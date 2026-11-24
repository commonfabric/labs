---
status: historical
created: 2026-10-17
archived: 2026-10-17
reason: "Local offline-verification investigation and benchmark evidence."
---

# Offline fingerprinting: reuse reconstruction before adding workers

The local optimization completed an exhaustive fingerprint of the 26.52 GB
Topics snapshot in **13m05.22s**, matching the maintenance baseline's content
hash and all fingerprint counts. A fixed, smaller cohort gave byte-identical
complete reports in **13.52s versus 51.95s**, best of five interleaved runs.
Repeated owner-document decoding dominated that cohort. Two-process replay
helped a separate bounded workload, but less than deduplication.

This was local investigation, not a deployed verifier release. The full
compaction verifier was exercised on synthetic compacted stores; its total
runtime on the real snapshot was not measured.

## Inputs and isolation

- Baseline checkout: Labs `fcdd1ae9272ef27ed7da15c01984169963fcf004`, fetched
  from GitHub main. Since maintenance's board pin `75711b5c45`, the inspector's
  only intervening change was the file-URL conversion change `da2dd5d96a`.
- Optimization worktree: `/tmp/opencode/labs-offline-verification-2026-10-17`,
  branch `perf/offline-verification-2026-10-17`.
- Source: the immutable `topics-before-board.sqlite` snapshot, 26,519,273,472
  bytes, SHA-256
  `cfa4fe2fc4d91469c22c0f55a6c1bccb3e2c9b28fbce79ce2f6ed346e231feb9`.
  It held 1,363,758 head instances, 3,952,056 revisions, and 2,552,863 commits.
- Environment: Linux, 24 logical CPUs, about 93 GiB RAM, Deno 2.9.4. Benchmarks
  ran at niceness 10 alongside maintenance and other bounded local work.
  Parallel replay used at most two processes. Workspace checking was confined
  to two CPUs. These were shared-host measurements, not isolated machine runs.
- All source handles were read-only. Synthetic compaction inputs and outputs
  lived in a new evidence directory. Maintenance checkouts, live services, and
  the served clone database were untouched.

Evidence and throwaway harnesses remain local under
`/home/wkelly/clones/offline-verification-optimization-20261017/`. Logs contain
timings, counts, and hashes, not document bodies. No identity key was needed.

## Where the time went

`profile.ts` timed enumeration and then the 1,000 busiest space-scope entities:

| Phase | Wall time |
| --- | ---: |
| Enumerate all 1,363,758 instances | 6.205 s |
| Build models for the 1,000-entity cohort | 4.006 s |
| Reconstruct those entities again | 2.906 s |
| Hash their already-reconstructed values | 0.050 s |

The second reconstruction spent 2.478 s inside the latest-set/delete SQL
lookup, versus 0.128 s fetching patches. Query plans showed indexed head
lookups, but the base and patch queries' disjunctions did not yield a
sequence-range seek. Enumeration used one covering-index pass, not a scan per
scope. This distinguished query cost from parsing, patching, and hashing.

The larger cohort contained the 5,000 busiest space-scope instances and all
1,108 instances of the first 100 lexically ordered non-space scopes: **6,108
instances in 101 scopes**. Both implementations received exactly that
enumeration and read related documents from the full read-only source. This
was a bounded comparison, not a verification verdict about the whole source.
Enumeration was performed once outside the timed A/B calls.

A separate 5 ms V8 profile of that A/B attributed the fingerprint samples as
follows. These are sampled attribution durations, not independent wall timers:

| Path | Baseline | Optimized |
| --- | ---: | ---: |
| Classification's related-document reads | 40.309 s | 6.752 s |
| Primary document reconstruction | 12.484 s | 6.788 s |
| Value hashing | 0.291 s | 0.450 s |
| Display link counting | 0.026 s | omitted |

The combined profile put 50.7% of self samples in `addToDeepFrozenCache`.
Repeatedly parsing and freezing owners reached through `streamDeclarationOf()`
was the principal avoidable work. Eliminating display link counts was not the
principal gain. Hashing generated values before their eventual exclusion added
a little work; it avoided retaining their documents or replaying included
entities after all manifests were known.

An engine-style snapshot-bounded base lookup was deliberately not introduced:
the inspector decodes the older set base even when a newer snapshot wins.
Skipping that decode could stop detecting a corrupt base. The patch leaves
reconstruction and exact-row boundary checks intact.

## Implemented fast path

Only `fingerprint.ts` changed executable behavior:

1. Enumerate every visible scope using the existing branch-aware enumeration.
2. Reconstruct each primary entity once and feed that same document to the
   existing classifier, manifest reader, and canonical value hasher.
3. Keep an LRU of at most 256 related lookup results per scope, including
   absent/corrupt related reads. Its underlying reader retains space-scope
   resolution for `cid:` schemas and the requested branch for every lookup.
4. Retain compact hashes, causes, and failures instead of whole-scope document
   bodies. Apply generated exclusions only after every scope's manifests have
   contributed, including causes discovered in later scopes.
5. Retain the listing's kind/revision diagnostic ordering, canonical address
   order, scheme 1, ambiguity reporting, and included corruption/unhashable
   behavior. An included decode error still throws; excluded generated
   corruption remains excluded.

