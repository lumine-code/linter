const { Point, Range } = require("atom");
const Severities = require("./severities");
const { getDescription, hasLazyDescription, resolveDescription } = require("./helpers");

// Above every other source of hover documentation. A diagnostic on the word
// under the pointer is what the reader is asking about; its type, which the
// language server would answer with, is not the news.
const PRIORITY = 100;

// Messages whose range covers the position, most severe first. The list is
// sorted by start, so a message beginning past the row ends the search.
function messagesAtPosition(buffer, position) {
  return collect(buffer, position.row, (range) => range.containsPoint(position));
}

// Messages touching the row at all, for the gutter: its dot stands for the
// line, not for any column of it.
function messagesAtRow(buffer, row) {
  return collect(buffer, row, (range) => range.start.row <= row && range.end.row >= row);
}

function collect(buffer, row, matches) {
  const messages = buffer.linterUI?.messages;
  if (!messages) return [];

  const found = [];
  for (const message of messages) {
    if (matches(message.location.displayRange || message.location.position)) {
      found.push(message);
    }
    if (message.location.position.start.row > row) break;
  }
  return found.sort((a, b) => Severities.compare(a.severity, b.severity));
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

  const link = document.createElement("a");
  link.classList.add("linter-hover-reference");
  link.textContent = `log:${position.row + 1}`;
  link.title = `Open ${message.linterName} log at line ${position.row + 1}`;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    atom.workspace.open(reference.file, {
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
  excerpt.innerHTML = atom.tools.markdown.render(message.excerpt);
  body.appendChild(excerpt);

  // Under it, one line saying where this came from and what it is called
  // there: "ruff language server: F401". The long form carries the rule code
  // and any related location, as plain text — markdown would reflow exactly
  // what it is precise about.
  const meta = document.createElement("div");
  meta.classList.add("linter-hover-meta");

  const source = document.createElement("span");
  source.classList.add("linter-hover-source");
  source.textContent = message.linterName;
  meta.appendChild(source);

  // Always in the DOM and empty until it has something, so a lazy description
  // fills its own place rather than landing after whatever was appended while
  // it resolved. The colon between the two is drawn by the stylesheet, which
  // is how it stays away when there is nothing to separate.
  const detail = document.createElement("span");
  detail.classList.add("linter-hover-detail");
  meta.appendChild(detail);

  const description = getDescription(message);
  if (description) {
    detail.textContent = withoutSourcePrefix(description, message.linterName);
  } else if (hasLazyDescription(message)) {
    // A hover is the gesture that asks for the long form, so resolving it is
    // this render's job — but only this one's. A tooltip dismissed meanwhile
    // has taken its element out of the document, and nothing is written to it.
    resolveDescription(message).then((text) => {
      if (text && detail.isConnected) {
        detail.textContent = withoutSourcePrefix(text, message.linterName);
      }
    });
  }

  if (message.reference?.file) meta.appendChild(buildReference(message, message.reference));
  body.appendChild(meta);

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

// Answers the hover package for both the text and the gutter. Enabled through
// the same setting the old bubble had, so turning the tooltip off still turns
// it off — the package simply declines, and whatever else provides hover
// documentation answers instead.
function createHoverProvider() {
  const enabled = () => atom.config.get("linter.showHoverTooltip");

  return {
    name: "Linter",
    packageName: "linter",
    priority: PRIORITY,

    hover(editor, position) {
      if (!enabled()) return null;
      const messages = messagesAtPosition(editor.getBuffer(), position);
      if (messages.length === 0) return null;
      return { contents: { element: buildElement(messages) }, range: intersectionOf(messages) };
    },

    hoverGutter(editor, row) {
      if (!enabled()) return null;
      const messages = messagesAtRow(editor.getBuffer(), row);
      if (messages.length === 0) return null;
      // No range: the answer is about the row, and the tooltip stands for all
      // of it, so the pointer may travel from the dot along the line.
      return { contents: { element: buildElement(messages) } };
    },
  };
}

module.exports = {
  createHoverProvider,
  messagesAtPosition,
  messagesAtRow,
  buildElement,
};
