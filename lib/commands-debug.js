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
async function showDebug(standardLinters, indieLinters, textEditor) {
  const Helpers = require("./helpers");
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
  const disabledLinters = lumine.config.get("linter.disabledProviders").map(formatItem).join("\n");
  const matchesIgnoreGlob = Helpers.matchesIgnoreGlob(textEditor.getPath(), ignoreGlob);
  lumine.notifications.addInfo("Linter Debug Info", {
    detail: [
      `Platform: ${process.platform}`,
      `Lumine Version: ${lumine.application.getVersion()}`,
      `Linter Version: ${manifest.version}`,
      `Opened file matches Ignore Glob: ${matchesIgnoreGlob ? "Yes" : "No"}`,
      `Matching Linter Providers: \n${matchingStandardLinters}`,
      `Disabled Linter Providers: \n${disabledLinters}`,
      `Standard Linter Providers: \n${standardLinterNames}`,
      `Indie Linter Providers: \n${indieLinterNames}`,
      `Ignore Glob: ${ignoreGlob}`,
      `Current File Scopes: \n${humanizedScopes}`,
    ].join("\n"),
    dismissable: true,
  });
}
module.exports = showDebug;
