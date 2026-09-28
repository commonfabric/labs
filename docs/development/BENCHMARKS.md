# Benchmarks

How the repository's `deno bench` files run in CI, where their results are
charted, and the constraints a bench file must satisfy for that tracking to
work.

It also holds the measurement helpers and the demonstration that share those
files' subject matter without being bench files themselves — the Topics browser
measurement and the Topics board demo below are both of that kind — so that a
reader looking for how a workload is measured finds all of it in one place.

## Report the measured boundary

Record the revision, resolved runtime posture, machine and tool versions, fixture
size, and demanded outputs with the result. Report the observed sample count from
benchmark JSON; a requested iteration count is not necessarily the number of
samples the harness collects. Keep warmup and diagnostic invocations distinct
from the samples included in the reported timing statistic.

Name each timer's actual start and end. An explicit timer around an awaited
operation includes call setup and promise resumption that an internal timer may
exclude. Nested phase timers are not an additive decomposition of wall-clock
time. Collect read accounting separately with instrumentation disabled for timing;
stable read counts alone establish neither stable latency nor a speedup.

Use repeated interleaved arms and matched fresh fixtures for comparative latency
claims. For retention claims, warm the runtime and take repeated post-GC samples
that separate surviving state from setup garbage; one cold-runtime heap delta
cannot establish retained memory cost.

## The pipeline

The Benchmarks workflow (`.github/workflows/benchmarks.yml`) runs every four
hours on a schedule, on the dedicated runner group. It runs `deno bench --json`
over `packages/runner/test/*.bench.ts` plus explicitly listed benchmarks in
`packages/utils`, `packages/fuse`, `packages/memory`, `packages/dashboard`, and
`packages/patterns`. It uploads JSON stdout and a copy of stderr in the
`bench-results` artifact with 90-day retention. A bench file outside those paths
does not run in CI until it is added to the workflow. The workflow's manual
trigger measures a specific commit.

The team ops dashboard charts benchmark trends on its `/bench` page, and its
trend reads one completed run per four-hour window from those artifacts. Each
benchmark is identified by its origin file, group, and name. The report's CPU
field divides that benchmark into one line per processor. The dashboard never
connects measurements from different processors. A report without a CPU
identity is unusable for trends because its measurements cannot be assigned to
a processor.

The trend compares the 75th percentile of each benchmark between runs, not its
average. `deno bench` measures a benchmark for a roughly fixed wall-clock
budget, so a single stalled sample raises the reported average by the length of
the stall divided by that budget, no matter how many samples the run collected.
The runners stall for a fifth of a second often enough to matter, and against a
budget of half a second that is a quarter added to the average — the size of
the moves the trend exists to find.

The 75th percentile is far enough up the distribution to move when a change
makes some but not all of an operation's runs slower, and far enough down that
a stalled sample or two cannot reach it. The fastest sample survives a stall
equally well, but it is the floor of the distribution and so is blind to a
change that leaves the floor alone and widens everything above it — a slow path
taken only sometimes moves nothing it can see. That is why the trend does not
read `min`.

How much protection that is depends on how many samples the run collected,
because the 75th percentile ignores the slowest quarter of them and no more. A
benchmark that fits 31 samples into the budget absorbs seven stalls before one
reaches the figure the trend reads; one that fits 11 absorbs two. The slowest
benchmarks in the repository are down at that end, so a benchmark written to
take tens of milliseconds per iteration is buying less of this protection than
one written to take tens of microseconds.

What the trend still cannot see is a change confined above the 75th percentile,
and on a user-facing timing that tail is what a person actually notices. Reading
it from these runs would first need the runner's stalls told apart from the tail
the code itself produces, which the current sample counts do not allow: on the
busiest processor `p99` puts 11% of neighboring run pairs more than a quarter
apart with no change behind them, against 2% for the 75th percentile. Until
that is separable, the drill-down's ladder from `min` to `max` is where the tail
is visible. A benchmark that measures a whole user-facing journey rather than
one operation has a different balance here, because its tail is the thing being
measured.

The runner group does not make two runs comparable, and the processor field
only goes part of the way. Over a forty-five day stretch the group served six
processor models, and within one model two runs have measured a fifth apart on
work that touches no repository code, because a run gets whatever share of a
shared host the other tenants leave it. So every run also measures the machine,
through the benchmarks in `packages/dashboard/machine-calibration.bench.ts`,
which call no repository code. The dashboard divides their geometric mean out of
each step of its index, and leaves them out of the index, the benchmark count
and the drill-down. See
[the investigation](../history/development/performance/2026-08-benchmark-headline-machine-noise.md)
for what an uncorrected run did to the tile.

That correction reaches as far as the machine and no further. A host that is
busy for the whole job is measured and divided out. Anything that slows one
phase of the job and not another is not, because the calibration is one
measurement taken at one point. The browser benchmarks below are the case to
hold in mind: they run against a toolshed this same job started, and contention
between the browser and that server sits inside their numbers with nothing to
subtract it against.

Which point of the job the calibration is taken at is `deno bench`'s to choose,
not the workflow's. It does not run files in the order they are listed: listing
the same files in reverse produces the identical report, and the two browser
files run first rather than last where the list puts them. The order it picks
is stable — repeated runs of one file set agree — and stability is what the
calibration actually needs, because a ruler read at the same point of every job
compares across jobs. Adding a bench file to the list does not place it, so
neither the calibration's position nor any other file's can be arranged from
here.

