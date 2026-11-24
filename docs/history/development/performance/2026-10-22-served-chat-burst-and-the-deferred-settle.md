---
status: historical
created: 2026-10-22
archived: 2026-10-22
reason: "The FabriChat send burst under view-scoped replication: a fire inside a transaction appends when that transaction commits, the serving pass's deferred settle is stranded by a drop of its parked head and counted drops as dispatches, a served consequence can reach the clients a wave ahead of the derivations that read it, and the deferral measured on the vote and chat bursts; with two removals tried and dropped, and what remains."
---

# The served chat burst: the send's transaction, and the settle a pass defers

The [batching record](2026-10-22-served-vote-batching-and-planner-reads.md)
left the serving pass taking every ready event before one settle, and
`6d9ec03f4` replaced the pass's wait for a parked head's loads with a
deferral: a pass that parks its head behind events it already ran ends
without its settle, and the pass the park's release starts settles behind
everything. This record measures the FabriChat send burst under
`EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION`, which found a fault in the send
path, two in the deferral and one in the benchmark, and reads the deferral
against both bursts. The direction is the one the arc has kept: the work a
burst costs the host first, latency for one viewer later.

## How it was measured

The benchmark is `fabrichat-send-burst.bench.ts`: four members, each a
web-class client with its view mounted, open a group room (the first member
creates it and each member's first message joins them, outside the
measurement), then each sends two messages with none of the eight settled
first. The arms are the census's: the store read-through on, the overlap
off, the flush deadline growing to a 1000 ms cap, the serving loop in the
worker, and the flag off or on; `off` is the loop off. The vote burst is
`lunch-poll-vote-burst.bench.ts` at 5x5 (`CF_LUNCH_POLL_VOTERS=5` and
`CF_LUNCH_POLL_OPTIONS=5`; the benchmark's default is 10x10) on the same arms,
and on the main thread with the flag on. Both ran on one four-core container, whose
readings move by half a second between runs of an arm, so a difference under
that is not one.

The probe, which stays uncommitted as the arc's probes do, runs the chat
benchmark's rounds and reads every member's message count after the joins and
after the burst. On a short count it dumps what each member holds, the serving
loop's counters, the commits the memory server admitted during each join, and
the view of a fresh session with the creator's identity that runs the room
itself. Temporary prints at the send, the drain, the dispatch, the handler's
commit and the load park traced single events; none of them is committed.

## A fire inside a transaction appends when that transaction commits

Under the flag every joining member's first message landed twice.
`editWithRetry` aborts an attempt whose read found a document absent that
turns out to be present, and runs its callback again, and a client under
server execution appended the event the moment the stream send ran, so both
attempts appended, each under its own id. A fire made inside a transaction is
work that transaction launched (scheduler-v2 I10): its append now waits for
the transaction to commit, and a transaction that fails or is aborted drops
it ([`cell.ts`](../../../../packages/runner/src/cell.ts)). Cubic's review of
`6d9ec03f4` found the first version appending at once through a transaction
whose commit was already in flight; `15bef7b4d` reads the transaction's state
the way the speculation lineage does, so such a fire waits on that commit,
one through a transaction that already committed appends at once, and one
through a transaction that already failed is refused.
`stream-send-origin-transaction.test.ts` pins every case, and its in-flight
and failed cases fail against the first version.

CI's run of the topic board seed test under server execution found what
both versions still did: they tracked the event's intent when the send ran,
and reported it refused when the transaction did not commit.
`PieceController.edit()` sends every attempt under one caller event id, so an
attempt `editWithRetry` aborted and ran again was reported refused before it
fired, and the seed, which fails on any refused intent, failed. It exited
with status 0 even so, since the rejection reaches the SES lockdown's
unhandled-rejection handler, and the test saw only a missing fixture file.
`76b9a7183` makes the fire happen at the commit: the intent is tracked, the
event appended and the pending commit registered then. A transaction that
does not commit fires nothing and signals nothing, and the echo its local
run left on the overlay is retired without a terminal outcome, so a later
fire of the same id keeps its echo.

## A drop of the parked head stranded the deferred settle

At the flush deadline the serving loop purges the in-process copies of
cascade events that have not run, which the next drain delivers again from
their durable entries. When the purged copy was the parked head, the drop
cleared the park without queueing a pass, and the park's release, finding no
park, returned without one. The settle the pass had deferred then waited for
new input. The probe showed it as every member holding three joins after
three extra settles while the fresh session, which derives the room itself,
read four: the room's derived messages document had not been rewritten after
the last join. In one probe run the serving loop purged 100 such copies and
parked a head 301 times. A drop that takes the parked head off the queue now
queues the pass the release would have
([`facade.ts`](../../../../packages/runner/src/scheduler/facade.ts),
`#dropEvent`). A new case in `scheduler-serving-event-batch.test.ts` purges a
parked head under a waiter parked before the purge, as the serving loop's
settle is, and fails with Deno's pending-promise error without the change.

Cubic's review of `6d9ec03f4` found two more faults in the deferral, both
fixed in `15bef7b4d`. The event phases counted a head that left the queue as
dispatched, so a head dropped without running could defer the settle behind
a parked one; the phases now count the handlers they start, and a case in the
same test file fails against the old count. And a pass that defers its settle
left the scheduler's rerun request latched, which queued a pass behind the
release's own; it is consumed there.

## A consequence can reach the clients a wave ahead of its derivations

With the stranded settle fixed, the probe still found rounds in which every
member held a message fewer than the fresh session, and an extra settle
brought it. The commits admitted during the last join showed why: the
handler's commit, six writes, went out in one wave, and the derivations that
read it, the room's derived messages among them, in the next. A wave the
flush deadline cuts between them does this, and the deferral, which holds the
settle behind a parked head across such a cut, gives the cut more to land
between: with the fixes in place it happened in one of six probe rounds with
the deferral on and one of 23 with it off. The harness's settle
waits for every event's first-order consequence, which is the handler's
commit. A member with the flag on runs nothing of the room itself, so what
it shows is the server's derived documents, a wave behind until the next one
arrives.

The benchmark's measured burst now ends when every member's own view of the
room's newest messages holds every message, as the vote benchmark's ends on
every voter's own rows (`waitForRows`); the joins are waited for the same way
before the check that follows them, and the consequences and the settle
follow outside the measured interval. The burst's numbers below are on that
end. What a member with the flag on shows in the window between its event's
consequence and the derivations was not looked at.

The window is not only a benchmark's: a member with the flag on shows the
consequence a wave before the derived view, so a chat member's message count
reads one short until that wave arrives. It is the flush deadline's trade, by
which a consequence is visible while the wave behind it keeps deriving
(`serving-loop.md` §3), and the deferral takes it whenever a park outlasts the
deadline, where settling at every park would derive once per parked event.
It is accepted for that batching, and stated beside the deferral in
`events.md` §2. W does not cover those inputs until the derivations land, so
a wait on it, as `cf get` makes, does not end on the handlers' commit alone;
and nothing a member shows is withdrawn, only late by a wave.

## The deferral, measured

| One burst | Loop off | Flag on, deferral | Flag on, no deferral |
| --- | ---: | ---: | ---: |
| Vote `5x5`, worker | 4.3 s | 3.8 s, 3.9 s | 6.3 s, 6.4 s |
| Vote `5x5`, main thread | 4.3 s | 3.4 s | 8.2 s |
| Send `4x2`, worker | 3.1 s | 3.6 s | 9.2 s |

The deferral holds most of the batching on both workloads, because both park
often: the vote burst parks every vote once on the loads its own cold reads
start, 25 parks a burst, and in the chat burst every room space parked about
2.4 times per event, almost all of them durable events parked on the room
space's own documents. Without the deferral each park ends the batch with a
settle. Restricting the deferral to a parked head that is a durable drained
event, not an in-process cascade copy, read 3.9 s on the send burst, no
different from deferring behind every parked head.

With the deferral and these fixes, the vote burst with the flag on reads
faster than with the loop off on the main thread, by more than the half
second this container's readings vary by, and about the same in the worker,
within it. The send burst reads half a second slower than the loop off.

## Two removals tried and dropped

**Stopping a room's run in the space that created it.** The manager's handler
creates each room in a space of its own and runs the room's pattern inline,
so the creator's serving runtime runs the room's graph, and every write its
derivations make into the room's space is refused at accumulation for want of
delegated carriage: 784 refusals in one run of the worker arm with the flag
on, with the scheduler's non-settling backoff on top. The room's own space
runs the same graph and its writes land. Stopping the room's local run once
the creating commit had landed removed every refusal and made the send burst
slower, 4.9 s with the deferral and 4.5 s with the durable-only rule against
3.6 and 3.9 s, and one arm without the deferral failed its room setup. Dropped;
the refusals stay a cost the record names.

**No pending load for a load the store read-through answers.** A serving
runtime's loads of its own space are answered by the store read-through
before the load's first await returns, yet the load is registered as pending
until those awaits finish, and that registration is what the preflight parks
on. Registering nothing for them made the vote burst slower, 5.4 s against
3.8 s, with 143 handler commits refused as inconsistent in one run: the park
keeps a handler from running until the read's integration and what it
notifies have run. Dropped.

## What remains

The send burst is half a second behind the loop off with the flag on. In
order of what the measurements point at: the creator's space running every
room's graph only to have its writes refused; and the parks themselves,
about 2.4 per chat event and one per vote, each costing a pass. The window in
which a flag-on member's event is consequenced and its derived view is not is
the accepted trade the section above describes, not an item here.
In one of the six probe rounds run with the flag, the deferral and these
fixes, the server's message list itself lacked the room creator's first
message, and the serving loop logged no drop and no spent deferral budget for
it. That symptom, one message short in the server's own list, was not seen in
the 39 rounds run since, with the deferral off or the flag off, and is not
explained. It is a different observation from a burst whose eight
consequences are marked with no derived write yet: the probe read the list
once after the consequences and a settle, so it cannot say whether that
message was lost or late.
