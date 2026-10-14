const DEFAULT_MARKER_INVALIDATION = "touch";

const MARKER_INVALIDATIONS = new Set([DEFAULT_MARKER_INVALIDATION, "never"]);

const markerInvalidations = new WeakMap();

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
  normalizePath,
  getMessageFile,
  getMarkerInvalidation,
  getDescription,
  hasLazyDescription,
  resolveDescription,
};
