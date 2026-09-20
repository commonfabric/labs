# CFC write-destination reads

Contextual Flow Control is the label system this runtime enforces on reads and
writes. Its per-transaction flow join is conservative: every label the
transaction consumed is carried forward onto everything the transaction wrote.
Spec §18.6.2 ("Read Exclusions (Runtime-Internal Reads)") is where that "every
label the transaction consumed" is narrowed, by listing the reads the runtime
makes for its own purposes rather than on a program's behalf.

This document covers one such class: the reads the write machinery makes of
the region it is about to write. It says what the class is, where the runtime
marks it, why excluding it does not let a label escape, and what it costs.

The spec-side amendment this class needs is SC-41 in
[`cfc-spec-changes.md`](./cfc-spec-changes.md).

What this unblocks is a whole-object write whose value the program did not
read out of the destination. A read-modify-write spelled
`cell.set({ ...cell.get(), secret: x })` reads the sibling, so §8.9.2's
conservative join covers it and the write is refused as before. Narrowing
that case is a per-write question, which SC-23 left transaction-global.

## The class

Two reads on the way to one `Cell.set()` carry `writeDestinationRead`
([`reactivity-log.ts`](../../packages/runner/src/storage/reactivity-log.ts)),
and `deriveFlowJoin()` in
[`prepare.ts`](../../packages/runner/src/cfc/prepare.ts) drops a read
carrying it. The read walk the join is built from, `forEachFlowObservation()`,
still visits it and classifies it, which is what leaves every other consumer
of that walk alone — the next section but two.

**The type probe.** `CellImpl.set()` asks whether the cell holds a stream
before choosing between delivering the value as an event and storing it. The
stream marker is a scalar at one known key of the stored value, named by
`STREAM_MARKER_KEY` in
[`builder/types.ts`](../../packages/runner/src/builder/types.ts), and
`CellImpl.isStream()` reads that key's own path. Reading the marker's path
rather than the whole resolved value is the narrower question and is worth
asking that way on its own; it is not what earns the exclusion, because a
label a document declares at its root resolves at the marker's path too. What
earns it is that on the write path the probe is the write machinery choosing
which of two ways to write. `isStream()` takes the read's metadata from its
caller, so `set()` passes the marker and `sink()` does not: the same probe
made to decide whether to add a listener is an ordinary observation and joins.

**The destination comparison.** `normalizeAndDiff()` in
[`data-updating.ts`](../../packages/runner/src/data-updating.ts) walks the
value a caller handed to `set()` against what is stored at the destination and
emits a change for each path where the two differ. The read it makes of the
destination to do that carries the marker.

**The SQLite publication comparison.** A query snapshots its raw destination
record before staging a request and compares that snapshot with the destination
when an abandoned publication settles. Both reads carry `writeDestinationRead`:
they decide whether the write still owns this exact destination state, without
dereferencing row links or carrying a destination value into the query or its
output. The initial snapshot and the pending publication's destination diff
also suppress scheduling dependencies: the query's inputs trigger another
request, while the previous output does not. Keeping that comparison out of
scheduling prevents a previous result's membership label from tainting the
public pending flag through a trigger read. Conflict detection remains in
force. This lets trusted publication machinery update a shared result whose
shape label withholds it from the observing runtime.

The marker is opt-in at a call site, never derived from the shape of a read,
which is what makes the failure direction the safe one: a destination read
nobody marks stays in the join and over-taints, where a marker reaching a
read that should keep its label would under-taint silently.

The marker goes on those call sites, not on the walk. Every other read
`normalizeAndDiff()` makes joins as an ordinary read does, which matters
because the walk takes reads for two other reasons:

- It reads the target of a same-document ancestor link and embeds that value
  in what it writes. The content of that read becomes part of a written value,
  so it belongs in the join.
- It reads the parent of a path to decide whether the parent is an array,
  which settles the identity derivation for an anchored element. That derived
  identity is written, as the link the slot comes to hold, so this read joins.

