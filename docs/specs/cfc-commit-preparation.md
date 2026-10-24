# CFC commit preparation

A transaction that reaches a CFC enforcement decision must have run the
boundary verification pass first. This document says where that pass runs, why
it runs there, and what the arrangement rests on.

## The step

`ExtendedStorageTransaction.commit()`
([extended-storage-transaction.ts](../../packages/runner/src/storage/extended-storage-transaction.ts))
does two things before it reaches the CFC enforcement ladder:

1. **Materialize schema documents.** Every content-addressed schema document a
   written link references is staged into the same transaction, so the
   reference and the documents it names travel together
   ([content-addressed-schemas.md](content-addressed-schemas.md)). This is a
   storage-delivery guarantee rather than a CFC decision; it runs whatever the
   enforcement dial says.
2. **Settle relevance and prepare**, which is `prepareForCommit()`:
   - **Probe flow-label relevance.** `flowLabelWorkExists`
     ([prepare.ts](../../packages/runner/src/cfc/prepare.ts)) asks whether the
     transaction observed or wrote a document carrying stored labels. A
     transaction that did is marked relevant. A write counts whatever value
     it leaves: every write the transaction recorded is an attempted write
     under spec §8.10.2.1, including one whose value returned to where it
     started and an authoritative write of an unchanged value, which the
     reactivity log's `writes` leave out. A write elided as equal to the
     current value is never recorded, so it marks nothing here. Nor does a
     write that ended where it started make the document's stored labels
     self-minted: it minted nothing.
   - **Probe the sink-request ceiling.** `gatedSinkRequestExists` asks whether
     the transaction assembled a request for a sink that declares a
     confidentiality ceiling.
   - **Prepare.** A relevant transaction that is still unprepared runs the
     verification `prepareCfc()` runs, which derives and persists its label
     map and records the reasons the boundary refused over, if any. That
     verification materializes schema documents first, so the prepared digest
     covers the staged writes wherever the prepare happened.

The two probes exist because relevance is **computed, not declared**. Reading
or writing a document that carries stored labels marks the transaction as it
happens, but not every transaction that owes CFC work is marked that way: a
value copied without its labels being consulted, and a request assembled from a
value pulled through a schema-less link, both reach the boundary unmarked. The
probes are what find those.

`Runtime.prepareTxForCommit(tx)` runs `prepareForCommit()` and nothing else.

## Why `commit()` runs it

Running the step there rules out one state: a transaction that is CFC-relevant
and unprepared when the enforcement ladder looks at it.

The ladder rejects a relevant transaction that is not prepared, and it takes
the rejection's reasons from the `invalidated` prepare state. An unprepared
transaction has none. A refusal is terminal only when every reason is a verdict
on the transaction's data, so a refusal with no reasons at all is not terminal,
and the rejection carries the retryable `StorageTransactionAborted` name.
Inside `Runtime.editWithRetry` that name spends the whole retry budget: each
attempt runs the action again, builds the same transaction, and is refused the
same way, because nothing between two attempts changes what the transaction
did.

Preparing inside `commit()` turns that outcome into the verdict it always was.
A transaction the ladder refuses has now been prepared, so its refusal
carries the reasons prepare recorded, and a refusal made of verdicts is
terminal: the action runs once.

The alternative — leaving the prepare to the caller — cannot hold the
property, because relevance can appear after a caller has prepared. Reading a
document that carries stored labels is enough: the read marks the transaction
relevant, and a caller that prepared before that read was told it was not.
Making that safe by hand means auditing every path from `prepareTxForCommit`
to `commit()` for reads and writes, at every call site.

## Why callers still prepare early

`Runtime.prepareTxForCommit(tx)` runs the same step, and callers still run it
before they commit. It is an ordering choice rather than a correctness one:

- The scheduler counts the CFC outbox as asynchronous post-commit work
  (`hasPendingPostCommitEffects`, [run.ts](../../packages/runner/src/scheduler/run.ts)),
  and prepare is what fills the outbox.
- The scheduler and the event loop build a reactivity log from the transaction
  before the commit (`txToReactivityLog`). Prepare's label-map writes belong in
  that log.

