---
name: perf-investigation
description: Investigate Common Fabric slowness end to end — measure it, attribute it to a phase and then to a cause, and land the fix wherever it turns out to belong. Use when something is slow, when it gets slower as the data grows, when asked to profile, benchmark, or measure a scaling curve, or when a performance fix needs proving rather than asserting. A slow pattern is the usual entry point; the cause is as often in the runtime.
---

# Performance Investigation

Two neighbours carry the halves this does not.
`docs/development/PERFORMANCE_PROGRAM.md` is why we spend this time at all and
what we consider worth speeding up. `docs/development/debugging/profiling.md` is
the walkthrough — the steps in order, with the commands. This skill is the map
they are read against: what each instrument reaches, what it is blind to, and
what the answers here have historically turned out to be.

## A slow pattern is an instrument, not the defect

The pattern in front of you is where the investigation starts, not where it
ends. On the board work this skill is drawn from, the wins split roughly evenly
between pattern changes and runtime changes — and which one a given symptom
would turn out to be was not knowable before measuring. Several runtime fixes
closed a footgun the pattern had merely been first to step in.

The clearest single number for why: in a CPU profile of fifty topic creates, the
topics pattern's own frames were 0.1% of self time and 11.6% of inclusive time.
A pattern body is a thin shell over runtime primitives, so "make the pattern do
less" only ever cashes out as "make it ask the runtime for less" — and that
ratio is one pass to measure on whatever you are holding.

So expect any of three outcomes, often more than one from a single
investigation:

- the pattern changes;
- the runtime changes — usually spun off as its own task, so a pattern PR does
  not quietly grow a runtime refactor;
- `skills/pattern-dev/SKILL.md` or `skills/pattern-critic/SKILL.md` gains a
  rule, when the pattern was written the way anyone would have written it and
  the cost was invisible at authoring time.

That third outcome is the highest-value one and the easiest to skip, because by
then you understand the problem and it no longer looks like a trap. If an
investigation ends with only a pattern fix, ask what made the cost invisible —
the answer is usually a rule worth writing down, and sometimes a runtime change
that makes the cheap spelling the natural one.

## Instruments, cheapest first

Each rung sees something the rung below cannot. Climb only as far as the
question needs, and stop as soon as an instrument answers it.

**Pattern test.** `deno task cf test <file> --verbose --stats-threshold 0`
prints the logger's timing and count rows per step with no browser, no shell,
and no rendering. `--stats-include` rescues named categories from the top-ten
truncation rather than from the threshold — a step faster than the threshold
still prints nothing at all, so keep `--stats-threshold 0` when every step has
to report — `--stats-action-limit` controls how many per-step scheduler action
deltas print, and `--storage-stats` adds the storage rows. This is the fastest
way to see a read count explode, and it needs no conversion work.

Its counts are exact; its milliseconds are not the product's.
`packages/cli/lib/test-runner.ts` enables idempotency verification by default.
Use `--no-idempotency-check` for timing experiments so verification replay does
not distort the measurement. Keep verification enabled for correctness checks.
The single-runtime runner also reports per-step read costs, including work
triggered by assertions and render steps; `packages/cli/README.md` defines each
counter and its measurement boundary.

**Browser integration test.** What the pattern test cannot see: rendering, the
main-thread/worker split, IPC, cold load, and anything about how cost scales
with what is on screen. Promote the test using
`skills/pattern-test-to-integration/SKILL.md`, which owns that conversion and
the scale knob the measurement below depends on. Then instrument it from
`packages/patterns/integration/cfc-browser-helpers.ts`: `StepTimer` and
`logStepTimings` for phase wall-clock, and `collectBrowserLoadSummary` for the
worker's scheduler/runner/storage rows plus main-thread IPC.

**Benchmarks.** For anything that must stay fast, a bench file is how it is
defended; `docs/development/BENCHMARKS.md` owns that lane, including
`packages/patterns/integration/topic-board-scale.bench.ts`, which measures a
board's cold load across sizes and documents why its larger sizes are declared
but skipped. Read it before adding a bench rather than inventing a shape.

