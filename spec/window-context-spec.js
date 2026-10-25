describe("linter toggles in editor windows", () => {
  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("linter");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("linter");
    await lumine.workspace.discardEditorWindows();
  });
  it("opens each provider chooser in its invoking document", async () => {
    const workspace = lumine.workspace;
    const first = await workspace.open();
    const extra = await workspace.openEditorWindow({ show: false });
    const second = workspace.buildTextEditor();
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    await lumine.commands.dispatch(first.getElement(), "linter:toggle-linter");
    await lumine.commands.dispatch(second.getElement(), "linter:toggle-linter");
    const local = workspace
      .getMainWindow()
      .getElement()
      .querySelector(".toggle-view lumine-input-dialog")
      .getModel();
    const remote = extra.getElement().querySelector(".toggle-view lumine-input-dialog").getModel();
    expect(remote.getElement().ownerDocument).toBe(extra.getDocument());
    await local.setQuery("local");
    await remote.setQuery("remote");
    expect(local.getQuery()).toBe("local");
    expect(remote.getQuery()).toBe("remote");
    await workspace.attachWindow(extra);
    expect(remote.isDestroyed()).toBe(true);
  });
});
