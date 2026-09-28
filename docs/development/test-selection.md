# Test selection

How to use the machinery that decides what a change's tests are worth
running, and how to answer the question it provokes most often, which is
"why did my test not run?". [The spec](../specs/test-selection.md) is the
normative description of the contract;
[the plan](../plans/pull-request-test-selection.md) carries the reasoning
and the parts still to be built.

Five things read a published manifest: the lanes that run every test in
continuous integration, the coverage gate, the comment a run on the default
branch leaves, the dashboard, and the read-only commands in [The
modes](#the-modes). [How continuous integration runs the
lanes](#how-continuous-integration-runs-the-lanes) says which lanes a run takes.

Every local query about test selection goes through one entry point:

```
deno task test-selection <mode>
```

Every mode that reads a manifest reads the one the lanes testing the
checked-out commit read: the newest the store had created at or before
that commit's committer date, resolved by the same code a lane resolves it
with. [The spec](../specs/test-selection.md#determinism) says why a lane
resolves at that moment. On a commit made before the newest manifest was
published, a mode therefore describes what lanes testing that commit would
read, not what the newest manifest says.

A pull request's lanes test the merge commit the continuous-integration
provider makes, which is dated when that commit was made rather than when
the branch's own last commit was. Checking out that merge commit is how to
ask about them exactly.

`--at <moment>`, in ISO 8601, reads the manifest that was current at that
moment instead, which is how to ask about a manifest published after the
checked-out commit was made. Where the commit's date cannot be read and no
moment is named, the mode stops and says so, because the manifest the lanes
testing that commit would read is then unknown.

## The modes

### `explain <identity>`

What one test is worth, and what selection would do with it. The argument
is the canonical identity key, three parts or four when the test ran in a
non-default configuration:

```
deno task test-selection explain '["unit","memory","space > writes a fact"]'
deno task test-selection explain '["integration","patterns","counter.test.ts","server-execution"]'
```

It prints the suite and the invocation unit the identity belongs to, its
score and its cost, the catches behind that score and how many distinct
sources they came from, when the most recent one was, its churn and flake
rate, whether the manifest withholds it, how many times it would run, and
whether a lane testing this commit reaches it when the change touches
nothing, which is the plan `plan --dry-run` prints. An identity the store
has never seen is reported as mandatory, which is what an identity with no
history is.

Each of those is printed on its own, because they are not alternatives: a
withheld identity a change reaches runs anyway, so an answer that picked
one of them would be leaving out something true.

The identity resolves through `tasks/test-identity-aliases/` first,
so asking about a renamed test under either name finds the joined history.

### `dials`

Every number selection can be tuned by, with the unit its value counts,
where the value comes from, and which way you would move it.
[Every dial](#every-dial) lists them.

### `coverage`

Every measured set — one suite's units over one workspace member's lines —
with how many units it holds and the baseline this commit's manifest holds
for it, and then every workspace member that carries no set, with the
reason. That baseline is the one the coverage gate compares this commit
against, since the gate resolves its manifest at the commit's moment too.
This is what answers "why is my package not gated?" and "what am I being
compared against?".

A member with two measured sets has two lines and two baselines. The
counts are never added together: a line one suite's tests cover says
nothing about whether another suite's do.

Where it resolves a manifest, it then prints what the measured sets cost with
coverage on. These are the lines [the publisher's
summary](#what-measured-sets-cost-with-coverage-on) carries, without the
`test selection: ` prefix the publisher puts on each one.

### `plan --dry-run [--lane N]`

What would run, and what it would cost: how many identities this tree
holds, how many are withheld, and per lane the number of tests, the
projected seconds against the budget, the capabilities it would open, and
a count by why each test was chosen. Given a lane number it answers "what
would lane three do?", and given none it prints all of them.

The plan is the one a lane computes, taken from the lane's own code rather
than worked out again here, so the two cannot disagree. It is the plan for
a change that touches nothing. A change's lanes also run every unit the
change touches, and the lane script's own dry run is the one that includes
those:

```
deno run -A tasks/ci-lane.ts --lane 3 --dry-run --base <ref>
```

The count is of this tree rather than of the manifest, because those are
different numbers and the plan beneath it is over the first. A manifest is
hours old, so it names units the tree has since dropped and misses units
the tree has since gained; the reconciliation of the two is what gets
packed, and it is what is counted here.

It also names any suite a lane cannot fill around: one whose overhead,
per-unit charge and capability setup together pass a lane's budget before
it runs anything. Such a suite takes a whole lane for each identity it
can still place, and one where no lane can hold any of them places none
at all. That line is what answers "why is a lane holding one test?" and
"why did none of this suite run?".

A suite that holds nothing has its identities left out of the list
beneath it, since the suite's line says what naming each of them would.
A suite that holds some of them keeps the rest in that list, because what
puts one of those past the bound is its own time on top of the charge and
the charge alone does not say which. The count beside the suite is of
what it can still run, so the two never disagree about the same test.

`--verify` compares the units the topology enumerates against the
identities this commit's manifest holds, in both directions. A unit the
manifest holds nothing for is one every lane runs as unknown, and
`--verify` fails on any. A manifest entry naming a unit the tree no longer
enumerates is reported without failing, because a manifest is hours old
and a unit deleted since it was published is expected to linger in it. A
unit the configuration declares unavailable is passed over, since nothing
runs it.

### How many lanes the run on the default branch uses

A change's tests are packed into a fixed number of lanes, `LANES`. The run
on the default branch cannot be, because how much work there is decides
how many lanes it needs and the job matrix has to exist before anything
starts. So one job asks:

```
deno run -A tasks/ci-lane.ts --full --lane-count
```

and it answers with an integer and nothing else on its standard output.
On its error stream and in the job summary it also gives what each lane of
that count is projected to take, both its work and the whole job with the
prologue. It packs those lanes the way the lanes will pack themselves, so
the table is what each lane projects for itself. The lanes then read the
same tree against the same manifest and work out their own shares, the
way a change's lanes do. What travels through job outputs is only the
lane count and the `--full` that tells each lane to run everything, never
which lane runs which test.

Run it yourself to see how many jobs the default branch would take. Where
nothing in the tree has a measured cost it answers from the shape of the
tree instead — the larger of the number of suites with anything to run
and what packing the stand-ins asks for — and says on the error stream
that it did so, since a projection from costs nobody has measured would
be arithmetic over an invented figure.

Whichever way it gets its answer, it answers no more than
`FULL_LANES_MAX`, so that one push's full run leaves runners for the
changes waiting behind it. A run that needs more takes that many and says
so on the error stream. Every test still runs when that happens. A test
whose repeated runs fit in no lane runs fewer times, down to once, and a
test that fits nowhere even once goes into the lane it leaves shortest,
so the lanes run past their budget instead.

## How continuous integration runs the lanes

`.github/workflows/deno.yml` runs every test through `tasks/ci-lane.ts` and
names no suite. Adding a test, a kind of test, or a configuration of existing
tests is a change to the topology, `tasks/test-topology.ts`, and never to the
workflow. A run's lanes come from two jobs.

- **`plan-full`** runs on a push to the default branch, on a run
  `.github/workflows/test-order-tomorrow.yml` calls, and on a pull request
  labelled `ci: full`. It runs `tasks/ci-lane.ts --full --lane-count`. It
  writes the count as its `of` output, the list of lane numbers from one to
  that count as its `lanes` output, and `--full` as its `args` output. On any
  other pull request it is skipped at once.
- **`tests`** runs every lane, once `plan-full` has succeeded or been skipped.
  It takes its matrix from `lanes`, or `[1, 2, 3, 4, 5]` where `plan-full` was
  skipped. Each of its jobs is named `Tests (N/M)`, where `M` is `of`, or 5
  where `plan-full` was skipped. Each runs `deno run -A tasks/ci-lane.ts --lane
  N --of M` with `plan-full`'s `args`, or with `--base origin/<base>` where
  `plan-full` was skipped. A lane packs the same plan from the manifest and the
  tree as every other lane of its run, and runs its own share of it.
- Each job of `tests` plans before it runs. Its `🗺️ Plan the lane` step runs
  the lane with `--dry-run`, which prints the lane's share, what it is
  projected to take, and what was withheld, in a step of their own. GitHub
  folds away the top of a step thousands of lines long, which is what the
  lane's own step becomes, so a plan printed there is hidden from anyone
  watching the job. `🧪 Run the lane` then runs the lane with `--described`.
  That packs the same plan again, since the tree and the manifest have not
  changed, and names it in one line: its batches, what it is projected to
  take, and the manifest it was packed against.

So a pull request's five lanes start without waiting, and a run of every test
waits for the count. Whether a run runs every test is decided in one place,
`plan-full`'s condition.

The label is `ci: full`, the value of `FULL_RUN_LABEL` in
`tasks/test-selection/policy.ts`, and `tasks/ci-workflow.test.ts` holds
`deno.yml` to it. The label is how a pull request runs everything: `plan-full`
runs, and the lanes run every test. The workflow runs when a label is added to
or removed from a pull request, so adding or removing `ci: full` starts a run
that reads the labels the pull request then carries. Any other label starts one
too. A re-run reads the labels of the event it repeats, so it does not see a
label changed since.

Each lane checks out the whole history, installs Deno and the dependencies,
restores its caches, runs the lane, and then uploads what it produced. Each of
the two Toolshed binaries a lane can build, `toolshed-baked-default` and
`toolshed-baked-opposite`, is cached under `.ci-cache/binaries/<name>` with an
exact key, `lane-binary-<name>-<binary cache key>`, and no restore prefix, since
a lane uses a binary it finds without asking what it was built from. The pattern
compile byte cache is under `.ci-cache/compile`, keyed
`cc-lane-<fingerprint>-tests-<lane>-<hash of the pattern sources>` and restored
from the prefix `cc-lane-<fingerprint>-`, so a lane can start from the cache
another lane or an earlier commit left and saves a fresher one.

A lane uploads three artifacts. `lane-failure-tests-<lane>-a<attempt>`, where
the lane failed, holds the working directory it kept and the core of any process
in the lane that crashed natively: the lane step runs with `ulimit -c unlimited`
and puts cores under `$RUNNER_TEMP/ci-lane-cores`. `lane-coverage-tests-<lane>`
holds `coverage/` without its raw profiles: each report at
`lcov/sets/<suite>/<member>/coverage.lcov`, where a `/` in the member's path is
written `__`, the file saying whether the compile cache was restored, and the
markers beside the reports of measured sets the lane saw fail. In the full run
it also holds the authored-pattern reports under
`lcov/pattern-runtime/<suite>`.
`test-records-tests-<lane>-a<attempt>` holds its test records.

The lane step is bounded at 30 minutes and its job at 40, the workflow's
ordinary bounds. Those only stop a lane that hangs. The budget a lane packs
against is derived from `LANE_BOUND_SECONDS` for a pull request and
`FULL_LANE_BOUND_SECONDS` for the full run. Neither is a bound a lane is stopped
at. A lane whose mandatory work passes its budget runs long rather than being
stopped with its later batches unrun, and its job log says how far its plan was
projected past the budget.

**`Status`** is the job a pull request requires. It runs on a pull request and
on a push once `plan-full` and `tests` have finished, whether they passed or
failed, and not in a run that was cancelled. It reads what every lane uploaded:

1. It holds the run's records to the topology: `deno task check-test-topology
   --commit "$GITHUB_SHA" --records test-records-artifacts`, which fails a
   recorded test that no suite of the topology claims.
2. On a pull request, it reads the pull request's description as it stands,
   through the API, runs [the coverage gate](#the-coverage-gate) over every
   lane's coverage reports, and uploads the comment the gate wants posted as the
   `coverage-comment` artifact. Where `tests` did not succeed, it passes the
   gate `--tests-failed`, and the gate reports rather than gates.
3. On a push, it measures the run's coverage with `tasks/coverage-report.ts`,
   and ships the measurements to the record store.
4. It fails unless every job it waited for succeeded or was skipped, and
   `tests` succeeded. A run whose lanes were skipped would otherwise pass having
   run no test.

A run the next day's test-order workflow calls runs no `Status`, since the
commit's own run already covers it.

On a push, the jobs that build the `toolshed` and `cf` binaries run beside the
lanes. `attest-binaries` waits for both builds and for `tests`,
`deploy-shell-staging` waits for `tests`, and `deploy-rapids` waits for
`attest-binaries`, so nothing is attested or deployed until every test has
passed. A pull request builds nothing there: the `binaries` suites compile each
binary as a test that it still compiles. The servers the full run's lanes start
are built by the lanes, from the same sources and the same build task, without
the commit and the shell endpoints the release binaries carry; the jobs that
build the release binaries check what those add.

## The coverage gate

A **measured set** is one suite's units over one workspace member's lines.
`deno task test-selection coverage` lists them.

A change that touches a member's tree reaches its set, and reaching a set
makes every one of its units run, with coverage turned on. How often each
of them runs is unchanged: a unit its flake rate says to repeat is still
repeated, and the repeats leave the set's number where it was, since a
coverage count is the union over what the runs reached. `Status`, the job that
joins the lanes, adds up what they measured for each set, scores each set over
its member's own source, and compares that against what the same set measured at
the newest `main` commit the branch contains. The baselines come from the
manifest current at the commit under test. A rise fails the pull request, and it
is the only coverage check that fails anything.

Run it yourself the way `Status` does:

```
deno run -A tasks/coverage-gate.ts --base origin/main --reports <directory> \
  [--body <description>] [--tests-failed] [--comment <file> --pr <number>]
```

where the directory holds the lanes' uploaded coverage. It prints a row
per set — the baseline, this run's count, the change, and the outcome —
and stops with a non-zero status on a rise nothing accepted. `--body` is the
pull request's description, where an acceptance is read from. `Status` reads the
description through the API rather than from the event that started the run. A
re-run repeats that event, so reading the description as it stands is what makes
an acceptance written after the push count on a re-run. A description `Status`
cannot read fails the step. `Status` passes `--tests-failed` when `tests`, the
job that runs the lanes, did not succeed.

`--comment` writes the comment the pull request is to be left with, as
`{prNumber, state, body}`: `state` is `regressed` where the gate failed and
`resolved` where it passed. `Status` uploads it as the `coverage-comment`
artifact, because a fork's pull request gets a read-only token there, and
`.github/workflows/pull-request-comments.yml` runs
`tasks/post-coverage-comment.ts` from the base repository's context to post it.
A pull request has at most one coverage comment, the one carrying the marker the
body opens with. A `regressed` payload posts it or rewrites it. A `resolved`
payload rewrites an existing one into a collapsed note saying the gate passes,
and posts nothing where there is none, since a pull request the gate never
failed has nothing to be told.

A run whose tests failed scores nothing. Where its gate found no failure of its
own, it writes no payload, and the comment stays as it was, since a pass in such
a run says nothing about a rise the comment may report. A failure the gate did
find in such a run, such as an acceptance it cannot read or one naming no
workspace member, is written. The poster posts only to the pull request whose
head is the commit the run tested. The Pull Request Comments workflow hands it
that commit as `HEAD_SHA`, and it refuses a payload naming any other pull
request or issue, because the payload was written by the pull request's own code
and the poster holds a write token.

Six things are worth knowing before reading a failure.

- **Each set is on its own.** A member with two measured sets has two
  numbers, and neither pays the other down. Nor does the source group over
  the same member, which is that member's source measured by every test in
  the run: `deno task test-selection coverage` shows the set's number and
  the coverage tile shows the group's.
- **Accept a rise in the pull request's description**, on a line of its
  own at the left margin, naming the member and the rise:
  `ACCEPT_COVERAGE_DEBT: packages/memory +12 lines`. The gate prints the
  line to paste with the number already filled in. One marker covers every
  set over that member.
- **A marker naming anything but a workspace member fails the gate.** Nothing
  consults it, so a marker naming a source group such as `packages/connectors`,
  which holds members but is none, would otherwise pass for one that worked. The
  gate lists the names it did not recognize.
- **A change reaching more than `LOCAL_COVERAGE_MAX_SETS` sets forces
  none of them**, and the summary says so. The tests still run under the
  ordinary rules; it is the run-the-whole-set part that stops. A set some
  run measured anyway is still scored, so a pull request labelled
  `ci: full`, which measures every set, is gated whatever the cap says.
- **A run with a failing test reports rather than gates every set a
  lane's report measured.** Coverage measured through a failure says
  nothing about whether the change was tested, and the failing test is
  what to fix.
- **A forced set that no lane's report measured fails**, in a run with a
  failing test as in any other. That is a set no lane reported, or one
  whose reports name no line of its member; a set's tests always load
  some of their own member's source, so an empty report measured nothing
  rather than covering nothing. The change was made to measure that set,
  and a lane that stopped before writing its report, an upload that
  carried nothing, a download that found nothing, and a lane that wrote
  an empty report all arrive at the gate looking the same. The row says a
  rise cannot be ruled out. A set the cap left unforced has nothing
  asking for it to be measured, so one no run measured is reported rather
  than failed.

Nothing about coverage fails a run on `main`. That run measures every set,
which is where the baselines come from, and merges every report into the
repository-wide figure the dashboard tile shows. That figure is a trend and
fails nothing. `Status` measures both on a push with `tasks/coverage-report.ts`,
over a directory holding the lanes' uploaded coverage:

```
CF_TEST_RECORDS_DIR=<spool> deno run -A tasks/coverage-report.ts \
  --reports <directory>
```

It writes the figures as measurements into the spool
`CF_TEST_RECORDS_DIR` names, and with that variable unset it records no
figure and only reports its summary. The shipping step of `Status` carries them
to the record store under the context the relay composes for the job, which
names the commit and the run, so the measurements carry neither. The publisher
collects the baselines from the objects it folds, each against the commit
its context names, and keeps them for
`LOCAL_COVERAGE_BASELINE_DAYS`;
[Coverage figures in the store](COVERAGE.md#coverage-figures-in-the-record-store)
says how each reader finds them.

The measurements also say whether the run's compile byte cache was cold, read
from the record each lane that opened the cache leaves beside its
coverage, so that the dashboard can leave a cold run out of its trend.
[Compile cache state and cold runs](COVERAGE.md#compile-cache-state-and-cold-runs)
says why a cold run's figure differs.

One set can come out of that with no baseline. A lane that saw a unit of
a measured set fail writes a marker beside that set's report, and the
report goes on merging into the repository-wide figure while the set
publishes nothing. What the marker stops is a number the run did not
clear becoming the bar every later pull request is held to: the run can
stay green through such a failure, so nothing else downstream would know
the number is short by whatever the failing test would have reached.

## Every dial

`tasks/test-selection/policy.ts` defines every one of these, and nothing
else defines any of them. `dials` prints the same content as the table
below, and `tasks/test-selection/policy.test.ts` holds the two to each
other: a dial added, removed, or reworded in `policy.ts` without the
matching edit here fails `deno task test`.

The **Units** column says what each number counts. Several of the dials
are bare fractions that do not mean the same thing, and the table holds
two different `0.25` values as it stands: `WEIGHT_BREADTH` is a share of a
test's score and `FILL_DENSITY_SHARE` is a share of the run's budget. A
share of an item's runs reads the same way again. Naming the unit is what
keeps them from being compared to each other.

The **Set by** column separates three kinds. A **chosen** value is a
decision somebody made, and editing it is how the decision changes. A
**measured** value is worked out from the data and written back by the
publisher, so the number in the file is only the seed used before there is
anything to measure, and editing it changes nothing after the first
publisher run. A **derived** value is computed from other dials and has no
expression of its own to edit: each lane budget is its run's bound less
the prologue and the safety margin, so a budget that does not fit inside
its own bound cannot be written down. The distinction matters because all
three look identical in a source file, and somebody who tunes a measured
value is arguing with a tape measure while somebody who tries to tune a
derived one is editing a line that is not there.

Four more numbers are measured, and they are not in the table because
they are not in `policy.ts`: `setupCost` for each capability, and
`suiteOverhead`, `correction` and `unitOverhead` for each suite. They are
fitted from the lanes' own timing records and published in the manifest,
one set per publisher run, which is where to read them. Nothing hand-edits
them, and a manifest carrying a strange one is a measurement to look at
rather than a setting to fix.

| Dial | Default | Units | Set by | Why you would move it, and which way |
| --- | --- | --- | --- | --- |
| `LANES` | 5 | lanes | chosen | Up when pull-request feedback is too thin and runner capacity allows more; down when the wave crowds other workflows off the shared runners. |
| `LANE_BOUND_SECONDS` | 300 | seconds | chosen | Up when more should fit in a lane; down when five minutes is longer than anybody will wait for a first answer. It sets what a lane packs against, not the workflow's step timeout, which only stops a lane that hangs. |
| `LANE_PROLOGUE_SECONDS` | 40 | seconds | chosen | Up when checkout, setup, and cache restore take longer than this and eat into the safety margin; down when they take less. Nothing measures it. |
| `LANE_SAFETY_SECONDS` | 30 | seconds | chosen | Up when lanes overrun their bound on slow runners; down when they finish early every time and the headroom is buying nothing. |
| `LANE_BUDGET_SECONDS` | 230 | seconds | derived | Nothing edits this. It is the bound less the prologue and the safety margin, so a budget that does not fit inside its own bound cannot be written down. |
| `FULL_LANE_BOUND_SECONDS` | 600 | seconds | chosen | Up when the run on `main` uses more jobs than it needs; down when `main` takes too long to say something broke. |
| `FULL_LANE_BUDGET_SECONDS` | 530 | seconds | derived | Nothing edits this. It is the full run's bound less the same prologue and safety margin a pull request's lane pays, since a lane of either run is the same job doing the same setup on the same runner. |
| `FULL_LANES_MAX` | 30 | lanes | chosen | Up when the organization's runner limit rises; down when a push's full run crowds out the pull requests behind it. A full run needing more lanes than this takes this many, and a lane may then run past its budget. |
| `FULL_RUN_LABEL` | ci: full | a label | chosen | Not a quantity. Change it only if the label collides with one the repository already uses for something else. |
| `UNMEASURED_COST_SECONDS` | 1 | seconds | chosen | Up when a lane holding new tests runs long; down when it finishes early. It is reached for only by a suite with no measured unit at all, since a suite that has any charges an unmeasured one the larger of its units' mean and their ninetieth percentile. |
| `VALUE_FLOOR` | 0.05 | score | chosen | Up when the cheap tail is not being swept up; down when it crowds out tests with a record of catching things. |
| `WEIGHT_PROVEN` | 0.55 | share of the score | chosen | Up when a record of catching things should count for more. The three weights are shares of one score, so what this gains the other two lose. |
| `WEIGHT_BREADTH` | 0.25 | share of the score | chosen | Up when a test that several distinct sources have hit should count for more; down when breadth is mostly telling you about the environment rather than the test. |
| `WEIGHT_CHURN` | 0.15 | share of the score | chosen | Up when something going wrong right now should jump the queue faster; down when the queue keeps being jumped by noise. |
| `PROVEN_SATURATION` | 2 | catches | chosen | Where the `proven` term reaches half its ceiling. Up when the term should go on telling eight catches from four; down when one catch should already be worth nearly everything a test can earn. |
| `FRESHNESS_HALF_LIFE_DAYS` | 120 | days | chosen | Up when old catches should keep more of their value; down when a test that caught something a year ago crowds out one that caught something last week. |
| `FRESHNESS_FLOOR` | 0.3 | multiplier | chosen | Up when a very old catch should keep more of its worth; down when age should be allowed to retire one almost completely. |
| `CATCH_WEIGHT_LOCAL` | 2 | multiplier | chosen | Up when evidence from a workstation should count for more; down if local records ever arrive in volume and stop being the scarce signal they are today. |
| `CATCH_WEIGHT_PR` | 1 | multiplier | chosen | Neither. It is the unit the other two are expressed against, so move those instead. |
| `CATCH_WEIGHT_MAIN` | 1.5 | multiplier | chosen | Up when an escape should pull harder on what gets selected next; down when the failures on `main` are mostly environmental rather than real. |
| `BREADTH_SATURATION` | 2 | sources | chosen | Where the `breadth` term reaches half its ceiling. Up when the term should go on telling eight sources from four; down when one source should already be worth nearly all it can give. |
| `ENVIRONMENTAL_MIN_SOURCES` | 5 | sources | chosen | How many distinct sources a failure must span inside `CATCH_BREADTH_WINDOW_DAYS` before it reads as the environment. Up when a genuinely broad regression is written off; down when a broken runner's failures still count as catches. |
| `CHURN_HALF_LIFE_DAYS` | 14 | days | chosen | Up when recent trouble should stay relevant for longer; down when a problem already fixed keeps its tests selected for weeks afterwards. |
| `CHURN_WINDOW_DAYS` | 60 | days | chosen | How far back the decayed counts are read. Past this the weight is under one part in sixteen, so moving it is a performance decision rather than a policy one. |
| `FLAKE_HALF_LIFE_RUNS` | 200 | runs | chosen | How many runs without disagreeing halve what a disagreement counts for. It is also how much evidence the share is measured over, so far below one over `FLAKE_EXCLUSION_RATE` the share swings about on too little: up when it does; down when a test that has plainly settled is still judged by what it did. |
| `FLAKE_WINDOW_DAYS` | 60 | days | chosen | How far back the counts are read at all. The weight decays by runs rather than by days, so this bounds what is remembered rather than marking where the weight has faded: a test that runs rarely can still be carrying weight when its days fall off the end. |
| `COST_WINDOW_DAYS` | 7 | days | chosen | Up when cost estimates are noisy; down when durations drift with the code or the runner image faster than the estimate follows. |
| `FILL_VALUE_SHARE` | 0.6 | share of the run's budget | chosen | Up when expensive high-value tests are crowded out by cheap ones; down when a lane spends its budget on a few slow tests and runs little else. The three shares sum to one. |
| `FILL_DENSITY_SHARE` | 0.25 | share of the run's budget | chosen | Up when more of the cheap tail should run; down when the tail is displacing tests with a record. |
| `FILL_EXPLORATION_SHARE` | 0.15 | share of the run's budget | chosen | Up when the unselected corpus is going stale; down when lanes spend the share on tests that never find anything. |
| `MIN_CORRECTION_SPAN_SECONDS` | 23 | seconds | derived | A tenth of a lane's budget, measured as the widest gap between the time two batches' own tests took. Nothing edits it: it moves only when the lane's budget does. |
| `MIN_CORRECTION_SAMPLES` | 3 | batches | chosen | Up when a slope is being fitted from too little and swinging about; down when a suite's real slope takes too long to be believed. |
| `FLAKE_EXCLUSION_RATE` | 0.005 | share of runs | chosen | Up when fewer tests should be held back from pull requests; down when flakes are still blocking people. |
| `FLAKE_MIN_EXECUTIONS` | 2 | runs of one item | chosen | What an item that has ever disagreed runs. Down to one when the cheapest evidence of intermittency is not worth a second execution; nowhere useful above two, since the line through the anchor covers everything flakier. |
| `FLAKE_ANCHOR_RATE` | 0.01 | share of runs | chosen | With `FLAKE_ANCHOR_EXECUTIONS`, the point the count's line passes through. Down to make the count climb faster with the rate; up to make it climb slower. |
| `FLAKE_ANCHOR_EXECUTIONS` | 5 | runs of one item | chosen | What an item at `FLAKE_ANCHOR_RATE` runs. Up when intermittent regressions still get through; down when executions crowd a lane. |
| `MAX_EXECUTIONS` | 10 | runs of one item | chosen | Where the line stops. Up when the flakiest items a change forces in still are not proven by what runs; down when they crowd a lane. |
| `SUITE_FLAKE_PRIOR_RATE` | 0.02 | share of runs | chosen | Up when too many suites count as flake-prone and their new items are repeated needlessly; down when new tests in a noisy suite land unrepeated and then flake. |
| `COVERAGE_COMMENT_LINES` | 25 | lines | chosen | Up when coverage comments are too noisy; down when debt is climbing unnoticed. |
| `LOCAL_COVERAGE_MAX_SECONDS` | 30 | seconds | chosen | Up when too many sets are reported as expensive for the report to be worth reading; down when one is quietly eating a lane. Nothing is excluded either way; it only decides what the summary mentions. |
| `LOCAL_COVERAGE_MAX_SETS` | 2 | measured sets | chosen | Up when broader changes should still be gated and the run can afford those sets' whole unit lists; down when sweeping changes are crowding lanes. |
| `EXCLUDED_FROM_COVERAGE_GATE` | 9 | workspace members | chosen | Not a quantity. A line comes off when a package fits the run's budget or gains a Deno-only half, which gives it a measured set. A line goes on when a package's own tests stop being what covers it. |
| `LOCAL_COVERAGE_BASELINE_DAYS` | 7 | days | chosen | Up when branches based further back are being reported for want of a baseline they contain; down when the manifest carries more history than anybody reads. |
| `COVERAGE_TREND_WEEKS` | 3 | weeks | chosen | Up when the tile goes amber too readily; down when debt climbs for a month before anybody is told. |
| `CATCH_BREADTH_WINDOW_DAYS` | 2 | days | chosen | Up when a broken runner's failures are being counted as catches; down when genuine breadth is being written off as environmental. |
| `SAME_COMMIT_REACH_DAYS` | 2 | days | chosen | How far back the fold remembers a commit's outcomes, so that a rerun landing in a later batch than the run it repeats is still read as the test disagreeing with itself. Up when reruns land far enough behind that their disagreement is being counted as a catch; down when the fold's memory is the thing that will not fit. It costs the number of identities that have failed times the number of commits, so it is the dial to check first when a run runs out of memory. |
| `FLAKE_COMMIT_REACH` | 8 | commits | chosen | How many of the most recently observed commits the fold keeps every identity's outcomes at. Past that a commit keeps only the identities that have already failed, so this bounds a test's first failure: up when one lands more commits after the pass it disagrees with than this and is counted as a catch; down when the fold's memory is the thing that will not fit. |
| `RENAME_SIMILARITY` | 0.7 | share of the longer name's own part | chosen | Up when the run report offers rename pairings nobody meant; down when a rename that discarded history goes unoffered. It only decides what is suggested — nothing is written to the alias file without somebody appending it. |
| `RENAME_MARGIN` | 0.1 | share of the longer name's own part | chosen | Up when the run report pairs a deletion with an unrelated addition; down when a rename made alongside another rename in the same area goes unoffered. |
| `RENAME_SUGGESTIONS` | 5 | suggestions in one comment | chosen | Up when a change that renamed many tests has its later suggestions cut off; down when a comment carrying this many is one nobody reads. |
| `ALIAS_GATE_MIN_CATCHES` | off | catches | chosen | Off by default. Turn it on at a catch count to fail a pull request that discards that much history in a rename without an alias line, and lower the count as the alias file becomes routine. |

## The publisher

`.github/workflows/test-selection.yml` runs every four hours and on manual
dispatch. Four-hourly rather than daily because aggregation is incremental
and therefore cheap, and a flake that appears in the morning should not
wait until the small hours to be prioritized. Manual dispatch is there so
that somebody who has just fixed something can refresh without waiting.

Each run reads the newest aggregate it can, fetches only the objects whose
runs are not already folded into it, folds them, ages the counters, scores
everything, and creates one manifest object and one aggregate object. It
reads and folds two hundred objects at a time, so what it holds is bounded
by the number of tests rather than by the number of runs.

A manifest holds every identity in the aggregate that the topology can
place, rather than the identities that ran inside the window the run
read. Placing an identity needs the file its records named, where its
suite's units are files, so the aggregate carries that file beside the
identity's scores. Without that, a manifest would hold what ran lately:
an identity would leave it on the first run that read none of its
records, and come back the next time it ran, while its scores sat in the
aggregate throughout. The exploration draw picks from the manifest's
entries, so the tests that had gone longest without running would be the
ones it could no longer reach. An aggregate written before those files
were carried holds none, and each identity rejoins the manifest as its
records name a file again.

A day of an identity's cost window carries the set of cost rules that
sealed it, as `COST_RULE`. A day carrying no such stamp was sealed
before the stamps began, which is every day an aggregate written before
them holds, and it counts as another set's day like any other.

Sealing a day drops every day of that identity another set sealed, so a
state holds one set's days. Another set's day is charged while it is all
there is, which for a test that has not passed since the change is until
the day ages out of the window, and is dropped the moment the rules in
force seal a day for that test.

Changing which executions reach a day's sample, or what the sample
holds, means changing `COST_RULE` in the same change. The cost window
then refills over its own length, charging fewer days' figures while it
does; carrying the old days instead would have figures the new rules
would never produce deciding what a pull request runs for that same
stretch.

A change to what a manifest or an aggregate holds needs no cold start.
The area both are written under is named rather than numbered and does
not move, so a run finds the aggregate the run before it left; a stored
body says which shape it was written in, and a reader reads anything at
or under its own forward, field by field. What a reader will not read is
a body from further ahead than itself. `writtenAhead` is what every
reader asks about that, so that what counts as too far ahead is answered
in one place.

A lane looks past such a body to the newest one behind it, over
`MANIFESTS_LOOKED_BACK` manifests, because a lane with no manifest runs
the whole corpus. The dashboard looks past one the same way and over the
same stretch, so that the figure a person reads is taken from the manifest
a pull request would obey rather than from an older one the dashboard
alone settled for.

A reader that passed over every body it looked at says so, naming the
newest shape it passed over. Reporting nothing there would say the store
holds no manifest, which is the one thing a reader that far behind its
publisher must not say. Anything else unreadable ends the search where it
stands: a corrupt object is not a reader waiting to be deployed, and
answering from an older body would report a figure while passing silently
over a store that is damaged.

**Nothing gates on it.** When the publisher fails, the previous manifest is
still the newest one and consumers keep using it. A manifest going stale
degrades selection quality slowly rather than failing anything, which is
the right direction for a system nothing should gate on.

That is why a run that cannot read any aggregate a previous run left
refuses to publish rather than starting from nothing. The aggregate is
where a test's catches live, and they accumulate over unbounded history:
a run that lost it and carried on would publish a manifest scoring every
test at the floor, and because it succeeded that manifest would be the
one every lane obeys. A stale manifest is recoverable; a confident wrong
one is not.

Refusing over the newest state alone would be permanent, though. Nothing
but the publisher creates a state object, and it creates one only where
it folded, so a newest state it cannot read is one every later run comes
to in the same condition: a body written in a shape from further ahead,
which is what lowering `MANIFEST_SCHEMA_VERSION` leaves behind, or a
body that arrives and is not an aggregate, which the store's create-only
credentials mean nothing can replace. So a run passes over a state it
cannot read and folds onto the newest one behind it that it can, saying
which it passed over and why.

A read that does not arrive is neither of those and is refused, the same
as a listing that fails. It says nothing about the object, and a run
that passed over on it would write a state superseding the one it
skipped, turning one bad read into a permanent one.

The days the run reads are what bound the walk. What a passed-over state
folded and the one behind it did not comes back from the records, so a
state named for a day before the first day of the window is not one the
walk reaches, and `--days` is what reaches it. That bound is what the
run can state rather than an exact account of the gap: the runs that
wrote the passed-over states read windows of their own, reaching a day
earlier than their own day for as many days as their window held, and a
record that arrived for one of those earlier days after the state behind
it was written is outside what this run reads. The run says so where it
happens, naming what it passed over and what it folded onto. The newest
state is read whatever day it carries, since taking it is not a choice
between two aggregates.

A cold start cannot read the whole window in one job, and is asked for
deliberately: the bootstrap is a manual dispatch with the bootstrap input
set, run once, and an incremental run that finds no aggregate at all says
so and stops. After that the incremental path keeps up. A store holding
no aggregate is the whole of what asks for a bootstrap. A change to what
a manifest or an aggregate holds does not, and neither does a stored
aggregate this publisher cannot read: both leave the catches where they
are, and a bootstrap would publish from an empty aggregate and drop
them.

A bootstrap replaces the score history rather than extending it. It folds
into an empty aggregate, so the state object it creates holds what its
window shows and nothing earlier, and every later run reads that one. A
test's catches accumulate over unbounded history, so the ones counted
before the window stop counting, and a bootstrap over a narrow window
throws away more than one over a wide window does. Nothing in the store
is removed: the publisher's identity holds create and not delete or
overwrite, so the state object a previous run left stays where it is and
stops being the newest.

The two paths look back over different windows. An incremental run reads
two days. A bootstrap reads sixty. The dispatch carries a days input
naming a window of its own, and it applies in either mode, so a bootstrap
over a shorter stretch of history is a matter of giving it.

The bootstrap input does not decide whether a run reads a rollup. One
rule is asked of each source and date the window covers. A pair whose
rollup is already folded is closed. A pair nothing is folded from is
taken from its rollup, where a rollup covers it. Everything else is read
raw. Both modes apply that rule. Their answers differ because their
aggregates differ, rather than because the input names a second way to
choose.

A run reaching a pair nothing is folded from takes that day whole from
its rollup, which is a manifest and a few tens of shards against the
day's thousands of raw objects. The publisher reads four shards at a time
and writes each run's observations to a temporary file. It keeps an offset
and timestamp per run in memory. The fold replays that file in time order
for each evidence pass and the classification pass, holding one run's
observations at a time. Shards are assigned by a hash of the raw object's
name, so shard order does not describe when the runs happened. Same-commit
disagreement and environmental failures also require evidence from the
whole day before any failure is classified.

A busy day is about six million observations, so the temporary file for
one runs to a gigabyte or two. One day is live at a time, and its file is
removed before the next day is read.

Keeping those observations in memory rather than in a file would fit
today. Folding the largest day so far peaks a little over a gigabyte with
the file, and holding what it spooled would add an estimated gigabyte and
a half to two gigabytes, against a heap V8 caps near four gigabytes. That
estimate comes from the size of an observation rather than from a measured
run without the file. The file is what leaves room for the corpus to grow
into.

The temporary file is removed when the day finishes or the read fails.
A day whose shards will not read is read from its raw objects instead,
which is how a day with no rollup at all is read, and the run says which
day it read that way and what stopped the rollup. The fold takes nothing
from the shards that did read, so no part of the day is counted twice,
and the day is left open rather than recorded, so later runs read it the
same way. Completed days are recorded, so no later run over a wide window
folds their raw objects on top and doubles every catch in them.

Falling back rather than ending the run is what keeps a shard from
stopping the publisher for good. The store holds create and nothing else,
so a shard that will not read stays where it is, and a run that ended
there would leave the day unrecorded for the next run to end on in the
same place.

Reading a day the long way costs more than the one run it happens on.
Every object of that day goes into the aggregate's list of folded
objects, where the rollup path would have written one receipt, and that
list is carried in every state object written from then on. The day is
also folded after the rollup days that follow it, because every rollup
day is read before the raw pass begins. The rules that decide whether a
failure is a catch look a day or two either side of it, and the fold has
by then aged its cross-batch context past the day being folded, so that
evidence is not in view. Every local submission of every day is folded
after every rollup day for the same reason. The day's own records are all
there and none of them is counted twice; what the day loses is some of
the evidence that would have classified them.

What the fallback rests on is that the shards that did read reached the
batch and nothing else. Replaying the spooled observations is a read of
the temporary file, and a failure there drives the fold, so part of the
day is already counted when it is raised. Reading that day again by any
route would count that part twice, and the run refuses there rather than
falling back.

A rollup is a derived cache of one closed day rather than the full-fidelity
record of that day, so
[the record spec](../specs/test-records.md#trust-boundaries-for-consumers)
asks a consumer that feeds decisions to treat a rollup as a cache of one
day rather than the record of it. What that rests on is the content: a
rollup summarizes a day's raw records rather than carrying them. It does
not rest on the credential that wrote it. The daily compactor
authenticates without a key through Workload Identity Federation, pinned to
`.github/workflows/test-records-compact.yml` on the default branch. There is no
downloaded compactor key and no writing path from a workstation; a local
`deno task test-records-compact --plan` is read-only.

The four-hourly publisher normally reaches no rollup: compaction leaves a
partition open for a week, while the incremental publisher reads two days. A
bootstrap, an incremental run catching up after an outage, or an incremental
run using a deliberately widened window can reach older closed days and read
their rollups. A day the compactor has not reached is folded from its raw
objects.

Publishing uses the workflow's own federated identity, pinned to that workflow
file on the default branch. It is the only workflow principal with a
folder-scoped create grant for manifests. A personal reporting key cannot
create one: it is scoped to its holder's own submissions folder. So a person
runs `--dry-run --out` and reads what a run would have produced.

### Verifying publication

A bootstrap or recovery is accepted only after all three of these are true:

1. The workflow run succeeds and its log names the manifest it created.
2. A complete public listing contains that manifest and a state object with the
   same trailing identifier.
3. A later incremental run succeeds and creates another manifest and state
   pair. Reaching that write proves that the incremental path could list, read,
   and validate the state left by the earlier run.

These checks are read-only:

```bash
gh run list --repo commonfabric/labs \
  --workflow test-selection.yml --branch main --limit 10
gh run view RUN_ID --repo commonfabric/labs --log
deno run --allow-net --allow-env - <<'TS'
import { listObjectTimes } from "@commonfabric/test-support/records";
import { storeBucket } from "./tasks/test-records-config.ts";
import { manifestPrefix } from "./tasks/test-selection/store.ts";

const prefix = `${manifestPrefix()}/`;
const objects = await listObjectTimes({ bucket: storeBucket(), prefix });
for (const object of objects) console.log(object.createdAt, object.name);
console.log(`${objects.length} objects under ${prefix}`);
TS
```

Use the identifier at the end of the logged manifest name to find both
objects. `listObjectTimes` reads the listing to its end rather than a
first page, so a name it does not print is a name the prefix does not
hold. The count on the last line is what separates a prefix holding
nothing from a listing that never ran: a cold start prints the count and
no names.

The selection dashboard tile supplies the existing stale signal: it turns
amber when the newest manifest is more than eight hours old.

### Recovery

Read the failed run's log and the public object listing before taking action.
Do not use bootstrap as a routine retry: it starts from an empty aggregate and
replaces score history with only the selected window.

- If the newest state is valid, rerun the ordinary workflow from `main` with
  bootstrap off. An empty `days` reads the landed two-day default, which is
  what an ordinary catch-up needs. An outage longer than that needs a wider
  window, and the `days` input is what widens it. Such a run is still an
  incremental one: it folds onto the state already there rather than
  replacing it, which is what separates it from a bootstrap.
- If the complete paginated listing has no state objects under the intended
  prefix, this is a cold start. Dispatch the workflow from `main` once with
  bootstrap on and leave `days` empty so the landed sixty-day default applies.
  Then require the three acceptance checks above. A change to what a manifest
  or an aggregate holds is not a cold start: the area is named rather than
  numbered, so it does not move, and both are read forward.
- If the run's log names a state it passed over and a state it folded onto,
  that pair says which aggregate the run took and nothing more: it is printed
  before the run reads a record or creates anything, so a later listing,
  read, or creation that failed leaves the pair in the log of a run that
  published nothing. What says a run published is its `created ...` line
  naming the manifest object, together with the run's own conclusion. Where
  both are there the recovery happened, and what a passed-over state folded
  from days outside that run's window is not in the manifest; a second
  dispatch changes none of that. Either way the log is reporting that the
  newest states stopped being readable, which is the thing to go and find
  the cause of.
- If the log says every state it looked at was one it could not read, read
  the fault it names against each. A state written in a shape from further
  ahead means a publisher below that shape is deployed; land a `main` that
  reads the shape it names and dispatch again. Where the log adds that the
  states behind those are named for days before the first day the run reads,
  widening `days` is what reaches them: dispatch with a window reaching a day
  the listing above shows a readable state was created on. Either way leave
  the append-only manifests and state objects intact — they and the raw
  record history are the recovery sources — and do not reach for bootstrap or
  for object deletion or renaming.
- If a widened window reaches no readable state either, work back through
  the listing, dispatching with a window that reaches the day each older
  state was created on, until one is folded onto or the listing runs out. A
  state written in a shape from further ahead is history out of reach rather
  than history lost, and reads as soon as a publisher at that shape is
  deployed, so a store holding one is never a cold start. A store whose
  every state is a body that arrived and is not an aggregate holds no
  history any publisher can reach, and that alone is the condition under
  which this is a cold start: dispatch once with bootstrap on, and then
  require the three acceptance checks above.
- If listing a state, or reading one, fails outright, that is neither absence
  nor an unreadable state: the run learned nothing about the object, and
  refuses on that rather than taking the one behind it. Dispatch again once
  the store serves the read.

To run it by hand against the store without creating anything:

```bash
deno run --allow-read --allow-env --allow-net --allow-write \
  tasks/test-selection-publish.ts --days 1 --dry-run --out /tmp/selection
```

That writes the manifest and the aggregate as plain JSON where you can
read them, and creates nothing in the store.

## What a run leaves out

A run's log names four kinds of identity that did not reach the manifest.
The first is the design working. The second is a test the tree no longer
holds. The third is a surface whose records do not say which unit they
belong to. The fourth is a topology defect.

The first is the identities that measure a whole invocation:

```
test selection: 8 identities measure a whole invocation rather than one
unit, so they are left out. The steps inside the invocation are measured
separately, so nothing is missing and there is nothing to act on.
```

A script that records each of its steps also records its own run from end
to end, and the topology tells the two apart. The whole-invocation record
names no unit, so no lane can be asked to run it, and adding its time to
the time of the steps inside it would count that work twice. The count is
that separation working. It changes when a suite gains or loses such a
record, and there is nothing to do about it either way.

The second is the identities that have left the tree:

```
test selection: 6 identities have left the tree: no suite claims them and
no run of them has been recorded inside the window a state keeps counters
for. Their states are dropped from the aggregate.
test selection: those 6 were recorded by 2 surface(s): unit:utils 4,
unit:memory 2
```

A test deleted from the repository keeps its records in the store, and
the store is what the publisher reads, so without this the aggregate
would carry its state for as long as the store lives. Two things have to
hold before one is dropped. No suite claims it, so nothing in the tree
can be asked to run it. And no run of it has been recorded inside the
window a state keeps counters for, which is the longer of
`CHURN_WINDOW_DAYS` and `FLAKE_WINDOW_DAYS` and so is sixty days today.

The second condition is what the first cannot say on its own. A suite
whose records name a scope the topology no longer holds claims none of
its identities, and every one of those is still running on the default
branch, so the runs hold them where the claim does not. What the second
condition does not reach is a test the tree holds that nothing runs at
all: a skip is the one outcome a state records nothing for, so such a
test meets both conditions and is dropped like a deleted one. What that
costs is catches from before the window, because every counter inside it
is empty either way.

A unit a configuration declares unavailable is the exception, and is kept
under the variant that declared it: the declaration is the tree saying the
test is there and does not run in this configuration. The exemption is
read a unit at a time, so a declaration naming one leaf inside a unit does
not reach it — such a unit is still enumerated and still running, and its
identities are placed by their file rather than reaching this at all.

That window is how long a deletion takes to settle. Until then the
deleted test is in the count below rather than this one, because it did
run inside the window. So this count is a one-off when a change deletes tests
and nothing at all in between, and a count that stays large run after run
is a suite that has stopped recording rather than a set of tests somebody
deleted. The surfaces named beside it say which suite.

The third is the identities no suite claims that the aggregate still
carries:

```
test selection: no suite claims 3295 identities the aggregate still
carries, so no lane can be asked to run one. Each has run inside the
window a state keeps counters for, or a configuration declares its unit
unavailable. What puts an identity here, and what takes it out again, is
in docs/development/test-selection.md.
test selection: those 3295 were recorded by 12 surface(s): unit:utils 742,
unit:runtime-client 509, unit:ts-transformers 379,
unit:schema-generator 314, unit:js-compiler 153, and 7 more
```

A surface is the kind of check a record is, the workspace member that owns
it, and the configuration it ran under where that is not the default one.
It says which part of the tree the count is about. The worst five are
named and the rest are counted, so that reading the count does not mean
reproducing the publisher against the store by hand.

What decides an identity's unit is its own records. Where a suite's units
are files, the answer is the file on the record, and a record has one when
the report it came from could name one: the registration preload captures
which module registered each test and leaves that map beside the report,
and ingestion otherwise reads the file from the report's own class names,
which needs the working directory the test process ran in. A report that
supplies neither has no file on any of its records, and neither does a
name that two files in one report both report. Where a suite's units are
not files — a dispatch arm, a pattern key — the answer is the recorded
name instead, and a name no suite recognizes leaves the identity without a
unit the same way. What
is not in the count is the lane measuring its own setup and its own
batches. Those records travel the same path as a test's, but nothing
enumerates them and no lane can be asked to run one, so no suite has a
unit for them and none should. `isLaneMeasurement` is what says so, and
everything that reads a recorded identity asks it: the drift guard, the
publisher, and the fold that carries the surfaces from one run to the
next. Each asks it of the identity the lane wrote, before the alias file
rewrites anything, so no line in that file can turn a lane's overhead
into a test's score.

Left out of everything scored, they are not discarded. The publisher
keeps them in its rolling aggregate over `COST_WINDOW_DAYS`, the same
window it measures a test's cost over, and fits `setupCost`,
`suiteOverhead`, `correction` and `unitOverhead` from them for the next
manifest. A lane writes one record per capability it opens and three per
batch — what the batch spent, what its own tests took between them, and
how many units it opened — and it is the second and third that make a fit
possible. Neither can be recovered from the records the batch produced: a
reader of a report cannot tell which of its records came from which
batch, and a unit whose tests all recorded nothing leaves no trace of
having been opened.

What its tests took, rather than what the packer expected them to take.
The two differ by however wrong the manifest's costs are, and a unit
nothing has measured is charged a stand-in that can be out by a factor of
ten. Fitting against the expectation would put that error in the
intercept, which is charged once to every lane that holds the suite and
kept for the whole window, long after the costs behind it were measured.
A suite whose intercept passes `LANE_BOUND_SECONDS` can place no
discretionary identity at all, so an expectation that was briefly wrong
would hold a whole suite out of every pull request for a week. What a
suite's cost model should carry is the machine's error, which is what the
tests' own time leaves.

The publisher leaves all of those out rather than putting an entry in the
manifest that no lane could run. The next record that says enough puts the
identity back in.

The count spans every identity the aggregate holds rather than the ones
this run read, because the surfaces it is taken from do. Three different
things are in it. The first is an identity whose records have never said
which unit it is in, which is the one to act on, and the next record
that says enough takes it out. The second is a test deleted inside that
window, which moves to the count above once the window has passed over
it and is gone from the aggregate for good after that. The third is a
test in a unit a configuration declares unavailable, which is here for
as long as the declaration stands and is not something to act on: the
declaration is why it stopped recording.

The fourth is the identities two suites both claim:

```
test selection: 2 identities are claimed by more than one suite, which is
a topology defect the drift guard fails on. They are left out rather than
placed in whichever suite came first.
```

No record can settle which suite owns one, so placing it either way would
put the work wherever the topology happened to be read in. The tree holds
the test twice over rather than not at all, which is why this is counted
apart from the tests that have left: an identity here keeps its history
until the topology is fixed.

The first runs after a change to what the aggregate carries report the
whole corpus here. An aggregate written before the files were carried
holds none, so every identity in it is read as its own invocation unit
until one of its records names a file again, and a suite whose units are
files can place none of them. Those runs publish the manifest they would
have published before, and the count falls as the records arrive. A
bootstrap would fill the files in one run, and it is the wrong tool for
it: a bootstrap replaces the score history with what its window holds,
so it would pay for a count that falls on its own with every catch
counted before that window.

What to check is that surface's wiring, which
[the record guide](test-records.md#covering-a-new-test-surface) covers: the
JUnit output the suite's command declares, the `--preload` naming
`packages/test-support/src/records/preload.ts` where the surface is `deno test`,
and the working directory that relative class names are joined onto. Where the
records do have a file, the file is one no suite has a unit for, and the answer
is in the topology.

### When the cost model is empty

Every run says what the cost model holds, so that one nobody measured is
as visible as one somebody did:

```
test selection: the cost model holds 12 suite(s) and 5 capability
setup(s), and 3 of those suite(s) have a cost with coverage on
```

The two halves are counted apart because they come from different
records. A lane writes one per capability it opens and a pair per batch,
and a lane killed part way through a batch leaves the pair unmatched, so
a model can hold a capability setup and no suite at all.

A batch run with coverage on is fitted apart from what the suite's batches cost
without coverage, because instrumenting a run costs it time and how much is a
property of the suite. The manifest carries the two fits in two maps of its
calibration: `suites` for batches run without coverage, and `suitesWithCoverage`
for batches run with it. The line counts each suite once whether it has one fit
or two, and the last figure is how many have a coverage-on fit.

The two fixed charges, a suite's `suiteOverhead` and a capability's
`setupCost`, are each the ninetieth percentile of what lanes have seen in
the window, the same percentile a test's own cost is read at: for a
suite, of what each batch spent beyond what its tests and its units
account for, and for a capability, of how long each opening took. That
is well above the typical observation of either. Up to one in ten
exceeds its charge, by an amount the fit does not bound. The safety
margin `LANE_SAFETY_SECONDS` absorbs such an excess up to its own size,
and a lane whose observations exceed their charges by more than that
between them runs past its bound. The charge is not the slowest observation,
because each charge is paid by every lane that holds the suite or
opens the capability: read at the slowest observation, one slow runner
would set what every lane pays, and every lane would pack short by that
runner's excess. The percentile is the observation at its rank rather
than a value between two, so over nine or fewer observations it is the
slowest of them, and a suite lanes have rarely run is charged its
slowest batch.

A run charges each suite the fit for how it runs that suite's batches:
`pricedForRun` in `tasks/test-selection/census.ts` charges the coverage-on fit
for every suite of the full run, and for the suites of the sets the coverage
gate scores on a pull request, and the other fit for the rest. Where no lane has
run a suite that way yet, the run charges the other fit. Charging a run without
coverage the coverage-on fit errs high. Charging a run with coverage the fit
without it is short by whatever instrumenting costs. Either is nearer than
charging nothing. A lane runs first the batches of a suite whose charge was not
fitted the way this run runs it. A lane is stopped part way through only by the
30-minute step timeout or by a cancellation, and one that is has then measured
what the model most needs.

A suite's own figures are what a lane is charged for holding the suite
and for opening each of its units, so a model with no suite in it
charges nothing for either and a lane packed against it runs past its bound. A
capability setup is measured from a lane's own records and is unaffected, and
the prologue is a fixed dial rather than a measurement at all, so it is there
whether any lane has measured anything or not. That is why this is about the
suites rather than everything a lane is charged. A run with no suite in its
model says so rather than publishing the empty map in silence:

```
test selection: no suite has a measured cost in the last 7 day(s), so a
lane is charged nothing for holding one or for opening its units, and a
lane packed against this manifest overruns. See
docs/development/test-selection.md.
```

Four different things end there. One of them the run can tell you
about, and a third line says so when it applies:

```
test selection: 15 lane measurement(s) this run read came from a run
the fold could not place, so the model was fitted without them.
```

**The fold declines the records of lanes that did run.** `provenance`
decides where a run's executions happened from the run's own facts, and
a run it cannot place contributes nothing — not its observations, not
its durations, and not what its lanes measured. A lane exercised only
from such runs therefore contributes nothing however long it runs and
however far back the publisher reads. That third line is what tells
this apart from a lane that has not run, and it is the one case here
anybody can act on.

It is counted over the objects the run folded, and over the same window
the model is fitted across, so a run reading a wider window than the
model's own — a bootstrap, or a window somebody asked for — does not
offer a measurement from a day the model cannot reach as the reason a
current model is empty. A measurement whose group carries no start time
that reads as one has no day and is not counted at all. So the figure is
evidence when it appears and says nothing when it does not: a run that
folds nothing new prints no such line whatever the store holds.

What `provenance` declines is what the record specification asks it to.
Under the
[trust boundaries](../specs/test-records.md#trust-boundaries-for-consumers)
the store holds every object to, a run marked `fork: true` was authored
under the repository's write access like any other, so a lane exercised
from a fork's pull request is read like a lane exercised from any other.
The flag marks a run whose head repository is not the base one, and
marks a run whose payload named fewer than both, so it is never a claim
that a fork ran the tests — which is why it settles whether a run may be
a baseline and says nothing about reading its observations. What is left
unplaceable is a run whose own facts do not say where it ran.

The other three the line cannot separate. No lane has run: nothing to
measure and nothing to do. A lane has run and recorded nothing, which
looks like any other suite that recorded nothing. Or the fold has
stopped reading a figure it used to read, or never started reading one
the lane now writes — `readReport` is where a stored object becomes the
kinds of thing the publisher takes out of it, and the lane measurements
are one of them, so a change on either side of that pair is invisible
except through the empty model itself.

All four fill in as soon as a lane run the fold can place lands: every
object the publisher folds for the first time gives up its lane
measurements, so one run puts a figure in the model and seven days of
runs fill the window `COST_WINDOW_DAYS` names. Until then the model is
not merely thin. Its fixed charges are ninetieth percentiles of what
lanes have seen: of each capability's openings, and of what each batch
spent beyond what its tests and its units account for. A model fitted
over part of a window may not yet have seen the slow runs that set those
percentiles, so it can read lower than one fitted over all of it, and
reading low is the direction that overruns a lane. A suite with nothing
at all in the window is charged nothing.

Nothing recovers a figure from before the publisher could read it. An
object the aggregate has already folded is never folded again, because
the counters it feeds add rather than replace, so a run that reads it
twice counts every execution in it twice. What a bootstrap is for is the
history that follows from the objects themselves; what no run can undo
is a window that went by while nothing readable was being written.

### What measured sets cost with coverage on

Two decisions about the coverage gate rest on what running a measured set with
coverage on costs, and the publisher's summary carries a line for each case that
asks for one. The publisher prefixes each line with `test selection: `.
`deno task test-selection coverage` prints the same lines for the manifest it
resolves, without the prefix.

```
test selection: workspace-unit/packages/glaze costs 41s with coverage
on, past LOCAL_COVERAGE_MAX_SECONDS of 30s. Its member's tests could be
split, the run could carry the cost, or the member could go on
EXCLUDED_FROM_COVERAGE_GATE.
```

A set past `LOCAL_COVERAGE_MAX_SECONDS` makes every pull request that reaches it
slower. What the line gives is the set's cost over the fewest lanes that hold
it, counting what each of those lanes pays for the set's suites and
capabilities. A set that no number of the run's lanes holds gets a line saying
it costs "more with coverage on than the run's 5 lanes of 3m50s hold". Nothing
is done about either automatically: which of the three to do is a decision
about the repository.

```
test selection: packages/donut is on EXCLUDED_FROM_COVERAGE_GATE for its
size, and its tests now cost 13m32s with coverage on across 4 lane(s),
inside the run's 5 lanes of 3m50s, so its line can come off.
```

Each entry on `EXCLUDED_FROM_COVERAGE_GATE` carries a kind in
`tasks/test-selection/policy.ts`: `size` for a member whose set is past what the
whole run holds, and `source` for a member whose own Deno-only tests are not
what should measure it, or that has none. An entry of kind `size`, and only such
an entry, comes off once its tests fit the whole run, and the line says when
they do, so that the entry comes off because somebody read a measurement. A
set's units are packed across lanes like any other mandatory work, so what it
has to fit is the run rather than one lane. A set spread over several lanes pays
its suites' overheads and its capabilities' setup in each of them. It also pays
each unit's overhead in every lane holding part of that unit, and a unit is
split over no more lanes than it holds entries, so that overhead is paid at most
once per entry. Each entry's own cost is multiplied by how many times it runs.
The units a set's suite declares unavailable are not run, so they are not
charged. The line charges a set or a member all of that over the fewest lanes
that hold it. All of one entry's runs go in one lane, so no number of lanes
holds a set or a member with an entry that costs more than one lane holds,
counting that lane's overheads and setup.

```
test selection: What 4 measured set(s) or exclusion-list entries cost
with coverage on cannot be said yet: no lane has run workspace-unit with
coverage on in the last 7 day(s).
```

Both judgments read the lanes' coverage-on fits. Until a lane has run a suite
with coverage on, what its tests cost that way is unknown, and a figure without
coverage is short by an unknown amount, so the line names the suites rather than
judging from it. A set or entry with no recorded test is passed over, since
nothing is known of its cost either way.

## What the run on the default branch does with a flaky test

A test whose flake share is above `FLAKE_EXCLUSION_RATE` is not selected
for a change. Where it may be run without its neighbours, the run on the
default branch runs it as many times as its share asks for and does not
fail for it, so it goes on being measured while it is out of changes, and
a green run of the default branch can carry a failure of one of these
tests and still deploy. `explain <identity>` says of any test whether the
manifest this commit resolves withholds it and how many runs it is given.
The reasoning behind each part is in [the
plan](../plans/pull-request-test-selection.md#an-excluded-test-still-runs-on-main).

A repository gate is a test like any other here. A gate introspects the
tree where a test runs the code, which decides what it reads and nothing
about what its failures are worth: a gate disagreeing with itself fails
somebody's change for something its author cannot act on, exactly as a
test doing the same does, and the flake tile is what asks for the fix in
both cases.

Two things go with that rule.

- **A failure the branch has not gone red for is still aged out.** Such a
  failure waits for a later run to judge it, and once the branch stops
  going red no such run has to arrive.
- **A measured set whose unit failed publishes no baseline.** [The
  coverage gate](#the-coverage-gate) says what that leaves for a later
  pull request.

A lane decides all of this from the records its batches gathered rather
than from what a command exited with. A runner that failed only on
identities a flake rate excuses has told the run nothing it should stop
for, and a runner that exited zero having run none of its unit has. So a
unit that recorded nothing fails the lane, and an excusal holds only for
an invocation that accounted for every identity it was asked to run.

## What the dashboard shows

Two tiles read the newest manifest. The flake tile reports how many tests
are too noisy to judge a change by. The selection tile reports what share
of the corpus five lanes would run and how close the fullest lane is to
its budget; it goes amber when the manifest has gone stale and red when a
lane's projected work is past its bound. Both tiles link to the full
manifest detail page.

Each tile charts its measurement from every available manifest, positioned
by generation time. The selected percentage uses each manifest's own corpus
size. Empty corpora and unreadable manifests leave gaps; measured zeros
remain visible. The chart's span follows the available objects. The dashboard
caches compact counts across restarts and removes them when their source
objects leave the listing. A latest manifest with no tests makes both
headlines unknown.

Both tiles show a running indicator while the publisher workflow is queued or
running on main. Activity and new manifests are checked every 30 seconds.
Activity requires the dashboard's GitHub token; the public measurements remain
available when that lookup fails.

Both follow [the dashboard's rules](../../packages/dashboard/README.md#philosophy-and-values):
they report on the system, they name tests, and nothing about either is
aggregated per person.

## The comment a run on the default branch leaves

Selection means some regressions land and the run on the default branch
catches them. When that happens, the change that caused it is told,
without anybody going looking.

`.github/workflows/pull-request-comments.yml` runs
`tasks/post-main-report.ts` in the base-repository context with a write
token. It follows the test workflow, because a `workflow_run` payload
describes the run it names and not the run that triggered it: a follower
of the relay would read the default branch and its tip whichever run's
records the relay had shipped. The repository squash-merges with the pull
request number in the subject, so the pull request behind a commit is
unambiguous; a commit pushed straight to the default branch has none, and
then nothing is posted.

Three runs are compared: the run at the commit, the run at the commit's
parent, and the pull request's own run. The two on the default branch are
read from their own `test-records-*` artifacts, which are readable the
moment a run ends where the store holds a run only once the relay has
shipped it — and two merges landing close together, which is the case
this exists for, is exactly when the earlier relay is still running.

The pull request's own run is read from the store instead, because the
relay is where the trust decision about it was made: it ships a fork run
only for a team member, and the store is what that decision produced.
Reading the run's own artifacts would go around that gate.

The previous run is asked for by the parent commit's name rather than
taken from a listing. Pushes to the default branch are not cancelled by
their successors, so two of them overlap whenever two merges land close
together, and the run before this one in a listing of finished runs can
be the run two commits back.

Every conclusion that leaves records counts, a run killed at its bound
included: that is the shape a hanging test takes, and every note needs
evidence rather than the absence of it. A run whose records cannot be
found is a run nothing is known about, not a run that skipped every test
it did not record — and a run one of whose artifacts could not be
downloaded is read as nothing at all, because a run read in part reads
as a run that ran less, and a report built on that would withdraw one an
earlier attempt correctly made.

A commit whose subject names a number that is not a pull request gets
nothing. An issue takes comments the same way a pull request does, so
the number is looked up before anything is written.

The comment carries up to seven notes, and it carries a note only when the
run found something the pull request's own run could not have found for
itself.

- **A test that failed for the first time at this commit.** Precisely
  that: it passed in the previous run on the default branch and failed in
  this one. A test that was already failing produces no note, which is
  what stops a break being attributed to whoever merged next. A test that
  both passed and failed at this commit produces no note either: that is
  the test disagreeing with itself, which the scorer calls flake evidence
  rather than a catch. Nor does a test the pull request's own run failed,
  because a failure that run reported is not something a later run found
  for it.
- **What the pull request's own run did with that test.** Its records say
  whether it ran the test, which is the only thing that settles it, and
  the manifest it resolved says why it did not. That manifest is the one current
  at the committer date of the commit the run tested: the merge commit its
  records name, never the branch's tip, since a manifest published between the
  two would explain a selection the lanes never made. Where the records name no
  single commit, or its date cannot be read, the note says the run did not run
  the test and gives no reason. The same holds for a pull request whose run did
  not run in lanes, since no manifest chose what it ran. Ran and passed is a flake or an interaction
  between changes. Withheld is the store holding the test back as too flaky to
  judge a change by. Not selected is the expected cost of selection: the
  coverage this design traded away, so nothing was missed. A test the packing
  reached, or one the store has never seen, with no record either way is a run
  that recorded less than it ran — a test job that fails before it uploads
  leaves its share behind like that — which is said in those words rather than
  as a test the run did not reach. And a test its run recorded a skip for, where
  no manifest says selection is why, is a test that skips itself under some
  condition.
- **A rise in the repository's uncovered-line count** of at least
  `COVERAGE_COMMENT_LINES`, measured between the run before the commit
  and the run at it, with the source groups the change touched that rose
  with it. Naming those is as near as this gets to saying where a test
  would go, and it is also what separates the part of the rise the
  change is behind from the part that is somewhere else. Never a
  failure, and never for one line. A change that touched no source at
  all is not asked about, because the repository-wide figure moves a
  little between runs on its own.
- **A rise in a measured set's number**, naming what let it past the
  coverage gate. As with the repository-wide figure, a change that
  touched no source at all is not asked about. The routes are: the
  member is on `EXCLUDED_FROM_COVERAGE_GATE`, so it carries no set; the
  change reached more measured sets than `LOCAL_COVERAGE_MAX_SETS`
  allows, so the gate did not run; the change did not touch the member,
  so the gate had nothing to compare; or the gate did measure the set
  and passed it, which means the two measurements disagree. Each calls
  for something different, which is why the note names it. The number is
  one member's source measured by one suite's tests alone, which a run
  measures whole however much of the corpus it ran. That is a different
  number from the source group over the same member, which is that
  member measured by every test in the run and which a selected run only
  samples; `coverageRecords` and `coverageFiguresOf` in
  `@commonfabric/test-support/records` are the one naming the producer and
  the reader share. The full run on the default branch is what publishes it.
- **A new test that turned out to be flaky.** A test this run ran, the
  previous run did not, and the store has never seen — that third
  condition is what stops a run that shipped part of its records making
  every test in the missing part look new — which passed and failed at
  this one commit, across the repeats a lane runs, across lanes and across
  attempts.
- **A test too flaky for a change that failed every one of its runs at this
  commit and passed every one at the parent.** Those failures do not fail the
  run, so the lane's job summary is the only other place they appear, and nobody
  reads the summary of a run that passed. It says the test is a known flaky one
  and that this run did not fail because of it, and that one bad runner produces
  the same record, since every run of a test at a commit shares a lane. It gives
  how many runs failed at the commit and passed at the parent, and the store's
  flake counts for the test. Such a test is not also listed as a first failure.
  Which failures a run excused is a fact about that run: a lane excuses a flaky
  test's failure only where its batch accounted for every identity it was asked
  to run, and a run that did not apply the rule excused nothing. The lanes
  record each identity they excused, and the report reads those records one
  artifact at a time. Each `test-records-tests-<lane>-a<attempt>` artifact
  holds one lane's attempt. An identity counts as excused only where every
  artifact that failed it also excused it, since an attempt that failed it
  without excusing it failed the run. The manifest supplies only the store's flake counts, and a
  report that cannot read it gives the note without them.
- **A rename that discarded history**, with the number of catches it
  would bring back and the line to append under
  `tasks/test-identity-aliases/`. Four things have to hold: the
  departing test caught something; the unit it lived in produced records
  in this run, so its absence is a test that left rather than a suite
  that did not run; the arriving name is one the store has never seen;
  and the pairing is clear — alike past `RENAME_SIMILARITY`, ahead of
  every other candidate by `RENAME_MARGIN`, and pointed at by no other
  departure. Alikeness is the lower of two comparisons, one over the
  groups a name is nested under and one over the part that is the test's
  own, because either alone answers a different question: two tests under
  one group share the whole chain, and two tests under different groups
  routinely share a leaf. At most `RENAME_SUGGESTIONS` are offered. A rename is never inferred, so this
  is a suggestion: append the line if the pairing is right, and ignore it
  if it is not.

Five properties keep this on the right side of
[the dashboard's rule](../../packages/dashboard/README.md#philosophy-and-values)
that reporting is about the system and never about individuals. The
comment's subject is a commit and a test, and no author is named. Nothing
is counted per author, per team, or per anything, and no history is kept:
each comment is a pure function of one run, and no tile, report or query
rolls them up. A test the selector declined to run is described as
coverage this design traded away, because the author did not miss it. A
test the store has seen disagreeing with itself is labelled as one, with
the counts behind the label rather than a figure to be taken on trust.
And the comment is edited in place rather than repeated, which the hidden marker
at the top makes possible; a later attempt that finds nothing withdraws
what an earlier one said.

If it ever stops being all five of those, it should be removed rather
than tuned.

Nothing gates on it. The reporter is best-effort throughout: a failure
becomes a warning annotation on the run and the workflow stays green,
because a comment nobody gates on must never turn a run red, and least of
all a run that has already passed. It reads two runs' worth of record
artifacts, so it takes minutes; nothing waits on it.

To see what it would say about a run, set `MAIN_REPORT_RUN_ID` to that
run and pass `--dry-run`, which posts nothing.

## Units that run whole

An invocation unit is usually one test file. A lane that wants part of
one registers the rest of the file's tests as ignored.

Some units hold more than one test and cannot be split. These are a
workspace member whose test task takes no file list, a member's browser
half, the reload suite's directory, and a section of the FUSE
integration script. A lane that asks for one test of such a unit runs
every test in it.

Each suite lists these units in `whole`, and a lane writes no skip list
for one. Most units in `whole` hold a single identity, such as a gate, a
type-check group, a binary build, one pattern's check, or one vintage
fixture's replay. Only the four kinds above hold several. A unit's shape
does not tell you which kind it is, because two of the four kinds are
paths.

The packer places each such unit as one choice. `plan()` in
`tasks/test-selection/plan.ts` merges the unit's tests into one choice
before it packs. That choice costs what all the tests cost together, and
it is held back when any of them is. The plan it writes lists the tests
again in place of the merged choice. The merge exists only inside
`plan()`. The manifest, the records, and the plan all name tests, so
anything that matches a record against the manifest or a plan finds the
test by its own name.

A change to such a member's source could make its unit mandatory only
through the coverage gate, and none of these units has a measured set
there: `packages/identity` because
[the coverage gate excludes it](#the-coverage-gate), and the five
browser halves because a measured set holds only a member's Deno-only
half. No diff names a directory, so these units reach a lane only on the
score of their tests.

A workspace member stops running whole when the task holding its tests
becomes one the topology can point at files. That task is its
`deno-test`, or its `test` if it defines no `deno-test`. The topology can
point a single `deno test` at files, and also a dependency list that
resolves to one, or the batch runner around one. It cannot point a task that
joins commands with a shell operator such as `&&`, a task that names its own
import map, or a test runner of the package's own.

A lane runs a member that runs whole through the member's own task,
with no record preload and no report path. A `deno test` that task
starts records nothing there, unless a runner of the member's own
writes records. The topology therefore refuses to load when it cannot
point a member's task at files, unless `RUNS_WHOLE` in
`tasks/test-topology/unit.ts` lists the member with the reason. It also
refuses an entry there for a member whose task it can point at files,
and an entry for a member the workspace does not hold.

The batch runner, `tasks/run-test-batches.ts`, is how a member whose files need
different flags stays splittable. Its `--serial` option names files that cannot
run beside another test file in one process, and those run in a `deno test`
without `--parallel`, one file at a time. Its `--all-access` option names files
that need every permission, and those run under `--allow-all`. The runner runs
each group as a `deno test` of its own and merges their JUnit reports into the
one path it was handed. A lane groups the files it selects the same way, with a
report for each group. The topology refuses a `--serial` or `--all-access`
pattern that names no test file, and so does the runner, which also refuses such
an `--ignore`. `packages/cli` uses both options, and `packages/dashboard` uses
`--all-access`.

## A case that fails only when its siblings do not run

A lane runs part of a file: the cases it holds run, and the registration
preload registers the rest as ignored. So a case that passes in a
full-file run and fails when a lane selects it on its own is reading
state that another case in the same file establishes — a process-wide
initialization, a global something else installs, a cache another case
fills. The selection that dropped the other case dropped the setup with
it.

`CF_TEST_SKIP_LIST` reproduces such a selection locally.
[The record guide](test-records.md#the-environment-surface) describes the
variable; the file it names is keyed by repository-relative test file and
holds the names this invocation is not to run. A name is a case's whole
`describe` chain, joined with ` > `, which is the name the report carries.
A file whose hooks sit outside every `describe` has a root suite the bdd
runner invents, named `global`, and every name in that file opens with
it. A name that matches nothing is skipped over in silence, so a case
that goes on running is as likely to be a misspelled name as an
independent case:

```json
{
  "packages/donut/test/glaze.test.ts": [
    "glazing a donut > takes the sugar ratio from the flavor"
  ]
}
```

`packages/test-support/src/records/preload.ts` is what reads the list, so
the invocation adds it to whatever preloads and variables the package's
own test task already passes, and runs from that package's directory.
Deno resolves `--preload` as a path rather than through the import map,
so it is absolute:

```bash
CF_TEST_SKIP_LIST=/tmp/skips.json deno test --no-check --allow-all \
  --preload="$(git rev-parse --show-toplevel)/packages/test-support/src/records/preload.ts" \
  test/glaze.test.ts
```

Running each case of a file alone, with every other case in it skipped,
is what settles whether the file holds more of them.

## Telling the machinery about a new test

Nothing, in the ordinary case. A test added to an existing suite is
recorded by that suite's runner, and an identity with no history is
mandatory until a run on the default branch records it, so a new test runs
before anything knows what it is worth.

Two things are worth knowing while writing one, and both are consequences
of the identity being the reported name:

- Prefer stable, content-derived wording over positional counters or
  interpolated identifiers, which mint a new identity every time they
  shift.
- A rename splits history unless a line is appended under
  `tasks/test-identity-aliases/`. Most renames cost nothing, because
  most tests have never caught anything; a rename of a test that has is
  worth the line.

Until a run records it, a new test file is charged what
[`standIn`](../../tasks/test-selection/census.ts) works out from the
measured units of the suite around it: the larger of their mean and their
ninetieth percentile. That is deliberately above what most units of a
suite cost, since a lane packed under what its work takes is one that runs past
its bound, where one packed over it finishes early. A change adding many files
at once therefore reads as filling a lane well before it does, and the lane
summary says how many seconds of its projection stand on units nothing has
measured.

A new test *surface* — a new script, harness, or kind of test — is a new suite
in `tasks/test-topology/`, never a new job, and [the record
guide](test-records.md#covering-a-new-test-surface) covers the wiring.
