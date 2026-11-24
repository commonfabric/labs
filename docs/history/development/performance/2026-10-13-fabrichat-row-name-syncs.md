---
status: historical
created: 2026-10-13
archived: 2026-10-13
reason: "Finding from an investigation of why some reloads of a fabrichat room name every message row's family: the gate before a row's start read a derived cell with no value as absent; with the two store states that leave such cells, the counts across reloads before and after the gate probes a derived cell's record, and a first render that can print a room without its lists, October 2026."
---

# Why a fabrichat room's reload named each message row, October 2026

A reload of a fabrichat room pays a handful of name-syncs
(`runner/start/syncCellsForRunningPattern`), or two per message row on top
of them. Captures of two thirty-message rooms on 2026-10-12 showed both
shapes: 4 on a first load, 124 on a second and third load of one room, 64 on
a second load of the other and 4 on its third. An earlier measurement of
the same day, at `575c896d26` and on no merged branch
(`2026-10-12-fabrichat-room-load-main.md`, commit `6c2c9fbaff`), had counted
four to five. The questions were whether the runner regressed between the
two, whether a row's start was racing the resume pre-sync under load, and
which stage of the gate before a row's start (`Runner.#familyAbsent`) held
it, on which document.

It is not a regression, and no row raced the pre-sync. The gate held a row
whenever one of the derived cells the row owns held no value, and whether a
store holds such cells is decided by how the room's earlier loads ended and
by what the row's pattern computes. The gate functions are the same text at
`575c896d26`, where the earlier measurement was taken, and at `27cc0885fa`.

## Setup

- The client: a Deno `cf piece render` of the room as its starter, through
  `skills/perf-investigation/scripts/profile-cf.ts`, with the logger's
  counts and timing statistics written at exit and the wire recorded under
  `CF_MEMORY_FRAME_LOG`. `serverExecution` off at both ends.
- The server: a local toolshed at a port offset over a store directory of
  its own. For a comparison each arm had its own toolshed over its own copy
  of one store, and its own checkout.
- Room A: thirty messages, twelve members, seeded on 2026-10-12 from main at
  `1384591508`. It shows sixty row instances, thirty in the message list
  and thirty in the thread list, and its row pattern holds two derived
  display cells of which a row reads one.
- Room B: the same seeding from the row pattern that builds a thread row
  only for the open thread, which main holds from `11975f05bd`. Thirty row
  instances.
- Rooms C: seven more, seeded on 2026-10-13 from main at `27cc0885fa`, the
  same shape as B.
- The code: main at `27cc0885fa`, and that commit with the gate change
  described below.
- The machine: an M3 Max with 16 cores, never idle. Its one-minute load was
  366 to 478 during the 2026-10-12 captures, and on 2026-10-13 between 48
  and 357, given with each measurement. So nothing here is a wall time:
  every number is a count.

Rooms A and B had each been loaded three times on 2026-10-12, and the store
they were in was kept. Every load of them here starts from a copy of that
store.

## What held a row

A temporary line in the gate's `hold()` named the stage and the document.
On a fourth load of room A, at main, the gate held 123 times:

| held | times | stage | document |
| --- | --- | --- | --- |
| a list's element piece | 60 | an owned cell | a `computed:` document of the row it instantiates, space-scoped |
| a row | 60 | an owned cell | the same document as its element piece |
| the room core | 1 | an owned cell | a `computed:` document, space-scoped |
| the add-member surface | 1 | an owned cell | a session-scoped document |
| a piece one of the room's wishes starts | 1 | the argument document | its argument document |

Every one of the 120 row holds was on an instance the root's pre-sync had
planned and named (`Runner.#presyncNamedInstances`): one round planned all
148 nested instances, and no sync failed. So no row was racing the
pre-sync. The pre-sync had asked for the document the row was held on, and
the store had answered.

The sixty documents are, by the row's own manifest, entry 9 of the thirty
message-list rows, `threadRowDisplay`, and entry 10 of the thirty
thread-list rows, `mainRowDisplay`. In the store each has exactly one
revision: the `set` that setup wrote, carrying the `result` back-link and
no value. `#documentPresent` read a document as here when it holds a value,
and made one exception, for a stream. A derived cell that holds its record
and no value read absent, the row was held, and its name-sync asked the
store for the family again and received the same record.

