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

Each create now leaves about 1.2 MB, against 3.6 MB before. The toolshed's heap
limit is 8 GB per isolate (`deploying.md`). Server CPU per create is unchanged:
0.24-0.43 s before and 0.25-0.37 s after, two alternating rounds of three, 100
creates each, at load 77-269.

## Landed

- A pattern built while a program runs binds a child graph that reaches no outer
  cell once rather than per event (`moduleWithReusedGraphBindings`).
- Once a handler's transaction commits on a serving runtime, its result is released
  (`#releaseServedHandlerResult` in `runner.ts`, serving-loop.md §1). A demand for a
  value, or an event to a stream, starts the piece again.
- The release drops the result pattern's keyless index entry, and a stopped piece's
  node bindings go too (`NodeBindingMemo.release()`). Both hold the cells of the run
  that started it, and through them its transaction.

## What is left

These come from snapshots at 101 and 301 Topics, per create, removing holders in
this order. The total is about 1.27 MB, and a transaction no longer stays per create.

- `ImmutableCellStore.#snapshots`, 285 KB: a child's immutable inputs documents,
  which outlive the stopped piece. `getImmutableCell()` makes them owned by their
  frozen values and live handles, yet they stay in the runtime's root store, so start
  from what puts them there. `bindImmutableCells()` in `traverse-recorder.ts` and
  `#retainValue()` are the first places to read.
- `deepFrozenCache`, 252 KB, and `sortedKeyCache`, 83 KB. Both are weak tables, so
  their size should follow the live objects they name and fall as those do. Check
  them again after the holders above and below shrink.
- `SpaceReplica.#docs`, 175 KB: the worker's copy of the documents a create wrote,
  which nothing evicts.
- `DerivedInternalCellIds`, 45 KB, a bounded cache that is still filling.
- `stringRepCache`, `#documentHolds` and `Provider.#syncRequests`, about 15-35 KB
  each.
- About 255 KB in no one holder, led by the scheduler's trigger index, which grows
  because the board's own derivations read every Topic.

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

3. **Take two snapshots of a growing heap.** Run the loop on the main thread, since
   the inspector reaches nothing else, and first check that the growth per create
   matches the worker's. Divide by the work between them, so a one-time load shows
   up as what it is. Take the first after 100 or so, since an empty board's first
   creates load modules.

   ```bash
   EXPERIMENTAL_SERVER_EXECUTION=true EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION=true SERVER_EXECUTION_WORKER=false ./scripts/start-local-dev.sh --port-offset 640 --inspect
   ```

   ```bash
   deno run --allow-net --allow-write skills/perf-investigation/scripts/heap-snapshot.ts 9869 a.heapsnapshot
   ```

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
