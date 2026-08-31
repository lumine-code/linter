const LinterRegistry = require("../lib/linter-registry");

describe("lib/linter-registry", () => {
  let registry;
  let linter;
  let linted;

  const messageFor = (editor, excerpt) => ({
    severity: "warning",
    excerpt,
    location: {
      buffer: editor.getBuffer(),
      position: [
        [0, 0],
        [0, 0],
      ],
    },
  });

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

  it("lints a buffer that has never been saved", async () => {
    const editor = await lumine.workspace.open();

    await registry.lint({ editor });

    expect(linted).toEqual([editor]);
    editor.destroy();
  });

  it("still skips a path the ignore glob matches", async () => {
    const editor = await lumine.workspace.open(__filename);
    spyOn(require("../lib/helpers"), "matchesIgnoreGlob").and.returnValue(true);

    await registry.lint({ editor });

    expect(linted).toEqual([]);
    editor.destroy();
  });

  it("does not consult repository ignore rules for an opened path", async () => {
    const editor = await lumine.workspace.open(__filename);
    const repositoryForPath = spyOn(lumine.project, "repositoryForPath").and.returnValue(
      Promise.resolve({ isPathIgnored: () => true }),
    );

    await registry.lint({ editor });

    expect(linted).toEqual([editor]);
    expect(repositoryForPath).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("keeps concurrent file results for different buffers", async () => {
    const first = await lumine.workspace.open();
    const second = await lumine.workspace.open();
    let resolveFirst;
    let resolveSecond;
    const received = [];
    registry.onDidUpdateMessages(({ messages }) => received.push(...messages));
    linter.lint = (editor) =>
      new Promise((resolve) => {
        if (editor === first) resolveFirst = resolve;
        if (editor === second) resolveSecond = resolve;
      });

    const firstRun = registry.lint({ editor: first });
    const secondRun = registry.lint({ editor: second });
    await conditionPromise(() => resolveFirst && resolveSecond);
    resolveSecond([messageFor(second, "second")]);
    await secondRun;
    resolveFirst([messageFor(first, "first")]);
    await firstRun;

    expect(received.map((message) => message.excerpt).sort()).toEqual(["first", "second"]);
    first.destroy();
    second.destroy();
  });

  it("drops an older result as soon as a newer run starts for its buffer", async () => {
    const editor = await lumine.workspace.open();
    const resolvers = [];
    const received = [];
    registry.onDidUpdateMessages(({ messages }) => received.push(...messages));
    linter.lint = () => new Promise((resolve) => resolvers.push(resolve));

    const oldRun = registry.lint({ editor });
    const newRun = registry.lint({ editor });
    await conditionPromise(() => resolvers.length === 2);
    resolvers[0]([messageFor(editor, "old")]);
    await oldRun;
    resolvers[1]([messageFor(editor, "new")]);
    await newRun;

    expect(received.map((message) => message.excerpt)).toEqual(["new"]);
    editor.destroy();
  });
});
