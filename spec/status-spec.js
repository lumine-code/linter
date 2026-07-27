const { StatusPanel } = require("../lib/status");

// The status band is built from severities.js, one tile per severity. These
// specs pin the two ways the tiers are deliberately not uniform: the quiet tier
// hides itself at zero, and it never keeps the band open on its own.
describe("lib/status", () => {
  let status;
  let messages;
  let lintingDisabled;

  const message = (severity) => ({ severity, excerpt: severity, location: { file: "/a.js" } });

  const tileFor = (severity) => status.tiles.find((tile) => tile.severity.name === severity);

  beforeEach(() => {
    messages = [];
    lintingDisabled = false;
    status = new StatusPanel({
      getCurrentMessages: () => messages,
      isLintingDisabledForEditor: () => lintingDisabled,
      allMessages: [],
      panel: { viewMode: "file" },
    });
  });

  afterEach(() => {
    status.destroy();
  });

  it("builds one tile per severity, in precedence order", () => {
    expect(status.tiles.map((tile) => tile.severity.name)).toEqual([
      "error",
      "warning",
      "info",
      "hint",
    ]);
    expect(tileFor("hint").anchor.querySelector(".icon").classList).toContain("icon-light-bulb");
  });

  it("counts each severity into its own tile", () => {
    messages = [message("error"), message("hint"), message("hint"), message("warning")];
    status.update();
    expect(tileFor("error").label.textContent).toBe("1");
    expect(tileFor("warning").label.textContent).toBe("1");
    expect(tileFor("info").label.textContent).toBe("0");
    expect(tileFor("hint").label.textContent).toBe("2");
  });

  it("ignores a severity outside the model rather than miscounting it", () => {
    messages = [message("boom")];
    status.update();
    for (const tile of status.tiles) {
      expect(tile.label.textContent).toBe("0");
    }
  });

  it("colors a tile only while it has something to report", () => {
    status.update();
    expect(tileFor("error").anchor.classList).not.toContain("text-error");
    messages = [message("error")];
    status.update();
    expect(tileFor("error").anchor.classList).toContain("text-error");
  });

  describe("the quiet tier", () => {
    const isHidden = (severity) =>
      tileFor(severity).anchor.classList.contains("linter-status-tile-hidden");

    it("hides its tile at zero and shows it as soon as one arrives", () => {
      status.update();
      expect(isHidden("hint")).toBe(true);
      messages = [message("hint")];
      status.update();
      expect(isHidden("hint")).toBe(false);
    });

    it("leaves the loud tiles visible at zero", () => {
      status.update();
      expect(isHidden("error")).toBe(false);
      expect(isHidden("warning")).toBe(false);
      expect(isHidden("info")).toBe(false);
    });

    // Disabled linting reads as three X, exactly as it did before hint existed.
    it("stays hidden while linting is disabled and nothing was reported", () => {
      lintingDisabled = true;
      status.update();
      expect(isHidden("hint")).toBe(true);
      expect(tileFor("error").label.textContent).toBe("X");
    });

    // A file whose only diagnostics are hints is still clean, which is what
    // turning statusMode off asks the band to respect.
    it("does not keep the band open on its own", () => {
      atom.config.set("linter.statusMode", false);
      messages = [message("hint")];
      status.update();
      expect(status.element.classList).toContain("linter-status-hidden");

      messages = [message("hint"), message("info")];
      status.update();
      expect(status.element.classList).not.toContain("linter-status-hidden");
    });
  });
});
