---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Measured writer-fit refusal-attribution deferral on the shared labeled-render fixture."
---

# Writer-fit refusal attribution measurements

The change moved structured writer-fit attribution behind `writerFitRejects`.
Successful persist-and-flag copies retained their diagnostics and derived labels,
while recording no refusal details and doing no consumed-label attribution walk.
Strict refusals retained their reason text, input addresses, atoms, and complete
attribution. Sink-ceiling and host-release collection sites were unchanged.

## Scope and method

The source baseline was `53baf62fdaf9dae6824bc9c5a0da812a64b95d6c`.
Both arms carried identical counter instrumentation and the same temporary test
harness; only the writer-fit gate placement differed. The fixture was the frozen
`packages/cli/test/fixtures/cfc-flow-labels/mapped-render.test.tsx` from the shared
benchmark task's commit `88d55af6c0`. Its harness plumbing was not cherry-picked:
the frozen harness explicitly selected `enforce-explicit` plus `cfcFlowLabels:
"persist"`, the shared benchmark's arm B. Server execution was disabled.

The fixture seeds 150 SQLite rows with `fixture-private` confidentiality on
`title`, queries 11, 50, and 150 rows, verifies each result count before rendering,
materializes its mapped view, then copies the rows into an ordinary Writable and
verifies the copy count. All six assertions passed in every measured run. The
idempotency replay was disabled to keep each phase represented once.

Five unprofiled pairs used alternating before/after order and a fresh Deno
process per run. Each process ran the N ladder in order. Three further alternating
pairs used V8's inspector CPU profiler at a requested 500-microsecond sampling
interval; those wall times are excluded from the timing medians. The machine was
an Apple M3 Max, Deno 2.9.4, V8 15.0.245.2-rusty, TypeScript 6.0.3.
Concurrent local work caused substantial host load, recorded with every run.
These are loaded-host observations, not a quiet-machine speedup claim. No outlier
was discarded. No browser worker was profiled; the headless harness exercises
the runtime locally, so its profile does not establish a browser worker CPU share.

## Successful-commit counters

For the measured copy action at each N, the delta was identical across all five
wall-time runs and all three profile runs:

| N | Before details / walks | After details / walks | Prepared / rejected, both arms |
| --- | --- | --- | --- |
| 11 | 12 / 1 | 0 / 0 | 1 / 0 |
| 50 | 51 / 1 | 0 / 0 | 1 / 0 |
| 150 | 151 / 1 | 0 / 0 | 1 / 0 |

There is one detail per measured write path, including the array length, but
only **one consumed-label walk per prepare**, because `refusalSources()` memoizes
its result. Thus the original estimate of one walk per write path overcounted
that part. Reading every caller confirmed that this closure has only the
writer-fit caller. The other three direct calls belong to sink-ceiling checking
and host-release refusal attribution; they can still run on succeeding operations.
The public counters measure actual work, not a universal count of failed commits.

The render phases recorded zero attribution details and zero label walks in both
arms. The labeled copy is essential to this experiment: rendering alone does not
exercise the optimized writer-fit path.

## Wall times

All values below are milliseconds. Raw values are in repetition order; before and
after reverse execution order on even repetitions. The group is the sum of query
assertion, materialization, copy action, and copy assertion durations. It excludes
initialization, seeding, and marker actions; it is not whole-process wall time.

### Labeled copy action

| N | Arm | Raw values | Median |
| --- | --- | --- | --- |
| 11 | before | 57.828, 69.075, 53.803, 62.295, 78.106 | 62.295 |
| 11 | after | 86.662, 64.105, 70.474, 118.278, 62.221 | 70.474 |
| 50 | before | 330.501, 282.296, 334.784, 288.932, 260.373 | 288.932 |
| 50 | after | 413.638, 272.754, 240.981, 320.745, 281.617 | 281.617 |
| 150 | before | 1216.749, 1030.953, 1032.340, 1070.705, 1109.549 | 1070.705 |
| 150 | after | 787.465, 676.493, 2220.300, 705.439, 694.810 | 705.439 |

### Mapped-view materialization

| N | Arm | Raw values | Median |
| --- | --- | --- | --- |
| 11 | before | 236.365, 223.438, 354.022, 161.767, 252.488 | 236.365 |
| 11 | after | 233.420, 228.343, 227.981, 208.977, 200.913 | 227.981 |
| 50 | before | 1355.224, 1190.111, 1437.495, 1212.608, 1275.003 | 1275.003 |
| 50 | after | 1406.214, 1470.372, 1123.477, 1328.594, 1075.479 | 1328.594 |
| 150 | before | 11302.357, 9777.886, 10349.461, 9065.273, 9738.326 | 9777.886 |
| 150 | after | 9341.388, 8603.112, 7039.372, 10812.392, 8217.204 | 8603.112 |

### Query, render, copy, and assertion group

| N | Arm | Raw values | Median |
| --- | --- | --- | --- |
| 11 | before | 448.241, 448.527, 559.684, 384.772, 519.663 | 448.527 |
| 11 | after | 560.430, 465.403, 473.473, 563.081, 447.823 | 473.473 |
| 50 | before | 1914.229, 1727.952, 1963.497, 1713.126, 1792.402 | 1792.402 |
| 50 | after | 2058.939, 1967.177, 1570.421, 1977.724, 1554.916 | 1967.177 |
| 150 | before | 13063.100, 11450.509, 12170.645, 10695.532, 11488.848 | 11488.848 |
| 150 | after | 11188.199, 10086.059, 9829.717, 12396.147, 9467.222 | 10086.059 |

