# The serving loop off the request thread

The serving loop runs inside the toolshed process, on the same thread as the
memory server's frame handling and the HTTP routes. A wave's settle step is a
run of synchronous scheduler actions, so while it runs every client round trip
to that toolshed waits: a schema watch add measured at 53 ms with the loop
absent costs 263 ms with it present, and a client that waits on nothing the
server computes is still paced by the server through the latency of each
message
([the 2026-10-11 record](../history/development/performance/2026-10-11-server-execution-send-wait-and-session-fan-out.md)).
[`serving-loop.md`](../specs/server-side-execution/serving-loop.md) §1 draws
the `ExecutorHost` inside the toolshed process and leaves its thread unsaid;
[the README](../specs/server-side-execution/README.md) §3.8 asks for per-space
budgets, and the one that exists is the 100 ms flush deadline, a timer that
cannot cut a synchronous action.

This plan moves the host, and with it every serving runtime, into a Web Worker
of the toolshed process. The memory server, the routes, and the store's one
writer stay on the main thread. The worker reads the store through its own
SQLite connections and reaches the server for everything else over a
`MessagePort`.

## What crosses the boundary, and what does not

The host touches the memory server and the store at a bounded set of points.
Each is placed below; the placement is the design.

**Reads of the store stay reads, on the worker's own connection.** The loop
reads `serverSeq`, the pending stream-event documents, commits since a sequence,
document heads, retirable effect instances, and, under the store read-through
posture, documents, all through `Engine.*` on an engine object. The wave commit
sink's reads run there too: the heads a rebase decides on, the paths written
since a sequence, an intrusion, and the paths the session that fired an event
overwrote. Every one of those is a SQLite query; the engine's decoded-document
cache is keyed by revision identity, and its branch-head cache is dropped
whenever the connection's data version shows another connection's commit, so a
second connection to the same WAL-mode file reads every committed revision and
serves nothing stale. The worker opens one engine per space it serves,
read-through included, at the file the main thread names once it has opened the
space itself, so the server's own engine map holds every space the worker
serves, which its synchronous lease scan reads. A store that is not a file
cannot be shared this way, so the worker needs a file store. Three writes stay
on the worker's connection, each small and serialized by SQLite's lock with the
engine's 5 s busy timeout: the lease rows the loop writes
(`execution-lease.ts`), which the main thread's admission reads from SQLite each
time; the outbox's retirement of a delivered row; and the outbox's failure
notice for an append the target refused, a derived commit of the loop's own that
the server does not fan out whichever thread writes it. The busy timeout covers
a transaction that takes the write lock up front, so every transaction the
engine opens is immediate, the schema's and the migrations' at open included: a
deferred one that reads first and writes after fails at once, rather than
waiting, when the other connection committed in between. The owner a space's
access list names is read the same way, through `resolveSpaceOwnerOf` on the
worker's engine.

**Wave commits cross to the main thread.** `EngineWaveCommitSink` applies a
wave's one derived commit inside the engine transaction that also writes its
basis rows, re-verifies its documents, attaches the wave's sqlite cell databases
through the memory server, and reports the commit to the server
(`noteExecutorCommit`) for dirtiness and fan-out. On the main thread the sink
reports the commit itself, as it applies it, and the worker's loop reports
nothing for it: a notice posted by the worker once the reply reached it would
let the server's fan-out of the wave's rows fall behind the loop's next step,
which in-process follows the apply synchronously. Every commit the server fans
out is applied on the main thread, where the server sees each one land: the
worker sends the `WaveSpaceCommit` (data throughout: operations, preconditions,
confirmed reads, annotations, basis rows, consequence ids, delegated carriage,
outbox appends) in the memory boundary's encoding, and the main thread applies
it through a sink of its own per session, returning the result. The counter that
keys the session's commits stays with the worker, because the outbox's own
writes draw from the same counter under the same session: each commit crosses
with the number the worker minted for it, and the main thread's sink is handed
that number. The served-ACL-change commit crosses the same way, as the list of
changes it applies; the main thread rebuilds the function from the list.

