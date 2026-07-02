class StatusPanel {
  constructor(pkg) {
    this.pkg = pkg;
    this.editor = null;
    this.statusMode = true;

    this.element = document.createElement("div");
    this.element.classList.add("linter-status", "inline-block");

    this.espan = document.createElement("a");
    this.eicon = document.createElement("span");
    this.eicon.classList.add("icon", "icon-stop");
    this.espan.appendChild(this.eicon);
    this.elabel = document.createElement("span");
    this.espan.appendChild(this.elabel);
    this.element.appendChild(this.espan);

    this.wspan = document.createElement("a");
    this.wicon = document.createElement("span");
    this.wicon.classList.add("icon", "icon-alert");
    this.wspan.appendChild(this.wicon);
    this.wlabel = document.createElement("span");
    this.wspan.appendChild(this.wlabel);
    this.element.appendChild(this.wspan);

    this.ispan = document.createElement("a");
    this.iicon = document.createElement("span");
    this.iicon.classList.add("icon", "icon-info");
    this.ispan.appendChild(this.iicon);
    this.ilabel = document.createElement("span");
    this.ispan.appendChild(this.ilabel);
    this.element.appendChild(this.ispan);

    this.element.onmouseup = (e) => this.onmouseup(e);
    this.element.oncontextmenu = (e) => e.preventDefault();

    this.configDisposable = atom.config.observe("linter-bundle.statusMode", (value) => {
      this.statusMode = value;
      this.update();
    });

    this.tooltipDisposable = atom.tooltips.add(this.element, {
      title:
        '<div style="text-align: left; line-height: 1.2em;">Click to toggle panel<br />Middle-click to toggle file/project view<br />Ctrl+middle-click to clear all<br />Right-click to go next<br />Ctrl+right-click to go previous<br />Use linter-bundle:toggle-current-file to enable or disable linting for this file</div>',
      html: true,
    });

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
    let ecount = 0;
    let wcount = 0;
    let icount = 0;
    const lintingDisabled = this.pkg.isLintingDisabledForEditor(this.editor);
    for (const message of this._getMessages()) {
      if (message.severity === "error") ecount++;
      else if (message.severity === "warning") wcount++;
      else if (message.severity === "info") icount++;
    }
    ecount && !lintingDisabled
      ? this.espan.classList.add("text-error")
      : this.espan.classList.remove("text-error");
    this.elabel.textContent = lintingDisabled && ecount === 0 ? "X" : ecount;
    wcount && !lintingDisabled
      ? this.wspan.classList.add("text-warning")
      : this.wspan.classList.remove("text-warning");
    this.wlabel.textContent = lintingDisabled && wcount === 0 ? "X" : wcount;
    icount && !lintingDisabled
      ? this.ispan.classList.add("text-info")
      : this.ispan.classList.remove("text-info");
    this.ilabel.textContent = lintingDisabled && icount === 0 ? "X" : icount;
    this.element.classList.toggle("linting-disabled", lintingDisabled);
    this.element.classList.toggle("project-mode", this.pkg.panel?.viewMode === "project");
    this.element.classList.toggle(
      "linter-status-hidden",
      !this.statusMode && ecount + wcount + icount === 0 && !lintingDisabled,
    );
  }

  onmouseup(e) {
    if (e.which === 2 && e.ctrlKey) {
      // ctrl+middle click
      atom.commands.dispatch(atom.views.getView(atom.workspace), "linter-bundle:clear");
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
