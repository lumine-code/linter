# linter

Linting infrastructure with an integrated UI.

Fork of [linter](https://github.com/steelbrain/linter) and [linter-ui-default](https://github.com/steelbrain/linter-ui-default).

## Features

- **Unified package**: combines linter core functionality with UI in a single package.
- **Status bar integration**: shows error, warning, and info counts in the status bar, with mouse shortcuts for toggling the panel and stepping through messages.
- **Linter panel**: sortable table view of all linter messages with filtering, and keyboard navigation when focused.
- **Inline bubbles**: hover-style message display at the cursor position.
- **Editor highlighting**: underline and gutter decorations for linted ranges.
- **Multiple sort methods**: sort by severity, position, or provider. Cell index is used as a primary sort key for notebook messages.
- **Linter management**: enable or disable individual linter providers.
- **Jupyter notebook support**: works with `.ipynb` files through the `linter.adapter` service. Messages are mapped to individual cells and the panel shows `[cell]:line:col` position.
- **Scrollmap markers**: exposes linter markers to scrollbar-overview packages through the `linter.ui` service.
- **Reference links**: clickable references in messages open related files.
- **Markdown rendering**: message excerpts support markdown formatting in tooltips and the panel.
- **MCP tool**: provides a read-only `GetLinterMessages` tool through the `mcp.tools` service.

## Installation

To install `linter` search for _linter_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/linter`.

## Commands

Commands available in `atom-workspace`:

- `linter:toggle-focus`: focus the panel (or return focus to the editor if already focused), opening the panel if needed,
- `linter:toggle-panel`: toggle the linter panel visibility,
- `linter:toggle-linter`: toggle a linter provider on/off,
- `linter:toggle-current-file`: toggle linting for the current file,
- `linter:file-mode`: show only the messages of the active editor in the panel,
- `linter:project-mode`: show the messages of the whole project in the panel,
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
}

.linter-text {
  &.error,
  &.warning,
  &.info {
    text-decoration-style: solid;
  }
}
```

## Services

- **[linter.registry](docs/linter.registry.md)** (`1.0.0`): provided to let packages push messages directly without implementing a full linter provider.
- **[intentions.list](https://lumine-code.github.io/docs.html#services/intentions.list)** (`1.0.0`): provided to expose message solutions as quick-fix code actions at the cursor.
- **[mcp.tools](https://lumine-code.github.io/docs.html#services/mcp.tools)** (`1.0.0`): provided to expose `GetLinterMessages`, a read-only diagnostics tool, to a connected MCP host.
- **[linter.provider](docs/linter.provider.md)** (`^1.0.0`): consumed to collect diagnostics from linter providers such as `linter-eslint` or `linter-ruff`.
- **[linter.ui](docs/linter.ui.md)** (`^1.0.0`): consumed to hand messages to external UI providers such as scrollbar-overview packages.
- **[linter.adapter](docs/linter.adapter.md)** (`^1.0.0`): consumed to let non-`TextEditor` pane items, such as Jupyter notebooks, take part in linting.
- **[status-bar](https://lumine-code.github.io/docs.html#services/status-bar)** (`^1.0.0`): consumed to display the error, warning, and info counts.

## Usage

### The `GetLinterMessages` MCP tool

`linter` publishes one tool through `mcp.tools`, so a connected MCP host can read the diagnostics the panel holds. It is read-only.

With no arguments the tool follows the current linter panel view mode:

- `file`: returns messages for the active editor,
- `project`: returns all known messages across the project.

The tool also accepts optional filters. When any of them is provided, the result is scoped from all known messages across the project, independent of UI focus or panel view mode (`mode` is `filter`). This lets callers target a file that is not the focused tab, or even a file that was never opened:

- `filePath`: only messages for this file. Matching mirrors the filesystem: on Windows it is case-insensitive and treats `/` and `\` as equal, on POSIX it is exact.
- `severity`: only messages with this severity (`error`, `warning` or `info`).
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
