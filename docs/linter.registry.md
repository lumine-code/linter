# linter.registry

A function that registers an "indie" linter: a package pushes messages into the linter panel whenever it likes, instead of waiting to be asked.

|             |                                                           |
| ----------- | --------------------------------------------------------- |
| Version     | `1.0.0`                                                   |
| Provided by | `provideLinterRegistry()` returning the register function |
| Consumed by | `consumeLinterRegistry(registerIndie)`                    |
| Owner       | [`linter`](https://github.com/lumine-code/linter)         |

Use this when you already have the diagnostics — a compiler you shell out to, a formatter, a language server — and only need somewhere to display them. When the panel should ask _you_ for messages about a specific editor, implement [`linter.provider`](linter.provider.md) instead.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "linter.registry": {
      "versions": { "^1.0.0": "consumeLinterRegistry" }
    }
  }
}
```

The service **is** a function, not an object with methods. Call it once per logical linter you want to appear in the panel; it returns a delegate you keep for the lifetime of your package.

## Contract

```ts
type RegisterIndie = (config: IndieConfig) => IndieDelegate;

type IndieConfig = {
  name: string;
  deleteOnOpen?: boolean;
  markerInvalidation?: "touch" | "never";
};
```

`name` is required and must be a string; anything else raises a notification and **throws**. `deleteOnOpen` defaults to `false`. `markerInvalidation` defaults to `"touch"`.

The delegate:

| Member                            | Description                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `name`                            | The name you registered.                                                                   |
| `setMessages(filePath, messages)` | Replaces the messages for one file. Every message's `location.file` must equal `filePath`. |
| `setAllMessages(messages)`        | Replaces everything this delegate has published, re-bucketed by `location.file`.           |
| `deleteFilePath(filePath)`        | Drops the messages for one file.                                                           |
| `clearMessages()`                 | Drops all of them.                                                                         |
| `getMessages()`                   | The delegate's current messages, flattened.                                                |
| `onDidUpdate(callback)`           | Fires after each of the mutators above.                                                    |
| `onDidDestroy(callback)`          | Fires when the delegate is disposed.                                                       |
| `dispose()`                       | Unregisters the delegate and clears its messages.                                          |

Messages take the same shape as for [`linter.provider`](linter.provider.md): `severity`, `excerpt`, and `location` with `file` and `position` are required; `tags`, `description`, `solutions`, `reference`, `url`, `icon`, and `linterName` are optional.

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumeLinterRegistry(registerIndie) {
    this.indie = registerIndie({ name: "my-tool" });
    return new Disposable(() => {
      this.indie.dispose();
      this.indie = null;
    });
  },

  publish(filePath, findings) {
    this.indie.setMessages(
      filePath,
      findings.map((finding) => ({
        severity: "error",
        excerpt: finding.message,
        location: { file: filePath, position: finding.range },
      })),
    );
  },
};
```

## Behavior

An indie delegate is always project-scoped: its messages persist until you replace or clear them, and nothing re-runs on save or on change. Keeping them in step with the buffer is your job.

Every call is committed immediately; marker invalidation does not add an update delay.

The default `"touch"` retires a message as soon as an edit touches its inline range. It suits classic linters that recompute after typing stops, preventing their previous result from remaining visible during that delay.

`"never"` is for a source that owns complete snapshots, such as a language server. Its markers track buffer edits without absorbing text inserted at their boundaries, and remain visible until a later snapshot replaces or clears them. Such a producer must publish an empty array when a file has no diagnostics and clear its messages when the producer stops.

`setMessages` throws if `filePath` is not a string or `messages` is not an array, and again if any message's `location.file` differs from `filePath` — the per-file bucket must be internally consistent. `setAllMessages` has no such constraint; it re-buckets by each message's own `location.file`.

Messages are validated on every `setMessages`, and on `setAllMessages` only in dev mode or when the argument is not an array. Invalid messages raise `[Linter] Invalid Linter Result received` and the call is dropped, leaving the previous set in place.

The delegate normalizes messages **in place**, so do not pass shared or frozen objects.

Calls on a disposed delegate are ignored rather than throwing, so a late callback after teardown is harmless.

## Teardown

Call `dispose()` on the delegate from the `Disposable` you return from `consumeLinterRegistry`. That removes its messages from the panel and fires `onDidDestroy`. Disposing the delegate does not clear your own reference — drop it yourself, as above.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
