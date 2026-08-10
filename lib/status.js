const { SEVERITIES } = require("./severities");

class StatusPanel {
  constructor(pkg) {
    this.pkg = pkg;
    this.editor = null;
    this.statusMode = true;

    this.element = document.createElement("div");
    this.element.classList.add("linter-status");

    this.tiles = SEVERITIES.map((severity) => {
      const anchor = document.createElement("a");
      const icon = document.createElement("span");
      icon.classList.add("icon", severity.icon);
      anchor.appendChild(icon);
      const label = document.createElement("span");
      anchor.appendChild(label);
      this.element.appendChild(anchor);
      return { severity, anchor, label };
    });

    this.element.onmouseup = (e) => this.onmouseup(e);
    this.element.oncontextmenu = (e) => e.preventDefault();

    this.configDisposable = lumine.config.observe("linter.statusMode", (value) => {
      this.statusMode = value;
      this.update();
    });

    this.tooltipDisposable = lumine.tooltips.addComposite(this.element, [
      {
        title: "Toggle panel",
        keyBindingExtra: "LMB",
        keyBindingCommand: "linter:toggle-panel",
      },
      {
        title: "Toggle file/project view",
        keyBindingExtra: "MMB",
      },
      {
        title: "Clear all messages",
        keyBindingExtra: "cmdorctrl+MMB",
        keyBindingCommand: "linter:clear",
      },
      {
        title: "Go to next message",
        keyBindingExtra: "RMB",
        keyBindingCommand: "linter:next",
      },
      {
        title: "Go to previous message",
        keyBindingExtra: "cmdorctrl+RMB",
        keyBindingCommand: "linter:previous",
      },
    ]);

    this.update();
  }

  destroy() {
    this.configDisposable.dispose();
    this.tooltipDisposable.dispose();
    this.element.remove();
  }

  setEditor(editor) {
    this.editor = editor;
  }

  _getMessages() {
    if (this.pkg.panel?.viewMode === "project") {
      return this.pkg.allMessages || [];
    }
    return this.pkg.getCurrentMessages();
  }

  update() {
    // Null-prototype so a severity literally named "constructor" cannot corrupt
    // the tally.
    const counts = Object.create(null);
    for (const { name } of SEVERITIES) {
      counts[name] = 0;
    }
    const lintingDisabled = this.pkg.isLintingDisabledForEditor(this.editor);
    for (const message of this._getMessages()) {
      if (counts[message.severity] !== undefined) counts[message.severity]++;
    }

    // Only the loud tiers keep the band open. A file whose sole diagnostics are
    // hints reads as clean, which is what turning statusMode off asks for.
    let loudCount = 0;
    for (const { severity, anchor, label } of this.tiles) {
      const count = counts[severity.name];
      anchor.classList.toggle(severity.textClass, Boolean(count) && !lintingDisabled);
      label.textContent = lintingDisabled && count === 0 ? "X" : count;
      // A quiet tile stays out of the way until one is reported, so a user with
      // no hint provider sees the same three tiles, and the same three "X", as
      // before.
      anchor.classList.toggle("linter-status-tile-hidden", severity.hideWhenZero && count === 0);
      if (!severity.hideWhenZero) loudCount += count;
    }

    this.element.classList.toggle("linting-disabled", lintingDisabled);
    this.element.classList.toggle("project-mode", this.pkg.panel?.viewMode === "project");
    this.element.classList.toggle(
      "linter-status-hidden",
      !this.statusMode && loudCount === 0 && !lintingDisabled,
    );
  }

  onmouseup(e) {
    if (e.which === 2 && e.ctrlKey) {
      // ctrl+middle click
      lumine.commands.dispatch(lumine.views.getView(lumine.workspace), "linter:clear");
    } else if (e.which === 3 && e.ctrlKey) {
      // ctrl+right click
      this.pkg.inspectPrevious();
    } else if (e.which === 1) {
      // left click
      this.pkg.togglePanel();
    } else if (e.which === 2) {
      // middle click
      const panel = this.pkg.panel;
      if (!panel) return;
      panel.setViewMode(panel.viewMode === "project" ? "file" : "project");
      this.update();
    } else if (e.which === 3) {
      // right click
      this.pkg.inspectNext();
    }
  }
}

module.exports = { StatusPanel };
