const { Emitter, CompositeDisposable } = require("atom");
const Validate = require("./validate");
const {
  normalizeMessages,
  mergeArray,
  normalizePath,
  DEFAULT_MARKER_INVALIDATION,
} = require("./helpers");

class IndieDelegate {
  constructor(indie, version) {
    this.scope = "project";
    this.emitter = new Emitter();
    this.messages = new Map();
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
      mergeArray(out, m);
    });
    return out;
  }

  clearMessages() {
    if (!this.subscriptions.disposed) {
      this.emitter.emit("did-update", []);
      this.messages.clear();
    }
  }

  // Keyed by `normalizePath`, because the caller replacing or deleting a file's
  // messages is rarely the one that set them: an editor closing deletes by
  // `editor.getPath()`, while a language server set them under whatever it
  // spelled the same file as. Keyed raw, that delete misses and the messages
  // outlive the editor.
  deleteFilePath(filePath) {
    const key = normalizePath(filePath);
    if (!this.subscriptions.disposed && this.messages.has(key)) {
      this.messages.delete(key);
      this.emitter.emit("did-update", this.getMessages());
    }
  }

  setMessages(filePath, messages = null) {
    if (typeof filePath !== "string" || !Array.isArray(messages)) {
      throw new Error("Invalid Parameters to setMessages()");
    }
    if (this.subscriptions.disposed || !Validate.messages(this.name, messages)) {
      return;
    }
    const key = normalizePath(filePath);
    messages.forEach(function (message) {
      // Compared the same way: a message spelling the same file differently is
      // not a mismatched message.
      if (normalizePath(message.location.file) !== key) {
        console.debug("[Linter-UI-Default] Expected File", filePath, "Message", message);
        throw new Error("message.location.file does not match the given filePath");
      }
    });
    normalizeMessages(this.name, messages, { markerInvalidation: this.markerInvalidation });
    this.messages.set(key, messages);
    this.emitter.emit("did-update", this.getMessages());
  }

  setAllMessages(messages, options) {
    if (this.subscriptions.disposed) {
      return;
    }
    if (!Array.isArray(messages) || atom.window.isDevMode()) {
      if (!Validate.messages(this.name, messages)) {
        return;
      }
    }
    normalizeMessages(this.name, messages, { markerInvalidation: this.markerInvalidation });
    this.messages.clear();
    for (let i = 0, { length } = messages; i < length; ++i) {
      const message = messages[i];
      const filePath = normalizePath(message.location.file);
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
    this.emitter.emit("did-destroy");
    this.subscriptions.dispose();
    this.messages.clear();
  }
}

module.exports = IndieDelegate;
