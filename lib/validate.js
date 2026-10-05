const { Range, Point } = require("lumine");
const { isProxy } = require("node:util").types;
const Severities = require("./severities");
const Tags = require("./tags");
const { MARKER_INVALIDATIONS } = require("./helpers");

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

function validRelatedInformation(related, positionCache) {
  if (!Array.isArray(related) || isProxy(related)) return false;
  for (const item of related) {
    if (!item || typeof item !== "object" || isProxy(item)) return false;
    try {
      if (typeof item.message !== "string") return false;
      const hasLocation = item.location !== undefined;
      const hasUri = item.uri !== undefined;
      if (hasLocation === hasUri) return false;
      if (hasUri) {
        if (typeof item.uri !== "string" || !item.uri) return false;
        continue;
      }
      const location = item.location;
      if (
        !location ||
        typeof location !== "object" ||
        isProxy(location) ||
        typeof location.file !== "string" ||
        !location.file
      )
        return false;
      const position = location.position;
      if (!position || typeof position !== "object" || isProxy(position)) return false;
      const endpoints = Array.isArray(position) ? position : [position.start, position.end];
      if (endpoints.length !== 2) return false;
      for (const point of endpoints) {
        if (!point || typeof point !== "object" || isProxy(point)) return false;
        const coordinates = Array.isArray(point) ? point : [point.row, point.column];
        if (
          coordinates.length !== 2 ||
          !Number.isFinite(coordinates[0]) ||
          coordinates[0] < 0 ||
          !Number.isFinite(coordinates[1]) ||
          coordinates[1] < 0
        )
          return false;
      }
      const range = Range.fromObject(position);
      if (!(position instanceof Range)) positionCache?.set(position, range);
    } catch {
      return false;
    }
  }
  return true;
}

function validateMessages(linterName, entries, positionCache) {
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
    let invalidCode = false;
    let invalidSource = false;
    let invalidRelated = false;
    for (let i = 0, { length } = entries; i < length; ++i) {
      const message = entries[i];
      const { reference } = message;
      try {
        if (
          !invalidCode &&
          message.code !== undefined &&
          typeof message.code !== "string" &&
          !(typeof message.code === "number" && Number.isFinite(message.code))
        ) {
          invalidCode = true;
          messages.push("Message.code must be a string or finite number");
        }
      } catch {
        if (!invalidCode) messages.push("Message.code must be a string or finite number");
        invalidCode = true;
      }
      try {
        if (!invalidSource && message.source !== undefined && typeof message.source !== "string") {
          invalidSource = true;
          messages.push("Message.source must be a string");
        }
      } catch {
        if (!invalidSource) messages.push("Message.source must be a string");
        invalidSource = true;
      }
      try {
        if (
          !invalidRelated &&
          message.relatedInformation !== undefined &&
          !validRelatedInformation(message.relatedInformation, positionCache)
        ) {
          invalidRelated = true;
          messages.push(
            "Message.relatedInformation must contain a message and exactly one file/range location or URI",
          );
        }
      } catch {
        if (!invalidRelated)
          messages.push(
            "Message.relatedInformation must contain a message and exactly one file/range location or URI",
          );
        invalidRelated = true;
      }
      if (!invalidIcon && message.icon && typeof message.icon !== "string") {
        invalidIcon = true;
        messages.push("Message.icon must be a string");
      }
      if (
        !invalidLocation &&
        (!message.location ||
          typeof message.location !== "object" ||
          // A message names its subject by path, or — for a buffer that has
          // never been saved and therefore has no path — by the buffer itself.
          (typeof message.location.file !== "string" && !message.location.buffer) ||
          typeof message.location.position !== "object" ||
          !message.location.position)
      ) {
        invalidLocation = true;
        messages.push("Message.location must have a file or a buffer");
      } else if (!invalidLocation) {
        const range = Range.fromObject(message.location.position);
        if (!(message.location.position instanceof Range)) {
          positionCache?.set(message.location.position, range);
        }
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
        if (!(reference.position instanceof Point))
          positionCache?.set(reference.position, position);
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
