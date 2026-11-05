---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Four-arm comparison selecting transaction-epoch memoization."
---

# Prepared digest cache selection

The selected implementation memoizes the complete digest at a transaction's
activity epoch and retains the original canonical hashing algorithm. Per-record
composition and an identity-keyed LRU were tested but not selected. This report
supersedes the implementation recommendation of the [initial
measurements](../2026-09-15-prepared-digest.md); their raw results remain intact.

## Comparison and reproducibility

All four arms use baseline `53baf62fdaf9dae6824bc9c5a0da812a64b95d6c`, identical
harness plumbing, and identical fixtures. `baseline` only adds measurement
access; `epoch` adds transaction memoization and its activity invalidation;
`parts` adds canonical-record hash composition from commit
`157d079fbd569be652dbdc51de74e52df978ae6c`; `lru` replaces that arm's frozen-object
hash WeakMap with an 8,192-entry LRU and its four record-projection WeakMaps with
2,048-entry LRUs. It uses the existing `LRUCache` utility. These bounds count
entries, not retained bytes.

[Raw data](data.json) includes all per-round timings, arm order, profile counts,
GC probes, and patch hashes. [replay.py](replay.py) creates isolated worktrees,
applies the retained shared and arm patches, and reruns the experiments. Full
original stdout, stderr, CPU profiles, and the final selected unit ladder are
also retained in
`/Users/berni/.codex/investigations/prepared-digest-20260915/cache-selection`.

Measurements used Deno 2.9.4 on an Apple M3 Max with other work active. Each
ladder used five interleaved rounds, rotating arm order. Timing columns are
medians; speedups are medians of same-round ratios, not quotients of the timing
columns. These small, shared-machine samples justify a workload-specific choice,
not precise universal latency claims.

## Unit ladder: preparation plus unchanged recheck

Each sample constructs a fresh transaction with 300 read activities, 300 traces,
and the stated number of write-policy payloads. Setup and abort are untimed.
Both digest requests are timed together. A common digest-equality guard is also
inside the historical replay benchmark's timed interval; the committed benchmark
performs that guard after timing. Each table cell is the median of five per-run
75th percentiles in milliseconds.

| Writes | KiB | Baseline ms | Epoch ms | Parts ms | LRU ms | Baseline / epoch |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 5 | 1 | 4.727 | 2.346 | 4.457 | 4.632 | 2.17x |
| 5 | 10 | 5.491 | 2.219 | 4.513 | 4.453 | 2.47x |
| 50 | 1 | 6.459 | 2.515 | 6.221 | 5.861 | 2.83x |
| 50 | 10 | 5.813 | 2.975 | 6.324 | 5.743 | 1.81x |
| 200 | 1 | 9.870 | 4.291 | 10.697 | 9.332 | 2.11x |
| 200 | 10 | 10.863 | 4.657 | 9.775 | 10.781 | 2.11x |

Epoch-only avoids the second computation without paying for hundreds of cold
per-record hashes. At 50 writes and 10 KiB, parts takes 1.92x as long as epoch
on the median paired comparison. The earlier [separate-phase
ladder](../2026-09-15-prepared-digest-paired-summary.md) showed the reason:
cold composition took roughly 1.6–1.8x baseline time, while already-hashed
records composed cheaply. Normal preparation and unchanged recheck offer only
one computation after epoch memoization, leaving no second hash pass in which
to amortize composition's cold cost. Repreparing after journal activity can
reuse some parts, but reconstructs read/write records too. There is no
runtime-wide warm-up threshold that makes freshly allocated records warm.

A single validation run of the final selected benchmark also exercises all five
phases. Its 50-write, 10-KiB 75th percentiles were 3.26 ms for the first digest,
0.000333 ms for the unchanged second request, 2.58 ms after one more write,
2.07 ms for direct hashing of warmed records, and 2.73 ms for preparation plus
recheck. All measured object-cache hit counts were zero: the unchanged request
uses the transaction memo, while changed snapshots retain whole-input hashing.
These are validation samples under variable load, not paired speedups.

## Shared arm B: labeled SQLite rows

The fixture maps labeled SQLite title rows into paragraph views at 11, 50,
and 150 rows. It runs under `enforce-explicit` / `persist`, with idempotency
replay disabled. Each metric covers its render-to-completion window; setup,
seeding, and assertions are outside. All six assertions passed in every sample,
with no runtime errors.

