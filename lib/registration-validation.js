const { MARKER_INVALIDATIONS } = require("./message-metadata");

function showError(title, description, points) {
  const renderedPoints = points.map((item) => `  • ${item}`);
  lumine.notifications.addWarning(`[Linter] ${title}`, {
    dismissable: true,
    detail: `${description}\n${renderedPoints.join("\n")}`,
  });
}

// Everything a UI may implement. A UI takes only the ones it has a use for —
// a scrollbar overview wants `render` and nothing else — so the check is that
// what is there is callable, not that all of it is there.
const UI_MEMBERS = [
  "attach",
  "render",
  "didBeginLinting",
  "didFinishLinting",
  "didChangeActiveItem",
  "didChangeLintingState",
  "showProjectView",
  "dispose",
];

function validateUI(ui) {
  const messages = [];
  if (ui && typeof ui === "object") {
    // The one requirement: something to call it in a notification.
    if (typeof ui.name !== "string") {
      messages.push("UI.name must be a string");
    }
    for (const member of UI_MEMBERS) {
      if (ui[member] !== undefined && typeof ui[member] !== "function") {
        messages.push(`UI.${member} must be a function`);
      }
    }
  } else {
    messages.push("UI must be an object");
  }
  if (messages.length) {
    showError(
      "Invalid UI received",
      `These issues were encountered while registering the UI named '${
        ui && ui.name ? ui.name : "Unknown"
      }'`,
      messages,
    );
    return false;
  }
  return true;
}

function validateLinter(linter) {
  const messages = [];
  if (linter && typeof linter === "object") {
    if (typeof linter.name !== "string") {
      messages.push("Linter.name must be a string");
    }
    if (
      typeof linter.scope !== "string" ||
      (linter.scope !== "file" && linter.scope !== "project")
    ) {
      messages.push("Linter.scope must be either 'file' or 'project'");
    }
    if (typeof linter.lintsOnChange !== "boolean") {
      messages.push("Linter.lintsOnChange must be a boolean");
    }
    if (!Array.isArray(linter.grammarScopes)) {
      messages.push("Linter.grammarScopes must be an Array");
    }
    if (typeof linter.lint !== "function") {
      messages.push("Linter.lint must be a function");
    }
  } else {
    messages.push("Linter must be an object");
  }
  if (messages.length) {
    showError(
      "Invalid Linter received",
      `These issues were encountered while registering a Linter named '${
        linter && linter.name ? linter.name : "Unknown"
      }'`,
      messages,
    );
    return false;
  }
  return true;
}

function validateIndie(indie) {
  const messages = [];
  if (indie && typeof indie === "object") {
    if (typeof indie.name !== "string") {
      messages.push("Indie.name must be a string");
    }
    if (
      indie.markerInvalidation !== undefined &&
      !MARKER_INVALIDATIONS.has(indie.markerInvalidation)
    ) {
      messages.push("Indie.markerInvalidation must be either 'touch' or 'never'");
    }
  } else {
    messages.push("Indie must be an object");
  }
  if (messages.length) {
    showError(
      "Invalid Indie received",
      `These issues were encountered while registering an Indie Linter named '${
        indie && indie.name ? indie.name : "Unknown"
      }'`,
      messages,
    );
    return false;
  }
  return true;
}

module.exports = { ui: validateUI, linter: validateLinter, indie: validateIndie, showError };
