# Choosing which tests a change runs

The contract of test selection: what a test is worth running, what the
manifest that says so contains, and what a consumer of one may and may
not conclude from it. This is the normative description of the shipped
parts; [the operating guide](../development/test-selection.md) says how to
use them, and
[the plan this comes from](../plans/pull-request-test-selection.md) carries
the reasoning and the parts still to be built. It rests on
[test-run records](test-records.md), whose store it reads and beside whose
dataset area it writes. The implementation is `tasks/test-selection/`, and
the manifest format itself is
`packages/test-support/src/records/selection.ts`, beside the record schema
it is the counterpart of.

## What the score measures

A test earns its place by having caught real breakage before. That is a
property of the test rather than a symptom of a problem: a test that found
a regression once sits somewhere mistakes get made, and it will find the
next one. So the score is built on catches and decays over months rather
than days.

That is a different quantity from "this test is currently flaky", and the
two are never scored together. A test failing a third of the time carries
almost no information per failure; a test that failed four times in two
years, each time because somebody broke something, carries a great deal.
Flakiness is dealt with separately, below.

### What a catch is

For every failing record, the publisher asks whether the failure says
something about a change or something about the test. A failure is a
**catch** unless one of these holds:

- The identity was already failing in the most recent run on the default
  branch. The test was already broken and this run learned nothing.
- The identity both passed and failed at the same commit, with nothing
  between the two runs but chance. That is a flake observation, and it is
  counted as one.
- The identity failed across at least `ENVIRONMENTAL_MIN_SOURCES` distinct
  sources within `CATCH_BREADTH_WINDOW_DAYS`. That is the environment or a
  dependency, not any one change.

Each catch is attributed to the pair of the commit and the source that saw
it, so re-running one broken commit ten times counts once. A source is the
branch for a continuous-integration run and the reporting person's login
for a local one.

A failure on the default branch cannot be judged when it happens. Every
push there is a distinct commit with one run, so a test that is flaky
there never contradicts itself, and counting each such failure as a catch
would make the least valuable test in the repository look like the most
valuable. Such a failure waits for the next run on that branch. Still
failing is the same breakage continuing, and nothing new is learned.
Passing at the same commit is the test disagreeing with itself, and counts
as a flake observation. Passing at a later commit counts as a catch: the
change between the two commits fixed what the test found. A run of
failures ended by one pass counts one catch, dated to the first of them,
so a week of the branch being red is worth one catch and not seven.

Nothing separates a failure a change fixed from one that healed itself, so
a test flaky on the default branch is credited for its own noise. The
judgement errs toward crediting a test rather than away from it. An
overstated score costs run time, and an understated one costs a test its
place.

### Where a catch happened

A catch is always a point in the test's favor, and the place says
something further.

- A **local catch** — somebody at a workstation, part way through writing
  something — is the highest-quality evidence this system can receive, and
  counts double.
- A **pull-request catch** is continuous integration doing its job.
- A **catch on the default branch** is a recorded escape: this test would
  have prevented a red default branch had it run on the pull request, and
  it did not. It counts one and a half times, which is the feedback loop
  that fixes that on its own.

### The formula

