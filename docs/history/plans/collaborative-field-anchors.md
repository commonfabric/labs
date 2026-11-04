---
status: historical
created: 2026-11-03
archived: 2026-11-03
reason: "Every work package landed; anchors are described live in docs/features/collaborative-fields.md"
---

# Anchors on collaborative fields

Comments, highlights and bookmarks on a collaborative text need to say which
text they are about, and the text moves under every edit. An anchor is the
runtime's answer: a range of a collaborative field, under a client-chosen id,
that Memory maps through every integrated operation in the transaction that
integrates it. An annotation names an anchor id and never stores a position;
no client keeps a position current; every writer of the field, an editor or a
handler's `applyChanges()`, moves the anchors because Memory does.

The design is specified in
[`../specs/memory-v2/07-op-views-and-annotations.md`](../../specs/memory-v2/07-op-views-and-annotations.md)
(§7.7.4 anchors on an operation, §7.8 storage and the anchors document, §7.15
annotations) and described for readers in
[`../features/collaborative-fields.md`](../../features/collaborative-fields.md).
This plan carries what is left to build on top of Memory's part.

## Shape

- **Stored** beside the field head and in every checkpoint, so pruning the
  operation log never loses one.
- **Mapped** by the codec: start with association 1, end with association -1;
  a range an edit empties becomes a point and stays one.
- **Written** by the `anchors` member of an `apply-op`, whose added ranges
  are stated against the client's document, the base with the payload applied,
  and mapped to the head; an operation whose payload changes nothing changes
  anchors alone and advances no version.
- **Delivered** on every operation snapshot and as the derived anchors
  document `of:op-anchors:<hash of { id, scope, path }>`, written in the same
  transaction whenever the set changes, in the field's own scope.
- **Read** from pattern code with `anchorsOf(content)`, a reactive-origin
  runtime call returning the anchors document.
- **Written** from pattern code with `content.addAnchor(id, range, { base? })`
  and `content.removeAnchor(id)`, recorded on the transaction like
  `applyChanges()` and carried on the field's `apply-op` in the commit, or on
  one with an empty payload when the transaction changed no text.
- The **editor** is a view: under collaboration its highlight positions come
  from the snapshot's anchors, mapped over its pending local edits; the host's
  `highlights` names which ids to draw and with what kind.

## Work packages

### WP1 — Memory: engine, codec, protocol, spec, inspector

- [x] `FieldAnchor`, `FieldAnchorChanges`, `ApplyOpOperation.anchors`,
      `ApplyOpResolution.anchors`, `OperationFieldSnapshot.anchors`,
      `operationAnchorsDocId` in `runtime/memory/v2.ts`.
- [x] `OperationCodec.mapAnchors()`, the anchors `integrate()` maps across its
      rebase, and the CodeMirror rule (`runtime/memory/v2/operation-codec.ts`).
- [x] `anchors` and `anchors_seq` on `op_field_epoch`, `anchors` on
      `op_checkpoint` and `op_submission`, guarded migration.
- [x] Integration maps the stored set and the carried adds, merges, restates
      the head-version checkpoint; the anchors document is written when the
      set changes, deleted on release and entity deletion, and refused to
      client writes.
- [x] Prune verifies the checkpoint's anchors against the head unless an
      operation changed anchors in the checkpoint's commit or later, and the
      anchors document against the head always.
- [x] Snapshot carries `anchors`; resolutions are replayable.
- [x] State inspector reports anchors, their checkpoint copies, the document
      id and a consistency check.
- [x] Spec §7.1, §7.2, §7.5, §7.5.1, §7.7, §7.7.4, §7.8, §7.9, §7.10, §7.12,
      §7.13, §7.15, §7.16, §7.17; feature doc section.

Completion gate: `deno task test` in `runtime/memory`,
`runtime/state-inspector` and `runtime/cli`; `deno task check`;
`deno task check-docs`.

### WP2 — Runner, API, runtime-client

- [x] `OpCursor`, `AnchorRange`, `FieldAnchor`, `FieldAnchors` and
      `addAnchor`/`removeAnchor` on `IWritable` in `base/api/index.ts`;
      regenerate `base/static/assets/types/commonfabric.d.ts`.
