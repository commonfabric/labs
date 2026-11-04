---
status: historical
created: 2026-10-19
archived: 2026-10-20
reason: "Measurements after merging main: refresh causes, client and server execution frequency, schema walks, frame serialization, and real browser vote bursts."
---

# Served-vote fan-out: causes, client/server counts, and browser measurements

This continues [the fan-out plan](../../../plans/served-vote-fan-out.md)
on `codex/served-vote-fan-out`, forked from `263d6f444` (the documentation
follow-up to `e48eab5`) and merged with main at `805b6505a`. The baseline
index tree, including merge adaptations, was
`0eadf6d07b3ffdfb427b555209a206286719afc6`.

The machine was a Linux 6.18.55 container on an AMD EPYC 9V74, limited to
four CPUs and 16 GiB. Deno was 2.9.4. Runs were sequential on an otherwise
idle container. Absolute times from the October 11 record are not controls
for this machine or this revision.

## Baseline

The unchanged lunch-poll burst benchmark ran with five voters and five
options, 25 concurrent votes, all five worker reconcilers holding the poll
view. Each timed burst ended when every client's vote list held the round's
rows at quiescence. OFF and worker runs alternated, twice each. The worker
arm enabled server execution, the worker, and store read-through; overlap
remained off. Timing-measure capture was disabled for headline runs.

| Arm | First run, mean (range) | Second run, mean (range) | Rejected commits / rolled-back writes, accounting bursts |
| --- | --- | --- | --- |
| OFF | 2.4 s (2.1–3.1) | 2.5 s (2.3–2.8) | 460 / 662; 372 / 554 |
| Worker | 3.5 s (2.7–4.2) | 3.5 s (3.0–4.2) | 0 / 0; 0 / 0 |

Contention and serving rows describe separate untimed accounting bursts,
including their consequence wait and verification, not the timed samples.
All five clients contributed contention counts. Keyed vote intents do not
collide, but OFF clients also write shared derived documents.

| Worker accounting row | First run | Second run |
| --- | --- | --- |
| Waves / deadline waves | 22 / 20 | 19 / 17 |
| Watermark lag, before → after | 1 → 1 | 1 → 1 |
| Cycle | 26 × 135.2 ms | 24 × 118.9 ms |
| Settle | 26 × 87.4 ms | 24 × 83.6 ms |
| Commit | 22 × 47.3 ms | 19 × 32.9 ms |
| Demand pass | 27 × 0.0 ms | 25 × 0.1 ms |
| Publish | 26 × 2.8 ms | 24 × 4.2 ms |
| Handler | 25 × 5.8 ms | 25 × 4.5 ms |
| Scheduler settle | 51 × 53.5 ms | 51 × 40.8 ms |
| Watch-add sync | 0 | 0 |

The 30-topic seed used the plan's exact size: index demand, two crossrefs,
three citing topics, and 120 body words. Each run used a fresh source toolshed
and storage directory. Process wall time, including client startup, was
23.61 / 23.68 s OFF and 35.98 / 33.80 s worker.

The seed's serving-side rows are differences between health snapshots around
the command. Each cell is count × average milliseconds; they are cumulative
phase timings, not additive portions of process wall time.

| Seed arm / run | Memory flush | Memory walk | Worker cycle | Worker settle | Worker commit |
| --- | --- | --- | --- | --- | --- |
| OFF 1 | 109 × 8.17 | 108 × 7.56 | — | — | — |
| OFF 2 | 109 × 8.50 | 108 × 7.84 | — | — | — |
| Worker 1 | 121 × 20.05 | 121 × 17.62 | 97 × 559.01 | 97 × 255.84 | 81 × 71.98 |
| Worker 2 | 124 × 17.50 | 123 × 15.35 | 89 × 590.43 | 89 × 261.37 | 84 × 55.75 |

Worker seed watermark lag ended at 1 and 125 commits. The lag remains variable;
the first run does not establish that the earlier watermark problem is fixed.

## Stage 1: four questions