**The transformer's emitted schema.** A derivation's cost often starts with how
much it declared it would read. `deno task cf check <file> --show-transformed`
shows what the pattern actually compiles to, and the emitted schema's size is a
usable proxy for read width — a board derivation that reads the whole space and
one that reads a length differ by orders of magnitude in emitted characters.
This catches a class the timers only see downstream of.

**A `cf` invocation, in-process.** The CLI is a Deno process like the test
runner, and `skills/perf-investigation/scripts/profile-cf.ts` runs one command
inside a process that writes what it measured: the logger's timing statistics
and counts, the spans under `CF_TIMING_MEASURES`, and, with `CF_PROF_CPU=1`, a
V8 CPU profile. `profile-toolshed.ts` beside it profiles the serving toolshed
over its inspector port for exactly the command's lifetime and differences
`/api/health/stats` around it. What neither says is what crossed the wire:
`CF_MEMORY_FRAME_LOG` records every frame the memory client sends and receives,
and `summarize-frame-log.ts` reads a capture back as watches, documents
delivered, and commits — `docs/development/debugging/profiling.md` says how to
pair them. On the Topics board this rung is where a survey that printed 60 KB
was found receiving 25 MB, and
`docs/history/development/performance/2026-09-cf-cli-topics-board-cost.md` is
the worked case.

**The deployed thing.** Every rung above is a rig you built, and a rig can
measure itself (see "What your harness holds live"). The board the team actually
uses is one `cf` command away — `skills/topics/SKILL.md` names it — and a single
call against it is the cheapest disconfirmation available for anything you are
about to file as an artifact of your setup. Use it that way rather than as a
measurement: it is shared, its timings carry whatever else is happening to it,
and its client sits idle for most of a read, so it settles whether a cost is
real long before it says how large.

**The server's own stats.** `/api/health/stats` on whichever toolshed the rungs
above are talking to reports that process's timing statistics, log counts and
slow queries, and — when it is serving — the serving loop's counters. One
request, no harness, and under the `serverExecution` ON arm it reaches where
most of the work now is. "The server side" in
`docs/development/debugging/profiling.md` has the requests and the fields; the
next section here is what to know before making them.

## Which process is doing the work

`serverExecution` decides where a derivation runs, and a measurement taken
without knowing which arm it was on describes neither. Under the ON arm servers
do the compute that is stored, clients commit only intent, and a client's own
derivation runs divert into a process-local speculation overlay — an echo. The
registry entry in `docs/development/EXPERIMENTAL_OPTIONS.md` defines both arms;
`docs/specs/server-side-execution/testing.md` binds how they are measured. What
follows is what to have in mind before pointing an instrument anywhere, the
walkthrough's server section being where the requests and their fields live.

**The posture is a fact you check, not one you set.** Which arm a server is on,
and which arm the browser shell was _built_ for, are both one request away — and
a client declares its own posture from its own environment, so a `cf` or a
harness left at its default against a serving toolshed is a mixed posture. That
one is worth recognizing because nothing about it looks wrong: every instrument
keeps reporting faithfully, and what it reports is a configuration that ships in
neither arm, with both ends deriving. Probe both ends before the run and record
what they said beside the number, the way a board size is recorded.

**Read the server's instruments before adding any.** The health route already
reports the serving process's own logger statistics, under the same key names
the pattern-test rung prints and the same ones the client records. So
`scheduler/run/action` and `traverse` exist in both processes and mean different
halves of one interaction, and which process a row came from is the only thing
that distinguishes them. Say which, in every number you report.

**A counter says how often; only a span says by how much.** A counter that fires
when something hits a deadline is a censored measurement: every wave that
overruns the flush budget reports that same budget, however far past it the wave
ran, so the count cannot separate a loop barely over from one an order of
magnitude over. The wave's phases are timed alongside the counters for that
reason, and reading them together is what shows a deadline enforced by a timer
failing to cut synchronous work. Neither replaces the other — the count for
frequency, the span for width.

**Frames are the sync point.** `waitForSettled` in
`packages/runner/src/executor/watermark.ts` resolves when the space's watermark
covers a given commit, riding the ordinary subscription, so it waits on a frame
rather than polling for a rendered consequence. It is what "the server is done"
means under ON, and `runtime.idle()` is not: a flag-ON client goes idle over its
own echo while the durable result is still a wave away, so a harness that timed
a write by awaiting idle is timing the speculation. Every such harness needs
re-reading against the ON arm before its numbers mean anything.

