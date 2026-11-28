---
status: historical
created: 2026-09-09
archived: 2026-09-09
reason: "Measurement record: the topics benchmarks with server execution ON against OFF at f7f942ad42 and at 3cdf2ab489 (#7193), the serving loop's own account of where the ON time goes, four single-mechanism ablations, and the improvements they point at. Of those, §5's second — the incremental `session.watch.add` — shipped as #7251; the first is open, and a 2026-09-18 re-measurement found it still the dominant ON term."
---

# Server execution ON against OFF on the topics benchmarks (2026-09-09)

The question: with `serverExecution` on, what does the topics workload cost
against the OFF arm, which part of the serving loop the difference sits in,
and what would move it. The August record
([topics-measure-report-2026-08-24.md](../../plans/server-execution-v2/optimize/topics-measure-report-2026-08-24.md))
answered the first half at tip `2ea87cea9`; this one repeats the measurement
at today's tip and spends most of its length on the second half.

The short answer. Two segments of the canonical board benchmark carry the
whole ON penalty at 30 topics: seeding the board (one `addTopic` per topic,
1.5 to 1.8 times OFF) and the cold render of the board's cards (1.6 to 1.8
times OFF). Opening a topic and following a crossref are at parity, which
they were not in August. At 100 topics the seed is 2.5 times OFF and the
cold load 1.6 times. The serving loop's counters and a CPU profile put the
cost in one place: the serving runtime's own watch-adds against the memory
server it is co-hosted with. They run inside the demand pass, the demand
pass runs under the wave's flush deadline, and each add costs the memory
server a walk over everything the serving session already tracks, so the
number of adds and the cost of each both grow with the board.

## 1. Method

**Binaries.** Two compiled toolsheds per tip, built by
`deno task build-binaries toolshed` from a clean worktree with
`EXPERIMENTAL_SERVER_EXECUTION` unset (OFF: `/api/meta` reports
`shellServerExecutionDefine: null`) and set to `true` (ON: define `"true"`).
Two tips: `f7f942ad42` (#7205) and `3cdf2ab489` (#7193, one commit later,
which changes what a query delivers and was merged while this ran).

**Per run.** A fresh working directory, so a fresh store. The binary started
with `--background --port=8047` and `EXPERIMENTAL_SERVER_EXECUTION=true`
for the ON arm only; `API_URL` and `MEMORY_URL` pointed at its own port.
Posture probed before the workload from `/api/meta` and
`/api/health/stats` and refused on a mismatch; every run below probed as
its arm. Stats captured before and after; the server killed by pid. The
workload ran from the repository root with `HEADLESS=1`, a run-specific
`SPACE_NAME`, `CF_LOG_LEVEL=silent`, and the same flag as the server, so
the seeding client and the serving toolshed were on one arm. No LLM key
was configured; the topics pattern makes no model call.

**Workloads.** `packages/patterns/integration/topic-board-navigation.bench.ts`
at its default 30 topics (5 measured iterations per segment after one
warm-up), `topic-board-scale.bench.ts` at its 100-topic ceiling, and the
board seed on its own under a CPU profile. `lunch-poll-vote-burst.bench.ts`
was not run: on the ON arm its harness targets a toolshed and on the OFF
arm an in-process store, so the two arms would not be the same
measurement.

**Machine and load.** Apple M3 Max, 16 cores, 128 GB, Deno 2.9.4. The box
was shared. Six `python -c 'while True: pass'` processes had been running
for twelve days and held the one-minute load near 11 for the whole
session, and another session's runner test suite drove it to 117 for a
stretch. The load before each run is recorded beside it below. Arms ran
adjacent within a pair with the order alternated across pairs. The v2
testing rule of quoting no latency above load 5 could not be met on this
box; the counters, which are load-insensitive, carry the attribution, and
the timings are read for their ratios within a pair.

## 2. Results

### 2a. The board benchmark, 30 topics

Milliseconds, average of the 6 iterations `deno bench` reports; the seed
is the harness's own timing of building the board, one `addTopic` and its
citations per topic. Load is the one-minute average at the start of the
run.

Tip `f7f942ad42`, before #7193:

| pair | arm | load | seed | board | open topic | crossref | journey |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | OFF | 11.9 | 25 069 | 1 060 | 337 | 280 | 2 565 |
| 1 | ON | 12.3 | 39 312 | 1 645 | 306 | 293 | 3 431 |
| 2 | ON | 17.0 | 39 659 | 1 653 | 341 | 281 | 3 600 |
| 2 | OFF | 13.3 | 29 101 | 1 194 | 427 | 300 | 2 565 |

