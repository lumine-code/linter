const { Emitter, CompositeDisposable } = require("lumine");
const { isProxy } = require("node:util").types;
const timers = require("node:timers");
const { normalizePath, DEFAULT_MARKER_INVALIDATION } = require("./message-metadata");
let messageHelpers;
const getHelpers = () => (messageHelpers ||= require("./helpers"));

function fileSnapshot(messages, filePath) {
  // Keep the existing array callback shape. The internal registry can read the
  // additive hint without changing iteration or enumerable snapshot contents.
  Object.defineProperty(messages, "affectedFiles", { value: [filePath] });
  return messages;
}

class IndieDelegate {
  constructor(indie, version) {
    this.scope = "project";
    this.emitter = new Emitter();
    this.messages = new Map();
    this.pendingPreparations = new Map();
    this.subscriptions = new CompositeDisposable();
    this.indie = indie;
    this.version = version;
    this.deleteOnOpen = indie.deleteOnOpen || false;
    this.markerInvalidation = indie.markerInvalidation || DEFAULT_MARKER_INVALIDATION;
    this.subscriptions.add(this.emitter);
  }

  get name() {
    return this.indie.name;
  }

  getMessages() {
    const out = [];
    this.messages.forEach((m) => {
      if (m.length) getHelpers().mergeArray(out, m);
    });
    return out;
  }

  clearMessages() {
    if (!this.subscriptions.disposed) {
      this.cancelPreparations();
      this.messages.clear();
      this.emitter.emit("did-update", []);
    }
  }

  // Keyed by `normalizePath`, because the caller replacing or deleting a file's
  // messages is rarely the one that set them: an editor closing deletes by
  // `editor.getPath()`, while a language server set them under whatever it
  // spelled the same file as. Keyed raw, that delete misses and the messages
  // outlive the editor.
  deleteFilePath(filePath) {
    const key = normalizePath(filePath);
    this.cancelPreparation(key);
    if (!this.subscriptions.disposed && this.messages.has(key)) {
      this.messages.delete(key);
      this.emitter.emit("did-update", fileSnapshot(this.getMessages(), key));
    }
  }

  setMessages(filePath, messages = null) {
    if (typeof filePath !== "string" || !Array.isArray(messages)) {
      throw new Error("Invalid Parameters to setMessages()");
    }
    if (this.subscriptions.disposed) return;
    const key = normalizePath(filePath);
    this.cancelPreparation(key);
    const positionCache = new WeakMap();
    const needsValidation = isProxy(messages) || messages.length > 0;
    if (needsValidation && !require("./validate").messages(this.name, messages, positionCache))
      return;
    // Normalized first, so the check below reads the path each message already
    // carries rather than spelling it out a second time.
    if (messages.length)
      getHelpers().normalizeMessages(this.name, messages, {
        markerInvalidation: this.markerInvalidation,
        positionCache,
      });
    messages.forEach(function (message) {
      // Compared the same way: a message spelling the same file differently is
      // not a mismatched message.
      if (message.location.normalizedFile !== key) {
        console.debug("[Linter-UI-Default] Expected File", filePath, "Message", message);
        throw new Error("message.location.file does not match the given filePath");
      }
    });
    this.messages.set(key, messages);
    this.emitter.emit("did-update", fileSnapshot(this.getMessages(), key));
  }

  cancelPreparation(key) {
    this.pendingPreparations.get(key)?.cancel();
  }

  cancelPreparations() {
    for (const preparation of this.pendingPreparations.values()) preparation.cancel();
  }

