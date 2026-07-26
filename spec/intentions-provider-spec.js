const { createIntentionsProvider } = require("../lib/intentions-provider");

describe("lib/intentions-provider", () => {
  const filePath = process.platform === "win32" ? "C:\\tmp\\example.js" : "/tmp/example.js";
  let editor;
  let messages;
  let provider;

  beforeEach(() => {
    editor = atom.workspace.buildTextEditor();
    editor.getBuffer().setPath(filePath);
    editor.setText("const foo = 1;\n");
    messages = [];
    provider = createIntentionsProvider(() => messages);
  });

  afterEach(() => {
    editor.destroy();
  });

  function addMessage(solutions, { file = filePath, position } = {}) {
    messages.push({
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
    });
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

  it("returns nothing for editors without a file path", async () => {
    const pathless = atom.workspace.buildTextEditor();
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
});
