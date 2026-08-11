const { CompositeDisposable, Disposable } = require("lumine");
const Linter = require("./linter-main");
const LinterUI = require("./linter-ui");
const Validate = require("./validate");
const Severities = require("./severities");
const { createIntentionsProvider } = require("./intentions-provider");
const { createHoverProvider } = require("./hover-provider");
const {
  getDescription,
  hasLazyDescription,
  resolveDescription,
  normalizePath,
} = require("./helpers");

let instance;
let ui;
let subscriptions;
let uiProviders;
let hub;

/**
 * The handle every `linter.ui` provider is given.
 *
 * A UI is handed each message change, but a message change cannot answer which
 * of them belong to the item on screen, where one is, or what the severity
 * tiers are — all of which the hub knows and none of which a UI can work out
 * for itself. One frozen instance, built once: two UIs comparing members must
 * see the same functions.
 * @returns {Object}
 */
function buildHub() {
  return Object.freeze({
    // The whole current set. A UI registering into a window that has been
    // linting for a while starts from here rather than waiting for a change.
    getMessages: () => instance?.registryMessages?.messages || [],
    // Which of them belong to the active pane item, adapters included.
    getCurrentMessages: () => ui.getCurrentMessages(),
    // The editor whose cursor marks a current position, or null when the active
    // item is not one — a notebook an adapter owns has its own idea of one.
    getCursorEditor: () => ui.editor,
    // The severity model, in precedence order. Open-ended by design, so a UI
    // reads it rather than hardcoding four tiers.
    getSeverities: () => Severities.SEVERITIES,
    revealMessage: (message) => ui.revealMessage(message),
    deleteMessages: (messages) => instance.deleteMessages(messages),
    isLintingDisabled: (editor) => ui.isLintingDisabledForEditor(editor),
    // A long form is either the text itself or a function producing it. The memo
    // that keeps a lazy one from running once per render lives here, because the
    // same message objects go to every UI.
    getDescription,
    hasLazyDescription,
    resolveDescription,
  });
}

/**
 * Activates the linter package.
 */