An uncommitted probe hosted the unchanged harness and copied the benchmark's
setup, two warmups, vote dispatch, and `waitForRows` endpoint. Temporary
instrumentation surrounded `refreshTrackedGraph`, `GraphQueryWalk`,
`SchemaObjectTraverser.traverse`, `EngineObjectManager.readState`, and the
memory boundary serializer. It collected host and client timing measures
and a host CPU profile with a 500 μs sampling interval. Measures were cleared
before capture; the one-million-entry cap was not reached. A second capture
disabled message compression before creating sessions.

The probe's snapshots, hashing, and counters add substantial overhead. Its
wall times are diagnostic, not benchmark results. Nested elapsed spans must
not be added as CPU time. In particular, asynchronous compression spans
overlap. The profile includes about 353 ms in inspector stop and about
319 ms in probe functions; neither belongs to the workload.

### 1. Schema traversal versus document reads

These are totals over one compressed capture on each arm, in milliseconds.

| Quantity | OFF | Worker |
| --- | --- | --- |
| Flush passes / session refreshes | 4 / 20 | 27 / 135 |
| Refresh phase total | 1,164.0 | 975.2 |
| Rewalk phase | 1,137.4 | 936.9 |
| Top-level schema traversal elapsed | 670.8 | 536.7 |
| Engine read elapsed | 94.5 | 206.5 |
| Engine reads | 4,730 | 3,115 |
| Top-level traversals | 29,448 | 16,295 |
| Schema calls | 94,639 | 71,586 |
| `anyOf` branches / fast rejects | 39,058 / 19,973 | 44,867 / 22,936 |

Read and traversal times overlap where traversal loads a document; they are
not an additive partition. The worker profile attributed 513 ms of sampled
self time to `traverse.ts`, including 99 ms in branch traversal and 50 ms
in the traverser constructor. It attributed 58 ms to SQLite statement code.

The median top-level traversal made one schema call on both arms. Worker
p90 was eight, p99 was 47, and the maximum was 120. This capture does not
show thousands of schema calls in one memory refresh traversal: it shows
thousands of small traversals. The large slow-traverse warnings from earlier
records must not be assigned to this path without checking their realm.

### 2. Work repeated across sessions

Every captured refresh had present user- or session-scoped reach: 20/20 OFF
and 135/135 worker. The detailed worker capture found user-scoped header,
profile/host state, selected-vote state, VDOM, and pattern-internal documents.
This was more than one small scoped tail. No refresh called `trackGraph`;
the whole-query evaluation cache does not serve this incremental path.

Grouping space-scoped traversal roots by flush pass, engine head, full
document address including path, and canonical selector produced 4,127
distinct groups from 25,604 OFF visits, and 3,094 from 15,454 worker visits.
Thus about 80% of worker visits repeated such an input. This includes
repetition within a session as well as across sessions. Equal roots do not
prove equal effects: a walk's existing coverage, missing-link attribution,
and scoped descendants remain part of its context. Replaying arbitrary
per-document traversal effects across identities would be unsound.

All complete encoded frames were distinct: 910 OFF and 292 worker. Removing
only request and session IDs before hashing left 673 and 140 distinct bodies.
Worker effects accounted for 135 frames, 83 distinct normalized bodies, and
4,924,512 serialized bytes. There is some identical content, but no direct
whole-frame cache hit without separating recipient envelopes.

### 3. Does a commit rewalk unchanged documents?

Worker refreshes produced 1,370 affected-document updates, all at changed
versions, but read 1,745 unchanged versions among 3,115 engine reads. The
incremental root selection is working; following those roots still rereads
unchanged supporting documents. Each refresh constructs a fresh manager
despite retaining the previous manager's document cache in the graph state.

OFF had 3,071 affected updates, 2,706 at unchanged versions, and 4,365
unchanged reads among 4,730. Conflict catch-up deliberately dirties rejected
operations and their confirmed/pending read sets, so OFF's incremental
refreshes walk those roots again at unchanged versions and read their
supporting documents again with them; none of these counts is a first
evaluation. Dropping their delivery solely because the server version is
unchanged would lose the client's conflict repair.

The compressed captures contained 151 admitted OFF commits with 104 writes,
and 45 worker commits with 497 writes. Dirty sets also include conflict
repair and coalesce across commits; their sizes are not write counts.

### 4. Encode without compression

