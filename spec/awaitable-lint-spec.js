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
    jasmine.useRealClock();
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
    await conditionPromise(() => resolve);
    resolve();
    expect((await pass).status).toBe("completed");
    expect(messages().map((entry) => entry.excerpt)).toEqual(["fresh"]);
    editor.destroy();
  });

  it("lints a private snapshot without opening a tab or taking buffer ownership", async () => {
    const original = buffer();
    const items = lumine.workspace.getPaneItems().slice();
    const originalRefcount = original.refcount;
    expect((await instance.lintBuffer(original)).status).toBe("completed");
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
    expect((await instance.lintBuffer(editor.getBuffer())).status).toBe("completed");
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
    expect((await second).status).toBe("completed");
    pending[0].resolve([message(pending[0].editor, "old")]);
    expect((await first).status).toBe("cancelled");
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
      }
      resolve([message(target, "stale")]);
      expect((await pass).status).toBe("cancelled");
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
    const disabled = await instance.lintBuffer(editor.getBuffer());
    expect(disabled.status).toBe("skipped");
    expect(disabled.reason).toBe("disabled");
    const original = buffer();
    // Match this buffer even when the checkout itself is in a hidden directory.
    lumine.config.set("linter.ignoreGlob", filePath.replace(/\\/g, "/"));
    const ignored = await instance.lintBuffer(original);
    expect(ignored.status).toBe("skipped");
    expect(ignored.reason).toBe("ignored");
    original.setPath(null);
    const pathless = await instance.lintBuffer(original);
    expect(pathless.status).toBe("skipped");
    expect(pathless.reason).toBe("no-path");
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
    const result = await instance.lintBuffer(original);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("provider-error");
    expect(result.providers[0].status).toBe("failed");
    expect(result.providers[0].error).toBe("provider failed");
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
    resolve([message(target, "obsolete")]);
    expect((await pass).status).toBe("cancelled");
    const stale = await instance.lintBuffer(original);
    expect(stale.status).toBe("cancelled");
    expect(stale.reason).toBe("disposed");
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
        targets.push(target);
        spyOn(target, "whenGrammarSettled").and.returnValue(ready);
        return target;
      });
      const pass = instance.lintBuffer(original);
      expect(target.isDestroyed()).toBeFalse();
      if (teardown === "package disposal") instance.dispose();
      else original.destroy();
      expect(target.isDestroyed()).toBeTrue();
      resolveReady();
      expect((await pass).status).toBe("cancelled");
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
    await conditionPromise(() => resolve);
    instance.deleteLinter(provider);
    resolve();
    expect((await pass).status).toBe("completed");
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
      const stale = await old.lintEditor(editor);
      expect(stale.status).toBe("cancelled");
      expect(stale.reason).toBe("disposed");
      expect((await Main.provideLinterLint().lintEditor(editor)).status).toBe("completed");
    } finally {
      Main.deactivate();
      editor.destroy();
    }
  });
});
