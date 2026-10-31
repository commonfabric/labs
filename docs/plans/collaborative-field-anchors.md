# Anchors on collaborative fields

Comments, highlights and bookmarks on a collaborative text need to say which
text they are about, and the text moves under every edit. An anchor is the
runtime's answer: a range of a collaborative field, under a client-chosen id,
that Memory maps through every integrated operation in the transaction that
integrates it. An annotation names an anchor id and never stores a position;
no client keeps a position current; every writer of the field, an editor or a
handler's `applyChanges()`, moves the anchors because Memory does.

The design is specified in
[`../specs/memory-v2/07-op-views-and-annotations.md`](../specs/memory-v2/07-op-views-and-annotations.md)
(§7.7.4 the `anchor-op` operation, §7.8 storage and the anchors document, §7.15
annotations) and described for readers in
[`../features/collaborative-fields.md`](../features/collaborative-fields.md).
This plan carries what is left to build on top of Memory's part.

## Shape

- **Stored** beside the field head and in every checkpoint, so pruning the
  operation log never loses one.
- **Mapped** by the codec: start with association 1, end with association -1;
  a range an edit empties becomes a point and stays one.
- **Written** by `anchor-op`, which maps the added ranges from the stated base
  to the head; no version advance, no submission id.
- **Delivered** on every operation snapshot and as the derived anchors
  document `of:op-anchors:<hash of { id, scope, path }>`, written in the same
  transaction whenever the set changes, in the field's own scope.
- **Read** from pattern code with `anchorsOf(content)`, a reactive-origin
  runtime call returning the anchors document.
- **Written** from pattern code with `content.addAnchor(id, range, { base? })`
  and `content.removeAnchor(id)`, recorded on the transaction like
  `applyChanges()` and emitted after the field's `apply-op` in the commit.
- The **editor** is a view: under collaboration its highlight positions come
  from the snapshot's anchors, mapped over its pending local edits; the host's
  `highlights` names which ids to draw and with what kind.

## Work packages

### WP1 — Memory: engine, codec, protocol, spec, inspector

- [x] `FieldAnchor`, `AnchorOpOperation`, `AnchorOpResolution`,
      `OperationFieldSnapshot.anchors`, `operationAnchorsDocId` in
      `runtime/memory/v2.ts`.
- [x] `OperationCodec.mapAnchors()` and the CodeMirror rule
      (`runtime/memory/v2/operation-codec.ts`).
- [x] `anchors` and `anchors_seq` on `op_field_epoch`, `anchors` on
      `op_checkpoint`, guarded migration.
- [x] Integration maps the stored set; `anchor-op` activates, maps, merges,
      restates the head-version checkpoint; the anchors document is written
      when the set changes, deleted on release and entity deletion, and refused
      to client writes.
- [x] Prune verifies the checkpoint's anchors against the head unless an
      `anchor-op` restated the set after the checkpoint, and the anchors
      document against the head always.
- [x] Snapshot carries `anchors`; resolutions are replayable.
- [x] State inspector reports anchors, their checkpoint copies, the document
      id and a consistency check.
- [x] Spec §7.1, §7.2, §7.5, §7.5.1, §7.7, §7.7.4, §7.8, §7.9, §7.10, §7.12,
      §7.13, §7.15, §7.16, §7.17; feature doc section.

Completion gate: `deno task test` in `runtime/memory`,
`runtime/state-inspector` and `runtime/cli`; `deno task check`;
`deno task check-docs`.

### WP2 — Runner, API, runtime-client

- [ ] `OpCursor`, `AnchorRange`, `FieldAnchor`, `FieldAnchors` and
      `addAnchor`/`removeAnchor` on `IWritable` in `base/api/index.ts`;
      regenerate `base/static/assets/types/commonfabric.d.ts`.
- [ ] `Cell.addAnchor()` and `Cell.removeAnchor()` beside `applyChanges()`:
      without `base`, a confirmed read of the field and a range check; with
      `base`, no read. Both in `cellMethods`, `WRITER_METHODS` and
      `WRITE_METHODS`.
- [ ] `recordAnchorOps()` on the transaction, an `anchorOps` list on the
      native commit emitted after `applyOps`, refused ahead of a seal and
      omitted under the speculation overlay. An `addAnchor()` without `base`
      followed by `applyChanges()` on the same field in one transaction is
      refused: the runner keeps no mapping of its own.
- [ ] `anchorsOf(content)` builtin returning a link to the anchors document,
      registered in the builtins, the builder, the transformer registry
      (`runtime-call`, reactive origin) and the replayable set.
- [ ] `isUndeclarableIdClass` in `runtime/runner/src/cfc/prepare.ts` admits the
      anchors document prefix, with its case argued.
- [ ] `docs/common/concepts/types-and-schemas/writable.md` section on anchoring
      ranges; the feature doc names the pattern-facing calls.

Completion gate: `deno task test` in `runtime/runner`, `base/ts-transformers`
and `runtime/runtime-client`; `deno task check-commonfabric-types` in
`base/static`; `deno task cfcheck`.

### WP3 — Editor as a view

The code editor's `highlights` surface, its `cf-selection-change` and
`cf-highlights-mapped` events and its `docs/highlights.md` are introduced by
PR #9390, which this package reworks; the items below name that PR's symbols.

- [ ] `highlights` takes `{ id, kind?, from?, to? }`; under collaboration the
      positions are the snapshot's anchors mapped over pending edits.
- [ ] The synchronization snapshot carries anchors, including at an unchanged
      cursor.
- [ ] The `cf-highlights-mapped` report and its outstanding-report machinery
      are removed: the editor no longer maps highlight positions for the host.
- [ ] `cf-selection-change` names the confirmed cursor, with the selection
      mapped back over pending edits, so a handler's `base` is a version
      Memory holds.
- [ ] `docs/highlights.md` describes the view contract.

Completion gate: `deno task deno-test` in `runtime/ui` and the highlights
browser test.

### WP4 — Shared-note comments on anchors

- [ ] A comment's `anchor` becomes `anchorId`; posting adds the anchor against
      the selection's cursor; verbs stop mapping; rows read `anchorsOf()`;
      deleting a comment removes its anchor.
- [ ] Pattern test, baseline, browser integration test, README and catalog
      entry follow.

## Open questions

- **CFC label of the anchors document.** The engine's write carries no `cfc`
  member: a range discloses offsets, not text, and the space ACL gates reads.
  §7.14's label mapper is where a field-level label would be copied onto the
  document if that changes.
- **A stale base epoch in a handler** is a refusal no re-run can fix, so it
  surfaces as a handler error rather than a retry.
