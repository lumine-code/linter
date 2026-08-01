const MessageRegistry = require("../lib/message-registry");

describe("lib/message-registry", () => {
  let registry;
  let updates;
  const linter = { name: "spec" };
  const message = (excerpt) => ({ key: excerpt, excerpt });

  beforeEach(() => {
    registry = new MessageRegistry();
    updates = [];
    registry.onDidUpdateMessages((update) => updates.push(update));
  });

  afterEach(() => registry.dispose());

  it("commits every snapshot synchronously", () => {
    registry.set({ messages: [message("one")], linter, buffer: null });
    expect(updates.length).toBe(1);
    expect(updates[0].added[0].excerpt).toBe("one");
  });

  it("commits deletions synchronously", () => {
    registry.set({ messages: [message("one")], linter, buffer: null });
    registry.deleteByLinter(linter);

    expect(updates.length).toBe(2);
    expect(updates[1].removed[0].excerpt).toBe("one");
    expect(registry.messages).toEqual([]);
  });

  it("processes a snapshot published reentrantly by an update listener", () => {
    let reentered = false;
    registry.onDidUpdateMessages(() => {
      if (reentered) return;
      reentered = true;
      registry.set({ messages: [message("two")], linter, buffer: null });
    });

    registry.set({ messages: [message("one")], linter, buffer: null });

    expect(updates.length).toBe(2);
    expect(updates[1].added[0].excerpt).toBe("two");
    expect(updates[1].removed[0].excerpt).toBe("one");
  });
});
