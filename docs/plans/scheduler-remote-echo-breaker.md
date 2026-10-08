# A scheduler breaker for remote-echo write loops

A trigger-independent bound on the write loop in which a derivation writes a
document, a remote change to that same document re-triggers it, and it writes
again without end, because another session is doing the same from the other
side.

This is the backoff Robin McCollum named as the prerequisite for revisiting
the sticky output placement (Topic 911), and the first of the three guardrails
Topic 913 lists against a runaway writer on a shared space. It sits in the
scheduler, where the loop runs, so it holds on both the client arm and the
server-execution serving arm.

## The shape of the loop

A reactive computation `A` reads a document `D` and writes `D`. In the storm
of 2026-10-07 the read is the write path's own diff base: the scope-narrowing
write reads `D`'s redirect slot and the value it holds, so `D` is in `A`'s read
set and in `A`'s write set at once. `A` commits a value to `D`. A second
session runs the same computation, holds a different instance state, and
commits a different value to the same space-scoped `D`. That commit arrives on
the first session as foreign novelty. Because `D` is in `A`'s read set, the
change re-triggers `A`. `A` re-runs, reads the foreign value as its diff base,
and writes its own differing value back over it. The second session sees that
and does the same. The deep-equal guard on writes does not help, because the
two values genuinely differ. Each run succeeds, commits cleanly, and is
re-triggered by the other side.

The investigation record is
[`../history/development/performance/2026-10-07-topics-space-write-storm.md`](../history/development/performance/2026-10-07-topics-space-write-storm.md).
The placement bug that made the two sides disagree is fixed in
commonfabric/labs#8553. This breaker is trigger-independent: it bounds the loop
whatever made the two sides disagree, so it holds for the three triggers the
shared Topics space has already seen (Topic 271's cross-version identity
collisions, the 2026-10-05 sweep, and the scope-placement split) and for the
next one.

### Why the existing bounds do not see it

The scheduler already carries three bounds, and the loop slips past all three
because every individual run of `A` is healthy:

- **The reactive retry budget** (`MAX_RETRIES_FOR_REACTIVE`, `run.ts`) counts
  *failed* commits. Each echo run commits successfully, so the budget is never
  charged.
- **Committed-write backpressure**
  ([`../features/committed-write-backpressure.md`](../features/committed-write-backpressure.md))
  bounds *conflict* retries. An echo run reads the foreign value as its fresh
  basis and commits without conflict, so backpressure never engages.
- **Convergence backoff** (§7.7 of
  [`../specs/scheduler-v2/README.md`](../specs/scheduler-v2/README.md),
  `PASS_RUN_BUDGET` and the settle cap) bounds a single settle pass that will
  not converge *locally*. Each echo run converges in one pass; the re-trigger
  arrives from outside, between passes, as a fresh remote notification.

The own-commit-source skip (`invalidation.ts`, `isOwnCommitSource`) already
stops `A` re-running for the echo of its *own* commit. A foreign session's
write is not own-commit-source, so it re-triggers legitimately. That is the
gap this breaker fills: a bound on re-runs that each succeed but are driven by
a remote party writing the same document back.

## 1. Detection

### Echo and convergence steps

After each successful run of `A`, the breaker classifies the documents that
triggered the run and that the run read. Such a document `D` satisfies:

1. `D` is among the addresses that triggered this run (the run's invalid
   causes — `A` ran *because* `D` changed, not because an unrelated input did).
2. `D` is in the run's read set, deep or shallow (`A` read `D` — the
   self-referential shape; the diff-base read satisfies this).

The run is an **echo step** for `D` when it also changed `D`: a write detail
under `D` holds a value that differs from the value `D` held before the run
(`!valueEqual(previousValue, value)`). In the loop that previous value is the
other session's: `A` read it as its diff base and wrote its own over it.

Otherwise the run is a **convergence step** for `D`. Storage drops a write of
an equal value before it reaches the transaction's write details, so a run that
wrote `D`'s current value again leaves no write behind, exactly as a run that
did not write `D` at all. Both are convergence: this run did not overwrite
anything.

