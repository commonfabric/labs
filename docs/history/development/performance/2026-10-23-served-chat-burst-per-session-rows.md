---
status: historical
created: 2026-10-23
archived: 2026-10-23
reason: "The FabriChat send burst with view-scoped replication on, followed through the serving worker and the main thread: each new message row starts once per viewing session behind a family pre-sync that costs CPU, whether those starts land inside a measured burst decides the iteration, the creator-space removal's result falls within that spread, none of four removals of the pre-sync's cost moves the burst, and the stall reproduces without the store read-through, as a wait for a first join the store never received."
---

# Where a served chat burst's slow iterations go

On `b21ced957` the FabriChat send burst read about a second slower with the
flag on than with the serving loop off, 3.0 to 3.1 s against 2.0 to 2.2 s,
and its iterations spread from 1.4 to 4.3 s
([vote record](2026-10-23-one-served-vote-across-three-realms.md)). A review
of the [read-through record](2026-10-22-served-chat-burst-event-view-under-read-through.md)
asked for two things on this burst. One was why stopping the creator
space's run of the room made the burst slower, since a removal that should
help and hurts means the model of where the time goes is wrong. The other
was a stall count on an arm without the store read-through. This round
followed the burst's rounds through the serving worker and the main thread
to answer both.

## How it was measured

The arms are the earlier records'. `flag` is the serving loop in the worker
with the store read-through on, the overlap off, the flush deadline growing
to a 1000 ms cap, and `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION` on. `off` is
the loop off. Every run was in process on a four-core container.

The probe, `probe-chat-flag.ts`, is kept out of the tree like the earlier
probes. It runs the send burst's four members, two messages each, over
three rooms, and diffs the serving worker's timing rows across round 1. For
this round it also logged, from a scratch worktree only:

- each dependency pre-sync of a piece start
  (`Runner.#syncCellsForRunningPattern`), with its duration, its caller and
  the scope identity it ran under;
- each hold of a run for a family name-sync (`Runner.#familyAbsent`), with
  the reason;
- which realm ran each traversal slow enough to report itself.

The caller came from the SES-tamed error's `getStackString`, since
`Error.stack` is empty under the runtime's lockdown.

## Every new row starts once per viewing session

The room renders its messages through `facts.main.map(...)`, one
`FabriChatMessageRow` per message. The room's UI is per session, so every
viewing session has its own instance of every row, and the serving worker
starts each one. In the probe's logs each new row started three times, once
in each of three of the four members' sessions, so a burst's 8 new messages
made 24 starts. The fourth member's session, whose view is mounted like the
others', started none of them; this round did not follow that up.

Every start came through the same path: the list map's `reconcile`, then
`run`, `#runAfterNamedFamilyLands`, `#nameFamilyBeforeRun` and
`#prepareCellsForRunningPattern`. The absence probe held every one for a
family name-sync, for one of two reasons:

| Reason | Holds |
| --- | ---: |
| A document the row's argument links to is not on this replica | 108 |
| A space-scoped owned cell (`counterpart`, `chatDisplay`) nothing has computed yet | 29 |

None of the held cells owed a seed.

## The pre-sync costs CPU

In the earlier CPU profile of the serving worker over a profiled burst
(k2), the pre-syncs took 2.1 s of 14.9 s busy, 14%. Of that, 1.47 s was
`#syncCrossSpaceReads`, which reads every node plan's inputs under its
schema (`cell.get()` through `traverse`) to find links into other spaces.
The rest was planning the nested instances' nodes and syncing their cells.
The 24 pre-syncs of a burst finish one after another, about 42 ms apart,
so a burst carries about 1.1 s of them, and the rows' instantiations bring
roughly 650 action runs with them.

The worker's busy time in that profile, by what it was inside of (the rows
overlap):

| Inside | Share |
| --- | ---: |
| Authored code (`invoke`) | 32% |
| Schema-validated reads (`validateAndTransform`) | 22% |
| Derivation settles (`runPullSettleOrder`) | 18% |
| Piece-start pre-syncs | 14% |
| `#runWithStartOwnership` | 10% |
| The list map's `reconcile` | 10% |
| Commit preparation | 10% |
| View planning | 0.7% |

## What the slow rounds hold

Round 1 of each probe, end to end, from the sends until every member's view
of the room's newest messages held all twelve. The serving worker's counts
are over the same window.

