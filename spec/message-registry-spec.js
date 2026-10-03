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

  it("keeps same-name providers independent when publishing and removing snapshots", () => {
    const first = { name: "shared" };
    const second = { name: "shared" };
    const one = message("one");
    const two = message("two");
    registry.set({ messages: [one], linter: first, buffer: null });
    registry.set({ messages: [two], linter: second, buffer: null });

    expect(registry.messages).toEqual([one, two]);
    registry.deleteByLinter(first);

    expect(registry.messages).toEqual([two]);
    expect(updates[2].removed).toEqual([one]);
    const replacement = message("replacement");
    registry.set({ messages: [replacement], linter: first, buffer: null });
    expect(registry.messages).toEqual([two, replacement]);
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

  it("retains one canonical object for an equivalent same-key snapshot", () => {
    const first = message("same");
    const replacement = message("same");
    registry.set({ messages: [first], linter, buffer: null });
    registry.set({ messages: [replacement], linter, buffer: null });

    expect(updates.length).toBe(1);
    expect(registry.messages[0]).toBe(first);
    expect(registry.messagesMap.values().next().value.oldMessages[0]).toBe(first);
    expect(registry.deleteMessages([first])).toBe(true);
    expect(registry.messages).toEqual([]);
  });

  it("publishes updated quick fixes without removing the diagnostic", () => {
    const first = { ...message("same"), solutions: [{ title: "old", replaceWith: "old" }] };
    const replacement = { ...message("same"), solutions: [{ title: "new", replaceWith: "new" }] };
    registry.set({ messages: [first], linter, buffer: null });
    registry.set({ messages: [replacement], linter, buffer: null });

    expect(updates[1].added).toEqual([]);
    expect(updates[1].removed).toEqual([]);
    expect(updates[1].updated).toEqual([replacement]);
    expect(registry.messages[0]).toBe(replacement);
    expect(registry.messagesMap.values().next().value.oldMessages[0]).toBe(replacement);
    expect(registry.deleteMessages([replacement])).toBe(true);
    expect(registry.messages).toEqual([]);
  });

  it("retains equivalent replacement solution records", () => {
    const first = { ...message("same"), solutions: [{ title: "fix", replaceWith: "fixed" }] };
    const replacement = { ...message("same"), solutions: [{ title: "fix", replaceWith: "fixed" }] };
    registry.set({ messages: [first], linter, buffer: null });
    registry.set({ messages: [replacement], linter, buffer: null });

    expect(updates.length).toBe(1);
    expect(registry.messages[0]).toBe(first);
  });

  it("refreshes a lazy description for each replacement snapshot", async () => {
    const { resolveDescription } = require("../lib/helpers");
    let detail = "old";
    const description = () => detail;
    const first = { ...message("same"), description };
    registry.set({ messages: [first], linter, buffer: null });
    expect(await resolveDescription(first)).toBe("old");
    detail = "new";
    const replacement = { ...message("same"), description };
    registry.set({ messages: [replacement], linter, buffer: null });

    expect(updates[1].updated).toEqual([replacement]);
    expect(await resolveDescription(registry.messages[0])).toBe("new");
  });

  it("refreshes provider extension fields outside the diagnostic key", () => {
    const oldContext = { version: 1 };
    const first = { ...message("same"), context: oldContext };
    const replacement = { ...message("same"), context: { version: 2 } };
    registry.set({ messages: [first], linter, buffer: null });
    registry.set({ messages: [replacement], linter, buffer: null });

    expect(updates[1].updated).toEqual([first]);
    expect(registry.messages[0]).toBe(first);
    expect(first.context).toBe(replacement.context);
    expect(oldContext.version).toBe(1);
    expect(registry.messages[0].context.version).toBe(2);
    expect(registry.deleteMessages([first])).toBe(true);
    expect(registry.messages).toEqual([]);
  });

  it("retains an unchanged extension reference without another notification", () => {
    const context = { version: 1 };
    const first = { ...message("same"), context };
    registry.set({ messages: [first], linter, buffer: null });
    registry.set({ messages: [{ ...message("same"), context }], linter, buffer: null });

    expect(updates.length).toBe(1);
    expect(registry.messages[0]).toBe(first);
  });

  it("removes omitted writable extension fields from the canonical record", () => {
    const first = { ...message("same"), context: { version: 1 } };
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [message("same")], linter, buffer: null });

    expect(registry.messages[0]).toBe(first);
    expect(Object.hasOwn(first, "context")).toBe(false);
    expect(updates[1].updated).toEqual([first]);
  });

  it("reconciles writable non-enumerable and symbolic extensions", () => {
    const symbol = Symbol("extension");
    const first = message("same");
    const replacement = message("same");
    Object.defineProperty(first, "hidden", { value: "old", writable: true, configurable: true });
    Object.defineProperty(replacement, "hidden", {
      value: "new",
      writable: true,
      configurable: true,
    });
    first[symbol] = "old";
    replacement[symbol] = "new";
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [replacement], linter, buffer: null });

    expect(registry.messages[0]).toBe(first);
    expect(first.hidden).toBe("new");
    expect(first[symbol]).toBe("new");
    expect(Object.getOwnPropertyDescriptor(first, "hidden").enumerable).toBe(false);
    expect(updates[1].updated).toEqual([first]);
  });

  it("replaces extension keys when their count stays the same", () => {
    const oldSymbol = Symbol("extension");
    const newSymbol = Symbol("extension");
    const first = { ...message("same"), removed: "old", [oldSymbol]: "old" };
    const replacement = { ...message("same"), added: "new", [newSymbol]: "new" };
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [replacement], linter, buffer: null });

    expect(registry.messages[0]).toBe(first);
    expect(Object.hasOwn(first, "removed")).toBe(false);
    expect(Object.hasOwn(first, oldSymbol)).toBe(false);
    expect(first.added).toBe("new");
    expect(first[newSymbol]).toBe("new");
    expect(updates[1].updated).toEqual([first]);
  });

  it("refreshes extensions with the same keys in a different order", () => {
    const first = { ...message("same"), alpha: { value: "old" }, beta: "old" };
    const replacement = { ...message("same"), beta: "new", alpha: { value: "new" } };
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [replacement], linter, buffer: null });

    expect(registry.messages[0]).toBe(first);
    expect(first.alpha).toBe(replacement.alpha);
    expect(first.beta).toBe("new");
    expect(updates[1].updated).toEqual([first]);
  });

  it("keeps separate metadata for duplicated canonical object occurrences", () => {
    const original = { ...message("same"), context: { version: 0 } };
    const first = { ...message("same"), context: { version: 1 } };
    const second = { ...message("same"), context: { version: 2 } };
    registry.set({ messages: [original, original], linter, buffer: null });

    registry.set({ messages: [first, second], linter, buffer: null });

    expect(registry.messages.map((entry) => entry.context.version)).toEqual([1, 2]);
    expect(original.context.version).toBe(0);
  });

  it("does not patch a location shared with an unchanged diagnostic", () => {
    const shared = {
      position: [
        [0, 0],
        [0, 1],
      ],
      extension: "old",
    };
    const first = { ...message("one"), location: shared };
    const other = { ...message("two"), location: shared };
    const replacement = {
      ...message("one"),
      location: {
        position: [
          [0, 0],
          [0, 1],
        ],
        extension: "new",
      },
    };
    registry.set({ messages: [first, other], linter, buffer: null });

    registry.set({ messages: [replacement, other], linter, buffer: null });

    expect(registry.messages[0]).toBe(replacement);
    expect(other.location.extension).toBe("old");
    expect(first.location.extension).toBe("old");
  });

  it("does not patch a target reused by a fresh incoming diagnostic", () => {
    const shared = {
      position: [
        [0, 0],
        [0, 1],
      ],
      extension: "old",
    };
    const first = { ...message("one"), location: shared };
    const other = {
      ...message("two"),
      location: {
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };
    const replacement = {
      ...message("one"),
      location: {
        position: [
          [0, 0],
          [0, 1],
        ],
        extension: "new",
      },
    };
    const incomingOther = {
      ...message("two"),
      location: shared,
      solutions: [{ title: "new fix" }],
    };
    registry.set({ messages: [first, other], linter, buffer: null });

    registry.set({ messages: [replacement, incomingOther], linter, buffer: null });

    expect(registry.messages[0]).toBe(replacement);
    expect(registry.messages[1]).toBe(incomingOther);
    expect(incomingOther.location.extension).toBe("old");
  });

  it("gathers extension changes before falling back for an incompatible field", () => {
    const first = { ...message("same"), context: "old" };
    Object.defineProperty(first, "locked", { value: "old" });
    const replacement = { ...message("same"), context: "new", locked: "new" };
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [replacement], linter, buffer: null });

    expect(registry.messages[0]).toBe(replacement);
    expect(first.context).toBe("old");
    expect(first.locked).toBe("old");
  });

  it("uses the latest getter owner for provider extension fields", () => {
    const first = message("same");
    const replacement = message("same");
    Object.defineProperty(first, "context", { get: () => "old", configurable: true });
    Object.defineProperty(replacement, "context", { get: () => "new", configurable: true });
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [replacement], linter, buffer: null });

    expect(registry.messages[0]).toBe(replacement);
    expect(first.context).toBe("old");
    expect(updates[1].updated).toEqual([replacement]);
  });

  it("does not invoke a rejected proxy's prototype trap", () => {
    const first = message("same");
    const prototypeTrap = jasmine.createSpy("prototype trap").and.throwError("should not run");
    const replacement = new Proxy(message("same"), { getPrototypeOf: prototypeTrap });
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [replacement], linter, buffer: null });

    expect(prototypeTrap).not.toHaveBeenCalled();
    expect(registry.messages[0] === replacement).toBe(true);
  });

  it("retains equivalent plain diagnostic records from another JavaScript realm", () => {
    const vm = require("node:vm");
    const first = vm.runInNewContext("({key:'same',excerpt:'same'})");
    const replacement = vm.runInNewContext("({key:'same',excerpt:'same'})");
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [replacement], linter, buffer: null });

    expect(updates.length).toBe(1);
    expect(registry.messages[0] === first).toBe(true);
  });

  it("keeps fresh owners for declared getter payloads", () => {
    const first = message("same");
    const replacement = message("same");
    let nextTitle = "fix";
    Object.defineProperty(first, "solutions", { get: () => [{ title: "fix" }] });
    Object.defineProperty(replacement, "solutions", { get: () => [{ title: nextTitle }] });
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [replacement], linter, buffer: null });

    expect(registry.messages[0]).toBe(replacement);
    nextTitle = "new fix";
    expect(registry.messages[0].solutions[0].title).toBe("new fix");
  });

  it("uses fresh opaque location owners even when snapshot coordinates match", () => {
    class Location {
      #detail;
      constructor(detail) {
        this.file = "/opaque.js";
        this.position = [
          [0, 0],
          [0, 1],
        ];
        this.#detail = detail;
      }
      get detail() {
        return this.#detail;
      }
    }
    const first = { ...message("same"), location: new Location("old") };
    const replacement = { ...message("same"), location: new Location("new") };
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [replacement], linter, buffer: null });

    expect(registry.messages[0]).toBe(replacement);
    expect(registry.messages[0].location.detail).toBe("new");
  });

  it("removes omitted non-enumerable and symbolic writable extensions", () => {
    const symbol = Symbol("extension");
    const first = message("same");
    Object.defineProperty(first, "hidden", { value: "old", configurable: true, writable: true });
    first[symbol] = "old";
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [message("same")], linter, buffer: null });

    expect(registry.messages[0]).toBe(first);
    expect(Object.hasOwn(first, "hidden")).toBe(false);
    expect(Object.hasOwn(first, symbol)).toBe(false);
    expect(updates[1].updated).toEqual([first]);
  });

  it("preserves duplicate diagnostic counts when snapshots change", () => {
    const first = message("same");
    registry.set({ messages: [first], linter, buffer: null });
    registry.set({ messages: [message("same"), message("same")], linter, buffer: null });

    expect(registry.messages.length).toBe(2);
    expect(updates[1].added.length).toBe(1);
    expect(updates[1].removed.length).toBe(0);
    const canonical = registry.messages[0];
    registry.set({ messages: [message("same")], linter, buffer: null });

    expect(registry.messages.length).toBe(1);
    expect(registry.messages[0]).toBe(canonical);
    expect(updates[2].removed.length).toBe(1);
  });

  it("reports same-key snapshot ordering changes", () => {
    const first = message("one");
    const second = message("two");
    registry.set({ messages: [first, second], linter, buffer: null });
    registry.set({ messages: [message("two"), message("one")], linter, buffer: null });

    expect(registry.messages).toEqual([second, first]);
    expect(updates[1].added).toEqual([]);
    expect(updates[1].removed).toEqual([]);
    expect(updates[1].updated).toEqual([second, first]);
  });

  it("delivers a reentrant deletion after the addition to every subscriber", () => {
    const received = [];
    registry.onDidUpdateMessages((difference) => {
      if (difference.added.length) registry.deleteMessages(difference.added);
    });
    registry.onDidUpdateMessages((difference) => {
      received.push(difference.added.length ? "added" : "removed");
    });

    registry.set({ messages: [message("one")], linter, buffer: null });

    expect(received).toEqual(["added", "removed"]);
    expect(registry.messages).toEqual([]);
  });

  it("accepts a reentrant publication after its provider was cleared", () => {
    let replaced = false;
    registry.onDidUpdateMessages(() => {
      if (replaced) return;
      replaced = true;
      registry.deleteByLinter(linter);
      registry.set({ messages: [message("two")], linter, buffer: null });
    });

    registry.set({ messages: [message("one")], linter, buffer: null });

    expect(registry.messages.map((entry) => entry.excerpt)).toEqual(["two"]);
  });

  it("forwards affected-file hints while publishing the full message set", () => {
    const first = message("one");
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({
      messages: [message("one"), message("two")],
      linter,
      buffer: null,
      affectedFiles: ["/changed.py"],
    });

    expect(updates[1].affectedFiles).toEqual(["/changed.py"]);
    expect(updates[1].messages.length).toBe(2);
    expect(updates[1].messages).toContain(first);
  });

  it("refreshes non-enumerable declared payload fields", () => {
    const first = message("same");
    const replacement = message("same");
    Object.defineProperty(first, "solutions", { value: [{ title: "old" }] });
    Object.defineProperty(replacement, "solutions", { value: [{ title: "new" }] });
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [replacement], linter, buffer: null });

    expect(updates[1].updated).toEqual([replacement]);
    expect(registry.messages[0].solutions[0].title).toBe("new");
  });

  it("reports removal of a non-enumerable lazy description", () => {
    const first = message("same");
    Object.defineProperty(first, "description", { value: () => "old" });
    const replacement = message("same");
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [replacement], linter, buffer: null });

    expect(updates[1].updated).toEqual([replacement]);
    expect(registry.messages[0].description).toBeUndefined();
  });

  it("refreshes payload exposed by provider-owned prototype getters", () => {
    class Diagnostic {
      constructor(title) {
        this.key = "same";
        this.excerpt = "same";
        this.title = title;
      }

      get solutions() {
        return [{ title: this.title }];
      }
    }
    const first = new Diagnostic("old");
    const replacement = new Diagnostic("new");
    registry.set({ messages: [first], linter, buffer: null });

    registry.set({ messages: [replacement], linter, buffer: null });

    expect(updates[1].updated).toEqual([replacement]);
    expect(registry.messages[0].solutions[0].title).toBe("new");
  });

  it("unions pending file hints from reentrant snapshots", () => {
    let replaced = false;
    registry.onDidUpdateMessages(() => {
      if (replaced) return;
      replaced = true;
      registry.set({
        messages: [message("x")],
        linter,
        buffer: null,
        affectedFiles: ["/x.py"],
      });
      registry.set({
        messages: [message("x"), message("y")],
        linter,
        buffer: null,
        affectedFiles: ["/y.py"],
      });
    });

    registry.set({ messages: [message("first")], linter, buffer: null });

    expect(updates[1].affectedFiles).toEqual(["/x.py", "/y.py"]);
  });

  it("includes other entries' removed files beside a publication hint", () => {
    const otherLinter = { name: "other" };
    const other = { ...message("other"), location: { normalizedFile: "/other.py" } };
    registry.set({ messages: [other], linter: otherLinter, buffer: null });
    let replaced = false;
    registry.onDidUpdateMessages(() => {
      if (replaced) return;
      replaced = true;
      registry.deleteByLinter(otherLinter);
      registry.set({
        messages: [message("new")],
        linter,
        buffer: null,
        affectedFiles: ["/changed.py"],
      });
    });

    registry.set({ messages: [message("first")], linter, buffer: null });

    expect(updates[2].affectedFiles).toContain("/changed.py");
    expect(updates[2].affectedFiles).toContain("/other.py");
  });
});