| Quantity | OFF compressed | OFF uncompressed | Worker compressed | Worker uncompressed |
| --- | --- | --- | --- | --- |
| Probe burst elapsed | 2,366 ms | 2,855 ms | 3,325 ms | 3,386 ms |
| Boundary serialization | 13.8 ms | 19.0 ms | 72.4 ms | 63.5 ms |
| Summed `send/encode` spans | 1,892.7 ms | 0.3 ms | 2,147.8 ms | 0.2 ms |
| Frames | 910 | 784 | 292 | 284 |
| Serialized bytes | 469,950 | 488,367 | 4,956,490 | 4,457,051 |

Serialization precedes `send/encode`. The worker CPU profile attributed
35 ms to native compression. Removing compression removes roughly two
seconds of overlapping asynchronous spans without removing two seconds of
burst time. Different flush boundaries change frame counts and bytes, so
the byte difference between these captures is not a compression ratio.

## An unchanged-read cache experiment, rejected

An experimental per-graph read cache reused a previously loaded document only
when its exact scope instance was tracked and absent from the dirty set. It
retained a fresh schema memo and published cached reads only after successful
refresh. Narrow-selector and newly reachable-document tests passed, including
a mutation check that disabling reuse caused the read-count assertion to fail.

The end-to-end measurements did not establish a win:

| Arm | Baseline burst means | Cache burst means | Baseline seed wall | Cache seed wall |
| --- | --- | --- | --- | --- |
| OFF | 2.4 / 2.5 s | 3.0 / 2.5 s | 23.61 / 23.68 s | 23.60 / 23.19 s |
| Worker | 3.5 / 3.5 s | 4.4 / 4.4 s | 35.98 / 33.80 s | 35.09 / 35.65 s |

These were successive paired sittings, not a randomized comparison of the
cache within one sitting. They establish no improvement; they do not isolate
the cause of the slower worker burst. The experiment and its tests were
removed. The next investigation asks why work repeats before choosing another
optimization.

Selective replication was deferred. It was off for the baseline seed and
ordinary burst measurements. A separate browser measurement is needed to
include actual UI input and DOM convergence; the established worker benchmark
has neither. Its results will form a separate series.

## Frequency before another optimization

The next capture kept the workload unchanged and added occurrence details to
existing timing rows, plus root-evaluation, dirty-batch, and conflict-repair
rows. Details identify documents by scoped key and selectors by path and schema
hash; they do not serialize document values. The same `traverse` details are
available on clients and servers. The live profiling guide describes the fields.

An uncommitted probe captured logger measures, statistics, action runs, trigger
notifications, and a 500 μs V8 sampling profile independently in the memory-server
realm, serving-worker realm, and every client. It captured complete action and
trigger streams at their runtime recording boundaries, rather than treating the
scheduler's bounded history as a whole-burst count. Each capture saved the
realm's `performance.timeOrigin`; a Linux monotonic/epoch clock anchor aligned
V8 sample timestamps with the measures. Tables below restrict each realm to the
common burst interval, excluding profiler startup and teardown. Entirely
contained measures are counted; boundary-crossing spans are excluded.

Runs alternated OFF and worker, twice at one client and twice at five clients,
with five options throughout. The sizes therefore represent five and 25 writes,
respectively; neither total nor per-client counts hold write count constant.
All exact-row and render-error checks passed. No realm reached the one-million
measure cap. Profiling and occurrence capture changed scheduling and add
substantial overhead; these are frequency diagnostics, not headline latency.

| Size / arm | Client computations, all clients | Client effects, all clients | Serving computations | Memory traversals | Conflict repairs |
| --- | --- | --- | --- | --- | --- |
| 1 client OFF | 133 / 133 | 64 / 64 | 0 / 0 | 525 / 525 | 0 / 0 |
| 1 client worker | 147 / 137 | 71 / 68 | 133 / 133 | 528 / 512 | 0 / 0 |
| 5 clients OFF | 1,491 / 1,530 | 815 / 871 | 0 / 0 | 29,768 / 37,532 | 684 / 637 |
| 5 clients worker | 1,789 / 1,673 | 1,180 / 1,074 | 826 / 793 | 17,643 / 17,450 | 0 / 0 |

The one-client comparison exposes duplicated computation without multi-client
conflicts: serving adds 133 server computations while the client still runs
147 / 137, versus 133 OFF. This does not prove every client computation is avoidable:
the served client maintains its echo and rendered view. It identifies the next
question as which notifications require each execution, rather than which leaf
is slow.

