const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

beforeEach(() => {
  for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
    spyOn(lumine.shell, method).and.resolveTo();
  spyOn(lumine.application, "openWindow").and.resolveTo();
});

describe("Diagnostics addressed by buffer and file", () => {
  let main, editor, file, scratch, provider, hub, uiLease;

  beforeEach(async () => {
    lumine.config.set("linter.lintOnOpen", false);
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mixed-diagnostics-")));
    file = path.join(scratch, "source.txt");
    fs.writeFileSync(file, "buffer file\n");
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("linter")).mainModule;
    editor = await lumine.workspace.open(file);
    provider = main.provideLinterRegistry()({ name: "Mixed Locations" });
    uiLease = main.consumeLinterUI({
      name: "Mixed Location Reader",
      attach: (value) => {
        hub = value;
      },
    });
  });

  afterEach(async () => {
    uiLease.dispose();
    provider.dispose();
    await lumine.packages.deactivatePackage("linter");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    const resolved = fs.realpathSync.native(scratch);
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), resolved);
    if (resolved !== scratch || !relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Refusing cleanup outside the owned diagnostic fixture");
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    lumine.config.unset("linter.lintOnOpen");
  });

  function bufferMessage() {
    return {
      severity: "warning",
      excerpt: "Buffer diagnostic",
      location: {
        buffer: editor.getBuffer(),
        position: [
          [0, 0],
          [0, 3],
        ],
      },
    };
  }

  function fileMessage() {
    return {
      severity: "error",
      excerpt: "File diagnostic",
      location: {
        file,
        position: [
          [0, 4],
          [0, 8],
        ],
      },
    };
  }

  it("shows both subjects in the active editor and the default MCP read", () => {
    provider.setMessages(file, [bufferMessage(), fileMessage()]);
    expect(hub.getMessages().length).toBe(2);
    expect(main.provideMcpTools()[0].execute({ filePath: file }).messages.length).toBe(2);
    expect(hub.getCurrentMessages().map((message) => message.excerpt)).toEqual([
      "Buffer diagnostic",
      "File diagnostic",
    ]);
    expect(main.provideMcpTools()[0].execute().messages.length).toBe(2);
    const help = main.provideContextHelp().getHelp(editor, [0, 5]);
    expect(help).not.toBeNull();
    if (help) expect(help.contents.render().textContent).toContain("File diagnostic");
  });

  it("keeps ordinary path-only diagnostics visible", () => {
    provider.setMessages(file, [fileMessage()]);
    expect(hub.getCurrentMessages().map((message) => message.excerpt)).toEqual(["File diagnostic"]);
    expect(main.provideMcpTools()[0].execute().messages.length).toBe(1);
  });

  it("keeps buffer-only diagnostics visible", () => {
    provider.setMessages(file, [bufferMessage()]);
    expect(hub.getCurrentMessages().map((message) => message.excerpt)).toEqual([
      "Buffer diagnostic",
    ]);
    expect(main.provideMcpTools()[0].execute().messages.length).toBe(1);
  });

  it("updates and removes both location kinds through ordinary provider publications", () => {
    const direct = bufferMessage();
    const named = fileMessage();
    provider.setMessages(file, [direct]);
    provider.setMessages(file, [direct, named]);
    expect(hub.getCurrentMessages().length).toBe(2);
    provider.setMessages(file, [named]);
    expect(hub.getCurrentMessages().map((message) => message.excerpt)).toEqual(["File diagnostic"]);
    expect(main.provideContextHelp().getHelp(editor, [0, 1])).toBeNull();
    provider.setMessages(file, []);
    expect(hub.getCurrentMessages()).toEqual([]);
    expect(main.provideContextHelp().getHelp(editor, [0, 5])).toBeNull();
  });
});