Benchmark results are not gated, and neither is CI wall time. The counts CI
gates on include the measured-set coverage gate (`tasks/coverage-gate.ts`, a step
of `Status`), the read limits of the headless lunch-poll render fixtures
([below](#headless-render-read-limits), tests of the `pattern-unit` suite), and
the Topics read and graph limits ([below](#the-read-budget), tests of the
`pattern-integration` and `pattern-integration-opposite` suites). None of them ingests benchmark results, so a bench
regression shows up as trend drift on the dashboard rather than as a failing
check.

Most packages with benches define a `bench` task for running them locally
(see `packages/runner/deno.jsonc`); otherwise invoke `deno bench` on a
single file.

`packages/runner/test/view-replication.bench.ts` measures view selection through
chains of 100, 300, and 1,000 computations, each mixed with an equally large
unrelated chain. Fixture construction stays outside timing; index construction
and selection are measured together. The selected action count and exclusion of
the unrelated chain are checked outside the timed interval.

`packages/runner/test/demand-pass.bench.ts` measures the demand read a serving
loop's demand pass makes, for one client session whose watch reaches 1,000,
5,000, and 20,000 documents: the memory server's `demandForSpace()` and the
fold of its result into the loop's `DemandMirror`. `unchanged` reads demand
nothing has written since the last read, and stays flat across the sizes;
`one watch added` rebuilds the session's share and folds in a change of one
key, and grows with the session's closure. The fixture's watch evaluation stays
outside timing.

`packages/runner/test/view-producer-proof.bench.ts` measures a client's currency
proof over 10, 14, 18, and 36 producers, where each producer reads the preceding
two outputs. This shared ancestry exercises repeated paths to the same upstream
value. Replica setup and plan indexing stay outside timing; the timed interval
covers one proof against unchanged values.

`packages/runner/test/executor-sustained-input.bench.ts` measures how long the
serving watermark takes to cover an input while input keeps arriving. Each
iteration opens a fresh served space outside the timed interval, then starts a
stream that commits one input at every settle barrier and stops after eight wave
cycles. The timed interval runs from the stream's start, which commits its first
input, to the watermark document covering that input. Each iteration writes the
per-input admission-to-coverage times and cycle counts, summarized as P50, P90
and maximum over every streamed input, and the loop's exhaustion counters, to
stderr.

`packages/runner/test/materializer-writers.bench.ts` measures
`collectMaterializerWritersForLog()` over logs of 100, 1,000, and 3,500 deep
reads of one document, the entity eight materializers write, each materializer
overlapping only a read near the end of the log. Index registration and log
construction stay outside timing; the timed interval covers one collection, and
the writer count is checked after it.

## Constraints on bench files

**Stdout must stay pure JSON.** The workflow redirects all of stdout to
`results.json`. One stray line printed by any bench file corrupts the
artifact for every benchmark in the run, not just the offending file. A
validation step (`tasks/check-bench-report.ts`) fails the run when stdout
carried no report, a report that will not parse, or anything besides the
report, and when the report is missing what every tile needs of it: the
processor identity, a product measurement, the machine calibration, and each
of the two key benchmarks. That last is a set rather than the whole report — a
product benchmark that stopped reporting passes it, and shows up as its own
series ending on the chart — and each of these shows up as a red run in the
Actions tab. What keeps a corrupt artifact off the charts is the dashboard
dropping one it cannot parse, rather than the run's color: a red run's
measurements are charted like any other run's. This applies to
module-scope code as well as bench bodies. Write diagnostics to stderr.
Module-scope
diagnostics may use `console.error`. The JSON reporter
captures console output from benchmark bodies, so body diagnostics that need
to reach the workflow must write to `Deno.stderr` directly. The workflow copies
stderr to `diagnostics.log` in the uploaded artifact and also shows it in the
workflow log. A stray diagnostic once corrupted every benchmark artifact for
five weeks before anyone noticed.

The `cf-bench/no-lost-diagnostics` lint rule (`tasks/lint-bench-console.ts`,
registered in the root `deno.jsonc`) holds both halves of that in place, so a
plain `deno lint` catches either mistake. In a `*.bench.ts` file, outside a
benchmark body, the four `console` methods that write to stderr — `error`,
`warn`, `trace`, `assert` — are the whole of what it allows, and every other one
is rejected. Naming the permitted four rather than enumerating the ones that
write to stdout is what makes that safe: a method nobody thought of, `dirxml`
say, is rejected rather than let through. Inside a benchmark body it rejects any
`console` call at all, written there or in a helper of the same file that a body
calls, however many hops away. A helper in another module is past what one
file's syntax tree shows, so write those with `Deno.stderr` too. The runner's
benchmarks do that through `benchDiagnostic()` in
`packages/runner/test/bench-diagnostics.ts`.

**Read a transaction's journal before it commits.** A benchmark that reports
what it wrote reads `tx.journal.novelty(space)`, and a transaction holds that
journal only while it is open: `commit()` releases it on the way to settling,
and the same call afterwards reports nothing. A benchmark that times the commit
cannot afford the read inside its timed window either.
`packages/runner/test/cell-set-flat-index-list.bench.ts` shows the arrangement.
Each of its write scenarios takes a callback and hands it the transaction just
before committing; the benchmark itself passes no callback, and instead runs the
same scenario once more, untimed, to fill in a report it writes once.
`packages/runner/test/bench-write-accounting.ts` turns those attestations into a
document count and a byte count — one attestation per written path is not one
document and not one value, so adding them up directly counts some bytes twice
and misses others.

**Names identify chart series.** The dashboard tracks each benchmark by its
origin file, group, and verbatim name. Renaming a bench or its group breaks
the series: history stays under the old name and the renamed bench starts
over. Two of those keys are written out in `KEY_BENCHMARKS` in
`packages/dashboard/bench-report.ts`, and the key benchmarks tile trends those
and nothing else, so moving or renaming one of them costs that tile half of
what it reads and both of them leave it nothing at all. Two things hold that
in place: `deno task check-bench-workflow` fails a change that leaves one of
those files out of the workflow's `deno bench` list, and the validation step
fails a run whose report is missing either, which together keep such a change
to a red check or one red run instead of a hole in the history. So:

- Keep names stable. Never interpolate values that change as unrelated commits
  land: content hashes, byte counts, module counts, dates. If a name must
  identify a module, derive a label from its source filename, not from its
  content. Log volatile sizes to stderr instead.
- Keep names short. The dashboard has little horizontal room for series
  labels, and the origin file and group already carry context, so the name
  should not repeat them.
- Keep names unique within a group. `Deno.bench` accepts duplicate names in the
  same group without an error and reports them as a single benchmark whose
  results array holds one entry per duplicate. A consumer reading one result
  per group and name silently drops the rest.

`packages/runner/test/esm-verifier.bench.ts` shows the pattern: short stable
names, per-module labels derived from source paths, sizes logged to stderr.

**Time only the operation the name promises.** `Deno.bench` times the whole
body unless the body takes the context argument and calls `b.start()` and
`b.end()` around the part under test. A body that builds a runtime, a storage
manager, or a fixture of documents, and then measures without that bracket,
reports the fixture as though it were the operation. Two costs follow. The
first is that the benchmark cannot see what it is named for: before its
measurement was bracketed, `Cell equals - comparison operations (100x)` in
`packages/runner/test/cell.bench.ts` spent 93% of its reported time building
and tearing down a runtime, so doubling the cost of `Cell.equals()` would have
moved it by 7%. The second is the reverse — a change to runtime construction or
to commit moves every benchmark shaped like that one, which reads on the chart
as a regression in whatever each is named for. The two `Cell getAsLink`
benchmarks in the same file show the bracket in place.

Many bench bodies in the repository still measure their fixture along with
their operation, so this is a rule for new benches rather than a description of
the tree. Bracketing an existing one changes the number it reports, which the
dashboard reads as a one-off step in that benchmark's line; the name stays the
same, so the series continues rather than restarting.

**The calibration bodies stay as they are.** The bodies in
`packages/dashboard/machine-calibration.bench.ts` are the ruler every other
benchmark is measured against, so editing one moves its timings and the
dashboard reads that move as the machine changing under a processor that did
not change. Adding a benchmark to that file is safe, and so is removing one:
each pair of runs is compared over the calibration benchmarks they share, so
one present on only one side takes no part. Rewriting one is not. Two things
keep those bodies honest, and both are easy to undo by accident. Each runs long
enough — a few hundred microseconds — that the just-in-time compiler has
settled before the measurement, because a body of a few tens of microseconds is
measured partly interpreted and partly compiled, and which it is varies between
runs by more than the machine does. And each takes an explicit warmup, so that
settling happens before the timings start.

## The end-to-end navigation benchmark

`packages/patterns/integration/topic-board-navigation.bench.ts` measures what a
person waits for rather than what a component costs: a browser loading a topic
board carrying dozens of topics, signing in, the cards appearing, opening a
topic, and following a crossref to a sibling. Its `topic board` group charts
each of those as its own series plus a `journey` series for the whole sequence,
so a regression lands on the segment that caused it.

Two further series in that group measure the Topics derivations rather than the
navigation over them, for the browser tier of [the Topics computation
plan](../plans/topics-computation-cost.md). Each charts a timed interval and
writes one read-accounted sample of the same operation to stderr; the reads and
the graph sizes are there rather than on a chart because a sample taken with
accounting on carries its overhead in the elapsed time and is not a latency
measurement.

- `comment` is a warm update: sending a comment on an open topic, which moves
  that topic's comment count and its last activity. It runs against a board of
  its own, in its own space, because sending a comment is a durable write that
  makes the commented topic the board's first card, which would leave `crossref`
  and `journey` opening a card with no citation to follow. Each iteration
  comments on a topic that has none, so every iteration measures the same thing;
  how cost grows with thread length is the headless probe's question, and its
  thread cases run at 10, 100, and 1,000 comments.
- `backlink` opens the topic the most siblings cite and waits for every row the
  topic's backlink derivation produces. `crossref` cannot measure that: it
  follows a citation outward from the board's first card, which is the newest
  topic, and nothing cites the newest topic. The segment reaches its topic
  through the shell's own navigation rather than by clicking, because a topic in
  the middle of the board is on no card or link the page is showing.

The comment segment needs the viewer to have a Profile, since the composer's
send button is disabled until `#profile` resolves to a named one. The field
beside it is not gated, so the draft is typed either way and it is the send that
waits. The first session of a run creates one through the wish's own create
surface; later sessions find it already there. One wait tells those two states
apart, so nothing races and nothing polls.

The `load` segment ends after the shell publishes its ready application and
selects the requested board route. Shell readiness is an explicit notification
from bootstrap; selecting the route does not require its topic data to have
rendered. This keeps the segment boundary independent of DOM mutation timing.

Each segment reaches its starting point with the timer stopped — `Deno.bench`'s
`b.start()` and `b.end()` bracket only the segment itself — so every iteration
measures one segment of a fresh navigation, and no benchmark depends on another
or on the order Deno runs them in.

Three things follow from it being an end-to-end measurement:

- **It needs more than Deno.** The workflow builds the toolshed binary, starts
  it, and relaxes the AppArmor restriction Astral needs, all before the
  benchmark step. Locally, start the dev servers and pass `API_URL` and
  `FRONTEND_URL`.
- **A failure is a red run, but not a lost window.** `deno bench` exits
  non-zero when a benchmark throws, and this one throws when the shell raises an
  uncaught exception or a navigation never completes. The report still lists
  every other benchmark, the workflow still uploads it, and the dashboard reads
  it: the run is red in the Actions tab and drops only the series it could not
  measure. A failed attempt also writes its phase, elapsed time, error, and
  main-thread IPC diagnostics to stderr, without requesting another reply from
  a possibly stalled worker. Successful latency samples and failed attempts
  remain separate. Each segment waits on the event it is waiting for, with no
  deadline of its own, so it fails when something is genuinely broken rather
  than when the runner is busy.
- **The `sign in` segment reads coarser than the others.** It calls the shared
  `login` helper from `@commonfabric/integration/shell-utils`, which polls the
  page on a 50ms interval, and a wall-clock measurement taken around a poll is
  quantized to its interval. Against a segment that runs in a couple of hundred
  milliseconds that is visible resolution, not rounding. The other segments
  wait on notifications and are unaffected.
- **The board's size is part of the measurement.** Changing it starts every
  series in the group over at a new scale, exactly as renaming a benchmark
  would. `CF_TOPIC_BOARD_TOPICS` overrides it for a local run that asks how a
  segment scales; CI leaves it unset, and the size in force is written to
  stderr and so into `diagnostics.log`.

`packages/patterns/integration/topic-board-seed.ts` builds a board on its own,
which is how to get one for a profiling session without running the benchmark.
The seeder holds a subscription to the board's index using its durable result
schema. This keeps the current list demanded without subscribing to each
topic's full result. Set `CF_TOPIC_BOARD_DEMAND=full` in either board benchmark,
or pass `--demand=full` to the seeder, to run the full-result stress workload.
The fixture records `seedDemand`, and diagnostics name it. Both seeding modes
use the same benchmark groups; compare execution arms with the same setting.
These subscriptions do not bound every seeding read: controller writes also
pull their result to complete, and citation creation addresses the topics.

## The board scaling benchmark

One board of one size catches a regression but says nothing about shape: a
change that is flat at thirty topics and quadratic at three hundred looks the
same on the navigation benchmark's `board` series.
`packages/patterns/integration/topic-board-scale.bench.ts` measures that same
thing — a signed-in cold load, timed until every card has rendered — across
board sizes of 100, 1000, and 10000, in a `topic board scale` group whose
series are named for the sizes. The boards carry no crossrefs, so the numbers
describe the cost of the list rather than of the join over it.
`CF_TOPIC_BOARD_DEMAND=full` selects full-result seeding. The navigation
fixture's citations and the scale fixture's lack of citations are distinct
workloads, so their timings do not form a size-only comparison.

A second series per size, named `reopen <size>`, measures a reopen for the
browser tier of [the Topics computation
plan](../plans/topics-computation-cost.md): a topic this page has already opened
once, opened again, so that what it measures is reaching the topic rather than
computing it for the first time. It asks whether that cost grows with the board
behind the topic, which is the question this file exists for and which the
navigation benchmark's single board cannot answer. Reopening writes nothing, so
both series of a size share its one seeded board, and a size skipped for one is
skipped for the other.

It charts a timed interval and writes two samples per size to stderr: the timed
one, carrying that operation's graph size and timing, and a read-accounted one
of the same operation, paired with it as the lunch-poll read-scaling benchmark
pairs its diagnostic vote with its timed vote. What the read-accounted half
records is a zero — a row per lift reading no runs — and the zero is the
finding. It is recorded rather than omitted so that a reopen which begins doing
lift work shows up as rows, instead of as an unexplained shift in the timing
beside it.

The sample declares `mayRunNothing`, which waives one failure and only one: an
operation completing no run that carried an authored source location. A run
carrying a location the helper cannot parse still fails the measurement,
declared or not, because that is a reading it cannot place rather than an
absence of work.

Three measurements stand behind that shape, and
[the baseline report](../history/development/performance/2026-09-20-topics-computation-cost-baseline.md)
records them: a survey of four operation boundaries, a classification of the
runs a reopen completes against first-open controls, and the outcome once the
two refusal paths were told apart. They are trial counts from particular runs
in a particular environment, which is why they sit in that record rather than
here. What they establish, and what governs this series, is that a reopen's
runs carry no source location at all rather than one the helper fails to parse
— so the attribution check, which fails a sample only when everything it is
given fails to parse, has nothing to refuse, while the no-runs guard does. That
is the distinction `mayRunNothing` is scoped to.

Widening the interval would not recover a lift run worth having. Of those four
boundaries only the whole round trip yields one, and for the return leg:
measuring the return to the board on its own records that same single
`lastActivityOf` run with the same counters, while the reopen beside it records
none. Charging this series for a board render is what widening that far would
do, and the `<size>` series already measures it, at a hundred topics costing an
order of magnitude more than the reopen.

The sample reports `runsWithoutSource` beside its zero so that a zero taken
next to such runs does not print identically to one taken next to no runs at
all.

What does not apply to this workload is separating producer from consumer work,
there being no lift work to separate; [the
plan](../plans/topics-computation-cost.md) records that.

A reopen may run nothing in the worker at all, and the series declares
`mayRunNothing` because that was observed rather than to quiet the check in
advance: on a 100-topic board one iteration recorded a single scheduler run and
a later one recorded none, and a third visit to one topic recorded none.
What the interval times is the shell reaching a topic whose values are already
computed, so the worker having nothing to do is the substance of the
measurement. Each sample records the declaration beside its run count, so a
reopen that starts doing work again is visible rather than hidden.

What `reopen` does not measure is worth stating, because the plan's phrase is
"reopen or reconnect" and only the first half of it is measured here. The page,
its shell, its worker and its runtime client stay up throughout, so this is not
a runtime restart and not a reconnect. Neither is measured here. A page reload
is out of the helper's reach outright, discarding the realm that holds the
sample; a transport reconnect is not induced at all, since that needs a storage
relay the Benchmarks workflow does not run. Cold initialization is
measured separately, by the navigation benchmark's `load`, `sign in`, `board`
and `open topic` segments, and a warm update by its `comment` segment.

Only the 100-topic board runs today. The other two are declared and skipped,
because a board of that size cannot be built:

- Seeding cost grows faster than the topic count, because the board recomputes
  its whole crossref join and index on every write and every topic holds the
  board's own list. Measured on an Apple M3 Max seeding against a local
  toolshed: thirty topics take 33 seconds and 0.95GB of peak resident memory,
  sixty take 143 seconds and 1.6GB, and a hundred take 274 seconds — four and a
  half minutes — and 2.6GB. Three and a third times the topics costs eight
  times the time.
- Time and memory do not grow the same way, and only one of them is what
  actually stops a larger board. Peak memory is close to linear at roughly
  26MB per topic, so a thousand needs on the order of 26GB — more than a runner
  has, which is the binding constraint. Time extrapolates to several hours
  rather than to anything a scheduled job could absorb, and ten thousand is out
  of reach on both counts.
- Crossrefs are not the cause, and neither is the benchmark. Creating the same
  topic pieces standalone is linear and flat in memory — a hundred in
  twenty-five seconds, holding at about a gigabyte — but attaching them to a
  board in a single write is refused by the board's element schema, so there is
  no route that avoids the per-write cost.

Declaring the skipped sizes rather than leaving them out keeps the curve they
belong to written down, and turning them on is one edit:
`CF_TOPIC_BOARD_SCALE_LIMIT` raises the ceiling. A skipped benchmark is absent
from the report entirely, so the dashboard simply has no series for it and the
run stays green.

Because that ceiling is the board's cost and not a property of the benchmark,
the two skipped sizes should be enabled as part of whatever lowers it.

## Topics browser measurement

`packages/patterns/integration/topics-browser-measurement.ts` is a helper that
measures one operation a caller drives in a Topics board's browser page, for the
browser tier of [the Topics computation
plan](../plans/topics-computation-cost.md). A caller invokes it around the
operation. Five benchmark series use it: `comment` and `backlink` in the
navigation benchmark, and one `reopen <size>` per declared board size in the
scale benchmark. Three of the five run by default: the two navigation series,
and `reopen 100`. The scale limit defaults to the hundred-topic board, so the
larger two are skipped with their load counterparts until
`CF_TOPIC_BOARD_SCALE_LIMIT` raises it.
Each charts the interval `timeTopicsOperation()` brackets, and each writes a
`measureTopicsReads()` sample of the same operation to `diagnostics.log`
alongside it. `reopen` declares `mayRunNothing` on that sample, because a reopen
completes no run for the call to attribute and the zero is what it has to
record; it writes its timed sample as well, for the graph and timing the
read-accounted half's elapsed time cannot speak for.

### The posture a sample is labeled with

Every sample carries the server-execution posture the deployment under
measurement ran, printed in square brackets after the sample's label as
`[<mode> via <source>]`, so a diagnostics line says which mode produced it and
which statement of the posture that came from, without a reader knowing how the
run was started. `topics-browser-posture.ts` reads it from the deployment
rather than from the benchmark process's own `EXPERIMENTAL_SERVER_EXECUTION`,
which would label whatever it was told: the toolshed reports the posture it
serves at on `/api/meta`, and the shell it serves states its own through the
build define. The worker refuses to initialize when its resolved posture
disagrees with the shell's declaration, so a page that loaded at all ran the
posture its shell declared.

The shell's define has two possible statements and they are not
interchangeable. The bundle served to the browser is the artifact the run
loads; `shellServerExecutionDefine` on `/api/meta` describes the shell its own
toolshed serves, which is the same artifact only when `FRONTEND_URL` and
`API_URL` name one origin. Both are read on every run, and what settles the
shell's posture is:

- both stating a define and agreeing — the posture, read from both;
- both stating one and disagreeing — refused, since they describe different
  artifacts and neither says what this run loaded;
- the bundle alone — the posture, whichever host served the shell, because the
  script the browser loads answers for itself;
- `/api/meta` alone, with the toolshed serving the shell — the posture;
- `/api/meta` alone, with another host serving the shell — undeclared, that
  define describing a shell this run never loads;
- neither — undeclared.

A bundle states nothing whether it could not be read or was read and carries
no define; that changes none of the above, and shows only in the reason an
undeclared posture records.

Reading a deployment has three outcomes. Where both halves state a posture and
agree, that is the mode. Where both state one and disagree, reading refuses,
because a client and a server on opposite postures exercise neither. Where the
deployment states the shell's half nowhere — a bundle with no define, or no
bundle that can be read — the posture is `undeclared`: a recorded fact about
the deployment, never the first-party default, which is a constant compiled
into the benchmark process rather than something the deployment said. So no
path labels a run from an assumption.

Whether `undeclared` is usable belongs to the caller, because strictness is a
property of what a measurement is for. A benchmark comparing two postures needs
a declared one and reads through `readDeclaredTopicsBrowserPosture()`, which
refuses the rest; the Benchmarks workflow builds its toolshed binary with
`EXPERIMENTAL_SERVER_EXECUTION` set, so the shell it serves carries a define
and the read succeeds. A test exercising these helpers does not care what
posture it ran under, reads through `readTopicsBrowserPosture()`, and carries
whatever it finds into its samples; the pattern-integration lane serves a shell
built with no posture defines, which is an ordinary configuration rather than a
fault. A sample taken under an undeclared posture prints `[posture undeclared]`
rather than a mode, so it cannot later be read as a measurement of either.

### What a sample records

`measureTopicsReads()` turns telemetry and body read accounting on in the
shell's runtime client, runs the operation, waits until the view has settled and
the runtime is idle, and turns both off again. From the `scheduler.run.complete`
markers it sums runs, `durationMs`, proxy accesses, the largest single run's
accesses, link resolutions, distinct documents, and registered dependencies, in
one row for the board's pivot (`crossrefTable`, the producer), one for each
per-topic consumer (`backlinksOf`, `presentCommentCountOf`, and
`lastActivityOf`), and one for every other run. It also records the scheduler
graph's node and edge counts before and after, the operation's elapsed time, and
the timing statistics the main thread and the worker accumulated over it, less
the helper's own requests. A timing row sums spans that can overlap, so its
total can exceed the elapsed time. Accounting is on for that elapsed time and
timing, and the sample says so. `timeTopicsOperation()` turns telemetry and read
accounting off before its interval and records that it did, then records the
same graph, elapsed time, and timing and no reads. Given a `Deno.bench`
interval, it starts the interval just before the operation and ends it at the
settled boundary, or where the operation or that wait throws. Both samplers need
the runtime client that signing in creates, so neither brackets cold
initialization, and a sample whose client is replaced during the operation
fails; a measured sample first turns telemetry and read accounting off on the
client it enabled them on.

A measured sample is taken against a program that `prepareTopicsProgram()`
compiles from the sources the board was seeded from, on an emulated runtime and
with `packages/patterns` as the program root, as the topic board fixture deploys
it. The compile takes about a second, so a caller prepares one program and
passes it to each measurement. A lift is found by name: the helper parses the
module with the TypeScript compiler's parser, finds the one
`const <name> = lift(...)` declaration in it, and takes the position where that
call's first argument starts, so a candidate whose lines moved is measured
under the same names. For the one-argument `lift(<function>)` the Topics lifts
are written as, that argument is the function, whose position is the one a
run's `src` names. A lift written `lift(<schema>, <function>)` would yield the
schema's position instead, which the runs do not carry. The helper reads a
lift's compiled function out of the emitted module the same way, so a bracket
or a declaration inside a string, a comment, a template literal, or a regular
expression is read as part of that literal or comment rather than as code.
Three checks then tie the running code to the compiled program, and each
failure names the check that failed.
Every Topics module an action's `src` names must carry the compiled module's
content identity, the `<identity>` in `cf:module/<identity>/topics/...`; any
other identity means the sources read are not the program the board runs. The
page's worker must collect no pattern coverage, and no implementation preview
may hold a coverage hit call, because coverage instrumentation rewrites every
lift's code. Each running lift's preview in a graph snapshot, the first 200
characters of its function's source, must equal the first 200 characters of the
lift's function in the compiled module; a failure names the lift and the first
character that differs. A name not declared as above fails the measurement, as
does a lift's module that is running but holds no action at the lift's position
or runs in two versions. A lift is reported as not running, with zero runs, only
when its module has not started during the operation and no action's `src` names
the module's file under any path. A `src` naming that file under another path,
or the module itself under another root, fails the measurement instead.

A measured operation fails when it completes no run carrying an authored source
location, when an event commit fails, or when the page raises an error. The
first of those is waived by declaring `mayRunNothing`, which permits a zero
rather than asserting one: an operation that does complete such runs is
attributed as usual, and the sample records the declaration, so a measured zero
is distinguishable from an operation nobody measured. A run whose marker carried
no source location is counted apart, as `runsWithoutSource`, and reported beside
the zero so that a zero taken next to runs the sample could not place reads
differently from one taken next to no runs at all.

It also fails when its runs cannot be attributed by position: when the runs that
did carry a source location all carry one the helper cannot parse, or when the
board's pivot module is not running, since a measurement is taken on a page
showing the board. Neither of those is waived — a location that cannot be read
is a measurement that cannot be placed rather than an absence of work, and
`mayRunNothing` does not reach it. `topics-browser-measurement.test.ts` holds
that case with the declaration in force. A timed operation fails on a
page error, and when the worker's `scheduler/run` timing records no run, unless
the caller declares with `mayRunNothing` that the operation may run nothing; the
sample records that declaration. The count is of action runs the worker's
scheduler times with `runSchedulerAction`'s `scheduler/run` span; runs that
overlap share that span's timer, so it is a lower bound, and timing without that
span fails the sample. With telemetry off, a timed operation cannot observe
event commit errors. A measured sample of the same operation checks them, which
the caller pairs with the timed one, as the rendered lunch-poll benchmark pairs
its diagnostic vote with its timed vote; the timed sample's notes say so.

The helper does not record:

- Transaction-attempt reads. The runtime client's read-stats request enables
  body accounting only, so attempt reads come from the headless tier.
- Rendering apart from the spans the shell already times. The sample's
  `vdomApply` row is the main thread's `vdom-applicator/apply-batch`, applying
  worker VDOM batches' operations to the DOM. The main thread also records
  `vdom-renderer` mount and unmount spans, which wait on the worker,
  `vdom-renderer` batch spans around applying a batch, `vdom-applicator` dispose
  and remove-node spans, and `runtime-client/ipc/*` waits on the worker. Lit
  element updates, style, layout, and paint have no timing of their own and
  appear only in the elapsed time.
- Network bytes or subscription events, which it does not count, and storage
  work, which it does not attribute as body reads. Timing rows can still include
  the durations of subscription requests and of worker storage spans.

`topics-browser-measurement.test.ts` runs both samplers on a two-topic board in
which one topic cites the other: opening a topic and returning to the board runs
each named lift at least once with reads recorded, attributed to its own
implementation; an operation that demands nothing fails the measurement; a page
whose worker collects pattern coverage fails it with a message naming coverage;
a runtime client replaced during a measured operation fails it after telemetry
and read accounting are turned off on the client they were turned on in; and the
timed sampler turns off telemetry a caller left on. The decisions that need no
browser live in `topics-browser-measurement-core.ts` beside the helper, and
`packages/patterns/test/topics-browser-measurement-core.test.ts` tests them
under a plain `deno test`, partly against compiled text, previews, and module
identities recorded from the Topics sources in a fixture beside that test.
That fixture is a recording, and nothing recompiles the Topics sources to check
it, which is what lets those cases hold still as the sources move. It is taken
again by hand, when a case needs material the recording does not hold. The
compiled half comes from one command:

```bash
deno task cf check packages/patterns/topics/main.tsx --json --no-check \
  --root packages/patterns
```

It prints a JSON document, and the whole compiled program is the string at
`files[0].output`: every module of it, each preceded by the
`// cf:module/<identity>` comment naming the identity that module compiles to,
which is the identity the helper's own compile reports for it. A lift's
`const <name> = (0, <alias>.lift)(...)` declaration is where to find the lift
in that text, and what the fixture records is the function the declaration
passes, which is what `compiledLiftText()` returns and what a preview begins.
The fixture's shifted identity is what the same command reports for
`/topics/main.tsx` after adding lines at the top of
`packages/patterns/topics/main.tsx`, as many as the case that reads that
identity names; the added lines come back out once the command has run.

No command prints a preview. A preview is what a running board reports for the
action at a lift's site: the implementation's `toString()` cut to its first 200
characters, carried on that action's node in a scheduler graph snapshot. The
browser helper reads one through `RuntimeClient.getGraphSnapshot()`, and a
headless run built with `topics-headless-fixture.ts` takes the same snapshot
from `runtime.scheduler` without a browser. The instrumented preview is one of
the same kind, from a board whose runtime collects pattern coverage, which
writes a `__cfPatternCoverage?.hit(` call before each statement; that call is
all the cases reading that preview ask of it.

## The Topics board demo

`packages/patterns/integration/topic-board-demo.test.ts` is not a benchmark. It
is the browser demonstration the [Topics computation
plan](../plans/topics-computation-cost.md) asks T0 for and T5 records before and
after a change, so it sits beside that plan's browser tier rather than in the
testing guide.

It shows four actions on one board, as a single journey: the board listing its
topics, a topic opened from its own card, the backlink on that topic followed to
the topic citing it, and a comment added that the thread then shows. Its board
comes from `seedTopicBoard`, shaped so exactly one topic cites exactly one
earlier one. That fixture derives every title and body from the topic's index,
so two runs of the same size build boards holding the same material, and the
demo seeds into a space of its own so nothing else a lane left in the shared
space appears on it. `CF_TOPICS_DEMO_TOPICS` sets how many topics that board
carries; the default is small because CI runs it.

Record it with:

```bash
deno task demo patterns topic-board-demo
```

which needs FFmpeg, as [the demo
command](TESTING.md#recording-browser-integration-tests-as-video-demos)
describes. `deno task integration patterns topic-board-demo` runs the same file
without recording it.

It asserts what it shows, so a broken behavior fails it rather than producing a
recording that looks right. The file itself states which of its properties a
candidate may change without invalidating a before-and-after comparison and
which it may not; read that before weakening an assertion in it.

## The multiplayer contention benchmark

`packages/patterns/integration/lunch-poll-vote-burst.bench.ts` measures what
several people editing one thing at the same moment cost each other: ten voters
each cast a vote on each of ten lunch-poll options, all hundred dispatched
before any settles, timed until every one of the ten clients holds the whole
result. Its `lunch poll` group carries one series, `vote burst 10x10`.

It is the only benchmark in the repository with a second writer. Every other
bench file drives one runtime against storage it alone holds, so a write
conflict cannot arise in one, and the cost of a contended write — the rejected
commit, the rolled-back optimistic write, the re-run — is invisible to all of
them. This one runs ten runtimes, each in its own Deno worker, through
`packages/patterns/integration/multi-runtime-harness.ts`. The benchmark passes
the harness no `apiUrl`, so it hosts an in-process storage server whether or
not `API_URL` is set, matching the resolved posture: a plain one when server
execution resolves OFF, and one with a serving loop attached when it resolves
ON, by `EXPERIMENTAL_SERVER_EXECUTION=true` or by the first-party default.
Both modes use ordinary worker
clients, without a browser or renderer mounts. The view-scoped web-client flag
therefore does not activate selective replication in this benchmark. Use the
browser Topics benchmarks to measure that mode, and hold server execution
constant when comparing replication flags.

Each burst waits for every writer's event consequences to arrive before the
replica barriers. The harness's budgeted `settle()` alone can return with pending
consequences, so it cannot define a successful measurement. Outside the timed
interval, every replica must contain the expected vote count and color
distribution for every option; a mismatch fails the run.

Four things follow from that shape:

- **Setup runs once, at module scope.** Ten workers, ten joins, ten options and
  two warm-up bursts cost around twelve seconds, so paying it per iteration
  would leave a run with almost no samples. Each iteration recolors every vote,
  so all hundred are real changes and the poll holds a hundred votes throughout;
  no iteration leaves a state the next one starts from differently.
- **Few samples.** An iteration runs in about 450ms on a developer machine and
  2.6 seconds on a four-core CI host, which puts this benchmark at the end of
  the distribution where the 75th percentile buys least — it discards the
  slowest quarter of a dozen samples, so two stalls in a run reach the figure
  the trend reads. Read it across several windows.
- **The wall-clock is half of what it measures.** A contended write is also
  work thrown away, and that half does not appear in a timing. The file writes a
  contention accounting — rejected commits and rolled-back writes over one
  untimed burst — to stderr, and so into `diagnostics.log`. On the keyed vote
  write both are zero; the same burst over a whole-list write measured 430 and
  558.
- **The size names the series.** `CF_LUNCH_POLL_VOTERS` and
  `CF_LUNCH_POLL_OPTIONS` resize it for a local run asking how the burst scales.
  Changing either starts a new line rather than continuing this one, exactly as
  the board benchmark's size does. CI leaves both unset, and the size in force
  is written to stderr.

Ten runtimes is the largest footprint of any benchmark in the job, and the cost
is worth knowing before adding a voter to it. **Measured on a default hosted
runner — four cores, 15.6GB — the file takes 89 seconds and peaks at 4.76GB
resident**, under a third of that host with around 9GB still free. The runner
group this workflow uses is a larger machine than that one, so the share it
takes there is smaller again.

Read that peak as a working set rather than as a requirement. The same run
under `--max-old-space-size=512` completes in 3.5GB at roughly double the
per-iteration time, and a developer machine with far more memory peaks higher,
at 5.4GB. So the absolute figure rises with the headroom the heap is offered
while the fraction of the host falls, and it is the fraction that decides
whether this belongs beside the other benchmarks.

That peak is a floor under everything measured after it. The workers are
released at process exit — `Deno.bench` offers no seam for "this file's
benchmarks are done", so the file closes the harness from an `unload` listener.
Which benchmarks that floor sits under is therefore a question of where
`deno bench` places this file, and the pipeline section above says that is not
a question the workflow's list answers.

`packages/patterns/integration/lunch-poll-keyed-votes.test.ts` is the assertion
half of the same property: it counts rolled-back writes instead of timing them,
and requires none, so a regression that this benchmark shows as trend drift
also fails a test.

## Rendered lunch-poll read scaling

`packages/patterns/integration/lunch-poll-read-scale.bench.ts` measures a vote
change with the production lunch poll's cards and summary demanded by a browser.
Its three series hold 74, 296, and 1184 votes over 14 options, with 8, 24, and 87
voters respectively. `CF_READ_SCALE_PROFILE_LOCATION` selects `same-space`
(the default) or `cross-space` voter profiles. Both variants use separately
stored profiles with identical names, vote counts, and option counts. The
cross-space variant seeds profiles in a dedicated space before seeding the
poll, so no seed transaction writes across spaces. That seed requires existing
profiles and rejects an unavailable profile instead of creating it. The
benchmark verifies the first vote's resolved voter space and records the
location in its artifacts.
Seeding, navigation, sign-in, viewer selection, warmup, and teardown are outside
the timed interval. The timer includes click-helper readiness, browser/protocol
overhead, and a trusted green-vote click through view
settlement and the matching selected button and summary swatch.

An untimed yellow-vote change collects reactive-body runs, proxy accesses,
maximum per-run accesses, link traversals, and successful/failed event-commit
markers from the browser worker. Accounting and telemetry are disabled before
the timed change. These body counters exclude event-handler and commit-preparation
reads; event-commit markers are counted separately and do not describe every
storage transaction. Diagnostics go to stderr. Missing successful event commits, event-commit
errors, and browser exceptions fail the run.

The benchmark process must set `EXPERIMENTAL_SERVER_EXECUTION` to `true` or
`false` explicitly, and before seeding it checks that the toolshed metadata,
the toolshed's serving loop, and the served shell's build define all name that
same arm. The workflow pins the shell build, toolshed, and benchmark process to
`false`, which keeps its client-execution series stable across changes to the
product default. The contention benchmark remains a separate workload.

For a local run, start matching client-execution dev servers as described in
[Local dev servers](LOCAL_DEV_SERVERS.md), then run:

```sh
EXPERIMENTAL_SERVER_EXECUTION=false \
API_URL=http://localhost:8000 FRONTEND_URL=http://localhost:5173 \
CF_LOG_LEVEL=silent \
deno bench --json -A \
  packages/patterns/integration/lunch-poll-read-scale.bench.ts \
  > /tmp/lunch-read-scale.json 2> /tmp/lunch-read-scale.log
```

To measure the server-execution arm instead, start the dev servers with
`EXPERIMENTAL_SERVER_EXECUTION=true` in their environment, for example
`EXPERIMENTAL_SERVER_EXECUTION=true scripts/start-local-dev.sh`, so that the
toolshed serves on that arm and the shell bakes it into its build define, and
run the same command with `EXPERIMENTAL_SERVER_EXECUTION=true`.

Set `CF_READ_SCALE_ARTIFACT_DIR` to a local output directory to save one screenshot
and the latest diagnostic sample per size, after the timed interval. The fixture
uses a dedicated space and a synthetic viewer. It supplies repeatable local
measurements; comparisons to a deployed board require matching its execution
posture, data, and cross-space links.

### Headless render read limits

The fixture's `main.test.tsx`, `296-votes.test.tsx`, and `1184-votes.test.tsx`
under `packages/patterns/integration/fixtures/lunch-poll-read-scale/` enforce
read budgets for two headless rendering windows: the seeded poll's first render,
and a render after changing one vote to yellow. The harness recursively demands
VDOM cells during each window and removes that demand before the next step.
These limits cover rematerialization, not a continuously mounted browser update;
the browser-worker measurements above remain a separate series.

| Votes | First-render total limit | Updated-render total limit | Per-run limit in each render |
| ----- | ------------------------ | -------------------------- | ---------------------------- |
| 74    | 6,000                    | 1,100                      | 300                          |
| 296   | 76,000                   | 67,000                     | 31,000                       |
| 1184  | 236,000                  | 214,000                    | 96,000                       |

Totals count completed transaction-attempt proxy accesses; per-run limits bound
one reactive body's proxy accesses. The 74-vote limits guard maintained
per-option tallying; the larger fixtures enforce separate scale ceilings. Setup,
vote dispatch, and functional assertions occupy separate intervals with no
declared limits. The fixture creates
keyed vote entities and assigns their membership once during setup, avoiding a
full membership-array update for each seeded vote. No timing limit is added by
these fixtures.

`clock-tick.test.tsx` beside them covers a different window: the poll's clock
advances by one `#now/300` tick inside one local day between two renders of the
74-vote poll, and the second render is held to 100 accesses in total and 50 in
one reactive body. That render measures 11 and 7. The poll filters its votes
down to the current day, so a filter keyed on the tick rather than on the day
rescans every stored vote whenever the tick advances, which measures 234 and
224 there — the ceilings sit between the two rather than close to either. The
clock comes from the fixture rather than from the runner's five-minute timer,
through the poll's `clock` input, so the tick lands inside the measured window
on every run.

Run them all from the repository root:

```sh
deno task cf test packages/patterns/integration/fixtures/lunch-poll-read-scale --verbose
```

The command reports measured totals and per-run maxima for every interval. Keep
the functional assertions, declared collection sizes, and render windows when
adjusting a ceiling; a budget failure should lead to attribution of the added
reads before changing the limit.

## Consumed CFC source collection

`packages/runner/test/cfc-consumed-source-dedup.bench.ts` calls
`collectConsumedLabel()` over real emulated-storage transaction reads at 128,
458, 916, 1,832, and 2,668 consumed sources. Each address contributes two
distinct confidentiality atoms; all addresses share one document and have
four-segment logical paths. The source count measures provenance entries,
while the joined confidentiality label contains only two atoms.

The `root label` arm keeps metadata width at one entry. The `field labels`
arm labels each read path separately, holding reads and resulting source counts
fixed while increasing label-map width. This pair distinguishes source
deduplication cost from the collector's per-read metadata work. It does not
measure pattern compilation, `lift`/`.map()` execution, or browser startup.

Each sample opens a fresh transaction and reads the values outside timing.
The timed interval contains one collector call, including its verifier reads,
metadata validation, overlap checks, and atom joins. Untimed checks verify
read, source, and joined-atom counts; fixture construction and transaction
cleanup are also outside timing. Exact counts go to stderr, and stdout remains
the benchmark JSON report:

```sh
deno bench --no-lock -A --json packages/runner/test/cfc-consumed-source-dedup.bench.ts
```

The [local measurement report](../history/development/performance/2026-09-14-cfc-consumed-source-dedup.md)
records an alternating source-count sweep and the limits of that measurement.
The [metadata-width measurement](../history/development/performance/2026-09-14-cfc-consumed-label-index.md)
uses the same fixture to compare per-document validation and indexed path
lookup. Index construction remains inside the collector timer.

## Prepared CFC digests

`packages/runner/test/cfc-prepared-digest.bench.ts` records 5, 50, or 200
write policy inputs with 1 or 10 KiB payloads, plus 300 read activities and
dereference traces. Each sample uses a fresh emulated-storage transaction.
Construction, initial hashing for warm cases, validation, and abort are outside
the timed interval. Policy names are distinct, so sorting does not repeatedly
hash large records to break name ties.

The five series measure the first digest, an unchanged second digest, a
second digest after one additional write, direct hashing over warmed records
in a fresh input wrapper, and preparation plus its unchanged recheck in one
interval. The direct-hashing series bypasses the transaction epoch memo; the
combined series measures the normal two-request shape. Diagnostics on stderr
report the immutable-object hash-cache hits during the measured interval; an
epoch-memo hit performs no hashing. Stdout remains the benchmark JSON report.

```sh
deno bench --no-lock -A --json packages/runner/test/cfc-prepared-digest.bench.ts
```

Prepared digests are process-local equality tokens over canonical activity.
The transaction reuses the complete token until its activity epoch changes;
decision-input recorders and write paths advance that epoch. A changed snapshot
is canonicalized and hashed in full. The token belongs to one transaction: a
fresh transaction prepares independently even when its effective CFC label is
unchanged.

Compare cache designs over preparation plus recheck as well as individual
calls: a cold setup cost must be recovered within the requests a transaction
actually makes. Include repeated executions of the same reactive nodes with
fresh transaction records. Stable labels can accompany changed write values
and newly allocated records, so neither label equality nor runtime uptime
establishes that an identity-keyed cache is warm. For retention comparisons,
probe live keys and discarded graphs separately across garbage collection.

## CFC path index queries

`packages/runner/test/cfc-path-index.bench.ts` measures `PathPrefixIndex` and
`ConsumedLabelIndex` over 50, 250, and 1,000 sources with wildcard fractions
of 0, 0.05, and 0.3 (rounded down to a whole source count). Templates end in
`"*"` at segment depths 2–5. Concrete queries have 2–7 segments and mix hits,
misses, and ancestor reads. The same corpus checks both indexes against
`isPrefix` in unit tests, including label-map encounter order.

Each timed sample performs 8,192 queries after explicit warmup. Divide the
reported nanoseconds by 8,192 for per-query cost. Index construction and
scan-equivalence checks stay outside timing. The fixture spreads templates
across distinct container prefixes; wildcard tails sharing one prefix still
require a scan of that bucket, and overlap queries returning many entries
still pay for collecting and ordering them. The wildcard-query scan fallback
and index construction are measured separately in
`packages/runner/test/cfc-dereference-coverage.bench.ts`.

## CFC flow-join lookup

`packages/runner/test/cfc-flow-join.bench.ts` measures one `deriveFlowJoin`
pass at every combination of 100, 300, and 1,000 label entries and 50, 200,
and 800 read activities. Concrete paths have three to six segments. Each
map also carries the three value, shape, and followRef wildcard templates
minted for a collection container. The reads overlap concrete entries and
those templates; the benchmark asserts both confidentiality contributions.

Runtime construction, seeding, journaling, assertions, and aborts stay outside
timing. Each sample uses a fresh transaction and includes the pass's metadata
resolution and index construction. Entry count and read count vary independently
so the grid separates per-document preparation from per-read lookup. This
synthetic pass benchmark does not measure mapped rendering or a browser.

The index returns matching entries in label-map order. Concrete queries cost
path traversal plus wildcard candidates under matching container prefixes and
the entries returned. Recursive root reads and wildcard queries can still
consume the whole map; the grid measures narrow concrete reads.

## CFC authoritative label coverage

`packages/runner/test/cfc-authoritative-cover.bench.ts` compares a plain scan
with the prefix-only `ConsumedLabelIndex` lookup used to protect carried link
labels from longest-prefix shadowing. It uses the path-index source grid and
8,192 concrete queries per sample. Each query selects all deepest matching
entries; wildcard queries are covered by unit tests and use the scan fallback.

The timer includes index construction and candidate selection. Divide the
reported nanoseconds by 8,192 for amortized per-query cost. Label merging,
fixture creation, and scan-equivalence assertions are outside this benchmark;
persistence tests verify the final labels. Construction is paid once per link
write that has a usable carried entry, so the amortized result depends on the
number of queries per write.

## Scoped snapshot memo reuse

`packages/runner/test/snapshot-memo.bench.ts` measures repeated CFC label-view
requests within an ambient metadata scope, both at the current instant and at a
historical read epoch. Each sample opens a fresh transaction and makes 74, 296,
or 1,184 requests for one labeled address. Setup and transaction cleanup are
outside the timed interval.

The reused-memo case includes its first miss. The cleared-memo control clears
only the active snapshot memo before each request; storage read caches remain
active. That control includes clearing the map and journaling the additional
reads. Both cases still merge label views for every request. They measure the
cost of repeated derivation in this fixture, not a whole-pattern speedup.

Untimed diagnostics verify one metadata read with reuse and one per request
with clearing. These are transaction read activities, not proxy-access counts
or storage network requests. Run with `deno bench -A --json
packages/runner/test/snapshot-memo.bench.ts`; the JSON timing report goes to
stdout and the exact read counts go to stderr.

## Index maintenance count probe

Run `deno run -A scripts/collection-index-cost.ts` from the repository root to
measure `groupBy` and `keyBy` at 32, 128, and 512 independently linked rows, with
unique keys and four duplicate-key buckets. Each case measures initialization,
unrelated and selected payload edits, a selected key edit, membership insertion,
reordering and removal, and lookup retargeting as separate phases on one evolving
fixture per case. Assertions check the resulting values after every phase, zero enumeration runs for these
lookup-only consumers, and no action reruns for an unrelated payload edit. A
complete run ends with `COLLECTION_INDEX_COST_COMPLETE`. The probe uses the
shared collection occurrence-identity helper and UTF-8 comparison to check the
canonical winner and group order after every
phase, including winner removal and lookup retargeting.

The JSON records sum `scheduler.run.complete` action bodies and their proxy
accesses and link resolutions. They exclude compilation, external transaction
setup, storage synchronization, and scheduler work outside completed bodies.
Result validation runs after each record is captured. The probe fixes client
execution and lazy materialization on; it reports counts, not elapsed time.
Membership edits replace the source membership array, while payload and key
edits address one linked row. The group consumer reads all matching titles; the
unique-key consumer reads its winner's title. These different consumption widths
are part of their respective measurements.

The [phase measurement report](../history/development/performance/2026-09-11-index-maintenance-phases.md)
records the validated local count matrix and its limits.

## Topics computation cost probe

Run `deno run -A --frozen scripts/topics-computation-cost.ts` from the
repository root to measure the Topics board's mention pivot, each topic's
backlink lookup, and a topic's comment and link aggregates over the headless
fixture in `packages/patterns/integration/topics-headless-fixture.ts`. The
fixture writes synthetic topics straight to emulated storage and runs the
unmodified Topics lifts — `crossrefTable`, `backlinksOf`,
`presentCommentCountOf`, and `lastActivityOf` — with no browser and no server.
Each case runs in a process of its own, started with `--frozen` as well, so no
process in a run writes `deno.lock`.

The options select what runs:

- `--small` runs only the small cases, which make the smoke run.
- `--filter=<regexp>` runs the cases whose ID the expression matches.
- `--repeat=<n>` runs every selected case `n` times, in rounds, so that repeated
  samples of one case alternate with the others rather than running back to
  back.
- `--max-old-space-size=<megabytes>` sets the heap each case's process runs
  under.
- `--mode=<name>` runs every case under that measurement mode, which defaults
  to `lazy-materialization-on`. [The modes](#the-modes) below list them.
- `--derive-limits` runs the read-budget cases instead and prints their limits,
  as [the read budget](#the-read-budget) describes. It takes no other option
  but `--max-old-space-size`, so the limits are derived under the default mode
  and refuse `--mode`: the limits go into one table that carries no mode, and
  three of the five counts a limit gates are proxy accesses, which a run with
  lazy materialization off has been measured to leave at 0 in every phase.

### The modes

A mode is an experimental posture the run's runtimes are given, and every
record the run writes — `environment`, `sample`, `limit` and `complete` — is
labeled with it, so a result file says which semantics produced it without a
reader consulting where the file sits.
`TOPICS_FIXTURE_MODES` in the fixture holds them:

- `lazy-materialization-on` pins `lazyMaterialization` on, which is the posture
  a runtime takes by default.
- `lazy-materialization-off` pins it off, so that a lift's body reads the whole
  of what its schema selects rather than the paths it touches.

Both pin `serverExecution` off. A measurement's runtime runs over an emulated
storage manager in one process, with no memory server and no serving loop,
where the ON posture needs a toolshed carrying an `ExecutorHost` over its
memory server; see
[`serverExecution`](EXPERIMENTAL_OPTIONS.md#serverexecution). Server execution
is measured in the browser tier, which has a toolshed to serve.

A measured case's label comes from the flags its runtime reports back once it
has resolved what it was given, not from the option asked for, so the label
reads the same field the runner acts on. Every mode sets both flags explicitly
and a runtime keeps an explicit value, so the two cannot part today; the probe
checks them against each other anyway, against a flag that later resolves
against an ambient control point. A `board` case starts no runtime at all, so
its sample carries the mode the run was given rather than one a runtime
reported.

### The heap the 512-topic cases need

V8's default heap can be too small for the `all-backlinks` cases at 512 topics,
so pass `--max-old-space-size=8192` to any run that includes them. The probe
starts each case's process with a larger heap only when that option is given. A
case whose process exhausts its heap is recorded as a `limit` line rather than a
sample:

```sh
deno run -A --frozen scripts/topics-computation-cost.ts --max-old-space-size=8192
```

### The matrix

The pivot cases hold 32, 128, and 512 topics under the `low-degree`,
`high-degree`, and `single-bucket` mention graphs, at four mentions per source.
At 32 and at 128 topics a sweep varies mentions per source over 0, 1, 4, and
16, where 0 is the `none` graph: 32 topics is the size the read budget gates,
and 128 is the size the probe reports the effect of mention degree at. The
small pivot cases hold 4 topics, with as many mentions per source, up to four,
as each graph allows. The fixture's documentation of
`MentionGraph` says how each graph spreads its mentions.

The thread cases hold four topics, each with 10, 100, or 1,000 comments and
three links, then with 10, 100, or 1,000 links and three comments. The small
thread case gives each topic one comment and one link.

The pivot cases are recorded under three demand workloads. The first topic is
the focus topic: the one `topic-open` opens. The mention phases change which
topics mention it, and the comment and link phases edit it; the unrelated
sibling edit changes a different topic, the last one.

- `board`: a board loaded before any topic is opened, which demands none of the
  four lifts. The probe does not measure it: each `board` case writes a sample
  recording `measured: false` and the reason, and starts no process.
- `topic-open`: the board with the focus topic open, which demands the pivot,
  the focus topic's backlinks, and its present comment count, but not its last
  activity.
- `all-backlinks`: the pivot and every topic's backlinks. This is a scaling
  probe, not what a board in use demands.

The `board` and `topic-open` definitions come from one browser measurement of a
small Topics board, with client execution, lazy materialization on, and card
values already stored. Loading the board, before any topic was opened, ran none
of the four lifts, since the cards read their stored values. Opening a topic ran
the pivot and that topic's backlinks and comment count, but not its last
activity. Returning to the board afterward ran that topic's last activity once;
a board returned to after opening a topic is not one of the probe's workloads.
That is one small sample. Server execution, and lazy materialization off, were
not measured.

The thread cases are measured under one workload, `aggregates`, which demands
every topic's present comment count and last activity and nothing else. Those
are the lifts that read a topic's comments, which the thread cases scale, and of
the two the last activity reads the topic's links as well; no pivot workload
demands a topic's last activity. The browser ran them only for the topic it
opened, the comment count on opening that topic and its last activity on
returning to the board; `aggregates` runs every topic's, so it is not what a
board in use demands either.

A case's ID names all of that, as
`pivot/<graph>/mentions-<count>/topics-<count>/<workload>` or
`thread/comments-<count>/links-<count>/aggregates`.

### The phases

Initialization runs from the transaction that starts the demanded lifts through
settlement. Compiling the Topics sources and writing the fixture come before it
and are not measured. The warm updates then run in turn on the same fixture,
each measured from the start of its edit through settlement:

- mention removal, in which the first topic that mentions the focus topic drops
  every entry naming it;
- mention insertion, in which that topic appends one entry naming the focus
  topic again;
- a same-count retarget, in which that topic points its one entry naming the
  focus topic at a topic it does not yet mention, leaving the focus topic's
  mentioners and joining that topic's. Where it already mentions every other
  topic, the entry points at one it mentions, and the phase's `edit` record says
  the target gained no mentioner;
- comment append, edit, and retraction on the focus topic;
- link removal, which stamps the focus topic's first present link as removed;
- an unrelated sibling edit, which writes the last topic's `title` and nothing
  else. None of the measured lifts reads a title. A rename through a topic also
  stamps `titleUpdatedAt`, which `lastActivityOf` reads, so this phase is not a
  rename.

Where nothing mentions the focus topic, as in the `none` graph, mention removal
is not measured and insertion starts from the second topic. The warm updates
write storage directly, so what a live edit costs beyond those writes is not in
the counts: dispatching its handler, running `mentionsOf`, which derives the
mention list the pivot reads, and the reads of the edit's own transaction.

The last phase, `reopen`, disposes the runtime without closing its storage,
opens a fresh runtime over the same storage manager, and starts the demanded
lifts again over the fixture and the outputs the case has stored. It is measured
from the transaction that starts the lifts through settlement, as initialization
is; disposing the old runtime and compiling the sources for the new one come
before it. Both runtimes share one storage manager, so the phase reopens storage
the process holds open; it does not measure a new client connecting to that
storage. Initialization's `other` bucket counts runs that reopen does not
repeat, so comparing the two phases' totals takes in that difference as well as
the lifts' own work. After reopen the probe also checks that every lift the
workload demands completed at least one action.

A phase the fixture cannot give records `measured: false` and a `reason` saying
why; every other phase record carries `measured: true`. After every phase the
probe checks that the measurement holds exactly the outputs its workload demands
and checks each of them, the pivot when demanded included, against values
computed from the fixture data. It also checks that no lift outside the
workload's demand completed an action in the phase. It fails the run on a
mismatch, on a lift outside the demand completing an action, or on an error the
runtime reports.

### The output

Standard output carries JSON lines. Standard error carries progress and
everything a case's process prints.

- The first line has the `kind` `environment`: the git revision and whether the
  tree is dirty, the Deno, V8, and TypeScript versions, the platform, the
  processor count, the `mode` the run was given and the experimental options
  that mode pins, the arguments, the V8 flags each case's process starts with,
  the `repeat` count, and the selected case IDs.
- A `sample` line is one case in one `round`: its `mode`, the case, its `family`
  (`pivot` or `thread`), its series, the `size` its series scales, its
  `workload`, the fixture's options with its mention count, the `focusTopic` and
  its `focusMentioners` count, and `demandedActions`, how many actions of each
  lift the workload starts. A measured sample adds `measured: true`, the heap
  limit its process ran under, and a record per phase; a `board` sample adds
  `measured: false` and the `reason` instead.
- A `limit` line records a case whose process exhausted its heap, which the
  probe recognizes by V8's out-of-memory message on the process's stderr. It
  names the run's `mode`, the case, its series (the ID with the scaled count
  written as `*`), the `size` that failed, `largestBuilt` (the largest smaller
  size of the series with a sample, or `null`), the heap limit the process ran
  under, how long it ran, the signal or exit code that ended it, and the
  out-of-memory message. No size of the series from `size` up runs again, and
  `skipped` lists the larger ones; an earlier round may already have sampled
  them.
- The last line has the `kind` `complete`, with the run's `mode`, the number of
  `samples` the run wrote, and the `limitedSeries` that recorded a limit. A case
  that fails in any other way ends the run with an error and no `complete` line.

A measured phase records:

- `edit`, for a warm update, the topic and entry indices its edit touched, with
  `removedEntries` for a mention removal and `targetGainsSource` for a retarget;
- `elapsedMs`, from the start of the phase through settlement;
- `bodies`, the completed-body reads that
  [read accounting](../features/read-accounting.md) defines, attributed to a
  lift by the authored source each run reports and grouped by role: `producer`
  holds the pivot, `consumer` the backlink lookup, `aggregate` the comment count
  and last activity, and `other` every remaining run, sinks and builtins
  included. `total` sums them all. Each entry counts runs, actions, proxy
  accesses, link resolutions, and per-run sums of distinct documents and
  registered dependencies, with the most proxy accesses of any one run;
- `attempts`, the transaction-attempt reads through settlement, of every kind,
  grouped by the same roles. An attempt counts toward a lift when its action
  completed a run of that lift in the same phase, and toward `other` when its
  action completed some other run there or when it names no action, as the
  initialization attempt does. An attempt whose action completed no run in the
  phase, such as one aborted because a read was unavailable, is under
  `unattributed`. `total` sums them all;
- `graph`, the scheduler's node and edge counts once settled;
- `memory`, the heap used, heap total, resident set size, and external memory,
  with `collected` saying whether a full collection ran before they were read.

The complete settled operation is the unit a comparison decides on:
`bodies.total` and `attempts.total` cover all of it, and the role groups show
where the work sits. Elapsed times are local wall-clock samples, for comparison
across `--repeat` rounds; nothing gates on them.

### The read budget

The read-budget tests hold a fixed set of probe cases to limits on their read
and graph counts, in continuous integration. Each case is measured in the test's
own process through the same fixture, phases, checks, and phase records the
probe uses, with no browser and no server.
`packages/patterns/integration/topics-read-budget.ts` names the cases and holds
the rules below, and `topics-read-budget-limits.ts` beside it holds the limits.
The cases are divided into groups, and each group runs in a test file of its
own, `topics-read-budget-<group>.test.ts`, so that no one file takes too large a
share of a lane.

The gated cases are:

- the 4-topic `low-degree` pivot cases under `topic-open` and `all-backlinks`;
- the 32-topic pivot cases under both workloads for the `high-degree` and
  `single-bucket` graphs at four mentions per source, and for the `low-degree`
  graph at 16;
- the thread cases with one comment and one link, with 100 comments, and with
  100 links.

No `board` case is gated, since the probe measures none. Every gated pivot
case holds 32 topics or the small case's 4, and no gated thread case holds more
than 100 comments or links; the larger sizes run only from the probe. A
regression that appears only above 32 topics is one the probe finds, not
continuous integration.

Every measured phase of a gated case has a limit on each of five counts, read
from its phase record:

| Count          | Phase record field                 | What it counts                                                                                                                       |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `attemptTotal` | `attempts.total.proxyAccesses`     | Proxy accesses of every transaction attempt from the start of the phase through settlement, each counted through its commit or abort |
| `bodyTotal`    | `bodies.total.proxyAccesses`       | Proxy accesses of every reactive body that completed in the phase, each counted from the start of the body to its end                |
| `bodyPerRun`   | `bodies.total.maxRunProxyAccesses` | The most proxy accesses any one of those bodies made                                                                                 |
| `graphNodes`   | `graph.nodes`                      | The scheduler graph's nodes once the phase settled                                                                                   |
| `graphEdges`   | `graph.edges`                      | The scheduler graph's edges once the phase settled                                                                                   |

The two read boundaries are the attempt and body boundaries that
[read accounting](../features/read-accounting.md#execution-boundary) defines,
and each count covers the complete settled operation: the pivot, lookup,
aggregate, and every other run together. A limit is the largest count five runs
of the case observed, plus 10%, rounded up to an integer. A phase in which the
case read nothing has a limit of zero on that count: the unrelated sibling edit
is such a phase in every gated case, since no measured lift reads a title. A
change that adds any read there exceeds the limit.

Each limit has a negative control: a regression variant that grows the count the
limit gates, and that must exceed it. `--derive-limits` runs the controls, on
the limits it has just derived, so that every limit is shown to gate a count a
regression grows. The variants are built in `topics-read-budget-variants.ts`
over the unmodified Topics sources, and each starts its work beside the demanded
lifts, in the same transaction:

- `scan`, assigned every read count, is one lift over the board that reads each
  topic's title, the titles of the topics it mentions, and every stamp on its
  comments and links. Each warm update writes one of those, so the scan runs
  again in every phase.
- `duplicate-demand`, assigned the graph counts of the pivot cases, starts a
  second instance of each demanded lift, the pivot among them.
- `per-record`, assigned the graph counts of the thread cases, starts a lift
  for each comment position and each link position on every topic.

Every limit is an upper bound, so the budget catches a change that reads more
and is blind to one that reads differently. Lazy materialization turned back
into eager traversal is the case that matters: it makes fewer proxy accesses,
not more, while every topic's `backlinksOf` runs again on each mention edit.
`packages/patterns/integration/topics-lazy-lookup-reruns.test.ts` holds that
property directly, on the 32-topic `high-degree` `all-backlinks` case under
lazy materialization: a mention edit re-runs the lookups of the topics whose
pivot row changed, and no other.

A case's test fails when a count exceeds its limit, when a measured count has no
limit, or when a limit names a phase the case did not record. The failure names
the workload, case, phase, count, observed value, and limit. Run one group from
`packages/patterns` with:

```sh
deno test --v8-flags=--max-old-space-size=4096 -A \
  ./integration/topics-read-budget-high-degree.test.ts
```

Continuous integration runs these files as units of the `pattern-integration`
and `pattern-integration-opposite` suites, packed into lanes by what each has
cost before.

To derive the limits again, run from the repository root:

```sh
deno run -A --frozen scripts/topics-computation-cost.ts --derive-limits \
  > topics-read-budget-limits.derived &&
  mv topics-read-budget-limits.derived \
    packages/patterns/integration/topics-read-budget-limits.ts
```

The command runs every gated case five times, in rounds, each run in a process
of its own as the probe runs a case, and prints the limits module. It imports
the module it prints, through the read-budget rules, so its output goes to a
file of its own and replaces the table only once the command succeeds;
redirecting it straight into the table empties the table before the command
can load it. A count that does not repeat identically across the five runs is
printed as ungated, with the value each run observed, and is not checked; the
command then fails, naming it, and leaves `topics-read-budget-limits.derived`
holding what it printed. `.gitignore` covers that file; delete it once you have
read it.

The control pass runs only when every count repeated. The command then runs
each gated case once more under every variant its limits are assigned to, and
fails when a variant leaves one of those limits unexceeded, naming the workload,
case, phase, count, variant, observed value, and limit of each.

A failing read-budget test has found a count that grew. Attribute the added
reads or graph size to a phase and a role in the probe's records before
changing anything else. A limit moves only when the table is derived again, and
not to let a change pass: as
[the plan's measurement protocol](../plans/topics-computation-cost.md#measurement-and-acceptance)
says, a candidate that exceeds a limit is revised or deferred rather than the
limit moved, and a new tradeoff needs a documented decision and rationale.
Nothing here limits startup time or latency.

## Engine current-state reads

`packages/memory/test/v2-engine-read.bench.ts` measures reading 256 documents
through the memory engine, once each, when every decoded revision is already in
the engine's document cache. What a read costs past that cache is resolving its
branch and finding its revision row in SQLite, so the case tracks the per-read
statement cost. One case reads at the default branch's head; the other reads on
a fork that holds no rows of its own, so every read falls through to the parent
as of the fork point. The fixture is written once per run, and checking what the
reads returned is outside the timed interval. Run with:

```sh
deno bench --no-lock -A packages/memory/test/v2-engine-read.bench.ts
```

## JSON Pointer encoding

`packages/memory/test/v2-path.bench.ts` measures encoding 256 distinct paths and
looking each result up in a prebuilt Map. The lookup consumes the encoded
string, including hashing or flattening deferred by string construction. Fixture
construction and checksum validation are outside the timed interval.

The plain-path cases sweep depths 1, 4, and 12. Separate depth-4 cases use long
segments or both JSON Pointer escape characters in every segment. These
synthetic controls distinguish segment traversal from character scanning and
escaping; their proportions do not estimate a deployed workload. Run with:

```sh
deno bench --no-lock --json packages/memory/test/v2-path.bench.ts
```

The
[local encoding measurement](../history/development/performance/2026-09-14-encode-pointer.md)
records interleaved comparisons and their limits.

## Refresh schema-closure walk

`packages/memory/test/v2-refresh-schema-closure.bench.ts` measures a push
refresh of a tracked graph after a commit to a tally document whose one link
schema references a schema document the graph already holds, for a graph
already delivered 10, 100, or 1,000 schema documents through a carrier whose
links reference each of them. Each sample commits the next tally value and then
times `refreshTrackedGraph()` over that one dirty document; fixture
construction, the commit, and the check that the refresh delivered only the
tally are outside the timed interval.

The tally's schema reference is a root of the refresh's schema-closure walk.
The walk covers only the closures its changed documents reference and stops at
schema documents the graph already established, so its cost should not grow
with the schema count. The documents one untimed refresh reads go to stderr per
fixture — one, the tally, at every size — which is the count to compare when a
timing moves. Run with:

```sh
deno bench -A --json packages/memory/test/v2-refresh-schema-closure.bench.ts
```

## String tuple keys

`packages/utils/test/string-tuple-key.bench.ts` measures encoding 256 distinct
string tuples and looking up their values in a prebuilt Map. The cases cover
two-field document identities, three-field cache slots, five-field consumed
sources, and fields containing escape characters or Unicode. Construction and
checksum checks stay outside the timed interval; the lookup includes string
hashing and flattening.

`stringTupleKey` is available through `@commonfabric/utils/string-tuple-key`.
It preserves string and tuple boundaries, including empty strings and embedded
NULs. Its opaque output is for internal Map and Set identities whose components
are all strings. A caller with a fixed string prefix and one trailing path can
spread that path into the tuple. Multiple variable-length arrays need explicit
boundaries; structured or nullable identities need their own encoding contract.
Existing persisted and wire key formats keep their protocol-defined encoding.

The collector and scheduler effects are tracked by
`packages/runner/test/cfc-consumed-source-dedup.bench.ts` and
`packages/runner/test/scheduler-invalid-causes.bench.ts` respectively.

## Labeled pattern-test mapped render

`packages/cli/test/fixtures/cfc-flow-labels/mapped-render.test.tsx` is the shared
headless regression fixture for CFC preparation over mapped SQLite rows. It
seeds 150 rows with a confidential title column, queries 11, 50, and 150 rows,
and demands each full mapped VDOM through the worker reconciler. It needs no
connector, browser, or external store. After each render, a labeled-copy action
reads every title and writes plain row values into an ordinary writable store,
exercising writer-fit preparation separately from generated view outputs.
The file stays identical between arms;
only the runtime flags change:

```sh
# Arm A: enforcement disabled, flow labels off.
deno task cf test packages/cli/test/fixtures/cfc-flow-labels/mapped-render.test.tsx --cfc-enforcement-mode disabled --cfc-flow-labels off --verbose --stats-threshold 0 --no-idempotency-check

# Arm B: shell enforcement and flow-label posture.
deno task cf test packages/cli/test/fixtures/cfc-flow-labels/mapped-render.test.tsx --cfc-shell-posture --verbose --stats-threshold 0 --no-idempotency-check
```

The output names the resolved posture and each N. `render_1`, `render_2`, and
`render_3` correspond to N=11, 50, and 150. Their intervals exclude compilation,
seeding, and the preceding query assertion's row materialization. They include
mounting and removing the worker reconciler's demand and settling its synchronous
mapped work. There is no DOM or browser paint. The assertions verify row counts;
the CLI's regression test verifies both postures and nonzero arm-B flow/digest
spans, without gating elapsed time. `action_3`, `action_5`, and `action_7` are
the corresponding labeled copies. Their following assertions verify the copied
row counts. A separate storage test reads the stored source and destination
labels with enforcement fixed to `enforce-explicit`, checking that column labels
survive the query with flow labels off and that only `persist` propagates them
to the copy. Zero counts remain visible for operations a
phase does not call.

For comparisons, alternate A/B for at least five rounds on the same machine and
revision, preserve complete output, and report the size, posture, machine,
Deno version, and idempotency setting with each number. Compare matching render
steps across arms and revisions, recording distributions as well as minima.
Ordinary mapping and reconciliation scale with rows in arm A too; the control
is the absence of flow-derivation work, not a promise of constant render time.
No elapsed-time threshold belongs in the functional test.

Add `--timing-measures-out /tmp/mapped-B.json` (a distinct path per run) for
unrounded spans and `cf:runTestPattern/step/render_N/materialize#...` boundaries.
Use the aggregation and attribution tools in
[profiling](debugging/profiling.md) to locate the CFC work inside each interval.
Nested timing totals overlap: `prepareCfc` includes its derivation and initial
digest, while a commit recheck can hash again outside preparation. The spans
measure elapsed time, not CPU attribution.

This `cf test` probe runs on demand, outside the scheduled `deno bench` suite.
Keep its source and step order stable across the optimizations it measures.
The [CLI guide](../../packages/cli/README.md#pattern-test-cfc-posture-and-labeled-fixtures)
documents the dials, labeled table declaration, and reporting boundaries.
