const path = require("node:path");
const { TextBuffer } = require("lumine");

describe("awaitable linter request consistency", () => {
  let instance;
  let editors;
  let buffers;
  let retained;
  let pending;
  let provider;
  const filePath = path.join(__dirname, "request-consistency.txt");

  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
  const diagnostic = (editor, excerpt) => ({
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
  const excerpts = () =>
    instance.registryMessages?.messages.map((message) => message.excerpt) || [];
  const flush = async () => {
    for (let count = 0; count < 8; count++) await Promise.resolve();
  };
  const completed = (outcome) => outcome?.status === "completed";
  const cancelled = (outcome) => outcome?.status === "cancelled";
  const buildEditor = (options) => {
    const editor = lumine.workspace.buildTextEditor(options);
    editors.push(editor);
    if (!options?.buffer) editor.setText("before\n");
    return editor;
  };
  const buildBuffer = () => {
    const buffer = new TextBuffer({ text: "before\n", filePath });
    buffers.push(buffer);
    return buffer;
  };

  beforeEach(() => {
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    lumine.config.set("linter.lintOnOpen", false);
    lumine.config.set("linter.lintOnChange", false);
    lumine.config.set("linter.lintPreviewTabs", true);
    lumine.config.set("linter.ignoreGlob", "");
    lumine.config.set("linter.disabledProviders", []);
    editors = [];
    buffers = [];
    retained = [];
    pending = [];
    instance = new (require("../lib/linter-main"))();
    instance.registryEditorsInit();
    provider = {
      name: "request-consistency-provider",
      scope: "file",
      grammarScopes: ["*"],
      lintsOnChange: false,
      lint(editor, { signal } = {}) {
        const request = { ...deferred(), editor, text: editor.getText(), signal };
        pending.push(request);
        return request.promise;
      },
    };
    instance.addLinter(provider);
  });

  afterEach(async () => {
    instance.dispose();
    for (const request of pending) request.resolve(null);
    for (const editor of editors) if (!editor.isDestroyed()) editor.destroy();
    for (const buffer of retained) if (buffer.isAlive()) buffer.release();
    for (const buffer of buffers) if (buffer.isAlive()) buffer.destroy();
    await Promise.allSettled(buffers.map((buffer) => buffer.fileWatchStartPromise));
  });

  for (const mutation of ["text", "path", "grammar"]) {
    it(`does not publish diagnostics for a live editor's earlier ${mutation}`, async () => {
      const editor = buildEditor();
      editor.getBuffer().setPath(filePath);
      const pass = instance.lintEditor(editor);
      await conditionPromise(() => pending.length === 1);
      if (mutation === "text") editor.setText("after\n");
      if (mutation === "path") editor.getBuffer().setPath(`${filePath}.renamed`);
      if (mutation === "grammar") {
        await lumine.packages.activatePackage("language-javascript");
        editor.setGrammar(lumine.grammars.grammarForScopeName("source.js"));
      }
      pending[0].resolve([diagnostic(editor, "obsolete result")]);
      await pass;
      expect(excerpts()).toEqual([]);
    });
  }

  it("does not publish diagnostics after the live text changes and then returns to its old value", async () => {
    const editor = buildEditor();
    const pass = instance.lintEditor(editor);
    await conditionPromise(() => pending.length === 1);
    editor.setText("intermediate\n");
    editor.setText("before\n");
    pending[0].resolve([diagnostic(editor, "obsolete revision")]);
    await pass;
    expect(excerpts()).toEqual([]);
  });

  it("keeps a paused buffer paused while a previously started provider completes", async () => {
    const editor = buildEditor();
    const pass = instance.lintEditor(editor);
    await conditionPromise(() => pending.length === 1);
    instance.registryEditors.disableTextEditorBuffer(editor);
    pending[0].resolve([diagnostic(editor, "result after pause")]);
    await pass;
    expect(excerpts()).toEqual([]);
  });

  it("invalidates the paused generation even if the buffer is enabled again before completion", async () => {
    const editor = buildEditor();
    const pass = instance.lintEditor(editor);
    await conditionPromise(() => pending.length === 1);
    instance.registryEditors.disableTextEditorBuffer(editor);
    instance.registryEditors.enableTextEditorBuffer(editor);
    pending[0].resolve([diagnostic(editor, "result from paused generation")]);
    await pass;
    expect(excerpts()).toEqual([]);
  });

  it("cancels a destroyed editor even while its buffer remains owned by its caller", async () => {
    const editor = buildEditor();
    const buffer = editor.getBuffer();
    buffer.retain();
    retained.push(buffer);
    const pass = instance.lintEditor(editor);
    await conditionPromise(() => pending.length === 1);
    const result = diagnostic(editor, "closed editor");
    editor.destroy();
    expect(buffer.isAlive()).toBeTrue();
    pending[0].resolve([result]);
    expect(cancelled(await pass)).toBeTrue();
    expect(excerpts()).toEqual([]);
  });

  it("does not notify a provider failure for an obsolete live-buffer revision", async () => {
    const editor = buildEditor();
    spyOn(console, "error");
    const addError = spyOn(lumine.notifications, "addError").and.returnValue({ onDidDismiss() {} });
    const pass = instance.lintEditor(editor);
    await conditionPromise(() => pending.length === 1);
    editor.setText("after\n");
    pending[0].reject(new Error("tool rejected the previous text"));
    await pass;
    expect(addError).not.toHaveBeenCalled();
    expect(excerpts()).toEqual([]);
  });

  it("keeps the newer live-buffer intent when an older detached snapshot becomes ready later", async () => {
    const original = buildBuffer();
    const ready = deferred();
    const build = lumine.workspace.buildTextEditor.bind(lumine.workspace);
    let snapshot;
    spyOn(lumine.workspace, "buildTextEditor").and.callFake((options) => {
      const editor = build(options);
      editors.push(editor);
      if (!snapshot) {
        snapshot = editor;
        const setGrammar = editor.setGrammar.bind(editor);
        spyOn(editor, "setGrammar").and.callFake((grammar) => {
          setGrammar(grammar);
          Object.defineProperty(editor.getBuffer().getLanguageMode(), "ready", {
            value: ready.promise,
          });
        });
      }
      return editor;
    });
    provider.lint = (editor) => [
      diagnostic(editor, editor === snapshot ? "older intent" : "newer intent"),
    ];
    const older = instance.lintBuffer(original);
    expect(snapshot).toBeDefined();
    const live = lumine.workspace.buildTextEditor({ buffer: original });
    expect(completed(await instance.lintEditor(live))).toBeTrue();
    expect(excerpts()).toEqual(["newer intent"]);
    ready.resolve();
    await older;
    expect(excerpts()).toEqual(["newer intent"]);
  });

  it("keeps the newest detached intent when snapshots finish grammar preparation out of order", async () => {
    const original = buildBuffer();
    const gates = [];
    const snapshots = [];
    const build = lumine.workspace.buildTextEditor.bind(lumine.workspace);
    spyOn(lumine.workspace, "buildTextEditor").and.callFake((options) => {
      const editor = build(options);
      editors.push(editor);
      snapshots.push(editor);
      const ready = deferred();
      gates.push(ready);
      const setGrammar = editor.setGrammar.bind(editor);
      spyOn(editor, "setGrammar").and.callFake((grammar) => {
        setGrammar(grammar);
        Object.defineProperty(editor.getBuffer().getLanguageMode(), "ready", {
          value: ready.promise,
        });
      });
      return editor;
    });
    provider.lint = (editor) => [
      diagnostic(editor, editor === snapshots[0] ? "older intent" : "newer intent"),
    ];
    const older = instance.lintBuffer(original);
    const newer = instance.lintBuffer(original);
    gates[1].resolve();
    await newer;
    expect(excerpts()).toEqual(["newer intent"]);
    gates[0].resolve();
    await older;
    expect(excerpts()).toEqual(["newer intent"]);
  });

  it("waits for every selected provider when one fails before another publishes", async () => {
    const editor = buildEditor();
    spyOn(console, "error");
    spyOn(lumine.notifications, "addError").and.returnValue({ onDidDismiss() {} });
    instance.addLinter({ ...provider, name: "second-consistency-provider" });
    let settled = false;
    const pass = instance.lintEditor(editor).then((outcome) => {
      settled = true;
      return outcome;
    });
    await conditionPromise(() => pending.length === 2);
    pending[0].reject(new Error("one provider failed"));
    await flush();
    expect(settled).toBeFalse();
    pending[1].resolve([diagnostic(editor, "successful provider")]);
    const result = await pass;
    expect(result.status).toBe("failed");
    expect(result.providers).toContain(
      jasmine.objectContaining({
        name: provider.name,
        status: "failed",
        reason: "provider-error",
        error: "one provider failed",
      }),
    );
    expect(result.providers).toContain(
      jasmine.objectContaining({
        name: "second-consistency-provider",
        status: "published",
        messageCount: 1,
      }),
    );
    expect(excerpts()).toEqual(["successful provider"]);
  });

  it("completes a no-provider pass without pretending diagnostics were published", async () => {
    const editor = buildEditor();
    instance.deleteLinter(provider);
    expect(completed(await instance.lintEditor(editor))).toBeTrue();
    expect(excerpts()).toEqual([]);
  });

  it("contains malformed provider results and still awaits every healthy provider", async () => {
    const editor = buildEditor();
    spyOn(console, "error");
    const addError = spyOn(lumine.notifications, "addError").and.returnValue({ onDidDismiss() {} });
    const addWarning = spyOn(lumine.notifications, "addWarning");
    provider.lint = () => [null];
    instance.addLinter({
      ...provider,
      name: "healthy-consistency-provider",
      lint(target) {
        const request = { ...deferred(), editor: target };
        pending.push(request);
        return request.promise;
      },
    });
    let settled = false;
    const pass = instance.lintEditor(editor).then(
      (outcome) => {
        settled = true;
        return outcome;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await conditionPromise(() => pending.length === 1);
    await flush();
    expect(settled).toBeFalse();
    pending[0].resolve([diagnostic(editor, "healthy result")]);
    const result = await pass;
    expect(result.status).toBe("failed");
    expect(result.providers).toContain(
      jasmine.objectContaining({
        name: provider.name,
        status: "failed",
        reason: "invalid-messages",
        messageCount: 0,
      }),
    );
    expect(addWarning).toHaveBeenCalledTimes(1);
    expect(addError).not.toHaveBeenCalled();
    expect(excerpts()).toEqual(["healthy result"]);
  });

  it("ignores late results after a provider has timed out", async () => {
    const editor = buildEditor();
    spyOn(console, "error");
    const addError = spyOn(lumine.notifications, "addError").and.returnValue({ onDidDismiss() {} });
    const pass = instance.lintEditor(editor);
    await conditionPromise(() => pending.length === 1);
    advanceClock(30000);
    const result = await pass;
    expect(result.status).toBe("failed");
    expect(result.providers).toContain(
      jasmine.objectContaining({
        name: provider.name,
        status: "failed",
        reason: "timeout",
        messageCount: 0,
      }),
    );
    expect(addError).toHaveBeenCalledTimes(1);
    pending[0].resolve([diagnostic(editor, "result after deadline")]);
    await flush();
    expect(excerpts()).toEqual([]);
  });

  it("pairs progress events when a begin listener synchronously disposes the hub", async () => {
    const editor = buildEditor();
    const progress = [];
    const lint = spyOn(provider, "lint").and.returnValue([]);
    instance.setUIBeginLintingCallback((event) => {
      progress.push({ kind: "begin", number: event.number });
      instance.dispose();
    });
    instance.setUIFinishLintingCallback((event) =>
      progress.push({ kind: "finish", number: event.number }),
    );
    expect(cancelled(await instance.lintEditor(editor))).toBeTrue();
    expect(lint).not.toHaveBeenCalled();
    expect(progress.map((event) => event.kind)).toEqual(["begin", "finish"]);
    expect(progress[1]?.number).toBe(progress[0]?.number);
  });

  it("contains an unprintable provider rejection without cancelling a healthy sibling", async () => {
    const editor = buildEditor();
    spyOn(console, "error");
    spyOn(lumine.notifications, "addError").and.returnValue({ onDidDismiss() {} });
    provider.lint = () => Promise.reject(Object.create(null));
    instance.addLinter({
      ...provider,
      name: "healthy-rejection-provider",
      lint(target) {
        const request = { ...deferred(), editor: target };
        pending.push(request);
        return request.promise;
      },
    });
    let settled = false;
    const pass = instance.lintEditor(editor).then((outcome) => {
      settled = true;
      return outcome;
    });
    await conditionPromise(() => pending.length === 1);
    await flush();
    expect(settled).toBeFalse();
    pending[0].resolve([diagnostic(editor, "healthy after opaque rejection")]);
    const result = await pass;
    expect(result.status).toBe("failed");
    expect(result.providers).toContain(
      jasmine.objectContaining({
        name: provider.name,
        status: "failed",
        reason: "provider-error",
      }),
    );
    expect(result.providers).toContain(
      jasmine.objectContaining({
        name: "healthy-rejection-provider",
        status: "published",
        messageCount: 1,
      }),
    );
    expect(excerpts()).toEqual(["healthy after opaque rejection"]);
  });

  it("supersedes only the shared project provider while both buffers' file providers finish", async () => {
    const first = buildEditor();
    const second = buildEditor();
    first.getBuffer().setPath(`${filePath}.first`);
    second.getBuffer().setPath(`${filePath}.second`);
    const record =
      (kind) =>
      (editor, { signal }) => {
        const request = { ...deferred(), kind, editor, signal };
        pending.push(request);
        return request.promise;
      };
    provider.lint = record("file");
    const project = {
      ...provider,
      name: "shared-project-consistency-provider",
      scope: "project",
      lint: record("project"),
    };
    instance.addLinter(project);
    let firstSettled = false;
    const firstPass = instance.lintEditor(first).then((result) => {
      firstSettled = true;
      return result;
    });
    await conditionPromise(() => pending.length === 2);
    const secondPass = instance.lintEditor(second);
    await conditionPromise(() => pending.length === 4);
    const requestFor = (kind, editor) =>
      pending.find((request) => request.kind === kind && request.editor === editor);
    const firstProject = requestFor("project", first);
    const firstFile = requestFor("file", first);
    expect(firstProject.signal.aborted).toBeTrue();
    expect(firstFile.signal.aborted).toBeFalse();
    await flush();
    expect(firstSettled).toBeFalse();
    requestFor("file", second).resolve([diagnostic(second, "second file")]);
    requestFor("project", second).resolve([diagnostic(second, "new project")]);
    const secondResult = await secondPass;
    expect(secondResult.status).toBe("completed");
    expect(secondResult.providers).toContain(
      jasmine.objectContaining({ name: provider.name, status: "published", messageCount: 1 }),
    );
    expect(secondResult.providers).toContain(
      jasmine.objectContaining({ name: project.name, status: "published", messageCount: 1 }),
    );
    firstFile.resolve([diagnostic(first, "first file")]);
    const firstResult = await firstPass;
    expect(firstResult.status).toBe("cancelled");
    expect(firstResult.reason).toBe("superseded");
    expect(firstResult.providers).toContain(
      jasmine.objectContaining({ name: provider.name, status: "published", messageCount: 1 }),
    );
    expect(firstResult.providers).toContain(
      jasmine.objectContaining({
        name: project.name,
        status: "cancelled",
        reason: "superseded",
        messageCount: 0,
      }),
    );
    expect(excerpts().sort()).toEqual(["first file", "new project", "second file"]);
    firstProject.resolve([diagnostic(first, "obsolete project")]);
    await flush();
    expect(excerpts().sort()).toEqual(["first file", "new project", "second file"]);
  });

  for (const mutation of [
    "caller encoding",
    "caller text",
    "snapshot encoding",
    "snapshot text",
    "snapshot edit and revert",
  ]) {
    it(`cancels a detached pass on ${mutation} while preserving the caller's ownership`, async () => {
      const original = buildBuffer();
      const originalEncoding = original.getEncoding();
      const pass = instance.lintBuffer(original);
      await conditionPromise(() => pending.length === 1);
      const request = pending[0];
      const snapshot = request.editor.getBuffer();
      const lateResult = diagnostic(request.editor, "obsolete detached result");
      if (mutation === "caller encoding") original.setEncoding("latin1");
      if (mutation === "caller text") original.setText("caller changed\n");
      if (mutation === "snapshot encoding") {
        // A generic buffer helper can hold the public base mutator even when
        // the snapshot's override suppresses factory configuration changes.
        TextBuffer.prototype.setEncoding.call(snapshot, "latin1");
        expect(snapshot.getEncoding()).toBe("latin1");
      }
      if (mutation === "snapshot text" || mutation === "snapshot edit and revert") {
        snapshot.setText("snapshot changed\n");
        if (mutation === "snapshot edit and revert") snapshot.setText("before\n");
      }
      expect(request.signal.aborted).toBeTrue();
      let result;
      pass.then((outcome) => {
        result = outcome;
      });
      await flush();
      expect(result?.status).toBe("cancelled");
      // Finish the non-cooperative provider after observing cancellation so a
      // failing scheduler test also settles cleanly.
      request.resolve([lateResult]);
      const outcome = await pass;
      expect(outcome.status).toBe("cancelled");
      expect(outcome.providers).toContain(
        jasmine.objectContaining({ name: provider.name, status: "cancelled", messageCount: 0 }),
      );
      expect(excerpts()).toEqual([]);
      expect(original.isAlive()).toBeTrue();
      if (mutation.startsWith("snapshot")) {
        expect(original.getText()).toBe("before\n");
        expect(original.getEncoding()).toBe(originalEncoding);
      }
    });
  }
});
