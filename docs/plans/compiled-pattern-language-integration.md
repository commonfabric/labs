# Compiled pattern language: measuring it in the real runtime

This plan says how the design of the
[compiled pattern language](../specs/compiled-pattern-language/README.md) is
validated from here on: what is built into the prototype, what is built into
the runtime, in which order, and what each step measures. It is a companion
of the design's own plan,
[compiled-pattern-language.md](compiled-pattern-language.md), which holds
the owner's rulings, the provisional decisions and the open questions. The
strategy below is the coordinator's provisional decision P30 there and is
not an owner ruling.

## Where things stand

The prototype on branch `claude/compiled-pattern-prototype` (draft pull
request #9942) is a Rust crate at `base/pattern-compiler/` that compiles a
pattern to a plan and value code, an executor in TypeScript that runs the
two (`base/pattern-compiler/exec/`), and a harness that runs the same
modules on today's runtime and compares (`base/pattern-compiler/compare/`).
Of the 215 corpus modules today's runtime runs in the comparison, the
executor runs 214; 6,013 of 6,107 compared values are equal, and no compared
label is looser than today's. Its run times over those modules, from the
table of the design's plan ("Run times: the executor beside today's
runtime"):

| | Prototype | Today's runtime |
| --- | ---: | ---: |
| Compile | 1.4 s | 64.5 s |
| To a settled result | 0.3 s | 14.2 s |
| 541 events | 1.6 s | 43.7 s |

These figures say little about a finished runtime, because the executor
does none of the following, each of which today's runtime does on every
run:

- **Contextual Flow Control at commit.** `ExtendedStorageTransaction.commit()`
  (`runtime/runner/src/storage/extended-storage-transaction.ts`) runs
  `prepareForCommit()`, and for a relevant transaction the verification of
  `prepareCfc()` (`runtime/runner/src/cfc/prepare.ts`), which derives a
  label for every written path and persists it. Today's runtime made 2,822
  preparations to settle the corpus.
- **Storage transactions.** A read journal, staged writes, the commit into
  the space's replica and the store
  (`runtime/runner/src/storage/v2-transaction.ts`,
  `runtime/memory/v2/engine.ts`), the encoding of values, and the
  notification of subscribers.
- **A scheduler across instances.** Today Scheduler v2
  (`runtime/runner/src/scheduler/`); in the design, the address index,
  demand and event queue of `scheduler-and-serving-loop.md`.
- **A network.** Every figure so far, on both sides, uses the runtime's
  emulated storage (`StorageManager.emulate` in
  `runtime/runner/src/storage/cache.deno.ts`), with no memory server and no
  socket.
- **A sandbox.** Today's runtime evaluates compiled pattern code in SES
  compartments under a module policy (`runtime/runner/src/sandbox/`). The
  executor evaluates value code with `new Function`.

## The options

### A. Build the missing pieces into the prototype

The prototype would gain a store with a journal and a commit, label
instantiation at commit with constraint checks, a scheduler, and a sandbox.

- **What it costs.** `base/` cannot import `runtime/` (the pace layers of
  `AGENTS.md`), so a store with transactions, an encoding, an envelope of
  labels and a commit would be written again in the prototype. That is the
  core machinery the `cf-review` skill flags when it is duplicated: hashing,
  serialization, identity and labels. The CFC kernel is held to the
  specification's pseudocode by the correspondence procedure
  (`docs/development/cfc-spec-correspondence.md`); a second copy of it in
  the prototype would be held to nothing.
- **What it measures.** The cost of the copies, not of the runtime the
  design would run in. The figures stay synthetic.
- **Where it is the right answer.** For the parts of the design that are
  new code under either option: the design's scheduler, label templates and
  their instantiation, keys of elements, and the layout of a result. Writing
  those in the prototype first duplicates nothing of today's runtime.

### B. Run plan-driven execution inside the runtime

The executor runs inside the runtime: its documents are entities of a
space, each of its transactions is a transaction of the runtime with the
runtime's commit and CFC preparation, its events come through the
scheduler, and its value code runs in the runtime's sandbox. The same
pattern can run both ways in one runtime, under one harness.

- **What it costs.** An adapter between the executor and the runtime, and a
  way to get the crate's output into the runtime.
- **What it measures.** The real cost of the storage, the CFC preparation,
  the scheduler and the sandbox, on the corpus, beside today's path.
- **The risk.** Coupling to today's semantics could hide where the design
  deliberately differs. Taken one difference at a time:
  - *Keys of elements.* The design keys an element by its identity or its
    value, not its position. The executor forms and keeps the keys itself
    and stores arrays as positions, as today's storage does, so this stays
    the design's as long as the executor owns it.
  - *Which documents an instance has.* The executor's layout, a result
    document with the kept outputs, state cells, documents of outputs and
    streams, is the design's. Stored as entities of a space it stays the
    design's. Part documents and chunks (provisional decisions P20 and P25
    to P29) need storage to carry a patch to a subscriber (question 290,
    point (a)); they are not needed to measure anything below.
  - *One transaction per cause.* The executor's transactions map one to one
    onto the runtime's.
  - *Labels.* The design instantiates a label per written path from the
    plan's templates (`execution-and-storage.md` §1.9, item 2). Until that
    is built into `prepareCfc()`, the runtime derives today's join over the
    reads of each transaction and stamps it on every written path. The
    labels stored before milestone 4 are therefore today's rule applied to
    the design's transactions, and the measurement is of its cost, not of
    the design's labels.
  - *The schema of a write.* A transaction relevant to Contextual Flow
    Control that writes a document which already carries labels must
    record the schema of that write (`recordCfcWritePolicyInput` of the
    runtime's transaction, which today's `Cell.set` calls); otherwise the
    commit is refused with "missing schema write-policy input"
    (`runtime/runner/src/cfc/prepare.ts`). The executor writes values and
    no schema of its own. The executor's store now reports the schema of
    the reference each write is made through, and the adapter records it
    with the runtime's `recordRelevantSchemaWritePolicyInput`, which falls
    back to the schema the document's stored labels name, as `Cell.set`
    does. The first corpus run of milestone 1 had no such record and saw
    176 commits refused.
  - *A conflict on a derived write.* By ruling, the commit withdraws that
    write alone and the rest commits. The memory server applies a commit
    whole or refuses it, and names what was stale: a direct commit with the
    entities of its stale reads (`ConflictError.conflicts` in
    `runtime/memory/v2/engine.ts`), a wave commit of the serving loop with
    the contribution each stale read belongs to (`WaveStaleReadError`),
    after which the wave commit step tries again without that
    contribution. So the ruling is implementable on today's storage as a
    second attempt that leaves the withdrawn units out, if each derived
    write is a contribution of its own, and not as one atomic commit. What
    that second attempt costs is measured in milestone 6; the prototype
    has no conflict at all.

