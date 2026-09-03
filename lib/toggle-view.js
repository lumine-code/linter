const { CompositeDisposable, Emitter } = require("lumine");

class ToggleView {
  constructor(providers) {
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.disabledProviders = [];
    this.providers = providers;
    this.changed = false;
    this.selectList = lumine.workspace.buildSelectList({
      className: "linter toggle-view",
      crumb: "Linters",
      emptyMessage: "No linter providers found",
      items: this.providers,
      search: { getFilterText: (item) => item },
      renderItem: (item, { filterKey, highlight }) => {
        const isDisabled = this.disabledProviders.includes(item);
        return {
          primary: highlight(filterKey),
          icon: isDisabled ? ["icon-circle-slash"] : ["icon-check"],
        };
      },
      commands: {
        "linter:toggle-selected-provider": {
          description: "Enable or disable the selected linter provider.",
          didDispatch: (event) => this.toggleSelected(event.detail.item),
        },
      },
      actions: [
        {
          command: "linter:toggle-selected-provider",
          context: "item",
          primary: true,
          disposition: "stay",
        },
      ],
    });
    this.subscriptions.add(
      this.emitter,
      this.selectList.onDidOpen(() => this.selectList.setItems(this.providers)),
      this.selectList.onDidCancel(() => {
        if (this.changed) this.emitter.emit("did-finish");
      }),
      lumine.config.observe("linter.disabledProviders", (disabledProviders) => {
        this.disabledProviders = disabledProviders;
      }),
    );
  }

  toggle(name) {
    const index = this.disabledProviders.indexOf(name);
    if (index === -1) {
      this.disabledProviders.push(name);
      this.emitter.emit("did-disable", name);
    } else {
      this.disabledProviders.splice(index, 1);
    }
    this.changed = true;
    lumine.config.set("linter.disabledProviders", this.disabledProviders);
  }

  toggleSelected(name) {
    this.toggle(name);
    return this.selectList.setItems(this.providers);
  }

  show() {
    this.selectList.show();
  }

  onDidDispose(callback) {
    return this.emitter.on("did-dispose", callback);
  }

  onDidDisable(callback) {
    return this.emitter.on("did-disable", callback);
  }

  onDidFinish(callback) {
    return this.emitter.on("did-finish", callback);
  }

  dispose() {
    this.emitter.emit("did-dispose");
    this.subscriptions.dispose();
    this.selectList.destroy();
  }
}

module.exports = ToggleView;
