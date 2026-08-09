const { CompositeDisposable, Emitter } = require("lumine");
const Helpers = require("./helpers");

let manifest;

function formatItem(item) {
  let itemName;
  if (item && typeof item === "object" && typeof item.name === "string") {
    itemName = item.name;
  } else if (typeof item === "string") {
    itemName = item;
  } else {
    throw new Error("Unknown object passed to formatItem()");
  }
  return `  - ${itemName}`;
}

function sortByName(item1, item2) {
  return item1.name.localeCompare(item2.name);
}

class Commands {
  constructor() {
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      this.emitter,
      lumine.commands.add("lumine-workspace", {
        "linter:lint": () => this.lint(),
        "linter:debug": () => this.debug(),
        "linter:state": () => this.toggleActiveEditor(),
        "linter:toggle-current-file": () => this.toggleActiveEditor(),
        "linter:toggle-linter": () => this.toggleLinter(),
      }),
    );
  }

  lint() {
    this.emitter.emit("should-lint");
  }

  debug() {
    this.emitter.emit("should-debug");
  }

  toggleLinter() {
    this.emitter.emit("should-toggle-linter");
  }

  toggleActiveEditor() {
    this.emitter.emit("should-toggle-active-editor");
  }

  onShouldLint(callback) {
    return this.emitter.on("should-lint", callback);
  }

  onShouldDebug(callback) {
    return this.emitter.on("should-debug", callback);
  }

  onShouldToggleActiveEditor(callback) {
    return this.emitter.on("should-toggle-active-editor", callback);
  }

  onShouldToggleLinter(callback) {
    return this.emitter.on("should-toggle-linter", callback);
  }

  dispose() {
    this.subscriptions.dispose();
  }
}

async function showDebug(standardLinters, indieLinters, textEditor) {
  if (!manifest) {
    manifest = require("../package.json");
  }
  if (!textEditor) {
    return;
  }
  const textEditorScopes = Helpers.getEditorCursorScopes(textEditor);
  const sortedLinters = standardLinters.slice().sort(sortByName);
  const sortedIndieLinters = indieLinters.slice().sort(sortByName);
  const indieLinterNames = sortedIndieLinters.map(formatItem).join("\n");
  const standardLinterNames = sortedLinters.map(formatItem).join("\n");
  const matchingStandardLinters = sortedLinters
    .filter((linter) => Helpers.shouldTriggerLinter(linter, false, textEditorScopes))
    .map(formatItem)
    .join("\n");
  const humanizedScopes = textEditorScopes.map(formatItem).join("\n");
  const ignoreGlob = lumine.config.get("linter.ignoreGlob");
  const ignoreVCSIgnoredPaths = lumine.config.get("core.excludeVcsIgnoredPaths");
  const disabledLinters = lumine.config.get("linter.disabledProviders").map(formatItem).join("\n");
  const filePathIgnored = await Helpers.isPathIgnored(
    textEditor.getPath(),
    ignoreGlob,
    ignoreVCSIgnoredPaths,
  );
  lumine.notifications.addInfo("Linter Debug Info", {
    detail: [
      `Platform: ${process.platform}`,
      `Lumine Version: ${lumine.app.getVersion()}`,
      `Linter Version: ${manifest.version}`,
      `Opened file is ignored: ${filePathIgnored ? "Yes" : "No"}`,
      `Matching Linter Providers: \n${matchingStandardLinters}`,
      `Disabled Linter Providers: \n${disabledLinters}`,
      `Standard Linter Providers: \n${standardLinterNames}`,
      `Indie Linter Providers: \n${indieLinterNames}`,
      `Ignore Glob: ${ignoreGlob}`,
      `VCS Ignored Paths are excluded: ${ignoreVCSIgnoredPaths}`,
      `Current File Scopes: \n${humanizedScopes}`,
    ].join("\n"),
    dismissable: true,
  });
}

module.exports = { Commands, showDebug };
