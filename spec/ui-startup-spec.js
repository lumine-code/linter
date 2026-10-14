const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CompositeDisposable, Disposable } = require("lumine");

describe("diagnostic projection startup", () => {
  it("loads projection only for an editor or diagnostic operation", () => {
    const isolatedModule = { exports: {} };
    let runtimeLoads = 0;
    let receiver;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/linter-ui.js"), "utf8"), {
      module: isolatedModule,
      require(request) {
        if (request === "lumine") return { CompositeDisposable };
        if (request === "./message-metadata") return require("../lib/message-metadata");
        if (request === "./linter-ui-runtime") {
          runtimeLoads++;
          return {
            patchEditor() {
              receiver = this;
              return "patched";
            },
            getMarkerMessages(messages) {
              receiver = this;
              return messages;
            },
          };
        }
        throw new Error(`Unexpected projection bootstrap dependency: ${request}`);
      },
      lumine: {
        workspace: {
          observeTextEditors: () => new Disposable(),
          getCenter: () => ({ observeActivePaneItem: () => new Disposable() }),
        },
        config: {
          observe(_key, callback) {
            callback(undefined);
            return new Disposable();
          },
        },
      },
      window: { cancelIdleCallback() {} },
    });
    const ui = new isolatedModule.exports();
    expect(runtimeLoads).toBe(0);
    expect(ui.patchEditor({})).toBe("patched");
    expect(runtimeLoads).toBe(1);
    const messages = [{}];
    expect(ui.getMarkerMessages(messages)).toBe(messages);
    expect(runtimeLoads).toBe(1);
    expect(receiver).toBe(ui);
    ui.dispose();
  });
});