### C. A second executor written for the runtime

A new executor in `runtime/runner`, with the prototype's kept for
comparison. Rejected: two implementations of one evaluation semantics, of
which only one would be compared with today's runtime.

## Recommendation

Provisional decision P30: **option B, with one executor.** The prototype's
executor stays the one implementation of the design's evaluation semantics.
It reaches the runtime through a small interface: the executor tells a
store outside it of each transaction (`TransactionHooks` in
`base/pattern-compiler/exec/executor.ts`), and an adapter implements that
interface with the runtime's own transactions. The in-memory store and the
comparison harness stay as the reference for semantics. New semantics, the
design's scheduler included, are written in the prototype first and reach
the runtime through the same kind of interface.

How each part of the question is answered:

- **The crate in the build.** Until milestone 5 the crate runs ahead of
  time, as it does for every comparison: `pattern-compiler emit` writes the
  plans and the value code, and the harness loads them. When the runtime
  compiles on load, the crate runs as a native binary in the compile worker
  (`ModuleCompileWorker` in
  `runtime/runner/src/harness/module-compile-worker.ts`), since only the
  server compiles (`scheduler-and-serving-loop.md` §10.5). A WebAssembly
  build of the crate is needed only where no native binary can run; the
  ruling that the compiler emits no WebAssembly is about its output and is
  not affected. No continuous-integration job builds the crate today;
  milestone 3 adds one, or checked-in artifacts for its tests.
