const main = require("../lib/main");

// The handle is the whole of what a UI can ask the hub. Its members exist
// because a message change cannot answer them: which messages belong to the
// item on screen, where one is, what the severity tiers are.
describe("the linter.ui handle", () => {
  let attached;

  const ui = (overrides = {}) => ({
    name: "spec-ui",
    attach: (handle) => attached.push(handle),
    ...overrides,
  });

  beforeEach(() => {
    attached = [];
    // main.js is the package's main module, so it is activated the way package
    // load would rather than reached into.
    lumine.config.setSchema("linter", {
      type: "object",
      properties: require("../package.json").configSchema,
    });
    lumine.config.set("linter.lintOnOpen", false);
    main.activate();
  });

  afterEach(() => {
    main.deactivate();
  });

  it("hands a UI the handle when it registers, before anything is rendered", () => {
    main.consumeLinterUI(ui());
    expect(attached.length).toBe(1);
  });

  it("gives every UI the same frozen handle", () => {
    main.consumeLinterUI(ui());
    main.consumeLinterUI(ui({ name: "second" }));

    const [first, second] = attached;
    expect(first).toBe(second);
    // Frozen, so one UI cannot reshape what the next one is handed.
    expect(Object.isFrozen(first)).toBe(true);
    const original = first.getMessages;
    first.getMessages = null;
    expect(first.getMessages).toBe(original);
  });

  it("answers with the severity model rather than making a UI hardcode it", () => {
    main.consumeLinterUI(ui());
    const severities = attached[0].getSeverities();

    expect(severities.map((severity) => severity.name)).toEqual([
      "error",
      "warning",
      "info",
      "hint",
    ]);
    // Every field the two surfaces render.
    expect(severities[0]).toEqual(
      jasmine.objectContaining({ label: "Error", icon: "icon-stop", textClass: "text-error" }),
    );
  });

  it("answers about messages before anything has been published", () => {
    main.consumeLinterUI(ui());
    const hub = attached[0];

    expect(hub.getMessages()).toEqual([]);
    expect(hub.getCurrentMessages()).toEqual([]);
    expect(hub.getCursorEditor()).toBe(null);
  });

  // A UI cannot watch the workspace for this itself. The hub answers
  // `getCursorEditor` and `getCurrentMessages` from state it updates on the very
  // same event, so a UI subscribing to it separately races the hub — and loses,
  // whenever it registered first. It reads the previous item every time.
  it("tells a UI the active item changed, once its own state has caught up", async () => {
    const seen = [];
    let hub = null;
    main.consumeLinterUI(
      ui({
        attach: (handle) => (hub = handle),
        didChangeActiveItem: () => seen.push(hub.getCursorEditor()),
      }),
    );

    const first = await lumine.workspace.open("first.js");
    const second = await lumine.workspace.open("second.js");

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(second);
    expect(seen).toContain(first);
    first.destroy();
    second.destroy();
  });

  // Everything but `name` is optional, and the hub calls each member only if
  // the UI has one.
  it("takes a UI that implements nothing but its name", () => {
    expect(() => main.consumeLinterUI({ name: "silent" })).not.toThrow();
  });

  it("returns a disposable even for a UI it rejects", () => {
    spyOn(lumine.notifications, "addWarning");
    const disposable = main.consumeLinterUI({ render: "not a function" });

    expect(typeof disposable.dispose).toBe("function");
    expect(() => disposable.dispose()).not.toThrow();
    expect(lumine.notifications.addWarning).toHaveBeenCalled();
  });

  it("disposes a UI when its registration is disposed", () => {
    let disposed = false;
    const disposable = main.consumeLinterUI(ui({ dispose: () => (disposed = true) }));

    disposable.dispose();

    expect(disposed).toBe(true);
  });
});
