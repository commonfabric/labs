# v2 detail: the serving loop

Normative spec for Phase 1 of
[the plan](../../plans/server-execution-v2.md). Read
[README.md](README.md) first; this document assumes its vocabulary.
MUST/NEVER language is binding on implementers.

## Anchors

- Scheduler: `packages/runner/src/scheduler/` (`execution.ts`,
  `dependency-graph.ts`, `events.ts`, `event-identity.ts`). The scheduler
  already runs graphs to fixpoint on a client runtime; the serving loop
  hosts THAT scheduler server-side. Do not write a new scheduler.
- Runtime construction: `packages/runner/src/runtime.ts` (`new Runtime`),
  builtin registration `packages/runner/src/builtins/index.ts`
  (`registerBuiltins(runtime)`).
- Store: engine-v3 sqlite per space DID (the on-disk layout is
  composed by `resolveMemoryEngineStoreRootUrl` and
  `resolveSpaceStoreUrl` in `packages/memory/v2/storage-path.ts`),
  tables `commit`, `revision`, `head`, `branch`, and `execution_lease`
  in the reduced §2 shape (`packages/memory/v2/engine.ts` schema;
  `packages/memory/v2/execution-lease.ts` holder side). The v1
  branch's richer shape was prior art, not substrate (its `engine.ts`:
  branch PK, `lease_generation`, `host_id`, `on_behalf_of`, state
  `active|draining|revoked`, `expires_at`) and none of it carried
  over.
- Memory server + protocol: `packages/memory/v2.ts`, mounted in toolshed
  at `/api/storage/memory`
  (`packages/toolshed/routes/storage/memory/memory.routes.ts`).

## 1. Components

```
toolshed process
└─ ExecutorHost (one per process)
   ├─ SpaceServer (one per ACTIVE space)
   │  ├─ lease        (execution_lease row, renewed on a timer)
   │  ├─ runtime      (ordinary Runtime, flag ON, server posture)
   │  ├─ subscription (accepted-commit feed for the space, from the
   │  │                activation scan's head — §3, §6)
   │  └─ outbox       (post-commit external effects, at-least-once)
   └─ activation policy (which spaces are active)
```

