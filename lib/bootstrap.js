const { CompositeDisposable, Emitter } = require("lumine");
const { normalizePath } = require("./message-metadata");
class Commands {
  constructor(resolveEditor) {
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      this.emitter,
      lumine.commands.add("lumine-workspace", {
        "linter:lint": {
          description: "Run every registered linter over the active file now.",
          isAvailable: (event) => Boolean(resolveEditor(event)),
          didDispatch: (event) => this.lint(event),
        },
        "linter:debug": {
          description: "Report which linters are registered and how they are set up.",
          didDispatch: (event) => this.debug(event),
        },
        // Two names for the one action, so they carry the one sentence.
        "linter:state": {
          description: "Turn linting on or off for the active file alone.",
          isAvailable: (event) => Boolean(resolveEditor(event)),
          didDispatch: (event) => this.toggleActiveEditor(event),
        },
        "linter:toggle-current-file": {
          description: "Turn linting on or off for the active file alone.",
          isAvailable: (event) => Boolean(resolveEditor(event)),
          didDispatch: (event) => this.toggleActiveEditor(event),
        },
        "linter:toggle-linter": {
          description: "Choose which diagnostic providers can display messages.",
          didDispatch: (event) => this.toggleLinter(event),
        },
      }),
    );
  }

  lint(event) {
    this.emitter.emit("should-lint", event);
  }

  debug(event) {
    this.emitter.emit("should-debug", event);
  }

  toggleLinter(event) {
    this.emitter.emit("should-toggle-linter", event);
  }

  toggleActiveEditor(event) {
    this.emitter.emit("should-toggle-active-editor", event);
  }

  onShouldLint(callback) {
    return this.emitter.on("should-lint", callback);
  }

  onShouldDebug(callback) {
    return this.emitter.on("should-debug", callback);
  }

  onShouldToggleActiveEditor(callback) {
    return this.emitter.on("should-toggle-active-editor", callback);
  }

  onShouldToggleLinter(callback) {
    return this.emitter.on("should-toggle-linter", callback);
  }

  dispose() {
    this.subscriptions.dispose();
  }
}
const showDebug = (...args) => require("./commands-debug")(...args);
let linterRuntime;
const getLinterRuntime = () => (linterRuntime ||= require("./linter-main-runtime"));
class Linter {
  constructor() {
    this.commands = new Commands((event) => this.commandEditor(event));
    this.subscriptions = new CompositeDisposable();
    this.initializationTasks = new Set();
    this.itemAdapters = new Set();
    this.toggleViews = new Set();
    this.disabledProviders = new Set();
    this.diagnosticBuffers = new Map();
    // UI render callback - will be set by index.js
    this.uiRenderCallback = null;
    this.uiLintingStateCallback = null;

    this.subscriptions.add(
      this.commands,
      lumine.config.observe("linter.disabledProviders", (names) =>
        this.setDisabledProviders(names),
      ),
    );

    this.commands.onShouldLint((event) => {
      this.registryEditorsInit();
      const textEditor = this.commandEditor(event);
      if (!textEditor) {
        return;
      }
      const editorLinter = this.registryEditors.get(textEditor);
      if (editorLinter) {
        editorLinter.lint();
      }
    });

    this.commands.onShouldToggleActiveEditor((event) => {
      const textEditor = this.commandEditor(event);
      if (!textEditor) {
        return;
      }
      this.registryEditorsInit();
      if (this.registryEditors.isTextEditorDisabled(textEditor)) {
        this.registryEditors.enableTextEditorBuffer(textEditor);
      } else {
        this.registryEditors.disableTextEditorBuffer(textEditor);
        this.registryMessagesInit();
        this.registryMessages.deleteByBuffer(textEditor.getBuffer());
      }
      if (this.uiLintingStateCallback) {
        this.uiLintingStateCallback();
      }
    });

    this.commands.onShouldDebug(async (event) => {
      this.registryIndieInit();
      this.registryLintersInit();
      await showDebug(
        this.registryLinters.getProviders(),
        this.registryIndie.getProviders(),
        this.commandEditor(event),
      );
    });

    this.commands.onShouldToggleLinter((event) => {
      const ToggleView = require("./toggle-view");
      const toggleView = new ToggleView(this.getProviderNames(), event?.context?.window);
      this.toggleViews.add(toggleView);
      toggleView.onDidDispose(() => {
        this.toggleViews.delete(toggleView);
        this.subscriptions.remove(toggleView);
      });
      toggleView.show();
      this.subscriptions.add(toggleView);
    });

    const projectPathChangeCallbackID = setImmediate(() => {
      this.initializationTasks.delete(projectPathChangeCallbackID);
      this.subscriptions.add(
        lumine.project.onDidChangePaths(() => {
          this.commands.lint();
        }),
      );
    });
    this.initializationTasks.add(projectPathChangeCallbackID);

    const registryEditorsInitCallbackID = setImmediate(() => {
      this.initializationTasks.delete(registryEditorsInitCallbackID);
      this.registryEditorsInit();
    });
    this.initializationTasks.add(registryEditorsInitCallbackID);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.initializationTasks.forEach((callbackID) => clearImmediate(callbackID));
    this.initializationTasks.clear();
    this.subscriptions.dispose();
    for (const subscription of this.diagnosticBuffers.values()) subscription.dispose();
    this.diagnosticBuffers.clear();
  }

