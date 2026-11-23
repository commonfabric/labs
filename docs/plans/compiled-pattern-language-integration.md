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

**The stack.** The work is four draft pull requests, each based on the one
before it: #9788, the design documents; #9942, the prototype
(`claude/compiled-pattern-prototype`); #9992, the integration
(`claude/compiled-pattern-integration-m1`), which holds milestone 1, milestone 4
through code round m, and the catch-up merge with `main`; and #10016,
Topics on the executor (`claude/compiled-pattern-topics`), which does not hold
milestone 4. The branch `claude/compiled-pattern-m4`, on which milestone 4 was
built, is retired. A change to a pattern that the work needs goes to `main` in a
pull request of its own (#10036 and #10050, open; #10054, closed without a
merge). The integration branch holds current `main`; what the merge did is in
"The catch-up merge with `main`" under milestone 4.

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
    to P28) need storage to carry a patch to a subscriber (question 290,
    point (a)); they are not needed to measure anything below. Chunked
    storage of long arrays is a requirement on the storage layer, which
    today's runtime has as well (the design's plan, "The scope of the
    storage decisions").
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
  not affected. No continuous-integration job builds the crate; the tests
  of milestone 3 load the checked-in artifacts of `compare/fixtures/`.
- **Layering.** The executor reads and writes nothing but values from
  `@commonfabric/data-model`, so it belongs in `base/`. The adapter touches
  storage, CFC and the sandbox, so it belongs in `runtime/runner`, under
  `src/compiled/`. In milestone 1 the adapter is in
  `base/pattern-compiler/compare/` beside the harness of today's runtime,
  which already imports the runner by relative path; the package is no
  workspace member, nothing in the runtime calls it, and it is a
  measurement. On the branch of milestone 3 the adapter is
  `runtime/runner/src/compiled/transactions.ts`, which
  `compare/runtime-transactions.ts` re-exports, and the runner imports the
  executor by relative path (provisional decision P50). The executor as a
  workspace package (its path in the root `deno.jsonc`, a `test` task, a
  checked path in `tasks/typecheck.ts`) is not built: `compare/`, which
  imports the runner, is in the same directory and has to move first.
- **What is shared, not duplicated.** Hashing and identity: the executor's
  identifiers are `taggedHashStringOf()` of `base/data-model`, and the
  adapter names the entity `of:<identifier>`. On the runner path of
  milestone 3 the result document is the entity of the result cell and
  every other document is named the same way; the executor minting the
  runtime's entity identifiers itself, so that one scheme remains, is not
  built.
  Serialization: the runtime's transactions encode, the adapter does not.
  Links: the adapter writes the runtime's link with
  `createSigilLinkFromParsedLink()` and reads it with `parseLink()`. Labels:
  milestone 4 instantiates templates with the runtime's label operations in
  `runtime/runner/src/cfc/`, and the prototype's template evaluator
  (`compare/template.ts`) stays a test oracle only.
- **The flag.** The whole effort is behind one experimental option, off by
  default. Milestones 1 and 2 need none, because nothing in the runtime
  reaches the adapter. The first of milestones 3 and 4 to be built adds
  the option, registered in `docs/development/EXPERIMENTAL_OPTIONS.md` in
  the same change: under it the preparation takes labels from templates
  (milestone 4) and the runner runs a piece from a plan (milestone 3). Every
  other milestone runs under it with no option of its own. The ruling that
  a space runs one path or the other becomes a mark of the space that the
  option permits.
- **The CFC specification process.** Milestones 1 to 3 are a host
  arrangement: the reads and writes go through
  `ExtendedStorageTransaction.commit()` and `prepareCfc()` unchanged, and
  what differs is how work is grouped into transactions. Milestone 4, labels
  from templates in place of the join, changes what Contextual Flow Control
  decides. Its rules are those of specs pull request #91, and the work
  assumes that pull request lands as it stands. It runs under the option of
  milestone 3, which is never on by default, and needs no further option.
  Where code reaches the main branch before that pull request merges, its
  deciding sites carry the `SPEC-PENDING` marker the procedure requires.

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

**The order of work.** The numbers name the milestones and are not their
order. The owner asked on 2026-11-19 for milestone 4, labels from templates
at commit, sooner. It is built next, on the adapter of milestone 1 and
beside milestone 2, and does not wait for milestone 3. The reason is in the
first figures below: with one transaction per cause, today's join stamps
one label on everything a settle writes, so the labels that milestones 1 to
3 store are too wide, commits are refused that the design accepts, and the
cost of preparation that milestone 2 would report is of a rule that neither
today's runtime nor the design applies at that grouping. The figure that
decides whether the work continues is therefore taken with milestone 4 in
place. Milestone 4 needs from milestone 3 only the experimental option,
which it adds itself (see "The flag" above); nothing else of the runner
changes for it.

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
   fails), and the decision of milestone 2. *Status:* built on the branch
   `claude/compiled-pattern-runner-m3` for one writer on emulated storage:
   the start, the events, the store, the writes by others, the rows of a
   `map` over an array declared as references as documents of their own,
   and what follows a refused commit. Not built: the load in bounded
   transactions, sync and resume, readers outside the executor, the shell,
   and the corpus on the runner path. The figures and the open findings are
   in "Milestone 3: a compiled piece in the runner" below.
4. **Labels from templates at commit.** Today `prepareCfc()` derives one
   label, the join over everything the transaction read
   (`deriveFlowJoin` in `runtime/runner/src/cfc/prepare.ts`), and stamps
   it on every path the transaction writes. With one transaction per cause
   that join covers far more than one node's reads, so milestones 1 to 3
   store labels that are too wide (see "Milestone 1: first figures",
   `briefing.tsx`). Milestone 4 replaces it, for every path the plan
   covers, as `execution-and-storage.md` §1.9 describes:
   - *The label of a written path* is its template from the plan
     (`Plan.outputs`, the write edges, the state cells; the templates of
     `plan-and-label-templates.md` §3), instantiated with the labels of
     the slots that template names, which are the labels of the places
     that output reads and nothing else. The preparation instantiates the
     template itself, with the runtime's label operations; it accepts no
     label the executor computed.
   - *The plan's constraints* (write-floor, writer-fit and egress,
     `plan-and-label-templates.md` §4.4) are checked from the same
     templates, and a failed constraint drops a derived write alone or
     rejects the event's transaction whole, by ruling.
   - *The prepared digest* binds the compiled pattern's identity and each
     template's instantiation key, and the preparation records what it
     verified per unit, so that a conflict can withdraw one derived write
     (§1.9, items 3 and 4).
   - *The journal* stays the read set for conflicts, and the source of the
     `dynamic` templates (§1.9, item 5).

   The executor tells the adapter, for each write, which plan record it
   belongs to and which slots that record's template is bound to, and the
   adapter records that in the transaction for the preparation. The label
   comparison of `compare/corpus.ts`, which today evaluates templates in
   TypeScript beside the runtime (`compare/template.ts`), then compares
   what the runtime stores on the integrated path with what today's
   runtime stores. It assumes specs pull request #91 lands, and runs under
   the option of milestone 3 ("The CFC specification process" above).
   *Measures:* the cost of instantiating a template per written path
   against one join per transaction, and the labels the design stores,
   compared with today's from the same runtime. *Status:* built on the
   integration branch, steps 1 to
   10 and 13 of its plan, behind the experimental option
   `compiledPatterns`; steps 11 and 12, instantiation keys and verified
   units in the prepared digest and a derived write dropped alone, are
   not. Specs pull request 91 was updated on 2026-11-19. The figures and
   the open findings are in "Milestone 4: labels from templates at commit"
   below.
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
  again on every access. Milestone 3 builds this: the store asks the replica
  once for a document it does not hold (`Store` option `load`), and the
  piece applies each change of another writer to the copy in memory, a
  change of the members of an array as the one splice that makes it
  (`spliceBetween` of `runtime/runner/src/compiled/transactions.ts`). What
  it leaves: a document that is not in the replica reads as absent, and a
  document in another space than the piece's is not told of changes.
- **The executor assumes it is the only writer.** In milestone 3 a client,
  another instance, or a handler of another pattern can write what it reads.
  The marking of readers (`scheduler-and-serving-loop.md` §3) has to be
  driven by those changes as well as by its own. Milestone 3 drives it from
  the storage notifications, for values and for labels, and after a refused
  commit the piece takes what the storage holds for the documents the
  transaction wrote (provisional decisions P58 and P62). Open before two
  writers share a space: a write by another writer of a derived array, or
  above it, is not applied to the executor (P61); a handler that the
  scheduler runs again after a conflict was not driven through the scheduler
  in a test; and the work after a refusal follows the size of the result.
- **Readers outside the executor read today's forms.** The executor stores
  a path of a link that crosses an array by key as the key's text, which
  the runtime does not resolve, and it nests the children of a rendered
  tree differently from today's runtime, which the harness translates
  (`base/pattern-compiler/README.md`, "Value code and the executor").
  Before the shell renders a compiled piece in milestone 3, the executor
  has to store the rendered tree in the form the renderer reads, and a link
  that the runtime can follow, or the readers of such a document have to be
  compiled too (`execution-and-storage.md` §9.9). As milestone 3 is built,
  the runtime follows the link to a row that is a document of its own. It
  does not follow a link whose path crosses an array by key, which the rows
  of a `map` over an array of plain values in place hold, and it reads a
  state cell that has no document yet as nothing where the executor reads
  the default of its schema. The shell does not render a compiled piece, and
  the harness compares the compiled result as the executor holds it.
- **The executor's own cost.** It was written to be read. In one corpus
  module it is slower per event than today's runtime
  (`showcase/battleship/pass-and-play/main.tsx`, 7.64 against 5.64 ms).
  Each milestone profiles the integrated run, so that the executor's cost
  and the runtime's cost are reported apart. On the runner path of milestone
  3 the piece reports its own time (`CompiledPieceCounts.ownMs`): 3.0 to 3.8
  ms of an edit of a title on the Topics board `filing-order` at 100 to
  2,000 topics, and 736 ms of a create of 1,960 ms at 1,000.

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
times in the design's plan, because the crate at that commit does not emit
the corpus of the main branch of 2026-11-18 (`6e9ff5a381`). With
`patterns/apps/weekly-calendar/view-walk.ts`, a helper of pattern tests
that came in with pull request #9825, or one of the four tests that import
it, footprint analysis does not finish: after three minutes a sample of the
process has every frame in `footprint::normal_map`. Each file alone
analyzes in under 0.2 seconds. Without those five files the crate panics
with an index out of bounds in `oxc_index`, on main's changes under
`patterns/system/` taken together; no single directory of them reproduces
it. The prototype's own corpus emits in 2.5 seconds. The crate of milestone
4 emits the whole corpus ("Milestone 4: labels from templates at commit"),
and the runs of milestone 1 have not been made again with it. Each command
ran in a process of its own on one machine, with no other work of this
session running. The integrated runs and today's run were made twice,
each pair back to back, and both pairs are given; today's time to settle
differs by two thirds between the two.

