---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Real-thread policy volume, repeated label structure, and an offline memoization replay."
---

# Inbox policy processing: volume and reuse

## Finding

A 50-message thread open triggers substantial repeated processing of generated
reactive data. The largest commit verifies **201 write targets against the same
2210 read-record addresses and multiplicities**, producing **444210 read-record
visits**. Its 102 full label variants all carry the **same confidentiality
policy**; their differences are generated integrity provenance.

This supports reusing stable policy structure. It does not support caching an
entire authorization decision just because confidentiality labels match:
metadata changes during the commit, and provenance and target context matter.

The preceding
[click attribution](2026-09-14-loom-person-inbox-click-attribution.md) put about
611 ms of sampled worker time inside input-requirement verification, 104 ms in
refusal-input attribution, and 344 ms in label-view rebasing. Those are
overlapping measurements from a separate diagnostic. This report measures the
data and repetition behind them, rather than assigning new latency totals.

## Probe and workload

The frozen candidates remain Loom `40129bb55` and Labs `820bd94a90`, served
against the unchanged pinned toolshed PID 83088. No runtime source or browser
bundle was modified. Nonpausing conditional CDP breakpoints observed function
arguments and already-materialized local read records in a benchmark-owned
worker. Conditions always returned false. They added no Cell reads, durable
writes, or extra subscriptions.

The breakpoints observed prepare entry, input verification after its read-list
construction, refusal attribution, and label-view merge/rebase. Their resolved
locations were checked against the exact saved bundle. Captured policy
structures and resolved addresses stay in the private evidence directory. Two
full count probes completed with no instrumentation errors and identical totals
below. A shipped control used the same probes. A third probe focused on rebase
input/output sizes and repeated value/path pairs.

All captures used the same canonical person and Signal thread, zero visible
bubbles before clicking, and 50 matching visible bubbles afterward. The content
digest matched the source window established by the independent SQL read during
the preceding attribution work. Other two source counts remained zero. Runtime
idle was awaited before each click.

These are **count diagnostics**, not latency measurements: debugger conditions
and structural serialization deliberately add overhead, and external machine
load reached 100.80. Their instrumented open times must not be compared with the
unprofiled 1754.5 ms median.

## Data volume

Both full lift captures produced exactly these totals:

| Counter                                                        | Improved lift | Shipped control |
| -------------------------------------------------------------- | ------------: | --------------: |
| Input-verification calls                                       |           419 |               2 |
| Read-record visits in those calls                              |        447605 |            1264 |
| Distinct-envelope lookups, summed across calls                 |         41747 |             268 |
| Refusal-input attribution calls                                |           206 |               0 |
| Offending-clause/source comparisons implied by the nested loop |        150020 |               0 |
| Label-view rebase calls                                        |           454 |             329 |
| Label entries scanned by rebase                                |        146425 |           21439 |
| Label-view merge calls                                         |          6212 |            2150 |
| Label entries supplied to merge                                |        166611 |            9746 |

Merge includes work called by rebase. Envelope lookups are source-address
lookups inside each invocation, not disk reads. Counts include the runtime
worker's work until the visible-content condition; they do not enumerate only
scheduler actions. The full probe observed 1560 prepare calls, many without a
verification target, versus the earlier profile's 26 scheduler commit-start
calls. Those are different instrumentation surfaces.

### The dominant commit

One prepare accounts for 99.2% of verification read-record visits:

- **201 distinct write targets**, all session scoped.
- **2210 read records per target**, containing **1507 distinct read addresses**.
- **203 source documents**: 202 session scoped and one space scoped.
- The same read-address multiset at every target. This comparison includes
  address, path, scope and nonrecursive posture; it does not prove that every
  other journal field is unchanged.
- Every target's verification schema is literally **`{}`**.

Read paths identify 50 sets of pattern-root metadata, 50 sets of element/array/
parameter arguments, 100 simple link/root documents, and one result array with
indices 0–49. This fits **50 mapped element instances × four documents, plus one
result array**. The exact roles of all 100 simple documents were inferred from
read shapes rather than separately resolving each root.

Thus the 203 documents are not 203 conversations. They overwhelmingly describe
execution structure for the selected thread. With only one actual thread in the
fixture, a whole-merge read and a selected-thread read reach the same 50
messages; this experiment cannot quantify unrelated-thread amplification.

The emitted pattern does expose that risk: `openMessagesOf` declares full
`DisplayThread[]`, and the list-row map declares each full thread including its
messages while capturing `openKey`. The click handler itself is narrow. The
header lift excludes message bodies but still declares all thread headers. These
contracts establish potential read breadth, not proof that every declared field
was consumed in every run.

## How similar are the labels?

At the first target check in the dominant prepare, one nonempty envelope and two
label values are visible. As prepare writes metadata onto generated documents,
later checks see additional envelopes. Across the whole prepare there are:

- **53 distinct serialized policy envelopes**, totaling **588693 bytes** if
  encoded with the probe's stable JSON representation.
- **102 full label values**, all with exactly the same confidentiality array.
- One transformation provenance identity, identifying `openMessagesOf`.
- 100 distinct link-provenance atoms, connecting one source document to 50
  generated argument documents: whole-array references to `array`, and indexed
  references to `element`.

The 102 variants therefore do not mean 102 confidentiality policies. Their
integrity records preserve where particular generated values came from.
Confidentiality and pure clause operations offer much more common structure than
complete labels.

The envelope byte count is a logical representation size, not measured wire
traffic or allocation. For scale, the selected message bodies total 2734 UTF-8
bytes; that excludes headers and all runtime structures. The largest carried
label view contains 1234 path entries and would occupy 424810 bytes in the same
JSON representation. Repetition of policies at paths contributes to this size.

