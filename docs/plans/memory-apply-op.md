# Memory `apply-op` — Implementation Plan

Status: In progress — CodeMirror collaboration and operational hardening implemented

Implementation checkpoint:

- Implemented: versioned codec registry and CodeMirror codec; negotiated wire
  types; atomic Memory persistence, integration, deduplication,
  materialization, release, stable op ids, and schema migration; direct
  query/watch delivery; codec-neutral runner and runtime-client transport; and
  opt-in `cf-code-editor` collaboration with explicit reconciliation events.
- Focused tests cover concurrent stale-base rebase, replay and submission
  deduplication, ordinary-write exclusion, entity deletion, migration, Memory
  session delivery, runner capability propagation, runtime-client IPC, and the
  pure CodeMirror adapter.
- Complete Memory, runner, runtime-client, patterns, and UI package suites pass,
  as does the focused two-browser collaboration integration suite. Formatting,
  lint, type checking, documentation, and policy checks pass.
- Exhaustive malformed/rollback, reconnect/watch-race, two-browser convergence,
  checkpoint/reset/retention, default-branch policy, metrics, benchmarks, and
  state-inspector coverage are implemented. A synthetic structured codec is
  exercised without product coupling. The range-oriented CFC and future rich-
  text readiness reviews remain intentionally deferred.

This plan implements
[Collaborative Operations, Views, and Anchors](../specs/memory-v2/07-op-views-and-annotations.md).
The specification defines the behavior and invariants; this document defines
the dependency order, concrete code seams, tests, and completion gates. If code
or a work package conflicts with the specification, stop and update the design
explicitly rather than introducing a runtime-side compatibility log.

CodeMirror is the first vertical slice. WordGard or another rich-text editor is
not part of the initial implementation, but every work package must preserve
the editor-neutral codec boundary needed for that later integration.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a work package complete only after its focused tests and completion gate
pass. Keep this plan current as work lands. Archive it under
`docs/history/plans/` when the final package is complete.

## How to execute this plan

- Work in numbered order. A package may be split into smaller PRs, but do not
  combine nonadjacent packages in one PR.
- Use red/green TDD for each behavioral slice: land a focused failing test,
  confirm the intended failure, implement the smallest coherent change, and
  then refactor.
- Keep the Memory codec and engine tests independent of the browser. Browser
  integration begins only after the protocol and runtime session are complete.
- Do not use sleeps or retry loops in tests. Await commit verdicts, session sync
  effects, or explicit test-harness events.
- Run the complete test task for every touched package before completing a work
  package. Run repository-wide format, lint, type, documentation, dependency,
  and conflict-marker gates before review.
- Treat codec ids, operation payloads, stored rows, cursors, and receipts as
  versioned wire/storage formats. A shape change requires a spec update and
  encode/decode fixtures.

## Fixed design constraints

- [x] Integration and canonical ordering happen in the Memory commit engine,
      never in `runtime-client`, a UI component, or a hidden sibling Cell.
- [x] `apply-op` is a top-level `Operation`; it is not a `PatchOp` variant.
- [x] The engine persists an ordinary derived patch revision so existing entity
      reads, point-in-time reconstruction, graph queries, and scheduler
      invalidation remain unchanged.
- [x] Submitted rows, integrated rows, field cursor advancement, operation
      resolution, and materialized revision are one SQLite transaction.
- [x] A server executes only locally registered, version-pinned codecs. No wire
      request can provide executable transform code.
- [x] Product synchronization uses integrated operations. Submitted operations
      are an audit/debug projection, not the source editors replay.
- [x] Every cursor includes both epoch and version.
- [x] Whole-value writes cannot silently reset an active collaborative field.
- [x] The runner-facing collaboration surface is codec-neutral. CodeMirror
      imports remain in the CodeMirror codec and UI adapter.
- [x] Integrated retention advances only after checkpoint reset behavior is
      tested end to end; submitted history remains durable.

## Failure taxonomy

Define typed failures before implementing the write path. The exact names may
change during review, but each category must stay distinguishable across the
Memory response boundary:

