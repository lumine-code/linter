const arrayUnique = require("lodash/uniq");
const { CompositeDisposable } = require("atom");
const IndieRegistry = require("./indie-registry");
const MessageRegistry = require("./message-registry");
const LinterRegistry = require("./linter-registry");
const EditorsRegistry = require("./editor-registry");
const { Commands, showDebug } = require("./commands");
const ToggleView = require("./toggle-view");

class Linter {
  constructor() {
    this.commands = new Commands();
    this.subscriptions = new CompositeDisposable();
    this.idleCallbacks = new Set();
    this.itemAdapters = new Set();
    // UI render callback - will be set by index.js
    this.uiRenderCallback = null;
    this.uiLintingStateCallback = null;

    this.subscriptions.add(this.commands);

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
      this.registryLintersInit();
      const toggleView = new ToggleView(
        arrayUnique(this.registryLinters.getProviders().map((linter) => linter.name)),
      );
      toggleView.onDidDispose(() => {
        this.subscriptions.remove(toggleView);
      });
      toggleView.onDidDisable((name) => {
        const linter = this.registryLinters.getProviders().find((entry) => entry.name === name);
        if (linter) {
          this.registryMessagesInit();
          this.registryMessages.deleteByLinter(linter);
        }
      });
      toggleView.onDidFinish(() => {
        this.registryEditorsInit();
        for (const editorLinter of this.registryEditors.editorLinters.values()) {
          editorLinter.lint();
        }
      });
      toggleView.show();
      this.subscriptions.add(toggleView);
    });

    const projectPathChangeCallbackID = window.requestIdleCallback(() => {
      this.idleCallbacks.delete(projectPathChangeCallbackID);
      this.subscriptions.add(
        atom.project.onDidChangePaths(() => {
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
    this.idleCallbacks.forEach((callbackID) => window.cancelIdleCallback(callbackID));
    this.idleCallbacks.clear();
    this.subscriptions.dispose();
  }

  // Set the UI render callback for direct integration
  setUIRenderCallback(callback) {
    this.uiRenderCallback = callback;
  }

  setUILintingStateCallback(callback) {
    this.uiLintingStateCallback = callback;
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
    if (atom.workspace.isTextEditor(item)) {
      return item;
    }

    const adapter = this.getAdapterForItem(item);
    const textEditor = adapter?.getTextEditorForItem?.(item);
    if (textEditor && atom.workspace.isTextEditor(textEditor)) {
      return textEditor;
    }

    return null;
  }

  getActiveTextEditor() {
    return this.getTextEditorForItem(atom.workspace.getCenter().getActivePaneItem());
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
      editorLinter.onShouldLint((onChange) => {
        this.registryLintersInit();
        this.registryLinters.lint({
          onChange,
          editor: editorLinter.getEditor(),
        });
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
      this.registryMessagesInit();
      this.registryMessages.set({ linter, messages, buffer });
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
      });
    });
    this.registryIndie.onDidUpdate(({ linter, messages, options }) => {
      if (linter.deleteOnOpen) {
        for (const editor of atom.workspace.getTextEditors()) {
          const filePath = editor.getPath?.();
          if (filePath) {
            linter.messages.delete(filePath);
          }
        }
        messages = linter.getMessages();
      }
      this.registryMessagesInit();
      this.registryMessages.set({ linter, messages, buffer: null });
      if (options?.showProjectView && this.uiProjectViewCallback) {
        this.uiProjectViewCallback();
      }
    });
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
    if (this.registryEditors?.shouldLintOnOpen()) {
      this.registryEditors.lintEditors();
    }
  }

  deleteLinter(linter) {
    this.registryLintersInit();
    this.registryLinters.deleteLinter(linter);
    this.registryMessagesInit();
    this.registryMessages.deleteByLinter(linter);
  }

  addIndie(indie) {
    this.registryIndieInit();
    return this.registryIndie.register(indie, 2);
  }

  deleteMessage(message) {
    this.registryMessagesInit();
    this.registryMessages.deleteMessage(message);
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