```text
catches   = CATCH_WEIGHT_LOCAL * localCatches
          + CATCH_WEIGHT_PR    * prCatches
          + CATCH_WEIGHT_MAIN  * mainCatches

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
- A test with **no catches but recent failures** — every one classified as
  flake evidence, or as a continuation of an already-broken default branch
  — scores `VALUE_FLOOR + WEIGHT_CHURN * churn`, and never a missing
  value. The branch for a test with no catches is written out rather than
  left to the algebra: there is no date to measure freshness from, and
  multiplying zero by a missing number yields a missing number, which
  sorts unpredictably against real scores.

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
| `sources` | unbounded, counted only over catches |
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

`cost` is the largest of the days' ninetieth percentiles inside its
window: the ninetieth rather than the maximum, because one unlucky runner
should not permanently inflate an estimate, and the largest across days
rather than an average, because a cost model that under-estimates blows
the time budget.

A day is one population, whatever order its records reached the store in
and however many runs read them. A day is therefore held as its slowest
executions and the count of all of them, so that the parts a day arrives
in combine into the percentile of the whole. Holding a percentile of each
part instead would let a part carrying one execution report that
execution as the percentile of every execution beside it.

Only executions that passed are measured. A cost predicts what a lane
will spend running the test again, and a failure measures something else.
It ended where the failure was reached. Where a wait's safety net ended
it, its duration is that net's bound. The bound a safety net carries and
the bound a lane is killed at are the same order of magnitude, so a test
that hits one is otherwise reported as fitting no lane and held out of
every pull request that does not touch it.

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
sharpens itself on exactly the tests it is least sure of.

Nothing is charged against the count, and no belief about how tests
usually behave survives into it. **A disagreement is a proof rather than a
sample**: a test that is deterministic cannot pass and fail at one commit,
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
several tests disagree at one commit holds out the ones with few runs
behind them. The rule that reads a failure across many sources as the
environment covers catches and not disagreements, and extending it is what
would fix this.

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
passed at a later commit, is credited as a catch. The identity returns to
changes with a share near nothing and a score raised by its own noise. Two
rules answer this, and a consumer may apply the first without the second.

**An excluded identity that may be run without its neighbours runs as many
times as its share asks for.** The count is the one the line already gives
that share, which runs past the exclusion rate. Several runs at one commit
are what let a share rise as well as fall, and they also put a pass beside
a spurious failure at its own commit, which classifies it as a
disagreement rather than crediting it as a catch.

Every run of it at that commit takes one invocation shape, since a
consumer that runs the identity once beside its neighbours and again on
its own has arranged for a test sensitive to that difference to disagree
with itself at every commit, and the exclusion would then never reverse.
An identity that may not be run without its neighbours therefore keeps its
single run: running its whole unit several times would run every
neighbour several times, and a neighbour that is not flaky would fail the
run several times as often for it.

What several runs at one commit cannot separate is a bad machine. A
consumer that runs them together runs them on one machine, so a machine
that fails one fails all, which is no disagreement at all. The rule that
reads a failure across many sources as the environment covers catches
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
asked to run, since one that recorded a withheld failure and then stopped
has run almost nothing while satisfying any weaker test. A stand-in for a
unit the store has never seen is accounted for by that unit recording
anything at all, because no record can carry a stand-in's name: a record
is named for a test and a stand-in for a file. And a unit that recorded
nothing recorded nothing under any name, which fails the run whether or
not anything was there to excuse.

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
is past what a lane is killed at is placed in a lane regardless, and what
that produces is a lane that runs long and says by how much. The
alternative is a run that reports a pass over a test it decided not to
run, which is the one failure this design will not have: a consumer is
told a test did not run, never left to infer it from a green result.
Weighing cost is for the identities nothing requires, and the list of
work no lane can hold names those alone.

The count of runs is the one thing that bends. An identity that would be
repeated and fits nowhere runs fewer times, down to once, since all of
one identity's runs go in one lane and one observation beats none. Down
to once and never to nothing.

A plan says what a suite costs it, as well as what a test does. A lane
pays a suite's overhead, what one of its units costs to open, and its
capabilities' setup before it runs anything of that suite, and that
charge is the same for every identity the suite has. Where it alone passes what a lane holding
two things may take, nothing can share a lane with one of the suite's
identities, so the suite takes a whole lane for each one it places; where
it passes what a lane is killed at, no lane can hold the suite and every
discretionary identity it has fits nowhere. Both are reported once for
the suite, and the identities of a suite in the second case are left out
of the report that names identities, since the suite's line says what
every one of them would.

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
- **What the change touches must run.** A changed test file's identities
  are mandatory. Everything else a change forces in goes through one
  rule, and there is no second rule beside it: a declaration names the
  paths a change reaches something by, and what a change reaches is what
  it forces. That is how a unit which is not a file — a type-check group,
  a repository gate, a binary — is reached at all, because only its suite
  knows what its unit covers. Anything else that has to answer "which
  parts of this repository did the change touch" answers from the same
  declarations, including a consumer deciding not which tests to run but
  which packages to measure. A second mechanism for the same question is
  a second thing to be wrong about, and the two would disagree.

  A declaration is bounded rather than exhaustive, so that what a change
  runs stays mostly what the score chose. No one unit may be reached by a
  significant share of the tree, and no one file may reach a significant
  share of the units. Something whose input is a large part of the
  repository declares the small and specific part of it, or declares
  nothing and is reached by the score alone. Declaring too little costs
  only that; declaring too much places the unit in every lane by
  declaration rather than by what it has caught. Nothing about a changed
  source file forces a test in except through a declaration that reaches
  it. Which tests run for it otherwise is what the score decides.

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
by. Those paths are declarations in the sense above, and reaching one is
what makes every unit of the set mandatory: the coverage gate adds no
second way of asking what a change touched. A set every one of whose
units the configuration deliberately does not run is not a set at all,
since scoring it would score whatever else happened to write into its
directory.

Four rules hold of every measurement.

- **Each set is counted on its own.** A set's units write their coverage
  profiles into a directory named for the suite and the member, and a
  set's count is converted from that directory alone. Two sets over one
  member are two counts and are never added together, and neither is
  added to the source group of the same name, which is the same lines
  measured by every test in the run.
- **Measuring a set does not change how often anything runs.** Its units
  are mandatory, so they leave the selectable set and no later pass
  takes them again; each runs as many times as its own flake rate asks
  for, which is the count anything else in the run would have given it,
  and a repeat reaches that unit and no other. A repeat leaves the set's
  number where it was, since a count is the union over what the runs
  reached. Two sets reaching one suite run the union of their units.
- **A set's lines are its member's own tree**, less the tree of any
  member nested inside it, counted by the rules the repository-wide
  metric already uses. A member's browser half is not part of any set,
  so that adding a test needing a browser costs a member nothing here,
  and what that half reaches is not counted toward the set.
- **Nothing about coverage fails a run on the default branch.** That run
  measures every set, which is where the baselines come from, and merges
  every report it produced into the one repository-wide figure, which is
  a trend rather than a gate.

A change forces the sets it reaches when it reaches at most
`LOCAL_COVERAGE_MAX_SETS` of them. Past that it forces none, rather than
some of the ones it reached, and what stopped the forcing is reported.

What is scored is a separate question from what is forced. Forcing costs
a run the whole of a set's unit list, and the cap is what bounds that
cost. Whether a number may be compared against the baseline turns on
whether the set ran whole, so every set the change reached that some run
measured is scored, however that run came to measure it. A run that
measures every set — which is what the default branch does, and what a
change may ask for — has produced comparisons exactly as sound as forced
ones.

A set is compared against the count the same set had at the newest
default-branch commit the change contains, which the manifest carries.
Newest is settled by the order of those commits in the default branch's
own history, and never by when the run that measured one was created: a
re-run of an older commit produces a later run of an earlier tree.

Five states report rather than fail, and each is one where the
comparison would be against something other than the change: a set with
no baseline the change contains, a set the cap left unforced that no run
measured, a set no report was written for, a set whose reports name no
line of its member and so measured nothing, and a run with a failing
test, whose coverage was measured through that failure.

A rise is accepted by an `ACCEPT_COVERAGE_DEBT` marker in the change's
description, which names the member and the lines, and accepts the rise
for every measured set over that member. Two markers naming one thing
are refused, since the author meant one number and would be given the
other. A marker naming neither a workspace member nor a coverage source
group fails, because nothing would ever consult it.

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
inside `LOCAL_COVERAGE_BASELINE_DAYS`.

A manifest is **untrusted input**. It is validated whole, and one bad
field rejects the object rather than leaving a consumer obeying half of
it. A manifest declaring a shape from further ahead than the reader is
treated as absent, because a reader that does not know a field cannot
know what obeying the rest would mean. A reader whose answer decides
what runs takes the newest one behind it instead, since a figure hours
old is what it costs and the whole corpus is what refusing costs. It
looks back over a bounded number of them, since every candidate is a
whole corpus to fetch. A reader that reaches the end of that bound says
so rather than reporting the store as holding none: it holds several,
and this reader can read none of the ones it looked at.

A manifest declaring an earlier shape is read forward field by field. So
is the publisher's own rolling aggregate, and for a stronger reason: the
aggregate is where every catch a test has been credited with lives, over
unbounded history, and no window of records gives those back.

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

The area of the store both are written under is named rather than
numbered, and does not move when a shape changes. An area that moved
with the shape would leave the aggregate behind in the old one, which
costs the catches and puts a manual cold start between one shape and the
next, during which nothing publishes and every consumer runs the whole
corpus.

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
stand-ins.

That the manifest may be an ordinary public object rather than a signed
artifact follows from what it can do. It can only change *which* tests
run. It cannot change what a test does, what a test asserts, or what the
repository builds. The worst a corrupted manifest achieves is a change
that ran fewer tests than it should have, which the full run on the
default branch catches.

## Renames

Renaming a test costs it all of its history, and the cost falls in the
worst possible place: `catches` accumulates over unbounded history and is
the whole of what makes a test worth running, so the best test in an area
drops to the floor at the exact moment somebody is working there.

`tasks/test-identity-aliases/` is what bridges the two halves, and
every reader of the store resolves through it, the publisher included. A
rename is never inferred: a wrong bridge silently credits one test with
another's record, and since the whole score rests on catch attribution
there is no downstream check that would notice. Suggesting a line is help;
writing one unasked is not.

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

A test that both passed and failed at one commit is that test
disagreeing with itself, which is flake evidence rather than a catch, and
it is not a first failure. An excluded identity that failed every one of
its runs at a commit and passed every one at the parent is the one
statement about such a test that several runs at one commit make
available, and a consumer reporting it says that the test is a known flaky
one and that the run was not failed by it. That a test is new is likewise
a claim about the store rather than about one run: an identity the store
has never seen is new, and an identity absent from one run's records is
only absent from that run.

Whether a change's own run ran a test is settled by that run's records
and by nothing else. The manifest it resolved answers the next question,
which is why it did not: held back as too flaky, or passed over by the
packing. Only a resolved manifest that holds the identity can support
that last answer, and a report without one says the run did not run the
test rather than crediting the selector with a decision nothing made.
Where the manifest says the test was to have run — the packing reached
it, or the store has never seen it, which makes it mandatory — a run
with no record of it recorded less than it ran, and that is a different
statement from a run that did not reach it. A test the packing did not
reach is coverage this design traded away rather than something the
change missed, and it must be described that way. The failure raises the
test's score, so the next change in that area runs it.

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
policy, and the lane number. That is what lets every lane compute its own
share and agree with the others by construction. The exploration draw's
seed comes from the manifest, so the draw is the same in every lane and
different between manifests.

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
in, and the lane goes on with no manifest.

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

A lane that resolves no manifest still agrees with its siblings, because
what it packs is decided by the tree rather than by what it failed to
read. Nothing has records in that state, so every unit the tree holds is
an identity with none and the whole corpus is mandatory. The lanes divide
that between them and say what they are doing.

A consumer with no commit to read falls back to the newest manifest there
is and reports that it has done so. That is the answer for a tool invoked
outside a checkout, where there is no tree under test and no other lane to
agree with. A lane holds a checkout by construction, so the moment it
resolves for comes from the commit rather than from this fallback.
