# Code coverage in CI

This repository measures code coverage in two different ways, because it runs
two different kinds of code. Keeping the two apart is the key to reading the
numbers correctly and to deciding which test job should collect which kind of
coverage.

## Two kinds of code, two coverage mechanisms

### Runtime and framework code is measured by Deno's V8 coverage

The packages that make up the Common Fabric runtime (api, runner, identity,
memory, and the rest) are ordinary TypeScript modules. Deno loads and runs them
directly, so Deno's built-in V8 coverage can record which of their lines ran. A
CI job turns this on by setting the `DENO_COVERAGE_DIR` environment variable.
After the tests finish, `tasks/write-coverage-lcov.ts` converts the raw V8
profile into an LCOV file, and the job uploads it as a `coverage-profile-*`
artifact. Most test jobs set `DENO_COVERAGE_DIR`. The pattern and package
integration jobs set it. The two workflow jobs running the opposite
server-execution arm set none.

A focused `*.browser.test.ts` file run through `deno-web-test` executes its
application module inside Chrome. That browser execution proves DOM behavior,
but it does not enter the Deno V8 profile. Put reusable policy and state
transitions in an ordinary source module and exercise them from a plain Deno
unit test as well; keep the browser case for the boundary only a real DOM can
prove.

Do not name a source file so that its path ends in `test.ts` (or `test.tsx`,
`test.js`, `test.mjs`, `test.jsx`). `deno coverage` takes those for test files
and leaves them out of the report, even though V8 records them and even if
`--exclude` is overridden. The debt metric reads a missing report entry as a
file no test ever loaded and charges every one of its lines, so a well-tested
file scores as entirely uncovered. This is why the `cf test` command lives in
`commands/test-command.ts`.

#### A file can also drop out of the report on its own

`deno coverage` builds the report from each covered file's transpiled form in
the Deno cache rather than from the source on disk. A file whose transpiled form
is absent from the cache is left out of the report, with a warning on stderr and
no change to the exit status. Because the debt metric charges every line of a
file that has no report entry, such a drop reads downstream as a coverage
regression that no change in the tree explains.

`deno coverage` says which of two things happened, in two different messages,
and `tasks/write-coverage-lcov.ts` acts on the difference:

- `Missing transpiled source code for: "<url>"` — the source is on disk but the
  cache holds no transpiled form of it. For a file the debt metric tracks that is
  a file the report should have carried: the script names those files and exits
  non-zero, after writing the report of what did convert so it can be read while
  the cause is found. Three things cause it. The profiles were collected by one
  Deno version and reported by another, which happens when a test starts the Deno
  on `PATH` instead of the Deno running it. Or they were collected from a working
  directory under a different Deno configuration, because the cache key covers
  the configuration in scope where the file was compiled. Or the run that
  collected them could not write the cache at all, which is what an agent
  sandbox that denies writes to `DENO_DIR` produces: the tests pass, because
  the transpiled form is held in memory, and every file is then missing from
  the report, so `deno coverage` says the profile covered nothing rather than
  naming the denial. Collect coverage outside the sandbox.
- `Source not found for "<url>"` — the source is gone, so a test compiled the
  file and then deleted it. No report could name it, so the script warns and
  carries on.

A file the metric does not track is only ever warned about, whichever message it
came with, because its absence from the report costs nothing. The conversion asks
the metric's own `isTrackedSourcePath`, so the two cannot drift apart. That
covers a file outside the repository, which is what a test that copies a fixture
project into a temporary directory and runs Deno there produces, as well as one
inside it that the metric never charges for — anything under `docs/` or
`scripts/`, a test or fixture directory, a `.test.ts` or `.d.ts`.

An empty report is not a failure by itself. `deno coverage` calls it an error
when nothing survives its filters, which happens honestly whenever a profile set
covers only test files, since those are excluded by design. With no repository
file dropped, the script takes that emptiness at face value: it warns and exits
zero. It also warns and exits zero when there was nothing to convert in the first
place, which is what a job whose test step never ran produces — the profile
directory is absent, or holds only empty files. Any other `deno coverage` failure
is an error.

Every one of those paths writes an output file, so the artifact upload always has
one to collect and the outcome is read from the conversion step rather than from
a missing file. What reads the report decides what an empty one means: the pull
request coverage gate fails a measured set the change forced whose reports name
no line of its member, as [Test selection](test-selection.md) describes.

### Authored pattern code is measured by transformer instrumentation

Patterns (the user programs under `packages/patterns`) are not loaded the way an
ordinary module is. Each pattern is compiled through the Common Fabric
transformer pipeline and then run inside a sandbox. Deno's V8 coverage never
sees the authored pattern statements execute, so it cannot report which lines of
a pattern ran.

To measure that, a `PatternCoverageCollector` is attached to the runtime. The
transformer then injects a coverage "hit" call in front of each authored
statement, and the collector receives the hits; the line numbers it records
point back at the authored pattern source. There are two ways a runtime gets a
collector:

- The `cf test` command builds one when the `CF_PATTERN_COVERAGE_DIR`
  environment variable is set (or the `--pattern-coverage-dir` flag is passed)
  and writes one `*.pattern-coverage.lcov` file per test. This is the pattern
  unit path.
- A runtime constructed with `RuntimeOptions.patternCoverage` set instruments
  every compile it performs, including the content-addressed cell-cache path a
  piece load takes. The instrumented compile is keyed as a distinct cached
  variant, so a coverage-on runtime never serves the uninstrumented bytes an
  ordinary compile stored. This is how the browser worker collects coverage in
  the integration path (see below).

These properties of this mechanism are worth keeping in mind:

- The counters are statement based. A single statement that spans several lines
  marks its whole source range as run the moment the statement is reached. The
  number answers "did this statement run", not "was every line independently
  exercised".
- Coverage records that a line ran. It never records that a test checked the
  result of running that line. A test that drives a pattern through a flow
  without asserting anything still marks those lines covered.
- Handler bodies and derived expressions run only when a test drives them, and a
  pattern unit test can drive both. A JSX handler, inline or bound, compiles to a
  stream on the node's prop: a test walks the rendered tree to the node, reads
  the prop, and sends it an event. A derived expression such as `{count * 2}`
  runs when a test reads the node it builds. So UI raises the uncovered-line
  count only until a test drives it; write that test rather than taking an
  `ACCEPT_COVERAGE_DEBT` marker.
  [pattern-testing.md](../common/workflows/pattern-testing.md) shows how.

#### What a pattern test has to read

The last bullet generalizes past handlers and derived expressions. Almost every
line of a pattern outside a handler body runs when something reads the value the
pattern returns, and a pattern test that drives streams and compares scalars
reads hardly any of it. Three groups go uncovered that way, and one pattern test
can take all three.

The view is the first. A pattern's view helpers are ordinary functions, and
nothing calls one until something reads `[UI]`. Reaching for a node is what
builds the tree, so one assertion that walks to a node covers every helper the
tree called on the way there. `packages/patterns/test/vnode-helpers.ts` holds
the walk. Tie the assertion to something the file already claims rather than to
a node's bare existence:
`hasText(findNodeById(instance[UI], "gallery-count"), "16 total examples")`
states the rendered header against the count the same test asserts through
`totalExamples`, so a gallery that computed its count and rendered nothing
fails.

The returned record is the second. A `computed()` sitting in it runs when a
reader asks for that field, so `[NAME]` and any output the test never compares
against goes unrun. State those against the values the test's own actions put
there, which says the setter stream reached the cell the field reports.

A stream nobody sends to is the third. A handler the pattern exposes and no test
drives has a body that runs in neither lane, so it sits at zero on every run
rather than moving between them. That is permanent debt rather than flap, and it
costs one more action apiece to clear.

`packages/patterns/cfc-spec-gallery/main.test.tsx` is the worked example. It
reads its view, states its name and the four inputs it reports back out, and
drives every stream the gallery exposes, which takes the file from 385 of its
522 measured lines to all of them. Before that the integration lane was the only
one covering the other 137, and
[the investigation record](../history/development/coverage-flake-cfc-spec-gallery-view-2026-09-01.md)
is what that cost the group on a run where the lane's report went missing.

