const { CompositeDisposable } = require("atom");
const { scrollToCursorWithMode } = require("./helpers");
const Severities = require("./severities");

/**
 * BubblePanel - Shows linter messages on mouse hover over issues
 * Also handles keyboard-triggered inspect commands
 * Uses a single window-level mouse listener for efficiency.
 */
class BubblePanel {
  constructor(pkg) {
    this.pkg = pkg;
    this.tooltip = null;
    this.disposables = new CompositeDisposable();
    this.hoverTimeout = null;
    this.hideTimeout = null;
    this.currentPosition = null;
    this.currentEditor = null;
    this.enabled = atom.config.get("linter.showHoverTooltip");
    this.tooltipListeners = null; // Track tooltip event listeners for cleanup
    this.lastMoveTime = 0; // For throttling mousemove
    this.lastEditorElement = null; // Track last hovered editor element

    // Bind event handlers
    this.onMouseMove = this.onMouseMove.bind(this);

    // Observe config changes
    this.disposables.add(
      atom.config.observe("linter.showHoverTooltip", (value) => {
        this.enabled = value;
        if (value) {
          this.attachWindowListener();
        } else {
          this.destroyTooltip();
          this.detachWindowListener();
        }
      }),
    );

    // Attach window listener if enabled
    if (this.enabled) {
      this.attachWindowListener();
    }
  }

  destroy() {
    this.destroyTooltip();
    this.detachWindowListener();
    this.disposables.dispose();
    this.currentEditor = null;
  }

  /**
   * Attaches a single mousemove listener to the window.
   */
  attachWindowListener() {
    if (this.windowListenerAttached) return;
    window.addEventListener("mousemove", this.onMouseMove);
    this.windowListenerAttached = true;
  }

  /**
   * Detaches the window mousemove listener.
   */
  detachWindowListener() {
    if (!this.windowListenerAttached) return;
    window.removeEventListener("mousemove", this.onMouseMove);
    this.windowListenerAttached = false;
  }

  onMouseMove(event) {
    // Throttle mousemove to ~30fps (33ms) to reduce CPU load
    const now = Date.now();
    if (now - this.lastMoveTime < 33) {
      return;
    }
    this.lastMoveTime = now;

    // Ignore if mouse is over the tooltip itself
    if (this.tooltip && this.tooltip.contains(event.target)) {
      return;
    }

    // Check if we're hovering over a linter-text decoration or linter line number
    const linterText = event.target.closest(".linter-text");
    const linterLineNumber = event.target.closest(".linter-line-number");

    if (!linterText && !linterLineNumber) {
      if (this.lastEditorElement) {
        this.lastEditorElement = null;
        this.onMouseLeave();
      }
      return;
    }

    // Find the editor element
    const editorElement = event.target.closest("atom-text-editor:not([mini])");
    if (!editorElement) {
      if (this.lastEditorElement) {
        this.lastEditorElement = null;
        this.onMouseLeave();
      }
      return;
    }

    this.lastEditorElement = editorElement;

    // Get the editor model from the element
    const editor = editorElement.getModel();
    if (!editor || !editor.component) return;

    this.currentEditor = editor;

    const buffer = editor.getBuffer();
    let messages;

    if (linterLineNumber) {
      // For line number hover, get row from data attribute and find all messages on that row
      const bufferRow = parseInt(linterLineNumber.dataset.bufferRow, 10);
      if (isNaN(bufferRow)) return;
      messages = this.getMessagesAtRow(bufferRow, buffer);
    } else {
      // For text hover, get buffer position from mouse coordinates
      const screenPosition = editor.component.screenPositionForMouseEvent(event);
      if (!screenPosition) return;
      const bufferPosition = editor.bufferPositionForScreenPosition(screenPosition);
      messages = this.getMessagesAtPosition(bufferPosition, buffer);
    }

    if (messages.length === 0) {
      this.hideTooltip();
      this.currentMessages = null;
      return;
    }

    // Build a key from message keys to compare
    const messagesKey = messages.map((m) => m.key).join(",");

    // If tooltip is visible and showing the same messages, just move it
    if (this.tooltip && this.currentMessages === messagesKey) {
      this.moveTooltip(event);
      return;
    }

    this.currentMessages = messagesKey;

    // Clear any pending timeouts
    if (this.hoverTimeout) {
      clearTimeout(this.hoverTimeout);
      this.hoverTimeout = null;
    }

    // Immediately destroy any existing/hiding tooltip
    this.destroyTooltip();

    // Store last event position for the delayed show
    this.lastMouseEvent = event;

    // Show tooltip after a short delay
    this.hoverTimeout = setTimeout(() => {
      this.showTooltipForMessages(messages, this.lastMouseEvent, editor);
    }, 200);
  }

  onMouseLeave() {
    if (this.hoverTimeout) {
      clearTimeout(this.hoverTimeout);
      this.hoverTimeout = null;
    }
    this.hideTooltip();
    this.currentMessages = null;
  }