| Run | Creator's run of the room | Pre-syncs | Actions | Round 1 |
| --- | --- | ---: | ---: | ---: |
| c1 | on | 24 | 760 | 5.15 s |
| c4 | on | 2 | 312 | 2.69 s |
| c5 | on | 2 | 258 | 2.27 s |
| c2 | on | 2 | 115 | 2.26 s |
| c3 | on | 3 | 113 | 1.68 s |
| cstop1 | stopped | not counted | 407 | 2.55 s |
| cstop2 | stopped | 1 | 72 | 2.06 s |

A round's time follows the work the worker does inside it. The fastest
rounds ran 72 to 115 actions and read about as fast as the loop off. The
middle ones ran 258 to 407, and c1, where all 24 row starts fell inside the
round, ran 760. In c2 the row starts began 3.6 s after the sends, past the
measured end.

The main thread is busier in the slow rounds too. In c1 the memory server's
refresh spent 13 to 16 ms per touched session, most of it re-walking the
session's selection, against about 3 ms in c2 and c3. Fourteen of the
fifteen traversals slow enough to report themselves in one probe ran on the
main thread. Each took 110 to 180 ms, over 7,000 to 14,000 schema visits and
12,000 to 24,000 `anyOf` branches.

## The creator-space result

The [deferred-settle record](2026-10-22-served-chat-burst-and-the-deferred-settle.md)
stopped the creator space's run of each room once the creating commit
landed. That removed every refused write and read slower: 4.9 and 4.5 s
against 3.6 and 3.9 s, over five iterations each. Run again as probes (the
table above), the rows start three times each in both arms. Round 1 reads
1.68 to 5.15 s with the creator's run on, median 2.27 s, and 2.06 and
2.55 s with it stopped. The spread within each arm is wider than the gap
between them.

The earlier difference lies within that spread. What governs the burst is
how much of the worker's work lands inside it, the per-session row starts
the largest part, and the creator's run does not touch those starts. So
the model the levers were ranked by was wrong: the refusals in the creator's
space were not on the burst's critical path, and the per-session rows were.

## Removals tried

**Skipping the pre-sync's cross-space reads on a serving runtime.** A run's
own read of a foreign document kicks the same load, so skipping them trades
the pre-sync's reads for a park wherever a run reads one. From one scratch
worktree, the send burst read 3.5 s (2.4 to 4.6) with the reads skipped
against 3.1 s (2.6 to 4.2) without. Dropped.

**A storage walk that stops at what its tracker covers.** The memory
server's walk of a session's selection follows a link into a document the
session already tracks only when the link declares no scope; a scoped one
is skipped as covered. The guard keeps a client's value reads correct,
since the skip leaves `null` where a repeat link's value would be, but the
storage walk reads no value back. Letting that walk skip a covered target
through an unscoped link passed the memory server's suite and the runner's
query and coverage tests. It moved neither chat arm, though: from one
scratch worktree, the send burst read 3.9 s (2.5 to 5.1) with it on the
flag arm against 2.8 s (2.5 to 3.2) without, and with the loop off 2.2 s
(1.7 to 2.7) with it against 2.2 s (1.8 to 2.5) without. The main thread's
slow walks fell from 45 to 38 in a run. The likely reason it did so little:
the room's UI is per session, so the links its walks follow already declare
a scope, and what stays slow is content a wave changed.

**Holding no run for an absence the store confirmed.** The gate counted a
document the store read-through had read and found nothing at as absent, and
held the row's start for a name-sync, which asks the replica and would have been
told the same absence until the feed reported a write. Letting such a document
hold no run, named family or not, removed both of the holds above. Three pairs
of send bursts, alternating with a control from the same worktree, read 3.2, 3.2
and 3.7 s with it against 3.5, 2.6 and 3.4 s without. A probe with the start log
showed why nothing moved: every row was still held, now for a default owed to
`pickerOpen`, which `message-row.tsx:242` declares as
`new Writable.perSession(false)`. The row's result is the space's, so each
viewing session's instance of that cell is owed a seed, and the hold's
preparation is what seeds it.

