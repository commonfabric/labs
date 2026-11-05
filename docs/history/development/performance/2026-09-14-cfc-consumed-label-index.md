---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Measured the remaining consumed-label metadata-width cost."
---

# Consumed label-map width

The [source-deduplication fix](https://github.com/commontoolsinc/labs/pull/7453)
removed the quadratic scan across consumed sources. Its maintained
`cfc-consumed-source-dedup.bench.ts` also exposed a separate cost: each read
validated and scanned the entire document's label map. This follow-up measured
that cost on base `a4f0ac827fd2111e77bd102d2634bdaaa7d7bc91`.

## Mechanism and boundary

`collectConsumedLabel()` now loads and validates each document's CFC metadata
once per synchronous collection. The cache key includes space, document ID,
normalized scope, and media type. It holds no state between collections.

An index canonicalizes the label paths once and finds overlapping ancestors,
equal paths, and descendants along a concrete path. Candidates retain the label
map's order. The collector applies its existing structure-entry and
nonrecursive-read predicates to those candidates; source identity and atom joins
are unchanged. Metadata validation still covers the entire map before indexing,
including malformed entries outside the read path.

A wildcard on either side uses the shared `isPrefix()` predicate in a scan.
Broad recursive reads still have broad result sets. Index construction and its
per-prefix entry lists cost total label-path length; queries sort only matching
candidates by their original ordinal, with an O(k log k) upper bound for k
candidates. This is a bound on concrete narrow reads, not a claim that every
collection is linear.

## Paired measurements

The unchanged maintained benchmark has 128, 458, 916, 1,832, and 2,668 sources,
two atoms per consumed read. The root-label arm holds label-map width at one;
the field-label arm has one entry per read. Both share a document and use
four-segment logical read paths. Each sample times one collector call, with
setup, value reads, assertions, and abort outside its explicit timer.

Five fresh-process pairs alternate B/F, F/B, B/F, F/B, B/F. Each process runs
the maintained fixture's untimed validation once before its timed sample.
Baseline and fix differ only in consumed-label lookup. No other validation
launched by this investigation ran during measurement; other machine users
remained active. There is no untouched machine-calibration arm.

Machine: Apple M3 Max, macOS arm64, Deno 2.9.4. One-minute load during the pairs
was 10.36–11.08. Absolute times are local collector diagnostics, not pane
latencies or production-tail estimates. Full samples, source hashes, the
comparison driver, and trimmed/untrimmed summaries are in the
[results artifact](2026-09-14-cfc-consumed-label-index.results.json).

| Field-label sources | Baseline minimum (ms) | Indexed minimum (ms) | Median paired speedup |
| ------------------- | --------------------- | -------------------- | --------------------- |
| 128                 | 1.730                 | 0.266                | 3.92×                 |
| 458                 | 19.171                | 1.342                | 11.69×                |
| 916                 | 80.076                | 2.136                | 26.07×                |
| 1832                | 275.124               | 4.204                | 45.35×                |
| 2668                | 572.278               | 5.952                | 61.64×                |

At the largest field-label size all five pairs favored the index. Untrimmed
means were 597.728ms / 9.391ms; removing each arm's highest and lowest samples
gave 595.085ms / 9.982ms. The root-label control showed no consistent win:
median paired ratios ranged from 0.86× to 1.21× across sizes. At 2,668 sources
its means were 6.338ms / 6.159ms. The fix targets metadata width, and its
indexing overhead can cost more on a small label map.

The field-label fixture has 1,334 reads and 1,334 label entries at its largest
size. The old validation and overlap walks each visited 1,779,556 entries. The
new validation visits 1,334 entries once, and each concrete query returns one
candidate. Collector calls and consumed-source counts are unchanged. The
comparison measures validation reuse and indexed lookup together; it does not
assign a separate speedup to either change.

## The Loom gap remains a separate question

Two throwaway probes exercised a labeled array returned by a lift: one used the
trusted builder's `mapWithPattern`, the other compiled a JSX `.map()` into 14
buttons. Their flat and nested arms kept rendered output unchanged while adding
two string arrays to each row. They used emulated storage, one root label, and
`serverExecution: false`, not injected SQLite or a browser worker.

All arms published their expected output. The builder arms performed 20
scheduler actions and commits each. The compiled JSX arms performed five each;
the sampled commit averages were 12.1ms flat and 15.1ms with two 64-element
arrays per row. These single diagnostic runs do not establish a timing ratio;
the probes showed unchanged scheduler action and commit counts but did not
capture consumed-source counts. One action can consume more reads, so those
counts cannot settle the element-shape question. The driver sources and logger
rows are retained in the results.

This follow-up therefore does not explain or close the deployed nested-array
arm's remaining 5.9s versus 3.5s gap in
[issue #7179](https://github.com/commontoolsinc/labs/issues/7179#issuecomment-5668537208).
The indexed metadata-width cost is independently reproduced and fixed here.

## Verification

The index agrees with the existing prefix predicate across an enumerated
concrete/wildcard path corpus. Regression cases cover encounter order, duplicate
paths, root and empty maps, a payload field named `value`, structure entries,
nonrecursive reads, scope/media-type isolation, refreshed metadata between
collections, and malformed nonmatching entries.

Local validation passed: the full runner suite had 1,409 tests and 9,929 steps
with zero failures (one existing ignored step). The CFC run had 184 tests and
1,786 steps; the final index and collector tests passed 12 steps after the
additional canonical-path case. Repository format, lint, type checking, and the
history-index gate passed. An independent subagent reviewed the implementation,
regressions, and measurement claims.

Run the maintained benchmark from the repository root:

```sh
deno bench --no-lock -A --json packages/runner/test/cfc-consumed-source-dedup.bench.ts
deno test --no-lock -A packages/runner/test/cfc-*.test.ts packages/runner/test/cfc/collectConsumedLabel.test.ts packages/runner/test/cfc/ConsumedLabelIndex.test.ts
```
