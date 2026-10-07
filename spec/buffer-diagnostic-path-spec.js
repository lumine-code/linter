const path = require("node:path");
const { TextBuffer } = require("lumine");

describe("buffer diagnostic paths across lint and MCP services", () => {
  let Main;
  let buffers;
  let editors;
  let disposables;
  let hub;
  let provider;
  const filePath = path.join(__dirname, "buffer-diagnostic.py");
  const diagnostic = (buffer) => ({
    severity: "warning",
    excerpt: "fresh buffer diagnostic",
    location: {
      buffer,
      position: [
        [0, 0],
        [0, 1],
      ],
    },
  });
  const namedBuffer = () => {
    const buffer = new TextBuffer({ text: "word\n", filePath });
    buffers.push(buffer);
    return buffer;
  };
  const read = (args) => Main.provideMcpTools()[0].execute(args);

  beforeEach(() => {
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    lumine.config.set("linter.lintOnOpen", false);
    lumine.config.set("linter.lintOnChange", false);
    Main = require("../lib/main");
    Main.activate();
    buffers = [];
    editors = [];
    disposables = [
      Main.consumeLinterUI({
        name: "buffer-path-spec",
        attach: (value) => {
          hub = value;
        },
      }),
    ];
    provider = {
      name: "buffer-path-spec",
      scope: "file",
      grammarScopes: ["*"],
      lintsOnChange: false,
      lint: (editor) => [diagnostic(editor.getBuffer())],
    };
    disposables.push(Main.consumeLinter(provider));
  });

  afterEach(async () => {
    for (const disposable of disposables.reverse()) disposable.dispose();
    for (const editor of editors) if (!editor.isDestroyed()) editor.destroy();
    for (const buffer of buffers) if (!buffer.isDestroyed()) buffer.destroy();
    Main.deactivate();
    await Promise.allSettled(buffers.map((buffer) => buffer.fileWatchStartPromise));
  });

  it("returns freshly linted named-buffer diagnostics through an MCP filePath filter", async () => {
    const buffer = namedBuffer();
    expect(await Main.provideLinterLint().lintBuffer(buffer)).toBeTrue();
    const result = read({ filePath });
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]?.file).toBe(filePath);
    expect(result.messages[0]?.excerpt).toBe("fresh buffer diagnostic");
    const message = hub.getMessages()[0];
    expect(message.location.buffer).toBe(buffer);
    expect(message.location.file).toBeUndefined();
    expect(message.location.normalizedFile).toBe(hub.normalizePath(filePath));
  });

  it("keeps an explicit provider path authoritative over the buffer's own path", async () => {
    const buffer = namedBuffer();
    const explicit = path.join(__dirname, "explicit-diagnostic.py");
    provider.lint = (editor) => {
      const message = diagnostic(editor.getBuffer());
      message.location.file = explicit;
      return [message];
    };
    expect(await Main.provideLinterLint().lintBuffer(buffer)).toBeTrue();
    expect(read({ filePath }).messages).toEqual([]);
    const result = read({ filePath: explicit });
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].file).toBe(explicit);
    expect(hub.getMessages()[0].location.buffer).toBe(buffer);
    expect(hub.getMessages()[0].location.file).toBe(explicit);
  });

  it("follows a renamed buffer without turning its inferred path into an explicit one", async () => {
    const buffer = namedBuffer();
    let message;
    provider.lint = (editor) => [(message ||= diagnostic(editor.getBuffer()))];
    expect(await Main.provideLinterLint().lintBuffer(buffer)).toBeTrue();
    const renamed = path.join(__dirname, "renamed-diagnostic.py");
    buffer.setPath(renamed);
    expect(read({ filePath }).messages).toEqual([]);
    expect(read({ filePath: renamed }).messages.map((entry) => entry.file)).toEqual([renamed]);
    expect(await Main.provideLinterLint().lintBuffer(buffer)).toBeTrue();
    expect(message.location.file).toBeUndefined();
    expect(message.location.buffer).toBe(buffer);
    expect(message.location.normalizedFile).toBe(hub.normalizePath(renamed));
    expect(read({ filePath }).messages).toEqual([]);
    expect(read({ filePath: renamed }).messages.map((entry) => entry.file)).toEqual([renamed]);
  });

  it("keeps unsaved editor diagnostics buffer-owned and without a made-up filename", async () => {
    const editor = await lumine.workspace.open();
    editors.push(editor);
    editor.setText("word");
    expect(await Main.provideLinterLint().lintEditor(editor)).toBeTrue();
    const message = hub.getMessages()[0];
    expect(message.location.buffer).toBe(editor.getBuffer());
    expect(message.location.file).toBeUndefined();
    expect(message.location.normalizedFile).toBeNull();
    expect(read({ scope: "project" }).messages[0].file).toBeNull();
    expect(read({ filePath }).messages).toEqual([]);
  });
});
