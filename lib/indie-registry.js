const { Emitter, CompositeDisposable } = require("lumine");
const IndieDelegate = require("./indie-delegate");
const Validate = require("./validate");

class IndieRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.delegates = new Set();
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(this.emitter);
  }

  register(config, version) {
    if (!Validate.indie(config)) {
      throw new Error("Error registering Indie Linter");
    }
    const indieLinter = new IndieDelegate(config, version);
    this.delegates.add(indieLinter);
    indieLinter.onDidDestroy(() => {
      this.delegates.delete(indieLinter);
    });
    indieLinter.onDidUpdate((payload) => {
      const messages = Array.isArray(payload) ? payload : payload.messages;
      const options = Array.isArray(payload) ? undefined : payload.options;
      this.emitter.emit("did-update", { linter: indieLinter, messages, options });
    });
    this.emitter.emit("observe", indieLinter);
    return indieLinter;
  }

  getProviders() {
    return Array.from(this.delegates);
  }

  observe(callback) {
    this.delegates.forEach(callback);
    return this.emitter.on("observe", callback);
  }

  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }

  dispose() {
    for (const entry of this.delegates) {
      entry.dispose();
    }
    this.subscriptions.dispose();
  }
}

module.exports = IndieRegistry;
