# 3. Commit Model

The commit model defines how state changes are proposed, validated, and
recorded. It provides atomicity (all operations in a transaction succeed or all
fail), serializability (transactions appear to execute one at a time), and
auditability (every mutation is recorded in an append-only commit log linked to
its UCAN envelope).

This revision removes semantic hashes from the JSON write path. A pending write
is identified by `(sessionId, localSeq)` and a confirmed write is identified by
its canonical `seq`.

## 3.1 Operations

An operation describes a single intended mutation within a transaction. Every
operation targets an entity by `id`.

```typescript
// Shown at module scope.
interface SetOperation {
  op: "set";
  id: EntityId;
  value: EntityDocument;
}

interface PatchWriteOperation {
  op: "patch";
  id: EntityId;
  patches: PatchOp[];
}

interface DeleteOperation {
  op: "delete";
  id: EntityId;
}

type Operation = SetOperation | PatchWriteOperation | DeleteOperation;
```

Operations do not include parent hashes or other version identifiers. The server
validates the read set, assigns a canonical `seq`, and records one or more
sequenced revisions. `set` carries a logical `EntityDocument`; `patch` carries
path-targeted edits whose leaf values use the shared FabricValue surface, not
just a JSON subset.

## 3.2 Transaction Structure

A transaction groups one or more operations into an atomic unit. All operations
succeed or all fail.

```typescript
// Shown at module scope.
interface Transaction {
  operations: Operation[];
  codeCID?: Reference;
  branch?: BranchId;
}
```

A transaction MUST contain at least one operation. Validation of all reads
happens before any writes are applied.

## 3.3 Client State: Confirmed and Pending

Clients maintain two tiers of state to support optimistic local writes while
waiting for server confirmation.

### 3.3.1 Confirmed State

The confirmed tier normally contains server-acknowledged state:

- the latest integrated entity values
- the canonical `seq` for those visible values
- any external changes incorporated from session sync frames

An ordinary confirmed record represents the client's last known server
revision. Section 3.8.3 defines an exception: the replica may retain a refused
derived write in this tier, marked `localFold`, without advancing its `seq`.
That record's value is local computation, not server-acknowledged content;
its `seq` identifies the durable base it was computed over. The marker does
not turn the refused commit into an accepted one.

### 3.3.2 Pending State

The pending tier contains optimistic local commits that have not yet been
confirmed. Pending commits are ordered by `localSeq`, which is monotonic within
the logical session.

Each pending commit has:

- a `localSeq`
- the operations included in the commit
- `reads.confirmed` dependencies on confirmed state
- `reads.pending` dependencies on earlier optimistic commits

### 3.3.3 Reading Across Tiers

When a client reads an entity, it MUST check pending state first, newest to
oldest, then fall back to confirmed state, including any local fold held
there. This ensures pipelined transactions see their own optimistic writes.
A local fold remains visible after its refused pending layer is removed.

```text
Read(entity, path):
  1. Check pending commits for overlapping writes at that path
  2. If found, read from the newest matching pending write
  3. Otherwise read from confirmed state
```

### 3.3.4 Single-Snapshot Rule

A commit's read set MUST describe one coherent client view: confirmed bases
from one integrated prefix of the space's history, any local folds over
those bases, and the session's own pending stack, never a mixture of states
observed before and after unrelated incoming changes. This is what makes the
submitted `reads.confirmed[].seq` values meaningful.

A client satisfies the rule in either of two ways:

- **Buffering.** While application code is building a transaction, incoming
  server sync frames are held rather than applied, and applied only after the
  transaction has been submitted or abandoned. The state the reads ran against
  is then the state the commit is built from.
- **Checking.** Frames apply as they arrive. The transaction holds each
  document it reads as a snapshot taken at its first read of that document,
  and at commit re-reads every snapshotted document from the local state the
  read set is exported from, rejecting the transaction locally — before it
  reaches the wire, for its caller to re-run — when any value differs from
  its snapshot. The read set then names the seqs of the local state at build
  time, and the check has established that every read still has the local
  content from which that read set is built. For a local fold, the named seq
  is its durable base, not a claim that the server held the folded value.
  The check has to be immediate: a transaction closed as one commit per
  space builds each space's read set after awaiting the earlier spaces' round
  trips, so it re-checks each later space's documents
  right before building that space's read set.