**The serving runtime's storage plane crosses as frames.** The serving runtime's
`StorageManager` connects to the memory server through `LoopbackStorageManager`,
a `Transport` that hands frames to `Server.connect()` in-process. The worker
uses the same manager over a `Transport` that posts each frame on the port; the
main thread owns one `Server.connect()` per worker-side transport and posts the
server's frames back. The port's transport is the in-process one's pump
(`queuedFrameTransport` in the memory client) over the port: a server frame
reaches the client on a turn of its own, frames held at close are dropped, and
`delivered()` waits for the frames held. The client holds to that discipline,
a session's deferred self-revocation among the things that depend on a frame
staged at close going nowhere, so a transport over the port keeps it. A send
over the port settles once the main thread has handled it, after the frames
that handling sent, so a session's revocation that follows a commit's verdict
can arrive while the commit is still outstanding: the client keeps the verdict
as it arrives and settles the commit with it. The protocol, the signed
`session.open`, and the service principal are unchanged, which is what keeps
the read-row admission's holder matching intact.

**The server's observer crosses as events, its queries as requests.** The main
thread installs the `ServerExecutionObserver` and forwards `commitAdmitted`,
`sessionOpened`, `demandChanged`, `viewsChanged` and `sessionChanged` to the
worker. The last is
the session registry's own lifecycle, an open, a detach with its expiry, or a
removal, replayed in full when the observer is installed; the worker keeps a
mirror from it and serves the three lookups the loop makes without waiting,
`hasLiveSessionsForSpace`, `hasLiveSessionFor` and `sessionReadCeiling`, as the
registry would. The worker asks the main thread for `demandForSessions`,
`viewInterestsForSpace`, `setViewSelection`, `foreignWriteAuthorityFor`,
`checkServedAclChange`, `commitDelegatedAppend`, `idle` and `flushSessions`, and
tells it of `noteExecutorCommit` and `noteLeaseReacquired` without waiting. The
demand set crosses as shares per session, read once and kept on the worker
(`DemandShareCache`) until the server's `demandChanged` names that session
again, so a demand pass hands the space server's mirror the objects it compared
last time and asks the server only for the sessions whose shares are stale or
not yet cached. The view interests cross the same way (`ViewInterestCache`):
read once per space and held until the server's `viewsChanged`, sent for a
watch set that carried views, or its `sessionChanged`, which is what attaches,
detaches or removes a viewing session, names the space, and dropped once the
space has no session left; a selection the worker installs updates the held
interest's generation itself.
A publish over unchanged interests then asks the server nothing, where the
request alone waited for the server's thread's turn, however empty the list.

**Lifecycle verbs run in the worker, from a descriptor.** The route sends a
verb as its name and its request, on either arm, and whichever thread runs the
loop builds the verb's closures over a `PiecesController` from the same
functions in `@commonfabric/piece`'s served lifecycle. The receipt comes back
as data.

**Stats cross on every cycle.** The worker posts the host's `ServingLoopStats`
at the end of each wave cycle, at each activation and park, and on request;
the main thread registers a stats provider that returns the latest copy, so
`/api/health/stats` keeps its shape and waits on nothing. The loop's own
logger counts and timing statistics are the worker realm's, so they cross on
request (`ServingLoopHandle.diagnostics()`), and a request waits for the
worker's turn: `/api/health/serving-loop-realm` is the route that asks, kept
apart from `stats` so that a worker in a long settle, or one that is hung,
delays only the caller who asked for its loggers. A test that reads a refusal
the loop's own CFC gate logged asks the handle rather than its own process's
loggers.

**The main thread holds two things on the worker's behalf.** The ambient
server-execution flag, which the memory server's admission of derived
commits reads and which the host claims in its own realm, is claimed by the
bridge for the server's realm while it serves. The serving-loop stats
provider the health route reads is the bridge's, returning the counters the
worker last posted. The pattern environment a served handler's `fetch`
resolves against is the worker realm's own, set from the address the worker is
started with, as the process sets its own from the same address.