  /**
   * Gets all messages that contain the given buffer position.
   * Returns messages ordered by severity precedence (error > warning > info > hint).
   */
  getMessagesAtPosition(bufferPosition, buffer) {
    if (!buffer.linterUI || !buffer.linterUI.messages) return [];

    const messages = buffer.linterUI.messages;
    const result = [];
    const targetRow = bufferPosition.row;

    for (const message of messages) {
      const range = message.location.displayRange || message.location.position;
      // Check if message contains this position
      if (range.containsPoint(bufferPosition)) {
        result.push(message);
      }
      // Early exit if we've passed this row (messages are sorted by start)
      if (message.location.position.start.row > targetRow) {
        break;
      }
    }

    // Most severe first; a severity outside the model sorts last
    result.sort((a, b) => Severities.compare(a.severity, b.severity));

    return result;
  }

  /**
   * Gets all messages on the given buffer row.
   * Returns messages ordered by severity precedence (error > warning > info > hint).
   */
  getMessagesAtRow(row, buffer) {
    if (!buffer.linterUI || !buffer.linterUI.messages) return [];

    const messages = buffer.linterUI.messages;
    const result = [];

    for (const message of messages) {
      const range = message.location.displayRange || message.location.position;
      // Check if message intersects this row
      if (range.start.row <= row && range.end.row >= row) {
        result.push(message);
      }
      // Early exit if we've passed this row (messages are sorted by start)
      if (message.location.position.start.row > row) {
        break;
      }
    }

    // Most severe first; a severity outside the model sorts last
    result.sort((a, b) => Severities.compare(a.severity, b.severity));

    return result;
  }

  /**
   * Shows tooltip for multiple messages on a row.
   */
  showTooltipForMessages(messages, event, editor) {
    if (messages.length === 0) return;

    this.destroyTooltip();

    const targetEditor = editor || this.currentEditor;
    if (!targetEditor) return;

    // Create tooltip container
    this.tooltip = document.createElement("div");
    this.tooltip.classList.add("linter-bubble-tooltip");
    // Border colour comes from the most severe message present. Guarded because
    // classList.add throws on an empty or whitespace-bearing string, which an
    // unvalidated provider can still supply.
    const topSeverity = Severities.get(messages[0].severity);
    if (topSeverity) {
      this.tooltip.classList.add(topSeverity.name);
    }

    // Add each message
    for (const message of messages) {
      const item = document.createElement("div");
      item.classList.add("linter-bubble-item");
      const severity = Severities.get(message.severity);
      if (severity) {
        item.classList.add(severity.name);
      }

      // Add linter name
      const sidebar = document.createElement("div");
      sidebar.classList.add("linter-bubble-sidebar");
      sidebar.textContent = message.linterName;
      item.appendChild(sidebar);

      // Add message content
      const content = document.createElement("div");
      content.classList.add("linter-bubble-content");
      content.innerHTML = atom.ui.markdown.render(message.excerpt);

      // Add log reference link if available
      if (message.reference && message.reference.file) {
        const refLine = Array.isArray(message.reference.position)
          ? message.reference.position[0]
          : (message.reference.position?.row ?? 0);
        const refColumn = Array.isArray(message.reference.position)
          ? message.reference.position[1]
          : (message.reference.position?.column ?? 0);

        const logRef = document.createElement("a");
        logRef.classList.add("linter-log-ref");
        logRef.textContent = `log:${refLine + 1}`;
        logRef.title = `Open log at line ${refLine + 1}`;
        logRef.addEventListener("click", (e) => {
          e.stopPropagation();
          atom.workspace.open(message.reference.file, {
            initialLine: refLine,
            initialColumn: refColumn,
            pending: true,
          });
          this.destroyTooltip();
        });
        content.appendChild(logRef);
      }

      item.appendChild(content);

      this.tooltip.appendChild(item);
    }

    // Position the tooltip near the mouse or cursor
    document.body.appendChild(this.tooltip);

    // Calculate position
    const tooltipRect = this.tooltip.getBoundingClientRect();
    let left, top;

    if (event) {
      // Mouse hover - position near mouse
      left = event.clientX + 10;
      top = event.clientY + 15;
    } else {
      // Keyboard trigger - position near cursor
      const cursorPos = targetEditor.getCursorScreenPosition();
      const pixelPos = targetEditor.element.pixelPositionForScreenPosition(cursorPos);
      const editorRect = targetEditor.element.getBoundingClientRect();
      const scrollTop = targetEditor.element.getScrollTop();
      const scrollLeft = targetEditor.element.getScrollLeft();

      left = editorRect.left + pixelPos.left - scrollLeft + 10;
      top = editorRect.top + pixelPos.top - scrollTop + 20;
    }

    // Adjust if tooltip would go off-screen
    if (left + tooltipRect.width > window.innerWidth) {
      left = window.innerWidth - tooltipRect.width - 10;
    }
    if (top + tooltipRect.height > window.innerHeight) {
      top = (event ? event.clientY : top) - tooltipRect.height - 10;
    }

    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;

    // Trigger animation
    requestAnimationFrame(() => {
      if (this.tooltip) {
        this.tooltip.classList.add("visible");
      }
    });

    // Track listeners for proper cleanup
    const tooltipLeaveHandler = () => this.hideTooltip();
    this.tooltip.addEventListener("mouseleave", tooltipLeaveHandler);

    const scrollView = targetEditor.element.querySelector(".scroll-view");
    let scrollHandler = null;
    if (scrollView) {
      scrollHandler = () => this.destroyTooltip();
      scrollView.addEventListener("scroll", scrollHandler, { passive: true, once: true });
    }

    // Hide on window resize
    const resizeHandler = () => this.destroyTooltip();
    window.addEventListener("resize", resizeHandler, { once: true });

    // Hide on any mouse button, keyboard input, or mouse wheel
    const inputHandler = () => this.hideTooltip();
    window.addEventListener("wheel", inputHandler, { once: true, passive: true });

    // Hide on buffer changes (text edits)
    const buffer = targetEditor.getBuffer();
    const bufferChangeHandler = buffer.onDidChange(() => {
      bufferChangeHandler.dispose();
      this.destroyTooltip();
    });

    // Store references for cleanup
    this.tooltipListeners = {
      tooltip: this.tooltip,
      tooltipLeaveHandler,
      scrollView,
      scrollHandler,
      resizeHandler,
      inputHandler,
      bufferChangeHandler,
    };
  }

