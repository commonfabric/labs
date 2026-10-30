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

| Event                  | Detail                    | When                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf-selection-change`  | `{ from, to, text }`      | The main selection changed, through the user or a dispatch the host made. A caret move with nothing selected is not a change; clearing a selection is, and fires once.                                                                                                                            |
| `cf-highlight-click`   | `{ id }`                  | A mousedown landed on a mark. The editor still places the caret, so the host hears the click without taking the gesture.                                                                                                                                                                          |
| `cf-highlights-mapped` | `{ highlights, version }` | An edit left the set the editor holds different from what the host has: the `highlights` property, or the last report while the host has yet to catch up to it. The detail is the whole set after the edit and, under collaboration, the `{ epoch, version }` of the document it is read against. |

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

Typing can run ahead of that round trip, and a host whose copy of the text is
behind the view can hand back positions read against a document the view has
left: an earlier report, or a range the host re-found in its older text. Setting
those would move the ranges back onto the wrong text, and the next keystroke
would map that wrong position onward. So while the host has yet to catch up to
the last report, a `highlights` value is taken for its ids and kinds only: a
range the view already holds keeps the position the view mapped it to, and one
the view does not hold is added where the host put it. The host has caught up
once its positions agree with the last report for every id both name, and from
then on its values are set as given. While a report is outstanding, a later edit
is reported against it rather than against the property, so an edit undone
before the host answers reports the restored positions and the host ends on
them, and a delayed echo of the undone edit finds the view past it.

The update listener reports in the other direction. After any transaction that
set the selection or changed the document, it emits `cf-selection-change` when
the main range differs, in position or text, from the one last reported, with
one exception: a caret with nothing selected is reported once, when a selection
collapses to it, and not again as it moves. The view maps the selection through
a collaborator's edit as it does through the user's, so a host holding a
selection while others type hears where it moved, and a selection that an edit
shifts onto other text is reported as what it now covers.

The highlight ranges are reported more narrowly. After an edit the listener
compares the field's ranges with what the host holds, the `highlights` property
or the outstanding report, and emits `cf-highlights-mapped` where they differ;
after a whole-document replacement from outside, it pushes the property in again
instead. A collaborator's edit is reported only while a report of this editor's
is outstanding: the host is about to store positions that edit has moved, and
every editor maps the same edits, so two editors that typed at once both report
the same merged positions. With nothing outstanding the collaborator's own
editor speaks for the edit, so a host does not hear one edit once from every
editor open on the document.

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

- **The host decides what is marked.** A range a deletion covers leaves the
  field and the next report, so a value from a host that has yet to see that
  report, still naming the range, agrees with the report on every id both name
  and is set as given: the range reappears where the host has it until the
  host's next value omits it. The editor decides only where a range the host
  names sits.
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
- **A collaborator's edit is reported only over an outstanding report.** The
  field keeps a range on its text through a remote edit, and an editor with
  nothing outstanding emits no `cf-highlights-mapped` for it: the collaborator's
  own editor reports the same edit, and the host's next `highlights` value
  arrives equal to what the field already holds. A host value and a
  collaborator's edit reach an editor on separate paths, so a value read against
  a document the view has yet to receive is set against the text the view has;
  whatever the host keeps beside a range to re-find it is what covers that. The
  selection is the exception: the editor whose selection a remote edit moved is
  the only one that can report it, and does.
