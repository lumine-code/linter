const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
// The keymap/menu files are JSONC (JSON with comments and trailing commas).
// Strip whole-line comments and trailing commas before JSON.parse so the tests
// can validate their structure without pulling in a JSONC parser.
const parseJsonc = (rel) =>
  JSON.parse(
    read(rel)
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1"),
  );

// Guards for the CSON -> JSON / Less -> CSS modernization, and for the boundary
// the front end was extracted across: what the hub ships is the markers, the
// hover and the services, and nothing that draws a panel.
describe("linter package assets", () => {
  it("ships keymaps and menus as JSONC, not CSON or plain JSON", () => {
    expect(exists("keymaps/main.jsonc")).toBe(true);
    expect(exists("menus/main.jsonc")).toBe(true);
    expect(exists("keymaps/linter-bundle.cson")).toBe(false);
    expect(exists("menus/linter-bundle.cson")).toBe(false);
    expect(exists("keymaps/main.json")).toBe(false);
    expect(exists("menus/main.json")).toBe(false);
  });

  it("uses the linter: command prefix in the keymap and menu", () => {
    const keymap = parseJsonc("keymaps/main.jsonc");
    expect(keymap["lumine-text-editor:not([mini])"]["alt-'"]).toBe("linter:next");

    const menu = parseJsonc("menus/main.jsonc");
    const flat = JSON.stringify(menu);
    expect(flat).toContain("linter:lint");
    // Menu entries must use the singular `command` key.
    expect(flat).not.toContain('"commands"');
  });

  // The front end is `linter-panel`'s. Its commands, its reveal-tier key and
  // its root class must not be named from here.
  it("names nothing that belongs to the panel", () => {
    for (const file of ["keymaps/main.jsonc", "menus/main.jsonc"]) {
      const source = read(file);
      expect(source).not.toContain("linter-panel");
      expect(source).not.toContain("alt-l");
      expect(source).not.toContain("toggle-panel");
    }
  });

  it("ships a CSS stylesheet built on custom properties, not Less", () => {
    expect(exists("styles/linter.css")).toBe(true);
    expect(exists("styles/linter-bundle.less")).toBe(false);
    const css = read("styles/linter.css");
    expect(css).toContain("var(--");
    // Check the code, not the explanatory header comment, for Less leftovers.
    const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(cssWithoutComments).not.toContain('@import "ui-variables"');
    expect(cssWithoutComments).not.toMatch(/\bfade\(|\bcontrast\(|\blighten\(|\bdarken\(/);
  });

  it("keeps every diagnostic underline one pixel thick", () => {
    const css = read("styles/linter.css");
    expect(css).toMatch(/\.linter-text\s*\{[^}]*text-decoration-thickness:\s*1px;/);
  });

  it("styles the decorations and the hover, and nothing the panel draws", () => {
    const css = read("styles/linter.css");
    expect(css).toContain(".linter-hover");
    expect(css).not.toContain(".linter-panel");
    expect(css).not.toContain(".linter-status");
    expect(css).not.toContain(".linter-row");
  });

  it("is named `linter`, scopes its dependencies, and drops lodash", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("linter");
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toBe("https://github.com/lumine-code/linter");
    expect(pkg.dependencies.lodash).toBeUndefined();
    // The view libraries went with the view: the hub renders no DOM of its own.
    expect(pkg.dependencies["@lumine-code/etch"]).toBeUndefined();
    expect(pkg.dependencies["@lumine-code/select-list"]).toBeUndefined();
    expect(pkg.dependencies.etch).toBeUndefined();
  });

  it("leaves the status bar and the panel's settings to the front end", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.consumedServices["status-bar"]).toBeUndefined();
    expect(pkg.configSchema.defaultSortMethod).toBeUndefined();
    expect(pkg.configSchema.statusMode).toBeUndefined();
    // A hub has nothing to teach; the tips went with the surfaces.
    expect(pkg.backgroundTips).toBeUndefined();
  });

  it("keeps the shared linter service contract intact", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.providedServices["linter.registry"].versions["1.0.0"]).toBe("provideLinterRegistry");
    expect(pkg.providedServices["linter.editors"].versions["1.0.0"]).toBe("provideLinterEditors");
    expect(pkg.providedServices["intentions.list"].versions["1.0.0"]).toBe("provideIntentionsList");
    expect(pkg.providedServices["mcp.tools"].versions["1.0.0"]).toBe("provideMcpTools");
    expect(pkg.providedServices["marker.layer"].versions["1.0.0"]).toBe("provideMarkerLayer");
    expect(pkg.consumedServices["linter.provider"].versions["^1.0.0"]).toBe("consumeLinter");
    expect(pkg.consumedServices["linter.ui"].versions["^1.0.0"]).toBe("consumeLinterUI");
    expect(pkg.consumedServices["linter.adapter"].versions["^1.0.0"]).toBe("consumeLinterAdapter");
  });

  it("has no leftover linter-bundle / lodash / unscoped-fork references in lib", () => {
    const libDir = path.join(root, "lib");
    for (const file of fs.readdirSync(libDir)) {
      if (!/\.js$/.test(file)) continue;
      const src = fs.readFileSync(path.join(libDir, file), "utf8");
      // util.js documents what it replaces, so allow the word "lodash" there.
      const scrubbed = file === "util.js" ? src.replace(/lodash/g, "") : src;
      expect(scrubbed).not.toContain("linter-bundle");
      expect(scrubbed).not.toContain("lodash");
      expect(scrubbed).not.toContain("@asiloisad/select-list");
    }
  });
});
