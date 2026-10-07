# linter.lint

Request a current classic-linter pass for an editor or named buffer and inspect its outcome.

| Field       | Value                                                |
| ----------- | ---------------------------------------------------- |
| Version     | `1.0.0`                                              |
| Provided by | `provideLinterLint()` returning a frozen lint handle |
| Consumed by | Packages requesting explicit classic-linter passes   |
| Owner       | `linter`                                             |

## Registration

```json
{
  "consumedServices": {
    "linter.lint": {
      "versions": { "^1.0.0": "consumeLinterLint" }
    }
  }
}
```

## Contract

```ts
interface LintOptions {
  signal?: AbortSignal;
}

interface ProviderOutcome {
  name: string;
  status: "published" | "unchanged" | "cancelled" | "failed";
  messageCount: number;
  reason?: string;
  error?: string;
}

interface LintOutcome {
  status: "completed" | "skipped" | "cancelled" | "failed";
  reason: string | null;
  providers: ProviderOutcome[];
  error?: string;
}

interface Lint {
  lintEditor(editor: TextEditor | null, options?: LintOptions): Promise<LintOutcome>;
  lintBuffer(buffer: TextBuffer | null, options?: LintOptions): Promise<LintOutcome>;
}
```

`null` or an omitted target returns `skipped` with reason `no-target`. A non-model target, malformed options or malformed signal rejects with `TypeError` before starting provider work. `lintEditor` accepts unsaved editors; `lintBuffer` requires a named buffer and returns `skipped` with reason `no-path` otherwise.

| Request status | Meaning                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `completed`    | The current pass settled without failed or cancelled providers. It may have no matching providers or only unchanged results.    |
| `skipped`      | No pass ran because its target was absent or excluded by the buffer-disabled, ignore-glob or preview-tab policy.                |
| `cancelled`    | The request or a provider run became obsolete, was aborted, or lost its target, registration or package generation.             |
| `failed`       | Preparation or grammar readiness failed, or at least one provider failed. Successful siblings may still have published results. |

| Provider status | Meaning                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `published`     | Valid results were accepted before completion. `messageCount` is the number published; zero means the provider cleared its previous results.                     |
| `unchanged`     | The provider returned `null` or `undefined`, retaining its previous diagnostics. `messageCount` is zero.                                                         |
| `cancelled`     | This run was discarded. `reason` identifies cancellation, supersession, removal or disabling; `messageCount` is zero.                                            |
| `failed`        | The provider threw, rejected, exceeded its deadline or returned invalid messages. `messageCount` is zero; `reason` and an optional `error` describe the failure. |

Accepted messages are published synchronously before the request promise resolves. Inspect the result before treating a following diagnostics read as a successful refresh. `completed` does not guarantee that any provider ran or supplied new messages, and unchanged or failed providers can leave previously known diagnostics in the registry. Partial results already accepted from valid siblings remain available when another provider fails or is cancelled. The `GetLinterMessages` MCP tool reads that known registry state without triggering a pass. Indie providers, including language servers publishing through `linter.registry`, keep their own schedule and are not triggered or awaited.

Request reasons include `no-target`, `no-path`, `disabled`, `ignored` and `preview` for skips; `aborted`, `superseded`, `changed`, `path-changed`, `encoding-changed`, `grammar-changed`, `snapshot-changed`, `destroyed`, `disposed` and provider cancellation reasons for cancellations; and `preparation-error`, `grammar-unavailable`, `grammar-timeout` or `provider-error` for failures. A mixture of provider cancellation reasons is reported as `provider-cancelled`. Provider reasons can also identify `timeout`, `invalid-messages` or `unregistered`. Treat an unfamiliar reason conservatively rather than assuming it indicates success.

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumeLinterLint(lint) {
    const edge = { lint, controllers: new Set() };
    this.lintEdge = edge;
    return new Disposable(() => {
      for (const controller of edge.controllers) controller.abort();
      if (this.lintEdge === edge) this.lintEdge = null;
    });
  },

  async refreshDiagnostics(editor) {
    const edge = this.lintEdge;
    if (!edge) return null;
    const controller = new AbortController();
    edge.controllers.add(controller);
    try {
      const result = await edge.lint.lintEditor(editor, { signal: controller.signal });
      if (result.status !== "completed") return result;
      // Accepted diagnostics are available now; unchanged providers retain
      // their last known messages, as recorded in result.providers.
      return result;
    } finally {
      edge.controllers.delete(controller);
    }
  },
};
```

## Behavior

`lintBuffer` reuses an open or explicitly registered editor for the buffer. Otherwise it builds a private editor from the captured text, path, encoding and grammar. A current registered non-fallback grammar is preserved; a missing, fallback or stale grammar is selected from the source path and contents. The pass waits for grammar readiness before matching classic providers. It does not open a pane item, increment the caller's buffer reference count, destroy that buffer, or read or write the source file on disk.

The private snapshot has a read-only file source whose path identifies the caller's source. Saving, reloading and retargeting that source are rejected. Providers must use the supplied editor's text for current contents; independently reading its path from disk can miss unsaved changes. A snapshot mutation cancels its request. File messages located by the private buffer are remapped to the original buffer before publication, retaining the caller's identity and lifecycle.

Requests are ordered when they arrive, before grammar preparation. A newer request for the same buffer supersedes the older intent even if preparation finishes out of order. Changes to the caller's text, path, encoding or grammar invalidate the pass. File provider ordering is per original buffer; project providers share their own latest-run ordering. Superseding a project provider does not cancel valid file-scoped siblings.

An optional caller signal cancels the request promptly, including during grammar preparation. Each provider receives a request-owned signal through its second `lint(editor, { signal })` argument. The hub discards late results even if a provider ignores cancellation; providers remain responsible for stopping their own external work. Grammar preparation and each provider have a 30-second deadline. Preparation timeout produces `failed`/`grammar-timeout`; provider timeout produces a failed provider outcome and aggregate `failed`/`provider-error`.

Diagnostics located only by buffer use that buffer's current path for file filtering and readout, including after a rename. An explicit provider `location.file` remains authoritative. The inferred path is never assigned to `location.file`, and diagnostics for unsaved editors keep their buffer identity without an invented filename.

Destroying the original buffer removes its file results.

## Teardown

A handle is tied to the package generation that provided it. Deactivation cancels pending requests and disposes their private editors, listeners and deadlines; a stale handle cannot invoke a new generation. A stale handle given a valid target returns `cancelled` with reason `disposed`. Provider-edge cleanup is bound to the original generation and cannot unregister a replacement from a later activation.

Consumption is passive. Consumers dispose their service edge, clear its retained handle and abort their outstanding requests. Cancellation leaves the caller's editor and buffer alive. Independent provider removal or disabling retires that provider's run and prevents its late results from being published.

## Versioning

`1.0.0` defines the two awaitable methods, structured request and provider outcomes, optional cancellation signal, private snapshot behavior and generation ownership.
