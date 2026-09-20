---
status: historical
created: 2026-09-19
archived: 2026-09-19
reason: "Measurement of the Topics browser benches under server execution on and off, with the feasibility findings that preceded it."
---

# Topics computation cost under server execution on and off

The browser tier's server-execution arm: both Topics benches run under both
postures, alternating, for the "Measurement and acceptance" section of
`docs/plans/topics-computation-cost.md`, which asks for both postures measured
before the baseline report in runs labeled by mode.

The data is in
[`2026-09-19-topics-server-execution-browser-arm.results.json`](2026-09-19-topics-server-execution-browser-arm.results.json)
beside this file. Each section below says which part of it that section's
figures come from, and names anything it states that the file does not hold.
Sourcing is stated per section rather than once here, because a single claim
covering everything is a claim over a population nobody enumerated, and it
outruns the file the moment one figure in one section comes from somewhere
else. This record says what was measured and under what conditions; the
interpretation belongs to the baseline report.

## Read this before the figures

Two limits bound what the numbers below support, and both are easier to apply
before reading them than after.

**The counters and the timings are not equally good.** The counters are the
result, and the navigation bench's were shown to reproduce across
independently seeded boards; the scale bench's reopen sample was not, and the
section on reproducibility bounds the claim. The timings are confounded and
support no posture conclusion; the section that gives them says why.

**The client's and the server's work are counted in different units.** The
browser's read accounting counts lift *runs*. The serving loop counts derived
*commits*. They cannot be summed, and no ratio between them means anything. No
statement here compares their magnitudes, and one cannot be assembled from the
figures by dividing.

## What ran

*Source: `rounds`, and `postureReadbacks` for the posture each round read.*

`topic-board-navigation.bench.ts` at 30 topics and `topic-board-scale.bench.ts`
at its default limit of 100, at `784a1e3a68`, under two alternations of both
postures: eight rounds in all.

Sizes were chosen rather than defaulted into. Navigation runs at 30 because
that is the size CI charts, so these figures sit beside the dashboard's own
series, and because at that size the board carries the crossrefs and backlinks
that are the Topics-specific work. Scale runs at 100 because its larger
declared sizes are skipped and because a 100-topic seed costs minutes.

The two postures are two artifacts, not one artifact with a flag: the shell's
posture is a build-time define, so each arm ran a separately built toolshed
binary serving its own baked shell. Every round read its posture back through
`readDeclaredTopicsBrowserPosture` before measuring and would have been skipped
rather than measured had the read not returned the mode that round was taking.
All eight returned it.

Each round ran against a fresh empty store, so no round inherited another's
state and no ON-arm derivation could reach an OFF arm.

## The located-lift counters do not change with the posture

*Source: each round's `samples[].lifts`.*

The navigation bench's located lifts, in each of its two rounds per posture:

| segment | lift | ON (2 rounds) | OFF (2 rounds) |
| --- | --- | --- | --- |
| `backlink` | `crossrefTable` | 1 run, 67 accesses, 163 hops | 1 run, 67 accesses, 163 hops |
| `backlink` | `backlinksOf` | 1 run, 66 accesses, 157 hops | 1 run, 66 accesses, 157 hops |
| `backlink` | `presentCommentCountOf` | 1 run, 1 access, 1 hop | 1 run, 1 access, 1 hop |
| `comment` | `presentCommentCountOf` | 1 run, 3 accesses, 2 hops | 1 run, 3 accesses, 2 hops |

`lastActivityOf` runs zero times in both segments under both postures.

The scale bench's four rounds are not in that table because they contribute no
located-lift work to compare: its `reopen 100, reads` sample reads zero runs
across all four lifts in every round, under both postures. That zero is the
reading its `mayRunNothing` declaration anticipates, and the section on
instrument liveness says what establishes it was recorded rather than missed.

The client runs its derivations under either posture. That is what
[`speculation.md`](../../../specs/server-side-execution/speculation.md) states
of a flag-ON client: "The ordinary client runtime runs the full graph; v2 does
not add a speculation engine — it REDIRECTS the existing run's writes into an
overlay instead of a storage transaction." These counters are that behavior
observed.

## A countable set of unattributed runs is absent under server execution

