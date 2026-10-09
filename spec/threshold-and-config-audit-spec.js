describe("Linter same-line length thresholds", () => {
  let ui, editor;
  beforeEach(async () => {
    await lumine.packages.deactivatePackage("linter");
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    lumine.config.set("linter.longLineLength", 500);
    editor = await lumine.workspace.open();
    ui = new (require("../lib/linter-ui"))();
  });
  afterEach(() => {
    ui.dispose();
    editor.destroy();
    lumine.config.unset("linter.longLineLength");
  });
  function publish() {
    const message = {
      severity: "warning",
      excerpt: "Controlled",
      location: {
        buffer: editor.getBuffer(),
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };
    require("../lib/helpers").normalizeMessages("controlled", [message], {
      markerInvalidation: "never",
    });
    ui.render({ added: [message], removed: [], messages: [message] });
  }
  for (const grow of [true, false]) {
    it(`${grow ? "removes" : "restores"} real inline markers after same-row ${grow ? "growth" : "shrinkage"}`, () => {
      editor.setText("x".repeat(grow ? 10 : 600));
      publish();
      const state = editor.getBuffer().linterUI;
      expect(state.markerMap.size).toBe(grow ? 1 : 0);
      editor.setText("x".repeat(grow ? 600 : 10));
      ui.updateMarkers();
      expect(editor.getBuffer().getLineCount()).toBe(1);
      expect(state.markerMap.size).toBe(grow ? 0 : 1);
    });
  }
});

describe("EditorLinter copied configuration callback", () => {
  let editor, linter, earlier;
  beforeEach(async () => {
    await lumine.packages.deactivatePackage("linter");
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    editor = await lumine.workspace.open();
    earlier = lumine.config.onDidChange("linter.lintOnChangeInterval", () => linter?.dispose());
    linter = new (require("../lib/editor-linter"))(editor);
  });
  afterEach(() => {
    earlier.dispose();
    linter.currentBufferChangeSubscription?.dispose();
    linter.currentDebouncedChangeHandler?.cancel();
    linter.dispose();
    editor.destroy();
    lumine.config.unset("linter.lintOnChangeInterval");
  });
  it("does not subscribe a live buffer from a copied callback after retirement", () => {
    const subscribe = spyOn(editor.getBuffer(), "onDidChange").and.callThrough();
    lumine.config.set("linter.lintOnChangeInterval", 401);
    expect(linter.disposed).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
    expect(linter.currentBufferChangeSubscription).toBeNull();
  });
});
