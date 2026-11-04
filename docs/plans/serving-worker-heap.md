# What a create leaves on a serving worker's heap

Status: In progress.

A serving worker's heap grows with every piece a handler creates, and a worker
that reaches V8's limit takes its whole process down. The goal is that a create
leaves the worker holding what bounded caches hold and nothing per piece, so
that a busy board runs without a restart. A piece nothing demands should exist as
what the store holds: its documents, and the `scheduler_basis` rows saying what
its actions read. Only something that needs a value the piece derives should
bring it back.

## What is known

A restarted server shows the size of what is actually needed. On a board of 2,004
Topics, its worker holds 131 MB after a read of `index`, 395 MB after the first
create, and 535 MB after reads of `index`, `topicCount`, `namesTable`,
`mentionable`, `crossrefs` and `topics`. Reads add almost nothing to a running
worker: 13 listings of 501 Topics added 5 MB.

So the cost is per create and not per Topic stored. A server that creates those
Topics itself keeps what starting them built, and nothing released it until the
space parked, which a space with sessions or a steady stream of events does not
do.

Worker heap after a forced collection, in MB, on a fresh board, with the changes
in order. Each column includes those to its left.

| Creates | Before | Child graph bound once | Child released at commit | Result pattern's index entry dropped | Node bindings dropped |
| ------- | ------ | ---------------------- | ------------------------ | ------------------------------------ | --------------------- |
| 101 | 509 | 446 | 382 | 378 | 323 |
| 201 | 845 | 720 | 577 | 571 | 421 |
| 301 | 1,215 | 977 | 767 | 753 | 558 |
| 401 | 1,570 | 1,299 | 1,010 | 998 | 647 |
| 501 | 2,023 | 1,564 | 1,234 | 1,189 | 808 |
| 1,001 | | | | | 1,394 |

Each create left about 1.2 MB on that server, against 3.6 MB before. The
toolshed's heap limit is 8 GB per isolate (`deploying.md`). Server CPU per create
is unchanged: 0.24-0.43 s before and 0.25-0.37 s after, two alternating rounds of
three, 100 creates each, at load 77-269.

A worker rig (`heap-worker-probe.ts`, under "The process") serves a fresh board
from a `ServingWorker` the way the toolshed does and has the worker write its own
snapshots, so each holder is measured in the process that holds it. On that rig
a create leaves 862 KB on the worker, measured over 40 creates after a first 10.
Whether the board's root is the loop's demand decides most of that: `cf piece new`
sends the served `instantiate` verb with `start: true`, which makes the root a
demand root, and the same board created without it leaves a third as much. A
server's board is demanded, so the demanded figure is the one to work on. The
memory server's session graphs, 375 KB per create on the Topics board, are on
the main thread under the worker arm and so are not on the worker.

## Landed

- A pattern built while a program runs binds a child graph that reaches no outer
  cell once rather than per event (`moduleWithReusedGraphBindings`).
- Once a handler's transaction commits on a serving runtime, its result is released
  (`#releaseServedHandlerResult` in `runner.ts`, serving-loop.md §1). A demand for a
  value, or an event to a stream, starts the piece again.
- The release drops the result pattern's keyless index entry, and a stopped piece's
  node bindings go too (`NodeBindingMemo.release()`). Both hold the cells of the run
  that started it, and through them its transaction.
- A wave lets go of its sealed commits once it has committed or been abandoned
  (`#releaseSealedState` in `executor/wave.ts`), keeping the counts and the
  settlement the serving loop reads afterwards. Each sealed commit holds the
  documents a run wrote and read, and `SpaceServer.#waveByTx` maps every
  transaction that sealed into a wave to that wave, so a node that kept its run's
  transaction kept the whole wave with it: 690 KB of the 1,551 KB a demanded
  board's create left on the worker.
- The served release of a handler's result asks for the release pass a stop
  asks for (`Runtime.releaseUnreadDocuments()`, `document-release.md`), so the
  watches of the documents only the stopped pieces read go. On the worker rig
  the replica's watch bookkeeping per create roughly halves: the selector
  tracker 37 KB to 18, root watches 31 to 15, the session's watch specs 18 to
  9, the provider's sync requests 28 to 13, replica documents 22 to 15. Two
  runs on one machine, one each side of the change, left 1,055 and 915 KB per
  create; the per-run spread is wide, so the holder table is the measure.

## What is left

Per create on the worker rig, a demanded board, removing holders cumulatively in
this order. The total is 862 KB.

- Each Topic's documents, about 135 KB per create in `SpaceReplica.#docs` and
  shared with the session's watch view, and the watch bookkeeping that remains
  around them, about 80 KB. The board's own derivations read every Topic, so
  `Scheduler.readsEntity()` holds the documents, the release pass keeps their
  watches, and the trigger index grows by about 50 KB per create. That is the
  cost of a demanded board whose computations stay registered after they ran.
  Letting a computation that has run keep only its basis rows, loading its
  inputs again when a change dirties it, is the design in the introduction
  applied to a demanded piece's computations; it is the largest item left and
  a change to what the scheduler keeps, not to storage.
- `deepFrozenCache` charges about 314 KB per create in a snapshot and holds
  nothing: those are objects awaiting finalization that a snapshot taken right
  after a collection still contains. Subtract them before reading a total.
- The transaction of the run that started the piece, 55 KB. A node a run starts
  binds its result cell to the run's transaction in `#instantiateNode`
  (`runner.ts`), and the map builtin's element instances of a demanded board are
  such nodes. `map.ts` already strips the transaction from the element cells it
  stores; the result cell wants the same, and since it reaches every node, the
  change needs the executor suites.