  lintEditor(...args) {
    return getLinterRuntime().lintEditor.apply(this, args);
  }

  lintBuffer(...args) {
    return getLinterRuntime().lintBuffer.apply(this, args);
  }

  observeDiagnosticBuffer(...args) {
    return getLinterRuntime().observeDiagnosticBuffer.apply(this, args);
  }

  syncDiagnosticBuffers(...args) {
    return getLinterRuntime().syncDiagnosticBuffers.apply(this, args);
  }

  getProviderNames(...args) {
    return getLinterRuntime().getProviderNames.apply(this, args);
  }

  refreshProviderViews() {
    if (this.disposed || !this.toggleViews.size) return;
    const names = this.getProviderNames();
    for (const view of this.toggleViews) view.setProviders(names);
  }

  setDisabledProviders(names) {
    const previous = this.disabledProviders;
    this.disabledProviders = new Set(names || []);
    // Update the run scheduler before re-linting. Its own config observer can
    // run after this one, and a disabled generation's pending results must die.
    this.registryLinters?.setDisabledProviders(names || []);
    const standard = this.registryLinters?.getProviders() || [];
    const indie = this.registryIndie?.getProviders() || [];
    for (const linter of [...standard, ...indie]) {
      if (this.disabledProviders.has(linter.name)) {
        this.registryMessages?.deleteByLinter(linter);
      }
    }
    for (const linter of indie) {
      if (previous.has(linter.name) && !this.disabledProviders.has(linter.name)) {
        this.publishIndieMessages({ linter, messages: linter.getMessages() });
      }
    }
    if (
      standard.some(
        (linter) => previous.has(linter.name) && !this.disabledProviders.has(linter.name),
      )
    ) {
      const editorsInitialized = this.registryEditors !== undefined;
      this.registryEditorsInit();
      if (editorsInitialized || !this.registryEditors.shouldLintOnOpen()) {
        this.registryEditors.lintEditors();
      }
    }
  }

  // Set the UI render callback for direct integration
  setUIRenderCallback(callback) {
    this.uiRenderCallback = callback;
  }

  setUILintingStateCallback(callback) {
    this.uiLintingStateCallback = callback;
  }

  // Progress of individual provider runs, for a UI that shows a spinner. Paired
  // per run and carrying the run number, so a stale finish can be ignored.
  setUIBeginLintingCallback(callback) {
    this.uiBeginLintingCallback = callback;
  }

  setUIFinishLintingCallback(callback) {
    this.uiFinishLintingCallback = callback;
  }

  isTextEditorLintingDisabled(textEditor) {
    if (!textEditor || !this.registryEditors) {
      return false;
    }
    return this.registryEditors.isTextEditorDisabled(textEditor);
  }

  // Set callback to switch UI to project view when requested by indie providers
  setUIProjectViewCallback(callback) {
    this.uiProjectViewCallback = callback;
  }

  addItemAdapter(adapter) {
    this.itemAdapters.add(adapter);
  }

