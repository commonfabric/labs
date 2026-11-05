---
status: historical
created: 2026-09-18
archived: 2026-09-18
reason: "Investigation findings behind reading a suite's per-unit cost as a rate rather than fitting it as a slope."
---

# Why a suite's per-unit cost cannot be fitted as a slope

Measured on 2026-09-18 against labs `bfc9f22105`. The source is the lane
artifacts of GitHub Actions run 35302717228, a full run of 22 lanes on the
`test-selection/pr-lanes` branch, of which lanes 1-7, 9-12, 15-20 and 22
finished. Their records hold 130 batch observations across 19 suites. Each
observation is what one lane spent on one batch, what that batch's own
tests took between them, and how many invocation units it opened.

The question this was run to answer: `Calibration.unitOverhead`, the
figure a lane is charged for each unit of a suite it opens, comes out at
exactly zero for every suite in every run. The dial that decides whether
it is believed at all, `MIN_UNIT_SPAN_UNITS`, asks that a suite's batches
have differed in size by fifty units. Whether that threshold was set too
high, or whether a slope is the wrong thing to be asking for, was the
thing to settle.

## The threshold is met or not according to how the run divided

Across those 18 lanes the widest gap between two batches of one suite was
22 units, for `workspace-unit`, whose batches held 65 to 87 units each. The
next widest were 18 units for `pattern-compat`, 13 for `runner-unit` and 11
for `pattern-unit`. Nothing came within half of fifty. The manifest the
publisher had written by 2026-09-18 carries a per-unit cost of exactly zero
for all six suites it names.

`spotsFor()` in `tasks/test-selection/plan.ts` puts an identity in the
cheapest lane that can still hold it, and separates lanes of equal cost by
how full they are, so the emptier one wins. Once a lane holds a suite,
every further identity of that suite costs the same in every lane already
holding it, and the tie sends each one to the emptiest. A suite therefore
gathers in the lanes already holding it and is shared out among them, and
where every lane fills to one budget the counts come out close.

Where the lanes do not come out even, the gap is wide. The earlier
decomposition read five lanes of an earlier run whose `runner-unit`
batches held 5, 16, 338, 343 and 618 units and whose `workspace-unit`
batches held 52 to 548; both clear fifty many times over, and the slope
fitted from the first of those came to 0.617 seconds a unit against the
0.513 to 0.546 those same batches paid. So the threshold does not put the
per-unit cost out of reach. It makes what a suite is charged a property of
how the run it was measured in happened to divide, and the reading it
falls back to when the gap is narrow is zero.

## Lowering the threshold does not help, because the slope is not there

The joint least-squares fit of what a batch spent on both what its tests
took and how many units it opened, run with no threshold at all, gives
these slopes on the unit count, with the standard error of each:

| suite | batches | widest gap, units | slope on the units | lowest rate | middle rate | highest rate |
| --- | --- | --- | --- | --- | --- | --- |
| `generated-patterns` | 18 | 6 | -2.09 ± 0.33 | 1.135 | 1.742 | 7.791 |
| `pattern-compat` | 18 | 18 | -0.01 ± 0.01 | 0.015 | 0.021 | 0.367 |
| `cfcheck` | 18 | 2 | 0.02 ± 0.02 | 0.000 | 0.000 | 0.000 |
| `runner-unit` | 15 | 13 | 1.08 ± 0.42 | 0.385 | 0.562 | 0.685 |
| `workspace-unit` | 14 | 22 | -0.17 ± 1.05 | 0.501 | 0.940 | 1.313 |
| `pattern-unit` | 11 | 11 | -20.67 ± 1.48 | 0.000 | 1.871 | 4.219 |
| `typecheck` | 10 | 4 | -4.23 ± 0.86 | 0.339 | 1.389 | 19.047 |
| `package-integration-opposite` | 5 | 3 | 3.98 ± 4.17 | 0.000 | 0.000 | 0.000 |
| `cli-deno` | 4 | 0 | — | 26.070 | 32.655 | 35.122 |
| `cli-core` | 3 | 1 | — | 10.897 | 18.968 | 19.434 |
| `package-integration` | 3 | 5 | — | 1.743 | 2.090 | 2.677 |

