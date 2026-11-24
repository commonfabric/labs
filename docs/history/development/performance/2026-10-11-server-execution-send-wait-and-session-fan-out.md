---
status: historical
created: 2026-10-11
archived: 2026-10-11
reason: "Point-in-time record of what a vote costs the serving loop and why, what main's CI actually failed on around #8660, and the measurements behind making a stream send fire-and-forget again with the wait moved to the read."
---

# Server execution: the per-vote cost, the CI evidence behind the #8660 revert, and a send that waits nowhere

All figures come from one 4-core container with nothing else on the box.
"ON" is server execution on, "OFF" off; both ends of every run were on the
same arm. The vote probe hosts its own memory server and serving loop in the
test process through `MultiRuntimeHarness`; the Topics seed runs
`topic-board-seed.ts` against a fresh toolshed started from the commit under
measurement. Measurement scripts were kept out of the tree; the last section
says how each number was taken.

## What one vote costs, and what it scales with

The keyed-votes fixture (`lunch-poll-keyed-votes`, which wraps the whole lunch
poll) with five voter sessions and five options, one vote at a time, then a
burst of all twenty-five. Each row is wall time from the send to the last of
four points: the send returning, the voter's own runtime idle, the voter's
event consequence arriving back, and every session settled.

| arm | one vote (send / idle / consequence / settled) | 25-vote burst, settled |
| --- | --- | --- |
| OFF | 2 ms / 100 ms / 100 ms / 135 ms | 0.65 to 1.2 s |
| ON | 3 ms / 150 to 430 ms / 450 to 550 ms / 555 to 570 ms | 12.1 to 17.5 s |

The serving loop's counters and timing rows around those phases say where the
ON time goes:

- **Three to five waves per single vote, nearly all cut by the deadline.** A
  single vote moved `waves` by 3 to 5 and `wavesBudgetExhausted` by the same;
  the 25-vote burst took 78 waves, 76 of them at the 100 ms flush deadline.
  `executor/wave/settle` averaged 103 to 128 ms per wave: the settle runs to
  the deadline, commits what it has, and the next cycle continues.
- **The serving runtime adds watches per vote, through its loopback session.**
  Every single vote added 9 to 14 watches (`watchRefresh/watchAddSync`, 22 to
  30 ms each, 200 to 300 ms of the vote); the burst added 35 at 29 ms each.
  `storeReads` stayed at 0: the serving runtime reads its own store through
  the same subscription machinery a browser uses, and each document it reaches
  for the first time is a schema-narrowed watch round trip over the loopback.
- **The derivations themselves are the largest share.** The burst spent 7.1 s
  in `scheduler/run` over 672 runs (10.6 ms each) and 4.3 s in 1961 actions;
  `scheduler/run/resubscribe` ran 2633 times.
- **Demand grows with every vote.** `demandedInstances` rose by 40 to 56 per
  single vote and stood at 2105 after one 5x5 burst, with `pushGrowthWakes`
  rising by 10 to 16 per vote: a new vote is a new element, and every
  session's instance of the derivations over it is demanded.

What the per-vote cost scales with is the number of connected sessions, not
the number of votes. The same probe at other shapes, ON, burst wall time
divided by votes:

| sessions x options | votes per burst | burst | per vote |
| --- | --- | --- | --- |
| 1 x 5 | 5 | 0.79 to 0.96 s | 160 to 190 ms |
| 2 x 5 | 10 | 2.1 to 2.35 s | 210 to 235 ms |
| 5 x 1 | 5 | 1.9 to 2.4 s | 380 to 480 ms |
| 5 x 5 | 25 | 12.1 to 17.5 s | 480 to 700 ms |

