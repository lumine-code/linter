let Main;
let EditorRegistry;

// Only pane items are linted on their own. A package builds editors of its own
// to render a diff, a patch preview or a dock's input field with, and none of
// those is a document; one that is — a commit box, a notebook's source editor —
// is registered by its owner through the `linter.editors` service. These specs
// pin both halves of that contract.
describe("lib/editor-registry discovery", () => {
  beforeEach(() => {
    EditorRegistry = require("../lib/editor-registry");
  });

  it("observes pane items, not the editors packages register with lumine.textEditors", async () => {
    lumine.config.set("linter.lintOnOpen", false);
    const registry = new EditorRegistry();
    registry.activate();
    const embedded = lumine.workspace.buildTextEditor();
    const registration = lumine.textEditors.add(embedded, { role: "viewer" });
    const paneEditor = await lumine.workspace.open();

    expect(registry.get(embedded)).toBeUndefined();
    expect(registry.get(paneEditor)).toBeDefined();

    registration.dispose();
    embedded.destroy();
    paneEditor.destroy();
    registry.dispose();
  });

  it("restores an owned embedded editor after disabling and enabling its buffer", () => {
    lumine.config.set("linter.lintOnOpen", false);
    const registry = new EditorRegistry();
    const embedded = lumine.workspace.buildTextEditor();
    try {
      registry.createFromTextEditor(embedded);
      registry.disableTextEditorBuffer(embedded);
      expect(registry.get(embedded)).toBeUndefined();
      registry.enableTextEditorBuffer(embedded);
      expect(registry.get(embedded)).toBeDefined();
    } finally {
      embedded.destroy();
      registry.dispose();
    }
  });

  it("keeps each explicit lease through pause and releases only its own resumed context", () => {
    lumine.config.set("linter.lintOnOpen", false);
    const registry = new EditorRegistry();
    const embedded = lumine.workspace.buildTextEditor();
    const first = registry.registerEditor(embedded);
    const second = registry.registerEditor(embedded);
    try {
      const beforePause = registry.get(embedded);
      registry.disableTextEditorBuffer(embedded);
      expect(registry.get(embedded)).toBeUndefined();
      first.dispose();
      registry.enableTextEditorBuffer(embedded);
      expect(registry.get(embedded)).toBeDefined();
      expect(registry.get(embedded)).not.toBe(beforePause);
      second.dispose();
      expect(registry.get(embedded)).toBeUndefined();
    } finally {
      first.dispose();
      second.dispose();
      embedded.destroy();
      registry.dispose();
    }
  });

  it("remembers an explicit lease acquired while its buffer is paused", () => {
    lumine.config.set("linter.lintOnOpen", false);
    const registry = new EditorRegistry();
    const embedded = lumine.workspace.buildTextEditor();
    registry.disableTextEditorBuffer(embedded);
    const registration = registry.registerEditor(embedded);
    try {
      expect(registry.get(embedded)).toBeUndefined();
      registry.enableTextEditorBuffer(embedded);
      expect(registry.get(embedded)).toBeDefined();
      registration.dispose();
      expect(registry.get(embedded)).toBeUndefined();
    } finally {
      registration.dispose();
      embedded.destroy();
      registry.dispose();
    }
  });

  it("retires shared ownership once when the editor itself is destroyed", () => {
    lumine.config.set("linter.lintOnOpen", false);
    const registry = new EditorRegistry();
    const embedded = lumine.workspace.buildTextEditor();
    const destroyed = [];
    registry.observe((linter) => linter.onDidDestroy(() => destroyed.push(linter)));
    const first = registry.registerEditor(embedded);
    const second = registry.registerEditor(embedded);
    registry.createFromTextEditor(embedded);
    embedded.destroy();
    expect(registry.get(embedded)).toBeUndefined();
    expect(destroyed.length).toBe(1);
    expect(() => first.dispose()).not.toThrow();
    expect(() => second.dispose()).not.toThrow();
    expect(() => registry.dispose()).not.toThrow();
    expect(destroyed.length).toBe(1);
  });

  it("keeps retired service edges inert after the registry is disposed", () => {
    lumine.config.set("linter.lintOnOpen", false);
    const registry = new EditorRegistry();
    const embedded = lumine.workspace.buildTextEditor();
    const registration = registry.registerEditor(embedded);
    registry.dispose();
    expect(registry.get(embedded)).toBeUndefined();
    expect(() => registration.dispose()).not.toThrow();
    expect(() => registry.registerEditor(embedded).dispose()).not.toThrow();
    expect(registry.get(embedded)).toBeUndefined();
    embedded.destroy();
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
    Main = require("../lib/main");
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

  it("keeps a detached editor registered while a second service edge still owns it", async () => {
    let hub;
    const ui = Main.consumeLinterUI({ name: "lease-spec-ui", attach: (value) => (hub = value) });
    const consumed = Main.consumeLinter(provider);
    const register = Main.provideLinterEditors();
    editor = lumine.workspace.buildTextEditor();
    editor.setText("word\n");
    const first = register(editor);
    const second = register(editor);
    try {
      await Main.provideLinterLint().lintEditor(editor);
      expect(hub.getMessages().map((entry) => entry.excerpt)).toEqual(["registered"]);
      first.dispose();
      expect(hub.getMessages().map((entry) => entry.excerpt)).toEqual(["registered"]);
      second.dispose();
      expect(hub.getMessages()).toEqual([]);
    } finally {
      first.dispose();
      second.dispose();
      consumed.dispose();
      ui.dispose();
    }
  });

  it("keeps a pane editor's automatic registration after its explicit edge is disposed", async () => {
    await lumine.packages.activatePackage("language-javascript");
    let hub;
    const ui = Main.consumeLinterUI({
      name: "pane-lease-spec-ui",
      attach: (value) => (hub = value),
    });
    const consumed = Main.consumeLinter(provider);
    editor = await lumine.workspace.open();
    editor.setText("word\n");
    await Main.provideLinterLint().lintEditor(editor);
    const explicit = Main.provideLinterEditors()(editor);
    try {
      explicit.dispose();
      expect(hub.getMessages().map((entry) => entry.excerpt)).toEqual(["registered"]);
      const before = lintedEditors.length;
      editor.setGrammar(lumine.grammars.grammarForScopeName("source.js"));
      await editor.whenGrammarSettled();
      await flushMicrotasks();
      expect(lintedEditors.length).toBeGreaterThan(before);
    } finally {
      explicit.dispose();
      consumed.dispose();
      ui.dispose();
    }
  });

  it("retires a pending run when the last detached registration is released", async () => {
    let hub;
    let release;
    let signal;
    const ui = Main.consumeLinterUI({
      name: "pending-lease-spec-ui",
      attach: (value) => (hub = value),
    });
    const consumed = Main.consumeLinter({
      ...provider,
      lint: (target, options) => {
        signal = options.signal;
        return new Promise((resolve) => {
          release = () =>
            resolve([
              {
                severity: "hint",
                excerpt: "retired registration",
                location: {
                  buffer: target.getBuffer(),
                  position: [
                    [0, 0],
                    [0, 1],
                  ],
                },
              },
            ]);
        });
      },
    });
    editor = lumine.workspace.buildTextEditor();
    editor.setText("word\n");
    const registration = Main.provideLinterEditors()(editor);
    const pass = Main.provideLinterLint().lintEditor(editor);
    let settled = false;
    pass.then(() => (settled = true));
    await conditionPromise(() => release);
    try {
      registration.dispose();
      await flushMicrotasks();
      expect(settled).toBe(true);
      expect(signal.aborted).toBe(true);
      expect(editor.isDestroyed()).toBe(false);
      release();
      await pass;
      expect(hub.getMessages()).toEqual([]);
    } finally {
      release();
      await pass;
      registration.dispose();
      consumed.dispose();
      ui.dispose();
    }
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
