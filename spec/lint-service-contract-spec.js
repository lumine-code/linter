const path = require("node:path");
const { TextBuffer } = require("lumine");

describe("the awaitable lint service contract", () => {
  let Main;
  let service;
  let provider;
  let edges;
  let buffers;
  let editors;
  let calls;
  let runs;
  let passes;
  const filePath = path.join(__dirname, "lint-service-contract.py");
  const status = (result) => result.status;
  const diagnostic = (editor, excerpt = "fresh") => ({
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

  function register(entry = provider) {
    const edge = Main.consumeLinter(entry);
    edges.push(edge);
    return edge;
  }

  function namedBuffer() {
    const buffer = new TextBuffer({ text: "word\n", filePath });
    buffers.push(buffer);
    return buffer;
  }

  async function openEditor() {
    const editor = await lumine.workspace.open();
    editor.getBuffer().setPath(filePath);
    editor.setText("word\n");
    editors.push(editor);
    return editor;
  }

  function track(promise) {
    passes.push(promise);
    return promise;
  }

  function deferProvider() {
    provider.lint = (editor, options) =>
      new Promise((resolve) => {
        const run = { editor, options, resolve };
        calls.push(run);
        runs.push(run);
      });
  }

  async function messages(wantedPath = filePath) {
    const result = await Main.provideMcpTools()[0].execute({ filePath: wantedPath });
    return result.messages;
  }

  async function within(promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("not-settled"), 300);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  beforeEach(() => {
    jasmine.useRealClock();
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    lumine.config.set("linter.lintOnOpen", false);
    lumine.config.set("linter.lintOnChange", false);
    Main = require("../lib/main");
    Main.activate();
    service = Main.provideLinterLint();
    edges = [];
    buffers = [];
    editors = [];
    calls = [];
    runs = [];
    passes = [];
    provider = {
      name: "lint-contract-spec",
      scope: "file",
      grammarScopes: ["*"],
      lintsOnChange: false,
      lint(editor, options) {
        calls.push({ editor, options });
        return [diagnostic(editor)];
      },
    };
    register();
  });

  afterEach(async () => {
    for (const run of runs) run.resolve([]);
    await Promise.allSettled(passes);
    for (const edge of edges.reverse()) edge.dispose();
    for (const editor of editors) if (!editor.isDestroyed()) editor.destroy();
    for (const buffer of buffers) if (!buffer.isDestroyed()) buffer.destroy();
    Main.deactivate();
    await Promise.allSettled(buffers.map((buffer) => buffer.fileWatchStartPromise));
  });

  it("publishes named-buffer diagnostics before completion can be followed by MCP readout", async () => {
    const buffer = namedBuffer();
    const result = await track(service.lintBuffer(buffer));
    expect(status(result)).toBe("completed");
    expect((await messages()).map((message) => message.excerpt)).toEqual(["fresh"]);
    expect((await messages())[0].file).toBe(filePath);
    expect(buffer.isAlive()).toBeTrue();
    expect(result.reason).toBeNull();
    expect(result.providers[0].name).toBe(provider.name);
    expect(result.providers[0].status).toBe("published");
    expect(result.providers[0].messageCount).toBe(1);
  });

  for (const targetKind of ["editor", "buffer"]) {
    for (const change of ["edit", "rename"]) {
      it(`cancels a ${targetKind} pass whose target changed by ${change} during provider work`, async () => {
        deferProvider();
        const target = targetKind === "editor" ? await openEditor() : namedBuffer();
        const buffer = targetKind === "editor" ? target.getBuffer() : target;
        const pass = track(
          targetKind === "editor" ? service.lintEditor(target) : service.lintBuffer(target),
        );
        await conditionPromise(() => runs.length === 1);
        if (change === "edit") buffer.setText("changed\n");
        else buffer.setPath(path.join(__dirname, "lint-service-renamed.py"));
        runs[0].resolve([diagnostic(runs[0].editor, "obsolete")]);
        const result = await pass;
        expect(status(result)).toBe("cancelled");
        expect(await messages(buffer.getPath())).toEqual([]);
        expect(buffer.isAlive()).toBeTrue();
        if (targetKind === "editor") expect(target.isDestroyed()).toBeFalse();
      });
    }
  }

  it("reports the superseded pass as cancelled while only the newest pass publishes", async () => {
    deferProvider();
    const buffer = namedBuffer();
    const older = track(service.lintBuffer(buffer));
    await conditionPromise(() => runs.length === 1);
    const newer = track(service.lintBuffer(buffer));
    await conditionPromise(() => runs.length === 2);
    runs[0].resolve([diagnostic(runs[0].editor, "old")]);
    expect(status(await older)).toBe("cancelled");
    expect(await messages()).toEqual([]);
    runs[1].resolve([diagnostic(runs[1].editor, "new")]);
    expect(status(await newer)).toBe("completed");
    expect((await messages()).map((message) => message.excerpt)).toEqual(["new"]);
  });

  it("does not call providers when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await track(service.lintBuffer(namedBuffer(), { signal: controller.signal }));
    expect(status(result)).toBe("cancelled");
    expect(calls.length).toBe(0);
    expect(await messages()).toEqual([]);
  });

  it("forwards a cancellation signal and settles without waiting for an uncooperative provider", async () => {
    deferProvider();
    const controller = new AbortController();
    const buffer = namedBuffer();
    const pass = track(service.lintBuffer(buffer, { signal: controller.signal }));
    await conditionPromise(() => runs.length === 1);
    expect(typeof runs[0].options?.signal?.addEventListener).toBe("function");
    controller.abort();
    expect(status(await within(pass))).toBe("cancelled");
    expect(runs[0].options?.signal?.aborted).toBeTrue();
    expect(runs[0].editor.isDestroyed()).toBeTrue();
    expect(buffer.isAlive()).toBeTrue();
    runs[0].resolve([diagnostic(runs[0].editor, "late")]);
    await pass;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await messages()).toEqual([]);
  });

  for (const operation of ["remove", "disable"]) {
    it(`cancels a pending provider when its registration is ${operation}d`, async () => {
      deferProvider();
      const pass = track(service.lintBuffer(namedBuffer()));
      await conditionPromise(() => runs.length === 1);
      if (operation === "remove") edges[0].dispose();
      else lumine.config.set("linter.disabledProviders", [provider.name]);
      expect(status(await within(pass))).toBe("cancelled");
      runs[0].resolve([diagnostic(runs[0].editor, "removed")]);
      await pass;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await messages()).toEqual([]);
    });
  }

  it("cancels an outstanding pass promptly when its package generation deactivates", async () => {
    deferProvider();
    const buffer = namedBuffer();
    const pass = track(service.lintBuffer(buffer));
    await conditionPromise(() => runs.length === 1);
    Main.deactivate();
    expect(status(await within(pass))).toBe("cancelled");
    expect(runs[0].editor.isDestroyed()).toBeTrue();
    expect(buffer.isAlive()).toBeTrue();
    runs[0].resolve([diagnostic(runs[0].editor, "old generation")]);
    await pass;
    Main.activate();
    register();
    expect(await messages()).toEqual([]);
  });

  it("keeps stale lint handles inert after reactivation instead of invoking the new generation", async () => {
    const old = service;
    Main.deactivate();
    Main.activate();
    register();
    const result = await old.lintBuffer(namedBuffer());
    expect(status(result)).toBe("cancelled");
    expect(calls.length).toBe(0);
    expect(await messages()).toEqual([]);
  });

  it("allows an old provider edge to clean up after deactivation without a live instance", () => {
    Main.deactivate();
    expect(() => edges[0].dispose()).not.toThrow();
    Main.activate();
  });

  it("binds provider-edge cleanup to the generation that registered the provider", async () => {
    const oldEdge = edges[0];
    Main.deactivate();
    Main.activate();
    register();
    oldEdge.dispose();
    const fresh = Main.provideLinterLint();
    expect(status(await track(fresh.lintBuffer(namedBuffer())))).toBe("completed");
    expect(calls.length).toBe(1);
    expect((await messages()).map((message) => message.excerpt)).toEqual(["fresh"]);
  });

  it("rejects fabricated editor models before calling their methods", async () => {
    const getBuffer = jasmine.createSpy("fabricated getBuffer").and.returnValue(namedBuffer());
    await expectAsync(
      Promise.resolve().then(() => service.lintEditor({ getBuffer })),
    ).toBeRejectedWithError(TypeError);
    expect(getBuffer).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  it("rejects fabricated buffer models before reading or subscribing to them", async () => {
    const isAlive = jasmine.createSpy("fabricated isAlive").and.returnValue(false);
    await expectAsync(
      Promise.resolve().then(() => service.lintBuffer({ isAlive })),
    ).toBeRejectedWithError(TypeError);
    expect(isAlive).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  it("rejects malformed caller signals before starting a provider", async () => {
    await expectAsync(
      Promise.resolve().then(() =>
        service.lintBuffer(namedBuffer(), { signal: { aborted: false } }),
      ),
    ).toBeRejectedWithError(TypeError);
    expect(calls.length).toBe(0);
  });

  it("treats an absent target as a skipped request rather than a completed empty pass", async () => {
    for (const target of [null, undefined]) {
      for (const method of ["lintEditor", "lintBuffer"]) {
        const result = await service[method](target);
        expect(status(result)).toBe("skipped");
        expect(result.reason).toBe("no-target");
        expect(result.providers).toEqual([]);
      }
    }
    expect(calls.length).toBe(0);
  });

  it("applies preview policy to the requested editor when its pane is not active", async () => {
    const editor = await openEditor();
    const sourcePane = lumine.workspace.paneForItem(editor);
    sourcePane.setPendingItem(editor);
    const otherPane = sourcePane.splitRight({ copyActiveItem: false });
    try {
      otherPane.activate();
      expect(sourcePane.getPendingItem()).toBe(editor);
      expect(lumine.workspace.getActivePane()).toBe(otherPane);
      lumine.config.set("linter.lintPreviewTabs", false);
      const result = await track(service.lintEditor(editor));
      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("preview");
      expect(calls.length).toBe(0);
      expect(await messages()).toEqual([]);
    } finally {
      otherPane.destroy();
    }
  });

  it("reports a provider failure explicitly while publishing successful providers before completion", async () => {
    spyOn(console, "error");
    spyOn(lumine.notifications, "addError").and.returnValue({ onDidDismiss() {} });
    const failingName = "lint-contract-failing";
    register({
      ...provider,
      name: failingName,
      lint() {
        throw new Error("deliberate provider failure");
      },
    });
    const result = await track(service.lintBuffer(namedBuffer()));
    expect(status(result)).toBe("failed");
    expect(result.reason).toBe("provider-error");
    const success = result.providers?.find((entry) => entry.name === provider.name);
    const failure = result.providers?.find((entry) => entry.name === failingName);
    expect(success?.status).toBe("published");
    expect(success?.messageCount).toBe(1);
    expect(failure?.status).toBe("failed");
    expect(typeof failure?.error).toBe("string");
    expect((await messages()).map((message) => message.excerpt)).toEqual(["fresh"]);
  });

  it("distinguishes an unchanged provider from newly published diagnostics", async () => {
    const buffer = namedBuffer();
    await track(service.lintBuffer(buffer));
    provider.lint = () => null;
    const result = await track(service.lintBuffer(buffer));
    expect(status(result)).toBe("completed");
    const unchanged = result.providers?.find((entry) => entry.name === provider.name);
    expect(unchanged?.status).toBe("unchanged");
    expect(unchanged?.messageCount).toBe(0);
    expect((await messages()).map((message) => message.excerpt)).toEqual(["fresh"]);
  });
});