  /**
   * Shows tooltip for a single message (used by keyboard commands).
   */
  showTooltip(message, event, editor) {
    this.showTooltipForMessages([message], event, editor);
  }

  moveTooltip(event) {
    if (!this.tooltip) return;

    const tooltipRect = this.tooltip.getBoundingClientRect();
    let left = event.clientX + 10;
    let top = event.clientY + 15;

    // Adjust if tooltip would go off-screen
    if (left + tooltipRect.width > window.innerWidth) {
      left = window.innerWidth - tooltipRect.width - 10;
    }
    if (top + tooltipRect.height > window.innerHeight) {
      top = event.clientY - tooltipRect.height - 10;
    }

    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  hideTooltip() {
    if (!this.tooltip) return;

    // Start hide animation
    this.tooltip.classList.remove("visible");
    this.tooltip.classList.add("hiding");

    // Remove after animation completes
    this.hideTimeout = setTimeout(() => {
      this.destroyTooltip();
    }, 150);
  }

  destroyTooltip() {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    // Clean up tracked event listeners to prevent memory leaks
    if (this.tooltipListeners) {
      const {
        tooltip,
        tooltipLeaveHandler,
        scrollView,
        scrollHandler,
        resizeHandler,
        inputHandler,
        bufferChangeHandler,
      } = this.tooltipListeners;
      if (tooltip && tooltipLeaveHandler) {
        tooltip.removeEventListener("mouseleave", tooltipLeaveHandler);
      }
      if (scrollView && scrollHandler) {
        scrollView.removeEventListener("scroll", scrollHandler);
      }
      if (resizeHandler) {
        window.removeEventListener("resize", resizeHandler);
      }
      if (inputHandler) {
        window.removeEventListener("wheel", inputHandler);
      }
      if (bufferChangeHandler) {
        bufferChangeHandler.dispose();
      }
      this.tooltipListeners = null;
    }
    if (this.tooltip) {
      this.tooltip.remove();
      this.tooltip = null;
    }
  }

  // Commands (replacing BubblePanel functionality)

  inspect() {
    this.destroyTooltip();
    const editor = this.pkg.editor;
    if (!editor) return;

    const message = this.pkg.getCurrentMessage();
    if (!message) return;

    this.currentEditor = editor;
    this.showTooltip(message, null, editor);

    // Hide on cursor movement
    const signal = editor.onDidChangeCursorPosition(() => {
      signal.dispose();
      this.hideTooltip();
    });
  }

  inspectNext() {
    this.destroyTooltip();
    const editor = this.pkg.editor;
    if (!editor) return;

    const message = this.pkg.getNextMessage();
    if (!message) return;

    editor.setCursorBufferPosition(message.location.position.start, {
      autoscroll: false,
    });
    scrollToCursorWithMode(editor, atom.config.get("linter.editorScrollPosition"));
    editor.element.focus();
    this.currentEditor = editor;
    this.showTooltip(message, null, editor);

    // Hide on cursor movement
    const signal = editor.onDidChangeCursorPosition(() => {
      signal.dispose();
      this.hideTooltip();
    });
  }

  inspectPrevious() {
    this.destroyTooltip();
    const editor = this.pkg.editor;
    if (!editor) return;

    const message = this.pkg.getPreviousMessage();
    if (!message) return;

    editor.setCursorBufferPosition(message.location.position.start, {
      autoscroll: false,
    });
    scrollToCursorWithMode(editor, atom.config.get("linter.editorScrollPosition"));
    editor.element.focus();
    this.currentEditor = editor;
    this.showTooltip(message, null, editor);

    // Hide on cursor movement
    const signal = editor.onDidChangeCursorPosition(() => {
      signal.dispose();
      this.hideTooltip();
    });
  }
}

module.exports = { BubblePanel };
