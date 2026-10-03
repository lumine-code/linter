const path = require("path");

describe("linter provider message state", () => {
  let instance;
  let editor;
  let renders;

  const filePath = path.join(__dirname, "provider-state.py");
  const otherPath = path.join(__dirname, "provider-state-other.py");
  const message = (excerpt, file = filePath, overrides = {}) => ({
    severity: "warning",
    excerpt,
    location: {
      file,
      position: [
        [0, 0],
        [0, 1],
      ],
    },
    ...overrides,
  });
  const classic = (overrides = {}) => ({
    name: "classic-state-spec",
    scope: "file",
    lintsOnChange: false,
    grammarScopes: ["*"],
    lint: () => [],
    ...overrides,
  });
  const visibleExcerpts = () =>
    instance.registryMessages.messages.map((entry) => entry.excerpt).sort();
  const createInstance = () => {
    // Reacquire the constructor for the current module generation. These specs
    // construct the hub directly and never activate or unload the package.
    const Linter = require("../lib/linter-main");
    instance = new Linter();
    instance.registryMessagesInit();
    instance.setUIRenderCallback((difference) => renders.push(difference));
  };

  beforeEach(() => {
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    lumine.config.set("linter.lintOnOpen", false);
    lumine.config.set("linter.lintOnChange", false);
    lumine.config.set("linter.disabledProviders", []);
    renders = [];
    editor = lumine.workspace.buildTextEditor();
    editor.setText("word\n");
    createInstance();
  });

  afterEach(() => {
    instance.dispose();
    editor.destroy();
    lumine.config.unset("linter.disabledProviders");
  });

  it("immediately removes a disabled indie's messages from every hub consumer", () => {
    const delegate = instance.addIndie({ name: "indie-state-spec" });
    const other = instance.addIndie({ name: "other-state-spec" });
    delegate.setMessages(filePath, [message("muted")]);
    other.setMessages(otherPath, [message("unaffected", otherPath)]);

    // A config edit must have the same effect as the provider picker.
    lumine.config.set("linter.disabledProviders", [delegate.name]);

    expect(visibleExcerpts()).toEqual(["unaffected"]);
    expect(renders[renders.length - 1].removed.map((entry) => entry.excerpt)).toEqual(["muted"]);
    expect(delegate.getMessages().map((entry) => entry.excerpt)).toEqual(["muted"]);
  });

  it("keeps indie updates cached while muted and restores the latest complete snapshot", () => {
    const delegate = instance.addIndie({ name: "indie-state-spec" });
    delegate.setMessages(filePath, [message("old")]);
    lumine.config.set("linter.disabledProviders", [delegate.name]);
    const renderCount = renders.length;

    delegate.setMessages(filePath, [message("new")]);
    delegate.setMessages(otherPath, [message("other", otherPath)]);

    expect(visibleExcerpts()).toEqual([]);
    expect(renders.length).toBe(renderCount);
    expect(
      delegate
        .getMessages()
        .map((entry) => entry.excerpt)
        .sort(),
    ).toEqual(["new", "other"]);

    lumine.config.set("linter.disabledProviders", []);

    expect(visibleExcerpts()).toEqual(["new", "other"]);
    expect(renders[renders.length - 1].added.map((entry) => entry.excerpt).sort()).toEqual([
      "new",
      "other",
    ]);
  });

  it("honors the saved disabled state before an indie first registers or publishes", () => {
    instance.dispose();
    lumine.config.set("linter.disabledProviders", ["indie-state-spec"]);
    createInstance();
    const delegate = instance.addIndie({ name: "indie-state-spec" });

    delegate.setMessages(filePath, [message("initially muted")]);

    expect(visibleExcerpts()).toEqual([]);
    expect(renders).toEqual([]);
    expect(delegate.getMessages().map((entry) => entry.excerpt)).toEqual(["initially muted"]);

    lumine.config.set("linter.disabledProviders", []);

    expect(visibleExcerpts()).toEqual(["initially muted"]);
  });

  it("retains full-snapshot replacements without showing their project-view request while muted", () => {
    const delegate = instance.addIndie({ name: "indie-state-spec" });
    const showProjectView = jasmine.createSpy("showProjectView");
    instance.setUIProjectViewCallback(showProjectView);
    delegate.setMessages(filePath, [message("obsolete")]);
    lumine.config.set("linter.disabledProviders", [delegate.name]);

    delegate.setAllMessages([message("replacement", otherPath)], { showProjectView: true });

    expect(visibleExcerpts()).toEqual([]);
    expect(showProjectView).not.toHaveBeenCalled();
    expect(delegate.getMessages().map((entry) => entry.excerpt)).toEqual(["replacement"]);

    lumine.config.set("linter.disabledProviders", []);

    expect(visibleExcerpts()).toEqual(["replacement"]);
  });

  it("does not restore a file deleted from a muted indie's snapshot", () => {
    const delegate = instance.addIndie({ name: "indie-state-spec" });
    delegate.setMessages(filePath, [message("deleted")]);
    delegate.setMessages(otherPath, [message("retained", otherPath)]);
    lumine.config.set("linter.disabledProviders", [delegate.name]);

    delegate.deleteFilePath(filePath);
    lumine.config.set("linter.disabledProviders", []);

    expect(visibleExcerpts()).toEqual(["retained"]);
  });

  it("does not restore messages cleared while an indie was muted", () => {
    const delegate = instance.addIndie({ name: "indie-state-spec" });
    delegate.setMessages(filePath, [message("cleared")]);
    lumine.config.set("linter.disabledProviders", [delegate.name]);

    delegate.clearMessages();
    lumine.config.set("linter.disabledProviders", []);

    expect(visibleExcerpts()).toEqual([]);
    expect(delegate.getMessages()).toEqual([]);
  });

  it("applies deleteOnOpen to a muted project snapshot before restoring it", async () => {
    const openEditor = await lumine.workspace.open(filePath);
    const delegate = instance.addIndie({ name: "project-state-spec", deleteOnOpen: true });
    lumine.config.set("linter.disabledProviders", [delegate.name]);

    delegate.setAllMessages([message("open file"), message("closed file", otherPath)]);
    expect(delegate.getMessages().map((entry) => entry.excerpt)).toEqual(["closed file"]);
    lumine.config.set("linter.disabledProviders", []);

    expect(visibleExcerpts()).toEqual(["closed file"]);
    openEditor.destroy();
  });

  it("does not restore a disposed indie when its provider name is enabled again", () => {
    const delegate = instance.addIndie({ name: "indie-state-spec" });
    delegate.setMessages(filePath, [message("disposed")]);
    lumine.config.set("linter.disabledProviders", [delegate.name]);

    delegate.dispose();
    lumine.config.set("linter.disabledProviders", []);

    expect(visibleExcerpts()).toEqual([]);
    expect(instance.registryIndie.getProviders()).toEqual([]);
  });

  it("uses the indie provider's name even when messages override their display source", () => {
    const delegate = instance.addIndie({ name: "indie-state-spec" });
    delegate.setMessages(filePath, [
      message("diagnostic", filePath, { linterName: "display-source" }),
    ]);
    lumine.config.set("linter.disabledProviders", [delegate.name]);

    expect(visibleExcerpts()).toEqual([]);

    lumine.config.set("linter.disabledProviders", ["display-source"]);

    expect(visibleExcerpts()).toEqual(["diagnostic"]);
    expect(instance.registryMessages.messages[0].linterName).toBe("display-source");
  });

  it("mutes every same-name indie while keeping their snapshots and lifetimes independent", () => {
    const first = instance.addIndie({ name: "shared-state-spec" });
    const second = instance.addIndie({ name: "shared-state-spec" });
    first.setMessages(filePath, [message("first")]);
    second.setMessages(otherPath, [message("second", otherPath)]);
    expect(visibleExcerpts()).toEqual(["first", "second"]);

    lumine.config.set("linter.disabledProviders", [first.name]);
    first.setMessages(filePath, [message("first latest")]);
    second.setMessages(otherPath, [message("second latest", otherPath)]);
    expect(visibleExcerpts()).toEqual([]);

    lumine.config.set("linter.disabledProviders", []);
    expect(visibleExcerpts()).toEqual(["first latest", "second latest"]);

    first.dispose();
    expect(visibleExcerpts()).toEqual(["second latest"]);
  });

  it("clears a classic provider immediately and rejects its in-flight result after disabling", async () => {
    const provider = classic({
      lint: () => [message("published", filePath, { linterName: "classic-display-source" })],
    });
    instance.addLinter(provider);
    await instance.registryLinters.lint({ editor });
    expect(visibleExcerpts()).toEqual(["published"]);
    let resolveLint;
    provider.lint = () => new Promise((resolve) => (resolveLint = resolve));
    const pending = instance.registryLinters.lint({ editor });

    lumine.config.set("linter.disabledProviders", [provider.name]);
    expect(visibleExcerpts()).toEqual([]);
    resolveLint([message("pending", filePath, { linterName: "classic-display-source" })]);
    await pending;

    expect(visibleExcerpts()).toEqual([]);
    expect(
      renders.some((change) => change.added.some((entry) => entry.excerpt === "pending")),
    ).toBe(false);
  });

  it("re-lints open editors when a classic provider is enabled from configuration", async () => {
    const openEditor = await lumine.workspace.open(filePath);
    let excerpt = "first run";
    const provider = classic({ lint: () => [message(excerpt)] });
    instance.addLinter(provider);
    await instance.registryLinters.lint({ editor: openEditor });
    lumine.config.set("linter.disabledProviders", [provider.name]);
    excerpt = "fresh run";

    lumine.config.set("linter.disabledProviders", []);
    await flushMicrotasks();

    expect(visibleExcerpts()).toEqual(["fresh run"]);
    openEditor.destroy();
  });

  it("does not accept an old classic run after disabling and re-enabling its provider", async () => {
    const openEditor = await lumine.workspace.open(filePath);
    let resolveOld;
    const provider = classic({
      lint: () => new Promise((resolve) => (resolveOld = resolve)),
    });
    instance.addLinter(provider);
    const oldRun = instance.registryLinters.lint({ editor: openEditor });
    lumine.config.set("linter.disabledProviders", [provider.name]);
    provider.lint = () => [message("new generation")];
    lumine.config.set("linter.disabledProviders", []);
    await flushMicrotasks();

    resolveOld([message("old generation")]);
    await oldRun;

    expect(visibleExcerpts()).toEqual(["new generation"]);
    openEditor.destroy();
  });

  it("keeps a paused document paused when its classic provider is enabled", async () => {
    const openEditor = await lumine.workspace.open(filePath);
    instance.registryEditorsInit();
    instance.registryEditors.disableTextEditorBuffer(openEditor);
    const lint = jasmine.createSpy("lint").and.returnValue([message("paused")]);
    const provider = classic({ lint });
    instance.addLinter(provider);
    lumine.config.set("linter.disabledProviders", [provider.name]);

    lumine.config.set("linter.disabledProviders", []);
    await flushMicrotasks();

    expect(lint).not.toHaveBeenCalled();
    expect(visibleExcerpts()).toEqual([]);
    openEditor.destroy();
  });
});
