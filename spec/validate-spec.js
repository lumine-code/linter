const Validate = require("../lib/validate");

// Validate guards the shapes packages hand across the linter services. On a bad
// shape it returns false and raises a warning notification; a good shape returns
// true silently. Spy the notification so the invalid-case tests stay quiet.
describe("lib/validate", () => {
  beforeEach(() => {
    spyOn(lumine.notifications, "addWarning");
  });

  describe("linter", () => {
    const good = {
      name: "my-linter",
      scope: "file",
      lintsOnChange: true,
      grammarScopes: ["source.js"],
      lint() {},
    };

    it("accepts a well-formed provider", () => {
      expect(Validate.linter(good)).toBe(true);
      expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
    });

    it("rejects an invalid scope and warns", () => {
      expect(Validate.linter({ ...good, scope: "nope" })).toBe(false);
      expect(lumine.notifications.addWarning).toHaveBeenCalled();
    });
  });

  describe("ui", () => {
    const good = {
      name: "my-ui",
      render() {},
      didBeginLinting() {},
      didFinishLinting() {},
      dispose() {},
    };

    it("accepts a well-formed UI provider", () => {
      expect(Validate.ui(good)).toBe(true);
    });

    // Everything but the name is optional: a scrollbar overview wants `render`
    // and nothing else, and used to have to write three empty stubs to say so.
    it("accepts a UI that implements only what it uses", () => {
      expect(Validate.ui({ name: "sparse", render() {} })).toBe(true);
      expect(Validate.ui({ name: "silent" })).toBe(true);
    });

    it("rejects a member that is present but not callable", () => {
      expect(Validate.ui({ name: "broken", render: "soon" })).toBe(false);
      expect(Validate.ui({ name: "broken", attach: {} })).toBe(false);
    });

    it("still requires a name to put in a notification", () => {
      expect(Validate.ui({ render() {} })).toBe(false);
    });
  });

  describe("indie", () => {
    it("requires a name", () => {
      expect(Validate.indie({ name: "my-indie" })).toBe(true);
      expect(Validate.indie({})).toBe(false);
    });

    it("accepts only the documented marker invalidation strategies", () => {
      expect(Validate.indie({ name: "my-indie", markerInvalidation: "touch" })).toBe(true);
      expect(Validate.indie({ name: "my-indie", markerInvalidation: "never" })).toBe(true);
      expect(Validate.indie({ name: "my-indie", markerInvalidation: "inside" })).toBe(false);
    });
  });

  describe("messages", () => {
    const good = {
      severity: "warning",
      excerpt: "something",
      location: {
        file: "/a.js",
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };

    it("accepts structured source, zero code and local or URI related locations", () => {
      const entry = {
        ...good,
        code: 0,
        source: "compiler",
        relatedInformation: [
          {
            message: "Defined here",
            location: {
              file: "/related.dat",
              position: [
                [0, 0],
                [0, 3],
              ],
            },
          },
          { message: "Unavailable source", uri: "untitled:other.dat" },
        ],
      };
      expect(Validate.messages("spec", [entry])).toBe(true);
      expect(Validate.messages("spec", [{ ...entry, code: "G310", relatedInformation: [] }])).toBe(
        true,
      );
    });

    it("rejects nonprimitive codes and sources, including nonfinite numbers", () => {
      for (const code of [null, {}, [], true, NaN, Infinity]) {
        expect(Validate.messages("spec", [{ ...good, code }])).toBe(false);
      }
      for (const source of [null, {}, [], true, 0]) {
        expect(Validate.messages("spec", [{ ...good, source }])).toBe(false);
      }
    });

    it("requires a message and exactly one related location representation", () => {
      const location = {
        file: "/related.dat",
        position: [
          [0, 0],
          [0, 1],
        ],
      };
      for (const relatedInformation of [
        null,
        {},
        "source",
        [null],
        [{}],
        [{ message: 42, location }],
        [{ message: "Missing destination" }],
        [{ message: "Both", location, uri: "untitled:other" }],
        [{ message: "Empty URI", uri: "" }],
      ]) {
        expect(() => Validate.messages("spec", [{ ...good, relatedInformation }])).not.toThrow();
        expect(Validate.messages("spec", [{ ...good, relatedInformation }])).toBe(false);
      }
    });

    it("rejects malformed or nonfinite related coordinates without throwing", () => {
      const sparsePoint = [0];
      sparsePoint.length = 2;
      for (const position of [
        null,
        {},
        [],
        [[0, 0]],
        [[0, 0], [0]],
        [[0, 0], sparsePoint],
        [
          [-1, 0],
          [0, 1],
        ],
        [
          [0, 0],
          [Infinity, 1],
        ],
        [
          [0, 0],
          [NaN, 1],
        ],
        [
          [0, "0"],
          [0, 1],
        ],
      ]) {
        const entry = {
          ...good,
          relatedInformation: [
            { message: "Related", location: { file: "/related.dat", position } },
          ],
        };
        expect(() => Validate.messages("spec", [entry])).not.toThrow();
        expect(Validate.messages("spec", [entry])).toBe(false);
      }
    });

    it("shares parsed related ranges with normalization without mutating validation input", () => {
      const { Range } = require("lumine");
      const { normalizeMessages } = require("../lib/helpers");
      const position = [
        [2, 3],
        [2, 7],
      ];
      const entry = {
        ...good,
        location: { ...good.location },
        relatedInformation: [{ message: "Related", location: { file: "/related.dat", position } }],
      };
      const cache = new WeakMap();
      expect(Validate.messages("spec", [entry], cache)).toBe(true);
      expect(entry.relatedInformation[0].location.position).toBe(position);
      const parsed = cache.get(position);
      expect(parsed instanceof Range).toBe(true);
      normalizeMessages("spec", [entry], { positionCache: cache });
      expect(entry.relatedInformation[0].location.position).toBe(parsed);
    });

    it("declines related proxies and throwing getters without an unhandled exception", () => {
      const prototype = jasmine.createSpy("prototype").and.throwError("Do not inspect");
      const proxy = new Proxy(
        { message: "Related", uri: "untitled:other" },
        { getPrototypeOf: prototype },
      );
      expect(Validate.messages("spec", [{ ...good, relatedInformation: [proxy] }])).toBe(false);
      expect(prototype).not.toHaveBeenCalled();
      const related = {};
      Object.defineProperty(related, "message", {
        get() {
          throw new Error("Provider failed");
        },
      });
      expect(() =>
        Validate.messages("spec", [{ ...good, relatedInformation: [related] }]),
      ).not.toThrow();
      expect(Validate.messages("spec", [{ ...good, relatedInformation: [related] }])).toBe(false);
    });

    it("accepts a valid message array", () => {
      expect(Validate.messages("my-linter", [good])).toBe(true);
    });

    it("rejects missing or primitive message entries without throwing", () => {
      for (const entry of [null, undefined, 1, "message", true, [], () => {}]) {
        expect(() => Validate.messages("spec", [entry])).not.toThrow();
        expect(Validate.messages("spec", [entry])).toBeFalse();
      }
      const sparse = new Array(2);
      expect(() => Validate.messages("spec", sparse)).not.toThrow();
      expect(Validate.messages("spec", sparse)).toBeFalse();
    });

    it("rejects proxy batches and proxy entries before inspecting provider traps", () => {
      const trap = jasmine.createSpy("get").and.throwError("Do not inspect provider proxy");
      const batch = new Proxy([good], { get: trap });
      const entry = new Proxy(good, { get: trap });
      expect(() => Validate.messages("spec", batch)).not.toThrow();
      expect(Validate.messages("spec", batch)).toBeFalse();
      expect(() => Validate.messages("spec", [entry])).not.toThrow();
      expect(Validate.messages("spec", [entry])).toBeFalse();
      expect(trap).not.toHaveBeenCalled();
      for (const target of [[good], good]) {
        const revoked = Proxy.revocable(target, {});
        revoked.revoke();
        const result = Array.isArray(target) ? revoked.proxy : [revoked.proxy];
        expect(() => Validate.messages("spec", result)).not.toThrow();
        expect(Validate.messages("spec", result)).toBeFalse();
      }
    });

    it("validates array entries without trusting an overridden iterator or throwing index getter", () => {
      const disguised = [null];
      disguised[Symbol.iterator] = function* () {
        yield good;
      };
      expect(Validate.messages("spec", disguised)).toBeFalse();
      const unreadable = [good];
      Object.defineProperty(unreadable, "0", {
        get() {
          throw new Error("Cannot read result");
        },
      });
      expect(() => Validate.messages("spec", unreadable)).not.toThrow();
      expect(Validate.messages("spec", unreadable)).toBeFalse();
      for (const field of ["relatedInformation", "solutions", "tags"]) {
        const disguisedMetadata = [null];
        disguisedMetadata[Symbol.iterator] = function* () {};
        expect(Validate.messages("spec", [{ ...good, [field]: disguisedMetadata }])).toBeFalse();
      }
    });

    it("contains throwing getters on every diagnostic field", () => {
      for (const field of [
        "reference",
        "location",
        "severity",
        "excerpt",
        "code",
        "source",
        "relatedInformation",
        "solutions",
        "tags",
        "url",
        "icon",
        "description",
        "linterName",
      ]) {
        const entry = { ...good };
        Object.defineProperty(entry, field, {
          get() {
            throw new Error(`Cannot read ${field}`);
          },
        });
        expect(() => Validate.messages("spec", [entry])).not.toThrow();
        expect(Validate.messages("spec", [entry])).toBeFalse();
      }
    });

    it("contains nested location, reference and coordinate access failures", () => {
      const throwing = (field, source) =>
        Object.defineProperty({ ...source }, field, {
          get() {
            throw new Error(`Cannot read ${field}`);
          },
        });
      for (const entry of [
        { ...good, location: throwing("file", good.location) },
        { ...good, location: throwing("buffer", good.location) },
        { ...good, location: throwing("position", good.location) },
        { ...good, location: { ...good.location, position: throwing("start", { end: [0, 1] }) } },
        {
          ...good,
          location: { ...good.location, position: [throwing("row", { column: 0 }), [0, 1]] },
        },
        { ...good, reference: throwing("position", { file: "/reference.js" }) },
        { ...good, reference: { file: "/reference.js", position: throwing("column", { row: 0 }) } },
      ]) {
        expect(() => Validate.messages("spec", [entry])).not.toThrow();
        expect(Validate.messages("spec", [entry])).toBeFalse();
      }
    });

    it("rejects malformed primary ranges without parsing missing coordinates as zero", () => {
      for (const position of [
        null,
        {},
        [],
        [[0, 0]],
        [[0], [0, 1]],
        [
          [0, 0],
          [0, "1"],
        ],
        [
          [-1, 0],
          [0, 1],
        ],
        [
          [0, 0],
          [NaN, 1],
        ],
      ]) {
        const entry = { ...good, location: { ...good.location, position } };
        expect(() => Validate.messages("spec", [entry])).not.toThrow();
        expect(Validate.messages("spec", [entry])).toBeFalse();
      }
      expect(
        Validate.messages("spec", [
          {
            ...good,
            location: {
              ...good.location,
              position: [
                [0, 0],
                [0, Infinity],
              ],
            },
          },
        ]),
      ).toBeTrue();
    });

    it("rejects malformed solution and reference shapes before normalization", () => {
      for (const solutions of [
        null,
        {},
        [null],
        [{}],
        [{ position: good.location.position }],
        [{ position: [], replaceWith: "fixed" }],
      ]) {
        const entry = { ...good, solutions };
        expect(() => Validate.messages("spec", [entry])).not.toThrow();
        expect(Validate.messages("spec", [entry])).toBeFalse();
      }
      for (const reference of [null, [], {}, { file: "/other", position: [0] }]) {
        expect(() => Validate.messages("spec", [{ ...good, reference }])).not.toThrow();
        expect(Validate.messages("spec", [{ ...good, reference }])).toBeFalse();
      }
      expect(
        Validate.messages("spec", [
          { ...good, solutions: [{ position: good.location.position, replaceWith: "fixed" }] },
        ]),
      ).toBeTrue();
    });

    it("warns once for a batch and lists each malformed field once", () => {
      const entries = [null, null, { ...good, excerpt: 1 }, { ...good, excerpt: 2 }];
      expect(Validate.messages("spec", entries)).toBeFalse();
      expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
      const detail = lumine.notifications.addWarning.calls.mostRecent().args[1].detail;
      expect(detail.match(/Message must be an object/g).length).toBe(1);
      expect(detail.match(/Message.excerpt must be a string/g).length).toBe(1);
    });

    it("rejects a non-array result", () => {
      expect(Validate.messages("my-linter", null)).toBe(false);
    });

    it("rejects an invalid severity", () => {
      expect(Validate.messages("my-linter", [{ ...good, severity: "boom" }])).toBe(false);
    });

    // A buffer that has never been saved has no path, so a message about one
    // names the buffer instead. One of the two is required; neither is not.
    it("accepts a message located by buffer instead of by file", () => {
      const buffer = { id: 7 };
      const message = { ...good, location: { buffer, position: good.location.position } };

      expect(Validate.messages("my-linter", [message])).toBe(true);
      expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
    });

    it("rejects a message located by neither", () => {
      const message = { ...good, location: { position: good.location.position } };

      expect(Validate.messages("my-linter", [message])).toBe(false);
      const [, options] = lumine.notifications.addWarning.calls.mostRecent().args;
      expect(options.detail).toContain("file or a buffer");
    });

    it("still rejects a message with no position", () => {
      const message = { ...good, location: { buffer: { id: 7 } } };

      expect(Validate.messages("my-linter", [message])).toBe(false);
    });

    it("accepts every severity of the model", () => {
      for (const severity of ["error", "warning", "info", "hint"]) {
        expect(Validate.messages("my-linter", [{ ...good, severity }])).toBe(true);
      }
    });

    it("names every severity when rejecting one", () => {
      Validate.messages("my-linter", [{ ...good, severity: "boom" }]);
      const [, options] = lumine.notifications.addWarning.calls.mostRecent().args;
      expect(options.detail).toContain("'error', 'warning', 'info' or 'hint'");
    });

    // Tags are optional, and no provider outside the LSP bridge sets them, so
    // the absent case is the one that must never regress.
    it("accepts a message with no tags", () => {
      expect(Validate.messages("my-linter", [good])).toBe(true);
      expect("tags" in good).toBe(false);
    });

    it("accepts an empty tag array", () => {
      expect(Validate.messages("my-linter", [{ ...good, tags: [] }])).toBe(true);
    });

    it("accepts known tags in any order", () => {
      expect(
        Validate.messages("my-linter", [{ ...good, tags: ["deprecated", "unnecessary"] }]),
      ).toBe(true);
    });

    it("rejects tags that are not an array", () => {
      expect(Validate.messages("my-linter", [{ ...good, tags: "deprecated" }])).toBe(false);
    });

    it("rejects an unknown tag", () => {
      expect(Validate.messages("my-linter", [{ ...good, tags: ["bogus"] }])).toBe(false);
    });

    it("rejects a message with no excerpt", () => {
      const { excerpt: _excerpt, ...withoutExcerpt } = good;
      expect(Validate.messages("my-linter", [withoutExcerpt])).toBe(false);
    });

    it("shares parsed positions with normalization without mutating validation inputs", () => {
      const { Range, Point } = require("lumine");
      const { normalizeMessages } = require("../lib/helpers");
      const sourceRange = [
        [0, 2],
        [0, 5],
      ];
      const sourcePoint = [3, 7];
      const diagnostic = {
        severity: "warning",
        excerpt: "shared positions",
        location: { file: "/positions.js", position: sourceRange },
        reference: { file: "/log.txt", position: sourcePoint },
      };
      const positionCache = new WeakMap();
      spyOn(Range, "fromObject").and.callThrough();

      expect(Validate.messages("spec", [diagnostic], positionCache)).toBe(true);
      expect(diagnostic.location.position).toBe(sourceRange);
      expect(diagnostic.reference.position).toBe(sourcePoint);
      normalizeMessages("spec", [diagnostic], { positionCache });

      expect(Range.fromObject).toHaveBeenCalledTimes(1);
      expect(diagnostic.location.position instanceof Range).toBe(true);
      expect(diagnostic.reference.position instanceof Point).toBe(true);
      expect(diagnostic.location.position.start.column).toBe(2);
      expect(diagnostic.reference.position.row).toBe(3);
    });

    it("keeps range and point interpretations separate when a source object is shared", () => {
      const { Range, Point } = require("lumine");
      const { normalizeMessages } = require("../lib/helpers");
      const shared = {
        start: { row: 0, column: 2 },
        end: { row: 0, column: 5 },
        row: 3,
        column: 7,
      };
      const diagnostic = {
        severity: "warning",
        excerpt: "shared object",
        location: { file: "/positions.js", position: shared },
        reference: { file: "/log.txt", position: shared },
      };
      const positionCache = new WeakMap();

      expect(Validate.messages("spec", [diagnostic], positionCache)).toBe(true);
      normalizeMessages("spec", [diagnostic], { positionCache });

      expect(diagnostic.location.position instanceof Range).toBe(true);
      expect(diagnostic.reference.position instanceof Point).toBe(true);
      expect(diagnostic.location.position.start.column).toBe(2);
      expect(diagnostic.reference.position.row).toBe(3);
    });
  });
});
