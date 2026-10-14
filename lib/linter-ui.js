let runtime;
const getRuntime = () => (runtime ||= require("./linter-ui-runtime"));

const { CompositeDisposable } = require("lumine");
const DEFAULT_LARGE_FILE_LINE_COUNT = 20000;
const DEFAULT_LONG_LINE_LENGTH = 4000;
function messageRange(message) {
  return message.location.displayRange || message.location.position;
}
function destroyBufferState(buffer) {
  return getRuntime().destroyBufferState(buffer);
}

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
        this.updateMarkers();
      }),
      lumine.config.observe("linter.longLineLength", (value) => {
        this.longLineLength = value || DEFAULT_LONG_LINE_LENGTH;
        this.sizeGeneration++;
        this.updateMarkers();
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
    this.updateMarkers(this.assignMessages(args), true);
  }

  /**
   * Delivers the standing message set to buffers patched after the last
   * render. Deferred one microtask so a batch of registrations — a notebook
   * building an editor per cell — resolves in a single pass, after the host
   * has finished wiring the editor it registered (an adapter cannot project
   * onto a cell editor its notebook has not indexed yet).
   * @param {TextBuffer} buffer - The freshly patched buffer
   */
  scheduleProjectionCatchUp(...args) {
    return getRuntime().scheduleProjectionCatchUp.apply(this, args);
  }

  /**
   * Checks if a buffer is considered "large" based on line count or line length.
   * @param {TextBuffer} buffer - The buffer to check
   * @returns {boolean} True if the buffer is large
   */
  isLargeBuffer(...args) {
    return getRuntime().isLargeBuffer.apply(this, args);
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
  isLargeFile(...args) {
    return getRuntime().isLargeFile.apply(this, args);
  }

  /**
   * Patches an editor with linter marker layers for highlighting.
   * @param {TextEditor} editor - The text editor to patch
   */
  patchEditor(...args) {
    return getRuntime().patchEditor.apply(this, args);
  }

  /**
   * Forgets an editor's buffer, and retires what the UI put on that buffer
   * along with the last editor showing it.
   * @param {TextBuffer} buffer
   */
  releaseBuffer(...args) {
    return getRuntime().releaseBuffer.apply(this, args);
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
  getMarkerMessages(...args) {
    return getRuntime().getMarkerMessages.apply(this, args);
  }

  /**
   * Assigns linter messages to their corresponding buffers.
   * @param {Object} args - Object containing added, removed, and all messages
   */
  assignMessages(...args) {
    return getRuntime().assignMessages.apply(this, args);
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
  updateMarkers(...args) {
    if (args.length === 0 && this.buffers.size === 0) return;
    return getRuntime().updateMarkers.apply(this, args);
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

  getMessagesAtPosition(editor, position) {
    const buffer = editor?.getBuffer?.();
    if (!buffer) return [];
    return require("./diagnostic-index")
      .messagesAtPosition(buffer, position)
      .map((message) => this.markerMessageOrigins.get(message) || message);
  }

  revealMessage(message) {
    if (this.activeItemAdapter && this.activeItem) {
      return this.activeItemAdapter.revealMessage?.(this.activeItem, message);
    }
    if (!this.editor) return;
    this.editor.setCursorBufferPosition(messageRange(message).start, {
      autoscroll: false,
    });
    this.editor.scrollToZone();
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
    return require("./diagnostic-index").messagesAtPosition(buffer, cursorPosition)[0];
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
    return require("./diagnostic-index").nextMessage(buffer, cursorPos);
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
    const cursorPos = this.editor.getCursorBufferPosition();
    return require("./diagnostic-index").previousMessage(buffer, cursorPos);
  }
}

module.exports = LinterUI;
