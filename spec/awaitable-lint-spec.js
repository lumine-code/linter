const path = require("node:path");
const { TextBuffer } = require("lumine");

describe("awaitable linter passes", () => {
  let instance;
  let targets;
  let provider;
  let originals;
  const filePath = path.join(__dirname, "awaitable.py");
  const message = (editor, excerpt) => ({
    severity: "warning",
    excerpt,
    location: {
      buffer: editor.getBuffer(),
      position: [
        [0, 0],
        [0, 1],
      ],
    },
  });
  const messages = () => instance.registryMessages?.messages || [];
  const buffer = () => {
    const original = new TextBuffer({ text: "word\n", filePath });
    originals.push(original);
    return original;
  };

  beforeEach(() => {
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    lumine.config.set("linter.lintOnOpen", false);
    lumine.config.set("linter.lintOnChange", false);
    targets = [];
    originals = [];
    instance = new (require("../lib/linter-main"))();
    provider = {
      name: "awaitable-spec",
      scope: "file",
      grammarScopes: ["*"],
      lintsOnChange: false,
      lint(editor) {
        targets.push(editor);
        return [message(editor, editor.getText())];
      },
    };
    instance.addLinter(provider);
  });

  afterEach(async () => {
    instance.dispose();
    for (const editor of targets) if (!editor.isDestroyed()) editor.destroy();
    for (const original of originals) if (!original.isDestroyed()) original.destroy();
    // Destroying a buffer can cancel an observation that is still starting.
    await Promise.allSettled(originals.map((original) => original.fileWatchStartPromise));
  });

  it("publishes the finished pass before a following diagnostics read", async () => {
    const editor = await lumine.workspace.open();
    editor.setText("fresh");
    let resolve;
    provider.lint = (target) =>
      new Promise((done) => {
        resolve = () => done([message(target, target.getText())]);
      });
    const pass = instance.lintEditor(editor);
    expect(messages()).toEqual([]);
    resolve();
    expect(await pass).toBeTrue();
    expect(messages().map((entry) => entry.excerpt)).toEqual(["fresh"]);
    editor.destroy();
  });

  it("lints a private snapshot without opening a tab or taking buffer ownership", async () => {
    const original = buffer();
    const items = lumine.workspace.getPaneItems().slice();
    const originalRefcount = original.refcount;
    expect(await instance.lintBuffer(original)).toBeTrue();
    expect(lumine.workspace.getPaneItems()).toEqual(items);
    expect(original.refcount).toBe(originalRefcount);
    expect(original.isDestroyed()).toBeFalse();
    expect(original.getText()).toBe("word\n");
    expect(targets.length).toBe(1);
    expect(targets[0].isDestroyed()).toBeTrue();
    expect(targets[0].getBuffer()).not.toBe(original);
    expect(messages()[0].location.buffer).toBe(original);
    original.destroy();
    expect(messages()).toEqual([]);
  });

  it("uses the existing pane editor when the buffer is open", async () => {
    const editor = await lumine.workspace.open();
    editor.getBuffer().setPath(filePath);
    editor.setText("open");
    expect(await instance.lintBuffer(editor.getBuffer())).toBeTrue();
    expect(targets).toEqual([editor]);
    expect(editor.isDestroyed()).toBeFalse();
    editor.destroy();
  });

  it("discards an older detached request for the same original buffer", async () => {
    const original = buffer();
    const pending = [];
    provider.lint = (editor) => new Promise((resolve) => pending.push({ editor, resolve }));
    const first = instance.lintBuffer(original);
    await conditionPromise(() => pending.length === 1);
    const second = instance.lintBuffer(original);
    await conditionPromise(() => pending.length === 2);
    pending[1].resolve([message(pending[1].editor, "new")]);
    await second;
    pending[0].resolve([message(pending[0].editor, "old")]);
    await first;
    expect(messages().map((entry) => entry.excerpt)).toEqual(["new"]);
    expect(pending.every((entry) => entry.editor.isDestroyed())).toBeTrue();
    original.destroy();
  });

  for (const change of ["edit", "rename", "destroy"]) {
    it(`discards snapshot results after the original buffer's ${change}`, async () => {
      const original = buffer();
      let target, resolve;
      provider.lint = (editor) =>
        new Promise((done) => {
          target = editor;
          resolve = done;
        });
      const pass = instance.lintBuffer(original);
      await conditionPromise(() => resolve);
      if (change === "edit") original.setText("new text");
      if (change === "rename") original.setPath(`${filePath}.renamed`);
      if (change === "destroy") {
        original.destroy();
        expect(target.isDestroyed()).toBeTrue();
        expect(instance.snapshotEditors.size).toBe(0);
      }
      resolve([message(target, "stale")]);
      await pass;
      expect(messages()).toEqual([]);
      expect(target.isDestroyed()).toBeTrue();
      if (!original.isDestroyed()) original.destroy();
    });
  }

  it("skips disabled and ignored buffers and buffers without a path", async () => {
    const editor = await lumine.workspace.open();
    editor.getBuffer().setPath(filePath);
    instance.registryEditorsInit();
    instance.registryEditors.disableTextEditorBuffer(editor);
    expect(await instance.lintBuffer(editor.getBuffer())).toBeFalse();
    const original = buffer();
    lumine.config.set("linter.ignoreGlob", "**/awaitable.py");
    expect(await instance.lintBuffer(original)).toBeFalse();
    original.setPath(null);
    expect(await instance.lintBuffer(original)).toBeFalse();
    expect(targets).toEqual([]);
    original.destroy();
    editor.destroy();
  });

  it("destroys the snapshot when a provider fails", async () => {
    const original = buffer();
    spyOn(console, "error");
    spyOn(lumine.notifications, "addError").and.returnValue({ onDidDismiss() {} });
    provider.lint = (editor) => {
      targets.push(editor);
      throw new Error("provider failed");
    };
    expect(await instance.lintBuffer(original)).toBeTrue();
    expect(targets[0].isDestroyed()).toBeTrue();
    expect(original.isDestroyed()).toBeFalse();
    original.destroy();
  });

  it("rejects pending results and new requests after disposal", async () => {
    const original = buffer();
    let target, resolve;
    provider.lint = (editor) =>
      new Promise((done) => {
        target = editor;
        resolve = done;
      });
    const pass = instance.lintBuffer(original);
    await conditionPromise(() => resolve);
    instance.dispose();
    expect(target.isDestroyed()).toBeTrue();
    expect(instance.snapshotEditors.size).toBe(0);
    resolve([message(target, "obsolete")]);
    expect(await pass).toBeFalse();
    expect(await instance.lintBuffer(original)).toBeFalse();
    expect(messages()).toEqual([]);
    expect(target.isDestroyed()).toBeTrue();
    original.destroy();
  });

  for (const teardown of ["package disposal", "buffer destruction"]) {
    it(`releases a snapshot waiting for its grammar after ${teardown}`, async () => {
      const original = buffer();
      const build = lumine.workspace.buildTextEditor.bind(lumine.workspace);
      let resolveReady, target;
      const ready = new Promise((resolve) => {
        resolveReady = resolve;
      });
      spyOn(provider, "lint").and.callThrough();
      spyOn(lumine.workspace, "buildTextEditor").and.callFake((options) => {
        target = build(options);
        const setGrammar = target.setGrammar.bind(target);
        spyOn(target, "setGrammar").and.callFake((grammar) => {
          setGrammar(grammar);
          Object.defineProperty(target.getBuffer().getLanguageMode(), "ready", { value: ready });
        });
        return target;
      });
      const pass = instance.lintBuffer(original);
      expect(instance.snapshotEditors.size).toBe(1);
      if (teardown === "package disposal") instance.dispose();
      else original.destroy();
      expect(target.isDestroyed()).toBeTrue();
      expect(instance.snapshotEditors.size).toBe(0);
      resolveReady();
      expect(await pass).toBeFalse();
      expect(provider.lint).not.toHaveBeenCalled();
      expect(messages()).toEqual([]);
    });
  }

  it("keeps provider registration state private to each registry", async () => {
    const other = new (require("../lib/linter-registry"))();
    other.addLinter(provider);
    const editor = await lumine.workspace.open();
    let resolve;
    const received = [];
    other.onDidUpdateMessages((event) => received.push(event));
    provider.lint = (target) =>
      new Promise((done) => {
        resolve = () => done([message(target, "independent")]);
      });
    const pass = other.lint({ editor });
    instance.deleteLinter(provider);
    resolve();
    await pass;
    expect(received.length).toBe(1);
    expect(Object.keys(provider).sort()).toEqual([
      "grammarScopes",
      "lint",
      "lintsOnChange",
      "name",
      "scope",
    ]);
    other.dispose();
    editor.destroy();
  });

  it("keeps a service handle tied to the generation that supplied it", async () => {
    const Main = require("../lib/main");
    Main.activate();
    const old = Main.provideLinterLint();
    Main.deactivate();
    Main.activate();
    const editor = await lumine.workspace.open();
    try {
      expect(await old.lintEditor(editor)).toBeFalse();
      expect(await Main.provideLinterLint().lintEditor(editor)).toBeTrue();
    } finally {
      Main.deactivate();
      editor.destroy();
    }
  });
});