A case pins each: marking the ancestor link's read, or the anchoring walk's
parent read, makes a transaction commit that should be refused. The anchoring
one turns on the anchored element landing in a document of its own, whose
declared ceiling is empty, so the enclosing array's label has nowhere to fit
once the read carrying it stops joining.

## Why the exclusion carries no label out

Each read answers a question about how to write rather than about what to
write: which of two ways to write, and which sub-paths differ. Three
properties together say where those answers can go.

First, no answer reaches a written value. Every value in the change set comes
from the caller's argument. The two reads decide which changes are emitted and
by which of the two routes, and they decide nothing else about their
content.

Second, where the slot's stored content steers the walk rather than merely
gating it, the walk reads that address again without the exclusion, so
the slot's own label gates every write the redirect carries the walk to. Two
branches do that, and `consumeSteeringSlot()` is the read both take:

- the stored value is a write-redirect link, which sends the write to the
  address that link names, in this document or another one;
- the stored value is a link whose scope is narrower than the slot's, which
  sends the write into the narrower-scope instance.

The repeated read is the ordinary read the comparison would have been, so
what it consumes at the slot is what any other read of the slot consumes.
Reading it as a `linkResolutionProbe` instead would not do: a probe consumes
`followRef`-class entries alone
([`cfc-observation-classes.md`](./cfc-observation-classes.md)), and a plain
declared entry at the slot is a covering entry, which a probe does not
consume.

Third, nothing a pattern writes can put the marker on a read. The symbol
keying it is private to
[`reactivity-log.ts`](../../packages/runner/src/storage/reactivity-log.ts),
so only runtime code importing `writeDestinationRead` can set it, and the
runner's public surface does not export it.

The cost of the type probe's half is measured the same way as the
comparison's, and it is smaller. The probe's answer selects between an event
send and a stored write, and each route discloses itself by its own effect
rather than by the join: a stored write appears in the write set, and a send
reaches the listeners and the delivery the event is queued for. The send need
not write storage at all, in which case the probe's answer leaves the
transaction's write set untouched and there is nothing there to read it
from.

## The objection §8.11.3 raises

§8.11.3 is the rule that a decision influenced by labeled inputs taints every
downstream output whatever that output's content is, and a reader who reaches
for it will read "the answer reaches no written value" above as the
content-label-only reasoning that rule exists to reject. The two meet at what
counts as the output.

What separates this decision from §8.11.3's router is what the decision
produces. The router picks among outputs whose values differ, so which output
was produced encodes the input. This decision picks which addresses receive a
value the caller supplied, identical whichever way the decision went. So what
it can encode is the write set rather than anything in it.

Each excluded read does influence an output, and the influence is named rather
than denied: which of two ways the transaction wrote, and which paths appear
in its write set. That is the channel the next section measures, and stating
it is what the exclusion rests on rather than a claim that nothing flowed.
Where a read influences *where* a write lands, which is the §8.11.3 router
shape at its sharpest, the read is not excluded at all — that is the steering
compensation above.

§18.6.2's own justification does not stretch to cover this class. It calls its
four exclusions public infrastructure, and says its read exclusion mirrors a
write-side rule that the same addresses are not value-write targets. Here the
addresses are the transaction's own write targets, so that sentence says the
opposite of what this class needs, and SC-41 proposes the reason the class
does rest on rather than borrowing that one.

## Flow relevance is unaffected

The exclusion is in the join derivation rather than in the read walk both it
and `flowLabelWorkExists()` share, so a read this class excludes still makes
a transaction flow-relevant exactly as it did. Nothing about when the flow
stage runs changes, and neither does what marks a transaction relevant.

Dropping the read from the walk instead would leave that property resting on
the predicate's write side — a transaction writing to a document that holds
any label entry is relevant on that ground alone. Deriving the exclusion one
layer in costs a transaction whose only labeled observation was excluded a
flow stage that computes an empty join, and buys a property that holds by
construction rather than by that argument.