Frames are also a queue, with the two costs any queue has — waiting behind what
is already in flight, and the work itself — and the memory server times them
apart. Only the second is a frame's own cost, so a queue time that dwarfs every
handle time is head-of-line blocking, and it is fixed at the frame in front
rather than at the one that reported it. The same split exists on the push side
one level coarser, over a flush pass rather than a frame, which makes it a bound
on push latency and not a per-frame cost to divide down.

That watermark helper wants a `Runtime`, so it is the Deno-side test process's
instrument rather than the browser's. On the browser rung the equivalent is
already in `collectBrowserLoadSummary`, whose flag-ON rows account for the echo:
how many overlay entries were dropped late, and how many retired on the
watermark backstop rather than on their own consequence mark. The backstop is
the later of the two signals by construction, so its share is a read on how long
the client held a value it had already been told about — which is the half of an
interaction's latency that no server-side counter can see.

**The workload stays uninstrumented.**
`docs/specs/server-side-execution/testing.md` §1 makes this binding for v2
measurement, and it is the one rule here that cuts against the rest of this
skill: probes added to the measured path warm it and understate its cost, which
is how v1 measured itself faster than it was. Under ON the reach is longer than
it looks, because the server runs the same pattern code — a probe added for the
client arm is now also running inside the wave it is timing. Instrument the
runtime and the serving loop, which every arm shares; leave the workload
byte-identical across arms and read the difference from outside.

## The logger names it; the profiler weighs it

Use both, because neither is sufficient and the failure is asymmetric.

The logger's spans attribute only a fraction of the time inside the span they
sit in — on the board work, the scheduler's own spans accounted for roughly a
tenth of `scheduler/run/action`. Elapsed wall-clock on a loaded machine varies
by more than the differences under test. So logger rows tell you **which key,
and how many times**; they do not reliably tell you where the time went.

A V8 sampling profile of the runtime worker does. `CdpWorkerProfiler` and
`renderProfileReport` (`packages/integration/cdp-profiler.ts`, exported from
`@commonfabric/integration`) attach to the worker and produce both a
`.cpuprofile` that Chrome DevTools and speedscope load, and a ranked self-time
report. Two things about using it here: the profiler picks the worker out of the
page's targets by its script URL, and its default sampling period is tuned for a
single interaction — over a window of minutes, a coarser period keeps the
profile inside the CDP message limit while still resolving a millisecond-scale
action. Treat profiling as instrumentation: a capture that fails should report
and let the phase run unprofiled, never fail the scenario.

Share the parts of that wiring nobody varies; copy the rest.
`attachWorkerProfiler`, `startWorkerProfile` and `writeWorkerProfile` (same
module) are the invariant half — finding the worker, degrading to unprofiled
rather than failing, and writing both artifacts — and no measurement has a
reason to spell any of them differently. Everything that encodes the question
stays in the scenario, written out: which iterations or phases to capture, the
sampling interval, the output prefix and label that carry the board size or the
phase, and the environment knob that turns capture on.

`packages/patterns/integration/default-app.test.ts` is the maintained example to
lift from, and that is the reason for the split rather than a full helper: the
half a measurer edits every time has to stay visible where they are already
reading. A perf harness is otherwise throwaway — built for one investigation,
driven by knobs nobody else needs, and not committed — so duplicating the parts
that differ costs less than a seam every future scenario has to be bent through.

## Narrowing, until a phase becomes a source

A phase is a place to look, never an answer. "The seed phase costs four minutes"
is where an investigation starts being useful, and stopping there produces a fix
aimed at a symptom. Keep going until you can name the thing doing the work — a
function, a read, a derivation that re-runs — and say whether it is expensive or
merely frequent.

`docs/development/debugging/profiling.md` has the steps and the commands. Two
things about them are worth knowing before you start, because they decide where
you begin and what you can trust:

- **The timings already exist.** A logger constructed with `enabled: false` is
  quiet, not inert: `timeStart`, `timeEnd` and `time` record into per-key
  statistics without consulting that flag, and the counts behind the logging
  methods increment before it is checked. Read what is accumulating before
  instrumenting anything.
