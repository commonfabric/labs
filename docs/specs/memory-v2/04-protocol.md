# 4. Protocol

The protocol defines how clients communicate with the memory server. The
current implementation uses WebSocket transport, a lightweight JSON
request/response framing layer, and session-scoped catch-up sync frames for
data delivery.

The major protocol change in this revision is that live data updates are no
longer tied to the invocation id of an individual subscription. The server
tracks a session's active watch set and the client's integrated `seenSeq`, then
pushes whatever that session needs to catch up.

## Status Note

This chapter tracks the currently shipped wire behavior for the memory-v2
rewrite. In particular:

- the handshake is `hello` / `hello.ok`, not a bare `{ "protocol": ... }`
  declaration
- request messages are plain JSON envelopes; transport-level UCAN framing
  remains deferred for this pass
- the toolshed v2 websocket route requires a signed `session.open`
  invocation whose subject, challenge, audience, and session descriptor match
  the current request
- the server ACL policy gates session opens and commands when enabled
- fresh spaces require a space-identity- or service-authorized ACL genesis
  transaction before ordinary writes
- route-level `Origin` enforcement remains deferred
- session resume remains keyed by caller-supplied `(space, sessionId)` rather
  than a server-issued, principal-bound identifier
- the public one-shot read surfaces are `graph.query`, `entity-id.list`, and
  `entity-id.exists`
- watch-set mutations return inline `sync` payloads, and steady-state topology
  shrink does not yet guarantee automatic `removes`

## 4.1 Transport

### 4.1.1 WebSocket

The WebSocket transport provides a persistent, bidirectional channel for:

- commands from the client
- final receipts from the server
- session-scoped sync effects from the server

The client MUST declare its protocol version in the first WebSocket message:

```json
{
  "type": "hello",
  "protocol": "memory",
  "flags": {
    "modernCellRep": true,
    "stableExpressionResultIds": true,
    "versionedGeneratedCellIds": true,
    "messageCompressionV1": true,
    "syncSchemaTableV2": true,
    "verdictCatchUpMarkers": true,
    "entityIdListing": true,
    "entityIdPagination": true,
    "entityIdLookup": true,
    "sessionHoldings": true,
    "sessionReadCeiling": true
  }
}
```

If the server accepts the protocol, it returns:

```json
{
  "type": "hello.ok",
  "protocol": "memory",
  "flags": {
    "modernCellRep": true,
    "stableExpressionResultIds": true,
    "versionedGeneratedCellIds": true,
    "messageCompressionV1": true,
    "syncSchemaTableV2": true,
    "verdictCatchUpMarkers": true,
    "entityIdListing": true,
    "entityIdPagination": true,
    "entityIdLookup": true,
    "sessionHoldings": true,
    "sessionReadCeiling": true
  },
  "sessionOpen": {
    "audience": "did:key:z6Mk...",
    "challenge": {
      "value": "64 hex characters",
      "expiresAt": 1760000000
    }
  }
}
```

If the server does not support the requested version or the required data-model
flags do not match what it implements, it returns a typed error response and
does not mark the connection ready.

`stableExpressionResultIds` declares the expression result identity contract:
`ifElse`, `when`, and `unless` key their result stores on the owning piece and
output spot. It is inherent to the build, and an absent marker means false.
The server accepts a wire-compatible `hello` without this marker, but refuses
every `session.open` on that connection with `SessionRevokedError`, before
authorization, store opening, or session restoration. A reconnecting client
treats this verdict as terminal for the session, dropping its pending commits
and watches. Refusing at session admission uses that terminal path even in
clients that retry server-rejected handshakes.

A client requires the server to advertise the same marker in `hello.ok` and
otherwise fails the connection permanently. This prevents a runtime from
joining a server that admits incompatible expression writers. Browser tabs
must reload and CLI clients must update to a build carrying the marker.
Backend replacement must disconnect existing sockets so their next session
open passes through admission; publishing shell assets alone does not apply
the gate to workers already running in tabs. This changes admission, not the
stored document format, and requires no document migration.

`versionedGeneratedCellIds` independently requires the
[generated cell identity contract](../generated-cell-identity.md): runtimes
honor each piece's accepted addressing format and authored artifact namespace.
It follows the same terminal admission and reconnect rules as
`stableExpressionResultIds`; omission or false refuses session admission,
and a non-boolean value is malformed. Both markers are build contracts.
Before enabling authored updates, deployment must drain old backends and close
their transport sockets. Admission cannot fence a connection still attached to
an old backend, and clearing a server's connection bookkeeping does not close
its transport sockets. Unchanged legacy pieces need no address migration.

`hello` and `hello.ok` are always ordinary memory text messages. When both
peers advertise `messageCompressionV1`, either peer may send later messages as
a versioned binary compression envelope. Its fixed header is followed directly
by one gzip member:

```text
bytes 0..3   ASCII "mcmp"
byte 4       envelope version 1
bytes 5..8   uncompressed UTF-8 byte length, unsigned 32-bit big-endian
bytes 9..    raw gzip bytes
```

A binary first frame violates the protocol because the connection has not yet
exchanged `hello`. Any binary frame on a connection that did not negotiate
`messageCompressionV1` is likewise a protocol violation. Memory WebSocket
hosts close the connection with WebSocket code 1003 in both cases.

A peer expands the binary frame before decoding the memory message inside it.
Messages below 1,024 UTF-8 bytes stay in their ordinary text form, as do
messages whose binary envelope would not be smaller. Receivers therefore accept
both ordinary text and compressed binary messages after negotiation. Expansion
is limited to 256 MiB per envelope and must produce exactly the declared byte
count. Compression work preserves WebSocket message order in both directions.

The capability defaults to `false` when absent. A new peer connected to an old
peer consequently keeps every message in the ordinary form. Each reconnect
starts again with an uncompressed `hello`; compression from the previous
connection does not carry across WebSocket boundaries.
The local `setMessageCompressionConfig(false)` rollback override suppresses
advertisement on clients and servers, keeping connections text-only even when
both builds support compression.

