const { CompositeDisposable, Disposable } = require("lumine");
const EMPTY_MESSAGES = [];

// Each display event describes all its changes in the coordinates before that
// event. Different events follow one another, so apply a chunk's total offset
// only after checking all its ranges. Ranges that overlap a changed screen row
// take the editor's exact conversion; unaffected ranges only need row offsets.
function shiftedItem(item, chunks) {
  let { row, end } = item;
  for (const changes of chunks) {
    let offset = 0;
    for (const change of changes) {
      if (end < change.start) break;
      if (row >= change.end) {
        offset += change.delta;
      } else {
        return null;
      }
    }
    row += offset;
    end += offset;
  }
  return { row, end, cls: item.cls };
}

function recordScreenChanges(cache, changes) {
  const projection = cache.get("projection");
  if (!projection?.size) return;
  const chunks = cache.get("screenChanges");
  // A batch large enough to make replay cost more than an exact projection
  // discards its old cache. Normally the hub's 20 ms throttle leaves one chunk.
  if (chunks.length >= 32) {
    projection.clear();
    chunks.length = 0;
    return;
  }
  const next = changes.map(({ oldRange, newRange }) => ({
    start: oldRange.start.row,
    end: oldRange.end.row,
    delta: newRange.end.row - newRange.start.row - (oldRange.end.row - oldRange.start.row),
  }));
  const last = chunks[chunks.length - 1];
  if (last?.every((change) => change.delta === 0) && next.every((change) => change.delta === 0)) {
    // Same-row typing does not schedule the overview at all. Coalesce those
    // pending dirty rows, so hours of typing leave no history to replay later.
    const combined = [...last, ...next].sort((a, b) => a.start - b.start);
    last.length = 0;
    for (const change of combined) {
      const previous = last[last.length - 1];
      if (previous && change.start <= previous.end) {
        previous.end = Math.max(previous.end, change.end);
      } else {
        last.push(change);
      }
    }
  } else {
    chunks.push(next);
  }
}

