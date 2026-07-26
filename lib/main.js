const { CompositeDisposable, Disposable } = require("atom");
const Linter = require("./linter-main");
const LinterUI = require("./linter-ui");
const Validate = require("./validate");
const { createIntentionsProvider } = require("./intentions-provider");

let instance;
let ui;
let subscriptions;
let externalUIProviders;

/**
 * Activates the linter package.
 */
function activate() {
  subscriptions = new CompositeDisposable();
  externalUIProviders = new Set();

  // Initialize core linter and UI
  instance = new Linter();
  ui = new LinterUI();

  // Wire core to UI
  instance.setUIRenderCallback((difference) => {
    ui.render(difference);
    for (const provider of externalUIProviders) {
      if (provider.render) {
        provider.render(difference);
      }
    }
  });
  instance.setUIProjectViewCallback(() => {
    ui.panel.setViewMode("project");
  });
  instance.setUILintingStateCallback(() => {
    ui.updateCurrent();
  });
  ui.setLintingStateProvider((editor) => instance.isTextEditorLintingDisabled(editor));
  ui.onDeleteMessage = (message) => instance.deleteMessage(message);

  // Register commands
  subscriptions.add(
    instance,
    ui,
    atom.commands.add("atom-workspace", {
      "linter:toggle-panel": () => ui.togglePanel(),
      "linter:toggle-focus": () => ui.panel.toggleFocus(),
      "linter:file-mode": () => ui.panel.setViewMode("file"),
      "linter:project-mode": () => ui.panel.setViewMode("project"),
      "linter:clear": () => instance.clearAll(),
      "linter:inspect": () => ui.inspect(),
      "linter:next": () => ui.inspectNext(),
      "linter:previous": () => ui.inspectPrevious(),
    }),
  );
}

/**
 * Deactivates the linter package.
 */
function deactivate() {
  subscriptions?.dispose();
}

/**
 * Consumes linter providers from external packages.
 * @param {Object|Array} linter - Linter provider(s) to consume
 * @returns {Disposable}
 */
function consumeLinter(linter) {
  const linters = Array.isArray(linter) ? linter : [linter];
  for (const entry of linters) {
    instance.addLinter(entry);
  }
  return new Disposable(() => {
    for (const entry of linters) {
      instance.deleteLinter(entry);
    }
  });
}

/**
 * Provides the indie linter service.
 * @returns {Function}
 */
function provideLinterRegistry() {
  return (indie) => instance.addIndie(indie);
}

/**
 * Consumes the status bar service.
 * @param {Object} statusBar
 */
function consumeStatusBar(statusBar) {
  ui.consumeStatusBar(statusBar);
}

/**
 * Consumes linter-ui providers from external packages.
 * @param {Object} provider - UI provider with render method
 * @returns {Disposable}
 */
function consumeLinterUI(provider) {
  if (!Validate.ui(provider)) {
    return;
  }
  externalUIProviders.add(provider);
  return new Disposable(() => {
    if (provider.dispose) {
      provider.dispose();
    }
    externalUIProviders.delete(provider);
  });
}

function consumeLinterAdapter(adapter) {
  instance.addItemAdapter(adapter);
  ui.addItemAdapter(adapter);
  return new Disposable(() => {
    instance.removeItemAdapter(adapter);
    ui.removeItemAdapter(adapter);
  });
}

/**
 * Provides quick-fix intentions built from linter message solutions.
 * @returns {Object} Provider for the intentions.list service
 */
function provideIntentionsList() {
  return createIntentionsProvider(() => instance?.registryMessages?.messages || []);
}

/**
 * Provides MCP tools for claude-chat integration.
 * @returns {Array} Array of tool definitions
 */
function provideMcpTools() {
  return [
    {
      name: "GetLinterMessages",
      description:
        "Get linter diagnostics (errors, warnings, info). Returns {mode, path, messages} where messages is an array with severity, excerpt, range, linterName, file, and url. When any of the optional filters (filePath, severity, linterName) is provided, returns messages scoped to those filters from across the whole project, independent of UI focus or panel view mode (mode 'filter'). With no filters it follows the linter panel view mode: 'file' returns messages for the active editor, 'project' returns all messages across all files. Always returns a valid result object even when no editor is open.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Absolute path of the file to return messages for. Works even when the file is not open in a tab. Matching mirrors the filesystem: on Windows it is case-insensitive and treats '/' and '\\' as equal; on POSIX it is exact.",
          },
          severity: {
            type: "string",
            enum: ["error", "warning", "info"],
            description: "Only return messages with this severity.",
          },
          linterName: {
            type: "string",
            description: "Only return messages produced by this linter provider.",
          },
        },
        required: [],
      },
      annotations: { readOnlyHint: true },
      execute(args = {}) {
        const { filePath, severity, linterName } = args || {};
        const allMessages = instance?.registryMessages?.messages || [];

        // When any filter is supplied, scope from the full registry regardless
        // of UI focus / view mode, so callers can target a file, severity, or
        // linter directly (even for files that were never opened in a tab).
        if (filePath != null || severity != null || linterName != null) {
          const wantPath = filePath != null ? normalizePath(filePath) : null;
          const messages = allMessages
            .filter((msg) => {
              if (wantPath != null && normalizePath(msg.location?.file) !== wantPath) {
                return false;
              }
              if (severity != null && msg.severity !== severity) {
                return false;
              }
              if (linterName != null && msg.linterName !== linterName) {
                return false;
              }
              return true;
            })
            .map(formatMessage);
          return { mode: "filter", path: filePath || null, messages };
        }

        const viewMode = ui?.panel?.viewMode || "file";
        const activeItem = atom.workspace.getCenter().getActivePaneItem();
        const activePath = activeItem?.getPath?.() || null;
        if (viewMode === "project") {
          return {
            mode: "project",
            path: activePath,
            messages: allMessages.map(formatMessage),
          };
        }
        if (!activePath) {
          return { mode: "file", path: null, messages: [] };
        }
        const messages = ui.getCurrentMessages().map(formatMessage);
        return { mode: "file", path: activePath, messages };
      },
    },
  ];
}

/**
 * Normalize a file path for comparison, mirroring filesystem semantics per
 * platform. On Windows (case-insensitive, accepts both separators) paths are
 * lower-cased and back-slashes are unified to forward slashes. On POSIX,
 * where paths are case- and separator-sensitive, they are compared verbatim.
 * This matches the convention already used in helpers.isPathIgnored.
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
 * Format a linter message for MCP output.
 * @param {Object} msg - Linter message
 * @returns {Object} Formatted message
 */
function formatMessage(msg) {
  const position = msg.location?.position;
  return {
    severity: msg.severity,
    excerpt: msg.excerpt,
    linterName: msg.linterName,
    file: msg.location?.file || null,
    range: position
      ? {
          start: { row: position.start?.row, column: position.start?.column },
          end: { row: position.end?.row, column: position.end?.column },
        }
      : null,
    url: msg.url || null,
  };
}

module.exports = {
  activate,
  deactivate,
  consumeLinter,
  consumeLinterUI,
  consumeLinterAdapter,
  provideLinterRegistry,
  consumeStatusBar,
  provideIntentionsList,
  provideMcpTools,
};