**The corpus.** 215 modules run on today's runtime in the comparison, the
executor runs 214. Until the fifth pair below, 213 ran in all three ways:
`examples/cfc-exchange-rules/witnessed-chain.tsx` failed in storage at the
creation of its argument, and runs since the adapter takes the inputs as
documents the executor did not make. In this
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
- **What remains refused, after four fixes to the adapter and the
  driver.** A third pair of runs recorded the schema of each write, and 13
  commits were refused in 5 modules. Three causes were then found and
  fixed, and a fifth pair has 4 refused commits in 2 modules.
  - *A document the replica dropped.* The replica drops a watched document
    that nothing holds or reads at its next release pass
    (`releaseUnreadDocuments`), and a read through a transaction then sees
    it absent at seq 0, so a commit that read it is refused as a stale
    read: 9 conflicts and 1 "pending dependency not resolved" in the third
    pair. The adapter now registers itself as the reader of every document
    it has named (`addDocumentReader`), and none is left.
  - *The shape of the inputs.* The driver wrote each labeled input with
    `Cell.set`, which stores the records of an array as documents of their
    own, and gave the executor the records in place. It now writes an input
    as the runner writes a lift's result, `diffAndUpdate` with no source of
    anchor identifiers, so storage and the executor hold the same shape.
    That removed the 11 modules whose stored element records differed from
    the run in memory.
  - *A bug of today's runtime: 2 refusals remain.* A write below an index
    of a labeled array whose records are held in place is refused with
    "type changed incompatibly at /" (`render-test.tsx`, `map-demo.tsx`).
    The same refusal happens with no executor, for a cell write into such
    an array written as a lift's result is. The schema of the write is
    wrapped from the root down the path with every segment an object
    property (`schemaEnvelopeForTargetPath` in
    `runtime/runner/src/cfc/prepare.ts`), and merging that with the stored
    array schema fails (`schema-merge.ts`). `Cell.set` avoids it only by
    splitting records into documents of their own. The fix is pull request
    #10012, against the main branch, not merged.
  - *A result document the runtime does not own.* The settles of
    `examples/cfc-input-cell-demo/briefing.tsx` and
    `apps/budget-tracker/confidential.tsx` were refused for writer-fit,
    where today's runtime settles both with no refusal. Today's runner
    enrolls the stores of a piece when it sets the piece up
    (`enrollPieceOwnedStores` in `runtime/runner/src/runner.ts`), and a
    clause that does not fit a store the runtime owns is declared onto the
    store rather than refused (§8.12.5); the adapter enrolled nothing. A
    variant of `briefing.tsx` that writes `briefing` alone, whose value
    rightly carries "demo-secret", was refused the same way. The adapter
    now enrolls each document the executor makes, under the instance's
    result document, and both settles commit.
  - *Labels too wide, as "Labels" above predicts.* With the result document
    enrolled, the settle of `briefing.tsx` stores one label at the root of
    the result: "demo-secret" with the clause of `city`, for the value and
    the shape. So `climate`, which reads `city` alone, and the text of
    `[UI]` carry "demo-secret". Today's runtime, which runs each node in a
    transaction of its own, labels `climate` and that text with the clause
    of `city` alone, and so does the design's template; `briefing` carries
    "demo-secret" in all three. This is today's join over every read of a
    transaction, applied to the design's one transaction for the whole
    settle, and milestone 4 is what removes it ("Milestone 4: labels
    from templates at commit", "The acceptance result").

  - *What is left.* The 2 refusals of the runtime's bug above, and 2
    writer-fit misfits in `examples/cfc-exchange-rules/witnessed-chain.tsx`,
    which runs in storage since the inputs are taken as documents the
    executor did not make, and which were not examined.

  With the fixes, the labeled runs store the values of the run in memory in
  every module but the 7 that read the clock and the 2 with a refused
  write, and the runs with the argument in place have no refused commit.
  The fifth pair, over 214 modules:

  | Over 214 modules | In memory | Argument in place | Labeled inputs | Today's runtime |
  | --- | ---: | ---: | ---: | ---: |
  | To a settled result | 962 ms | 3,071 ms | 2,828 ms | 38,911 ms |
  | 541 events | 3,946 ms | 12,889 ms | 14,529 ms | 117,885 ms |
  | Commits for the events | | 1,977 | 1,973 | 1,462 |
  | CFC preparations (settle / events) | | 0 / 9 | 96 / 442 | 2,753 / 2,089 |

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

**Not examined.** The two writer-fit misfits of `witnessed-chain.tsx`; the
outlier of the labeled battleship run; how much of the wait for a commit to
settle is idle; and why the driver's own comparison with today's values,
made in the same process after the runs, finds 5,637 of 6,053 equal where
the values run finds 6,013 of 6,107.

## Milestone 4: labels from templates at commit

The figures of this section are those of the corpus run of code round m, at
commit `79d2e29dd6`, on the source of current `main`. The integration branch
holds one commit more, `dbcce35f91`, which removes a second declaration of one
flag in `runtime/runner/src/cfc/prepare.ts` and changes no behavior; no corpus
run was made at it. Two rounds precede that run on the same source: round l,
from `4363108f0c` to `482c8ed39d`, built the three changes of representation,
and round m, from `11d92e4776` to `dbcce35f91`, examined every finding of the
check, made the check deterministic and lowered the cost of the preparation. The
run at `4363108f0c` is the code of the ninth corpus run on the source of current
`main`, and is what the figures below are compared with.

**To read first.** What is unsound, stubbed or not verified comes first, then
the cost that still grows with the data, then what is fixed, then the rest.
Whenever a list is named, the case is named with it: an array of references, an
array of plain values in place, or the result of another per-element construct.

*Unsound, stubbed, or not verified.*

1. *The write records of an instance of another pattern are left out: a stub
   over a structural defect.* The comparison adapter registers one plan with the
   runtime, that of the pattern the executor is started with, and recorded every
   write under it. An instance that a handler makes of another pattern runs a
   plan of its own, and its records name records of that plan. Where the
   starting plan has a record at the same index, the runtime instantiated that
   record's template with the other instance's bindings: in the fixture
   `compare/fixtures/instantiate.tsx`, `{output: 0}` of a `Row` instance
   (`count`) was instantiated as output 0 of the starting pattern (`buttons`),
   and in `apps/calendar/calendar.tsx` the calendar's atom was minted onto a
   value that a record of an `EventDetail` instance wrote. Where the starting
   plan has no record at the index, the commit was refused: the 3 refused
   commits of `apps/base/contacts.tsx`. As stubbed, the executor tells its hooks
   of each instance it makes of another artifact
   (`TransactionHooks.instantiated` of `exec/executor.ts`), and the adapter
   leaves the records of those instances out, so their paths take the label of a
   write with no record, the transaction's join. What the stub leaves wrong:
   every label of such an instance is a join bound and rests on item 2; and a
   write of such an instance that leaves its value as it was stores no label, so
   the ruling Z67 is not met for these instances. The planned fix: register the
   plan of each instantiated pattern (`instanceOptions.artifacts` gives the
   artifact by the identity the hook is told), keep one table of inputs for each
   registered plan in a transaction, since the runtime's tables are by compiled
   pattern, and record each write under the plan its instance runs. Not built
   (open finding 1; question 348 of the design's plan).
2. *Every join bound rests on "the transaction read what flowed", and that is
   audited in one place.* A path takes the transaction's join where its record
   is given as bound (`PlanWrite.bound`), where its record lacks an input that
   its template reaches (`unbacked` of `instantiatePlanLabels` in
   `runtime/runner/src/cfc/plan-labels.ts`), where it has no record, and where
   its record is left out by the stub of item 1. The join holds what the
   transaction read through the storage. It holds nothing of a value that the
   executor took from its memory. Round l's fallback, a record that lacks an
   input takes the join and counts as a bound, stored a label narrower than what
   flowed in exactly such a case: a handler bound in a row of a `map` over an
   array that a computation returned (the result of another per-element
   construct) takes its state from the row, which is at no stored position and
   which the handler's transaction did not read. That case is fixed (item 15).
   The other sites where a value reaches a write from the executor's memory are
   not audited: the memo entries of cones, the elements of an upstream
   per-element result, the state of a binding that was copied, and what an
   instance of another pattern holds. 1,284 bounds are taken in 82 modules of
   the corpus, so the exposure is wide. Candidates in the run, not examined: 8
   write records in 3 modules store a label that lacks a confidentiality clause
   that the label of the prototype's template evaluator holds, where the
   evaluator's label is no bound. 6 are in `apps/person-workbench/main.tsx` and
   `apps/topic-workbench/main.tsx`, 3 each, with labels that are incomparable; 1
   more is in `apps/topic-workbench/main.tsx`; and 1 is the write of record
   `{"body":0,"write":1}` of `examples/scoped-user-directory/main.tsx`, which
   stores the clause of `directory` where the evaluator's label holds that of
   `me` as well. The two workbench modules are ones whose refused commits go
   through on join bounds since round l; the record of
   `examples/scoped-user-directory/main.tsx` differed in the same way at
   `4363108f0c`. The check against the values reports none of the 8. Unsound
   wherever a value reaches a write from memory, until the audit is made (open
   finding 2; question 349 of the design's plan).
3. *Suspected and not verified: an element of a `fold` whose slot is bound to an
   output may not be regrouped when a label changes.* `Instance.#idOf` of
   `exec/executor.ts`, for an element whose slot is bound to an output
   (`Bound.output`), takes the positions of that output's cone instance before
   it asks for the identifier of the instance, and the ask is what forms those
   positions. On the first ask the element's positions then lack them, and a
   change of a label there does not find the element until its next regroup. The
   branch for an element of an upstream per-element result asks first and is
   right. Read from the code; no test produces it, and for which of the three
   cases of a collection it arises is not established. The fix is a reorder of
   two statements, to be made with a test of a `fold` whose element reads a
   computed output under a change of a label that the output read (open finding
   3).
4. *A removal's `*` entry is replaced by a more specific entry of origin
   `structure`.* What decided a removal is stored once for the list, as entries
   of origin `structure` at the list's `*` path. `resolvedEntryGroups` of
   `runtime/runner/src/cfc/consumed-label.ts` resolves the classes `value` and
   `followRef` of that origin by the longest prefix, so a concrete `structure`
   entry of the class `followRef` at a slot, the stamp that a recorded link
   write mints, replaces the `*` entry for that slot, and a read there does not
   consume what decided the removal. The case is an array of references. It is
   not fixed and has no test: the comparison adapter records no link write, so
   no run produces the pair. The fix changes the resolution with the option off
   and needs the specification sentence first (open finding 4).
5. *One finding of the check is classified as an artifact and is not shown to be
   one, and 5 values are found in runs that the check does not count.* With
   every event sent three times, the write of record `{"body":1,"write":0}` of
   `product/primitives/sortable-table.tsx`, at the root of the document that
   `addRow` creates for the row it appends, depends on the input `rows` and
   stores an empty label. Read from the code: the executor names a created
   document by the number of documents the instance created before it,
   `sortByColumn` creates a document for each row, so in the run with one more
   row every later document has another number and the document compared holds
   the row of another event. By the ruling Z74 an append puts no label of the
   list on what it adds; the check's criterion for it (`appendedElsewhere`)
   compares positions of one list and does not follow a record into the document
   created for it. No test shows the classification. Apart from it, the same run
   finds 5 values in 2 modules whose run has a refused commit, 4 in
   `examples/profile-group-chat/main.tsx` and 1 in
   `examples/profile-roster-live-demo/profile-roster-live-demo.tsx`; they are
   kept apart, not counted and not examined (open finding 5).
6. *A handler that writes nothing under a condition on a labeled input stores
   nothing.* In `examples/map-demo/map-demo.tsx`, `initHandler` writes nothing
   where `initialized` is true, so no label says that the paths it could have
   written depend on `initialized`. By the owner's ruling of 2026-11-20 (Z77 of
   the design's plan) this is a channel of the specification's write gate
   proposal, a label change that a write under a secret causes, and it is
   recorded and not fixed: "assume the proposal or something equivalent
   eventually lands and so don't worry about the potential for leaks now, but
   still make sure things are sound in terms of just correctly computing the
   labels under that relaxed condition" (open finding 6).

*Cost that still grows with the data.*

7. *The preparation of a transaction that writes many documents.* The general
   preparation was quadratic in the documents a transaction stores a label on,
   on `main` as well, and that is fixed (item 19). What remains:
   `InputReadView.#stands` of `runtime/runner/src/cfc/prepare.ts` compares every
   read record at each ask, 456 ms of 1,135 ms in a profile of the preparation
   of the write of 10,000 documents in
   `dev/experimental/folksonomy-stress-test.tsx`, so the work still grows with
   the written documents times the reads. Removing it needs the transaction to
   say when the metadata of a record was replaced. Today's runtime does not
   prepare that transaction at all, because it holds no label, so the 1,201 ms
   measured for it are a cost of the option. Its 10,007 records are 7 as
   recorded. They take the transaction's join by round l's fallback, because a
   slot of the handler's template is bound to an empty chain, and the evaluator
   of the comparison does not evaluate them (open finding 7).
8. *A handler bound in a row of a `map` over an array that a computation
   returned reads, in its transaction, every stored position the computation
   read* (`Instance.#readComputedSource`; item 15). The work is linear in those
   positions for each event of such a handler, and for an array made from a list
   it grows with the list. It is the price of the fix as built, and no cheaper
   form is designed (open finding 8).
9. *What the three changes of representation leave linear,* for an array of
   references, where the group table applies: a label change at a path below the
   container, and every member of a table that has a position in the changed
   document (`MemberGroups.byDoc`), are marked for regrouping whatever the class
   of the change; the readers of the elements of a `fold`
   (`Instance.#regroupReaders`) do not read the class either;
   `Instance.#coveredMembers` does work in the number of positions an
   evaluation's read went through, which adds a constant factor to an evaluation
   that is linear in the container already; `#forget` walks the cone instances
   of every upstream element, and the enclosing `fold` is regrouped, with a sort
   of the identifiers of the inner groups, on each change of an inner group; and
   the table is formed by one walk of the collection per runtime. The records of
   the elements of a per-element result share their inputs at the cost of one
   ask for a label identifier per position each element's cone instance bound,
   for each record, about 0.07 ms per element at the start of 1,000 elements of
   plain values in place ("The cost that grows with the data" below; open
   finding 9).
10. *Where each member has a label of its own, every figure stays linear in the
    members,* and the record of a whole read is about 10% larger with the table
    of inputs than without: 2,378,558 bytes against 2,170,613 for a `filter`
    over an array of 10,000 references with 10,000 distinct labels. No
    representation removes that label. The diagnostic and the hard limit (Z79)
    and an output stored at a declared ceiling (Z80) are ruled and not built
    (open finding 10).
11. *The preparation time over the corpus is 10,300 ms with the option on,
    against 353 ms with it off,* at load averages between 10.5 and 12. Three
    modules account for 7,917 ms of it:
    `examples/cfc-trusted-component-examples/main.tsx` 3,690 ms in 209
    preparations, `dev/experimental/folksonomy-stress-test.tsx` 2,313 ms in 14,
    and `send-publish-examples.tsx` of the first one's directory 1,914 ms
    in 145. The cost of the two `cfc-trusted-component-examples` modules is not
    attributed; it was 3,073 ms and 1,452 ms at `4363108f0c`, before either
    round. 1,284 bounds are taken, in 82 modules (open finding 11).
12. *The executor's memory on `dev/experimental/folksonomy-stress-test.tsx` was
    not measured again.* A process that held the runs in memory beside the run
    in storage ran out of memory at a heap of 4 GB at the ninth run, and the
    cause was not found. Since then the log of the executor's store is kept only
    where a caller sets one (`Store.log` of `exec/store.ts`), and in this run
    the module is checked on its scenario as given, which holds three runs in
    memory beside the run in storage. Whether the heap still reaches 4 GB in the
    process that failed was not measured (open finding 12).

*Fixed in rounds l and m.* Each of 13 to 16 stored a label without a clause of
what the value was computed from, and each has a test.

13. *An append dropped the label of the members that an earlier write of the
    whole list stored,* over an array of plain values in place. A write of a
    whole list stores the label of its members as one derived `value` entry at
    the list's path. A later transaction that wrote one member, as an append
    does, minted the declared entry of the path again, where the schema of the
    document declares a label at its root, and dropped every derived entry at
    the path with it. In `showcase/card-piles/main.tsx` a card that `shuffle`
    moved from the other pile stored no clause of that pile after the next
    `push`. The entry stays unless the transaction wrote a value at the path or
    a record gives the path a label (`prepareBoundaryCommitSteps` of
    `runtime/runner/src/cfc/prepare.ts`; fixture
    `compare/fixtures/set-then-push.tsx`). With the option off the entry is
    dropped as before.
14. *What a per-element result stores once for every position was cleared by the
    next addition at its end,* over the kept result of another per-element
    construct. After a change of the members of such a result other than an
    addition at its end, the label of the membership is stored as the `*`-child
    entries of the result's path. The next write that added a member at the end
    wrote the result's path, which cleared them as a write that replaces the
    container does, and minted none: in the fixture `key-returns`,
    `labels/1/memo`, of a `map` over a `filter` over plain values in place,
    stored no clause of `words` after a member returned behind one that had
    left. The executor marks the record of an addition at the end of a kept
    collection output (`PlanWrite.membersAppended` of
    `runtime/runner/src/cfc/types.ts`), and the entries stay for it and for a
    record whose label alone is formed again. A member appended after a removal
    now reads what decided the removal. Not covered by a test: the entries kept
    for a record whose label alone is formed again.
15. *Round l's fallback stored a label narrower than what flowed,* where a
    handler bound in a row of a `map` over an array that a computation returned
    (the result of another per-element construct) takes its state from memory
    (item 2). In the fixture `compare/fixtures/computed-row-state.tsx` the
    appended value stored no clause of either input, and
    `apps/topic-workbench/main.tsx` stored `attached` with no clause of
    `sessions` once its commit was no longer refused. The handler's transaction
    now reads every stored position that the computation of the array read:
    those its cone instance bound, those of the outputs it reads by name, and
    those of each element of a collection it passes on
    (`Instance.#readComputedSource` of `exec/executor.ts`). The fixture
    `compare/fixtures/computed-row-cone.tsx` pins that an element computed again
    alone from such a row stores the clauses of what the computation read.
16. *A record given again with no inputs replaced a stored label with the empty
    label.* A record whose label alone is formed again (`PlanWrite.relabel`) and
    that has no inputs took the join of a transaction that evaluates nothing and
    reads nothing. It takes the join together with what the path stores
    (`unbacked` of `plan-labels.ts`). This covers a record given as bound, which
    stored the empty label before round l.
17. *The findings of the check at `482c8ed39d` were artifacts of the check, but
    for one.* Of 10 values in 4 modules on the scenarios as given and 4 in 2
    modules with events sent three times: `apps/contacts/contact-book.tsx` (2)
    and `apps/cozy-poll/main.tsx` (4) store a value made from `Date.now()`,
    which differs between any two runs and so counted as depending on every
    input; `product/primitives/check-list.tsx` (3) and
    `examples/todo-list/todo-list.tsx` (3, at position 0 of `mentionable`)
    started the run with the option on from an argument that the run with the
    option off had appended to; and `showcase/card-piles/main.tsx` (1) is
    item 13. The check is deterministic since ("The check of stored labels
    against the values" below).
18. *No commit is refused with the option on and not off,* where 60 in 25
    modules were at `4363108f0c` and 11 in 4 modules at the end of round l.
    Round l: a record that lacks an input takes the transaction's join and
    counts as a bound, in place of a refusal. Round m: the record of the number
    of members and the record of the membership of an append, where a slot of
    the handler has no position, take the join joined with the positions they
    name (8 commits in 3 modules), and the records of an instance of another
    pattern are left out (3 commits; item 1). The commits go through on join
    bounds, so this count is no evidence of sound labels (item 2).
19. *The general preparation was quadratic in the documents a transaction
    writes, with no option and on `main` as well.* `verifyInputRequirements`
    resolved the envelope of every read again after each target's label write
    (`InputReadView.sourceMetadata`), and `valueWritePathsOf` scanned every
    write attempt for each target. The resolver now lists the documents it
    retired and the view resolves again the reads of those alone, and
    `WrittenValuePaths` indexes the attempts by document. The write of 10,000
    documents of `dev/experimental/folksonomy-stress-test.tsx` prepares in 1,201
    ms where it took 7,043 ms. On today's path, with flow labels persisted and
    no experimental option, a transaction that reads 20,000 documents and writes
    20,000 prepares in 1,659 ms where it took 12,030 ms. The verdicts, the
    stored labels and the digest are those of before. The commit, `17a3f57016`,
    touches `runtime/runner/src/cfc/prepare.ts` and two test files, the
    functions it changes are byte-equal on `main` at `63023da64f`, and it can be
    cherry-picked there (question 347 of the design's plan).

*The rest.*

20. *The three changes of representation are built* (Z75 of the design's plan),
    behind `compiledPatterns`: one table of inputs per transaction, one record
    for the records that differ in a member of one container or in the document,
    and groups of equal labels for a read that covers the members of an array of
    references. At the commit that holds the three, `7e732de8c8`, all 2,153 rows
    of stored labels of the corpus are byte-equal to those of `4363108f0c`. The
    records of the outputs that read the list of
    `dev/experimental/folksonomy-stress-test.tsx` take 16,062 bytes where they
    took 37,735,505, and the write of 10,000 documents 545,044 bytes in 7
    records where it took 19,623,727 in 10,007 ("The cost that grows with the
    data" below).
21. *The records of the elements of a per-element result are one record where
    their inputs hold equal labels:* 3 records in place of 1,002 for a `map`
    over 1,000 plain values in place, and 3 in place of 668 for a `map` over the
    result of a `filter`. The corpus gains little, since its lists hold two or
    three members (same part).
22. *A change of labels says at which paths it is of the path itself alone*
    (`LabelChange.alone` of `exec/executor.ts`), so an addition to an array of
    references no longer asks for the label of every member. The records of
    outputs to give again after a label changed alone are still found by
    position and not by class (open finding 9).
23. *Every run of both rounds is on the source of current `main`:* 287 modules
    attempted, 244 run. Against the run at `482c8ed39d`, 2,108 of 2,154 rows
    have an equal stored label, and 23 rows are new ("The corpus" below).
24. *The label for a write that leaves the value as it was* costs 127 more
    commits with the option on than with it off, 2,911 against 2,784, and 839
    more preparations, since every commit of a compiled pattern is prepared.

The comparison beside today's rows could find none of the unsound labels above,
because it counts a label with fewer clauses as tighter.
**The check of stored labels against the values.** `compare/perturbation.ts`
runs a scenario on the executor in memory, twice as given and once more for each
labeled input with the value of that input alone changed (`perturbedRuns`). A
labeled input is a member of the argument that the scenario writes under a
schema with a clause, or the profile of the seeded home. `soundnessOf` in
`compare/stored-labels.ts` then takes each kept output and each target of a
write edge whose value differs between the run as given and the run with the
input changed, and requires that the confidentiality stored for it with the
option on, read with every link followed, holds the clauses of that input. For a
list that a write record targets it compares each member held in place beside
the list, since a read of one member consumes less than a read of the list. The
check reads no write record, no slot binding and no template. The template
evaluator of the prototype reads the same slot bindings as the runtime, so it
cannot find a binding that leaves a read out; this check can.

*The check is deterministic.* Two things made its findings depend on the run,
and both are removed. Value code that reads `Date.now()`, `new Date()` or
`crypto` held other values in each run, so a value made from the time of day
counted as depending on every labeled input, and 12 modules were left out
because two runs gave different values. The executor takes the globals of the
value code as an option (`globals` of `exec/executor.ts`), and the comparison
gives it a `Date` with one time for the start and one for each event, 2026-01-01
00:00 UTC plus one minute for each event, and a `crypto` that draws from the
seeded `Math.random` (`compare/random.ts`). And `inStorage` of
`compare/integrated.ts` handed the executor the caller's argument, to which a
handler that appends to an input list appended in place, so the run with the
option on started from what the run with the option off had left, with a member
that links to a document its store does not hold. It hands a copy. The clock
document holds one time in every run, in memory and in storage, so a module that
reads the clock is checked. Two corpus runs of one commit differ in nothing the
report prints but the times. Today's runtime is not given the fixed globals: the
comparison of values (`compare/values.ts`) is as it was.

Over the corpus, with each scenario as given, the check covers 241 of the 244
modules that run, in 931 runs in memory that take 18.3 s together. It compares
28,099 pairs of a stored position and a labeled input, 20,039 of them in
`dev/experimental/folksonomy-stress-test.tsx`, and in 1,563 of them the value
depends on the input. None of those stores no clause of the input.
`compare/test/stored-labels.test.ts` runs the check on every fixture scenario
and on the fixture of `wish`.
**The same check with every event sent three times.** A scenario of the corpus
sends each handler few events, so a defect that needs a handler to run again on
what an earlier run stored is not seen. `repeatedEvents` of
`compare/perturbation.ts` gives the events of a scenario three times over: in
the reverse of the order given, then in the order given with each value changed,
then in the reverse order with the value changed again. A module with handlers
whose scenario committed no event in today's run gets one generated event for
each binding, sent three times over; 10 modules of the corpus are checked that
way. `soundnessAfterEachEvent` of `compare/stored-labels.ts` runs the check
after each event, against runs in memory advanced to the same event, so that a
label that the write of a later event would cover is found at the event that
leaves it too narrow. The runs in memory do not compare a run in which an event
found no element with one in which it found one.

*The criterion for an appended member.* By the owner's ruling on an append (Z74
of the design's plan), which member stands at an index after additions alone is
no dependency on the list. `appendedElsewhere` of `compare/perturbation.ts`
therefore does not count a position whose stored label lacks an input's clause
where three things hold: the position is in an array in both runs; the member
there equals the member at another position of the same array in the run with
the input changed; and in both runs the position is at or behind the first
position that the executor's store records for the array as placed by additions
at its end, with no member removed, moved or replaced at or behind it since
(`Store.appended` and `Store.appendedFrom` of `exec/store.ts`). The store
records that from each change as it is made, and not from the values, which a
removal and a missing addition can leave the same. A member that one of the runs
appended after another change of the list is excused as well and flagged
(`afterOtherChange`), because its position then differs for that change too and
not for additions alone. The report counts the excused positions, the flagged
ones apart, and writes them to `soundness-appended.tsv` of the run's tables. The
criterion applies to an array of plain values in place, to an array of
references, and to the kept result of another per-element construct alike, since
it reads positions of stored arrays. It does not follow an appended record into
a document created for it ("To read first", 5).

Over the corpus the check with events sent three times covers 131 modules, in
908 runs in memory that take 177.7 s together, and compares 7,884 pairs, of
which 1,220 have a value that depends on the input. It finds 1 value that stores
no clause of the input, the write of `product/primitives/sortable-table.tsx`
("To read first", 5). It excuses 1 position by the criterion above, a write of
`showcase/card-piles/main.tsx` at position 3 of an array of plain values in
place, flagged as appended after another change of the list; so no excused
position of the corpus is a case of additions alone, and that 1 is not shown to
be sound. The 16 positions of `mentionable` in
`examples/todo-list/todo-list.tsx`, the result of another per-element construct,
that earlier runs excused are not excused and not reported: a member appended
after a removal reads what decided the removal ("To read first", 14). What the
check covers and what it does not:

- 113 of the 244 modules are not checked this way. 107 have no event to send and
  no handler to generate one for. 5 have a commit refused in the run with the
  events sent three times, each for a reason that the run of the scenario as
  given did not have: an unsupported claim `writeAuthorizedBy` in
  `dev/test/cfc-trusted-write/frozen.tsx` and `main.tsx` of the same directory,
  and a writer-fit misfit of confidentiality in
  `examples/profile-group-chat/main.tsx`,
  `examples/profile-roster-live-demo/profile-roster-live-demo.tsx` and
  `apps/redactor/vault.tsx`. What the check finds in such a run is kept apart
  and not counted, 5 values in 2 modules (`soundness-repeated-unstored.tsv` of
  the run's tables). 1 stops because its result exceeds 250,000 characters
  (`dev/experimental/folksonomy-stress-test.tsx`). No run stops at a failed
  write.
- 23 inputs have no run of their own: for 16 an event went to an element that
  the run does not hold, and for 7 no value of the type differs from the one the
  scenario gives.
- It does not reach a branch that one particular value of an input decides. A
  handler that tests `note === "n"` takes that branch only where the scenario
  gives `"n"`, and a changed value does not.
- A scenario whose result exceeds 250,000 characters of text is stopped
  (`REPEATED_RESULT_LIMIT`). Where the checks after every event would compare
  more than 20,000 pairs or read more than 2,000,000 characters of results, the
  check runs after the first event and after the last event of each third of the
  events, and after no other (`STEPPED_PAIRS` and `STEPPED_SIZE`).
- A document that an instance creates is matched between runs by the number the
  executor gives it, the count of documents the instance created before it.
  Where a run with a changed input creates another number of documents, the
  documents compared hold the values of different events ("To read first", 5).
- A channel of the write gate proposal is no finding of this check by the ruling
  Z77, and the check does not tell the two apart: it reports a value that
  depends on an input and stores no clause of it, whatever the cause.
- The limits of the check as given hold here as well: one other value per input,
  confidentiality alone, and the kept outputs and the targets of write edges
  alone.
What the check does not establish:

- It is a lower bound. Each input is changed once, to one other value
  (`perturbed`), so a dependency that this one change does not exercise is not
  seen. A row that passes is not shown to be sound.
- It checks confidentiality, by the clauses of the inputs. It checks no
  integrity.
- It checks the kept outputs and the targets of write edges, and no other stored
  state.
- It compares runs in memory with one run in storage, and the runs in memory
  read no label. A value that reaches a write from the executor's memory flows
  in every run alike, so the check sees its dependency only where a labeled
  input of the scenario is what the value was made from and the scenario's
  change of that input changes the written value. The finding of "To read
  first", 15, was found while the refused commits were examined and is pinned by
  a fixture written for it; the corpus as it ran before had it behind a refused
  commit.
- A scenario is a sequence of events that the corpus or a fixture gives. A
  defect that needs another sequence is not seen by the run of the scenario as
  given: a `push` that lost what an earlier `push` decided needs an addition of
  a labeled value to a list followed by an addition of a value with no label,
  and no scenario has them. The run with every event sent three times, above, is
  made for that.
- 3 of the 244 modules are not checked: `apps/redactor/vault.tsx` and the two
  modules of `dev/test/cfc-trusted-write` have a commit refused with the option
  on, and with it off as well. No commit is refused with the option on alone, so
  no finding is kept apart for a refusal on the scenarios as given.
- 7 inputs have no run of their own, because no value of their type differs from
  the one the scenario gives.
- Where the type of an input declares clauses below its root, any one of them
  satisfies the check, since a declared entry below the root replaces the root's
  for a read there. The check does not test that the clause is that of the part
  read.

**Defects the check found, fixed.** Each stored a label without a clause of what
the value was computed from.

- *A value stored in place under a template of one reference slot.* The template
  of the output is one slot of the class `identity`, which says that the output
  holds a reference, and the executor stored a value in place and no link: what
  a `reduce` computed, over an array of references, over an array of plain
  values in place and over the result of another per-element construct alike,
  and the array that a spread child copies. The write record bound the slot in
  its class, so the runtime took the label of the reference alone.
  `Instance.#storedInPlace` of `exec/executor.ts` binds the slot in the class
  `value` where the position written holds a value that is neither a link nor a
  stream, for the records of outputs and of write edges
  (`plan-and-label-templates.md` §2.5, "A value in place under a template of one
  reference slot").
- *A `reduce` over the result of another per-element construct* stored the
  clause of its initial value and not that of the array. Its slot was bound to
  the positions its own steps read, and an element of the upstream result is at
  no stored position. `Instance.#readsBehind` adds the positions that the memo
  entries the steps used read. A `reduce` over an array of references and one
  over an array of plain values in place were bound to the positions of their
  elements before.
- *A removal through a handle.* `Handle.remove` and `Handle.removeAll` of the
  executor, and `removeByValue`, which calls the second, read the list through
  the handle and wrote back what they kept with `set`, so each kept value was
  stored at another position under a template that holds the handle's slot and
  the removed member in the class `identity` alone. By the owner's ruling of
  2026-11-20 a removal removes in place, and it is built: each run of removed
  positions next to each other is one splice of the stored list
  (`Handle.#removeAt`), the executor writes no member that the list keeps, and a
  kept reference stays the reference it was, to a document the removal does not
  write. What the labels of a removal are is "A change of a list's members
  through a handle" under "What is built".
- *A chain that ends at a position the transaction wrote.* The adapter replaced
  such a binding by the staged position alone and dropped the positions that a
  link stored there led to. A chain binding can be marked `staged`: each of its
  positions that the transaction wrote takes the label staged there, and the
  others the label observed (`SlotBinding.staged` of
  `runtime/runner/src/cfc/types.ts`; `slotLabel` of `instantiatePlanLabels` in
  `plan-labels.ts`).
- *A write that leaves the value as it was stored no label.* In
  `product/primitives/counter.tsx` a handler writes `clamp(value + step, min,
  max)` to `value`. Where the clamped value equals the stored one, the adapter
  gave no write record, and `value` kept the label of the write before, with no
  clause of `min`, at 3 rows. The rule of the owner's ruling of 2026-11-20 is
  built ("A write that leaves the value as it was" under "What is built"), and
  the 3 rows store the clause.
- *Chains and groups of equal labels were compared by the wrong label.* A slot's
  read that reached positions through links reports one chain for each set of
  chains whose positions hold equal labels, and the elements of a `fold` are
  grouped the same way. The identifier compared was that of a read of the value
  at each position. The runtime observes a link that the read crossed as a
  reference, and the label of that observation is not part of the label of a
  read of the value at the link's position: two links written by transactions
  that read different labeled data have one identifier for a read of their
  values. The chain through the second link was then left out, or its element
  put in the group of the first, and the stored label lacked the clause of the
  second link. `TransactionHooks.labelOf` takes the class a position is observed
  in, and for a position that holds a link the executor compares the identifier
  of the slot's class together with that of the reference (`Instance.#labelKey`,
  used by `#distinctByLabel` and `#idOf`). A test of
  `compare/test/runtime-transactions.test.ts` writes two links in two
  transactions that read different labeled sources and finds one identifier for
  their values and two for them as references. No row of the corpus was traced
  to this defect; it was found by reading and pinned by the tests.
- *A change of the members of a list through a handle lost what an earlier
  change decided.* By case:
  - *an array of plain values in place:* `push` after `push`, and `addUnique`,
    `remove`, `removeAll` and `removeByValue` alike, because the list had one
    `value` label, that of its last write;
  - *an array of references:* the number of members, and which reference stands
    at a position. After a `push` that the input decides and one that it does
    not decide, the count was stored under an empty label
    (`compare/fixtures/count-of-records.tsx`). The records that the references
    name were not affected;
  - *a list that `set` replaced, read by a per-element construct:* after
    `set([])` on a list that held members, the result of a `map` over it stored
    no clause of what decided that the list is empty
    (`compare/fixtures/handle-methods.tsx`, an array of plain values in place);
  - *`addUnique` of a member the list holds, and a removal that finds no
    member:* nothing was stored, although that the list stays as it was reveals
    what the comparison read.

  The methods examined are `set`, `update`, `increment`, `push`, `remove`,
  `removeAll`, `removeByValue`, `addUnique` and `send`. `increment`, `update`,
  `key(name).set` on a record and `send` showed no failure in the scenarios
  tried, which does not show that they have none. Tests:
  `compare/test/stored-labels.test.ts` ("after several changes of the members of
  a list of plain values in place", "after the other methods of a handle changed
  a list of plain values in place", "after several pushes onto an array of
  references") and `runtime/runner/test/cfc-plan-labels.test.ts` ("for changes
  of the members of a list in place").
- *A label formed again after a label changed alone cleared the label entries
  below its path, and withdrew the pattern's atom from them.* The runtime stored
  the label of such a record at its path and cleared what was stored below, and
  the path counted as written, so a stamp that the runtime carries lost its
  `TransformedBy` atom. The record is marked as one whose label alone is formed
  again (`PlanWrite.relabel`), the entries below its path stay, and such a path
  is no write (`valueWrittenPrefixes` in `prepareBoundaryCommitSteps` of
  `runtime/runner/src/cfc/prepare.ts`). Tests:
  `runtime/runner/test/cfc-plan-labels.test.ts` ("for a record given again
  because a label changed alone").
- *The schema input of a write below a member of an array.* The adapter recorded
  the schema input of a write at `0/done` below an input's array at that path. A
  schema input is spelled from its path with each segment as a named property,
  and the envelope that the document stores spells an array as an array, so the
  two did not merge and the preparation crashed with "type changed incompatibly"
  in `dev/nested-map-ifelse-test/nested-map-ifelse-test.tsx`. The input is
  recorded at the outermost array on the way, with an index spelled as `items`
  (`RuntimeTransactions.#recordSchema` of `compare/runtime-transactions.ts`). It
  is fixed in the adapter and not in `runtime/runner/src/cell.ts`.

- *A value that the result holds in place took a label narrower than what it
  holds,* in four cases. The rows of a view, which are the result of a `map`
  held in place under a kept output whose template names another output, had one
  record for everything below, with the label of the collection's membership;
  each entry of the construct's elements is recorded at its path below the kept
  output. A kept output that the plan has no template for had no record and took
  the label of the kept output above it; it has a record, and the runtime gives
  it the transaction's join. The value of a cell stored in place as a branch of
  a `select`, as `cell.get() ?? fallback` gives it, kept its slot in the class
  `identity`; it is bound in the class `value`, with a chain for each link the
  value holds (`Instance.#storedInPlace` of `exec/executor.ts`). And an
  evaluation that gives the value an output already holds stored no label,
  though what its inputs hold can be other positions than before; it is reported
  as a write that left the value as it was, and its label alone is formed again
  in the same transaction. Tests: the fixture
  `compare/fixtures/held-in-place.tsx` with
  `compare/test/stored-labels.test.ts`, and
  `runtime/runner/test/cfc-plan-labels.test.ts`.
- *A read of a position that holds no member.* The resolver of an observation's
  label joins, for a content read at a path through such a position, what a read
  of the list's membership consumes: the `enumerate` entry at the list's path
  and the entries above it (`ObservationLabelResolver.#membershipOfAbsent` of
  `runtime/runner/src/cfc/observation-label.ts`). With the option off the
  resolver reads nothing more.
- *An array inside a value that a compiled pattern's write stores whole.* The
  write's label is stored as the `enumerate` entry at the path of each array the
  written value holds, the target of a reference excepted, unless that path
  stores a label of its own in the same commit; an array below a covered path
  takes the label of the nearest path above it that stores a label in the commit
  (`arrayPathsWithin` and `prepareBoundaryCommitSteps` of
  `runtime/runner/src/cfc/prepare.ts`).
- *A write of `undefined` at a position,* which stored no label, and *a member
  change under an envelope:* `key(n).set(value)` behind the last member of a
  list is a write that the plan bounds with an envelope and has no write edge
  for, so the position and the number of members took the join and the list's
  `enumerate` entry stayed as it was. A write that leaves a path holding nothing
  stores its label at the path, and the executor gives the records of the member
  change, with no inputs and marked as bound. The fixture
  `compare/fixtures/member-edges.tsx`, a list of plain values in place, also
  verifies a removal and an addition in one transaction that leaves a member at
  the position another stood at: the stored labels follow the members, and
  nothing had to change.
- *The record of the result of a `flatMap`* binds the source of its membership
  and the element each member came from. Before, a `flatMap` over an array of
  references refused every commit for those two unbound slots. The fixture
  `compare/fixtures/derived-members.tsx` has the results of `map`, `filter` and
  `flatMap` as kept outputs over an array of references, over a list of plain
  values in place and over the result of another per-element construct.
- *A kept result of a per-element construct whose members change otherwise than
  by an addition at its end* took no label for which member stands at each
  position, once the label of a link output was on its `value` entry. The record
  is marked (`PlanWrite.membersChanged` of `runtime/runner/src/cfc/types.ts`),
  and the runtime stores the record's confidentiality, that of the collection's
  membership, as the `*`-child entries of the result in the classes `value`,
  `shape` and `followRef`, in place of the ones the path carried. An addition at
  the end leaves them. This is not ruled (question 328 of the design's plan).
- *A `push` under a condition that a labeled input decides* is confirmed by a
  fixture, `compare/fixtures/push-under-condition.tsx`: both additions of one
  handler, the first under the condition, store the input's clause, because the
  write edge has one template over everything the body reads.

- *An append after a write of the whole list, a per-element result after an
  addition at its end, a handler bound in a row of a computed array, and a
  record given again with no inputs* ("To read first", 13 to 16). Tests: the
  fixtures `compare/fixtures/set-then-push.tsx`,
  `compare/fixtures/computed-row-state.tsx`,
  `compare/fixtures/computed-row-cone.tsx` and
  `compare/fixtures/literal-state.tsx` with
  `compare/test/stored-labels.test.ts`, the fixture `key-returns` in the same
  test file, and `runtime/runner/test/cfc-plan-labels.test.ts`.

The check on each scenario as given found 6 values in 4 modules at its first
corpus run, 3 in 1 module at the sixth, none at the seventh and the eighth, 1 in
1 module at the ninth, 10 in 4 modules at the end of round l, when 49 commits
that had been refused went through, and none at the run of round m. The check
with every event sent three times found 27 in 3 modules at the eighth run, where
it was new, 4 in 2 modules at the ninth and at the end of round l, and 1 in 1
module at the run of round m.
**The cost that grows with the data.**
`dev/experimental/folksonomy-stress-test.tsx` holds a list of 10,000 references,
and with the option on its write records, the work on them, and the executor's
work grew with the list. The design's answer is `plan-and-label-templates.md`
§4.7 ("Collections with many members"), and this part has what is built of it,
what was measured, and what still grows.

*The class.* A plan and its data are in the class where some structure is sized
by the positions that a read or a write covers, and the label needs only the
distinct labels among them. In the module every member of the list has the same
label, and no output observes a difference between two members: each derived
output is the result of a `computed` that reads the whole list, or of a `map`
over such a result, so its label is the join over all members and the
membership. What grows there is the representation and no label.

*A stored label does not change because a collection crossed a size,* by the
owner's ruling of 2026-11-20 (Z78 of the design's plan). A coarser label chosen
by a size is sound as a label and is a channel as a flow: a handler that appends
a member under a secret moves the list over the size, the labels of the other
members rise, and a reader learns the secret from whether a member it could read
is still readable. `plan-and-label-templates.md` §4.7 has the argument. So the
cost is lowered by the representation and by what an author declares, and by
nothing that depends on a size.

*Built: three changes of representation,* by the owner's ruling of 2026-11-20
(Z75; the owner's words: "Yes, build them"), behind `compiledPatterns`. Each
leaves every stored label as it is.

- *(a) One table of inputs per transaction.* A write record holds the index of
  its inputs in the table of inputs of the transaction (`PlanInputsTable` of
  `runtime/runner/src/cfc/plan-inputs.ts`), which the writer records in parts as
  write-policy inputs of the kind `plan-inputs`. A set of inputs names the
  inputs of an output, the inputs of an element group and each slot binding by
  index, so each distinct set of inputs and each distinct slot binding is
  written once. The memo of an output's label in `instantiatePlanLabels` is
  keyed by that index, and no content hash of the inputs is formed. The executor
  forms the inputs of a cone instance once for the records of one change
  (`Instance.#namedInputs` of `exec/executor.ts`). With the option off no
  `plan-inputs` input is read.
- *(b) One record for the records that differ in a member of one container or in
  the document.* Records of a transaction that name one record of the plan and
  one entry of the table of inputs, carry the same marks, and differ in their
  target alone are given to the runtime as one record (`mergedPlanWrites` of
  `runtime/runner/src/cfc/plan-write-targets.ts`). Its target holds `*` at the
  member's position and the record always lists the members, indices next to
  each other as a range, or lists the further documents; a `*` target never
  stands for members that the record does not list. The preparation reads such a
  record as one record for each path it covers (`planWritesPerTarget`) and
  instantiates its template once where the instantiation takes no label that the
  transaction staged; a staged label can differ by the path and is formed for
  each. What is stored is what the records given one by one store, the one `*`
  entry included where every member of an array has one label
  (`collapseEqualElements` of `prepare.ts`). It applies to a whole write over an
  array of references, whose members are documents, and to the elements of a
  per-element result where their inputs are one entry of the table; an array of
  plain values in place written whole is one record already.
- *(c) Groups of equal labels for a read that covers the members of an array of
  references.* The executor keeps, for each such array, each observation class
  and each set of positions read below a member, the group of every member by
  the labels the runtime observes at its positions (the type `MemberGroups` of
  `exec/executor.ts`). The table is formed by one walk, and brought up to date
  for the members that a write of the transaction touched (`Store.onChange`) and
  for those whose labels changed (`watchLabels`). A binding names the positions
  of one member of each group and states the container with its numbers of
  members and of groups (`SlotBinding.members` of
  `runtime/runner/src/cfc/types.ts`), which the runtime does not read to form
  the label. The chain of an `identity` slot whose value holds many links is
  formed from the same table for the class `identity`. A change of a member's
  label that makes or empties a group forms again the label of each output whose
  binding names the container; a member that moves between two groups that both
  stay changes no label and gives no record. The table is kept in memory with
  the collection (Z85). It covers an array of references alone: an array of
  plain values in place is one position, whose entries one read resolves, and
  the result of another per-element construct is bound to the upstream output,
  whose elements a `fold` reports by groups already.

*The stored labels are byte-equal.* At `7e732de8c8`, which holds the three
changes, all 2,153 rows of stored labels of the corpus are byte-equal to those
of `4363108f0c` in the stored label, the label with every link followed and the
label at the position alone, and the refused commits, the commits and the
preparations are the same. Two runs of `4363108f0c` are equal in the same way.
The rows of the later commits differ for the changes of what is stored that "To
read first" lists, and not for the representation.

*Measured: the bytes of the write records,* as the JSON text of the `plan-write`
inputs, and of the `plan-inputs` inputs with them, that the runtime's
transaction is given. Baseline `4363108f0c`, as built `482c8ed39d`:

| Transaction | Baseline | As built |
| --- | ---: | ---: |
| `dev/experimental/folksonomy-stress-test.tsx`, the outputs that read the list, an array of references (19 records) | 37,735,505 B | 16,062 B |
| The same module, a handler's write of 10,000 documents | 19,623,727 B in 10,007 records | 545,044 B in 7 records |
| `apps/person-workbench/main.tsx`, largest transaction (40 records) | 1,249,365 B | 52,173 B |
| `dev/factory-outputs/lot-with-coordinator-demo/main.tsx`, largest transaction | 181,430 B | 23,464 B |
| `dev/experimental/folksonomy-aggregator.tsx`, largest transaction | 14,907 B | 9,801 B |

For the transaction of the outputs that read the list, at `7e732de8c8`: the
executor's time before the transaction 939 ms where it was 6,117 ms, and the
preparation and commit 63 ms where they were 672 ms. Over the corpus at that
commit the bounds taken are 1,055 where they were 1,792, because records that
name one entry of the table share an instantiation, and the preparation time
7,112 ms where it was 7,987 ms; the run with the changes ran beside other work,
so the times are not a measurement of the difference. One changed member of an
array of references among 1,000 gives the runtime the same number of write
records, of the same size but for the digits of the number of members, and asks
for the same number of label identifiers, as among 10
(`compare/test/runtime-transactions.test.ts`).

*The write of 10,000 documents was a refused commit until round l.* Its
transaction was refused at `4363108f0c` and at every earlier measurement, for a
slot bound to an empty chain at the root of each written document, so every
figure measured for it before is of a refused preparation. With round l's
fallback it commits, on the transaction's join ("To read first", 2 and 7).

*Measured: the preparation of a transaction that writes many documents.* Once
that write committed, its preparation took 6.4 s of an 11.3 s run, in two steps
of the general preparation that cost the documents written times the reads and
write attempts ("To read first", 19). After the fix, for the handler
`loadActions` of the module, single runs:

| | Preparation |
| --- | ---: |
| Today's runtime | not prepared: the transaction holds no label |
| The executor in storage, option off | not prepared |
| Option on, before the fix | 7,043 ms |
| Option on, after the fix | 1,201 ms |

On today's path, with no experimental option and flow labels persisted, a
prepared transaction that reads `R` unlabeled documents and one labeled one and
writes `N` documents under a schema, `N` = `R`:

| `N` | Before | After |
| ---: | ---: | ---: |
| 1,000 | 81 ms | 67 ms |
| 2,000 | 158 ms | 93 ms |
| 5,000 | 595 ms | 240 ms |
| 10,000 | 2,239 ms | 585 ms |
| 20,000 | 12,030 ms | 1,659 ms |

After the fix the time per document still rises, from 0.047 ms at 2,000 to 0.083
ms at 20,000: `InputReadView.#stands` compares every read record at each ask
("To read first", 7).

*Measured: the records of the elements of a per-element result.* The executor
names, for the entry of an element's output, the identifiers of the labels at
the positions its cone instance bound (`Instance.#shareKey`, as the groups of a
`fold` are formed, provisional decision P31 of the design's plan), and gives
every record with one name the inputs of the first; (b) then makes them one
record. A record that names another element's inputs keeps its own element's
positions as what it read, so a change of a label at one of them gives that
record again, with inputs of its own, and no other. `compare/fixtures/lists.tsx`
in storage with the option on, the commit of the start, before (`68fff9e26c`)
and after (`dbcce35f91`), single runs at a load of about 12:

| Elements | Records given | Recorded, before | Recorded, after | Bytes, before | Bytes, after | Templates instantiated, before | After | Start, before | After |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A `map` over 10 plain values in place | 21 | 12 | 3 | 10,580 | 2,332 | 12 | 3 | | |
| The same over 1,000 | 2,001 | 1,002 | 3 | 930,858 | 2,336 | 1,002 | 3 | 315 ms | 377 ms |
| A `map` over the result of a `filter`, 10 elements | 13 | 8 | 3 | 7,339 | 2,768 | 11 | 6 | | |
| The same over 1,000 | 1,333 | 668 | 3 | 620,421 | 2,772 | 671 | 6 | 293 ms | 375 ms |

No bound is taken in any row. The start as a whole is slower after, by about
0.07 ms for each element at 1,000: the executor asks for the label identifier of
each position of each element's record (`Instance.#labelsOf`) and does not keep
the identifiers, because nothing invalidates a kept identifier of an element
that no `fold` names when a label changes. An array of references is not in the
table, since a labeled input of the comparison holds its records in place; a
test of `exec/test/transaction-hooks.test.ts` covers it, with one set of inputs
among 10 elements and among 1,000 where the labels are equal, three sets where
the elements hold three labels, and one record given again for a change of the
label of what one element read. The inputs are not shared where the template has
a `fold` or a `dynamic` node, reaches a slot that no evaluation bound, is bound
again by the target (`Instance.#storedInPlace`) or covers the members of a
container, nor where the store names no label identifier for a position, which
includes every position that the transaction in progress wrote. The last is why
the corpus gains little: its lists hold two or three members, and the first
transaction of a scenario writes the documents that its rows read. Over the
corpus the records recorded are 8,766 for 20,572 given, where they were 9,122
for 20,595 before the change.

*Where the members have labels of their own,* the label of anything computed
from the whole collection has as many clauses as the collection has members, and
today's runtime stores the same label. Measured on a constructed case, a
`filter` over an array of references with one member changed, single runs, at
`4363108f0c` and at `482c8ed39d`:

| Members | Distinct labels | Option | Preparation, baseline | As built | Record, baseline | As built | Stored entries of the list |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 1 | on | 7 ms | 6 ms | 834 B | 1,006 B | 2,484 B |
| 10,000 | 10 | on | 9 ms | 6 ms | 2,813 B | 3,122 B | 10,158 B |
| 1,000 | 1,000 | on | 61 ms | 56 ms | 217,613 B | 236,556 B | 864,978 B |
| 10,000 | 10,000 | on | 969 ms | 792 ms | 2,170,613 B | 2,378,558 B | 8,694,978 B |
| 10,000 | 10,000 | off | 286 ms | not run | (not used) | (not used) | 1,449,913 B |

With few distinct labels the preparation is flat. With one label per member
every figure is linear in the members with the option on and off, the record is
about 10% larger as built, and the option stores six times the bytes of entries
that today's runtime stores. No representation removes that label. By rulings of
2026-11-20 the runtime reports a diagnostic for a label of very many clauses and
refuses the commit above a hard limit (Z79), and a body with a declared maximum
confidentiality stores an output at the ceiling where the author marks it (Z80).
Neither is built; the unit and the numbers of the limit and the syntax of the
mark are not decided (questions 339 and 340 of the design's plan).

*What (c) leaves linear,* for an array of references. Read from the code and not
measured as time:

- *A label change below the container, or in a document that a member has a
  position in.* A change of labels says at which paths only entries changed that
  label a read of the path itself (`LabelChange.alone`: `enumerate` entries and
  concrete `structure` entries), and a table of member groups skips those at its
  container's path or above it. Before, every addition to the list asked for the
  label of every member, 30 asks for 10 members in a test of
  `exec/test/transaction-hooks.test.ts`. A change at a path below the container,
  and the members of a table that have a position in the changed document
  (`MemberGroups.byDoc`), are still marked whatever the class, and the readers
  of the elements of a `fold` (`Instance.#regroupReaders`) do not read the
  class.
- *The cover of an evaluation's read.* `Instance.#coveredMembers` is called with
  the positions one evaluation's read went through, and its work is the number
  of those positions. The evaluation went through the same positions, so the
  cover adds a constant factor to an evaluation that is linear in the container
  and nothing to one that read one member. The plan, if the factor matters: keep
  with each kept cover the position texts it was formed from and the clock, and
  return it where the store's log shows that the read went through the same
  positions.
- *The `fold` path.* `Instance.#forget` walks the cone instances of every
  upstream element, which is bounded by the depth of the per-element constructs
  and not by a collection's size. The enclosing `fold` is regrouped on each
  change of an inner group (`#regroupEnclosing`), which sorts the identifiers of
  the inner groups; the plan is to keep them sorted with the assembly. The
  suspected defect of `Instance.#idOf` is "To read first", 3.
- *The first walk.* The table of a collection is formed by one walk of its
  members, once per collection and runtime.

*Fixed earlier: the executor's time for an event.* `Store.changedSince` of
`exec/store.ts` walked the log of changes back to the time given for each
position asked about. The store keeps, per path of each document, the time of
the last change at the path and at or below it, and the answer for a position
visits the nodes along its path (`exec/test/store-changes.test.ts`). The events
14 to 16 of the module run in memory with generated events take 414, 3 and 53 ms
where they took 4,119, 3,720 and 14,945 ms.

*Open: the executor's memory* ("To read first", 12). The log of changes of the
executor's store is kept only where a caller sets one (`Store.log`). Whether the
process that ran out of memory at a heap of 4 GB still does was not measured.

*Open: the preparations of the module* take 2,313 ms for 14 of them at this run,
22% of the preparation time of the whole corpus with the option on. They took
1,389 ms at `4363108f0c`, where the write of 10,000 documents was refused, and
5,801 ms at the end of round l, where it committed and the preparation was
quadratic.
**What is built.** On the integration branch, behind the
experimental option `compiledPatterns`, off by default. The runtime side,
under `runtime/runner/src/cfc/`: a resolver of the label one observation
consumes, factored out of the join (`observation-label.ts`); a pure
`instantiateTemplate` with the runtime's label operations
(`plan-template.ts`); a registry of compiled plans and an authorized
`plan-write` input of the transaction (`compiled-plans.ts`); and the pass
that binds each covered path's slots and instantiates its template at
commit (`plan-labels.ts`), whose labels replace the join at every covered
path in the persist step of `prepare.ts`. Only a serving runtime turns
plan labels on for its transactions, by the owner's ruling that a
client's speculative run is never the stored result. The prototype side:
the executor reports for each write its plan record and the slots its
template is bound to, the selections and chosen children, and the reads
attributed to `dynamic` nodes; the adapter records them as `plan-write`
inputs and registers the compiled pattern. Labels are handled by
identifier and a `fold` is instantiated once per group of element inputs
(provisional decision P31 of the design's plan). The deciding sites carry
the `SPEC-PENDING` marker for specs pull request 91.

Two rules of the design's rulings are built as well. Code of a pattern B
compiled into a pattern A mints B's atom: `mint` in
`runtime/runner/src/cfc/plan-labels.ts` names entry `pattern` of
`Plan.patterns` for a derivation whose `pattern` is not 0, and refuses the
label where the plan does not list that entry. A slot bound to an address
the transaction did not read takes the label stored there, observed in the
committing transaction: `observeLabel` of `PlanLabelEnvironment` in
`runtime/runner/src/cfc/prepare.ts` reads the document's label metadata,
journaled so that the commit validates the version it used, and reads no
value, so the transaction's value read set and its join do not change. The
groups of a `fold` are bound this way, in both forms of P31: the `uniform`
form, for an array of plain values in place, and the `groups` form, for an
array of references and for the result of another per-element construct.
The template label is asserted to be within the transaction's flow join
together with the stored labels resolved from those observations.

By the owner's ruling on question 303 of the design's plan, every commit
of a compiled pattern is prepared when the option is on, so every kept
output carries the pattern's atom; the owner's reason is that soon all
data carries a label, at least a `User` or `Space` atom. It is built:
`recordCfcWritePolicyInput` marks a transaction as relevant to CFC where
it records an authorized `plan-write` input and stores labels from
templates, so a commit that read no labeled data is prepared. A document
that a `plan-write` covers enters the persist step whatever the
transaction's join is.

Built with it:

- **The atom of a kept output that holds a link is on the content.** By the
  owner's ruling of 2026-11-20 (Z81 of the design's plan) the pattern's atom of
  a kept output that passes a value on by reference is joined onto the content,
  with no scope, so a read through the link takes it. A covered path at which
  the transaction wrote a link stores its label as an entry of the class `value`
  at that path, with a `shape` entry, in the document that holds the link,
  whether that document is written whole or the path alone
  (`prepareBoundaryCommitSteps` of `runtime/runner/src/cfc/prepare.ts`;
  `plan-and-label-templates.md` §3.2, "Where the atom of a kept output is
  stored"). The envelope of the document that the link names is not written.
  Where the links of an array's elements have equal labels, one entry at the
  array's `*` path is stored and an element whose label equals it stores none.
  The loop of `prepareBoundaryCommitSteps` that stored such a label on the
  link's `followRef` entry no longer receives a path. Before the ruling the atom
  was on a `value` entry where the document was written whole and on the
  `followRef` entry where the path was written alone; a first attempt to put it
  on the link's entry in both cases was taken back, because a `value` read at
  the link's path then resolved to the join of the written path above it.
- **One atom per pattern.** Each entry of `Plan.patterns` is the hash of
  the record `{ module, binding }`, with `module` the content hash of the
  module the `pattern(...)` call is written in, formed from its path, its
  text and the identities of the modules it imports (`module_identity` and
  `pattern_identity` of `base/pattern-compiler/src/plan.rs`;
  `plan-and-label-templates.md` §1.5). A pattern registered alone and the
  same pattern compiled into another mint one atom. The hash is SHA-256
  over the JSON text and is not the string that the runtime's
  `computeModuleHashes` forms.
- **The observation of a label is a dependency of the commit.** Where a
  slot is bound to an address the transaction did not read, the runtime
  observes the stored label with `labelBasisRead`
  (`runtime/runner/src/storage/reactivity-log.ts`): a read that adds no
  flow label, schedules nothing, and stays among the reads of the commit,
  so the store validates the version the label was taken from. A label
  that another session changed after the preparation fails that
  validation, and a document that the replica never loaded is not taken
  as a document with no label.
- **A refusal is known before the next transaction.** The adapter runs
  the preparation before the commit (`Runtime.prepareTxForCommit`), and
  after a refusal it writes each document of the refused transaction whole
  at its next change. A refusal that the store makes after the
  preparation is known only when the commit settles.
- **The outcome of a `wish` has a write record.** A write record can name an
  operation (`PlanWrite.record` of `runtime/runner/src/cfc/types.ts`), and
  `wishOutcomeLabel` in `plan-labels.ts` gives the outcome the label of
  `plan-and-label-templates.md` §3.19: the instantiated `Operation.input` joined
  with the label of what the resolution read, with no integrity.
  `Instance.#resolveWish` writes the outcome under that record, with the
  positions that the answer of the resolution reports as read. A slot of a
  `wish` that reads the mark of a failure, which the state document does not
  hold, is bound to the outcome.
- **A staged address takes the label of the nearest covering write.** A slot
  bound to an address the transaction wrote takes the label of the nearest path
  at or above the address that a write of the transaction covers, and the
  transaction's join only where none does (`stagedLabel` in `plan-labels.ts`). A
  covering write whose own label is being instantiated is passed over, and a
  position that the write being instantiated covers is read as it is stored.
- **The index of an element is bound.** A slot of root `index` reads no stored
  position. It is bound, in the class `enumeration`, to the stored array its
  collection is over, through each `map` between them
  (`Instance.#indexBinding`). Where a `filter` or a `flatMap` is on the way, the
  index depends on what that construct keeps: the slot stays unbound and the
  commit is refused. This is narrower than `plan-and-label-templates.md` §2.2
  ("The label of a slot of root `index`"), which also joins the root of every
  position.
- **A member of a handler binding's state at no stored position** is bound to
  what the slot it is taken from reads (`Instance.#placeBinding`): the index as
  above; an element of an array of references or of an array of plain values in
  place at its position; and an element of the result of another per-element
  construct to the upstream output that holds it.
- **A collection over the array an output computes** has the label of that
  output as its membership (`CompiledPlan.collections` of `compiled-plans.ts`
  reads `source.output`), with the output's inputs reported by the record.
- **A state cell whose schema declares a label has a document from the start,**
  by the owner's ruling of 2026-11-20. `Instance.stateCell` writes the constant
  first value under the cell's schema where the schema declares a label
  (`declaresLabel` of `exec/executor.ts`), because a label is stored with a
  document and the declared clause was stored nowhere otherwise
  (`plan-and-label-templates.md` §1.3).

- **A write that leaves the value as it was stores the label of the write,** by
  the owner's ruling of 2026-11-20. The executor's store calls
  `Store.onUnchanged` for a write of a body that leaves the value at its path as
  it was, and the executor gives the transaction hooks the records of the write
  being made (`TransactionHooks.unchanged`). The adapter records each as a
  `plan-write` input marked `unchanged` (`PlanWrite.unchanged` of
  `runtime/runner/src/cfc/types.ts`), and does the same for every change that
  the storage finds unchanged, where it gave no record before
  (`RuntimeTransactions.change` and `RuntimeTransactions.unchanged`). So the
  rule is applied to every write of a compiled pattern, a derived write
  included, and not to a handler's own writes alone. The preparation takes the
  target of such an input as a path the transaction wrote, holding the value it
  held (`valueWriteTargets` of `runtime/runner/src/cfc/prepare.ts`): the label
  instantiated from the record's template replaces the label stored there, and
  the transaction writes the stored labels of the document and no value. The
  specification counts a write that leaves the value unchanged among the
  attempted writes (section 8.10.1, `08-10-validation-at-boundaries.md`) and has
  the committing attempt's derivation replace the derived label (section 8.12.8,
  `08-12-store-label-monotonicity.md`).
- **What a commit that stores a label alone does to readers.** The labels of a
  document are stored in the document, and a read of a labeled value consumes
  them. Measured with the option off and with it on, with the same result
  (`runtime/runner/test/cfc-plan-labels.test.ts`, "a commit that changes a
  declared label and no value"): a commit that changes a declared label entry
  and writes no value runs a sink that read the value again, and a transaction
  that read the value before it fails with `StorageTransactionInconsistent`.
  Both also hold where the changed label is that of another value of the same
  document. So today's runtime wakes a reader and refuses an earlier reader for
  a label-only commit, and for more readers than the changed label concerns.
  What today's runtime does not do is store a label when a write leaves the
  value as it was; that is the rule above, for compiled patterns alone. For
  soundness: a transaction that read the value under the earlier label cannot
  commit on it, since a label read remains a dependency of the commit (section
  8.10.1, `08-10-validation-at-boundaries.md`); and a label that a computation
  derived earlier and that does not run again keeps what it had, which the
  specification permits (section 8.9.4, `08-09-runtime-label-propagation.md`). A
  commit that would store the label the path holds already writes nothing, runs
  no reader and conflicts with nothing ("for a write that left the value as it
  was" in the same file).
- **The labels of the outputs that read a label are formed again after it
  changed alone.** An output computed from a value whose label changed without
  its value is not evaluated again, so its stored label would lack the new
  clause. The executor keeps, for each record of an output it gave, the
  positions that the inputs of the record read and the collections that its
  template folds over (`Instance.#noteRecord`). After a commit changed labels
  and no value, the adapter tells the executor (`watchLabels`, with `alone`),
  and the executor gives again the records whose inputs read a position at,
  above or below a changed entry and those that fold over a collection with an
  element whose group changed (`Instance.#recordsReading`), in a derivation
  transaction of its own (`Instance.#relabel`). Each is marked
  `PlanWrite.relabel`: the runtime stores the label at the record's path and
  leaves the entries below it (`PlanLabels.labelOnly` of
  `runtime/runner/src/cfc/plan-labels.ts`). A record given in the transaction
  that stored the label is not given again. One changed label among 10 elements
  and among 1,000 gives the same records again, over an array of references (a
  test of `exec/test/transaction-hooks.test.ts`); an array of plain values in
  place and the result of another per-element construct were not measured. The
  records are found by position and not by class, so an output that holds a link
  is given again when any label of the document the link names changes (open
  finding 9). The adapter reports the label entries a commit changed for every
  document the transaction wrote, and says at which paths every changed entry
  labels a read of the path itself alone (`LabelChange.alone` of
  `exec/executor.ts`); the group table of an array of references skips those at
  its container's path or above it. The adapter keeps the entries of every
  document it read the labels of, and reads them again before a transaction
  only where a commit changed the document since.
- **A change of a list's members through a handle,** by the owner's rulings of
  2026-11-20 for a removal (Z71, Z72 and Z73 of the design's plan) and by the
  provisional decision P39 of that plan, which is the coordinator's, for an
  addition. It holds for an array of plain values in place and for an array of
  references; the result of another per-element construct has no handle to
  change it through.
  - *The storage write.* The adapter writes a splice of a stored array as the
    number of members and the positions the splice changed, and no position
    before it (`RuntimeTransactions.change`). The labels stored for the
    positions before the splice stay with them.
  - *The records.* `Instance.#memberWrites` of `exec/executor.ts` gives one
    record for each member added, at its own position; one for the number of
    members where it changes; and one for the membership of the list, marked
    `PlanWrite.enumeration`, which labels no member. Every record holds what the
    method compared to find the members (`PlanWrite.decided`) and what the list
    stored of its membership, the label of its number of members and of its
    enumeration (`PlanWrite.observed`). `Handle.#positionsOf` reports what the
    comparison read: which positions the list has; at a position that holds a
    link, the reference and nothing of the document it names; at a position that
    holds a plain value, the value. A write through `key(n).set` at the position
    behind the last member is recorded as an addition (`Instance.#changed`). By
    the owner's ruling on an append (Z74) the record of an added member holds
    the label of the write and of what the method compared, and nothing of what
    the list stored of its membership; the records of the number of members and
    of the membership hold that.
  - *The membership.* The runtime stores the label of the membership record as
    the `enumerate` entry at the list's path, in place of the one it carried:
    what the list stored of its membership joined with what decided the change
    (`prepareBoundaryCommitSteps`, the loop over `memberChanges`). The entries
    of the positions at or beyond the number of members the list has after the
    change are dropped, a `shape` entry among them, so a position created again
    mints its existence entry again. A write that replaces an array stores its
    label as the `enumerate` entry of the array as well.
  - *What decided a removal is stored once for the list* (Z71). Where the change
    removed members (`PlanWrite.removes`), the label of what decided it, the
    record's template joined with what the comparison read, is joined into the
    list's `*`-child entries of origin `structure` in the classes `shape`,
    `value` and `followRef`, confidentiality alone. A member's own entries are
    of origin `derived`. The resolution resolves each origin on its own and
    joins the results (`resolvedEntryGroups` of
    `runtime/runner/src/cfc/consumed-label.ts`), so a read of a position joins
    the `*` entry with the position's own entry and the resolver is unchanged.
    Successive removals join into the entries. A write that replaces the list
    clears them. They are kept for a list that a removal leaves empty. A read of
    a member that stands before the first removed position consumes them too,
    although the removal did not change what that position holds; that is the
    cost of one entry in place of one per moved member. The specification states
    such a wildcard entry for `shape` and for slots that hold references, and
    not for the `value` class of a plain value in place, so this needs the
    sentence of "The label rule of a removal" below.
  - *A kept member that moves keeps its entries* (Z72). The membership record
    names the runs of members that the change kept at another position
    (`PlanWrite.moves`, `PlanWrite.start`). The preparation carries the stored
    entries of origin `derived` and `structure` at or below a moved member under
    the member's new path, integrity included, and drops those of a removed
    member (`memberEntryPlacement`). The existence entries, of the class
    `shape`, stay at their positions. No template is instantiated for a kept
    member, and the storage write that puts a moved member at its position
    stamps nothing (`isMovedMemberWrite`).
  - *A change that finds nothing to do is a label write of the membership*
    (Z73). A removal that finds no member, and `addUnique` of a member the list
    holds, give the records of the number of members and of the membership as
    those of writes that left the value as it was (`Handle.#kept`,
    `Instance.membersKept`), so both take what the comparison read.

  The `enumerate` entry and the `*` entries are not measured by writer-fit.
- **A record with no inputs is given as bound, and a record that lacks an input
  takes the same label.** A kept output that the plan has no template for, a
  write that the plan has an envelope and no write edge for, and an element
  entry with a slot that the executor has no stored position for have a record
  marked `PlanWrite.bound`. The runtime gives the target the transaction's join,
  as a written path with no record has it, and not the label of a covered path
  above it (`instantiatePlanLabels` of `runtime/runner/src/cfc/plan-labels.ts`).
  A record whose template reaches a slot with no binding or bound to no
  position, a collection with no elements reported, or a choice that was not
  reported and chooses from no collection takes the join as well, in place of a
  refusal of the commit, and counts as a bound (`unbacked`; provisional decision
  P42 of the design's plan). That holds for the record of the number of members
  and for the record of the membership of a member change too, joined with the
  positions they name. A record whose label alone is formed again and that has
  no inputs takes the join together with what the path stores. The join holds
  what the transaction read through the storage and no more, so it is a bound of
  the label only where everything that flowed into the value was read in the
  transaction ("To read first", 2).
- **A handler's transaction reads what a computed row was made from.** A handler
  bound in a row of a `map` over an array that a computation returned takes its
  state from the row, which is at no stored position. Before the records of its
  writes are given, the executor has the transaction read every stored position
  that the computation of the array read: those its cone instance bound, those
  of the outputs it reads by name, and those of each element of a collection it
  passes on (`Instance.#readComputedSource` of `exec/executor.ts`). The join
  then holds the clauses of what the row was made from. The work is the number
  of those positions for each event.
- **The records of an instance of another pattern are left out,** as a stub
  (`TransactionHooks.instantiated` of `exec/executor.ts`;
  `RuntimeTransactions.instantiated` of `compare/runtime-transactions.ts`;
  provisional decision P43 of the design's plan). Their paths take the
  transaction's join ("To read first", 1).
- **The write records of a transaction name their inputs in one table, equal
  records are one record, and a read that covers the members of an array of
  references is bound by groups** ("The cost that grows with the data" above).
  The adapter keeps the records of a transaction and records them when the
  transaction ends. A record that a later record of the same path replaces stays
  as it is, before the merged ones, so the last record of a path is the same.
- **What a transaction stores once stays where a later transaction does not
  replace it** (provisional decision P44 of the design's plan). A derived
  `value` entry at a path stays where a transaction mints the declared entry of
  the path again, writes no value at the path and gives the path no record, over
  an array of plain values in place that an earlier write stored whole. The
  `*`-child entries that hold the label of the membership of a kept per-element
  result stay for a record marked `PlanWrite.membersAppended`, an addition at
  the end of the result, and for a record whose label alone is formed again
  (`prepareBoundaryCommitSteps` of `runtime/runner/src/cfc/prepare.ts`). The
  first members of the result of a `flatMap` are reported as a change other than
  an addition, so its positions keep the label of the membership across later
  additions.
- **The budget of pending-specification markers is 80,** by the owner's ruling
  of 2026-11-20 (`SPEC_PENDING_BUDGET` of `tasks/check-cfc-correspondence.ts`).
  `deno task check-cfc-correspondence` passes at `dbcce35f91`; the count of
  markers at that commit was not taken for this document.
**The acceptance result.** On `examples/cfc-input-cell-demo/briefing.tsx`,
with the option on, `climate`, which reads `city` alone, stores only the
clause of `city`; with the option off it stores "demo-secret", the join
over the whole settle (see "Labels too wide" under milestone 1).

**The label rule of a removal.** By the owner's ruling of 2026-11-20 the label
rule of `remove`, `removeAll` and `removeByValue` is derived from the CFC
specification and not from today's implementation. `plan-and-label-templates.md`
§2.5 ("The label rule of a removal through a handle") has the derivation with
its citations. Its result, by case:

- *What the decision reads.* All three operations take a member. The decision D
  of a removal is the join of the reference to the list, the member, what the
  body read to decide that the removal runs, and what the comparison read: over
  an array of references the identity of the reference at each compared position
  and no target; over an array of plain values in place the value of each
  compared position, since a copy is compared by value.
- *The enumeration of the list, in every case:* the stored enumeration joined
  with D. It is a join and no replacement, because which members remain is a
  function of which members there were. An addition has the same rule.
- *An array of references.* A kept element is a target document that the removal
  neither writes nor observes, and its label does not change. Each reference
  keeps its own restrictions, which move with it. Which reference stands at a
  position, for every position from the first removed one on, is a selection of
  this transaction with the label D, which one entry at the list's `*` path can
  hold. This agrees with the ruling as worded.
- *An array of plain values in place.* A kept element before the first removed
  position is not written. A kept element from the first removed position on
  stands at another position. A static read of a position consumes nothing of
  the list's enumeration, so D has to be consumed at the position: after
  `words.removeByValue(secret)` over `["a", "b"]`, a read of `words[0]` gives
  `"a"` or `"b"` by whether `secret` equals `"a"`. Read by its letter the
  specification puts D on the `value` entry of every such position, one entry
  written per kept element.
- *The result of another per-element construct* (`map`, `filter`, `flatMap`) has
  no handle a body can remove through. A removal from its source is one of the
  two cases above, and the derived collection follows from its membership
  template: the elements that remain keep their keys, their state and their
  labels, and none is evaluated again for the removal. By the owner's ruling on
  an append, an addition to the source puts nothing of the source's membership
  on a position of the derived collection. What a position carries of a removal
  from the source is not ruled. As built, where the members of a kept result
  change otherwise than by an addition at its end, the label of the
  collection's membership is stored once for its positions, at the result's
  `*` path (`PlanWrite.membersChanged`).

The derivation left three questions, and the owner's rulings of 2026-11-20
settle them (Z71, Z72 and Z73 of the design's plan; the owner's words for the
three: "go with 3, move the entries, and yes"):

- *What decided a removal is stored once for the list,* over an array of plain
  values in place: one `*` entry in the `value` class, which a read of a
  position joins with the position's own entry. It replaces the first
  alternative, an entry written per moved element, in the provisional decision
  P39.
- *A kept element that moves keeps its integrity:* the runtime moves the stored
  label entries with the members of an array it splices, and no template is
  instantiated for the kept element.
- *A removal that finds nothing is a label write of the enumeration,* as a write
  that leaves a value as it was stores its label.

All three are built ("A change of a list's members through a handle" under "What
is built").

**The specification sentence that the first ruling needs,** as proposed, pending
the specification pull request. It is for section 4.6.3 of the label
representation chapter (`04-label-representation.md`), in the paragraph
"Wildcard per-class entries (conforming template representation)", after the
sentence that lists what the per-class twins cover:

> The same holds where a writer changes the membership of a container of values
> stored in place by removing members: the runtime MAY store the join of what
> decided the removal once, as per-class twins at the container's wildcard child
> path, in place of rewriting the `value` entry of every member the removal
> moved. A wildcard twin minted this way is *additive* in the `value` class as
> well: the effective `value` label of a child is the join of the twin and the
> child's own most specific `value` entry, and a more specific concrete entry
> does not replace the twin. Successive membership decisions join into the twin;
> it is cleared only by a write that replaces the container, whose own
> derivation then labels every member.

The paragraph as it stands states the twins for a container whose slots hold
references, and states the join of a wildcard entry with a concrete entry for
the frozen `shape` entry alone ("Frozen existence joins with membership
templates", the one stated exception to the rule that a more specific entry
replaces). For the `value` class a member's own entry would replace the twin,
and a read of the member would not consume what decided which member stands at
the position. The sentence adds a second exception. The deciding sites carry the
`SPEC-PENDING` marker for specs pull request 91.

**The cost of a removal at position k of a list of n members,** as built, read
from the code and not measured as time:

- *The executor.* The comparison reads the positions 0 to k for `remove`, which
  stops at the first match, and all n positions for `removeAll` and
  `removeByValue`. Over an array of references it compares the references and
  reads no document they name. Each run of removed positions next to each other
  is one splice, so a `removeAll` of r runs makes r splices. It gives two
  records whatever n is: the number of members, and the membership, which names
  the runs of moved members.
- *The pre-pass.* One template instantiation, since the records of one change
  share their bindings (`sameTemplateInputs` of `plan-labels.ts`). The positions
  that the comparison read are resolved once, k + 2 or n + 1 label lookups.
- *The preparation.* The stored entries of the n - k - 1 moved members are
  carried under another path, one path rewritten per entry that a member has,
  and a member with no entry of its own costs nothing. No label is computed for
  them. The entries written are the `value` and `shape` entries of the number of
  members where they change, the `enumerate` entry of the list, and three `*`
  entries.
- *The storage write.* The adapter writes n - k - 1 positions and the number of
  members. That is the cost of shifting an array stored in one document, and no
  cost of the labels.

With an entry written per moved element, the first alternative, the same removal
wrote n - k - 1 `value` entries, each with a label of its own to intern.

**The catch-up merge with `main`.** The integration branch holds current `main`,
pull request commonfabric/labs#10080 included, which moves stored label entries
with the elements of an array for today's runtime, with no option
(`elementEntryPlacements` of `runtime/runner/src/cfc/prepare.ts`,
`keptElementIndices` of `runtime/runner/src/storage/array-edit-script.ts`). That
change and milestone 4 placed carried entries at the same point of the same loop
of `prepareBoundaryCommitSteps`. What the merge did there, and in three other
places:

- *The record wins for an array that has one,* by the owner's ruling of
  2026-11-20 (Z76 of the design's plan; the owner's words: "(a) (and this is
  clearly more sound. if it's equal complexity and obviously more sound, just
  decide)"). `main` infers the alignment of old and new positions from the
  values the transaction wrote, and milestone 4 takes it from the executor's
  record of the splice (`PlanWrite.moves`, `PlanWrite.start`), which is exact
  where two members are equal. There is one type and one block that applies a
  placement, and `elementEntryPlacement` picks the source for each stored entry:
  an entry beneath an array that a membership record names is placed by the
  record alone (`memberEntryPlacement`), whatever the values at the array's
  positions are, and every other entry by the alignment.
  `elementEntryPlacements` is given the recorded arrays and aligns none of them.
  It also aligns no array beneath a recorded one, whose member the record may
  have moved, and no array above one, beneath whose indices the writes are those
  of the recorded change. With `compiledPatterns` off no array has a record and
  the alignment places every entry, as on `main`. A test of
  `runtime/runner/test/cfc-plan-labels.test.ts` has a list of two equal members
  whose first a record removes: the entries of the second move to the first
  position, where an alignment by value keeps the first and drops them.
  On that branch, `docs/specs/cfc-conformance-statement.md` §8 says which
  source places the entries with the option on.
- *Not covered by a test:* a transaction that changes the members of an array
  above a recorded one and has no record of that change. By the rule as built
  the entries beneath the outer array's elements then stay at their indices.
- *The commit dependency on a label that a stored label rests on.* `main` moved
  `SpaceReplica.#commitReadActivities` to `commitReadActivities()` of
  `runtime/runner/src/storage/commit-read-activities.ts`. The exception that
  milestone 4 made there moves with it: a verifier read of the CFC envelope that
  a stored label rests on (`isLabelBasisRead`) stays a dependency of the commit.
  On `main` the same function also tells the transaction's patch encoder which
  reads pin an array before it sends a change of that array as splices. How the
  label dependency acts on that encoder is not tested.
- *The splice test.*
  `runtime/runner/test/cfc-array-splice-element-labels.test.ts` is `main`'s
  file; it tests the carry that the ignored test of milestone 4 showed missing.
- *The crate's catalog.* `removed-form:pattern-tool-interim` is an entry of the
  catalog, implemented in part (`base/pattern-compiler/src/tool_rewrite.rs`).
  `removed-form:schema-argument`, which `language-subset.md` §4.4.3 lists, has
  the status "not implemented": a schema passed to a form of the API that takes
  one is accepted without a report (`base/pattern-compiler/src/catalog.rs`).

*The corpus of current `main`.* 287 modules are attempted, 16 more than before
the merge, and 244 run. 8 of the 16 run: two modules of `apps/food-recipe`,
`apps/redactor/vault.tsx`, and five of `showcase/inductor/lofi`. Two modules
that ran no longer run, `dev/loom-chat-room-fixture/main.tsx` and
`dev/loom-overlay-fixture/main.tsx`; the report lists 2 comparisons that fail on
the built-in `spaceMembers` in a function body, a reason no run before the merge
had, and that these are the two was not checked. 23 modules request an effect,
where 16 did. `main`'s alignment of elements runs with the option off as well,
so today's labels of spliced arrays, and with them the rows beside today's, can
differ from the runs before the merge for that reason alone. Every corpus run
from `4363108f0c` on is on this source, and "The corpus" below has the figures
of the last one.

**Not verified** for a change of a list's members: records in place with entries
below them, under a `*` entry of origin `structure` that a `structure` entry
further down replaces ("To read first", 4). Verified earlier, with the
fixture `compare/fixtures/member-edges.tsx` over a list of plain values in
place: members removed and added in one transaction at the same position, where
nothing had to change; `key(i).set(undefined)`, which stored no label and is
fixed; and a write beyond the end of a list, which stopped the executor
(`exec/parts.ts`) and is fixed. A write beyond the end leaves a hole before the
position it writes, which is a channel of the write gate proposal and is not
closed.
**The cost of one changed element.** `compare/template-cost.ts`, a
`filter` over a list of 100, 1,000 and 10,000 elements with one element
changed, preparation time in milliseconds with the option off and on, the
median of two runs:

| The list | 100: off / on | 1,000: off / on | 10,000: off / on |
| --- | --- | --- | --- |
| An array of plain values in place | 3.0 / 1.1 | 1.4 / 1.5 | 3.7 / 5.5 |
| An array of references | 0.6 / 0.7 | 0.9 / 0.9 | 3.2 / 3.2 |
| The result of a `map` | 0.4 / 0.6 | 0.5 / 0.8 | 0.5 / 0.7 |

With the option on, a commit instantiates 3 to 7 templates at every size,
and a test pins that the counters and the stored entries are equal at two
lengths. The time at 10,000 elements of plain values in place, 5.5 ms
against 3.7 ms, was not examined.

**A defect found and fixed.** The first build stored one label entry per
element of a kept per-element output, and every commit encoded, hashed
and compacted all of them: the preparation of a change of one element took
2.2, 16.8 and 157.5 ms at 100, 1,000 and 10,000 elements. Where every
element of an array written whole has one label, one entry at the array's
`*` path is now stored, and the same change prepares in 0.6 to 0.8 ms at
every size. The rule and its limits are in
`plan-and-label-templates.md` §2.3 ("One entry for the elements of an array
written whole").

**The comparison.** `compare/stored-labels.ts` reads both sides of a row
after the last event, with every link below the row's path followed: the
label at each position alone, joined over every position of the value
(`deepLabel`), and a container row in the class `shape` on both sides. A
link that names a position by a path is followed through the links stored
on the way to that position. Labels are compared in commitment-normal
form, since a label that derives from a document of another space holds
the committed form of that document's atoms. For each binding of a slot
of the argument that observes more than a reference, the comparison also
checks, without the template, that the label the runtime resolves holds
the clause of the input the slot is below and that no chain ends at a
position that holds a link; the run reports no binding that fails the
check.

A link is followed in the scope it names (`storedReader` of
`compare/deep-label.ts`), since today's `wish` for a target of the home space
keeps its state in a document of the user behind a link that names that scope,
and the label of a row is read starting in the scope of its cell (`deepLabelOf`
of `compare/harness.ts`).

**`wish` in the comparison.** A module that calls `wish` runs in a seeded
home (`compare/wish-home.ts`). Before the pattern is compiled, today's
runtime is given a profile in a space of its own, under a schema whose
confidentiality is a user atom, and a root of the home space that lists
the profile and holds an empty list of mentionable pieces and an empty
piece registry; today's `wish` resolves against them. The executor is
given the same documents and a table that answers `#profile`,
`#profileName`, `#profileBio`, `#mentionable`, `#pieceRegistry` and a
search by tag with the outcome today's runtime stores, so a read of the
profile is a read through a reference into another space, with the label
the storage holds for it. The table also reports the positions each
answer read (`simulatedReads`), which the write record of the outcome
carries. Not simulated: the profile is data and no
running instance of `patterns/system/profile-home/profile-home.tsx`; a
search by tag finds nothing; and `#summaryIndex`, `#learnedSummary`,
`#default`, `#chatManager`, `#favorites`, `#journal` and a query that is
computed have no answer, so a module whose executor resolves one of them
is not run. Of 113 calls of `wish` in the patterns outside tests, 46 are
answered from the seeded profile, 16 with an empty list, 13 by the clock,
17 by a search with no match, and 21 are not simulated.

**The corpus.** `compare/corpus.ts` over the whole corpus, `patterns/system/`
included, on the source of current `main`, at `79d2e29dd6`. Of 287 modules
attempted 244 run. 23 request an effect. 13 runs fail at a commit that CFC
enforcement refuses as not prepared: 6 for a missing trusted-event policy, 4 for
`writeAuthorizedBy`, 2 for `maxConfidentiality` and 1 for `writePolicyAnyOf`. 1
needs a `wish` that is not simulated (`#summaryIndex`), 1 has no value code, and
5 comparisons fail: 2 on the built-in `spaceMembers` in a function body, 1 each
on `spaceDeleted` and `linksOf`, and 1 on an element construct that has no
function. Beside today's rows:

| | Equal | Tighter | Looser | Other |
| --- | ---: | ---: | ---: | --- |
| 1,763 output rows | 280 | 1,090 | 80 | 296 whose atom names the pattern, 17 incomparable |
| 414 write rows | 318 | 8 | 80 | 8 incomparable |

31 of today's rows have no stored write and 4 no stored output to compare. The
160 looser rows are not classified by cause at this run.

Against the run at `482c8ed39d`, the end of round l (`diff-rows.txt` and
`compare.txt` of the run's outputs): 2,108 of its 2,154 rows have an equal
stored label, 46 differ, and 23 rows are new. Today's labels of the 2,154 rows
are equal in both runs, and the arm with the option off has the same commits and
preparations.

- *23 new rows in 18 modules* are write rows of today's run that had no stored
  write to compare with. The run with the option on starts from the argument as
  given, so a handler's append lands where today's run appended.
- *28 rows in 4 modules differ because their commits were refused before:*
  `apps/topic-workbench/main.tsx` 15,
  `dev/gideon-tests/test-record-key-set-56.tsx` 8, `apps/base/contacts.tsx` 3
  and `apps/person-workbench/main.tsx` 2. They are the labels of commits that go
  through, on join bounds.
- *18 rows in 7 modules are not traced row by row:*
  `apps/budget-tracker/expense-form.tsx` 5,
  `dev/scope-bug-ct1597-reduce/main.tsx` 4, `product/primitives/check-list.tsx`
  3, `apps/file-share/main.tsx` 2, `showcase/card-piles/main.tsx` 2,
  `apps/contacts/contact-book.tsx` 1 and
  `product/primitives/amount-ledger.tsx` 1. Each of these modules has a handler
  that appends to an input list or reads the time of day, so its run with the
  option on starts from another state than before; the rows with one more
  integrity atom of a body at a list are the derived entry that stays ("To read
  first", 13).
- *Within round m,* 2 rows differ between the run before the stub of "To read
  first", 1, and the last run, both in modules where a handler instantiates
  another pattern: `groups` of `apps/base/contacts.tsx`, whose commit is no
  longer refused, and `addEvent#1/2` of `apps/calendar/calendar.tsx`, which
  loses the pattern atom that a record of the `EventDetail` instance had minted
  under the calendar's plan.

At the end of round l, 109 rows in 15 modules differed from `4363108f0c`, all in
modules that had a refused commit.

The rows looser than today's are not all attributed, and "tighter" is not
evidence of correctness (open finding 13), so the corpus does not show that the
labels from templates are equal to or tighter than today's outside the
deliberate exceptions. A label stored for a write that leaves the value as it
was is such an exception: there the label is wider than today's by rule. A label
that is the transaction's join is another: it is wider than a template's label
wherever the transaction read more than the write's inputs. How many of the
looser rows are in modules that call `wish` was not counted.

Of 20,568 write records checked against the template evaluator of the prototype,
9,051 agree. The run at `4363108f0c` checked 9,318, of which 8,145 agreed; the
records checked are more because commits that were refused go through, 10,007 of
them the records of the write of 10,000 documents of
`dev/experimental/folksonomy-stress-test.tsx`. The corpus run gives the runtime
20,572 write records, which are recorded as 8,766 `plan-write` inputs. Of the
11,517 that do not agree:

- 10,373 in 22 modules are not evaluated because a slot is bound to an empty
  chain, 10,007 of them the records above. With the fallback such a record takes
  the transaction's join.
- 506 in 35 modules have no entry stored at the record's path. They are not
  examined. At the eighth run 68 of 80 such records were read as records of the
  number of members and of the membership of a list, whose label joins labels
  stored before the commit and which the evaluator cannot form.
- 270 are not evaluated because dynamic reads are not reported by the record,
  and 96 in 11 modules because a slot has no binding.
- 57 in 17 modules are not evaluated because the record joins labels stored
  before the commit, and 37 in 8 modules because the record names no template.
- For 99 the evaluator's label is a bound. The relation named is that of the
  evaluator's label to the stored one (`compareLabels` of `compare/template.ts`,
  called with the evaluator's label first): for 74 it is equal in
  confidentiality and holds more integrity atoms, for 18 it holds fewer clauses
  and more atoms, for 6, in `apps/base/contacts.tsx`, it holds more clauses and
  more atoms, and for 1 the clauses are incomparable.
- For 38 the evaluator's label is equal in confidentiality and holds more
  integrity atoms, and for 31 it holds fewer clauses and more atoms. In both the
  stored label claims less integrity and no less confidentiality.
- For 8 in 3 modules the evaluator's label is no bound and holds a
  confidentiality clause that the stored label lacks: 6 incomparable, 3 each in
  `apps/person-workbench/main.tsx` and `apps/topic-workbench/main.tsx`; 1 more
  in `apps/topic-workbench/main.tsx`; and 1 in
  `examples/scoped-user-directory/main.tsx`. They are candidates for a stored
  label that is too narrow and are not examined ("To read first", 2).
- For 2 in `apps/base/contacts.tsx` the labels are equal in confidentiality and
  the stored label holds a pattern atom where the evaluator's holds none. Not
  examined; the module instantiates another pattern ("To read first", 1).

With the option on and not off, no commit is refused, where 60 in 25 modules
were at `4363108f0c` ("To read first", 18). Three modules have a commit refused
with the option on and with it off: `apps/redactor/vault.tsx` and the two of
`dev/test/cfc-trusted-write`. No run stopped after a refusal.

Over the 244 modules the option off made 2,784 commits and 688 preparations in
353 ms, and the option on 2,911 commits and 1,527 preparations in 10,300 ms ("To
read first", 11). The machine was under load during the run, with load averages
between 10.5 and 12 and another corpus run in progress, so the times are an
upper bound and not a measurement of the cost. With the option on the runtime
took a bound 1,284 times, in 82 modules. The whole run took 653 s. By run, with
the option on:

| Run | Commit | Refused, on and not off | Preparation | Bounds | Records given, recorded | Wall | Load |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| The code of the ninth run on this source | `4363108f0c` | 60 in 25 modules | 7,987 ms | 1,792 | not counted | 572 s | about 8.6 |
| With the three changes of representation | `7e732de8c8` | 60 in 25 | 7,112 ms | 1,055 | not counted | 556 s | beside other work |
| The end of round l | `482c8ed39d` | 11 in 4 | 12,737 ms | 1,256 | 20,241, 8,685 | 572 s | about 8 |
| Round m, after the fixes of soundness and of the preparation | `68fff9e26c` | 3 in 1 | 9,833 ms | 1,351 | 20,595, 9,122 | 616 s | 8.8 to 9.0 |
| Round m, the last run | `79d2e29dd6` | 0 | 10,300 ms | 1,284 | 20,572, 8,766 | 653 s | 10.5 to 12.0 |

The preparation time rose at the end of round l because the commits that the
fallback let through are prepared, the write of 10,000 documents among them, and
fell in round m with the fix of the quadratic preparation. The difference
between the last two rows is within what two runs differ by under this load.

**The cost of a label for a write that leaves the value as it was.** With the
option on, 2,795 write records are those of a write that left the value as it
was, and the commits that recorded them changed 34,447 label entries. The run at
`4363108f0c` had 2,374 such records and 23,187 changed entries; the rise is at
the end of round l, where the commits that had been refused go through, and was
not measured by cause. The option on makes 127 more commits than the option off,
where the run at `4363108f0c` made 24 more, and 839 more preparations. Two
mechanisms add commits by construction: a derivation transaction that gives
again the records of the outputs that read a label that changed alone, and a
reader that runs again because the label it consumed changed.

Today's runtime committed 1,970 transactions to its storage from the start of
the instances until every kept output was read, 1,853 from the first event on,
and 377 before the start, which is the compile cache; none was reverted. The
count is of the commit notifications that the storage manager of today's run
broadcasts. It is taken at another layer than the executor's count of its own
commits, which includes the append of each event and each watermark as a
transaction, so the two are not a comparison of work.
The crate emits the corpus as one program in 6.3 s. Three changes brought
it there from 339 s: two quadratic steps of the footprint analysis are
linear (`Val::alts` and `normal_map` of `src/footprint.rs`), the identity
of every module is formed once per program, and a path over a value whose
type declares no structure widens where it repeats
(`footprint-analysis.md` §5.2).

**Defects the corpus found, fixed.**

- *The compiler crashed on the whole corpus.* `returned_origin` and
  `passed_on` of `base/pattern-compiler/src/plan.rs` resolved the returned
  expressions of a body defined in another module with the semantic tables
  of the module being emitted, which panicked with an index out of bounds
  in `oxc_index`. Both now resolve them in the module the body is written
  in.
- *Three defects stored a label narrower than the truth.* First, a
  `select` branch used the `identity` slot of its operand where
  `plan-and-label-templates.md` §3.5 requires the `value` for a scalar
  (`select_in` of `src/plan.rs`), so `(name ?? "").toUpperCase()` stored no
  clause of `name`; a branch now has the class `branch_class` gives by the
  operand's type, and a read of a selected container in the `select`'s own
  cone joins each branch with the `value` of its place. Second, a read
  through the output of a selected reference in another cone, and a kept
  output at a path below such a value, had only the references in their
  template; they now have a `dynamic` read of kind `link` through the
  output (`through_output` and `holds_reference` of `src/plan.rs`). Third,
  the adapter recorded a position as read before its write at the first
  read and did not count a read after the transaction's own write (`read`
  of `compare/runtime-transactions.ts`), so a slot there was bound to the
  label stored before the transaction; such a slot is now bound to the
  label the write staged.
- *A defect of the comparison's oracle masked them.* The evaluator
  resolved every slot binding as a recursive read, so a `shape` slot took
  the entries below its position. It now resolves a `shape` and an
  `identity` slot as a read that is not recursive, as the runtime resolves
  the read the adapter journaled.
- *A slot below the elements of a collection that no element was read
  for had no binding,* the commonest refusal: an `identity` slot at
  `items/*` of a handler or a `computed` that spreads or pushes to an empty
  list. The write record now binds it to `*` below the collection
  (`#elementsBound` of `exec/executor.ts`), and the runtime takes the join
  of the element entries `*` covers, none for an empty collection.

- *Two bindings stored a label without the clauses of what the slot
  read.* A `value` slot that no evaluation of the writing cone bound took
  the positions of another slot at the same path; where that slot
  observes the reference, the positions end at the link, and the label was
  that of the link's position alone. And the read of a value that holds
  links was reported as one chain, of which the runtime took every
  position but the last as a link crossed. Both are fixed: the chain goes
  on to where the link leads, and a binding lists each position reached
  through a link in the value as a chain of its own
  (`plan-and-label-templates.md` §2.5, "A value that holds links"). 93
  rows in 34 modules gained a clause.
- *An `enumeration` slot was resolved as a read of the container's
  value,* so the label of `items.length` held a clause that only a member
  of an element declares. It is resolved as a `shape` read at the
  container's path.
- *The statement body of a `computed` that returns a place it named*
  stored a copy under the label of the reference. The returned place is
  observed for `value`.
- *Refusals fixed:* a slot of the argument or of a state cell that no
  evaluation bound is bound to the position it names; the slot of a
  binding whose state the pattern computes is bound to that output; the
  slot of a literal that a handler binding gives its state is a constant;
  a slot that reads what a `reduce` computed is bound to the positions its
  steps read; a slot that a cone's template reaches and another cone read
  is bound where that cone read it; and, over an array of plain values in
  place read through a computation, the slot of an element at no stored
  position is bound to the one position that the computation read, which
  is a wider bound than the element's own position.
- *An instance that a function body makes* created again the documents
  the executor was given, in the transaction of the body. It does not.
- *Three refusals of the pre-pass:* the slot of an index, a member of a handler
  binding's state at no stored position, and a collection that "iterates no
  source" are bound as "What is built" has them. A staged address below the
  target of the write whose label is being instantiated, and a chain marked
  `staged` whose position that write itself covers, were refused as a cycle; the
  first takes the label of a write further up or the join, and the second the
  label stored at the position.

**Open findings.** What is unsound, stubbed or not verified comes first, then
the cost that still grows with the data, then the rest.

1. *The write records of an instance of another pattern are left out,* a stub
   over a structural defect of the adapter, which registers one plan ("To read
   first", 1). The labels of such an instance are join bounds, and a write of it
   that leaves its value as it was stores no label, so the ruling Z67 is not met
   there. The fix is planned and not built: a registered plan and a table of
   inputs for each instantiated pattern, and each write recorded under the plan
   its instance runs. Question 348 of the design's plan.
2. *Every join bound rests on "the transaction read what flowed",* which fails
   where a value reaches a write from the executor's memory ("To read first",
   2). One such case is fixed, a handler bound in a row of a `map` over an array
   that a computation returned. The others are not audited. 1,284 bounds are
   taken in 82 modules. 8 write records in 3 modules store a label that lacks a
   confidentiality clause that the template evaluator's label holds and are not
   examined. Question 349 of the design's plan.
3. *Suspected: an element of a `fold` whose slot is bound to an output is not
   regrouped on a change of a label that the output read,* in `Instance.#idOf`
   of `exec/executor.ts` ("To read first", 3). Read from the code, not verified,
   no test. Question 350 of the design's plan.
4. *A removal's `*` entry is replaced by a more specific entry of origin
   `structure`,* in `resolvedEntryGroups` of
   `runtime/runner/src/cfc/consumed-label.ts`, for a slot of an array of
   references at which a recorded link write minted a `followRef` entry ("To
   read first", 4). Unsound for that slot. Not fixed and not tested. The fix, a
   group of its own for an entry that the runtime minted at a `*` path, changes
   the resolution with the option off and needs the specification sentence
   first. Questions 343 and 326 of the design's plan.
5. *One finding of the check is classified as an artifact of the numbering of
   created documents and is not shown to be one,* the write of
   `product/primitives/sortable-table.tsx`; and 5 values in 2 modules are found
   in runs with a refused commit and are not counted or examined ("To read
   first", 5). The check would need to match created documents by what created
   them. Question 350 of the design's plan.
6. *A handler that writes nothing under a condition on a labeled input stores
   nothing* ("To read first", 6). A channel of the write gate proposal: by the
   owner's ruling (Z77) it is recorded and not fixed.
   `examples/map-demo/map-demo.tsx` shows it with generated events. Of the same
   kind, and recorded: a member appended at another index (Z74); a hole that a
   write beyond the end of a list leaves before the position it writes; and a
   removal that finds nothing, which leaves the positions as they were. Question
   335 of the design's plan.
7. *The preparation of a transaction that writes many documents still grows with
   the written documents times the reads,* in `InputReadView.#stands` of
   `runtime/runner/src/cfc/prepare.ts`, and with the option on such a
   transaction is prepared where today's runtime prepares none ("To read first",
   7). Whether the fix of the quadratic steps goes to `main` in a pull request
   of its own is question 347 of the design's plan.
8. *A handler bound in a row of a `map` over an array that a computation
   returned reads every stored position the computation read,* for each event
   ("To read first", 8). Question 351 of the design's plan.
9. *What the three changes of representation leave linear,* for an array of
   references ("To read first", 9; "The cost that grows with the data"). With
   it: after a label changed alone, the records of outputs to give again are
   found by position and not by class (`Instance.#recordsReading`), so an output
   that holds a link is given again when any label of the document the link
   names changes, though its slot reads the reference alone.
   `scheduler-and-serving-loop.md` §3.6 has the rule, by the slots a template
   reaches. The plan: the executor keys the readers of a record
   (`#recordReaders` of `exec/executor.ts`) by the class each slot observes
   beside the position, and a record is formed again only where a changed
   entry's class is one its slot consumes. The comparison adapter still reads
   the stored label entries of every written document after the commit and
   compares every entry, and `prepareBoundaryCommitSteps` itself walks every
   stored entry of a written document. The plan for that: the preparation
   returns, per document, the paths of the entries it added, changed or dropped.
   Questions 333 and 351 of the design's plan.
10. *A collection whose members have labels of their own* has a label of as many
    clauses as members for anything computed from the whole of it ("To read
    first", 10). The diagnostic, the hard limit and an output stored at a
    declared ceiling are ruled and not built. Questions 339 to 342 of the
    design's plan.
11. *The preparation time over the corpus,* 10,300 ms with the option on against
    353 ms with it off, under load, with 7,917 ms in three modules, two of which
    are not attributed ("To read first", 11). Question 345 of the design's plan.
12. *The executor's memory on `dev/experimental/folksonomy-stress-test.tsx`* was
    not measured again ("To read first", 12). Question 332 of the design's plan.
13. *The check against the values is a lower bound, and "tighter" in the
    comparison is not evidence of correctness.* A row counts as tighter where
    the stored label has fewer clauses than today's, and a binding that leaves
    out a read has exactly that effect. The check on a scenario as given changes
    each input once and covers confidentiality alone. The check with every event
    sent three times covers 131 of the 244 modules, does not reach a branch that
    one value of an input decides, is cut short for a large scenario, and
    matches created documents by their number. Neither sees a value that flowed
    from the executor's memory unless a labeled input of the scenario made it
    and the change of that input changes what is written.
14. *506 write records have no entry stored at their path,* in 35 modules, where
    the evaluator gives a label; 480 in 32 modules at `4363108f0c`. Not
    examined.
15. *The bounds.* The runtime took a bound 1,284 times, in 82 modules. A bound
    is taken because the value code or the runtime does not report a selection,
    a choice or the addresses of a dynamic read: picks through `.key(k)`; the
    `through` position of a scan; the choice of `find`; the `select` over the
    keys of a record constructed in place; the optional members of a spread; and
    dynamic reads of kind `link` through a selected reference.
    `plan-and-label-templates.md` §4.2 has, for each, who knows the answer, what
    is reported and where it is kept, and the provisional decision P37 for the
    groups of a scan's prefix. A bound is also taken for a record that the
    executor gives with no inputs and for a record that lacks an input ("What is
    built"). The run does not count the kinds apart, and the counter counts
    instantiations: a record that stands for several paths, and records that
    name one entry of the table of inputs, count once.
16. *The cost of a label for a write that leaves the value as it was* ("The cost
    of a label for a write that leaves the value as it was", above). 127 more
    commits with the option on than with it off, and 839 more preparations,
    since every commit of a compiled pattern is prepared. Question 324 of the
    design's plan.
17. *Looser rows that are not attributed.* 80 output rows and 80 write rows are
    looser than today's, and they are not classified by cause at this run. 18
    rows in 7 modules that differ from the end of round l are not traced row by
    row.
18. *What the ruling on the atom of a kept output leaves open.* The atom is on
    the content at the output's path (Z81). The envelope of the document that
    the link names is not written, a write edge that stores a reference keeps
    the atom of its body in the label of the link, and whether the specification
    needs a sentence for an atom with no scope at the path of a link is not
    decided (`plan-and-label-templates.md` §8, question 72).
19. *A declared integrity that the crate emits as text.* The rows of
    `examples/cfc-authorship-chat` differ from today's by the atom
    `authored-by`. The schema the crate emits for its cells holds the declared
    integrity as the text of its type, `ifc.integrity: { "$source": "readonly
    [AuthorshipIntegrity<IntegrityAuthor>]" }`, which the runtime refuses as
    malformed integrity. A cell with such a schema gets no document at the start
    and stores no declared label. Not looked at again at this run.
20. *The catch-up merge with `main`* has two interactions that no test covers
    ("The catch-up merge with `main`", above). Question 346 of the design's
    plan. The specification sentence that the ruling on a removal needs is
    proposed and pending the specification pull request.
21. *Seen in today's runtime, by reading and not measured:*
    `contractCandidatesForWrite` of `runtime/runner/src/cfc/ui-contract.ts`
    scans every write-policy input of the transaction for each write of an
    event's transaction (`recordTrustedEventPolicyInputs`), so its work is the
    product of the two counts. Records that differ in a member of one container
    are one write-policy input since round l, so a write of 10,000 documents
    gives 7 `plan-write` inputs and no longer 10,007; the product remains for
    records that do not merge.
22. *`#unchangedOutput` and `#outputRecord` of `exec/executor.ts` find the
    recorded output for a path by a scan of the recorded outputs.* A stub with a
    plan: index the recorded outputs by path.
Steps 11 and 12 of the milestone's plan, instantiation keys and verified units
in the prepared digest and a derived write dropped alone, are not built.

## Milestone 2: Topics at scale

Measured on the Topics branch (`claude/compiled-pattern-topics`) with the
harness `base/pattern-compiler/compare/topics/scale.ts`: one process per arm,
board and size, an edit is the median of three, on an 18-core machine at load
averages of 6 to 12. Counts are exact. Every topic has the clause of the
input `topics`; a clause of its own on each topic
(`SCALE_TOPIC_LABELS=distinct`) is the separate case of the next section,
whose cost today's runtime has as well and the compiler does not introduce.

Three boards are measured. `main` is `patterns/apps/topics/main.tsx`, whose
cards are the output of one `lift` over the whole array of topic references.
`filing-order` (`board-filing-order.tsx`) derives the cards by a `map` over
the array of topic references, with no sort. `sorted-references`
(`board-sorted-references.tsx`) has a `lift` that reads the sort key of each
topic and returns the references in order, and a `map` over that result. On
the last two, `mentionable` is a `map` over the array of topic references
whose rows are plain values in place.

| One edit, ms | 100 topics | 1,000 topics | 2,000 topics |
| --- | ---: | ---: | ---: |
| `main`, executor on runtime storage | 260 | 2,680 | 7,295 |
| `filing-order`, executor on runtime storage | 232 | 2,369 | 5,888 |
| `sorted-references`, executor on runtime storage | 251 | 2,555 | 6,965 |
| `main`, executor in memory | 20 | 171 | 398 |
| `filing-order`, executor in memory | 10 | 79 | 183 |
| `main`, today's runtime | 392 | 4,116 | 8,138 |
| `filing-order`, today's runtime | 335 | 3,155 | 7,665 |

An edit at 1,000 topics is below today's runtime and grows with the board, so
the rule of "Two tracks, one target" is met in its first half and not in its
second. The instantiation of templates is flat: 17 templates, 45 nodes and 9
records per edit at every size. A write record lists one position for each
group of positions read through a handle that hold one label (provisional
decision P49): 20 KB, 118 KB and 226 KB of records per edit of `main`.

One edit of `filing-order` at 1,000 topics takes 2,826 ms in the profiled
run: the executor's own work 95 ms, the records of writes that left their
value 106 ms, the end of the transaction 736 ms of which the preparation is
589 ms, and 1,861 ms from the executor's return until every commit has
settled. Each part is ten times what it is at 100 topics. Three causes:

- **The result document is written by every edit and holds every row.** It
  holds 21 label entries a topic for the cards and 8 more for the rows of
  `mentionable`: 29,052 entries and 10 MB at 1,000 topics. The preparation
  and the memory server's handling of the commit follow the size of that
  document. The remedy is that the rows of each per-topic collection in the
  result are documents of their own (the placement rule of the next section).
  The adapter of milestone 1 writes the result as one document; the runner
  path of milestone 3 stores such rows as documents (provisional decision
  P54; "Milestone 3: a compiled piece in the runner" below), and an edit of
  a title there does not write the result document.
- **A `lift` that reads two fields of each topic runs again on an edit of
  any field.** A read through a handle records the root of the member's
  document as read. `crossrefTable` and the sort of `sorted-references` run
  on every edit of a title for that reason. The remedy is a read through a
  handle that depends on the positions read. Milestone 3 builds it: the plan
  holds the schema of the type a body declares for a handle, and a read under
  it registers the members that schema declares (provisional decisions P56
  and P57). On the runner path an edit of a title runs no whole-list `lift`.
- **The records of rows a `lift` writes are given for every row on each
  run** (provisional decision P48): 1,010 given for an edit at 1,000 topics,
  of which 11 are recorded. The remedy is no record for a row whose value and
  whose inputs' label identifiers are those of the run before. Milestone 3
  builds it (provisional decision P59). It does not apply where the
  transaction in progress wrote a position the `lift` read, as a create
  does, since such a position has no label identifier yet.

The language has no construct for three of the board's whole-list `lift`s:
`namesTable` is a row for each entry of a record of references, and there is
no per-element construct over a record; `crossrefTable` is a join; and
`crossrefIndexOf` groups by name into a record.

**The decision.** The owner decided on 2026-11-21 to go to milestone 3 on
this evidence, and to build the rows as documents there. The edit at 100,
1,000 and 2,000 topics, from send to settled, is measured on the runner
path in "Milestone 3: a compiled piece in the runner" below: on
`filing-order` an edit of a title takes 14 to 123 ms where this section has
232 to 5,888 ms, and the work of the piece in it is 3 to 4 ms at each size.

**Two defects found on the Topics branch.** The first stays on the runner
path of milestone 3. The second is closed there.

- The first create after a load on `main` brings a new clause into what the
  whole-list `lift`s read, so every row is labeled again in one commit: 15.5 s
  at 1,000 topics and 53.6 s at 2,000, of which the preparation is 7.2 s and
  27.0 s. The preparation finds written and covered paths by prefix
  (`runtime/runner/src/cfc/prepare.ts`) and is still more than linear in the
  paths of one document; two passes compare each cleared existence entry with
  each written path. Milestone 3 changes neither the preparation nor the
  board: a create on the runner path runs the whole-list `lift`s and gives
  every row its record again, and the preparation of a large transaction is
  also the number of targets times the number of reads (the new section,
  "What still grows, and why").
- A change of a label alone, at a position a `lift` read, does not form the
  labels of the rows that `lift` wrote again until the `lift` runs again. The
  record of an output is formed again on such a change; the rows have nothing
  like it. This is an under-label for the time between. On the branch of
  milestone 3 the records of the rows are one reader of the labels the `lift`
  read, and the label of a record is formed again when a label it read
  changed, whether or not a value changed with it (provisional decisions P58
  and P59), with a test.

## Labels of large derived collections

Where each of `N` members of a collection has a label of its own, a value
that depends on all of them has a label of `N` clauses. On the Topics board
with a clause per topic, each card's 22 label entries hold all `N` clauses,
since the cards are the output of one `lift` over the whole array of
references and a `lift` output has one label. An edit at 100 topics takes
5.3 s and the entries of the changed documents are 33 MB; at 200, 21 s and
130 MB. Three causes are separate, and each has its own answer.

**Repetition.** The same label is stored at every entry of every row.

- A label is stored once for the collection, at a `*` entry, and joined into
  each read below it, as ruling Z71 does for the decision of a removal.
  Adding a member then changes one entry.
- A label of many clauses is named by a content identifier over a canonical
  tree of its clause identifiers, hashed per node. The same set has one
  identifier in any order of insertion, an added or removed clause changes a
  number of nodes logarithmic in the set, and the check of one reader is
  kept per node. A chain, the identifier of the label before joined with the
  new clause, costs one step per addition but names one set differently by
  order and is formed again whole on a removal.

**Coarseness.** A `lift` over the whole list gives each row the join where
its content depends on one member.

- The cards are a `map` over the array of topic references, with the card's
  text computed per topic. The boards
  `patterns/apps/topics/board-filing-order.tsx` (no sort) and
  `board-sorted-references.tsx` (a `lift` that reads the sort key of each
  topic and returns the references in order, then the `map` over that
  result) measure this: an edit at 100 topics with a clause per topic takes
  0.3 s and 1.2 s, with 1.1 MB and 10 MB of entries.
- The language has no construct that keeps a sorted order. A `sortBy(key)`
  construct is the intended form: the compiler knows that the order of two
  members depends on the keys of those two alone.
- A row reached through its position depends on what decided the position.
  For rows held in place, the label of the position is joined into every
  read below it (one entry at `*` of the per-element result). The stored
  labels of a `map` over the result of a `lift` that is an array of
  references need it stated, since a row's own entries replace the entry of
  the array in the runtime's resolution. The executor marks every output that
  holds the result of a per-element construct, and the runtime joins the
  templates stored once at `*` into a read of a position, also for a
  container held within a member of another.
- For rows that are records or view nodes of a `map` over an array of
  references, or over the result of a construct that yields references, each
  row is a document of its own, keyed by the element, and the output array
  holds references. The position then carries the label of the order, the
  row document carries its own, an edit writes one row document, and a
  change of order writes the references. The boundary is decided per
  construct by the compiler from the two templates, and never per row from
  the values of labels at run time: a boundary that moved with the data
  would change addresses and would itself be an effect of the labels (as in
  ruling Z78). Rows that are scalars stay in place. To be measured: `N` more
  documents at load and at first read.

**The join itself.** Where a value does depend on every member, as the order
of a sorted list does, two forms shorten it.

- *Per user, with the user as ceiling.* The derivation runs per user over
  the members that user may read, and its result is stored per user under
  the one clause of that user. Every input admits the user, so the label
  only restricts; no property of the computation is needed. It needs a read
  of a list that yields the members the reader may read and does not reveal
  that others exist. Cost: one result per user, formed again for each user
  who may read a changed member. This is the form to build first.
- *One shared sorted list, filtered on read.* Each reader gets the members
  they may read, in order, under the join over those members alone. This is
  sound where the relative order of any two members depends on those two
  alone, which holds for a comparison sort by a per-element key, a `filter`
  by a per-element predicate and a `map`, and not for a rank shown in a row,
  a top-`k`, a running total or a deduplication that keeps the first. The
  filtered list is indexed anew and does not expose the count of the whole.
  The filter is a trusted step that replaces one join by a smaller one; it
  needs the `sortBy` construct and a proposal to the specification (chapter
  4 on membership, count and order of an enumeration; section 8.2).

A board on which every topic has an audience of its own is one that no
reader can read whole. Once the read of the members a reader may read
exists, the bench for this case is several users with overlapping sets of
readable topics, each with a result per user.

**Found on the way, in the executor.**

- A read that stops at the links of members declared as cells names no
  position of what a link leads to (provisional decision P46), and an
  `enumeration` slot of one container is bound to the container alone. Both
  are fixed on the Topics branch.
- A handler's reference to a kept output at a path with no element position
  is a handle to the output's stored position in the result document, which
  refuses a write, and the slot is bound as a constant (provisional decision
  P47). A push then stores a link, and a read through it takes the label
  stored at that position.
- A row document that a `lift` writes with `Writable.for(...).set(...)` has
  the record of that `lift` under the plan's `created` write edge
  (provisional decision P48).
- A `lift` parameter member typed `unknown` was handed the content of the
  linked document in one probe. Not examined.

## Milestone 3: a compiled piece in the runner

Built in two rounds on 2026-11-22 on the branch
`claude/compiled-pattern-runner-m3`, behind the experimental option
`compiledPatterns`. The part that touches storage, the scheduler and
Contextual Flow Control is `runtime/runner/src/compiled/` (`piece.ts` and
`transactions.ts`); the executor is `base/pattern-compiler/exec/`. Notes 579
to 598 of `base/pattern-compiler/SPEC-NOTES.md` on that branch hold the
detail, and the provisional decisions P50 to P63 of
[compiled-pattern-language.md](compiled-pattern-language.md) are of these
rounds. Every figure is of one writer on emulated storage in one process, with
flow labels stored (`cfcFlowLabels` is `persist`), on an 18-core machine at
load averages of 3 to 10. Every topic or item has one shared clause unless a
paragraph says otherwise. Whenever this section says `map`, it names the case:
an array of references, an array of plain values in place, or the result of
another per-element construct.

**Findings on structure, scale and soundness.**

- *An edit of one topic's title does the same work at every size of the
  board.* On the boards `filing-order` and `sorted-references`, with rows as
  documents, the edit makes 5 evaluations, reads 12 positions, gives 9 write
  records, makes 2 commits and writes 3 documents with 30 label entries, at
  100, 1,000 and 2,000 topics. The work of the piece in it is 3.0 to 3.8 ms on
  `filing-order` at each size. The time of the whole step is 14 to 123 ms and
  follows the position of the edited topic among the topics, for a cause in
  the memory server that today's path has as well (fourth finding).
- *Soundness: a label that changed has to reach every record that read it,
  also where a value changed with it.* Milestone 4 forms the label of a record
  again only for a change that the store reports as one of labels alone. A
  write by another writer that changes the label of a document together with a
  value that no derivation read then leaves every record that read the
  document, rows and outputs alike, stored under the label of before, which is
  an under-label. On the branch of milestone 3 the label of a record is formed
  again whenever a label its inputs read changed and the record is not given
  again (provisional decision P58), with a test.
- *Soundness: the executor has gone on when a commit of the piece is refused.*
  Left so, its documents are ahead of the storage, and a later derivation can
  store, under the labels of what the storage holds, a value computed from
  what the refused transaction wrote. The piece takes what the storage holds
  for each document the refused transaction wrote and derives again
  (provisional decision P62). This is closed for those documents, with what
  "Not verified" below lists.
- *Scale: the memory server's refresh of tracked queries follows the links
  from a written document.* On the generated boards each topic mentions the
  two before it, so a write of topic `k` follows `k` topics: a write of a
  field the board does not read takes 30 ms at the first of 2,000 topics and
  88 ms at the last. A profile of the edit of the last of 2,000 topics has 68
  of 87 ms in the server's `refreshTrackedGraph`. This bounds what an edit
  costs on either path. It follows the links of the written document and not
  the size of the board.
- *Scale: the runtime's preparation of a commit is the number of targets times
  the number of reads.* The preparation asks `InputReadView.reads` of
  `runtime/runner/src/cfc/prepare.ts` once for each target it verifies, and
  each ask compares every read record of the transaction with the snapshot the
  view holds (`InputReadView.#stands`). It is on today's path as well and no
  part of the compiled path: writing 10,000 input cells in one transaction
  with no piece started has 9.8 s of preparation where 1,000 cells have 0.17
  s, and today's arm loads the board of 1,000 topics in 110 to 125 s, 76 s of
  one run in the preparation.
- *Scale: the load of a compiled piece is one commit.* At 2,000 topics that
  commit holds 8,011 documents and the memory server refuses it with
  `MessageTooLargeError`, since one client message is limited to 1,000,000
  array slots and record members. The split into bounded transactions is a
  plan and not built (provisional decision P63).
- *Scale: a create, and every change of the members of a long array, still
  follow the size.* "What still grows, and why" below has each.
- *Three over-labels are found,* one of rows in place, one of rows as
  documents and one of the crate ("Over-labels found" below). No under-label
  of rows as documents is found against rows in place.
- *A write by another writer to a derived array is not taken by the executor,*
  in either layout. With rows as documents it is reported
  (`CompiledPiece.refusals`); with rows in place nothing reports it
  (provisional decision P61).

**What is built.**

- *Start.* `startCompiledPiece(runtime, tx, artifact, argument, resultCell)`
  of `runtime/runner/src/compiled/piece.ts` is the call beside `Runtime.run`,
  and it throws with the option off. The result document of the instance is
  the entity of `resultCell`, every other document the executor makes is an
  entity of the same space, and the creation and the first derivation are
  written into `tx`, which the caller commits. `runtime.ts` and `index.ts` of
  the runner do not import `src/compiled/`, so a runtime that starts no
  compiled piece loads none of it. The runner imports the executor by relative
  path, and the executor imports nothing of `runtime/` (provisional decision
  P50). Value code is evaluated as the executor evaluates it, with no sandbox.
- *Events.* A stream of the executor is stored as a link to an entity that
  holds the runtime's stream marker, and the piece registers one event handler
  of the scheduler for it (`Scheduler.addEventHandler`), so `Cell.send` on the
  member of the result reaches it. The handler runs the compiled handler in
  the transaction the scheduler gives it (`Instance.handleEvent`), which the
  scheduler commits. An event that a handler sends to a stream of the piece is
  queued with the scheduler as well (`Instance.takeQueued`). No event is
  appended to a stream document and no watermark is written (provisional
  decision P52), and every transaction the executor opens within one call of
  the scheduler is written into the scheduler's one transaction
  (`RuntimeTransactions.within`; provisional decision P53).
- *The derivation, and settled.* The derivation is one action of the scheduler
  for the piece, an effect, which runs `Instance.settle()` in the scheduler's
  transaction (provisional decision P51). The piece invalidates it after an
  event, after a change by another writer, when a commit of another writer
  changed a label the executor read, and after a refused commit. Settled is
  what it is for any piece: `Runtime.idle()` resolves when no event is queued
  and the derivation action is not invalid, and the harness then awaits the
  commits (`Scheduler.idleWithPendingCommits()`). The action opts out of the
  scheduler's delay of 100 ms for actions that take 50 ms or more on average
  (`Scheduler.setNoDebounce`; provisional decision P55).
- *The store.* The executor's store is the copy in memory that keeps the
  identity of arrays. A document the executor did not make, such as an input
  cell the argument links to, is read from the replica when a reference first
  leads to it (`Store` option `load`) and not again. Each position read is
  journaled in the transaction (`TransactionHooks.read`).
- *Writes by others.* The piece subscribes to the storage notifications. A
  commit whose source is no transaction of the piece and that changed a
  document the executor holds is applied to the store outside any transaction,
  which marks the readers, and the derivation is invalidated. A change of the
  members of an array is applied as the one splice between the array before
  and after, found by comparing the canonical text of the members from both
  ends (`spliceBetween`). A write into the document of a row is applied to the
  row the executor holds; a write of the array of links of a derived array, or
  above it, is reported and not applied (provisional decision P61).
- *Rows as documents.* `rowDocumentCollections` of `exec/row-documents.ts`
  reads the plan when the piece starts (provisional decision P54). It names a
  collection whose construct is `map`, written in no element body, with an
  output below a row, whose source is a slot whose schema declares the array
  or its members as cells, or an output whose body gives a reference at each
  member, or a `filter` over such a source. That is a `map` over an array of
  references that the type declares as references, or over the result of a
  construct that yields references. A `map` over an array of plain values in
  place keeps its rows in place whatever the data holds. Each named row is an
  entity of its own, named by the array's document, its path and the key of
  the row, and the array holds the runtime's link to it. The array can stand
  below a member of an array, as the cards among the children of a view node
  do. On the boards `filing-order` and `sorted-references` the rule names the
  cards and `mentionable`; on `main` it names nothing, since there both are
  the result of a `lift` that gives plain values. `CompiledPieceOptions.rows`
  set to `in-place` keeps the rows in the array, for comparison. A member
  added at the end of an array of row documents is written as the number of
  members and the link added (provisional decision P60); a prepend and a
  removal write the array of links whole.
- *Reads through handles.* The crate emits the schema of the type a body
  declares for a handle (`ReadInput.schema` and `ComputedInput.schema`, from
  `body_record` of `src/plan.rs`), the executor reads through the handle under
  that schema, and a read under a schema that declares its members registers
  the positions of those members and not the root of the member's document
  (provisional decision P57). The read of a slot that observes which children
  a container has gives the members as references and reads none of them,
  where no slot of the cone reads a child as a value or a shape, or where
  every body of the cone that is handed the container declares a handle at
  each child (provisional decision P56).
- *The label readers.* The label of a write record is formed again when a
  label its inputs read changed and the record is not given again
  (`Instance.labelsChanged`; provisional decision P58). The store says for
  each change whether a read of a class at a position consumes the label it
  consumed before (`LabelChange.unchanged`), so an entry that a `Cell.set` of
  one field adds under the label of the document's root forms no label again.
  The records of the row documents that a `lift` writes are one reader of the
  labels of what the body read, and when the body runs again a row that holds
  what it held is given no record where the labels the body read are those it
  had read (provisional decision P59). The adapter finds the entries a read
  consumes through the runtime's index of a document's entries
  (`ConsumedLabelIndex`).
- *Refused commits.* When a commit of the piece is refused, by the preparation
  or by the store, the adapter reads from the replica what the storage holds
  for each document of the executor that the transaction wrote, the piece
  takes it in place of what the executor holds (`Instance.restore`), which
  marks what read those documents, and the derivation runs. A document the
  storage does not hold is removed. The result document of an instance is
  taken with the rows of each of its collections left out, and the next
  derivation stores each path that differs and every row. The piece keeps the
  reason (`CompiledPiece.refusals`). An event that the executor itself refuses
  aborts the scheduler's transaction.
- *The harness.* `compare/runner-path.ts` starts today's piece with
  `Runtime.run` and the compiled piece with `startCompiledPiece` over the
  lists of `compare/fixtures/runner-lists.tsx`, sends with `Cell.send`, writes
  with `Cell.set`, awaits settled, compares the results and reports per change
  the time, the commits, the documents written and the preparation's counters.
  Its arm `alone` makes the same changes with no piece started, which is what
  the harness's own writes cost. The arm `runner` of `compare/topics/scale.ts`
  does the same for the Topics boards with the calls of its arm
  `today-labeled`: each topic and each input is a cell written under a schema
  with the clause of the input `topics`, an edit is a `Cell.set` of a title,
  and a create is `Cell.send` on `addTopic`.
- *Tests.* `runtime/runner/test/compiled/piece.test.ts`,
  `row-documents.test.ts`, `layout-labels.test.ts` and
  `refused-commit.test.ts`. They load the checked-in artifacts of
  `compare/fixtures/` and need no build of the crate.

**Which comparison is like with like.** Today's piece computes what a reader
demands, so the harness pulls the whole result of today's piece in each step
(`Cell.pull`), and the figure of today's arm includes that pull. The compiled
piece derives without a reader, so its figure is taken without a pull, and the
pull of its whole result is reported apart. For having the result up to date
after a change, the runner's figure without a pull stands against today's with
it: on `filing-order` at 1,000 topics, 29 ms against 9,459 ms for an edit of
the middle topic. For a reader that reads the whole result after each change,
both include the pull: 4.5 s against 9.5 s. A pull of the compiled result
reads every row document and every topic in one transaction, and its time
follows the board on both arms.

**Topics, one edit of a title.** A write of one topic's title by a writer
outside the board, rows as documents, one process for each board and size.
Each edit is preceded by a write of a field of the same topic that the board
does not read, the "write alone", which is what the write costs with no
derivation behind it. Times in ms.

| One edit of a title | 100 topics | 1,000 topics | 2,000 topics |
| --- | ---: | ---: | ---: |
| `filing-order`, runner, the first topic | 17 | 18 | 21 |
| `filing-order`, runner, the middle topic | 14 | 29 | 48 |
| `filing-order`, runner, the last topic | 15 | 47 | 123 |
| `filing-order`, write alone, first / middle / last | 12 / 10 / 11 | 19 / 27 / 46 | 30 / 58 / 88 |
| `filing-order`, the piece's own time in an edit | 3.8 | 3.0 | 3.1 |
| `filing-order`, a pull of the whole result behind it | 376 | 4,507 | 10,071 |
| `sorted-references`, runner, first / middle / last | 17 / 17 / 14 | 20 / 34 / 67 | 22 / 64 / 151 |
| `sorted-references`, write alone, median of three | 11 | 30 | 53 |
| `sorted-references`, the piece's own time in an edit | 4.0 | 4.5 | 11.2 |
| `sorted-references`, a pull of the whole result behind it | 369 | 4,879 | 10,483 |
| `filing-order`, today's runtime, with its pull | 765 | 9,459 | not run |
| `filing-order`, today's runtime, write alone, with its pull | 481 | 5,987 | not run |
| `sorted-references`, today's runtime, with its pull | 679 | 9,399 | not run |

Today's arm was not run at 2,000 topics: its load at 1,000 takes 110 s, and
the run would pass ten minutes. The coordinator ran `filing-order` on the
runner path again on 2026-11-22: an edit of the first, the middle and the last
topic settles in 20, 15 and 15 ms at 100 topics and in 26, 36 and 49 ms at
1,000, with 5 evaluations, 12 reads and 9 records at both sizes. Every other
figure of this section is the build agent's.

The board `main` was measured on the runner path in the first round alone,
before the reads through handles and the label readers were built: an edit
takes 349, 3,400 and 9,946 ms at 100, 1,000 and 2,000 topics, against 986 and
14,478 ms for today's runtime with its pull at 100 and 1,000. No rows of
`main` are documents, and its cards are the output of one `lift` over the
whole array of topic references, which reads every title.

**Topics, one create.** `Cell.send` on `addTopic`, the median of three
creates, rows as documents, without a pull. Times in ms.

| One create | 100 topics | 1,000 topics | 2,000 topics |
| --- | ---: | ---: | ---: |
| `filing-order`, runner | 243 | 1,960 | 5,096 |
| `sorted-references`, runner | 261 | 2,343 | 4,913 |
| `filing-order`, today's runtime, with its pull | 1,520 | 16,531 | not run |

In the coordinator's run of `filing-order` a create takes 237 to 275 ms at 100
topics and 1,745 to 2,087 ms at 1,000.

**Topics, the load.** On `filing-order`, runner, rows as documents, the load
takes 421 ms at 100 topics and 4.3 to 4.7 s at 1,000, with 74 ms and 1.1 s of
preparation. At 2,000 the memory server refuses the commit; with its limit
raised in the harness (`SCALE_MESSAGE_SLOTS`) the load takes 11.6 to 14.6 s,
of which 3.5 to 5.1 s are preparation. Today's arm loads 1,000 topics in 110
to 125 s.

**The fixture of growth.** `compare/runner-path.ts`, the list `Cells` of
`runner-lists.tsx`: a `map` over an array of references that the type declares
as references, rows as documents. The mean of five changes after the first of
a kind. The compiled arm is without a pull; the arm `alone` makes the same
change with no piece started; today's arm includes the pull of the result and
is of the run of the first round, at a load average of 7 to 10. Times in ms.

| Change | compiled, 100 | 1,000 | 10,000 | alone, 100 | 1,000 | 10,000 | today, 100 | 1,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| edit one field | 3.6 | 3.2 | 5.5 | 1.3 | 1.8 | 3.4 | 82 | 689 |
| append | 17 | 72 | 837 | 10 | 62 | 725 | 140 | 1,250 |
| prepend | 23 | 163 | 2,535 | 15 | 126 | 1,963 | 194 | 1,584 |
| remove first | 19 | 146 | 2,546 | 13 | 134 | 1,839 | 111 | 1,098 |
| remove last | 13 | 85 | 1,096 | 8 | 55 | 822 | 94 | 923 |

The piece gives 6 records for an append, 4 for a prepend and 1 for a removal
at every length, and writes 5, 4 and 3 documents. Most of each change of the
members is the harness's own write, a `Cell.set` of an array of `N` links and
the preparation of that commit. What the piece adds is 7, 10 and 112 ms for an
append and 8, 38 and 570 ms for a prepend at 100, 1,000 and 10,000 rows. The
load of the compiled piece takes 170 ms, 1.0 s and 42.5 s, with 33 ms, 335 ms
and 35.3 s of preparation, and 10,000 rows need the memory server's limit
raised; today's load takes 1.8 s at 100 rows and 70.6 s at 1,000, of which
66.5 s are the preparation, and was not run at 10,000. A pull of the compiled
result takes about 24, 200 and 2,400 ms. With the rows in place, measured in
the first round, an edit of one field of one member takes 10.6, 62.9 and 794
ms: it follows the length of the list, as today's does.

**What an edit of a title does, at every size.** On `filing-order` and
`sorted-references` with rows as documents, the writer's commit changes the
topic's document, and the piece's derivation evaluates 5 cone instances (the
row of `mentionable`, the strings of the card, and the card), reads 12
positions through the transaction, gives 9 write records and commits two row
documents. Three documents are written in 2 commits, the topic and the two
rows, with 30 label entries in them. No whole-list `lift` runs, and the result
document is not written. An edit of a body, an author or a comment count is
the same. Three things make it so: the cards and the rows of `mentionable` are
documents of their own; a body that reads `mentions` and `shortName` through a
handle typed with those members is not marked by a change of the title; and
the read of the array of topics for its members and their number reads no
topic.

**What still grows, and why.**

- *A create.* It runs `crossrefTable`, `namesTable`, `crossrefIndexOf` and
  `topicCount`, each a `lift` over the whole array of topic references or over
  a result of one. At 1,000 topics on `filing-order` it reads 14,136 positions
  through the transaction and gives 2,122 write records, and takes 736 ms in
  the piece and 462 ms in the preparation, the rest in the commits and the
  memory server. Every row of `crossrefTable` and `namesTable` is given its
  record again, because the created topic is stored in the transaction that
  runs the `lift`s and the label of a position that the transaction in
  progress wrote has no identifier (P59). Two things would shorten it: the
  adapter knowing the identifier of a label that the transaction in progress
  stages, and boards written with a construct in place of the `lift`s over the
  whole list. The language has none of the three constructs: a per-element
  construct over a record, a join, and a grouping by a key.
- *Other edits that run a whole-list `lift`.* An edit of `mentions` or
  `shortName` of a topic runs `crossrefTable`, and `crossrefIndexOf` behind it
  where a row's `name` or the number of rows changed. On `sorted-references`
  an edit of `lastActivityAt` runs `topicsByActivity`. Not measured.
- *A change of the members of an array of row documents.* A prepend and a
  removal write the array of links whole, `N` links, because the executor
  gives the record of a change of the members of a kept `map` as one that
  names the array, and the runtime refuses a record that names a path the
  transaction did not write. The piece also compares the members of the array
  before and after a change by another writer, and the executor brings the
  keys of the assembly up to date. An append writes the number of members and
  one link. Most of the time of each is the write that causes the change, on
  either path.
- *The load.* It is one commit (the sixth finding), and its preparation is
  more than linear for the cause of the fifth finding: a profile of the load
  at 10,000 rows has 29.1 s of 43.2 s in `InputReadView.reads`, 23.2 s of them
  in `InputReadView.#stands`. Both the targets and the reads follow the rows:
  20,007 documents and more than 20,000 reads at 10,000 rows. A transaction
  that said whether its read activity changed since an ask, as a count that
  moves with each record added or reclassified, would make an ask cost nothing
  where it did not. That changes a file the specification correspondence
  governs and a path that runs with the option off, so it is not made on this
  branch (questions 347 and 351 of
  [compiled-pattern-language.md](compiled-pattern-language.md)).
- *The memory server's refresh of tracked queries* (the fourth finding). The
  piece's commit of two row documents adds to it, since each row holds a
  reference to its topic: 35 ms at the last of 2,000 topics.
- *The work after a refused commit* follows the size of the result, since the
  result document is stored again row by row.
- *The piece's own time in an edit on `sorted-references`* is 4.0 ms at 100
  topics and 11.2 ms at 2,000, and a write that the board does not read costs
  the piece 1.9 to 5.8 ms. The cause is not traced. On `filing-order` it is
  3.0 to 3.8 ms at each size.
- *A pull of the whole result* follows the board on both arms: 0.4 s, 4.5 s
  and 10 s at 100, 1,000 and 2,000 topics on the runner path.

**Over-labels found.** `runtime/runner/test/compiled/layout-labels.test.ts`
starts each list of `runner-lists.tsx` twice in one runtime, with rows as
documents and with rows in place, over items that each have a clause of their
own, and reads the root, the array, the number of members, each position and
each leaf of a row through a cell. What a read consumes is the join the
runtime derives from the reads of that transaction (`deriveFlowJoin`). After
the load, an edit, an addition at the end and a removal, rows as documents
give no clause less than rows in place at any of these, for a `map` over an
array declared as references, a `map` over an array of references declared as
plain values, a `map` over an array of plain values in place, and a `map` over
the result of a `filter` over an array of plain values in place. On Topics
boards of 4 topics, each with a clause of its own, 3,474 probes over the load,
three edits and three creates give the same in both layouts after the load and
after each create.

- *Rows in place, after an edit below `$UI`.* After each edit rows as
  documents give less than rows in place at 134 probes on `filing-order` and
  105 on `sorted-references`, all below `$UI`, and more at none. At each of
  them rows as documents give what both layouts gave after the load. An edit
  that writes below `$UI` in the result document removes the entries the
  document stored at `$UI` (`value`, with no clause) and at `$UI/children`
  (`enumerate`), and a read below `$UI` with no nearer entry then consumes the
  entry of the root, which holds every clause the load read. This is an
  over-label of rows in place, which is not the default layout.
- *A result that holds nothing but links, with rows as documents.* The result
  of `Cells` is the array of links alone. The runtime takes a written value
  that holds nothing but links for a structure of links and stores, for every
  child of its root, the join of the transaction that wrote it, so every read
  below the root consumes every clause, where rows in place give a leaf the
  clause of its member. With a plain value beside the array (`Counted` of
  `handle-reads.tsx`) a leaf of a row consumes the clause of its member alone.
- *The `value` slot the crate lists beside a handle.* For `crossrefTable` and
  `namesTable` the crate lists a `value` slot at `sources.*` beside the
  handle, from the helpers that test a member for presence. The body is handed
  a handle at each member, so the executor reads no member for that slot, and
  the slot stays in the template: the label of each row holds the label of a
  read of each topic whole. It is the crate's to narrow.

**Not verified.**

- A handler that the scheduler runs again after a conflict was not driven
  through the scheduler in a test: with the server's fan-out held, the
  scheduler's wait for the replica has no end.
- A refused commit of a transaction that created an instance is not tested.
- No figure is of two writers that share a space, of a memory server reached
  over a socket, or of an idle machine.
- The board `main` and the rows-in-place layout of the Topics boards were not
  measured after the second round, and today's arm was not run at 2,000
  topics.
- The comparison of what a read consumes in the two layouts is at 4 topics and
  on the four lists of `runner-lists.tsx`; it compares rows as documents with
  rows in place and not either with today's runtime.
- Which function copies frozen values in an edit, and how much, was not
  profiled apart after the second round.
- The document of a row that left is deleted in the transaction that removes
  its link. A reader that held the link then reads nothing; no test covers
  such a reader.
- An entry at the position of a link added at the end stays until the array is
  next written at or above it (P60); no test reads it after a later prepend.

**Not built.**

- *The load in bounded transactions.* The plan (provisional decision P63): the
  creation of the instance's own documents in a first transaction; each row
  that is a document of its own, with its records, in a transaction of at most
  `K` rows, where each record of the row has inputs with no position the first
  derivation staged; and the result document with the links, and everything
  else, in the transaction the caller commits. Open in the plan: a refusal of
  an earlier transaction has to refuse the caller's, and the rows a `lift`
  writes are given their records when the body has returned, so they stay in
  the last transaction, 2,000 documents at 2,000 topics.
- *No sync and no resume.* A document that is not in the replica when a
  reference leads to it reads as absent. A document in another space than the
  piece's is not told of changes. The result cell carries no mark of the
  pattern, and a piece is not started again from what it stored.
- *Readers outside the executor.* The runtime follows the link to a row that
  is a document. It does not follow a link whose path crosses an array by key,
  and it reads a state cell with no document as nothing. The harness compares
  the compiled result as the executor holds it.
- *The shell* does not render a compiled piece.
- *The corpus on the runner path.* No corpus module is started with
  `startCompiledPiece`, and no continuous-integration job builds the crate.
- *The rest of the design's scheduler and serving loop:* a scheduler node for
  each cone instance (P51), the stream document and its watermark (P52), an
  effect's request leaving the piece, and the withdrawal of one derived write,
  which belong to milestone 6.
- *The boundary of rows as documents emitted by the crate* (P54), the executor
  as a workspace package (P50), and the identifier of a label that the
  transaction in progress stages.