Tip `3cdf2ab489`, with #7193:

| pair | arm | load | seed | board | open topic | crossref | journey |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | OFF | 13.8 | 25 302 | 976 | 395 | 265 | 2 508 |
| 1 | ON | 15.7 | 44 659 | 1 740 | 355 | 276 | 3 806 |
| 2 | ON | 19.6 | 45 204 | 1 745 | 354 | 259 | 4 645 |
| 2 | OFF | 24.1 | 46 772 | 1 547 | 436 | 386 | 3 403 |
| 3 | OFF | 36.6 | 32 170 | 818 | 270 | 247 | 2 423 |
| 3 | ON | 70.3 | 36 101 | 1 205 | 305 | 230 | 2 951 |

Pairs 2 and 3 at the second tip ran inside the sibling suite's load spike
(the OFF seed of pair 2 doubled with no code change, and pair 3's OFF run
took 973 s of wall clock for its 151 s of work) and are listed for
completeness, not read. The `load` and `sign in` segments are at parity in
every pair and are left out of the tables.

What the readable pairs say. The seed is 1.45 to 1.76 times OFF and the
board segment 1.4 to 1.8 times; open-topic and crossref are at parity or
faster under ON; the journey is 1.35 to 1.5 times. #7193 moved nothing
that the load did not also move: its OFF numbers match the earlier tip's,
and its one clean ON pair is inside the earlier tip's spread on the board
segment and above it on the seed, where the load was also higher. The ON
penalty is entirely in the two segments where the server has derivation
work to do before the client can proceed — a create, and a cold session's
first demand — and absent from the two where it has none.

### 2b. The scale benchmark, 100 topics

One pair, tip `3cdf2ab489`, ON first, both inside the load spike (34 at the
OFF start, 22 to 49 during ON).

| arm | seed | cold load, 4 iterations avg (min–max) |
| --- | --- | --- |
| ON | 565 056 | 5 388 (4 301–6 424) |
| OFF | 222 859 | 3 429 (2 831–4 424) |

The seed ratio grew from 1.6 at 30 topics to 2.5 at 100, and §3 shows the
shape behind that: the server fell behind the seeding client from about
the 25th topic on and did not catch up until the seed stopped writing.

### 2c. What the seeding client waits for

Under ON a verb send appends the event and then awaits its own pull and a
durability sync (`packages/piece/src/ops/piece-controller.ts`, `edit`), and
the harness then pulls the board's `topics` key for the new piece. So each
topic's seed time is the server round trip: append admitted, event drained
and run in a wave, the new topic piece demanded and loaded, its
derivations committed, the frame pushed. Nothing in the seed is echo-timed.

## 3. Where the ON time goes

All numbers here are the serving toolshed's own, from `/api/health/stats`
differenced across a run (only `count` and `totalTime` subtract), the
`servingLoop` block, and the server log. "The serving session" is the
loopback session the serving runtime holds against the co-hosted memory
server.

### 3a. Counters, whole runs

| run | waves | budget exhausted | authored | derived commits | events | demand passes | demand pass ms | terminal loads | view-lag deferrals | compiles |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nav pair 1 ON, `f7f942ad42` | 351 | 314 | 45 | 351 | 37 | 798 | 19 293 | 519 | 22 | 30 |
| nav pair 2 ON, `f7f942ad42` | 349 | 329 | 44 | 349 | 37 | 827 | 20 969 | 514 | 17 | 30 |
| nav pair 1 ON, `3cdf2ab489` | 383 | 326 | 43 | 383 | 36 | 812 | 20 866 | 529 | 21 | 30 |
| scale ON, `3cdf2ab489` | 1 007 | 2 614 | 107 | 1 007 | 100 | 1 726 | 405 544 | 2 275 | 38 | 96 |

Three things to read off this. Nine in ten waves reach the 100 ms flush
deadline before the scheduler is quiescent, so a wave is routinely a
partial commit and the cascade it was settling continues in the next one.
The demand pass takes an eighth of a 30-topic run's wall clock and 62 % of
the 100-topic run's. And `structureLoadTerminal` — a demanded root
confirmed to carry no pattern metadata — fires about 15 times per browser
navigation and 23 times per seeded topic, which §3c traces to the watch
adds.

### 3b. The settle series

`servingLoop.settle.series` records, per authored input, the time from
admission to the wave whose watermark covers it, with the cycle count.
For the 30-topic seed (pair 1 ON, `f7f942ad42`; entries with
`eventAppend: true`):