## Rebase repeats whole-view work

The focused third probe recorded 409 rebase calls scanning 146587 entries. Its
window and instrument set differ from the full probes, so its totals stay
separate. Of those input entries, 136458 survived the path selection: most work
was not a search that discarded unrelated paths.

One exact view value with **1234 entries** was rebased at the **empty path 100
times**. Those calls alone scanned 123400 entries, 84% of the total. Across the
capture, 409 calls had only 112 distinct exact view-value/path pairs. Reusing
one canonical result per such pair could avoid 131231 repeated input-entry
visits in this trace, before accounting for cache lookup and required ownership
costs. That is an opportunity estimate, not a measured speedup.

All observed view containers were mutable. A public identity-only WeakMap cache
would miss in-place changes and could return aliased arrays. Reuse belongs in an
owned immutable/canonical representation or a scoped view creator whose base
replacement clears its cache. Existing transaction snapshot memoization already
caches address-derived views; this per-field rebase work occurs outside it.

## Offline test of diagnostic reuse

The dominant prepare calls refusal attribution 101 times with the same two
clauses and the same source snapshot: 710 clause/source records representing 355
read addresses. Across the complete capture, 206 calls use 106 source snapshots
containing 4010 records and produce 37505 attributed input records.

A private Deno replay compared the existing function with an atom-to-source
index, then with that index plus reuse of identical attribution results. The
index uses existing `deepEqualKey` buckets with `deepEqual` verification. Result
memoization also respects rendered atom text, since structurally equal objects
can have different property order when rendered. All 206 calls matched the
existing output and passed fresh-container/mutation-isolation checks.

| Replay arm             | Rep 1 ms | Rep 2 ms | Rep 3 ms | Median ms |
| ---------------------- | -------: | -------: | -------: | --------: |
| Existing attribution   |    28.29 |    26.53 |    26.24 |     26.53 |
| Source index           |    10.15 |     9.70 |     9.63 |      9.70 |
| Index plus result memo |     4.18 |     4.13 |     4.07 |      4.13 |

The reductions are 63% and 84%. Repetitions were interleaved, and each replay
includes index construction for every used snapshot. It excludes source
collection, policy decisions, and deep-freezing the enclosing refusal detail.
These are offline component timings; no end-to-end improvement was measured. An
earlier replay version lacked the rendered-order edge case; its artifacts were
retained, corrected, checked, and superseded by the values above.

## Next implementation candidates

1. **Separate envelope validity from lazy input-gate preparation.** Every read
   envelope must still be checked for an unsupported version or malformed shape,
   even for `{}`. But those 201 empty schemas do not request authored input
   gates, so eagerly spreading and canonicalizing all read records for them is
   unnecessary. Preserve the existing clock-less-read instrumentation contract.
   This is a smaller first change than introducing a new general cache.
2. **Reuse owned canonical label views**, especially empty-path rebases.
   Preserve observation classes, wildcard behavior, independent mutable output
   arrays, and changes to the base view. Avoid re-normalizing identical
   confidentiality clauses at every generated path where the representation
   allows reuse.
3. **Index/memoize attribution within its existing source snapshot.** This has a
   replayed improvement and does not cache a policy verdict. Independent result
   containers and exact output ordering remain part of its behavior.
4. **If read normalization remains significant, process stable read prefixes
   incrementally.** The native V2 read log is append-only while the transaction
   is ready, so a cursor can normalize newly added non-verifier reads before
   each target. Preserve journal positions, duplicates, metadata and
   nonrecursive posture; refresh trigger reads and label-metadata observations.
   Generic Iterable backends need an explicit capability or the current
   fallback.

A cache of complete envelopes for the entire prepare is incorrect without
invalidation: this trace directly observes earlier target writes becoming input
metadata for later checks. A cache of authorization outcomes needs still more
context: target and scope, write prefix, trust, acting principal, and resolved
manifests/grants. Identical confidentiality does not make those interchangeable.

## Evidence and state

Private artifacts are under
`/Users/berni/.codex/investigations/person-inbox-20260914/improvements/`:
`runtime-*-policy-*-policy.json`, `policy-count-summary.json`,
`policy-rebase-summary.json`, the `policy-probe-*` and `measure-policy*`
scripts, `refusal-replay.ts`, `refusal-replay-results.json`, and
`measurements.jsonl`. The raw probes include addresses and policy atoms and are
not checked into the repository. The
[sanitized counts and replay results](2026-09-14-loom-person-inbox-policy-counts.json)
include instrumented attempts and uptime records.

| Count capture              | Load before (1/5/15 min) | Load after (1/5/15 min) |
| -------------------------- | ------------------------ | ----------------------- |
| Lift policy-1              | 44.23 47.90 32.86        | 53.63 49.45 34.01       |
| Shipped policy-1           | 97.14 62.46 40.16        | 95.57 64.42 41.38       |
| Lift policy-2              | 78.25 72.67 48.64        | 100.80 78.84 51.98      |
| Lift policy-3, rebase only | 74.25 76.73 53.26        | 65.52 74.78 52.84       |

All nine offline replay measurements recorded the same before/after uptime:
21:52 Pacific, up 7:24, 14 users, load averages 33.32 63.25 50.34. Each is
retained beside its raw time in the accompanying JSON.

The runtime production branch remains at `820bd94`; no production code was
changed. The acceptance browser tree was restored to the saved pin after each
capture, and the same toolshed remained running. No pin was adopted or change
published.
