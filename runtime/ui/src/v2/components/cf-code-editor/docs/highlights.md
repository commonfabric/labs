# Highlights in cf-code-editor

A collaborative field can carry anchors. An anchor is a range of the field's
text under an id that a pattern chooses. Memory moves every anchor through every
edit of the field, whoever made the edit, in the same transaction that stores
the edit. `docs/features/collaborative-fields.md` describes anchors, and
`docs/specs/memory-v2/07-op-views-and-annotations.md` §7.7.4 and §7.15 specify
them.

The editor is a view of those anchors. It never decides where an anchor is, and
it never writes one. A host, typically a pattern showing comments, passes the
ids it wants marked, and the editor marks each one where Memory says it is.

## The host's side

```tsx
<cf-code-editor
  $value={content}
  collaborative
  highlights={[{ id: "comment-1", kind: "active" }, { id: "comment-2" }]}
  oncf-selection-change={trackSelection({ selection })}
  oncf-highlight-click={selectComment({ selected })}
/>;
```

- `highlights` lists the anchor ids to mark. Each mark is a span with the class
  `cm-highlight` and a `data-highlight-id` attribute naming the id. A `kind`
  made of lowercase letters, digits and hyphens adds the class
  `cm-highlight-<kind>`. The editor styles `cm-highlight-active` more strongly
  than the others.
- An id the field has no anchor for marks nothing. An anchor whose text an edit
  deleted is a point, and a point marks nothing either.
- `cf-highlight-click` fires with `{ id }` when a primary-button press lands on
  a mark, naming the innermost mark under the pointer. The press still places
  the caret.
- `cf-selection-change` fires with `{ from, to, text, base }` when the
  person changes the main selection. The range is stated against the text at
  `base`, which is the field version Memory last confirmed to this editor. A
  handler can pass the range and `base` to `addAnchor()` unchanged, and Memory
  maps the range from `base` to whatever the field holds when the handler's
  commit lands. `text` is the selected text, for showing to the person.

## Where the marks come from

The collaboration controller (`codemirror-collaboration.ts`) keeps the field's
anchors as they stand at the version it has confirmed:

- Installing a snapshot takes the snapshot's anchors.
- A snapshot that integrates operations takes its anchors, which are stated at
  the version the snapshot ends at.
- A snapshot at the version the controller already holds can still carry a
  different set, because an operation that only adds or removes anchors advances
  no version. The controller takes that set and tells its observers.
- An apply response carries operations and no anchors. The controller moves its
  anchors through those operations with `mapAnchorRange()`, the rule Memory's
  codec applies, until the next snapshot states them again.

Each synchronization snapshot the controller publishes carries these anchors.
The editor maps them over the edits it has not yet had confirmed, again with
`mapAnchorRange()`, and stores the result in `highlightField`
(`features/highlights.ts`). Between snapshots the field moves each range through
every transaction by the same rule, so a mark follows typing at once and the
next snapshot replaces it with Memory's answer.

## How a selection becomes a confirmed range

Local typing reaches Memory a moment after it appears in the editor. Until
Memory confirms it, the editor's text and the text at the confirmed version
differ. `selectionReport()` restates the selection against the confirmed text by
running the pending edits backwards:

- A selection with no pending edits inside it maps exactly, and is reported with
  `base` set to the confirmed version.
- A selection that covers a pending edit has no range in the confirmed text. It
  is reported as nothing selected, with `from === to`. When Memory confirms the
  edit, the editor reports the selection again, now with a range.
- Outside collaboration, or before the field's first collaborative edit, there
  is no confirmed version. The range is the editor's own and `base` is `null`. A
  handler given such a range reads the field and checks that it still holds
  `text` at that range before anchoring it.

Every empty selection is reported as the same value, so moving the caret while
typing fires nothing. A selection is reported when the person makes it. Its
`base` stays valid as Memory confirms later versions, because Memory maps a
range from any version it still holds, so a remote edit wakes no handler through
this event. Memory holds at least its operation checkpoint interval of history,
100 operations by default. A selection held until its `base` is 32 versions
behind the confirmed version, or in an earlier epoch, is reported again against
the newer version, so a selection the person makes and acts on later still names
a version Memory holds.
