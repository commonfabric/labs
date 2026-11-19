# Space history

A space's store keeps every commit it has admitted, so a space can be shown as
it stood at an earlier point, interacted with there, and set back to what it
held. This document covers how that is put together across the layers: the
memory server's history and branch commands, the runtime that runs a fork, and
the shell's history panel.

The storage rules are in
[`../specs/memory-v2/06-branching.md`](../specs/memory-v2/06-branching.md),
sections 6.15 to 6.18, and the wire commands in
[`../specs/memory-v2/04-protocol.md`](../specs/memory-v2/04-protocol.md),
section 4.3.8. Inspecting a store's history offline, without a server, is the
state inspector's job; see the `state-inspector` skill.

## The model

Three ideas carry the feature.

**A step.** A space's history is a sequence of commits, each with a `seq`.
Most are the space's own computation: under server execution, the serving
loop's `derived` commits. A step begins at a commit something outside that
computation made, such as an event, an edit or a restore, and runs through the
commits computing what followed from it. The step's `seq` is its last commit,
which is the point of history holding the state the step left.

A space that has been compacted
([`../plans/compact-space.md`](../plans/compact-space.md)) has no steps below
the compaction: compaction deletes revisions, so a point of history below it
can hold a document as absent that the space held then, and the server
neither lists such a point nor forks or restores from it.

A step is **settled** when every event sent up to its end had its handler run
by then. The serving loop records the seq it has computed through on each
commit it makes (`derivedThrough`), so a step is settled when the loop had
computed through the last commit that sent an event, at the step's end. A step
that sent no event is settled when none before it was pending: what a write
alone calls for is derived state, which a fork computes for itself. Where no
serving loop commits, each client stores what it computes with its own commits,
and every step is settled. A listing judges this from the stretch of history
it read, so an event pending from before that stretch is not counted.

**A fork.** Showing an earlier state is not a read-only operation. A running
piece writes: an interaction as small as switching a tab is state, and a state
taken between an event and the computation that follows it has that
computation still to do. So an earlier step is always opened in a fork: a
branch of the space, forked at the step's `seq`. A fork is cheap to make, since
a branch shares its parent's revisions up to the fork point, and what a fork's
runtime writes to the space's documents stays in the fork. The section below
says what does not.

**A restore.** Setting a space back is one new commit on the space that writes
every document the space and the chosen step differ in. The state restored is
a point of the space's own history: the step a fork shows, not what the fork
holds. Nothing is removed from the space's history, so the state a restore
replaced is itself a step that can be opened or restored.

## Who computes a fork

No serving loop runs a branch. The runtime that opens a fork computes what the
fork stores, as a client does with server execution off: it runs the fork's
derivations and handlers itself and commits their writes to the branch. A
session of a branch is accordingly not client demand, and a commit on a branch
is not reported to the space's serving loop.

Two consequences follow.

- **An event the serving loop had not delivered at the fork point is not
  delivered in the fork.** Under server execution an event is appended to a
  stream's log and the loop runs its handler; a fork's runtime does not drain
  those logs. A fork of a settled step has none pending, as far back as the
  listing that judged it read. A fork of an unsettled step shows the state
  before the pending handler ran, which is why the shell marks such a step.
- **A fork repeats no effect it has not diverged from.** The built-ins that
  reach outside the space, such as the fetch and language-model built-ins, key
  their stored result by a hash of their request. A fork inherits both, so its
  runtime finds the result and sends nothing. Once an interaction in the fork
  changes a request, the built-in sends the new one, from the fork's runtime,
  as it would anywhere.

### What a fork does not contain

A fork is a branch of the viewed space's documents at the chosen step. Other
spaces are forked too, though not at that step, and two things lie outside a
fork altogether.

- **Other spaces.** A fork's runtime opens every other space on a branch of
  the same name as the fork's, which the server forks from that space as it
  stands when the runtime first opens it. What a piece in the fork writes to
  another space stays on that branch and ends with the fork. Another space is
  forked at its present state and not as of the viewed step, so a link out of
  a fork reaches documents from now beside the viewed space's documents from
  the past. A space the principal cannot write to gets no branch and is read
  as it stands.
- **SQLite databases.** A pattern's SQLite database is not stored as
  revisions, so no branch holds a copy of one. A piece in a fork reads the
  database as it stands now, beside documents from the past, and a write to
  it from a fork is refused rather than landing in the space.
- **Effects.** A request a fork's runtime sends, because the fork diverged
  from what was already fetched, is a real request.

## What a restore covers

A restore rewrites the space's documents, in every user's instance of a
user-scoped one. It leaves alone the access list, session-scoped instances,
the serving loop's own records (event logs, the watermark, the effect and
attention indexes), and the SQLite databases a pattern keeps, which are not
stored as revisions and so have no earlier state to return to. A collaborative
field in a rewritten document ends its epoch; an open editor starts again from
the restored text. `06-branching.md` section 6.15 states each of these.

A restore takes its state from the space's own history, and the server refuses
one that names a branch other than the default. A fork is computed by the
client that opened it, so its documents and their labels are that client's
word, and copying them onto the space would take them at face value. What was
done in a fork is therefore not carried into the space: restoring from a fork
sets the space back to the step the fork was taken at. A restore that keeps a
fork's changes is planned as a replay of the fork's events on top of the
restored step, so that the space's own computation produces the result
([`06-branching.md`](../specs/memory-v2/06-branching.md), section 6.15.5).

