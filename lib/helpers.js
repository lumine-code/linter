const { unique: arrayUnique } = require("./util");
const { normalizeTags } = require("./tags");
const { Range, Point } = require("lumine");
const picomatch = require("picomatch");

const $version = "__$sb_linter_version";
const $activated = "__$sb_linter_activated";
const $requestLatest = "__$sb_linter_request_latest";
const $requestLastReceived = "__$sb_linter_request_last_received";

const DEFAULT_MARKER_INVALIDATION = "touch";
const MARKER_INVALIDATIONS = new Set([DEFAULT_MARKER_INVALIDATION, "never"]);
const markerInvalidations = new WeakMap();

function shouldTriggerLinter(linter, wasTriggeredOnChange, scopes) {
  if (wasTriggeredOnChange && !linter.lintsOnChange) {
    return false;
  }
  // Use pre-computed Set for O(1) lookup if available, otherwise fall back to includes
  const scopeSet = linter._grammarScopesSet;
  if (scopeSet) {
    return scopes.some((scope) => scopeSet.has(scope));
  }
  return scopes.some((scope) => linter.grammarScopes.includes(scope));
}

function getEditorCursorScopes(textEditor) {
  return arrayUnique(
    textEditor
      .getCursors()
      .reduce(
        (scopes, cursor) => scopes.concat(cursor.getScopeDescriptor().getScopesArray()),
        ["*"],
      ),
  );
}

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

/**
 * What a message is about, for display.
 *
 * A message names its subject by path. A buffer that has never been saved has
 * no path, so such a message names the buffer instead and there is nothing to
 * show but that it is untitled.
 * @param {Object} message
 * @returns {string} A label, never null — an unlocated message is not valid.
 */
function messageSubject(message) {
  const file = message.location?.file;
  if (typeof file === "string") {
    return file;
  }
  return "untitled";
}

/**
 * The editor currently showing this buffer, for a message located by buffer
 * rather than by path. Returns null once nothing is showing it, which is the
 * same answer as opening a path that has since been deleted.
 * @param {Object} buffer
 * @returns {Object|null}
 */
function editorForBuffer(buffer) {
  if (!buffer) {
    return null;
  }
  for (const editor of lumine.workspace.getTextEditors()) {
    if (editor.getBuffer() === buffer) {
      return editor;
    }
  }
  return null;
}

// The compiled form of the ignore glob, which is one config value that hardly
// ever changes. `picomatch.isMatch` is `picomatch(pattern)(string)`, so asking
// it directly re-parses the pattern and rebuilds its regular expression on
// every lint request.
let ignoreMatcher = null;
let ignoreMatcherGlob = null;

function ignoreMatcherFor(glob) {
  if (glob !== ignoreMatcherGlob) {
    ignoreMatcherGlob = glob;
    // An empty pattern is picomatch's one hard error, and an empty ignore glob
    // means the user cleared the field — nothing is ignored.
    ignoreMatcher = glob ? picomatch(glob) : () => false;
  }
  return ignoreMatcher;
}

function matchesIgnoreGlob(filePath, ignoredGlob) {
  if (!filePath || !ignoredGlob) {
    return false;
  }
  const normalizedFilePath = process.platform === "win32" ? filePath.replace(/\\/g, "/") : filePath;
  return ignoreMatcherFor(ignoredGlob)(normalizedFilePath);
}

function updateMessageKey(message) {
  const { reference, location } = message;
  const locationBufferId = location.buffer
    ? location.buffer.id || location.buffer.getId?.() || String(location.buffer)
    : null;
  message.key = [
    `$LINTER:${message.linterName}`,
    `$LOCATION:${location.file}$${location.position.start.row}$${location.position.start.column}$${location.position.end.row}$${location.position.end.column}`,
    location.cell != null ? `$CELL:${location.cell}` : "$CELL:null",
    locationBufferId ? `$BUFFER:${locationBufferId}` : "$BUFFER:null",
    reference
      ? `$REFERENCE:${reference.file}$${
          reference.position ? `${reference.position.row}$${reference.position.column}` : ""
        }`
      : "$REFERENCE:null",
    `$EXCERPT:${message.excerpt}`,
    `$SEVERITY:${message.severity}`,
    // Tags sit in the key because flagMessages diffs purely by key: without
    // this, a message whose tags changed lands in oldKept and keeps a stale
    // decoration forever.
    message.tags?.length ? `$TAGS:${message.tags.join(",")}` : "$TAGS:null",
    message.icon ? `$ICON:${message.icon}` : "$ICON:null",
    message.url ? `$URL:${message.url}` : "$URL:null",
    typeof message.description === "string"
      ? `$DESCRIPTION:${message.description}`
      : "$DESCRIPTION:null",
  ].join("");
}

function normalizeMessages(
  linterName,
  messages,
  { markerInvalidation = DEFAULT_MARKER_INVALIDATION } = {},
) {
  for (let i = 0, { length } = messages; i < length; ++i) {
    const message = messages[i];
    const { reference, solutions } = message;
    message.location.position = getRangeClass(message.location.position);
    if (reference !== undefined && reference.position !== undefined) {
      reference.position = getPointClass(reference.position);
    }
    if (Array.isArray(solutions)) {
      for (let j = 0, _length = solutions.length; j < _length; j++) {
        const solution = solutions[j];
        solution.position = getRangeClass(solution.position);
      }
    }
    message.version = 2;
    // The one place a message's path is normalized. Every consumer compares
    // paths by this value, here and in whatever displays them, and computing it
    // per message per publish was the largest single cost in the update path.
    message.location.normalizedFile = normalizePath(message.location.file);
    if (!message.linterName) {
      message.linterName = linterName;
    }
    markerInvalidations.set(message, markerInvalidation);
    // Canonical tags: known values only, deduplicated, in a fixed order, and
    // dropped entirely when nothing survives. Every reader downstream then sees
    // one shape, and a provider reordering its array does not churn the key.
    if (message.tags !== undefined) {
      const tags = normalizeTags(message.tags);
      if (tags) {
        message.tags = tags;
      } else {
        delete message.tags;
      }
    }
    updateMessageKey(message);
  }
}

