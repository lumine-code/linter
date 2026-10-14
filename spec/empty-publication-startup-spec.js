const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Emitter, CompositeDisposable } = require("lumine");

describe("empty indie diagnostic publications", () => {
  it("preserves clearing events without loading message processing", () => {
    const isolatedModule = { exports: {} };
    let validations = 0;
    let normalizations = 0;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/indie-delegate.js"), "utf8"), {
      module: isolatedModule,
      lumine: { window: { isDevMode: () => true } },
      require(request) {
        if (request === "lumine") return { Emitter, CompositeDisposable };
        if (request === "node:util") return require("node:util");
        if (request === "./message-metadata") return require("../lib/message-metadata");
        if (request === "./validate")
          return {
            messages: () => {
              validations++;
              return false;
            },
          };
        if (request === "./helpers")
          return {
            normalizeMessages: () => {
              normalizations++;
            },
          };
        throw new Error(`Unexpected publication dependency: ${request}`);
      },
    });
    const delegate = new isolatedModule.exports({ name: "Startup" }, 1);
    const events = [];
    delegate.onDidUpdate((event) => events.push(event));
    const options = { showProjectView: true };
    delegate.setMessages("C:/startup/test.js", []);
    expect(events[0].length).toBe(0);
    expect(events[0].affectedFiles).toEqual([
      require("../lib/message-metadata").normalizePath("C:/startup/test.js"),
    ]);
    expect(delegate.messages.size).toBe(1);
    expect(delegate.getMessages()).toEqual([]);
    delegate.setAllMessages([], options);
    expect(events[1].messages).toEqual([]);
    expect(events[1].options).toBe(options);
    expect(delegate.messages.size).toBe(0);
    expect(validations).toBe(0);
    expect(normalizations).toBe(0);
    delegate.setAllMessages(new Proxy([], {}));
    expect(validations).toBe(1);
    expect(events.length).toBe(2);
    delegate.dispose();
    delegate.setMessages("C:/startup/test.js", []);
    expect(events.length).toBe(2);
  });
});
