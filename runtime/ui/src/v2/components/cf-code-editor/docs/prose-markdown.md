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

## Math

With the `math` property set, prose mode also draws TeX formulas in Markdown:
`$…$` inline and `$$…$$` display. The syntax is `features/math-syntax.ts`, what
draws it is `features/prose-math.ts`, and KaTeX itself is reached only through
`features/katex-render.ts`:

- **`mathMarkdown`**, a Markdown parser extension, makes each formula a node of
  the syntax tree, `InlineMath` or `DisplayMath`, with `MathMark` children for
  its delimiters, so nothing inside a formula is parsed as emphasis, a link or
  code. The editor parses Markdown with it only while `math` is set in prose
  mode. It follows Pandoc: inline math neither opens before a space nor closes
  after one, and a closing `$` followed by a digit closes nothing, so
  `$5 and
  $6` stays text; `\$` is a literal dollar sign. A formula stays
  within its paragraph, so a `$$` with no closing `$$` before the next blank
  line stays text.
- **`buildMathDecorations(state, hasFocus)`** follows the active-line pattern
  with range-based activation: while the editor has focus and the selection
  touches a formula, the formula keeps its TeX, marked `cm-prose-math-source`;
  otherwise a widget drawing KaTeX's output replaces it. A `$$` formula with its
  lines to itself is replaced as a block, `cm-prose-math-block`, covering those
  whole lines; any other formula is replaced inline, `cm-prose-math`. TeX that
  KaTeX cannot parse is shown as written, `cm-prose-math-error`, with KaTeX's
  message as its tooltip. A click on a formula places the cursor beside it,
  which shows its TeX.
- **`proseMath(hasFocus, render)`** draws each formula with `render`, which is
  `katex-render.ts`'s `renderFormula`, and provides the decorations from a state
  field rather than a view plugin, because a block formula replaces line breaks,
  which CodeMirror accepts only from a field. A field cannot read the view's
  focus, so a small view plugin compares the two after every update and sends a
  correction when they differ. CodeMirror's `focusChangeEffect` would drop its
  transaction whenever another lands first, which the editor's own updates do.

KaTeX runs with `trust` off, so `\href`, `\url`, `\includegraphics` and the
`\html…` commands draw nothing of the author's choosing; with `maxSize` 10 (em)
and `maxExpand` 1000.

`katex-render.ts` holds KaTeX and its layout rules and imports nothing of the
editor's. The editor imports it as `cf-katex-render`, the first time an editor
draws math. In Deno and the browser tests, `runtime/ui`'s import map resolves
that name to the module. The shell instead leaves the name external to its
bundles, builds the module as `/scripts/katex-render.js`, and maps the name to
that script in its page's import map, so a page loads KaTeX only when an editor
draws math, and the script carries no second copy of CodeMirror;
`runtime/shell/integration/katex-script.test.ts` holds the three together. Until
KaTeX arrives, formulas show as their TeX, and the editor's `updateComplete`
waits for it. A load that fails is reported as `cf-error`; a page that maps no
script to the name, one embedding the shell's components outside the shell's own
page, is one where that happens.

KaTeX's layout rules, `features/katex-styles.ts`, are added to the editor's
shadow root once loaded. Its fonts cannot be declared there, since a shadow root
ignores `@font-face`: the shell serves them from `/fonts/katex/` and declares
them in `/styles/katex-fonts.css`, which its page loads, and the browser fetches
a face only when a formula uses it. A page without that stylesheet draws
formulas in fallback faces. `tasks/generate-katex-assets.ts` writes all three
from the pinned KaTeX release;
[DEPENDENCIES.md](../../../../../../../docs/development/DEPENDENCIES.md#katex)
says how to roll it.

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

Singletons (`bulletWidget`, `hrWidget`) are used where possible: CodeMirror
keeps a widget's element when the widget replacing it is the same object, so one
instance serves every bullet and every rule.

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
