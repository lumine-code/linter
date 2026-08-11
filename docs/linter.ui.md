# linter.ui

A place to display diagnostics. The linter hands every message change to each registered UI, and hands each one a way to ask it questions.

|             |                                                      |
| ----------- | ---------------------------------------------------- |
| Version     | `1.0.0`                                              |
| Provided by | `provideLinterUI()` returning one UI object          |
| Consumed by | `consumeLinterUI(provider)` returning a `Disposable` |
| Owner       | [`linter`](https://github.com/lumine-code/linter)    |

This is the service a panel, a scrollbar overview, a gutter decorator or a status indicator implements. The linter draws inline markers and answers hovers itself; everything else a reader sees is a UI.

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

Only `name` is required. Implement the members you have a use for and leave the rest out — a scrollbar overview wants `render` and nothing else.

| Member                                           | Required | Description                                                                                       |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `name`                                           | yes      | Identifies the UI in error notifications.                                                         |
| `attach(hub)`                                    | no       | Called once at registration, before the first `render`, with the handle described below.          |
| `render({ added, removed, messages })`           | no       | The message set changed. `messages` is the full current set; `added` and `removed` are the delta. |
| `didBeginLinting({ linter, filePath, number })`  | no       | A provider started a run. `filePath` is `null` for a project-scoped linter.                       |
| `didFinishLinting({ linter, filePath, number })` | no       | That run finished, whether it produced messages, failed, or timed out.                            |
| `didChangeLintingState()`                        | no       | Linting was turned on or off for a buffer. No message changed, so nothing else says so.           |
| `dispose()`                                      | no       | Release everything. Called for you — see Teardown.                                                |
| `showProjectView()`                              | no       | A provider asked for the project's messages to be brought up. Honour it if you have such a view.  |

A member that is present but is not a function is a registration error: the UI is rejected with a dismissable notification and never receives anything.

### The hub handle

What `attach` receives. Each member answers something a message change cannot.

| Member                        | Returns                 | Description                                                                                  |
| ----------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `getMessages()`               | `Message[]`             | The whole current set, for a UI registering into a window that has been linting for a while. |
| `getCurrentMessages()`        | `Message[]`             | Which of them belong to the active pane item, adapters included.                             |
| `getCursorEditor()`           | `TextEditor \| null`    | The editor whose cursor marks a current position; `null` when the active item is not one.    |
| `getSeverities()`             | `Severity[]`            | The severity model, most severe first. See below.                                            |
| `revealMessage(message)`      | —                       | Scroll to a message and focus it, through whatever adapter owns its item.                    |
| `deleteMessages(messages)`    | —                       | Remove them from the registry.                                                               |
| `isLintingDisabled(editor)`   | `boolean`               | Whether the user turned linting off for that editor's buffer.                                |
| `normalizePath(filePath)`     | `string \| null`        | The spelling `location.normalizedFile` is in. Compare paths with it, never with `===`.       |
| `getDescription(message)`     | `string \| null`        | The resolved long form, or `null` while a lazy one has not been asked for.                   |
| `hasLazyDescription(message)` | `boolean`               | Whether there is a long form still to fetch.                                                 |
| `resolveDescription(message)` | `Promise<string\|null>` | Fetches it. Memoized, so a provider's function runs once however many UIs ask.               |

One frozen object, the same for every UI.

Each severity record carries `name`, `label`, `rank` (0 is most severe), `lsp`, `icon`, `textClass`, `gutterDot` and `hideWhenZero`. The list is open-ended, so read it rather than assuming four tiers, and give an unrecognized severity the lowest precedence.

## Minimal example

```js
module.exports = {
  provideLinterUI() {
    return {
      name: "my-overview",
      render({ messages }) {
        this.decorate(messages);
      },
    };
  },
};
```

## Behavior

`render` receives the whole current message set on every change, not just the delta, so a UI that rebuilds from scratch can ignore `added` and `removed`. Use them only if rebuilding is expensive.

Messages reaching a UI have already been normalized: `location.position` is a `Range`, `reference.position` is a `Point`, `linterName` is filled in, and `tags`, when present, holds only known values in a fixed order. Two fields are the hub's own bookkeeping but are contract all the same — `key` identifies a message across publishes, and `location.normalizedFile` is the spelling of its path that comparisons use, because a provider and a buffer rarely write the same file the same way. They are the same objects every UI holds, so treat them as read-only.

`didBeginLinting` and `didFinishLinting` are paired per run and carry a `number` that increments per provider, so a UI showing progress can ignore a `didFinishLinting` whose `number` is stale. `didFinishLinting` always fires, including when the provider threw or timed out.

Nothing is validated after registration: if `render` throws, the exception surfaces in the developer console and other UIs still run.

## Teardown

`consumeLinterUI` returns a `Disposable` that calls your `dispose()` and then unregisters you, so you do not need to return a `Disposable` of your own from `provideLinterUI`. Everything a UI allocates must be released in `dispose()`. The handle is dead afterwards; stop calling it.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
