const timers = require("node:timers");

describe("MessageRegistry cooperative preparation", () => {
  let registry, updates, linter, helpers;
  const message = (key, fields = {}) => ({ key, excerpt: key, ...fields });
  const work = (current = () => true, onYield = () => {}) => ({
    current,
    yieldIfNeeded: () =>
      new Promise((resolve) =>
        timers.setImmediate(() => {
          onYield();
          resolve(current());
        }),
      ),
  });
  const request = (messages, linter, extra = {}) => ({ messages, linter, buffer: null, ...extra });

  beforeEach(() => {
    jasmine.useRealClock();
    registry = new (require("../lib/message-registry"))();
    helpers = require("../lib/helpers");
    updates = [];
    linter = { name: "prepared" };
    registry.onDidUpdateMessages((event) => updates.push(event));
  });
  afterEach(() => registry.dispose());

  it("prepares without publishing or changing canonical records, then skips sync diff", async () => {
    const retained = Array.from({ length: 64 }, (_, index) => message(`kept-${index}`));
    const old = [message("one"), message("two"), ...retained];
    registry.set(request(old, linter));
    const entry = [...registry.messagesMap.values()][0];
    const oldIndex = entry.keyIndex;
    const canonical = entry.oldMessages;
    const oldArray = registry.messages;
    const input = request(
      [message("two"), message("three"), ...retained.map((item) => message(item.key))],
      linter,
      { affectedFiles: ["/test"] },
    );
    let slices = 0;
    const preparation = await registry.prepare(
      input,
      work(
        () => true,
        () => {
          slices++;
          expect(registry.messages).toBe(oldArray);
          expect(entry.oldMessages).toBe(canonical);
          expect(entry.keyIndex).toBe(oldIndex);
          expect(updates.length).toBe(1);
        },
      ),
    );
    expect(slices).toBeGreaterThan(1);
    expect(preparation).not.toBeNull();
    spyOn(helpers, "flagMessages").and.callThrough();
    registry.set({ ...input, preparation });
    expect(helpers.flagMessages).not.toHaveBeenCalled();
    expect(updates.length).toBe(2);
    expect(updates[1].added).toEqual([input.messages[1]]);
    expect(updates[1].removed).toEqual([old[0]]);
    expect(registry.messages).toEqual([input.messages[1], old[1], ...retained]);
    expect(updates[1].affectedFiles).toEqual(["/test"]);
  });

  it("does not allocate registry state for a new provider before commit", async () => {
    const input = request([message("one")], linter);
    const preparation = await registry.prepare(input, work());
    expect(registry.messagesMap.size).toBe(0);
    expect(registry.nextProviderId).toBe(0);
    expect(registry.providerIds.has(linter)).toBe(false);
    expect(updates).toEqual([]);
    registry.set({ ...input, preparation });
    expect(registry.messages).toEqual(input.messages);
  });

  it("does not scan payloads for first reports or clearing", async () => {
    const unreadable = message("one");
    Object.defineProperty(unreadable, "extension", {
      get() {
        throw new Error("payload inspected");
      },
    });
    const input = request([unreadable], linter);
    expect(await registry.prepare(input, work())).not.toBeNull();
    registry.set(input);
    const clear = request([], linter);
    const preparation = await registry.prepare(clear, work());
    expect(preparation).not.toBeNull();
    registry.set({ ...clear, preparation });
    expect(registry.messages.length).toBe(0);
  });

  it("reads only keys for unmatched additions and removals", async () => {
    const old = message("old");
    const incoming = message("new");
    for (const value of [old, incoming]) {
      Object.defineProperty(value, "location", {
        get() {
          throw new Error("unmatched payload inspected");
        },
      });
    }
    registry.set(request([old], linter));
    const input = request([incoming], linter);
    const preparation = await registry.prepare(input, work());
    expect(preparation).not.toBeNull();
    registry.set({ ...input, preparation });
    expect(registry.messages[0] === incoming).toBe(true);
    expect(updates[1].removed[0] === old).toBe(true);
  });

  it("retains identical objects without reading their payload accessors", async () => {
    const old = message("same");
    Object.defineProperty(old, "location", {
      get() {
        throw new Error("identical payload inspected");
      },
    });
    registry.set(request([old], linter));
    const input = request([old], linter);
    const preparation = await registry.prepare(input, work());
    expect(preparation).not.toBeNull();
    registry.set({ ...input, preparation });
    expect(registry.messages[0] === old).toBe(true);
    expect(updates.length).toBe(1);
  });

  it("falls back without invoking a key getter", async () => {
    const old = message("old");
    registry.set(request([old], linter));
    const incoming = message("new");
    Object.defineProperty(incoming, "key", {
      get() {
        throw new Error("key getter invoked");
      },
    });
    expect(await registry.prepare(request([incoming], linter), work())).toBeNull();
  });

  it("falls back without invoking an array index getter", async () => {
    registry.set(request([message("old")], linter));
    const messages = [message("new")];
    Object.defineProperty(messages, "0", {
      get() {
        throw new Error("array index getter invoked");
      },
    });
    expect(await registry.prepare(request(messages, linter), work())).toBeNull();
  });

  it("uses the same registry bucket for null and omitted buffers", async () => {
    const old = message("old");
    registry.set(request([old], linter));
    const input = { messages: [message("new")], linter };
    registry.set({ ...input, preparation: await registry.prepare(input, work()) });
    expect(updates[1].removed).toEqual([old]);
    expect(registry.messages).toEqual(input.messages);
  });

  it("retains duplicate occurrence matching and reports reordered canonical records", async () => {
    const old = [message("a"), message("a"), message("b")];
    registry.set(request(old, linter));
    const input = request([message("b"), message("a"), message("a")], linter);
    registry.set({ ...input, preparation: await registry.prepare(input, work()) });
    expect(updates[1].added).toEqual([]);
    expect(updates[1].removed).toEqual([]);
    expect(updates[1].updated).toEqual([old[2], old[0], old[1]]);
    expect(registry.messages).toEqual([old[2], old[0], old[1]]);
  });

  it("retains the canonical array and emits nothing for equivalent fresh records", async () => {
    registry.set(request([message("one")], linter));
    const original = registry.messages;
    const input = request([message("one")], linter);
    registry.set({ ...input, preparation: await registry.prepare(input, work()) });
    expect(registry.messages).toBe(original);
    expect(updates.length).toBe(1);
  });

  it("ignores the UI-owned live displayRange getter during preparation", async () => {
    const location = {
      file: "/test",
      position: [
        [0, 0],
        [0, 1],
      ],
    };
    const old = message("one", { location });
    registry.set(request([old], linter));
    const getRange = jasmine.createSpy("marker.getRange").and.throwError("must not read marker");
    // Same enumerable/configurable accessor contract as bindMarkerMessage.
    Object.defineProperty(location, "displayRange", {
      enumerable: true,
      configurable: true,
      get: getRange,
      set(value) {
        Object.defineProperty(this, "displayRange", { value, writable: true, configurable: true });
      },
    });
    const input = request(
      [
        message("one", {
          location: {
            file: "/test",
            position: [
              [0, 0],
              [0, 1],
            ],
          },
        }),
      ],
      linter,
    );
    const preparation = await registry.prepare(input, work());
    expect(preparation).not.toBeNull();
    registry.set({ ...input, preparation });
    expect(registry.messages[0] === old).toBe(true);
    expect(getRange.calls.count()).toBe(0);
    expect(updates.length).toBe(1);
  });

  it("does not traverse shared opaque extension values or buffer identity metadata", async () => {
    const opaque = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("opaque graph inspected");
        },
      },
    );
    const location = () => ({
      buffer: opaque,
      position: [
        [0, 0],
        [0, 1],
      ],
    });
    const old = message("one", { extension: opaque, location: location() });
    registry.set(request([old], linter));
    const input = request([message("one", { extension: opaque, location: location() })], linter);
    const preparation = await registry.prepare(input, work());
    expect(preparation).not.toBeNull();
    registry.set({ ...input, preparation });
    expect(registry.messages[0] === old).toBe(true);
    expect(updates.length).toBe(1);
  });

  it("falls back for extension descriptor patches without touching canonical objects", async () => {
    const old = message("one", { extension: "before" });
    registry.set(request([old], linter));
    const input = request([message("one", { extension: "after" })], linter);
    const preparation = await registry.prepare(input, work());
    expect(preparation).toBeNull();
    expect(old.extension).toBe("before");
    expect(updates.length).toBe(1);
    registry.set({ ...input, preparation });
    expect(old.extension).toBe("after");
    expect(registry.messages[0]).toBe(old);
  });

  it("does not invoke extension getters while preparing an opaque fallback", async () => {
    registry.set(request([message("one")], linter));
    let reads = 0;
    const incoming = message("one");
    Object.defineProperty(incoming, "extension", {
      get() {
        reads++;
        return "opaque";
      },
    });
    const input = request([incoming], linter);
    expect(await registry.prepare(input, work())).toBeNull();
    expect(reads).toBe(0);
    registry.set(input);
    expect(registry.messages[0]).toBe(incoming);
  });

  for (const [name, mutate] of [
    ["set", (registry, linter) => registry.set(request([message("new")], linter))],
    ["delete", (registry) => registry.deleteAll()],
    ["delete by provider", (registry, linter) => registry.deleteByLinter(linter)],
    ["delete by buffer", (registry) => registry.deleteByBuffer(null)],
    ["delete messages", (registry) => registry.deleteMessages(registry.messages)],
    ["dispose", (registry) => registry.dispose()],
  ]) {
    it(`cancels preparation on ${name} between slices`, async () => {
      registry.set(request([message("one")], linter));
      let changed = false;
      const preparation = await registry.prepare(
        request([message("two")], linter),
        work(
          () => true,
          () => {
            if (!changed) {
              changed = true;
              mutate(registry, linter);
            }
          },
        ),
      );
      expect(preparation).toBeNull();
    });
  }

  it("cancels through the caller guard and handles reentrant mutation in that guard", async () => {
    registry.set(request([message("one")], linter));
    let current = true;
    expect(
      await registry.prepare(
        request([message("two")], linter),
        work(
          () => current,
          () => {
            current = false;
          },
        ),
      ),
    ).toBeNull();
    let reentered = false;
    expect(
      await registry.prepare(
        request([message("two")], linter),
        work(() => {
          if (!reentered) {
            reentered = true;
            registry.deleteAll();
          }
          return true;
        }),
      ),
    ).toBeNull();
  });

  it("recomputes a stale token rather than restoring a deleted canonical snapshot", async () => {
    const old = message("one");
    registry.set(request([old], linter));
    const input = request([message("one")], linter);
    const preparation = await registry.prepare(input, work());
    registry.deleteMessages([old]);
    spyOn(helpers, "flagMessages").and.callThrough();
    registry.set({ ...input, preparation });
    expect(helpers.flagMessages).toHaveBeenCalled();
    expect(updates[2].added).toEqual(input.messages);
    expect(registry.messages[0]).toBe(input.messages[0]);
  });

  it("rejects tokens for different input arrays and consumes a token only once", async () => {
    registry.set(request([message("one")], linter));
    const input = request([message("two")], linter);
    const preparation = await registry.prepare(input, work());
    spyOn(helpers, "flagMessages").and.callThrough();
    registry.set({ ...input, messages: [message("three")], preparation });
    registry.set({ ...input, preparation });
    expect(helpers.flagMessages.calls.count()).toBe(2);
    expect(registry.messages).toEqual(input.messages);
  });

  it("preserves listener publication ordering when a prepared commit reenters set", async () => {
    registry.set(request([message("one")], linter));
    const input = request([message("two")], linter);
    const preparation = await registry.prepare(input, work());
    let reentered = false;
    registry.onDidUpdateMessages(() => {
      if (!reentered) {
        reentered = true;
        registry.set(request([message("three")], linter));
      }
    });
    registry.set({ ...input, preparation });
    expect(updates.map((event) => event.messages.map((item) => item.key))).toEqual([
      ["one"],
      ["two"],
      ["three"],
    ]);
  });
});
