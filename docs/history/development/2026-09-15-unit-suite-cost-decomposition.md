---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Investigation findings behind giving the test-selection cost model a per-unit term."
---

# Where a unit suite's batch spends its time

Measured on 2026-09-15 against labs `8ad81f2f0e`. Two sources: the five
lane artifacts of GitHub Actions run 35000579348 on the
`test-selection/pr-lanes` branch, which are continuous-integration
measurements on GitHub's Linux runners; and a workstation (Apple silicon,
Deno 2.9.4), which is faster than a runner and where every figure below is
wall clock from a warm cache.

The question this was run to answer: the test-selection cost model fitted
each suite an intercept charged once when a lane holds the suite and a
slope on the seconds its tests were planned to take, and had no term for
how many invocation units the batch opened. `Calibration.unitOverhead`
existed and was deliberately empty, with a comment saying a lane times its
batches and not the units inside them. Whether the model needed such a
term at all was the thing to settle, since the comparable investigation
for the pattern type check found that gate's cost 94% variable in its
items and about four seconds fixed.

## The lane runs its invocations one after another

`runBatch` in `tasks/ci-lane.ts` awaits each invocation in turn, so a
batch's wall time is the sum of its invocations' wall times. The worker
pool in `tasks/workspace-tests.ts`, which runs workspace members
concurrently up to `testConcurrency()`, belongs to the root `deno task
test` and is not on the lane's path at all. Within one invocation, only
`packages/schema-generator` passes `--parallel`. So nothing in a unit
suite's batch overlaps in a way a per-unit term would over-charge for.

## What a batch spends that its tests do not

For each unit-suite batch of that run, what the lane spent against the sum
of the durations its own records carry for the tests that ran in it. Lane
5's two batches failed and lane 5 is shown for completeness; the fit reads
only passing measurements.

| Lane | Suite | Units | Members | Spent | Test seconds | Residual | Per unit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `runner-unit` | 338 | 1 | 252.5 s | 67.9 s | 184.5 s | 0.546 s |
| 2 | `runner-unit` | 16 | 1 | 15.1 s | 6.9 s | 8.2 s | 0.515 s |
| 3 | `runner-unit` | 5 | 1 | 5.4 s | 2.8 s | 2.6 s | 0.513 s |
| 4 | `runner-unit` | 343 | 1 | 245.5 s | 59.0 s | 186.6 s | 0.544 s |
| 5 | `runner-unit` | 618 | 1 | 288.8 s | 58.2 s | 230.6 s | 0.373 s |
| 1 | `workspace-unit` | 202 | 21 | 315.9 s | 80.3 s | 235.6 s | 1.166 s |
| 2 | `workspace-unit` | 52 | 16 | 209.9 s | 116.9 s | 93.0 s | 1.789 s |
| 3 | `workspace-unit` | 74 | 10 | 377.3 s | 317.5 s | 59.8 s | 0.809 s |
| 4 | `workspace-unit` | 283 | 30 | 1094.8 s | 819.2 s | 275.7 s | 0.974 s |
| 5 | `workspace-unit` | 548 | 35 | 1148.7 s | 659.8 s | 489.0 s | 0.892 s |

`runner-unit` is the clean case, because it is one workspace member, so
its batch is one `deno test` process whatever it holds and a per-process
constant cannot hide in the per-unit figure. Across batches of 5, 16, 338
and 343 units — a 68-fold range — the residual per unit is 0.513, 0.515,
0.546 and 0.544 seconds. That is a 6% spread over a range that wide.

`workspace-unit` is one process per member, so it pays a process start as
well. Its residual per unit is between 0.81 and 1.79 seconds, and the two
high readings are the two batches with the fewest units per member: lane 2
held 52 units across 16 members and lane 3 held 74 across 10.

## The workstation says the same thing with the tests taken out

Running a `runner-unit` batch with `--filter` set to a pattern no test
name matches leaves every module loaded and every test registered, and
runs nothing. What is left is the process start and the module load.

| Units | Wall clock |
| --- | --- |
| 1 | 0.14 s |
| 16 | 3.13 s |
| 64 | 15.21 s |
| 128 | 29.11 s |
| 256 | 55.06 s |

A straight line through the 16-unit and 256-unit points has a slope of
0.216 seconds a unit and an intercept of −0.33 seconds; the one-unit point
puts the intercept at 0.14 seconds. So the fixed part of a `runner-unit`
batch is a fraction of a second and the rest is proportional to the units,
which is the same shape the continuous-integration residuals have at 0.53
seconds a unit on a slower machine.

