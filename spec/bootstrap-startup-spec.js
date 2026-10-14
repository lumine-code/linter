const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { createRequire } = require("node:module");

describe("linter bootstrap ownership", () => {
  it("registers commands and empty diagnostics without loading effect runtimes", () => {
    const script = `
const assert = require("node:assert/strict"), Module = require("node:module");
const api = Module.createRequire(${JSON.stringify(require.resolve("lumine"))})("@lumine-code/event-kit");
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === "lumine" ? api : originalLoad.call(this, name, ...args); };
const subscribe = () => new api.Disposable(), commands = [];
let idleId = 0;
global.window = { requestIdleCallback: () => ++idleId, cancelIdleCallback() {} };
global.lumine = {
  config: { observe(key, callback) { callback(key === "linter.disabledProviders" ? [] : false); return subscribe(); } },
  commands: { add(_selector, descriptors) { commands.push(...Object.keys(descriptors)); return subscribe(); } },
  workspace: { observeTextEditors: subscribe, getTextEditors: () => [], getCenter: () => ({ observeActivePaneItem: subscribe }) },
  window: { isDevMode: () => true },
};
const main = require(${JSON.stringify(require.resolve("../lib/main"))});
main.activate();
assert(commands.includes("linter:lint"));
assert(commands.includes("linter:inspect"));
const metadata = require(${JSON.stringify(require.resolve("../lib/message-metadata"))});
assert.equal(typeof metadata.Severities.isValid, "function");
assert.equal(typeof metadata.RegistrationValidation.indie, "function");
assert.equal(Object.keys(metadata).includes("Severities"), false);
assert.equal(Object.keys(metadata).includes("RegistrationValidation"), false);
const linter = main.consumeLinter({ name: "StartupFile", scope: "file", lintsOnChange: true, grammarScopes: ["source.startup"], lint: () => [] });
const delegate = main.provideLinterRegistry()({ name: "Startup" });
let updates = 0;
delegate.onDidUpdate(() => updates++);
delegate.setAllMessages([], { showProjectView: true });
delegate.setMessages("C:/startup/empty.js", []);
assert.equal(updates, 2);
assert.deepEqual(delegate.getMessages(), []);
const markers = main.provideMarkerLayer();
assert.equal(typeof markers.initialize, "function");
assert.equal(typeof markers.getItems, "function");
delegate.dispose();
linter.dispose();
main.deactivate();
for (const filename of ${JSON.stringify(["commands", "linter-main", "linter-ui", "commands-debug", "linter-main-runtime", "linter-ui-runtime", "marker-layer-runtime", "message-registry", "helpers", "validate", "lint-request", "severities", "registration-validation"].map((name) => require.resolve("../lib/" + name)))}) {
  assert.equal(require.cache[filename], undefined, filename + " loaded before a diagnostic operation");
}
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    expect(result.status)
      .withContext(result.stderr || result.error?.message)
      .toBe(0);
  });

  it("preserves compatibility identities and retires every constructor on reload", async () => {
    if (lumine.packages.isPackageLoaded("linter")) await lumine.packages.unloadPackage("linter");
    const first = await lumine.packages.activatePackage("linter");
    const firstRequire = createRequire(path.join(first.path, "package.json"));
    const previous = firstRequire("./lib/bootstrap");
    expect(firstRequire("./lib/linter-main")).toBe(previous.Linter);
    expect(firstRequire("./lib/linter-ui")).toBe(previous.LinterUI);
    expect(firstRequire("./lib/commands").Commands).toBe(previous.Commands);
    expect(firstRequire("./lib/commands").showDebug).toBe(previous.showDebug);
    const metadata = firstRequire("./lib/message-metadata");
    expect(firstRequire("./lib/severities")).toBe(metadata.Severities);
    expect(firstRequire("./lib/registration-validation")).toBe(metadata.RegistrationValidation);
    await lumine.packages.unloadPackage("linter");
    const fresh = await lumine.packages.activatePackage("linter");
    const currentRequire = createRequire(path.join(fresh.path, "package.json"));
    const current = currentRequire("./lib/bootstrap");
    for (const name of ["Linter", "LinterUI", "Commands", "showDebug"])
      expect(current[name]).not.toBe(previous[name]);
    expect(currentRequire("./lib/linter-main")).toBe(current.Linter);
    expect(currentRequire("./lib/linter-ui")).toBe(current.LinterUI);
    expect(currentRequire("./lib/commands").Commands).toBe(current.Commands);
    const currentMetadata = currentRequire("./lib/message-metadata");
    expect(currentRequire("./lib/severities")).toBe(currentMetadata.Severities);
    expect(currentRequire("./lib/registration-validation")).toBe(
      currentMetadata.RegistrationValidation,
    );
    expect(currentMetadata.Severities).not.toBe(metadata.Severities);
    expect(currentMetadata.RegistrationValidation).not.toBe(metadata.RegistrationValidation);
    await lumine.packages.unloadPackage("linter");
  });
});
