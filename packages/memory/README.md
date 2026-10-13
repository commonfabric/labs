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

## Client authentication and reconnect

On direct connections, a mount joining its principal's lease renewal waits for
the complete renewal, including retriable refusals and backoff. Mounts arriving
during backoff join that same renewal. Its retries request fresh challenges and
are shared regardless of the number of waiting mounts. Permanent refusal,
connection loss, client closure or failure, and the mount's abort signal end the
wait. Canceling one mount leaves the renewal and other mounts running.

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

## Routed transport and quotas

The private listener speaks independently versioned router protocol v1, with
authenticated negotiation and bounded header/chunk/completion records. It
assembles forwarded application bodies at the endpoint, validates their routing
headers against decoded content, and sends responses through a callback-driven
bounded queue. The router forwards private responses without parsing their
application bodies. The
[Mode A specification](../../docs/specs/memory-v2/routed-mode-a.md#private-transport-version-and-streaming-records)
defines framing, public streaming negotiation and compatibility. Public upload
credits bound browser sends by router-accepted record bytes. The router
assembles admission controls before validating them; ordinary application bodies
continue to forward incrementally.

Private peers require signed-link `routerEncodingNegotiation: true` and
`routerRequestAdmission: true`. The router's signed binary `rpc1` appends one
byte `0x01` after the nonce; the host requires that exact byte and end-of-record
before registering the control link. `rpo1` remains four bytes. A data
`router.hello` carries original client `memoryFlags` and separate
`negotiatedMemoryFlags`, selected from the client and the router's frozen
startup public offer. The router-signed `rdb1` binds both canonical hashes,
original first, selected second. The host validates the exact binding before
consuming the ticket or replacing a backend, uses the selection for its backend
hello, and echoes it with explicit support in `router.ready`. Support checks
alone do not authorize a different selection. Private peers require coordinated
deployment; endpoint upgrades cannot enable unadvertised encodings until the
router restarts. Public streaming and credit framing are unchanged.

Private request headers carry consecutive per-socket `requestOrdinal` values
starting at `1`, without wrapping past `2^53 - 1`. The router sends only the
header until a matching 16-byte binary `mri\x01` grant confirms the declared
body-byte reservation and ordinal. This covers streamed requests, buffered
controls and legacy uploads. Both private `router.hello` and `router.ready`
require `routerRequestAdmission: true`; that flag is excluded from public and
effective Memory descriptors. Public upload and private response headers must
not carry request ordinals.

The host retains at most one 4 KiB header while its 4 MiB pending-input budget
lacks capacity, without allocating the body. Request finalization releases
capacity; a successful grant-write callback enables body reception. One sender
control slot lets grants interleave between response records without releasing
logical output-body counts. The router consumes grants before response assembly
and public ownership checks. An owned response can finish while an upload waits;
a blocked public downstream may delay its grant without unbounded read-ahead.
Invalid grants or premature body records close the connection, and cancellation
releases each owned reservation exactly once. Admission uses explicit capacity
grants under the existing caps, independently of public `mrc\x01` credits.

Peers supporting `syncLabelTableV1` negotiate lossless interning of CFC
label-map metadata in sync responses and effects. A sync's `labelTable` stores
distinct labels and `labelPathTable` stores distinct paths; integer references
replace these fields only in document CFC label-map entries. The client expands
schemas, then restores complete metadata before replica integration. Application
values keep their representation. Peers without the capability exchange inline
labels. This transport representation preserves CFC decisions and lets repeated
metadata fit the same frame and parser bounds.

`commitLabelTableV1` independently negotiates CFC metadata tables under
`transact.commit` and transaction acknowledgments' `response.ok`. The client
compacts only the outgoing copy before transport validation; retained commits
stay inline and replay is encoded using the replacement connection's
capabilities. The server expands labels and paths after bounded wire decoding
and before commit-shape, CFC and store validation. Malformed or unnegotiated
metadata tables and references are refused before application. Routed structural
checks see the compact payload and forward it unchanged to the endpoint. The
server compacts acknowledgment revision documents at the connection's send
boundary, including replay results, and the client expands them before resolving
the commit. Each message has its own 16 MiB referenced-metadata expansion
budget. The
[commit encoding contract](../../docs/specs/memory-v2/04-protocol.md#negotiated-commit-metadata-encoding)
defines the positions and expansion budget.

The toolshed paces request-driven output by waiting for zero retained logical
output bytes before decoding and dispatching the next request or producing a
host refusal. Capacity returns after completion-record write callbacks release
each body. A cancellable `setImmediate` between request turns gives socket I/O
an event-loop opportunity. Reads pause at body boundaries while output remains;
an admitted partial body finishes with its input reservation held. Already
buffered receiver events remain subject to the hard input queue bound. Closing
the connection cancels capacity and scheduling waits. Unsolicited effects,
presence, and revocations retain bounded-close behavior on output exhaustion.

The private Mode A host accepts partial `RoutedHostLimits` overrides. Omitted
fields retain defaults, `null` disables an individual quota, and a positive safe
integer sets a custom bound. This includes session, watch, holdings, principal,
proof, request, space, context, ticket and socket quotas. `spacesPerContext`
defaults to 1,200 distinct spaces over a context's lifetime;
`sessionsPerContext` independently bounds simultaneous sessions.
`viewsPerSession` defaults to 64 and `holdingsPerSession` to 8,192. `frameSlots`
defaults to 150,000 JSON values; `null` disables value counting. The router
advertises the matching deployment value in `hello.ok.routerFrameSlots`, which
clients apply to sends and receives until the connection changes. An omitted
hello field retains the 150,000 default. Disabling quotas retains byte and depth
bounds, unambiguous JSON validation, authorization, ownership fencing and replay
checks. The
[Mode A specification](../../docs/specs/memory-v2/routed-mode-a.md#toolshed-deployment-inputs)
describes deployment configuration and validation.

The host's `context-closed` audit retains the first socket failure. An
`output-limit` close includes `outputLimit` with `frameBytes`, `bufferedBytes`,
`limitBytes`, `endpoint` (`data` or `control`), and `classification`
(`single-message` or `queued-output`), sampled before close. `messageType` is
included when the sender has a structured Memory message. The 4 MiB output bound
applies to the larger of retained logical output and outstanding socket bytes,
plus the attempted payload, including when admission quotas are disabled. The
audit carries no payload or error text.

Structured data refusals also carry `outputLimit.diagnostics`: separate
`socketBytes` and `sender.retainedBytes`, queued-body counts, lifetime logical
and record admission/completion counters, active-body written progress, and
monotonic queue/callback ages. A written prefix remains retained until the
body's final record completes. These callbacks measure local socket writes, not
peer receipt. `attemptedSource` identifies the response's originating request
kind and routing identifiers when it matches the serialized dispatch;
unsolicited pushes carry their own routing identifiers. Unmatched responses are
explicitly unattributed. Identifiers are truncated to 256 characters; message
kinds to 64.

`history` retains sixteen enqueue/high-water/callback/recovery observations. At
2 MiB retained output, one Node `setImmediate` marker records an event-loop
opportunity. It is canceled at recovery to 1 MiB or on close. `eventLoop`
reports whether the marker ran and its delay, or is null outside a high-water
episode. Recording introduces no waits or admission changes. Only the failure
audit emits these observations; a low socket counter alone cannot distinguish an
outstanding blocked write from a callback that has not had an opportunity to
run.

Failure-only `messageSizes` measures result fields and sync
documents/schema-table entries using the canonical Memory encoder. It keeps
eight largest measured entries per category, recording paths, document IDs and
standalone encoded byte sizes (including each encoding's format prefix), never
values. These sizes are not additive wire contributions. The scan inspects at
most `min(frameSlots ?? 256, 256)` entries and stops after two raw-message
limits of measured bytes; the final encode can cost one additional frame. Frames
above the 8 MiB raw-message limit are skipped. `truncated` marks incomplete
scans, so a largest entry is largest among those inspected. `unavailable`
preserves the original refusal when independent encoding fails. Queued bodies
have source attribution only; size breakdowns describe the refused message.

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
