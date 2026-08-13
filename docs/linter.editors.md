# linter.editors

Registers an editor that is not a pane item for linting, so a package's own editor — a commit box, a notebook's source editor — is checked and decorated like any open document.

|             |                                                                       |
| ----------- | --------------------------------------------------------------------- |
| Version     | `1.1.0`                                                               |
| Provided by | `provideLinterEditors()` returning `(editor, options?) => Disposable` |
| Consumed by | any package with an editor of its own that is a document              |
| Owner       | [`linter`](https://github.com/lumine-code/linter)                     |

On its own the linter only lints documents: the pane items open in the workspace. A package builds editors of its own to render a diff, a patch preview or a picker's input field with, and none of those wants diagnostics — but a few embedded editors hold something a person is writing, and those are documents in every sense but the pane. This service is how their owner says so.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "linter.editors": {
      "versions": { "^1.0.0": "consumeLinterEditors" }
    }
  }
}
```

## Contract

The consumed value is a single function.

| Function                     | Returns      | Description                                                                |
| ---------------------------- | ------------ | -------------------------------------------------------------------------- |
| `register(editor, options?)` | `Disposable` | Lints the `TextEditor` from now on. Dispose to stop and drop its messages. |

Options — all optional:

| Option | Type      | Default | Description                                                                                                                                                                                                         |
| ------ | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint` | `boolean` | `true`  | Run providers on this editor. `false` registers it for **rendering only**: its buffer gets the marker layers and answers hover, for an editor that displays messages an adapter projects onto it — a notebook cell. |

A destroyed editor, or a value that is not a `TextEditor`, is refused silently: the returned `Disposable` is inert.

## Minimal example

```js
module.exports = {
  consumeLinterEditors(register) {
    this.linterRegistration = register(this.commitEditor);
    return this.linterRegistration;
  },
};
```

## Behavior

A registered editor behaves exactly like a pane item: providers whose `grammarScopes` match run on open, save and change, its messages appear on its markers and in every registered UI, and a buffer with no path is carried as [`location.buffer`](linter.provider.md). Registering an editor twice is a no-op, and registering one that is also a pane item changes nothing — it was already linted.

With `lint: false` no provider ever runs on the editor and nothing new appears in the panel; the registration only makes the editor able to **show** messages. That is for an editor whose content is checked through another route — a notebook cell, whose diagnostics arrive against the notebook and are projected onto the cell by a [`linter.adapter`](linter.adapter.md). Without the registration those projections have nowhere to land, since only patched buffers carry marker layers. The decorations retire with the editor on their own, so in this mode the returned `Disposable` is inert.

Register only an editor whose content a person writes. An editor rendering derived content — a diff, a preview — gains nothing from diagnostics, and keeping it out is the default this service exists to preserve.

## Teardown

Dispose the returned `Disposable` when the editor goes away or stops being a document; its messages are removed with it. An editor that is destroyed cleans up by itself, and disposing after that is allowed and does nothing.

## Versioning

`1.1.0` provided. Consume `^1.0.0` for plain registration, `^1.1.0` when depending on `options` — an older provider would run providers on a render-only editor. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