| Failure | Meaning | Client response |
| --- | --- | --- |
| `UnsupportedOpCodecError` | Server does not have the requested codec id | Disable collaborative mode; never fall back to whole-value sync |
| `OpFieldBaselineMismatchError` | First apply was authored against a different baseline | Fetch a fresh field snapshot and reinitialize or reconcile |
| `OpCursorMismatchError` | Epoch is wrong or version is ahead of the server | Fetch a fresh snapshot |
| `OpSubmissionMismatchError` | Submission id was reused with different content | Surface a non-retryable protocol error |
| `OpHistoryUnavailableError` | Required transform suffix predates retained history or exceeds a hard bound | Reset from a checkpoint/snapshot |
| `OpFieldWriteConflictError` | Ordinary set/patch would change an active field | Release deliberately or author an `apply-op` |
| `OpCodecError` | Codec rejected or could not deterministically integrate the payload | Surface a non-retryable payload error |

The first failing tests for every package should assert error names as well as
messages so serialization cannot collapse the taxonomy into generic
`TransactionError` failures.

---

## WP0 — Contract fixtures and scenario harness

Purpose: pin the cross-layer examples before production implementation.

- [x] Add shared JSON fixtures for one string baseline, two concurrent
      CodeMirror submissions, their canonical integration, materialized string,
      cursors, op ids, and receipt.
- [x] Add malformed fixtures: unknown codec, null/non-null cursor mismatch,
      future version, wrong epoch, duplicate id with changed payload, invalid
      `ChangeSet`, and oversized batch.
- [x] Add a scenario fixture for activation racing an ordinary write; the
      baseline hash must fail rather than applying an edit to the wrong text.
- [x] Add inactive-watch fixtures for an ordinary baseline change, activation,
      release, and entity deletion.
- [x] Add a scenario fixture for release followed by an ordinary replacement
      and a later new epoch.
- [x] Record the exact CodeMirror payload version and dependency pin in the
      fixture metadata.

Likely files:

- `packages/memory/test/fixtures/apply-op/`
- `packages/memory/test/v2-apply-op-fixtures.test.ts`

Completion gate:

- [x] Fixture validation is green and no production codec or storage behavior
      has been added yet.

## WP1 — Editor-neutral codec contract and CodeMirror codec

Purpose: prove deterministic integration without involving persistence or the
wire protocol.

- [x] Add the codec types, registry, size limits, and registry lookup under
      `packages/memory/v2/op-codec.ts`.
- [x] Make registration reject duplicate ids and ids without an explicit
      version suffix.
- [x] Implement the CodeMirror codec under
      `packages/memory/v2/op-codecs/codemirror.ts` using
      `@codemirror/state` and `@codemirror/collab`.
- [x] Decode all JSON into fresh trusted values; do not retain mutable request
      objects inside a codec result.
- [x] Reject CodeMirror effects/selections in v1 and accept client id,
      `ChangeSet` JSON, and an optional deterministic rewrite dedupe id.
- [x] Return canonical logical operations separately from the materialized
      string so version counting never depends on submission count.
- [x] Add dependency pins according to
      `docs/development/DEPENDENCIES.md`; verify single-copy and unused-dependency
      gates.

Required tests:

- [x] Same-base inserts from two clients converge in either server commit order.
- [x] A stale multi-update batch rebases over the complete integrated suffix.
- [x] Malformed changes, non-string baselines, effects, and limits fail before
      producing materialized output.
- [x] Repeating the same encoded inputs produces byte-equivalent encoded
      integrated operations and materialized output.
- [x] A second synthetic codec over JSON data passes the same registry contract,
      proving the interface is not text-specific.

Likely files:

- `packages/memory/v2/op-codec.ts`
- `packages/memory/v2/op-codecs/codemirror.ts`
- `packages/memory/test/v2-op-codec.test.ts`
- `packages/memory/deno.jsonc`
- `deno.lock`

Completion gate:

- [x] `packages/memory` codec tests pass without opening an Engine or Runtime.

## WP2 — Wire types, negotiation, and strict validation

Purpose: make the new format explicit and safely negotiable before the engine
accepts it.

