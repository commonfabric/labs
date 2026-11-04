---
status: historical
created: 2026-10-11
archived: 2026-10-11
reason: "Record of the deliberate contract break taken when labs#8713 (binding a Loom root to one meeting occurrence) was reverted together with labs#8715, which removes the `bindMeeting` result field from the Loom root's contract recorded at 20261011T182304Z."
---

# Loom: reverting the root's meeting binding

labs#8713 gave the Loom root (`packages/patterns/loom/main.tsx`) a
`bindMeeting` result field, binding a root to one meeting occurrence, and its
contract was recorded as baseline `20261011T182304Z-qsqQOWTGzU00g8hJ`. It
landed on top of labs#8715, which changed how stored CFC envelopes merge
(`packages/runner/src/cfc/schema-merge.ts`). On main that change let writes
commit that stored writer claims must refuse, in
`cfc-stored-write-requirements.test.ts` and `cfc-writer-claim-marker.test.ts`.
Both pull requests were reverted together, newest first, to restore that
enforcement.

## What the gate reports

Against baseline `20261011T182304Z-qsqQOWTGzU00g8hJ`, the pattern-update proof
reports `result.bindMeeting: existing result field was removed` for
`loom/main.tsx`. No change to the reverted pattern satisfies it short of
keeping the field, and the field is the surface the revert takes out.

## What is accepted

A Loom root whose piece was stamped with that contract no longer has
`bindMeeting` once it rolls forward. The baseline stays, as
`check-baselines-append-only` requires: it records a contract that was
deployed, and the entry in `tasks/pattern-compat-accepted-breaks.ts` forgives
that one baseline at that one path. The binding is expected to return when
labs#8713 and labs#8715 re-land with the merge fixed, recorded as a new
baseline then.
