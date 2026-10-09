describe("Linter pending diagnostic description", () => {
  let helpers, elements, finishes;
  beforeEach(async () => {
    await lumine.packages.activatePackage("linter");
    helpers = require("../lib/helpers");
    elements = [];
    finishes = [];
  });
  afterEach(async () => {
    for (const finish of finishes) finish("controlled detail");
    for (const element of elements) element.remove();
    await lumine.packages.deactivatePackage("linter");
  });
  it("shares one pending resolver across two actual hover surfaces", async () => {
    const description = jasmine.createSpy("description").and.callFake(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    );
    const message = {
      severity: "warning",
      excerpt: "Controlled",
      linterName: "controlled",
      description,
    };
    const { buildElement } = require("../lib/context-help-provider");
    for (let index = 0; index < 2; index++) {
      const element = buildElement([message]);
      elements.push(element);
      jasmine.attachToDOM(element);
    }
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    expect(description).toHaveBeenCalledTimes(1);
    for (const finish of finishes) finish("controlled detail");
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    for (const element of elements)
      expect(element.querySelector(".linter-hover-detail").textContent).toBe("controlled detail");
    expect(helpers.getDescription(message)).toBe("controlled detail");
  });
});