For one OFF client, both captures recorded 122 commit notifications, 197 new
invalidations, 73 already-invalid decisions, and 23 own-commit skips. With the
worker on, the first client's 134 notifications split into 49 commits and 85
integrations; its decisions were 218 new invalidations, 93 already-invalid, and
15 own-commit skips. The serving worker recorded 89 commit notifications and
133 new invalidations, 50 already-invalid, and 23 own-commit skips. A notification
can match multiple actions, and an already-invalid decision is not an additional
execution. Those distinctions prevent notification count from masquerading as
run count.

The serving worker's one-client run split into 58 space-instance and 75
user-instance computations. Its second five-client run split into 218 space and
575 user-instance computations. Fan-out itself is another source of executions:
a single trigger can lead to multiple instance runs, so trigger and action counts
need not match.

The memory server has a separate multiplication:

| Size / arm | Touched sessions | Affected document occurrences | Root-selector evaluations during refresh | Selectors per affected document |
| --- | --- | --- | --- | --- |
| 1 client OFF | 4 / 4 | 101 / 100 | 548 / 547 | 5.4 / 5.5 |
| 1 client worker | 8 / 8 | 107 / 104 | 555 / 540 | 5.2 / 5.2 |
| 5 clients OFF | 20 / 25 | 3,198 / 3,760 | 38,297 / 47,998 | 12.0 / 12.8 |
| 5 clients worker | 205 / 200 | 1,560 / 1,350 | 18,232 / 17,993 | 11.7 / 13.3 |

A touched session may refresh several graphs, and watch extension can evaluate
additional roots. Root evaluations are not all schema traversals: coverage can
skip a selector, while following one selector can traverse several documents.
The second five-client worker capture's 17,993 root evaluations contained only
2,058 distinct document/path/schema tuples across the interval. That is evidence
of repeated inputs, not proof that their versions or evaluation contexts match.

Sampling corroborates where the resulting work runs. In that capture, the
memory-server profile assigned about 802 ms of sampled self time to
`runner/src/traverse.ts`, while the serving worker's largest source-file self
row was `storage/v2-transaction.ts` at 474 ms. The first client had 355 ms there
and 231 ms in `traverse.ts`. The memory server also spent about 224 ms in the
logger itself under this diagnostic capture. Summed nested timing durations
are not CPU time, and profiler overhead is part of the reason these captures
are kept separate from benchmark results.

The second five-client worker capture returned a validation failure in 4,850
of 17,450 memory-server traversals. This is a returned selector-validation
result, not a thrown exception or a failed burst. No captured traversal threw.
The outcome field keeps those distinctions visible instead of conflating all
unsuccessful work.

A cross-tab locates V8 samples inside the synchronous `memory/query/root`
intervals using the saved clock alignment, then groups by selector path and
schema hash. Three leading groups from the same capture, all at `["value"]`:

| Schema hash prefix | Root calls | Summed root duration | Sampled time inside roots | Samples in `traverse.ts` |
| --- | --- | --- | --- | --- |
| `0tbE0pZM` | 235 | 93.7 ms | 93.2 ms | 41.1 ms |
| `Hcp-1RXh` | 125 | 90.2 ms | 91.2 ms | 48.6 ms |
| `K8q-FnfS` | 125 | 70.1 ms | 79.0 ms | 43.0 ms |

The full hashes remain in each measure for lookup. These are sampled
attributions, not exact per-call CPU measurements; short intervals can be missed
or overrepresented by sampling. The first group runs almost twice as often as
the second for similar total cost. This is the distinction a leaf-duration
ranking alone hides. The monotonic-to-epoch clock anchors taken before and after
the captures had no measurable offset drift.

The evidence selects further causal analysis of invalidation, per-instance
execution, and selector multiplicity. It does not yet select a cache, batching
change, or other optimization.

## A separate browser measurement

`packages/patterns/integration/lunch-poll-vote-burst.browser.ts` drives the real
lunch poll through independent Chromium profiles. Setup creates real profiles,
joins the poll, and adds options through its UI. The authoring controller is
disposed before browsers open. Two warmup bursts precede three measured bursts;
every burst changes each voter's color for every option.

