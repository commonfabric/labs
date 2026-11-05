---
status: historical
created: 2026-09-25
archived: 2026-09-25
reason: "Point-in-time measurement and attribution of the Topics and lunch-poll benchmarks with server execution on, against read-through and off controls on one machine."
---

# Topics and lunch-poll benchmarks with server execution on

The four Topics and lunch-poll benchmark files run with `serverExecution` on,
then profiled until each cost had a named source. Every measured figure below
is in
[`2026-09-25-server-execution-topics-lunch-benchmarks.results.json`](2026-09-25-server-execution-topics-lunch-benchmarks.results.json)
beside this file, under the key each section names, except the discarded
profiling artifact described under the setup; constants such as the flush
deadline and the park interval are quoted from the source.

## Setup and limits

One Linux container: an Intel Xeon at 2.80 GHz with four cores and 15 GB, Deno
2.9.4, Chromium 141. The toolshed and shell were source runs started by
`scripts/start-local-dev.sh --inspect` at `207df13`, plus the change that lets
`lunch-poll-read-scale.bench.ts` run either posture. Each arm used a fresh store
and verified its posture at both ends before running: `/api/meta`, the
`servingLoop` block on `/api/health/stats`, and the served shell's baked
define.

| Arm | Posture |
| --- | --- |
| first pass | server execution on, one store accumulating every bench |
| A | server execution on, fresh store |
| B | A plus `SERVER_EXECUTION_STORE_READ_THROUGH=true` |
| C | server execution off everywhere, fresh store |
| D | as A, fresh store, the 1184-vote read-scale case alone |

Two limits bound every comparison. The browser, the bench process and the
toolshed share four cores, so a posture that moves work to the server also
moves contention onto the browser; the record of 2026-09-19 names the same
confound. And each arm ran once, in one order, so a difference under about a
fifth between arms is not a result. The findings below are the ones that are
either far larger than that or carried by counters and profiles rather than by
timings.

Server CPU profiles were taken over the toolshed's inspector with
`skills/perf-investigation/scripts/profile-toolshed.ts`, worker profiles with
`attachWorkerProfiler`. The first sample of every server profile absorbs the
time before sampling began and was excluded; one early reading that put 3.3 s
of self time in `MapSet.has` was that artifact. Inclusive time through inlined
or asynchronous frames was not trusted where the call chain was impossible, so
the attributions below rest on self time and on chains whose callers were
checked in source.

## Benchmark results

*Source: `firstPass_on`, `A`, `B`, `C`, `D_on_readscale1184`.*

| Measurement | On (A) | On, read-through (B) | Off (C) |
| --- | --- | --- | --- |
| navigation `journey` | 6,893 ms | 6,194 ms | 5,889 ms |
| navigation `board` | 3,772 ms | 3,000 ms | 2,791 ms |
| navigation `comment` | 633 ms | failed | 469 ms |
| seed, 30-topic board | 79 to 125 s | 63 to 67 s | 51 to 52 s |
| vote burst 5×5 | 28,682 ms | 23,132 ms | 482 ms |
| vote burst 10×10 | failed | not run | 2,904 ms |
| read scale, 74 votes | 896 ms (first pass) | not run | 556 ms |
| read scale, 296 votes | 2,665 ms (first pass) | not run | 786 ms |
| read scale, 1184 votes | failed twice | not run | 809 ms |
| board scale, 100 topics | 8,559 ms (first pass) | not run | not run |

The 10×10 burst failed in both the first pass and arm A. In arm A one voter's
consequences had not arrived after 120 s (`A.burst10`); in the first pass, the
serving loop's own settle series put that space's event coverage at a median of
172 s and a maximum of 252 s (`serverCounters.firstPass_burst10x10_coverage`).
The first pass's 1184-vote viewer
never rendered the options. One of arm D's viewers did, and completed the
untimed diagnostic vote (`D_on_readscale1184_diagnosticSample`); the run then
failed on the same render probe as the first pass, a later viewer's options
never appearing.

Arm B's `comment` segment failed in the full run and again alone: once the
send button was never found, once the topic page's `#profile` surface never
resolved. Arms A and C, and the first pass, passed it.

## Where the time goes

### The serving loop is one serial queue, and it is saturated

*Source: `serverCounters.A_seed30`, `serverCounters.A_burst5`,
`serverCounters.A_servingLoopBeforeCold1`,
`serverCounters.firstPass_burst10x10_cycles`,
`workerProfiles.coldBoardIdleShare`.*

Seeding thirty topics ran 381 wave cycles at a mean of 194 ms, 74 s of an 81 s
profile; the 5×5 burst ran 2,422 cycles at 210 ms, 508 s of 518 s. Under server
execution on, more cycles exhausted the 100 ms flush deadline than closed a
wave: 620 against 584 in arm A up to its first board probe, and 844 against 700
over the first pass's 10×10 burst. The browser worker was 84 to 87% idle during
the slow board loads: the client waits on the server.

### The watermark starves while input keeps arriving

*Source: `serverCounters.A_seedEventCoverage`.*

