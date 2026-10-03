const { CompositeDisposable, Emitter } = require("lumine");

class ToggleView {
  constructor(providers) {
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.disabledProviders = [];
    this.providers = providers;
    this.selectListHost = lumine.workspace.addSelectList(
      {
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
            description: "Enable or disable messages from the selected provider.",
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
      },
      { className: "linter toggle-view", crumb: "Linters" },
    );
    this.selectList = this.selectListHost.getModel();
    this.subscriptions.add(
      this.emitter,
      this.selectListHost.onDidOpen(() => this.selectList.setItems(this.providers)),
      this.selectListHost.onDidCancel(() => this.dispose()),
      lumine.config.observe("linter.disabledProviders", (disabledProviders) => {
        this.disabledProviders = disabledProviders;
        this.selectList.setItems(this.providers);
      }),
    );
  }

  toggle(name) {
    const names = this.disabledProviders.includes(name)
      ? this.disabledProviders.filter((entry) => entry !== name)
      : [...this.disabledProviders, name];
    lumine.config.set("linter.disabledProviders", names);
  }

  toggleSelected(name) {
    this.toggle(name);
    return this.selectList.setItems(this.providers);
  }

  show() {
    this.selectListHost.show();
  }

  onDidDispose(callback) {
    return this.emitter.on("did-dispose", callback);
  }

  setProviders(providers) {
    this.providers = providers;
    return this.selectList.setItems(providers);
  }

  dispose() {
    if (this.subscriptions.disposed) return;
    this.emitter.emit("did-dispose");
    this.subscriptions.dispose();
    this.selectListHost.destroy();
  }
}

module.exports = ToggleView;
