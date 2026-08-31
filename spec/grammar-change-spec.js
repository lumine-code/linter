const Main = require("../lib/main");

describe("grammar changes", () => {
  let disposables;
  let editor;
  let finishes;
  let renders;

  const diagnosticFor = (target, excerpt = "old grammar") => ({
    severity: "warning",
    excerpt,
    location: {
      buffer: target.getBuffer(),
      position: [
        [0, 0],
        [0, 4],
      ],
    },
  });

  const register = (provider) => {
    disposables.push(Main.consumeLinter(provider));
    disposables.push(Main.provideLinterEditors()(editor));
  };

  const changeToJavaScript = () => {
    const grammar = lumine.grammars.grammarForScopeName("source.js");
    expect(grammar).toBeDefined();
    editor.setGrammar(grammar);
  };

  beforeEach(async () => {
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    lumine.config.set("linter.lintOnOpen", true);
    // A grammar change is structural, not an edit, and must run providers even
    // when lint-on-change is disabled globally and by the provider.
    lumine.config.set("linter.lintOnChange", false);
    await lumine.packages.activatePackage("language-javascript");

    disposables = [];
    finishes = [];
    renders = [];
    Main.activate();
    disposables.push(
      Main.consumeLinterUI({
        name: "grammar-change-spec-ui",
        render: (difference) => renders.push(difference),
        didBeginLinting() {},
        didFinishLinting: (event) => finishes.push(event),
        dispose() {},
      }),
    );
    editor = lumine.workspace.buildTextEditor();
    editor.setText("word\n");
  });

  afterEach(() => {
    for (const disposable of disposables.reverse()) disposable.dispose();
    if (!editor.isDestroyed()) editor.destroy();
    Main.deactivate();
  });

  it("re-lints a wildcard provider under the new grammar", async () => {
    const lintedScopes = [];
    register({
      name: "grammar-wildcard-spec",
      scope: "file",
      lintsOnChange: false,
      grammarScopes: ["*"],
      lint(target) {
        const scope = target.getGrammar().scopeName;
        lintedScopes.push(scope);
        return scope === "source.js" ? [] : [diagnosticFor(target)];
      },
    });
    await conditionPromise(() => renders.some((change) => change.added.length === 1));

    changeToJavaScript();

    await conditionPromise(() => lintedScopes.includes("source.js"));
    await conditionPromise(() => renders.some((change) => change.removed.length === 1));
    expect(lintedScopes.length).toBe(2);
  });

  it("retracts a file provider that no longer matches", async () => {
    const initialScope = editor.getGrammar().scopeName;
    let lintCount = 0;
    register({
      name: "grammar-scoped-spec",
      scope: "file",
      lintsOnChange: false,
      grammarScopes: [initialScope],
      lint(target) {
        lintCount++;
        return [diagnosticFor(target)];
      },
    });
    await conditionPromise(() => renders.some((change) => change.added.length === 1));

    changeToJavaScript();

    await conditionPromise(() => renders.some((change) => change.removed.length === 1));
    expect(lintCount).toBe(1);
  });

  it("drops a pending result from the old grammar", async () => {
    const initialScope = editor.getGrammar().scopeName;
    let resolveLint;
    register({
      name: "grammar-pending-spec",
      scope: "file",
      lintsOnChange: false,
      grammarScopes: [initialScope],
      lint() {
        return new Promise((resolve) => {
          resolveLint = resolve;
        });
      },
    });
    await conditionPromise(() => typeof resolveLint === "function");

    changeToJavaScript();
    resolveLint([diagnosticFor(editor)]);

    await conditionPromise(() =>
      finishes.some((event) => event.linter.name === "grammar-pending-spec"),
    );
    expect(renders.some((change) => change.added.length > 0)).toBe(false);
  });
});