- **Layering.** The executor reads and writes nothing but values from
  `@commonfabric/data-model`, so it belongs in `base/`. The adapter touches
  storage, CFC and the sandbox, so it belongs in `runtime/runner`, under
  `src/compiled/`. In milestone 1 the adapter is in
  `base/pattern-compiler/compare/` beside the harness of today's runtime,
  which already imports the runner by relative path; the package is no
  workspace member, nothing in the runtime calls it, and it is a
  measurement. Milestone 3 makes the executor a workspace package (its path
  in the root `deno.jsonc`, a `test` task, a checked path in
  `tasks/typecheck.ts`) and moves the adapter into the runner. That move
  waits until the paused work on provisional decision P18, which changes
  the executor in another worktree, has landed.
- **What is shared, not duplicated.** Hashing and identity: the executor's
  identifiers are `taggedHashStringOf()` of `base/data-model`, and the
  adapter names the entity `of:<identifier>`; milestone 3 has the executor
  mint the runtime's entity identifiers itself, so that one scheme remains.
  Serialization: the runtime's transactions encode, the adapter does not.
  Links: the adapter writes the runtime's link with
  `createSigilLinkFromParsedLink()` and reads it with `parseLink()`. Labels:
  milestone 4 instantiates templates with the runtime's label operations in
  `runtime/runner/src/cfc/`, and the prototype's template evaluator
  (`compare/template.ts`) stays a test oracle only.
- **The flag.** Milestone 1 needs none, because nothing in the runtime
  reaches the adapter. Milestone 3 adds one experimental option, off by
  default, that lets the runner run a piece from a plan, registered in
  `docs/development/EXPERIMENTAL_OPTIONS.md` in the same change. The ruling
  that a space runs one path or the other becomes a mark of the space that
  the option permits.
- **The CFC specification process.** Milestones 1 to 3 are a host
  arrangement: the reads and writes go through
  `ExtendedStorageTransaction.commit()` and `prepareCfc()` unchanged, and
  what differs is how work is grouped into transactions. Milestone 4, labels
  from templates in place of the join, is a semantic gap: the rule is in
  specs pull request #91, which is a draft. Code lands behind the
  milestone 3 option with a `SPEC-PENDING` marker at the deciding site, or
  after that pull request merges; it changes what is stored, so it never
  runs at the default.

## Two tracks, one target

The owner chose on 2026-11-18 to continue on both sides at once, each with
a goal of its own, and to take Topics (`patterns/apps/topics/`) as the
target both work toward. Topics is a pattern of the product, it is slow at
around 1,000 topics on today's runtime, and today's figures for it exist
(`patterns/integration/topic-board-navigation.bench.ts`, and the record
`docs/history/development/performance/2026-09-25-server-execution-topics-lunch-benchmarks.md`).
It tests the design's central claim at the size where it matters: that the
cost of one change does not grow with the length of a list.

- **The prototype track is the reference for semantics.** Its goal: Topics
  at 100, 1,000 and 2,000 topics runs on the executor, with the values of
  today's runtime and no label looser. It reimplements nothing of the
  runtime. In order: the crate emits the corpus of the main branch (it
  stops on two failures today, which the method of the figures below
  names); then Topics. Emitted with its imports on the main branch,
  Topics' board (`main.tsx`) has no unsupported construct and three errors
  of the subset type checker, and the pattern of one topic (`topic.tsx`)
  has one call the emitter does not resolve, 73 writes through a handle
  the emitter cannot name, and about 30 errors of the type checker, most
  of them arguments of a handler that are not assignable. After Topics:
  P18 and the reference patterns, FabriChat and `system/home/home.tsx`.
