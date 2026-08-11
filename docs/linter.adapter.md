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

Every required member is a function, and all required members are called. There is no validator for this service, so a missing required member surfaces as a `TypeError` at the moment the linter first needs it rather than at registration.

| Member                                  | Returns                            | Description                                                                                          |
| --------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `handlesItem(item)`                     | boolean                            | Whether this adapter owns the pane item. Asked first, for every adapter, on every pane change.       |
| `getTextEditorForItem(item)`            | `TextEditor`                       | The editor the linter should treat as the item's source, for grammar and path detection.             |
| `getMessagesForItem(item, allMessages)` | `Message[]`                        | Narrows the full message set to the ones belonging to this item.                                     |
| `getMarkerLocationsForMessage(message)` | `Partial<Location>[] \| undefined` | Optional. Projects one diagnostic onto concrete buffers used for inline markers and hover.           |
| `getCurrentMessage(item, messages)`     | `Message \| undefined`             | The message at the item's current position, for `linter:inspect` and for a UI marking a current row. |
| `getNextMessage(item, messages)`        | `Message \| undefined`             | The next message after the current position, for `linter:next`.                                      |
| `getPreviousMessage(item, messages)`    | `Message \| undefined`             | The previous one, for `linter:previous`.                                                             |
| `revealMessage(item, message)`          | —                                  | Scroll and focus the item so the message is visible.                                                 |

## Minimal example

```js
module.exports = {
  provideLinterAdapter() {
    return {
      handlesItem: (item) => item instanceof MyNotebookEditor,
      getTextEditorForItem: (item) => item.getSourceEditor(),
      getMessagesForItem: (item, allMessages) =>
        allMessages.filter((message) => message.location?.file === item.getPath()),
      getMarkerLocationsForMessage: (message) => markerLocationsForMessage(message),
      getCurrentMessage: (item, messages) => item.messageAtCursor(messages),
      getNextMessage: (item, messages) => item.messageAfterCursor(messages),
      getPreviousMessage: (item, messages) => item.messageBeforeCursor(messages),
      revealMessage: (item, message) => item.reveal(message.location.position),
    };
  },
};
```

## Behavior

An adapter is registered with both halves of the hub: the registry, which decides what to lint, and the marker and navigation side, which decides what is shown where. Both consult `handlesItem` before anything else, so an adapter that answers `false` costs nothing. A UI reaches the same answers through the handle it is given — `getCurrentMessages`, `revealMessage` — so it never has to know an adapter exists.

The editor returned by `getTextEditorForItem` is what providers receive as their `lint(editor)` argument, so its path and grammar determine which providers run at all. It does not have to be attached to a pane — a backing buffer the item keeps for its own purposes is the usual answer.

`getMessagesForItem` is called with every message the linter holds, project-wide. Filtering on `location.file` is the common case, but an item that maps several files, or a slice of one, is free to do something else.

`getMarkerLocationsForMessage` is optional and does not alter the message the registry holds. Return `undefined` when the adapter does not own the diagnostic, an empty array when it owns the diagnostic but no inline target is currently visible, or one location per target buffer. Returning multiple locations renders the same diagnostic in split views without duplicating it in the registry, so a UI still lists it once. The first adapter to return a value other than `undefined` or `null` owns marker projection for that diagnostic.

Adapters are consulted in registration order and the first one whose `handlesItem` returns `true` wins.

## Teardown

`consumeLinterAdapter` returns a `Disposable` that unregisters the adapter from both halves. Nothing else is released for you: if the adapter holds a backing editor, dispose it yourself.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