  removeItemAdapter(adapter) {
    this.itemAdapters.delete(adapter);
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

  getTextEditorForItem(...args) {
    return getLinterRuntime().getTextEditorForItem.apply(this, args);
  }

  commandEditor(event) {
    if (event?.context) return event.context.embeddedEditor ?? event.context.fileEditor ?? null;
    return this.getActiveTextEditor();
  }

  getActiveTextEditor() {
    return this.getTextEditorForItem(lumine.workspace.getCenter().getActivePaneItem());
  }

  registryEditorsInit() {
    if (this.disposed || this.registryEditors !== undefined) {
      return;
    }
    const EditorsRegistry = require("./editor-registry");
    this.registryEditors = new EditorsRegistry();
    this.subscriptions.add(this.registryEditors);
    this.subscriptions.add(
      this.registryEditors.onDidDisableBuffer((buffer) => {
        this.registryLinters?.cancelBuffer(buffer, "disabled");
        this.registryMessages?.deleteByBuffer(buffer);
      }),
    );
    this.registryEditors.observe((editorLinter) => {
      const filePath = editorLinter.getEditor().getPath?.();
      if (filePath) {
        this.registryIndieInit();
        for (const delegate of this.registryIndie.getProviders()) {
          if (delegate.deleteOnOpen) {
            delegate.deleteFilePath(filePath);
          }
        }
      }
      editorLinter.onShouldLint((trigger) => {
        this.registryLintersInit();
        const editor = editorLinter.getEditor();
        this.registryLinters.lint({
          trigger,
          editor,
          isDisabled: () => this.registryEditors.isBufferDisabled(editor.getBuffer()),
        });
      });
      editorLinter.onDidDestroy(() => {
        if (this.disposed) return;
        this.registryMessagesInit();
        if (!this.registryEditors.hasSibling(editorLinter)) {
          const editor = editorLinter.getEditor();
          const buffer = editor.getBuffer();
          this.registryLinters?.cancelBuffer(
            buffer,
            editor.isDestroyed() ? "destroyed" : "unregistered",
          );
          this.registryMessages.deleteByBuffer(buffer);
        }
      });
    });
    this.registryEditors.activate();
  }

  registryLintersInit() {
    if (this.disposed || this.registryLinters !== undefined) {
      return;
    }
    const LinterRegistry = require("./linter-registry");
    this.registryLinters = new LinterRegistry();
    this.subscriptions.add(this.registryLinters);
    this.registryLinters.onDidUpdateMessages(({ linter, messages, buffer }) => {
      if (this.disabledProviders.has(linter.name)) return;
      if (messages.length || this.registryMessages) {
        this.registryMessagesInit();
        this.registryMessages.set({ linter, messages, buffer });
      }
    });
    this.registryLinters.onDidBeginLinting((event) => {
      this.uiBeginLintingCallback?.(event);
    });
    this.registryLinters.onDidFinishLinting((event) => {
      this.uiFinishLintingCallback?.(event);
    });
  }

  registryIndieInit() {
    if (this.registryIndie !== undefined) {
      return;
    }
    const IndieRegistry = require("./indie-registry");
    this.registryIndie = new IndieRegistry();
    this.subscriptions.add(this.registryIndie);
    this.registryIndie.observe((indieLinter) => {
      indieLinter.onDidDestroy(() => {
        this.registryMessages?.deleteByLinter(indieLinter);
        this.refreshProviderViews();
      });
      this.refreshProviderViews();
    });
    this.registryIndie.onDidUpdate((event) => this.publishIndieMessages(event));
  }

  publishIndieMessages({ linter, messages, options, affectedFiles }) {
    if (linter.deleteOnOpen) {
      for (const editor of lumine.workspace.getTextEditors()) {
        // Apply this policy even while muted, so restoring a snapshot cannot
        // bring back project results for an open document.
        const filePath = normalizePath(editor.getPath?.());
        if (filePath) linter.messages.delete(filePath);
      }
      messages = linter.getMessages();
    }
    if (this.disabledProviders.has(linter.name)) return;
    if (messages.length || this.registryMessages) {
      this.registryMessagesInit();
      this.registryMessages.set({ linter, messages, buffer: null, affectedFiles });
    }
    if (options?.showProjectView && this.uiProjectViewCallback) {
      this.uiProjectViewCallback();
    }
  }

  registryMessagesInit() {
    if (this.registryMessages) {
      return;
    }
    const MessageRegistry = require("./message-registry");
    this.registryMessages = new MessageRegistry();
    this.subscriptions.add(this.registryMessages);
    this.registryMessages.onDidUpdateMessages((difference) => {
      this.syncDiagnosticBuffers();
      // Direct call to UI render callback
      if (this.uiRenderCallback) {
        this.uiRenderCallback(difference);
      }
    });
  }

  addLinter(linter) {
    if (this.disposed) return;
    this.registryLintersInit();
    if (!this.registryLinters.addLinter(linter)) {
      return;
    }
    this.refreshProviderViews();
    if (this.registryEditors?.shouldLintOnOpen()) {
      this.registryEditors.lintEditors();
    }
  }

  deleteLinter(linter) {
    if (this.disposed) return;
    this.registryLintersInit();
    this.registryLinters.deleteLinter(linter);
    this.registryMessages?.deleteByLinter(linter);
    this.refreshProviderViews();
  }

  addIndie(indie) {
    this.registryIndieInit();
    return this.registryIndie.register(indie, 2);
  }

  deleteMessages(messages) {
    this.registryMessagesInit();
    this.registryMessages.deleteMessages(messages);
  }

  clearAll() {
    this.registryMessagesInit();
    this.registryMessages.deleteAll();
    this.registryIndieInit();
    for (const delegate of this.registryIndie.getProviders()) {
      delegate.clearMessages();
    }
  }
}
let uiRuntime;
const getUIRuntime = () => (uiRuntime ||= require("./linter-ui-runtime"));
const DEFAULT_LARGE_FILE_LINE_COUNT = 20000;
const DEFAULT_LONG_LINE_LENGTH = 4000;
function destroyBufferState(buffer) {
  return getUIRuntime().destroyBufferState(buffer);
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
    this.initializationTasks = new Set();
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
    // Cancel deferred shared-runtime initialization.
    this.initializationTasks.forEach((callbackID) => clearImmediate(callbackID));
    this.initializationTasks.clear();
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
    return getUIRuntime().scheduleProjectionCatchUp.apply(this, args);
  }

