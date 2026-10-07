const { CompositeDisposable } = require("lumine");

const CANCELLED = Symbol("cancelled lint operation");

function errorText(error) {
  try {
    return error instanceof Error && typeof error.message === "string"
      ? error.message
      : String(error);
  } catch {
    return "The operation failed with an unreadable error";
  }
}

function outcome(status, reason = null, providers = [], error) {
  const result = { status, reason, providers: providers.map((provider) => ({ ...provider })) };
  if (error !== undefined) result.error = errorText(error);
  return result;
}

function validateOptions(options) {
  if (options === undefined) return undefined;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Lint options must be an object");
  }
  const { signal } = options;
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    throw new TypeError("Lint signal must be an AbortSignal");
  }
  return signal;
}

// A request owns cancellation and observation, never the caller's model. The
// same primitive also retires an individual provider without cancelling its
// siblings. Late promise settlements always have rejection handlers attached.
class LintRequest {
  constructor({ buffer, editor, signal, id } = {}) {
    this.id = id;
    this.buffer = buffer;
    this.editor = editor;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.subscriptions = new CompositeDisposable();
    this.reason = null;
    this.closed = false;
    if (buffer) {
      this.input = {
        text: buffer.getText(),
        filePath: buffer.getPath(),
        grammar: buffer.getLanguageMode().grammar,
        encoding: buffer.getEncoding(),
      };
      this.subscriptions.add(
        buffer.onDidChange(() => this.cancel("changed")),
        buffer.onDidChangePath(() => this.cancel("path-changed")),
        buffer.onDidChangeEncoding(() => this.cancel("encoding-changed")),
        buffer.onDidChangeLanguageMode(() => this.cancel("grammar-changed")),
        buffer.onDidDestroy(() => this.cancel("destroyed")),
      );
    }
    if (editor) this.observeEditor(editor);
    if (signal) {
      const cancel = () => this.cancel("aborted");
      signal.addEventListener("abort", cancel, { once: true });
      this.subscriptions.add({ dispose: () => signal.removeEventListener("abort", cancel) });
      if (signal.aborted) cancel();
    }
  }

  observeEditor(editor) {
    this.editor = editor;
    this.subscriptions.add(editor.onDidDestroy(() => this.cancel("destroyed")));
  }

  link(parent) {
    const cancel = () => this.cancel(parent.reason || "cancelled");
    parent.signal.addEventListener("abort", cancel, { once: true });
    this.subscriptions.add({ dispose: () => parent.signal.removeEventListener("abort", cancel) });
    if (parent.signal.aborted) cancel();
  }

  cancel(reason) {
    if (this.closed || this.reason) return;
    this.reason = reason;
    this.controller.abort(reason);
  }

  isCurrent() {
    return !this.closed && !this.reason;
  }

  wait(promise, { timeout, timeoutReason = "timeout" } = {}) {
    if (this.reason) {
      // The operation may already have started before cancellation. Consume
      // its rejection even when no caller is waiting for its eventual result.
      Promise.resolve(promise).catch(() => {});
      return Promise.resolve(CANCELLED);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal.removeEventListener("abort", cancel);
        callback(value);
      };
      const cancel = () => finish(resolve, CANCELLED);
      this.signal.addEventListener("abort", cancel, { once: true });
      if (timeout !== undefined) {
        timer = setTimeout(() => this.cancel(timeoutReason), timeout);
      }
      Promise.resolve(promise).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
      if (this.signal.aborted) cancel();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.subscriptions.dispose();
    this.buffer = null;
    this.editor = null;
    this.input = null;
  }
}

module.exports = { LintRequest, CANCELLED, outcome, validateOptions, errorText };