Every address is compared by its complete identity — space, scope instance, and
id, the scheduler's `entityKey` — resolved against the one identity the
transaction serves: the demanded instance on a serving runtime, the runtime's
own session everywhere else. Write details name a scope but not its instance,
so they resolve through the same identity. Matching on less would let the same
id in two spaces, or two session instances of one document, pass for one
document.

The step is computed at commit kickoff, while the transaction's write details
are still staged, and handed to the breaker once the commit has succeeded. A
counter of echo steps is kept per pair `(action id, document identity)`: the
storm wrote one shared space-scoped document, so the pair that oscillates is a
single key, while two demanded instances of one node write distinct documents
and stay apart.

### Trip condition

An untripped pair trips when its echo-step count reaches `ECHO_TRIP_THRESHOLD`
within `ECHO_WINDOW_MS`. Before a trip, a convergence step clears the pair and a
window that elapses with no echo step resets the count. The count is of
sustained oscillation: an eventually-consistent derivation that writes `D` once
or twice and then agrees resets long before it trips.

Proposed defaults, to be tuned against the health-route rate signal (Topic
913) once that exists:

| Constant | Value | Why |
| --- | --- | --- |
| `ECHO_WINDOW_MS` | 10000 | Ten seconds. The storm ran near ten writes per second, so a real loop fills the window many times over; a human alternation does not. |
| `ECHO_TRIP_THRESHOLD` | 12 | Twelve oscillation steps on one document inside the window. A convergent derivation reaches one or two and resets. |

### Telling it from legitimate work

The conditions together are what separate the loop from collaboration, and each
rules out a specific honest case:

- **Two people typing into one document.** A collaborative edit is an event
  handler appending or patching, not a reactive computation re-triggered by its
  own output. A handler is not a reactive run, and is not re-triggered by the
  document it wrote, so no step is ever counted for it.
- **A derivation whose inputs genuinely change often.** A clock, a counter, a
  fast sensor: `A` reads input `S` and writes `D`. A change to `S` re-triggers
  `A`, which writes a new, correct `D`. The trigger is `S`, not `D`, so `D` is
  never a candidate, and `S`, which `A` does not change, is a convergence step —
  the breaker never trips, however fast `S` moves.
- **A cold load re-persisting a derived label per item.** Topic 913 records one
  session writing 663 commits in a minute on a cold board load, doing nothing
  wrong. Those are 663 *distinct* documents written once each, each written
  because of an input rather than because of itself. The breaker is keyed per
  `(action, document)`; the loop rewrites the *same* document and a bulk load
  does not.
- **A genuine convergence over a few runs.** Two sessions settling on one value
  write differing values for a run or two and then agree. The agreeing run is a
  convergence step, which clears the pair before the threshold.

## 2. Response

### Backoff

On a trip, the breaker defers `A`'s re-runs with capped exponential backoff.
It rides the scheduler's existing time-gate primitive (§8.1 of the
scheduler-v2 spec): a gate field `echoBackoffUntil` folded into
`eligibleAt(N) = max(debounceReadyAt, throttleReadyAt, backoffUntil,
echoBackoffUntil)`. A time-gated action is not selected as a settle seed until
it is eligible, and the single wake is armed for the deadline that stands.

The threshold governs only the entry into the tripped state. Once a pair has
tripped, every further echo step renews the backoff at once, one step longer,
from `ECHO_BACKOFF_BASE_MS` doubling to `ECHO_BACKOFF_MAX_MS`. The loop never
gets a fresh burst after a deadline passes: each wake allows one run, and if
that run echoes again the next backoff is already in place.

| Constant | Value |
| --- | --- |
| `ECHO_BACKOFF_BASE_MS` | 500 |
| `ECHO_BACKOFF_MAX_MS` | 30000 |
| `ECHO_QUIET_RESET_MS` | 60000 |

At the cap, `A` re-runs at most once every thirty seconds in response to a
remote echo, so the commit rate for the loop falls from the storm's ~10/s to
~0.03/s per looping document. The system gets slower under a sustained loop
rather than busy-looping — the same principle as committed-write backpressure,
applied to a loop of *successful* commits.

Distinct from the convergence backoff: `echoBackoffUntil` is a separate field
so that clearing one does not clear the other, and so that the idle semantics
stay correct. `isConvergenceBackoffDeferred` reads only `backoffUntil`, so an
echo-deferred re-run is treated like a throttle window — a freshness bound on
an already-ran computation that does **not** hold `idle()` open. An echo re-run
is not idle-relevant work a caller must observe; a reader sees the last
committed value, which stands.

