# Highlights in cf-code-editor

A collaborative field carries anchors. An anchor is a point in the field's text,
held as an offset under an id that a pattern chooses. Memory moves every anchor
through every edit of the field, whoever made the edit, in the same transaction
that stores the edit. `docs/features/collaborative-fields.md` describes anchors,
and `docs/specs/memory-v2/07-op-views-and-annotations.md` §7.7.4 and §7.15
specify them.

A highlight is the text from one anchor to another. The editor is a view of the
field's anchors: it never decides where an anchor is, and it never writes one. A
host, typically a pattern showing comments, names the pairs of anchors it wants
marked, and the editor marks the text between each pair where Memory says the
two anchors are.

## The host's side

```tsx
<cf-code-editor
  $value={content}
  collaborative
  highlights={[
    {
      id: "comment-1",
      fromAnchor: "comment-1:from",
      toAnchor: "comment-1:to",
      kind: "active",
    },
    { id: "comment-2", fromAnchor: "comment-2:from", toAnchor: "comment-2:to" },
  ]}
  oncf-selection-change={trackSelection({ selection })}
  oncf-highlight-click={selectComment({ selected })}
/>;
```

- `highlights` lists the ranges to mark. Each entry is
  `{ id, fromAnchor, toAnchor, kind? }`. `fromAnchor` and `toAnchor` are ids in
  the field's anchors, the map that `anchorsOf(field)` reads and writes, and the
  mark covers the text from the first anchor's offset up to the second's. `id`
  names the highlight and can be any string the host chooses.
- Each mark is a span with the class `cm-highlight` and a `data-highlight-id`
  attribute holding the entry's `id`. A `kind` made of lowercase letters, digits
  and hyphens adds the class `cm-highlight-<kind>`. The editor styles
  `cm-highlight-active` more strongly than the others.
- An entry marks nothing when the field holds no anchor under `fromAnchor` or
  under `toAnchor`, and when the second anchor is not after the first. The
  second case is how deleted text shows: an edit that deletes the text of a
  highlight leaves both anchors at one offset.
- An anchor's offset can lie past the end of the text, because Memory does not
  check an offset against the field when a pattern writes it. The editor treats
  such an anchor as one at the end of the text.
