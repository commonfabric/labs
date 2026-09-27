# 07 — Collaborative Operations, Views, and Anchors

This section specifies first-class operation-based collaborative fields in
Memory v2. CodeMirror text collaboration is the first integration. The storage
and protocol contract is editor-neutral so a future rich-text codec can reuse
the same field identity, commit, cursor, receipt, query, subscription, and
checkpoint machinery.

The experimental CodeMirror vertical slice implements the codec, commit,
query/watch, checkpoint retention, runner, runtime-client, editor, default-
branch policy, reconnect, and operator-inspection paths described here. The
structured-codec readiness proof and range-oriented CFC review remain tracked
in [`../../plans/memory-apply-op.md`](../../plans/memory-apply-op.md).

Materialized entity reads remain the default Memory interface. Collaborative
fields add an operation-aware write class and two explicit history projections;
they do not turn every Cell read into an operation-log read.

---

## 7.1 Goals

- Make Memory the sole authority that orders, validates, integrates, and
  materializes collaborative operations.
- Preserve the submitted operation payload accepted from the client.
- Expose a canonical integrated operation stream with resumable field-local
  cursors.
- Update the integrated history and ordinary materialized entity value in one
  SQLite transaction.
- Keep non-collaborative readers and reactive computations on ordinary entity
  snapshots.
- Support multiple trusted, versioned editor codecs without embedding one
  editor's operation types in the Memory wire protocol.
- Provide stable operation identifiers that future anchored annotations and
  range-level provenance can reference.

## 7.2 Non-Goals

- Presence, collaborator lists, selections, and cursors are ephemeral product
  concerns and are not part of durable `apply-op` history.
- Clients cannot upload executable codecs or choose untrusted transform logic.
- The first CodeMirror slice does not implement branch merging, range-level CFC
  labels, or anchored annotation mutation.
- Graph traversal remains materialized-only. Operation projections address one
  field directly.
- There is no universal operation intermediate representation. Each codec owns
  its submitted and integrated JSON payload formats.

---

## 7.3 Terms and Identities

A **collaborative field** is one value-relative path in an entity bound to one
server-registered codec for the lifetime of a field epoch.

Its durable address is:

```text
(branch, entity id, resolved scope key, path)
```

`path` uses Memory's `ValuePath` vocabulary and is relative to
`EntityDocument.value`. It does not include the stored `value` segment. The
engine adds that segment when it derives the ordinary materialization patch.

A field has three additional identities:

- **epoch** — a server-assigned generation. Releasing and later reopening the
  same address creates a new epoch.
- **version** — the number of canonical logical operations integrated in the
  epoch. Versions start at zero and increase by one per stored integrated op.
- **op id** — a stable identifier derived from field address, epoch, and
  version. It identifies one integrated op independently of the commit that
  carried its submitted batch.

An operation cursor is `{ epoch, version }`. A bare version is never sufficient
across field release, entity deletion, branch fork, or history reset.

## 7.4 Three Projections

### 7.4.1 Submitted projection

The submitted projection is the codec payload exactly as accepted from the
client, together with its submission id, base cursor, commit sequence, and
operation index.

- It records author intent and protocol provenance.
- It is ordered by canonical commit order.
- It is not assumed to be replayable against the latest document.
- It joins to invocation and authorization records when a commit carries them.
  The current session-authenticated transport does not imply that every commit
  payload is independently signed.

### 7.4.2 Integrated projection

The integrated projection is the canonical operation stream produced by the
server codec after validation, transformation, and normalization.

- It is replayable from its epoch baseline or a compatible checkpoint.
- It is the source consumed by collaborative editor sessions.
- It may differ from the submitted payload without changing that submitted
  record.
- Its prefix is immutable. A cursor that was once valid never names a different
  operation later.

### 7.4.3 Materialized projection

The materialized projection is the ordinary field value produced by applying
the integrated operations.

Every accepted `apply-op` that produces canonical logical operations also
produces an ordinary patch revision for the owning entity in the same
transaction as the submitted and integrated rows. A canonically empty batch
leaves the materialized value unchanged. Existing `graph.query`, watch-set
sync, point-in-time reads, conflict detection, and reactivity therefore
continue to consume normal entity state.

The three projections are different views of one accepted commit. A client
cannot author the integrated or materialized projection independently.

---

