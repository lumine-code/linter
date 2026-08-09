const { Emitter, CompositeDisposable } = require("lumine");
const { debounce } = require("./util");

// Debounce configuration constants for consistency
const DEBOUNCE_SAVE_MS = 50;
const DEBOUNCE_CHANGE_DEFAULT_MS = 300;

class EditorLinter {
  constructor(editor) {
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    if (!lumine.workspace.isTextEditor(editor)) {
      throw new Error("EditorLinter expects a valid TextEditor");
    }
    const editorBuffer = editor.getBuffer();
    this.editor = editor;

    // Store reference to current debounced change handler for proper cleanup
    this.currentDebouncedChangeHandler = null;
    // Store current buffer change subscription for proper disposal
    this.currentBufferChangeSubscription = null;

    // Initialize debounced change handler with default interval
    const initialInterval =
      lumine.config.get("linter.lintOnChangeInterval") || DEBOUNCE_CHANGE_DEFAULT_MS;
    this.currentDebouncedChangeHandler = debounce(() => {
      this.emitter.emit("should-lint", true);
    }, initialInterval);
    this.currentBufferChangeSubscription = editorBuffer.onDidChange(
      this.currentDebouncedChangeHandler,
    );

    const debouncedLint = debounce(
      () => {
        this.emitter.emit("should-lint", false);
      },
      DEBOUNCE_SAVE_MS,
      { leading: true },
    );

    this.subscriptions.add(
      this.editor.onDidDestroy(() => this.dispose()),
      this.editor.onDidSave(debouncedLint),
      editorBuffer.onDidReload(debouncedLint),
      lumine.config.observe("linter.lintOnChangeInterval", (interval) => {
        // Cancel any pending debounced calls from previous handler
        if (this.currentDebouncedChangeHandler) {
          this.currentDebouncedChangeHandler.cancel();
        }
        // Dispose previous buffer change subscription to prevent memory leak
        if (this.currentBufferChangeSubscription) {
          this.currentBufferChangeSubscription.dispose();
        }
        // Create new debounced handler with updated interval
        this.currentDebouncedChangeHandler = debounce(() => {
          this.emitter.emit("should-lint", true);
        }, interval);
        // Create new subscription and store reference for cleanup
        this.currentBufferChangeSubscription = editorBuffer.onDidChange(
          this.currentDebouncedChangeHandler,
        );
      }),
    );
  }

  getEditor() {
    return this.editor;
  }

  lint(onChange = false) {
    this.emitter.emit("should-lint", onChange);
  }

  onShouldLint(callback) {
    return this.emitter.on("should-lint", callback);
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  dispose() {
    this.emitter.emit("did-destroy");
    // Cancel any pending debounced change handler before disposal
    if (this.currentDebouncedChangeHandler) {
      this.currentDebouncedChangeHandler.cancel();
      this.currentDebouncedChangeHandler = null;
    }
    // Dispose buffer change subscription
    if (this.currentBufferChangeSubscription) {
      this.currentBufferChangeSubscription.dispose();
      this.currentBufferChangeSubscription = null;
    }
    this.subscriptions.dispose();
    this.emitter.dispose();
  }
}

module.exports = EditorLinter;
