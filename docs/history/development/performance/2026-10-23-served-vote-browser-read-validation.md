---
status: historical
created: 2026-10-23
archived: 2026-10-23
reason: "One rendered lunch vote at 296 votes, with view-scoped replication on, after two changes to the browser's local read validation: a basis check answered from the deep-frozen document it last observed (validation 3.5 to 2.3 s over eight votes), and a commit's own validations standing on the scheduler's pre-commit pass (2.6 to 1.1 s, a vote 1,216 to 1,027 ms); two levers that did not pay, a covered-link skip in the memory server's walk and a fixed long flush deadline; and the Topics off arm's board found bimodal across runs on every tree."
---

# The browser's repeated read validations

The [plan and selection record](2026-10-23-served-vote-plan-and-selection.md)
left one rendered lunch vote at 296 votes about 1.1 s with view-scoped
replication on, against about 0.7 s with the serving loop off. Its critical
path was the browser's runtime worker, busy about a second a vote, most of it
re-proving producers at each committing run's read validation. This round
took two passes at those proofs, tried two levers elsewhere, and measured the
Topics navigation benchmark's off arm again.

## How it was measured

The arms are the earlier records'. `flag` is the serving loop in the worker
with the store read-through on, the overlap off, the flush deadline growing
to a 1000 ms cap, and `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION` on. `off` is
the loop off. Every run used a toolshed and shell built from source in a
scratch worktree, on a four-core container.

The probe is `probe-read-scale.ts`, kept out of the tree as before: the
read-scale fixture at 296 votes, one warmed viewer, eight timed votes. Its CPU
runs profile the browser's runtime worker, the toolshed's main thread and the
serving worker over the same eight votes. The container's speed drifts over
an hour by more than these changes move a vote, so each comparison here
alternates its arms, and only arms from one series are compared.

## A basis check over the version it last observed

A producer's proof matches every entry of its basis against the replica.
`ViewInputBasisCache.matches` observed each entry's path reachability and
value again on every check, though a basis value last observed in a
deep-frozen document version can observe nothing different there, and the
replica hands back one such object per version. The check now answers from
the earlier observation when the document is that same object.

| Over eight votes | Before | After |
| --- | ---: | ---: |
| `validateLocalReadBasis`, inclusive | 3,538 ms | 2,266 ms |
| `observeViewInput`, self | 774 ms | 46 ms |
| Timed votes, three alternating pairs | 1,220 ms | 1,176 ms |

`isDeepFrozen` on the documents costs about 22 ms over the eight votes: the
replica's documents are frozen once, and the memo answers every later check.

## One validation for a commit

A committed run validated its transaction's local read basis five times back
to back, each pass with a fresh producer checker:

1. the scheduler, just before committing;
2. the extended transaction's commit, before preparing it;
3. the same, after preparing it;
4. the storage transaction's own commit;
5. the scheduler again, once the commit was kicked off.

Nothing between the first four changes what they check. The scheduler now
validates through `validateLocalReadBasisForCommit`, and the commit's own
validations in the same synchronous stretch stand on that pass while the
transaction reads and requires nothing new. The stretch ends at the next
microtask checkpoint, and when the transaction hands its writes to the replica
or a seal sink, so the fifth pass still checks again.

A first version let any validation stand on any earlier passing one in its
stretch. `view-server-currency.test.ts` refused it: a producer the scheduler
unsubscribes synchronously, inside an open reader transaction, must fail the
reader's next validation, and it did not. Only the commit's own passes stand
on a pass now; every other validation checks afresh.

| Over eight votes, with the basis check above in both arms | Before | After |
| --- | ---: | ---: |
| Every validation pass, inclusive | 2,551 ms | 1,066 ms |
| The producer check, inclusive | 2,457 ms | 1,286 ms |
| Timed votes, two alternating pairs | 1,216 ms | 1,027 ms |

The medians of those pairs are 1,152 and 1,006 ms. The first version, which
let every validation stand, measured about the same over three pairs, 1,346
against 1,116 ms.

## Two levers that did not pay

**A covered-link skip in the memory server's walk.** The walk skips a link
whose target the schema tracker already covers, but only for a link that
declares a scope. Extending the skip to unscoped links in a storage walk read
flat on the chat burst and on the Topics flag arm. On the off arm the board
read 4.0 s with it, against 3.6 s without. It was reverted.

**A fixed 1000 ms flush deadline.** A vote's settle is cut into two waves by
the deadline that grows from 100 ms. A fixed 1000 ms deadline gives one wave a
vote, and the vote read 1,275 ms against 1,040 ms over two pairs. The cut wave
ships the handler's write a wave early, and the browser starts on it then.

## The Topics off arm runs in two modes

The navigation benchmark's off arm reads its board segment in one of two
modes, on every tree tried, and stays in one for a whole run:

| Run | Tree | Board | Journey |
| --- | --- | ---: | ---: |
| 01:01 | `b21ced957` | 1.7 s | 4.6 s |
| 03:28 | scratch tree | 4.0 s | 6.4 s |
| 03:34 | scratch tree | 3.6 s | 6.1 s |
| 03:50 | `3d19505d1` | 1.9 s | 5.0 s |
| 03:57 | `b21ced957` | 3.9 s | 6.9 s |

The flag arm read board 2.6 to 2.7 s and journey 4.9 to 5.2 s in all three of
its runs. So the flag arm beats the off arm's slow mode, and ties or loses to
its fast mode. The [three-realm record](2026-10-23-one-served-vote-across-three-realms.md)
compared the flag arm with a fast-mode run.

## Adopting a node again as its run begins

A view node that ran locally is never adopted again: every later change to
its inputs runs it, and the browser ran 78.5 actions a vote against 54 with
the loop off. A probe-only counter, set where a view node's run begins, asked
the server's proof each time whether it already held, which is what adopting
the node again instead of running it would need. Of 24.5 view-node runs a
vote, one began under a proof that held. The other 23.5 began as soon as a
frame changed their inputs, ahead of the frame carrying the server's output
and basis for them. Adopting a node again at that point would save one run a
vote, so it was not built.

## What remains

- **A lost chat message comes first.** In about one chat room in a dozen,
  with the serving loop on, the creator's first message was lost. It
  outranks every lever here and has a record of its own
  ([lost-join record](2026-10-23-served-chat-lost-first-join.md)).
- **The browser still runs more a vote with the flag on.** After both
  changes above a rendered vote read 1,027 ms, and the browser ran 78.5
  actions a vote against 54 with the loop off. Adopting view nodes again
  would save one of those runs a vote.
