let runtime;
const getRuntime = () => (runtime ||= require("./marker-layer-runtime"));
const { CompositeDisposable } = require("lumine");
const EMPTY_MESSAGES = [];

// Each display event describes all its changes in the coordinates before that
// event. Different events follow one another, so apply a chunk's total offset
// only after checking all its ranges. Ranges that overlap a changed screen row
// take the editor's exact conversion; unaffected ranges only need row offsets.

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
      initialize: (...args) => getRuntime().initialize.apply(this, args),
      getItems: (...args) => getRuntime().getItems.apply(this, args),
    };
  },
};
