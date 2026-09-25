# Transactions

This document specifies how reads and writes are grouped into atomic units.

## Status

Draft — based on codebase investigation. This document describes the current
implementation; no major changes are currently proposed.

---

## Current State

### Overview

Transactions provide atomicity and consistency for cell operations. All writes
to cells require a transaction context.

### Transaction Lifecycle

1. **Open**: `runtime.edit()` creates a new transaction
2. **Read**: `cell.withTx(tx).get()` reads within transaction context
3. **Write**: `cell.withTx(tx).set(value)` buffers write
4. **Commit**: `tx.commit()` attempts to persist changes
5. **Abort**: `tx.abort()` discards changes (or automatic on error)

### Settle Outcomes

A transaction settles in one of three ways: its commit succeeds, its commit is
rejected, or something aborts it. All three run the callbacks registered through
`addCommitCallback`. A rejected commit and an abort both deliver an error to
those callbacks, because both discard every write the transaction staged.

Those callbacks are the compensation hook: they undo in-memory state that only
makes sense if the transaction's writes became durable. Two rules govern one.

A callback that undoes such state checks that the state is still the state this
transaction established. Another transaction can reach the same deterministic
address and take ownership before this one settles, and its bookkeeping matches
durable writes of its own.

Not every failure calls for compensation. A stale basis — a conflict, or a local
inconsistency — is resolved by re-running the same work against fresh state, and
that re-run may depend on the very bookkeeping a compensating callback would
discard; undoing it there can stop the work converging at all.
`storage/rejection.ts` classifies the outcomes, so a callback acts only on the
ones no re-run follows.

That exception covers the bookkeeping, not the writes. Every outcome that
delivers an error discards what the transaction staged, a stale basis included,
so a record saying those writes are in place is wrong however the transaction
failed. Such a record is not state to discard but a debt to mark: the callback
says the writes are owed, and the next run issues them again against the
bookkeeping it kept. A callback that only tears state down, under the outcomes
with no re-run behind them, leaves the re-run trusting writes that never landed.
The list coordinators are the case this rule exists for — a per-element pattern
run and the links that make a result container reachable are both writes the
coordinator remembers making.

On a serving runtime, a commit succeeds when the transaction is sealed into a
wave, and its writes become durable only when the wave commits. The wave can
still withdraw a sealed transaction after that: it drops a contribution that
read a pending write the wave dropped, requeues an event, and withdraws
everything sealed into it when it is abandoned. The commit callbacks have
already run by then and never learn of it. A compensation therefore also
follows the wave's verdict on the transaction, which `waveSettlementOf()` in
`executor/wave.ts` returns, and treats a withdrawal as writes that are not all
in place. A withdrawal does not say which writes landed: a wave that drops some
of a superseded derivation's documents commits the rest, and withdraws the
transaction all the same. State that is published only once a transaction is
accepted waits for the same verdict.

External side effects belong in the post-commit outbox instead, which runs only
after a successful commit.

Work that re-runs what another transaction already carries, so the two can be
compared, wants none of this. The idempotency validator is the case that exists.
Its callbacks would compensate for state belonging to the run it duplicates,
which has already committed it, so it takes its transaction from
`createDuplicateWorkTransaction` — a wrapper that drops settle callbacks rather
than registering them, leaving nothing to take back when the transaction is
discarded.

### Read-Your-Writes

Within a transaction, reads reflect pending writes:

```typescript
// Shown for illustration only.
const tx = runtime.edit();
cell.withTx(tx).set(5);
cell.withTx(tx).get();  // returns 5, even before commit
```

This allows handlers to read back values they've written within the same
transaction.

### Conflict Detection

The system detects conflicts when the committed state changes between first
cell access and commit.

#### Behavior

- The first operation on a cell within a transaction (whether `get()` or
  `set()`) captures the current committed value as the **baseline**
- On commit, if the committed state no longer matches the baseline, the commit
  fails with `StorageTransactionInconsistent`
- Even **identical writes** trigger conflict — detection is based on baseline
  divergence, not on whether final values differ
- This is optimistic concurrency control
- **Important**: Simply opening a transaction does not capture any baselines.
  Conflict detection only applies to cells that were **accessed** (read or
  written) within the transaction. If T2 commits before T1 touches a cell, T1's
  subsequent access captures T2's committed value as the baseline, so no
  conflict occurs.

#### Examples

Conflict (both transactions access before either commits):

```
Transaction A: open, set cell (captures baseline=1)
Transaction B: open, set cell (captures baseline=1), commit  // succeeds
Transaction A: commit  // FAILS — baseline 1 ≠ committed 2
```