*Source: each round's `samples[].remaining` and `runsWithoutSource`.*

The located lifts above are not all the work a sample sees. A run whose marker
carries a source location is attributed to its lift; every other run falls into
a `remaining` row. That row differs between the postures, and the difference is
concentrated rather than spread.

Each figure below is identical in both of its posture's rounds:

| segment | posture | remaining runs | runs without source | remaining accesses | max accesses in one run |
| --- | --- | --- | --- | --- | --- |
| `backlink` | OFF | 46 | 26 | 668 | 279 |
| `backlink` | ON | 42 | 22 | 114 | 79 |
| `comment` | OFF | 31 | 24 | 20 | 4 |
| `comment` | ON | 29 | 22 | 20 | 4 |

Three things hold together. The remaining-run difference is 4 in `backlink` and
2 in `comment`. In each segment that difference equals the runs-without-source
difference exactly and independently — 4 = 4 and 2 = 2 — rather than only in
the sum of the two segments, where offsetting differences could agree by
accident. And the whole of the 554-access difference falls in `backlink`, whose
largest single run drops from 279 accesses to 79, while `comment` carries the
same 20 accesses under both postures despite its two-run difference.

So the difference is a small countable set of runs that do not happen under
server execution: four fewer in `backlink`, which carry 554 fewer accesses
between them, and two fewer in `comment`, which carry none that this sample
can measure. The absent runs are exactly the ones that had no source location.

No per-run figure is available, and dividing the 554 by the four would invent
one. The sampler aggregates source-less runs, so there is no distribution over
those four to divide — and what can be seen of the population they came from
says it is not uniform: the OFF `backlink` row's largest single run is 279 of
its 668 accesses, 42% of the row in one run of 46.

**What those four runs are is not recorded, and identifying them needs an
instrumentation change.** A run carrying a source location is bucketed under it
and keeps its identity; a run carrying none is added into a single aggregate
(`topics-browser-measurement.ts`, where `marker.src === undefined` selects
`sampling.withoutSource`). The absent runs are in that aggregate by definition,
so what survives of them is a count and a cost, not an identity. Retaining
anything further about a source-less run is the work someone would have to do
to answer what they are.

A second reason not to describe the row loosely: `remaining` is a union of two
populations — runs with no source location, and runs whose location is outside
the four lifts being tracked. Only the first moved here.

## The navigation bench's counters do not change with the board

*Source: `determinism`, which holds the compared field values, and each
round's `boardIds`.*

`packages/patterns` seeds a fresh board per bench process, and the piece ids it
mints differ from one seed to the next. Whether that moves the counters is
therefore a question about every figure above.

It does not, in the navigation bench. Comparing the two rounds of each posture
field by field — four lifts times six counters, the remaining row, the
runs-without-reads, runs-without-source and event-commit counts, and the graph's
node and edge counts before and after, across both segments:

| posture | fields compared | matching | differing | matching and non-zero |
| --- | --- | --- | --- | --- |
| OFF | 74 | 74 | 0 | 47 |
| ON | 74 | 74 | 0 | 47 |

The non-zero column is the one that carries the claim: a sparse table can agree
almost entirely through empty rows, and 47 of these agreements are between
figures that are not zero, among them 668, 343, 279, 256 and 3473.

The four boards were distinct. Each round seeded its own into a fresh empty
store, and the board and comment-board ids each round minted are recorded per
round in the results file, where the four differ.

**This is a claim about the navigation bench.** The scale benchmark's
`reopen 100, reads` sample recorded one remaining run of 19 accesses in one OFF
round and none in the other, so it is outside the claim.

Its `mayRunNothing` declaration is not what excuses that. `recordReopenReads`
bounds the declaration to the located-lift rows — a reopen is expected to
complete no run carrying an authored source location, and the declaration
"reaches only that one outcome" — whereas what varied here is the source-less
population the `remaining` row holds, which that declaration does not speak to.
Both rounds' located-lift rows read zero, as the declaration anticipates. The
`remaining` row simply varied, and nothing in the benchmark asserts it would
not.

## Every arm's instrument was demonstrably live

*Source: each round's `samples[]`.*