Two per row is the list's element piece and then the row: the element
piece's owned cells include the row's, so it is held on the row's document,
and once its own name-sync lands and it instantiates the row, the row is
held on that document again.

## Where a derived cell with no value comes from

Setup writes each derived cell's `result` back-link in the commit that sets
the piece up. The cell's value is a later commit, of the computation's
first run. Three things leave the record without a value.

**A computation that yields `undefined`.** It runs, and writes nothing.

**A computation nothing demands.** Room A's row sets its `display` to
`inThread ? threadRowDisplay : mainRowDisplay`. A row that starts through
its own held start computes the branch it reads and not the other: on the
second, third and fourth loads of room A no commit gave any of the sixty
documents a value. So each row kept one derived cell with no value, and
room A named its rows on every load after its first. The row pattern has
held both cells since `466e9cd612` on 2026-10-05, which is before
`575c896d26`; room B's pattern has one. A row that starts inside its list's
run computes both branches: the load that built the rows sent a value for
all sixty, and so did the first load with the change below.

**A client that closes before its commits are applied.** The load that
first builds the rows computes every derived cell of every row, the
unread branch included, and sends each value as a commit of its own. `cf
piece render` prints once the scheduler is idle and exits. On 2026-10-12:

| first load | commits sent | answered at exit | applied by the store |
| --- | --- | --- | --- |
| room A, load 379 to 417 | 1,899 | 39 | 108 |
| room B, load 397 to 413 | 908 | 29 | 93 |

1,706 of room A's unanswered commits, and 814 of room B's, wrote a derived
cell's value. The store was left holding every row with its setup and
almost none of its values. The second load therefore named every row, 124
and 64 name-syncs, computed the values the rows read and had 1,870 of 1,873
commits answered. Room B's third load found every row's cells valued and
named none. Room A's found the unread branch still without a value.

This third way depends on the machine. A room C first loaded at main on
2026-10-13, at a load of 126 to 164, sent 885 commits and had 46 answered at
exit, and the store applied all 885 after the client had gone. Its second
load paid 4 name-syncs.

The earlier measurement's four to five fits the same reading and was not
taken again: its reload room was first opened in a browser, which stays
open while its commits are answered.

## Counts across reloads

Five reloads of each room in each arm, both arms at once, each from its own
copy of the 2026-10-12 store. One-minute load at the start of a render
between 48 and 216.

| room | client | name-syncs | rows instantiated outside their list's run | `resumeCellSync` spans |
| --- | --- | --- | --- | --- |
| A | main | 124, five times | 60 of 60, five times | 13,285 |
| A | main with the change | 4, five times | 0 of 60, five times | 295 |
| B | main | 4, five times | 0 of 30 | 299 |
| B | main with the change | 4, five times | 0 of 30 | 299 |

The load of room A at main that carried the temporary line, at a load of
300 to 311 and from the same store state, gave the same 124 and 13,285. The
counts did not move with the load.

A room C loaded six times in each arm, at a load of 73 to 164: 4 name-syncs
on every load from the second on in both arms, with the rows instantiated
inside their list's run. In the arm with the change the second load is the
one that built the rows; its first printed none, which the section after
next describes.

## The change

For an instance the resume pre-sync planned and named, the gate takes the
record of a derived cell, a document whose id has the `computed:` scheme,
for the cell, unless the cell is owed a default at a scope narrower than
the result of the instance that owns it (`ownedCellRecordSuffices` in
`packages/runner/src/runner.ts`). A derived cell whose record has arrived
is here; one this replica never loaded has no record and still holds the
start. `packages/runner/test/resume-presync-plan-count.test.ts` resumes a
tree whose rows each own a derived cell that yields `undefined` and expects
one name-sync. Before the change it counted seven: the root's, and two for
each of three rows.

