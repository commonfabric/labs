# Committed-write backpressure

How the scheduler keeps a committed write from being silently dropped when the
server rejects it under contention.

## The problem

The runtime is local-first and optimistic. When an event handler writes, the
write is applied to local replicated memory immediately and the transaction is
committed to the server in the background. The handler does not wait for the
server. The server can still reject the commit, most often with a per-entity
basis-sequence conflict: another writer advanced the entity's sequence between
the time this commit read its basis and the time it reached the server. On
rejection the optimistic write is rolled back (a "revert") and the originating
event is re-run.

The re-run used to have a fixed budget. An event handler retried five times and
then gave up: it logged "Event handler transaction failed after exhausting all
retries" and dropped the write. Nothing surfaced to the user.

Under sustained contention that budget is exhausted before the contention
clears. The concrete case that motivated this work: profile appends issued while
the home space rehydrates. Loading a home that already has profiles produces a
burst of basis-sequence conflicts as reactive rehydration commits churn the home
entity. A profile append targeting the same entity loses the race over and over,
runs out of its five retries in a few milliseconds, and is dropped. Creating
three profiles left a durable count of one. "Drops data under load" is a
correctness cliff, not graceful degradation.

## The principle

A committed write that represents real user intent must converge or fail loudly.
It must never vanish. Under contention the system should get slower, not lossy.

The split is by whether a re-run against fresher confirmed state could make the
commit succeed — that is, whether the rejection is a **stale basis**:

