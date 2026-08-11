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

    it("accepts a valid message array", () => {
      expect(Validate.messages("my-linter", [good])).toBe(true);
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
  });
});
