# The margin in cf-code-editor

The editor shows its element children in a margin beside its text. A child that
names one of the collaborative field's anchors sits beside the line where that
anchor is, so a comment, a note, or any other aside a host draws stays level
with the text it is about while the text is edited, scrolled, and wrapped. The
anchors are the ones [highlights](highlights.md) are drawn between: points in
the field's text that Memory moves through every edit.

## The host's side

```tsx
<cf-code-editor $value={content} collaborative highlights={highlights}>
  <cf-vstack>
    <cf-text>Comments</cf-text>
  </cf-vstack>
  {comments.map((comment) => (
    <cf-vstack data-anchor={comment.fromAnchor}>
      <cf-text>{comment.body}</cf-text>
    </cf-vstack>
  ))}
</cf-code-editor>;
```

- The margin is a column of the editor's children, in their order. A child drawn
  as `display: contents`, such as the element that holds the rows of a mapped
  list, is looked through: its children are the margin's. A child's `order`
  style places it in the column as it would in any flex column, and a hidden
  child takes no place.
- A child whose `data-anchor` attribute names an anchor of the field sits beside
  the text at that anchor: its top is level with the top of the text there. An
  empty `data-anchor` names none.
- A child that names no anchor sits under the child before it in the column, and
  moves with it. The children before the first that names an anchor stay at the
  top of the margin, so a header goes first.
- Children are kept `--cf-code-editor-margin-gap` apart, `0.5rem` unless the
  host sets it. Where two would come closer, the lower one moves down. Where an
  anchor is the start of a highlight whose `kind` is `active`, the child naming
  it keeps its place beside its text and the children above it move up to make
  way, as far as the children at the top leave room.
- A child naming an anchor the field does not hold, such as one not yet written
  or one since removed, sits after the children whose anchors it holds.
- With no element child, the editor draws no margin and its text takes the full
  width.

## Width and wrapping

The text and the margin share the editor's width, the text taking three parts
and the margin one, from bases of `--cf-code-editor-text-basis` (`24rem`) and
`--cf-code-editor-margin-basis` (`16rem`), with
`--cf-code-editor-margin-spacing` (`1rem`) between them. Where the two bases do
not fit side by side, the margin wraps below the text. Nothing there is level
with any line, so the margin is the column as it stands: its children in their
order, none moved.

## How a child is moved

The margin lays its children out as a column and then moves each run of them, a
child that names an anchor with the children under it, by its `translate` style.
The margin owns that property on its children. A host that sets a child's
`style` attribute replaces the `translate` the margin wrote there, and the
margin writes it again, from the next measurement, before the browser paints.

The margin measures in CodeMirror's measure cycle, where the editor's own layout
is read. It measures again whenever the text or its layout changes, the view
scrolls, the anchors or the highlights change, a child is added, removed, or
resized, or a child's `style` or `data-anchor` changes. Where the text at an
anchor lies outside the part of the document CodeMirror has drawn, the margin
places it at the top of its line, by the heights CodeMirror estimates for the
lines above it.

`features/margin.ts` holds the arrangement; `placeMarginGroups()` there is the
placement on its own, free of the page.
