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

This plan moves the serving runtimes into Web Workers of the toolshed process,
one worker and one host per served space. The memory server, the routes, and
the store's one writer stay on the main thread. A worker reads the store
through its own SQLite connections and reaches the server for everything else
over a `MessagePort`. The sections below place each crossing for one worker;
[One worker per space](#one-worker-per-space) says how the main thread shares
the memory server among several.

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
cache is keyed by revision identity, and its branch cache holds a branch's fork
point, which never changes, and a head the branch has reached, which only moves
forward. A read at a branch's head finds its row through the `head` table, and a
read at a given sequence asks SQLite for the branch's head only when that
sequence is past the head the cache holds, so a second connection to the same
WAL-mode file reads every committed revision and serves nothing stale. The
worker opens one engine per space it serves,
read-through included, at the file the main thread names once it has opened the
space itself. A store that is not a file cannot be shared this way, so the
worker needs a file store. The lease is the memory server's map, which the
worker acquires and releases through requests over the port
(`execution-lease.ts`). The outbox's failure notice for an append the target
refused crosses the same way: the server finds the source entry and patches it
as one step, a derived commit admitted against that map, which it does not fan
out. One write stays on the worker's connection, small and
serialized by SQLite's lock with the engine's 5 s busy timeout: the outbox's
retirement of a delivered row. The busy timeout covers
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
it through a sink of its own under the sending session, returning the result.
The counter that keys the session's commits stays with the worker, because the
outbox's own writes draw from the same counter under the same session: each
commit crosses with the number the worker minted for it, and the main thread's
sink is handed that number. The served-ACL-change commit crosses the same way,
as the list of changes it applies; the main thread rebuilds the function from
the list. A foreign batch and a change to another space's list leave the worker
for that space's owner over the worker's own routed session
([owner routing](../specs/server-side-execution/serving-loop.md#2-the-lease-single-deriver-operationally), on by default), and only the
home batch and the home's changes cross the port; a host given no route sends
them across the port with the home's.

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
worker a space is placed on. The last is
the session registry's own lifecycle, an open, a detach with its expiry, or a
removal. A worker is sent a space's sessions as the server holds them when the
space is placed on it (`Server.sessionSnapshot()`), and every change after;
the worker keeps a
mirror from it and serves the three lookups the loop makes without waiting,
`hasLiveSessionsForSpace`, `hasLiveSessionFor` and `sessionReadCeiling`, as the
registry would. Each of the three is asked about the space a tenure serves, so
a worker's mirror holds its own spaces' sessions and no others. The worker asks the main thread for `demandForSessions`,
`viewInterestsForSpace`, `setViewSelection`, `foreignWriteAuthorityFor`,
`checkServedAclChange`, `commitDelegatedAppend`, `idle` and `flushSessions`, and
tells it of `noteExecutorCommit` without waiting. The
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

**Lifecycle verbs run in the worker, from a descriptor.** The toolshed's
`pattern.lifecycle` handler sends a verb as its name and its request, on
either arm, and whichever thread runs the
loop builds the verb's closures over a `PiecesController` from the same
functions in `@commonfabric/piece`'s served lifecycle. The receipt comes back
as data, a structured clone on the port, so a verb hands back plain values: a
cell read with no schema returns nested objects as proxies over the store,
which the port cannot clone.

**Stats cross on every cycle.** A worker posts its host's `ServingLoopStats`
at the end of each wave cycle, at each activation and park, and on request;
the main thread registers a stats provider that returns the workers' latest
copies taken together with the last copy of each worker that has closed
(`stats-merge.ts`), so `/api/health/stats` keeps its shape and waits on
nothing. Just ahead of each
wave commit the worker also posts its counters without the settle blocks
(`ServingLoopCounters`), which the main thread merges into that copy: the
settle series cost about as much to post as a commit. The counters post
travels on the port the commit does, whose messages the main thread handles
in order, so a client that has seen a wave's commit reads counters that
include what that wave counted before its commit, and a later full post,
never older than a counters post before it, replaces the merged counters
with everything else. The loop's own
logger counts and timing statistics are each worker realm's own, so they
cross on request (`ServingLoopHandle.diagnostics()`), each serving worker's
with those of the compile worker it starts under `compile-worker:` logger
names (`servingLoopDiagnostics()`, a snapshot read without waiting on the
compile worker), added up across the serving workers (`diagnostics-merge.ts`:
counts add, and a timing key's distribution is the mixture of the workers'
distributions), and a request waits for each serving worker's turn:
`/api/health/serving-loop-realm` is the route that asks, kept apart from
`stats` so that a worker in a long settle, or one that is hung, delays only
the caller who asked for the loggers. A worker that closes hands back what
its realm logged, which stays in the sum; one that fails takes it along. A
test that reads a refusal
the loop's own CFC gate logged asks the handle rather than its own process's
loggers.

**The main thread holds two things on the workers' behalf.** The ambient
server-execution flag, which the memory server's admission of derived
commits reads and which a host claims in its own realm, is claimed by the
pool for the server's realm for as long as it is open, whether or not a
worker runs, and by each bridge while it serves. The serving-loop stats
provider the health route reads is the pool's. The pattern environment a served handler's `fetch`
resolves against is the worker realm's own, set from the address the worker is
started with, as the process sets its own from the same address.

**The lease holder's process component is minted per worker start.** The
holder a space's lease and derived commits name is the service identity plus
a component the process mints once. With the loop in workers, the main
thread mints a component as it starts each worker. The worker's realm adopts
it (`adoptProcessInstanceId`), and the worker's loopback connections name it
to the memory server (`ServerConnectOptions.leaseHolderInstance`): the holder
the server's synchronous lease read computes for a session then is the one
that session's worker acquired under, so the server tells a space's serving
session from another worker's session of the same principal. No two workers
share a component, so a worker's commits never share a key with another's, or
with those of a predecessor that served the same space, under the engine's
replay keying, which keys on the holder and the counter.

**The runtime's other needs are already remote.** Pattern sources come from
`/api/patterns` over HTTP, which the main thread answers; the compiled-module
byte cache is per worker, and that worker's runtimes take turns at a cold compile
so that a program compiles once per worker, which with a worker per space is
once per space whose own storage closure does not hold it; the type-check,
transform and emit step of a serving runtime's compiles runs in a compile
worker the serving worker starts (`ModuleCompileWorker`), so its CPU and its
heap are off the thread that serving worker's loops run on, except for a
compile instrumented for pattern coverage or one that asks for its
transformed program, which runs on that thread; external effects (`fetch`,
LLM calls, the outbox) run where the runtime runs. A Worker started without
a permission
descriptor inherits the process's permissions, FFI for SQLite included.

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

A worker that dies takes the serving runtimes of its own spaces with it, and
no other worker's. The pool treats its exit as a park of each of those spaces
with the failure-park backoff the host already applies, counted per space. A
rejected worker initialization enters the same
recovery path. Once the dead worker is gone, the main thread releases every lease
its holder held: a host leaves a space parked on another holder's lease rather
than contending for it. A space is placed again after both the backoff and the
teardown and lease release, on a worker under a fresh holder, if it still has
something to serve and the pool has not closed. With the
leases released, the successor acquires them as it activates, which is the
recovery `serving-loop.md` §6 specifies for a lost tenure. A main thread that
closes closes each port, and each worker's host closes as it does today.

A worker that stalls is handled the same way, except that nothing waits for its
teardown, since a stalled thread may never release its lifetime lock. It posts a
heartbeat every 10 s, and the main thread kills it after six consecutive 10 s
intervals with no message of any kind from it (`serving-loop.md` §2, "The
watchdog"), counting the leases the kill releases in `lease.lost`. A commit it left
in flight reaches admission naming a holder the map no longer holds, and is
refused.

## One worker per space

`ServingWorkerPool` (`serving-worker-host.ts`) is the main thread's side of
all of the above for several workers, and
[`serving-loop.md`](../specs/server-side-execution/serving-loop.md) §1,
"Workers", is its normative statement. What it adds to one worker's
crossings:

**Placement.** The memory server takes one execution observer, so the pool
installs it and each worker's `ServingPortBridge` carries what the pool hands
it. A space is placed on a worker when it first has something to serve, by the
admission-side criteria a host applies (`admissionActivates`), or when a
lifecycle verb names it. Its events then go to that worker alone, and the
worker's host, which is the host a single worker ran, decides what to
activate. Commits admitted for a space before its worker serves are held and
handed over, in order, behind the space's sessions.

**Closing a worker.** A host reports what it holds, and the pool asks a worker
whose host holds nothing to close (`host.retire`). The port is ordered and a
request handler runs as its message is read, so the host decides after every
trigger the pool sent ahead of the request, and a host that has started
something by then stays. What the pool sends while the request is in flight
reaches a host that may have closed, so the commits among it that would start
a tenure are kept for the space's next placement, and a lifecycle verb waits
for the answer. A closed worker is terminated, and its space's next trigger
places it on a fresh one.

**Bounds.** A worker is an isolate holding the serving runtime's whole module
graph: on a four-core machine one takes about half a second to load, and holds
about 45 MB of JavaScript heap, about 110 MB of the process's memory, before
it serves anything, where a kept runtime in a shared host holds about 3 MB.
A serving worker whose runtimes compile also starts a compile worker of its
own (`ModuleCompileWorker`), a second isolate that lasts until the serving
worker's host closes.
Three knobs bound that: `maxWorkers`, past which a space joins a worker that
already serves one; `spareWorkers`, which hides the load time from a
placement; and the cap on workers kept only for parked runtimes, with the
heap budget that closes such workers under memory pressure.

**Failure.** A worker that fails affects its own spaces. The watchdog, the
lease release and the backoff are the ones above, per worker and per space.

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
   worker entry and `ServingWorkerPool` (`serving-worker-host.ts`) starts
   workers and recovers the spaces of one that dies. A unit test runs a host in a Worker against a
   file-backed memory server and settles an authored commit through it.
3. [x] **Toolshed wiring under `SERVER_EXECUTION_WORKER`.** The bootstrap
   (`runtime/toolshed/lib/server-execution.ts`) starts a `ServingWorkerPool`
   over the toolshed's own entry (`lib/serving-worker.ts`) when the variable
   is `true`, or is unset or empty over a file memory store, and the
   in-process host otherwise. It hands the rest of the process a
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
   `MultiRuntimeHarness` drives. A serving runtime runs no child placed in a
   space other than the one it serves, which the private-inbox and FabriChat
   tests rely on under the worker: the loop of the child's space is the one
   that derives it, and in a worker that loop can start after the home
   space's next events have run.
5. [x] **Measure.** The vote probe and the Topics seed under the worker against
   the in-process loop on the same box: client watch-add latency, the
   per-vote and per-topic client cost, and the serving loop's own wave
   timings, whose settle the worker leaves where it was and whose cycle
   gains the port round trips of its commit.
   [The 2026-10-11 record](../history/development/performance/2026-10-11-serving-loop-in-a-worker.md)
   holds the numbers, and the wave basis race the measurement exposed, which
   the ordering section above now covers.
6. [ ] **Spec and default.** `serving-loop.md` §1's component diagram names the
   worker (done). The toolshed runs the loop in a worker by default wherever
   its memory store is a file, the one store a worker opens, and
   `SERVER_EXECUTION_WORKER=false` keeps it on the request thread (done).
   After a soak, the in-process path goes, with the flag, and a lane runs the
   ON arm under the worker.
7. [x] **One worker per space.** `ServingWorkerPool` places each space on a
   worker of its own, routes the server's observer by placement, closes a
   worker whose host holds nothing, keeps spares, bounds the workers placed
   on and those kept for parked runtimes, closes parked workers under a heap
   budget, and recovers a failed worker's spaces alone. Each worker acquires
   under a holder component of its own, which its loopback connections name
   to the server. The counters and the realm diagnostics of several workers
   are reported as one. `SERVER_EXECUTION_MAX_WORKERS=1` serves every space
   from one worker.
8. [ ] **A heap limit per worker.** A worker that reaches V8's heap limit
   takes the whole process down, since the limit is the process's flag
   applied to each isolate. A worker started through `node:worker_threads`
   with `resourceLimits` is terminated alone at its own limit, which the pool
   would handle as it handles any failed worker. Such a worker has no `self`,
   so the serving entry modules, which take the port from `self`, need a
   port that works under both.
9. [ ] **Release a placement before its worker closes.** A space stays
   placed on its worker until the worker is gone. A worker that serves
   several spaces and never holds nothing, as the one worker of
   `maxWorkers: 1` on a busy server does, keeps a placement for every space
   it has served. Releasing one needs the host to say that it holds nothing
   for that space, and the same ordered request the worker-level close makes,
   per space.
10. [ ] **Measure.** The vote probe and the Topics seed with a worker per
    space against one worker for every space on the same box: activation
    latency with and without a spare, the process's memory by active space
    count, and the wave timings of two spaces settling at once.
11. [ ] **Compile workers the serving workers share.** Each serving worker
    starts a compile worker of its own at its first compile and keeps it
    until its host closes, so with a worker per space a space that has
    compiled holds two isolates. Compiles handed to a set of compile workers
    on the main thread, reached over the serving port, would let every
    serving worker share them, and a serving worker's own would go.