A second pass finds the transaction prepared and does nothing, so the early
run and the boundary's run cost one prepare between them.

Two transaction states take none of the step, at either call site. A
transaction that is no longer open cannot commit, and every part of the step
reaches storage through the transaction: the flow probe reads stored metadata,
and `prepareCfc` reads and writes the derived label map. A read-only
transaction is skipped so that both call sites reach the same answer about
one — `commit()` takes none of the step for a read-only transaction — and a
transaction that admits no writes has nothing to stamp in any case.

## The prepared digest and the commit-time recheck

The CFC specification's §8.10.1 (`08-10-validation-at-boundaries.md`) allows
an implementation to split an attempt into "full verification at *prepare*
time producing a canonical digest of the verified activity" and "a cheap
recheck at *commit* time that the digest still matches", on four conditions.
This runtime takes that split. What follows is how it arranges the three
conditions that concern the digest, and when the digest is computed. The
fourth, that the verification's own reads remain commit dependencies,
concerns the storage commit rather than this step.

**What the digest is derived from.** The specification asks that the digest
"be derived by the verifier itself from the canonicalized journal it
verified", label-metadata writes the verification staged included. A
successful preparation ends by taking a snapshot of the transaction's
activity from the journal as the verification left it: the reads that were
not the verifier's own, the attempted and the applied writes, the ordered
write log, and the decision inputs recorded beside them. The snapshot is
frozen at every level as it is taken, and `prepareCfc()` accepts no input, so
no caller can supply one or change the one taken. The prepared digest is
`preparedDigestFor()` of that snapshot
([canonical.ts](../../packages/runner/src/cfc/canonical.ts)): its canonical
form, hashed.

**When the digest is computed.** The digest is a function of the snapshot
alone, so its value is settled when the snapshot is taken and the transaction
computes it when something first reads it: the string `prepareCfc()` returns,
`digest` on the state `getCfcState().prepare` returns, or a recheck that has
two snapshots to compare. A transaction prepared through `prepareForCommit()`
and committed with the activity it prepared over reads none, so it
canonicalizes and hashes nothing. An invalidated preparation keeps the
snapshot it had, and its `digest` is computed the same way.

The hash is not defined for every value: it refuses one that is not a fabric
value, a `Date` or a function among them. What a snapshot record takes over
from the journal, a read's `meta` first of all, is hashed where the snapshot
is taken, once per object, so a `meta` the hash refuses throws at the end of
the preparation and the transaction does not commit, whether or not anything
reads its digest. The records the snapshot builds itself hold strings,
numbers and frozen paths. The decision inputs recorded through the
transaction's `record…` methods are typed as fabric values and deep-frozen as
they are recorded, and are not hashed again at the preparation; one that the
hash refuses all the same throws where the snapshot's digest is first read.

**The recheck.** Every journaled read, every write, and every change to a
recorded decision input advances the transaction's activity epoch, and a
snapshot is kept with the epoch it was taken at. At commit, when the epoch is
the one the preparation's snapshot was taken at, the activity being committed
is that snapshot, whose digest matches itself. When the epoch has moved, the
activity is snapshotted again, both digests are computed, and a difference
invalidates the preparation. Outside the `observe` enforcement mode it also
rejects the commit, as `StorageTransactionAborted` carrying
`cfc-prepared-digest-mismatch`, which a caller may retry in a fresh
transaction.

**Activity after the preparation.** The condition §8.10.1 places on what
follows a preparation is:

> any post-prepare activity in the transaction — any further read or write,
> including metadata — invalidates the preparation: commit MUST fail or
> re-verify from scratch

Activity invalidates the preparation where it happens, in the entry the
transaction offers for it
([extended-storage-transaction.ts](../../packages/runner/src/storage/extended-storage-transaction.ts)),
and the invalidation records which kind it was:

- a read (`read-after-prepare`);
- a write, through whichever entry makes it: a single write and each write a
  batch yields (`write-after-prepare`), a recorded SQLite statement
  (`sqlite-write-after-prepare`), and a recorded mergeable op
  (`mergeable-op-after-prepare`);
