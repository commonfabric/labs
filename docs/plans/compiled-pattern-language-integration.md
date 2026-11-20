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
   fails), and the decision of milestone 2.
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
   compared with today's from the same runtime. *Status:* built in the
   coordinating session on branch `claude/compiled-pattern-m4`, steps 1 to
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

The figures of this section are those of the seventh run over the corpus, at
commit `699ba789d2` of branch `claude/compiled-pattern-m4`.

**To read first.** Four results are serious. The first is unsound and open, and
the corpus does not show it.

1. *A `push` through a handle drops the label of what the list already holds.*
   The case is an array of plain values in place. After a `push` of a word of
   the event, a `push` of the labeled input `note` and a `push` of another word
   of the event, the list `["x","n","y"]` is stored under an empty label,
   although it holds the value of `note`. The adapter writes a spliced array
   whole (`RuntimeTransactions.change` of `compare/runtime-transactions.ts`),
   the write record of a `push` names the array's path, and the runtime stores
   the record's label in the class `value` at that path and clears the `value`
   entries below it. The template of a `push` holds the reference to the list
   and the pushed value, and nothing of what the list stored. The list therefore
   has the label of its last write alone. No scenario of the corpus sends such a
   sequence to a list, so neither the corpus run nor the check over the corpus
   shows it. A probe of the round with `soundnessOfScenario` reports 2 failures
   for these three events on the fixture `remove-shift.tsx`; no test of the
   branch at that commit states it. Two fixes were tried and withdrawn. The
   provisional decision P39 of the design's plan is the rule to build for it
   (open finding 1).
