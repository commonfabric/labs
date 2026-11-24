---
status: historical
created: 2026-10-13
archived: 2026-10-13
reason: "Measurements of the review fixes for PR 8814; current ownership semantics are maintained in the feature contract."
---

# Immutable-cell review fixes: measurements

This record measures the working tree after the review of `95d9703` on
[PR 8814](https://github.com/commonfabric/labs/pull/8814), including weak ownership
of array-element snapshots and shared clone cycle tracking. It does not describe
an isolated machine or deployed latency. The
[live contract](../../../../features/immutable-cell-identifiers.md) states the
ownership and serialization rules.

## Retention

`packages/runner/test/immutable-cell-retention.ts` creates 100 distinct versions
of a 1,000-row value, crosses event-loop turns, and forces collection. Each row
contains a 256-character payload. The local Deno runtime is recorded in
[retention.json](retention.json); these are single retained-heap samples, not
latency measurements or medians.

| Representation | Discarded IDs, MiB retained | Retained ID strings, MiB retained |
| --- | ---: | ---: |
| Legacy data URI | 0.828 | 38.441 |
| Explicit runtime-owned snapshot | 34.540 | 34.545 |
| Element snapshot | 0.038 | 0.032 |

Element IDs do not themselves retain values: a source value or a cell/link
object must remain live, or a caller exports a portable ID. Explicit immutable
cells keep their runtime-long ownership. The CI retention regression checks 100
live versions, equal-content deduplication, collection of discarded versions,
and survival through source, cell, link, parsed-link, and converted-event owners.

## Creation time

`packages/runner/test/immutable-cell-measure.ts` measures the element path using
`createElement()`. Two warm-up pairs precede seven measured pairs with alternating
arm order. Input construction, freezing, decoded-value equality checks, and
identity assertions sit outside the timed region. Reused input uses ten
iterations per sample; fresh input uses one. All raw samples are in
[paired.json](paired.json).

The shared host's one-, five-, and fifteen-minute load averages were
395.44 / 389.05 / 377.01 ([host.txt](host.txt)). Other test suites and development
work were running. The harness invokes local codec/runtime functions and starts
no server. Wall-clock timings under this contention cannot establish production
latency or a reliable fresh-input speedup.

| Link schemas | Rows | Input | Legacy median ms | Native median ms |
| --- | ---: | --- | ---: | ---: |
| inline | 100 | fresh frozen | 14.4094 | 112.8890 |
| inline | 100 | fresh mutable | 350.6822 | 220.3779 |
| inline | 100 | reused frozen | 5.5893 | 0.0029 |
| inline | 1000 | fresh frozen | 127.9392 | 487.1672 |
| inline | 1000 | fresh mutable | 1770.4115 | 1704.5989 |
| inline | 1000 | reused frozen | 116.7611 | 0.0045 |
| reference | 100 | fresh frozen | 4.2244 | 6.6464 |
| reference | 100 | fresh mutable | 7.0863 | 8.8986 |
| reference | 100 | reused frozen | 8.8581 | 0.0036 |
| reference | 1000 | fresh frozen | 119.2401 | 105.5783 |
| reference | 1000 | fresh mutable | 122.8066 | 644.3985 |
| reference | 1000 | reused frozen | 71.5119 | 0.0043 |

The reused frozen arm shares the actual timed input by identity in every case.
Fresh equal values deduplicate to the existing snapshot, so
`sharesMeasuredInput` is false for those timed arms; they do not establish
identity sharing with each newly constructed input. Fresh results are mixed and
include substantial regressions in this run. Reused frozen values avoid payload
encoding and are consistently cheaper in this local measurement.

## Validation evidence

Focused runner validation passed 10 tests and 242 steps, including the unchanged
traversal goldens, native/legacy equality, portable cache invalidation, schema
closure retention, capture schema readdressing, and GC ownership. Focused
conversion and cloning validation passed 414 steps. All 637 documentation blocks
and repository lint passed. Full-suite and exact-head CI status belong in the
[PR validation section](https://github.com/commonfabric/labs/pull/8814), since
those runs were still in progress when these measurements completed.

A fresh served amount-ledger run passed 36 assertions and failed 3
([raw output](amount-ledger-served.log)). Previously branch-only assertions 4/5
passed; assertions 25/29/36 failed and also occur in the saved main baseline.
Subsequent assertions observe the expected state, consistent with the served
settlement barrier excluding cascade children. This does not prove all served
failures pre-existing, and is not a clean served-pattern result.
