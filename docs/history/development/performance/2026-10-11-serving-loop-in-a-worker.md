---
status: historical
created: 2026-10-11
archived: 2026-10-11
reason: "Point-in-time record of what the serving loop costs with the loop in a worker of the toolshed process against the loop on its main thread, the wave basis race the move exposed, and what still differs under the worker."
---

# The serving loop in a worker: what the thread bought, and what moving it exposed

All figures come from one 4-core container with nothing else on the box. "OFF"
is server execution off; "ON, main" is the serving loop on the toolshed's
main thread, which is the default; "ON, worker" is the loop in a Web Worker of
the same process under `SERVER_EXECUTION_WORKER=true`, as
[`docs/plans/serving-loop-worker.md`](../../../plans/serving-loop-worker.md)
builds it. The vote probe hosts its own memory server and serving loop in the
test process through `MultiRuntimeHarness`; the Topics seed runs
`topic-board-seed.ts` against a fresh toolshed. The last section says how each
number was taken.

## The vote burst

`lunch-poll-vote-burst.bench.ts` at five voters and five options: twenty-five
votes fired before any settles, the burst measured from the first send to every
session settled, after two warm-up bursts whose vote distributions are checked.

| arm | 25-vote burst, avg | min … max | p75 |
| --- | --- | --- | --- |
| OFF | 408 ms | 305 … 485 ms | 452 ms |
| ON, main | 12.2 s | 10.8 … 14.6 s | 12.4 s |
| ON, worker | 9.0 s | 7.9 … 10.4 s | 10.1 s |

Every arm's accounting burst cost zero rejected commits and zero rolled-back
writes across the five sessions. The worker takes about a quarter off the
burst. What remains is the loop's own work, not the thread it runs on: the
wave timing rows below put a wave's settle at about 100 ms on either thread,
and the burst is tens of waves.

## The Topics seed

Thirty topics, two cross-references each, three citing topics, 120-word
bodies, the index demanded, against a toolshed started fresh for each run. The
seed loop is the time the script reports for its thirty topics.

| arm | seed loop | runs |
| --- | --- | --- |
| ON, main | 59.5 s, 57.1 s, 66.6 s | 3 |
| ON, worker, before the basis fix | 27.7 s, 28.2 s | 2 |
| ON, worker, after the basis fix | 29.8 s | 1 |

The seed is a client paced by the server through the latency of each message
([the earlier record](2026-10-11-server-execution-send-wait-and-session-fan-out.md)
measured a watch add at 263 ms with the loop on the request thread against
53 ms without it), and with the loop off that thread the client's half of the
seed halves. The serving loop's counters for the same runs, read from
`/api/health/stats` after each:

| counter | ON, main | ON, worker, before the fix | ON, worker, after the fix |
| --- | --- | --- | --- |
| `waves` / `derivedCommits` | 261 / 261, 253 / 253 | 106 / 106, 90 / 89 | 70 / 70 |
| `supersededWrites` | 0 | 1089, 1009 | 0 |
| `events.dropped` | 0 | 6, 6 | 4 |
| `events.loadParkDeferrals` | 0 | 40, 40 | 38 |
| `events.drainInFlightSkips` | 5 | 1222, 913 | 684 |
| `watermarkLag` at the end | 1 | 149, 132 | 1 |
| `structureLoadDeferred` | 0 | 138 | 219 |
| `executor/wave/settle` p50 / p95 | 99.5 / 211 ms | 121 / 263 ms | 133 / 278 ms |
| `executor/wave/cycle` p50 / p95 | 113 / 245 ms | 264 / 540 ms | 329 / 542 ms |

The middle column is the loop before the fix below: a thousand superseded
writes, six dropped events and a watermark 149 commits behind are not a loop
that is working, and the seed finishing faster says only that the client was
no longer waiting on it. With the fix the superseded writes and the watermark
lag are gone and the seed loop keeps its time, while the structure-load
deferrals, the load-park deferrals of served events and the drain skips
remain: the home runtime's structure loads find no pattern metadata where the
main thread's find it, which is the same difference the next section
describes, and each deferral costs a later wave. A wave's settle sits near
100 ms on either thread; a cycle under the worker takes about three times
the main thread's, which is the port round trips of its commit and its
server requests.

## The wave basis race