2. *The label rule of a removal through a handle, derived from the CFC
   specification, contradicts the owner's ruling as worded for one case.* For an
   array of references the derivation gives what the ruling says: no kept
   element is labeled again. For an array of plain values in place the
   specification puts what the removal's decision read on every position from
   the first removed one on, and the ruling says that the kept elements are not
   labeled again. The derivation, the three questions it leaves for the owner
   (questions 320 to 322 of the design's plan) and what limits an implementation
   today are in "The label rule of a removal" below (open finding 2).
3. *The work of one commit grows with the data.* The write records of one
   transaction held 127 MB for a list of 10,000 references. One fix brings them
   to 13 MB, and three costs that are linear in the number of elements remain.
   It is open finding 3, and question 318 of the design's plan.
4. *Storing a label for a write that leaves the value as it was costs commits
   and preparations.* The rule is the owner's ruling of 2026-11-20 and is built.
   Over the corpus with the option on, the commits rise from 2,643 to 2,902 and
   the preparations from 1,284 to 1,510. Five modules account for 240 of the 259
   added commits, and the cause there is not established (open finding 4).

The check of the stored labels against the values (below) finds no value over
the corpus that depends on an input and stores no clause of it: 0 in the 204
modules it checks. It found five of the defects listed under "Defects the check
found, fixed". The comparison beside today's rows could find none of them,
because it counts a label with fewer clauses as tighter.

**The check of stored labels against the values.** `compare/perturbation.ts`
runs a scenario on the executor in memory, twice as given and once more for each
labeled input with the value of that input alone changed (`perturbedRuns`). A
labeled input is a member of the argument that the scenario writes under a
schema with a clause, or the profile of the seeded home. `soundnessOf` in
`compare/stored-labels.ts` then takes each kept output and each target of a
write edge whose value differs between the run as given and the run with the
input changed, and requires that the confidentiality stored for it with the
option on, read with every link followed, holds the clauses of that input. The
check reads no write record, no slot binding and no template. The template
evaluator of the prototype reads the same slot bindings as the runtime, so it
cannot find a binding that leaves a read out; this check can.

Over the corpus it checks 204 of the 238 modules that run, in 860 runs in memory
that take 14.2 s together. It compares 5,791 pairs of a stored position and a
labeled input, and in 1,206 of them the value depends on the input. None of
those stores no clause of the input. `compare/test/stored-labels.test.ts` runs
the check on every fixture scenario and on the fixture of `wish`, and finds no
such value.

What the check does not establish:

- It is a lower bound. Each input is changed once, to one other value
  (`perturbed`), so a dependency that this one change does not exercise is not
  seen. A row that passes is not shown to be sound.
- It checks confidentiality, by the clauses of the inputs. It checks no
  integrity.
- It checks the kept outputs and the targets of write edges, and no other stored
  state.
- A scenario is a sequence of events that the corpus or a fixture gives. A
  defect that needs another sequence is not seen: the `push` defect of "To read
  first" needs an addition of a labeled value to a list followed by an addition
  of a value with no label, and no scenario has them.
- 34 of the 238 modules are not checked. 23 have a commit refused with the
  option on, so the storage holds the values of an earlier commit; what the
  check finds there is kept apart and not counted, 59 findings in 11 modules
  (`soundness-unstored.tsv` of the run's tables). In 7 modules two runs on one
  scenario give different values, and 4 read the clock.
- 6 inputs have no run of their own, because no value of their type differs from
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
  2026-11-20 a removal removes in place, and it is built: each removed position
  is one splice of the stored list (`Handle.#removeAt`), the executor writes no
  member that the list keeps, and a kept reference stays the reference it was,
  to a document the removal does not write. `Instance.readDeciding` binds the
  handle's slot, in the class `value`, to what the comparison with each member
  read, since which members the list keeps depends on it. The label that the
  write of a removal stores is as wide as before the change, and what it should
  be is "The label rule of a removal" below.
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

The first corpus run of the check found 6 values in 4 modules, the sixth run 3
in 1 module, and the seventh finds none.

**The cost that grows with the data.**
`dev/experimental/folksonomy-stress-test.tsx` holds a list of 10,000 references.
Measured there, with the option on:

- *Fixed: a hash per template node.* `instantiatePlanLabels` keys the memo of an
  `output` and of a `shared` label by the content hash of the inputs that the
  write record reports for the place, and formed that hash at every such node,
  80 times for a template with 40 `shared` nodes. In a profile of the module,
  `inputsKey` was 9.4 s of the 10.0 s of the pre-pass. The key is formed once
  per object (`inputsKey` and `writeKey` of `plan-labels.ts`), and the counter
  `planInputKeys` of the runtime's CFC statistics counts the keys formed.
- *Fixed in part: one chain per element in every record.* A slot whose read
  follows the links that a value holds reported one chain per position reached,
  so a read of the array of 10,000 references listed 10,000 chains per slot, in
  every write record whose template reaches the slot. One transaction recorded
  13 write records of 126.8 MB together. `Instance.#distinctByLabel` reports one
  chain for each set of chains whose positions hold equal label identifiers
  (`TransactionHooks.labelOf`; provisional decision P31), and the same
  transaction records 13.0 MB. The identifiers compared are those of the
  observations the runtime makes at each position (`Instance.#labelKey`), so a
  position that holds a link has two.
- *Open: the executor walks every position* that the read reached to find its
  label identifier, so the work is linear in the elements where the record no
  longer is.
- *Open: a slot of the class `identity` keeps every position in its one chain.*
  One such chain of the module holds 20,001 positions and 1.4 MB, in each record
  whose template reaches the slot.
- *Open: a write of many elements gives a write record per element.* One
  transaction of the module, which writes 10,000 elements, records 10,007 write
  records of 11.9 MB together.

The 12 preparations of the module took about 7,700 ms in the fifth run, 941 ms
in the sixth and 1,221 ms in the seventh, which ran under a higher load; that is
46% of the preparation time of the whole corpus with the option on. The size of
the records was measured at the sixth run and not again. The three open costs
are linear in the number of elements, for an array of references; an array of
plain values in place and the result of another per-element construct were not
measured. How a write record is bounded is question 318 of the design's plan.

**What is built.** On branch `claude/compiled-pattern-m4`, behind the
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

- **The atom of a kept output at a link.** A covered path at which the
  transaction wrote a link stores its label on a pointer-class entry at
  that position, as `plan-and-label-templates.md` §3.2 has it ("Where the
  atom of a kept output is stored"). A reader of the reference takes the
  entry, and a read through the link takes the integrity of the target
  alone. Where the links of an array's elements have equal labels, one
  pointer-class entry at the array's `*` path is stored and an element
  whose label equals it stores none. With one entry per link, the kept
  result of a `filter` over an array of references stored 137 entries at
  200 elements and 17 at 20.
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
  them. A commit that changes the label at a path runs a reader of the value
  again and conflicts with a transaction that read the value before, which a
  write of an equal value did not. A commit that would store the label the path
  holds already writes nothing, runs no reader and conflicts with nothing. The
  tests of `runtime/runner/test/cfc-plan-labels.test.ts` ("for a write that left
  the value as it was") state each.
- **The labels of the kept outputs are formed again after a label changed
  alone.** An output computed from a value whose label changed without its value
  is not evaluated again, so its stored label would lack the new clause. After a
  commit changed labels through a record of an unchanged write, the adapter
  tells the executor (`watchLabels`, with `alone`), and the executor gives the
  records of the kept outputs again in a derivation transaction of its own, as
  those of writes that leave the values as they are (`Instance.#relabel`). The
  executor keeps no record of which outputs read which label, so the work is the
  number of kept outputs, each element of a per-element output counted, over an
  array of references, over an array of plain values in place and over the
  result of another per-element construct alike. An output with a kept output
  below its path is left out, because the runtime stores a record's label for
  its path and clears what is stored below it, and an output below that the plan
  has no template for has no record to store its label again.
- **A removal through a handle removes in place** ("Defects the check found,
  fixed" above, and "The label rule of a removal" below).
- **The budget of pending-specification markers is 80,** by the owner's ruling
  of 2026-11-20 (`SPEC_PENDING_BUDGET` of `tasks/check-cfc-correspondence.ts`).
  The governed files hold 41 markers at commit `699ba789d2`, of which 20 are in
  `prepare.ts` and 7 in `plan-labels.ts`.

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
  stands at another position: the path was overwritten, and its `value` label is
  the element's own label joined with D. A static read of a position consumes
  nothing of the list's enumeration, so D has to be at the position: after
  `words.removeByValue(secret)` over `["a", "b"]`, a read of `words[0]` gives
  `"a"` or `"b"` by whether `secret` equals `"a"`. **This contradicts the ruling
  as worded,** which says that the kept elements are not labeled again with what
  the removal read, and which names the write of `footprint-analysis.md` §6.1,
  the container's enumeration alone.
- *The result of another per-element construct* (`map`, `filter`, `flatMap`) has
  no handle a body can remove through. A removal from its source is one of the
  two cases above, and the derived collection follows from its membership
  template: the elements that remain keep their keys, their state and their
  labels, and none is evaluated again for the removal.

The derivation leaves three questions for the owner: whether the positions from
the first removed one on take D over an array of plain values in place (question
320 of the design's plan, with three alternatives), whether a kept element that
moves keeps its integrity (question 321), and whether a removal that finds
nothing writes the enumeration (question 322). The provisional decision P39 of
that plan, which is the coordinator's and no owner ruling, takes the first
alternative of question 320: each position from the first removed one on stores
its own label joined with D.

What limits an implementation today, measured on `remove-shift.tsx` and two
fixtures of the round:

- *The adapter writes a spliced array whole,* so every list that a handler adds
  to or removes from has one `value` label, that of its last write. For a
  removal that label is D as the executor computes it. Over an array of plain
  values in place the kept elements are covered by D and not by labels of their
  own. Over an array of references the executor's comparison reads the whole
  list with `get`, so D also holds the values of the targets, which is wider
  than the rule.
- *The runtime has no enumeration entry for a list of plain values in place.* It
  stamps `enumerate` entries on containers of links alone (`structureStampPaths`
  of `runtime/runner/src/cfc/prepare.ts`). A count or an enumeration of a list
  of plain values in place reads the `shape` entry of the list and, through the
  path below it, the list's `value` entry. A rule that puts what a decision read
  on the enumeration therefore has no entry to store it in for this case.
- *Two fixes of the `push` defect were withdrawn.* A record per pushed position
  keeps the labels of the elements apart and removes the defect, and then the
  count of the list no longer holds what decided the addition (1 failure of the
  check on the round's fixture `count-after-change.tsx`, 0 before). Joining the
  stored label of the list into the write reads the list recursively, and where
  an element's type declares a clause on a member the label at the list's path
  then holds that clause and the write is refused as a writer-fit misfit.
- *Seen in today's runtime:* after a whole-array write that shortens an array, a
  `shape` entry stays at a position that no longer exists. That is wider than
  the rule as long as a later creation of the position mints the entry again,
  which was not verified.

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
included. Of 271 modules attempted 238 run. 16 request an effect. 12 runs fail
at a commit that CFC enforcement refuses as not prepared: 6 for a missing
trusted-event policy, 3 for `writeAuthorizedBy`, 2 for `maxConfidentiality` and
1 for `writePolicyAnyOf`. 1 needs a `wish` that is not simulated
(`#summaryIndex`), 1 has no value code, and 3 comparisons fail: on the built-ins
`spaceDeleted` and `linksOf` in a function body, and on an element construct
that has no function. Beside today's rows:

| | Equal | Tighter | Looser | Other |
| --- | ---: | ---: | ---: | --- |
| 1,695 output rows | 288 | 1,013 | 118 | 263 whose atom names the pattern, 13 incomparable |
| 199 write rows | 129 | 10 | 57 | 3 incomparable |

45 of today's rows have no stored write and 4 no stored output to compare. The
175 looser rows, by the cause the run's classification gives each:

| Cause | Rows |
| --- | ---: |
| The module has commits refused with the option on, so the storage holds the labels of an earlier commit (open finding 7) | 59 |
| Confidentiality: the module used the bound of a selection, a pick or a fold (open finding 8) | 46 |
| Integrity alone: a handler write whose template, the `derive` of its body, has inputs with no label mints no atom (`plan-and-label-templates.md` §3.2), where today stamps `TransformedBy` of the handler from a transaction join that is not empty | 42 |
| Confidentiality looser with no bound used and no refused commit: 5 rows of `product/primitives/counter.tsx`, 3 of `dev/gideon-tests/test-cross-piece-client.tsx`, and 4 where today's label holds no clause; none attributed (open finding 9) | 12 |
| Integrity alone: other atoms that today has and the template lacks | 8 |
| Integrity alone: a kept output whose atom is on the link's entry, which a read of the value through the link does not take, and whose target holds none (open finding 10) | 5 |
| Confidentiality: the clause is stored at an ancestor path written whole, 3 rows of `product/primitives/counter.tsx` | 3 |

30 rows are looser that were not looser in the sixth run: 19 output rows that
were tighter, 9 whose atom named the pattern, and 2 write rows that had no
stored write to compare. All 30 are in 5 modules that record writes that left
the value as it was (`apps/base/person.tsx`, `apps/base/family-member.tsx`,
`product/collection-naming/item.tsx`, `product/primitives/counter.tsx` and
`apps/cozy-poll/main.tsx`; the 2 write rows are `updateTags` of the first two).
28 are looser in confidentiality and the 2 write rows in integrity alone. The
attribution is that the stored label holds a clause of what a run read where
today's label, by today's rule, lacks it; the rows were not inspected one by
one, so that is not established for each. 18 of them are counted under the bound
in the table, because their modules also used one, 2 under a refused commit, and
the 8 of `product/primitives/counter.tsx` under the two causes that name it.

The rows looser than today's are not all attributed, and "tighter" is not
evidence of correctness (open finding 5), so the corpus does not show that the
labels from templates are equal to or tighter than today's outside the
deliberate exceptions. A label stored for a write that leaves the value as it
was is such an exception: there the label is wider than today's by rule.

Over the 20 modules that call `wish` and run, 25 rows are looser, in 6 modules.
With the outcome of each `wish` under its own record and the comparison reading
user-scoped links, 19 of those modules, run alone at the commit of that change,
went from 26 looser rows to 11.

Of 4,383 write records checked against the template evaluator of the prototype,
3,801 agree. For 448 records in 8 modules no entry is stored at the record's
path, where the evaluator gives a label: 416 of them are in the five modules of
`examples/cfc-trusted-component-examples`, 26 in `apps/cozy-poll/main.tsx`, 5 in
`dev/catalog/stories/kitchen-sink-story.tsx` and 1 in
`apps/work-snapshot/main.tsx`. The sixth run had no such record; the cause is
not examined (open finding 6). 125 were not evaluated, for dynamic reads that
the record does not report. 6 records in 3 modules are equal in confidentiality
and tighter in integrity than the evaluator's label, which is a bound there. 2
records in 2 modules are equal in confidentiality and tighter in integrity, and
1, in `examples/scoped-user-directory/main.tsx`, is looser in confidentiality
than the evaluator's label.

With the option on and not off, 38 commits in 24 modules are refused: 17 in 14
modules for a slot bound to an empty chain, 16 in 9 modules for a slot with no
binding, 3 in 2 modules for a pick whose choice was not reported and that
chooses from no collection, 1 for a collection with no elements reported, and 1
because the preparation crashed:
`dev/nested-map-ifelse-test/nested-map-ifelse-test.tsx`, with "type changed
incompatibly" from an object to an array at the root of a document, which is no
refusal by a rule. `apps/topic-workbench/main.tsx` has 1 refused commit where it
had 4. No run stopped after a refusal.

Over the 238 modules the option off made 2,695 commits and 652 preparations in
373 ms, and the option on 2,902 commits and 1,510 preparations in 2,639 ms, of
which `dev/experimental/folksonomy-stress-test.tsx` accounts for 1,221 ms (open
finding 3). The machine was under load during the run (load averages between 7
and 12), so the times are an upper bound and not a measurement of the cost. With
the option on the runtime took a bound 342 times, in 53 modules.

**The cost of a label for a write that leaves the value as it was.** With the
option on, 900 write records in 21 modules are those of a write that left the
value as it was, and the commits that recorded them changed 1,385 label entries.
Against the sixth run, which gave no record for such a write, the option on
makes 259 more commits, 226 more preparations and 527 ms more preparation time
under a higher load; the option off is unchanged. 14 modules make more commits
and 2 fewer. The five modules of `examples/cfc-trusted-component-examples`
account for 240 of the added commits, 208 of the added preparations and 661 of
the 900 records; `main.tsx` alone makes 120 more commits. Why these modules
commit so much more is not established. Two mechanisms add commits by
construction: a derivation transaction that gives the records of every kept
output again after a label changed alone, and a reader that runs again because
the label it consumed changed.

Today's runtime committed 1,882 transactions to its storage from the start of
the instances until every kept output was read, 1,796 from the first event on,
and 374 before the start, which is the compile cache; none was reverted. The
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

**Open findings,** most serious first.

1. *A `push` through a handle drops the label of what the list already holds,
   over an array of plain values in place.* Unsound. The list has one `value`
   label, that of its last write, because the adapter writes a spliced array
   whole and the template of a `push` holds nothing of what the list stored ("To
   read first", 1). The same holds for `pushAll` and `addUnique`, by the same
   write; that was not measured. No corpus scenario shows it. Two fixes were
   withdrawn ("The label rule of a removal", what limits an implementation). The
   rule to build is the provisional decision P39 of the design's plan: an
   enumeration entry at the list's path that an addition or a removal replaces
   with the stored enumeration joined with what decided the change, and an added
   element recorded at its own position. It needs a change of
   `runtime/runner/src/cfc/prepare.ts`, which stamps no enumeration entry on a
   list of plain values in place. Question 323 of the design's plan.
2. *The label of a removal through a handle is not the derived rule.* The
   executor removes in place. The list still has one `value` label, which for a
   removal is what its decision read: over an array of plain values in place the
   kept elements before the first removed position are covered by it although
   the rule leaves them alone, and over an array of references it also holds the
   values of the targets, because the comparison reads the whole list with
   `get`. The derived rule contradicts the owner's ruling as worded for an array
   of plain values in place ("The label rule of a removal"). Questions 320 to
   322 of the design's plan are for the owner; P39 is what is built next.
3. *Write records, and the work on them, grow with the data* ("The cost that
   grows with the data", above). Three costs are linear in the number of
   elements: the walk of every position for its label identifier, the one chain
   of an `identity` slot that holds every position, and one write record per
   element of a write of many elements. The preparations of
   `dev/experimental/folksonomy-stress-test.tsx` take 102 ms each, against under
   1 ms each over the rest of the corpus. Question 318 of the design's plan.
4. *The cost of a label for a write that leaves the value as it was* ("The cost
   of a label for a write that leaves the value as it was", above). 259 more
   commits and 226 more preparations over the corpus, 240 and 208 of them in
   five modules, cause not established. After a label changed alone the executor
   gives the records of every kept output again, and not those of the outputs
   that read the label, so that work grows with the number of kept outputs.
   `scheduler-and-serving-loop.md` §3.6 has the rule that limits it to the
   outputs whose template reaches the changed slot. Question 324 of the design's
   plan.
5. *The check against the values is a lower bound, and "tighter" in the
   comparison is not evidence of correctness.* A row counts as tighter where the
   stored label has fewer clauses than today's, and a binding that leaves out a
   read has exactly that effect. The check changes each input once, covers
   confidentiality alone, runs the scenarios it is given, and leaves 34 modules
   out, 23 of them for a refused commit, where it finds 59 values in 11 modules
   that are not counted because the storage there holds an earlier commit. Those
   59 are not examined. Finding 1 is a defect that the check passes over the
   whole corpus.
6. *448 write records have no entry stored at their path.* The comparison with
   the template evaluator finds, in 8 modules, records whose path stores no
   label entry where the evaluator gives a label; the sixth run had none. 416
   are in the five modules of `examples/cfc-trusted-component-examples`, which
   are also the modules of finding 4. Whether an entry stored further up covers
   the path, or a label is missing, is not examined, and the check against the
   values reports no failure in these modules.
7. *Refusals that remain.* The 38 commits in 24 modules refused with the option
   on and not off, with the reasons above. One of them is a crash of the
   preparation and no refusal by a rule
   (`dev/nested-map-ifelse-test/nested-map-ifelse-test.tsx`), new in the seventh
   run and not examined. A module with a refused commit holds the labels of an
   earlier commit, which accounts for 59 of the looser rows.
8. *The bounds.* The runtime took a bound 342 times, because the value code or
   the runtime does not report a selection, a choice or the addresses of a
   dynamic read: picks through `.key(k)`; the `through` position of a scan; the
   choice of `find`; the `select` over the keys of a record constructed in
   place; the optional members of a spread; and dynamic reads of kind `link`
   through a selected reference. `plan-and-label-templates.md` §4.2 has, for
   each, who knows the answer, what is reported and where it is kept, and the
   provisional decision P37 for the groups of a scan's prefix. 46 of the looser
   rows are in modules that used a bound.
9. *Looser rows that are not attributed.* 12 rows are looser in confidentiality
   with no bound used and no refused commit. Today's label holds no clause at 4
   of them where the template's holds one: one row each of
   `dev/scope-bug-ct1597-reduce/main.tsx` and
   `dev/test/non-idempotent/accumulator.tsx`, and two of
   `showcase/battleship/multiplayer/room.tsx`. Why today's label is empty there
   is not established: either today's runtime stores too narrow a label, or the
   comparison reads the wrong position on today's side. None was reproduced in a
   test outside the corpus run, so none is a finding against the runtime yet. 3
   are in `dev/gideon-tests/test-cross-piece-client.tsx`, and 5 in
   `product/primitives/counter.tsx`, which are among the 30 rows that became
   looser with the label of an unchanged write and were not inspected one by
   one.
10. *The atom on a link is not taken by a read of the value through the link.* A
    kept output that passes a value on by reference stores its atom on the
    link's entry. A reader that reads the target's content through the link
    takes the integrity of the target alone, so it does not see the atom, and 5
    rows are looser in integrity for it. Joining the atom onto the target's
    content was not built: section 3.7.2 of the specification's core concepts
    chapter (`03-core-concepts.md`) scopes the endorsement of a link to the
    selection, and an atom with no scope joined onto the content would claim
    that the pattern vouches for a value it only chose. Whether the atom on a
    link is a selection endorsement with a scope, taken when the link is
    traversed, is question 313 of the design's plan, for the owner.
11. *A declared integrity that the crate emits as text.* The rows of
    `examples/cfc-authorship-chat` differ from today's by the atom
    `authored-by`. The schema the crate emits for its cells holds the declared
    integrity as the text of its type, `ifc.integrity: { "$source": "readonly
    [AuthorshipIntegrity<IntegrityAuthor>]" }`, which the runtime refuses as
    malformed integrity. A cell with such a schema gets no document at the start
    and stores no declared label.
12. *Seen in today's runtime, by reading and not measured:*
    `contractCandidatesForWrite` of `runtime/runner/src/cfc/ui-contract.ts`
    scans every write-policy input of the transaction for each write of an
    event's transaction (`recordTrustedEventPolicyInputs`), so its work is the
    product of the two counts. With one write-policy input per write record, a
    write of 10,000 elements makes both counts grow with the elements.

Steps 11 and 12 of the milestone's plan, instantiation keys and verified
units in the prepared digest and a derived write dropped alone, are not
built.
