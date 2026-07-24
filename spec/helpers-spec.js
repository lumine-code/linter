const Helpers = require("../lib/helpers");

describe("lib/helpers", () => {
  describe("isPathIgnored", () => {
    it("treats a missing path as ignored", async () => {
      expect(await Helpers.isPathIgnored(null, "**/*.min.{js,css}", false)).toBe(true);
    });

    it("matches the ignore glob when the VCS check is disabled", async () => {
      // ignoredVCS = false, so this never touches atom.project (no repo needed).
      expect(await Helpers.isPathIgnored("src/vendor/lib.min.js", "**/*.min.{js,css}", false)).toBe(
        true,
      );
      expect(await Helpers.isPathIgnored("src/app.js", "**/*.min.{js,css}", false)).toBe(false);
    });
  });

  describe("flagMessages", () => {
    it("splits inputs into kept / removed / added by key", () => {
      const a = { key: "A" };
      const b = { key: "B" };
      const c = { key: "C" };
      const result = Helpers.flagMessages([a, c], [a, b]);
      expect(result.oldKept.map((m) => m.key)).toEqual(["A"]);
      expect(result.oldRemoved.map((m) => m.key)).toEqual(["B"]);
      expect(result.newAdded.map((m) => m.key)).toEqual(["C"]);
    });

    it("returns null when inputs are undefined", () => {
      expect(Helpers.flagMessages(undefined, [])).toBeNull();
    });

    it("treats an empty old set as all-added", () => {
      const a = { key: "A" };
      const result = Helpers.flagMessages([a], []);
      expect(result.newAdded).toEqual([a]);
      expect(result.oldKept).toEqual([]);
      expect(result.oldRemoved).toEqual([]);
    });
  });
});
