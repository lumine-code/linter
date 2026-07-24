const { CompositeDisposable, Emitter } = require("atom");
const { debounce } = require("./util");
const { flagMessages, mergeArray } = require("./helpers");

// Debounce interval for message updates (ms)
const MESSAGE_UPDATE_DEBOUNCE_MS = 100;

class MessageRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.messages = [];
    // Use Map with composite key for O(1) lookup instead of Set with O(n) search
    this.messagesMap = new Map();
    this.subscriptions = new CompositeDisposable();
    // Use trailing-only debounce to prevent race conditions
    this.debouncedUpdate = debounce(this.update.bind(this), MESSAGE_UPDATE_DEBOUNCE_MS, {
      leading: false,
      trailing: true,
    });
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
    this.debouncedUpdate();
  }

  update() {
    // State machine for update concurrency control
    switch (this.updateState) {
      case "processing":
        this.updateState = "pending";
        return;
      case "pending":
        return;
      case "idle":
      default:
        this.updateState = "processing";
        break;
    }

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
      const wasPending = this.updateState === "pending";
      this.updateState = "idle";
      if (wasPending) {
        this.debouncedUpdate();
      }
    }
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
    this.debouncedUpdate();
  }

  deleteAll() {
    for (const entry of this.messagesMap.values()) {
      entry.deleted = true;
    }
    this.debouncedUpdate();
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
    this.debouncedUpdate();
  }

  dispose() {
    if (this.debouncedUpdate.cancel) {
      this.debouncedUpdate.cancel();
    }
    this.subscriptions.dispose();
  }
}

module.exports = MessageRegistry;