- **The integration track is the reference for cost.** Its goal: one
  honest figure for Topics at those sizes, beside today's runtime on the
  same harness (milestone 2). It builds only what that figure needs, and
  where the design replaces a mechanism of today's runtime, as templates
  replace the write policy taken from a schema, it does the least that
  makes the figure honest rather than port the mechanism.
- **What decides whether to continue.** The cost of one change at 1,000
  topics on the integrated path against today's, and how it grows from 100
  to 2,000. Today's runtime is measured in both postures: the client
  posture of the comparison harness, which milestone 1 used, and
  server-side execution, which is what a deployment runs and what today's
  figures for Topics are of. The integrated executor runs in the client
  posture until milestone 6, so if today's server-side path is much cheaper
  than its client path, the serving loop moves ahead of the scheduler. If
  the integrated cost is not clearly below today's, or grows with the size
  of the board, both tracks stop and report before milestone 3. Otherwise
  the scheduler comes next.

## Milestones

Each milestone ends with the corpus run both ways and the values compared,
and reports what it measures beside the figures before it.

1. **The executor's documents in the runtime's storage.** Each transaction
   of the executor is a transaction of the runtime: each position it reads
   is read through the transaction, each change is staged as it is made,
   and the commit runs with its CFC preparation. The append of an event to
   its stream and the watermark that passes it are transactions of their
   own, as the executor makes them. An input can be a labeled cell that the
   argument links to, as today's harness writes it. *Measures:* what
   storage transactions and today's CFC preparation cost at one transaction
   per cause. *Does not measure:* the scheduler, the sandbox, template
   labels, the network; the executor still schedules itself, and the
   storage is emulated. *Status:* built
   (`compare/runtime-transactions.ts`, `compare/integrated.ts`); the first
   figures are below.
2. **Topics at scale on the runtime's storage.** The board and the topics
   of `patterns/apps/topics/` at 100, 1,000 and 2,000 topics, run by the
   executor on the runtime's storage with labeled inputs: the board's load,
   the creation of one topic, and an edit of one topic, each beside today's
   runtime on the same harness, with every commit accepted. Until the crate
   emits Topics, the same claim is measured on the prototype's fixtures of
   a list (`compare/growth.ts`, 100 to 10,000 rows over an array of
   references, an array of plain values in place and the result of another
   per-element construct) with the documents in the runtime's storage.
   *Measures:* whether the cost of one change stays flat in the size of the
   board on real storage, and how it compares with today's. *Decides:*
   whether the work continues (see "Two tracks, one target").
3. **A compiled piece in the runner.** Behind the experimental option the
   runner starts a piece from a plan. Its events come through stream cells
   and the scheduler, its store reads through the replica, and the change
   channel tells it of writes by others. One harness starts and drives both
   paths with the runtime's own calls (`Runtime.run`, `sendEvent`).
   *Measures:* the scheduler and the routing of events, and the first
   figure per event from send to settled that compares like with like.
   *Needs first:* a crate that emits the corpus of the main branch, which
   it does not today (the method of the figures below says where it
   fails), and the decision of milestone 2.
4. **Labels from templates at commit.** `prepareCfc()` instantiates the
   template of each path the plan covers and checks the plan's constraints
   (`execution-and-storage.md` §1.9). The label comparison of
   `compare/corpus.ts` runs against the integrated path. *Measures:* the
   cost of instantiating templates against the join, and the labels the
   design stores, compared with today's from the same runtime.
