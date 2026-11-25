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
through its ninth corpus run, and the catch-up merge with `main`; and #10016,
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

The figures of this section are those of the ninth run over the corpus, at
commit `20c44beec5`, which the integration branch holds. The run is on the
source of `main` as it was before the catch-up merge. The corpus of current
`main` is in "The catch-up merge with `main`" below.

**To read first.** The open soundness findings come first, then the regression
of cost, which is serious, then what is fixed, then the rest. Whenever a list is
named, the case is named with it: an array of references, an array of plain
values in place, or the result of another per-element construct.

*Unsound and open.* The check of the stored labels against the values ("The
check of stored labels against the values" below) reports 4 values in 2 modules
that depend on an input and store no clause of it when every event of a scenario
is sent three times, and 1 of the 4 on each scenario as given.

1. *Three outputs of `examples/todo-list/todo-list.tsx`, at position 0 of the
   result of another per-element construct.* The output `mentionable` is the
   result of a `map` over the array that a `computed` returns, which holds the
   records of the input `items` that are not done. At position 0, `$NAME`,
   `summary` and a prop of the rendered tree differ between the run as given and
   the run with `items` changed, and store no confidentiality. The check with
   events sent three times reports them at its event 1; the check on the
   scenario as given reports none. They are not examined. The commit that ends
   the round says that the module has no finding, and the tables of the run have
   these 3 (open finding 1).
2. *One write of `showcase/card-piles/main.tsx`, at a position of an array of
   plain values in place.* The handler `moveToPile` removes a card from one list
   with `remove` and adds it to the other with `push`. The write of record
   `{"body":1,"write":2}` at position 3 depends on the input `pile2` and stores
   the clause of `pile1` alone. Both runs of the check report it. It is not
   examined (open finding 1).
3. *A removal's `*` entry is replaced by a more specific entry of origin
   `structure`.* What decided a removal is stored once for the list, as entries
   of origin `structure` at the list's `*` path. `resolvedEntryGroups` of
   `runtime/runner/src/cfc/consumed-label.ts` resolves the classes `value` and
   `followRef` of that origin by the longest prefix, so a concrete `structure`
   entry of the class `followRef` at a slot, the stamp that a recorded link
   write mints, replaces the `*` entry for that slot, and a read there does not
   consume what decided the removal. The case is an array of references. It is
   not fixed and has no test: the comparison adapter records no link write, so
   no run produces the pair. The fix changes the resolution with the option off
   and needs the specification sentence first (open finding 2).
4. *A handler that writes nothing under a condition on a labeled input stores
   nothing.* In `examples/map-demo/map-demo.tsx`, `initHandler` writes nothing
   where `initialized` is true, so no label says that the paths it could have
   written depend on `initialized`: 16 values, of the outputs `stops` and
   `areasOfInterest`, of the view, and of later writes into those lists. The
   check finds them only when events are generated for the module. The scenario
   of the corpus run sends none, so the tables of the run do not hold them, and
   the module has no finding in the run. By the owner's ruling of 2026-11-20
   (Z77 of the design's plan) this is a channel of the specification's write
   gate proposal, a label change that a write under a secret causes, and it is
   recorded and not fixed: "assume the proposal or something equivalent
   eventually lands and so don't worry about the potential for leaks now, but
   still make sure things are sound in terms of just correctly computing the
   labels under that relaxed condition" (open finding 3).

*Cost: a regression, serious and open.*

5. *The cost of the labels rose against the eighth run,* over the same 238
   modules, with the option on:

   | | Eighth run | Ninth run |
   | --- | ---: | ---: |
   | Preparation time | 2,176 ms | 9,250 ms |
   | Bounds taken | 499, in 53 modules | 1,762, in 70 modules |
   | Records of writes that left the value as it was | 756 | 2,297 |
   | Label entries those records changed | 3,625 | 22,625 |
   | Write records checked against the evaluator | 4,271 | 9,039 |
   | Commits refused with the option on and not off | 44, in 24 modules | 55, in 23 modules |
   | Time of the whole run | 10 minutes | 22 minutes |

   Three modules account for 6,744 ms of the preparation time:
   `examples/cfc-trusted-component-examples/main.tsx` takes 3,453 ms where it
   took 189 ms, `send-publish-examples.tsx` of the same directory 1,464 ms, and
   `dev/experimental/folksonomy-stress-test.tsx` 1,828 ms where it took 942 ms.
   The regression is not attributed by measurement. By reading, the fixes of the
   round are its source: each element entry of the result of a per-element
   construct held below a kept output has a record of its own; a kept output
   with no template, an element entry with a slot that has no stored position,
   and a member change under an envelope are given as bound and take the
   transaction's join; and an evaluation that gives the value an output already
   holds is reported as a write that left the value as it was. The machine was
   under load during the run (load averages between 9 and 11), so the times are
   an upper bound (open finding 4).
6. *The executor's memory on `dev/experimental/folksonomy-stress-test.tsx` is
   not fixed.* A process that held the runs in memory beside the run in storage
   ran out of memory at a heap of 4 GB. The cause is not found (open finding 5).

*Fixed in this run.* Each of 7 to 9 stored a label without a clause of what the
value was computed from, and each has a test.

7. *A value that the result holds in place took a label narrower than what it
   holds,* the cause of the 10 values of `examples/map-demo/map-demo.tsx` and
   the 1 of `apps/base/person.tsx` that the eighth run left untriaged:
   - *the rows of a view,* which are the result of a `map` held in place under a
     kept output whose template names another output, had one record for
     everything below, with the label of the collection's membership. Each entry
     of the construct's elements is recorded at its path below the kept output;
   - *a kept output that the plan has no template for* had no record and took
     the label of the kept output above it. It has a record, and the runtime
     gives it the transaction's join. 25 kept outputs in 13 modules of the
     corpus have no template;
   - *the value of a cell stored in place as a branch of a `select`,* as
     `cell.get() ?? fallback` gives it, kept its slot in the class `identity`.
     It is bound in the class `value`, with a chain for each link the value
     holds;
   - *an evaluation that gives the value an output already holds* stored no
     label, though what its inputs hold can be other positions than before. It
     is reported as a write that left the value as it was, and its label alone
     is formed again in the same transaction.
8. *Three reads consumed nothing of what decided the members of a list.* A read
   of a position that holds no member consumes the list's membership, over an
   array of plain values in place and over an array of references (open finding
   2 of the eighth run). An array inside a value written whole takes the label
   of the write as its `enumerate` entry (open finding 3 of the eighth run). And
   after `key(i).set(undefined)` the position stored no label; a write that
   leaves a path holding nothing stores its label at the path.
9. *A member change under an envelope had no record.* `key(n).set(value)` behind
   the last member of a list is a write that the plan bounds with an envelope
   and has no write edge for, so the position and the number of members took the
   join and the list's `enumerate` entry stayed as it was. The executor gives
   the records of the member change, with no inputs and marked as bound.
10. *A `flatMap` over an array of references refused every commit,* for two
    unbound slots: the source of the collection's membership before its first
    element, and the element that each member of the result came from. Both are
    bound. This was a refusal and no label that was too narrow.
11. *The position of an added member holds nothing of the list's membership,* by
    the owner's ruling on an append (Z74 of the design's plan), and the check
    has a criterion for a member that additions alone placed at another index
    ("The same check with every event sent three times" below). The 16 values of
    `examples/todo-list/todo-list.tsx` that the eighth run reported at the
    positions 1 to 4 of `mentionable` are no failure by that criterion. Its
    residue: all 16, and 1 write of `showcase/card-piles/main.tsx`, were
    appended after another change of the list, which the check reports apart and
    does not show to be sound (open finding 6). A `push` under a condition that
    a labeled input decides is confirmed by a fixture,
    `compare/fixtures/push-under-condition.tsx`: both additions of one handler,
    the first under the condition, store the input's clause, because the write
    edge has one template over everything the body reads.
12. *The atom of a kept output that holds a link is stored in one place,* by the
    owner's ruling of 2026-11-20 (Z81 of the design's plan): on the content, in
    the `value` entry at the output's path, whether the document that holds the
    link is written whole or the path alone. A read through the link takes it.
    74 output rows that were equal to today's are tighter, 52 of them in
    `examples/cfc-spec-gallery/main.tsx`.
