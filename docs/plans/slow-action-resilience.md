# A slow action and the spaces behind it

Status: Proposed. Nothing here is built. Stages 0 to 2 observe and change no
behavior. Stage 3 changes what can end an action's run, stage 4 adds a state
an action can be in, and stage 5 needs a ruling on the lease before any code.

A serving worker runs one action at a time, and an action runs to its end once
it starts. An action that takes a minute holds its worker for a minute. Every
space placed on that worker waits behind it, and at the watchdog's limit the
worker is ended and the same action starts again on its successor. This plan
makes each action's cost visible where an operator and an authoring agent can
read it, lets the main thread see which action a silent worker is in and ask
it to stop without ending the worker, and gives a stopped derivation somewhere
to finish that is not the thread its space is served on.

Blocking a pattern this slow is the last step of this plan and not the first.
A board that people already rely on should lose the freshness of one derived
value before it loses the piece, and should lose the piece before it takes
other spaces with it.

## What prompted it

Estuary ran with server execution on during 2026-11-15, and spaces stalled.
The owner's report names the Topics space as the likely source: a board of
over 3,000 Topics whose assembly takes over a minute. Nothing in this plan has
confirmed that from Estuary's logs; stage 0 does.

The board's source supports the suspicion. Three of its derivations read every
Topic in one action and run again when any Topic changes: `crossrefTable`,
`cardRowsByActivity`, and the `mentionableIndex` the board instantiates
([`main.tsx`](../../patterns/apps/topics/main.tsx)).
[Topics computation cost](topics-computation-cost.md) is the plan that makes
those derivations cheaper. This plan is about what the runtime does while a
pattern like that exists, since the next one will not be Topics.

## Why one action reaches other spaces

Each of these is the specified behavior, and each is reasonable alone.

