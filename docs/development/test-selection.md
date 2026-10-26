# Test selection

How to use the machinery that decides what a change's tests are worth
running, and how to answer the question it provokes most often, which is
"why did my test not run?". [The spec](../specs/test-selection.md) is the
normative description of the contract, and [the archived
plan](../history/plans/pull-request-test-selection.md) records the
reasoning behind the design.

Five things read a published manifest: the lanes that run every test in
continuous integration, the coverage gate, the comment a run on the default
branch leaves, the dashboard, and the read-only commands in [The
modes](#the-modes). [How continuous integration runs the
lanes](#how-continuous-integration-runs-the-lanes) says which lanes a run takes.

Every local query about test selection goes through one entry point:

```
deno task test-selection <mode>
```

Every mode that reads a manifest, apart from `health`, reads the one the
lanes testing the checked-out commit read: the newest the store had created
at or before that commit's committer date, resolved by the same code a lane
resolves it with. [The spec](../specs/test-selection.md#determinism) says why a lane
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
score and its cost, the new real test failures behind that score and how
many distinct sources they came from, when the most recent one was, its
churn and flake rate, whether the manifest withholds it, how many times it
would run, and whether a lane testing this commit reaches it when the change
touches nothing, which is the plan `plan --dry-run` prints. An identity the
store has never seen is reported as mandatory, which is what an identity
with no history is.

Each of those is printed on its own, because they are not alternatives: a
withheld identity a change reaches runs anyway, so an answer that picked
one of them would be leaving out something true.

The identity resolves through `tasks/test-identity-aliases/` first,
so asking about a renamed test under either name finds the joined history.

### `dials`

Every number that decides what selection does or reports, with the unit its
value counts, whether it is chosen or derived, and which way you would move
it.
[Every dial](#every-dial) lists them.

### `coverage`

Every measured set — one suite's units over one workspace member's lines — with
how many units it holds, its baseline, and its gate's score, and then every
workspace member that carries no set, with the reason. Of the baselines this
commit's manifest holds for a set, the one shown is the one measured at the
newest default-branch commit the checkout contains. That is the one the coverage
gate compares this commit against on a pull request, since the gate resolves its
manifest at the commit's moment too and chooses among its baselines the same
way. On `main` a gate compares against its parent commit's own run first, and
the manifest only where that run gives no figure. This is what
answers "why is my package not gated?" and "what am I being compared against?".

A member with two measured sets has two lines and two baselines. The
counts are never added together: a line one suite's tests cover says
nothing about whether another suite's do.

Where it resolves a manifest, it then prints what the measured sets cost with
coverage on. These are the lines [the publisher's
summary](#what-measured-sets-cost-with-coverage-on) carries, without the
`test selection: ` prefix the publisher puts on each one.

### `health`

Whether the cost model the lanes are packed by still describes what they
spend. It reads the newest manifest, not the commit's, because what it
judges is the model lanes are packing by now, and `--at` names another
moment instead. It prints each suite's fixed charge, its tests too long for
any lane, and what its batches spent over what they were charged, then how
many lanes ran past their bound, and then either that the model holds or
each thing that broke, naming the suite and the figure. It exits 1 where
anything broke, and where it could not read a manifest to judge. [When the
cost model breaks](#when-the-cost-model-breaks) says what it looks at and what
to do.

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
per-unit charge and capability setup together pass a lane's budget
before it runs anything. Such a suite takes a whole lane for
each identity it can still place, and one where no lane can hold any of
them places none at all. That line is what answers "why is a lane holding one test?" and
"why did none of this suite run?".

A suite that holds nothing has its identities left out of the list
beneath it, since the suite's line says what naming each of them would.
A suite that holds some of them keeps the rest in that list, because what
puts one of those past the bound is its own time on top of the charge and
the charge alone does not say which. The count beside the suite is of
what it can still run, so the two never disagree about the same test.

`--verify` compares the units the topology enumerates against the identities
this commit's manifest holds, in both directions. A unit the manifest holds
nothing for is one a lane has only a stand-in for, and `--verify` fails on any.
A coverage gate the manifest holds nothing for fails it too, and is reported as
offered at the floor of the score, since no lane runs a gate and its first
record comes from the default branch. A manifest entry naming a unit the tree no
longer enumerates is reported without failing, because a manifest is hours old
and a unit deleted since it was published is expected to linger in it. A unit
the configuration declares unavailable is passed over, since nothing runs it.

### How many lanes a run uses

The number of lanes a run takes depends on how much work it has, and the
job matrix has to exist before any lane starts. So one job asks, for a
change:

```
deno run -A tasks/ci-lane.ts --lane-count --base <ref> [--label <name>]...
```

and for the run on the default branch:

```
deno run -A tasks/ci-lane.ts --lane-count --full
```

It answers on its standard output with one line of JSON and nothing else:
the count as `of`, and as `args` the arguments every lane takes besides its
own number, which are `--full`, or the base and the scale. On its error
stream and in the job summary it also gives what each lane of that count is
projected to take, both its work and the whole job with the prologue. It
packs those lanes the way the lanes will pack themselves, so the table is
what each lane projects for itself. The lanes then read the same tree
against the same manifest and work out their own shares. What travels
through job outputs is only the count and those arguments, never which lane
runs which test. A lane run without `--of`, as on a workstation, counts its
run's lanes the same way.

A change's tests have two parts: the work its change makes mandatory, and
`DISCRETIONARY_SECONDS` of tests chosen by score, which the value, density
and exploration passes share. The count is the fewest lanes at which a
bisection, described below, finds that the plan holds both. A plan holds
the mandatory work where nothing mandatory overflows: an identity overflows
when no lane can hold even one run of it and no lane is empty to run it
alone. It holds the tests chosen by score where the room the mandatory pass
leaves below the lanes' budgets, added up over the lanes, is at least
`DISCRETIONARY_SECONDS`. A target larger than what one lane holding every
test the passes could choose would be charged needs no more room than that,
so a large scale opens no lanes that nothing could fill.
So a change that forces a great deal of work in takes more lanes, and still
runs the tests chosen by score. A change with nothing mandatory takes the
fewest lanes that hold `DISCRETIONARY_SECONDS`, which is three. The passes
spend the target and no more however many lanes there are, and less where
`LANES_MAX` leaves them less room.

The run on the default branch has no tests chosen by score, since it runs
everything, so its count is the fewest lanes at which nothing overflows.
Unless the cap holds a run back, every mandatory identity either fits inside
a lane's budget or runs alone, and the only lanes past their budget each
hold one test that no number of lanes would bring under it. A repeated
identity with room for some of its runs but not all runs fewer times, which
is not an overflow.

Each count is judged by its own packing alone. Adding up how far the lanes
run past their budget would not do, because that total does not fall
steadily as lanes are added: while every lane is crowded, work that fits
nowhere goes to the shortest lane and opens its suite there again, which
can cost more than the budget the added lane brings. A search stopping
where the total first stops falling can stop at half the lanes the run
needs, and a count far short of the run's needs can show a smaller total
than one close to it, so no total measured at one count says what another
count would achieve.

The search is a bisection between one lane and `LANES_MAX`, so it packs a
handful of counts and none past the cap. Each count it tries is packed
through the mandatory pass only, since that settles whether the count holds
the run. It relies on an added lane not making anything overflow that did
not before, nor leaving less room. Where the packing breaks that, the count
can be more lanes than the run needs, but never fewer: every count it
settles on below the cap is one it saw hold the run.

Run it yourself to see how many jobs a change or the default branch would
take. Where nothing in the tree has a measured cost it answers from the
shape of the tree instead — the larger of the number of suites with
anything to run and what packing the stand-ins asks for — and says on the
error stream that it did so, since a projection from costs nobody has
measured would be arithmetic over an invented figure.

Whichever way it gets its answer, it answers no more than `LANES_MAX`, so
that one run leaves runners for the runs waiting behind it. A run that needs
more takes that many and says on the error stream that it needs more. A
change's tests chosen by score then get what room is left, which it also
says. In the run on the default branch every test still runs. A test whose
repeated runs fit in no lane runs fewer times, down to once, and a test
that fits nowhere even once goes into the lane it leaves shortest, so the
lanes run past their budget instead. A full run that needs more is the sign
to raise `LANES_MAX`.

## How continuous integration runs the lanes

`.github/workflows/deno.yml` runs every test through `tasks/ci-lane.ts` and
names no suite. Adding a test, a kind of test, or a configuration of existing
tests is a change to the topology, `tasks/test-topology.ts`, and never to the
workflow. A run's lanes come from two jobs.

- **`plan`** runs first in every run. On a pull request it checks out the
  whole history, since the change is the diff against the merge base, and
  runs `tasks/ci-lane.ts --lane-count --base origin/<base>` with a `--label`
  for each label the pull request carries. On a push to the default branch,
  and on a run `.github/workflows/test-order-tomorrow.yml` calls, it runs
  `tasks/ci-lane.ts --lane-count --full`. It writes the count as its `of`
  output, the list of lane numbers from one to that count as its `lanes`
  output, and the lanes' arguments as its `args` output. A label the count
  cannot read fails it, and with it the run.
- **`tests`** runs every lane, once `plan` has succeeded. It takes its matrix
  from `lanes`. Each of its jobs is named `Tests (N/M)`, where `M` is `of`.
  Each runs `deno run -A tasks/ci-lane.ts --lane N --of M` with `plan`'s
  `args`. A lane packs the same plan from the manifest and the tree as every
  other lane of its run, and runs its own share of it.
- Each job of `tests` plans before it runs. Its `🗺️ Plan the lane` step runs
  the lane with `--dry-run`, which prints the lane's share, what it is
  projected to take, and what was withheld, in a step of their own. The
  withheld table says of each identity whether it ran anyway because the
  change reaches it. GitHub folds away the top of a step thousands of
  lines long, which is what the lane's own step becomes, so a plan printed
  there is hidden from anyone watching the job. `🧪 Run the lane` then
  runs the lane with `--described`. That packs the same plan again, since the tree and the manifest have not
  changed, and names it in one line: its batches, what it is projected to
  take, and the manifest it was packed against. It then prints a line as it
  begins to open each capability, one just before each command that setup
  runs, one once each capability has opened, and one as each batch starts.
  Setup captures its commands' output, so in a lane that stops without saying
  why, the last of these lines names the step it stopped in.
- The lane replaces the shell of `🧪 Run the lane` rather than running under
  it. GitHub stops a step that reaches its bound by sending SIGINT to the
  step's own process, and SIGTERM a few seconds later, and a shell waiting on a
  command passes neither on. The lane passes each signal on to the command it
  is running and starts nothing more, a rerun included. `deno test` told to stop names the tests
  it was in the middle of and writes its report, so the lane keeps the records
  of the tests it finished, and the test that held it up is recorded as skipped:
  a cancelled run sends the same signal, and a test it interrupts has not
  failed. A test `deno test` reports as cancelled in a run the lane did not
  signal is one an error it did not catch stopped, and is recorded as failed.
  The lane then prints the end of each server's log, keeps its working
  directory for the upload of what a failing lane left behind, and exits
  without converting its coverage, which takes longer than GitHub waits.

Only the `🧪 Run the lane` step is given `GITHUB_TOKEN` in its
environment, and `tasks/ci-workflow.test.ts` fails a lane job in which the
job or any other step is. The
lane takes `GITHUB_TOKEN` and `GH_TOKEN` out of its own environment before it
reads, plans, or opens anything, so no child it starts inherits them. A suite
that asks the GitHub API anything declares the `github-api` capability, which
hands the token back to that suite's commands and to no others.

A lane gathers each execution of a batch into a spool and output paths of its
own. Where the batch's suite declares a variant, every record from it takes
that variant, replacing any a producer wrote. The shipping step therefore takes
no `variant`. A record whose kind and scope are outside the suite's record
surfaces, or that carries a variant in a batch of a default suite, is kept as
written and named in the lane's summary. It does not fail the batch, since the
tests it came with either passed or did not. The record then belongs to no
suite, and the store half of `check-test-topology` in `Status` fails on it.

So every run's lanes wait for the count. Whether a run runs every test, and
how much a pull request chooses by score, is decided in one place, the count.

A pull request's labels say how much it runs:

- No label beginning `ci:` runs the work the change makes mandatory and
  `DISCRETIONARY_SECONDS` of tests chosen by score.
- `ci: <n>x`, where `<n>` is a non-negative decimal such as `2`, `2.5`,
  `0.1` or `.5`, runs the mandatory work and `n` times `DISCRETIONARY_SECONDS`
  of tests chosen by score, over as many lanes as that takes. `ci: 0x` runs
  the mandatory work and nothing chosen by score, in the fewest lanes that
  hold it, which is one lane where nothing is mandatory. `ci: 1x` is the
  same as no label.
- `ci: full` runs everything. It is the value of `FULL_RUN_LABEL` in
  `tasks/test-selection/policy.ts`. The lanes run every test as the run on
  the default branch does, so a test too flaky for a change runs as many
  times as its share asks for and its failures do not fail the pull
  request. A change that fixes such a test therefore gets no gating run of
  it under the label; without the label, the change reaching the test makes
  it mandatory and gating.

Every label beginning `ci:`, however it is spelled or capitalized, must be
one of these, and a pull request may carry only one of them. A label such as
`ci: 2`, `CI: 2x` or `ci: fast`, or two such labels even where they agree,
fails `plan` with an error naming them, before any lane starts. Labels
outside that namespace are ignored. The scale the count settled on is among
the arguments it hands the lanes, which each lane's job log shows as
`LANE_ARGS`.

The workflow runs when a label is added to or removed from a pull request, so
adding or removing one starts a run that reads the labels the pull request
then carries. Any other label starts one too. A re-run reads the labels of the
event it repeats, so it does not see a label changed since. A re-run of the
lanes alone reuses the count and arguments `plan` gave the first attempt.

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
holds `coverage/`: each report at
`lcov/sets/<suite>/<member>/coverage.lcov`, where a `/` in the member's path is
written `__`, the file saying whether the compile cache was restored, and the
markers beside the reports of measured sets the lane saw fail. In the full run
it also holds the authored-pattern reports under
`lcov/pattern-runtime/<suite>`. The raw profiles the reports are converted
from stay behind in `coverage-raw/`, outside the uploaded directory, because
the upload walks every directory under its path.
`test-records-tests-<lane>-a<attempt>` holds its test records.

The lane step is bounded at 60 minutes and its job at 70, by the lane job's own
pair of timeout anchors, above the full run's thirty-minute lane bound. Those
only stop a lane that hangs, and a pull request's lanes, which are instances of
the same job definition, wait as long before one is stopped. The budget a lane
packs against is derived from `LANE_BOUND_SECONDS` for a pull request and
`FULL_LANE_BOUND_SECONDS` for the full run. Neither is a bound a lane is stopped
at. A lane whose mandatory work passes its budget runs long rather than being
stopped with its later batches unrun, and its job log says how far its plan was
projected past the budget.

**`Status`** is the job a pull request requires. It runs on a pull request and
on a push once `plan` and `tests` have finished, whether they passed or
failed, and not in a run that was cancelled. It reads what every lane uploaded:

1. It holds the run's records to the topology: `deno task check-test-topology
   --commit "$GITHUB_SHA" --records test-records-artifacts`, which fails a
   recorded test that no suite of the topology claims. The download holds the
   artifacts of every attempt at the run, and the check reads only each job's
   latest attempt, so re-running a lane replaces what an earlier attempt at it
   recorded.
2. It judges [the coverage gates](#the-coverage-gate) the lanes' plan chose,
   over every lane's coverage reports, and records each one. On a pull request
   it reads the pull request's description as it stands, through the API, and
   uploads the comment the gates want posted as the `coverage-comment`
   artifact. On a push it reads the description of the pull request the push
   merged, and where it cannot, it warns and accepts no rise. Where `tests` did
   not succeed, it passes `--tests-failed`, and the gates report rather than
   gate.
3. On a push, it measures the run's coverage with `tasks/coverage-report.ts`.
   It ships the gates' records, and on a push the measurements beside them, to
   the record store.
4. It fails unless every job it waited for succeeded or was skipped, and
   `tests` succeeded. A run whose lanes were skipped would otherwise pass having
   run no test.

A run the next day's test-order workflow calls runs no `Status`, since the
commit's own run already covers it.

On a push, the jobs that build the `toolshed` and `cf` binaries run beside the
lanes. `attest-binaries` waits for both builds and for `tests`, and
`deploy-shell-staging` waits for `tests`, so nothing is attested or published
until every test has passed. Rapids server deployment follows the coordinated
infra candidate through `rapids-release.yml`; see
[deploying](deploying.md#coordinated-rapids-releases). A pull request builds
nothing there: the `binaries` suites compile each
binary as a test that it still compiles. The servers the full run's lanes start
are built by the lanes, from the same sources and the same build task, without
the commit and the shell endpoints the release binaries carry; the jobs that
build the release binaries check what those add.

## The coverage gate

A **measured set** is one suite's units over one workspace member's lines.
`deno task test-selection coverage` lists them.

Each set has a **coverage gate**: a test of its own, of kind `gate`, owned by
the set's member and named for its suite, such as `["gate", "memory",
"coverage-gate workspace-unit"]`. The gates make up the `coverage-gate` suite of
the topology, one unit per set. No lane runs a gate. Running one means running
every unit of its set with coverage turned on, which the lanes do, and judging
what they measured, which `Status`, the job that joins the lanes, does.

A change that touches a member's tree reaches its set, and that makes the set's
gate one the plan may choose. It is chosen by its score, in the same passes as
any test, and nothing forces it in. Choosing it places every identity of the
set's units in whatever lanes hold them, inside the pass's share of the run's
budget and charged what they add, or places nothing where the whole set does
not fit. A test of the set the change edited runs anyway, so a gate whose whole
set already runs costs nothing more. How often each identity runs is unchanged:
one its flake rate says to repeat is still repeated, and the repeats leave the
set's number where it was, since a coverage count is the union over what the
runs reached. A gate whose set the change does not reach is never chosen, except
by a run of every test, which chooses every gate, and `explain` on a gate's
identity says whether the plan chose it.

`Status` packs the plan the lanes packed, from the same tree and manifest and
the lane count and arguments `plan` handed them, to learn which gates they
chose. For each one, it adds up what the lanes measured
for its set, scores the set over its member's own source, and compares that
against what the same set measured at the newest `main` commit the branch
contains. On a pull request the baselines come from the manifest current at the
commit under test; on `main`, from the parent commit's own run, as below. A rise
is a failure of the gate, and on a pull request a failing gate whose set the
change reaches fails the run. It is the only coverage check that fails anything.
A gate the change reached and the plan did not choose is listed as not measured,
and fails nothing.

`Status` records every gate it judged, as a test record under the gate's
identity, so the publisher scores it as it scores any test: a rise no acceptance
covers is a failure, a comparison that found none is a pass, and every other
verdict, an accepted rise among them, is a skip. On `main` a gate compares a
commit against its parent's figure alone, read from the parent's own push run
once that run's Status job has uploaded it, and from the manifest otherwise. A
gate that has caught rises scores higher, and is chosen more often.

Run it yourself the way `Status` does:

```
deno run -A tasks/coverage-gate.ts --base origin/main --reports <directory> \
  [--full | --scale <n>] [--of <lanes>] [--body <description>] \
  [--tests-failed] [--comment <file> --pr <number>]
deno run -A tasks/coverage-gate.ts --full --default-branch [--of <lanes>] \
  --reports <directory> [--body <description>] [--tests-failed]
```

where the directory holds the lanes' uploaded coverage. The first is a pull
request's, and `--full` says its run ran every test, which chooses every gate.
`--of` and `--scale` are the lane count and the scale `plan` handed the lanes,
which `Status` passes on so that it packs the plan they packed; without them it
counts the lanes the way `plan` does, at a scale of one.
The second is a push's, and reads the parent commit's run through GitHub's API,
which takes `GITHUB_TOKEN`. It prints a row per set — the baseline, this run's
count, the change, and the outcome — and stops with a non-zero status where a
gate fails the run. With `CF_TEST_RECORDS_DIR` naming a spool, it writes each
gate's record there. `--body` is the description acceptances are read from.
`Status` reads a pull request's description through the API rather than from
the event that started the run. A re-run repeats that event, so reading the
description as it stands is what makes an acceptance written after the push
count on a re-run. A description `Status` cannot read fails the step. `Status`
passes `--tests-failed` when `tests`, the job that runs the lanes, did not
succeed.

The gate never reads which gates were chosen from what a lane reported, so a
lane cannot make it judge a set or skip one. On a pull request it fails where it
cannot read the store, since it cannot then pack the plan the lanes packed. A
set that rose is reported as a coverage failure rather than a test failure.

The gate asks git which of the baselines' commits the branch contains, so the
checkout it runs in needs the whole history. A checkout too shallow to reach
any of them reports every set it scores as having no baseline, which passes
those sets without comparing them. `Status` checks out with `fetch-depth: 0`, and
`tasks/ci-workflow.test.ts` holds it to that.

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
- **Any line the set's tests newly cover lowers its count.** Cover the new
  code where possible. Where some of it cannot be covered, write tests in the
  same suite for other uncovered lines of the same member instead.
- **An
  [`ACCEPT_COVERAGE_DEBT` marker](COVERAGE.md#the-measured-set-gate-and-accepting-debt)
  naming anything but a workspace member fails the gate.** Nothing consults it, so a marker naming a source group
  such as `packages/connectors`, which holds members but is none, would
  otherwise pass for one that worked. The gate lists the names it did not
  recognize.
- **A pull request labelled `ci: full` runs every gate.** Those whose sets
  the change reaches can fail it. The rest are judged and recorded, and a rise
  in one of them fails nothing.
- **A run with a failing test reports rather than gates every set a
  lane's report measured**, and so does a set a lane measured through a
  failure the run excused. Coverage measured through a failure says nothing
  about whether the change was tested, and the failing test is what to fix.
- **A chosen gate whose set no lane's report measured fails**, in a run with
  a failing test as in any other, where the change reaches its set. That is a
  set no lane reported, or one whose reports name no line of its member; a
  set's tests always load some of their own member's source, so an empty
  report measured nothing rather than covering nothing. The plan chose to
  measure that set, and a lane that stopped before writing its report, an
  upload that carried nothing, a download that found nothing, and a lane that
  wrote an empty report all arrive at the gate looking the same. The row says
  a rise cannot be ruled out, and the gate's record is a skip.

Nothing about coverage fails a run on `main`. That run judges every gate and
records what each found, a rise as a failure, so that a gate's score counts the
rises it has seen; it reads the description of the pull request the push
merged, so a rise that pull request accepted is not recorded as a failure. It
measures every set, which is where the baselines come from, and merges every
report into the repository-wide figure the dashboard tile shows. That figure is
a trend and fails nothing. `Status` measures both on a push with
`tasks/coverage-report.ts`, over a directory holding the lanes' uploaded
coverage:

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
test's score and `FILL_DENSITY_SHARE` is a share of the discretionary
target. A share of an item's runs reads the same way again. Naming the unit is what
keeps them from being compared to each other.

The **Set by** column separates two kinds. A **chosen** value is a
decision somebody made, and editing it is how the decision changes. A
**derived** value is computed from other dials and has no expression of
its own to edit: each lane budget is its run's bound less the prologue and
the safety margin, so a budget that does not fit inside its own bound
cannot be written down. The distinction matters because the two look
identical in a source file, and somebody who tries to tune a derived value
is editing a line that is not there.

More numbers come from measurement, and they are not in the table
because they are not in `policy.ts`: `setupCost` for each capability, for
each suite `overhead`, `correction` and `unitOverhead`, and for each unit
lanes have measured hooks for, what those hooks take, in the suite's
`unitHooks`. The setups and the hooks are read off the lanes' own timing
records, the rest are fitted to them,
and all of them are published in the manifest, one set per publisher run,
which is where to read them.
Nothing hand-edits them, and a manifest carrying a strange one is a
measurement to look at rather than a setting to fix.

| Dial | Default | Units | Set by | Why you would move it, and which way |
| --- | --- | --- | --- | --- |
| `LANE_BOUND_SECONDS` | 300 | seconds | chosen | Up when more should fit in a lane; down when five minutes is longer than anybody will wait for a first answer. It sets what a lane packs against, not the workflow's step timeout, which only stops a lane that hangs. |
| `LANE_PROLOGUE_SECONDS` | 40 | seconds | chosen | Up when checkout, setup, and cache restore take longer than this and eat into the safety margin; down when they take less. Nothing measures it. |
| `LANE_SAFETY_SECONDS` | 30 | seconds | chosen | Up when lanes overrun their bound on slow runners; down when they finish early every time and the headroom is buying nothing. |
| `LANE_BUDGET_SECONDS` | 230 | seconds | derived | Nothing edits this. It is the bound less the prologue and the safety margin, so a budget that does not fit inside its own bound cannot be written down. |
| `FULL_LANE_BOUND_SECONDS` | 1800 | seconds | chosen | Up when the run on `main` uses more jobs than it needs; down when `main` takes too long to say something broke. |
| `FULL_LANE_BUDGET_SECONDS` | 1730 | seconds | derived | Nothing edits this. It is the full run's bound less the same prologue and safety margin a pull request's lane pays, since a lane of either run is the same job doing the same setup on the same runner. |
| `DISCRETIONARY_SECONDS` | 575 | seconds | chosen | Up when regressions reach the default branch past pull requests that did not run the test chosen by score that would have caught them; down when pull requests take more lanes than runner minutes allow. A pull request whose mandatory work fits in five lanes with room to spare most often takes five at this figure. The label `ci: <n>x` multiplies it by n for one pull request. |
| `LANES_MAX` | 30 | lanes | chosen | Up when the lane-count job says a run needs more lanes than this, and the organization's runner limit has room; down when one run crowds out the runs behind it. A run needing more lanes than this takes this many: a pull request then runs fewer tests chosen by score, and any run's mandatory work may put its lanes past their budget. |
| `FULL_RUN_LABEL` | ci: full | a label | chosen | Not a quantity. Change it only if the label collides with one the repository already uses for something else. |
| `UNMEASURED_COST_SECONDS` | 1 | seconds | chosen | Up when a lane holding new tests runs long; down when it finishes early. It is reached for only by a suite with no measured unit at all, since a suite that has any charges an unmeasured one the larger of its units' mean and their ninetieth percentile. |
| `VALUE_FLOOR` | 0.05 | score | chosen | Up when the cheap tail is not being swept up; down when it crowds out tests with a record of new real test failures. |
| `WEIGHT_PROVEN` | 0.55 | share of the score | chosen | Up when a record of new real test failures should count for more. The three weights are shares of one score, so what this gains the other two lose. |
| `WEIGHT_BREADTH` | 0.25 | share of the score | chosen | Up when a test that several distinct sources have hit should count for more; down when breadth is mostly telling you about the environment rather than the test. |
| `WEIGHT_CHURN` | 0.15 | share of the score | chosen | Up when something going wrong right now should jump the queue faster; down when the queue keeps being jumped by noise. |
| `PROVEN_SATURATION` | 2 | new real test failures | chosen | Where the `proven` term reaches half its ceiling. Up when the term should go on telling eight new real test failures from four; down when one new real test failure should already be worth nearly everything a test can earn. |
| `FRESHNESS_HALF_LIFE_DAYS` | 120 | days | chosen | Up when new real test failures should keep more of their value as they age; down when a test that had a new real test failure a year ago crowds out one that had one last week. |
| `FRESHNESS_FLOOR` | 0.3 | multiplier | chosen | Up when a very old new real test failure should keep more of its worth; down when age should be allowed to retire one almost completely. |
| `NEW_REAL_TEST_FAILURE_WEIGHT_LOCAL` | 2 | multiplier | chosen | Up when evidence from a workstation should count for more; down if local records ever arrive in volume and stop being the scarce signal they are today. |
| `NEW_REAL_TEST_FAILURE_WEIGHT_PR` | 1 | multiplier | chosen | Neither. It is the unit the other two are expressed against, so move those instead. |
| `NEW_REAL_TEST_FAILURE_WEIGHT_MAIN` | 1.5 | multiplier | chosen | Up when an escape should pull harder on what gets selected next; down when the failures on `main` are mostly environmental rather than real. |
| `BREADTH_SATURATION` | 2 | sources | chosen | Where the `breadth` term reaches half its ceiling. Up when the term should go on telling eight sources from four; down when one source should already be worth nearly all it can give. |
| `ENVIRONMENTAL_MIN_SOURCES` | 5 | sources | chosen | How many distinct sources a failure must span inside `NEW_REAL_TEST_FAILURE_BREADTH_WINDOW_DAYS` before it reads as the environment. Up when a genuinely broad regression is written off; down when a broken runner's failures still count as new real test failures. |
| `MASS_FAILURE_MIN_IDENTITIES` | 50 | identities | chosen | How many identities one run must newly break before none of those failures is a new real test failure. Up when a breakage that reached many tests still escaped the pull requests that ran some of them; down when one broken run still credits a new real test failure to a whole suite. |
| `CHURN_HALF_LIFE_DAYS` | 14 | days | chosen | Up when recent trouble should stay relevant for longer; down when a problem already fixed keeps its tests selected for weeks afterwards. |
| `CHURN_WINDOW_DAYS` | 60 | days | chosen | How far back the decayed counts are read. Past this the weight is under one part in sixteen, so moving it is a performance decision rather than a policy one. |
| `FLAKE_HALF_LIFE_RUNS` | 200 | runs | chosen | How many runs without disagreeing halve what a disagreement counts for. It is also how much evidence the share is measured over, so far below one over `FLAKE_EXCLUSION_RATE` the share swings about on too little: up when it does; down when a test that has plainly settled is still judged by what it did. |
| `FLAKE_WINDOW_DAYS` | 60 | days | chosen | How far back the counts are read at all. The weight decays by runs rather than by days, so this bounds what is remembered rather than marking where the weight has faded: a test that runs rarely can still be carrying weight when its days fall off the end. |
| `COST_WINDOW_DAYS` | 7 | days | chosen | Up when cost estimates are noisy; down when durations drift with the code or the runner image faster than the estimate follows. |
| `FILL_VALUE_SHARE` | 0.6 | share of the discretionary target | chosen | Up when expensive high-value tests are crowded out by cheap ones; down when a lane spends its budget on a few slow tests and runs little else. The three shares sum to one. |
| `FILL_DENSITY_SHARE` | 0.25 | share of the discretionary target | chosen | Up when more of the cheap tail should run; down when the tail is displacing tests with a record. |
| `FILL_EXPLORATION_SHARE` | 0.15 | share of the discretionary target | chosen | Up when the unselected corpus is going stale; down when lanes spend the share on tests that never find anything. |
| `MIN_CORRECTION_SPAN_SECONDS` | 23 | seconds | derived | A tenth of a lane's budget, measured as the widest gap between the time two batches' own tests took. Nothing edits it: it moves only when the lane's budget does. |
| `MIN_CORRECTION_SAMPLES` | 3 | batches | chosen | Up when a slope is being fitted from too little and swinging about; down when a suite's real slope takes too long to be believed. |
| `HEALTH_TOO_LONG_FACTOR` | 2 | multiplier | chosen | Up when the test selection tile goes red for ordinary growth in the tests too long for any lane; down when a jump that took tests out of every pull request went unreported. |
| `HEALTH_TOO_LONG_JUMP` | 20 | identities | chosen | Up when a handful of newly slow tests turns the test selection tile red; down when a suite's worth of tests left pull requests without it going red. |
| `HEALTH_OVERRUN_SHARE` | 0.15 | share of lanes | chosen | Up when the test selection tile goes red over lanes a slow runner held up; down when lanes ran past their bound for days without it going red. |
| `HEALTH_MIN_LANES` | 20 | lanes | chosen | Up when a quiet week's few lanes turn the test selection tile red; down when lanes running long go unjudged for want of enough of them. |
| `HEALTH_DRIFT_FACTOR` | 2 | multiplier | chosen | Up when the test selection tile goes red for a suite whose charges are off in a way nobody will fix; down when a suite charged twice or half what it spends went unreported. |
| `HEALTH_MIN_BATCHES` | 10 | batches | chosen | Up when a suite few lanes run turns the test selection tile red on a handful of batches; down when a suite's drift goes unjudged for want of enough of them. |
| `FLAKE_EXCLUSION_RATE` | 0.005 | share of runs | chosen | Up when fewer tests should be held back from pull requests; down when flakes are still blocking people. |
| `FLAKE_MIN_EXECUTIONS` | 2 | runs of one item | chosen | What an item that has ever disagreed runs. Down to one when the cheapest evidence of intermittency is not worth a second execution; nowhere useful above two, since the line through the anchor covers everything flakier. |
| `FLAKE_ANCHOR_RATE` | 0.01 | share of runs | chosen | With `FLAKE_ANCHOR_EXECUTIONS`, the point the count's line passes through. Down to make the count climb faster with the rate; up to make it climb slower. |
| `FLAKE_ANCHOR_EXECUTIONS` | 5 | runs of one item | chosen | What an item at `FLAKE_ANCHOR_RATE` runs. Up when intermittent regressions still get through; down when executions crowd a lane. |
| `MAX_EXECUTIONS` | 10 | runs of one item | chosen | Where the line stops. Up when the flakiest items a change forces in still are not proven by what runs; down when they crowd a lane. |
| `RERUN_EXECUTIONS` | 3 | runs of one unit | chosen | The most times the full run runs a unit again where a test in it failed every time. Up when flaky tests on `main` fail every rerun and go on being counted as new real test failures; down when a real break's reruns take time that tells nobody anything. |
| `RERUN_BUDGET_SECONDS` | 300 | seconds | chosen | What one lane of the full run may spend rerunning its failures. Up when failures go without reruns for want of it; down when a broken `main` holds every lane this much longer than it needs. |
| `COVERAGE_COMMENT_LINES` | 25 | lines | chosen | Up when coverage comments are too noisy; down when debt is climbing unnoticed. |
| `LOCAL_COVERAGE_MAX_SECONDS` | 30 | seconds | chosen | Up when too many sets are reported as expensive for the report to be worth reading; down when one is quietly eating a lane. Nothing is excluded either way; it only decides what the summary mentions. |
| `EXCLUDED_FROM_COVERAGE_GATE` | 9 | workspace members | chosen | Not a quantity. A line comes off when a package fits the run's budget or gains a Deno-only half, which gives it a measured set. A line goes on when a package's own tests stop being what covers it. |
| `LOCAL_COVERAGE_BASELINE_DAYS` | 7 | days | chosen | Up when branches based further back are being reported for want of a baseline they contain; down when the manifest carries more history than anybody reads. |
| `NEW_REAL_TEST_FAILURE_BREADTH_WINDOW_DAYS` | 2 | days | chosen | Up when a broken runner's failures are being counted as new real test failures; down when genuine breadth is being written off as environmental. |
| `SAME_COMMIT_REACH_DAYS` | 2 | days | chosen | How far back the fold remembers a commit's outcomes, so that a rerun landing in a later batch than the run it repeats is still read as the test disagreeing with itself. Up when reruns land far enough behind that their disagreement is being counted as a new real test failure; down when the fold's memory is the thing that will not fit. It costs the number of identities that have failed times the number of commits, so it is the dial to check first when a run runs out of memory. |
| `FLAKE_COMMIT_REACH` | 8 | commits | chosen | How many of the most recently observed commits the fold keeps every identity's outcomes at. Past that a commit keeps only the identities that have already failed, so this bounds a test's first failure: up when one lands more commits after the pass it disagrees with than this and is counted as a new real test failure; down when the fold's memory is the thing that will not fit. |
| `COMMIT_REACH_DAYS` | 30 | days | chosen | How late a re-run of a commit may arrive and still be recognized as one rather than judged as a new commit. Up when re-runs landing later than this have their failures counted as new real test failures; down when the fold's memory of commits is the thing that will not fit. |
| `RENAME_SIMILARITY` | 0.7 | share of the longer name's own part | chosen | Up when the run report offers rename pairings nobody meant; down when a rename that discarded history goes unoffered. It only decides what is suggested — nothing is written to the alias file without somebody appending it. |
| `RENAME_MARGIN` | 0.1 | share of the longer name's own part | chosen | Up when the run report pairs a deletion with an unrelated addition; down when a rename made alongside another rename in the same area goes unoffered. |
| `RENAME_SUGGESTIONS` | 5 | suggestions in one comment | chosen | Up when a change that renamed many tests has its later suggestions cut off; down when a comment carrying this many is one nobody reads. |
| `NAMED_UNSCHEDULABLE` | 10 | identities | chosen | How many of the costliest identities no lane can hold a report names before it counts the rest. Up when a report leaves out one worth seeing; down when the list is longer than anybody reads. |

## The publisher

`.github/workflows/test-selection.yml` runs every four hours and on manual
dispatch. Four-hourly rather than daily because aggregation is incremental
and therefore cheap, and a flake that appears in the morning should not
wait until the small hours to be prioritized. Manual dispatch is there so
that somebody who has just fixed something can refresh without waiting.

Each run reads the newest aggregate it can, fetches only the objects whose
runs are not already folded into it, folds them, ages the counters, scores
everything, and creates one manifest object and one aggregate object. It
reads two hundred objects at a time and folds each day as one batch,
spooled to a temporary file, so what it holds in memory is bounded by the
number of tests rather than by the number of runs.

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

Only the default branch says which tests exist and where each one lives.
The identities the aggregate holds, and the file each one's records named,
come from `main`'s records alone. A workstation or a pull request may be
running a tree that adds, renames, or moves tests, so its records are
evidence about identities `main` recorded before them and about nothing
else. They count toward those identities' runs, failures, flakes, and new
real test failures, and a pull request's lanes toward their costs. For any
other identity they are kept by no state, and count only toward their own
run's crowd, which is a fact about the run rather than about the test. A
test a change adds enters the aggregate once `main` records it, which is
once the change lands, and a move that lands replaces the old file the
same way. `foldObservations` holds every batch to this, and since each day
is one batch replayed in time order, an off-`main` record counts when
`main` recorded the identity before it. A record that reaches the store
late is folded by a later run, so whether it counts depends on what that
run's aggregate already holds: one folded after `main`'s record counts,
and one folded before a late `main` record arrives does not.

An identity's cost window holds, for each day, how many of its passing
executions fell in each duration bucket, and its cost is the ninetieth
percentile of every day of the window taken together.
[The spec](../specs/test-selection.md#how-far-back-each-input-looks) says
why it is read that way.

A day of an identity's cost window carries the set of cost rules that
sealed it, as `COST_RULE`. A day carrying no such stamp was sealed
before the stamps began, which is every day an aggregate written before
them holds, and it counts as another set's day like any other.

Sealing a day drops every day of that identity another set sealed, so a
state holds one set's days. Another set's day is charged while it is all
there is, which for a test that has not passed since the change is until
the day ages out of the window, and is dropped the moment the rules in
force seal a day for that test.

Changing which executions reach a day's sample means changing
`COST_RULE` in the same change. The cost window then refills over its
own length, charging fewer days' figures while it does; carrying the old
days instead would have figures the new rules would never produce
deciding what a pull request runs for that same stretch. Changing how a
day's sample is stored does not change `COST_RULE`: the days already
stored are read forward into the new form, at or above what they held,
and keep the stamp of the rules that sealed them.

An aggregate also carries the set of rules its new real test failures were
credited under, as `NEW_REAL_TEST_FAILURE_RULE`, stored under the name
`catchRule`, and an aggregate carrying none was written before that stamp began.
Changing what decides whether a failure is a new real test failure, or which run
and day one is attributed to, means changing `NEW_REAL_TEST_FAILURE_RULE` in the
same change. The next run then reads an aggregate naming another set, and rather
than folding onto it, folds every day from the first one that aggregate's
history holds into an empty aggregate, saying so in its log. That run takes
about as long as a bootstrap over the same days. Nothing is lost: records carry
no retention, so the whole history is still there to fold. Changing a weight
that multiplies the counts does not change `NEW_REAL_TEST_FAILURE_RULE`, since
the counts are the same and the weights are applied when a manifest is scored.

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

That is why a run that cannot read any aggregate a previous run left refuses
to publish rather than starting from nothing. The aggregate is where a
test's new real test failures live, and they accumulate over unbounded
history: a run that lost it and carried on would publish a manifest scoring
every test at the floor, and because it succeeded that manifest would be the
one every lane obeys. A stale manifest is recoverable; a confident wrong one
is not.

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

A cold start is asked for deliberately: the bootstrap is a manual
dispatch with the bootstrap input set, and an incremental run that finds
no aggregate at all says so and stops. After that the incremental path
keeps up. A store holding no aggregate is what asks for a bootstrap. A
change to what a manifest or an aggregate holds does not, and neither
does a stored aggregate this publisher cannot read: the incremental path
reads past both.

A bootstrap starts from nothing, so it is held to the stores where that
loses nothing: it reads the stored states newest first, of any day, and
refuses if any of them is an aggregate this publisher can read, naming it,
and naming the `days` window an incremental run reaches it with where newer
states that do not read stand in front of it. An incremental run
folding onto that aggregate keeps every new real test failure it holds and
reads from the last day it read, which is everything a bootstrap would have
read since. A bootstrap starts from nothing only where the store holds no
state at all, or holds only states that are not aggregates. Where no state
reads and one of them is written in a shape from further ahead, it refuses
as well, since that history reads as soon as a publisher at that shape is
deployed. A listing or a read that fails ends a bootstrap too. Nothing in
the store is removed: the publisher's identity holds create and not delete
or overwrite, so the state object a previous run left stays where it is and
stops being the newest.

A new real test failure is dated to the day of the failure it credits. For a
new real test failure on the default branch, that is the first failure of
the run of failures the fix ended. Each test's state keeps its new real test
failures by that day as well as in total, which is what lets an alias divide
them at its date.

The two paths look back over different windows. An incremental run reads two
days, or from the last day its aggregate read where that is further back, so a
publisher that has stopped catches up on the first run after it starts again.
The last day read is read again because the run that read it ran before the day
was over, and what that run folded is passed over. An incremental run reads no
further back than that, apart from the day before today, which its two days
reach: an object folded for an earlier day would be folded after the days that
follow it, where the rules that decide whether a failure is a new real test
failure read the runs in the order they happened. An object that arrives late
for the day before is folded after what the last run read of today, out of order
by at most that one day. A bootstrap reads sixty. The dispatch carries a days
input naming a window of its own, and it applies in either mode: an incremental
run widens to it, and never narrows below the last day its aggregate read; a
bootstrap over a shorter stretch of history is a matter of giving it.

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

A day read the long way is spooled the same way, a chunk of its raw
objects at a time. A busy day is about six million observations, so the
temporary file for one runs to a gigabyte or two. One day is live at a
time, and its file is removed before the next day is read.

Keeping those observations in memory rather than in a file would fit
today. Folding the largest day so far peaks a little over a gigabyte with
the file, and holding what it spooled would add an estimated gigabyte and
a half to two gigabytes, against a heap V8 caps near four gigabytes. That
estimate comes from the size of an observation rather than from a measured
run without the file. The file is what leaves room for the corpus to grow
into.

The temporary file is removed when the day finishes or the read fails. A day
whose shards will not read is read from its raw objects instead, which is
how a day with no rollup at all is read, and the run says which day it read
that way and what stopped the rollup. The fold takes nothing from the shards
that did read, so no part of the day is counted twice, and the day is left
open rather than recorded, so later runs read it the same way. Completed
days are recorded, so no later run over a wide window folds their raw
objects on top and doubles every new real test failure in them.

Falling back rather than ending the run is what keeps a shard from
stopping the publisher for good. The store holds create and nothing else,
so a shard that will not read stays where it is, and a run that ended
there would leave the day unrecorded for the next run to end on in the
same place.

Reading a day the long way costs more than the one run it happens on.
Every object of that day goes into the aggregate's list of folded
objects, where the rollup path would have written one receipt, and that
list is carried in every state object written from then on.

The window is folded one day at a time, oldest first, whichever way each day is
read. The rules that decide whether a failure is a new real test failure look a
day or two either side of it, and back at what the default branch last said, so
a day folded after a later one would be judged against what happened after it.
Either way, a day is folded in one batch with that day's local submissions,
which the fold spools and replays in time order. A day read the long way is
read two hundred objects at a time.

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
bootstrap, or an incremental run catching up after an outage, can reach days the
compactor has closed and read their rollups. A day the compactor has not reached
is folded from its raw objects.

Publishing uses the workflow's own federated identity, pinned to that workflow
file on the default branch. It is the only workflow principal with a
folder-scoped create grant for manifests. A personal reporting key cannot
create one: it is scoped to its holder's own submissions folder. So a person
runs `--dry-run --out` and reads what a run would have produced.

The access token the workflow mints for that identity lasts an hour, and a run
that folds every day of the history again, as one does after the rules that
credit new real test failures change, takes longer than that. So the workflow
runs the publisher in two steps. The first reads, folds and scores with
`--dry-run --out <dir>`, and holds no credential, since the store is public to
read. The workflow then mints the token, and the second step runs `--create
<dir>`, which checks what the first step wrote and creates the manifest and the
aggregate from it.

### What an aggregate keeps

An aggregate keeps one state per test, and each state is bounded by the
windows its counts are kept over and by the days the test had new real test
failures on. Three things keep the number of states and the list of folded
objects from growing with the store.

A test the tree no longer holds is dropped once no run of it is recorded
inside the windows a state keeps, as
[What a run leaves out](#what-a-run-leaves-out) describes.

A test renamed under an alias line is resolved on every run, the way
each record a run reads is resolved. Its history from the days before
the alias's date moves to the new name and is added to whatever the new
name already holds. History from the alias's date onward stays under
the old name, since that is what a record of that day resolves to. Each
run moves whatever an alias line written since the previous run gives to
a new name, and says how many tests it moved.

The list of folded objects holds the days still open, and the first day the
history holds. A day is closed once it has been read and is
`COMPACTION_LAG_DAYS` behind the run, which is when the store stops expecting
late arrivals for it. A closed day's objects leave the list and its rollup
receipts go with them, and the aggregate records the last closed day instead, so
a run over a wider window passes over the closed days rather than folding them
twice. The objects and receipts of the first day its history holds stay in the
list when that day closes, because that day is where a fold of the whole history
under new rules starts, and every publisher reads it from the list. A bootstrap
closes every day before its window, since the window is where the history it
counts begins: a later run folding an earlier day would fold it after the days
that follow it, and the rules that decide whether a failure is a new real test
failure read the runs in the order they happened.

A day closes only if every day before it has been read, which an incremental
run makes sure of by reading from the last day its aggregate read. The days
before the first day a bootstrap or a fold of the whole history reads are the
exception: they close unread, because that day is where the history the run
counts begins.

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

### When the cost model breaks

Where the cost model a new manifest carries has broken, the dashboard's test
selection tile goes red and links to the cost model section of the page behind
it, which names each suite and figure that broke. The publisher's log and job
summary carry the same report, and the run itself succeeds: the manifest is
published whatever its health says, since nothing obeys the health.

The publisher measures the model in the manifest it creates, under
`health`, from the lanes' own records over `COST_WINDOW_DAYS`. Each batch
records what the packer charged the lane for it, `ci-lane projected batch
<suite>`, beside what it spent, and each lane records its work as a whole
once its work is done: `ci-lane lane`, from opening its first capability to
the end of the lane's own work, coverage conversion included; `ci-lane
projected lane`, what the packer projected that to be; and `ci-lane bound
lane`, the bound the lane was packed to finish inside less
`LANE_PROLOGUE_SECONDS`. The packer charges nothing for converting coverage,
so a lane whose conversion is slow is one the model under-charges, and it
counts as such. The packer charges nothing for [running a failure
again](#running-a-failure-again) either, but that is not the model's error, so
`ci-lane lane` leaves the time out and a lane of the full run records it apart
as `ci-lane reruns`. Only a lane that passed is read, since one that went red
stopped early.

Four things count as broken. Their dials are in [Every dial](#every-dial).

| What broke | What it takes | Where to look |
| --- | --- | --- |
| Some number of tests are too long for any lane, up from a lower count | More than `HEALTH_TOO_LONG_FACTOR` times as many as the manifest before, and more than `HEALTH_TOO_LONG_JUMP` more. Once reported, later manifests are judged against the same count from before the jump, so the alarm holds until the count falls back | The suites the message names. A jump this size is a suite's fixed charge moving rather than tests growing slow, so read that suite's fixed charge on the dashboard and the batches its fit came from. |
| A lane pays some seconds to hold a suite, past what a lane may fill | A fixed charge (overhead, one unit, and its capabilities' setup) past `LANE_BUDGET_SECONDS` | The suite's fit: what batches in the window spent beyond their tests, and which of them are far from the rest. [When the cost model is empty](#when-the-cost-model-is-empty) covers a fit with nothing in it. |
| Some of the lanes projected to finish inside their bound ran past it | More than `HEALTH_OVERRUN_SHARE` of them, over at least `HEALTH_MIN_LANES` | The model is charging less than lanes spend. The suites whose ratio is high are the ones to read first. |
| A suite's batches spent more than twice, or under half, what they were charged | The ninetieth percentile of spent over charged outside `1 / HEALTH_DRIFT_FACTOR` to `HEALTH_DRIFT_FACTOR`, over at least `HEALTH_MIN_BATCHES` batches | The suite's fit against its batches. The fit charges what a batch spends on average, so the median sits near one while the model holds and the ninetieth percentile somewhat above it. |

`deno task test-selection health --at <moment>` judges the manifest current
at any moment, including one from before the publisher measured its model.
Such a manifest is judged on what it and the one before it hold, which is
the first two rows, since the other two need the lanes' recorded charges.
Asked of the manifest of 2026-09-25 20:25, when the pattern unit suite's
fixed charge took about 180 tests out of every pull request, it names that
suite and the jump; asked of the manifests either side of that break, it
says the model holds.

### Recovery

Read the failed run's log and the public object listing before taking action.
A bootstrap is for a store holding no aggregate any publisher can read, and
refuses anywhere else, naming the aggregate an incremental run should fold
onto.

- If the newest state is valid, rerun the ordinary workflow from `main` with
  bootstrap off and `days` empty. Such a run reads from the last day the state
  read, however long the outage was, and folds onto the state already there
  rather than replacing it, which is what separates it from a bootstrap. The
  selection area deletes its objects 45 days after they are created, so an
  outage that long leaves no state, and is a cold start.
- To count a readable aggregate's history again from the records, raise
  `NEW_REAL_TEST_FAILURE_RULE` in a change and land it. The next run folds every
  day from the first day that aggregate's history holds into an empty one. A
  bootstrap refuses there, since it would start from a window rather than from
  that day.
- If the complete paginated listing has no state objects under the intended
  prefix, this is a cold start. Dispatch the workflow from `main` once with
  bootstrap on and leave `days` empty so the landed sixty-day default applies,
  or, where earlier states expired, with `days` reaching the first day of the
  store's history, since the records are kept and every new real test failure in
  them counts. Then require the three acceptance checks above. A change to what
  a manifest or an aggregate holds is not a cold start: the area is named rather
  than numbered, so it does not move, and both are read forward.
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
  record history are the recovery sources — and do not reach for object
  deletion or renaming. A bootstrap refuses here, naming the newest state it
  can read and the `days` window that reaches it.
- If a widened window reaches no readable state either, work back through
  the listing, dispatching with a window that reaches the day each older
  state was created on, until one is folded onto or the listing runs out. A
  state written in a shape from further ahead is history out of reach rather
  than history lost, and reads as soon as a publisher at that shape is
  deployed, so a store holding one is never a cold start. A store whose
  every state is a body that arrived and is not an aggregate holds no
  history any publisher can reach, and that alone is the condition under
  which this is a cold start: dispatch once with bootstrap on, and then
  require the three acceptance checks above. The bootstrap reads every state
  of any day before it starts from nothing, and refuses where one of them
  reads.
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

The second condition is what the first cannot say on its own. A suite whose
records name a scope the topology no longer holds claims none of its
identities, and every one of those is still running on the default branch,
so the runs hold them where the claim does not. What the second condition
does not reach is a test the tree holds that nothing runs at all: a skip is
the one outcome a state records nothing for, so such a test meets both
conditions and is dropped like a deleted one. What that costs is new real
test failures from before the window, because every counter inside it is
empty either way.

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

Left out of everything scored, they are not discarded. The publisher keeps
them in its rolling aggregate over `COST_WINDOW_DAYS`, the same window it
measures a test's cost over, and reads `setupCost` and each suite's fit from
them for the next manifest. A lane writes one record per capability it opens
and five per batch: what the batch spent, what the tests of its units and
their hooks took between them, how many times its passes opened a unit, and
how many passes it made, and a fifth that the fit does not read: what the
packer charged the lane for the batch, which [When the cost model
breaks](#when-the-cost-model-breaks) reads with the three a lane writes once
about its work as a whole. None of the first four can be recovered from the
records the batch produced: a reader of a report cannot tell which of its
records came from which batch. The second, third and fourth are what the
correction, the per-unit charge and the per-pass charge are fitted to, and a
batch missing any of them is not read. [What a lane is
charged](../specs/test-selection.md#what-a-lane-is-charged) says how. A lane
also writes one record for each time a pass opened a unit whose hooks its
report timed, `ci-lane hooks <suite> in <unit>`, which is where each unit's
hooks are read from.

The second counts the records the suite places in one of its units, which are
the identities a manifest holds and the packer charges by. A record the suite
places in no unit is left out of it, and so is the skip a lane registers for a
test it was not given. A record placed in no unit is the one a wrapper writes
for a whole invocation, which holds its units' time a second time, or a phase
that several units of a script share, or one off the suite's surfaces. What a
batch spends on those is part of what it spent beyond its units' tests, which
the per-pass and per-unit charges carry: a wrapper's run once for each pass,
and a shared phase once for each unit that runs it.

A unit's hooks are the setup and teardown its `describe`s declare around
their tests, such as a `beforeAll` that deploys a pattern and opens a page.
Deno's JUnit report times them only inside the case it writes for each
`describe`, and that case holds every test beneath it a second time, so
ingestion records it only where it failed on its own account or the manifest
already knows it, and then with the time it spent outside the cases directly
inside it. What the lane reads is the time each outermost such case took that
no record holds, which is the hooks of the `describe`s nested in it too, and
for a `Deno.test` whose leaves are steps, what its own body took around them,
less whatever a recorded container among them holds. The second figure
counts that, since the packer charges a unit's hooks through the same
correction as its tests, and the publisher keeps what each unit's hooks took,
counted by bucket as a test's durations are. They differ from unit to unit far more than a figure
for the whole suite could carry: one file's hooks can take a minute where
another's take nothing.

What its tests took, rather than what the packer expected them to take.
The two differ by however wrong the manifest's costs are, and a unit
nothing has measured is charged a stand-in that can be out by a factor of
ten. Fitting against the expectation would put that error in the
correction and the per-unit charge, which every lane holding the suite
pays for the whole window, long after the costs behind it were measured.
What a suite's cost model should carry is the machine's error, which is
what the tests' own time leaves.

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
bootstrap is not the tool for it, and refuses over a store holding an
aggregate in any case: the count falls on its own.

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
records. A lane writes one per capability it opens and several per batch,
and a lane killed part way through a batch leaves those unmatched, so a
model can hold a capability setup and no suite at all.

A batch run with coverage on is fitted apart from what the suite's batches cost
without coverage, because instrumenting a run costs it time and how much is a
property of the suite. The manifest carries the two fits in two maps of its
calibration: `suites` for batches run without coverage, and `suitesWithCoverage`
for batches run with it. A stored batch that does not say whether coverage was on
is read into neither. The line counts each suite once whether it has one fit or
two, and the last figure is how many have a coverage-on fit.

A capability's `setupCost` is the ninetieth percentile of how long its
openings took in the window, the same percentile a test's own cost is read at.
It is not the slowest opening, because the charge is paid by every lane that
opens the capability: read at the slowest, one slow runner would set what every
lane pays. The percentile is the observation at its rank rather than a value
between two, so over nine or fewer openings it is the slowest of them.

A unit's hooks are charged at the ninetieth percentile of what they took each
time a pass opened the unit in the window, which is the percentile a test is
read at, and are published in the suite's fit as `unitHooks`. A unit with no
entry there is charged nothing for its hooks.

A suite's three figures are fitted to what its batches spent by least squares:
`overhead` for each pass, `unitOverhead` for each time a pass opened a unit, and
`correction` for each second of its units' tests and their hooks, none of them
below zero. The correction is fitted only from at least `MIN_CORRECTION_SAMPLES`
batches whose tests and hooks took times spanning at least
`MIN_CORRECTION_SPAN_SECONDS`, and only where it comes out above zero; otherwise
it is one, and the other two are fitted to what the batches spent beyond their
tests and hooks. The fit is what a batch of its
shape spends on average. The packer charges a batch the fit, except that it charges
the batch's tests no less than what the longest unit of each pass takes, added
together, since a pass does not finish before its longest unit does. So a lane
is charged about what the batches it holds spend between them on average. Lanes spend
either side of that. The safety margin `LANE_SAFETY_SECONDS` absorbs a lane
that spends more by up to its own size, and one that spends more than that runs
past its bound. The packer also reads each test at the ninetieth percentile of
its own executions, which is above what the test usually takes, so a lane's
tests are usually charged more than they take.

A run charges each suite the fit for how it runs that suite's batches:
`pricedForRun` in `tasks/test-selection/census.ts` charges the coverage-on fit
for every suite of the full run, and for the suites of the sets the coverage
gate scores on a pull request, and the other fit for the rest. Where no lane has
run a suite that way yet, the run charges the other fit. Charging a run without
coverage the coverage-on fit errs high. Charging a run with coverage the fit
without it is short by whatever instrumenting costs. Either is nearer than
charging nothing. A lane runs first the batches of a suite whose charge was not
fitted the way this run runs it. A lane is stopped part way through only by its
step timeout or by a cancellation, and one that is has then measured
what the model most needs. Within each of those two groups, the batch the
packer charged the lane most for its tests goes first, so a lane cut short
has spent its time on its largest batches. The suite's identifier breaks a
tie, so every attempt at a lane runs its batches in the same order.

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
not merely thin. A capability's setup is the ninetieth percentile of its
openings, and a suite's figures are an average over its batches. A model
fitted over part of a window may not yet have seen the slow runs that raise
either, so it can read lower than one fitted over all of it, and reading low
is the direction that overruns a lane. A suite with nothing at all in the
window is charged nothing.

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

A set past `LOCAL_COVERAGE_MAX_SECONDS` makes every pull request that chooses
its gate slower, and costs its gate a place wherever the run cannot spare that
much. What the line gives is the set's cost over the fewest lanes that hold it,
counting what each of those lanes pays for the set's suites and capabilities. A
set that no number of lanes up to `LANES_MAX` holds gets a line saying it costs
"more with coverage on than the 30 lanes of 3m50s a pull request may take
hold", and no plan for a pull request can choose its gate. Nothing is done about
either automatically: which of the three to do is a decision about the
repository.

```
test selection: packages/donut is on EXCLUDED_FROM_COVERAGE_GATE for its
size, and its tests now cost 13m32s with coverage on across 4 lane(s),
inside the 30 lanes of 3m50s a pull request may take, so its line can come
off.
```

Each entry on `EXCLUDED_FROM_COVERAGE_GATE` carries a kind in
`tasks/test-selection/policy.ts`: `size` for a member whose set is past what the
whole run holds, and `source` for a member whose own Deno-only tests are not
what should measure it, or that has none. An entry of kind `size`, and only such
an entry, comes off once its tests fit the whole run, and the line says when
they do, so that the entry comes off because somebody read a measurement.
Choosing a set's gate packs its units across lanes, so what it has to fit is the
run rather than one lane. A set spread over several lanes pays
its suites' overheads and its capabilities' setup in each of them. It also pays
each unit's overhead in every lane holding part of that unit, and a unit is
split over no more lanes than it holds entries, so that overhead is paid at most
once per entry. Each unit's selected entries are charged once for each time the
unit runs, and the passes and unit openings a repeated entry adds are charged
their overheads once, in the lane holding that entry.
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
The reasoning behind each part is in [the archived
plan](../history/plans/pull-request-test-selection.md#an-excluded-test-still-runs-on-main).

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

### Running a failure again

The publisher reads a test as flaky only where it both passed and failed at one
commit, in one order. The run on the default branch runs most tests once per
commit, so a flaky test there never does that on its own. Each of its failures
is instead followed by a pass at a later commit, and the publisher credits the
change between them with a new real test failure. The test's score rises, and
selection picks it more often for doing what made it look valuable.

So a lane of the full run runs a test again when the test failed every time the
lane ran it. After its last batch, the lane runs the unit holding that test
again, up to `RERUN_EXECUTIONS` times, and stops once each such test in it has
passed. Every rerun is shipped as ordinary records of the lane's run: the same
commit, the same seed, and the same start. A flaky test therefore leaves a pass
beside its failure, and the publisher counts a flake rather than a new real test
failure. A test that is really broken fails every rerun, and its failure waits
for a later commit to judge it, as before.

The reruns collect evidence and decide nothing. Whether the lane fails is
settled from its batches' own records, with the excusal rules above, before
any rerun starts. A failure that passes when run again still fails the run,
and an excused failure stays excused whatever its reruns record.

Every rerun is a run of the test like any other. A test that passed on a
rerun is read everywhere as having disagreed with itself at the commit,
including by [the comment a run on the default branch
leaves](#the-comment-a-run-on-the-default-branch-leaves), which does not name
it as a first failure. A test that failed every rerun counts each of those
failures in its churn.

A unit runs again as its batch ran it, with the same skip list, so that the
rerun asks the same tests the same thing. A [unit that runs
whole](#units-that-run-whole) runs whole again, and the records of every test
in it ship. Coverage is off for a rerun, since nothing scores what a rerun
would measure. A test that has already passed beside its failure in the lane,
because its unit was repeated, has the evidence already and is no reason to
run its unit again. It still runs again where another test in its unit is.

What a lane spends on reruns is bounded by `RERUN_BUDGET_SECONDS`. Each rerun
goes to the unit that has run again least across all of the lane's suites, so
the budget is spread over the lane's failures rather than spent on the first. A
unit starts only where what the packer charges for it fits in what is left of
the budget, and the time the reruns take is what comes off it. A rerun takes
along any other waiting units of the same suite that fit beside it. The charge
is read from passing runs, so a rerun that hangs runs for as long as the hang,
and the lane's step timeout is what bounds that; the lane passes the signal
that timeout sends on to the rerun, as it would to a batch. The lane's job summary says
what the reruns took, which tests passed on a rerun, which never did, which no
rerun recorded, and which tests' units did not fit. A pull request's lanes
rerun nothing, unless the pull request is labelled `ci: full`, which runs its
lanes as the full run.

A lane decides all of this from the records its batches gathered rather than
from what a command exited with. A runner that failed only on identities a flake
rate excuses has told the run nothing it should stop for, and a runner that
exited zero having run none of its unit has. So a unit that a pass of its batch
recorded nothing for fails the lane, and an excusal holds only where every pass
accounted for every identity it was asked to run that the tree holds. Each pass
is judged on its own records and its own name maps. A repeated unit whose second
pass stopped part way is not accounted for by the first pass, which ran it to
the end. The lane reads what the tree holds from the name maps the registration
preload leaves in the spool. An identity a unit's processes did not register,
nor any test inside it, is absent where everything the map holds that encloses
it is a `describe`, known as one by a leaf the map holds inside it. Such an
identity is one the manifest carries for a test the tree no longer holds,
such as one renamed since the manifest, and the lane's job summary lists it apart from the identities that withdraw an excusal.
A registered test records the steps its body names as it runs, which no map
holds, so an identity beneath a registered test shows nothing; so does one
beneath a `describe` the map holds no leaf inside, and any identity of a unit
whose processes left no name map. A name map the preload marked as interrupted,
because an `error` or `unhandledrejection` event reached its file before the
file's hooks and tests began, shows nothing either. An identity any of those
leaves unrecorded withdraws the excusal. A package's browser tests, which run as
one unit, are read from the mark the browser test runner leaves once it has
loaded every file and run every test.

## What the dashboard shows

Two tiles read the newest manifest. The flake tile reports how many tests
are too noisy to judge a change by. The selection tile reports what share
of the corpus a change touching nothing would run and how close the fullest
lane is to
its budget; it goes amber when the manifest has gone stale and red when a
lane's projected work is past its bound, or when the publisher found the
cost model broken. Both tiles link to the full manifest detail page, and a
broken model links the selection tile straight to that page's cost model
section, which shows what broke, how the lanes came out, and each suite's
charges against the manifest before and against what its batches spent.

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

- **A test that failed for the first time at this commit.** Precisely that:
  it passed in the previous run on the default branch and failed in this
  one. A test that was already failing produces no note, which is what stops
  a break being attributed to whoever merged next. A test that both passed
  and failed at this commit produces no note either: that is the test
  disagreeing with itself, which the scorer calls flake evidence rather than
  a new real test failure. Nor does a test the pull request's own run
  failed, because a failure that run reported is not something a later run
  found for it.
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
  judge a change by. Otherwise the note says what the plan the lanes computed
  over that manifest says about leaving it out, which is never something the
  author missed. That plan is rebuilt from the labels the pull request carries
  when the comment is written, so a `ci: <n>x` or `ci: full` it ran under is
  the plan that explains it; labels the count cannot read leave no plan, and
  the note gives no reason. Either its unit runs whole and holds a withheld test, or no
  lane can hold the test, or the tests that had to run left no room in the lanes
  for anything else, or the lanes filled what they left with other tests. Only
  those four are said, because the plan records nothing more specific about a
  test it did not place. A test the packing
  reached, or one the manifest does not hold whose unit the packing placed,
  with no record either way is a run
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
  plan for the pull request did not choose the set's gate, so nothing
  measured the set there; no manifest was resolved for the pull request's
  run, so whether its plan chose the gate cannot be said; the change did
  not touch the member, so the gate had nothing to compare; or the gate
  did measure the set and passed it, which means the two measurements
  disagree. Each calls
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
  test's failure only where every pass of its batch accounted for every identity
  that pass was asked to run that the tree holds, and a run that did not apply
  the rule excused nothing. The lanes record each identity they excused, and the
  report reads those records one artifact at a time. Each
  `test-records-tests-<lane>-a<attempt>` artifact holds one lane's attempt. An
  identity counts as excused only where every artifact that failed it also
  excused it, since an attempt that failed it without excusing it failed the
  run. The manifest supplies only the store's flake counts, and a report that
  cannot read it gives the note without them.
- **A rename that discarded history**, with the number of new real test
  failures it would bring back and the line to append under
  `tasks/test-identity-aliases/`. Four things have to hold: the departing
  test had a new real test failure; the unit it lived in produced records in
  this run, so its absence is a test that left rather than a suite that did
  not run; the arriving name is one the store has never seen; and the
  pairing is clear — alike past `RENAME_SIMILARITY`, ahead of every other
  candidate by `RENAME_MARGIN`, and pointed at by no other departure.
  Alikeness is the lower of two comparisons, one over the groups a name is
  nested under and one over the part that is the test's own, because either
  alone answers a different question: two tests under one group share the
  whole chain, and two tests under different groups routinely share a leaf.
  At most `RENAME_SUGGESTIONS` are offered. A rename is never inferred, so
  this is a suggestion: append the line if the pairing is right, and ignore
  it if it is not.

Five properties keep this on the right side of
[the dashboard's rule](../../packages/dashboard/README.md#philosophy-and-values)
that reporting is about the system and never about individuals. The
comment's subject is a commit and a test, and no author is named. Nothing
is counted per author, per team, or per anything, and no history is kept:
each comment is a pure function of one run, and no tile, report or query
rolls them up. A test the selector declined to run is described by what the plan
the lanes computed says about leaving it out, because the author did not miss
it. A test the store has seen disagreeing with itself is labelled as one, with
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
one registers the rest of the file's tests as ignored, and ships no
record of them.

A `describe()` that fails as a whole, for example in its `beforeAll`, is
recorded under its own title. The outermost `describe()` of a file
registers a single `Deno.test` under its title, so ignoring that title
ignores every test inside it. Where a file declares a hook outside every
`describe()`, that outermost one is the `global` suite the runner
invents. A lane therefore never lists the title of a `describe()`
holding a test the lane runs. A `describe()` a lane chose runs its hooks
with the tests inside it ignored. A lane running a test inside a
`describe()` runs that `describe()`'s hooks too, on every run of the unit,
whether or not it chose the `describe()` itself, so the packer charges it
the `describe()`'s own cost for each of those runs, once however many tests
inside it the lane holds. Ingestion records the case a
`describe()` reports for itself in two separate cases: whenever it fails
on its own account, and on every run, pass or fail, once the manifest
holds its title in the unit that ran and no other case in the report has
that title. A record of any test inside a
`describe()` also accounts for it, ignored or not, including one the
lane's own skip list named and does not ship.
A `describe()` whose `beforeAll` fails reports no test inside it, so its
own failing case is the record that stands.

Some units hold more than one test and cannot be split. These are a
workspace member whose test task takes no file list, a member's browser
half, the reload suite's directory, and a section of the FUSE
integration script. A lane that asks for one test of such a unit runs
every test in it.

Each suite lists these units in `whole`, and a lane writes no skip list
for one. A lane of the full run that [runs a failure
again](#running-a-failure-again) inside one runs the whole unit again. Most
units in `whole` hold a single identity, such as a gate, a type-check group,
a binary build, one pattern's check, or one vintage fixture's replay. Only the
four kinds above hold several. A unit's shape does not tell you which kind it
is, because two of the four kinds are paths.

`tasks/test-topology.test.ts` checks `whole` in both directions. Every unit
outside it has to be a test file in the tree, because the preload looks a
skip list up under the file that registered the test, and a skip list for
anything else matches nothing. Every unit in it has to be one its suite
writes no skip list for, and one of the suite's own units.

The packer places each such unit as one choice. `plan()` in
`tasks/test-selection/plan.ts` merges the unit's tests into one choice
before it packs. That choice costs what all the tests cost together, and
it is held back when any of them is. The plan it writes lists the tests
again in place of the merged choice. The merge exists only inside
`plan()`. The manifest, the records, and the plan all name tests, so
anything that matches a record against the manifest or a plan finds the
test by its own name.

A change to such a member's source could bring its unit into a run only
through a coverage gate the plan chose, and none of these units belongs to a
measured set: `packages/identity` because
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

Where the topology points a member's task at files, it applies the task's
`--ignore` globs and the member's `exclude` lists, both the top-level one
and the one under `test`, while it enumerates the files. Deno applies
neither to a path named on its command line, so a file a lane hands over
would otherwise run in spite of being excluded.

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
recorded by that suite's runner.

What must run for want of records is decided a unit at a time. A unit that
no identity in the manifest locates to, under its own suite and variant,
gets a stand-in and must run until a published manifest holds a record of it,
so a new test file runs in its own change before anything knows what it is
worth. Once it has landed on the default branch, the full run there runs it,
and a pull request tested before the next manifest is published runs it only
where its budget has room: a file the default branch gained after the commit
the manifest was published from is not forced in for want of records, and
the exploration pass reaches its stand-in first. A new test
inside a unit the manifest already knows is not made mandatory on its own.
It runs whenever a lane runs its unit, because a lane's skip list names only
identities the manifest holds. Where that unit is a file, the change that
adds the test edits it, which makes the unit mandatory. A record that
belongs to a suite as a whole rather than to one of its units makes no unit
known.

Two things are worth knowing while writing one, and both are consequences
of the identity being the reported name:

- Prefer stable, content-derived wording over positional counters or
  interpolated identifiers, which mint a new identity every time they
  shift.
- A rename splits history unless a line is appended under
  `tasks/test-identity-aliases/`. Most renames cost nothing, because most
  tests have never had a new real test failure. A rename of a test that has
  had one is worth the line.

Until a run records it, a new test file is charged what
[`standIn`](../../tasks/test-selection/census.ts) works out from the
measured units of the suite around it: the larger of their mean and their
ninetieth percentile. That is deliberately above what most units of a
suite cost, since a lane packed under what its work takes is one that runs past
its bound, where one packed over it finishes early. A change adding many files
at once therefore reads as filling a lane well before it does, and the lane
summary says how many seconds of its projection stand on units nothing has
measured.

A step added to `packages/cli/integration/integration.sh` needs an arm of
the script's `case "$SECTION"` table that runs that step and nothing else.
The `cli-core` suite makes a unit of each arm that runs one step, and of
each standalone script beside it, and of nothing else; an arm that runs
several steps is for running the script by hand, and no lane is pointed at
one. A step no single-step arm runs is a step no lane can run.
`packages/cli/test/integration-sections.test.ts` fails on one.
`packages/cli/integration/fuse-exec.sh` is cut the other way. Each arm other
than `all` is a section of phases over one mount, and the `cli-fuse` suite
makes a unit of each section. A phase only one section runs belongs to that
section's unit. A phase several sections run, the prelude among them,
belongs to the suite rather than to any unit.
`packages/cli/test/fuse-sections.test.ts` holds the table to every phase
being reachable and to the orderings the phases depend on.

A new test *surface* — a new script, harness, or kind of test — is a new suite
in `tasks/test-topology/`, never a new job, and [the record
guide](test-records.md#covering-a-new-test-surface) covers the wiring.

`deno task check-test-topology` is what notices a surface nobody
registered. It reads every file the repository holds for one named the way
`deno test` finds test files, or a shell script in an `integration`
directory, and fails on any that no suite accounts for, or that two suites
of the same variant claim. A file that looks like a test and is not one,
such as a project a test drives as a fixture, is listed in
`NOT_A_TEST_SURFACE` in `tasks/check-test-topology.ts` with the reason, and
an entry the tree no longer holds fails. A unit the run's records never
reached is reported rather than failed. Every run for a pull request or a
push runs the check in `Status` against that run's records. A run another
workflow calls has no `Status` job and runs no check.