The runner takes the checking form: `claim()` in
`packages/runner/src/storage/transaction/attestation.ts`, run by every commit
path of `v2-transaction.ts`, and the local rejection is
`StorageTransactionInconsistent`, which those paths' callers classify as
retryable. The two forms are equivalent in what reaches the server; they
differ in when a change under an open transaction is discovered.

A reactive computation opts into `validateReactiveReads`, which checks its
scheduling dependencies before accepting an empty commit or seal. Deep reads
compare the value at the read path; shallow reads compare container structure.
Both distinguish an absent field from a present `undefined` value.
Changes to unrelated fields do not reject an empty computation. The scheduler
installs subscriptions in the same synchronous turn, including the union of
instance reads after each fan-out instance, so changes during later instances
remain observed. A rejected empty computation (including a replaced replica
route) carries `emptyReactiveCommit`. It retries past debounce and throttle
when its node or fan-out instance has no accepted result yet, or no live
demander to wake it. Live nodes with accepted results retain their gates.
Event handlers also carry `sourceAction`, but do not opt into this check:
their empty commits retain ordinary completion and post-commit effects.

## 3.4 Commit Structure

A client commit explicitly separates dependencies on confirmed state from
dependencies on earlier pending commits.

```typescript
// Shown at module scope.
type ReadPath = readonly string[];
type SessionId = string;

interface MergeContext {
  sourceBranch: BranchId;
  sourceSeq: number;
  baseBranch: BranchId;
  baseSeq: number;
}

interface ClientCommit {
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  operations: Operation[];
  codeCID?: Reference;
  branch?: BranchId;
  merge?: MergeContext;
}

interface ConfirmedRead {
  id: EntityId;
  branch?: BranchId;
  path: ReadPath;
  seq: number;
}

interface PendingRead {
  id: EntityId;
  path: ReadPath;
  // The dependency set: every pending layer the read's materialized view
  // sat on. Each element must have resolved to an ACCEPTED commit for this
  // commit to be applicable; the staleness check (§3.6.1) runs once per
  // read, from the basis §3.6.3 selects. A scalar is the single-layer
  // form, and the only form a client may send to a server that has not
  // advertised the `pendingReadStacks` capability in the hello exchange.
  localSeq: number | number[];
  // The reader's confirmed basis for THIS document, in the SERVER's seq
  // space: the seq of the last accepted write to the document that the
  // client's confirmed view reflected at build time (0 for a document its
  // subscriptions never covered). When present, the staleness check scans
  // the FULL interval from this basis, excluding only the own-session
  // layers the `localSeq` array names, per §3.6.3 (the CT-1910 repair
  // with declared-set validation). When absent (a legacy client),
  // staleness is based at the resolution of the HIGHEST localSeq element —
  // the document's top-of-stack layer below the reader, which the array
  // MUST include (§3.5). Servers ignore unknown fields, so clients attach
  // this unconditionally; older servers keep the legacy basis.
  basisSeq?: number;
}
```

Confirmed reads are validated against canonical history. Pending reads are
resolved within the submitting logical session.

A read's `path` is an array holding a string at every index. The server refuses
a commit carrying a read of any other path — one with a hole, one with a
segment that is not a string, or one that is not an array — with a
`ProtocolError`, whether or not the read's staleness is checked. The staleness
check matches a read's path against a write's touched paths segment by
segment, and defines that match for string segments only.

A confirmed read's `seq` names a position in the space's log, and so does a
pending read's `basisSeq` where it has one: a safe integer of zero or more, and
not negative zero, which the wire encoding keeps distinct from zero. `NaN`, an
infinity, a fraction, a negative number, a number past
`Number.MAX_SAFE_INTEGER`, and a value that is not a number name no position,
and nor does a confirmed read with no `seq`. A pending read's `localSeq` is held
to less: it names at least one layer, and each is an integer other than negative
zero. The server refuses a commit carrying a read that breaks any of these rules
with a `ProtocolError`. It does so before it checks the staleness of any read in
the commit, and whether or not it would check that read's. The staleness check
scans the log after the position a read names, and a value that is not one
bounds the scan by accident: after `NaN` it finds no write, so a read naming it
could never be stale.

