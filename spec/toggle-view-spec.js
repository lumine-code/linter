const ToggleView = require("../lib/toggle-view");
const Linter = require("../lib/linter-main");

describe("ToggleView", () => {
  let view;

  beforeEach(() => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    lumine.config.set("linter.disabledProviders", []);
    view = new ToggleView(["first", "second"]);
  });

  afterEach(() => {
    view?.dispose();
    view = null;
    lumine.config.unset("linter.disabledProviders");
  });

  it("toggles the selected provider through a staying primary action", async () => {
    view.show();
    await view.selectList.selectItemById("second");

    await view.selectList.confirmSelection();

    expect(lumine.config.get("linter.disabledProviders")).toEqual(["second"]);
    expect(view.selectList.getSelectedItemId()).toBe("second");
    expect(view.selectListHost.isVisible()).toBe(true);
  });

  it("persists each transition without mutating the previously observed setting", () => {
    const before = lumine.config.get("linter.disabledProviders");
    view.toggle("first");
    const disabled = lumine.config.get("linter.disabledProviders");
    view.toggle("first");

    expect(before).toEqual([]);
    expect(disabled).toEqual(["first"]);
    expect(lumine.config.get("linter.disabledProviders")).toEqual([]);
  });

  it("updates its provider list while preserving the selected provider", async () => {
    view.show();
    await view.selectList.selectItemById("second");
    await view.setProviders(["first", "new server", "second"]);

    expect(view.selectList.getItems()).toEqual(["first", "new server", "second"]);
    expect(view.selectList.getSelectedItemId()).toBe("second");
  });

  it("disposes its subscriptions when the list is cancelled", () => {
    view.show();
    const dispose = jasmine.createSpy("dispose");
    view.onDidDispose(dispose);
    lumine.commands.dispatch(view.selectList.getElement(), "core:cancel");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(view.subscriptions.disposed).toBe(true);
    view.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("shared provider list", () => {
  let instance;

  beforeEach(() => {
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    lumine.config.set("linter.lintOnOpen", false);
    lumine.config.set("linter.disabledProviders", []);
    jasmine.attachToDOM(lumine.workspace.getElement());
    instance = new Linter();
  });

  afterEach(() => instance.dispose());

  it("combines both registries and tracks registration while the picker is open", async () => {
    const classic = {
      name: "Classic",
      scope: "file",
      grammarScopes: ["*"],
      lintsOnChange: true,
      lint: () => [],
    };
    instance.addLinter(classic);
    const indie = instance.addIndie({ name: "Language Server" });
    instance.addIndie({ name: "Classic" });
    instance.commands.toggleLinter();
    const [view] = instance.toggleViews;
    await view.setProviders(instance.getProviderNames());
    expect(view.providers).toEqual(["Classic", "Language Server"]);

    const extra = instance.addIndie({ name: "Another Server" });
    expect(view.providers).toEqual(["Another Server", "Classic", "Language Server"]);
    indie.dispose();
    expect(view.providers).toEqual(["Another Server", "Classic"]);
    instance.deleteLinter(classic);
    expect(view.providers).toEqual(["Another Server", "Classic"]);
    extra.dispose();
    expect(view.providers).toEqual(["Classic"]);
    view.dispose();
    expect(instance.toggleViews.size).toBe(0);
  });
});