A wave takes its basis, the server sequence the store stands at, when a seal
opens it, and treats a document whose head has passed that basis as
conflicting: a pure derivation's write to it is superseded, the loop's
bookkeeping drops whole, an event handler's requeues. On the main thread a
wave's commit applies synchronously inside `commitWave`, so the next wave
opens at or after the commit's sequence. In the worker the commit crosses the
port and is in flight for a round trip, and the serving runtime's scheduler
keeps sealing through it: the next wave opened with a basis the in-flight
commit was about to pass, and every document that commit wrote conflicted for
it. The list builtins' resume seeds dropped wave after wave, the derivations
reading them were withdrawn with them (233 to 244 `contribution-dropped`
warnings per vote run against two on the main thread), and a voter's replica
read an empty vote list.

The fix notes each landed home commit to the wave open at the time
(`WaveAccumulator.noteOwnWaveCommit`, called by `SpaceServer` as
`commitWave` returns), and the wave rebases a write to a document sitting
exactly at that commit's sequence to that head, which the sink re-verifies in
its transaction, in place of the conflict. The wave's contributions read the
replica with the commit's writes applied, since a run that read them stale is
refused at its own commit and never seals, so the rebase claims nothing they
did not see. `serving-loop.md` §3d carries the rule. After it the vote burst
under the worker ran with zero dropped contributions and passed its
distribution checks, and the private-inbox test's dropped contributions went
from 125 to 2.

## What still differs under the worker

The private-inbox test, whose pieces span several spaces, fails or stalls under
the worker and passes on the main thread. Its home space's serving runtime
logged 296 `foreign-write-refused` seals from `map` runs writing other spaces,
122 `sync-load-failure`s refusing foreign scoped reads on the serving path, and
source-reconcile and compile-cache writeback failures, where the same test on
the main thread logs none of them; an offer the test sends is refused twice
where the main thread accepts it. The refusals themselves are the designed
fail-closed shape for a serving runtime reaching into a space it does not
serve. What differs is that the home runtime reaches at all: the evidence
points at it materializing a foreign space's derivations itself while that
space's own loop lags behind it, which the main thread's ordering never let
happen. The cause is not pinned, and the plan's stage 4 carries it as the open
exception. The other twenty multi-runtime pattern tests pass under the worker, as do the
runner's executor suites on both postures, the toolshed's and the piece
package's suites, and the memory engine's.

Two counters move for a reason other than the loop. `push.prioritizedSessions`
reads 30 on the main thread and 1 under the worker over a seed; it is the
memory server's own counter, so the difference is in how often a flush found
derived rows and other sessions together, not in the relay. The loop's logger
counts and timing rows are the worker realm's and reach the health route as
`servingLoopRealm`.

## Watch-add latency

The seed phases probe, fifteen topics with the `addTopic` send decomposed,
against a fresh toolshed under each posture, with the client's timing rows
read at the end. The row is `memory.v2.client:watchAdd/request`, the client's
wait for the server to answer a schema watch add; the earlier record measured
the same row at 53 ms with the loop absent.

| arm | watch adds | per add | setup | 15-topic loop | total |
| --- | --- | --- | --- | --- | --- |
| ON, main | 107 | 264 ms | 26.0 s | 15.0 s | 41.2 s |
| ON, worker | 100 | 66 ms | 10.3 s | 8.8 s | 28.0 s |

This is the number the move was made for. A watch add on the main thread
waits behind whatever wave the loop is settling, and costs five times what it
costs with the loop absent; with the loop in a worker it costs 66 ms, within
15 ms of the loop-absent figure, and the probe's setup and seed loop, which are
paced by those round trips, run in less than half the time. The `synced` share
of each `addTopic` send fell from 7.6 s over the fifteen topics to 1.9 s; the
`idle` share, the client's own runtime, did not move.

## How the numbers were taken

- **Vote burst:** `deno bench` over `lunch-poll-vote-burst.bench.ts` from
  `packages/patterns` with `CF_LUNCH_POLL_VOTERS=5 CF_LUNCH_POLL_OPTIONS=5`,
  `EXPERIMENTAL_SERVER_EXECUTION` and `SERVER_EXECUTION_WORKER` selecting the
  arm, one run per arm, and the harness's own refusal accounting.
- **Topics seed:** `topic-board-seed.ts` against a toolshed started from
  `packages/toolshed` with `MEMORY_DIR` on a fresh directory and both
  variables set for both processes, `/api/health/stats` read before and after,
  timed end to end around the seed process.
- **Seed phases:** a scratch script mirroring `seedTopicBoard` step for step,
  fifteen topics with `DECOMPOSE=1`, against a toolshed started the way the
  seed's was, that prints the client's `getTimingStatsBreakdown()` rows at the
  end; the watch-add row above is its `memory.v2.client:watchAdd/request` line
  and the `synced` and `idle` shares are its per-send decomposition.
- **Drops and refusals:** counts of the named logger lines in each run's
  output.