The rule is one of shape. Which position a well-formed value names is the
client's claim, trusted as §3.6.3 describes; a confirmed read's `seq` past the
head is trusted too, where a `basisSeq` past the head is refused.

## 3.5 Stacked Pending Commits

A client can create commit `C2` that reads from the optimistic writes of earlier
commit `C1`.

```text
C1 submitted (pending, localSeq 1):
  - reads Entity A from confirmed seq 5
  - writes Entity A

C2 submitted (pending, localSeq 2):
  - reads Entity A from localSeq 1
  - writes Entity B derived from A
```

If `C1` is later confirmed, the server resolves `C2`'s pending read to that
confirmed commit. If `C1` is rejected, `C2` is invalid and must be rejected as
well. Rejection therefore cascades through the stack of dependent pending
commits.

The cascade cannot rely on each pending layer reading the layer beneath it:
zero-read operations (mergeable collection writes) legally interleave into a
stack without any read edge. A commit that reads through a pending stack
therefore records its FULL dependency set directly: the read's `localSeq`
array names every pending layer of the document that the reader's
materialized view sat on, in ascending order. Each element imposes a
resolution requirement; the highest element — the view's top-of-stack layer
— is the legacy staleness basis when no `basisSeq` is declared (§3.6.3).

The client mirrors the server cascade from the moment a rejection is KNOWN,
not from the moment the layer leaves the overlay. A client that keeps a
rejected layer in its overlay past the verdict — to hold the drop until the
conflict's read repair lands, so that a retry rebuilds against repaired
confirmed state — is still building views over that layer meanwhile, and so
still names it. It MUST reject such a commit locally rather than send it,
because the server can only answer it with "pending dependency not
resolved"; the same applies to every queued or in-flight commit naming a
`localSeq` whose optimistic writes are dropped. Deciding at the verdict
rather than at the drop is what bounds the cost: otherwise one conflict
spawns a doomed round trip per commit minted anywhere in that window, which
is a run of them under sustained write load, and the window is bounded only
by a timer the client may be in no position to fire. The local rejection's
readiness gate waits for the dependency's drop, so the retry rebuilds
against the repaired base rather than against the dead layer that doomed
it.

Completeness is relative to the VIEW, not to the session's commit history,
so the array may be non-contiguous in the session's `localSeq` space. A
layer the client removed from its overlay before the read view was built — a
rejection verdict honored, the view rebuilt without it — contributed nothing
to the observed value and is legitimately absent from the array, and the
server imposes no resolution requirement on a layer that is not named. This
is what lets a client process a rejection eagerly and still commit later
work built over the surviving layers, rather than dooming every dependent
minted after the verdict. The server verifies the DURABLE half of the
completeness claim: the staleness scan's declared-set exclusion (§3.6.3)
rejects a read whose omitted own layer left an overlapping durable write in
the scan interval, so an omission is only ever accepted when the omitted
layer contributed nothing durable — which a processed rejection never does.
What remains on the client's honor is only the never-durable half: omitting
a REJECTED layer whose optimistic value DID contribute to the observed view
fabricates an observation (the CT-1872 1c phantom shape — an INV-1
violation, `09-invariants.md`), exactly as a fabricated confirmed read
would, and is unverifiable server-side because the rejected value never
crossed the wire. Omission means "my view did not include this layer",
never "I would rather not mention it".