5. **Value code in the sandbox.** The module texts of value code are
   evaluated in an SES compartment under the runtime's module policy, and
   the runtime compiles on load with the crate in the compile worker.
   *Measures:* the cost of the sandbox at load and per call, and of
   compiling on the server.
6. **Server execution and the network.** The serving loop, with its waves
   and seals, and a memory server reached over a socket. FabriChat, once
   the crate emits `room.tsx` and `manager.tsx`, and `system/home/home.tsx`.
   *Measures:* what the existing serving benchmarks measure for today's
   path, such as a FabriChat send and a Topics board.

The design's storage changes, part documents and chunks, are in no
milestone. If they become a requirement on storage, they are measured where
storage builds them, with the harness of milestone 3.

## What stays in the prototype

- The crate: the front end, the subset type checker, footprint analysis,
  the plan and value code, and its corpus reports.
- The executor's in-memory store and its tests, and the comparison harness:
  the values (`compare/values-corpus.ts`), the labels (`compare/corpus.ts`),
  and the fixtures of growth. A question of semantics is settled there
  first, where the corpus runs in minutes with no runtime, and the
  integration follows.
- The counts derived from a plan (`compare/cost-model.ts`), and the table of
  run times of the executor alone (`compare/times.ts`), which is the lower
  bound of the integrated figures.

## Risks

- **The executor relies on the identity of the objects it holds.** The keys
  of a stored array are kept by the array object (`KeyState` in
  `exec/store.ts`). A store that reads through the replica keeps the
  documents in memory between transactions and replaces them when the
  change channel says another writer changed them; it does not read them
  again on every access.
- **The executor assumes it is the only writer.** In milestone 3 a client,
  another instance, or a handler of another pattern can write what it reads.
  The marking of readers (`scheduler-and-serving-loop.md` §3) has to be
  driven by those changes as well as by its own.
- **Readers outside the executor read today's forms.** The executor stores
  a path of a link that crosses an array by key as the key's text, which
  the runtime does not resolve, and it nests the children of a rendered
  tree differently from today's runtime, which the harness translates
  (`base/pattern-compiler/README.md`, "Value code and the executor").
  Before the shell renders a compiled piece in milestone 3, the executor
  has to store the rendered tree in the form the renderer reads, and a link
  that the runtime can follow, or the readers of such a document have to be
  compiled too (`execution-and-storage.md` §9.9).
- **The executor's own cost.** It was written to be read. In one corpus
  module it is slower per event than today's runtime
  (`showcase/battleship/pass-and-play/main.tsx`, 7.64 against 5.64 ms).
  Each milestone profiles the integrated run, so that the executor's cost
  and the runtime's cost are reported apart.

## Milestone 1: first figures

**Method.** `compare/integrated.ts` runs each module that a run of today's
runtime recorded (`compare/values-corpus.ts run`) three ways, on the
argument and the committed events of that run: the executor with its
documents in memory (`memory`), the executor with its documents in the
runtime's storage and the argument in place (`plain`), and the same with
each input a cell of its own under a schema that declares a clause, the
argument linking to each (`labeled`). Today's figures are those of
`compare/cost.ts run`, which writes the inputs the same way as `labeled`
and sends the same generated events. A time of `plain` and `labeled` runs
from the start of the executor's work to the settlement of every commit it
made; a time of today's runtime from the send to the runtime idle with
every kept output read, the reads of labels by the harness included. Both
use the runtime's emulated storage, with no memory server and no socket.
Both run in the client posture: a `Runtime` constructed with no serving
host resolves `serverExecution` off (`getServerExecutionConfig` in
`runtime/memory/v2.ts`), although the first-party default that deployed
entry points apply is on. So the comparison is with today's runtime where a
client derives and commits itself, and not with server-side execution,
where a client commits only the append of an event and the serving loop
commits one derived transaction per wave with the stream's watermark in it.
All runs were made at the prototype's commit `3d33db2e4d` with the code of
milestone 1 added, which is the corpus and the runtime of the table of run
times in the design's plan, because the crate does not emit the corpus of
the main branch of 2026-11-18 (`6e9ff5a381`). With
`patterns/apps/weekly-calendar/view-walk.ts`, a helper of pattern tests
that came in with pull request #9825, or one of the four tests that import
it, footprint analysis does not finish: after three minutes a sample of the
process has every frame in `footprint::normal_map`. Each file alone
analyzes in under 0.2 seconds. Without those five files the crate panics
with an index out of bounds in `oxc_index`, on main's changes under
`patterns/system/` taken together; no single directory of them reproduces
it. The prototype's own corpus emits in 2.5 seconds. Each command ran in a
process of its own on one machine, with no other work of this session
running. The integrated runs and today's run were made twice, each pair
back to back, and both pairs are given; today's time to settle differs by
two thirds between the two.