What does change is what the stage then does. The per-value derived component
at a written path is replaced by the committing attempt's derivation, and
before this exclusion the destination read fed the path's own stored derived
label back into the join, so a later untainted write re-derived the clause a
tainted one had left. It now drops. The frozen `observes:"shape"` existence
entry still grows rather than replaces, which is SC-4's rule and not this
one's business.

## What it costs

Whether a path was written is visible to anyone who can see the document's
write set. Dropping a write therefore tells such an observer that the value
the writer produced for that path equalled the value already stored there.

One attempt discloses one bit. Repeated attempts with values of the writer's
choosing make it an equality oracle on the prior value at that path, so a
field drawn from a small set is recoverable rather than merely narrowed.

Where the disclosure lands is what bounds it, and two shapes land it
differently. A leaf comparison discloses the compared path's own prior
content at that same path — the path whose own label governs who may learn
about it — and that holds when a stored link has sent the comparison to
another document, since the compared path is then the one in that document.
Key removal and array shrink are the other shape: what the comparison
observes is the parent's membership, and what surfaces is a delete at a
child, so the parent's membership reaches a child whose own ceiling may
admit a wider audience than the parent's.

Write elision is what opens that channel, and elision is not new here. What
the exclusion changes is that the elision's influence is no longer labeled at
all. Before it, the transaction's join reached every path the transaction
wrote, so a dropped write at one path put that path's label on the write of
another — labeling the channel, but at the wrong paths.

At every rung where the commit lands, the same bit is observable with the
destination read in the join, since the join labels written values and does
not decide which writes are emitted. `enforce-strict` is the exception and
the honest cost of the exclusion: there the join's presence refuses the whole
transaction, so the bit does not escape, and after the exclusion the
transaction commits and its write set is visible.

Closing the channel instead would mean writing every path the caller named
whether or not its value changed, which turns every whole-object `set()` into
a full rewrite of the document.

Recording a channel a profile does not close is the discipline §18.6.4's
conformance checklist asks for, and this is the record it asks for. §4.6.3's
existence channel is the neighboring disclosure, carried as SC-4 in
[`cfc-spec-changes.md`](./cfc-spec-changes.md).

## What this does not change

The exclusion is scoped to the flow join, and the marker changes nothing else
about either read. What each read is recorded as follows from the rest of its
metadata, which this marker sits beside rather than replaces.

The diff's destination read carries `markReadAsAttemptedWrite`, so:

- it is still recorded in `attemptedWrites`, which is what gives the label
  machinery a record of the paths a transaction meant to write before a
  same-value comparison dropped one;
- it is still a read in the transaction's reactivity log, so the commit still
  carries its concurrency precondition and a conflicting concurrent write is
  still detected;
- it still seeds scheduler dependencies exactly as it did.

The type probe carries `ignoreReadForScheduling` and no attempted-write
marker, so it is in neither of those logs, and it was in neither before this
marker existed. What it has always been is a read the journal records for
label purposes and the reactivity log does not.

The exclusion is also scoped to the flow join among the three consumed sets
CFC derives. The transaction-global consumed set the egress and sink ceilings
read (`collectConsumedLabel`), and the per-write read-prefix gate of
[`cfc-write-prefix-provenance.md`](./cfc-write-prefix-provenance.md), both
still count these reads: a destination read precedes the write it is about,
which is exactly the position the prefix gate quantifies over. Those two can
therefore gate a write or a release on a label this one does not, which
over-gates and never under-gates. Widening the exclusion to reach them is a
separate change with its own measurements to take, and SC-23 in
[`cfc-spec-changes.md`](./cfc-spec-changes.md) is the precedent for stating
such a boundary rather than leaving it to be discovered.

That SC-23 boundary is worth naming precisely, because it names the flow join
as the one place it declined to narrow. It declined to narrow it *by journal
order*, which is a claim about which of a handler's observations fed a
particular write. This exclusion makes no such claim. It subtracts a read
that is not a handler observation at all before the join is formed, which is
what §18.6.2 is for, so the two do not meet.