**The lease holder's process component is minted per worker start.** The
holder a space's lease and derived commits name is the service identity plus
a component the process mints once. With the loop in a worker, the main
thread mints the component as it starts each worker and both realms adopt it
(`adoptProcessInstanceId`): the server's synchronous lease scan then matches
the rows the worker writes, and a worker started in place of one that died
carries a fresh component, so its commits never meet its predecessor's under
the engine's replay keying, which keys on the holder and the counter.

**The runtime's other needs are already remote.** Pattern sources come from
`/api/patterns` over HTTP, which the main thread answers; the compiled-module
byte cache is per worker; external effects (`fetch`, LLM calls, the outbox)
run where the runtime runs. A Worker started without a permission descriptor
inherits the process's permissions, FFI for SQLite included.

## Ordering and failure

The port is one ordered channel each way. A frame the server sent before
answering an `idle()` request arrives at the worker's transport before the
answer, which is what the settle loop's frame-delivery coupling relies on; the
same holds for a `commitAdmitted` event that follows a wave commit's result,
and for the session event that precedes the `sessionOpened` it describes. A
message posted to a worker before its listener exists is dropped, so the
worker's entry posts a ready notice first and the main thread sends nothing,
the host's options included, until it has arrived.

A wave commit is in flight for a port round trip, and the serving runtime's
scheduler keeps running through it, so a seal that opens the next wave during
the flight is routine where in-process it was a rarity: that wave takes its
basis from the worker's connection before the commit has landed, and every
document the commit wrote would then count as conflicting for it, dropping
the loop's bookkeeping and the derivations that read it wave after wave. The
space server notes each landed home commit to the wave open at the time
(`noteOwnWaveCommit`), and the wave rebases a write to a document sitting
exactly at that commit's seq to that head, which the sink re-verifies, in
place of the conflict. The wave's contributions read the replica with the
commit's writes applied, so the rebase claims nothing they did not see.

That is also what lets the loop overlap the flight with its next cycle. Under
`SpaceServerPolicy.overlapWaveCommit` (`SERVER_EXECUTION_OVERLAP_COMMIT`), a
cycle leaves its commit in flight and ends at its publish. When nothing but
the loop's own echoes arrived meanwhile, the cycle finishes the commit before
it ends, so a quiet space runs the cycles it runs with the commit inline;
otherwise the next cycle drains and settles over it and finishes it inside
that settle, after the settle's first completed step or after the deadline
cuts it, and before the cycle computes its own advance: the
watermark, the derived tail and the open wave's note of the landed commit are
then all current when the successor decides its commit. An event the finish
requeues is drained again there, so its re-run joins the runs the rollback
re-armed in the same wave. A write the sink refused rolls back while the successor's
settle is still open, which re-runs what read it, and the settle is probed
again rather than ended. A cycle that ran a lifecycle verb commits inline,
because the verb's receipt reads the outcome. The port round trip then costs
the loop only what the next drain and settle do not cover, which
`executor/wave/commit-wait` reports against `executor/wave/commit`.

A worker that dies takes every serving runtime with it. The main thread's
bridge treats its exit as a park of every space with the failure-park backoff
the host already applies. A rejected worker initialization enters the same
recovery path. Once the dead worker is gone, the main thread releases the lease rows
its holder held in every space it opened: a host leaves a space parked on
another holder's live lease rather than contending for it, so a successor
that waited out the rows' TTL would also wait for the next session, event,
or demand change to activate the space. Replacement waits for both the backoff
and teardown/lease release, then starts under a fresh holder unless the host
has closed. With the rows released, the successor acquires them as it activates,
which is the recovery
`serving-loop.md` §6 specifies for a lost tenure. A main thread that closes
closes the port, and the worker's host closes as it does today.

