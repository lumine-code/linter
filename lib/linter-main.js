const { unique: arrayUnique } = require("./util");
const { CompositeDisposable } = require("lumine");
const IndieRegistry = require("./indie-registry");
const MessageRegistry = require("./message-registry");
const LinterRegistry = require("./linter-registry");
const EditorsRegistry = require("./editor-registry");
const { Commands, showDebug } = require("./commands");
const { normalizePath } = require("./helpers");
const ToggleView = require("./toggle-view");

class Linter {
  constructor() {
    this.commands = new Commands();
    this.subscriptions = new CompositeDisposable();
    this.idleCallbacks = new Set();
    this.itemAdapters = new Set();
    this.toggleViews = new Set();
    this.disabledProviders = new Set();
    // UI render callback - will be set by index.js
    this.uiRenderCallback = null;
    this.uiLintingStateCallback = null;

    this.subscriptions.add(
      this.commands,
      lumine.config.observe("linter.disabledProviders", (names) =>
        this.setDisabledProviders(names),
      ),
    );

    this.commands.onShouldLint(() => {
      this.registryEditorsInit();
      const textEditor = this.getActiveTextEditor();
      if (!textEditor) {
        return;
      }
      const editorLinter = this.registryEditors.get(textEditor);
      if (editorLinter) {
        editorLinter.lint();
      }
    });

    this.commands.onShouldToggleActiveEditor(() => {
      const textEditor = this.getActiveTextEditor();
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

    this.commands.onShouldDebug(async () => {
      this.registryIndieInit();
      this.registryLintersInit();
      await showDebug(
        this.registryLinters.getProviders(),
        this.registryIndie.getProviders(),
        this.getActiveTextEditor(),
      );
    });

    this.commands.onShouldToggleLinter(() => {
      const toggleView = new ToggleView(this.getProviderNames());
      this.toggleViews.add(toggleView);
      toggleView.onDidDispose(() => {
        this.toggleViews.delete(toggleView);
        this.subscriptions.remove(toggleView);
      });
      toggleView.show();
      this.subscriptions.add(toggleView);
    });

    const projectPathChangeCallbackID = window.requestIdleCallback(() => {
      this.idleCallbacks.delete(projectPathChangeCallbackID);
      this.subscriptions.add(
        lumine.project.onDidChangePaths(() => {
          this.commands.lint();
        }),
      );
    });
    this.idleCallbacks.add(projectPathChangeCallbackID);

    const registryEditorsInitCallbackID = window.requestIdleCallback(() => {
      this.idleCallbacks.delete(registryEditorsInitCallbackID);
      this.registryEditorsInit();
    });
    this.idleCallbacks.add(registryEditorsInitCallbackID);
  }

  dispose() {
    this.disposed = true;
    this.idleCallbacks.forEach((callbackID) => window.cancelIdleCallback(callbackID));
    this.idleCallbacks.clear();
    this.subscriptions.dispose();
  }

  getProviderNames() {
    this.registryLintersInit();
    this.registryIndieInit();
    return arrayUnique(
      [...this.registryLinters.getProviders(), ...this.registryIndie.getProviders()].map(
        (linter) => linter.name,
      ),
    ).sort((first, second) => first.localeCompare(second));
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

  getTextEditorForItem(item) {
    if (!item) return null;
    if (lumine.workspace.isTextEditor(item)) {
      return item;
    }

    const adapter = this.getAdapterForItem(item);
    const textEditor = adapter?.getTextEditorForItem?.(item);
    if (textEditor && lumine.workspace.isTextEditor(textEditor)) {
      return textEditor;
    }

    return null;
  }

  getActiveTextEditor() {
    return this.getTextEditorForItem(lumine.workspace.getCenter().getActivePaneItem());
  }

  registryEditorsInit() {
    if (this.registryEditors !== undefined) {
      return;
    }
    this.registryEditors = new EditorsRegistry();
    this.subscriptions.add(this.registryEditors);
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
        this.registryLinters.lint({ trigger, editor: editorLinter.getEditor() });
      });
      editorLinter.onDidDestroy(() => {
        this.registryMessagesInit();
        if (!this.registryEditors.hasSibling(editorLinter)) {
          this.registryMessages.deleteByBuffer(editorLinter.getEditor().getBuffer());
        }
      });
    });
    this.registryEditors.activate();
  }

  registryLintersInit() {
    if (this.registryLinters !== undefined) {
      return;
    }
    this.registryLinters = new LinterRegistry();
    this.subscriptions.add(this.registryLinters);
    this.registryLinters.onDidUpdateMessages(({ linter, messages, buffer }) => {
      if (this.disabledProviders.has(linter.name)) return;
      this.registryMessagesInit();
      this.registryMessages.set({ linter, messages, buffer });
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
    this.registryIndie = new IndieRegistry();
    this.subscriptions.add(this.registryIndie);
    this.registryIndie.observe((indieLinter) => {
      indieLinter.onDidDestroy(() => {
        this.registryMessagesInit();
        this.registryMessages.deleteByLinter(indieLinter);
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
    this.registryMessagesInit();
    this.registryMessages.set({ linter, messages, buffer: null, affectedFiles });
    if (options?.showProjectView && this.uiProjectViewCallback) {
      this.uiProjectViewCallback();
    }
  }

  registryMessagesInit() {
    if (this.registryMessages) {
      return;
    }
    this.registryMessages = new MessageRegistry();
    this.subscriptions.add(this.registryMessages);
    this.registryMessages.onDidUpdateMessages((difference) => {
      // Direct call to UI render callback
      if (this.uiRenderCallback) {
        this.uiRenderCallback(difference);
      }
    });
  }

  addLinter(linter) {
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
    this.registryLintersInit();
    this.registryLinters.deleteLinter(linter);
    this.registryMessagesInit();
    this.registryMessages.deleteByLinter(linter);
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

module.exports = Linter;
