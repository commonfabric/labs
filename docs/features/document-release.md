# Document release

A runtime holds a stored document because its memory session watches it. A
watch names a root document and a selector (a path and a schema); the server
keeps the session up to date with the root and with every document the schema
reaches from it through links. The union of a session's watches is what the
runtime's replica of the space holds, apart from a document the server retracted
while something here still read it, which the replica keeps for that reader
until the next release pass. This document describes how the runtime removes
the watches nothing needs any more, and drops the documents they kept loaded, so
that a long-lived runtime that opens and closes many pieces does not hold every
document it ever loaded.

The implementation is `SpaceReplica.releaseUnread()` in
`runtime/runner/src/storage/v2.ts`, driven by
`Runtime.releaseUnreadDocuments()` in `runtime/runner/src/runtime.ts`. The wire
message it relies on is `session.watch.remove`, section 4.3.9 of
[`../specs/memory-v2/04-protocol.md`](../specs/memory-v2/04-protocol.md).

## What keeps a document

A replica keeps a document while any of these holds:

- An action registered with the scheduler read it on its last run. This covers
  a piece's computations, and a cell's `sink()`, which is how a host's
  subscription to a piece's result reads it. The scheduler answers with
  `Scheduler.readsEntity()`, from the same index that decides which actions a
  change wakes.
- A cell whose own document it is has loaded it and is still reachable. A cell
  takes the document's hold token (`IStorageManager.holdDocument()`) when it
  loads, or, for a cell made from a loaded one, when it is first read; the
  storage manager keeps the token only weakly, so the hold ends when every cell
  holding it has been garbage collected, and that collection completes a
  release a pass was asked for earlier (see "When documents are released").
  Code that keeps a cell and reads or
  writes its document through it later therefore finds the document still
  loaded. The hold covers that document alone: a document the cell's value
  links to is kept only on its own account, and a read through the link that
  finds it dropped loads it again, as a read of any document not loaded
  does.
- A sink registered on the replica itself (`SpaceReplica.sinkDocument()`) names
  it.
- A local write to it is still pending.
- It is the stream sidecar of an event this runtime sent under server
  execution whose consequence has not yet arrived. The speculation overlay
  reads the sidecar for the event's consequence mark, so the sidecar stays
  watched until the mark arrives (`SpeculationOverlayDestination.trackIntent()`
  in `runtime/runner/src/speculation/overlay-destination.ts`; the
  requirement is in
  [`../specs/server-side-execution/speculation.md`](../specs/server-side-execution/speculation.md),
  section 4).

A release pass also keeps the watches rooted at a document that was loaded, or
read through the replica, since the previous pass began. A value read lazily,
such as one `Cell.pull()` returns, can follow a link into a document after the
read that produced it, and this keeps such a document through the pass that
comes next.

An event handler is not a reader between events. Before a handler runs, the
scheduler loads its inputs and waits for them (the presync and the preflight in
`runtime/runner/src/scheduler/events.ts`), so a handler whose inputs were
released loads them again when its next event arrives.

## When documents are released

A release pass runs when something that read documents has gone: when a piece
is stopped (`Runner.stop()`, which also runs when the runtime restarts a
piece), when a serving runtime stops the pieces a handler's result started once
the handler's transaction commits, which leaves running one a client demands
at that moment (`#releaseServedHandlerResult` in
`runtime/runner/src/runner.ts`; "A piece a handler starts" in
[`../specs/server-side-execution/serving-loop.md`](../specs/server-side-execution/serving-loop.md)),
when a host's client cancels a cell subscription
(`RuntimeProcessor.handleCellUnsubscribe()` in `runtime/runtime-client`),
and when a host's client departs (`RuntimeProcessor.disposeClient()`). A host
may also call `Runtime.releaseUnreadDocuments()` itself. A pass any of these
asks for is followed by another once the cells holding what it kept have been
garbage collected, as below. The pass waits until the scheduler is idle. Passes run one after another, never two at once. Requests
made before a pass begins share it, and a request made while a pass is under
way is answered by the next one, which waits for that one to finish. So at most
one pass waits at a time, and the requests that arrive while one is under way,
as a closing pane's cancellations of each of its subscriptions do, cost one
more pass between them.

A cell holds its document until it is collected, and a pass keeps every watch
rooted at a document it keeps. The pass a cancellation or a stop asks for runs
once the scheduler is next idle, which is seldom long enough for a collection
to have taken the cells the subscription or the piece held. So the documents
those cells loaded usually stay, with what their watches reach, through that
pass and the second one the window below can add. What the subscription or the
piece read only through its links, in documents watched on their own, is what
those passes can release.

The rest goes once the cells holding it have been collected. The storage
manager registers each hold token it hands out with a `FinalizationRegistry`,
and the first pass of a request something other than a collection made marks
each token live as it begins (`ReleaseOptions.followUpOnCollection`); the
second pass the window below can add marks nothing, and closing the storage
manager unmarks every token. When a marked token
that is still its document's current one is collected while its space is
open, the storage manager tells the runtime
(`IStorageManager.subscribeHoldsCollected()`), which asks for a pass. That
pass marks nothing, so a collection completes a release something already
asked for and never begins one: a runtime that stops nothing and loses no
client sees no pass on any collection's account, and the passes collections
ask for end once the tokens marked have been collected. The pass decides as
any other does, so a document held again under a new token since, read by a
scheduler action, or held some other way, stays; a marked token whose
document an action reads costs a pass that releases nothing. A collection
that takes many marked tokens reports each one, and the requests share one
pass, as requests made before a pass begins always do; a pass shared by such
a request and any other marks as the other would.