## 7.5 Trusted Codec Registry

Memory servers use a process-configured registry of versioned codecs. Codec ids
are stable wire identifiers such as `codemirror-changeset@1`. Changing payload
validation or integration semantics requires a new id.

Conceptually, a codec supplies:

```text
validate materialized value
validate and decode submitted payload
decode stored integrated payload
rebase submitted operations over an integrated suffix
apply canonical operations to the materialized value
encode canonical operations and the new materialized value
```

Codec execution is part of the trusted commit engine and must be:

- deterministic for the same encoded inputs
- synchronous and free of network, filesystem, clock, and randomness access
- bounded by payload, operation-count, and materialized-value limits
- able to reject malformed payloads without partially mutating storage

The Memory protocol carries only codec ids and JSON payloads. It does not carry
JavaScript modules, package URLs, or client-computed integrated operations.

The server advertises `applyOp` support and its configured codec ids during the
Memory handshake. A client must fail clearly when its codec is unavailable; it
must not fall back to whole-value collaborative writes.

### 7.5.1 CodeMirror codec

The first codec uses CodeMirror `ChangeSet` JSON and the central-authority
rebasing semantics from `@codemirror/collab`.

- The materialized value is a string.
- A submitted payload is an ordered batch of
  `{ clientId, changes, dedupeId? }` records. `dedupeId` marks a deterministic
  editor-generated rewrite as idempotent across the operations integrated
  after its base; ordinary user edits omit it.
- Selection/effect data is not accepted as durable content in the first codec.
- The server rebases the batch over integrated changes after the submitted base
  cursor and applies the rebased changes to the current string.
- A matching `dedupeId` in that intervening suffix suppresses only the repeated
  rewrite. Ordinary edits before or after it remain in order and are remapped
  across the suppressed change.
- Empty canonical changes may be omitted; only stored integrated operations
  advance the field version.

A future rich-text codec may use a JSON document and editor-native steps or
transactions. It must satisfy the same deterministic contract and cursor
invariants; no Memory protocol change is required.

---

## 7.6 Field Activation and Lifecycle

The first successful `apply-op` at an inactive address atomically activates a
new field epoch. That request carries a null cursor and a hash of the baseline
value the client observed. Memory:

1. reads the current materialized value at the field path
2. verifies the baseline hash
3. validates the value with the named codec
4. creates the next epoch at version zero
5. integrates the submitted batch in the same transaction

This makes activation an explicit compare-and-apply operation without adding a
separate declaration race. If the value changed after the client opened the
editor, activation fails with the current field projection and the client must
reinitialize or deliberately reconcile.

Multiple clients may race to activate the same inactive field. After the first
request activates the epoch, another null-cursor request with the same codec and
baseline hash is interpreted as version zero of that epoch and rebased over the
operations already accepted there. A different codec or baseline is rejected.

Within an active epoch:

- the codec id is immutable
- `apply-op` may use an older version in the same epoch and is rebased over the
  intervening integrated suffix
- a future version or different epoch is rejected
- a submission id is unique within the epoch

An explicit `release-op-field` operation deactivates the field without changing
its materialized value. A later `apply-op` starts a new epoch from the then
current value. Deleting the owning entity releases all its active collaborative
fields in the same transaction.

Ordinary `set` or `patch` operations may coexist with collaborative fields only
when their resulting value preserves every active field they overlap. A write
that would change an active collaborative field is rejected unless an earlier
operation in the same commit released that field. This prevents a whole-value
writer from silently creating history that collaborative clients cannot replay.

---

## 7.7 Write Operations

`apply-op` and `release-op-field` are top-level Memory operations, not
`PatchOp` variants. `PatchOp` describes a deterministic materialized JSON
mutation; `apply-op` preserves one submitted representation while the server
derives a different integrated representation and a materialized patch.

The wire shapes are:

```text
ApplyOpOperation {
  op: "apply-op"
  id: EntityId
  scope?: CellScope
  path: ValuePath
  codec: OpCodecId
  submissionId: string
  base: OpCursor | null
  baselineHash?: string       // required exactly when base is null
  payload: JSONValue          // codec-defined submitted batch
}

ReleaseOpFieldOperation {
  op: "release-op-field"
  id: EntityId
  scope?: CellScope
  path: ValuePath
  codec: OpCodecId
  cursor: OpCursor
}
```