- [x] Add `OpCodecId`, `OpCursor`, `ApplyOpOperation`,
      `ReleaseOpFieldOperation`, integrated operation records, and
      `ApplyOpResolution` to `packages/memory/v2.ts`.
- [x] Extend `Operation`, `AppliedCommit`, and stored commit-resolution types
      without changing `PatchOp`.
- [x] Add optional `applyOp` handshake support and an advertised codec-id list.
      Old servers parse as unsupported; old clients ignore the new fields.
- [x] Add strict validators for both operation shapes at the server boundary.
      Validate path segments, cursor integers, conditional baseline hash,
      submission ids, codec ids, and JSON payload bounds before codec execution.
- [x] Repeat security-critical validation inside the Engine so direct tests and
      in-process callers cannot bypass it.
- [x] Preserve typed error names in `ResponseMessage` decoding.
- [x] Add encode/decode round-trip fixtures for requests, responses, replayed
      resolutions, and handshake downgrade.

Likely files:

- `packages/memory/v2.ts`
- `packages/memory/v2/handshake.ts`
- `packages/memory/v2/server.ts`
- `packages/memory/v2/client.ts`
- `packages/memory/test/v2-handshake.test.ts`
- `packages/memory/test/v2-server.test.ts`

Completion gate:

- [x] A new client refuses collaborative writes against an old/unsupported
      server before issuing `transact`, and all malformed wire fixtures fail at
      the intended boundary.

## WP3 — Engine schema and field-history read primitives

Purpose: land storage shapes and read helpers before the atomic apply path.

- [x] Add `op_field_epoch`, `op_submission`, `op_integrated`, and
      `op_checkpoint` DDL plus indexes to `packages/memory/v2/engine.ts`.
- [x] Use canonical JSON Pointer encoding from the shared Memory path helpers
      for `path_key`; do not invent a second escaping implementation.
- [x] Include `branch` and resolved `scope_key` in every primary and lookup key.
- [x] Add startup migration tests for an existing current Engine database and a
      fresh database. The migration is additive and must not rewrite entity
      revision history.
- [x] Add Engine helpers to read the active epoch, read a cursor-bounded
      integrated suffix, read submitted records, and read the latest compatible
      checkpoint.
- [x] Assert contiguous integrated versions and detect corrupted cursor/head
      state loudly.
- [x] Add the new core table names to every SQLite builtin guard that protects
      Memory-owned tables.

Likely files:

- `packages/memory/v2/engine.ts`
- `packages/memory/v2/path.ts`
- `packages/memory/v2/sqlite/guard.ts`
- `packages/memory/test/v2-engine-apply-op-schema.test.ts`
- `packages/state-inspector/`

Completion gate:

- [x] Fresh and migrated databases expose identical collaborative schema, and
      direct Engine read helpers pass branch/scope/path isolation tests.

## WP4 — Atomic `apply-op` and release in the commit engine

Purpose: make Memory the sole integration authority.

- [x] Pass the configured codec registry into every Engine opened by the
      server. Emulated and loopback servers must configure the same registry
      explicitly in tests.
- [x] Implement inactive-field activation with null cursor and baseline hash.
- [x] Implement active-field integration: load suffix, call codec, allocate
      contiguous versions/op ids, and advance the field head.
- [x] Insert submitted/integrated/checkpoint rows and the derived materializing
      patch revision inside `applyCommitTransaction`.
- [x] Return the canonical operations in `ApplyOpResolution` and encode the
      resolution in the `commit.resolution` column.
- [x] Make `(sessionId, localSeq)` replay decode and return the stored operation
      resolutions without invoking the codec.
- [x] Implement durable submission-id deduplication across new sessions.
- [x] Implement `release-op-field`, entity-delete release, and epoch increment.
- [x] Validate ordinary `set`/`patch` results against active collaborative paths
      in operation-index order. Allow writes that preserve field values; reject
      hidden replacement.
- [x] Derive confirmed-read and scheduler touched paths from the materialization
      patch, not the opaque submitted payload.
- [x] Treat accepted `apply-op` dirty origins as patch-like so the writer gets
      authoritative materialized state in the covering sync.
