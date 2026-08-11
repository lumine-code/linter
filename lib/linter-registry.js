const { Emitter, CompositeDisposable } = require("lumine");
const Helpers = require("./helpers");
const Validate = require("./validate");
const { $version, $activated, $requestLatest, $requestLastReceived } = require("./helpers");

// Default timeout for linter execution (30 seconds)
const LINTER_TIMEOUT_MS = 30000;

// Helper to create a timeout promise
function createTimeoutPromise(ms, linterName) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Linter '${linterName}' timed out after ${ms}ms`));
    }, ms);
  });
}

class LinterRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.linters = new Set();
    this.lintOnChange = true;
    this.ignoreVCS = true;
    this.ignoreGlob = "**/*.min.{js,css}";
    this.lintPreviewTabs = true;
    this.subscriptions = new CompositeDisposable();
    this.disabledProviders = [];
    this.activeNotifications = new Set();
    this.subscriptions.add(
      this.emitter,
      lumine.config.observe("linter.lintOnChange", (lintOnChange) => {
        this.lintOnChange = lintOnChange;
      }),
      lumine.config.observe("core.excludeVcsIgnoredPaths", (ignoreVCS) => {
        this.ignoreVCS = ignoreVCS;
      }),
      lumine.config.observe("linter.ignoreGlob", (ignoreGlob) => {
        this.ignoreGlob = ignoreGlob;
      }),
      lumine.config.observe("linter.lintPreviewTabs", (lintPreviewTabs) => {
        this.lintPreviewTabs = lintPreviewTabs;
      }),
      lumine.config.observe("linter.disabledProviders", (disabledProviders) => {
        if (disabledProviders.length !== 0) {
          console.warn(`Linter package: disabled linter providers: ${disabledProviders}`);
        }
        this.disabledProviders = disabledProviders;
      }),
    );
  }

  hasLinter(linter) {
    return this.linters.has(linter);
  }

  addLinter(linter) {
    if (!Validate.linter(linter)) {
      return false;
    }
    linter[$activated] = true;
    if (typeof linter[$requestLatest] === "undefined") {
      linter[$requestLatest] = 0;
    }
    if (typeof linter[$requestLastReceived] === "undefined") {
      linter[$requestLastReceived] = 0;
    }
    linter[$version] = 2;
    // Convert grammarScopes array to Set for O(1) lookup in shouldTriggerLinter
    if (Array.isArray(linter.grammarScopes) && !(linter.grammarScopes instanceof Set)) {
      linter._grammarScopesSet = new Set(linter.grammarScopes);
    }
    this.linters.add(linter);
    return true;
  }

  getProviders() {
    return Array.from(this.linters);
  }

  deleteLinter(linter) {
    if (!this.linters.has(linter)) {
      return;
    }
    linter[$activated] = false;
    this.linters.delete(linter);
  }

  async lint({ onChange, editor, isCenterEditor = null }) {
    const filePath = editor.getPath();
    if (
      (onChange && !this.lintOnChange) ||
      (!this.lintPreviewTabs && lumine.workspace.getActivePane().getPendingItem() === editor)
    ) {
      return false;
    }
    // A buffer that has never been saved cannot be matched against a glob or
    // asked about by a repository, and it is not ignored either — it is just not
    // a file yet. `isPathIgnored` answers `true` for a missing path, so the
    // question only makes sense once there is one.
    if (filePath && (await Helpers.isPathIgnored(filePath, this.ignoreGlob, this.ignoreVCS))) {
      return false;
    }
    const scopes = Helpers.getEditorCursorScopes(editor);
    // Asked at most once per run, and only if a provider narrowed itself to the
    // documents open in the centre.
    let center = null;
    const inCenter = () => {
      if (center === null) center = isCenterEditor ? isCenterEditor() : true;
      return center;
    };

    const promises = [];
    for (const linter of this.linters) {
      if (!Helpers.shouldTriggerLinter(linter, onChange, scopes)) {
        continue;
      }
      if (this.disabledProviders.includes(linter.name)) {
        continue;
      }
      // A package builds editors of its own to render a diff, a preview or a
      // dock's input field with. A provider that only means documents says so.
      if (linter.editors === "center" && !inCenter()) {
        continue;
      }
      const number = ++linter[$requestLatest];
      const statusBuffer = linter.scope === "file" ? editor.getBuffer() : null;
      const statusFilePath = linter.scope === "file" ? filePath : null;
      this.emitter.emit("did-begin-linting", {
        number,
        linter,
        filePath: statusFilePath,
      });
      promises.push(
        Promise.race([
          new Promise(function (resolve) {
            resolve(linter.lint(editor));
          }),
          createTimeoutPromise(LINTER_TIMEOUT_MS, linter.name),
        ]).then(
          (messages) => {
            this.emitter.emit("did-finish-linting", {
              number,
              linter,
              filePath: statusFilePath,
            });
            if (
              linter[$requestLastReceived] >= number ||
              !linter[$activated] ||
              (statusBuffer && !statusBuffer.isAlive())
            ) {
              return;
            }
            linter[$requestLastReceived] = number;
            if (statusBuffer && !statusBuffer.isAlive()) {
              return;
            }
            if (messages === null || messages === undefined) {
              return;
            }
            let validity = true;
            if (lumine.window.isDevMode() || !Array.isArray(messages)) {
              validity = Validate.messages(linter.name, messages);
            }
            if (!validity) {
              return;
            }
            Helpers.normalizeMessages(linter.name, messages);
            this.emitter.emit("did-update-messages", {
              messages,
              linter,
              buffer: statusBuffer,
            });
          },
          (error) => {
            this.emitter.emit("did-finish-linting", {
              number,
              linter,
              filePath: statusFilePath,
            });
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[Linter] Error running ${linter.name}:`, errorMessage, error);

            // Use linter name as the key to prevent duplicate notifications
            const notificationKey = `linter-error:${linter.name}`;

            // Check if we already have an active notification for this linter
            if (this.activeNotifications.has(notificationKey)) {
              return;
            }

            const notification = lumine.notifications.addError(
              `[Linter] Error running ${linter.name}`,
              {
                detail: `${errorMessage}\n\nSee Console for more info.`,
                dismissable: true,
                buttons: [
                  {
                    text: "Open Console",
                    onDidClick: () => {
                      lumine.window.openDevTools();
                      notification.dismiss();
                    },
                  },
                  {
                    text: "Cancel",
                    onDidClick: () => {
                      notification.dismiss();
                    },
                  },
                ],
              },
            );
            // Track notification by linter name and remove when dismissed
            this.activeNotifications.add(notificationKey);
            notification.onDidDismiss(() => {
              this.activeNotifications.delete(notificationKey);
            });
          },
        ),
      );
    }
    await Promise.all(promises);
    return true;
  }

  onDidUpdateMessages(callback) {
    return this.emitter.on("did-update-messages", callback);
  }

  onDidBeginLinting(callback) {
    return this.emitter.on("did-begin-linting", callback);
  }

  onDidFinishLinting(callback) {
    return this.emitter.on("did-finish-linting", callback);
  }

  dispose() {
    this.activeNotifications.clear();
    this.linters.clear();
    this.subscriptions.dispose();
  }
}

module.exports = LinterRegistry;
