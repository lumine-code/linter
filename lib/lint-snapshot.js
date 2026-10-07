const path = require("node:path");
const { Readable } = require("node:stream");
const { Disposable, TextBuffer } = require("lumine");

function readOnlyError(operation) {
  const error = new Error(`Cannot ${operation} a private lint snapshot`);
  error.code = "LINTER_SNAPSHOT_READ_ONLY";
  return error;
}

// A snapshot has a source identity, but its contents belong to this request.
// A custom source with its own no-op notification hook does not subscribe to
// the native file watcher. Neither reading nor writing reaches the disk.
class SnapshotBuffer extends TextBuffer {
  constructor({ text, filePath, encoding }) {
    super({ text, encoding });
    const source = Object.freeze({
      getPath: () => filePath,
      getBaseName: () => path.basename(filePath),
      getEncoding: () => "utf8",
      existsSync: () => true,
      createReadStream: () => Readable.from([text]),
      createWriteStream: () => {
        throw readOnlyError("save");
      },
      onDidChange: () => new Disposable(),
    });
    try {
      super.setFile(source);
      this.snapshotSource = source;
      this.snapshotSourceInitialized = true;
    } catch (error) {
      super.destroy();
      throw error;
    }
  }

  setPath(filePath) {
    if (this.snapshotSourceInitialized) {
      if (filePath === this.getPath()) return;
      throw readOnlyError("retarget");
    }
    return super.setPath(filePath);
  }

  setEncoding(encoding) {
    // Factory configuration can arrive after grammar settlement. This is a
    // captured request, so those defaults cannot replace its encoding or
    // trigger a reload of the private source.
    if (this.snapshotSourceInitialized) return;
    return super.setEncoding(encoding);
  }

  setFile(file) {
    if (this.snapshotSourceInitialized) {
      if (file === this.snapshotSource) return;
      throw readOnlyError("replace the source of");
    }
    return super.setFile(file);
  }

  save() {
    return Promise.reject(readOnlyError("save"));
  }

  saveAs() {
    return Promise.reject(readOnlyError("save"));
  }

  saveTo() {
    return Promise.reject(readOnlyError("save"));
  }

  load() {
    return Promise.reject(readOnlyError("reload"));
  }

  loadSync() {
    throw readOnlyError("reload");
  }

  reload() {
    return Promise.reject(readOnlyError("reload"));
  }
}

function selectSnapshotGrammar(grammar, filePath, text) {
  const scopeName = grammar?.scopeName;
  if (
    scopeName &&
    scopeName !== "text.plain.null-grammar" &&
    lumine.grammars.grammarForScopeName(scopeName) === grammar
  ) {
    return grammar;
  }
  return lumine.grammars.selectGrammar(filePath, text);
}

function createLintSnapshot({ text, filePath, grammar, encoding }) {
  const buffer = new SnapshotBuffer({ text, filePath, encoding });
  let editor;
  try {
    editor = lumine.workspace.buildTextEditor({ buffer });
    const selectedGrammar = selectSnapshotGrammar(grammar, filePath, text);
    if (!lumine.grammars.assignGrammar(buffer, selectedGrammar)) {
      throw new Error("Could not assign the lint snapshot grammar");
    }
    return editor;
  } catch (error) {
    if (editor && !editor.isDestroyed()) editor.destroy();
    if (!buffer.isDestroyed()) buffer.destroy();
    throw error;
  }
}

// Project results outlive the editor that supplied the input. A named buffer
// becomes a durable file location; an anonymous buffer remains tied to its
// own lifetime. Return copies only where ownership actually changes.
function mapProjectLocations(messages, { snapshotBuffer, originalBuffer } = {}) {
  const result = [];
  for (const message of messages) {
    const location = message.location;
    const reportedBuffer = location.buffer;
    const buffer = reportedBuffer === snapshotBuffer ? originalBuffer : reportedBuffer;
    if (!buffer) {
      result.push(message);
      continue;
    }
    const file = typeof location.file === "string" ? location.file : buffer.getPath?.();
    if (typeof file === "string") {
      const ownedLocation = { ...location, file };
      delete ownedLocation.buffer;
      result.push({ ...message, location: ownedLocation });
    } else if (!buffer.isDestroyed?.()) {
      result.push(
        buffer === reportedBuffer ? message : { ...message, location: { ...location, buffer } },
      );
    }
  }
  return result;
}

module.exports = { createLintSnapshot, mapProjectLocations };