No conflict (T1 accesses after T2 commits):

```
Transaction A: open
Transaction B: open, set cell (2), commit  // succeeds, cell is now 2
Transaction A: set cell (3)  // captures baseline=2 (T2's committed value)
Transaction A: commit  // succeeds — baseline 2 = committed 2
```

In the conflict case, both transactions captured the original value as their
baseline. In the no-conflict case, Transaction A's first access happens after
Transaction B has committed, so A's baseline already reflects B's changes.

### Non-Traditional Transaction Semantics

This system does not implement SQL-style transaction isolation. Key differences:

- **Live references, not snapshots**: For cells with `any` type (no schema),
  `cell.get()` returns a live proxy to committed state. If another transaction
  commits while yours is open, your previously-read reference reflects their
  changes — no isolation. (This proxy behavior exists because for untyped cells,
  reading eagerly might require crawling the entire space via links. Cells with
  schemas may behave differently since the schema scopes the read.)

- **Conflict detection is baseline-based**: The first access to a cell (read
  or write) captures the committed value as a baseline. If the committed value
  changes before commit, the transaction fails. If T2 commits *before* T1
  touches the cell, T1's access captures T2's value as its baseline and commits
  successfully — no conflict.

- **Two read modes**: `cell.get()` returns committed state (live proxy);
  `cell.withTx(tx).get()` returns pending writes (read-your-writes).

- **Point-in-time requires explicit copy**: If you need snapshot semantics,
  deep-copy at read time: `JSON.parse(JSON.stringify(cell.get()))`.

### Retry Semantics

The `editWithRetry()` helper runs a callback in a transaction and can re-run it
both before commit and after a **retryable** commit rejection:

```typescript
// Shown for illustration only.
const result = await runtime.editWithRetry((tx) => {
  const current = cell.withTx(tx).get();
  cell.withTx(tx).set(current + 1);
  return current + 1;
});
```

- Before commit, while retry budget remains, may load documents the callback
  read as absent that the replica has not examined. If any exist, aborts the
  staged attempt and re-runs the entire callback with a fresh transaction,
  without sending that attempt to the server.
- On a retryable commit rejection, re-runs the entire callback with a fresh
  transaction while budget remains.
- Shares one `maxRetries` budget between those two paths, in addition to the
  initial callback invocation. With no budget left, skips reconciliation and
  submits the current transaction to ordinary commit validation; any rejection
  is returned without another retry.
- On any other commit rejection, returns the error without another retry,
  even if earlier reconciliation already re-ran the callback.
- Returns `{ ok }` when a transaction commits, carrying that invocation's
  callback result, or `{ error }` when it cannot commit.

Either retry path can repeat effects the callback performs outside its own
transaction. Aborting an attempt discards only its staged operations, so effects
committed through another channel need a stable identity or another way to make
them idempotent.

Retryability is an **allow-list**: `isRetryableCommitRejection`, defined in the
shared rejection vocabulary (`packages/runner/src/storage/rejection.ts`) and
consumed only by `editWithRetry()`. The scheduler's commit classifier
(`classifyCommitDisposition`, `packages/runner/src/scheduler/events.ts`) draws
its predicates from that same module but composes them itself, so the two
classifiers are independent and can disagree — the scheduler retries only a
stale basis (`ConflictError`, `StorageTransactionInconsistent`) and drops
everything else on the first attempt, including the liveness and abort classes
`editWithRetry()` does retry. A rejection is retried by `editWithRetry()` only
when re-running the function against fresh state can produce a different
outcome:

| Class | Why a re-run can converge |
| --- | --- |
| `ConflictError` | Stale basis from upstream. The retry first awaits the conflict's `readyToRetry` catch-up gate, then pulls every document in the scope named by the conflict list. Repeated addresses share one pull; entries without scope retain the default space-scoped pull. |
| `StorageTransactionInconsistent` | Stale basis on this replica — a value read during the transaction changed locally; re-reading resolves it. |
| `ConnectionError`, `InvalidMessageError` | Liveness failure: the commit never reached a verdict, and the memory client re-establishes the link on its own (a transport close schedules `reconnect()`; a `transact` issued while disconnected queues and calls `restoreConnection()`), so a retry can land the identical write. `InvalidMessageError` is collateral — an undecodable frame makes the client reject every in-flight request, including commits it says nothing about. |
| `StorageTransactionAborted` | The attempt was discarded before storage, and a re-run is a genuinely new attempt that costs no round-trip. Producers: the callback called `tx.abort()`; a prepared CFC transaction's inputs drifted before the verdict (`cfc-prepared-digest-mismatch`, and the `invalidateCfc` drift reasons such as `read-after-prepare`); or a CFC refusal that is not wholly a verdict (`cfc-refusal-not-a-verdict`) — prepare could not evaluate an input it needed, or a resolution failed. Those clear on a fresh attempt once the input is there. |
| `AuthorizationError` with `retriable: true` | The server itself marked this denial as one a fresh handshake heals (a session-open anti-replay race). |

