---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Decision to permit two exact stale derived-state corrections during vintage replay."
---

# Stale derived-state correction decision

On September 14, 2026, Mike Salisbury approved permitting a narrowly scoped
correction of calculated state while preserving the vintage gate's checks on
authored data.

## Context

A synchronous schema refusal inside a lift body could leave its previous result
visible. Assigning the ordinary result-disposition closure before invoking the
body lets refusal clear the result and retains dependencies for recovery when
valid input returns. This behavior is specified in the
[lazy-materialization contract](../../features/lazy-cell-materialization.md).

The July 30 lunch-poll vintage exposed this correction as two state-loss
findings. Its Chipotle and Thai Kitchen card roots stored `artSyncState` as
`"generated"`; replay with the corrected runtime produced `""`. This field is
a computed projection of the generated-art fetch status or the option's stored
image URL. It is not the authored image URL or an explicit keep action.

The initial explanation described a missing fetch-result document. Inspection
showed that this was incomplete: the stored user-scoped result contains 70 PNG
bytes, and those bytes remain in the disposable replay's database. The absence
is in the recomputing transaction's view after cache invalidation.

An isolated card update preserved the generated status. Updating the parent
first reproduced the clearing. Instrumenting the fetch builtin confirmed that
it received an empty URL and took its explicit cache-clearing path. The
calculation then refused the absent result, and the corrected refusal path
cleared the dependent output. Preloading and continuously demanding the old
fetch result did not prevent this intentional invalidation.

The generated-art pattern disables its request for an empty prompt, a stored
image URL, or disabled generation. Its display status is a current request
projection; it is not a history of successful requests. The status correction
therefore does not require retaining the old cache as a current result.

The inspected result document was
`of:fid1:bcfuETuI_n4kYg8nAW4rNMnPvvKFv_JAMEYTZTFhuws`, under the capture
principal's user scope. Its generated-art owner was
`of:fid1:bowNjrnX6WfjrSJSKV3UC3OkTHZmjnG2JLbEEA-XdFU`. The investigation
used disposable copies, raw stored-value inspection, and temporary process
instrumentation; it made no writes to the fixture or live pieces.

## Accepted scope

The approval covers only this primary SQLite fixture, with no companion stores:

- Test: `lunch-poll/main.test.tsx`, tier `pinned`.
- Capture: `2026-07-30T21-32-46.548Z`.
- Capture identity: `vKpn8ERxJNomhrTLevYIZ5cL3qg_QKk73pMRtnPKJwM`.
- SHA-256: `6eafc9fda5e4fb3fd904ddab215dad3834f6f6fb2f8be055cab258b2306dfff0`.
- Space: `did:key:z6MkiP8m4ES1oC1PwNdjNDut2nXWP6TY2EJceCHmSdYUmoEm`.
- Pattern: `/packages/patterns/lunch-poll/poll-option-card.tsx`, default export.
- Recorded pattern identity: `iJLndA3hnQHY1W_revxrP3ENer9VYf2tIFNCOjoPV6Y`.
- Chipotle root: `of:fid1:nBd8WTpSRoVy0BNB2CKnWShQAhJJOS8pqYFHL45hI1U`.
- Thai Kitchen root: `of:fid1:qLOvr9VSkYDzl-vOQ4t0ztIxXKSIhgPVwtBcD-fihXU`.
- Field and transition: `artSyncState`, exactly `"generated"` to `""`.

The checksum binds the approval to the complete recorded input. Modifying the
fixture or adding a companion store requires fresh assessment. Fixture bytes
remain unchanged.

## Consequences

The gate may grade these two transitions as reported changes rather than losses.
It still compares every field and retains the ordinary grading for unrelated
losses, nested values, different transitions, and other fixtures. An unused
correction requires removal or reassessment; it cannot remain silently active.

This decision allows the runtime fix to proceed through validation and review.
It does not declare those checks complete, authorize changes to live pieces,
retire the lazy-materialization flag, or exempt derived values generally.

## Alternatives

- Preserve or migrate the saved status. This would require a useful meaning for
  `generated` after request invalidation, or a separate history surface.
  Keeping it as the current calculated status would retain the stale-result bug.
- Defer the runtime fix. This avoids a gate-policy addition but leaves invalid
  input capable of displaying a previous successful result.
- Exempt calculated fields broadly, remove the fixture, or strip the field from
  both sides. These would weaken detection beyond the specific correction that
  was approved.

The selected approach keeps the evidence immutable and makes its narrow
exception visible and testable. The current gate contract belongs in
[pattern update testing](../../specs/pattern-update-testing.md).