- `cf-highlight-click` fires with `{ id }`, the `id` of the entry, when a click
  lands on a mark: a press and release of the primary button that leaves nothing
  selected. The press still places the caret.
  [Which presses are clicks](#which-presses-are-clicks) says which presses count
  and which mark a click lands on.
- `cf-selection-change` fires with `{ from, to, text }` when the main selection
  changes. The range is stated against the text Memory last confirmed to this
  editor, and `text` is the whole of the text that range holds. Nothing selected
  is reported as `from === to`.
- The marks need a collaboration that is running. The editor clears them when
  collaboration fails or ends, and draws none while `collaborative` is off.

A handler that turns a selection into a highlight reads the field, checks that
it still holds `text` at `[from, to)`, and writes the two offsets into the
field's anchors under two ids of its choosing. The check matters because the
field can change between the report and the handler's run. "Anchoring text" in
`docs/common/concepts/types-and-schemas/writable.md` shows such a handler and
explains when its commit is refused and run again.

## Where the marks come from

The collaboration controller (`codemirror-collaboration.ts`) keeps the field's
anchors, a map from anchor id to offset, as they stand in the confirmed text:
the text Memory has confirmed to this editor. For a field that has been edited
collaboratively, that is the field's text at the version the controller has
confirmed. A field nobody has edited collaboratively has no version, and its
confirmed text is the value it stores. Memory's snapshot of such a field carries
its anchors all the same, so a highlight a pattern places on a note nobody has
typed in is drawn like any other.

- Installing a snapshot takes the snapshot's anchors, whether or not the field
  has a version.
- A snapshot that integrates operations takes its anchors, which are stated at
  the version the snapshot ends at.
- A snapshot that leaves the confirmed text as it is can still carry different
  anchors, because a write to the field's anchors advances no version. That
  holds at the version the controller already holds and for a field with no
  version. The controller takes those anchors and tells its observers.
- An apply response carries operations and no anchors. The controller moves each
  anchor through those operations with `mapAnchor()`, the rule Memory's codec
  applies, until the next snapshot states them again.

The controller publishes a synchronization snapshot from the first snapshot of
the field it installs: the confirmed version, which is `null` for a field
without one, the edits Memory has not confirmed, and these anchors. The editor
maps each offset over the unconfirmed edits, again with `mapAnchor()`, and
stores the result in `highlightField` (`features/highlights.ts`). Between
snapshots the field moves each offset through every transaction by the same
rule, so a mark follows typing at once and the next snapshot replaces the
offsets with the ones Memory holds.

The first collaborative edit gives the field its version. While the apply that
carries it is in flight, the edit is one of the unconfirmed edits and the
anchors are still stated against the stored value, so the marks stay where the
typing moved them. The apply response then moves the anchors through the edit as
it does at any later version. Presence is stated against a version, so the
editor joins its presence room once the field has one.

`mapAnchor()` moves an anchor as a cursor moves. Text inserted at an anchor
lands after it, so the anchor stays where it is. An anchor inside deleted text
lands where the deletion began. The two anchors of a highlight move by that one
rule, each on its own, which gives a highlight its edges. With "Hello" and a
highlight over "el", from offset 1 to offset 3:

| Edit             | Anchors after | The mark covers                                     |
| ---------------- | ------------- | --------------------------------------------------- |
| Insert "XY" at 1 | 1 and 5       | "XYel": text typed at the start joins the highlight |
| Insert "XY" at 3 | 1 and 3       | "el": text typed at the end stays outside it        |
| Delete "el"      | 1 and 1       | nothing                                             |

## How a selection becomes a confirmed range

Local typing reaches Memory a moment after it appears in the editor. Until
Memory confirms it, the editor's text and the confirmed text differ.
`selectionReport()` restates the selection against the confirmed text by running
the pending edits backwards:

- A selection with no pending edits inside it maps exactly. It is reported as
  the range the same text has in the confirmed text.
- A selection that covers a pending edit has no range in the confirmed text. It
  is reported as nothing selected, with `from === to`. When Memory confirms the
  edit, the editor reports the selection again, with a range.
- A field with no collaborative edit has the value it stores as its confirmed
  text, and its selections map the same way.
- Outside collaboration there is no confirmed text, and the range is the
  editor's own.

The editor restates the selection whenever the selection changes and whenever
the confirmed text does, and fires the event when the report differs from the
last one it sent. Every empty selection is the same report, so moving the caret
while typing fires nothing. An edit that leaves a held selection's range where
it was, such as one made after it, fires nothing either. An edit that moves or
changes the range, such as a collaborator typing before it, fires the event with
the range the selection has in the newer text, so the last report a handler
received names where the selected text is in the text Memory has confirmed to
this editor.

A new editor has sent no report, so its first one is always sent, and says that
nothing is selected. A host that keeps the last report somewhere that outlives
the editor is told that way that the selection it kept is gone.

Each event carries the selected text in full. The editor sends one on each
change of the selection, and again each time a confirmed edit moves a selection
the person is holding, so a host that stores every report writes the whole of
the selected text each time. Dragging out a long selection sends a report, each
longer than the last, for every step of the drag.

## Which presses are clicks

`cf-highlight-click` fires on the browser's `click` event, which follows the
release of the primary button, and only when the editor's main selection is then
empty. A press that drags out a selection is therefore a selection and not a
click, even when it starts on a mark, which is what lets a person select text
inside one highlight to place another. A press that extends a selection, such as
a shift-click or the second press of a double-click, is not a click either. A
plain click on a mark that lies inside a selection is one: the editor collapses
the selection to a caret before the click is read.

A click is on a highlight when the character under the pointer is inside the
highlight's range. CodeMirror resolves a point to the nearest position between
two characters and says which side of that position the point is on, and
`characterAt()` reads the character from the two: the one after the position for
a point on a character's left half, the one before it for a point on the right
half. Both halves of a highlight's last character therefore count, and neither
half of the character after it does.

CodeMirror resolves a point beside the text the same way, so `characterAt()`
checks the character it found against the point. A click past the end of a line,
or above or below the document's lines, is on no character and reports nothing.

Where highlights overlap, the click names the innermost one: the shortest range
that holds the character, and the earlier-starting of two the same length.
