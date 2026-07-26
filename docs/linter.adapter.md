# linter.adapter

Teaches the linter about a pane item that is not a `TextEditor`, so a notebook or a custom editor can be linted and navigated like a file.

|             |                                                          |
| ----------- | -------------------------------------------------------- |
| Version     | `1.0.0`                                                  |
| Provided by | `provideLinterAdapter()` returning one adapter           |
| Consumed by | `consumeLinterAdapter(adapter)` returning a `Disposable` |
| Owner       | [`linter`](https://github.com/lumine-code/linter)        |

The linter is built around `TextEditor`: it reads a grammar and a path to decide which providers to run, and it moves a cursor to reveal a message. An adapter supplies both for an item that has neither — pointing at a backing editor for the first, and handling navigation itself for the second.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "linter.adapter": {
      "versions": { "1.0.0": "provideLinterAdapter" }
    }
  }
}
```

## Contract

Every member is a function, and all of them are called. There is no validator for this service, so a missing member surfaces as a `TypeError` at the moment the linter first needs it rather than at registration.

| Member                                  | Returns                | Description                                                                                    |
| --------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `handlesItem(item)`                     | boolean                | Whether this adapter owns the pane item. Asked first, for every adapter, on every pane change. |
| `getTextEditorForItem(item)`            | `TextEditor`           | The editor the linter should treat as the item's source, for grammar and path detection.       |
| `getMessagesForItem(item, allMessages)` | `Message[]`            | Narrows the full message set to the ones belonging to this item.                               |
| `getCurrentMessage(item, messages)`     | `Message \| undefined` | The message at the item's current position, for the panel's "current line" mode.               |
| `getNextMessage(item, messages)`        | `Message \| undefined` | The next message after the current position, for `linter:next-error`.                          |
| `getPreviousMessage(item, messages)`    | `Message \| undefined` | The previous one, for `linter:previous-error`.                                                 |
| `revealMessage(item, message)`          | —                      | Scroll and focus the item so the message is visible.                                           |

## Minimal example

```js
module.exports = {
  provideLinterAdapter() {
    return {
      handlesItem: (item) => item instanceof MyNotebookEditor,
      getTextEditorForItem: (item) => item.getSourceEditor(),
      getMessagesForItem: (item, allMessages) =>
        allMessages.filter((message) => message.location?.file === item.getPath()),
      getCurrentMessage: (item, messages) => item.messageAtCursor(messages),
      getNextMessage: (item, messages) => item.messageAfterCursor(messages),
      getPreviousMessage: (item, messages) => item.messageBeforeCursor(messages),
      revealMessage: (item, message) => item.reveal(message.location.position),
    };
  },
};
```

## Behavior

An adapter is registered with both halves of the package: the registry, which decides what to lint, and the panel, which decides what to show. Both consult `handlesItem` before anything else, so an adapter that answers `false` costs nothing.

The editor returned by `getTextEditorForItem` is what providers receive as their `lint(editor)` argument, so its path and grammar determine which providers run at all. It does not have to be attached to a pane — a backing buffer the item keeps for its own purposes is the usual answer.

`getMessagesForItem` is called with every message the linter holds, project-wide. Filtering on `location.file` is the common case, but an item that maps several files, or a slice of one, is free to do something else.

Adapters are consulted in registration order and the first one whose `handlesItem` returns `true` wins.

## Teardown

`consumeLinterAdapter` returns a `Disposable` that unregisters the adapter from both halves. Nothing else is released for you: if the adapter holds a backing editor, dispose it yourself.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
