const { CompositeDisposable, Emitter } = require("atom");
const { SelectListView, highlightMatches, createTwoLineItem } = require("@lumine-code/select-list");

class ToggleView {
  constructor(providers) {
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.disabledProviders = [];
    this.providers = providers;
    this.changed = false;
    this.selectList = new SelectListView({
      className: "linter toggle-view",
      emptyMessage: "No linter providers found",
      willShow: () => {
        this.selectList.update({ items: this.providers });
      },
      elementForItem: (item, { filterKey, matchIndices }) => {
        const isDisabled = this.disabledProviders.includes(item);
        return createTwoLineItem({
          primary: highlightMatches(filterKey, matchIndices),
          icon: isDisabled ? ["icon-circle-slash"] : ["icon-check"],
        });
      },
      didConfirmSelection: (item) => {
        const index = this.selectList.selectionIndex;
        this.toggle(item);
        this.selectList.update({ items: this.providers });
        this.selectList.selectIndex(index);
      },
      didCancelSelection: () => {
        this.selectList.hide();
        if (this.changed) {
          this.emitter.emit("did-finish");
        }
      },
    });
    this.subscriptions.add(
      this.emitter,
      atom.config.observe("linter.disabledProviders", (disabledProviders) => {
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
    atom.config.set("linter.disabledProviders", this.disabledProviders);
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