A retry the scheduler owes after a conflict releases the debounce and throttle
but not this backoff, as it does not release the convergence backoff: each
bounds a loop, and a retry inside one waits its turn like every other run.

### What stands, and what stops

The run's last committed value stands. It is durable and valid — the loop is
not a correctness failure on either side, only a disagreement about which of
two valid values wins, and neither write is rolled back. The breaker does not
stop `A` writing; it rate-limits how often `A` re-runs while it keeps echoing.
A real change to another input still marks `A` invalid and is served when the
backoff ends.

Eventual consistency is preserved: once the other side agrees or goes away,
`A`'s next run reads the now-stable value, leaves it as it is, and that
convergence step clears the pair and lifts the backoff.

### The loud line

When a pair trips, the breaker logs one line at error level through a counted
channel, naming the action, the document, the threshold, and the window:

```
remote-echo-breaker-tripped action <id> rewrote document <space>/<scope>/<id>
12 times within 10000ms against a remote writer; backing off its re-runs,
starting at 500ms
```

Counted regardless of log level (via `getLoggerCountsBreakdown()`), and emitted
once per trip rather than per renewal — the same discipline as
`reactive-retry-not-converging` — so a permanent loop does not flood the log.

### Reset

An untripped pair is cleared by a convergence step and has its count reset by
a lapsed `ECHO_WINDOW_MS`. A tripped pair is cleared, and its backoff lifted,
by:

- a **convergence step** for `D` — the loop has ended;
- `ECHO_QUIET_RESET_MS` with no echo step — the loop ended without a run that
  could observe it, for instance because the other session went away. The
  quiet stretch is longer than the backoff cap, so a loop still running at the
  cap never looks quiet. The ten-second window does not reset a tripped pair,
  since it would cancel a thirty-second backoff before its deadline;
- `A`'s registration being retired — the pair state is dropped, and the gate
  on the node record, which outlives the registration, is cleared so a later
  registration of the same action does not inherit it.

The per-pair state lives in a bounded map (`MAX_ECHO_PAIRS`, oldest-evicted),
so a space that touches very many documents cannot grow the table without
bound.

## 3. Observability

A tripped breaker is visible without a log search through three surfaces, in
rising order of plumbing:

1. **The counted log channel** — `getLoggerCountsBreakdown().scheduler[
   "remote-echo-breaker-tripped"]` returns the cumulative trip count in any
   process, reachable from the browser console summary
   (`commonfabric.getLoggerCountsBreakdown()`) with no new wiring. The prototype
   ships this.
2. **A scheduler stat** — `scheduler.getEchoBreakerStats()` returns
   `{ active, trips, cyclesObserved }`: the pairs whose backoff is in force
   right now, the pairs that have tripped, and the echo steps counted. `active`
   counts deadlines rather than tripped pairs, so a loop that ended without a
   convergence step stops counting once its last backoff runs out. The
   prototype ships this.
3. **The health route** — a per-space field on `/api/health/stats` so a tripped
   breaker on a serving instance is a dashboard fact. This composes with the
   per-space commit-rate signal Topic 913 scopes, and is best built alongside
   it rather than in this prototype; the design records the field
   (`servingLoop.echoBreaker: { active, trips }`, OFF-arm-absent like the rest
   of the `servingLoop` block) and defers its wiring.

## 4. Interaction with the existing bounds and with server execution

**The retry budget and backpressure** are orthogonal and compose cleanly. They
act on *failed* commits (transient conflicts, terminal refusals); the echo
breaker acts on *successful* commits that re-trigger. A run the breaker is
spacing out still commits normally, and if that commit conflicts, backpressure
engages on top. The breaker never charges the retry budget and never rolls a
write back.

**Server execution** (the ON arm, serving-loop.md) runs the derivations in the
one serving runtime rather than on the clients, so under it the serving loop is
the writer. The breaker lives in the scheduler, which the serving loop hosts,
so it applies unchanged. Three points make it correct there:

- The serving loop already skips its own derived commits by commit class and
  holder (serving-loop.md §3's self-echo rule), so the server never counts an
  echo step against its own wave output. A counted echo step on the serving arm
  comes from a genuine foreign writer (a client still writing the space, or a
  second instance of the node), which is exactly the loop to bound.
- Keying by complete identity, resolved against the run's demanded instance,
  keeps two demanded instances of one fanned-out node apart: they write
  distinct scoped documents, so neither counts against the other. The storm's
  shared space-scoped document is one key, which is what trips.
- `echoBackoffUntil` behaves like a throttle for the wave's idle probe
  (`isIdle`, `hasArmedGateWake`): a deferred echo re-run does not hold a wave
  open, and the SpaceServer's parking policy already treats an armed gate wake
  as not-idle, so a backed-off re-run is a scheduled wake rather than a lost
  one.

The breaker is the client-and-server guardrail; it does not reach a client
running stale code that never re-runs through this scheduler path (Topic 907's
mixed-version case), which is why Topic 913's server-side commit cap is a
separate, complementary guardrail that bounds a writer the runtime cannot
reach.

## 5. The experimental flag

The breaker ships behind `remoteEchoBreaker`, registered in
[`../development/EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md):

- **Toggle:** `EXPERIMENTAL_REMOTE_ECHO_BREAKER` env, or
  `RuntimeOptions.experimental.remoteEchoBreaker`.
- **Default:** off. A new in-progress feature that changes write cadence under a
  loop; it ships dormant and is enabled deliberately for dogfooding on a
  dev space before any default-on decision.
- **Authority:** server. Under server execution the server runs the
  derivations, so a client and server that disagreed on whether to rate-limit
  would diverge on write cadence for a shared document; the safe direction is
  that the deployment decides.
- **End state:** fold into base scheduler semantics and delete the flag once
  the thresholds have been tuned against live rate data and the behavior has
  soaked.

## 6. Tests

`packages/runner/test/scheduler-remote-echo-breaker.test.ts` holds both
levels. Waits are on scheduler drains and the fake clock's `settle` and `tick`,
never a sleep or a poll, per
[`../development/waiting-in-tests.md`](../development/waiting-in-tests.md).

- **The classifier and the breaker.** `computeEchoSteps()` against a stand-in
  transaction: an echo step for a changed self-read trigger, a convergence step
  when nothing was written, no echo step for an output that was not the
  trigger, no match across spaces for one id, and distinct keys for two session
  instances. The breaker fed synthetic steps at chosen instants: the threshold
  trips, every later echo renews one step longer up to the cap, a lapsed window
  resets only an untripped pair, a quiet stretch starts a tripped pair afresh, a
  convergence step lifts the backoff unless another document of the action is
  still backing off, `active` follows deadlines, and the table is bounded.
- **Two sessions over one emulated server** with manual fan-out, each running
  an effect that reads a shared document and writes its own tag to it. The
  breaker trips on both sides and the commit sequence stops while logical time
  is held. With time advanced through repeated backoffs, each session re-runs
  at most once per cycle while the disagreement continues. Once the two agree,
  the session that reads the agreed value writes it again, storage drops the
  write, and that convergence step clears its pair; commits stop and nothing is
  active. With the flag off the same loop keeps committing and never trips. A
  derivation re-run past the threshold by another session's edits to its input
  does not trip. A re-subscribed action does not inherit the retired
  registration's backoff.

Each of the renewal, convergence, identity, and unsubscribe behaviors has been
checked to fail its test when reverted.

## Stages

1. [x] **The breaker and the flag.** The `RemoteEchoBreaker` module, the
   `echoBackoffUntil` gate field and its `eligibleAt` fold, the `run.ts`
   finalize hook that computes the steps and applies the backoff, the flag, and
   the unit tests. Flag off, no behavior change.
2. [x] **The two-session tests** manufacturing the loop and proving the trip,
   the sustained rate bound, the convergence reset, and the no-trip on
   legitimate re-derivation.
3. [ ] **The health-route field**, built with Topic 913's per-space rate signal.
4. [ ] **Tuning and graduation:** set the thresholds from live rate data, soak,
   then fold in and delete the flag. Revisiting the sticky placement (Topic
   911) unblocks once stage 1 is on.