- **Marks only help in the process that emits them.** `cf test` runs in a Deno
  process with no browser; a worker CPU profile comes from a different process
  over CDP. Bracketing a phase is what gives a profile its interval, but the
  bracket has to be on the same side of that boundary as the samples.
- **Every recorded span can put itself on the timeline.** `CF_TIMING_MEASURES=1`
  — or `cf test --timing-measures-out <file>` — makes each logger time span emit
  a `performance.measure` as well as recording into the statistics, across the
  whole stack rather than only what someone wrapped by hand. It is off by
  default because the volume is for a tool, not a person: a topics pattern test
  emits over 800,000 spans, and a human opening a timeline wants the phases
  someone named rather than every span the runtime recorded.
  `skills/perf-investigation/scripts/aggregate-measures.ts` rolls the result up
  by key prefix, which is what the statistics cannot do: a logger records
  against its full joined path and nothing shorter, so the count at the level
  where it starts multiplying exists in no stored row.
- **Some keys name the occurrence too.** A key is a place in the code, so
  `scheduler/run/action` is the same key for every action that runs. Where the
  emitter can say which one, it attaches that to the measure rather than the key
  — putting it in the key would multiply the statistics by every value it takes
  — and `attribute-measures.ts --detail` groups by it.
- **Intervals recover the caller.** A key that runs everywhere is recorded
  against itself whoever reached it, so no aggregate can say who is responsible.
  Spans nest, so the span open when another began is the one that called it:
  `skills/perf-investigation/scripts/attribute-measures.ts` rebuilds that tree
  and answers who, how deep, and how many each caller asked for. Read its ratio
  rather than its totals — few callers asking for a great deal each is a width
  problem, many asking for a little is a frequency one, and they are fixed at
  opposite ends of the stack.

Ask the next question rather than reporting the first table. Who calls it,
frequency or width, is the unit cost flat, and — the one most easily skipped —
who calls the _heavy_ instances, whose callers are routinely not the typical
ones. `docs/development/debugging/profiling.md` carries that ladder. A chain
that reaches uninstrumented ground has produced a result rather than a dead end:
it names where to wrap next.

A chain that reaches uninstrumented ground has not run out of data. The harness
phases that attribution treats as transparent still locate those spans in the
run, and whatever finished immediately before them is a caller nobody wrapped —
`attribute-measures.ts --roots` reads both out of the capture you already have,
and names where the next span would attribute the most.

A measure is an elapsed duration, so summing measures gives cumulative elapsed
span time and never CPU — the sum already contains whatever was waited through,
and a nested span counts the same interval again inside its parent. Only the
sampling profile attributes CPU. Wall time needs the other arithmetic again:
spans must be unioned rather than summed, because concurrent ones overlap and a
parent's elapsed time is not the total of its children's. What the union leaves
uncovered is time something was open and nothing instrumented was running —
waiting, in whatever form — and `skills/perf-investigation/scripts/wall-time.ts`
is what reports it. Absence looks the same whether it is a round trip or
unwrapped compute, so that view says where to look rather than what it found.

A row whose per-call duration barely varies across hundreds of calls is the tell
that its spans were concurrent rather than sequential, and that its total is
therefore not a wall cost: work varies, waiting on one shared thing does not.
`runner/start/resumeCellSync` reads as 111 seconds over 326 calls at a uniform
368ms inside a twenty-minute run; the enclosing
`runner/start/syncCellsForRunningPattern` is four calls totalling 1.97 seconds,
and that is the number. Where a total looks impossible, find the span that
encloses it before believing either.

**You are done narrowing when you can write a benchmark.** A source you
understand can be provoked directly; one you cannot provoke is still a
hypothesis. Confirm it correlates — that it moves with the real measurement
rather than merely being fast — and keep it, because that is what defends the
fix afterwards.

## Count against average

Every logger row carries a count and a set of durations — the `cf test` stats
print `n`, `total`, `avg` and `p95`, and the browser summary adds `p50` and
`max` — and the count against the average is the whole diagnosis: a row whose
`total` grew because `count` grew is a different bug from one whose `average`
grew, and they have disjoint fixes. Read them before forming a theory. Rows are
ranked by `total` and truncated, so a row that measures set sizes rather than
milliseconds will sort above real timings and evict them — read those by name
instead of widening the summary.

