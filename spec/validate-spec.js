const Validate = require("../lib/validate");

// Validate guards the shapes packages hand across the linter services. On a bad
// shape it returns false and raises a warning notification; a good shape returns
// true silently. Spy the notification so the invalid-case tests stay quiet.
describe("lib/validate", () => {
  beforeEach(() => {
    spyOn(atom.notifications, "addWarning");
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
      expect(atom.notifications.addWarning).not.toHaveBeenCalled();
    });

    it("rejects an invalid scope and warns", () => {
      expect(Validate.linter({ ...good, scope: "nope" })).toBe(false);
      expect(atom.notifications.addWarning).toHaveBeenCalled();
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

    it("rejects a UI missing render", () => {
      const { render: _render, ...withoutRender } = good;
      expect(Validate.ui(withoutRender)).toBe(false);
    });
  });

  describe("indie", () => {
    it("requires a name", () => {
      expect(Validate.indie({ name: "my-indie" })).toBe(true);
      expect(Validate.indie({})).toBe(false);
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

    it("rejects a message with no excerpt", () => {
      const { excerpt: _excerpt, ...withoutExcerpt } = good;
      expect(Validate.messages("my-linter", [withoutExcerpt])).toBe(false);
    });
  });
});
