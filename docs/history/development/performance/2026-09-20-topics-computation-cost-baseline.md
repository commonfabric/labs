---
status: historical
created: 2026-09-20
archived: 2026-09-20
reason: "T0's baseline for the Topics computation-cost arc: the two tiers' measured costs, the probe's baseline with its environment and source versions, and what neither tier measures."
---

# The Topics computation-cost baseline

T0's baseline for `docs/plans/topics-computation-cost.md`, separating the four
costs that plan names — pivot production, per-topic lookup, activity, and
rendering — across the two tiers it defines. It is the last of T0's
deliverables, and it draws on runs the earlier ones recorded rather than taking
new ones.

Every measured figure below is in
[`2026-09-20-topics-computation-cost-baseline.results.json`](2026-09-20-topics-computation-cost-baseline.results.json)
beside this file, which also names, per block, the run each figure was
extracted from — with one exception, the three trials under "The trials behind
that shape", which are carried from `docs/development/BENCHMARKS.md` and have
no data file, as that section states. Those runs are recorded in three places,
and the extract's `sources` block gives each one's revision:

- the headless matrix, in
  [`2026-09-18-topics-lazy-materialization.results.json`](2026-09-18-topics-lazy-materialization.results.json),
  whose `lazy-materialization-on` arm is the probe's baseline;
- the browser benches, in
  [`2026-09-19-topics-server-execution-browser-arm.results.json`](2026-09-19-topics-server-execution-browser-arm.results.json),
  whose four server-execution-off rounds are the client-execution baseline;
- delivered documents, from the `experiment/topic-own-entry-lookup` branch,
  which is on `origin`.

Two kinds of number here sit outside that file. One is a set of measurements,
and the section that gives them says so. The other is not measurements at all:
the source-drift counts in the next section are diffstats between revisions
that section names, and git reproduces them from those revisions.

## Read this before the figures

Six limits bound what follows, and each is easier to apply before reading a
number than after.

