const { Emitter, CompositeDisposable } = require("atom");
const EditorLinter = require("./editor-linter");

class EditorRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.lintOnOpen = true;
    this.subscriptions = new CompositeDisposable();
    this.editorLinters = new Map();
    this.disabledBuffers = new WeakSet();
    this.subscriptions.add(
      this.emitter,
      atom.config.observe("linter-bundle.lintOnOpen", (lintOnOpen) => {
        this.lintOnOpen = lintOnOpen;
      }),
    );
  }

  activate() {
    const subscriptions = [];
    const observeRegisteredEditors = atom.textEditors && atom.textEditors.observe;

    if (observeRegisteredEditors) {
      subscriptions.push(
        atom.textEditors.observe((textEditor) => {
          this.createFromTextEditor(textEditor);
        }),
      );
    }

    subscriptions.push(
      atom.workspace.observeTextEditors((textEditor) => {
        this.createFromTextEditor(textEditor);
      }),
    );

    this.subscriptions.add(...subscriptions);
  }

  get(textEditor) {
    return this.editorLinters.get(textEditor);
  }

  createFromTextEditor(textEditor) {
    if (this.isBufferDisabled(textEditor.getBuffer())) {
      return null;
    }
    let editorLinter = this.editorLinters.get(textEditor);
    if (editorLinter) {
      return editorLinter;
    }
    editorLinter = new EditorLinter(textEditor);
    editorLinter.onDidDestroy(() => {
      this.editorLinters.delete(textEditor);
    });
    this.editorLinters.set(textEditor, editorLinter);
    this.emitter.emit("observe", editorLinter);
    if (this.lintOnOpen) {
      editorLinter.lint();
    }
    return editorLinter;
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
    for (const [editor, editorLinter] of Array.from(this.editorLinters)) {
      if (editor.getBuffer() === buffer) {
        editorLinter.dispose();
      }
    }
  }

  enableTextEditorBuffer(textEditor) {
    const buffer = textEditor.getBuffer();
    this.disabledBuffers.delete(buffer);
    for (const editor of atom.workspace.getTextEditors()) {
      if (editor.getBuffer() === buffer) {
        this.createFromTextEditor(editor);
      }
    }
  }

  hasSibling(editorLinter) {
    const buffer = editorLinter.getEditor().getBuffer();
    return Array.from(this.editorLinters.keys()).some((item) => item.getBuffer() === buffer);
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
    for (const entry of this.editorLinters.values()) {
      entry.dispose();
    }
    this.subscriptions.dispose();
  }
}

module.exports = EditorRegistry;
