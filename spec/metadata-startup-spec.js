const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

describe("the diagnostic metadata bootstrap", () => {
  it("loads without message normalization, marker rendering or lint execution", () => {
    const isolatedModule = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, "../lib/message-metadata.js"), "utf8"),
      {
        module: isolatedModule,
        process,
        console,
        require: (request) => {
          throw new Error(`Unexpected metadata dependency: ${request}`);
        },
      },
    );
    const metadata = isolatedModule.exports;
    expect(metadata.getMarkerInvalidation({})).toBe("touch");
    expect(metadata.getDescription({ description: "detail" })).toBe("detail");
    expect(metadata.getMessageFile({ location: { file: "/file.py" } })).toBe("/file.py");
  });

  it("shares description and marker policy identities with the message helpers", async () => {
    const metadata = require("../lib/message-metadata");
    const helpers = require("../lib/helpers");
    for (const name of [
      "getDescription",
      "resolveDescription",
      "getMarkerInvalidation",
      "normalizePath",
    ])
      expect(metadata[name]).toBe(helpers[name]);
    const message = {
      excerpt: "issue",
      severity: "error",
      location: {
        file: "/file.py",
        position: [
          [0, 0],
          [0, 1],
        ],
      },
      description: jasmine.createSpy().and.resolveTo("detail"),
    };
    helpers.normalizeMessages("spec", [message], { markerInvalidation: "never" });
    expect(metadata.getMarkerInvalidation(message)).toBe("never");
    await metadata.resolveDescription(message);
    expect(helpers.getDescription(message)).toBe("detail");
    expect(helpers.hasLazyDescription(message)).toBe(false);
  });
});
