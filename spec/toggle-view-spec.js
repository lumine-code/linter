const ToggleView = require("../lib/toggle-view");

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
    expect(view.selectList.isVisible()).toBe(true);
  });
});
