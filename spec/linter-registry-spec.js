const LinterRegistry = require("../lib/linter-registry");

describe("lib/linter-registry", () => {
  let registry;
  let linter;
  let linted;

  beforeEach(() => {
    // The registry reads these when it is constructed, and the schema that
    // supplies their defaults is only registered once the package activates.
    lumine.config.set("linter.lintOnChange", true);
    lumine.config.set("linter.lintPreviewTabs", true);
    lumine.config.set("linter.ignoreGlob", "**/*.min.{js,css}");
    lumine.config.set("linter.disabledProviders", []);

    linted = [];
    registry = new LinterRegistry();
    linter = {
      name: "spec",
      scope: "file",
      lintsOnChange: true,
      grammarScopes: ["*"],
      lint(editor) {
        linted.push(editor);
        return [];
      },
    };
    registry.addLinter(linter);
  });

  afterEach(() => {
    registry.dispose();
  });

  it("lints an editor with a path", async () => {
    const editor = await lumine.workspace.open(__filename);

    await registry.lint({ editor });

    expect(linted).toEqual([editor]);
    editor.destroy();
  });

  // `isPathIgnored` answers `true` for a missing path, which used to make every
  // never-saved buffer look like an ignored one and skip it before any provider
  // ran. Nothing has decided to ignore it — it is simply not a file yet.
  it("lints a buffer that has never been saved", async () => {
    const editor = await lumine.workspace.open();

    await registry.lint({ editor });

    expect(linted).toEqual([editor]);
    editor.destroy();
  });

  // A package builds editors of its own to render a diff, a patch preview or a
  // dock's input field with. `editors: "center"` is how a provider says it only
  // means the documents somebody opened.
  describe('a provider declaring editors: "center"', () => {
    beforeEach(() => {
      linter.editors = "center";
    });

    it("is asked about an editor the centre holds", async () => {
      const editor = await lumine.workspace.open(__filename);

      await registry.lint({ editor, isCenterEditor: () => true });

      expect(linted).toEqual([editor]);
      editor.destroy();
    });

    it("is not asked about one the centre does not", async () => {
      const editor = await lumine.workspace.open(__filename);

      await registry.lint({ editor, isCenterEditor: () => false });

      expect(linted).toEqual([]);
      editor.destroy();
    });

    it("asks the question once however many providers narrowed themselves", async () => {
      const second = { ...linter, name: "second", lint: () => [] };
      registry.addLinter(second);
      const editor = await lumine.workspace.open(__filename);
      const asked = jasmine.createSpy("isCenterEditor").and.returnValue(false);

      await registry.lint({ editor, isCenterEditor: asked });

      expect(asked.calls.count()).toBe(1);
      editor.destroy();
    });

    it("is asked when nothing supplied an answer, as a caller from before this could not", async () => {
      const editor = await lumine.workspace.open(__filename);

      await registry.lint({ editor });

      expect(linted).toEqual([editor]);
      editor.destroy();
    });
  });

  it('leaves a provider declaring editors: "any" alone', async () => {
    linter.editors = "any";
    const editor = await lumine.workspace.open(__filename);

    await registry.lint({ editor, isCenterEditor: () => false });

    expect(linted).toEqual([editor]);
    editor.destroy();
  });

  it("leaves a provider that declared nothing alone", async () => {
    const editor = await lumine.workspace.open(__filename);

    await registry.lint({ editor, isCenterEditor: () => false });

    expect(linted).toEqual([editor]);
    editor.destroy();
  });

  it("still skips a path the ignore glob matches", async () => {
    const editor = await lumine.workspace.open(__filename);
    spyOn(require("../lib/helpers"), "isPathIgnored").and.returnValue(Promise.resolve(true));

    await registry.lint({ editor });

    expect(linted).toEqual([]);
    editor.destroy();
  });
});
