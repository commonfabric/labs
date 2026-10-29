# The Fetch Builtins' Request Deadlines

_Why `fetch.ts` and `fetch-program.ts` keep a wall-clock bound, what that bound
is actually measuring, and what had to change before an early fire was
survivable._

**Status:** current · **Updated:** 2026-07-29

---

## The question

[Retiring the LLM Tool-Call
Deadline](../history/development/proposals/retiring-llm-tool-call-deadlines.md)
removed a deadline that
bounded how long a local computation was allowed to take, and kept one that
bounded how long to keep believing a different replica was still working. It
left the two deadlines in the fetch builtins undecided, on the grounds that a
bound on a network call raises a different question: what should happen when a
remote peer never answers. This document settles that.

The test is the one in
[`waiting-in-tests.md`](../development/waiting-in-tests.md#wall-clock-time-is-not-a-measure-of-progress):
not "is the bound comfortably large" but "is firing early safe". A bound whose
early fire only repeats work is tolerable. A bound whose early fire drops a real
result is not.

The answer for both is the same: the bound stays, because it answers a question
that has no event, and because the thing it protects is not the request. What
changed is that the bound used to be consulted in places where it was answering
a question the code could answer exactly, and where firing early cost a real
result rather than repeated work.

## What each deadline actually protects

Neither deadline bounds a fetch. Neither one aborts anything, and neither one is
consulted by the replica running the request.

Both fetch builtins coordinate across replicas — every client runs the whole
reactive graph of every started piece, so several of them reach the same
`fetchJson` node at the same moment and would otherwise all issue the request.
The coordination is a claim written to durable state, and the deadline decides
when a claim is treated as abandoned:

- **`fetch.ts`**, through `tryClaimMutex` in `fetch-utils.ts`, writes
  `pending: true` plus a `requestId` and a `lastActivity` timestamp into an
  `internal` cell. A replica may claim when nothing is pending, or when the
  standing claim's `lastActivity` is older than the bound. The default bound
  lives in `fetch-utils.ts` as `MUTEX_STALE_AFTER`; a caller can override it per
  call with `options.mutexTimeoutMs`.
- **`fetch-program.ts`** writes a `fetching` entry, carrying a `requestId` and a
  `startTime`, into a durable cache keyed by the input hash. The bound is
  `PROGRAM_CLAIM_STALE_AFTER` in that file.

`lastActivity` does not live up to its name, and the difference matters. It is
stamped once, when the claim is made, and nothing ever refreshes it. So the
comparison measures how long ago the request started, not how long the claimant
has been silent. The LLM dialog's five-minute bound is the other thing:
`safelyPerformUpdate` refreshes its timestamp on every durable write of a turn,
so there the comparison really is a staleness bound on a heartbeat. Reading
these two as the same shape is the mistake this document is trying to prevent.

So each bound is a lease on a claim, not a timeout on a request. The lease
exists because of what happens without one: a replica that goes away between
claiming and writing back leaves `pending: true` — or a `fetching` entry —
standing in durable state forever. `addCancel` releases the claim when a pattern is stopped in an
orderly way, which covers a navigation but not a closed tab, a killed worker, or
a machine that went to sleep and never came back. With no lease, no other
replica may ever claim, and the piece shows a spinner that will never resolve.

Deciding whether the replica holding a claim is still there is failure
detection, and it is the case the proposal document already identifies as
irreducible. Nothing in the runner reports another replica's presence: the
memory server knows about connections and sessions, but no signal derived from
them reaches a client, so there is no transport close, no abort, and no rejected
promise to wait on. A staleness bound is the only instrument available, and that
is why both bounds stay.

## The bound is a predicate, not a timer

Nothing arms these deadlines. No timer fires at the bound. Each one is a
comparison against `Date.now()` inside the builtin's reactive action, evaluated
whenever something else causes that action to run.

Two consequences follow, and they pull in opposite directions.

As a recovery mechanism, the bound is weaker than it looks: an abandoned claim is
cleared only if some replica's action happens to run later, and nothing
guarantees that a quiet piece ever will. It recovers reliably at the moments a
replica arrives and evaluates the state fresh — a page load, a piece being
opened — which is the common shape of the case it exists for.

As a hazard, the bound is narrower than it looks: it cannot fire spontaneously
during a healthy request in an otherwise quiet piece, because nothing wakes the
action to evaluate it. It fires when a replica is already awake for another
reason and finds a claim standing. That is exactly the busy-piece,
several-replicas case.

## What an early fire used to cost

Sizing was the first symptom. The `fetch.ts` bound was five seconds, chosen on
the reasoning that HTTP requests usually finish quickly. That is the reasoning
`waiting-in-tests.md` rules out, and it did not survive contact with a real
endpoint: `options.mutexTimeoutMs` was added so the lunch-poll pattern's image
generation could raise its own bound to thirty seconds, an escape hatch for a
default that was below the latency of work the repository ships. The
`fetch-program.ts` bound was ten seconds for an operation that walks a program's
entry module and every transitive dependency over the network, and loads the
compiler stack on the way.

But the sizing was the smaller half. In both builtins an early fire cost a real
result:

**`fetch-program.ts` applied the bound to its own in-flight resolution.** It
tracked no local state at all, so the replica that started a resolution judged
its own work by elapsed time exactly as it judged anyone else's. When the bound
tripped, the entry went back to `idle`, and the resolution the replica was still
running now had nowhere to write. Its writeback only lands if the entry is still
`fetching`, so the finished program was discarded on arrival. The piece was left
with `pending: false`, no result, and no error — indistinguishable from
"finished, nothing here" — and it stayed that way. The self-restart the code
appears to intend does not even happen: the action's own write does not wake it,
so the entry sits at `idle` until something else disturbs it.

**`fetch.ts` let a failing duplicate erase a good result.** A takeover leaves two
requests for the same inputs in flight. `tryWriteResult` gates only on the input
hash, so both may write, which is fine when both succeed and write the same
thing. The error path cleared `result` unconditionally before writing the error,
so a duplicate that failed — being rate-limited for being a duplicate, most
plausibly — replaced the other request's good result with its own error.

Neither of those is "repeats cleanup". Both are "drops a real result".

## What changed

**A replica no longer judges its own work by the clock.** `fetch-program.ts`
records what it is resolving in an `inFlight` map and leaves those entries alone
however long they take: a resolution running here ends when its promise settles,
which is a real event and needs no estimate. The bound now applies only to an
entry this replica did not claim. `fetch.ts` already had this narrowing in its
`alreadyFetching` check, which answers from the replica's own state rather than
from the timestamp.

Note what is *not* in that sentence. `fetchProgram` holds an `AbortController`,
but the signal never reaches the network: `HttpProgramResolver` issues its
requests without one, and `resolveProgram` takes no signal. Aborting suppresses
a writeback nobody is waiting for; it does not end a resolution. So a program
host that accepts a connection and never answers leaves this replica resolving
indefinitely, with `pending: true`. That is the same trade the tool-call
proposal names: a truthful pending state instead of a deadline that reports a
failure and throws away the answer if it ever arrives. Wiring cancellation
through `js-compiler` would make it a real event end-to-end, and is not done
here.

**A failure no longer overwrites a result it did not produce.** The error path in
`fetch.ts` leaves a result already recorded for the same inputs in place. A
failed request is evidence about that request, not about the value another
request already obtained.

**A takeover no longer passes through `idle`.** `fetch-program.ts` rewrites a
stale `fetching` entry straight into its own claim. Round-tripping through
`idle` published `pending: false` with no result for a tick, which reads to a
consumer as "finished, nothing here".

**A claim now says which replica made it.** Both builtins used to write the
input hash as the claim's `requestId`, so every replica claiming the same
request wrote the same value. Teardown compared against it to decide whether the
standing claim was its own, and the comparison always said yes. A replica
closing a piece could therefore release a claim another replica had taken over
and was actively working under, publishing `pending: false` with no result — the
same lie, reached from the other end. The claim id now carries `runtime.id`,
which is unique per storage manager and so per replica.

That identity is used for teardown only. Writebacks stay gated on the input
hash, so after a takeover either request may write its result: they are
requests for the same inputs, and the first one home should count. Making the
writeback strict would have been the other way to use a unique id, and it would
have reintroduced the defect this whole change is about — the loser's real
result discarded.

**The bounds themselves are unchanged**, at five and ten seconds. Once firing
early is survivable, the size stops being a correctness question, and it is a
trade with a cost on both sides.

Too low, and a slow request pays a duplicate whenever a second replica is awake
to notice it — the case the lunch-poll pattern worked around by raising its own
bound to thirty seconds.

Too high, and an abandoned claim is believed for longer. That is worse than a
delay, because of the predicate-not-a-timer property above. A replica arriving
fresh evaluates the state during startup and then has no reason to look again.
If the abandoned claim is younger than the bound at that moment, the takeover
does not happen, nothing schedules another attempt, and the piece keeps showing
a spinner until something else disturbs the action. That is the shape of a tab
crashing mid-request and the user reloading straight away, which is the most
likely way anyone meets an abandoned claim at all.

A duplicate request is wasted work. A spinner that never resolves is a dead end
the user cannot even diagnose. So the trade goes to the lower bound, and a
caller whose endpoint is slow enough for duplicates to matter raises its own
with `options.mutexTimeoutMs` — which is what that option is for.

## What is still exposed

A takeover during a healthy request sends a second copy of the request to the
remote peer. For a GET that is wasted bandwidth. The fetch builtins accept a
caller-supplied `method`, so it can also be a second POST, and the remote peer
sees the side effect twice. Preventing duplicate requests is what the mutex is
for, so this is the mutex failing at its job rather than a correctness bug in the
runtime, and it is the same trade the proposal document accepts for the LLM
dialog's heartbeat: an early fire costs a wasted call, not corrupted state.

Closing that last gap needs the claim to be refreshed while the request is in
flight, so that the bound measures the claimant's silence rather than the
request's duration — which is what makes the LLM dialog's five-minute bound
defensible, since `safelyPerformUpdate` refreshes its heartbeat on every durable
write of a turn. A fetch has no intermediate durable writes to hang that on, so
it would take a periodic write of its own: a durable write every few seconds for
every long-running fetch, which every other replica then reads. That is a real
cost against a residual risk, and it is not paid here.

Cancellation does not reach a program resolution's network requests, so a hung
program host leaves that resolution running. `fetch-program.ts` retains one
controller per dispatched request and resolved user or session instance. Input
changes preserve older resolutions so returning to an earlier URL can use its
result. Stopping the node aborts every local controller and releases its accepted
claims, including requests waiting for outbox dispatch. Claim cleanup and
completion guards read under the identity that issued each request. Aborting
suppresses writeback; it does not stop the resolver's network requests.

`runtime/runner/test/fetch-claim-takeover.test.ts` pins what makes the residual
risk survivable: a slow resolution running in this replica still reaches its
result, a failing request does not erase a result recorded for the same inputs,
and the staleness branch itself leaves a fresh claim alone while taking over an
old one. It also covers the claim's other transitions — handing it back when the
pattern stops, a resolution that fails, an empty URL.

One case there is untested, and it is the negative half of the ownership check:
an entry carrying *another* replica's claim id, which teardown must leave alone.
Reaching it takes a second replica writing the same durable cache cell, and
`StorageManager.emulate` gives each runtime its own server, so a runner unit
test cannot arrange it as things stand. The positive half — an entry this
replica still holds, which teardown does release — is covered.