function getMarkerInvalidation(message) {
  return markerInvalidations.get(message) || DEFAULT_MARKER_INVALIDATION;
}

function getPointClass(point) {
  if (!(point instanceof Point)) {
    return Point.fromObject(point);
  }
  return point;
}

function getRangeClass(range) {
  if (!(range instanceof Range)) {
    return Range.fromObject(range);
  }
  return range;
}

function createKeyMessageMap(messages) {
  const keyMessageMap = new Map();
  for (let i = 0, { length } = messages; i < length; ++i) {
    const message = messages[i];
    keyMessageMap.set(message.key, message);
  }
  return keyMessageMap;
}

function flagMessages(inputs, oldMessages) {
  if (inputs === undefined || oldMessages === undefined) {
    return null;
  }
  if (!oldMessages.length) {
    return { oldKept: [], oldRemoved: [], newAdded: inputs };
  }
  if (!inputs.length) {
    return { oldKept: [], oldRemoved: oldMessages, newAdded: [] };
  }
  const cache = createKeyMessageMap(oldMessages);
  const newAdded = [];
  const oldKept = [];
  const oldKeptKeys = new Set();
  for (let iInput = 0, len = inputs.length; iInput < len; iInput++) {
    const input = inputs[iInput];
    if (cache.has(input.key)) {
      oldKept.push(input);
      oldKeptKeys.add(input.key);
    } else {
      newAdded.push(input);
    }
  }
  // Use Set for O(1) lookup instead of Array.includes() which is O(n)
  const oldRemoved = [];
  for (const [key, message] of cache) {
    if (!oldKeptKeys.has(key)) {
      oldRemoved.push(message);
    }
  }
  return { oldKept, oldRemoved, newAdded };
}

// `push.apply` spreads the source across the argument list, and V8 caps how long
// that list may be. One registry entry holds everything a provider published, so
// a project-wide language server is enough to reach the cap — where it throws a
// RangeError rather than merging slowly. Big batches go through a loop instead.
const ARGUMENT_LIST_LIMIT = 30000;

function mergeArray(arr1, arr2) {
  const { length } = arr2;
  if (!length) {
    return;
  }
  if (length <= ARGUMENT_LIST_LIMIT) {
    Array.prototype.push.apply(arr1, arr2);
    return;
  }
  for (let i = 0; i < length; i++) {
    arr1.push(arr2[i]);
  }
}

// A message excerpt rendered to HTML, keyed by the excerpt itself.
//
// `lumine.tools.markdown.render` builds a MarkdownIt instance, installs its
// plugins, runs the front-matter parser and sanitizes the result on every call
// — far more than a one-line diagnostic is worth, and the panel asks for it once
// per row per render. Keyed by the string rather than by the message because a
// fresh lint run produces new message objects for the same text, and because one
// excerpt is usually reported many times over.
const RENDERED_EXCERPT_LIMIT = 2000;
const renderedExcerpts = new Map();

function renderExcerpt(excerpt) {
  const key = typeof excerpt === "string" ? excerpt : String(excerpt ?? "");
  if (renderedExcerpts.has(key)) {
    // Re-inserted so the entries in use are the last to be evicted.
    const cached = renderedExcerpts.get(key);
    renderedExcerpts.delete(key);
    renderedExcerpts.set(key, cached);
    return cached;
  }
  const html = lumine.tools.markdown.render(key);
  // An excerpt names an identifier or a path often enough that the set of them
  // is not bounded on its own. A Map iterates in insertion order, so the first
  // key is the least recently used one.
  if (renderedExcerpts.size >= RENDERED_EXCERPT_LIMIT) {
    renderedExcerpts.delete(renderedExcerpts.keys().next().value);
  }
  renderedExcerpts.set(key, html);
  return html;
}

// `Message.description` is either the long form itself or a function producing
// it lazily. Both UIs want the resolved string, and the function form must not
// run once per hover or once per re-render, so its result is memoized against
// the message object; a new lint run builds new message objects and the cache
// falls away with them.
const resolvedDescriptions = new WeakMap();

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
  if (!hasLazyDescription(message)) {
    return getDescription(message);
  }
  let text = null;
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
  return text;
}

module.exports = {
  $version,
  $activated,
  $requestLatest,
  $requestLastReceived,
  DEFAULT_MARKER_INVALIDATION,
  MARKER_INVALIDATIONS,
  shouldTriggerLinter,
  getEditorCursorScopes,
  matchesIgnoreGlob,
  normalizePath,
  messageSubject,
  editorForBuffer,
  updateMessageKey,
  normalizeMessages,
  getMarkerInvalidation,
  createKeyMessageMap,
  flagMessages,
  mergeArray,
  renderExcerpt,
  getDescription,
  hasLazyDescription,
  resolveDescription,
};