Five votes from one session cost 0.8 s; the same five votes from five sessions
cost 2.4 s. The lunch poll's view reads session-scoped and user-scoped state
(`Writable.perSession` confirmation flags, the viewer's `#profile` wish), so
every derivation downstream of those narrows to session scope, and the serving
runtime runs one instance of each per demanding session (scopes.md §2). A vote
dirties the vote list, and the serving loop re-runs every session's instance of
every demanded derivation that reads it, on one thread. The OFF arm does the
same work per client, in parallel, in that client's own worker. There is no
conflict storm in either arm: the vote is a keyed write, and no commit was
rejected or rolled back in any run.

## What main's CI actually failed on

The revert of #8660 (#8673) names two lanes. The job logs of two of the red
runs (46cb908, the commit that landed #8660, and 5581e98d three commits later)
say:

- `fabrichat spaces across runtimes` passed in every run of every lane that
  ran it: twice in lane 3 of 46cb908, and in lanes 1, 3, 5, 6, 13 and 16 of
  5581e98d. The three fabrichat identities listed under lane 3's summary
  appear under "identities no record accounts for", a test-selection manifest
  bookkeeping line, not a failure.
- The server-execution lane's one failure was `Home catalog revisions across
  execution modes > keeps an old revision stale when an invocation ID is
  admitted again`, in run 2 of 6 and in no other run: the receipt of an
  invocation reused on the serving runtime read as `{}`. That test sends
  through `sendEvent` with a commit callback and reads the receipt with
  `receipt.pull()`; it does not go through `PieceController.set()`, so #8660
  did not change what it waited for, and a send that waits for its consequence
  does not reach it either.
- The default lane's failure was real and the seed's: `Topics board demo`
  timed out following a backlink, because the seed no longer derived each
  topic's published `mentions`, and with client execution the seed's runtime
  is the only runtime that could.

So the wait that #8660's re-landing branch added to a stream send (returning
once the overlay saw the event's terminal consequence) answered a failure that
the logs do not show, and it cost the seed one server round trip per send:
three per topic.

## The change

- A stream send through `PieceController.set()` returns once the event is
  committed and this runtime's speculative run is idle; it does not wait for
  the serving runtime. Under server execution the event is the client's whole
  contribution.
- `PieceController.get()` waits for every event this runtime fired to reach
  its terminal consequence before reading, so a caller that sent and then
  reads sees what the served run stored. `piece-controller-served-send.test.ts`
  pins both halves.
- `cf get` waits, under server execution, until the serving runtime has
  reacted to every authored commit at or below the server's head as of the
  read, through a new `serverHeadSeq()` on the storage provider (the ordered
  round trip `pullToServerHead()` already made, now returning the sequence it
  learns) and `waitForSettledThroughHead`, which treats a head that is the
  loop's own watermark write as covered: the loop keeps its bookkeeping
  commits above W, so on a quiet space W rests one or more below the head and
  a wait on `W ≥ head` alone would never resolve. A `cf get` in a fresh
  process after a `cf set` or `cf call` in another therefore reads what the
  serving runtime stored.
- `Runtime.trackEventIntent()` installs the overlay when a fire is the first
  thing a runtime does. Tracking went through the lazily created overlay
  before, so a runtime whose first act was a send counted no intent, and a
  wait for intent quiescence had nothing to wait for.
- The Topics seed, under server execution, reads no topic result and no
  crossref table: the serving runtime derives those when a reader demands
  them. It waits once at the end for every event it sent to be consequenced.
  Under client execution it keeps deriving each topic's result and the
  board's crossref table, because nothing else runs them.

## The Topics seed, before and after

`--topics=N --demand=index --crossrefs=2 --citing-topics=3 --body-words=120`,
wall time of the whole seed process against a fresh toolshed. "main" is
28272ec, which carries the revert of #8660.

| seed | main OFF | branch OFF | main ON | branch ON |
| --- | --- | --- | --- | --- |
| 30 topics | 45.1 s | 27.3 s | 61.8 s | 59.5 s |
| 100 topics | 235.4 s | 81.8 s | 342.2 s | 322.9 s |

With client execution the change is the 2.9x at 100 topics #8660 bought
before: a send no longer pulls the whole result root. Under server execution
the seed is 4% faster at 30 topics and 6% at 100, which is the surprise this
section is about: the client stopped waiting on the serving runtime, and the
seed barely moved.

A probe that mirrors the seed loop and times each step says where the time
went. ON, 30 topics, nothing else on the box: setup 21.9 s, the loop 36.6 s,
of which the `addTopic` sends were 35.5 s, the index-row waits 0.1 s, the
six mention sends 0.9 s, and the one wait at the end 0.2 s. So the row wait
is answered from speculation, the end wait finds nothing outstanding, and the
whole loop is the send itself: 0.7 s per topic at the start, rising to 1.9 s
by the thirtieth, with `pendingIntentCount` 0 the moment each send returned.

Splitting the send into its three steps (15 topics, both arms, taken with a
type check running on the same box, so the absolute numbers are inflated and
the ratio is the reading):

| step of one `addTopic` send | OFF | ON |
| --- | --- | --- |
| `editWithRetry` (the event is queued) | 1 to 2 ms | 1 to 5 ms |
| `runtime.idle()` (the speculative handler run) | 260 to 400 ms | 330 to 720 ms |
| `synced()` (the append acknowledged) | 130 to 320 ms | 250 to 650 ms |
| whole send | 440 to 670 ms | 690 to 1020 ms |

The client's timing rows over those runs name the difference: 124 watch adds
at 53 ms each OFF, 107 at 263 ms each ON (28.9 s of a 43.5 s run); the
handler's speculative run 116 ms OFF against 147 ms ON. The client's own work
is the same in both arms. What grows under server execution is every round
trip to the toolshed: a schema watch and a commit acknowledgment each wait
behind the serving loop, which runs in the same process on the same thread
and, for this seed, is never idle (247 waves for 30 topics, 185 of them cut by
the 100 ms deadline). The seed is paced by the server after all, not through
a wait the client chose but through the latency of every message it sends.

The other half of a 30-topic ON run is its first 22 to 27 s, before the first
topic: `executor/wave/root-ensure` ran 4 times at 6.7 s each on the serving
side, and the seed's own client spent 20.6 s in
`ensureDefaultPattern.compilePattern` (two `compileToRecordGraph` calls at
11.5 s, 14.2 s of it reading the compile cache). The OFF arm's setup was 13 s
on the same box. Neither is per topic, and together they are 45% of the
30-topic ON run.

## What the architecture promises, against what the loop does

The spec's claim is that one committing runtime per space is the fast design
for multiplayer (server-side-execution/README.md §1). Four things in the
measurements above stand between the loop and that claim, in the order they
cost:

1. **Every session's view is derived on the server.** A view that reads
   session- or user-scoped state fans out per session by design, and demand
   is what a wave has to make current before W advances. So a vote one view
   needs re-derives N views on one thread. The levers are, in order: keeping
   session-scoped derivations that only feed rendering out of the serving
   runtime's demand, so the server derives the shared tally once and each
   client derives its own view as it does today; failing that, patterns that
   read session state as late as possible, so the fan-out starts below the
   expensive derivations rather than at the top of the view.
2. **The serving runtime reads through a loopback subscription.** 22 to 30 ms
   per newly reached document, 9 to 14 of them per vote. The store
   read-through posture (`SERVER_EXECUTION_STORE_READ_THROUGH`) is the path
   that reads the engine directly; it is off by default and
   `MultiRuntimeHarness` has no way to turn it on, so the probe above could not
   measure it. Giving the harness that knob and re-running the 5x5 probe is
   the next measurement.
3. **The serving loop shares its thread with the memory server.** While a
   wave derives, every client round trip to that toolshed waits: the seed's
   watch adds went from 53 ms to 263 ms and its commit acknowledgments from
   130 to 320 ms to 250 to 650 ms. A client that waits on nothing the server
   computes is still paced by the server through the latency of each
   message. Moving the serving loop off the request thread, or bounding how
   long a wave holds it, is what makes a fire-and-forget send cost what a
   send costs.
4. **Waves are deadline-cut, not quiescence-bound.** 76 of 78 burst waves hit
   the 100 ms deadline, each paying a commit, a publish and a refresh pass.
   The earlier record measured the deadline's share at 15 to 20% of a burst;
   it is the smallest of the four.

## How the numbers were taken

- **Vote probe:** a scratch script over `MultiRuntimeHarness` and the
  `lunch-poll-keyed-votes` fixture, sessions and options from the environment,
  `EXPERIMENTAL_SERVER_EXECUTION` selecting the arm. Per phase it timed the
  four points above and differenced `getServingLoopStats()` and
  `getTimingStatsBreakdown()` from the test process, which hosts the serving
  loop.
- **CI logs:** the workflow run archives of 38054135567 (46cb908) and
  38062478969 (5581e98d), every `Tests (n/25)` job's log read for test
  outcomes and `ERRORS` blocks.
- **Topics seed:** `topic-board-seed.ts` against a toolshed started from the
  measured commit with `MEMORY_DIR` on a fresh directory and
  `EXPERIMENTAL_SERVER_EXECUTION` set for both processes, timed end to end
  around the seed process, one run per cell, OFF then ON, main then branch.
- **Seed phases:** a scratch script that mirrors `seedTopicBoard` step for
  step against the same kind of toolshed, timing each step per topic; with
  `DECOMPOSE=1` it makes the `addTopic` send as its three calls
  (`editWithRetry`, `runtime.idle()`, `synced()`) and times each, and at the
  end prints the client's `getTimingStatsBreakdown()` rows and the serving
  loop's counters from `/api/health/stats`.