The endpoint checks exact option/name/color tuples in every page's rendered
swatches, rejects duplicates, and waits through two animation-frame callbacks.
This observes a paint opportunity, not physical display presentation. The
convergence time is the maximum client checkpoint; driver completion is reported
separately so CDP cleanup cannot extend the headline. Timings include preparing
and dispatching the actual CDP clicks.

Fresh source toolsheds and matching shell builds ran OFF/worker/OFF/worker with
selective replication and overlap off. Each run used five profiles and five
options, 25 votes. The box was otherwise idle. These browser measurements use
the production pattern and actual profile UI, unlike the keyed-fixture worker
benchmark, so they form a separate series.

| Arm | First run: three samples, mean | Second run: three samples, mean |
| --- | --- | --- |
| OFF | 5.59, 4.52, 4.60 s; **4.90 s** | 5.64, 5.76, 6.41 s; **5.94 s** |
| Worker | 5.16, 6.29, 5.66 s; **5.70 s** | 6.18, 6.57, 4.60 s; **5.78 s** |

All exact DOM and browser-error checks passed. This sample size and variation do
not establish a browser-level advantage for either arm. A one-profile OFF smoke
run also passed, with five votes at 0.85, 0.79, and 0.77 seconds.

Health rows span all three samples and their between-sample waits. Cells are
count × average milliseconds, not three-sample wall time:

| Arm / run | Memory flush | Touched-session walk | Worker cycle | Worker settle | Worker commit |
| --- | --- | --- | --- | --- | --- |
| OFF 1 | 32 × 260.4 | 128 × 61.9 | — | — | — |
| OFF 2 | 30 × 309.1 | 126 × 70.1 | — | — | — |
| Worker 1 | 94 × 83.9 | 434 × 6.5 | 72 × 228.5 | 72 × 97.1 | 63 × 58.9 |
| Worker 2 | 92 × 66.3 | 441 × 6.5 | 79 × 227.4 | 79 × 91.1 | 65 × 74.0 |

For reproduction, start a source toolshed at `http://localhost:8400` and a shell
at `http://localhost:5173`, with `SHELL_URL=http://localhost:5173` on toolshed.
`FRONTEND_URL` deliberately points to toolshed at port 8400: toolshed proxies
the shell through that setting, as in the measured runs.
Set `EXPERIMENTAL_SERVER_EXECUTION` consistently on toolshed, shell build, and
measurement process. Set worker and store read-through to the same arm; keep
`SERVER_EXECUTION_OVERLAP_COMMIT=false` and
`EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION=false`. Then, from the repository root:

```sh
API_URL=http://localhost:8400 FRONTEND_URL=http://localhost:8400 \
CF_LUNCH_POLL_VOTERS=5 CF_LUNCH_POLL_OPTIONS=5 \
CF_LUNCH_POLL_BROWSER_ROUNDS=3 CF_LUNCH_POLL_BROWSER_OUT=/tmp/browser-burst.json \
deno run -A --no-check packages/patterns/integration/lunch-poll-vote-burst.browser.ts
```

The command inherits the arm flags set above. Shell's `serve` task builds with
its environment before listening; restart it when changing arms. Set
`ASTRAL_BIN_PATH` when using an installed Chromium. The measurement saves full
client logger rows and server health snapshots outside the timed intervals,
allowing the same keys to be compared without summary truncation.

The final browser snapshot support was also exercised twice on each arm with
one profile and five options. Across each run's three measured bursts and
between-sample waits:

| Arm | Burst means | Client action runs | Client traversals | Serving action runs | Serving traversals |
| --- | --- | --- | --- | --- | --- |
| OFF | 0.84 / 0.80 s | 638 / 638 | 547 / 547 | 0 / 0 | 0 / 0 |
| Worker | 1.05 / 0.97 s | 698 / 709 | 547 / 547 | 408 / 408 | 392 / 392 |

Action rows include both computation and effects on clients. The serving realm
runs computations. These are snapshot deltas around the browser series, not the
single-burst, common-interval counts from the Deno profiles. Browser convergence
observes visible state, which can include speculation; it is not a separate
watermark-coverage assertion.

## Unprofiled checks and instrumentation cost

