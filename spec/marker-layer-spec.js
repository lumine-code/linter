const { CompositeDisposable } = require("lumine");
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
  });
});
