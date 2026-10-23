const timers = require("node:timers");

describe("Indie delegate asynchronous preparation", () => {
  let delegate, delegates, IndieDelegate;
  const filePath = "/indie-async.py";
  const message = (excerpt, file = filePath, row = 0) => ({
    severity: "warning",
    excerpt,
    location: {
      file,
      position: [
        [row, 0],
        [row, 1],
      ],
    },
  });
  const nextTurn = () => new Promise((resolve) => timers.setImmediate(resolve));
  const until = async (predicate) => {
    for (let turn = 0; turn < 500; turn++) {
      if (predicate()) return;
      await nextTurn();
    }
    throw new Error("Preparation did not reach the requested slice");
  };
  const forceSlices = () => {
    let elapsed = 0;
    spyOn(performance, "now").and.callFake(() => (elapsed += 5));
  };
  const batch = (count = 24, file = filePath) =>
    Array.from({ length: count }, (_, index) => message(`message-${index}`, file, index));

  beforeEach(() => {
    jasmine.useRealClock();
    IndieDelegate = require("../lib/indie-delegate");
    delegate = new IndieDelegate({ name: "async-spec", markerInvalidation: "never" }, 2);
    delegates = [delegate];
    spyOn(lumine.notifications, "addWarning");
    spyOn(console, "debug");
  });
  afterEach(() => {
    for (const value of delegates) value.dispose();
  });

  it("does no report traversal before yielding and publishes one complete replacement", async () => {
    forceSlices();
    delegate.setMessages(filePath, [message("old")]);
    let reads = 0;
    const messages = batch();
    for (const entry of messages)
      Object.defineProperty(entry, "excerpt", {
        enumerable: true,
        get() {
          reads++;
          return "new";
        },
      });
    const updates = [];
    delegate.onDidUpdate((update) => updates.push(update));
    const pending = delegate.setMessagesAsync(filePath, messages);
    expect(reads).toBe(0);
    expect(delegate.getMessages()[0].excerpt).toBe("old");
    await until(() => reads > 0);
    expect(reads).toBeLessThan(messages.length);
    expect(updates).toEqual([]);
    expect(delegate.getMessages()[0].excerpt).toBe("old");
    expect(await pending).toBe(true);
    expect(updates.length).toBe(1);
    expect(updates[0].length).toBe(messages.length);
    expect(updates[0].every((entry) => entry.version === 2)).toBe(true);
    expect(updates[0].affectedFiles).toEqual([require("../lib/helpers").normalizePath(filePath)]);
  });

  it("matches synchronous normalized metadata and shares range conversions across slices", async () => {
    forceSlices();
    const { Range, Point } = require("lumine");
    const make = () =>
      Array.from({ length: 4 }, (_, row) => ({
        ...message("metadata", filePath, row),
        code: 0,
        source: "compiler",
        tags: ["deprecated", "unnecessary", "deprecated"],
        reference: { file: "/reference.py", position: [row, 2] },
        relatedInformation: [
          {
            message: "related",
            location: {
              file: "/related.py",
              position: [
                [row, 1],
                [row, 3],
              ],
            },
          },
        ],
      }));
    const sync = new IndieDelegate({ name: "async-spec", markerInvalidation: "never" }, 2);
    delegates.push(sync);
    sync.setMessages(filePath, make());
    const messages = make(),
      helpers = require("../lib/helpers");
    spyOn(Range, "fromObject").and.callThrough();
    spyOn(helpers, "createMessageNormalizer").and.callThrough();
    expect(await delegate.setMessagesAsync(filePath, messages)).toBe(true);
    expect(delegate.getMessages()).toEqual(sync.getMessages());
    expect(Range.fromObject.calls.count()).toBe(8);
    expect(helpers.createMessageNormalizer).toHaveBeenCalledTimes(1);
    expect(
      messages.every(
        (entry) =>
          entry.location.position instanceof Range && entry.reference.position instanceof Point,
      ),
    ).toBe(true);
    expect(messages.every((entry) => helpers.getMarkerInvalidation(entry) === "never")).toBe(true);
  });

  it("returns false with the same single validation warning and leaves the previous report intact", async () => {
    forceSlices();
    delegate.setMessages(filePath, [message("old")]);
    const invalid = () => [
      message("valid"),
      { ...message("invalid"), severity: "wrong", source: 12 },
    ];
    const sync = new IndieDelegate({ name: "async-spec" }, 2);
    delegates.push(sync);
    sync.setMessages(filePath, invalid());
    const warning = lumine.notifications.addWarning.calls.mostRecent().args;
    lumine.notifications.addWarning.calls.reset();
    const entries = invalid();
    expect(await delegate.setMessagesAsync(filePath, entries)).toBe(false);
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
    expect(lumine.notifications.addWarning.calls.mostRecent().args).toEqual(warning);
    expect(entries.every((entry) => entry.version === undefined)).toBe(true);
    expect(delegate.getMessages()[0].excerpt).toBe("old");
  });

  it("rejects proxy batches without reading their traps", async () => {
    const trap = jasmine.createSpy("proxy read").and.throwError("Unexpected proxy read");
    const entries = new Proxy([], { get: trap });
    expect(await delegate.setMessagesAsync(filePath, entries)).toBe(false);
    expect(trap).not.toHaveBeenCalled();
    expect(lumine.notifications.addWarning).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid parameters and mismatched paths without replacing a report", async () => {
    delegate.setMessages(filePath, [message("old")]);
    await expectAsync(delegate.setMessagesAsync(null, [])).toBeRejectedWithError(
      "Invalid Parameters to setMessagesAsync()",
    );
    await expectAsync(delegate.setMessagesAsync(filePath, null)).toBeRejectedWithError(
      "Invalid Parameters to setMessagesAsync()",
    );
    const entries = [message("wrong file", "/other.py"), message("later")];
    await expectAsync(delegate.setMessagesAsync(filePath, entries)).toBeRejectedWithError(
      "message.location.file does not match the given filePath",
    );
    expect(entries.every((entry) => entry.version === 2)).toBe(true);
    expect(delegate.getMessages()[0].excerpt).toBe("old");
  });

  for (const action of ["sync", "async", "delete", "clear", "all", "dispose", "abort"]) {
    it(`invalidates pending preparation on ${action}`, async () => {
      forceSlices();
      delegate.setMessages(filePath, [message("old")]);
      const controller = new AbortController();
      const pending = delegate.setMessagesAsync(filePath, batch(), { signal: controller.signal });
      await nextTurn();
      if (action === "sync") delegate.setMessages(filePath, [message("replacement")]);
      if (action === "async")
        expect(await delegate.setMessagesAsync(filePath, [message("replacement")])).toBe(true);
      if (action === "delete") delegate.deleteFilePath(filePath);
      if (action === "clear") delegate.clearMessages();
      if (action === "all") delegate.setAllMessages([message("replacement")]);
      if (action === "dispose") delegate.dispose();
      if (action === "abort") controller.abort();
      expect(await pending).toBe(false);
      const expected = ["sync", "async", "all"].includes(action)
        ? ["replacement"]
        : action === "abort"
          ? ["old"]
          : [];
      expect(delegate.getMessages().map((entry) => entry.excerpt)).toEqual(expected);
      expect(delegate.pendingPreparations.size).toBe(0);
    });
  }

  it("deletes preparation even when the file has no published report yet", async () => {
    const updates = [];
    delegate.onDidUpdate((update) => updates.push(update));
    const pending = delegate.setMessagesAsync(filePath, batch());
    delegate.deleteFilePath(filePath);
    expect(await pending).toBe(false);
    expect(updates).toEqual([]);
  });

  it("uses the same normalized file identity for sync replacement and pending cancellation", async () => {
    const alias = process.platform === "win32" ? filePath.toUpperCase() : filePath;
    const pending = delegate.setMessagesAsync(filePath, batch());
    delegate.setMessages(alias, [message("replacement", alias)]);
    expect(await pending).toBe(false);
    expect(delegate.getMessages().map((entry) => entry.excerpt)).toEqual(["replacement"]);
  });

  it("keeps separate files independent and includes their latest reports in the committed snapshot", async () => {
    forceSlices();
    const other = "/other-async.py",
      messages = batch();
    const pending = delegate.setMessagesAsync(filePath, messages);
    delegate.setMessages(other, [message("other", other)]);
    const updates = [];
    delegate.onDidUpdate((update) => updates.push(update));
    expect(await pending).toBe(true);
    expect(updates.length).toBe(1);
    expect(updates[0].length).toBe(messages.length + 1);
    expect(updates[0][0].excerpt).toBe("other");
    expect(updates[0].affectedFiles).toEqual([require("../lib/helpers").normalizePath(filePath)]);
  });

  it("aborts during normalization without leaking partially normalized entries into the current report", async () => {
    forceSlices();
    delegate.setMessages(filePath, [message("old")]);
    const entries = batch(),
      controller = new AbortController(),
      updates = [];
    delegate.onDidUpdate((update) => updates.push(update));
    const pending = delegate.setMessagesAsync(filePath, entries, { signal: controller.signal });
    await until(() => entries.some((entry) => entry.version === 2));
    expect(entries.every((entry) => entry.version === 2)).toBe(false);
    controller.abort();
    expect(await pending).toBe(false);
    expect(updates).toEqual([]);
    expect(delegate.getMessages()[0].excerpt).toBe("old");
  });

  it("drops a caller-invalidated report between slices", async () => {
    forceSlices();
    let current = true;
    const pending = delegate.setMessagesAsync(filePath, batch(), { isCurrent: () => current });
    await nextTurn();
    current = false;
    expect(await pending).toBe(false);
    expect(delegate.getMessages()).toEqual([]);
  });

  it("does not let an already obsolete invocation supersede a valid preparation", async () => {
    forceSlices();
    const pending = delegate.setMessagesAsync(filePath, batch());
    expect(
      await delegate.setMessagesAsync(filePath, [message("obsolete")], { isCurrent: () => false }),
    ).toBe(false);
    expect(await pending).toBe(true);
    expect(delegate.getMessages().length).toBe(24);
  });

  it("rechecks ownership after the caller predicate synchronously replaces the file", async () => {
    let replace = false;
    const pending = delegate.setMessagesAsync(filePath, batch(), {
      isCurrent: () => {
        if (replace) {
          replace = false;
          delegate.setMessages(filePath, [message("replacement")]);
        }
        return true;
      },
    });
    replace = true;
    expect(await pending).toBe(false);
    expect(delegate.getMessages()[0].excerpt).toBe("replacement");
  });

  it("preserves a newer report published from the completed update callback", async () => {
    let replaced = false;
    delegate.onDidUpdate(() => {
      if (!replaced) {
        replaced = true;
        delegate.setMessages(filePath, [message("newer")]);
      }
    });
    expect(await delegate.setMessagesAsync(filePath, [message("prepared")])).toBe(true);
    expect(delegate.getMessages()[0].excerpt).toBe("newer");
  });

  it("does not start a replacement preparation from a destruction callback", async () => {
    let replacement;
    delegate.onDidDestroy(() => {
      replacement = delegate.setMessagesAsync(filePath, [message("retired")]);
    });
    const pending = delegate.setMessagesAsync(filePath, batch());
    delegate.dispose();
    expect(await pending).toBe(false);
    expect(await replacement).toBe(false);
    expect(delegate.getMessages()).toEqual([]);
    expect(delegate.pendingPreparations.size).toBe(0);
  });
});
