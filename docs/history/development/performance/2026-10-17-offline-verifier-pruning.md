---
status: historical
created: 2026-10-17
archived: 2026-10-17
reason: "Bounded offline-verifier pruning experiments and correctness evidence."
---

# Offline verifier: reuse evidence and seek directly to replay ranges

Two local optimizations retained exhaustive verification: sharing each store's
primary reconstruction between head comparison and fingerprinting, and making
replay bounds usable by SQLite's existing index. Reconstruction reuse reduced a
bounded real-data phase from **25.50 to 13.98 seconds** (minimum of five pairs).
Indexed bounds removed history-length scaling in a fixed-suffix fixture.
The final synthetic full-verifier comparison improved by about **12%**. A real
full-compaction verifier run was not measured by this investigation.

## Scope and provenance

The baseline was `67974410f7e4c011f30279fc6b7eb3b83cd6a2d6`, the final head of
[PR #9045](https://github.com/commonfabric/labs/pull/9045). The follow-up was
developed locally on `perf/offline-verifier-pruning-2026-10-17`, using existing
bounded cohorts and synthetic fixtures. #9045 remained open, with its required
Status check, all four test lanes, and Cubic passing.

Measurements ran on Linux 7.2.6, AMD Ryzen AI 9 HX 370, Deno 2.9.4, V8
15.0.245.2-rusty, and TypeScript 6.0.3. Benchmark workers were pinned to CPU 22
at niceness 10 on a shared machine. These measurements followed the hardware
upgrade and are not directly comparable with the earlier
[fingerprint investigation](2026-10-17-offline-fingerprint.md).

The source snapshot was opened read-only. Mutations were confined to disposable
synthetic fixtures. The maintenance clone, production, maintenance references,
and identity keys were outside this work. Evidence and throwaway measurement
scripts remain local under
`/home/wkelly/clones/offline-verifier-pruning-20261017/`.

## What was pruned, and why it was sound

### Duplicate reconstruction within one store

`fingerprintReader()` returned a primary reconstruction while retaining its
classification, value hash, manifest causes, and diagnostic evidence. The full
verifier used the backup fingerprint's primary observations for head comparison;
the result reader captured its own evidence from the other reconstruction.
Primary document bodies were released after comparison. Related-document reads
used a separate 256-entry scope-local cache in each store.

The reused result belonged to the same unchanged store, configured branch,
scope, entity, and latest read. Both stores still reconstructed independently.
Equality of head IDs, counts, hashes, or plan selections supplied no shortcut.
Whole-document canonical encoding still compared metadata and generated cells.
Identical decode failures on both sides still failed the document comparison.

Each fingerprint independently enumerated visible revisions, including entities
without heads, and used its own revision counts for diagnostic ordering. A
visited bitmap sent heads missed by an aborted backup scan through the ordinary
comparison path. Mismatch examples and comparison exceptions retained head-order
precedence. Fingerprint failures retained each store's enumeration/listing order
and result-before-backup precedence. Generated exclusions were applied only
after collecting manifest causes across all scopes.

Self-review found that spreading a caller's address could accidentally forward
an extra `atSeq` property into the new reader. The final implementation selected
`id` and `scope` explicitly and supplied its configured branch, so a historical
cut could not contaminate head evidence. A regression test failed before the
fix and passed after it. A separate test held primary documents equal while
their schema documents differed, confirming store-specific classification.

### Rows outside the replay interval

The replay query expressed lexicographic bounds as `OR` predicates. Its query
plan used only the `(branch, id, scope_key)` index prefix. Equivalent tuple
predicates exposed the `(seq, op_index)` range to SQLite:

```sql
AND (seq, op_index) > (?, ?)
AND (seq, op_index) <= (?, ?)
```

This changed how the existing row set was found. It preserved the operation
filter, ordering, address fields, and bound inclusivity. Exact-row reads still
excluded snapshots at their own sequence; latest-at-sequence reads retained
their whole-commit snapshot rule. The older set base was still decoded before
snapshot selection, preserving corruption detection beneath a newer snapshot.

The local benchmark
`packages/state-inspector/test/reconstruct-range.bench.ts` held the replay suffix
fixed while growing older history. Its fixture included two operations at one
sequence, snapshots, and a later replacement. Unit tests checked the exact-row
and latest results, with and without snapshots, and a corrupt set base.

## Measurements

### Paired head comparison plus fingerprinting

The existing cohort held **2,108 addresses across 101 scopes**: 1,000 busy
space-scope entities plus the entities in 100 other scopes. Two read-only handles
opened the same source history. Enumeration was replaced with the fixed cohort;
related-document reads used the source normally. The timer included both sides'
replay, whole-document comparisons, classification, hashing, and roll-ups. Source
selection, opening, process startup, and report serialization were outside it.
This was a phase workload, not a full compaction verification.

Five measured pairs alternated execution order after an excluded warmup pair:

| Implementation | Minimum | Median |
| --- | ---: | ---: |
| Separate comparison and fingerprint passes | 25.498 s | 26.431 s |
| Reconstruction/evidence reuse | 13.984 s | 14.530 s |

The minimum and median ratios were both approximately **1.82×**. Complete
serialized outputs matched in every arm, including both fingerprint reports and
the comparison count; their SHA-256 was
`c4d610a1927b1c5b610fa7a173d9d136ae25321a6068dff8cee09b1ae9943f6a`.
A separate instrumented pair counted **31,350 → 18,286 SQL calls**, excluding
the replaced enumeration. These measurements used the evidence-reuse prototype
before indexed bounds and the final address-selection fix. A subsequent
five-round tuple-query experiment showed no clear additional cohort gain.

### Fixed suffix, increasing old history

Five interleaved pairs per case followed an excluded warmup pair. Each sample
performed 500 reconstructions; assertions and encoding of the returned outcomes
were outside the timer. The comparison used the same reader and fixture, with
the original predicates restored through a query wrapper for the baseline.
All returned outcomes matched. Median microseconds per read were:

| Old revisions | Snapshot: original / indexed | Exact first operation: original / indexed |
| ---: | ---: | ---: |
| 100 | 73.71 / 65.03 | 62.58 / 65.26 |
| 1,000 | 93.81 / 39.62 | 106.95 / 54.27 |
| 10,000 | 573.01 / 38.97 | 593.15 / 48.09 |

The recent set base made the base lookup short in this fixture. The gain came
from avoiding the irrelevant prefix in patch selection; it did not establish
constant-time base lookup for an arbitrary history. Direct `deno bench` runs
also showed this scaling change. Their JSON retained the observed sample counts
and distributions separately from the interleaved experiment.

### Full verifier on the existing synthetic fixture

The fixture compared **1,003 heads and 1,000 materialized boundaries**. Seven
interleaved fresh-process pairs measured `verifyCompaction().elapsedMs`, which
excluded process startup:

| Implementation | Minimum | Median |
| --- | ---: | ---: |
| #9045 baseline | 1.119 s | 1.178 s |
| Evidence reuse and indexed bounds | 0.987 s | 1.036 s |

The median reduction was **12.0%**. All 24 ordered check records and every other
report field matched after removing elapsed time. These timings preceded the
head-only address guard; the benchmark supplied ordinary head addresses.

## Correctness checks and rejected approach

The clean fixture and its four existing tampered variants preserved complete
ordered reports. Seventeen additional variants covered identical corrupt
payloads, altered and corrupt snapshots, operation-index changes, missing
revisions and heads, revision-only data, changed generated causes, BLOB payloads,
NULL absence, changed ancestry, classification failure, and deeply nested data.
Fourteen returned matching complete reports; three deeply nested cases threw
matching errors on both implementations. Every mutation in the final harness
asserted a nonzero changed-row count. An earlier snapshot mutation had matched
zero rows and was replaced before counting it as evidence.

The package run passed **145 tests / 347 steps**. After adding the final
store-specific schema test, the focused fingerprint suite passed all **16
steps**. The new cases also exercised generated session documents, independent
enumeration, caps, early fingerprint failure, mismatch ordering, and corrupt
bases beneath snapshots. Repository formatting, lint, and workspace type
checking passed during the investigation; final gate logs accompany the local
commit. The existing historical fingerprint report was preserved.

An earlier prototype compared full typed revision/snapshot multisets with
grouped SQL `EXCEPT` scans before skipping a result-side replay. On the synthetic
fixture its median was **1.264 s versus 1.301 s**, too small a gain to justify
another whole-history scan and its proof obligations. That approach was removed.
Snapshot-bounded base decoding was also excluded because it could hide a corrupt
older base.

## Recommendation and limits

The measured follow-up supported local commits for same-store evidence reuse and
indexed replay bounds. Its full-store benefit still depended on the real
verifier's phase distribution. If paired comparison/fingerprinting occupied
fraction `f` of runtime and improved by 1.82×, the corresponding projection was
`T_new / T_old = (1 - f) + f / 1.82`, before other workload differences. The
bounded cohort did not measure whole-store memory or an end-to-end speedup.

The parent workstream retained ownership of full-compaction measurements and
board rehearsal. Follow-up publication required coordination. Production
adoption still required landed Labs/build provenance, immutable maintenance
references landed on infra main, and a fresh rehearsal.