Five of the eight slopes are negative, which says a batch grows cheaper
the more units it opens; two more sit inside their own standard error.
`workspace-unit`, the suite the whole question is about, comes out at
minus a sixth of a second with a standard error of one second: the fit
cannot tell its per-unit cost from zero, or from two seconds, or from
minus two. The eighth is `runner-unit`, which comes out positive and two
and a half standard errors clear of zero — and its figure of 1.08 seconds
a unit is about twice the 0.513 to 0.546 seconds the same suite was
measured at directly in
[the earlier decomposition](2026-09-15-unit-suite-cost-decomposition.md).
So the one slope this run can fit is also the one that can be checked, and
it reads high by a factor of two.

Lowering `MIN_UNIT_SPAN_UNITS` to zero therefore buys little. The five
negative slopes are refused by the guard against a cost at or below zero
and stay at zero. `cfcheck` would take 0.024 a unit and
`package-integration-opposite` 3.98, both from spans of three units or
fewer. `runner-unit` would take 1.08 where it costs about 0.53. The
threshold is not what is standing between this data and a per-unit cost.

## What a batch does say on its own

The last three columns above are the rate each batch paid: what it spent
beyond its own tests, over the units that spending opened, with what its
tests took charged at the suite's own correction. Those readings are
stable in a way the slopes are not. `runner-unit`'s fifteen batches paid
between 0.385 and 0.685 seconds a unit, with 0.562 in the middle, against
a figure measured directly on a workstation at 0.513 to 0.546 and a
load-only curve of 0.216 seconds a unit on a machine faster than a runner.
`workspace-unit`'s fourteen batches paid between 0.501 and 1.313, with
0.940 in the middle, against 0.81 to 1.79 in the earlier measurement.

The rate needs no spread, because it is read off one batch rather than
across two. It is also an over-estimate by construction: the rate is what
a batch paid per unit for everything it did not spend on tests, so
whatever a batch paid for itself is in it, and the true per-unit cost is
at or below every reading. The middle reading is the one worth taking. The
highest reads a small batch's whole fixed cost as though every unit paid
it — `typecheck`'s 19.047 comes from its one batch of a single unit — and
the lowest lands under figures the same suites have been measured at
directly, because a batch's wall time moves by several seconds for reasons
that have nothing to do with what the batch held.

## What charging nothing per unit costs

Both directions, and the second is the one that kills a lane.

A batch smaller than any that has been seen is over-charged. With nothing
charged per unit, the suite's intercept holds the whole of what a batch of
eighty units spent on them, because the intercept is raised until no
observation is under-predicted. `workspace-unit` fits an intercept of 85.3
seconds, which is what a batch of about 75 files cost. A pull request's
lane holding three of those files is charged all of it, against a
`LANE_BUDGET_SECONDS` of 230: 37% of the lane, before any test runs.

A batch larger than any that has been seen is under-charged, and nothing
bounds by how much. The charge for a lane holding the suite is the
intercept plus the correction against the selected tests' own cost, and
neither term grows with the units. So a lane may pack the suite's cheapest
units in numbers no batch has ever held, against a charge that stops
rising. At one second of test time a unit, `workspace-unit`'s old figures
put 142 units inside a 230-second budget, at a projected 229.4 seconds.
The earlier decomposition measured that suite at 0.81 to 1.79 seconds a
unit, so those 142 module loads cost between 115 and 254 seconds that the
budget does not account for, against the 70 seconds between the budget and
the 300-second bound the lane job is killed at.

The table below reads both models out at the whole suite in one batch. The
last column is what the run actually spent on that suite, summed over the
lanes that held it, which is above what one batch would spend by however
many times the suite's own fixed cost was paid.

