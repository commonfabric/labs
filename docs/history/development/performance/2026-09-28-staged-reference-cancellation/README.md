---
status: historical
created: 2026-09-28
archived: 2026-09-28
reason: "Paired synthetic measurements of staged-reference cancellation suspension points."
---

# Staged-reference cancellation measurements

Adding suspension points inside recursive label derivation reduced the observed
wait for cancellation on deep synthetic diamonds. It preserved every matched
label-map hash and derivation count. This measures responsiveness on a heavily
contended development machine; it does not establish production latency or a
throughput improvement.

## Comparison and method

The baseline was `e42b9625643ea76029052a23bc63c4693a8e72ff`. The candidate changed
`packages/runner/src/cfc/prepare.ts` to delegate staged-reference derivation and
integrity-floor checks through the preparation generator. Only that source file
was swapped between arms; its SHA-256 hashes are in [manifest.json](manifest.json).
The candidate source was restored and its hash verified after measurement.

Five process pairs alternated baseline/candidate order. Each arm ran three fresh
Deno processes: cooperative completion, synchronous completion, and cancellation.
The 30 process invocations yielded 340 records in [samples.jsonl](samples.jsonl).
All times in those records are milliseconds. The manifest records process order,
options, start times and system load; sample counters retain derivation counts,
cache hits and completed preparations.

Each sample used a fresh emulated store and runtime with `enforce-explicit` and
flow-label persistence. A stored leaf carried `secret` confidentiality. Each of
`depth` new objects had one or two fields pointing at the same next object; a
holder referenced the root. Every new object and holder declared `object-proof`
integrity. Both source-first (`bottom-up`) and holder-first (`top-down`) staging
orders were measured. Setup, commit, label inspection, serialization and teardown
were outside preparation timing. Successful runs checked every deepest leaf label
and hashed the complete stored maps of the holder and all nodes.

Completion processes first warmed up with a depth-2, width-2 graph. Cooperative
processes then took two samples per depth/order; synchronous processes took six
per width/order, with their first two excluded from the reported timing summary.
Cancellation processes did not warm up and scheduled an abort timer for 25 ms
immediately before preparation. Every cancellation returned
`StorageTransactionAborted`; reading the holder afterwards confirmed no payload
was committed.

The normal cooperative driver's 16 ms budget was retained. Instrumentation around
`maybeYield` recorded both time between generator steps (`maxStep`) and actual
uninterrupted event-loop slices (`maxEventLoopSlice`). The latter resets only
after a real macrotask yield, excludes the wait to resume, and includes the final
preparation segment. A generator suspension that does not yield to the event loop
does not reset that measurement.

The environment was Deno 2.9.4, V8 15.0.245.2-rusty and TypeScript 6.0.3 on arm64
macOS 26.6.2. This investigation's tests and checks were stopped before timing,
but unrelated Deno, Python and Swift work remained active. One-minute system load
at process starts ranged from 70.3 to 172.8. That contention makes small timing
differences and throughput conclusions unreliable.

## Cancellation

Five observations per arm and depth, width 2, holder-first staging. The timer was
scheduled for 25 ms; the values below are when its callback actually fired after
preparation began, not an additional delay after that deadline.

| Depth | Baseline median (range), ms | Candidate median (range), ms |
| --- | --- | --- |
| 12 | 716.2 (248.5–1029.9) | 47.9 (43.3–84.3) |
| 14 | 1881.9 (791.1–3110.4) | 48.4 (37.9–101.1) |

The observed ranges did not overlap. These graphs exercised cancellation while
walking the first target's references, before that target's full map was built.

## Completion and synchronous controls

Cooperative completion has ten observations per arm and case. Entries are
baseline → candidate medians in milliseconds.

| Depth | Staging | Preparation elapsed | Longest event-loop slice |
| --- | --- | --- | --- |
| 10 | Source first | 312.3 → 352.8 | 94.9 → 35.7 |
| 10 | Holder first | 270.5 → 270.3 | 108.7 → 32.3 |
| 12 | Source first | 1159.6 → 1171.3 | 455.6 → 85.5 |
| 12 | Holder first | 908.3 → 868.9 | 360.5 → 72.1 |

Synchronous completion has twenty retained observations per arm and case. Paired
ratios divide the candidate median by the baseline median within each process
pair, in pair order. Values above 1 are slower.

| Width at depth 12 | Staging | Elapsed median, ms | Five paired ratios |
| --- | --- | --- | --- |
| 1 | Source first | 13.005 → 12.310 | 1.899, 1.134, 1.007, 0.906, 0.695 |
| 1 | Holder first | 11.983 → 12.160 | 2.053, 1.014, 0.854, 1.357, 0.572 |
| 2 | Source first | 1158.221 → 1006.402 | 1.267, 1.096, 0.666, 0.844, 0.673 |
| 2 | Holder first | 981.033 → 737.907 | 0.878, 0.997, 0.722, 0.517, 0.591 |

There is no consistent slowdown across these controls, but the variation and
background load cannot rule out small overhead or support a throughput-speedup
claim. The useful result is earlier cancellation and shorter uninterrupted work
on these synthetic graphs.

## Output and work preservation

Every baseline/candidate pair, including the discarded timing warmups, had
identical complete-map hashes, serialized byte counts, entry counts and derivation
counts for its case, depth, width and staging order. Staging orders also agreed.

| Case | Total entries | Serialized bytes | Derivations | Cache hits |
| --- | --- | --- | --- | --- |
| Depth 10, width 2 | 6130 | 691120 | 221 | 162 |
| Depth 12, width 1 | 104 | 14282 | 91 | 0 |
| Depth 12, width 2 | 24560 | 2990354 | 313 | 242 |

The depth-12, width-2 holder alone had 8192 entries. This change did not reduce
flat-map size or recursive work. Cooperative and synchronous depth-12 wide cases
had different serialization hashes; a separate comparison of their complete
parsed maps found them equal, with only JSON object-property ordering differing.
The maintained regression also compares complete maps across forced yields and
checks the deepest confidentiality and integrity labels.

## Limits and validation

Individual flat-map operations and final ceiling, grant and digest work remain
synchronous. The observed 72–86 ms median worst slices at depth 12 demonstrate
that suspension points do not provide a hard 16 ms latency bound. There is no
transaction-size cap or compact persisted format in this change. These are
synthetic runtime transactions, not measured application patterns or a deployed
server workload.

The candidate passed repository formatting, lint and type checking, focused CFC
checks, and the full runner suite: 1574 tests and 12121 steps passed, zero failed,
one ignored step. Regressions cover aborting within the first target, preservation
of every stored label across forced yields, and transaction mutation during an
inner yield without retaining privileged write access. The first-target
cancellation regression fails against the baseline.
