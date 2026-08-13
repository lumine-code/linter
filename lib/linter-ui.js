const { CompositeDisposable, Range } = require("lumine");
const { getMarkerInvalidation, normalizePath } = require("./helpers");
const { SEVERITIES } = require("./severities");
const { TAGS } = require("./tags");

// Default thresholds for large file detection
const DEFAULT_LARGE_FILE_LINE_COUNT = 20000;
const DEFAULT_LONG_LINE_LENGTH = 4000;

/**
 * Returns a paintable range without changing the provider-owned diagnostic
 * range. Text decorations cannot render an empty span, so an insertion-point
 * diagnostic at end-of-line paints the whole line, matching the equivalent
 * range that spans from line-end to the next line's start. Elsewhere it borrows
 * the following character.
 * @param {TextBuffer} buffer
 * @param {Range} range
 * @returns {Range}
 */
function getDisplayRange(buffer, range) {
  const { start, end } = range;
  const lineLength = buffer.lineLengthForRow(start.row);
  // If range spans from line end to next line start, mark entire line.
  if (start.column >= lineLength && end.row === start.row + 1 && end.column === 0) {
    return new Range([start.row, 0], [start.row, lineLength]);
  }
  if (!range.isEmpty()) {
    return range;
  }

  const column = Math.min(start.column, lineLength);
  if (column >= lineLength && lineLength > 0) {
    return new Range([start.row, 0], [start.row, lineLength]);
  }
  if (column < lineLength) {
    return new Range([start.row, column], [start.row, column + 1]);
  }
  return range;
}

/**
 * Destroys every marker tracked for a message key and forgets the key.
 * A message owns one severity marker plus one marker per tag, so every teardown
 * path goes through here rather than assuming a single marker.
 * @param {Map<string, Array>} markerMap
 * @param {string} key
 */
function destroyMarkers(markerMap, key) {
  const markers = markerMap.get(key);
  if (!markers) {
    return;
  }
  for (const marker of markers) {
    marker.destroy();
  }
  markerMap.delete(key);
}

/**
 * Retires everything the UI put on a buffer. A marker layer outliving every
 * editor of its buffer keeps its markers and its index for nothing.
 * @param {TextBuffer} buffer
 */
function destroyBufferState(buffer) {
  const state = buffer.linterUI;
  if (!state) {
    return;
  }
  state.markerMap?.clear();
  const layers = [
    ...Object.values(state.severityLayers || {}),
    ...Object.values(state.tagLayers || {}),
  ];
  for (const layer of layers) {
    layer.clear();
    layer.destroy();
  }
  delete buffer.linterUI;
}

/**
 * Linter UI Controller
 * Manages the UI components for displaying linter messages.
 */
class LinterUI {
  constructor() {
    this.editor = null;
    this.activeItem = null;
    this.activeItemAdapter = null;
    this.itemAdapters = new Set();
    this.lintingStateProvider = null;
    this.allMessages = [];
    // Every buffer the UI has patched, against the number of editors showing
    // it. Kept rather than rederived: the buffer set is read twice per publish,
    // and asking the workspace means flattening every pane container's items.
    this.buffers = new Map();
    this.patchedEditors = new WeakSet();
    this.markerMessageOrigins = new WeakMap();
    this.largeFileLineCount = DEFAULT_LARGE_FILE_LINE_COUNT;
    this.longLineLength = DEFAULT_LONG_LINE_LENGTH;
    // Bumped whenever a threshold changes, so a buffer measured against the old
    // one is measured again. See isLargeFile.
    this.sizeGeneration = 0;
    this.idleCallbacks = new Set();
    // Messages whose markers an edit invalidated, waiting for one batched
    // delete. See queueMessageDeletion.
    this.pendingDeletions = new Set();
    this.deletionFlushScheduled = false;
    this.subscriptions = new CompositeDisposable();
    // One entry per live editor, removed as each is destroyed. Held apart from
    // the package-lifetime subscriptions, which would otherwise keep a spent
    // disposable for every editor opened in the session.
    this.editorSubscriptions = new CompositeDisposable();

    // Observe editors and active editor changes. Only pane items are patched;
    // an editor a package registered through `linter.editors` is patched by
    // that registration.
    this.subscriptions.add(
      lumine.workspace.observeTextEditors((editor) => {
        this.patchEditor(editor);
      }),
      lumine.workspace.getCenter().observeActivePaneItem((item) => {
        this.setActiveItem(item);
      }),
      lumine.config.observe("linter.largeFileLineCount", (value) => {
        this.largeFileLineCount = value || DEFAULT_LARGE_FILE_LINE_COUNT;
        this.sizeGeneration++;
      }),
      lumine.config.observe("linter.longLineLength", (value) => {
        this.longLineLength = value || DEFAULT_LONG_LINE_LENGTH;
        this.sizeGeneration++;
      }),
    );
  }

