---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Authoritative link-label cover lookup measurements and render attribution."
---

# Authoritative link-label coverage

The persist seam resolves each carried label entry against the deepest
worker-authoritative source entries. A prefix-only `ConsumedLabelIndex` lookup
limits candidate selection to matching ancestors. The existing deepest-path
selection and equal-depth label merges remain in encounter order. Construction
is lazy and scoped to one link write; no usable carried entries means no index.

## Method and correctness

Baseline: `dd23b59eea6623e37a490c427d57e86d0c0e0373`, including the
wildcard-source index optimization. Apple M3 Max; Deno 2.9.4;
V8 15.0.245.2-rusty. Only `prepare.ts` and `consumed-label-index.ts` differ
between runtime arms. Other development processes were active. Small timing
differences are inconclusive; this is not a quiet-machine latency claim.

The generated grid checks 70,200 concrete queries against `isPrefix` in each
lookup mode. The exhaustive small-path corpus covers wildcards on either side,
empty paths, and empty segments. Focused tests cover canonical payload fields
named `value`, duplicate entries, snapshot paths, and encounter order.
Persistence tests run real link writes with concrete and wildcard carried
paths; their final labels include every deepest authoritative match, exclude
shallower and descendant labels, and include the carried contribution.

## Lookup benchmark

`packages/runner/test/cfc-authoritative-cover.bench.ts` times 8,192 concrete
queries per sample with explicit warmup. The index arm includes construction.
Both arms use the same deepest-match selection, verified before timing. The
checksum identifies selected entries; label merging is outside this kernel.
These numbers are amortized over 8,192 queries, not construction-free lookup
cost and not a promise for link writes with only one query.

| Sources | Wildcard fraction | Scan µs/query | Index µs/query | Speedup |
|---|---|---|---|---|
| 50 | 0 | 0.673 | 0.080 | 8.4x |
| 50 | 0.05 | 0.770 | 0.071 | 10.9x |
| 50 | 0.3 | 0.751 | 0.082 | 9.2x |
| 250 | 0 | 3.537 | 0.125 | 28.2x |
| 250 | 0.05 | 3.656 | 0.099 | 37.1x |
| 250 | 0.3 | 3.778 | 0.121 | 31.1x |
| 1000 | 0 | 16.293 | 0.177 | 91.9x |
| 1000 | 0.05 | 15.665 | 0.213 | 73.4x |
| 1000 | 0.3 | 19.682 | 0.214 | 91.8x |

## Shared arm-B render ladder

The frozen mapped-list fixture and timers are the shared harness recorded in
[the wildcard-source investigation](2026-09-15-cfc-wildcard-source-index.md).
The fixture waits for the query's actual row count, renders 11/50/150 rows,
and separately copies labeled rows. Arm B uses `--cfc-shell-posture`; all
runs use `--no-idempotency-check`. Compile, seed, assertions, and copy actions
are outside each render materialization interval. Each invocation is a fresh
process. Five pairs alternate before/after order; profiling is a separate pair.

Times below are milliseconds for N=11/50/150. The logger rounds multi-second
intervals to tenths of a second.

| Pair | Before | After |
|---|---|---|
| 0 | 89/382/3300 | 105/430/2600 |
| 1 | 113/580/3100 | 99/497/2700 |
| 2 | 93/391/3200 | 80/365/2300 |
| 3 | 109/435/3100 | 91/436/2300 |
| 4 | 81/384/2800 | 84/364/2300 |

Medians: **93/391/3100 → 91/430/2300 ms**. At 150 rows every pair improves,
by 13–28%; the median paired speedup is **1.27x**. The ratio of independent
150-row medians is 1.35x (26% less elapsed time). The smaller sizes do not
establish a consistent gain; their medians and paired ratios are affected by
host variation.

The replay script also completed all twelve invocations successfully. Its
five additional unprofiled pairs improved at 150 rows in every pair, with
medians **94/411/3200 → 96/405/2900 ms**. The raw summaries retain this second
set separately; the variation reinforces using paired ratios and attributing
the scan through the profile rather than treating one absolute median as a
stable latency promise. Across all ten pairs, the median 150-row speedup is
**1.20x**, ranging from 1.07x to 1.39x.

## Profile attribution

The separate pair profiles the whole fixture, including setup and copy actions,
with V8 sampling at 500 µs. Total sampled time: 5212 → 5167 ms. Its render
ladder is 90/396/2900 → 90/384/2500 ms. Whole-fixture and render intervals are
different populations and should not be substituted for each other.

Named `isPrefix` self time falls **437.529 → 6.331 ms** (98.6% lower).
Of the baseline total, **428.954 ms** has `authoritativeCoverFor` as its immediate
caller; that caller has no `isPrefix` samples after the change. Remaining
samples come from `labelForEntriesAtPath` and `labelViewForLink`.
`authoritativeCoverFor`'s own self time is 13.368 → 1.481 ms.
Sampling zero does not mean a function never executes: wildcard query fallback
still scans, and wildcard source buckets still use the shared predicate.

The repeated 150-row render reduction and the removed scan samples support a
win for this change. They do not attribute the remaining render time to a
single cause or establish an improvement at the smaller sizes.

## Replay and artifacts

[Raw measurement summaries](2026-09-15-cfc-authoritative-cover.data.json)
include kernel samples, all runtime pairs, profile attribution, and raw artifact
hashes. The [optimization patch](2026-09-15-cfc-authoritative-cover.patch)
freezes the two-module delta. The
[replay script](2026-09-15-cfc-authoritative-cover.replay.py) creates and removes
its own disposable Git worktree at the baseline, applies the shared harness,
and changes only those two modules between arms. It checks baseline history
before starting and specifies UTF-8 for text files. Its output directory must
not exist; raw logs and CPU profiles remain there.

```sh
CHECKOUT="$PWD" OUT=/tmp/cfc-authoritative-replay \
  python3 docs/history/development/performance/2026-09-15-cfc-authoritative-cover.replay.py

deno bench --no-check --json packages/runner/test/cfc-authoritative-cover.bench.ts
```

Raw local captures for the recorded run:
`/tmp/cfc-authoritative-cover/ladder-*` and `kernel.json`.
