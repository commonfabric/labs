---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "First-batch read-accounting measurements and generic reduction baselines."
---

# Pattern read accounting: first-batch baseline

Measured against base commit `16de7e0c87` with the uncommitted read-accounting
implementation, using Deno 2.9.4 on macOS arm64. This record covers A1/A2 and
the available portion of A0 in `docs/history/plans/pattern-computation-cost.md`.
It does not establish a speedup for an incremental aggregate: those operators
are not implemented by this batch.

## Reduction baselines

`packages/runner/test/read-stats.test.ts` runs native reductions over lazy,
schema-typed cell views in subscribed scheduler actions. It changes one row's
numeric field from 0 to 10 and waits for the runtime to become idle. These
tests measure the reduction body and its subscriptions, not the full authored
compiler/builtin graph or an aggregate's output commits.

| Reduction | 10 rows | 100 rows | 1,000 rows | Update runs |
| --- | ---: | ---: | ---: | ---: |
| Count with an even-number predicate | 20 | 200 | 2,000 | 1 |
| Sum | 20 | 200 | 2,000 | 1 |
| Minimum | 20 | 200 | 2,000 | 1 |
| Maximum | 20 | 200 | 2,000 | 1 |
| Element with minimum field | 29 | 299 | 2,999 | 1 |
| Element with maximum field | 29 | 299 | 2,999 | 1 |
| Count without a predicate | 0 | 0 | 0 | 0 |

Numbers are proxy accesses after the edit. Initialization is excluded. The
element-returning reductions also read the selected element's numeric field
inside the action so the asserted result is a scalar.

An unconditional count does not depend on an element's numeric field, so that
edit correctly leaves it clean. A separate append test grows 100 scalar
elements to 101; its generic count reduction reads all 101 elements.

Both schema views and query result proxies count two consecutive sum scans as
`4N` accesses even when the second scan reuses cached views. The tests also
cover iterator reads, actual link-resolution work versus memo hits, independent
overlapping transactions, cumulative/per-run statistics, disabled accounting,
and cleanup after an action throws.

Reproduce the assertions from the repository root:

```sh
ENV=test deno test --no-check \
  --preload=packages/runner/test/clock-preload.ts \
  --allow-ffi --allow-env --allow-read --allow-write=/tmp,/var/folders \
  packages/runner/test/read-stats.test.ts
```

The next aggregate comparison should use equivalent authored patterns at the
same sizes, check identical results, and count all scheduler work through each
update. Runtime benchmarks must additionally measure aggregate maintenance,
output writes, and commits.

## Lunch-poll command

```sh
deno task cf test packages/patterns/lunch-poll/main.test.tsx \
  --verbose --stats-threshold 0 --no-idempotency-check
```

The test passed all 36 assertions. It has 74 test steps; that is not a
74-vote population. Its demand-driven computations frequently run when an
assertion reads an output, rather than during the preceding action's settle.

In the recorded run, `assertion_29` performed 110 scheduler runs and 39,478
proxy accesses, 3,596 link hops, 1,169 per-run documents summed, and 3,663
per-run scheduling dependencies summed. The assertion at
`lunch-poll/main.test.tsx:550:61` walked the rendered UI and accounted for
38,676 accesses across five runs, with a maximum of 11,220 in one run. The
tally at `lunch-poll/main.tsx:1499:19` accounted for 268 accesses across two
runs, 134 in each. Source attribution distinguishes this test-harness work
from the tally itself.

These are observations of this headless test, not the deployed vote-cost
table. Async demand and intermediate settling can change run counts; these
observations are not asserted as fixed budgets. The original 74-vote deployed
figures remain unconfirmed under A0, with representative read-side measurement
and the probe/deployed discrepancy reserved for A4/A5. No deployed board was
modified or measured in this batch.

## Instrumentation overhead

The disabled read sites check a shared boolean. When no action is being
measured, they perform no counter lookup or allocation. Active accounting uses
transaction-keyed counters and a set of document records.

The benchmark is `packages/runner/test/read-stats.bench.ts`, a reduction of
1,000 linked rows in a fresh transaction. Four disabled-accounting trials used
the order original/instrumented/instrumented/original. The original trials
temporarily restored the six read-path files from the base commit; all working
changes were restored afterward.

| Trial | Read-path instrumentation | p75 |
| --- | --- | ---: |
| 1 | Absent | 15.1 ms |
| 2 | Present, disabled | 15.0 ms |
| 3 | Present, disabled | 17.9 ms |
| 4 | Absent | 16.1 ms |

A subsequent enabled/disabled benchmark reported 20.2 ms disabled and 15.5 ms
enabled at p75. This reversal and the variation above make a tight overhead
percentage unsupported. The benchmark is retained for further measurement;
these samples establish neither a throughput improvement nor zero timing
overhead. The allocation-free disabled read path is a code property.

## Validation

- Repository type check passed; subsequent focused type checks cover the
  expanded tests and final instrumentation changes.
- Runner package suite: 1,400 tests and 8,641 steps passed. The expanded
  read-accounting suite subsequently passed all 36 steps; scheduler timing
  tests also passed after the accounting boundary change.
- CLI package suite: parallel phase 1,819 tests/2,881 steps, all-access phase
  one test, and serial phase 218 tests/683 steps passed. Subsequent focused
  report and CLI-output tests passed five steps.
- The CLI suite required execution outside the macOS sandbox for its local
  servers, and `env -u NO_COLOR TERM=xterm-256color` for color tests. A minimal
  Cliffy-only probe reproduced the terminal-dependent failures without
  importing changed code.
- All 597 checked documentation code blocks passed. Repository formatting,
  lint, and CLI completion-slot checks passed before the final documentation
  record was added.

The counters cover a scheduler action's own transaction through action
completion. They exclude event-handler transactions, commit preparation,
verification replay, and plain JavaScript arithmetic. Dependency counts are
compacted scheduling reads before commit preparation, not the union of all
scope instances' retained subscriptions. CLI read-cost tables cover the
single-runtime runner; the verification-disable option also reaches
multi-user workers.
