# linter.ui

A second place to display diagnostics. The linter hands every message change to each registered UI, alongside its own panel.

|             |                                                      |
| ----------- | ---------------------------------------------------- |
| Version     | `1.0.0`                                              |
| Provided by | `provideLinterUI()` returning one UI object          |
| Consumed by | `consumeLinterUI(provider)` returning a `Disposable` |
| Owner       | [`linter`](https://github.com/lumine-code/linter)    |

This is the service a scrollbar overview, a gutter decorator, or a status indicator implements. It does not replace the built-in panel; it runs beside it.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "linter.ui": {
      "versions": { "1.0.0": "provideLinterUI" }
    }
  }
}
```

## Contract

All five members are required. A UI missing any of them is rejected with a dismissable notification and never receives anything.

| Member                                           | Type     | Description                                                                                       |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `name`                                           | string   | Identifies the UI in error notifications.                                                         |
| `render({ added, removed, messages })`           | function | The message set changed. `messages` is the full current set; `added` and `removed` are the delta. |
| `didBeginLinting({ linter, filePath, number })`  | function | A provider started a run. `filePath` is `null` for a project-scoped linter.                       |
| `didFinishLinting({ linter, filePath, number })` | function | That run finished, whether it produced messages, failed, or timed out.                            |
| `dispose()`                                      | function | Release everything. Called for you — see Teardown.                                                |

## Minimal example

```js
module.exports = {
  provideLinterUI() {
    return {
      name: "my-ui",
      render({ messages }) {
        this.decorate(messages);
      },
      didBeginLinting({ linter }) {
        this.busy(linter.name, true);
      },
      didFinishLinting({ linter }) {
        this.busy(linter.name, false);
      },
      dispose() {
        this.clear();
      },
    };
  },
};
```

## Behavior

`render` receives the whole current message set on every change, not just the delta, so a UI that rebuilds from scratch can ignore `added` and `removed` entirely. Use them only if rebuilding is expensive.

Messages reaching a UI have already been normalized: `location.position` is a `Range`, `reference.position` is a `Point`, and `linterName` is filled in. They are the same objects the panel holds, so treat them as read-only.

`didBeginLinting` and `didFinishLinting` are paired per run and carry a `number` that increments per provider, so a UI showing progress can ignore a `didFinishLinting` whose `number` is stale. `didFinishLinting` always fires, including when the provider threw or timed out.

Nothing is validated after registration: if `render` throws, the exception surfaces in the developer console and other UIs still run.

## Teardown

`consumeLinterUI` returns a `Disposable` that calls your `dispose()` and then unregisters you, so you do not need to return a `Disposable` of your own from `provideLinterUI`. Everything a UI allocates must be released in `dispose()`.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
