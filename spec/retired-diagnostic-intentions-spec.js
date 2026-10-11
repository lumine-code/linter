const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Quick fixes belonging to withdrawn diagnostics", () => {
  let editor, indie, intentions, leases, scratch, file;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      if (!jasmine.isSpy(lumine.shell[method])) spyOn(lumine.shell, method).and.resolveTo();
    if (!jasmine.isSpy(lumine.application.openWindow))
      spyOn(lumine.application, "openWindow").and.resolveTo();
    lumine.config.set("linter.lintOnOpen", false);
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-fixes-")));
    file = path.join(scratch, "source.txt");
    fs.writeFileSync(file, "foo\n");
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("linter");
    editor = await lumine.workspace.open(file);
    leases = [];
    leases.push(
      lumine.packages.serviceHub.consume("linter.registry", "^1.0.0", (register) => {
        indie = register({ name: "Owned diagnostic fixes" });
      }),
      lumine.packages.serviceHub.consume("intentions.list", "^1.0.0", (provider) => {
        intentions = provider;
      }),
    );
  });

  afterEach(async () => {
    indie?.dispose();
    for (const lease of leases || []) lease.dispose();
    await lumine.packages.deactivatePackage("linter");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), scratch);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Refusing cleanup outside the owned quick-fix fixture");
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    lumine.config.unset("linter.lintOnOpen");
  });

  const solution = () => ({
    position: [
      [0, 0],
      [0, 3],
    ],
    replaceWith: "bar",
  });

  function publish(solutions) {
    indie.setMessages(file, [
      {
        severity: "warning",
        excerpt: "Replace foo",
        location: {
          file,
          position: [
            [0, 0],
            [0, 3],
          ],
        },
        solutions,
      },
    ]);
  }

  const request = () => intentions.getIntentions({ textEditor: editor, bufferPosition: [0, 1] });

  it("discards promised fixes when their provider is disposed", async () => {
    let resolve;
    publish(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = request();
    indie.dispose();
    resolve([solution()]);
    expect(await pending).toEqual([]);
    expect(editor.getText()).toBe("foo\n");
  });

  it("does not apply an offered fix after its diagnostic is cleared", async () => {
    publish([solution()]);
    const actions = await request();
    expect(actions.length).toBe(1);
    indie.setMessages(file, []);
    await actions[0].selected();
    expect(editor.getText()).toBe("foo\n");
  });

  it("discards promised fixes from a deactivated package generation", async () => {
    let resolve;
    publish(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = request();
    await lumine.packages.deactivatePackage("linter");
    resolve([solution()]);
    expect(await pending).toEqual([]);
    expect(editor.getText()).toBe("foo\n");
  });

  it("applies a current ordinary replacement", async () => {
    publish([solution()]);
    const actions = await request();
    await actions[0].selected();
    expect(editor.getText()).toBe("bar\n");
  });

  it("applies a promised replacement while its diagnostic remains current", async () => {
    publish(Promise.resolve([solution()]));
    const actions = await request();
    expect(actions.length).toBe(1);
    await actions[0].selected();
    expect(editor.getText()).toBe("bar\n");
  });
});
