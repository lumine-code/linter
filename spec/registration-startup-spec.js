const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

describe("linter registration validation startup", () => {
  it("validates synchronous providers without loading message or geometry runtimes", () => {
    const isolatedModule = { exports: {} };
    const warnings = [];
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, "../lib/registration-validation.js"), "utf8"),
      {
        module: isolatedModule,
        lumine: { notifications: { addWarning: (...args) => warnings.push(args) } },
        require: (request) => {
          if (request === "./message-metadata") return require("../lib/message-metadata");
          throw new Error(`Unexpected registration dependency: ${request}`);
        },
      },
    );
    const validation = isolatedModule.exports;
    expect(validation.ui({ name: "UI", render() {} })).toBeTrue();
    expect(validation.indie({ name: "Indie", markerInvalidation: "never" })).toBeTrue();
    expect(
      validation.linter({
        name: "Provider",
        scope: "file",
        lintsOnChange: true,
        grammarScopes: ["source.js"],
        lint() {},
      }),
    ).toBeTrue();
    expect(validation.indie({ name: "Invalid", markerInvalidation: "invalid" })).toBeFalse();
    expect(warnings.length).toBe(1);
  });

  it("shares the existing public validation function identities", () => {
    const registration = require("../lib/registration-validation");
    const validation = require("../lib/validate");
    for (const name of ["ui", "linter", "indie"]) expect(registration[name]).toBe(validation[name]);
  });
});
