# Serving each space from the process that owns it

A deployment can run several toolshed processes over one memory store. Rapids
and Estuary run 21 of them, `toolshed-binary@8001` through `@8021`, with one
`MEMORY_DIR` between them
([`random-space-identities.md`](../specs/random-space-identities.md),
"Deployment mappings"). Their nginx sends each space's memory WebSocket, by its
`space=<did>` query parameter, to one process, and spreads ordinary API
requests over five others. This plan calls the process a space's socket reaches
that space's **owner**.

The serving loop is written as though every space were served by one process.
[`protocol.md`](../specs/server-side-execution/protocol.md) §2b says so of
provisioning ("Same host, same process — this is store sequencing, not a
network await") and puts the other case out of v2 scope. Whenever a serving
loop acts on a space other than its home, it acts through its own process's
memory server:

| crossing                               | today                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| event append into another space        | the outbox calls `Server.commitDelegatedAppend` on its own process                                          |
| foreign wave batch                     | the wave sink applies it to an engine its own process opened, then reports a warm notice                    |
| served access-list change elsewhere    | `Server.commitServedAclChange` on its own process                                                           |
| `.inSpace()` space creation            | the genesis commit goes through a loopback session on its own process                                       |
| read of another space                  | a loopback session on its own process, woken only by commits that process admitted                          |
| lifecycle registration in another space | the toolshed's pattern-lifecycle handler appends through `commitDelegatedAppend` on the process it runs in |

The foreign wave batch carries provisioning, `.inSpace()` child setup, closure
replication, compile-cache writeback and the `agent` queue index entry.

Every one of these is admitted by a memory server the owner never hears from.
Memory-server push and the executor host's activation triggers stay inside one
process. So, with 21 processes:

- When the owner already serves the target, its loop gets no notice of the
  commit. An appended event waits until that loop next activates, and the
  owner's clients are not pushed the new state.
- When nobody serves the target, the delivering process activates it and serves
  it. Its derived commits are pushed only to its own sessions, and the owner's
  clients are on the owner. A later session open on the owner is refused on the
  delivering process's lease and is not retried.
- A cross-space read is woken only by commits its own process admitted. Commits
  that the owner makes to the space it reads leave its derivations stale.

The `execution_lease` row in each space's SQLite file is the only thing that
stops two processes from deriving one space. That is why it cannot simply move
into memory ([the closing stage](#stage-l-the-lease-in-memory) does that, once
the stages before it hold).

The change: a serving loop reaches every space other than its home through
that space's owner. The toolshed never computes who the owner is; it reaches
the owner through the route the deployment already keeps, `MEMORY_URL` with
`?space=<did>` ([`CONFIGURATION.md`](../development/CONFIGURATION.md), the
`MEMORY_URL` row). The toolshed's own runtime already uses that route with one
socket per space (`RemoteSessionFactory` in
`runtime/runner/src/storage/v2-remote-session.ts`), and the meeting-rooms route
already creates spaces through it. In a single-process deployment `MEMORY_URL`
names the process itself, so the owner of every space is that process and the
same code path serves.

## The routed plane

The executor host gets one new input, the route: the URL a session reaches a
space's owner at. The toolshed bootstrap passes `MEMORY_URL`. Under the worker
it crosses in `ServingWorkerInit`, and the worker opens its connections itself.
The host keeps one routed session per target space, open as the service
identity on a socket addressed `?space=<target>`. It opens that session when it
first needs one and closes it when no SpaceServer of the host has needed it for
the life of a tenure. The memory client's connection handling covers reconnects
as it does for every other remote session; nothing here adds a retry of its
own.

A send whose session is not connected fails the way a transport failure does
today. The outbox already treats that as transient (`serving-loop.md` §5,
LT4), and the wave treats it as a foreign failure (below).

The memory router's routed mode (`MEMORY_ROUTER_CONFIG_FILE`,
[`CONFIGURATION.md`](../development/CONFIGURATION.md)) is a separate, private
listener that these deployments do not run. On it, `Server.options.ownsSpace`
refuses a `session.open` for a space the process does not own, and the routed
host admits no `actingAs` binding. The routed session of this plan reaches the
owner's direct listener through the deployment's own `?space=` route, where the
binding is admitted. On a deployment that runs both, `ownsSpace` is a second
fence that agrees with the route; the route is what picks the owner.

## The memory protocol: `served`

A session request, beside `pattern.lifecycle`
([`04-protocol.md`](../specs/memory-v2/04-protocol.md) §4.3.10):

```
{ type: "served", requestId, space, sessionId, kind, body }
```

`space` is the session's space, which is the target. `kind` is one of:

- **`append`**: one delegated event append. The body is the entry
  `Server.commitDelegatedAppend` takes today, without `targetSpace`, which the
  session supplies, and without `sessionId`: the commit's session is the routed
  session. It carries the target stream and its link, `eventId`, payload, the
  carried actor (`actingPrincipal`, `actingSession`, `sessionlessSpaceScope`),
  `capabilityRef`, and the `localSeq` the delivering host minted. The owner
  runs `commitDelegatedAppend` and returns `{ seq?, deduped }`.
- **`commit`**: one foreign wave batch, as a `WaveSpaceCommit` in the memory
  boundary's encoding: the encoding `sink.commitWave` already uses across the
  worker port. The owner applies it through the foreign branch of
  `EngineWaveCommitSink` (`runtime/runner/src/executor/engine-wave-sink.ts`).
  Its refusals are unchanged: sqlite operations, a store with no genesis, a
  write to the ACL document, a scoped write with no delegation. The owner then
  reports the commit as `noteExecutorCommit` does today, warm notice included.
  The response is the seq the batch committed at.
- **`acl`**: one served access-list change, as the list of changes the worker
  port's `ServedAclChangeData` carries. The owner rebuilds the change function
  from the list and runs `commitServedAclChange`, so the admission is the
  owner's, and a refusal there fails that run alone, as the local commit's
  refusal does (serving-loop.md §3d). Only a sealed run's change is sent: a
  withdrawn run and a client's speculative echo commit nothing, and a change
  the seal's check refused never reaches the owner.

The handler answers `{ ok }` with the kind's result, or `{ refusal: { code,
message } }`. On the wire the server sends `ok` as the response's `ok`, and a
refusal as the protocol's standard response `error`, named
`ServedRequestRefusal` with the refusal's `code` and `message`
(04-protocol.md §4.3.12), which the client raises as that error:

- `refused`: a deterministic admission refusal, the engine's `ProtocolError`.
  The outbox takes its LT4 arm, and the wave takes the foreign-failure arm.
- `unavailable`: the owner has no handler installed, since no serving loop
  runs there, or its handler does not serve the kind, as a staged kind's
  handler does not before its stage lands.
- `internal`: anything else.

A transport failure produces no answer at all. The caller treats it, and
`unavailable` and `internal`, as transient: the outbox keeps the row and stops
its drain, and the wave fails foreign and replays.

The memory server admits a `served` request only from a session whose principal
is in the delegating class, which is the process identity under the server
execution flag (`memoryAclPrincipalsFor`). It hands the request to a handler
the serving side installs, `Server.setServedRequestHandler()`, as
`setPatternLifecycleHandler()` installs the verbs' handler. The handler needs
runner code (the sink and the ACL change functions), and the memory package sits
below the runner. The toolshed bootstrap installs it, on the main thread, where
the memory server and the bridge's sinks already live. The server advertises
`servedRequests` as it advertises `patternLifecycle`. A request is bounded like
`pattern.lifecycle`: 8 MiB direct, 4 MiB through the memory router.

**Trust.** This is the footing `protocol.md` §2 already rules on (owner,
2026-08-03): servers trust each other's carried actor claims, for writes and
events alike, and admissibility comes from the validated grant, never the
envelope. Every process of a deployment holds the same service key, so the
routed session authenticates exactly as the co-hosted one does. What changes is
that "co-hosted" stops meaning "one process" and comes to mean "one deployment".
The spec text that says "same process" or "co-hosted memory server" for these
rows is amended to say so.

## Crossing by crossing

**Event appends.** The outbox delivers each pending row as an `append` on the
target's routed session in place of calling `commitDelegatedAppend` on its own
server. Everything else in `serving-loop.md` §5 holds: the rows are durable,
delivery is at least once, the target's `eventId` horizon dedupes, and a
deterministic refusal writes the failure notice in the source. The
pattern-lifecycle handler's registration delivery, which appends to the
`addPiece` stream of the space root it registers into, sends the same request
when that space is not the one its process serves. That delivery then observes
the registration's outcome through the same routed session, with a watch on the
stream document, where it watched its own server's admitted commits: the owner
consequences the event, and only the owner's push says when.
([commonfabric/labs#9437](https://github.com/commonfabric/labs/pull/9437)
removes the HTTP route. The session handler's delivery is what remains.)

**Foreign wave batches.** The wave commit step stays foreign-first and
home-after-success, stopping at the first failure. Each foreign batch is now a
`commit` request awaited on the target's routed session, where it was a store
write. `protocol.md` §2b's "store sequencing, not a network await" becomes a
request to the owner, and its failure rule covers the new failure:

- A refusal or a transport failure is a foreign failure. The home commit never
  lands, the event stays unconsequenced and replays, and a persistent failure
  falls to the error-is-the-consequence rule (events.md §5).
- A transport failure is counted as transient. Every delivery failure budget the
  loop already keeps classes it as `unknown`, which retries and does not harden
  into a drop at the first attempt.
- A reply lost after the owner applied the batch leaves the same state a crash
  between the halves leaves today, and the replay converges the same way: the
  replay is a fresh run of the event, not a resend of the batch. The run reads
  the state the applied batch left, and every foreign write it stages is
  derived from that read, with its precondition taken from it, so a write the
  owner already applied is either absent from the new batch or asserted
  against the state it produced, and provisioning finds its allocation record
  and is a no-op (`protocol.md` §2b, "Replay safety"). A write the replay
  still cannot land is a foreign failure like any other, and falls to the
  error-is-the-consequence rule.

The wave's commit-step reads of a foreign space (heads, intrusions, stale reads)
stay on the shared store through `engineForSpace`. SQLite's `data_version`
keeps them current across processes, and the owner re-checks the batch's
preconditions when it applies it. The worker's port protocol keeps
`sink.commitWave` for the home batch alone.

**Served access-list changes into another space.** These become `acl` requests,
awaited at the same commit step as before.

**`.inSpace()` space creation.** `StorageManager.createSpace` on the serving
runtime opens the genesis session through the route, signed by the new space's
key, as the meeting-rooms route does. The genesis is then admitted by the new
space's owner.

**Reads of another space.** The serving runtime's storage plane opens every
space other than its home with a remote session through the route, carrying the
same `actingAs: "space-owner"` read binding, in place of a loopback session on
its own server. The owner's push then wakes it on every commit to that space,
from whichever process the commit came. The home space stays on the loopback
session. Foreign scoped reads keep their grant-scoped rule; the next section
moves the lease out of their admission.

## Reads that name an instance

`protocol.md` §2's read row admits a read naming an `entity_scope_key` from a
live lease holder on the co-hosted memory server. It checks the full DR1 holder
minted by that process (`#denyExplicitInstanceReads` and
`#liveCoHostedLeaseSpaceFor` in `runtime/memory/v2/server.ts`). A routed read
session reaches the owner from a sibling process, whose holder the owner never
minted and whose lease it cannot see. So the row changes:

