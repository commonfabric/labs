---
status: historical
created: 2026-08-04
archived: 2026-08-04
reason: "Record of the rehearsal and live source update that moved the Estuary lunch poll onto the mainline pattern."
---

# Migrating the Estuary lunch poll onto the mainline source

Record of a `setsrc` against a populated production space, rehearsed on a clone
first. The live counterpart is
[`packages/patterns/lunch-poll/DEPLOY-AND-SHARE.md`](../../../../../patterns/apps/lunch-poll/DEPLOY-AND-SHARE.md).

## What was changed

The Estuary lunch poll ran a source lineage that existed in no commit on any
branch. It carried a restaurant-hours feature — a `restaurant-availability.ts`
module plus `checkRestaurantHours`, `availabilityRefresh`,
`availabilityLastRequestedAt` and `restaurantSearchContext` inputs — and lacked
`participantProfiles`. The authored source survived only inside the deployed
piece, from which it was recovered before the update.

The update replaced that source with `packages/patterns/lunch-poll/main.tsx` at
commit `c97de0181555adf7351cc78b339263792e1221fd`, the commit Estuary itself
runs, confirmed from its `/api/meta`. Dropping the restaurant-hours feature was
the accepted cost.

- Piece: `fid1:S2MlU76VbKBRTtFt_hgPyi9MB04ti9yKN08G2IJJUW4` in space `team-lunch`
- Space DID: `did:key:z6MkhAKxuP8cXuDNjyUJ2xgmjjgENQGm7zzo5Tg3V7vyYnzr`
- Source ref before: `cf:pattern:6L3o4uBafChxKHyi5OSt-nbQoN3FIRmw_YVK1dVkhwk`
- Source ref after: `cf:pattern:dTg2Hp4JCJbEGWO_2KVmrN_GKww7RG2FEzrQ6nvMopo`

## Why a rehearsal was required

The compatibility checker rejected the transition, naming two removals:

```
Pattern schemas are not backward compatible:
- argument.availabilityLastRequestedAt: existing argument field was removed
- result.applyRestaurantSearchContext: existing result field was removed
```

A rejected compatibility check on a populated space is one of the conditions
that makes a rehearsal mandatory. The update went through with
`--dangerously-allow-incompatible-schema`.

Getting the snapshot took a person with host access. Estuary's whole-space dump
endpoint is off, so the snapshot came from `VACUUM INTO` run on the host against
the live store.

## Rehearsal result

Two passes against a clone, resetting the clone between them, produced identical
outcomes: 150270 → 150656 commits, 153163 → 154179 revisions, 708 entities
added, one removed, two changed.

The removed entity was `stream of:fid1:6p8kfS4w8LxrVjaXTg9BUaTPDHwNFQ03I9mOpzevTME`,
the handler behind the "Enable daily checks" button — the restaurant-hours
feature being dropped. `cf space verify --expect-migration` exits non-zero on any
removal, so the gate fired on both passes and the removal had to be identified
before the run could be judged.

The two changed entities were the piece and one owned cell. No free cell
changed, so no authored content was overwritten. Write churn peaked at 275
commits per minute and returned to zero within two minutes on both passes.

## What the poll kept and lost

Kept: five options, ten participants, forty votes, no visits, the question and
the host name, all byte-identical to the pre-update values.

Lost: the `joinedAt` timestamp on all ten participant records. The mainline
`User` type does not declare that field. Rolling the source back restores the
restaurant-hours feature but not those timestamps, since nothing rewrites a
field the forward migration dropped.

Production matched the rehearsal's prediction field for field.

## A CLI limitation found on the way

`cf piece set --input` cannot write any field of this pattern on this build. It
fails with `updated input does not match its schema: myName: value does not
match type string`, whether or not the calling identity has joined, and
including on a write to `myName` itself. The read path materializes `myName` as
`""`. This closes the documented Option B state-copy loop for this pattern;
seeding through the pattern's own handlers still works.
