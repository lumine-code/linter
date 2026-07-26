# linter.provider

A linter definition: which grammars it applies to, when it runs, and a `lint` function returning diagnostics for one file.

|             |                                                             |
| ----------- | ----------------------------------------------------------- |
| Version     | `1.0.0`                                                     |
| Provided by | `provideLinter()` returning one linter, or an array of them |
| Consumed by | `consumeLinter(linter)` returning a `Disposable`            |
| Owner       | [`linter`](https://github.com/lumine-code/linter)           |

If you already have the messages — a build tool's output, a type checker you run yourself — use [`linter.registry`](linter.registry.md) instead. It needs no grammar scopes and no `lint` function.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "linter.provider": {
      "versions": { "1.0.0": "provideLinter" }
    }
  }
}
```

`provideLinter` may return **a single linter or an array of them**. Returning an array is the supported way to ship several linters from one package; you do not need several `providedServices` entries.

## Contract

All five fields are required. A linter missing any of them is rejected with a dismissable notification and never runs.

| Field           | Type                    | Description                                                                                                                   |
| --------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `name`          | string                  | Shown in the panel and copied into each message's `linterName`. Also the key a user disables the provider by.                 |
| `scope`         | `"file"` \| `"project"` | Any other value is rejected. `"file"` scopes results to the linted buffer; `"project"` replaces the whole project result set. |
| `lintsOnChange` | boolean                 | Required even when `false`. `false` means the linter runs on open and save only.                                              |
| `grammarScopes` | string[]                | Matched against the scopes under the cursor. **`["*"]` matches every editor** — the scope list is always seeded with `"*"`.   |
| `lint`          | `(editor) => messages`  | Returns `Message[]`, `null`, `undefined`, or a `Promise` of those.                                                            |

A message. These four are required:

| Field               | Type                                 | Description                                                            |
| ------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `severity`          | `"error"` \| `"warning"` \| `"info"` | Anything else is rejected.                                             |
| `excerpt`           | string                               | The one-line message text.                                             |
| `location.file`     | string                               | Absolute path.                                                         |
| `location.position` | Range-compatible                     | `[[row, column], [row, column]]` or a `Range`. Must not contain `NaN`. |

And these are optional:

| Field         | Type                                        | Description                                                           |
| ------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| `description` | string \| `() => string \| Promise<string>` | Long form, resolved lazily when the message is expanded.              |
| `solutions`   | array \| `Promise<array>`                   | Quick fixes. Also surfaced as code actions through `intentions.list`. |
| `reference`   | `{ file: string, position: Point }`         | A second location, such as a prior declaration. Also `NaN`-checked.   |
| `url`         | string                                      | Opened by the panel as "more info".                                   |
| `icon`        | string                                      | Icon name for the panel row.                                          |
| `linterName`  | string                                      | Overrides `name` for this message.                                    |

## Minimal example

```js
module.exports = {
  provideLinter() {
    return {
      name: "my-linter",
      scope: "file",
      lintsOnChange: true,
      grammarScopes: ["source.js"],
      async lint(editor) {
        const filePath = editor.getPath();
        if (!filePath) return null;
        const findings = await runMyTool(filePath, editor.getText());
        return findings.map((finding) => ({
          severity: "warning",
          excerpt: finding.message,
          location: {
            file: filePath,
            position: [
              [finding.line, finding.column],
              [finding.line, finding.column + finding.length],
            ],
          },
        }));
      },
    };
  },
};
```

## Behavior

`lint` is called per editor and raced against a 30-second timeout; a linter that overruns it has its result discarded.

Return `null` or `undefined` to leave the previous messages in place. Return `[]` to clear them.

Responses are ordered. A result that arrives after a newer request for the same linter has already been answered is dropped, so a slow run cannot overwrite a fresh one. Results for a buffer that has since been destroyed are dropped too.

A `"project"`-scoped linter's results replace the entire project message set on every run, so it must return everything it knows about each time.

Files are skipped before `lint` is called when they match the `linter.ignoreGlob` setting, when `linter.ignoreVCS` is on and the repository ignores them, or when the editor is a preview tab and `linter.lintPreviewTabs` is off. A user can also disable an individual provider by `name`, which skips it without unregistering it.

Message shape is validated on every run in dev mode, and always when the return value is not an array; in a release build a plausible array is trusted. Develop with `--dev` if you want the diagnostics.

The panel normalizes what you return **in place**: positions become `Range` and `Point` instances, `linterName` is filled in from `name`, and a stable key is attached. Do not assume the objects you returned stay untouched, and do not hand out shared or frozen objects.

If `lint` throws or rejects, the error is logged and raised as a notification, deduplicated per linter so one broken provider cannot flood the user.

## Failure modes

Unusually for this ecosystem, this service fails loudly once your object reaches the hub:

| Notification                              | Cause                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `[Linter] Invalid Linter received`        | A missing or mistyped field on the linter object. The detail lists each one.                 |
| `[Linter] Invalid Linter Result received` | A malformed message. Only the first instance of each distinct problem is reported per batch. |
| `[Linter] Error running <name>`           | `lint` threw or rejected.                                                                    |

Everything _before_ that point is still silent: a misspelled `linter.provider`, or a `provideLinter` that is not exported from your main module, produces nothing at all. `npm run check:services` catches the second.

## Teardown

`consumeLinter` returns a `Disposable` that removes your linters and their messages, so a linter object needs no `dispose` method. To retract messages while staying registered, return `[]` from the next `lint`.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
