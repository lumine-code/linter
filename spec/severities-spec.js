const Severities = require("../lib/severities");

// severities.js is the single source of truth the panel, the status bar, the
// marker layers and every severity sort read from, so these specs pin the
// invariants those call sites rely on rather than the literal contents.
describe("lib/severities", () => {
  it("mirrors the LSP DiagnosticSeverity scale", () => {
    expect(Severities.NAMES).toEqual(["error", "warning", "info", "hint"]);
    for (const severity of Severities.SEVERITIES) {
      expect(severity.rank).toBe(severity.lsp - 1);
    }
  });

  it("orders the array by rank", () => {
    Severities.SEVERITIES.forEach((severity, index) => {
      expect(severity.rank).toBe(index);
    });
  });

  it("gives every severity the fields its call sites read", () => {
    for (const severity of Severities.SEVERITIES) {
      expect(typeof severity.name).toBe("string");
      expect(typeof severity.label).toBe("string");
      expect(typeof severity.icon).toBe("string");
      expect(typeof severity.textClass).toBe("string");
      expect(typeof severity.gutterDot).toBe("boolean");
      expect(typeof severity.hideWhenZero).toBe("boolean");
    }
  });

  it("keeps hint the quiet tier", () => {
    const hint = Severities.get("hint");
    expect(hint.gutterDot).toBe(false);
    expect(hint.hideWhenZero).toBe(true);
    // Every louder tier keeps its dot and its permanent status tile.
    for (const severity of ["error", "warning", "info"]) {
      expect(Severities.get(severity).gutterDot).toBe(true);
      expect(Severities.get(severity).hideWhenZero).toBe(false);
    }
  });

  describe("isValid", () => {
    it("accepts exactly the model", () => {
      for (const name of Severities.NAMES) {
        expect(Severities.isValid(name)).toBe(true);
      }
    });

    it("rejects anything else", () => {
      for (const value of ["boom", "", null, undefined, 4, "Error"]) {
        expect(Severities.isValid(value)).toBe(false);
      }
    });
  });

  describe("get", () => {
    it("returns null rather than a fallback record", () => {
      expect(Severities.get("boom")).toBe(null);
      expect(Severities.get(undefined)).toBe(null);
    });
  });

  describe("rankOf / compare", () => {
    it("ranks an unknown severity last", () => {
      expect(Severities.rankOf("boom")).toBe(Severities.UNKNOWN_RANK);
      expect(Severities.UNKNOWN_RANK).toBeGreaterThan(Severities.rankOf("hint"));
    });

    // The three severityOrder maps this module replaced produced NaN here, which
    // silently scrambled the panel and bubble sort order.
    it("is never NaN, whatever it is given", () => {
      const values = [...Severities.NAMES, "boom", "", null, undefined, 4];
      for (const a of values) {
        for (const b of values) {
          expect(Number.isNaN(Severities.compare(a, b))).toBe(false);
        }
      }
    });

    it("sorts most severe first", () => {
      const sorted = ["hint", "boom", "error", "info", "warning"].sort(Severities.compare);
      expect(sorted).toEqual(["error", "warning", "info", "hint", "boom"]);
    });
  });

  describe("listText", () => {
    it("renders the names as prose", () => {
      expect(Severities.listText()).toBe("'error', 'warning', 'info' or 'hint'");
    });
  });
});