| topics | typical settle | cycles |
| --- | --- | --- |
| 1–10 | 18–680 ms | 1–5 |
| 11–20 | 25–1 495 ms | 1–10 |
| 21–30 | 150–3 875 ms | 2–22 |

The late creates take 10 to 22 cycles each: the board's per-create
recompute (its crossref join and index over every topic) no longer fits
one flush window, and each cut wave costs a derived commit, a watermark
write, and a push fan-out before the next one resumes it. For the
100-topic seed the series shows the server losing the race outright:

| events | mean settle | mean cycles |
| --- | --- | --- |
| 1–10 | 270 ms | 2 |
| 11–20 | 442 ms | 3 |
| 21–30 | 115 s | 485 |
| 31–40 | 553 s | 2 317 |
| 91–100 | 107 s | 404 |

From about the 25th topic the watermark stopped covering new appends until
the seed ended; the client kept appending because its per-topic wait is on
its own pull and durability, not on coverage.

### 3c. Timing rows

The largest rows of the 100-topic scale run's delta, and of a 30-topic
seed profiled on its own (§3d; that run was slowed by binary builds
sharing the machine, so read the shares rather than the milliseconds):

| row | scale run: count × mean | seed profile: count × mean |
| --- | --- | --- |
| `executor/wave/cycle` | 2 775 × 206 ms = 571 s | 509 × 284 ms = 144 s |
| `executor/wave/settle` | 2 775 × 169 ms = 468 s | 509 × 207 ms = 105 s |
| `scheduler/execute` | 378 × 1 527 ms = 577 s | 167 × 531 ms = 89 s |
| `storage.v2/watchRefresh/watchAddSync` | 3 377 × 119 ms = 402 s | 738 × 98 ms = 72 s |
| `memory/watchAdd/total` | 3 700 × 53 ms = 196 s | 850 × 31 ms = 26 s |
| `memory/frame/handle` | 5 302 × 38 ms = 203 s | 1 415 × 20 ms = 28 s |
| `memory/flush/refresh` | 3 824 × 19 ms = 74 s | 818 × 30 ms = 24 s |
| `engine/compileToRecordGraph` | — | 33 × 545 ms = 18 s |
| `executor/wave/root-ensure` | — | 4 × 5.6 s = 22 s |

`watchAddSync` is the serving runtime waiting on a `session.watch.add` it
sent to the co-hosted memory server. Each row is one coalesced batch of
`pull()` calls, so the count is a floor on the syncs issued; it is of the
same order as the two confirmation syncs per terminal load, which is the
largest producer the pass has, beside the piece starts. Half the seed's wall
clock on the server is that wait, and it is inside `scheduler/execute`
because the demand pass that issues the adds is awaited ahead of
`runtime.idle()` in the settle race
(`packages/runner/src/executor/space-server.ts`, `#waveCycle`).

The per-add cost is not fixed. It is 43 ms at 30 topics and 119 ms at 100,
because a `session.watch.add` rebuilds the session's tracked-id set from
every entity it holds (`trackedIdsFromEntries` over `session.entities`,
`packages/memory/v2/server.ts`, in both the add and the refresh handlers)
and extends the tracked graph by cloning its state, and the serving
session holds the board's whole closure (`demandedInstancesMax` 4 433 at
30 topics, 13 740 at 100). So the seed pays adds × entities, and both
factors are the board size.

### 3d. The CPU profile

A source-run ON toolshed at `3cdf2ab489` under `--inspect`, sampled at
2 ms across a 30-topic seed by
`skills/perf-investigation/scripts/profile-toolshed.ts` (a 250 µs interval
over a bracket this long exceeds the inspector's message size, as the skill
warns). Self time by file: internal 28 % (of which idle 10.8 % and garbage
collection 8.0 %), `typescript.js` 10 %, the memory server's `query.ts`
8.9 %, `traverse.ts` 4.3 %, `server-sync.ts` 3.9 %, `server.ts` 3.7 %,
`deep-freeze.ts` 2.9 %. The single largest non-internal frame is
`trackedIdsFromEntries` at 3.5 %, then `extendTrackedGraph` 2.7 % and
`cloneTrackedGraphState` 1.4 %, the memory server's per-add work from §3c.
Inclusive, `compileToRecordGraph` is 9.8 % and is the caller of almost all
of the TypeScript time: the run's three cold compiles (the system root,
the board, and the profile-create surface) are what the compiler cost, and
the thirty cache hits that follow cost about 65 ms each plus a 25 ms SES
evaluation and an awaited write-back.