**The sources have moved since every run here.** The probe's baseline was taken
at `fd9fa9a44b`, the browser rounds at `784a1e3a68`, and the delivery figures
at `bc23e3c6d0`. Against `9774543b73`, the revision this record was written at,
`packages/patterns/topics/main.tsx` and `topic.tsx` have both changed in each
case: 181 insertions and 86 deletions in `main.tsx` and 204 and 37 in
`topic.tsx` since `fd9fa9a44b`; 140 and 82, and 204 and 37, since
`784a1e3a68`; 188 and 85, and 224 and 30, since `bc23e3c6d0`. Two commits
account for the difference from the probe's baseline: `a0847cfc8e` (#7768),
after which a topic that has never run sorts by when it was filed, and
`5260dfd06c` (#7774), after which a topic stores its own number. Whether a
baseline taken two source changes back still serves as T5's comparison point is
T5's question, and this record does not decide it.

**Counters and timings are not equally good here, and the counters repeat only
where a section says they do.** The browser tier's two client-execution rounds
of the navigation bench agree field by field. Its two scale rounds do not:
seven non-timing fields differ between them — five in the reopen sample's
`remaining` row, its `runsWithoutSource` count, and the node count its graph
started from — although all four located lifts read the same zero in both. The
section on that workload gives each round separately. The headless matrix ran
one round per case, so it is not the matrix that establishes those counters
repeat. Two things do, each over part of it. The read-budget derivation runs
each of its eleven gated cases five times, and the section on the gated
measures says what follows from that. The other is the repeat subset, which is
not in this record:
four `high-degree` `all-backlinks` cases run five times each, reported in
[the lazy-materialization record](2026-09-18-topics-lazy-materialization.md)
as each producing one distinct set of counters across its five rounds, equal
to the matrix arm's for the same case. No case outside those two sets has a
repeated sample behind it here.

The timings were all taken on a shared machine under unrelated load, and the
sections that give them say what the load was.

**Attempt reads come from the headless tier only.** The browser helper records
completed-body reads and not transaction attempts, because the runtime client's
read-stats request enables body accounting alone. Where a figure below is an
attempt count, it is headless.

**The two tiers do not run the same thing.** The headless fixture writes
synthetic topics to emulated storage and runs the four Topics lifts directly,
with no pattern body, no browser and no server. The browser tier runs the whole
system, rendering included, against a toolshed. A cost the headless tier
reports as absent may be absent because nothing there runs it.

**Delivery is measured by a different rig on a different fixture.** The
delivered-document figures come from a rig that counts what a start has handed
to it from a server. T0's instruments count runtime reads in one process with
no memory server, and cannot see delivery at all. The fixtures also differ. The
two are separate baselines of the same system, not one series.

**Three quantities, three units, no arithmetic between them.** Runtime reads
are counted in runs and proxy accesses; delivery in documents and bytes;
startup and latency in milliseconds. No figure here sums or ratios across two
of those, and none can be assembled from the tables by dividing.

## What ran: the headless tier

The probe is `scripts/topics-computation-cost.ts`, run at `fd9fa9a44b` with a
clean working tree, under `--max-old-space-size=8192`, in the mode
`lazy-materialization-on`, which pins `lazyMaterialization` on and
`serverExecution` off. Deno 2.9.4, V8 15.0.245.2-rusty, TypeScript 6.0.3, on
`darwin`/`aarch64`, 10 processors, an Apple M5 with 32 GiB. Wall clock 1311
seconds.

The matrix holds 85 cases: 26 under `board`, 26 under `topic-open`, 26 under
`all-backlinks`, and 7 under `aggregates`. 59 are measured. The 26 `board`
cases are not, and the probe records the reason rather than a zero: a board
loaded before any topic is opened reads its stored card values, and in a
browser with client execution loading it ran none of the four lifts, so there
is no work of theirs to measure headlessly. No series recorded a limit, so
every declared size built, up to and including the 512-topic cases.

Each measured case runs ten phases: initialization, eight warm updates, and
a reopen. The figures below quote initialization except where a section names
another phase.

## What ran: the browser tier

`topic-board-navigation.bench.ts` at 30 topics and `topic-board-scale.bench.ts`
at 100, built at `784a1e3a68`, on a Mac17,2 running Darwin 27.0.0 with 10
logical CPUs, driving Google Chrome 153. Four rounds ran under client
execution, two of each bench, each against a fresh empty store, each reading
its posture back from the deployment before measuring.

Those rounds ran under unrelated load throughout. One-minute load average
against 10 logical CPUs: the navigation rounds pooled to a median of 19.15 over
52 samples, minimum 13.58 and maximum 69.88; the scale rounds to 21.13 over 78
samples, minimum 12.17 and maximum 52.02.

The results file records no lazy-materialization setting for these rounds.
`EXPERIMENTAL_OPTIONS.md` records that flag as on by default. This record
states both and does not state that the rounds held it on.

## Pivot production

The board's `crossrefTable` materializes the mention lists and scans them per
destination. It runs once per phase that demands it.

Headless, `topic-open`, initialization, at four mentions per source — proxy
accesses of the pivot's one run:

| topics | low-degree | high-degree | single-bucket |
| --- | --- | --- | --- |
| 32 | 193 | 193 | 189 |
| 128 | 769 | 769 | 765 |
| 512 | 3,073 | 3,073 | 3,069 |

The small low-degree case, 4 topics at three mentions per source, reads 21.
Link resolutions move with the accesses: 322, 1,282 and 5,122 for the
low-degree column.

Holding topics at 128 and varying mentions per source, the same measure, for
the graph shape each row names:

| mentions per source | low-degree | high-degree | single-bucket |
| --- | --- | --- | --- |
| 1 | 385 | 385 | 384 |
| 4 | 769 | 769 | 765 |
| 16 | 2,305 | 2,305 | 2,289 |

At zero mentions per source the matrix builds one case rather than three, the
graphs not differing where nothing mentions anything. It is the `none` graph,
and its pivot reads 257.

On a warm update the pivot re-runs in full. Taking
`pivot/high-degree/mentions-4/topics-128/topic-open` through every phase, the
pivot's proxy accesses: 769 at initialization, 768 on a mention removal, 769 on
a mention insertion, 769 on a same-count retarget, and 0 on each of comment
append, comment edit, comment retraction, link removal, and the unrelated
sibling edit. Its reopen reads 769.

## Per-topic lookup

Each topic's `backlinksOf` scans the pivot's rows to find its own.

Headless, `topic-open`, initialization — one topic open, so one run of the
lookup — proxy accesses at four mentions per source:

| topics | low-degree | high-degree | single-bucket |
| --- | --- | --- | --- |
| 32 | 72 | 99 | 99 |
| 128 | 264 | 387 | 387 |
| 512 | 1,032 | 1,539 | 1,539 |

The same small low-degree case reads 15.

The low-degree column separates the two things that could be driving that
growth, because it holds one of them still: the focus topic has exactly 4
mentioners at 32, at 128 and at 512 topics, while its lookup goes 72, 264 and
1,032. So a topic's lookup grows with the board behind it and not only with its
own inbound count. The other two columns do not separate them — the focus
topic's mentioners there are 31, 127 and 511 as the board grows — which is why
the claim rests on the low-degree column alone.

The `all-backlinks` workload demands every topic's lookup at once. It is a
scaling probe: no browser workload demands it. Initialization, four mentions
per source:

| topics | runs | low-degree accesses | high-degree accesses | single-bucket accesses |
| --- | --- | --- | --- | --- |
| 32 | 32 | 2,304 | 2,304 | 2,207 |
| 128 | 128 | 33,792 | 33,792 | 33,407 |
| 512 | 512 | 528,384 | 528,384 | 526,847 |

The low-degree and high-degree cases at 512 topics agree on the figures this
table gives — the same 528,384 accesses over the same 512 runs — and each
settles a graph of 3,595 nodes and 532,488 edges. They are not identical:
their largest single runs differ, which the paragraph below turns on, and so
do their registered-dependency counts. They differ most in time. Low-degree's
phase took 94,931.5 milliseconds and high-degree's 65,126.2, each one sample
on the loaded machine described above.

One of those columns can be divided by its run count and two cannot, and on
the page they look identical. In the low-degree column at 512 topics the
largest single run made 1,032 accesses, which is also the column's 528,384
divided by its 512 runs, so every run made 1,032. The other two cannot be
divided, for different reasons. The high-degree column holds the same 528,384
over the same 512 runs, but its largest single run made 1,539, so the runs are
not uniform and the quotient is a figure no run is known to have made — 1,032
is a whole number there and some run may well have made it, which is exactly
what this record cannot establish. The single-bucket column holds 526,847 over
512 runs, which is not a whole number, so no run made it. This record divides
only where the largest run equals the mean.

## Activity

`lastActivityOf` scans a topic's comments and its links, including edits and
retractions. `presentCommentCountOf` scans its comments. The `aggregates`
workload demands both on every topic of a four-topic board and nothing else. In
each row below the largest single run is exactly a quarter of the total, so the
four runs are equal and the per-run figure is the total divided by four.

Scaling comments — proxy accesses at initialization, over four runs. Every row
has three links per topic except the first, which has one:

| comments per topic | `presentCommentCountOf` | `lastActivityOf` |
| --- | --- | --- |
| 1 | 12 | 48 |
| 10 | 84 | 216 |
| 100 | 804 | 1,656 |
| 1,000 | 8,004 | 16,056 |

The step from the first row to the second therefore changes links as well as
comments, so 48 and 216 are not a comment-only comparison. It does not reach
the comment-count column: the links table below holds that column at 28 across
a hundredfold change in links, so links do not move it.

Scaling links, with three comments per topic:

| links per topic | `presentCommentCountOf` | `lastActivityOf` |
| --- | --- | --- |
| 10 | 28 | 188 |
| 100 | 28 | 1,268 |
| 1,000 | 28 | 12,068 |

The comment count is flat in links at 28 across all three; `lastActivityOf` is
not. The 1,000-comment case settles a graph of 4,056 nodes and 8,052 edges.

The pivot workloads demand the comment count and not the activity. Through the
same representative case as above, the comment count reads 7 at initialization
and 9 on each of comment append, comment edit and comment retraction, while
`lastActivityOf` is not demanded at all — no pivot workload demands a topic's
last activity. Link removal and the unrelated sibling edit
read nothing, in any lift: 0 body reads and 0 attempt reads for the whole
phase. The control for those two zeros is in the same case and the same run,
where initialization reads 1,163 and grows with the board — 193, 769 and 3,073
for the pivot alone across the three sizes.

## Rendering: no instrument here produces a figure

The plan names rendering as one of four costs to separate, and describes it as
the derivations a topic performs for active comments, active links, presence
booleans, and link-resolution inputs. **Neither tier produces a figure for
them, and this record has none to give.**

In the headless tier they never run. The fixture starts the four lifts directly
over emulated storage and instantiates no pattern body, so the derivations that
rendering performs never start, and are absent by construction rather than
measured at zero. Its `other` bucket holds the runs that do start outside the
four lifts, sinks and builtins among them.

In the browser tier they do run, and nothing attributes them. `hasLinks` and
`hasComments` are `computed(...)` expressions inside the topic's body
(`packages/patterns/topics/topic.tsx`), and `mentionsOf`, `createdByOf` and
`cardsByActivity` are lifts the helper does not track. All of it falls into the
sample's `remaining` row, which the helper aggregates without keeping any run's
identity. What survives of a run in that row is a count and a cost.

Two changes would close it, and both are instrument work this record does not
do:

- **Retain identity for a run the sampler aggregates.** In
  `packages/patterns/integration/topics-browser-measurement.ts`, a run whose
  marker carries no source location is added into `sampling.withoutSource`.
  Keeping something per run — a location, or a key — is what would let the
  rendering derivations be told apart from the rest of `remaining`.
- **Archive the helper's timing rows.** The sampler already records a
  `vdomApply` row, the main thread's `vdom-applicator/apply-batch` span. No
  timing row of any kind is in the browser results file, so none is available
  here. That row is also not the whole of rendering: Lit element updates, style,
  layout and paint have no timing of their own and fall only in the elapsed
  time.

## The browser tier's counters

Both client-execution rounds of the navigation bench produced identical
counters. The `backlink` segment, which opens the topic the most siblings cite
on a 30-topic board:

| lift | runs | proxy accesses | link resolutions | distinct documents |
| --- | --- | --- | --- | --- |
| `crossrefTable` | 1 | 67 | 163 | 122 |
| `backlinksOf` | 1 | 66 | 157 | 93 |
| `presentCommentCountOf` | 1 | 1 | 1 | 2 |
| `lastActivityOf` | 0 | 0 | 0 | 0 |

Its `remaining` row holds 46 runs and 668 proxy accesses, 26 of those runs
carrying no source location, and the largest single run in it made 279 of the
668. The scheduler graph went from 1,674 nodes and 3,473 edges to 912 and
1,586.

The `comment` segment, a warm update, ran `presentCommentCountOf` once for 3
proxy accesses and none of the other three lifts; its `remaining` row holds 31
runs and 20 proxy accesses, 24 without a source location, and it committed one
event. Its graph went from 889 nodes and 1,538 edges to 933 and 1,655.

`lastActivityOf` reads zero runs in both segments. Its control is in the same
sample: the three lifts beside it ran.

Per-lift durations are the part that moved between rounds. `crossrefTable` took
12.3 and 8.5 milliseconds, `backlinksOf` 4.0 and 3.0, against elapsed times of
338 and 243 milliseconds for the `backlink` segment and 139 and 105 for
`comment`. Read accounting and telemetry were on around those elapsed times.

## The reopen workload: a measured zero

A reopen on a 100-topic board completes no run carrying an authored source
location, in either client-execution round: all four lifts read zero runs. That
is the result rather than a gap in the instrumentation, and the plan's
browser-tier requirement to count producer and consumer work separately has
nothing to separate for this workload.

The two rounds' own controls differ, which is why they are given separately.
One round's `remaining` row carries 1 run of 19 proxy accesses, recorded inside
that round. The other's `remaining` row is also zero, and what establishes its
instrument was live is the graph it built: 2,284 nodes and 3,989 edges, from
5,587 and 11,961 before the operation.

### The trials behind that shape

**These figures have no data file.** They are carried here from
`docs/development/BENCHMARKS.md` at `02b5a4694a` (#7684), which is their source
of record, and they are the one set in this report a reader cannot check
against a file beside it. All three were taken against a local toolshed with
client execution. `BENCHMARKS.md` keeps the rationale they support — why the
sample's `mayRunNothing` declaration waives one failure and not the other.

The first asked whether the absence belongs to the operation or to where the
interval is drawn. Four boundaries, each a re-open within one live runtime
client, on an eight-topic board with citations:

| boundary | attributable runs |
| --- | --- |
| open a topic already opened once, from the board | none; 1 scheduler run |
| a third visit to the same topic | none; 0 scheduler runs |
| reopen with another topic opened in between | runs carried a read sample, but no source location |
| the whole round trip, topic to board to topic | `lastActivityOf` once; the other three lifts not at all |

Only the last yields a lift run, and for the return leg: measuring the return
to the board on its own records that same single `lastActivityOf` run with the
same counters, while the reopen beside it records none.

The second classified the runs, because a reopen at first refused the
read-accounted sample on every attempt — by the attribution check on 14 of 20
trials at a hundred topics and 19 of 20 at eight, and by the old no-runs guard
on the rest. Across 32 reopen trials and 16 first-open controls in the same
environment, every reopen run that carried a read sample carried no source
location and none carried one that failed to parse, while the first opens
carried 416 parseable locations and attributed three lift runs on every one of
the 16 — 260 parseable locations across the ten controls at a hundred topics
and 156 across the six at eight. A first open also carries runs without a
location, 216 and 126 of them, alongside its parseable ones. Those two
observations do not conflict, and the reason is the whole point of the second
trial: the attribution check fails a sample only when everything it is given
fails to parse, so a first open passes it on the strength of its parseable
locations, while a reopen, whose runs without a location were the whole
population rather than part of it, had nothing for the check to place.

The third is the outcome: with the two cases told apart, 20 trials of the
hundred-topic reopen recorded 20 zeros and no refusals. Thirteen saw one run
carrying no source location and seven saw none at all.

### Reopen means two different operations

The headless tier has a phase of the same name and it is not the same
operation. It disposes the runtime, opens a fresh one over the same storage
manager, and starts the demanded lifts again, so it re-runs the work. Through
the representative 128-topic case, reopen reads 1,164 proxy accesses over three
runs, against initialization's 1,163 over nine. The browser's reopen keeps its
page, shell, worker and runtime client throughout. Neither is a reconnect:
inducing a transport reconnect needs a storage relay the Benchmarks workflow
does not run, so a browser reconnect is unmeasured.

## Delivered documents, which nothing gates

What a topic loads at start is decided by the declared parameter of each
consuming computation rather than by what a body reads, so a candidate can move
every read figure above without moving delivery, or the reverse. T0's
instruments cannot see delivery: they count runtime reads in one process over
an emulated storage manager, with no memory server.

The figures below come from a separate rig on the
`experiment/topic-own-entry-lookup` branch, whose head `9c1bc1aa33` is on
`origin` and is where the result files are committed. **The runs themselves
were taken at `bc23e3c6d0`**, which each result file records as its head, with
the working tree otherwise clean; that is the revision a reader checking a
figure needs. Its `current` arm is `packages/patterns/topics/main.tsx` as it
stood there, with lazy materialization on and server execution off. On its
board, topic k for k from 1 to N-1 mentions topics k+1 through k+2 modulo N,
and topic 0, the one measured, mentions nothing; the probe instead sweeps
mention shape and degree. So this is a second baseline of the same system and
not another point on the tables above.

What one topic's start delivers, from each file's `start` phase — the phase
matters, because the same fields read differently over `startAndPull`:

| topics on the board | other-topic documents | other topics | other-topic bytes | documents in all | bytes in all |
| --- | --- | --- | --- | --- | --- |
| 4 | 3 | 3 | 113,070 | 187 | 264,137 |
| 10 | 9 | 9 | 339,210 | 211 | 498,891 |
| 40 | 39 | 39 | 1,469,910 | 331 | 1,672,761 |

**Nothing gates this measure today.** The read and graph limits beside the
headless read-budget test gate runtime reads; no limit anywhere gates delivered
documents. A candidate could therefore pass T5's acceptance while leaving this
cost untouched. Whether delivery joins the gated measures is T2's decision.

## The gated measures, and one thing their table does not record

`packages/patterns/integration/topics-read-budget-limits.ts` holds the gated
limits, derived at `aeffec09a3` (#7527) and not re-derived since. Eleven cases
are gated, each on five counts in each measured phase: attempt-boundary proxy
accesses, body-boundary proxy accesses, the most any one body made, and the
settled graph's nodes and edges. The limits are kept there rather than here
because they are checked by a test that sits beside them.

No entry in that table is marked ungated, which establishes that every gated
count repeated identically across the five derivation rounds; the command
prints a count that varied as ungated instead of as a limit.

**The table cannot record whether the negative controls passed.** The plan
requires every gated measure to have a regression variant that exceeds its
limit, and the command runs those controls — but in
`scripts/topics-computation-cost.ts`, `limitsModuleSource` is printed before
`deriveControls` is awaited, so the artifact is written before the control pass
runs and could not carry its result whichever way it fell. Today the control
pass is asserted by the procedure rather than recorded by the artifact. That is
an ordering problem in the derive command, and fixing it belongs with whoever
owns that script.

## What neither tier measured

- **Server execution's cost.** The headless fixture runs over an emulated
  storage manager in one process with no memory server, so the ON posture's
  serving loop has nothing there to engage; identical counters under that flag
  would not mean the posture makes no difference. The browser tier can run both
  postures and did, and its counters are recorded, but it cannot yield a
  latency comparison: the rig co-hosts the toolshed it measures against, and
  under ON that toolshed derives, so its work competes with the browser it
  serves. Measuring that needs the server off the browser's hardware.
- **The board-alone workload.** The probe records it as not measured, for the
  reason quoted above.
- **A reconnect**, for the reason given above.
- **Network bytes and subscription events**, which neither tier counts.
- **Any posture but the default.** Every headless figure here was taken with
  lazy materialization pinned on and server execution off, which is what the
  probe's mode records. The browser rounds record server execution off and no
  lazy-materialization setting at all, as the section on that tier says; this
  record does not state what they held. The headless tier can measure lazy
  materialization off, and the effect of doing so is recorded separately; no
  headless figure here is from that posture.

## Where the startup and latency limits went

The plan asks T0 for numeric startup and latency limits and says they are
recorded in its measurement-and-acceptance section rather than here or in a
code table. They are there, and they are not gated in continuous integration.
Each one is derived from the browser figures this record's data file holds,
under client execution, and the `startupAndLatencyDerivation` block beside this
file carries the observations and the arithmetic behind each.

## T0's deliverables

Every T0 deliverable the plan lists is landed: the headless fixture (#7473),
the probe and its baseline (#7484, with the baseline arm recorded on
2026-09-18), the read-budget test and the negative controls its derivation
command runs (#7527), the browser instrumentation (#7490), the browser
workloads (#7684), the browser demo (#7673), and this report. Nothing in T0
remains outstanding. The instrument gaps this record names — rendering
attribution, archived timing rows, and the derive command's control ordering —
are work for whoever takes them, not unfinished T0 deliverables.
