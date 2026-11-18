# Compiled pattern language: continuing the specification

This plan carries the design work on the
[compiled pattern language](../specs/compiled-pattern-language/README.md) from
its current state to a set of specifications complete enough to prototype
against. It is written for an agent picking the work up with no other context:
it says where everything is, what is decided, what is open, and what to do
next.

## Where the work is

- **Branch:** `claude/fable-pattern-language-redesign-vvh48e` in
  `commonfabric/labs`, draft pull request #9788.
- **Documents**, all under `docs/specs/compiled-pattern-language/`:

  | Document | Owns |
  | --- | --- |
  | `README.md` | The overview: the design in outline, staging, and the open questions that cut across documents |
  | `language-subset.md` | The TypeScript subset: tiers, grammar, type rules, labels as annotations, diagnostics, standard-library surface, corpus measurements |
  | `plan-and-label-templates.md` | The plan format, slots and observation classes, the label rule of every operation, instantiation, error states, what rests on the compiler |
  | `builtin-inventory.md` | Every built-in and factory: what it does today, its class in the new design, its informal label rule, and the calls legal inside function bodies |
  | `footprint-analysis.md` | The analysis of a function body: the abstract domain, the transfer rule of each construct, the causes of a widening, the write side and what makes a computation a materializer, reads through cell handles, the soundness lemma |
  | `execution-and-storage.md` | The transaction of one cause for one instance, cone evaluation and the in-memory memo, the layout of a result document, causal identifiers, durable operation state, provenance, cache promotion, migration |
  | `scheduler-and-serving-loop.md` | What remains of the scheduler across instances: the address index, demand, events, effects, materializers, convergence bounds, links and commits across spaces, the serving loop, compiled artifacts, client speculation |

- **Cross-read record:**
  [`../history/specs/compiled-pattern-language/cross-read-2026-11-11.md`](../history/specs/compiled-pattern-language/cross-read-2026-11-11.md)
  lists every contradiction found by reading the seven documents against
  each other, with the side that governs and the smallest correction for
  each. This plan cites its findings by number: K1 to K19, the numbers 1
  to 26 of its section 3, F1 to F21, and the A, B, C, and D numbers of its
  section 5. Its corrections are applied in every document, in two rounds
  of passes. Not applied are the ones that wait on the owner (A2, A9, the
  first item of A14, the two senses of "cause" in A17, K3, K13, and what
  remains of K12), the corpus counts (K4, K5, A16, F20), and the numbering
  gap after §3.19 of the plan document (K7), which stays because other
  documents cite the numbers after it.
- **Second cross-read record:**
  [`../history/specs/compiled-pattern-language/cross-read-2026-11-12.md`](../history/specs/compiled-pattern-language/cross-read-2026-11-12.md)
  is the same review made after those passes, by five readers, one per
  seam between documents: 85 findings, numbered 1.1 to 5.17, of which 23
  would stop an implementer. Its corrections are applied in all seven
  documents, by seven authors working at the same time from one list of
  decisions for the findings that offered a choice. A check of the seams
  between the documents followed, and its corrections are applied.