- [x] Roll back every row, including the commit row, when codec integration,
      derived patch application, or post-write validation fails.

Required tests:

- [x] First apply atomically creates an epoch, integrates operations, and changes
      the ordinary point-in-time entity value.
- [x] Two sessions concurrently submit at the same base; server arrival order is
      the immutable integrated order and both operations survive.
- [x] Commit replay and cross-session duplicate submission return the original
      resolution and do not advance version.
- [x] Duplicate id with different content fails.
- [x] A codec exception leaves commit, entity revision, op tables, cursor, and
      snapshots unchanged.
- [x] Whole-document and ancestor patches cannot alter an active field; disjoint
      and value-preserving writes remain valid.
- [x] Release plus replacement in one commit works, while replacement before
      release fails.
- [x] Scope and branch keys isolate otherwise identical field addresses.
- [x] A commit with multiple operations observes prior operation-index results.

Likely files:

- `packages/memory/v2/engine.ts`
- `packages/memory/v2/server.ts`
- `packages/memory/v2/patch.ts`
- `packages/memory/test/v2-apply-op.test.ts`
- `packages/memory/test/v2-apply-op-concurrency.test.ts`
- `packages/memory/test/v2-apply-op-replay.test.ts`

Completion gate:

- [x] Independent Memory sessions converge through one Engine with no runtime
      collaboration code and all atomic rollback assertions pass.

## WP5 — Direct op queries and session-watch delivery

Purpose: provide race-free initialization, incremental updates, and reconnect.

- [x] Add `op.query` request/result types with explicit `integrated` and
      `submitted` projection selection.
- [x] Return an integrated snapshot when no cursor is supplied, the epoch
      differs, or the cursor is older than retained history; otherwise return a
      complete suffix delta.
- [x] Represent an inactive field with a null cursor, current materialized
      value, and baseline hash. Keep inactive watches live across ordinary
      changes, activation, release, and entity deletion.
- [x] Add `op-field` to `WatchSpec`. Keep graph watches materialized-only.
- [x] Extend session watch state with the last delivered field cursor and extend
      `SessionSync` with operation-field effects.
- [x] Install the watch and compute its initial snapshot/delta under the same
      per-space publication ordering used by ordinary watch mutations.
- [x] Carry op-field dirtiness separately from entity dirty ids while preserving
      one verdict-before-fan-out order.
- [x] Deduplicate receipt and watch delivery by cursor in the client.
- [x] Resume retained sessions from server watch state. Reinstall replaced
      sessions using the client's last cursor.
- [x] Add submitted-history authorization tests and ensure audit payloads never
      enter ordinary entity sync.
- [x] Add query caps and pagination for audit history before exposing the
      submitted projection through tools.

Required tests:

- [x] Atomic watch installation cannot miss an operation committed between
      editor initialization and watch setup.
- [x] Initial snapshot, same-epoch delta, wrong-epoch reset, and retained-floor
      reset have distinct fixtures.
- [x] Disconnect/reconnect delivers each canonical cursor once.
- [x] Replaced-session reinstall resumes from the supplied cursor.
- [x] Applying a receipt and then receiving its duplicate watch delta advances
      the cursor exactly once.
- [x] Ordinary entity and op-field watches for one commit agree on materialized
      content and commit ordering.

Likely files:

- `packages/memory/v2.ts`
- `packages/memory/v2/engine.ts`
- `packages/memory/v2/server.ts`
- `packages/memory/v2/server-sync.ts`
- `packages/memory/v2/client.ts`
- `packages/memory/test/v2-op-query.test.ts`
- `packages/memory/test/v2-op-watch.test.ts`
- `packages/memory/test/v2-op-resume.test.ts`

Completion gate:

- [x] A headless client can initialize, submit, disconnect, resume, and consume
      canonical deltas without consulting an ordinary entity update for op
      history.

## WP6 — Runner storage capability

Purpose: carry operation sessions through the existing authenticated storage
connection and commit sequence without teaching ordinary Cell transactions
editor semantics.

