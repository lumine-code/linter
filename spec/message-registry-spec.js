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

  it("deletes a batch of messages in one update", () => {
    const one = message("one");
    const two = message("two");
    const three = message("three");
    registry.set({ messages: [one, two, three], linter, buffer: null });

    expect(registry.deleteMessages([one, three])).toBe(true);

    expect(updates.length).toBe(2);
    expect(updates[1].removed).toEqual([one, three]);
    expect(updates[1].added).toEqual([]);
    expect(registry.messages).toEqual([two]);
  });

  it("reports nothing to delete when none of the messages are known", () => {
    registry.set({ messages: [message("one")], linter, buffer: null });

    expect(registry.deleteMessages([message("other")])).toBe(false);
    expect(registry.deleteMessages([])).toBe(false);
    expect(updates.length).toBe(1);
  });

  it("does not resurrect a deleted message on the next snapshot", () => {
    const one = message("one");
    const two = message("two");
    registry.set({ messages: [one, two], linter, buffer: null });
    registry.deleteMessages([one]);

    // The provider republishes what it still believes: the deleted message is
    // an addition again, which is the same answer a fresh lint would give.
    registry.set({ messages: [one, two], linter, buffer: null });

    expect(updates[2].added).toEqual([one]);
    expect(registry.messages.map((m) => m.excerpt).sort()).toEqual(["one", "two"]);
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
