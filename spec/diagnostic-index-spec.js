const { Range } = require("lumine");
const {
  messagesAtPosition,
  messagesAtRow,
  nextMessage,
  previousMessage,
} = require("../lib/diagnostic-index");

describe("diagnostic index", () => {
  let editor, buffer, state, markers;

  beforeEach(() => {
    editor = lumine.workspace.buildTextEditor();
    editor.setText(Array(200).fill("abcdefghijklmnop").join("\n"));
    buffer = editor.getBuffer();
    state = buffer.linterUI = {
      messages: [],
      markerMessages: new Map(),
      unmarkedMessages: [],
      indexRowsOrdered: true,
      hasProjectedMessages: false,
      severityLayers: Object.fromEntries(
        ["error", "warning", "info", "hint"].map((severity) => [severity, buffer.addMarkerLayer()]),
      ),
    };
    markers = [];
  });

  afterEach(() => {
    delete buffer.linterUI;
    editor.destroy();
    if (!buffer.isDestroyed()) buffer.destroy();
  });

  function add(range, { severity = "warning", snapshot = range, native = true } = {}) {
    const ordinal = state.messages.length;
    const message = {
      key: `diagnostic-${ordinal}`,
      severity,
      excerpt: `diagnostic ${ordinal}`,
      location: { buffer, position: Range.fromObject(snapshot) },
    };
    state.messages.push(message);
    const record = { message, ordinal };
    if (native) {
      const marker = state.severityLayers[severity].markRange(range, {
        invalidate: "never",
        exclusive: true,
      });
      markers.push(marker);
      state.markerMessages.set(marker.id, record);
      Object.defineProperty(message.location, "displayRange", {
        configurable: true,
        enumerable: true,
        get: () => marker.getRange(),
      });
    } else {
      message.location.displayRange = Range.fromObject(range);
      state.unmarkedMessages.push(record);
    }
    return message;
  }

  it("finds a late diagnostic without reading unrelated native ranges", () => {
    const messages = Array.from({ length: 200 }, (_, row) =>
      add([
        [row, 2],
        [row, 5],
      ]),
    );
    const reads = markers.map((marker) => spyOn(marker, "getRange").and.callThrough());

    expect(
      messagesAtPosition(buffer, { row: 199, column: 3 }).map((message) => message.key),
    ).toEqual([messages[199].key]);
    expect(messagesAtRow(buffer, 199).map((message) => message.key)).toEqual([messages[199].key]);

    expect(reads.every((read) => read.calls.count() === 0)).toBe(true);
  });

  it("preserves ordinals across severity layers and multiline overlaps", () => {
    const first = add([
      [2, 2],
      [8, 5],
    ]);
    const second = add(
      [
        [5, 8],
        [5, 12],
      ],
      { severity: "error" },
    );

    expect(messagesAtRow(buffer, 5)).toEqual([first, second]);
    expect(messagesAtPosition(buffer, { row: 5, column: 3 })).toEqual([first]);
    expect(messagesAtPosition(buffer, { row: 8, column: 5 })).toEqual([first]);
  });

  it("merges static diagnostics with native candidates in snapshot order", () => {
    const first = add(
      [
        [5, 2],
        [5, 8],
      ],
      { native: false, severity: "unknown" },
    );
    const second = add([
      [5, 3],
      [5, 6],
    ]);

    expect(messagesAtPosition(buffer, { row: 5, column: 4 })).toEqual([first, second]);
    expect(messagesAtRow(buffer, 5)).toEqual([first, second]);
  });

  it("returns the latest message object associated with a standing marker", () => {
    const previous = add([
      [5, 2],
      [5, 8],
    ]);
    const latest = { ...previous, excerpt: "updated details" };
    state.messages[0] = latest;
    state.markerMessages.get(markers[0].id).message = latest;

    expect(messagesAtPosition(buffer, { row: 5, column: 4 })[0]).toBe(latest);
  });

  it("follows anchors moved by an earlier edit", () => {
    const message = add([
      [5, 2],
      [5, 8],
    ]);

    buffer.insert([0, 0], "prefix\n");

    expect(messagesAtPosition(buffer, { row: 5, column: 4 })).toEqual([]);
    expect(messagesAtPosition(buffer, { row: 6, column: 4 })).toEqual([message]);
  });

  it("uses the painted span of an end-of-line insertion-point diagnostic", () => {
    const message = add(
      [
        [0, 0],
        [0, 16],
      ],
      {
        snapshot: [
          [0, 16],
          [0, 16],
        ],
      },
    );

    expect(messagesAtPosition(buffer, { row: 0, column: 3 })).toEqual([message]);
  });

  it("keeps column-order ties in ordinal order when a painted span starts earlier", () => {
    const first = add([
      [0, 6],
      [0, 12],
    ]);
    const second = add(
      [
        [0, 0],
        [0, 16],
      ],
      {
        snapshot: [
          [0, 16],
          [0, 16],
        ],
      },
    );

    expect(nextMessage(buffer, { row: 0, column: 2 })).toBe(first);
    expect(previousMessage(buffer, { row: 0, column: 9 })).toBe(second);
  });

  it("finds adjacent messages with strict start comparisons and wraps at the ends", () => {
    const first = add([
      [2, 2],
      [2, 5],
    ]);
    const middle = add([
      [10, 2],
      [10, 5],
    ]);
    const last = add([
      [190, 2],
      [190, 5],
    ]);
    const reads = markers.map((marker) => spyOn(marker, "getRange").and.callThrough());

    expect(nextMessage(buffer, { row: 50, column: 0 }).key).toBe(last.key);
    expect(previousMessage(buffer, { row: 50, column: 0 }).key).toBe(middle.key);
    expect(nextMessage(buffer, { row: 190, column: 2 }).key).toBe(first.key);
    expect(previousMessage(buffer, { row: 2, column: 2 }).key).toBe(last.key);
    expect(reads.every((read) => read.calls.count() === 0)).toBe(true);
  });

  it("keeps legacy navigation order for projected spans whose rows are unordered", () => {
    const first = add(
      [
        [60, 2],
        [60, 5],
      ],
      {
        snapshot: [
          [2, 2],
          [2, 5],
        ],
      },
    );
    const second = add(
      [
        [20, 2],
        [20, 5],
      ],
      {
        snapshot: [
          [10, 2],
          [10, 5],
        ],
      },
    );
    state.indexRowsOrdered = false;

    expect(nextMessage(buffer, { row: 0, column: 0 })).toBe(first);
    expect(previousMessage(buffer, { row: 100, column: 0 })).toBe(second);
    expect(messagesAtPosition(buffer, { row: 20, column: 3 })).toEqual([second]);
  });

  it("validates dirty row ordering once before repeated indexed navigation", () => {
    for (let row = 0; row < 20; row++)
      add([
        [row, 2],
        [row, 5],
      ]);
    state.indexRowsOrdered = null;
    const reads = markers.map((marker) => spyOn(marker, "getRange").and.callThrough());

    expect(nextMessage(buffer, { row: 10, column: 0 }).key).toBe(state.messages[10].key);
    expect(state.indexRowsOrdered).toBe(true);
    expect(reads.reduce((count, read) => count + read.calls.count(), 0)).toBe(20);
    for (const read of reads) read.calls.reset();

    expect(nextMessage(buffer, { row: 11, column: 0 }).key).toBe(state.messages[11].key);
    expect(reads.every((read) => read.calls.count() === 0)).toBe(true);
  });

  it("clears ordinary anchor drift after all live rows match their snapshots again", () => {
    add([
      [5, 2],
      [5, 5],
    ]);
    state.indexRowsOrdered = null;
    state.anchorRowsMoved = true;

    nextMessage(buffer, { row: 0, column: 0 });

    expect(state.indexRowsOrdered).toBe(true);
    expect(state.anchorRowsMoved).toBe(false);
  });

  it("keeps anchor drift while a live row differs from its provider snapshot", () => {
    add(
      [
        [25, 2],
        [25, 5],
      ],
      {
        snapshot: [
          [5, 2],
          [5, 5],
        ],
      },
    );
    state.indexRowsOrdered = null;
    state.anchorRowsMoved = true;

    nextMessage(buffer, { row: 0, column: 0 });

    expect(state.anchorRowsMoved).toBe(true);
  });

  it("does not clear projected topology drift solely because its rows currently match", () => {
    add([
      [5, 2],
      [5, 5],
    ]);
    state.indexRowsOrdered = null;
    state.anchorRowsMoved = true;
    state.hasProjectedMessages = true;

    nextMessage(buffer, { row: 0, column: 0 });

    expect(state.anchorRowsMoved).toBe(true);
  });

  it("retains linear navigation for mixed static snapshots and moved anchors", () => {
    const first = add(
      [
        [25, 2],
        [25, 5],
      ],
      {
        snapshot: [
          [5, 2],
          [5, 5],
        ],
      },
    );
    const second = add(
      [
        [6, 2],
        [6, 5],
      ],
      { native: false },
    );

    expect(nextMessage(buffer, { row: 0, column: 0 })).toBe(first);
    expect(previousMessage(buffer, { row: 100, column: 0 })).toBe(second);
  });

  it("falls back to message ranges when native metadata is unavailable", () => {
    const message = add(
      [
        [5, 2],
        [5, 8],
      ],
      { native: false },
    );
    delete state.markerMessages;

    expect(messagesAtPosition(buffer, { row: 5, column: 4 })).toEqual([message]);
    expect(nextMessage(buffer, { row: 0, column: 0 })).toBe(message);
  });

  it("falls back while a marker-message mapping is being rebuilt", () => {
    const message = add([
      [5, 2],
      [5, 8],
    ]);
    state.markerMessages.clear();
    state.diagnosticIndexReady = false;

    expect(messagesAtPosition(buffer, { row: 5, column: 4 })).toEqual([message]);
    expect(nextMessage(buffer, { row: 0, column: 0 })).toBe(message);
  });

  it("leaves a disposed buffer's diagnostic state inert", () => {
    add([
      [5, 2],
      [5, 8],
    ]);
    delete buffer.linterUI;

    expect(messagesAtPosition(buffer, { row: 5, column: 4 })).toEqual([]);
    expect(messagesAtRow(buffer, 5)).toEqual([]);
    expect(nextMessage(buffer, { row: 0, column: 0 })).toBeUndefined();
  });
});