- a decision input the transaction had not recorded, such as a write-policy
  input (`write-policy-input-added`) or a dereference
  (`dereference-trace-added`).

A write invalidates whatever the storage layer goes on to do with it. The
specification counts among the attempted writes "successful write operations
whose final value is unchanged relative to prior state (no-op writes)"
(§8.10.1, and §8.10.2.1 on why), and those are the writes the storage layer
elides: a write of the value already there, and a delete that finds nothing,
reach neither the write set nor the write log. A recorded SQLite statement
and a mergeable op commit with the transaction and are held beside the
journal rather than in it. The op replaces the diff of the value it covers,
so one recorded after the preparation can change what is stored. None of
these reaches the digest's input, so a comparison of digests at commit cannot
tell that any of them happened, and the invalidation at the write is what
refuses them. An empty batch yields no write and leaves the preparation
standing.

`commit()` does not prepare an invalidated transaction again. In an enforcing
mode the ladder refuses it as relevant and not prepared. An invalidation is
not a verdict on the transaction's data, and `invalidateCfc()` records its
reason without a verdict tag whoever supplied it, so the rejection carries the
retryable `StorageTransactionAborted` name that §8.10.1 asks of a failure
after preparation. It reports the denial `write-prepare-invalidated`
([cfc-denial-reporting.md](../features/cfc-denial-reporting.md)). The
verification from scratch happens in the fresh transaction a retrying caller
opens.

Activity that advances the epoch without invalidating reaches the recheck
instead, which decides by digest alone. A decision input recorded a second
time with the content it had, such as a dereference the transaction had
already performed, is one case: the digest binds the set of those, so it is
unchanged and the commit is accepted. The policy snapshot and the module
delegations are another. The `Runtime` sets each once, when it creates a
transaction, so only a transaction no `Runtime` created can have one set
after its preparation. That first setting changes the digest and is refused
there.

Computing the digest on first read changes when the hash runs, and neither
what it is nor which commits the recheck accepts.
`packages/runner/test/storage/prepared-digest.test.ts` pins both halves: a
commit whose activity stands hashes nothing, and one whose activity moved
hashes both snapshots, and is refused where they differ.

## Cooperative preparation for asynchronous completions

`Runtime.editWithRetry` accepts an optional owner `AbortSignal`. With one, it
awaits `prepareForCommitCooperatively` before committing. The synchronous and
cooperative entry points run the same boundary checks; the cooperative driver
uses `CooperativeYield` between target documents and within staged-reference
label derivation, including derivation for integrity floors, so cancellation
can reach the event loop. The reference walk suspends between recursive calls
and label-map construction phases. Cancellation aborts the uncommitted
transaction and ends retries. No target is omitted from a successful
preparation.

The privileged write scope covers each synchronous verification step and ends
before a yield. If the transaction's activity epoch changes during that yield,
the attempt aborts rather than sealing candidates collected before the change.
The caller must await preparation before committing. Initial collections,
individual flat label-map operations, other verification, and final ceiling,
grant, and activity-snapshot work remain synchronous. Suspension points do not impose a
transaction-size limit or a hard bound on event-loop latency.

`sqliteQuery` supplies its builtin lifetime signal to completion and error
writebacks. Stopping the builtin cancels preparation; a later activation can
reissue its stored pending query. This does not cancel the shared runtime or an
already submitted storage commit. Callers without an owner signal retain
synchronous preparation, including scheduler fan-out, whose instance ordering
does not permit an intervening macrotask.

## Read-only renderer subscriptions

The worker VDOM reconciler subscribes through the internal `readOnly` option
on `Cell.sink`. Each subscription retains its own reactive read journal, and
reads through child cells in the callback use a separate read-only transaction.
The option applies on initial delivery and scheduler reruns; `sinkMeta` applies
it to its metadata-read transaction. Stream listeners create no subscription
transaction.

These subscriptions admit no writes through their delivered cells, so their
commits take the read-only path above. Generic subscriptions retain writable
callback child cells. Rendering still evaluates confidentiality and integrity
at the display boundary, and label metadata reads remain reactive dependencies;
read-only transaction mode grants no additional render authority. Event handlers
and bindings resolve their writable cells independently of the subscription
transaction.