  /**
   * Checks if a buffer is considered "large" based on line count or line length.
   * @param {TextBuffer} buffer - The buffer to check
   * @returns {boolean} True if the buffer is large
   */
  isLargeBuffer(...args) {
    return getUIRuntime().isLargeBuffer.apply(this, args);
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
    return getUIRuntime().isLargeFile.apply(this, args);
  }

  /**
   * Patches an editor with linter marker layers for highlighting.
   * @param {TextEditor} editor - The text editor to patch
   */
  patchEditor(...args) {
    return getUIRuntime().patchEditor.apply(this, args);
  }

  /**
   * Forgets an editor's buffer, and retires what the UI put on that buffer
   * along with the last editor showing it.
   * @param {TextBuffer} buffer
   */
  releaseBuffer(...args) {
    return getUIRuntime().releaseBuffer.apply(this, args);
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
    return getUIRuntime().getMarkerMessages.apply(this, args);
  }

  /**
   * Assigns linter messages to their corresponding buffers.
   * @param {Object} args - Object containing added, removed, and all messages
   */
  assignMessages(...args) {
    return getUIRuntime().assignMessages.apply(this, args);
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
    return getUIRuntime().updateMarkers.apply(this, args);
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

  getMessagesAtPosition(...args) {
    return getUIRuntime().getMessagesAtPosition.apply(this, args);
  }

  revealMessage(...args) {
    return getUIRuntime().revealMessage.apply(this, args);
  }

  // Message inspection. The message itself is shown by the hover package,
  // which asks this one for whatever covers the cursor — so these commands
  // put the cursor on a message and open the tooltip there. Without that
  // package installed they still navigate; there is simply nothing to open.
  inspect(...args) {
    return getUIRuntime().inspect.apply(this, args);
  }

  inspectNext(...args) {
    return getUIRuntime().inspectNext.apply(this, args);
  }

  inspectPrevious(...args) {
    return getUIRuntime().inspectPrevious.apply(this, args);
  }

  inspectMessage(...args) {
    return getUIRuntime().inspectMessage.apply(this, args);
  }

  showTooltipAtCursor(...args) {
    return getUIRuntime().showTooltipAtCursor.apply(this, args);
  }

  deleteMessage(...args) {
    return getUIRuntime().deleteMessage.apply(this, args);
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
  queueMessageDeletion(...args) {
    return getUIRuntime().queueMessageDeletion.apply(this, args);
  }

  /**
   * Commits every queued deletion as one update.
   */
  flushPendingDeletions(...args) {
    return getUIRuntime().flushPendingDeletions.apply(this, args);
  }

  /**
   * Gets the linter message at the current cursor position.
   * @returns {Object|undefined} The message at cursor or undefined
   */
  getCurrentMessage(...args) {
    return getUIRuntime().getCurrentMessage.apply(this, args);
  }

  /**
   * Gets the next linter message after the cursor position.
   * @returns {Object|undefined} The next message or first message if at end
   */
  getNextMessage(...args) {
    return getUIRuntime().getNextMessage.apply(this, args);
  }

  /**
   * Gets the previous linter message before the cursor position.
   * @returns {Object|undefined} The previous message or last message if at start
   */
  getPreviousMessage(...args) {
    return getUIRuntime().getPreviousMessage.apply(this, args);
  }
}
module.exports = { Commands, showDebug, Linter, LinterUI };
