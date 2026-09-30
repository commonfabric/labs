---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Measured flow-read indexing, scan equivalence, and shared-render attribution."
---

# Indexed flow-read labels

The flow-join pass loses its per-read scan of unrelated label entries. A
prepare-local index for each document and read class selects overlapping entries
before applying the observation-specific exclusions. The generated transaction
corpus preserves confidentiality clauses, hereditary integrity, and contributing
spaces per read. The synthetic grid improves substantially; the shared fixture's
flow spans improve too. These measurements do **not** establish a substantial
end-to-end rendering improvement: a different scan, `authoritativeCoverFor`,
dominates its `isPrefix` samples.

## Workload and measurement boundaries

Shared runtime base: `53baf62fdaf9dae6824bc9c5a0da812a64b95d6c`. The grid
baseline is the wildcard-index prerequisite at
`da6a77b935cafdd5398ab140a660bd02f8078b9d` (PR #7582); the same index
implementation is present in both shared-runtime arms. Measurements ran on an
Apple M3 Max with Deno 2.9.4 while other development tasks were active. Absolute
timings are machine-load dependent. Five pairs alternate before/after order. The
grid reports the minimum of each run's 75th percentile; the shared ladder also
reports medians so a single fast run does not become its conclusion. The
[data file](2026-09-15-cfc-flow-read-index.data.json) retains each grid run's
statistics and each runtime run's phase timings.

The grid uses real emulated transactions and exactly E label entries at E = 100,
300, 1,000, independently of R = 50, 200, 800 read activities. Concrete paths
have three to six segments and real scalar payloads. Three additional entries
are the collection's value, shape, and followRef `*` templates. Reads overlap
the concrete entries and templates. Construction, seeding, reads, assertions,
and aborts are outside timing; one complete `deriveFlowJoin`, including metadata
resolution and index construction, is inside. Confidentiality contains both
`content` and `membership`; integrity is empty. Repeated paths still count as
distinct read activities.

The shared workload is the same `mapped-render.test.tsx` under shell posture
(`enforce-explicit`, `persist`) at N = 11, 50, 150. It seeds labeled SQLite
rows, asserts the query result count, materializes each mapped view, then copies
the labeled values in a separate action. Copy actions are separate from the
render windows. The fixture's SHA-256 is
`f5b1b159ff6ccb98174931ef8a2553adb6de80cf8868aba42c6e849a0ea7edc0`. The CLI
posture support and timing spans came from the working snapshot of pattern-test
harness commit `88d55af6c0`. Its final settle-stat reporting refactor and
comment changes postdate the capture; the materialization boundary is identical.
Both runtime arms include the wildcard-source index change; only the flow-read
adoption and its index API additions differ.

## Attribution before optimization

A preserved baseline checkout was measured before changing flow resolution.
Temporary logger spans bracketed `effectiveReadLabel`, with
`CF_TIMING_MEASURES=1` and a V8 sampling profile. The final shared fixture was
then captured on the same preserved baseline. For its N = 50 materialization,
1,463 `effectiveReadLabel` spans totaled **2.50 ms**, all nested under
`deriveFlowJoin`, within a **562.95 ms** materialization window.

Across the final fixture's full ladder and copy actions, the baseline captured
10,695 such spans totaling **20.99 ms**. Of **578.97 ms** sampled self time in
the named `isPrefix` function, **571.07 ms** had `authoritativeCoverFor` on its
ancestor stack, **6.79 ms** had `effectiveReadLabel`, and 1.12 ms had neither.
The source-based hypothesis that flow-read lookup caused most of `isPrefix` self
time is therefore disproved for this fixture.

The after capture has the same 10,695 flow-label calls, totaling **5.90 ms**.
Sampled `isPrefix` self time under that caller falls to **0.59 ms**; the
separate `authoritativeCoverFor` scan remains at **765.75 ms**. Logger durations
are elapsed spans, and profile samples are CPU attribution; those are distinct
measurements and are not added together.

## R by E grid

Milliseconds per complete pass, minimum run p75 across five interleaved pairs:

| Entries | Reads |  Before | After | Before / after |
| ------: | ----: | ------: | ----: | -------------: |
|     100 |    50 |   1.345 | 0.288 |          4.67x |
|     100 |   200 |   5.357 | 0.591 |          9.07x |
|     100 |   800 |  25.450 | 2.964 |          8.59x |
|     300 |    50 |   3.610 | 0.368 |          9.82x |
|     300 |   200 |  14.439 | 0.890 |         16.22x |
|     300 |   800 |  68.320 | 3.471 |         19.68x |
|   1,000 |    50 |  13.743 | 0.947 |         14.52x |
|   1,000 |   200 |  56.206 | 1.590 |         35.34x |
|   1,000 |   800 | 211.665 | 4.824 |         43.87x |

At R = 800, multiplying E by ten multiplies the baseline cost by 8.32 and the
indexed cost by 1.63. Building the index and resolving metadata still cost E per
pass; unrelated entries are not scanned once per read.

The precise bound includes depth, matching wildcard candidates, and output size.
Building the trie costs O(E times depth) per used read class. A concrete query
follows its path, tests wildcard candidates bucketed under its prefixes, and
collects and orders its K matching entries. A recursive root read must still
return all descendants; a wildcard query retains the scan fallback. An
unconditional O(path length) claim for arbitrary wildcard queries or unbounded
output would be false.

## Shared arm-B ladder

Unprofiled materialization windows, milliseconds, five interleaved pairs:

|   N | Before median | After median | Before minimum | After minimum |
| --: | ------------: | -----------: | -------------: | ------------: |
|  11 |          99.3 |        101.8 |           96.9 |          98.9 |
|  50 |         499.8 |        514.0 |          423.7 |         471.9 |
| 150 |       3,521.4 |      3,567.3 |        3,313.0 |       3,449.9 |

The rendering windows show substantial run-to-run spread; their changes do not
establish a causal rendering win. Across these runs, the median cumulative
`effectiveReadLabel` span drops from 21.67 ms to 4.00 ms, and `deriveFlowJoin`
from 46.76 ms to 30.67 ms. The caller improves in the shared workload; the
broader rendering-speedup target remains unproven.

Within the profiled render windows, the flow-label span ladder is:

|   N | Calls in each arm | Before span ms | After span ms |
| --: | ----------------: | -------------: | ------------: |
|  11 |               332 |          0.408 |         0.150 |
|  50 |             1,463 |          2.497 |         0.614 |
| 150 |             4,363 |         11.933 |         1.816 |

These spans explain the narrow improvement without attributing the
`authoritativeCoverFor` work to it.

## Correctness and reproduction

`test/cfc/deriveFlowJoin.test.ts` compares real-transaction results to an
independent linear oracle over generated paths. The corpus includes root,
concrete and both-sided wildcard paths, empty segments, pointer-escape text,
payload fields named `value`, every origin and observation class, recursive and
nonrecursive followRef observations, and machinery exclusions. A mixed
transaction checks class-index reuse and integrity intersection. A metadata
replacement in the same transaction checks that the next pass builds fresh
indexes. Deliberately sharing one class's index across all classes makes the
corpus fail. Existing template-population tests cover restamp and trace
exclusions through persisted runtime behavior.

The added index tests compare ancestor-only queries to `isPrefix` and check that
canonical-path mode preserves payload coordinates and snapshots mutable input
paths. The wildcard-source change's own corpus holds ordered overlap candidates
to the same predicate.

Run the focused corpus and grid from a checkout:

```sh
deno test -A --no-check packages/runner/test/cfc/deriveFlowJoin.test.ts \
  packages/runner/test/cfc/ConsumedLabelIndex.test.ts
deno bench -A --no-check --json packages/runner/test/cfc-flow-join.bench.ts
```

With the shared fixture and CLI posture support available, the arm is:

```sh
deno task cf test \
  packages/cli/test/fixtures/cfc-flow-labels/mapped-render.test.tsx \
  --cfc-shell-posture --verbose --stats-threshold 0 --no-idempotency-check
```

For attribution, bracket `effectiveReadLabel` in a scratch checkout with the
logger's `time` method. Run `skills/perf-investigation/scripts/profile-cf.ts`
with `CF_PROF_OUT`, `CF_PROF_CPU=1`, and `CF_TIMING_MEASURES=1`. The logger's
measure key is `effectiveReadLabel`, without its `cfc` logger-name prefix.
Extract measures contained in `runTestPattern/step/render_2/materialize` for the
N = 50 window, then run:

```sh
deno run --allow-read skills/perf-investigation/scripts/attribute-measures.ts \
  n50.measures.json --key=effectiveReadLabel
```

The local raw profiles, all run logs, before/after harness patches, and frozen
fixture remain under `/tmp/effective-read-label/`. None of the temporary
profiling wrappers is part of the production change.