- **Retry through the window — a stale basis.** Two rejections mean the confirmed
  timeline moved under the commit, so re-reading it fresh can resolve it: a
  server-side `ConflictError` (another writer advanced the entity's sequence) and
  the local `StorageTransactionInconsistent` guard (a value the transaction read
  changed on this replica between the read and the commit). These are exactly what
  a contention burst — a space rehydrating while a handler writes to it — produces.
  Re-running the handler against fresh confirmed state and committing again can
  succeed, so the write backs off and retries until it lands.
- **Fail fast — everything else.** A **permanent precondition failure**
  (`PreconditionFailedError` — `receipt-exists`, `origin-committed`) can never
  succeed and must not re-run: `receipt-exists` means the event was already
  durably handled by a prior delivery (idempotent dedup); `origin-committed` means
  the event's origin lineage did not commit, so the descendant must not apply.
  Every **other non-permanent rejection** — an authorization denial, a malformed
  store operation, a transport error, a handler `tx.abort()` — is not a stale
  basis: re-running hits the same rule and gets the same refusal. Retrying it
  would burn the whole window arriving at the same answer, and for an
  authorization denial that means retrying a security denial. So it drops on the
  first attempt.

The old code had two problems this fixes. It retried a fixed five times and then
dropped, so a stale-basis rejection that was not typed as `ConflictError` — a
`StorageTransactionInconsistent` from the rehydration storm — ran out of its five
attempts in a few milliseconds and vanished (a silent-loss cliff). And it gave
*only* `ConflictError` the window. Now both stale-basis rejections are windowed
(the `StorageTransactionInconsistent` one unconditionally — generalizing an
interim version that windowed it only on a commit carrying a mergeable op), and
there is no fixed count anywhere: a stale basis is bounded by the retry window, a
non-stale-basis rejection drops immediately.

## The model

The event-handler commit path classifies each commit result and acts on it
(`packages/runner/src/scheduler/events.ts`, `classifyCommitDisposition`):

- **Success** — done.
- **A stale-basis rejection** (`ConflictError` or `StorageTransactionInconsistent`)
  — the backpressure path. The event is re-queued parked via the
  existing `notBefore` mechanism with a single capped exponential backoff plus
  jitter (`scheduler/backpressure.ts`, `computeBackoffDelayMs`). The curve is
  deliberately near-immediate at the start: the default `baseDelayMs` is 25/32 ms,
  so the first few delays are 0.78, 1.56, 3.125 ms — effectively immediate. A
  stale-basis conflict usually clears the instant the fresh confirmed state
  arrives, and these sub-5ms delays let it converge within a settle (the harness
  and the UI settle by waiting for the event queue to drain, so a retry that would
  have cleared immediately must not be spaced out). The delay only grows into real
  spacing once the failure persists: it reaches 25ms before the seventh attempt
  and doubles to a 1-second cap. Backoff makes the scheduler slow down under
  sustained contention instead of busy-looping; jitter keeps concurrent writers
  contending for the same entity from retrying in lockstep. The event keeps
  retrying for a bounded window (default 30 seconds), measured from the first
  failure, which is long enough to outlast a rehydration burst. `idle()` and
  `settled()` already wait for a parked head event, so a write that converges
  still completes within a settle.

  The re-run needs the fresh state it is re-running against, so the requeued
  event holds its slot until that state arrives: the replica's catch-up to
  the conflict point (the rejection's `readyToRetry` gate, which the wire
  attaches to a `ConflictError`) and a pull of the document the conflict
  names (`Runtime.awaitCommitRetryReadiness`, the readiness `editWithRetry`
  and the reactive path await before their own re-runs). The event re-enters
  the queue at once, in send order, marked `retryReadinessPending`; dispatch
  passes over it and `idle()` stays open as for any parked head, so a later
  event cannot overtake the retry, and a cascade victim whose own readiness
  resolves sooner queues up behind it. The backoff step is the pacing floor
  under that wait: the step's `notBefore` is fixed when the rejection is
  classified, so a readiness that outlasts the delay dispatches the re-run as
  soon as it resolves, and one that resolves sooner leaves the event parked
  until the step elapses. The retry window is unaffected either way, since
  the deadline rides the requeued event. The wait is also part of the
  commit's tracked chain, so the pending-commit barrier
  (`idleWithPendingCommits`, and `settled()` through it) stays open across
  it. A runtime disposing with its storage kept open drains that barrier
  before it tears down its writes, so the drain waits for the readiness the
  way it waits for the reactive path's catch-up; a runtime closing its
  storage tears down its writes first, and the wait then returns and the
  event is dropped, its commit callback and staged work settling as they do
  on the give-up path.
- **Window elapsed without converging** — a terminal `CommitConvergenceError` is
  surfaced through the scheduler error channel (`scheduler.onError`). The write
  fails loudly rather than disappearing. This is the bounded-resource backstop:
  if a transient failure genuinely never clears, the system does not retry
  forever, it reports, carrying the original error as the error's `cause`.
- **Permanent rejection** — never retried, exactly as before, and still
  observable through the `scheduler.event.commit` telemetry marker
  (`permanentRejection`).
- **Any other non-permanent rejection** — dropped without retry. An authorization
  denial, a malformed store operation, a transport error, or a handler
  `tx.abort()` is not a stale basis, so re-running cannot resolve it; the write is
  dropped and logged rather than entering the window.
- **`retries: false` opt-out** — dropped without retry as well; see below.

### Why only a stale basis is windowed

The dividing line is whether a re-run against fresher confirmed state could change
the outcome. A `ConflictError` and a `StorageTransactionInconsistent` are races
with the confirmed timeline — the server, or the local basis guard, saw a read go
stale — and re-reading fresh confirmed state can win the race, so they take the
window. Every other non-permanent rejection is deterministic with respect to
confirmed state: an authorization policy, a malformed operation, a handler abort,
or a transport failure the server keeps rejecting refuses the identical
transaction identically no matter how fresh the state is. Windowing one would burn
up to the full window (30 seconds by default) of backoff to arrive at the same
refusal, and for a forged or unauthorized event that means retrying a security
denial. So they fail fast, alongside the permanent precondition failures.

An interim version windowed only `ConflictError`, plus `StorageTransactionInconsistent`
when the commit carried a mergeable op (add-wins, commutative — always safe to
retry). Windowing every `StorageTransactionInconsistent` generalizes that: a
stale basis converges by re-running whether or not the op is mergeable, and the
receipt machinery (below) keeps the re-run from double-applying, so the
mergeable-op gate is no longer needed.

### Resource bounds

Backoff caps the retry *rate* (one parked timer per intent, capped delay), and
the window caps the total *duration*. Together they bound the work a single
contended write can generate to roughly tens of attempts over the window, not a
busy loop. The event queue still holds one entry per intent; a backoff retry
re-queues that same entry in place rather than fanning out.

### Event-queue ordering

The scheduler processes the event queue strictly head-first, and a parked event
(`notBefore` in the future) holds the head until its timer fires — this is the
same behavior the existing dirty-dependency throttle already relies on. A backoff
retry is parked at the head, so while a contended write is backing off, events
queued behind it wait. Under a transient storm (which clears in well under a
second) this is imperceptible. The visible effect is only on a write that keeps
conflicting for seconds: event processing behind it slows until the write either
lands or the retry window elapses and it fails terminally. That is the intended
backpressure — the system gets slower under sustained contention rather than
losing the write. `maxDelayMs` bounds how long any single backoff step holds the
head.

### Idempotency

Retrying re-runs the same event with the same durable event id. The memory
engine's receipt machinery makes a re-delivery of an already-applied event a
permanent `receipt-exists` rejection, so a retry cannot double-apply. A retry
only happens after a rejection, where the optimistic write was reverted, so the
re-run reads fresh confirmed state (including profiles that landed in the
meantime) and reconciles — which is why three concurrent appends converge to a
list of three rather than clobbering each other.

### The `retries` opt-out

`queueEvent`'s `retries` argument is a boolean: it gates whether a transient
failure is retried at all, with no count anywhere. It defaults to `true` (used by
every real user event through `cell.send`), so user events get backpressure. A
caller that sends with `retries: false` — a speculative lineage origin, an
internal one-shot — opts out: any failure gives up immediately, so a descendant of
a failed origin still drops deterministically. When `retries` is `true`, a
stale-basis failure is bounded by the retry window rather than a count (a
non-stale-basis failure still drops on the first attempt).

The same `retries` boolean also gates the inSpace-name resolution path
(`RetryImmediately`), which re-runs the handler to resolve a
`PatternFactory.inSpace("name")` target. That loop needs no count either: name
resolution is monotonic — each re-run resolves at least one previously-unresolved
name into a cache, and a resolved name never becomes pending again — so a handler
that references finitely many distinct names terminates on its own. A
`retries: false` event does not take this path; it drops instead of re-running.

## Configuration

`RuntimeOptions.commitBackpressure` tunes the policy
(`scheduler/backpressure.ts`, `CommitBackpressurePolicy`): `baseDelayMs`,
`maxDelayMs`, `jitter`, `retryWindowMs`. Unset fields fall back to
`DEFAULT_COMMIT_BACKPRESSURE` and every field is clamped to a well-defined range
(non-negative delays, a cap no lower than the base delay, jitter within [0, 1], a
non-negative window). The clamps only keep the arithmetic sane; the
never-silently-dropped guarantee does not depend on them. A zero window is
allowed and does not reintroduce silent drops — it makes the first stale-basis
failure fail terminally instead of being retried. Tests use this to shrink the
window and backoff.

## Observability

The `scheduler.event.commit` telemetry marker carries the new state:
`retryAttempt` and `backoffMs` on a backoff retry, and `terminal`
(`"permanent"` | `"convergence"`) when a commit reaches a terminal outcome.
A non-converging write also logs `commit-convergence-failed` and is delivered to
registered `scheduler.onError` handlers as a `CommitConvergenceError`.

## The reactive-action path

The reactive path (`scheduler/run.ts`) does not need this backpressure.
Both paths wait for conflict recovery before the scheduler retries the run, but
they differ in what surrounds that wait: the event path re-queues with backoff
inside a bounded window, while the reactive path re-arms its subscription and
re-queues after recovery. A reactive action is a re-derivation: its output is a
function of its inputs. On a conflict it does not enter the bounded retry
budget — instead it re-arms its subscription and awaits
`Runtime.awaitCommitRetryReadiness`: first the conflict's `readyToRetry`
catch-up, then scoped pulls of every named conflict instance. Those pulls also
repair validation dependencies outside the action's scheduling read set. If the
registration is still active, it re-queues itself against the repaired state.
Fresh input changes can independently re-run the action while recovery is still
pending. Reader-dirty propagation is a redundant fast path when the catch-up
write lands as a fresh notification, but it does not cover a conflict whose
triggering write was already delivered. A conflict there is a wait for recovery,
not a failure, and consumes no budget. Only non-conflict
transient errors fall back to the bounded `MAX_RETRIES_FOR_REACTIVE` retry, and
every attempt re-subscribes so the action recovers when its inputs next change.

Whichever way a run ends, the moment the scheduler stops attempting a commit is
the moment it calls `abandonStagedWork` on that transaction. Every stop does
so, on both paths: a permanent or terminal rejection, an exhausted retry
budget, an exhausted name resolution, a handler that threw, and a caller that
opted out of retrying. A refused late seal is the one refusal that is not a
stop: the durable entry is still the truth and the drain delivers it, so a
further attempt is coming and the staged work is waiting for something. Work staged there
and waiting for the commit hears it as its effect's `abandon`.
That decision is the scheduler's, because the number of attempts is not a
property of the rejection. A CFC refusal whose every reason is a verdict on the
committed data arrives as a terminal class and stops on the first attempt; a
refusal naming something prepare could not evaluate keeps the retryable class,
because the attempt that reads it decides differently. Either way the builtin
waiting on the commit sees a rejection and cannot tell how many follow it, and a
builtin that guesses either reports an error for work that is about to happen or
waits forever for work that will not.

A write CFC enforcement refused and nothing will retry is reported through
`reportDroppedCfcRejectedWrite`, on the reactive path as well as the event path,
so it is visible rather than dropped in silence. A builtin that staged a request
on the abandoned transaction settles its result with the error through the
`onRejected` hook of `enqueueSinkRequestPostCommitEffect`; without that its
request is staged but never sent, and its result stays pending with nothing
coming. Every builtin that stages a sink request passes the hook, and `sqlite*` gives
its effect an `abandon` directly, since it enqueues that effect by hand.
The backpressure rework targets the event-handler path instead, where a one-shot
write *is* the user's intent and cannot be re-derived from inputs, so a conflict
must be actively retried rather than recovered by re-derivation.

## Tests

- `packages/runner/test/scheduler-commit-backpressure.test.ts` — the validation
  of record. It drives the event-handler commit path against an emulated server
  that rejects commits on demand: a burst of transient conflicts longer than the
  old budget still lands; a non-stale-basis rejection (which the server normalizes
  to `TransactionError`) drops on the first attempt without entering the window; a
  permanent rejection is not retried and stays observable; a never-converging
  conflict surfaces a terminal error within the window with bounded attempts; and
  three whole-array appends (`list = [...list, value]`, the profile-append shape)
  survive a conflict storm so the durable count reaches three. This
  deterministically reproduces the silent-loss bug and proves the fix.
- `packages/runner/test/scheduler-event-retry-readiness.test.ts` — the wait
  ahead of the re-run. A refusal carrying a test-held `readyToRetry` gate
  shows no re-dispatch while the gate is held, once logical time has passed
  every backoff step, and exactly one once it opens; a later event queued
  during the hold runs only after the retry; the pending-commit barrier stays
  open for the same hold; and the document the conflict names is synced
  before the handler runs again.
- `packages/runner/test/mergeable-append-multispace-conflict.test.ts` — a
  mergeable append survives a `StorageTransactionInconsistent` storm (windowed),
  and an `AuthorizationError` on the same commit fails fast without entering the
  window (non-stale-basis).
- `packages/runner/test/scheduler-event-lineage.test.ts` — a permanently failing
  origin (a handler that aborts its own tx) fast-fails on its first attempt (an
  abort is not a stale basis, so it is not windowed), and the test asserts the
  lineage invariant: the origin's payload-only same-space follow-up never commits.
  Also exercises the give-up (`retries: false`) and terminal-convergence paths,
  and the "stops handler-result pieces when the handler commit never converges"
  case drives an unending conflict to a terminal `CommitConvergenceError`.
- `packages/runner/test/cfc-ui-contract.test.ts` — the `writeAuthorizedBy`
  enforcement cases confirm the fast-fail path: an unauthorized push is rejected
  and dropped immediately rather than retried for the full window. The refusal
  is a `CfcCommitRefusalError` — a verdict on the pushed data, so it is
  terminal (`cfc/verdict-reason.ts`); only a refusal that is not wholly a
  verdict keeps the retryable `StorageTransactionAborted` name.
- `packages/patterns/integration/home-profile.test.ts` — unchanged browser-level
  profile-creation regression coverage; still passes (the fix does not regress
  the normal cross-space append).

## Reproduction status in this codebase

The motivating instance — profile appends swallowed by a rehydration conflict
storm, leaving a durable count of one — was confirmed in an earlier copy where
loading a home with existing profiles produced about nineteen basis-sequence
conflicts. In the current copy that storm is much milder: rehydrating a home
with a profile produces only a few reactive-commit conflicts, and they clear
before a profile append is issued, so the append's event commit does not hit a
conflict at all. A browser count-probe driven against this copy therefore does
not exercise the backpressure path (no event-handler conflict, no backoff), so
it cannot validate the fix end-to-end here, and any residual count discrepancy
under idle-only waits comes from cross-space rehydration timing rather than the
conflict-exhaustion this change addresses. The fix is validated instead at the
runner level, where the conflict storm is injected deterministically and the
committed write is shown to converge rather than drop.