- [x] Add a separate optional `IOperationStorageCapability` beside
      `IStorageManager` in `packages/runner/src/storage/interface.ts`. Do not add
      CodeMirror types to runner interfaces.
- [x] Define codec-neutral `openOpField`, `applyOp`, `releaseOpField`, and
      subscription/result types using Memory wire values.
- [x] Implement the capability in `packages/runner/src/storage/v2.ts` using the
      same per-space `SpaceSession`, local-sequence allocator, reconnect state,
      and pending-commit durability barrier as ordinary writes.
- [x] Do not place `apply-op` in `PendingVersion`: the editor owns its immediate
      local view, while Memory owns canonical materialization. Ordinary Cell
      state advances from authoritative verdict/sync results. WP11's edit
      against a read is the one case the replica shows ahead of the verdict,
      because its result is fixed by the value it was computed from.
- [x] Ensure a collaboration commit participates in `synced()`, shutdown, route
      replacement, authorization errors, and telemetry.
- [x] Keep emulated storage behavior on the real loopback Memory server rather
      than adding an in-memory alternate transform implementation.

Required tests:

- [x] Operation and ordinary commits share monotonically ordered local sequence
      allocation.
- [x] `synced()` waits for an in-flight operation commit.
- [x] Route replacement and reconnect resend the same submission id and recover
      the stored resolution.
- [x] Closing the manager releases operation watches without affecting other
      subscribers.
- [x] Unsupported storage managers fail capability detection explicitly.

Likely files:

- `packages/runner/src/storage/interface.ts`
- `packages/runner/src/storage/v2.ts`
- `packages/runner/src/storage/v2-emulate.ts`
- `packages/runner/test/storage-v2-apply-op.test.ts`

Completion gate:

- [x] Runner tests prove the operation capability uses the same authenticated
      session and durability lifecycle as ordinary storage work.

## WP7 — Runtime-client editor-neutral sessions

Purpose: expose collaborative fields to main-thread consumers without moving
integration authority out of Memory.

- [x] Add generic operation-session request, response, notification, receipt,
      and close messages to `packages/runtime-client/src/protocol/`.
- [x] Resolve a `CellHandle` to its canonical `(space, id, scope, path)` once in
      the worker and open the runner operation-storage capability.
- [x] Add codec-neutral runtime-client methods for capability discovery,
      snapshot query, subscription, submit, release, and session close.
- [x] Give each opened editor an explicit operation-session id. The worker pins
      that session to one canonical resolved target while overlapping or later
      sessions resolve independently, and close abandons pins created before a
      subscription installs.
- [x] Register listeners before opening so an update cannot land between the
      initial response and subscription setup.
- [x] Filter duplicate or older cursors but reject gaps; gaps trigger a Memory
      snapshot request rather than local log reconstruction.
- [x] Keep the worker as a transport/lifecycle adapter. It must not host codec
      registries, operation logs, rebasing, or materialization.

Required tests:

- [x] Open/update/close lifecycle cleans up listeners and worker watches.
- [x] An update arriving during open is delivered exactly once.
- [x] Abort and runtime disposal reject pending work without leaking a session.
- [x] Cursor gap and epoch reset behavior request/accept a canonical snapshot.
- [x] A synthetic JSON codec session uses the same runtime-client surface.

Files:

- `packages/runtime-client/src/protocol/types.ts`
- `packages/runtime-client/src/backends/runtime-processor.ts`
- `packages/runtime-client/src/runtime-client.ts`

Completion gate:

- [x] Runtime-client tests contain no CodeMirror imports outside a dedicated
      adapter fixture and no durable collaboration state outside Memory.

## WP8 — CodeMirror integration in `cf-code-editor`

Purpose: deliver the first product consumer of Memory `apply-op`.

- [x] Add an opt-in `collaborative` property that activates only for a
      `CellHandle<string>` and a server advertising the CodeMirror codec.
- [x] Initialize CodeMirror from the operation-session snapshot and its cursor.
- [x] Use `@codemirror/collab` locally for pending updates, submission encoding,
      canonical receipt confirmation, and remote-delta rebasing.
- [x] Submit collaborative edits immediately; the whole-value debounce/throttle
      setting does not govern operation submission.
