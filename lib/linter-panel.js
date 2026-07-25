/** @babel */
/** @jsx etch.dom */

const etch = require("@lumine-code/etch");
const path = require("path");

// Static maps to avoid repeated string operations in render loop
const SEVERITY_TEXT = { error: "Error", warning: "Warning", info: "Info" };
const SEVERITY_CLASS = {
  error: "linter-severity text-error icon icon-stop",
  warning: "linter-severity text-warning icon icon-alert",
  info: "linter-severity text-info icon icon-info",
};

class LinterPanel {
  constructor(pkg) {
    this.pkg = pkg;
    this.editor = null;
    this.cwatch = null;
    this.viewMode = "file"; // "file" or "project"
    this.sortMethod = atom.config.get("linter.defaultSortMethod") || "severity";
    this.sortDirection = "asc";
    this.showError = true;
    this.showWarning = true;
    this.showInfo = true;
    // Cache sorted messages to avoid re-sorting on every render
    this._sortedMessagesCache = null;
    this._lastMessages = null;
    this._lastSortMethod = null;
    this._lastSortDirection = null;
    // Track current highlighted row for CSS-only updates
    this._currentRowIndex = -1;
    // Track right-clicked row for context menu
    this._contextRow = null;
    // Track keyboard-focused row index for panel navigation
    this._focusedRowIndex = -1;
    // Bind row click handler once for event delegation
    this._onRowClick = this._onRowClick.bind(this);
    this._onRowMiddleClick = this._onRowMiddleClick.bind(this);
    etch.initialize(this);

    // Prevent browser auto-scroll on middle-click
    this.element.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });

    // Handle middle-click to delete individual messages
    this.element.addEventListener("mouseup", (e) => {
      if (e.button === 1) this._onRowMiddleClick(e);
    });

    // Context menu: track which row was right-clicked
    this.element.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".linter-row");
      this._contextRow = row;
    });

    // Register context menu and keyboard navigation commands
    this._disposables = atom.commands.add(this.element, {
      "linter:copy-description": () => this._copyDescription(),
      "linter:copy-details": () => this._copyDetails(),
      "core:move-up": (e) => {
        e.stopPropagation();
        this._moveFocusUp();
      },
      "core:move-down": (e) => {
        e.stopPropagation();
        this._moveFocusDown();
      },
      "core:confirm": (e) => {
        e.stopPropagation();
        this._confirmFocused();
      },
      "core:cancel": (e) => {
        e.stopPropagation();
        this._cancelFocus();
      },
    });
    atom.contextMenu.add({
      ".linter-wrapper .linter-row": [
        { label: "Copy Description", command: "linter:copy-description" },
        { label: "Copy Details", command: "linter:copy-details" },
      ],
    });
  }

  /**
   * Returns messages for the current view mode.
   * File mode: messages from the active editor's buffer.
   * Project mode: all messages across the project.
   */
  _getMessages() {
    if (this.viewMode === "project") {
      return this.pkg.allMessages || [];
    }
    return this.pkg.getCurrentMessages();
  }

  /**
   * Switches between file and project view modes.
   */
  setViewMode(mode) {
    if (this.viewMode === mode) return;
    // Clear .current highlight BEFORE state reset (etch won't touch it)
    const currentRow = this.element?.querySelector(".linter-row.current");
    if (currentRow) {
      currentRow.classList.remove("current");
    }
    this.viewMode = mode;
    this._currentRowIndex = -1;
    this._sortedMessagesCache = null;
    this._lastMessages = null;
    this.observe();
    this.update();
    this.pkg.status.update();
  }

  /**
   * Handle row clicks using event delegation for better performance.
   * Uses data attributes to find message position instead of closures.
   */
  _onRowClick(event) {
    // Check if clicked on log reference link
    const logRef = event.target.closest(".linter-log-ref");
    if (logRef) {
      event.stopPropagation();
      const file = logRef.dataset.file;
      const line = parseInt(logRef.dataset.line, 10);
      const column = parseInt(logRef.dataset.column, 10) || 0;
      if (file) {
        atom.workspace.open(file, {
          initialLine: line,
          initialColumn: column,
          pending: true,
        });
      }
      return;
    }

    // Find the clicked row
    const row = event.target.closest(".linter-row");
    if (!row) return;

    const rowIndex = row.dataset.index;
    if (rowIndex === undefined) return;

    const messages = this._getMessages();
    const sortedMessages = this._getSortedMessages(messages);
    const message = sortedMessages[parseInt(rowIndex, 10)];
    if (!message) return;

    if (this.viewMode === "project") {
      // In project mode, open the file and navigate to position
      atom.workspace.open(message.location.file, {
        initialLine: message.location.position.start.row,
        initialColumn: message.location.position.start.column,
        pending: true,
      });
    } else {
      this.pkg.revealMessage(message);
    }
  }

  _onRowMiddleClick(event) {
    const row = event.target.closest(".linter-row");
    if (!row) return;

    const rowIndex = row.dataset.index;
    if (rowIndex === undefined) return;

    const messages = this._getMessages();
    const sortedMessages = this._getSortedMessages(messages);
    const message = sortedMessages[parseInt(rowIndex, 10)];
    if (!message) return;

    this.pkg.deleteMessage(message);
  }

  setEditor(editor) {
    this.editor = editor;
    // Clear .current highlight BEFORE re-render (etch won't touch it if virtual DOM unchanged)
    const currentRow = this.element?.querySelector(".linter-row.current");
    if (currentRow) {
      currentRow.classList.remove("current");
    }
    this._currentRowIndex = -1;
    // Invalidate cache when editor changes (only matters in file mode)
    if (this.viewMode === "file") {
      this._sortedMessagesCache = null;
      this._lastMessages = null;
    }
    this.observe();
  }

  /**
   * Updates only the current row highlight using CSS classes.
   * Avoids full etch re-render for cursor position changes.
   */
  _updateCurrentRowHighlight() {
    if (!this.editor || this.pkg.activeItemAdapter || !this.element) return;

    const messages = this._getMessages();
    const sortedMessages = this._getSortedMessages(messages);
    const curpos = this.editor.getCursorBufferPosition();
    const editorPath = this.viewMode === "project" ? this.editor.getPath?.() : null;

    // Find which row (in visible filtered order) contains cursor
    let newRowIndex = -1;
    let visibleIndex = 0;
    for (let i = 0; i < sortedMessages.length; i++) {
      const message = sortedMessages[i];
      // Apply same visibility filters as render
      if (!this.showError && message.severity === "error") continue;
      if (!this.showWarning && message.severity === "warning") continue;
      if (!this.showInfo && message.severity === "info") continue;

      if (editorPath && message.location.file !== editorPath) {
        visibleIndex++;
        continue;
      }
      const range = message.location.displayRange || message.location.position;
      if (range.containsPoint(curpos)) {
        newRowIndex = visibleIndex;
        break;
      }
      visibleIndex++;
    }

    // No change needed
    if (newRowIndex === this._currentRowIndex) return;

    const tbody = this.element.querySelector("tbody");
    if (!tbody) return;

    // Remove current class from old row
    if (this._currentRowIndex >= 0) {
      const oldRow = tbody.children[this._currentRowIndex];
      if (oldRow) {
        oldRow.classList.remove("current");
      }
    }

    // Add current class to new row
    if (newRowIndex >= 0) {
      const newRow = tbody.children[newRowIndex];
      if (newRow) {
        newRow.classList.add("current");
      }
    }

    this._currentRowIndex = newRowIndex;
    this.scrollToCurrent();
  }

  /**
   * Returns sorted messages, using cache if inputs haven't changed.
   * Avoids re-sorting on every cursor move (which triggers render).
   */
  _getSortedMessages(messages) {
    // Check if we can use cached result
    if (
      this._sortedMessagesCache &&
      this._lastMessages === messages &&
      this._lastSortMethod === this.sortMethod &&
      this._lastSortDirection === this.sortDirection &&
      this._lastViewMode === this.viewMode
    ) {
      return this._sortedMessagesCache;
    }

    // Need to re-sort
    let sortedMessages;
    if (this.sortMethod === "severity") {
      const severityOrder = { error: 0, warning: 1, info: 2 };
      sortedMessages = [...messages].sort((a, b) => {
        const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
        if (severityDiff !== 0) {
          return this.sortDirection === "asc" ? severityDiff : -severityDiff;
        }
        const positionDiff = compareMessagePosition(a, b, false);
        return this.sortDirection === "asc" ? positionDiff : -positionDiff;
      });
    } else if (this.sortMethod === "provider") {
      sortedMessages = [...messages].sort((a, b) => {
        // Use < > comparison instead of localeCompare for better performance
        if (a.linterName < b.linterName) return this.sortDirection === "asc" ? -1 : 1;
        if (a.linterName > b.linterName) return this.sortDirection === "asc" ? 1 : -1;
        const positionDiff = compareMessagePosition(a, b, false);
        return this.sortDirection === "asc" ? positionDiff : -positionDiff;
      });
    } else {
      // "position" sort: in project mode, sort by file path then position
      // in file mode, sort by position only
      const byFile = this.viewMode === "project";
      sortedMessages = [...messages].sort((a, b) => {
        const val = compareMessagePosition(a, b, byFile);
        return this.sortDirection === "asc" ? val : -val;
      });
    }

    // Update cache
    this._sortedMessagesCache = sortedMessages;
    this._lastMessages = messages;
    this._lastSortMethod = this.sortMethod;
    this._lastSortDirection = this.sortDirection;
    this._lastViewMode = this.viewMode;

    return sortedMessages;
  }

  _copyDescription() {
    if (!this._contextRow) return;
    const desc = this._contextRow.querySelector(".linter-description");
    if (desc) {
      atom.clipboard.write(desc.textContent.trim());
    }
  }

  _copyDetails() {
    if (!this._contextRow) return;
    const index = parseInt(this._contextRow.dataset.index, 10);
    if (isNaN(index)) return;
    const messages = this._getMessages();
    const sortedMessages = this._getSortedMessages(messages);
    const message = sortedMessages[index];
    if (!message) return;
    atom.clipboard.write(
      JSON.stringify(
        message,
        (k, v) => (k === "key" || k === "version" || k === "displayRange" ? undefined : v),
        2,
      ),
    );
  }

  /**
   * Abbreviates a file path relative to the project root.
   */
  _abbreviatePath(filePath) {
    if (!filePath) return "";
    const projectPaths = atom.project.getPaths();
    const multiProject = projectPaths.length > 1;
    for (const projectPath of projectPaths) {
      if (filePath.startsWith(projectPath)) {
        const relative = filePath.substring(projectPath.length + 1).replace(/\\/g, "/");
        return multiProject ? path.basename(projectPath) + "/" + relative : relative;
      }
    }
    return path.basename(filePath);
  }

  destroy() {
    if (this.cwatch) {
      this.cwatch.dispose();
      this.cwatch = null;
    }
    if (this._disposables) {
      this._disposables.dispose();
    }
    etch.destroy(this);
  }

  update() {
    // Clear .current and .focused before re-render since etch doesn't know about them
    const currentRow = this.element?.querySelector(".linter-row.current");
    if (currentRow) currentRow.classList.remove("current");
    this._currentRowIndex = -1;
    const focusedRow = this.element?.querySelector(".linter-row.focused");
    if (focusedRow) focusedRow.classList.remove("focused");
    // _focusedRowIndex is preserved so readAfterUpdate can restore it
    etch.update(this);
  }

  readAfterUpdate() {
    this._updateCurrentRowHighlight();
    // Restore focused row highlight if panel still has focus
    if (this._focusedRowIndex >= 0 && this.element.contains(document.activeElement)) {
      const savedIndex = this._focusedRowIndex;
      this._focusedRowIndex = -1;
      const tbody = this.element.querySelector("tbody");
      if (tbody && tbody.children.length > 0) {
        this._setFocusedRow(Math.min(savedIndex, tbody.children.length - 1));
      }
    } else {
      this._focusedRowIndex = -1;
    }
  }

  setSortMethod(method) {
    if (this.sortMethod === method) {
      this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
    } else {
      this.sortMethod = method;
      this.sortDirection = "asc";
    }
    this.update();
  }

  toggleVisibility(type) {
    if (type === "error") this.showError = !this.showError;
    if (type === "warning") this.showWarning = !this.showWarning;
    if (type === "info") this.showInfo = !this.showInfo;
    this.update();
  }

  render() {
    const isProject = this.viewMode === "project";

    const severityClass =
      this.sortMethod === "severity"
        ? "linter-header-sortable linter-header-active"
        : "linter-header-sortable";
    const providerClass =
      this.sortMethod === "provider"
        ? "linter-header-sortable linter-header-active"
        : "linter-header-sortable";

    const thirdLabel = isProject ? "File" : "Position";
    const thirdClass =
      this.sortMethod === "position"
        ? "linter-header-sortable linter-header-active"
        : "linter-header-sortable";

    const head = (
      <tr class="linter-header">
        <th class={severityClass} on={{ click: () => this.setSortMethod("severity") }}>
          Severity{" "}
          {this.sortMethod === "severity" ? (this.sortDirection === "asc" ? "▼" : "▲") : ""}
        </th>
        <th class={providerClass} on={{ click: () => this.setSortMethod("provider") }}>
          Provider{" "}
          {this.sortMethod === "provider" ? (this.sortDirection === "asc" ? "▼" : "▲") : ""}
        </th>
        <th class={thirdClass} on={{ click: () => this.setSortMethod("position") }}>
          {thirdLabel}{" "}
          {this.sortMethod === "position" ? (this.sortDirection === "asc" ? "▼" : "▲") : ""}
        </th>
        <th>
          <span class="linter-header-title">Description</span>
          <span class="linter-toggles">
            <span
              class={this.viewMode === "file" ? "linter-view-tab active" : "linter-view-tab"}
              on={{ click: () => this.setViewMode("file") }}
            >
              File
            </span>
            <span
              class={this.viewMode === "project" ? "linter-view-tab active" : "linter-view-tab"}
              on={{ click: () => this.setViewMode("project") }}
            >
              Project
            </span>
            <label class="input-label error">
              <input
                class="input-toggle"
                type="checkbox"
                checked={this.showError}
                on={{ change: () => this.toggleVisibility("error") }}
              />
            </label>
            <label class="input-label warning">
              <input
                class="input-toggle"
                type="checkbox"
                checked={this.showWarning}
                on={{ change: () => this.toggleVisibility("warning") }}
              />
            </label>
            <label class="input-label info">
              <input
                class="input-toggle"
                type="checkbox"
                checked={this.showInfo}
                on={{ change: () => this.toggleVisibility("info") }}
              />
            </label>
          </span>
        </th>
      </tr>
    );

    const data = [];
    const messages = this._getMessages();
    const sortedMessages = this._getSortedMessages(messages);

    // Track visible index for data-index attribute
    let visibleIndex = 0;
    for (let i = 0; i < sortedMessages.length; i++) {
      const message = sortedMessages[i];
      if (!this.showError && message.severity === "error") continue;
      if (!this.showWarning && message.severity === "warning") continue;
      if (!this.showInfo && message.severity === "info") continue;

      const scls = SEVERITY_CLASS[message.severity];
      const stxt = SEVERITY_TEXT[message.severity];

      // Build position/file cell content
      const positionContent = [];
      const cell = message.location.cell;
      if (isProject) {
        // Project mode: show abbreviated file path + line:col
        const abbrev = this._abbreviatePath(message.location.file);
        positionContent.push(
          <span class="linter-file-path" title={message.location.file}>
            {abbrev}
          </span>,
        );
        positionContent.push(
          <span class="linter-file-line">
            {cell != null ? `[${cell}]:` : ""}
            {message.location.position.start.row + 1}:{message.location.position.start.column + 1}
          </span>,
        );
      } else {
        // File mode: show line:col
        positionContent.push(
          <span>
            {cell != null ? `[${cell}]:` : ""}
            {message.location.position.start.row + 1}:{message.location.position.start.column + 1}
          </span>,
        );
        // Add log reference link if available
        if (message.reference && message.reference.file) {
          const refLine = Array.isArray(message.reference.position)
            ? message.reference.position[0]
            : (message.reference.position?.row ?? 0);
          const refColumn = Array.isArray(message.reference.position)
            ? message.reference.position[1]
            : (message.reference.position?.column ?? 0);
          positionContent.push(
            <a
              class="linter-log-ref"
              dataset={{ file: message.reference.file, line: refLine, column: refColumn }}
              title={`Open log at line ${refLine + 1}`}
            >
              log:{refLine + 1}
            </a>,
          );
        }
      }

      const item = (
        <tr
          class={"linter-row " + message.severity}
          dataset={{ index: i, visibleIndex: visibleIndex }}
        >
          <td class={scls}>{stxt}</td>
          <td class="linter-provider">{message.linterName}</td>
          <td class="linter-position">{positionContent}</td>
          <td class="linter-description" innerHTML={atom.ui.markdown.render(message.excerpt)} />
        </tr>
      );

      data.push(item);
      visibleIndex++;
    }

    return (
      <div class="linter-wrapper" tabIndex="0">
        <table class="linter-table">
          <thead>{head}</thead>
          <tbody on={{ click: this._onRowClick }}>{data}</tbody>
        </table>
      </div>
    );
  }

  getTitle() {
    return "Linter";
  }

  getIconName() {
    return "alert";
  }

  getDefaultLocation() {
    return "bottom";
  }

  getAllowedLocations() {
    return ["center", "bottom"];
  }

  toggle() {
    const refocus = atom.workspace.getActivePaneItem() != this;
    let prev = document.activeElement;
    atom.workspace.toggle(this).then(() => {
      if (refocus) {
        prev.focus();
      }
      this.scrollToCurrent();
    });
  }

  observe() {
    if (this.cwatch) {
      this.cwatch.dispose();
      this.cwatch = null;
    }
    if (this.editor) {
      // Use CSS-only highlight update instead of full re-render
      // This is much faster as it only updates 2 DOM elements instead of entire table
      this.cwatch = this.editor.onDidChangeCursorPosition(
        throttle(() => {
          this._updateCurrentRowHighlight();
        }, 100),
      );
    }
  }

  scrollToCurrent() {
    const currentRow = this.element.querySelector(".linter-row.current");
    if (!currentRow) return;

    const scrollContainer = this.element.querySelector("tbody");
    if (!scrollContainer) return;

    const rowTop =
      currentRow.getBoundingClientRect().top -
      scrollContainer.getBoundingClientRect().top +
      scrollContainer.scrollTop;
    const rowBottom = rowTop + currentRow.offsetHeight;
    const visibleTop = scrollContainer.scrollTop;
    const visibleBottom = scrollContainer.scrollTop + scrollContainer.clientHeight;

    if (rowTop < visibleTop) {
      scrollContainer.scrollTop = rowTop;
    } else if (rowBottom > visibleBottom) {
      scrollContainer.scrollTop = rowBottom - scrollContainer.clientHeight;
    }
  }

  _setFocusedRow(index) {
    const tbody = this.element.querySelector("tbody");
    if (!tbody) return;
    if (this._focusedRowIndex >= 0) {
      const oldRow = tbody.children[this._focusedRowIndex];
      if (oldRow) oldRow.classList.remove("focused");
    }
    this._focusedRowIndex = index;
    if (index >= 0) {
      const newRow = tbody.children[index];
      if (newRow) {
        newRow.classList.add("focused");
        this.scrollToFocused();
      }
    }
  }

  _moveFocusDown() {
    const tbody = this.element.querySelector("tbody");
    if (!tbody || !tbody.children.length) return;
    const count = tbody.children.length;
    this._setFocusedRow(
      this._focusedRowIndex < 0 ? 0 : Math.min(this._focusedRowIndex + 1, count - 1),
    );
  }

  _moveFocusUp() {
    const tbody = this.element.querySelector("tbody");
    if (!tbody || !tbody.children.length) return;
    const count = tbody.children.length;
    this._setFocusedRow(
      this._focusedRowIndex < 0 ? count - 1 : Math.max(this._focusedRowIndex - 1, 0),
    );
  }

  _confirmFocused() {
    if (this._focusedRowIndex < 0) return;
    const tbody = this.element.querySelector("tbody");
    if (!tbody) return;
    const row = tbody.children[this._focusedRowIndex];
    if (!row) return;
    const rowIndex = row.dataset.index;
    if (rowIndex === undefined) return;
    const message = this._getSortedMessages(this._getMessages())[parseInt(rowIndex, 10)];
    if (!message) return;
    this._setFocusedRow(-1);
    if (this.viewMode === "project") {
      atom.workspace.open(message.location.file, {
        initialLine: message.location.position.start.row,
        initialColumn: message.location.position.start.column,
        pending: true,
      });
    } else {
      this.pkg.revealMessage(message);
    }
  }

  _cancelFocus() {
    this._setFocusedRow(-1);
    const editor = atom.workspace.getActiveTextEditor();
    if (editor) editor.element.focus();
  }

  _initFocusedRow() {
    const tbody = this.element.querySelector("tbody");
    if (!tbody || !tbody.children.length) return;
    const startIndex = this._currentRowIndex >= 0 ? this._currentRowIndex : 0;
    this._setFocusedRow(Math.min(startIndex, tbody.children.length - 1));
  }

  toggleFocus() {
    if (this.element.contains(document.activeElement)) {
      this._cancelFocus();
      return;
    }
    atom.workspace.open(this, { searchAllPanes: true }).then(() => {
      this.element.focus();
      this._initFocusedRow();
    });
  }

  scrollToFocused() {
    if (this._focusedRowIndex < 0) return;
    const tbody = this.element.querySelector("tbody");
    if (!tbody) return;
    const focusedRow = tbody.children[this._focusedRowIndex];
    if (!focusedRow) return;
    const rowTop =
      focusedRow.getBoundingClientRect().top - tbody.getBoundingClientRect().top + tbody.scrollTop;
    const rowBottom = rowTop + focusedRow.offsetHeight;
    const visibleTop = tbody.scrollTop;
    const visibleBottom = tbody.scrollTop + tbody.clientHeight;
    if (rowTop < visibleTop) {
      tbody.scrollTop = rowTop;
    } else if (rowBottom > visibleBottom) {
      tbody.scrollTop = rowBottom - tbody.clientHeight;
    }
  }
}

function compareMessagePosition(a, b, byFile) {
  if (byFile) {
    const fileA = a.location.file || "";
    const fileB = b.location.file || "";
    if (fileA < fileB) return -1;
    if (fileA > fileB) return 1;
  }

  const cellA = a.location.cell;
  const cellB = b.location.cell;
  if (cellA != null || cellB != null) {
    const valueA = cellA == null ? -1 : cellA;
    const valueB = cellB == null ? -1 : cellB;
    if (valueA !== valueB) return valueA - valueB;
  }

  const startA = a.location.position.start;
  const startB = b.location.position.start;
  if (startA.row !== startB.row) return startA.row - startB.row;
  return startA.column - startB.column;
}

function throttle(func, timeout) {
  let timer = false;
  return function (...args) {
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      func.apply(this, args);
      timer = false;
    }, timeout);
  };
}

module.exports = { LinterPanel };
