const Tags = require("../lib/tags");

// The tag list is mirrored by the `.linter-tag-<tag>` rules in the stylesheet
// and by the LSP DiagnosticTag mapping in the ide-client bridge, so pin it.
describe("lib/tags", () => {
  it("mirrors LSP DiagnosticTag", () => {
    expect(Tags.TAGS).toEqual(["unnecessary", "deprecated"]);
    expect([...Tags.VALID_TAG]).toEqual(Tags.TAGS);
  });

  describe("normalizeTags", () => {
    it("keeps known tags in canonical order regardless of input order", () => {
      expect(Tags.normalizeTags(["deprecated", "unnecessary"])).toEqual([
        "unnecessary",
        "deprecated",
      ]);
      expect(Tags.normalizeTags(["unnecessary", "deprecated"])).toEqual([
        "unnecessary",
        "deprecated",
      ]);
    });

    it("removes duplicates", () => {
      expect(Tags.normalizeTags(["deprecated", "deprecated"])).toEqual(["deprecated"]);
    });

    it("drops unknown tags but keeps the known ones", () => {
      expect(Tags.normalizeTags(["bogus", "deprecated"])).toEqual(["deprecated"]);
    });

    it("returns null when nothing survives, so the field can be deleted", () => {
      expect(Tags.normalizeTags(["bogus"])).toBe(null);
      expect(Tags.normalizeTags([])).toBe(null);
    });

    it("returns null for anything that is not an array", () => {
      for (const value of ["deprecated", null, undefined, 0, {}]) {
        expect(Tags.normalizeTags(value)).toBe(null);
      }
    });
  });

  describe("listText", () => {
    it("renders the names as prose", () => {
      expect(Tags.listText()).toBe("'unnecessary' or 'deprecated'");
    });
  });
});
