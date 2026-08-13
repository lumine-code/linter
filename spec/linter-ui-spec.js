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
  let extraEditors;

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
    extraEditors = [];
    ui = new LinterUI();
    ui.patchEditor(editor);
    ui.setActiveItem(editor);
  });

  afterEach(() => {
    if (ui) {
      ui.dispose();
      ui = null;
    }
    for (const extraEditor of extraEditors) {
      extraEditor.destroy();
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

  // Inline decorations are skipped for a file too big to be worth decorating.
  // The verdict used to be taken once, when the editor was first seen, so a file
  // that grew past the threshold went on being decorated and one that was
  // generated long and then emptied never got its decorations back.
  describe("a buffer too large to decorate", () => {
    // Past the default longLineLength, and appended rather than set so the
    // markers already on the first row are not invalidated by the edit itself.
    const longLine = "x".repeat(5000);

    const onRow = (excerpt, row) =>
      message({
        excerpt,
        location: {
          file: "/spec.js",
          buffer,
          position: [
            [row, 0],
            [row, 6],
          ],
        },
      });

    it("decorates nothing once the buffer has grown past the threshold", () => {
      publish([message()]);
      expect(buffer.linterUI.markerMap.size).toBe(1);

      buffer.append(`${longLine}\n`);
      publish([onRow("after growing", 1)]);

      expect(buffer.linterUI.isLargeFile).toBe(true);
      // Including whatever was decorated while it was small enough: nothing
      // maintains those markers from here.
      expect(buffer.linterUI.markerMap.size).toBe(0);
    });

    it("decorates everything it holds once the buffer is small again", () => {
      buffer.append(`${longLine}\n`);
      const first = message({ excerpt: "while large" });
      publish([first]);
      expect(buffer.linterUI.isLargeFile).toBe(true);
      expect(buffer.linterUI.markerMap.size).toBe(0);

      buffer.deleteRow(2);
      const second = onRow("while small", 1);
      normalizeMessages("spec", [second]);
      ui.render({ added: [second], removed: [], messages: [first, second] });

      expect(buffer.linterUI.isLargeFile).toBe(false);
      // Both of them: the one published while it was too large was never
      // decorated, so it is new here too.
      expect(buffer.linterUI.markerMap.size).toBe(2);
    });

    it("measures again when the threshold changes", () => {
      buffer.append(`${"x".repeat(600)}\n`);
      publish([message()]);
      expect(buffer.linterUI.isLargeFile).toBe(false);

      lumine.config.set("linter.longLineLength", 500);
      publish([onRow("after the setting changed", 1)]);

      expect(buffer.linterUI.isLargeFile).toBe(true);
    });
  });

  // The buffer set is read twice on every publish. It used to be rebuilt from
  // the workspace each time, which meant flattening every pane container's
  // items; it is kept now, against the number of editors showing each buffer.
  describe("which buffers the UI knows about", () => {
    const buffersOf = () => Array.from(ui.getBuffers());

    it("keeps a buffer while another editor is still showing it", () => {
      const split = lumine.workspace.buildTextEditor({ buffer });
      ui.patchEditor(split);
      expect(buffersOf()).toEqual([buffer]);

      split.destroy();

      expect(buffersOf()).toEqual([buffer]);
      expect(buffer.linterUI).toBeDefined();
    });

    it("retires the buffer's layers with the last editor showing it", () => {
      const other = lumine.workspace.buildTextEditor();
      const otherBuffer = other.getBuffer();
      ui.patchEditor(other);
      const layer = otherBuffer.linterUI.severityLayers.error;
      expect(buffersOf().length).toBe(2);

      other.destroy();

      expect(buffersOf()).toEqual([buffer]);
      expect(otherBuffer.linterUI).toBeUndefined();
      expect(layer.isDestroyed()).toBe(true);
    });

    it("patches a buffer again after it has been released", () => {
      const other = lumine.workspace.buildTextEditor();
      const otherBuffer = other.getBuffer();
      ui.patchEditor(other);
      other.destroy();

      const reopened = lumine.workspace.buildTextEditor({ buffer: otherBuffer });
      extraEditors.push(reopened);
      ui.patchEditor(reopened);

      expect(otherBuffer.linterUI.severityLayers.error.isDestroyed()).toBe(false);
      expect(buffersOf().length).toBe(2);
    });
  });

  describe("adapter marker projection", () => {
    const buildVisibleEditor = () => {
      const target = lumine.workspace.buildTextEditor();
      target.setText("const unused = 1;\n");
      const element = lumine.views.getView(target);
      element.style.height = "600px";
      element.style.width = "800px";
      jasmine.attachToDOM(element);
      extraEditors.push(target);
      ui.patchEditor(target);
      return target;
    };

    const renderEditor = (target) => {
      const element = lumine.views.getView(target);
      element.getComponent().updateSync();
      return element.querySelectorAll(".linter-text.hint");
    };

    it("hands the messages straight back when no adapter projects", () => {
      const messages = [message()];
      normalizeMessages("spec", messages);

      expect(ui.getMarkerMessages(messages)).toBe(messages);

      ui.addItemAdapter({ getMarkerLocationsForMessage: () => [{ buffer }] });
      expect(ui.getMarkerMessages(messages)).not.toBe(messages);
    });

    it("renders one registry message in every projected split buffer", () => {
      const splitEditor = buildVisibleEditor();
      const splitBuffer = splitEditor.getBuffer();
      const originalBuffer = { name: "notebook source buffer" };
      const original = message({
        location: {
          file: "/notebook.ipynb",
          buffer: originalBuffer,
          cell: 1,
          position: [
            [0, 6],
            [0, 12],
          ],
        },
      });
      ui.addItemAdapter({
        getMarkerLocationsForMessage: () => [{ buffer }, { buffer: splitBuffer }],
      });

      publish([original]);

      expect(renderEditor(editor).length).toBeGreaterThan(0);
      expect(renderEditor(splitEditor).length).toBeGreaterThan(0);
      expect(ui.allMessages).toEqual([original]);
      expect(original.location.buffer).toBe(originalBuffer);
      expect(buffer.linterUI.messages.length).toBe(1);
      expect(splitBuffer.linterUI.messages.length).toBe(1);
      expect(buffer.linterUI.messages[0].location.buffer).toBe(buffer);
      expect(splitBuffer.linterUI.messages[0].location.buffer).toBe(splitBuffer);
      expect(buffer.linterUI.messages[0].location.displayRange).toBeDefined();
      expect(splitBuffer.linterUI.messages[0].location.displayRange).toBeDefined();
    });

    it("removes projected markers from every target buffer", () => {
      const splitEditor = buildVisibleEditor();
      const splitBuffer = splitEditor.getBuffer();
      const original = message();
      ui.addItemAdapter({
        getMarkerLocationsForMessage: () => [{ buffer }, { buffer: splitBuffer }],
      });
      publish([original]);

      ui.render({ added: [], removed: [original], messages: [] });

      expect(buffer.linterUI.markerMap.size).toBe(0);
      expect(splitBuffer.linterUI.markerMap.size).toBe(0);
      expect(buffer.linterUI.messages).toEqual([]);
      expect(splitBuffer.linterUI.messages).toEqual([]);
    });

    it("keeps a never-invalidated projected marker through an edit that touches it", () => {
      // The shape language-server cell diagnostics arrive in: file and cell,
      // no buffer of their own — the adapter's projection is the only way
      // onto a buffer. The delegate said "never", and the invalidation is
      // recorded against the ORIGINAL message; asking with the projected
      // clone used to answer "touch", so the first keystroke that brushed a
      // notebook marker destroyed it for good.
      const original = message({
        location: {
          file: "/notebook.ipynb",
          cell: 1,
          position: [
            [0, 6],
            [0, 12],
          ],
        },
      });
      normalizeMessages("spec", [original], { markerInvalidation: "never" });
      ui.addItemAdapter({
        getMarkerLocationsForMessage: () => [{ buffer }],
      });
      ui.render({ added: [original], removed: [], messages: [original] });
      expect(buffer.linterUI.markerMap.size).toBe(1);

      // An edit inside the marker range — what typing or an undo does.
      editor.setTextInBufferRange(
        [
          [0, 8],
          [0, 8],
        ],
        "x",
      );
      expect(buffer.linterUI.markerMap.size).toBe(1);
      expect(buffer.linterUI.markerMap.values().next().value[0].isDestroyed()).toBe(false);
    });

    it("re-creates markers the map lost while their messages stayed current", () => {
      const original = message({
        location: {
          file: "/notebook.ipynb",
          cell: 1,
          position: [
            [0, 6],
            [0, 12],
          ],
        },
      });
      normalizeMessages("spec", [original], { markerInvalidation: "never" });
      ui.addItemAdapter({
        getMarkerLocationsForMessage: () => [{ buffer }],
      });
      ui.render({ added: [original], removed: [], messages: [original] });
      expect(buffer.linterUI.markerMap.size).toBe(1);

      // Whatever desyncs the map from the current set — a transient
      // projection failure, an external teardown — the next render with no
      // added or removed messages must repair it.
      for (const markers of buffer.linterUI.markerMap.values())
        for (const marker of markers) marker.destroy();
      buffer.linterUI.markerMap.clear();

      ui.render({ added: [], removed: [], messages: [original] });
      expect(buffer.linterUI.markerMap.size).toBe(1);
      expect(rendered(".linter-text.hint").length).toBeGreaterThan(0);
    });

    it("deletes the registry-owned message when a projected marker is invalidated", () => {
      const original = message();
      ui.addItemAdapter({
        getMarkerLocationsForMessage: () => [{ buffer }],
      });
      ui.onDeleteMessages = jasmine.createSpy("onDeleteMessages");
      publish([original]);

      editor.setTextInBufferRange(
        [
          [0, 7],
          [0, 7],
        ],
        "x",
      );
      ui.flushPendingDeletions();

      expect(ui.onDeleteMessages).toHaveBeenCalledWith([original]);
    });
  });

  // One edit invalidates every marker it touched, and the buffer reports them
  // one at a time. Asking for each deletion separately re-runs the whole render
  // pipeline once per message, which is what makes deleting a block of lines in
  // a heavily linted file stall.
  describe("batching invalidated markers", () => {
    it("asks for every message an edit invalidated in one call", async () => {
      const messages = [
        message({ excerpt: "one" }),
        message({
          excerpt: "two",
          location: {
            file: "/spec.js",
            buffer,
            position: [
              [1, 0],
              [1, 6],
            ],
          },
        }),
      ];
      ui.onDeleteMessages = jasmine.createSpy("onDeleteMessages");
      publish(messages);
      expect(buffer.linterUI.markerMap.size).toBe(2);

      // One edit spanning both messages, so both markers invalidate together.
      buffer.setTextInRange(
        [
          [0, 0],
          [1, 9],
        ],
        "",
      );
      await Promise.resolve();

      expect(ui.onDeleteMessages.calls.count()).toBe(1);
      expect(
        ui.onDeleteMessages.calls
          .argsFor(0)[0]
          .map((m) => m.excerpt)
          .sort(),
      ).toEqual(["one", "two"]);
    });

    it("drops queued deletions when the UI is disposed before the flush", async () => {
      const deleted = [];
      ui.onDeleteMessages = (list) => deleted.push(...list);
      publish([message()]);

      buffer.setTextInRange(
        [
          [0, 0],
          [0, 17],
        ],
        "",
      );
      ui.dispose();
      ui = null;
      await Promise.resolve();

      expect(deleted).toEqual([]);
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
