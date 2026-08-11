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

  it("still skips a path the ignore glob matches", async () => {
    const editor = await lumine.workspace.open(__filename);
    spyOn(require("../lib/helpers"), "isPathIgnored").and.returnValue(Promise.resolve(true));

    await registry.lint({ editor });

    expect(linted).toEqual([]);
    editor.destroy();
  });
});
