# Chapter 9 — Storage and Sync

Chapter 8 ended with an optimistic commit leaving the local replica. This
chapter follows it: the wire protocol, how the server detects conflicts
without locks, how other clients hear about it, and what's actually on disk.
The code is `packages/memory` (the store and protocol) plus
`packages/runner/src/storage/` (the client side).

> **Historical note, because you'll see traces of it in the code.** The
> original storage engine ("v1") modeled storage as a chain of immutable
> *facts* `{the, of, is, cause}` with per-fact compare-and-swap. Both its
> engine and its fact vocabulary have been removed; what survives is a
> handful of names (`URI`, `ConflictError`, `MIME`, and `State` — now just
> an address and the value it holds — in `interface.ts`), reused by the
> current engine ("v2", `packages/memory/v2/`). V2 keeps the spirit —
> optimistic concurrency over append-only history — but moves the unit of
> conflict from single facts to **commits with read-set validation**, which
> is what's described below. Toolshed and the runtime speak only v2.

## The data model: documents in spaces

The unit of storage is an **entity document**: a JSON document named by a
hash id (`of:fid1:<hash>`, derived from the cell's creation context — the
document itself mutates while its id stays stable), living in a space, with
the cell's payload under its `value` field (the document shape reserves
room for metadata fields such as `source`, but today the system produces
and consumes only `value`). Cells (Chapter 8) address `(space, id, path)`;
the path is resolved inside the document.

Documents also carry a **scope key**. `PerUser`/`PerSession` cells
(Chapter 2) aren't filtered by queries — the engine physically partitions
revisions by `scope_key` derived from the session's principal
(`v2/engine.ts`). Isolation by partition, not by discipline.

