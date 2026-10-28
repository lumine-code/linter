const { CompositeDisposable } = require("lumine");

describe("clearing diagnostic decorations", () => {
  let editor;
  let element;
  let delegate;
  let split;
  let overview;
  let panelMessages;
  let previousSyntaxExecution;
  let main;

  beforeEach(async () => {
    jasmine.useRealClock();
    main = require("../lib/main");
    previousSyntaxExecution = lumine.grammars.syntaxExecution;
    lumine.grammars.syntaxExecution = "worker";
    const grammarPackage = await lumine.packages.activatePackage("language-python");
    await grammarPackage.resourceLoadPromise;
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    lumine.config.set("linter.lintOnOpen", false);
    lumine.config.set("linter.lintOnChange", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
    main.activate();
    editor = await lumine.workspace.open("clear-diagnostics.py");
    editor.setText("def work():\n    value = 1\n    return value\n");
    await editor.whenGrammarSettled();
    editor.update({ autoIndent: true, tabLength: 4, softTabs: true });
    element = editor.getElement();
    element.style.height = "600px";
    element.style.width = "800px";
    split = editor.copy();
    main.provideLinterEditors()(split, { lint: false });
    const splitElement = split.getElement();
    splitElement.style.height = "600px";
    splitElement.style.width = "800px";
    jasmine.attachToDOM(splitElement);
    panelMessages = [];
    main.consumeLinterUI({
      name: "clear-regression-panel",
      render: ({ messages }) => {
        panelMessages = messages;
      },
    });
    const props = main.provideMarkerLayer();
    overview = {
      editor,
      props,
      cache: new Map(),
      disposables: new CompositeDisposable(),
      update() {},
    };
    props.initialize(overview);
    delegate = main.provideLinterRegistry()({
      name: "clear-regression",
      markerInvalidation: "never",
    });
    delegate.setMessages(editor.getPath(), [
      {
        severity: "error",
        tags: ["unnecessary", "deprecated"],
        excerpt: "Retained diagnostic",
        location: {
          file: editor.getPath(),
          position: [
            [2, 4],
            [2, 10],
          ],
        },
      },
    ]);
  });

  afterEach(() => {
    overview?.disposables.dispose();
    main.deactivate();
    split?.destroy();
    editor?.destroy();
    lumine.grammars.syntaxExecution = previousSyntaxExecution;
  });

  const painted = (target = editor) => {
    const view = target.getElement();
    view.getComponent().updateSync();
    return view.querySelectorAll(
      ".linter-text, .linter-line-number, .linter-tag-unnecessary, .linter-tag-deprecated",
    ).length;
  };

  const expectCleared = () => {
    expect(main.provideLinterHub().getMessages()).toEqual([]);
    expect(panelMessages).toEqual([]);
    const state = editor.getBuffer().linterUI;
    expect(state.markerMap.size).toBe(0);
    for (const layer of [
      ...Object.values(state.severityLayers),
      ...Object.values(state.tagLayers),
    ]) {
      expect(layer.getMarkerCount()).toBe(0);
    }
    expect(painted()).toBe(0);
    expect(painted(split)).toBe(0);
    // null means the already-empty overview is unchanged.
    expect(overview.props.getItems(overview) ?? []).toEqual([]);
  };

  for (const action of ["none", "newline", "undo-redo", "apply-edits", "replace-all"]) {
    it(`removes severity and tag markers after ${action}`, async () => {
      expect(painted()).toBeGreaterThan(0);
      expect(painted(split)).toBeGreaterThan(0);
      expect(overview.props.getItems(overview).length).toBeGreaterThan(0);
      if (action !== "none") {
        editor.setCursorBufferPosition([1, Infinity]);
        if (action === "apply-edits") {
          await editor.getBuffer().applyTextEdits([
            {
              range: editor.getSelectedBufferRange(),
              text: "\n    ",
            },
          ]);
        } else if (action === "replace-all") {
          await editor.getBuffer().replaceAllMatches(/value/g, "result");
        } else {
          const insertion = editor.insertNewline();
          expect(typeof insertion.then).toBe("function");
          await insertion;
        }
        if (action === "undo-redo") {
          editor.undo();
          editor.redo();
        }
        expect(painted()).toBeGreaterThan(0);
      }
      lumine.commands.dispatch(lumine.workspace.getElement(), "linter:clear");
      expectCleared();
      if (action !== "none") {
        editor.undo();
        expectCleared();
        editor.redo();
        expectCleared();
        lumine.commands.dispatch(lumine.workspace.getElement(), "linter:clear");
        expectCleared();
      }
    });
  }

  it("does not revive withdrawn diagnostics before a later clear command", async () => {
    expect(painted()).toBeGreaterThan(0);
    editor.setCursorBufferPosition([1, Infinity]);
    await editor.insertNewline();
    delegate.clearMessages();
    expectCleared();
    editor.undo();
    lumine.commands.dispatch(lumine.workspace.getElement(), "linter:clear");
    expectCleared();
  });

  for (const clear of ["command", "hub"])
    it(`repairs already orphaned decorations through the ${clear} when the registry is empty`, () => {
      const buffer = editor.getBuffer();
      const state = buffer.linterUI;
      const unrelated = buffer.addMarkerLayer().markRange([
        [0, 0],
        [0, 1],
      ]);
      const snapshots = [
        ...Object.values(state.severityLayers),
        ...Object.values(state.tagLayers),
      ].map((layer) => [layer, layer.createEagerSnapshot()]);
      main.provideLinterHub().clearMessages();
      expectCleared();
      // Reproduce annotations restored by an older core after their provider
      // forgot them. Clear must recover this state as well as prevent new ones.
      buffer.transact(() => {
        for (const [layer, snapshot] of snapshots) {
          layer.restoreFromSnapshot(snapshot, false);
          buffer.markerLayersWithPendingUpdateEvents.add(layer);
        }
      });
      expect(main.provideLinterHub().getMessages()).toEqual([]);
      expect(state.markerMap.size).toBe(0);
      expect(painted()).toBeGreaterThan(0);
      if (clear === "command")
        lumine.commands.dispatch(lumine.workspace.getElement(), "linter:clear");
      else main.provideLinterHub().clearMessages();
      expectCleared();
      expect(unrelated.isDestroyed()).toBe(false);
      expect(unrelated.getRange()).toEqual([
        [0, 0],
        [0, 1],
      ]);
    });

  it("keeps cleared diagnostics gone when an already accepted Enter finishes preparing", async () => {
    const client = lumine.grammars.syntaxWorkerService.client;
    const request = client.request.bind(client);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const preparing = new Promise((resolve) => {
      started = resolve;
    });
    spyOn(client, "request").and.callFake(async (operation, ...args) => {
      const result = request(operation, ...args);
      if (operation === "prepared-indent") {
        started();
        await gate;
      }
      return result;
    });
    editor.setCursorBufferPosition([1, Infinity]);
    const before = editor.getText();
    const insertion = editor.insertNewline();
    try {
      await preparing;
      lumine.commands.dispatch(lumine.workspace.getElement(), "linter:clear");
      expectCleared();
      expect(editor.getText()).toBe(before);
    } finally {
      release();
    }
    await insertion;
    expect(editor.getText()).toBe("def work():\n    value = 1\n    \n    return value\n");
    expectCleared();
    editor.undo();
    expectCleared();
    editor.redo();
    expectCleared();
  });
});
