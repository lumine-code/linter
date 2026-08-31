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
| `name`          | string                  | Copied into each message's `linterName`, and shown wherever one is listed. Also the key a user disables the provider by.      |
| `scope`         | `"file"` \| `"project"` | Any other value is rejected. `"file"` scopes results to the linted buffer; `"project"` replaces the whole project result set. |
| `lintsOnChange` | boolean                 | Required even when `false`. `false` means the linter runs on open and save only.                                              |
| `grammarScopes` | string[]                | Matched against the scopes under the cursor. **`["*"]` matches every editor** — the scope list is always seeded with `"*"`.   |
| `lint`          | `(editor) => messages`  | Returns `Message[]`, `null`, `undefined`, or a `Promise` of those.                                                            |

A message. These four are required:

| Field               | Type                                             | Description                                                            |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| `severity`          | `"error"` \| `"warning"` \| `"info"` \| `"hint"` | Anything else is rejected. `"hint"` is the quiet tier.                 |
| `excerpt`           | string                                           | The one-line message text.                                             |
| `location.file`     | string                                           | Absolute path. May be replaced by `location.buffer` — see below.       |
| `location.position` | Range-compatible                                 | `[[row, column], [row, column]]` or a `Range`. Must not contain `NaN`. |

| Field             | Type         | Description                                                                                  |
| ----------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `location.buffer` | `TextBuffer` | The buffer the message is about, **instead of** `location.file` when the buffer has no path. |

A buffer that has never been saved has no path, so a message about one names the buffer. Exactly one of `file` and `buffer` is required; a location with neither is rejected. Everything works the same either way — markers, hover, code actions, `linter:next` — with two differences a UI listing it cannot avoid: it has no path to label the entry with, and navigating to it can only reveal it in an editor already showing that buffer rather than opening one. Once nothing is showing the buffer, there is nowhere to go, the same as for a file that has since been deleted.

And these are optional:

| Field         | Type                                        | Description                                                           |
| ------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| `tags`        | `("unnecessary" \| "deprecated")[]`         | Dims or strikes the marked range. Orthogonal to `severity`.           |
| `description` | string \| `() => string \| Promise<string>` | Long form, shown beside the excerpt. See below.                       |
| `solutions`   | array \| `Promise<array>`                   | Quick fixes. Also surfaced as code actions through `intentions.list`. |
| `reference`   | `{ file: string, position: Point }`         | A second location, such as a prior declaration. Also `NaN`-checked.   |
| `url`         | string                                      | A link to the rule's documentation, opened in the browser.            |
| `icon`        | string                                      | Icon name, for a UI that shows one per message.                       |
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

Only documents are linted: the pane items open in the workspace, plus any editor a package registered through [`linter.editors`](linter.editors.md). A package builds editors of its own to render a diff, a patch preview or a picker's input field with — they are real editors, most with no grammar and no path, and none of them reaches your `lint`. A buffer nobody has saved yet does: it is a pane item, it simply has no path. An item that is not itself an editor counts through the editor its [adapter](linter.adapter.md) names for it, so a notebook still reaches you.

`lint` is called per editor and raced against a 30-second timeout; a linter that overruns it has its result discarded.

Changing an editor's grammar immediately retracts every file-scoped provider result for that buffer, discards file results still running under the old grammar, and runs the providers matching the new grammar. This is structural rather than a text change, so it happens even when `lintsOnChange` or the global lint-on-change setting is false. A project-scoped snapshot remains intact when one editor stops matching; a project provider that matches the new grammar replaces it on its next run as usual.

Return `null` or `undefined` to leave the previous messages in place. Return `[]` to clear them.

Responses are ordered per provider and target buffer; a project-scoped provider has the whole project as its one target. A result that arrives after a newer request for the same target has started is dropped, so a slow run cannot overwrite a fresh one. Results for a buffer that has since been destroyed are dropped too.

A `"project"`-scoped linter's results replace the entire project message set on every run, so it must return everything it knows about each time.

Files are skipped before `lint` is called when they match the `linter.ignoreGlob` setting or when the editor is a preview tab and `linter.lintPreviewTabs` is off. A buffer with no path cannot match the glob and is linted. Repository ignore rules are discovery policy, so they never suppress a document the user explicitly opened. A user can also disable an individual provider by `name`, which skips it without unregistering it.

Message shape is validated on every run in dev mode, and always when the return value is not an array; in a release build a plausible array is trusted. Develop with `--dev` if you want the diagnostics.

The hub normalizes what you return **in place**: positions become `Range` and `Point` instances, `linterName` is filled in from `name`, `tags` is reduced to the known values in a fixed order (and dropped when none survive), and a stable key is attached. Do not assume the objects you returned stay untouched, and do not hand out shared or frozen objects.

`description` is the message's long form and is rendered as plain text: under the excerpt in the hover tooltip, and in the `GetLinterMessages` MCP tool. It is where a rule code (`Ruff: F401`) or a set of related locations belongs — the excerpt stays the one-line summary. The string form is shown as soon as the message arrives. The function form is called at most once per message, when a reader asks for the long form — the hover tooltip opening, a UI's "details" affordance — and its result is cached until the next lint run replaces the message; a function that throws costs the long form, not the message. Only the string form reaches the MCP tool, which never runs provider code.

The severity and tag vocabularies follow the LSP diagnostic model — `severity` mirrors `DiagnosticSeverity` (`error` 1, `warning` 2, `info` 3, `hint` 4) and `tags` mirrors `DiagnosticTag` — and both sets are open-ended. A consumer must supply its own default for a value it does not recognize rather than assume a fixed set of keys, and should treat an unknown severity as the lowest precedence.

If `lint` throws or rejects, the error is logged and raised as a notification, deduplicated per linter so one broken provider cannot flood the user.

## Failure modes

Unusually for this ecosystem, this service fails loudly once your object reaches the hub:

| Notification                              | Cause                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `[Linter] Invalid Linter received`        | A missing or mistyped field on the linter object. The detail lists each one.                 |
| `[Linter] Invalid Linter Result received` | A malformed message. Only the first instance of each distinct problem is reported per batch. |
| `[Linter] Error running <name>`           | `lint` threw or rejected.                                                                    |

Everything _before_ that point is still silent: a misspelled `linter.provider`, or a `provideLinter` that is not exported from your main module, produces nothing at all — your linter simply never arrives.

## Teardown

`consumeLinter` returns a `Disposable` that removes your linters and their messages, so a linter object needs no `dispose` method. To retract messages while staying registered, return `[]` from the next `lint`.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
