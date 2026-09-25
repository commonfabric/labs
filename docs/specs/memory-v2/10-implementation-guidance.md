# Implementation Guidance: Seq Revisions and Session Watch Sync

This document supplements sections 01-06 of the Memory v2 spec. It describes the
intended implementation target for the current rewrite, not the earlier
hash/fact/subscription prototype.

If this file conflicts with sections 01-06, update the file. Do not preserve
older guidance by layering compatibility code around it.

## Status Note

This guidance tracks the current implementation, not the full future protocol
target. In particular:

- the current wire protocol uses memory-v2 JSON envelopes encoded at the
  boundary with the shared flag-dispatched value codec, not UCAN-framed
  transport
- plain `transact` requests do not currently carry or persist per-commit
  `invocation` / `authorization` payloads; signed-write metadata remains
  deferred to a later pass
- the toolshed v2 websocket authenticates `session.open` by requiring the
  signed invocation to match the requested space, session descriptor, server
  audience, current connection challenge, and short validity window
- the memory server ACL policy gates session opens and commands when enabled;
  route-level `Origin` enforcement remains deferred
- fresh-space writes require an ACL-only genesis by the space identity or a
  configured service DID; storage performs named-space genesis in a temporary
  space-authenticated session and then remounts as the active user
- populated spaces that never had an ACL are temporarily authenticated-public
  READ/WRITE (never OWNER), except that the home identity claims its own
  ACL-less space; malformed, ownerless, and retracted ACLs fail closed
- session resume still uses caller-provided `sessionId` values; principal
  binding and server-issued session ids remain deferred
- one-shot `graph.query` now honors `branch` and `atSeq`
- the public one-shot read surface in this pass is `graph.query`; the older
  simple `query` / wildcard selector shape remains future protocol design
- watch installation remains current-state only in this pass; do not treat
  watch specs as historical subscriptions keyed by `atSeq`
- steady-state topology shrink does not yet drive automatic unwatch/removal
  semantics; clients should only rely on `removes` from explicit watch-set
  replacement in this pass
- branch lifecycle commands are not yet exposed on the v2 wire; current branch
  creation keeps its fork-seq semantics until that cutover lands

## 1. Source Of Truth

Implementation authority is:

1. sections 01-06 of this spec
2. this guidance file
3. the focused v2 tests
4. the current runtime-facing public interfaces

Do not revive old `commit.hash`, `fact.hash`, `value_ref`,
`graph.query subscribe`, or subscription-id routing because they existed in the
previous implementation.

## 2. Clean Break Rules

- Use a new engine root: `engine-v3` / `.engine-v3`.
- Do not migrate or read the current v2 SQLite files in place.
- Do not keep the old live wire protocol alongside the new one.
- Keep blob payload storage content-addressed; drop semantic hashes only from
  the JSON entity path.

## 3. Transport Target

This pass keeps the lightweight WebSocket framing already used by the current
codebase. The target wire messages are:

- `hello`
- `hello.ok`
- `session.open`
- `transact`
- `graph.query`
- `session.watch.set`
- `session.watch.add`
- `session.ack`
- `response`
- `session/effect`

Do not switch this pass to full UCAN message framing. None of the current wire
messages are transport-level signed UCAN invocations beyond the current
`session.open` authentication step.

The `hello.ok` response includes `sessionOpen.audience` and a one-time
`sessionOpen.challenge`. The client signs both values into the next
`session.open` invocation, along with `iat` and `exp`. The server rejects a
missing, expired, reused, or mismatched challenge, and rejects a missing or
mismatched audience.

## 4. Session Model

Use a logical session per space. The session owns:

- `sessionId`
- `seenSeq`
- retained outstanding commits keyed by `localSeq`
- the current watch set
- the current watch-union result known to the server

Reconnect behavior:

1. re-open the session with `sessionId` and `seenSeq`
2. replay outstanding commits in `localSeq` order
3. if `session.open` resumes an existing session, integrate its inline
   catch-up sync and keep the existing watch set
4. if `session.open` opens a fresh session, reinstall the watch set

The client should treat `seenSeq` as “highest canonical seq fully integrated
into confirmed state,” not merely “latest seq observed on the wire.”

Current deferred constraint:

- `sessionId` hardening is out of scope for this pass. Resume remains keyed by
  the supplied `(space, sessionId)` pair rather than a server-issued,
  principal-bound identifier.

