const DEFAULT_MARKER_INVALIDATION = "touch";

const MARKER_INVALIDATIONS = new Set([DEFAULT_MARKER_INVALIDATION, "never"]);

const markerInvalidations = new WeakMap();
// Trusted UI anchors, separate from provider-owned displayRange accessors.
// A fresh report can reuse a coordinate key while its old marker has moved.
const markerAnchors = new WeakMap();
const markerResets = new WeakMap();

/**
 * A key for comparing two paths that may name the same file. Windows is
 * case-insensitive and accepts either separator, and providers disagree: a
 * language server commonly answers with a lowercase drive letter for the
 * `C:\…` it was given. Compared as raw strings those are two different files,
 * so messages are stored under one and looked up under the other, and nothing
 * is ever shown for them.
 *
 * For comparison and map keys only — it destroys the casing a path is
 * displayed and opened with, so keep the original for both.
 * @param {string} filePath
 * @returns {string|null} null when there is no path to compare
 */
function normalizePath(filePath) {
  if (typeof filePath !== "string") {
    return null;
  }
  if (process.platform === "win32") {
    return filePath.replace(/\\/g, "/").toLowerCase();
  }
  return filePath;
}

// Explicit provider paths identify their own subject. Buffer-only locations
// follow the caller's current path without storing an inferred file field.
function getMessageFile(message) {
  const file = message.location?.file ?? message.location?.buffer?.getPath?.();
  return typeof file === "string" ? file : null;
}

function getMarkerInvalidation(message) {
  return markerInvalidations.get(message) || DEFAULT_MARKER_INVALIDATION;
}

// `Message.description` is either the long form itself or a function producing
// it lazily. Both UIs want the resolved string, and the function form must not
// run once per hover or once per re-render, so its result is memoized against
// the message object; a new lint run builds new message objects and the cache
// falls away with them.
const resolvedDescriptions = new WeakMap();

const pendingDescriptions = new WeakMap();

// The string form needs no resolution; the function form is only known once
// resolveDescription has run, and reports null until then.
function getDescription(message) {
  const { description } = message;
  if (typeof description === "string") {
    return description || null;
  }
  if (typeof description === "function" && resolvedDescriptions.has(message)) {
    return resolvedDescriptions.get(message);
  }
  return null;
}

// True while a lazy description exists but has not been resolved yet — the
// panel shows its "details" affordance exactly then.
function hasLazyDescription(message) {
  return typeof message.description === "function" && !resolvedDescriptions.has(message);
}

async function resolveDescription(message) {
  if (pendingDescriptions.has(message)) return pendingDescriptions.get(message);
  if (!hasLazyDescription(message)) {
    return getDescription(message);
  }
  let text = null;
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  pendingDescriptions.set(message, pending);
  try {
    const value = await message.description();
    text = typeof value === "string" && value ? value : null;
  } catch (error) {
    // A provider whose description throws loses the detail, not the message.
    // The failure is cached like any other result so a broken description is
    // not retried on every render.
    console.error("linter: Message.description failed to resolve", error);
  }
  resolvedDescriptions.set(message, text);
  pendingDescriptions.delete(message);
  settle(text);
  return text;
}

module.exports = {
  DEFAULT_MARKER_INVALIDATION,
  MARKER_INVALIDATIONS,
  markerInvalidations,
  markerAnchors,
  markerResets,
  normalizePath,
  getMessageFile,
  getMarkerInvalidation,
  getDescription,
  hasLazyDescription,
  resolveDescription,
};

// Single source of truth for the message severity model.
//
// Mirrors the LSP DiagnosticSeverity scale: Error 1, Warning 2, Information 3,
// Hint 4. Array order IS precedence order, and `rank` is always `lsp - 1`. The
// order drives the marker layers, the panel filter tiles, the status-bar tiles
// and every severity sort in the package, so a fifth tier is added here and
// nowhere else.
//
// `gutterDot` and `hideWhenZero` are the two places the tiers are deliberately
// not uniform: a hint gets no gutter dot and its status tile stays out of the
// way until one is reported, because a hint is the tier the editor is supposed
// to render quietly.

const SEVERITIES = [
  {
    name: "error",
    label: "Error",
    rank: 0,
    lsp: 1,
    icon: "icon-stop",
    textClass: "text-error",
    gutterDot: true,
    hideWhenZero: false,
  },
  {
    name: "warning",
    label: "Warning",
    rank: 1,
    lsp: 2,
    icon: "icon-alert",
    textClass: "text-warning",
    gutterDot: true,
    hideWhenZero: false,
  },
  {
    name: "info",
    label: "Info",
    rank: 2,
    lsp: 3,
    icon: "icon-info",
    textClass: "text-info",
    gutterDot: true,
    hideWhenZero: false,
  },
  {
    name: "hint",
    label: "Hint",
    rank: 3,
    lsp: 4,
    icon: "icon-light-bulb",
    textClass: "text-hint",
    gutterDot: false,
    hideWhenZero: true,
  },
];

