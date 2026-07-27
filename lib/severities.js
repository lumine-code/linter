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

module.exports = { SEVERITIES, NAMES, UNKNOWN_RANK, get, isValid, rankOf, compare, listText };