A cell owed such a default keeps its hold because a start's preparation is
what seeds the default when the cell holds no value. On a resume through
`Runner.start()` the root's preparation already seeds it for every instance
its pre-sync named, before any row reaches the gate. The pre-syncs that
name instances and seed nothing are `runSynced()`'s and
`syncStoredPieceCells()`'s. A test in the same file resumes through a
synced run in a caller's transaction and expects each row's start to seed
its per-user default; without the exception no row is seeded. Another
expects one name-sync for a tree whose rows each run a sub-instance scoped
to the user that owns such a cell: the default is owed relative to the
sub-instance's own result, which is per-user too, so none is owed.

The counts in the table above were taken with a first form of the change,
which took the record for every derived cell, whether or not the pre-sync
had named its owner and whether or not a default was owed to it. All 120
row holds were on named instances, and five more reloads of each room
limited to named instances, at a load of 175 to 229, gave the same counts:
4 name-syncs and 295 spans for room A on each, 4 and 299 for room B. Five
more with the form that landed, the exception for an owed default included,
on main at `560bcd9f20` and at a load of 323 to 758, gave the same counts
again.

The first form failed one test of the runner's suite,
`packages/runner/test/cfc-policy-manifest-shared-install.test.ts`, "starts
it again for the participant who set it up when the manifest cannot be
loaded". There the pre-sync's sync of the policy manifest is made to fail,
so the round records no instance as named. The piece's per-user part owns a
derived cell, `known`, that nothing has computed. At main the part is held
on it, starts in a transaction of its own, and its commit is refused for
want of the manifest while the piece stays running, which is what the test
expects. With the first form the part was not held, started inside the
piece's instantiation, and the refusal took the piece's start with it. The
same test fails at main when the first participant reads `known` once
before the restart, so what it expects rests on that cell never having been
computed. The final form leaves an instance the pre-sync did not name held
as before.

## What a reload still pays

Four name-syncs, three of them for nested instances of the room. On rooms
A and B with the change:

- The room core, held on a cell it owns that is not a derived one and holds
  no value: the cell its `wish` for the space's root writes to. The gate
  passes the core's three derived cells that hold no value, `latest`,
  `oldestAt` and `expiredThrough`, and stops at this one. The core's
  name-sync plans the whole tree a second time: 87 instances and 3,385
  cells on room B, after the root's 88 and 3,487.
- The add-member surface, held on the session's own instance of a
  session-scoped cell, which no store holds before the session writes it.
- A piece one of the room's wishes starts, held on its argument document,
  which the store holds and the replica has not loaded. This is the case
  the gate exists for.

The first two deliver nothing. The replica separates a document it has
examined from one it has not (`IStorageProvider.unexaminedAbsences`), which
is the distinction the gate lacks for them.

## A first render can print a room without its lists

Found while measuring, and present at main. A first render of a room whose
rows no client has built can print the room with no participants and no
messages. Of eight first renders of rooms C on 2026-10-13, four printed
thirty messages (twenty-nine for a room seeded with one fewer) and four
printed none: one of four at main and three of four with the first form of
the change, at a load of 126 to 298.

Six of the eight carried the temporary line, three in each arm, with
another in the list coordinator. The gate's decisions are the same in both
arms and in both outcomes: the room core is held, named and started, then
the add-member surface. The change alters which document each of those two
holds names, and no decision.

After the two starts each list coordinator reconciles once. Its result
container is not in the store, so it waits for the container's pull and the
seed of an empty one (`resumeContainerWait`), which re-arms it. In a render
that printed the rows the second reconcile followed. In one that printed
none the process had exited first: the wait is registered with the storage
manager's settle barrier, and a one-shot render waits for the scheduler's
`idle()`, which does not include it. Such a render sent 46 commits where a
full one sent 885, and the next load built the rows.

Eight renders do not show whether the two arms differ in how often this
happens. Each render at main ran at the same time as one with the change,
and two of the four pairs agreed.

## What this says about an earlier reading

[`2026-10-12-cycle-break-room-counts.md`](2026-10-12-cycle-break-room-counts.md)
found that a room opened once before, by the run that built its rows, did
twice the action runs and four times the commits on its next load, and read
that as a re-derivation after a change of runtime. Room A here did the same
with no change of runtime between the two loads: 108 commits applied from
its first load, then 1,873 on its second and 406 on its third, all three at
`1384591508`. A first load whose commits were not applied accounts for room
A's; that record's rooms were not measured again.