After compression negotiation, a client may change the send mode in both
directions without reconnecting by sending an ordinary text control frame:

```json
{
  "type": "memory.compression",
  "requestId": "debug-1",
  "enabled": false
}
```

The server applies the requested mode to its later sends and returns the same
control frame as an acknowledgement. It returns `enabled: false` when the
connection did not negotiate compression. Both peers continue accepting text
and binary frames after a negotiated connection disables sending compression,
so compressed work already in flight remains valid. Control frames share the
application-message queues and therefore cannot reorder the messages around
them.

The browser shell exposes this exchange as
`await commonfabric.setMemoryMessageCompression(false)`. Passing `true`
re-enables compression on connections which negotiated the capability.

Memory hosts include `sessionOpen.audience` and `sessionOpen.challenge` in
`hello.ok`. The audience is the server DID the client must sign for. Toolshed
uses its service identity DID. The standalone memory host uses a stable
deterministic DID. The public memory client rejects a server that omits either
field.

#### Server Audience Ownership

The audience value identifies the memory server or service that may accept the
signed `session.open`. It is part of the signed invocation, so changing it
invalidates signatures made for the old value.

Production toolshed deployments own this value through the toolshed service
identity. That DID must be stable across restarts and across horizontally scaled
instances that serve the same logical memory endpoint. All instances behind one
toolshed memory endpoint must advertise the same audience. Otherwise a client
can sign for one instance and fail when routing sends it to another instance.

Changing the toolshed service DID is an audience rotation. During rotation,
clients must discover the new value from `hello.ok` and sign new `session.open`
requests for it. Existing open sessions can continue only while their
connection remains alive and keeps using challenges issued by the server that
accepted them. Reconnects and new sessions must use the new audience. Operators
should coordinate rotation with deployment routing and client reconnect
behavior.

Standalone and test memory hosts may use a deterministic local DID, but they
still need to advertise an audience. The public client treats a missing audience
as a protocol error.

The challenge is scoped to this WebSocket connection. The current
implementation generates 32 cryptographically random bytes and encodes them as
64 hexadecimal characters. The challenge expires at `expiresAt`, in unix
seconds. The client signs the challenge and audience into the next
`session.open` invocation. The server accepts the current challenge only once.
After a successful `session.open`, the response includes a new
`sessionOpen.challenge`. The client uses that new challenge for the next
`session.open` on the same connection.

`persistentSchedulerState` was RETIRED 2026-08-04 (server-execution v2
Phase 1 stage C: the persisted observation form was deleted and reduced
to the `scheduler_basis` index — see
[the archived spec](../../history/specs/persistent-scheduler-state.md)).
The server no longer advertises or reads it; an old client that still
advertises it connects normally (optional-capability flags tolerate
mismatch) and takes the flag-absent path it already handled.

