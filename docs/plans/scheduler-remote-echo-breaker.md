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

### One echo cycle

A run of `A` is an **echo step** for document `D` when all of the following
hold at the commit of that run:

1. `D` is in the run's write set (`A` wrote `D`).
2. `D` is in the run's read set, deep or shallow (`A` read `D` — the
   self-referential shape; the diff-base read satisfies this).
3. `D`'s id is among the addresses that triggered this run (the run's invalid
   causes — `A` ran *because* `D` changed, not because an unrelated input did).
4. The value `A` wrote to `D` differs from the value `D` held before this run
   wrote it (`!valueEqual(previousValue, value)` on `D`'s write detail — the
   run overwrote a differing value rather than converging on it).

Condition 4 reads the write detail's `previousValue`, which in the loop is the
foreign session's value: `A` read it as its diff base and is now writing over
it. A run that writes a value *equal* to what `D` held is a **convergence
step**, not an echo step.

An **echo cycle** for `(A, D)` is one echo step counted against a sliding
window. The window and the counter are keyed by the pair `(action id, resolved
document key)`, where the resolved document key is the address id together with
its resolved scope instance (`scopeKey` when the serving arm set one, else the
declared `scope`). Keying by the *resolved* instance keeps two legitimately
distinct scoped instances of one node apart: the storm wrote one shared
space-scoped document, so the pair that oscillates is a single key.

### Trip condition

The breaker trips for `(A, D)` when its echo-cycle count reaches
`ECHO_TRIP_THRESHOLD` within `ECHO_WINDOW_MS`. A convergence step for `(A, D)`,
or a window that elapses with no echo step, resets the count. The count is of
sustained oscillation: an eventually-consistent derivation that writes `D`
once or twice and then agrees resets before it ever trips.

Proposed defaults, to be tuned against the health-route rate signal (Topic
913) once that exists:

| Constant | Value | Why |
| --- | --- | --- |
| `ECHO_WINDOW_MS` | 10000 | Ten seconds. The storm ran near ten writes per second, so a real loop fills the window many times over; a human alternation does not. |
| `ECHO_TRIP_THRESHOLD` | 12 | Twelve oscillation steps on one document inside the window. A convergent derivation reaches one or two and resets. |

### Telling it from legitimate work

The four conditions together are what separate the loop from collaboration,
and each rules out a specific honest case:

- **Two people typing into one document.** A collaborative edit is an event
  handler appending or patching, not a reactive computation re-triggered by its
  own output. A handler is not re-triggered by the document it wrote, so no
  echo step is ever counted. Condition 2 (the computation reads what it wrote)
  and condition 3 (the re-trigger is the document itself) both fail for a
  handler-driven edit.
- **A derivation whose inputs genuinely change often.** A clock, a counter, a
  fast sensor: `A` reads input `S` and writes `D`. A change to `S` re-triggers
  `A`, which writes a new, correct `D`. The trigger is `S`, not `D`, so
  condition 3 fails — the breaker never counts it, however fast `S` moves.
- **A cold load re-persisting a derived label per item.** Topic 913 records one
  session writing 663 commits in a minute on a cold board load, doing nothing
  wrong. Those are 663 *distinct* documents written once each. The breaker is
  keyed per `(action, document)`, so every pair has a count of one and nothing
  trips. The loop rewrites the *same* document; a bulk load does not.
- **A genuine convergence over a few runs.** Two sessions settling on one value
  write differing values for a run or two and then agree. The agreeing run is a
  convergence step (condition 4 fails), which resets the count before the
  threshold.

## 2. Response

### Backoff

On a trip, the breaker defers `A`'s re-runs with capped exponential backoff.
It rides the scheduler's existing time-gate primitive (§8.1 of the
scheduler-v2 spec): a new gate field `echoBackoffUntil` folded into
`eligibleAt(N) = max(debounceReadyAt, throttleReadyAt, backoffUntil,
echoBackoffUntil)`. A time-gated action is not selected as a settle seed until
it is eligible, and a single wake is scheduled for the deadline. The delay
doubles on each further trip of the same pair, from `ECHO_BACKOFF_BASE_MS` to
`ECHO_BACKOFF_MAX_MS`.

