---
status: historical
created: 2026-10-22
archived: 2026-10-22
reason: "The FabriChat send burst after the deferred settle: the probe's lost bursts were late derivations, the drain's event view lagged the feed by milliseconds and the read-through barrier could not bring it current, the benchmark stalled in four of six runs with the mechanism after its lags unestablished, a prefetch of parked heads' loads was dropped, the Topics navigation benchmark measured with view-scoped replication on, and a review's fixes to the send path, the deferral's owner and the record of what the deferral trades."
---

# The served chat burst: an event view behind the feed, and late derivations

The [chat record](2026-10-22-served-chat-burst-and-the-deferred-settle.md)
left the FabriChat send burst half a second behind the serving loop off with
view-scoped replication on, and one probe round unexplained. This round ran
that burst on the worker arm until it failed, and found three things:

- the probe's lost bursts were derivations arriving late;
- the drain's view of a stream lagged the feed's notice by milliseconds, and
  under the store read-through the barrier meant to bring it current could
  not;
- the benchmark stalled outright in four of six runs.

It also measured the Topics navigation benchmark with the flag on, and
carries a review's fixes. As in the records before it, the direction is the
work a burst costs the host first, and one viewer's latency later.

## How it was measured

The arms are the census's: the store read-through on, the overlap off, the
flush deadline growing to a 1000 ms cap, and the serving loop in the worker
with view-scoped replication on (`flag`), or the loop off (`off`).

The benchmarks:

- `fabrichat-send-burst.bench.ts` (four members, two messages each);
- `lunch-poll-vote-burst.bench.ts` at 5x5;
- `topic-board-navigation.bench.ts`, against a toolshed and shell run from
  source.

The chat probe hosts the send benchmark's harness and stays uncommitted, as
the records' probes do. This round it gained four things:

- a per-phase list of the commits admitted during a burst;
- the end condition the benchmark uses, `waitForRows` on every member's
  view;
- a count of head parks per round;
- a V8 profile of each realm on request.

The logging in the space server, the wave accumulator, the scheduler and the
overlay was temporary and is not committed. Everything ran on a four-core
container, one arm at a time.

## The probe's lost bursts were late

The probe used to end a burst when every member's intents had resolved and
the harness had settled, then read each member's message count. In the
rounds that read short, every handler's consequence mark had committed, and
no commit in that window had written the room's messages list. That was read
as a lost burst.

What the handlers write is the room's record document; the messages list is
a derivation over it. Ending on `waitForRows` instead, every such round
completed. The derivations landed 2 to 8 s after the marks, with no new
input. Three things made those rounds late:

- **Head parks, one after another.** The probe counts about 44 head parks
  per round. In the slow rounds they ran in sequence, at roughly 100 ms
  each: a park, its release, the next event's park.
- **One long settle on the shared worker.** It ran over 1.3 s, and its
  deadline fired late.
- **Refused lifts in the room creator's space.** That space runs the room's
  graph, and the room space refuses its writes. `foreign-write-refused` is
  not a terminal abort, so each refused lift takes the reactive retry, up to
  ten times.

Across one ten-round probe run, the 943 parks had a median of 1 ms; the
release is usually immediate. The tail is in parks that wait on another
space's documents: for most member spaces their 90th percentile was 100 to
870 ms, and the longest was 2.3 s.

## The drain ran ahead of the feed

The serving loop learns of an event in two ways:

- **The drain** lists pending stream entries from the store, through the
  worker's own SQLite connection. That connection sees a commit as soon as
  the memory server has written it.
- **The replica** learns of the same commit only when the feed's notice for
  it is drained. Under the store read-through, that is when
  `#refreshHeldDocuments` re-reads what the commit wrote.

So the drain can reach an entry its replica's view does not hold yet. It
checks for that before a handler runs, since the consequence mark is written
at the entry's index in the replica's view.

On such a mismatch the drain ran a barrier: it flushed the space's sessions
on the memory server and awaited an ordered response on the serving
connection. Under the read-through, that connection carries no frames for
the space, so the response brought the replica nothing. The entry deferred to
a rescan, and the next cycle's feed refresh brought the view current.

With the drain, the feed and the refresh logged, against `c416f1336`:

- One run caught the drain reading an entry at 31:08.604 and the feed's
  notice for that commit arriving at 31:08.606.
- The barrier then took 870 ms and found the view unchanged.
- Each run logged four to nine such mismatches. The barrier recovered none
  of them, and each cost 0.3 to 1.6 s of the drain's time, which the serving
  loop awaits ahead of its settle.

Under the read-through, the drain now reads the entries document from the
store into the replica (`0ed69db50`), with nothing to wait for. The ordered
response stays for a replica that reads over its session.

## The benchmark's stalls

On `c416f1336` the send benchmark ended in a `waitForRows` timeout after
120 s in four of six uninstrumented runs on the flag arm. Every stalled run
had logged view-lag deferrals.

The deferrals were not what held the burst. In the run read closely, twelve
deferrals each named a different event, and none repeated: every lag
resolved. After the last one, the server logged nothing until the timeout.

Instrumented, the burst did not stall: three runs with the scheduler's
deferred settle and three with it switched off all completed, with four to
nine lags each. What stalls a burst after its lags resolve is not
established.

With `0ed69db50`, every run completed, and none logged a lag:

