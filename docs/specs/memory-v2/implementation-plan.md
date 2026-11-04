# Memory v2 Implementation Plan

## Summary

This implementation pass rewrites the current Memory v2 engine from
hash-addressed JSON facts plus subscription-id live updates to:

- seq-addressed commit history
- per-entity revision rows and inline snapshots
- logical session resume keyed by `sessionId`
- session-scoped watch sets
- session-scoped catch-up sync frames

## Current Status

This file and
[10-implementation-guidance.md](10-implementation-guidance.md)
are the authoritative implementation notes for the current code. They describe
what is shipped now and what remains explicitly deferred, even where sections
04-06 still describe the broader target design.

Implemented on the current branch:

- `engine-v3` / `.engine-v3` storage roots for the rewritten v2 engine
- seq/revision-based JSON storage with point-in-time reads
- lightweight WebSocket framing with `hello`, `session.open`, `transact`,
  `graph.query`, `op.query`, `session.watch.set`, `session.watch.add`,
  `session.ack`, `response`, and `session/effect`
- experimental collaborative fields: negotiated versioned codec registries,
  top-level `apply-op` and `release-op-field` commits, submitted and integrated
  SQLite history, stable epoch/version operation ids, atomic ordinary-value
  materialization, and direct operation-field query/watch effects
- a codec-neutral runner and runtime-client collaboration capability plus an
  opt-in CodeMirror adapter in `cf-code-editor`; ordinary Cell readers continue
  to consume the derived string value
- storage-owned checkpoints and retention floors, submitted-history operator
  inspection, reconnect recovery, and multi-browser collaboration coverage
- session-scoped watch-union sync with catch-up frames, `removes`, and
  per-verdict catch-up markers with client-side verdict parking (conflicts
  and accepts, CT-1927)
- one-shot `graph.query` support for `branch` and `atSeq`
- `session.watch.add` duplicate-id handling: identical definitions are no-ops,
  changed definitions are rejected
- unsafe store-subject rejection before engine-root path construction
- shared JSON-pointer/path-overlap helpers reused across memory and runner
- watch-layer hot-path cleanup:
  - session cache diffing by revision identity instead of serialized payload
    comparison
  - incremental ordered client watch views instead of full resort on every emit

Explicitly deferred:

- full UCAN transport framing for all wire messages
- server-issued or principal-bound session ids; resume remains keyed by the
  caller-provided `sessionId`
- public branch lifecycle commands on the v2 wire protocol
- merge proposal generation, merge conflict workflows, and advanced branch
  live-sync optimizations
- the structured-codec readiness proof required before a WordGard integration
- broad protocol-spec reconciliation outside these implementation notes

This is a clean break:

- no in-place migration from the current v2 engine store
- no dual-read compatibility for the old SQLite layout
- no compatibility shim for the current `graph.query subscribe` live protocol

The runner/storage public surface remains stable. The change happens under
`runtime/memory/v2`, `runtime/runner/src/storage/v2.ts`, and the toolshed
memory route.

## Constraints

- Keep `Runtime`, `StorageManager`, `IStorageProvider`,
  `IExtendedStorageTransaction`, scheduler notifications, and `syncCell()`
  semantics stable.
- Use red/green TDD for each implementation slice: write the focused failing
  test first, make it pass with the smallest viable change, then refactor.
- Keep the lightweight WebSocket protocol already used by the current v2 code:
  `hello`, `session.open`, `transact`, `graph.query`, `session.watch.set`,
  `session.ack`, `response`, and `session/effect`.
- Do not switch this pass to full UCAN transport framing.
- Keep `session.open` as the authenticated edge; defer per-commit signed write
  metadata.
- Session resume may keep using caller-provided `sessionId` values for now.
  Session-id hardening is deferred.
- Keep blob payload storage content-addressed. The seq rewrite applies to JSON
  entity storage, not blob data.
- Keep branch-aware reads, writes, and watch scopes where already supported.
  Defer public branch lifecycle commands, merge proposals, and advanced branch
  sync.

## Phase 0: Spec Maintenance

- Rewrite this file to reflect the actual execution plan.
- Rewrite
  [10-implementation-guidance.md](10-implementation-guidance.md)
  so it no longer points implementers at `fact` / `value` tables, commit hashes,
  or invocation-id-scoped subscriptions.
- Keep sections 01-06, 10, and this file aligned enough that the code can use
  them as the implementation source of truth.

## Phase 1: Engine Root and Storage Rewrite

- Introduce a new engine root version:
  - directory mode: `<memory-root>/engine-v3/`
  - single-file mode: sibling `<basename>.engine-v3/`
- Route both toolshed-backed and emulated v2 engines to that new root.
- Replace the old SQLite JSON schema:
  - remove `value`
  - remove `fact`
  - add `revision(branch,id,seq,op_index,op,data,commit_seq)`
  - change `head` to `(branch,id,seq,op_index)`
  - change `commit` to drop semantic `hash`
  - inline full JSON document values in `snapshot.value`
  - keep `branch`, `invocation`, `authorization`, and `blob_store`
