const { Emitter, CompositeDisposable, Disposable } = require("lumine");
const EditorLinter = require("./editor-linter");

class EditorRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.lintOnOpen = true;
    this.subscriptions = new CompositeDisposable();
    this.editorLinters = new Map();
    this.editorRegistrations = new Map();
    this.disabledBuffers = new WeakSet();
    this.subscriptions.add(
      this.emitter,
      lumine.config.observe("linter.lintOnOpen", (lintOnOpen) => {
        this.lintOnOpen = lintOnOpen;
      }),
    );
  }

  // Only pane items are discovered. A package builds editors of its own to
  // render a diff, a patch preview or a dock's input field with, and none of
  // those is a document; one that is — a commit box, a notebook's source
  // editor — is registered by its owner through the `linter.editors` service,
  // which acquires its own lease through `registerEditor`.
  activate() {
    if (this.disposed || this.active) return;
    this.active = true;
    this.subscriptions.add(
      lumine.workspace.observeTextEditors((textEditor) => {
        this.createFromTextEditor(textEditor);
      }),
    );
  }

  get(textEditor) {
    return this.editorLinters.get(textEditor);
  }

  getEditorForBuffer(buffer) {
    return [...this.editorLinters.keys()].find(
      (editor) => !editor.isDestroyed() && editor.getBuffer() === buffer,
    );
  }

  onDidDisableBuffer(callback) {
    return this.emitter.on("did-disable-buffer", callback);
  }

  createFromTextEditor(textEditor) {
    const registration = this.getOrCreateRegistration(textEditor);
    if (!registration) return null;
    // Pane discovery is one registry-owned enrollment, regardless of how
    // many explicit service consumers also borrow the same editor.
    registration.automatic = true;
    return this.ensureEditorLinter(registration);
  }

  registerEditor(textEditor) {
    const registration = this.getOrCreateRegistration(textEditor);
    if (!registration) return new Disposable();
    const lease = {};
    registration.leases.add(lease);
    this.ensureEditorLinter(registration);
    return new Disposable(() => {
      if (registration.retired || !registration.leases.delete(lease)) return;
      if (!registration.automatic && registration.leases.size === 0) {
        this.retireRegistration(registration);
      }
    });
  }

  getOrCreateRegistration(textEditor) {
    if (this.disposed || !lumine.workspace.isTextEditor(textEditor) || textEditor.isDestroyed()) {
      return null;
    }
    let registration = this.editorRegistrations.get(textEditor);
    if (registration) return registration;
    registration = {
      editor: textEditor,
      automatic: false,
      leases: new Set(),
      linter: null,
      retired: false,
      destroySubscription: null,
    };
    this.editorRegistrations.set(textEditor, registration);
    registration.destroySubscription = textEditor.onDidDestroy(() =>
      this.retireRegistration(registration),
    );
    return registration;
  }

  ensureEditorLinter(registration) {
    const textEditor = registration.editor;
    if (registration.retired || this.isBufferDisabled(textEditor.getBuffer())) return null;
    if (registration.linter) return registration.linter;
    const editorLinter = new EditorLinter(textEditor);
    registration.linter = editorLinter;
    editorLinter.onDidDestroy(() => {
      if (this.editorLinters.get(textEditor) === editorLinter) {
        this.editorLinters.delete(textEditor);
      }
      if (registration.linter === editorLinter) registration.linter = null;
    });
    this.editorLinters.set(textEditor, editorLinter);
    this.emitter.emit("observe", editorLinter);
    if (this.lintOnOpen) {
      editorLinter.lint();
    }
    return editorLinter;
  }

  retireRegistration(registration) {
    if (registration.retired) return;
    registration.retired = true;
    this.editorRegistrations.delete(registration.editor);
    registration.leases.clear();
    registration.destroySubscription?.dispose();
    registration.destroySubscription = null;
    registration.linter?.dispose();
    registration.linter = null;
    registration.editor = null;
  }

  isBufferDisabled(buffer) {
    return this.disabledBuffers.has(buffer);
  }

  isTextEditorDisabled(textEditor) {
    return this.isBufferDisabled(textEditor.getBuffer());
  }

  disableTextEditorBuffer(textEditor) {
    const buffer = textEditor.getBuffer();
    this.disabledBuffers.add(buffer);
    this.emitter.emit("did-disable-buffer", buffer);
    for (const [editor, editorLinter] of Array.from(this.editorLinters)) {
      if (editor.getBuffer() === buffer) {
        editorLinter.dispose();
      }
    }
  }

  enableTextEditorBuffer(textEditor) {
    const buffer = textEditor.getBuffer();
    this.disabledBuffers.delete(buffer);
    for (const registration of this.editorRegistrations.values()) {
      if (registration.editor.getBuffer() === buffer) {
        this.ensureEditorLinter(registration);
      }
    }
  }

  hasSibling(editorLinter) {
    const buffer = editorLinter.getEditor().getBuffer();
    for (const editor of this.editorLinters.keys()) {
      if (editor.getBuffer() === buffer) {
        return true;
      }
    }
    return false;
  }

  shouldLintOnOpen() {
    return this.lintOnOpen;
  }

  lintEditors() {
    for (const editorLinter of this.editorLinters.values()) {
      editorLinter.lint();
    }
  }

  observe(callback) {
    this.editorLinters.forEach(callback);
    return this.emitter.on("observe", callback);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const registration of [...this.editorRegistrations.values()]) {
      this.retireRegistration(registration);
    }
    this.subscriptions.dispose();
  }
}

module.exports = EditorRegistry;