| Burst, flag arm | `c416f1336` | `0ed69db50` | Loop off |
| --- | --- | --- | --- |
| Chat send 4x2 | 4.6 s, 4.9 s, stalled four times | 4.4 s, 4.4 s, 5.1 s, 3.8 s | 2.3 to 3.0 s |
| Vote 5x5 | 3.7 to 3.9 s | 3.5 to 3.6 s | 3.7 s |

Two of the four chat runs with the change also carried the prefetch below.
No run stalled with the change, and the burst still reads slower than the loop
off. The stalls stopped with the change; that does not show the change ended
them. What held the stalled bursts is not established, and every run here was
on the read-through arm. A serving replica without the read-through, which is
the default on either thread, reads over its session and still runs the
barrier the read-through replaced.

## Tried and dropped: prefetching a parked head's queue

When a head event parks on its loads, the events queued behind it start
their own loads only on reaching the head, and then park in turn. The
attempt preflighted the dependencies of every queued event at the moment
the head parked, so their cold loads would start together. Nothing moved:

| Measure | Without | With |
| --- | ---: | ---: |
| Probe parks per round | 43.3 | 44.5 |
| Chat burst | 4.9 s | 5.3 s |
| Vote burst | 3.8 s, 3.9 s | 3.7 s, 3.6 s |

In each chat pair, the second run of each arm stalled. The parks were not
waiting on loads that the queued events would have started earlier, so the
change was dropped.

## Topics with view-scoped replication on

With the flag on, the browser runs none of the Topics derivations, so the
navigation benchmark's comment and backlink segments failed two of its
guards. Under server execution, both segments now declare `mayRunNothing`
on their timed samples and write no read-accounted sample, since that
sample attributes the browser's reads to derivations the browser does not
run (`BENCHMARKS.md`).

On `0ed69db50`:

| Segment | Loop off | Flag arm |
| --- | ---: | ---: |
| load | 573 ms | 577 ms |
| sign in | 877 ms | 682 ms |
| board | 4.4 s | 3.3 s |
| open topic | 1.1 s | 902 ms |
| crossref | 860 ms | 498 ms |
| journey | 8.0 s | 5.8 s |
| comment | 484 ms | 755 ms |
| backlink | 988 ms | 802 ms |

Every segment reads faster with the flag on except `load`, which is even,
and `comment`. With the flag
on, a comment's derivations run on the server, so the page waits for a wave
and its frame where the browser would otherwise have derived them itself.

## A review's fixes

A review of the work since `cecf1e447` raised four points.

**The send.** A send inside a transaction appended its event from a commit
callback, a hook whose contract forbids external effects. The append now
runs from the transaction's post-commit outbox, which flushes at the
commit's verdict and only on success, so it no longer waits for view
coverage. The commit callback keeps only the in-memory compensation, which
retires the echo of an attempt that did not commit.

The scheduler's lineage gate already decides commit-or-drop for the local
echo. It cannot carry the append, because a client that runs nothing of the
piece drops its echo at dispatch, while the append has to happen all the
same. `events.md` now states this rule as its own, extending the one
scheduler-v2's I10 states for a handler attempt's launches.

**The deferral's owner.** The deferred settle depends on some later pass
running it. Every way a park ends now goes through one method that queues
that pass: a release, a failed load, or a drop. A test pins the failed-load
ending, as one already pinned the drop.

**What the deferral trades.** The comment beside the deferral said the
serving loop keeps cycling while a parked head's loads are in flight. It
does not: the scheduler is not idle while a head is parked, so a cycle's
settle waits until the park ends or the deadline cuts it. A cut that comes
first commits the handlers' writes a wave ahead of the derivations over
them.

That is the flush deadline's existing trade (`serving-loop.md` §3), taken
whenever a park outlasts the deadline. It is accepted for this arc as the
batching's price, a user-visible choice the owner has yet to ratify, and
stated in `events.md` §2:

- W does not cover those inputs until the derivations land.
- A member that runs nothing of the piece shows the consequence a wave
  before the derived view.

**The barrier's read.** A read from the store that throws inside the barrier
now defers the entry to its rescan, as a failed response does, rather than
aborting the drain.

Measured after these changes, interleaved:

| Burst | Flag arm | Loop off |
| --- | ---: | ---: |
| Chat send | 4.2 s, 4.3 s | 3.0 s |
| Vote | 3.5 s | 3.8 s |

No run logged a view lag.

## What remains

- **The chat burst against the loop off.** It completes now, but reads 3.8
  to 5.1 s against 3.0 s. Three costs are visible:
  - the head parks, whose slow tail waits on other spaces' documents;
  - the room's long settle on the worker, which every space shares;
  - the main thread's flush refreshes: 11 to 29 passes per burst at 83 to
    220 ms each on the flag arm, across ten probe captures, against 13 at
    about 62 ms with the loop off.
- **The Topics comment segment**, 755 ms with the flag on against 484 ms
  with the loop off.
- **The vote burst**, about even with the loop off.
- **The benchmark's stalls on `c416f1336`.** What held those bursts after
  their view lags resolved is not established. They did not recur under
  instrumentation, or with `0ed69db50`, and both statements are about the
  read-through arm. A serving replica without the read-through, the default,
  still runs the barrier. Counting runs of the benchmark without it, or
  finding whether `#armDeferredRescan` armed and fired after a stalled run's
  last deferral, would settle which.
- **A removal that should have helped and did not.** Stopping the room's run
  in the space that created it removed every refusal and made the send burst
  slower ([chat record](2026-10-22-served-chat-burst-and-the-deferred-settle.md)).
  Every lever named here is chosen from a model of where the burst's time
  goes, and that result says the model is wrong somewhere.
