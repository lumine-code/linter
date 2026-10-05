const { Point, Range } = require("lumine");
const path = require("node:path");
const Severities = require("./severities");
const diagnosticIndex = require("./diagnostic-index");
const {
  getDescription,
  hasLazyDescription,
  resolveDescription,
  renderExcerpt,
  normalizePath,
} = require("./helpers");

// Above every other source of hover documentation. A diagnostic on the word
// under the pointer is what the reader is asking about; its type, which the
// language server would answer with, is not the news.
const PRIORITY = 100;

// Messages whose live range covers the position, most severe first. Native
// severity marker indexes find the candidates without reading earlier ranges.
function messagesAtPosition(buffer, position) {
  return diagnosticIndex
    .messagesAtPosition(buffer, position)
    .sort((a, b) => Severities.compare(a.severity, b.severity));
}

// Messages touching the row at all, for the gutter: its dot stands for the
// line, not for any column of it.
function messagesAtRow(buffer, row) {
  return diagnosticIndex
    .messagesAtRow(buffer, row)
    .sort((a, b) => Severities.compare(a.severity, b.severity));
}

// The narrowest span every matched message agrees on. All of them contain the
// position, so the intersection does too, and it is what the tooltip watches
// to decide the pointer has left the thing it is describing.
function intersectionOf(messages) {
  return messages
    .map((message) => Range.fromObject(message.location.displayRange || message.location.position))
    .reduce((a, b) => new Range(Point.max(a.start, b.start), Point.min(a.end, b.end)));
}

function buildReference(message, reference) {
  const position = Array.isArray(reference.position)
    ? { row: reference.position[0], column: reference.position[1] }
    : { row: reference.position?.row ?? 0, column: reference.position?.column ?? 0 };

  const link = document.createElement("button");
  link.type = "button";
  link.classList.add("linter-hover-reference");
  link.textContent = `log:${position.row + 1}`;
  link.title = `Open ${message.linterName} log at line ${position.row + 1}`;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    void lumine.workspace.open(reference.file, {
      initialLine: position.row,
      initialColumn: position.column,
      pending: true,
    });
  });
  return link;
}

// A long form usually opens with the name of the tool that produced it —
// "Ruff: F401" from a server already introduced as "ruff language server" —
// and the line reads twice as long for it. The opening word goes only when the
// source is already saying it; anything else is left exactly as it was given.
function withoutSourcePrefix(description, linterName) {
  if (!linterName) return description;
  const opening = /^([^:\n]{1,32}):\s*(\S.*)$/s.exec(description);
  if (!opening) return description;
  const [, prefix, rest] = opening;
  return linterName.toLowerCase().includes(prefix.trim().toLowerCase()) ? rest : description;
}

function relatedPosition(location) {
  return Range.fromObject(location.position).start;
}

function relatedPathLabel(file, message) {
  const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(file) ? path.win32 : path;
  if (normalizePath(file) === normalizePath(message.location?.file)) return pathApi.basename(file);
  const [projectPath, relative] = lumine.project.relativizePath(file);
  return projectPath ? relative : pathApi.basename(file);
}

function buildRelatedInformation(message) {
  if (!message.relatedInformation?.length) return null;
  const list = document.createElement("ul");
  list.className = "linter-hover-related";
  for (const related of message.relatedInformation) {
    const row = document.createElement("li");
    row.className = "linter-hover-related-item";
    const context = document.createElement("div");
    context.className = "linter-hover-related-message";
    context.textContent = related.message;
    row.appendChild(context);
    if (related.location?.file) {
      const { file } = related.location;
      const position = relatedPosition(related.location);
      const fullLabel = `${file}:${position.row + 1}:${position.column + 1}`;
      const link = document.createElement("button");
      link.type = "button";
      link.className = "linter-hover-related-location";
      link.textContent = `${relatedPathLabel(file, message)}:${position.row + 1}:${position.column + 1}`;
      link.title = fullLabel;
      link.setAttribute("aria-label", `${related.message} ${fullLabel}`);
      link.addEventListener("click", () => {
        void lumine.workspace.open(file, {
          initialLine: position.row,
          initialColumn: position.column,
          pending: true,
        });
      });
      row.appendChild(link);
    } else if (related.uri) {
      const uri = document.createElement("div");
      uri.className = "linter-hover-related-uri";
      uri.textContent = related.uri;
      row.appendChild(uri);
    }
    list.appendChild(row);
  }
  return list;
}

