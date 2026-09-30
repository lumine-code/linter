const IndieDelegate = require("../lib/indie-delegate");

describe("lib/indie-delegate", () => {
  let delegate;
  const filePath = "/indie-spec.py";
  const message = (excerpt) => ({
    severity: "warning",
    excerpt,
    location: {
      file: filePath,
      position: [
        [0, 0],
        [0, 1],
      ],
    },
  });

  beforeEach(() => {
    delegate = new IndieDelegate({ name: "indie-spec" }, 2);
  });

  afterEach(() => delegate.dispose());

  it("clears its state before notifying subscribers", () => {
    delegate.setMessages(filePath, [message("old")]);
    const observed = [];
    delegate.onDidUpdate(() => observed.push(delegate.getMessages()));

    delegate.clearMessages();

    expect(observed).toEqual([[]]);
    expect(delegate.getMessages()).toEqual([]);
  });

  it("preserves a replacement published from a clear notification", () => {
    delegate.setMessages(filePath, [message("old")]);
    let replaced = false;
    delegate.onDidUpdate(() => {
      if (replaced) return;
      replaced = true;
      delegate.setMessages(filePath, [message("new")]);
    });

    delegate.clearMessages();

    expect(delegate.getMessages().map((entry) => entry.excerpt)).toEqual(["new"]);
  });

  it("reports the affected file while retaining the full delegate snapshot", () => {
    const otherPath = "/other-spec.py";
    const other = {
      ...message("other"),
      location: {
        file: otherPath,
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };
    delegate.setMessages(otherPath, [other]);
    const updates = [];
    delegate.onDidUpdate((update) => updates.push(update));

    delegate.setMessages(filePath, [message("current")]);

    expect(Array.isArray(updates[0])).toBe(true);
    expect(updates[0].affectedFiles).toEqual([filePath]);
    expect(updates[0].map((entry) => entry.excerpt)).toEqual(["other", "current"]);
    expect(Object.keys(updates[0])).toEqual(["0", "1"]);
  });
});