- **Spaces share workers.** A space gets a worker of its own while fewer than
  `maxWorkers` workers are placed on, 4 in the toolshed, and joins the worker
  with the fewest spaces after that
  ([`serving-loop.md`](../specs/server-side-execution/serving-loop.md) §1,
  "Workers"). A worker holds about 110 MB of the process's memory before it
  serves anything
  ([the serving loop off the request thread](serving-loop-worker.md), "One
  worker per space"), and Topic 3060 measured about 240 MiB per served space
  before the compile workers were shared, so the pool cannot simply be made
  larger.
- **Nothing cuts an action.** The serving scheduler yields a macrotask between
  actions once 16 ms of continuous work has passed
  (`scheduler/cooperative-yield.ts`), and the consequence-flush deadline is a
  timer that fires at those yields. The yield's own header gives the bound: one
  action plus a slice. An action that reads 3,000 documents in one body is one
  action.
- **The watchdog cannot tell busy from hung.** A worker's heartbeat is a timer
  on the thread the action holds, so a long action is silence. After 60 s of
  silence the pool ends the worker, releases its leases, and places its spaces
  again through the path a failed worker takes (`serving-loop.md` §2, "The
  watchdog"). The successor loads the same program over the same store and
  runs the same action. If that action takes longer than the limit, every
  placement ends the same way, and the spaces that shared the worker are ended
  with it each time.
- **The heap limit has the rule the time limit lacks.** A worker ended at its
  heap limit is not placed again as a failed worker is, "since a program that
  grew one heap to the limit grows the next": a space alone on the worker is
  left unplaced, and spaces that shared it each get a worker of their own
  (`serving-loop.md` §1). A program that held one thread for a minute holds
  the next for a minute too, and no rule says so.
- **The budget is specified and absent.**
  [The README](../specs/server-side-execution/README.md) §3.8 makes per-space
  budgets, CPU time per wave among them, part of the executor contract, so
  that a runaway pattern degrades its own space and not the host.
  [Scheduled work in the server](scheduled-work-in-the-server.md) §1.5 records
  the same gap: the existing budgets pace network effects, and neither they
  nor the flush deadline bounds compute.

## What exists to build on

- **Per-action wall time** is measured on every run (`recordActionTime`,
  `scheduler/timing.ts`) into the scheduler's own `ActionStats` map and
  exported as `ct.scheduler.action.duration_ms`. The time runs until the run
  settles, so a body that awaits is charged for its waits. The export is
  attributed by pattern and module name, so two instances of one pattern in a
  space read as one (`scheduled-work-in-the-server.md` §3.1 and §3.2).
  `ServingLoopStats` (`executor/stats.ts`) holds nothing per action or per
  piece, and the executor never reads `ActionStats`, so none of this reaches
  the health route today.
- **[Read accounting](../features/read-accounting.md)** counts proxy accesses,
  link resolutions, distinct documents and registered dependencies per run,
  and names the verified source location of an authored action. It is off by
  default. Its counters are taken where a body's reads pass: the query-result
  proxy, the schema view, link resolution, traversal and the storage
  transaction, each site behind one flag test (`readStatsActive`). Reads a
  cache serves are counted too, so the sites see more than storage does.
- **A thrown control signal.** `RetryImmediately`
  (`scheduler/retry-immediately.ts`) is thrown from inside a run to have the
  scheduler abort the run's transaction and queue the action again
  (`rescheduleActionForImmediateRetry` in `scheduler/run.ts`). It is the only
  throw that aborts. After any other throw the scheduler logs the error and
  still commits what the run had staged (`finalizeSchedulerAction`).
- **A transaction that refuses once it is over.** Every read and write
  through a `V2StorageTransaction` starts with `#editable()`, which returns an
  error unless the transaction is `ready`.
- **Stats that cross from worker to main thread.** A worker posts its
  `ServingLoopStats` and counters as `host.stats` and `host.counters` notices,
  and `/api/health/stats` reads the main thread's latest copy without waiting
  on a worker. The route's `sessionReports` block, where the remote-echo
  breaker's trips are listed
  ([its plan](scheduler-remote-echo-breaker.md), Topic 913), is the model for
  a bounded list of events beside lifetime counts. Its transport is not
  reusable here: it carries reports from client sessions, and its parser
  accepts the breaker's kind alone.
- **A hold on a re-run.** The breaker defers an action's next run with a
  capped exponential backoff (`scheduler/echo-breaker.ts`).
- **A placement rule that isolates a program.** The heap limit's rule above.
- **The watchdog's way of counting.** Its check counts its own firings rather
  than reading a clock, so a main thread that itself stalled does not end a
  worker. Every threshold below is counted the same way.

## Stages

Each stage is useful without the ones after it.

### 0. Confirm the diagnosis

Nothing below should be sized from a suspicion.

- From Estuary's toolshed logs and `/api/health/stats` for 2026-11-15: the
  workers the watchdog ended, `lease.lost`, the failure-park backoff per
  space, and which spaces shared a worker with the Topics space.
- On a clone of the board
  ([rehearsal procedure](../development/space-clone-rehearsal.md)), served by
  one worker with read accounting on: wall time, distinct documents and link
  resolutions for each of the board's actions on a cold start and on one
  comment to one Topic. Take a CPU profile of the slowest, to separate reading
  and decoding documents from the work done over them. Stage 5 depends on that
  split.

- Which thread the minute was spent on. By default a serving runtime's
  document reads arrive through its home session, and the memory server's
  schema walk that delivers them runs on the main thread (`serving-loop.md`
  §1). Time spent there stalls every space of the toolshed whatever worker
  it is placed on, and stages 2 to 4 do nothing for it:
  [the revision-keyed schema memo](revision-keyed-schema-memo.md) and
  [the served vote's fan-out](served-vote-fan-out.md) are the plans for the
  main thread's cost. The stages below are for time a worker's thread spends
  inside an action.

Exit: a record in `docs/history/` that names the actions, their costs, the
thread each cost fell on, and whether the watchdog loop above happened.

### 1. Each action's cost on the health route

The serving loop keeps, per space, a bounded table of its most expensive
actions, filled from the scheduler's `ActionStats`, and posts it with the
stats a worker already sends. The main thread reports it under `servingLoop`
on `/api/health/stats`, in the shape `sessionReports` has: lifetime counts and
a bounded list of entries. An entry carries:

- the action's identity: the pattern, the module, the verified source location
  where the action is authored, and the piece instance it belongs to;
- runs, total wall time, the longest run, and the last run;
- how many of its runs a change to its inputs caused, which is what separates
  an action that is slow once from one that is slow on every write to the
  space;
- for sampled runs, the read-accounting counters.

An action is logged once when it first passes a threshold, with the same
fields.

Read accounting stays off for ordinary runs. A run is sampled when the
action's previous run passed the threshold, so the cost of measuring falls on
actions that are already expensive. Today the setting is the scheduler's
(`setReadStatsEnabled()`), nothing on a server turns it on, and a run keeps
the one it started with, so this needs the setting to be choosable per run.
`read-accounting.md` asks for the overhead to be measured on the workload
before any timing claim, and that measurement is part of this stage.

`ActionStats` has the run count, the total and the last run's time. The
longest run and the count of runs an input change caused are new. So is the
piece instance in the attribution, which the scheduler already resolves when
it reports an action's error (`handleSchedulerError`,
`scheduler/diagnostics.ts`). Without it the table cannot say which board is
the slow one.

The entry is written for two readers. An operator reads which action in which
space holds a worker. An authoring agent reads what to change: a location, a
count of documents, and the fact that the action runs again on every change
to any of them, which together point at a collection index or an aggregate
([reactive collections](../common/concepts/reactive-collections.md)).

Exit: on a fixture board, the route names the slow action, its piece and its
counts, and an action under the threshold has no entry.

### 2. A beacon the main thread reads

A worker's stats reach the main thread when its cycle ends, which is after the
slow action has finished. While the action runs the main thread knows only
that the worker is silent.

The pool allocates a small `SharedArrayBuffer` for each worker and hands it
over as a field of the worker's init (`ServingWorkerInit`), which is how a
worker is given everything else it starts with. A shared buffer is cloned by
reference and needs no transfer list, which the serving port does not have.
Nothing shares memory between these threads today, so this stage's first test
is that the buffer arrives shared on both kinds of thread a worker can be
(`serving-thread.ts`). Pattern code cannot reach it: `SharedArrayBuffer` and
`Atomics` are withheld from pattern compartments
(`base/pattern-contract/src/sandbox-contract.ts`).

The worker's scheduler writes to it around every action run:

| Slot     | Written                     | Holds                              |
| -------- | --------------------------- | ---------------------------------- |
| `epoch`  | at each run's start and end | a counter, odd while a run is live |
| `action` | at each run's start         | a small integer naming the action  |
| `reads`  | at the read sites           | a count of reads in the live run   |

The integer is the worker's own numbering. The worker posts the identity an
integer stands for once, the first time it runs that action, as a notice on
the serving port. A post is queued for the main thread without the worker
yielding, which this stage's test confirms on both kinds of thread. A post
per run would make every run a message, and the watchdog
counts every message from a worker as a sign of life
(`bridge.messagesReceived`), so it would also hide a hung worker. The buffer
costs a store per run and says nothing to the watchdog.

`epoch` marks the stretch in which a body holds the thread. A body that
returns a promise has let go of it, and its slot is even from then on.

The pool's check, on the timer the watchdog already has, reads the slots with
`Atomics.load` and counts how many of its own firings have seen the same odd
`epoch`. That count is how long the action has run, in check intervals, with
no clock shared between the threads. `reads` separates the two cases the
watchdog cannot: a count that moves is an action doing work, and one that does
not is an action in a loop of its own or a thread that has stopped.

What this stage changes:

- The health route reports, for each worker, the action it is in and for how
  many intervals, without waiting on the worker.
- A watchdog kill names the action the worker was in, in its log line and in
  the stage 1 table.
- The pool remembers that action for the space. Stage 4 uses it.

The check interval is 10 s today, sized for a limit of a minute. Stage 3 needs
a finer one. It stays one timer for the pool, justified as the watchdog's is:
a thread that has stopped cannot report that it has stopped.

Exit: with a fixture action that never returns, the route names it while it
runs and the kill names it afterwards; the watchdog's existing tests pass
unchanged.

### 3. A stop the worker honors

The buffer gains one slot the main thread writes: `stop`, holding the `epoch`
of the run the pool wants ended. It names a run and is not a flag, so a stop
that arrives as the run ends cannot end the next one.

**Where the worker looks.** At the sites that already test
`readStatsActive`, which include reads a cache serves without touching
storage, and at cell writes: one `Atomics.load` and a comparison. A run that
reads thousands of documents passes thousands of these.
The worker also holds each run to a limit of its own, tested at the same sites
every so many reads, so a run is bounded even when the main thread is busy.
The main thread's stop is for what only the pool knows: another space's
commits waiting on this worker, a lifecycle verb waiting on this space, or a
closing process.

**What a stop does.** The site aborts the run's transaction and throws a
signal of the kind `RetryImmediately` is. The scheduler handles it beside
that one in `finalizeSchedulerAction`: it records the stop in the stage 1
table and puts the action in the state stage 4 describes, and it does not
queue the action again. The abort is what makes this safe. A throw the
scheduler does not know is logged and the run's staged writes are committed,
so a stop that was only a throw would commit half of a board.

**A stop the body cannot keep.** Pattern code may catch what a read throws,
and nothing stops it catching `RetryImmediately` today. Because the stop
aborts the transaction before it throws, a body that catches it gets no
further: every later read or write through that transaction is refused by
`#editable()`, and the scheduler finalizes the run as stopped from the
transaction's state, whatever the body returned.

**What a stop does not reach.** A body that loops over plain values calls into
the runtime nowhere. The compiler could add a test inside loop bodies, as
`PatternCoverageTransformer` adds its hit counters for a coverage run. This
plan does not, until stage 0 or stage 1 shows such a loop in a real pattern:
the watchdog still ends that worker, and after stage 2 it says which action
it was.

**Derivations only, at first.** A stopped derivation loses nothing: its inputs
are still there. A stopped event handler has consumed an event, and events are
intent
([`events.md`](../specs/server-side-execution/events.md)). Handlers keep
running to their end until the open question below is decided. The beacon
names a slow handler all the same.

**When the pool asks.** Two thresholds, both counted in the pool's checks and
both set from stage 0 and stage 1 data:

- a run is asked to stop once it has run for the shorter one while another
  space placed on its worker has work waiting;
- a run is asked to stop at the longer one whatever else is waiting, and that
  one is well under the watchdog's limit.

A run that does not end within some checks of the request is in a loop the
sites do not reach, and the watchdog's kill follows as it does today.

Exit: on a pool of one worker serving two spaces, a fixture action that reads
without end in one space is stopped, the worker is not ended, `lease.lost`
does not move, and an event in the other space commits within the shorter
threshold plus a check. A body that catches the throw commits nothing. An
action under the thresholds is never asked to stop.

### 4. What a stopped action becomes

A stopped derivation is **suspended**, a state the scheduler does not have
today: it is not run when its inputs change. Its outputs keep the values of
its last committed run. If it
never completed a run they are absent, which readers already handle for a
document that has not arrived.

- **The reader can tell.** The health route lists a space's suspended actions
  with the stage 1 fields and the reason. A piece's own readers need the same
  fact closer to the value: a record on the piece that `cf` and the shell
  read, so that a board whose backlinks have stopped updating says so. Its
  shape is an open question.
- **A kill suspends too.** When the watchdog ends a worker and stage 2 names
  the action, the successor starts with that action suspended. This is the
  heap limit's reasoning applied to time, and it is what ends the loop under
  "Why one action reaches other spaces".
- **A space that keeps being stopped gets a worker of its own**, past
  `maxWorkers` if need be, as spaces that shared a worker ended at its heap
  limit do. How many such workers a process allows is bounded by memory
  (Topic 3060).
- **What resumes it.** A source update to the piece, since that is what can
  change the program. An operator's request. And, without either, the lane in
  stage 5, or until that exists a retry when the worker is otherwise idle
  under an allowance that doubles with each stop, as the flush deadline's
  does.

One step belongs before suspension. An action that completes, but slowly, and
runs again on every write to its space, costs more through its reruns than
through any one run. Such an action's next run is held until the space has
gone some multiple of the last run's cost since that run began, so that it
takes a bounded share of its worker. The remote-echo breaker already defers a
re-run for another reason, and its deferral is the mechanism to extend.

Exit: after a kill that names an action, the successor serves the space with
that action suspended and is not ended again. A suspended action's outputs
read as its last committed values, and the route and the piece's record say
they are stale.

### 5. A lane for derivations too slow to serve

Stage 4 keeps a space responsive at the price of one derived value that no
longer updates. This stage is how that value keeps updating.

A suspended derivation runs on a helper worker that holds no lease. The helper
opens the space's store on a connection of its own, reads every document as
of one sequence number S (`Engine.readState` takes a `seq`), and runs the
action's body against that snapshot under limits far longer than the serving
thread's. It commits nothing. Its result, the writes it would make, the reads
it made and S, crosses to the space's serving worker as data. That worker,
which holds the lease, commits it the way it commits an effect's completion
(`serving-loop.md` §4, `markEffectCompletion`): a derived-class commit of its
own, marked for what it completes, serialized behind the seals, and never
part of a wave. The serving thread never runs the slow body, so events and
every other derivation in the space keep their latency, and the slow value
lags by about one run.

What has to be decided before this is built:

- **The lease and the tripwires.** The README's invariant is about who
  commits: "dual *execution* is fine and deliberate", and "dual *commitment*
  is what must never happen". A helper that hands its result to the holder
  commits nothing, and takes none of the lease shapes `serving-loop.md` §2
  forbids. But it runs an action for a space it does not hold, and v2 deleted
  "shadow/authoritative action-transaction routing" (README §5) and lists
  `shadowRun` among the identifiers §8 rejects on sight. Whether a helper's
  run is the thing those were written against is a ruling, not a reading.
- **What the commit carries.** A run's seal carries its read log, its basis
  rows and its CFC and identity stamps, and an unstamped seal is forbidden
  (§3d). A result that crosses as data has to carry all of them, or the
  holder has to be able to rebuild them from the reads and S.
- **Reading at S.** A serving runtime reads through its replica, and the
  posture in which it reads the store directly is off by default and reads at
  the head. The helper's reads at one `seq` are a path no runtime takes today.
  A compaction can also remove the history a `seq` names
  ([`compact-space`](compact-space.md)), so S has to be recent or the run
  starts over.
- **Freshness.** On a busy space the inputs move during every run. A rule that
  the reads must be unchanged at commit would never be satisfied. The proposal
  is that the holder accepts a result derived at S, marks it so, and asks for
  another run when the inputs have moved since S.
- **A handler that reads a lagging value.** A handler that decides from a
  derived value could decide from one that predates its own event. The safe
  rule is that such a handler waits for the run that covers its event, which
  delays that handler and nothing else. Whether any deployed handler reads the
  outputs of the derivations in question is something stage 0's record can
  say.
- **The enforcement boundary.** The action run is where CFC is enforced
  (`serving-loop.md` §3c), and a scoped action runs once per demander. The
  helper has to run the same gate under the same scope, or the lane is limited
  to actions that are neither scoped nor labeled.
- **Only derivations with no effects.** An action that dispatches a network
  effect or writes through the outbox stays on the serving thread.
- **Cost.** A helper is another isolate with the pattern's module graph and
  whatever the action reads. One helper for the process, started when
  something is suspended and closed when nothing is, is the starting point.

If stage 0's profile shows that most of the slow action's time is reading and
decoding documents, a smaller step may cover most of the gain: the previous
run's dependency log names the documents the action reads, so the serving
worker can load them in a loop that yields and then run the body over memory
that is already warm. That needs no ruling. It does nothing for a body that is
slow over warm data.

Exit: with a fixture derivation slower than the serving thread's limit, the
space's events keep their latency, the derivation's output reaches a value
derived at a sequence number no older than one run behind the head, and a
handler that reads it never decides from a value older than its own event.

### 6. Refusing a pattern

With the stages above an action passes through four states as its measured
cost rises: it runs as it does today; its reruns are held to a share of its
worker; it is suspended and, once stage 5 exists, derived in the lane; and
last, if the lane's limits end it too, it is refused with the stage 1 entry as
the error an author or an authoring agent acts on.

Two refusals can come earlier than deployment and belong to other plans as
much as this one:

- a pattern-test budget that runs a fixture at two sizes and fails when the
  reads of one edit grow with the size, which catches a derivation that reads
  a whole collection on every change before it is deployed
  (`read-accounting.md`, "Pattern-test budgets");
- the compiler's `collection:nested-scan` warning, extended to a single scan
  of a captured collection inside one `lift`.

## Open questions

1. **Is a helper within the single-deriver rule?** Stage 5 waits on this.
2. **May a handler be stopped?** If so, what becomes of its event: queued
   again behind a longer limit, or failed where its sender reads the failure.
3. **Where does a piece record that one of its values is stale?** A document
   the runtime writes on the piece, a field on its result, or nothing beyond
   the health route.
4. **Does the suspended set outlive the process?** Held by the pool it is lost
   at a restart, and the first run after one is stopped or ended again before
   the pool knows.
5. **Wall time or CPU time?** A synchronous body's wall time on its own thread
   is close to its CPU time unless the machine is short of cores, which
   Estuary's host metrics can say. `scheduled-work-in-the-server.md` §3.2
   names the trap for bodies that suspend.
6. **How fine is the pool's check?** Stage 3's shorter threshold cannot be
   finer than the check interval.

## Not in this plan

- Making the Topics board cheaper:
  [Topics computation cost](topics-computation-cost.md).
- A cap on a writer's commit rate: Topic 913.
- Quota and billing: `scheduled-work-in-the-server.md` Part 3. Stage 1's table
  is for diagnosis and is not a ledger.
- What a worker's heap holds:
  [serving worker heap](serving-worker-heap.md).
- The main thread's own cost, per commit and per schema walk:
  [served vote fan-out](served-vote-fan-out.md) and
  [the revision-keyed schema memo](revision-keyed-schema-memo.md).

## Acceptance

One fixture carries the plan: a board-shaped pattern with one derivation whose
cost a test sets, served beside a second space on a pool of one worker.

- While the slow derivation runs, `/api/health/stats` names it, its piece and
  how long it has run.
- The second space's event commits within the stage 3 threshold plus a check.
- No worker is ended and `lease.lost` does not move.
- The slow derivation's output reads as stale and, with stage 5, reaches a
  value no older than one run behind the head.
- A derivation under the thresholds is never held, stopped or suspended, and
  its output is byte-identical to today's.

The thresholds are counted in the pool's checks, so the tests drive the checks
and read no clock.
