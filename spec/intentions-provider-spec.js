const { createIntentionsProvider } = require("../lib/intentions-provider");
const { normalizeMessages } = require("../lib/helpers");

describe("lib/intentions-provider", () => {
  const filePath = process.platform === "win32" ? "C:\\tmp\\example.js" : "/tmp/example.js";
  let editor;
  let messages;
  let provider;

  beforeEach(() => {
    editor = lumine.workspace.buildTextEditor();
    editor.getBuffer().setPath(filePath);
    editor.setText("const foo = 1;\n");
    messages = [];
    provider = createIntentionsProvider(() => messages);
  });

  afterEach(() => {
    editor.destroy();
  });

  // Normalized on the way in, as the registry does: nothing reaches a consumer
  // of linter messages without passing through it, and the path each message
  // is matched on is one of the things it settles.
  function addMessage(solutions, { file = filePath, position } = {}) {
    const message = {
      severity: "warning",
      excerpt: "Prefer bar over foo",
      location: {
        file,
        position: position || [
          [0, 6],
          [0, 9],
        ],
      },
      solutions,
    };
    normalizeMessages("spec", [message]);
    messages.push(message);
  }

  it("declares the wildcard grammar scope", () => {
    expect(provider.grammarScopes).toEqual(["*"]);
  });

  it("maps a replaceWith solution to an intention that applies the fix", async () => {
    addMessage([
      {
        title: "Rename to bar",
        position: [
          [0, 6],
          [0, 9],
        ],
        currentText: "foo",
        replaceWith: "bar",
      },
    ]);

    const intentions = await provider.getIntentions({ textEditor: editor, bufferPosition: [0, 7] });
    expect(intentions.length).toBe(1);
    expect(intentions[0].icon).toBe("tools");
    expect(intentions[0].title).toBe("Rename to bar");
    expect(intentions[0].priority).toBe(50);

    await intentions[0].selected();
    expect(editor.getText()).toBe("const bar = 1;\n");
  });

  it("falls back to the message excerpt for an untitled solution", async () => {
    addMessage([
      {
        position: [
          [0, 6],
          [0, 9],
        ],
        replaceWith: "bar",
      },
    ]);

    const intentions = await provider.getIntentions({ textEditor: editor, bufferPosition: [0, 6] });
    expect(intentions.length).toBe(1);
    expect(intentions[0].title).toBe("Fix: Prefer bar over foo");
  });

  it("skips a replace solution silently when currentText no longer matches", async () => {
    addMessage([
      {
        title: "Rename to bar",
        position: [
          [0, 6],
          [0, 9],
        ],
        currentText: "stale",
        replaceWith: "bar",
      },
    ]);

    const intentions = await provider.getIntentions({ textEditor: editor, bufferPosition: [0, 7] });
    expect(intentions.length).toBe(1);
    await intentions[0].selected();
    expect(editor.getText()).toBe("const foo = 1;\n");
  });

  it("runs callback solutions through their apply()", async () => {
    const apply = jasmine.createSpy("apply");
    addMessage([
      {
        title: "Run the fixer",
        position: [
          [0, 6],
          [0, 9],
        ],
        apply,
      },
    ]);

    const intentions = await provider.getIntentions({ textEditor: editor, bufferPosition: [0, 8] });
    expect(intentions.length).toBe(1);
    await intentions[0].selected();
    expect(apply).toHaveBeenCalled();
  });

  it("awaits promised solutions", async () => {
    addMessage(
      Promise.resolve([
        {
          title: "Rename to bar",
          position: [
            [0, 6],
            [0, 9],
          ],
          replaceWith: "bar",
        },
      ]),
    );

    const intentions = await provider.getIntentions({ textEditor: editor, bufferPosition: [0, 7] });
    expect(intentions.length).toBe(1);
    await intentions[0].selected();
    expect(editor.getText()).toBe("const bar = 1;\n");
  });

  it("ignores messages without solutions, outside the cursor, or from other files", async () => {
    addMessage(undefined);
    addMessage(
      [
        {
          position: [
            [1, 0],
            [1, 1],
          ],
          replaceWith: "x",
        },
      ],
      {
        position: [
          [1, 0],
          [1, 5],
        ],
      },
    );
    addMessage(
      [
        {
          position: [
            [0, 6],
            [0, 9],
          ],
          replaceWith: "x",
        },
      ],
      { file: "/somewhere/else.js" },
    );

    const intentions = await provider.getIntentions({ textEditor: editor, bufferPosition: [0, 7] });
    expect(intentions).toEqual([]);
  });

  it("does not offer a file's messages in an editor that has no path", async () => {
    const pathless = lumine.workspace.buildTextEditor();
    addMessage([
      {
        position: [
          [0, 6],
          [0, 9],
        ],
        replaceWith: "bar",
      },
    ]);
    expect(await provider.getIntentions({ textEditor: pathless, bufferPosition: [0, 7] })).toEqual(
      [],
    );
    pathless.destroy();
  });

  // A buffer that has never been saved has no path for a message to name, so
  // its messages name the buffer and are matched on that instead.
  it("offers a buffer-located message in the editor holding that buffer", async () => {
    const pathless = lumine.workspace.buildTextEditor();
    pathless.setText("const foo = 1;\n");
    messages.push({
      severity: "warning",
      excerpt: "Prefer bar over foo",
      location: {
        buffer: pathless.getBuffer(),
        position: [
          [0, 6],
          [0, 9],
        ],
      },
      solutions: [
        {
          title: "Rename to bar",
          position: [
            [0, 6],
            [0, 9],
          ],
          replaceWith: "bar",
        },
      ],
    });

    const intentions = await provider.getIntentions({
      textEditor: pathless,
      bufferPosition: [0, 7],
    });
    expect(intentions.length).toBe(1);

    await intentions[0].selected();
    expect(pathless.getText()).toBe("const bar = 1;\n");
    pathless.destroy();
  });

  it("does not offer another buffer's messages", async () => {
    const one = lumine.workspace.buildTextEditor();
    const two = lumine.workspace.buildTextEditor();
    two.setText("const foo = 1;\n");
    messages.push({
      severity: "warning",
      excerpt: "Prefer bar over foo",
      location: {
        buffer: one.getBuffer(),
        position: [
          [0, 6],
          [0, 9],
        ],
      },
      solutions: [
        {
          position: [
            [0, 6],
            [0, 9],
          ],
          replaceWith: "bar",
        },
      ],
    });

    expect(await provider.getIntentions({ textEditor: two, bufferPosition: [0, 7] })).toEqual([]);
    one.destroy();
    two.destroy();
  });
});
