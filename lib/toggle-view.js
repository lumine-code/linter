// The provider on/off list. Every provider the registry knows is one row whose
// icon says whether it is currently enabled; confirming flips it and leaves the
// list up, so a run of providers can be switched in one visit.
function showToggleView({ providers, onDisable, onFinish }) {
  let changed = false;

  const disabledProviders = () => atom.config.get("linter.disabledProviders");

  const toggleProvider = (name) => {
    const disabled = disabledProviders().slice();
    const index = disabled.indexOf(name);
    if (index === -1) {
      disabled.push(name);
      onDisable(name);
    } else {
      disabled.splice(index, 1);
    }
    changed = true;
    atom.config.set("linter.disabledProviders", disabled);
  };

  return atom.modals.toggle({
    id: "linter.providers",
    className: "linter toggle-view",
    emptyMessage: "No linter providers found",
    source: providers,
    renderer: {
      row: (name) => ({
        label: name,
        icon: [disabledProviders().includes(name) ? "icon-circle-slash" : "icon-check"],
      }),
    },
    confirm: ({ item }) => {
      // Enter on an empty list has nothing to flip.
      if (item == null) return { keepOpen: true };
      toggleProvider(item);
      // Re-running the source repaints the icons; the kernel puts the focus
      // back on the same provider by name.
      return { keepOpen: true, refresh: true };
    },
    // Linting is deferred to the close so a run of toggles costs one lint pass,
    // not one per provider. A view that is going away with the window or the
    // package has nothing left to lint through.
    didClose: (result) => {
      if (changed && result.reason !== "destroyed") onFinish();
    },
  });
}

module.exports = { showToggleView };