function activate() {
  subscriptions = new CompositeDisposable();
  uiProviders = new Set();

  instance = new Linter();
  ui = new LinterUI();
  hub = buildHub();

  // Every member of a UI is optional except its name, so each of these asks
  // before it calls. A UI that only draws markers implements none of them.
  const notify = (member, ...args) => {
    for (const provider of uiProviders) {
      provider[member]?.(...args);
    }
  };

  instance.setUIRenderCallback((difference) => {
    ui.render(difference);
    notify("render", difference);
  });
  // Per-run progress, for a UI that shows a spinner. The markers show none, so
  // these only ever reach the providers.
  instance.setUIBeginLintingCallback((event) => notify("didBeginLinting", event));
  instance.setUIFinishLintingCallback((event) => notify("didFinishLinting", event));
  // An indie provider can ask for the project's messages to be brought up, and
  // toggling linting for a file changes nothing about the message set — so
  // neither reaches a UI on the render path.
  instance.setUIProjectViewCallback(() => notify("showProjectView"));
  instance.setUILintingStateCallback(() => notify("didChangeLintingState"));
  ui.setLintingStateProvider((editor) => instance.isTextEditorLintingDisabled(editor));
  ui.onDeleteMessages = (messages) => instance.deleteMessages(messages);

  // Register commands
  subscriptions.add(
    instance,
    ui,
    lumine.commands.add("lumine-workspace", {
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
 * Provides registration for an editor that is not a pane item. Only the
 * documents open in the workspace are linted on their own; a package whose own
 * editor is a document too — a commit box, a notebook's source editor —
 * registers it here and it is linted and decorated like any other.
 * @returns {Function} (editor) => Disposable
 */
function provideLinterEditors() {
  return (editor) => {
    if (!lumine.workspace.isTextEditor(editor) || editor.isDestroyed()) {
      return new Disposable(() => {});
    }
    instance.registryEditorsInit();
    instance.registryEditors.createFromTextEditor(editor);
    ui.patchEditor(editor);
    return new Disposable(() => {
      instance?.registryEditors?.get(editor)?.dispose();
    });
  };
}

/**
 * Consumes a place to display diagnostics — the panel, a scrollbar overview, a
 * gutter of someone else's. Each is handed the message changes and, if it asks
 * for one, a handle onto the hub.
 * @param {Object} provider - A `linter.ui` provider
 * @returns {Disposable}
 */
function consumeLinterUI(provider) {
  // A no-op disposable rather than nothing: the service hub is handed whatever
  // comes back, and a rejected UI must still be safe to unregister.
  if (!Validate.ui(provider)) {
    return new Disposable(() => {});
  }
  provider.attach?.(hub);
  uiProviders.add(provider);
  return new Disposable(() => {
    provider.dispose?.();
    uiProviders.delete(provider);
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
 * Provides the messages shown when the pointer rests on an issue or its
 * gutter dot, rendered by the hover package.
 * @returns {Object} Provider for the hover.provider service
 */
function provideHover() {
  return createHoverProvider();
}

/**
 * Provides quick-fix intentions built from linter message solutions.
 * @returns {Object} Provider for the intentions.list service
 */
function provideIntentionsList() {
  return createIntentionsProvider(() => instance?.registryMessages?.messages || []);
}

/**
 * Provides MCP tools exposing linter diagnostics to MCP clients.
 * @returns {Array} Array of tool definitions
 */
function provideMcpTools() {
  return [
    {
      name: "GetLinterMessages",
      description:
        "Get linter diagnostics (errors, warnings, info, hints). Returns {mode, path, messages} where messages is an array with severity, tags, excerpt, description, range, linterName, file, and url. The description is the provider's long form, such as a language server's rule code, and is null when it has none. With no arguments it returns the messages of the active editor (mode 'file'); pass scope 'project' for every message the project holds. Any of the optional filters (filePath, severity, linterName) scopes from across the whole project whatever the scope says (mode 'filter'), so a file that was never opened in a tab can still be asked about. Always returns a valid result object even when no editor is open.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["file", "project"],
            description:
              "Whether to return the active editor's messages or every message in the project. Defaults to 'file'. Ignored when a filter is given.",
          },
          filePath: {
            type: "string",
            description:
              "Absolute path of the file to return messages for. Works even when the file is not open in a tab. Matching mirrors the filesystem: on Windows it is case-insensitive and treats '/' and '\\' as equal; on POSIX it is exact.",
          },
          severity: {
            type: "string",
            enum: Severities.NAMES,
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
        const { scope, filePath, severity, linterName } = args || {};
        const allMessages = instance?.registryMessages?.messages || [];

        // When any filter is supplied, scope from the full registry whatever is
        // on screen, so callers can target a file, severity, or linter directly
        // (even a file that was never opened in a tab).
        if (filePath != null || severity != null || linterName != null) {
          const wantPath = filePath != null ? normalizePath(filePath) : null;
          const messages = allMessages
            .filter((msg) => {
              if (wantPath != null && msg.location?.normalizedFile !== wantPath) {
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

        const activeItem = lumine.workspace.getCenter().getActivePaneItem();
        const activePath = activeItem?.getPath?.() || null;
        if (scope === "project") {
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
 * Format a linter message for MCP output.
 * @param {Object} msg - Linter message
 * @returns {Object} Formatted message
 */
function formatMessage(msg) {
  const position = msg.location?.position;
  return {
    severity: msg.severity,
    tags: msg.tags || null,
    excerpt: msg.excerpt,
    // The long form carries a rule code for language-server messages, which is
    // worth as much to a reader here as it is in the panel. Only the string
    // form is reported: running a provider's lazy description per message would
    // turn a read into arbitrary work.
    description: getDescription(msg),
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
  provideLinterEditors,
  provideIntentionsList,
  provideMcpTools,
  provideHover,
};
