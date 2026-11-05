---
status: historical
created: 2026-09-16
archived: 2026-09-16
reason: "Review of merged scoped conflict recovery and disposition of the broader repair proposal."
---

# Scoped conflict recovery review

The review compared merged [PR #7217][merged] with the inactive server repair
implementation in [PR #7202][draft]. The baseline was
`029610988aececdc0b7140ab6b23e876511806fb`; the focused follow-up started from
`eb3cf87db`. This is a record of that assessment, not a description of future
runtime behavior.

## Findings and chosen follow-up

The scoped conflict array preserved every stale document instance through the
memory protocol and runner normalization. The runtime helper waited for ordered
catch-up, then pulled those instances in their scopes. This was sufficient for
the reduced output-restoration operation when the helper was called.

The reactive scheduler still called the rejection's `readyToRetry()` directly.
That gate advanced the watched view but did not load a hidden user output. A
fresh runtime with a durable user output and a space output pointing elsewhere
repeatedly rejected the `sendValueToBinding()` operation that restored the scoped
output. The runtime-helper control succeeded. A diagnostic change that called
the helper from reactive recovery made the scheduler converge. The reduced
reproduction failed with server execution configured off and on; the full
lunch-poll browser revision sequence was not rerun in this review.

The chosen follow-up reused the helper and preserved the scheduler's ability to
run on fresh input changes while another commit recovered. Its delayed retry
needed to remain on the pending-commit barrier and check registration identity
and write teardown before requeueing. An independently queued run could precede
repair completion, so an exact total action count was not a valid convergence
assertion. The stored result and eventual settlement were the relevant outcomes.

## Disposition of the larger design

The [design at the final reviewed draft commit][design] and its
[implementation][implementation] remain available through immutable Git
references. They proposed a stronger contract: transaction-owned repair coverage,
complete receipts, explicit release,
and reconstruction after reconnect. The staged server component was inactive;
client ownership and receipt validation had not been completed.

The review recommended retaining scoped conflict pulls as the correctness fix
and retiring the larger implementation after the focused follow-up lands.
Reloading every dependency in one server snapshot was not necessary for safety:
the retry rebuilt its transaction, and the server validated that transaction's
reads at commit. A newly reached stale dependency could legitimately require
another conflict and repair.

The useful remaining architectural question was repair lifetime. Ordinary
`sync()` retained graph watches, and graph roots could contribute server execution
demand. The review established those code paths, but did not measure their
production cost. It recommended measuring retained repair roots, delivery bytes,
and induced execution after completed or canceled operations before choosing a
new ownership protocol. Open [PR #7068][other] also proposed persistent
conflict-root watches, so further work needed to account for that overlap.

## Regression requirements retained

- A hidden scoped output already equal to the desired `null` still repairs and
  restores its redirect. A different previous value also converges; a genuinely
  new output needs no conflict recovery.
- Reads ignored for scheduling remain validation dependencies. Repair must not
  turn an output's previous-value read into a computation trigger.
- Recovery reaches the scoped pull after catch-up, and the pending-commit barrier
  remains open through both phases.
- Completion after removal, re-registration, or storage teardown cannot revive
  the old operation. Fresh work in a new registration remains independent.
- Further lifetime work should test shared repair ownership, cancellation,
  reconnect and identity replacement, watch replacement, and cleanup without
  extra execution demand. The draft's receipt-specific tests are relevant only
  if that protocol is pursued.

[merged]: https://github.com/commontoolsinc/labs/pull/7217
[draft]: https://github.com/commontoolsinc/labs/pull/7202
[design]: https://github.com/commontoolsinc/labs/blob/5603bf4b0ff329672c5a49b96181d5392183236a/docs/plans/transaction-conflict-repair.md
[implementation]: https://github.com/commontoolsinc/labs/tree/5603bf4b0ff329672c5a49b96181d5392183236a
[other]: https://github.com/commontoolsinc/labs/pull/7068
