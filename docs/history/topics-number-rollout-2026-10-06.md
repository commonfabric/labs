---
status: historical
created: 2026-10-06
archived: 2026-10-06
reason: "Record of the source push that made the Estuary Topics board's topics publish the numbers they store: a staged live rollout with rollback proven first, in place of a clone rehearsal."
---

# Publishing topic numbers on the Estuary Topics board

On 2026-10-06 every topic on the Estuary Topics board (`topics-dev-476ea34f`)
and the board itself moved to the source that publishes each topic's stored
number (#8214, with #8462's readable header). This records how it ran, what
each check showed, and what it leaves unverified.

## Starting state

The board ran the source of #7774 (`5260dfd06c`), pattern identity
`IPACbAMt…`. A survey of its `topics` collection found two topic generations,
both of which stored their numbers and published none:

| identity | topics |
| --- | --- |
| `vjPm8eQw…` | 451 |
| `HpxPMivF…` | 413, the generation `addTopic` was creating |

The namespace was dense with no duplicates or gaps, and every topic stored the
number it held for it. The target topic source, `main` at `347fbd968f`, has
identity `NqWGhxuS…`; the target board source has `uABpu95R…`. Against
#7774's `topic.tsx`, the source the `HpxPMivF…` topics ran, the target renumbers
no hoist: it keeps 33 lifts, 4 handlers and 5 patterns. The older
`vjPm8eQw…` generation's source was not compared.

The board's change is a single line of `main.tsx` beyond doc comments, the
theme background on its `cf-screen`. What it carries that matters is the
`topic.tsx` compiled into it, which is the source `addTopic` creates topics
from. The board's card already rendered a published number before the update.

## Why there was no clone rehearsal

`docs/development/space-clone-rehearsal.md` requires one here on three counts:
two generations were live, the board's members are separate pieces, and the
change adds a result field the board reads. A clone needs a snapshot taken on
the Estuary host.

The rollout ran instead as a staged live update, ruled by Mike with Gideon's
approval, on the reasoning that the board's demand for `shortName` is optional
and reads old and new topics alike, so the July failure mode — a required field
missing from old results emptying the whole array — had no path. Each stage
was a precondition for the next:

1. **One throwaway topic.** #862, filed through the deployed `addTopic` so it
   carried `HpxPMivF…`, was moved with `cf piece setsrc` and checked.
2. **Rollback, both ways.** #862 returned to its prior revision with
   `cf piece restore`, then went forward and back again through a one-row
   `cf piece retarget` plan and `cf piece rollback` from that plan.
3. **Both real generations.** #202 (`vjPm8eQw…`, 5 comments, 2 links) and
   #703 (`HpxPMivF…`, 3 comments, 2 links), both resolved, moved forward and
   back through one plan.

At every step the topic kept its title, body hash, comment and link counts,
and stored number, and published its number exactly when on the new source.
The board kept every row throughout.

## The sweep

`cf piece survey --path topics --retarget topics=…/topic.tsx` stamped one plan
of 873 topics. It was applied in batches cut from that plan, each its own
rollback plan, from a laptop rather than the Estuary host. Topics went first and
the board after them: the board's demand did not change, so the children-first
order held, where the 2026-08-28 migration inverted it because the board's
demand was what moved.

After each batch a driver compared the board's `index` before and after, and
stopped the run on a non-zero exit, `applied` or `written` short of the batch,
a transport error in the log, a row gone, a migrated topic's title changed, a
comment count fallen, or a change in published numbers other than the batch
size.

| batch | topics | wall | median | p90 | max | publishing after |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 50, 25 of each generation | 293 s | 3.2–3.8 s | 3.8–8.8 s | 27.4 s | 50 |
| 2 | 100 | 528 s | 4.0 s | 6.9 s | 15.8 s | 150 |
| 3 | 100 | 371 s | 2.8 s | 5.3 s | 10.5 s | 250 |
| 4 | 100 | 457 s | 3.1 s | 9.2 s | 15.9 s | 350 |
| 5 | 100 | 439 s | 3.2 s | 4.5 s | 45.7 s | 450 |
| 6 | 100 | 464 s | 3.5 s | 5.8 s | 21.2 s | 550 |
| 7 | 100 | 517 s | 3.9 s | 6.3 s | 17.5 s | 650 |
| 8 | 100 | 524 s | 4.2 s | 6.4 s | 12.8 s | 750 |
| 9 | 100 | 505 s | 4.1 s | 5.7 s | 13.5 s | 850 |
| 10 | 23 | 125 s | 4.2 s | 5.6 s | 14.3 s | 873 |

About seventy minutes of apply time for 873 topics. Every batch reported
`applied` and `written` equal to its size, and no batch logged a transport
error: none of the laptop failures that ended every 2026-08-28 run before it
moved to the host. A survey diffed against the full plan afterwards reported
873 moved as planned and none outstanding.

The board update applied in 233 s and logged two `sync-load-failure` lines
(`memory client closed`, `Memory websocket changed before send`); it reported
`applied: 1 · written: 1`, the board's identity read `uABpu95R…` afterwards,
and its `index` kept every row. A final pass then moved the ten topics filed
on the old board during the sweep, in 81 s. The closing survey found 883
topics on `NqWGhxuS…`, the board on `uABpu95R…`, and no other generation. A
topic filed afterwards, #885, was created on `NqWGhxuS…` publishing its
number.

## What the checks showed

**A title changed on a topic the sweep did not touch.** The driver stopped
after batch 3 because an agent added `[RESOLVED]` to a topic during the batch.
The check was narrowed to title changes on topics the batch migrated, and
other renames were counted and reported thereafter; one more occurred, in
batch 5.

**Comment counts rose and none fell.** 218 counts went up across the ten
batches. `commentCount` is derived and materializes only when a topic runs,
and the update runs each topic, so a count stale since the topic last ran
refreshes. All 15 increases in batches 1 and 2 were checked individually
against the topic's stored comments and matched them; the later increases
were not checked one by one.

**A plan holding rows already on target writes nothing to them.** The final
pass's plan carried all 883 topics, 873 of them already moved; the apply wrote
the ten that were not.

## What it leaves unverified

The checks compared the board's `index` — titles, comment counts, published
numbers, row membership — and individual topics' bodies, comments and links
on the samples above. No pass compared every topic's computed results before
and after, which a clone would have allowed without touching production.

#7806, which renumbers a lift in `topic.tsx`, was held out of this push
because the plan's rule that no stored hoist name may resolve to a different
body has no stored-data check yet. Its update is a second, smaller push of the
same shape.

#862 and #885 remain on the board, titled `[OBSOLETE]`; a topic has no
retraction verb.
