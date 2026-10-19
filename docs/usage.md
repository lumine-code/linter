# Linting guide

The linter package surfaces diagnostics — errors, warnings, info, and hints — from providers and language servers directly in the editor. See the [package README](../README.md) for installation and the command list. Providers such as `spell-check` and language adapters such as `ide-eslint` and `ide-ruff` report the problems; the `linter` package collects them and marks them in the editor. Language adapters also need `ide`. To read them all in one list, add `diagnostics`.

## Inline messages

Problems are underlined and marked in the gutter. Hints use a dotted underline without a gutter or overview marker; unnecessary code is dimmed and deprecated code struck through. Install [`documentation-view`](https://github.com/lumine-code/ide/blob/master/docs/code-intelligence.md#documentation-and-context-help) to read diagnostics in its persistent panel and add `hover` for pointer tooltips, or use `linter:inspect` at the cursor; `linter:next` and `linter:previous` step through the current file's messages. **Show Context Help** controls the diagnostic context-help integration for both surfaces.

Inline decorations are skipped for very large files to keep editing responsive — the **Large File Line Count** and **Long Line Length** settings control the thresholds. Every message is still reported.

## Controlling what gets linted

`marker:toggle-focus` opens the shared marker layer picker for the scrollbar map and minimap. Its linter layer switch changes only the overview markers: inline underlines and the diagnostic list remain available. A disabled layer releases its subscriptions and cached markers; enabling it rebuilds them from current diagnostics. Layer changes do not restart language servers.

`scrollmap:toggle` hides or shows the scrollbar marker strips independently of the shared layer switches and minimap visibility.

`linter:toggle-current-file` pauses the active file; `linter:toggle-linter` enables or disables providers. **Ignore files matching this Glob** excludes matching paths, and the core **Exclude VCS Ignored Paths** setting skips ignored files. Unsaved buffers can still be linted.

The provider list combines classic linters, project scans, and language servers. Language server providers appear as soon as their adapter is registered, even before it reports a problem. Disabling a provider immediately hides its messages throughout the linter while the server and its other IDE features continue running; enabling it restores the latest pushed diagnostics or runs a fresh classic lint. The list updates when providers are added or removed, and your choices persist between editor sessions. An adapter's own **Diagnostics** feature setting controls whether its diagnostics are presented; switching it preserves the running server and restores current cached reports when enabled.

By default files are linted when opened (**Lint on Open**) and as you type (**Lint on Change**, throttled by **Lint on Change Interval**); disable either to lint only on save. `linter:lint` lints the current file on demand, and `linter:debug` reports which providers apply to it.

## Providers

The `linter` package does not analyze code itself — it consumes the `linter.provider` service. Install one or more provider packages for the languages you work in, and their diagnostics appear automatically. Packages can also push messages directly through the `linter.registry` service, and non-text items such as Jupyter notebooks integrate through the `linter.adapter` service.

Providers receive open document editors, including unsaved buffers. Packages can register document editors embedded in another surface, such as a commit message or notebook source, through `linter.editors`.

Packages can consume [`linter.lint`](linter.lint.md) and await `lintEditor(editor, { signal })` or `lintBuffer(buffer, { signal })` for an explicit classic-linter pass. Each returns a structured `completed`, `skipped`, `cancelled` or `failed` outcome with per-provider publication, unchanged, cancellation and failure details; accepted results are available before completion. Inspect that outcome before treating a diagnostics read as a successful refresh. A named buffer without an open or registered editor is linted through a private editor with a read-only source and the selected grammar, preserving the caller's buffer and unsaved contents. Newer intent, changed input, cancellation and lifecycle changes retire obsolete work. Language servers and other providers that push diagnostics independently keep their own schedule.

Install `spell-check` to report misspellings through the linter and offer corrections through [autocomplete](https://github.com/lumine-code/autocomplete/blob/master/docs/usage.md) and code actions. Use **Checked Grammars**, **Excluded Scopes**, and **Severity** to control automatic checking. `spell-check:check-spelling` checks nonempty selections regardless of the scope settings; with no selection, it checks the whole file using its configured grammar scopes and exclusions.

`ide-ruff:lint-projects` and `ide-eslint:lint-projects` scan project files on demand, including files that are not open. Their `lint-selected` commands scan the files or folders selected in the tree view. Results appear in `linter` and `diagnostics`; opening a file preserves the scan's findings. These scans complement the adapters' live language-server diagnostics.

`ide-ruff` uses the same selected Ruff executable for its server and scans, including notebook files and safely projected `.ipy` documents. `ide-eslint` uses each project's ESLint and plugins, with bundled ESLint v8 for legacy configuration or v10 for flat configuration when no user-installed engine is available. Configuration Format defaults to automatic detection.
