---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Measurement snapshot; the mechanisms it found are described live in docs/features/keyed-collection-writes.md."
---

# What a keyed collection write costs under concurrency

Measurements taken on 2026-09-01 against `lunch-poll-keyed-votes` and
throwaway fixtures beside it, all in
`packages/patterns/integration/multi-runtime-harness.ts` with three sessions
against the in-process storage server, on one developer machine. "Refused"
counts commits the server rejected, read back through
`MultiRuntimeSession.rejections()`; "rolled back" counts the `storage.v2`
`commit-revert` log, which covers much the same population but is logged only
for a refused commit that had semantic operations and a subscriber to notify.
Every figure is from one machine, so the counts are worth reading for their
shape rather than their value.

The two lunch-poll rows measure `castVote` as it stood that day, before
"a recast writes its own vote and nothing else" (#6820) took `addUnique` off
the recast path. A recast there still ran the scan; one today does not, so
those two rows describe a handler the poll no longer has. The rows above them
are throwaway fixtures carrying their own handlers and are unaffected.

## What was measured

Each burst is three sessions writing four keys apiece, three rounds, every
round fired at once with `idle: false`. Every session warms each of its keys
first, so no measurement includes a first write to a document a session has
never held.

| Burst | Refused |
| --- | --- |
| keyed upsert of members that are already present | 0 |
| keyed upsert where every round adds a new member | 0 |
| the same, collection passed down into a sub-pattern | 0 |
| the same, handler also deep-reads a sibling collection | 0 |
| `removeByValue` with no clear of the removed entity | 0 |
| `removeByValue` paired with `set(undefined)` on the entity | 12 |
| keyed upsert plus one `computed` over the whole collection | ~150 |
| one session removing while two upsert members already present | 13–18 over three runs, all of them the upserting sessions |
| lunch poll votes, recasts only | 0 over twenty runs |
| lunch poll votes, opening with a toggle-off of all twelve | 16–27, thirteen runs |

In the one-removing-two-upserting row, the removing session was never itself
refused, and every root conflict named the collection's own document.

## Which read each disturbance trips

A later run crossed the two victim shapes against the four things another
session can do to a collection. Three sessions, four keys apiece, four rounds;
two of them write their own records every round while the third does the
disturbing. The collection is populated first, which matters: a warm-up of bare
keyed writes never adds anything to the array, and a `removeByValue` against an
empty array writes nothing and refuses nobody.

| Victim writes | nothing | adds a member | removes one | clears one member's value | removes and clears |
| --- | --- | --- | --- | --- | --- |
| one record, by key | 0 | 8 | 8 | 0 | 8 |
| the same, plus `addUnique` | 0 | 17 | 16 | 17 | 17 |

The first row is the collection's own link, held by `elementById`: membership
changing in either direction trips it, and replacing a member's value does not.
The second row adds the scan's per-element link reads, which a member's value
being replaced does trip. A victim that scans pays both, at roughly twice the
cost.

## Two fixes for row one that measure nothing

Run on 2026-09-02 by the session that had been deflaking the same burst, on
its own three-arm scenario (three voters, four rounds, two of them recasting
concurrently while the third does nothing, adds a vote, or removes one). Its
baseline arms read 5, 15 and 33.

**Recording the link probe as a shallow read.** `commitReadActivities` already
excludes reference-resolution shape reads, but only when `nonRecursive` is
true, so the probe was recorded that way. The arms came back 5, 15 and 31:
nothing. The geometry is why. The probe sits BENEATH the array — the array's
path plus the probe's sub-path — while a membership write patches AT the
array's path, an ancestor. Shape-only granularity fires at or above the read's
path by design, so a shallow probe is not spared a write to its own parent.

**Comparing `addUnique` and `removeByValue` candidates structurally** instead
of dereferencing each element, which matches how the server dedups `add-unique`
by stored value. Also nothing, on any arm, and reverted. That is consistent
with the crossed table above: what a keyed write carries is the resolution's
probe, not the comparison's dereferences, and the scan's own reads reach only
handlers that scan.

So a fix has to say something the conflict evaluation cannot say today: a
mergeable membership write to an array does not change whether THAT ARRAY's
own slot holds a link, so it must not invalidate a `followRef` probe there.
That is the observation-class distinction the CFC spec already draws, applied
to commit-time conflict rather than to flow labels, and it is protocol-level
rather than a change at the cell or exclusion layer. Anyone picking this up
starts at the conflict evaluation; the two layers above it are measured and
recorded here so they are not tried twice.

What neither session established is whether the conflict set's strong read is
load-bearing somewhere, and it should be established before it is narrowed.
The other two consumers each have a stated reason for the strength they use;
this one may be an unexamined default, or it may be holding something up that
nobody wrote down. One concrete way it could be load-bearing: `removeByValue`
writes the filtered array, so an element after the removed one changes index,
and a resolution that followed an INDEXED slot has an address that genuinely
depended on the collection's content. `packages/patterns/lunch-poll/main.tsx`
warns about that shape in its own terms — a `list.key(i)` handle follows the
slot and retargets when an earlier element is removed. No call site that
resolves through an indexed slot and then writes to the result was looked for
here, so whether this is reachable is open. It is the reason the narrowing has
to be by path rather than by observation class alone.

## What the numbers say

A keyed edit that changes no membership is free. Two separate mechanisms make
one that does change membership cost something, and each row above exercises
one of them.

**Clearing an element's document.** `addUnique` and `removeByValue` match
candidates with `areLinksSame`, resolving each element's link, and resolving one
reads that element's document at its link path. A write inside an element sits
below that path and does not disturb the read; `set(undefined)` on the element
sits at it and does. Read back through `rejections()`, all twenty and all
sixteen refused commits of two toggling vote bursts had written the vote list,
none of them held the list in its read set, and every one was refused over
another vote's document at exactly that link address. So the cost of a burst
that changes membership is those changes refusing one another over records none
of them was removing. Removals with no clear, in the same arrangement, cost
nothing.

**The array read a no-op `addUnique` leaves behind.** `Cell.addUnique`
(`packages/runner/src/cell.ts`) reads the array, finds its candidate already
present, and returns before `recordMergeableOp`. The read exclusion in
`commitReadActivities` (`packages/runner/src/storage/v2.ts`) drops a read only
for an entity with a recorded mergeable operation, so that read stays. A probe
with one session removing while two upserted present members refused only the
upserting sessions, and the collection document was in their read sets at its
bare value path.

None of these bursts exercises the second: their rounds are homogeneous with a
settle between them, so a present-member upsert is never in flight beside a
membership change. Only the probe with one session removing while two upsert
does that.

Roughly half the refusals in some runs carry "pending dependency rejected"
rather than a stale read: commits dropped because one they stacked on locally
was dropped. One root conflict can cost several rolled-back writes, so a
rollback count overstates contention on its own. Two other kinds appear,
"stale pending read" and "pending dependency dropped locally".

## What the numbers do not say

No refused commit in any of these runs wrote a derived document. That is not
the same as no derivation committing: the marker fires on refusal, so a
derivation that recomputed and committed cleanly leaves nothing here to count.

Nor is the fixture the reason. `lunch-poll-keyed-votes` exposes `voteCount`
and its siblings, which derive from the collections they count, so a burst that
changes one and a test that reads it between rounds can demand a derivation and
make it commit. What the fixture does not expose is the poll's `[UI]`, so
`todaysVotes` and the per-option swatches stay dark whatever the burst does.

What a memoized derivation over a collection costs was measured only in the
throwaway fixture, where adding a single `computed` over the list took a burst
from zero refusals to roughly 150 — all of them on the derivation's own
commit, which writes only its memoized result. Nothing in continuous
integration measures that on the poll.

The claim that a reader's work and a writer's work are never the same commit
rests on the runner opening one transaction per event dispatch
(`packages/runner/src/scheduler/events.ts`) and another per reactive run
(`packages/runner/src/scheduler/run.ts`). Commits do batch several dispatches:
rejected commits in the toggling vote bursts carried two `castVote` runs each.
The observation that no refused commit wrote a derived document is direct; the
generalization from it is not.