### 3e. Four mechanisms on the path, named

1. **The demand pass syncs every demanded root it cannot start, twice, and
   forgets the answer when demand departs.** A root the client tracks that
   carries no pattern metadata (a value document) gets
   `#confirmNoPatternMeta`: a `.sync()` of each observed document in the
   space scope and in the demanding scope, then a second
   `ensurePieceRunning`. The verdict parks in `#terminalStructureLoads`,
   which the departed-keys sweep deletes, so every browser session that
   opens the board re-confirms the same documents (about 15 per
   navigation), and a seed whose demand keys churn as the list grows
   re-confirms as it goes (`structureLoadTerminal` 2 275 for 100 topics).
   Each confirmation is two of the watch-adds in §3c.
2. **The flush deadline cuts nine waves in ten.** With the demand pass
   awaited inside the race, a wave that starts one cannot settle before
   100 ms, so it commits what it has and the cascade resumes next cycle.
   Every extra wave is a derived commit, a watermark write, and a push
   pass over every session of the space (`memory/flush/refresh`).
3. **The event drain defers on a lagging view and re-arms on a 250 ms
   timer.** The drain checks that the serving replica's view holds the
   entry at its stored index before it runs the handler; the feed learns of
   the append synchronously at admission but the view learns of it from
   the loopback session's next frame, so the check fails on 17 to 22 of a
   seed's 36 events (`event-view-lag` in the log). A deferred scan re-arms
   on new input or the `EVENT_DEFERRAL_REARM_MS` backstop, and a seeding
   client sends its next event only after the previous one lands, so the
   backstop is what fires.
4. **A cold session waits out the demand grace.** A watch-set change arms
   `DEMAND_WAKE_GRACE_MS` (300 ms) before the demand pass runs, so the
   first wave a fresh browser session's board depends on starts no sooner
   than that after its watches arrive.

Two more sit beside them, on both arms.

5. **Each topic create opens the profile-create surface again.** Every
   `addTopic` under the seeding identity, which has no profile, resolves
   `system/profile-create.tsx` over HTTP and compiles it: 30 compiles for
   30 topics on the server under ON, and the same 71 fetches from the
   seeding client under OFF. `openSidecarSurface` memoizes per wish node
   (`SidecarSurfaceState`), and the source reconciler's `open` compiles
   deliberately even for an identity in memory so the space holds the
   closure (`packages/runner/src/source-reconciler.ts`). Under ON that
   cost sits on the wave path.
6. **The seed holds the whole board result live.** `seedTopicBoard` sinks
   `getResult(board)` with no schema so each write lands against a
   current list, which the `cf` CLI also does; under ON that demand is
   what the server has to make current every wave, and it is the closure
   the serving session tracks (§3c). A browser demands the board's view
   instead.

## 4. Ablations

Each row is one ON toolshed binary at `3cdf2ab489` with a single edit,
run on the 30-topic board benchmark adjacent to unmodified ON and OFF
binaries, all from one sequence. The edits are what the mechanism in §3e
names and not a proposed fix: they exist to show which number moves.

The sequence ran inside the sibling suite's worst stretch (one-minute load
21 to 136 at run start), so the timings below are not comparable across
rows and the counters are what each row is read from.

| binary | load | seed | board | waves | budget exhausted | terminal loads | view-lag deferrals |
| --- | --- | --- | --- | --- | --- | --- | --- |
| unmodified ON | 45 | 88 378 | 1 744 | 356 | 364 | 705 | 19 |
| `DEFAULT_FLUSH_DEADLINE_MS` 100 → 1000 | 21 | 45 409 | 1 788 | 140 | 15 | 533 | 15 |
| drain awaits frames once before deferring | 113 | 56 872 | 2 140 | 424 | 405 | 508 | 0 (12 recovered) |
| `DEMAND_WAKE_GRACE_MS` 300 → 20 | 136 | 146 660 | 3 626 | 637 | 819 | 1 158 | 18 |
| terminal verdict kept across demand departure | 26 | 82 786 | 2 695 | 476 | 634 | 948 | 14 |
| unmodified OFF | 14 | 24 880 | 1 207 | — | — | — | — |

**Flush deadline.** Ten times the deadline took the late creates from 10 to
37 cycles each down to 1 to 4, and the count of cut waves from 364 to 15,
and their settle times did not move (2 to 4 s either way). The cut waves
are a symptom of the settle waiting on the demand pass, not a cost of
their own; the deadline is not a lever for this workload.

