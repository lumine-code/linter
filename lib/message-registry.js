const { CompositeDisposable, Emitter } = require("lumine");
const preparations = new WeakMap();
let messageHelpers;
const getHelpers = () => (messageHelpers ||= require("./helpers"));

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
    this.generation = 0;
    this.subscriptions.add(this.emitter);
  }

  // Generate a unique key for buffer+linter combination
  _getKey(buffer, linter, allocate = true) {
    const bufferId = buffer ? buffer.id || buffer.getId?.() || String(buffer) : "null";
    let providerId = this.providerIds.get(linter);
    if (providerId === undefined) {
      if (!allocate) return undefined;
      providerId = ++this.nextProviderId;
      this.providerIds.set(linter, providerId);
    }
    return `${bufferId}::${providerId}`;
  }

  async prepare({ messages, linter, buffer, affectedFiles }, work) {
    const generation = this.generation;
    const current = () =>
      !this.subscriptions.disposed &&
      this.updateState === "idle" &&
      this.generation === generation &&
      work.current() &&
      this.generation === generation &&
      !this.subscriptions.disposed &&
      this.updateState === "idle";
    if (!current()) return null;
    // Lookup must not allocate provider IDs or otherwise change registry state.
    const existing = this.messagesMap.get(this._getKey(buffer, linter, false));
    if (!current()) return null;
    if (existing?.changed || existing?.deleted) return null;
    const iterator = getHelpers().prepareFlagMessages(messages, existing?.oldMessages || []);
    let step;
    let units = 0;
    do {
      step = iterator.next();
      // The caller's ownership check can include editor and server state. Do
      // not repeat that full guard for every field in a large report.
      if (++units === 32 || step.done) {
        units = 0;
        if (!current()) return null;
        const yielding = work.yieldIfNeeded();
        if (yielding) {
          if ((await yielding) === false) return null;
          if (!current()) return null;
        }
      }
    } while (!step.done);
    if (step.value === null) return null;
    const token = Object.freeze({});
    preparations.set(token, {
      registry: this,
      generation,
      messages,
      linter,
      buffer,
      affectedFiles,
      diff: step.value,
    });
    return token;
  }

  set({ messages, linter, buffer, affectedFiles, preparation }) {
    const prepared = preparation && preparations.get(preparation);
    const diff =
      prepared?.registry === this &&
      prepared.generation === this.generation &&
      prepared.messages === messages &&
      prepared.linter === linter &&
      prepared.buffer === buffer &&
      prepared.affectedFiles === affectedFiles &&
      this.updateState === "idle"
        ? prepared.diff
        : null;
    if (preparation) preparations.delete(preparation);
    this.generation++;
    if (this.subscriptions.disposed) return;
    const key = this._getKey(buffer, linter);
    const existing = this.messagesMap.get(key);
    if (messages.length === 0) {
      if (existing) {
        existing.deleted = true;
        this.update();
      }
      return;
    }
    if (existing) {
      const wasPending = existing.changed;
      existing.messages = messages;
      existing.preparedDiff = diff;
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
        preparedDiff: diff,
        changed: true,
        deleted: false,
        affectedFiles,
      });
    }
    this.update();
  }

  update() {
    this.generation++;
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
            getHelpers().mergeArray(result.removed, entry.oldMessages);
            keysToDelete.push(key);
            continue;
          }
          if (!entry.changed) {
            getHelpers().mergeArray(result.messages, entry.oldMessages);
            continue;
          }
          entry.changed = false;
          for (const file of entry.affectedFiles || []) affectedFiles.add(file);
          entry.affectedFiles = undefined;
          // Equivalent snapshots retain their canonical array and key index.
          // Check stored keys too: a provider mutating an existing object's key
          // must not make a cached lookup silently match the wrong snapshot.
          let flaggedMessages = entry.preparedDiff;
          entry.preparedDiff = null;
          if (!flaggedMessages) {
            if (!getHelpers().messageKeyIndexMatches(entry.keyIndex, entry.oldMessages)) {
              entry.keyIndex = getHelpers().createMessageKeyIndex(entry.oldMessages);
            }
            flaggedMessages = getHelpers().flagMessages(
              entry.messages,
              entry.oldMessages,
              entry.keyIndex,
            );
          }
          if (flaggedMessages !== null) {
            const { oldKept, oldRemoved, newAdded, updated } = flaggedMessages;
            getHelpers().mergeArray(result.added, newAdded);
            getHelpers().mergeArray(result.removed, oldRemoved);
            getHelpers().mergeArray(result.updated, updated);
            const allThisEntry =
              newAdded.length || oldRemoved.length || updated.length
                ? newAdded.concat(oldKept)
                : entry.oldMessages;
            getHelpers().mergeArray(result.messages, allThisEntry);
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

  getDiagnosticBuffers() {
    const buffers = new Set();
    for (const entry of this.messagesMap.values()) {
      if (entry.deleted || !entry.oldMessages.length) continue;
      if (entry.buffer) buffers.add(entry.buffer);
      else
        for (const message of entry.oldMessages) {
          if (message.location.buffer) buffers.add(message.location.buffer);
        }
    }
    return buffers;
  }

  deleteByBuffer(buffer) {
    this.generation++;
    for (const entry of this.messagesMap.values()) {
      if (entry.buffer === buffer) {
        entry.deleted = true;
      } else if (entry.buffer === null) {
        const remaining = entry.messages.filter((message) => message.location.buffer !== buffer);
        if (remaining.length !== entry.messages.length) {
          entry.messages = remaining;
          entry.changed = true;
          if (!remaining.length) entry.deleted = true;
        }
      }
    }
    this.update();
  }

  deleteAll() {
    this.generation++;
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
    this.generation++;
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
    this.generation++;
    for (const entry of this.messagesMap.values()) {
      if (entry.linter === linter) {
        entry.deleted = true;
      }
    }
    this.update();
  }

  dispose() {
    this.generation++;
    this.pendingEvents.length = 0;
    this.subscriptions.dispose();
    this.messages = [];
    this.messagesMap.clear();
    this.providerIds = new WeakMap();
  }
}

module.exports = MessageRegistry;
