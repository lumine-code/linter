const { CompositeDisposable, Disposable } = require("lumine");

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

  buildUI() {
    return {
      name: "linter-markers",
      attach: (hub) => {
        this.hub = hub;
      },
      render: ({ added, messages, removed }) => {
        this.messages = messages;
        for (const [editor, layer] of this.layers) {
          const editorPath = this.pathOf(editor);
          if (this.mentions(added, editorPath) || this.mentions(removed, editorPath)) {
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
        layer.disposables.add(new Disposable(() => this.layers.delete(layer.editor)));
        layer.cache.set("data", this.messagesFor(this.pathOf(layer.editor)));
      },
      getItems: ({ editor, cache }) => {
        const data = cache.get("data") ?? [];
        // Dropped here rather than painted transparent: the threshold counts the
        // items a layer returns, and once it is exceeded every renderer skips
        // that layer whole, so a flood of hints would take the error markers
        // down with it.
        const shown = this.showHints ? data : data.filter((m) => m.severity !== "hint");
        return shown.map((message) => {
          const startRow = editor.screenPositionForBufferPosition(
            message.location.position.start,
          ).row;
          const endRow = editor.screenPositionForBufferPosition(message.location.position.end).row;
          return {
            row: Math.min(startRow, endRow),
            end: Math.max(startRow, endRow),
            cls: message.severity,
          };
        });
      },
    };
  },
};