- [x] `Cell.addAnchor()` and `Cell.removeAnchor()` beside `applyChanges()`:
      without `base`, a confirmed read of the field and a range check against
      the value the transaction's changes to the field yield; with `base`, no
      read in the commit's conflict set. Both in `cellMethods`,
      `WRITER_METHODS` and `WRITE_METHODS`.
- [x] `recordAnchorChanges()` on the transaction, folded into the field's
      `apply-op` on the native commit, or into one with an empty payload when
      the transaction changed no text, refused ahead of a seal and omitted
      under the speculation overlay. An anchor added after the transaction's
      text changes is stated against their result, which the runner holds; one
      added before them rides an operation with an empty payload ahead of
      theirs, which Memory moves through them.
- [x] `anchorsOf(content)` builtin returning a link to the anchors document,
      registered in the builtins, the builder, the transformer registry
      (`runtime-call`, reactive origin) and the replayable set.
- [x] `isUndeclarableIdClass` in `runtime/runner/src/cfc/prepare.ts` admits the
      anchors document prefix, with its case argued.
- [x] `docs/common/concepts/types-and-schemas/writable.md` section on anchoring
      ranges; the feature doc names the pattern-facing calls.

Completion gate: `deno task test` in `runtime/runner`, `base/ts-transformers`
and `runtime/runtime-client`; `deno task check-commonfabric-types` in
`base/static`; `deno task cfcheck`.

### WP3 — Editor as a view

PR #9390, which introduced a `highlights` surface whose positions the editor
mapped and reported back to the host, did not land; this package built the
view directly on `main` instead.

- [x] `highlights` takes `{ id, kind? }`; the positions are the anchors of the
      latest operation snapshot, mapped over pending edits with Memory's own
      `mapAnchorRange()`, and moved through each transaction by the same rule
      until the next snapshot restates them.
- [x] The synchronization snapshot carries anchors, including at an unchanged
      cursor; an apply response moves them through the operations it carries.
- [x] The editor reports no highlight positions to the host; no
      `cf-highlights-mapped` event exists.
- [x] `cf-selection-change` names the confirmed cursor as `base`, with the
      selection mapped back over pending edits. A selection covering an edit
      not yet confirmed is reported as nothing selected until Memory confirms
      it.
- [x] `cf-highlight-click` names the clicked anchor.
- [x] `runtime/ui/src/v2/components/cf-code-editor/docs/highlights.md`
      describes the view contract.

### WP4 — Shared-note comments on anchors

- [x] A comment is a keyed record whose id is its anchor's id; posting adds
      the anchor against the selection's `base`, in the commit that stores the
      comment; the body verbs do no mapping; rows read `anchorsOf()`; deleting
      a comment removes its anchor.
- [x] Comments and replies are `AuthoredByCurrentUser` records written only by
      the handlers their policies name; replies and the resolved state are
      cells the comment links.
- [x] Pattern test, baseline, browser integration test, README and catalog
      entry.

## Outcome

Every work package landed. Two of the open questions were settled by WP3: a
stale base surfaces as the handler's commit failing, and the editor offers
the handler route, reporting a selection over unconfirmed text as nothing
selected until Memory confirms it. The CFC label of the anchors document
remains open and is listed among the deferred decisions of
`docs/specs/memory-v2/07-op-views-and-annotations.md` §7.17.

## Open questions

- **CFC label of the anchors document.** The engine's write carries no `cfc`
  member: a range discloses offsets, not text, and the space ACL gates reads.
  §7.14's label mapper is where a field-level label would be copied onto the
  document if that changes.
- **A stale base epoch in a handler** is a refusal no re-run can fix, so it
  surfaces as a handler error rather than a retry.
- **Anchoring text still pending in the editor.** An anchor rides the
  `apply-op` that inserts its text, so the editor can anchor a selection over
  text it has not yet confirmed by sending the anchor on its own next
  submission, which needs the host to hand it the anchor id; the handler route
  instead maps the selection back over pending edits, as WP3 states, and
  cannot anchor the pending text. WP3 decides which the editor offers.