| suite | units | correction | old intercept | new intercept | per unit | old, whole suite | new, whole suite | run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `generated-patterns` | 122 | 0.380 | 15.6 | 12.1 | 1.742 | 291 | 500 | 493 |
| `pattern-compat` | 306 | 0.502 | 0.5 | 0.3 | 0.021 | 239 | 245 | 245 |
| `cfcheck` | 295 | 1.000 | 0.0 | 0.0 | 0.000 | 207 | 207 | 118 |
| `runner-unit` | 874 | 1.201 | 41.8 | 7.5 | 0.562 | 1755 | 2212 | 2210 |
| `workspace-unit` | 1051 | 1.015 | 85.3 | 24.2 | 0.940 | 3246 | 4172 | 4087 |
| `pattern-unit` | 115 | 0.393 | 54.3 | 24.3 | 1.871 | 1037 | 1222 | 1170 |
| `typecheck` | 35 | 0.490 | 19.0 | 17.7 | 1.389 | 208 | 255 | 245 |
| `cli-deno` | 4 | 1.000 | 35.1 | 2.5 | 32.655 | 58 | 156 | 149 |
| `cli-core` | 10 | 0.362 | 58.3 | 1.4 | 18.968 | 409 | 542 | 509 |
| `package-integration` | 38 | 1.265 | 33.4 | 6.5 | 2.090 | 488 | 541 | 537 |

The old figures under-predict the whole suite for nine of these ten: by
61% for `cli-deno`, 41% for `generated-patterns`, 21% for `runner-unit`
and `workspace-unit`, 20% for `cli-core`, 15% for `typecheck`, 11% for
`pattern-unit`, 9% for `package-integration` and 3% for `pattern-compat`.
The tenth is `cfcheck`, whose batches finish in half the time their own
tests take and whose correction stays at one for want of a span, so it is
over-predicted by 75% under both. The new figures are at or above the
run's own total for all ten, by between 0.0% and 6.3%.

## What changed

`unitOverhead` is read as the middle rate rather than fitted as a slope,
and `MIN_UNIT_SPAN_UNITS` is gone. The intercept is what the rate leaves,
read as it always has been: the largest residual no other term accounts
for. The correction keeps its own sample count and span threshold, which
are about fitting a line and are unaffected.

The trade that leaves is one the observations cannot settle either way. A
batch far smaller than any that has been seen is now charged a per-unit
cost that already carries a share of whatever the batch pays for itself,
so it may be charged less than the whole of that fixed cost. What that can
be wrong by is bounded by the suite's own fixed cost — one process start
for `runner-unit`, measured at 0.14 seconds on a workstation — where
charging nothing per unit is wrong by the per-unit cost times however many
units a lane packs, which nothing bounds. The intercept covers the
difference comfortably on this data: `workspace-unit` keeps 24.2 seconds
of intercept against batches whose smallest residual was 37.1 seconds.

## A correction fitted alone can take the whole of what a unit costs

The rate is read from what a batch spent beyond its own tests, and what
its tests are charged is the correction. The correction is fitted from the
tests alone, and within a suite more units usually means more seconds of
tests, so a correction fitted too high takes some of what a unit costs
with it. Where it takes all of it, every batch reads as having spent
nothing on its units and the suite is published charging nothing a unit —
which is the reading the whole change exists to replace.

One suite in this run does exactly that. `package-integration-opposite`
fits a correction of 1.786, whose line implies a fixed cost of minus 21.7
seconds, and every one of its five batches then reads as having spent
nothing beyond its tests:

| units | tests | spent | spent less tests | rate at a correction of one |
| --- | --- | --- | --- | --- |
| 8 | 104.1 | 163.5 | 59.4 | 7.42 |
| 9 | 71.4 | 104.7 | 33.2 | 3.69 |
| 9 | 117.6 | 185.2 | 67.7 | 7.52 |
| 10 | 114.5 | 175.1 | 60.5 | 6.05 |
| 11 | 110.4 | 188.5 | 78.1 | 7.10 |

A fixed cost below nothing is not a figure the model can carry, since a
suite's intercept is charged at or above zero. So a correction whose line
implies one is refused and the suite keeps a correction of one, which
gives this suite a per-unit cost of 7.102 seconds, an intercept of 3.8,
and a whole-suite reading of 856 seconds against the 817 the run spent —
above it, where the fitted correction gave 925.

It is the only suite of the nineteen the refusal changes. Two figures that
are equal for a suite spending exactly in proportion to its tests are
differenced to reach the fixed cost, so the comparison allows for what
that arithmetic leaves behind; a suite the refusal catches is out by
seconds rather than by parts in a billion.

