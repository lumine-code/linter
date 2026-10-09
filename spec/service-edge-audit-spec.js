const path = require("node:path");
describe("Linter service edge ownership", () => {
  let main, editor, leases, delegates, item;
  const message = () => ({
    severity: "warning",
    excerpt: "Controlled diagnostic",
    location: {
      file: path.join(__dirname, "controlled-unopened.txt"),
      position: [
        [0, 0],
        [0, 1],
      ],
    },
  });
  beforeEach(async () => {
    await lumine.packages.deactivatePackage("linter");
    await lumine.packages.loadPackage("linter");
    lumine.config.set("linter.lintOnOpen", false);
    lumine.config.set("linter.lintOnChange", false);
    main = (await lumine.packages.activatePackage("linter")).mainModule;
    editor = await lumine.workspace.open();
    editor.setText("controlled");
    leases = [];
    delegates = [];
    item = null;
  });
  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    for (const delegate of delegates) delegate.dispose();
    if (item) await lumine.workspace.paneForItem(item)?.destroyItem(item, { force: true });
    await lumine.packages.deactivatePackage("linter");
    editor.destroy();
    lumine.config.unset("linter.lintOnOpen");
    lumine.config.unset("linter.lintOnChange");
  });
  function provide(name, value) {
    const lease = lumine.packages.serviceHub.provide(name, "1.0.0", value);
    leases.push(lease);
    return lease;
  }
  function classic(name) {
    return {
      name,
      scope: "file",
      grammarScopes: ["*"],
      lintsOnChange: false,
      lint: jasmine.createSpy(name).and.resolveTo([]),
    };
  }
  function publish() {
    const delegate = main.provideLinterRegistry()({ name: "controlled indie" });
    delegates.push(delegate);
    delegate.setAllMessages([message()]);
  }
  it("keeps a shared classic linter active until the final real hub edge retires", async () => {
    const provider = classic("shared classic");
    const first = provide("linter.provider", provider),
      second = provide("linter.provider", provider);
    first.dispose();
    const outcome = await main.provideLinterLint().lintEditor(editor);
    expect(provider.lint).toHaveBeenCalledTimes(1);
    expect(outcome.providers.map((entry) => entry.name)).toEqual(["shared classic"]);
    second.dispose();
    provider.lint.calls.reset();
    await main.provideLinterLint().lintEditor(editor);
    expect(provider.lint).not.toHaveBeenCalled();
  });
  it("releases only the original members when a provided linter array later changes", async () => {
    const a = classic("original array member"),
      b = classic("other edge member"),
      payload = [a];
    const first = provide("linter.provider", payload);
    provide("linter.provider", b);
    payload.push(b);
    first.dispose();
    await main.provideLinterLint().lintEditor(editor);
    expect(a.lint).not.toHaveBeenCalled();
    expect(b.lint).toHaveBeenCalledTimes(1);
  });
  it("shares one UI attachment and keeps it until the last payload edge retires", () => {
    const ui = {
      name: "shared UI",
      attach: jasmine.createSpy("attach"),
      render: jasmine.createSpy("render"),
      dispose: jasmine.createSpy("dispose"),
    };
    const first = provide("linter.ui", ui),
      second = provide("linter.ui", ui);
    expect(ui.attach).toHaveBeenCalledTimes(1);
    first.dispose();
    expect(ui.dispose).not.toHaveBeenCalled();
    publish();
    expect(ui.render).toHaveBeenCalledTimes(1);
    second.dispose();
    expect(ui.dispose).toHaveBeenCalledTimes(1);
  });
  it("delivers a message change to other UIs when one UI throws", () => {
    provide("linter.ui", {
      name: "broken UI",
      render() {
        throw new Error("Controlled UI error");
      },
    });
    const render = jasmine.createSpy("healthy UI render");
    provide("linter.ui", { name: "healthy UI", render });
    const log = spyOn(console, "error");
    try {
      publish();
    } catch {
      /* Original source can propagate the controlled UI failure. */
    }
    expect(render).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
  });
  it("keeps a shared adapter in the real active pane until its final edge retires", () => {
    let hub;
    provide("linter.ui", {
      name: "adapter observer",
      attach(value) {
        hub = value;
      },
    });
    item = { element: document.createElement("div"), getTitle: () => "Controlled adapter item" };
    const adapter = {
      handlesItem: (candidate) => candidate === item,
      getTextEditorForItem: () => editor,
      getMessagesForItem: () => [{ excerpt: "Owned adapter" }],
    };
    const first = provide("linter.adapter", adapter),
      second = provide("linter.adapter", adapter);
    const pane = lumine.workspace.getActivePane();
    pane.addItem(item);
    pane.activateItem(item);
    expect(hub.getCurrentMessages().map((message) => message.excerpt)).toEqual(["Owned adapter"]);
    first.dispose();
    expect(hub.getCurrentMessages().map((message) => message.excerpt)).toEqual(["Owned adapter"]);
    second.dispose();
    expect(hub.getCurrentMessages()).toEqual([]);
  });
  it("ignores an attach return value while retaining the documented UI registration", () => {
    const render = jasmine.createSpy("render after false attach");
    provide("linter.ui", { name: "false attach UI", attach: () => false, render });
    publish();
    expect(render).toHaveBeenCalledTimes(1);
  });
  it("keeps the outer shared UI lease when a nested lease ends during attach", () => {
    let nested = false;
    const ui = {
      name: "nested UI",
      render: jasmine.createSpy("nested render"),
      dispose: jasmine.createSpy("nested dispose"),
      attach: jasmine.createSpy("nested attach").and.callFake(() => {
        if (!nested) {
          nested = true;
          main.consumeLinterUI(ui).dispose();
        }
      }),
    };
    const outer = main.consumeLinterUI(ui);
    leases.push(outer);
    expect(ui.attach).toHaveBeenCalledTimes(1);
    expect(ui.dispose).not.toHaveBeenCalled();
    publish();
    expect(ui.render).toHaveBeenCalledTimes(1);
    outer.dispose();
    expect(ui.dispose).toHaveBeenCalledTimes(1);
  });
  it("does not invoke a callback returned after a documented UI getter retires its owner", () => {
    let armed = false;
    const render = jasmine.createSpy("retired getter render");
    const ui = {
      name: "getter retirement UI",
      get render() {
        if (armed) main.deactivate();
        return render;
      },
    };
    provide("linter.ui", ui);
    armed = true;
    publish();
    expect(render).not.toHaveBeenCalled();
  });
  it("releases native UI resources allocated before attach finishes retiring the package", () => {
    const resources = new (require("lumine").CompositeDisposable)();
    const ui = {
      name: "staged attach UI",
      attach() {
        main.deactivate();
        resources.add(editor.onDidChangeGrammar(() => {}));
      },
      dispose: jasmine.createSpy("staged UI dispose").and.callFake(() => resources.dispose()),
    };
    const lease = main.consumeLinterUI(ui);
    leases.push(lease);
    expect(resources.disposed).toBe(true);
    expect(ui.dispose).toHaveBeenCalledTimes(1);
    expect(editor.isDestroyed()).toBe(false);
  });
  it("does not invoke an attach returned by a getter that retires the current package", () => {
    let reads = 0;
    const attach = jasmine.createSpy("retired getter attach");
    provide("linter.ui", {
      name: "attach getter retirement UI",
      get attach() {
        if (++reads === 3) main.deactivate();
        return attach;
      },
    });
    expect(reads).toBe(3);
    expect(attach).not.toHaveBeenCalled();
  });
});
