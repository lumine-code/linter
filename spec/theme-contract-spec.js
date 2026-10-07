const path = require("path");

describe("hint hover theme colors", () => {
  it("honors a hint color independently of general subtle text", () => {
    const stylesheet = lumine.themes.requireStylesheet(
      path.join(__dirname, "..", "styles", "linter.css"),
    );
    const container = document.createElement("div");
    container.className = "linter-hover";
    container.style.cssText =
      "--text-color-hint: rgb(10,20,30); --text-color-subtle: rgb(100,110,120);";
    container.innerHTML =
      '<div class="linter-hover-item hint"><span class="linter-hover-icon">Hint</span></div>';
    jasmine.attachToDOM(container);
    try {
      expect(getComputedStyle(container.firstElementChild).borderLeftColor).toBe("rgb(10, 20, 30)");
    } finally {
      container.remove();
      stylesheet.dispose();
    }
  });
});
