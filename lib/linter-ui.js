const { CompositeDisposable, Range } = require("atom");
const { StatusPanel } = require("./status");
const { LinterPanel } = require("./linter-panel");
const { BubblePanel } = require("./bubble");
const { scrollToCursorWithMode } = require("./helpers");

// Default thresholds for large file detection
const DEFAULT_LARGE_FILE_LINE_COUNT = 20000;
const DEFAULT_LONG_LINE_LENGTH = 4000;

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
    this.buffers = new Set();
    this.patchedEditors = new WeakSet();
    this.largeFileLineCount = DEFAULT_LARGE_FILE_LINE_COUNT;
    this.longLineLength = DEFAULT_LONG_LINE_LENGTH;
    this.idleCallbacks = new Set();
    this.subscriptions = new CompositeDisposable();

    // Initialize UI components
    this.status = new StatusPanel(this);
    this.panel = new LinterPanel(this);

    // Defer hover tooltip initialization - not needed immediately
    const bubbleInitCallbackID = window.requestIdleCallback(() => {
      this.idleCallbacks.delete(bubbleInitCallbackID);
      this.bubble = new BubblePanel(this);
    });
    this.idleCallbacks.add(bubbleInitCallbackID);

    // Observe editors and active editor changes
    const editorObservers = [
      atom.workspace.observeTextEditors((editor) => {
        this.patchEditor(editor);
      }),
    ];
    if (atom.textEditors?.observe) {
      editorObservers.push(
        atom.textEditors.observe((editor) => {
          this.patchEditor(editor);
        }),
      );
    }

    this.subscriptions.add(
      ...editorObservers,
      atom.workspace.getCenter().observeActivePaneItem((item) => {
        this.setActiveItem(item);
      }),
      atom.config.observe("linter-bundle.largeFileLineCount", (value) => {
        this.largeFileLineCount = value || DEFAULT_LARGE_FILE_LINE_COUNT;
      }),
      atom.config.observe("linter-bundle.longLineLength", (value) => {
        this.longLineLength = value || DEFAULT_LONG_LINE_LENGTH;
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

    this.subscriptions.dispose();

    if (this.bubble) {
      this.bubble.destroy();
    }
    if (this.panel) {
      this.panel.destroy();
    }
    if (this.status) {
      this.status.destroy();
    }

    // Cleanup marker layers from all buffers
    for (const buffer of this.getBuffers()) {
      if (buffer.linterUI) {
        if (buffer.linterUI.markerMap) {
          buffer.linterUI.markerMap.clear();
        }
        buffer.linterUI.error.clear();
        buffer.linterUI.error.destroy();
        buffer.linterUI.warning.clear();
        buffer.linterUI.warning.destroy();
        buffer.linterUI.info.clear();
        buffer.linterUI.info.destroy();
      }
      delete buffer.linterUI;
    }
  }

  /**
   * Renders linter messages - called by core when messages change.
   * @param {Object} args - Object containing added, removed, and all messages
   */
  render(args) {
    this.allMessages = args.messages;
    this.assignMessages(args);
    this.updateMarkers();
    this.updateCurrent();
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
   * Patches an editor with linter marker layers for highlighting.
   * @param {TextEditor} editor - The text editor to patch
   */
  patchEditor(editor) {
    if (this.patchedEditors.has(editor)) {
      return;
    }
    this.patchedEditors.add(editor);

    const buffer = editor.getBuffer();
    this.buffers.add(buffer);
    if (!buffer.linterUI) {
      const isLarge = this.isLargeBuffer(buffer);
      buffer.linterUI = {
        error: buffer.addMarkerLayer(),
        warning: buffer.addMarkerLayer(),
        info: buffer.addMarkerLayer(),
        markerMap: new Map(),
        messages: [],
        updateRequired: false,
        isLargeFile: isLarge,
      };
    }
    // Text decorations (wavy underlines)
    editor.decorateMarkerLayer(buffer.linterUI.error, {
      type: "text",
      class: "linter-text error",
    });
    editor.decorateMarkerLayer(buffer.linterUI.warning, {
      type: "text",
      class: "linter-text warning",
    });
    editor.decorateMarkerLayer(buffer.linterUI.info, {
      type: "text",
      class: "linter-text info",
    });
    // Line-number decorations (gutter styling)
    editor.decorateMarkerLayer(buffer.linterUI.error, {
      type: "line-number",
      class: "linter-line-number error",
    });
    editor.decorateMarkerLayer(buffer.linterUI.warning, {
      type: "line-number",
      class: "linter-line-number warning",
    });
    editor.decorateMarkerLayer(buffer.linterUI.info, {
      type: "line-number",
      class: "linter-line-number info",
    });

    this.subscriptions.add(
      editor.onDidDestroy(() => {
        this.buffers.delete(buffer);
      }),
    );
  }

  /**
   * Gets all unique buffers from open text editors.
   * @returns {Set} Set of text buffers
   */
  getBuffers() {
    const buffers = new Set(this.buffers);
    atom.workspace.getTextEditors().forEach((editor) => buffers.add(editor.getBuffer()));
    return buffers;
  }

  /**
   * Assigns linter messages to their corresponding buffers.
   * @param {Object} args - Object containing added, removed, and all messages
   */
  assignMessages(args) {
    const addedByPath = new Map();
    const addedByBuffer = new Map();
    for (const message of args.added) {
      const buffer = message.location.buffer;
      if (buffer) {
        if (!addedByBuffer.has(buffer)) {
          addedByBuffer.set(buffer, []);
        }
        addedByBuffer.get(buffer).push(message);
        continue;
      }
      const path = message.location.file;
      if (!addedByPath.has(path)) {
        addedByPath.set(path, []);
      }
      addedByPath.get(path).push(message);
    }

    const removedByPath = new Map();
    const removedByBuffer = new Map();
    for (const message of args.removed) {
      const buffer = message.location.buffer;
      if (buffer) {
        if (!removedByBuffer.has(buffer)) {
          removedByBuffer.set(buffer, []);
        }
        removedByBuffer.get(buffer).push(message);
        continue;
      }
      const path = message.location.file;
      if (!removedByPath.has(path)) {
        removedByPath.set(path, []);
      }
      removedByPath.get(path).push(message);
    }

    const affectedPaths = new Set([...addedByPath.keys(), ...removedByPath.keys()]);
    const affectedBuffers = new Set([...addedByBuffer.keys(), ...removedByBuffer.keys()]);

    const messagesByPath = new Map();
    const messagesByBuffer = new Map();
    for (const message of args.messages) {
      const buffer = message.location.buffer;
      if (buffer) {
        if (!messagesByBuffer.has(buffer)) {
          messagesByBuffer.set(buffer, []);
        }
        messagesByBuffer.get(buffer).push(message);
        continue;
      }
      const path = message.location.file;
      if (!messagesByPath.has(path)) {
        messagesByPath.set(path, []);
      }
      messagesByPath.get(path).push(message);
    }

    for (const buffer of this.getBuffers()) {
      if (!buffer.linterUI) {
        continue;
      }
      const bufferPath = buffer.getPath();
      if (!affectedBuffers.has(buffer) && !affectedPaths.has(bufferPath)) {
        continue;
      }
      const addedMessages = addedByBuffer.get(buffer) || addedByPath.get(bufferPath) || [];
      // Create displayRange for new messages
      for (const message of addedMessages) {
        if (!message.location.displayRange) {
          const { start, end } = message.location.position;
          const lineLength = buffer.lineLengthForRow(start.row);
          // If range spans from line end to next line start, mark entire line
          if (start.column >= lineLength && end.row === start.row + 1 && end.column === 0) {
            message.location.displayRange = new Range([start.row, 0], [start.row, lineLength]);
          } else {
            message.location.displayRange = message.location.position;
          }
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
   * Updates marker decorations incrementally.
   */
  updateMarkers() {
    for (const buffer of this.getBuffers()) {
      if (!buffer.linterUI) {
        continue;
      }
      const { addedMessages, removedMessages, isLargeFile, markerMap } = buffer.linterUI;

      if (!addedMessages?.length && !removedMessages?.length) {
        continue;
      }

      // Skip inline decorations for large files
      if (isLargeFile) {
        buffer.linterUI.addedMessages = null;
        buffer.linterUI.removedMessages = null;
        continue;
      }

      // Remove markers using O(1) markerMap lookup
      if (removedMessages?.length) {
        for (const message of removedMessages) {
          const marker = markerMap.get(message.key);
          if (marker) {
            marker.destroy();
            markerMap.delete(message.key);
          }
        }
      }

      // Add markers for added messages
      if (addedMessages?.length) {
        for (const message of addedMessages) {
          // Destroy any existing marker for this key before creating a new one.
          // This prevents orphaned markers when a buffer is closed and reopened before
          // the deferred cleanup (deleteByBuffer + debounce) has a chance to run.
          const existing = markerMap.get(message.key);
          if (existing) {
            existing.destroy();
          }
          const marker = buffer.linterUI[message.severity].markRange(
            message.location.displayRange,
            { invalidate: "touch" },
          );
          markerMap.set(message.key, marker);
          marker.onDidChange(({ isValid }) => {
            // Guard: only act if this marker is still the tracked one for this key.
            if (!isValid && this.onDeleteMessage && markerMap.get(message.key) === marker) {
              this.onDeleteMessage(message);
              marker.destroy();
              markerMap.delete(message.key);
            }
          });
        }
      }

      // Reconcile: destroy any markers tracked in markerMap that no longer correspond
      // to a current message (e.g. after a Save As / path change that shifts old keys).
      const currentKeys = new Set((buffer.linterUI.messages || []).map((m) => m.key));
      for (const [key, marker] of markerMap) {
        if (!currentKeys.has(key)) {
          marker.destroy();
          markerMap.delete(key);
        }
      }

      buffer.linterUI.addedMessages = null;
      buffer.linterUI.removedMessages = null;
    }
  }

  /**
   * Sets the current editor for all UI components.
   * @param {TextEditor} editor - The text editor to set
   */
  setEditor(editor) {
    this.editor = editor;
    this.status.setEditor(editor);
    this.panel.setEditor(editor);
  }

  setLintingStateProvider(provider) {
    this.lintingStateProvider = provider;
    this.updateCurrent();
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
    this.setEditor(atom.workspace.isTextEditor(item) ? item : null);
    this.updateCurrent();
  }

  addItemAdapter(adapter) {
    this.itemAdapters.add(adapter);
    this.activeItemAdapter = this.getAdapterForItem(this.activeItem);
    this.updateCurrent();
  }

  removeItemAdapter(adapter) {
    this.itemAdapters.delete(adapter);
    if (this.activeItemAdapter === adapter) {
      this.activeItemAdapter = this.getAdapterForItem(this.activeItem);
      this.updateCurrent();
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
    scrollToCursorWithMode(this.editor, atom.config.get("linter-bundle.editorScrollPosition"));
    this.editor.element.focus();
  }

  /**
   * Updates all UI components to reflect current state.
   */
  updateCurrent() {
    this.status.update();
    this.panel.update();
  }

  /**
   * Consumes the status bar service.
   * @param {Object} statusBar - The status bar service
   */
  consumeStatusBar(statusBar) {
    statusBar.addLeftTile({ item: this.status, priority: -100 });
  }

  // Panel commands
  togglePanel() {
    this.panel.toggle();
  }

  // Bubble commands
  inspect() {
    if (this.activeItemAdapter) {
      const message = this.getCurrentMessage();
      if (message) this.revealMessage(message);
      return;
    }
    this.bubble?.inspect();
  }

  inspectNext() {
    if (this.activeItemAdapter) {
      const message = this.getNextMessage();
      if (message) this.revealMessage(message);
      return;
    }
    this.bubble?.inspectNext();
  }

  inspectPrevious() {
    if (this.activeItemAdapter) {
      const message = this.getPreviousMessage();
      if (message) this.revealMessage(message);
      return;
    }
    this.bubble?.inspectPrevious();
  }

  deleteMessage(message) {
    if (!message || !this.onDeleteMessage) return;
    this.onDeleteMessage(message);
  }

  clearMessages() {
    if (!this.editor) {
      return;
    }
    const buffer = this.editor.getBuffer();
    if (!buffer.linterUI) {
      return;
    }
    // Clear markers
    for (const marker of buffer.linterUI.markerMap.values()) {
      marker.destroy();
    }
    buffer.linterUI.markerMap.clear();
    buffer.linterUI.messages = [];
    this.updateCurrent();
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
