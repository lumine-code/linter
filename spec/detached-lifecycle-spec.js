const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { Disposable, TextBuffer } = require("lumine");

describe("detached linter request lifecycle", () => {
  let instance;
  let originals;
  let snapshots;
  let provider;
  let temporaryDirectory;
  const fixturePath = path.join(__dirname, "detached-lifecycle.py");

  function originalBuffer(filePath = fixturePath, text = "word\n") {
    const buffer = new TextBuffer({ text });
    buffer.setFile({
      getPath: () => filePath,
      existsSync: () => fs.existsSync(filePath),
      createReadStream: () => Readable.from([text]),
      createWriteStream: () => {
        throw new Error("The caller's virtual source cannot be written");
      },
      onDidChange: () => new Disposable(),
    });
    originals.push(buffer);
    return buffer;
  }

  function message(editor, excerpt = "snapshot result") {
    return {
      severity: "warning",
      excerpt,
      location: {
        buffer: editor.getBuffer(),
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };
  }

  function observeSettlement(pass) {
    const state = { settled: false, value: undefined };
    pass.then((value) => {
      state.settled = true;
      state.value = value;
    });
    return state;
  }

  beforeEach(() => {
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    lumine.config.set("linter.lintOnOpen", false);
    lumine.config.set("linter.lintOnChange", false);
    originals = [];
    snapshots = [];
    temporaryDirectory = null;
    instance = new (require("../lib/linter-main"))();
    provider = {
      name: "detached-lifecycle-spec",
      scope: "file",
      grammarScopes: ["*"],
      lintsOnChange: false,
      lint: (editor) => [message(editor)],
    };
    instance.addLinter(provider);
    const build = lumine.workspace.buildTextEditor.bind(lumine.workspace);
    spyOn(lumine.workspace, "buildTextEditor").and.callFake((options) => {
      const editor = build(options);
      snapshots.push(editor);
      return editor;
    });
  });

  afterEach(async () => {
    instance.dispose();
    for (const editor of snapshots) if (!editor.isDestroyed()) editor.destroy();
    for (const buffer of originals) if (!buffer.isDestroyed()) buffer.destroy();
    await Promise.allSettled(
      [...originals, ...snapshots.map((editor) => editor.getBuffer())].map((buffer) =>
        buffer.getFileWatchStartPromise(),
      ),
    );
    if (temporaryDirectory) {
      const resolved = path.resolve(temporaryDirectory);
      if (
        path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
        !path.basename(resolved).startsWith("linter-detached-lifecycle-")
      ) {
        throw new Error("Refusing to remove a directory outside this spec's temporary root");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  it("selects a named standalone buffer's grammar when its mode is the null sentinel", async () => {
    await lumine.packages.activatePackage("language-python");
    provider.grammarScopes = ["source.python"];
    const seenScopes = [];
    provider.lint = (editor) => {
      seenScopes.push(editor.getGrammar().scopeName);
      return [];
    };
    const original = originalBuffer();
    expect(original.getLanguageMode().grammar.scopeName).toBe("text.plain.null-grammar");
    await instance.lintBuffer(original);
    expect(seenScopes).toEqual(["source.python"]);
    expect(original.getLanguageMode().grammar.scopeName).toBe("text.plain.null-grammar");
    expect(original.refcount).toBe(0);
  });

  it("does not start a second file observation for the snapshot", async () => {
    const original = originalBuffer();
    const client = lumine.workspace.textEditorFactory.fileWatchClient;
    const observeFile = spyOn(client, "watchFile").and.callThrough();
    await instance.lintBuffer(original);
    expect(observeFile).not.toHaveBeenCalled();
    expect(snapshots[0].isDestroyed()).toBe(true);
  });

  it("cannot save the private copy to its original path or another file", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "linter-detached-lifecycle-"));
    const filePath = path.join(temporaryDirectory, "original.py");
    const otherPath = path.join(temporaryDirectory, "other.py");
    fs.writeFileSync(filePath, "disk text\n");
    const original = originalBuffer(filePath, "unsaved snapshot text\n");
    provider.lint = async (editor) => {
      await Promise.allSettled([editor.save(), editor.saveAs(otherPath)]);
      return [];
    };
    await instance.lintBuffer(original);
    expect(fs.readFileSync(filePath, "utf8")).toBe("disk text\n");
    expect(fs.existsSync(otherPath)).toBe(false);
    expect(original.getText()).toBe("unsaved snapshot text\n");
    expect(original.refcount).toBe(0);
  });

  for (const teardown of ["package disposal", "original destruction", "snapshot destruction"]) {
    it(`settles a grammar wait after ${teardown} without requiring the grammar to finish`, async () => {
      const original = originalBuffer();
      let releaseReady;
      const ready = new Promise((resolve) => {
        releaseReady = resolve;
      });
      const build = lumine.workspace.buildTextEditor.and.originalFn.bind(lumine.workspace);
      lumine.workspace.buildTextEditor.and.callFake((options) => {
        const editor = build(options);
        snapshots.push(editor);
        const snapshotBuffer = editor.getBuffer();
        const setMode = snapshotBuffer.setLanguageMode.bind(snapshotBuffer);
        spyOn(snapshotBuffer, "setLanguageMode").and.callFake((languageMode) => {
          setMode(languageMode);
          const mode = snapshotBuffer.getLanguageMode();
          Object.defineProperty(mode, "ready", { value: ready, configurable: true });
          Object.defineProperty(mode, "atGrammarSettlement", {
            value: undefined,
            configurable: true,
          });
        });
        return editor;
      });
      const pass = instance.lintBuffer(original);
      const settled = observeSettlement(pass);
      expect(snapshots.length).toBe(1);
      try {
        if (teardown === "package disposal") instance.dispose();
        if (teardown === "original destruction") original.destroy();
        if (teardown === "snapshot destruction") snapshots[0].destroy();
        await flushMicrotasks();
        expect(settled.settled).toBe(true);
        expect(snapshots[0].isDestroyed()).toBe(true);
      } finally {
        releaseReady();
        await pass;
      }
    });
  }

  for (const teardown of ["package disposal", "provider removal", "original destruction"]) {
    it(`retires a hanging project provider after ${teardown}`, async () => {
      provider.scope = "project";
      const original = originalBuffer();
      let releaseProvider;
      let providerOptions;
      const finished = [];
      instance.registryLinters.onDidFinishLinting((event) => finished.push(event));
      provider.lint = (_editor, options) => {
        providerOptions = options;
        return new Promise((resolve) => {
          releaseProvider = resolve;
        });
      };
      const pass = instance.lintBuffer(original);
      const settled = observeSettlement(pass);
      await conditionPromise(() => releaseProvider);
      try {
        if (teardown === "package disposal") instance.dispose();
        if (teardown === "provider removal") instance.deleteLinter(provider);
        if (teardown === "original destruction") original.destroy();
        await flushMicrotasks();
        expect(settled.settled).toBe(true);
        expect(snapshots[0].isDestroyed()).toBe(true);
        expect(providerOptions?.signal?.aborted).toBe(true);
        if (teardown === "provider removal") expect(finished.length).toBe(1);
      } finally {
        releaseProvider([]);
        await pass;
      }
    });
  }

  it("keeps named project results useful after closing the input and reopening its path", async () => {
    const Main = require("../lib/main");
    const registrations = [];
    let hub;
    Main.activate();
    try {
      registrations.push(
        Main.consumeLinterUI({
          name: "detached-project-lifecycle",
          attach: (value) => (hub = value),
        }),
        Main.consumeLinter({ ...provider, scope: "project", lint: (editor) => [message(editor)] }),
      );
      const original = originalBuffer();
      await Main.provideLinterLint().lintBuffer(original);
      expect(hub.getMessages().length).toBe(1);
      expect(hub.getMessages()[0].location.file).toBe(fixturePath);
      expect(hub.getMessages()[0].location.buffer).toBeUndefined();
      original.destroy();
      expect(hub.getMessages().length).toBe(1);
      const reopened = lumine.workspace.buildTextEditor({ buffer: originalBuffer() });
      registrations.push(Main.provideLinterEditors()(reopened, { lint: false }));
      await flushMicrotasks();
      expect(hub.getMessagesAtPosition(reopened, [0, 0]).map((entry) => entry.excerpt)).toEqual([
        "snapshot result",
      ]);
    } finally {
      for (const registration of registrations.reverse()) registration.dispose();
      Main.deactivate();
    }
  });

  it("drops anonymous project locations on close while keeping durable file results", async () => {
    const Main = require("../lib/main");
    const registrations = [];
    let hub;
    const original = new TextBuffer({ text: "word\n" });
    originals.push(original);
    const editor = lumine.workspace.buildTextEditor({ buffer: original });
    Main.activate();
    try {
      registrations.push(
        Main.consumeLinterUI({
          name: "anonymous-project-lifecycle",
          attach: (value) => (hub = value),
        }),
        Main.consumeLinter({
          ...provider,
          scope: "project",
          lint: (target) => [
            message(target, "anonymous input"),
            {
              severity: "warning",
              excerpt: "durable result",
              location: {
                file: fixturePath,
                position: [
                  [0, 0],
                  [0, 1],
                ],
              },
            },
          ],
        }),
        Main.provideLinterEditors()(editor),
      );
      await Main.provideLinterLint().lintEditor(editor);
      expect(hub.getMessages().length).toBe(2);
      editor.destroy();
      expect(hub.getMessages().map((entry) => entry.excerpt)).toEqual(["durable result"]);
    } finally {
      for (const registration of registrations.reverse()) registration.dispose();
      Main.deactivate();
    }
  });
});

describe("private lint snapshot construction", () => {
  let editors;
  const filePath = path.join(__dirname, "private-snapshot.py");
  const createSnapshot = (options = {}) => {
    const editor = require("../lib/lint-snapshot").createLintSnapshot({
      text: "value = 1\n",
      filePath,
      ...options,
    });
    editors.push(editor);
    return editor;
  };

  beforeEach(async () => {
    editors = [];
    await lumine.packages.activatePackage("language-python");
  });

  afterEach(async () => {
    for (const editor of editors) if (!editor.isDestroyed()) editor.destroy();
    await Promise.allSettled(
      editors.map((editor) => editor.getBuffer().getFileWatchStartPromise()),
    );
  });

  it("selects Python from the path without starting file observation", async () => {
    const client = lumine.workspace.textEditorFactory.fileWatchClient;
    const observeFile = spyOn(client, "watchFile").and.callThrough();
    const original = new TextBuffer({ text: "value = 1\n" });
    try {
      const snapshot = createSnapshot({ grammar: original.getLanguageMode().grammar });
      expect(await snapshot.whenGrammarSettled()).toBe(true);
      expect(snapshot.getGrammar().scopeName).toBe("source.python");
      expect(snapshot.getPath()).toBe(filePath);
      expect(snapshot.getText()).toBe("value = 1\n");
      expect(observeFile).not.toHaveBeenCalled();
      expect(original.refcount).toBe(0);
      expect(original.getLanguageMode().grammar.scopeName).toBe("text.plain.null-grammar");
    } finally {
      original.destroy();
    }
  });

  it("preserves a valid caller grammar rather than choosing one from the extension", async () => {
    const grammar = lumine.grammars.grammarForScopeName("source.python");
    const snapshot = createSnapshot({ filePath: "private.txt", grammar, encoding: "utf16le" });
    expect(await snapshot.whenGrammarSettled()).toBe(true);
    expect(snapshot.getGrammar()).toBe(grammar);
    expect(snapshot.getBuffer().getEncoding()).toBe("utf16le");
  });

  it("rejects persistence and reload APIs while allowing cursor marker and text work", async () => {
    const snapshot = createSnapshot();
    expect(await snapshot.whenGrammarSettled()).toBe(true);
    const buffer = snapshot.getBuffer();
    snapshot.setCursorBufferPosition([0, 3]);
    const marker = buffer.markRange([
      [0, 0],
      [0, 5],
    ]);
    snapshot.setText("value = 2\n");
    expect(snapshot.getText()).toBe("value = 2\n");
    expect(marker.isDestroyed()).toBe(false);
    for (const operation of [
      () => snapshot.save(),
      () => snapshot.saveAs(`${filePath}.other`),
      () => buffer.saveTo({ getPath: () => filePath }),
      () => buffer.reload(),
      () => buffer.load(),
    ]) {
      await expectAsync(operation()).toBeRejectedWith(
        jasmine.objectContaining({ code: "LINTER_SNAPSHOT_READ_ONLY" }),
      );
    }
    expect(() => buffer.loadSync()).toThrowError("Cannot reload a private lint snapshot");
    marker.destroy();
  });

  it("cannot acquire a backing store or watcher by being retargeted", async () => {
    const snapshot = createSnapshot();
    expect(await snapshot.whenGrammarSettled()).toBe(true);
    const buffer = snapshot.getBuffer();
    const client = lumine.workspace.textEditorFactory.fileWatchClient;
    const observeFile = spyOn(client, "watchFile").and.callThrough();
    expect(() => buffer.setPath(`${filePath}.other`)).toThrowError(
      "Cannot retarget a private lint snapshot",
    );
    expect(() => buffer.setFile({ getPath: () => `${filePath}.other` })).toThrowError(
      "Cannot replace the source of a private lint snapshot",
    );
    expect(() => buffer.setPath(filePath)).not.toThrow();
    expect(snapshot.getPath()).toBe(filePath);
    expect(observeFile).not.toHaveBeenCalled();
  });

  it("destroys its editor and private buffer if grammar assignment fails", () => {
    let built;
    const build = lumine.workspace.buildTextEditor.bind(lumine.workspace);
    spyOn(lumine.workspace, "buildTextEditor").and.callFake((options) => {
      built = build(options);
      return built;
    });
    spyOn(lumine.grammars, "assignGrammar").and.throwError("assignment failed");
    expect(() => createSnapshot()).toThrowError("assignment failed");
    expect(built.isDestroyed()).toBe(true);
    expect(built.getBuffer().isDestroyed()).toBe(true);
    expect(lumine.workspace.getTextEditors()).not.toContain(built);
  });

  it("maps named project locations to the original path without mutating provider objects", () => {
    const snapshot = createSnapshot();
    const original = createSnapshot({ filePath: `${filePath}.original` });
    const input = {
      severity: "warning",
      excerpt: "project result",
      location: {
        buffer: snapshot.getBuffer(),
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };
    const [mapped] = require("../lib/lint-snapshot").mapProjectLocations([input], {
      snapshotBuffer: snapshot.getBuffer(),
      originalBuffer: original.getBuffer(),
    });
    expect(mapped.location.file).toBe(`${filePath}.original`);
    expect(mapped.location.buffer).toBeUndefined();
    expect(input.location.buffer).toBe(snapshot.getBuffer());
    expect(input.location.file).toBeUndefined();
  });

  it("keeps an explicit provider path authoritative for project locations", () => {
    const snapshot = createSnapshot();
    const input = {
      severity: "warning",
      excerpt: "project result",
      location: {
        buffer: snapshot.getBuffer(),
        file: `${filePath}.explicit`,
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };
    const [mapped] = require("../lib/lint-snapshot").mapProjectLocations([input]);
    expect(mapped.location.file).toBe(`${filePath}.explicit`);
    expect(mapped.location.buffer).toBeUndefined();
    expect(input.location.buffer).toBe(snapshot.getBuffer());
  });

  it("retains live anonymous locations and drops them once their buffer is destroyed", () => {
    const buffer = new TextBuffer({ text: "word\n" });
    const input = {
      severity: "warning",
      excerpt: "anonymous result",
      location: {
        buffer,
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };
    const { mapProjectLocations } = require("../lib/lint-snapshot");
    expect(mapProjectLocations([input])).toEqual([input]);
    buffer.destroy();
    expect(mapProjectLocations([input])).toEqual([]);
  });
});
