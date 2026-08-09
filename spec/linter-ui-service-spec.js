const Linter = require("../lib/linter-main");
const { getMarkerInvalidation } = require("../lib/helpers");

// Validate.ui() requires didBeginLinting and didFinishLinting of every external
// UI provider and docs/linter.ui.md documents both, so they have to actually be
// dispatched. They were not: nothing subscribed the registry emitter to the
// providers, and every UI in the wild carried two dead stubs.
describe("lib/linter-main linting progress", () => {
  let instance;
  let editor;
  let events;

  const provider = (name) => ({
    name,
    render() {},
    didBeginLinting(event) {
      events.push({ name, phase: "begin", ...event });
    },
    didFinishLinting(event) {
      events.push({ name, phase: "finish", ...event });
    },
    dispose() {},
  });

  const linter = (overrides = {}) => ({
    name: "spec-linter",
    scope: "file",
    lintsOnChange: false,
    grammarScopes: ["*"],
    lint: () => [],
    ...overrides,
  });

  const lintOnce = async () => {
    instance.registryLintersInit();
    await instance.registryLinters.lint({ onChange: false, editor });
  };

  beforeEach(async () => {
    events = [];
    // Linter is constructed directly rather than through the package, so
    // register the schema the way package load would: the registry and the lint
    // path read several of its defaults and throw on undefined.
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    // addLinter lints every open editor when lint-on-open is enabled, which
    // would race a second run against the one each spec triggers.
    lumine.config.set("linter.lintOnOpen", false);
    lumine.config.set("linter.lintOnChange", false);
    editor = await lumine.workspace.open("progress.js");
    instance = new Linter();
  });

  afterEach(() => {
    instance.dispose();
  });

  it("dispatches a paired begin and finish to every registered UI", async () => {
    const first = provider("first");
    const second = provider("second");
    instance.setUIBeginLintingCallback((event) => {
      first.didBeginLinting(event);
      second.didBeginLinting(event);
    });
    instance.setUIFinishLintingCallback((event) => {
      first.didFinishLinting(event);
      second.didFinishLinting(event);
    });
    instance.addLinter(linter());

    await lintOnce();

    expect(events.map((e) => `${e.name}:${e.phase}`)).toEqual([
      "first:begin",
      "second:begin",
      "first:finish",
      "second:finish",
    ]);
  });

  it("carries the documented payload", async () => {
    instance.setUIBeginLintingCallback((event) => events.push({ phase: "begin", ...event }));
    instance.setUIFinishLintingCallback((event) => events.push({ phase: "finish", ...event }));
    instance.addLinter(linter());

    await lintOnce();

    const [begin, finish] = events;
    expect(begin.linter.name).toBe("spec-linter");
    expect(begin.filePath).toBe(editor.getPath());
    expect(typeof begin.number).toBe("number");
    // Paired per run, so a UI can drop a finish whose number is stale.
    expect(finish.number).toBe(begin.number);
  });

  // The doc promises finish always fires. A provider that throws is the case
  // where a spinner would otherwise be left spinning forever.
  it("finishes even when the provider throws", async () => {
    instance.setUIBeginLintingCallback(() => events.push("begin"));
    instance.setUIFinishLintingCallback(() => events.push("finish"));
    instance.addLinter(
      linter({
        lint: () => {
          throw new Error("boom");
        },
      }),
    );
    spyOn(console, "error");

    await lintOnce();

    expect(events).toEqual(["begin", "finish"]);
  });

  it("reports a project-scoped run with no file path", async () => {
    instance.setUIBeginLintingCallback((event) => events.push(event));
    instance.setUIFinishLintingCallback(() => {});
    instance.addLinter(linter({ scope: "project" }));

    await lintOnce();

    expect(events[0].filePath).toBe(null);
  });

  it("renders an indie snapshot synchronously", () => {
    const renders = [];
    instance.setUIRenderCallback((difference) => renders.push(difference));
    const delegate = instance.addIndie({ name: "snapshot-spec" });
    const diagnostic = {
      severity: "hint",
      excerpt: "unused",
      location: {
        file: editor.getPath(),
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };

    delegate.setMessages(editor.getPath(), [diagnostic]);

    expect(renders.length).toBe(1);
    expect(renders[0].added).toEqual([diagnostic]);
    expect(getMarkerInvalidation(diagnostic)).toBe("touch");
  });

  it("carries an indie's marker invalidation strategy into its messages", () => {
    const renders = [];
    instance.setUIRenderCallback((difference) => renders.push(difference));
    const delegate = instance.addIndie({
      name: "snapshot-spec",
      markerInvalidation: "never",
    });
    const diagnostic = {
      severity: "hint",
      excerpt: "unused",
      location: {
        file: editor.getPath(),
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };

    delegate.setMessages(editor.getPath(), [diagnostic]);

    expect(getMarkerInvalidation(renders[0].added[0])).toBe("never");
  });
});
