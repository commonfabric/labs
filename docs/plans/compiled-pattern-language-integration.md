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

Milestones 3, 5 and 6 are on three branches cut from the Topics branch, each of
which holds a first build of all six milestones (commit `e86377cca0`) and what
one line of work added to it: `claude/compiled-pattern-runner-m3` (draft pull
request #10140) holds milestone 3, value code in the sandbox and the serving
loop, and is read at its commit `233996ca69`;
`claude/compiled-pattern-serving-m6`, cut from that commit, holds the serving
runtime that reads from the store, and is read at `01e7567a86`; and
`claude/compiled-pattern-sandbox-m5` holds the crate and the executor on
FabriChat and Home, and is read at `bada36c846`. The three are being merged, and
the sections below describe their union. A fix of the runtime itself that this
work finds goes to `main` in a pull request of its own, by the owner's ruling
Z89: #10142, #10145, #10146 and #10147.

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
- **A network.** The figures of milestones 1 to 5, on both sides, use the
  runtime's emulated storage (`StorageManager.emulate` in
  `runtime/runner/src/storage/cache.deno.ts`), with no memory server and no
  socket. Milestone 6 measures a compiled piece under the serving loop, with a
  memory server and two clients over a websocket in one process.
- **A sandbox.** Today's runtime evaluates compiled pattern code in SES
  compartments under a module policy (`runtime/runner/src/sandbox/`). The
  executor evaluates value code with `new Function` unless it is given
  another evaluator; a compiled piece on the runner path gives it an SES
  compartment ("Milestone 5: value code in the sandbox" below).

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

