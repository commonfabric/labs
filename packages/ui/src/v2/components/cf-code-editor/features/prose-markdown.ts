import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { EditorState, Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/** Minimal cursor interface returned by `SyntaxNode.cursor()`. */
type SyntaxCursor = {
  firstChild(): boolean;
  nextSibling(): boolean;
  name: string;
  from: number;
  to: number;
};

/**
 * Heading node names used by the lezer markdown parser.
 * ATXHeading1..6 correspond to # through ######.
 * HeaderMark is the child node for the # characters (including trailing space).
 */
const HEADING_NODES = new Set([
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
]);

/**
 * Map heading node names to CSS class names for styling.
 */
const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "cm-prose-h1",
  ATXHeading2: "cm-prose-h2",
  ATXHeading3: "cm-prose-h3",
  ATXHeading4: "cm-prose-h4",
  ATXHeading5: "cm-prose-h5",
  ATXHeading6: "cm-prose-h6",
};

/**
 * Inline markdown syntax nodes and their mark child names.
 * Each entry maps a parent node to the CSS class to apply and the
 * child node name that contains the syntax markers (e.g. **, *, ~~).
 */
const INLINE_SYNTAX: Record<string, { className: string; markName: string }> = {
  StrongEmphasis: { className: "cm-prose-bold", markName: "EmphasisMark" },
  Emphasis: { className: "cm-prose-italic", markName: "EmphasisMark" },
  Strikethrough: {
    className: "cm-prose-strikethrough",
    markName: "StrikethroughMark",
  },
};

/**
 * Widget that renders a bullet character to replace list markers (-, *, +).
 */
class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-prose-bullet";
    span.textContent = "•";
    return span;
  }

  override eq() {
    return true;
  }
}

// Singleton — safe to reuse because eq() always returns true (no instance state).
const bulletWidget = new BulletWidget();

/**
 * Widget that renders a styled number for ordered list markers (1., 2., etc.).
 */
class OrderedListWidget extends WidgetType {
  constructor(private text: string) {
    super();
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-prose-list-number";
    span.textContent = this.text;
    return span;
  }

  override eq(other: OrderedListWidget) {
    return this.text === other.text;
  }
}

/**
 * Widget that renders a footnote reference as a superscript label.
 */
class FootnoteWidget extends WidgetType {
  constructor(private label: string) {
    super();
  }

  toDOM() {
    const span = document.createElement("sup");
    span.className = "cm-prose-footnote";
    span.textContent = this.label;
    return span;
  }

  override eq(other: FootnoteWidget) {
    return this.label === other.label;
  }
}

/**
 * Widget that renders a horizontal rule to replace --- / *** / ___ markers.
 */
class HorizontalRuleWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement("hr");
    hr.className = "cm-prose-hr";
    return hr;
  }

  override eq() {
    return true;
  }
}

// Singleton — safe to reuse because eq() always returns true (no instance state).
const hrWidget = new HorizontalRuleWidget();

/**
 * Widget that renders a checkbox for task list items (- [x] / - [ ]).
 * Clicking the checkbox toggles the checked state in the document.
 */
class TaskCheckboxWidget extends WidgetType {
  constructor(
    private checked: boolean,
    private pos: number,
  ) {
    super();
  }

  override toDOM(view: EditorView) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "cm-prose-checkbox";
    input.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const newText = this.checked ? "[ ]" : "[x]";
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: newText },
      });
    });
    return input;
  }

  override eq(other: TaskCheckboxWidget) {
    return this.checked === other.checked && this.pos === other.pos;
  }

  override ignoreEvent() {
    return false;
  }
}

const hiddenReplace = Decoration.replace({});

/**
 * Build prose decorations from an EditorState.
 *
 * Exported for testing — the ViewPlugin delegates to this function so that
 * tests can exercise the decoration logic without needing a full EditorView.
 */
