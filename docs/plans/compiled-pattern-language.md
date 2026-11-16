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
  lists the places where it found the documents ambiguous. Its notes
  through 272 and notes 281 to 302 are written into the documents.
  Notes 273 to 280, which measure cost, are written into
  [What compiling, running, and storing cost](#what-compiling-running-and-storing-cost)
  below, and notes 303 to 306, the results of the value comparison,
  into
  [What the prototype's executor computes](#what-the-prototypes-executor-computes).
  The latest prototype commit read is `3e518147df`, at which the crate
  also emits value code and an executor runs a plan with it: in the
  fixtures 122 of 122 compared values equal those of today's runtime,
  and in the corpus 4,472 of 4,537, over the 186 modules the executor
  runs. No compared row of the corpus evaluates the label of an
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
computes values and was not timed.

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
notes 281 to 306. Notes 281 to 302 say what the executor needed that the
documents did not give, and are written into the documents. Of the
questions they raised, the place of a slot of `Body.reads`, a path that
a call leaves out, the first value of a state cell, a moved element,
a cone with side-writes, the collections a cone's record lists, and
who places a stream in a computed value are ruled, and so is which
default is read along a chain of places ([Decided](#decided)).
Questions 141, 144 to 147, and 149 to 151 below, and questions 81 to
84 of `execution-and-storage.md`, are open. Of question 141 the member
is ruled, and what it holds beside the collections is open. Of
question 144 the placing and the check are ruled, and what the check
covers outside the result is open. Notes 303 to 306 are the results
here.
Nothing was timed.

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
  clock is compared as one token.
- **Today's side can be a saved run.** A run saves what today's runtime
  computed, and the executor can be run alone again on the crate's
  current output against the saved values (`compare/values-corpus.ts`,
  the command `again`). The notes do not say which figures come from
  such a rerun.
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
  debug-string built-in. It reads `spaceOf` as the space it is given
  and has no acting principal. It does not use `Cone.writes`,
  `ConeResult.selections`, or `ConeResult.picks`: a body's side-write
  goes through the handle the body holds.
- **The executor has no reader.** It evaluates every kept output and
  then the result, where the design evaluates what is demanded.
- **The emitter departs from the documents in three ways** that the
  results depend on. It writes one function per value a cone computes,
  where `execution-and-storage.md` §2.1 has one per cone. A pattern
  compiled in at a call written inside an initializer is evaluated in
  the caller's cone, where `plan-and-label-templates.md` §1.4 makes it
  cones of its own. And the cone the crate makes for an array written
  in place lists no slot of what the members hold. Each is a defect of
  the prototype.

### The fixtures

19 of the 20 fixtures are run, in 23 runs. All 23 are executed, and 122
of 122 compared values are equal. `fixtures/link-cycle.tsx` is left out:
its handlers make two cells link to each other, and a read of the whole
result of today's run rejects with a `LinkCycleError`. One event of
`fixtures/handle-passed.tsx` is not handled, because its handler
instantiates a pattern.

### The corpus

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

No difference is classed as a gap of the design by itself. The gaps this
round found are in what the executor needed in order to compute a value
at all. Each showed as a wrong value or a failed run before the emitter
or the executor supplied what was missing. Eight are ruled
([Decided](#decided)), and the rest are questions: 141, 144 to 147,
and 149 to 151 below, and questions 81 to 84 of
`execution-and-storage.md`.
The one design difference in the table is by the documents: in
`patterns/dev/gideon-tests/test-ifelse-both-branches.tsx` today's
runtime evaluates both branches of an `ifElse` and the executor the
selected one.

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
  14 of the 18 are of a binding for which the crate found no path, and
  4 hold a stream that is an input of the pattern. The 12 were not
  examined. By ruling the value code places a stream and the runtime
  checks the position against `Binding.result`, so the listed paths
  have to be complete: the 14 are positions the compiler owes a path
  for, and an evaluation that stored one of them would fail. The 4
  are no binding's stream, are passed on as any input is, and are not
  checked.
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

Today's figure includes the cells through which the scenario gives the
instance its inputs, one per top-level input. It is not the row "today,
measured: documents of the instance" of
[Storage](#storage): that row is over 213 modules, after settle, and of
the instance's own documents alone.

The executor's count is a lower bound on what the compiled path stores
for these scenarios, in this sense: it leaves out the part documents,
the state documents of operations, the stream documents, and the
instances document, which `execution-and-storage.md` §4.1 lists and the
executor does not make. It is not a bound on state cells. The executor
makes a document for every state cell when the instance is created or
the element key enters. By ruling a state cell whose first value is a
constant, or that is declared with no value, has no document until
something writes it (`execution-and-storage.md` §4.1), so the design
stores fewer state cell documents than the executor counted. No figure
is derived for the difference.

The derived counts of [Storage](#storage) stay the figures to compare
with today's, and the executor's count does not replace them. It bears
on them in two ways.

- **It is between the two derived bounds, on the mean.** The derived
  count is 2.2 documents per module at the least and 8.6 at the most,
  over 213 modules after settle. The executor has 7.0 over 186 modules
  after the events. The module sets and the points in the scenario
  differ, so this is no check of either bound.
- **The "least" bound counts no state cell,** because the document of a
  state cell is written when the cell is first written. By ruling that
  holds for a cell whose first value is a constant as well. A cell
  whose first value is not a constant has a document once that value
  is written, and the least bound rises by the number of such cells
  whose first value has been written, which the derivation did not
  count. In the prototype's corpus 3 of 1,399 first values read a
  slot. The executor's 4.8 state cell documents per module count
  every state cell, so they are no measure of that term.

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
  value function calls `host.stream(binding)`, a function of
  `ConeHost`, and puts the marker it returns at the position. The
  marker is inert: the function can place it in the value it returns
  and can do nothing else with it. It cannot send to it or read through
  it, so the rule that a cone's function holds no handle stands. When
  the runtime stores the value, it replaces each marker by the link to
  the stream of that binding for the element keys of the cone instance,
  and it checks that the position is one that `Binding.result` lists
  for that binding. A `*` of a listed path matches any element, and a
  path below a conditional matches under either selection. A marker at
  a position that no listed path covers fails the evaluation. So
  `Binding.result` stays the statement that the label analysis relies
  on, and the compiler owes its completeness: a path for every position
  of the result at which value code can place the stream. A stream
  that is an input of the pattern is no binding's marker. It is passed
  on as any input is, and the check does not apply to it. The rule is
  the same in an element body over an array of references, over an
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
- An element of a collection that is the result of a per-element
  construct, such as a `map` or a `filter`, is keyed by the key of the
  upstream element it came from. A change of one upstream element then
  evaluates that element's nodes through a chain of such constructs,
  and no other element's. Where the source is plain values that one
  computation produces as a whole array, an implementation may evaluate
  the whole collection again on each change in place of keeping results
  per element, and the observable result is the same.
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
    (A9). Such a callee is compiled into the surrounding instance and
    cannot be in another space. It either always makes a child instance or
    is refused.
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
    §2.8, question 33). *Assumed:* it finds the stored state where that
    is not yet deleted, as an element whose key returns does. A link to a
    torn-down instance held elsewhere reads the last stored values. For
    a child of an element body this holds over an array of references,
    an array of plain values in place, and the result of another
    per-element construct alike: the key returns when the same resolved
    address, the same value, or the same upstream key stands in the
    collection again.
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
125. **How a result path of a binding names a position inside an
    element** (PL question 78). *Assumed:* a `*` at the position of
    each enclosing collection. Two collections spread into one array
    of children are not told apart by the path. The path names a
    position of the stored result, so the question is the same over an
    array of references, an array of plain values in place, and the
    result of another per-element construct.
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
130. **A result path of a stream that the elements of a collection
    hold** (PL question 84). A stream inside a value that one element
    holds, as `example[UI]` over an array of the results of patterns
    in `patterns/examples/cfc-trusted-component-examples/` (208
    bindings). By ruling `Binding.result` lists every position of the
    result at which value code can place the stream, and a marker at
    a position no listed path covers fails the evaluation, so the
    binding cannot be left without a path through the collection.
    *Assumed:* the path is listed with `*` at the collection, which
    the check matches at any element, and a reader of the plan alone
    tries each position. The alternative names the position of the
    member in the place of `*`. The source here is an array
    written in place in the pattern body, whose members the instance
    computes: not a stored array of references, and not the result of
    a per-element construct.
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
     names. The alternative holds the collections alone, as the
     prototype's artifact does. Open with it: whether `Cone.entry` is
     unique in a plan without the `site` steps. The question is the
     same for a collection over an array of references, over an array
     of plain values in place, and over the result of another
     per-element construct: a `site` step names a call and no
     collection.
144. **What the check of a stream's position covers** (ES question
     78). By ruling value code places a stream with `host.stream`, and
     the runtime replaces the marker by the link when it stores the
     value and checks the position against `Binding.result`. The
     ruling names the positions `Binding.result` lists, which are
     paths of the result. Three things it does not determine, each
     *assumed:*
     - A marker in a value stored outside the result, such as a
       side-write or a path of a child's argument that a cone
       computes, is replaced by the link and is not checked, because
       `Binding.result` lists no such position. The alternative
       refuses a marker there, or gives `Binding` a list for those
       positions.
     - A marker at a path of the argument that a value function gives
       a sandboxed body is handed to the body as a reference to the
       stream, as any reference at that path is. The alternative
       refuses it.
     - A listed path at which no selection stores the stream is not
       found by the check, which is of stored markers alone. The
       compiler owes that it lists no such path, and nothing verifies
       it. The 12 listed paths of the prototype's run that hold no
       stream were not examined, so it is not known whether they are
       below a conditional or are such paths.

     The three are the same in an element body over an array of
     references, over an array of plain values in place, and over the
     result of another per-element construct.
145. **What a cone stores that passes on an element that is a plain
     value** (ES question 79). By ruling a move moves the results of the
     element's key and evaluates nothing for the element. A link to the
     position of a plain value stored in place names another value
     after a move. *Assumed:* such a cone stores the value in the
     element's result, and no link to the position, so that the row
     shows the right value once its results have moved with the key.
     The alternative stores the link and has the move rewrite it. The
     question is about an array of plain values in place. Over an array
     of references the result holds the link to the cell, which a move
     does not change. Over the result of another per-element construct
     the position of the upstream result is not stable on a move
     either, and the assumption is extended: the result holds what the
     upstream position holds, the value or the link to a cell.
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
     101). By ruling an element of the result of a per-element
     construct is keyed by the key of the upstream element it came
     from, and a `flatMap` can yield several elements for one upstream
     element. *Assumed:* the key is the upstream key together with the
     count of earlier elements that the same upstream element
     contributed. This is the case of the result of another per-element
     construct. The assumption is the same whether a segment holds
     references or plain values in place; the alternative keys a
     reference by the address it resolves to and a plain value by its
     value, under the upstream key.
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
     today's two answers.
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
  tier of an element body is addressed by no document. The gap is the
  same over an array of references, an array of plain values in place,
  and the result of another per-element construct.
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
  value passed on unchanged refers into what the write replaces.
- **Defects of the prototype that the value comparison depends on:** a
  pattern compiled in at a call inside an initializer is evaluated in
  the caller's cone; the cone of an array written in place lists no
  slot of what its members hold; a constant captured by a handler that
  is not a literal at the binding is held as `null`; no code is emitted
  for a `reduce` in the reactive tier or a spread in the argument of a
  pattern; and 8 modules with 23 differing values, and 8 modules whose
  value code fails, are not examined.

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

## Next work

1. **The owner rules** on the questions above. A ruling is added to
   [Decided](#decided) and the question removed.
2. **Stage 2 of the overview's staging,** on branch
   `claude/compiled-pattern-prototype`: after the front end, the subset
   type checker, then footprint analysis, and then the corpus numbers
   that need types. A place where the prototype finds the specification
   ambiguous or not implementable is corrected in the document that owns
   the rule.
3. **Post the drafted description to specs pull request #91** and ask for
   its review, when the owner decides it leaves draft.

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