- [x] Route programmatic backlink edits through the same local operation stream.
- [x] Keep the editor read-only while opening or resetting a session. A codec or
      protocol failure emits `cf-error`; it never silently switches to
      last-writer-wins Cell writes.
- [x] Preserve the existing behavior for plain strings and non-collaborative
      Cell bindings.
- [x] Do not add presence or selection persistence.

Required tests:

- [x] Pure adapter tests cover pending submission, stale-base rebase, own receipt,
      duplicate watch delta, cursor gap, and epoch reset.
- [x] Component tests cover binding replacement, collaborative toggle, disposal,
      runtime abort, ordinary mode, and backlink rewrites.
- [x] A browser integration test opens two independent runtimes against one
      Memory server, performs overlapping edits without timing sleeps, and
      asserts both editor documents and the ordinary Cell value converge.
- [x] Reconnect integration confirms same-epoch offline pending edits retain
      their submission ids and rebase after reconnect.
- [x] An epoch reset with unconfirmed local edits preserves the local document,
      makes the editor read-only, and emits an explicit reconciliation event
      containing local and canonical values; it never silently discards edits.

Likely files:

- `packages/ui/src/v2/components/cf-code-editor/cf-code-editor.ts`
- `packages/ui/src/v2/components/cf-code-editor/codemirror-collaboration.ts`
- `packages/ui/src/v2/components/cf-code-editor/*.test.ts`
- `packages/ui/src/v2/components/cf-code-editor/docs/collaboration.md`
- `packages/patterns/integration/`

Completion gate:

- [x] Two browser clients converge through Memory, the stored Cell remains a
      plain string for ordinary readers, and disabling collaboration preserves
      current editor behavior byte-for-byte.

## WP9 — Checkpoints, limits, branches, and operational tooling

Purpose: close the gaps that are acceptable for an experimental CodeMirror
slice but not for long-lived rich-text documents.

- [x] Implement checkpoint creation and verification at deterministic operation
      counts or byte thresholds.
- [x] Add retained-version floors and snapshot reset responses before pruning
      any integrated rows.
- [x] Benchmark transform suffix length, transaction lock duration, op-query
      pagination, and checkpoint replay with realistic source and rich-text
      document sizes.
- [x] Add operator metrics for apply count, transform suffix, payload bytes,
      integration duration, reset count, codec failures, and active watches.
- [x] Expose field cursors, epochs, submissions, integrated operations, and
      checkpoint consistency through `cf inspect` / state-inspector.
- [x] Implement child-branch epoch creation from the fork-sequence materialized
      value, or keep a tested default-branch rejection until it lands.
- [x] Keep collaborative branch merges unavailable until branch integration
      semantics and a Memory branch-merge operation are specified.
- [ ] Perform the CFC review for submitted-history visibility and future range
      side-data before treating the substrate as WordGard-ready.

Completion gate:

- [x] No unbounded transform or query work runs inside the per-space lock;
      behind-retention clients recover through a tested snapshot reset; branch
      behavior is implemented or explicitly rejected at every boundary.

## WP10 — WordGard readiness review and documentation closure

Purpose: verify that the substrate is genuinely editor-neutral before beginning
the rich-text codec.

- [ ] Implement a test-only structured-document codec with multi-node edits and
      confirm it uses the same engine, query, watch, runner, and runtime-client
      paths.
- [ ] Exercise codec version mismatch, epoch release, checkpoint reset, and
      anchored op ids with that structured codec.
- [ ] Review whether WordGard requires codec hooks absent from the contract,
      especially schema validation, node identity, step mapping, and anchor
      mapping. Update the spec before adding product-specific hooks.
- [ ] Add or update the live feature guide for collaborative fields and link it
      from `docs/features/README.md`.
- [ ] Update Memory v2 implementation status and invariant coverage.
- [ ] Archive this plan after every completion gate passes; keep the normative
      specification live.

Completion gate:

- [ ] The structured codec proves no CodeMirror types or assumptions leaked
      into shared APIs, and the remaining WordGard work is confined to a codec,
      editor adapter, and rich-text-specific product behavior.