During the seed, event-appended value writes reached watermark coverage at a
median of 9.4 s and a p90 of 27 s, after a median of 47 cycles. The 72 events
were covered within 27 distinct seconds, one second covering 19: an exhausted
cycle carries no watermark movement, so coverage waits for input to pause and
then arrives in a batch.

### Parking discards the running space, and revisiting it costs about 20 s

*Source: `boardProbeMs`, `serverCounters.firstPass_coldBoard`.*

A space with no live session parks after `DEFAULT_IDLE_PARK_MS` (30 s) plus up
to one more idle wait, disposing its runtime. The next board load then took
21.9 to 22.8 s against 3.1 to 4.0 s within the window, and 15.8 s with
read-through. Server side, that load ran 46 demand passes totalling 21.1 s,
restarting every demanded piece and syncing each one's cells over the loopback
session (`watchAddSync`, 207 at a mean of 73 ms). Off, the same board loaded
cold in 3.6 s.

### The demand pass recomputes the whole demanded set every pass

*Source: `serverCounters.D_rs1184`, `profileSelfShares.D_rs1184_server`.*

`#loadDemandedStructure` calls `demandedInstancesForSpace`, which rebuilds the
demanded-instance list from every session's tracked entries, then walks every
row, known key and root key. The source names an incremental form as a
follow-on for when the union reaches tens of thousands; the 1184-vote poll
reached 17,653 demanded instances. There, 7,968 passes took 1,151 s of a
1,992 s run. `#loadDemandedStructure`, `demandedInstancesForSpace` and the
`emit` closure inside it held 31.6% of server self time between them, and
`trackedIdsFromEntries`, which `demandedInstancesForSpace` also calls, another
4.4%. The same run lost its execution lease ten times, averaged 19.3 s per
`scheduler/execute`, and answered `/_health` in 14 to 57 s, which is a
process-wide stall rather than one space's work.

### Materializer overlap is tested once per read, against every read

*Source: `profileSelfShares.D_rs1184_server`.*

`collectMaterializerWritersForLog` in
`packages/runner/src/scheduler/materializers.ts` iterates each read, each
materializer on that read's entity, and for each calls `readsOverlapWrites`
with the log's whole read list, without skipping a candidate already
collected. With lunch bodies of 3,554 accesses, `readsOverlapWrites` under it
held 6.7% of self time.

### Each push refresh re-walks the session's whole schema closure from SQLite

*Source: `serverCounters.A_burst5`, `profileSelfShares.A_burst5_server`.*

`refreshTrackedGraph` calls `assembleSchemaDocClosures` with
`revalidateEstablished` set, so every refresh re-loads every `cid:` schema
document the session has ever received. The `closure` phase ran 10,327 times at
9.1 ms in the burst, and the call held 17% of the profile inclusive.

### Every engine read issues five SQLite statements

*Source: `profileSelfShares.A_burst5_server`.*

`readStateForScopeKey` and `readRowForBranch` in `packages/memory/v2/engine.ts`
query the branch head twice, the branch status and the branch row before the
document row, and the decoded-document cache is consulted only after all five.
Unnamed native frames, whose callers in the profile are SQLite statement
calls, were 14% of the burst's self time.

### A profile-less viewer compiles a sidecar per topic

*Source: `serverCounters.A_seed30`.*

Seeding thirty topics ran the `#profile` wish 65 times, 62 ending in
`send-error`, and compiled 32 times at a mean of 369 ms, only two of them
missing the compile cache. A cache hit still resolves the program, reads the
cache and evaluates the module graph; the evaluation alone averaged 64 ms
(`compileCacheEvaluate`). `SourceReconciler.#resolveSupplied` calls
`compilePattern`, which bypasses the in-process `compileOrGetPattern` dedupe.

### The warm board is client work

*Source: `workerProfiles.A_warmBoardInclusiveMs`,
`profileSelfShares.seed30_topicsPatternFrames`.*

Arm A's three warm 30-topic board loads spent their worker time on rendering
(0.92 to 0.99 s inclusive), on `validateAndTransform` (0.61 to 0.70 s) and on
restarting the topic patterns the client still runs. The topics pattern's own
frames were 0.07% of server self time over a seed, in line with the 0.1% the
perf-investigation skill records for a profile of fifty topic creates.

## Claims checked

| Claim | Where | Result here |
| --- | --- | --- |
| read-through runs the served journey in roughly a third of the time | `EXPERIMENTAL_OPTIONS.md`, `SERVER_EXECUTION_STORE_READ_THROUGH` | not reproduced: `journey` 6.19 s against 6.89 s; seeds 17 to 46% faster; cold board 31% faster |
| a 10×10 burst takes 2.6 s on a four-core CI host | `BENCHMARKS.md` | consistent off, at 2.90 s on this four-core host; on, it does not complete |
| the topics pattern's frames are about 0.1% of self time | perf-investigation skill | reproduced on the server, at 0.07% |
| three and a third times the topics costs eight times the seed time | `BENCHMARKS.md` | not reproduced on: in the first pass, 100 topics took 519 s against 83 to 85 s for 30, about six times; not measured off at 100 |