## Two ways to be slow, at every level

A call costs what it costs and happens as often as it happens, so every finding
has two fixes available: make the work cheaper, or ask for it less. They are not
alternatives to choose between up front — which one is available is a fact about
the code you have not read yet, and investigations that assume one skip the
larger win about half the time.

Both live at every level of the stack, and neither level is the natural home of
this work. A leaf at the edge — resolving a link, walking a schema, hashing a
value — can often be made cheaper for every caller at once, which is the widest
possible fix and the one that closes a footgun rather than an instance. The
caller can often stop asking: hoist the read, declare a narrower one, split a
derivation so the half that cannot have changed does not re-run. A pattern
usually surfaces the second; the first is usually a runtime change, and is the
reason this work does not end at the pattern.

Look for both before choosing. The cheapest real fix is frequently the one at
the other end of the stack from where the symptom appeared.

## Where cost comes from in this runtime

Seed list, not a boundary — these are the causes this codebase has actually
produced, and the point is the shape of each, so you recognize the next one.
`packages/patterns/topics/main.tsx` carries several of them as comments on the
code that resolves them.

- **The read is too wide.** The transformer shrinks a derivation's input schema
  to the paths it can see the body reach, and gives up when it cannot see — a
  helper call or a dynamic index makes it declare everything, so one derived
  value reads the whole space. The fix is making the read declarable: a
  module-scope `lift` whose parameter type is the bound, iteration that the
  analysis can follow.
- **The read is too often.** A read placed inside a scan materializes its value
  once per iteration. Hoisting it out changes nothing semantically and removes a
  factor of N.
- **Each access costs more than it looks.** Reading an element through a
  reactive array resolves a link every time, so a quadratic scan over one pays a
  link resolution per element per pass. Taking a plain array first is the same
  scan at a fraction of the cost.
- **The invalidation shape is wrong.** A derivation declared over a whole list
  re-runs for every element on any change to any of them. Splitting it so each
  half depends only on what can actually change it — and sampling, where a read
  should register no dependency at all — turns N re-runs per write into one.
- **What you hold live decides what a write costs.** A cell's demand is what
  re-materializes when anything under it changes, and the widest demand is the
  one you get by default: `getResult(piece).sink(() => {})` sinks on the piece
  cell, which carries no schema, so it demands the whole result and every piece
  that result reaches. Nothing in the spelling says so. Applying the durable
  schema and keying into a bounded surface first — a board's `index` rather than
  its result — buys the same liveness for a fraction of the walk. This is a
  cause in product code and a confound in a harness; see "What your harness
  holds live".
- **An append re-walks the list against its element schema.** Appending to a
  growing array is free, and so is appending a piece to one. Appending a piece
  whose declared shape is wide re-walks every element already there, once per
  append, with no reactive fan-out at all — the scheduler run count stays flat
  while the traversal count climbs per element. The cost is the list's length
  times what one element's schema costs to walk, and it is the second factor
  that decides whether you can see it: a narrow element looks flat at the size
  where a wide one bends, because both grow with the list and only one has a
  coefficient large enough to notice. An A/B cannot separate those; a ladder can
  — hold the append fixed and vary only what the element is, from a plain value
  up to the real thing, until the curve bends.
- **The work is fine but keeps being thrown away.** Mapped sub-patterns track
  their elements by normalized link address, which is stable across position
  changes for a cell and includes the positional index for an inline value — so
  an inline element makes identity equal position, and any reorder or prepend
  re-addresses every downstream cell and rebuilds its subtree.
  `packages/runner/src/builtins/map.ts` states the rule at its source. The
  symptom is churn rather than slowness in any one place, and no timer shows it
  — the work is fast every time, there is just N times more of it than there
  should be. What shows it is snapshotting the rendered tree across successive
  appends and counting how many addresses survive: a carried element should keep
  all of them and mint none. Nothing shared captures that today, so expect to
  build it: it has to walk the persisted VDOM as cells, so every node carries
  the entity id and path it lives at, and run on each append so consecutive
  snapshots diff as the same tree plus one element, modulo ids.

