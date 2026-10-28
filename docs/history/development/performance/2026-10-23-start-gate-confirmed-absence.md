---
status: historical
created: 2026-10-23
archived: 2026-10-23
reason: "Why a piece's start is not held for a name-sync over a document the store read-through confirmed absent, and why a start held only for defaults such a document owes seeds them without the pre-sync walk: on the served FabriChat send burst every new message row's start ran a pre-sync, 2 to 24 a burst, which cost the serving worker CPU; with the change none ran, and the burst's time did not move. Over three rooms of the chat probe, the serving worker spent about 1.1 s in pre-syncs with the change against 6.2 s without, and 7% less time busy. Measured on the served-vote branch (#9122) before the change was split out to land on its own."
---

# A start the store's confirmed absence does not hold

This change was made and measured on the served-vote branch
(commonfabric/labs#9122), and split out of it to land on its own. The change
under "After review" came after the measurements, on both.

## How it was measured

On #9122's branch, on the arm the branch's chat records use: the serving loop
in a worker, the store read-through on, the overlap off, the flush deadline
growing to a 1000 ms cap, and `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION` on.
The gate itself runs in whichever runtime serves the space, and only with
`SERVER_EXECUTION_STORE_READ_THROUGH` on. Every run was on a four-core
container.

The send-burst timings come from `fabrichat-send-burst.bench.ts` in process,
alternating each change with a control from the same worktree. The probe,
`probe-chat-flag.ts`, kept out of the tree, runs the burst's four members over
three rooms; one variant logged every pre-sync of a piece start
(`Runner.#syncCellsForRunningPattern`) and every hold for a family name-sync
(`Runner.#familyAbsent`), with its reason. The CPU numbers come from V8
profiles of the serving worker over every round of the probe.

## What held the starts

The room renders one `FabriChatMessageRow` per message, and its UI is per
session, so every viewing session has its own instance of every row and the
serving worker starts each one. With three sessions viewing, a burst's eight
new messages made 24 starts. The gate before a piece's run held every one for
a family name-sync:

| Reason | Holds |
| --- | ---: |
| A document the row's argument links to is not on this replica | 108 |
| A space-scoped owned cell (`counterpart`, `chatDisplay`) nothing has computed yet | 29 |

With the store read-through on, the replica had already asked the store for
each such document and been told it holds nothing there. A name-sync asks the
replica, which answers with that report and does not ask the store again until
the feed reports a write, so it could deliver none of them, while its pre-sync
walk cost the start CPU: in an earlier profile of the serving worker over one
burst, the pre-syncs took 2.15 s of its 14.0 s busy, 15%, and 1.46 s of that
was `#syncCrossSpaceReads` reading every node plan's inputs under its schema.
(Busy time here is the profile's sampled time less its idle samples, and a
sample counts once if any pre-sync function is on its stack, as below.)

## The change

`35ab37838`. The replica says which instances the read-through found nothing
at (`IStorageProvider.storeReportedAbsent`), and such a document holds no
start, named family or not. The replica still reports a transaction's read of
one as unexamined, for commit to reconcile.

That alone removed both holds above and moved nothing: three alternating pairs
read 3.2, 3.2 and 3.7 s with it against 3.5, 2.6 and 3.4 s without. Every row
was still held, now for a default owed to `pickerOpen`, which the row declares
`new Writable.perSession(false)`: the row's result is the space's, so each
viewing session's instance of that cell is owed a seed, and the hold's
preparation is what seeded it. So a start held only for defaults the store
reported absent now seeds them, each in a transaction of its own as the
preparation does, without the pre-sync walk (`Runner.#seedOwedDefaults`). A
caller-owned setup, which seeds them in the caller's transaction, is not held
at all.

`1222fe860` tests the window this leaves: the store gains a document after the
replica reported it absent, the commit of a run that read it absent is refused
with a conflict on it, and the attempt that reads it again, once the feed
reports the write, commits.

## Measured

With both parts, the probe's round 1 ran no pre-syncs, where earlier rounds
ran 2 to 24. Three alternating pairs of send bursts read 3.3, 3.9 and 3.3 s
with the change against 3.1, 4.3 and 2.9 s without, so the burst's time did
not move.

## The serving worker's CPU

The profiles ran on #9122's head, `78320a68a`, with three rooms each joined
by its four members and then sent its burst. That head's message row carries
a fold of its derivations made later on that branch, and with it the row's
starts were not held with or without this change: over the burst's window,
pre-syncs took 79 ms of the worker's 4.0 s busy with the change reverted and
31 ms of 3.9 s with it. So both arms put back `main`'s row, and differ only in
this change, reverted (`1222fe860` and `35ab37838`) or kept:

| Over three rooms, in the serving worker | Without the change | With it |
| --- | ---: | ---: |
| Pre-syncs of piece starts | 6.33 and 6.08 s | 1.12 and 1.05 s |
| Their share of busy time | 11.7% and 11.8% | 2.3% and 2.2% |
| Seeding owed defaults without the walk | none | 161 and 164 ms |
| Busy time | 54.0 and 51.4 s | 49.4 and 48.2 s |
| The run, end to end | 57.9 and 55.2 s | 53.1 and 52.5 s |

The change takes about five seconds of pre-syncs out of three rooms, about
1.7 s a room, and the worker's busy time falls by 3.9 s on average, 7%. A
sample counts as a pre-sync once if any of the start path's sync functions is
on its stack: `#syncCrossSpaceReads`, `#syncResumeInstanceNodes`,
`#syncCellsForRunningPattern` and its inner half, `presyncInputs`,
`#syncFamilyCell`, `#prepareCellsForRunningPattern` or `#nameFamilyBeforeRun`.
That is the count the earlier profile's 15% comes from.

Profiles of round 1's burst alone did not settle it. How much of the rows'
start work fell inside the burst's window varied from run to run: without the
change, three runs caught 23, 112 and 779 ms of pre-syncs.

## After review

The gate held a start for the argument document even when the store had
reported it absent, on the reasoning that the name-sync would read it fresh.
It would not: the name-sync asks the replica, which answers with the report.
Setup writes the argument in the transaction that writes the result linking to
it, so with that result present the report predates the write, and the gate
now asks the store for the argument again
(`IStorageProvider.readStoreAbsenceAgain`), the read the feed's report of the
write would make. An argument the store still holds nothing at holds no start,
like any other document the store reported absent. A read the store gives no
answer to holds the start for a name-sync, as one it could not be asked for
does. Once the store answers that it holds the argument, the gate walks the
links in what it holds through a read transaction of its own, since the
probe's transaction checked the argument out absent and reads it that way.
This was not measured: a start meets it only in the feed's lag, which none of
the runs above was timed in.

The re-read applies a frame from inside the gate, and a frame's storage
notification reaches its subscribers before the re-read returns. The
scheduler's subscriber marks the readers of what changed and queues a pass, so
no action runs between the gate's probes; `engine-read-through.test.ts` holds
both halves.
