const { CompositeDisposable, Disposable } = require("lumine");
const path = require("path");
const fs = require("fs");
const os = require("os");
const markerLayer = require("../lib/marker-layer");

// The hub's rule, mirrored: Windows treats `/` and `\` as one separator and is
// case-insensitive, so a message and a buffer naming the same file must compare
// equal. The real one is handed over on `attach`.
const normalizePath = (filePath) =>
  typeof filePath === "string" && process.platform === "win32"
    ? filePath.replace(/\\/g, "/").toLowerCase()
    : filePath;

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

    it("refreshes updated message objects even when overview geometry is unchanged", () => {
      const layer = createLayer(editor);
      const original = message("warning", 2, 3);
      original.key = "same-diagnostic";
      ui.render({ added: [original], removed: [], messages: [original] });
      layer.props.getItems(layer);
      layer.update.calls.reset();
      const replacement = message("warning", 2, 3);
      replacement.key = original.key;

      ui.render({ added: [], removed: [], updated: [replacement], messages: [replacement] });

      expect(layer.cache.get("data")).toEqual([replacement]);
      expect(layer.update).toHaveBeenCalledTimes(1);
      expect(layer.props.getItems(layer)).toBeNull();
      expect(layer.cache.get("projection").get(original.key).message).toBe(replacement);
      layer.disposables.dispose();
    });

    it("ignores updated diagnostics belonging to other files", () => {
      const layer = createLayer(editor);
      const foreign = message("warning", 5, 5, path.join(tempDir, "other.js"));

      ui.render({ added: [], removed: [], updated: [foreign], messages: [foreign] });

      expect(layer.cache.get("data")).toEqual([]);
      expect(layer.update).not.toHaveBeenCalled();
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

      // Direct provider calls do not run the hub's assignment to layer.items.
      // A null return keeps its previous raw output; the provider's saved
      // projection remains available to assert against an exact conversion.
      function currentItems() {
        return provider.getItems(layer) ?? layer.cache.get("rendered").items;
      }

      it("skips an unchanged snapshot without filtering or projecting it again", () => {
        const messages = [tracked(2), tracked(10), tracked(20)];
        layer.cache.set("data", messages);
        provider.getItems(layer);
        spyOn(messages, "filter").and.callThrough();
        spyOn(editor, "screenPositionForBufferPosition").and.callThrough();

        expect(provider.getItems(layer)).toBeNull();

        expect(messages.filter).not.toHaveBeenCalled();
        expect(editor.screenPositionForBufferPosition).not.toHaveBeenCalled();
      });

      it("keeps an empty snapshot after its initial clear", () => {
        expect(provider.getItems(layer)).toEqual([]);
        expect(provider.getItems(layer)).toBeNull();
      });

      it("reuses unchanged diagnostics recreated by a provider", () => {
        const first = [tracked(2), tracked(10), tracked(20)];
        layer.cache.set("data", first);
        provider.getItems(layer);
        spyOn(editor, "screenPositionForBufferPosition").and.callThrough();
        const replacements = [tracked(2), tracked(10), tracked(20)];
        layer.cache.set("data", replacements);

        const result = provider.getItems(layer);

        expect(editor.screenPositionForBufferPosition).not.toHaveBeenCalled();
        expect(result).toBeNull();
        expect(layer.cache.get("rendered").items).toEqual(exactItems(replacements));
        expect(layer.cache.get("projection").get(replacements[0].key).message).toBe(
          replacements[0],
        );
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
        expect(result).toBeNull();
        expect(layer.cache.get("rendered").items).toEqual(exactItems([replacement]));
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
        expect(result).toBeNull();
        expect(layer.cache.get("rendered").items).toEqual(exactItems(messages));
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

        expect(currentItems()).toEqual(exactItems(messages));
      });

      it("keeps snapshot rows fixed when no inline marker tracks an edit", () => {
        const messages = [message("warning", 2, 2), message("warning", 20, 20)];
        layer.cache.set("data", messages);
        provider.getItems(layer);

        editor.getBuffer().insert([5, 0], "\n");

        expect(currentItems()).toEqual(exactItems(messages));
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
        expect(currentItems()).toEqual(exactItems(messages));
        editor.unfoldBufferRow(4);
        expect(currentItems()).toEqual(exactItems(messages));
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

        expect(currentItems()).toEqual(exactItems(messages));
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
        expect(result).toBeNull();
        expect(layer.cache.get("rendered").items).toEqual(exactItems(messages));
      });

      it("consumes layout changes after the diagnostics without normalizing unchanged rows", () => {
        const messages = [tracked(2), tracked(10)];
        layer.cache.set("data", messages);
        provider.getItems(layer);
        editor.getBuffer().insert([25, 0], "\n");

        expect(provider.getItems(layer)).toBeNull();
        expect(layer.cache.get("screenChanges")).toEqual([]);
        expect(layer.cache.get("rendered").items).toEqual(exactItems(messages));

        editor.getBuffer().insert([5, 0], "\n");
        expect(provider.getItems(layer)).toEqual(exactItems(messages));
      });

      it("reprojects a reset even when it reproduces the same overview rows", () => {
        const messages = [tracked(2), tracked(10)];
        layer.cache.set("data", messages);
        provider.getItems(layer);
        spyOn(editor, "screenPositionForBufferPosition").and.callThrough();
        editor.displayLayer.reset({ softWrapColumn: 80 });
        editor.screenPositionForBufferPosition.calls.reset();

        expect(provider.getItems(layer)).toBeNull();
        expect(editor.screenPositionForBufferPosition).toHaveBeenCalledTimes(4);
        expect(layer.cache.get("rendered").items).toEqual(exactItems(messages));
      });

      it("reprojects a full replacement with the same line count", () => {
        const messages = [tracked(2), tracked(10)];
        layer.cache.set("data", messages);
        provider.getItems(layer);
        spyOn(editor, "screenPositionForBufferPosition").and.callThrough();

        editor.setText(editor.getText().replaceAll("lorem", "other"));
        const items = currentItems();

        expect(editor.screenPositionForBufferPosition).toHaveBeenCalledTimes(4);
        expect(items).toEqual(exactItems(messages));
      });

      it("refreshes a retired getter before later source edits", () => {
        const diagnostic = tracked(10);
        layer.cache.set("data", [diagnostic]);
        provider.getItems(layer);
        const retiredRange = diagnostic.location.displayRange;
        Object.defineProperty(diagnostic.location, "displayRange", {
          configurable: true,
          writable: true,
          value: retiredRange,
        });
        markerLayer.invalidateBuffer(editor.getBuffer());

        expect(provider.getItems(layer)).toBeNull();
        expect(layer.cache.get("projection").get(diagnostic.key).tracksEdits).toBe(false);
        editor.getBuffer().insert([5, 0], "\n");
        expect(provider.getItems(layer)).toBeNull();
        expect(layer.cache.get("rendered").items).toEqual([{ row: 10, end: 10, cls: "warning" }]);
      });

      it("reprojects a rebound getter even when its descriptor still tracks edits", () => {
        const diagnostic = tracked(2);
        layer.cache.set("data", [diagnostic]);
        provider.getItems(layer);
        Object.defineProperty(diagnostic.location, "displayRange", {
          configurable: true,
          get: () => ({ start: { row: 10, column: 0 }, end: { row: 10, column: 5 } }),
        });

        markerLayer.invalidateBuffer(editor.getBuffer());

        expect(provider.getItems(layer)).toEqual([{ row: 10, end: 10, cls: "warning" }]);
        expect(layer.update).toHaveBeenCalledTimes(1);
      });

      it("reprojects a retired getter selectively while reusing unrelated anchors", () => {
        const diagnostics = [tracked(2), tracked(10), tracked(20)];
        layer.cache.set("data", diagnostics);
        provider.getItems(layer);
        const retired = diagnostics[1];
        Object.defineProperty(retired.location, "displayRange", {
          configurable: true,
          writable: true,
          value: retired.location.displayRange,
        });
        spyOn(editor, "screenPositionForBufferPosition").and.callThrough();

        markerLayer.invalidateBuffer(editor.getBuffer(), { resetProjection: false });

        expect(provider.getItems(layer)).toBeNull();
        expect(editor.screenPositionForBufferPosition).toHaveBeenCalledTimes(2);
        expect(layer.cache.get("projection").get(retired.key).tracksEdits).toBe(false);
        expect(layer.cache.get("rendered").items).toEqual(exactItems(diagnostics));
      });

      it("keeps pending layout shifts while selectively retiring an anchor", () => {
        const diagnostics = [tracked(2), tracked(10), tracked(20)];
        layer.cache.set("data", diagnostics);
        provider.getItems(layer);
        editor.getBuffer().insert([5, 0], "\n");
        const retired = diagnostics[1];
        Object.defineProperty(retired.location, "displayRange", {
          configurable: true,
          writable: true,
          value: retired.location.displayRange,
        });
        spyOn(editor, "screenPositionForBufferPosition").and.callThrough();

        markerLayer.invalidateBuffer(editor.getBuffer(), { resetProjection: false });
        const items = provider.getItems(layer);

        expect(editor.screenPositionForBufferPosition).toHaveBeenCalledTimes(2);
        expect(items).toEqual(exactItems(diagnostics));
        expect(items.map((item) => item.row)).toEqual([2, 11, 21]);
      });

      it("invalidates only editors of the changed buffer", () => {
        const other = lumine.workspace.buildTextEditor();
        const otherLayer = createLayer(other, provider);
        markerLayer.invalidateBuffer(editor.getBuffer());

        expect(layer.update).toHaveBeenCalledTimes(1);
        expect(otherLayer.update).not.toHaveBeenCalled();
        otherLayer.disposables.dispose();
        other.destroy();
      });

      it("preserves a change of keys even when their geometry is identical", () => {
        const original = tracked(2, "old-key");
        layer.cache.set("data", [original]);
        provider.getItems(layer);
        const replacement = tracked(2, "new-key");
        layer.cache.set("data", [replacement]);

        expect(provider.getItems(layer)).toEqual([{ row: 2, end: 2, cls: "warning" }]);
        expect(layer.cache.get("projection").has(original.key)).toBe(false);
        expect(layer.cache.get("projection").get(replacement.key).message).toBe(replacement);
      });

      it("preserves raw membership changes hidden by the hub's range merging", () => {
        const first = tracked(2, "first");
        const second = tracked(2, "second");
        layer.cache.set("data", [first, second]);
        provider.getItems(layer);
        layer.items = [{ row: 2, end: 2, cls: "warning" }];
        layer.cache.set("data", [first]);

        expect(provider.getItems(layer)).toEqual([{ row: 2, end: 2, cls: "warning" }]);
      });

      it("does not hide a severity change at unchanged rows", () => {
        const diagnostic = tracked(2);
        layer.cache.set("data", [diagnostic]);
        provider.getItems(layer);
        const replacement = message("error", 2, 2);
        replacement.key = diagnostic.key;
        layer.cache.set("data", [replacement]);

        expect(provider.getItems(layer)).toEqual([{ row: 2, end: 2, cls: "error" }]);
      });

      it("revisits hidden hints when the setting changes", () => {
        const diagnostic = message("hint", 2, 2);
        layer.cache.set("data", [diagnostic]);
        expect(provider.getItems(layer)).toEqual([]);
        expect(provider.getItems(layer)).toBeNull();

        lumine.config.set("linter.marker.showHints", true);

        expect(provider.getItems(layer)).toEqual([{ row: 2, end: 2, cls: "hint" }]);
        lumine.config.set("linter.marker.showHints", false);
        expect(provider.getItems(layer)).toEqual([]);
      });
    });
  });
});