A pass keeps the watches rooted at a document loaded or read since the
previous pass began, and removes only those rooted at one neither loaded nor
read in that window. A piece that read its documents after the last pass
began, and then stops, leaves them in that window, so the pass its stop asks
for keeps them. Where a pass kept the watches of a document nothing holds for
that reason alone, one read while the pass itself was under way included,
`Runtime.releaseUnreadDocuments()` runs one more pass once the scheduler is
next idle. That pass removes the watches rooted at each such document neither
loaded nor read since the first pass began, and asks for no further one. It
keeps a document loaded or read after the first pass began, as any pass would,
and the next pass anything asks for decides it.

A host's worker also asks for a pass once it has first brought up the user's
Home, and the housekeeping that starts has settled with the scheduler idle
(`RuntimeProcessor.#startHomeHousekeeping()` in `runtime/runtime-client`).
Bringing Home up loads what its pieces read as they resume and what its stored
result links to, each room its chat manager lists among it, and nothing goes on
to read much of that.

A pass that has watches to remove first gives each document the replica keeps,
as above, and the session still delivers, a watch of its own where it has none,
with a selector that follows no links: a document that something reads only
through a link from another document is otherwise watched only as part of that
document's watch. A kept document the server retracted gets none, as below. It
then
removes the watches rooted at each document the replica does not keep and that
was neither loaded nor read since the previous pass began, so no removal can
take a kept document from the session. The server answers with `removes` naming
each document no remaining watch reaches. Each is emptied as any removal empties
it, and then dropped unless a local write to it is pending: its value, its
delivery record, and its watched mark go.

A document that something began to hold while the removal was on its way is the
exception. It keeps its value, but loses its delivery record and its watched
mark, and is watched again on its own; the answer to that watch brings it up to
date and records its delivery again. If that watch fails, the document keeps its
value, still without a delivery record or a watched mark, and the next pass
watches it again, or drops it if nothing holds it any more. A frame that
delivers the document, or a removal the server sends for it, before then settles
it instead, and the pass leaves it alone. An action that reads the document does
not load it again, so dropping it would leave the action with no value and no
later changes. If the space refuses the watch outright, the document is removed
and dropped like the others, so that its readers meet the refusal.

A removal the server pushes, for a document a write's re-walk no longer reaches
or for an instance whose lease has lapsed, stands: the document leaves the
watch list, and nothing asks the server for it again. One the replica holds
keeps its value, unwatched, for the reader that holds it, so an action in the
middle of reading it finishes with the value it had; the first release pass to
find it held by nothing drops it, and a read after that loads it as it now
stands. One nothing holds is emptied and dropped at once.

The server attributes each document it tracks to what reached it: a watch's
root to the watch, a document reached through a link to the document holding
the link, a schema document to the document whose selector or `cfc` envelope
names it, and the schema closure a delivered document's content refers to, to
that document. A removal releases the removed watches' roots. A document whose
last reaching watch, link, or schema reference lets go leaves the session,
together with what only it reached, and the answer names each in `removes`. A
document another watch or link still reaches stays. One that lost a record and
keeps another is walked again under the records it keeps once the retirements
have settled, so that what only the lost record's walk reached is released; a
document that lost nothing is not walked. A watch whose root a permissive watch
already covered was never walked; when that cover goes, the server walks the
root on its own, so the documents it names stay delivered.

A write that edits a link away retracts in the same way: the refresh that
re-walks the changed document releases what the walk no longer reaches, and the
pushed frame names it in `removes`. A document the server retires and reaches
again in one pass, as a schema document is when the document that kept it goes
and one that still names it is delivered after, is delivered, not retracted.
So a document stays loaded in a runtime
only while something reaches it, not until the next full evaluation.

A server that does not advertise `watchRemoveV1` could only be asked to remove
a watch by replacing the whole watch set, which sends the whole union back.
Against such a server the runtime keeps every watch.

## Reading a released document again

A dropped document is absent from the replica, as a document the runtime never
loaded is, and the paths that load an absent document load it again, as it now
stands on the server:

- A cell remembers that it loaded its document only until the storage manager
  drops that document (`IStorageManager.droppedDocuments()`), so its next read
  starts a load.
- The storage manager and the runtime forget that they kicked a load for a
  dropped link target or cross-space link (`#docPullKicks`, `#crossingKicks`,
  `Runtime.#missingDocLoadKicks`), and that they pulled the targets of an
  immutable document, so the next read through such a link kicks the load
  again.

The read that starts a load does not wait for it. A synchronous read of a
document that is not loaded, such as `Cell.get()` or `Cell.getRaw()` or a read
of the document's metadata, returns `undefined` and starts the load, as it does
for a document nothing here ever loaded. So a caller that needs the value of a
document no cell of its own holds, such as a stopped piece's argument read
through a cell made after the stop, syncs or pulls that cell first
(`Cell.sync()`, `Cell.pull()`). A read inside `Runtime.editWithRetry()` needs
neither: before the transaction commits, the runtime waits for the loads its
reads of absent documents started, and runs the attempt again if any of those
documents exists.

## Measuring

`getLoggerCounts().sizes.storage` reports a runtime's `documents` and
`watchedDocuments`, in total and per space under `bySpace`.
`runtime/runner/test/document-release.profile.ts` stores forty todo lists and
has a second runtime open each one (load, start, subscribe to its result) and
close it again (cancel the subscription, stop it, let go of its cells),
printing those sizes as it goes; `--no-release` runs it against a server
without watch removal, for comparison.