**Seeding owed defaults without the pre-sync walk.** On top of that, a
start held only for defaults the store reported holding nothing for seeds
them, each in a transaction of its own as the preparation does, and loads
nothing; a caller-owned setup, which seeds them in the caller's
transaction, is not held at all. The probe's round 1 ran no pre-syncs, where
the earlier rounds ran 2 to 24. Three pairs, against the branch head from a
worktree of its own, read 3.3, 3.9 and 3.3 s with it against 3.1, 4.3 and
2.9 s without. The pre-sync's CPU is not what sets the burst's time.

**After review.** The gate still held a start for an absent argument
document the store had reported, on the reasoning that the name-sync would
read it fresh; it would not, since a name-sync asks the replica. The setup
that wrote the result linking to the argument wrote the argument too, so the
gate now asks the store for it again (`readStoreAbsenceAgain()`). That came
after the measurements here and was not measured.

The benchmark's end is each member's own read of the room's newest messages
holding every body. Each member is a web client with its view mounted, so
under the flag the serving worker runs every session's view of the room,
rows included, on one thread; with the loop off each member's runtime runs
its own, four runtimes on four threads. That holds whichever of the
removals above is in.

## Stalls

**Under CPU profiling, on the read-through arm.** The profiled chat probe
stalled three times, and two of the three were the probe's own:

- **A real stall.** On a worktree at `172ce8769`, with `0ed69db50` in, round
  1's join wait timed out after 120 s. The probe's watchdog covered only the
  burst, so nothing was dumped.
- **Two artifacts.** The probe's profiler start waits for the serving worker
  to answer on a `BroadcastChannel`. The worktree those two ran from lacked
  the probe-only worker hook that answers.

With the watchdog over the joins and each burst phase, and every dump step
bounded, two further profiled runs completed. That is one real stall in four
valid runs.

**Without the read-through.** The read-through record's stalls were all on
the read-through arm, and a serving replica without the read-through still
runs the barrier (`flushSessions` and `pullToServerHead`) that the
read-through replaced. Four send-burst benchmark runs on the flag arm with
the read-through off, at `b21ced957`:

| Run | Result |
| --- | --- |
| 1 | 4.0 s (2.6 to 5.2) |
| 2 | 3.8 s (2.8 to 5.2) |
| 3 | 3.4 s (2.8 to 4.3) |
| 4 | stalled: a member's wait for the room's rows timed out after 120 s, in the run's last iteration |

So the stall is not confined to the read-through arm. The benchmark records
no rounds, so it cannot say whether the stalled wait was a join's or the
burst's.

**What one stalled wait held.** Two probe runs of eight rooms each, on the
flag arm with the read-through off, from the scratch worktree the other
probes ran from. The second completed all eight rooms. The first stalled in
its fourth room's join wait, and the watchdog's dumps at 30 s and 60 s say
what the wait was for:

- Every member's view of the room held three of its four joins, as did a
  session opened fresh for the dump. The missing one was the first member's,
  the room's creator, written as the first message after the room's
  creation.
- Each of the other three joins was followed by a serving-loop commit to the
  room's space that wrote the room's messages. The first member's was not:
  its event append landed, and no commit after it wrote the messages.
- The serving loop had armed the deferred rescan 4 times and fired it 4
  times. No event sidecar of the room held an entry, so no event was
  waiting to be processed, and the watermark was 2 commits behind at the
  dump.
- In the same window the creator's space refused 227 writes its run of the
  room tried to make into the room's space, and the room's waves dropped
  derivations whose reads depended on a withdrawn contribution, each of
  which re-arms after the rollback.

So this stalled wait was not a wake that never came: it waited for a
message the store never received. Which runtime consumed the first
member's join without writing it is not established.

## What remains

- **A lost message, the branch's blocking fault.** A served event was
  consumed and its consequence never written: the stalled probe's room never
  received its creator's first message, which every member's wait needed.
  One room in about a dozen stalls this way. Whether the room's serving
  runtime consumed that event without a handler, or the creator space's run
  of the room did, is the next question
  ([lost-join record](2026-10-23-served-chat-lost-first-join.md)).
- **Every session's view on one thread, a decision for the owner.** Each
  member is a web client with its view mounted, so under the flag the
  serving worker runs every session's instance of every row, where with the
  loop off each member's runtime runs its own, four runtimes on four
  threads. None of the removals above changes that ratio, so the chat goal
  may not be reachable by removing cost. Two directions change the ratio
  instead, and choosing between them is the owner's: computing once per
  message the part of a row that no session's state reaches, and settling
  the data a session watches ahead of its view's rows within a wave.