| Constant | Value |
| --- | --- |
| `ECHO_BACKOFF_BASE_MS` | 500 |
| `ECHO_BACKOFF_MAX_MS` | 30000 |

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

### What stands, and what stops

The run's last committed value stands. It is durable and valid — the loop is
not a correctness failure on either side, only a disagreement about which of
two valid values wins, and neither write is rolled back. The breaker does not
stop `A` writing; it rate-limits how often a *remote echo* re-runs it. `A` is
still re-triggered immediately by a genuine change to any *other* document it
reads, because the backoff gates the action and a real input change still marks
it invalid and schedules a wake — the backoff only delays *when* the deferred
run becomes eligible, and a legitimate input change that arrives after the
deadline runs at once.

Eventual consistency is preserved: if the other side goes away, `A`'s next
run reads the now-stable value, writes an equal value, and the convergence step
clears the breaker.

### The loud line

On each trip the breaker logs one line at error level through a counted
channel, naming the action, the document, the cycle count, and the window:

```
remote-echo-breaker tripped: action <id> rewrote document <space>/<id>
<count> times in <window>ms against a remote writer; backing off to <delay>ms
```

Counted regardless of log level (via `getLoggerCountsBreakdown()`), and emitted
once per trip rather than per cycle — the same discipline as
`reactive-retry-not-converging` — so a permanent loop does not flood the log.

### Reset

The breaker resets a pair's count and clears its `echoBackoffUntil` when any of:

- `A` takes a **convergence step** for `D` (writes a value equal to what `D`
  held) — the loop has ended.
- `ECHO_WINDOW_MS` elapses with no echo step for the pair — no sustained loop.
- `A`'s node is removed or its registration retired — the state is pruned with
  the node.

The per-pair state lives in a bounded map (`ECHO_STATE_MAX`, oldest-evicted),
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
   `{ active, trips, cyclesObserved }`: how many pairs are currently in backoff,
   the cumulative trip count, and the cumulative echo-cycle count. The prototype
   ships this.
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
- Keying by resolved instance (`scopeKey`) keeps two demanded instances of one
  fanned-out node apart: they write distinct scoped documents, so neither
  counts against the other. The storm's shared space-scoped document is one
  key, which is what trips.
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

- **Unit** (`packages/runner/test/scheduler-remote-echo-breaker.test.ts`,
  `describe("RemoteEchoBreaker")`): feed the breaker synthetic echo and
  convergence steps on a fake clock and assert the threshold trips, a
  convergence step resets, a window lapse resets, the backoff escalates to the
  cap, the per-pair keying keeps distinct documents independent, and the
  bounded map evicts. Deterministic, no sleeps — the breaker takes `now` as an
  argument.
- **Two-session** (same file or a companion), modeled on
  `scoped-output-convergence.test.ts` and `array-push-mergeable.test.ts`: two
  runtimes over one emulated shared server, a program whose computation writes a
  space-scoped document from a per-session input so the two sessions disagree on
  purpose. Assert that with the flag on the breaker trips, the shared server's
  commit sequence advances slower under the backoff than it does with the flag
  off (`Engine.serverSeq`), and the last value stands. A companion case drives a
  *legitimate* alternating edit — each session writing its own value in turn,
  converging — and asserts the breaker does not trip. Waits are on cell and
  commit events and the fake clock's `tick`, never a sleep or a poll, per
  [`../development/waiting-in-tests.md`](../development/waiting-in-tests.md).

## Stages

1. **The breaker and the flag.** The `RemoteEchoBreaker` module, the
   `echoBackoffUntil` gate field and its `eligibleAt` fold, the `run.ts`
   finalize hook that computes echo steps and applies the backoff, the flag, and
   the unit test. Flag off, no behavior change.
2. **The two-session test** manufacturing the loop and proving the trip, the
   commit-rate fall, and the no-trip on legitimate alternation.
3. **The health-route field**, built with Topic 913's per-space rate signal.
4. **Tuning and graduation:** set the thresholds from live rate data, soak, then
   fold in and delete the flag. Revisiting the sticky placement (Topic 911)
   unblocks once stage 1 is on.