The normal growth path for live interests should use `session.watch.add`,
including the first watch install on a fresh session. Use `session.watch.set`
only when replacing the full interest set. Watch mutations must be serialized
per session so overlapping add/set requests cannot race to construct competing
local watch views.

When `session.watch.add` receives a watch id that already exists, treat the
request as idempotent only if the watch definition is identical. If the
definition differs, reject the request and require the client to use
`session.watch.set` to replace the full watch set.

Watch additions stage changes to graph selectors, missed-target ownership,
document caches, schema reference scans, and operation cursors. Evaluation,
operation snapshot attachment, and wire conversion finish before publication.
Once the engine is acquired, the captured session must still be the registry's
current session. Staging through publication then runs synchronously:
temporary maps read through the exclusively held session state, copy mutable
containers only for touched keys, and commit into the original maps on success.
Discard failed stages; never retain a chain of staged maps in a live session.
Shared evaluation-cache entries require independent clones.

Operation snapshots retain their declaration list and cursor map across engine
access. A concurrent watch replacement owns its own cursor map.

Ordinary additions index watch IDs and maintain only changed interests.
Incremental refresh reconciles each changed scoped key against delivered
entries, operation watches, and remaining misses on every branch. The last
miss owner leaving must retire an interest unless another source still owns
it. Watch replacement recomputes complete provenance; normalizing an accepted
list with duplicate IDs also recomputes it because an operation owner can
depart. A refresh's schema-closure pass walks only the closures of the documents
it delivers, and stops at schema documents the graph already established, so
its cost follows the changed documents rather than every schema hash the session
holds; `docs/specs/content-addressed-schemas.md`, under "Traversal and sync",
states what that pass verifies and what it leaves to a fresh evaluation.

## 5. Transaction Contract

The runner-facing transaction contract does not change.

`IExtendedStorageTransaction.commit()` still has two phases:

1. synchronous local apply
2. asynchronous server resolution

The storage-visible notification behavior must remain:

- optimistic `"commit"` before the async round trip completes
- `"revert"` synchronously before the promise resolves on conflict
- `"integrate"` for remote sync

Path and document-boundary rules:

- `read()` / `write()` operate on full stored documents.
- `readValue()` / `writeValue()` style helpers are thin adapters that prepend
  `"value"` and then delegate to those full-document operations.
- the replica/storage layer should traffic in logical `EntityDocument` values,
  not a runner-side `StorageValue` interpretation.
- only the shared query/traversal layer treats selector paths as value-relative.
- `encodeMemoryV2Boundary` / `decodeMemoryV2Boundary` belong at persistence or
  wire boundaries, not in the middle of transaction or replica logic.

## 6. Stable Snapshot Rule

A commit's read set must describe one stable local snapshot, so that
`reads.confirmed` and `reads.pending` describe one coherent view
(`03-commit-model.md` §3.3.4). Two ways to get there:

- Buffer incoming sync while a transaction is reading and writing, and apply
  it after the transaction has been submitted.
- Apply sync as it arrives; snapshot each document at the transaction's first
  read of it; at commit, re-read every snapshotted document from the state the
  read set is built from, and reject the transaction locally when any value
  differs. The caller re-runs it against the changed state.

The runner uses the second. A rejected transaction surfaces as
`StorageTransactionInconsistent`, which its commit paths classify as retryable.

## 7. Commit Identity and Storage Identity

Use these identities consistently:

- pending commit identity: `(sessionId, localSeq)`
- canonical commit identity: `seq`
- persisted revision identity: `(branch, id, seq, opIndex)`

`seq` identifies the accepted transaction. `opIndex` identifies the specific
stored revision row when one commit writes multiple operations.

## 8. Engine Schema

Use a seq/revision schema, not a hash/fact schema.

Required persistent concepts:

- `commit`
- `revision`
- `head`
- `snapshot`
- `branch`
- `invocation`
- `authorization`
- `blob_store`

Required properties:

- `commit` has no semantic hash column
- `revision.data` stores inline encoded document payloads or patch arrays
- `head` points at `(seq, op_index)` for the current entity state
- `snapshot.value` stores inline full encoded document values
- `(session_id, local_seq)` remains unique for idempotent replay

## 9. Read Path

Current and point-in-time reads should use:

- direct head lookup for the latest state
- latest snapshot at or before the requested seq
- revision replay from that snapshot boundary

Do not rebuild JSON entity history through parent hashes.

Patch replay rules stay conservative:

- `set` and `delete` replace the current base state
- `patch` replays on top of the latest base/snapshot
- confirmed-read conflicts remain path-aware

