# linter

Linting infrastructure with inline markers and hovers.

Fork of [linter](https://github.com/steelbrain/linter) and [linter-ui-default](https://github.com/steelbrain/linter-ui-default). The panel and the status-bar tile live in [linter-panel](https://github.com/lumine-code/linter-panel).

## Features

- **The hub**: collects diagnostics from every linter provider, from packages that push their own, and from language servers, and holds one message set for the project.
- **Editor highlighting**: underline and gutter decorations for linted ranges, on two independent axes — severity, and the LSP tags a message carries.
- **Hover messages**: shows the messages under the pointer, or the whole line's when the pointer rests on the gutter dot, through the `hover` package's tooltip.
- **Quick fixes**: exposes the solutions a message carries as code actions at the cursor.
- **Linter management**: enable or disable individual linter providers, or linting for one file.
- **Jupyter notebook support**: works with `.ipynb` files through the `linter.adapter` service, mapping messages to individual cells.
- **Any number of front ends**: hands every message change, and a handle to ask about them, to each `linter.ui` package — the panel, a scrollbar overview, a status indicator.
- **MCP tool**: provides a read-only `GetLinterMessages` tool through the `mcp.tools` service.

## Installation

To install `linter` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/linter`.

## Commands

Commands available in `lumine-workspace`:

- `linter:toggle-linter`: toggle a linter provider on/off,
- `linter:toggle-current-file`: toggle linting for the current file,
- `linter:lint`: manually trigger linting on the current file,
- `linter:debug`: show debug information about active linters,
- `linter:state`: toggle linting for the current file (legacy alias),
- `linter:inspect`: show the message bubble at the cursor position,
- `linter:next`: jump to the next linter message,
- `linter:previous`: jump to the previous linter message,
- `linter:clear`: clear linter messages for the current editor.

## Customization

Override the package custom properties in your `styles.css`, or restyle the decorations directly:

```css
:root {
  --linter-dot-size: 6px;
  --linter-unnecessary-opacity: 0.4;
}

.linter-text {
  &.error,
  &.warning,
  &.info,
  &.hint {
    text-decoration-style: solid;
  }
}
```

Hints get no gutter dot by default, since they are meant to stay quiet. Add one:

```css
.linter-line-number.hint:not(.info):not(.warning):not(.error) {
  background-image: radial-gradient(
    circle,
    var(--text-color-hint) calc(var(--linter-dot-size) / 2),
    transparent calc(var(--linter-dot-size) / 2)
  );
}
```

## Services

- [`linter.registry`](docs/linter.registry.md): provided to let packages push messages directly without implementing a full linter provider.
- [`linter.editors`](docs/linter.editors.md): provided to let a package register an editor of its own — a commit box, a notebook's source editor — for linting; only pane items are linted on their own.
- `intentions.list`: provided to expose message solutions as quick-fix code actions at the cursor.
- `mcp.tools`: provided to expose `GetLinterMessages`, a read-only diagnostics tool, to a connected MCP host.
- `hover.provider`: provided to show the messages under the pointer in the `hover` package's tooltip, ahead of any documentation source.
- [`linter.provider`](docs/linter.provider.md): consumed to collect diagnostics from linter providers such as `linter-eslint` or `linter-ruff`.
- [`linter.ui`](docs/linter.ui.md): consumed to hand messages, and a handle to ask about them, to whatever displays them — the `linter-panel` package, a scrollbar overview.
- [`linter.adapter`](docs/linter.adapter.md): consumed to let non-`TextEditor` pane items, such as Jupyter notebooks, take part in linting.

## Usage

### The `GetLinterMessages` MCP tool

`linter` publishes one tool through `mcp.tools`, so a connected MCP host can read the diagnostics it holds. It is read-only.

With no arguments the tool returns the messages of the active editor (`mode` is `file`). Pass `scope: "project"` for every message the project holds.

The tool also accepts optional filters. When any of them is provided, the result is scoped from all known messages across the project whatever the scope says (`mode` is `filter`). This lets callers target a file that is not the focused tab, or even a file that was never opened:

- `filePath`: only messages for this file. Matching mirrors the filesystem: on Windows it is case-insensitive and treats `/` and `\` as equal, on POSIX it is exact.
- `severity`: only messages with this severity (`error`, `warning`, `info` or `hint`).
- `linterName`: only messages produced by this linter provider.

Filters combine with AND, e.g. `{ filePath, severity: "error" }` returns only the errors for that file.

Returned data has the shape:

```json
{
  "mode": "file",
  "path": "/path/to/current/file.js",
  "messages": [
    {
      "severity": "warning",
      "tags": null,
      "excerpt": "Warning message",
      "linterName": "my-linter",
      "file": "/path/to/current/file.js",
      "range": {
        "start": { "row": 0, "column": 0 },
        "end": { "row": 0, "column": 1 }
      },
      "url": null
    }
  ]
}
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