With the final timing additions and measure emission disabled, repeated standard
bench runs gave 2.6 / 2.8 s OFF and 4.3 / 4.1 s worker. The 30-topic seed gave
23.10 / 23.25 s OFF and 33.19 / 29.01 s worker. These later sittings do not by
themselves isolate the cost of the added logger rows from scheduling variation.

The standard bench's untimed serving-side accounting burst reports count ×
average milliseconds, separately from those repeated latency samples:

| Worker run | Waves / at deadline | Cycle | Settle | Commit | Demand pass | Publish | Handler | Scheduler settle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 20 / 18 | 23 × 141.7 | 23 × 93.4 | 20 × 48.6 | 24 × 0.1 | 23 × 1.1 | 25 × 5.5 | 51 × 48.9 |
| 2 | 22 / 19 | 26 × 139.0 | 26 × 92.1 | 22 × 38.9 | 28 × 0.1 | 26 × 1.9 | 25 × 6.7 | 52 × 51.6 |

Both accounting bursts began and ended one commit behind the head and recorded
zero `watchRefresh/watchAddSync` calls. OFF has no serving runtime for these rows.

A direct control temporarily removed only the timing additions from the three
runtime files, restoring the merged baseline versions from the index. An
uncommitted host ran the same workload with two warmups and one measured burst
per process, without CPU profiling, measures, or trigger-history capture. Each
arm ran twice with and without the additions; the second pair reversed their
order. The final sources were restored afterward.

| Arm | Instrumentation present | Instrumentation removed |
| --- | --- | --- |
| OFF | 2.23 / 2.65 s | 2.83 / 3.25 s |
| Worker | 3.63 / 4.10 s | 3.93 / 5.04 s |

These small samples show no consistent default-cost penalty. They do not
establish a speedup or bound small overhead. The larger diagnostic captures
explicitly enable measure emission and profiling and should not be used as
latency comparisons.

The final seed's serving rows, again count × average milliseconds:

| Seed arm / run | Memory flush | Memory walk | Worker cycle | Worker settle | Worker commit |
| --- | --- | --- | --- | --- | --- |
| OFF 1 | 109 × 8.60 | 108 × 7.97 | — | — | — |
| OFF 2 | 109 × 8.15 | 108 × 7.56 | — | — | — |
| Worker 1 | 127 × 19.11 | 126 × 16.84 | 104 × 458.98 | 104 × 217.22 | 83 × 60.08 |
| Worker 2 | 120 × 19.56 | 119 × 17.26 | 101 × 395.77 | 101 × 124.04 | 84 × 63.37 |

Both worker seeds ended one commit behind the head. The baseline's variable lag
remains an open investigation; these two runs do not identify its cause.

## Validation

Repo-wide formatting, lint, and type checking passed, as did checked documentation,
the history index, and skill facts. The browser measurement also passed a focused
type check; its paired real-browser runs exercised the convergence predicate and
the complete client/server snapshots.

With shuffle seed `20261011`, the memory view-interest, demand-principal,
miss-interest, query, and schema-closure files passed 39 tests and 44 steps;
the traversal files passed 47 tests and 233 steps. The full executor file list
from the plan passed 54 tests and 714 steps both as committed and with overlap
forced on. The expression was restored afterward. Toolshed server-execution
passed four tests and 17 steps, and piece served-lifecycle passed one test and
29 steps. Executor and traversal runs used `test/clock-preload.ts` from the
runner package, matching its test task.

## Review follow-up, 2026-10-20

The first published continuation was `0145a1665`. Review found several inherited
correctness gaps that could undermine measurement: demand invalidations could
be lost while a read was pending, detached sessions could leave stale demand or
view-interest caches, and a failed worker could restart before its predecessor's
lease release. These are corrected with regression tests. A successful wave
stays successful if its post-commit admission readback fails, and an uncloneable
port result now rejects its caller with a serializable error.

Refresh diagnostics now include reads completed before a failed walk. Failed
lifecycle verbs retain completed phase timings across the worker port and onto
the request span without changing their refusal code. The profiling recipe
explicitly enables both trigger and action-run histories and names the worker
realm's `loggerCounts` field.

