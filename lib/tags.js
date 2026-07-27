// Single source of truth for the message tag model.
//
// Mirrors the LSP DiagnosticTag scale: Unnecessary 1, Deprecated 2. A tag
// classifies a message on an axis orthogonal to severity — a message carries
// none, one, or both, at any severity — so tags live here rather than in
// severities.js.
//
// The order below is canonical: it is what the message key is built from, what
// `.linter-tag-<tag>` in styles/linter.css mirrors, and the order the marker
// layers are created in.

const TAGS = ["unnecessary", "deprecated"];

const VALID_TAG = new Set(TAGS);

/**
 * Canonical form of a provider-supplied tag list: known values only, without
 * duplicates, in TAGS order. Returns null when nothing survives so callers can
 * drop the field entirely rather than leave an empty array behind.
 * @param {*} tags
 * @returns {string[]|null}
 */
function normalizeTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return null;
  }
  const canonical = TAGS.filter((tag) => tags.includes(tag));
  return canonical.length ? canonical : null;
}

/**
 * @returns {string} The tag names as prose, for validation messages.
 */
function listText() {
  const quoted = TAGS.map((tag) => `'${tag}'`);
  const last = quoted.pop();
  return `${quoted.join(", ")} or ${last}`;
}

module.exports = { TAGS, VALID_TAG, normalizeTags, listText };
