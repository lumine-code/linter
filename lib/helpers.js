const { unique: arrayUnique } = require("./util");
const { normalizeTags } = require("./tags");
const { Range, Point } = require("lumine");
const picomatch = require("picomatch");
const { isProxy } = require("node:util").types;

const $version = "__$sb_linter_version";
const $activated = "__$sb_linter_activated";

const DEFAULT_MARKER_INVALIDATION = "touch";
const MARKER_INVALIDATIONS = new Set([DEFAULT_MARKER_INVALIDATION, "never"]);
const markerInvalidations = new WeakMap();
const plainPrototypes = new WeakSet([Object.prototype]);
const arrayPrototypes = new WeakSet([Array.prototype]);
const objectConstructorSource = Function.prototype.toString.call(Object);
const arrayConstructorSource = Function.prototype.toString.call(Array);

function nativePrototype(prototype, known, source) {
  if (!prototype) return false;
  if (known.has(prototype)) return true;
  const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  if (
    typeof constructor === "function" &&
    constructor.prototype === prototype &&
    Function.prototype.toString.call(constructor) === source
  ) {
    known.add(prototype);
    return true;
  }
  return false;
}

function plainPrototype(prototype) {
  return prototype === null || nativePrototype(prototype, plainPrototypes, objectConstructorSource);
}
const KEYED_MESSAGE_FIELDS = new Set([
  "key",
  "severity",
  "excerpt",
  "linterName",
  "tags",
  "icon",
  "url",
  "description",
  "location",
  "reference",
  "solutions",
  "version",
]);
const KEYED_LOCATION_FIELDS = new Set([
  "file",
  "position",
  "cell",
  "buffer",
  "normalizedFile",
  "displayRange",
]);
const KEYED_REFERENCE_FIELDS = new Set(["file", "position"]);

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

