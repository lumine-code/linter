# linter.lint

Await a lint pass for a text editor or a named buffer without opening a tab.

| Field       | Value                                   |
| ----------- | --------------------------------------- |
| Version     | `1.0.0`                                 |
| Provided by | `provideLint()` returning a lint handle |
| Consumed by | Packages requesting fresh diagnostics   |
| Owner       | `linter`                                |

## Registration

```json
{
  "consumedServices": {
    "linter.lint": {
      "versions": { "^1.0.0": "consumeLint" }
    }
  }
}
```

## Contract

```ts
interface Lint {
  lintEditor(editor: TextEditor): Promise<boolean>;
  lintBuffer(buffer: TextBuffer): Promise<boolean>;
}
```

Both methods await every matching classic linter provider, including providers that reject or time out. Accepted messages are published synchronously before the promise resolves. Indie providers, including language servers that publish on their own schedule, are not triggered or awaited.

`false` means the request was skipped: the package or target was destroyed, the buffer has no path for `lintBuffer`, linting is disabled for the buffer, the path matches the linter ignore glob, or the editor is a preview tab excluded by configuration. A completed pass returns `true` even when no provider matched or a provider failed; it does not promise that diagnostics were produced. A newer request supersedes an older request for the same provider and buffer.

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumeLint(lint) {
    this.lint = lint;
    return new Disposable(() => {
      if (this.lint === lint) this.lint = null;
    });
  },

  async refreshDiagnostics(editor) {
    return this.lint ? this.lint.lintEditor(editor) : false;
  },
};
```

## Behavior

`lintBuffer` reuses an open editor for the buffer when available. Otherwise it builds a private snapshot editor containing the text, path and grammar, waits for its language mode, and destroys it after the providers settle. It never opens a pane item, retains or destroys the caller's buffer, or writes its text to disk. File results and request ordering belong to the caller's original buffer. Results from a detached snapshot whose original buffer changed or was destroyed are discarded. Destroying the original buffer removes its file results.

## Teardown

A handle belongs to the package generation that provided it. After that generation deactivates, its methods return `false`; a stale handle cannot invoke a new generation. Consumers must dispose their service edge and stop using its handle.

## Versioning

`1.0.0` defines the two awaitable lint methods and their skip, snapshot and lifecycle behavior.