// The LSP bridge retains a plain-text fallback for other consumers. Do not
// repeat that fallback when this surface has the structured metadata already.
function hoverDescription(message, description) {
  const structured = message.code != null || message.source || message.relatedInformation;
  if (!structured) return withoutSourcePrefix(description, message.linterName);
  const sourceAndCode = [message.source, message.code]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join(": ");
  const related = (message.relatedInformation || [])
    .map((item) => {
      if (!item.location) return `${item.uri}: ${item.message}`;
      const position = relatedPosition(item.location);
      return `${item.location.file}:${position.row + 1}:${position.column + 1}: ${item.message}`;
    })
    .join("\n");
  const fallback = [sourceAndCode, related].filter(Boolean).join("\n\n");
  return description === fallback ? "" : description;
}

function buildItem(message) {
  const item = document.createElement("div");
  item.classList.add("linter-hover-item");
  const severity = Severities.get(message.severity);
  // Guarded: classList throws on an empty name, and a provider can still send
  // a severity outside the model.
  if (severity) item.classList.add(severity.name);

  const icon = document.createElement("span");
  icon.classList.add("linter-hover-icon", "icon");
  if (severity) icon.classList.add(severity.icon, severity.textClass);
  icon.title = severity ? severity.label : String(message.severity);
  item.appendChild(icon);

  const body = document.createElement("div");
  body.classList.add("linter-hover-body");

  const excerpt = document.createElement("div");
  excerpt.classList.add("linter-hover-excerpt");
  excerpt.innerHTML = renderExcerpt(message.excerpt);
  body.appendChild(excerpt);

  // Metadata stays on one compact line; descriptions and source locations
  // have their own blocks rather than extending the provider's label.
  const meta = document.createElement("div");
  meta.classList.add("linter-hover-meta");

  if (message.code !== undefined && message.code !== null && message.code !== "") {
    const code = document.createElement("code");
    code.className = "linter-hover-code";
    code.textContent = String(message.code);
    meta.appendChild(code);
  }

  const source = document.createElement("span");
  source.classList.add("linter-hover-source");
  source.textContent = message.linterName || message.source || "";
  meta.appendChild(source);

  // Legacy providers still supply a plain or lazy long form. Keep its place
  // stable while it resolves and show additional prose without duplicated LSP metadata.
  const detail = document.createElement("span");
  detail.classList.add("linter-hover-detail");
  meta.appendChild(detail);

  const description = getDescription(message);
  if (description) {
    detail.textContent = hoverDescription(message, description);
  } else if (hasLazyDescription(message)) {
    // A hover is the gesture that asks for the long form, so resolving it is
    // this render's job — but only this one's. A tooltip dismissed meanwhile
    // has taken its element out of the document, and nothing is written to it.
    resolveDescription(message).then((text) => {
      if (text && detail.isConnected) {
        detail.textContent = hoverDescription(message, text);
      }
    });
  }

  if (message.reference?.file) meta.appendChild(buildReference(message, message.reference));
  body.appendChild(meta);

  const related = buildRelatedInformation(message);
  if (related) body.appendChild(related);

  item.appendChild(body);
  return item;
}

// The tooltip supplies the surface; this is what stands on it. Severity,
// rule name and origin are the whole point of a diagnostic, and markdown
// would flatten all three into one paragraph.
function buildElement(messages) {
  const root = document.createElement("div");
  root.classList.add("linter-hover");
  const topSeverity = Severities.get(messages[0].severity);
  if (topSeverity) root.classList.add(topSeverity.name);
  for (const message of messages) root.appendChild(buildItem(message));
  return root;
}

// Answers context-help consumers for both text and the gutter. The setting
// controls whether diagnostics join documentation on either surface.
function createContextHelpProvider() {
  const enabled = () => lumine.config.get("linter.showContextHelp");

  return {
    name: "Linter",
    packageName: "linter",
    priority: PRIORITY,

    getHelp(editor, position, { signal } = {}) {
      if (signal?.aborted || !enabled()) return null;
      const messages = messagesAtPosition(editor.getBuffer(), position);
      if (messages.length === 0) return null;
      return {
        contents: { render: () => buildElement(messages) },
        range: intersectionOf(messages),
      };
    },

    getGutterHelp(editor, row, { signal } = {}) {
      if (signal?.aborted || !enabled()) return null;
      const messages = messagesAtRow(editor.getBuffer(), row);
      if (messages.length === 0) return null;
      // No range: the answer is about the row, and the tooltip stands for all
      // of it, so the pointer may travel from the dot along the line.
      return { contents: { render: () => buildElement(messages) } };
    },
  };
}

module.exports = {
  createContextHelpProvider,
  messagesAtPosition,
  messagesAtRow,
  buildElement,
};
