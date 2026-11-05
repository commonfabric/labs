---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Prepared-digest optimization measurement at a fixed baseline."
---

# Prepared CFC digest measurements

Baseline: `53baf62fdaf9dae6824bc9c5a0da812a64b95d6c`. Optimized code is the
accompanying changeset. Measurements ran on an Apple M3 Max with Deno 2.9.4
and V8 15.0.245.2-rusty, on macOS arm64. Other tasks and test suites were
active; these are local comparisons, not quiet-machine latency claims.

[Raw per-round measurements](2026-09-15-prepared-digest-data.json) retain all
samples summarized below. Full benchmark JSON, logs, profiles, the exact shared
fixture, and local reconstruction scripts are retained at
`/Users/berni/.codex/investigations/prepared-digest-20260915`.

## Unit ladder

The committed `packages/runner/test/cfc-prepared-digest.bench.ts` ran five
alternating before/after rounds, reversing arm order on odd rounds. Each cell
below is the minimum of five per-run 75th percentiles, in milliseconds. Setup,
warmup hashing, assertions, and cleanup were outside timing. All sizes included
300 read activities and 300 traces. Distinct policy names avoided hash-based
sort ties. Payloads contain a string of the stated size and a small schema.

| Writes | KiB | Phase | Baseline ms | Optimized ms | Baseline / optimized |
| --- | --- | --- | ---: | ---: | ---: |
| 5 | 1 | first | 5.7761 | 9.9763 | 0.58x |
| 5 | 1 | unchanged | 4.9016 | 0.0018 | 2800.93x |
| 5 | 1 | one-write | 4.4088 | 5.1504 | 0.86x |
| 5 | 1 | warm-parts | 4.2218 | 0.7450 | 5.67x |
| 5 | 10 | first | 3.6361 | 9.4349 | 0.39x |
| 5 | 10 | unchanged | 5.2059 | 0.0019 | 2715.64x |
| 5 | 10 | one-write | 4.7864 | 4.0047 | 1.20x |
| 5 | 10 | warm-parts | 4.3454 | 0.6935 | 6.27x |
| 50 | 1 | first | 5.7814 | 8.9183 | 0.65x |
| 50 | 1 | unchanged | 5.9140 | 0.0029 | 2027.41x |
| 50 | 1 | one-write | 5.7095 | 5.8546 | 0.98x |
| 50 | 1 | warm-parts | 4.9771 | 0.7798 | 6.38x |
| 50 | 10 | first | 6.5607 | 9.2537 | 0.71x |
| 50 | 10 | unchanged | 5.0743 | 0.0015 | 3292.86x |
| 50 | 10 | one-write | 5.2705 | 5.7100 | 0.92x |
| 50 | 10 | warm-parts | 4.3969 | 0.7152 | 6.15x |
| 200 | 1 | first | 9.0735 | 13.8092 | 0.66x |
| 200 | 1 | unchanged | 7.7967 | 0.0017 | 4562.12x |
| 200 | 1 | one-write | 10.0402 | 8.3752 | 1.20x |
| 200 | 1 | warm-parts | 8.0361 | 0.9593 | 8.38x |
| 200 | 10 | first | 11.6192 | 17.2996 | 0.67x |
| 200 | 10 | unchanged | 10.1945 | 0.0019 | 5437.09x |
| 200 | 10 | one-write | 9.9198 | 7.7985 | 1.27x |
| 200 | 10 | warm-parts | 7.5442 | 0.9965 | 7.57x |

The unchanged transaction computation performed zero hashes. With one added
write, cache hits were 306, 351, and 501 at 5, 50, and 200 writes; direct
composition over warmed records hit 616, 751, and 1,201 times. Baseline hits
were zero in every case. The direct warm series uses a fresh outer input
wrapper with the same frozen records, so it cannot use the transaction memo.

Cold composition is slower: individual small-record SHA-256 calls add overhead.
The change does not establish a speedup for every transaction shape. Rebuilding
after one write also reconstructs the journal read and write records, so that
case retains count-dependent work even though the existing policy payloads and
traces reuse hashes. The warm-record curve is approximately flat against
payload bytes: about 0.7–1.0 ms across these six cases.

## Shared arm B

Both comparison checkouts ran a byte-identical snapshot of
`packages/cli/test/fixtures/cfc-flow-labels/mapped-render.test.tsx` from the
concurrent CFC pattern-test-posture work. The fixture uses labeled SQLite title
columns and maps their query results to paragraph views at 11, 50, and 150 rows.
The test harness options were `enforce-explicit` / `persist`, with idempotency
replay disabled. Both checkouts received the same harness-option plumbing and
render-window timing instrumentation. The optimization was the only runtime
difference. The fixture SHA-256 was:

`f5b1b159ff6ccb98174931ef8a2553adb6de80cf8868aba42c6e849a0ea7edc0`

Five unprofiled rounds alternated checkout order. The table reports independent
minimum render durations and the median of each round's paired speedup.

| Rows | Baseline minimum ms | Optimized minimum ms | Median paired speedup |
| --- | ---: | ---: | ---: |
| 11 | 146.6 | 156.2 | 0.97x |
| 50 | 913.4 | 809.0 | 1.09x |
| 150 | 6008.9 | 5927.1 | 1.14x |

The 50-row arm improved in four of five pairs; the 150-row arm improved in all
five, although the independently best 150-row runs were only 1.4% apart. The
11-row arm did not improve consistently. Machine load and the sample count
limit the precision of the wall-time claim. All six fixture assertions passed
in every run, with no reported runtime errors.

## Profile attribution

A separate profiled pair used the same workload and a 500-microsecond sampling
interval. Samples were assigned to the harness's render windows using the
profiler-start timestamp. Inclusive hasher time counts a sample once if its
stack contains `value-hash.ts`; digest time counts a sample once if its stack
contains `preparedDigestFor`. These categories overlap and must not be added.

| Rows | Hasher share before | Hasher share after | Digest share before | Digest share after |
| --- | ---: | ---: | ---: | ---: |
| 11 | 4.23% | 6.76% | 2.83% | 5.39% |
| 50 | 23.98% | 12.71% | 24.65% | 15.80% |
| 150 | 20.48% | 9.87% | 21.42% | 13.99% |

At 150 rows, sampled inclusive hashing fell from 2.134 s to 0.836 s within
render windows of 10.418 s and 8.474 s. Deno selected the native `node:crypto`
backend; this is not a browser/WASM profile and does not remeasure the cited
19-second browser opening.

## Correctness evidence

Tests cover equal activity recorded in different insertion order, differing
write-policy values, ordered write attempts, read/write interleaving, trace
deduplication, canonical paths, mutable-input changes, and reuse of a record
hashed before the first digest. Transaction tests cover an unchanged commit,
a repeated trace requiring a recomputation, a late batch write, and immutable
trust/implementation snapshots. The cache-reuse tests fail on the baseline.

The activity audit found that `#noteWrite()` had no callers at the baseline.
The change reconnects write paths and advances the epoch for non-journal
decision inputs. Verification still runs during prepare; the memo reuses only
the digest, never a policy verdict.