**Event drain.** Awaiting the co-hosted server's frame delivery once and
re-reading the view recovered every lagging entry (12 of 12) and sent none
to the 250 ms backstop. The seed ran in 57 s at load 113 against the
unmodified binary's 88 s at load 45; the mechanism's own bound is 250 ms
per deferred event, which was 17 to 22 of a seed's 36 events on every
unmodified run.

**Demand grace.** Ran at load 136 and has no counter of its own; nothing is
read from it.

**Terminal verdict kept.** Wrong as written, and it says so: terminal
loads rose to 948, the demand pass doubled, and `runner/start/resumeCellSync`
ran 19 934 times. A kept verdict stays in the set the feed re-arms on every
commit touching one of its observed documents, and each re-arm attempts a
piece start. The confirmation has to become cheap; parking more of them is
not the fix.

## 5. What to change, in the order the numbers rank them

1. **Confirm "no pattern metadata" from the co-hosted engine, not through
   two loopback syncs, and take the never-a-piece roots off the wave's
   settle path** (`packages/runner/src/executor/space-server.ts`,
   `#confirmNoPatternMeta` and `#loadDemandedStructure`). The serving
   process holds the engine; a read of the observed documents' metadata at
   the engine head answers the same question without a `session.watch.add`
   round trip, and a sync is only owed when the head is past what the
   replica applied. This is the largest term at every size measured: half
   the seed's wall clock on the server at 30 topics, 62 % at 100, and the
   growth from 43 ms to 119 ms per add. The kept-verdict ablation shows
   the shape to avoid.
2. **Make a `session.watch.add` incremental on the memory server**
   (`packages/memory/v2/server.ts`, the add and refresh handlers). Each add
   rebuilds the session's tracked-id set from every entity it holds,
   copies the entity map, and clones the tracked graph state, so the
   serving session, which tracks the board's whole closure, pays the board
   size on every one of its adds. Maintaining the tracked set by delta
   removes the second factor of the product in 1 whatever becomes of the
   first, and it reaches every session, browsers included.

   **Shipped 2026-09-11 as
   [#7251](https://github.com/commonfabric/labs/pull/7251)** ("perf(memory):
   stage incremental watch maintenance"), which maintains the tracked set by
   delta and stages the entity map and graph state without enumerating them.
   A re-measurement on 2026-09-18 was taken with that change already in the
   tree, so the per-add cost it reports is the cost that remains after this
   item. Annotated here rather than left to mislead; the recommendation above
   is the 2026-09-09 text, unedited.
3. **Let the event drain wait for frame delivery before it defers**
   (`space-server.ts`, the `event-view-lag` arm of `#drainStreamEvents`).
   The ablation form — `server.idle()`, `inputSynced()`, one macrotask,
   re-read — recovered every lag; the real change can be narrower, since
   the sidecar sync that precedes the check could wait for the replica to
   reach the append's admitted seq. Worth 250 ms on most creates when
   nothing else is writing, which is the agent and CLI case.
4. **Open a sidecar surface once per runtime and registry epoch, not once
   per wish node** (`packages/runner/src/builtins/wish.ts`,
   `SidecarSurfaceState`; or `packages/runner/src/source-reconciler.ts`,
   `open`, answering from memory when the space already holds the
   closure). Thirty fetch-and-compile rounds per thirty topics, about
   100 ms each, on both arms; on the wave path under ON, and in the
   seeding process under OFF.
5. **Narrow what the seed and the `cf` CLI hold live.** The schema-less
   result sink is the closure the serving session tracks, and so the size
   in 1 and 2. `topic-create-onscreen.test.ts` already keys into the
   board's `index` behind a knob; the seed fixture and the CLI's board
   reads
   ([2026-09-cf-cli-topics-board-cost.md](2026-09-cf-cli-topics-board-cost.md))
   should do the same. This is the one lever a pattern or a caller holds.
6. **Leave the flush deadline alone**, and treat the demand grace as a
   bounded 300 ms per cold session until it can be measured on a quiet
   machine.

Not moved by anything here: #7193, which lands between the two tips and
changes what a query delivers. Its OFF numbers match the earlier tip's and
its one clean ON pair sits inside the earlier tip's spread; the cost this
record attributes is in the serving loop's own reads, which that change
does not touch.

## 6. Files

The run driver, the per-run artifacts (server logs, stats captures, bench
JSON, seed fixtures), the seed CPU profile, and the ablation binaries are
in the session's scratch directory on the measuring box and are not
archived. The ablation edits are three one-line constant changes and one
block replacement in `packages/runner/src/executor/space-server.ts`,
described in §4.