13. *The slow events of `dev/experimental/folksonomy-stress-test.tsx` had one
    cause,* in the executor and not in the labels: `Store.changedSince` of
    `exec/store.ts` compared every change made since an evaluation with every
    position the entry read. The events 14 to 16 of the run with generated
    events take 414, 3 and 53 ms where they took 4,119, 3,720 and 14,945 ms
    ("The cost that grows with the data" below).

*The rest.*

14. *Collections with many members.* The analysis of the class that
    `dev/experimental/folksonomy-stress-test.tsx` is in gives three changes of
    representation that leave every stored label as it is, and the owner ruled
    on 2026-11-20 that they are built (Z75 of the design's plan). They are being
    built; no result exists ("The cost that grows with the data" below).
15. *The catch-up merge with `main` is made,* with the executor's record of a
    splice winning over the alignment by value, by the owner's ruling (Z76). Two
    of its interactions have no test, and no corpus run exists with the code of
    this run on the source of current `main` ("The catch-up merge with `main`"
    below).
16. *The labels formed again after a label changed alone are still found by
    position and not by class* (open finding 8).
17. *The label for a write that leaves the value as it was* costs 21 more
    commits with the option on than with it off, 2,720 against 2,699, where the
    eighth run had 61 more, and 775 more preparations, since every commit of a
    compiled pattern is prepared.

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
option on, read with every link followed, holds the clauses of that input. The
check reads no write record, no slot binding and no template. The template
evaluator of the prototype reads the same slot bindings as the runtime, so it
cannot find a binding that leaves a read out; this check can.

Over the corpus, with each scenario as given, it checks 206 of the 238 modules
that run, in 862 runs in memory that take 19.8 s together. It compares 6,021
pairs of a stored position and a labeled input, and in 1,271 of them the value
depends on the input. One of those stores no clause of the input: the write of
`showcase/card-piles/main.tsx` ("To read first", 2).
`compare/test/stored-labels.test.ts` runs the check on every fixture scenario
and on the fixture of `wish`.
**The same check with every event sent three times.** A scenario of the corpus
sends each handler few events, so a defect that needs a handler to run again on
what an earlier run stored is not seen. `repeatedEvents` of
`compare/perturbation.ts` gives the events of a scenario three times over: in
the reverse of the order given, then in the order given with each value changed,
then in the reverse order with the value changed again. A module with handlers
whose scenario committed no event in today's run gets one generated event for
each binding, sent three times over; 11 modules of the corpus are checked that
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
it reads positions of stored arrays.

Over the corpus the check with events sent three times covers 99 modules, in 779
runs in memory that take 169 s together, and compares 5,067 pairs, of which 908
have a value that depends on the input. It finds 4 values in 2 modules that
store no clause of the input: 3 in `examples/todo-list/todo-list.tsx` and 1 in
`showcase/card-piles/main.tsx` ("To read first", 1 and 2). It excuses 17
positions in 2 modules by the criterion above, 16 in
`examples/todo-list/todo-list.tsx` at the positions 1 to 4 of `mentionable` and
1 write of `showcase/card-piles/main.tsx`, and all 17 are flagged as appended
after another change of the list. So no excused position of the corpus is a case
of additions alone, and the 17 are not shown to be sound. What the check covers
and what it does not:

- 139 of the 238 modules are not checked this way. 17 have a commit refused with
  the option on; what the check finds there is kept apart and not counted, 50
  findings in 7 modules (`soundness-repeated-unstored.tsv` of the run's tables).
  In 12 modules two runs on one scenario give different values, and 3 read the
  clock. 2 runs stop at a write that fails with "expected object but found
  array" (`examples/scoped-group-chat/main-plain-inputs.tsx` is one), and 1
  stops because its result exceeds 250,000 characters
  (`dev/experimental/folksonomy-stress-test.tsx`). The others have no event to
  send and no handler to generate one for.
- 13 inputs have no run of their own: for 9 an event went to an element that the
  run does not hold, and for 4 no value of the type differs from the one the
  scenario gives.
- It does not reach a branch that one particular value of an input decides. A
  handler that tests `note === "n"` takes that branch only where the scenario
  gives `"n"`, and a changed value does not.
- A scenario whose result exceeds 250,000 characters of text is stopped
  (`REPEATED_RESULT_LIMIT`). Where the checks after every event would compare
  more than 20,000 pairs or read more than 2,000,000 characters of results, the
  check runs after the first event and after the last event of each third of the
  events, and after no other (`STEPPED_PAIRS` and `STEPPED_SIZE`).
- In 4 modules the run with the events sent three times has a commit refused for
  a reason that the run of the scenario as given did not have: an unsupported
  claim `writeAuthorizedBy` in `dev/test/cfc-trusted-write/frozen.tsx` and
  `main.tsx` of the same directory, and a writer-fit misfit of confidentiality
  in `examples/profile-group-chat/main.tsx` and
  `examples/profile-roster-live-demo/profile-roster-live-demo.tsx`.
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
- A scenario is a sequence of events that the corpus or a fixture gives. A
  defect that needs another sequence is not seen by the run of the scenario as
  given: a `push` that lost what an earlier `push` decided needs an addition of
  a labeled value to a list followed by an addition of a value with no label,
  and no scenario has them. The run with every event sent three times, above, is
  made for that.
- 32 of the 238 modules are not checked. 22 have a commit refused with the
  option on, so the storage holds the values of an earlier commit; what the
  check finds there is kept apart and not counted, 60 findings in 12 modules
  (`soundness-unstored.tsv` of the run's tables). In 6 modules two runs on one
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

- *A value that the result holds in place,* in the four cases of "To read
  first", 7. `Instance.#storedInPlace` of `exec/executor.ts` covers the value of
  a cell given by a `select`. Tests: the fixture
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
- *A write of `undefined` at a position,* and *a member change under an
  envelope* ("To read first", 8 and 9). The fixture
  `compare/fixtures/member-edges.tsx`, a list of plain values in place, also
  verifies a removal and an addition in one transaction that leaves a member at
  the position another stood at: the stored labels follow the members, and
  nothing had to change.
- *The record of the result of a `flatMap`* binds the source of its membership
  and the element each member came from ("To read first", 10). The fixture
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

The check on each scenario as given found 6 values in 4 modules at its first
corpus run, 3 in 1 module at the sixth, none at the seventh and the eighth, and
1 in 1 module at the ninth. The check with every event sent three times found 27
in 3 modules at the eighth run, where it was new, and finds 4 in 2 modules at
the ninth.
**The cost that grows with the data.**
`dev/experimental/folksonomy-stress-test.tsx` holds a list of 10,000 references,
and with the option on its write records, the work on them, and the executor's
work grow with the list. The design's answer is `plan-and-label-templates.md`
§4.7 ("Collections with many members"), and this part has what was measured and
what is built of it.

*The class.* A plan and its data are in the class where some structure is sized
by the positions that a read or a write covers, and the label needs only the
distinct labels among them. In the module every member of the list has the same
label, and no output observes a difference between two members: each derived
output is the result of a `computed` that reads the whole list, or of a `map`
over such a result, so its label is the join over all members and the
membership. What grows there is the representation and no label. Measured at the
eighth run, for an array of references:

- *The inputs of a named output are copied into every record that names it,*
  once per path by which the record reaches it. One transaction of the module
  recorded 13 write records of 12,981,878 bytes, of which 1,446,001 bytes hold
  the same content when each distinct set of inputs is written once. The factor
  exists with small data as well: 20.6 in one transaction of
  `apps/person-workbench/main.tsx`, 11.8 in
  `dev/factory-outputs/lot-with-coordinator-demo/main.tsx`, 8.6 in
  `apps/topic-workbench/main.tsx`, and 3 or more in 14 of 276 corpus modules.
- *A read of a whole collection is reported position by position.* A slot whose
  read follows the links of an array lists one chain per distinct label
  (`Instance.#distinctByLabel`; provisional decision P31), but only after the
  executor asked for the label identifier of every position. A slot of the class
  `identity` is not reduced: one chain of 20,001 positions and 1.4 MB, in each
  record whose template reaches the slot.
- *A write of a whole collection is reported record by record.* A write of
  10,000 members gives 10,007 write records of 11,908,330 bytes together, of
  which 7 have distinct inputs.

*A stored label does not change because a collection crossed a size,* by the
owner's ruling of 2026-11-20 (Z78 of the design's plan). A coarser label chosen
by a size is sound as a label and is a channel as a flow: a handler that appends
a member under a secret moves the list over the size, the labels of the other
members rise, and a reader learns the secret from whether a member it could read
is still readable. `plan-and-label-templates.md` §4.7 has the argument. So the
cost is lowered by the representation and by what an author declares, and by
nothing that depends on a size.

*Adopted and being built: three changes of representation,* by the owner's
ruling of 2026-11-20 (Z75; the owner's words: "Yes, build them"). Each leaves
every stored label as it is. (a) One table of inputs per transaction, which the
records name by index. (b) One record with a `*` target for equal writes into
one container. (c) Groups with counts for any read that covers a whole
container, the one chain of an `identity` slot included, kept in memory with the
collection (Z85). They are being built behind `compiledPatterns`, after this
run, and no figure exists for them as built. Estimated by encoding the records
of the two transactions above again: 11.9 MB and 13.0 MB become about 4 KB and
6.5 KB. That the stored labels are byte-equal before and after is argued and not
shown; the corpus run with the changes is the check (question 338 of the
design's plan).

*Where the members have labels of their own,* the label of anything computed
from the whole collection has as many clauses as the collection has members, and
today's runtime stores the same label. Measured on a constructed case, a
`filter` over an array of references with one member changed, single runs:

| Members | Distinct labels | Option | Preparation | Record | Stored entries of the list |
| ---: | ---: | --- | ---: | ---: | ---: |
| 10,000 | 1 | on | 5 ms | 482 B | 1,784 B |
| 10,000 | 100 | on | 10 ms | 14,043 B | 44,231 B |
| 10,000 | 10,000 | on | 754 ms | 1,350,343 B | 4,348,031 B |
| 10,000 | 10,000 | off | 294 ms | (not used) | 1,449,913 B |

With few distinct labels the preparation is flat. With one label per member
every figure is linear in the members with the option on and off, and the option
stores the label three times. No representation removes that label. By rulings
of 2026-11-20 the runtime reports a diagnostic for a label of very many clauses
and refuses the commit above a hard limit (Z79), and a body with a declared
maximum confidentiality stores an output at the ceiling where the author marks
it (Z80). Neither is built; the unit and the numbers of the limit and the syntax
of the mark are not decided (questions 339 and 340 of the design's plan).

*Fixed at this run: the executor's time for an event.* This cost was in the
executor and not in the labels. `Store.changedSince` of `exec/store.ts` walked
the log of changes back to the time given for each position asked about, so an
entry evaluated before a write of many positions was compared with every one of
those changes each time it was checked: 10,000 changes times 20,000 positions.
The store keeps, per path of each document, the time of the last change at the
path and at or below it, and the answer for a position visits the nodes along
its path. A test asserts that it visits the same number of nodes for one changed
member among 10 and among 1,000 (`exec/test/store-changes.test.ts`). The module
run in memory with generated events, 21 events:

| Event | Before | After |
| --- | ---: | ---: |
| 0, `loadActions` | 432 ms | 478 ms |
| 13, `loadActions` | 347 ms | 457 ms |
| 14, `loadActions` | 4,119 ms | 414 ms |
| 15, `removeTagHandler` | 3,720 ms | 3 ms |
| 16, `addTagHandler` | 14,945 ms | 53 ms |
| 17, `onRemoveTag` | not recorded | 324 ms |

The result holds about 1.06 million characters of text after each of these
events. The times are single runs on a machine with other work.

*Open: the executor's memory.* A process that held the runs in memory beside the
run in storage stopped with "out of memory" at a heap of 4 GB. It is not fixed
and the cause is not found. The log of changes of the executor's store
(`Store.log`) still grows by one entry per change for the life of an instance,
and nothing but two tests reads it; whether it is the cause was not measured.

*Open: the preparations of the module* take 1,828 ms for 14 of them at this run,
where they took 942 ms at the eighth, about 7,700 ms at the fifth, 941 ms at the
sixth and 1,221 ms at the seventh. That is 20% of the preparation time of the
whole corpus with the option on.
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
  above or below a changed entry where a read of the position consumes another
  label than before, and those that fold over a collection with an
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
  finding 8). The adapter reports the label entries a commit changed for every
  document the transaction wrote. It keeps the entries of every document it
  read the labels of, and reads them again before a transaction only where a
  commit changed the document since.
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
- **A record with no inputs is given as bound.** A kept output that the plan has
  no template for, a write that the plan has an envelope and no write edge for,
  and an element entry with a slot that the executor has no stored position for,
  as for an element of an array that a computation returned, have a record
  marked `PlanWrite.bound`. The runtime gives the target the transaction's join,
  as a written path with no record has it, and not the label of a covered path
  above it (`instantiatePlanLabels` of `runtime/runner/src/cfc/plan-labels.ts`).
  The join is equal to or wider than the label a template would give. Such a
  record counts among the bounds taken.
- **The budget of pending-specification markers is 80,** by the owner's ruling
  of 2026-11-20 (`SPEC_PENDING_BUDGET` of `tasks/check-cfc-correspondence.ts`).
  The governed files held 46 markers at the eighth run; the count at this run
  was not taken.
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

*The corpus of current `main`,* run at the merge with the code of the eighth
run, so without the changes of the ninth: 287 modules are attempted, 16 more
than before the merge, and 244 run. 8 of the 16 run: two modules of
`apps/food-recipe`, `apps/redactor/vault.tsx`, and five of
`showcase/inductor/lofi`. Two modules that ran no longer run,
`dev/loom-chat-room-fixture/main.tsx` and `dev/loom-overlay-fixture/main.tsx`;
the report lists 2 comparisons that fail on the built-in `spaceMembers` in a
function body, a reason no earlier run had, and that these are the two was not
checked. 23 modules request an effect, where 16 did. Beside today's, of 1,763
output rows 966 are tighter, 355 equal, 286 have an atom that names the pattern,
137 are looser and 19 incomparable, and of 390 write rows 314 are equal, 63
looser, 9 tighter and 4 incomparable; 28 write rows of
`examples/cfc-trusted-component-examples` are compared that had no row. 49
commits in 26 modules are refused with the option on and not off,
`apps/food-recipe/prepared-food.tsx` and `apps/redactor/vault.tsx` among them.
The check of stored labels reports no value on the scenarios as given, in 210
modules, and 27 values in 3 modules with every event sent three times, which are
those of the eighth run. `main`'s alignment of elements runs with the option off
as well, so today's labels of spliced arrays, and with them the rows beside
today's, can differ from the earlier runs for that reason alone. No corpus run
exists with the code of the ninth run on this source.

**Not verified** for a change of a list's members: records in place with entries
below them, under a `*` entry of origin `structure` that a `structure` entry
further down replaces ("To read first", 3). Verified at this run, with the
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
included, on the source of `main` before the catch-up merge. Of 271 modules
attempted 238 run. 16 request an effect. 12 runs fail at a commit that CFC
enforcement refuses as not prepared: 6 for a missing trusted-event policy, 3 for
`writeAuthorizedBy`, 2 for `maxConfidentiality` and 1 for `writePolicyAnyOf`. 1
needs a `wish` that is not simulated (`#summaryIndex`), 1 has no value code, and
3 comparisons fail: on the built-ins `spaceDeleted` and `linksOf` in a function
body, and on an element construct that has no function. Beside today's rows:

| | Equal | Tighter | Looser | Other |
| --- | ---: | ---: | ---: | --- |
| 1,695 output rows | 287 | 1,041 | 88 | 265 whose atom names the pattern, 14 incomparable |
| 203 write rows | 130 | 9 | 61 | 3 incomparable |

41 of today's rows have no stored write and 4 no stored output to compare. The
149 looser rows are not classified by cause at this run. At the eighth run, of
173 looser rows, 63 were in a module with a commit refused with the option on,
50 were looser in confidentiality in a module that used a bound, 23 were looser
in confidentiality with neither, and 37 in integrity alone.

Against the eighth run, by output row (`diff-from-round-j.txt` of the run's
outputs); no write row moved:

- *74 rows that were equal are tighter,* in 14 modules, 52 of them in
  `examples/cfc-spec-gallery/main.tsx`: the atom of an output that holds a link
  is on its `value` entry in every case ("To read first", 12), and the
  comparison reads the class `value`. The eighth run had lost 67 such rows to
  the two places of the atom.
- *15 rows that were looser are tighter, 11 are equal, and 6 name the
  pattern's atom.* 9 of the 32 are in `system/self/self.tsx` and 11 in
  `product/primitives/demo/atoms-demo.tsx`. Why each moved was not checked row
  by row.
- *8 rows are looser that were not:* 5 that were tighter, 2 of them in
  `apps/cozy-poll/main.tsx` and 1 each in
  `dev/experimental/folksonomy-demo.tsx`, `product/primitives/check-list.tsx`
  and `showcase/wordsearch/main.tsx`; and 3 that named the pattern's atom, 2 in
  `product/primitives/demo/atoms-demo.tsx` and 1 in
  `examples/scoped-group-chat/main-plain-inputs.tsx`. A record given as bound
  takes the transaction's join, which is wider than a template's label; whether
  that is the cause of each was not checked.
- *4 rows that were tighter are equal, 3 that named the pattern's atom are
  tighter, and 1 that was tighter is incomparable*
  (`examples/group-chat-lobby/group-chat-lobby.tsx`).

The rows looser than today's are not all attributed, and "tighter" is not
evidence of correctness (open finding 9), so the corpus does not show that the
labels from templates are equal to or tighter than today's outside the
deliberate exceptions. A label stored for a write that leaves the value as it
was is such an exception: there the label is wider than today's by rule. How
many of the looser rows are in modules that call `wish` was not counted.

Of 9,039 write records checked against the template evaluator of the prototype,
7,881 agree. The eighth run checked 4,271, of which 3,947 agreed: the fixes of
this run give a record for each element entry held below a kept output. Of the
1,158 that do not agree:

- 477 in 30 modules have no entry stored at the record's path, where the eighth
  run had 80 in 31 modules. They are not examined. At the eighth run 68 of the
  80 were read as records of the number of members and of the membership of a
  list, whose label joins labels stored before the commit and which the
  evaluator cannot form.
- 262 in 8 modules are not evaluated because a slot is bound to an empty chain,
  and 261 because dynamic reads are not reported by the record.
- 32 in 12 modules are not evaluated because the record joins labels stored
  before the commit, and 32 in 7 modules because the record names no template.
- For 60 the evaluator's label is a bound: 31 equal in confidentiality and
  tighter in integrity, 16 tighter in both, 12 looser in confidentiality and
  tighter in integrity, and 1 incomparable in confidentiality.
- 14 are equal in confidentiality and tighter in integrity, and 14 tighter in
  both.
- 6 are looser in confidentiality than the evaluator's label where that label is
  no bound: 5 in 2 modules, tighter in integrity, of which
  `apps/cozy-poll/main.tsx` is one, and 1 in
  `examples/scoped-user-directory/main.tsx`, equal in integrity. A stored label
  that is looser than the evaluator's is no soundness finding; why they differ
  is not examined.

With the option on and not off, 55 commits in 23 modules are refused: 27 in 11
modules for a slot with no binding, 20 in 13 modules for a slot bound to an
empty chain, 6 in `apps/base/contacts.tsx` and 1 in
`system/fabrichat/adapter.tsx` for a pick whose choice was not reported and that
chooses from no collection, and 1 in `apps/contacts/contact-book.tsx` for a
collection with no elements reported. `system/self/self.tsx` has none where it
had some. `apps/cozy-poll/main.tsx` has 7 where it had 1,
`product/primitives/demo/atoms-demo.tsx` 6 where it had 3,
`apps/base/contacts.tsx` 7 where it had 6,
`dev/experimental/folksonomy-stress-test.tsx` 8 where it had 7, and
`apps/file-share/main.tsx` 2 where it had 1. Why they rose is not investigated.
During the round a record for each element entry held below a kept output was
refused where a slot of its template has no stored position, 22 more refused
commits in 13 modules; such a record is given as bound. No run stopped after a
refusal.

Over the 238 modules the option off made 2,699 commits and 652 preparations in
409 ms, and the option on 2,720 commits and 1,427 preparations in 9,250 ms ("To
read first", 5). The machine was under load during the run, so the times are an
upper bound and not a measurement of the cost: the option off took 257 ms at the
eighth run for the same commits and preparations. With the option on the runtime
took a bound 1,762 times, in 70 modules.

**The cost of a label for a write that leaves the value as it was.** With the
option on, 2,297 write records are those of a write that left the value as it
was, and the commits that recorded them changed 22,625 label entries. The eighth
run had 756 such records and 3,625 changed entries. The records are more because
an evaluation that gives the value an output already holds is reported as such a
write ("To read first", 7); how much of the rise that accounts for was not
measured. The option on makes 21 more commits than the option off, where the
eighth run made 61 more and the seventh 207.
`examples/cfc-spec-gallery/main.tsx` makes 75 commits with the option on, as
with it off, where it made 93 at the eighth run.
`examples/cfc-trusted-component-examples/main.tsx` makes 402 against 400. Two
mechanisms add commits by construction: a derivation transaction that gives
again the records of the outputs that read a label that changed alone, and a
reader that runs again because the label it consumed changed.

Today's runtime committed 1,882 transactions to its storage from the start of
the instances until every kept output was read, 1,799 from the first event on,
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

**Open findings.** The open soundness findings come first, then the regression
of cost, then the rest.

1. *4 values that depend on an input and store no clause of it are not
   examined:* 3 outputs at position 0 of `mentionable` in
   `examples/todo-list/todo-list.tsx`, the result of another per-element
   construct, and 1 write of `showcase/card-piles/main.tsx`, at a position of an
   array of plain values in place that a `push` after a `remove` writes ("To
   read first", 1 and 2). Unsound until shown otherwise; either may be an
   artifact of the check. Question 344 of the design's plan.
2. *A removal's `*` entry is replaced by a more specific entry of origin
   `structure`,* in `resolvedEntryGroups` of
   `runtime/runner/src/cfc/consumed-label.ts`, for a slot of an array of
   references at which a recorded link write minted a `followRef` entry ("To
   read first", 3). Unsound for that slot. Not fixed and not tested. The fix, a
   group of its own for an entry that the runtime minted at a `*` path, changes
   the resolution with the option off and needs the specification sentence
   first. Questions 343 and 326 of the design's plan.
3. *A handler that writes nothing under a condition on a labeled input stores
   nothing* ("To read first", 4). A channel of the write gate proposal: by the
   owner's ruling (Z77) it is recorded and not fixed.
   `examples/map-demo/map-demo.tsx` shows it at 16 values with generated events.
   Of the same kind, and recorded: a member appended at another index (Z74); a
   hole that a write beyond the end of a list leaves before the position it
   writes; and a removal that finds nothing, which leaves the positions as they
   were. Not decided whether they are of this kind or labels that are too
   narrow: 2 findings of `examples/group-chat-room/group-chat-room.tsx` with
   generated events, where a pushed message at position 2 depends on `users` and
   the member's `id` is drawn from the random source, whose draws the runs make
   in different numbers. Question 335 of the design's plan.
4. *The regression of cost at this run* ("To read first", 5). Serious. The
   preparation time with the option on is 9,250 ms where it was 2,176 ms, the
   bounds taken 1,762 where they were 499, the records of writes that left the
   value as it was 2,297 where they were 756 and the label entries they changed
   22,625 where they were 3,625, the write records checked 9,039 where they were
   4,271, the refused commits 55 where they were 44, and the run 22 minutes
   where it took 10. Not attributed by measurement. Question 345 of the design's
   plan.
5. *The executor's memory on `dev/experimental/folksonomy-stress-test.tsx`.* A
   process with the runs in memory beside the run in storage ran out of memory
   at 4 GB. Not fixed, cause not found ("The cost that grows with the data").
   Question 332 of the design's plan.
6. *A member appended after a removal is excused by the check and not shown to
   be sound.* 17 positions in 2 modules, all flagged as appended after another
   change of the list: 16 at the positions 1 to 4 of `mentionable` in
   `examples/todo-list/todo-list.tsx`, the result of another per-element
   construct, and 1 write of `showcase/card-piles/main.tsx`, an array of plain
   values in place. For a stored list the `*` entries of a removal are joined on
   a read of the later position. For a kept result of a per-element construct
   the label of the membership is stored at the result's `*` path where the
   members change otherwise than by an addition at the end, which is built and
   not ruled; whether it covers each of the 16 is not established. Question 328
   of the design's plan.
7. *Write records, and the work on them, grow with the data.* The three changes
   of representation that the owner ruled to build are being built, and nothing
   is measured as built ("The cost that grows with the data"). Until they are
   in, a read of a whole array of references walks every position, a slot of the
   class `identity` keeps every position in its chain, and a write of many
   members gives a record per member. For a collection whose members have labels
   of their own the label of a whole read has as many clauses as members; the
   diagnostic, the hard limit and an output stored at a declared ceiling are
   ruled and not built. Questions 318 and 338 to 342 of the design's plan.
8. *After a label changed alone, the records to give again are found by position
   and not by class,* so an output that holds a link is given again when any
   label of the document the link names changes, though its slot reads the
   reference alone. `scheduler-and-serving-loop.md` §3.6 has the rule, by the
   slots a template reaches. Not built. The plan: the executor keys the readers
   of a record (`#recordReaders` of `exec/executor.ts`) by the class each slot
   observes beside the position, the adapter reports the class of each changed
   entry, and a record is formed again only where a changed entry's class is one
   its slot consumes. The comparison adapter still reads the stored label
   entries of every written document after the commit and compares every entry,
   and `prepareBoundaryCommitSteps` itself walks every stored entry of a written
   document. The plan for that: the preparation returns, per document, the paths
   of the entries it added, changed or dropped. Question 333 of the design's
   plan.
9. *The check against the values is a lower bound, and "tighter" in the
   comparison is not evidence of correctness.* A row counts as tighter where the
   stored label has fewer clauses than today's, and a binding that leaves out a
   read has exactly that effect. The check on a scenario as given changes each
   input once, covers confidentiality alone and leaves 32 modules out. The check
   with every event sent three times covers 99 of the 238 modules, does not
   reach a branch that one value of an input decides, and is cut short for a
   large scenario. In modules with a refused commit the two find 60 values in 12
   modules and 50 in 7 that are not counted, because the storage there holds an
   earlier commit. They are not examined.
10. *477 write records have no entry stored at their path,* in 30 modules, where
    the evaluator gives a label; 80 in 31 modules at the eighth run. Not
    examined.
11. *Refusals that remain.* 55 commits in 23 modules are refused with the option
    on and not off, with the reasons above. The rise in
    `apps/cozy-poll/main.tsx`, `product/primitives/demo/atoms-demo.tsx` and
    three more modules is not investigated. A module with a refused commit holds
    the labels of an earlier commit.
12. *The bounds.* The runtime took a bound 1,762 times, in 70 modules. A bound
    is taken because the value code or the runtime does not report a selection,
    a choice or the addresses of a dynamic read: picks through `.key(k)`; the
    `through` position of a scan; the choice of `find`; the `select` over the
    keys of a record constructed in place; the optional members of a spread; and
    dynamic reads of kind `link` through a selected reference.
    `plan-and-label-templates.md` §4.2 has, for each, who knows the answer, what
    is reported and where it is kept, and the provisional decision P37 for the
    groups of a scan's prefix. Since this run a bound is also taken for a record
    that the executor gives with no inputs ("What is built"). The run does not
    count the two kinds apart.
13. *The cost of a label for a write that leaves the value as it was* ("The cost
    of a label for a write that leaves the value as it was", above). 21 more
    commits with the option on than with it off, and 775 more preparations,
    since every commit of a compiled pattern is prepared. Question 324 of the
    design's plan.
14. *Looser rows that are not attributed.* 88 output rows and 61 write rows are
    looser than today's, and they are not classified by cause at this run. 8
    output rows are looser that were not at the eighth run. At the seventh run
    today's label held no clause at 4 rows where the template's holds one (one
    row each of `dev/scope-bug-ct1597-reduce/main.tsx` and
    `dev/test/non-idempotent/accumulator.tsx`, and two of
    `showcase/battleship/multiplayer/room.tsx`); they were not looked at again,
    and none was reproduced in a test outside the corpus run, so none is a
    finding against the runtime yet.
15. *What the ruling on the atom of a kept output leaves open.* The atom is on
    the content at the output's path (Z81). The envelope of the document that
    the link names is not written, a write edge that stores a reference keeps
    the atom of its body in the label of the link, and whether the specification
    needs a sentence for an atom with no scope at the path of a link is not
    decided (`plan-and-label-templates.md` §8, question 72).
16. *A declared integrity that the crate emits as text.* The rows of
    `examples/cfc-authorship-chat` differ from today's by the atom
    `authored-by`. The schema the crate emits for its cells holds the declared
    integrity as the text of its type, `ifc.integrity: { "$source": "readonly
    [AuthorshipIntegrity<IntegrityAuthor>]" }`, which the runtime refuses as
    malformed integrity. A cell with such a schema gets no document at the start
    and stores no declared label. Not looked at again at this run.
17. *The catch-up merge with `main`* has two interactions that no test covers,
    and no corpus run with the code of this run on the source of current `main`
    ("The catch-up merge with `main`", above). Question 346 of the design's
    plan. The specification sentence that the ruling on a removal needs is
    proposed and pending the specification pull request.
18. *Seen in today's runtime, by reading and not measured:*
    `contractCandidatesForWrite` of `runtime/runner/src/cfc/ui-contract.ts`
    scans every write-policy input of the transaction for each write of an
    event's transaction (`recordTrustedEventPolicyInputs`), so its work is the
    product of the two counts. With one write-policy input per write record, a
    write of 10,000 elements makes both counts grow with the elements.
19. *The executor's store keeps a log of every change for the life of an
    instance* (`Store.log` of `exec/store.ts`), and `#unchangedOutput` and
    `#outputRecord` of `exec/executor.ts` find the recorded output for a path by
    a scan of the recorded outputs. Both are stubs with a plan: keep the log
    only where a caller asks, as `Store.appended` is kept, and index the
    recorded outputs by path.
Steps 11 and 12 of the milestone's plan, instantiation keys and verified
units in the prepared digest and a derived write dropped alone, are not
built.
