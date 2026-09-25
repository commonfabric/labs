# Common Memory

The durable store and wire protocol behind Common Fabric spaces. A space is a
data repository named by a DID; the runtime reads and writes it through this
package, and the server that owns the SQLite file on disk lives here too.

The behavior below is specified in full in
[`docs/specs/memory-v2/`](../../docs/specs/memory-v2/README.md). This document
is a map of the package, not a substitute for the specification.

## Data model

The unit of storage is an **entity document**: a JSON document named by an
entity identifier, holding the payload under its `value` field. Documents are
versioned by a monotonic sequence number (`seq`) that orders every write in a
space, and they are partitioned by a **scope** — `space`, `user`, or `session` —
so that per-user and per-session cells are isolated physically rather than by
convention.

A write is expressed as an **operation**: `set` replaces a document, `patch`
applies a list of edits to one, `delete` writes a tombstone, and `sqlite` folds
a SQLite statement into the same transaction as the cell writes. The patch
vocabulary is JSON Patch plus edits that merge rather than clobber — appending
to an array, adding to it by identity, removing from it by value, and
incrementing a number — each resolved against durable state so that concurrent
writers combine instead of overwriting each other.

## Commit model

A client ships a batch of operations as a **client commit**, which carries the
operations, the set of documents the transaction read, and any preconditions it
needs to hold. Local commits are optimistic: the client applies them immediately
and the server confirms them asynchronously.

The server validates a commit by comparing the sequence numbers in its read set
against the space's current state. If a document the transaction read has moved
on, the commit is rejected as a conflict and the client retries against the
newer state. Conflict granularity is refined for patches, so two writers
touching disjoint parts of one document do not conflict — see
[`08-conflict-granularity.md`](../../docs/specs/memory-v2/08-conflict-granularity.md).

Preconditions cover what the read set cannot express on its own: that an earlier
commit from the same session has landed, that an entity is absent, or that an
entity's value hashes to a specific value.

## Runtime compatibility

The `stableExpressionResultIds` marker in `hello` and `hello.ok` identifies
runtimes whose expression result stores use stable output coordinates. The
server refuses session admission without it, and the client refuses a server
that does not enforce it. Existing incompatible tabs need a reload and CLI
checkouts need an update. Backend replacement must disconnect existing sockets
so they pass through admission again; document contents do not need migration.
The [protocol specification](../../docs/specs/memory-v2/04-protocol.md)
describes the terminal refusal and its reconnect behavior.

## Client queries during reconnect

`Client.restoreConnection()` waits for the transport handshake and restoration
of existing space sessions. A connected transport can still be restoring its
sessions. Ordinary graph, operation-field, entity, and SQLite queries wait for
that restoration before constructing their request with the active session ID.
Event-attention requests and SQLite source registration use the same boundary. A
session closed or permanently refused during restoration fails the request with
its session error. This boundary does not guarantee completion across a
subsequent transport failure during request issuance.

Watch mutations (`watchSetSync()`, `watchAddSync()`, `watchRemoveSync()`, and
`viewSetSync()`) reach the server in call order, through a per-session chain. A
mutation whose turn comes while the connection is down or its session has not
reopened keeps its turn and waits for restoration before it sends. Restoration
re-establishes the watch set without queuing behind those waiting mutations,
after any mutation already sent, and the waiting mutations follow it in call
order. A removal takes effect in the watch set restoration re-establishes from
the moment its turn comes.

## Layout

- `v2.ts` — the protocol vocabulary: documents, operations, commits, queries,
  and every wire message.
- `v2/engine.ts` — the storage engine over SQLite: revisions, heads, snapshots,
  and commit validation.
- `v2/server.ts` and `v2/server-sync.ts` — the WebSocket server, session
  tracking, watch sets, and catch-up sync.
- `v2/client.ts` — the client half: session open and resume, optimistic commits,
  and watch subscriptions.
- `v2/message-compression.ts` — the negotiated binary gzip envelope used by
  remote WebSocket transports for messages where compression reduces wire size.
- `v2/query.ts` — schema-aware graph queries that follow JSON Schema references
  across documents.
- `v2/sqlite/` — the SQLite builtin: statement execution, column provenance, and
  the guards around it.
- `v2/patch.ts` — applying a patch operation to a document.
- `v2/dump.ts` — read-only, crash-consistent snapshots of a space's store, for
  offline inspection.
- `v2/standalone.ts` — the same server on an ephemeral localhost port with a
  non-persistent store, so several runtimes can share one backend without a
  toolshed process.
- `acl.ts` — space access control: capabilities and the access control list.
- `interface.ts` — identifiers, results, and errors shared across the package's
  public surfaces.

## Exports

The package has no root export; import the subpath you need. `./interface` and
`./acl` carry the shared vocabulary, `./v2` the protocol types, and the rest
name one module each — the client, the engine, the server, and the SQLite
surface under `./sqlite`. The `exports` block in `deno.jsonc` is the list.

## Tests

```sh
deno task test
```
