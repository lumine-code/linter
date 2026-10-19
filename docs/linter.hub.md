# linter.hub

Read and act on diagnostics through one generation-bound handle, including whichever project views the user enables.

|             |                                                   |
| ----------- | ------------------------------------------------- |
| Version     | `1.0.0`                                           |
| Provided by | `provideLinterHub()` returning one frozen handle  |
| Consumed by | `consumeLinterHub(hub)` returning a `Disposable`  |
| Owner       | [`linter`](https://github.com/lumine-code/linter) |

## Registration

```json
{
  "consumedServices": {
    "linter.hub": {
      "versions": { "^1.0.0": "consumeLinterHub" }
    }
  }
}
```

## Contract

Every method is required. The handle is also supplied to each [`linter.ui`](linter.ui.md) provider's `attach(hub)` callback.

| Member                                    | Returns                 | Description                                                                                                                                                     |
| ----------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getMessages()`                           | `Message[]`             | The whole current set.                                                                                                                                          |
| `getCurrentMessages()`                    | `Message[]`             | Diagnostics belonging to the active center document, adapters included.                                                                                         |
| `getCursorEditor()`                       | `TextEditor \| null`    | The active center editor, or `null` for an adapter's item.                                                                                                      |
| `getMessagesAtPosition(editor, position)` | `Message[]`             | Diagnostics covering a buffer position, using live markers. Projected locations return their registry-owned messages.                                           |
| `getSeverities()`                         | `Severity[]`            | The severity model, most severe first.                                                                                                                          |
| `revealMessage(message)`                  | —                       | Reveal and focus a message through the adapter owning its item.                                                                                                 |
| `deleteMessages(messages)`                | —                       | Remove those messages from the registry.                                                                                                                        |
| `nextMessage()`                           | —                       | Navigate to the next diagnostic in the active center document or adapter.                                                                                       |
| `previousMessage()`                       | —                       | Navigate to the previous diagnostic in the active center document or adapter.                                                                                   |
| `clearMessages()`                         | —                       | Clear every message in the current registry, including indie delegates.                                                                                         |
| `canShowProjectView()`                    | `boolean`               | Whether a registered UI offers a project view. Synchronous, with no side effects.                                                                               |
| `showProjectView()`                       | `boolean`               | Ask every registered UI offering a project view to reveal it. Returns whether a callback was invoked successfully; an asynchronous reveal may still be pending. |
| `isLintingDisabled(editor)`               | `boolean`               | Whether linting is disabled for that editor's buffer.                                                                                                           |
| `normalizePath(filePath)`                 | `string \| null`        | Normalize a path to the spelling used by `location.normalizedFile`.                                                                                             |
| `getDescription(message)`                 | `string \| null`        | The resolved long form, or `null` while a lazy one has not been requested.                                                                                      |
| `hasLazyDescription(message)`             | `boolean`               | Whether there is a long form still to fetch.                                                                                                                    |
| `resolveDescription(message)`             | `Promise<string\|null>` | Fetch the long form, memoized across UIs.                                                                                                                       |

One frozen object is shared by every consumer in the provider's current window and activation. Each severity record carries `name`, `label`, `rank` (0 is most severe), `lsp`, `icon`, `textClass`, `gutterDot` and `hideWhenZero`. The list is open-ended; give an unrecognized severity the lowest precedence.

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumeLinterHub(hub) {
    this.hub = hub;
    return new Disposable(() => {
      if (this.hub === hub) this.hub = null;
    });
  },
  showProblems() {
    if (this.hub?.canShowProjectView()) this.hub.showProjectView();
  },
};
```

## Behavior

The handle never activates or selects a particular UI package. A project view request goes to every ready UI implementing `showProjectView()`; marker-only UIs do not handle it. Implementations reveal their project view idempotently, so requesting it twice keeps it open. A UI failure is reported in the developer console without preventing other UIs from receiving the request.

Register a command's `isAvailable` predicate using `canShowProjectView()` when the command requires a project view. UI registrations and removals invalidate command availability. The command's handler must still check availability because a UI may disappear between presentation and execution.

## Teardown

Return a `Disposable` from the consumption callback that removes the reference to that handle. After the provider deactivates, message reads return empty results, navigation and mutation calls return `false`, and project views are unavailable. A retained handle cannot affect a later activation.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