A space is ACTIVE when it has ≥1 live client session or undelivered
events; otherwise it MAY be parked (lease released, loop stopped, and
the runtime disposed or kept for the space's next tenure — Parking
below).
Activation on: session open, event append, or explicit warm request.
*(AMENDED 2026-09-09: a fourth trigger — a pattern-lifecycle verb
request, which the host queues on the space's serving loop; the loop
runs it ahead of a cycle's event drain, its seals joining that cycle's
wave, and once the wave has committed re-announces the documents the
verb staged to itself as a warm-marked notice — the same carrier as the
provisioning path's — so the next cycle loads and derives the staged
piece; the request settles at the verb's own wave commit —
[docs/features/server-pattern-lifecycle.md](../../features/server-pattern-lifecycle.md).
AMENDED 2026-09-11: a verb's transaction stamped `directCommit` commits
to the store on its own instead of sealing, ahead of the wave; the source
update's setup transaction is one, per §3e.)*

A park can leave a space that still meets the ACTIVE criteria: a serving
loop that throws, an initialization that fails, and a lease lapse that
aborts a wave (§2) each park the space whatever its demand. So when any
park completes, the host re-evaluates the criteria — live client
sessions, undelivered events, and warm requests not yet consumed — and
re-activates a space that meets them without waiting for another
trigger. The exception is a park caused by another process's live lease
refusing an acquire or a re-acquire (§2): that process serves the space,
and an activation here would be refused again. A park during which a
rival took the lease for some other reason, such as a lapse that
aborted a wave, is re-evaluated like any other, and its one activation
attempt is refused. Every park other than an idle one or one on a
rival's lease extends the space's failure-park backoff, which delays its
next activation by base·2^(n−1) for the nth consecutive such park, up
to a cap. An idle park or a committed wave clears the backoff. A space
whose serving fails every time is therefore rebuilt at a widening
interval rather than in a tight loop. Impl: `host.ts`'s park handler
and `#reactivateAfterPark`; pinned in
`packages/runner/test/executor-serving-loop.test.ts` and
`packages/runner/test/executor/activation-lease.test.ts`.

What activation LOADS (RULED 2026-08-02): there is NO piece-start
policy in v2. The space is ONE lazy reactive graph, and activation
loads graph structure sufficient to resolve the demanded values and
the queued events — never "instantiate the pieces" as a step of its
own. Demand is value-granular client pull: a subscription to a value
recomputes that value and its upstream FOR THE SUBSCRIBER'S INSTANCES,
nothing else — a principal's subscription at a broad address is demand
for that principal's instance of every node that narrows beneath it
(scopes.md §2, RULED 2026-08-16; fan-out stage B), so the demand
registry keeps the demanding (user, session) pair on every INSTANCE a
client session TRACKS — memory v2's schema-narrowed closure of that
session's watches (the roots, every doc the selectors' schemas reach —
absent targets included — and the schema document a delivered document's
`cfc` label names; the `pattern`, `argument`, `result`, and `internal`
metadata of a document is data on it and puts nothing in the closure,
05-queries.md "Metadata / Provenance Resolution"), instance-keyed,
accumulated across its overlapping watches, space-scoped instances
included. Demand is that union over the space's client sessions; there
is no demand walk.
*(AMENDED 2026-09-09 (descriptive; the RULED semantics — the tracked
set — unchanged): a piece's own computeds are in a session's closure
exactly where a watch's schema crosses to them — a result read under the
pattern's result schema reaches the computed behind each result
property — so a client that wants a derived value names it by reading
under a schema that reaches it, and a schema-less root watch demands the
root document alone. The one-push-late structural-growth path is what
carries a piece's computeds into demand once the result document holds
the link a schema crosses (protocol.md §4's later demand).)*
The serving loop runs the STALE writers of demanded instances — a
writer whose instance for a demanding pair never ran at its ratchet,
or was dirtied since (§3b's per-instance clean bit; the basis index is
the same predicate at activation) — and those runs' own logged reads
make their inputs live and current in turn (§3b, one-run-late); a
demanded instance's writers hold demand (a demand root, §8's liveness
bracket) while any session tracks the instance and release it when
none does — a session's tracked set shrinks only on a full
re-evaluation or close (coarse, RULED 2026-08-18; fine-grained is
future). A derivation that becomes reachable through a wave's own
write becomes demand when the tracker's push-time re-traversal reaches
it and lands in a later derived commit (protocol.md §4's later
demand); a value-only change re-derives the demanded instances through
the trigger index alone. Nothing about structure versus value is
decided anywhere. *(RULED 2026-08-18 — the (d′) demand model; the
owner accepted the stage-C design's ruling set, item 1 as recommended:
the demand-WALK sentence this paragraph replaces — "the demand WALK
(the live reader per demanded root that pulls the value's subtree)
runs once per demanding pair, each run following THAT demander's
redirects" — described the fan-out stage-B mechanism and was amendable,
not a rule. The text is the design's §2.10, verbatim
([`stage-c-design.md`](../../plans/server-execution-v2/stage-c-design.md)).
IMPLEMENTED by the design build's W1 (2026-08-19): the per-demander
demand walk is deleted; the serving loop marks the writers of demanded
instances as standing demand roots (§8's liveness bracket) and runs the
stale ones. verification-coverage.md OW39 — the row that tracked "spec
ahead of code" — is CLOSED by W1's landing.)*
Events run
their handlers eagerly — after preflight makes any dirty state
inputs current (D-v2-2). Undemanded derivations stay
dirty-unmaterialized indefinitely — `idle()` already excludes them
(§3b's pull-based laziness). Per-piece start/stop, root-piece
bootstrap, and auto-start-on-event are client-era framings with no
server analog (runtime-mapping.md N22/N31).

Activation mechanics: the memory server notifies the ExecutorHost on
any AUTHORED admission into a space with no live lease — an
admission-side hook, not a poll (prior art: the no-handler auto-load
path in `queueSchedulerEvent`, `scheduler/events.ts`). Host boot
discovery is a per-space check: stream head past `eventWatermark`
means undelivered events, so activate. A park racing an incoming
commit self-heals: the hook re-fires on the next admission.

The EXPLICIT WARM REQUEST *(RULED 2026-08-21 — the owner adopted the
recommendation set for the home-profile setup-after-park residual;
implemented the same day)*: the SERVING-SIDE PROVISIONING PATH issues
it — the wave commit step reports every durably committed foreign
provisioning batch (§2b's sanctioned authored crossing: a served
`.inSpace()` create's scaffolding, the delegated program-
materialization writeback) to the co-hosted memory server as a
warm-marked admission notice carrying the staged doc instances. The
host activates a parked target on it even with NO live session and NO
events (the carries-events arm's sibling), and the target's tenure
takes the staged instances as identity-less WARM DEMAND — the
anonymous-session shape, a demand key with no demanding pair, unioned
into the demand pass for that tenure — so the staged piece
structure-loads and derives. This is the one deliberate extension of
the demand union beyond client sessions: the issuer is the
provisioning run that KNOWS it staged setup needing derivation — a
scoped signal, never a blanket write-trigger — so T11.Q7 stays as
designed (the admission hook alone still notifies without activating;
a provisioning write ALONE still parks). Lifecycle: idempotent
against an active target (the union is a no-op under standing client
demand); a request racing a park re-carries itself into the successor
activation; the captured warm demand is TENURE-scoped (it dies with
the tenure — recompute-on-demand, §6 step 2, is the recovery posture
for anything a dying tenure drops), and the request itself is a
one-shot in-process signal, not a durable row — loss across a process
crash in the staged-but-underived window is the OW46 silent-park
observability family. One deliberate side effect, stated: the
warm notice rides `noteExecutorCommit`, whose dirtiness marking means a
foreign provisioning batch's staged writes now also PUSH to any client
session subscribed to those docs in the target space — previously those
engine-direct commits produced no notice at all, so a subscribed client
saw them only on its next own sync. Beneficial (staleness removed),
never load-bearing: no client in the ruled flows subscribes to setup
docs before activation.

**Parking.** A park releases the lease and stops the loop. A park for a
lost lease, a failed loop, a failed initialization or a closing host
disposes the runtime. An IDLE park (§3's "on idle") that abandoned no
open wave and left no effect unretired in its outbox (§4: an effect
dispatched or held when the park closes the outbox is recovered by a
fresh runtime's memo re-miss, and its completion carries identity only
that outbox holds) offers it to the host instead, which keeps it for the
space's next tenure — for `SpaceServerPolicy.parkedRuntimeRetentionMs` (default
10 minutes; `SERVER_EXECUTION_PARKED_RUNTIME_RETENTION_MS` in the
toolshed bootstrap, where the literal `0` disposes at every park), and
at most `maxParkedRuntimes` (default 8) across the host, the
longest-kept disposed first. A tenure that takes a kept runtime serves
with it as it stands: no compile, no module evaluation, no piece
restart and no pre-sync, where a fresh runtime pays all four for every
demanded piece. It takes one only when the runtime holds exactly the
idle state the parked tenure left over exactly the store that tenure
last saw:

- The parked tenure leaves every demanded entity it entered, warm
  demand included, so what the runtime serves next is the successor's
  demand alone.
- A kept runtime NEVER commits. Its seal destination refuses every
  transaction it closes, and the parked tenure's own destination refuses
  a transaction the tenure opened and closed after the park (§2's
  stop-committing MUST, carried past the park). A refusal TAINTS the
  runtime: something in it moved while nothing could land. One that
  lands while the park is still under way keeps the runtime from being
  offered at all.
- A storage subscription taints it on any change its replica takes in —
  a delivered frame, a load, a retraction, a reset — for its home space
  or any other.
- The successor, holding the lease, takes it only while the space's
  store head is the head recorded at the park. A commit that reached the
  store by any route fails this, including one this process's memory
  server never admitted and so never delivered (a second process on the
  same store), and the successor builds fresh.

A tainted runtime is disposed at once, and one turned down at activation
then, each under the same deadline as a park's own dispose
(`parkDisposeTimeoutMs`), past which the dispose is abandoned. Kept
state is process memory only; recovery (§6) is unchanged, and a fresh
runtime is what every other activation builds. The cost is
the memory the kept runtimes hold, which is what their tenures held
while active: measured on 30 small pieces, about 3 MB of post-GC heap
per kept runtime (1.2 MB on 10), so the defaults bound the extra at
eight such runtimes for ten minutes each. A visit after the window
closes pays the fresh build. Counted: `parkedRuntimes` (§7).

Wiring, by plane. Every byte between these components travels on
exactly ONE of two planes; the split is what keeps bookkeeping off
the commit stream (README §3.3):

```
loopback-runtime plane               direct-engine plane
(storage protocol — carries every    (raw engine-table access —
commit the host produces)            carries no commit, ever)

SpaceServer runtime ◄──────────┐     ExecutorHost
  │ (a)                    (d) │       │ (c)
  ▼                            │       ▼
IStorageManager                │     execution_lease table
  │ (a)                        │     (same engine-v3 store)
  ▼                            │
memory server ─────────────────┘
  │ (b)
  ▼
ExecutorHost ── activate ──► SpaceServer

SpaceServer outbox ──(e)──► network; results re-enter via (a)
```

- **(a) runtime → IStorageManager → memory server**: the ONLY
  commit path — each wave's one derived commit (final values,
  watermark doc — §3) and the outbox's AUTHORED commits
  (cross-space event appends, `.inSpace` provisioning —
  protocol.md §2b) all enter the store here. Basis-index rows (§3b)
  travel on this plane too, but as part of the store TRANSACTION —
  never as part of the commit REPRESENTATION: they are engine table
  rows, they are not pushed to any subscriber (protocol.md §3), and
  admission never reads them (protocol.md §7). "On the storage
  protocol" must not be read as "on the wire".
  READS take this plane too by default: the serving runtime's home
  session watches its roots under their selectors, and the memory
  server's schema walk delivers the closure. Under the store
  read-through posture (`SpaceServerPolicy.storeReadThrough`;
  `SERVER_EXECUTION_STORE_READ_THROUGH=true` in the toolshed bootstrap,
  default OFF) the home space's reads leave the session instead: a
  document the replica does not hold is read synchronously from the
  engine on first access and a `sync()` of that document resolves from
  the engine with no watch registered, while a `sync()` of a held
  document is answered from the replica, and the feed's admitted
  commits (plane (d)) re-read the documents the replica holds — so the
  runtime walks the schema once, over what it actually reads, and the
  memory server never walks it for the serving session at all. The
  read-through preserves the frame validator's delivery guarantee: it
  reads the `cid:` schema documents referenced by an accessed document's
  link positions or schema metadata, and follows the schema documents'
  own references to a fixpoint, just as a session's frame carries them.
  This applies to content-addressed documents as well. Reads
  run at the engine's head, as delivered frames do; writes and
  foreign-space reads stay on the session. Two rules a session frame
  follows hold here in the read-through's own form. Protocol.md §3's
  lease-holder delivery rule — another principal's instance reaches
  only the live holder of the space's lease — is applied per read: a
  read of such an instance that finds the lease row lapsed runs the
  renew arm first (the lost-then-reacquire step the renew timer takes,
  taken at the moment the lapse is found) and is served under the
  reacquired tenure, or withheld as the tenure parks. During initialization,
  lease loss withholds the read and invalidates activation; that partially
  initialized runtime is disposed rather than reused under a new tenure.
  Space-scoped
  documents and the service's own instances are delivered to any
  session, so they are read without consulting the row. And an address
  the store holds nothing at leaves no record, as a pull that delivered
  nothing leaves none: a transaction's read of it stays an unexamined
  absence for commit to reconcile, and the store is asked again only
  when the feed reports a write to it. Counted: `storeReads`,
  `storeRefreshes` (§7).
- **(b) memory server → ExecutorHost**, in-process: the
  admission-hook activation feed — an authored admission into a
  space with no live lease NOTIFIES the host, and activation then
  follows this section's ACTIVE criteria (≥1 live session or
  undelivered events; never a poll). The distinction matters for
  provisioning: an `.inSpace` write is an authored admission into
  a lease-less space, but alone it meets neither criterion, so the
  minted space stays parked until its first session or event —
  reconciling protocol.md §2b's "activates later" with this hook
  (trace finding T11.Q7).
- **(c) ExecutorHost → engine tables**: lease acquire and renew by
  direct table update, and — since Phase 1 stage G — the outbox's
  delivery-acked row retirement (§5's deleted-on-delivery-ack; the
  rows were WRITTEN inside the wave's own plane-(a) transaction, so
  only the delete rides here) — the direct-engine plane's ONLY
  traffic, none of it ever a commit (§2).
- **(d) memory server → runtime**: the space subscription delivers
  accepted commits from the activation scan's head (§3, §6); the
  loop's own derived commits return here too and are skipped by
  class + holder (self-echo, §3).
- **(e) outbox → network**: post-commit external effects,
  at-least-once under memo-key dedupe (§4–§5); completions re-enter
  as derived commits on (a), dirtiness injected in-process (§4).

## 2. The lease (single-deriver, operationally)

The invariant "derived state has exactly one deriving committer" holds by
construction against *clients* (no code path). Against *other server
processes* (deploy overlap, partition) it holds via the lease:

- One row per space in `execution_lease`: `(space, holder, expiresAt)`.
  The table reduces the v1 branch's richer shape (see Anchors) to
  exactly these three fields — prior art, not substrate.
- **`holder` is a PER-PROCESS identity (DR1, RULED 2026-08-03):**
  the SpaceServer's service identity plus a process-instance
  component minted at PROCESS START — stable across every renew and
  reacquire within one process lifetime (it stays a nameable,
  attestable identity, so protocol.md §1's "the envelope principal
  IS the lease holder" reads literally), fresh whenever the process
  is genuinely new. The equality check below thereby fences every
  CROSS-process succession (deploy overlap, a successor host) for
  free. The one residue — a same-process reacquire after a pause
  that outlived the TTL (a runtime GC pause is the canonical cause;
  nothing to do with the deferred session-data GC of scopes.md §8) —
  is covered by the stop-committing-immediately MUST below,
  enforced IN-PROCESS before reacquiring (an in-memory generation
  counter suffices; co-hosting makes the abort-before-reacquire
  sequencing local and cheap). This is also why the FORBIDDEN list
  bans per-commit fencing tokens: v1's `lease_generation` is not
  needed — not because fencing is unwanted, but because the
  holder's process component already fences across processes and
  the in-process residue is a local obligation, not wire machinery.
- Acquire with a conditional write; TTL 15 s; renew every 5 s **by direct
  table update — a lease renewal is NEVER a commit** (v1's renewal-adjacent
  traffic was part of the storm). Periodic renewal has two drivers (stage C
  tuning T3, 2026-08-18): the interval timer, and a MID-WAVE renew issued
  from the serving scheduler's cooperative macrotask yield (§3) once the
  tenure has gone TTL/3 without a renewal — the timer rides the macrotask
  queue a long settle used to starve (the stage-C attribution's t2:
  renew gaps to 10 s against the 15-s TTL, then `lease-lost` on every
  active space at once), so the belt renews at the same cadence without
  depending on the timer queue being serviced. Neither driver is a
  commit. Impl: `space-server.ts` `#renewIfDue` on
  `Runtime.servingYieldObserver`; pinned in
  `executor-cooperative-yield.test.ts` (ii).
- Renewal starts immediately after acquisition and covers runtime creation,
  foreign basis reads, and delegated append recovery. Initialization remains
  distinct from an active serving loop. Before launch, a direct renewal checks
  that the lease is still live even if synchronous work delayed timer callbacks.
  A renewal failure or lease-store exception invalidates initialization: the
  outstanding initialization await finishes, then its runtime is disposed,
  its renewal timer is cleared, and its lease is released. Observer cleanup
  failures cannot skip the factory disposer; observer cleanup and disposer
  failures cannot skip lease release. Host shutdown waits
  for this lifecycle before returning. Initialization that loses its lease
  parks, and §1's re-evaluation after a park follows once that activation
  has finished: matching demand starts a fresh tenure after the
  failure-park backoff. Warm notices arriving during initialization or its
  cleanup remain obligations of the successor. Initial acquisition refusal
  on a rival's lease does not schedule another attempt, and host shutdown
  cancels a pending backoff. A lifecycle-verb request whose activation fails
  receives the not-served error; the request alone is not a persistent
  reactivation criterion. These boundaries are covered by
  `test/executor/activation-lease.test.ts`.
- On renewal failure or expiry: the SpaceServer MUST stop committing
  immediately (in-flight transaction aborts), then re-acquire or park.
  A wave aborted this way parks the tenure even when the re-acquire
  succeeds. §1's re-evaluation after a park then starts a new tenure for
  a space that still has demand, and that tenure's fresh runtime
  recomputes the withdrawn derivations (§6 step 2). A failed re-acquire
  parks on the rival's lease, and the host leaves the space to the
  rival.
- The memory server rejects a derived-class commit whose `holder` does not
  match the live lease. This is one equality check, not admission
  machinery. It binds fresh commits: an exact replay of an already-accepted
  commit answers from the store first (replay detection precedes
  current-authority admission), so a network retry of an accepted commit is
  never re-admitted against current authority. (Stage F adds the
  envelope-session half of the same check — protocol.md §2's
  derived-envelope defense-in-depth, RULED 2026-08-05.)
- Liveness is judged by the MEMORY SERVER's clock: admission compares
  `expiresAt` against its own clock, and an expired row matches NOBODY —
  a derived commit under an expired lease is rejected even before any
  successor acquires. Holder clocks never arbitrate liveness.
- A refused derived commit can be the holder's first sign of a lapse:
  neither renewal driver may come due until well after the TTL has run
  out, for example when the host process was suspended. When the memory
  server refuses a derived commit and the lease row no longer names the
  holder live, the SpaceServer runs the renew arm at once, as the store
  read-through does (§1 plane (a)). The tenure therefore ends at the
  first refused commit. A wave refused this way aborts as a lease loss
  and parks, as above. Impl: `space-server.ts` `#confirmLease`, called
  from the wave sink's refusal hook; pinned in
  `executor-serving-loop.test.ts`.

FORBIDDEN: per-action leases, lease fencing tokens per commit, lease
renewal via the commit stream, more than one lease shape.

## 3. The loop, normatively

State per SpaceServer: `W` = watermark, the highest space seq whose
derived consequences are fully committed. Persisted in the space (one
well-known doc, updated in the same transaction as derived commits — never
its own commit).

An event whose sidecar synchronization fails or whose replica view does not
hold its stored `(eventId, seq)` has not entered the scheduler. A quiet scheduler
therefore cannot establish coverage for it. The drain retains the earliest such
sequence across cycles, clamping both input-head and quiescent-tail advancement
below it. A fresh scan re-evaluates this floor; ending the serving tenure clears
it. This composes with the foreign-write shadow floor and does not wait for
sealed-write durability. [Event visibility](events.md#2-lifecycle-end-to-end)
defines the ordered publication/response barrier before deferral.

```
on activate(space):
  acquire lease (else park)
  start lease renewal through initialization
  runtime = new Runtime(serverPosture)   // flag ON, egress allow,
                                         // builtins registered
  load graph structure for demanded values + queued events (§1 —
    no piece-start step; undemanded nodes stay unmaterialized)
  W = read watermark doc (0 if absent)
  re-mark the dirty frontier from the basis index (§3b, §6):
    a node is dirty iff a recorded input seq is behind that doc's head
  subscribe(space, from = the head the index scan ran against)
  verify the initialization tenure remains live (else dispose and park)

on commits [s..n] arriving (the wave's input batch; commits arriving
mid-wave belong to the NEXT wave — natural double-buffering, no timers):
  for each commit c:
    if c.class == derived and c.holder == self: continue   // own echo
    mark dirty: resolve c's written docs/paths against the dependency
    graph's input links (the scheduler's existing dirtiness path)
    if c.class == event-append: enqueue for handler processing (events.md)
  // The wave is THE REGULAR SCHEDULER run to idle — no phase split,
  // no event handling outside it (D-v2-2, ruled 2026-08-02). Events
  // enter the scheduler's ordinary queue; idle() does not resolve
  // until every queued event is processed, same as a client today.
  // Handlers run eagerly — but only after preflight makes any dirty
  // state inputs current (D-v2-2): the scheduler's existing rule
  // recomputes a dirty computed input ON DEMAND before the handler
  // that reads it runs, and only then (anchor:
  // scheduler/event-preflight-dependencies.ts). Pull-based laziness
  // therefore still skips derived work nothing demands — which is
  // where rapid-fire coalescing comes from: superseded intermediates
  // are skipped by laziness, not by an explicit drain phase.
  run scheduler to QUIESCENCE — scheduler.idle()
  (Scheduler.idle() in packages/runner/src/scheduler/facade.ts)
  resolves; it
  awaits queued AND parked events, running actions, and demanded pull
  work — the eager/idle-scheduled actions and their cascades included.
  It does NOT await undemanded dirty computeds (pull-based laziness,
  §3b), commit durability, or post-commit async builtin work
  (finalizeReactiveActionCommit in scheduler/run.ts rides
  runtime.settled(), which maps to the outbox here). There is no
  separate commit for idle-time work.
  commit one derived-class transaction containing:
    - all derived cell changes of this wave (final values only)
    - consequenceOf: every eventId drained this wave
    - watermark doc := n
  hand external effects to the outbox (post-commit; see §5)

on wave budget exhaustion — EITHER trigger (deadline RULED, owner
2026-08-04): (a) a cascade that will not quiesce within the
scheduler's pass budget, or (b) the CONSEQUENCE-FLUSH DEADLINE — a
wave still running at T_flush commits what is sealed so far. ONE
mechanism for both: close a wave when it has sealed contributions or pending
effects, count `wavesBudgetExhausted`, and keep W unchanged. A zero-delta
cycle with no pending effects closes no wave and makes no durable commit,
but still increments the exhaustion counter. A committed exhausted wave
contains a consistent sealed snapshot; its `derivedThrough` stays at the
current W. Continuation waves carry the
cascade as dirtiness; W jumps to the top of the pending input batch only
at true quiescence. Crash recovery stays sound because the basis index
re-marks the truncated dirty frontier (§3b, §6) and memo hits suppress
effect re-fires.

on drain-settle (TRUE quiescence: a settled non-exhausted cycle, no
contributions, no pending events, the drain empty — S1, RULED
2026-08-19; protocol.md §4's quiescence-advance amendment):
  additionally advance W over the space's own committed derived tail
  (own waves and standalone effect completions contiguously above the
  input coverage point),
  sealed as an advance-only wave and pushed through the ordinary
  watermark-doc channel — client retirement floors that include a
  pushed derived commit's seq become reachable on a quiet space (the
  swatch-stall class fix). At most once per quiescence transition
  (latched by content-carrying own derived commits, consumed on seal); a
  completion arriving after an advance chose its target keeps a later advance
  owed. Each successful advance-only commit is counted even when that newer
  completion keeps the latch armed. The advance's own bookkeeping commit
  is never chased; any non-own seq
  above the coverage point stops the advance below it (fail-closed —
  its coverage arrives input-driven). Counted: settleAdvances.

on idle (no dirty work, no queued events) for IDLE_PARK_MS:
  park per activation policy
```

**The deadline is the MULTI-USER LATENCY bound.** Without it, one
user's heavy demanded fan-out delays every other user's consequence
visibility in the same batch — head-of-line blocking ACROSS users,
because the whole input batch commits once at the batch's derived
closure. With it, a consequence is visible within roughly
2·T_flush + push even while the wave behind it keeps deriving.
**The deadline is HONEST only if the settle yields (stage C tuning T3,
2026-08-18):** the scheduler's settle loop ran a whole wave's actions
on one microtask chain, so the deadline timer could fire only after the
last one — the stage-C attribution measured chat event waves late by
2.5–8.3 s with `wavesBudgetExhausted` a symptom, not a bound. A SERVING
runtime's scheduler now yields one macrotask between ACTIONS in the
settle loop whenever its slice of continuous work (16 ms) is spent
(`scheduler/cooperative-yield.ts`; the OFF arm and clients construct no
yielder and keep their exact microtask shape), so the deadline fires
within one action + a slice of its time (measured live: lateness p50
25 ms, p90 152 ms, max 399 ms — one action's instance runs and its
resubscribe still run to their end; the WORK is the design half's).
NOT inside the per-demander fan-out loop (considered and rejected): a
macrotask there let a run's own asynchronous seal refusal land mid-pass,
and the loop re-ran the dirtied instance in the same pass while the
refusal's queued retry ran it again — two durable emissions of one
served event; the retry machinery's contract is that a failed run's
retry lands on the QUEUED pass, never the current one. Its companion, the DRAIN'S IN-FLIGHT GUARD: with cycles
routinely cut before a just-drained event has run, the post-commit
re-arm re-drains the still-pending entry every cycle and used to queue
a SECOND copy each time (4× dispatch of the lockdown toggle on the
two-browsers gate); the drain now skips an entry whose earlier drain
copy has not yet reached its commit callback (`events.drainInFlightSkips`;
events.md §4). Pinned: `executor-cooperative-yield.test.ts` (i) and
`executor-events-down.test.ts` (exactly-once under an honest deadline).
Light waves never reach the deadline and stay single-commit — the
zero-delta case, which is why this is a trigger on the EXISTING
exhaustion machinery rather than a new commit topology. T_flush is
a policy knob (order 50–100 ms), tuned in Phase 6 with the other
budgets. The configured default is 100 ms. `wavesBudgetExhausted` counts
exhausted cycles, including those with no wave closure or durable commit;
`waves` counts closures, including vacuous or aborted outcomes. Their ratio
is not a committed-wave exhaustion fraction. The amplification budget's
inspection rule treats deadline flushes under load as a reason to inspect
and, with the required evidence, re-baseline (testing.md §4). The deadline
allows sealed consequences to become visible under sustained multi-user
input while full input coverage remains gated on quiescence.

**Sealing order makes the first flush worth flushing**: events and
their handler consequences MUST seal ahead of deep demanded
recomputes. The loop already behaves this way — events run eagerly,
derivations are demanded pulls — this sentence pins it so an
implementation does not reorder. Per-stream `eventWatermark` still
advances for events fully processed in an exhausted wave, and
`consequenceOf` carries them, so overlay echoes retire on the FIRST
flush (speculation.md §4) even when W lags to quiescence.

**Considered and RECORDED as the fallback, not built** (owner,
2026-08-04): the two-tier WRITE-CLASS split — every wave committing
its non-re-derivable tier (handler consequences, `eventWatermark`
advances, effect intents, cascade entries) ahead of a re-derivable
tier. It buys constant consequence latency at a CONSTANT 2×
amplification floor plus a steady-state consistency seam between
consequences and their derived views; the deadline buys the same
latency bound load-adaptively on machinery that already exists and
is model-verified (C10). Adopt the split ONLY if Phase 3's
propagation gate (≤300 ms p50, testing.md §5) fails under realistic
fan-out with the deadline alone — and if adopting, split by WRITE
CLASS (the §3d conflict seam, which makes the second tier
drop-only and keeps the watermark-with-consequences atomicity),
never by "handlers vs reactive".

Rules:

- **One derived commit per wave.** If the wave's changes exceed a
  transaction-size bound, split by piece: every split carries the same
  final `derivedThrough` metadata AND the same full `consequenceOf`
  list (bounded by wave input, so repetition is cheap — and
  required: push is per-recipient filtered by `scope_key`, so the
  split a client happens to receive must itself carry the eventIds
  its overlay reconciliation matches — speculation.md §4), the
  watermark DOC write rides ONLY
  the last split, and all splits land before the loop takes new input.
  The amplification budget (README §3.3) is enforced here as ONE
  metric: `derivedCommits / (authoredSeen − effect-channel acks)` MUST
  stay ≤ 2 on pure workloads and ≤ 3 on workloads with effectful nodes
  (their completion commits are derived-class) — a logical write is one
  authored commit excluding effect-channel acks (testing.md §4).
- **The loop never awaits the network.** Effectful built-ins resolve from
  memo (§4) or yield a pending marker; the network call runs in the
  outbox, and its completion re-enters the loop as a new dirty input
  (result cell write). This is the v1 `compileAndRun` outbox lesson,
  generalized.
- **Self-echo is a no-op**: the subscription will deliver the loop's own
  derived commits back; they are identified by commit class + holder and
  skipped before dirtiness marking. Outbox completion commits (§4) are
  self-echoes too: their dirtiness is injected IN-PROCESS post-commit,
  so the subscription copy is skipped like any other.
- Waves are processed in seq order; there is no concurrency per space.
  Cross-space concurrency is free (separate SpaceServers).

## 3b. Reading state: discovery by running (D11)

There is no static read analysis anywhere in v2. Reads are discovered by
executing:

- Every run (handler, computed, eager action) executes in a transaction
  that logs each read — doc, path, version (the reactivity log,
  `packages/runner/src/storage/reactivity-log.ts`). The scheduler
  subscribes the node to exactly its LAST run's read set.
- **Dynamic dependencies are one-run-late, and that is sound**: a node
  cannot newly read C except as a consequence of a change in something
  it already read — the branch that reaches C is conditioned on prior
  inputs. Run k's read set decides the wake for k+1; dependencies
  discovered in k+1 take effect for k+2.
- **Whether a node runs at all** is the equality cutoff on the same
  machinery: an unchanged upstream output never dirties downstream, so
  conditional secondary inputs are never read and never subscribed.
  Pull-based laziness composes: undemanded computeds do not run;
  dirtiness travels last-known edges as a flag until demand pulls a
  recompute.
- **Snapshot discipline**: a wave reads the store at its input batch's
  seq (mid-wave commits are next wave's input), so a mid-run discovered
  read cannot tear.
- **Cross-space**: the first foreign read (executed under the piece's
  granted authority — concretely, on the loopback plane over a session
  whose READ capability resolves as the foreign space's OWNER through
  the `actingAs: "space-owner"` delegated binding, OW31 RULED
  2026-08-18/19; protocol.md §2b's free-read row carries the full
  mechanism) registers, by being logged, a
  server-internal wake on that doc for the home SpaceServer. Same one-run-late soundness.
  v2 assumes spaces co-hosted on one memory server; sharding is out of
  scope. *(Phase 5 pinned the wake end to end and added NO machinery
  for it — survival-tested: the foreign read's loopback session IS
  the registration; a foreign commit's frames arrive on that session,
  the scheduler runs autonomously off storage notifications, and the
  re-run's SEAL wakes the loop — with chained-not-yet-applied seals
  counted as WORK by the idle check (a seal chained in a cycle's
  last microtasks is otherwise invisible to it; the level keeps the
  wake deterministic instead of falling back to the idle timeout,
  which the removed fan-out had covered incidentally). The foreign
  commit is never home input — W and the input batch stay per home
  space.
  Foreign SCOPED reads are the exception: fail-closed refused until
  the grant-scoped read design's resolution lands — protocol.md §2.)*
- **Scope discovery is part of read discovery**: a run's scope is the
  narrowest scope of anything it read, so it too is discovered by
  running. A narrowing discovery writes the broad-slot redirect AND
  the discovering run's own instance; SIBLING instances materialize
  on their own demand like any other undemanded derivation
  (scopes.md §2, ruled 2026-08-02 batch 4, corrected by the S3
  review). The redirect write dirties the broad slot's readers in
  the same wave, and demanded siblings are ordinary demanded work
  under §3's budget rule. **The instance set is derived by the
  scheduler from what the node has LEARNED (fan-out stage B, RULED
  2026-08-16):** per node, a KNOWN-SCOPE RATCHET — the top hop a
  node-level bit, the session depth PER PRINCIPAL (ragged, scopes.md
  §2), only ever narrowing, forgotten with the node — written only by
  run outcomes (the transaction's read-scope ratchet — logged reads,
  the write path's diff-base read at the narrower instance, and
  identity consumption: resolving whose home space a run targets is
  a user-scoped read); the demand registry supplies the DEMANDERS,
  and `instances(ratchet, demanders)` is one probe run (the smallest
  pair) while unnarrowed, one run per demanding principal at user
  depth, one per demanding session for a session-deep principal. The
  ratchet has three sources and no fourth: no schema or code
  inspection decides instance sets (D11). Discovery RE-ARM: a run
  that moves the ratchet has its new siblings run in the same pass,
  before the wave settles. Arrival RE-ARM: a new demanding pair on a
  root re-arms every NARROWED node beneath it for that pair only.
  Precise per-instance dirtiness (B7): the node is singular (C11b) but
  its record keeps, per instance, the last committed reactivity log
  and a clean bit — a change dirties exactly the instances whose reads
  covered it (a keyed notification address names the instance; a
  space doc dirties all), the node's ONE subscription is the union of
  the instance logs (a pass that skips clean instances keeps their
  reads registered), and an N-user space costs O(affected instances)
  per change, not O(N) per node — the load-bearing property that keeps
  waves draining under sustained multi-user input (an exhausted wave
  holds W; a pinned W stalls the client's coverage-of-basis
  retirement).
- Read sets are authoritative IN MEMORY. Two persisted forms are
  distinguished, and confusing them is how v1 died:
  1. **The basis index (CORRECTNESS-BEARING for recovery)**: compact
     rows `(action, entity, seq)` — "output current iff these inputs
     unchanged since these seqs" — written INSIDE the wave's derived
     transaction (never own commits; amplification untouched). In-wave
     reads share the wave's own commit seq. Purpose: recovery and warm
     start are the SAME move — activation re-marks the dirty frontier
     by comparing recorded input seqs against current heads (§6), and
     skips still-current nodes instead of recomputing the world.
     Recovery DEPENDS on this index (own derived commits are echo-
     skipped live, so commit replay cannot re-mark the frontier); what
     keeps it on the right side of the no-payload lesson is its shape:
     ids + seqs only, overwritten in place per (action, instance) —
     never payloads,
     never per-run history — and admission never reads it. It is NOT
     the evidence log (§8's exception says the same). Prior art being
     REDUCED, not a kept shape: main's `persistentSchedulerState`
     persisted form (`scheduler_observation` full-JSON payloads with
     replay/snapshot/context-floor machinery, OFF by default on main)
     fails this section's own test; the v2 index is a NEW schema of
     standalone `(action, entity, seq)` rows replacing those payload
     tables (deletion + reduction tracked in plan Phase 1; pre-arc
     #3646 is the scope precedent).
  2. **The evidence log (FORBIDDEN — tripwires §8)**: per-run link
     payloads, certificates, replay records — 130 KB per map run in v1.
     The test between the two: payloads or per-run history ⇒ evidence;
     ids + seqs, overwritten in place per (action, instance) ⇒ basis
     index.
  W, `eventWatermark`, and the basis index are the correctness-bearing
  persisted forms; commit REPLAY bears nothing — recovery never replays
  (§6). Client reload needs none of this: every derived value is
  committed, so client reload is read-and-render.

The index's DDL, authored (closes scopes.md §8 item 1). This is the
engine-v3 migration Phase 1 stage C reduces the observation tables
to. The NORMATIVE content is the columns, the keys, and the drops;
SQL types and secondary indexes (e.g. an entity-keyed lookup mirror
of today's `idx_scheduler_read_index_lookup`) are implementation
detail:

```sql
-- One standalone table. No FOREIGN KEY clauses anywhere: v1's
-- satellites all hung off scheduler_observation; the v2 index
-- references nothing and nothing references it.
CREATE TABLE scheduler_basis (
  branch           TEXT,    -- engine-v3 branch, as on every table
  action           TEXT,    -- durable action identity/fingerprint;
                            --   restart-stable (a per-process
                            --   component would empty the index
                            --   exactly when recovery reads it)
  action_scope_key TEXT,    -- the INSTANCE that ran (scopes.md §7
                            --   M2 re-keying; scope_key vocabulary
                            --   is the shared `resolveScopeKey` in
                            --   the wire-shape module —
                            --   packages/memory/v2.ts — per
                            --   LD3, key-vocabulary.md §3)
  entity_space     TEXT,    -- the input doc's space: foreign reads
                            --   are logged reads too (cross-space
                            --   bullet above)
  entity           TEXT,    -- the input doc id
  entity_scope_key TEXT,    -- the input INSTANCE read
  seq              INTEGER, -- the input's seq at read time, in the
                            --   entity's own space's sequence;
                            --   in-wave reads share the wave's
                            --   commit seq
  PRIMARY KEY (branch, action, action_scope_key,
               entity_space, entity, entity_scope_key)
);
```

Rules the shape carries, binding:

- **Overwrite in place, per (action, instance)**: a run of
  (`action`, `action_scope_key`) — scopes.md §8's overwrite unit —
  REPLACES that instance's rows as a set. Never append beside a
  previous run's rows: per-run history is the evidence log's
  signature (§8).
- **Doc-granular, ids + seqs ONLY**: no path column, no payloads.
  Path precision stays in-memory in the reactivity log; a JSON path
  column is the first step back toward evidence.
- **Carriage**: rows are written INSIDE the wave's derived store
  TRANSACTION (above — never own commits). protocol.md §3 and §7
  carry the matching sanctions, so the closed metadata list stays
  closed: basis rows are engine table rows on the loopback store
  transaction, never commit metadata, never pushed, never read at
  admission.
- **Narrowing DELETES the rows it stranded** (S4, binding; AMENDED
  2026-08-16 with scopes.md §2's ragged ruling — fan-out stage A): a
  run's rows are recorded under its FULL instance address — its
  DISCOVERED scope resolved against its identity (`space`,
  `user:<p>`, `session:<p>:<s>`), the instance it actually served —
  never under the demand's stamp alone; and every key the run's
  address STRANDS — the stamp when it differs (a user-scoped watch's
  `user:<p>` on a node that discovered `space`; a session-scoped
  watch's `session:<p>:<s>` on a node that discovered `user`, the
  ragged case) and every strictly-broader key on the run's own chain
  (`space`; `user:<p>` under a session address) — MUST be cleared for
  that action in the SAME wave transaction, in both directions
  (narrower-than-stamp and broader-than-stamp), a real row set already
  recorded in the wave under a key never being overwritten by a
  clearance. Without this the stranded key's rows survive forever and
  §6's re-mark rule re-dirties a zombie at every activation — a
  `space`-key zombie has no runnable identity, so it can never
  overwrite its own rows and never stops being dirty; a departed
  session's over-keyed rows have none either. Sound by monotonicity at
  the top hop and within one principal (scopes.md §2 as amended), and
  for the same reason overwriting is: the rows are a basis cache, not
  history.
- **Interim retention is UNBOUNDED, and that is accepted** (S8).
  Rows at `space` and `user:<p>` keys are touched by no session
  retirement, and no execution-context bound exists —
  `scheduler_basis` specifies none. The
  narrowing rule above removes the one case that would grow without
  a run to overwrite it; everything else is bounded in practice by
  overwrite-in-place per (action, instance). A real bound is the
  session-data GC design's job — OPEN, and it must cover
  non-session keys too (scopes.md §8 item 2).

Dropped WHOLE in the same migration — the payload/history tables,
the two the new schema replaces, and the write index:

```sql
DROP TABLE scheduler_observation;         -- payload evidence (§8)
DROP TABLE scheduler_action_snapshot;     -- per-run history
DROP TABLE scheduler_observation_replay;  -- replay FORBIDDEN (§6)
DROP TABLE scheduler_context_floor;       -- nothing left to floor:
                                          --   it gated SHARED
                                          --   snapshots across
                                          --   principals; the v2
                                          --   index shares nothing
                                          --   (scopes.md §7, ruled)
DROP TABLE scheduler_read_index;          -- REPLACED (below)
DROP TABLE scheduler_action_state;        -- REPLACED (below)
DROP TABLE scheduler_write_index;         -- write links are
                                          --   evidence, not basis:
                                          --   staleness is decided
                                          --   by READS alone
```

`scheduler_read_index` and `scheduler_action_state` are REPLACED,
not reshaped — this section's NEW-schema ruling above. Both FK into
`scheduler_observation` (dropped, so the spine is gone) and both
key by `process_generation`, which accumulates per-process history
where v2 overwrites in place; reshaping would rewrite every column
and both keys — a replacement wearing an ALTER costume. The plan's
stage-C criterion is the backstop: after this migration the basis
index is the ONLY persisted scheduler state besides W and
`eventWatermark`.

**WARNING — the drop list is SEVEN tables, and an enumeration of the
observation tables yields SIX** (D6). `scheduler_context_floor` is
the one such an enumeration misses: it hangs off no observation
spine. A migration driven off the six-table enumeration leaves the
floor table behind and fails the plan's stage-C criterion for a
reason that reads like a mystery.
`migrateSchedulerObservationTablesToBasis` in
`packages/memory/v2/engine.ts` drives the drop from the seven-table
list above; anything that re-derives that list must too.

**NO BACKFILL** (D10). `scheduler_read_index` and
`scheduler_action_state` rows are NOT migrated into
`scheduler_basis`. The new table starts empty. A store that had
opted into `persistentSchedulerState` therefore loses warm start
ONCE, at the migration — acceptable because the index is a cache:
the first activation after the migration re-marks everything dirty
and recomputes, which is exactly what an absent index means (§6). A
migration that reads old rows would have to reinterpret
`process_generation` history as overwrite-in-place state, which is
the reshaping this section already rejected.

**Old client / new server compat is already answered** (D11): a
migrated server advertises no `persistentSchedulerState` capability
at hello, and a client from before the migration reads that as absent
state and runs fresh — the same path it takes against any server that
does not advertise it. No version handshake is needed.

**Protocol-layer deletions ride the same migration** (D7). With the
persisted form gone the flag gates nothing, so the following delete
WITH the machinery — this is derivable, not a fork, and is listed
here so no one re-derives it mid-PR:

- the `persistentSchedulerState` experimental flag and its ambient
  control point (`setPersistentSchedulerStateConfig`);
- its `serverFlags` capability negotiation at hello (both sides);
- the `scheduler.snapshot.list` RPC and its client wrapper;
- `CommitData.schedulerObservation` — the commit-carried
  observation payload.

**Collateral that "byte-identical" gates do NOT cover** (D9, S7).
Dev tooling and live docs read these tables directly and break
silently, since no product test exercises them:

- `packages/state-inspector` — `hasSchedulerBasisTable` in `db.ts`
  and the basis-row count in `queries.ts` name the table directly, so
  the inspector follows any change to it by hand;
- the `cf inspect` CLI surface that renders that output;
- `packages/memory/v2/sqlite/guard.ts` — the `CORE_TABLE_NAMES`
  blocklist that a pattern statement may never reference lists
  `scheduler_basis` and none of the dropped names; a table added to
  the engine goes IN, or pattern SQL gains a reachable engine table;
- the specs that described the persisted form — archived by stage C.3:
  `docs/history/specs/persistent-scheduler-state.md`,
  `docs/history/specs/scheduler-v2/per-doc-rehydration-persisted-form.md`
  (extracted from the still-live `per-doc-rehydration.md`), and
  `docs/history/specs/scheduler-v2/incremental-observation-adoption.md`.

The stage-C TRAIN carries both halves (the plan cuts it as three
PRs): C.2 carries this migration; C.1 deletes the certificate
surface it ships beside (`completeSchedulerScopeSummary`
/ `completeActionScopeSummary` — README §5), and that half is NOT a
hand edit: ~110 fixture files under
`packages/ts-transformers/test/fixtures/` embed the emitted marker,
so the GOLDEN-REGENERATION procedure is a required step of the
change, not a follow-up. Plan Phase 1 stage C sizes the full
surface. (The OFF-arm observation-adoption path, the one certificate
consumer outside the transformer, is gone with the observation
machinery — runtime-mapping.md N62.)

## 3c. CFC: the enforcement boundary is the action run

Batching commits MUST NOT coarsen CFC granularity. If flow control
evaluated at the wave commit, the wave's read-union would taint every
write in it — one action reading a secret would overtaint an unrelated
action's public write. Therefore, normatively:

- CFC evaluates at the END OF EACH ACTION RUN, against that action's own
  logged read set (§3b) — the same Runtime code path as a client today,
  including the existing rejected-write drop
  (`reportDroppedCfcRejectedWrite`, `scheduler/events.ts`).
- **The unit is the RUN, and a run is `action × instance`** (S5). Say
  "per action run", never "per action": under scope fan-out ONE
  action runs N times as N principals inside ONE wave (scopes.md
  §2), so an action-granular unit would merge N principals'
  provenance inside the load-bearing enforcement — the same
  over-tainting this section exists to prevent, one level down.
  Labels evaluate PER INSTANCE RUN.
- The wave transaction carries only writes that individually passed
  their action run's check; each write keeps per-action-run
  provenance for label purposes (the `cfcFlowLabels` ladder applies
  unchanged), and protocol.md §1/§7 carries attribution at exactly
  this granularity. The commit is transport; enforcement already
  happened per action run, in memory. The carried provenance's
  READER is main's existing read-time label derivation, unchanged
  (FP6, RULED 2026-08-03): a later run reading the cell — same
  wave or a later one — seeds its own ladder from the cell's
  labels; the carriage is what makes that input available
  server-side across waves, and no new enforcement point exists.
- Handler runs are actions: a server-side handler run gets per-run CFC
  exactly as its client run did. D-v2-1 moves WHERE handlers run, never
  the enforcement unit.
- **The run carries the READ CEILING of the session it acts as.** The
  stamp reads the memory server's session record for the run's
  `scopeKeyIdentity.sessionId` (`Server.sessionReadCeiling`) and
  attaches it as `WaveRunContext.readCeiling` — the ceiling the
  client declared in its signed `session.open` descriptor
  (protocol.md §1), or one the server assigned to the session. The
  sqlite builtin resolves one effective ceiling per run: the serving
  runtime's own option met with the carried one, `onExceed` meeting
  toward `fail` — and reads under it exactly as a client's own run
  reads under its option (06-cfc.md, "Runtime read ceiling"): the
  meet joins the request hash and filters rows for a session-scoped
  result. A shared result materializes under its query contract and
  carries labels on its array shape and rows; cell reads meet the
  carried session ceiling with the runtime ceiling before returning content. Never
  for a bookkeeping run, which acts as no session; a run acting as a
  session that declared none reads under the serving runtime's option
  alone. Verification-coverage.md OW64 is the coverage row.
- **The run's CFC trust snapshot carries the run's ACTING principal** —
  the event's server-stamped actor, the demanded instance's principal,
  or the delegated carriage's actor — never the serving runtime's
  ambient identity; a run with no acting principal keeps the service
  snapshot and cannot mint USER-NAMED current-principal claims. (The
  actor-less setup/defaults mint carve-out can still resolve a
  placeholder to the SERVICE under keep-service — the same ruling's
  flagged Q3 caveat, recorded in the OW34 design of record and
  arbitrated by the OW59 row's store audit.) (OW34-family,
  RULED 2026-08-21. The snapshot attaches at the SpaceServer's run
  stamp, before the run's first read, so the mid-run grant writes and
  the commit-prep label mints of one run read one value. SC-38 in
  `docs/specs/cfc-spec-changes.md` records the current-principal
  family's served-execution reading; verification-coverage.md OW59 is
  the coverage row.)

FORBIDDEN: wave-level label unions; deferring any CFC check to commit
or admission time; a server bypass ("the server is trusted") — the
server is trusted with AUTHORITY, not with skipping flow control over
user data.

## 3d. Transactions: the action tx seals into the wave

Today 1 action run = 1 `IExtendedStorageTransaction`, and the per-action
bookkeeping (reactivity log, CFC at close, basis capture, failure
isolation) hangs off it. v2 KEEPS that object and interface — `action(tx)`
is unchanged — and changes only the destination: server-side, an action
tx SEALS into the wave accumulator instead of committing to the store.
Sealing fires everything commit fires today: the read log feeds the graph
and basis rows (§3b), CFC evaluates against this action's reads (§3c),
and the action's passed writes join the wave — carrying the run's
identity annotations with them: the acting identity and, on scoped
writes, the explicit `scope_key` (protocol.md §1's transaction
identity model). Attach at SEAL time, when the run still knows who
it ran as (the demand's instance or the event's stamped actor); the
wave commit step only batches what sealing attached — by then no
single "current user" exists to consult, which is the model, not a
gap.

**Unstamped seals are FORBIDDEN (RULED 2026-08-05).** Sealing an
unstamped transaction under the flag is REFUSED with a loud error —
never an anonymous fallback: every server-side commit path MUST
declare its run context (the run's kind and durable action identity)
before it seals. The refusal lives at the seal destination and only
there — with no destination installed (the OFF arm, and ON-arm
client speculation) seal == commit as today, and nothing is checked.
(The completion-commit path never seals at all; §4 clarifies why it
opens no unstamped gap.) A transaction that sealed NOTHING (a
read-only probe — piece structure loads, pattern-identity reads)
contributes nothing and needs no context: the refusal guards writes
entering the wave.

**The sanctioned internal stamp kinds (stage F, discharging the
ruling's naming duty): exactly one — `bookkeeping`.** It marks the
serving loop's OWN writes — the watermark-doc advance today, the
pattern-swap setup write (§3e), and the acked-effect retirement
write when Phase 4 lands the client-effect channel (protocol.md §5
— a bookkeeping-stamped wave WRITE, one of protocol.md §1's
service-identity writes; earlier drafts mis-attributed it to
stage G). Stage G's own retirement — the outbox's delivery-acked
ROW delete — is no stamped write at all: it rides the direct-engine
plane (c) as an engine-table delete, never a commit (§1). Declared
at the stamping choke points the scheduler and runner own: the
reactive-action run, the event dispatch, the pattern swap, and — the
PIECE-START site (RULED 2026-08-13, the F1 fold-in) — the
demanded-piece startup path's setup/instantiation writes
(`ensurePieceRunning` → start → `Runner.#startCore()`: the self-minted
instantiation tx, the missing-stream-marker setup REPAIR, the
deferred piece-start/run transactions, and the runtime-internal
pattern-update/rollforward writes — the same `applySetupState`
output the pattern-swap choke point already stamps). A piece-start
commit that FAILS after start() resolved (the path is
fire-and-forget by design) must SURFACE — loudly logged in every
arm and counted into §7's `structureLoadFailures` on a serving
runtime via the installed observer — never be swallowed: a
swallowed refusal leaves the piece silently running against setup
writes that never landed. Its conflict class: bookkeeping writes
are advances that commute, so they REBASE like other
non-re-derivable writes; a rebase that conflicts semantically DROPS
the contribution whole — there is no event to requeue, and the loop
re-derives its bookkeeping next wave (a raced watermark advance is
re-advanced; watermark forgery is an accepted authored intrusion —
protocol.md §1's threat model). A fourth kind is a spec edit here
first.

**The flag-ON client's speculative-consequence deferred start
(RULED 2026-08-13; the Phase-4 P1-5 flag).** A flag-ON CLIENT's
deferred piece-start transaction minted as a SPECULATIVE
CONSEQUENCE — the start a speculative handler echo's commit
callback mints, carrying the create-only receipt + result wrapper
of that echo — is SANCTIONED to stamp `event-handler` kind with
the firing event's `eventId`, so the speculation overlay diverts
it as the handler consequence it is. Committing it authored (or
stamping it `bookkeeping`, which the overlay does not divert)
would race the SERVING side's own deferred start for the
create-only receipt; a client win suppresses the served navigateTo
entirely — no intent is ever computed — where a handler fire's one
authored act is the event (protocol.md §1's `authored` row; the
MINOR-3 receipt-race pin fails that mutation deterministically).
Scope, not exception: this section's refusal machinery and the
sole-`bookkeeping` rule above govern internal writes at the WAVE
SEAL destination, and the client's start tx never seals into a
wave (no destination is installed client-side — the refusal
paragraph above), so this sentence names the boundary rather than
carving an exception. The serving side's and the OFF arm's
deferred starts keep `bookkeeping`; the rule for wave-seal
internal writes is unchanged.

What decides the stamp is the run the start came FROM, not the
call site that minted the transaction, so every deferred start a
flag-ON client mints carries its originating run's context. The
NAMED-FAMILY start is the one that makes the difference visible:
it sets a piece up once the execution family it waited for lands,
and it mints its transaction afresh rather than from a commit
callback, so under the narrower reading it took `bookkeeping` and
COMMITTED. What it writes is the argument the originating run
computed, which for a speculative run is a value only the echo
holds — a collection whose create allocates a name and stores it
in the member it creates has the served member's stored name
replaced by the client's next allocation, while the collection's
map still records that member under the name the server gave it.
Both speculable kinds reach that start: a handler's echo, and a
derivation instantiating a pattern, which protocol.md §1's
ratified no-creation-carve-out holds to the same rule with no
exception for a transaction a start mints for itself. The whole
run context travels, so the entry retires under the originating
event and a cascade child stays reachable from its root, and the
lookup that finds it walks a transaction's wrappers to the
nearest stamp, as the serving side's wave-context lookup does.

**The bookkeeping-stamped deferred start's refusal arm: catch up
and start (RULED 2026-08-24).** A deferred start that keeps the
`bookkeeping` stamp — the one that commits to the store — can be
REFUSED for a stale confirmed read when the serving side
materialized the piece first (the first-hydration race,
verification-coverage.md OW45 arm B). Under the flag that refusal
is the expected outcome of losing the race, not a failure: the
client treats it as "the server won", waits for the conflicting
documents to arrive (the conflict's catch-up gate plus the named
document's pull), and STARTS the piece from the served documents
through the ordinary load walk — the reactive flow that catches
up with the server. The recovery arm COMMITS NOTHING: it neither
re-commits the refused materialization nor mints a start
transaction of its own, so the speculative-consequence sanction
above — written for the deferred-start transaction — has nothing
to govern there; the load walk's own setup/instantiation writes
keep the sanctioned `bookkeeping` stamp of the piece-start site,
exactly as a reload's do. The OFF arm keeps the refusal terminal
(a cross-tab race is the cross-tab mutex's story — this OFF
sentence is the COORDINATOR's conservative default, not part of
the 2026-08-24 ruling; the owner may re-rule it).

- The accumulator is a layered view: store snapshot at the wave's input
  seq + previously sealed writes. Actions run serially per space, so a
  later action reads earlier ones' sealed writes; intra-wave ordering is
  the scheduler's ordering. The input seq is the serverSeq the wave was
  opened at, and any seal opens one when none is open. A wave nothing
  sealed into is discarded at the next cycle's start and again ahead of
  the cycle's own watermark write, so the wave a cycle commits was opened
  at or after its predecessor's commit landed: a seal arriving while that
  commit is in flight (a read probe against the serving runtime) would
  otherwise leave a wave whose basis the loop's own commit has already
  passed, and the next cycle's writes to the documents it touched — the
  watermark advance among them — would be dropped against it. That input
  seq is what the wave CLAIMS its view covers, and the view its
  runs read is the replica's, which can sit below it: a commit admitted
  between a run's reads and the seal that opens the wave is counted in
  the basis and absent from the view. The concurrency rule's per-doc CAS
  is what covers the gap, and its pure-derivation arm says how.
- Failure isolation is per action: an aborted tx discards only its own
  writes; the wave keeps the rest.
- On a client (OFF arm, and speculation in the ON arm) seal == commit /
  overlay-apply as today — one abstraction, two destinations. Anchor:
  `packages/runner/src/storage/extended-storage-transaction.ts`.

**Mid-wave concurrency rule**: the wave commit CASes PER DOC against
the wave's read basis, and conflict handling is PER WRITE CLASS.
A write's class is determined by the producing RUN's kind — every
write of an event-handler run is non-re-derivable; every write of a
derivation run is a pure derivation write (RULED 2026-08-05). The
classes:

- **Pure derivation writes**: a doc whose head advanced past the basis
  (a concurrent authored commit landed mid-wave) has its derived write
  DROPPED from the wave commit. Dropping is sound exactly because
  derived values are re-derivable, and the drop RE-ARMS NOTHING
  (RULED 2026-08-05): the concurrent commit is the next wave's input,
  and it recomputes exactly the runs whose recorded reads it dirties —
  the ordinary dependency path, with no superseded-write mark (the
  ruling note below). Count drops as `supersededWrites` (exposed in
  §7's counters). This class CASes against a second basis as well: the
  seq the replica stood at for the doc when the contribution SEALED. The
  replica gap above is when the two differ, and a doc the replica had not
  taken the head of holds a value the derivation that wrote it never saw,
  so committing that write would be the blind derived write this section
  forbids — even where the head sits at or below the wave's basis.
  Recovery is the same as for any other drop, and needs no addition: a
  derivation that read the doc carries it in its basis rows, so the
  arrival of the commit it missed re-runs it.

  An INTRUSION is what makes that second basis a conflict. A serving
  tenure's own derived commits advance a document under runs still in
  flight as a matter of course, so a view older than the head means
  nothing by itself; the drop needs a commit after that view which the
  tenure's own derived commits do not account for — a client's authored
  write, another holder's derived write, a system commit. A document only
  this tenure writes therefore never reaches the drop, which is this
  section's own reading of a derived document: there are no other writers
  on one.

  The seal is the moment to read the replica at, and the replica is what
  to read rather than the run's own recorded read seqs. Later is a
  different view — the commit step runs after the heads query, by which
  time a frame may have landed and the replica no longer says what the
  run derived from. And the recorded seqs are not that view: a sealed
  transaction has passed its commit-time claim check, which re-reads
  every document it snapshotted, so a run whose replica is current on a
  doc read the content the store holds however old the seq it recorded.
- **Non-re-derivable writes** — `eventWatermark` advances,
  handler-consequence writes, effect intents — are REBASED AND RETRIED:
  re-CAS against the new head, merging at field level (these are
  advances and appends that commute with concurrent authored appends).
  If the rebase conflicts semantically, roll the affected events back
  to unconsequenced (requeue) rather than lose them. events.md §4's
  atomicity survives the retry: the watermark advance and its
  consequences move TOGETHER into the rebased commit, never
  separately. This class CASes against the wave's basis alone — the
  pure-derivation arm's lower basis does not carry here. Its conflict
  arm rebases or requeues rather than dropping, and requeueing against
  a seq the replica has not caught up to yet is the sustained-traffic
  livelock this section forbids.

An event-delivery processing checkpoint is an internal
`bookkeeping`-stamped write. A terminal error, drop, or
`needs-attention` notice is an `event-handler`-stamped
non-re-derivable contribution carrying that event's consequence and
watermark advance. Sealing a terminal contribution is not durable
success: the serving loop keeps the event's arrival barrier closed
until the closing wave confirms that the complete contribution
committed. A rejected, resolved-error, rebased-out, or refused-wave
notice leaves the entry pending, records its checkpoint or notice-write
failure, and cannot release later events. This contract adds no
same-wave dependent-withdrawal mechanism. A failed processing-state write
re-derives on a later input, activation, or typed recovery wake. A quiet space
does not add a timer solely to retry that write: it remains loudly pending
through the failure counter and warning until one of those valid wakes arrives.

Dropping would be unsound for authored values, which is one more reason
the classes never share a commit. Whole-wave CAS failure is FORBIDDEN
(livelock under sustained authored traffic), as are blind derived
writes (clobber).

**Recomputation after a drop arrives by DEPENDENCY ONLY (Q1, RULED
2026-08-05).** A dropped superseded write has no recompute trigger of
its own: basis rows are reads-only, so an intrusion on a producer's
OUTPUT doc that the producer never read re-arms nothing — and the
ruling keeps it that way; no re-arm mechanism exists. In the owner's
words:

> if it's truly a derived doc, there can't be other writers anyway.
> if it's shared state (which derives can update as well), then it's
> either a non-conflicting operation (push) or more likely it'll
> read the value first and so it will be recomputed because it's in
> the read list — owner, 2026-08-05

Unpacked for implementers: (i) a genuinely derived doc has no
authored writers, so the superseding race does not arise for it;
(ii) shared state that derivations also update either uses
non-conflicting operations or is read-modify-write — and a
read-first derivation carries that doc in its READ LIST, hence in
its basis rows, hence the authored intrusion re-runs it through the
normal affected-graph path; (iii) a dropped superseded write is
therefore NOT re-armed by the drop itself — if a blind-writing
derivation races an authored writer on shared state, the derived
output waits for the next input change (accepted). The corollary is
deliberate: a survivor whose writes were dropped per-doc still lands
its BASIS ROWS — its reads are true, and no recompute-owed mark
exists.

A contribution whose **read dependency is withdrawn** has a separate
invalidation obligation. The accumulator records when its withdrawn-read
closure discards an entire reactive run. Once the replica finishes rolling
that run back, the scheduler re-arms its current, still-registered instance
against the next wave's basis. This covers a read of an unchanged field through
a pending document whose sibling field was discarded: rollback leaves the
read's value equal, so a value-change notification alone cannot recover the
withdrawn result. The retry preserves the run's consumed CFC trigger reads and
does not dirty accepted sibling instances. Removing the action or its scoped
instance invalidates that registration's obligation, including a run whose body
or seal is still pending. A newer sealed publication makes the old withdrawal
inert. A run with no new contribution preserves the outstanding publication's
recovery obligation and keeps its refreshed subscriptions. This settlement
observer is outside the pending-commit barrier that the serving loop drains before committing its wave.

An ordinary write elided against pending state retains internal commit
provenance for that dependency. This applies to raw storage writes, normalized
result values, and preserved output links. Normalization records the actual
compared target, including descendants reached through scoped links and write
redirects. A later run that elides one pending output and
writes another must withdraw if the elided value is discarded. Read-only foreign
spaces carry the same internal dependency into the wave. A derivation that only
elides pending outputs automatically contributes a write-free acceptance
obligation, so a replacement registration can recover the outputs it reused
without inheriting its predecessor's registration. Ordinary read probes,
confirmed-only no-ops, and non-derivation runs do not acquire this obligation.
The basis is conservative at document granularity:
when an older pending layer exists, repeating the transaction's own replacement
can retain that layer's dependency too. Its withdrawal can require one fresh run
even when the replacement did not need the old value. These reads do not create
scheduling subscriptions or CFC value taint. UI-blind writes retain their existing
blind-write behavior;
this provenance does not extend the raw API's CFC attempted-target coverage.

This dependency invalidation does not re-arm a direct output supersession, a
failed foreign writer, or a failed commit precondition. Those dispositions
retain their existing dependency and demand rules. A reader of a failed
contribution can recompute from the rolled-back state without retrying its
failed producer.

**The event REQUEUE above is not events.md §5's event DROP** (T3).
Two different conflict notions share the vocabulary of this section
and must not be collapsed:

| | when it applies | consequence |
| --- | --- | --- |
| REQUEUE (this section) | the handler RAN and its consequence commit lost a per-doc basis CAS — the event is valid, only raced | rolled back to unconsequenced and retried in a later wave |
| DROP (events.md §5) | the handler CANNOT RUN AT ALL — its preconditions are gone (target stream/doc deleted, CAS base unrecoverable) | no consequences; a dropped-event notice on the stream entry, `eventWatermark` advances past it |

(The per-doc DROP of a superseded DERIVED WRITE, first bullet above,
is a third thing again — a write, not an event.) The event-drop
predicate is stated once, in events.md §5; this section cites it and
never restates it. A raced event is never dropped, and an unrunnable
event is never requeued — requeueing one would wedge the stream,
which is the failure `eventWatermark` advancement exists to prevent.

**Multi-space seals** (`.inSpace(...)` provisioning): one tx writes one
space by DEFAULT; a tx crosses only via the explicit opt-in chain —
`.inSpace()` → `optIntoInSpaceMultiSpaceCommit`
(`builder/pattern.ts`) → `Runner.enableCrossSpaceChildCommit()`
(`runner.ts`, commit order `[children..., parent]`) →
`enableMultiSpaceWrites` (`interface.ts`). Opted-in writes are
sequenced at the commit step — foreign authored commits first, home
derived commit after success — per protocol.md §2b (today's
`V2StorageTransaction.#commitMultiSpace()`/`#runSplitCommits()` in
`v2-transaction.ts`: sequential, stop at first failure). The wave does
not close until the
split completes or fails as a unit (same-host store sequencing, not a
network await).

Phase 5 SANCTIONED the crossing, and the accumulation gate (RULED
2026-08-14 (c)) survives as its AUTHORIZATION seat: a serving wave
ADMITS a foreign-space write at ACCUMULATION iff BOTH hold —

- the sealing run's context carries the §2b delegated carriage
  (acting identity AND `capabilityRef`, the provisioning shape
  protocol.md §2's server-produced authored row requires on EVERY
  foreign commit); and
- the ACTING identity holds a **structural write grant for the
  TARGET space**, probed against the co-hosted memory server
  (`foreignWriteAuthorityFor`; the wave REFUSES the accept posture
  at construction without an authority probe, so the gate cannot be
  configured vacuous — carriage alone is minted for every acting
  run and authorizes nothing). The structural grants:
  **owner-by-identity** (the target space IS the actor's own DID —
  their home space, the wish bootstrap's target),
  **fresh-store creation** (the target store does not exist — §2b's
  sanctioned provisioning, where the creating commit makes the
  space the actor's; the probe checks the space NAME is a
  well-formed DID and never materializes a store itself, so a
  carriage-bearing write to a garbage space string cannot silently
  provision one — the recorded residual is that a well-formed FRESH
  DID still provisions at commit, §2b's sanctioned minting with
  quota attribution the standing residual, README §3.8), or an
  **explicit ACL grant** (the target's own ACL document grants the
  actor WRITE — checked mode-independently: this is the serving
  plane's normative fail-closed interim, not the client ACL
  rollout, so neither the service-DID blanket nor the
  missing-ACL-populated-legacy compat arm applies). Per-DOC grant
  RESOLUTION stays the OW13 owed hardening.

A carriage-less foreign write — the lunch-wall class: a run resolving
against the SERVICE identity's ambient state — and an UNGRANTED one —
an actor reaching for a space it holds no authority over — both
refuse at the seal sink, action-scoped (that action's tx fails loudly
and is counted into §7's `foreignWriteRefusals`; its already-sealed
spaces withdraw per this section's failure isolation) while the wave
commits everything else. The commit-step foreign-engine resolution
(the serving loop resolves the wave's foreign co-hosted engines ahead
of the commit step) keeps the sink's delegated validation as
backstop, and is itself failure-ISOLATED per space: a foreign engine
that cannot resolve fails exactly the contributions targeting it
(events requeue and replay; derivations drop to recompute-on-demand;
counted into §7's `foreignEngineFailures`) while the wave commits the
rest — never a loop failure, so one misdirected crossing can never
park the HOME space. The producers the gate admits: `.inSpace`
provisioning handlers (the event's acting principal + grant), and
per-demanding-identity wish resolution — a demanded run acting as its
demander (scopes.md §5) whose home-space bootstrap writes ride the
same crossing (builtins.md §5 carries the register row; RULED
2026-08-14).

## 3e. Pattern updates

The SpaceServer owns the pattern-source watcher and the hot-swap. The
two halves have different owners. FOLLOWING a piece's source origin
belongs to whoever explicitly OPENS the piece (piece-source-lifecycle.md).
Tenure activation owes its space the EXISTENCE of a root, without following
that root's source. A served wish explicitly opens the runtime-supplied
sidecars it needs through `openSidecarSurface` and `SourceReconciler.open`;
existing sidecars follow their origins on that open. The ON client only
references those sidecars, leaving the serving runtime as their opener. The
SWAP is the server's: a pattern-pointer
write is an ordinary authored input that dirties the piece, the swap is
the server reacting to it, and the swap's setup write stamps the
`bookkeeping` kind and enters the wave
(§3d). Because a sealed setup can still be WITHDRAWN at the wave
commit, the swap replaces the running graph only after DURABLE
acceptance — on withdrawal the old graph stays (old-graph-plus-new-
pointer is a coherent not-yet-swapped state; the reverse is the
broken-setup class). The pointer write itself stays authored-class
under the writing principal. A served source update (the `setsrc`
lifecycle verb, [server-pattern-lifecycle.md](../../features/server-pattern-lifecycle.md))
moves the pointer in a setup transaction that COMMITS DIRECTLY to the
store rather than sealing — the serving loop's own derived-class commit,
serialized with the wave's seals, its own read set validated by the
store as a client commit's — because module-loading.md lets update
authority publish only from a transaction that commits to storage
itself. A wave open at that commit takes a contribution sealed AFTER it,
whose reads of the docs it wrote saw the commit, as having observed them
(§3d's conflict set exempts them for that contribution, and the sink
holds the store to that exact head), so the swap's first derivation
under the new pattern lands in the same cycle. Root creation and explicit wish-sidecar opens
fetch system source through the serving runtime's API URL. Those fetches remain
within verification-coverage.md OW55's source-trust obligation; root ensuring
adds no source-following probe for an existing root.

## 4. Effectful nodes: memoization contract

For `fetch*`, `generate*`, `sqlite*` (the §3.5 effectful class):

- **Memo key** = stable hash of (builtin id, canonical JSON of the
  resolved request inputs — after cell dereference, before any network
  activity). Canonicalization: sorted keys, no undefined, links by entity
  id + path.
- **Storage**: the result is an ordinary cell commit; the memo key is
  written alongside the result (same doc, `requestHash` field). A builtin
  may also write this field with `pending: true` to select the current
  request; that marker alone is not a stored result. No new tables.
- **Hit rule**: if the recomputed key equals the stored key and a settled
  result or error is present, the stored result IS the node's value — no effect fires. This is what makes
  restart-recovery safe: recompute pure nodes, re-derive keys, reuse
  results.
- **Miss rule**: enqueue the effect on the outbox with the key AND
  the run's identity carriage — the result-cell address including
  its instance `scope_key`, plus the run's acting identity where it
  had one, plus the run's CFC LABEL BASIS (FP6, RULED 2026-08-03;
  RULED 2026-08-05 STRUCTURAL: the carriage carries the basis
  reference, and the completion's writeback re-reads the request
  inputs so labels derive from the basis AS IT STANDS at writeback,
  never from a frozen at-seal snapshot).
  The completion commit is derived-class, so it carries
  protocol.md §1's annotations like any other — but it never passes
  through §3d's sealing (the run is long over when the response
  arrives), and the memo key cannot supply them (the instance is
  hashed in, not recoverable), so the outbox entry is the only
  carrier. No unstamped gap opens here: the completion commit's
  identity annotations are sourced from the carriage captured at
  the ORIGINAL run's seal — necessarily stamped, per §3d's refusal
  — so completion commits inherit stamped provenance transitively,
  and no unstamped derived path exists (clarification, adjudicated
  2026-08-05, vetoable). The completion WRITE's labels derive from
  the carried request basis — an external result inherits its
  request's confidentiality; results are never default-unlabeled. On
  completion, commit result + key in one derived-class commit and
  inject the result-cell dirtiness IN-PROCESS, post-commit — the next
  wave consumes it directly. The subscription's copy of the completion
  commit is an ordinary self-echo and is skipped (§3). A crash between
  completion commit and consumption is covered by recovery: the basis
  index shows the consumers stale against the result doc's head (§6).
- **In-flight dedupe**: one outstanding effect per (key, result
  target) per space; the target includes its resolved user/session instance.
  A second miss on the same (key, target) attaches to the in-flight effect.
  Before dispatch, each accepted attachment retains its own release check.
  A synchronous release refusal selects the next attachment under that
  attachment's captured run context. Once an attachment dispatches, the key
  deduplicates until its work and readable completion retire; a thrown error
  or rejected work promise does not select another attachment.
  Completion acceptance follows the currently selected request in that
  instance, so A→B→A may reuse the original A without accepting a stale B. Two DISTINCT result targets
  carrying byte-identical inputs are two distinct requests, and
  each egresses (RULED 2026-08-13; the earlier per-key-only
  wording promised a cross-target sharing that §4's own miss
  rule — exactly one result-cell address per entry — could not
  deliver). A response-sharing layer (one egress fanned to N
  per-target writebacks, restricted to idempotent-marked
  effects) remains a possible future optimization, not an owed
  item.
- Failures commit an error-shaped result (the existing builtin error cell
  conventions) with the key, so retries are input-driven (inputs change →
  new key), never timer-driven loops.

FORBIDDEN: re-firing an effect whose settled stored result has a matching key; effect retry
timers inside the loop; a "pending effects" table (the EFFECT half of
the outbox is
process-local; on crash, missing results are re-missed from keys —
the durable rows of §5 carry APPENDS, never effect state).

## 5. The outbox

- EFFECT requests: a process-local queue of (space, memo key,
  request, authority
  handle, label basis + identity carriage — §4's miss rule: the
  result-cell
  address with its `scope_key`, the acting identity where the
  run had one, and the run's CFC label basis (FP6, RULED
  2026-08-03; structural per the 2026-08-05 ruling — the basis
  reference rides the entry and labels re-derive at writeback)
  so the completion write's labels derive from its
  request's — an external result inherits its request's
  confidentiality. Process-local is SOUND here: a crash re-misses
  the effect from memo keys (§4, §6; at-least-once, already ruled).
- **Cross-space event appends are DURABLE (FP1, RULED
  2026-08-03).** Their entries are engine-table rows written INSIDE
  the emitting wave's own store transaction — the basis-row
  carriage pattern, sanctioned in protocol.md §7 — and DELETED on
  delivery-ack: a queue that empties, never history, so the
  no-per-run-persistence lesson holds. A row carries the event
  (payload bounded by the event, never graph-scaled) plus the
  acting
  identity (`actingPrincipal` + `actingSession`) + `capabilityRef`
  that the target's admission validates and stamps `firedAt` from —
  actor inheritance crosses spaces through exactly this carriage
  (events.md §2). Activation re-sends pending rows (§6 step 5);
  the target's `eventId` horizon keeps processing exactly-once.
  This closes the crash window between wave commit and delivery
  that a process-local append queue could not survive.
- `.inSpace` provisioning rides NEITHER queue today: its foreign
  commits are SEQUENCED at the wave commit step — foreign-first,
  home-after-success, stop-at-first-failure (protocol.md §2b) — so
  a crash between the halves leaves the event unconsequenced and
  the deterministic replay converges. Outbox carriage is its
  sharded-future form only (§2b's closing note).
- At-least-once; for effects, idempotence comes from the builtins'
  request-hash guards — the claim-time completed-request check (a
  stored hash matching with a result/error present is never
  re-claimed) and the write-time hash re-check — plus the completion
  committer's all-no-op short-circuit (RULED 2026-08-05; the earlier
  "a duplicate completion writes an identical key and is a CAS
  no-op" wording described a mechanism the completion path does not
  have). Completion commits deliberately carry `basisSeq = NOW` — no
  per-doc CAS re-verification; a concurrent intrusion on the result
  docs surfaces through the hash guards re-reading current state —
  and the outbox's READABILITY-GATED in-flight retirement closes the
  race the guards alone cannot see: the effect's key retires only
  when every completion commit's writes are readable by the serving
  runtime, so a stale re-admit of the key dedupes instead of
  re-claiming against unabsorbed state. Readability is IMMEDIATE:
  sealed commits — waves and completions alike — confirm on the
  serving replica at verdict time, never parked (an engine-plane
  commit's catch-up marker can never arrive, so parking one wedges
  retirement permanently — the completion-visibility wedge; the
  retirement barrier stays as the belt over that structural
  guarantee). And completion writebacks commit AUTHORITATIVELY:
  their memo-state writes go through even where the replica's
  optimistic view — possibly a doomed sealed overlay a later wave
  supersede-drops (§3d) — calls them no-ops, so a drop can never
  tear the stored hash from the result it serves; the all-no-op
  short-circuit above accordingly fires only for genuinely
  write-free writebacks, and identical re-asserts are idempotent at
  the store. For appends, idempotence is the `eventId` dedupe
  horizon.
- When several accepted contributions to one document share a
  wave sequence, their settled local value includes every contribution in
  local sealing order. Local promotion also preserves that order between
  verdicts, including in the view that excludes speculative pending layers.
  An authoritative frame at the same sequence already
  contains the wave's value and prevents replay of accepted contributions;
  a newer frame also takes
  precedence. `memory-v2-wave-promotion.test.ts` covers this boundary across
  space, user, and session instances, including reordered verdict delivery,
  withdrawal, and noncommutative appends. Foreign provisioning groups
  contributions by actor and grant, so one wave can commit several batches
  to a foreign space in a different order from local sealing. Accepted verdicts
  for each space follow that space's server sequence, retaining sealing order
  within each batch. The settled replica therefore matches the engine when
  nonadjacent contributions share a foreign batch.
- Authority: the capability handle bound at wiring time (README §3.8);
  the outbox holds provider credentials via the existing broker; the
  SpaceServer's runtime never sees raw secrets.
- Per-space budget hooks live here (Phase 6 — LANDED): a cap on
  DISPATCHED-but-unsettled network effects (`maxOutstandingEffects` —
  README §3.8's "outstanding LLM calls") and an egress-rate token
  bucket (`egressRatePerSecond`, burst = one second's tokens), both
  `SpaceServerPolicy` knobs threaded from the toolshed bootstrap's env
  (`SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS`, default 16 — the
  LITERAL `0` is the only opt-out to unbounded; an unparseable or
  negative value falls back to the default with a warning, so a typo
  can never disable the production bound — FAIL-CLOSED;
  `SERVER_EXECUTION_EGRESS_RATE_PER_S`, default unpaced;
  `SERVER_EXECUTION_FLUSH_DEADLINE_MS` tunes §3's T_flush the same
  way). The gate holds DISPATCH only: the in-flight dedupe entry exists
  from admission, so a re-admit during a hold attaches instead of
  double-firing. LOCAL kinds (sqlite-query — no egress) bypass the
  gate. On park/close, held dispatches DROP — the crash-equivalent
  posture (memo re-miss re-fires on re-activation); firing them would
  egress work for a dead runtime. Holds are counted
  (`outbox.budgetDeferrals`, §7) — growth under load is the budget
  working, not a failure.

## 6. Recovery, precisely

On activate after crash or deploy:

1. Acquire lease, read watermark W.
2. Re-mark the dirty frontier from the BASIS INDEX (§3b): a node is
   dirty iff a recorded input seq is behind that doc's current head.
   Recovery is index-guided re-marking, NOT commit replay — own derived
   commits are echo-skipped live (§3), so replay could not re-mark the
   frontier anyway. Subscribe from the head the index scan ran against;
   later commits arrive as ordinary input. Rows whose `entity_space` is
   FOREIGN (§3b's cross-space reads) are judged against that space's
   own co-hosted engine's head (Phase 5); a failed foreign resolution
   degrades to surfacing, never a wedge — correctness rides
   recompute-on-demand either way.
3. The first wave recomputes the dirty frontier; memo hits suppress
   re-firing completed effects; memo misses re-fire effects whose
   results never landed. External effects are therefore at-least-once
   across crash/lease-handover (the request may have left the process
   before the crash) — RULED and accepted (owner, 2026-08-02). A
   fired-marker (a durable "request left" write ahead of each effect)
   was considered and REJECTED: it costs a commit per effect yet
   cannot close the window — the marker write and the request can
   still straddle a crash.
4. Undelivered events — stream head past `eventWatermark`, the §1 boot
   check — reprocess (events.md §5); events at/below the watermark are
   skipped by the idempotency rule.
5. Pending durable outbound-append rows (§5, FP1) RE-SEND; a
   duplicate of an already-delivered append dedupes at the target's
   `eventId` horizon. Nothing regenerates an EFFECT request from
   here — those re-miss from memo keys in step 3, by design.

There is NO replay log, NO persisted run observations, NO snapshot of
scheduler state beyond W, `eventWatermark`, and the basis index's
ids + seqs rows (§3b — payloads stay FORBIDDEN). If recovery seems to
need more than these, the design is wrong somewhere else — stop and
escalate.

## 7. Counters (implement with the loop, not after)

`events.visibilityBarriers` counts ordered publication/response attempts for
lagging event views. `visibilityRecoveries` counts matching identities after
those attempts, and `visibilityDeferrals` counts scans that still stop at a
mismatched identity. `deferredRescansArmed` and `deferredRescansFired` count
the backstops an active tenure scheduled and the callbacks that ran, across all
transient drain outcomes. Only a serving tenure arms one: a park clears the
armed backstop, and a deferral reaching a parked tenure arms none, so the
pending entries wait for the next activation's own scan.
`deliveryFailureWakesArmed` and `deliveryFailureWakesFired` are the
delivery-failure backstop's pair — the wake a failed checkpoint arms at its
budget boundary — and that same tenure discipline holds for it. The two `Armed`
counters read differently, because the two backstops re-arm differently: a
deferred rescan with a timer standing arms nothing further, so
`deferredRescansArmed` counts distinct backstops, while a re-derived delivery
checkpoint cancels the wake it replaces and arms another, so
`deliveryFailureWakesArmed` counts the passes that reached the entry rather than
the one wake standing for it. An armed timer can be unnecessary if input wakes
the drain first; these counters do not equate each deferral with an elapsed
timer interval or each cycle with a durable commit.

Exposed via the existing `/api/health/stats` shape, replacing v1's pool block:
`servingLoop: { activeSpaces, waves, wavesBudgetExhausted, supersededWrites,
authoredSeen, effectAcks, derivedCommits, structureLoadFailures,
structureLoadDeferred, structureLoadStuck, structureLoadTerminal,
structureLoadConfirmationsSkipped, structureLoadRearmed, watermarkClamped,
storeReads, storeRefreshes, unstampedSealRefusals, foreignWriteRefusals,
foreignEngineFailures, warmRequests, watermarkLag, demandArrivals,
undemandedNarrowingRuns, earlyEmitRefusals, demand: {demandedRows,
demandedInstances, demandedInstancesMax, demandedPairs, demandedWriters,
demandedWritersMax, demandRootEnters, demandRootLeaves, notCurrentRearms,
demandPasses, demandPassMs, demandKeysReconciled, structureRootsPreloaded,
pushGrowthWakes, watchWakes, warmWakes}, settle:
{series, dropped}, settleAdvances: {count, lastDelta, series, dropped}, events:
{appended, processed, coalescedPerWaveMax, skippedIdempotent,
drainInFlightSkips, visibilityBarriers, visibilityRecoveries,
visibilityDeferrals, deferredRescansArmed, deferredRescansFired,
lt1LeftoversPurged, lt1LateSealsRefused, orphanDeliveriesRefused,
handlerNotRunDeferrals, loadParkDeferrals, loadParkFailures,
deliveryDeferralsActive, deliveryFailuresActive,
maxAccumulatedDeliveryFailureMs, deliveryFailureWakesArmed,
deliveryFailureWakesFired, needsAttention: {total, byPhase},
needsAttentionSealFailures, deliveryCheckpointWriteFailures, explicitRetries,
dropped}, memo: {hits, misses, inflight}, outbox: {queued, completed, failed,
budgetDeferrals}, lease: {held, lost}, parkedRuntimes: {retained, reused,
discarded, held}, push: {prioritizedSessions, followerSessions,
mixedFlushes} }`
(`parkedRuntimes` counts the runtimes idle parks kept, those a successor
tenure served with, and those disposed unused — expired, evicted, tainted,
or turned down at activation because the store head moved — with `held`
the number kept now; §1's Parking;
`structureLoadFailures`/`structureLoadDeferred` count demanded-structure loads
that threw / could not land yet — never-a-piece id classes are EXCLUDED from
piece demand and count nothing, RULED 2026-08-07; `structureLoadFailures` also
counts a piece-start commit that failed AFTER its start resolved (the §3d
piece-start site's surfaced fire-and-forget failure, stage P2-F);
`structureLoadStuck` counts roots whose CONSECUTIVE-deferral streak crossed the
space server's stuck threshold — once per crossing, with a WARN naming the space
and root at the crossing and at each doubling of the streak — so a
forever-parked root (a demanded piece whose program docs never materialized,
verification-coverage.md OW46) is a health-stats fact instead of an
undifferentiated share of the per-attempt `structureLoadDeferred` aggregate; the
streak clears when the root starts or terminalizes;
`structureLoadTerminal`/`structureLoadRearmed` carry the demand-cycle terminal
state. A root with no pattern metadata is confirmed before it parks, and the
co-hosted engine — the authority the serving replica syncs from — answers first.
It is read at the chain termini the attempt resolved, the demanded instance's
and the scoped-to-space fallback's alike, at the instance the replica itself
resolves their scope to. A pattern pointer it holds at none of them is one a
second traversal could not read either, so the attempt's verdict stands and
`structureLoadConfirmationsSkipped` counts the traversal not taken. A pointer it
holds means the replica read behind the store, and a terminus it cannot be
addressed for from here — another space, a scope the tenure's session cannot
key, a closed database — is a question it does not answer: both confirm by a
second owning-result traversal, including the scoped-to-space fallback. Each
traversal syncs the complete addresses it reads; cycle detection distinguishes
scopes. Confirmation does not subscribe to additional addresses formed by
combining observed IDs with other scopes. A confirmed root parks terminal,
counted once, and a commit touching an observed document re-arms it. Admissions
racing either traversal invalidate a no-metadata verdict when they touch an
observed document; pending foreign novelty hidden by a sealed write also
prevents terminalization. These invalidated attempts count as deferrals.

The retry follows frame application within the settle loop. Its structure load
and demanded derivations finish before the watermark covers the triggering
input. A shadowed retry waits for the replica's shadow-flip signal, allowing
the wave to commit the sealed writes that make its input visible. The load pass
runs under §3's flush deadline and is single-flighted across cycles of one
tenure. Demand departure drops terminal decisions; a new tenure starts its own
pass. Park cancels structure loading at its next asynchronous boundary, before
any subsequent piece start. Completion from a parked tenure cannot publish a
terminal decision; park does not wait for unresolved pattern loading.
`watermarkClamped` counts
non-exhausted cycles whose foreign-write shadow floor is below an input batch
head above W. An event-visibility floor can constrain the same cycle, so the
counter does not isolate the marginal effect of the shadow floor. The shadow
clamp covers inbound foreign novelty still hidden by a parked own write; it
is honesty, not failure,
and lifts by itself; `storeReads` counts the engine reads that the store
read-through posture (§1 plane (a)) performs for serving replicas, and
`storeRefreshes` counts the held documents it re-reads off the feed, both
zero while the posture is off; `unstampedSealRefusals` counts write-carrying
transactions refused at the seal by §3d's unstamped refusal —
structurally ZERO when every server-side commit path declares its
run context, so any non-zero count names an undeclared commit path,
the class that wedged the resumed list builtins' recovery seeds
until they stamped `bookkeeping`; `foreignWriteRefusals` counts §3d's
accept-gate refusals — carriage-less AND ungranted foreign writes,
both action-scoped; `foreignEngineFailures` counts commit-step
foreign-engine resolutions that failed and were isolated per space —
a growing count names a foreign store that persistently cannot open,
never a home-space outage; `warmRequests` counts explicit warm
requests issued — one per foreign provisioning batch a wave durably
committed (§1's third activation trigger, RULED 2026-08-21) — so a
provisioning flow whose target never derives its staged setup is
diagnosable from the issue count against the target's activity) (`effectAcks` counts
effect-channel ack writes, so the
§3 amplification metric is computable from counters alone —
`settleAdvances` counts S1's drain-settle quiescence advances (RULED
2026-08-19, protocol.md §4; count, lastDelta, bounded series of
{space, from, to, at}) and is what amplification/settle arithmetic
subtracts, since each advance mints one designed advance-only wave at
a quiescence transition, split from the per-input `settle` series so
W4's settle metric can exclude those waves;
`outbox.budgetDeferrals` counts Phase-6 budget dispatch holds — §5;
the `push` block is the memory server's Phase-6 push-priority
counters (protocol.md §3), nested under `servingLoop` in the health
route so the OFF-arm response never changes shape —
`push.prioritizedSessions`/`push.followerSessions` count sessions
EVALUATED per group in mixed batches, frame or no frame: an ordering
witness, not a delivered-frame metric). Every
Phase gate in the plan reads these counters; tests MUST assert on
counters, not logs.

The (d′) `demand` block (stage-C design build W1, 2026-08-19) is the
demand-model accounting after the demand walk was deleted — so there is
NO `walkRuns` counter, and its absence is the structural witness (a
`demand-walk:*` action anywhere in the graph fails the T9′ pin).
`demandedRows` is the closure the last pass saw (rows =
⋃ `session.trackedIds` over the space's client sessions, service
excluded); `demandedInstances`/`Max` the distinct registry keys and
their peak; `demandedPairs` the total (instance key, demanding pair)
entries; `demandedWriters`/`Max` the standing demand-root set (the
`isDemandRoot` disjunct, §8's bracket) and its peak; `demandRootEnters`/
`demandRootLeaves` the ACCUMULATED root transitions across the space's
whole life (they are held on the space's stats, not read from the
current runtime's counters, which zero on a reactivation);
`notCurrentRearms` the per-key not-current-for-pair re-arms (B7's clean
bit); `demandRootEnters`/`Leaves` fold the delta SINCE THE LAST FOLD, so
a transition the registration/unregistration hook fires BETWEEN passes is
counted, not lost to a pass-start snapshot (W1 review MINOR-2);
`demandPasses` the pass count and `demandPassMs` the pass's total WALL
time — which INCLUDES the awaited structure-load segments
(`ensurePieceRunning`) for first-demand/pending root keys, NOT only the
reconcile (the reconcile does no per-row engine read; the label is wall
time, review MINOR-3);
`demandKeysReconciled` the instance keys the passes reconciled, accumulated
over the passes whose reconcile completed, so a pass that throws partway adds
nothing.
The pass reads the demand set per session (`demandForSpace`): the memory
server keeps each session's share and hands back the same object until a
write to that session's watches, views, delivered entities, graph misses, or
tracked set replaces it, and the SpaceServer keeps the shares it last read.
A session whose share is the one held costs the pass one comparison, a
replaced share is compared row by row, and only the keys whose rows changed,
with the warm keys captured since the last pass, are reconciled against the
registry — so a pass over unchanged demand with no new warm key reconciles
nothing and adds nothing here, and the transitions a pass makes are the ones
reconciling every key would make. The first pass of a tenure, and the pass
after one whose reconcile threw partway, reconcile every key;
`structureRootsPreloaded` counts the root-document addresses the pass requests
TOGETHER before those segments run — the instance a demand names and, for
every scoped demand, the space instance as well. A segment syncs that space
instance only when the scoped read finds no pattern pointer and starts
nothing, which the pull cannot know in advance, so a scoped root whose own
instance resolves has one address requested that its segment never syncs.
Issuing them in one pull is what lets the replica's refresh queue coalesce
them into a single `session.watch.add` rather than one per address inside the
settle. It is counted per address requested per pass, and most requested
addresses are already watched and cost no round trip, so it runs well above
the adds the pull saves. The pull is also where the pass opens the
changed-document collection its terminal arm invalidates against, because a
root's reading is taken over the span from that pull to the root's own
segment;
`pushGrowthWakes`/`watchWakes`/`warmWakes` count NOTIFIES (the push-time
`demandChanged`, the `session.watch.set`/`.add` notifies, and the warm
request's staged-instance captures — the third kept apart so
`watchWakes` keeps meaning exactly the session-watch notifies) BEFORE the
300 ms grace coalesces notifications into one pending callback. Each
notification advances the demand generation; a notification racing a pass
can require another pass after it completes. Input-driven cycles reconcile
demand before a held grace callback fires, so 300 ms is not a universal
cold-session latency floor. Count notifications, callbacks, passes, wave
closures, and durable commits separately. The service (loopback) session's
notifies are DROPPED — its tracked-set growth is the serving
graph's own reads, not client demand (review MINOR-4). `demandArrivals`
(top-level) the root-level arrival re-arm's count. The `settle` block is
SERVER SETTLE per authored input — admission (the feed's admitted-commit
notice, the append's seq) to W COVERING it (the wave whose
`derivedThrough` ≥ seq); each series entry carries `ms`, `waves`/`cycles`
(the T2′/T3′ cycle count), and `class`, which is `value-only` at coverage
and promoted to `structural-growth` by ADJACENCY — a push-growth wake
that fires AFTER this input was covered (the most recently covered input),
plus the next derived commit as its landing. It is NOT a wake "between
admission and coverage" (such a wake does not change the class), and a
growth from an unrelated later input can land on this row: the split is an
attribution heuristic, not a causal proof (review MINOR-4). W4's
acceptance run reads p50/p95 off it (with that caveat, and net of the
now-dropped service-session growth). `undemandedNarrowingRuns` and
`earlyEmitRefusals` are pre-existing top-level counters the earlier §7
list omitted (folded in here).

The `events` block's dedupe counters (events.md §4's one-entry-one-
completed-run sentence; stage C tuning + stage-C design build W3,
2026-08-19): `drainInFlightSkips` — re-drains that found the entry's
earlier drain copy still queued, held, running, or marked into an
uncommitted wave and did not queue it again (the drain against itself);
`lt1LeftoversPurged` — LT1 same-space in-process copies the flush
deadline found still QUEUED and purged synchronously at the deadline
decision (their durable entry stays pending; the next drain delivers it
with a `streamEntry`); `lt1LateSealsRefused` — LT1 copies that were
RUNNING at the deadline and sealed after their appending wave closed,
refused at the seal destination before entering any wave (the drain's
copy is the one completed run) — it also grows for the shaper-HELD LT1
class (a copy forwarding a renderer-trusted event object is held by the
scheduler's wake shaper, out of the purge's `eventQueue` reach, and
released into a later wave where the refusal catches it; exactly-once
holds, at one refused run + one extra cycle per such cascade — W3
review m3, recorded, the shaper-held pin still a follow-on);
`orphanDeliveriesRefused` — LT1 copies the wave withdrew because no
surviving contribution of that wave appended their entry (a derivation
emitter's superseded sidecar write, a withdrawn or never-sealed
emitter), their same-eventId siblings folded with them — counted once
per EVENT (W3 review M1). All four are the invariant WORKING, routine
under short waves; `events.processed > events.appended` is the drain
delivering server-emitted entries, never the double's signature —
per-event run counts are (and a store-side per-event consequence-commit
count is not one either: it reads 1 for a same-wave double and 2 for a
late-seal split with a surviving intent sibling — W3 review B1).

The `events` block's DISPOSITION counters:

- `loadParkDeferrals` counts every load-park decision, including the
  failed head and each same-space arrival-barrier follower — and a
  barrier follower may also have been swept behind a handler-not-run
  withdrawal or a piece-start deferral (events.md §5: every deferral
  arm carries §2's barrier); `loadParkFailures` counts only heads
  whose required load actually failed.
- `deliveryDeferralsActive`, `deliveryFailuresActive`, and
  `maxAccumulatedDeliveryFailureMs` expose the current durable
  checkpoint population without treating settlement as failure.
- `needsAttention` counts terminal attention notices only after their
  carrying wave commits, split under `byPhase` into `dispatch-load`,
  `commit-preparation`, and `commit-finalization`.
  `needsAttentionSealFailures` counts failed attempts to persist that
  cover, and `deliveryCheckpointWriteFailures` counts failed
  processing-checkpoint writes.
- `explicitRetries` counts accepted new-ID retry appends carrying
  `retryOf`.
- `dropped` remains exclusive to events.md §5's T3 disposition and
  retains its legacy decision-time counting point. Unlike
  `needsAttention`, a refused T3 notice can therefore be decided and
  counted again.

Repeated failure attempts remain measurable in counters. Logs report
the first deferral, class changes, positive recovery, committed
attention, failed checkpoint/attention writes, and explicit retry
transitions rather than every retry. `loadParkDeferrals` growing while
`processed` does not names a load that is not healing; a rising
`dropped` on a space whose pieces all start names a T3 disposition bug
rather than routine delivery failure.

## 8. Tripwires (grep-able FORBIDDEN list)

If any of these identifiers (or obvious synonyms) appear in NEW v2
code, the survival test was skipped — reject the diff:

`claim`, `candidate`, `settlement`, `fence`, `rank`, `contextKey`,
`completeSchedulerScopeSummary`, `completeActionScopeSummary`,
`scopeSummary`, `evidence`, `observationReplay`, `shadowRun`,
`admissionCertificate`, `lease_generation`, `fencingToken` (§2's
FORBIDDEN lease shapes, greppable — DR1's per-process holder is the
fence; a reappearing generation/token field is v1 revival).

Scope: the tripwires bind ALL v2-era code. The pre-existing
`completeSchedulerScopeSummary` / `completeActionScopeSummary`
observation surface — the certificate had TWO identifiers, and naming
only the first let inventories undercount it — was deleted from main
by plan Phase 1 stage C, so a reappearing identifier is a revival, not
a leftover.

The intentional exceptions: `execution_lease` (§2 — CREATED in
Phase 1; the v1 branch's shape is prior art, not existing substrate)
and the basis index tables (§3b — a NEW reduced schema of ids + seqs
only, overwritten in place; correctness-bearing for recovery but never
payloads, so NOT the evidence log).

One tripwire is positive rather than lexical (labs #5569): scheduler
liveness is maintained incrementally, and NO global rebuild runs on
the maintenance path to repair a missed transition —
`recomputeLiveRefs` survives only as the reference definition. Any
future demand-root kind (a new `isDemandRoot` disjunct), and any new
site that flips effect status, materializer envelopes, provisional
demand, or registration, MUST bracket the transition with the
liveness notifications: capture `wasLive` before the flip, call
`notifyNodeLivenessChange` after it (the
`updateMaterializerRegistration` / `updateSchedulerActionType`
shape), or route through `setNodeProvisionalDemand`. An unbracketed
flip is SILENT — nothing repairs it anymore, and the node serves (or
starves) work against a stale liveness answer. Review test for a diff
that adds such a site without the bracket: reject it. Verification:
run the runner suite with `SCHEDULER_LIVENESS_EQUIVALENCE=1` (the
every-mutation equivalence hook in
`packages/runner/src/scheduler/dependency-graph.ts` checks the
incremental state against the full rebuild at each mutator exit).
