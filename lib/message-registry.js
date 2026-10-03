const { CompositeDisposable, Emitter } = require("lumine");
const {
  createMessageKeyIndex,
  messageKeyIndexMatches,
  flagMessages,
  mergeArray,
} = require("./helpers");

class MessageRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.messages = [];
    // Use Map with composite key for O(1) lookup instead of Set with O(n) search
    this.messagesMap = new Map();
    this.providerIds = new WeakMap();
    this.nextProviderId = 0;
    this.subscriptions = new CompositeDisposable();
    // Update state tracking using a simple state machine
    // States: 'idle' | 'processing' | 'pending'
    this.updateState = "idle";
    this.pendingEvents = [];
    this.subscriptions.add(this.emitter);
  }

  // Generate a unique key for buffer+linter combination
  _getKey(buffer, linter) {
    const bufferId = buffer ? buffer.id || buffer.getId?.() || String(buffer) : "null";
    let providerId = this.providerIds.get(linter);
    if (providerId === undefined) {
      providerId = ++this.nextProviderId;
      this.providerIds.set(linter, providerId);
    }
    return `${bufferId}::${providerId}`;
  }

  set({ messages, linter, buffer, affectedFiles }) {
    const key = this._getKey(buffer, linter);
    const existing = this.messagesMap.get(key);
    if (existing) {
      const wasPending = existing.changed;
      existing.messages = messages;
      existing.changed = true;
      existing.deleted = false;
      existing.affectedFiles =
        wasPending && existing.affectedFiles && affectedFiles
          ? [...new Set([...existing.affectedFiles, ...affectedFiles])]
          : wasPending
            ? undefined
            : affectedFiles;
    } else {
      this.messagesMap.set(key, {
        messages,
        linter,
        buffer,
        oldMessages: [],
        changed: true,
        deleted: false,
        affectedFiles,
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
        // A subscriber can synchronously delete messages while another
        // publication is being delivered. Finish that delivery before sending
        // its deletion, so every subscriber sees the same event order.
        while (this.pendingEvents.length) {
          this.emitter.emit("did-update-messages", this.pendingEvents.shift());
        }
        const result = {
          added: [],
          removed: [],
          updated: [],
          messages: [],
        };
        const affectedFiles = new Set();
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
          for (const file of entry.affectedFiles || []) affectedFiles.add(file);
          entry.affectedFiles = undefined;
          // Equivalent snapshots retain their canonical array and key index.
          // Check stored keys too: a provider mutating an existing object's key
          // must not make a cached lookup silently match the wrong snapshot.
          if (!messageKeyIndexMatches(entry.keyIndex, entry.oldMessages)) {
            entry.keyIndex = createMessageKeyIndex(entry.oldMessages);
          }
          const flaggedMessages = flagMessages(entry.messages, entry.oldMessages, entry.keyIndex);
          if (flaggedMessages !== null) {
            const { oldKept, oldRemoved, newAdded, updated } = flaggedMessages;
            mergeArray(result.added, newAdded);
            mergeArray(result.removed, oldRemoved);
            mergeArray(result.updated, updated);
            const allThisEntry =
              newAdded.length || oldRemoved.length || updated.length
                ? newAdded.concat(oldKept)
                : entry.oldMessages;
            mergeArray(result.messages, allThisEntry);
            entry.oldMessages = allThisEntry;
          }
        }
        // Delete after iteration to avoid modifying during iteration
        for (const key of keysToDelete) {
          this.messagesMap.delete(key);
        }
        if (result.added.length || result.removed.length || result.updated.length) {
          if (affectedFiles.size) {
            // A coalesced snapshot or another entry's deletion can touch files
            // beyond the producer's hint. Include the final diff's locations.
            for (const message of [...result.added, ...result.removed, ...result.updated]) {
              const file = message.location?.normalizedFile;
              if (file != null) affectedFiles.add(file);
            }
            result.affectedFiles = [...affectedFiles];
          }
          this.messages = result.messages;
          this.emitter.emit("did-update-messages", result);
        }
      } finally {
        rerun = this.updateState === "pending" || this.pendingEvents.length > 0;
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
    return this.deleteMessages([message]);
  }

  // Removes a set of messages in one pass, emitting once. An edit invalidates
  // every marker it touched and each one asks for its own message to go, so
  // deleting them one at a time would run the whole UI pipeline — which is
  // O(all messages) — once per message.
  deleteMessages(messages) {
    const wanted = new Set(messages);
    if (!wanted.size) {
      return false;
    }
    const removed = [];
    for (const entry of this.messagesMap.values()) {
      if (entry.deleted) continue;
      const kept = [];
      for (const message of entry.oldMessages) {
        if (wanted.has(message)) {
          removed.push(message);
        } else {
          kept.push(message);
        }
      }
      if (kept.length !== entry.oldMessages.length) {
        entry.oldMessages = kept;
      }
    }
    if (!removed.length) {
      return false;
    }
    const removedSet = new Set(removed);
    this.messages = this.messages.filter((message) => !removedSet.has(message));
    this.pendingEvents.push({
      added: [],
      removed,
      updated: [],
      messages: this.messages,
    });
    this.update();
    return true;
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
    this.pendingEvents.length = 0;
    this.subscriptions.dispose();
  }
}

module.exports = MessageRegistry;
