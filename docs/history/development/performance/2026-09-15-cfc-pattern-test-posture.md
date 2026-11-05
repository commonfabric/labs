---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Measured headless labeled mapped-render and copy costs at two CFC postures."
---

# Pattern-test CFC posture measurement

Measured the shared fixture
`packages/cli/test/fixtures/cfc-flow-labels/mapped-render.test.tsx` on an
Apple M3 Max running macOS 26.4.1, Deno 2.9.4, and V8 15.0.245.2-rusty.
The checkout was based on `53baf62fdaf9dae6824bc9c5a0da812a64b95d6c`, with the
CLI posture and CFC timing changes in the working tree.

Five rounds alternated A then B, each running the same 11/50/150-row fixture.
A used `disabled` enforcement and `off` flow labels; B used
`enforce-explicit` and `persist`. Both used `--verbose --stats-threshold 0`,
`--no-idempotency-check`, and `--timing-measures-out`. The file printed both
its resolved runtime posture and the row count.

Local CLI/runner suites and other user tasks were active. These are loaded-host
observations, not quiet-machine latency estimates or measured optimization
speedups. Timing-measure collection was enabled in both arms.

## Settled intervals

Each render interval mounted, settled, and unmounted the headless reconciler
after a row-count assertion had populated the SQLite query. Compilation,
seeding, and query materialization were outside it. The separate copy interval
ran from handler send through settlement, copying each row into plain writable
data. Its stream lookup and subsequent assertion were outside the interval.

| Workload | N | A minimum / median / maximum (ms) | B minimum / median / maximum (ms) | B/A paired median ratio |
| --- | ---: | ---: | ---: | ---: |
| render | 11 | 96.4 / 148.5 / 259.5 | 218.1 / 234.9 / 285.2 | 1.48 |
| render | 50 | 324.2 / 371.2 / 495.7 | 1165.0 / 1286.1 / 1452.5 | 3.36 |
| render | 150 | 576.6 / 978.3 / 1035.1 | 8997.1 / 10081.9 / 11025.7 | 11.27 |
| copy | 11 | 28.2 / 35.6 / 76.0 | 63.0 / 74.5 / 76.1 | 1.93 |
| copy | 50 | 62.0 / 112.6 / 126.0 | 164.5 / 255.2 / 372.2 | 2.21 |
| copy | 150 | 164.0 / 204.3 / 275.3 | 960.8 / 1184.0 / 1322.4 | 5.86 |

Arm A also scales: ordinary mapping and reconciliation still visit N rows.
Its CFC preparation spans are zero throughout these measured intervals.
Arm B separates sharply as N grows; that is the regime this rung needs to
expose, rather than a claim that arm A has constant wall time.

## Preparation spans

Median cumulative span milliseconds within arm B, with calls per interval in
parentheses. Totals overlap; preparation contains derivation and the first
digest, and commit rechecking adds a second digest. They are elapsed spans,
not CPU time.

| Workload | N | prepareCfc | deriveFlowJoin | collectConsumedLabel | preparedDigestFor |
| --- | ---: | ---: | ---: | ---: | ---: |
| render | 11 | 42.6 (1) | 5.3 (1) | 0.0 (0) | 23.3 (2) |
| render | 50 | 558.2 (1) | 9.5 (1) | 0.0 (0) | 258.3 (2) |
| render | 150 | 4887.2 (1) | 47.4 (1) | 0.0 (0) | 2196.4 (2) |
| copy | 11 | 24.1 (1) | 1.0 (1) | 1.6 (1) | 3.9 (2) |
| copy | 50 | 119.4 (1) | 3.9 (1) | 5.7 (1) | 13.9 (2) |
| copy | 150 | 825.1 (1) | 14.5 (1) | 13.1 (1) | 42.0 (2) |

Rendering does not call the consumed-label collector in this fixture. The
labeled copies do, so the two workloads must remain distinct when measuring
a refusal-diagnostic optimization. The post-run label test holds enforcement
at `enforce-explicit` and checks source and copied values: column labels are
present with flow off; copied values acquire them only with flow persistence.

All ten command runs exited successfully with six passing assertions each.
Some runs emitted `memory client closed` storage-load messages during teardown,
after the measured intervals; these are retained in the raw logs. The measurements
do not establish a clean teardown diagnostic channel, browser paint latency,
or the improvement from any subsequent optimization.

## Reproduction and artifacts

The [maintained commands and boundaries](../../../development/BENCHMARKS.md#labeled-pattern-test-mapped-render)
describe how to repeat the fixture. Raw logs, timing captures, extracted samples,
and environment metadata are in the measuring workstation directory
`/Users/berni/.codex/artifacts/2026-09-15-cfc-pattern-posture/`.

Fixture SHA-256:
`f5b1b159ff6ccb98174931ef8a2553adb6de80cf8868aba42c6e849a0ea7edc0`.
