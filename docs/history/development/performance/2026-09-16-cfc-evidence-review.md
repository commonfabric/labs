---
status: historical
created: 2026-09-16
archived: 2026-09-16
reason: "PR 7604 review verification of phase warmups and capture comparison."
---

# CFC evidence review

Review of PR 7604 checked the warmup boundary against both retained raw phase
logs. For every R/P/E/phase tuple, removing the first two observations
reproduced the corresponding `rawMs` array in
[phases.json](2026-09-16-cfc-commit-preparation-round2/phases.json). All 162
recorded medians equal the medians of those filtered arrays. The instrumenter
emits raw diagnostics; the aggregation excludes warmups before fitting.

The browser comparator was strengthened to traverse object keys in sorted order
before assigning reference numbers, and to compare the capture `label` and
`count` as well as its complete content/label/refusal payload. Reversing every
object's insertion order preserves equality. Changing either `label` or `count`
breaks equality, and an unexpected second space still fails closed.

All twelve original pairs and three cache-follow-up pairs passed this version of
the comparator. Its
[recorded results](2026-09-16-cfc-browser-comparison-review.json) include the
new canonical hashes. The earlier manifests retain the hashes of their
respective normalization versions; the
[reproduction note](2026-09-16-cfc-browser-evidence-reproduction.md) identifies
the commits needed to reproduce those earlier results. These are equivalence
checks of existing captures, not new performance measurements.