## WP11 — Text edits from pattern code

Purpose: let a handler edit an active collaborative string, which an ordinary
write may not change (§7.6), with an edit the open editors merge like any
other.

- [x] Let `apply-op` name no base: it applies at the field's current version
      with nothing to rebase over, and activates an inactive field from its
      value. With a `baselineHash` it applies only while the field holds that
      value, and a stale hash in a wave commit is a conflict on that document;
      without one it is a blind write, guarded by its commit's reads as a
      `set` is. The engine states the base before applying it, so the apply
      path itself is unchanged (§7.6, §7.7.1).
- [x] Add `Writable<string>.applyChanges()`, taking changes in the shape of a
      CodeMirror change spec against the value the handler read. The handler's
      transaction records them and writes the changed text, so CFC, its later
      reads, and reactivity see an ordinary write.
- [x] Carry the recorded changes in the handler's own commit as one `apply-op`
      per field, after the document writes, whose patch leaves the field out,
      with the hash of the value the handler read. Carry them through a
      sealed commit the same way, and leave them out of the client overlay's
      whole-document seal, whose `set` carries the changed text.
      The handler's read of the field rides the same commit, so a field that
      moved refuses it as an ordinary conflict and the scheduler runs the
      handler again; the handler's receipt makes the commit, and the edit with
      it, apply once however many runtimes handle the event.
- [x] Show the edit in the replica's pending layer as a replacement of the
      field with the changed text, which is the store's result whenever the
      commit is accepted.
- [x] Encode the changes as a `codemirror-changeset@1` payload in
      `packages/memory/v2/text-changes.ts`, which imports no CodeMirror, so the
      runner names the codec without loading it.

Required tests:

- [x] An `apply-op` without a base applies at the current version, blind or
      beside a read of the field, activates an inactive field, replays with
      its commit, and is rejected by a stale read in its commit or under its
      submission id in a later commit.
- [x] A stale confirmed read of the field refuses the commit as a
      `ConflictError` before the operation applies.
- [x] A handler's edit commits beside an ordinary write to another field of the
      same document, shows in the writer's view before the server's echo, and
      a field that moved after the read refuses the commit.
- [x] The payload encoding applies under CodeMirror exactly as the changes do.
- [x] A served handler's edit commits through its wave, two in one wave both
      land, and one computed before a keystroke its replica never saw is
      refused rather than replacing it.

Files:

- `packages/memory/v2/engine.ts`
- `packages/memory/v2/text-changes.ts`
- `packages/runner/src/cell.ts`
- `packages/runner/src/storage/v2-transaction.ts`
- `packages/runner/src/storage/v2.ts`
- `packages/patterns/shared-note/main.tsx`

---

## Cross-package validation matrix

| Work packages | Required validation |
| --- | --- |
| WP0–WP2 | Focused Memory fixture/protocol tests, `deno task check-docs` |
| WP3–WP5 | Complete `packages/memory` test task, migration tests, protocol tests |
| WP6 | Complete `packages/runner` test task plus Memory tests |
| WP7 | Complete `packages/runtime-client` and runner tests |
| WP8 | Complete UI Deno and browser tests plus focused integration test |
| WP9–WP10 | All touched package tests, benchmarks recorded without pass/fail timing thresholds, repository-wide gates |
| WP11 | Complete `packages/memory` and `packages/runner` test tasks, the `shared-note` pattern test, `deno task cfcheck` |

Every review-ready PR must also run `deno fmt --check`, `deno lint`, relevant
type checks, `deno task check-docs`, `deno task check-conflict-markers`,
`deno task check-no-waitfor`, and dependency gates affected by its imports.

## Review checkpoints

Request explicit architecture review at these boundaries:

1. After WP0, before freezing codec and wire shapes.
2. After WP3, before writing production rows into the new schema.
3. After WP5, before exposing the capability through runner/runtime-client.
4. After WP8, before calling CodeMirror collaboration usable outside tests.
5. After WP10, before beginning a WordGard production codec.

The first implementation PR should begin at WP0/WP1. It should not recreate the
discarded runtime-owned operation log as an interim step.