- The read logs of the active computations, about 42 KB, which grow with the
  index for the same reason.
- Bounded caches still filling: `watchIds` 30 KB, `DerivedInternalCellIds`
  35 KB, `sortedKeyCache` 13 KB, `externalRefHashCache` 12 KB,
  `stringRepCache` 10 KB. Each stops growing at its bound.
- The provider's `#syncRequests`, 17 KB, and `#documentHolds`, 7 KB, for the
  documents the board holds.

Beyond these:

- A piece a demand or an event starts keeps running until its space parks, so a
  client that opens many Topics in turn builds up the same cost. Releasing a piece
  when its last demand leaves is the same change at another site, and a demanded
  piece's writers are what `leaveDemandedEntity()` already tracks.
- A kept runtime (`parkedRuntimeRetentionMs`) holds whatever its tenure held.
- Lower the heap limit once a day of real traffic shows what a worker needs.
- Nothing here has run on rapids.

## The process

Run each step on a local server with the flags the deployment uses
(`EXPERIMENTAL_SERVER_EXECUTION=true`, `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION=true`).
A create here is an `addTopic` event, and any verb that starts a piece will do.

1. **Measure the heap after a collection, between steps.** A local server answers
   `/api/health/collected-memory` with `servingLoopWorker.heapUsed` after a full
   collection. RSS moves by hundreds of megabytes on its own, and a process's heap
   numbers leave a worker out. Vary one thing at a time: a round of creates, then a
   round of reads, then more creates. This says what the growth follows before
   anyone reads code.

2. **Take a control.** Restart the server on the same board and measure again after
   a read. The difference from the running server is what the running server keeps
   that it does not need.

3. **Take two snapshots of the worker's growing heap.** `heap-worker-probe.ts`
   serves a fresh board from a `ServingWorker` with `heap-worker-module.ts` as
   the worker's entry, creates Topics through the board's `addTopic` verb, and
   has the worker write its own snapshot after the first N creates and after M
   more. `--v8-flags=--expose-gc` reaches the worker, and a snapshot the worker
   writes holds the worker's heap and nothing else. Divide the growth by M, so a
   one-time load shows up as what it is; N of 10 is past an empty board's module
   loads. The board's root is the loop's demand unless `PROBE_START=0`, and the
   demanded board is the server's case.

   ```bash
   deno run -A --config deno.jsonc --v8-flags=--expose-gc skills/perf-investigation/scripts/heap-worker-probe.ts 10 40 /tmp/heap-probe
   ```

   A running server can be snapshotted over the inspector instead, which reaches
   its main thread alone, so the loop has to run there:

   ```bash
   EXPERIMENTAL_SERVER_EXECUTION=true EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION=true SERVER_EXECUTION_WORKER=false ./scripts/start-local-dev.sh --port-offset 640 --inspect
   ```

   ```bash
   deno run --allow-net --allow-write skills/perf-investigation/scripts/heap-snapshot.ts 9869 a.heapsnapshot
   ```

   That heap also holds the memory server's session graphs, which the worker arm
   keeps on the main thread, so a holder found there is charged to the worker
   only once the worker rig shows it.

4. **Read retained sizes.** `heap-retained.ts` charges each object to what alone
   keeps it alive. A holder that retains a lot is a fix. When several holders share
   the same objects, they all charge to the root, and the next step separates them.

   ```bash
   deno run -A --v8-flags=--max-old-space-size=40000 skills/perf-investigation/scripts/heap-retained.ts a.heapsnapshot b.heapsnapshot 200
   ```

5. **Remove holders cumulatively.** Removing one holder of shared objects frees
   nothing, so `heap-removal.ts` removes them in the order given and reports the
   growth left after each. What stays is grouped by shortest retaining path, which
   names the next holder to add to the list.

   ```bash
   deno run -A --v8-flags=--max-old-space-size=40000 skills/perf-investigation/scripts/heap-removal.ts a.heapsnapshot b.heapsnapshot 200 --cut edge:#docs --cut node:ExtendedStorageTransaction
   ```

   `--steps` sets how many steps of the path name a group, and `--rows` how
   many groups print; a deeper path tells two holders under one field apart.

   A path through a WeakMap's table is not a retaining path: the entry's value is
   kept by its key. Both tools leave that edge out, and a tool that follows it will
   name holders that hold nothing.

6. **Ask whether the holder is needed.** Compare against step 2: what a restarted
   server does without, a running one can drop, and what a restart does is already
   a tested path. A cache is safe to drop from when a miss only costs recomputing.

7. **Fix it with a failing test first, one holder at a time.** Measure the curve
   after each fix, since a holder's share of a retained size says little about what
   removing it frees. Then run the executor suites: a change to what stays running
   shows up in `runtime/runner/test/executor*.test.ts`.

8. **Compare CPU with the fix off.** Other sessions on the same machine drive load
   past 500, so wall time alone misleads. Alternate a server from each tree, and
   read `ps -o time=` on the toolshed around each round.

Three things cost time on the way. At load 500 the serving worker's watchdog kills
it during a deploy, so a run with no board in it says nothing. A burst client waits
forever on a dead server, so when a round stops reporting, check the toolshed's pid
and `~/Library/Logs/DiagnosticReports` first. And `start-local-dev.sh` overwrites
its log, so copy that before a restart.