## 10. Watch Sets And Sync

The server should not route live updates through the original watch request id.

Instead:

- each session owns the full current watch set
- the server computes the union of watched entities for that session
- the server emits `session/effect` sync frames for the union

Practical guidance:

- watch overlap should dedupe at the session cache layer
- `removes` mean “no longer relevant to this watch union,” not tombstone
- keep one-shot `graph.query` for non-live reads and shared traversal logic
- compare sync cache entries by revision identity (`branch`, `id`, `seq`,
  `deleted`), not by serializing document payloads on hot paths
- keep the client watch view incrementally ordered instead of rebuilding and
  sorting the full entity set on every emit

Return transact verdicts inline before the independently batched fan-out — N
commits share one watch-union recompute. Use one publication lock per space for
transactions, direct writes, and fan-out. Send a transaction's verdict while it
holds the lock, complete its post-commit scheduler bookkeeping, and release the
lock before fan-out evaluates the live space state. A transaction arriving
during same-space fan-out waits for that turn; locks for other spaces remain
independent. Stage a catch-up obligation for accepts and conflict rejections so
the next batched frame to the committing session carries `caughtUpLocalSeq`; the
client parks each accept's state application until that marker covers it, and
the read-repair gate holds conflict drops the same way (04-protocol.md section
4.11.2, CT-1927). Other rejection kinds carry no marker obligation and apply
immediately.

## 11. Query / Traversal Reuse

Keep using the shared traversal code, reached through
`@commonfabric/runner/graph-query`. That module holds the query driver:
`GraphQueryWalk` over an `ObjectStorageManager` the storage side implements,
and `schemaTrackerKey` for the key a walk records under. It is the whole of
what storage code should import from the runtime for this purpose;
[schema graph queries](../../features/schema-graph-queries.md) describes the
exchange and what it costs.

The server and client must continue to agree on entity reachability and graph
membership. Reuse traversal logic rather than reimplementing a separate graph
expander in storage code.

For schema-aware live watches, keep the cache lifetimes split:

- keep a persistent doc-plus-selector tracker per watched graph so `watchAdd`
  can stop immediately at already-current frontiers
- allow additive watch growth to reuse a persistent traversal memo for the
  tracked graph
- use a fresh traversal memo for write-triggered refreshes so retargets and
  other topology changes cannot be incorrectly pruned by stale memo entries

For one-shot reads, `graph.query` must honor:

- `branch` for branch-scoped traversal
- `atSeq` for point-in-time reconstruction on that branch

Do not silently drop `atSeq` from one-shot query semantics.

Keep shared JSON-pointer and path-overlap helpers in one module under
`packages/memory/v2` so patch application, conflict detection, and runner-side
read invalidation do not drift.

## 12. Branch Scope

This pass includes only the branch-aware read/write/query behavior already wired
through the core storage path:

- branch-aware writes
- branch-aware current reads
- branch-aware point-in-time reads
- branch-aware watch scopes

Public branch lifecycle commands, merge proposal generation, and advanced branch
live-sync behavior remain deferred. Do not block the seq/revision rewrite on
merge ergonomics.

## 13. Testing Strategy

Drive the rewrite with focused red/green TDD.

For each implementation slice:

1. write or update the focused failing test first
2. make the minimal production change needed to turn it green
3. clean up only after the test is passing

Do not batch large speculative rewrites and add tests afterward. If a behavior
matters enough to preserve or change, capture it in a failing test before
changing the implementation.

Required test areas:

- new engine-root path resolution
- rejection of unsafe store subjects before path construction
- revision replay and snapshots
- idempotent `(sessionId, localSeq)` replay
- session watch installation and catch-up sync
- duplicate-id handling for `session.watch.add`
- one-shot `graph.query` coverage for `branch` and `atSeq`
- reconnect with outstanding commits
- runner notification ordering
- toolshed end-to-end sync on the new protocol

Keep the runner/storage public surface stable in tests. If a test only probes
old v2 internals that are being deleted, rewrite or remove it instead of
restoring the deleted behavior.

## 14. Anti-Patterns

Do not:

- reintroduce hash-addressed JSON facts as an internal compatibility layer
- keep both subscription-id updates and session sync at once
- tie live updates to the invocation or request that created a watch
- compare confirmed duplicates by `(seq, hash)` after hashes are gone
- silently fall back from the new engine root to the old one
- spread branch support across special cases instead of carrying branch through
  the core read/write path