- **Who may name an instance:** a session authenticated as the deployment's
  service identity, the delegating class, whether or not it holds a lease
  anywhere.
- **Unchanged:** the grant-scoped read rule (a foreign scoped instance is read
  under its actor's own READ grant on the space), the refusal of an unnamed
  scoped read from a serving session, and the wire collapse guard for everyone
  else.
- **What goes:** the per-process sharpening. It kept a second process sharing
  the service DID from passing on this process's lease rows. A deployment
  whose processes hold one key gives that second process the same trust, and
  this plan is what makes it a peer.
  [`verification-coverage.md`](../specs/server-side-execution/verification-coverage.md)
  records a Phase-1 acceptance that waits on that sharpening; the stage that
  makes the change records its retirement there.
- **What stays:** the session's keyed delivery (`leaseHolderReads`, and the
  `scopeKey` field it puts on the wire). It is armed by the first admitted
  named read, and from then on it is a property of the session's principal for
  the session's life.
- **Also goes:** the lapse machinery that hangs from the lease:
  `leaseHolderReadsLapsed`, its re-arm when the lease is lost, and
  `noteLeaseReacquired` with its port notice.
- **The unnamed-scope guard:** `#denyForeignServingScopedRead` decides that a
  serving session is reading a foreign space by finding a live lease it holds
  on some other space of the same server. A routed session holds none there. It
  decides instead by principal class: a delegating-class session that does not
  hold the read space's live lease on this server is reading a foreign space,
  and its unnamed scoped read is refused as now. Home reads stay on the
  loopback session and keep passing on the holder equality.