  async setMessagesAsync(filePath, messages = null, { signal, isCurrent } = {}) {
    if (typeof filePath !== "string" || !Array.isArray(messages))
      throw new Error("Invalid Parameters to setMessagesAsync()");
    if (
      this.subscriptions.disposed ||
      this.disposing ||
      signal?.aborted ||
      (isCurrent && !isCurrent())
    )
      return false;
    const key = normalizePath(filePath);
    const linterName = this.name;
    const markerInvalidation = this.markerInvalidation;
    this.cancelPreparation(key);
    const preparation = {
      cancelled: false,
      wake: null,
      cancel: () => {
        preparation.cancelled = true;
        if (this.pendingPreparations.get(key) === preparation) this.pendingPreparations.delete(key);
        preparation.wake?.();
      },
    };
    this.pendingPreparations.set(key, preparation);
    const owned = () =>
      !preparation.cancelled &&
      !this.subscriptions.disposed &&
      !this.disposing &&
      !signal?.aborted &&
      this.pendingPreparations.get(key) === preparation;
    const current = () => owned() && (!isCurrent || isCurrent()) && owned();
    let deadline = 0;
    const pause = () =>
      new Promise((resolve, reject) => {
        const handle = timers.setImmediate(() => {
          preparation.wake = null;
          try {
            deadline = performance.now() + 4;
            resolve(current());
          } catch (error) {
            reject(error);
          }
        });
        preparation.wake = () => {
          timers.clearImmediate(handle);
          preparation.wake = null;
          resolve(false);
        };
        if (!owned()) preparation.wake();
      });
    const work = { current, yieldIfNeeded: () => (performance.now() >= deadline ? pause() : null) };
    try {
      signal?.addEventListener("abort", preparation.cancel, { once: true });
      // Defer even the first validation slice. The caller receives ownership
      // before any report-sized traversal or normalizer module initialization.
      if (!(await pause())) return false;
      const positionCache = new WeakMap();
      if (!(await require("./validate").messagesAsync(linterName, messages, positionCache, work)))
        return false;
      const normalize = getHelpers().createMessageNormalizer(linterName, {
        markerInvalidation,
        positionCache,
      });
      for (let index = 0, { length } = messages; index < length; index++) {
        if (!current()) return false;
        normalize(messages[index]);
        const yielding = work.yieldIfNeeded();
        if (yielding && !(await yielding)) return false;
      }
      // Keep sync semantics: normalize the complete report before checking
      // whether every diagnostic belongs to this per-file bucket.
      for (let index = 0; index < messages.length; index++) {
        if (!current()) return false;
        const message = messages[index];
        if (message.location.normalizedFile !== key) {
          console.debug("[Linter-UI-Default] Expected File", filePath, "Message", message);
          throw new Error("message.location.file does not match the given filePath");
        }
        const yielding = work.yieldIfNeeded();
        if (yielding && !(await yielding)) return false;
      }
      if (!current()) return false;
      this.pendingPreparations.delete(key);
      this.messages.set(key, messages);
      this.emitter.emit("did-update", fileSnapshot(this.getMessages(), key));
      return true;
    } finally {
      signal?.removeEventListener("abort", preparation.cancel);
      if (this.pendingPreparations.get(key) === preparation) this.pendingPreparations.delete(key);
    }
  }

  setAllMessages(messages, options) {
    if (this.subscriptions.disposed) {
      return;
    }
    this.cancelPreparations();
    if (!isProxy(messages) && Array.isArray(messages) && messages.length === 0) {
      this.messages.clear();
      this.emitter.emit("did-update", { messages: [], options });
      return;
    }
    let positionCache;
    if (!Array.isArray(messages) || lumine.window.isDevMode()) {
      positionCache = new WeakMap();
      if (!require("./validate").messages(this.name, messages, positionCache)) {
        return;
      }
    }
    getHelpers().normalizeMessages(this.name, messages, {
      markerInvalidation: this.markerInvalidation,
      positionCache,
    });
    this.messages.clear();
    for (let i = 0, { length } = messages; i < length; ++i) {
      const message = messages[i];
      const filePath = message.location.normalizedFile;
      let fileMessages = this.messages.get(filePath);
      if (!fileMessages) {
        this.messages.set(filePath, (fileMessages = []));
      }
      fileMessages.push(message);
    }
    this.emitter.emit("did-update", { messages: this.getMessages(), options });
  }

  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  dispose() {
    this.disposing = true;
    this.cancelPreparations();
    this.emitter.emit("did-destroy");
    this.subscriptions.dispose();
    this.messages.clear();
  }
}

module.exports = IndieDelegate;