The same measurement over `workspace-unit`, member by member, covers 878
files across 29 processes and comes to about 147 seconds, of which about
34 seconds is the 29 one-unit readings. Per-unit costs differ widely by
member — 0.006 s for `packages/fuse` and `packages/iframe-sandbox`, 0.04 s
for `packages/ts-transformers`, 0.20 s for `packages/cf-harness`, 0.28 s
for `packages/toolshed` — which is what a member's own `deno test` flags
buy: a member without `--no-check` type-checks every file it opens.

## What the two-term model does with those observations

Running `calibrate()` over the five artifacts gives `workspace-unit` an
intercept of 1054.7 seconds and a correction of 1.000, and `runner-unit`
an intercept of 11.3 seconds and a correction of 4.875. A lane's budget is
230 seconds. So the model priced `workspace-unit` at more than four whole
lanes before a single test of it ran, and charged a five-unit
`runner-unit` batch 30 seconds where the lane spent 5.4.

`workspace-unit` reaching 1054.7 is not the model being cautious. The
two-term model has nowhere else to put a cost that grows with the units,
so the intercept — charged once, however few units the batch holds —
absorbs the largest batch's whole per-unit bill.

## Fitting the unit count as a third term

`spent = intercept + correction × planned + unitOverhead × units`, with
the intercept raised afterwards until no observation is under-predicted,
gives:

| Suite | Intercept | Correction | Per unit |
| --- | --- | --- | --- |
| `runner-unit` | 0.0 s | 0.742 | 0.617 s |
| `workspace-unit` | 232.2 s | 1.000 | 2.906 s |

The four `runner-unit` batches were packed against planned figures of
60.6, 10.4, 3.9 and 48.1 seconds, over 338, 16, 5 and 343 units. So that
fit predicts 253.6, 17.6, 6.0 and 247.4 seconds against the 252.5, 15.1,
5.4 and 245.5 the lanes spent: within 2.5 seconds everywhere, and high on
every one of them. A 230-second lane holds about 372 of the suite's 847
units before any test cost, where the two-term model's 11.3-second
intercept and correction of 4.875 charged a lane 4.9 seconds for each
second of runner test time.

For `workspace-unit` the same fit never reaches the correction: its four
batches were charged 38.1, 21.8, 18.9 and 40.2 seconds, a span of 21.3
against the 23 a correction needs, so the unit slope is fitted alone. It
accounts for 822 of the 1054.7 seconds the two-term intercept held. The
232.2 seconds left is still more than a lane's budget.

## Why `workspace-unit` cannot be judged on these observations

The four `workspace-unit` batches were packed against planned figures of
38.1, 21.8, 18.9 and 40.2 seconds. The identities they actually ran cost,
in the manifest published at 2026-09-16T04:46:51Z from 10 runs, 238.0,
292.0, 888.6 and 1472.0 seconds — and that manifest has no entry at all
for 181, 547, 1315 and 2146 of the identities each batch ran, so those
figures are floors. `runner-unit` has no such gap: the same comparison
gives 67.6, 10.4, 3.8 and 46.9 seconds against test seconds of 67.9, 6.9,
2.8 and 59.0.

So the `workspace-unit` observations come from a manifest that under-costed
that suite's tests by a factor between 2 and 47, and no term of a cost
model recovers from a planned figure wrong by that much. What the
observations can still show is the shape: the residual per unit holds
between 0.81 and 1.79 seconds across batches from 52 to 283 units.

Coverage instrumentation was ruled out as the explanation. Running a
member's units with and without `DENO_COVERAGE_DIR` on the workstation:

| Member | Units | Plain | With coverage | Ratio |
| --- | --- | --- | --- | --- |
| `packages/memory` | 98 | 20.0 s | 30.1 s | 1.51 |
| `packages/data-model` | 61 | 8.1 s | 13.2 s | 1.62 |
| `packages/piece` | 1 | 140.3 s | 407.2 s | 2.90 |

A factor of 1.5 to 2.9, against the factor of 20 that lane 4's planned
figure is short by.

## A suite priced between the budget and the bound says nothing

A lane running a single identity may go up to `LANE_BOUND_SECONDS`, which
is 300 seconds, where a lane holding anything else stops at
`LANE_BUDGET_SECONDS`, which is 230. An identity whose lone cost exceeds
the bound is reported as unschedulable, naming the figure. Between the two
there is no report: at `workspace-unit`'s fitted intercept of 232.2
seconds, every one of its identities is schedulable on its own and no two
of them fit in a lane together, and nothing says so.