## What does not change

What the loop computes does not change: the demand pass, the outbox, the
lease, the sink and the protocol keep their meaning. The wave and the cycle
take the two additions above, the rebase of a write over the loop's own
landed commit and, under its flag, the overlapped commit, and the demand pass
awaits its rows, which a worker reads across the port. What changes otherwise
is who holds the engine object the loop reads, which thread the sink runs
on, and how the host reaches the server. The in-process arrangement stays
available: it is what every existing test runs, and the flag below selects
between the two.

## Stages

1. [x] **The serving plane as an interface.** The host and the space server
   take a `HostMemoryServer` in place of the memory server: the methods listed
   above, the engine opener, and the wave commit sink factory. The in-process
   server satisfies it as it is and behaves as today. No behavior changes;
   the existing executor tests pass unchanged.
2. [x] **The port protocol.** A worker-side `ServingPlane`
   (`serving-port-plane.ts`) over a port and the main-thread
   `ServingPortBridge` (`serving-port-bridge.ts`) that serves it, on the
   framing `serving-port-protocol.ts` defines: requests and replies with ids,
   observer events, loopback frames multiplexed by transport id, wave commits
   applied through a main-thread sink, stats relay. `serving-worker.ts` is the
   worker entry and `ServingWorker` (`serving-worker-host.ts`) starts one and
   replaces one that dies. A unit test runs a host in a Worker against a
   file-backed memory server and settles an authored commit through it.
3. [x] **Toolshed wiring under `SERVER_EXECUTION_WORKER`.** The bootstrap
   (`runtime/toolshed/lib/server-execution.ts`) starts a `ServingWorker`
   over the toolshed's own entry (`lib/serving-worker.ts`) when the variable
   is `true`, the in-process host otherwise, and hands the routes a
   `ServingLoop` either way; the pattern-lifecycle verbs cross as the
   descriptors `@commonfabric/piece`'s `served-lifecycle-verbs.ts` names on
   both paths; the health route reads the relayed stats through the
   provider the bridge registers. The flag is registered in
   [`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md).
4. [x] **The ON-arm suites under the worker.** The serving memory server
   tests build (`serving-memory-server.deno.ts`) runs its loop in a worker
   over a temporary file store when `SERVER_EXECUTION_WORKER` is `true`, and
   refuses the closures a worker cannot take, so a test that hands the loop
   one says `worker: false`. Under that variable, the suites built on it
   pass: its own, the watermark and reviewed-send tests, the CLI's
   agent-connections test, and the pattern integration tests the
   `MultiRuntimeHarness` drives, with one open exception. The private-inbox
   test, whose pieces span several spaces, fails or stalls under the worker
   with the basis race below closed:
   the home space's serving runtime attempts foreign scoped reads and
   foreign writes from `map` runs that in-process it never attempts, so the
   append it waits for is refused or never derives. The evidence points at
   the home runtime materializing a foreign space's derivations itself while
   that space's own loop lags behind it, which the in-process ordering never
   let happen; the cause is not yet pinned. The fabrichat room-principals
   test, where a runtime one space refuses reads a list the loop derives
   across it, fails the same way on some runs. A lane running the ON arm under
   the worker is a question for stage 6, with the default.
5. [x] **Measure.** The vote probe and the Topics seed under the worker against
   the in-process loop on the same box: client watch-add latency, the
   per-vote and per-topic client cost, and the serving loop's own wave
   timings, whose settle the worker leaves where it was and whose cycle
   gains the port round trips of its commit.
   [The 2026-10-11 record](../history/development/performance/2026-10-11-serving-loop-in-a-worker.md)
   holds the numbers, and the wave basis race the measurement exposed, which
   the ordering section above now covers.
6. [ ] **Spec and default.** `serving-loop.md` §1's component diagram names the
   worker (done); after a soak, and once stage 4's open exception is closed,
   the worker becomes the default and the in-process path goes, with the
   flag.
