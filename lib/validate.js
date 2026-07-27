const { Range, Point } = require("atom");
const Severities = require("./severities");
const Tags = require("./tags");

function showError(title, description, points) {
  const renderedPoints = points.map((item) => `  • ${item}`);
  atom.notifications.addWarning(`[Linter] ${title}`, {
    dismissable: true,
    detail: `${description}\n${renderedPoints.join("\n")}`,
  });
}

function validateUI(ui) {
  const messages = [];
  if (ui && typeof ui === "object") {
    if (typeof ui.name !== "string") {
      messages.push("UI.name must be a string");
    }
    if (typeof ui.didBeginLinting !== "function") {
      messages.push("UI.didBeginLinting must be a function");
    }
    if (typeof ui.didFinishLinting !== "function") {
      messages.push("UI.didFinishLinting must be a function");
    }
    if (typeof ui.render !== "function") {
      messages.push("UI.render must be a function");
    }
    if (typeof ui.dispose !== "function") {
      messages.push("UI.dispose must be a function");
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

function validateMessages(linterName, entries) {
  const messages = [];
  if (Array.isArray(entries)) {
    let invalidURL = false;
    let invalidIcon = false;
    let invalidExcerpt = false;
    let invalidLocation = false;
    let invalidSeverity = false;
    let invalidTags = false;
    let invalidSolution = false;
    let invalidReference = false;
    let invalidDescription = false;
    let invalidLinterName = false;
    for (let i = 0, { length } = entries; i < length; ++i) {
      const message = entries[i];
      const { reference } = message;
      if (!invalidIcon && message.icon && typeof message.icon !== "string") {
        invalidIcon = true;
        messages.push("Message.icon must be a string");
      }
      if (
        !invalidLocation &&
        (!message.location ||
          typeof message.location !== "object" ||
          typeof message.location.file !== "string" ||
          typeof message.location.position !== "object" ||
          !message.location.position)
      ) {
        invalidLocation = true;
        messages.push("Message.location must be valid");
      } else if (!invalidLocation) {
        const range = Range.fromObject(message.location.position);
        if (
          Number.isNaN(range.start.row) ||
          Number.isNaN(range.start.column) ||
          Number.isNaN(range.end.row) ||
          Number.isNaN(range.end.column)
        ) {
          invalidLocation = true;
          messages.push("Message.location.position should not contain NaN coordinates");
        }
      }
      if (
        !invalidSolution &&
        message.solutions &&
        !Array.isArray(message.solutions) &&
        !(message.solutions instanceof Promise)
      ) {
        invalidSolution = true;
        messages.push("Message.solutions must be valid");
      }
      if (
        !invalidReference &&
        reference &&
        (typeof reference !== "object" ||
          typeof reference.file !== "string" ||
          typeof reference.position !== "object" ||
          !reference.position)
      ) {
        invalidReference = true;
        messages.push("Message.reference must be valid");
      } else if (!invalidReference && reference && reference.position !== undefined) {
        const position = Point.fromObject(reference.position);
        if (Number.isNaN(position.row) || Number.isNaN(position.column)) {
          invalidReference = true;
          messages.push("Message.reference.position should not contain NaN coordinates");
        }
      }
      if (!invalidExcerpt && typeof message.excerpt !== "string") {
        invalidExcerpt = true;
        messages.push("Message.excerpt must be a string");
      }
      if (!invalidSeverity && !Severities.isValid(message.severity)) {
        invalidSeverity = true;
        messages.push(`Message.severity must be ${Severities.listText()}`);
      }
      // Absent is the common case and must pass untouched: tags are optional
      // and no provider outside the LSP bridge sets them.
      if (
        !invalidTags &&
        message.tags &&
        (!Array.isArray(message.tags) || message.tags.some((tag) => !Tags.VALID_TAG.has(tag)))
      ) {
        invalidTags = true;
        messages.push(`Message.tags must be an array of ${Tags.listText()}`);
      }
      if (!invalidURL && message.url && typeof message.url !== "string") {
        invalidURL = true;
        messages.push("Message.url must be a string");
      }
      if (
        !invalidDescription &&
        message.description &&
        typeof message.description !== "function" &&
        typeof message.description !== "string"
      ) {
        invalidDescription = true;
        messages.push("Message.description must be a function or string");
      }
      if (!invalidLinterName && message.linterName && typeof message.linterName !== "string") {
        invalidLinterName = true;
        messages.push("Message.linterName must be a string");
      }
    }
  } else {
    messages.push("Linter Result must be an Array");
  }
  if (messages.length) {
    showError(
      "Invalid Linter Result received",
      `These issues were encountered while processing messages from a linter named '${linterName}'`,
      messages,
    );
    return false;
  }
  return true;
}

module.exports = {
  ui: validateUI,
  linter: validateLinter,
  indie: validateIndie,
  messages: validateMessages,
};
