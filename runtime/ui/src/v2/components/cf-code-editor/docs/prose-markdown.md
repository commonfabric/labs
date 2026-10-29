# Prose markdown decorations in cf-code-editor

Prose mode gives the editor a WYSIWYG-like feel for markdown. Syntax markers
(`#`, `**`, `` ` ``, `---`, etc.) are hidden when the cursor is elsewhere and
revealed when the user moves to the relevant line or range. The underlying
document text is always valid markdown — decorations only change how it is
displayed.

## Architecture: one function, one ViewPlugin

The entire feature lives in `features/prose-markdown.ts` and has two exports:

### `buildProseDecorations(state, hasFocus)` — the pure logic

A plain function that takes an `EditorState` and a focus boolean, walks the
lezer syntax tree, and returns an unsorted array of `Range<Decoration>`. It has
no dependency on `EditorView`, which means tests can exercise every decoration
rule with a headless state.

### `createProseMarkdownPlugin()` — the CM6 glue

A `ViewPlugin` that calls `buildProseDecorations` in its constructor and
`update()` method, converting the result into a `DecorationSet` via
`Decoration.set(decos, true)` (the `true` flag lets CM6 handle sort order). It
re-runs whenever the document, selection, viewport, or focus changes.

## The active-line pattern

Almost every syntax element follows the same two-step pattern:

1. **Cursor is elsewhere** — hide the markers with `Decoration.replace` (or a
   widget replacement) and apply a `Decoration.mark` for styling.
2. **Cursor is on the same line (or inside the range)** — skip the replace
   decoration so the raw markers are visible, but still apply the mark so
   styling (font size, weight, color) stays consistent and content does not
   jump.

Block-level elements (headings, blockquotes, list markers) use **line-based**
activation: the cursor's line number is compared to the element's line number.
Inline elements (bold, italic, links, inline code) use **range-based**
activation: the cursor position is compared to the element's `from`/`to` span.

## Supported syntax elements

| Syntax        | Lezer node(s)                                                     | Inactive behavior                                               | CSS class(es)            |
| ------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------ |
| `# Heading`   | `ATXHeading1`..`6`, `HeaderMark`                                  | `##` hidden, text styled                                        | `cm-prose-h1`..`h6`      |
| `**bold**`    | `StrongEmphasis`, `EmphasisMark`                                  | `**` hidden, text styled                                        | `cm-prose-bold`          |
| `*italic*`    | `Emphasis`, `EmphasisMark`                                        | `*` hidden, text styled                                         | `cm-prose-italic`        |
| `~~struck~~`  | `Strikethrough`, `StrikethroughMark`                              | `~~` hidden, text styled                                        | `cm-prose-strikethrough` |
| `` `code` ``  | `InlineCode`, `CodeMark`                                          | Backticks hidden, content styled                                | `cm-prose-inline-code`   |
| `[text](url)` | `Link`, `LinkMark`                                                | `[`, `](url)` hidden, text styled                               | `cm-prose-link`          |
| `[^1]`        | `Link` (footnote)                                                 | Replaced with superscript widget                                | `cm-prose-footnote`      |
| `- item`      | `ListMark` in `BulletList`                                        | `-` replaced with bullet widget                                 | `cm-prose-bullet`        |
| `1. item`     | `ListMark` in `OrderedList`                                       | `1.` replaced with styled number widget                         | `cm-prose-list-number`   |
| `> quote`     | `QuoteMark`                                                       | `>` hidden, line decoration always applied                      | `cm-prose-blockquote`    |
| `---`         | `HorizontalRule`/`ThematicBreak`                                  | Replaced with `<hr>` widget                                     | `cm-prose-hr`            |
| `- [ ] todo`  | `TaskMarker`                                                      | `[ ]` replaced with checkbox widget                             | `cm-prose-checkbox`      |
| `- [x] done`  | `TaskMarker` (checked)                                            | Checkbox + strikethrough on text                                | `cm-prose-task-checked`  |
| `` ```lang `` | `FencedCode`, `CodeMark`                                          | Fences hidden, body lines styled                                | `cm-prose-codeblock`     |
| `code`        | `CodeBlock`                                                       | Lines always styled (no cursor sensitivity)                     | `cm-prose-codeblock`     |
| GFM tables    | `Table`, `TableHeader`, `TableRow`, `TableDelimiter`, `TableCell` | Pipes hidden, cells and rows styled via line + mark decorations | `cm-prose-table-*`       |

## Widgets

Six `WidgetType` subclasses handle elements that cannot be expressed as simple
mark/replace decorations:

- **`BulletWidget`** — renders a `•` character.
- **`OrderedListWidget`** — renders the original number text (e.g. `1.`) with
  styling.
- **`FootnoteWidget`** — renders the footnote label as a `<sup>`.
- **`HorizontalRuleWidget`** — renders an `<hr>` element.
- **`TaskCheckboxWidget`** — renders an `<input type="checkbox">` that toggles
  `[x]`/`[ ]` in the document on click.

Singletons (`bulletWidget`, `hrWidget`) are used where possible since their
`eq()` methods always return `true`.

## Integration with cf-code-editor

The Lit component activates prose mode through a `Compartment` in
`_getModeExtension()`. When `mode === "prose"`, the compartment provides:

1. A CM6 theme with prose-oriented layout (centered content, wider line height).
2. `createProseMarkdownPlugin()` — the decoration ViewPlugin described above.
3. Prose-specific CSS for all `cm-prose-*` classes.

When `mode !== "prose"`, the compartment returns an empty extension array.

## Testing

`buildProseDecorations` is tested directly in `features/prose-markdown.test.ts`
using headless `EditorState` instances (no DOM, no `EditorView`). The test
helpers (`hasReplace`, `hasMark`, `hasWidget`, `hasLineClass`) inspect the
returned decoration array by checking `spec` properties — `isReplace` looks for
decorations without a `class` in spec, `isMark` looks for a `class` string.
