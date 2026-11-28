# A slow action and the spaces behind it

Status: Proposed. The first run is stages 0 to 4, as the owner scoped it on
2026-11-16: isolate a space whose action holds a shared worker, and fail an
action loudly once a run of it has held a thread for three minutes. Computing
a slow derivation off the serving thread is deferred, under "Later". Stage 1 is
[labs#10179](https://github.com/commonfabric/labs/pull/10179). Stages 2 and 4
are being built by another session, as the owner decided on 2026-11-23, with
one change to the text below: the rule that a stopped handler's event takes
the error as its consequence, without the handler running again, applies when
the watchdog ends a worker in the middle of a handler, and not only at the
three-minute hard limit. The case behind it: a Topics `adoptTopics` call over
3,281 Topics held a worker past 60 s and ran again on every placement, nine
times in ten minutes and once more after a restart.

A serving worker runs one action at a time, and an action runs to its end once
it starts. An action that takes a minute holds its worker for a minute. Every
space placed on that worker waits behind it, and at the watchdog's limit the
worker is ended and the same action starts again on its successor. This plan
makes each action's cost visible where an operator and an authoring agent can
read it, lets the main thread see which action a silent worker is in and ask
it to stop without ending the worker, moves a space with such an action onto a
worker of its own, and bounds what any one run may take.

A slow pattern costs its own space first. It reaches no other space, and only
the part of it that passes the hard limit stops working.

## What prompted it

Estuary ran with server execution on during 2026-11-15, and spaces stalled.
The owner's report names the Topics space as the likely source: a board of
over 3,000 Topics whose assembly takes over a minute.

Estuary's logs for those days show the loop described below. Server execution
was turned on at 22:58 UTC on 2026-11-14, and the first serving worker was
ended by the watchdog three minutes later. 96 were ended over the next two
days, each for sending no message within the watchdog's limit, and 83 of them
in the first three hours, one every 80 to 90 seconds. Each ended worker held
8 or 9 spaces. The 34 in the first 70 minutes all came from one toolshed
instance, the one that serves the Topics space; the rest have not been
attributed. The log lines do not name the action a worker was
in, so they do not show that the board's assembly was what held it; stage 0
does that on a copy of the space.

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
  silence, or the number of seconds `SERVER_EXECUTION_WORKER_WATCHDOG_SECONDS`
  gives, the pool ends the worker, releases its leases, and places its spaces
  again through the path a failed worker takes (`serving-loop.md` §2, "The
  watchdog"). Estuary ran with that setting at 300, so a worker there was
  held for five minutes before it was ended. The successor loads the same
  program over the same store and runs the same action. If that action takes
  longer than the limit, every placement ends the same way, and the spaces
  that shared the worker are ended with it each time.
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
- On a copy of the board's space installed on Rapids
  ([staging copy procedure](../development/staging-space-copy.md)): the same
  counters, the worker's heartbeats and the kills, for a cold start and for
  one comment to one Topic. Rapids runs server execution on, deploys every
  green `main`, and has few users, where Estuary has the people who use the
  board daily. This is the measurement of the deployment: the pool, the
  sharded server, and a stall as other spaces see it.
- On a local clone of the same snapshot
  ([rehearsal procedure](../development/space-clone-rehearsal.md)), served by
  one worker with read accounting on: wall time, distinct documents and link
  resolutions for each of the board's actions on a cold start and on one
  comment to one Topic. Take a CPU profile of the slowest, to separate reading
  and decoding documents from the work done over them. The steps under
  "Later" depend on that split.

- Which thread the minute was spent on. By default a serving runtime's
  document reads arrive through its home session, and the memory server's
  schema walk that delivers them runs on the main thread (`serving-loop.md`
  §1). Time spent there stalls every space of the toolshed whatever worker
  it is placed on, and stages 2 to 4 do nothing for it:
  [the revision-keyed schema memo](revision-keyed-schema-memo.md) and
  [the served vote's fan-out](served-vote-fan-out.md) are the plans for the
  main thread's cost. The stages below are for time a worker's thread spends
  inside an action.

Measured so far, on 2026-11-16: Rapids holds a copy of the board's space
from 2026-11-13, and a `topics` command read one Topic from it. That
command's session watches the board's documents; it does not ask for what
the shell's view of the board asks for. The space had a serving worker to
itself, with the watchdog at its default.

| Measure                                  | Value                        |
| ---------------------------------------- | ---------------------------- |
| Time for the command to return           | 52 s                         |
| Main thread, CPU in the first minute     | 22 s                         |
| Main thread, longest block               | about 12.6 s                 |
| Serving worker, CPU until it went idle   | about 97 s over 125 s        |
| Derived commits, and waves               | 148 in about 150             |
| Waves in each 10 s of that work          | 16 to 18                     |
| Store reads                              | about 99,500                 |
| Worker heap at its highest               | about 1.85 GB                |
| Process resident memory, before and peak | 0.5 GB and 3.9 GB            |
| Workers the watchdog ended               | none                         |

The health route did not return during the main thread's block, so every
space of that instance waited there, whatever worker it had. The worker
committed throughout its work, so no single action held it for long, and the
silence Estuary's watchdog saw did not occur.

The same space with the board open in a shell, from a cold start, again on a
worker of its own:

| Measure                                    | Value                      |
| ------------------------------------------ | -------------------------- |
| Time until the shell showed the board      | about 45 s                 |
| Serving worker, CPU before it was ended    | about 96 s over 100 s      |
| Derived commits in that time               | 10                         |
| Longest stretch with no wave               | about 70 s                 |
| Longest stretch with no heartbeat counted  | about 40 s                 |
| Worker heap when it was ended              | 3,167 MB                   |
| Main thread, CPU over the same 140 s       | about 67 s                 |
| Main thread, blocks the health route saw   | 20 s, 16 s, 9 s and 5.5 s  |
| Slowest single traversal logged            | 16.1 s                     |
| Process resident memory at its highest     | 5.9 GB                     |

The pool ended the worker after 100 s under the heap limit's rule, at two
heartbeats in a row above 2,048 MB, and left the space unplaced. It was not
the watchdog. The heap figure on the health route did not change for the 40 s
before those two heartbeats while the worker used a whole core, which is what
a worker that sends none looks like; with other spaces on that worker, or a
slower machine, the same stretch passes the watchdog's 60 s. Nothing outside
the worker says which action that stretch was, or whether it was one: that is
what stages 1 and 2 add.

Two things here are outside what stages 2 to 4 reach. The main thread was
busy for about half of those 140 s, in blocks of up to 20 s, and every space
of the instance waited through each. And the worker's memory, not its time,
is what ended it on a host where the pool watches the heap.

Not yet measured: the same load with other spaces on the board's worker,
which is how Estuary ran it.

Exit: a record in `docs/history/` that names the actions, their costs, the
thread each cost fell on, and whether the watchdog loop above happened.

### 1. Each action's cost on the health route

Each serving host keeps a bounded table of the actions its runtimes have spent
the most wall time on, fed from the scheduler's `scheduler.run.complete`
marker, and posts it with the full stats a worker already sends. The main
thread reports it under `servingLoop.actions` on `/api/health/stats`, in the
shape `sessionReports` has: a bounded list of entries and counts of what the
list leaves out. Rows of one action of one space that two workers reported,
the one before a kill and its successor, are taken together. An entry
carries:

- the action's identity: the space, the scheduler's id, the pattern and module
  names, the verified source location where the action is authored, and the
  result cell of the piece it belongs to;
- runs, total wall time, the longest run, and the last run;
- how many of its runs a change to its inputs caused, which is what separates
  an action that is slow once from one that is slow on every write to the
  space;
- for sampled runs, the read-accounting counters.

The list is ranked by total time. A host tracks 512 actions and reports all
of them, and the process lists 50 once the rows of every worker are together,
so an action split across workers is ranked by its whole total. A run of an
action with no row takes the cheapest action's row only if it alone took
longer than that action's total, so the table never trades an expensive
action for a cheap one. An action's first run of a second or more
is logged once, as `slow-action`, with the same identity.

The marker gained what the table needed: the piece, read from the action's
observation identity (`schedulerObservationIdentity.pieceRootId`), which the
scheduler already reads when it attributes a commit rejection; whether an input
change caused the run, which is whether the run had invalidation causes; and
the authored location on every run rather than only on measured ones.

Read accounting stays off for ordinary runs. A run is to be sampled when the
action's previous run passed the threshold, so the cost of measuring falls on
actions that are already expensive. Today the setting is the scheduler's
(`setReadStatsEnabled()`), nothing on a server turns it on, and a run keeps
the one it started with, so this needs the setting to be choosable per run.
`read-accounting.md` asks for the overhead to be measured on the workload
before any timing claim, and that measurement is part of this stage.

Built in [labs#10179](https://github.com/commonfabric/labs/pull/10179): the
table, the merge across workers, the marker's new fields, and the log line.
Not built yet: the sampled read counters with the per-run setting and the
overhead measurement, and event handlers, whose runs report no duration
(`scheduler.invocation` has none), so a slow handler has no entry.

The entry is written for two readers. An operator reads which action in which
space holds a worker. An authoring agent reads what to change: a location, a
count of documents, and the fact that the action runs again on every change
to any of them, which together point at a collection index or an aggregate
([reactive collections](../common/concepts/reactive-collections.md)).

Exit: on a fixture board, the route names the slow action, its piece and its
counts, ahead of every action that cost less, and the log names only actions
whose run passed the threshold.

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

The check interval is 10 s today, sized for a limit of a minute. Stage 4's
sharing limit needs a finer one, and 1 s is the proposal. It stays one timer
for the pool, justified as the watchdog's is: a thread that has stopped cannot
report that it has stopped.

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
reads thousands of documents passes thousands of these. At the same sites,
every so many reads, the worker tests the run against the hard limit on a
clock of its own, so that limit holds even when the main thread is busy.

**What a stop does.** The site aborts the run's transaction and throws a
signal of the kind `RetryImmediately` is. The scheduler handles it beside
that one in `finalizeSchedulerAction`, and what it does next depends on which
limit the run passed, which stage 4 sets out. The abort is what makes this
safe. A throw the scheduler does not know is logged and the run's staged
writes are committed, so a stop that was only a throw would commit half of a
board.

**A stop the body cannot keep.** Pattern code may catch what a read throws,
and nothing stops it catching `RetryImmediately` today. Because the stop
aborts the transaction before it throws, a body that catches it gets no
further: every later read or write through that transaction is refused by
`#editable()`, and the scheduler finalizes the run as stopped from the
transaction's state, whatever the body returned.

**What a stop does not reach.** A body that loops over plain values calls into
the runtime nowhere. The compiler could add a test inside loop bodies, as
`PatternCoverageTransformer` adds its hit counters for a coverage run. This
plan does not, until stage 0 or stage 1 shows such a loop in a real pattern.
A run that does not end within some checks of a stop is ended with its
worker, and stage 4 treats it as it treats a run that did stop.

Exit: a fixture action that reads without end is stopped, its worker is not
ended and `lease.lost` does not move. A body that catches the throw commits
nothing. A run that is not asked to stop is byte-identical to today's.

### 4. Isolating a space, and the hard limit

Two limits, each counted on the stretch a body holds the thread (`epoch`).

| Limit   | Value                   | Applies to                             |
| ------- | ----------------------- | -------------------------------------- |
| Sharing | 10 s, set from stage 0  | a run on a worker other spaces wait on |
| Hard    | 3 minutes, as ruled     | every run on every worker              |

**The sharing limit isolates the space.** While a run is live, the pool knows
whether it has routed anything to that worker for another space: a commit, a
session or demand change, a lifecycle verb. Once it has, and the run has
passed the sharing limit, the pool asks the run to stop. The stopped action
is not failed. Its space is placed again on a worker of its own, past
`maxWorkers` if need be, and no other space joins that worker, as the heap
limit's rule does for spaces that shared a worker. The action runs again
there from the start. The cost is one lost run of at most the sharing limit,
and the other spaces wait no longer than that limit plus a check.

Moving the other spaces away and letting the run finish would lose nothing,
but a worker that is inside an action cannot release the leases of its other
spaces, and a pool that released them for it would have that worker serve
spaces whose leases it no longer holds. Stopping the run needs neither. The
owner chose stopping and rerunning on 2026-11-16; the limit's value and what
starts its count remain open (question 3).

A space that was already alone on its worker stays there, and once one of its
runs passes the sharing limit that worker takes no other space.

**An isolated space stays isolated** until the process ends or a source update
changes a piece in it. How many workers a process may hold for isolated
spaces is a bound of its own, since each costs what any worker costs; past
it, an isolated space joins the isolated worker with the fewest spaces, and
slow spaces then wait on one another and on nothing else.

**The watchdog steps back while a run is live.** Its limit of silence ends a
worker whose thread is in no run, as today. A worker inside a run is held to
the two limits above and not to the watchdog's, so an isolated space's
two-minute action is no longer ended at one.

**The hard limit fails the action.** A run that holds a thread for three
minutes is stopped, on any worker, isolated or not. Its action is **failed**,
a state the scheduler does not have today:

- It is not run again when its inputs change. Its outputs keep the values of
  its last committed run, and are absent if it never completed one, which
  readers already handle for a document that has not arrived.
- Everything else in the piece and the space runs as before.
- The failure is loud. An error-level log line and a counter carry the stage
  1 fields: the piece, the source location, the documents read, how long the
  run held the thread. The health route lists the space's failed actions.
  And the piece itself says so, where its users are. For a handler that
  surface exists: `events.md` §5 has a handler that throws commit no
  consequences and write the handler-error surface as the derived commit for
  its event, with the watermark advanced past it, and a handler stopped at
  the hard limit is such a throw. For a derivation nothing reaches a client
  today, since the serving runtime wires no error handler, and what this
  stage writes is the first open question below.
- A source update to the piece clears the failure, since that is what can
  change the program, and so does an operator's request. Nothing else does.
  An action that fails after three minutes would fail again after three more.

**A run that cannot be stopped.** When a stop is not honored the worker is
ended, and the pool applies the same outcome on the successor from what the
beacon named: the space isolated if the run had passed the sharing limit, the
action failed if it had passed the hard limit. A failed handler's pending
events take the error as their consequence without the handler running. This
is the heap limit's reasoning applied to time, and it is what ends the loop
under "Why one action reaches other spaces".

Exit:

- On a pool of one worker serving two spaces, a fixture derivation slower than
  the sharing limit in one space is stopped once the other space has work
  routed, the other space's event commits within the sharing limit plus a
  check, and the slow space is served from a worker of its own where the
  derivation completes.
- A fixture derivation slower than the hard limit is failed once. Its output
  keeps its last committed value, the route and the log name it, the rest of
  its piece keeps updating, and it is not run again when its inputs change.
- A handler stopped at the hard limit leaves `events.md` §5's error as its
  event's consequence, and the stream's later events run.
- With a fixture body that loops over plain values, the worker is ended once
  and the successor serves the space with the action failed.
- A run under both limits is never stopped, and a space none of whose runs
  passed the sharing limit is never isolated.

## Later

Not part of the first run. Each waits on what stages 0 and 1 measure.

### A hold on reruns

An action that completes, but slowly, and runs again on every write to its
space, costs more through its reruns than through any one run. After stage 4
that cost falls on its own space alone. If stage 1's count of input-driven
runs shows spaces that are busy with one action most of the time, such an
action's next run can be held until the space has gone some multiple of the
last run's cost since that run began, so that it takes a bounded share of its
worker. The remote-echo breaker already defers a re-run for another reason,
and its deferral is the mechanism to extend.

### A lane for derivations too slow to serve

Stage 4 leaves a failed derivation's value where its last committed run put
it, and leaves an isolated space waiting on its own slow action. A lane is
how that value could keep updating and that space keep its latency.

A derivation past a limit runs on a helper worker that holds no lease. The
helper opens the space's store on a connection of its own, reads every
document as of one sequence number S (`Engine.readState` takes a `seq`), and
runs the action's body against that snapshot under limits far longer than the
serving thread's. It commits nothing. Its result, the writes it would make,
the reads it made and S, crosses to the space's serving worker as data. That
worker, which holds the lease, commits it the way it commits an effect's
completion
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
  whatever the action reads. One helper for the process, started when a
  derivation needs it and closed when none does, is the starting point.

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

### Refusing a pattern earlier

Stage 4's failure is a refusal of one action at run time. Two refusals can
come before deployment, and belong to other plans as much as this one:

- a pattern-test budget that runs a fixture at two sizes and fails when the
  reads of one edit grow with the size, which catches a derivation that reads
  a whole collection on every change before it is deployed
  (`read-accounting.md`, "Pattern-test budgets");
- the compiler's `collection:nested-scan` warning, extended to a single scan
  of a captured collection inside one `lift`.

## Open questions

1. **Where does a piece say that one of its derivations has failed?** A
   document the runtime writes on the piece, in the shape the handler-error
   surface has, is the proposal. The shell and `cf` would read it.
2. **Does the failed set outlive the process?** Held by the pool it is lost at
   a restart, and the first run after one holds a thread for three minutes
   again before it fails again. Rapids deploys on every green `main`, so
   there that is three minutes of one space on every deploy.
3. **The sharing limit's value**, and whether it should wait for another
   space's work or apply to every shared worker.
4. **How many workers may isolated spaces hold?** Topic 3060 has the cost of
   one.
5. **Wall time or CPU time?** A synchronous body's wall time on its own thread
   is close to its CPU time unless the machine is short of cores, which the
   host's metrics can say. `scheduled-work-in-the-server.md` §3.2 names the
   trap for bodies that suspend, which is why the limits count only the
   stretch a body holds the thread.
6. **Is a helper within the single-deriver rule?** The lane under "Later"
   waits on this, and the first run does not.

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

One fixture carries the first run: a board-shaped pattern with one derivation
whose cost a test sets, served beside a second space on a pool of one worker.
Stage 4's exit lists what it has to show. Beyond that:

- While a slow run is live, `/api/health/stats` names its action, its piece
  and how long it has held the thread.
- No worker is ended for a run that honors a stop, and `lease.lost` does not
  move.
- On the copy of the board on Rapids, a cold start and a comment leave every
  other space's round trip within the sharing limit plus a check.

The sharing limit is counted in the pool's checks, so its tests drive the
checks and read no clock. The hard limit is tested on the worker's clock,
which the tests supply.
