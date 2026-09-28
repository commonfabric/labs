---
status: historical
created: 2026-09-28
archived: 2026-09-28
reason: "Clarifies the completion-only equality claim and canceled-work counts in the original measurements."
---

# Completion equality and canceled work

This corrects the scope of the “Every baseline/candidate pair” sentence in the
[original report](README.md#output-and-work-preservation), following review of
PR #8187. The repository preserves historical report content, so the correction
is recorded here rather than rewriting the original.

Every **successful completion** comparison, including the synchronous samples
excluded from timing summaries, had identical complete-map hashes, serialized
byte counts, entry counts and derivation counts for its case, depth, width and
staging order. This covers 320 records across the cooperative and synchronous
completion processes. Staging orders also agreed within each case.

The remaining 20 records are canceled runs. They have no complete-map hashes,
serialized byte counts or entry counts, and no claim of output-map equality
applies to them. Every canceled run returned `StorageTransactionAborted` and
left the holder absent from storage. Because cancellation intentionally stops
at different points, the two arms' derivation counts are not equal.

The counts below come from `stats.stagedReferenceDerivations` in
[samples.jsonl](samples.jsonl), listed in process-pair order (0 through 4).

| Depth | Baseline derivations before abort | Candidate derivations before abort |
| --- | --- | --- |
| 12 | 71, 71, 25, 71, 71 | 23, 21, 23, 22, 23 |
| 14 | 83, 29, 29, 29, 29 | 25, 25, 25, 25, 25 |

The candidate stops earlier in each matched cancellation sample. These counts
are not a fixed cancellation budget: the timer and cooperative yields are
scheduled by the event loop, and the machine was heavily contended. This
clarification changes neither the measurements nor the original timing limits.