This is the one ruling the plan needs on admission. Once the plan is approved,
the ruling is recorded where `protocol.md` §2 records the 2026-08-03 ruling it
amends.

## Activation

Nothing in the host's activation policy changes. A process activates a space on
what its own memory server admits, as now. Once every crossing above routes,
what the memory server admits for a space it does not own is limited to:

- a client session that reached it in spite of the route (a socket opened
  without `?space=`);
- a commit from such a session.

Production clients always name the space. `sharedMemoryConnection`, which names
none, stays off in these deployments until a router terminates client
connections ([`random-space-identities.md`](../specs/random-space-identities.md)).
`serving-loop.md` §1 states the invariant: a space is served only by its owner,
because everything that activates it reaches the owner. A serving loop never
activates a space it reached through the route.

## The flag

`SERVER_EXECUTION_OWNER_ROUTING`, registered in
[`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md) in the stage
that adds it. Off, every crossing stays in-process as today. On, every crossing
routes, along with the read-row change.

The stages below are not separately safe:

- Routing writes without reads moves a target to its owner and takes away the
  wakes the source got only because it also served the target.
- Routing reads without writes stops a process from seeing its own writes into
  another space.

So the flag stays off until all of R1–R3 have landed, and every test of the
routed arm sets it. R4 turns it on in the toolshed, where `MEMORY_URL` is always
set, which is correct for a single process and for 21.

## Testing

None of the existing tests runs two memory servers over one store. Each stage
adds to one harness: two `Server`s over one file store in one test process, each
with its own `ExecutorHost`, and a route that maps a space to the `Server` that
owns it. Routed sessions connect through that `Server`'s `connect()` over the
loopback transport, so the harness needs no HTTP. Every assertion is about
which server admitted what and which host serves what.

Two details make the two hosts behave as two processes would. The serving
memory server of the test support
(`runtime/runner/src/executor/serving-memory-server.deno.ts`) takes a store it
is handed, so two of them open one file. And the lease holder's process
component (`adoptProcessInstanceId` in
`runtime/memory/v2/execution-lease.ts`) is one value per module instance, so
the hosts of one test process mint one holder until R3. The read row binds a
serving session's holder to that component, so R1 and R2 leave it shared and
assert on which server admitted what; from R3 on, each host takes its own
component, and the two holders differ as two processes' do.

R4 adds one integration test with two toolshed processes behind a proxy that
routes `?space=` the way nginx does, and measures the cross-space scenario of
the server-execution benchmarks (an event from one space into another) with the
flag on and off.

## Stages

1. [x] **R1: the routed plane and appends.**
   - The flag and its registry entry.
   - The host's route input, under the worker too.
   - `served` with `append`, its admission and its handler installation.
   - The outbox and the lifecycle registration delivery send through it, and
     the delivery observes its outcome through the routed session.
   - `04-protocol.md` gets the request.
   - `serving-loop.md` §5 and `protocol.md` §2b get the delivery path.
   - Test: an event from X's loop on server A into Y, owned by B, is admitted by
     B, activates Y on B and not on A, is deduped on re-send, and a refused
     grant writes the failure notice in X.
2. [ ] **R2: foreign batches, access-list changes and genesis.**
   - `commit` and `acl`.
   - The wave commit step awaits them.
   - Genesis goes through the route.
   - `protocol.md` §2b's provisioning text is amended.
   - Test: provisioning into a space owned by B lands on B and warm-activates it
     there; with B unreachable, the foreign batch fails, X's home commit does
     not land, and the event replays once B is back.
3. [ ] **R3: reads through the owner, and the read row.**
   - Remote sessions for every space but the home.
   - The read-row change, with its ruling recorded in `protocol.md` §2, and
     the Phase-1 acceptance it retires recorded in `verification-coverage.md`.
   - `serving-loop.md` §3b and `runtime-mapping.md` follow.
   - Test: X on A derives from Y on B and is woken by B's commits; a named
     scoped read of Y's instance for an actor whom Y grants READ is admitted on
     B, and one for an actor whom Y does not grant is refused.
4. [ ] **R4: on by default.**
   - The toolshed passes `MEMORY_URL` and turns the flag on.
   - The two-process integration test, and the cross-space measurement.
   - `serving-loop-worker.md` and `serving-loop.md` §1 drop the in-process
     crossings from their description of the default.
5. [ ] **L: the lease in memory.** The section below. It lands only after a
   release with owner routing on has been deployed to every process.

## Stage L: the lease in memory

With every crossing routed, a space is served only by its owner, and two
processes never contend for one space. The lease then needs nothing stored.
Holding it in memory removes the two problems the stored row causes:

- A space stays unserved after a process is killed and restarted, until its
  predecessor's row expires.
- Any stall of the worker thread longer than the 15 s TTL lapses every lease
  that worker holds, and every space it serves aborts its in-flight wave. The
  recorded cause of such a stall is a long settle starving the renew timer,
  which the mid-wave renew (`serving-loop.md` §2) covers; the stored lease
  turns every other stall of that length into the same loss.

**Precondition.** The route never moves a space between running processes.
With the lease in memory, nothing stored stops the old owner from serving a
space its new owner starts to serve. A change to the set of processes behind
the route drains and restarts them all. The deployment's mapping is a function
of the space's DID and the process count
([`random-space-identities.md`](../specs/random-space-identities.md)), so a
restart under an unchanged count keeps every space where it was.

**What the lease becomes.**

- **Where it lives:** each memory server keeps a map from space to holder in
  memory. The engine's derived-class admission checks that map in place of
  `selectLiveExecutionLease`, and the derived-envelope check stays one equality
  against it.
- **Acquire and release:** they are calls on the memory server's thread. Under
  the worker they cross the port as requests, so `SpaceServer.activate` awaits
  its acquire.
- **Rivals:** a second `ExecutorHost` on the same `Server` (a test's rival) is
  refused as a rival is today, and `host.ts` keeps not retrying a space parked on
  a rival.
- **Holder identity:** the service identity plus a component minted for each
  process start, and under the worker for each worker start. The component still
  keys commit replay and fences the in-flight commits of a worker that was
  replaced.
- **Renewal:** none. The renew timer, the mid-wave renew on the cooperative
  yield, `#renewIfDue`, `#confirmLease`'s renew arm, and the lease TTL policy
  knob all go.
- **Tenure:** the in-process tenure counter stays, because parking still ends a
  tenure, and work sealed under it must not commit afterward.
- **Restart:** a process starts with an empty map. Nothing an earlier process
  held is consulted or waited for.

**The watchdog.** This is the one wait the design keeps, because a thread that
has stopped cannot report that it has stopped. It replaces the stored lease's
TTL as the liveness rule, and it is more tolerant: a stalled worker keeps its
spaces for 60 s where the TTL released them after 15 s, so its successor serves
them later than it does today, and no space is served by two processes in
between because none can be. It is the only timer left in the lease:

- The worker posts a heartbeat every 10 s from a timer of its own.
- The main thread checks every 10 s. When it has had no message of any kind
  from the worker for 60 s, it terminates the worker and releases the worker's
  leases. It then starts a successor under a fresh component, through the
  replacement path that a worker failure already takes (`ServingWorker`'s
  `#onWorkerFailed`).
- A kill counts in `lease.lost`.
- The in-process arrangement has no watchdog: the thread that would watch is
  the thread that stopped.

**The rolling deploy.** A deploy restarts the 21 processes one at a time. Each
port keeps its spaces, and systemd never runs two processes on one port. With
owner routing on in the release before, an old process never activates a space
it does not own, so an old process that still writes rows and a new one that
keeps the lease in memory never serve the same space. The `execution_lease`
table stays in the schema, unused, until a later release drops it.

**What the spec loses.** These parts are rewritten or dropped:

- `serving-loop.md` §1's diagram ("execution_lease row, renewed on a timer").
- §2's acquire, renew and expiry rules, the memory-server-clock liveness rule,
  and the refused-commit renew arm.
- §6's recovery steps that wait out a TTL.
- `protocol.md`'s lease mentions.
- `serving-loop-worker.md`'s lease rows and their release on a worker's death.
- `runtime-mapping.md` N64.
- The `EXPERIMENTAL_OPTIONS.md` entries that describe renewal.

§8's FORBIDDEN list keeps its bans, and adds a stored lease.