## Three other ways of splitting the two, measured

Each of these was raised in review and each was fitted over the same 130
observations. The summed intercept across all 19 suites is 96.5 seconds
for the reading that landed and 538.4 for the one it replaced, which is
the figure to read the first two against. A fourth proposal, which keeps
the slope and changes what gates it, is in the section after them.

**Leave the per-unit charge out of the intercept**, so that the intercept
is the largest residual outright and each term over-estimates on its own.
The model is then above both readings at every batch size, which is the
property the split gives up. It also charges `workspace-unit`'s intercept
of 85.3 seconds to a lane holding three files, which is the charge this
whole change exists to remove; the three files come to 88.1 seconds rather
than 85.3. Summed intercept: 538.4 seconds, the same as before.

**Credit the intercept with one unit**, so that the intercept is the
largest residual less one unit's rate. This is the tightest version of the
same idea: the prediction at one unit is exactly the largest residual, so
it is above both readings for every batch of one unit or more. It charges
three `workspace-unit` files 87.2 seconds. Summed intercept: 450.1
seconds. Both of these are safe in both directions and neither moves the
figure the measurement was run to move.

**The tightest line that bounds every observation from above**, found as
a two-variable linear program over the constraints that no observation is
under-predicted and neither figure is negative. This is the cheapest model
with the in-sample guarantee, and on this data it returns a per-unit cost
of exactly zero, with the old intercept, for `workspace-unit` (85.32),
`generated-patterns` (15.58), `typecheck` (19.05), `cli-deno` (35.12) and
`cli-core` (58.30). In-sample is where the two terms cannot be told apart,
so a criterion that reads only in-sample resolves the split by putting
everything in the term that is charged once.

## Gating the slope differently rather than replacing it

**Gate a fitted slope on the seconds it explains** rather than on a count
of units, so that both regressors are held to `MIN_CORRECTION_SPAN_SECONDS`
in one currency. This keeps the slope and changes only what decides
whether it is believed, so it is not a way of splitting the two. It does
not work: the two conditions multiply. A slope clears the gate when its
own value times the span in units reaches the threshold, so the narrower
the span the larger the slope needed, and the noise slopes a narrow span
produces are exactly the large ones. `typecheck` illustrates it: a span of
four units and a rate reading of 19.047 from a batch of one.

## What would settle the split rather than choose it

A lane times each invocation it makes, and a suite's invocations are not
its units: `workspace-unit` issues one per workspace member, `typecheck`
one for the whole batch, a file suite one per part. Those three counts —
batches, invocations, units — differ from each other across batches in a
way the units alone do not, so recording the invocation count beside the
three figures a lane already writes would separate a cost paid once per
batch from one paid per invocation and one paid per unit. That is a
measurement rather than a choice between two readings the data cannot
distinguish, and it is the thing to do next.

## Varying the batch sizes deliberately was considered and rejected

A packer that gave one lane twice another's share of a suite would produce
the spread a slope needs. Three things argue against it.

The spread needed is large. `workspace-unit`'s residual across its
fourteen batches has a mean of 66.2 seconds and a standard deviation of
16.0, and 22 units separate the largest batch from the smallest, so
almost none of that variation can be read as size. A slope's standard
error is that deviation over the root
of the summed squared deviations of the sizes, so for fourteen batches
spread evenly over a range, a slope determined to a tenth of a second a
unit needs a range of about 150 units. The suite's mean test cost is 2.96
seconds a unit, so a lane holding 150 units more than its neighbour holds
about 440 seconds more work — most of a full run's lane, and nearly twice
a pull request's lane budget.

The observation is lost in the case it is most wanted. A lane killed at
its bound writes none of a batch's three measurements, because the three
are written together when the batch finishes. So the unbalanced lane that
would carry the wide reading is the one most likely to record nothing.

It buys nothing for the small suites. `typecheck` holds 35 units in all
and `cli-core` holds 10, so no division of either produces a gap of fifty,
or of five.

Against all three, reading the rate needs no spread at all.
