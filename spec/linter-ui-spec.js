const LinterUI = require("../lib/linter-ui");
const { normalizeMessages } = require("../lib/helpers");

// linter-ui owns the two marker axes: one layer per severity, one per tag. The
// decorations it registers are *layer* decorations, and editor.getDecorations()
// only walks per-marker decorations, so every rendering assertion here reads the
// DOM instead.
describe("lib/linter-ui", () => {
  let ui;
  let editor;
  let buffer;

  // Attach the editor element directly, with an explicit size: a component that
  // believes it is invisible skips its update entirely, so a workspace-hosted
  // editor in a headless spec never paints the decorations these specs read.
  beforeEach(() => {
    editor = lumine.workspace.buildTextEditor();
    editor.setText("const unused = 1;\nlegacy();\n");
    const element = lumine.views.getView(editor);
    element.style.height = "600px";
    element.style.width = "800px";
    jasmine.attachToDOM(element);
    buffer = editor.getBuffer();
    ui = new LinterUI();
    ui.patchEditor(editor);
    ui.setActiveItem(editor);
  });

  afterEach(() => {
    if (ui) {
      ui.dispose();
      ui = null;
    }
  });

  // location.buffer short-circuits the path matching in assignMessages, so no
  // fixture file has to exist on disk.
  const message = (overrides = {}) => ({
    severity: "hint",
    excerpt: "unused",
    location: {
      file: "/spec.js",
      buffer,
      position: [
        [0, 6],
        [0, 12],
      ],
    },
    ...overrides,
  });

  const publish = (messages, removed = []) => {
    normalizeMessages("spec", messages);
    ui.render({ added: messages, removed, messages });
  };

  // updateSync rather than getNextUpdatePromise: the decorations are in place by
  // the time render() returns, and awaiting a scheduled frame only adds a way
  // for the spec to hang.
  const rendered = (selector) => {
    const element = lumine.views.getView(editor);
    element.getComponent().updateSync();
    return element.querySelectorAll(selector);
  };

  describe("marker layers", () => {
    it("creates a layer for every severity and every tag", () => {
      expect(Object.keys(buffer.linterUI.severityLayers)).toEqual([
        "error",
        "warning",
        "info",
        "hint",
      ]);
      expect(Object.keys(buffer.linterUI.tagLayers)).toEqual(["unnecessary", "deprecated"]);
    });

    it("retires layers left by a build that kept them as direct keys", () => {
      const legacy = {
        error: buffer.addMarkerLayer(),
        warning: buffer.addMarkerLayer(),
        info: buffer.addMarkerLayer(),
      };
      const staleLayer = legacy.warning;
      buffer.linterUI = legacy;
      ui.patchedEditors.delete?.(editor);
      ui.patchedEditors = new WeakSet();
      ui.patchEditor(editor);
      expect(staleLayer.isDestroyed()).toBe(true);
      expect(buffer.linterUI.severityLayers.warning).toBeDefined();
    });
  });

  describe("rendering", () => {
    it("decorates a hint with its severity class", () => {
      publish([message()]);
      const spans = rendered(".linter-text.hint");
      expect(spans.length).toBeGreaterThan(0);
    });

    // The severity marker and the tag marker cover the same range, and the
    // editor merges overlapping text decorations into ONE span carrying every
    // class. This is the assertion that pins the whole two-axis design.
    it("puts the severity class and the tag class on the same span", () => {
      publish([message({ tags: ["unnecessary"] })]);
      const spans = rendered(".linter-text.hint.linter-tag-unnecessary");
      expect(spans.length).toBe(1);
      expect(spans[0].textContent).toBe("unused");
    });

    it("carries both tags at once", () => {
      publish([message({ tags: ["unnecessary", "deprecated"] })]);
      const spans = rendered(".linter-text.hint.linter-tag-unnecessary.linter-tag-deprecated");
      expect(spans.length).toBe(1);
    });

    it("tags nothing when the message has no tags", () => {
      publish([message()]);
      const tagged = rendered("[class*='linter-tag-']");
      expect(tagged.length).toBe(0);
    });

    it("decorates a non-empty range that ends exactly at EOF", () => {
      editor.setText("const unused");
      publish([message()]);

      const spans = rendered(".linter-text.hint");
      expect(spans.length).toBe(1);
      expect(spans[0].textContent).toBe("unused");
    });

    it("expands a zero-width diagnostic at EOF across its line", () => {
      editor.setText("const unused");
      publish([
        message({
          location: {
            file: "/spec.js",
            buffer,
            position: [
              [0, 12],
              [0, 12],
            ],
          },
        }),
      ]);

      const spans = rendered(".linter-text.hint");
      expect(spans.length).toBe(1);
      expect(spans[0].textContent).toBe("const unused");
    });

    // Tags decorate text only; the gutter dot carries the severity alone.
    it("never puts a tag class in the gutter", () => {
      publish([message({ tags: ["deprecated"] })]);
      const gutter = rendered(".linter-line-number[class*='linter-tag-']");
      expect(gutter.length).toBe(0);
    });
  });

  describe("marker bookkeeping", () => {
    const markersFor = (msg) => buffer.linterUI.markerMap.get(msg.key);

    it("tracks one marker per message plus one per tag", () => {
      const plain = message();
      const one = message({ tags: ["unnecessary"], excerpt: "one" });
      const both = message({ tags: ["unnecessary", "deprecated"], excerpt: "both" });
      publish([plain, one, both]);
      expect(markersFor(plain).length).toBe(1);
      expect(markersFor(one).length).toBe(2);
      expect(markersFor(both).length).toBe(3);
    });

    it("collects the tag markers when a message loses its tags", () => {
      const tagged = message({ tags: ["deprecated"] });
      publish([tagged]);
      expect(buffer.linterUI.tagLayers.deprecated.getMarkerCount()).toBe(1);

      const plain = message();
      normalizeMessages("spec", [plain]);
      expect(plain.key).not.toBe(tagged.key);
      ui.render({ added: [plain], removed: [tagged], messages: [plain] });

      expect(buffer.linterUI.tagLayers.deprecated.getMarkerCount()).toBe(0);
      expect(buffer.linterUI.markerMap.size).toBe(1);
    });

    // Validation is skipped outside dev mode on two of the three intake paths,
    // so an out-of-model severity reaches updateMarkers in a release build. It
    // used to throw here and take the whole render down with it.
    it("skips a severity outside the model without throwing", () => {
      const bogus = { ...message({ excerpt: "bogus" }), severity: "boom" };
      const good = message();
      expect(() => publish([bogus, good])).not.toThrow();
      expect(buffer.linterUI.markerMap.has(bogus.key)).toBe(false);
      expect(markersFor(good).length).toBe(1);
    });

    it("destroys every marker of every message on clearMessages", () => {
      publish([message({ tags: ["unnecessary", "deprecated"] })]);
      ui.clearMessages();
      expect(buffer.linterUI.markerMap.size).toBe(0);
      expect(buffer.linterUI.tagLayers.unnecessary.getMarkerCount()).toBe(0);
      expect(buffer.linterUI.tagLayers.deprecated.getMarkerCount()).toBe(0);
    });

    it("keeps markers valid while their provider recomputes", () => {
      const tracked = message({ tags: ["unnecessary"] });
      normalizeMessages("spec", [tracked], { markerInvalidation: "never" });
      ui.render({ added: [tracked], removed: [], messages: [tracked] });
      const markers = markersFor(tracked);

      editor.setTextInBufferRange(
        [
          [0, 7],
          [0, 7],
        ],
        "x",
      );

      expect(markers.every((marker) => marker.isValid())).toBe(true);
      expect(buffer.linterUI.markerMap.get(tracked.key)).toBe(markers);
    });

    it("does not extend an anchored zero-width diagnostic over inserted text", () => {
      editor.setText("const unused");
      const tracked = message({
        tags: ["unnecessary"],
        location: {
          file: "/spec.js",
          buffer,
          position: [
            [0, 12],
            [0, 12],
          ],
        },
      });
      normalizeMessages("spec", [tracked], { markerInvalidation: "never" });
      ui.render({ added: [tracked], removed: [], messages: [tracked] });
      const markers = markersFor(tracked);

      editor.setTextInBufferRange(
        [
          [0, 12],
          [0, 12],
        ],
        ".",
      );

      expect(markers.every((marker) => marker.isValid())).toBe(true);
      expect(markers.map((marker) => marker.getRange().serialize())).toEqual([
        [
          [0, 0],
          [0, 12],
        ],
        [
          [0, 0],
          [0, 12],
        ],
      ]);
    });

    it("invalidates markers by touch by default", () => {
      const classic = message({ tags: ["unnecessary"] });
      publish([classic]);
      const markers = markersFor(classic);

      editor.setTextInBufferRange(
        [
          [0, 7],
          [0, 7],
        ],
        "x",
      );

      expect(markers.every((marker) => !marker.isValid())).toBe(true);
    });
  });

  // Every spec above carries a `location.buffer`, which short-circuits the
  // matching. A provider that reports only a path — every language server does
  // — goes through the branch below instead.
  describe("matching a message to a buffer by path", () => {
    const windows = process.platform === "win32";
    const byPath = (file) => ({
      severity: "error",
      excerpt: "reported by path",
      location: {
        file,
        position: [
          [0, 6],
          [0, 12],
        ],
      },
    });

    it("finds the buffer when the provider spells the path its own way", () => {
      // Pyright and tsserver answer with a lowercase drive letter for the
      // `C:\…` they were handed. It is the same file, and it has to be treated
      // as one, or the message is stored and never shown.
      buffer.setPath(windows ? "C:\\project\\main.py" : "/project/main.py");
      publish([byPath(windows ? "c:/project/main.py" : "/project/main.py")]);
      expect(ui.getCurrentMessages().map((m) => m.excerpt)).toEqual(["reported by path"]);
    });

    it("still keeps a different file apart", () => {
      buffer.setPath(windows ? "C:\\project\\main.py" : "/project/main.py");
      publish([byPath(windows ? "C:\\project\\other.py" : "/project/other.py")]);
      expect(ui.getCurrentMessages()).toEqual([]);
    });
  });

  describe("dispose", () => {
    it("destroys both axes of layers", () => {
      const severityLayer = buffer.linterUI.severityLayers.hint;
      const tagLayer = buffer.linterUI.tagLayers.deprecated;
      ui.dispose();
      ui = null;
      expect(severityLayer.isDestroyed()).toBe(true);
      expect(tagLayer.isDestroyed()).toBe(true);
      expect(buffer.linterUI).toBeUndefined();
    });
  });
});
