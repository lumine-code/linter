const LinterUI = require("../lib/linter-ui");
const { normalizeMessages } = require("../lib/helpers");
const { createHoverProvider } = require("../lib/hover-provider");

// The tooltip itself belongs to the hover package; what this package owes it is
// an answer about a position or a row, and an element to put on its surface.
describe("lib/hover-provider", () => {
  let ui;
  let editor;
  let buffer;
  let provider;

  beforeEach(() => {
    editor = lumine.workspace.buildTextEditor();
    editor.setText("const unused = 1;\nlegacy();\n");
    buffer = editor.getBuffer();
    ui = new LinterUI();
    ui.patchEditor(editor);
    ui.setActiveItem(editor);
    provider = createHoverProvider();
    lumine.config.set("linter.showHoverTooltip", true);
  });

  afterEach(() => {
    ui?.dispose();
    ui = null;
  });

  const message = (overrides = {}) => ({
    severity: "warning",
    excerpt: "unused variable",
    linterName: "spec-linter",
    location: {
      file: "/spec.js",
      buffer,
      position: [
        [0, 6],
        [0, 12],
      ],
    },
    ...overrides,
  });

  const publish = (messages) => {
    normalizeMessages("spec", messages);
    ui.render({ added: messages, removed: [], messages });
  };

  describe("hover", () => {
    it("answers with the messages covering the position, most severe first", () => {
      publish([
        message(),
        message({
          severity: "error",
          excerpt: "assigned but never read",
          linterName: "other-linter",
        }),
      ]);

      const answer = provider.hover(editor, { row: 0, column: 8 });
      const items = answer.contents.element.querySelectorAll(".linter-hover-item");
      expect(items.length).toBe(2);
      expect(items[0].classList).toContain("error");
      expect(items[0].querySelector(".linter-hover-excerpt").textContent).toContain(
        "assigned but never read",
      );
      expect(items[1].classList).toContain("warning");
      expect(items[1].querySelector(".linter-hover-source").textContent).toBe("spec-linter");
      // The narrowest span they agree on is what the tooltip watches to know
      // the pointer has left the thing being described.
      expect(
        answer.range.isEqual([
          [0, 6],
          [0, 12],
        ]),
      ).toBe(true);
    });

    it("declines where there is nothing to report", () => {
      publish([message()]);
      expect(provider.hover(editor, { row: 0, column: 0 })).toBe(null);
      expect(provider.hover(editor, { row: 1, column: 2 })).toBe(null);
    });

    it("declines while the setting is off", () => {
      publish([message()]);
      lumine.config.set("linter.showHoverTooltip", false);
      expect(provider.hover(editor, { row: 0, column: 8 })).toBe(null);
      expect(provider.hoverGutter(editor, 0)).toBe(null);
    });

    it("says where a message came from, and what it is called there", () => {
      publish([message({ linterName: "ruff language server", description: "Ruff: F401" })]);

      const answer = provider.hover(editor, { row: 0, column: 8 });
      const meta = answer.contents.element.querySelector(".linter-hover-meta");
      expect(meta.querySelector(".linter-hover-source").textContent).toBe("ruff language server");
      // The long form opens with the name of the tool that produced it, which
      // the line has already said.
      expect(meta.querySelector(".linter-hover-detail").textContent).toBe("F401");
    });

    it("leaves a long form alone when it is not repeating the source", () => {
      publish([message({ linterName: "pyflakes", description: "see PEP 8: line too long" })]);

      const answer = provider.hover(editor, { row: 0, column: 8 });
      expect(answer.contents.element.querySelector(".linter-hover-detail").textContent).toBe(
        "see PEP 8: line too long",
      );
    });

    it("fills a long form that only resolves when it is asked for", async () => {
      const description = jasmine.createSpy("description").and.resolveTo("no-unused-vars");
      publish([message({ description })]);

      const answer = provider.hover(editor, { row: 0, column: 8 });
      const detail = answer.contents.element.querySelector(".linter-hover-detail");
      expect(detail.textContent).toBe("");

      // Only an element still in the document is written to: a tooltip
      // dismissed while the provider was thinking has taken its own away.
      jasmine.attachToDOM(answer.contents.element);
      await description.calls.mostRecent().returnValue;
      await Promise.resolve();
      expect(detail.textContent).toBe("no-unused-vars");
    });
  });

  describe("hoverGutter", () => {
    it("collects everything on the row, whatever column it starts at", () => {
      publish([
        message(),
        message({
          severity: "error",
          excerpt: "later on the same line",
          location: {
            file: "/spec.js",
            buffer,
            position: [
              [0, 15],
              [0, 17],
            ],
          },
        }),
      ]);

      const answer = provider.hoverGutter(editor, 0);
      expect(answer.contents.element.querySelectorAll(".linter-hover-item").length).toBe(2);
      // No range: the answer is about the row, and the tooltip stands for all
      // of it rather than for the columns the messages happen to cover.
      expect(answer.range).toBeUndefined();

      expect(provider.hoverGutter(editor, 1)).toBe(null);
    });
  });
});
