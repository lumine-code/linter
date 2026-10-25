describe("file linter command availability", () => {
  beforeEach(async () => {
    const textGrammarPackage = await lumine.packages.activatePackage("language-text");
    await textGrammarPackage.resourceLoadPromise;
  });

  it("requires a captured document without initializing diagnostics registries", async () => {
    await lumine.packages.activatePackage("linter");
    jasmine.attachToDOM(lumine.workspace.getElement());
    const available = () =>
      lumine.commands.canDispatch(lumine.workspace.getElement(), "linter:toggle-current-file");
    expect(available()).toBe(false);
    const editor = await lumine.workspace.open();
    expect(available()).toBe(true);
    editor.destroy();
    expect(available()).toBe(false);
    await lumine.packages.deactivatePackage("linter");
  });
});
