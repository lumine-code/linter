const LinterUI = require("../lib/linter-ui");
const { normalizeMessages } = require("../lib/helpers");
const { createContextHelpProvider, messagesAtPosition } = require("../lib/context-help-provider");

// Tooltips and panels share the answer; each surface renders its own element.
describe("lib/context-help-provider", () => {
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
    provider = createContextHelpProvider();
    lumine.config.set("linter.showContextHelp", true);
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

  describe("getHelp", () => {
    it("defers custom content until rendering and creates a fresh element for each surface", () => {
      const description = jasmine.createSpy("description").and.resolveTo("no-unused-vars");
      publish([message({ description })]);

      const answer = provider.getHelp(editor, { row: 0, column: 8 });
      expect(description).not.toHaveBeenCalled();
      expect(answer.contents.element).toBeUndefined();

      const tooltip = answer.contents.render();
      const panel = answer.contents.render();
      expect(tooltip).not.toBe(panel);
      expect(tooltip.querySelector(".linter-hover-item")).not.toBe(
        panel.querySelector(".linter-hover-item"),
      );
      expect(tooltip.textContent).toBe(panel.textContent);
      expect(description).toHaveBeenCalled();
    });

    it("declines cancelled requests for text and gutter help", () => {
      publish([message()]);
      const controller = new AbortController();
      controller.abort();

      expect(
        provider.getHelp(editor, { row: 0, column: 8 }, { signal: controller.signal }),
      ).toBeNull();
      expect(provider.getGutterHelp(editor, 0, { signal: controller.signal })).toBeNull();
    });

    it("answers with the messages covering the position, most severe first", () => {
      publish([
        message(),
        message({
          severity: "error",
          excerpt: "assigned but never read",
          linterName: "other-linter",
        }),
      ]);

      const answer = provider.getHelp(editor, { row: 0, column: 8 });
      const items = answer.contents.render().querySelectorAll(".linter-hover-item");
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
      expect(provider.getHelp(editor, { row: 0, column: 0 })).toBe(null);
      expect(provider.getHelp(editor, { row: 1, column: 2 })).toBe(null);
    });

    it("follows a diagnostic shifted by an edit before it", () => {
      publish([message()]);

      editor.setTextInBufferRange(
        [
          [0, 0],
          [0, 0],
        ],
        "prefix\n",
      );

      expect(provider.getHelp(editor, { row: 0, column: 8 })).toBe(null);
      expect(provider.getHelp(editor, { row: 1, column: 8 })).not.toBe(null);
    });

    it("finds later diagnostics after earlier lines are deleted", () => {
      editor.setText(Array(40).fill("const unused = 1;").join("\n"));
      const messages = [20, 30].map((row) =>
        message({
          excerpt: `row ${row}`,
          location: {
            file: "/spec.js",
            buffer,
            position: [
              [row, 6],
              [row, 12],
            ],
          },
        }),
      );
      normalizeMessages("spec", messages, { markerInvalidation: "never" });
      ui.render({ added: messages, removed: [], messages });

      buffer.deleteRows(0, 14);

      const answer = provider.getHelp(editor, { row: 15, column: 8 });
      expect(answer).not.toBe(null);
      expect(
        answer.contents.render().querySelector(".linter-hover-excerpt").textContent.trim(),
      ).toBe("row 30");
    });

    it("reads only nearby diagnostic ranges when hovering near the end of a file", () => {
      editor.setText(Array(200).fill("const unused = 1;").join("\n"));
      const messages = Array.from({ length: 200 }, (_, row) =>
        message({
          excerpt: `row ${row}`,
          location: {
            file: "/spec.js",
            buffer,
            position: [
              [row, 6],
              [row, 12],
            ],
          },
        }),
      );
      publish(messages);
      const reads = messages.map((entry) =>
        spyOnProperty(entry.location, "displayRange", "get").and.callThrough(),
      );

      const answer = provider.getHelp(editor, { row: 199, column: 8 });

      expect(answer.contents.render().querySelectorAll(".linter-hover-item").length).toBe(1);
      expect(reads.slice(0, -1).every((read) => read.calls.count() === 0)).toBe(true);
    });

    it("shows a tagged diagnostic once despite its additional decoration markers", () => {
      publish([message({ tags: ["unnecessary", "deprecated"] })]);

      const answer = provider.getHelp(editor, { row: 0, column: 8 });

      expect(answer.contents.render().querySelectorAll(".linter-hover-item").length).toBe(1);
    });

    it("returns fresh metadata when its standing diagnostic key is unchanged", () => {
      const original = message();
      publish([original]);
      const replacement = message({
        solutions: [
          {
            title: "Use the value",
            position: [
              [0, 6],
              [0, 12],
            ],
            replaceWith: "used",
          },
        ],
      });
      normalizeMessages("spec", [replacement]);
      expect(replacement.key).toBe(original.key);

      ui.render({ added: [], removed: [], updated: [replacement], messages: [replacement] });

      expect(messagesAtPosition(buffer, { row: 0, column: 8 })[0]).toBe(replacement);
    });

    it("declines while the setting is off", () => {
      publish([message()]);
      lumine.config.set("linter.showContextHelp", false);
      expect(provider.getHelp(editor, { row: 0, column: 8 })).toBe(null);
      expect(provider.getGutterHelp(editor, 0)).toBe(null);
    });

    it("says where a message came from, and what it is called there", () => {
      publish([message({ linterName: "ruff language server", description: "Ruff: F401" })]);

      const answer = provider.getHelp(editor, { row: 0, column: 8 });
      const meta = answer.contents.render().querySelector(".linter-hover-meta");
      expect(meta.querySelector(".linter-hover-source").textContent).toBe("ruff language server");
      // The long form opens with the name of the tool that produced it, which
      // the line has already said.
      expect(meta.querySelector(".linter-hover-detail").textContent).toBe("F401");
    });

    it("leaves a long form alone when it is not repeating the source", () => {
      publish([message({ linterName: "pyflakes", description: "see PEP 8: line too long" })]);

      const answer = provider.getHelp(editor, { row: 0, column: 8 });
      expect(answer.contents.render().querySelector(".linter-hover-detail").textContent).toBe(
        "see PEP 8: line too long",
      );
    });

    it("fills a long form that only resolves when it is asked for", async () => {
      const description = jasmine.createSpy("description").and.resolveTo("no-unused-vars");
      publish([message({ description })]);

      const answer = provider.getHelp(editor, { row: 0, column: 8 });
      const element = answer.contents.render();
      const detail = element.querySelector(".linter-hover-detail");
      expect(detail.textContent).toBe("");

      // Only an element still in the document is written to: a tooltip
      // dismissed while the provider was thinking has taken its own away.
      jasmine.attachToDOM(element);
      await description.calls.mostRecent().returnValue;
      await Promise.resolve();
      expect(detail.textContent).toBe("no-unused-vars");
    });
  });

  describe("getGutterHelp", () => {
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

      const answer = provider.getGutterHelp(editor, 0);
      expect(answer.contents.render().querySelectorAll(".linter-hover-item").length).toBe(2);
      // No range: the answer is about the row, and the tooltip stands for all
      // of it rather than for the columns the messages happen to cover.
      expect(answer.range).toBeUndefined();

      expect(provider.getGutterHelp(editor, 1)).toBe(null);
    });
  });
});
