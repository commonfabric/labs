# Choosing which tests a change runs

The contract of test selection: what a test is worth running, what the
manifest that says so contains, and what a consumer of one may and may
not conclude from it. This is the normative description of the shipped
parts; [the operating guide](../development/test-selection.md) says how to
use them, and [the archived plan this comes
from](../history/plans/pull-request-test-selection.md) records the
reasoning behind it. It rests on
[test-run records](test-records.md), whose store it reads and beside whose
dataset area it writes. The implementation is `tasks/test-selection/`, and
the manifest format itself is
`packages/test-support/src/records/selection.ts`, beside the record schema
it is the counterpart of.

## What the score measures

A test earns its place by having had new real test failures before. That is
a property of the test rather than a symptom of a problem: a test that found
a regression once sits somewhere mistakes get made, and it will find the
next one. So the score is built on new real test failures and decays over
months rather than days.

That is a different quantity from "this test is currently flaky", and the
two are never scored together. A test failing a third of the time carries
almost no information per failure; a test that failed four times in two
years, each time because somebody broke something, carries a great deal.
Flakiness is dealt with separately, below.

### Two runs under the same conditions

Every test run shuffles the order its tests run in, by a seed that is fixed
for a commit: the Pacific day the commit was committed on, unless an override
names another
([TESTING.md](../development/TESTING.md#every-test-run-shuffles-its-order)).
Each record's context carries the seed as `shuffleSeed`, and a context without
one records a run in declaration order. Two of the rules below compare one
run's outcome with another's: a pass and a failure of the same identity read
as a flake, and a failure on the default branch judged by the pass that
follows it. Both compare runs at **one point** only: the same commit, with the
same seed or both without one. A test that depends on the order its siblings
run in passes in one order and fails in another, which is a bug in the test
rather than chance, so outcomes at one commit in different orders are not
compared. The rules that read the default branch's most recent outcome read
it in the order of the run being judged, and fall back to the branch's most
recent outcome in any order only where the branch has not run the identity in
that one. The default branch runs in two orders at once, the day's and, in
its daily run, the next day's, so an order-dependent test can be failing
there in one and passing in the other. The rules that count failures across
sources take runs in any order.

### What a new real test failure is

For every failing record, the publisher asks whether the failure says
something about a change or something about the test. A failure is a **new
real test failure** unless one of these holds:

- The identity was already failing in the most recent run on the default
  branch, in the order described above. The test was already broken and
  this run learned nothing.
- The identity both passed and failed at one point, with nothing between
  the two runs but chance. That is a flake observation, and it is counted as
  one.
- The identity failed across at least `ENVIRONMENTAL_MIN_SOURCES` distinct
  sources within `NEW_REAL_TEST_FAILURE_BREADTH_WINDOW_DAYS`. That is the
  environment or a dependency, not any one change. A failure away from the
  default branch while that branch was already failing the identity, as the
  first rule reads it, is left out of that count, though another failure from
  the same source can still count that source. A pull request's run tests the
  pull request merged into the default branch, and a workstation runs a change
  on top of one of that branch's commits, so while the branch fails a test,
  every pull request and workstation that runs the test fails it too. Those
  failures are the default branch's one breakage, and the default branch is
  already one of the sources. While the default branch is failing a test,
  nothing tells a failure its code caused from one its environment caused. So a
  breakage of the environment is credited to the default branch as one new real
  test failure when that branch fails the test before enough other sources do to
  reach `ENVIRONMENTAL_MIN_SOURCES`.
- The run that saw it newly broke at least `MASS_FAILURE_MIN_IDENTITIES`
  identities. That is the run, or the change as a whole, and not any one
  test.

Each new real test failure is attributed to the pair of the commit and the
source that saw it, so re-running one broken commit ten times counts once. A
source is the branch for a continuous-integration run and the reporting
person's login for a local one.

A test is worth a place in a pull request for the breakage it finds that
the rest of the selection would miss. A breakage that a crowd of tests
sees is found by whichever of them a pull request runs, so it says nothing
about any one of them. Crediting each would raise every test in the crowd
by the same amount, which tells none of them apart and dilutes the score
of every test that does find something alone. A failure in a crowd is
still a failure, and churn counts it.

A run, for this rule, is what one source saw at one point, and on a
workstation, what one invocation saw. A workstation runs its uncommitted
changes on top of the commit it names, so two of its runs at one commit
ran two different trees. A failure counts toward its run's crowd when
none of the other rules above sets it aside and it is new: on the default
branch, an identity whose previous run there did not fail; anywhere else,
one the default branch was not already failing. So a pull request run
while the default branch is red for a hundred tests is judged by what it
broke itself.

On the default branch the crowd is judged at the failure that began a breakage,
and a failure continuing it belongs to the same breakage until the branch passes
in that failure's order, since the new real test failure would be dated to the
first failure. Where the branch has not yet run the identity in that order, as
on the first run of a new day's order, the failure continues whatever breakage
the branch was in when it last ran it.

The publisher folds the objects one continuous-integration run uploaded
in one batch, and carries what each run newly broke from one batch to
the next for `SAME_COMMIT_REACH_DAYS`. A part of a run arriving in a later
publisher run is judged with what was counted before it.

A run on the default branch is a run of that branch's own head: each push to it,
and the daily run of every suite at its head under the seed the next day's
commits will take
([TESTING.md](../development/TESTING.md#tomorrows-seed-run-a-day-ahead)). A
failure on the default branch cannot be judged when it happens. Each of those
runs is the one run at its point. When a test fails in one of them, the run runs
the test again, up to `RERUN_EXECUTIONS` times ([the
guide](../development/test-selection.md#running-a-failure-again)), and a pass on
one of those reruns is the test disagreeing with itself at that point, which
counts as a flake observation. A failure every rerun repeats says nothing yet.
Counting each such failure as a new real test failure would make a test that is
flaky enough to fail several times in a row look like the most valuable test in
the repository. Such a failure waits for the next run on that branch with the
same seed. Still failing is the same breakage continuing, and nothing new is
learned. Passing at the same point is the test disagreeing with itself, and
counts as a flake observation. Passing at a later commit with the same seed
counts as a new real test failure: the change between the two commits fixed what
the test found. Passing with a different seed judges nothing, since an
order-dependent test stops failing when the order moves on, so that pass says
nothing about whether a change fixed anything. The failure goes on waiting. A
run with its seed is a later commit of the same Pacific day, a rerun of one of
that day's commits, or, for a failure in the daily run under the next day's
seed, one of the next day's commits. A pass that judges a failure in its own
order also drops the failures waiting in other orders, since they are the same
breakage seen in another order. A failure no run judges is dropped once it is
older than the longest window a test's history keeps. That drops the new real
test failure of a real breakage whose fix landed on a later Pacific day than the
breakage did, which is the price of not crediting an order change as a fix. A
run of failures ended by one pass counts one new real test failure, dated to the
first of them in the pass's order, so a week of the branch being red is worth
one new real test failure and not seven.

Nothing separates a failure a change fixed from one that healed itself, so
a test flaky on the default branch is credited for its own noise. The
judgement errs toward crediting a test rather than away from it. An
overstated score costs run time, and an understated one costs a test its
place.

### Where a new real test failure happened

A new real test failure is always a point in the test's favor, and the place
says something further.

- A **local** new real test failure — somebody at a workstation, part way
  through writing something — is the highest-quality evidence this system
  can receive, and counts double.
- A new real test failure on a **pull request** is continuous integration
  doing its job.
- A new real test failure on the **default branch** is a recorded escape:
  this test would have prevented a red default branch had it run on the pull
  request, and it did not. It counts one and a half times, which is the
  feedback loop that fixes that on its own.

### The formula

```text
catches   = NEW_REAL_TEST_FAILURE_WEIGHT_LOCAL * localCatches
          + NEW_REAL_TEST_FAILURE_WEIGHT_PR    * prCatches
          + NEW_REAL_TEST_FAILURE_WEIGHT_MAIN  * mainCatches

if catches == 0:
    record = 0
else:
    proven    = 1 - 0.5 ** (catches / PROVEN_SATURATION)
    freshness = FRESHNESS_FLOOR + (1 - FRESHNESS_FLOOR)
                * 0.5 ** (daysSinceLastCatch / FRESHNESS_HALF_LIFE_DAYS)
    record    = proven * freshness

breadth = 1 - 0.5 ** (sources / BREADTH_SATURATION)

value = VALUE_FLOOR + WEIGHT_PROVEN * record
      + WEIGHT_BREADTH * breadth + WEIGHT_CHURN * churn
```

Two guarantees follow, and both are asserted rather than argued:

- A test that has **never failed anywhere** scores exactly `VALUE_FLOOR`.
- A test with **no new real test failures but recent failures** — every one
  classified as flake evidence, or as a continuation of an already-broken
  default branch — scores `VALUE_FLOOR + WEIGHT_CHURN * churn`, and never a
  missing value. The branch for a test with no new real test failures is
  written out rather than left to the algebra: there is no date to measure
  freshness from, and multiplying zero by a missing number yields a missing
  number, which sorts unpredictably against real scores.

`VALUE_FLOOR` is what points the packing at the cheap tail. A
fifty-millisecond test that has never failed has a value per second of
one, which beats a hundred-second integration test scoring 0.9 by a factor
of a hundred.

### How far back each input looks

There is no single window, because the inputs want very different horizons
and one number damages most of them.

| Input | Horizon |
| --- | --- |
| `catches`, `lastCatch` | unbounded; `freshness` does the discounting |
| `sources` | unbounded, counted only over new real test failures |
| `churn` | decayed with a `CHURN_HALF_LIFE_DAYS` half-life, read over `CHURN_WINDOW_DAYS` |
| `flakeRate` | decayed with a `FLAKE_HALF_LIFE_RUNS` half-life in runs, read over `FLAKE_WINDOW_DAYS` |
| `cost` | `COST_WINDOW_DAYS` |

The counts behind `churn` and `flakeRate` are decayed rather than cut off.
A ratio over a long undecayed window measures total historical brokenness
rather than the current rate, and a week of failures eight months ago
would otherwise outrank a test that is failing right now. What they decay
against differs, because they ask different questions. Churn asks how much
trouble is here lately, which is a question about time. The flake share
asks whether a test still disagrees with itself, and what answers that is
runs that did not.

One set of run counts serves both `churn` and `flakeRate`, so it is kept
for the longer of the two windows and each term reads back only as far as
its own.

`cost` is the ninetieth percentile of every passing execution inside its
window, taken together: the ninetieth rather than the maximum, because
one unlucky runner should not permanently inflate an estimate, and rather
than the mean, because a cost model that under-estimates blows the time
budget. Each execution counts once however the days fall, so a slow day,
whether a loaded runner or a regression since fixed, raises the cost by
as much of the window as it holds rather than setting it for a week.

The window is one population, whatever order its records reached the
store in and however many runs read them. A day is therefore held as
counts of its executions by duration, so that the parts a day arrives in,
and the days a window spans, combine into the percentile of the whole.
Holding a percentile of each part instead would let a part carrying one
execution report that execution as the percentile of every execution
beside it.

The counts are kept in buckets, 32 to each doubling of a duration, and a
percentile is read as the largest duration its bucket counts. The cost is
therefore never below the exact percentile and at most one bucket, about
2.2%, above it, and what a day holds grows with how widely its durations
spread rather than with how many ran.

Only executions that passed are measured. A cost predicts what a lane
will spend running the test again, and a failure measures something else.
It ended where the failure was reached. Where a wait's safety net ended
it, its duration is that net's bound. The bound a safety net carries and
a lane's bound are the same order of magnitude, so a test that hits one is
otherwise reported as fitting no lane and held out of every pull request that
does not touch it.

Only executions on a lane's runner are measured. A workstation is a
different machine, faster or slower by however it differs, so its record
counts as evidence about the test and not about what a lane will spend
running it.

A day records which set of these rules sealed it, and a day carrying no
such record was sealed before any set was recorded, which reads as
another set. These rules change, and a day sealed under earlier ones did
not measure what these measure, so such a day answers only until these
rules have sealed a day for that test, and is dropped the moment they
do. Carried instead, it would
decide what runs for the whole of the window, and a safety net's bound
is the figure that outcome is worst for.

Two things follow that are worth stating. The window refills over its
own length after a change, charging fewer days' figures while it does.
And a test that keeps hitting a safety net seals no day at all, so it
keeps the earlier set's figure until that figure ages out; what answers
that case is the rule above it, that a failure is not measured.

A test with no passing execution inside the window has no measured cost
and is charged nothing. Such a test has either barely run or is failing
everywhere, and one failing everywhere holds up the default branch, which
is a louder alarm than any lane's budget and is answered first.

That rule is about an identity the store holds, whose executions inside
the window all failed. A unit the store holds no identity for at all — a
file that is new, or one whose every test was renamed — is a different
case and is not charged nothing.

Such a unit is charged from what its own suite's measured units cost, as
the larger of two readings of them: their mean, and their ninetieth
percentile. The suites are orders of magnitude apart, so one figure across
all of them describes none of them, and a suite's own units are the whole
of the evidence about what another of them will take. A suite holding no
measured unit has none of that evidence, and each of its units takes
`UNMEASURED_COST_SECONDS`, which is above zero so that a packer treats a
suite it knows nothing about as taking time.

Both readings, because a lane holding one such unit and a lane holding
twenty are short of time for different reasons.

A suite's units are bimodal: many fast ones, a few slow ones, and little
in between. The middle of them therefore falls where no unit sits, and
describes neither the fast units nor the slow. The ninetieth percentile is
where a test's own cost is read, and against one unit it is short one time
in ten.

What a lane holding twenty is packed against is their total, which sits
near twenty times the mean whatever shape they came from. So a figure
under the mean falls short of that total with a probability that climbs
towards one as the count grows, however safe the same figure is against
one unit. Which of the two readings is the larger is decided by how heavy
the suite's tail is.

No one figure covers a unit from the far end of a tail, and one that did
would charge a lane many times what it holds. What answers that is the
rule below, that a consumer reporting a projected time says how much of it
rests on stand-ins.

## Flakes

A flake is a test that disagrees with itself. `flakeRate` is how often it
was seen doing so, as a share of the runs it took part in inside
`FLAKE_WINDOW_DAYS`, weighted toward what it has done lately.

A share of runs rather than a share of failures. What the rate decides is
whether running the test once fails somebody's change for something its
author cannot act on, and that is a chance per run. The two quantities
differ by everything a test's passes say. A test that failed once in ten
thousand runs, and passed when the commit was run again, has every one of
its failures a flake: a share of failures reads it as wholly unreliable,
and a share of runs reads it as one part in ten thousand. Counting runs is
also what lets an exclusion reverse, since a run that does not disagree
lowers a share of runs and leaves a share of failures exactly where it
was.

The share is a lower bound on how often a test fails on its own. The only
spurious failure it can count is one with a pass beside it at the same
commit, and a test run once per commit produces none. What raises the
bound is repeats, and a rising share is what buys those, so the measure
sharpens itself on exactly the tests it is least sure of. A test that has
never disagreed with itself gets no repeats, so its first disagreement
comes from the default branch running it again after it fails.

Nothing is charged against the count, and no belief about how tests
usually behave survives into it. **A disagreement is a proof rather than a
sample**: a test that is deterministic cannot pass and fail at one point,
so an observation of one rules out the possibility the share would
otherwise be shrunk toward. A test seen twice that disagreed once reads a
half, and a test that disagreed once in ten thousand runs reads a
ten-thousandth; what separates them is how much each has been run, not how
much either is believed.

So the exclusion is the plain comparison it looks like, and what it says
is that a disagreement holds a test out until about one over the exclusion
rate runs stand behind it. A test that has just been seen to disagree, and
has nothing else on its record, is held out until it has shown otherwise.

That cuts the other way for a disagreement the environment caused rather
than the test. Nothing here separates the two, so a bad runner that makes
several tests disagree at one commit holds out the ones with few runs behind
them. The rule that reads a failure across many sources as the environment
covers new real test failures and not disagreements, and extending it is
what would fix this.

Both counts are published beside the share, because a share cannot be
weighed without them: one disagreement in two runs and a thousand in two
thousand are the same ratio and not the same claim. Everything that shows
a person this figure shows the counts with it. They are counted flat, so
they are not what the share divides: the share weights a day by the runs
that have followed it, and a test reads flakier when its disagreements are
the recent part of its counts.

Above `FLAKE_EXCLUSION_RATE` an identity leaves the selectable set
entirely: it is too noisy to judge a change by. It keeps running on the
default branch, it appears on the dashboard, and the exclusion reverses
on its own as those runs stop disagreeing, which is what makes this
better than a quarantine list somebody has to remember to empty.
Reversing on evidence takes one thing of the default branch in return,
which [what the default branch does with an excluded
identity](#what-the-default-branch-does-with-an-excluded-identity) sets
out.

A disagreement's weight halves every `FLAKE_HALF_LIFE_RUNS` runs that
follow it, because a sum cannot tell two histories apart that nobody would
confuse. A test that disagreed twice and then passed two hundred times has
settled; a test that passed two hundred times and then disagreed twice has
just started. Those are the same counts and not the same test, and an
undecayed share gives them the same number.

**Runs rather than days.** What shows a test has settled is running
without disagreeing. A test that has sat untouched for three weeks has
shown nothing, and a calendar that cleared it would be clearing it for
having been left alone. So an exclusion reverses on evidence: what falls
is the weight of what a test did against the weight of what it has done
since, and a test that is not running does not work its way back.

That is also how much evidence the share is measured over, which is what
stops the half-life going much below one over `FLAKE_EXCLUSION_RATE`.
Below that there are not enough runs in view to tell the rate the
exclusion turns on from nothing.

`FLAKE_WINDOW_DAYS` still bounds what is read at all. It is a bound on
what is remembered rather than a point where the weight has faded, so a
test that runs rarely can be carrying weight when its days fall off the
end.

### How many times a lane runs one test

A test that has never disagreed with itself runs once. Any share at all
puts it on the line through `FLAKE_MIN_EXECUTIONS` at a share of nothing
and `FLAKE_ANCHOR_EXECUTIONS` at `FLAKE_ANCHOR_RATE`, which carries on
past that anchor until `MAX_EXECUTIONS` stops it. So a test that has been
seen to disagree at all is run at least twice, because one execution
cannot tell a pass from a lucky pass.

Zero is the one point the count steps at, between running a test once and
running it at least twice, which is why the manifest records a share as
it was measured rather than to a few places. A share written to four
places reaches zero once a test has twenty thousand runs behind one
disagreement, and the step would then be taken on how often the test ran
rather than on whether it had ever disagreed.

The line runs past `FLAKE_EXCLUSION_RATE`, which the exclusion rule makes
sensible rather than contradictory. A test that flaky is not selected, so
the only way it reaches a lane is a change that edits it or that its suite
maps onto its unit — very likely a fix, and the execution count is what
makes it prove itself.

The exclusion threshold is per execution, and a test appears once per
execution, so a test run five times fails a lane spuriously about five
times as often as its share says. That cost is deliberate, and the
exclusion is what bounds which tests pay it.

How often an identity runs does not depend on what put it in the lane,
or on which run it is. An identity a change edited, an identity a
declaration reached, an identity chosen for what it is worth, and every
identity of a run over the whole corpus all run the count their share
asks for.

All of one identity's runs go in one lane, so a lane cannot be added to
make room for them. An identity that would be repeated and fits in no
lane runs fewer times, down to once, and a mandatory one is placed at
that single run however far past a lane's capacity it is; [what must run,
and what must not](#what-must-run-and-what-must-not) carries the rule.

**An execution is not a retry.** Every one must pass, and any failure
among them fails the run. Five runs of a test is strictly stricter than
one, never laxer. Nothing is retried and nothing is masked. Where a
consumer takes the second rule below, an excluded identity's runs on the
default branch are laxer than the one gating run it would otherwise get.
They are still not retries, since no run is re-attempted and no result is
discarded.

### What the default branch does with an excluded identity

An identity run once per commit is seen to disagree with itself only when
somebody re-runs the job, so every run an excluded identity gets on the
default branch lowers its share and almost none can raise it. Left there,
the exclusion reverses on runs that were incapable of keeping it in place,
and each of the identity's spurious failures, judged by the next run that
passed at a later commit, is credited as a new real test failure. The
identity returns to changes with a share near nothing and a score raised by
its own noise. Two rules answer this, and a consumer may apply the first
without the second.

**An excluded identity that may be run without its neighbours runs as many
times as its share asks for.** The count is the one the line already gives
that share, which runs past the exclusion rate. Several runs at one commit
are what let a share rise as well as fall, and they also put a pass beside a
spurious failure at its own commit, which classifies it as a disagreement
rather than crediting it as a new real test failure.

Every run of it at that commit takes one invocation shape, since a
consumer that runs the identity once beside its neighbours and again on
its own has arranged for a test sensitive to that difference to disagree
with itself at every commit, and the exclusion would then never reverse.
An identity that may not be run without its neighbours therefore keeps its
single run: running its whole unit several times would run every
neighbour several times, and a neighbour that is not flaky would fail the
run several times as often for it.

What several runs at one commit cannot separate is a bad machine. A consumer
that runs them together runs them on one machine, so a machine that fails
one fails all, which is no disagreement at all. The rule that reads a
failure across many sources as the environment covers new real test failures
rather than disagreements, and a default branch offers one source to read.

**A failure of an excluded identity does not fail the run.** This is a
separate decision and it is the one that carries risk: the branch already
fails for these identities once per commit, and the first rule multiplies
that. A consumer decides it per identity and never per invocation, since
one invocation reports one status for many identities.

It is a rule for every identity the store holds back, and a repository
gate is one of those. A gate introspects the tree where a test runs the
code. That decides what a gate reads and how it is invoked, and nothing
about what its failures are worth: a gate that disagrees with itself
fails somebody's change for something its author cannot act on, which is
the whole of what this rule is answering. A consumer reads the withheld
entry's reason rather than its membership of the set, so a reason added
later does not become non-gating without anybody deciding it.

What asks for a flaky gate to be fixed is the same thing that asks for a
flaky test to be fixed, which is a consumer's report of what the store
holds back rather than a red run. A rule that kept gates gating would buy
that prompt by failing a change for a reason its author cannot act on,
which is the cost this whole section exists to avoid paying.

An invocation is excused only when it accounted for every identity it was
asked to run that the tree holds, since one that recorded a withheld
failure and then stopped has run almost nothing while satisfying any
weaker test. An identity that holds others is also accounted for by a
record of anything it holds, since it ran for that record to exist, and a
name its report gave to several cases is not recorded for itself
([the record spec](test-records.md#ci-movement)). A stand-in for a unit the store has never seen is accounted
for by that unit recording anything at all, because no record can carry a
stand-in's name: a record is named for a test and a stand-in for a file.
And a unit that recorded nothing recorded nothing under any name, which
fails the run whether or not anything was there to excuse.

What the tree holds is what the unit's own test processes registered. A
manifest holds every identity the default branch recorded in a file the tree
still holds, so it names tests renamed since it was published, and no run of
this tree can record one of those. Where a unit's processes registered no
test by an identity's name and none inside it, that identity is absent, so
long as everything they registered that encloses it is a group they
registered a test inside. A registered test can record steps it names only
as it runs, so a registration says nothing about what lies beneath a test,
and a group registered with nothing inside it says nothing about what the
group holds. An absent identity's missing record says nothing about whether
the invocation stopped. Only a registration shows a test absent. A process
that died before it could say what it registered shows nothing, and an
identity it left unrecorded withdraws the excusal like any other.

A test file that an `error` or `unhandledrejection` event reached before any of
its hooks or tests began shows nothing either. Either can stop a module part way
through loading, after it registered some of its tests and before it registered
the rest. A unit of several files that one process runs, such as a package's
browser tests, is shown only by a mark its runner leaves after loading every
file and running every test, since a file that never loaded registered nothing.
[The record spec](test-records.md) says what each writes.

The rule is per invocation and not per set of them. A consumer that runs
an identity several times, or that reaches one unit through several
commands, has several invocations whose records arrive in one place, and
one that ended badly having recorded no failure accounted for nothing
whatever the others recorded. Reading them together would excuse a run
that died part way through on the strength of the part that finished,
which is the case the rule is for. That is the rule
under [what a run owes the change behind
it](#what-a-run-on-the-default-branch-owes-the-change-behind-it) applied
here, that a conclusion rests on a record that is there and never on one
that is missing. A consumer with no manifest has no withheld set, so it
runs nothing more than once and gates on everything.

Two things follow for a consumer that takes the second rule. A run
carrying a non-gating failure reports success, so whatever that success
releases is released, and a measurement taken through the failing unit —
coverage among them — is reported rather than compared. And a failure that
waits for a later run to judge it now waits without a red branch to
prompt anybody, so whatever holds those waiting failures is bounded rather
than left to grow.

Nothing is masked by either rule. Every run is recorded, every failure is
classified by the rules under [what the score
measures](#what-the-score-measures), and a non-gating failure is named in
what the run reports. The failure no longer fails the run, and only for
identities already held to be unable to say whether a change is good.

## What must run, and what must not

One rule keeps a test out, and it makes a change less red rather than
more. An identity above `FLAKE_EXCLUSION_RATE` is not selected, since a
test that disagrees with itself fails somebody's change for something
its author cannot act on.

It comes back the moment the change edits the test itself, or its suite
maps the change onto its unit, since that is very likely a fix and has to
be allowed to prove itself. Under the full policy it is not kept out at
all; [what the default branch does with an excluded
identity](#what-the-default-branch-does-with-an-excluded-identity) says
how it runs there.

**A mandatory identity runs, whatever it costs.** Nothing weighs it
against a budget, a lane's capacity, or the time the run is trying to
hold to, and no rule anywhere takes one out. An identity whose own cost
is past a lane's bound is placed in a lane regardless, and what that produces is
a lane that runs long and says by how much. The alternative is a run that
reports a pass over a test it decided not to run, which is the one failure this
design will not have: a consumer is told a test did not run, never left to infer
it from a green result. Weighing cost is for the identities nothing requires,
and the list of work no lane can hold names those alone.

The count of runs is the one thing that bends. An identity that would be
repeated and fits nowhere runs fewer times, down to once, since all of
one identity's runs go in one lane and one observation beats none. Down
to once and never to nothing.

A plan says what a suite costs it, as well as what a test does. A lane pays
a suite's overhead, what one of its units costs to open, and its
capabilities' setup before it runs anything of that suite, and that
charge is the same for every identity the suite has. A lane that runs a
suite with coverage on pays what that suite's batches have cost with
coverage on, where such a fit exists, and otherwise its fit without
coverage. The two are fitted apart, since instrumenting a run costs it time
and how much is a property of the suite. Where it alone passes what a lane
holding two things may take, nothing can share a lane with one of the
suite's identities, so the suite takes a whole lane for each one it places;
where it passes a lane's bound, no lane can hold the suite and every
discretionary identity it has fits nowhere. Both are reported once for the
suite, and the identities of a suite in the second case are left out of the
report that names identities, since the suite's line says what every one of
them would.

**A unit that runs whole is one choice.** Some units have a runner that
runs every identity in them, whatever it is asked. The topology lists
these, and the packer places each as one choice rather than one choice
per identity. That choice costs what all its identities cost together.
It is held back when any of its identities is held back. It runs when
any of its identities must run. The plan still lists each identity,
under the reason that put it there. The manifest and every record
therefore name identities, never units.

Neither reading changes what the packer does. What they change is what a
plan can be asked. A plan that reported only the identities says nothing
at all in the first case, and in the second says the same thing once per
identity — thousands of times where a report is unbounded, and where one
is bounded, filling the whole of what it has room for with tests that
each cost a thousandth of the figure beside them.

Two rules force a test in.

- **An identity with no records must run.** This is required of any
  consumer that selects which tests run, by
  [the record spec](test-records.md#trust-boundaries-for-consumers), on the
  grounds that a selector which never runs the unselected starves its own
  data and that a renamed test is an unknown identity until an alias line
  lands.

  What a consumer can see is a unit, so the rule is applied per unit. A
  unit that no identity the manifest knows in its suite and variant
  belongs to is represented by a stand-in, and the stand-in must run. A
  new identity inside a known unit is not forced in. It runs whenever its
  unit runs, because what a runner is told to skip names only identities
  the manifest holds. A record a suite writes for itself rather than for
  one of its units makes no unit known.

  A unit is not forced in for want of records where it is a file the
  default branch gained after the commit the manifest was published from
  and before the change branched off it. The full run on the default
  branch runs every unit there, so the store has that unit's records, or
  is about to, and the manifest is only too old to hold them. Forcing it
  into every change tested in that window would charge each of them a
  stand-in, and the lanes to hold it, for data that is already being
  gathered. Such a unit keeps its stand-in at the floor score, and since
  it has never run, the exploration pass reaches it first among what is
  left. Everything else the manifest has not seen is forced in: a unit
  the change brought, a unit the manifest's own commit already held, and
  a unit whose name is not a path at all, such as a repository gate or a
  type-check group, since a list of files cannot say when one of those
  arrived. A manifest naming no commit the checkout holds leaves nothing
  known to have arrived after it, and a consumer with no manifest has no
  such commit, so the whole corpus stays mandatory there.
- **What the change touches must run.** A changed test file's identities
  are mandatory. Everything else a change forces in goes through one
  rule, and there is no second rule beside it: a declaration names the
  paths a change reaches something by, and what a change reaches is what
  it forces. That is how a unit which is not a file — a type-check group
  or a repository gate — is reached at all, because only its suite knows
  what its unit covers. A unit whose suite declares nothing, such as the
  build of a shipped binary, is never forced in by a change. It runs when
  it is unknown, when the score chooses it, and in a run over the whole
  corpus. Anything else that has to answer "which
  parts of this repository did the change touch" answers from the same
  declarations, including the [coverage gates](#coverage) a change may
  choose. A second mechanism for the same question is
  a second thing to be wrong about, and the two would disagree.

  A declaration is bounded rather than exhaustive, so that what a change
  runs stays mostly what the score chose. No one unit may be reached by a
  significant share of the tree, and no one file may reach a significant
  share of the units. Something whose input is a large part of the
  repository declares the small and specific part of it, or declares nothing
  and is reached by the score alone. Declaring too little costs only that;
  declaring too much places the unit in every lane by declaration rather
  than by its new real test failures. Nothing about a changed source file
  forces a test in except through a declaration that reaches it. Which tests
  run for it otherwise is what the score decides.

  The type check is not bounded that way. A change reaches every
  type-check group whose files import a changed file, directly or through
  other modules, however many groups that is; a manifest, a declaration
  file it loads into every check, or the lock file reaches the groups whose
  modules it governs. The change can alter each of those groups' verdicts,
  and no `deno test` type-checks anything, so a group left to the score is
  a type error the change may have made that nothing looks for.

## Packing

A run's lanes are filled from a plan, and every lane of the run computes
the same plan, so packing is part of the contract rather than a detail of
one consumer.

### What a lane is charged

A lane is charged the setup of each capability it opens, and for each
suite it holds:

- the suite's `overhead` once for each pass, where a pass is one
  invocation of the suite's command over the units still asking for runs,
  so a batch whose identities run three times takes three passes;
- the suite's `unitOverhead` for each time a pass opens a unit;
- what its tests take, which is the larger of two figures. One is the
  suite's `correction` times the tests' own costs and their units' hooks,
  each counted once for each time its unit runs. The other is what the
  longest unit of each pass takes, hooks included, added together, since a
  pass does not finish before its longest unit does. The second is the one
  that binds for a suite whose runner runs its units side by side.

A unit's tests are the identities the lane holds in it, and every test the
manifest holds around one of them in that unit: the `describe` blocks
enclosing a leaf, whose `beforeAll` and `afterAll` hooks run on every run of
the unit that runs anything inside them. A `describe`'s own cost is the time
it spent outside the cases directly inside it, so a chain of them is counted
level by level without overlap. Each is counted once per run of its unit,
whichever lane holds its own identity, and once only where the lane holds
both it and a test inside it.

A unit's hooks are the time its outermost tests took that no record
holds: chiefly the `beforeAll` and `afterAll` hooks of the `describe`s the
manifest holds no identity for, such as one that deploys a pattern. They
are the unit's rather than the suite's, since one file's hooks can take a
minute where another's take nothing, and they are counted once per run of
the unit. A unit the fit names no hooks for takes nothing for them.

A suite with no fit is charged no overhead, nothing per unit, no hooks,
and a correction of one. A runner that runs units side by side starts the
costliest first, by the cost the lane hands it with each unit, since the
second figure assumes nothing long starts last.

A capability's setup is charged at the ninetieth percentile of its
openings over the cost window. A unit's hooks are charged at the ninetieth
percentile of what they took each time a pass opened the unit over the
cost window, which is the percentile a test's own cost is read at. They
are read apart for batches run with coverage on, as a suite's figures are.
A suite's three figures are fitted to what the lanes' own batches of it
spent, by least squares with none of them below zero: what each batch
spent against `overhead` times its passes, `unitOverhead` times the units
it opened, and `correction` times what the tests of its units and their
hooks took. The fit takes no account of the longest-unit figure. So a batch is charged what a batch of its shape spends on
average, and the safety margin `LANE_SAFETY_SECONDS` absorbs a lane that
spends more than its batches' average.

- What a batch's tests took counts only the records its suite places in
  a unit. A record placed in no unit, such as one a wrapper writes for a
  whole invocation, is part of what the batch spent beyond its tests.
- What a unit's hooks took is read from the unit's JUnit report: the time
  each outermost test took that no record holds, which is what the hooks
  of its `describe`s took, and for a `Deno.test` whose leaves are steps,
  what its own body took around them, less what a recorded container
  among them holds. A unit whose report holds no such test, such as one a
  runner other than `deno test` reports, has no hooks, and what it spends
  beyond its tests is in the per-unit charge.
- The correction is fitted only over at least `MIN_CORRECTION_SAMPLES`
  batches whose tests' times span at least `MIN_CORRECTION_SPAN_SECONDS`,
  and only where it comes out above zero. Otherwise the correction is
  one, which is the reading that needs no evidence, and `overhead` and
  `unitOverhead` are fitted to what the batches spent beyond their tests.
- Where the batches cannot tell a charge per pass from a charge per unit,
  as when every batch opens one unit in one pass, `unitOverhead` carries
  it.
- A batch that does not say how many passes it made, or whether coverage
  was on for it, is not read.

### How many lanes a run takes

The job matrix has to be known before any lane starts, so one job counts a
run's lanes, and it hands them the count and the arguments every lane takes
besides its own number. Each lane then packs the same plan over the same
reading at that count, so what a lane runs passes through no job output.
A later attempt of the lanes alone is handed what the count of the
attempt it repeats decided. A later attempt of the whole run counts again
from the same commit, change, labels and manifest, and so comes to the
same answer.

A pull request's plan has a discretionary target: `DISCRETIONARY_SECONDS`
times the run's scale, which is the seconds the value, density and
exploration passes are to fill between them. The full run's target is zero,
since it chooses nothing. A run takes the fewest lanes, up to `LANES_MAX`,
whose plan holds it. A plan holds a run where:

- no mandatory identity overflows, which is to say each one either fits
  inside a lane's budget or runs alone in a lane of its own; and
- the room the mandatory pass leaves below the lanes' budgets, added up
  over the lanes, is at least the target, or at least what one lane
  holding every identity the passes could choose would be charged where
  that is less.

The count is found by bisection between one lane and `LANES_MAX`. It
takes an added lane to leave nothing overflowing that did not before, and
no less room. Where that fails the count may be more lanes than the run
needs, never fewer. A run whose plan holds it at no count up to
`LANES_MAX` takes `LANES_MAX` lanes: its passes fill what room is left,
and its mandatory work may put a lane past its budget. Where nothing in the
tree has a measured cost, the count is the larger of the number of suites
with anything to run and what the packing of the stand-ins asks for.

A pull request's scale is one unless a label says otherwise. Every label
whose name begins `ci:`, in any spelling or capitalization, says how much
the pull request runs, and each must be one of two forms:

- `FULL_RUN_LABEL`, `ci: full`, which makes the run the full one;
- `ci: <n>x`, where `<n>` is a non-negative decimal written as digits
  with an optional fraction or as a fraction alone, which makes the scale
  `n`. At a scale of zero the run holds its mandatory work and nothing
  chosen by score, in as few lanes as that takes, which is one where
  nothing is mandatory.

A label in that namespace in neither form, or more than one such label,
stops the count before it reads anything, and with it the run: no lane
starts, and the count says which labels it could not reconcile. Running the
default instead would run something the labels did not ask for.

### How lanes are filled

The mandatory identities are placed first, the costliest first, with the
identity's key breaking ties. Each goes in the cheapest lane that can still
hold it, running fewer times where its repeats fit nowhere, down to once.
One that fits nowhere even once goes in the lane it leaves shortest. This
is the only pass that may put a lane past its bound, or past its budget
with more than one identity in it.

Three passes then spend the run's discretionary target, or what the
mandatory pass left of the lanes' budgets where that is less, each up to
its share of it. `FILL_VALUE_SHARE` is spent in descending score.
`FILL_DENSITY_SHARE` is spent in descending score per second of what each
identity would add to the lane it went in, recomputed as placements make
other identities cheaper. `FILL_EXPLORATION_SHARE` is spent on what
neither chose, never-run identities first and then the longest unrun,
with an order shuffled by the manifest's seed breaking ties. A share left
unspent is available to the passes after it. The passes spend the target
and no more however many lanes the run has, and less where `LANES_MAX`
leaves them less room. A change that forces in a great deal of work takes
more lanes rather than leaving them no room.

In these passes an identity goes in the cheapest lane that can hold it
inside its budget, and the emptier lane wins a tie. A lane holding
nothing may take one identity run once up to the lane's bound, which is
where an identity costing more than a whole budget runs. An identity that
would be repeated takes as many of its runs as fit, giving them up one at
a time down to one.

A coverage gate the change reaches is a candidate of these three passes
as well, taken at its own score. Choosing one places every identity its
set holds, under these same rules, across as many lanes as that takes.
[Which gates a change runs](#which-gates-a-change-runs) says how.

## Coverage

Selection breaks a gate on the repository's whole coverage number: a
change that runs a fifth of the test time measures a fifth of the
coverage, and the two sides of that comparison are no longer the same
thing. One narrower measurement survives, and it is the unit of
everything here.

A **measured set** is one suite's units over one workspace member's
lines. Run every unit of the set and what those tests reached in that
member is complete, whatever selection did anywhere else in the run, so
the comparison against the default branch stays honest.

A suite declares its measured sets. Each one names the member whose lines
it counts, the units that measure it, and the paths a change reaches it
by. Those paths are declarations in the sense above, and the coverage
gates add no second way of asking what a change touched. A set every one
of whose units the configuration deliberately does not run is not a set
at all, since scoring it would score whatever else happened to write into
its directory.

The suite that runs each workspace member's own tests declares one set for
every member under `packages/` with tests that run under Deno alone, at
whatever depth the member sits, reached by its own tree less the trees of
members nested inside it. The repository's `tasks` and `scripts` trees
carry none. That suite leaves a member out only where the member is named,
with a reason, on `EXCLUDED_FROM_COVERAGE_GATE`.

### A gate is a test

Each measured set has a **gate**: the comparison of what the set's units
reached in its member against what the same set reached on the default
branch. A gate is a test in everything selection reads. It has an
identity, of kind `gate`, owned by the member whose lines it counts and
named for the suite whose units it judges, such as `coverage-gate
workspace-unit`. Every run that reaches its verdict records it, and the
publisher scores those records like any other identity's. A gate
therefore earns a place in a pull request by its new real test failures,
as a test does.

What sets a gate apart is where its verdict is reached. Several lanes may
share a set's units between them, so no lane can judge the set, and the
job that joins the lanes does. The topology holds the gates as a suite of
their own, one unit per set, whose units are verdicts over other suites'
units. A lane never runs one, and a plan never places one in a lane.

### Which gates a change runs

A change may choose only the gates of sets it reaches. A gate whose set
the change does not reach is never chosen, whatever it scores.

Among those, a gate is chosen by score, in the value, density and
exploration passes, like any test. Choosing a gate places every identity
of every unit of its set, each in a lane that holds it inside its budget,
across as many lanes as that takes. A gate is chosen only where the whole
of that fits inside the pass's share, since a count over part of a set
measures nothing. What it costs the pass is what those identities add to
the lanes. An identity of the set already placed for another reason, a
test the change edited among them, is part of the set's run and is not
placed again, so a gate whose whole set already runs costs nothing more.
Each identity of the set runs as many times as its own flake rate asks
for, and an identity the manifest holds back is placed all the same,
since the set is measured whole or not at all.

In the density pass a gate's density is its score over what choosing it
adds. Working that out is a packing of a whole set, so a gate is weighed
when it is offered, when it reaches the head of the queue, and after a
gate is chosen, rather than after every placement.

A gate the plan does not choose forces nothing. Its set is reported as
not measured, and nothing fails for it.

Neither rule that forces a test in reaches a gate. A gate is not a unit,
and the units of its set are under both rules already. A gate nothing has
recorded is offered at the floor of the score, under the identity its
suite says it records under. The default branch reaches every gate's
verdict on every push, so that is where its record starts. A gate the
manifest holds back is not chosen, and the full policy runs it and fails
nothing for it, as it does any excluded identity.

A lane charges a suite at what its batches cost with coverage on where
the run measures that suite, and a pull request measures the suites of
the gates its plan chose. Pricing has to know that before the plan is
packed. So the plan is packed first with no suite priced as measured,
which is the answer wherever it chooses no gate. Where it chose some, it is
packed again with those gates' suites priced as measured and only their
gates offered, and again with fewer for as long as it then chooses no gate
of some of those suites. Each packing after the second offers fewer
suites, so this ends, and it ends with every suite priced the way the
lanes will run it.

The job that joins the lanes packs the same plan, from the same tree, the
same manifest, and the lane count and scale the lanes were handed, to learn
which gates were chosen. On a pull request it
refuses to judge anything where it cannot read the store, as a lane
refuses to pack. A run of every test chooses every gate whatever the
store says.

### Measuring a set

Five rules hold of every measurement.

- **Each set is counted on its own.** A set's units write their coverage
  profiles into a directory named for the suite and the member, and a
  set's count is converted from that directory alone. Two sets over one
  member are two counts and are never added together, and neither is
  added to the source group of the same name, which is the same lines
  measured by every test in the run.
- **Measuring a set does not change how often anything runs.** Each of
  its identities runs as many times as its own flake rate asks for, which
  is the count anything else in the run would have given it, and a repeat
  reaches that unit and no other. A repeat leaves the set's number where
  it was, since a count is the union over what the runs reached. Two
  chosen gates over one suite run the union of their units.
- **A set's lines are its member's own tree**, less the tree of any
  member nested inside it, counted by the rules the repository-wide
  metric already uses. A member's browser half is not part of any set,
  so that adding a test needing a browser costs a member nothing here,
  and what that half reaches is not counted toward the set.
- **A change's lanes instrument only what is judged.** They turn coverage
  on for the members of the sets whose gates the plan chose and run
  everything else unmeasured, since instrumenting a run costs it time and
  nothing reads a profile no gate judges. A run over the whole corpus
  instruments every member, since the baselines and the repository-wide
  figure come from it.
- **The default branch measures every set.** That is where the baselines
  come from, and its run merges every report it produced into the one
  repository-wide figure, which is a trend rather than a gate.

### The verdict

A set is compared against the count the same set had at the newest
default-branch commit the change contains, which the manifest carries.
Newest is settled by the order of those commits in the default branch's
own history, and never by when the run that measured one was created: a
re-run of an older commit produces a later run of an earlier tree.

A commit on the default branch is compared against its first parent's
count and nothing else. A verdict there is attributed to the commit that
reached it, by the rule under [what a run owes the change behind
it](#what-a-run-on-the-default-branch-owes-the-change-behind-it). A
baseline further back holds every commit in between, among them a rise
another pull request accepted. The publisher carries a commit's figures
into a manifest hours after its run, so the parent's count is read from
the parent's own push run as well as from the manifest: from the first of
that run's attempts to upload its figures, which it does at the end of its
`Status` job, whether or not the rest of the run has finished. Those
figures leave out every set a unit of which failed in that run, as the
manifest's do. A parent whose run has not uploaded them yet, or whose
upload cannot be read, has no count to compare against unless the manifest
already carries one, and the verdict otherwise compares nothing; nothing
waits for it. Nor does the head of a push that lands several commits,
since its parent was never a push of its own. Because this depends on when
the gate asks, two attempts of one run can differ, one comparing and one
not, where everything else a gate reads is fixed by the commit; once the
parent's figures exist, every attempt reads the same ones.

A rise is accepted by an `ACCEPT_COVERAGE_DEBT` marker in the change's
description, which names the member and the lines, and accepts the rise
for every measured set over that member. Two markers naming one thing
are refused, since the author meant one number and would be given the
other.

Four verdicts compare nothing, and each is one where the comparison would
be against something other than the change: a set with no baseline the
change contains, or on the default branch none at the parent; a run with a failing test, whose coverage was measured
through that failure; a set some lane measured through a failure the run
excused; and a set no report measured, either because no report was
written for it or because its reports name no line of its member.

A gate's record follows from its verdict. A rise no acceptance covers is
a failure, and a comparison that found no rise is a pass. Every other
verdict is a skip. One that compared nothing says nothing about whether
the set rose, and a pass or a failure would score the gate for a
measurement it did not make. An accepted rise is a rise a person let
through rather than a set that did not rise, and its acceptance is
usually written between a run of a commit that recorded the rise as a
failure and a re-run of the same commit, so a pass there would read as
the gate disagreeing with itself.

A gate fails a run only on a pull request, and only where the change
reaches its set and the run does not excuse it as too flaky to judge by.
Such a gate fails the run for a rise no acceptance covers, and for a set
no report measured, since the change was made to measure the set and a
rise in it cannot be ruled out. A marker that cannot be read, or that
names anything but a workspace member some set scores, fails the run as
well, because nothing consults it. A run of every test on a pull request
chooses every gate, and those whose sets the change does not reach are
judged for their records alone.

The default branch's run judges every gate on every push and fails for
none of them. It reads the markers of the pull request it merged, so that
a rise that pull request accepted is not recorded as a failure; a marker
it cannot read is reported, and every gate is judged as though nothing
were accepted.

## The manifest

One gzipped JSON object per publisher run, created — never overwritten —
under the dataset area
[the record spec describes](test-records.md#the-store). It carries the
schema version, the generation time, the exploration seed, the commit
whose tree was enumerated, how many runs the aggregate saw, every dial it
was built with, the fitted calibration numbers, every identity with its
score and its flake share and the inputs and counts behind both, the
withheld set with its reason, the
tests a configuration deliberately does not run, a reference packing into
lanes, the unschedulable list, a count and digest of known identities, and
the coverage baselines, one per measured set per default-branch run
inside `LOCAL_COVERAGE_BASELINE_DAYS`. It may carry the cost model's
health as well: per suite, its fixed charge and its tests too long for
any lane beside those of the manifest before, and what its batches spent
over what they were charged; how many lanes ran past their bound; and
what the publisher found broken in those figures.

A manifest is **untrusted input**. It is validated whole, and one bad field
rejects the object rather than leaving a consumer obeying half of it. The health
is the one exception, because nothing obeys it: a health a reader cannot read is
dropped and the rest of the manifest is read. A manifest declaring a shape from
further ahead than the reader is treated as absent, because a reader that does
not know a field cannot know what obeying the rest would mean. A reader whose
answer decides what runs takes the newest one behind it instead, since a figure
hours old is what it costs and the whole corpus is what refusing costs. It looks
back over a bounded number of them, since every candidate is a whole corpus to
fetch. A reader that reaches the end of that bound says so rather than reporting
the store as holding none: it holds several, and this reader can read none of
the ones it looked at.

A manifest declaring an earlier shape is read forward field by field. So
is the publisher's own rolling aggregate, and for a stronger reason: the
aggregate is where every new real test failure a test has been credited
with lives, over unbounded history, and no window of records the publisher
ordinarily reads gives those back.

The rules that decide whether a failure is a new real test failure change, and
the aggregate holds new real test failures as counts rather than as the failures
they came from, so a count credited under other rules cannot be judged again by
itself. The aggregate therefore names the set of rules its new real test
failures were credited under, as `NEW_REAL_TEST_FAILURE_RULE`. A publisher
reading an aggregate that names another set, or none, folds every day that
aggregate's history holds again into an empty aggregate. Records carry no
retention, so every record those new real test failures came from is folded
again under the rules in force. What that costs is one run reading the whole
history, which has to fit inside one job.

A stored aggregate the publisher cannot read is passed over for the
newest one behind it that it can. Nothing but the publisher creates an
aggregate and it creates one only where it folded, so refusing over the
newest would be refusing for good, which is why this goes further than a
consumer does with a manifest: a consumer passes over only a body
written ahead of it, where the publisher passes over a corrupt body too.
A body that fails to arrive is not passed over by either, since a read
that did not happen says nothing about what it would have read.

The walk reaches back over the days the run reads and no further, since
what a passed-over aggregate holds and the one behind it does not comes
back from the records the run reads. That bound is approximate in one
direction, because the runs that wrote the passed-over aggregates read
windows reaching earlier than their own day, and a run states what it
passed over and what it folded onto rather than claiming the gap was
closed. A run that can read no aggregate at all refuses, naming each and
what stopped it. Refusing costs a stale manifest; starting from an empty
aggregate would cost a manifest scoring every test at the floor, so a
run never does that on its own.

A cold start, the bootstrap, is the one run that starts from an empty
aggregate, and it does so only where the store holds no aggregate any
publisher can read. Where one is stored, of any day, it refuses and names
it. An incremental run folding onto it keeps every new real test failure it
holds and reads from the last day it read.

The objects the publisher has folded are the other part of an aggregate that
would otherwise grow with the store. A day the publisher has read, with every
day before it read too, closes once it is as far behind as the store waits for
late arrivals, and the aggregate records the last closed day rather than the
name of every object of the days up to it. The names of the first day its
history holds stay, since that day is where a fold of the whole history begins.
An incremental run reads from the last day its aggregate read, so no day is left
unread behind one that closes. It reads no day before both that one and the day
before today, since an object that arrives late for one would be folded after
the days that follow it, out of the order the rules judge runs in.

The selection area deletes its objects at a fixed age, which has to exceed
the longest the publisher may stop for. Every run writes a new aggregate
carrying each new real test failure forward, so an aggregate expiring costs
nothing while a newer one exists, and only an outage longer than that age
leaves none.

The area of the store both are written under is named rather than numbered,
and does not move when a shape changes. An area that moved with the shape
would leave the aggregate behind in the old one, which costs the new real
test failures and puts a manual cold start between one shape and the next,
during which nothing publishes and every consumer runs the whole corpus.

A withheld entry naming a reason the reader has no rule for is the one
thing dropped rather than refused. Refusing it would refuse the whole
manifest, a refused manifest is treated as an absent one, and an absent
manifest makes the whole corpus mandatory. Dropping the entry costs one
test its exclusion; refusing the manifest costs every test its score.

A consumer that finds no manifest runs rather than failing. Nothing then
has records, so every unit the tree holds is an identity with none, and
the rule that such an identity must run makes the whole corpus mandatory.
What a consumer must not do in that state is project from costs. Every
cost is a stand-in, so a projection is arithmetic over whatever figure
stands in for the ones nobody measured and is wrong by however wrong that
figure is; a consumer deciding how many lanes to divide the work into
takes the shape of the topology instead. The same holds for a manifest
that arrives and knows none of the tree, which is why the question is
whether anything is measured rather than whether a manifest was found. A
consumer that reports a projected time says how much of it rests on
stand-ins. A lane that could not ask the store at all is the exception to
running, for the reason under [Determinism](#determinism).

That the manifest may be an ordinary public object rather than a signed
artifact follows from what it can do. It can only change *which* tests
run. It cannot change what a test does, what a test asserts, or what the
repository builds. That holds because of what a consumer lets its strings
reach. The only ones that reach a command are suite and unit names, and
only those matching a suite and a unit the tree defines, and the commit
the manifest names, only where it is a full object id, and only to ask
git what the default branch gained after it. A test's name reaches
nothing but the list of names a runner is told to skip.

The worst a corrupted manifest achieves is a change that ran fewer tests
than it should have, which the full run on the default branch catches.

## Which tests there are

The default branch says which tests there are and where each one lives. A
consumer that keeps a rolling aggregate adds an identity, and takes the file
its records name, from the default branch's records alone. A workstation or
a pull request may be running a tree that adds, renames, or moves tests.
Read as a description of the tree, its records would describe that branch's
tree rather than the one the lanes run: a branch that moves every test would
give every test a file the default branch's tree does not hold, and leave
every test out of the manifest. So its records are evidence about the
identities the default branch recorded before them, and about nothing else.
They count toward those identities' runs, failures, flakes, and new real
test failures, and a pull request's lanes toward their costs. A failure of
any other identity still counts toward its run's crowd, since the crowd says
how much one run broke rather than anything about one test. A test a change
adds enters once the default branch records it, which is once the change
lands.

## Renames

Renaming a test costs it all of its history, and the cost falls in the worst
possible place: the count of new real test failures, `catches`, accumulates
over unbounded history and is the whole of what makes a test worth running,
so the best test in an area drops to the floor at the exact moment somebody
is working there.

`tasks/test-identity-aliases/` is what bridges the two halves, and every
reader of the store resolves through it, the publisher included. The
publisher resolves the history its aggregate already holds as well as each
record it reads, on every run, so an alias line that lands after the old
name's records were folded still moves their new real test failures to the
new name. A rename is never inferred: a wrong bridge silently credits one
test with another's record. Since the whole score rests on attributing new
real test failures, there is no downstream check that would notice.
Suggesting a line is help; writing one unasked is not.

## Removals

A test deleted from the repository keeps its records, because the store
is append-only and a record is a fact about a run that happened. So every
consumer has to be able to hold an identity nothing will ever run again,
and a consumer that keeps a rolling aggregate has to be able to let one
go.

Nothing selects such an identity. What decides where a test runs is the
working tree, and an identity the topology has no unit for is left out of
the manifest rather than carried under a name nothing can run. A manifest
published before the deletion still names it, and a consumer reconciles
the manifest against the tree before packing, so the entry drops out
there too.

A deletion is never bridged. The alias file joins a test's history to the
name it now has, and a deleted test has no such name; an alias to one
would credit another test with its record. Nothing declares a removal
either. What says a test is gone is the tree not holding it, which is the
same thing that says where every other test runs.

A consumer that keeps a rolling aggregate drops an identity on two
conditions together. No suite claims it, and no run of it has been
recorded inside the longest window the aggregate keeps counters for.
Either alone is not enough: an identity whose records never say which
unit they came from is claimed by nobody and is running, and a topology
that reads the tree wrongly stops claiming tests that are running. An
identity more than one suite claims is a defect over a test the tree
holds twice and is not a departure at all. A unit a configuration
declares unavailable, under the variant that declares it, is accounted
for rather than lost, and every identity in it is kept. Until the window
has passed over it a deleted identity is one nobody claims and which has
run, which is what it is.

A guard that compares a tree against a set of records compares it against
the records that tree produced. A tree read against an earlier run's
records disagrees with them over every test deleted in between, and over
every test renamed on the same day, since an alias reaches records from
earlier days only. Both are the repository working as intended.

## What a run on the default branch owes the change behind it

Selection trades away the guarantee that a pull request runs every test
that could have caught its regression. The counterpart of that trade is
that the run on the default branch which does catch one reports it back
to the change that caused it. A consumer of the store may build that
report; what follows is what it may and may not conclude.

Attribution is a comparison of two runs and nothing else. A test failed
for the first time at a commit when the previous run on the default
branch passed it and the run at that commit failed it. A test the
previous run did not judge — because it did not run, or skipped, or was
already failing — is not attributable to the commit, however long it has
been failing. Nothing may stand in for that comparison, and in
particular the identity of whoever merged next may not: that assumption
is exactly the mistake the comparison exists to prevent.

The previous run is the run at the commit's parent. Pushes to the default
branch are not cancelled by their successors, so two of them overlap
whenever two merges land close together; taking the run before this one
from a listing of finished runs then reaches past the run in between, and
attributes whatever that commit broke to this change.

A run's records are evidence for what they cover and for nothing else. A
run killed at its bound judged what it reached, and what it reached is
worth reading; what it did not reach is not evidence that anything is
absent. So every conclusion a consumer draws rests on a record that is
there — a failure here against a pass there, a disagreement at one
commit, a unit that recorded something — and never on a record that is
missing. A run whose records cannot be found at all is a run nothing is
known about, and in particular is not a run that skipped every test.

A test that both passed and failed at one commit is that test disagreeing with
itself, which is flake evidence rather than a new real test failure, and it is
not a first failure. An excluded identity that failed every one of its runs at a
commit and passed every one at the parent is the one statement about such a test
that several runs at one commit make available, and a consumer reporting it says
that the test is a known flaky one and that the run was not failed by it.
Whether a run excused an identity is a fact about that run, and a consumer reads
it from what the run recorded rather than working it out again from the
manifest. A run that did not apply the rule excused nothing, and one that did
withdraws an excusal wherever an invocation left an identity it was asked to
run, and the tree holds, unaccounted for. That a test is new is likewise a claim
about the store rather than about one run: an identity the store has never seen
is new, and an identity absent from one run's records is only absent from that
run.

Whether a change's own run ran a test is settled by that run's records
and by nothing else. The manifest it resolved answers the next question,
which is why it did not: held back as too flaky, or passed over by the
packing. That manifest is the one resolved at the moment the run's lanes
resolved it, which is when the commit the run tested was made. For a pull
request that commit is the merge its records name, and not the tip of its
branch, since a manifest published between the two would explain a selection the
lanes never made. A report that cannot establish that moment has no resolved
manifest. Nor does a run whose tests did not run in lanes, since no manifest
chose what it ran. Only a resolved manifest can support that last answer,
and a report without one says the run did not run the test rather than
crediting the selector with a decision nothing made. With one, an identity the
manifest holds was placed or passed over on its own. An identity it does not
hold runs wherever its unit runs: the record the run under report wrote of it
says which unit that is, and the plan says whether that unit was placed. One
whose record names no unit is read as one the packing reached.
Where the manifest says the test was to have run — the packing reached it or
its unit — a run with no record of it recorded less than it ran,
and that is a different statement from a run that did not reach it. A test the
packing did not reach is something the change did not miss, and it must be
described by what the plan the lanes computed says about leaving it out: its
unit runs whole and holds a withheld test, or no lane can hold it, or the tests
that had to run left no room in the lanes for anything else, or the lanes filled
what those tests left with other tests. A report must
not say more than the plan records, and in particular must not attribute the
choice to the test's score.

A report addresses the change and never a person. No author is named, no
figure is counted per author or per team, and no history of such reports
is kept anywhere: a report is a pure function of one run, and nothing
rolls a series of them up. A test the store has seen disagreeing with
itself is labelled as one, with the counts behind the label, so nobody is
told they broke something that breaks on its own and nobody is asked to
take that on trust.

Nothing gates on any of this. A report is best-effort, and a run on the
default branch is never failed by it.

## Determinism

The packing function is pure. No clock, no unseeded randomness, no
dependence on anything but the working tree, the manifest, the diff, the
files the default branch gained between the manifest's commit and the
change's merge base, the policy, and the lane number. That is what lets
every lane compute its own share and agree with the others by
construction. The exploration draw's seed comes from the manifest, so
the draw is the same in every lane and different between manifests.

The tree is an input alongside the manifest because the two answer
different questions. The tree says which tests exist, and the manifest
says what each of them is worth and costs; a manifest is hours old by
construction, so an entry naming a unit the tree no longer holds is work
no lane can be asked to do, and a unit the tree has gained is work no
manifest can price. A consumer reconciles the two before packing, and
packs what the reconciliation produced.

The policy is an input because one function serves both the run on the
default branch and the run on a change. It takes two values. The budgeted
policy spends a bounded amount on the tests worth the most, by the rules
under [what must run](#what-must-run-and-what-must-not) and the score
above them. The full policy requires every identity, so the discretionary
part of the packing finds nothing left to take; everything after that
behaves the same for both. The rule that keeps a test out still names a
set under the full policy, but it names the identities that are run
several times and cannot fail the run rather than identities left out of
it. A consumer that packs the two runs through different code
will drift, and what it drifts into is running different sets of tests in
the two places that are meant to agree.

Every lane has to resolve the same manifest, and so does every later
attempt of the same run. A lane resolves the newest manifest generated at
or before the moment the commit under test was made, reading the committer
date out of its own checkout.

What that moment has to be is stable rather than exact. Nothing the
scheduling service reports about when a run happened is stable, because it
reports a start per attempt rather than per run, and an attempt resolving
at its own start would pack the lanes differently from the attempt it
repeats. The commit is stable by construction, and it needs nothing from
that service: no credential, no request, and no failure path where a
request is refused. It is also the same value on a workstation as in a
job, so a dry run answers the question a lane would answer.

The committer date rather than the author date. A rebased or cherry-picked
commit keeps the author date it was first written at, which can be
arbitrarily old, while the committer date moves with the tree.

Resolution lists the manifests once and takes the newest the store had
created at or before the moment, breaking a tie between two created in the
same instant with the full object name. What it compares is the creation
time the store assigns, not the timestamp leading the object's name. The
two are different moments: a publisher names its manifest from the moment
it started and creates the object when it finishes, so the name carries a
moment at which the object was not yet there to be read. A listing that
will not say when it created an object fails rather than standing a value
in, and a lane whose listing fails does not pack, for the reason below.

That difference is what keeps the eligible set closed. Every manifest is
created at a real moment, and the lanes list after the commit was made, so
by the time any lane lists, no manifest that the store had not already
created can ever become eligible. Ordering on the name instead would leave
a manifest whose publisher is still running eligible before it exists: a
lane listing during that gap and a lane listing after it would resolve
different manifests and pack the corpus differently.

Two clocks still meet in the comparison, one on the machine that writes
the commit and one in the store. A commit dated behind the store's clock
resolves an older manifest than the tree deserves, which costs selection
quality and nothing else. A commit dated ahead of it reopens the window
above, because manifests created between the real moment and that date are
eligible while the lanes are listing. What bounds that is where the
committer date comes from: a lane resolving against a
provider-generated merge commit is comparing the continuous-integration
provider's clock against the store's. A branch commit authored on a
workstation whose clock runs far enough ahead is what escapes the bound.

One condition outside this repository has to hold. The manifests a commit
can resolve have to outlive the window in which the scheduling service
still permits that run to be re-run, which is a lifecycle rule on the
bucket rather than anything a reader controls. Where the re-run window is
the longer of the two, the retention is what to raise.

A lane that resolves no manifest because the store answered that it holds
none, or none this reader understands, still agrees with its siblings. The
store gives every lane that answer, and what the lanes then pack is decided
by the tree. Nothing has records in that state, so every unit the tree
holds is an identity with none and the whole corpus is mandatory. The
lanes divide that between them and say what they are doing.

A store that could not be asked is different. A listing or a read can fail
for one lane and succeed for the next. A lane that packed without the
manifest its siblings read would lay out a plan they are not following,
and a test each plan put in the other's lanes would run in neither while
the run passed. So a lane whose listing or read fails refuses to pack, and
says why. A count of lanes planned from the same reading refuses too.

A lane that cannot read the committer date refuses for the same reason,
and says why. A lane holds a checkout by construction, so failing to read
the date is a fault in one lane rather than a property of the run. Its
siblings may well have read the date, and no other moment the lane could
take is one they are sure to share. A count of lanes planned from the same
reading refuses too.