Several figures above are zeroes, and a dead instrument produces the same
zeroes as an absence of work. Each arm therefore carries a non-zero figure of
its own. The control is drawn from inside the arm being checked rather than
from the other posture: the other posture is a different deployment, and its
instrument working says nothing about this one's.

All eight rounds carry one, and they divide three ways: the four navigation
rounds on their non-zero lift runs, accesses and link resolutions; three of the
four scale rounds on their remaining row; and the fourth on the graph it built.

Two of those needed the control to be scoped to its own arm rather than drawn
from the other posture, and they are the reason it is worth the trouble:

- `r1-on-scale` reads zero across every located lift. It is the round whose
  board-load case failed, so its arm was degraded, and the check still
  separates a degraded-but-live instrument from a dead one: its remaining row
  carries 1 run of 19 accesses, recorded inside that same ON round.
- `r2-off-scale` reads zero across every located lift *and* zero in its
  remaining row. What establishes its instrument was live is the graph it
  built: 2,284 nodes and 3,989 edges.

A control drawn from the other posture would have cleared both of these using a
different deployment's evidence. `r1-off-scale` and `r2-on-scale` likewise read
zero across their located lifts and carry a non-zero remaining row.

## The serving loop runs, and only under ON

| round | client lift runs | client accesses | server waves | server derived commits |
| --- | --- | --- | --- | --- |
| `r1-off-nav` | 4 | 137 | absent | absent |
| `r1-on-nav` | 4 | 137 | 631 | 631 |
| `r2-off-nav` | 4 | 137 | absent | absent |
| `r2-on-nav` | 4 | 137 | 605 | 605 |
| `r1-off-scale` | 0 | 0 | absent | absent |
| `r1-on-scale` | 0 | 0 | 846 | 846 |
| `r2-off-scale` | 0 | 0 | absent | absent |
| `r2-on-scale` | 0 | 0 | 817 | 816 |

*Source: each round's `servingLoop`, absent on the OFF rounds.*

`absent` is not zero. The OFF binary constructs no `ExecutorHost`, so
`/api/health/stats` carries no `servingLoop` block at all to read a zero from.
That is a sharper statement than a zero reading, and it is what makes these two
artifacts differ in mechanism rather than in a reported string.

Every ON round reported `structureLoadFailures` 0. That is not the same as the
arm having run without incident, and two other counters should be read beside
it rather than left for someone who can no longer go and look. The two ON
navigation rounds report `foreignWriteRefusals` of 17 and 21, and
`r2-on-scale` reports `lease.lost` 2; `foreignEngineFailures` and
`supersededWrites` are 0 throughout. So write actions were refused in the arm
whose counters are compared above.

This record attributes nothing to that. What can be said is that the located
lifts those refusals sit beside are identical between the postures and
reproduce across boards, and that the refusal counts are themselves close
between the two rounds that have them, which is the shape of a property of the
workload rather than of a disturbance. Whether they are expected under this
posture is a question for someone who owns the serving loop.

So: the client's located-lift work is unchanged between the postures, and under
ON the server additionally performs derivation commits that have no counterpart
in the OFF arm, where no serving loop exists. The two halves are counted in
different units and the paragraph at the top of this record says why no
magnitude follows.

## This rig cannot measure server execution's latency at all

*Source: each round's `cases` for the timings, `loadByArm` and `loadSeries`
for the load.*

Comparing each round's mean, seven of the ten timed cases separate between the
postures, six of them with ON slower. The count is not stable under the choice
of statistic: on each round's 75th percentile it is eight and seven, and on
each round's fastest iteration four and four. One of the ten, the scale
benchmark's board-load case, has a single ON round rather than two, its other
having failed — the conditions section says how, and that case carries no
counters either way. None of it is usable anyway, and the reason is not that
this machine was busy. It is that the rig cannot hold the two postures to the
same conditions.

**The arms did not run under the same load.** One-minute load average, pooled
over each posture's rounds, against 10 logical CPUs:

| bench | posture | median | mean | max |
| --- | --- | --- | --- | --- |
| navigation | ON | 24.45 | 44.11 | 126.49 |
| navigation | OFF | 19.15 | 26.36 | 69.88 |
| scale | ON | 42.70 | 56.53 | 253.16 |
| scale | OFF | 21.13 | 22.67 | 52.02 |

