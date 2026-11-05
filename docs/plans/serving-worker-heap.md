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
a create left 862 KB on the worker before the changes under "Landed" that
followed, 522 KB after the closure change among them, and 610 KB on the run
after the last of them, measured over 40 creates after a first 10. Two runs of
one tree on one machine differ by a hundred kilobytes or more, as what the
replica holds at the moment of the snapshot varies and as work that is not a
create's lands in the interval (the 610 KB run charges 81 KB to the TypeScript
checker's feedback cells and 105 KB to the frozen-value cache's table), so a
change is judged by the holder table (`heap-retained.ts`), not by the total.
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
- A piece that keeps running no longer keeps the transaction that started it
  through the start's own closures, a node's closures, or the identity its
  result cell's siblings share (`start-transaction-release.test.ts`; the
  paths a raw node's builtin and a bound result cell still keep are under
  "What is left"). V8 gives every closure of one function
  scope one context, so a closure that lives as long as the piece, the start's
  `cancel` or a node's `action` or `handler`, kept every variable any closure of
  that scope had captured, and a function whose parameters are destructured or
  defaulted keeps those in a scope of their own on the same terms. The start
  took its options apart and named the object no further; the nodes stopped
  naming their transaction-bound `resultCell` and `inputsCell` parameters in
  closures; a cell made from a link mints the identity its siblings share
  without a transaction (`CauseContainer.cell` in `cell.ts`), where it was the
  first, transaction-bound cell made for the entity; and the pattern watcher's
  lagging pointer is set only for a start that arms the watcher, since the map
  builtin's element starts do not, and nothing else cleared it. With the
  transactions went what they kept: `deepFrozenCache`'s weak-set table, 314 KB
  per create before, is no longer charged at all, and the worker rig's create
  went from 915 to 522 KB.
- A transaction that has settled releases the records it accumulated for
  preparation (`#releasePreparationInputs` in `extended-storage-transaction.ts`):
  the write-policy inputs and the identities that recorded them, the
  dereference traces, trigger reads, structure containers, asserted value roots,
  consulted grants and manifests, the observations, and the preparation that
  verified them, whose input held the same records. Those were 38 KB of the
  54 KB the transaction of a map element's start left per create, 21 KB of it
  the write-policy inputs and 13 KB the traces; the state is charged 2 KB per
  create since, its modes and the snapshots it shares. A settled transaction runs no
  further gate over them; the one reader after settlement is a post-commit
  effect's release check, so a commit releases them once its inline effects
  have flushed, an abort or a commit refused before storage releases them at
  once, the refusal keeping its reasons, and a transaction whose effects a seal
  destination took over keeps them, since the destination flushes after its
  wave lands.

## What is left

Per create on the worker rig, a demanded board, removing holders cumulatively in
this order. The figures are from the holder table taken at 862 KB per create,
before the last three changes under "Landed", which did not move them apart
from the holders the settled-transaction and `deepFrozenCache` entries below
describe.

- Each Topic's documents, about 135 KB per create in `SpaceReplica.#docs` and
  shared with the session's watch view, and the watch bookkeeping that remains
  around them, about 80 KB. The board's own derivations read every Topic, so
  `Scheduler.readsEntity()` holds the documents, the release pass keeps their
  watches (as long as the session still delivers them; one the server retracted
  gets no watch of its own), and the trigger index grows by about 50 KB per
  create. That is the
  cost of a demanded board whose computations stay registered after they ran.
  Letting a computation that has run keep only its basis rows, loading its
  inputs again when a change dirties it, is the design in the introduction
  applied to a demanded piece's computations; it is the largest item left and
  a change to what the scheduler keeps, not to storage.
- One settled transaction per create, 21 KB now that it releases its
  preparation records (under "Landed"): its journal and the rest of its own
  fields. It is the transaction of the start of a map element, which the
  closure change under "Landed" does not reach on three paths: the map
  builtin's action keeps the `inputsCell` the raw node hands it, which the
  node's plan binds to the start's transaction (`inputsCell.withTx(tx)` in
  `#buildRawNodeInputs`), and builtins read through that cell by `.key()` or
  `.withTx(tx)` rather than through its own transaction, though several read it
  directly during their setup, so each needs reading before the node hands them
  a cell without one; the element's `resultCell` reaches `#startCore` bound to
  the transaction from `#startWithTx`'s callers, and the start's closures
  capture it, where the nodes' `cellTx(resultCell)` checks decide local-read
  behavior from that binding; and the immutable cell store's snapshots keep a
  query-result proxy made under the transaction. Cutting the paths one by one
  has each next one take the charge over, so the three go together.
- `deepFrozenCache` is a `WeakSet`, and the charge the tools gave it was the
  weak set's own table, which V8 sizes by the peak number of live frozen
  objects; it fell to nothing once the transactions above were released, since
  what they kept was frozen documents. The entry is kept here because the
  charge will come back with any holder that keeps frozen values, and it names
  the holder, not the cache.
- The read logs of the active computations, about 42 KB, which grow with the
  index for the same reason.
- Bounded caches still filling: `watchIds` 30 KB, `DerivedInternalCellIds`
  35 KB and `stringRepCache` 10 KB are LRU caches, and each stops growing at
  its bound. `sortedKeyCache` 13 KB and `externalRefHashCache` 12 KB are weak
  maps, which grow with the lifetime of their keys, so they fall when the
  holders above do.
- The provider's `#syncRequests`, 17 KB, and the storage manager's
  `#documentHolds`, 7 KB, for the documents the board holds.

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
