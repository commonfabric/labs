# Highlights and selection in cf-code-editor

A host can mark ranges of the document and hear about the selection. The editor
draws each range, keeps it on the text it was placed over while the text
changes, and tells the host what it heard and where the ranges moved. The host
owns the meaning: a comment anchored to a sentence, a search hit, a suggestion
are all a `HighlightRange` to the editor.

```text
highlights = [{ id: "c1", from: 6, to: 11 }]

"hello world"
       ^^^^^  ← a <span class="cm-highlight" data-highlight-id="c1">
```

## The surface

The `highlights` property takes `HighlightRange[]`, each
`{ id, from, to, kind? }` in the coordinates of the document the host read.
Setting it replaces the whole set. A range past the end of the document is
clamped, and one that is empty after that is dropped.

Three events come back, each a `CustomEvent` with the detail named:

| Event                  | Detail               | When                                                                                                                                                                   |
| ---------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf-selection-change`  | `{ from, to, text }` | The main selection changed, through the user or a dispatch the host made. A caret move with nothing selected is not a change; clearing a selection is, and fires once. |
| `cf-highlight-click`   | `{ id }`             | A mousedown landed on a mark. The editor still places the caret, so the host hears the click without taking the gesture.                                               |
| `cf-highlights-mapped` | `{ highlights }`     | A local edit moved or resized the ranges, so the set the editor holds no longer equals the `highlights` property. The detail is the whole set after the edit.          |

## The two CM6 building blocks

### `StateField` — the ranges and their marks (`highlightField`)

`features/highlights.ts` keeps the ranges in a `StateField`. On every
transaction the field maps each range through the transaction's changes first,
then applies the transaction's effects. Mapping is what keeps a range on its
text: an insertion before a range moves it, one inside it grows it, a deletion
overlapping it shrinks it, and a deletion covering it drops it. Text inserted at
either end of a range stays outside it, which is how a mark decoration maps too.
Two effects change the set: `setHighlightsEffect` replaces it, read against the
document the transaction produces, and `clearHighlightsEffect` empties it.

The field rebuilds a `DecorationSet` of `Decoration.mark` ranges whenever its
ranges change and provides it through `EditorView.decorations`. Each mark
carries `cm-highlight`, `cm-highlight-<kind>` when the range has a `kind`, and
the id as `data-highlight-id`. `highlightTheme` paints `cm-highlight` as a
translucent wash and `cm-highlight-selected` as a stronger one; a host with
other kinds styles their classes itself.

### The component — pushing in and reporting out

`cf-code-editor` dispatches `setHighlightsEffect` when the `highlights` property
changes, unless the field already holds the same ranges by value. That
comparison is what keeps a host and an editor from echoing at each other: the
host hands back what `cf-highlights-mapped` reported, the editor sees no
difference, and nothing is dispatched.

The update listener reports in the other direction. After a transaction of the
user's or the host's that set the selection, it emits `cf-selection-change` for
the main range. After a local edit it compares the field's ranges with the
`highlights` property and emits `cf-highlights-mapped` where they differ; after
a whole-document replacement from outside, it pushes the property in again
instead. A remote collaborator's edit is mapped but not reported: only the
editor that made an edit speaks for it, so two editors never hand a host two
positions for one range.

The mousedown handler that routes clicks on mention pills also looks for a
`data-highlight-id` ancestor and emits `cf-highlight-click` for it, without
preventing the default, so the caret still lands where the click did.

## How the layers fit together

```text
host.highlights ──► setHighlightsEffect ──► highlightField ──► decorations
                                                │
user edits ────► transaction.changes ──► mapped ranges
                                                │
                              differ from host.highlights?
                                                │ yes
                              cf-highlights-mapped { highlights } ──► host
```

## Bounds

- **Mapping is per open editor.** A range is mapped by the editor that holds it.
  An edit made with no editor open, such as a handler's `applyChanges()`,
  reaches the host as a changed document and nothing else; the host has to find
  the range in the new text itself.
- **A whole-document replace resets the set.** When the bound cell replaces the
  document rather than editing it, every range maps to nothing. The editor sets
  the `highlights` property's ranges again in the same transaction, read against
  the new text, so the host's ranges survive if they were right for it. A
  collaboration snapshot installing is handled the same way, whether it arrives
  into an empty editor or over text the cell mirrored first: any whole-document
  replacement that is not the user's own typing sets the host's ranges again.
- **A collaborator's edit is mapped silently.** The field keeps a range on its
  text through a remote edit, and the editor reports nothing. The collaborator's
  own editor reports the same edit to the host, and the host's next `highlights`
  value arrives equal to what the field already holds.