function updateMessageKey(message, linterPrefix, locationPrefix) {
  const { reference, location } = message;
  const locationBufferId = location.buffer
    ? location.buffer.id || location.buffer.getId?.() || String(location.buffer)
    : null;
  message.key = [
    linterPrefix ?? `$LINTER:${message.linterName}`,
    `${locationPrefix ?? `$LOCATION:${location.file}$`}${location.position.start.row}$${location.position.start.column}$${location.position.end.row}$${location.position.end.column}`,
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
  { markerInvalidation = DEFAULT_MARKER_INVALIDATION, positionCache } = {},
) {
  // A provider normally reports thousands of locations in the same file.
  // Cache only this batch: the comparison rule and visible path spelling stay
  // unchanged, and no process-lifetime cache retains arbitrary project paths.
  const paths = new Map();
  const linterPrefixes = new Map();
  for (let i = 0, { length } = messages; i < length; ++i) {
    const message = messages[i];
    const { reference, solutions } = message;
    message.location.position = getRangeClass(message.location.position, positionCache);
    if (reference !== undefined && reference.position !== undefined) {
      reference.position = getPointClass(reference.position, positionCache);
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
    let path = paths.get(message.location.file);
    if (!path) {
      path = {
        normalized: normalizePath(message.location.file),
        prefix: `$LOCATION:${message.location.file}$`,
      };
      paths.set(message.location.file, path);
    }
    message.location.normalizedFile = path.normalized;
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
    let prefix = linterPrefixes.get(message.linterName);
    if (!prefix) {
      prefix = `$LINTER:${message.linterName}`;
      linterPrefixes.set(message.linterName, prefix);
    }
    updateMessageKey(message, prefix, path.prefix);
  }
}

function getMarkerInvalidation(message) {
  return markerInvalidations.get(message) || DEFAULT_MARKER_INVALIDATION;
}

function getPointClass(point, positionCache) {
  if (!(point instanceof Point)) {
    const cached = positionCache?.get(point);
    return cached instanceof Point ? cached : Point.fromObject(point);
  }
  return point;
}

function getRangeClass(range, positionCache) {
  if (!(range instanceof Range)) {
    const cached = positionCache?.get(range);
    return cached instanceof Range ? cached : Range.fromObject(range);
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

function ownKeys(object) {
  // The two specialised collectors are much cheaper than Reflect.ownKeys on
  // ordinary records, while still including non-enumerable and symbol fields.
  // Both callers reject proxies before reflection.
  const names = Object.getOwnPropertyNames(object);
  const symbols = Object.getOwnPropertySymbols(object);
  return symbols.length ? names.concat(symbols) : names;
}

function sameFields(left, right, ignored, compare, seen) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return Object.is(left, right);
  }
  const leftKeys = ownKeys(left);
  const rightKeys = ownKeys(right);
  let ordered = leftKeys.length === rightKeys.length;
  if (ordered) {
    for (let i = 0; i < leftKeys.length; i++) {
      if (leftKeys[i] !== rightKeys[i]) {
        ordered = false;
        break;
      }
    }
  }
  if (ordered) {
    for (const key of leftKeys) {
      if (ignored.has(key)) continue;
      const a = left[key],
        b = right[key];
      if (!Object.is(a, b) && !compare(a, b, key, seen)) return false;
    }
    return true;
  }
  let count = 0;
  for (const key of leftKeys) {
    if (ignored.has(key)) continue;
    if (!Object.hasOwn(right, key)) return false;
    const a = left[key],
      b = right[key];
    if (!Object.is(a, b) && !compare(a, b, key, seen)) return false;
    count++;
  }
  for (const key of rightKeys) {
    if (!ignored.has(key)) count--;
  }
  return count === 0;
}

const NO_IGNORED_FIELDS = new Set();

// Functions and promises retain their identity. Plain solution records can
// be rebuilt without changing what they do, while an opaque provider-owned
// object is equivalent only to itself. Cycles in extension fields are allowed.
function sameValue(left, right, seen) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (isProxy(left) || isProxy(right)) return false;
  if (left instanceof Range && right instanceof Range) return left.isEqual(right);
  if (left instanceof Point && right instanceof Point) return left.isEqual(right);
  const array = Array.isArray(left);
  if (array !== Array.isArray(right)) return false;
  const leftPrototype = Object.getPrototypeOf(left),
    rightPrototype = Object.getPrototypeOf(right);
  if (array) {
    if (
      !nativePrototype(leftPrototype, arrayPrototypes, arrayConstructorSource) ||
      !nativePrototype(rightPrototype, arrayPrototypes, arrayConstructorSource)
    )
      return false;
  } else if (!plainPrototype(leftPrototype) || !plainPrototype(rightPrototype)) return false;
  seen = seen || new WeakMap();
  const previous = seen.get(left);
  if (previous) return previous === right;
  seen.set(left, right);
  if (Array.isArray(left) && left.length !== right.length) return false;
  return sameFields(left, right, NO_IGNORED_FIELDS, compareValueField, seen);
}

function compareValueField(left, right, _key, seen) {
  return sameValue(left, right, seen);
}

function sameMessagePayload(left, right) {
  if (left === right) return true;
  if (isProxy(left) || isProxy(right)) return false;
  const leftSolutions = Object.getOwnPropertyDescriptor(left, "solutions");
  const rightSolutions = Object.getOwnPropertyDescriptor(right, "solutions");
  const leftDescription = Object.getOwnPropertyDescriptor(left, "description");
  const rightDescription = Object.getOwnPropertyDescriptor(right, "description");
  if (
    leftSolutions?.get ||
    leftSolutions?.set ||
    rightSolutions?.get ||
    rightSolutions?.set ||
    leftDescription?.get ||
    leftDescription?.set ||
    rightDescription?.get ||
    rightDescription?.set
  )
    return false;
  const prototype = Object.getPrototypeOf(left);
  if (!plainPrototype(prototype) || !plainPrototype(Object.getPrototypeOf(right))) {
    // A provider-owned class can expose payload through prototype getters or
    // private state. Its fresh instance is not proven equivalent by own fields.
    return false;
  }
  if (getMarkerInvalidation(left) !== getMarkerInvalidation(right)) return false;
  // Resolution is memoized per message, not per function. Even a provider
  // reusing its resolver may answer differently in a fresh diagnostic snapshot.
  if (typeof left.description === "function" || typeof right.description === "function")
    return false;
  if (
    left.severity !== right.severity ||
    left.excerpt !== right.excerpt ||
    left.linterName !== right.linterName ||
    left.description !== right.description ||
    left.icon !== right.icon ||
    left.url !== right.url ||
    !sameValue(left.tags, right.tags) ||
    !sameValue(left.solutions, right.solutions)
  )
    return false;
  if (!sameDeclaredRecord(left.location, right.location, KEYED_LOCATION_FIELDS)) return false;
  return sameDeclaredRecord(left.reference, right.reference, KEYED_REFERENCE_FIELDS);
}

function sameDeclaredRecord(left, right, fields) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (
    isProxy(left) ||
    isProxy(right) ||
    !plainPrototype(Object.getPrototypeOf(left)) ||
    !plainPrototype(Object.getPrototypeOf(right))
  )
    return false;
  if (left.file !== right.file) return false;
  if (fields === KEYED_LOCATION_FIELDS) {
    if (
      left.cell !== right.cell ||
      left.buffer !== right.buffer ||
      left.normalizedFile !== right.normalizedFile
    )
      return false;
    const a = left.position,
      b = right.position;
    if (a === b) return true;
    if (isProxy(a) || isProxy(b)) return false;
    if (a instanceof Range && b instanceof Range) {
      return (
        a.start.row === b.start.row &&
        a.start.column === b.start.column &&
        a.end.row === b.end.row &&
        a.end.column === b.end.column
      );
    }
  }
  return sameValue(left.position, right.position);
}