Session documents synchronize by default. With the experimental
[`localSessionDocuments`](../development/EXPERIMENTAL_OPTIONS.md#localsessiondocuments)
flag enabled and server execution disabled, the runtime's own session instance
lives only in its local replica. Explicit foreign-instance reads still go to the
server for admission and loading. A transaction whose reads, writes, and
preconditions are entirely local needs no server connection. Values of the local
session instance are not persisted in the space's SQLite database. Space and
user documents still synchronize.
Server execution always synchronizes session documents so the serving runtime
can read and derive them. Toolshed's webhook runtime keeps its session state
synchronized even when the deployment enables local session storage for clients.

## The commit protocol: optimistic concurrency via read sets

A client sends the synchronized part of a transaction as a `ClientCommit`
(`packages/memory/v2.ts`):

```ts
// Shown for illustration only.
ClientCommit {
  localSeq,                       // client-session-local sequence number
  reads: {
    confirmed: [{ id, path, seq }],      // "I read X at server commit seq N"
    pending:   [{ id, path, localSeq }], // "I read my own unconfirmed commit"
  },
  operations: [ set | patch | delete | sqlite ],
  // (abridged — the real type also carries preconditions, scheduler
  // observations, branch/merge fields, ...)
}
```

With local session storage enabled in client-execution mode, transactions whose
reads, writes, and preconditions are entirely local settle locally. A session
write that consumes shared state still sends those shared reads for server
validation. Mixed
transactions send their space/user operations and reads while keeping session
operations and reads local. Their optimistic session writes settle with the
server verdict: rejection rolls them back and rejects dependent local writes.
Local origin and value preconditions are checked by the replica; the server
validates the synchronized portion described below.

A `patch` operation is itself a small language: alongside the
diff-generated ops (`replace`, `add`, `remove`, `move`, `splice`) it
carries the **mergeable** ops from Chapter 2 — `append`, `add-unique`,
`remove-by-value`, `increment` — which record the *intent* of a collection
write rather than its result. The whole family is defined in one registry;
see `docs/features/patch-operations.md`,
`docs/features/mergeable-collection-writes.md` (including the trade-off:
merging is add-wins, so a stale add landing after a remove resurrects the
element), and `docs/features/keyed-collection-writes.md` (how
`elementById` gives a list element a deterministic address so per-element
edits decompose into these ops).

The `reads` field is the concurrency-control token, built automatically from
the transaction journal (Chapter 8). The protocol is *optimistic*: no locks,
no leases — the client asserts what it saw, and the server validates that
assertion at commit time (`v2/engine.ts`, inside a single SQLite
transaction):

1. **Idempotence.** A commit is keyed by `(sessionId, localSeq)`. A replay
   returns the recorded result; a *different* payload under the same
   `localSeq` is a protocol error. This makes retry-after-disconnect safe.
2. **Read validation.** For each confirmed read, the engine checks whether
   any later revision touched it. Full-document `set`/`delete` conflicts
   with any read of that document; a `patch` conflicts **only if its patched
   paths overlap the read path** (a read can also be recorded as shape-only
   — `nonRecursive` — conflicting only with writes at or above its path).
   Two users patching disjoint fields of the same document both succeed —
   this path-granular rule is what makes field-level two-way bindings
   (Chapter 4) practical under concurrency. Mergeable ops go one step
   further, on the client side: the op's own incidental read of the
   container is dropped from the read set, so two concurrent `append`s or
   `increment`s to the *same* collection both land, applied against durable
   state — they merge rather than conflict. (A reader that explicitly
   `.get()`s the list still records that read, and still
   conflicts-and-retries.)
3. **Pending resolution.** Pipelined commits (a client needn't wait for ack
   to keep committing) have their pending reads mapped to the server
   sequence numbers their dependencies actually landed at, then validated
   the same way.
4. **Append.** The commit gets the next global `seq`; each operation becomes
   a revision row; per-document heads advance.

On conflict, the loser gets a `ConflictError` *and* the server immediately
pushes fresh state for the contested documents to that session — so the
client-side story from Chapter 8 (revert, re-run, retry) starts from
current data, not after another round trip.

Client-side resilience details worth knowing
(`packages/memory/v2/client.ts`): unacknowledged commits are kept and
**replayed on reconnect** (safe by idempotence), and a connection drop
leaves commits queued rather than failed. On the way back the client also
declares what its replica holds, so the server re-delivers exactly what it
lacks — never the whole watch union again, never less than the gap.
Offline-tolerant by construction, within a session's lifetime.

## Subscriptions: watches over schema-shaped graphs

With local session storage enabled, client-executed session reads subscribe to
replica changes without registering server graph watches. A local write or rollback notifies
reactive readers through the same sink/trigger machinery.

For synchronized documents, the read side mirrors the reactive model. Over one
WebSocket, a client opens
a session per space (`hello` → `session.open`, then `transact` /
`graph.query` / `session.watch.set` / `session.watch.add` / `session.ack`).

A **watch** is a set of graph queries: roots (`{id, selector}`) where the
selector is a *schema path selector* — the same schemas from Chapter 7,
acting as a query language. The server traverses each root document,
**following links reachable under the schema**, and records which documents
the traversal touched. That set is the subscription. So "subscribe to this
piece" means: walk its argument/result documents as shaped by its schemas,
across link boundaries, and watch everything you saw. (This is the precise
sense of the tagline from Chapter 1 — *reactivity is subscription to the
result of a query defined by schemas*.)

After every commit the server marks the written ids dirty and, on a
debounced tick, re-walks only the affected graphs per session, diffs against
what that session already has, and pushes a `session/effect` carrying a
`SessionSync` — upserts (id, seq, doc) and removes. The originating
session is skipped (it already applied the change optimistically). The
client integrates the delta into its replica and notifies cell sinks —
re-entering Chapter 8's trigger index, completing the loop from the
Chapter 1 trace.

## On disk: one SQLite database per space

Each space is one SQLite file (`<store>/engine-v3/<space-did>.sqlite`),
WAL-mode. The core tables (`v2/engine.ts` INIT script, abridged):

```sql
"commit"  (seq PK, session_id, local_seq, original JSON, resolution JSON, ...)
           -- the full history of commits; UNIQUE (session_id, local_seq)
revision  (id, scope_key, seq, op, data JSON, ...)   -- one row per operation
head      (id, scope_key → seq)                      -- current tip per document
snapshot  (id, scope_key, seq, value JSON)           -- periodic materializations
branch    (name, parent_branch, fork_seq, head_seq, ...)
blob_store(hash PK, data BLOB, content_type, size)
```

Reading a document means: find its head revision; if it's a `set`, decode
it; if a `patch`, replay patches forward from the nearest snapshot
(a snapshot is written once enough patch revisions — 10 by default —
accumulate since the last full value, bounding replay cost). So the store
is an **event log with materialized checkpoints** — history is retained,
heads are fast, and the conflict checks in the commit protocol are simple
indexed queries over `revision`.

The schema also reveals features at the edge of this tutorial's scope:
`branch` (commits can target named branches forked from main, with merge
records), and persisted scheduler state (tables that let server-side
executors rehydrate action read/write indexes across processes).

## The SQLite capability (cells as databases)

Patterns can also declare cells that *are* SQLite databases (the
`sqlite-builtin`, `docs/specs/sqlite-builtin`): the cell's entity id names a
per-`(space, id)` database file. The design is asymmetric, deliberately:

- **Writes** ride inside ordinary commits as `{op: "sqlite", db, sql, params}`
  operations — atomic with cell writes in the same transaction, conflict-
  checked like everything else. There is no standalone SQL-write RPC.
- **Reads** (`sqlite.query`) bypass the engine connection entirely and go
  through a pooled set of *read-only* connections opened directly on the
  database file (`v2/sqlite/read-pool.ts`), with a statement guard
  (SELECT-only, no ATTACH/PRAGMA). Reads scale without touching the writer;
  read-only is enforced by the OS-level open flag, not by parsing alone.

A server-side registry can also map a handle to an external on-disk
database (`cf piece link sqlite:/abs/path <piece>/<field>`) — read-only —
which is how local datasets get exposed to patterns. (Databases governed by
the CFC flow-control layer additionally capture per-column provenance and
apply read-time clearance to query results — Chapter 10.)

## The local/remote symmetry

One detail with outsized architectural value: the *same* client and server
classes run in-process. `EmulatedStorageManager`
(`packages/runner/src/storage/v2-emulate.ts`) constructs a real
`MemoryServer` and connects the real client over a loopback transport — no
sockets, identical protocol. Tests and CLI runs exercise the genuine commit
and watch machinery, and "local vs deployed" differs only in transport and
authentication. When debugging sync behavior, you can usually reproduce it
entirely in-process.

---

**Next:** [Chapter 10 — Identity, authorization, and
isolation](10-identity-and-security.md): who is allowed to do all of the
above, and how untrusted code is contained.
