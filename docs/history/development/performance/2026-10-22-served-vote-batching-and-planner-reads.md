---
status: historical
created: 2026-10-22
archived: 2026-10-22
reason: "The served vote burst after the deadline cap and view-scoped replication's first two changes: the serving pass runs every ready event before one derivation pass, a grown delivery extends a session's support graph in place, the committed documents reach the sessions before the planner walks, and the planner's reads shed three repeated costs and keep what they found at each cell between walks; measured on the census probe, the CPU profiler and the benchmark, with what remains."
---

# The served vote: batching the pass, and what the planner's reads still cost

The [view-scoped record](2026-10-22-view-scoped-replication-vote-burst.md)
left the served vote burst at 9.1 s on the main thread and 5.4 s in the
worker with `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION` on, against 4.8 s and
4.7 s with it off, and named what was left: a plan per session per wave, the
renderer-schema walk the planner and the memory server both make, and a
manifest on every frame. This record lands the changes that followed, in the
order they were measured, and reads each against the census probe, the V8
sampling profiler, and the benchmark. The direction throughout is the work a
burst costs the host, taken out where it repeats; latency for one viewer is
traded later where it pays.

## How it was measured

The census probe hosts the vote-burst benchmark's harness with every realm's
timing measures drained around one burst of 25 votes (five voters, five
options), each voter a web-class client with its view mounted. The arms are
the census's: the store read-through on, the overlap off, the flush deadline
growing to a 1000 ms cap, the serving loop on the main thread (`main-cap`) or
in the worker (`worker-cap`), each with the flag off or on (`-flag`), and the
loop off (`off`). The profiler is Deno's `--cpu-prof` at a 500 µs interval over
one probe run of the main-thread flag arm, which covers the setup and two
bursts; its figures are totals over that run, so they rank costs rather than
size one burst. The benchmark is `lunch-poll-vote-burst.bench.ts` with its
default size, run as back-to-back series of arms on the same four-core
container, whose readings move by half a second between runs of one arm, so
a difference under that is not one. Every count below is one burst, the
probe's last round, unless it says otherwise.

## The serving pass runs every ready event before one derivation pass

Under the serving posture a scheduler pass took one event and then settled
every derivation it dirtied, so a wave of five votes ran the tally
derivations five times. The pass now takes every ready event the queue
holds, each handler reading what the one before it wrote, and settles once
([`facade.ts`](../../../../packages/runner/src/scheduler/facade.ts),
`#processExecuteEventPhases`). The first attempt moved nothing: the
preflight parks the head event on the loads its own cold reads start, and
every event parked in turn, so the pass still took one event per pass. A
head the preflight parks on its loads, behind events the pass already
dispatched, now ends the pass without its settle, and the pass the park's
release starts dispatches it and settles behind it. A first version waited
for the loads inside the pass instead; that held the serving loop's cycles
for as long as the loads took, which an exactly-once test of the drain's
in-flight guard showed, and was replaced before landing. The specification's
account is in
[`events.md`](../../../specs/server-side-execution/events.md) and
[`serving-loop.md`](../../../specs/server-side-execution/serving-loop.md).

| Count, one burst of 25 votes, flag off, main thread | one event per pass | every ready event |
| --- | ---: | ---: |
| Probe burst | 6.2 s | 3.3 s |
| Scheduler passes | 51 | 4 |
| Serving scheduler runs | 861 | 474 |

## A grown delivery extends the support graph in place

A planner selection that delivered what the view's current one delivered
already rode the next frame. One that only added roots — a new voter's
profile, a new vote's document — still set the full-resync flag, and the
next flush pass re-evaluated the session's whole watch set through the
renderer schema. `setViewSelection` now tells a superset delivery from a
changed one, and the refresh extends the session's support graph by the
added roots over the demand graph it keeps current, as the frame commits
([`server.ts`](../../../../packages/memory/v2/server.ts)). About 0.55 s of a
burst on the main thread was those re-evaluations.

## The committed documents reach the sessions before the planner walks

The planner ran after the wave's commit returned, which is before the memory
server's refresh turn had sent the committed documents to the sessions. On
the main thread the planner's UI walks then held the thread for every
viewing session, and the frames those documents owed waited behind them. The
serving loop now has the memory server flush the space's sessions before a
quiescent settlement plans; a settle the deadline cut plans nothing a
session already holds a selection for and keeps the refresh's own turn
([`space-server.ts`](../../../../packages/runner/src/executor/space-server.ts),
`#finishWave`). This moves no work; it orders it.

## What a plan cost, and the three costs that repeated

From a probe run with the plan's phases timed, ten plans averaged 442 ms:
the UI walk 302 ms, publishing the selection to the memory server 50 ms,
comparing with the published selection 25 ms, selecting the cone 19 ms,
reading the pieces' registration metadata 10 ms, assembling the selection
8 ms, installing the caches 5 ms, the producer ancestry 2.5 ms. The walk was
600 cell reads at 0.3 to 0.4 ms each.

The profiler put 12.0 s of the run's 62 s of main-thread CPU in the
planner, 8.7 s of it in the walk, and three repeated costs stood out, two
inside a cell read and one in the comparisons around the plan, none of them
the read itself:

1. **The view-reference hash.** Each read keys the transaction's read cache
   by a hash of the cell's link and label view, and the link carries the
   renderer schema, so each fresh cell hashed the whole schema: 1.3 s of
   the walk. The interned schema's own hash stands in for it now
   ([`cell.ts`](../../../../packages/runner/src/cell.ts), `#viewRefHash`).
