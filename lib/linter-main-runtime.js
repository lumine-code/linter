const { TextBuffer } = require("lumine");
const { unique: arrayUnique } = require("./util");
class Runtime {
  async lintEditor(editor, options) {
    const { outcome, validateOptions } = require("./lint-request");
    const signal = validateOptions(options);
    if (editor == null) return outcome("skipped", "no-target");
    if (!lumine.workspace.isTextEditor(editor))
      throw new TypeError("lintEditor requires a TextEditor");
    if (this.disposed) return outcome("cancelled", "disposed");
    if (editor.isDestroyed()) return outcome("cancelled", "destroyed");
    if (signal?.aborted) return outcome("cancelled", "aborted");
    this.registryEditorsInit();
    this.registryLintersInit();
    const buffer = editor.getBuffer();
    return this.registryLinters.lint({
      editor,
      buffer,
      signal,
      isDisabled: () => this.registryEditors.isBufferDisabled(buffer),
    });
  }
  async lintBuffer(buffer, options) {
    const { outcome, validateOptions } = require("./lint-request");
    const signal = validateOptions(options);
    if (buffer == null) return outcome("skipped", "no-target");
    if (!(buffer instanceof TextBuffer)) throw new TypeError("lintBuffer requires a TextBuffer");
    if (this.disposed) return outcome("cancelled", "disposed");
    if (!buffer.isAlive()) return outcome("cancelled", "destroyed");
    if (signal?.aborted) return outcome("cancelled", "aborted");
    if (!buffer.getPath()) return outcome("skipped", "no-path");
    this.registryEditorsInit();
    const openEditor =
      lumine.workspace.getTextEditors().find((editor) => editor.getBuffer() === buffer) ||
      this.registryEditors.getEditorForBuffer(buffer);
    if (openEditor) return this.lintEditor(openEditor, { signal });
    this.registryLintersInit();
    return this.registryLinters.lint({
      buffer,
      signal,
      createEditor: (...args) => require("./lint-snapshot").createLintSnapshot(...args),
      isDisabled: () => this.registryEditors.isBufferDisabled(buffer),
    });
  }
  observeDiagnosticBuffer(buffer) {
    if (!this.diagnosticBuffers.has(buffer)) {
      this.diagnosticBuffers.set(
        buffer,
        buffer.onDidDestroy(() => {
          this.registryMessages?.deleteByBuffer(buffer);
          this.diagnosticBuffers.get(buffer)?.dispose();
          this.diagnosticBuffers.delete(buffer);
        }),
      );
    }
  }
  syncDiagnosticBuffers() {
    if (this.disposed) return;
    const current = this.registryMessages.getDiagnosticBuffers();
    for (const [buffer, subscription] of this.diagnosticBuffers) {
      if (current.has(buffer)) continue;
      subscription.dispose();
      this.diagnosticBuffers.delete(buffer);
    }
    for (const buffer of current) this.observeDiagnosticBuffer(buffer);
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
}
module.exports = Runtime.prototype;