## What materializing schema documents cannot do

Materialization is the one thing the boundary does that an earlier
`prepareTxForCommit` does not, so it is the one thing that could make the two
probes answer differently. It runs before the probes, and it is a write, so it
moves the transaction's activity epoch and discards the memoized negative
verdict `probeFlowLabelWork` keeps: the boundary's probe really does
re-evaluate rather than reading the earlier answer back. What it cannot do is
reach a different one.

Materialization stages content-addressed schema documents and nothing else:
every write it makes lands on an id beginning with `cid:`. The flow derivation
consults no `cid:` document on any of its three channels:

- a write target whose id begins with `cid:` is skipped by `valueWriteTargets`;
- a read of one is skipped by `forEachFlowObservation`;
- a trigger read naming one is skipped by `forEachFlowObservation`, on top of
  the same filter applied when trigger reads are recorded;
- a link written into a labeled document that names a `cid:` source records
  no link-write policy input (`recordLinkWritePolicyInput`), so the link-label
  derivation never asks a `cid:` document for metadata it cannot carry. The
  compile cache's records link their code this way, to
  [code documents](content-addressed-schemas.md#code-documents) staged
  through the same privileged blind write as a schema document.

That exclusion is deliberate. A `cid:` document sits on an unverified write
path that any principal who can write to the space can reach, so a label map
stored on one is attacker-controlled, and joining it into a flow derivation
would let that principal choose another transaction's labels.

Two changes would make the probes able to disagree again: materialization
staging a document under an id the flow derivation does consult, or the `cid:`
exclusion narrowing to something less than "every channel". Either one makes
the probe's answer depend on whether materialization has run, so an early
prepare and the boundary can reach different verdicts. The cost of that is no
longer a doomed retry loop, because the boundary prepares. It is that a
transaction prepares later than the caller that prepared it expects, and the
label-map writes prepare makes are missing from a reactivity log built before
the commit.

## Where this is pinned

- [cfc/preparation-cancellation.test.ts](../../packages/runner/test/cfc/preparation-cancellation.test.ts)
  — cancellation during preparation, label and refusal parity, and changes to
  the transaction during a yield.
- [sqlite-query-cancellation.test.ts](../../packages/runner/test/sqlite-query-cancellation.test.ts)
  — stopping a piece discards its query writeback; restarting reissues the
  pending query.
- [cfc-commit-preparation.test.ts](../../packages/runner/test/cfc-commit-preparation.test.ts)
  — a transaction that turns relevant after the caller prepared it still
  commits prepared; an `editWithRetry` action runs once for a CFC verdict on a
  transaction nothing prepared; a read-only transaction is left unprepared
  where a writable one is prepared; a child-cell wrapper prepares the
  transaction it wraps; materialization stages `cid:` ids alone; a labeled
  `cid:` document leaves a transaction unprepared; a write returned to its
  starting value, and an authoritative write of an unchanged value, each make
  a labeled target relevant; a reverted path's derived label is replaced
  whether or not another document in its space changed.
- [storage/prepared-digest.test.ts](../../packages/runner/test/storage/prepared-digest.test.ts)
  — what the prepared digest binds; a write after a preparation invalidates
  it and fails the commit through each write entry, including a batched
  write the storage layer elides, a recorded SQLite statement, and a recorded
  mergeable op; an empty batch leaves the preparation standing; module
  delegations set after a preparation fail the commit on the digest
  comparison.
- [runtime-prepare-tx-for-commit.test.ts](../../packages/runner/test/runtime-prepare-tx-for-commit.test.ts)
  — the settled-transaction and aborted-transaction cases.
- [cfc-flow-probe-memo.test.ts](../../packages/runner/test/cfc-flow-probe-memo.test.ts)
  — one probe evaluation per transaction activity epoch.
- [edit-with-retry-classification.test.ts](../../packages/runner/test/edit-with-retry-classification.test.ts)
  — which commit rejections `editWithRetry` retries, and which end the
  sequence after one attempt.
