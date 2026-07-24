# linter

A unified linting package that combines linting infrastructure with an integrated UI.

Fork of [linter](https://github.com/steelbrain/linter) and [linter-ui-default](https://github.com/steelbrain/linter-ui-default).

## Features

- **Unified package**: combines linter core functionality with UI in a single package.
- **Status bar integration**: shows error, warning, and info counts in the status bar. Left-click toggles the panel, middle-click toggles file/project mode, Ctrl+middle-click clears messages, right-click jumps to next, Ctrl+right-click jumps to previous.
- **Linter panel**: sortable table view of all linter messages with filtering, and keyboard navigation when focused.
- **Inline bubbles**: hover-style message display at the cursor position.
- **Editor highlighting**: underline and gutter decorations for linted ranges.
- **Multiple sort methods**: sort by severity, position, or provider. Cell index is used as a primary sort key for notebook messages.
- **Linter management**: enable or disable individual linter providers.
- **Jupyter notebook support**: works with `.ipynb` files through the `linter-adapter` service. Messages are mapped to individual cells and the panel shows `[cell]:line:col` position.
- **Scrollmap markers**: exposes linter markers to scrollbar-overview packages through the `linter-ui` service.
- **Reference links**: clickable references in messages open related files.
- **Markdown rendering**: message excerpts support markdown formatting in tooltips and the panel.
- **MCP tool**: provides a read-only `GetLinterMessages` tool through the `mcp-tools` service.

## Installation

To install `linter`, clone this repository into your Lumine packages directory (`~/.lumine/packages/linter`) and restart Lumine. If it is listed in your configured package sources, it can also be installed from the Install pane of the Lumine settings.

## Commands

Commands available in `atom-workspace`:

- `linter:toggle-focus`: focus the panel (or return focus to the editor if already focused), opening the panel if needed,
- `linter:toggle-panel`: toggle the linter panel visibility,
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

The styling can be adjusted in your Lumine stylesheet:

- e.g. a solid underline instead of a dashed one:

```css
.linter-text {
  &.error,
  &.warning,
  &.info {
    text-decoration-style: solid;
  }
}
```

- e.g. change the gutter dot size:

```css
:root {
  --linter-dot-size: 6px;
}
```

## Provided Service `linter-indie`

Indie linter delegate for custom integrations. Allows packages to push linter messages directly without implementing the full linter provider interface.

In your `package.json`:

```json
{
  "consumedServices": {
    "linter-indie": {
      "versions": { "2.0.0": "consumeIndie" }
    }
  }
}
```

In your main module:

```javascript
module.exports = {
  consumeIndie(registerIndie) {
    const indie = registerIndie({ name: "my-indie-linter" });

    // Set messages for a specific file
    indie.setMessages("/path/to/file.js", [
      {
        severity: "warning",
        location: {
          file: "/path/to/file.js",
          position: [
            [0, 0],
            [0, 1],
          ],
        },
        excerpt: "Warning message",
      },
    ]);

    // Or set all messages at once
    indie.setAllMessages([/* messages */]);

    // Clear all messages
    indie.clearMessages();
  },
};
```

## Provided Service `mcp-tools`

Provides MCP tools for a connected MCP host. The service currently exposes `GetLinterMessages`, a read-only tool that returns diagnostics from the linter panel.

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

In `package.json` this service is provided as:

```json
{
  "providedServices": {
    "mcp-tools": {
      "versions": {
        "1.0.0": "provideMcpTools"
      }
    }
  }
}
```

## Consumed Service `linter-adapter`

Allows non-TextEditor pane items (such as Jupyter notebooks) to integrate with the linter panel. The adapter maps linter messages to the correct item, handles navigation, and provides cursor-aware message lookup.

In your `package.json`:

```json
{
  "providedServices": {
    "linter-adapter": {
      "versions": {
        "1.0.0": "provideLinterItemAdapter"
      }
    }
  }
}
```

In your main module:

```javascript
module.exports = {
  provideLinterItemAdapter() {
    return {
      // Return true if this adapter handles the given pane item
      handlesItem: (item) => item instanceof MyCustomEditor,

      // Return the TextEditor that linters should lint for this item (for grammar/path detection)
      getTextEditorForItem: (item) => item.getSourceEditor(),

      // Filter all linter messages down to those relevant for this item
      getMessagesForItem: (item, allMessages) =>
        allMessages.filter((m) => m.location?.file === item.getPath()),

      // Return the message at the current cursor position (or undefined)
      getCurrentMessage: (item, messages) => item.getMessageAtCursor(messages),

      // Return the next message after the current cursor position
      getNextMessage: (item, messages) => item.getNextMessage(messages),

      // Return the previous message before the current cursor position
      getPreviousMessage: (item, messages) => item.getPreviousMessage(messages),

      // Scroll the item to the given message
      revealMessage: (item, message) => item.revealMessage(message),
    };
  },
};
```

## Consumed Service `linter`

Standard linter provider interface. Packages like `linter-eslint`, `linter-ruff`, etc. provide this service to report diagnostics.

```javascript
// Provider example
module.exports = {
  provideLinter() {
    return {
      name: "my-linter",
      scope: "file", // or 'project'
      lintsOnChange: true,
      grammarScopes: ["source.js"],
      lint(editor) {
        return [
          {
            severity: "error", // 'error' | 'warning' | 'info'
            location: {
              file: editor.getPath(),
              position: [
                [0, 0],
                [0, 1],
              ],
            },
            excerpt: "Error message",
          },
        ];
      },
    };
  },
};
```

## Consumed Service `linter-ui`

External UI providers that want to display linter messages. Used by scrollbar-overview packages to show linter markers.

```javascript
// UI provider example
module.exports = {
  provideLinterUI() {
    return {
      name: "my-ui",
      render({ added, removed, messages }) {
        // Handle message updates
      },
      didBeginLinting({ linter, filePath }) {},
      didFinishLinting({ linter, filePath }) {},
      dispose() {},
    };
  },
};
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