The read-boundary helper no longer treats the watermark document's revision as
proof of coverage. An empty-root graph query can request the highest authored
sequence at or below a captured head, and the helper waits for the watermark
value to cover that sequence. A server that does not advertise serving requires
no watermark wait. Tests cover an uncovered authored commit followed by a newer
watermark revision, a multi-commit bookkeeping tail, and exclusion of writes
beyond the captured head.

The vote endpoint remains local visible-row convergence, potentially including
speculation. Its duplicate-row check now also verifies the array length. The
seed rejects failed intent outcomes instead of treating quiescence alone as
success. Neither change instruments the poll or Topics patterns.

After those corrections, all six repository gates passed again. The executor
list passed 57 tests and 725 steps both as committed and with overlap forced on;
the expression was restored. The authored-boundary suite added one test group
with six steps on the committed posture. Memory and traversal counts stayed at
39/44 and 47/233. Toolshed server-execution plus lifecycle routes passed 5 tests
and 36 steps, and piece served-lifecycle passed 1 test and 30 steps. The initial
continuation's CI passed after retrying a manifest-download failure that had
occurred before tests started.

On the review-fix source, with the box otherwise idle, the repeated standard
burst was 3.4 / 3.2 s OFF and 4.9 / 5.3 s worker. All exact-row checks passed.
These are a new sitting, not a controlled comparison of the review fixes to
`0145a1665`; both arms were slower than in the preceding sitting. They establish
no speedup. Overlap and selective replication remained off.

The untimed serving-side accounting bursts, count × average milliseconds:

| Worker run | Waves / at deadline | Cycle | Settle | Commit | Demand pass | Publish | Handler | Scheduler settle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 28 / 26 | 29 × 171.6 | 29 × 111.9 | 28 × 53.6 | 30 × 0.1 | 29 × 0.1 | 25 × 8.4 | 51 × 79.3 |
| 2 | 24 / 23 | 26 × 148.4 | 26 × 103.1 | 24 × 42.3 | 27 × 0.4 | 26 × 0.1 | 25 × 6.5 | 51 × 59.9 |

Both began and ended one commit behind the head and recorded no
`watchRefresh/watchAddSync` calls. OFF has no serving loop for these rows.

The 30-topic seeds were 26.67 / 28.06 s OFF and 43.75 / 40.08 s worker. All
completed without a failed intent outcome. Their serving rows were:

| Seed arm / run | Memory flush | Memory walk | Worker cycle | Worker settle | Worker commit |
| --- | --- | --- | --- | --- | --- |
| OFF 1 | 110 × 9.58 | 109 × 8.87 | — | — | — |
| OFF 2 | 111 × 10.76 | 109 × 9.97 | — | — | — |
| Worker 1 | 138 × 22.05 | 138 × 19.02 | 122 × 505.23 | 123 × 238.69 | 96 × 80.80 |
| Worker 2 | 132 × 20.13 | 132 × 17.43 | 103 × 594.64 | 103 × 160.42 | 90 × 68.93 |

The worker's watermark lag was 138 in the first run and one in the second.
That variability remains open; successful intent outcomes do not establish
whole-space watermark coverage. Raw outputs are `reviewed-burst-*` and
`reviewed-seed-*` in the scratch directory used above. The browser and causal
profile tables above describe the earlier capture source, not these review-fix
runs.

CI on `a4fe2a1e9` caught a browser-startup regression in the lifecycle timing
follow-up: importing the error envelope through the executor host pulled the
SQLite module into the browser worker. The existing cold Topics navigation test
failed in both execution arms with a login timeout. A temporary startup-task
probe exposed the underlying `Deno is not defined` error. Moving the shared
lifecycle result and failure types into a module without runtime dependencies
removes that import path. The temporary probe was removed; the existing browser
test passed on the corrected bundle with execution OFF and ON.

The port's error-classification comment now distinguishes ordinary protocol
faults (whose `ProtocolError` class the outbox uses) from timed lifecycle
failures (whose envelope carries name/code for lifecycle routes and reconstructs
the protocol error as its cause). A round-trip test covers both cases.

All six repository gates passed after that import correction. The committed
executor and authored-boundary suites passed 58 tests and 732 steps; memory,
traversal, toolshed, and piece suite counts remained as recorded above. No
serving-cycle, finish, or park behavior changed in this correction.
