# linter.editors

Registers an editor that is not a pane item for linting, so a package's own editor — a commit box, a notebook's source editor — is checked and decorated like any open document.

|             |                                                             |
| ----------- | ----------------------------------------------------------- |
| Version     | `1.0.0`                                                     |
| Provided by | `provideLinterEditors()` returning `(editor) => Disposable` |
| Consumed by | any package with an editor of its own that is a document    |
| Owner       | [`linter`](https://github.com/lumine-code/linter)           |

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

| Function           | Returns      | Description                                                                |
| ------------------ | ------------ | -------------------------------------------------------------------------- |
| `register(editor)` | `Disposable` | Lints the `TextEditor` from now on. Dispose to stop and drop its messages. |

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

A registered editor behaves exactly like a pane item: providers whose `grammarScopes` match run on open, save and change, its messages appear in the panel and on its markers, and a buffer with no path is carried as [`location.buffer`](linter.provider.md). Registering an editor twice is a no-op, and registering one that is also a pane item changes nothing — it was already linted.

Register only an editor whose content a person writes. An editor rendering derived content — a diff, a preview — gains nothing from diagnostics, and keeping it out is the default this service exists to preserve.

## Teardown

Dispose the returned `Disposable` when the editor goes away or stops being a document; its messages are removed with it. An editor that is destroyed cleans up by itself, and disposing after that is allowed and does nothing.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