**The corpus.** 215 modules run on today's runtime in the comparison, the
executor runs 214, and 213 run in all three ways: one more fails in the
runs in storage at the creation of its argument
(`examples/cfc-exchange-rules/witnessed-chain.tsx`), not examined. In this
session's values run 6,013 of 6,107 compared values equal today's, the
figure of the design's plan, so the hooks change no value of the executor.

| Over 213 modules | In memory | In storage, argument in place | In storage, labeled inputs | Today's runtime |
| --- | ---: | ---: | ---: | ---: |
| To a settled result, first pair | 593 ms | 1,894 ms | 1,687 ms | 25,302 ms |
| To a settled result, second pair | 662 ms | 2,184 ms | 2,021 ms | 42,586 ms |
| 536 events, first pair | 2,833 ms | 8,246 ms | 9,980 ms | 72,607 ms |
| 536 events, second pair | 2,923 ms | 9,510 ms | 10,279 ms | 75,400 ms |
| Commits to settle | | 426 | 424 | 1,458 |
| Commits for the events | | 1,959 | 1,780 | 1,448 |
| CFC preparations to settle | | 0 | 95 | 2,743 |
| CFC preparations for the events | | 0 | 421 | 2,067 |
| Reads journaled to settle | | | 1,834 | 492,625 |
| Reads journaled for the events | | | 33,759 | 2,255,897 |

The executor journals a position once per transaction; today's count is
every read the journal holds, so the last two rows are not counts of the
same thing.

**The two modules of the milestone,** and the one module of the corpus
that is slower than today. Milliseconds; a range is the two pairs of runs.

| Module | To settle: memory, labeled, today | Per event: memory, labeled, today | Commits for the events: labeled, today | Preparations: labeled, today |
| --- | --- | --- | --- | --- |
| `examples/counter/counter.tsx` | 0.5–1.0, 3.5–4.0, 28 | 0.19–0.25, 2.9–3.7, 15–17 | 11, 10 | 6, 15 |
| `examples/simple-list/simple-list.tsx` | 1.9–2.5, 5.4–5.8, 138–166 | 0.5–0.6, 4.4–5.7, 69–78 | 29, 60 | 14, 90 |
| `showcase/battleship/pass-and-play/main.tsx` | 5.2–6.2, 11–12, 118–189 | 13.5–13.7, 26–249, 7.7–9.7 | 12, 4 | 0, 0 |

**What the figures say.**

- **Commits are most of the added cost.** With the argument in place, the
  events take 5,910 ms of synchronous work in the second pair (the executor,
  the reads through the transaction, the staging and the local commit),
  against 2,923 ms in memory: about 1.5 ms more for each of the 1,959
  commits. Waiting for those commits to settle adds 3,600 ms more, about
  1.8 ms each. How much of that wait is work and how much is idle was not
  measured.
- **The executor commits more often per event than today's runtime,** 3.3
  to 3.7 against 2.7 on average, because the append of the event and the
  watermark that passes it are commits of their own beside the event's
  transaction and the derivation behind it. Whether the watermark belongs in the
  event's transaction is not decided by the documents
  (`scheduler-and-serving-loop.md` §5.5); there it would save one commit
  per event.
