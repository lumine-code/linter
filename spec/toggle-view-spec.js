const { showToggleView } = require("../lib/toggle-view");

// The provider on/off list. It is the one place the package writes
// `linter.disabledProviders`, and the one place a batch of toggles is turned
// into a single re-lint, so both are pinned here.
describe("lib/toggle-view", () => {
  let disabled;
  let finishes;
  let closes;

  const session = () => atom.modals.getActiveSession();

  // Deliveries are coalesced onto a microtask and a confirm walks several of
  // them, so nothing a source produced is readable in the tick that asked for
  // it. Mirrors `settle()` in the editor's own spec/helpers/modal-helpers.js,
  // which a package repo cannot require across the checkout boundary.
  const settle = async () => {
    for (let pass = 0; pass < 6; pass++) {
      const current = session();
      if (!current) return;
      await Promise.resolve();
      const run = current.frames.length > 0 ? current.frame.run : null;
      if (run) await run.whenSettled();
    }
  };

  const viewProps = () => ({
    onDisable: (name) => disabled.push(name),
    onFinish: () => finishes++,
    onClose: (result) => closes.push(result.reason ?? result.status),
  });

  const open = async (providers = ["eslint", "flake8"]) => {
    const opened = showToggleView({ providers, ...viewProps() });
    await settle();
    return opened;
  };

  const dispatch = (command) => atom.commands.dispatch(session().element, command);

  const rows = () =>
    Array.from(session().element.querySelectorAll("ol.list-group > li")).map((li) => ({
      label: li.querySelector(".primary-text").textContent,
      enabled: li.querySelector(".primary-line").classList.contains("icon-check"),
    }));

  beforeEach(() => {
    disabled = [];
    finishes = 0;
    closes = [];
    atom.config.set("linter.disabledProviders", []);
  });

  afterEach(() => {
    if (session()) session().cancel("destroyed");
  });

  it("lists every provider, marking the disabled ones", async () => {
    atom.config.set("linter.disabledProviders", ["flake8"]);
    await open();
    expect(rows()).toEqual([
      { label: "eslint", enabled: true },
      { label: "flake8", enabled: false },
    ]);
  });

  it("says nothing is there when no provider is registered", async () => {
    await open([]);
    expect(rows()).toEqual([]);
    expect(session().element.querySelector(".empty-message").textContent).toBe(
      "No linter providers found",
    );
  });

  it("flips a provider and stays open on the same row", async () => {
    await open();
    session().focusItem("eslint");
    dispatch("core:confirm");
    await settle();

    expect(atom.config.get("linter.disabledProviders")).toEqual(["eslint"]);
    expect(session()).not.toBeNull();
    expect(session().getFocusedItem()).toBe("eslint");
    expect(rows()).toEqual([
      { label: "eslint", enabled: false },
      { label: "flake8", enabled: true },
    ]);
  });

  it("flips a provider back on", async () => {
    atom.config.set("linter.disabledProviders", ["eslint"]);
    await open();
    session().focusItem("eslint");
    dispatch("core:confirm");
    await settle();

    expect(atom.config.get("linter.disabledProviders")).toEqual([]);
    // Re-enabling is not a disable, so nothing is reported for it.
    expect(disabled).toEqual([]);
  });

  it("reports each provider as it is disabled and lints once at the close", async () => {
    await open();
    session().focusItem("eslint");
    dispatch("core:confirm");
    await settle();
    session().focusItem("flake8");
    dispatch("core:confirm");
    await settle();

    expect(disabled).toEqual(["eslint", "flake8"]);
    expect(finishes).toBe(0);

    dispatch("core:cancel");
    expect(finishes).toBe(1);
  });

  it("does not lint when nothing was toggled", async () => {
    await open();
    dispatch("core:cancel");
    expect(finishes).toBe(0);
  });

  it("does not lint when the list goes away with the window", async () => {
    await open();
    session().focusItem("eslint");
    dispatch("core:confirm");
    await settle();

    session().cancel("destroyed");
    expect(finishes).toBe(0);
  });

  it("closes the list when the command runs again", async () => {
    await open();
    expect(await open()).toBeNull();
    expect(session()).toBeNull();
    expect(closes).toEqual(["toggled"]);
  });

  // The command palette confirms by dispatching into the editor it came from,
  // so `linter:toggle-linter` reaches `atom.modals` from inside another view's
  // action. The kernel makes that a sublist: `toggle()` hands back the HOST
  // session, and escaping the list only pops a frame off it. Anything the
  // caller hangs on the returned session would therefore outlive the list, so
  // the close has to be reported by the view itself.
  describe("opened from inside another modal's action", () => {
    const openPushed = async () => {
      const host = atom.modals.open({
        id: "toggle-view-spec.host",
        source: ["open the provider list"],
        confirm: () => {
          // Returning nothing: the kernel reads a returned value as an
          // ActionResult, and the session object is not one.
          showToggleView({ providers: ["eslint", "flake8"], ...viewProps() });
        },
      });
      await settle();
      dispatch("core:confirm");
      await settle();
      return host;
    };

    it("is pushed onto the host session rather than replacing it", async () => {
      const host = await openPushed();
      expect(session()).toBe(host);
      expect(session().depth).toBe(2);
      expect(session().view.id).toBe("linter.providers");
    });

    it("reports its close when it is popped, while the host session lives on", async () => {
      await openPushed();
      dispatch("core:confirm");
      await settle();
      expect(atom.config.get("linter.disabledProviders")).toEqual(["eslint"]);

      dispatch("core:cancel");
      await settle();

      expect(closes).toEqual(["popped"]);
      expect(finishes).toBe(1);
      expect(session()).not.toBeNull();
      expect(session().view.id).toBe("toggle-view-spec.host");
    });
  });
});