- Make current and point-in-time reads use `snapshot + revision replay`.
- Store patch arrays inline on `revision.data`.
- Deduplicate replay by `(session_id, local_seq)` plus canonical equality of the
  stored `original` payload.
- Remove parent-hash resolution from JSON commit handling entirely.

## Phase 2: Server Protocol and Session Watches

- Replace server-side subscription tracking with per-session watch state:
  - `seenSeq`
  - current watch set
  - current relevant entity keys
  - last synced entity cache
- Add `session.watch.set` to replace the current watch set for a session.
- Add `session.watch.add` to incrementally extend the current watch set by id.
- Add `session.ack` to advance server-side `seenSeq`.
- Emit `session/effect` sync messages instead of `graph.update`.
- Keep one-shot `graph.query` for non-live reads.
- For schema-aware watches, persist the tracked doc-plus-selector frontier
  across watch growth, reuse a persistent traversal memo only for `watchAdd`
  style growth, and keep write-triggered refreshes on a fresh memo.
- Recompute watch-union results per session and emit:
  - `upserts` for relevant current entity state
  - `removes` when an entity leaves the watch union
- Return transact verdicts inline before the independently batched fan-out;
  serialize transaction publication and fan-out with one lock per space. Send
  the verdict while the transaction holds the lock, finish its post-commit
  scheduler bookkeeping, and release the lock for fan-out. Stage a
  `caughtUpLocalSeq` catch-up obligation for accepts and conflict rejections
  (CT-1927), delivered by the batched fan-out, so the CLIENT parks each verdict's
  state application until the marker covers it.

## Phase 3: Client Rewrite

- Rewrite `runtime/memory/v2/client.ts` around:
  - session-scoped watch sets
  - a session cache of watched entity state
  - reconnect by `seenSeq`
- Add client APIs for:
  - `watchSet(watches)`
  - `watchAdd(watches)`
  - `ack(seenSeq)`
  - one-shot `queryGraph(query)`
- On reconnect:
  - reopen the session with `seenSeq`
  - replay outstanding commits in `localSeq` order
  - apply inline catch-up sync if the session resumes
  - reinstall the watch set only if the session reopened fresh
- Remove subscription-id handling and seq/hash-based duplicate-confirm logic.

## Phase 4: Runner / Toolshed Integration

- Update `runtime/runner/src/storage/v2.ts` to use session watch installation
  instead of `queryGraph({ subscribe: true })`.
- Use `watchAdd(...)` as the normal watch growth path, including the first watch
  install on a fresh session.
- Keep the runner/storage public API unchanged.
- Keep current notification semantics:
  - optimistic `commit`
  - synchronous `revert` before promise resolution on conflict
  - async `integrate` for remote sync
- Update toolshed route handling to reject the old live `graph.query subscribe`
  path.
- Keep emulation on the same code path as the real v2 server/client pair.

## Phase 5: Basic Branches

Implemented in this pass:

- branch-aware writes
- branch-aware current reads
- branch-aware point-in-time reads
- branch-aware watch scopes

Deferred:

- public branch create/delete/list commands on the v2 wire protocol
- merge proposal generation
- merge conflict workflow
- advanced branch-specific live sync optimizations
- deleted-branch refinements beyond historical reads

## Phase 6: Remove Old Assumptions

- Delete the old hash/fact/subscription-oriented v2 internals.
- Do not keep compatibility shims for:
  - old v2 wire messages
  - old v2 SQLite engine files
  - `commit.hash`, `fact.hash`, `value_ref`, or `head.fact_hash`
- Update diagnostics and benches to use `watch`, `sync`, and `revision`
  terminology where they describe v2 internals.

## Focused Test Plan

### Engine

- new engine-root resolution in directory and single-file modes
- current reads from `head + snapshot + revision replay`
- point-in-time reads through patch chains
- set / patch / delete revision replay
- idempotent replay by `(sessionId, localSeq)` with identical `original`
- protocol error on replay with different `original`
- branch create/delete/list and branch-aware reads

### Server / Client

- `hello` then `session.open` ordering
- `session.watch.set` installs or replaces the current watch set
- `session.watch.add` incrementally extends the current watch set for new ids
  while treating duplicate identical ids as no-ops and rejecting changed
  definitions
- `session/effect` emits correct `upserts` and `removes`
- `session.ack` advances server-side `seenSeq`
- reconnect restores watch set and replays outstanding commits
- old live `graph.query subscribe` is rejected
- one-shot `graph.query` honors `branch` and `atSeq`

### Runner / Provider

- optimistic commit notification ordering remains unchanged
- revert-before-promise-resolution on conflict remains unchanged
- integrate notifications stay suppressed while newer pending state shadows the
  same path
- reconnect still deduplicates replayed outstanding local work
- retry-after-revert succeeds after subscribed state refresh
- overlapping watched graphs dedupe correctly

### Route / Integration

- toolshed v2 websocket handshake on the new protocol
- end-to-end runtime sync across fresh runtimes using watch sync
- root retarget and deep-link propagation through session sync
- server restart + resume with watch restoration
- safe store-subject rejection on toolshed-backed v2 session open
- basic branch-aware reads/writes against the real toolshed route