The dependency array MUST include the view's top-of-stack pending layer
below the reader — the highest layer surviving in the overlay when the view
was built. For a read that declares no `basisSeq`, the staleness
basis is the stack top (implicitly, the array's highest element), and basing
the scan at a lower layer is unsound, not merely conservative: the session's
own newer stacked commits then land inside the scan interval, where the
path-blind set/delete check false-conflicts with the reader's own stack. A
read that declares `basisSeq` does not have this constraint on its basis —
own-session exclusion (§3.6.3) removes the self-conflict, which is exactly
what lets the scan start at the true confirmed basis — but the top-of-stack
element remains REQUIRED in the array for its resolution edge. Any narrowing
of the dependency set (for example, pruning layers whose write footprint
provably cannot influence the read path) may drop only NON-top layers.

The array form is a negotiated capability (`pendingReadStacks` in the hello
flags). Toward a server that does not advertise it, the client MUST send
scalar reads, collapsing each array to its top-of-stack element — the
pre-capability wire shape. Because the omitted lower layers are then
invisible to the server, the client MUST NOT send such a commit while any
omitted dependency is unsettled: the server could durably accept a commit
the client is about to cascade-reject, and the caller would observe a
conflict for a write that landed. The client holds the send until every
omitted dependency settles — a dropped one dooms the commit locally before
it reaches the wire, and all-accepted makes the scalar shape sound (each
omitted layer's resolution is already durable). Scheduler observations,
being droppable bookkeeping, degrade instead of holding: an observation
whose read sat on more than one pending layer is dropped client-side
(flag-off semantics — the resume re-runs fresh) rather than delaying the
flush that semantic commits await.

## 3.6 Server Validation

When the server receives a commit, it validates all read dependencies before
applying any writes.

### 3.6.1 Validation Rule

For each confirmed read in the commit:

```text
there MUST NOT exist a later visible overlapping write on
(read.branch ?? commit.branch)
with seq > read.seq
```

The validation model is path-aware and seq-based. A later write to an unrelated
path on the same entity does not invalidate the read.

An **identity commit** is exempt from this rule and from the staleness half of
§3.6.3. It is a commit that leaves every document it writes as the space
already holds it. The server proves that only once a staleness check has
refused the commit, since the proof reads stored documents and reconstructs
the reader's view of each; a commit that validates pays nothing for it, and
one refused for an unresolved or rejected dependency is not a candidate. The
proof is per document, over the commit's `set` and `patch` operations on that
document in order, so a commit that creates a document with a `set` and then
patches it is judged as one write of the final value:

- replayed on the document as the commit's read of that document saw it, the
  sequence yields the stored document;
- replayed on the stored document, the sequence leaves it unchanged. This
  condition is for the writer's replica, which re-folds the operations over
  whatever confirmed base it holds when the accept arrives: a sequence
  idempotent on the durable value lands on that value from any base between
  the read and the head, where a positional splice replayed over a base
  already carrying its elements would duplicate them.

The reader's view of a document is reconstructed from the commit's own read
of it, on the commit's branch: for a pending read, the document at the read's
declared `basisSeq` with exactly the own layers the read names replayed on it
in local order, since that read is the view the value came through, even
where the commit also carries a confirmed read of the document; for a
confirmed read, the document at its `seq`; and the stored document itself
when the commit did not read the document, where the sequence is an identity
only if it is idempotent. A read names its branch only where that differs
from the commit's, exactly as §3.6.1's staleness rule reads it, and a read of
the same entity on another branch is passed over. Two reads leave the view
unreconstructable, and a commit carrying one gets no exemption: a pending
read that declares no `basisSeq`, since the durable document at a named
layer's resolution is not the reader's view, carrying every foreign write on
other paths that landed before the layer and that the reader had not
integrated; and a read whose basis lies below the commit's branch's creation
seq, which names no state of that branch (`06-branching.md` §6.10.1).

Applying such a commit changes nothing, so no read it recorded can have led it
to a wrong write, and refusing it would only make the writer re-derive the
value the space already holds. An operation that is not a `set` or a `patch`,
or that no reconstructed view accepts, keeps the commit out of the exemption.
Every operation of an identity commit elides
(§3.7.1 step 5). The exemption covers staleness only: a pending read naming an
unresolved or rejected layer still refuses the commit (§3.6.3), so a commit the
client has cascade-dropped is never accepted (`09-invariants.md`, INV-6). A
commit touching a space's ACL document is never an identity commit: INV-12 and
INV-13 define its admission, and a losing genesis is refused rather than
recorded twice.

### 3.6.2 Write-Footprint Overlap

Validation is based on overlap, not just entity identity.

- `set` overlaps every read path on the same entity
- `delete` overlaps every read path on the same entity
- `patch` overlaps when any patch op touches the read path, an ancestor of the
  read path, or a descendant of the read path
- structural collection edits MAY be treated conservatively as overlapping the
  whole collection subtree in phase 1

Implementations MAY over-approximate overlap. They MUST NOT miss a real overlap.

### 3.6.3 Pending-Read Resolution

Pending reads are resolved against earlier commits in the same logical session.

```typescript
// Shown inside a pattern body.
function validatePendingReads(
  commit: ClientCommit,
  sessionId: SessionId,
  serverState: ServerState,
): ValidationResult {
  for (const read of commit.reads.pending) {
    const layers = Array.isArray(read.localSeq)
      ? read.localSeq
      : [read.localSeq];

    // Every listed layer must resolve to an ACCEPTED commit. The staleness
    // check (§3.6.1/§3.6.2) then runs once per read, from the basis this
    // section selects below (declared `basisSeq`, or the legacy highest
    // element's resolution).
    for (const localSeq of layers) {
      const resolution = serverState.resolveLocalSeq(sessionId, localSeq);

      if (resolution === null) {
        return pendingDependency(localSeq);
      }

      if (resolution.rejected) {
        return cascadedRejection(localSeq);
      }
    }
  }

  return valid();
}
```

If a referenced `localSeq` is not resolved yet, the server MAY hold the commit
in the session queue until the dependency resolves. If the dependency resolves
to rejection, the queued commit is rejected immediately.

Holding is queueing, not reordering: within a logical session, commits are
resolved (accepted or rejected) in increasing `localSeq` order, and a held
commit MUST NOT be leapfrogged by a later same-session commit. A commit's
resolution seq is therefore monotonic in its `localSeq` within a session —
the property that makes the top-of-stack pending read a sound LEGACY
staleness basis (§3.5): every own-session layer below the reader resolves at
or before the basis layer's seq, so the scan interval past the basis
contains no own-session commits. (The current implementation rejects rather
than holds, which preserves this ordering trivially.) A `basisSeq` read does
NOT lean on this ordering: its own-session exclusion checks each excluded
commit's `localSeq` directly, so an own commit admitted out of submission
order simply conflicts.

Every element of an array `localSeq` participates in this resolution
requirement — one unresolved or rejected element rejects the commit. The
staleness scan (§3.6.1/§3.6.2) then runs once per read, from a basis chosen
by the read's shape:

- **True basis (`basisSeq` present).** The scan covers the full interval
  `(basisSeq, head]` and excludes only the own-session layers the read's
  dependency array NAMES — the accepted layers whose inclusion in the
  reader's materialized view the array attests. The exclusion is what
  makes the true basis sound, and its declared-set restriction is what
  keeps it sound without trusting either wire order or client discipline:
  any own write the array does not name conflicts exactly like a foreign
  write, whether it is a higher `localSeq` admitted first (an out-of-order
  submission) or an omitted layer whose write is durably integrated — a
  view missing durable state it never declared away. The server thereby
  verifies that `basisSeq` plus the named layers fully account for the
  document's durable history at the read path; §3.5's view-relative
  omission allowance stays sound because a processed REJECTION left no
  durable write for the scan to find. (The converse — an omitted rejected
  layer whose optimistic value DID reach the view — is unverifiable from
  durable history and remains in the fabricated-read trust class.) Foreign
  writes in the interval conflict — including those between the reader's
  confirmed basis and the top layer's resolution seq, which the legacy
  basis never scanned. A `basisSeq` greater than the server's current head
  is a protocol error; values at or below head are trusted, like a
  confirmed read's `seq`. A client that misstates its basis can lose a
  concurrent writer's update, but only on a document it may write, where a
  commit carrying no reads could overwrite that update just the same.
  The declared-set restriction is server-side VALIDATION of the array's
  completeness attestation, not an extension of what a client may omit:
  the sanctioned omission remains a processed rejection (§3.5), and a
  client has nothing to gain from omitting a live layer — the scan
  converts exactly that bug into a retryable conflict.
- **Legacy basis (`basisSeq` absent).** The scan is based at the HIGHEST
  element's resolution seq. Writes landing between the reader's confirmed
  basis and that seq are not scanned — the pending-read basis over-advance
  (CT-1910), retained verbatim for old clients and recorded as an INV-1
  known deviation in `09-invariants.md`. The deviation retires when clients
  that omit `basisSeq` do.

### 3.6.4 Conflict Response

When validation fails, the server rejects the commit with a `ConflictError` and
stages the repair for delivery through the sync stream.

```typescript
// Shown at module scope.
interface ConflictError extends Error {
  name: "ConflictError";
  /**
   * Server head seq at rejection time. Carried for diagnostics; a sync window
   * reaching this seq reflects the winning write.
   */
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
```

The rejection carries no document values. Instead the server marks the commit's
write targets and both read sets (`reads.confirmed` and `reads.pending`) dirty
for the session — origin-less, so the session's own echo suppression does not
hide them — and the next sync frame delivers the watched documents as ordinary
upserts. Repair therefore arrives as a consistent cut over the session's watched
view, with every document the frame links to delivered in the same cut. A dirty
address outside that view does not gain a watch through dirty marking alone.
Confirmed-read validation reports each stale branch, entity, and scope once. Its
first stale read supplies the diagnostic read sequence and conflicting sequence;
subsequent reads of that instance skip the staleness scan. Every read still
validates its branch and resolves its scope. An unknown branch or unresolvable
scope takes precedence over any stale reads already found. The `conflicts` array
includes an entry even when only one instance is stale. Non-default branches are
named in the descriptor; an absent `branch` means the default branch, regardless
of the commit's target branch. A client can query each conflicting branch,
entity, and scope before retrying. The runner emits default-branch reads and its
retry helper repairs those instances; cross-branch clients use the memory
protocol's branch-aware queries. Each scope resolves under the rejected session's
identity. Older responses can omit this array; their diagnostic identifies
entities but does not preserve their scopes. The runner also exposes the first
descriptor as `conflict` for existing consumers. The diagnostic previews up to
three distinct entity IDs and counts the remaining IDs. Each entity's clause
uses its first reported instance's sequences; other scopes or branches of that
entity share the clause. The structured array remains complete regardless of
the diagnostic's length.

## 3.7 Server-Side Commit Processing

When a commit passes validation, the server applies it atomically and records it
in the commit log.

### 3.7.1 Processing Steps

1. Validate all confirmed reads.
2. Resolve all pending reads within the logical session.
3. Assign the next global `seq`.
4. Append a `commit` row containing the original payload and resolution data.
5. Append one `revision` row per operation in the transaction — except an
   operation proven to change nothing (an identical re-`set` of a
   content-addressed document, or every operation of an identity commit,
   §3.6.1), which appends no revision and is reported in the verdict's
   elided operation indexes.
6. Update `head` pointers for touched entities (an elided operation touches
   nothing).
7. Materialize or refresh snapshots as needed.
8. Mark the session-local pending commit as confirmed and enqueue session sync
   for interested sessions.

All write steps happen inside a single database transaction.

### 3.7.2 Commit Log Entry

```typescript
// Shown at module scope.
type BranchLifecycleWrite =
  | {
    cmd: "/memory/branch/create";
    args: {
      localSeq: number;
      name: BranchId;
      fromBranch?: BranchId;
      atSeq?: number;
    };
  }
  | {
    cmd: "/memory/branch/delete";
    args: {
      localSeq: number;
      name: BranchId;
    };
  };

type WritePayload = ClientCommit | BranchLifecycleWrite;

interface CommitLogEntry {
  seq: number;
  branch: BranchId;
  sessionId: SessionId;
  localSeq: number;
  original: WritePayload;
  resolution: {
    seq: number;
    resolvedPendingReads?: Array<{
      localSeq: number;
      seq: number;
    }>;
  };
  invocationRef: Reference | null;
  authorizationRef: Reference | null;
}
```

The semantic JSON write path is keyed by `seq`, not by commit hash. The
content-addressed UCAN envelope is reserved for a later signed-write pass.

### 3.7.3 Seq Assignment

Seq numbers are assigned from one space-global Lamport clock. All branches share
the same seq sequence.

```text
Commit on "main":  seq 1
Commit on "main":  seq 2
Commit on "draft": seq 3
Commit on "main":  seq 4
```

All revisions produced by a single commit share the same `seq`. Revision
identity is `(branch, id, seq, opIndex)`.

### 3.7.4 Commit Identity, Signing, and Replay

Each committed write-class operation has identifiers with different roles:

- `(sessionId, localSeq)` is the optimistic identity used before acceptance and
  the idempotence key for replay
- `seq` is the canonical committed identity used after acceptance
- `invocationRef` and `authorizationRef`, when present, point at separately
  persisted signed-write metadata

On replay after reconnect:

1. the server deduplicates by `(sessionId, localSeq)`
2. it compares the replayed `original` payload with the stored `original`
3. if they match, it returns the existing commit result
4. if they differ, the replay is a protocol error

Fresh invocations or fresh authorization wrappers do not change the identity of
the underlying semantic write.

### 3.7.5 Session Identity and Reconnect

Pending-read resolution is scoped to a logical session, not to a single
WebSocket connection. The server issues a `sessionId` bound to the authenticated
client and space. The server also issues a rotating `sessionToken` that the
client must present to resume that logical session.

At most one connection may own a given logical session at a time. When a newer
connection successfully resumes a session with the current token, ownership
transfers to that connection, the old owner is revoked for that session, and
the server rotates the token. A client presenting a stale token receives
`SessionRevokedError` and must not assume it can continue replaying retained
commits on that session.

On reconnect:

1. the client resumes the logical session and reports the highest canonical
   `seenSeq` it has fully integrated, along with the latest `sessionToken` —
   and, where both peers advertise `sessionHoldings`, the documents its
   replica absorbed at their delivered seqs (04-protocol.md section 4.1.2),
   excluding local promotions and folds from the declaration
2. the client replays retained unacknowledged commits for that session
3. the server deduplicates by `(sessionId, localSeq)`
4. the client re-establishes its watch set and receives session-scoped catch-up
   sync for whatever its declared holdings lack: a resumed session's catch-up
   is diffed against the declaration, and a session the server no longer
   holds is re-established with the declaration on the watch set, so a
   reconnect never re-downloads what the client still holds and never elides
   what it lost

## 3.8 Notification Ordering Guarantee

Notifications visible to the runtime scheduler must respect causal order.

### 3.8.1 Notification Types

The client provider fires three notification types:

1. `commit` — synchronous optimistic apply inside `.commit()`
2. `revert` — rollback caused by server rejection
3. `integrate` — external or newly-confirmed server data becoming visible in
   confirmed state

### 3.8.2 Ordering Rules

- A successful local commit produces exactly one synchronous `commit`
  notification.
- A rejected local commit produces a later `revert` notification before the
  promise resolves with the conflict.
- `integrate` notifications MUST be suppressed for entity paths still shadowed
  by newer local pending state.
- If multiple pending commits overlap the same entity/path, visible
  notifications MUST reflect the visible state transitions, not hidden
  intermediate states.

### 3.8.3 A Derived Write the Space Refuses

A principal may read a space it cannot write, and a reactive computation it
runs there still writes its outputs. Those writes are derived: running the
computation again reproduces them. When the server refuses such a commit with
an `AuthorizationError` it has not marked retriable, the client keeps each
written document's new value instead of reverting it, as a _local fold_: the
confirmed value at the same `seq`, with the refused write applied, held by
that replica alone.

- A document is folded only where the refused write sits directly on the
  confirmed version it was made over. Where a newer confirmed version arrived
  underneath it, or an earlier pending write lies beneath it, the write is
  reverted as any other rejection's is.
- A frame at the same `seq` leaves a fold in place, since it carries the value
  the fold was made over. A frame at a later `seq` replaces it.
- A later write over a folded document goes to the server as a whole-document
  `set`, never as a patch, because the server holds a different value than the
  one the patch was computed against. That matters once the principal is
  granted WRITE. The commit also reads the whole document at the fold's `seq`,
  so that a change the server took to any part of it since conflicts, rather
  than being overwritten by the whole-document `set`.
- The re-run the scheduler makes after the refusal reads the folded value and
  so has nothing to write. Its computation settles instead of re-running
  against the same refusal.

Event handlers are not folded. Their writes are acts rather than derivations,
and a refusal of one is reverted and reported.

A read of a folded value can feed a later computation or event handler.
Its confirmed read names the durable base's `seq`; it does not name the
refused commit as a pending dependency or prove that the local value ever
existed on the server. This is the local-input exception to
[INV-1](09-invariants.md#inv-1--read-coherence-no-phantom-no-missed-write).
The whole-document read above guards publication of a folded write target;
it does not persist a folded document merely because another write read it.

The bounded [local-fold model](tla/README.md#model-local-folds) checks fold
eligibility, frame replacement, and subsequent whole-document publication.
Its bounds exclude composition with multiple pending layers and documents;
the pending-stack model's durable-read proof does not cover local folds.

## 3.9 Commit Ordering

Commits are ordered by canonical `seq`.

- Pending commits are ordered locally by `localSeq`.
- Confirmed commits are ordered globally by `seq`.
- The mapping from pending to confirmed order is resolved by the server when it
  accepts the commit.

## 3.10 Atomicity Guarantees

The server applies a transaction atomically:

- either every material state change lands — one revision row and head
  update per operation that changes state
- or none of them do

An identical re-`set` of a content-addressed document, and every operation of
an identity commit (§3.6.1), is a semantic no-op the engine proves before
applying: it produces no revision, no head update, and no dirty mark, while
the commit row and the space sequence still advance and the verdict names the
elided operation indexes. There is no partial visibility of a committed
transaction — a no-op is exact by proof, not a torn apply. A client that
promotes its own accepted write to the commit's seq therefore holds a basis
for the document above its per-document head; the basis is truthful, because
the proof established that the document's content at that seq is what the
client holds, and validation scans revisions above a basis rather than
comparing it to a head.

## 3.11 Branch-Aware Commits

Ordinary commits target one branch. Validation still uses:

```text
For each confirmed read:
  there MUST NOT exist a later visible overlapping write on
  (read.branch ?? commit.branch)
  with seq > read.seq
```

Merge proposals are the special case where reads explicitly name different
branches for source, target, and base observations.

## 3.12 Client Retry Strategy

When a commit is rejected with a `ConflictError`:

1. discard the rejected pending commit and any dependent stacked commits
2. wait for the repair sync: the catch-up marker covering the rejected commit
   (`caughtUpLocalSeq` reaching its `localSeq`), whose frame delivers current
   documents for the commit's write targets and read sets (§3.6.4)
3. rebuild the transaction against the repaired confirmed state
4. resubmit

Conflict retries are event-gated, not counted: every conflict raised against a
repaired read set proves a newer overlapping write, so each round makes
progress, and waiting on the repair frame bounds the loop without a retry
budget. Rejections other than `ConflictError` are terminal for the failing run
— re-running against an unchanged replica recomputes the identical refused
write. Recovery is owned by reactivity: any server-side change that could make
the operation valid overlaps state the client subscribes to, and its arrival
re-triggers the computation.

## 3.13 Mapping from Current Implementation

| v1 Concept                            | v2 Concept                                        | Notes                                                         |
| ------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `cause` (hash-based CAS)              | `reads.confirmed[].seq` + path overlap validation | The client no longer sends parent hashes for JSON commits     |
| `Changes` (nested `of/the/cause` map) | `Operation[]`                                     | Simpler flat mutation list                                    |
| `Assert { is: value }`                | `SetOperation`                                    | Same root-write semantics                                     |
| `Retract { is?: void }`               | `DeleteOperation`                                 | Same root-delete semantics                                    |
| `Claim = true`                        | `reads.confirmed` / `reads.pending`               | Read dependencies moved out of operations and now carry paths |
| Pending optimistic write handles      | `(sessionId, localSeq)`                           | Session-scoped and replay-safe                                |
| Commit identity                       | `seq`                                             | Canonical ordering and lookup key after acceptance            |