`CF_PATTERN_COVERAGE_DIR` names the directory the `*.pattern-coverage.lcov`
files are written to. The `cf test` command in
`packages/cli/commands/test-command.ts` reads it directly. The browser
integration path does not run through `cf test`; there the integration harness
reads the same variable to decide whether to turn worker coverage on and where to
write the merged LCOV it pulls back from the browser (see "How the integration
jobs collect authored-pattern coverage").

## How the two feed the coverage gate

The Coverage Check job downloads every `coverage-profile-*` artifact with
`actions/download-artifact`. The action checks each artifact's recorded digest.
`tasks/coverage-check.ts` verifies that every expected artifact is present. It
joins all the downloaded LCOV files together and hands them to
`tasks/coverage-metrics.ts`. That code walks the tracked source files under
`packages` and `tasks`. For each file, it counts how many lines no test covered.
The top-level `scripts` directory is excluded from this gate. The counts roll up
into
`coverage-debt: <group> uncovered lines` metrics, for example
`coverage-debt: packages/patterns uncovered lines`, and the coverage check
gates a pull request on them.

Authored pattern files under `packages/patterns` are tracked source files, so
their uncovered lines count toward `coverage-debt: packages/patterns`. Every
authored-pattern coverage stream feeds this one metric: the `pattern-unit-test`
job's coverage (`TN:pattern-runtime`) and the integration jobs' coverage
(`TN:pattern-runtime-integration`) both join the combined LCOV, and a line
covered by either counts covered. Nothing in the accounting reads the test name —
the two are kept distinct only so a reader of the combined report can tell what
covered a line.

One detail of the gate's accounting is worth knowing when reasoning about
pattern coverage. A file with no LCOV record has every tracked line counted as
uncovered, unless it compiles to no code at all, opts out of coverage, or sits
in a package the run never started — see the subsections below. A file with a
record is scored against the lines that record names.
For a file measured by Deno's V8 coverage that is every executable line; pattern
instrumentation names only the statements it could instrument, so a pattern
file's first record both covers real lines and drops the never-named lines out of
the count.

The gate absorbs that safely, because it is a ratchet: it fails a pull request
only when a group's uncovered count *rises* above its `main` baseline.
Gaining a record can only *lower* a file's count, since the record names a subset
of the file's lines and the rest stop being counted, so it settles at a lower —
and therefore stricter — bar rather than failing anything. The instrumented
statements are also the only lines this mechanism can speak to: a line the
instrumentation cannot reach is not a line a pattern test could cover.

### A file that compiles to nothing is charged nothing

Charging every tracked line of a file with no coverage record is how the gate
catches source that no test ever loaded. A second kind of file also has no
record: one holding only declarations — interfaces, type aliases, ambient
declarations — which compiles to an empty module. Such a file has no statement
to run, so a test that loads it executes nothing and Deno's coverage has nothing
to report. No test can cover a line of it, so the gate charges it nothing.

The gate tells the two apart by compiling each file it finds no record for, and
charges it only when something comes out. `tasks/executable-source.ts` runs the
file through the TypeScript compiler and reads the emitted JavaScript: a file
that emits no statement, an `export {}` module marker aside, is charged nothing,
and every other file is charged its full tracked-line count. Which constructs
reach the output is the compiler's rule. An enum, a namespace holding a value,
and an import kept for its side effects all emit code. A type-only import, a
namespace holding only types, and a comment do not. The compile happens at gate
time, once per file the report leaves out. A file with a record never pays for
it, because its record already says which of its lines ran.

Such a file occasionally does get a record. A comment that survives into the
emitted output leaves Deno one line to report, and that line is hit the moment
the module loads, so the file contributes nothing either way.

The charge is all or nothing. The first line of runnable code added to such a
file charges the whole file, which is the bill a new module of that size runs
up. A file that gains code usually gains a coverage record with it, and that
brings the charge down to the lines no test reached. The full charge stands
only while nothing loads the file.

### A file that opts out of coverage is charged nothing

A `// deno-coverage-ignore-file` comment on a file's first line, or on the line
after its shebang, opts the file out of Deno's coverage: `deno coverage` leaves
it out of the report it writes, whether or not a test loaded it. The gate reads
the same line for a file the report has no record for, and charges such a file
nothing, so the comment means the same thing on a file no test can load as on
one a test did.

Those are the only lines Deno reads it from, ahead of every other comment and
pragma; the same comment anywhere later leaves the file in Deno's report and
charged by the gate. A `// @ts-check` or a `deno-lint-ignore-file` goes on the
line after it. Text may follow the directive after whitespace, which is the
place for the reason:

```text
// deno-coverage-ignore-file -- runs only in a browser, as inlined text
```

The comment is for a file Deno's coverage cannot measure. A notable case is a
source file that runs only in a browser, such as one imported as text and
inlined into a document a frame loads: no Deno-run test can load it, so no
test could pay its debt down, and the browser tests that do drive it report
into nothing this metric reads. A file a Deno test could load is not such a
file, and the ratchet is what holds it to its tests.

### A package a run never started is not scored at all

`deno task test` stops handing packages to its workers as soon as one of them
fails, and the packages already running finish. What a failing run measured is
therefore whatever was in flight rather than a prefix anyone chose, and the
packages it never started have unknown coverage rather than none. Charging
those the way a file no test loaded is charged reports a collapse of thousands
of lines in packages the change under test never touched, in numbers that are
otherwise well formed and that nothing downstream could tell from a real
measurement.

So the runner records the members it selected and never started, writing
`unlaunched-members.txt` into the run's coverage profile directory
([`tasks/unlaunched-members.ts`](../../tasks/unlaunched-members.ts) owns the
file). `tasks/write-coverage-lcov.ts` copies that record beside the LCOV report
it writes, the workspace test job uploads the two together as one artifact, and
`tasks/coverage-check.ts` reads the union of the records every artifact
carries. One job selects each member, so a member any record names is one that
nothing in the run measured against its own tests.

A run that started everything it selected removes any record it finds rather
than leaving one, in the profile directory and beside the report alike, so that
the record and the report always describe the same run. CI never reuses either
directory — every job runs on a fresh runner, and nothing restores a
`coverage/` path — but a local run that reuses one would otherwise go on
suppressing groups that an earlier run stopped short of and this one measured,
which is the same silent failure arriving from the other side.

A metric group holding such a member is left out of the run's metrics
altogether, and so is the workspace total, which no longer totals the
workspace. The gate builds one row per metric the run produced, so a group with
no metric is one the run does not speak for: it is neither gated nor reported,
and the job's log names it. An `ACCEPT_COVERAGE_DEBT` line naming such a group
fails the check, the same as one naming any group the run measured no coverage
for.

Two bounds are worth stating. The record names a member that never started, and
not one whose tests started and then failed — that member is measured as far as
its tests got, and the run's own failure report is what names it. And the whole
group goes unscored rather than the unlaunched member's files alone: one member
going unmeasured leaves the group's count short by whatever that member's tests
would have covered, with nothing in the report to say by how much, so the
members that did run are no more scorable than the one that did not. That
reaches a package measured by more than one job — `packages/shell` is covered
by both the workspace unit run and its own integration job — where the
workspace run skipping it is enough on its own to leave the group unscored.

## Coverage must not depend on the execution environment

Whether a line counts as covered must not depend on how fast the machine ran,
how the test files were distributed across shards, or any other property of the
environment or configuration. A line that is covered on one run and uncovered
on the next is a defect in the tests. It is not noise for the gate to absorb,
and it is not something to wave through with an override.

So when you find a line whose coverage moves with the environment — a branch
guarded on elapsed wall-clock time, a line whose count changes when test files
are redistributed across shards, a path that only some runs happen to take —
write a test that covers that line reliably on every run and under every
configuration. Extract the code into something a plain unit test can call
directly if that is what it takes: a unit test that constructs the input it
wants does not care how loaded the machine is or which shard it landed in.

The
[2026-07-28 investigation record](../history/development/coverage-ratchet-noise-2026-07-28.md)
works through two real instances, and describes how to localize a group-level
change down to the specific file and line so you know what to write a test for.

Before localizing, check that the group-level change is a measurement at all. A
group marked `excl` in the job's table under the line "Not gated, because no
baseline counts the same base-branch code as this run does" is comparing two
different bodies of code, because the ratchet stepped back to an older baseline
commit; its `Change` column then reports what the base branch did in between.
Comparing two runs directly has the same trap in a different form, since a
pull request's runs measure the merge ref, which GitHub rebuilds whenever the
base branch moves. Compare only files whose content is identical between the
two commits, and read the counts per line rather than per group.

### Diagnostics that fire on wall-clock time

The slow-traverse report in `packages/runner/src/traverse.ts` was one of those
instances. It logged a traversal's counters only when that traversal had taken
more than 100 milliseconds of real time, so it ran on a loaded machine and did
not run on an idle one. Thirty-nine lines moved with the load: the body of the
report, plus the two `MapSet` getters that nothing but the report called.
Several unrelated pull requests spent an `ACCEPT_COVERAGE_DEBT` marker on the
result.

Write such a diagnostic so that the elapsed time reaches it as a parameter,
rather than having the reporting code measure the time for itself. Put the
threshold comparison and the report together in a function that takes the
elapsed time, and call that function from the timed path every time, with no
condition around the call. That is what `maybeReportSlowTraverse()` does now.
Every line of the diagnostic then runs on every machine, and the clock decides
nothing except which way the comparison inside goes.

A test reaches the report by choosing the elapsed time. It can call the
function directly with a time over the threshold, or it can pin the clock the
timed path reads, which also proves that the path still reaches the
diagnostic. The `SchemaObjectTraverser slow-traverse reporting` cases in
`packages/runner/test/traverse.test.ts` are the worked example of the second.
They replace `performance.now` — what `logger.timeStart` and `timeEnd` read —
for the length of one traversal, and advance it from a store read, because
`traverse()` is synchronous and a test cannot step a clock from outside a call
that never yields. That the traversal really did read the store is asserted, so
a traversal that stopped reading could not pass the test vacuously.

The fake clock that a package's test task preloads does not cover a branch like
this one, and cannot. It replaces `performance.now` with logical time, and
logical time moves only when a positive-delay timer fires. A synchronous call
arms no timers, so a span timed around synchronous work measures exactly zero:
under the runner package's preload, `elapsed > 100` is deterministically false
in every test in the package. The `clock.tick(ms)` control is asynchronous and
advances nothing until it is awaited, so there is no way to move logical time
from inside a synchronous call either. A test that wants a chosen elapsed time
therefore replaces `performance.now` outright, saving and restoring it rather
than assuming it is the native one, since the preload already owns that
property. That is also why the movement was collected by the
pattern-integration jobs rather than by the runner suite: their coverage comes
from a browser worker, which a Deno `--preload` never reaches.

Leaving the threshold comparison behind at the call site does not reduce the
movement to nothing. The lines inside a guard are covered only on a run that
took the branch, so a call site of the form
`if (elapsed > SLOW_TRAVERSE_MS) report(...)` keeps its reporting line moving
from one run to the next, and one line of movement fails the ratchet exactly as
thirty-nine did. Do not reason from what the `if` line itself reports either.
That count is a projection of V8's block ranges onto lines: it differs between
the one-line and the braced form of the same guard, and it changed between deno
2.8.3 and the pinned 2.9.4, which now credits a braced guard's line with the
condition's own count. See
[deno coverage: one-line guard reported uncovered when its branch is not taken](deno-coverage-guard-line-artifact.md).

### Paths reached only when something happens twice

A second common shape is a line that runs only on the second occurrence of
something within one process: a cache that is populated the second time it is
asked, a guard that turns away a duplicate, a retry that only a second failure
reaches. Whether a suite produces that second occurrence is often decided by
scheduling rather than by anything a test asserts, so the line is covered on
some runs and not on others.

Write a test that produces the second occurrence itself rather than one that
performs an operation and hopes the suite repeats it. The
`records one violation for an action caught twice` case in
`packages/runner/test/scheduler-pull-idempotency.test.ts` is the worked
example. It reaches the deduplication guard in `runIdempotencyRecheck()` by
running one action twice over an input it moves, and it distinguishes a
deduplicated second detection from a single detection by having the action
write an incrementing count, so the recorded violation says which detection it
came from.

An assertion that only counts the outcome would pass either way and would leave
the line's coverage exactly as environment-dependent as it was.
[The August 2026 record](../history/development/coverage-flake-idempotency-dedup-2026-08-12.md)
follows one such line from a group-level `+2` down to the guard and the test.

### Rejection paths reached only when two writes race

The third shape is a branch that runs only when one write lands on a base
another write already changed: a merge that finds the key it removes already
gone, a precondition only a loser fails, a replay that has to drop a layer. The
surrounding code runs constantly. What decides whether the branch runs is the
order frames arrive in, which nothing in an integration suite asserts, so the
line is covered on some runs and not on others.

Reaching such a line does not take a race, and that is the way out of it. What
the branch responds to is the value the operation was handed, so a test that
constructs that value reaches the branch directly. `applyPatch()` is a pure
function over a value tree: its `missing object key` rejection, which the
client's pending-layer replay reaches when a `remove` names a key a winning
writer already dropped, is one call over a base object without the key.
`packages/memory/test/v2-patch-errors.test.ts` is the worked example, and it
states one case per rejection the module raises rather than only the line that
moved — a sibling branch in the same file is the next one to flap.
[The investigation record](../history/development/coverage-flake-patch-remove-missing-key-2026-08-17.md)
follows that line from a group-level `+2` down to the two integration hits that
covered it in one run and not the next.

What the second party holds need not be a write. A lease row another process
owns puts a branch in the same position: the server executor's `activate()`
reports `lease-unavailable` and returns `false` only when the space's execution
lease is already held, and the host arm that unregisters the refused space runs
only behind that. Nothing in the suite asks for a rival holder, so both were
reached when one case's park happened to chain a re-activation while the rival
row it had installed for a different purpose still stood. The way out is the
same one: a lease is a row, so a test writes the row and calls `activate()`. The
cases are in `packages/runner/test/executor-space-server.test.ts` and
`packages/runner/test/executor-serving-loop.test.ts`, and
[their investigation record](../history/development/coverage-flake-executor-contention-paths-2026-08-26.md)
follows ten lines across three files from a group-level `+10` down to the two
shards that reached them.

### Failure reports reached only when the operation fails

A fourth shape is the branch that reports a failure: the `if (error)` arm of an
asynchronous recovery, the log line that says a write was refused. The recovery
around it runs on every resume, and the report inside it runs only when the
write underneath fails. No test asks for that write to fail, so whether the line
is covered comes down to whether some suite, somewhere in the run, happened to
tear a runtime down while one was in flight.

The list coordinators' resume-seed recovery was one of those. A coordinator
resuming against a result container with no durable value pulls the container
and seeds an empty array once the pull settles, and it warns when either the
pull or the seed fails. One workspace shard on one `main` run reached the seed's
warning three times; no other artifact in that run or the next reached it at
all.

Reaching such a branch takes a failing operation, not a failing environment, so
give the recovery its operation as a parameter.
`seedResultContainerWhenPullSettles()` in
`packages/runner/src/builtins/list-result-container-seed.ts` takes the runtime,
the container, a predicate saying whether the coordinator still holds it, the
pull to wait on, and the logger to report through.
`packages/runner/test/list-result-container-seed.test.ts` then hands it a pull
that rejects and a runtime whose commits are refused. Each failure case asserts
the message key and the error carried with it, so a report that changed which
failure it named fails rather than staying green on the line count.

A guard reached only on a retry takes the same treatment. `editWithRetry()`
runs its action synchronously on the first attempt, so a liveness check inside
the action reads as unable to disagree with the one the caller just made — and
as a dead line. It is not: a retryable rejection is followed by an `await` of
the conflict's catch-up gate and then a fresh call that runs the action again.
A test reaches it by refusing the first commit with a `ConflictError` whose
`readyToRetry` gate flips the liveness answer, and asserts the commit count so
that a version which stopped retrying fails rather than passing vacuously.

Extracting it also settled where the branch lives. The same recovery had been
written out three times, once each in `map.ts`, `filter.ts` and `flatmap.ts`, so
one failure report was three separate branches waiting to flap, and two of them
had never been covered on any run.
[The investigation record](../history/development/coverage-flake-list-resume-seed-2026-08-20.md)
follows the five lines from the group-level `+3` down to the single artifact
that covered them.

The fetch builtins' completion writeback is the same shape with nothing to
extract. `tryWriteResult()` already takes the runtime it commits through, and
so does `startFetch()`, so a test that hands either one a runtime whose commits
are refused reaches both the arm that carries the refusal back and the throw
that converts it. `packages/runner/test/fetch-writeback.test.ts` states the
function's three outcomes, because the two that do not write are distinct for
the caller — inputs that moved mean the request was superseded and is done,
while a refused commit means the claim is still pending and only this response
could have completed it — and then drives `fetchJson` end to end against a held
response with the writeback's commit refused.

Refusing ONE commit inside a real run takes a way to say which one, and
position is the wrong way to say it: what sits between the response and the
writeback is scheduling, which is the thing being taken out of the answer.
Name the transaction by what it writes instead. The completion writeback is the
transaction that carries the response into the builtin's result document, which
`getTransactionWriteAttempts()` reports at commit time; the error writeback that
follows it only clears a result that is already absent, which records no write
of that document at all. Asking for the one commit that writes it therefore
lands the refusal on the completion write and on nothing else, however the run
is scheduled. A case that wants both refused names a document both of them do
write — the claim they each release — rather than refusing every commit from
the response onward, which would count whatever else the scheduler opened in
the same window. Count the transactions the name matched, past the number
refused rather than capped at it, and state that count: a run that produced
another matching transaction then fails on the count instead of quietly leaving
it to commit.
[The investigation record](../history/development/coverage-flake-fetch-writeback-refusal-2026-08-24.md)
follows those five lines from the group-level `+5` down to the single artifact
that covered them, and to the sibling rethrow that no artifact in either run
covered.

### Branches reached only when a batch carries unrelated work

A fifth shape is the branch that handles what a failure did not touch: the
skip for the entry a bulk operation leaves alone, the arm that keeps the
survivors of a partial failure moving. Whether the branch runs is decided by
what else was in the batch when the failure landed, and that is assembled by
scheduling rather than named by any test.

The server executor's wave withdrawal is one of those. When a foreign space's
co-hosted engine cannot be resolved, `commitWave()` in
`packages/runner/src/executor/wave.ts` walks the wave's contributions and
withdraws the ones that sealed into that space — an event handler requeues, a
derivation drops — while everything else commits. Reaching the skip that lets
everything else through takes a wave holding both a contribution that crossed
into the failed space and one that did not. An end-to-end test can provoke the
first; the second is whatever the serving loop had sealed by then. The loop was
entered by exactly one artifact in each of two consecutive runs, and it saw two
contributions on one and one on the other.

Assemble the batch in the test rather than provoking one. `WaveAccumulator`
takes its space, lease and replica lookup as arguments and exposes
`failForeignSpace()` as a method, so a test seals the contributions it wants,
fails a space, and commits, with nothing else deciding what the wave holds. The
`an unresolvable foreign space withdraws exactly its own crossings` case in
`packages/runner/test/executor-wave.test.ts` puts one contribution of each kind
in the wave and asserts the disposition of each, so a version that withdrew the
bystander with the crossings fails rather than staying green on the line count.
State all the arms in the one case rather than only the arm that moved. The
derivation drop arm beside this flapping skip had never been covered on any
run, and it comes for free once the wave is built by hand — whereas a case
written for the skip alone leaves it exactly where it was, and a second case
added for it later would set up the same wave twice.
[The investigation record](../history/development/coverage-flake-foreign-space-withdrawal-2026-08-26.md)
follows the single line from the group-level `+1` down to the one artifact that
covered it, and to the two arms neither run reached.

### Branches reached only when the operating system got there first

A sixth shape is the arm that copes with something outside the process having
already gone: a signal sent to a child that has exited, a write to a pipe the
far end has closed. The operation around it runs on every teardown. Whether the
arm runs is decided by how the kernel's notification interleaved with the work
the code was doing, which no test orders and no assertion mentions.

Stopping a spawned child is the worked example. `Deno.ChildProcess` waits for
its child from the moment it is spawned, and `kill()` throws
`TypeError: Child process has already terminated` once that wait has resolved,
whether or not anyone read `status`. So the `catch` beside a `kill()` runs when
the child exited far enough ahead of the stop for the runtime to have reaped it,
and a driver that asks its child to exit and then stops it produces that
ordering on some runs and not on others.

The state is constructible in isolation — spawn a child, await its status, and
`kill()` throws every time — but not where the branch sits. A driver owns the
child it spawned and takes it down itself, so a test driving the driver has no
argument it can pass to ask for one order or the other. What it can construct is
the thing the branch responds to, which is what `kill()` does when it is called.
Give the signal a function of its own, taking only the part of the child it
touches — `Pick<Deno.ChildProcess, "kill">` is the whole of it — and both arms
are reached by passing an object whose `kill()` returns and one whose `kill()`
throws. Prefer such a stand-in to a real reaped child even though one can be
had, because it lets the case say which signal was sent, which a process that is
already gone cannot show, and because it spawns nothing.
`terminateChildProcess()` in
`packages/connectors/agents/connector/src/child-process.ts` is that function,
and the cases beside it in
`packages/connectors/agents/connector/test/child-process.test.ts` assert that
the running child was sent `SIGTERM` and that the reaped one was asked at all,
so a version that stopped sending it fails rather than staying green on the
line count.

Extracting it settled where the branch lives, as it did for the list
coordinators above. The same arm had been written out three times over, once at
each place in that package that takes down a child it spawned, so one branch was
three waiting to flap — and two of the three had never been covered on any run.
Extract the signal alone rather than the whole teardown: what those three shared
was the arm, and each of them waits for the process to go in a different way.
[The investigation record](../history/development/coverage-flake-child-already-exited-2026-09-11.md)
follows the single line from the group-level `+1` down to the one call in
twenty-seven that covered it.

Ask what stops the child before giving its signal a function of its own, since
a signal that is not needed goes rather than becoming testable. A child that
ends on a failed write to a pipe this process owns is stopped by closing that
pipe — which is a property of that child, held by the ones that write their
output and die on `SIGPIPE`, and not by one that ignores a failed write or has
handed the write end to a child of its own. `nearestOnBranch()` in
`tasks/coverage-gate.ts` reads `git rev-list` until the commit it was asked
about appears, and leaving the loop that reads it cancels the stream, so git
ends at its next write and `await child.status` reaps it. Its own
[investigation record](../history/development/coverage-flake-gate-git-walk-2026-09-17.md)
has the measurements, and the case that covers a walk stopping while git still
has output to write.

### A line two callbacks share

A seventh shape is not a branch only some runs take. Both arms run on every
run. What moves is whether one measurement ran both of them.

Two callbacks passed one after another to the same call share a line. An
uncalled function's range reaches past its own text, so the line where one
callback ends and the next begins is reported uncovered unless both callbacks
ran in the measurement being read.
[deno coverage: one-line guard reported uncovered when its branch is not taken](deno-coverage-guard-line-artifact.md)
holds the mechanics and a reproduction, under "A line two adjacent callbacks
share".

The gate merges the coverage artifacts a run uploads by adding each line's
counts together, so a line one shard reaches is covered however many shards
missed it. A shared line is not settled that way. It needs one artifact in
which both callbacks ran, and which test files an artifact holds is decided by
how the suite was split across shards. Nothing asserts that split, and it is
repacked whenever a test file is added or removed: the runner suite's shards
come from `tasks/select-runner-test-files.ts`, which packs the weighted list of
test files into bins, so one new file moves whatever lands after it.

Any two adjacent callback arguments sit in this position. The pair that
produced it here is a request's two endings — the work to start once the
request commits, and the ending for a request refused before it starts — which
is the shape of each `enqueuePostCommitLLMWork()` call in
`packages/runner/src/builtins/llm.ts` and of the served compile path in
`packages/runner/src/builtins/compile-and-run.ts`. Neither file is where the
shape comes from, so a search for it goes by the call sites rather than by what
they call.

Give the second callback a name of its own, declared above the call. Each
function's lines are then its own — covered wherever that function runs — and
no line needs two arms in one measurement. That is what `announce` and
`reportCreated` in `compileAndRun()` are, and what `settleRefused` is at three
of the `enqueuePostCommitLLMWork()` calls; where the callback only forwards
to a function already in hand, pass that function instead, as the direct
`generateObject` path passes `settleAbandoned`.

Driving both arms from one test file settles the count as well, since a file is
what the shard split moves. Prefer the name: nothing keeps two cases in one
file, and the next person to split an 800-line test suite has no way to know
that a count depends on it.
[The investigation record](../history/development/coverage-flake-shared-callback-line-2026-09-16.md)
follows three such lines down to the shards that held the arms apart.

### Checks the layer below already makes

Not every line that moves deserves a test. Sometimes a line decides nothing:
every observable consequence is the same whether it is there or not, because
the code it calls makes the same check on its own. Opening a remote memory
session had three abort checks, one before connecting, one after connecting,
and one after mounting. The memory client refuses an aborted signal on entry to
both the connect and the mount, raising the signal's own reason, which the
caller's own catch clause converts exactly as its own check would. Only the
third check decides anything: an abort landing after the mount resolves has
already shut the client, and without the check the method would hand that dead
client back.

A test cannot distinguish such a line, which is exactly what makes it a
problem: any test written for it passes with the line deleted, so it protects
nothing and satisfies the tool. Delete the line instead, and write the test
that states what the surviving code does at that point. That test is what makes
the deletion safe — the check now lives one layer down, and the test fails if
that layer stops making it.

Reachability is not the test here. Both removed checks were reached in CI, on
the runs where an abort happened to land in the microtask between one library
call returning and the next line running. What decides the question is whether
any input tells the two versions apart.

### A branch only some of the corpus reaches

`packages/ts-transformers` and `packages/schema-generator` move for a reason of
their own: their unit suites never reach parts of the analyzer and the
formatters. What reaches them is the pattern integration jobs, compiling
whatever the pattern corpus happens to contain, on whichever shard the pattern
landed on. So a branch for a language construct the corpus uses rarely — a
`Stream<T>` parameter, a numeric literal type node, the bare `object` type —
is covered when a shard happened to compile the one pattern that spells it,
and uncovered otherwise. The carrier artifact names a different shard from one
run to the next for the same line.

These take a unit test, not a pattern. Both packages have `*-flap-coverage`
test files that build the type or the source they need and call the analyzer or
the generator directly:
`packages/ts-transformers/test/policy/capability-analysis-flap-coverage.test.ts`
and `packages/schema-generator/test/schema-generator-flap-coverage.test.ts`.
Each case asserts what the branch produces — that a stream argument is
recorded opaque while a writable argument is recorded read and written, that a
numeric literal emits a number rather than the string the node carries — so a
branch that changed what it produced would fail rather than stay green on the
line count.

### A fact the checkout supplies

A line can also sit behind a fact the code reads from the machine it is
running on: the branch the checkout is on, the platform, whether some tool is
installed. `tasks/test-records.ts` stamps a local test run with the branch,
and records one only when git names one. Continuous integration builds a pull
request from a detached merge commit, where `git branch --show-current` prints
nothing, so the arm that records a branch ran on a developer's machine and not
in that job. Its coverage then came from whatever else in the run happened to
build a context, which is what made it move.

A test that creates a scratch repository on a named branch does reach the arm,
and asserting that git's answer reaches the context is worth doing. It does
not settle the coverage, though, because it buys the line with a subprocess:
the line is covered where git is installed, behaves as the test expects, and
is allowed to run, and not elsewhere.

Separate reading the facts from deciding what they mean.
`buildLocalContext()` asks git for the commit, the branch and the status, and
hands the three answers to `composeLocalContext()`, which turns them into the
context. Reaching the arm that records a branch is then a matter of saying
what git said, so a unit test states the facts and asserts the context they
compose into. `tasks/test-records-flap-coverage.test.ts` holds one case per
arm: a branch git named, the empty string a detached checkout produces, and
the absent answer a directory outside a repository produces. Nothing in that
file runs a subprocess or reads the surrounding checkout, so every arm runs on
every machine.

### What the check says when the regression is not the pull request's

The gate compares whole-group counts, so a flapping line fails whichever pull
request is measured against a run that happened to cover it, however unrelated
the diff. The check recognizes that case and says so: when a gated group is over
its baseline and none of the lines the pull request added are uncovered, it
reads the coverage reports of the `main` run its baseline came from and names
every line this run leaves uncovered that the baseline run covered.

The comment lists those lines file by file, gives the `ACCEPT_COVERAGE_DEBT`
line that lets the pull request through, and carries a prompt for a fresh agent
session to make the lines cover the same way every time. The author's pull
request is not the place to fix them, and it is not held up waiting for someone
to.

The prompt says where the measurement came from, so a session picking it up can
locate it instead of reconstructing it: the page of the workflow run that
measured the lines, the base-branch commit that run merged the pull request
into, and — for each affected group — the baseline run its count was held
against and the commit that run measured. The commit named for the measuring
run is the base-branch commit rather than the pull request head, because a
`pull_request` run measures `refs/pull/<number>/merge`, and because the
question the reader has is what has landed on `main` since. The prompt hands
them the command that answers it, `git log <base commit>.. -- <file>`, and
tells them to say so and stop if a line has since changed or been given a test.

Anything the run context does not name is left out rather than guessed at. A
run of the checker outside GitHub Actions names no run page and no commit, and
its prompt falls back to asking the reader to check what has landed since the
measurement was taken.

The identity travels on the rows the gate builds. Each row already records the
baseline it was held against; it also records the run that measured it and the
base-branch commit that run merged, both of which the check has in hand when it
scores the row. The comment reads them back out of the rows it is given.

Only files the pull request left alone are compared. A file it changed has
different content in the two checkouts, so the same line number means a
different line in each report and no comparison is possible. When the baseline
run's coverage artifacts cannot be read — expired, or the download failed — the
check falls back to the ordinary regression comment.

## Ratchet baselines and accepting debt

The ratchet applies per source group and only to the groups a PR changes: for
each such group the uncovered-line count must not rise above the count from the
`main` run for the base-branch commit the PR is merged with, or the nearest
ancestor of it that has one (see "Which `main` run the ratchet compares
against"). Debt in unchanged groups is still reported, but does not block the
PR.

Accept one group's increase with the narrow per-group marker in the PR
description, on a line of its own and flush against the left margin:

```text
ACCEPT_COVERAGE_DEBT: packages/runner +12 lines
```

The marker names the source group — `workspace`, a top-level directory such as
`tasks`, or a package as `packages/runner` — rather than the metric that group's
lines are counted in. Only `packages` splits into a second level, because that is
where the collection stops rolling a file up; `tasks/foo` names no group.

The same marker also accepts a rise in a measured set, and there it names a
workspace member, which can sit deeper than a source group:
`packages/connectors/github`. A name below `packages/` that is deeper than a
group is read by the coverage gate alone, and this ratchet measures nothing for
it and passes over it. The coverage gate fails on a name that is neither a
member nor a group, so a name nothing could ever consult still fails a
job — this one or that one. Which gate a marker is for follows from the
name; see [the test-selection contract](../specs/test-selection.md#coverage).

A name can have the shape of a group and still name none — a package that is not
there, or a misspelling of one that is. Nothing would ever consult such a line,
so rather than let it pass for an acceptance that had no effect, the check fails
the job and lists the groups the run did measure.

The number is how far above the baseline the group may rise, not the total it
may reach. The gate passes the group when its uncovered-line count is at most
the baseline plus that number, so a run whose baseline is 5746 accepts 5758 and
fails at 5759. A group with no baseline yet is held to zero, and the whole of
the accepted rise is available to it.

Stating the rise is what makes the marker survive a rebase. The baseline the
ratchet compares against is the `main` run for whatever base-branch commit the
pull request is merged with, so it moves whenever the pull request is rebased. A
total written for one baseline says something different against the next one:
too generous when the base branch covered lines in the meantime, and short by the
difference when it uncovered some, which fails the pull request for debt it did
not add. A rise says the same thing against every baseline, so the marker keeps
accepting exactly the debt its author accepted and no more.

The check prints the line to paste, with the rise it measured already filled in,
under `---BEGIN COPY-PASTE---` at the end of the Coverage Check job's log. A line
that starts with `ACCEPT_COVERAGE_DEBT:` and that the check cannot read fails the
job and says what form to write instead, rather than being passed over as though
it were not there.

An accepted group keeps its attribution. The gate keeps one comment on the pull
request and rewrites it in place as the answer changes, and the comment an
acceptance leaves behind names the files holding the lines it accepted, under
"Files with new uncovered lines" — the same heading and the same counts the
failing run wrote. So the pull request goes on saying which file the debt is in
after the acceptance stops anything from failing over it.

The left margin is what tells an acceptance from a mention of one. A description
can name the marker in a sentence, and can indent an example of it into a code
block, without either being read as accepting anything — or as a malformed
attempt at it. Indent the line to show the form, and write it flush to use it. A
pull request description often starts life as a commit message body, so a line
indented there arrives indented, and stays an example. The check names each
indented marker it passed over in its log, so an author who indented one meaning
it as an acceptance can see why the gate carried on without it.

Use the broad reset marker only to bootstrap coverage data for the first time,
or when the `main` baseline is known to be bogus and should be re-seeded for one
cycle:

```text
NEW_COVERAGE_BASELINE
```

When that PR merges, the main run's coverage metrics become the new ratchet
baseline for later PRs, and no run before it is one: the accepted level is what
later runs are held to, and nothing older can undo it. That floor applies to the
metrics the acceptance named, or to every coverage metric for the broad reset
marker. It reaches only the PRs whose base-branch commit already contains the
acceptance; a PR whose run started earlier is gated against the ancestry it does
contain, and picks the floor up when a later run of it merges the acceptance. The
check still requires the full expected coverage artifact set during that reset
cycle. Jobs with no reportable covered files upload an empty LCOV report, so a
missing artifact means the report upload itself failed.

Each run writes a per-run baseline artifact recording its coverage-debt metrics
and its compile cache states. It is named `perf-metrics` for historical reasons
— it once also carried CI timing metrics for the removed performance gate — and
keeps that name so the ratchet needs no migration; a run from before the gate
was removed reads as a valid baseline unchanged. The file records each metric's
uncovered-line count under a `durationSeconds` key, for the same reason the
artifact keeps its name.

That artifact is also where the repository's coverage debt over time is read
from. The dashboard's coverage debt tile
(`packages/dashboard/coverage-debt-history.ts`) reads the
`coverage-debt: workspace uncovered lines` record out of one `main` run a day,
shows the newest of those figures, and charts the run of them. It skips a run
any of whose compile cache states is cold, for the reason the ratchet does;
"Compile cache state and cold runs" below says what records those states. So the
metric name, the `durationSeconds` key and the `compileCacheStates` tag have a
reader outside the gate, and a change to any of them is a change to the tile.

A later PR run reads its ratchet baseline from the `perf-metrics` artifact of the
`main` run for the base-branch commit it merged, or of the nearest ancestor of
that commit which has one; there is no separate history store. It finds that run
in the CI workflow's run listing (see "How the ratchet finds that run"), keeping
the successful pushes to `main` and ordering them from the nearest ancestor of
that commit outwards — leaving out the runs for commits it does not contain —
and then reading one run at a time, stopping as soon as every metric has a
baseline. Usually the nearest run measured every metric, and that is the only
baseline artifact read; reading further back happens when a run uploaded
nothing, ran cold, or measured a metric no nearer run did. The walk reads twenty
runs at most, so a metric no `main` run has measured yet, such as a new
package's, costs a bounded number of reads. The runs the walk read are the ones
the "Baseline source runs" log group names.

The workflow downloads the current run's `coverage-profile-*` artifacts before
starting `tasks/coverage-check.ts`. `COVERAGE_ARTIFACTS_DIR` points the script at
one subdirectory per artifact. The download step checks the artifact digests. The
script separately checks the expected artifact names
(`EXPECTED_COVERAGE_ARTIFACT_NAMES`). It also rejects an artifact containing no
coverage files. A manual run without the environment variable uses the GitHub API
download path instead.

The names the script checks come from the run's artifact listing, which is read
through the GitHub API. When GitHub's rate limit refuses that listing, the
subdirectories of `COVERAGE_ARTIFACTS_DIR` name the artifacts instead, so the run
still measures its coverage; the files it measures are the downloaded ones
either way. The compile cache states are not among the downloads, so such a run
has none recorded, as when their artifacts are missing. A pull request's run
without the environment variable has nothing to fall back on, and fails as it
does for any other failure to read its own coverage, with the limit named in its
log.

### Measuring a before/after locally

The gate reports a group total rather than a per-line diff, so localizing a rise
means measuring the same group twice: once with the branch's tree, once with the
tree it will merge onto. Set `DENO_COVERAGE_DIR` for each run and convert with
`tasks/write-coverage-lcov.ts`, exactly as the CI jobs do, then compare the two
LCOV reports' zero-hit lines across the files the branch changed.

Take both measurements from the same base. Rebasing between them straddles two
trees and the delta stops meaning anything, so rebase first and measure after.

A local total will not match CI's. CI sums a group over every job that loads its
files and one local suite loads a subset, so the absolute numbers differ. The
offset is constant between two runs of the same suite, which is what leaves the
delta comparable when the totals are not.

The baseline half checks the merge base out over the packages being measured, so
for the length of that run the worktree holds the base's code rather than the
branch's. A tree sampled during it reads as though the branch had been reverted.
It has not been: the branch's work is in its commits, and anything uncommitted is
in the stash the measurement pushed. `git stash list` and
`git grep <symbol> <branch-sha> -- <paths>` settle that from outside the run,
without waiting for it to finish. Restore with `git checkout HEAD -- <paths>`
followed by `git stash pop`.

## Compile cache state and cold runs

The pattern test jobs restore a compile byte cache keyed on a fingerprint hash
over the compiler packages. A PR that changes that fingerprint runs cold: every
pattern compiles from scratch. A cold run covers compile branches that only
execute on a cold cache, which lowers its coverage debt, so ratcheting a warm PR
against a cold `main` run would fail it with phantom uncovered lines.

The pattern-integration process owns one shared cache in
`packages/patterns/integration/pieces-controller.ts`. Its controller helper and
the capability-gate controller both inject that cache into every runtime they
create. A custom runtime in this suite must do the same. Setting
`CF_COMPILE_CACHE_FILE` only tells the test-support cache where to persist its
bytes; a runtime uses those bytes only when it receives the cache through its
`moduleByteCache` option.

To tell cold from warm, each pattern job uploads a small `cache-state-*`
artifact recording its cache restore result. The coverage check aggregates those
into `compileCacheStates` in `perf-metrics.json`. A job family is cold when
any of its shards had a full cache miss, detected as the cache file being absent
after the restore step (the combined `actions/cache` action does not expose the
matched key). A partial hit through a restore key counts as warm: both key forms
start with the fingerprint hash, so any restore means the compiled bytes are
current. The ratchet skips a cold sample when choosing among the
base-branch commit and its ancestors, so a cold `main` run cannot lower the
baseline that warm PRs are held to.

Every run stamps its own `perf-metrics.json`, so a baseline run's coldness is
read straight off the artifact that run published. Before writing the stamp, a
run fills in any family whose cache-state artifact did not arrive, using the
compile fingerprint: `tasks/compile-cache-state.ts` mirrors the `cc-*` key globs
(drift-guarded by a test that parses the workflow) and compares the run's commit
against the commit whose cache it would have restored — the pull request's own
changed files, or the previous `main` run for a push. A family with no recorded
state is filled cold when those paths changed. Recorded states are ground truth
and always win. A run a rate limit ends early writes the same stamped artifact
before it stops, so it still tells later runs whether it was cold.

Neither source is complete. Fingerprint inference cannot see non-fingerprint
cold causes (cache eviction, cache-service outages), and a run whose cache-state
artifacts and fingerprint comparison both failed publishes no stamp at all. A
run with no recorded state is treated as not-cold and may still be used as a
baseline.

A CI lane records the state of the compile byte cache it restores
(`COMPILE_CACHE_FILE` in `tasks/ci-capabilities.ts`) itself. A lane whose
batches open that cache checks whether the file exists before its first batch
runs, because the first pattern a batch compiles writes the file whatever the
cache held. It writes `cold` or `warm` to `compile-cache-state.txt` at the top
of the directory its coverage artifact holds. A file that exists reads as warm,
which is sound only while the workflow keys the lanes' cache, and every restore
key for it, on the compiler fingerprint, as it keys the jobs' caches: a file
restored from a run of another compiler holds no bytes this one can use, and
would read as warm all the same. `tasks/coverage-report.ts` reads
every such record and publishes the run's state under the `compile-cache` key of
`compileCacheStates`: cold when any record says `cold` or says something it
does not recognize, warm when every record says `warm`, and absent when no lane
opened the cache. The dashboard's repository-wide trend leaves a cold run out,
so a fingerprint change does not show as a drop in debt that the next warm run
takes back.

## Which `main` run the ratchet compares against

A `pull_request` run checks out `refs/pull/<number>/merge`, whose first parent
is the base-branch commit and whose second parent is the pull request head.
GitHub rebuilds that merge ref whenever the base branch moves, so the run
measures the pull request merged with `main` as it stood when the run started.

The baseline is the `main` run for that commit, or for the nearest ancestor of
it that has one. Comparing against the commit itself is exact: both numbers
count the same base-branch code, so the only difference between them is the
pull request. Runs that are not ancestors are never used, in either direction —
one that landed after the run started measured code the run does not contain.

The base commit's own run is usually available, but not always: it may still be
going, or it may have failed. Rather than skip the gate, the ratchet steps back
to the nearest ancestor that has a usable run. Whatever the base branch changed
in between is then present in this run and absent from the baseline, so the
groups it touched have totals that count different code on the two sides. Those
groups are reported and not gated; every other group still is, which is the
point of stepping back rather than giving up. A gap of one or two commits
usually touches one or two groups.

One case this does not reach: a base-branch commit that changes a test in one
package can move the coverage of source in another, and no diff of that source
names it. It ends when a `main` run measures the base commit.

Two details of reading the base commit are load-bearing. It comes from the
checked-out merge commit rather than the triggering event, because GitHub does
not rewrite `pull_request.base.sha` when it rebuilds the merge ref. And it is
read with `git cat-file commit HEAD` rather than `git log --format=%P`, because
`actions/checkout` clones to depth one and git reports a shallow boundary commit
as having no parents.

### How the ratchet finds that run

The `main` run for a commit is found in the CI workflow's run listing, which
GitHub returns newest first, a hundred runs to a page. The check asks for that
listing with no filter and keeps the successful pushes to `main` itself. GitHub
serves a listing filtered by branch, status or event from a search index
instead, and that index can return a window of runs that ended weeks earlier,
with a success status and nothing in the response to say so. A baseline that
exists then reads as one that does not.
[The investigation record](../history/development/coverage-ratchet-stale-run-listing-2026-09-17.md)
has the instances.

The check does not take a listing's word for being current either. The run
doing the asking was created before the listing was read, so a current listing
shows it, ahead of every run created before it. Run ids grow with creation, so
"created before" is a comparison of ids and needs no clock. A listing that shows
a page of older runs and then a page that still lacks this run, or that ends
without it, is not current. One page of grace covers two runs created together
whose order puts a page boundary between them.

A listing that is not current is read again, twice more at most. If it still
leaves the run out, a pull request's job fails, and says why in its log, in an
error annotation, in the job summary and in the pull request's coverage comment.
It fails rather than passes because no baseline found through that listing can
be trusted, and because the remedy is cheap: re-running the Coverage Check job
reads the listing again, and the job takes about a minute. Nothing in that
failure says the pull request regressed coverage. A run the gate compares
nothing for passes with the warning instead: a `main` run, a pull request that
changed no source group, and one whose description carries
`NEW_COVERAGE_BASELINE`. Such a pull request still gets its coverage comment
resolved, so a failure an earlier run reported does not stay open on it.

The listing is read only as far back as the walk needs. The first reading goes
back to the run asking, which is on the first page for a run whose tests have
just finished. When the runs on those pages leave a metric without a baseline,
the walk asks for the next older page, up to ten pages in all. That happens
when a job is re-run days after its run was created: the commit it merges is
as old as the run, and the newest pages hold only runs for commits that landed
since. Ten pages reach back about three days. A run created longer ago than that
is out of reach, together with the `main` runs for the commit it merges, and its
changed groups are reported as not gated.

The nearest ancestor is still the nearest one when the runs span pages. A page
further back holds runs created earlier, and those are usually the ones for
commits further from the base-branch commit, but two pushes that land together
can have their runs created in the other order, with a page boundary between
them. So before the walk reads the run for an ancestor, every commit nearer the
base-branch commit has to be accounted for. A commit is accounted for once the
listing has shown its push run, whatever that run's conclusion: a run still
going and one that failed are runs the ratchet cannot use, and having seen one
says there is nothing further back to find. Until then the walk reads another
page, and it takes the ancestor it has when there are no more.

Nothing but a shown run accounts for a commit. Its date does not: a commit's
date is whatever the client that made it said it was, so it puts no bound on
when the commit's run was created. Every commit on `main` normally has a run, so
the search costs a page only in the case it exists for. A commit with no run at
all, such as one pushed together with its descendants, costs the rest of the
page budget on the runs that have to look past it.

### When a changed group is not gated

A pull request is not failed for a baseline that does not exist. That leaves a
job that compared nothing looking exactly like one that found nothing, so the
check says which it was. When the gate applied to a group — the pull request
changed it, and the description accepted nothing for it — and held it against no
baseline, the run reports it in four places:

- The job's log, under `!!! COVERAGE WAS NOT GATED for …`, and in its last line,
  which claims the ratchet only for the groups it compared.
- A warning annotation on the run, which the pull request's checks show.
- The job summary.
- The pull request's coverage comment, headed "Test coverage was NOT gated on
  this run". It is posted even on a pull request that had no coverage comment,
  and the next run that gates every changed group rewrites it into the
  collapsed summary.

Each names the groups, and for each group one of four reasons:

- No successful `main` run within reach measured the base-branch commit or an
  ancestor of it.
- The base branch changed the group between the nearest measured ancestor and
  the base-branch commit, so the two totals count different code.
- The base-branch commit could not be read from the checkout.
- GitHub's API rate limit stopped the run reading the baseline data at all, so
  no group was compared. A limit is read off the response — the status together
  with the rate-limit headers — rather than off the wording of a refusal, whose
  body the client cancels unread. The reads that treat an ordinary failure as
  absent data, a run's artifact listing and the lookup of the pull request that
  merged its commit among them, let a limit through instead: reported as absent
  data it would become a claim that no `main` run has measured the group.

For the first three, a later run of the pull request gates those groups, once a
`main` run has measured the commit it merges. Re-running the Coverage Check job
is enough when that `main` run has finished since; updating the branch gives the
next run a newer commit to merge.

A run a rate limit stopped passes, and re-running the Coverage Check job once
the limit has reset is the whole remedy. It passes rather than fails because the
limit bounds what this repository may ask of GitHub in an hour: it is a property
of the moment rather than of the pull request, and a re-run started straight
away meets it again, so failing would hold the pull request on a condition its
author has no way to clear. That is the one thing separating it from a run
listing that is not current, whose remedy is a re-run that costs about a minute.
What makes the pass safe to keep is that it is no longer a quiet one — the run
reports through the same four places above, so a pull request that was never
gated does not read as one that was.

A limit reached before the comparison, on the listing of the run's own
artifacts, does not stop the run measuring what it downloaded (see "Ratchet
baselines and accepting debt"). The comparison then reads the API again, and a
limit still in force there ends the run as above, naming the groups it measured.

The table header in the job's log is the quick check. `excl` beside a group the
pull request changed means that group was not compared, and a header reading
`OK: 0` with every group `excl` means nothing was. `ovrd` is what says an
`ACCEPT_COVERAGE_DEBT` line took effect. A group with no baseline is held to
zero, so an accepted rise covers it only when the group's whole count is that
small; a group carrying any real debt reads `excl` beside its acceptance, and
the line has accepted nothing on that run.

## A combined report for IDEs

The same `coverage-profile-*` artifacts feed a second consumer. On `main`, the
`attest-binaries` job downloads all of them, runs
`tasks/combine-coverage-lcov.ts` to merge them into one LCOV file, and uploads
that file to the build-artifacts bucket next to the release tarball. The point
is to give someone working in an IDE a single file that shows coverage for the
whole repository, instead of one fragment per CI job.

Two things happen during the merge. The source paths in each fragment are
absolute paths rooted at whichever runner produced them, so they are rewritten
to repository-relative paths that an IDE can map onto a local checkout. Records
for the same source file are then combined into one, with the per-line hit
counts added together, so a file exercised by several jobs is reported once with
its combined coverage.

The merged file carries line coverage only. LCOV identifies a function by its
name, and `deno coverage --lcov` can emit several functions with the same name
in one file (a free function and a method, for example), so function and branch
records cannot be merged back together reliably from the fragments alone. Line
coverage is what an IDE uses to color the gutter, which is what this file is
for.

To download the report for a given commit:

```
gsutil cp gs://commontools-build-artifacts/workspace-artifacts/labs-<commit-sha>.lcov .
```

## Which job collects which coverage

| Job | Runtime (V8) coverage | Authored-pattern coverage |
| --- | --- | --- |
| `pattern-unit-test` | yes | yes (`cf test` with `CF_PATTERN_COVERAGE_DIR`) |
| `pattern-integration-test` | yes | yes (browser worker collector) |
| `pattern-reload-integration-test` | yes | yes (browser worker collector) |

The pattern unit job runs each `packages/patterns/**/*.test.tsx` file through
`cf test` in-process. The two integration jobs run browser-driven `deno test`
files against a running Toolshed server. Both kinds of authored-pattern coverage
feed the same gated metric.

The pattern integration job runs in two server-execution arms, and only the
arm with the flag off collects authored-pattern coverage. The instrumentation
records what the browser's runtime worker compiles, which is the whole of what
ran only where that worker is the sole compiler; the arm with server execution
on has a second compiler on the server. The arm with it off measures the same
pattern files, so nothing goes unmeasured.

The compile byte cache is available to `cf test` through
`CF_COMPILE_CACHE_FILE`. Coverage and non-coverage compiles use different cache
keys. Coverage cache entries also carry the spans registered during the
transform, so a restored coverage compile can rebuild the current collector
before the cached module bytes run. The `pattern-unit-test` job wires both
`CF_PATTERN_COVERAGE_DIR` and `CF_COMPILE_CACHE_FILE`, which lets CI reuse
coverage-transformed module bytes between runs without mixing them with ordinary
compiled bytes.

With that file set, the pattern-test orchestrator in `tasks/integration.ts`
fills it before any test runs. It sorts the shard's files by path, cuts them
into runs of neighbors of about a fifth of the shard each, never across a
program root, and hands each run to a `cf test --compile-only` process, five
at a time; each compiles its files' programs and runs nothing. Files that sit
together share most of their modules, so each run compiles those once, and the
test processes that follow, five at a time, all start from a full cache. A
`cf test` process seeds from the file only as it starts, so without that pass
the processes started together on a cold cache each compile the modules they
share. The compile-only process writes no coverage, since nothing ran.

The persistent cell cache stores each module's span list as one JSON string.
This keeps reporting metadata in one value instead of expanding every span
object into its own derived storage records. Coverage caches use the
`pattern-coverage` variant. The cell-cache reader accepts only the JSON string
representation. A covered closure without valid JSON spans is treated as a
cache miss, recompiled from source, and written back in the scalar format.

The runner remembers persisted closures for the lifetime of the runner session.
Each entry is identified by its space, cache variant, entry identity, and
complete module identity set. It skips another persistence operation for the
same closure. Concurrent requests for the same closure share one persistence
operation.

## How the integration jobs collect authored-pattern coverage

For these jobs coverage is a runtime-level capability rather than a `cf test`
one, so the worker never reads `CF_PATTERN_COVERAGE_DIR`. In an integration test
the pattern's event handlers run in the browser's runtime Web Worker, and that
worker is constructed with `RuntimeOptions.patternCoverage` on — a
`patternCoverage` flag on the worker's `InitializationData`, which the
integration harness sets when `CF_PATTERN_COVERAGE_DIR` is present. Every compile
the worker performs is then instrumented, including the piece-load path through
the content-addressed cell cache, whose instrumented variant is keyed apart from
the ordinary one so the worker never runs uninstrumented bytes.

Keying the variants apart means a piece an ordinary realm authored has no
instrumented closure to warm-load. That resume falls back to cold recovery — a
recompile from the stored source closure, which the runtime instruments like any
other compile — so the resumed piece reports coverage for the handlers it runs
rather than reporting nothing. The recovery writes its instrumented bodies back
under the coverage variant, so later coverage-on sessions warm-load them instead
of recompiling.

The cache-key split has a consequence for the test process too. In a
browser-driven test that process runs a pieces controller
(`initializePiecesController`) that creates the space's pieces. When the run
collects coverage, the controller has to collect it too — and this matters beyond
its own coverage.

Here is why. A coverage-on browser reads the instrumented cache variant. An
uninstrumented controller writes the ordinary one. So if the controller does not
instrument, every browser misses what the controller wrote and compiles each
pattern from scratch for itself. That includes the space-root default pattern,
which `ensureDefaultPattern` exists to compile exactly once. Each of those
compiles is synchronous, so it wedges the worker's event loop and stalls
unrelated IPC — the "second-boot slow window" the lunch-poll vote test describes.
With the controller uninstrumented, that test ran for 16 minutes and never
rendered its UI. Once it instruments, the test passes in 7 seconds.

A new browser-driven suite that creates its pieces some other way should expect
the same trap.

Getting the hits back out crosses two boundaries: the worker's and the browser's.
`PatternCoverageCollector.toData()` and `ingest()` give the spans and hit counts a
plain-JSON form. The worker exposes them over the RuntimeClient IPC
(`GetPatternCoverage`), and the harness pulls them with `page.evaluate` — one
batched dump per runtime, not a per-hit round trip. Every realm runs the same
instrumented bytes, so the fileName-plus-span-id keys line up: a realm that only
warm-loaded already-instrumented bytes reports hits that merge cleanly against
the realm that compiled them and holds the spans. The harness merges the realms'
hits and writes a `*.pattern-coverage.lcov` tagged
`TN:pattern-runtime-integration`, which the job uploads in its
`coverage-profile-*` artifact.

### One report per test file, not one per shard

`deno test` runs each test file in its own isolate. A shard's files therefore
hold separate instances of the harness module, each with its own collector and
its own space, and each writes its own `*.pattern-coverage.lcov` under
`CF_PATTERN_COVERAGE_DIR`. The gate copies and joins every `.lcov` in an
artifact, so a shard's coverage arriving in several files reads the same as one,
and a report is named apart from every other in the run for that reason.

The isolation runs the other way as well. A test file that runs its patterns
only through a pieces controller in the test process, with no page to dump from,
never reaches the write and contributes nothing — `all.test.ts` is the case in
the tree.

### The dump has to happen before the runtime is dropped

A worker's collector lives and dies with the runtime that built it. A shell
builds a new runtime whenever the page navigates and whenever its identity is
set — `shouldRecreateRuntime` compares the `Identity` object, and the integration
harness mints a fresh one from what crosses the page boundary — so one suite runs
through several runtimes, and every hit a dropped runtime holds is gone. A suite
that drives one page through two logins has two runtimes and two dumps to take:
one before the second navigation, and one before the harness disposes what that
navigation left. The pull happens in three places — before a login, before the
harness disposes a runtime, and on the page itself
(`Page.addBeforeUnloadHook`), which is what covers a reload and a page close as
well as a `goto`.

Taking only the last runtime's dump is what makes a line's coverage turn on the
environment, which the section above rules out. The lines at risk are the ones a
flow reaches late — a derived expression that runs when the view renders it, a
handler body that runs when the user gets that far. Whether the runtime holding
those hits is the one still standing at teardown depends on how the run was
timed and which shard the file landed in, and a line that drops out that way is
charged to whichever pull request happened to reshuffle the shards.

A dump that comes back empty-handed is reported, with one exception: a page that
never booted a runtime holds nothing, and is normal. A page that cannot be
reached at all, a runtime that does not answer the request, and a worker built
with no collector each name what was lost on the job's log. Coming back with
hits and no spans is not one of those — that is exactly what a realm that
warm-loaded somebody else's instrumented bytes reports, and those hits key
against the spans the compiling realm registered.

Integration coverage counts toward the gated `coverage-debt: packages/patterns`
metric exactly like unit coverage, which means a broad end-to-end flow that runs a
line without asserting on it lowers the debt. That trade is deliberate. Crediting
integration coverage only in a separate, never-gated number would score whatever
an end-to-end flow reaches — a piece assembled across several patterns, a path
through the shell no unit test drives — as uncovered however well it is
exercised. Coverage does not measure verification either way (see the properties
under "Authored pattern code is measured by transformer instrumentation"), so a
unit test that asserts on what it ran remains the better test; the gate just does
not treat what an integration test covers as worthless.

A span's file name is whatever the realm that compiled it called the module, and
that arrives in two shapes. A pattern the controller resolved off disk is named
relative to the patterns root (`/lunch-poll/main.tsx`), because that is the root
the resolver was given. A pattern the worker fetched over HTTP is named by its URL
pathname (`/api/patterns/system/default-app.tsx`), because Toolshed's pattern
identity is computed over pathname-prefixed names. Stripping the route prefix maps
the second shape onto the first, and both then resolve against the patterns root.

That rename runs when the report is written rather than as each realm reports,
because the realms do not all arrive the same way: the browser dumps are ingested,
but a runtime this process runs registers its spans into the shared collector
directly, as it compiles. Renaming on the way in silently covers only the first
kind. A record naming a file that is not in the checkout is the failure mode to
watch for — the gate matches records against the files it walked, so such a record
matches nothing and drops its coverage without complaining, which looks exactly
like a pattern nobody tested. Writing one warns.

## Known limitations and possible future work

- Only the browser-driven suites contribute. A pattern exercised solely through
  the headless multi-runtime harness (`multi-runtime-harness.ts`), whose sessions
  are Deno workers rather than pages, has nowhere for the teardown dump to run and
  contributes nothing. Those sessions could write their own LCOV directly — they
  are Deno realms with a filesystem — which is the natural way to extend this.

- Integration coverage is not a reason to skip a unit test. A unit test can cover
  a handler body too (see the handler bullet above) and can assert on what the
  handler did, which coverage never checks. Integration coverage only removes the
  case where a line no unit test happens to drive would otherwise read as
  untested.

## Related documentation

- [TESTING.md](TESTING.md) — how to run the test suites whose execution this
  coverage is measured from.
- [CI_PERFORMANCE.md](CI_PERFORMANCE.md) — CI wall-time optimization policy.
- [One-line guard coverage artifact](deno-coverage-guard-line-artifact.md) —
  why V8 can report a one-line conditional guard as uncovered when its branch
  is not taken.
- [../common/workflows/pattern-testing.md](../common/workflows/pattern-testing.md)
  — writing the pattern unit tests that the `pattern-unit-test` job runs through
  `cf test`, the source of the gated authored-pattern coverage.
