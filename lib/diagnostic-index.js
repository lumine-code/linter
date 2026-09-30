const { Point, Range } = require("lumine");

function messageRange(message) {
  return Range.fromObject(message.location.displayRange || message.location.position);
}

function indexedState(state) {
  return (
    state?.markerMessages instanceof Map &&
    Array.isArray(state.unmarkedMessages) &&
    state.diagnosticIndexReady !== false &&
    state.severityLayers
  );
}

function nativeRecords(state, query, matchesMarker = () => true) {
  const records = [];
  for (const layer of Object.values(state.severityLayers)) {
    for (const marker of layer.findMarkers(query)) {
      const record = state.markerMessages.get(marker.id);
      if (record && matchesMarker(marker)) records.push(record);
    }
  }
  return records;
}

function collect(buffer, query, matchesRange) {
  const state = buffer.linterUI;
  if (!state?.messages?.length) return [];
  if (!indexedState(state)) {
    return state.messages.filter((message) => matchesRange(messageRange(message)));
  }

  const records = nativeRecords(state, query);
  for (const record of state.unmarkedMessages) {
    if (matchesRange(messageRange(record.message))) records.push(record);
  }
  // Only severity markers are queried: tag markers paint the same diagnostic
  // again. The ordinal preserves the snapshot's order across severity layers
  // and the static fallback, including ties between overlapping diagnostics.
  records.sort((a, b) => a.ordinal - b.ordinal);
  return records.map(({ message }) => message);
}

function messagesAtPosition(buffer, position) {
  return collect(buffer, { containsPosition: position }, (range) => range.containsPoint(position));
}

function messagesAtRow(buffer, row) {
  return collect(
    buffer,
    { intersectsRow: row },
    (range) => range.start.row <= row && range.end.row >= row,
  );
}

function linearAdjacent(messages, position, direction) {
  if (direction > 0) {
    return (
      messages.find((message) => messageRange(message).start.isGreaterThan(position)) || messages[0]
    );
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messageRange(messages[index]).start.isLessThan(position)) return messages[index];
  }
  return messages[messages.length - 1];
}

function adjacentMessage(buffer, position, direction) {
  const state = buffer.linterUI;
  const messages = state?.messages;
  if (!messages?.length) return;
  position = Point.fromObject(position);
  // A notebook can paint a diagnostic at a different row from its snapshot.
  // Static snapshots mixed with moving anchors can change their relative row
  // order too. Those cases retain the established first/last ordinal search.
  if (!indexedState(state) || state.unmarkedMessages.length > 0) {
    return linearAdjacent(messages, position, direction);
  }
  if (state.indexRowsOrdered == null) {
    let previousRow = -Infinity;
    let rowsOrdered = true;
    let anchorRowsMoved = false;
    for (const message of messages) {
      const row = messageRange(message).start.row;
      if (row < previousRow) rowsOrdered = false;
      if (row !== message.location.position.start.row) anchorRowsMoved = true;
      previousRow = row;
    }
    state.indexRowsOrdered = rowsOrdered;
    // A normal provider refresh can put every anchor back at its snapshot.
    // Projected locations have their own topology, so only a state explicitly
    // known to have no projected messages can clear the sticky source flag.
    if (anchorRowsMoved || state.hasProjectedMessages === false) {
      state.anchorRowsMoved = anchorRowsMoved;
    }
  }
  if (!state.indexRowsOrdered) return linearAdjacent(messages, position, direction);

  const lastRow = buffer.getLastRow();
  let row = position.row;
  let windowRows = 1;
  while (row >= 0 && row <= lastRow) {
    const startRow = direction > 0 ? row : Math.max(0, row - windowRows + 1);
    const endRow = direction > 0 ? Math.min(lastRow, row + windowRows - 1) : row;
    const firstWindow = row === position.row;
    const start = Point(startRow, firstWindow && direction > 0 ? position.column : 0);
    const end = Point(endRow, firstWindow && direction < 0 ? position.column : Infinity);
    const records = nativeRecords(state, { startsInRange: Range(start, end) }, (marker) => {
      if (!firstWindow) return true;
      const markerStart = marker.getStartPosition();
      return direction > 0 ? markerStart.isGreaterThan(position) : markerStart.isLessThan(position);
    });
    if (records.length) {
      let selected = records[0];
      for (const record of records) {
        if (direction > 0 ? record.ordinal < selected.ordinal : record.ordinal > selected.ordinal) {
          selected = record;
        }
      }
      return selected.message;
    }
    // Searching starts after the cursor with one document-sized query would
    // materialize every later marker. Grow disjoint row windows only while no
    // candidate exists; dense files normally finish in the first two windows.
    row = direction > 0 ? endRow + 1 : startRow - 1;
    windowRows *= 8;
  }
  return direction > 0 ? messages[0] : messages[messages.length - 1];
}

function nextMessage(buffer, position) {
  return adjacentMessage(buffer, position, 1);
}

function previousMessage(buffer, position) {
  return adjacentMessage(buffer, position, -1);
}

module.exports = { messagesAtPosition, messagesAtRow, nextMessage, previousMessage };