`syncSchemaTableV2` advertises support for the hash-keyed schema table described
in [Session Sync Payload](#423-session-sync-payload). It defaults to `false`
when absent. The server sends compact sync payloads only when both peers
advertise the capability; otherwise it sends the historical fully expanded
shape.

`entityIdListing` advertises support for `entity-id.list`. It defaults to
`false` when absent. A client must not send the request unless the server
advertises the capability.

`entityIdPagination` advertises support for the pagination fields on
`entity-id.list`. `entityIdLookup` advertises support for
`entity-id.exists`. Both default to `false` when absent. A client connected to
an older server may make the historical unpaginated list request, but must not
send continuation fields or an existence request.

`verdictCatchUpMarkers` advertises that the server stages a `caughtUpLocalSeq`
catch-up obligation for accepts and conflict rejections, delivered on the
batched fan-out (section 4.11.2). It is build-inherent (always advertised by
this build) and defaults to `false` when absent: against an older server that
stamps markers only for conflicts, the client applies verdicts immediately
instead of parking them.

`sessionHoldings` advertises that the server takes a reconnecting client's
DECLARED holdings — the `holdings` a resuming `session.open` and a
re-establishing `session.watch.set` may carry (sections 4.1.2 and 4.3.5) — as
the base of its delivery diff, in place of its own memory of the session. It is
build-inherent and defaults to `false` when absent. A client whose consumer
declares holdings treats the flag's absence as terminal at restore: the initial
connection proceeds normally (nothing is held yet, so nothing needs declaring),
but a reconnect MUST fail that session with an explicit error rather than
silently fall back to the delivery paths the declaration exists to replace — a
server-memory resume can elide a document the replica lost. A consumer that
declares no holdings is unaffected: its sessions restore on the
declaration-less paths (a resumed session diffed against the server's memory, a
fresh one delivered in full) on any server.

`sessionReadCeiling` advertises that the server records a session's declared
read ceiling — the `readCeiling` of the signed `session.open` descriptor
(section 4.1.2) — and that runs served as that session read their `db.query`
results under it (server-side execution `protocol.md` §1; sqlite-builtin
`06-cfc.md`, "Runtime read ceiling"). It is build-inherent and defaults to
`false` when absent. A client whose session declares a ceiling REQUIRES it: an
older server would accept the descriptor and serve every query unbounded, so
the client refuses to open the session against a server that does not
advertise it, before signing a `session.open`. A client declaring none is
unaffected on any server.

### 4.1.2 Logical Sessions and Resume

Pending-read resolution, idempotent replay, and live sync are scoped to a
logical session per space rather than to one TCP connection.

```typescript
// Shown at module scope.
type SessionId = string;
type SignatureBytes = Uint8Array;

interface SessionOpenRequest {
  type: "session.open";
  requestId: string;
  space: SpaceId;
  session: {
    sessionId?: SessionId;
    seenSeq?: number;
    sessionToken?: string;
    // The read ceiling every `db.query` served as this session reads
    // under (see the rules). Inside the signed descriptor: a bound on
    // what the session is served, declared by the session itself.
    readCeiling?: SessionReadCeiling;
  };
  invocation?: SessionOpenInvocation;
  authorization?: {
    signature: SignatureBytes;
  };
  // The client's declared holdings, sent when resuming (see the rules).
  // Outside the signed descriptor: it shapes only what this session is
  // re-sent, never what it may read.
  holdings?: SessionHolding[];
}

// One document the client declares it HOLDS: the id, the scope name (the
// instance resolves from the session, as for every frame), the branch
// (absent = the default branch; the diff keys by branch, so a same-id
// document on another branch is a different holding and never stands in
// for this one), the server seq of the covering commit it has confirmed,
// and whether that is a tombstone. A document the client does not list is
// one it does not hold, whatever the server remembers delivering.
interface SessionHolding {
  id: EntityId;
  scope?: CellScope;
  branch?: BranchId;
  seq: number;
  deleted?: true;
}

// A session's declared read ceiling: a non-empty conjunction of
// confidentiality clauses — an atom, or `{ anyOf: [atom, …] }` — and the
// mode a query without an `onExceed` of its own falls back to. The same
// shape, validated by the same rule, as the runtime option
// `cfcReadMaxConfidentiality`; a malformed one refuses the message.
type CfcAtom = string | { [key: string]: unknown };

interface SessionReadCeiling {
  maxConfidentiality: (CfcAtom | { anyOf: CfcAtom[] })[];
  onExceed?: "fail" | "skip";
}

interface SessionOpenInvocation {
  iss: DID;
  cmd: "session.open";
  sub: SpaceId;
  aud: DID;
  args: {
    protocol: "memory";
    session: {
      sessionId?: SessionId;
      seenSeq?: number;
      sessionToken?: string;
    };
  };
  challenge: string;
  iat: number;
  exp: number;
}

interface SessionOpenResult {
  sessionId: SessionId;
  sessionToken: string;
  serverSeq: number;
  // Highest of the session's own localSeqs whose verdicts are decided and
  // reflected in delivered/served state (SESSION localSeq space, not server
  // seqs). Lets a resuming client re-anchor its catch-up point without
  // waiting for a frame. See section 4.11.2 for the stamping contract.
  caughtUpLocalSeq?: number;
  resumed?: boolean;
  sync?: SessionSync;
  sessionOpen: {
    challenge: {
      value: string;
      expiresAt: number;
    };
    audience: string;
  };
}
```

Rules:

- the client MUST open or resume a session before issuing any memory commands
  for that space on the current connection
- `sessionId` is caller-supplied in the current pass when the client wants to
  resume an existing logical session; server-issued, principal-bound ids remain
  deferred
- `sessionToken` is a server-issued opaque resume capability; clients MUST
  present the latest token when resuming an existing session
- `seenSeq` is the highest canonical seq the client has fully integrated into
  confirmed state
- `resumed: true` means the server found an existing logical session for the
  supplied `(space, sessionId)` pair
- a session's `readCeiling` is taken from the descriptor of its LAST open,
  never inherited: a resume that declares none reads unbounded, and one that
  re-declares reads under what it re-declared. The server records it on the
  session and the serving runtime reads it per run; a server may also assign
  a session a ceiling of its own, which lands in the same record
- the server rotates `sessionToken` on every successful `session.open`
- at most one connection may own a given `(space, sessionId)` at a time
- a successful resume transfers ownership to the new connection, invalidates the
  old owner for that session, and MAY emit `session/revoked` to the previous
  owner with reason `"taken-over"`
- a successful `session.open` rotates the one-time connection challenge and
  returns the next challenge in `sessionOpen`
- a stale `sessionToken` MUST fail with `SessionRevokedError`
- when a resumed session already has watches installed, `sync` carries the
  catch-up delta the client missed while offline
- a resuming client that advertises `sessionHoldings` (and whose server does)
  sends `holdings`: the documents its replica holds, each at the seq it holds
  it at. The server replaces its memory of what the session was delivered with
  that statement before computing the catch-up, so the delta re-delivers every
  document the client does not hold — one it never absorbed, or lost with a
  replaced replica — and elides every one it does. A session with no watches
  covers nothing: the catch-up retracts as `removes` whatever the declaration
  (or, undeclared, the delivery memory) still lists, and clears the memory,
  so nothing outside the empty union lingers as demand. A resume without
  `holdings` is diffed against the server's memory
- after reconnect, the client resumes the session, replays retained commits,
  applies inline catch-up `sync` when present, and only re-establishes the
  watch set if the session was reopened fresh — declaring its holdings on that
  `session.watch.set` (section 4.3.5) so the re-establishment carries the
  difference rather than the whole union
- a `session.open` denied with an `AuthorizationError` the server did NOT mark
  `retriable` is permanent: the client stops reopening that session and
  terminates it with the real error rather than retrying the identical handshake
  forever. A `retriable` authorization race (an expired, used, or mismatched
  challenge; a stale signed `exp`) and every transport-level disconnect still
  retry, so a transient blip or a fresh-challenge race heals. A permanent
  protocol-flag mismatch at `hello` ends the whole connection the same way. See
  [`../../features/authorization-failure-surfacing.md`](../../features/authorization-failure-surfacing.md)
  for how the client, the runner storage layer, and the CLI act on this
  classification end to end.

## 4.2 Message Format

### 4.2.1 Client → Server: JSON Request Envelope

The current wire protocol uses JSON message envelopes serialized at the wire
boundary with the shared flag-dispatched value codec. The `modernCellRep` flag
MUST match between peers; optional capabilities govern accepted operations,
and `stableExpressionResultIds` and `versionedGeneratedCellIds` govern session
admission as described above.
`session.open` currently carries the
only signed authorization material in this pass; `transact` carries just the
semantic commit body. Per-commit signed UCAN envelopes remain deferred.

```typescript
// Shown at module scope.
interface HelloMessage {
  type: "hello";
  protocol: "memory";
  flags: {
    modernCellRep: boolean;
    stableExpressionResultIds?: boolean;
    versionedGeneratedCellIds?: boolean;
    messageCompressionV1?: boolean;
    syncSchemaTableV2?: boolean;
    entityIdListing?: boolean;
    entityIdPagination?: boolean;
    entityIdLookup?: boolean;
    sessionHoldings?: boolean;
    sessionReadCeiling?: boolean;
  };
}

interface RequestMessage {
  type:
    | "session.open"
    | "transact"
    | "graph.query"
    | "entity-id.list"
    | "entity-id.exists"
    | "session.watch.set"
    | "session.watch.add"
    | "session.ack"
    | "event.attention.resolve";
  requestId: string;
  space: SpaceId;
  sessionId?: SessionId;
}
```

The server-owned attention resolver addresses one immutable event-stream entry
by its stream sidecar, event ID, and stamped sequence. Retry and Dismiss are
same-space atomic decisions. A replay returns the first recorded resolution,
including after ordinary event compaction removes the resolved source entry.

```typescript
// Shown at module scope.
interface EventAttentionResolveRequest {
  type: "event.attention.resolve";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  sidecarId: string;
  eventId: string;
  seq: number;
  action: "retry" | "dismiss";
}
```

Per-commit invocation / authorization persistence is deferred in this pass.

#### Record positions in an envelope

Every position where a message names fields holds a plain object. Those
positions are the message itself, and within it `session`, `invocation`,
`commit`, `query`, `db`, `db.tables`, each entry of `holdings`, and a
`hello` message's `flags`. Both sides refuse anything else there, and the
refusal is the one a string or a number in that position gets.

The value codec that decodes a frame builds class instances as well as
records: a `FabricBytes`, a `FabricLink`, a `FabricRegExp`, a
`FabricError`. None of those carries properties, so reading named fields
off one reads nothing at all. The shape check at the position is what
settles whether a value belongs there; the field checks that follow it
cannot.

An instance is a value, and what a record position *contains* may be one.
The `signature` of a `session.open` authorization is a `FabricBytes`, and
a `transact` commit carries links inside the documents it writes. The
requirement is on the container, not on what the container holds.

### 4.2.2 Server → Client: Response and Session Effect

The server sends:

- `response` for command results
- `session/effect` for catch-up sync on an open logical session
- `session/revoked` when a session loses ownership to a newer connection

```typescript
// Shown at module scope.
interface ResponseMessage<Result> {
  type: "response";
  requestId: string;
  ok?: Result;
  error?: {
    name: string;
    message: string;
    // On an AuthorizationError, present and `true` when the denial is an
    // anti-replay handshake race a fresh reconnect heals (an expired, used, or
    // mismatched connection challenge; a stale signed `exp`). Absent marks a
    // permanent denial — an audience or protocol mismatch, or an ACL capability
    // shortfall — that no retry changes. The client uses it to decide whether to
    // keep reopening a denied session or to terminate it. An older server sends
    // no marker, so its AuthorizationError is read as permanent.
    retriable?: boolean;
    // Positive, versioned evidence that the server reached a durable no-commit
    // verdict. Delivery recovery may use this to distinguish a permanent
    // protocol failure from an ambiguous transport or storage outcome.
    permanentEvidence?: true;
    // Engine revision whose ACL state produced an authorization denial.
    aclRevision?: number;
  };
}

interface SessionEffect<Effect> {
  type: "session/effect";
  space: SpaceId;
  sessionId: SessionId;
  effect: Effect;
}

interface SessionRevoked {
  type: "session/revoked";
  space: SpaceId;
  sessionId: SessionId;
  reason: "taken-over";
}
```

Live data delivery is not routed through the initiating request id.

Attention resolution returns this result through the response envelope:

```typescript
// Shown at module scope.
interface EventAttentionResolveResult {
  serverSeq: number;
  resolution:
    | { kind: "dismissed" }
    | { kind: "retried"; eventId: string };
}
```

### 4.2.3 Session Sync Payload

```typescript
// Shown at module scope.
interface SessionSync {
  type: "sync";
  fromSeq: number;
  toSeq: number;
  // Outcome marker (SESSION localSeq space): every verdict of the receiving
  // session's commits through this localSeq is decided, and this frame
  // reflects those outcomes for the docs it covers (section 4.11.2).
  // Releases the client's read-repair gate and applies parked accepts —
  // the promotion of accepted-but-unpromoted commits from pending overlay
  // to confirmed mirror.
  caughtUpLocalSeq?: number;
  upserts: Array<{
    branch: BranchId;
    id: EntityId;
    seq: number;
    doc?: EntityDocument;
    deleted?: true;
  }>;
  removes: Array<{
    branch: BranchId;
    id: EntityId;
  }>;
}
```

Semantics:

- `upserts` carry the latest state each watched entity should have after
  integrating `toSeq`
- `deleted: true` means the entity is currently tombstoned
- `removes` are not deletions in storage; they mean the entity is no longer in
  the session's relevant watch-set result

#### Negotiated schema-table encoding

When both peers advertise `syncSchemaTableV2`, the server MAY compact a
server-to-client `SessionSync` carried by `response.ok.sync` or
`session/effect.effect`. For each JSON Schema attached to a modern `link@1`
payload, it:

1. computes the canonical tagged schema hash
2. replaces the inline schema with `schema-ref@2:<tagged-hash>`
3. adds the interned schema to a frame-local `schemaTable` keyed by that
   hash (structurally equal to the inline schema; its serialized key order is
   not guaranteed canonical — only the hash is)

For example, the compact wire form can contain:

```json
{
  "type": "sync",
  "fromSeq": 10,
  "toSeq": 11,
  "upserts": [{
    "branch": "",
    "id": "of:example",
    "seq": 11,
    "doc": {
      "value": {
        "contact": {
          "/": {
            "link@1": {
              "id": "of:contact",
              "path": [],
              "schema": "schema-ref@2:fid1:..."
            }
          }
        }
      }
    }
  }],
  "removes": [],
  "schemaTable": {
    "fid1:...": {
      "type": "object",
      "properties": { "name": { "type": "string" } }
    }
  }
}
```

The table is scoped to one sync payload, not to a connection or logical
session. A client MUST resolve every `schema-ref@2:` before exposing the sync to
the session cache. It MUST reject a reference when the table is missing the key
or when hashing the referenced table value does not reproduce the key. It MUST
also reject a sync whose documents still carry a reserved reference at a
recognized schema position after expansion — a reference the client does not
interpret must fail the frame rather than reach the session cache as data.
After expansion, downstream consumers observe the historical `SessionSync`
shape with inline schemas and no `schemaTable` field.

Earlier revisions of this encoding also interned the `schema` field of
`$alias` records. Those records are Pattern-binding vocabulary, not links —
their `schema` field is binding metadata — and saved patterns continue to
carry them, so current servers leave alias schemas inline. Clients deployed
against the earlier revision continue to expand references at alias schema
positions, so those positions remain covered by the reservation rule below.

The `schema-ref@2:` prefix is reserved in the `schema` field of `link@1` and
`$alias` payloads. Link recognition follows the canonical cell-rep form — in
the legacy representation, the single-key `{ "/": { "link@1": … } }`
envelope — so an envelope carrying sibling keys is not a link and its contents
are ordinary data. Memory servers MUST reject set or patch operations
whose resulting stored document uses that prefix as an opaque schema string in
a recognized schema position; ordinary strings in other document positions are
unaffected.

### 4.2.4 Batching

The current JSON wire format does not define a separate batch envelope. Clients
issue one request per message in this pass.

## 4.3 Commands

### 4.3.1 `transact` — Write Operations

```typescript
// Shown at module scope.
interface TransactRequest {
  type: "transact";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  commit: ClientCommit;
}

interface Commit {
  seq: number;
  branch: BranchId;
  sessionId: SessionId;
  localSeq: number;
  original: ClientCommit | BranchLifecycleWrite;
  resolution: {
    seq: number;
    resolvedPendingReads?: Array<{ localSeq: number; seq: number }>;
  };
  invocationRef: Reference | null;
  authorizationRef: Reference | null;
  revisions: StoredRevision[];
  createdAt: string;
}

type TransactResult =
  | { ok: Commit }
  | { error: ConflictError }
  | { error: TransactionError }
  | { error: AuthorizationError };
```

Path conventions on the wire:

- `ClientCommit` reads and writes use full document paths.
- `readValue` / `writeValue` style helpers are client-side conveniences that
  prepend `"value"` before constructing those commit paths.
- Inline `data:` document reads are local-only. Clients may read them during
  traversal, but must not serialize them into `ClientCommit.reads` because they
  have no server sequence and do not participate in conflict validation.
- query selectors remain value-relative and are re-rooted by the shared
  traversal layer.

### 4.3.2 `query` — Deferred In This Pass

The older simple `/memory/query` surface is not currently exposed on the v2
wire. One-shot reads in this pass use `graph.query` directly.

### 4.3.3 `graph.query` — One-Shot Schema Traversal

`graph.query` performs one-shot schema-guided traversal.

```typescript
// Shown at module scope.
type ValuePath = readonly string[];

type ValueSchemaPathSelector = Omit<SchemaPathSelector, "path"> & {
  path: ValuePath;
};

interface GraphQueryRoot {
  id: EntityId;
  selector: ValueSchemaPathSelector;
}

interface GraphQueryRequest {
  type: "graph.query";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  query: {
    roots: GraphQueryRoot[];
    branch?: BranchId;
    atSeq?: number;
  };
}

interface GraphQueryResult {
  serverSeq: number;
  entities: EntitySnapshot[];
}
```

The selector path is relative to `document.value`, not the full stored document
root. The server converts it to a document path by prepending `"value"` before
running shared traversal.

### 4.3.4 Entity Identifier Discovery and Lookup

#### `entity-id.list` — List Live Entity Identifiers

`entity-id.list` returns the identifiers of live entities in the default branch
and space scope. The server reads the current entity index and does not select
or return stored entity values. The result is sorted by identifier.

```typescript
// Shown at module scope.
interface EntityIdListRequest {
  type: "entity-id.list";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  after?: EntityId;
  limit?: number;
  expectedServerSeq?: number;
}

interface EntityIdListResult {
  serverSeq: number;
  ids: EntityId[];
  nextAfter?: EntityId;
}
```

The command requires `READ` access to the space. Deleted entities, user-scoped
entities, and session-scoped entities do not appear in the result.

The server caps `limit` at 1,000 identifiers. `nextAfter` is present when
another page exists. The client sends that value as `after` and sends the first
page's `serverSeq` as `expectedServerSeq` on every continuation. If the space
changes between pages, the server returns `SnapshotChangedError`. It does not
silently restart the enumeration or combine pages from different snapshots.

A request without pagination fields retains the original protocol behavior and
returns the complete list. This compatibility path is for clients connected to
servers that advertise `entityIdListing` without `entityIdPagination`.

#### `entity-id.exists` — Test One Live Entity Identifier

`entity-id.exists` tests the same live, default-branch, space-scoped identifier
index without selecting an entity value.

```typescript
// Shown at module scope.
interface EntityIdLookupRequest {
  type: "entity-id.exists";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  id: EntityId;
}

interface EntityIdLookupResult {
  serverSeq: number;
  exists: boolean;
}
```

The command requires `READ` access to the space. It does not reveal user- or
session-scoped instances of the same identifier.

### 4.3.5 `session.watch.set` — Replace the Session Watch Set

The watch set defines the union of queries whose results the session wants kept
up to date.

```typescript
// Shown at module scope.
interface WatchSpec {
  id: string;
  kind: "query" | "graph";
  query: GraphQuery;
}

// As defined in section 4.1.2.
type SessionHolding = {
  id: EntityId;
  scope?: CellScope;
  seq: number;
  deleted?: true;
};

interface WatchSetRequest {
  type: "session.watch.set";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  watches: WatchSpec[];
  // The client's declared holdings (section 4.1.2): when present, the
  // response's `sync` is the difference between the new union and these.
  holdings?: SessionHolding[];
}

interface WatchSetResult {
  serverSeq: number;
  sync: SessionSync;
}
```

Semantics:

- the provided watch list replaces the entire prior watch set for the session
- the server recomputes the union of watched entities
- the response carries the initial `sync` needed to bring the session cache in
  line with the new interest set: the whole union when the request declares no
  `holdings`, and otherwise the difference between the union and the declared
  holdings — a held document at its current seq is elided, a changed or
  unlisted one is delivered, and a held document the union no longer covers is
  removed. This is how a client whose server session lapsed (an expired
  resume, a restarted server) re-establishes its watches without downloading
  again every document it still holds
- later committed changes continue to arrive via `session/effect`

### 4.3.6 `session.watch.add` — Extend the Session Watch Set

`session.watch.add` incrementally adds new watch specs into the existing
session watch set by `id`.

```typescript
// Shown at module scope.
interface WatchAddRequest {
  type: "session.watch.add";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  watches: WatchSpec[];
}

interface WatchAddResult {
  serverSeq: number;
  sync: SessionSync;
}
```

Semantics:

- each provided watch with a new `id` is added to the existing watch set
- if a provided watch reuses an existing `id` with the same definition, it is a
  no-op
- if a provided watch reuses an existing `id` with a different definition, the
  server rejects the request; clients must use `session.watch.set` to replace
  the full watch set
- new graph watches are evaluated from their new roots only
- traversal stops immediately when it reaches an already tracked
  entity-plus-selector pair
- the server returns the inline `sync` needed for the mutation; pure additive
  growth does not emit `removes`
- in the current pass, `removes` are only guaranteed for explicit watch-set
  replacement; steady-state topology shrink does not yet drive automatic
  unwatch behavior
- watch mutations are applied in order per session; clients must serialize
  `session.watch.set` and `session.watch.add`

### 4.3.7 Branch Lifecycle Commands

Branch create / delete / merge lifecycle commands are not currently exposed on
the v2 wire. The engine already carries branch state internally, but public wire
commands for that surface remain deferred in this pass.

## 4.4 Selectors

Selectors still describe sets of entities or schema-guided traversals. The
protocol change in this revision is not selector syntax; it is the transport
model for delivering live updates.

## 4.5 Authentication

### 4.5.1 Current Pass

Transport-level authentication is only partially implemented in this pass.
Write-class requests may carry `invocation` / `authorization` payloads so they
can be persisted alongside accepted commits, but the current wire protocol
still uses plain JSON envelopes rather than full UCAN message framing.

On memory WebSocket routes, `session.open` itself is authenticated:

- the request must carry `invocation` and `authorization`
- `invocation.cmd` must be `"session.open"`
- `invocation.iss` must be a DID whose signature verifies
- `invocation.sub` must match the requested `space`
- `invocation.args.session` must match the requested session descriptor
- `invocation.args.protocol` must be the memory protocol
- `invocation.challenge` must match the current connection challenge
- the challenge must still be live
- the challenge must not have been used already on this connection
- `invocation.aud` must match the server audience from `hello.ok`
- `invocation.iat` and `invocation.exp` are signed into the invocation
- `invocation.exp` must not be expired beyond the server clock-skew grace
- the signature must verify against `invocation.iss` for the hash of
  `invocation`

Opening a previously unused space may initialize empty backing storage, but
`session.open` is not itself a logical write or claim.

When ACL policy is active, the authenticated principal is evaluated against
the space ACL document (wire entity id `of:<space DID>`) for every command:

| Stored ACL state | Effective access |
| --- | --- |
| valid ACL with a concrete OWNER | Explicit principal grant, then `"*"`; normal READ < WRITE < OWNER ordering |
| never-created ACL, server sequence 0 | Authenticated READ only; the first write must be a valid ACL-only genesis by the space identity or a service DID |
| never-created ACL, server sequence greater than 0 | Temporary pre-launch compatibility: authenticated READ and WRITE, never OWNER |
| malformed, ownerless, or retracted ACL | No ordinary access (fail closed) |

The exact space DID and configured service DIDs retain implicit OWNER so they
can initialize or repair ACL state. A valid ACL mutation is a whole-document,
space-scoped replacement on the default branch and must retain at least one
concrete (non-`"*"`) OWNER. Patch, deletion, mixed ACL/data commits, and
last-owner removal are rejected. These shape and genesis rules are hard
storage invariants in both `observe` and `enforce`; `observe` relaxes only
ordinary capability shortfalls on an already valid ACL.

The shape and genesis rules are catalogued as **INV-12** (ACL mutation commit
shape) and **INV-13** (ACL genesis precedence and authority) in
[`09-invariants.md`](09-invariants.md#inv-12--acl-mutation-commit-shape) —
go there for the exact admission predicate, what each rejection message means,
and what is and is not known about why the whole-document rule exists. A client
that writes the ACL through an ordinary value-surface `set` emits `op: "patch"`
and is refused with "ACL mutations must replace the space-scoped ACL document";
it must address the whole document instead.

Genesis remains an explicit transaction. For a fresh named space, the storage
manager briefly authenticates as the derived space identity, writes the genesis
document against a confirmed absent ACL, closes that bootstrap session, and
mounts the durable session as the active user. The document is whichever the
caller registered beside the space key
(`registerSpaceIdentity(identity, { genesisAcl })` — the space is then born
with exactly that ACL, this admission check is the only validation it
receives, and an open of a space that already exists proceeds only if it is
owned exactly as that document says — grants below OWNER are the owner's to
evolve — else is refused), else the fallback
`{ [activeUser]: "OWNER", "*": "WRITE" }`. The wildcard grant is the rollout
default until ACL management has a UI, spelled once as the runner's
`DEFAULT_GENESIS_GRANTS`; the active user remains the concrete owner who can
later narrow it. This preserves user/session-scoped partitioning. When the
active identity already is
the space DID (the home space), the same flow instead writes
`{ [space]: "OWNER" }`; that narrow path also privatizes a populated legacy
home with no ACL. Populated named spaces with no ACL remain public under the
compatibility row above.

The server's unauthenticated `writeDocument` operator path cannot create a
fresh space or mutate the ACL document while ACL policy is active. Its access
to ordinary documents in an already-created space remains a known deferred
blob-authorization issue.

The challenge protects against replay of a captured signed `session.open` after
the original WebSocket handshake has moved on.
It also limits a captured open to the connection that received the challenge.
Audience binding protects against replaying an open signed for one memory host
to another memory host.

This does not prevent every relay attack.
A fully interactive relay can still forward the server challenge to a signer
and forward the signed result back to the same server.
The user or calling code still needs to intend the operation it signs.
Transport security, origin checks, and product-level signing prompts remain
part of the complete security boundary.

The memory protocol does not add encryption above WebSocket.
The `messageCompressionV1` envelope changes representation only and provides
no confidentiality or integrity protection. Compressed frame sizes reveal
plaintext-length and repeated-substring correlations, so callers must not treat
wire length as confidential.
Remote deployments must expose the route over `wss` or another TLS-protected
transport.
Plain `ws` is only appropriate for local development or a trusted private
transport.

Broader ACL-based read opens and non-owner session opens are implemented by the
server ACL policy when enabled.
Route-level `Origin` checks remain future work on the v2 websocket route.

### 4.5.2 Future Target

The longer-term target is still UCAN-authorized memory commands. When that
cutover lands, the invocation object will define the command and the
authorization object will prove that
the issuer was allowed to submit it. Successful write-class commands persist
both references for later audit.

### 4.5.3 Space Authorization

When transport-level authorization lands, read commands will require read
access and write-class commands will require write access.

## 4.6 Session Sync Delivery

When a successful commit or watch-set change affects the entities relevant to a
session, the server pushes a `session/effect`.

### 4.6.1 Delivery Model

The server maintains, per session:

- the active watch set
- the highest integrated `seenSeq`
- the current session cache or enough metadata to compute deltas

The live-sync contract is:

1. determine which entities are relevant to the session's current watch union
2. compare that relevant set with what the session has already integrated
3. send one or more `SessionSync` frames to bring the session up to date

### 4.6.2 Overlap and Deduplication

Because the watch set is a union, overlapping watches dedupe naturally:

- one entity appears once in the session cache even if many watches include it
- one sync frame can satisfy many overlapping watches
- the client derives per-watch views locally from the session cache

### 4.6.3 Watch Changes

When the client replaces the watch set:

- newly relevant entities are sent as `upserts`
- entities no longer relevant are sent as `removes`
- entities still relevant but unchanged are not resent when the replacement
  declares `holdings` (section 4.3.5); a replacement that declares none is
  delivered in full, since the server does not assume a silent client holds
  anything

In the current pass, that `removes` guarantee only applies to explicit
watch-set replacement. Steady-state topology shrink during background refresh
does not yet drive automatic unwatch behavior.

### 4.6.4 Cross-Session Delivery

Commits from one session must still trigger sync for all other sessions whose
watch unions are affected.

### 4.6.5 Commit Notification Model

The runtime-facing scheduler rules remain the same:

1. optimistic local commit fires one synchronous `commit` notification
2. server rejection fires a later `revert`
3. externally integrated or newly confirmed server data fires `integrate` only
   when it becomes visible beyond any newer local pending shadowing

## 4.7 Error Responses

All errors are returned in `response`.

```typescript
// Shown at module scope.
interface ConflictError extends Error {
  name: "ConflictError";
  /** Server head seq at rejection time (§3.6.4). */
  retryAfterSeq: number;
  /** First stale confirmed read per branch, entity, and scope. */
  conflicts?: Array<{
    of: string;
    scope: "space" | "user" | "session";
    /** Absent for the default branch. */
    branch?: string;
    seq: number;
    conflictSeq: number;
  }>;
}

interface TransactionError extends Error {
  name: "TransactionError";
  cause: SystemError;
}

interface QueryError extends Error {
  name: "QueryError";
  cause: SystemError;
}

interface AuthorizationError extends Error {
  name: "AuthorizationError";
}

interface ConnectionError extends Error {
  name: "ConnectionError";
  cause: SystemError;
}

interface RateLimitError extends Error {
  name: "RateLimitError";
  retryAfter: number;
}
```

## 4.8 Client Library API

### 4.8.1 Connection

```typescript
// Shown at module scope.
interface MountOptions {
  sessionId?: SessionId;
  seenSeq?: number;
}

interface MemorySession {
  mount(space: SpaceId, options?: MountOptions): SpaceSession;
  close(): void;
}
```

### 4.8.2 Space Session

```typescript
// Shown at module scope.
interface SpaceSession {
  transact(
    args: ClientCommit,
  ): Promise<Result<Commit, ConflictError | TransactionError>>;
  query(args: Query): Promise<FactSet>;
  graphQuery(args: SchemaQuery): Promise<FactSet>;
  watchSet(watches: WatchSpec[]): Promise<{ serverSeq: number }>;
  close(): void;
}
```

### 4.8.3 Session Cache and Derived Views

The client library maintains one session cache per mounted space:

- confirmed entities integrated through `seenSeq`
- local pending commits layered above that cache
- derived per-watch query results computed locally

An implementation MAY still expose convenience methods named `subscribe()` at
the client API level, but they are library constructs built on `watchSet()` and
the session cache rather than distinct server-routed effect streams.

### 4.8.4 Session Lifecycle

On disconnect:

1. pending promises reject with `ConnectionError`
2. the logical session may still be resumable
3. the client reconnects, replays retained commits, restores the watch set, and
   resumes integrating sync from `seenSeq` — declaring what its replica holds
   (section 4.1.2) so the server re-delivers exactly what it lacks

## 4.9 Blob Transfer

Blob bytes are transferred through dedicated HTTP endpoints. Blob references in
entity values remain content-addressed.

## 4.10 Branch Parameter

`branch` on read and write commands still determines which branch is being read
or mutated. If omitted, the default branch is used.

## 4.11 Message Ordering

### 4.11.1 Client-Side Ordering

Clients MUST:

- submit pending commits in increasing `localSeq` order per logical session
- integrate `SessionSync` frames in increasing `toSeq` order
- build each commit's read set from one stable snapshot
  (`03-commit-model.md` §3.3.4): either buffer incoming sync while a
  transaction builds, or verify at commit that every document the transaction
  read still holds the value it read

### 4.11.2 Server-Side Ordering

The server processes writes serially within a branch, or with equivalent
serializable isolation.

For live sync, transact verdicts return INLINE before the independently batched
fan-out: N commits can apply against one watch-union recompute, which is where
the subscription pipeline's throughput comes from. A per-space publication lock
orders transactions and fan-out: the server sends the verdict while holding the
lock, completes the transaction's post-commit scheduler bookkeeping, and then
releases the lock for fan-out. Locks for other spaces remain independent. The
lock covers each complete turn, so a transaction arriving during fan-out for
its space waits for that fan-out to finish. The remaining ordering contract is
enforced through the catch-up marker and CLIENT-side verdict parking (CT-1927):

- the server MAY coalesce multiple successful commits into one `SessionSync`
  frame
- on a live connection, the server MUST send a commit's transact response
  before any `SessionSync` frame whose `caughtUpLocalSeq` covers that commit
- for every accept and every `ConflictError` rejection, the server MUST
  stage a catch-up obligation for the committing session, and the next
  frame the batched fan-out sends that session MUST carry
  `caughtUpLocalSeq` at or above the verdict's localSeq — an
  otherwise-empty frame when nothing the session watches is dirty. Other
  rejection kinds (protocol, authorization, apply errors) carry no marker
  obligation; the client applies them immediately
- the marker means "every verdict of yours through this localSeq is
  decided, and this frame reflects those outcomes for the docs it covers."
  The frame includes a doc unless the session provably holds it (CT-1965,
  decided per doc by the LAST op the session's accepted commit applied):
  own `set`- and `delete`-produced heads are elided — the writer supplied
  the bytes (or the absence), and the verdict plus marker promote them —
  while own `patch`-produced heads are delivered as full post-apply
  documents, since merged state is truth the writer cannot extrapolate. A
  head moved past the session's own write, and all foreign novelty, is
  delivered in full. REJECTED commits' docs are staged origin-less, so
  repair frames DO cover them, and a frame lost in flight re-stages its
  docs origin-less, so the retry delivers full documents.
- the CLIENT MUST NOT apply a verdict's state effects ahead of the marker
  that covers it: an accept's promotion (pending overlay to confirmed
  mirror, removing the pending local copy) is PARKED until
  `caughtUpLocalSeq` reaches its localSeq. For an elided `set` head the
  promotion installs the client's own value; for a `patch` head the
  covering frame has already delivered the post-apply document, so
  promotion retires the overlay against delivered truth. Extrapolating the
  post-apply state from the client's own ops remains the fallback where no
  frame channel exists — unwatched docs, servers that still suppress; a
  conflict rejection's drop/revert is held by the read-repair gate
  (`finalizeRejection`, with a timeout backstop for lost connections).
  Visible state is unaffected by parking — the pending overlay already
  shows the write.
- parking splits what an accepted commit's client observers wait for. The
  commit PROMISE the submitting caller awaits resolves at marker coverage:
  a resolved commit means the caller's subscribed view reflects the
  committed write and the foreign novelty it was applied on top of.
  Post-commit effects gated on durability alone — verdict callbacks and
  the outbox flush — run at the VERDICT instead: delaying them to
  coverage buys nothing (they do not read the subscribed view) and costs
  a fan-out window on every effect-bearing commit. Commit callbacks keep
  the SETTLEMENT timeline — after coverage on accept, after the
  read-repair gate on rejection — because their consumers act on the
  post-commit view; a `resolveAt: "verdict"` caller's returned promise
  settles early, but its commit callbacks still wait. The same split holds on rejection: the fate is sealed
  at rejection receipt (verdict callbacks fire), while the promise and
  commit callbacks wait out the read-repair gate a retry needs. A caller may opt a commit back to
  verdict timing (`commit({ resolveAt: "verdict" })`) when it needs
  "durably accepted" without forcing the fan-out through —
  controlled-staleness test fixtures foremost.

The server advertises this contract with the build-inherent
`verdictCatchUpMarkers` protocol flag. A client that sees it absent (an
older server that stamps markers only for conflicts) applies verdicts
immediately, as before; a client with no active sync consumer (no watch
view — so no frame stream to order against) also applies immediately.

## 4.12 Mapping from Current Implementation

| Current shape                              | New shape                                                 | Notes                                                     |
| ------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------- |
| `task/effect` tied to `query.subscribe`    | `session/effect` tied to `sessionId`                      | Live sync is session-scoped rather than invocation-scoped |
| Per-subscription routing                   | Watch-set union + session cache                           | Overlap is deduped at the session layer                   |
| Re-subscribe each live query independently | Restore one watch set                                     | The client still restores interests after reconnect       |
| Hash-centric semantic commit identity      | `(sessionId, localSeq)` before accept, `seq` after accept | UCAN envelope refs remain content-addressed               |
