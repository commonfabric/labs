---
status: historical
created: 2026-11-17
archived: 2026-11-17
reason: "Why the memory server's walks during a FabriChat send still did twice the work they did before labs #9155 once records were attributed, and how sharing one memo between records brought them back to it"
---

# A FabriChat send and the memo shared between records, November 2026

## What remained

Attributing what a walk reaches to the record (one document under one
selector) whose walk reached it took the FabriChat send benchmark most of the
way back after labs #9155
([the earlier record](2026-11-12-fabrichat-send-record-attribution.md)). The
memory server's re-walks of changed documents still did about twice the work
they did before #9155, and the browser added and removed more watches per
send.

## Method

The send benchmark ran against compiled toolshed binaries, as before, with a
build of each that wrote one line per refresh: the dirty documents, each
document walked again with its selector, the time and the walk counters of
each, and each watch the browser added or removed. The machine was shared
with many other sessions, with load averages between 20 and 106, so one
build's mean send time varied twofold between rounds, and the time its
server spent walking changed documents again fourfold. The findings below
rest on the counters, which the load does not change.

## Findings

Per send, the walks of the earlier change did 11,647 schema traversals with
228 memo hits, where the build before #9155 did 5,692 with 1,797. One
document accounted for most of the difference: the room's rendered list of
message rows, which the browser watches under four view-node schemas. Each of
the four walks of it did about 1,800 schema traversals; before #9155 the
first did about 900 and two of the others about ten, answered from the memo
the first had filled.

The memo was keyed by record, so that a record walking a position another
record of the document had walked would still attribute what it reached. A
record is named by the selector its link was entered with, and the four
schemas' links differ while agreeing on the positions inside the row
documents, so no walk reused another's work, and a walk under a union reused
none of its own across branches.

The extra watch traffic is not retraction. During a send the server retracted
nothing. The extra additions were watches on the `receipt:` documents event
handlings write (labs #9556, later than #9155) and documents watched twice;
the removals were the browser's own release passes. Measured across #9155
alone, watch additions and frames per send did not change (reported in topic
2872).

## The change

The memo is keyed by position and schema again, and by scope instance where a
visit names one. A memoized position keeps the range of its record's
attribution list that its traversal added. A memo hit for another record
replays that range to the record walking the position now, following the
memoized positions the range names, each once, and is refused, so the
position is traversed, when a record it names has left the tracker. A hit
for the same record in the same visit replays nothing.

Review found the cases where a range does not stand for everything a fresh
traversal of the position would attribute, and each became a test: a hit
inside the position, which the range now names; a link back into the same
document; a record reaching itself; attributions made while resolving a link
through to its target, before any position of the document began; and a
traversal the cycle tracker cut short at a document already in progress
outside the position. The last two keep their result in the memo but are
replayed only for the record that memoized them, in the same visit, and a
position enclosing such a hit is kept from other records in turn; the cycle
tracker records the lowest cut within each position's span in constant time.

## Measurements

Per send, from the traced runs:

| Build                       | Schema traversals | Memo hits |
| --------------------------- | ----------------- | --------- |
| Before #9155                | 5,692             | 1,797     |
| Record attribution (#9784)  | 11,647            | 228       |
| The change                  | 5,787             | 1,484     |

Re-walking a 16-level tree under a recursive union whose branches share a
subtree took 917,497 schema traversals with record attribution alone, since
each re-walk bypassed the memo for its own document, and takes 119 with the
change.

No wall-time comparison was reliable while the record was written: three
interleaved rounds under load gave mean send times of 788 ms before #9155,
1,410 ms with record attribution and 1,269 ms with the change, with rounds of
one build ranging from 530 ms to 1,100 ms. Whether the send is faster than it
was before #9155 needs a run on a quiet machine.

## Left for other work

A walk over several roots sharing one tracker gives about 1% of roots in
random small graphs less reach than each has alone, both before and after the
change; one such case is a link whose target's record is entered inside a
cycle the tracker then cuts. A link whose path runs through a primitive value
attributes nothing, so its target is never watched. Walking an explicitly
named scope instance records the root under the session's own instance as
well, which leaves the session's own instance unwalked when it comes after
under one selector.
