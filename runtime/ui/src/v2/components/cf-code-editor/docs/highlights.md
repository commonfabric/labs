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
Setting it replaces the whole set: which ids are marked, in what order, and with
what kind. Where a range the editor already holds sits is the editor's to say,
as the next section explains. A range past the end of the document is clamped.

Three events come back, each a `CustomEvent` with the detail named:

| Event                  | Detail                        | When                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf-selection-change`  | `{ from, to, text, version }` | The main selection changed, through the user, a dispatch the host made, or an edit of anyone's that moved it. A caret move with nothing selected is not a change; clearing a selection is, and fires once. Under collaboration, `version` is the `{ epoch, version }` of the document the range is read against.                                                     |
| `cf-highlight-click`   | `{ id }`                      | A mousedown landed on a mark. The editor still places the caret, so the host hears the click without taking the gesture.                                                                                                                                                                                                                                             |
| `cf-highlights-mapped` | `{ highlights, version }`     | An edit left the set the editor holds different from what the host has: the `highlights` property, or the last report while the host has yet to catch up to it. The detail is the whole set after the edit, a range whose text the edit deleted among them as an empty range, and, under collaboration, the `{ epoch, version }` of the document it is read against. |

## The two CM6 building blocks

### `StateField` — the ranges and their marks (`highlightField`)

`features/highlights.ts` keeps the ranges in a `StateField`. On every
transaction the field maps each range through the transaction's changes first,
then applies the transaction's effects. Mapping is what keeps a range on its
text: an insertion before a range moves it, one inside it grows it, a deletion
overlapping it shrinks it, and a deletion covering it empties it. Text inserted
at either end of a range stays outside it, which is how a mark decoration maps
too. An emptied range is not dropped: it stays in the set as a point, `from`
equal to `to`, kept before text inserted at it, so that the host hears its text
is gone and decides what to do with it. Two effects change the set:
`setHighlightsEffect` replaces it, read against the document the transaction
produces, and `clearHighlightsEffect` empties it.

The field rebuilds a `DecorationSet` of `Decoration.mark` ranges for its
non-empty ranges whenever its ranges change and provides it through
`EditorView.decorations`. An empty range has no text to mark. Each mark carries
`cm-highlight`, `cm-highlight-<kind>` when the range has a `kind`, and the id as
`data-highlight-id`. `highlightTheme` paints `cm-highlight` as a translucent
wash and `cm-highlight-selected` as a stronger one; a host with other kinds
styles their classes itself.

### The component — pushing in and reporting out

`cf-code-editor` dispatches `setHighlightsEffect` when the `highlights` property
changes, with the value's ids, order, and kinds, and with the view's own
position for every range the view already holds. A range the view does not hold
is added where the host put it. Nothing is dispatched when that leaves the field
as it is, which is what keeps a host and an editor from echoing at each other:
the host hands back what `cf-highlights-mapped` reported, the editor sees no
difference, and nothing is dispatched.

The view's position wins for a range it holds because the view has mapped that
range through every edit it has received, and the host's position for it is at
best the same and otherwise read against a document the view has left. Typing
runs ahead of the report round trip, so a value may hand back an earlier report.
A host that moved a range itself, by making an edit to the document and mapping
the range through it, hands the result to a view that maps that same edit when
it reaches it, before or after the value does; either order ends with the view's
own mapping. Setting the host's position in these cases would put the range on
the wrong text, and the next keystroke would map that wrong position onward. A
host that wants a range somewhere else gives it a new id. A value that places
every id the last report also names where the report placed it is the host
caught up to that report, which ends the reporting of collaborators' edits
described below. While a report is outstanding, a later edit is reported against
it rather than against the property, so an edit undone before the host answers
reports the restored positions and the host ends on them, and a delayed echo of
the undone edit finds the view past it.

The update listener reports in the other direction. After any transaction that
set the selection or changed the document, it emits `cf-selection-change` when
the main range differs, in position or text, from the one last reported, with
one exception: a caret with nothing selected is reported once, when a selection
collapses to it, and not again as it moves. The view maps the selection through
a collaborator's edit as it does through the user's, so a host holding a
selection while others type hears where it moved, and a selection that an edit
shifts onto other text is reported as what it now covers. Under collaboration
the event names the version of the document the range is read against, so a host
that stores the range beside the text's history can say which version it belongs
to.

The highlight ranges are reported the same way. After an edit the listener
compares the field's ranges with what the host holds, the `highlights` property
or the outstanding report, and emits `cf-highlights-mapped` where they differ;
after a whole-document replacement from outside, it pushes the property in again
instead. Whose edit it was makes no difference: a collaborator's edit is
reported by every editor it reaches. Each editor maps it against its own
document, and when two people type at once only an editor holding both edits can
report where they leave the ranges together, so no editor can leave that to
another. A host therefore hears one edit from every editor open on the document,
and the version each report carries is what lets it set the duplicates aside.

Under collaboration each report also names the document it is read against: the
collaborative field's `{ epoch, version }`, with the confirmed version advanced
by this editor's own edits Memory has yet to confirm. Two editors that have
received the same updates and have nothing pending name the same version; one
with edits pending names a version the field has yet to reach, and two editors
with different edits pending can name one version for different text. A host
that stores reported positions can be handed reports out of order, a write of
its own that lost a race re-run after the winner's write among them, and the
version is what lets it refuse a report not later than the one it holds, as a
receiver of presence discards a selection for a version that has passed.

The mousedown handler that routes clicks on mention and backlink pills also
looks for a `data-highlight-id` ancestor and emits `cf-highlight-click` for it,
without preventing the default, so the caret still lands where the click did.
The pills come first: a click on a pill that sits inside a highlight navigates
as a pill click does and emits nothing for the highlight.

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

- **The host decides what is marked; the editor decides where.** A range whose
  text a deletion covered stays in the field as an empty range and is reported
  so, and a value from a host that has yet to see that report, still naming the
  range where it was, leaves it empty: the view holds it, so the view's position
  stands. The range is gone once the host's value omits it. A host cannot move a
  range the view holds; it names a new id for a new place.
- **Mapping is per open editor.** A range is mapped by the editor that holds it.
  An edit made with no editor open, such as a handler's `applyChanges()`,
  reaches the host as a changed document and nothing else; a host that keeps
  ranges maps them through that edit itself, with the rule the field applies,
  and an editor that later opens on the document places them as given.
- **A range the view does not hold is placed in the text the view has.** A host
  adds a range with positions read against the document as the host had it. An
  editor whose document differs at that moment, by an edit in flight either way,
  sets the range against its own text and maps it onward from there, and nothing
  re-finds it. The host's selection report, and the version it names, is what
  lets a host place a new range against the text the editor showed.
- **A whole-document replace resets the set.** When the bound cell replaces the
  document rather than editing it, every range maps to an empty one. The editor
  sets the `highlights` property's ranges again in the same transaction, as
  given, read against the new text, so the host's ranges survive if they were
  right for it. A collaboration snapshot installing is handled the same way,
  whether it arrives into an empty editor or over text the cell mirrored first:
  any whole-document replacement that is not the user's own typing sets the
  host's ranges again.
- **Every editor reports every edit that moves a range.** A host with several
  editors open hears one collaborator's edit from each of them, with the same
  positions and, with nothing pending in any of them, the same version. A host
  that stores positions takes the first and sets the rest aside by version; a
  host that cannot tell them apart pays for the duplicates.
