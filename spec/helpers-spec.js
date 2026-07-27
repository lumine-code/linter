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

  describe("normalizeMessages", () => {
    const message = (overrides = {}) => ({
      severity: "hint",
      excerpt: "unused",
      location: {
        file: "/a.js",
        position: [
          [0, 0],
          [0, 1],
        ],
      },
      ...overrides,
    });

    it("leaves a message with no tags alone", () => {
      const msg = message();
      Helpers.normalizeMessages("my-linter", [msg]);
      expect("tags" in msg).toBe(false);
      expect(msg.key).toContain("$TAGS:null");
    });

    it("rewrites tags into canonical order in place", () => {
      const msg = message({ tags: ["deprecated", "unnecessary"] });
      Helpers.normalizeMessages("my-linter", [msg]);
      expect(msg.tags).toEqual(["unnecessary", "deprecated"]);
    });

    it("drops the field when only unknown tags were supplied", () => {
      const msg = message({ tags: ["bogus"] });
      Helpers.normalizeMessages("my-linter", [msg]);
      expect("tags" in msg).toBe(false);
    });

    // flagMessages diffs purely by key, so a tag change has to change the key
    // or the decoration goes stale for the rest of the session.
    it("gives two otherwise identical messages different keys when tags differ", () => {
      const plain = message();
      const tagged = message({ tags: ["unnecessary"] });
      Helpers.normalizeMessages("my-linter", [plain, tagged]);
      expect(plain.key).not.toBe(tagged.key);
    });

    it("gives the same key regardless of the order tags arrived in", () => {
      const a = message({ tags: ["deprecated", "unnecessary"] });
      const b = message({ tags: ["unnecessary", "deprecated"] });
      Helpers.normalizeMessages("my-linter", [a, b]);
      expect(a.key).toBe(b.key);
    });
  });
});