The copy medians changed by +13.1%, -2.5%, and -34.1% at N=11, 50,
and 150. The N=150 optimized copy outlier of 2220.300 ms remains in the raw
values. The group medians changed by +5.6%, +9.7%, and -12.2%, respectively.
Rendering dominates at N=150 and does no work in these two attribution functions;
its observed improvement cannot be attributed to this gate change.

## Profile attribution

These are V8 sample-weighted self times in milliseconds, not OS-measured thread
CPU time. Profile startup/stop overhead and descheduling affect the sampled
intervals, so they are not interchangeable with the unprofiled action wall times.
Zeros mean no sample landed in that function; the counters separately prove no
calls on optimized successful copies.

| N | Function | Before raw self ms | Before median | After raw self ms | After median |
| --- | --- | --- | --- | --- | --- |
| 11 | `describeRefusalInputs` | 3.407, 0.767, 0.000 | 0.767 | 0.000, 0.000, 0.000 | 0.000 |
| 11 | `collectConsumedLabel` | 0.000, 1.469, 0.000 | 0.000 | 0.000, 0.000, 0.000 | 0.000 |
| 50 | `describeRefusalInputs` | 22.808, 17.570, 11.403 | 17.570 | 0.000, 0.000, 0.000 | 0.000 |
| 50 | `collectConsumedLabel` | 0.000, 6.326, 1.515 | 1.515 | 0.000, 0.000, 0.000 | 0.000 |
| 150 | `describeRefusalInputs` | 191.130, 104.931, 139.646 | 139.646 | 0.000, 0.000, 0.000 | 0.000 |
| 150 | `collectConsumedLabel` | 2.766, 1.503, 2.302 | 2.302 | 0.000, 0.000, 0.000 | 0.000 |

Including descendant frames, the before medians for `describeRefusalInputs` /
`collectConsumedLabel` were 0.767 / 1.463 ms at N=11, 17.570 / 3.570 ms at
N=50, and 144.254 / 7.618 ms at N=150. Both became zero afterward. All render
profiles had zero self and inclusive time for both functions in both arms.

Across all instrumented action and render phases, the two functions and their
descendants accounted for 1.64%, 1.26%, and 1.83% of non-idle sample-weighted
before time. The proposed 25–40% whole-worker estimate is **not supported by
this fixture**. The deterministic work removal is proven, and the large-copy
median improved, but this loaded headless run does not settle the fraction in a
particular browser's 19-second open.

## Strict-policy replay and regression coverage

The same query/render/copy sequence was replayed under `enforce-strict` with the
copy destination supplied as an external cell declaring `unrelated-store-policy`.
That policy cannot admit `fixture-private`. Making this an external destination
matters: the pattern-owned Writable can widen its store policy and succeeds even
under strict mode.

The replay checks the full reason string against each detail's target and atoms,
requires `fixture-private` among the offending atoms, nonempty `inputs`, and
`attribution: "complete"`. Query assertions pass; copy-count assertions fail
because the refused destination stays empty. Each N rejects one prepare and
records N+1 full details with one label walk, identically before and after.
The runtime prepare-reject hook captures these details: the scheduler's terminal
error channel does not surface every prepare refusal.

Permanent runner tests cover all four enforcement modes, four write targets
sharing one attribution walk under strict mode, exact strict refusal reason and
input path, successful persisted labels and diagnostics, and counter snapshot,
reset, and noninterference with preparation/relevance. The pre-fix instrumented
run failed the successful-commit no-detail assertion; the optimized focused suite
passed all 100 steps. The full runner package suite passed 1,427 tests and
10,079 steps, with zero failures.

## Evidence and replay

- [Raw wall timings and counter deltas](2026-09-15-writer-fit-refusal-details/raw.json)
- [Strict replay counters and attribution examples](2026-09-15-writer-fit-refusal-details/strict.json)
- [Raw profile summaries](2026-09-15-writer-fit-refusal-details/profiles.json)
- [Frozen patches, fixture, and harness inputs](2026-09-15-writer-fit-refusal-details/replay-inputs.json)
- [Replay script](2026-09-15-writer-fit-refusal-details/replay.py)
- [Profile and timing summarizer](2026-09-15-writer-fit-refusal-details/analyze.py)

Run from a checkout that contains the baseline commit:

```sh
python3 docs/history/development/performance/2026-09-15-writer-fit-refusal-details/replay.py /tmp/new-writer-fit-replay --rounds 5 --profiles 3
python3 docs/history/development/performance/2026-09-15-writer-fit-refusal-details/analyze.py /tmp/new-writer-fit-replay/writer-fit-results
```

A fresh-worktree verification with one wall-time pair and both strict arms passed.
The replay creates a new detached worktree, applies identical instrumentation to
both arms, alternates the gate patch, validates all successful-run assertions and
counters, and runs both strict-policy cases. It retains logs and full `.cpuprofile`
files in that worktree. The checked-in summaries retain every measured repetition;
the larger original logs and profiles remained local under
`/tmp/writer-fit-refusal-details`.