- **It prepares CFC far less often:** 95 against 2,743 preparations to
  settle and 421 against 2,067 for the events, which is the design's one
  preparation per transaction. What a preparation costs is not resolved
  here: the difference between the labeled runs and the runs with the
  argument in place is smaller than the difference between two runs.
- **176 commits of the labeled runs were refused, in 79 modules,** all but
  one with "missing schema write-policy input": the write of a document
  that already carries labels, with no schema recorded for it (see
  "The schema of a write" above). The other one is a writer-fit misfit.
  The 38 modules where a labeled run stores other values than the run in
  memory are these refusals. The runs with the argument in place have no
  refusal, and store the values of the run in memory in 206 of 213
  modules; each of the other 7 reads the wall clock or calls
  `crypto.randomUUID()`, which the comparison does not make equal between
  two runs.
- **With the schema of each write recorded, 13 commits are refused, in 5
  modules** (a third pair of runs). 9 are conflicts of the store ("stale
  confirmed read") and 1 a "pending dependency not resolved". The executor
  writes its documents and never subscribes to them, so the replica's
  confirmed view of each stays at seq 0 while the store's moves on: an
  accepted commit retires its pending entries only once the confirmed view
  reaches the commit's seq, and that view advances when the store delivers
  the document to a subscription. A later commit relevant to Contextual Flow
  Control that reads such a document, the instance's argument document in
  the two `scoped-group-chat` modules, is refused as stale. With the adapter
  subscribing to each document it writes, as the runtime syncs the cells it
  runs, none of these is refused (tried on those two modules and on
  `examples/map-demo/map-demo.tsx`). 2 are "type changed incompatibly", a
  defect of the labeled runs' setup: the driver writes each input through
  `Cell.set`, which stores each record of an array as a document of its own
  and the array as links to them, and gives the executor the same input
  with its records held in place, so a handler's write of a member of a
  record lands, in storage, below a link. Today's runtime accepts a write
  below an index of an array that holds strings in place, checked
  directly. 1 is the writer-fit misfit. The labeled runs then store the
  values of the run in memory in 191 of 213 modules. Of the other 22, 5
  have a refused commit, 6 read the clock, and in 11 an element record that
  the run in storage holds differs from the run in memory with no commit
  refused. A
  run of one of the 11 alone (`apps/project-list/main.tsx`) stores the
  same element records as the run in memory, and the cause was not found.
  The same pair took 4,537 against 60,900 ms to settle and 25,085 against
  191,688 ms for the events, with 434 CFC preparations for the events
  against 2,067; every time of it is about three times those of the two
  pairs above, on both sides, because the machine was busy with other work
  then, and it is given for the ratio and the counts alone.
- **`showcase/battleship/pass-and-play/main.tsx` is slower than today's
  runtime per event by the executor's own work:** 13.5 ms in memory
  against 7.7 to 9.7 ms for today's whole event. The prototype's last
  round found one of its four events taking 47.8 ms, with 1,140 element
  evaluations over the run, so that event evaluates the element bodies of
  the board wholesale; not investigated yet. One labeled run of it took
  249 ms per event on average and the other 26 ms; that was not examined.
- **The ratios overstate what a compiled runtime gains.** The executor runs
  no scheduler, no sandbox and no network, and today's figures include the
  harness reading labels between events. They are an upper bound on the
  gain until milestones 3 to 6.

**Not examined.** The failure of `witnessed-chain.tsx` in storage, which
the change to the covering path did not fix; the 11 labeled modules that
store another element record with no commit refused; the outlier of the labeled
battleship run; how much of the wait for a commit to
settle is idle; and why the driver's own comparison with today's values,
made in the same process after the runs, finds 5,637 of 6,053 equal where
the values run finds 6,013 of 6,107.
