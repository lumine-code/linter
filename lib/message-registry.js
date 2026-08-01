const { CompositeDisposable, Emitter } = require("atom");
const { flagMessages, mergeArray } = require("./helpers");

class MessageRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.messages = [];
    // Use Map with composite key for O(1) lookup instead of Set with O(n) search
    this.messagesMap = new Map();
    this.subscriptions = new CompositeDisposable();
    // Update state tracking using a simple state machine
    // States: 'idle' | 'processing' | 'pending'
    this.updateState = "idle";
    this.subscriptions.add(this.emitter);
  }

  // Generate a unique key for buffer+linter combination
  _getKey(buffer, linter) {
    const bufferId = buffer ? buffer.id || buffer.getId?.() || String(buffer) : "null";
    const linterName = linter.name || String(linter);
    return `${bufferId}::${linterName}`;
  }

  set({ messages, linter, buffer }) {
    const key = this._getKey(buffer, linter);
    const existing = this.messagesMap.get(key);
    if (existing) {
      existing.messages = messages;
      existing.changed = true;
    } else {
      this.messagesMap.set(key, {
        messages,
        linter,
        buffer,
        oldMessages: [],
        changed: true,
        deleted: false,
      });
    }
    this.update();
  }

  update() {
    // An update listener may synchronously publish another snapshot. Mark that
    // work pending and let the outer call drain it without growing the stack.
    if (this.updateState !== "idle") {
      this.updateState = "pending";
      return;
    }

    let rerun;
    do {
      this.updateState = "processing";
      try {
        const result = {
          added: [],
          removed: [],
          messages: [],
        };
        const keysToDelete = [];
        for (const [key, entry] of this.messagesMap) {
          if (entry.deleted) {
            mergeArray(result.removed, entry.oldMessages);
            keysToDelete.push(key);
            continue;
          }
          if (!entry.changed) {
            mergeArray(result.messages, entry.oldMessages);
            continue;
          }
          entry.changed = false;
          const flaggedMessages = flagMessages(entry.messages, entry.oldMessages);
          if (flaggedMessages !== null) {
            const { oldKept, oldRemoved, newAdded } = flaggedMessages;
            mergeArray(result.added, newAdded);
            mergeArray(result.removed, oldRemoved);
            const allThisEntry = newAdded.concat(oldKept);
            mergeArray(result.messages, allThisEntry);
            entry.oldMessages = allThisEntry;
          }
        }
        // Delete after iteration to avoid modifying during iteration
        for (const key of keysToDelete) {
          this.messagesMap.delete(key);
        }
        if (result.added.length || result.removed.length) {
          this.messages = result.messages;
          this.emitter.emit("did-update-messages", result);
        }
      } finally {
        rerun = this.updateState === "pending";
        this.updateState = "idle";
      }
    } while (rerun);
  }

  onDidUpdateMessages(callback) {
    return this.emitter.on("did-update-messages", callback);
  }

  deleteByBuffer(buffer) {
    for (const entry of this.messagesMap.values()) {
      if (entry.buffer === buffer) {
        entry.deleted = true;
      }
    }
    this.update();
  }

  deleteAll() {
    for (const entry of this.messagesMap.values()) {
      entry.deleted = true;
    }
    this.update();
  }

  deleteMessage(message) {
    for (const entry of this.messagesMap.values()) {
      if (entry.deleted) continue;
      const idx = entry.oldMessages.indexOf(message);
      if (idx !== -1) {
        entry.oldMessages.splice(idx, 1);
        this.messages = this.messages.filter((m) => m !== message);
        this.emitter.emit("did-update-messages", {
          added: [],
          removed: [message],
          messages: this.messages,
        });
        return true;
      }
    }
    return false;
  }

  deleteByLinter(linter) {
    for (const entry of this.messagesMap.values()) {
      if (entry.linter === linter) {
        entry.deleted = true;
      }
    }
    this.update();
  }

  dispose() {
    this.subscriptions.dispose();
  }
}

module.exports = MessageRegistry;