### 7.7.1 Apply semantics

For an active field, the engine performs the following inside
`applyCommit`'s immediate SQLite transaction:

1. Resolve branch, scope key, entity, and field path.
2. Load and validate the active field epoch and codec.
3. Check durable submission-id idempotency.
4. Reject a future version; load integrated ops after a stale base version.
5. Ask the codec to validate and rebase the submitted batch.
6. Apply the canonical operations to the current materialized field value.
7. Insert the submitted record and canonical integrated rows.
8. If the canonical batch is non-empty, insert an ordinary patch revision
   replacing the field value.
9. Advance the field cursor by the number of canonical operations and store the
   operation resolution. A canonically empty batch does neither.
10. Commit all rows or none.

Multiple operations in one commit are processed in operation-index order. A
later operation observes the earlier operation's result. Applying operations to
different field paths remains atomic with the rest of the commit.

`apply-op` does not carry an ordinary confirmed read of the field. Its base
cursor is the field-specific concurrency precondition, and stale bases are
mergeable through the codec. Other reads in the commit retain normal Memory
conflict semantics.

### 7.7.2 Submission idempotency

`submissionId` is durable across session replacement and reconnect:

- repeating an identical submission in the same field epoch returns its
  original resolution without integrating it again
- reusing the id with a different codec, base, or payload is a protocol error
- normal `(sessionId, localSeq)` replay remains the idempotency boundary for the
  complete commit

### 7.7.3 Resolution and receipt

`AppliedCommit` contains one resolution per `apply-op` operation:

```text
ApplyOpResolution {
  operationIndex: number
  address: {
    branch: BranchName
    id: EntityId
    scope?: CellScope
    scopeKey: string
    path: ValuePath
  }
  codec: OpCodecId
  submissionId: string
  from: OpCursor
  to: OpCursor
  operations: Array<{
    opId: string
    cursor: OpCursor
    submissionId: string
    payload: JSONValue
  }>
  duplicate: boolean
}
```

The response includes the canonical operations so the submitting editor can
confirm or rebase its pending state without waiting for watch fan-out. The same
operations may later arrive through a subscription and are deduplicated by
cursor.

Commit replay reconstructs these resolutions from stored commit resolution
data. It never reruns a codec against newer state.

---

## 7.8 Storage Model

Collaborative metadata is stored beside, not inside, ordinary entity JSON.
The initial schema has four logical tables:

### `op_field_epoch`

One current-state row per field address:

```text
(branch, id, scope_key, path_key) primary key
epoch
codec
version
baseline_hash
materialized
active
commit_seq
```

Releasing a field keeps this row and marks it inactive; reopening replaces its
current-state fields with the next epoch. Per-epoch history remains in the
submission, integrated, and checkpoint tables. `path_key` is the canonical JSON
Pointer encoding of the value-relative path.

### `op_submission`

One row per accepted submitted batch:

```text
(branch, id, scope_key, path_key, epoch, submission_id) primary key
base_version
submitted_payload
integrated_from
integrated_to
integrated_payload
commit_seq
operation_index
```

The encoded payload is retained directly for efficient submitted-view queries.
The row also joins to the canonical `commit` record, whose `original` field
preserves the complete accepted request.

### `op_integrated`

One row per canonical logical operation:

```text
(branch, id, scope_key, path_key, epoch, version) primary key
op_id unique
submission_id
payload
commit_seq
```

Versions are contiguous. The engine must verify `current_version` equals the
largest stored version before advancing it.

### `op_checkpoint`

Replay checkpoints:

```text
(branch, id, scope_key, path_key, epoch, version) primary key
materialized
commit_seq
```

The engine writes a version-zero checkpoint when an epoch is activated and
creates later checkpoints whenever the configured operation-count interval is
crossed. Creating checkpoint N prunes integrated replay rows only through the
previous nonzero checkpoint. This one-checkpoint lag keeps the recent suffix
available to connected editors while bounding transform and query work.
Submitted rows remain available for duplicate detection and audit.

The materialized entity revision remains the authority for ordinary reads.
`op_checkpoint.materialized` exists for operation replay and compaction and
must equal the field value at its cursor.

---

## 7.9 Query and Subscription Protocol

Operation views use direct-field queries. `graph.query` remains
materialized-only so one traversal never mixes values, operation logs, and
field-local cursors.

