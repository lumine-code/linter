const { Emitter, CompositeDisposable } = require("lumine");
const Helpers = require("./helpers");
const Validate = require("./validate");
const { LintRequest, CANCELLED, outcome, errorText } = require("./lint-request");
const { mapProjectLocations } = require("./lint-snapshot");

const LINTER_TIMEOUT_MS = 30000;

class LinterRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.linters = new Set();
    this.requests = new WeakMap();
    this.requestNumbers = new WeakMap();
    this.bufferRequests = new WeakMap();
    this.activePasses = new Set();
    this.nextPassId = 0;
    this.lintOnChange = true;
    this.ignoreGlob = "**/*.min.{js,css}";
    this.lintPreviewTabs = true;
    this.disabledProviders = [];
    this.activeNotifications = new Set();
    this.subscriptions = new CompositeDisposable(
      this.emitter,
      lumine.config.observe("linter.lintOnChange", (value) => {
        this.lintOnChange = value;
        this.checkPolicies();
      }),
      lumine.config.observe("linter.ignoreGlob", (value) => {
        this.ignoreGlob = value;
        this.checkPolicies();
      }),
      lumine.config.observe("linter.lintPreviewTabs", (value) => {
        this.lintPreviewTabs = value;
        this.checkPolicies();
      }),
      lumine.config.observe("linter.disabledProviders", (names) =>
        this.setDisabledProviders(names),
      ),
    );
  }

  hasLinter(linter) {
    return this.linters.has(linter);
  }

  setDisabledProviders(names) {
    this.disabledProviders = names.slice();
    for (const linter of this.linters) {
      if (names.includes(linter.name)) this.cancelProvider(linter, "disabled");
    }
  }

  addLinter(linter) {
    if (this.disposed) return false;
    if (this.linters.has(linter)) return true;
    if (!Validate.linter(linter) || this.disposed) return false;
    this.requests.set(linter, {
      latestFileRuns: new WeakMap(),
      latestProjectRun: null,
      active: new Set(),
    });
    this.linters.add(linter);
    return true;
  }

  getProviders() {
    return [...this.linters];
  }

  cancelProvider(linter, reason) {
    for (const run of this.requests.get(linter)?.active || []) run.cancel(reason);
  }

  deleteLinter(linter) {
    if (!this.linters.has(linter)) return;
    this.cancelProvider(linter, "unregistered");
    this.linters.delete(linter);
    this.requests.delete(linter);
  }

  cancelBuffer(buffer, reason = "disabled") {
    this.bufferRequests.get(buffer)?.cancel(reason);
  }

  clearFileResultsForGrammarChange(buffer) {
    this.cancelBuffer(buffer, "grammar-changed");
    for (const linter of this.linters) {
      if (linter.scope !== "file") continue;
      this.requests.get(linter).latestFileRuns.get(buffer)?.cancel("grammar-changed");
      this.emitter.emit("did-update-messages", { linter, messages: [], buffer });
    }
  }

  skipReason(editor, buffer, trigger, isDisabled) {
    if (isDisabled?.()) return "disabled";
    if (trigger === "change" && !this.lintOnChange) return "change-disabled";
    if (
      editor &&
      !this.lintPreviewTabs &&
      lumine.workspace.paneForItem(editor)?.getPendingItem() === editor
    )
      return "preview";
    const filePath = buffer.getPath();
    if (filePath && Helpers.matchesIgnoreGlob(filePath, this.ignoreGlob)) return "ignored";
    return null;
  }

  checkPolicies() {
    for (const pass of this.activePasses) {
      const reason = this.skipReason(pass.editor, pass.buffer, pass.trigger, pass.isDisabled);
      if (reason) pass.cancel(reason);
    }
  }

  async lint({
    trigger = "manual",
    editor,
    buffer = editor?.getBuffer(),
    createEditor,
    signal,
    isDisabled,
  }) {
    if (this.disposed) return outcome("cancelled", "disposed");
    if (!buffer?.isAlive() || editor?.isDestroyed()) return outcome("cancelled", "destroyed");
    if (signal?.aborted) return outcome("cancelled", "aborted");
    if (trigger === "grammar") this.clearFileResultsForGrammarChange(buffer);
    const skip = this.skipReason(editor, buffer, trigger, isDisabled);
    if (skip) return outcome("skipped", skip);

    const pass = new LintRequest({ buffer, editor, signal, id: ++this.nextPassId });
    pass.trigger = trigger;
    pass.isDisabled = isDisabled;
    const previous = this.bufferRequests.get(buffer);
    this.bufferRequests.set(buffer, pass);
    this.activePasses.add(pass);
    previous?.cancel("superseded");
    let ownedEditor;
    let providers = [];
    try {
      if (createEditor) {
        ownedEditor = createEditor(pass.input);
        editor = ownedEditor;
        pass.observeEditor(editor);
        const destroySnapshot = () => {
          if (!editor.isDestroyed()) editor.destroy();
        };
        pass.signal.addEventListener("abort", destroySnapshot, { once: true });
        pass.subscriptions.add({
          dispose: () => pass.signal.removeEventListener("abort", destroySnapshot),
        });
        if (pass.signal.aborted) destroySnapshot();
        pass.subscriptions.add(
          editor.getBuffer().onDidChange(() => pass.cancel("snapshot-changed")),
          editor.getBuffer().onDidChangePath(() => pass.cancel("snapshot-changed")),
          editor.getBuffer().onDidChangeEncoding(() => pass.cancel("snapshot-changed")),
          editor.getBuffer().onDidChangeLanguageMode(() => pass.cancel("snapshot-changed")),
        );
      }
      if (!pass.isCurrent()) return this.passOutcome(pass, providers);
      const ready = await pass.wait(editor.whenGrammarSettled({ signal: pass.signal }), {
        timeout: LINTER_TIMEOUT_MS,
        timeoutReason: "grammar-timeout",
      });
      if (ready === CANCELLED || !pass.isCurrent()) return this.passOutcome(pass, providers);
      if (!ready) return outcome("failed", "grammar-unavailable");
      const skipped = this.skipReason(editor, buffer, trigger, isDisabled);
      if (skipped) return outcome("skipped", skipped);

      const scopes = Helpers.getEditorCursorScopes(editor);
      const runs = [];
      for (const linter of this.linters) {
        if (!Helpers.shouldTriggerLinter(linter, trigger === "change", scopes)) continue;
        if (this.disabledProviders.includes(linter.name)) continue;
        runs.push(this.runProvider(pass, linter, editor));
      }
      providers = await Promise.all(runs);
      return this.passOutcome(pass, providers);
    } catch (error) {
      if (!pass.isCurrent()) return this.passOutcome(pass, providers);
      pass.cancel("preparation-error");
      return outcome("failed", "preparation-error", providers, error);
    } finally {
      if (this.bufferRequests.get(buffer) === pass) this.bufferRequests.delete(buffer);
      this.activePasses.delete(pass);
      pass.close();
      if (ownedEditor && !ownedEditor.isDestroyed()) ownedEditor.destroy();
    }
  }

  passOutcome(pass, providers) {
    if (pass.reason)
      return outcome(
        pass.reason === "grammar-timeout" ? "failed" : "cancelled",
        pass.reason,
        providers,
      );
    const failed = providers.some((provider) => provider.status === "failed");
    if (failed) return outcome("failed", "provider-error", providers);
    const cancelled = providers.filter((provider) => provider.status === "cancelled");
    if (cancelled.length) {
      const reasons = new Set(cancelled.map((provider) => provider.reason));
      return outcome(
        "cancelled",
        reasons.size === 1 ? cancelled[0].reason : "provider-cancelled",
        providers,
      );
    }
    return outcome("completed", null, providers);
  }

  async runProvider(pass, linter, editor) {
    const state = this.requests.get(linter);
    const statusBuffer = linter.scope === "file" ? pass.buffer : null;
    const current = statusBuffer ? state.latestFileRuns.get(statusBuffer) : state.latestProjectRun;
    const name = linter.name;
    if (current?.id > pass.id)
      return { name, status: "cancelled", reason: "superseded", messageCount: 0 };
    current?.cancel("superseded");
    const run = new LintRequest({ id: pass.id });
    run.link(pass);
    state.active.add(run);
    if (statusBuffer) state.latestFileRuns.set(statusBuffer, run);
    else state.latestProjectRun = run;
    const number = (this.requestNumbers.get(linter) || 0) + 1;
    this.requestNumbers.set(linter, number);
    const event = { number, linter, filePath: statusBuffer ? editor.getPath() : null };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      state.active.delete(run);
      this.emitter.emit("did-finish-linting", event);
    };
    const cancelled = () => ({
      name,
      status: run.reason === "timeout" ? "failed" : "cancelled",
      reason: run.reason,
      messageCount: 0,
    });
    try {
      run.signal.addEventListener("abort", finish, { once: true });
      this.emitter.emit("did-begin-linting", event);
      if (!run.isCurrent()) return cancelled();
      const messages = await run.wait(
        Promise.resolve().then(() =>
          run.isCurrent() ? linter.lint(editor, { signal: run.signal }) : CANCELLED,
        ),
        { timeout: LINTER_TIMEOUT_MS },
      );
      if (messages === CANCELLED || !run.isCurrent() || !pass.isCurrent()) {
        if (run.reason === "timeout" && pass.isCurrent())
          this.reportError(
            linter,
            new Error("Linter '" + name + "' timed out after " + LINTER_TIMEOUT_MS + "ms"),
          );
        return cancelled();
      }
      if (messages == null) return { name, status: "unchanged", messageCount: 0 };
      const positionCache = new WeakMap();
      if (!Validate.messages(name, messages, positionCache))
        return { name, status: "failed", reason: "invalid-messages", messageCount: 0 };
      const sourceBuffer = editor.getBuffer();
      const accepted =
        linter.scope === "project"
          ? mapProjectLocations(messages, {
              snapshotBuffer: sourceBuffer,
              originalBuffer: pass.buffer,
            })
          : messages;
      for (const message of accepted) {
        if (sourceBuffer !== pass.buffer && message.location.buffer === sourceBuffer)
          message.location.buffer = pass.buffer;
      }
      Helpers.normalizeMessages(name, accepted, { positionCache });
      if (!run.isCurrent() || !pass.isCurrent()) return cancelled();
      this.emitter.emit("did-update-messages", {
        messages: accepted,
        linter,
        buffer: statusBuffer,
      });
      return { name, status: "published", messageCount: accepted.length };
    } catch (error) {
      if (!run.isCurrent() || !pass.isCurrent()) return cancelled();
      this.reportError(linter, error);
      return {
        name,
        status: "failed",
        reason: "provider-error",
        error: errorText(error),
        messageCount: 0,
      };
    } finally {
      run.signal.removeEventListener("abort", finish);
      run.close();
      finish();
    }
  }

  reportError(linter, error) {
    const message = errorText(error);
    console.error("[Linter] Error running " + linter.name + ":", message, error);
    const key = "linter-error:" + linter.name;
    if (this.activeNotifications.has(key)) return;
    const notification = lumine.notifications.addError("[Linter] Error running " + linter.name, {
      detail: message + "\n\nSee Console for more info.",
      dismissable: true,
      buttons: [
        {
          text: "Open Console",
          onDidClick: () => {
            lumine.window.openDevTools();
            notification.dismiss();
          },
        },
        { text: "Cancel", onDidClick: () => notification.dismiss() },
      ],
    });
    this.activeNotifications.add(key);
    notification.onDidDismiss(() => this.activeNotifications.delete(key));
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
    if (this.disposed) return;
    this.disposed = true;
    for (const pass of this.activePasses) pass.cancel("disposed");
    this.activeNotifications.clear();
    this.linters.clear();
    this.requests = new WeakMap();
    this.subscriptions.dispose();
  }
}

module.exports = LinterRegistry;