2. **A refusal rebuilt per read.** A read of a cell not yet synced starts a
   load, whose selector is externalized by decomposing its schema. The
   renderer schema declares a `$id`, a resource scope the decomposer refuses
   for structural reasons (its root `$defs` it supports), and it built a new
   error, stack trace included, for every read: 0.45 s. A structural refusal is kept per interned schema
   ([`schema-decompose.ts`](../../../../packages/runner/src/schema-decompose.ts)).
3. **Equality by hashing.** The planner compared a new selection with the
   published one, and the memory server a new delivery with the current one,
   with `valueEqual`, which hashes both operands whole: 1.1 s. Both walk the
   operands in step now and stop at the first difference.

| Per plan, main thread, flag on | before | after |
| --- | ---: | ---: |
| Plan | 442 ms | 387–427 ms |
| UI walk | 302 ms | 261–273 ms |

The run's planner CPU fell from 12.0 s to 6.4 s with the next change; these
three were worth about a quarter of it on their own.

## The walk keeps what it found at each visible cell

The walk's whole result was cached under the view's identity and invalidated
by the scheduler's read matching, and every vote changed values the UI
shows, so the cache held for nothing within a burst and the walk read all
600 cells again. Each visible cell is now read in a transaction of its own,
and what the walk found there — its own reads, the bindings and handlers it
declared, and the cells its node holds — is kept per view in a memo indexed
the way the whole-walk cache was. A walk after a change reads only the cells
whose documents changed and takes the rest from the last walk
([`view-render-reads.ts`](../../../../packages/runner/src/view-render-reads.ts)).
The walk reports a document two cells read once rather than sorting its
whole read list, which its consumers do for themselves; the sort had been a
third of the walk's time outside the reads.

| Per plan, main thread, flag on, one burst | before | after |
| --- | ---: | ---: |
| Plan | 387–427 ms | 220–266 ms |
| UI walk | 261–273 ms | 134–161 ms |
| Cell reads per walk | 765 | 354 |

A vote burst still invalidates more than half the cells, because the tally
rows, the voter lists and the per-option counts all show the votes. The
profiler's planner total over a run fell from 12.0 s to 6.4 s, the walk's
from 8.7 s to 4.4 s. What the walk reads now is dominated by the reads
themselves, at 0.4 ms each.

The memory server parsed every query doc key its graphs hold on every
refresh of every session; the parse is kept by key
([`query.ts`](../../../../packages/memory/v2/query.ts)).

## The benchmark

Three series, each a back-to-back run of arms, each arm the benchmark's
three iterations after its warm-up. The first series precedes the ordering
and read changes, the second follows them, the third follows the memo.

| `vote burst 5x5`, average | off | main-cap | worker-cap | main-cap-flag | worker-cap-flag |
| --- | ---: | ---: | ---: | ---: | ---: |
| Series 1 | 3.8 s, 4.3 s | 3.7 s | 3.8 s | 5.6 s | 4.0 s |
| Series 2 | 3.9 s, 4.3 s | — | 5.3 s | 6.0 s | 4.4 s, 4.0 s |
| Series 3 | 4.2 s, 4.0 s | — | 5.6 s | 5.8 s | 3.7 s, 4.2 s |

The worker arm with the flag on reads level with the loop off, and under it
in the third series' first run; the main-thread arm with the flag on does
not. The probe says why. In the worker, the planner runs off the main
thread, and the frames-first ordering keeps it off the sessions' path, so
what the bench sees of it is the next burst's first wave waiting for the
previous burst's plans. On the main thread, the plans are 1.1 to 1.3 s of
thread time per burst after the memo (five plans at 220 to 266 ms), and the
memory server's refresh batches carry about 0.3 s more than with the flag
off: the `tracked` phase that rebuilds each session's demand entities and
ids, and the frames that carry a 320,000-character plan to each session.
The probe's bursts put the arms in the same order: on one capture, 4.3 s
with the loop off, 4.5 s on the main thread with the flag off, 7.1 s then
3.9 s with it on, and 2.8 s in the worker with it on.

## What remains

1. **The plan's size.** A plan carries 548 delivery roots, the same 548 as
   inputs, and 1,058 producer bases, about 320,000 characters, to each of
   five sessions at each quiescent settlement. Encoding one is a few
   milliseconds; the memory server's codec walk, the client's decode, and
   the client's re-application of an unchanged plan are what it costs.
   Grouping bases by document, dropping the inputs the roots already name,
   and sending the producers whose bases changed would each take a share.
2. **A plan per session.** Five sessions viewing one piece plan five times
   over the same snapshot. Their UI walks differ only where the UI reads a
   user- or session-scoped document, and the lunch poll's does, so the walks
   cannot be shared blindly; the cone and the ancestry are shared already.
3. **The planning tail on the main thread.** With the frames first, the
   planner's thread time delays the next burst rather than this one's
   frames. The worker arm is the one that serves the burst at parity.
4. **The refresh batch under the flag.** `#viewDemandIds` runs before and
   after each touched session's refresh and `#entriesFromGraphs` rebuilds
   the demand entities each time, about 0.3 s a burst over five sessions.

## Validation

`deno fmt`, `deno lint` and `deno check` on every changed file. The scheduler
suite's new batching test pins the serving posture's one derivation pass
over three events and the non-serving posture's one per event; the memory
view-interest suite pins the plan over an unchanged delivery, the extension
for a grown one, and the re-evaluation for a shrunk one; the planner suite
pins the cut-wave plan, the re-walk at quiescence and the shared cone; the
render-walk suite pins the memo, which after one leaf changes walks the
changed cell and the node holding it and reads what a fresh walk reads; the
decomposer suite pins the kept refusal. The view replication client, flags,
serving-loop, space-server and settle-advance suites pass, except one
lifecycle step (a piece's source identity awaited before its graph installs)
and one scheduler-core step that fail on this branch with and without these
changes. The probe stays uncommitted, as the records' probes do.