Listing history and forking need the access they read and write with: READ to
list, WRITE to fork or delete a fork. Restoring needs OWNER. A fork is as
private as the space: whoever can read the space can read its branches.

## The layers

| Layer          | What it adds                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Memory engine  | `listCommits()` and `restoreBranch()` in `runtime/memory/v2/history.ts`; `createBranch()` and `deleteBranch()`                   |
| Memory wire    | `branch.create`, `branch.delete`, `branch.list`, `history.list`, `branch.restore`; `SessionDescriptor.branch` and `forkBranch`   |
| Runner storage | `Options.branches` and `Options.forkBranch` on the storage manager; `listHistory()` and the branch methods on a space's provider |
| Runner         | `historySteps()` in `runtime/runner/src/history-steps.ts`, which groups commits into steps                                       |
| Runtime client | `spaceHistory()`, `createSpaceBranch()`, `deleteSpaceBranch()`, `restoreSpace()`; `InitializationData.branches`                  |
| `lib-shell`    | `RuntimeInternals.spaceHistory()`, `forkSpace()`, `restoreSpace()`; `SpaceFork`                                                  |
| Shell          | The history panel (`XHistoryView`) and the `open-history`, `close-history` and `restore-history` commands                        |

A session is opened on a branch, and the server reads and writes that branch
for everything the session sends without naming one. That is what lets the
layers above storage stay unaware of branches: a runtime whose storage manager
lists a space under `branches` runs that space as the branch holds it, and no
cell, link or transaction says which branch it is of.

A storage manager given `Options.forkBranch` opens every space `branches`
does not list on that branch, with `SessionDescriptor.forkBranch` set. The
server forks the branch from the space's default branch the first time a
session asks, for a principal that may write to the space, and opens a
session of the default branch for one that may not. A branch of that name
the space already holds is used as it is, whoever asks, so a fork's name is
one no other branch has: `forkSpace()` makes it from a fresh UUID. A worker
runtime passes
the branch as `forkBranch` when every space its `InitializationData.branches`
lists names the same one. Closing the storage manager deletes the branch in
each space it opened that way.

`RuntimeInternals.forkSpace(space, seq)` creates a branch named
`history:<uuid>` and stands up a second runtime, in a worker of its own, whose
storage opens the space on that branch with server execution declared off. It
returns a `SpaceFork` holding that runtime. `SpaceFork.restore()` restores the
space to the `seq` the fork was taken at and ends the fork, without waiting
for the fork's runtime, since nothing the fork wrote is part of the restore;
`SpaceFork.discard()` ends it without restoring. Ending a fork disposes of its
runtime and deletes its branches: the runtime that took the fork deletes the
viewed space's branch, and the fork's runtime deletes the branch in every
other space it opened as its storage closes. A runtime whose embedder
supplied its connection has no worker of its own to stand a second beside,
and cannot fork.

The branches a runtime opens are part of its security context: a document
attaching to a runtime asserts them, so a page cannot join a fork's runtime
believing it is the space's.

## In the shell

"Toggle history" in the header menu opens the history panel for the viewed
space (`showHistoryView` in the shell's display toggles). The panel lists the
space's steps, newest first, each with what began it, its `seq`, its time and
the principal that made it, and marks a step that is not settled as in
progress. The list is read when the
panel opens and again after returning from a fork; it does not follow the
space live.

Choosing a step forks the space there. While a fork is open, the root element
hands the fork's runtime to everything it renders in place of its own, so the
whole shell shows the fork: the piece in view, the piece list, navigation
within the space. The panel then offers two ways out. "Back to now" discards
the fork. "Restore this version" sets the space back to the step the fork
shows and ends the fork; changes made in the fork are not kept, which the
panel says while a fork is open. Closing the panel, moving to another space,
or replacing the runtime discards the fork as well. The step that is open
cannot be chosen again.

Each way out puts the view back where it was when the fork was opened, since a
piece reached inside a fork may exist nowhere else.

Ending a fork deletes its branch first and disposes of its runtime after, so
a fork dropped because its own runtime is being replaced still gets its branch
deleted. A fork is deleted through the root's runtime, so when that runtime is
replaced, the old one is disposed of once the fork's branch deletion has been
answered. A fork whose page goes away before ending it leaves its branch in the
store of the viewed space and of every other space its runtime opened. Such a
branch holds nothing but what was done in it and is not reachable from its
space. The space compaction tool deletes a space's leftover `history:`
branches itself before it compacts that space
([`../plans/compact-space.md`](../plans/compact-space.md)).

## What is not here yet

- **Restoring with a fork's changes.** A restore sets the space to the step a
  fork was taken at and leaves out what was done in the fork. Keeping those
  changes is planned as a replay: the space is restored to the fork point and
  the events sent in the fork are played back on top of it
  (`06-branching.md` section 6.15.5).
- **Long-lived branches and merging.** A fork is taken to look at a step and
  to choose it for a restore. Branches that live on, that a serving loop runs,
  and that merge back through a three-way comparison are the design in
  `06-branching.md` section 6.7. Restore is the case of that merge in which
  the source wins every document, and its commit records the same `merge`
  metadata a merge would.
- **History of one piece.** The panel lists the space's steps. A step does not
  say which piece it touched.
- **A fork across spaces as of the step.** Another space a fork reaches is
  forked at its present state rather than at the point of its history that
  matches the viewed step.