| Rows | Baseline ms | Epoch ms | Parts ms | LRU ms | Baseline / epoch | Epoch / parts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 11 | 107.9 | 87.3 | 81.8 | 123.7 | 1.143x | 1.001x |
| 50 | 518.4 | 370.2 | 436.3 | 493.8 | 1.323x | 0.930x |
| 150 | 3749.4 | 3214.8 | 2977.4 | 3113.4 | 1.197x | 1.073x |

Epoch beats parts in four of five 50-row pairs, by about 7% in the paired
median. Parts wins four of five 150-row pairs, by about 7%. The representative
50-row case favors epoch; the larger case is evidence against claiming epoch
is always fastest. LRU loses to epoch in all five 50-row pairs.

## Repeated executions with stable labels

A separate fixture seeds 50 labeled SQLite rows once. Three successive actions
increment a revision consumed by the same mapped computations, changing rendered
text without changing the declared confidentiality label. Each round's metric
is the median of three update-action-plus-following-render durations. Seeding,
initial render, and assertions are excluded. All four assertions passed in
every sample, with no runtime errors.

| Arm | Median update plus render ms | Baseline / arm | Epoch / arm |
| --- | ---: | ---: | ---: |
| baseline | 138.79 | 1.000x | 1.012x |
| epoch | 143.57 | 0.989x | 1.000x |
| parts | 155.86 | 0.962x | 0.872x |
| lru | 145.40 | 0.976x | 0.975x |

Epoch-only and baseline are effectively tied here. Epoch takes about 13% less
time than parts in the median paired comparison and wins four of five pairs.
There is no demonstrated substantial cross-execution cache win from a stable
label alone.

An independent, untimed identity probe compared preparations from the same
reactive action: 151 repeat comparisons, 150 equal canonical write-policy
inputs, and 100 equal complete digests. None reused read, trace, or policy
record identities (2,860 reads, 802 traces, 302 policies examined). In the
51 differing snapshots, consumed reads and writes changed; trigger reads also
changed in 50. These counts substantiate stable policy content while showing
why identity caches miss and why label equality cannot substitute for full
transaction-activity equality. The instrumented probe's durations are excluded
from performance comparisons.

## GC and retention

Forced GC preserved a cached ordinary frozen object in both WeakMap and LRU.
For parts, a retained input had 650 cache hits after GC in both implementations;
fresh equal records had zero hits in both. A changed payload changed the digest
even with its declared label unchanged. WeakMap entries remain available while
their keys are live. An identity-keyed LRU retains dead keys but cannot associate
a new equal object with an old key.

A separate forced-GC probe hashed and discarded 4,000 frozen objects carrying
10 KiB strings. Heap growth was about 4.70 MB with WeakMap and 44.02 MB with
LRU, an additional 39.32 MB retained by the LRU arm. This controlled single-probe
comparison is not a product-wide heap estimate; other caches also contribute
to the common growth. The LRU neither added useful hits nor improved the
representative 50-row runs, so the selected implementation retains WeakMap.

## Profile attribution

One separate profiled pair used 500-microsecond sampling. Samples are assigned
to render windows using the profiler-start timestamp. Hasher share counts each
sample whose stack includes `value-hash.ts`; digest share counts each whose
stack includes `preparedDigestFor`. These overlapping categories are not added.

| Rows | Baseline hasher | Epoch hasher | Baseline digest | Epoch digest |
| --- | ---: | ---: | ---: | ---: |
| 11 | 4.79% | 2.69% | 2.93% | 1.27% |
| 50 | 22.46% | 15.50% | 23.28% | 15.70% |
| 150 | 19.93% | 14.04% | 20.83% | 14.26% |

The 150-row native-hasher share fell from about 19.9% to 14.0%. This is a
Deno/native profile, not a browser/WASM measurement of the cited 19-second
opening. A single profiled pair is attribution evidence, not another wall-time
speedup sample.

## Scope of the selected change

Scheduler preparation and commit recheck request a token for the same
transaction. The epoch memo removes redundant digest construction and hashing
when no activity intervenes; policy verification still runs. Fresh transactions
compute independently. Ordering, set semantics, and digest arithmetic remain
those of the original canonicalizer.

Tests retain insertion-order equality, differing writes, canonical paths,
trace deduplication, policy multiplicity, unchanged commit reuse, late activity,
failed write attempts, and immutable trust/implementation inputs. The proposed
per-part objective is deliberately not claimed complete: representative evidence
favored removing it. Exploiting stable policy content across reactive executions
would require a separately designed cache keyed by semantic versions or content,
covering every decision input and avoiding a full hash just to discover a hit.
