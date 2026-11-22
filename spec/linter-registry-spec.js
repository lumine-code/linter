let LinterRegistry;

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

  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    LinterRegistry = require("../lib/linter-registry");
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

  it("clears a run's timeout when its provider finishes", async () => {
    const editor = await lumine.workspace.open(__filename);
    const timeoutID = 42;
    spyOn(globalThis, "setTimeout").and.returnValue(timeoutID);
    const clearTimeout = spyOn(globalThis, "clearTimeout");

    await registry.lint({ editor });

    expect(clearTimeout).toHaveBeenCalledWith(timeoutID);
    editor.destroy();
  });

  it("lints a buffer that has never been saved", async () => {
    const editor = await lumine.workspace.open();

    await registry.lint({ editor });

    expect(linted).toEqual([editor]);
    editor.destroy();
  });

  for (const policy of ["unregistered", "disabled", "on-change disabled", "empty grammar scopes"]) {
    it(`skips syntax preparation with ${policy} providers`, async () => {
      const editor = await lumine.workspace.open();
      const settle = spyOn(editor, "whenGrammarSettled");
      const exact = spyOn(editor, "getScopeDescriptorsForBufferPositions");
      if (policy === "unregistered") registry.deleteLinter(linter);
      if (policy === "disabled") registry.setDisabledProviders([linter.name]);
      if (policy === "on-change disabled") linter.lintsOnChange = false;
      if (policy === "empty grammar scopes") linter.grammarScopes = [];
      try {
        const pass = await registry.lint({ editor, trigger: "change" });
        expect(pass).toEqual({ status: "completed", reason: null, providers: [] });
        expect(settle).not.toHaveBeenCalled();
        expect(exact).not.toHaveBeenCalled();
      } finally {
        editor.destroy();
      }
    });
  }

  it("selects wildcard providers without querying scopes and still supplies settled syntax", async () => {
    const editor = await lumine.workspace.open();
    const exact = spyOn(editor, "getScopeDescriptorsForBufferPositions");
    let resolve;
    spyOn(editor, "whenGrammarSettled").and.returnValue(new Promise((done) => (resolve = done)));
    try {
      const pass = registry.lint({ editor });
      expect(linted).toEqual([]);
      resolve(true);
      expect((await pass).status).toBe("completed");
      expect(linted).toEqual([editor]);
      expect(exact).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
    }
  });

  it("selects scoped providers with one exact query over all cursor positions", async () => {
    const editor = await lumine.workspace.open();
    editor.setText("first\nsecond");
    editor.setCursorBufferPosition([0, 1]);
    editor.addCursorAtBufferPosition([1, 1]);
    linter.grammarScopes = ["meta.embedded.test"];
    for (const cursor of editor.getCursors())
      spyOn(cursor, "getScopeDescriptor").and.throwError("unexpected presentation scope");
    const exact = spyOn(editor, "getScopeDescriptorsForBufferPositions").and.resolveTo([
      editor.getRootScopeDescriptor(),
      { getScopesArray: () => ["meta.embedded.test"] },
    ]);
    const settle = spyOn(editor, "whenGrammarSettled").and.resolveTo(true);
    try {
      const pass = await registry.lint({ editor });
      expect(pass.status).toBe("completed");
      expect(linted).toEqual([editor]);
      expect(exact).toHaveBeenCalledTimes(1);
      expect(exact.calls.mostRecent().args[0]).toEqual(editor.getCursorBufferPositions());
      expect(settle).toHaveBeenCalledTimes(1);
      expect(exact.calls.mostRecent().args[1].signal).toBe(
        settle.calls.mostRecent().args[0].signal,
      );
    } finally {
      editor.destroy();
    }
  });

  it("leaves unrelated syntax unsettled when exact scopes rule out every provider", async () => {
    const editor = await lumine.workspace.open();
    linter.grammarScopes = ["source.unrelated"];
    const exact = spyOn(editor, "getScopeDescriptorsForBufferPositions").and.resolveTo([
      editor.getRootScopeDescriptor(),
    ]);
    const settle = spyOn(editor, "whenGrammarSettled");
    try {
      expect(await registry.lint({ editor })).toEqual({
        status: "completed",
        reason: null,
        providers: [],
      });
      expect(exact).toHaveBeenCalledTimes(1);
      expect(settle).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
    }
  });

  it("cancels a pending scope lookup before invoking any provider", async () => {
    const editor = await lumine.workspace.open();
    linter.grammarScopes = ["meta.embedded.test"];
    let resolve;
    const exact = spyOn(editor, "getScopeDescriptorsForBufferPositions").and.returnValue(
      new Promise((done) => (resolve = done)),
    );
    const settle = spyOn(editor, "whenGrammarSettled");
    const controller = new AbortController();
    try {
      const pass = registry.lint({ editor, signal: controller.signal });
      controller.abort();
      expect((await pass).status).toBe("cancelled");
      expect(exact.calls.mostRecent().args[1].signal.aborted).toBeTrue();
      resolve([{ getScopesArray: () => ["meta.embedded.test"] }]);
      await Promise.resolve();
      expect(linted).toEqual([]);
      expect(settle).not.toHaveBeenCalled();
    } finally {
      editor.destroy();
    }
  });

  it("rechecks exact scopes if the cursor moves while provider readiness is pending", async () => {
    const editor = await lumine.workspace.open();
    editor.setText("first\nsecond");
    editor.setCursorBufferPosition([0, 0]);
    linter.grammarScopes = ["meta.embedded.test"];
    const exact = spyOn(editor, "getScopeDescriptorsForBufferPositions").and.callFake(
      async ([position]) => [
        { getScopesArray: () => (position.row === 0 ? ["meta.embedded.test"] : ["text.plain"]) },
      ],
    );
    let resolve;
    const settle = spyOn(editor, "whenGrammarSettled").and.returnValue(
      new Promise((done) => (resolve = done)),
    );
    try {
      const pass = registry.lint({ editor });
      await conditionPromise(() => settle.calls.any());
      editor.setCursorBufferPosition([1, 0]);
      resolve(true);
      expect((await pass).providers).toEqual([]);
      expect(linted).toEqual([]);
      expect(exact).toHaveBeenCalledTimes(2);
    } finally {
      editor.destroy();
    }
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
    await conditionPromise(() => resolvers.length === 1);
    const newRun = registry.lint({ editor });
    await conditionPromise(() => resolvers.length === 2);
    resolvers[0]([messageFor(editor, "old")]);
    await oldRun;
    resolvers[1]([messageFor(editor, "new")]);
    await newRun;

    expect(received.map((message) => message.excerpt)).toEqual(["new"]);
    editor.destroy();
  });

  it("drops a run from an earlier registration of the same provider object", async () => {
    const editor = await lumine.workspace.open();
    const resolvers = [];
    const received = [];
    const started = [];
    registry.onDidUpdateMessages(({ messages }) => received.push(...messages));
    registry.onDidBeginLinting(({ number }) => started.push(number));
    linter.lint = () => new Promise((resolve) => resolvers.push(resolve));

    const oldRun = registry.lint({ editor });
    await conditionPromise(() => resolvers.length === 1);
    registry.deleteLinter(linter);
    registry.addLinter(linter);
    const newRun = registry.lint({ editor });
    await conditionPromise(() => resolvers.length === 2);
    resolvers[1]([messageFor(editor, "new generation")]);
    await newRun;
    resolvers[0]([messageFor(editor, "old generation")]);
    await oldRun;

    expect(received.map((entry) => entry.excerpt)).toEqual(["new generation"]);
    expect(started[1]).toBeGreaterThan(started[0]);
    editor.destroy();
  });

  it("does not reset requests when a registered provider is added again", async () => {
    const editor = await lumine.workspace.open();
    const resolvers = [];
    const received = [];
    registry.onDidUpdateMessages(({ messages }) => received.push(...messages));
    linter.lint = () => new Promise((resolve) => resolvers.push(resolve));

    const oldRun = registry.lint({ editor });
    await conditionPromise(() => resolvers.length === 1);
    registry.addLinter(linter);
    const newRun = registry.lint({ editor });
    await conditionPromise(() => resolvers.length === 2);
    resolvers[1]([messageFor(editor, "new")]);
    await newRun;
    resolvers[0]([messageFor(editor, "old")]);
    await oldRun;

    expect(received.map((entry) => entry.excerpt)).toEqual(["new"]);
    editor.destroy();
  });
});
