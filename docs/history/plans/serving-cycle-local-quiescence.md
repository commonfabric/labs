---
status: historical
created: 2026-10-11
archived: 2026-10-11
reason: "Executed plan; stages 1–3 were built and measured, stage 4 was reverted, and stage 5 measured the flush deadline without building the proposed coalescing knob, and the record names where the remaining cost sits."
---

# The serving cycle without server round trips

The plan's initial hypothesis was that waits around derivation and commit
dominated the serving loop's cost on bursty input. That attribution was not yet
established. Over a 30-topic Topics seed the scheduler's runs amount to four to
five seconds of work, and the seed takes 60 s on the main thread and 30 s in
the worker: 378 cycles at a 118 ms median on the main thread, 84 cycles at
329 ms in the worker, with the settle alone at 102 and 133 ms
([the 2026-10-11 record](../development/performance/2026-10-11-serving-loop-in-a-worker.md)).
A client running the same program pays none of that: a node commits its
transaction and the next node runs. This plan keeps the wave as the commit
unit, which the watermark, the consequence list, exactly-once events and the
fan-out budget rest on, and removes the per-cycle waits and passes around it.

## Where a cycle's time goes

A cycle in `SpaceServer.#serveWave` drains events, runs the demanded-structure
load pass, settles the scheduler to quiescence under the 100 ms flush
deadline, commits the wave, and then runs the post-commit work before the
next cycle: the sealed contributions' settlement, the delivery reconciliation,
the view-plan publish, the outbox drain, and the demand pass.

**The settle probes quiescence through the server.** Each probe awaits the
structure load pass, the runtime's `idle()`, the memory server's `idle()`, the
storage manager's `inputSynced()` and one macrotask, and then asks whether the
scheduler is idle. The server's `idle()` is server-wide: it waits for every
connection's in-flight receives, every space's publication lock and any
scheduled refresh, and its own documentation says a sustained stream of new
work extends it indefinitely. So one space's settle is paced by every client
of every space, and under any sustained input the probe reaches the deadline
without observing quiescence, whatever the scheduler was doing. The barrier
exists because the loop's inputs reach its replica as frames pushed on its
own loopback session: the probe has to let the server push them and the
replica apply them before "idle" means anything. Under the store read-through
posture the home space's documents are read from the engine already, and the
loop is told of each admitted commit by the server's observer (the feed), so
the frames are a second delivery of what the loop can read for itself.

**The demand pass re-asks the server every cycle.** `demandForSpace` and
`viewInterestsForSpace` return every session's rows, and the space server
compares them to its mirror. The pass cost 8 ms per cycle on the main thread
and 96 ms over the worker's port, where the rows cross as fresh objects. The
server already sends `demandChanged` when a session's demand moves; the rows
themselves do not travel with it.

**The post-commit work runs ahead of the next settle.** The outbox drain and
the view-plan publish are I/O against the server and other spaces; nothing
the next settle reads waits on them, and the next wave already opens during
the commit's round trip.

## What changes

**Quiescence is decided locally.** With read-through on for the serving
space, the settle's proof becomes: every feed record at or below the batch
head has been integrated into the replica (`integrateStoreWrites`, which
read-through already runs per record), the structure load pass is not
pending, and the scheduler is idle. No `Server.idle()`, and no frame barrier
for the home space; the loopback session keeps carrying the loop's own commit
confirmations, which settle sealed layers and are not inputs. A foreign
space's session, which still delivers that space's writes as frames, keeps
its `inputSynced()` barrier until foreign spaces read through their engines
the same way. The coverage math (`#barrierHead`, `#visibleInputHead`, prefix
coverage) keeps its meaning and gets its proof from the feed rather than the
barrier: the batch head is the highest feed record integrated when the
scheduler was last observed idle. `serving-loop.md` §3's prefix-coverage
paragraph describes the frame barrier as the mechanism and is amended to name
either; the rule it states, which sequence W may cover, does not change.

**Demand crosses as deltas.** `demandChanged` names the changed session, the
worker keeps each live session's share and re-reads only the sessions named
since its last pass, in one request, and `demandForSpace` is answered from
those shares; the in-process arm reads the server directly, as a lookup. The
view interests keep crossing as a request per publish, which the pipelined
post-commit work below takes off the cycle's critical path.

