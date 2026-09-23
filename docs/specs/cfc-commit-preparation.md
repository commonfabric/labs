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
     transaction that did is marked relevant.
   - **Probe the sink-request ceiling.** `gatedSinkRequestExists` asks whether
     the transaction assembled a request for a sink that declares a
     confidentiality ceiling.
   - **Prepare.** A relevant transaction that is still unprepared runs
     `prepareCfc()`, which derives and persists its label map and records the
     reasons the boundary refused over, if any. `prepareCfc()` materializes
     schema documents first, so the prepared digest covers the staged writes
     wherever the prepare happened.

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
A transaction the ladder refuses has now run `prepareCfc()`, so its refusal
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

## Cooperative preparation for asynchronous completions

`Runtime.editWithRetry` accepts an optional owner `AbortSignal`. With one, it
awaits `prepareForCommitCooperatively` before committing. The synchronous and
cooperative entry points run the same boundary checks; the cooperative driver
uses `CooperativeYield` between target documents so cancellation can reach the
event loop. Cancellation aborts the uncommitted transaction and ends retries.
No target is omitted from a successful preparation.

The privileged write scope covers each synchronous verification step and ends
before a yield. If the transaction's activity epoch changes during that yield,
the attempt aborts rather than sealing candidates collected before the change.
The caller must await preparation before committing. Initial collections, each
target's verification, and final ceiling, grant, and digest work remain
synchronous.

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
- a read of one is skipped by `flowReadExcluded`;
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
  `cid:` document leaves a transaction unprepared.
- [runtime-prepare-tx-for-commit.test.ts](../../packages/runner/test/runtime-prepare-tx-for-commit.test.ts)
  — the settled-transaction and aborted-transaction cases.
- [cfc-flow-probe-memo.test.ts](../../packages/runner/test/cfc-flow-probe-memo.test.ts)
  — one probe evaluation per transaction activity epoch.
- [edit-with-retry-classification.test.ts](../../packages/runner/test/edit-with-retry-classification.test.ts)
  — which commit rejections `editWithRetry` retries, and which end the
  sequence after one attempt.