const NAMES = SEVERITIES.map((severity) => severity.name);
const BY_NAME = new Map(SEVERITIES.map((severity) => [severity.name, severity]));

// A severity outside the model sorts after every known one rather than
// producing NaN. Validation is skipped outside dev mode on two of the three
// intake paths, so this is reachable in a release build.
const UNKNOWN_RANK = SEVERITIES.length;

/**
 * Looks up a severity record.
 * Returns null rather than a fallback record, so every call site has to state
 * how it degrades instead of silently painting an unknown severity as an error.
 * @param {*} name
 * @returns {Object|null}
 */
function get(name) {
  return BY_NAME.get(name) || null;
}

/**
 * @param {*} name
 * @returns {boolean} True when the severity is part of the model.
 */
function isValid(name) {
  return BY_NAME.has(name);
}

/**
 * @param {*} name
 * @returns {number} Precedence rank, or UNKNOWN_RANK for anything unknown.
 */
function rankOf(name) {
  const severity = BY_NAME.get(name);
  return severity ? severity.rank : UNKNOWN_RANK;
}

/**
 * Total comparator for two severity names, most severe first.
 * @param {*} a
 * @param {*} b
 * @returns {number}
 */
function compare(a, b) {
  return rankOf(a) - rankOf(b);
}

/**
 * @returns {string} The severity names as prose, for validation messages.
 */
function listText() {
  const quoted = NAMES.map((name) => `'${name}'`);
  const last = quoted.pop();
  return `${quoted.join(", ")} or ${last}`;
}

function showError(title, description, points) {
  const renderedPoints = points.map((item) => `  • ${item}`);
  lumine.notifications.addWarning(`[Linter] ${title}`, {
    dismissable: true,
    detail: `${description}\n${renderedPoints.join("\n")}`,
  });
}

// Everything a UI may implement. A UI takes only the ones it has a use for —
// a scrollbar overview wants `render` and nothing else — so the check is that
// what is there is callable, not that all of it is there.
const UI_MEMBERS = [
  "attach",
  "render",
  "didBeginLinting",
  "didFinishLinting",
  "didChangeActiveItem",
  "didChangeLintingState",
  "showProjectView",
  "dispose",
];

function validateUI(ui) {
  const messages = [];
  if (ui && typeof ui === "object") {
    // The one requirement: something to call it in a notification.
    if (typeof ui.name !== "string") {
      messages.push("UI.name must be a string");
    }
    for (const member of UI_MEMBERS) {
      if (ui[member] !== undefined && typeof ui[member] !== "function") {
        messages.push(`UI.${member} must be a function`);
      }
    }
  } else {
    messages.push("UI must be an object");
  }
  if (messages.length) {
    showError(
      "Invalid UI received",
      `These issues were encountered while registering the UI named '${
        ui && ui.name ? ui.name : "Unknown"
      }'`,
      messages,
    );
    return false;
  }
  return true;
}

function validateLinter(linter) {
  const messages = [];
  if (linter && typeof linter === "object") {
    if (typeof linter.name !== "string") {
      messages.push("Linter.name must be a string");
    }
    if (
      typeof linter.scope !== "string" ||
      (linter.scope !== "file" && linter.scope !== "project")
    ) {
      messages.push("Linter.scope must be either 'file' or 'project'");
    }
    if (typeof linter.lintsOnChange !== "boolean") {
      messages.push("Linter.lintsOnChange must be a boolean");
    }
    if (!Array.isArray(linter.grammarScopes)) {
      messages.push("Linter.grammarScopes must be an Array");
    }
    if (typeof linter.lint !== "function") {
      messages.push("Linter.lint must be a function");
    }
  } else {
    messages.push("Linter must be an object");
  }
  if (messages.length) {
    showError(
      "Invalid Linter received",
      `These issues were encountered while registering a Linter named '${
        linter && linter.name ? linter.name : "Unknown"
      }'`,
      messages,
    );
    return false;
  }
  return true;
}

function validateIndie(indie) {
  const messages = [];
  if (indie && typeof indie === "object") {
    if (typeof indie.name !== "string") {
      messages.push("Indie.name must be a string");
    }
    if (
      indie.markerInvalidation !== undefined &&
      !MARKER_INVALIDATIONS.has(indie.markerInvalidation)
    ) {
      messages.push("Indie.markerInvalidation must be either 'touch' or 'never'");
    }
  } else {
    messages.push("Indie must be an object");
  }
  if (messages.length) {
    showError(
      "Invalid Indie received",
      `These issues were encountered while registering an Indie Linter named '${
        indie && indie.name ? indie.name : "Unknown"
      }'`,
      messages,
    );
    return false;
  }
  return true;
}

Object.defineProperties(module.exports, {
  Severities: {
    value: { SEVERITIES, NAMES, UNKNOWN_RANK, get, isValid, rankOf, compare, listText },
  },
  RegistrationValidation: {
    value: { ui: validateUI, linter: validateLinter, indie: validateIndie, showError },
  },
});