The synchronous public APIs and full compaction verifier's checks were retained.
The verifier benefits through its existing fingerprint calls. Its separate
head-comparison reconstruction still runs; merging that evidence into the
fingerprint would require a further change.

## Comparative results

For the 6,108-instance cohort, five interleaved pairs produced:

| Measure | Baseline | Optimized |
| --- | ---: | ---: |
| Minimum wall time | 51.948 s | 13.523 s |
| Wall-time range | 51.948–78.305 s | 13.523–19.213 s |
| Queries after branch-cache warmup | 70,390 | 34,389 |

The minimum ratio was **3.84×**. Every complete JSON report was byte-identical,
including classifications, ordered exclusions, and diagnostics. The report
SHA-256 was
`138fc116f956b0321663df435b18caec3f20d3085502b0bacd8d7f5fde2fc74e`.
`comparison.json`, `comparison.time`, `cohort.cpuprofile`, and
`cpu-attribution.json` hold the evidence. Repeated comparisons shared a process,
so their end-of-call RSS readings are not independent peak-memory measurements.

### Exhaustive real-snapshot fingerprint

The optimized full run returned:

- Fingerprint:
  `fid1:pIvbSXTSrGwddcG2CVeS55OU9P5CqrCWaDL_-ks768g`.
- Included entities: **1,235,334**; excluded generated addresses: **128,424**.
- Ambiguous causes: **0**; unhashable values: **0**.
- Fingerprint call: **785.220 s**; whole process: **788.25 s**.
- User/system CPU: **803.48 / 26.50 s**; CPU utilization: **105%**.
- Peak RSS: **4,386,172 KiB**; swaps: **0**.

The hash and counts exactly matched the parent session's completed clone
manifest. That clone command took **35m56.39s**, with user/system CPU
**2310.82 / 57.68 s** and peak RSS **5,181,052 KiB**, also without swapping.
The clone command includes copying, file hashes, and bookkeeping, whereas this
run timed fingerprinting directly, so these are not an isolated end-to-end A/B.
The full run checked content-hash/count equality, not byte equality against the
parent's entire per-entity sidecar. The bounded A/B did check complete-report
byte equality.

`full-optimized.json`, `full-optimized.time`, and `parent-baseline.json` record
this comparison. The source's full fingerprint covered every enumerated
instance; no sampling option was used.

### Full compaction verification on synthetic stores

`compaction-compare.ts` built 1,000 computed instances with eight patches each,
one manifest owner, an ACL, authored content in two scopes, and a non-history
table. It compacted a dedicated writable copy with three retained revisions
and compared baseline and optimized verifier reports in separate processes.

All **24 ordered checks and their details** matched, with only `elapsedMs`
excluded from comparison. The clean result passed; four independent variants
failed identically: corrupted generated content at a materialized boundary,
removed per-user state, changed non-history table contents, and a changed
commit payload. The clean pass took **10.085 s versus 0.873 s**. This fixture
deliberately stresses repeated reads of one large owner manifest, so its ratio
must not be extrapolated to a real store.

`compaction-fixture/comparison.json` records the verdicts and timings. The
package suite passed **143 tests / 330 steps**, including nine new cases for
cross-scope generated causes, diagnostic order, corruption and tombstones,
scope-local and schema-reference lookups, cache lifetime, branch inheritance,
child-local patches, legacy scope-less stores, and reconstruction reuse.

## Parallelism experiment and next seam

A disposable two-process experiment partitioned a separate 2,108-instance
cohort by stable enumeration index. Each process opened its own read-only
handle, reconstructed each assigned document once, and canonically encoded and
hashed the whole document. The parent checked the exact returned index set,
ordered the results deterministically, and compared every result with the
single-process run. No document bodies crossed the process boundary.

Across five interleaved runs, minimum wall time was **3.220 s with one process
versus 2.332 s with two**, a **1.38×** gain including process startup and IPC.
Every aggregate was identical. An injected worker failure propagated, and the
parent awaited all child exits. End-of-work child RSS was about 181–185 MB for
one process and 318–322 MB combined for two, not a measured concurrent peak.
See `process-parallel.json` and `process-parallel.time`.

An earlier Web Worker prototype produced no result and was idle when diagnosed;
the investigator stopped only that experiment. Its cause was not established,
and it is not evidence for a working production worker implementation.

The next integration seam would be bounded batches of independent verifier
evidence: exact-row boundaries, paired head comparisons, and payload checks.
A coordinator must validate complete partition coverage, merge counters and
the first five failures by original enumeration index, and retain every SQL,
ACL, branch, tombstone, metadata, and fingerprint check. Fingerprint causes
must be unioned globally before exclusions; partial fingerprint roll-ups cannot
simply be combined. Reusing paired-head evidence also needs a final coverage
walk for revision-only entities, with ACL handling kept separate. Inputs must
be frozen offline snapshots shared by all readers; worker exits and malformed
messages must fail the operation. These are design requirements, not shipped
APIs or a claimed full-verifier speedup.

The measured deduplication change was the smaller, better-proven candidate for
review. Production use still requires landing Labs source on GitHub main, a
main-workflow build after landing, immutable artifact references landed on
infra GitHub main, ancestry and provenance verification, and a fresh rehearsal.
No push, merge, artifact update, or live deployment was performed here.
