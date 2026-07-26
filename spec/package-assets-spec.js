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

// Guards for the linter-bundle -> linter rebrand and the CSON -> JSON /
// Less -> CSS modernization. The command prefix, config namespace, and package
// name all move to `linter`; the shared service names stay the same.
describe("linter package assets", () => {
  it("ships keymaps and menus as JSONC, not CSON or plain JSON", () => {
    expect(exists("keymaps/linter.jsonc")).toBe(true);
    expect(exists("menus/linter.jsonc")).toBe(true);
    expect(exists("keymaps/linter-bundle.cson")).toBe(false);
    expect(exists("menus/linter-bundle.cson")).toBe(false);
    expect(exists("keymaps/linter.json")).toBe(false);
    expect(exists("menus/linter.json")).toBe(false);
  });

  it("uses the linter: command prefix in the keymap and menu", () => {
    const keymap = parseJsonc("keymaps/linter.jsonc");
    expect(keymap["atom-workspace"]["alt-l"]).toBe("linter:toggle-focus");

    const menu = parseJsonc("menus/linter.jsonc");
    const flat = JSON.stringify(menu);
    expect(flat).toContain("linter:lint");
    expect(read("menus/linter.jsonc")).not.toContain("linter-bundle:");
    // Menu entries must use the singular `command` key.
    expect(flat).not.toContain('"commands"');
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

  it("is named `linter`, scopes its dependencies, and drops lodash", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("linter");
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toBe("https://github.com/lumine-code/linter");
    expect(pkg.dependencies.lodash).toBeUndefined();
    expect(pkg.dependencies["@lumine-code/etch"]).toBeDefined();
    expect(pkg.dependencies["@lumine-code/select-list"]).toBeDefined();
    expect(pkg.dependencies["@asiloisad/select-list"]).toBeUndefined();
    expect(pkg.dependencies.etch).toBeUndefined();
  });

  it("keeps the shared linter service contract intact", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.providedServices["linter.registry"].versions["1.0.0"]).toBe("provideLinterRegistry");
    expect(pkg.providedServices["intentions.list"].versions["1.0.0"]).toBe("provideIntentionsList");
    expect(pkg.providedServices["mcp.tools"].versions["1.0.0"]).toBe("provideMcpTools");
    expect(pkg.consumedServices["linter.provider"].versions["^1.0.0"]).toBe("consumeLinter");
    expect(pkg.consumedServices["linter.ui"].versions["^1.0.0"]).toBe("consumeLinterUI");
    expect(pkg.consumedServices["linter.adapter"].versions["^1.0.0"]).toBe("consumeLinterAdapter");
  });

  it("has no leftover linter-bundle / lodash / unscoped-fork references in lib", () => {
    const libDir = path.join(root, "lib");
    for (const file of fs.readdirSync(libDir)) {
      if (!file.endsWith(".js")) continue;
      const src = fs.readFileSync(path.join(libDir, file), "utf8");
      // util.js documents what it replaces, so allow the word "lodash" there.
      const scrubbed = file === "util.js" ? src.replace(/lodash/g, "") : src;
      expect(scrubbed).not.toContain("linter-bundle");
      expect(scrubbed).not.toContain("lodash");
      expect(scrubbed).not.toContain("@asiloisad/select-list");
    }
  });
});