An `op.query` request identifies a field and an optional `after` cursor. The
integrated projection is exposed through one `OperationFieldSnapshot` envelope
containing the current materialized value, baseline hash, current cursor, and
the integrated suffix after the supplied cursor. Submitted-history queries are
deferred to operator tooling.

An inactive-field response contains a null cursor, the current materialized
value, its baseline hash, and no operations. It gives a client exactly the
inputs required for race-free first activation. An active response includes the
codec id, current non-null cursor, and a `retainedFrom` cursor. A missing,
wrong-epoch, or older-than-retained cursor produces `reset: true`, the current
canonical materialized value, and no integrated operations. A cursor at or
after `retainedFrom` receives the complete contiguous suffix through the
response cursor.

Live operation delivery extends the existing session watch set with an
`operation` watch kind. The initial `session.watch.add` response atomically
installs the watch and returns an `OperationFieldSnapshot`. Later `SessionSync`
frames carry operation-field effects alongside ordinary entity upserts.

The ordering rules are:

- the transact verdict is sent before watch fan-out for the same commit
- every operation effect names its field cursor; its enclosing `SessionSync`
  names the covered commit-sequence interval
- a client applies each cursor at most once
- reconnect reinstalls the operation watch and filters the immutable suffix by
  cursor
- clients behind the retained floor reset from the canonical materialized
  snapshot; writes behind that floor fail with `OpHistoryUnavailableError`

An operation watch may be installed while the field is inactive. Ordinary
writes then produce a newer inactive field response, activation produces an
active response, and release or entity deletion produces an inactive response.
This closes the race between reading a baseline and the first `apply-op` without
turning ordinary entity sync into inferred operation history.

An editor should initialize from one field response, track unconfirmed local
edits in its codec implementation, and consume canonical suffixes thereafter.
It should not infer operation history from ordinary entity sync frames.

The runtime-client assigns an ephemeral operation-session id to each editor
open. The worker resolves the supplied `CellHandle` to its canonical target
once for that id and uses the pinned `(space, id, scope, path)` for capability,
query, apply, subscribe, and release requests. Another operation session for
the same source handle resolves independently, so retargeting an alias cannot
move an existing editor or trap a later editor on the earlier target. Close and
abandon messages discard the pin even when opening ended before a watch was
installed. These ids are transport-lifecycle identities, not Memory session
ids or durable field identities.

An editor-generated idempotent rewrite first confirms its earlier ordinary
local updates. The rewrite is then the first unconfirmed update, allowing a
canonical copy from another client to acknowledge rather than duplicate it.
Programmatic rewrites wait for an in-progress close or release transition and
resume only against the resulting authority.

If a mismatched-epoch response arrives while an editor has unconfirmed local
operations, the client must preserve those local contents and surface an
explicit reconciliation state.
It must not silently discard them or apply them to a different epoch. A normal
disconnect within the same epoch retains the original submission ids and
resends through the Memory session's outstanding-commit mechanism.

---

## 7.10 Ordinary Reads, Reactivity, and Conflicts

The internal consequence of an accepted `apply-op` is an ordinary `patch`
revision at the field path. Consequently:

- current and point-in-time entity reads require no collaborative special case
- entity snapshots continue to bound materialized replay
- graph-query and watch-set consumers receive ordinary documents
- confirmed reads overlapping the field conflict exactly as they do for an
  equivalent patch
- scheduler dirty-path computation uses the derived materialization patch

The committing runtime cannot extrapolate a server-rebased result from its
submitted payload. Server dirty-origin handling therefore treats `apply-op`
like a `patch` that names no base (`03-commit-model.md` section 3.1): the
writer receives the authoritative materialized document in the covering
session sync rather than suppressing its own echo as a plain `set`.

Operation watches and materialized watches may both cover the same field. Their
payloads serve different consumers, but their commit-sequence ordering must not
contradict each other.

---

## 7.11 Branches

Field addresses and every collaborative storage key include a branch. The
editor and runtime-client integration operates on the default branch. Memory
rejects collaborative queries, applies, and releases on child branches. There
is no Memory branch-merge operation; operation-aware child inheritance and
collaborative merge semantics remain deferred. Parent cursors are never
accepted as child cursors.

---

## 7.12 Checkpoints and Retention