**Post-commit work pipelines.** After `commitWave` returns, the loop awaits
only what the next settle depends on: the foreign warm notices, the sealed
contributions' settlement and the delivery reconciliation. The view-plan
publish and the outbox drain start and run alongside the next cycle, each
single-flighted so a slow one is joined rather than duplicated, and a failure
in either is reported where it is reported today. (Stage 4 below records
what this measured: the next settle depends on both after all, through the
loads and the commits they issue, and the change was reverted.)

**The cadence becomes a policy, measured.** With the settle local, a wave
closes when the scheduler is idle or at the deadline, and a cycle is one
input batch. Whether nearby inputs should share a cycle beyond that is
decided by the measurements, not ahead of them: the knob is the coalescing
window between a feed arrival and the cycle it starts, and the default is
none until the numbers say otherwise.

## What does not change

The wave is the commit unit, carrying the derived writes, the consequence
list and the watermark in one derived-class commit; the §3d conflict rules;
CFC, which evaluates per action run at seal, never over the wave; the
deadline as the multi-user latency bound; the OFF arm and clients.

## Stages

1. [x] **A cycle's phases on the health route.** Timing rows for each phase
   of a cycle, and the settle's three waits apart (the runtime's idle, the
   server's idle, the frame barrier), so the baseline below is per phase and
   each stage's effect is read from the same rows. The baseline is the
   record above: cycles, settle and cycle medians, `demandPassMs`, and the
   vote burst's wave count and time.
2. [x] **Demand as deltas.** The observer event names the changed session,
   the space server's mirror (`DemandShareCache`) re-reads that session's
   rows alone and answers the pass from the mirror, both arms. The view
   interests still cross as a request per publish; stage 4 takes the publish
   off the critical path instead. Measured on the 30-topic seed under the
   worker: the demand pass's median fell from 63 ms to 60 ms, and to 31 ms
   with the store read-through on, so the pass's cost was the loads it
   issues more than the rows it reads.
3. [x] **Local quiescence under read-through.** The settle's probe over the
   feed and the scheduler for the home space, the frame barrier kept for
   foreign sessions, the spec paragraph amended. Measured on the vote burst
   under the worker with the read-through on: the settle's server-idle wait
   went from a port round trip per probe to none, and the burst's wave count
   and deadline count rose a little (40 waves, 40 at the deadline, from 38
   and 36): every settle still ends at the deadline, because what keeps a
   settle from quiescing is the scheduler's own post-event work, 150 to
   300 ms per vote, not a wait on the server.
4. [x] **Pipelined post-commit.** Built, measured, and reverted. With the
   publish and the outbox drain queued behind the commit and run alongside
   the next cycle, a worker cycle's median fell from 259 ms to 195 ms and
   the burst did not move (11.8 s from 11.6 s), while the 30-topic seed
   under the worker went from 64 s to 87 s and ended with the watermark 149
   commits behind the head instead of one: the loads the publish kicks and
   the appends the drain commits land while the next settle runs, so the
   settle's input barrier waits on the loop's own post-commit work, every
   settle reaches the deadline, no probe completes, and no cycle proves
   coverage. Either piece alone did the same (167 and 128 behind). The
   publish and the drain stay inside the cycle, after the commit.
5. [x] **Cadence and the number.** The flush deadline was measured; the
   proposed feed-coalescing knob was not built. The deadline stays at
   100 ms; the record is
   [`2026-10-11-serving-cycle-local-quiescence.md`](../development/performance/2026-10-11-serving-cycle-local-quiescence.md).
   The burst stayed an order of magnitude above the client arm, and the
   record says why the write-class split is not the next design: the order
   of magnitude is in what a vote re-derives on the serving side, not in
   how the loop waits for it or commits it.
   The plan as written: The coalescing knob, measured on the vote
   burst and the seed under both postures against the client arm: the
   burst's wave count and settled time are the target, a watch add near its
   loop-absent cost and a watermark lag of one are the constraints. If the
   burst stays an order of magnitude above the client arm, the two-tier
   write-class split `serving-loop.md` §3 records as the fallback is the next
   design, and it goes through the specification first.