// The `marker.layer` provider: linter messages on the overview maps.
//
// Registered as an internal `linter.ui`, so the render patches and the hub
// handle arrive exactly as they would for an external UI package.
module.exports = {
  activate() {
    this.messages = [];
    this.hub = null;
    // The marker hub builds exactly one layer per (provider, editor), so an
    // editor maps to a single layer. It has to exist before the observer below,
    // which fires synchronously on subscribe.
    this.layers = new Map();
    this.disposables = new CompositeDisposable(
      // Subscribed once for the package rather than once per editor: hints are
      // shown or hidden everywhere at once.
      lumine.config.observe("linter.marker.showHints", (value) => {
        this.showHints = value;
        for (const layer of this.layers.values()) {
          layer.update();
        }
      }),
    );
  },

  deactivate() {
    this.messages = [];
    this.hub = null;
    this.layers.clear();
    this.disposables.dispose();
  },

  // A provider and a buffer rarely spell the same file the same way — a language
  // server commonly answers with a lowercase drive letter for the `C:\…` it was
  // given. The hub settles that on every message as `location.normalizedFile`
  // and hands over the rule it used, so both sides of this comparison are in
  // the same spelling. Without it a server's diagnostics marked nothing.
  pathOf(editor) {
    const filePath = editor.getPath();
    return this.hub ? this.hub.normalizePath(filePath) : filePath;
  },

  mentions(messages, editorPath) {
    return messages.some((m) => m.location.normalizedFile === editorPath);
  },

  messagesFor(editorPath) {
    return this.messages.filter((m) => m.location.normalizedFile === editorPath);
  },

  // Inline markers can be recreated or retired without any display event.
  // Their new getters may still have the same message identity and shape, so
  // the UI reports those anchor changes once per buffer after reconciliation.
  // A native retirement only needs descriptor checks; a rebind resets the
  // projection because a getter of the same shape may now read another anchor.
  invalidateBuffer(buffer, { resetProjection = true } = {}) {
    for (const [editor, layer] of this.layers) {
      if (editor.getBuffer() !== buffer) continue;
      if (resetProjection) {
        layer.cache.get("projection").clear();
        layer.cache.get("screenChanges").length = 0;
      }
      layer.cache.set("dirty", true);
      layer.update();
    }
  },

  buildUI() {
    return {
      name: "linter-markers",
      attach: (hub) => {
        this.hub = hub;
      },
      render: ({ added, messages, removed, updated = EMPTY_MESSAGES }) => {
        this.messages = messages;
        for (const [editor, layer] of this.layers) {
          const editorPath = this.pathOf(editor);
          if (
            this.mentions(added, editorPath) ||
            this.mentions(removed, editorPath) ||
            this.mentions(updated, editorPath)
          ) {
            layer.cache.set("data", this.messagesFor(editorPath));
            layer.update();
          }
        }
      },
    };
  },

  provideMarkerLayer() {
    return {
      name: "linter",
      description: "Linter message markers",
      position: "left",
      merge: true,
      enabled: "linter.marker.enabled",
      threshold: "linter.marker.threshold",
      initialize: (layer) => {
        this.layers.set(layer.editor, layer);
        layer.cache.set("projection", new Map());
        layer.cache.set("screenChanges", []);
        layer.cache.set("dirty", true);
        layer.cache.set("sourceChanges", false);
        layer.disposables.add(
          new Disposable(() => this.layers.delete(layer.editor)),
          layer.editor.displayLayer.onDidChange((changes) =>
            recordScreenChanges(layer.cache, changes),
          ),
          layer.editor.displayLayer.onDidReset(() => {
            layer.cache.get("projection").clear();
            layer.cache.get("screenChanges").length = 0;
            layer.cache.set("dirty", true);
          }),
          layer.editor.getBuffer().onDidChangeText(({ changes }) => {
            if (
              changes.some(
                ({ oldRange, newRange }) =>
                  oldRange.start.row !== oldRange.end.row ||
                  newRange.start.row !== newRange.end.row,
              )
            ) {
              layer.cache.set("dirty", true);
              // Display changes can arrive after this buffer event. Decide
              // whether there are shifts to replay when the overview polls.
              layer.cache.set("sourceChanges", true);
            }
            if (changes.some(({ oldRange, newRange }) => oldRange.end.row !== newRange.end.row)) {
              // Row-changing source edits move live anchors away from the
              // snapshot encoded in their key. A new object at that snapshot
              // starts a new anchor; screen-only wraps and folds do not.
              const projection = layer.cache.get("projection");
              for (const [key, cached] of projection) {
                if (cached.tracksEdits) {
                  cached.canReuseReplacement = false;
                } else {
                  // Large buffers have no inline marker: their snapshot row
                  // stays fixed in buffer coordinates when text is inserted.
                  projection.delete(key);
                }
              }
            }
            const change = changes[0];
            if (
              changes.length === 1 &&
              change.newRange.start.row === 0 &&
              change.newRange.start.column === 0 &&
              change.newRange.end.isEqual(layer.editor.getBuffer().getEndPosition())
            ) {
              layer.cache.get("projection").clear();
              layer.cache.get("screenChanges").length = 0;
              layer.cache.set("dirty", true);
            }
          }),
        );
        layer.cache.set("data", this.messagesFor(this.pathOf(layer.editor)));
      },
      getItems: ({ editor, cache }) => {
        const data = cache.get("data") ?? EMPTY_MESSAGES;
        const projection = cache.get("projection") ?? new Map();
        const changes = cache.get("screenChanges") ?? [];
        // A folded edit can move an anchor without a display change to replay.
        // Polling runs after both event streams, so this does not discard
        // reusable projections merely because the buffer event arrived first.
        if (cache.get("sourceChanges") && !changes.length) projection.clear();
        const previous = cache.get("rendered");
        if (
          previous &&
          !cache.get("dirty") &&
          previous.data === data &&
          previous.dataLength === data.length &&
          previous.showHints === this.showHints &&
          previous.projection === projection &&
          previous.projectionSize === projection.size &&
          !changes.length
        ) {
          return null;
        }
        // Dropped here rather than painted transparent: the threshold counts the
        // items a layer returns, and once it is exceeded every renderer skips
        // that layer whole, so a flood of hints would take the error markers
        // down with it.
        const shown = this.showHints ? data : data.filter((m) => m.severity !== "hint");
        const nextProjection = new Map();
        const keys = [];
        let unchanged = previous?.items.length === shown.length;
        const items = shown.map((message, index) => {
          // Providers commonly rebuild their message objects after each run.
          // The normalized key includes their snapshot coordinates, severity
          // and content, so unchanged diagnostics still share this cache.
          const key = message.key ?? message;
          keys.push(key);
          const cached = projection.get(key);
          const tracksEdits =
            typeof Object.getOwnPropertyDescriptor(message.location, "displayRange")?.get ===
            "function";
          let item =
            cached &&
            ((cached.message === message && cached.tracksEdits === tracksEdits) ||
              (cached.message !== message && cached.canReuseReplacement))
              ? shiftedItem(cached.item, changes)
              : null;
          let canReuseReplacement = cached?.canReuseReplacement ?? true;
          if (!item) {
            const range = message.location.displayRange || message.location.position;
            const startRow = editor.screenPositionForBufferPosition(range.start).row;
            const endRow = editor.screenPositionForBufferPosition(range.end).row;
            item = {
              row: Math.min(startRow, endRow),
              end: Math.max(startRow, endRow),
              cls: message.severity,
            };
            // An old live marker may have moved away from its provider's
            // snapshot. A freshly reported object at that same snapshot must
            // be projected anew rather than inheriting the old anchor's move.
            const position = message.location.position;
            canReuseReplacement =
              range.start.row === position.start.row &&
              range.start.column === position.start.column &&
              range.end.row === position.end.row &&
              range.end.column === position.end.column;
          }
          item.cls = message.severity;
          const oldItem = previous?.items[index];
          if (
            previous?.keys[index] !== key ||
            oldItem?.row !== item.row ||
            oldItem?.end !== item.end ||
            oldItem?.cls !== item.cls
          ) {
            unchanged = false;
          }
          nextProjection.set(key, {
            message,
            canReuseReplacement,
            tracksEdits,
            item,
          });
          return item;
        });
        cache.set("projection", nextProjection);
        cache.set("screenChanges", changes);
        changes.length = 0;
        cache.set("dirty", false);
        cache.set("sourceChanges", false);
        // Compare raw membership and rows, never layer.items: the hub's merge
        // can turn several diagnostics into one range and hide count changes.
        cache.set("rendered", {
          data,
          dataLength: data.length,
          showHints: this.showHints,
          projection: nextProjection,
          projectionSize: nextProjection.size,
          keys,
          items,
        });
        return unchanged ? null : items;
      },
    };
  },
};
