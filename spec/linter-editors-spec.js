const Main = require("../lib/main");
const EditorRegistry = require("../lib/editor-registry");

// Only pane items are linted on their own. A package builds editors of its own
// to render a diff, a patch preview or a dock's input field with, and none of
// those is a document; one that is — a commit box, a notebook's source editor —
// is registered by its owner through the `linter.editors` service. These specs
// pin both halves of that contract.
describe("lib/editor-registry discovery", () => {
  it("observes pane items, not the editors packages register with lumine.textEditors", async () => {
    lumine.config.set("linter.lintOnOpen", false);
    const registry = new EditorRegistry();
    registry.activate();
    const embedded = lumine.workspace.buildTextEditor();
    const registration = lumine.textEditors.add(embedded);
    const paneEditor = await lumine.workspace.open();

    expect(registry.get(embedded)).toBeUndefined();
    expect(registry.get(paneEditor)).toBeDefined();

    registration.dispose();
    embedded.destroy();
    paneEditor.destroy();
    registry.dispose();
  });
});

describe("the linter.editors service", () => {
  let lintedEditors;
  let renders;
  let editor;

  const provider = {
    name: "spec-provider",
    scope: "file",
    lintsOnChange: false,
    grammarScopes: ["*"],
    lint(target) {
      lintedEditors.push(target);
      return [
        {
          severity: "hint",
          excerpt: "registered",
          location: {
            buffer: target.getBuffer(),
            position: [
              [0, 0],
              [0, 1],
            ],
          },
        },
      ];
    },
  };

  beforeEach(() => {
    // The service is exercised through the real package entry, so register the
    // schema the way package load would: the registries read its defaults.
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    lumine.config.set("linter.lintOnOpen", true);
    lintedEditors = [];
    renders = [];
    Main.activate();
  });

  afterEach(() => {
    if (editor && !editor.isDestroyed()) {
      editor.destroy();
    }
    editor = null;
    Main.deactivate();
  });

  it("lints a registered editor and retracts its messages when the registration goes", async () => {
    Main.consumeLinterUI({
      name: "spec-ui",
      render: (difference) => renders.push(difference),
      didBeginLinting() {},
      didFinishLinting() {},
      dispose() {},
    });
    const consumed = Main.consumeLinter(provider);
    const register = Main.provideLinterEditors();
    editor = lumine.workspace.buildTextEditor();
    editor.setText("word\n");
    const buffer = editor.getBuffer();

    const registration = register(editor);
    await conditionPromise(() => lintedEditors.includes(editor));
    await conditionPromise(() =>
      renders.some((difference) => difference.added.some((m) => m.location.buffer === buffer)),
    );

    registration.dispose();
    expect(
      renders.some((difference) => difference.removed.some((m) => m.location.buffer === buffer)),
    ).toBe(true);

    // A second dispose is allowed — the editor's own destruction and the
    // registration's teardown can both reach the same EditorLinter.
    registration.dispose();
    consumed.dispose();
  });

  it("hands back an inert disposable for an editor that is already gone", () => {
    const register = Main.provideLinterEditors();
    const gone = lumine.workspace.buildTextEditor();
    gone.destroy();

    const registration = register(gone);

    expect(() => registration.dispose()).not.toThrow();
    expect(lintedEditors).toEqual([]);
  });
});