## Off screen and on screen

Measure the same operation twice — once with nothing rendering the result, once
with it on screen. The pair is what makes the numbers mean something:

- the **difference between them** is the rendering cost;
- the **difference between an early operation and a late one** is how the cost
  scales;
- an operation measured only on screen conflates the two, and one measured only
  off screen can look flat while the product feels unusable.

Time individual operations against a board that already exists, rather than
inferring per-operation cost by dividing the time to build one — building is a
different curve, and the number you want for a regression is what one more costs
at a given size.

Under the `serverExecution` ON arm the pair becomes a triple, because the write
no longer completes where it was issued: the writer's own settle is over its
echo, the durable result lands a wave later on the server, and the render
follows that. Split the measurement at each handover — write to echo, echo to
watermark coverage, coverage to painted — or the one number hides which of the
three moved.

## What your harness holds live

A harness that holds more live than its subject does measures itself. This is
the same failure the causes above describe, aimed at your rig rather than at the
product, and it is easy to miss for the reason the widest demand is the default:
the spelling that produces it looks like the obvious way to keep a piece running
while you write to it.

`packages/patterns/integration/topic-board-fixture.ts` holds a board live with
`getResult(board.getCell()).sink(() => {})` so each write lands against a
current list. That is a schemaless sink on the piece cell, so every write
re-materializes the whole board. Narrowing it to the board's own `index` — what
`packages/patterns/integration/topic-create-onscreen.test.ts` does behind a
knob, keeping the wide spelling available so the difference stays measurable —
took the off-screen growth of a create across a size sweep from 3.70× to 1.70×,
and the traversals slow enough to report over a fifty-topic run from 101 to 9.

So before reading any curve: ask what the harness demands, and whether the
product demands the same thing. A browser rendering a board demands its view; an
agent filing through the CLI demands nothing of the sort. If those differ, the
curve is partly yours.

The correction that follows is not "discard the finding". The same over-wide
read turned out to be what the `cf` CLI does against the real board, at sixteen
times the scale — which is why the deployed rung exists above. A rig that
exaggerates a real cost and a rig that invents one look identical from inside
the rig.

Under the ON arm the stakes rise, because demand is what makes the server run
anything at all: what a client holds live decides which derivations a wave has
to make current before it can commit. So an over-wide sink no longer costs its
own process alone — it enlarges every wave in that space, for every client. The
`servingLoop.demand` counters are the server's account of it, and
`demandedInstancesMax` against what the product would actually demand is the
same question this section asks, answered from the other side.

## Measuring honestly

The gap between a real change and machine noise is narrower than it looks, and
this repo has been burned by it.

- **A mean hides a stall.** One stalled sample inside a run is enough to invent
  a regression the dashboard then reports. Compare trimmed against untrimmed,
  and check whether an elevated reading arrives with a `max` an order of
  magnitude above its typical sample and a reduced sample count. The worked case
  is
  `docs/history/development/performance/2026-08-benchmark-headline-machine-noise.md`.
- **Alternate, don't batch.** Interleave the two sides and take a min-of-five
  rather than running all of one then all of the other; background load drifts
  over minutes. Where the harness allows it, normalize against an untouched
  control measured in the same run.
- **Never sleep to stabilize a measurement.** A sleep sets a floor on the number
  you are trying to reduce and makes it depend on scheduling luck.
  `docs/development/waiting-in-tests.md` is binding here, and the waits in
  `packages/patterns/integration/cfc-browser-helpers.ts` are the event-driven
  primitives to reach for.
- **State the board size, the machine, and which side is which** in any number
  you report. A ratio without a size is not reproducible.

## Landing it

A performance change needs its evidence attached: the measurement, the size it
was taken at, and what moved. Point at the mechanism rather than the number
alone — a number without a cause is indistinguishable from noise that happened
to persist.

Where the investigation produced a finding worth keeping but no longer describes
the current system — a decomposition, a ruled-out hypothesis, a noise analysis —
it is a point-in-time record: `docs/history/development/performance/` is its
home, under the rules in `docs/README.md`.
`docs/history/development/performance/2026-08-topics-create-off-screen.md` is
the worked case behind the harness section above, the append ladder, and the
self-against-inclusive number.