The correctness model does not depend on a complete epoch log. Memory creates
storage-owned checkpoints at deterministic committed cursors. Automatic
compaction retains one checkpoint of overlap. Explicit maintenance may prune
through the latest checkpoint only after replaying every later integrated
operation through the registered codec and verifying that the result equals
both the field head and the ordinary materialized value.

The lowest remaining contiguous cursor is the epoch's retained-version floor.
Readers behind it receive a reset snapshot; writers behind it receive
`OpHistoryUnavailableError`. Submitted records are not pruned with integrated
replay rows, preserving durable idempotency and the audit projection.

Checkpoint creation is storage-owned. Clients cannot submit a materialized
checkpoint or claim that it corresponds to an operation cursor.

---

## 7.13 Security and Resource Limits

- Normal Memory WRITE authorization applies to `apply-op` and
  `release-op-field`; READ authorization applies to operation queries and
  watches.
- The server validates scope exactly as for entity operations.
- Clients cannot submit integrated operations, checkpoints, label side-data, or
  operation ids.
- Codec ids must be registered locally and version-pinned.
- The engine bounds submitted bytes, operations per batch, and materialized
  document size before accepting a commit.
- The server imposes protocol-wide limits before invoking codec-specific
  parsing.
- Errors disclose no field content beyond what the authenticated session may
  read.

Checkpoint-lag compaction bounds the transform suffix and integrated query
suffix. The protocol uses typed `OpHistoryUnavailableError` responses for stale
writes and snapshot resets for stale readers, so the server performs no
unbounded collaborative-history work inside the per-space commit lock.

---

## 7.14 Storage-Derived Labels

Range-oriented CFC labels are a future derived projection over integrated
history. They remain storage-owned side-data associated with a materialized
checkpoint.

- Clients may render labels but cannot author them through `apply-op`.
- Codec integration may report affected ranges to a trusted label mapper, but
  those reports are not authoritative by themselves.
- The authoritative label computation and validation occur inside the same
  transaction or deterministic checkpoint derivation.
- Unlabeled collaborative fields pay no range-label storage cost.

The first CodeMirror implementation does not define or store range-label
side-data. A future checkpoint schema extension may add it with the required
label validation contract.

## 7.15 User-Level Anchored Annotations

Comments, instructions, bookmarks, and highlights remain ordinary application
entities. Their anchors reference a collaborative field address, epoch, and
codec-defined position or range.

The codec may later provide deterministic anchor mapping through integrated
operations. Annotation payloads do not enter the system-owned label plane, and
annotation writes remain normal Memory transactions.

Stable integrated operation ids and epochs are part of this first design so
adding anchor mapping does not require replacing the collaboration history
identity model.

---

## 7.16 Normative Invariants

1. **One authority:** only the Memory commit engine produces canonical
   integrated operations.
2. **Atomic projections:** submitted rows, integrated rows, cursor advancement,
   operation resolution, and materialized revision commit together or not at
   all.
3. **Immutable prefix:** an integrated cursor never changes meaning.
4. **Replayable resolution:** replaying `(sessionId, localSeq)` returns the
   original operation resolution without codec execution.
5. **Durable submission idempotency:** one submission id cannot integrate twice
   in one field epoch.
6. **Materialized compatibility:** an ordinary entity read after the commit
   returns the codec-produced value.
7. **No hidden reset:** ordinary writes cannot alter an active collaborative
   field without releasing it or deleting its entity.
8. **Codec agreement:** field epoch, submitted rows, integrated rows, queries,
   and receipts always name the same versioned codec id.
9. **Cursor completeness:** an active incremental response contains every
   integrated operation after a matching retained input cursor through its
   output cursor; an epoch mismatch or unavailable cursor returns an explicit
   canonical reset snapshot.
10. **No client authority over derived data:** clients never supply canonical
    op ids, integrated payloads, checkpoints, or storage-owned label side-data.

## 7.17 Deferred Decisions

- The representation and algebra for range-level CFC side-data.
- Codec-specific anchor formats and annotation mapping APIs.
- Collaborative branch merge semantics.
- Retention durations for submitted audit payloads.
- Whether mature deployments move codec execution into a more isolated
  deterministic host while preserving the same registry contract.

These decisions do not change the submitted/integrated/materialized projection
split, field cursor, or atomic `apply-op` commit contract.
