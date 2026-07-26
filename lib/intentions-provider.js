const { Range } = require("atom");

/**
 * Normalize a file path for comparison, mirroring filesystem semantics per
 * platform, matching the convention used in helpers.isPathIgnored.
 * @param {string} filePath
 * @returns {string|null}
 */
function normalizePath(filePath) {
  if (typeof filePath !== "string") {
    return null;
  }
  if (process.platform === "win32") {
    return filePath.replace(/\\/g, "/").toLowerCase();
  }
  return filePath;
}

/**
 * Applies a single v2 message solution. Callback solutions run their apply();
 * replace solutions verify currentText (when given) still matches the buffer
 * text at the position and are skipped silently otherwise.
 * @param {Object} textEditor
 * @param {Object} solution
 */
async function applySolution(textEditor, solution) {
  if (typeof solution.apply === "function") {
    await solution.apply();
    return;
  }
  if (typeof solution.replaceWith !== "string") {
    return;
  }
  const position = Range.fromObject(solution.position);
  if (
    solution.currentText != null &&
    textEditor.getTextInBufferRange(position) !== solution.currentText
  ) {
    return;
  }
  textEditor.setTextInBufferRange(position, solution.replaceWith);
}

/**
 * Creates the intentions.list provider that exposes linter message solutions
 * as quick-fix actions at the cursor.
 * @param {Function} getMessages - Returns the current registry messages
 * @returns {Object} Provider for the intentions.list service
 */
function createIntentionsProvider(getMessages) {
  return {
    grammarScopes: ["*"],
    async getIntentions({ textEditor, bufferPosition }) {
      const filePath = normalizePath(textEditor.getPath());
      if (filePath === null) {
        return [];
      }
      const intentions = [];
      for (const message of getMessages()) {
        if (normalizePath(message.location?.file) !== filePath) {
          continue;
        }
        if (!Range.fromObject(message.location.position).containsPoint(bufferPosition)) {
          continue;
        }
        let solutions = message.solutions;
        if (solutions instanceof Promise) {
          try {
            solutions = await solutions;
          } catch {
            continue;
          }
        }
        if (!Array.isArray(solutions)) {
          continue;
        }
        for (const solution of solutions) {
          intentions.push({
            icon: "tools",
            title: solution.title || `Fix: ${message.excerpt}`,
            priority: 50,
            selected: () => applySolution(textEditor, solution),
          });
        }
      }
      return intentions;
    },
  };
}

module.exports = { createIntentionsProvider, applySolution };
