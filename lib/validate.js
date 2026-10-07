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
  if (isProxy(related) || !Array.isArray(related)) return false;
  for (let index = 0; index < related.length; index++) {
    const item = related[index];
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

function record(value) {
  return value !== null && typeof value === "object" && !isProxy(value) && !Array.isArray(value);
}

function validCoordinates(point) {
  if (!point || typeof point !== "object" || isProxy(point)) return false;
  if (Array.isArray(point) && point.length !== 2) return false;
  const row = Array.isArray(point) ? point[0] : point.row;
  const column = Array.isArray(point) ? point[1] : point.column;
  // Infinity is an intentional end-of-line/end-of-buffer sentinel in the
  // editor's position API. Missing, mistyped and negative coordinates are not.
  return (
    typeof row === "number" &&
    typeof column === "number" &&
    !Number.isNaN(row) &&
    !Number.isNaN(column) &&
    row >= 0 &&
    column >= 0
  );
}

function validPoint(point, positionCache) {
  if (!validCoordinates(point)) return false;
  const parsed = Point.fromObject(point);
  if (!(point instanceof Point)) positionCache?.set(point, parsed);
  return true;
}

function validRange(position, positionCache) {
  if (!position || typeof position !== "object" || isProxy(position)) return false;
  if (Array.isArray(position) && position.length !== 2) return false;
  const start = Array.isArray(position) ? position[0] : position.start;
  const end = Array.isArray(position) ? position[1] : position.end;
  if (!validCoordinates(start) || !validCoordinates(end)) return false;
  const parsed = Range.fromObject(position);
  if (!(position instanceof Range)) positionCache?.set(position, parsed);
  return true;
}

function validLocation(location, positionCache) {
  if (!record(location)) return false;
  const { file, buffer, position } = location;
  if (file !== undefined && (typeof file !== "string" || !file)) return false;
  if (buffer !== undefined && !record(buffer)) return false;
  if (file === undefined && buffer === undefined) return false;
  return validRange(position, positionCache);
}

function validSolutions(solutions, positionCache) {
  if (isProxy(solutions)) return false;
  if (solutions instanceof Promise) return true;
  if (!Array.isArray(solutions)) return false;
  for (let index = 0; index < solutions.length; index++) {
    const solution = solutions[index];
    if (!record(solution) || !validRange(solution.position, positionCache)) return false;
    if (typeof solution.replaceWith !== "string") return false;
    if (solution.title !== undefined && typeof solution.title !== "string") return false;
  }
  return true;
}

function validateMessages(linterName, entries, positionCache) {
  const invalid = new Set();
  const check = (description, predicate) => {
    try {
      if (!predicate()) invalid.add(description);
    } catch {
      invalid.add(description);
    }
  };
  if (isProxy(entries) || !Array.isArray(entries)) {
    invalid.add("Linter Result must be an Array");
  } else {
    for (let index = 0; index < entries.length; index++) {
      let message;
      try {
        message = entries[index];
      } catch {
        invalid.add("Message must be a readable object");
        continue;
      }
      if (!record(message)) {
        invalid.add("Message must be an object");
        continue;
      }
      check("Message.code must be a string or finite number", () => {
        const { code } = message;
        return (
          code === undefined ||
          typeof code === "string" ||
          (typeof code === "number" && Number.isFinite(code))
        );
      });
      check(
        "Message.source must be a string",
        () => message.source === undefined || typeof message.source === "string",
      );
      check(
        "Message.relatedInformation must contain a message and exactly one file/range location or URI",
        () =>
          message.relatedInformation === undefined ||
          validRelatedInformation(message.relatedInformation, positionCache),
      );
      check("Message.location must have a file or a buffer and a valid position", () =>
        validLocation(message.location, positionCache),
      );
      check("Message.reference must be valid", () => {
        const { reference } = message;
        return (
          reference === undefined ||
          (record(reference) &&
            typeof reference.file === "string" &&
            reference.file.length > 0 &&
            validPoint(reference.position, positionCache))
        );
      });
      check(
        "Message.solutions must be valid",
        () => message.solutions === undefined || validSolutions(message.solutions, positionCache),
      );
      check("Message.excerpt must be a string", () => typeof message.excerpt === "string");
      check(`Message.severity must be ${Severities.listText()}`, () =>
        Severities.isValid(message.severity),
      );
      check(`Message.tags must be an array of ${Tags.listText()}`, () => {
        const { tags } = message;
        if (tags === undefined) return true;
        if (isProxy(tags) || !Array.isArray(tags)) return false;
        for (let index = 0; index < tags.length; index++) {
          if (!Tags.VALID_TAG.has(tags[index])) return false;
        }
        return true;
      });
      for (const field of ["url", "icon", "linterName"]) {
        check(
          `Message.${field} must be a string`,
          () => message[field] === undefined || typeof message[field] === "string",
        );
      }
      check(
        "Message.description must be a function or string",
        () =>
          message.description === undefined ||
          typeof message.description === "function" ||
          typeof message.description === "string",
      );
    }
  }
  if (invalid.size) {
    showError(
      "Invalid Linter Result received",
      `These issues were encountered while processing messages from a linter named '${linterName}'`,
      [...invalid],
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