Alternating the arms and counterbalancing their order within each alternation
protects a comparison against drift and against position. Neither protects it
against the machine being busier during one posture than the other, which is
what happened.

**And the rig cannot separate the posture from its own cost.**
[`BENCHMARKS.md`](../../../development/BENCHMARKS.md) says of these benchmarks
that "they run against a toolshed this same job started, and contention between
the browser and that server sits inside their numbers with nothing to subtract
it against". Under ON that co-hosted toolshed performs the 605 to 846 derived
commits tabulated above, which the OFF toolshed does not perform at all. Its
work competes with the browser it is serving, for the same ten CPUs.

That second reason is structural, and three things follow from it.

**A quieter machine does not fix this.** The contention is between the two
halves of the rig, not between the rig and whatever else the host is doing. On
an otherwise idle machine the ON arm's browser still shares its CPUs with a
serving loop deriving, and the OFF arm's browser shares them with a toolshed
that derives nothing, because the OFF binary builds no `ExecutorHost`. Both
arms carry the ordinary contention with a toolshed that
[`BENCHMARKS.md`](../../../development/BENCHMARKS.md) describes; only the ON arm
additionally carries that toolshed's derivation. The asymmetry is a property of
the design rather than of the afternoon.

**It is not a defect in the benchmarks.** They were built to measure
client-side cost with a toolshed as a fixture, and for client execution that is
sound: the fixture serves data and does no derivation. Server execution breaks
the assumption the design rests on, by giving the fixture work that grows with
the thing being measured.

**Measuring this needs the server off the browser's CPUs.** That is a
requirement on hardware, not on scheduling, and it is the constraint to plan
against for any later evaluation of a candidate on this axis. The counters in
this record stand on their own and do not need repeating; the latency question
needs a rig this tier does not currently have.

Whether the higher load during the ON arm was unrelated work or server
execution's own is not separable here, and it does not need to be: neither
licenses a posture claim.

The scale benchmark's ON arm ran at roughly double the OFF arm's load median,
21.13 against 42.70. Nothing here attributes any share of that to the serving
loop, and the difference is not evidence of a magnitude: the two medians are
pooled over windows of very different length, the ON scale rounds having run
547 and 541 seconds against the OFF rounds' 191 and 202, so they summarise
roughly 2.7 times as much time and as many samples. The observation is that the
arms ran under different conditions, which is why no comparison between them is
offered.

The machine also sets a floor under any latency claim made on it. The four
100-topic seeds these rounds performed, identical work each time, took 146.5,
147.8, 242.0 and 285.8 seconds.

## What the environment had to be shown to do first

The plan left open whether the browser benchmark environment — a built
toolshed binary serving a baked shell, driven by Chrome — runs a coherent arm
at all. That was settled before any round ran, and separately from what the
rounds found.

*Source: `postureReadbacks` and each round's `posturePayload`;
`machine.browser` and `machine.sandbox` for the browser and the session.
Two things in this section were observed on a terminal and are not in the
results file: the launch probe's own steps, and the refusal described at the
end. The refusal is a property of the reader named there.*

Chrome launches under Astral in the session that ran this, which had to be
shown rather than assumed: a browser failing to start inside a macOS agent
sandbox is an artifact of the sandbox and not a result, so a measurement whose
record is silent on it leaves a reader unable to tell a checked environment
from an unchecked one. The session was established as unsandboxed by what it
could do — writes outside the workspace, Apple Events, the GUI launchd domain,
direct network — and a headless launch through the repository's own
`Browser.launch` then selected the installed Chrome, navigated a `data:` URL,
read a user agent of Chrome 153 back out of the page, and closed. Every one of
the eight rounds below launched browsers through that same path.

A toolshed binary built with `EXPERIMENTAL_SERVER_EXECUTION=true` serves a
deployment whose posture reads back as declared: `/api/meta` reports both
`serverExecution: true` and a baked `shellServerExecutionDefine` of `"true"`,
and the served bundle carries the same define, so both halves state the posture
and agree on it. The same binary built at `false` reads back declared at
`server-execution-off`, and carries no `servingLoop` block.

