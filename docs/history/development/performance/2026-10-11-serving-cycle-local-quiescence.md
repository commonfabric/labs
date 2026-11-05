---
status: historical
created: 2026-10-11
archived: 2026-10-11
reason: "Point-in-time record of what the five stages of the serving-cycle plan measured on the vote burst and the Topics seed, what each stage moved, and where the burst's remaining order of magnitude over the client arm sits."
---

# The serving cycle without server round trips: what the stages moved, and what they did not

All figures come from one 4-core container. The code is the branch of
[commonfabric/labs#8691](https://github.com/commonfabric/labs/pull/8691) at
each stage of
[`docs/history/plans/serving-cycle-local-quiescence.md`](../../plans/serving-cycle-local-quiescence.md),
which this record closes. "OFF" is server execution off; "main" is the serving
loop on the toolshed's main thread; "worker" is the loop in a Web Worker under
`SERVER_EXECUTION_WORKER=true`; "read-through" is the store read-through
posture under `SERVER_EXECUTION_STORE_READ_THROUGH=true`. The vote probe hosts
its own memory server and serving loop in the test process through
`MultiRuntimeHarness`; the Topics seed runs `topic-board-seed.ts` against a
fresh toolshed. The last section says how each number was taken and which runs
shared the box with a type check.

## What the plan set out to move

[The worker record](2026-10-11-serving-loop-in-a-worker.md) left the 25-vote
burst at 9.0 s under the worker against 408 ms with the loop off, and put a
wave's settle at about 100 ms on either thread with the burst tens of waves.
The plan read the cycle as paced by three round trips to the memory server —
the settle's `Server.idle()`, the demand pass's re-read of every session's
rows, and the post-commit publish and outbox drain ahead of the next cycle —
and set out to take each off the cycle's critical path, measure, and then pick
a cadence.

## Where a cycle's time went before the change

Stage 1 gave each phase of the cycle a timing row. On the 30-topic seed under
the worker, before any other stage:

| row | count | p50 | total |
| --- | --- | --- | --- |
| `storage.v2:watchRefresh/watchAddSync` (the serving runtime's own loads) | 286 | 54 ms | 48.5 s |
| `executor/wave/demand-pass` | 88 | 63 ms | 12.5 s |
| `executor/wave/commit` | 74 | 113 ms | 11.9 s |
| `executor/wave/publish` | 93 | 90 ms | 8.9 s |
| `executor/wave/settle-server-idle` | 95 | 122 ms | 10.4 s |
| `executor/wave/settle-input-barrier` | 95 | 2 ms | — |

On the main thread the same seed's settle waited 0.2 ms at the server's idle
and 0.2 ms at the input barrier: the plan's premise that the server-wide idle
paces the settle held only under the worker, where the idle is a port round
trip to a busy main thread. What the main thread spent its settles on was the
serving runtime's own loads, 743 watch adds at a 24 ms median, 39.6 s in all.

## The vote burst, stage by stage

Five voters, five options, the burst measured from the first send to every
session settled. The serving side's line is one burst's loop cost as the
benchmark now prints it: how many waves the burst took, how many of its
settles the 100 ms deadline cut, and the average of each phase.

| arm and stage | burst, avg | waves (cut) | cycle | settle | commit | demand | publish | scheduler settle per event |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OFF | 408 ms | — | — | — | — | — | — | — |
| worker, stage 2, no read-through | 13.4 s | 34 (35) | 357 ms | 124 ms | 147 ms | 25 ms | 66 ms | — |
| worker, stage 2, read-through | 11.2 s | 38 (36) | 258 ms | 119 ms | 84 ms | 0.5 ms | 52 ms | 173 ms |
| worker, stage 3, read-through | 11.6 s | 40 (40) | 259 ms | 112 ms | 85 ms | 0.5 ms | 62 ms | 208 ms |
| worker, stage 4, read-through | 11.8 s | 48 (47) | 195 ms | 110 ms | 86 ms | 12 ms | 32 ms, off the path | 156 ms |
| main, stage 2, read-through | 14.4 s | 89 (88) | 145 ms | 124 ms | 16 ms | 0.1 ms | 0.1 ms | 239 ms |
| main, stage 3, read-through | 15.0 s | 107 (106) | 151 ms | 129 ms | 17 ms | 0.1 ms | 0.2 ms | 302 ms |
| main, stage 4, read-through | 15.0 s | 93 (92) | 154 ms | 131 ms | 18 ms | 0.1 ms | 0.1 ms | 267 ms |

Three things the table says.

**The read-through is what removed the loads.** Without it the serving
runtime's own loads cost 24 watch adds of 224 ms per burst, with a schema walk
over the poll document of 100 to 340 ms behind each; with it they are gone and
the demand pass, which issued them, fell from 25 ms to under a millisecond.
That is the one change in the table that moved the burst, from 13.4 s to
11.2 s.

**Stages 3 and 4 moved the cycle, not the burst, and stage 4 cost
coverage.** Taking the server's idle out of the settle and the publish and
drain off the path brought a worker cycle's average from 258 ms to 195 ms.
The wave count rose with it, from 38 to 48: a cycle that ends sooner starts
the next one sooner, and every settle still ends at the deadline. The burst
stayed where it was. Stage 4 also left the watermark behind: 69 commits
behind the head after a burst under the worker, and 149 behind after the
seed, where every other arm ends one behind. The loads the publish kicks and
the appends the drain commits land while the next settle runs, so the
settle's input barrier waits on the loop's own post-commit work, every
settle reaches the deadline, no probe completes, and no cycle proves
coverage; the seed, whose clients wait on coverage, went from 64 s to 87 s.
Either piece alone did the same (167 and 128 behind). The change was
reverted, and the publish and the drain stay inside the cycle, after the
commit. The burst's own lag figure does not separate the two, and it shows
something else: on the main thread the watermark sits one commit behind the
head both before a burst and when its last vote is verified, while under the
worker it sits 246 behind before and 328 behind after on the final code, and
253 and 312 on the stage 2 code, before the settle changed. The worker's loop
does not cover the benchmark's bursts even in the quiet between them, which
predates these stages, belongs to the worker arm rather than to the cycle
(the seed under the worker ends one behind), and goes on the list the
worker record keeps of what still differs under it. The burst's clients do
not wait on coverage, so the figure costs the burst nothing; the seed, whose
clients do wait, is where stage 4's loss showed.

**What cuts every settle is the scheduler's own work.** The `scheduler
settle per event` column is `scheduler/execute/settle`, the derivations the
scheduler runs after each vote's handler: 150 to 300 ms per vote, against a
7 ms handler and a 100 ms deadline. Over a burst the loop's realm ran about
1,900 action runs and 650 scheduler passes for 25 votes, 2.3 ms an action and
11 to 14 ms a pass, of which the re-subscription of each action's reads alone
was 2,600 calls. The client arm serves the same 25 votes in 408 ms across five
runtimes. The order of magnitude is in what a vote re-derives on the serving
side, not in how the loop waits for it or commits it.

## The cadence

The flush deadline is the cadence: a settle ends at quiescence or at the
deadline, and under this burst at the deadline. Under the worker with the
read-through on, stage 4 reverted:

| deadline | burst, avg | waves (cut) | cycle | settle | commit | watermark after |
| --- | --- | --- | --- | --- | --- | --- |
| 100 ms (the default) | 11.6 s | 40 (40) | 259 ms | 112 ms | 85 ms | — |
| 300 ms | 11.5 s | 30 (28) | 358 ms | 252 ms | 111 ms | 1 behind |
| 1000 ms | 15.8 s | 11 (9) | 781 ms | 647 ms | 178 ms | 1 behind |

A longer deadline buys fewer, larger waves and nothing on the burst's time;
at a second it costs the burst a third, since each voter's confirmation
waits for a wave to close. The default stays. The coalescing window the plan
named as the knob, a wait between a feed arrival and the cycle it starts, was
not built: the cycle is already paced by the deadline, not by its own
overhead.

## The Topics seed

Thirty topics, two cross-references each, three citing topics, 120-word
bodies, the index demanded, against a toolshed started fresh for each run.

| arm | seed loop, stage 1 | stage 2 | stage 4, reverted | stage 3, the final code |
| --- | --- | --- | --- | --- |
| main | 72.0 s | 73.1 s | 76.4 s | 81.4 s |
| worker | 38.1 s | 48.8 s | 31.8 s, 149 behind | 37.3 s |
| main, read-through | — | 60.9 s | 59.0 s | 59.5 s |
| worker, read-through | — | 31.3 s | 32.9 s, 146 behind | 31.1 s |

The seed is a client paced by the server's latency, and under the worker it
sits near the client's own floor; the stages do not move it, and the spread
between runs of one arm is the box. What the read-through takes off it is
the serving runtime's loads, the 48.5 s of watch adds above. Every run
except the two stage 4 worker runs ends with the watermark one behind the
head; those two are the regression the previous section describes, and the
stage 4 worktree seeds that found it ran 64 s at stage 3 against 87 s at
stage 4.

## Where this leaves the plan's question

The plan said that if the burst stayed an order of magnitude above the client
arm after the five stages, the two-tier write-class split
`serving-loop.md` §3 records as the fallback would be the next design. The
burst stayed there, but the table does not point at the split: a wave's commit
is 86 ms of a 195 ms cycle under the worker and 18 ms of 154 ms on the main
thread, and splitting it into two commits would add a commit, not remove
derivations. What the numbers point at is the serving runtime's derivation
volume per input. Three questions come before any design:

- what the 1,900 action runs per burst are — how many runs one vote causes,
  and whether the serving runtime re-derives the poll once per viewing
  session where a client derives it once;
- why a scheduler pass costs 11 to 14 ms and re-subscribes 2,600 reads per
  burst, when the client arm's runtimes serve the burst in under half a second
  in all;
- what the 100 to 340 ms schema walks over the poll document are, which the
  read-through moved off the loads and the derivations still pay.

Each is a measurement on the scheduler rows the benchmark now prints, not on
the loop, and the stage 1 rows stay in place for it.

## How the numbers were taken

Vote burst: `CF_LUNCH_POLL_VOTERS=5 CF_LUNCH_POLL_OPTIONS=5 deno bench -A
--no-check integration/lunch-poll-vote-burst.bench.ts` in
`packages/patterns`, with `EXPERIMENTAL_SERVER_EXECUTION`,
`SERVER_EXECUTION_WORKER`, `SERVER_EXECUTION_STORE_READ_THROUGH` and
`SERVER_EXECUTION_FLUSH_DEADLINE_MS` set per arm. The serving side's line is
the one the benchmark prints to stderr before its measured iterations, from
the loop realm's stats and timing rows read before and after one burst; under
the worker those rows are the loop's alone, on the main thread the scheduler
rows count the five voters' runtimes as well, which is why the main-thread
rows in the table are the loop's phases only. The stage 2 worker run without
the read-through, both stage 3 runs and both stage 4 runs shared the box with
a workspace type check or a test suite, which is where the spread between
11.2 s and 11.8 s comes from; the cadence and OFF runs had the box alone.

Topics seed: `topic-board-seed.ts --topics=30 --demand=index --crossrefs=2
--citing-topics=3 --body-words=120` against a toolshed started from source
with the posture's variables set, the serving loop's counters and the loop
realm's timing rows read from `/api/health/stats` before and after. The
stage 1 and stage 2 seeds ran beside a test suite; the stage 3 seeds, and
the stage 4 seeds against worktrees of that commit and its two halves, had
the box alone, as did the final-code seeds.