  /**
   * Disposes of all UI resources.
   */
  dispose() {
    // Cancel any pending idle callbacks
    this.idleCallbacks.forEach((callbackID) => window.cancelIdleCallback(callbackID));
    this.idleCallbacks.clear();
    // A queued deletion outliving the UI would ask a disposed registry to
    // publish. The flush is already scheduled; emptying the queue makes it a
    // no-op.
    this.pendingDeletions.clear();

    this.subscriptions.dispose();
    this.editorSubscriptions.dispose();

    // Cleanup marker layers from all buffers
    for (const buffer of this.getBuffers()) {
      destroyBufferState(buffer);
    }
    this.buffers.clear();
  }

  /**
   * Renders linter messages - called by core when messages change.
   * @param {Object} args - Object containing added, removed, and all messages
   */
  render(args) {
    this.allMessages = args.messages;
    this.assignMessages(args);
    this.updateMarkers();
  }

  /**
   * Checks if a buffer is considered "large" based on line count or line length.
   * @param {TextBuffer} buffer - The buffer to check
   * @returns {boolean} True if the buffer is large
   */
  isLargeBuffer(buffer) {
    const lineCount = buffer.getLineCount();
    if (lineCount > this.largeFileLineCount) {
      return true;
    }
    // Check for very long lines (sample first 100 lines for performance)
    const linesToCheck = Math.min(lineCount, 100);
    for (let i = 0; i < linesToCheck; i++) {
      if (buffer.lineLengthForRow(i) > this.longLineLength) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether this buffer is too large to decorate inline, answered again
   * whenever it or the thresholds have changed since the last answer.
   *
   * The verdict used to be taken once, when the buffer was patched: a file that
   * grew past the threshold went on being decorated, one that was generated
   * long and then emptied never got its decorations back, and neither setting
   * meant anything until the next session.
   * @param {Object} state - The buffer's linterUI state
   * @param {TextBuffer} buffer
   * @returns {boolean}
   */
  isLargeFile(state, buffer) {
    const lineCount = buffer.getLineCount();
    if (state.sizeLineCount !== lineCount || state.sizeGeneration !== this.sizeGeneration) {
      state.sizeLineCount = lineCount;
      state.sizeGeneration = this.sizeGeneration;
      state.isLargeFile = this.isLargeBuffer(buffer);
    }
    return state.isLargeFile;
  }

  /**
   * Patches an editor with linter marker layers for highlighting.
   * @param {TextEditor} editor - The text editor to patch
   */
  patchEditor(editor) {
    if (this.patchedEditors.has(editor)) {
      return;
    }
    this.patchedEditors.add(editor);

    const buffer = editor.getBuffer();
    this.buffers.set(buffer, (this.buffers.get(buffer) || 0) + 1);

    if (!buffer.linterUI) {
      buffer.linterUI = {
        severityLayers: {},
        // Tags are a second, orthogonal axis: a message carries none, one, or
        // both, at any severity. They get their own layers rather than a
        // severity x tag product because decorateMarkerLayer paints one class
        // on every marker in a layer. The editor merges overlapping text
        // decorations into a single span carrying every class, so the severity
        // class and the tag class arrive together and each axis stays
        // independently stylable.
        tagLayers: {},
        markerMap: new Map(),
        messages: [],
        // Settled by isLargeFile, the first time this buffer has a message.
        isLargeFile: false,
        sizeLineCount: -1,
        sizeGeneration: -1,
      };
      for (const severity of SEVERITIES) {
        buffer.linterUI.severityLayers[severity.name] = buffer.addMarkerLayer();
      }
      for (const tag of TAGS) {
        buffer.linterUI.tagLayers[tag] = buffer.addMarkerLayer();
      }
    }

    for (const severity of SEVERITIES) {
      const layer = buffer.linterUI.severityLayers[severity.name];
      // Text decorations (wavy underlines)
      editor.decorateMarkerLayer(layer, {
        type: "text",
        class: `linter-text ${severity.name}`,
      });
      // Line-number decorations (gutter styling). Registered for every
      // severity, including the ones the stylesheet paints no dot for: the
      // decoration is what keeps gutter hover working and what lets a user turn
      // a dot on from styles.css with no code change.
      editor.decorateMarkerLayer(layer, {
        type: "line-number",
        class: `linter-line-number ${severity.name}`,
      });
    }

    // Tags decorate text only. The gutter dot already carries the severity, and
    // its rules resolve precedence through :not() chains that a second axis
    // would not fit into.
    for (const tag of TAGS) {
      editor.decorateMarkerLayer(buffer.linterUI.tagLayers[tag], {
        type: "text",
        class: `linter-tag-${tag}`,
      });
    }

    const destroySubscription = editor.onDidDestroy(() => {
      this.editorSubscriptions.remove(destroySubscription);
      this.releaseBuffer(buffer);
    });
    this.editorSubscriptions.add(destroySubscription);
  }

  /**
   * Forgets an editor's buffer, and retires what the UI put on that buffer
   * along with the last editor showing it.
   * @param {TextBuffer} buffer
   */
  releaseBuffer(buffer) {
    const showing = this.buffers.get(buffer);
    if (showing === undefined) {
      return;
    }
    if (showing > 1) {
      this.buffers.set(buffer, showing - 1);
      return;
    }
    this.buffers.delete(buffer);
    destroyBufferState(buffer);
  }

  /**
   * The buffers the UI has patched.
   * @returns {Iterable} The text buffers
   */
  getBuffers() {
    return this.buffers.keys();
  }

  /**
   * Whether any registered adapter projects a message onto other buffers.
   * @returns {boolean}
   */
  hasMarkerProjection() {
    for (const adapter of this.itemAdapters) {
      if (typeof adapter.getMarkerLocationsForMessage === "function") {
        return true;
      }
    }
    return false;
  }

  /**
   * Expands panel messages into the concrete buffer locations where their
   * inline markers should be rendered. Adapters may return multiple locations
   * for one message (for example, the same notebook cell in split panes)
   * without duplicating the original message in the registry or panel.
   * @param {Array} messages - Registry-owned messages
   * @returns {Array} Messages targeted at marker buffers
   */
  getMarkerMessages(messages, projectionCache = new WeakMap()) {
    // Nothing projects, so the marker messages are the messages. Asked once for
    // the whole set rather than once per message: without an adapter that
    // projects — which is every window with no notebook open — the pass below
    // copies the entire message set and writes a cache entry per message, three
    // times over, to arrive back where it started.
    if (!this.hasMarkerProjection()) {
      return messages;
    }

    const markerMessages = [];
    for (const message of messages) {
      const cachedMessages = projectionCache.get(message);
      if (cachedMessages) {
        markerMessages.push(...cachedMessages);
        continue;
      }

      const projectedMessages = [];
      let projections;
      for (const adapter of this.itemAdapters) {
        if (typeof adapter.getMarkerLocationsForMessage !== "function") continue;
        const candidate = adapter.getMarkerLocationsForMessage(message);
        if (candidate !== undefined && candidate !== null) {
          projections = candidate;
          break;
        }
      }

      if (projections === undefined) {
        projectedMessages.push(message);
        projectionCache.set(message, projectedMessages);
        markerMessages.push(...projectedMessages);
        continue;
      }

      for (const projection of projections || []) {
        if (!projection?.buffer) continue;
        const location = { ...message.location, ...projection };
        if (!Object.prototype.hasOwnProperty.call(projection, "displayRange")) {
          delete location.displayRange;
        }
        // A projection may name a different file, and the spelling carried over
        // from the message would then be the wrong one — `normalizedFile`
        // answers for `file` wherever a location goes.
        if (Object.prototype.hasOwnProperty.call(projection, "file")) {
          location.normalizedFile = normalizePath(location.file);
        }
        const markerMessage = {
          ...message,
          location,
        };
        this.markerMessageOrigins.set(markerMessage, message);
        projectedMessages.push(markerMessage);
      }
      projectionCache.set(message, projectedMessages);
      markerMessages.push(...projectedMessages);
    }
    return markerMessages;
  }

  /**
   * Assigns linter messages to their corresponding buffers.
   * @param {Object} args - Object containing added, removed, and all messages
   */
  assignMessages(args) {
    const projectionCache = new WeakMap();
    const addedMarkerMessages = this.getMarkerMessages(args.added, projectionCache);
    const removedMarkerMessages = this.getMarkerMessages(args.removed, projectionCache);
    const allMarkerMessages = this.getMarkerMessages(args.messages, projectionCache);
    const addedByPath = new Map();
    const addedByBuffer = new Map();
    for (const message of addedMarkerMessages) {
      const buffer = message.location.buffer;
      if (buffer) {
        if (!addedByBuffer.has(buffer)) {
          addedByBuffer.set(buffer, []);
        }
        addedByBuffer.get(buffer).push(message);
        continue;
      }
      // Keyed by the normalized path: the provider and the buffer may spell the
      // same file differently, and this map is only ever read back by path.
      const path = message.location.normalizedFile;
      if (!addedByPath.has(path)) {
        addedByPath.set(path, []);
      }
      addedByPath.get(path).push(message);
    }

    const removedByPath = new Map();
    const removedByBuffer = new Map();
    for (const message of removedMarkerMessages) {
      const buffer = message.location.buffer;
      if (buffer) {
        if (!removedByBuffer.has(buffer)) {
          removedByBuffer.set(buffer, []);
        }
        removedByBuffer.get(buffer).push(message);
        continue;
      }
      const path = message.location.normalizedFile;
      if (!removedByPath.has(path)) {
        removedByPath.set(path, []);
      }
      removedByPath.get(path).push(message);
    }

    const affectedPaths = new Set([...addedByPath.keys(), ...removedByPath.keys()]);
    const affectedBuffers = new Set([...addedByBuffer.keys(), ...removedByBuffer.keys()]);

    const messagesByPath = new Map();
    const messagesByBuffer = new Map();
    for (const message of allMarkerMessages) {
      const buffer = message.location.buffer;
      if (buffer) {
        if (!messagesByBuffer.has(buffer)) {
          messagesByBuffer.set(buffer, []);
        }
        messagesByBuffer.get(buffer).push(message);
        continue;
      }
      const path = message.location.normalizedFile;
      if (!messagesByPath.has(path)) {
        messagesByPath.set(path, []);
      }
      messagesByPath.get(path).push(message);
    }

    for (const buffer of this.getBuffers()) {
      if (!buffer.linterUI) {
        continue;
      }
      const bufferPath = normalizePath(buffer.getPath());
      if (!affectedBuffers.has(buffer) && !affectedPaths.has(bufferPath)) {
        continue;
      }
      const addedMessages = addedByBuffer.get(buffer) || addedByPath.get(bufferPath) || [];
      // Create displayRange for new messages
      for (const message of addedMessages) {
        if (!message.location.displayRange) {
          message.location.displayRange = getDisplayRange(buffer, message.location.position);
        }
      }
      buffer.linterUI.addedMessages = addedMessages;
      buffer.linterUI.removedMessages =
        removedByBuffer.get(buffer) || removedByPath.get(bufferPath) || [];
      buffer.linterUI.messages =
        messagesByBuffer.get(buffer) || messagesByPath.get(bufferPath) || [];
      buffer.linterUI.messages.sort((a, b) => {
        return a.location.position.start.compare(b.location.position.start);
      });
    }
  }

  /**
   * Updates marker decorations incrementally. Creation is keyed off the
   * marker map rather than the added list: marker projection is dynamic — an
   * adapter answers per render, and a notebook cell's answer can transiently
   * come up empty while its view rebuilds around an undo — so a message can
   * join or leave a buffer without being added or removed anywhere. Whatever
   * the map lacks for the current set is created, whatever it holds beyond it
   * is destroyed, and the pass is idempotent.
   */
  updateMarkers() {
    for (const buffer of this.getBuffers()) {
      if (!buffer.linterUI) {
        continue;
      }
      const state = buffer.linterUI;
      const { removedMessages, markerMap } = state;
      const current = state.messages || [];

      // Enter on explicit changes, and also whenever the map disagrees with
      // the current set — that disagreement is what a healed projection or a
      // reconciled-away marker looks like.
      const inSync =
        !state.addedMessages?.length &&
        !removedMessages?.length &&
        current.length === markerMap.size &&
        current.every((message) => markerMap.has(message.key));
      if (inSync) {
        continue;
      }

      const wasLarge = state.isLargeFile;
      // Skip inline decorations for large files
      if (this.isLargeFile(state, buffer)) {
        // Whatever was decorated while it was small enough goes: nothing will
        // maintain those markers from here.
        if (!wasLarge) {
          for (const key of Array.from(markerMap.keys())) {
            destroyMarkers(markerMap, key);
          }
        }
        state.addedMessages = null;
        state.removedMessages = null;
        continue;
      }

      // Remove markers using O(1) markerMap lookup
      if (removedMessages?.length) {
        for (const message of removedMessages) {
          destroyMarkers(markerMap, message.key);
        }
      }

      // Create markers for every current message the map holds nothing for —
      // the newly added ones, the whole set after a large file shrank, and
      // the ones a healed projection just brought back.
      for (const message of current) {
        if (markerMap.has(message.key)) {
          continue;
        }
        const severityLayer = state.severityLayers[message.severity];
        if (!severityLayer) {
          // Validation is skipped outside dev mode on the provider and
          // setAllMessages paths, so a severity outside the model reaches
          // here. Skip the decoration only: the panel and the status bar
          // still list the message.
          continue;
        }
        if (!message.location.displayRange) {
          message.location.displayRange = getDisplayRange(buffer, message.location.position);
        }
        // Tag markers cover the same range as the severity marker, so their
        // decorations coincide exactly and the merged span carries both
        // classes across the whole range. Snapshot-owned markers use
        // exclusive boundaries so newly typed text does not inherit stale
        // styling; classic markers retire as soon as an edit touches them.
        //
        // The invalidation is recorded against the ORIGINAL message —
        // normalizeMessages keys a WeakMap by it — and this may be a
        // projected clone, so the lookup goes through the origin. Asking with
        // the clone silently answered "touch" for every projected marker,
        // which is what made notebook markers vanish on the first edit that
        // brushed them however their delegate had said "never".
        const origin = this.markerMessageOrigins.get(message) || message;
        const invalidate = getMarkerInvalidation(origin);
        const markerOptions =
          invalidate === "never" ? { invalidate, exclusive: true } : { invalidate };
        const markers = [severityLayer.markRange(message.location.displayRange, markerOptions)];
        for (const tag of message.tags || []) {
          const tagLayer = state.tagLayers[tag];
          if (tagLayer) {
            markers.push(tagLayer.markRange(message.location.displayRange, markerOptions));
          }
        }
        markerMap.set(message.key, markers);
        if (invalidate === "touch") {
          // Observing the severity marker is sufficient: every marker for a
          // message has the same range and invalidation strategy.
          const marker = markers[0];
          marker.onDidChange(({ isValid }) => {
            if (!isValid && markerMap.get(message.key)?.[0] === marker) {
              this.queueMessageDeletion(origin);
              destroyMarkers(markerMap, message.key);
            }
          });
        }
      }

      // Reconcile: destroy any markers tracked in markerMap that no longer correspond
      // to a current message (e.g. after a Save As / path change that shifts old keys).
      // Tags are part of the key, so a message whose tags changed arrives under a new
      // key and its stale tag markers are collected here too.
      const currentKeys = new Set(current.map((m) => m.key));
      for (const key of markerMap.keys()) {
        if (!currentKeys.has(key)) {
          destroyMarkers(markerMap, key);
        }
      }

      state.addedMessages = null;
      state.removedMessages = null;
    }
  }

  setLintingStateProvider(provider) {
    this.lintingStateProvider = provider;
  }

  isLintingDisabledForEditor(editor) {
    return Boolean(editor && this.lintingStateProvider?.(editor));
  }

  setActiveItem(item) {
    if (this.activeItem === item) {
      return;
    }

    this.activeItem = item;
    this.activeItemAdapter = this.getAdapterForItem(item);
    this.editor = lumine.workspace.isTextEditor(item) ? item : null;
    // Told, rather than left to be noticed. `getCursorEditor` and
    // `getCurrentMessages` are answered from what was just assigned above, so a
    // UI watching the workspace for this itself would be racing these three
    // lines — and losing whenever it subscribed first.
    this.onDidChangeActiveItem?.();
  }

  addItemAdapter(adapter) {
    this.itemAdapters.add(adapter);
    this.activeItemAdapter = this.getAdapterForItem(this.activeItem);
    // An adapter arriving changes which messages the active item has.
    this.onDidChangeActiveItem?.();
  }

  removeItemAdapter(adapter) {
    this.itemAdapters.delete(adapter);
    if (this.activeItemAdapter === adapter) {
      this.activeItemAdapter = this.getAdapterForItem(this.activeItem);
      this.onDidChangeActiveItem?.();
    }
  }

  getAdapterForItem(item) {
    if (!item) return null;
    for (const adapter of this.itemAdapters) {
      if (adapter.handlesItem?.(item)) {
        return adapter;
      }
    }
    return null;
  }

  getCurrentMessages() {
    if (this.activeItemAdapter && this.activeItem) {
      return this.activeItemAdapter.getMessagesForItem?.(this.activeItem, this.allMessages) || [];
    }
    if (!this.editor) return [];
    const buffer = this.editor.getBuffer();
    return buffer.linterUI ? buffer.linterUI.messages : [];
  }

  revealMessage(message) {
    if (this.activeItemAdapter && this.activeItem) {
      return this.activeItemAdapter.revealMessage?.(this.activeItem, message);
    }
    if (!this.editor) return;
    this.editor.setCursorBufferPosition(message.location.position.start, {
      autoscroll: false,
    });
    this.editor.scrollToCursorPosition({
      zone: lumine.config.get("linter.editorScrollZone"),
    });
    this.editor.element.focus();
  }

  // Message inspection. The message itself is shown by the hover package,
  // which asks this one for whatever covers the cursor — so these commands
  // put the cursor on a message and open the tooltip there. Without that
  // package installed they still navigate; there is simply nothing to open.
  inspect() {
    if (this.activeItemAdapter) {
      const message = this.getCurrentMessage();
      if (message) this.revealMessage(message);
      return;
    }
    if (!this.getCurrentMessage()) return;
    this.showTooltipAtCursor();
  }

  inspectNext() {
    this.inspectMessage(this.getNextMessage());
  }

  inspectPrevious() {
    this.inspectMessage(this.getPreviousMessage());
  }

  inspectMessage(message) {
    if (!message) return;
    this.revealMessage(message);
    if (!this.activeItemAdapter) this.showTooltipAtCursor();
  }

  showTooltipAtCursor() {
    const view = this.editor && lumine.views.getView(this.editor);
    if (view) lumine.commands.dispatch(view, "hover:toggle");
  }

  deleteMessage(message) {
    if (!message || !this.onDeleteMessages) return;
    this.onDeleteMessages([message]);
  }

  /**
   * Asks for a message to be deleted at the end of the current tick.
   *
   * One edit invalidates every marker it touched, and the buffer reports them
   * one at a time in a single synchronous pass. Each deletion re-runs the whole
   * render pipeline, so deleting a block of lines used to cost one full pass per
   * message in it. Collecting them and asking once turns that back into one.
   * @param {Object} message - The registry-owned message
   */
  queueMessageDeletion(message) {
    this.pendingDeletions.add(message);
    if (this.deletionFlushScheduled) {
      return;
    }
    this.deletionFlushScheduled = true;
    // A microtask: the marker callbacks all land in this tick, and the deletion
    // is committed before the frame is painted.
    Promise.resolve().then(() => this.flushPendingDeletions());
  }

  /**
   * Commits every queued deletion as one update.
   */
  flushPendingDeletions() {
    this.deletionFlushScheduled = false;
    if (!this.pendingDeletions.size) {
      return;
    }
    const messages = Array.from(this.pendingDeletions);
    this.pendingDeletions.clear();
    if (this.onDeleteMessages) {
      this.onDeleteMessages(messages);
    }
  }

  /**
   * Gets the linter message at the current cursor position.
   * @returns {Object|undefined} The message at cursor or undefined
   */
  getCurrentMessage() {
    if (this.activeItemAdapter && this.activeItem) {
      return this.activeItemAdapter.getCurrentMessage?.(this.activeItem, this.getCurrentMessages());
    }
    if (!this.editor) {
      return;
    }
    const buffer = this.editor.getBuffer();
    if (!buffer.linterUI) {
      return;
    }
    const cursorPosition = this.editor.getCursorBufferPosition();
    for (const message of buffer.linterUI.messages) {
      if (message.location.position.containsPoint(cursorPosition)) {
        return message;
      }
    }
  }

  /**
   * Gets the next linter message after the cursor position.
   * @returns {Object|undefined} The next message or first message if at end
   */
  getNextMessage() {
    if (this.activeItemAdapter && this.activeItem) {
      return this.activeItemAdapter.getNextMessage?.(this.activeItem, this.getCurrentMessages());
    }
    if (!this.editor) {
      return;
    }
    const buffer = this.editor.getBuffer();
    if (!buffer.linterUI) {
      return;
    }
    const cursorPos = this.editor.getCursorBufferPosition();
    for (const message of buffer.linterUI.messages) {
      if (message.location.position.start.isGreaterThan(cursorPos)) {
        return message;
      }
    }
    if (buffer.linterUI.messages.length) {
      return buffer.linterUI.messages[0];
    }
  }

  /**
   * Gets the previous linter message before the cursor position.
   * @returns {Object|undefined} The previous message or last message if at start
   */
  getPreviousMessage() {
    if (this.activeItemAdapter && this.activeItem) {
      return this.activeItemAdapter.getPreviousMessage?.(
        this.activeItem,
        this.getCurrentMessages(),
      );
    }
    if (!this.editor) {
      return;
    }
    const buffer = this.editor.getBuffer();
    if (!buffer.linterUI) {
      return;
    }
    const messages = buffer.linterUI.messages;
    const cursorPos = this.editor.getCursorBufferPosition();
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].location.position.start.isLessThan(cursorPos)) {
        return messages[i];
      }
    }
    if (messages.length) {
      return messages[messages.length - 1];
    }
  }
}

module.exports = LinterUI;
