const { CompositeDisposable, Disposable } = require("lumine");
const path = require("path");
const fs = require("fs");
const os = require("os");
const markerLayer = require("../lib/marker-layer");

// The hub's rule, mirrored: Windows treats `/` and `\` as one separator and is
// case-insensitive, so a message and a buffer naming the same file must compare
// equal. The real one is handed over on `attach`.
const normalizePath = (filePath) =>
  process.platform === "win32" ? filePath.replace(/\\/g, "/").toLowerCase() : filePath;

describe("linter marker layer", () => {
  let workspaceElement, editor, editorPath, tempDir;

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-marker-"));
    editorPath = path.join(tempDir, "sample.js");
    fs.writeFileSync(editorPath, Array(30).fill("lorem ipsum").join("\n"));
    editor = await lumine.workspace.open(editorPath);
    // The harness keeps one config for the whole window, so without this a spec
    // that enables hints leaves them enabled for every spec after it -- and the
    // next `set(true)` would be a no-op that never reaches the observer.
    lumine.config.unset("linter.marker.showHints");
    // The suite never activates the package (activation hooks); the module is
    // driven directly, exactly as `activate()` in lib/main.js drives it.
    markerLayer.activate();
  });

  afterEach(() => {
    markerLayer.deactivate();
    try {
      // Retries because Windows keeps a directory non-empty until the last handle on a
      // child closes, and `force` swallows only ENOENT.
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Windows can hold locks on freshly opened files; the OS cleans temp anyway.
    }
  });

  // `normalizedFile` is what the hub settles a message's path to and what every
  // consumer compares by, so a fixture without one is not a message the linter
  // could hand over.
  function message(severity, startRow, endRow, file = editorPath) {
    return {
      severity,
      location: {
        file,
        normalizedFile: normalizePath(file),
        position: {
          start: { row: startRow, column: 0 },
          end: { row: endRow, column: 5 },
        },
      },
    };
  }

  function createLayer(layerEditor, props = markerLayer.provideMarkerLayer()) {
    const layer = {
      editor: layerEditor,
      props,
      cache: new Map(),
      items: [],
      disposables: new CompositeDisposable(),
      update: jasmine.createSpy("update"),
    };
    // Attached the way the marker hub attaches it.
    props.initialize(layer);
    return layer;
  }

  describe("the internal linter.ui", () => {
    let ui;

    beforeEach(() => {
      ui = markerLayer.buildUI();
      ui.attach({ normalizePath });
    });

    it("matches the shape expected by the linter package", () => {
      expect(typeof ui.name).toBe("string");
      expect(typeof ui.render).toBe("function");
      expect(typeof ui.attach).toBe("function");
    });

    // A server answers with its own spelling of the path it was handed — a
    // lowercase drive letter for `C:\…` is the usual one. Compared raw, its
    // diagnostics marked nothing at all.
    it("marks a file the provider spelled differently", () => {
      // Only asserted on Windows: it is the platform where two spellings are
      // one file, and off it a different spelling is a different file.
      if (process.platform !== "win32") return;
      const layer = createLayer(editor);
      const spelling = editorPath
        .replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase())
        .replace(/\\/g, "/");
      const messages = [message("error", 1, 1, spelling)];

      ui.render({ added: messages, removed: [], messages });

      expect(layer.cache.get("data").length).toBe(1);
    });

    it("stores rendered messages on the module", () => {
      const messages = [message("error", 1, 1)];
      ui.render({ added: messages, removed: [], messages });
      expect(markerLayer.messages).toBe(messages);
    });

    it("pushes messages of the matching file into the linter layer", () => {
      const layer = createLayer(editor);

      const own = message("error", 2, 3);
      const foreign = message("warning", 5, 5, path.join(tempDir, "other.js"));
      ui.render({ added: [own, foreign], removed: [], messages: [own, foreign] });

      expect(layer.cache.get("data")).toEqual([own]);
      expect(layer.update).toHaveBeenCalled();

      layer.disposables.dispose();
    });

    it("does not touch the layer when the patch concerns other files", () => {
      const layer = createLayer(editor);

      const foreign = message("warning", 5, 5, path.join(tempDir, "other.js"));
      ui.render({ added: [foreign], removed: [], messages: [foreign] });

      // The layer keeps the empty seed from initialize; the foreign patch
      // neither updates the data nor schedules a redraw.
      expect(layer.cache.get("data")).toEqual([]);
      expect(layer.update).not.toHaveBeenCalled();

      layer.disposables.dispose();
    });

    it("clears layer data when messages are removed", () => {
      const layer = createLayer(editor);

      const own = message("error", 2, 3);
      ui.render({ added: [own], removed: [], messages: [own] });
      expect(layer.cache.get("data")).toEqual([own]);

      ui.render({ added: [], removed: [own], messages: [] });
      expect(layer.cache.get("data")).toEqual([]);

      layer.disposables.dispose();
    });
  });

  describe("marker.layer service provider", () => {
    let provider;

    beforeEach(() => {
      // In the package the UI is registered before any layer can attach, so a
      // layer never sees the module without the hub's path rule.
      markerLayer.buildUI().attach({ normalizePath });
      provider = markerLayer.provideMarkerLayer();
    });

    it("describes the linter layer", () => {
      expect(provider.name).toBe("linter");
      expect(provider.position).toBe("left");
      expect(provider.merge).toBe(true);
      expect(provider.enabled).toBe("linter.marker.enabled");
      expect(provider.threshold).toBe("linter.marker.threshold");
      expect(typeof provider.initialize).toBe("function");
      expect(typeof provider.getItems).toBe("function");
    });

    it("seeds the cache with current messages for the layer editor", () => {
      const own = message("error", 1, 1);
      const foreign = message("info", 2, 2, path.join(tempDir, "other.js"));
      markerLayer.messages = [own, foreign];

      const layer = createLayer(editor, provider);
      expect(layer.cache.get("data")).toEqual([own]);
      layer.disposables.dispose();
    });

    it("maps messages to raw markers with severity classes", () => {
      const layer = createLayer(editor, provider);
      layer.cache.set("data", [
        message("error", 4, 6),
        message("error", 2, 3),
        message("warning", 10, 10),
      ]);

      // Sorting and merging are left to the host.
      const items = provider.getItems(layer);
      expect(items).toEqual([
        { row: 4, end: 6, cls: "error" },
        { row: 2, end: 3, cls: "error" },
        { row: 10, end: 10, cls: "warning" },
      ]);

      layer.disposables.dispose();
    });

    it("projects the live diagnostic range after edits move it", () => {
      const layer = createLayer(editor, provider);
      const tracked = message("warning", 2, 3);
      tracked.location.displayRange = {
        start: { row: 5, column: 0 },
        end: { row: 6, column: 5 },
      };
      layer.cache.set("data", [tracked]);

      expect(provider.getItems(layer)).toEqual([{ row: 5, end: 6, cls: "warning" }]);

      layer.disposables.dispose();
    });

    it("drops hint messages by default", () => {
      const layer = createLayer(editor, provider);
      layer.cache.set("data", [message("error", 1, 1), message("hint", 4, 4)]);

      expect(provider.getItems(layer)).toEqual([{ row: 1, end: 1, cls: "error" }]);

      layer.disposables.dispose();
    });

    it("maps hint messages once they are enabled", () => {
      lumine.config.set("linter.marker.showHints", true);
      const layer = createLayer(editor, provider);
      layer.cache.set("data", [message("error", 1, 1), message("hint", 4, 4)]);

      expect(provider.getItems(layer)).toEqual([
        { row: 1, end: 1, cls: "error" },
        { row: 4, end: 4, cls: "hint" },
      ]);

      layer.disposables.dispose();
    });

    it("re-runs the layer when the hint setting is toggled", () => {
      const layer = createLayer(editor, provider);
      expect(layer.update).not.toHaveBeenCalled();

      lumine.config.set("linter.marker.showHints", true);
      expect(layer.update).toHaveBeenCalled();

      layer.disposables.dispose();
    });

    it("returns no items without cached data", () => {
      const layer = createLayer(editor, provider);
      layer.cache.clear();
      expect(provider.getItems(layer)).toEqual([]);
      layer.disposables.dispose();
    });

    describe("cached screen projection", () => {
      let layer;

      beforeEach(() => {
        layer = createLayer(editor, provider);
      });

      afterEach(() => layer.disposables.dispose());

      function tracked(row, key = `row-${row}`) {
        const result = message("warning", row, row);
        result.key = key;
        const marker = editor.getBuffer().markRange(result.location.position, {
          invalidate: "never",
          exclusive: true,
        });
        Object.defineProperty(result.location, "displayRange", {
          configurable: true,
          get: () => marker.getRange(),
        });
        layer.disposables.add(new Disposable(() => marker.destroy()));
        return result;
      }

      function exactItems(messages) {
        return messages.map((entry) => {
          const range = entry.location.displayRange || entry.location.position;
          const start = editor.screenPositionForBufferPosition(range.start).row;
          const end = editor.screenPositionForBufferPosition(range.end).row;
          return { row: Math.min(start, end), end: Math.max(start, end), cls: entry.severity };
        });
      }

      it("reuses unchanged diagnostics recreated by a provider", () => {
        const first = [tracked(2), tracked(10), tracked(20)];
        layer.cache.set("data", first);
        provider.getItems(layer);
        spyOn(editor, "screenPositionForBufferPosition").and.callThrough();
        const replacements = [tracked(2), tracked(10), tracked(20)];
        layer.cache.set("data", replacements);

        const result = provider.getItems(layer);

        expect(editor.screenPositionForBufferPosition).not.toHaveBeenCalled();
        expect(result).toEqual(exactItems(replacements));
      });

      it("reuses a repeated snapshot before its replacement gets an inline marker", () => {
        const original = tracked(10);
        layer.cache.set("data", [original]);
        provider.getItems(layer);
        spyOn(editor, "screenPositionForBufferPosition").and.callThrough();
        const replacement = message("warning", 10, 10);
        replacement.key = original.key;
        layer.cache.set("data", [replacement]);

        const result = provider.getItems(layer);

        expect(editor.screenPositionForBufferPosition).not.toHaveBeenCalled();
        expect(result).toEqual(exactItems([replacement]));
      });

      it("projects only diagnostics on the wrapped row being edited", () => {
        editor.getBuffer().setTextInRange(
          [
            [10, 0],
            [10, 11],
          ],
          "x".repeat(30),
        );
        editor.displayLayer.reset({ softWrapColumn: 20 });
        const messages = [tracked(2), tracked(10), tracked(20)];
        layer.cache.set("data", messages);
        provider.getItems(layer);
        spyOn(editor, "screenPositionForBufferPosition").and.callThrough();

        editor.getBuffer().insert([10, 0], "xx");
        const result = provider.getItems(layer);

        expect(editor.screenPositionForBufferPosition).toHaveBeenCalledTimes(2);
        expect(result).toEqual(exactItems(messages));
      });

      it("replays disjoint changes within a transaction and later changes in order", () => {
        const messages = [tracked(2), tracked(10), tracked(20)];
        layer.cache.set("data", messages);
        provider.getItems(layer);

        editor.getBuffer().transact(() => {
          editor.getBuffer().insert([5, 0], "\n");
          editor.getBuffer().insert([15, 0], "\n");
        });
        editor.getBuffer().insert([8, 0], "\n");

        expect(provider.getItems(layer)).toEqual(exactItems(messages));
      });

      it("keeps snapshot rows fixed when no inline marker tracks an edit", () => {
        const messages = [message("warning", 2, 2), message("warning", 20, 20)];
        layer.cache.set("data", messages);
        provider.getItems(layer);

        editor.getBuffer().insert([5, 0], "\n");

        expect(provider.getItems(layer)).toEqual(exactItems(messages));
      });

      it("starts a new anchor when a provider repeats a moved diagnostic's old snapshot", () => {
        const original = tracked(10);
        layer.cache.set("data", [original]);
        provider.getItems(layer);
        editor.getBuffer().insert([5, 0], "\n");
        expect(provider.getItems(layer)[0].row).toBe(11);
        const replacement = tracked(10);
        layer.cache.set("data", [replacement]);

        expect(provider.getItems(layer)).toEqual([{ row: 10, end: 10, cls: "warning" }]);
      });

      it("reprojects diagnostics covered by a fold and offsets the later ones", () => {
        const messages = [tracked(2), tracked(10), tracked(20)];
        layer.cache.set("data", messages);
        provider.getItems(layer);

        const fold = editor.foldBufferRange([
          [4, 0],
          [12, 5],
        ]);
        expect(provider.getItems(layer)).toEqual(exactItems(messages));
        editor.unfoldBufferRow(4);
        expect(provider.getItems(layer)).toEqual(exactItems(messages));
        expect(fold).toBeDefined();
      });

      it("invalidates the full projection when the wrap column resets", () => {
        editor.getBuffer().setTextInRange(
          [
            [10, 0],
            [10, 11],
          ],
          "x".repeat(60),
        );
        editor.displayLayer.reset({ softWrapColumn: 40 });
        const messages = [tracked(2), tracked(10), tracked(20)];
        layer.cache.set("data", messages);
        provider.getItems(layer);

        editor.displayLayer.reset({ softWrapColumn: 20 });

        expect(provider.getItems(layer)).toEqual(exactItems(messages));
      });

      it("coalesces pending same-row typing before a later overview update", () => {
        const messages = [tracked(2), tracked(10), tracked(20)];
        layer.cache.set("data", messages);
        provider.getItems(layer);
        spyOn(editor, "screenPositionForBufferPosition").and.callThrough();

        for (let i = 0; i < 80; i++) {
          editor.getBuffer().insert([10, 0], "x");
        }
        const result = provider.getItems(layer);

        expect(editor.screenPositionForBufferPosition).toHaveBeenCalledTimes(2);
        expect(result).toEqual(exactItems(messages));
      });
    });
  });
});