- **Prototype:** branch `claude/compiled-pattern-prototype` holds a Rust
  crate at `base/pattern-compiler/`, stage 2 in progress. It is not part
  of this branch. It parses the corpus with the `oxc` parser, classifies
  code into tiers, and holds the subset type checker: written types,
  inference, narrowing, assignability, and promotion by the typed
  criterion, which agrees with the syntactic one wherever it decides. At
  prototype commit `44515f9159`, on 426 corpus modules, it accepts 335
  without an error and reports 386 errors: `any` in a type (182), 75
  type mismatches, a function type in data from one declaration (35),
  and `patternTool` (31) are most of them. Footprint analysis covers
  `footprint-analysis.md` §2 to §8, with the record of each use of a
  body, and finds 90 of 1,972 bodies widening (4.6%) where the
  document's script found 83 of 1,962. Its listing for FabriChat's
  `commitEdit` equals the one in §12.3. A `plan` command emits the
  plan as JSON with label templates, schema documents, declared
  labels, and constraint records. It emits a plan with no unsupported
  construct for 271 of the 288 accepted modules that hold a pattern;
  `patternTool` is the most frequent construct left. In those plans
  9,051 of 9,100 outputs have a template. Nine slots have a declared
  label, and the accepted plans hold 52 writer constraints. All six
  `cfc-flow:*` diagnostics are built. The five that are errors report
  nothing in the corpus. `cfc-flow:ui-contract` reports twice, in the
  lobby and in FabriChat, each for a sub-pattern whose trusted surface
  is in the pattern that embeds it; by the document's rule for a
  pattern written as a tag, the lobby's is not a report. A write-floor
  or writer-fit constraint on a write a body makes through a handle is
  never decided, because the template holds the handle's `identity`
  slot, which has no declared label. Not built: hashes of code and schemas,
  `$defs` for recursive types, and constraints at created and request
  targets. A comparison of template labels with the labels the runtime
  computes exists at prototype commit `4ca9fe56cb`, under
  `base/pattern-compiler/compare/`: a template evaluator in TypeScript
  and a harness over the runner's emulated storage, with no server and
  no browser. It generates a scenario per module, with a distinct
  clause per input and one event per handler. Of the 270 modules with
  a full plan, 213 run; 33 need `wish`, 14 request an effect, and the
  runtime refuses the commit of 10. Of 1,388 outputs compared, none is
  looser and none incomparable with the pattern's atom on kept
  outputs. Without that atom, which tests the rule of each template,
  47 are looser in integrity alone, by the ruling on a promoted
  `computed`, and none is looser in confidentiality. None is looser
  without the runtime's static part. The modules run have 651
  bindings with 924 write edges: 266 written in the pattern itself,
  314 of a pattern compiled in at a tag or a call, and 71 of an
  element body. 377 have a result path and 344 get an event that
  commits; 15 events are refused, 6 of them by a pattern written to
  be refused or for a trusted event the harness does not send, and
  the rest by the handler on the generated values or by gaps in the
  crate, the harness, and the generator. Of 231 write edges compared,
  219 are equal, 12 tighter, and none looser. Of the 12 tighter, 10
  have a label an earlier event of the scenario left on the shape of
  the target. In 2, of `examples/map-demo/map-demo.tsx`, a handler of
  an element body writes a cell it captured, and the stored label
  holds the join of the `map` coordinator's transaction, which is on
  every path of the element's argument document and holds the labels
  of the list's own document (prototype note 261); the template has
  none of it, by the ruling that labels flow per value through the
  callback of a per-element construct. 3 edges for a value are not
  compared because the run stored a link at the target, and the edge
  with a reference for the same write is equal.
  150 write edges are of a write the run did not make; a sample of 40
  found a write of an equal value, a branch not taken on the generated
  values, or a random choice, and no error. The comparison is partial
  in these ways. 208 bindings of patterns reached through elements of
  an array of pattern results have no result path, and 37 write edges
  target the stream of another binding and 52 hold a slot over all
  elements; neither kind is compared. Outputs below the elements of a
  collection are not compared. With the events sent in the order of
  the plan, no row is looser either, and one row differs because the
  event reaches another element. In that order 228 write edges are
  compared: 219 are equal and 9 tighter, 8 of those by a label an
  earlier event left and 1 by the join of the `map` coordinator; 2
  edges are not compared because the run stored a link, and 2 because
  the runtime fails to read a label. The write of `askToRetire` of
  `patterns/system/profile-picker/profile-picker.tsx` is equal in both
  orders under the assumption of question 131, and no row of the
  corpus is of the kind of question 138. In that order `map-demo.tsx` stores
  two links that form a cycle, and a read of the cell that holds one
  of them throws in `traverseWithSelector`
  (`runtime/runner/src/traverse.ts`) where `resolveLink` reports the
  cycle; that is a finding against the runtime, reduced to a test that
  is not committed. 53 outputs
  have no stored value; for 7 of them the template has a clause where
  the runtime stores no label, because an action threw or a
  conditional rendered nothing.
  The crate accepts 333 modules and reports 389 errors. It does not
  yet emit `$defs` for a recursive type. The crate's `SPEC-NOTES.md`
  lists the places where it found the documents ambiguous. Its notes through
  272, notes 281 to 302, notes 307 to 320, notes 325 to 341, notes 344
  to 363, notes 367 to 382, notes 387 to 402, notes 406 to 414, and
  notes 419 to 426 are written into the documents.
  Notes 273 to 280, which measure cost, are written into
  [What compiling, running, and storing cost](#what-compiling-running-and-storing-cost)
  below, and notes 303 to 306, 321 to 324, 342 and 343, 364 to 366,
  383 to 386, 403 to 405, 415 to 418, and 427 to 431, the results of
  the value comparison and the later runs of the label comparison and
  the cost measurement, into
  [What the prototype's executor computes](#what-the-prototypes-executor-computes).
  The latest prototype commit read is `7774ba208c`. From commit
  `3e518147df` on the crate also emits value code and an executor runs
  a plan with it. At `3e518147df`, in the fixtures 122 of 122 compared
  values equal those of today's runtime, and in the corpus 4,472 of
  4,537, over the 186 modules the executor runs. At `96f3b83a73`, with
  the rulings on what the executor needed implemented, the figures are
  152 of 152 in the fixtures and 4,485 of 4,539 in the corpus, over 187
  modules. At `59055fd0c5`, with the rulings on the collections a cone lists
  and on who places a stream implemented, they are 280 of 280 in the fixtures
  and 4,642 of 4,735 in the corpus, over 194 modules. At `77993077e4`, with
  a record that a handler writes into a list stored as a document of its
  own and with the rulings on a plain value in place, a derived collection
  passed on, a write below the root of an empty state cell, a first value,
  the callee's default, and `[SELF]` implemented, they are 489 of 490 in the
  fixtures and 4,641 to 4,650 of 4,735 in the corpus, over 194 modules. The
  range is one module that draws from `Math.random`. At `e63b3d305c`,
  with the rulings on a key that left its collection, on which
  evaluation fails the check of a stream, on a stream a function body
  returns, on what a `*` of a result path stands for, on the key of a
  `flatMap` member, and on the record of a key implemented, with
  `Math.random` seeded in both runs, and with a pattern instantiated
  and a handler bound in a function body, they are 673 of 674 in the
  fixtures and, over 196 modules of the corpus, 4,680 of 4,769 against
  the saved values of today's runtime and 5,324 of 5,410 against a
  fresh seeded run of it. That commit does not have the rulings on the
  top-level property a failed check keeps, on the prefix match at a
  `flatMap` result, on a collection as one nested child, on a write
  that re-keys a plain value, on a body's copy of one, on a handle by
  position, or on `asInstance()`. At `e4f2fb3431`, with those rulings
  and the rulings on a `push` below an empty argument path, on the
  place of `[SELF]` in a binding record, and on the type marker
  `KeyedBy<T, "field">` implemented, they are 727 of 728 in the
  fixtures and, over 196 modules of the corpus, 5,335 of 5,410 against
  a fresh seeded run of today's runtime. At `a462df710a`, with the
  rulings that no record lists where a stream is stored and no
  position is checked, on a spread child, on a state path of plain
  type, and on what a re-key moves implemented, they are 752 of 753
  in the fixtures and, over the same 196 modules, 5,414 of 5,498
  against a fresh seeded run, which sends 11 more events. That commit
  forms a key with no field name and resolves it through a schema,
  by a ruling that is withdrawn. It does not have the rulings that
  followed: that a key names its declared fields and is resolved
  with no schema, and that `KeyedBy` can name several fields. Nor
  does it have the rulings after those: that the key is declared on
  the array, with the array type `ArrayByKey`, in the place of
  `KeyedBy` on the element type, and that the element part of such a
  key holds the names of the fields and one salted hash of their
  values. At `7774ba208c`, with the rulings that a key names its
  declared fields, that it is resolved with no schema, and that the
  declaration can name several fields implemented, they are 767 of
  768 in the fixtures and, over the same 196 modules, 5,414 of 5,498
  against a fresh seeded run, every figure of the corpus as at
  `a462df710a`. That commit has the marker `KeyedBy` on the element
  type and the plain form of the key: a string with separators and
  an escaping of the prototype's own, which holds each field name
  with the value of the field, with no salt and no hash. It does not
  have the rulings that followed: `ArrayByKey` on the array, the
  salted hash, a key that is a fabric value with no separators of
  the design's own, the schema traversed at a link as the place a
  reader learns the key fields from, and a reference by key to an
  element of a plain array generated from scratch. No
  compared row of the
  corpus evaluates the label of an
  index: the 54 index slots of the corpus plans are read by outputs
  below the elements of a collection and by handlers with no
  compared write edge. Two fixtures of the prototype test the label of
  the index and the row of question 138.
- **Specification change:** draft pull request #91 in `commonfabric/specs`
  (branch `claude/compiled-pattern-label-templates`) carries the label
  semantics as prose, pseudocode, and Lean statements. It includes the
  pattern closure, as prose, and it follows
  `plan-and-label-templates.md` for the rules that document gained in the
  second round of passes; [Known limits](#known-limits-of-what-exists)
  lists what it still lacks. That repository is private; cite it from this
  one by section and chapter file only, as
  [`../development/cfc-spec-correspondence.md`](../development/cfc-spec-correspondence.md)
  requires.
- **Merged branches:** `claude/pattern-language-subset-spec`,
  `claude/pattern-language-plan-labels-spec`, and
  `claude/pattern-language-builtin-inventory` are fully merged into the branch
  above and carry nothing else. New work does not go on them.

## What compiling, running, and storing cost

The prototype measured what the path of today costs and derived what
the plans say of the compiled path, at prototype commit `4ca9fe56cb`
(its notes 273 to 280). The figures do not show that the compiled path
is faster at run time: no time of the compiled path is measured. The
executor of
[What the prototype's executor computes](#what-the-prototypes-executor-computes)
computes values and was not timed. The prototype's later commits, to
`a462df710a`, measure no cost, and the figures of this section are not
computed again for them. At commit `7774ba208c` every command of the
measurement was run once more over the corpus, on a machine that was
not idle; those figures are under
[The comparison of labels and the cost measurement at commit `7774ba208c`](#the-comparison-of-labels-and-the-cost-measurement-at-commit-7774ba208c)
and replace none of this section. The one other later figure that
bears on storage is the count of documents the executor stores, under
[Documents](#documents).

### What is measured and what is derived

At that commit the crate emits a plan and no value code. Three kinds of
figure follow, and each table says which a row is.

- **Measured on both sides:** the time to compile.
- **Measured for the path of today alone:** the time, the transactions,
  and the scheduler's runs of a scenario, and what the scenario leaves
  stored.
- **Derived for the compiled path:** counts that
  `execution-and-storage.md` fixes for a plan, computed from the plan's
  records. A derived count is not a time and not a measurement.

Compile time is over the 270 modules with a full plan. The run and the
storage are over the 213 of them that the corpus comparison runs. The
scenario of a module is the generated one of the comparison: every
top-level input has a value, every array has two elements, and one
event is sent to each handler whose stream the result holds. The
machine is an Apple M3 Max with 16 cores and 128 GB, with Deno 2.9.8
and rustc 1.93.0 under Cargo's release profile. Nothing else ran during
a measurement, and no measurement was repeated on another day. Times
are wall time in milliseconds.

### Compile time

Both pipelines were given the same program for a module: the module and
the modules it imports by path, 1,004 files for the 270 modules, with a
median of one file and 5.9 KB of source per module. Today's side is
`PatternManager.compilePattern` in
`runtime/runner/src/pattern-manager.ts`, three times in a runtime and a
store of its own each, and once more in the same runtime, which reads
the compile cache. The crate's side is its analysis and the JSON text
of the plans, 20 times in one process, from source text in memory.

| In one process, 270 modules | total | median | p10 | p90 | least | most |
| --- | --- | --- | --- | --- | --- | --- |
| crate, median of 20 | 5,104 | 0.626 | 0.0822 | 15 | 0.0387 | 1,189 |
| today, first compile of the module | 91,115 | 151 | 96.5 | 666 | 84.9 | 5,207 |
| today, median of the two later compiles | 87,419 | 146 | 96.3 | 657 | 82.7 | 4,892 |
| today, again in the same runtime, from the cache | 7,644 | 18.6 | 15 | 43.1 | 13.2 | 389 |
| today, last compile: building the program | 7,794 | 28.6 | 25.1 | 32 | 20.3 | 49.5 |
| today, last compile: type check | 24,933 | 47.9 | 24.7 | 187 | 13.5 | 1,142 |
| today, last compile: transformers and emit | 33,988 | 28.4 | 7.84 | 241 | 3.94 | 2,449 |
| today, last compile: evaluating the modules | 2,130 | 2.05 | 0.827 | 10.2 | 0.513 | 355 |
| today, last compile: compile cache | 5,996 | 11.8 | 9.26 | 38.8 | 8.08 | 285 |
| today, last compile: the rest | 11,426 | 27.5 | 23.5 | 64.8 | 21.6 | 552 |

Per module, today's later compiles take 240 times the crate's time at
the median (p10 41, p90 1,201). The totals differ by 17 times, and by
12 times without today's type check and evaluation. The two figures
are far apart because three programs are most of the crate's total:
the three that hold FabriChat's room.

| The three programs with FabriChat's room | files | crate | today | ratio |
| --- | --- | --- | --- | --- |
| `patterns/dev/loom-chat-room-fixture/main.tsx` | 18 | 1,154 | 4,892 | 4.24 |
| `patterns/dev/loom-overlay-fixture/main.tsx` | 18 | 1,189 | 4,763 | 4.01 |
| `patterns/system/fabrichat/room-test-fixture.ts` | 15 | 1,102 | 3,715 | 3.37 |

They take 3.4 s of the crate's 5.1 s. At the median the crate takes
0.12 ms per KB of source, and on these three 2.3 ms per KB. A sample of
the process on the third has 70% of its top frames in the allocator
and in `memmove`, below `String::clone` and the functions of the
crate's type evaluator that build the shape of a type. The reading is
that the evaluator builds the shape of a type again at each use and
keeps none. It was read from the sample alone and no fix was tried. So
for the reference pattern the measured gain is 3.4 times, not
hundreds, until that is fixed. Given the 1.5 MB bundled `guest.js` of
`patterns/showcase/iframe-firebreak-commons` as a module, the crate had
not finished one run after 108 s; the file is a data file and is in no
figure here.

With one process per module, timed from its start to its end:

| One process per module, 270 | total | median | p10 | p90 | least | most |
| --- | --- | --- | --- | --- | --- | --- |
| crate, median of 5 | 6,651 | 3.58 | 2.46 | 21.6 | 2.05 | 1,336 |
| today, one run | 381,950 | 1,101 | 960 | 2,014 | 869 | 6,870 |

The ratio per module has the median 310 (p10 83, p90 515). About half
of today's 1,101 ms is the compile and the rest is starting Deno and
loading the runtime's modules.

The comparison is not even, in both directions:

- **The crate emits no value code and no source map.** Today's emit
  produces the JavaScript that runs. An emitter of value code adds time
  that is not in the crate's figure.
- **The crate forms no content hash.** A plan names its schemas, bodies
  and patterns by placeholders. Today's figure includes the content
  identity of every module.
- **The crate checks less than TypeScript.** Its type checker does not
  check a generic function per instantiation, applies assignability at
  four kinds of site, and reads no declaration file. Today's check is
  the full semantic check of every file against the declarations of
  `commonfabric` and the standard library.
- **Today's evaluation of the modules has no counterpart** in the
  crate. It is 2% of today's total.
- **Today's figure includes storing** the source and the compiled
  modules in the space (7%). The crate writes nothing, and its
  in-process figure leaves out reading the files.
- **Today's pipeline has a cache and the crate has none.** Against a
  second compile in the same runtime the medians differ by 30 times,
  and the crate is slower than that cache on the three large programs.

### Run counts

Today's side is measured: the scenario run with the runtime's own
timing spans counted, all 213 modules in one process one after the
other. "To settle" is from the compiled pattern to the point where the
instance was started, the result and every kept output were read, the
scheduler was idle, and the store had confirmed.

The compiled side is derived from the plan:

- **Transactions to settle: 2,** whatever the plan. This is a reading
  of `execution-and-storage.md` and not a number it states as a count
  for every case: §1.1 and §1.5 give one derivation transaction that
  evaluates every demanded cone instance, those of the children in the
  same space included, and §1.4 gives the creating transaction for an
  instance a handler creates. For an instance created outside a
  handler, as the scenario's is, one creating transaction is an
  assumption (question 140).
- **Cone instances:** one per cone and combination of element keys of
  the collections around it (§2.1 and §2.5 there). For a collection
  over a computed array, a state cell, or the result of an operation,
  the plan gives no size, so one row takes those as empty and one as
  two elements. 54 of the 213 modules have such a collection.
- **Per event: 1 or 2 transactions** (§1.1 there): the event's, and
  one derivation transaction behind the batch where a demanded cone
  instance became stale.

| To settle, 213 modules | total | median | p10 | p90 | least | most |
| --- | --- | --- | --- | --- | --- | --- |
| today, measured: milliseconds | 21,566 | 37.8 | 9.96 | 238 | 4.73 | 2,058 |
| today, measured: transactions committed | 1,461 | 2 | 1 | 19.8 | 1 | 76 |
| today, measured: runs of a scheduler action | 4,343 | 11 | 4 | 44.8 | 2 | 187 |
| today, measured: calls of an authored body | 844 | 1 | 0 | 13 | 0 | 53 |
| today, measured: CFC preparations | 2,822 | 8 | 0 | 35 | 0 | 134 |
| today, measured: reads journaled | 674,328 | 819 | 160 | 7,057 | 58 | 107,490 |
| compiled, derived: transactions | 426 | 2 | 2 | 2 | 2 | 2 |
| compiled, derived: cones | 1,845 | 5 | 2 | 14.8 | 0 | 150 |
| compiled, derived: cone instances, other collections empty | 1,708 | 4 | 2 | 15 | 0 | 147 |
| compiled, derived: cone instances, other collections of 2 | 2,406 | 5 | 2 | 23 | 0 | 153 |
| compiled, derived: sandboxed bodies in the plan | 724 | 1 | 0 | 9 | 0 | 37 |

The median number of transactions to settle is 2 on both sides. The
ratio of today's transactions to the derived is 1 at the median module
(p10 0.5, p90 9.9) and 3.4 over the totals. 84 modules commit one
transaction today, where the derived count is two, and 92 commit more
than two; the most is 76. The ratio of today's runs of a scheduler
action to the derived cone instances is 2.3 at the median (p10 1.4,
p90 3.7) and 1.8 over the totals.

| Per committed event, 344 events of 104 modules | total | median | p10 | p90 | least | most |
| --- | --- | --- | --- | --- | --- | --- |
| today, measured: milliseconds | 18,219 | 26 | 8.22 | 123 | 2.87 | 420 |
| today, measured: transactions committed | 1,175 | 2 | 1 | 8 | 1 | 38 |
| today, measured: runs of a scheduler action | 1,605 | 3 | 1 | 12 | 1 | 48 |
| today, measured: reads journaled | 701,101 | 979 | 199 | 4,712 | 63 | 14,451 |

Derived per event: 1 to 2 transactions, and a bound on cone
evaluations that is 2.7 at the median module and 4.7 at the mean over
the modules. Today's mean per committed event is 3.4 transactions and
4.7 runs of a scheduler action. 15 further events were refused by the
runtime and are in no row.

These ratios of counts are all that can be said about run time. A
transaction of the design is not a transaction of today: it prepares
CFC once over everything a cause staged, where each of today's 2,822
preparations to settle is one node's. A cone evaluation is not a run
of a scheduler action: it is one call of emitted code with no
scheduler step, no transaction, and no journal of its own. Neither
difference has a measured cost.

### Storage

Today's side is measured: what the replica of the scenario's space
holds after the run. The documents of the instance are its result,
argument, internal, and computed documents, which the design replaces.
Bytes are of the JSON of a document's value, of its meta fields, and
of its `cfc` envelope.

The compiled side is derived from the plan by
`execution-and-storage.md` §4.1: one result and one argument document;
one operation state document per durable operation and combination of
element keys; none to one document per state cell, per child record
(two for a child), and per row of a kept collection as a part (§4.5,
§4.6, §4.10 there). The nodes of a rendered tree are split points too
and are not counted, so the "most" row lacks the parts of a rendered
tree above 1,024 bytes, and it counts state cells that are never
assigned and children the scenario does not instantiate. The bound is
loose in both directions. Label entries, by §4.3 there: one for the
pattern's atom, then a `value` and a `shape` entry per kept output
whose template is not a constant, and an `enumerate` entry per kept
collection. Whether a template instantiates to an empty label depends
on the inputs, which the derivation does not evaluate, so the table
has the count where every label is empty and where none is. No bytes
of values are derived. One row is an estimate from today's run and not
a derivation: the bytes of the result with every link to a document of
the instance replaced by what it names.

| After settle, 213 modules | total | median | p10 | p90 | least | most |
| --- | --- | --- | --- | --- | --- | --- |
| today, measured: documents of the instance | 5,882 | 9 | 2 | 50 | 2 | 938 |
| today, measured: bytes of their values | 7,990,374 | 5,900 | 1,286 | 31,799 | 283 | 1,705,696 |
| today, measured: bytes of their meta fields | 2,996,753 | 4,463 | 997 | 28,152 | 924 | 478,329 |
| today, measured: label entries | 9,735 | 3 | 0 | 130 | 0 | 825 |
| today, measured: envelope bytes, labels by reference | 1,505,693 | 578 | 0 | 19,710 | 0 | 163,929 |
| estimate from today's run: bytes of the result, inlined | 6,112,595 | 3,205 | 786 | 13,327 | 15 | 1,705,985 |
| compiled, derived: documents, least | 466 | 2 | 2 | 2 | 2 | 16 |
| compiled, derived: documents, most | 1,834 | 3 | 2 | 8 | 2 | 335 |
| compiled, derived: rows of the stream index | 734 | 1 | 0 | 8.8 | 0 | 122 |
| compiled, derived: label entries, every label empty | 213 | 1 | 1 | 1 | 1 | 1 |
| compiled, derived: label entries, none empty, rows share a label | 3,512 | 11 | 1 | 35.6 | 1 | 143 |
| compiled, derived: label entries, none empty, rows differ | 3,850 | 11 | 1 | 40 | 1 | 143 |

- **Documents.** Today's documents of the instance are 2.75 times the
  most derived at the median module (p10 1, p90 8.9), 3.2 times over
  the totals, and 12.6 times the least derived.
- **Bytes.** Today's values and meta fields together are 3.3 times the
  estimate at the median (p10 1.6, p90 8.8) and 1.8 times over the
  totals. Two modules each hold the bundle of an iframe guest, above
  1.5 MB, in one value, which both layouts store once; without them
  the totals differ by 2.7 times.
- **Label entries.** Today stores 9,735, and the derived count is
  between 213 and 3,850. Over the totals that is 2.5 times fewer
  against the most derived. It is not fewer per module: 145 of the 213
  modules store fewer entries today than the most derived, and 68
  store none today, where the design stores the one entry of the
  pattern's atom. The difference is in the modules with many entries:
  the p90 is 130 today and 40 derived.

After the events of the 108 modules that have one, today's documents
of the instance grew by 543 and its label entries by 2,676. The design
adds one stream document for each stream that received an event, 359
over these modules. Both add the same other documents: a receipt per
handling and a document per record a handler writes into an array.

Per element of a `map`: 34 of the modules have a `map` over an array of
the argument. Each was run to settle at two lengths of every such
array, 2 and 10, and a figure is the difference divided by 8.

| Per element, 34 modules | median | p10 | p90 | least | most |
| --- | --- | --- | --- | --- | --- |
| today, measured: documents of the instance | 5.5 | 0 | 19.8 | 0 | 80 |
| today, measured: bytes of values | 2,290 | 16.8 | 8,739 | 0 | 18,328 |
| today, measured: bytes of meta fields | 3,101 | 0 | 10,093 | 0 | 44,208 |
| today, measured: label entries | 15 | 2.1 | 225 | 0 | 292 |
| today, measured: milliseconds to settle | 18.8 | -1.83 | 86.9 | -9.83 | 194 |
| today, measured: transactions | 0.5 | 0 | 13.9 | 0 | 38 |
| estimate from today's run: bytes of the result, inlined | 974 | 0 | 3,810 | 0 | 5,024 |
| compiled, derived: documents, most (a part per row) | 1 | 0 | 1 | 0 | 2 |
| compiled, derived: label entries, rows share a label | 0 | 0 | 0 | 0 | 0 |
| compiled, derived: label entries, rows differ | 2 | 0 | 4 | 0 | 8 |
| compiled, derived: cone instances | 2.5 | 0 | 7.7 | 0 | 31 |

A negative time is the noise of two runs. The p10 of 0 is five
modules whose longer arrays add no document of the instance, three of
them because the `map` is over an array below the top level of the
argument, which the two runs do not lengthen.

### What the figures support

- **Compile time** is lower by two orders of magnitude at the median
  module, and by 3.4 times on the reference pattern. The second figure
  comes from the prototype's type evaluator and not from the design.
  The crate does not emit code or hash, so its figure will grow.
- **Run time is not measured.** The counts that stand in for it are
  lower for the modules that are large today and not for the median
  module: the median module settles in 2 transactions today and in 2
  by the design, and 84 of 213 modules settle in one transaction
  today. The tenth of the modules with the most commit 20 or more
  today, against a derived 2. Per event it is 3.4 transactions at
  the mean against 1 to 2.
- **Storage** is lower in documents and in the modules with a `map`,
  and not in label entries for a small module, which stores no entry
  today and one in the design. The bytes of values are lower by an
  estimated 1.8 times over the corpus.
- **The scenario is small.** Every array has two elements. The costs
  that grow with the data are per element, where the measured side is
  5.5 documents and 15 label entries against a derived 1 at most and 0
  to 2. The corpus totals above do not show what data of realistic
  size would cost.

### Not measured

- **Any time of the compiled path.** The emitter and the executor of
  the next section exist to compare values. The executor keeps its
  documents in memory, forms no label and no transaction, and runs a
  body with no sandbox, so a time of it would not be a time of the
  design. A number needs an executor that evaluates the cones of a
  derivation transaction against the store of today and writes the
  kept outputs to one result document.
- **Bytes of the compiled layout.** The inlined result is an estimate.
- **Label entries of the compiled layout between the two bounds.**
  Counting the compared outputs whose evaluated template is not empty
  would give the count for the scenario. It was not done.
- **The history.** The store keeps every revision of a document, and a
  document of today's layout is rewritten by each run that changes it.
  The bytes above are of the latest values.
- **A cold compile on the server and in the browser.** Both figures
  are of Deno on one machine.
- **The 47 modules that need `wish` or an effect,** and the 10 whose
  run fails.

## What the prototype's executor computes

At prototype commit `3e518147df` the crate emits value code beside a
plan (`src/emit.rs`, its `emit` command), and an executor written in
TypeScript (`exec/executor.ts`) runs the two. A comparison
(`compare/values.ts`) runs the scenario of a module on today's runtime
and on the executor and compares the values. These are the prototype's
notes 281 to 306. At commit `96f3b83a73` the emitter and the executor
implement five of the rulings that followed: the place of a slot of
`Body.reads`, a path that a call leaves out, the first value of a state
cell, a moved element with the keys of a derived collection, and the
two kinds of cone with side-writes. Those are notes 307 to 320, which
are written into the documents, and notes 321 to 324, which run the
comparison again. At commit `59055fd0c5` the crate and the executor
implement the rulings on the collections a cone's record lists and on
who places a stream, and the executor has a `reduce` in the reactive
tier, the record of a key of a list, and a cell made with `new`. Those
are notes 325 to 341, which are written into the documents, and notes
342 and 343, which run the comparison again. At commit `77993077e4` the
executor stores a record that a handler writes into a list as a
document of its own, as today's runtime does, and the crate and the
executor implement the rulings on the identity of a plain value in
place, on an output that passes a derived collection on, on a write
below the root of an empty state cell, on a first value stored as a
value, on where the callee's default is held, and on the name bound to
`[SELF]`. Those are notes 344 to 363, which are written into the
documents, and notes 364 to 366, which run the comparison again. At
commit `e63b3d305c` the crate and the executor implement the rulings on
what a key that left its collection keeps, on which evaluation fails
the check of a stream's position, on a stream that a function body
returns, on what a `*` of a result path stands for, on the key of an
element that a `flatMap` contributes, and on the record of a key of a
list. The comparison seeds `Math.random` in both runs, and the
executor instantiates a pattern and binds a handler in a function
body. Those are notes 367 to 382, which are written into the
documents, and notes 383 to 386, which run the comparison again. At
commit `e4f2fb3431` the crate and the executor implement the rulings
on a collection among the children of a view node, on the prefix
match of kind `element` at the result of a `flatMap`, on the
top-level property that keeps its value where the check of a stream
fails, on a function body's copy of a plain value, on a handle by
position and its comparison with a reference by key, on a write that
re-keys a plain value, on a `push` below an empty argument path, on
the place of `[SELF]` in a binding record, on the modifier
`asInstance()`, and on the type marker `KeyedBy<T, "field">`. Those
are notes 387 to 402, which are written into the documents, and
notes 403 to 405, which run the comparison again. At commit
`a462df710a` the crate records no result path of a binding and the
executor checks no position of a stream, and the two implement the
rulings on a spread child, on a state path of plain type and a member
handle read through a handle of handles, and on what a re-key moves.
The executor forms a key with no field name and resolves it through
the schema that the array is stored under, by a ruling that is
withdrawn since ([Decided](#decided)). Those are notes 406 to 414,
which are written into the documents, and notes 415 to 418, which
explain a difference between the two forms of the comparison and run
it again. At commit `7774ba208c` the crate and the executor implement
the rulings that a key names its declared key fields and is resolved
from the key alone, and that the declaration can name several fields;
the crate reports the two diagnostics of the declaration; a re-key
removes the instance that a moved instance of a function body
replaces; and a fixture compares a stream after a spread with today's
runtime. The prototype at that commit has the marker `KeyedBy` on the
element type and the plain form of the key, which the rulings since
replace. Those are notes 419 to 426, which are written into the
documents, and notes 427 to 431, which run the comparison of labels
and the cost measurement over the corpus and the comparison of values
again. Each
part below gives the figures of each commit, the earliest first.

Notes 281 to 302 say what the executor needed that the
documents did not give, and are written into the documents. Of the
questions they raised, the place of a slot of `Body.reads`, a path that
a call leaves out, the first value of a state cell, a moved element,
a cone with side-writes, the collections a cone's record lists, and
who places a stream in a computed value are ruled, and so is which
default is read along a chain of places ([Decided](#decided)).
Questions 152 to 157 are what notes 307 to 320 found the rulings to
leave undetermined. Of them 152 to 156 are ruled, and so is question
145: the identity of a plain value in place, where the callee's
default is held, a write below the root of an empty state cell, a
first value stored as a value, and the keys of a derived collection
passed on unchanged. Questions 141, 144, 146, 147, 149 to 151, and 157 to 166
below, and questions 81 to 84 of `execution-and-storage.md`, are open; 158 to
163 are what those rulings leave undetermined, and 164 to 166 are what notes
325 to 341 found the rulings on questions 141 and 144, and the pieces added to
the executor, to leave undetermined. Of
question 141 the member is ruled, and what it holds beside the collections is open. Of
question 144 the placing and the check are ruled, and what the check
covers outside the result is open. Questions 164 and 165 are ruled:
which evaluation fails the check of a stream's position, and a stream
that a function body returns. Questions 42, 125, 147, and 166 are ruled
in part: what a key that left its collection keeps, what a `*` of a
result path stands for, the key of an element that a `flatMap`
contributes, and the record of a key of a list. Each entry says what
stays open, and question 167 is what the ruling on 166 leaves
undetermined in the reactive tier. Questions 168 to 173 are what notes
344 to 363 found undetermined, and questions 149, 160, 161, and 163 are
restated with what the prototype observed under their assumptions.
Questions 160, 163, 164, 170, and 173 are ruled since, and so is what
notes 368, 369, 374, and 375 asked: an event for the stream of a key
that left its collection, what keeps its value where the check of a
stream fails, the kind of a `*` at a `flatMap` result, and a
collection among the children of a view node. Questions 174 to 183 are
what those rulings, the ruling on `asInstance()`, and notes 367 to 382
leave undetermined. Question 175 is ruled since, by the type marker
`KeyedBy<T, "field">`, and question 178 in two of the three cases of
a re-key. Questions 184 to 186 are what that ruling leaves
undetermined. Questions 187 to 191 are what notes 387 to 402 found
undetermined, and questions 160, 163, 164, 170, 173, and 178 are
restated with what the prototype does at commit `e4f2fb3431`.
Questions 187 and 189 to 191 are ruled since. A further ruling drops
the listed result paths of a binding and the check of a stream's
position ([Decided](#decided)). It settles question 188 and the
first part of question 144, makes questions 125, 130, 164, and 182
not applicable, and leaves questions 192 and 193. The prototype at
commit `e4f2fb3431` has the list and the check. At commit
`a462df710a` it has neither: its crate records no stream position,
its executor replaces a marker by the link wherever it stores a
value, and the comparison's harness finds a stream at the position at
which an executor that runs beside today's run recorded storing the
link. The parts below that
count listed paths, kinds of a `*`, and failed checks describe the
prototype at the commit they name, and not the design. The ruling on
question 191 is withdrawn and replaced: a key names its declared
fields and is resolved with no schema, and `KeyedBy` can name several
fields, as a union of their names. That answers what note 411 asked,
and questions 194 to 198 are what it leaves undetermined. Three
rulings after it settle questions 194 and 197, and put the
declaration on the array: the array type `ArrayByKey<T, "field">`
replaces `KeyedBy` on the element type ([Decided](#decided)).
Questions 199 to 201 are what those leave undetermined. Four later
rulings settle questions 199 and 200: no key, identifier or stored
string is built with separators of the design's own, a reader whose
type declares no key learns the key fields from the schema traversed
while the link to the array is resolved, an `asInstance()` instance
that a re-key replaces stays in the store, and an element of a plain
array generated from scratch has a reference by key. Questions 202 to
205 are what those rulings and notes 419 to 426 leave undetermined,
and entry 206 records the last of the four rulings with the owner's
reservation. The parts
below that name `KeyedBy`, a key field declared in the element type,
a key that holds the value of its field, or a key written as a string
with separators describe the prototype at
the commit they name, and not the design.
Notes 303 to 306, 321 to 323, 342, 364 and 365, 383 and 384, 403
and 404, 416 and 417, and 429 and 430 are the results here.
The executor was not timed. Note 428 times today's runtime and the
crate's compile again, on a machine that was not idle.

Note 324 says what the later round did not keep to and did not verify.
The tests of the five rulings were written before the code. Two fixes
of the executor were made from a difference in the corpus, and not
from a test written first. One is the copy of a container read under a
schema, which had no address, so that `equals` and `remove` did not
find a member a handler had read through a typed handle; a test of the
store was written after the fix. The other hands on the keys of a
derived collection that a cone returns unchanged (question 156, since
ruled), and
has no test. The counts of bodies, state
cells, and constants that notes 308 to 310 give are over all 382
corpus patterns, the ones with an unsupported construct included. The
rows of the tables below that say "not verified" are a reading of the
source and of the two values.

Note 343 says the same of the round of commit `59055fd0c5`. The tests of
the two rulings, of the paths the crate lists, of the record of a key,
and of `reduce` were written before the code. The three tests of where a
marker of an element body is stored passed before the change, since the
executor stored such a stream already. The fixture of the keys of a
`flatMap` result describes what the executor did and changed no code.
The classes of the 12 listed paths that hold no stream rest on a reading
of the source for 7 of them and of one branch for the other 5. The
difference of `apps/person-workbench/main.tsx` and the differences of
`product/primitives/demo/atoms-demo.tsx` are not examined. No fresh run
of today's runtime over the corpus was made: the executor was run again
against the values of the earlier run, and the change to the
comparison's harness, which resolves a result path with no `*` first, is
exercised by the fixtures alone.

Note 366 says the same of the round of commit `77993077e4`. The fixture
of a record written into a list was red before the change, and its unit
tests were written with the change. The tests of the reference by key
were written after the store and before the executor was complete, and
they found a defect: a state path that a handler declares with a data
type was handed a handle. The unit tests of the keys of a derived
collection passed on were written with the change, and the test that
removes the mark shows what the mark decides. The tests of a write
below the root of an empty state cell and of `[SELF]` describe what the
executor did and changed no code. The test of the emitter's `equals`
was written after the code. The counts of evaluations over the corpus
differ by a few from those of the run of commit `59055fd0c5` before any
change of this round, which was not examined. No fresh run of today's
runtime over the corpus was made.

Note 386 says the same of the round of commit `e63b3d305c`. The tests
of the rulings on a key that left its collection and on the record of
a key describe what the executor did and changed no code. The tests of
the rulings on which evaluation fails, on a stream a body returns, on
the kinds of a `*`, and on the key of a `flatMap` member, of the seed,
and of the executor's part of instantiating and binding in a function
body were written and seen to fail before the code. The test of the
emitter's pattern identity was written in the same step as the code.
The fresh run of today's runtime was made once, with the crate and the
executor as they were before the instances of a function body, and the
current ones are compared with it. That today's values are the same in
a second fresh run is shown for the 14 modules of `showcase/` alone.
The differences of `apps/base/person.tsx` and
`apps/base/family-member.tsx` are not examined. The classes of note
374 rest on a reading of the crate and have no fixture. The
comparison's scripts are run without the type check, which
`values-corpus.ts` does not pass.

Note 405 says the same of the round of commit `e4f2fb3431`. The tests
of the ruling on the children of a view node, in the crate and in the
executor, were the existing tests of the flat layout, which failed
after the change and were then rewritten. The test of the emitter's
two factories for a view node and the test of the checker for
`KeyedBy` were written after the code. The executor's tests of the
rulings on a `push` below an empty argument path and on the place of
`[SELF]` were written before the code and seen to fail by putting the
committed executor back. Every other test of the round was written
and seen to fail first. The comparison of labels was not run over the
corpus with the new paths of the children; its tests on the fixtures
pass. The cost model was not changed. The nested layout of the
children is compared with today's runtime through the paths that the
events take alone, since the comparison of values flattens the
children. The limits that notes 389, 393, 394, 396, 397, and 399 name
rest on a reading of the code where they name no test. The run of
commit `e63b3d305c` that the corpus figures are set against was made
again for this round in a separate worktree.

Note 418 says the same of the round of commit `a462df710a`. The tests
of the store's record of the stream links were written after the
code, and the tests of the positions at which a reader finds a link
before it. The tests of the rulings on a state path of plain type and
on a spread child, three of the tests of the ruling on what a re-key
moves, and the test of a key that a read of a whole array forms
passed when they were written: they describe what the executor did
and were not seen to fail. The existing tests that named a listed
path or a failed check were rewritten or removed after the code
changed. Every other test of the round was written and seen to fail
first. The comparison of labels was run on one module with the
executor beside it and not over the corpus, and the cost measurement
was not run; both read the crate's `emit` output at this commit, and
their tests on the fixtures pass. A stream at a member written after
a spread, and a JSX spread child, are in no fixture that is compared
with today's runtime. The replacement of a marker at a place other
than the result is tested through the store's record and not for
each place. The limits that notes 411 and 413 name rest on a reading
of the code where they name no test.

Note 431 says the same of the round of commit `7774ba208c`. Five of
the six tests of the store for a key that names its fields were
written and seen to fail first; the sixth, that a position that holds
a link is keyed by its cell with or without a declared field, passed
when it was written. The three tests of that ruling on the fixture
were written after the store had changed and were then run on the
store and the executor of commit `a462df710a`: two failed, and the
third, that a handler over a plain array generated from scratch
stores the value, passed, so it describes what the executor did. The
test of the plan for several key fields failed first. The two tests
of the diagnostic of a wrong declaration were written before the code
and were not seen to fail. The executor's tests of several key fields
failed first by not passing the type check, with no assertion
reached. The tests of the diagnostic of a mismatch and of the removal
of a replaced instance failed first. The test of a stream after a
spread failed for the missing fixture and passed once the fixture
existed, with no change to the code. The two diagnostics are tested
on snippets alone, since no pattern of the corpus uses the marker.
Nothing of a declared key is compared with today's runtime, which has
none. The members of a segment of a `flatMap` are keyed with no
declared field. A reference by key to an element of a plain array
generated from scratch is not tested, because the executor makes
none. The comparison of labels was not compared module by module with
an earlier run. The limits that notes 424 and 426 name rest on a
reading of the code where they name no test. The coordinator of this
work ran the prototype's tests and fixtures at that commit and not
the corpus, the comparison of labels, or the cost measurement: 468
tests of the crate and 81 tests under Deno passed, and the fixtures
gave 48 of 48 runs and 767 of 768 values.

### What is compared, and what is not

A compared value is one member of the result, or one state cell of the
pattern's body, after the instance settled and after each event. The
scenario of a module is the generated one of the label comparison. A
fixture uses the scenario its label test writes, where it writes one.

- **Three things are made equal before the comparison.** The children
  of a view node are compared as one flat list. A child that is the
  result of a pattern is compared as its tree, because the compiled
  path holds the callee's tree in place at a child position
  (`plan-and-label-templates.md` §1.1, question 107 here) where today's
  run holds the result with the tree under `$UI`. A time read from the
  clock is compared as one token. At commit `e4f2fb3431` the executor
  stores a collection among the children of a view node as one nested
  child, and the comparison still flattens the children on both
  sides. So the nested layout itself is compared with today's by the
  events alone: an event reaches its stream through the path. One
  layout of today differs from the nested one: a `map` over an array
  written in place runs when the pattern is built, and today's run
  holds its elements as children of their own from the position of
  the expression on. The case is a collection over plain values in
  place; a `map` over a cell is stored nested today.
- **Today's side can be a saved run.** A run saves what today's runtime
  computed, and the executor can be run alone again on the crate's
  current output against the saved values (`compare/values-corpus.ts`,
  the command `again`). For the figures of commit `3e518147df` the
  notes do not say which come from such a rerun. The corpus figures of
  commit `96f3b83a73` over the 270 modules are such a rerun: the
  executor alone, against the values that today's runtime computed in
  the run of the earlier commit. Today's runtime was run again for the
  two modules that the later commit adds, and for no other.
- **The executor is not the design's runtime.** It instantiates no
  label, checks no constraint, has no transaction log, and persists
  nothing. It runs no effect: the result of an operation reads as
  pending, and a module with an operation of kind `effect` or `wish` is
  not run. It hands a body the whole value at a `value`, `shape` or
  `enumeration` slot and narrows none to its class. It runs a body as
  plain JavaScript with no sandbox and no budget, and rolls a handler
  that throws back by restoring its documents. It makes no part
  document and no stream document, and has one scope instance. It does
  not instantiate a pattern or bind a handler in a function body, does
  not evaluate a `reduce`, and has no `elementById`, `linksOf`, or
  debug-string built-in. At commit `59055fd0c5` it evaluates a `reduce`
  in the reactive tier, as one unit that is evaluated again as a whole,
  has the record of a key of a list (`elementById`, with `addUnique`
  and `removeByValue`), and constructs a cell with `new` in a function
  body as with `of`. It still instantiates no pattern and binds no
  handler in a function body: the artifact names a compiled pattern by
  hash and holds no plan of a pattern from another module, and the
  executor has one instance over one store. At commit `77993077e4` it
  stores a record that `set`, `push` or `addUnique` writes into an
  array as a document of its own, with a link in the array, as today's
  runtime does. It names that document by a counter, keeps in place a
  record that is set at one position of an array and the records of an
  array that a body creates a cell with, and writes no default of the
  argument into the argument document, where today's runtime writes
  one. At commit `e63b3d305c` it instantiates a pattern in a function
  body, as an instance of the callee's plan with documents of its own
  in the same store, and binds a handler there, as a stream that an
  event runs the handler for with the state the body bound. It finds
  the callee by the identity that the factory value carries, among the
  artifacts of the program it is given, and the crate's `Child` has no
  `callee` (question 183). It names such an instance and such a stream
  by the run that made it and an ordinal among all that the run made,
  names a run of a handler by a count of the events handled, never
  tears an instance down, and writes the argument of an instance that
  a run names again whole; the documents name them by the site and by
  the receipt. At commit `e4f2fb3431` it makes an instance of its own
  for a pattern called through `asInstance()` in the reactive tier,
  which stays when its key leaves, and finds it by a table from the
  child and the element keys. It forms the key of a plain value from
  a field that the element type declares with `KeyedBy`. Today's
  runtime has neither, so the executor's tests of the two are
  compared with nothing. It reads `spaceOf` as the
  space it is given and has no acting principal. It does not use
  `Cone.writes`,
  `ConeResult.selections`, or `ConeResult.picks`: a body's side-write
  goes through the handle the body holds. At commit `96f3b83a73` it
  reads the write edges of a cone for one thing, to find the cone that
  a read of a written place demands.
- **The executor has no reader.** It evaluates every kept output and
  then the result, where the design evaluates what is demanded. At
  commit `96f3b83a73` it evaluates a cone with a small, fixed set of
  write targets only where an evaluation reads or passes on a place
  that one of its write edges names, and it evaluates each materializer
  whose input changed after the kept outputs and the result of a wave,
  where a write starts a further wave. The ruling has a materializer
  run after the rest of the wave "often", and the documents promote one
  ahead of a reader inside its envelope
  (`scheduler-and-serving-loop.md` §7.2). The executor runs it after
  the wave always. Three cases the executor leaves out: a handler's
  read of a write target demands nothing; a write edge that names its
  handle by a computed value, or whose target is a created cell or a
  child's argument, has no root and path, and no reader is found for
  it; and a cone of an element body whose reader is outside the body is
  evaluated for every key of the table, in each of the three cases of a
  per-element source, at commit `59055fd0c5` as well. At that commit
  the executor drops the cone instances of a key that left its
  collection, in each of the three cases, and a key that comes back has
  new instances, which are evaluated; it keeps the state cells declared
  under the key, as the ruling on a key that left has it
  ([Decided](#decided)). At commit `e63b3d305c` it refuses an event
  for the stream of a key that is away, as the ruling since has it,
  and it has no state of an operation that is kept per key and no
  child of an element body.
- **`Math.random` is seeded at commit `e63b3d305c`.** The comparison
  installs a `Math.random` before today's runtime freezes the
  intrinsics of the realm, and both runs seed it with the index of
  each event. The sequence starts again for each run of a handler,
  since today's runtime can run the handler of one event more than
  once. Two callers are kept out of the sequence: the jitter of a
  retry's delay (`computeBackoffDelayMs` in
  `runtime/runner/src/scheduler/backpressure.ts`), which draws from
  the realm's own generator; and the timing statistics of the logger
  (`TimingDataStore.record` in `base/logger/src/logger.ts`), which the
  harness empties before each event. A handler that sends to another
  stream is one run in the executor and two in today's runtime, and
  the two would then draw differently; no module of the corpus run
  shows it.
- **The emitter departs from the documents in three ways** that the
  results depend on. It writes one function per value a cone computes,
  where `execution-and-storage.md` §2.1 has one per cone. A pattern
  compiled in at a call written inside an initializer is evaluated in
  the caller's cone, where `plan-and-label-templates.md` §1.4 makes it
  cones of its own. And the cone the crate makes for an array written
  in place lists no slot of what the members hold. Each is a defect of
  the prototype.
- **At commit `a462df710a` the harness takes the place of a stream
  from the executor.** The plan does not say where a stream is
  stored, so the harness runs an executor beside today's run. The
  executor starts when today's instance has settled, and handles each
  event that today's run committed after today's run handled it. For
  a binding the harness takes the positions at which the executor's
  stored result holds the link, the last element of each enclosing
  collection first, and sends the event at the first of them at which
  today's run holds a stream. The elements that the event is for are
  the positions of the keys of that link in the executor's element
  tables. That is the same over an array of references, over an array
  of plain values in place, and over the result of another
  per-element construct, where the link has the upstream key. Two
  layouts of today are translated: the result of a pattern at a child
  position, with its tree under `$UI`, and the children of a view
  node, where a child is found by the number of children before it
  with each nested array counted flat. Four things follow. A scenario
  with events and no executor sends none, so the comparison of labels
  and the cost measurement run the executor beside today's run for
  that reason alone. A module that the executor does not run gets no
  event in today's run. A run has an event for every binding of a
  handler, where it had one for each binding with a listed path, and
  the harness reports "not sent" for a binding whose stream the
  executor's result does not hold. And a binding whose stream the
  executor stored at a position that no listed path named gets its
  event.
- **The saved file holds `undefined` at commit `a462df710a`.** JSON
  leaves out a member that holds `undefined` and writes a position of
  an array that holds it as `null`, so the comparison made from the
  file (`again`) compared 5 values fewer than the one made in the
  process that ran today's runtime (`run`), and found 2 values of
  `dev/catalog/catalog.tsx` different that `run` found equal. The
  file holds each `undefined` as a record that stands for it at this
  commit, and the two forms give the same figure in every row.

### The fixtures

19 of the 20 fixtures are run, in 23 runs. All 23 are executed, and 122
of 122 compared values are equal. `fixtures/link-cycle.tsx` is left out:
its handlers make two cells link to each other, and a read of the whole
result of today's run rejects with a `LinkCycleError`. One event of
`fixtures/handle-passed.tsx` is not handled, because its handler
instantiates a pattern.

At commit `96f3b83a73`, 22 of the 25 fixtures are run, in 27 runs, and
152 of 152 compared values are equal. The added runs are two of
`fixtures/callee-default.tsx` with 8 values, one of
`fixtures/chain.tsx` with 2, and one of `fixtures/side-writes.tsx`
with 20. Three fixtures are not compared with today's runtime:
`link-cycle` as before; `state-first`, whose state cell has a first
value computed from an input, which today's runtime refuses
(`validateStaticData` in `runtime/runner/src/cell.ts`); and
`side-write-undemanded`, in which a cone with a side-write is demanded
by nothing and the executor does not evaluate it, a difference the
ruling makes.

`fixtures/chain.tsx` is a `map` over a `filter` over a `map`, once
over records and once over plain values. A test of the executor runs
it with the records given as references to cells, so its two chains
are the case of an array of references and the case of an array of
plain values in place, and the second and third construct of each are
the case of the result of another per-element construct. It counts
the evaluations of cone instances of an element body.

| Step | Case | Evaluations |
| --- | --- | ---: |
| The instance is created: 3 records and 3 plain values | Both arrays | 16 |
| The title behind one reference changes | Array of references | 2 |
| `done` behind one reference changes, and the element leaves the `filter` result | Array of references | 1 |
| One plain value is replaced in place | Array of plain values in place | 3 |
| Both arrays are reversed | Both arrays | 0 |

The 2 are the first `map` and the last for that key: the predicate of
the `filter` read `done`, which did not change. The 3 are one cone
instance in each body for the key that entered. On the reversal the six
collections are assembled again, once each, and assembly is counted
apart from evaluation. In `fixtures/index-nodes.tsx`, whose elements
are plain values in place, a move of two of three elements evaluates
the function that reads the index for the two moved keys: 2
evaluations, where the executor of the earlier commit made 4. Where a
body is permitted to evaluate a whole collection again, the executor
keeps results per key all the same. The key of an element that a
`flatMap` contributes (question 147) is exercised by no fixture of that
commit.

At commit `59055fd0c5`, 27 of the 30 fixtures are run, in 33 runs, and
280 of 280 compared values are equal. The added runs are one of
`fixtures/within.tsx` with 3 values, two of `fixtures/stream-marker.tsx`
with 70, one of `fixtures/flat-keys.tsx` with 4, one of
`fixtures/keyed.tsx` with 48, and one of `fixtures/reduce.tsx` with 3.
Each of the five covers the three cases of a per-element source or says
which it covers.

- **`within`.** Each of three callbacks has a declaration that reads
  neither the element nor the index: over an array of references, over
  an array of plain values in place, and over the result of a `filter`.
  Its cone has one instance per key in each, and a change of the input
  it reads evaluates every instance.
- **`stream-marker`.** A handler is bound per element in three bodies,
  over the same three cases. The stored link has the key of the element
  in each, an event for it reads that element, and without its listed
  path each fails the check at the first element.
- **`flat-keys`.** A `flatMap` over an array of references, whose
  segment is an array the element holds, and one over an array of plain
  values in place, whose segment the callback writes, each with a `map`
  over its result, which is the case of the result of another
  per-element construct. The cone instances of the `map` have the key of
  the source element with the position in the segment, in both. A
  segment behind a reference that grows evaluates the new position
  alone, a move of the source elements evaluates nothing in either case,
  and a plain value that enters evaluates its own segment. Two members
  of one segment that change places are both evaluated again. By
  ruling the key has the member in the place of the position
  (question 147), and under it such a change of places evaluates
  nothing.
- **`keyed`.** The record of a key of a list, which is a list of
  references. The record is a cell of its own, by ruling (question
  166).
- **`reduce`.** A fold over an array of references, one over an array of
  plain values in place with the index, and one over the result of a
  `map`. A step that reads an outer input is not compared, because the
  compiler of today's runtime refuses it.

At commit `77993077e4`, 32 of the 36 fixtures are run, in 39 runs, and
489 of 490 compared values are equal. The added runs are one of
`fixtures/list-records.tsx` with 84 values, one of
`fixtures/value-identity.tsx` with 44, one of
`fixtures/passes-collection.tsx` with 2, one of
`fixtures/state-below.tsx` with 54, and two of
`fixtures/absent-state.tsx` with 12, and `fixtures/callee-default.tsx`
has 22 values where it had 8. `fixtures/self.tsx` is not compared,
beside the three fixtures that were not compared before.

- **`list-records`.** A handler writes records into a list with `push`
  and with `set`, and the executor stores each as a document of its
  own with a link in the list, as today's runtime does. The list is an
  array of references. All 84 values are equal.
- **`value-identity`.** A row over an array of plain values in place,
  with each test beside the same row over an array of references. It
  has the three handlers of question 160: one write through the
  element's reference commits and the row loses its state, two writes
  in turn are rejected, and one `update` commits. Over the array of
  references all three commit and the row keeps its state. By the
  ruling on question 160 the design re-keys the element, so the first
  two outcomes are the prototype's and not the design's.
- **`passes-collection`.** An output that passes the result of a
  `filter` on, over an array of references and over an array of plain
  values in place, each with a `map` over the output, which is the
  case of the result of another per-element construct. Over
  references the keys are those of the cells with the mark or without
  it. Over plain values a `filter` that drops the first of two equal
  values leaves the second with the count it has in the source, and
  without the mark the count is lost.
- **`state-below`.** A write of one member, and a `push`, below the
  root of a state cell that has no document, in the pattern's body and
  in an element body over an array of references, over an array of
  plain values in place, and over the result of a `filter`. The
  executor instantiates no label, so the label of the members taken
  from the default is not exercised.
- **`absent-state`.** A handler whose state path is bound to a value
  that is nothing and whose body has an entry at a member below the
  path. The executor places nothing at the path.
- **`callee-default`.** One of its 22 values differs: a path of the
  callee's result that passes on a path the caller left empty. A read
  addressed at the path gives the callee's default in both runs.
  Today's read of the whole result gives nothing there, and the
  comparison reads the whole result (question 149). It is today's
  runtime and not the design. The record is the same for a callee in
  an element body in each of the three cases.
- **`self`.** The name bound to `[SELF]` placed in a value, in the
  pattern's body and in an element body over an array of references
  and over an array of plain values in place. The executor stores a
  link to the result.

At commit `e63b3d305c`, 37 of the 41 fixtures are run, in 44 runs, and
673 of 674 compared values are equal. The added runs are
`fixtures/key-returns.tsx` with 72 values,
`fixtures/stream-returned.tsx` with 16, `fixtures/star-kinds.tsx` with
49, `fixtures/random.tsx` with 18, and `fixtures/instantiate.tsx` with
27, and `fixtures/flat-keys.tsx` has 6 values where it had 4. The one
value that differs is that of `callee-default`, above. The run prints
the events the harness did not send: one, of `star-kinds`. One event
of `handle-passed` is not handled: its handler instantiates a pattern,
which the executor does at this commit, and then calls `navigateTo`.

- **`key-returns`.** A state cell declared in the body of a `map` over
  the result of a `filter`, once over records that a handler pushed,
  which are references, and once over plain values in place. The keys
  leave the result of the `filter` and enter it again. The cone
  instances of a key are gone while it is away, no document is made or
  deleted, and the key that returns reads what its cell held. The
  executor's tests add a link that leaves an array of references and
  stands in it again, a plain value that leaves an array in place and
  is written again at another position, and the last occurrence of two
  equal plain values. Over plain values in place today's key is the
  position, so a value that returns at another position is the one
  case where today's runtime would read another cell, and the
  comparison does not have it.
- **`stream-returned`.** A `lift` that returns the stream it is handed,
  for a binding outside every element body and for a binding of an
  element body over references and over plain values in place. The
  stored link has the key of the element in each, and no path of
  `Binding.result` names the position.
- **`star-kinds`.** Each kind of a `*`: `every` and `element` over
  references and over plain values in place, `inside` over an array of
  plain values written in place, and `element` over the result of
  another construct, with an event for each binding but one. The one
  is of two collections spread into one array of children, which the
  harness could not resolve with the children stored flat; by the
  ruling since, each collection is a child position of its own.
- **`random`.** A pattern that draws from `Math.random`, under the
  seed.
- **`instantiate`.** A function body that instantiates a pattern, with
  two instances made by two events, and a `computed` that binds a handler
  twice. An event for the second stream writes the cell, the
  `computed` is not evaluated again, and the streams are the ones it
  bound.
- **`flat-keys`.** Over a source of references, a segment of plain
  values and a segment of references that the element holds; over a
  source of plain values in place, a segment of plain values that the
  callback writes in an order an input chooses. Two members of one
  segment that change places evaluate nothing in the body over the
  result. Where the callback computes the members, the callback is
  evaluated once per source element, and the body over the result for
  no member. No fixture declares a state cell in a body over the
  result.

At commit `e4f2fb3431`, 39 of the 48 fixtures are run, in 46 runs, and
727 of 728 compared values are equal. The added runs are
`fixtures/value-copy.tsx` with 35 values and
`fixtures/push-default.tsx` with 12, and `fixtures/star-kinds.tsx` has
56 values where it had 49. The one value that differs is the one that
differed at the earlier commit. Nine fixtures are not compared with
today's runtime and are run by the executor's tests alone. Five of
them are of this round: `member-kind`, `flat-streams` and `rekey`,
whose rulings today's runtime does not follow, and `as-instance` and
`keyed-by`, which today's runtime does not compile.

- **`star-kinds`.** With a collection among the children stored as
  one nested child, the harness resolves a `*` below a child position
  in the array that the child holds, and sends an event for every
  binding: the event for the second of two collections among the
  children of one node, which it could not send, is sent. It sends
  no event for a stream at a `member` position of an array value,
  which is stored flat.
- **`value-copy`.** Over arrays of plain values in place: a handler
  that reads two arrays through their handles and writes each with
  members of the other, a handler that stores one element in a cell,
  and a handler of a row that finds its element with a handle by
  position and `equals`. The executor stores the values, and makes no
  document for the copy of a record.
- **`push-default`.** A `push` below a path of the argument at which
  nothing is stored and whose schema declares a default, with an
  array of plain values in place and with an array whose default
  record stays in place while the pushed record is a reference.
- **`member-kind`.** Kind `member` in an array value with a spread,
  after a spread over references and after one over plain values in
  place. No path of the corpus has the kind.
- **`flat-streams`.** A handler bound in the body of the callback of
  a `flatMap`, over a source of references and over a source of plain
  values in place, each with segments of plain values that the
  callback writes. Every member of a segment holds the stream of its
  source key, and an event for it reads the source element. A segment
  of references holds no stream of the body in a member, so that key
  form is tested on the match alone.
- **`rekey`.** Over an array of plain values in place, with a body
  over the array and one over the result of a `filter` of it: a write
  through a reference by key keeps the state of the row, two writes
  one after the other commit, a handler that throws moves nothing,
  and a reference stored elsewhere under the old key, or a handle
  that the same handler stored before its write, reads as nothing.
  Over an array of references the two writes commit and no key
  changes.
- **`stream-marker`.** A marker below a conditional fails the check
  while another subtree of the tree changed in the same write, and
  the stored `$UI` is the earlier tree whole. The same for a marker
  of a cone of an element body over references, over plain values in
  place, and over the result of a `filter`.
- **`self`.** A handler that captures the name of `[SELF]`, in the
  pattern's body and in an element body over references and over
  plain values in place, is handed a reference to the result cell.
- **`as-instance`.** A pattern called through `asInstance()` in an
  element body. Over an array of references the argument holds the
  link to the element's cell, and a change of the element's value
  writes no argument and changes no key. Over an array of plain
  values in place the argument holds the value: the instance of a
  value that left reads the value it was last given, and the same
  value written again, at any position, has the same instance. Over
  the result of a `filter` the instance is identified by the upstream
  key and is the same when the `filter` drops the element and keeps
  it again. An event for a stream of the instance is handled while
  the key is away.
- **`keyed-by`.** A plain array generated from scratch, where a `lift`
  returns the whole array each time and a change of an input gives
  every element another `stars`: each element has the key of its
  `id`, the state cell of its row stays, and the row reads the new
  value. The result of a `filter` and a `map` over it: the
  `asInstance()` instance of a row is the same when its element has
  another `stars`, leaves the result of the `filter`, and enters it
  again. An array of plain values in place: a write through a
  reference by key that changes another member re-keys nothing, a
  `set` of the whole array in another order keeps each row with its
  `id`, and two elements with one value of the field are occurrences
  0 and 1. An array of references: the keys are those of the cells.

At commit `a462df710a`, 40 of the 51 fixtures are run, in 47 runs, and
752 of 753 compared values are equal. The added run is
`fixtures/flat-inner.tsx` with 25 values. The one value that differs
is the one that differed at the earlier commits. Eleven fixtures are
not compared with today's runtime and are run by the executor's tests
alone. Two of them are of this round, `rekey-made` and
`spread-child`, whose rulings today's runtime does not follow.

- **`flat-inner`.** A `flatMap` whose callback returns the result of
  an inner `map` that binds a handler, twice. The binding has two
  `element` steps, and the result of the `flatMap` has one level of
  positions. Over an array of references, groups and parts that a
  handler pushed, each position holds the link with the key of the
  group's cell and the key of the part's cell. Over an array of plain
  values in place, shelves and tags that the creator of the instance
  wrote, each position holds the link with the key of the shelf,
  formed from its whole value, and the key of the tag. The segment is
  the result of another per-element construct in both. An event for a
  position reads its group and its part, and 25 of 25 values equal
  today's.
- **`stream-target`**, which is run with generated events, has an
  event for the binding `inc`, whose stream the result does not hold,
  and the harness sends none for it.
- **`stream-marker`, `star-kinds`, `member-kind` and
  `stream-returned`.** No position is checked. Over an array of
  references and over an array of plain values in place, a binding of
  the element body is stored once for each key, at the row of that
  key; the one stream of a binding made outside the callback is
  stored at every element; and a member written after a spread in an
  array value is at the position after what the spread holds. Over
  the result of another per-element construct the link has the
  upstream key. A marker below a conditional is stored when its
  branch is selected, with the rest of the tree of the same
  evaluation.
- **`value-identity`.** Four added tests. Over an array of plain
  values in place, a handler that declares `stop: Stop` stores a
  link with the collection and the key of the element, and
  `center.set(stop.position)` stores that link with `position` after
  the key; a handle whose schema declares its items as handles gives
  one reference by key for each member, which stays with its element
  when the element moves. Over an array of references the cells hold
  links to the element's cell and to `position` in it, and each
  member handle names the position that holds the link.
- **`rekey-made`, and three added tests of `rekey`.** Over an array of
  plain values in place with no declared key field, with a `lift`
  that instantiates a pattern with a state cell and one that binds a
  handler. The instance and its state are those of the element after
  the write, and an event for its stream is handled. Nothing moves
  for the binding that a function body made: the body binds a handler
  of its own under the new key, and the stream has another name. What
  is moved replaces what is stored under the new key. Of two equal
  elements, the second is occurrence 0 after the first is re-keyed,
  and it has neither its own earlier state nor the first's. A `set`
  of the whole array re-keys nothing. Over an array of references the
  write changes no key and the instance stays.
- **`spread-child`.** A JSX spread child is one child at its written
  position, which holds a nested array: over an array of plain values
  in place, over the result of a `map` whose source holds references,
  and over an array of references. An array literal with a spread is
  one child that holds the members and what the spread holds as the
  positions of one nested array, and one with a hole is one child
  whose hole is a position that holds nothing. A child written after
  them keeps its position when a spread array changes its length.
  Today's JSX factory flattens each of these where the tree is built.
- **`keyed-by`.** Over an array of plain values in place, a reference
  by key names the element after another member changed, with no
  re-key, and the same key names no element of an array whose schema
  declares no field. Over a plain array generated from scratch, and
  over the result of a `filter` and a `map` over it, the keys are
  formed from the collection's copy of the keyword and have the same
  form. Over an array of references the key is the cell. The second
  statement of the first case is of the ruling that is withdrawn: by
  the ruling that replaces it, a key that names `id` resolves by that
  field in any array.

At commit `7774ba208c`, 41 of the 53 fixtures are run, in 48 runs, and
767 of 768 compared values are equal. The added run is
`fixtures/spread-stream.tsx` with 15 values. The one value that
differs is the one that differed at the earlier commits. Twelve
fixtures are not compared with today's runtime and are run by the
executor's tests alone: the eleven of the earlier commit and
`keyed-by-fields`, since today's runtime has no declared key.

- **`spread-stream`.** Each form of a spread is written in a
  `computed`, which today's runtime runs: an array value with a
  spread and a stream at the member after it, twice, and a view node
  with two JSX spread children and a stream at a child after them.
  The arrays are plain values in place that each `computed` reads
  whole, so no per-element construct of the plan is over them, and
  the `map` in each is that of JavaScript. With an event for each of
  the two streams, 15 of 15 values are equal, both events are
  committed and handled, and the executor's result holds 3 links to
  a stream. This is the function tier, where a view node flattens
  the arrays it is handed in both runtimes.
- **`member-kind` and `spread-child` stay with the executor's tests,**
  because today's runtime runs neither where the pattern's body
  writes the form. For an array literal with a spread of a pattern
  value, written as a value, today's run stores 50 positions for the
  spread operand, the two rows first and 48 that hold nothing after
  them, and the member at position 51, where the executor stores the
  two rows and the member at position 3. For the same literal among
  the children of a view node, today's transformer stops with "Spread
  traversal of opaque pattern values is not lowerable. Move this
  expression into computed()". For a JSX spread child of a pattern
  value, the evaluation of the pattern throws "object is not
  iterable". So the ruling on a spread child, as one child at its
  written position in the reactive tier, has no run of today's
  runtime to be compared with there. The spread operand in these
  fixtures is a pattern value; the prototype's note does not say for
  each of the three cases of a source what today's runtime does.
- **`keyed-by`.** The key of a declared key field names the field.
  Over a plain array generated from scratch, with a `filter` and a
  `map` after it, the state cells of the rows over elements whose
  `id` are 1 and 2 have keys that name `id`, those of a body over the
  result of a `filter` of the numbers 1 and 2 have keys of the whole
  value, and the stream of a handler over the result of a `filter`
  has the upstream key, which names the field. A handler over that
  array is given the value, and what it sets stores the value and no
  link, because the executor gives an element of such an array no
  place; by the ruling since, the element has a reference by key.
  Over an array of plain values in place, a handler of a row stores
  `picked.set(repo)` as a link with the collection and the key, and
  `owner.set(repo.owner)` as that link with `owner` after the key.
  Readers of the two cells whose types declare no key, and a read
  under a schema that declares another key, give the name and the
  owner, also after the array is written whole in another order with
  other values of both members. Over an array of references the key
  is the cell.
- **`keyed-by-fields`.** A key of two fields, declared as
  `KeyedBy<Repo, "owner" | "name">`, with each row an instance of a
  pattern called through `asInstance()` that has a state cell. Over a
  plain array generated from scratch, with a `filter` and a `map`
  after it: after an input gives every element another `stars` and
  another input reverses the order, each row holds the note it was
  given and the new `stars`, the two links of the result are those of
  the same two instances in the other order, and the element that
  now passes the `filter` has a third instance. Over an array of
  plain values in place: two elements with one `name` and two `owner`
  are two keys, a write through the reference by key to `stars`
  re-keys nothing, a `set` of the whole array in the other order with
  other `stars` leaves each instance with its element and its note,
  an element with another `name` is another key, and the two
  instances of the keys that left stay. It is not compared with
  today's runtime.
- **`rekey-made`,** one added test. Over an array of plain values in
  place with no declared key, the instance that a `lift` made for a
  key that left is in the store until a re-key moves another instance
  to its name. After the re-key no document or declared place begins
  with its name, the documents of the store are those of two rows,
  and the instance that moved handles an event. Over an array of
  references no key changes and nothing is replaced.

### The corpus

The figures down to the heading "The corpus at commit `96f3b83a73`"
are of commit `3e518147df`.

The comparison takes the 270 modules with a full plan. Today's runtime
runs 213 of them, the same 213 as in the cost section. The executor
runs 186 of the 213. In 159 of the 186 every compared value is equal
and every event that today's runtime committed is handled.

| Why a module is not executed | Modules |
| --- | ---: |
| The emitter writes no code for a `reduce` in the reactive tier | 7 |
| The value code throws | 6 |
| An output that no value function computes | 4 |
| A handler called in a function body | 2 |
| The built-in `toIndentedDebugString` | 2 |
| The emitter writes no code for a spread in the argument of a pattern | 1 |
| A value that is no plain data | 1 |
| The built-in `linksOf` | 1 |
| The built-in `toCompactDebugString` | 1 |
| The value code does not parse | 1 |
| The value code names something it does not bind | 1 |

The first row is the emitter's. The rows that name a built-in, a handler
called in a function body, and a value that is no plain data are things
the executor does not implement. The rows "the value code throws",
"names something it does not bind", and "does not parse" were not
examined one by one, and each counts as a defect of the prototype until
shown otherwise.

Today's runtime committed 269 events for the executed modules. The
executor does not handle 15 of them: 9 call `elementById`, 4 instantiate
a pattern in the handler, one writes through a handle to a constant,
which the documents refuse (`execution-and-storage.md` §2.4), and one
calls `increment` on a value that is no handle.

Over the executed modules 4,537 values are compared. 4,472 are equal and
65 differ, in 24 modules.

| Cause of a difference | Class | Modules | Values |
| --- | --- | ---: | ---: |
| `dataFile(...)` at module scope, a built-in the executor does not have | Prototype defect | 6 | 7 |
| An event the executor did not handle, and what later values show of it | Prototype defect | 4 | 15 |
| A handler factory as a value of the result (`plan-and-label-templates.md` §3.21), which the executor does not store | Prototype defect | 1 | 5 |
| A check today's JSX factory makes of a `$` attribute and the executor does not | Prototype defect | 1 | 2 |
| A branch that is not selected is not evaluated (`execution-and-storage.md` §2.2), and the pattern counts its evaluations | Design difference the documents state | 1 | 5 |
| Today's runtime writes a cell in a template literal as `[object Object]`, and the executor writes its value | Today's runtime, not the design | 1 | 5 |
| A read of the acting principal or of an access list, which the executor does not have. Not verified | Prototype defect, not verified | 2 | 3 |
| Not examined | Not classed | 8 | 23 |

The eight modules not examined are `examples/todo-list/todo-list.tsx`,
`showcase/card-piles/main.tsx`, `examples/map-demo/map-demo.tsx`,
`system/agent-run/agent-run.tsx`, `dev/catalog/catalog.tsx`,
`examples/cfc-spec-gallery/main.tsx`,
`dev/gideon-tests/test-cell-equals.tsx`, and
`showcase/wordsearch/wordsearch.tsx`. So 23 of the 65 differing values
have no cause, and the causes given for the other rows come from a
first reading of the source and the two values and are not verified.

At this commit no difference is classed as a gap of the design by
itself. The gaps this round found are in what the executor needed in
order to compute a value at all. Each showed as a wrong value or a failed run before the emitter
or the executor supplied what was missing. Eight are ruled
([Decided](#decided)), and the rest are questions: 141, 144 to 147,
and 149 to 151 below, and questions 81 to 84 of
`execution-and-storage.md`.
The one design difference in the table is by the documents: in
`patterns/dev/gideon-tests/test-ifelse-both-branches.tsx` today's
runtime evaluates both branches of an `ifElse` and the executor the
selected one.

### The corpus at commit `96f3b83a73`

The crate emits a plan with no unsupported construct for 272 modules,
two more, because a first value that is not a constant is no longer
unsupported. The first two columns are over the same 270 modules. In
the second the executor alone was run again, against the values that
today's runtime computed for the first. For the third, today's runtime
was run on the two added modules.

| | `3e518147df` | `96f3b83a73` | `96f3b83a73`, 272 modules |
| --- | ---: | ---: | ---: |
| Modules run by today's runtime | 213 | 213 | 215 |
| Executed | 186 | 187 | 189 |
| Every value equal and every event handled | 159 | 161 | 161 |
| Values compared | 4,537 | 4,539 | 4,607 |
| Values equal | 4,472 | 4,485 | 4,527 |
| Values that differ | 65 | 54 | 80 |
| Modules with a difference | 24 | 22 | 23 |
| Committed events the executor does not handle | 15 of 269 | 15 | 20 of 278 |
| Documents the executor stored | 1,302 | 504 | 509 |
| Of them state cells | 898 | 98 | 99 |

The table "Why a module is not executed" and the table of causes above
are not made again for the later commit. What the notes give of the
changes:

- **One module more is executed,** `dev/test/input-self/subjects.tsx`.
  One of its two values differs: the result holds a reference to
  itself, which the executor's read gives as nothing at the second
  level and today's read follows (question 157).
- **Values that differed and are equal:** 6 of
  `examples/todo-list/todo-list.tsx`, by the moved element and by the
  keys of a derived collection that a cone passes on unchanged
  (question 156); 2 of `showcase/card-piles/main.tsx` and 4 of
  `apps/contacts/contact-book.tsx`, both by the fix of the copy of a
  container that had no address.
- **Two values that were equal differ,** both in
  `examples/map-demo/map-demo.tsx` after its last event. The handler of
  that event removes an area, which it did not find before the fix of
  the container copy. A cell that an earlier event had set to the
  area's center then reads as nothing, because it holds a reference to
  a position below the array (question 145; under the ruling it holds
  a reference by key and reads as nothing all the same). The two values of the
  module that differed after that event are equal, so the module has 4
  values that differ, as before. No other value that was equal differs.
- **The two added modules.** `showcase/battleship/pass-and-play/main.tsx`
  has 32 of 32 values equal. `apps/base/contacts.tsx` has 10 of 36: two
  of its handlers construct a cell with `new` in a function body, which
  the executor does not do.
- **Rulings that changed no value.** The demand of a cone with a small,
  fixed set of write targets changed no value of the corpus.

Of the 23 values in 8 modules that the earlier commit left without a
cause, 8 are equal (`todo-list.tsx` and `card-piles`). The other 15, by
class:

| Module | Values | Class | Cause |
| --- | ---: | --- | --- |
| `examples/map-demo` | 4 | Design difference, ruled (question 145) | A stored reference to a member of an element that is a plain value in place, which is then removed |
| `dev/gideon-tests/test-cell-equals` | 1 | Prototype defect under the ruling of question 145 | `equals` of a reference with an element that is a plain value in place, of which the executor holds a copy |
| `showcase/wordsearch` | 3 | Neither | The pattern draws its seed from `Math.random`, and the two runs draw two numbers |
| `system/agent-run` | 4 | Today's runtime, not verified | The scenario's argument holds `run.state`, and today's run reads nothing at `run` |
| `dev/catalog/catalog` | 2 | Prototype defect, not verified | A child that is `null` in today's run holds nothing in the executor's |
| `examples/cfc-spec-gallery` | 1 | Prototype defect, not verified | A `$cell` attribute holds a pattern's result; today's read gives no `$NAME` below it |

The classes of the first two rows are those given at that commit, and
they are wrong. Both modules fill their list with `push`. Today's
runtime gives a record so written a document of its own and stores a
link in the list, so both lists are arrays of references, and neither
row is of the case of an array of plain values in place. The executor
of that commit stored such a record in place, which is a defect of the
prototype. Both rows are equal at commit `77993077e4`, below. Today's
runtime does hold records in place: the records of the argument that
an instance is created with, and of a default
(`plan-and-label-templates.md` §1.3, "Which stored forms make which
case").

### The corpus at commit `59055fd0c5`

The figures are of the executor alone, run again on the crate's output
of this commit against the values that today's runtime computed in the
run of commit `96f3b83a73` over the 272 modules. No fresh run of today's
runtime was made.

| | `96f3b83a73`, 272 modules | `59055fd0c5` |
| --- | ---: | ---: |
| Modules run by today's runtime | 215 | 215 |
| Executed | 189 | 194 |
| Every value equal and every event handled | 161 | 167 |
| Values compared | 4,607 | 4,735 |
| Values equal | 4,527 | 4,642 |
| Values that differ | 80 | 93 |
| Modules with a difference | 23 | 24 |
| Committed events the executor does not handle | 20 of 278 | 15 of 293 |
| Evaluations that fail the check of a stream's position | not made | 0 |
| Stored stream positions at a listed path | 440 | 683 |
| Stored stream positions at no listed path | 18 | 3 |
| Documents the executor stored | 509 | 535 |

Over the 189 modules that were executed before, 4,529 of 4,607 values
are equal, 2 more, and 11 events are not handled, 9 fewer. The tables
"Why a module is not executed" and of causes are not made again for this
commit. What the notes give of the changes:

- **Five modules more are executed,** the ones with a `reduce` in the
  reactive tier. `apps/budget-tracker/data-view.tsx`, and
  `amount-ledger.tsx`, `budget-vs-actual.tsx` and
  `spend-by-category.tsx` of `product/primitives/`, have every value
  equal, 80 values. `product/primitives/demo/atoms-demo.tsx` has 33 of
  48 equal, with 4 events not handled, each a handler of a pattern
  compiled in whose state holds a constant where the handler expects a
  handle. Its 15 differences were not examined. Two modules with a
  `reduce` stop at `toIndentedDebugString`.
- **Values that differed and are equal:** 7 of
  `apps/topic-workbench/main.tsx`, whose events are handled with the
  record of a key of a list.
- **Five values that were equal differ,** all in
  `apps/person-workbench/main.tsx`. Its handler `attachToPicked` ran to
  its end for the first time, and it attaches a session where today's
  run returns early because the picked card is nothing. The executor
  holds something that is not nothing for the card. That was so before
  and did not show, because the event failed at `elementById`. It is not
  examined further, and counts as a defect of the prototype until shown
  otherwise. No other value that was equal differs.
- **Events.** Both events that failed at a cell made with `new` fail at
  the next step, a pattern instantiated in the handler. A pattern
  instantiated in a function body stops 6 events and a handler bound in
  one stops 2 modules; the debug strings and `linksOf` stop 6 modules.
- **Streams.** No evaluation fails the check of a stream's position. The
  3 stored positions at no listed path hold the stream of a binding that
  a `computed` makes and returns, which is allowed by ruling
  (question 165). The 683 at a listed
  path include the 208 positions of a stream inside a member of an
  element, at which the earlier executor stored a record.
- **Documents.** The 26 documents more are 5 argument and 5 result
  documents of the added modules, 5 state cells, and 11 records of a
  key.

### The corpus at commit `77993077e4`

The figures are of the executor alone, run again on the crate's output
of this commit against the values that today's runtime computed in the
run of commit `96f3b83a73` over the 272 modules. No fresh run of today's
runtime was made.

| | `59055fd0c5` | `77993077e4` |
| --- | ---: | ---: |
| Modules run by today's runtime | 215 | 215 |
| Executed | 194 | 194 |
| Every value equal and every event handled | 167 | 168 or 169 |
| Values compared | 4,735 | 4,735 |
| Values equal | 4,642 | 4,641 to 4,650 |
| Values that differ | 93 | 85 to 94 |
| Modules with a difference | 24 | 22 or 23 |
| Committed events the executor does not handle | 15 of 293 | 15 of 293 |
| Documents the executor stored | 535 | 598 |

The range is `showcase/card-piles/main.tsx` alone: 0, 6 or 9 of its 28
values differ from one run to the next, by what `Math.random` draws.
Without that module 85 values differ, in 22 modules. What the notes
give of the changes:

- **Ten values that differed are equal.** 4 of
  `examples/map-demo/map-demo.tsx` and 1 of
  `dev/gideon-tests/test-cell-equals.tsx`: both modules fill their list
  with `push`, so their elements are cells in today's runtime, and the
  executor stores them so. The two rows were classed as a design
  difference and as a defect under the ruling of question 145, and
  both were a defect of the prototype, which stored such a record in
  place. The case is an array of references. And 5 of
  `apps/person-workbench/main.tsx`: a handler whose body has an entry
  at a state path and one at a member below it was handed a record
  with the member where the path was bound to a value that is
  nothing, and the executor places nothing there.
- **Two values that were equal differ,** both in
  `dev/gideon-tests/test-handler-capture-key-equals.tsx`. A handler of
  a row finds its element with `inboxItems.key(i).equals(inboxItem)`.
  The handle of `key(i)` names the position, the row's element is a
  reference by key, the two are not equal in the prototype, and the
  handler removes nothing. Today's runtime finds
  the element, because both name the position there. By the ruling on
  question 163 the two are equal in the design. The case is an
  array of plain values in place; over an array of references both
  resolve to the cell.
- **`card-piles` varies.** Its handler reads two piles, shuffles the
  cards, and sets both piles. In the prototype
  the first pile then holds references by key into the second, which
  is set next, and the cards that changed piles read as nothing.
  Today's runtime stores copies, and by the ruling on question 163 so
  does the design. The executor of the earlier commit
  stored a link to the position, which read whatever card stood
  there, and the cards of the scenario are all equal. The case is an
  array of plain values in place.
- **No other value changed.** The rulings on a derived collection
  passed on, on a write below the root of an empty state cell, on a
  first value, on the callee's default, and on `[SELF]` changed no
  value of the corpus. No event of the run is refused for a reference
  whose key no position holds.
- **Documents.** The 63 documents more are the 64 documents of a
  record that a handler wrote into a list, less one record of a key.

The notes make no table over all the values that differ at this
commit. They class the following, which earlier commits left
unexplained or not examined. The other differences have the classes of
the tables above.

| Module | Values | Class | Cause |
| --- | ---: | --- | --- |
| `product/primitives/demo/atoms-demo` | 11 | Prototype defect, and a write the documents refuse | A handler of a pattern compiled in sorts `rows`, which the call writes as a literal. The crate holds `null` for each constant of it, and the handler ends early |
| `product/primitives/demo/atoms-demo` | 4 | Prototype defect | What four events that are not handled leave: `step`, `min` and `items` are constants the crate holds as `null`, where the handler expects a handle |
| `system/agent-run` | 4 | The scenario, not verified by a run | The generator gives `run` no value for four required members of type `unknown`, and today's read of `run` under its schema gives nothing |
| `dev/catalog/catalog` | 2 | Prototype defect, not verified | As at commit `96f3b83a73` |
| `examples/cfc-spec-gallery` | 1 | Prototype defect, not verified | As at commit `96f3b83a73` |
| `dev/gideon-tests/test-handler-capture-key-equals` | 2 | Prototype, against the ruling on question 163 | A handle that names a position compared with a reference by key |
| `showcase/card-piles` | 0, 6 or 9 | Prototype, against the ruling on question 163 | A handler that moves plain values between two arrays |

With the crate's constants right, the first row would still differ:
the handler writes through a handle to a constant of the call, which
the compiled path refuses (`execution-and-storage.md` §2.4), and
today's runtime writes the callee's argument document. The rows of
`agent-run`, `catalog` and `cfc-spec-gallery` rest on a reading of the
source and of the two values. The last two rows are of the case of an
array of plain values in place, and neither arises over an array of
references.

### The corpus at commit `e63b3d305c`

Two runs, both of the executor alone on the crate's output of this
commit. The first is against the values that today's runtime computed
in the run of commit `96f3b83a73`, with the line of
`showcase/card-piles/main.tsx` from a seeded run of today's runtime in
its place. The second is against a fresh seeded run of today's runtime
over all 272 modules, which sends more events: with the kinds of a `*`
the harness resolves the stream of more bindings, most of them through
a `*` of kind `inside`. Each run gives the same file byte for byte
when it is repeated.

| | `77993077e4` | `e63b3d305c`, saved values | `e63b3d305c`, fresh run |
| --- | ---: | ---: | ---: |
| Modules run by today's runtime | 215 | 215 | 215 |
| Executed | 194 | 196 | 196 |
| Every value equal and every event handled | 168 or 169 | 168 | 169 |
| Values compared | 4,735 | 4,769 | 5,410 |
| Values equal | 4,641 to 4,650 | 4,680 | 5,324 |
| Values that differ | 85 to 94 | 89 | 86 |
| Modules with a difference | 22 or 23 | 25 | 24 |
| Committed events the executor does not handle | 15 of 293 | 10 of 295 | 10 of 475 |
| Evaluations that fail the check of a marker | 0 | 3 | 3 |
| Stored stream positions at no listed path | 3 | 31 | 31 |
| Documents the executor stored | 598 | 615 | 793 |

With the rulings applied and before the instances of a function body,
the first run had 4,641 of 4,735 values equal, 94 that differ in 23
modules, 168 modules fully equal, 15 of 293 events not handled, and
598 documents: the figures of the earlier commit with `card-piles` at
its 9 differences. No value that was equal differs for a ruling. What
the notes give of the changes against that, in the first run:

- **`card-piles` is fixed by the seed, at 9 of 28.** With the seed the
  module has the same values in three runs of today's runtime, alone
  and in one process with 13 other modules, and 9 of its 28 values
  differ in every run. The cause is the prototype's reference by key
  where a handler moves plain values between two arrays. By the ruling
  since, such a handler holds copies, and the design stores what
  today's runtime stores (question 163). The case is an array of plain
  values in place.
- **`apps/base/contacts.tsx`** has 17 differences where it had 26,
  with its 4 events handled.
- **`apps/base/person.tsx` and `apps/base/family-member.tsx`** are
  executed for the first time, with 2 of 18 and 2 of 16 values that
  differ, at a child of the tree that today's run holds as nothing.
  They are the 2 modules more with a difference, and they are not
  examined.
- **`dev/self-reference-test`** has its event handled, and its 2
  differences still.
- **Events.** Of the 6 events that failed with a pattern called in a
  function body, 3 are handled and 3 fail at `navigateTo` in the
  handler, which requests an effect.
- **Evaluations that fail the check.** The 3 are of
  `apps/base/contacts.tsx`: a promoted `computed` with a block body
  returns a tree that holds the stream of `openInNewView`, value code
  places the marker, and the crate lists no path for the binding. It
  is a defect of the crate's list, which the check found. Over the
  scenarios of the earlier commit no evaluation fails.
- **Stored stream positions at no listed path.** 9 are of a stream
  that a function body returns, where the earlier commit had 3: the 6
  more are in `examples/cfc-spec-gallery/main.tsx` and held a record
  in the place of the stream before. 22 are in `person.tsx`,
  `family-member.tsx`, `contacts.tsx` and `dev/self-reference-test`:
  the streams of bindings a function body made, and those of bindings
  of an instance a function body made, which the count reads against
  the plan of the instance it started with.
- **Documents.** The 17 documents more are 5 argument and 5 result
  documents, of the 2 modules and of 3 instances, and 7 cells and
  records of theirs.
- **The fresh run.** `showcase/wordsearch/wordsearch.tsx`, which draws
  from `Math.random` as well, has no difference where it had 3, which
  is the seed. 7 modules send more events than before, 180 more
  committed in all, with every value of theirs equal.

19 modules that today's runtime runs are not executed: 6 whose value
code throws, 4 at an output that no value function computes, 5 at a
debug string, and one each at `linksOf`, at a spread in the argument
of a pattern compiled in, at value code that does not parse, and at a
name value code does not bind. The crate's `null` constants for the
literal arguments of a call of a pattern compiled in
(`product/primitives/demo/atoms-demo.tsx`) are as they were.

### The corpus at commit `e4f2fb3431`

The figures of this section are from the prototype author's run, as
the prototype's note 404 and the two reports of that run give them.
They were not computed again for this plan. The run is a fresh seeded
run of today's runtime over all 272 modules (`values-corpus.ts run`),
followed by the executor alone on the file of that run
(`values-corpus.ts again`), which is the form of the fresh-run column
of the earlier commit. The fresh run was made with the crate of the
commit before the notes and with an executor that had a defect, fixed
since (below), and `again` with the executor of this commit. The
baseline is the fresh run of commit `e63b3d305c`.

| | `e63b3d305c`, fresh run | `e4f2fb3431` |
| --- | ---: | ---: |
| Modules run by today's runtime | 215 | 215 |
| Executed | 196 | 196 |
| Every value equal and every event handled | 169 | 171 |
| Values compared | 5,410 | 5,410 |
| Values equal | 5,324 | 5,335 |
| Values that differ | 86 | 75 |
| Modules with a difference | 24 | 22 |
| Committed events the executor does not handle | 10 of 475 | 10 of 475 |
| Evaluations that fail the check of a marker | 3 | 0 |
| Stored stream positions at no listed path | 31 | 31 |
| Documents the executor stored | 793 | 793 |

Three modules have another outcome than at the baseline, and each is
better.

- **`showcase/card-piles/main.tsx`** is fully equal, 28 of 28 values
  where 9 differed. Its handler reads two piles through their handles
  and sets both, and by the ruling on a function body's copy the
  executor stores the values. The case is an array of plain values in
  place.
- **`dev/gideon-tests/test-handler-capture-key-equals.tsx`** is fully
  equal, 4 of 4 values where 2 differed. The handler of a row finds
  its element with `inboxItems.key(i).equals(inboxItem)`, and by the
  ruling on the comparison a handle by position is equal to the
  reference by key of the element that stands there. The case is an
  array of plain values in place.
- **`apps/base/contacts.tsx`** has no evaluation that fails the check
  of a marker, where it had 3: the crate lists a path for a stream in
  the tree that a promoted `computed` returns. Its 17 differences are
  as they were.

No module is worse: none has a value that differs where it was equal,
an event that is not handled where it was, or another reason for not
being executed. The prototype's author read that from a second fresh
run, of the crate and the executor at commit `e63b3d305c`, set module
by module against this one.

- **Events.** The 10 that are not handled are the 10 of the baseline:
  3 call a debug-string built-in in a function body, 4 are of
  `product/primitives/demo/atoms-demo.tsx` (below), and one each
  writes through a handle to a value the instance holds no address
  for, reads an output that no value function computes, and calls
  `increment` on a value that is no handle.
- **Modules not executed.** The 19 are the 19 of the baseline.
- **`product/primitives/demo/atoms-demo.tsx`.** A state path of a
  binding of a pattern compiled in, bound to a name whose property
  the call writes as a literal, holds the literal as its constant at
  this commit. The module's 4 events are still not handled and its 15
  differences are as they were, for another cause: its handlers are
  `action`s that capture `step`, `min` and `items`, the slot of a
  captured name has the schema of the place and not the handle type
  that the callee declares, and the handler is handed the value where
  it calls `step.get()`. That defect of the prototype is not fixed.
- **A defect of the executor that the run found.** With a declared
  key, a reader of an element that has no place depends on what the
  element of its key holds. The executor checked that dependency in
  the context of whoever checked the entry, and the fold of a
  `reduce` checks its steps outside the collection, so the fold was
  evaluated again at every settling: `atoms-demo.tsx` had 319
  assemblies where it had 14, with the same values. The dependency
  finds the element in the table of its collection by the key at
  this commit. The elements concerned are plain values with no
  place: those of a plain array generated from scratch and of an
  array written in place in a pattern body.
- **What the executor counted.** 4,153 evaluations, 1,122 of them of
  a cone instance of an element body, and 538 assemblies, with every
  one of the 518 writes of a handler covered by a write edge or an
  envelope.
- **Documents.** The 793 are 199 argument and 199 result documents,
  281 state cells, 34 cells that a function body created, 68 records
  that a handler wrote into a list, and 12 records of a key of a
  list.
- **The two forms of the comparison disagree, and that is not
  examined.** `run` compares in the process that ran today's runtime,
  and `again` compares with the values as the file holds them. For
  this run `run` has 5,340 of 5,415 values equal, and for the run of
  commit `e63b3d305c` 5,329 of 5,415, where `again` has 5,335 of
  5,410: 5 compared values more in `run`, and 5 more equal. The
  modules that differ between the two forms are
  `dev/catalog/catalog.tsx`,
  `dev/catalog/stories/cf-code-editor-story.tsx`,
  `dev/self-reference-test/self-reference-test.tsx` and
  `system/profile-create/profile-create.tsx`, and
  `showcase/battleship/multiplayer/room.tsx` is not executed for
  another reason in each form. The figures of the table are those of
  `again`, as at the earlier commit.

### The corpus at commit `a462df710a`

The figures of this section are from the prototype author's run, as
the prototype's note 417 and the two reports of that run give them.
They were not computed again for this plan; the coordinator of this
work ran the prototype's tests and fixtures again and not the corpus.
The run is a fresh seeded run of today's runtime over all 272 modules
(`values-corpus.ts run`), with the crate and the executor of this
commit, followed by the executor alone on the file of that run
(`values-corpus.ts again`). The two forms give the same figure in
every row. The baseline is the `again` form of the run of commit
`e4f2fb3431`; the `run` form of that run had 5,415 values compared and
5,340 equal.

| | `e4f2fb3431`, `again` | `a462df710a` |
| --- | ---: | ---: |
| Modules run by today's runtime | 215 | 215 |
| Executed | 196 | 196 |
| Every value equal and every event handled | 171 | 171 |
| Values compared | 5,410 | 5,498 |
| Values equal | 5,335 | 5,414 |
| Values that differ | 75 | 84 |
| Modules with a difference | 22 | 22 |
| Committed events the executor does not handle | 10 of 475 | 10 of 486 |
| Positions of the results that hold a stream | 721 | 726 |
| Documents the executor stored | 793 | 802 |

Against the `run` form at commit `e4f2fb3431`, read module by module,
four modules have another outcome. In each an event is sent for a
binding that had no listed path and whose stream the executor's
result holds.

- **`apps/base/family-member.tsx`** has 5 committed events where it
  had 1, and 42 of 48 values equal where it had 14 of 16. Its 6
  differences are the 2 it had, at one position of the tree, read
  again after each of the 4 added events.
- **`apps/base/person.tsx`** has 6 committed events where it had 1,
  and 56 of 63 values equal where it had 16 of 18. Its 7 differences
  are the 2 it had, at one position, read again after each of the 5
  added events.
- **`dev/gideon-tests/test-pattern-composition-index-based.tsx` and
  `dev/gideon-tests/test-pattern-composition-shared-cells.tsx`** have
  3 committed events each where each had 2, and 12 of 12 values equal
  where each had 9 of 9. The third event of each, of
  `removeItemByIndex` and of `removeItem`, was not sent before.

That is 11 more committed events, 83 more values compared, 74 more
equal, and 9 more that differ. The 9 are differences that the modules
had, read again after the added events, and no new difference.

- **Against the `again` form of the earlier commit,** four more
  modules have other figures, by the form of the file alone:
  `dev/catalog/catalog.tsx` has 8 of 8 values equal where `again` had
  6 of 8, `dev/catalog/stories/cf-code-editor-story.tsx` 22 of 22
  where it had 20 of 20,
  `dev/self-reference-test/self-reference-test.tsx` 7 of 10 where it
  had 7 of 9, and `system/profile-create/profile-create.tsx` 17 of 18
  where it had 16 of 16.
- **No module is worse:** none has a value that differs at a position
  where it was equal, an event that is not sent or not handled where
  it was, or another reason for not being executed.
- **The rulings on a spread child, on a state path of plain type, on
  what a re-key moves, and on the key changed nothing in the corpus.**
  A run of the crate and the executor at the commit that drops the
  listed result paths alone has every module with the figures of the
  final run.
- **Events.** The 10 that are not handled are the 10 of the earlier
  commits.
- **Modules not executed.** The 19 are the 19 of the earlier commits.
  The one difference between `run` and `again` is the reason for
  which `showcase/battleship/multiplayer/room.tsx` is not executed:
  an output that no value function computes in `run`, and a name
  that value code does not bind in `again`. The executor alone, in a
  process in which today's runtime did not run, gives the reason of
  `again` for the argument as generated and for the argument read
  back from JSON, so the difference is in the state of the process
  in which today's runtime ran and not in the file. That is not
  examined further.
- **What the executor counted.** 4,200 evaluations, 1,126 of them of
  a cone instance of an element body, and 544 assemblies, with every
  write of a handler covered by a write edge or an envelope.
- **Documents.** Of the 802, 290 are state cells, where the run of
  the earlier commit had 281.
- **No plan of the corpus** has a child with `asInstance` or a
  collection with `keyField`.

### The corpus at commit `7774ba208c`

The figures of this section are from the prototype author's run, as
the prototype's note 430 gives them. They were not computed again for
this plan; the coordinator of this work ran the prototype's tests and
fixtures again and not the corpus. The run is a fresh seeded run of
today's runtime over all 272 modules (`values-corpus.ts run`), with
the crate and the executor of this commit, followed by the executor
alone on the file of that run (`values-corpus.ts again`). The report
of each command is, line for line, the report of the same command at
commit `a462df710a`.

| | `a462df710a` | `7774ba208c` |
| --- | ---: | ---: |
| Modules run by today's runtime | 215 | 215 |
| Executed | 196 | 196 |
| Every value equal and every event handled | 171 | 171 |
| Values compared | 5,498 | 5,498 |
| Values equal | 5,414 | 5,414 |
| Values that differ | 84 | 84 |
| Modules with a difference | 22 | 22 |
| Committed events the executor does not handle | 10 of 486 | 10 of 486 |
| Positions of the results that hold a stream | 726 | 726 |
| Documents the executor stored | 802 | 802 |

Every figure is identical to that of commit `a462df710a`. The
prototype's author read the two results files module by module, on
every member of the comparison: the values compared and equal, each
difference with its path and both values, the events that are not
handled and not sent, the reason for not being executed, the
executor's counts, its documents by kind, and the stored streams.

- **One module has another record, `apps/base/contacts.tsx`,** and it
  is better or worse in no figure. It has 17 differences in both
  runs, and three of them, those of `$UI` after the first three
  events, name another first path. The prototype's author traced that
  to today's run and not to the crate or the executor. Today's run
  stores the records of the rows of that `map`, which is over an
  array of references, with their members in another order in the
  runs of this round, `children` before `props` where the earlier run
  had `props` first. The row differs at its `style` and at a child,
  and the comparison names the first of the two that it reads. The
  values that today's run recorded are the same in both files once
  the members are put in one order, and a run of that module with the
  executor of `a462df710a` gives the new order too. Why today's run
  gives another order of the members was not examined.
- **The executor alone on the earlier file** (`values-corpus.ts again`
  with the crate and the executor of this commit, on the results file
  of the run at `a462df710a`) gives every module the record it had
  there, with no difference in any member.
- **The rulings on a key that names its fields and on several key
  fields, the two diagnostics, and the removal of a replaced instance
  changed nothing in the corpus.** No plan of the corpus has a
  collection with `keyFields` or a child with `asInstance`, and no
  type of the corpus uses `KeyedBy`.
- **Events and modules not executed** are those of the earlier
  commits. `run` and `again` differ in the reason for which
  `showcase/battleship/multiplayer/room.tsx` is not executed, as at
  commit `a462df710a`.
- **Two runs.** The first run of this round was made while the
  comparison of labels ran in a second process, and a second run was
  made alone. Both have the same report and the same record for every
  module.

### The comparison of labels and the cost measurement at commit `7774ba208c`

Both were run once over the corpus at this commit, with the executor
beside today's run so that the harness finds each stream (the
prototype's notes 427 and 428). The figures are the prototype
author's and were not computed again for this plan. In each table the
left column is the last figure this plan held, which is of an earlier
state of the corpus, the crate and the harness. The two columns are
therefore no comparison module by module, none was made, and what
each difference between the columns comes from was not examined.

**The comparison of labels** (`compare/corpus.ts run` and `report`),
in the default order of the events: 272 modules attempted and 215
run, with 33 that need `wish`, 14 that request an effect, and 10
whose run fails on a refusal of Contextual Flow Control. The left
column is of prototype commit `4ca9fe56cb`
([Where the work is](#where-the-work-is)).

| | `4ca9fe56cb` | `7774ba208c` |
| --- | ---: | ---: |
| Outputs compared | 1,388, 125 bounds | 1,453, 156 bounds |
| With the atom of a kept output: tighter | 1,267 | 1,330 |
| With it: the atom names the pattern | 121 | 123 |
| With it: looser, incomparable | 0, 0 | 0, 0 |
| Write edges compared | 231, 1 bound | 224, 1 bound |
| Equal | 219 | 214 |
| Tighter | 12 | 10 |
| Looser, incomparable | 0, 0 | 0, 0 |
| Bindings of a handler: no step, `site`, `element` | 266, 314, 71 | 274, 314, 74 |
| Events committed | 344 | 486 |
| Events refused | 15 | 49 |
| Bindings that got no event | 18 | 127 |

No row is looser or incomparable. Of the 10 tighter write edges, 8
are of handlers bound in no element body and 2 of handlers of an
element body, by the join of the `map` coordinator's transaction. The
127 bindings with no event are those whose stream the executor's
result does not hold: 64 bound in no element body, 35 in a pattern
compiled in, and 28 in an element body. The 49 refused events are in
10 modules, 37 of them for a missing input of the trusted-event
policy. No results file of this comparison at commit `a462df710a`
exists. The plan does not tell an element body over an array of
references from one over an array of plain values in place, so the
counts of bindings with an `element` step are of both, and of bodies
over the result of another per-element construct.

**The cost measurement.** Every command of `compare/cost.ts` ran once
over the corpus, and `compare/cost-report.ts` printed its tables:
`run` (179 s), `scale` (48 s), `closures`, and the crate's `time`,
`compile` and `processes`. The left column is of
[What compiling, running, and storing cost](#what-compiling-running-and-storing-cost),
at 270 modules compiled and 213 run. Times are wall time in
milliseconds, totals over the modules.

| | `4ca9fe56cb` | `7774ba208c` |
| --- | ---: | ---: |
| Modules compiled, and run | 270, 213 | 272, 215 |
| Compile in one process: the crate, median of 20 | 5,104 | 4,833 |
| Compile in one process: today, first compile | 91,115 | 102,945 |
| Compile, one process per module: the crate | 6,651 | 7,010 |
| Compile, one process per module: today | 381,950 | 436,953 |
| To settle, today: milliseconds | 21,566 | 17,520 |
| To settle, today: transactions committed | 1,461 | 1,480 |
| To settle, today: runs of an action | 4,343 | 4,281 |
| To settle, derived for the compiled path: transactions | 426 | 430 |
| Committed events, and the modules that have one | 344, 104 | 486, 96 |
| Per committed event, today: milliseconds, median | 26 | 57.3 |
| Per committed event, today: transactions | 1,175 | 1,221 |
| Per committed event, today: runs of an action | 1,605 | 1,609 |

After the instance settled, today's run stored 5,926 documents of the
instances and 9,848 label entries for the 215 modules. The derived
count for the compiled path is 470 documents at least and 1,700 at
most, with 215 label entries where every label is empty and 3,297 at
most. The median ratio of today's later compiles to the crate's, per
module, is 262.

- **The times were taken on a machine that was not idle.** A session
  that edits the documents worked in another tree of the repository
  at the same time. So the times are no repeat of the earlier
  measurement, and no conclusion about a change of a time is drawn
  from them.
- **The events are 486,** the number that the comparison of values
  commits.
- **`cost.ts` gives the executor no artifact for a pattern that a
  function body instantiates,** so a module with such a call is run
  beside an executor that cannot make the instance.
- **No time of the compiled path is measured,** as before.

### What the run conformed to

The executor counted where its run kept to the plan.

- **Reads of another cone's output.** Every one was over an edge of
  `Plan.edges`.
- **Writes of a handler.** All 291 were covered by a write edge or an
  envelope of the handler's body.
- **Reads of a slot the reading cone does not list.** 165, of which 141
  are in two modules that hold an array of pattern results, and 29 reads
  by root and path. Statically the emitter found 76 reads over the 361
  corpus patterns that no slot of the reading cone names, 55 of them of
  the result of an operation, which the comparison does not run. The
  reads in the two modules are of the third departure above.
- **Streams.** Of the positions at which a stored result holds a
  stream, 431 are named by a path of `Binding.result` and 18 by none.
  Of the listed paths without `*`, 315 hold the stream and 12 do not.
  13 of the 18 are of a binding for which the crate listed no path: 6
  of a member written after a spread among the children of a view
  node, and 7 of a stream inside a value that the elements of a
  collection hold. 2 hold a stream that is an input of the pattern,
  and 3 the stream of a binding that a function body makes and
  returns. A further 208 positions, of a stream inside a member of an
  element read as `example[UI]`, were in no count, because that run
  stored a record in the place of the stream. Each of the 12 is below
  a conditional whose other branch is selected when the run ends: 4
  held the stream at an earlier point of the run and 8 at no point, by
  a reading of the source that covers one branch alone for 5 of them.
  By ruling the value code places a stream and the runtime
  checks the position against `Binding.result`, so the listed paths
  have to be complete: the 13 and the 208 are positions the compiler
  owes a path for, and an evaluation that stored one of them fails.
  The 2 are no binding's stream, are passed on as any input is, and
  are not checked. The 3 are allowed and not checked, by ruling
  (question 165).
- **A cone that writes a cell it reads.** 6 evaluations wrote a
  position they had read. The executor evaluates such a cone instance
  once, as the prototype observed today's runtime to do. By
  `execution-and-storage.md` §2.7 such a cone instance is stale again
  by its own write, and one that does not settle ends in the error
  state at the bound of ten evaluations. That is a difference from
  today that the corpus has, and it was not run.
- **What the plan lacked.** 38 of the 446 cones of an element body list
  no slot of root `element` or `index`; by ruling the record of a cone
  lists the collections it is written in, and such a cone has an
  instance per element key as every other cone of the body has. 355
  uses of a
  body that is no handler have 1,093 slots whose place in the argument
  the crate's plan does not give; by ruling each entry of `Body.reads`
  holds it. Of 1,399 state cells with a function for their first
  value, 3 read a slot, through no cone; by ruling such a first value
  is computed by a cone and written through a write edge. 200
  state entries of bindings hold `null` for a constant that is not a
  literal written at the binding, which is a defect of the crate.

The plan of commit `96f3b83a73` has more of what was lacking. The
counts are over all 382 corpus patterns, the ones with an
unsupported construct included.

- **The place of a slot.** The corpus plans have 6,179 entries of
  `Body.reads`, each with its place, 1,314 of them in the 602 uses of a
  body that is no handler. The executor builds the slot part of an
  argument from the plan alone. Two inputs of a use bound to one place
  give two entries with one slot, and an entry whose place holds `*` is
  not placed by the executor: the container is given whole by the
  entry at the container's own path.
- **A path a call leaves out.** The corpus has 72 names declared with a
  default of the callee, for a path the call leaves out or writes a
  constant at. Of the 410 state entries of bindings that hold a
  constant, 144 hold `null`, where the earlier commit had 200. Value
  code of a callee reads a slot with the callee's default at 49 reads,
  and passes a sandboxed body a list of places with their defaults in
  27 uses of a body, where the ruling has the entry of `Body.reads`
  hold the default (question 152). The crate applies the default to a
  name the callee's parameter destructures and where the call writes
  its argument as a record, and in no other form; both limits are the
  prototype's.
- **The first value of a state cell.** Of 1,496 state cells, 1,473 have
  a constant first value, 15 have none, and 8 have one that is not a
  constant. None of the 8 reads a slot or an output of another cone:
  the value is a call, a record written in the pattern body, or a
  member of a module constant, which the crate does not evaluate.
  Where the declaration writes no type argument, the schema the crate
  gives the cell is the default alone, a limit of the crate.
- **The kind of a cone with side-writes.** Of the 3,717 cones, 14 have
  a small, fixed set of write targets, 13 of them a state cell and 1
  the cell of a handle at a slot, and 33 are materializers, each a
  `lift` that creates a cell under a cause computed from data and
  gives it a value. The 187 executed modules have 6 and 19 of them.
  The writes that expression code makes, a stored request and a first
  value, are not counted. The crate's plan holds the kind as a member
  of the cone and holds a materializer's body in a cone. The documents
  have neither: the kind is read from `Cone.writes` and
  `Plan.operations`, and a materializer is in no cone
  (`plan-and-label-templates.md` §3.11).
- **Streams.** The result holds a stream at 425 positions that a listed
  path names, where the earlier commit had 431, and at 18 that none
  names. The 6 fewer are in three modules,
  `apps/contacts/contact-book.tsx`, `examples/map-demo/map-demo.tsx`
  and `examples/todo-list/todo-list.tsx`, 2 each: the fix of the
  container copy made a handler's `remove` find its element, the list
  has one row fewer when the run ends, and a row holds the stream of
  its binding at two positions. The listed paths that hold the stream
  were 315 before and after.

At commit `59055fd0c5` the plan and the run have the following. The
counts of plans are over all 382 corpus patterns.

- **The collections a cone lists.** `Cone.within` is a member of the
  crate's record, with the `element` step of each element body around
  the cone's code, outermost first, and the `site` step of each pattern
  compiled in. Of the 3,717 cones, 576 have an `element` step, 60 of
  those list no slot of root `element` or `index`, and 1,336 have a
  `site` step. The record is the same over an array of references, over
  an array of plain values in place, and over the result of another
  per-element construct, where the cone names its own collection and not
  the upstream one. The executor takes from the `element` steps which
  instances of a cone exist.
- **Streams.** The executor gives value code an inert marker, writes the
  link in its place, and checks the positions of the result against
  `Binding.result`. With the crate as it was, 12 evaluations in 8
  modules failed the check. The crate lists a path for a member written
  after a spread, in the children of a view node and in an array
  literal, and for a stream inside a member of an element, over an array
  of plain values in place and over the result of another per-element
  construct; over an array of references the plan knows no stream inside
  an element. 1,142 of the 1,355 bindings of a handler have a `result`
  member, where 823 had one, and they list 1,420 paths, where they
  listed 1,012. Of the 202 bindings of an element body, 181 have a path,
  where 127 had one. No evaluation of the corpus run fails the check.
  The crate still evaluates `x[UI]` as a chosen child, which is a defect
  of the prototype: the key is static.
- **`reduce`.** The 9 `reduce` operations of the corpus are all
  registered with a function for the initial value and one for the step.
  The fold is not kept per key, so one changed element evaluates every
  step.

At commit `77993077e4` the plan and the run have the following, over
the corpus.

- **A record written into a list.** 64 documents of a record that a
  handler wrote into a list exist after the scenarios. Each such list
  is an array of references.
- **A reference by key.** A reference to an element that is a plain
  value in place holds the key at the array and the path below the
  element, and the store finds the position that holds the key at
  each read and each write. The key holds the value with no salt, a
  limit of the prototype. An element of a `map` or `flatMap` result
  whose body computes a value is passed on as that value, because the
  executor stores no assembled result at an address of its own
  (question 161). Value code calls the host's `equals` with each
  operand as the reference it is, at 18 calls (question 171).
- **A derived collection passed on.** 27 outputs in 15 modules have
  the mark `Output.passesCollection`. A `computed` with a block body
  that returns the result, and a result path of a sandboxed body that
  passes its input on, have no mark; both are limits of the
  prototype. The mark is the same whether the upstream source holds
  references or plain values in place, since the plan does not say
  which.
- **The callee's default.** 51 entries of `Body.reads`, in 9 modules,
  hold a default, and 78 entries of `Binding.state` hold one (question
  158). Value code of a callee hands the host a reference with the
  callee's default 42 times (question 169). Where code of the caller
  names a path of the callee's result that passes the path on, the
  crate writes a read of the caller's slot with no default, which is
  a defect of the crate.
- **A first value.** A member of handle type of a first value that is
  not a constant is stored as a value, where
  `execution-and-storage.md` §4.1 assumes a link (question 155): a
  limit of the prototype.

At commit `e63b3d305c` the plan and the run have the following. The
counts of plans are over all 382 corpus patterns.

- **The kinds of a `*`.** An entry of `Binding.result` is a path with
  one kind for each `*`. Of the 1,420 listed paths, 448 have a `*`,
  and their 476 `*` are 215 `inside`, 207 `element`, 51 `member` and 3
  `every`. In every path with a `*` the number of `element` kinds is
  the number of `element` steps of the binding. The kinds are the same
  whether the collection is over references or over plain values in
  place, since the plan does not say which. The crate counts a child
  written after a collection among the children of a view node as
  kind `member`, with the children stored flat; by the ruling since,
  such a child has a static position and no `*`, so the 51 are an
  upper bound on kind `member`. The executor accepts a marker by the
  kind, from the origin it keeps for each position of an array it
  assembled.
- **Where the kind is not determined or not right.** The crate states
  `element` at the result of a `flatMap` for a binding of the upstream
  body, and the executor compares the upstream key with the composed
  one and would refuse; by the ruling since, the match is a prefix. No
  pattern of the corpus has the case. The crate records the streams of
  what a callback returns for a `map` alone, so a stream inside an
  element that a `filter` passes on has no listed path: a defect of
  the crate, with no case in the corpus run. An array assembled from
  entries that is spread into another keeps, for each position, the
  kind it has in the inner array (question 182).
- **Which output keeps its value.** Where a marker fails the check,
  the executor puts back the stored value at the kept entry of
  `Plan.outputs` with the longest path at or above the position, for
  a cone of an element body the row alone, and leaves a position that
  no entry is above as it was. By the ruling since, the unit is the
  top-level property of the result. The stored value that is put back
  is the one at the same position, so where the element moved in the
  evaluation that fails, the row keeps what another key had stored
  there: a limit of the prototype, which stores a result by position.
- **A stream handed to a body.** The crate records nothing for a
  stream bound to a formal of a body, so `Body.computed` has no entry
  that says the position holds a stream (question 179). The executor
  hands the body a handle to the stream wherever a marker is in the
  computed argument.
- **The key of a `flatMap` member.** The member part is formed by the
  rule for any array, with the count among the members of the one
  segment, after the source key. A member that is a plain value in
  place of a stored array that the callback passed on is named by
  that array and its key in it (question 180). A segment that is the
  assembled result of another per-element construct has the keys of
  that result, with no test. A member the callback computes has no
  address and is passed on as its value.
- **The record of a key.** The plan holds no record that names the
  record of a key: the body has a write edge and an envelope with
  target `handle` at `*` below the list, and the executor uses the
  path for a count alone (question 181).
- **The identity of a pattern in value code.** The marker of each
  `pattern(...)` in the text of a module holds the identity of the
  pattern, the entry that the pattern's own `Plan.patterns` begins
  with, and an artifact holds the text of every module its code
  imports. The output of the crate for one file holds the artifacts
  of that file alone, so a callee from another file is found only in
  the output for the corpus.

At commit `e4f2fb3431` the plan and the run have the following. The
counts of plans are over all 382 corpus patterns, and the counts of
the run are from the prototype author's corpus run.

- **The children of a view node.** The crate gives each child one
  position, counted over the children as written, and a child that is
  a collection is the value of that collection at its position. The
  paths of `Binding.result` through it are `children/<n>/*`, and a
  child written after it has an index of its own. The entry of a
  rendered tree at `children/<n>` is the membership of the
  collection, and the entries of an element are those of the
  collection's own outputs, so the tree has no entry at `children/*`.
  The record is the same over an array of references and over an
  array of plain values in place, which the plan does not tell apart,
  and over the result of another per-element construct. The crate
  makes one child of a spread child, of an array literal among the
  children that itself has a spread or a hole, and of an expression
  of array type that is no collection (question 187). In the reactive
  tier value code writes each child as written, with the members of
  an array literal that has no spread as children of their own; a
  view node that a function body builds is written with a factory
  that flattens the arrays the body hands it, as today's `h` does
  with real arrays. The executor stores the children as given.
- **The kinds of a `*`.** 1,143 of the 1,355 bindings of a handler
  have a `result` member and list 1,421 paths, and 181 of the 202
  bindings of an element body have one. 411 paths have a `*`, where
  448 of 1,420 had one, and their 425 `*` are 215 `inside`, 207
  `element` and 3 `every`. No path of the corpus has kind `member`:
  the 51 of the earlier commit were all children written after a
  collection. The kind stays for an array value with a spread, which
  a fixture has. In the run, 690 stored positions hold a stream at a
  listed path and 31 at none; a listed path without `*` holds the
  stream at 344 and holds none at 13, where the run of commit
  `e63b3d305c` had 339 and 12, since a child written after a
  collection has such a path.
- **Kind `element` at the result of a `flatMap`.** The crate lists a
  path for a binding of the callback's body, with a `*` of kind
  `element` at the result, and leaves the position in a segment that
  the callback writes as an array literal out of the path. The
  executor accepts a position whose key is the key of the marker or
  begins with that key and the separator. Where the callback returns
  the result of an inner `map` whose body binds the handler, the
  crate lists `*/*` with two kinds `element`, which no position of
  the stored result has (question 188).
- **Which property keeps its value.** For each marker at a position
  that no listed path covers, the executor leaves the top-level
  property of the result as it was stored and stores every other
  property. It records the property, the binding and the position,
  and the next evaluation that stores the property clears the
  record, as `execution-and-storage.md` §2.2 assumes. It keeps the
  memo entry as before. No evaluation of the corpus run fails the
  check.
- **A function body's copy.** A read through a handle, with `get` or
  `sample`, gives a plain value in place as a copy that carries no
  address. Writing it to a cell stores the value, and writing it into
  an array stores it in place; the executor makes no document for
  the copy of a record, where it makes one for a record the body
  wrote. A member of the copy that is a link is the value of its cell
  and carries that cell's address, so over an array of references a
  body moves links as before. `remove`, `removeAll` and `addUnique`
  find a member by the position that a reference names, and a copy by
  its value. Whether today's runtime keeps such a copy in place or
  gives it a document was not measured; the values are the same
  either way. A handler bound in an element body whose state declares
  a data type for its element is handed a stand-in that carries the
  reference by key (question 189).
- **A handle by position and `equals`.** A handle from `key(i)` names
  the position, at the call and when stored, in each of the three
  cases. The executor resolves each operand of `equals` to the
  position it names at that time and compares there. It records the
  links each reference crossed and the outcome, and no position, so a
  move evaluates nothing for a comparison of two references by key.
  What the comparison gives where the parent cannot be read does not
  arise, since the executor reads every document (question 174). A
  read through a handle whose type declares the members as handles
  gives a handle by key for a member that is a plain value in place
  (question 189).
- **A re-key.** The executor records, for each key that the path of
  a write crossed, the key that the position holds after the write
  where it is another one. Until the transaction ends it finds a
  changed key under the key the element has now. When the handler
  returns, or at the next settling for a write from outside a
  handler, it moves the state cells of the old key to the new key,
  in the body over the array and in the bodies over the results of
  the constructs applied to it, drops the cone instances of the old
  key, and re-keys an `asInstance()` instance. A handler that throws
  moves nothing. Question 190 has the four things that the ruling
  does not name. The case is an array of plain values in place.
- **A `push` below an empty argument path** starts from the default
  nearest the end of the links that the handle resolves through, or
  from that of the handle's declared type. The executor does it for
  `push` alone: a `set` of one member below an empty path of the
  argument starts from an empty record, where the ruling on a write
  below the root of a cell covers any write. No case of it is in the
  corpus run that was examined.
- **The place of `[SELF]`.** The state entry of a binding that
  captures the name has `place: { result: true }`, the capture `link`
  and the template `const`. The crate knows the name by its spelling
  in the pattern being planned and not by its scope, and gives a
  pattern compiled in the result of the enclosing instance for its
  own `[SELF]`. No state entry of the corpus plans has the place.
- **`asInstance()` in the plan.** The checker accepts the modifier
  where it accepts `asScope` and `inSpace`. The crate records a call
  whose callee it can see as an entry of `Plan.children` with
  `callee: { compiled }`, `asInstance: true`, `name` and the `within`
  of the site, one write edge with target `argument` for each path
  of the argument, and a slot of root `child` for each read of the
  result. Nothing of the callee is in the enclosing plan. The record
  has the same form in each of the three cases and outside an
  element body (question 177). The hash is a placeholder; the record
  has no `argumentSchema` and no `resultSchema`; `name` is the name
  of the enclosing construct, so two calls in one body are told apart
  by their index; a call that composes the modifier with `asScope` or
  `inSpace` is recorded with neither scope nor space; and a call
  through the modifier of a factory value is reported as
  unsupported. No pattern of the corpus calls the modifier, and no
  plan of the corpus has such a child.
- **`asInstance()` in the executor.** A read of a slot of root
  `child` evaluates the argument for the element keys of the reading
  cone instance, makes the instance of the callee's plan where none
  exists for the child and those keys, writes the argument where it
  changed, and gives the reader the reference to the result document.
  When the key leaves, the memo entry of that evaluation is dropped
  and nothing is written. An event for a stream of the instance is
  routed by the name of the instance and handled whether or not the
  key is in the collection. For a binding of an element body with no
  modifier the executor refuses an event whose key no element table
  holds; before, an event sent through a stored link to such a stream
  ran the handler with no element, a defect of the executor. The
  identity is a table from the child and the keys to the instance,
  and the documents are named with the key the instance was made
  under (question 178). Nothing removes an instance.
- **`KeyedBy` in the plan.** The checker reads `KeyedBy<T, "field">`
  as `T` with an annotation, so for assignability it is `T`. The
  schema of the items has the keyword `keyField`, and the record of a
  collection has `keyField` where its source is a slot or an output
  and none where its source is another collection. The crate does not
  check that the field is a required property of type `string` or
  `number`, and accepts the marker on an array that holds references
  (question 186). No type of the corpus uses the marker, and no
  collection of the corpus plans has `keyField`.
- **`KeyedBy` in the executor.** The element part of the key of a
  plain value that holds the field is the name of the field and the
  canonical form of the field's value, with the occurrence count
  after it; an element that lacks the field is keyed by its whole
  value, and a position that holds a link by its cell. The key names
  its field, so a reference by key is resolved with no schema
  (question 191). An element of a plain array generated from scratch
  has no place, so a reader depends on what the element of its key
  holds at the path it reads. The key holds the value with no salt
  and no hash. A reference by key that a read outside the element
  table makes, for a container that a cone passes on, is formed from
  the whole value also where the array declares a field, and the
  members of a segment of a `flatMap` are keyed with no declared
  field: both are limits of the prototype. A write to the key field
  itself re-keys the element, by a reading of the code with no test
  (question 184).
- **A literal argument of a call of a pattern compiled in.** Of the
  410 state entries of the corpus plans that hold a constant, 142
  hold `null`, where 144 did.

At commit `a462df710a` the plan and the run have the following. The
counts of plans are over all 382 corpus patterns, and the counts of
the run are from the prototype author's corpus run.

- **No result path in the plan.** The crate records no stream
  position: the paths, the kinds `element`, `every`, `member` and
  `inside`, the order of the members of the returned record, and the
  count of the bindings of an element body with no path are gone. A
  binding has `handler`, `state`, `name`, `within` and `eventSchema`.
  Of the 1,355 bindings of a handler, 202 are in an element body.
  `Binding.within` has one `element` step for each enclosing
  collection, and the `site` step after the `element` step for a
  pattern compiled in at a tag of an element body. Value code writes
  an array literal with a spread as an array literal, with the
  members of each spread operand read through a function that gives
  none for an operand that holds nothing. The record is the same over
  an array of references and over an array of plain values in place,
  which the plan does not tell apart, and over the result of another
  per-element construct.
- **No position is checked.** The executor stores a value with each
  marker replaced by the link to the stream of the marker's binding,
  for the element keys of the cone instance that called
  `host.stream`, wherever the marker is. Nothing keeps a stored value
  in place of a new one, and no evaluation fails for where a stream
  is. The replacement is made by the one function that stores a
  value, so it is the same for the result, for a state cell, for the
  argument of an `asInstance()` instance, and for what a handler
  writes; the tests have it for the result. The store records the
  position of each link to a stream that it stores, by document, and
  drops the record of a position that another value is stored at. In
  the run, 726 positions of the results hold a stream. Over an array
  of references and over an array of plain values in place, a binding
  of the element body is stored once for each key, at the row of that
  key, and the one stream of a binding made outside the callback at
  every element. Over the result of another per-element construct the
  link has the upstream key. In an array of plain values that is
  written in place in the pattern body, the element that holds the
  stream of a binding of a pattern compiled in holds the link inside
  its value.
- **A `flatMap` whose callback returns an inner `map` that binds a
  handler** needed no change of the executor beyond the removal of
  the check. Each position of the one level of the result holds the
  link with the key of the outer element and the key of the inner
  one, over a source of references and over a source of plain values
  in place, with a segment that is the result of another per-element
  construct in both.
- **The two points that the ruling leaves as assumptions** (questions
  192 and 193). Nothing in the crate read the list for a label: no
  template and no constraint named a path of `Binding.result`, and
  the comparison of labels read the list to find the stream of an
  event alone. The crate records a binding for every bound handler,
  whether or not a result path held its stream, and removes none, and
  the executor has a stream for every binding of the plan. So the
  prototype gives no case for either question, and neither is
  answered by it.
- **The key of a plain value with a declared key field.** The element
  part is `value:` and the canonical form of the value of the
  declared field, where the array declares one and the value holds
  it, and of the whole value otherwise. So a key formed from the
  field `id` with the value 7 is the key of a whole value that is 7.
  The store resolves a reference by key with the key field that the
  schema of the array declares for its items, and forms the keys of
  an array that it reads whole, or that an element table is made
  from, with the same field. It keeps the schema each document is
  stored under: the argument schema and the result schema of the
  plan, the schema of a state cell, and, for a document made with
  none, as the record a handler pushed, the schema of the first
  position that links to it, of the first link to it that holds one,
  or of the first read of it. The copy of the keyword in
  `Collection.keyField` is used for a plain array generated from
  scratch, whose elements have no place, and for a stored array that
  the store knows no schema for. Where a reader declares the element
  type with `KeyedBy` and the place does not, or the reverse, the
  executor follows the place. A reference by key that a read of a
  whole array makes is formed with the field, which it was not at
  the earlier commit. The key has no salt and no hash, and the
  members of a segment of a `flatMap` are keyed with no declared
  field. Each of these is about plain values: an array of plain
  values in place, a plain array generated from scratch, and the
  result of a `filter` and a `map` over it. Over an array of
  references the key is the cell. All of this follows a ruling that
  is withdrawn. By the ruling that replaces it the key names its
  fields, a reference by key is resolved with no schema, and no
  record of the schema an array is stored under is kept for it
  ([Decided](#decided)). The note asks which schema decides the key
  field of an array of plain values in place, and what a link by key
  to a member below the element holds so that its resolver finds the
  field. The ruling answers both: no schema decides, and the link
  needs nothing beside the key.
- **A state path of plain type, and a member handle read through a
  handle of handles.** The executor did both before the ruling, and
  four tests have them. Over an array of plain values in place, a
  handler that declares `stop: Stop` is given a reference by key, and
  `center.set(stop.position)` stores a reference by key with the
  member's path; a member handle read through a handle of handles is
  a reference by key. Over an array of references both resolve to
  the element's cell, and a member handle names the position that
  holds the link.
- **What a re-key moves.** The executor holds each instance that a
  function body made by its name, and on a re-key gives the instance
  of the old key the name of the new key. The instance keeps its
  documents and its streams, as an `asInstance()` instance does, and
  the body that runs again under the new key writes its argument and
  makes nothing. An instance that is named under the new key already,
  of a key that left, is replaced: it stays in the store and no name
  leads to it. Nothing moves for a binding that a function body made,
  nothing moves for another element whose occurrence count the write
  changed, and a `set` of the whole array re-keys nothing. Nothing
  removes the instance that was replaced, or the stream of the
  binding that the old key's run made. The case is an array of plain
  values in place with no declared key field; over an array of
  references the write changes no key and the instance stays.
- **A spread among the children of a view node.** The crate and the
  executor did what the ruling says before it. A JSX spread child,
  and an array literal with a spread or a hole, are each one child
  that holds a nested array, over an array of plain values in place,
  over the result of a `map` whose source holds references, and over
  an array of references. Value code reads the spread of an array of
  references as values, so the nested array holds the values of the
  elements and no links, which is a limit of the prototype.
  `deno lint` stops with an internal error at a JSX spread child, so
  the fixture is exempt from it.

At commit `7774ba208c` the plan and the run have the following. The
prototype at this commit has the marker `KeyedBy` on the element type
and the plain form of the key, a string with separators and an
escaping of its own; by the rulings since, the key is declared on the
array with `ArrayByKey`, and a key is a fabric value that the helpers
of `base/data-model` hash and write ([Decided](#decided)). Each
statement about a key is about plain values: an array of plain values
in place, a plain array generated from scratch, and the result of
another per-element construct where the upstream position holds a
value. Over an array of references the key is the cell, with or
without declared key fields, which one test of the store and one of
the fixture have.

- **The key of a declared key field names the field.** The element
  part of the key of a plain value that holds its declared key fields
  is the prefix `fields:` and the fields, each as the name, `=` and
  the value. A plain value with no declared key is keyed whole, as
  `value:` and the canonical form of the value. So the key of a field
  `id` that holds 7 is `fields:id=#7#0`, and the key of a whole value
  7 is `value:7#0`. The prefixes, the separators and the count after
  `#` are the prototype's, and none of them is the design: by ruling
  the element part of the first is a record of the names and one
  salted hash, that of the second is a hash, and the key is a record
  of the element part and the occurrence count. What the withdrawn
  ruling added is removed: the store keeps no schema for a document.
- **A reference by key is resolved from the key alone.** The store
  forms the keys of the array with the fields that the key names, and
  with none for a key that names none, and takes the position whose
  key is the key. It reads no schema: not that of the reference, not
  that of a link on the way, and none of the document. A write
  through a reference by key decides whether it re-keyed the element
  with the fields of the key it went through. Forming a key uses a
  declaration: an element table is made with `Collection.keyFields`,
  and an array that is read whole gives each member that is a
  container a reference by key formed with the key fields that the
  schema of the read declares. By ruling since, a reader whose type
  declares no key takes the fields from the schema that is traversed
  while the link to the array is resolved; the executor forms the
  keys of such a read from the whole value. By case:
  - **An array of plain values in place.** A reference to the element
    and one to a member below it resolve with no schema, after a
    write to another member, which re-keys nothing, and after a move.
    A stored link by key reads the same element through a reader
    whose schema declares no key, the key `id`, the key `name`, and
    both fields. The array read under each of those four declarations
    gives its first member four addresses, and each resolves to that
    member.
  - **A plain array generated from scratch, with a `filter` and a
    `map` after it.** The array is what a `lift` returns. Its
    elements have no place in the executor, so a handler of a row is
    given the value and stores the value and no link. The documents
    have the result of `fetchJson` as one stored document whose
    elements have an address, and the executor answers every effect
    as pending, so it runs no such array. The note asks whether an
    element of an array that a `lift` or a `computed` returns whole
    has a reference by key with the address of the output as its
    collection. By ruling since it has (question 206).
  - **The result of another per-element construct.** An element has
    the upstream key, so the key names the fields that the source
    collection declares, and nothing is resolved by a key of the
    result: the executor stores no assembled result at an address
    that a reference could name.
  - **An array of references.** A link to a cell holds no key.
- **Several key fields in the front end and the plan.** The checker
  reads the second argument of `KeyedBy` as a string literal type or
  a union of them, and annotates `T` with the names, each once, in
  the order of their code points. The schema of the items has the
  keyword `keyFields`, an array of the names, in the place of
  `keyField`: `["id"]` for one field and `["name", "owner"]` for
  `KeyedBy<Repo, "owner" | "name">`. The record of a collection whose
  source is a slot or an output has `keyFields` with the same array,
  and one whose source is another collection has none. By ruling the
  keyword is on the schema of the array and not of the items. The
  type does not tell an array of plain values in place from an array
  of references, and the crate accepts the marker on both. No type of
  the corpus uses the marker.
- **The diagnostic of a wrong declaration.** The crate reports
  `keyed-by:declaration`, an error at the marker, where the second
  argument is missing or has a member that is no string literal type,
  and where a field names no property of `T`, an optional property,
  or a property whose type is not `string`, `number`, a literal of
  either, or a union of those. Nothing is reported where `T` or a
  member of the union is a type the checker does not evaluate. The
  documents name the diagnostic `array-by-key:declaration`, and
  assume that a literal type counts.
- **One key across the fields, and its written form.** The element
  part is `fields:`, then the fields in the order of their names,
  each as the name, `=` and the value, joined with `,`, and the
  occurrence count after it: `fields:name=labs,owner=cf#0`. A `\`
  stands before each `\`, `,` and `=` of a name and of a string
  value, a number is `#` and its canonical form, and a string value
  that starts with `#` has a `\` before it. That was the form the
  documents proposed at the time, with values in the place of the
  hash. By the ruling since, the design has no such form: no
  separator and no escaping of its own (question 199). The names are
  ordered by code point, as the documents have it. The tests of the
  store, over arrays of plain values in place: three elements that
  share `owner` or `name` have three keys; the order in which the
  fields are given changes no key; each key resolves to its element
  from the key alone; a write to a member that is no key field
  re-keys nothing, and a write to one key field re-keys the element;
  two elements with the same values of both fields are occurrences 0
  and 1; and an element that lacks one field is keyed whole. Two
  things are the executor's choice: an element is keyed whole where
  a declared field holds a value that is neither a string nor a
  number, which the documents assume as well, and the values are
  held with no salt and no hash.
- **A value that declares one key, given where another key is
  declared.** The crate reports `keyed-by:mismatch`, an error at the
  value, where a value is checked against a declared type: an
  argument, an attribute of a tag that names a pattern, a returned
  value under a written return type, and an initializer under an
  annotation. The walk compares the two types through handles,
  arrays, the properties that both declare, and the members of a
  union, and reports the first position at which both declare key
  fields and the two lists differ. A position at which one side
  declares no key is no mismatch, in both directions, and the same
  fields written in another order are one key. The documents name
  the diagnostic `array-by-key:mismatch`. By case, as two tests have
  it. An array of plain values in place, or of references, which the
  type of a pattern input does not tell apart: an input declared with
  the key `id`, given to a pattern whose input declares the key
  `name` or both fields, to the state of a handler, to the argument
  of a `lift` result, and to an authored function, is reported, and
  given where a plain array type or the same key is declared it is
  not. A plain array generated from scratch: the result of a `lift`
  whose return type declares the key `id`, given where `name` is
  declared, is reported. The result of another per-element construct:
  the result of a `filter` has the element type of its source with
  its key, and is reported the same way. Four limits: an object
  literal or an array literal is checked member by member, so a
  mismatch is reported at the member that is not a literal; an
  assignment and the argument of a handle method are not checked; the
  walk stops at depth 6; and both identifiers are provisional in the
  crate's catalog. The note asks whether a value whose type declares
  no key is accepted where a key is declared, as the crate has it
  (question 205).
- **A stream after a spread, compared with today's runtime.** Under
  [The fixtures](#the-fixtures): today's runtime runs neither an
  array literal with a spread among the children of a view node nor
  a JSX spread child where a pattern's body writes it, so the ruling
  on a spread child has no run of today's runtime to be compared
  with in the reactive tier. In a `computed`, which today's runtime
  runs, 15 of 15 values are equal.
- **A re-key removes the instance that the moved one replaced.** The
  case is an array of plain values in place with no declared key, and
  an instance that a `lift` or a `computed` of the element body made.
  Where the instance of the old key moves to a name that an instance
  of a key that left has, the executor removes that instance: its
  argument document, its result document and its state cells, the
  record of its stream links, the instances and the bindings that its
  own function bodies made, and the names that lead to them. A link
  to one of its documents that is stored elsewhere reads as nothing,
  and an event for one of its streams finds no instance. Two things
  are not removed. An `asInstance()` instance that is named under the
  new key is replaced in the table of the instances and stays in the
  store, where a link that a handler stored elsewhere reads it; by
  ruling since, that is the design ([Decided](#decided)). And the
  stream of a binding that a function body made under the old key
  stays. Whether the removal of the instance that a function body
  made is the design is question 204. Over an array of references no
  key changes and nothing is replaced.
- **A `set` of a plain value on a cell that holds a link** writes
  through the link in the executor: `picked.set(value)` after
  `picked.set(reference)` wrote the value into the element that the
  reference named. The prototype's author found it while testing keys
  and did not examine it or compare it with today's runtime. The
  reference there was a reference by key to an element of an array of
  plain values in place.

### Documents

The executor stores an argument document, a result document, and one
document per state cell that exists, and counts a cell that a function
body creates.

| Documents after the scenario, 186 modules | total | per module |
| --- | ---: | ---: |
| executor, measured: all | 1,302 | 7.0 |
| executor, measured: argument documents | 186 | 1 |
| executor, measured: result documents | 186 | 1 |
| executor, measured: state cells | 898 | 4.8 |
| executor, measured: cells a function body created | 32 | 0.2 |
| today, measured: all, from the compile on | 9,700 | 52.2 |

For a fixture with no state cell the executor stores two documents, and
one more per state cell.

At commit `96f3b83a73` the executor writes nothing when it creates a
state cell whose first value is a constant, by the ruling, and the
first write makes the document. Over the 187 modules it then stores 504
documents, 2.7 per module, of which 98 are state cells, 0.5 per module;
over the 189 modules of the wider set, 509 and 99. At commit
`59055fd0c5`, over 194 modules, it stores 535 documents, 2.8 per
module; the 26 more include 5 state cells and 11 records of a key of a
list, which the executor stores as documents of their own (question
166). At commit `77993077e4`, over the same 194 modules, it stores 598
documents, 3.1 per module; 64 of them are records that a handler wrote
into a list, each a document of its own as in today's runtime. At
commit `e63b3d305c`, over 196 modules, it stores 615 documents for the
scenarios of the saved values, 3.1 per module, and 793 for the
scenarios of the fresh run, which send more events. The 17 more of
the first are 5 argument and 5 result documents of the 2 modules more
and of 3 instances that a function body made, and 7 cells and records
of theirs. At commit `e4f2fb3431`, over the same 196 modules and the
scenarios of a fresh run, it stores 793 documents again. At commit
`a462df710a`, over the same 196 modules and the scenarios of a fresh
run that sends 11 more events, it stores 802 documents, of which 290
are state cells where 281 were. The notes
give no
other row of the table for those five commits. The prototype's cost model
still counts one document per state cell, which is an upper bound under
the ruling, and the derived figures of [Storage](#storage) are not
computed again.

Today's figure includes the cells through which the scenario gives the
instance its inputs, one per top-level input. It is not the row "today,
measured: documents of the instance" of
[Storage](#storage): that row is over 213 modules, after settle, and of
the instance's own documents alone.

The executor's count is a lower bound on what the compiled path stores
for these scenarios, in this sense: it leaves out the part documents,
the state documents of operations, the stream documents, and the
instances document, which `execution-and-storage.md` §4.1 lists and the
executor does not make. The count of commit `3e518147df` is not a
bound on state cells. That executor
makes a document for every state cell when the instance is created or
the element key enters. By ruling a state cell whose first value is a
constant, or that is declared with no value, has no document until
something writes it (`execution-and-storage.md` §4.1), so the design
stores fewer state cell documents than that executor counted. The 98
of commit `96f3b83a73` are of the rule, for the scenarios run: the
cells that an event or a side-write wrote.

The derived counts of [Storage](#storage) stay the figures to compare
with today's, and the executor's count does not replace them. It bears
on them in two ways.

- **It is between the two derived bounds, on the mean.** The derived
  count is 2.2 documents per module at the least and 8.6 at the most,
  over 213 modules after settle. The executor has 7.0 over 186 modules
  after the events at commit `3e518147df`, and 2.7 over 187 modules at
  commit `96f3b83a73`. The module sets and the points in the scenario
  differ, so this is no check of either bound.
- **The "least" bound counts no state cell,** because the document of a
  state cell is written when the cell is first written. By ruling that
  holds for a cell whose first value is a constant as well. A cell
  whose first value is not a constant has a document once that value
  is written, and the least bound rises by the number of such cells
  whose first value has been written, which the derivation did not
  count. In the prototype's corpus 3 of 1,399 first values read a
  slot at commit `3e518147df`, and 8 of 1,496 state cells have a first
  value that is not a constant at commit `96f3b83a73`. The 4.8 state
  cell documents per module of the earlier commit count every state
  cell, so they are no measure of that term. The 0.5 of the later
  commit count the cells that were written, by an event or a
  side-write as well as by a first value.

## Rules of this work

1. **The owner's rulings are fixed.** The list under
   [Decided](#decided) is not reopened by an agent. A finding that argues
   against a ruling is reported to the owner with the evidence.
2. **A detailed document governs the overview.** Where they disagree, the
   overview is corrected.
3. **One document, one author at a time.** A document that needs something
   from another states its assumption and lists the request under its open
   questions. It does not define the other's content.
4. **A change to what Contextual Flow Control decides goes to the
   specification first.** A label rule that changes in
   `plan-and-label-templates.md` changes in specs pull request #91 in the
   same pass.
5. **Claims about the current system are verified against source** and cite
   a file with a function or section name, never a line number.
6. **FabriChat is the reference pattern** (`patterns/system/fabrichat/`,
   [`../specs/fabrichat/`](../specs/fabrichat/README.md)). Its eight source
   modules exclude `room-test-fixture.ts`.
7. **Before committing:** `deno task check-docs`,
   `deno task check-address-examples`, `deno task check-skill-facts`,
   `deno task check-cfc-correspondence`, and
   `deno task check-conflict-markers`. `docs/` is excluded from `deno fmt`,
   so prose is wrapped at 80 columns by hand. Read
   [`../README.md`](../README.md) first.

## Decided

Each ruling is written into the documents. This list exists so that none
is relitigated.

**Architecture**

- The language is a subset of TypeScript with its own compiler, written in
  Rust. The runtime's CFC kernel and scheduler stay in TypeScript.
- The compiler emits JavaScript value code and a data plan. There is no
  interpreted intermediate representation and no WebAssembly output.
- Trust in the compiler is unconditional and a property of the deployment.
  There is no per-user decision and no fallback label. For a module in the
  subset the compiler's statelessness check is the enforcement; the load-time
  verifier runs only on imported TypeScript modules.
- Execution is authoritative on the server. Clients speculate from the same
  compiled artifact, evaluate the same gates, and never request effects,
  with one exception: a client enacts `navigateTo` from its speculative run,
  reconciled with the server's result as it is today.
- One transaction per cause. A failed cone takes a labeled error state and
  the rest commits.
- A failed constraint on what a handler itself writes rejects the event's
  whole transaction. A failed constraint on a derived output drops that
  output's write alone: the output keeps what is stored, and the rest of
  the transaction commits.
- Several events are handled in one batch. Before a handler body runs, the
  stale cones it reads are evaluated, the ones an earlier event of the batch
  made stale included. Every other derivation the batch made stale settles
  once behind the batch, not once per event.
- A change of demand is a cause of its own, the fourth kind. It has a
  transaction of its own, which runs as the demanding principal.
- A conflict on a derived write withdraws that write alone, and the rest
  of the cause's transaction commits.
- A cone with side-writes is of one of two kinds. Where its writes go to
  a small, fixed set of targets that the compiler names, the cone is an
  ordinary node, and its write targets count as its outputs for demand:
  a demanded reader of a written cell demands the cone first, a reader
  that passes the cell on by reference included. Where the write set is
  dynamic or very large, the cone is a materializer: it is evaluated
  eagerly whenever one of its inputs changes, as a rule after the rest
  of the wave has been evaluated, and its writes make their readers
  stale, which a further wave evaluates.
- Each entry of `Body.reads` holds the path in the body's argument at
  which the slot's value is placed, as an entry of `Body.computed` does.
- Value code places the stream of a binding in a value it computes. The
  value function calls `host.stream(binding)`, a function of `ConeHost`,
  and puts the marker it returns at the position. The marker is inert:
  the function can place it in the value it returns and can do nothing
  else with it. It cannot send to it or read through it, so the rule
  that a cone's function holds no handle stands. When the runtime stores
  a value, it replaces each marker by the link to the stream of that
  binding for the element keys of the cone instance that called
  `host.stream`, wherever the marker is: at a position of the result, in
  the value of a side-write, or in a child's argument. That is the whole
  rule. No position is checked, and no evaluation fails for where a
  stream is. A binding record has no member that names where its stream
  is stored, so a reader that has the plan alone cannot say where a
  stream is, and reads the stored result. A stream that is an input of
  the pattern is no binding's marker and is passed on as any input is. A
  client runs the value code, places the marker, and stores the link it
  derived. The rule is the same in an element body over an array of
  references, over an array of plain values in place, and over the
  result of another per-element construct. A `flatMap` whose callback
  returns an inner `map` that binds a handler needs no rule of its own:
  each stored position holds the link that value code placed, in all
  three cases. This ruling withdraws five earlier ones, which govern
  nothing: that the plan lists the result paths of a binding
  (`Binding.result`) and the list is complete; that the runtime checks
  the position of a marker against the list; that a listed path states
  what each `*` stands for, by the kinds `element`, `every`, `member`
  and `inside`; that a `*` of kind `element` at a `flatMap` result
  matches by prefix; and which evaluation fails the check and that the
  top-level property of the result keeps its stored value.
- A collection among the children of a view node is stored as one
  nested child, as the runtime of today stores the result of a `map`.
  The collection is the child at the position `n` it is written at,
  and its elements are at `children/<n>/*`. The children array is not
  stored flat. A child written after the collection has a static
  position, and two collections among the children of one node are
  two child positions. The paths of `Plan.outputs`, of label entries,
  of provenance records and of split points follow. An array literal
  that the author writes among the children is still written out
  among them when the tree is built. The same for a collection over
  an array of references, over an array of plain values in place, and
  over the result of another per-element construct.
- A spread child, `{...xs}`, and an array literal with a spread or a
  hole among the children of a view node, are each one child at the
  position they are written at. The literal is stored as one nested
  array value. The same for `xs` an array of references, an array of
  plain values in place, and the result of another per-element
  construct.
- A stream that a function body returns into the result is stored as any
  reference that a function body returns is. A `lift` or a `computed`
  that returns a value holding the stream of a binding returns a
  reference and no marker, so reads through it are dynamic. The same for
  a body used in an element body over an array of references, over an
  array of plain values in place, and over the result of another
  per-element construct.
- A handling is identified by the receipt, which leaves the acting
  principal out.
- An event is routed to an instance that is not loaded through a stream
  index: one row per stream, from the stream identifier to its instance
  and binding. It stands in for the result back-links that
  server-primary execution follows today, and is read only when no
  loaded instance has registered the stream. How pending entries are
  found, the order of the queue, and what happens to an event that cannot
  be routed stay as they are today.
- A read of a cell whose writer is in an instance that is not loaded
  consults the scheduler's stored record of what is stale. Where the
  stored value is current the read returns it and the instance is not
  loaded. Only where it is stale is the instance loaded and the writer
  evaluated first.
- A cone is evaluated at most ten times in one transaction. The number is
  a placeholder, fixed with the plan version. A cone that failed at the
  bound is not evaluated again until one of its inputs changes.
- The identifier of a space that an `inSpace` request creates is obtained
  and not derived from the request. The allocation is recorded in a step
  that commits before the step in the foreign space, so that a retry
  names the same space.
- A handler's pending effect is requested again at activation after a
  restart, with the references followed and the egress ceiling checked
  on the content as it is then.
- Nothing in this design bounds an effect whose completion changes its
  own request, or a cycle across two spaces. They fall under rate limits
  in general, which this design does not specify. To be revisited.
- The scheduler is switched per space. A space runs the builder path
  with Scheduler v2 or the compiled path with this design's scheduler,
  never both. The two exist side by side only for validation, and the
  builder path is retired soon after.
- A client cannot read the element-key salt. It cannot name value-keyed
  per-element state, or a binding with copied captures, before the server
  stores a link.

**Language**

- Three tiers: reactive expressions, function bodies (`lift`, `handler`,
  `computed`, `action`), and imported TypeScript marked by the directive
  `"use typescript";`.
- `ifElse`, `when`, `unless`, and the `str` tag are removed. The compiler
  accepts them in the interim with a warning, only while that costs nothing
  beyond mapping each to the operation of `?:`, `&&`, `||`, and a template
  literal.
- `map`, `filter`, `flatMap`, `reduce`, `findIndex`, `some`, `every`, and
  `find` are reactive constructs. The callback of `reduce` is an expression
  and its accumulator is a data type.
- A collection method called on a cell handle in a function body, such as
  `aCell.map(...)`, is a compile error. The compiler does not rewrite it
  to a reactive form. The diagnostic names two corrections: wrap the
  expression in an inline `pattern(...)`, which keeps it reactive, or read
  first, `aCell.get().map(...)`, which processes the values synchronously.
- A handle type may hold a handle type: `Cell<Cell<T>>` is valid, and
  `get()` on the outer handle returns the inner one. `key(...)` flattens
  every handle it passes through, so `key` on a `Cell<{ a: Cell<T> }>`
  with `"a"` is a `Cell<T>`. The subset type checker gives `key` this
  type itself, and a pattern needs no overload or cast to state it.
- A function type is refused in data, with no exception for a type that
  describes a value probed for a method. A declaration says whether a
  value is a cell or is not.
- A default is static. A default named by `typeof` of a constant whose
  initializer is a call is refused. Two extensions are wanted later and
  are not designed: a default whose value the compiler can compute, and
  a default that is a link to another value.
- A handle of `T` is assignable to the same kind of handle of `unknown`,
  at the root of the value type. `Cell<T>` is not assignable to
  `Cell<T | undefined>`, or the reverse. `object` is a type of the
  subset, and a handle is assignable to it.
- In the reactive tier an argument of a pattern, a handler, or a `lift`
  result is bound by reference: a value stands for a handle of it and a
  readable handle for its value. An authored function called there is
  not, so its argument is `count.get()` and not `count`.
- A default belongs to the stored place. A callee bound by reference to
  a property that declares a default gets a link, not a copy, and the
  link holds the schema with the default, so the callee reads the
  default where nothing is stored, whether or not it declares one.
- Where the call of a pattern compiled into another leaves out a path
  for which the callee declares a default, the compiler writes the
  callee's declared default into the plan as a constant for that path.
  A path that the call binds to a slot of the caller at which nothing
  is stored also reads the callee's default, as it does today.
- The default read at a position is the one declared nearest the end
  of the chain of places the read resolves through, the stored place
  last. The reader's own default, a callee's included, is read only
  where no place along the chain declares one. So a caller's argument
  at which nothing is stored, or a bound cell, that declares a default
  wins over the callee's default. The runtime of today reads the same
  for a read addressed at a position: the top-level default of the last
  link schema along the chain that declares one (`resolveLink` in
  `runtime/runner/src/link-resolution.ts`, `combineSchemaForLink` in
  `runtime/runner/src/traverse.ts`). A schema on the handle that wrote
  the final document counts for nothing, because it is not stored.
- A sandboxed body of a pattern compiled into another finds the
  callee's default in the plan. The entry of `Body.reads` for a path
  that the call binds to a slot of the caller holds the default the
  callee declares for the path (`ReadInput.default`), and value code
  does not pass it. Where the callee passes such a path on by
  reference, the stored reference carries the callee's declared
  default. The rule that the default nearest the end of the chain is
  read then gives a reader of the callee's result the value the runtime
  of today shows. Both are the same inside an element body over an
  array of references, over an array of plain values in place, and over
  the result of another per-element construct.
- The name a pattern binds to `[SELF]` is a reference to the result
  cell of the instance. Passed on, it adds no label, as a handle passed
  on without a read adds none. A handler binding that captures the
  name holds, at that state path, a kind of place of its own in the
  binding record, which names the result of the instance
  (`Binding.state.place` with `result`).
- A read of a default carries no integrity. Where a stored object has
  an absent property and a default fills it, the defaulted part carries
  the empty integrity, not the object's claims. The specification has no
  rule for a default that is read and not stored, and needs this one.
  The read has less integrity than today, so it is the third
  deliberate exception to "equal to or tighter".
- Integrity is anchored in an object as a whole. A read of a stored
  object whole carries the object's integrity, also where a default
  fills one of its properties. A read that selects one property follows
  the rules for a selection, and a selected property that is a default
  carries none.
- `ifElse` and the container of a `map` are trusted in the sense that
  their result does not join the labels of all their arguments. The
  runtime joins the labels of a module's argument schema onto its
  result document, which widens both. The templates do not, and the
  comparison expects a template tighter than the runtime there.
- A write through a handle bound to a value the instance computes is
  refused. Where the value at the bound path is a reference to a stored
  place, as an element that a `filter` in a `computed` passes on or a
  handle that a `computed` returns, the handle resolves to that place
  and the write lands there. An argument given to a pattern that a
  function body instantiates is the initial value of the child's stored
  argument, and the child writes it freely.
- A promoted `computed` mints no `TransformedBy` for the code of its
  callback. Every output of a pattern carries a `TransformedBy` that
  names the pattern, because trust is attached to the pattern. That
  holds for a value the pattern only passes on, through a `slot`, a
  `select`, or a `pick`, as for one it computes. Where the value is
  passed on by reference, the atom is on the link, as the pattern's
  endorsement of the selection, and the target keeps its own label.
- A child in the reactive tier does not write an argument given as a
  literal or a computed value. The runtime allows it today. A pattern
  that changes or owns one of its arguments is given a writable cell
  for it, and the corpus patterns that rely on today's behavior are
  rewritten that way.
- A handle that a body passes on without reading through it adds
  nothing of the label of its cell to what the body writes. The label
  stays at the cell, as it does for a handle to a cell the body
  created, and reaches only a reader that follows the handle.
- The callback of a per-element construct is a pattern, and labels
  flow through it per value. Each thing the body is given has its own
  label: the element has the label of its own slot of the collection
  and of what that slot holds, the index and the whole collection
  have theirs only for a node that reads them, and each
  captured value has its own. A node of the body takes the labels of
  what it reads and closes over, and nothing of what another node of
  the same body reads. So a handler that closes over the element alone
  writes under the event and the element, also where another node of
  the body reads the index. Nothing of another element, and nothing
  of the collection's length or order, reaches a node that reads
  neither the index nor the collection. This is tighter than the
  runtime of today, which stores one join of the `map` coordinator's
  transaction on every path of an element's argument document.
- `elementById` yields a handle of the element type or `undefined`,
  because the record for a key may never have been written or may have
  been cleared.
- An argument bound by reference takes the declared type of its path. A
  condition that narrows the value does not narrow the handle, and `!`
  does not change the type of a place.
- On a value of type `unknown` the only test is against `undefined`. A
  `typeof` test does not narrow it, and a legacy key read for a string
  is declared `string`.
- A writable view wider than a place's declaration is refused, with no
  exception for migration code. An input that holds data of an older
  shape declares that shape.
- `typeof NAME` in a label argument, outside a writer or rule-set
  position, stands for the value of a module-scope constant with a
  static initializer.
- `any` is refused. Published label typings are identity aliases, and no
  editor plugin is part of the design.
- `streamData` and `llm` are removed. `wish` is structural.
- `patternTool` is removed in favor of a pattern closure: an inline
  `pattern(...)` in the reactive tier, used as a value, whose captures the
  compiler binds as private parameters.

**Calls inside a function body**

- Five kinds: instantiate a pattern, create a cell, request an effectful
  built-in, read context that is not a cell, and bind a handler.
- A `handler` or an `action` may instantiate a pattern and request an
  effect, and so may the body of a pattern a handler instantiates.
- A `lift` or a `computed` may instantiate a pattern, and that pattern may
  request effects. An evaluation that instantiates the same pattern at the
  same place names the same instance and updates its argument, and an
  instance an evaluation no longer makes is torn down. An effect in the
  instance is requested again when its request changes, as for any effect
  whose input changed.
- An instance made in a `lift` or a `computed` is identified by the
  enclosing instance, the body's name and the calls and callbacks it is
  written in, the site, and the ordinal of the instantiation among those
  the evaluation makes at that site, or by an explicit cause where the
  author writes `.for(cause)`. The compiler warns on an instantiation in
  a loop or a callback of a function body that has no `.for(cause)`. A
  `lift` or a `computed` does not request an effect directly.
- An explicit cause in a handler names the same thing on every event: a
  cell a handler creates under `.for(cause)` is one cell, with its
  existence label fixed at first creation. Without an explicit cause an
  identifier minted in a handler derives from the event.
- A function body may call two kinds of factory value: a pattern factory,
  which it instantiates, and a handler factory, which it binds. Both are
  resolved at run time from their own compiled records. A `lift` result is
  not a factory value.
- A handler binding made in a function body copies a scalar and a value
  the body computed. It binds a container that has a stored address by
  reference, as it is today: the handler reads the container when an event
  arrives, and a record the handler passes on links to the original. A
  binding made in the reactive tier copies nothing, the body of a
  per-element callback included: every path of the handler's state is a
  slot of the instance.

**Identity and storage**

- The keep set of an instance is everything reachable from its result cell,
  the rendered `[UI]` tree included. Interim values are not stored and not
  labeled.
- The keep set is stored in as many documents as serve its readers, not in
  one. A kept subtree, such as a row of a kept collection or a part of the
  rendered tree, can have a document of its own, linked from the result, so
  that a reader loads and subscribes to the parts it uses. One evaluation
  writes all the documents it changed in one transaction. The split can be
  fine, and the runtime decides it by a rule about size.
- A state cell's identifier derives from its cause, with the name taken from
  the assigned variable as the transformer's `.for(...)` does.
- A first value of a state cell that is a constant is the default of the
  cell's schema. Nothing is written when the cell is created, and a read
  of a cell that holds nothing reads the default, with the integrity of
  a default. A first value that is not a constant is computed by a cone
  and written once, when the cell is first created, through a write edge
  to the state cell, so the stored value has the label and the integrity
  of that run. Writing a constant first value at creation as well is
  legal and not required. A state cell with a constant first value has
  no document until something writes it. The owner named both forms and
  delegated the choice to the one of lower complexity; this is that
  choice.
- A write below the root of a state cell that holds nothing creates
  the document from the default with the write applied, so the members
  the write did not name stay readable. The members taken from the
  default keep the label of a default, which has the empty integrity.
  The same for a state cell of an element body over an array of
  references, over an array of plain values in place, and over the
  result of another per-element construct.
- A first value that is not a constant is always stored as a value and
  never as a reference, so a write to the cell never lands in the
  input the value came from. The same in all three cases of a
  per-element source, also where the first value is the element
  itself.
- A `map` element is keyed by its cell identity where the collection
  holds a reference, and by its value otherwise. In both cases the key
  also holds the count of earlier occurrences of the same identity or
  value in the collection, so two equal elements have two keys.
  The position is never in the key, also where the callback uses the
  index. The index is given to the nodes of the body that read it, so
  a move evaluates those nodes alone, and the state, streams, and
  children of the body stay with their element. A value-derived key
  is salted with a secret of the space.
- The label of the index is the label of the collection's own array:
  its length and which link each slot holds. It holds nothing of what
  the links point to, which is what a `findIndex` reads and the index
  does not. It is the label of the whole array, not of the slots up
  to the element's position. Where a position holds a plain value in
  place, the label has that the position holds something and of what
  kind, and not the value. For the result of a `filter` or a
  `flatMap`, the label is the membership of the result, which holds
  what every predicate read, joined with which reference each
  position of the result holds.
- A state cell declared with a value from the index keeps what it
  holds when its element moves, because the declared value is written
  at first creation only. A cell or child that a function body makes
  under an explicit cause that holds the index is named by the cause,
  so a move names another. A binding of a function body that copies
  the index is a stream named by the copied value, so a move names
  another stream.
- Everything an element body holds is per element key, and so per
  occurrence: its state cells, its streams, its effects, and its
  children. Equal elements share nothing. A body with no state of its
  own (no handler, no declared cell, no effect, no child) could reuse
  one outcome for equal values; the design does not special-case it.
  So a per-element body over plain values that declares a state cell
  is legal, and where two equal values stand in a collection and the
  first is removed, the state that remains is that of the first
  occurrence.
- The record of a cone lists the collections of the element bodies the
  cone is written in, outermost first (`Cone.within`). The runtime uses
  the list for two things. The first is which instances of the cone
  exist: one for each combination of element keys of the listed
  collections, made when a key is added and dropped when it is removed.
  The second is where an instance's outputs, state cells, streams,
  effects, and children are kept: under those keys. A cone of an
  element body that reads neither the element nor the index has an
  instance per element key all the same; it is not evaluated once for
  every row. The rule is the same for an array of references, an array
  of plain values in place, and the result of another per-element
  construct.
- When an element moves, the runtime moves what the element's key
  holds, its stored results included, to the new position. It evaluates
  nothing for the element except the nodes that read the index.
  Evaluating again is permitted, and moving is preferred.
- The removal of an element deletes nothing that is stored under its
  key. The cone instances of the key are dropped. Its state cells and
  its operation state stay stored, and an element that returns under
  the same key reads what its state cells held. That is as today, where
  the cells of an element are named from the key and an element that
  returns finds its old values. The rule is the same over an array of
  references, over an array of plain values in place, and over the
  result of another per-element construct. Reclaiming the storage
  would be a separate mechanism, and this design has none.
- An element of a plain array generated from scratch, which a `lift`
  or a `computed` returns whole and the instance stores as an output,
  has a reference by key with the output's address as its collection,
  by the same rule as an element of an array of plain values in
  place, with or without a declared key. Without a declared key the
  key is the whole value, so the reference reads as nothing once the
  element changes, and no write repairs it, since a computed output
  refuses writes. The owner gave the ruling weakly, with a
  reservation: "if all that hashing gets too complex for little gain,
  copies are fine". So storing a copy is acceptable if building the
  reference proves complex for little gain. The prototype stores a
  copy and is to report what the reference costs to build (question
  206). The ruling is about a plain array generated from scratch
  alone.
- An element that is a plain value in place is named by its collection
  and its key, and a reference to it or to a member of it resolves to
  the current position at each read and write. So `equals`, two-way
  binding, and a write through the element work, and a move still
  evaluates nothing. A cone that passes such an element on stores
  that reference, by the rule that a value passed on unchanged is
  stored as a reference, and no copy of the value. After the element
  is removed such a reference reads as nothing, which remains a
  difference from today. The case is an array of plain values in
  place, and the result of another per-element construct where the
  upstream position holds a value. Over an array of references a
  reference to an element is the link to its cell.
- A write through a reference by key that changes the value re-keys
  the element in the same transaction. The runtime moves what the old
  key holds to the new key and updates the reference that the writer
  holds, so the state of the row survives and later writes in the
  same handler succeed. References stored elsewhere under the old key
  still read as nothing, because the runtime cannot find them all.
  The case is an array of plain values in place; nothing of it arises
  over an array of references. Where such an array declares a key
  field with `ArrayByKey<T, "field">`, a write to another member
  changes no key, and nothing is re-keyed.
- On a re-key, an instance that a `lift` or a `computed` of the
  element body made moves as a child does, and nothing moves for a
  binding that a function body made. What is moved replaces what is
  stored under the new key. Nothing moves for the other elements
  whose occurrence count the edit changed. A write that is not made
  through a reference by key re-keys nothing. The case is an array of
  plain values in place with no declared key field, and a body over
  the result of another per-element construct applied to it; nothing
  of it arises over an array of references.
- On such a re-key, where a moved instance that was called through
  `asInstance()` takes the name that another such instance holds, the
  replaced instance is no longer named by the element table, and its
  documents stay in the store. Nothing is cleaned up, as when an
  element leaves, and a link to it that is stored elsewhere keeps
  reading it. The case is an array of plain values in place with no
  declared key; over an array of references no write changes a key.
  The ruling does not cover a replaced instance that a `lift` or a
  `computed` of the body made (question 204).
- A function body that reads a plain value holds a copy, and writing
  it elsewhere stores the value, as today. References by key are for
  the nodes of the reactive tier that pass an element on. A handle
  that a body is given for the element is a reference by key, and a
  value that the body reads through a handle is a copy. The case is
  an array of plain values in place.
- A value that a handler is given for its element through a state
  path of plain type, as `stop: Stop`, is a reference by key, and a
  member read from it, as `stop.position`, carries the reference with
  the member's path, so `center.set(stop.position)` stores a
  reference by key. A member handle read through a handle of handles,
  as `Writable<Writable<Item>[]>`, is a reference by key as well. A
  binding made in an element body copies nothing under either answer,
  because the reactive tier binds by reference, so the stream is the
  same stream when the data changes; the ruling decides what a value
  read from the state carries. The case is an array of plain values
  in place, and the result of another per-element construct where the
  upstream position holds a value; over an array of references the
  state path and the member handle resolve to the element's cell.
- `items.key(i)` is a handle by position, at the call and when it is
  stored. Nothing rewrites it to a reference to the element, so
  `items.key(0)` addresses the first element, whichever it is, and a
  stored one reads whatever element is at the position at the time of
  the read. The same for `items` an array of references, an array of
  plain values in place, and the result of another per-element
  construct. A reference to the element itself comes from the element
  handle that a per-element body is given, from `elementById`, or,
  for an array of references, from reading the element's own cell.
- `items.key(i)` is equal to a reference by key to the element at
  position `i`. Both are resolved to the current position and compared
  there, so the comparison is of one moment and needs a read of the
  parent. The case is an array of plain values in place.
- An element of a collection that is the result of a per-element
  construct, such as a `map` or a `filter`, is keyed by the key of the
  upstream element it came from. A change of one upstream element then
  evaluates that element's nodes through a chain of such constructs,
  and no other element's. Where the source is plain values that one
  computation produces as a whole array, an implementation may evaluate
  the whole collection again on each change in place of keeping results
  per element, and the observable result is the same.
- The key of an element is derived from upstream causes and stays
  stable, for an array of references and for the result of another
  per-element construct. Over an array of references the key is the
  identity of the element's cell, which is tied to the cause of adding
  the item, as where a handler instantiates a pattern and pushes the
  result. An edit of the item, a rename included, changes no key, and
  such an array needs no declared key.
- The key of the elements of an array is declared on the array, with
  the array type `ArrayByKey<T, "field">`. `ArrayByKey<Repo, "id">`
  is a `Repo[]` whose elements are plain `Repo`, as in
  `fetchJson<{ items: ArrayByKey<Repo, "id"> }>({ url })`. It is a
  type-level declaration with no run-time call, and the compiler
  writes the key field into the schema of the array: the schema
  keyword is on the array schema, and not on the items schema. It
  applies to plain values: a plain array that is generated from
  scratch, where one computation produces the whole array each time,
  as the result of an API call is, and an array of plain values in
  place. The key of such an element is formed from the value of the
  field, with the occurrence count where two elements have the same
  value of it. The result of another per-element construct is keyed
  by the upstream key, so a declared key is carried through the
  downstream constructs. An array of references does not need the
  declaration. `ArrayByKey` is not the collection method `keyBy`,
  which builds an index and changes the key of no element. This
  ruling replaces the syntax of two earlier ones, and that syntax
  governs nothing: a type marker `KeyedBy<T, "field">` on the
  element type, with a union of field names for several fields.
  `KeyedBy` does not exist. The rest of those rulings stands: a
  plain value can have a declared key, the key is carried
  downstream, and several fields are written as a union.
- The key belongs to the array and not to the element. An element
  that is put into a second array has the key that the second array
  declares, or none: the two arrays hold two copies, or the second
  array has a key of its own. The case is an array of plain values
  in place and a plain array generated from scratch; the result of
  another per-element construct has the upstream key, and an array
  of references is keyed by its cells.
- `ArrayByKey` can name several fields. The element still has one
  key, which is formed across them. The syntax is a union of field
  names, as `ArrayByKey<Repo, "owner" | "name">`. The fields are
  ordered by name when the key is formed, so the order in which the
  union is written changes no key. The case is that of the
  declaration: an array of plain values in place, a plain array
  generated from scratch included, with the key carried through the
  result of another per-element construct; an array of references is
  keyed by its cells.
- The key of a plain value that has declared key fields names the
  fields: its element part holds the list of the field names and one
  salted hash of the combined values of those fields. It does not
  hold the values. A reference by
  key is resolved from the key alone, with no schema: the resolver
  reads the names from the key, combines those fields of each
  element of the array, hashes, and compares. The salt is the one
  that the element key of a whole value is hashed with, which a
  client cannot read, so a client cannot form such a key before the
  server stores a link, and a stored reference does not show the
  values of the key fields. Two keys that share the value of one
  field have nothing in common. The key has no written form with
  separators of the documents' own, by the ruling below on written
  forms. Resolving from the key alone holds for a
  reference to a member below the element, as the one that
  `center.set(repo.position)` stores, and for every reader, whatever
  key the reader's type declares. A key formed from a field `id`
  with the value 7 is not the key of a whole value that is 7, and a
  key formed from the whole value, where no key is declared, names
  no field. The runtime keeps no record of the schema that an array
  is stored under for the purpose of resolving a key. Forming keys,
  when an element table is made or a whole array is read, uses the
  key fields that the collection or the read declares. The case is
  an array of plain values in place, a plain array generated from
  scratch included, and the result of another per-element construct
  where the upstream position holds a value; an array of references
  is keyed by its cells and is not affected. This ruling withdraws
  an earlier one, which governs nothing: that a key does not say how
  it was formed, and that whoever resolves a key takes the key field
  from the schema. It also replaces one part of the ruling that it
  extends, and that part governs nothing: that the element part
  holds each field name with the canonical form of the field's
  value.
- The design builds no key, no identifier and no other stored string
  by joining parts with separators and an escaping of its own. The
  owner gave the ruling for the element part of a key ("field names
  can contain : as well") and for the design in general. Wherever the
  design needs the written form of a structured thing, as the element
  part of a key with its field names and hash, a whole key with its
  element part and occurrence count, the key of a `flatMap` member
  with the key of its source element, a name with its ordinal, or
  the steps of a `within`, that form is the serialization of a fabric
  value by the helpers of `base/data-model`: `hashOf` and
  `taggedHashStringOf` (`base/data-model/src/value-hash/impl.ts`) for
  a hash, and `jsonFromFabricValue` (`base/data-model/src/codecs.ts`)
  for a string. The documents state the structure, for a key with
  declared fields the names in the order of the names and one salted
  hash, and name the helper; they define no separator. A hash is
  written as the helpers write one, with its algorithm tag. This
  replaces three things, which govern nothing: the assumed written
  form `name,owner:<hash>` with its `\` escaping, the assumption of
  a digest with no algorithm tag, and the separator `/` between the
  key of a source element and the member part in the key of a
  `flatMap` member, which the prototype writes under the ruling on
  that key: this ruling replaces that part of it, and the rest of
  that ruling stands. The record forms are the
  documents' choice (question 202). The ruling covers every key: for
  an array of references the element part is the record of the
  address, for an array of plain values in place, a plain array
  generated from scratch included, it is the hash or the record of
  the names and the hash, and the result of another per-element
  construct has the upstream key unchanged.
- A reader whose type declares no key learns the key fields of an
  array it is given from the schema that is traversed while the link
  to the array is resolved: the keyword `keyFields` on the schema of
  the array that is met on that traversal ("the keys should be picked
  up while the schema is traversed while resolving the link"). No
  separate record of the stored schema is kept. The case is an array
  of plain values in place that the reader reaches through a link, a
  plain array generated from scratch that an instance stored
  included; the result of another per-element construct has the
  upstream key, and an array of references is keyed by its cells.
  What such a reader does where no schema with the keyword is met is
  question 203.
- The key of an element that a `flatMap` contributes is formed from
  the member itself, by the same rule as for any array, together with
  the source element's key: the cell identity for a member that is a
  reference, and the value with the occurrence count for a member that
  is a plain value. The occurrence count is among the members of that
  source element's segment. Two members of one segment that change
  places then evaluate nothing, as for `map`. The rule covers a
  segment of references and a segment of plain values, over a source
  of any of the three cases. The two parts are not joined with a
  separator: by the ruling on written forms the key is a record of
  the key of the source element and the key of the member.
- An output that passes a derived collection on unchanged is the same
  collection for keying, and the plan marks that output as such
  (`Output.passesCollection`). The case is the result of another
  per-element construct that a `computed` or a `lift` returns as it
  is, with a per-element construct applied to that output. The rule is
  the same where the upstream source is an array of references and
  where it is an array of plain values in place.
- Every rule, assumption, and question about a per-element construct
  says which case it is about: an array of references, an array of
  plain values in place, or the result of another per-element
  construct.
- The identity of the cell that a slot of a collection links to is the
  address the link resolves to: the space, the document, the scope, and
  the path within the document. Two links into two paths of one
  document are two elements. What an element body holds is named from
  the enclosing instance and the key, as the result cell of an element
  is named today from the result container and the key
  (`cellIdentityKey` in `runtime/runner/src/builtins/scope-policy.ts`,
  `listElementKeys` in
  `runtime/runner/src/builtins/list-element-keys.ts`, and
  `listElementResultCell` in
  `runtime/runner/src/builtins/list-coordinator-plan.ts`). The design
  does not need the links that the runtime of today stores between the
  arrays that per-element constructs read and write. The causes are
  computed as they were, in particular where an instance writes several
  documents.
- The record of a key of a list, which `elementById` yields a handle
  of, is as today: a cell of its own, named by the address of the list
  and the key. It is not a member of the list until a reference to it
  is added, and a reader of the list's label does not cover it before
  that. The list holds references to its records, so a per-element
  construct over it is the case of an array of references.
- An event for the stream of a binding of an element body whose key
  has left its collection is refused, also where a link to the stream
  is stored outside the collection. The same over an array of
  references, over an array of plain values in place, and over the
  result of another per-element construct. A row that is to take
  events after its element has left is called through `asInstance()`.
- `asInstance()` is a modifier of a pattern factory, beside
  `asScope(scope)` and `inSpace(space, options)`, written
  `Row.asInstance()({ r })`. It returns a factory of the same types.
  The call is an instance of its own, with its own argument and
  result documents, and is not compiled into the surrounding
  instance. It composes with the other modifiers, and a call through
  `inSpace` is such an instance already.
- A pattern call through `asInstance()` in a per-element body is an
  instance of its own from the moment the element first appears,
  identified by the site of the call, the collection and the element
  key. Over an array of references its argument holds the reference
  to the element. Over an array of plain values in place, and over
  the result of another per-element construct, its argument holds the
  value, written again when the element changes while it is in the
  collection. When the element leaves, nothing is written and the
  instance stays; no copy is made then or when a reference to the
  instance is stored elsewhere. When the same key returns it is the
  same instance, so state within it survives a change of a query and
  back. Events for its streams are handled whether or not the element
  is in the collection. Cleanup of instances that nothing refers to
  is deferred; the history of documents is kept by default, so it is
  not a new issue.
- Stored per-element state is not carried over from the current runtime.

**Labels**

- Template labels are equal to or tighter than today's, with three
  deliberate exceptions. One is the collection index, where the keys of
  absent elements join a bucket's membership label. The second is a read
  through a handle that is static because every run that returns normally
  makes it: a run that throws before the read carries the read's label
  all the same. The third is the integrity of a default that is read
  and not stored. Nothing is stored once for several positions of a
  collection, so no stored label joins the labels of two positions.
- A read through a handle at a static place that is conditional stays
  dynamic.
- `minBy`, `maxBy`, and a keyed lookup break a tie among equal keys by
  the first position in the collection's order.
- The argument a language model supplies to a pattern closure given to
  it as a tool carries the label of the model's output. The result
  carries the label of the instance's own result.
- A language-model built-in checks the egress ceiling on every send, not
  only at the request: a tool-loop result, a system prompt rendered
  again, and a dialog's live transcript.
- `findIndex`, `some`, and `every` use the prefix rule: elements after the
  deciding one do not join the label.
- A factory value that changes under a child tears the child down and starts
  a new one under the same name. An `inSpace` instantiation's identifiers
  are known before the cross-space commit.

## Open, and needing the owner

Each entry names where the question is stated in full and the assumption the
documents make until it is answered. "ES", "SS", and "FA" are
`execution-and-storage.md`, `scheduler-and-serving-loop.md`, and
`footprint-analysis.md`; a question number is an entry of that document's
open-questions section, and the other numbers are findings of the cross-read
record.

**Label rules.** Each changes what Contextual Flow Control decides, so the
answer goes to the specification with the document.

7. **The integrity of a closure's factory value** (record, section 2).
   *Assumed, and written into the specification:* it takes no integrity
   from its captures.
<!-- The list restarts so that the numbers below stay as cited. -->

10. **A value passed on unchanged is a reference** (FA question 2).
    *Assumed:* yes, as today, which makes "the stored value is a link to
    the original" a rule of the language. The values of the prototype's
    corpus run need the rule. What a write stores where the reference
    leads into what the write replaces is question 84 of ES.
11. **A label-only change** (SS question 8). *Assumed:* a demanded kept
    output is instantiated again without running value code.

**Transactions, identity, and spaces.**

15. **Commits across spaces** (SS question 6). *Assumed:* one ordered,
    non-atomic sequence: the creation of a space an `inSpace` request
    creates, the allocation record, access changes, the batches in other
    spaces, then home. The ruling has the allocation recorded before the
    step in the other space; the creation of the space comes first here
    because a record committed before it could name a space that never
    exists (ES §5.6, SS §9.4).
16. **Demand across spaces** (SS question 5). *Assumed:* a serving
    runtime's session on another space counts as demand there.
17. **`inSpace` on a statically resolved callee in the reactive tier**
    (A9). Settled with the ruling on `asInstance()`: a call through
    `inSpace` is an instance of its own, with its own argument and
    result documents, and is not compiled into the surrounding
    instance ([Decided](#decided)). The entry keeps its number.
<!-- The list restarts so that the numbers below stay as cited. -->

21. **Event order per space** (SS question 10). *Assumed:* the proposal of
    Scheduler v2 §7.5.

**Clients.**

23. **A predicted refusal** (SS question 7). *Assumed:* no speculative
    result, a mark on the control, and the event is still sent.

**Migration.**

25. **Settled effect results** (ES question 2). *Assumed:* copied forward,
    so that a migrated instance does not request again.
26. **Retired documents and refused sources** (ES questions 3 and 4).
    *Assumed:* deletion after thirty days without a read, and a space
    that holds an instance whose source the compiler refuses is not
    switched.
27. **State inside a compiled-in sub-pattern** (ES §5.7, §9.3). Matching it
    to a call site needs the builder form, so an instance of a space
    switched after stage 6 loses that state.

**The language.**

28. **When the identity-alias typings are published** (A14). Until they
    are, an accepted program can show an editor error, against rule 2 of
    the language subset.
29. **Two senses of "cause"** (A17): what a transaction is opened for, and
    the seed of an identifier, as in `.for(cause)`.
30. **`inspectConfLabel` on an interim value** (K3). The plan document
    instantiates the value's template when asked; the inventory answers
    `notAvailable`. The ruling says an interim value is not labeled.
<!-- The list restarts so that the numbers below stay as cited. -->

32. **Context reads in the pattern body** (`builtin-inventory.md`, open
    question 10). The language subset refuses `eventKey` and
    `currentPrincipal` there and no document decides the others. Today
    every one but `equals` and `getPatternEnvironment` throws in a pattern
    body. *Assumed:* the others are legal there, as in a `lift`.
33. **"Evaluate the same gates"** (K18). The ruling has clients evaluate
    the same gates as the server. One gate cannot be evaluated on a
    client: the egress ceiling of an effect a handler requests depends on
    sink ceilings that are server configuration. The overview now says a
    client evaluates the gates it can from the plan and the data it holds.
34. **The label metadata of a label that depends on a value**
    (`plan-and-label-templates.md`, open question 16). The stored label of
    a conditional, a chosen child, or a prefix fold differs with the
    condition's value, so a reader of the label in another instance learns
    something about the condition.
35. **What `resultOwnerOf` returns** (`plan-and-label-templates.md`, open
    question 17). It returns the result of a verifier read, which
    contributes no label today. The specification calls an exposed
    verification result a labeled observation.
36. **An effect request that holds a reference** (F1). *Written into
    `plan-and-label-templates.md` §3.14 and the specification:* the
    transaction that checks the egress ceiling follows the references the
    request holds as far as the built-in serializes, and checks the ceiling
    on the join. The other correction, a request that reads the content of
    its members, would put that content's label on every other write of
    the handler.
37. **Side-writes of a failed cone.** *Written into
    `plan-and-label-templates.md` §5.2:* a failed cone's writes to a state
    cell, a cell through a handle, a created cell, or an anchors document
    are withdrawn, which leaves it visible that the write did not happen,
    as it is today; a child's argument and an effect's request take the
    error state.
**From the second round of passes.** "PL" is
`plan-and-label-templates.md`, "LS" is `language-subset.md`, and "BI" is
`builtin-inventory.md`. Each is written into the documents as an
assumption.

39. **What a withdrawn write takes with it** (PL §4.5, §4.6, question
    28). The ruling withdraws a derived write alone on a conflict. Other
    writes of the transaction can have been computed from a value or a
    label it staged. *Assumed:* those are withdrawn with it and the rest
    commits. The alternative evaluates and checks them again at the
    commit.
<!-- The list restarts so that the numbers below stay as cited. -->

41. **Where a result is split** (ES §4.10, question 32). *Assumed:* the
    split points are the root of a kept output, a row of a kept
    collection, and a node of the rendered tree at any depth; a part is
    split off at 1,024 bytes and merged back at 512, and a document holds
    at most 65,536; the properties of a rendered node stay with the node.
    The numbers are placeholders for stage 4 to measure.
42. **An instance made again under the identity of one torn down** (ES
    §2.8, question 33). By ruling the removal of an element deletes
    nothing stored under its key, and an element that returns under the
    same key reads what its state cells held ([Decided](#decided)). The
    ruling is on the state cells and the operation state that an
    element body declares, over an array of references, an array of
    plain values in place, and the result of another per-element
    construct alike. It does not speak of an instance. *Assumed:* an
    instance made again under the identity of one torn down finds the
    stored state where that is not yet deleted, and the documents of a
    torn-down instance are deleted after the retention period of ES
    §9.6. A link to a torn-down instance held elsewhere reads the last
    stored values. That covers an instance that a `lift` or a
    `computed` makes, which is not about a per-element construct, and a
    child of an element body, in each of the three cases: the key
    returns when the same resolved address, the same value, or the same
    upstream key stands in the collection again. The alternative for
    the child of an element body keeps its documents as the state cells
    of the body are kept, so that a child made again always finds its
    state. By ruling a child of an element body that is called through
    `asInstance()` is not torn down when its key leaves, in each of the
    three cases, so the assumption covers a child without the modifier.
43. **A failed evaluation of a computation that makes instances** (PL
    §3.14). *Assumed:* the instances of the last evaluation stay, and
    their arguments take the error state.
44. **A cone that failed on a time or memory budget** (ES question 34).
    *Assumed:* as at the bound, it is not evaluated again until an input
    changes.
45. **The acting principal of a space-scoped evaluation** (SS §9.3,
    question 34). *Assumed:* none, as today. So a change of demand runs
    as the demanding principal only for that principal's own scope, and
    an `inSpace` instantiation by a space-scoped computation is refused.
46. **A kept output computed before a handler body** (ES §1.6). *Written
    in:* the event's transaction stores it; where the body read it by
    address it is instantiated and checked before the read, commits under
    that label, and its cone is evaluated again behind the batch.
47. **A container captured by an inline handler that reads only scalars
    below it** (`footprint-analysis.md` §8.5). Under the binding ruling
    the container is one link, where today the scalars are copied when
    the binding is made. The stream then stays the same when such a
    scalar changes. *Assumed:* the link.
48. **Captures of an inline pattern** (PL §3.15, questions 23 and 24).
    *Assumed:* an inline pattern instantiated in a function body binds
    its captures by the rule for a handler binding, and a pattern closure
    of the reactive tier keeps the closure rule, which copies.
49. **A `computed` that instantiates a pattern is not promoted** (LS
    §6.1), because promotion would compile the call into the surrounding
    instance and change which documents exist.
50. **`inSpace` and `asScope` on an instantiation in a computation** (PL
    §3.14; BI question 11). *Assumed:* legal, as in a handler.
<!-- The list restarts so that the numbers below stay as cited. -->

52. **Trigger reads lost at a restart** (PL §3.10, question 29). A body
    with a sampled read can be evaluated because of a change at an
    address it does not read again, and after a restart that address's
    label is not joined. *Assumed:* accepted, equal to today. The
    alternative stores those reads with the basis rows.
53. **An explicit cause is not salted** (PL §1.3, question 30), so an
    observer who can list documents can test a guess of a low-entropy
    cause. *Assumed:* as today.
54. **Logs** (the overview). Whether a body can pass labeled data to
    `console`. Nothing is assumed; the footprint counts the arguments as
    read.
55. **A cone that reads a stale stored value of an instance that is not
    loaded** (ES §2.4, SS §4.4). *Assumed:* the read does not wait. It
    returns what is stored, the instance is loaded and the writer
    evaluated, and the reading cone is evaluated again. An output
    computed from the stale value can be stored in between. The
    alternative withdraws the derivation.
56. **Standing demand still loads an instance** (SS §4.4). The ruling on
    reading a current stored value is applied to an event's reads and to
    a one-shot pull. *Assumed:* a session, a render sink, an effect, or a
    materializer that depends on the instance loads it, because the
    scheduler learns of later input changes only through a loaded
    instance's entries.
57. **A write through a handle by an instance that is not loaded** (SS
    §4.4, §5.3). Nothing stored names the writer, so the check cannot
    tell that the value is stale. *Assumed:* the read returns what is
    stored.
58. **Stream index rows across a source update** (SS §5.1). *Assumed:*
    a row is kept, and an event for a binding the new plan lacks cannot
    be run.

**From the corrections after the second cross-read.**

59. **An explicit cause in the reactive tier** (LS §4.7, question 17; PL
    §1.3, question 31). *Assumed:* `.for(cause)` there takes a string
    literal, which takes the place of the declaration's name. A cause
    that is data is legal only in a function body.
60. **A `computed` that binds a handler is not promoted** (LS §6.1),
    because promotion would turn a binding made in a function body into
    one of the reactive tier. Ten `computed` calls of the corpus fail on
    this alone. It widens question 49.
61. **A built-in that needs a requester, where no principal demands it**
    (BI "The requester of a request"; SS §6.2, question 36). *Assumed:*
    `agent`, a cross-space or clearance-reading `sqliteQuery`, and
    `navigateTo` have user or session scope whatever computes their
    request, and are not requested without a demanding principal, as
    today. The principal of a completion's transaction and of a
    materializer's run is not decided. It extends question 45.
<!-- The list restarts so that the numbers below stay as cited. -->

63. **The allocation record of a created space stays when the unit that
    asked for it does not commit** (PL §4.6, question 32). *Assumed:*
    accepted, as the one exception to "no write commits that used a write
    that does not".
64. **Tearing down an instance in another space** (SS §9.3, question 40;
    ES §2.8). *Assumed:* the home transaction writes the mark of the
    instance it made, and the other space's loop marks the instances that
    belong to it there.
65. **`asScope` on a child** (ES §4.6, question 52). *Assumed:* the scope
    changes only the child's state cell documents. A kept output of the
    child that reads no such cell is stored once for the space, where
    today the whole result cell is per user or session.
66. **Spaces created without a name by the current runtime** are not
    found by a compiled instance, because the allocation record is named
    by the request's own identifier (ES §5.6).
67. **A handle below the cut of a recursive type** (FA §2.2, request 22).
    *Assumed:* the body is handed handles down to the cut and finds
    nothing below it, the one exception to "narrowing the argument does
    not change what the body does".
<!-- The list restarts so that the numbers below stay as cited. -->

69. **`sqliteDatabase`** (BI, LS §4.7). *Assumed:* legal in the reactive
    tier only, with table declarations that are static; a database first
    written with no acting principal has no owner, so a rule that names
    the owner admits nobody.
70. **A handler that reads a materializer that cannot run ahead of it**
    (SS §7.2). *Written in:* the event holds its place until the
    materializer has run. A materializer that stays invalid keeps the
    event waiting.

**From the rulings of 2026-11-13.** Each is written into the documents
as an assumption.

76. **The state of an occurrence among equal elements** (PL question
    36). Which state an occurrence has depends on the equal elements
    before it in the collection, which the label of its own position
    does not hold. *Assumed:* accepted as a residual. It is the same
    over an array of references, where equal elements are links that
    resolve to one address, and over an array of plain values in place,
    where they are equal values. An element of the result of another
    per-element construct has its upstream key, so its state depends on
    the equal elements of the first source of the chain and not on
    equal values in the result.
77. **The argument of a `.for(tag)` instance on a later event** (PL
    question 39). *Assumed:* not written again. The alternative writes it
    on every event, as a computation does.
78. **Which bodies the warning for an instantiation without a cause
    covers** (LS question 26). *Assumed:* a `lift`, a `computed`, an
    `assert`, and an authored function one of them or the reactive tier
    calls; not a `handler`, an `action`, or an inline event handler.
79. **The label of the error state after a refused send** (PL question
    38). *Assumed:* the join of the request's label, what was sent and
    received before, and the label the refused check was evaluated on.
80. **The instance of a tool call** (BI question 6). *Assumed:*
    identified by the built-in's operation, the request or turn, the
    ordinal of the model call, and the position of the tool call, not by
    the identifier the model supplies; made in the operation's space at
    the result's scope; torn down when the request or turn settles.
81. **The label of a database declaration's state document** (PL
    question 40). *Assumed:* empty.
82. **Which initializers are static for a default** (LS question 25).
    *Assumed:* a literal, an array or object literal of static
    initializers, and a reference to a constant with one.
83. **When a space is switched** (ES question 69). *Assumed:* the
    deployment names the spaces, the switch runs at an activation before
    the first cycle and evaluates nothing, and each instance has its
    first compiled evaluation at its first load.
84. **A space with an instance whose source the compiler refuses** (ES
    questions 4 and 70). *Assumed:* it is not switched; when the builder
    path is retired it is switched without that instance, which stops
    running until its source is updated. It extends question 26.
85. **Reversing a switch** (ES question 71). *Assumed:* not reversed.
86. **A link between a switched space and one that is not** (ES question
    72; SS question 41). *Assumed:* the reader reads the value and label
    as the other path stored them, so the tighter labels hold only along
    switched spaces.
87. **Events across the switch** (ES question 73). *Assumed:* the switch
    starts once the builder path has handled the queued events; a later
    event on a stream whose identifier is not kept is deferred and then
    dropped.
88. **How a validation run compares the two paths** (ES question 74).
    *Assumed:* between two spaces, one on each path. Nothing is designed.
89. **A client that holds spaces of both kinds** (SS question 42).
    *Assumed:* one runtime runs, per space, the path the space's mark
    names.
<!-- The list restarts so that the numbers below stay as cited. -->

93. **Whether a write through a handle of `unknown` is refused,** on the
    ground that a write needs a specific type, with `Cell<T>` then
    assignable to `ReadonlyCell<unknown>`. Raised by the owner, not
    ruled. The prototype is counting the corpus sites that write through
    such a handle.
<!-- The list restarts so that the numbers below stay as cited. -->

97. **A default on a type that names `undefined`** (LS question 34).
    *Assumed:* the type keeps the named `undefined`.
98. **A truthiness test on a value of type `unknown`.** *Assumed:*
    accepted, as a test of presence. The ruling names the test against
    `undefined` alone, so it can be read as refusing this.
99. **The declared type of a bound path whose prefix a condition
    narrows** (LS question 35). *Assumed:* the declared type is taken at
    the last step, and the prefix keeps its narrowing so that the
    property is found. The alternative refuses a path below a narrowed
    prefix.
100. **Which read and append the read-then-push warning reports** (LS
    question 36). *Assumed:* any read of the list in a body that calls
    `push` or `pushAll` on it, and not `addUnique`. This reports more
    sites than today's classifier.
101. **How the cones of a plan are partitioned** (PL question 44).
    *Assumed:* the partition the prototype chose.
102. **A statically resolved pattern on a cycle of calls** (PL question
    45; LS question 37). *Assumed:* refused. What the builder does today
    is not verified.
103. **How value code reads the child a dynamic key chose** (PL question
    46). *Assumed:* it is handed every child. `execution-and-storage.md`
    §2.2 gives `ConeHost.slot` no key, which disagrees with PL §3.18.
    The assumption was enough for the three corpus modules with such a
    read that the prototype's executor ran.
104. **The plan record of `wish`** (PL questions 47 and 48). *Assumed:*
    one operation of kind `wish`, whose result is read through slots
    rooted at the operation and labeled with the request joined with
    one dynamic entry for the search, with no integrity. A query that
    is not a constant is assumed to take the widest part. `wish` in a
    function body is assumed refused, and `language-subset.md` does not
    yet say so.
105. **The plan record of `reduce` in the reactive tier** (PL question
    49). *Assumed:* an operation of kind `reduce` over a step cone and a
    collection of its own, with the label a `fold` joined with the
    initial value.
106. **Three smaller records** (PL questions 50 to 52): the source of a
    scan, the positions after an array spread, and a write through a
    link that an instantiation or an effect returned. Each is assumed
    as PL states it.
107. **The template entries of a constructed value** (PL question 53):
    a rendered tree under `$UI`, or a record used as one value.
    *Assumed:* an entry per path, with view-node paths `props/<name>`
    and `children/<n>`, and a join where the value is observed whole.
    `execution-and-storage.md` has to agree on the view-node paths.
108. **What the hash of a body's code covers, and which slots carry a
    declared label** (PL questions 54 and 55). *Assumed:* the module
    and the binding; and no declared label on an `identity` slot or an
    in-place `shape` slot.
109. **What the compiler reports about label flow** (PL questions 56
    and 57). *Assumed:* it reports a confidentiality clause that no
    ceiling clause subsumes, unless a `Policy` atom is involved, though
    an exchange rule could make the clause fit at run time; and it
    takes a declared integrity as complete for a failure, though the
    runtime joins label components on both axes, so that a declaration
    is a lower bound.
110. **A JSX tag that names a factory value the instance computed** (PL
    question 58). *Assumed:* refused. `language-subset.md` names no
    diagnostic for it.
111. **Two refusals that look intended** in the corpus. A handle from
    `key` on an optional property, of type `Cell<T | undefined>`, given
    where a handler declares an optional `Writable<T>` (FabriChat's
    `room.tsx`); and an array of pattern results given where a cell of
    an array of that pattern's result type is declared
    (`quick-capture.tsx`). *Assumed:* both refused, as
    `language-subset.md` §7.5 reads.
112. **An input constraint on what expression code reads** (PL
    question 59). *Assumed:* constrained as a body is.
113. **Whether the compiler should decide write-floor and writer-fit
    for a write through a handle.** With no declared label on an
    `identity` slot (question 108), every such template has a term the
    compiler cannot evaluate, so it decides these two for expression
    code and for bodies that read values alone. *Assumed:* that stands,
    and the runtime check covers the rest.
114. **A UI contract whose surface is in the embedding pattern** (PL
    question 61). The chain of enclosing elements continues through a
    pattern written as a tag below the surface, and ends where a
    pattern is called and its tree is placed through a computed value.
    The second case occurs once, in FabriChat's thread composer.
    *Assumed:* it is reported, as a warning. The alternative suppresses
    the report for a pattern that is compiled into another.
115. **What is hashed** (PL questions 62 and 63). *Assumed:* every hash
    is the tagged value hash the runtime uses, with no tag for the kind
    of record; only a recursive type gets a `$defs` entry, named by its
    declared name; code is hashed as its source for a cone and as the
    module and binding for a body.

116. **What identifies the pattern in its `TransformedBy`, and which
    pattern it is for code compiled into another** (PL question 64).
    *Assumed:* the pattern's module and binding, and the pattern in
    whose source the expression is written.
117. **What the corpus comparison compares.** The runtime copies values
    where the plan passes references. *Assumed:* the comparison is made
    on dereferenced labels. The static part the runtime joins from a
    module's argument schema is separated by its origin and expected
    as a difference, by ruling.

119. **The runtime does not label an `ifElse` result with its
    condition** (PL question 69). Where the chosen branch is a
    reference, `forwardReference` writes the reference and a link to it
    with two raw writes that are not recorded as link writes, and no
    stored entry holds the condition's label. It reaches a reader only
    through the static entry joined from the argument schema, and only
    where the condition's input schema declares it. Where the branch is
    a literal, the stored value gets the join. This is confirmed by a
    test over three cases, not committed. It is a finding against the
    runtime, and by the owner's decision it is not filed, because the
    builder path is retired; what matters is that a conditional in
    pattern code has the right label in the compiled path. *Assumed:*
    the template, which joins the condition and the
    chosen branch, stands, and the comparison is made with the
    runtime's static part included for a conditional.

120. **Where the pattern's `TransformedBy` is added** (PL questions 71
    and 72). *Assumed:* at kept outputs only, with no condition, as one
    entry at the root of the result document. A promoted `computed`
    that passes a value unchanged to a child argument, a write target,
    or an effect request then has fewer atoms than today. What a reader
    that dereferences a link gets of the link's atom is not stated.
121. **Two labels the comparison found the documents wrong or silent
    about** (PL questions 73 and 74). *Assumed:* the label of an event
    slot is what the event arrived with, and a declared label is not a
    lower bound there; and no `TransformedBy` is minted beside a label
    that only a declaration gives.
122. **An output of a computation that threw, in the comparison** (PL
    question 76). The runtime stores no label there; the compiled path
    stores an error state under the output's template. *Assumed:* such
    an output is not a row of the comparison and is no further
    exception to "equal or tighter". The alternative counts it as an
    exception by ruling. The comparison met seven such outputs.
123. **A record for a reference that a site of a body made** (PL
    question 77). *Assumed:* a path that holds a handle a `createCell`
    site returned takes the body's `derive` template, and the plan has
    no member that names the site. The alternative adds such a member,
    which gives a constant template where the cell is a state cell.
124. **How much of a handler's template is on a link it writes** (PL
    question 79). By ruling the link carries at least the label of the
    event. *Assumed:* the handler's whole template joined with the
    label of the reference, which equals what the runtime stores
    today. The alternative joins the event and the reference alone.
    For a `lift` or a `computed` that passes a handle on at a result
    path the link keeps the label of the reference alone.
125. **Where the stream of a binding of an element body is stored** (PL
    question 78). Not applicable as a question about the plan, by the
    ruling that value code places a stream and that no record names
    where it is stored ([Decided](#decided)): each element of the
    assembled collection holds the link that the cone instance of its
    key placed, and a reader of the plan alone cannot say where a
    stream is. Settled by ruling as well: a collection among the
    children of a view node is one nested child, with its elements at
    `children/<n>/*`, so two collections among the children of one node
    are two child positions, and a child written after a collection has
    a static position. The prototype's plans hold a list of result
    paths with a kind for each `*` (prototype note 372), which the
    design does not have. The same over an array of references, an
    array of plain values in place, and the result of another
    per-element construct. The entry keeps its number.
126. **A schema of the plan and the schema the runtime stores an input
    under** (PL question 80). *Assumed:* the comparison stores inputs
    under the runtime's schema. The documents do not say how a schema
    of the plan names a policy.
127. **The `link` entry at the position of a handle that is only
    passed on** (PL question 81). The runtime stores there what the
    reference declares, which repeats the label of the cell's type.
    *Assumed:* it is not part of the handle's label, and the stamp of
    the run that wrote the link is. The runtime reads nothing at such
    a position, so the template can be looser than today by that
    stamp; the comparison met no such row.
128. **The event type of an inline handler that declares none** (PL
    question 82). An `on*` attribute of a host element expects no
    type. *Assumed:* `unknown`, so the handler reads nothing of its
    event. The alternatives refuse a parameter without an annotation
    there, or declare the event type of each attribute of each host
    element.
129. **The existence label of a path that a write removed** (PL
    question 83). The runtime leaves it in place, so a read of a list
    a handler emptied carries the clauses its former elements were
    created under. *Assumed:* the compiled path keeps it, equal to
    today. The alternative removes it with the path.
130. **A stream that the elements of a collection hold inside a value**
    (PL question 84). Not applicable, by the ruling that value code
    places a stream and that no record names where it is stored
    ([Decided](#decided)). A stream inside a value that one element
    holds, as `example[UI]` over an array of the results of patterns in
    `patterns/examples/cfc-trusted-component-examples/` (208 bindings),
    is stored where the element cone passes the member on with the
    marker in it. A further 5 bindings of the corpus have a stream that
    is read through a member of the element by name, as `entry.node`.
    The source is an array of plain values in place, an array written
    in place in the pattern body whose members the instance computes,
    or the result of another per-element construct whose elements hold
    the stream of a binding of that construct's body. Over an array of
    references the case does not arise, because a stream behind a
    reference is no binding's marker. The entry keeps its number.
131. **The declared label of an element's handle in the compiled
    path** (PL question 85). Settled by ruling: the handle of an
    element is read at the element's position in the source
    collection, and nothing of the `map` coordinator's join is in its
    label. Settled by PL's own rule: an entry of origin `link` at that
    position is in the label of a handle the body resolves or reads or
    writes through. Open: whether such a handle, where it is resolved
    and not read through, also carries the label that the declaration
    of the source collection gives the element. A clause a list
    declares for itself is stored at the root of the list's document
    and is consumed by a read of content, not by a read of which
    reference a position holds. In the runs observed the argument
    document of the element's instance has no `link` entry at
    `element`, and the handler has the list's clause from the
    coordinator's join alone, so the two descriptions the question
    gave of one label are two labels. *Assumed:* the handle carries
    the declared label, which is equal to today for `askToRetire` of
    `patterns/system/profile-picker/profile-picker.tsx`. Without it
    that write is tighter in confidentiality and has no atom
    (question 138). No record of the plan holds the declared label.
    Not determined by a run: whether a list that declares a clause
    for its items alone gives the link at `element` a `link` entry.
    The open part is about an array of references, which the observed
    runs are over. Over an array of plain values in place no link
    stands below the position, and the assumption gives the handle the
    same declared label of the list. Over the result of another
    per-element construct the element's label is what the template of
    the upstream output gives the position, and nothing is open.
133. **A written path that holds a link, for a write edge with no
    reference** (PL question 87). *Assumed:* the row is not compared
    where the run stored a link at the written path, and is counted
    apart. Not stated: whether one write can have an edge with a
    reference and an edge without, as the prototype emits.
134. **A label the runtime fails to read, and a slot whose path
    crosses a cycle of links** (PL question 88). *Assumed:* the row
    is not compared, and in the compiled path the evaluation that
    reads the slot fails as a body that throws does.

136. **A binding that a computation in an element body makes** (PL
    question 90). A binding made in a function body is named by what
    it holds and by no place, and everything an element body holds is
    per element key. *Assumed:* the first governs, so two occurrences
    that bind equal state from a `computed` or a `lift` have one
    stream. That is the same over an array of references (two links
    that resolve to one address, passed on), an array of plain values
    in place (equal copied values), and the result of another
    per-element construct (two elements with different keys that copy
    or pass on equal state).
138. **A write row whose template is empty beside the coordinator's
    join** (PL question 96). Where every clause a run stores for a
    handler's write is of the `map` coordinator's join, the template
    has no clause and mints no atom, and the run mints one. The row is
    tighter in confidentiality and looser in integrity by that atom.
    *Assumed:* it is counted apart as looser in integrity and is not
    among the deliberate exceptions. The alternatives count it as an
    exception by ruling, or mint on every `derive` of a write edge.
    One fixture has such a row and the corpus has none. The row arises
    in all three cases. What the coordinator's join holds today
    differs: the clauses of the list's own document over an array of
    references, those of the other elements as well over an array of
    plain values in place, and, over the result of another per-element
    construct, which today is an array of links to the upstream
    elements' result cells, what it holds for an array of references.
140. **The transaction that creates an instance outside a handler**
    (ES question 77). *Assumed:* one transaction that writes the
    argument and evaluates nothing, so that a new instance settles in
    two transactions. The alternative evaluates in the creating
    transaction. The derived count of two transactions to settle
    rests on the assumption.

**From the prototype's executor.** Each is written into the documents
as an assumption, which is what the prototype does.

141. **What `Cone.within` holds beside the collections** (PL question
     98). By ruling the record of a cone lists the collections of the
     element bodies it is written in, outermost first, and the runtime
     takes from the list which instances of the cone exist and under
     which keys what they hold is kept. The ruling is on the
     collections. *Assumed:* the member holds the steps of where the
     cone's code is written, as the `within` of a declaration does, so
     it has a `site` step for each pattern compiled in that the code is
     written in, and its `element` steps are the list the ruling
     names. The alternative holds the collections alone. The
     prototype's plans hold the `site` steps as well, as assumed: of
     3,717 cones, 576 have an `element` step and 1,336 a `site` step.
     Open with it: whether `Cone.entry` is
     unique in a plan without the `site` steps. The question is the
     same for a collection over an array of references, over an array
     of plain values in place, and over the result of another
     per-element construct: a `site` step names a call and no
     collection.
144. **A marker stored outside the result, and a marker handed to a
     sandboxed body** (ES question 78). Settled by ruling for the first:
     value code places a stream with `host.stream`, and the runtime
     replaces the marker by the link when it stores the value, wherever
     the marker is, so a marker in a side-write or at a path of a
     child's argument that a cone computes is replaced as one in the
     result is, and no position is checked ([Decided](#decided)). One
     thing the ruling does not determine. *Assumed:* a marker at a path
     of the argument that a value function gives a sandboxed body is
     handed to the body as a reference to the stream, as any reference
     at that path is. The alternative refuses it. The prototype's
     executor does both, and no test of it stores a marker outside the
     result. The same in an element body over an array of references,
     over an array of plain values in place, and over the result of
     another per-element construct. Question 165 has a stream that a
     function body returns.
145. **What a cone stores that passes on an element that is a plain
     value** (ES question 79). Settled by ruling: an element that is a
     plain value in place is named by its collection and its key, a
     reference to it or to a member of it resolves to the current
     position at each read and write, and a cone that passes the
     element on stores that reference and no copy. Two such references
     are equal where they name the same collection, key and path, and
     neither equals a reference to a cell. A write through one lands
     at the position that holds the key. A handler bound in the body
     holds the same reference as the cones of its row. After removal
     the reference reads as nothing, a deliberate difference from
     today. The case is an array of plain values in place, and the
     result of another per-element construct where the upstream
     position holds a value; over an array of references nothing
     changed. Questions 160 to 163 have what the ruling leaves open.
     The entry keeps its number.
146. **Which cone with side-writes is of which kind** (ES question 80).
     By ruling a cone with a small, fixed set of write targets is an
     ordinary node and one whose write set is dynamic or very large is
     evaluated eagerly. *Assumed:* the compiler decides the kind from
     the footprint, as FA §6.3 has it: an ordinary node where every
     write target is a statically named slot, and a materializer where
     a target is reached through data (a `*`, a computed path, a handle
     read from a value). No number is set for "very large": no count of
     static targets makes a cone a materializer.
147. **The key of an element that a `flatMap` contributes** (PL question
     101). Settled by ruling: the key is formed from the member itself,
     by the rule for any array, together with the source element's
     key. A member that is a reference has its cell identity and a
     member that is a plain value its value, each with the count of
     earlier occurrences among the members of that source element's
     segment. Two members of one segment that change places evaluate
     nothing, and a state cell declared in a body over the result
     stays with the member. The prototype forms the member part so at
     commit `e63b3d305c`, and its fixture has both kinds of segment:
     two members of one segment that change places evaluate nothing.
     Question 180 has which collection a reference by key to such a
     member names. Open: a segment that is itself the result of
     another per-element construct, as
     `xs.flatMap((x) => x.items.map(f))` yields. *Assumed:* the member
     part is the key the member has in that result. The alternative
     forms it from what the position holds. That case is the result of
     another per-element construct as the segment, over upstream
     references and upstream plain values alike. The entry keeps its
     number.
<!-- The list restarts so that the numbers below stay as cited. -->

149. **A property default of a place, in a read of an object whole** (PL
     question 103). By ruling the default nearest the end of the chain
     is read. For a read of an object whole, the runtime of today takes
     only the top-level default of a link's schema: a default that the
     link's schema declares for a property is dropped, and the reader's
     own default for the property is read. *Assumed:* the ruling holds
     at every path of what a slot reads, so a property that is absent
     reads the same default in a whole read as in a selection of it,
     which differs from today for the whole read. The alternative keeps
     today's two answers. One value of the prototype's fixtures is of
     this kind: a path of a compiled-in callee's result that passes on
     a path the caller left empty reads the callee's default where the
     read is addressed at the path, in both runs, and nothing in
     today's read of the whole result. Not about a per-element
     construct: the same for a callee in an element body in each of
     the three cases.
150. **A stored `undefined`, and a default written at setup** (PL
     question 104). Today a stored `undefined` reads as an absent value
     does, and a pattern writes its own argument defaults into its
     argument document at setup where a key is absent, which makes each
     a stored value for whatever reads through the document. *Assumed:*
     a stored `undefined` reads as absent, so the default the ruling
     names is read; and the compiled path writes no default into an
     argument document, so a default is always read and has the
     integrity of a default. The alternative writes the callee's
     defaults at setup, as today, which gives them the integrity of
     that run.
151. **What "the causes are computed as they were" requires** (PL
     question 105). By ruling the design does not need the links that
     today's runtime stores between the arrays per-element constructs
     read and write, and the causes are computed as they were.
     *Assumed:* the same inputs and structure of derivation, not
     identifiers equal byte for byte to today's. Over an array of
     references the key has today's inputs, the resolved address and
     the count. Over an array of plain values in place it differs from
     today's by ruling. Over the result of another per-element
     construct it is the upstream key, where today's is the address of
     the upstream element's result cell. The alternative asks for
     today's identifiers over an array of references.

**From the rulings as the prototype implemented them.** Each is what
its notes 307 to 320 found a ruling to leave undetermined, written
into the documents as an assumption, which is the prototype's choice
unless the entry says otherwise.

152. **How a sandboxed body of a compiled-in callee is handed the
     callee's default** (ES question 85). Settled by ruling: the entry
     of `Body.reads` holds the default (`ReadInput.default`), and value
     code does not pass it. The same inside an element body over an
     array of references, over an array of plain values in place, and
     over the result of another per-element construct. The entry keeps
     its number.
153. **A path of a compiled-in callee's result that passes on a path
     the caller left empty** (PL question 106). Settled by ruling: the
     stored reference carries the callee's declared default, so a
     reader of the result reads the default of the caller's place where
     it declares one and the callee's default otherwise, as today. The
     same in all three cases. Question 158 has what the two rulings
     leave open. The entry keeps its number.
154. **A write below the root of a state cell that holds nothing** (ES
     question 86, PL question 109). Settled by ruling: the document is
     created from the default with the write applied, and the members
     taken from the default keep the label of a default, the empty
     integrity. The same for a state cell of an element body in all
     three cases. The entry keeps its number.
155. **Whether a first value is stored as a value** (ES question 87).
     Settled by ruling: always a value, so a write to the cell never
     lands in the input. The same in all three cases, also where the
     first value is the element itself: over an array of plain values
     in place the cell holds the value and no reference to the
     element. *Assumed* beside it: a member of the value that is of
     data type and carries the address it was read from is stored as
     a value as well, and a member of handle type is stored as the
     link its type declares. The entry keeps its number.
156. **An output that passes a derived collection on unchanged** (PL
     question 107). Settled by ruling: such an output is the same
     collection for keying, and the plan marks it
     (`Output.passesCollection`). The case is the result of another
     per-element construct that a cone returns as it is, with a
     per-element construct applied to that output, over an upstream
     array of references and over an upstream array of plain values in
     place alike. Question 159 has what the ruling leaves open. The
     entry keeps its number.
157. **A read through the name a pattern binds to `[SELF]`** (PL
     question 108). By ruling the name is a reference to the result
     cell of the instance ([Decided](#decided)). Open: what a read
     through it is, of a path of the result that a cone of the
     instance computes; no record of the plan holds it. Question 170
     has what a handler binding that captures the name holds. Not
     about a per-element construct.

**From the rulings on questions 145 and 152 to 156.** Each is what a
ruling leaves undetermined, written into the documents as an
assumption.

158. **Where the callee's default is held beside `Body.reads`** (PL
     question 110). By ruling the entry of `Body.reads` of a sandboxed
     body of a pattern compiled in holds the callee's default, and a
     reference to a path of its argument that the callee passes on
     carries it. A handler is one body for all its bindings.
     *Assumed:* the entry of `Binding.state` whose place is a slot the
     call bound holds the default; and every reference to a path of
     its argument that the callee stores carries the default, not only
     one at a path of the result. The same inside an element body over
     an array of references, over an array of plain values in place,
     and over the result of another per-element construct.

159. **An output that is a derived collection on some evaluations
     only** (PL question 111). By ruling an output that passes a
     derived collection on unchanged is the same collection for
     keying, and the plan marks it. *Assumed:* the compiler marks an
     output where every evaluation yields the assembled result of the
     one collection, a chain of such outputs included, and for a
     sandboxed body where its record says the result always passes
     that input on. An output that is the collection under one
     selection and another array under the other is not marked, and
     its elements are keyed by what its positions hold. The case is
     the result of another per-element construct; the keys differ
     from the marked case where the upstream source is an array of
     plain values in place or the upstream body computes values, and
     not where the positions hold references to cells.

160. **A write through a reference by key that changes the value** (PL
     question 112). Settled by ruling: the write re-keys the element
     in the same transaction. The runtime moves what the old key
     holds to the new key and updates the reference the writer holds,
     so a row keeps its state and a handler that writes two members
     in turn succeeds at both. References stored elsewhere under the
     old key still read as nothing. *Assumed* beside it: what is
     moved is the state cells, the streams, the operation state and
     the children of the row, with their labels unchanged; and a
     write through a reference whose key no position holds is
     refused. By ruling an edit that is not made through a reference
     by key re-keys nothing and is a new element (question 190). The
     prototype re-keys at commit
     `e4f2fb3431`, when the handler returns or at the next settling
     for a write from outside a handler; before, one write committed,
     the row lost its state, and a second write through the same
     reference was refused with the event. Question 190 has four
     further points of the re-key, which are ruled since. The
     case is an array of plain values in place, and the result of
     another per-element construct where the upstream position holds
     a stored value; not an array of references. The entry keeps its
     number.
161. **How a reference by key is stored, and a key that returns** (PL
     question 113). *Assumed:* a link whose target is the address of
     the collection, with the key in the place of a position and the
     path after it; a client, which cannot read the salt, does not
     resolve one, and a read through it is pending there until the
     server's result arrives; and a reference whose key left resolves
     again when an equal value is added. The same two cases; not an
     array of references. Open with it, over the result of another
     per-element construct: what names a collection that is the
     assembled result of a `map` or a `flatMap` whose body computes
     its values, where the output is interim and nothing is stored at
     an address. *Assumed:* the instance and the index of the output,
     and a read through the reference reads the output as a cone reads
     another cone's output. The prototype passes such an element on as
     its value.
162. **The label of a reference by key** (PL question 114). The key is
     a salted hash of the value. *Assumed:* the stored reference
     carries the label of the run that wrote it and nothing for the
     value; a read through it carries the label of what is stored at
     the position it resolves to, joined with the label of the
     collection's array; and a read that resolves to nothing carries
     the label of the array. The alternative joins the labels of every
     position's value. The same two cases; not an array of references.
163. **Which readers hold a reference by key** (PL question 115).
     Settled by ruling, in both halves. A function body that reads a
     plain value holds a copy, and writing it elsewhere stores the
     value, as today; a handle the body is given for the element is a
     reference by key. And `items.key(i)` is equal to a reference by
     key to the element at position `i`, with both resolved to the
     current position and compared there. With them, by ruling:
     `items.key(i)` is a handle by position at the call and when
     stored, and nothing rewrites it. The prototype does both halves
     at commit `e4f2fb3431`: a handler that exchanges members between
     two arrays stores the values (`showcase/card-piles/main.tsx`, 28
     of 28 values equal in a seeded run, where 9 differed), and a
     handle by position is equal to the reference by key of the
     element that stands there
     (`dev/gideon-tests/test-handler-capture-key-equals.tsx`, 4 of 4
     values, where 2 differed). Question 174 has what the comparison
     gives where the parent cannot be read, and question 189 has two
     ways in which a body gets an element and holds a reference by
     key, by ruling. The case of the two halves is an array of
     plain values in place. Over an array of references both operands
     resolve to the cell. The entry keeps its number.

**From the rulings on questions 141 and 144 as the prototype implemented
them, and from the pieces added to its executor.** Each is what its
notes 325 to 341 found undetermined, written into the documents as an
assumption, which is the prototype's choice, unless the entry says it
is settled by ruling. Question 167 is what the ruling on question 166
leaves undetermined.

164. **Which cone instance fails where a stream is stored at a position
     the plan does not name** (ES question 88). Not applicable, by the
     ruling that value code places a stream and that no position is
     checked ([Decided](#decided)): no evaluation fails for where a
     stream is. Where one cone instance called `host.stream` and another
     stores the value, the link is to the stream of the keys of the
     instance that called. The same in an element body over an array of
     references, over an array of plain values in place, and over the
     result of another per-element construct. The prototype's executor
     at commit `e4f2fb3431` makes the check and keeps the top-level
     property of the result where it fails (prototype notes 370 and
     390), which the design does not have. The entry keeps its number.

165. **A stream that a function body returns into the result** (PL
     question 116). Settled by ruling. A `lift` or a `computed` that
     returns a value holding the stream of a binding its body made, or
     of one it was handed, returns a reference and no marker. The stream
     is treated like any reference a function body returns: the link is
     stored, and reads through it are dynamic. The corpus has 3 such
     positions, in rows that one `computed` returns as a whole array of
     plain values, and 9 at prototype commit `e63b3d305c`, where a body
     is handed a reference to the stream wherever its computed argument
     holds a marker (question 179); the rule is the same for a body used
     in an element body in all three cases. The entry keeps its number.

166. **Where the record of a key of a list is stored** (`elementById`;
     ES question 89). Settled by ruling: as today, the record is a
     cell of its own, named by the address of the list and the key. It
     is not a member of the list until a reference to it is added, and
     a reader of the list's label does not cover it before that. Open:
     what the footprint records for the handle. *Assumed:*
     `footprint-analysis.md` §7 keeps the entry at `*` below the list's
     handle, as the name of some record of the list, and a write
     through the handle is no write at a position of the list: it
     makes no reader of the list stale and is not labeled as a member
     of the list. The alternative records the write as dynamic, as a
     write to a cell made under a cause computed from data. The list
     holds references to the records, so for a per-element construct
     over it this is the case of an array of references; it does not
     arise over an array of plain values in place or over the result
     of another per-element construct.

167. **`elementById` in the reactive tier** (PL question 117). PL §3.19
     has `h.elementById(k)` with a key that is not a constant as a
     `pick` with the template of `k` as the choice, and a `pick`
     chooses a child of its container. By ruling the record is a cell
     of its own and no child of the list. *Assumed:* the plan keeps the
     `pick`, and the runtime binds the chosen child to the record that
     the address of the list and the key name. A read through the
     handle then has the label of the key and of the record, and
     nothing of the list's members or of its membership. The
     alternative gives the plan a slot root for the record of a key.
     The list holds references to its records, so this is the case of
     an array of references; not about an array of plain values in
     place or the result of another per-element construct.

**From the measurement of what today's runtime stores for a record
in a list, and from the rulings on questions 145 and 152 to 157 as the
prototype implemented them.** Each is what its notes 344 to 363 found
undetermined, written into the documents as an assumption.

168. **The document of a record that a function body writes into a
     list** (PL question 118). Today's runtime gives a record that
     `set`, `push` or `addUnique` writes into a stored array a
     document of its own and stores a link, and keeps in place a
     record of the argument that an instance is created with, or of a
     default. The documents have the compiled path store the first as
     today, and the prototype does so. *Assumed:* the document is
     named as a cell that the body creates with no explicit cause is,
     so two writes of equal records make two documents, as today; a
     record written through a handle that names one position gets a
     document as well; and a record in a constant first value of a
     state cell, or in a default that is read and not stored, is a
     plain value in place. The alternative stores every record in
     place. The question decides which case a stored list is of: an
     array of references for a list that function bodies fill, and an
     array of plain values in place for the records of an argument or
     of a default. It does not arise for the result of another
     per-element construct.
169. **Which record holds the default that a stored reference to a
     path bound by a call carries** (PL question 119). By ruling a
     reference to a path of its argument that a compiled-in callee
     passes on carries the callee's declared default, and no record of
     the plan gives the runtime the schema the callee declares for the
     path. *Assumed:* value code supplies it: value code of the callee
     hands the runtime the reference with the default when it stores
     it, and a read by code of the caller of such a path of the
     callee's result is written as a read of the caller's slot with
     the callee's default. The alternative gives `Output`, or the
     slot, a member for it. The prototype does the first half. The
     same in an element body in all three cases.
170. **What `Binding.state.place` holds for a state path bound to the
     name of `[SELF]`** (PL question 120). Settled by ruling: a new
     kind of place in the binding record names the result of the
     instance, written `{ result: true }`, and the runtime hands the
     handler a reference to the result cell. The prototype does so at
     commit `e4f2fb3431`. Its crate knows the name by its spelling
     and not by its scope, and gives a pattern compiled in the result
     of the enclosing instance for its own `[SELF]`: limits of the
     prototype. The same for a binding in an element body in
     all three cases. The entry keeps its number.
171. **How value code compares two references** (ES question 90).
     `equals` compares what its operands name once their links are
     resolved, and a value function cannot read through a reference.
     *Assumed:* `ConeHost` has a member `equals(a, b)` that takes the
     two references, and the cone instance depends on the links the
     resolution crossed. The alternative makes `equals` an operation
     of the plan with an output of its own. The same over an array of
     references, where an element resolves to its cell; over an array
     of plain values in place, where an element is a reference by key
     and no key is resolved to a position; and over the result of
     another per-element construct.
172. **Which record gives the type of a position of a body's argument
     that no slot names** (ES question 91). Whether an `identity`
     position holds a handle or a reference stand-in follows from the
     type the body declares, which for an entry of `Body.reads` is
     `Slot.schema`. An entry of `Body.computed` has no schema.
     *Assumed:* the runtime takes the type from the body's declared
     parameter type at the entry's place, which the artifact holds
     beside the plan. The alternative gives `ComputedInput` a schema
     member. Not about a per-element construct.
173. **A write below a place that holds nothing and is no state cell**
     (ES question 92). Settled by ruling: as for a state cell. A
     `push` below a path of the argument at which nothing is stored
     and whose schema declares a default starts from the default, and
     the push is applied. The members taken from the default keep the
     label of a default. Today's runtime has written the default into
     the argument document by then, which this design is assumed not
     to do (question 150). At commit `e4f2fb3431` the prototype's
     executor starts a `push` from the default, and 12 of 12 values
     of its fixture equal today's. It starts a `set` of one member
     below an empty path of the argument from an empty record, which
     is a limit of the prototype. The same for
     a handle in an element body in all three cases. The entry keeps
     its number.

**From the rulings of 2026-11-16 and 2026-11-17 on questions 160, 163,
164, 170 and 173, on the children of a view node, and on a pattern
call that is an instance of its own; and from the prototype's notes 367
to 386.** Each is what a ruling leaves undetermined or a note found
undetermined, written into the documents as an assumption.

174. **A handle by position compared with a reference by key, where
     the parent cannot be read** (PL question 121). By ruling
     `items.key(i)` is never rewritten to a reference to the element,
     and it is equal to a reference by key to the element at position
     `i`, with both resolved to the current position. Resolving needs
     a read of the parent. *Assumed:* where the comparing code cannot
     read the parent, the two are not equal. The alternatives fail
     the comparison or leave it pending. The owner did not restate
     that the ruling on the comparison stands beside the ruling on
     `key(i)`; the documents take it to stand, as a comparison at one
     moment. The case is an array of plain values in place, and the
     result of another per-element construct where the upstream
     position holds a value; over an array of references both
     resolve to the element's cell, which needs the same read.

175. **A declared key field for an array of plain values generated
     from scratch** (PL question 122). By ruling keys derive from
     upstream causes and stay stable, over an array of references and
     over the result of another per-element construct, and a declared
     key field would matter only for an array of plain values that
     one computation produces whole each time. Settled by the ruling
     on the array type `ArrayByKey<T, "field">`: the author declares
     the key on the array, and the key of a plain value of it then
     names that field and holds a salted hash of its value; the
     declaration can name several fields ([Decided](#decided)).
     Without the
     declaration the elements of such an array are keyed by their whole
     value with the occurrence count. The ruling is about an array of
     plain values in place, a plain array generated from scratch
     included. The entry keeps its number.

176. **A stored reference to the result of a pattern call in a
     per-element body without `asInstance()`** (LS question 41).
     *Assumed:* a function body that stores such a reference outside
     the collection is a compile error unless the call has
     `asInstance()` or `inSpace(...)`
     (`element-body:result-stored-outside`), reported where the
     compiler can follow the result to a write outside the
     collection. The rule was proposed to the owner, who did not
     object, and is not ruled. The alternative allows the store, and
     the reference reads as nothing once the element has left. The
     same over an array of references, over an array of plain values
     in place, and over the result of another per-element construct.
177. **`asInstance()` outside a per-element body** (LS question 42).
     *Assumed:* legal wherever the instantiation it modifies is
     legal, with the same meaning: the call is an instance of its own
     and is not compiled in. The alternative refuses it there. Not
     about one case of a per-element source.
178. **What the rulings on `asInstance()` leave open for the record
     and the argument** (PL question 123). Three parts. First, the
     record. *Assumed:* the plan records the call as a `Child` with a
     member `asInstance`. Second, a re-key against an instance, which
     by ruling is answered for two cases and open for one. Over an
     array of references it does not arise: the key is the identity
     of the element's cell, tied to the cause of adding the item, and
     an edit does not change it. Over an array of plain values in
     place that declares a key field with `ArrayByKey<T, "field">`
     it is avoided: an edit of another member, and a new array that
     holds an element with the same value of the field, keep the key
     and the instance. Open is an array of plain values in place with
     no declared key, edited through a reference by key. *Assumed:*
     the instance is re-keyed with the element (question 160), as the
     rest of what the old key holds is, and a link stored elsewhere
     to its result under the old key reads what it read before. The
     owner did not object to this and did not rule it. By a later
     ruling an instance that such a re-key replaces under the new key
     stays in the store ([Decided](#decided)). No record maps
     a key to an instance. The prototype's executor answers with the
     smaller mechanism (its note 397): it keeps a table from the
     child and the element keys to the instance, moves the table
     entry to the new key on a re-key, and leaves the documents under
     the names they were made with. The row keeps its instance and
     its argument is written again, as assumed, and a link stored
     elsewhere to the result keeps reading the later values, where
     the documents assume that it reads what it read before the write
     and no later value. The coordinator of this work recommends
     adopting the executor's behavior. That is a recommendation and
     no ruling, and the assumption in the documents is unchanged
     until the owner rules. Over the result of another per-element
     construct the case is that of the upstream source. Third, the
     argument of an instance whose key is away. *Assumed:* it holds
     at a path bound to the element what it last held, the reference
     over an array of references and the value over an array of
     plain values in place and over the result of another per-element
     construct.

179. **Which record says that a position of a body's argument holds
     the stream of a binding** (PL question 124). By ruling a stream
     that a function body returns is allowed and not checked, and a
     marker at a path of the argument of a sandboxed body is handed
     to the body as a reference to the stream (question 144).
     `execution-and-storage.md` §2.2 assumes an `identity` entry of
     `Body.computed` at the path. The prototype's crate records
     nothing for a stream bound to a formal of a body, and its
     executor hands the body a handle wherever a marker is in the
     computed argument. *Assumed:* the compiler owes the `identity`
     entry of `Body.computed`, and a marker at a path that no entry
     names is not handed on. The same for a body used in an element
     body over an array of references, over an array of plain values
     in place, and over the result of another per-element construct.
180. **Which collection a reference by key to a member of a `flatMap`
     result names** (PL question 125). PL §1.3 names the assembled
     result for an element of a `map` or `flatMap` result whose body
     computed a value. For a member that is a plain value in place of
     a stored array that the callback passed on, the prototype names
     that stored array and the member's key in it. The two differ in
     what a move of a member between two segments is. *Assumed:* the
     stored array, as the prototype does, since a write through the
     reference has to land there. The case is a segment of plain
     values in place that the callback passes on, over a source of
     any of the three cases; a member that is a reference is the link
     to its cell.
181. **Which template labels a write to the record of a key** (PL
     question 126; with question 166). By ruling the record that
     `elementById` yields a handle of is a cell of its own and no
     member of the list. The plan has a write edge and an envelope
     with target `handle` at `*` below the list, and that edge is the
     only one whose template could label the write. *Assumed:* the
     template of that edge labels the write to the record, and the
     write is no write at `*` of the list for a reader of the list.
     The list holds references to its records, so this is the case of
     an array of references.
182. **An array assembled from entries that is spread into another** (PL
     question 127). Not applicable, by the ruling that no record names
     where a stream is stored: each stored position of such an array
     holds what value code placed there, and nothing states a kind of
     position. The case is an array value outside the children of a view
     node, over collections of any of the three cases. The entry keeps
     its number.
183. **Whether a runtime instantiates from `Child.callee` or from the
     factory value** (PL question 128). PL §1.1 has the hash of the
     compiled pattern in `Child.callee` for a callee the compiler
     knows. The prototype's value code carries the identity of each
     `pattern(...)` in the factory value, and its executor finds the
     callee's artifact by that identity; its `Child` has no `callee`.
     *Assumed:* `Child.callee` is what the runtime instantiates from
     where the compiler knows the callee, and the identity in the
     factory value is used for a factory value received as data. Not
     about a per-element construct.

**From the rulings of 2026-11-17 on a declared key.** The ruling
that a plain value can have a declared key, which is declared with
`ArrayByKey<T, "field">`, settles question 175 and two of the three
cases of the re-key in question 178. These three points it does not
rule.

184. **A write to the key field itself of a plain value in place**
     (PL question 129). The key of a plain value in an array that
     declares a key field is formed from the value of that field, so
     a write
     to the field, or to any one of several key fields, through a
     reference by key changes the key. *Assumed:* it is the
     re-key that is ruled for a write that changes the value of a
     plain value with no declared key (question 160): what the old
     key holds moves to the new key in the same transaction, and the
     writer's reference is updated. The alternative refuses the
     write. The case is an array of plain values in place; nothing of
     it arises over an array of references, and over the result of
     another per-element construct it is the case of the upstream
     source.
185. **The document of a plain value of a keyed array that a
     function body pushes elsewhere** (ES question 93). A handler
     that reads an element of an array that declares a key field and
     pushes it to another list without `asInstance()`, as
     `saved.push(repo)` does, stores a copy as a document of its own.
     By ruling the key belongs to the array, and an element put into
     a second array has that array's key, or none; the second list
     here holds a link and is keyed by the cell. Whether the
     identity of the copy's document derives from the key is not
     ruled, and the owner gave no assumption. *Assumed* by the
     documents: it does not; the
     document is named as any record that a body writes into a list
     is (question 168), so two pushes of one
     element make two documents. The alternative derives the
     identifier from the destination and the key, so that a second
     push names the same document. The case is a body that reads an
     array of plain values in place, or the result of another
     per-element construct where the upstream position holds such a
     value; over an array of references the body pushes the link and
     no document is made.
186. **`ArrayByKey` on an array of references** (LS question 43). By
     ruling an array of references does not need the declaration.
     Whether the declaration written on one is ignored or is an error
     is not ruled, and the owner gave no assumption. *Assumed* by the
     documents: it is accepted and ignored, because whether a
     position holds a link or a plain value is a fact of the stored
     array that the checker does not always know; a position that
     holds a link is keyed by its cell. The alternative reports an
     error or a hint where the compiler can tell that the elements
     are cells. The question is about an array of references alone.

**From the prototype's notes 387 to 402, on the rulings of 2026-11-16
and 2026-11-17 as it implemented them.** Each is what a note found
that a ruling does not name, written into the documents as an
assumption.

187. **A spread child, and an array literal with a spread, among the
     children of a view node** (PL question 130; note 387). Settled by
     ruling: a spread child, `{...xs}`, and an array literal among the
     children that itself has a spread or a hole, are each one child at
     the position they are written at, and the literal is stored as one
     nested array value ([Decided](#decided)). Every child written after
     either has a static position. The prototype's crate makes it so.
     The same whether `xs` is a collection over an array of references,
     over an array of plain values in place, or the result of another
     per-element construct; where `xs` is another expression of array
     type, as an input, the child holds the reference, as today's run
     stores it. The entry keeps its number.
188. **A handler bound in the body of an inner `map` that the callback
     of a `flatMap` returns** (PL question 131; note 389). Not
     applicable, by the ruling that value code places a stream and that
     no record names where it is stored ([Decided](#decided)). The
     binding has two `element` steps, the stored result of the `flatMap`
     has one level of positions, and each position holds the link that
     value code placed. The prototype's crate lists `*/*` for such a
     binding, in a list that the design does not have. The case is the
     result of another per-element construct, the `flatMap`, over a
     source of any of the three cases, with a segment that is the result
     of a `map` or a `filter` over an array of references or over an
     array of plain values in place. The entry keeps its number.
189. **What a function body is given for an element where it is given no
     handle** (PL question 132; notes 391 and 392). Settled by ruling,
     in both cases ([Decided](#decided)). A handler bound in an element
     body whose state declares a data type for its element, as
     `stop: Stop`, is given a reference by key, and a member read from
     it carries the reference with the member's path, so
     `center.set(stop.position)` stores a reference by key. A member
     handle read through a handle of handles, as
     `Writable<Writable<Item>[]>`, is a reference by key. The
     prototype's executor does both. Both cases are an array of plain
     values in place, and the result of another per-element construct
     where the upstream position holds a value; over an array of
     references the state path and the member handle resolve to the
     element's cell. The entry keeps its number.
190. **What a re-key does beside moving what the old key holds** (PL
     question 133; note 393). Settled by ruling, in four points
     ([Decided](#decided)): an instance that a `lift` or a `computed` of
     the body made moves as a child, and nothing moves for a binding
     that a function body made; what is moved replaces what is stored
     under the new key; nothing moves for the other elements whose
     occurrence count changed; and a write that is not made through a
     reference by key re-keys nothing. The prototype's executor does the
     last three, and at commit `7774ba208c` moves an instance that a
     function body made as well. What becomes of an instance that the
     moved one replaces is ruled for an `asInstance()` instance and is
     question 204 for one that a function body made. The case is an
     array of plain values in place with no
     declared key field, and a body over the result of another
     per-element construct applied to it; nothing of it arises over an
     array of references. The entry keeps its number.
191. **Whether a key says how it was formed** (PL question 134; notes
     399 and 411). Settled by ruling: the key of a plain value that has
     declared key fields names the fields and, by a later ruling, holds
     one salted hash of their values (question 197), a
     key formed from the whole value names no field, and a reference by
     key is resolved from the key alone, with no schema
     ([Decided](#decided)). The ruling that the key does not say how it
     was formed, and that the resolver takes the key field from the
     schema, is withdrawn. The prototype's executor at commit
     `a462df710a` follows the withdrawn ruling: it forms the key with no
     field name, resolves it through the schema that the array is stored
     under, and keeps a record of that schema; it has to change. Its
     note 411 found that the withdrawn ruling does not determine which
     schema decides the key field, the one the array is stored under or
     the one the reader declares, or what a link by key to a member
     below the element holds so that its resolver finds the field. The
     ruling answers both: no schema decides, and the link needs nothing
     beside the key. The case is an array of plain values in place, a
     plain array generated from scratch included, and the result of
     another per-element construct where the upstream position holds a
     value; an array of references is keyed by its cells. The entry
     keeps its number.

**From the ruling of 2026-11-17 that drops the listed result paths.**
The ruling settles question 188 and makes questions 125, 130, 164 and
182 not applicable. These two points it does not rule.

192. **The label of a position that holds a stream** (PL question 135).
     No record names where a stream is stored. No label rule of PL §3
     reads where one is: a position of the result has the template of
     the nearest entry of `Plan.outputs` at or above it, a stream that a
     function body returns has the template of the body's output, a
     marker stored by a side-write or in a child's argument has the
     label of that write, and the label of which stream exists is with
     the row of the stream index. *Assumed:* those rules stand
     unchanged, and the expression that places the stream of a binding
     of the reactive tier has the template `const`, as a reference
     passed on. The alternative gives the position a template of its
     own. The same below a collection over an array of references, over
     an array of plain values in place, and over the result of another
     per-element construct, where the position has the template of the
     element.
193. **Whether anything decides that a binding has to exist from where
     its stream is stored** (PL question 136). *Assumed:* nothing does.
     A stream of a binding exists by the binding's record and its
     `within`, one per combination of element keys, and its row of the
     stream index is written when its identifier is first computed,
     whether or not a kept path holds a link to it. The alternative
     leaves out a binding whose stream no kept output and no stored
     value can hold, which needs an analysis of where value code can
     place the marker. The same for a binding of an element body over an
     array of references, over an array of plain values in place, and
     over the result of another per-element construct.

**From the rulings of 2026-11-17 on a key that names its fields and on
several key fields.** The rulings settle question 191 again and answer
the prototype's note 411. They left these five points, each proposed
by the coordinator of this work and written into the documents as an
assumption. Questions 194 and 197 are ruled since, and the rulings
that followed are under the next heading.

194. **The order of the fields of a key with several fields** (PL
     question 137). Settled by ruling: the fields are ordered by name
     when the key is formed, so the order in which the author writes
     the union changes no key ([Decided](#decided)). The ruling is
     about plain values: an array of plain values in place, a plain
     array generated from scratch included, and the result of another
     per-element construct where the upstream position holds a value.
     An array of references is keyed by its cells and is not affected.
     The entry keeps its number.
195. **Which properties can be key fields** (PL question 138). Each
     field is a required property of the element type at the top
     level, of type `string` or `number`, and the compiler refuses
     anything else (`array-by-key:declaration`). The owner deferred
     one extension, with priority 2: a key field that holds a
     reference, whose identity goes into the hash in the place of a
     value ("in principle references to other keyed things could work
     as well"). It is not part of the design until it is taken up. The
     other alternatives, which are not ruled, allow another scalar
     type, an optional property, or a path to a nested member. The
     question is about plain values: an array of plain values in
     place, a plain array generated from scratch included, and the
     result of another per-element construct where the upstream
     position holds a value. An array of references is keyed by its
     cells and is not affected.
196. **The schema keyword of the key fields** (PL question 139). By
     ruling the keyword is on the schema of the array, and not on the
     schema of the items. Its name is not ruled. *Assumed:* the
     keyword is `keyFields`, an array of the names in the order of
     the names, also where the declaration names one field, with a
     copy in `Collection.keyFields` of the plan record. It is read
     where a key is formed and by no resolver. The alternative is a
     keyword `keyField` that holds one name or an array of names.
     Prior art that the coordinator named from memory, not verified:
     the Kubernetes OpenAPI extension `x-kubernetes-list-map-keys`
     beside `x-kubernetes-list-type: map`, `primaryKey` of the
     Frictionless Table Schema, `key` of a YANG `list`, and `xs:key`
     of XML Schema. The question is about plain values: an array of
     plain values in place, a plain array generated from scratch
     included, and the result of another per-element construct where
     the upstream position holds a value. An array of references is
     keyed by its cells and is not affected.
197. **What the element part of a key that names its fields holds**
     (PL question 140). Settled by ruling: the element part holds the
     list of the field names and one salted hash of the combined
     values of those fields, and does not
     hold the values ([Decided](#decided)). The documents' earlier
     assumption, the plain values written as
     `name=labs,owner=commonfabric`, governs nothing. The form of the
     element part is question 199. The ruling is about plain values:
     an array of plain values in place, a plain array generated from
     scratch included, and the result of another per-element
     construct where the upstream position holds a value. An array of
     references is keyed by its cells and is not affected. The entry
     keeps its number.
198. **An array whose type declares one key, passed where another key
     is declared** (PL question 141). By ruling a key is resolved
     whatever key the reader's type declares, and keys are formed with
     the key fields that the collection or the read declares, so two
     readers whose types declare different keys form two keys for one
     element. *Assumed:* an array whose type declares one key, passed
     to a parameter whose type declares another key, is a compile
     error where the compiler sees both types
     (`array-by-key:mismatch`), and a parameter whose type declares no
     key accepts it (question 200). The owner said yes to the
     proposal, and it is not ruled. The alternative reports nothing.
     The question is about plain values: an array of plain values in
     place, a plain array generated from scratch included, and the
     result of another per-element construct where the upstream
     position holds a value. An array of references is keyed by its
     cells and is not affected.

**From the rulings of 2026-11-17 on the form of a key and where it is
declared.** The rulings settle questions 194 and 197 and replace the
syntax of the declaration: the key is declared on the array, with
`ArrayByKey<T, "field">`. These three points they do not rule. The
owner said yes to the coordinator's proposal for each, and each was
written into the documents as an assumption. Questions 199 and 200
are ruled since, and the rulings that followed are under the next
heading.

199. **The written form of the element part of a key that names its
     fields** (PL question 142). Settled by ruling: the element part
     has no written form that the documents define with separators
     or an escaping of their own. It is a fabric value, and the
     helpers of `base/data-model` hash it and write it
     ([Decided](#decided)). The documents' assumption, the names
     joined with `,`, then `:`, then a digest with no algorithm tag,
     with a `\` before a `\`, `,` or `:` of a name, governs nothing.
     The structure is the names of the key fields in the order of the
     names, and one salted hash of the array of the values of those
     fields in the same order, as `["labs", "commonfabric"]` and
     `[7]`; the hasher puts a byte for the type in front of each
     part, so the number 7 and the string `7` have two keys. The
     record forms are question 202. The ruling is about plain values
     where it concerns this element part: an array of plain values in
     place, a plain array generated from scratch included, and the
     result of another per-element construct where the upstream
     position holds a value. An array of references is keyed by its
     cells and is not affected. The entry keeps its number.
200. **A reader whose type is a plain array type, given an array with
     a declared key** (PL question 143). By ruling
     `ArrayByKey<Repo, "id">` is a `Repo[]`, so a parameter typed
     `Repo[]` accepts it. Settled by ruling: the reader learns the
     key fields from the schema that is traversed while the link to
     the array is resolved, which is the keyword `keyFields` on the
     schema of the array met on that traversal, and forms keys with
     them, so the key is carried forward. No separate record of the
     stored schema is kept ([Decided](#decided)). The documents'
     assumption that the link holds the schema that the array is
     stored under is replaced by the ruling. A collection of the plan
     that declares the key has `Collection.keyFields`, and the result
     of another per-element construct has the upstream key. Resolving
     a key reads no schema. The ruling is about an array of plain
     values in place that the reader reaches through a link, a plain
     array generated from scratch that an instance stored included.
     Over an array of references nothing of it arises. What the
     reader does where no schema with the keyword is met is question
     203. The entry keeps its number.
201. **The diagnostics of `ArrayByKey`** (LS question 44). *Assumed:*
     a declaration whose second argument does not name required
     top-level properties of type `string` or `number` is an error
     named `array-by-key:declaration`, and the error of question 198
     is named `array-by-key:mismatch`. The two keep the meaning that
     the documents gave them under the earlier syntax, and the names
     follow the type name. The alternative for the first is a type
     error of the checker with no name of its own. Both concern plain
     values: an array of plain values in place, a plain array
     generated from scratch included, and the result of another
     per-element construct where the upstream position holds a value.
     On an array of references the declaration has no effect
     (question 186).

**From the later rulings of 2026-11-17 and the prototype's notes 419
to 426.** Four rulings settle questions 199 and 200 and what notes
420 and 426 asked: on written forms, on the schema that a reader
learns the key fields from, on an `asInstance()` instance that a
re-key replaces, and on a reference by key to an element of a plain
array generated from scratch ([Decided](#decided)). Questions 202 to
205 are what they and the notes leave undetermined, each written
into the documents as an assumption. Entry 206 is ruled and records
the owner's reservation.

202. **The record forms of a key and of a name** (PL question 144).
     By ruling the documents state the structure of each thing that
     has a written form, and the helpers of `base/data-model` hash
     and write it. The ruling gives the structure of a key with
     declared fields and leaves the record forms to the documents.
     *Assumed:* a key is a record with the members `element` and
     `occurrence`; the element part of a key that names fields is a
     record with the members `fields` and `hash`, that of a key
     formed from a whole value is the hash alone, and that of a
     position that holds a link is the record of the address; the
     key of a `flatMap` member is a record with the members `source`
     and `member`; the salted hash of a value is `hashOf` of the
     record with the members `salt` and `value`; a key that stands
     in a stored path is the text that `jsonFromFabricValue` returns
     for it; and a name of several parts in a plan record is a
     record, as `{ name: "save", ordinal: 1 }` for a name with its
     ordinal, in the place of the strings `save#1` and `make#1/n0`
     that the documents had. The alternatives use arrays in the place
     of records, give the salt to the hasher in another way, or hold
     a name as the text of the codec. The parts on a key are about
     each case: the address record for an array of references, the
     hash and the record with `fields` for an array of plain values
     in place, a plain array generated from scratch included, and
     the upstream key unchanged for the result of another
     per-element construct. The part on a name is not about a
     per-element construct.
203. **A reader whose type declares no key, where no schema with the
     keyword is met** (PL question 145). By ruling such a reader
     learns the key fields from the schema that is traversed while
     the link to the array is resolved. The coordinator of this work
     named the case that the ruling leaves: a link that holds no
     schema, or one written by a party whose type declares no key.
     *Assumed:* the reader then forms keys from the whole value.
     References by key still resolve, since a key names its fields.
     The alternatives fail the read, or keep the record of the
     stored schema that the ruling says is not kept. The case is an
     array of plain values in place that the reader reaches through
     a link, a plain array generated from scratch that an instance
     stored included; the result of another per-element construct
     has the upstream key, and over an array of references nothing
     of it arises.
204. **An instance that a function body made, replaced on a re-key**
     (PL question 146; note 426). By ruling an `asInstance()`
     instance that a re-key replaces under the new key stays in the
     store, and a link stored elsewhere keeps reading it. The ruling
     does not cover a replaced instance that a `lift` or a `computed`
     of the element body made. *Assumed:* it is removed with its
     documents, and with the instances and bindings that its own
     function bodies made, as the prototype's executor does at
     commit `7774ba208c`; a link to one of its documents that is
     stored elsewhere reads as nothing. The alternative leaves it in
     the store, by the rule that a removal deletes nothing. The case
     is an array of plain values in place with no declared key, and
     a body over the result of another per-element construct applied
     to it; nothing of it arises over an array of references.
205. **An array whose type declares no key, given where a key is
     declared** (PL question 147; note 424). The assumed error
     `array-by-key:mismatch` is for two declared keys that differ
     (question 198), and a reader whose type declares no key accepts
     an array with a declared key (question 200). *Assumed:* an
     array whose type declares no key is accepted where a key is
     declared, as the prototype's crate has it, and the reader forms
     keys with the fields that its own type declares. Two readers of
     one program can then form two keys for one stored array; both
     resolve to the element, and what each reader keeps under its
     key is its own. The alternative refuses it as a mismatch. The
     case is an array of plain values in place and a plain array
     generated from scratch; the result of another per-element
     construct has the element type of its source with the key of
     the source, which is the case of question 198, and on an array
     of references the declaration has no effect.
206. **A reference by key to an element of a plain array generated
     from scratch** (PL question 148; note 420). Settled by ruling:
     an element of an array that a `lift` or a `computed` returns
     whole, stored as an output, has a reference by key with the
     output's address as its collection, by the same rule as an
     element of an array of plain values in place
     ([Decided](#decided)). The two sub-cases. With a declared key
     the reference stays with the element while the values of its
     key fields stay, across each new array that the computation
     returns. Without a declared key the key is the whole value, so
     the reference reads as nothing once the element changes, and no
     write repairs it, since a computed output refuses writes. The
     owner's reservation stands with the ruling: "if all that
     hashing gets too complex for little gain, copies are fine". The
     prototype's executor gives such an element no place: a handler
     of a body over the array is given the value and stores a copy,
     with a declared key and without one. The prototype is to build
     the reference and report what it costs. The ruling is about a
     plain array generated from scratch alone: an array of plain
     values that is stored in place has its reference by key by the
     earlier ruling, an element of the result of another per-element
     construct has the upstream key, and an element of an array of
     references is the link to its cell. The entry keeps its number.

One question above is restated by the notes 307 to 320. For the
assumption of ES question 83, in which transaction a first value that is not a
constant is written, the prototype does the alternative: it computes
the value when the cell is created, which for a cell of an element body
is when the key enters the element table, in all three cases.

## Open, and not needing the owner

- **The pattern closure's remaining gaps** (K12): which output or argument
  path holds which entry of `Plan.closures`, and a closure called through
  `inSpace`. A conditional between two closures is a factory value
  (`language-subset.md` §4.4.2).
- **The label of a model's output has no definition in the
  specification.** The rules for a tool closure and for a later send both
  rest on it, and specs pull request #91 refers to a contract rule for a
  language-model effect that no chapter states.
- **A statically resolved pattern called with `inSpace`** in the reactive
  tier of an element body is an instance of its own, by the ruling on
  `asInstance()`. No document says how the request of a space, which a
  handler makes in its transaction, is made by an element body of the
  reactive tier. The gap is the same over an array of references, an
  array of plain values in place, and the result of another
  per-element construct.
- **`execution-and-storage.md` leaves two things unspecified:** how the
  arrangement of part documents is computed again when a conflict
  withdraws writes at the commit, after the size rule ran; and how the
  instances that belong to a torn-down instance are found when it is not
  loaded.
- **`footprint-analysis.md`, owner question 2** says the current treatment
  of a value passed on unchanged "is what keeps such a body from reading
  the record". A probe showed that a `lift` that returns an input record
  whole keeps the record's full declared type in its argument schema, so
  the sentence may be wrong about the current runtime.
- **Three corrections to the pattern corpus** that the type checker's
  first slice found: `MentionablePiece` in
  `patterns/system/backlinks-index/backlinks-index.tsx` declares an
  optional `get` method, left from code that probed whether a value is a
  cell, and is to say what the value is; the battleship pattern's
  `Default<typeof INITIAL_SHOTS>` names a call result and is to take a
  static default; and `aboutRecordOf` in FabriChat's `manager.tsx` needs
  no overload once `key` flattens.
- **Uneven wording.** `language-subset.md` says selector where the other
  documents say key function, and it cites open questions of the newer
  documents by number.
- **Four assumptions `execution-and-storage.md` made from the
  prototype's executor** (its questions 81 to 84): the text of the
  value-code module, with one function per source module so that a
  name of module scope resolves as in the source; what a value function
  returns for a constructed value and for the constant paths of the
  result; in which transaction the first value of a state cell is
  written where it is not a constant; and what a write stores where a
  value passed on unchanged refers into what the write replaces. The
  last covers one array; by ruling a body that exchanges members
  between two arrays of plain values in place stores copies
  (question 163).
- **Defects of the prototype that the value comparison depends on:** a
  pattern compiled in at a call inside an initializer is evaluated in
  the caller's cone; the cone of an array written in place lists no
  slot of what its members hold; a constant captured by a handler that
  is not a literal at the binding is held as `null`; no code is emitted
  for a spread in the argument of a pattern (a `reduce` in the reactive
  tier is emitted at commit `59055fd0c5`); and 8 modules whose value
  code fails are not examined. Of
  the 23 differing values that had no cause, 8 are equal at commit
  `96f3b83a73` and 15 are classed, 7 of them by a reading that is not
  verified. At that commit the crate also holds the kind of a cone
  with side-writes as a member of the cone and a materializer's body
  in a cone, where the documents have neither; applies a callee's
  default only to a destructured name and a call written as a record;
  gives a state cell declared without a type argument a schema that is
  the default alone; and counts one document per state cell in its
  cost model. Its executor finds no reader for a write edge without a
  root and a path, lets a handler's read of a write target demand
  nothing, and has no test for the keys of a derived collection passed
  on unchanged. At commit `59055fd0c5` the crate evaluates a member
  read with the key `UI` or `NAME` as a chosen child, where the key is
  static; its executor keeps a `reduce` as one unit and not per key,
  has no function for a `reduce` without an initial value, which the
  language refuses, and does not compare a step that reads an outer
  input, which the compiler of today's runtime refuses; it instantiates
  no pattern and binds no handler in a function body, because the
  artifact names a compiled pattern by hash and holds no plan of a
  pattern from another module, and the executor has one instance over
  one store; and it has no `linksOf` and no debug-string built-in. The
  difference of `apps/person-workbench/main.tsx` and the 15 of
  `product/primitives/demo/atoms-demo.tsx` are examined at commit
  `77993077e4`: the first was a defect of the executor, since fixed,
  and the 15 come from constants the crate holds as `null`. At that
  commit the executor names the document of a record written into a
  list by a counter; stores in place a record that is set at one
  position of an array and the records of an array that a body creates
  a cell with; writes no default of the argument into the argument
  document; forms the key of a plain value with no salt; passes an
  element of a `map` or `flatMap` result whose body computes a value
  on as that value; stores a member of handle type of a computed first
  value as a value; and starts a `push` below an empty path of the
  argument from the empty array. The crate marks no output of a
  `computed` with a block body or of a sandboxed body that passes a
  derived collection on, and writes a caller's read of a path that a
  callee passes on with no default. At commit `e63b3d305c` the crate
  lists no result path for a stream that a promoted `computed` with a
  block body places in a tree it returns
  (`apps/base/contacts.tsx`, 3 evaluations that fail the check), and
  none for a stream inside an element that a `filter` passes on;
  records nothing for a stream bound to a formal of a body; has no
  `callee` on `Child`; and counts a child written after a collection
  as kind `member`, with the children of a view node flat. Its
  executor keeps the nearest entry of `Plan.outputs` where a check
  fails, and not the top-level property; compares the whole key at a
  `*` of kind `element`, and not a prefix; does not re-key a plain
  value that a write through its reference changes; stores a
  reference by key where a function body moves a plain value; holds a
  handle by position unequal to a reference by key; names an instance
  and a binding that a function body makes by the run and an ordinal;
  tears no instance down; and has no `asInstance()`. The comparison's
  `values-corpus.ts` does not pass the type check. At commit
  `e4f2fb3431` the crate and the executor have those rulings. The
  crate lists `*/*` with two kinds `element` for a handler bound in
  an inner `map` whose result the callback of a `flatMap` returns;
  does not report `element-body:result-stored-outside` or the
  diagnostic of a wrong declaration of a key, which that commit's
  documents named `keyed-by:declaration` and the catalog names
  `array-by-key:declaration`, because it follows the diagnostic
  catalog of `language-subset.md` at an earlier commit; does not check that
  a declared key field is a required property of type `string` or
  `number`; writes a placeholder for the hash of an `asInstance()`
  callee, with no schemas, and neither scope nor space where the
  modifiers compose; reports a call through the modifier of a
  factory value as unsupported; knows `[SELF]` by its spelling; and
  gives the slot of a name that an `action` captures the schema of
  the place and not the handle type the callee declares, so the
  handler is handed a value where it calls `get()`
  (`product/primitives/demo/atoms-demo.tsx`, 4 events). Its executor
  hands a handler a reference by key at a state path of data type,
  which is the ruling since;
  does not move an instance or a binding that a function body made
  when it re-keys; applies the default below an empty argument path
  for `push` alone; forms the key of a declared key field with no
  salt and no hash, and with the name of the field in it; forms a
  reference by key outside the element table from the whole value;
  keys the members of a `flatMap` segment with no declared field;
  identifies an `asInstance()` instance by a table and never removes
  one; and has no test for a write to the key field itself. The
  comparison of labels was not run over the corpus with the nested
  paths of the children, and the two forms of the value comparison
  disagree by 5 compared values, which is not examined. At commit
  `a462df710a` the crate records no result path, the executor checks
  no position and replaces a marker by the link wherever it stores a
  value, the comparison's harness finds a stream at the position the
  executor recorded, a re-key moves an instance that a `lift` or a
  `computed` of an element body made, and the two forms of the value
  comparison give the same figures. Against the rulings since that
  commit: the executor forms the key of a declared key field with no
  field name, resolves a reference by key through the schema that
  the array is stored under, and keeps a record of that schema,
  where by ruling the key names its fields and is resolved with no
  schema; and the crate and the executor have one key field and the
  keyword `keyField`, where by ruling the declaration can name
  several fields; and the crate reads the key from a marker
  `KeyedBy` on the element type and the executor holds the value of
  the field in the key, where by ruling the key is declared on the
  array with `ArrayByKey` and the element part holds the names of
  the fields and one salted hash of their values. The executor's
  value code reads the spread of an array of
  references as values, so a spread child over such an array holds
  no links; and nothing removes an instance that a re-key replaced,
  or the stream of a binding that the run of the old key made. At
  commit `7774ba208c` the key names its declared fields, a reference
  by key is resolved from the key alone, the store keeps no schema
  for a document, the declaration can name several fields with the
  keyword `keyFields`, the crate reports the two diagnostics of the
  declaration, and a re-key removes the instance of a function body
  that a moved one replaces. Against the rulings: the crate reads
  the key from the marker `KeyedBy` on the element type and writes
  the keyword into the schema of the items, where the key is
  declared on the array with `ArrayByKey`; the executor writes a key
  as a string with the prefixes `fields:`, `value:` and `cell:`, the
  separators `=`, `,`, `#` and `/`, and an escaping with `\`, where
  a key is a fabric value that the helpers of `base/data-model` hash
  and write; the key holds the values of the fields with no salt and
  no hash; a read of a whole array under a type that declares no key
  forms the keys from the whole value, where the reader takes the
  key fields from the schema traversed while the link is resolved;
  and an element of a plain array generated from scratch has no
  place, so a handler over it stores a copy, where it has a
  reference by key. The two diagnostics have the names
  `keyed-by:declaration` and `keyed-by:mismatch` and are provisional
  in the crate's catalog; the mismatch is not checked at an
  assignment or at the argument of a handle method, and its walk
  stops at depth 6. The members of a segment of a `flatMap` are
  keyed with no declared field. A `set` of a plain value on a cell
  that holds a link writes through the link, which is not examined.

The open questions each document ends with stay where they are.

## Known limits of what exists

- **Neither cross-read covered every section.** Each reader states what
  was not read in full at the end of its section of the record. In the
  second, no reader read `footprint-analysis.md` against the execution or
  scheduler documents.
- **Specs pull request #91 follows `plan-and-label-templates.md`** for
  every label rule the passes and both rounds of corrections wrote, as
  prose and pseudocode. It reduces the order of steps of a commit across
  spaces to two rules, and five questions for the owner (7, 11, 36, 39,
  43) are stated in it without a mark. Its description on GitHub is from
  the first draft; a current one is drafted and not posted. It has not
  been reviewed. Its Lean development states the two target theorems and
  is unchanged since the first draft: the calculus models no body calls,
  references, bindings, element keys, error states, or outputs stored
  between causes, so every rule about those is prose and pseudocode only.
- **Claims about the current system are verified unevenly.** Each pass
  reported what it did not verify. Among them: that running a new pattern
  on an occupied result cell stops the one running there, which three
  documents take from a doc comment; how a child inside a synthesized
  pattern is named across re-runs; most of the per-built-in request
  operands in `builtin-inventory.md` beyond the schemas, which came from
  reading by search; and the citations `scheduler-and-serving-loop.md`
  carried over, which were checked to exist and not for what they are
  cited for.
- **The server-primary execution specification differs from source in
  one place this work relies on.** `events.md` says an event needs no
  piece-start step. In source a queued event for a piece that is not
  running starts it (`ensurePieceRunningVerdict` in
  `runtime/runner/src/ensure-piece-running.ts`), and
  `scheduler-and-serving-loop.md` §5.1 describes the source. That
  specification is outside this work and is not corrected here.
- **Corpus numbers are syntactic, from one measurement.**
  `language-subset.md` §11.1 states the method: the files the pattern type
  check compiles and what they import, 425 modules, read with the
  TypeScript parser and no type checker. The three documents quote it and
  mark each figure that needs types or that the measurement did not
  reproduce. The tables of `footprint-analysis.md` §11.3 to §11.5 come
  from that document's own script and cover 1,962 of the 1,966 bodies.
  How often footprint analysis widens (83 of those 1,962 bodies, 4.2%)
  needs the type checker.
- **Factory values depend on pending work.** On this branch a factory can
  be stored but not read back as something callable. Pull request #4687 in
  this repository implements
  [first-class serializable factories](first-class-serializable-factories.md)
  and is not merged. It is where the pattern closure comes from. As
  described it also makes `lift` factories values, which this design does
  not; the owner is asking for that pull request to cover patterns only.
- **The Scheduler v2 specification differs from source in six places**
  that `scheduler-and-serving-loop.md` relies on source for, such as the
  name of the run budget and a fourth node status. That specification is
  outside this work and is not corrected here.
- **The rulings on `asInstance()` and on a declared key are tested by
  the prototype's executor alone,** and the declared key in the form
  of `KeyedBy` on the element type, which the ruling on `ArrayByKey`
  replaces. Today's runtime has neither, so the
  value comparison has no row for them, and no pattern of the corpus
  uses either. The nested layout of the children of a view node is
  compared with today's runtime through the paths that the events
  take, and not as stored values. The label comparison has not been
  run over the corpus with the nested paths.
- **The prototype follows the rulings on a key in part.** At commit
  `7774ba208c` the key names its declared key fields, a reference by
  key is resolved from the key alone with no schema, and the
  declaration can name several fields. It has the marker `KeyedBy`
  on the element type and the plain form of the key: a string with
  separators and an escaping of its own that holds each field name
  with the value of the field. It does not have the rulings since:
  `ArrayByKey` on the array with the keyword on the array schema,
  one salted hash in the place of the values, a key and a name as
  fabric values with no separators of the design's own, the schema
  traversed at a link as the place a reader whose type declares no
  key learns the key fields from, and a reference by key to an
  element of a plain array generated from scratch. The rest of this
  item is of the earlier commit. At commit `a462df710a` its executor
  forms the key of
  a declared key field with no field name, so a key formed from a
  field `id` with the value 7 is the key of a whole value that is 7.
  It resolves a reference by key through the schema that the array
  is stored under and keeps a record of that schema, and where a
  reader and the place declare different keys it follows the place.
  Its crate and its executor have one key field, with the keyword
  `keyField`. By ruling the key names its fields, is resolved with
  no schema, and can be formed across several fields. At that commit
  and after it the prototype has the marker `KeyedBy` on the element
  type and the plain form of the key, which holds the value of the
  field. By the rulings since, the key is declared on the array with
  `ArrayByKey<T, "field">`, the schema keyword is on the array
  schema, and the element part holds the names of the fields and one
  salted hash of their combined values. The case is an
  array of plain values in place, a plain array generated from
  scratch included, and the result of another per-element construct
  where the upstream position holds a value. The prototype follows
  the rulings that drop the listed result paths and the check, and
  the rulings on a spread child, on a state path of plain type, and
  on what a re-key moves. The figures of this plan that count listed
  paths or failed checks are of commit `e4f2fb3431` and earlier.
- **The comparison of labels and the cost measurement were run over
  the corpus once, at commit `7774ba208c`, and not compared with an
  earlier run.** Both read the crate's `emit` output and run the
  executor beside today's run to find the streams. No results file
  of either at commit `a462df710a` exists, the figures this plan
  held before are of an earlier corpus, crate and harness, and no
  difference between the two sets of figures was examined. The times
  were taken on a machine that was not idle. The cost measurement
  gives the executor no artifact for a pattern that a function body
  instantiates. A module that the executor does not run gets no
  event in today's run.
- **The ruling on a spread child is compared with nothing in the
  reactive tier.** Today's runtime runs neither an array literal
  with a spread among the children of a view node nor a JSX spread
  child where a pattern's body writes it: the transformer refuses
  the first, and the evaluation of the pattern throws at the second.
  The forms are compared in a `computed`, where 15 of 15 values are
  equal. The prototype tried a spread of a pattern value and does
  not say what today's runtime does for each of the three cases of
  a source.
- **One module of the corpus has another record at commit
  `7774ba208c` with no change of a figure.** In
  `apps/base/contacts.tsx` three of the 17 differences name another
  first path, because today's run stores the members of the rows of
  a `map` over an array of references in another order than in the
  earlier run. The cause of the other order was not examined.
- **One difference between the two forms of the value comparison is
  not examined.** At commit `a462df710a` the two forms give the same
  figure in every row. `showcase/battleship/multiplayer/room.tsx` is
  not executed for another reason in each, and the difference is in
  the state of the process in which today's runtime ran.

## Next work

1. **The owner rules** on the questions above. A ruling is added to
   [Decided](#decided), and the question's entry says that it is
   settled and keeps its number.
2. **Stage 2 of the overview's staging,** on branch
   `claude/compiled-pattern-prototype`: after the front end, the subset
   type checker, then footprint analysis, and then the corpus numbers
   that need types. A place where the prototype finds the specification
   ambiguous or not implementable is corrected in the document that owns
   the rule.
3. **Post the drafted description to specs pull request #91** and ask for
   its review, when the owner decides it leaves draft.
4. **In the prototype:** compare the label comparison and the cost
   measurement over the corpus, which ran once at commit
   `7774ba208c`, module by module with a run of the same crate and
   corpus, and take the times on an idle machine; bring the
   crate's diagnostic catalog to that of `language-subset.md`, which
   has `element-body:result-stored-outside`,
   `array-by-key:declaration` and `array-by-key:mismatch`; give the
   slot of a captured name the
   handle type that the callee declares; and have value code keep the
   links of an array of references that is spread among the children
   of a view node.
5. **In the prototype, for the rulings of 2026-11-17 on keys.** The
   prototype at commit `7774ba208c` names the declared fields in the
   key, resolves a reference by key from the key alone, keeps no
   record of a stored schema, and accepts several fields. It has
   `KeyedBy` on the element type and the plain form of the key. To
   do: replace the
   marker `KeyedBy` on the element type by the array type
   `ArrayByKey<T, "field">`, accept a union of field names in it,
   and write the keyword into the schema of the array in the place
   of the schema of the items; write the names of the declared key
   fields, ordered by name, and one salted hash of their combined
   values into the element part of the key, in the place of the
   values of the fields; hold a key, the key of a `flatMap` member
   and a name of several parts as fabric values, hashed with
   `hashOf` and written with `jsonFromFabricValue` where a string is
   needed, and remove the prefixes, the separators and the escaping
   of its own; resolve a reference by key by reading the names from
   the key, combining those fields of each element, hashing, and
   comparing; have a reader whose type declares no key take the key
   fields from the schema that is traversed while the link to the
   array is resolved; give an element of a plain array generated
   from scratch a reference by key with the output's address as its
   collection, and report what that costs to build, since the owner
   accepts a copy if it is complex for little gain; key an element
   that is put into a second array by the key of that array, or by
   its whole value; and, under the assumptions of questions 195,
   196, 198 and 201 to 205, write the keyword as `keyFields` with
   `Collection.keyFields`, use the assumed record forms, form keys
   from the whole value where no schema with the keyword is met,
   accept an array whose type declares no key where a key is
   declared, and report `array-by-key:declaration` and
   `array-by-key:mismatch` under those names. Also examine what a
   `set` of a plain value does on a cell that holds a link.

### Briefing an author

A brief that produced a usable document in the first round had these parts:

- the overview and the sibling documents to read in full first, with this
  plan's [Decided](#decided) list;
- the one file the author writes, and an explicit instruction to edit no
  other document and to list what it needs from the others;
- the numbered contents the document must cover;
- the instruction to measure the corpus with throwaway scripts that are not
  committed, and to verify claims against source;
- the gates to run, the branch to push to, and no pull request in labs;
- a closing summary: what the document decides, what it needs from the
  others, and the questions for the owner.

A brief for a reader who checks documents against each other had these
parts:

- the documents to read in full, and the sections of the others to check
  against;
- the findings already known, with an instruction not to repeat them;
- what counts as a finding: two statements that cannot both hold, an
  assumption about another document that it does not meet, a wrong
  reference, or an answered open question, and not style;
- for each finding the sections on both sides, the side that governs, and
  the smallest correction;
- a closing statement of what was checked and found consistent, and of
  what was not read in full.

When this plan's work is done or abandoned, archive it as
[`../README.md`](../README.md) describes.
