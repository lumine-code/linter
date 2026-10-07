const { CompositeDisposable, Disposable } = require("lumine");
const Linter = require("./linter-main");
const LinterUI = require("./linter-ui");
const Validate = require("./validate");
const Severities = require("./severities");
const { createIntentionsProvider } = require("./intentions-provider");
const { createContextHelpProvider } = require("./context-help-provider");
const markerLayer = require("./marker-layer");
const {
  getDescription,
  hasLazyDescription,
  resolveDescription,
  normalizePath,
  getMessageFile,
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
function buildHub(linter, renderer) {
  return Object.freeze({
    // The whole current set. A UI registering into a window that has been
    // linting for a while starts from here rather than waiting for a change.
    getMessages: () => (linter.disposed ? [] : linter.registryMessages?.messages || []),
    // Which of them belong to the active pane item, adapters included.
    getCurrentMessages: () => (linter.disposed ? [] : renderer.getCurrentMessages()),
    // The editor whose cursor marks a current position, or null when the active
    // item is not one — a notebook an adapter owns has its own idea of one.
    getCursorEditor: () => (linter.disposed ? null : renderer.editor),
    getMessagesAtPosition: (editor, position) =>
      linter.disposed ? [] : renderer.getMessagesAtPosition(editor, position),
    // The severity model, in precedence order. Open-ended by design, so a UI
    // reads it rather than hardcoding four tiers.
    getSeverities: () => Severities.SEVERITIES,
    revealMessage: (message) => !linter.disposed && renderer.revealMessage(message),
    deleteMessages: (messages) => !linter.disposed && linter.deleteMessages(messages),
    isLintingDisabled: (editor) => linter.disposed || renderer.isLintingDisabledForEditor(editor),
    // The spelling `location.normalizedFile` is in. A UI matching messages to a
    // file of its own has to compare them the same way, and writing the rule out
    // a second time is how a message ends up stored under one spelling and
    // looked up under another.
    normalizePath,
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

  const generation = (instance = new Linter());
  const renderer = (ui = new LinterUI());
  const providers = uiProviders;
  hub = buildHub(generation, renderer);

  // The scrollbar/minimap layer is an ordinary `linter.ui`, registered
  // directly rather than through the service hub — same validation, same
  // attach, same render patches.
  markerLayer.activate();
  renderer.onDidChangeMarkerAnchors = (buffer, reason) =>
    markerLayer.invalidateBuffer(buffer, { resetProjection: reason !== "retire" });
  subscriptions.add(
    consumeLinterUI(markerLayer.buildUI()),
    new Disposable(() => markerLayer.deactivate()),
  );

  // Every member of a UI is optional except its name, so each of these asks
  // before it calls. A UI that only draws markers implements none of them.
  const notify = (member, ...args) => {
    for (const provider of providers) {
      provider[member]?.(...args);
    }
  };

  generation.setUIRenderCallback((difference) => {
    renderer.render(difference);
    notify("render", difference);
  });
  // Per-run progress, for a UI that shows a spinner. The markers show none, so
  // these only ever reach the providers.
  generation.setUIBeginLintingCallback((event) => notify("didBeginLinting", event));
  generation.setUIFinishLintingCallback((event) => notify("didFinishLinting", event));
  // An indie provider can ask for the project's messages to be brought up, and
  // toggling linting for a file changes nothing about the message set — so
  // neither reaches a UI on the render path.
  generation.setUIProjectViewCallback(() => notify("showProjectView"));
  generation.setUILintingStateCallback(() => notify("didChangeLintingState"));
  // Which item is on screen decides what `getCurrentMessages` and
  // `getCursorEditor` answer, and no message changed when it moved.
  renderer.onDidChangeActiveItem = () => notify("didChangeActiveItem");
  renderer.setLintingStateProvider((editor) => generation.isTextEditorLintingDisabled(editor));
  renderer.onDeleteMessages = (messages) => generation.deleteMessages(messages);

  // Register commands
  subscriptions.add(
    generation,
    renderer,
    lumine.commands.add("lumine-workspace", {
      "linter:clear": {
        description: "Drop every message the linters have reported so far.",
        didDispatch: () => generation.clearAll(),
      },
      "linter:inspect": {
        description: "Show the messages sitting on the line under the cursor.",
        didDispatch: () => renderer.inspect(),
      },
      "linter:next": {
        description: "Move the cursor to the next message in this file.",
        didDispatch: () => renderer.inspectNext(),
      },
      "linter:previous": {
        description: "Move the cursor to the previous message in this file.",
        didDispatch: () => renderer.inspectPrevious(),
      },
    }),
  );
}

/**
 * Deactivates the linter package.
 */
function deactivate() {
  subscriptions?.dispose();
  instance = null;
}

function provideLinterLint() {
  const linter = instance;
  if (!linter || linter.disposed)
    throw new Error("Cannot provide linter.lint while the package is inactive");
  return Object.freeze({
    lintEditor: (editor, options) => linter.lintEditor(editor, options),
    lintBuffer: (buffer, options) => linter.lintBuffer(buffer, options),
  });
}

/**
 * Consumes linter providers from external packages.
 * @param {Object|Array} linter - Linter provider(s) to consume
 * @returns {Disposable}
 */
function consumeLinter(linter) {
  const generation = instance;
  const linters = Array.isArray(linter) ? linter : [linter];
  for (const entry of linters) {
    generation.addLinter(entry);
  }
  return new Disposable(() => {
    for (const entry of linters) {
      generation.deleteLinter(entry);
    }
  });
}

/**
 * Provides the indie linter service.
 * @returns {Function}
 */
function provideLinterRegistry() {
  const generation = instance;
  return (indie) => {
    if (!generation || generation.disposed) throw new Error("The linter registry is inactive");
    return generation.addIndie(indie);
  };
}

/**
 * Provides registration for an editor that is not a pane item. Only the
 * documents open in the workspace are linted on their own; a package whose own
 * editor is a document too — a commit box, a notebook's source editor —
 * registers it here and it is linted and decorated like any other.
 *
 * `lint: false` registers the editor for rendering only: its buffer gets the
 * marker layers and answers hover, but no provider ever runs on it. That is
 * the mode for an editor that displays messages an adapter projects onto it —
 * a notebook cell — where running providers on the fragment itself would lint
 * the same content twice. The decorations retire with the editor, so the
 * returned Disposable is inert in that mode.
 * @returns {Function} (editor, options) => Disposable
 */
function provideLinterEditors() {
  const generation = instance;
  const renderer = ui;
  return (editor, { lint = true } = {}) => {
    if (
      !generation ||
      generation.disposed ||
      !lumine.workspace.isTextEditor(editor) ||
      editor.isDestroyed()
    ) {
      return new Disposable(() => {});
    }
    renderer.patchEditor(editor);
    if (!lint) {
      return new Disposable(() => {});
    }
    generation.registryEditorsInit();
    return generation.registryEditors.registerEditor(editor);
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
  if (!instance || instance.disposed || !Validate.ui(provider)) {
    return new Disposable(() => {});
  }
  provider.attach?.(hub);
  const providers = uiProviders;
  providers.add(provider);
  return new Disposable(() => {
    provider.dispose?.();
    providers.delete(provider);
  });
}

function consumeLinterAdapter(adapter) {
  const generation = instance;
  const renderer = ui;
  generation.addItemAdapter(adapter);
  renderer.addItemAdapter(adapter);
  return new Disposable(() => {
    generation.removeItemAdapter(adapter);
    renderer.removeItemAdapter(adapter);
  });
}

/**
 * Provides the messages shown when the pointer rests on an issue or its
 * gutter dot, rendered by tooltips and the documentation panel.
 * @returns {Object} Provider for the context-help.provider service
 */
function provideContextHelp() {
  return createContextHelpProvider();
}

/**
 * Provides quick-fix intentions built from linter message solutions.
 * @returns {Object} Provider for the intentions.list service
 */
function provideIntentionsList() {
  const generation = instance;
  return createIntentionsProvider(() =>
    generation?.disposed ? [] : generation?.registryMessages?.messages || [],
  );
}

/**
 * Provides MCP tools exposing linter diagnostics to MCP clients.
 * @returns {Array} Array of tool definitions
 */
function provideMcpTools() {
  const generation = instance;
  const renderer = ui;
  return [
    {
      name: "GetLinterMessages",
      description:
        "Get known linter diagnostics (errors, warnings, info, hints) without opening files or triggering a lint pass. Returns {mode, path, messages} where messages is an array with severity, tags, excerpt, description, range, linterName, file, and url. The description is the provider's long form, such as a language server's rule code, and is null when it has none. With no arguments it returns the messages of the active editor (mode 'file'); pass scope 'project' for every message the project holds. Any of the optional filters (filePath, severity, linterName) scopes from across the whole project whatever the scope says (mode 'filter'). A file that was never opened can have messages from a project-scoped provider or an explicitly awaited buffer lint pass. Always returns a valid result object even when no editor is open.",
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
        const allMessages = generation?.disposed
          ? []
          : generation?.registryMessages?.messages || [];

        // When any filter is supplied, scope from the full registry whatever is
        // on screen, so callers can target a file, severity, or linter directly
        // (including diagnostics a project provider reported for an unopened file).
        if (filePath != null || severity != null || linterName != null) {
          const wantPath = filePath != null ? normalizePath(filePath) : null;
          const messages = allMessages
            .filter((msg) => {
              // Buffer-owned diagnostics follow renames even between passes.
              // Explicit paths keep the batch-normalized comparison key.
              const messagePath =
                msg.location?.file == null
                  ? normalizePath(getMessageFile(msg))
                  : msg.location.normalizedFile;
              if (wantPath != null && messagePath !== wantPath) {
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
        const messages = generation?.disposed
          ? []
          : renderer?.getCurrentMessages().map(formatMessage) || [];
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
    file: getMessageFile(msg),
    range: position
      ? {
          start: { row: position.start?.row, column: position.start?.column },
          end: { row: position.end?.row, column: position.end?.column },
        }
      : null,
    url: msg.url || null,
  };
}

function provideMarkerLayer() {
  return markerLayer.provideMarkerLayer();
}

module.exports = {
  activate,
  deactivate,
  consumeLinter,
  consumeLinterUI,
  consumeLinterAdapter,
  provideLinterRegistry,
  provideLinterEditors,
  provideLinterLint,
  provideIntentionsList,
  provideMcpTools,
  provideContextHelp,
  provideMarkerLayer,
  markerLayer,
};
