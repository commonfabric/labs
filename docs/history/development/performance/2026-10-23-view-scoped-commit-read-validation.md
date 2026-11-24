---
status: historical
created: 2026-10-23
archived: 2026-10-23
reason: "Why a view-scoped web client observes nothing again for a basis check over the deep-frozen document it last observed, why a commit's own read validations stand on the scheduler's pre-commit pass for one synchronous stretch, and why that stretch ends when a replica applies a frame: over eight rendered lunch votes at 296 votes, local read validation went from 3,538 to 2,266 ms and then every validation pass from 2,551 to 1,066 ms, a vote from 1,216 to 1,027 ms. Measured on the served-vote branch (#9122) before the changes were split out to land on their own."
---

# A committing run's local reads, validated once

These three changes were made and measured on the served-vote branch
(commonfabric/labs#9122), and split out of it to land on their own, after the
[shared read check](2026-10-23-view-scoped-shared-read-check.md) they build
on. The code is the same on both.

## How it was measured

On #9122's branch, on the arm the
[proof pass's record](2026-10-23-view-scoped-proof-pass-per-wake.md)
describes: the serving loop in a worker, the store read-through on, the overlap
off, the flush deadline growing to a 1000 ms cap, and
`EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION` on. A probe kept out of the tree
seeded the lunch poll's read-scale fixture at 296 votes, warmed one viewer, and
timed eight votes. Its CPU runs profiled the browser's runtime worker over the
same eight votes.

The container's speed drifts over an hour by more than these changes move a
vote, so each comparison alternated its arms, and only arms from one series
are compared.

## A basis check over the version it last observed

`fe2801178`, against `3d19505d1`. A producer's proof matches every entry of its
basis against the replica. `ViewInputBasisCache.matches` observed each entry's
path reachability and value again on every check, though a basis value last
observed in a deep-frozen document version can observe nothing different
there, and the replica hands back one such object per version. The check now
returns the earlier observation's result when the document is that same
object.

| Over eight votes | Before | After |
| --- | ---: | ---: |
| `validateLocalReadBasis`, inclusive | 3,538 ms | 2,266 ms |
| `observeViewInput`, self | 774 ms | 46 ms |
| Timed votes, three alternating pairs | 1,220 ms | 1,176 ms |

`isDeepFrozen` on the documents costs about 22 ms over the eight votes: the
replica's documents are frozen once, and the memo serves every later check.

## One validation for a commit

`271086444`, against `fe2801178`. A committed run validated its transaction's
local read basis five times back to back, each pass with a fresh producer
checker:

1. the scheduler, just before committing;
2. the extended transaction's commit, before preparing it;
3. the same, after preparing it;
4. the storage transaction's own commit;
5. the scheduler again, once the commit was kicked off.

Nothing between the first two changes what they check, and nothing between
them and the fourth does unless preparing the commit reads more, as its CFC
check reads the stored metadata of a document it writes. The scheduler now
validates through `validateLocalReadBasisForCommit`, and the commit's own
validations in the same synchronous stretch stand on that pass while the
transaction reads and requires nothing new; a validation after such a read
checks afresh. The stretch ends at the next microtask checkpoint, and when the
transaction hands its writes to the replica or a seal sink, so the fifth pass
still checks again. Every other validation
checks afresh: the scheduler can unsubscribe a producer synchronously, and a
reader validated after that must see it, which `view-server-currency.test.ts`
holds.

| Over eight votes, with the basis check above in both arms | Before | After |
| --- | ---: | ---: |
| Every validation pass, inclusive | 2,551 ms | 1,066 ms |
| The producer check, inclusive | 2,457 ms | 1,286 ms |
| Timed votes, two alternating pairs | 1,216 ms | 1,027 ms |

The medians of those pairs are 1,152 and 1,006 ms. The producer check is made
at a transaction's first read as well as in every validation pass, so it can
take longer than the passes do.

## The stretch ends at a frame

`56bab27a9`. A frame the replica applies can change what the pre-commit pass
proved, so the stretch also ends once a frame is applied. Client session frames,
the store read-through's feed and the plans a session delivers arrive through
that one application; the empty plans a replica publishes when its session is
replaced or loses a capability arrive in an event of their own, after the
stretch has ended. In `local-read-policy.test.ts` a frame lands between a
passing pre-commit validation and the next one, and the second fails; without
the end at the frame it stood on the first. The change ends the stretch earlier
and was not measured on its own.

## After review

Three changes came after the measurements above, and each only makes a
validation check again in a case the measured votes did not reach.

- A pre-commit pass that applies a frame itself, as a store read-through can on
  a replica miss, ends the stretch it began in. The pass now records the
  stretch it began in, and leaves nothing to stand on when that one has ended.
- The scheduler ends the stretch once its commit call returns. A commit that
  handed nothing over, refused before storage, leaves the stretch open, and
  its commit callbacks can have changed what the pre-commit pass proved, so the
  fifth pass now checks again whatever the commit did.
- The stretch also ends where the scheduler state a producer's currency rests
  on changes: when an action begins a run, which revokes its adoption, and when
  the node registry removes a node or sets one to anything but clean. None of
  these happens inside a commit, so the argument above already kept them out of
  a stretch; the ends put that where the state changes.

`local-read-policy.test.ts` holds the first two and the hand-off's own end, each
with a case that fails without it, and the third through a producer the
registry removes, whose case fails without the end at a removal.
