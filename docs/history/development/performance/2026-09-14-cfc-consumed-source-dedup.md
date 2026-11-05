---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Local reproduction and verification of consumed CFC source deduplication."
---

# Consumed CFC source deduplication

The starting evidence was
[the Loom investigation on issue #7179](https://github.com/commontoolsinc/labs/issues/7179#issuecomment-5668537208).
This investigation reproduced its consumed-source scaling in Labs, without
re-running the deployed-pane investigation or claiming to reproduce pane boot.

## Scope and fixture

Base checkout: `ed17ef324e04e0e04a95bdf5991849576929e51e`, rather than the
issue's `be73306e5`. The source scan was present at this checkout. The first
production edit exported `collectConsumedLabel()` directly from its module and
documented its contract; it did not change the algorithm. The benchmark ran
against that scan before the fix was written.

The maintained benchmark is
`packages/runner/test/cfc-consumed-source-dedup.bench.ts`, registered by the
existing runner benchmark glob. It uses real emulated storage, labeled payloads,
and actual transaction read activities. All reads share a document and scope;
each distinct four-segment read path contributes two distinct User atoms. There
are no duplicate sources to remove. The confidentiality join contains two atoms,
distinguishing provenance width from label-atom width.

| Sources | Payload reads | Root-label entries | Field-label entries |
| ------- | ------------- | ------------------ | ------------------- |
| 128     | 64            | 1                  | 64                  |
| 458     | 229           | 1                  | 229                 |
| 916     | 458           | 1                  | 458                 |
| 1832    | 916           | 1                  | 916                 |
| 2668    | 1334          | 1                  | 1334                |

Each measured operation is **one collector call**. Runtime/document setup, value
reads, read-count inspection, assertions, and abort are outside the explicit
timer. A fresh transaction prevents verifier journals accumulating between
samples. Source and joined-atom counts are checked after each call. The timed
call includes verifier metadata reads, envelope validation, overlap checks,
source collection, and both atom joins.

## Identity and order

The collector buckets on
`JSON.stringify([read.id, read.space, read.scope,
pathKey(read.path), pathKey(labelPath)])`.
The fields are strings under the CFC address contract, so JSON tuple encoding
preserves their boundaries, including embedded NULs, slashes, tildes, and empty
path segments. Both path keys use the existing canonicalization and pointer
encoding.

Only a bucket's atoms reach `deepEqual()`. Atom identity is not serialized;
property-order-independent equality and the distinction between signed zeros
remain CFC's existing predicate. Appending each newly accepted source to the
separate result array preserves global first-seen order. The index lasts for one
collection and cannot retain sources across transactions.

This removes the square across distinct addresses, with a bounded atom count per
address. It does not claim linear behavior for unbounded numbers of structurally
distinct atoms at one address, or for the rest of the collector.

## Measurement method

Machine: Apple M3 Max, macOS 26.4.1 (25E253), arm64, Deno 2.9.4 / V8
15.0.245.2-rusty. The complete initial `deno bench --no-lock -A --json` reports
are retained as diagnostics, including sample counts, averages, p75, maxima, and
runtime/CPU identity. They were sequential runs, and are not the load-bearing
A/B.

For the paired measurement, a throwaway driver registers the maintained
benchmark bodies, lets their untimed module-level validation warm each case, and
executes each body once with its explicit timer. It changes no workload or
collector instrumentation. Five fresh-process pairs alternate baseline/fix order
(B/F, F/B, B/F, F/B, B/F), restoring the fixed file afterwards. The source
snapshots differ only in source deduplication. The raw result artifact includes
the driver, controller, source hashes, timing samples, and load readings. No
test suite or other validation launched by this investigation ran during those
pairs; other machine users and workloads remained active.

Report the minimum of five for the scaling table, and the median of paired speed
ratios alongside it. Five samples are too few to claim production-tail latency.
The raw samples and trimmed/untrimmed averages expose stalls rather than
dropping them silently. There is no untouched machine-calibration arm. Absolute
times are local diagnostic costs, not Loom timings or release SLOs.

The final paired run's one-minute load averages ranged from 11.74 to 15.69. The
fixed collector won all 50 comparisons (ten cases in each of five pairs). For
the root-label arm, doubling sources from 458 to 916 cost 4.01 times as much in
the scan and 1.92 times as much with buckets, using each arm's minimum of five.
The larger points continue the separation between quadratic and approximately
linear growth.

| Sources | Baseline min (ms) | Fixed min (ms) | Min/min speedup | Median paired speedup |
| ------- | ----------------- | -------------- | --------------- | --------------------- |
| 128     | 7.419             | 0.283          | 26.2×           | 23.4×                 |
| 458     | 88.973            | 0.844          | 105.5×          | 92.9×                 |
| 916     | 356.986           | 1.621          | 220.2×          | 174.5×                |
| 1832    | 1532.942          | 4.026          | 380.7×          | 347.7×                |
| 2668    | 3509.897          | 5.766          | 608.7×          | 530.6×                |

The field-label arm holds the same source/read counts:

| Sources | Baseline min (ms) | Fixed min (ms) | Min/min speedup | Median paired speedup |
| ------- | ----------------- | -------------- | --------------- | --------------------- |
| 128     | 8.961             | 1.507          | 5.9×            | 5.0×                  |
| 458     | 96.886            | 16.413         | 5.9×            | 5.5×                  |
| 916     | 465.885           | 67.256         | 6.9×            | 5.6×                  |
| 1832    | 1977.121          | 273.443        | 7.2×            | 6.4×                  |
| 2668    | 3787.920          | 595.181        | 6.4×            | 6.1×                  |

At 2,668 root-label sources, individual paired speedups ranged from 354.5 to
608.7 times. Untrimmed means were 3,697.4ms / 7.50ms (baseline / fixed);
removing each arm's highest and lowest sample gave 3,621.9ms / 7.08ms. The
field-label means at the same size were 4,383.2ms / 739.8ms, versus trimmed
means of 4,426.1ms / 732.5ms. Trimming does not create the result. All samples,
including the noisier initial series, are in the
[raw results](2026-09-14-cfc-consumed-source-dedup.results.json).

The initial Deno reporter run independently exhibited the square before the fix:
root-label averages at 458 and 916 sources were 142.6ms and 572.4ms. That run
included competing validation work and a changing machine load, so its absolute
times are diagnostic only. Its JSON remains intact in the raw artifact, with its
sample counts and distribution statistics.

## The remaining width cost

At fixed read/source counts, the field-label arm keeps substantially more
collector work after deduplication. Each call still validates and scans the
label map once per read: with R reads and L label entries, both walks visit R ×
L entries. At the largest field-label point that is 1,779,556 entries per walk,
versus 1,334 for the root-label arm. Every read still contributes only two
sources. This is width per collector call, not additional collector calls.

A separate [V8 profile](2026-09-14-cfc-consumed-source-dedup.cpuprofile) of five
fixed `field labels 2668` calls sampled 5.737s over their bodies, including
untimed fixture reads. Restricting attribution to stacks beneath
`collectConsumedLabel()` gave 5.053s: 68.6% collector self, 16.0% the prefix
predicate callback, 10.9% `storedMetadataFor()`, and 2.5% its entry-validation
callback. Pointer encoding was about 0.3%. Inlining and unsplit collector self
time limit further attribution; these percentages are sample weights, not five
summed wall-clock measurements. The profile's line numbers are
emitted-JavaScript positions, not TypeScript source links.

This fixture establishes another read-count × metadata-width cost, and gives a
concrete follow-up question for `isPrefix()`, which lives in
`cfc/path-prefix-index.ts` at this checkout. It does **not** establish why
Loom's nested-array element produces more consumed sources or wider label maps.
There is no `lift`, mapped sub-pattern, JSX rendering, injected SQLite store, or
browser in this benchmark. The deployed nested-array arm's remaining 5.9s versus
the flat arm's 3.5s remains unexplained here.

No prefix algorithm or `encodePointer()` change is included.

## Correctness and validation

- `deno test --no-lock -A packages/runner/test/cfc-*.test.ts`: 182 passed, 1,775
  steps, zero failures (4m38s). The issue recorded 1,741 steps at its older pin;
  this checkout has additional cases.
- New focused suite: one top-level test, five steps, zero failures.
- `deno task check`: all 46 package groups passed.
- Repository-wide `deno fmt --check` and `deno lint`: passed. The first lint run
  caught a block-local function declaration in the benchmark; its final form is
  a local arrow function with the same measured body. The initial measurements
  are retained separately, and the paired run was repeated on the final fixture.
- `deno task test` in `packages/runner`: 1,406 passed, 9,917 steps, zero
  failures, one ignored step (28m16s).
- Repository control-character and conflict-marker checks passed; the new
  untracked source files were also checked explicitly for literal controls.

The focused tests exercise structural equality, signed zero, every address
field, separator collisions, pointer escapes, canonical aliases, distinct label
paths, payload/metadata source merging, first-seen refusal input order, and
fresh collection state. The original scan passed them before the fix. Two
deliberately wrong implementations failed them: serializing atoms instead of
structural comparison, and joining address fields with an unescaped NUL. Both
mutations were discarded before final validation.

## Reproduction

Run from the repository root:

```sh
deno bench --no-lock -A --json packages/runner/test/cfc-consumed-source-dedup.bench.ts
deno test --no-lock -A packages/runner/test/cfc-*.test.ts
deno test --no-lock -A packages/runner/test/cfc/collectConsumedLabel.test.ts
```

Diagnostics go to stderr; benchmark stdout is pure JSON. To compare the
algorithms, use the same benchmark file in both arms and undo only the source
bucket change in the baseline arm, keeping the direct module export. The
attached raw artifact records the exact source delta and diagnostic runner.
