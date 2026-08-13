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

  // `lint: false` registers an editor for rendering only: the buffer is
  // patched so projected messages have marker layers to land on, but no
  // provider ever runs on the editor itself. This is the mode for a notebook
  // cell, whose diagnostics arrive against the notebook and reach the cell
  // through a linter.adapter projection.
  it("patches but never lints an editor registered with lint: false", async () => {
    const consumed = Main.consumeLinter(provider);
    const register = Main.provideLinterEditors();
    editor = lumine.workspace.buildTextEditor();
    editor.setText("word\n");
    const renderOnly = lumine.workspace.buildTextEditor();
    renderOnly.setText("word\n");

    const renderRegistration = register(renderOnly, { lint: false });
    expect(renderOnly.getBuffer().linterUI).toBeDefined();

    // A linted sibling is the clock: once the pipeline has run for it, the
    // render-only editor has had every opportunity it will ever get.
    const lintedRegistration = register(editor);
    await conditionPromise(() => lintedEditors.includes(editor));
    expect(lintedEditors.includes(renderOnly)).toBe(false);

    expect(() => renderRegistration.dispose()).not.toThrow();
    lintedRegistration.dispose();
    renderOnly.destroy();
    consumed.dispose();
  });

  it("renders a marker placed on a render-only editor's severity layer", () => {
    const register = Main.provideLinterEditors();
    editor = lumine.workspace.buildTextEditor();
    editor.setText("word\n");
    const buffer = editor.getBuffer();

    register(editor, { lint: false });

    // A projection targeting this buffer lands on the severity layers; the
    // render path must pick the marker up through the layer decoration.
    buffer.linterUI.severityLayers.error.markRange([
      [0, 0],
      [0, 4],
    ]);
    const byMarker = editor.decorationManager.decorationPropertiesByMarkerForScreenRowRange(0, 1);
    const classes = [...byMarker.values()].flat().map((properties) => properties.class);
    expect(classes.some((value) => value?.includes("linter-text error"))).toBe(true);
  });
});