- **The crate in the build.** For every comparison the crate runs ahead of time:
  `pattern-compiler emit` writes the plans and the value code, and the harness
  loads them. To compile on load, the crate runs as its release binary in a
  child process that the realm starting the piece starts (`PatternCompiler` of
  `runtime/runner/src/compiled/compile.deno.ts`; provisional decision P101), and
  not in the compile worker (`ModuleCompileWorker` in
  `runtime/runner/src/harness/module-compile-worker.ts`): the worker exists to
  take the type check and the emit off the thread of the realm, and a child
  process is off it already. Only the server compiles
  (`scheduler-and-serving-loop.md` §10.5). `Runtime.run` does not call
  `PatternCompiler`; the loader of a serving runtime does, on the branch of
  milestone 6, where a helper of tests gives it one ("Milestone 6: server
  execution and the network" below). A WebAssembly build of the crate is needed
  only where no native binary can run; the ruling that the compiler emits no
  WebAssembly is about its output and is not affected. No continuous-integration
  job builds the crate; the tests of milestone 3 load the checked-in artifacts
  of `compare/fixtures/`.
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
3. **A compiled piece in the runner.** Behind the experimental option the runner
   starts a piece from a plan. Its events come through stream cells and the
   scheduler, its store reads through the replica, and the change channel tells
   it of writes by others. One harness starts and drives both paths with the
   runtime's own calls (`Runtime.run`, `sendEvent`). *Measures:* the scheduler
   and the routing of events, and the first figure per event from send to
   settled that compares like with like. *Needs first:* a crate that emits the
   corpus of the main branch, which it does not today (the method of the figures
   below says where it fails), and the decision of milestone 2. *Status:* built
   on the branch `claude/compiled-pattern-runner-m3` for one writer on emulated
   storage: the start, with the load in bounded transactions, the events, the
   store, the writes by others, the rows of a `map` over an array declared as
   references as documents of their own, the first derivation of an instance a
   handler made as a transaction of its own, what follows a refused commit, and
   a harness that runs the corpus on the runner path; and the constructs that
   stand in the place of Topics' whole-list `lift`s: the collection index
   (`groupBy`, `keyBy` and `lookup`), with each bucket of a kept index as a
   document of its own and the index stored bucket by bucket, the keyed join as
   a `map` whose body calls `lookup` and whose row holds its bucket by a link,
   `Object.entries(record).map`, `sortBy`, and a `flatMap` that keeps its
   segments under a change of an element and of its source. On the two Topics
   boards written with them, every step reads the same positions and gives the
   same records at 100, 1,000 and 2,000 topics. An edit of a title, of the
   mentions and of `lastActivityAt` on `filing-order` settles in 8 to 26 ms, and
   an edit of the `shortName` in 18 and 27 ms at 100 and 1,000 topics, but for
   cells that are a pause in the harness's own write. A create reads 57
   positions and gives 102 records at every size and takes 98, 279 and 547 ms:
   its time still follows the board, because it changes three documents as long
   as the board, and a change of one link of a document of `N` links costs in
   proportion to the document in the runtime itself. A move in the sorted order
   of `sorted-references` takes 18, 52 and 81 ms: the array of links is written
   once and whole, since the preparation refuses a write of the positions that
   differ under the record of the array. The load takes 3.8 s at 1,000 topics.
   Three suspected under-labels of a folded collection and of a row that holds
   the membership of an index in place are noted and deferred by the ruling Z88.
   Not built: the order of a kept collection in chunks, a move that writes a
   bounded number of positions, a row whose key has no bucket held by a
   reference, `keys()` and `keyEntries()`, a bound for the documents a `lift`
   writes in a load, readers outside the executor, and the shell. Sync and
   resume are built in milestone 6. The two boards do not run on today's
   runtime. The figures and the open findings are in "Milestone 3: a compiled
   piece in the runner" below.
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
5. **Value code in the sandbox.** The module texts of value code are evaluated
   in an SES compartment under the runtime's module policy, and the runtime
   compiles on load with the crate in the compile worker. *Measures:* the cost
   of the sandbox at load and per call, and of compiling on the server.
   *Status:* built on the branch of milestone 3. A compiled piece evaluates its
   value code in one SES compartment with a frozen global object. The emitted
   text freezes the data of a module and hardens each function of module scope,
   under every evaluator. What a handle names is in private fields, and the
   crate's check refuses a member of a handle that the language does not list, a
   write to a listed one, and a declaration of a name that begins with `$`.
   `PatternCompiler` compiles a pattern source with the crate's release binary
   in a child process, with a bound on its output and no bound on its time, and
   keeps the artifacts by the identity of the source. With a compiler given to a
   runtime (`runCompiledPatterns`), `Runtime.run` starts a pattern from its
   source as a compiled piece, and a program the crate refuses runs on today's
   path with the diagnostics logged. A program is accepted only whole: of 307
   corpus modules that export a pattern, 199 start as a compiled piece through
   `Runtime.run` and 103 run on today's path, 27 for a `wish`, 21 for an effect,
   54 for a module of the program that the check refuses and 1 for a construct
   with no value code. The compartment adds nothing to a call; the lockdown of
   the realm costs a call about 5 ns. The crate compiles a source of 19 files in
   20 to 95 ms where today's first compile takes 655 to 831 ms. Open, with
   soundness first: the names the emitter binds around authored code, and with
   them the host of a call, are kept from a body by the check alone; a body that
   catches an error of the executor reads its members; and a body that holds a
   reference in a value reads the identifier of its document. A compiled piece
   cannot fall back once its start has begun. Stubbed, with a plan: a second
   `run` of a running piece, a throw at module scope taken as a refusal, a
   compiler for a toolshed's runtime, and the write of the store that copies the
   path it changes, which a read of a stored value without a copy needs. The
   compiler does not run in the compile worker (provisional decision P101), and
   today's module verifier is not run on value code, as `language-subset.md`
   §3.4 has it for a module in the subset. The figures and the open findings are
   in "Milestone 5: value code in the sandbox" below.
6. **Server execution and the network.** The serving loop, with its waves and
   seals, and a memory server reached over a socket. FabriChat, once the crate
   emits `room.tsx` and `manager.tsx`, and `system/home/home.tsx`. *Measures:*
   what the existing serving benchmarks measure for today's path, such as a
   FabriChat send and a Topics board. *Status:* built behind the same option for
   one piece of space scope: the tests of milestone 3 pass against a memory
   server over a socket; a client writes the source of a pattern and the
   argument, and the serving runtime compiles the source, evaluates the value
   code in a compartment, starts the piece in a wave and runs its handlers and
   its derivation; a piece keeps a basis of the documents its derivation read,
   and a serving loop that takes a space over starts no executor for a piece
   whose basis matches the storage, until an event or a change of a source wakes
   it. The serving runtime of the tests and the harnesses reads its space from
   the store, as a toolshed does. The two Topics boards run under the serving
   loop at 100, 1,000 and 2,000 topics: an edit of a title reaches a second
   client in 16 to 20 ms at every size and place where today's board takes 82,
   1,005 and 1,429 ms, a create in 79, 185 and 348 ms where today's takes 521,
   2,460 and 8,967 ms, and the load in 0.5, 3.2 and 6.0 s where today's takes
   2.3, 6.9 and 13.3 s, with inputs under no label. Closed, with tests: value
   code reads the members of a record in one order in every process, an event a
   handler sends is stored with the handler's transaction, and an instance a
   handler made is started at a resume. Open, with structure and scale first:
   the unit of the basis is the piece, so the first event after a takeover is
   the whole derivation, 8.5 s at 2,000 topics, which with labels on the inputs
   is the one step not below today's (9.6 s against 8.2 s); a step that changes
   a member of the result document follows the board on every holder, 198 ms for
   an edit of the `shortName` at 2,000 topics; and the load is one transaction
   of one wave. Nothing but a helper of tests installs the loader. The crate
   accepts copies of the programs of FabriChat and Home, and both run on the
   executor and on the runner path with `wish`, about 20 built-ins and the write
   policies stood in for: a send into a room of 100 messages takes 236 to 244 ms
   and grows with the room. The figures and the open findings are in "Milestone
   6: server execution and the network" and "FabriChat and Home" below.

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
  it leaves: a piece reads as absent a document that nothing brought into
  the replica, unless its runtime reads from the store. A document of
  another space that a link names is read there and told of changes, and is
  not brought where the replica does not hold it. Milestone 6 brings the
  documents of a piece at a resume, each by a sync of its own, from the
  links of the result and from the list the basis keeps of the documents the
  piece made.
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
  3 the piece reports its own time (`CompiledPieceCounts.ownMs`): 2 to 3 ms of
  an edit of a title on the Topics board `filing-order` at 100 to 2,000 topics,
  and 32 ms of a create of 279 ms at 1,000. The executor copies what a value
  slot reads for each call (`Store.read`), so a function body that is handed a
  whole array costs a copy of the array for each call: 14 of 27 ms of one edit
  at 10,000 rows on the executor in memory. A plain value of an array that no
  document holds is keyed by a hash that follows every reference in it. On
  FabriChat the executor's own work in a send follows the messages held: 107 to
  119 ms of a send into a room of 100 messages.
- **Two things keep value code inside its footprint by the crate's check
  alone.** The compartment confines names, the emitted text freezes module data
  and hardens functions, and a handle keeps what it names in private fields. The
  emitted text binds `$rt`, `$h`, `$arg`, `$e` and `$s` around authored code,
  and the host of a call, whose methods read any slot of the plan, is an object
  with public state: the check's refusal of every name that begins with `$` is
  what keeps a body from them. And a body that catches an error the executor
  threw reads the members of the error, the error state of another value among
  them. An artifact that the check did not accept is trusted as given; `emit`
  prints none for a refused module unless `--unchecked` asks, and the serving
  loader of milestone 6 evaluates none it did not compile ("Milestone 5: value
  code in the sandbox" below).
- **A figure measured in a posture no deployment runs.** Every serving
  measurement before the fourth round of milestone 6 ran the serving runtime
  reading its space over a session, where a toolshed reads from the store. An
  edit that followed the board, a wake that grew faster than the board and a
  plan to bring inputs under the schema of the plan all came from that posture.
  The harnesses of this work are helpers of tests; a default that differs from a
  toolshed's is a finding to look for in each ("Milestone 6: server execution
  and the network" below).
- **FabriChat and Home are measured on copies, with stand-ins.** The copies
  differ from the patterns in the forms the language refuses and in the
  constructs the crate does not translate; `wish` is answered from a table,
  about 20 built-ins by constants for one user who owns every space, and the
  write policies, the added integrity and the write authorizations are removed
  from the schemas. A figure of the compiled path there is a lower bound of what
  it will cost with policies checked ("FabriChat and Home" below).
- **A piece cannot move between the two paths.** A program that the crate
  refuses runs on today's path. A piece that was started compiled and whose
  program is no longer accepted at a resume is refused, with the reason stored:
  today's path reads none of the documents the executor wrote and names its
  state cells otherwise. A compiled piece whose start throws after its first
  load transactions committed cannot fall back either.
- **The serving runtime compiles what a client wrote.** A client writes the
  source of a pattern and the document that names it for a result, and the
  serving runtime compiles and runs what it finds. Nothing decides who may write
  either. Nothing but a helper of tests installs the loader.
- **The start of a piece is several commits.** The load of a compiled piece
  commits the documents the instance makes for itself and the rows that are
  documents before the transaction the caller handed (provisional decision P65).
  Where that transaction is never committed, or is refused, the documents of the
  earlier commits stay stored with nothing that links to them, and nothing
  removes them. The documents a `lift` writes for its rows are not split off, so
  a board with the three `lift`s of about 4,000 topics is past the memory
  server's limit for one message. Under the serving loop of milestone 6 the load
  is one transaction of one wave, bounded by nothing. The design's own statement
  is one transaction for a creation outside a handler
  (`execution-and-storage.md` §1.1, assumed there under its question 77).

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
- **The records of rows a `lift` writes are given for every row on each run**
  (provisional decision P48): 1,010 given for an edit at 1,000 topics, of which
  11 are recorded. The remedy is no record for a row whose value and whose
  inputs' label identifiers are those of the run before. Milestone 3 builds it
  (provisional decision P59). It does not apply where the transaction in
  progress wrote a position the `lift` read, since such a position has no label
  identifier yet. On the runner path the first derivation of an instance a
  handler made is therefore committed before the derivation of what reads the
  instance (provisional decision P64), so that a create is not that case.

Three of the board's whole-list `lift`s have a construct of the language in
their place on the boards that milestone 3 measures: `namesTable`, a row for
each entry of a record of references, is `Object.entries(record).map`;
`crossrefTable`, a join, is a `flatMap` into pairs, a `groupBy` and a `map`
whose body calls `lookup`; and `crossrefIndexOf`, which groups by name, is a
`groupBy`. "The constructs" under milestone 3 has the label rule of each and
what each does not cover.

**The decision.** The owner decided on 2026-11-21 to go to milestone 3 on this
evidence, and to build the rows as documents there. The edit at 100, 1,000 and
2,000 topics, from send to settled, is measured on the runner path in "Milestone
3: a compiled piece in the runner" below: on `filing-order`, with the mentions
declared as references in the harness's topic schema, an edit of a title settles
in 11 to 23 ms where this section has 232 to 5,888 ms, and the work of the
piece in it is 2 to 4 ms.

**Two defects found on the Topics branch.** The first was not measured again on
the board `main`. The second is closed on the runner path of milestone 3.

- The first create after a load on `main` brings a new clause into what the
  whole-list `lift`s read, so every row is labeled again in one commit: 15.5 s
  at 1,000 topics and 53.6 s at 2,000, of which the preparation is 7.2 s and
  27.0 s. The preparation finds written and covered paths by prefix
  (`runtime/runner/src/cfc/prepare.ts`) and is still more than linear in the
  paths of one document; two passes compare each cleared existence entry with
  each written path. The board `main` was not measured on the runner path of
  milestone 3 with the reads through handles and the label readers. On the
  boards `filing-order` and `sorted-references` a create there gives one write
  record for each row of the pivot, since a topic that is made has a label of
  its own and the label of each row names the membership of the index it looked
  up ("What still grows, and why" there). The first derivation of the created
  topic is committed before the derivation of what reads it (provisional
  decision P64). The preparation of a document that holds a long array of links
  is still a product within that document.
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
- `xs.sortBy((x) => key)` keeps a sorted order (provisional decision P85; "The
  constructs" under milestone 3): the compiler knows that the order of two
  members depends on the keys of those two alone. The order of the result has
  the `fold` of the key over every member, and a row its own member's label.
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

Built on 2026-11-22 and 2026-11-23 on the branch
`claude/compiled-pattern-runner-m3`, behind the experimental option
`compiledPatterns`, and read at its commit `233996ca69`. The part that touches
storage, the scheduler and Contextual Flow Control is
`runtime/runner/src/compiled/` (`piece.ts` and `transactions.ts`); the executor
is `base/pattern-compiler/exec/`. Notes 579 to 669 of
`base/pattern-compiler/SPEC-NOTES.md` on that branch hold the detail, and the
provisional decisions P50 to P92 and P140 to P146 of
[compiled-pattern-language.md](compiled-pattern-language.md) are of this
milestone. Every figure is of one writer on emulated storage in one process,
with flow labels stored (`cfcFlowLabels` is `persist`), on an 18-core machine at
load averages of 3 to 12. Every topic or item has one shared clause unless a
paragraph says otherwise. Whenever this section says `map`, `filter`, `flatMap`,
`groupBy` or `sortBy`, it names the case: an array of references, an array of
plain values in place, or the result of another per-element construct.
**The topic schema of a figure.** The harness writes each topic as a cell under
a schema, and the memory server follows links from a written topic as far as
that schema lets it (the finding on the harness's subscription below). Two
schemas are in use. The *default* schema (`topicSchemaOf` of
`compare/topics/scale.ts`) declares a label and no structure. The schema with
*the mentions declared as references* is the switch
`SCALE_TOPIC_SCHEMA=mentions-as-cells` of that harness. Each table below says
which schema it is of and when it was measured.

**The two boards measured.** `board-filing-order.tsx` and
`board-sorted-references.tsx` exist in two forms, both on the local branch
`claude/compiled-pattern-topics-runs` and in no pull request. In the form *with
the three `lift`s*, `namesTable`, `crossrefTable` and `crossrefIndexOf` are each
a `lift` over the whole array of topic references or over a result of one, and
the cards of `sorted-references` are a `map` over the result of the `lift`
`topicsByActivity`. In the form *on the constructs*, which is the form at the
head of that branch, the four are written with the constructs of "The
constructs" below. The tables hold both, since the first is what the same board
costs without the constructs. Both boards on the constructs declare their input
as `BoardInput`, whose `names` is a record of cells (`BoardNames`), where
`main.tsx` declares a record of unknown values (provisional decision P87).

**Findings on structure, scale and soundness.**

- *Soundness, suspected and not resolved: a member that enters a folded
  collection under a label of its own gives no record again where its label is
  stored when it enters.* The fixtures are `crossref.tsx` and
  `bucket-reference.tsx`, with a topic under a clause of its own that mentions
  no topic, pushed onto the array by another writer in the transaction that
  writes the topic. The rows of the other topics are given no record, and a read
  of the bucket of any of them does not consume the clause of the topic that
  entered, although its list of mentions decided that it is in no bucket. The
  groups of the stored array are brought up to date for a member that enters
  (`MemberGroups`), and the records that read the array are given again only
  when stored labels change (`Instance.#memberLabelsChanged`). On Topics a
  create gives the records, because the label of the new topic is stored one
  commit later. It holds in both layouts of a row. By the ruling Z88 it is noted
  and not resolved (question 438 of the design's plan).
- *Soundness, suspected and not resolved: a row that holds the membership of an
  index in place keeps the label it was given until its own record is given
  again.* With the list of mentions of one topic written under another clause by
  another writer, the row of that topic and the rows whose buckets changed
  consume the new clause, and the row of a topic that none mentions, which holds
  an empty array in place, does not (`crossref.tsx`, the last row). A row that
  holds its bucket by a link consumes the entry of the index, which is kept
  current (provisional decisions P142 and P143; question 439).
- *Structure: the wire form of an array written at its path is a `replace` of
  the array, and the preparation refuses the form that would send a splice.*
  Read from `V2StorageTransaction.getNativeCommit` for an array of 1,000 links:
  a write at the path of the array is one `replace` patch that holds the array,
  88 KB; writes of the positions that differ, under a read of the array, are two
  marked splices; and `Cell.set` of the array is two marked splices.
  `findArrayPatchPath` of `runtime/runner/src/storage/v2-transaction.ts` groups
  a write as one of an array only where an array stands above the path written.
  The adapter writes the array of row documents at its path, so a move sends the
  array. With the positions between the first and the last that differ written
  one by one, the preparation refuses the commit ("a plan-write names
  `/$UI/children/0/children/1/children/0` ..., which the transaction did not
  write"): the record of the array names the array, and a record of the plan has
  to name a path the transaction wrote. A splice on the wire therefore needs a
  record for each position written, or a record of the plan that covers the
  positions of a splice (questions 425 and 441).
- *Scale, structural: in the runtime itself, a change of one link of a document
  of `N` links costs in proportion to the document, and no compiled piece
  removes it.* `compare/patch-cost.ts` starts no piece: one document holds `N`
  links to other documents, as an array and as a record, and each step is one
  transaction of the runtime with one write, timed until the commit is settled
  and the scheduler is idle. The median of 9 steps on emulated storage, in ms,
  measured on 2026-11-23 at a load average of 5.2:

  | Step | 1,000 links, 88 KB | 2,000, 176 KB | 4,000, 352 KB | 8,000, 704 KB |
  | --- | ---: | ---: | ---: | ---: |
  | one link of the array replaced, no labels stored | 4.8 | 6.3 | 12.7 | 23.0 |
  | one link appended to the array, no labels stored | 3.4 | 6.2 | 13.5 | 23.8 |
  | one link moved, the array written, no labels stored | 18.4 | 34.7 | 64.0 | 126.2 |
  | one member added to the record, no labels stored | 4.7 | 8.4 | 20.8 | 39.1 |
  | one link of the array replaced, labels stored | 14.0 | 23.8 | 52.9 | 118.6 |
  | one link appended to the array, labels stored | 12.0 | 24.8 | 53.8 | 120.7 |
  | one link moved, the array written, labels stored | 39.5 | 81.3 | 172.3 | 429.2 |
  | one member added to the record, labels stored | 19.0 | 39.1 | 81.9 | 178.2 |

  With labels stored, a replacement of one link takes 14 to 17 ms for each 100
  KB of the document, and without them 3 to 5 ms. A move of one link, written as
  the array, takes five to six times a replacement without labels and three
  times with them. By the logger's timings of the nine replacements at 8,000
  links without labels, the time is in the refresh of the watches of the storage
  (`storage.v2/watchRefresh`, 764 ms over the nine), the client's decoding of
  what it receives (`memory.v2.client/receive/decodeBoundary`, 167 ms) and the
  memory server's refresh of the sessions the commit touched
  (`memory/memory/flush/refresh`, 67 ms). So a subscriber of a document receives
  and decodes the document for a change of one path, and the server evaluates
  its subscriptions over the document again. *What the compiled path writes into
  documents that grow with the board:* the result document, which holds six
  members with one link for each topic (the children of the board in `$UI`, the
  arrays `mentionable`, `crossrefs` and `namesTable`, and the records of the
  buckets of `crossrefIndex` and of `mentionIndex`; 163 to 324 bytes for a topic
  in each, 1.14 MB at 1,000 topics); and, on a create, the array
  of topic references (372 KB at 1,000 topics) and the record of names (369 KB)
  of the board's input, which the handler appends to. *What storage would need,*
  in no milestone: a change delivered to a subscriber as the patch and not as
  the document; a subscription evaluated again for the paths a patch touched;
  the preparation's work on the stored labels of a document bounded by the paths
  written; and an array or a record of links stored in chunks, so that a list of
  2,000 links is no single document (the part documents of provisional decision
  P20). On the compiled path a link is written with the space of its target
  (`createSigilLinkFromParsedLink` in `#writeRow` and `#writeBucket` of
  `transactions.ts`), which is 56 of its 155 bytes where the target is in the
  space of the result (question 424 of the design's plan).
- *Soundness: a `map` over plain values generated from scratch that hold
  references lost every row when a document that a reference leads to was
  written. Closed, with a test.* The case is
  `compare/fixtures/value-references.tsx`: a `lift` gives one pair of references
  for each mention, plain values generated from scratch and stored as an array,
  and a `map` over that array of plain values in place reads the title of the
  topic that mentions. `Store.#keysOf` of `exec/store.ts` formed the key of each
  plain member of a stored array from the member read with every link followed.
  A write of the title of a topic that a pair leads to therefore formed every
  key again from the changed content, and every row of the `map` then held
  nothing: the result was 13 times `undefined` at 8 topics. A member that holds
  links is keyed by its own content with each link as the address of what it
  names (`Store.#linksNamed`, `Store.addressOf`), and a member that holds none
  keeps the key it has (provisional decision P92). The keying reads no document
  a link leads to; it registers the reads that find what each link names
  (`Position.own`). *Scale, closed with it:* with each topic mentioning the two
  before it, the load of the fixture took 15, 46 and 259 ms at 16, 20 and 24
  topics, five times as long for each four topics more, because the keying
  walked a graph of documents as a tree; 64 topics load in 49 ms. *Left:*
  `Instance.#table` of `exec/executor.ts` keys a plain value of an array that no
  document holds by the salted hash of the value with every reference followed.
  No fixture reaches it with a value that holds a reference (question 380 of the
  design's plan).
- *Scale: a create reads the same positions and gives the same records at every
  size, and its time still follows the board.* On `filing-order` a create makes
  20 evaluations, reads 57 positions and gives 102 records at 100, 1,000 and
  2,000 topics, and takes 98, 279 and 547 ms. Three things made its reads and
  its records follow the board, and each is removed: a change of the source of a
  `flatMap` formed the segment of every topic (provisional decision P140); the
  read of the `enumeration` entry of the handler's state followed the link of
  each member of the namespace into each topic's document (P141); and each row
  of the pivot held the membership of its bucket and was given its record again
  when a topic with a label of its own entered (P142). The piece's own time is
  17, 32 and 46 ms and the preparation 19, 39 and 65 ms. In the profile of a
  create at 2,000 topics on `sorted-references` the piece's own work is 56 ms in
  the derivation and 14 ms in the handler, the preparation 73 ms, and the rest
  is what three documents as long as the board cost the runtime: the memory
  server's `refreshTrackedGraph` 147 ms and `applyCommitTransaction` 110 ms,
  `compressLabelMetadata` 73 ms, hashing 85 ms, `deepFreeze` 50 ms and garbage
  collection 58 ms. Of the piece's own work, 35 ms are the array of cards, which
  a create on that board changes at its front, and 29 ms the table of the
  entries of the namespace, which is formed whole with its canonical text when
  an entry is added. The documents of the last commit of a create are 0.17, 1.16
  and 2.26 MB. The 3 records of `mentionedBy` that a create gives are of the
  rows whose topic no topic mentions, which hold an empty array in place.
- *Soundness, not checked: what a read of a bucket of a kept index consumes
  differs between the two layouts of the buckets, and each leaves out what the
  other holds.* The test has four items in two buckets and a fifth that enters
  under a clause of its own. With the buckets in place (`rows` at `in-place`), a
  read of another bucket consumes the clauses of that bucket's members and of
  the new item, and not the clauses of the members of the other bucket, whose
  keys decide that they are not in it. With the buckets as documents, the same
  read consumes the clauses of the four and not that of the new item: the
  document of a bucket that the transaction does not write keeps the label it
  has, and a read that follows the link to it consumes nothing of the result
  document above the link. Both are suspected under-labels. By the ruling Z88
  they are noted and not resolved, and a kept index is not checked for labels
  beyond the tests named (questions 398, 405 and 406 of the design's plan).
- *Scale: an edit of the `shortName`, and an edit of the mentions that changes a
  bucket, write the result document.* An edit of the `shortName` makes 7
  evaluations, reads 11 positions and gives 10 records at every size, with 3 to
  5 ms in the piece, and takes 18 and 27 ms at 100 and 1,000 topics. An edit of
  the mentions makes 10 evaluations, reads 4 positions and gives 2 records, and
  takes 18, 23 and 26 ms. Each changes a link of the record of the buckets or
  gives the record of the index again at the path of the index (P143), which
  stores a label entry of the result document, so the commit carries that
  document: 0.15, 1.14 and 2.24 MB, at the cost of the finding on a document of
  links. The executor writes the buckets that changed and does not form the
  index whole (P144).
- *Scale: a move of one row of a sorted order writes the array of links once,
  and whole.* An edit of `lastActivityAt` on `sorted-references` moves one card
  to the front of an array of links in the result document: 5 evaluations, 10
  positions read and 11 records at every size, 18, 52 and 81 ms at 100, 1,000
  and 2,000 topics, with the piece's own time 3, 9 and 15 ms and the preparation
  4, 17 and 31 ms. A change of one sort key gives two changes of the array, one
  that takes the row out and one that puts it in. The adapter keeps the
  identifier and the link of the document of each row by its key and writes an
  array whose positions shifted once, when the transaction ends (provisional
  decision P146). The storage reports one changed path for each position between
  the old place and the new, and the commit carries the array, for the reason of
  the finding on the wire form. What would bound it, the order in chunks, is
  under "Not built" below (question 425 of the design's plan).
- *Soundness: a value read through a reference that an upstream row holds was
  stored with the label of the reference alone. Closed, with tests.* The case
  is a chain of two per-element constructs: a `map` over an array of references
  whose row holds a member of its element, as `{ tag: item.tag }` does, and a
  second per-element construct over the result of that `map` whose body reads
  the value, as `rows.map((row) => row.tag + "!")` and the key function of
  `rows.groupBy((row) => row.tag)` do. The row of the first holds a reference
  to where the element stores the member. The slot of the second was bound to
  the upstream output and to nothing else, so the stored label held nothing of
  the label of the value at the position the reference names: with each item
  under a clause of its own, a text computed from the tag of the first item was
  stored with no clause, a bucket of an index over such rows without the keys
  of the other members, and the occupied keys with no clause. The binding keeps
  the stored positions that the read of the slot went through, and the
  preparation joins the label of that read with the label of the output
  (provisional decision P74). The site carries the `SPEC-PENDING` marker, since
  a binding of a slot to an output and to a read at once is in no clause of the
  specification. Every such chain had the defect, an index or not; which
  patterns of the corpus hold one was not counted.
- *Soundness: the label of a row of a keyed join holds the key of every source,
  also of the sources that are in no bucket of the row.* A rule that gives a row
  the keys of the sources that name it alone is an under-label: that a source
  is absent from bucket `k` says its key is not `k`. The rule that is built is
  the one `plan-and-label-templates.md` §3.17 decides, tested on stored labels
  with a clause for each member, for a bucket that holds members and for a key
  no member has.
- *Scale: a read that finds what a reference names was registered as a read of
  the named document whole. Closed.* The element table of a collection over an
  array of references, and the keys of the array, are formed from what each
  link names. Registered as reads of the named position and everything below
  it, they had a write to any field of any member mark every assembly over the
  array, form the keys again, and report a read of every member to the
  transaction: an edit of a title read 1,013 positions at 1,000 topics. Such a
  read is marked (`Position.own` of `exec/store.ts`), and a write below the
  position is no change for it (provisional decision P79). An edit of a title
  reads 11 positions at every size.
- *Structure: the two measured boards do not run on today's runtime.*
  `groupBy` is declared on a cell of an array (`IDerivable.groupBy` of
  `base/api/index.ts`), the result of a `flatMap` or a `map` in a pattern body
  is typed as a plain array, and a cast to a cell type is refused by today's
  transformer and by the crate. A grouping of the result of another per-element
  construct, which the pivot and its index both need, is therefore in the
  compiled language alone, and `base/api/index.ts` declares no `sortBy`
  (provisional decisions P80 and P85). The arms `today` and `today-labeled` of
  the harness run `main.tsx`. At 100 topics the facts the arm `runner` reads of
  each board on the constructs, over the load, six edits and three creates,
  equal those the arm `today-labeled` read of the same board with the three
  `lift`s.
- *Scale: a handler is handed each value it closes over read whole, and a stored
  value is copied for each read.* The executor hands a handler each value it
  closes over, read whole (`Instance.#attempt`), which is why the verb
  `addTopic` is a handler with cells in its state (provisional decision P81). A
  function body is handed its argument with nothing read of the computed part at
  a path that a `value` or an `identity` entry of `Body.reads` fills
  (provisional decision P91): the `lift` `backlinksOf` of a new topic, which
  declares the pivot and its index as cells and reads one bucket, reads that
  bucket and not the index with every row and every topic behind it.
  An `enumeration` or a `shape` entry of a handler's state that gives way to a
  handle the state holds is read with no link of a child followed (provisional
  decision P141). `Store.read` still copies what it reads: 14 of the 27 ms of
  an edit in a `lift` over an array of plain values in place at 10,000 rows on
  the executor in memory.
- *Scale: three more costs of the constructs follow the data.* The time of a
  change of a key follows the size of the two buckets it touches: a `map` over a
  bucket is assembled again, and `Index` finds a member in its bucket by a scan.
  The element table of `Object.entries(record).map` is formed again for each
  change of the record, with its canonical text: 29 ms of a create at 2,000
  topics. And a `sortBy` or a `filter` over the result of another per-element
  construct forms its order whole for each change.
- *A step can take 170 to 450 ms more than the piece and the preparation account
  for, for causes outside the piece.* Some cells of the tables below are such a
  pause: an edit of the `shortName` at 2,000 topics on both boards (386 and 388
  ms, with the piece and the preparation at 14 ms together), an edit of the
  title of the last topic at 1,000 in two of three runs (184 and 164 ms), and an
  edit of the mentions at 1,000 in one of three. In a profile of an edit of the
  `shortName` at 2,000 topics, measured on 2026-11-23, 291 of the step's 353 ms
  are one call of `deepFreeze` of `base/data-model/src/deep-freeze.ts` under the
  `Cell.set` of the harness's own write: one insertion into the weak set of
  deep-frozen objects, which holds an entry for every container of every frozen
  value alive, grows the table. It falls on whichever step grows the table past
  its size, in the median of three runs or not. The other cause seen is the
  collector: at 1,000 topics the heap is 1.1 GB after the load, and one run with
  a trace showed one mark-compact collection of 181 ms during the edits. Both
  follow the number of objects the process holds. The edit of the last of 2,000
  topics that took 256 to 265 ms on the boards with the three `lift`s was not
  profiled.
- *Soundness: a load split over several transactions under-labels in two cases,
  and both are closed with a test.* The load of a compiled piece commits the
  creation and the row documents in transactions of their own before the
  transaction the caller handed (provisional decision P65). First, the documents
  of the creation hold the argument, which the caller can have computed from
  what it read in the handed transaction; a transaction of the adapter that read
  nothing would store them with no label. The creation therefore makes the reads
  the handed transaction had made when the load began. Second, a caller that
  writes an input into the handed transaction and starts the piece in it stages
  positions that only that transaction reads; a row stored by another
  transaction would read them as absent. A load whose handed transaction holds a
  write of the caller is therefore written into that transaction whole.
- *Soundness: a label that changed has to reach every record that read it, also
  where a value changed with it.* Milestone 4 forms the label of a record again
  only for a change that the store reports as one of labels alone. A write by
  another writer that changes the label of a document together with a value that
  no derivation read then leaves every record that read the document, rows and
  outputs alike, stored under the label of before, which is an under-label. On
  the branch of milestone 3 the label of a record is formed again whenever a
  label its inputs read changed and the record is not given again (provisional
  decision P58), with a test.
- *Soundness: the executor has gone on when a commit of the piece is refused.*
  Left so, its documents are ahead of the storage, and a later derivation can
  store, under the labels of what the storage holds, a value computed from what
  the refused transaction wrote. The piece takes what the storage holds for each
  document the refused transaction wrote and derives again (provisional decision
  P62). This is closed for those documents, with what "Not verified" below
  lists.
- *Structure: a load whose handed transaction never commits leaves documents
  stored.* Where the caller does not commit the handed transaction, or its
  commit is refused, the creation and the row documents that the load committed
  stay in the storage, with sound labels and with no document that links to
  them. Nothing removes them.
- *Scale: the load is bounded for the rows of a `map` and not for the documents
  a `lift` writes.* The rows of a `map` over an array declared as references, or
  over the result of a construct that yields references, are committed in
  transactions of at most `CompiledPieceOptions.loadRows` rows, 250 unless
  given. The documents a `lift` writes for its rows are given their records when
  the body has returned, and stay in the handed transaction: 4,000 of the 8,011
  documents of the load at 2,000 topics. A board of about twice that size is
  refused by the memory server as the load in one commit is at 2,000
  (`MessageTooLargeError`: one client message is limited to 1,000,000 array
  slots and record members). The count is of the boards with the three `lift`s.
  The boards on the constructs load a document for each bucket and for each row
  of `namesTable` as well: 5,011 documents at 1,000 topics, and 10,011 documents
  in 26 commits at 2,000; the boards that keep the index of the pairs load one
  more for each topic that is mentioned, 12,011 at 2,000.
- *Scale: the write whose time followed the position of a topic was the
  harness's own subscription, under a schema with no structure.* The memory
  server's `refreshTrackedGraph` (`runtime/memory/v2/query.ts`) walks each
  written document again under each selector its tracker holds for it, and a
  walk follows the links the selector's schema lets it follow. The piece reads
  through transactions and holds no query. The harness holds each topic under
  the default schema, which admits every link, so the walk of topic `k` follows
  its mentions to the topics before it and reads `k + 3` documents. With the
  mentions declared as references, a write of a field the board does not read
  takes 12, 8 and 14 ms at the first, the middle and the last of 2,000 topics,
  where under the default schema it takes 25, 44 and 79 ms. For a real board the
  cost of a write of one document is the number of documents reachable through
  links from it under the schema of the widest query that reaches it. A board
  whose topics are read under the board's own argument schema, which declares
  the mentions as cells, pays for the topic itself. A reader that subscribes to
  a topic with no schema, or with one that declares no structure, pays the
  transitive closure of the topic's mentions on every write of the topic, on
  today's path and on the compiled path alike. No real board was measured.
- *Scale: the preparation of a commit has one product left, within one
  document.* The preparation asks `InputReadView.reads` of
  `runtime/runner/src/cfc/prepare.ts` once for each target it verifies. On the
  branch an ask of a transaction that lists the read records it listed compares
  no record and classifies only the metadata objects that are not frozen
  (provisional decision P66), so the asks are not the number of targets times
  the number of reads: writing 10,000 cells in one transaction with no piece
  started has 2.9 s of preparation, where it has 9.8 s without the change. What
  is left is more than linear: for a document that holds an array of 10,000
  links, `pathHoldsUnattributedInitialization`, `pathHoldsStagedReference` and
  `isRuntimeWritePolicyInput` compare each written path of the document with
  each write-policy input of the document, 1.4 s of the 2.9 s, since
  `writePolicyInputsForDocument` indexes the inputs by document and not by path.
  The change of P66 is on the branch of milestone 3 alone; `main` has the
  product of targets and reads, on today's path (question 347 of the design's
  plan).
- *Scale: the executor compares every unit of the result in each derivation.*
  `Instance.#storeResult` stores every unit of the result again and compares
  what it holds member by member (`Instance.#storeUnit`, `canonical` of
  `exec/store.ts`). A profile of one edit at 2,000 topics on `sorted-references`
  has 4.5 of 7.5 ms there. The result of that board holds the output of
  `topicsByActivity`, an array of one reference for each topic; the result of
  `filing-order` holds no such array.
- *Structure: the derivation behind an event that made an instance is two
  commits.* The first derivation of the new instance is committed before the
  derivation of what reads it (provisional decision P64). The owner's ruling has
  the derivations a batch made stale settle once behind the batch; each is still
  evaluated once, and the ruling Z87 admits the two commits.
- *Every step on `filing-order` does the same work at every size of the board.*
  On the boards on the constructs, with rows as documents, an edit of a title
  makes 5 evaluations, reads 11 positions, gives 9 write records and makes 2
  commits, at 100, 1,000 and 2,000 topics, and the documents of its last commit
  are 8.6 KB at each size. With the mentions declared as references it settles
  in 10 to 26 ms at each size and position, but for the cells that are a pause
  in the harness's own write. An edit of the mentions makes 10 evaluations,
  reads 4 positions and gives 2 records; an edit of the `shortName` makes 7,
  reads 11 and gives 10; an edit of `lastActivityAt` makes 3, reads 10 and gives
  7; and a create makes 20, reads 57 and gives 102.
- *Over-labels: a load in one transaction over-labels what is bound through the
  argument, and three more are found,* one of rows in place, one of rows as
  documents and one of the crate ("Over-labels found" below). No under-label of
  rows as documents is found against rows in place.
- *A write by another writer to a derived array is not taken by the executor,*
  in either layout. With rows as documents it is reported
  (`CompiledPiece.refusals`); with rows in place nothing reports it (provisional
  decision P61).

**What is built.**

- *Start.* `startCompiledPiece(runtime, tx, artifact, argument, resultCell)` of
  `runtime/runner/src/compiled/piece.ts` is the call beside `Runtime.run`, and
  it throws with the option off. The result document of the instance is the
  entity of `resultCell`, and every other document the executor makes is an
  entity of the same space. The caller commits `tx`. `runtime.ts` and `index.ts`
  of the runner do not import `src/compiled/`, so a runtime that starts no
  compiled piece loads none of it. The runner imports the executor by relative
  path, and the executor imports nothing of `runtime/` (provisional decision
  P50). Value code is evaluated in an SES compartment unless the caller gives
  another evaluator ("Milestone 5: value code in the sandbox" below).
- *The load in bounded transactions.* `RuntimeTransactions.within` takes
  `loadRows`, and `startCompiledPiece` passes `CompiledPieceOptions.loadRows`,
  250 unless given (provisional decision P65). The adapter commits, before
  `startCompiledPiece` returns: the creation, which is the documents the
  instance makes for itself, in a transaction that makes the reads `tx` had made
  when the load began; and then the row documents, in transactions of at most
  `loadRows` rows. A row goes into such a transaction where its write records
  name stored positions alone (`#namesStoredAlone`: no position the load wrote,
  no `output` and no `staged` binding), where one of the records is of the row
  whole, and where no transaction of the load has written its document. Each
  transaction of rows is committed at `loadRows` rows and at the end of the
  change of the result that made the rows, so that none is open when the
  executor next reads or writes. Everything else, the links to the rows among
  it, is written into `tx`. Where the preparation refuses one of the adapter's
  transactions, `tx` is aborted. A load whose `tx` the caller wrote into before
  the start, and a load with `loadRows` set to `Infinity`, is written into `tx`
  whole. A reader may observe, after the creation, the argument, the empty
  result and the state documents, and after a transaction of rows, row documents
  that no document links to. Each row is stored with the records it has in a
  load in one transaction, and those records name stored positions alone, so the
  label they instantiate to is the label the row has when the load is done; no
  path of a row is without a record, since one record is of the row whole. A
  read through a link that `tx` then writes joins the label of the link's
  position. The commits of the adapter keep `StorageManager.synced()` waiting
  like any commit.
- *Events.* A stream of the executor is stored as a link to an entity that holds
  the runtime's stream marker, and the piece registers one event handler of the
  scheduler for it (`Scheduler.addEventHandler`), so `Cell.send` on the member
  of the result reaches it. The handler runs the compiled handler in the
  transaction the scheduler gives it (`Instance.handleEvent`), which the
  scheduler commits. An event that a handler sends to a stream of the piece is
  sent with `Cell.send` on the cell of the entity that holds the stream's
  marker, bound to the handler's transaction (`CompiledPiece.#registerStream`;
  provisional decision P151): on a runtime that is no serving runtime it is an
  event of the scheduler's queue, and on a serving runtime it is stored with the
  transaction ("Milestone 6: server execution and the network" below). A stream
  that the state of a binding alone holds, which no stored value links to, gets
  its marker in the transaction of the handler that first sends to it
  (`RuntimeTransactions.markedStream`). The piece appends no event to a stream
  document of the design and writes no watermark (provisional decision P52), and
  every transaction the executor opens within one call of the scheduler is
  written into the scheduler's one transaction (`RuntimeTransactions.within`;
  provisional decision P53).
- *The derivation, and settled.* The derivation is one action of the scheduler
  for the piece, an effect, which runs `Instance.settle()` in the scheduler's
  transaction (provisional decision P51). The piece invalidates it after an
  event, after a change by another writer, when a commit of another writer
  changed a label the executor read, and after a refused commit. Settled is what
  it is for any piece: `Runtime.idle()` resolves when no event is queued and the
  derivation action is not invalid, and the harness then awaits the commits
  (`Scheduler.idleWithPendingCommits()`). The action opts out of the scheduler's
  delay of 100 ms for actions that take 50 ms or more on average
  (`Scheduler.setNoDebounce`; provisional decision P55).
- *An instance a handler made.* A handler that makes an instance stores the
  instance's two documents in the event's transaction. The derivation action
  first runs `Instance.settleMade`, which derives the instances a handler made
  and nothing else in one derivation transaction, and the action then
  invalidates itself and runs again for the rest, which the scheduler commits
  apart (provisional decision P64). The derivation of what reads the new
  instance then finds the labels of its result stored, with identifiers, and a
  `lift` over the list gives no record again for a row whose value and labels
  stayed. A reader between the two commits finds the new member with its result
  and the board's derived outputs without it. One create is two derivations, and
  the new member reads the outputs of the board it is handed once in its own
  transaction and again when they change, about 5 positions a topic more for
  each create on Topics.
- *The store.* The executor's store is the copy in memory that keeps the
  identity of arrays. A document the executor did not make, such as an input
  cell the argument links to, is read from the replica when a reference first
  leads to it (`Store` option `load`) and not again. Each position read is
  journaled in the transaction (`TransactionHooks.read`). A read gives the
  members of a record in the order of the storage, the names by their UTF-8
  bytes with the array indexes first (`membersInOrder` of `exec/store.ts`;
  provisional decision P150). A document that a link names in another space than
  the piece's is read in that space, and the subscription takes the commits of
  that space for the documents the piece holds of it
  (`RuntimeTransactions.#decode`); a document of another space that the replica
  does not hold is not brought ("FabriChat and Home" below).
- *Writes by others.* The piece subscribes to the storage notifications. A
  commit whose source is no transaction of the piece and that changed a document
  the executor holds is applied to the store outside any transaction, which
  marks the readers, and the derivation is invalidated. A change of the members
  of an array is applied as the one splice between the array before and after,
  found by comparing the canonical text of the members from both ends
  (`spliceBetween`). A write into the document of a row is applied to the row
  the executor holds; a write of the array of links of a derived array, or above
  it, is reported and not applied (provisional decision P61).
- *Rows as documents.* `rowDocumentCollections` of `exec/row-documents.ts` reads
  the plan when the piece starts (provisional decision P54). It names a
  collection whose construct is `map`, written in no element body, with an
  output below a row, whose source is a slot whose schema declares the array or
  its members as cells, or an output whose body gives a reference at each
  member, or a `filter` over such a source. That is a `map` over an array of
  references that the type declares as references, or over the result of a
  construct that yields references. A `map` over an array of plain values in
  place keeps its rows in place whatever the data holds. Each named row is an
  entity of its own, named by the array's document, its path and the key of the
  row, and the array holds the runtime's link to it. The array can stand below a
  member of an array, as the cards among the children of a view node do. On the
  boards `filing-order` and `sorted-references` on the constructs the rule names
  the cards, `mentionable`, the rows of the pivot and the rows of `namesTable`;
  on `main` it names nothing, since there the cards and `mentionable` are the
  result of a `lift` that gives plain values. `CompiledPieceOptions.rows` set to
  `in-place` keeps the rows in the array, for comparison. A member added at the
  end of an array of row documents is written as the number of members and the
  link added (provisional decision P60); a prepend and a removal write the array
  of links whole, and so does a splice that shifts more than 16 positions
  (provisional decision P90). An array whose positions shifted is written once,
  when the transaction ends, from the link kept for each row by its key
  (`RowArray.links`, `#writeSplicedArrays` of `transactions.ts`; provisional
  decision P146); the rows that entered are written when their change arrives.
- *The buckets of a kept index as documents* (provisional decisions P88 and
  P89). `bucketDocumentCollections` of `exec/row-documents.ts` names a `groupBy`
  or a `keyBy` that is written in no element body and that the result keeps at a
  path through no element. `startCompiledPiece` gives the set to the executor
  (the `Instance` option `bucketDocuments`) and to the adapter, unless `rows` is
  `in-place`. The stored index is `{ kind, mode, buckets }` with no array of the
  occupied keys (`Instance.indexRecord`): the occupied keys are the names of the
  members of `buckets`, in the order the buckets came to exist. The executor
  writes the record `buckets` of such an index member by member: a bucket that
  emptied is removed, and each other bucket is compared by itself. The adapter
  stores the bucket of an encoded key in a document of its own, named by the
  document and the path of the record and by the key, with a link to it at the
  bucket's member of `buckets` in the result document (`BucketRecord`,
  `#bucketDocument`, `#writeBucket` of `transactions.ts`). A member that moves
  from one bucket to another writes the two documents and no link of the result
  document; the record of the index is given again at its path (P143).
  A bucket that comes to exist writes its document and one link, and a
  bucket that emptied loses its document and its link. A read at or above the
  record reads every bucket document. A second piece that is handed the stored
  index reads a bucket through the link, as it reads any stored link.
  - *The labels of a bucket document.* At a write at or above the record
    `buckets`, as the load makes it, each bucket document has the record of the
    index and stores the fold. A bucket document written after that is written
    under no record: it stores the join of what its transaction read, and the
    transaction reads the index at its own position in the result document
    (`kind`), so the join holds the entry of the index. For a read by the
    executor of a bucket at its path in the result document, the adapter names
    the position of the link as a position the read went through
    (`#crossedBucketLink`), and the label of the read joins what it consumes of
    the result document at that position with what it consumes of the bucket
    document. Three facts of the runtime decide this: a read that follows a link
    consumes the label of the document the link leads to and nothing of the
    entries above the link; the record of the index, instantiated for a write
    after the load, gives the clause of the member that changed and not the fold
    over every member; and a record of the plan has to name a path the
    transaction wrote, so the link of a bucket cannot be covered by a record at
    `buckets`.
  - *What it gives.* Measured on 2026-11-23 on the boards that keep one index,
    the result document at 1,000 topics is 0.81 MB and holds 66 label entries at
    every size of the board, where with the buckets in place it is 2.0 to 2.3 MB
    and holds 4,094 entries, four for each topic. On the boards that keep the
    index of the pairs as well, the result document is 1.14 MB at 1,000 topics.
  - *What it leaves.* A link to a bucket that comes to exist after the load
    stores two label entries at its path in the result document, the stamps of a
    write under no record, so the entries grow by two for each bucket made after
    the load. `keys()` and `keyEntries()` are not built; they would read the
    names of the members of `buckets`.
- *A row that holds its bucket by a link* (provisional decisions P142 and P143).
  A row of a per-element construct whose value holds what `lookup` gave, as it
  gave it, for an index of the same instance that the result keeps with its
  buckets as documents, stores a reference to the position of the bucket below
  the record `buckets` of the kept index. `Host.lookup` notes that position for
  the array of members it gives (`bucketPlaces`, `Instance.bucketRecordOf`), and
  `Instance.#formOf` stores the reference where the value of an output holds
  that array. The evaluation still depends on the bucket, and what reads the row
  in memory reads the members. A row derived from the bucket, as
  `lookup(topic).map((pair) => pair.from)` is, holds no bucket and is stored as
  a row of the result of another per-element construct. The link is to the
  position in the result document and not to the bucket's document, so a read
  through it reads the result document at `<index>/buckets/<key>`, below the
  entry of the index, and then the bucket's document.
  - *The record of the row.* The template of the output is the join of the key
    and of the output of the index. `Instance.#heldByReference` gives the record
    with the inputs of the output of the index replaced by inputs under which
    that output has no label: every slot a constant of the plan, every `fold`
    with no element. The label stored at the row's position is that of the key,
    and a change of the membership gives no record of the row
    (`Instance.#noteRecord`).
  - *The record of the index at its path.* Where a bucket changed,
    `Instance.#storeIndex` gives the record of the index at the path of the
    index as a record that forms the label alone (`#unchangedOutput`), so the
    entry above the buckets holds the membership as it is. A change of a label
    alone gives it there as well (`#relabel`).
  - *A key with no bucket.* The row holds an empty array in place under the
    record it had, which names the membership, so such a row is given its record
    again when the membership changes and its label goes stale as the second
    finding says. A reference to a position that holds nothing would read as
    `undefined` through the runtime where the executor in memory gives an empty
    array.
  - *What the layout leaves.* The bucket's document keeps the label it was
    written with, and the read consumes the entry of the index above the link
    beside it (questions 394, 406 and 442 of the design's plan).
- *A kept index stored bucket by bucket* (provisional decision P144). Where the
  buckets are documents of their own, the result of the instance holds the
  reference to the index and not the index. `Instance.#indexForm` stores the
  index whole the first time it stands at its path, and afterwards
  `Instance.#storeIndex` writes the buckets that a change of the assembly
  touched (`Index.changed`) and removes those that emptied. An index that is
  formed again whole is stored whole, each bucket compared. A member that moves
  between two buckets does not evaluate the result of the instance.
- *A change of the source of a `flatMap`, applied to its kept segments*
  (provisional decision P140). For a `flatMap` over an array of references whose
  bodies return the result of an inner per-element construct,
  `Instance.#reassemble` applies the splices of the source to the kept segments:
  the lengths, the dependencies on the inner assemblies, the members and the
  values of the elements that left are taken out, and the segment of each
  element that entered is formed and put at its place. Finding the place of a
  segment adds up the lengths of the segments before it, a step for each element
  and no read. A `flatMap` over an empty source keeps no segments and is formed
  whole at its first element.
- *The argument of a function body, read once* (provisional decision P91).
  `Host.invoke` of `exec/executor.ts` reads each entry of `Body.reads` with
  `Host.slot` and puts it at its path, and `Host.pass` copies the computed part
  of the argument. `pass` gives nothing at a path that a `value` or an
  `identity` entry of `Body.reads` fills, and the slot of an `enumeration` entry
  is read only where the entry does not give way to what the argument holds. So
  a `lift` over an array of plain values in place reads the array once for a
  call, and a `lift` that declares a record as a cell and reads one scalar of it
  as a value reads that scalar and not the record with every link followed. The
  emitter still writes the expression of the computed part; nothing is read from
  it.
- *The key of a stored plain value that holds links* (provisional decision P92;
  the second finding).
- *Reads through handles.* The crate emits the schema of the type a body
  declares for a handle (`ReadInput.schema` and `ComputedInput.schema`, from
  `body_record` of `src/plan.rs`), the executor reads through the handle under
  that schema, and a read under a schema that declares its members registers the
  positions of those members and not the root of the member's document
  (provisional decision P57). The read of a slot that observes which children a
  container has gives the members as references and reads none of them, where no
  slot of the cone reads a child as a value or a shape, or where every body of
  the cone that is handed the container declares a handle at each child
  (provisional decision P56).
- *The label readers.* The label of a write record is formed again when a label
  its inputs read changed and the record is not given again
  (`Instance.labelsChanged`; provisional decision P58). The store says for each
  change whether a read of a class at a position consumes the label it consumed
  before (`LabelChange.unchanged`), so an entry that a `Cell.set` of one field
  adds under the label of the document's root forms no label again. The records
  of the row documents that a `lift` writes are one reader of the labels of what
  the body read, and when the body runs again a row that holds what it held is
  given no record where the labels the body read are those it had read
  (provisional decision P59). The adapter finds the entries a read consumes
  through the runtime's index of a document's entries (`ConsumedLabelIndex`). It
  keeps the label identifier of each position of a document of the piece's space
  until a commit changes the document (`#labelIds`, cleared from the storage
  notification), and keeps the identifier the runtime's table gave a label by
  the label's text (`#internedByText`). A document of another space is not kept,
  since the adapter hears of no commit there. Without the two, forming and
  hashing the label of every position a `lift` read of every member took 263 ms
  of a create at 1,000 topics.
- *The preparation's asks for the reads.* The transaction freezes the read
  records it lists when `InputReadView` asks and returns a count that advances
  when the list gains a record or is emptied (`freezeReadActivityRecords` of
  `storage/interface.ts`, implemented in `v2-transaction.ts` and passed on by
  the two wrappers of `extended-storage-transaction.ts`). With the same list and
  the same count the view compares no record, and it classifies again only the
  distinct metadata objects that are not frozen; the sites of the runner that
  build a metadata object for a read freeze it. A transaction that does not
  offer the call, or hands out another list, is compared record by record. A
  record the view has copied refuses another metadata object with a `TypeError`;
  a metadata object changed in place is found at the next ask. The change is in
  a file the specification correspondence governs and on a path that runs with
  the option off. By the notes' classification it is a host arrangement in the
  terms of `docs/development/cfc-spec-correspondence.md`: it decides nothing and
  stores nothing (provisional decision P66).
- *Refused commits.* When a commit of the piece is refused, by the preparation
  or by the store, the adapter reads from the replica what the storage holds for
  each document of the executor that the transaction wrote, the piece takes it
  in place of what the executor holds (`Instance.restore`), which marks what
  read those documents, and the derivation runs. A document the storage does not
  hold is removed. The result document of an instance is taken with the rows of
  each of its collections left out, and the next derivation stores each path
  that differs and every row. The piece keeps the reason
  (`CompiledPiece.refusals`). An event that the executor itself refuses aborts
  the scheduler's transaction.
- *The harness.* `compare/runner-path.ts` starts today's piece with
  `Runtime.run` and the compiled piece with `startCompiledPiece` over the lists
  of `compare/fixtures/runner-lists.tsx`, sends with `Cell.send`, writes with
  `Cell.set`, awaits settled, compares the results and reports per change the
  time, the commits, the documents written and the preparation's counters. Its
  arm `alone` makes the same changes with no piece started, which is what the
  harness's own writes cost. With `--inputs-first` it commits the inputs before
  the piece is started, which is what lets the piece load in bounded
  transactions. The arm `runner` of `compare/topics/scale.ts` does the same for
  the Topics boards with the calls of its arm `today-labeled`: each topic and
  each input is a cell written under a schema with the clause of the input
  `topics`, an edit is a `Cell.set` of a field, and a create is `Cell.send` on
  `addTopic`. `compare/patch-cost.ts` starts no piece and measures what a change
  of one link of a document of links costs in the runtime's transactions and the
  memory server (the first finding). `compare/runner-corpus.ts` runs the main
  pattern of each corpus module as a compiled piece and beside it on the
  executor in memory ("The corpus on the runner path" below).
- *Tests.* `runtime/runner/test/compiled/piece.test.ts`,
  `row-documents.test.ts`, which holds the tests of the load in bounded
  transactions, `layout-labels.test.ts`, `refused-commit.test.ts`,
  `created-members.test.ts` and, for the buckets as documents,
  `kept-index.test.ts` and `crossref.test.ts`;
  `base/pattern-compiler/exec/test/body-argument.test.ts` and
  `value-references.test.ts` for the argument read once and the key of a plain
  value that holds links; and for the preparation
  `runtime/runner/test/cfc/InputReadView.test.ts`, which counts the work with
  `InputReadView.recordsCompared` and `InputReadView.metadataObjectsClassified`.
  The tests of the piece load the checked-in artifacts of `compare/fixtures/`
  and need no build of the crate.

- *Tests of the layout of the rows that hold a bucket, of the sorted move and of
  a create.* `runtime/runner/test/compiled/bucket-reference.test.ts` over
  `compare/fixtures/bucket-reference.tsx`, seven cases, among them one record of
  `mentionedBy` when a topic enters the array, no record of a row when a member
  enters its bucket, and the clause of a changed list of mentions consumed by a
  read of a bucket through the link of a row that no transaction wrote;
  `sorted-rows.test.ts` over `compare/fixtures/sorted-rows.tsx`, five cases that
  count the writes of the array (`RuntimeCounts.rowArraysWritten`); and, in
  `base/pattern-compiler/exec/test/`, `bucket-documents.test.ts`,
  `handler-enumeration.test.ts` and two cases of `crossref.test.ts` on the
  segments of a `flatMap`.

**Which comparison is like with like.** Today's piece computes what a reader
demands, so the harness pulls the whole result of today's piece in each step
(`Cell.pull`), and the figure of today's arm includes that pull. The compiled
piece derives without a reader, so its figure is taken without a pull, and the
pull of its whole result is reported apart. For having the result up to date
after a change, the runner's figure without a pull stands against today's with
it: on `filing-order` at 1,000 topics, an edit of the middle topic settles in 12
to 13 ms with the mentions declared as references and in 30 ms under the default
schema, against 9,459 ms for today's arm on the board with the three `lift`s
under the default schema. For a reader that reads the whole result after each
change, both include the pull: 4.5 s against 9.5 s, both on the boards with the
three `lift`s under the default schema. A pull of the compiled result reads
every row document and every topic in one transaction, and its time follows the
board on both arms. Today's runtime does not take the boards on the constructs,
and was not run again beside them.

**Topics on the runner path.** With the mentions declared as references
(`SCALE_TOPIC_SCHEMA=mentions-as-cells`), rows and buckets as documents, the
load in bounded transactions with the memory server's default limit, and no
pull; one process for each board and size. The time is from the write until the
board is up to date, in ms. The columns "on the constructs" are of 2026-11-23,
with the rows of the pivot holding their bucket by a link and the kept indexes
stored bucket by bucket: the median of three runs at load averages of 6.3 to
12.0, with a create the median of three creates in each run. The columns "with
the three `lift`s" are of 2026-11-22: one run at load averages of 3.4 to 4.4,
with a create the median of three. An edit of a title is one edit; the "write
alone" is a write of a field of the same topic that the board does not read,
which is what the write costs with no derivation behind it; the other edits are
of the middle topic; a create is `Cell.send` on `addTopic`.

| `filing-order` | `lift`s, 100 | 1,000 | 2,000 | constructs, 100 | 1,000 | 2,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| load | 450 | 4,031 | 7,485 | 458 | 3,754 | 7,572 |
| edit of a title, the first topic | 13 | 17 | 15 | 18 | 19 | 26 |
| edit of a title, the middle topic | 11 | 10 | 13 | 11 | 13 | 14 |
| edit of a title, the last topic | 9 | 9 | 265 | 10 | 184 | 12 |
| write alone, the first topic | 9 | 13 | 13 | not run | not run | not run |
| write alone, the middle topic | 7 | 143 | 10 | not run | not run | not run |
| write alone, the last topic | 6 | 19 | 11 | not run | not run | not run |
| edit of the mentions | 34 | 273 | 517 | 18 | 23 | 26 |
| edit of the `shortName` | 44 | 365 | 773 | 18 | 27 | 386 |
| edit of `lastActivityAt` | 7 | 9 | 14 | 8 | 9 | 11 |
| create | 158 | 1,034 | 1,783 | 98 | 279 | 547 |

| `sorted-references` | `lift`s, 100 | 1,000 | 2,000 | constructs, 100 | 1,000 | 2,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| load | 445 | 4,095 | 7,762 | 465 | 3,806 | 7,620 |
| edit of a title, the first topic | 13 | 16 | 16 | 18 | 20 | 30 |
| edit of a title, the middle topic | 10 | 13 | 14 | 11 | 14 | 15 |
| edit of a title, the last topic | 10 | 10 | 256 | 10 | 164 | 12 |
| edit of the mentions | 32 | 253 | 500 | 19 | 23 | 35 |
| edit of the `shortName` | 43 | 346 | 694 | 19 | 29 | 388 |
| edit of `lastActivityAt` | 57 | 445 | 868 | 18 | 52 | 81 |
| create | 163 | 1,163 | 2,019 | 102 | 315 | 590 |

The load of the boards with the three `lift`s is 3, 10 and 18 commits at the
three sizes. The cells on the constructs that are a pause in the harness's own
write and not the piece (the finding on pauses): the edit of the `shortName` at
2,000 topics on both boards, and the edit of the title of the last topic at
1,000. The lowest and the highest of the three runs on the constructs at 1,000
topics on `filing-order`: the load 3,622 to 3,908 ms, the edit of the title of
the first topic 19 to 19, of the middle 12 to 13 and of the last 13 to 294, the
edit of the mentions 19 to 216, of the `shortName` 25 to 33 and of
`lastActivityAt` 8 to 11, and a create 270 to 297. On `sorted-references`: the
load 3,696 to 4,021, the edit of the title of the last topic 14 to 196, the edit
of the mentions 21 to 202, of `lastActivityAt` 48 to 56, and a create from 297
to 332 ms. The write alone of 143 ms at the middle of 1,000 topics was seen
once.

What the layouts of the kept index changed. Each cell is the median of three
runs at 100, 1,000 and 2,000 topics on the boards on the constructs. The first
column is of 2026-11-22, with the kept index as one record of the result
document and the body's argument read whole. The second is of 2026-11-23, with
the buckets and the rows of `namesTable` as documents, the argument of a body
read once and a splice written as the array. The third is of 2026-11-23, with a
row that holds its bucket by a link, the index stored bucket by bucket, the
segments of a `flatMap` kept under a change of its source, the `enumeration`
entry of a handler's state read with no link followed, and the array of a sorted
order written once:

| Step | Index as one record | Buckets as documents | Rows hold the bucket by a link |
| --- | --- | --- | --- |
| `filing-order`, edit of the `shortName` | 42, 275, 969 | 20, 35, 389 | 18, 27, 386 |
| `sorted-references`, edit of the `shortName` | 47, 417, 1,037 | 20, 38, 349 | 19, 29, 388 |
| `filing-order`, edit of the mentions | not kept | 13, 16, 29 | 18, 23, 26 |
| `sorted-references`, edit of `lastActivityAt` | 38, 232, 558 | 19, 56, 94 | 18, 52, 81 |
| `filing-order`, create | 165, 1,109, 3,323 | 145, 792, 1,465 | 98, 279, 547 |
| `sorted-references`, create | 178, 1,293, 3,096 | 150, 763, 1,501 | 102, 315, 590 |
| `filing-order`, positions a create reads | 801, 7,101, 14,101 | 283, 2,083, 4,083 | 57, 57, 57 |
| `filing-order`, records a create gives | not kept | 202, 1,102, 2,102 | 102, 102, 102 |
| `filing-order`, the piece's own ms in a create | 50, 387, 1,636 | 41, 227, 435 | 17, 32, 46 |
| `filing-order`, the piece's own ms in an edit of the `shortName` | not kept | 5, 12, 16 | 3, 5, 4 |
| `filing-order`, records of an edit of the `shortName` | 20, 20, 20 | 18, 18, 18 | 10, 10, 10 |
| `filing-order`, bytes of the last commit of an edit of the `shortName` | 230,877, 1,998,490, 3,969,496 | 114,895, 819,607, 1,603,615 | 145,576, 1,136,488, 2,238,496 |
| `filing-order`, load | 431, 3,420, 7,993 | 495, 4,088, 8,773 | 458, 3,754, 7,572 |
| `sorted-references`, load | 437, 3,568, 7,997 | 503, 4,031, 8,424 | 465, 3,806, 7,620 |

Two cells of the third column are higher than those of the second. An edit of
the mentions writes the result document where it wrote four small documents,
since the record of the index is given at its path (P143): 18, 23 and 26 ms
against 13, 16 and 29. And the last commit of an edit of the `shortName` carries
a result document that holds one more record of links, for the index of the
pairs. The load writes one document for each bucket, for each row of
`namesTable` and for each topic that is mentioned: 12,011 documents at 2,000
topics, where the boards that keep one index write 10,011. It is linear in the
board, 4.6, 3.8 and 3.8 ms for each topic at 100, 1,000 and 2,000.

What one step does on `filing-order` on the constructs, at 100, 1,000 and 2,000
topics, from the first of the three runs, with the size as JSON of the documents
that the last commit of the step changed, from a fourth run:

| Step | Evaluations | Positions read | Records given | Piece's own ms | Preparation ms | Bytes of the last commit's documents |
| --- | ---: | --- | --- | --- | --- | --- |
| edit of a title, the middle topic | 5 | 11, 11, 11 | 9, 9, 9 | 2, 2, 3 | 3, 3, 3 | 8,630, 8,636, 8,642 |
| edit of the mentions | 10 | 4, 4, 4 | 2, 2, 2 | 3, 4, 4 | 4, 6, 7 | 152,050, 1,142,954, 2,244,954 |
| edit of the `shortName` | 7 | 11, 11, 11 | 10, 10, 10 | 3, 5, 4 | 4, 6, 10 | 145,576, 1,136,488, 2,238,496 |
| edit of `lastActivityAt` | 3 | 10, 10, 10 | 7, 7, 7 | 2, 2, 2 | 2, 2, 2 | 5,877, 5,880, 5,883 |
| create | 20 | 57, 57, 57 | 102, 102, 102 | 17, 32, 46 | 19, 39, 65 | 168,952, 1,159,875, 2,261,877 |

The bytes of the last commit of an edit of the mentions, of an edit of the
`shortName` and of a create are those of the result document. On
`sorted-references` an edit of `lastActivityAt` evaluates 5 entries, reads 10
positions and gives 11 records at every size, with the piece's own time 3, 9 and
15 ms and the preparation 4, 17 and 31 ms. With the three `lift`s the same edit
reads 410, 4,010 and 8,010 positions and gives 403, 4,003 and 8,003 records, a
create on `filing-order` reads 2,061, 19,161 and 38,161 positions and gives 91
records with 41, 297 and 510 ms in the piece and 41, 282 and 503 ms in the
preparation, and an edit of the mentions reads 1,000, 10,000 and 20,000
positions and gives 4 records.

The coordinator ran `filing-order` on the constructs on the runner path at 1,000
topics on 2026-11-23, at the commit this section is read at, with the mentions
declared as references and rows and buckets as documents, one run: the load
takes 3,686 ms; an edit of the title of the first, the middle and the last topic
19, 13 and 11 ms; an edit of the `shortName` 27 ms and of `lastActivityAt` 10
ms; and the creates 277 to 303 ms, with 57 to 76 positions read and 101 to 103
records. The coordinator ran the board with the three `lift`s on 2026-11-22
under the default schema: the load takes 3,673 ms, an edit of the title of the
first, the middle and the last topic 21, 30 and 43 ms, and a create 1,029 to
1,084 ms; under that schema the time of an edit follows the position of the
topic, for the cause of the finding on the harness's subscription. Every other
figure of this section is the build agents'.

On the constructs under the default schema, measured on 2026-11-22 with the kept
index as one record of the result document, the times are within a tenth of
those of the same day under the schema with the mentions declared as references
at 100 and 1,000 topics. Nothing newer exists under that schema.
**Topics with the three `lift`s under the default schema.** Of 2026-11-22, with
the load in one commit and rows as documents. Nothing newer exists for these
rows. Times in ms.

| | 100 topics | 1,000 topics | 2,000 topics |
| --- | ---: | ---: | ---: |
| `filing-order`, the piece's own time in an edit of a title | 3.8 | 3.0 | 3.1 |
| `filing-order`, a pull of the whole result behind an edit | 376 | 4,507 | 10,071 |
| `sorted-references`, a pull of the whole result behind an edit | 369 | 4,879 | 10,483 |
| `filing-order`, today's runtime, an edit of a title, with its pull | 765 | 9,459 | not run |
| `filing-order`, today's runtime, write alone, with its pull | 481 | 5,987 | not run |
| `sorted-references`, today's runtime, an edit of a title, with its pull | 679 | 9,399 | not run |
| `filing-order`, today's runtime, a create, with its pull | 1,520 | 16,531 | not run |

Today's arm was not run at 2,000 topics: its load at 1,000 takes 110 to 125 s,
76 s of one run in the preparation, and the run would pass ten minutes.

The board `main` was measured on the runner path on 2026-11-22 without the reads
through handles and the label readers: an edit takes 349, 3,400 and 9,946 ms at
100, 1,000 and 2,000 topics, against 986 and 14,478 ms for today's runtime with
its pull at 100 and 1,000. No rows of `main` are documents, and its cards are
the output of one `lift` over the whole array of topic references, which reads
every title. One run of today's runtime on `main` at 2,000 topics took 30.8 to
37.3 s for an edit.

**The fixture of growth.** `compare/runner-path.ts`, the list `Cells` of
`runner-lists.tsx`: a `map` over an array of references that the type declares
as references, rows as documents. No topic schema enters. The table is of
2026-11-22, with the load in one commit: the mean of five changes after the
first of a kind. The compiled arm is without a pull; the arm `alone` makes the
same change with no piece started; today's arm includes the pull of the result
and is of another run of that day, at a load average of 7 to 10. Times in ms.

| Change | compiled, 100 | 1,000 | 10,000 | alone, 100 | 1,000 | 10,000 | today, 100 | 1,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| edit one field | 3.6 | 3.2 | 5.5 | 1.3 | 1.8 | 3.4 | 82 | 689 |
| append | 17 | 72 | 837 | 10 | 62 | 725 | 140 | 1,250 |
| prepend | 23 | 163 | 2,535 | 15 | 126 | 1,963 | 194 | 1,584 |
| remove first | 19 | 146 | 2,546 | 13 | 134 | 1,839 | 111 | 1,098 |
| remove last | 13 | 85 | 1,096 | 8 | 55 | 822 | 94 | 923 |

The piece gives 6 records for an append, 4 for a prepend and 1 for a removal at
every length, and writes 5, 4 and 3 documents. Most of each change of the
members is the harness's own write, a `Cell.set` of an array of `N` links and
the preparation of that commit. What the piece adds is 7, 10 and 112 ms for an
append and 8, 38 and 570 ms for a prepend at 100, 1,000 and 10,000 rows. A pull
of the compiled result takes about 24, 200 and 2,400 ms. With the rows in place
an edit of one field of one member takes 10.6, 62.9 and 794 ms: it follows the
length of the list, as today's does.

The load of this fixture in bounded transactions, with `--inputs-first` and the
memory server's default limit:

| The load, `Cells` | 100 rows | 1,000 rows | 10,000 rows |
| --- | ---: | ---: | ---: |
| load, ms | 78 | 471 | 4,598 |
| commits of the load | 3 | 6 | 42 |
| preparation in it, ms | 13 | 80 | 721 |
| the harness's write of the inputs before it, ms | 114 | 573 | 6,278 |

Of the 6,278 ms of the harness's write at 10,000 rows, 3.1 s are the
preparation, for the product within one document of the finding on the
preparation above. In one transaction with the inputs the load takes 170 ms, 1.0
s and 42.5 s, and 10,000 rows need the memory server's limit raised.
Today's load takes 1.8 s at 100 rows and 70.6 s at 1,000, of which 66.5 s are
the preparation, and was not run at 10,000.

**What an edit of a title does, at every size.** On `filing-order` and
`sorted-references` with rows as documents, the writer's commit changes the
topic's document, and the piece's derivation evaluates 5 cone instances (the row
of `mentionable`, the strings of the card, and the card), reads 11 positions
through the transaction, gives 9 write records and commits two row documents.
Three documents are written in 2 commits, the topic and the two rows. No
whole-list `lift` runs, and the result document is not written. An edit of a
body, an author or a comment count is the same. Five things make it so: the
cards and the rows of `mentionable` are documents of their own; a body that
reads `mentions` and `shortName` through a handle typed with those members is
not marked by a change of the title; the read of the array of topics for its
members and their number reads no topic; a read that finds what a reference
names is no read of what is stored below the named position (provisional
decision P79); and a change of a label that leaves an element of a folded
collection in its group gives no record of the fold again (provisional
decision P82). Without the last, every edit of any field of a topic gives a
record of the index of the pivot by name, and the piece and the preparation
then read each label entry of the document that holds the index: measured on
2026-11-22 with the index in the result document, an edit of a title took 48 ms
at 1,000 topics and 89 ms at 2,000.

**The constructs.** Four `lift`s of a Topics board with the three `lift`s run on
a create, each over the whole array of topic references or over a result of
one. `topicCount` reads the number of members, and nothing is to change there.
The other three read every member where one changed, and so does the `lift`
`topicsByActivity` of `sorted-references` on an edit of `lastActivityAt`. Each
construct below keeps its result under a change of one member by reading that
member alone, which is what `map` does for a row. The crate emits each in the
plan and the value code, the executor runs it in memory and on the runner path,
and each has tests of its values, of the work of one change at two sizes, and of
its stored labels. The label rules are the build agents' reading of
`plan-and-label-templates.md` §3.17 and are not reviewed against the
specification; by the ruling Z88 the open questions of labels are noted in the
design's plan and taken up after the milestones.

- *The collection index: `xs.groupBy((x) => key)`, `xs.keyBy((x) => key)` and
  `index.lookup(k)`* (provisional decisions P67, P72, P73 and P75 to P77). This
  is the surface that `language-subset.md` §4.4, `plan-and-label-templates.md`
  §3.17 and today's runtime already have; no new function is added. The
  callback has the grammar of a `map` callback and gives one key: a string, a
  number, a boolean or a cell; `null` and `undefined` leave the element out.
  - *By case.* Over an array of references a bucket holds the references of its
    members in the order of the source. Over an array of plain values in place a
    bucket holds a reference by key to each member's position in the source
    array. Over the result of another per-element construct a bucket holds a
    reference by key to the row where the rows are documents of their own, and
    a copy of the row otherwise.
  - *The plan.* A `Collection` whose `construct` is `groupBy` or `keyBy`, whose
    body cone is the key function, observed as `value` for a scalar key and as
    `identity` for a cell, an object or an unknown (`Emitter::collection` and
    `Emitter::key_class` of `src/plan.rs`). The plan holds no `Operation` of
    kind `index`, which is what `plan-and-label-templates.md` §3.17 has.
  - *The label rule.* The membership of a bucket, its count and its order: the
    membership of the source joined with a `fold` of the key function's
    template over every element of the source, and not over those in the
    bucket. The occupied keys have the same template. A `lookup` has the
    template of the key joined with that fold, for a key that has a bucket and
    for one that has none. An element of a bucket is the source element passed
    through, whose content is labeled where it is stored.
  - *The work of one change.* The executor keeps, for each element key, the
    encoded index key, and for each index key the element keys of its bucket in
    source order (`Index` of `exec/executor.ts`). A change of one member's key
    evaluates that member's key function, takes the member out of one bucket
    and puts it into another at its place in the source order, and marks what
    looked up either key; what looked up a key depends on that one bucket
    (`Host.lookup`). On the executor in memory, with the members spread over ten
    tags, a change of one member's key evaluates 7 entries and changes 2 buckets
    at 10, 100, 1,000 and 10,000 members, and takes 1.1, 0.3, 1.1 and 8.7 ms; an
    append evaluates 5 and takes 0.4, 0.2, 0.7 and 4.7 ms. The counts do not
    follow the collection; the time follows the size of the buckets that
    changed, a tenth of the members here.
  - *Stored.* An index that the result keeps at a path through no element is
    stored as `{ kind, mode, buckets }`, with each bucket in a document of its
    own and a link to it at the bucket's member of `buckets` ("The buckets of a
    kept index as documents" above). The result holds such an index by
    reference, and a change stores the buckets that changed by themselves
    (provisional decision P144). With `rows` at `in-place`, and for an index
    kept in an element body, the buckets are in the result document, with a
    label entry at the index and at each bucket. An array of scalars that
    differs from the stored one at more than one position is written whole with
    one record (provisional decision P83). A second piece that is handed a
    reference to the stored index and looks up one key reads that bucket,
    evaluates nothing when another bucket changes, and follows its own.
  - *Not covered.* `keys()` and `keyEntries()` are not built. A `lookup` by a
    cell in an index the instance is handed, and a key whose type the crate
    does not resolve, are listed as unsupported; the crate does not resolve the
    type of a row of a `map` written in the body of a `flatMap`, so the key
    function of an index over such rows has its parameter annotated. A key
    function passed by name is refused. One label entry for all buckets, and
    the state document of `execution-and-storage.md` §6.3, are not built
    (provisional decision P69).
  - *Against today's runtime.* The values of the fixture `keyed-join.tsx`, over
    plain values in place, are equal, 2 of 2. Today's runtime gave the members
    of a bucket in another order than the source's for an array of cells in one
    probe; the executor gives the source order.
- *The keyed join* (provisional decision P68) has no construct of its own. It is
  a `map` over the rows whose body calls `index.lookup(key)`. In `group` mode
  the lookup is a collection, so the body can pass it on, read its length or
  `map` over it. A source that names several keys, as a topic names the topics
  it mentions, is first spread into one element for each pair with a `flatMap`,
  whose rows the grouping then holds.
  - *By case.* The rows are those of the `map`: over an array of references each
    row is a document of its own where it is a record; over plain values in
    place, or over the result of another per-element construct, the rows are in
    place. A `map` over the members of a bucket is a `map` over the result of
    another per-element construct whose elements have the keys they have in the
    index's source, so it forms no key of its own (provisional decision P76).
  - *The label rule.* A row has the label of what its body reads of its own
    element and, for the lookup, the template of the key joined with the fold
    over every source. A row whose key no source names still depends on every
    source's key. What the body reads of a matched member is a read through
    that member's reference and has that member's label.
  - *The work of one change.* On the runner path, with items and tags as cells,
    a write of one item's tag by another writer moves the item between two
    rows: 7 evaluations, 4 write records and 2 commits at 12, 120 and 600 items,
    and 11, 65 and 305 positions read, which follows the bucket that changed
    (half the items).
  - *Stored.* A row whose value holds what `lookup` gave, for a kept index of
    the same instance with buckets as documents, holds a link to the position of
    the bucket and is not written when the bucket changes; a row whose key has
    no bucket holds an empty array in place ("A row that holds its bucket by a
    link" above). A row whose body derives something from its bucket stores the
    fold and is given its record again when the membership changes under another
    label.
  - *Not covered.* A key function that returns several keys, and a row whose key
    has no bucket held by a reference.
- *`Object.entries(record).map(([name, value]) => row)`* (provisional decisions
  P70 and P78), over a record that is an input. The key of an element is the
  entry's name, so a row keeps its identity while its name is in the record.
  - *By case.* Over a record of references, `value` is the reference at the
    entry, and the rows are documents of their own where the schema of the
    record declares its values as cells and the row is a record or a view node.
    Over a record of plain values in place, `value` is the value at the entry
    and the rows are in place. `Object.entries` of a record that the instance
    computed is a plain array generated from scratch, and the `map` over it is
    the `map` over such an array that the language has.
  - *The plan and the label rule.* A `Collection` of construct `map` over the
    slot of the record with `source.entries`, the record observed as
    `enumeration` (`Emitter::entries_of_record` of `src/plan.rs`). The
    membership, the count and the order of the rows, and the name of an entry,
    have the label of that enumeration; the value of an entry has the label of
    the reference or the value there; a row has the label of what its body
    reads, and no row depends on another entry.
  - *The work of one change.* One body for a change of one member, none for a
    field no body reads, one for an entry added among 10 and among 1,000, none
    for an entry removed. The record is located whole for each change of it and
    the element table is formed again, so the steps of the assembly follow the
    record.
  - *Not covered.* `Object.keys(x).map` and `Object.values(x).map` stay the
    expression over the whole record. A `filter` or a `flatMap` over the
    entries is not recognized. A record whose entry a handler removes and adds
    again under one name within a transaction keeps the row's state. On today's
    runtime the expression stands inside a `computed`, and the fixture gives
    the same rows for a record of plain values and, where the members hold what
    their type declares, for a record of cells.
- *`xs.sortBy((x) => key)`* (provisional decisions P85 and P86), ascending, with
  one key function; a descending order is a negated numeric key.
  `base/api/index.ts` declares no `sortBy`, so a source that uses it does not
  run on today's runtime.
  - *The order of keys* (`compareSortKeys` of `exec/executor.ts`): numbers by
    value, texts by their code units, `false` before `true`; a number before a
    text before a boolean; `null`, `undefined` and `NaN` behind every other key.
    Equal keys keep the order of the source. Texts are not compared with
    `localeCompare`, whose order follows the locale of the process.
  - *The plan and the label rule.* A `Collection` whose `construct` is `sortBy`,
    with the key function as its body cone, observed as `value`. The membership
    and the order have the template of a `filter`: the `fold` of the key over
    every element, joined with the source's membership. An element is the
    source element passed through. So a read of a position depends on every
    key, and a row's content on its own member alone; with rows as documents
    the link at a position has the fold and the row's document its own label.
  - *By case.* Over an array of references the assembly keeps the key each
    element was placed by and its members in sorted order. An element whose key
    changed is taken out at its old place and put in by binary search: two
    splices, which a `map` over the result applies with one evaluation of the
    body of the element that moved, 6 evaluations for a change of one key among
    1,000 elements as among 10. The rows of a `map` over a `sortBy` of an array
    of references are documents of their own. Over the result of another
    per-element construct the order is formed whole for each change: one change
    among 16,000 elements of the fixture takes 158 ms. An element that moved in
    the source forms the order whole.
  - *Stored.* An array of references in the sorted order; a move that shifts
    more than 16 positions is one write of the array of links, made once for a
    transaction (provisional decisions P90 and P146; the finding on a move
    above).
  - *On `sorted-references`* the cards are a `map` over
    `topics.sortBy((topic) => -(topic.lastActivityAt || topic.createdAt))`. A
    topic whose key reads as `undefined` has a card behind every other, where
    the `lift` leaves it out.
- *The segments of a `flatMap`* (provisional decision P84). Where every body of
  a `flatMap` over an array of references returns the assembled result of
  another per-element construct, the assembly keeps the length of each segment
  and its dependency on each inner assembly (`Rows.segments`). A change of one
  element or of its inner assembly puts the members of that segment in the
  place of those it had, as one splice, which a collection over the result
  applies as it applies the splices of a `map`; the members behind the splice
  are numbered again, a step for each and no read. One segment is formed for a
  change of one topic's mentions among 1,000 topics as among 10. A change of
  the source array takes out the segments of the elements that left and forms
  those of the elements that entered (provisional decision P140). A `flatMap`
  over an empty source, and one whose body returns a stored array or writes one,
  form the assembly whole.

*On the Topics boards.* `crossrefTable` is a `flatMap` over the array of topic
references that gives one pair for each mention, a plain value in place that
holds two references; a `groupBy` of the pairs by the topic mentioned, a cell;
and a `map` over the array of topic references whose row holds `mentionedBy:
byMentioned.lookup(topic)`, the pairs of its topic as the lookup gave them
(provisional decision P145). The rows of that `map` are documents of their own,
and each holds its bucket by a link. The result keeps the index of the pairs as
`mentionIndex`. `crossrefIndexOf` is `pivot.groupBy((row) => row.name)`, an
index over the result of a `map` over an array of references, whose buckets hold
references to the row documents. `namesTable` is
`Object.entries(names).map(([name, member]) => ({ member, name }))` in a
`computed`, over a record of references; its rows are documents of their own,
since the boards declare the values of `names` as cells (provisional decision
P87). The verb `addTopic` is a handler whose state declares the mention
universe, the pivot and its index as cells. A topic reads its backlinks in the
`lift` `backlinksOf`, which reads the one bucket of the topic's number in the
stored index by its key and `from` of each pair of it; it does not call
`lookup`, since the input is the one that `main.tsx` hands the index of the
`lift` through. Two things differ from the boards with the three `lift`s: a
topic that the board lists at two entries has two rows of the pivot, and a key
of the namespace that the name grammar does not admit has a row of the table.
The facts the harness reads of the board at 100 topics, over the load and every
step, equal those of the boards whose rows held the topics that mention. The
crate's check refuses both boards with two errors `subset-type:mismatch` each:
the handler `addBoardTopic` declares `names` as a cell of a record of unknown
values, and the board hands it a cell of a record of cells. The harnesses
compile them with `emit --unchecked`, so the measured boards run from artifacts
no check accepted.

**What still grows, and why.**

- *Every write of a document that holds a list of links,* for the cause of the
  finding on it, which is the runtime's and not the piece's. On the boards these
  are the result document, at an edit of the `shortName`, at an edit of the
  mentions that changes a bucket, at a move in the sorted order and at a create,
  and the two inputs a create appends to.
- *The time of a create,* which reads and records the same at every size: three
  documents as long as the board in the memory server, the preparation and the
  hashing, the array of cards on `sorted-references`, and the table of the
  entries of the namespace formed whole (the finding on a create).
- *The size of the two buckets a change of a key touches* (the finding on the
  three costs).
- *A change of the members of an array of row documents.* A prepend, a removal
  and a move that shifts more than 16 positions write the array of links whole,
  `N` links, once for a transaction, because the executor gives the record of a
  change of the members of a kept `map` as one that names the array, and the
  runtime refuses a record that names a path the transaction did not write. The
  piece also compares the members of the array before and after a change by
  another writer, and the executor brings the keys of the assembly up to date.
  An append writes the number of members and one link. Most of the time of each
  is the write that causes the change, on either path.
- *The load.* It follows the board and is linear in it, at 3.8 ms a topic: 3.8 s
  at 1,000 topics and 7.6 s at 2,000 on `filing-order`. The profile of one load
  at 2,000 topics, 10.2 s under the profiler at a load average of 11: the
  piece's own 5.1 s, of which the commits of the row documents in bounded
  transactions are 1.9 s (the runtime's preparation and storage), the
  evaluations 1.3 s, the write records 0.7 s (`#outputRecord`, of which
  `#shareKey` and `#labelsOf` 0.3 s), the stored form and the canonical text of
  each value 1.0 s (`Instance.stored`, `canonical`), the forms of the rows 0.5
  s, and the adapter's encoding 0.36 s. Outside the piece: the preparation of
  the handed transaction 1.5 s, the memory server's `applyCommitTransaction` 1.1
  s, garbage collection 0.8 s, `compressLabelMetadata` 0.75 s, `deepFreeze` with
  its weak table 1.3 s, and hashing 0.67 s. About 3 s of the 10 are the
  executor's: the evaluations, the write records and the canonical texts. The
  canonical text of a value is formed at each evaluation to compare with at the
  next one; forming it when the entry is next evaluated would take it out of the
  load, and needs the entries whose value the executor changes in place, an
  index among them, kept apart, which is not built. Today's runtime loads
  `main.tsx` at 1,000 topics in 14.7 to 17.7 s with no label stored and in 37.7
  to 110 s with labels, in the measurements of milestone 2 and of 2026-11-22; it
  was not measured again beside this load.
- *The preparation of a document that holds a long array of links* (the finding
  on the preparation above).
- *The memory server's refresh of tracked queries,* for a subscription whose
  schema admits links (the finding on the harness's subscription above). The
  piece's commit of two row documents is walked as well, since each row holds a
  reference to its topic.
- *The work after a refused commit* follows the size of the result, since the
  result document is stored again row by row.
- *The comparison of every unit of the result in each derivation* (the finding
  on it above): 2.9, 4.5 and 5.6 ms of the piece's own time in an edit of a
  title on `sorted-references` with the three `lift`s. On the boards on the
  constructs the piece's own time in an edit of a title is 2 to 4 ms at each
  size, and what of it is this comparison was not separated.
- *A copy of each stored value that a body reads* (`Store.read`), which follows
  the size of what a body is handed.
- *A pull of the whole result* follows the board on both arms: 0.4 s, 4.5 s and
  10 s at 100, 1,000 and 2,000 topics on the runner path, on the boards with the
  three `lift`s under the default schema.
**Over-labels found.** `runtime/runner/test/compiled/layout-labels.test.ts`
starts each list of `runner-lists.tsx` twice in one runtime, with rows as
documents and with rows in place, over items that each have a clause of their
own, and reads the root, the array, the number of members, each position and
each leaf of a row through a cell. What a read consumes is the join the runtime
derives from the reads of that transaction (`deriveFlowJoin`). After the load,
an edit, an addition at the end and a removal, rows as documents give no clause
less than rows in place at any of these, for a `map` over an array declared as
references, a `map` over an array of references declared as plain values, a
`map` over an array of plain values in place, and a `map` over the result of a
`filter` over an array of plain values in place. On Topics boards of 4 topics,
each with a clause of its own, 3,474 probes over the load, three edits and three
creates give the same in both layouts after the load and after each create.

- *A load in one transaction, at what is bound through the argument.* On boards
  of 6 topics with a clause per topic, 4,652 probes of what a read of the result
  consumes over the load, three edits and three creates: the load in bounded
  transactions gives the same as the load in one transaction at 4,546, less at
  106, on both boards, and more at none. The 106 are at `topics`, `names`,
  `namesTable` and `index`, whose records are bound through the argument
  document. In a load in one transaction that document is staged, and a staged
  document takes the join of everything the transaction read, so each of the
  four holds the clause of the other input. With the creation stored first they
  hold the label of the reference alone. A load that is written into the handed
  transaction whole, because the caller wrote into it or `loadRows` is
  `Infinity`, has this over-label.
- *Rows in place, after an edit below `$UI`.* After each edit rows as documents
  give less than rows in place at 134 probes on `filing-order` and 105 on
  `sorted-references`, all below `$UI`, and more at none. At each of them rows
  as documents give what both layouts gave after the load. An edit that writes
  below `$UI` in the result document removes the entries the document stored at
  `$UI` (`value`, with no clause) and at `$UI/children` (`enumerate`), and a
  read below `$UI` with no nearer entry then consumes the entry of the root,
  which holds every clause the load read. This is an over-label of rows in
  place, which is not the default layout.
- *A result that holds nothing but links, with rows as documents.* The result of
  `Cells` is the array of links alone. The runtime takes a written value that
  holds nothing but links for a structure of links and stores, for every child
  of its root, the join of the transaction that wrote it, so every read below
  the root consumes every clause, where rows in place give a leaf the clause of
  its member. With a plain value beside the array (`Counted` of
  `handle-reads.tsx`) a leaf of a row consumes the clause of its member alone.
  *Plan:* the adapter gives the record of the array for each link position of
  such a result, as `#recordAppended` does for the links an append adds.
- *The `value` slot the crate lists beside a handle.* For `crossrefTable` and
  `namesTable` the crate lists a `value` slot at `sources.*` beside the handle,
  from the helpers that test a member for presence. The body is handed a handle
  at each member, so the executor reads no member for that slot, and the slot
  stays in the template: the label of each row holds the label of a read of each
  topic whole. It is the crate's to narrow. This is of the boards with the three
  `lift`s.
- *The name of a row of `Object.entries(record).map`.* The name is bound to no
  stored position, so its record takes the join of the transaction that derived
  the row, which holds the clause of every member the transaction read. *Plan:*
  bind the slot of the name to the `enumeration` of the record. Where the rows
  are documents of their own the name of a row has the clause of the record and
  of no member.
- *A constant beside the rows,* as `kind: "table"`, has no record of the plan
  and takes the join of the transaction, which holds the clause of the record.
- *The result of a piece that is handed a kept index.* The `name` of the second
  piece's result in `kept-index.test.ts` consumes the clause of every item
  beside its own. Not examined; the crate reads the handed index with `$h.read`
  and no slot.
- *A bucket document written after the load.* It is written under no record and
  stores the join of what its transaction read, which is more than the fold of
  the keys. The link to a bucket that comes to exist after the load stores two
  entries at its path in the result document.
- *A splice written as the array.* A transaction that splices an array of row
  documents in the middle reads the array of links whole, so the join of what it
  read, which a write under no record stores, holds the label of the array.

A test of stored labels over a result that holds nothing but links tests
nothing, since every path there consumes every clause: the fixtures of the
constructs hold a number beside the rows that no clause reaches.

**The corpus on the runner path.** `compare/runner-corpus.ts` runs the main
pattern of each module as a compiled piece, with the generated inputs as plain
values in the argument and the generated events queued with the scheduler, and
beside it on the executor with its documents in memory. Value code is evaluated
in the compartment of milestone 5; with `new Function` no module has another
outcome. The comparison is with the executor in memory and not with today's
runtime, which was not run beside it; the value comparison of
`compare/values-corpus.ts` is what relates that executor to today's runtime. The
inputs are plain values, so the run says little about labels. The comparison
orders the members of each record. A `wish` is answered from the table of a
seeded home (`compare/wish-home.ts`, through the option `wishes` of the
instance; provisional decision P197), except under `--resume` and `--serving`,
where nothing hands the table to the piece that takes over. Measured on
2026-11-23, one run:

| Of 375 modules | |
| --- | ---: |
| not run: exports no pattern | 68 |
| not run: requests an effect | 30 |
| not run: no value code | 4 |
| not run: a `wish` the home does not simulate | 1 |
| run | 272 |
| started, with the first commit taken | 258 |
| handled every event | 219 |
| had no commit refused | 248 |
| hold the values the executor in memory holds | 228 |

Without the table of the home, 40 of those modules are left out for a `wish` and
239 are run: 230 start, 200 handle every event, 215 have no commit refused, 210
hold the values of the executor in memory, and 183 do all four. With the table,
194 did all four at the commit that added it; the count was not made again at
the head. Of the 40 modules with a `wish`, 28 start: 11 take every event and
hold equal values, and 17 start and either differ from the executor in memory,
at `$UI` in most, or have an event with no stored stream or one whose handler
did not commit. Why the 17 differ was not examined: the executor in memory reads
the home from documents it is given and the piece from the storage, under other
identifiers.

The classes of failure:

- *Did not start, 14 modules.* The value code throws in 5. The executor has no
  built-in `spaceMembers` (2 modules), `indexedCollections`, `getEntityId`,
  `spaceDeleted` or `linksOf` (1 each) in a function body, and no function for
  one element construct. The preparation refuses the first commit in 2.
- *An event not handled, 39 modules.* In 29 no stream of the binding is stored:
  the binding is in an element body and its collection has no element, or the
  stream belongs to an instance a body made. In 10 the handler did not commit.
- *A commit refused, 12 modules.* A missing trusted-event policy input, 6; an
  unsupported trust-sensitive claim, 3; `maxConfidentiality`, 2; a writer-fit
  misfit, 1.
- *Values differ.* Not examined, beyond that a draw of the random source or of
  the clock in an event differs between the two runs by construction.
  `product/primitives/demo/atoms-demo.tsx` handles 7 of 20 events and
  `showcase/inductor/pool/inductor-pool.tsx` 0 of 3, each with "the handler did
  not commit", where a transaction was aborted before the marker of a stream
  that the state of a binding alone holds was written; why the two handle fewer
  events with the marker was not examined.

**Not verified.**

- A handler that the scheduler runs again after a conflict was not driven
  through the scheduler in a test: with the server's fan-out held, the
  scheduler's wait for the replica has no end.
- A refused commit of a transaction that created an instance is not tested.
- A load in bounded transactions whose handed transaction is not committed, or
  is refused by the store, is not tested for what it leaves;
  `refused-commit.test.ts` loads with `loadRows` set to `Infinity`, since its
  harness withholds the server's fan-out and the commits of the adapter keep
  `StorageManager.synced()` waiting.
- No step of the Topics boards was measured with a clause for each topic, so
  the size of the labels that the constructs store there is not measured.
- The label rules of the constructs are the build agents'. The tests of stored
  labels read what a read consumes in the runtime's own resolution; none
  compares a construct with today's runtime, which stores a narrower label for a
  bucket by the decision of `plan-and-label-templates.md` §3.17.
- A bucket whose members are copies of rows in place, the label of a value
  reached by crossing a link in a member, and a read of one position among the
  occupied keys of a kept index, were not compared.
- The load at 2,000 topics was not measured under the default schema, and the
  boards on the constructs were measured under it only with the kept index as
  one record of the result document.
- The difference between two measurements of a create at 2,000 topics of
  2026-11-22, 2,174 and 3,323 ms on the same reads, is not explained beyond the
  spread of a major collection.
- The tests of `sorted-rows.test.ts` were written after the code.
- A reference to a position that holds nothing, which a row whose key has no
  bucket would hold, was not read through the runtime.
- The edit of the last of 2,000 topics that took 256 to 265 ms with the three
  `lift`s, and the write alone of 143 ms seen once, were not profiled.
- The profiles of the steps are of the board `filing-order` at 2,000 topics.
  `sorted-references` was not profiled.
- Each cell of the boards on the constructs is the median of three runs on a
  machine with other load.
- Today's runtime was not run beside the boards on the constructs, which it does
  not take, and was not measured again. Its figures are of `main.tsx` and of the
  boards with the three `lift`s.
- No real board was measured for what the memory server's refresh of tracked
  queries costs.
- The 7 corpus modules whose values differ on the runner path are not examined,
  and the corpus was not run beside today's runtime or with labeled inputs.
- No figure of this section is of two writers that share a space, of a memory
  server reached over a socket, or of an idle machine. The tests of this section
  pass over a socket ("Milestone 6: server execution and the network" below).
- The board `main` and the rows-in-place layout of the Topics boards were not
  measured with the reads through handles, the label readers or the constructs,
  and today's arm was not run at 2,000 topics on the boards with the three
  `lift`s.
- The comparison of what a read consumes in the two layouts is at 4 topics and
  on the four lists of `runner-lists.tsx`, and that of the two loads at 6
  topics; each compares two arrangements of the compiled piece and neither with
  today's runtime.
- Which function copies frozen values in an edit, and how much, was not profiled
  apart.
- The document of a row that left is deleted in the transaction that removes its
  link. A reader that held the link then reads nothing; no test covers such a
  reader.
- An entry at the position of a link added at the end stays until the array is
  next written at or above it (P60); no test reads it after a later prepend.

**Not built.**

- *A row whose key has no bucket held by a reference* (provisional decision
  P142). Such a row holds an empty array in place under a record that names the
  membership, so its label goes stale and it is given its record again when the
  membership changes. The state document of an index of
  `execution-and-storage.md` §6.3 and one label entry for all buckets
  (provisional decision P69) are not built beyond the entry of the index that
  P143 keeps current.
- *The order of a kept collection of row documents in chunks.* The array stored
  as documents of at most 64 links, with the result holding the list of the
  chunks: a move writes the two chunks it touches, and an append the last. The
  part documents of provisional decision P20 (`exec/parts.ts`) are this for an
  array above a size, and the runner path runs with `parts: false`. What it
  needs: the adapter's `#placeOf` and `read` for a position of the array, which
  find the chunk as they find a row's document; a reader through the runtime
  that reads the children of a view node through the chunks, which is a change
  of the renderer or a flattening read; and the label of the membership at the
  list of chunks, where a read of any position passes it, as the entry of an
  index stands above its buckets. An order key for each row with the reader
  sorting, and a linked order, both change what the children of a view node are
  for every reader, and were not taken.
- *A move of one row that sends a splice.* It needs a record for each position
  written, or a record of the plan that covers the positions of a splice (the
  finding on the wire form).
- *A read of a stored value that is frozen and not copied.* `Store.read` copies
  what it reads. The plan is in "Milestone 5: value code in the sandbox" below.
- *The canonical text of a value formed when its entry is next evaluated,* which
  would take it out of the load.
- *A captured value that a body only passes on, observed as `identity`,* so that
  `addTopic` can be an `action`; and the crate giving a parameter declared as a
  cell no `value` entry, where the executor leaves the computed part unread.
- *The key of a plain value that no document holds,* formed from its plain
  content with each reference as the address it names (`Instance.#table`).
- *A link written without the space of its target* where the target is in the
  space of the result.
- *What the constructs lack:* `keys()` and `keyEntries()`; a `lookup` by a cell
  in a handed index; an incremental `sortBy` and `filter` over the result of
  another per-element construct; the segments of a `flatMap` whose body returns
  a stored array; `Object.keys(x).map`, `Object.values(x).map` and a `filter`
  over the entries of a record; the slot of an entry's name bound to the
  record's `enumeration`; and a method `sortBy` and a `groupBy` over the result
  of another per-element construct in `base/api/index.ts` and today's
  transformer, without which the two boards run on the compiled path alone.
- *What the bounded load leaves.* The documents a `lift` writes for its rows in
  transactions of their own, and the removal of what a load stored where the
  handed transaction does not commit.
- *The memory server's refresh, in `runtime/memory`.* A plan: a write that
  changes no link of the written document leaves what the walk reaches as it is,
  so the refresh can send the document's own snapshot and keep the closure, and
  walk again only where a link was added or removed; and a walk that reaches a
  document already tracked under a selector that covers the one it arrives with
  can stop there, which `coveringSelector` decides for the roots.
- *The preparation indexed by path.* `writePolicyInputsForDocument` indexes the
  write-policy inputs by document.
- *A unit of the result that is not compared.* A plan: a unit whose entry was
  not evaluated in the derivation is not compared.
- *The minimal write of a prepend and a removal.* A plan: a splice operation of
  the storage that moves the label entries with their positions, as the
  plan-write `moves` does for a handler's splice of a stored list.
- *The record of a result that holds nothing but links,* and *the `value` slot
  beside a handle narrowed in the crate* ("Over-labels found" above).
- *Sync and resume are milestone 6's* ("Milestone 6: server execution and the
  network" below). A document that is not in the replica when a reference leads
  to it reads as absent on a runtime that does not read from the store, and a
  document of another space that the replica does not hold is not brought.
- *Readers outside the executor.* The runtime follows the link to a row that is
  a document. It does not follow a link whose path crosses an array by key, and
  it reads a state cell with no document as nothing. The harness compares the
  compiled result as the executor holds it.
- *The shell* does not render a compiled piece.
- *What the corpus on the runner path lacks:* the runtime's own `wish`, an
  effect's request, the built-ins named above, a template for a
  `writeAuthorizedBy` claim, and a stream for a binding whose collection has no
  element. No continuous-integration job builds the crate.
- *The rest of the design's scheduler and serving loop:* a scheduler node for
  each cone instance (P51), the stream document and its watermark (P52), an
  effect's request leaving the piece, and the withdrawal of one derived write.
  Milestone 6 builds none of the four.
- *The boundary of rows as documents emitted by the crate* (P54), and the
  executor as a workspace package (P50).

## Milestone 5: value code in the sandbox

Built on 2026-11-22 and 2026-11-23, and read at the commit `233996ca69` of the
branch `claude/compiled-pattern-runner-m3`. The code is `value-code.ts`,
`compile.deno.ts` and `run.ts` of `runtime/runner/src/compiled/`, with the
evaluator option of the executor in `base/pattern-compiler/exec/executor.ts`,
the freeze of module data in `exec/frozen.ts`, and the commands `emit` and `emit
--accepted` of the crate. Notes 700 to 709 and 670 to 680 of
`base/pattern-compiler/SPEC-NOTES.md` hold the detail, and the provisional
decisions P100 to P103 and P170 to P179 of
[compiled-pattern-language.md](compiled-pattern-language.md) are of this
milestone. Every figure is of one process on an Apple M5 Max with 18 cores at a
load average of 4.2 to 10 from other work. Whenever this section says `map`, it
names the case.

**Findings on structure, scale and soundness.**

- *Soundness, open: the names the emitter binds, and with them the host of a
  call, are kept from a function body by the crate's check alone.* The emitted
  code wraps authored code in functions whose parameters are `$h`, `$arg`, `$e`
  and `$s`, beside `$rt`. `Host.slot` reads whatever index of the plan it is
  given and counts it (`slotsNotListed`) without refusing, and a `Host` is not
  frozen: its `reads`, `dependencies` and `bound` are public and writable. The
  check refuses a free use of such a name and every declaration of a name that
  begins with `$`. Nothing in the executor stands behind it. What closes it
  without the check is the host as an object with private state that is handed
  to authored code through no name, which changes the shape of the emitted code
  and is not started (question 386 of the design's plan).
- *Soundness, open: a body that catches an error the executor threw reads its
  members.* After `error instanceof Error` the check accepts any member, so
  `error.state` gives the error state the executor holds for the value whose
  read failed. The classes `Unsupported`, `ReadsFailure`, `MissingKey` and
  `ComputedOutput` are frozen; an instance is not.
- *Soundness, open: a body that holds a reference in a value reads the
  identifier of its document.* A `Ref` stands in for a link that is not
  followed. Where the position has a declared record type the check refuses the
  read (`schema:path-not-in-type`); where the type is `unknown` and the body
  narrows it, the body reads `doc`. The instance is frozen, and the freeze does
  not enter its array `path` and its object `schema`.
- *Soundness, closed with tests: three ways an accepted source reached the
  executor.* Each was reachable by a source the check accepted, compiled with
  `emit --accepted` and evaluated in the compartment. First, a handle named its
  position in public members: `target`, a reference with the identifier of the
  document and the schema of the position, and `declared`, a schema object of
  the artifact. The compiler keeps one parsed artifact for every piece of a
  source in a process, so a body that set a member of `declared` changed the
  schema that every other piece of that source reads under, in every space the
  process serves, and a body could set `target` and write through the handle to
  another position. The members are private fields, read by the executor with
  `partsOf` and `targetOf`, and a handle, a `Ref` and a `StreamRef` are frozen
  when made; `IndexHandle` keeps its context the same way (provisional decisions
  P100 and P171). Second, the check accepted any member of a handle, read,
  called or written: it refuses a member that the table of `language-subset.md`
  §4.7 does not list, by name or by a computed key, and a write to a listed
  member (`TypedRules::handle_member` of `src/typed.rs`, under
  `cell:unsupported-method`). Third, a source could declare a name the emitter
  binds: `const $h = ["plain"]` at module scope, read as `$h.at(0)` in a
  function of the reactive tier, read the host of the call there, and through
  `$h.slot(n)` any slot of the plan, a read the plan declares for no body and
  that no label covers. `Checker::reserved_names` of `src/check/mod.rs` refuses
  every declaration whose name begins with `$` (provisional decision P172). No
  module of the corpus has such a member or such a name: 373 modules are
  accepted with the checks as without.
- *Soundness, closed: the host of a call held the executor in a public member,
  and value code could replace a method of the host of every piece.* `Host`
  keeps its instance in a private field, and `compartmentEvaluator` freezes
  every class whose instances value code is handed, makes or catches
  (`HANDED_CLASSES` of `exec/executor.ts`), each with its prototype (provisional
  decision P112). Both needed a text that names `$rt` or `$h`, which the check
  refuses.
- *Soundness, closed: module data was mutable and no function was hardened.* The
  emitted text freezes each constant of module scope and hardens each function
  of it, as `language-subset.md` §3.3 says, by calling functions of the
  executor, under every evaluator (provisional decision P170; "What is built"
  below).
- *Soundness, closed: `emit <file>` printed value code for a module the check
  refuses.* `emit` prints the diagnostics and no artifact unless every module is
  accepted, and `emit --unchecked` prints the artifacts of refused modules, for
  diagnosis. Thirteen fixtures of `compare/fixtures/` hold forms the check
  refuses and are emitted with it, and so are the two measured Topics boards.
- *Structure: a program is accepted only whole.* `emit --accepted` gives an
  artifact only where every module of the program is accepted. Of 239 modules
  that the corpus run starts from the artifact of one module, 35 that the crate
  accepts one by one run on today's path through `Runtime.run` because a module
  they import is refused, mostly a shared helper. `emit --corpus` judges each
  module alone, which is why the figures of the corpus do not show it. The check
  would have to refuse the modules the pattern reaches and no others, or the
  helpers be brought into the subset.
- *Structure: a compiled piece cannot fall back once its start has begun.*
  `startCompiledPiece` may have committed load transactions before it throws.
  Two modules of the corpus call `table`, which the executor does not have, at
  module scope, and throw there. And a piece whose program is no longer accepted
  at a resume is refused and not run on today's path (provisional decision
  P175).
- *Structure: the freeze of module data exists twice.* `exec/frozen.ts` does
  what `freezeVerifiedPlainData` of `runtime/runner/src/sandbox/plain-data.ts`
  does for today's bundles, in another package. The executor is in `base/` and
  cannot import the runner, and the runner's function refuses a value of a class
  it does not know, where module data of the subset may hold a pattern factory.
- *Scale, removed: a read of an array of plain values in place hashed every
  member at each read.* About 40% of `Store.read` on an array of 10,000 plain
  records was the salted hash of each record, the key of its position: the keys
  formed from the copies of a read were never kept. The keys of a whole read of
  an array that holds no link are kept from the second such read on (provisional
  decision P179). An edit under a `lift` over the whole array takes 27 ms at
  10,000 rows, from 70.
- *Scale, open: a function body that is handed a whole array is handed a copy of
  it for each call, and the store changes stored containers in place, which is
  what keeps a read a copy.* Of the 27 ms of that edit, 14 are the one read,
  which copies every record and gives each an address, and the rest is
  `Host.pass`, which copies the argument again, and the walk of the result. For
  a `map` over the same array, whose element body reads one row, the same edit
  costs 0.3 ms at 10,000 rows. A read of a stored value without a copy is
  stubbed ("Stubbed, with a plan" below).
- *Scale: an edit in a `map` over an array of plain values in place does work
  that follows the length of the array, and the lockdown of the realm makes that
  work about four times slower.* On the executor in memory the edit costs 0.08
  ms at 1,000 and at 10,000 rows in a realm that is not locked down, and 0.10
  and 0.30 ms in one that is. Which step it is was not profiled.
- *Structure: no claim keeps two processes from compiling one source at once.*
  Within one `PatternCompiler` a source is compiled once at a time. Two
  compilers of one process, or two processes, may both run the binary for one
  source; they write the same text under two names and rename (provisional
  decision P178).
- *The compartment adds nothing to a call.* It has the intrinsics of the realm,
  so a value is passed by reference with no membrane, no copy and no freeze, and
  a call of a function made in the compartment is a plain call.

**What a function body is handed, class by class.** A body of the function tier
is given the event, the state or the argument, what it imports, and what its
calls return. "Check": the crate refuses the source. "Freeze": the write throws,
or the member does not exist. "Neither": open.

| What the body holds | Members | A read | A write |
| --- | --- | --- | --- |
| A plain value: a copy the store made, or module data | Those of the JavaScript value | The language's own; the intrinsics are frozen by the compartment | Module data: check (`module-scope:frozen-data-write`) and freeze. A copy is the body's own |
| `Handle` | `get`, `sample`, `key`, `set`, `update`, `push`, `remove`, `removeAll`, `removeByValue`, `addUnique`, `increment`, `send`, `elementById`, `equals`, `resolveAsCell`, `for`, which `language-subset.md` §4.7 lists | Allowed | Check (`cell:unsupported-method`) and freeze |
| `Handle` | `asSchema`, `withTx` | Check at a call (`cell:unsupported-method`); a read that is not called is accepted and gives a function that returns its receiver | Check and freeze |
| `Handle` | `refusingWrites`, `constructor`, any other name, a computed key | Check | Check and freeze |
| `Handle` | The instance, the host, the reference, the slot, the path, the schema | Freeze: private fields | Freeze |
| `Handle`, through `Object.getPrototypeOf`, `Object.keys`, a spread or `Object.assign` | The prototype and the class | The prototype and the class are frozen and hold no state; the instance has no own member | Freeze |
| `IndexHandle` | The collection and the context | Freeze: private fields | Freeze |
| `StreamMarker` | None | Nothing to read | Freeze |
| `Ref`, as the stand-in of a link that is not followed, or in a value | `doc`, `path`, `schema`, `key`, `withSchema`, `withDefault` | Check, where the position has a declared record type (`schema:path-not-in-type`). Neither, where the type is `unknown` narrowed by the body: the body reads the identifier of the document | The instance is frozen. Neither for the array `path` and the object `schema`, which the freeze does not enter |
| An error the executor threw, caught by the body: `Unsupported`, `ReadsFailure`, `MissingKey`, `ComputedOutput` | `kind`, `state`, and those of `Error` | Neither: after `error instanceof Error` the check accepts any member | Neither for the instance; the classes are frozen |
| What it imports from `commonfabric` | The record, its functions, the cell constructors, the factories | Allowed as the language defines them | Freeze |
| The exports of a module, through a namespace import | Its members | Allowed | Freeze |
| `$rt`, `$h`, `$arg`, `$e`, `$s`, a `Thunk`, an `Assembled` | All | Check: no name that begins with `$` is declared, and a free one is refused. The emitted text binds them around authored code, so nothing but the check keeps a body from them | `$rt` and its functions are frozen. A `Host` is not |

**What is built.**

- *The evaluator.* `Instance` has the option `evaluate`, a `ModuleEvaluator`: it
  is given the path and the text of a module and the names of the parameters,
  and returns the function whose body is the text. The default,
  `evaluateWithFunction`, is `new Function`, and every path of the prototype
  keeps it. `startCompiledPiece` gives the executor `compartmentEvaluator()` of
  `runtime/runner/src/compiled/value-code.ts` unless the caller gives another
  (`CompiledPieceOptions.evaluate`), which the harnesses use to measure the
  difference. The evaluator locks the realm down as today's runtime does when it
  loads a pattern (`ensureSESLockdown`), makes one compartment whose global
  object is frozen (`createLockedCompartment` of `sandbox/ses-runtime.ts`), and
  evaluates each text there as the body of one function expression with the
  parameters `$rt` and `$exports`. A piece makes a compartment of its own, and a
  caller may share one evaluator among pieces (provisional decision P102).
- *The globals* (provisional decision P103). Those of a module compartment of
  today's bundles (`createModuleCompartmentGlobals`) without `__cfReg`, which
  value code does not call: the shared intrinsics, `Proxy` as `undefined`, the
  gated `Date` and `Math`, `structuredClone`, `TextDecoder`, `TextEncoder`,
  `URL`, `URLSearchParams`, `atob`, `btoa`, and the console whose methods are
  bound. No `Deno`, `fetch`, `setTimeout`, `process` or `crypto`.
- *The clock.* The gated `Date` and `Math` read the frame on top of the frame
  stack. `CompiledPiece` runs each compiled handler under a frame of a handler
  with the time of the event, so `Date.now()` in a handler body is the event's
  time to the second and `Math.random()` is a draw. The derivation runs under no
  such frame, and the same calls throw there and at module scope. With `new
  Function` both read the realm's clock anywhere.
- *The emitted freeze* (provisional decision P170). The emitter wraps the
  initializer of each `const` of module scope (`module_text`, `frozen_code` and
  `Rewriter::visit_variable_declarator` of `src/emit.rs`): `$rt.fn(...)` where
  it is a function written in place, and `$rt.data(...)` otherwise, a builder
  definition included, whose result is a function of the executor. A literal
  that is no container is left as it is. A declared function is named to
  `$rt.fn` in the first line of the text, before any statement runs, and `export
  default` of a function or of an expression is wrapped the same way.
  `freezeModuleData` of `exec/frozen.ts` freezes an array and a plain record in
  place with what they hold, replaces a `Map` and a `Set` by a `FrozenMap` and a
  `FrozenSet` of `@commonfabric/data-model/frozen-builtins`, hardens a function,
  and freezes any other object without entering it; `hardenFunction` freezes a
  function and the object its `prototype` names. Both run whatever evaluates the
  text, `new Function` included: the freeze is part of what the emitted code
  means and not of the compartment. The body of a pattern compiled in is called
  with `$rt.inline(context, argument, $h)`, and the text writes into no array of
  the executor.
- *What the executor hands the code.* The object `$rt`, each function of it and
  the host `$rt.nohost` are frozen (`Instance.#runtime`, `Instance.#load`), and
  so are the exports object of a module once its text has run
  (`Instance.#module`), the record a module imports from `commonfabric`, each
  function of it, the cell constructors, and each factory `pattern` and
  `handler` return. A `Handle`, a `Ref` and a `StreamRef` are frozen when made,
  and what a `Handle` and an `IndexHandle` name is in private fields
  (provisional decision P171). The classes of `HANDED_CLASSES` (`Unsupported`,
  `Assembled`, `Index`, `IndexHandle`, `Thunk`, `ReadsFailure`, `Handle`, `Host`
  and `NoHost`) and `Ref`, `StreamRef`, `StreamMarker`, `MissingKey` and
  `ComputedOutput` of the store are frozen with their prototypes when the first
  compartment evaluator of a process is made.
- *What the check refuses for it.* A member of a handle that
  `language-subset.md` §4.7 does not list, and a write to a listed one
  (`cell:unsupported-method`); a declaration whose name begins with `$`
  (`stdlib:unsupported-member`, the identifier a free use has, since the
  document has no reserved names and no identifier for one; provisional decision
  P172); and a write through a module-scope constant
  (`module-scope:frozen-data-write`).
- *Which checks of today's verifier apply.* The classification of module items
  (`verifyCompiledModuleBody`) is not run: it accepts the grammar of
  TypeScript's CommonJS emit after the transformer and refuses all 186 module
  texts of `compare/fixtures/` at their first statement, and
  `language-subset.md` §3.4 has the compiler's check as the only one for a
  module in the subset. The verification of the module graph is not needed:
  value code names a module by its index in the artifact, and the one external
  specifier the executor resolves is `commonfabric`. The frozen global object
  and the frozen intrinsics are applied, as for a bundle.
- *Compile on load* (provisional decision P101). `PatternCompiler` of
  `runtime/runner/src/compiled/compile.deno.ts`, and the function
  `compilePatternSource(program, options)` over it, take a program as
  `Runtime.run`'s compile takes one (`RuntimeProgram`: the files and the name of
  the main file) and return the artifact of the pattern the program names, every
  module the crate emitted, and the artifacts by identity. The crate runs as its
  release binary in a child process: the files of the program are written to a
  temporary directory, the binary runs there with `emit --accepted` and the
  relative paths, and the directory is removed. The child is no Deno process and
  touches nothing of `DENO_DIR`. `PatternCompileError` carries the diagnostics
  of a refused program, and is also thrown where the crate wrote no value code
  for a construct of the pattern the program names. An absent binary is
  `PatternCompilerMissingError`, with the path and the command that builds it;
  the default path is the release build in the checkout. A module that ends in
  `export default Name;` is compiled as the pattern the constant `Name` holds.
- *The compile bounded* (provisional decisions P177 and P178). The child is
  spawned and its two streams are read as they arrive (`readBounded`). A stream
  that holds more than `maxOutputBytes`, 256 MB unless given, has the child
  stopped by its handle, the other stream cancelled and the exit awaited, and
  the compile rejects with `PatternCompilerOutputError`; nothing is kept in the
  cache for it. The largest module of the corpus emits 2.1 MB, and the corpus
  whole 23 MB. The compile has no bound on its time: the repository refuses a
  timeout as an upper bound on work that would have completed, and a caller
  stops a compile with the `signal` it gives the compiler. A compile of a source
  whose compile is under way in the same `PatternCompiler` waits for that one.
- *The cache.* With `cacheDir`, what the binary printed is kept under the hash
  of the binary's bytes and the hash of the source, which is the name of the
  main file and the names and texts of the files. A file is written under
  another name and renamed. Nothing is kept for a refused program. The first
  compile of a compiler with a cache directory removes each directory of it
  whose name is 64 hexadecimal digits and is not the hash of its own binary, and
  leaves every other entry, so the directory may be the one the shared compile
  cache keeps `modules` and `claims` in. Two servers with different binaries on
  one directory remove each other's trees at each start and compile again.
- *A pattern started from its source through `Runtime.run`* (provisional
  decisions P173 to P176). `runCompiledPatterns(runtime, { compile })` of
  `runtime/runner/src/compiled/run.ts` gives a runtime a compiler and sets
  `Runtime.compiledPatternRunner`. Under the option,
  `PatternManager.compilePattern` hands the program to it after today's compile
  (`prepare`), which is where the child process runs, in a call that is
  asynchronous already; `Runner.run` asks it first (`run`) and returns the
  result cell where it started a compiled piece; `Runner.stop` and
  `Runtime.dispose` stop such pieces; and `Runner.start` asks
  `Runtime.compiledPieceLoader` for a result document that names no pattern, as
  `ensurePieceRunningVerdict` does. With the option off none of the four is
  reached, and with no compiler given the runtime imports no executor.
  - *A refused program runs on today's path, visibly.* `prepare` keeps what the
    compiler rejected with, logs it as the warning `pattern-not-compiled` with
    the main file and the diagnostics, which name the construct and its
    position, calls `fellBack`, and returns `refusalOf(pattern)`. `run` then
    returns false and `Runner.run` goes on as without the option. A host whose
    binary is absent is no refusal: the compile rejects.
  - *A plan that requests `wish` or an effect falls back* (P176). Nothing
    answers a request of a compiled piece outside the executor's harness, so a
    program any pattern of which has such an operation runs on today's path,
    with that as the reason.
  - *How a piece is marked in storage* (P173). As `setUpCompiledPiece` marks one
    for a serving runtime (P110): the result document names no pattern identity,
    the document `compiledPointerOf(result)` holds the entity of the program,
    and that entity holds the program as text. `Runner.run` writes the three in
    the transaction of the start. One form serves a client under server
    execution and a runtime that starts the piece itself.
  - *Which pattern a piece names* (P174). The entity of its program, which is
    named by the text of the program: the files, the main file and the export.
    No identity of today's compile is stored, and no compiler build. The
    identity a plan begins with is derived from the program at each compile.
  - *A resume whose program is no longer accepted* (P175). The piece is refused:
    the loader stores the reason (`compiledFailureOf`, P111), starts nothing,
    and the stored result stays as it is. It is not run on today's path, which
    reads none of the documents the executor wrote for the piece and names its
    state cells otherwise, so a fallback there would run the pattern from its
    argument with its state lost. Moving a piece between the two paths is a
    migration and is not built.
- *The keys of a whole read, kept* (provisional decision P179). `Store.#copy`
  gives each member of an array that is a container the address of its key. The
  copies of a read that left no member out, of an array no position of which is
  or holds a link, are what the store reads at those positions itself, so the
  keys formed from them are kept as the keys the store forms without copies are
  (`KeyState`), from the second such read of an array on, and brought up to date
  at each write to the array, which reads the member written. Kept from the
  first read on, a `map` over plain values in place paid for it at the load, 8
  to 10% at 1,000 rows on the runner path. A read under a schema that leaves a
  member out does not keep its keys (`Store.#leftOut`), and `Store.#copy` makes
  no reference for the position of a member that is no container.
- *Tests.* `runtime/runner/test/compiled/value-code.test.ts` changes the text of
  the module of `fixtures/handler.tsx`: a handler body reads `Deno`, `fetch`,
  `setTimeout` and `process` as `undefined`; a module that assigns to a global,
  adds a member to `Array.prototype`, replaces a member of `$rt` or reads the
  clock at module scope does not load; a handler body reads the event's time to
  the second, and a random draw; and the two cases on a handle.
  `runtime/runner/test/compiled/compile.test.ts` runs a shell script in the
  place of the binary, so it needs no build of the crate.
  `compare/test/compile-on-load.test.ts` runs the release binary on
  `fixtures/handler.tsx`, starts a piece from the result, from the binary and
  from the cache directory, and has the binary refuse a body that names `$h`.
  `tests/emit_accepted.rs` covers the command.
- *Tests of the freeze, the check, the start from source and the bounded
  compile.* `runtime/runner/test/compiled/module-freeze.test.ts` over
  `compare/fixtures/module-data.tsx`: seventeen writes that a handler body
  makes, each put into the emitted text since the check refuses the source, each
  a `TypeError`: to an array, a record, a nested array, a `Map` (by its method
  and by `Map.prototype.set.call`) and a `Set` of module data; to a declared
  function, its prototype, a function held in a constant, a handler, an imported
  function and an imported cell constructor; to the exports; to a function of
  `$rt`, to `$rt.nohost`, to a handle and to `$rt.self`. `tests/emit.rs`,
  `tests/handle_members.rs`, six cases, `tests/reserved_names.rs`, three, and
  `tests/emit_accepted.rs` in the crate. `compare/test/runtime-run.test.ts`,
  with the release binary, on `fixtures/module-data.tsx`: the pattern run with
  the option off and with it on holds the same value after one event, and the
  second is a compiled piece; a source the crate refuses holds the same value on
  both runtimes, starts no compiled piece and reports the diagnostic; a second
  runtime on the same storage resumes the piece with `start` and handles an
  event; and a second runtime whose compiler rejects stores the reason and
  leaves the result. `compile.test.ts` has six cases of the bounded compile, and
  `exec/test/store-read.test.ts` four of the kept keys.
- *The harnesses.* `compare/sandbox-cost.ts` measures the evaluators, one call
  of a value function, the patterns of `fixtures/sandbox-cost.tsx` on the
  executor in memory, and the crate's binary beside today's compile.
  `compare/runner-path.ts` and `compare/runner-corpus.ts` take
  `--evaluate=function`.

**Stubbed, with a plan.**

- *A second `run` of a result document whose piece runs* returns the cell and
  leaves the piece, where today's runner stops the piece, replaces the argument
  and starts it again. The plan: stop the piece, write the argument document,
  and resume from the basis, which finds the argument changed.
- *A compiled piece whose start throws.* The plan: `prepare` evaluates the
  modules once in a compartment with a host that stores nothing, and treats a
  throw as a refusal, so that the program runs on today's path.
- *`Runner.start` resolves to false for a compiled piece* that the loader
  started or resumed: the value says whether a graph of today's runner is
  installed. A caller that reads it as "the piece runs" is wrong for a compiled
  piece.
- *A pattern made without `compilePattern`* has no program and runs on today's
  path with no diagnostic.
- *Nothing gives a toolshed's runtime a compiler.* `runCompiledPatterns` is
  called by the test and the harness alone, and the serving loader of milestone
  6 is given a compiler by a helper of tests.
- *The first commit of `examples/router/router.tsx` is refused through
  `Runtime.run`* ("plan-label refused") and taken from the artifact alone. The
  two differ in the three documents of the mark, written in the transaction of
  the start, and in the program, which through `Runtime.run` holds the imports.
  Not traced.
- *A read of a frozen stored value without a copy.* `Store.read` copies what it
  reads while a body may change what it is handed. `Store.write`, `Store.splice`
  and `spliceAt` change the stored containers in place, and the journal and
  `Instance.restore` put old members back the same way. So before a stored
  container can be given to a reader: (1) a write copies the containers on the
  path to what it changes and leaves the others, which makes the cost of a write
  that of the path and keeps a reader's value as it was; (2) the address of a
  stored container is kept by the store for its position and not registered at
  each read, with the keys of an array read from the kept `KeyState`; (3) a read
  under no schema, of a container that holds no link and needs no default,
  returns the stored container; (4) a read through a handle in a body stays a
  copy, since a body may change what it is handed; (5) the corpus is run both
  ways, since a value function that sorts or writes into what it read then
  throws. A stored container that two positions hold cannot carry two addresses,
  so the store has to hold no container at two positions. Step (1) changes every
  write of the store.

**What the compartment costs.** `compare/sandbox-cost.ts`, each part in a
process of its own, three runs, the median.

- *To make an evaluator:* 5.4 to 6.2 ms for the first of a process, which is the
  lockdown of the realm, and 0.09 to 0.12 ms for each later one. Today's runtime
  locks the realm down when it first loads a pattern, so a process that runs
  both pays the lockdown once.
- *To make the function of a module's text:* 0.0004 ms with `new Function`
  before the lockdown, 0.0015 to 0.0018 ms with it after the lockdown, and
  0.0012 to 0.0015 ms in the compartment.
- *One call of a value function,* the element function of a `map` body with a
  host that does no work, 2,000,000 calls, the median of 7 rounds: 0.2 to 0.4 ns
  with `new Function` before the lockdown, 5.6 to 10.2 ns with `new Function`
  after it, and 5.5 to 9.8 ns in the compartment. The lockdown costs a call
  about 5 ns, against about 50,000 ns that the executor spends for each
  evaluation of a row at load.

The executor in memory on `fixtures/sandbox-cost.tsx`, over arrays of plain
values in place. `function` is `new Function` in a realm that is not locked
down; `locked` is `new Function` after a lockdown; `per instance` is a
compartment evaluator for each instance; `one` is one evaluator for all. In ms;
the load is the median of 5 in each run, the edit of 20.

| Pattern | Rows | Measure | function | locked | per instance | one |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `PerRow`, an expression for each row of a `map` | 100 | load | 8.0 | 7.5 | 8.6 | 7.5 |
| | 1,000 | load | 59.6 | 56.8 | 61.7 | 56.6 |
| | 10,000 | load | 550 | 602 | 556 | 535 |
| | 100 | edit of one title | 0.115 | 0.114 | 0.123 | 0.114 |
| | 1,000 | edit of one title | 0.077 | 0.097 | 0.105 | 0.094 |
| | 10,000 | edit of one title | 0.081 | 0.327 | 0.291 | 0.300 |
| `BodyPerRow`, a `lift` for each row of a `map` | 100 | load | 5.8 | 7.1 | 6.6 | 6.6 |
| | 1,000 | load | 60.5 | 61.7 | 62.1 | 58.4 |
| | 10,000 | load | 616 | 678 | 614 | 607 |
| | 100 | edit of one title | 0.087 | 0.098 | 0.097 | 0.097 |
| | 1,000 | edit of one title | 0.091 | 0.112 | 0.110 | 0.107 |
| | 10,000 | edit of one title | 0.103 | 0.348 | 0.348 | 0.312 |
| `Whole`, a `lift` over the whole array | 100 | load | 1.3 | 1.6 | 1.6 | 1.3 |
| | 1,000 | load | 10.9 | 12.8 | 12.2 | 11.9 |
| | 10,000 | load | 112 | 117 | 119 | 116 |
| | 100 | edit of one title | 1.02 | 1.13 | 1.10 | 1.03 |
| | 1,000 | edit of one title | 10.2 | 10.6 | 10.5 | 10.2 |
| | 10,000 | edit of one title | 99 | 114 | 110 | 101 |
| | 10,000 | in the 2 store reads of an edit | 95 | 112 | 104 | 101 |
| | 10,000 | one read of the array | 47 | 52 | 48 | 47 |

The three arms in a locked realm do not differ beyond the spread between runs.
Against the realm that is not locked, the load is within the spread. The rows of
`Whole` are of two reads of the array for a call. With one read (provisional
decision P91), measured on 2026-11-23 with `new Function`, an edit of one title
takes 0.56, 5.5 and 57 ms and the load 0.85, 6.4 and 64 ms at 100, 1,000 and
10,000 rows.

With the keys of a whole read kept (provisional decision P179), measured on
2026-11-23 at a load average of 7 to 10: three runs each, the two arms
interleaved, the median, in ms, on the arm with a compartment for each instance.
The figures of the column "keys formed at each read" include the freeze of each
handle and reference, whose cost was not measured apart.

| Pattern | Rows | Measure | keys formed at each read | keys kept |
| --- | ---: | --- | ---: | ---: |
| `Whole`, a `lift` over an array of plain values in place | 100 | load | 1.11 | 1.02 |
| | 1,000 | load | 8.75 | 8.24 |
| | 10,000 | load | 81.8 | 75.2 |
| | 100 | edit of one title | 0.70 | 0.26 |
| | 1,000 | edit of one title | 7.18 | 2.23 |
| | 10,000 | edit of one title | 70.0 | 27.1 |
| | 10,000 | in the store reads of an edit | 55.3 | 14.3 |
| | 10,000 | one read of the array | 56.8 | 11.9 |
| `PerRow`, a `map` over the same array | 10,000 | load | 623 | 594 |
| | 10,000 | edit of one title | 0.32 | 0.30 |
| `BodyPerRow`, a `lift` for each row of that `map` | 10,000 | load | 647 | 629 |
| | 10,000 | edit of one title | 0.34 | 0.33 |

On the runner path, `compare/runner-path.ts --arms=compiled --case=plain
--no-pull --inputs-first --later=5`, a `map` over an array of plain values in
place: the load takes 109 and 546 ms at 100 and 1,000 rows, an edit of one field
26.1 and 189 ms, and an append at 1,000 rows 164 ms, each within 3% of the
figure with the keys formed at each read. The runner path has no `lift` over a
whole array among its cases, so it shows that the kept keys cost it nothing and
not what they gain.

The runner path, `compare/runner-path.ts` with the arm `compiled`, no pull and
the inputs committed first, over a `map` over an array declared as references,
rows as documents; three runs, the median, in ms:

| Rows | Step | `new Function` | `new Function`, locked | compartment |
| ---: | --- | ---: | ---: | ---: |
| 100 | load | 81 | 69 | 104 |
| 1,000 | load | 376 | 409 | 403 |
| 10,000 | load | 3,585 | 4,435 | 3,880 |
| 100 | edit one field, the mean of 5 later | 3.6 | 3.2 | 3.7 |
| 1,000 | edit one field, the mean of 5 later | 3.1 | 3.3 | 3.6 |
| 10,000 | edit one field, the mean of 5 later | 4.2 | 5.2 | 5.8 |
| 10,000 | append, the mean of 5 later | 784 | 782 | 854 |

The arms are within the spread of three runs on a loaded machine: the locked arm
with `new Function` is the slowest load at 10,000 rows and the fastest at 100.
The runner path adds the transactions and the preparation to the executor's
work, a load of 3.6 s at 10,000 rows against 0.55 s for `PerRow` on the executor
in memory and an edit of 4 to 6 ms against 0.08 to 0.3 ms, so the difference the
executor in memory shows is not visible there. For a `map` over an array of
plain values in place, one run each: a load of 100 and 558 ms with `new
Function` and 119 and 623 ms with the compartment at 100 and 1,000 rows, and an
edit of 25.5 and 188 ms against 29.5 and 198 ms; 10,000 rows were run with the
compartment alone, 5,839 ms the load.

**The corpus.** Of the 373 modules the crate emits, 239 are run on the runner
path from the artifact of one module. With `new Function` and with the
compartment the same modules start, handle every event, have no commit refused
and hold the values of the executor in memory, and no module has a different
outcome line in the two runs. With the emitted freeze no outcome line differs
but that of `apps/reward-spinner`, which draws at random.

**The corpus through `Runtime.run`.** `compare/runtime-run-corpus.ts`, one run
of 2026-11-23, made before the compile was bounded and the keys of a whole read
were kept. Each module that exports a pattern is resolved to its program
(`resolveLocalProgram`), compiled and run with a plain argument and no input
cells in a runtime in the serving posture on emulated storage. Of 307:

| Outcome | Modules |
| --- | ---: |
| A compiled piece that started | 199 |
| of those, every event handled | 184 |
| of those, the values of the executor in memory after the events | 181 |
| A compiled piece whose first commit was refused | 3 |
| The start threw (`table is not a function`) | 2 |
| Today's path | 103 |
| of those, the result holds what it holds with the option off | 102 |
| of those, the first commit refused the same way both times | 7 |

The one module of today's path that differs requests a fetch. Why the 103 run on
today's path: 27 request `wish`, 21 an effect, 54 have a module in their program
that the check refuses (`any` 15, `var` at module scope 10, a type mismatch 16,
an import with no bindings 3, and ten others), and 1 has a construct with no
value code. Of the 239 modules that the corpus run starts from the artifact of
one module, 199 start as a compiled piece, 3 have the first commit refused, 2
throw, and 35 run on today's path, all 35 with the values of the option off. The
events of a pattern on today's path were not sent.

**What compiling costs.** `compare/sandbox-cost.ts compile`, 9 runs, the median,
in ms. `crate` is a `PatternCompiler` made for the compile with no cache
directory: the temporary directory, the process and the parse of the output.
`cached` is a compiler made for the compile with the artifact in the cache
directory, which reads and hashes the binary. `kept` is the same with a compiler
that has read the binary before. `today, first` and `second` are
`PatternManager.compilePattern` of the same program in a runtime of its own, and
again in that runtime.

| Source | Files | Bytes | crate | cached | kept | today, first | today, second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `fixtures/sandbox-cost.tsx` | 1 | 1,230 | 3.9 | 2.5 | 0.10 | 322 | 23.6 |
| `fixtures/runner-lists.tsx` | 1 | 1,451 | 3.9 | 2.2 | 0.11 | 111 | 16.2 |
| `fixtures/handler.tsx` | 1 | 829 | 3.6 | 2.3 | 0.08 | 95 | 12.6 |
| `examples/cfc-trusted-component-examples/send-publish-examples.tsx` | 19 | 119,470 | 94.9 | 7.6 | 5.4 | 831 | 114 |
| `examples/cfc-spec-gallery/main.tsx` | 19 | 88,841 | 20.0 | 3.3 | 1.1 | 655 | 53.8 |

The `today, first` of the first row holds the first compile of the process. The
whole corpus, 373 accepted modules, is emitted by one process of the binary in
4.2 s, 23 MB of artifacts. The cache directory saves little for a small source
unless the compiler is kept, since hashing the binary for its identity is 2 ms
of the 2.3; a server keeps one `PatternCompiler`.

**Not verified.**

- No run compared the two evaluators on the Topics boards. By the order of the
  commits, the build agents' tables of milestone 3 on the constructs were
  measured on the branch of milestone 3 before the compartment was merged into
  it, so with `new Function`.
- Which step of an edit in a `map` follows the length of the array, and why the
  lockdown slows it, was not profiled.
- The plain values in place at 10,000 rows on the runner path were not run with
  `new Function`.
- A cell of the runner path is the median of three runs on a loaded machine, and
  the arms do not separate.
- No test has two processes compile one source at once, or a cache directory
  that another process wrote, and no test runs a compile that is stopped by its
  signal.
- The corpus through `Runtime.run` was run once, with a plain argument and no
  input cells.
- The test of a handle's private members and of `$rt.self` did not fail first.
- Topics was not run with the emitted freeze, and 10,000 rows of plain values in
  place were not run on the runner path with the kept keys.
- Four `plan.json` fixtures (`created`, `rekey-made`, `side-writes`,
  `value-beside-handle`) are behind the crate.
- Nothing was run in a browser or on a toolshed.
- The clock of a handler is the event's time to the second and a random draw is
  a draw; the executor records no read for either (the deferred questions of
  the design's plan).

**Not built.**

- The mark of a compiled space, a compiler for a toolshed's runtime, and a piece
  moved between the two paths.
- The host as an object with private state that authored code is handed through
  no name, a check of the members of a caught error, and a stand-in of a
  reference that gives a body no identifier.
- A check that refuses the modules a pattern reaches and no others.
- A read that is frozen and shared, and the write of the store that copies the
  path it changes.
- A claim for a compile between processes, which needs a wait on another
  process's file: a poll, or a lock the shared compile cache has and this cache
  does not.
- One freeze of module data for the executor and for today's bundles.
- A rule for reserved names in `language-subset.md`, with an identifier of its
  own in §10.
- A WebAssembly build of the crate, for where no native binary can run, and a
  continuous-integration job that builds the binary.
- The module policy of today's bundles is not applied to value code: there is
  no module graph to verify, and no check at load stands in the place of the
  crate's.

## Milestone 6: server execution and the network

Built on 2026-11-22 and 2026-11-23, behind the experimental option
`compiledPatterns`, and read at the commit `01e7567a86` of the branch
`claude/compiled-pattern-serving-m6`, which is cut from the commit `233996ca69`
of the branch of milestone 3 and holds it. The code is `setup.ts`, `serving.ts`,
`resume.ts`, `basis.ts` and `serving-memory-server.deno.ts` of
`runtime/runner/src/compiled/`, with the member `Runtime.compiledPieceLoader`
and the branch of `runtime/runner/src/ensure-piece-running.ts` that asks it.
Notes 800 to 850 of `base/pattern-compiler/SPEC-NOTES.md` on that branch hold
the detail, and the provisional decisions P110 to P120, P130 to P136, P150 to
P153 and P210 of [compiled-pattern-language.md](compiled-pattern-language.md)
are of this milestone. It is built for one piece of space scope, started by a
client and run by the serving runtime of its space. Every figure is of one
process that holds the memory server on a websocket, the serving loop on the
same thread and the clients, on an 18-core machine at load averages of 6.1 to
12.1 from other work. The serving runtimes run with the defaults of a runtime,
which store flow labels; the inputs are under no label unless a paragraph says
otherwise. Whenever this section says `map`, it names the case. Every figure is
the build agents'.

**Findings on structure, scale and soundness.**

- *Structure, found and closed: every serving measurement and test of this
  milestone before 2026-11-23 ran its serving runtimes reading their space over
  a session, where a toolshed reads from the store.* A serving runtime reads its
  home space straight from the store where the policy of its loop says so
  (`SpaceServerPolicy.storeReadThrough`): a document its replica does not hold
  is read from the store when it is first read, a sync is answered from the
  store with no query of a session, and the loop brings the documents the
  replica holds up to date from the commits the store takes. The bootstrap of a
  toolshed turns that on unless `SERVER_EXECUTION_STORE_READ_THROUGH` is
  `false`. `listenCompiledServingMemoryServer` passed no policy. It sets
  `storeReadThrough` where the caller's policy leaves it unset (provisional
  decision P210). Three things were consequences of the posture and not of a
  piece. An edit of one title of a Topics board followed the board and the place
  of the topic, 16, 35 and 55 ms for the middle topic and 19, 44 and 83 ms for
  the last at 100, 1,000 and 2,000 topics, with 2 ms in the piece: `start` of
  `compiled/serving.ts` brought the argument document with a sync under a schema
  that declares no structure, which stays a query of the session, each topic of
  the generated board links to the two before it, and the memory server walks
  such a query again from a document that changed over what it reaches (69 of
  the 95 ms of one such edit in the profile). It is 16 to 20 ms at 2,000 topics
  at any place of the board. The first event after a takeover grew faster than
  the board, 18 s at 1,000 topics and 66 to 111 s at 2,000, for a query that the
  wake kept over every link of the result. And a plan to bring the inputs under
  the argument schema of the plan, with a load that waits for a document the
  replica lacks, is not needed under the read-through. Every table of this
  section is measured with the read-through, today's arms included (question 469
  of the design's plan).
- *Soundness, not closed, for a serving runtime that reads over a session:*
  `RuntimeTransactions.load` reads the replica alone and takes a document the
  replica does not hold as empty. Under the read-through the replica reads it
  from the store in that read, and the store says whether the document exists.
  For a runtime without it, the query that follows every link is still how the
  documents of the inputs arrive.
- *Structure, open: the unit of the basis is the piece, so the first event after
  a takeover is the whole derivation, and with labels on the inputs it is the
  one step of the compiled board that is not below today's.* A piece whose basis
  does not match the storage, and every piece at its first event after a resume,
  evaluates its whole derivation once, in one transaction of one wave, and
  writes what differs with no record of a plan. On `filing-order` the first edit
  after a takeover takes 545, 4,451 and 8,543 ms at 100, 1,000 and 2,000 topics,
  with 24,032 evaluations at 2,000 for an edit that evaluates 5 once the
  executor runs; today's board takes 132, 1,066 and 2,296 ms. With the inputs
  under a label it takes 672, 4,576 and 9,584 ms, against 349, 3,362 and 8,204
  ms for today's board. In the profile of that step at 1,000 topics (4.6 s
  sampled): 2.4 s are the derivation (`startCompiledPiece`, of which
  `Instance.#ensure` with the value code 1.0 s, the adapter's `change` with the
  write records 0.6 s, and the comparison of each value with its stored text 0.7
  s), 0.4 s the read of every document the result reaches (`bringReached`), 0.5
  s the commit of the wave and 0.35 s its preparation. Until that cycle's wave
  commits, a reader sees the result of before the change, with no partial
  result, and every other piece that the same thread serves waits for the cycle.
  What is built removes the cost from a piece that is only read, and from every
  piece of a space until it gets an event or one of its sources changes: after a
  takeover a reader reads the stored result in 37, 140 and 229 ms. A basis per
  unit, and a wake that evaluates what an event reaches, are not built
  ("Stubbed, with a plan" below; question 430).
- *Scale, open: a step that changes a member of the result document follows the
  board on every holder.* On `filing-order` an edit of the `shortName` reaches a
  second client in 39, 118 and 198 ms at 100, 1,000 and 2,000 topics, the first
  edit of the mentions in 38, 109 and 198 ms, and a create in 79, 185 and 348
  ms, with 3, 3 and 48 ms in the piece at 2,000. Each of the three delivers the
  result document to the reader, 1.1 MB as JSON text at 1,000 topics and 2.2 MB
  at 2,000, where an edit of a title delivers one row document of 300 bytes. The
  result document holds, in place, six members that have one link for each
  topic: the children of the board in `$UI` (187 bytes for a topic), the arrays
  `mentionable`, `crossrefs` and `namesTable` (163 each), and the records of the
  buckets of `crossrefIndex` (171) and of `mentionIndex` (324). In the profile
  of twenty edits of the `shortName` of the middle topic at 2,000 topics, 165 ms
  each (4.0 s sampled): the two clients parse and freeze the document they are
  delivered, 1.1 s (`SpaceSession.#onMessage`, `parseWireText`, `deepFreeze`);
  the server encodes it, 0.43 s, and compresses it for the websocket, 0.39 s;
  the comparison of the document before and after, 0.24 s; the table of the link
  schemas of the document, 0.28 s (`mapLinkSchemas` of
  `memory/v2/schema-table-links.ts`); the queries of the sessions 0.15 s; the
  commit of the wave 0.11 s; and the piece 0.06 s. An edit of the mentions that
  changes no bucket does not follow the board: twenty of them take 41 and 43 ms
  each at 1,000 and 2,000 topics. This is the finding of milestone 3 on a
  document of links, met by a reader: a holder is delivered a changed document
  whole, and a reader of the board holds the result document, since `$UI` is a
  member of it. What the compiled path could do is under "Not built" below
  (questions 424 and 470).
- *Structure, open: the load of a piece on a serving runtime is one transaction
  of one wave.* It takes 3.2 and 6.0 s at 1,000 and 2,000 topics, in which a
  reader sees nothing of the board. The bounded load of milestone 3 is not in
  use there. It commits at 10,000 rows, since the commit of a wave is no client
  message and the limit of 1,000,000 slots does not apply to it. Bounded
  transactions inside one wave would bound nothing, since a wave is one commit
  of the store ("Stubbed, with a plan" below; question 432).
- *Soundness, closed with tests: value code observed two orders of the members
  of one record.* The JSON codec writes a record with its names in the order of
  their UTF-8 bytes (`JsonEncodeAct.encodePlainObject`), so a process that reads
  a document from the storage holds each record in that order, and the process
  that wrote it holds it as written until the stored document replaces its own.
  A derivation that depends on the order gave one result before a restart and
  another after it. Value code is handed the members of a record in the order of
  the storage, for a stored record and for a record that one computation made
  and another reads (provisional decision P150; question 426).
- *Soundness, closed with tests: an event that a handler sends was kept in the
  process alone.* A serving loop that stopped between the handler's commit and
  the handling of the event lost the event, and the next loop found the piece
  current. The event is sent through the cell of its stream in the handler's
  transaction, and on a serving runtime it is stored with what the handler wrote
  and withdrawn with it (provisional decision P151; question 427).
- *Soundness, closed with tests: an instance a handler made did not run after a
  resume.* The instances the handlers of a piece made are listed in the document
  of the counts, and a resume starts each before the first derivation of the
  piece (provisional decision P152; question 428).
- *Soundness, two assumptions the basis rests on, of which no test covers a
  wave.* First, a transaction that read a document whole is refused where the
  document changed before its commit, for a commit of a client and for a
  contribution to a wave. The list `recent` of the basis is sound only with it.
  `refused-commit.test.ts` shows it for a commit of a client; nothing tests it
  for a wave. Second, one runtime runs a piece at a time: two runtimes that both
  run it would each write the basis from its own view (question 429).
- *Soundness, closed: the serving runtime evaluated value code that a client
  wrote.* A client writes the source of a pattern and no artifact, the serving
  runtime compiles the source with the crate's check and evaluates the value
  code its own compile gave in a compartment, and the loader refuses a document
  that names no source (provisional decision P110). What it leaves is who may
  write the source and the document that names it (question 417).
- *Soundness, closed: a rejected wave left the executor ahead of the storage.* A
  transaction sealed into a wave settles with no error before the wave commits.
  Where the wave is then rejected, the replica takes the writes back and the
  loop queues the event again. The adapter takes the replica's `revert` of a
  transaction it handed, where that transaction had settled without an error, as
  a refused commit, and the piece restores the documents the transaction wrote
  from the storage before the event is handled again (provisional decision
  P135). `Instance.restore` keeps what the place of a state cell was declared
  as. Not closed: the restore follows the size of the result, and a wave that
  holds the transactions of two pieces restores each.
- *Soundness, closed: the names of handler runs and of the documents handlers
  make began at zero in a second process.* The counts are kept in a document of
  the piece, written in the transaction that advances them, and a resume goes on
  from them (provisional decision P132). That is one more document written by
  each event.
- *Soundness, closed: three defects of a resume.* A second process read every
  stored link as one to an input; each document the executor makes carries the
  `result` link to the result document, and a resumed adapter reads it to tell
  the two apart (provisional decision P131). A resumed runtime had not enrolled
  the documents of the piece as stores the instance owns, so its write was
  measured for writer-fit and refused. And a document the result links to by no
  link a sync follows was read as absent and made again. A resumed adapter
  enrolls each document it holds from the run before with its first write of it,
  and the basis lists the documents the piece made, which a resume brings by
  name (provisional decision P119).
- *Scale, an observation: a topic written under a schema that declares a label
  and no structure makes each write of it follow the links of the topic.* With
  the inputs labeled under such a schema, an edit of the title of the middle
  topic takes 22, 43 and 75 ms and of the last 21, 56 and 121 ms; with the
  mentions declared as references they take 20, 22 and 24 ms and 16, 17 and 23
  ms. An input a user writes may be under such a schema. That is the memory
  server's, as in milestone 3.
- *Scale, open: a resume reads one document for each source, each with a sync of
  its own.* For a list of references the sources are the items, so the
  comparison of the basis reads 199, 1,263 and 10,268 documents at 100, 1,000
  and 10,000 rows, which the store answers in 0.08 s at 1,000 and 0.66 s at
  10,000 until a client reads; on Topics it reads 223, 1,280 and 2,284
  documents. Nothing bounds it: there is no transaction, and the syncs are sent
  together. The memory server holds the head of each document without its value;
  the comparison does not read it from there (question 431).
- *Scale: an append under server execution follows the list, outside the piece.*
  It reaches a second client in 27, 41 and 227 ms at 100, 1,000 and 10,000 rows,
  where today's piece takes 40, 189 and 2,344 ms. An append changes two
  documents that hold one link for each member, the array of the input and the
  array of rows in the result document (question 433).
- *Structure, open: the list of the instances the handlers of a piece made is
  written whole when it changes,* so a piece whose handlers made `N` instances
  writes `N` entries for the next one: on Topics one entry for each topic
  created through `addTopic`. Every listed instance is started at a wake,
  demanded or not.
- *Scale, closed for the numbers of the sources: the basis was one document with
  an entry for each source, and each event paid for its size.* The number of a
  source is in one of 256 documents, chosen by a hash of the identifier of the
  source (provisional decision P120). Not closed: the list of the documents the
  piece made is in the one document of the basis and follows the rows where each
  row has a stream or a document of its own, and after a refused commit the
  piece writes every part again.
- *Structure: the wake of a piece that the basis found current writes documents
  for some modules of the corpus,* though the basis matched: the derivation gave
  another value than the stored one. In a run of 2026-11-22 that counted them
  these were 20 of 131 modules, 2 to 17 documents each, and they were not traced
  one by one. A cause seen is a computation that is not a function of its
  inputs. The order in which an index gives its keys is the order in which the
  buckets came to exist in the process, which a derivation from the start and
  one that followed the changes can give differently; it was not examined.
- *Structure: the crate's check refuses the two measured boards, and today's
  compiler refuses `topic.tsx` of the measurement branch.* The serving arm
  compiles the boards with `emit --unchecked`, and today's arm runs `main.tsx`.
  A toolshed would refuse these two boards.
- *Structure, open: a state cell that nothing wrote has no document, so a reader
  outside the executor reads nothing where the executor reads the default of the
  cell's schema.* The result of `fixtures/serving-list.tsx` holds a link to the
  state cell `events`; a client reads `undefined` there until the first event,
  and the executor reads 0.
- *A memory server over a socket broke nothing in the piece.* The tests of
  milestone 3 pass on both storages, and `compare/runner-path.ts` over a socket
  gives the values the emulated storage gives. The one limit met is that of
  milestone 3: a load in one transaction at 10,000 rows that are documents is
  one client message of more than 1,000,000 slots, which the server refuses;
  with the inputs committed first the load is 42 commits and is taken.
- *A second serving loop in one process had its first nine waves rejected as
  replays* ("commit replay mismatch"): the memory server keeps the sequence
  numbers of a session of the service identity across serving loops in one
  process. It is a property of a restart inside one process, as the tests make
  it, and was not followed further; the piece converged through the rejections.
- *Seen and not explained.* One run of the Topics harness printed nothing after
  the line of the experimental options and used 0.9 s of processor time in ten
  minutes; a serving runtime that starts no piece left the harness waiting
  without end, which is closed, and may have been its cause. On
  `sorted-references` the reader's sink on the caption of the first card
  resolved before the edit of `lastActivityAt` in every run, so that cell of the
  table holds the sender's time: a defect of the harness or a stale read of one
  of the two clients. And a client that held a sink on the result from before
  `CompiledServingMemoryServer.restart` did not have the new loop reach the
  piece, where a client that connected after the restart did.

**What is built.**

- *A memory server over a socket.* The tests of `runtime/runner/test/compiled/`
  open their storage through `test/compiled/storage.ts`, which with
  `COMPILED_PIECE_STORAGE=socket` starts a `StandaloneMemoryServer` on an
  ephemeral localhost port for each test and connects with
  `StorageManager.open`. `compare/runner-path.ts` takes `--server=socket` for
  the same. `refused-commit.test.ts` stays on the emulated server, whose fan-out
  it withholds by hand. The test task of the runner installs a clock that
  advances by itself when the loop is idle, and a round trip over a websocket is
  real I/O, which that clock reads as an idle loop; the suite of the serving
  loop therefore runs on the real clock (`compiled-serving` in
  `realClockFiles`).
- *Setup by source* (provisional decisions P110 and P136).
  `setUpCompiledPiece(runtime, tx, program, argument, resultCell)` of `setup.ts`
  writes three documents and no result: the program as JSON text, the files by
  name with the name of the main file and of the export, in an entity named by
  that text (`patternSourceDocumentOf`); a document named from the result
  document (`compiledPointerOf`) that holds `{ source }`, the entity of the
  program; and the argument document, with each cell as a link. The module
  imports the identifiers of `exec/store.ts` and none of the executor. A client
  under server execution runs nothing of a compiled piece and commits only the
  append of an event: `Cell.send` on a member of the result resolves the link to
  the entity that holds the stream marker and appends, as for a stream of
  today's piece. Today's client tries to run the handler of each event it sends,
  finds none, and logs "Event dropped: no handler registered" for each send; the
  event is appended all the same. The pointer is a document and no meta field,
  because the set of meta fields is closed (`META_FIELDS` of `meta-seam.ts`).
- *Compile on the server* (provisional decisions P110 and P111).
  `serveCompiledPieces` of `serving.ts` installs `Runtime.compiledPieceLoader`.
  The loop's structure load and the scheduler's handling of an event with no
  handler both call `ensurePieceRunningVerdict`, which follows the `result`
  links from the document it was given to the result document
  (`followResultCellChain`). Where the result document names no pattern,
  `ensureVerdict` asks the loader, with the option on alone, and tells it
  whether an event waits. The loader reads the document that names the pattern,
  parses the program (`patternProgramOf`) and hands it to the compiler it was
  given (`ServeCompiledPiecesOptions.compile`).
  `listenCompiledServingMemoryServer` gives one `PatternCompiler` of milestone 5
  for the server, which runs the crate's binary with `emit --accepted` and keeps
  the artifacts in its cache directory. What a compiler gave is kept for each
  compiler by the entity of the source, so one compile serves every piece of a
  source in every space of the process, and a source the compiler refused is not
  compiled again. The value code is evaluated with `compartmentEvaluator`. Where
  the document names no source, the source is no program, or the compiler
  rejects, the loader writes `{ reason }` into the document
  `compiledFailureOf(result)`, in a transaction stamped as a derivation with no
  acting principal, starts nothing, and returns to the loop that the piece is
  not served. The reason of a refused source is the text of the compiler's
  diagnostics.
- *The piece under the serving loop* (provisional decision P134). The loader
  brings the documents of the piece and starts it: with `startCompiledPiece`
  from the stored argument where the result document is empty, and from the
  basis otherwise. The handlers and the derivation are the scheduler's, so the
  loop is not changed for them: its event drain queues each durable event with
  the scheduler for the entity of its stream, where the piece registered a
  handler, and the loop stamps the transaction of the handler and of the
  derivation action with the context of the run and seals it into the wave, as
  for an action of today's piece. A transaction that the loop did not stamp is
  refused at the seal, so the loader stamps the transaction of the load as a
  derivation with no acting principal (`stampWaveRunContext`) and starts the
  piece with `loadRows` at `Infinity`. The load brings the empty result document
  without what it links to (`syncCompiledPiece` with `rows` false; provisional
  decision P118), so that the serving session keeps no query that the server
  walks over every row link at each append. On a serving runtime the executor is
  given the stored argument (`CompiledPieceOptions.storedArgument`,
  `RuntimeTransactions.heldArgument`), and its creation of that document is no
  write.
- *A rejected wave* (provisional decision P135; the finding above).
- *The basis of a piece* (provisional decisions P113 to P116 and P120).
  `basis.ts`. A piece keeps one document, named from its result document
  (`basisDocumentOf`), that says what the stored result was derived from. It is
  the form of `scheduler-and-serving-loop.md` §10.4 with the piece as the unit:
  one set of identifiers and sequence numbers by document, for all cone
  instances of the piece together.
  - *The sources* are the documents the derivation reads and does not derive: a
    document that exists outside the executor and that the executor read; the
    argument document; a document that a transaction of the executor other than
    a derivation wrote, which is a handler's, the creation of the instance, a
    request or a completion; a place of the executor's own that was read while
    the storage held no document of it, such as a state cell nothing has
    written; a document another writer changed and the executor took the change
    of; and the document of the counts, which every handled event writes. A
    document the derivation alone writes is no source. The adapter tells the
    piece of each through `SourceObserver`.
  - *What is stored for a source* is the sequence number the replica's confirmed
    view of the document stood at (`ISpaceReplica.confirmedDocumentSeq`) when a
    derivation ran with no write of the piece to it unconfirmed. The source is
    unchanged while its head is that number. A source in another space is
    recorded as never current.
  - *A source the piece itself wrote.* A piece cannot know the number its own
    commit will give a document: in a serving runtime the handler's transaction
    and the derivation's are sealed into one wave and get one number, after both
    ran. The basis has a list `recent` of the sources that a transaction of the
    piece wrote and that the replica has not confirmed at that transaction's
    number. The transaction that writes the basis reads each of them whole, so
    its commit depends on what the document holds, and a counter `revision`
    makes every write a change. A source of the list is unchanged while its head
    is not behind the head of the document of the basis. When a later derivation
    finds the commit confirmed, the source gets its number and leaves the list.
  - *A commit that stores a label writes the document.* A handler that sets a
    cell to the value it holds writes no value, and its commit still stores a
    label, which moves the head of the document. The adapter tells the piece of
    each document that a commit of a handed transaction changed, and where the
    basis was recorded before that, the derivation runs once more and records
    it.
  - *When the basis is written.* By a transaction of the derivation alone, after
    `settle()`: at the load, at a resume, and in a derivation whose transaction
    has other writes or behind which a transaction of the piece wrote a source.
    A change by another writer of a field that no cone reads writes nothing: the
    derivation runs, evaluates nothing, and leaves the basis one number behind,
    and until the next write of the basis a resume finds that piece stale. A
    transaction whose commit is refused, or taken back after a rejected wave,
    takes its write of the basis with it, and the piece then writes the document
    whole.
  - *The parts.* The number of a source is in the document of one of 256 parts,
    chosen by a hash of the identifier of the source (`basisPartOf`), and the
    document of the basis names the parts that exist. The basis also lists the
    documents the executor made that are no rows, and the entities of the
    streams.
- *A resume from the basis* (provisional decision P117).
  `resumeCompiledPieceFromBasis(runtime, artifact, resultCell)` of `resume.ts`
  returns a `ResumedPiece`. It reads the document of the basis, the documents of
  its parts, and one document for each source, each brought under a schema with
  which the sync follows no link, outside any transaction: no row, no document
  of the result, no stream. The replica is subscribed to each from then on. It
  compares the identity of the compiled pattern (`Plan.patterns[0]`), then
  `basisMatches`. Where they match, nothing is evaluated, no `Instance` is made,
  the value code is not loaded, and nothing is committed. The piece then waits:
  a commit that changes a document its basis names wakes it, and its caller
  wakes it (`ResumedPiece.wake`) before an event. Under the serving loop a
  demand finds the piece served and reads what is stored, and an event wakes it,
  which registers the handlers. Where they do not match, and at a wake,
  `resumeCompiledPiece` runs.
- *A resume that derives* (provisional decisions P130 to P132, P119 and P153).
  `resumeCompiledPiece(runtime, artifact, resultCell)` brings the result
  document and what a link leads to from it, at any depth, each document once
  and each by a sync of that one document under a schema that follows no link
  (`bringReached` of `resume.ts`). The replica is subscribed to each, and the
  session holds no query over them. It brings the inputs with the query that
  follows links, as the load does, which on a runtime that reads over a session
  is how the piece hears of a member another writer adds; and it brings by name
  the documents the basis lists and the documents the derivation finds absent.
  The resumed instance evaluates the first derivation again, against the stored
  argument and the stored state: a state cell whose document the storage holds
  is given neither its first value nor its default (the `Instance` option
  `resume`). The derivation is one transaction. A change of it that writes what
  the storage holds is no write, so a resume over inputs that did not change
  commits nothing, or the basis alone. A path whose value differs is written
  with no record of the plan, and the runtime labels it with the join of what
  the transaction read. A place the resumed executor finds no document of is a
  source of the basis, so the next resume brings it first.
- *The serving runtime reads from the store* (provisional decision P210).
  `listenCompiledServingMemoryServer` gives its serving loop `storeReadThrough:
  true` where the caller's policy leaves it unset. The serving runtime then
  holds no query over the inputs of a piece and none over what the piece wrote,
  `RuntimeTransactions.load` reads a document the replica does not hold from the
  store, and a member that another writer adds to an input is read the same way
  when the executor first follows the reference. The loop counts the reads
  (`ServingLoopStats.storeReads`).
- *The members of a record in one order* (provisional decision P150).
  `membersInOrder` of `exec/store.ts` gives the names of a record in the order
  of the storage: a name that is an array index before every other name, in the
  order of the numbers, and the others by their UTF-8 bytes. `Store.#copy`
  builds the copy of a stored record that a read returns from the names in that
  order, and `Host.v` of `exec/executor.ts` does the same for a record that a
  computation made and another reads without the storage between them. Those two
  are where a value reaches value code: a slot, a handle's `get`, the argument
  of a body. Names that are in order already cost one comparison each and no
  sort. `{ title, tags }` is read as `{ tags, title }`, and a `map` over the
  entries of a record gives its rows in that order. Not changed: `Store.write`
  and `Store.put` compare what a position holds with what is written as JSON
  text, which holds the order, so two records that differ in order alone are
  taken as a change by the executor, and the runtime's transaction then finds no
  difference and logs no write.
- *An event a handler sends* (provisional decision P151). The handler of the
  scheduler that runs a compiled handler sends each event the handler sent with
  `Cell.send` on the cell of the entity that holds the stream's marker, bound to
  the transaction the scheduler gave the handler
  (`CompiledPiece.#registerStream`). On a serving runtime, under a transaction
  the wave stamped, `Cell.send` writes the entry into the document of the
  entries of the stream in that transaction, with the acting principal of the
  run as `firedAt` (`actingForEmission` of `executor/wave.ts`), records the
  append as a mergeable one, and queues a copy for the same wave. No code of the
  serving loop is changed for it.
- *An instance a handler made, at a resume* (provisional decision P152). An
  instance that a `lift` or a `computed` made is made again by the body that
  made it when the resumed executor evaluates the body. No body makes an
  instance of a handler's run again, since the name of a run of a handler is
  formed from the count of the events handled. `Instance.madeByHandlers` gives
  each instance a handler made that exists, by its identifier with the identity
  of its pattern, and `CompiledPiece.#keepMinted` writes the list into the
  document of the counts, as the member `made`, in the transaction in which it
  changed. This is the instances document of `execution-and-storage.md` §2.8
  with the run and the ordinal left out. A resume reads the list, finds the
  artifact of each by the identity (`CompiledPieceOptions.artifacts`), and gives
  the executor each with the argument the storage holds for it; the root makes
  each before its own first derivation, under the identifier it has, and the
  instance then registers its streams and derives as the root does at a resume.
  An instance that was re-keyed (ruling Z41) is listed under the identifier its
  documents have, and the name it is held under is not stored.
- *Tests.* `runtime/runner/test/compiled/resume.test.ts` and `basis.test.ts`,
  over `fixtures/serving-list.tsx` and `fixtures/handler.tsx`, on a memory
  server that two or three runtimes share, emulated and over a socket;
  `fixtures/serving-list.tsx` is a `map` over an array that the type declares as
  references, with rows as documents, two handlers that write the array, and a
  state cell. `compiled-serving.test.ts`, against a memory server that listens
  on a websocket with the serving loop on the same thread: a piece a client set
  up is derived and read through sync; two clients take turns sending four
  events and both converge on what the executor in memory gives for that order;
  a client that sends nothing reads the result; a second serving loop that takes
  the space over evaluates nothing until an event arrives, goes on from the
  storage, and is woken by a client's change of an item; an event whose wave is
  rejected is handled again from what the storage holds; a source is compiled
  once and a handler body reads `typeof Deno` as `"undefined"`; a document that
  holds an artifact gets no compile and no evaluation, and the client reads the
  reason; and a source whose body names `$h` gets no evaluation, and the client
  reads the diagnostic. `compare/test/serving-compile.test.ts` runs the release
  binary for the compile of a source and for the refusal of a body that names
  `$h`, and `compare/test/resume-corpus.test.ts` runs two modules of the corpus
  through `runner-corpus.ts --resume`. `value-code.test.ts` has three cases on
  the host and the frozen classes.
- *Tests of the order of members, of a sent event, of a made instance and of the
  read-through.* `base/pattern-compiler/exec/test/member-order.test.ts` over
  `compare/fixtures/member-order.tsx`, five cases, one with a name beyond the
  Basic Multilingual Plane beside one within it, which the order of UTF-16 code
  units and the order of UTF-8 bytes place differently;
  `runtime/runner/test/compiled/member-order.test.ts`;
  `compiled-serving.test.ts`, "an event a handler sends to a stream of the
  piece", over `compare/fixtures/relay.tsx`, whose second case stops the loop
  between the commit of the handler and the handling of the event it sent,
  attaches another serving loop, and has a client read that the event was
  handled once; `handler-send.test.ts`, a send from a handler in a runtime that
  runs the piece itself, on both storages; `made-instance-resume.test.ts` over
  `compare/fixtures/made-counter.tsx`; the case of `compiled-serving.test.ts`
  that counts the reads from the store; and
  `compare/test/resume-corpus.test.ts`, with the three modules of the corpus
  that failed after a resume. The stop between the two handlers is made by the
  test: a serving loop that the deadline of a wave cuts there by itself was not
  seen. A resume between the transaction of the event that made an instance and
  the derivation behind it is not tested.
- *The harnesses.* `compare/serving-path.ts`, with `--profile=<file>` for a
  sampling profile; `compare/runner-corpus.ts` with `--resume`, `--serving` and
  `--detail`; and the arms `serving` and `serving-today` of
  `compare/topics/scale.ts`, in `compare/topics/serving.ts`. That harness starts
  a memory server on a websocket with the serving loop on the same thread and
  two clients with server execution on. The sender writes each topic as a
  document, 500 in a transaction, and the two inputs of the board as cells of
  their own, and sets the board up: with `setUpCompiledPiece` on the arm
  `serving`, and with `Runtime.run` on the arm `serving-today`. Each step is
  timed from the sender's call until the sender and the second client each read
  the one value the step changes, through a sink on that one path. The second
  client holds, beside the sink of each step, a sink on the caption of each of
  the first 20 cards, which is what a reader that shows the first screen of the
  board holds: the result document and 20 documents of cards, and no topic. With
  `SCALE_TAKEOVER` another serving loop then takes the space over, a client that
  holds nothing reads `topicCount`, and the sender edits the title of the first
  topic twice. `SCALE_SERVING_LABELS` writes each topic and each input under the
  schema and the clause the arm `runner` writes it under; `SCALE_COMMITS` lists
  the documents a reader was delivered in a step; and `SCALE_PROFILE_STEP` and
  `SCALE_PROFILE_EDITS` take profiles. The harness has a type error from before
  these rounds and is run with `--no-check`; `deno task check` does not check
  the file.
- *With the experimental option off.* `ensureVerdict` passes the loader whether
  an event waits and asks it only with the option on and where a loader is
  installed, and nothing installs one but `listenCompiledServingMemoryServer`.
  The other changes are in `runtime/runner/src/compiled/`, which a runtime that
  starts no compiled piece does not load, and in `base/pattern-compiler/`.
  `docs/development/EXPERIMENTAL_OPTIONS.md` on the branch says what the option
  gates under server execution.

**Where the wave and seal rules of the specification differ from what is
built.** Today's serving loop is followed in each of the nine, and its behavior
for a piece of today's runtime is unchanged. The sections are of
`scheduler-and-serving-loop.md`.

1. *One derivation transaction behind the batch* (§10.2). The derivation is one
   effect of the scheduler that the piece invalidates, and the loop runs it as
   it runs any action of the cycle. Whether one cycle that drains several events
   runs it once was not measured; `serving-path.ts` counts 15 derivations for 14
   events sent one at a time.
2. *The basis index, and the marking of stale cone instances at activation*
   (§10.4, §10.6). The basis is of the piece and not of a cone instance, the
   piece writes it in a transaction of its derivation and not the memory server
   inside the store transaction of the wave, and a stale piece derives whole.
3. *Demand per path, and a read answered from the rows* (§4.1 to §4.4). Demand
   on any document of the piece loads the piece, and a piece that runs derives
   every output, demanded or not. A piece that the basis finds current is read
   from storage with nothing run.
4. *Only the server compiles, and a compiled pattern carries the integrity of
   compiled output* (§10.5). The serving runtime compiles. The compile is a
   child process that the loader awaits inside the loop's start of the piece,
   where the specification has the instance stay unloaded with its demand
   pending. The compiled pattern is not stored as a document of the space with
   the integrity of compiled output: it is kept in the process and in the cache
   directory of the compiler. A build of the compiler is no part of the identity
   a piece names.
5. *The stream documents, the stream watermarks and the stream index* (§5.1).
   The events a client appends are those of today's stream entries, and so is
   an event that a handler sends (P151).
6. *A conflict leaves out the derived write that conflicts and what used it*
   (§5.5). The piece restores every document the withdrawn transaction wrote,
   the result document whole.
7. *The context of an evaluation: the acting principal, the scope key and the
   read ceiling of each cone instance* (§10.3). The piece is of space scope, the
   load is a derivation with no acting principal, and a handler runs under the
   context the loop stamps for its event.
8. *A setup transaction commits by itself, ahead of the wave* (§10.8). The
   client's setup is a commit of the client, and the first derivation is a
   transaction of a wave.
9. *Client speculation* (§11). A client runs nothing of a compiled piece.

**Stubbed, with a plan.**

- *A basis per unit, and a wake that evaluates what an event reaches.* The
  executor's memo entry of a cone instance holds the value as the value code
  returned it, the positions it read, its dependencies, the element tables, the
  units of the layout, the inputs of its write records and the groups its fold
  labels are formed from (`Instance.#ensure`, `#evaluated`, `#noteInputs`,
  `#regroup`). The plan, from what the executor holds:
  1. *The dependencies of an entry are data, by name.* `Entry.reads` is a list
     of positions, each a document with a path, and `Entry.dependencies` names
     the entries it used (`Dependency.on`); `Instance.#register` forms the index
     from them. So the skeleton of the memo can be stored as it is: for an
     entry, by its name, the positions it read and the names it used. What
     cannot be stored is the value as the value code returned it, the closures
     of `Dependency.stamp` and of `Entry.writers`, and the tables of an assembly
     (`Entry.members`, `Entry.rows`).
  2. *The basis by position, and kept in reverse.* A basis that names a document
     and its sequence number makes every unit stale that read any path of the
     document: the index over the mentions and a sort by `lastActivityAt` read
     one path of every topic, so an edit of a title would make them stale, and
     their evaluation reads every row. And a basis kept with each unit has to be
     read for every unit before the stale ones are known, which follows the
     board. So: for each source document, a document named from it that lists
     the entries that read it, each with the paths it read, and with each stored
     unit the names of the entries that used it. A wake that a change of a
     source caused reads the list of that one source, marks the entries whose
     paths the change touches, and follows the users upward.
  3. *When the lists are written.* An evaluation whose positions and whose used
     entries are those of the evaluation before writes nothing. The load writes
     one list for each source document, 2,000 more documents at 2,000 topics, or
     fewer where the lists are spread over parts as the numbers of the basis are
     (P120). A piece that was found stale at a resume, because a source changed
     while no loop served it, knows the documents that changed and not the
     paths, and marks every entry the lists of those documents name.
  4. *What the executor needs, in the order it can be built.* (a) An entry that
     stands for a stored unit: `Instance.#ensure` returns, for a name the memo
     does not hold and the lists did not mark, an entry whose value is the
     stored one, with no reads and no dependencies of its own. That is sound
     only for a value that the stored form gives back, a record or a view node
     of plain values and references; a value that holds a handle, a stream or an
     index is evaluated. (b) The table of a collection from the stored array and
     the keys of its rows, with no body run, and an assembly whose entry holds
     the keys and leaves the rows it did not evaluate as stored. (c) The marks
     from the lists: a marked name is evaluated when the result demands it, and
     the entries that used it are marked where its value changed. (d) A fold, a
     sort and an index are each one unit over every row, evaluated only where a
     path it read changed.
  5. *The write records.* A unit that is not evaluated gives no record, and none
     is needed while nothing is written for it. The groups a fold label is
     formed from need the labels of the members, which the storage holds.
  6. *The instances a handler made* are each a root of such units and are
     started the same way: no derivation until a list marks one of their entries
     or an event names one of their streams.
  7. *The order of the work.* The read of the documents and the derivation are
     of the same size, so a stored entry that reads its value on demand has to
     come with a wake that brings the documents of a unit when the unit is
     evaluated. Under the read-through the read of every document the result
     reaches before the derivation is not needed, since the replica reads from
     the store what the derivation reads; the storage manager says nowhere that
     a read-through is installed, so the resume cannot tell.

  *To decide first:* whether a row of the basis is of a cone instance or of the
  stored unit, a row document, which is question 22 of
  `scheduler-and-serving-loop.md`. Items (a) to (d) change `Instance.#ensure`,
  `#table`, `#reassemble`, the assembly of an index and the adapter's write
  path. The reverse lists alone, with nothing that reads them, would add writes
  to every load and nothing else.
- *A bounded load under the serving loop.* Two ways, neither built. *A
  transaction of the load that commits ahead of the wave:*
  `SpaceServer.#stampRun` refuses `ServerRunInfo.directCommit` for a run that is
  no `bookkeeping` run, and a bookkeeping run carries no acting principal and no
  record of a plan. It needs a ruling of the owner: whether a derivation may
  commit the rows of a first load directly, each transaction with the write
  records of its rows, under the basis `#commitDirect` takes, and what a reader
  may conclude from a board that holds some of its rows. Without it the rows of
  a load would be stored by a run of the kind the loop uses for its own
  bookkeeping. *A first derivation that stops after a bounded number of rows and
  goes on in the next cycle:* a reader sees the list grow, each wave holds whole
  rows under their own records, and it is item 4 (b) of the plan above, an
  assembly that holds the rows it evaluated and leaves the others as stored
  (question 432).
- *The names of handler runs from the identity of the event,* in place of the
  counts in a document of the piece. The serving loop has the identity of an
  event in its stream, and the scheduler's handler is not given it. It would
  make the names the same on a client that speculates.

**Before a toolshed may install the loader.**

1. The host of a call as an object that authored code is handed through no name.
   The emitted text freezes module data and hardens functions, and a handle
   names nothing in a public member; the names the emitter binds, and so the
   host, are kept from a body by the check alone ("Milestone 5: value code in
   the sandbox" above).
2. The compile off the loop's thread and outside the loop's wait (§10.5). The
   compile has a bound on its output and takes a signal, and its cache directory
   loses the trees of other binaries at the first compile.
3. A decision on who may write the document of the source and the document that
   names it, and with which label the reason of a refusal is stored (questions
   417 and 419 of the design's plan).
4. The compiled pattern as a document with the integrity of compiled output,
   where a client is to speculate (§10.5).
5. A compiler given to the toolshed's runtime, which nothing does but a helper
   of tests.

Beside the five, the open findings above stand for any server that stops and
starts: the first event after a takeover is the whole derivation in one cycle,
during which every other piece of the thread waits.

**Topics under the serving loop.** The arms `serving` and `serving-today` of
`compare/topics/scale.ts` with `SCALE_TAKEOVER`, one process for each board,
size and run, one at a time, measured on 2026-11-23 at load averages of 6.1 to
8.4. Each cell is the time in milliseconds until the second client, which sent
nothing, reads the value, at 100, 1,000 and 2,000 topics. The compiled boards
have the median of three runs, with a create as the median of three creates in
each run. Today's board has one run. The inputs are under no label; the serving
runtimes store the labels of the templates over them, 53 label entries on the
result document of the compiled board and 10 on the first row of `mentionable`.
The serving runtimes read from the store, today's as well, and the reader holds
the first screen of cards.

| Step | `filing-order`, compiled | `sorted-references`, compiled | `main.tsx`, today, one run |
| --- | --- | --- | --- |
| load | 546, 3,204, 6,047 | 549, 3,090, 5,956 | 2,320, 6,929, 13,266 |
| edit of a title, first topic | 34, 39, 39 | 34, 35, 38 | 106, 737, 1,475 |
| edit of a title, middle topic | 17, 18, 20 | 18, 17, 18 | 82, 1,005, 1,429 |
| edit of a title, last topic | 16, 17, 16 | 15, 20, 15 | 84, 754, 1,550 |
| edit of the mentions | 38, 109, 198 | 42, 106, 193 | 87, 696, 1,393 |
| edit of the `shortName` | 39, 118, 198 | 40, 111, 209 | 146, 1,242, 2,573 |
| edit of `lastActivityAt` | 8, 11, 9 | 12, 26, 39 (the sender) | 397, 2,685, 5,958 |
| create | 79, 185, 348 | 80, 194, 339 | 521, 2,460, 8,967 |
| takeover: a client reads `topicCount` | 37, 140, 229 | 39, 123, 223 | 123, 724, 1,536 |
| takeover: the loop is quiescent | 38, 140, 230 | 44, 128, 224 | 636, 4,115, 12,612 |
| first edit after the takeover | 545, 4,451, 8,543 | 548, 4,191, 8,316 | 132, 1,066, 2,296 |
| second edit after the takeover | 18, 20, 21 | 17, 18, 18 | 125, 1,671, 2,991 |

The lowest and the highest of the three runs at 2,000 topics on `filing-order`:
load 5,910 to 6,318, the edit of the middle title 20 to 21, the edit of the
`shortName` 196 to 204, a create 344 to 356, the first edit after the takeover
8,361 to 8,730. The basis found the compiled board current in every run, after
the comparison of 223, 1,280 and 2,284 documents, and the serving runtime
evaluated nothing before the first edit. The piece's own time is 2 ms for an
edit of a title, 3 for an edit of the `shortName` and 18, 33 and 48 ms for a
create, which is what it is on the runner path. The sender of the compiled
boards reads within 3 ms of the second client, since no client runs the board.
Today's sender runs the board itself and reads its own speculation first. The
first edit of a board is 34 to 39 ms at every size and was not taken apart.

- *What the comparison with today's board is of.* Today's arm runs `main.tsx`,
  the program of the repository, since today's compiler does not take the boards
  on the constructs; the compiled arm runs boards that the crate's check
  refuses. Today's arm has one run.
- *Against the runner path* (milestone 3, on emulated storage, timed until the
  scheduler of the one runtime is idle, with inputs under a clause): the load is
  3.2 s at 1,000 topics where it is 3.8 s; an edit of the middle title is 18 and
  20 ms at 1,000 and 2,000 where it is 13 and 14 ms; an edit of the `shortName`
  118 and 198 ms where it is 27 ms at 1,000; and a create 185 and 348 ms where
  it is 279 and 547 ms.
- *The first edit after a takeover* is longer than the load of the board and is
  the whole derivation (the finding on the unit of the basis).

**With the inputs under a label.** `SCALE_SERVING_LABELS`, with the mentions
declared as references, one run of each arm, measured on 2026-11-23. The
reader's time in ms at 100, 1,000 and 2,000 topics, with the time of the
preparations of the process in the step, the clients' and the serving runtime's
together, where it was reported:

| Step | `filing-order`, compiled | preparations in it | `main.tsx`, today | preparations in it |
| --- | --- | --- | --- | --- |
| load | 494, 3,268, 6,729 | 85, 726, 1,483 | 2,850, 16,164, 40,819 | 295, 7,388, 25,832 |
| edit of a title, middle topic | 20, 22, 24 | 3 | 218, 2,498, 5,004 | 60, 751, 2,003 |
| first edit of the mentions | 41, 97, 190 | 9 to 10 | not reported | |
| edit of the `shortName` | 50, 114, 198 | 9 to 11 | 428, 3,783, 7,192 | not reported |
| edit of `lastActivityAt` | 8, 11, 10 | 4 to 6 | not reported | |
| create | 132, 359, 761 | 21, 40, 79 | 1,019, 8,788, 15,372 | 452, 4,180, 9,392 |
| first edit after the takeover | 672, 4,576, 9,584 | 83, 663, 1,212 | 349, 3,362, 8,204 | not reported |
| second edit after the takeover | 31, 437, 37 | | not reported | |

The load of the compiled board makes five preparations and that of today's board
219, 2,020 and 4,019. The result document of the compiled board holds 68 label
entries, a row 10 and a topic 1; `sorted-references` is within an eighth of
these figures, with 70 entries on the result document. Nothing was refused on
either arm. The harness read no label entry on the result document of today's
board and one on a topic; where today's runtime keeps the labels of what it
derives under the serving loop was not looked for, so that zero says nothing of
whether it stores them. Against the same boards with no label on the inputs, the
compiled load is 0.7 s longer at 2,000 topics, an edit of a title 4 ms, and a
create twice as long, 761 against 348 ms, of which the preparations are 79 ms;
where the rest of the create goes was not profiled. The second edit after the
takeover at 1,000 topics, 437 ms, is one run and was not repeated. With labels
stored the first edit after a takeover is the one step of the compiled board
that is not below today's: 9.6 s against 8.2 s at 2,000 topics.

**One event under server execution.** `compare/serving-path.ts`, one process for
each run, with two clients over the websocket with server execution on. The
pattern is `fixtures/serving-list.tsx`, a `map` over an array of references,
each to an item in a document of its own, with rows as documents. The serving
runtime compiles the source with the crate's release binary, which is part of
the load, and reads from the store. A figure of an event is the median of 7
events in one process, in ms, from the send on the first client until that
client (`sender`) and the second (`reader`) read the label of the one row the
event changes; the load is from the commit of the setup until the second client
reads the last row. The table has the median of 3 runs of the compiled arm and 1
run of today's at each length, of 2026-11-23, at load averages of 6.3 to 11.1.
`Rows` is the length of the list at the start.

| Rows | Arm | Runs | Load | `rename`, sender | `rename`, reader | `add`, sender | `add`, reader |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | compiled | 3 | 127 | 15.9 | 16.3 | 26.9 | 27.2 |
| 100 | today | 1 | 811 | 4.1 | 17.8 | 11.8 | 40.2 |
| 1,000 | compiled | 3 | 352 | 15.4 | 15.7 | 39.9 | 40.7 |
| 1,000 | today | 1 | 2,003 | 4.0 | 20.3 | 59.5 | 189 |
| 10,000 | compiled | 3 | 3,153 | 26.4 | 26.9 | 226 | 227 |
| 10,000 | today | 1 | 53,228 | 5.7 | 29.1 | 654 | 2,344 |

The three runs of the compiled arm: the load is 123 to 140, 336 to 356 and 3,073
to 3,306 ms; `add` at the reader 26.8 to 29.0, 37.6 to 42.0 and 220 to 234 ms.

- *What the columns compare.* The reader's column is the served path on both
  arms. Today's sender runs the handler itself and shows the result from its own
  speculation, which is why its figure is below the reader's. A client runs
  nothing of a compiled piece, so its two columns are the same path.
- *A rename* of one item is flat to within a factor of two from 100 to 10,000
  rows on both arms.
- *An append* follows the list on both arms.
- *The load* of the compiled piece is one transaction of one wave, 3.2 s at
  10,000 rows against 53 s for today's piece.

**A takeover.** After the events, another serving loop takes the space over
(`CompiledServingMemoryServer.restart`), a client that holds nothing reads the
last row, and the sender sends two more events. In ms from the restart, the same
runs:

| Rows | Arm | A client reads the last row | The loop is quiescent | Documents the comparison read | Evaluations before an event | First event, reader | Evaluations by then | Second event, reader |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | compiled | 25.6 | 29.2 | 199 | 0 | 48.2 | 113 | 12.0 |
| 100 | today | 122 | 158 | – | – | 14.5 | – | 15.3 |
| 1,000 | compiled | 79.3 | 81.2 | 1,263 | 0 | 223 | 1,013 | 13.1 |
| 1,000 | today | 1,093 | 1,551 | – | – | 18.1 | – | 17.7 |
| 10,000 | compiled | 658 | 662 | 10,268 | 0 | 2,134 | 10,013 | 14.9 |
| 10,000 | today | 33,162 | 69,899 | – | – | 25.7 | – | 26.2 |

The first event after the takeover is 42.5 to 49.9, 218 to 226 and 2,131 to
2,291 ms in the three runs of the compiled arm. The piece was found current in
every run. The serving runtime evaluated nothing and started no executor until
the first event; `Instance.counts.evaluations` is counted from the wake. What
the takeover costs is the read of one document for each source and for each part
of the basis, each a sync of its own. Today's piece is loaded and run again by
the loop that takes over. The first event pays for the wake: it starts the
executor, which brings every document of the piece and evaluates every row once,
where today's piece was loaded by the takeover. The second event is as an event
before the takeover.

**An append, profiled, with the serving runtime reading over a session.** A
profile of 2026-11-23, taken before the serving runtime of the harness read from
the store: `serving-path.ts --profile=<file>` over seven appends at 10,000 rows,
4.1 s sampled, with the memory server, the serving loop and both clients in the
one process. 29 % was the memory server evaluating the queries of its sessions
again (`refreshTrackedGraph` and `rewalkDocument` of
`runtime/memory/v2/query.ts`); 21 % every replica that holds a changed document
taking it whole (`SpaceSession.#onMessage`, `parseWireText`, `deepFreeze`);
about 20 % the commit; and 1 % the piece, 44 ms for 14 events. An append took
492 ms at the reader in that posture, and takes 227 ms with the read-through. No
profile of an append was taken with the read-through; the profile of an edit of
a `shortName` on Topics, in the finding on a step that changes a member of the
result document, is of the read-through. That every holder takes a changed
document whole is the protocol's, and what would remove it is what the finding
of milestone 3 on a document of links names.

**The corpus under the serving loop and after a resume.**
`compare/runner-corpus.ts`, one run of each over the 376 modules the crate emits
on the measurement branch, of which 239 are run with no table for a `wish`. A
module passes where the piece starts, every event is handled, no commit is
refused and the piece holds the values of the executor in memory.

| Arm | Pass |
| --- | ---: |
| the runner path | 183 |
| under the serving loop (`--serving`) | 183 |
| after a resume from the basis and a wake (`--resume`) | 182 |

- *Under the serving loop* a memory server listens on a websocket with the
  serving loop on the same thread and one client: the client writes the main
  file of each module as its source and appends each event with a send to the
  entity of its stream, the serving runtime, which reads from the store,
  evaluates the value code in a compartment, and the harness waits for the loop
  (`ExecutorHost.whenQuiescent`) and compares what the serving runtime's piece
  holds. The counts of the report are those of the runner path: 230 of 239
  start, 200 have every event handled, 215 have no commit refused and 210 equal
  the executor in memory. What a client reads through sync is not compared: the
  stored result holds the executor's forms, a link by key among them, which the
  runtime's read does not resolve.
- *After a resume* each module is handed to a second runtime after half of its
  events. 131 modules were resumed; the others have no event or do not start.
  The basis of all 131 matched the storage, so each was found current with no
  evaluation, and the wake that followed wrote no document for 93 of them.
- *The module that does not pass after a resume* is
  `dev/gideon-tests/test-idempotent-side-effects.tsx`, which holds a computation
  that is not idempotent and counts its own evaluations, and is evaluated once
  more by the wake. The two modules that render a record as text and the module
  with an instance a handler made pass.

**FabriChat and Home** have a section of their own below.

**Not verified.**

- The assumption that a contribution to a wave is refused where a document it
  read whole changed before the commit has no test.
- A serving loop that the deadline of a wave cuts between a handler and the
  handling of the event it sent was not seen; the test makes the stop.
- A resume between the transaction of the event that made an instance and the
  derivation behind it is not tested.
- Today's arms have one run at each size, and so have the labeled arms.
- No run has a source changed while no loop served the space, which costs the
  same wake as the first event.
- The time the compiler takes inside the load was not taken apart from it; for a
  fixture of one file milestone 5 measures 4 ms.
- Whether one cycle that drains several events runs the derivation once was not
  measured.
- The modules whose wake wrote documents though the basis matched were not
  traced one by one or counted again, and the order in which an index gives its
  keys was not examined.
- What a client reads of a compiled result through sync was not compared over
  the corpus.
- A wave that holds the transactions of two pieces and is rejected was not
  tested.
- The first edit of a board, 34 to 39 ms at every size, the create with labels
  on the inputs, and an append with the read-through were not profiled.
- Where today's board keeps its labels under the serving loop, and whether the
  two arms store labels of the same strength for the same derived values.
- The reader's sink that resolved before the edit, the run that did not start,
  and the client whose sink from before a restart was not reached.
- No figure is of a serving loop in a process of its own, of a toolshed, or of
  an idle machine.

**Not built.**

- A basis per unit and a wake that evaluates what an event reaches, the bounded
  load, and the names of handler runs from the identity of the event ("Stubbed,
  with a plan" above).
- *The arrays of row links and the records of bucket links of the result in
  documents of their own,* with a link at their member of the result, as the
  rows and the buckets themselves are kept. A reader of the first screen then
  holds the result document and the document of the children of the board, and
  is delivered neither the record of the buckets of an index nor the arrays it
  does not read. The write of a changed record would still follow the board, at
  a sixth of the bytes on the measured board. It changes the places of
  `RuntimeTransactions` (`#rowArraysOf`, `#bucketRecordsOf`, `#placeOf`) and the
  targets of the write records.
- For a serving runtime that reads over a session: the inputs brought under the
  argument schema of the plan, with each position the plan reads as a reference
  not followed, and a `load` that waits for a document the replica lacks.
- The read of every reached document before a wake left out under the
  read-through, which needs the storage manager to say that a read-through is
  installed.
- The list of made instances written member by member, and an instance started
  at a wake only where it is demanded.
- The heads of the sources read from the memory server's tables in place of one
  sync for each source, and the list of the documents a piece made kept outside
  the one document of the basis.
- The comparison of `Store.write` and `Store.put` by a text that does not hold
  the order of the members.
- The compiled pattern as a document of the space, a compile outside the loop's
  wait, and the other items needed before a toolshed installs the loader.
- A schema on the link to a state cell that gives a reader its default.
- The mark of a compiled space, and client speculation.
- The stream document of the design, its watermark and the stream index, an
  effect's request leaving the piece, the withdrawal of one derived write, and a
  scheduler node for each cone instance.

## FabriChat and Home

Built on 2026-11-23 on the branch `claude/compiled-pattern-sandbox-m5`, and read
at its commit `bada36c846`. The copies are
`base/pattern-compiler/compare/fabrichat/` and `compare/home/`, with the harness
`compare/fabrichat/scale.ts`; the changes of the crate are in `src/declared.rs`,
`src/narrow.rs`, `src/infer.rs` and `src/emit.rs`, those of the executor in
`exec/executor.ts` and `exec/store.ts`, and those of the adapter in
`runtime/runner/src/compiled/transactions.ts`. Notes 720 to 741 of
`base/pattern-compiler/SPEC-NOTES.md` on that branch hold the detail, and the
provisional decisions P190 to P197 and P200 of
[compiled-pattern-language.md](compiled-pattern-language.md) are of this work.
`room.tsx` and `manager.tsx` of `patterns/system/fabrichat/` import each other
and are one program of 16 modules; the program of
`patterns/system/home/home.tsx` has 26 modules and holds that one. Every figure
is of one run of each cell, on an Apple M5 Max with 18 cores at a load average
of 6 to 12 from other work. Whenever this section says `map`, it names the case.
Every figure but one is the build agents'.

**Findings on structure, scale and soundness.**

- *The comparison with today's runtime is not like with like, in four respects.*
  The compiled arm runs with the write policies, the added integrity and the
  write authorizations removed from the schemas, so its preparation checks no
  policy. It answers `wish` from a table and about 20 built-ins with constants,
  for one fixed user who owns every space. Its storage is in the thread of the
  runtime, where today's arm has two runtimes of the person in workers, the one
  that set the profile up and the one that sends, and both run the room; a
  settle of today's arm is at least two rounds over both. And today's arm keeps
  the links to the messages as links, where the compiled arm holds the schema of
  the message in each. So today's figures are an upper bound of what a send
  costs today in one runtime, and the compiled figures a lower bound of what the
  compiled path will cost with policies checked. Neither arm runs under server
  execution.
- *Scale, not closed: a send grows with the room on every arm.* A send evaluates
  the same 27 cones and 11 element bodies at every size, and makes 5 commits. On
  the runner path it takes 72 to 74 ms into a room of 10 messages, 236 to 244 ms
  at 100 and 1,690 to 1,802 ms at 1,000, about 1.7 ms for each message held, and
  reads 93, 543 and 5,043 positions and gives 137, 499 and 4,099 records. On the
  executor in memory it takes 8.5 to 9.7, 45 to 49 and 259 to 285 ms. Today's
  runtime, in its own harness, takes 690 to 757 ms at 10, 1,654 to 1,770 at 100
  and 4,188 to 4,231 at 256. The owner's own figure is 1.2 s for a send at 30
  messages on a deployment; the compiled path passes that between 500 and 1,000
  messages, so it is below today's at the sizes both reached and does not meet
  the rule that a step does not grow with the data. What grows, and why, is
  below.
- *Soundness, closed with a test: a place of the result that held a time of the
  data model was not written when the time changed.* FabriChat stores every time
  as a `FabricEpochNsec` and its policy as a `FabricDurationNsec`. The executor
  refused one as "a value that is no plain data"; once admitted, a copy by
  `structuredClone` made the plain record `{}` of it, and its text as JSON, by
  which the executor compared values, is `{}` whatever it holds, so every two
  times were equal. The window `messages.latest.messages` of the room, which
  holds the 100 newest messages by value, kept at each position the `sentAt` of
  the message that stood there before the window moved. A primitive of the data
  model is a leaf of the executor's values, compared by the text of the JSON
  codec of fabric values, and a `bigint` by its digits (provisional decision
  P194), and `put` of `Instance.#place` compares by `canonical`. *Not closed:*
  40 other places of `exec/executor.ts` form a text with `JSON.stringify` and
  were not read one by one, so a comparison or a key formed there from a value
  that holds a time may still see `{}`, and a `bigint` there throws (question
  472 of the design's plan).
- *Scale and structure, closed: the canonical text of every slot of the plan was
  formed for each slot bound.* `Instance.#elementsBound` binds a slot below the
  elements of a collection that no element was read for. For each such slot it
  formed the canonical text of the root and path of every slot of the plan, so
  the work of one record was the square of the number of slots of the plan.
  Home's plan is large and its event gives 63 records: 630 of the 700 ms of its
  profile were there, and 310 of about 1,000 ms of a send into a room of 100
  messages. `Instance.#valueSlotsAt` holds the slots at each root and path, made
  once for an instance. Home's event takes 83 ms on the runner path, from 690.
- *Soundness, closed with a test: a value written in the state of a binding had
  no function.* The state of a handler applied in the reactive tier is read by
  the places of the plan, so the emitter rendered none of its expressions, and a
  conditional written there, as `container: ownSpace ? undefined : container`,
  had an output and no value function: the first event of the room failed.
  `binding_state` of `src/emit.rs` renders each member of the state that is a
  value with no function.
- *Soundness, suspected and deferred by the ruling Z88: four sites of the
  manager have no record of labels.* Three bodies read the access list of a
  space whose operand an authored function returned, so the plan has no entry of
  `dynamicReads` for the read, and one sends through a handle the emitter cannot
  name, so no template covers the write (questions 458 and 459).
- *Structure: three refusals of Contextual Flow Control that the harness steps
  around.* With the schemas as the crate emits them, no send of the room commits
  and Home's first commit is refused: a write policy names its handler as `{
  body: { binding, module } }`, which the preparation refuses as "malformed
  writePolicyAnyOf"; integrity of the current principal "requires the run's
  actor", which an event this harness queues does not carry; and
  `writeAuthorizedBy` is an "unsupported trust-sensitive claim". The harness
  gives the schemas without those three members unless `SCALE_POLICIES` is
  `keep` (provisional decision P196; questions 455 to 457).
- *Structure: the seed of a room is the square of its size.* Each of its sends
  is a send into the room as it stands: the sends that fill a room of 1,000
  messages take 152 s on the executor in memory and 901 s on the runner path.

**What the checker refused, classed.** The program of Home had 38 errors, 33 in
the 16 modules of FabriChat and 5 in the other 10. By class:

| Diagnostic and site | Errors | Class |
| --- | ---: | --- |
| `schema:unknown-type-access`, `commitAttach` of `room-records.tsx` | 5 | Defect of the crate: the type parameter of `attachRequests` was not bound |
| `subset-type:mismatch`, `changeSharedSpaceMembershipIn` of `shared-space-catalog.ts` | 3 | Defect of the crate: narrowing |
| `subset-type:mismatch`, `sharedSpaceProfileViewOf` of `shared-space-interface.ts` | 1 | Defect of the crate: narrowing |
| `subset-type:any`, `profile-home.tsx` 8, `shared-space-catalog.ts` 3, `agent-queue.tsx` 3 | 14 | The language has no `any` (`language-subset.md` §7.8). The pattern changes |
| `subset-type:overload`, `manager.tsx` 5, `private-inbox.tsx` 1 | 6 | The language has no overload. The pattern changes as §12.4 says |
| `opaque-get:invalid-call`, `takesOffers` of `manager.tsx` | 1 | A `Stream` has no `get`. The pattern changes as §12.9 says |
| `subset-type:mismatch`, a `Cell<T>` where `Cell<T \| undefined>` is declared or the reverse: `room.tsx` 3, `room-records.tsx` 1, `favorites-manager.tsx` 1 | 5 | Rule of the language (§7.5.1, §7.5.2, §7.5.4). The pattern changes |
| `subset-type:mismatch`, a cell where `{ get(): T }` is declared, `rosterProfiles` | 1 | Rule of the language (§7.5.1). The pattern changes |
| `subset-type:mismatch`, a `Cell<Message>` where a `Cell` of a view of it is declared, `room-records.tsx` | 2 | Rule of the language (§7.5.1). The pattern changes |

So 9 of the 38 were defects of the crate, and 29 are forms the language does not
have or refuses by rule. The constructs the emitter did not translate, by site:

| Construct | Sites | Class |
| --- | ---: | --- |
| A guard in the block body of the callback of a collection method of a promoted `computed` | 3 | Gap of the crate: `language-subset.md` §6.1 admits the body. Not built; the copies changed |
| `resolveAsCell` in a promoted `computed` | 2 | Gap of the crate: §4.7 and §6.1 admit it in the reactive tier. Not built; the copies changed |
| `elementById` with a constant key in a promoted `computed` | 1 | The same |
| `P.asScope("user")(...)` in the body of a `map` | 3 | Gap of the crate: `builtin-inventory.md` names these sites. Not built; the copies changed |
| A call of a function with no footprint record | 2 | Follows from the overloads, and is gone with them |
| A dynamic read of kind `space` whose operand the emitter cannot name | 3 | Gap of the crate, in the records of labels. Left as it is |
| A write through a handle the emitter cannot name | 1 | The same |

**What the crate fixed.**

- *The walk of a type gave up at 12 steps* (provisional decision P190).
  `typed_at` of `src/declared.rs` counts the steps from the expression asked for
  to the declaration that types it, and returned no type past 12. In
  `commitAttach` the type parameter of `attachRequests` stayed unbound for it.
  The limit is 24. It is a limit of depth and no guard against a cycle, so a
  type still depends on how deeply its initializer is nested, at a depth no
  module of the corpus reaches. The corpus has 13 errors fewer and none more.
- *Three forms of narrowing* (`src/narrow.rs`; provisional decisions P191 and
  P192). An optional read of a discriminant compared with a literal, as
  `c?.status === "unavailable"`, narrows the union as the plain read does. A
  strict comparison of an ordinary value typed `unknown` with `undefined` or
  `null` gives that type in the true branch, and not on a data position. A type
  predicate narrows a value to the asserted type where no member of the value's
  type is assignable to the asserted type and the asserted type is assignable to
  a member.
- *The operand that decides* (provisional decision P193). The left operand of
  `&&` gives the result the part of its type that can be falsy, and the left
  operand of `||` the part that can be truthy (`deciding_part` of
  `src/infer.rs`), and a literal position of a tuple has that element's type.
  Both were false refusals that the limit of the walk had hidden.
- *A value function for each value of the state of a binding* (the finding
  above).

**The copies, and what each change stands in for.** `compare/fabrichat/` holds
the 16 modules of the program of FabriChat and `compare/home/` the other 10 of
the program of Home, each in the directory it has under `patterns/system/`. The
patterns under `patterns/` are untouched. Each change is a commit that names
what it stands in for. Both programs pass `check` with no error, and `emit`
gives every pattern of both value code with nothing unsupported; the plans of
`FabriChatManager`, `FabriChatManagerCore` and `Home` keep 4 entries for the 4
sites of the manager whose operand an authored function returned. That the
copies still compile and run on today's runtime was not verified.

- *For the rules of the language.* No `any`: a stored reference is declared
  `unknown`, an open record `Record<string, unknown>`, an instantiation takes
  `.for(cause)` with no cast, and the result of the agent queue declares the
  types its cells hold. No overload: `inboxLinkOf` and `roomLinkOf` are deleted
  and the instance is assigned to the declared cell type, `aboutRecordOf` keeps
  one signature, and for `linkedRoom`, `joinStreamOf` and `inboxOf` the position
  is declared with the type that is read. A stream's presence is tested through
  `ReadonlyCell<{ receive?: unknown }>`. A handle of `T | undefined` is declared
  so on both sides. `rosterProfiles` declares `ReadonlyCell`. A link to a
  replied message is declared `Cell<MessageRecord>`, the type the cell has,
  which is recursive through the cell.
- *For a guard in the callback of a collection method of a promoted `computed`*
  (3 sites): a conditional expression. The plan for the crate: `statements` of
  `src/plan.rs` handles the block of such a callback and knows no `if`, while
  `code_block` gives the block of the `computed` itself a `select` for each
  guard; the callback needs the same, with the place of what it returns in place
  of a template.
- *For `elementById` and `resolveAsCell` in a promoted `computed`:* a call in an
  authored function (`titleSetIn`, `resolvedMessage`, `resolvedKeyOf`), which is
  a body with a footprint of its own, so the label of the result is that of the
  whole body. The plan: `elementById` with a constant key is a path projection
  by key, as `key` is, and `resolveAsCell` an observation of class `identity` of
  the place its receiver names.
- *For `asScope("user")`:* `RoomRoster` and `NoticeTold` are instantiated
  without it. The state the instance declares is then of the space and not of
  the user, which is the same with one user and wrong with two. The plan: the
  modifier sets `Child.scope` on the call-site record, which the plan has for a
  call outside an element body.
- *For a schema made by hand:* `pattern` is given none (`agent-queue.tsx`,
  `home.tsx`), since the language has no such argument.
- *For the measurement.* `messageRightsForSession` is a `map` over the stored
  messages, an array of references, where a `computed` mapped the entries that
  `facts` returns, which is a `map` over the result of a body, formed whole at
  each send, with a copy of each message in the result. A message the room
  cannot read has a row there, where the entries left it out. And `indexesOf`
  reads the length of a list at its member `length`, where it read the list
  whole for it.

**The stand-ins of the harness.** Each keeps a figure of this section from being
that of the pattern as deployed.

- *`wish` from a table* (provisional decision P197). A `wish` is answered by the
  table of `compare/wish-home.ts` through the option `wishes` of the instance,
  which `CompiledPieceOptions` passes on: `#profile` is a reference to a seeded
  profile, and `#default` and `#chatManager` have no answer and hold an error.
  Nothing of the runtime's own `wish` runs. The plan: the piece resolves the
  operands in its derivation transaction with the functions
  `runtime/runner/src/builtins/wish.ts` resolves a target with, stores the
  outcome in the operation's state document with the reads the resolution made
  as the entry of `dynamicReads`, and launches a sidecar as the `Child` the plan
  has for it; the two sidecar patterns are not compiled into the program.
- *The built-ins answered by constants* (provisional decision P195). The copies
  import 25 names of `commonfabric` that the executor does not have. The pure
  ones (`isWellFormedDID`, `parseDID`, `joinSpaceMembers`, the classes of the
  data model) are the runtime's own, handed in. The others read what the runtime
  holds: the acting principal and the key of the event (`currentPrincipal`,
  `eventKey`), the owner a label attests (`profileOwnerOf`, `principalOf`,
  `writtenPrincipalOf`, `resultOwnerOf`), and the access list of a space
  (`spaceAccess`, `spaceMembers`, `spaceDeleted`, `spaceOfLink`). The option
  `builtins` of the instance answers a name the executor lacks, and never one it
  has, and the harness answers these for one fixed user who owns every space.
  The plan: each is an observation with a class of its own in
  `builtin-inventory.md`; the executor needs the acting principal and the key of
  the event from the transaction it runs in, which the adapter has, and for the
  others a read of the label or of the access list through the adapter, recorded
  as a dynamic read.
- *Write policies, added integrity and write authorizations removed*
  (provisional decision P196; the finding above).
- *The profile seeded in the room's space.* The profile of a home is in a space
  of its own. A document that a link names in another space is read there by the
  adapter, and a document of another space that the replica does not hold is not
  brought, so the harness seeds the profile in the room's space. What the
  adapter still needs: the sync of a document the replica does not hold, after
  which the piece derives again, as the runner's pre-sync does; the space of a
  link that names none inside a document of another space, which is that
  document's space; an identifier of the executor for a document that includes
  its space, since two spaces can hold documents of one entity; and the read
  recorded for the basis with its space.
- *The stand-in for `SELF`* is a key the result of Home does not hold, so two
  cones of Home are in an error state on both arms, `$UI` and one `map`.

**What a send, the seed, Home and the manager cost.**
`compare/fabrichat/scale.ts`, on the executor in memory and as a compiled piece
in the runner on emulated storage with value code in a compartment; today's
runtime with `patterns/integration/fabrichat-room-send-scale.ts`, which runs the
room of `patterns/system/fabrichat/room.tsx` in the fixture
`fabrichat-room-profile-wish` on `MultiRuntimeHarness`, with the labels and the
write policies the pattern declares and server execution off, a send timed from
the event to the end of `MultiRuntimeHarness.settle()`. One run of each cell,
three sends, measured on 2026-11-23. Milliseconds.

| Step | Messages held | Executor in memory | Compiled piece in the runner | In the piece | Today's runtime |
| --- | ---: | --- | --- | --- | --- |
| Room, send | 10 | 8.5 to 9.7 | 72 to 74 | 31 to 33 | 690 to 757 |
| Room, send | 100 | 45 to 49 | 236 to 244 | 116 to 119 | 1,654 to 1,770 |
| Room, send | 256 | not run | not run | | 4,188 to 4,231 |
| Room, send | 1,000 | 259 to 285 | 1,690 to 1,802 | 892 to 974 | not reached |
| Room, the sends that fill it | 100 | 2,404 | 15,174 | | 106,284 |
| Room, the sends that fill it | 1,000 | 151,924 | 900,644 | | 256 in ten minutes |
| Home, start | | 45 | 221 | | not run |
| Home, one event | | 5.8 | 83 | 26 | not run |
| Manager, start | | 25 | 129 | | not run |

The coordinator ran a send into a room of 100 messages on the runner path on
2026-11-23, at the commit this section is read at: 219 to 227 ms, 107 to 112 ms
of it in the piece, with 543 to 553 positions read and 499 to 507 records. Home
starts with 101 evaluations, 16 element bodies and 43 members of the result, and
the manager with 38 evaluations and 20 members. Home's event adds a space to its
list and evaluates 4 cones.

- *What the comparison shows.* On each harness as it stands, the compiled path
  is below today's runtime at each size both reached, by 9 times at 10 messages
  and 7 times at 100, and both grow with the room, today's more steeply.
- *What it does not show.* What either costs under server execution, with
  policies checked, with the runtime's own `wish`, or with two users. Today's
  runtime was not run on Home or the manager, and not at 1,000 messages.
- *The 5 commits of a send* are the design and no defect: the handler of
  `sendMessage`, the handler of the stream `tellJoined` that it sends to, the
  first derivation of the row instance the handler made (ruling Z87), and two
  derivations.

**What still grows with each message held, and why.** From profiles of three
sends at 1,000 messages on each arm (`SCALE_CPU_PROFILE`, `SCALE_TRACE`).

- *The pattern's own.* `facts` (`messageFacts` and `messageEntries` of the
  copies) reads every message at each send: the record, `sentAt` and `body`
  again by their own cells, and the author through the link `authorProfile`, the
  outcome of the `wish` and the profile. That is 5 positions read for each
  message, by the design of the pattern. `rowFactsForSession` reads the rights
  of every message and forms a record with an entry for each, and
  `threadMessages`, `participants` and the members of the result under
  `messages` read what `facts` returns.
- *The executor's, on both arms.* A read of a value copies what it reads, each
  link followed (`Host.v`, `Store.read`): 115 ms of a send of 257 ms in memory
  at 1,000. The `map` over `facts.main` that makes the rows of the conversation
  is a `map` over the result of a body, and `Instance.#reassemble` brings an
  assembly up to date only over a stored array or over another collection, so
  this one is formed whole at each send, which checks the dependencies of every
  row and its state cells: 42 ms. And the canonical text of what `facts`
  returns, formed to see whether it changed, with the registration of each
  position it read: 70 ms.
- *The executor's and the adapter's, on the runner path alone.* The records of
  the rows of `messageRights`, a `map` over an array of references, are given
  again at each send: the record of a row names the position `*` below the
  messages for a slot that no evaluation bound, an append stores a label at the
  new position, and a path that names every element is taken to consume another
  label. That is 4 records for each message held, 177 ms at 1,000, with 65 ms of
  the 244 ms of the preparation for their templates (question 463).
  `Instance.#unchangedOutput` gives a record for every place of the result that
  a comparison left as it was, 160 ms at 1,000. And every stored link to a
  message carries the schema of the message, 1.5 KB, where the handle that the
  body returned was typed: the result document of a room of 203 messages is 1.29
  MB in the executor's store, about 6 KB for each message held. The storage
  interns the schemas of links; the executor and the adapter form the text of
  each, compare it and encode it. Whether a stored link to a typed handle has to
  carry the schema is not decided.
- *Removed.* The window of the room was written member by member, 100 writes and
  100 records, twice, for each send into a room of 100 messages or more: a place
  of the result that holds an array of the same length with another value at
  every position is written once (provisional decision P200), 265 ms for a send
  at 100 against 620. `Instance.#place` forms the inputs of a cone instance once
  for the records of the places it leaves as they are. And the adapter answers
  whether a path consumes another label once for a path and a class in a change
  (`RuntimeTransactions.#reportLabels`), where it asked for each position of
  each record: 480 ms of a send at 1,000.

**The plan for `facts` on the constructs.** Not built. The entries are a `map`
over the stored messages, an array of references, each entry from its own
message (`key`, `sentAt`, the keys of what it replies to, `inMain`, `live`,
`authorKey`). `main` is a `filter` of them by `inMain` and a `map` to the cell,
which gives an array of references that the rows of the conversation are a `map`
over. `places` is a `groupBy` of the entries by the key of their thread, and a
row reads `lookup(key)` for the count of replies and the newest of them.
`authors` is the keys of a `groupBy` by `authorKey`, in the order the buckets
came to exist. `count` is the length of the messages. `latest` is the last 100
of `main`, which needs a construct the language does not have, a window of the
newest members of a collection that is brought up to date by the splice of its
source; until then a body reads `main` whole. `threads` is a `flatMap` over
`main` with the bucket of each root. `legacyReplies` is the length of a
`filter`. `rowFactsForSession` goes away: a row derives its own controls from
its message and from what the session holds, as a row of `messageRights` does.
What the emitter lacks for this is the three constructs the copies stand in for.
Beside it, for the executor: a third branch of `#reassemble` for a source that
an output computes, which takes the keys of the array the output holds, finds
the one run that differs from the keys of the table, as `spliceBetween` of the
adapter does for values, and applies it as the splices of a stored array are
applied.

**Not verified.**

- No test was written first for `#valueSlotsAt`, for the inputs of a cone
  instance formed once, or for the adapter's answer once for a path and a class;
  each changes no value, and the tests of the records pass.
- A resume of a piece whose stream marker was written by the handler that first
  sent to it.
- Why 17 of the corpus modules with a `wish` differ from the executor in memory,
  why two modules handle fewer events with the marker of a state-held stream,
  and why `apps/redactor/vault.tsx` holds its refusal of writer fit twice.
- The emitted files of the fixtures `crossref` and `index-of-rows`, which emit
  with nothing unsupported, were not regenerated.
- Each cell is one run on a machine with other load.

**Not built.**

- The three constructs of the emitter that the copies stand in for, and `facts`
  on the constructs.
- A window of the newest members of a collection.
- The runtime's own `wish`, the built-ins that read a label or an access list,
  and the sync of a document of another space.
- The assembly of a `map` over the result of a body by its keys, a read without
  a copy, and a stored link to a typed handle without the schema.
- A row's record that an append to its array does not give again.
- The remaining texts of JSON in the executor read one by one.
- Today's runtime at 1,000 messages and under server execution, and either arm
  with two users.
