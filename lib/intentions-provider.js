const { Range } = require("lumine");
const { normalizePath } = require("./helpers");

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
      // A buffer that has never been saved has no path to match on, so its
      // messages name the buffer instead.
      const filePath = normalizePath(textEditor.getPath());
      const buffer = filePath === null ? textEditor.getBuffer() : null;
      const intentions = [];
      for (const message of getMessages()) {
        if (buffer) {
          if (message.location?.buffer !== buffer) {
            continue;
          }
        } else if (normalizePath(message.location?.file) !== filePath) {
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