Every other rejection is **terminal when encountered**: a `ProtocolError` (the
server refused the commit's shape), an unmarked `AuthorizationError` (the server
evaluated the request and denied it), a `PreconditionFailedError` (permanent by
definition — the client must not retry), a `RowLabelCommitError` (a commit-time
rule refused the data), a `CfcCommitRefusalError` (the client-side CFC boundary
evaluated the transaction's own reads and writes and refused them before
storage saw them — and did so on EVERY recorded reason. A refusal is terminal
only when every reason is a verdict; a reason is a verdict only when its
producer tags it as one (`cfc/verdict-reason.ts`), so anything untagged — an
input the transaction does not have, a failed resolution, a prepared state a
caller disturbed — stays retryable. A verdict covers the input a re-run cannot
change as well as the data policy refused: an input absent from stored state
the transaction already holds reads the same on every attempt, and its
producer leaves the run depending on the state whose arrival would decide
otherwise. It carries both channels: `reasons`, the prose one per rule
that refused, and `refusals`, the structured descriptions
(`cfc/refusal-detail.ts`) naming the boundary, the offending label atoms, and
the reads that carried them — which is what lets a consumer state a remedy
rather than only a verdict), a
`StoreError`, or the generic `TransactionError`. Those
are deterministic with respect to the committed data: a re-run recomputes the
identical refused write, and each doomed attempt costs a server round-trip plus
a revert notification to the cell's subscribers.

`SessionError` is terminal too, for a different reason — not the data, the retry
path. The server raises it when a commit is routed to a session it no longer
knows, and the argument for retrying it would be the same as for a
`ConnectionError`: the commit was never evaluated, so a re-established session
could land it. But nothing between two attempts re-establishes one. The replica
memoizes its session mount and clears it only on close; the memory client
reopens a session only from its transport-reconnect path. A transport drop
therefore never surfaces as a `SessionError` at all — the commit queues and
replays after the reconnect reopens the session. What surfaces is the other
case: a live connection whose session the server dropped (an ACL
de-authorization sweep, or a takeover), which is terminal for that session — the
client's own remedy is the `session/revoked` frame, which closes it rather than
reopening it. Retrying burns the budget within milliseconds and replaces the
real cause with a generic `TransactionError` once the revocation lands. It
belongs back in the allow-list only once the retry path remounts the session.

A rejection class introduced later is non-retryable until someone establishes
that re-running can converge and adds it to the allow-list. If a callback
*throws* rather than aborting, the transaction is aborted and the error is
returned without any retry.

The scheduler also provides automatic retry for handlers on transaction conflict.

### Relationship to Handlers

Handlers execute within transaction context:
- The transaction is provided to the handler function
- Reads and writes within the handler use this transaction
- On handler completion, the transaction commits
- On handler error, the transaction aborts

```typescript
// Shown for illustration only.
const handler = (tx, event) => {
  const current = someCell.withTx(tx).get();
  someCell.withTx(tx).set(current + 1);
  // tx commits automatically after handler returns
};
```

### Cell Methods and Transactions

The transaction layer uses a narrow subset of Cell methods:

| Method | Purpose |
|--------|---------|
| `get()` | Read current value |
| `getRaw()` | Read without schema transformation |
| `set()` | Write value |
| `setRaw()` | Write without schema transformation |
| `update()` | Partial object update |
| `push()` | Array append |
| `remove()` | Array removal |
| `key()` | Navigate to nested property |
| `withTx()` | Bind cell to transaction |
| `asSchema()` | Type cast |

These ~10 methods form the core data access API. Everything else (reactivity,
streaming) builds on top.

---

## Open Questions

- ~~How do nested/child transactions work (if at all)?~~ Not supported. For
  cases where nested semantics might be useful (e.g. a chain of events with
  rollback), branches and merging branches may be the better mechanism.
  Transactions are intended for short-lived operations.
- ~~How are transactions serialized for storage?~~ As UCAN invocations.
- ~~What consistency guarantees exist across spaces?~~ None so far.

---

**Previous:** [Cells](./4-cells.md) | **Next:** [Reactivity](./6-reactivity.md)