// Unknown extension objects are passed through by identity, never recursively
// inspected as diagnostic data. Keep the canonical record and notify its UIs
// when that reference changes. All descriptor plans are gathered before writes.
function extensionPatches(left, right, fields, patches) {
  if (left === right) return patches;
  if (!left || !right) return left === right ? patches : false;
  if (
    isProxy(left) ||
    isProxy(right) ||
    !plainPrototype(Object.getPrototypeOf(left)) ||
    !plainPrototype(Object.getPrototypeOf(right))
  )
    return false;
  const leftKeys = ownKeys(left);
  const rightKeys = ownKeys(right);
  let sameKeys = leftKeys.length === rightKeys.length;
  if (sameKeys) {
    for (let i = 0; i < leftKeys.length; i++) {
      if (leftKeys[i] !== rightKeys[i]) {
        sameKeys = false;
        break;
      }
    }
  }
  if (!sameKeys) {
    for (const key of leftKeys) {
      if (fields.has(key) || Object.hasOwn(right, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(left, key);
      if (!descriptor.configurable || !descriptor.writable || descriptor.get || descriptor.set)
        return false;
      patches ||= [];
      patches.push({ target: left, key, descriptor: null });
    }
  }
  for (const key of rightKeys) {
    if (fields.has(key)) continue;
    const incoming = Object.getOwnPropertyDescriptor(right, key);
    const previous = Object.getOwnPropertyDescriptor(left, key);
    if (incoming.get || incoming.set || previous?.get || previous?.set) return false;
    if (
      previous &&
      Object.is(previous.value, incoming.value) &&
      previous.enumerable === incoming.enumerable &&
      previous.writable === incoming.writable &&
      previous.configurable === incoming.configurable
    )
      continue;
    if (
      !incoming.configurable ||
      !incoming.writable ||
      (previous && (!previous.configurable || !previous.writable)) ||
      (!previous && !Object.isExtensible(left))
    )
      return false;
    patches ||= [];
    patches.push({ target: left, key, descriptor: incoming });
  }
  return patches;
}

function messageExtensionPatches(left, right) {
  let patches = extensionPatches(left, right, KEYED_MESSAGE_FIELDS, null);
  if (patches === false) return false;
  patches = extensionPatches(left.location, right.location, KEYED_LOCATION_FIELDS, patches);
  if (patches === false) return false;
  return extensionPatches(left.reference, right.reference, KEYED_REFERENCE_FIELDS, patches);
}

function directTargetUses(oldMessages, inputs) {
  const uses = new Map();
  for (const messages of [oldMessages, inputs]) {
    for (const message of messages) {
      for (const target of [message, message.location, message.reference]) {
        if (target && typeof target === "object") {
          uses.set(target, (uses.get(target) || 0) + 1);
        }
      }
    }
  }
  return uses;
}

function createMessageKeyIndex(messages) {
  // A provider may report identical diagnostics more than once. Keep each
  // occurrence rather than collapsing the old snapshot into one value per key.
  const buckets = new Map();
  const keys = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const key = messages[i].key;
    keys[i] = key;
    const previous = buckets.get(key);
    if (previous === undefined) {
      buckets.set(key, i);
    } else if (Array.isArray(previous)) {
      previous.push(i);
    } else {
      buckets.set(key, [previous, i]);
    }
  }
  return { messages, keys, buckets };
}

function messageKeyIndexMatches(index, messages) {
  return (
    index?.messages === messages &&
    index.keys.length === messages.length &&
    messages.every((message, i) => message.key === index.keys[i])
  );
}

function flagMessages(inputs, oldMessages, keyIndex) {
  if (inputs === undefined || oldMessages === undefined) {
    return null;
  }
  if (!oldMessages.length) {
    return { oldKept: [], oldRemoved: [], newAdded: inputs, updated: [] };
  }
  if (!inputs.length) {
    return { oldKept: [], oldRemoved: oldMessages, newAdded: [], updated: [] };
  }
  if (!messageKeyIndexMatches(keyIndex, oldMessages)) keyIndex = createMessageKeyIndex(oldMessages);
  const { buckets } = keyIndex;
  const offsets = new Map();
  const consumed = new Uint8Array(oldMessages.length);
  const newAdded = [];
  const oldKept = [];
  let updated = [];
  let targetUses;
  const plans = [];
  for (let iInput = 0, len = inputs.length; iInput < len; iInput++) {
    const input = inputs[iInput];
    const indices = buckets.get(input.key);
    let index;
    if (indices !== undefined) {
      if (Array.isArray(indices)) {
        const offset = offsets.get(indices) ?? 0;
        index = indices[offset];
        offsets.set(indices, offset + 1);
      } else if (!consumed[indices]) {
        index = indices;
      }
    }
    if (index !== undefined) {
      consumed[index] = 1;
      const previous = oldMessages[index];
      if (sameMessagePayload(previous, input)) {
        const patches = messageExtensionPatches(previous, input);
        if (patches?.length) targetUses ||= directTargetUses(oldMessages, inputs);
        if (patches !== false && !patches?.some(({ target }) => targetUses.get(target) !== 1)) {
          oldKept.push(previous);
          if (patches?.length) {
            for (const patch of patches) plans.push(patch);
            updated.push(previous);
          }
        } else {
          oldKept.push(input);
          updated.push(input);
        }
      } else {
        oldKept.push(input);
        updated.push(input);
      }
    } else {
      newAdded.push(input);
    }
  }
  for (const { target, key, descriptor } of plans) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  }
  const oldRemoved = [];
  for (let i = 0; i < oldMessages.length; i++) {
    if (!consumed[i]) oldRemoved.push(oldMessages[i]);
  }
  if (
    !newAdded.length &&
    !oldRemoved.length &&
    oldMessages.some((message, index) => message.key !== oldKept[index].key)
  ) {
    // Reordering is observable too. Report the affected canonical records so
    // consumers refresh their ordering without pretending they were removed.
    updated = oldKept;
  }
  return { oldKept, oldRemoved, newAdded, updated };
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
  createMessageKeyIndex,
  messageKeyIndexMatches,
  flagMessages,
  mergeArray,
  renderExcerpt,
  getDescription,
  hasLazyDescription,
  resolveDescription,
};