export function buildProseDecorations(
  state: EditorState,
  hasFocus: boolean,
): Range<Decoration>[] {
  const decorations: Range<Decoration>[] = [];
  const doc = state.doc;
  const cursorPos = state.selection.main.head;
  const cursorLine = doc.lineAt(cursorPos).number;

  // Helper: hide pipe delimiters and style cells in a table row
  const addTableCellDecos = (
    rowCursor: { node: { cursor(): SyntaxCursor } },
    hidden: Decoration,
  ) => {
    const rCursor = rowCursor.node.cursor();
    if (rCursor.firstChild()) {
      do {
        if (rCursor.name === "TableDelimiter") {
          decorations.push(hidden.range(rCursor.from, rCursor.to));
        } else if (rCursor.name === "TableCell") {
          decorations.push(
            Decoration.mark({ class: "cm-prose-table-cell" }).range(
              rCursor.from,
              rCursor.to,
            ),
          );
        }
      } while (rCursor.nextSibling());
    }
  };

  syntaxTree(state).iterate({
    enter(node) {
      // Headings
      if (HEADING_NODES.has(node.name)) {
        const headingLine = doc.lineAt(node.from).number;
        const isActiveLine = hasFocus && headingLine === cursorLine;
        const className = HEADING_CLASS[node.name];

        // Find the HeaderMark child (the ## characters)
        let markEnd = node.from;
        const cursor = node.node.cursor();
        if (cursor.firstChild()) {
          do {
            if (cursor.name === "HeaderMark") {
              markEnd = cursor.to;
              const afterMark = doc.sliceString(markEnd, markEnd + 1);
              if (afterMark === " ") markEnd++;
              break;
            }
          } while (cursor.nextSibling());
        }

        if (!isActiveLine && markEnd > node.from) {
          decorations.push(hiddenReplace.range(node.from, markEnd));
        }

        const textStart = isActiveLine ? node.from : markEnd;
        // An unfinished heading can contain only its hidden marker.
        if (textStart < node.to) {
          decorations.push(
            Decoration.mark({ class: className }).range(textStart, node.to),
          );
        }
        return;
      }

      // Bullet list markers
      if (
        node.name === "ListMark" &&
        node.node.parent?.parent?.name === "BulletList"
      ) {
        const markLine = doc.lineAt(node.from).number;
        const isActiveLine = hasFocus && markLine === cursorLine;

        if (!isActiveLine) {
          // Replace "- " / "* " / "+ " with bullet widget
          const markEnd = node.to;
          const afterMark = doc.sliceString(markEnd, markEnd + 1);
          const replaceEnd = afterMark === " " ? markEnd + 1 : markEnd;
          decorations.push(
            Decoration.replace({ widget: bulletWidget }).range(
              node.from,
              replaceEnd,
            ),
          );
        }
        return;
      }

      // Ordered list markers
      if (
        node.name === "ListMark" &&
        node.node.parent?.parent?.name === "OrderedList"
      ) {
        const markLine = doc.lineAt(node.from).number;
        const isActiveLine = hasFocus && markLine === cursorLine;

        if (!isActiveLine) {
          const markText = doc.sliceString(node.from, node.to);
          const markEnd = node.to;
          const afterMark = doc.sliceString(markEnd, markEnd + 1);
          const replaceEnd = afterMark === " " ? markEnd + 1 : markEnd;
          decorations.push(
            Decoration.replace({
              widget: new OrderedListWidget(markText),
            }).range(node.from, replaceEnd),
          );
        }
        return;
      }

      // Blockquote markers
      if (node.name === "QuoteMark") {
        const markLine = doc.lineAt(node.from).number;
        const isActiveLine = hasFocus && markLine === cursorLine;

        // Apply left-border style to the line
        const line = doc.lineAt(node.from);
        decorations.push(
          Decoration.line({ class: "cm-prose-blockquote" }).range(
            line.from,
          ),
        );

        // Hide the > marker when cursor is elsewhere
        if (!isActiveLine) {
          const markEnd = node.to;
          const afterMark = doc.sliceString(markEnd, markEnd + 1);
          const replaceEnd = afterMark === " " ? markEnd + 1 : markEnd;
          decorations.push(hiddenReplace.range(node.from, replaceEnd));
        }
        return;
      }

      // Tables (GFM)
      if (node.name === "Table") {
        const startLine = doc.lineAt(node.from).number;
        const endLine = doc.lineAt(node.to).number;
        const cursorInTable = hasFocus &&
          cursorLine >= startLine && cursorLine <= endLine;

        if (!cursorInTable) {
          // Count columns from the header for CSS grid
          let colCount = 0;
          const cursor = node.node.cursor();
          if (cursor.firstChild()) {
            do {
              if (cursor.name === "TableHeader") {
                const hCursor = cursor.node.cursor();
                if (hCursor.firstChild()) {
                  do {
                    if (hCursor.name === "TableCell") colCount++;
                  } while (hCursor.nextSibling());
                }
              }
            } while (cursor.nextSibling());
          }

          // Process each child: TableHeader, TableDelimiter (separator), TableRow
          const cursor2 = node.node.cursor();
          if (cursor2.firstChild()) {
            do {
              if (cursor2.name === "TableHeader") {
                // Style header line + hide delimiters, style cells
                const line = doc.lineAt(cursor2.from);
                decorations.push(
                  Decoration.line({
                    class: "cm-prose-table-row cm-prose-table-header",
                    attributes: {
                      style: `--table-cols: ${colCount}`,
                    },
                  }).range(line.from),
                );
                addTableCellDecos(cursor2, hiddenReplace);
              } else if (
                cursor2.name === "TableDelimiter" &&
                doc.sliceString(cursor2.from, cursor2.to).includes("---")
              ) {
                // Hide the separator row (| --- | --- |)
                decorations.push(
                  Decoration.line({
                    class: "cm-prose-table-separator",
                  }).range(doc.lineAt(cursor2.from).from),
                );
              } else if (cursor2.name === "TableRow") {
                const line = doc.lineAt(cursor2.from);
                decorations.push(
                  Decoration.line({
                    class: "cm-prose-table-row",
                    attributes: {
                      style: `--table-cols: ${colCount}`,
                    },
                  }).range(line.from),
                );
                addTableCellDecos(cursor2, hiddenReplace);
              }
            } while (cursor2.nextSibling());
          }
        }
        return;
      }

      // Indented code blocks
      if (node.name === "CodeBlock") {
        const startLine = doc.lineAt(node.from).number;
        const endLine = doc.lineAt(node.to).number;

        for (let ln = startLine; ln <= endLine; ln++) {
          decorations.push(
            Decoration.line({ class: "cm-prose-codeblock" }).range(
              doc.line(ln).from,
            ),
          );
        }
        return;
      }

      // Fenced code blocks
      if (node.name === "FencedCode") {
        const startLine = doc.lineAt(node.from).number;
        const endLine = doc.lineAt(node.to).number;
        const cursorInBlock = hasFocus &&
          cursorLine >= startLine && cursorLine <= endLine;

        // Find the opening and closing fence lines
        let openFenceEnd = node.from;
        let closeFenceStart = node.to;
        const cursor = node.node.cursor();
        if (cursor.firstChild()) {
          do {
            if (cursor.name === "CodeMark") {
              if (cursor.from === node.from) {
                // Opening fence — hide the whole line
                openFenceEnd = doc.lineAt(cursor.from).to;
              } else {
                // Closing fence
                closeFenceStart = doc.lineAt(cursor.from).from;
              }
            }
          } while (cursor.nextSibling());
        }

        if (!cursorInBlock) {
          // Hide opening fence line (```lang)
          if (openFenceEnd > node.from) {
            decorations.push(
              hiddenReplace.range(node.from, openFenceEnd),
            );
          }
          // Hide closing fence line (```)
          if (closeFenceStart < node.to) {
            decorations.push(
              hiddenReplace.range(closeFenceStart, node.to),
            );
          }
        }

        // Apply code background to all lines in the block
        for (let ln = startLine; ln <= endLine; ln++) {
          // Skip fence lines when not editing
          if (!cursorInBlock && (ln === startLine || ln === endLine)) {
            continue;
          }
          decorations.push(
            Decoration.line({ class: "cm-prose-codeblock" }).range(
              doc.line(ln).from,
            ),
          );
        }
        return;
      }

      // Horizontal rules
      if (
        node.name === "HorizontalRule" || node.name === "ThematicBreak"
      ) {
        const ruleLine = doc.lineAt(node.from).number;
        const isActiveLine = hasFocus && ruleLine === cursorLine;

        if (!isActiveLine) {
          decorations.push(
            Decoration.replace({ widget: hrWidget }).range(
              node.from,
              node.to,
            ),
          );
        }
        return;
      }

      // Task markers (GFM)
      if (node.name === "TaskMarker") {
        const markerText = doc.sliceString(node.from, node.to);
        const isChecked = /^\[[xX]\]$/.test(markerText);
        const markLine = doc.lineAt(node.from).number;
        const isActiveLine = hasFocus && markLine === cursorLine;

        if (!isActiveLine) {
          // Replace [x] / [ ] with a checkbox widget
          const afterMarker = doc.sliceString(node.to, node.to + 1);
          const replaceEnd = afterMarker === " " ? node.to + 1 : node.to;
          decorations.push(
            Decoration.replace({
              widget: new TaskCheckboxWidget(isChecked, node.from),
            }).range(node.from, replaceEnd),
          );

          // Apply strikethrough to the rest of the line when checked
          if (isChecked) {
            const line = doc.lineAt(node.from);
            const textStart = node.to + 1; // after [x] and space
            if (textStart < line.to) {
              decorations.push(
                Decoration.mark({
                  class: "cm-prose-task-checked",
                }).range(textStart, line.to),
              );
            }
          }
        }
        return;
      }

      // Links
      if (node.name === "Link") {
        const isActive = hasFocus &&
          cursorPos >= node.from && cursorPos <= node.to;

        // Check if this is a footnote reference like [^1]
        const fullText = doc.sliceString(node.from, node.to);
        const innerText = fullText.slice(1);
        const isFootnote = innerText.startsWith("^");

        if (isFootnote) {
          if (!isActive) {
            // Extract the footnote label (everything after ^, before ])
            const label = innerText.match(/^\^([^\]]+)/)?.[1] ?? "";
            decorations.push(
              Decoration.replace({
                widget: new FootnoteWidget(label),
              }).range(node.from, node.to),
            );
          }
          return;
        }

        if (!isActive) {
          // Find link structure: [text](url)
          // Hide all LinkMark children and the URL, keep only the text
          const children: { name: string; from: number; to: number }[] = [];
          const cursor = node.node.cursor();
          if (cursor.firstChild()) {
            do {
              children.push({
                name: cursor.name,
                from: cursor.from,
                to: cursor.to,
              });
            } while (cursor.nextSibling());
          }

          // Hide everything that isn't the link text content
          // Structure: LinkMark([) ... text ... LinkMark(]) LinkMark(() URL LinkMark())
          // So hide: first LinkMark, and from second LinkMark onward
          const firstMark = children.find((c) => c.name === "LinkMark");
          if (firstMark) {
            // Hide opening [
            decorations.push(
              hiddenReplace.range(firstMark.from, firstMark.to),
            );
          }

          // Find the ] and hide from ] to end of link
          const closeBracketIdx = children.findIndex(
            (c, i) => i > 0 && c.name === "LinkMark",
          );
          if (closeBracketIdx >= 0) {
            decorations.push(
              hiddenReplace.range(
                children[closeBracketIdx].from,
                node.to,
              ),
            );
          }
        }

        // Style the full range when editing, just the text when not
        decorations.push(
          Decoration.mark({ class: "cm-prose-link" }).range(
            node.from,
            node.to,
          ),
        );
        return;
      }

      // Inline code
      if (node.name === "InlineCode") {
        const isActive = hasFocus &&
          cursorPos >= node.from && cursorPos <= node.to;

        // Collect CodeMark children (the backticks)
        const marks: { from: number; to: number }[] = [];
        const cursor = node.node.cursor();
        if (cursor.firstChild()) {
          do {
            if (cursor.name === "CodeMark") {
              marks.push({ from: cursor.from, to: cursor.to });
            }
          } while (cursor.nextSibling());
        }

        if (!isActive) {
          for (const mark of marks) {
            decorations.push(hiddenReplace.range(mark.from, mark.to));
          }
        }

        decorations.push(
          Decoration.mark({ class: "cm-prose-inline-code" }).range(
            isActive ? node.from : (marks.length > 0 ? marks[0].to : node.from),
            isActive
              ? node.to
              : (marks.length > 1 ? marks[marks.length - 1].from : node.to),
          ),
        );
        return;
      }

      // Inline syntax (bold, italic, strikethrough)
      const inline = INLINE_SYNTAX[node.name];
      if (!inline) return;

      const isActive = hasFocus &&
        cursorPos >= node.from && cursorPos <= node.to;

      // Collect all mark children (opening and closing markers)
      const marks: { from: number; to: number }[] = [];
      const cursor = node.node.cursor();
      if (cursor.firstChild()) {
        do {
          if (cursor.name === inline.markName) {
            marks.push({ from: cursor.from, to: cursor.to });
          }
        } while (cursor.nextSibling());
      }

      // Hide markers when cursor is elsewhere
      if (!isActive) {
        for (const mark of marks) {
          decorations.push(hiddenReplace.range(mark.from, mark.to));
        }
      }

      // Always apply styling to the full range
      decorations.push(
        Decoration.mark({ class: inline.className }).range(
          node.from,
          node.to,
        ),
      );
    },
  });

  return decorations;
}

/**
 * Creates a ViewPlugin that renders markdown syntax in prose mode.
 *
 * For headings: hides ## markers and applies heading size styling.
 * For inline syntax (bold, italic, strikethrough): hides markers
 * (**, *, ~~) and applies the appropriate styling.
 *
 * When the cursor IS on the same line, markers are revealed but
 * styling is preserved so content doesn't jump in size/weight.
 */
export function createProseMarkdownPlugin() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = Decoration.set(
          buildProseDecorations(view.state, view.hasFocus),
          true,
        );
      }

      // TODO(@robdodson): For large documents, optimize to only decorate
      // visible ranges using update.view.visibleRanges.
      update(update: ViewUpdate) {
        if (
          update.docChanged || update.viewportChanged ||
          update.selectionSet || update.focusChanged
        ) {
          this.decorations = Decoration.set(
            buildProseDecorations(update.view.state, update.view.hasFocus),
            true,
          );
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
