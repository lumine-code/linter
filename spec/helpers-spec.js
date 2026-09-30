const Helpers = require("../lib/helpers");

describe("lib/helpers", () => {
  describe("normalizePath", () => {
    // Providers disagree about how to spell a path. A language server commonly
    // answers with a lowercase drive letter for the `C:\…` it was given, and
    // compared raw that is a different file — so its messages were stored under
    // one spelling, looked up under another, and shown nowhere.
    const windows = process.platform === "win32";

    it("gives one key to the spellings Windows treats as one file", () => {
      const a = Helpers.normalizePath("C:\\Users\\me\\project\\main.py");
      const b = Helpers.normalizePath("c:\\Users\\me\\project\\main.py");
      const c = Helpers.normalizePath("C:/Users/me/project/main.py");
      expect(`${a === b} ${a === c}`).toBe(windows ? "true true" : "false false");
    });

    it("keeps POSIX paths exact, where case and separator are meaningful", () => {
      // Only asserted off Windows: two files really can differ by case there.
      if (windows) return;
      expect(Helpers.normalizePath("/home/me/Main.py")).not.toBe(
        Helpers.normalizePath("/home/me/main.py"),
      );
      expect(Helpers.normalizePath("/home/me/main.py")).toBe("/home/me/main.py");
    });

    it("has no key for something that is not a path", () => {
      expect(Helpers.normalizePath(undefined)).toBeNull();
      expect(Helpers.normalizePath(null)).toBeNull();
      expect(Helpers.normalizePath(42)).toBeNull();
    });

    // Every consumer matches on this rather than spelling the path out again:
    // doing it per message per publish was the largest cost in the update path.
    it("is settled once, when a message is normalized", () => {
      const file = windows ? "C:\\Users\\me\\Main.py" : "/home/me/Main.py";
      const message = {
        severity: "error",
        excerpt: "x",
        location: {
          file,
          position: [
            [0, 0],
            [0, 1],
          ],
        },
      };
      Helpers.normalizeMessages("spec", [message]);

      expect(message.location.normalizedFile).toBe(Helpers.normalizePath(file));
    });

    it("has no path for a message that names a buffer instead", () => {
      const message = {
        severity: "error",
        excerpt: "x",
        location: {
          buffer: {},
          position: [
            [0, 0],
            [0, 1],
          ],
        },
      };
      Helpers.normalizeMessages("spec", [message]);

      expect(message.location.normalizedFile).toBeNull();
    });
  });

  // Rendering one line of markdown costs a whole MarkdownIt instance, its
  // plugins, a front-matter parse and a sanitize pass. The panel asks for one
  // per row per render, so the answer is kept.
  describe("renderExcerpt", () => {
    it("renders the markdown a message excerpt carries", () => {
      expect(Helpers.renderExcerpt("`F401` unused")).toContain("<code>F401</code>");
    });

    it("renders one excerpt once", () => {
      const render = spyOn(lumine.tools.markdown, "render").and.callThrough();
      const first = Helpers.renderExcerpt("cached excerpt");
      const second = Helpers.renderExcerpt("cached excerpt");

      expect(second).toBe(first);
      expect(render.calls.count()).toBe(1);
    });

    it("still tells two excerpts apart", () => {
      expect(Helpers.renderExcerpt("one")).not.toBe(Helpers.renderExcerpt("two"));
    });

    it("renders whatever a provider put in place of a string", () => {
      expect(() => Helpers.renderExcerpt(undefined)).not.toThrow();
    });
  });

  describe("matchesIgnoreGlob", () => {
    it("does not match a missing path", () => {
      expect(Helpers.matchesIgnoreGlob(null, "**/*.min.{js,css}")).toBe(false);
    });

    it("matches the configured ignore glob", () => {
      expect(Helpers.matchesIgnoreGlob("src/vendor/lib.min.js", "**/*.min.{js,css}")).toBe(true);
      expect(Helpers.matchesIgnoreGlob("src/app.js", "**/*.min.{js,css}")).toBe(false);
    });

    // The compiled glob is kept between calls, so a changed setting has to take
    // effect and a stale pattern must not answer for the new one.
    it("follows the glob changing", () => {
      expect(Helpers.matchesIgnoreGlob("src/app.js", "**/*.min.js")).toBe(false);
      expect(Helpers.matchesIgnoreGlob("src/app.js", "**/app.js")).toBe(true);
      expect(Helpers.matchesIgnoreGlob("src/app.js", "**/*.min.js")).toBe(false);
    });

    // picomatch throws on an empty pattern, and clearing the setting is how a
    // user says they want nothing ignored.
    it("matches nothing when the glob is empty", () => {
      expect(Helpers.matchesIgnoreGlob("src/vendor/lib.min.js", "")).toBe(false);
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

    it("ignores a marker's live display range when comparing snapshots", () => {
      const a = {
        key: "same",
        location: {
          position: [
            [0, 0],
            [0, 1],
          ],
        },
      };
      Object.defineProperty(a.location, "displayRange", {
        enumerable: true,
        get: jasmine.createSpy("liveRange").and.throwError("should not be read"),
      });
      const b = {
        key: "same",
        location: {
          position: [
            [0, 0],
            [0, 1],
          ],
        },
      };

      const result = Helpers.flagMessages([b], [a]);

      expect(result.oldKept[0] === a).toBe(true);
      expect(result.updated).toEqual([]);
    });

    it("refreshes changed marker invalidation policies outside the key", () => {
      const a = {
        severity: "warning",
        excerpt: "same",
        location: {
          file: "/a.js",
          position: [
            [0, 0],
            [0, 1],
          ],
        },
      };
      const b = {
        severity: "warning",
        excerpt: "same",
        location: {
          file: "/a.js",
          position: [
            [0, 0],
            [0, 1],
          ],
        },
      };
      Helpers.normalizeMessages("spec", [a], { markerInvalidation: "touch" });
      Helpers.normalizeMessages("spec", [b], { markerInvalidation: "never" });

      expect(a.key).toBe(b.key);
      expect(Helpers.flagMessages([b], [a]).updated).toEqual([b]);
    });

    it("preserves removed duplicate occurrences in snapshot order", () => {
      const first = { key: "duplicate" };
      const middle = { key: "other" };
      const last = { key: "duplicate" };

      const result = Helpers.flagMessages([{ key: "duplicate" }], [first, middle, last]);

      expect(result.oldKept).toEqual([first]);
      expect(result.oldRemoved).toEqual([middle, last]);
    });

    it("reuses a key index without consuming its duplicate occurrences", () => {
      const original = [{ key: "same" }, { key: "same" }];
      const index = Helpers.createMessageKeyIndex(original);

      for (let i = 0; i < 3; i++) {
        const result = Helpers.flagMessages([{ key: "same" }, { key: "same" }], original, index);
        expect(result.oldKept[0]).toBe(original[0]);
        expect(result.oldKept[1]).toBe(original[1]);
        expect(result.newAdded).toEqual([]);
        expect(result.oldRemoved).toEqual([]);
      }
    });

    it("rebuilds a key index after an existing object changes its key", () => {
      const original = [{ key: "before" }];
      const index = Helpers.createMessageKeyIndex(original);
      original[0].key = "after";

      const result = Helpers.flagMessages([{ key: "after" }], original, index);

      expect(result.oldKept[0]).toBe(original[0]);
      expect(result.newAdded).toEqual([]);
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

    it("preserves the existing key format with batch-local prefixes", () => {
      const messages = [
        message(),
        message({
          linterName: "other",
          reference: {
            file: "/log.txt",
            position: [2, 4],
          },
        }),
      ];
      Helpers.normalizeMessages("spec", messages);

      for (const entry of messages) {
        const batched = entry.key;
        Helpers.updateMessageKey(entry);
        expect(entry.key).toBe(batched);
      }
    });

    it("recomputes changed file paths between normalization batches", () => {
      const entry = message();
      Helpers.normalizeMessages("spec", [entry]);
      const previousKey = entry.key;
      entry.location.file = "/other.js";

      Helpers.normalizeMessages("spec", [entry]);

      expect(entry.key).not.toBe(previousKey);
      expect(entry.location.normalizedFile).toBe(Helpers.normalizePath("/other.js"));
    });
  });

  describe("description resolution", () => {
    it("reads the string form without resolving anything", async () => {
      const msg = { description: "Ruff: F401" };
      expect(Helpers.getDescription(msg)).toBe("Ruff: F401");
      expect(Helpers.hasLazyDescription(msg)).toBe(false);
      expect(await Helpers.resolveDescription(msg)).toBe("Ruff: F401");
    });

    it("reports nothing for a message with no description", async () => {
      const msg = { excerpt: "boom" };
      expect(Helpers.getDescription(msg)).toBeNull();
      expect(Helpers.hasLazyDescription(msg)).toBe(false);
      expect(await Helpers.resolveDescription(msg)).toBeNull();
    });

    it("calls the function form once and serves the result from cache after", async () => {
      let calls = 0;
      const msg = {
        description: () => {
          calls++;
          return Promise.resolve("the long form");
        },
      };
      expect(Helpers.hasLazyDescription(msg)).toBe(true);
      expect(Helpers.getDescription(msg)).toBeNull();

      expect(await Helpers.resolveDescription(msg)).toBe("the long form");
      expect(await Helpers.resolveDescription(msg)).toBe("the long form");
      expect(calls).toBe(1);
      expect(Helpers.getDescription(msg)).toBe("the long form");
      expect(Helpers.hasLazyDescription(msg)).toBe(false);
    });

    it("swallows a throwing description and does not retry it", async () => {
      let calls = 0;
      const msg = {
        description: () => {
          calls++;
          throw new Error("nope");
        },
      };
      spyOn(console, "error");
      expect(await Helpers.resolveDescription(msg)).toBeNull();
      expect(await Helpers.resolveDescription(msg)).toBeNull();
      expect(calls).toBe(1);
      expect(console.error).toHaveBeenCalled();
    });
  });
});