The reader that returns those answers refuses when it should. Pointed at a
deployment that declares nothing, it refused rather than labeling — "the
toolshed names no baked define and the served shell's entry script carries no
define" — and that deployment served an entry script normally, so the refusal
was the define being absent rather than the fetch failing.

## Turning server execution on over an existing store fails to start a piece

*Source: `upgradeHazard`, and `quiescenceProbe` for the 100-topic row.*

A serving loop handed a store that was authored under the OFF posture does not
start the home space's profile piece. The piece-start commit is refused with
`StorageTransactionInconsistent`: the stored value's `profiles` link reads
`["defaultPattern","profiles"]` where the starting graph computes
`["profiles"]`.

Holding the board size fixed and varying only where the store came from:

| store handed to the ON server | waves | derived commits | structure load failures |
| --- | --- | --- | --- |
| seeded under ON, 8 topics | 12 | 10 | 0 |
| seeded under OFF, 8 topics | 12 | 12 | 1 |
| seeded under OFF, 100 topics | 77 | 78 | 1 |

This is not an artifact of the measurement rig. An OFF-authored store met by a
server with execution enabled is what any deployment turning the flag on over
existing data would present, so this describes the upgrade path. It is also why
the arms above seed each round under the posture that round measures. All four
ON rounds report zero structure-load failures; the four OFF rounds report no
such counter, having no serving loop to keep one.

`structureLoadTerminal` is not a failure count, and is not what moved above. It
counts demanded roots confirmed synced with no pattern meta, which the demand
cycle stops retrying — plain value documents, the "never" half of the
not-yet-versus-never distinction (`packages/runner/src/executor/stats.ts`). The
arms rounds record it between 2,194 and 4,457 with no structure-load failure
anywhere among them. It was not captured for the 8-topic probes above, so this
record makes no claim about it there.

Separately, a serving loop derives nothing from a store handed to it until
something demands that store. Over a restored OFF-seeded store an ON toolshed
held at zero waves, zero derived commits and zero active spaces across the
eleven samples of the probe's idle phase, spanning its first ten seconds, and
moved only once a client loaded the board.

## Conditions, and what shaped the run

*Source: `loadSeries`, `swapSpotObservations`, `design.stoppingRule`, and each
round's `seeds`.*

The measurement ran on a shared developer machine, 10 logical CPUs, under
unrelated load throughout. The full load series is in the results file.

Memory pressure was episodic rather than steadily worsening, and it tracked
seeding: free swap fell while a 100-topic seed held its heap and recovered when
the seeding child exited. Twelve readings taken by hand during the run span
569 MB to 1,633 MB of 47,104 MB. They are spot observations rather than a
series — the results file records them as such, and unlike the load series
they show a range rather than a distribution. A stopping rule was set in
advance to
halt cleanly after the round in flight if free swap fell below 400 MB. It never
fired.

One case was lost. `r1-on-scale`'s board-load case failed with a runtime login
timeout at a round load median of 36.33 and a maximum of 93.08. The same case
completed under OFF minutes later at a median of 26.45, and again under ON in
the second alternation, so what this records is a case failing under load and
observed under ON, not a posture effect. Under memory pressure the login did
not fail so much as run out of budget, which is the general hazard of a
timeout: work that would have completed cannot, once the bound is reached. This
particular case carries no read accounting — the scale benchmark's read
accounting attaches to its reopen sample alone — so what the failure cost was
a timing, and the counters are complete.

Seeding is itself a heavy load source, and under this design it is not
separated from the timed work. Each bench process seeds its own board: the
navigation benchmark seeds its main board before any case runs, but seeds its
comment board lazily, inside the run, when the `comment` case first executes.
Across the four navigation rounds that seed took 15.0, 15.4, 23.8 and 43.5
seconds, and it lands between the `journey` and `comment` segments, so the last
two of the eight segments are measured on a machine that has just finished it.
Alternating the postures puts that effect on both arms rather than removing it.

The third alternation was dropped deliberately. Alternation and counterbalanced
ordering exist to protect a timing comparison, and that comparison was already
established as unusable, so a third pass would have strengthened nothing that
could be used. The counters need two samples per posture to show whether the
board's nondeterministic ids move them; alternations 1 and 2 supply those, and
the field-by-field agreement above is what they showed.
