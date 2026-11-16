# pattern-compiler

A prototype of the front end of the compiled pattern language, which
[`docs/specs/compiled-pattern-language/`](../../docs/specs/compiled-pattern-language/README.md)
proposes. The language is a subset of TypeScript, and the design gives it a
compiler of its own, written in Rust. This crate is the first part of stage 2 of
that design's staging: it shows how much of the pattern corpus the rules of the
subset accept.

Nothing in the repository depends on this crate, and no continuous-integration
job builds or tests it. It is not a Deno workspace member.

## What it covers

- **Parsing.** `.ts` and `.tsx` modules, with a position for every diagnostic.
- **The module model.** Each module's imports, its module-scope definitions, its
  exports, and whether it begins with the `"use typescript";` directive. A name
  from `commonfabric` is recognized by resolving it through its import, never by
  how it is written.
- **Tiers.** Every function body is classified as module scope, the reactive
  tier, the function tier, or imported TypeScript, as
  [`language-subset.md`](../../docs/specs/compiled-pattern-language/language-subset.md)
  §1 defines them. Each body is recorded with its kind, where it is written, the
  body that encloses it, what it captures, and the runtime calls it makes.
- **Rules.** The rules of `language-subset.md` §3, §4, and §5 that syntax and
  name resolution decide, and the rules of §7 and §8 that the type of an
  expression decides, reported under the identifiers of that document's §10. The
  promotion criterion of its §6.1 is applied by syntax and with types, and the
  typed outcome decides wherever every type it reads is evaluated.
- **The corpus report.** How many modules of `patterns/` are accepted, the count
  of each diagnostic, the number of bodies of each kind, and the count of each
  removed form.

- **Value code.** For each plan, the JavaScript an executor calls to compute
  what the plan describes (`src/emit.rs`), and a minimal executor of the two
  (`exec/`). "Value code and the executor" below says what they cover.

## What it does not cover

It emits no label code: a label is instantiated from the plan's templates, and
the value code computes values alone. Its footprint analysis
(`src/footprint.rs`) fills in the `Body` record of
[`footprint-analysis.md`](../../docs/specs/compiled-pattern-language/footprint-analysis.md),
and `src/plan.rs` emits a first slice of the plan of
[`plan-and-label-templates.md`](../../docs/specs/compiled-pattern-language/plan-and-label-templates.md)
§1.1 as JSON: the records without their hashes and constraints, and with the
label templates of §3 for expression code, a use of a body, a `select`, a
`pick`, a `fold`, a collection, a write edge, an operation, and a binding. A
constructed value, a rendered tree included, has an entry per path. A slot holds
the JSON schema of the type at its path and the label its annotations declare,
where the emitter has the type of the slot's root (`src/schema.rs`), and the
plan lists the constraints of `plan-and-label-templates.md` §4.4 that come from
the annotations a body reads and writes under. The `cfc-flow:*` diagnostics are
reported where `plan-and-label-templates.md` §4.4 has the compiler decide them
on declared labels (`src/flow.rs`; notes 167 to 172 of `SPEC-NOTES.md`).
`plan path/to/module.tsx` prints the plan of each pattern,
`plan --corpus <patterns directory>` counts the modules a plan is emitted for
with no unsupported construct and the records that have a template, and
`plan --corpus <directory> --sites` lists each unsupported construct with its
file, line, and text. `SPEC-NOTES.md` lists what it leaves out. Its type checker
resolves written types and the declared types of bindings, infers the types of
call results, standard-library members, operators, literals, and callback
parameters, narrows a reference by the conditions around it and by the
assignments to a `let`, and decides assignability (`language-subset.md` §7.5) at
four sites: an argument, an attribute of a tag that names a pattern, a returned
value under a written return type, and an initializer under an annotation. The
arguments of a pattern, of a handler, and of a `lift` result written in the
reactive tier are bound by reference (§7.5.2), and the argument of a pattern
instantiated in a function body is accepted under the same conditions (§7.5.3).
The body of a `pattern` reads an optional property of its input whose type
declares a default without `undefined` (§7.6.1). It does not check a generic
function per instantiation, and it does not apply assignability at an assignment
or at the argument of a handle method. Where it has no type for an expression,
the expression is counted under the reason, and a rule that needs the type
counts the site as not decided and reports nothing. `SPEC-NOTES.md` lists the
places where the specification was ambiguous or could not be implemented as
written, with the reading this crate chose.

`compare/` holds a first form of the comparison of stage 3: a TypeScript
evaluator of the templates of `plan-and-label-templates.md` §3.2
(`compare/template.ts`), a harness that runs a pattern through the existing
transformer and builder and reads the stored labels of its slots and outputs
(`compare/harness.ts`), fixtures, a generator of scenarios
(`compare/generate.ts`), and a run over the corpus (`compare/corpus.ts`). The
harness resolves a slot of root `argument`, `element`, `state`, `binding`, and
`event`. It sends an event to the stream of a binding and compares the write
edges of the handler's body with the labels at the paths that event's run wrote.
It evaluates the templates of those edges on what is stored before the event,
compares no edge of an event the runtime did not commit, and compares no row
whose label the runtime fails to read. It finds the branch of a `select` and the
child of a `pick` from the values the run stored. Every kept output carries the
atom of the plan's pattern, and a row whose atom names the pattern where the
runtime's names other code is counted in a category of its own. The position of
a tag that names a pattern is read below the `$UI` of the result the run holds
there. The generator gives each top-level input of a plan a value of its type
and a confidentiality atom of its own, and each handler an event of the type its
event declares. An `identity` slot has the label of the link at the position
that holds the reference, and is joined with a value read of its path only where
an output passes the reference on. A write row is compared beside the label the
target's type declares, and the slot of a handle its body only passes on has the
stamp of the link without the entry of origin `link`. A binding of an element
body gets its event at the last element of each enclosing collection, and its
write edges and state are evaluated with that element bound. A state cell of
another instance, an element's or a compiled-in pattern's, is read from the
manifest of that instance's result document. An output that passes on a
reference the instance computed is compared with both sides reading the cell the
stored link leads to. The static part is separated by document.

Run the tests from the repository root with
`deno test -A base/pattern-compiler/compare/test/`, and print the tables of the
fixtures with `deno run -A base/pattern-compiler/compare/report.ts`. The run
over the corpus needs the release build of the crate:

```sh
deno run -A --no-check base/pattern-compiler/compare/corpus.ts run results.jsonl
deno run -A --no-check base/pattern-compiler/compare/corpus.ts report results.jsonl
```

`run` takes each module the crate emits a plan for with no unsupported
construct, skips the ones that need `wish` or request an effect, and appends one
line per module to the results file. It sends the events of the handlers bound
in no element body and no pattern compiled in first, and with `--plan-order` it
sends every event in the order of the plan's bindings. `report` prints the
modules run and skipped by reason, the outputs and write edges compared by
category, what was not compared by reason, each output classified without the
atom of a kept output and with it, the events committed and refused with the
runtime's reason for each refusal, the looser rows by what differs, and the
outputs the run holds no value at by what the run stores there, with one example
each. Notes 177 to 186, 191 to 193, and 197 on of `SPEC-NOTES.md` say what the
comparison takes as each side's label and what it found, notes 217 to 227 why
the runtime refuses an event and what the generator does about it, notes 228 to
240 what ruling U1 and the comparison rules of PL §3.1 changed, notes 241 to 251
the events for handlers bound in an element body or in a pattern compiled in,
and notes 252 on the order of the events and the state a write row is compared
on.

`compare/cost.ts` measures what compiling and running the same modules costs
today: the time of today's compile by phase, and for each module's generated
scenario the wall time, the transactions, the runs of a scheduler action, and
the documents and label entries stored. `compare/cost-model.ts` derives from a
plan the counts the design fixes for the compiled path, which nothing runs: cone
instances, transactions, documents, and label entries. The crate's `time`
command times the crate on the files of each module's program. From the
repository root:

```sh
deno run -A --no-check base/pattern-compiler/compare/cost.ts closures closures.json
base/pattern-compiler/target/release/pattern-compiler time patterns closures.json > crate-time.jsonl
deno run -A --no-check base/pattern-compiler/compare/cost.ts compile closures.json compile.jsonl
deno run -A --no-check base/pattern-compiler/compare/cost.ts processes closures.json processes.jsonl
deno run -A --no-check base/pattern-compiler/compare/cost.ts run run.jsonl
deno run -A --no-check base/pattern-compiler/compare/cost.ts scale scale.jsonl
deno run -A --no-check base/pattern-compiler/compare/cost-report.ts .
```

Notes 273 on of `SPEC-NOTES.md` have the method, the tables, and what is a
measurement and what is derived.

The `catalog` command prints, for each entry of the diagnostics catalog, whether
the crate implements it, implements the part syntax decides, leaves it to the
type checker or to footprint analysis, or lists it as retired.
`tests/catalog.rs` compares that table with the identifiers in the
specification, so the two cannot differ without a failing test.

## Value code and the executor

`emit path/to/module.tsx` prints, for each pattern of the module, one artifact:
the plan, its schema documents, and under `code` the value code with what an
executor needs beside the plan. `src/emit.rs` writes the value code from the
same walk that fills in the plan: `src/plan.rs` records what each name and each
expression of the reactive tier denotes, and the emitter rewrites the source
with those records. A name that denotes a slot becomes `$h.slot(i)` for a slot
its cone lists, a value of another cone becomes `$h.output(i)`, a use of a
sandboxed body becomes `$h.invoke(body, computed)`, a type annotation is
removed, and a JSX element becomes a call that builds a view node. `$h` is the
host object of `execution-and-storage.md` §2.2.

The artifact's `code` has these members.

| Member                | Holds                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `modules`             | One JavaScript text per module: the module's own code of module scope, then a registration for each function the plan needs of it |
| `values`              | For each value a cone computes: its cone, its entry of `Plan.outputs`, and whether it has a value function                        |
| `outputsBelow`        | The interim outputs at a path below a value                                                                                       |
| `handlers`            | For each handler body: whether its state is its second parameter or what it captures                                              |
| `unlistedReads`       | The reads the value code makes of a place that no slot of its cone names                                                          |
| `valuesWithoutOutput` | The values the code refers to that have no entry of `Plan.outputs`                                                                |
| `unsupported`         | The constructs the emitter writes no code for                                                                                     |

A cone's record in the plan has `within` (PL §1.4, "The `within` of a cone"):
the `element` step of each element body the cone's code is written in, outermost
first, and the `site` step of each pattern compiled in around it. The executor
takes from the `element` steps which instances of a cone exist and under which
keys what an instance holds is kept. That is the same for a collection over an
array of references, over an array of plain values in place, and over the result
of another per-element construct.

An entry of `Body.reads` of the plan holds the slot and the path in the body's
argument at which the slot's value is placed (PL §1.1, `ReadInput`), and the
executor builds the slot part of the argument from those entries.

A path of the argument of a pattern compiled in that the call leaves out is
bound to the default the callee's argument type declares for it, as a constant:
the setup function holds it, and the state of a binding that captures it has it
as `place.constant`. A path the call binds to a slot of the caller reads that
default where nothing is stored at the slot. Expression code reads the slot
through `$rt.or`. For a sandboxed body the entry of `Body.reads` holds the
default (`ReadInput.default`, ruling Z16), value code passes `$h.invoke` nothing
for it, and the executor puts it at the entry's place where the slot yields
nothing and its own place declares no default. Where code of the callee passes
the path on by reference, value code gives the reference the default
(`$h.withDefault`), and the stored link holds it in its schema. A read through a
chain of links reads the default of the last link that declares one, and the
reader's own where no link does (`Store.locate`). The state entry of a binding
of the callee whose place is such a slot has the default in a member `default`,
as the documents assume. The crate gives a reference the default where the value
code of the callee stores it. Where code of the caller names a path of the
callee's result, the crate resolves it to the caller's slot at compile time and
writes a read of that slot with no default, which is a defect of the crate.

A module's text registers a setup function for the pattern (`$rt.setup`) and for
each pattern compiled into it, and each setup function registers a value
function per value (`$rt.value`), the function of the body of each element
construct (`$rt.element`), the function of a first value of a state cell that is
not a constant (`$rt.state`), and the function of a handler written in place
(`$rt.handler`). The function of a sandboxed body is registered in the module it
is written in (`$rt.body`).

The name a pattern binds to `[SELF]` is, in value code, a reference to the
result cell of the instance (`$rt.self`, ruling Z17): where value code places it
in a value the executor stores a link to the result document, in the pattern's
body and in an element body alike (`compare/fixtures/self.tsx`). The state entry
of a binding that captures the name has no `place`, and the executor hands the
handler nothing for it.

A `reduce` in the reactive tier registers two functions where it is written
(`$rt.reduce`): that of its initial value, in the cone the `reduce` is written
in, and that of its step, which reads the accumulator as the slot of root
`operation` its cone lists. The executor evaluates the step once per element of
the collection the step's cone is written in, in the order the collection
iterates (`compare/fixtures/reduce.tsx`, over references, over plain values, and
over the result of a `map`).

A first value of a state cell that is a constant is the default of
`StateCell.schema`, and no code gives it. Any other first value is computed by a
cone that has a write edge with target `state`, which `StateCell.first` names.
The executor always stores such a value as a value: a reference the value
function returns is stored as what it resolves to then, so a write to the cell
never lands in the input (ruling Z15). A cell of an element body whose first
value is the element holds the element's value, over an array of references,
over an array of plain values in place, and over the result of another
per-element construct. A write below the root of a cell that has no document
creates the document from the default with the write applied (ruling Z14;
`compare/fixtures/state-below.tsx`, with a cell in each of the three kinds of
element body).

`exec/executor.ts` runs an artifact on an argument, with Deno: it loads the
module texts, makes the argument document and the result document in memory,
writes a first value that is not a constant once when its cell is created, makes
the document of a state cell with the first write to it and reads the default of
the cell's schema until then, evaluates the kept outputs and the result,
evaluates the body of an element construct once per element key, and handles an
event by running the handler's body and evaluating again what read a position
the body wrote. It instantiates no label, checks no constraint, persists
nothing, and answers every effect as pending. It does not narrow a slot to its
observation class and does not evaluate the debug strings. A function body can
instantiate a pattern and bind a handler (ES §2.8). In value code the marker of
each `pattern(...)` holds the identity of the pattern, the entry that the
pattern's own `Plan.patterns` begins with, so the factory value a body calls
names the callee, in whichever module it is written. The executor is given the
artifacts of the program (`options.artifacts` of `Instance`), finds the callee's
among them, and makes an instance of it with documents of its own in the same
store, named from the instance that made it, the run of the body, and the
ordinal among what that run made. The run of a `lift` or a `computed` is named
by the body and its element keys, and the run of a handler by its event. A
handler that a body binds has a stream named the same way, and an event for it
runs the handler with the state the body bound
(`compare/fixtures/instantiate.tsx`). The record `Child` of the crate's plan has
no `callee`. The record of a key of a list (`elementById`) is a place of its
own, named by the list and the key, which has a document once something writes
it, and `addUnique` and `removeByValue` change the list's membership by
reference. The record is a cell of its own and no member of the list until a
reference to it is added (ruling Z23): a write through the handle is a write to
the record, at no position of the list, and makes no reader of the list stale.
The plan has no record that names it: the body's write edge and envelope are at
`*` below the list, as `footprint-analysis.md` §7 records the handle, and the
executor reads them for its count of covered writes alone. A record that a
function body puts into an array through a handle, with `push`, `addUnique` or a
`set` of the list, gets a document of its own, and the list stores a link to it,
as today's runtime does (`anchorValueAsEntity` in
`runtime/runner/src/data-updating.ts`): the list is then an array of references.
A record of the argument the instance is created with, and a plain value that is
no record, stay in the list's document, which is the case of an array of plain
values in place. From the repository root:

```sh
base/pattern-compiler/target/release/pattern-compiler emit path/to/module.tsx > artifact.json
deno run -A base/pattern-compiler/exec/run.ts artifact.json argument.json
deno test -A base/pattern-compiler/exec/test/
```

An output whose value is, on every evaluation, the assembled result of an
element construct passed on unchanged has `passesCollection` in the plan, which
names the record of the collection (ruling Z13): the crate marks a promoted
`computed` whose expression is such a result or a marked output. A construct
whose source is a marked output has the element table of that collection in the
executor, with the keys of the source elements, whether those are references or
plain values in place (`compare/fixtures/passes-collection.tsx`). Where the
output has no mark, the executor keys by what the positions of the output hold.

The executor keys an element of the result of a `map`, a `filter` or a `flatMap`
by the key of the element it came from, so a change of one element evaluates
that element's cone instances down a chain of constructs and no other element's.
An element of the result of a `flatMap` has that key together with a part formed
from the member itself (ruling Z22): the identity of the cell for a member that
is a reference, and the value for a member that is a plain value, with the count
of the earlier equal members of the same segment. The position in the segment is
in no key, so two members of one segment that change places keep their keys, and
nothing is evaluated for them in a body over the result
(`compare/fixtures/flat-keys.tsx`: a segment of plain values and a segment of
references that the source element holds, over a source of references, and a
segment of plain values that the callback writes, over a source of plain values
in place). A member that is a plain value and whose value changes is another
key. A segment that is the assembled result of another per-element construct has
the keys of that result, as the documents assume, with no test. When elements
move it evaluates nothing for them but what read the index: the entries of a key
stay with the key. `Instance.counts` has the evaluations of cone instances of an
element body (`elementEvaluations`) and the assemblies of a collection
(`assemblies`) apart.

When a key leaves its collection, the executor drops the cone instances of the
key and deletes nothing that is stored under it (ruling Z18): a state cell the
body declares keeps its document, and an element that returns under the same key
has new cone instances, which read what the cell held. The key returns when a
link to the same cell stands in an array of references again, when the same
value with the same occurrence count stands in an array of plain values in place
again, and when the upstream key enters the result of another per-element
construct again, as an element that a `filter` dropped and keeps again does
(`compare/fixtures/key-returns.tsx`, with a body over the result of a `filter`
of references and one over the result of a `filter` of plain values in place).
The executor has no state of an operation to keep, and no child of a body.

An element that is a plain value in place is named by its collection and its key
(ruling Z12). The executor holds such a reference as a path whose segment at the
array is the key and not a position (`keySegment` in `exec/store.ts`), and a
read or a write through it finds the position that holds the key at that time
(`Store.locate`). A cone, a handler bound in the body and a function body that
read the array through a handle are all given that reference, and what passes
the element or a member of it on stores it. A read through it depends on the
value at the key and the path and on no position, so a move evaluates nothing.
`equals` compares two such references as the collection, the key and the path
they hold and resolves no key, and a reference by key is not equal to a
reference to a cell or to a handle that names a position. After the element is
removed a read gives nothing, and a write is refused, which rejects a handler's
event. A write that changes the value leaves the position with another key, and
the reference keeps the key it was made with, as the documents assume: a second
write through it is refused. `compare/fixtures/value-identity.tsx` and the tests
of "an element that is a plain value in place" in `exec/test/executor.test.ts`
show each of these over an array of plain values in place, and beside it what
holds over an array of references, where the element is a cell and nothing of
this applies. An element of the result of a `map` whose body computes a value is
passed on as that value: the executor stores no assembled result at an address a
reference could name.

A cone with side-writes has its kind in `Cone.sideWrites`, from the tier
footprint analysis gives its bodies: `static` where every write target is one
the compiler names, and `materializer` where a target is reached through data.
The executor evaluates a `static` cone when something it evaluates reads the
target of one of the cone's write edges or passes that target on by reference,
before that reader, and not otherwise. It evaluates a `materializer` cone after
the rest of a wave, where an input of it changed, and what the cone writes makes
its readers stale for the next wave. `Instance.trace` lists the cones evaluated,
in order. `plan --corpus` counts the cones of each kind.

Value code places the stream of a binding by calling `$h.stream(binding)` and
putting what it is given at the position (ES §2.2, "Value code places a
stream"). The executor gives it a marker with no member: the code cannot send to
it or read through it. When the executor stores a value, it writes in the
marker's place the link to the stream of that binding for the element keys of
the cone instance that called. For a marker at a position of the result it
checks that a path of `Binding.result` covers the position. An entry of
`Binding.result` holds the path and, for each `*` of it, what the `*` stands for
(`ResultPath.stars`, ruling Z21): `element` for a collection the binding has an
`element` step for, `every` for a collection whose callback writes the one
stream of a binding made outside it, `member` for the one position of a member
written after a spread, with the number of entries written before it, and
`inside` for a collection of which one element holds the stream inside its
value. The check accepts a marker at a `*` only at a position of the stated
kind: for `element` the position that holds the key of the cone instance that
placed the marker, for `every` and `inside` an element of a collection and no
member written beside it, and for `member` the member written at that entry. The
executor knows which it is from how it assembled the array: value code hands it
the entries of an array that has a spread, and of the children of a view node,
apart (`$rt.list`, `$rt.spread`, `$rt.children`), and the assembled result of a
`map`, a `filter` or a `flatMap` has the key of each position
(`compare/fixtures/star-kinds.tsx`). The harness of the comparison resolves a
listed path from the plan and the kinds (`streamAt` in `compare/harness.ts`). It
does not resolve a path through two collections spread into one array, since the
kind does not say which of the two a `*` stands for. A marker at a position no
listed path covers fails the evaluation that stores it (ruling Z19): the kept
output that holds the position is not written and keeps what was stored for it,
which is nothing where nothing was stored, and every other output of the result
is stored. `Instance.failures` has, for each such marker, the output, its path
with the index of the element in the place of a `*`, the binding, and the
position. For a cone of an element body the output that fails is that of the
element whose row holds the position, and the rows of the other elements are
stored, over an array of references, over an array of plain values in place, and
over the result of another per-element construct alike. So the crate lists a
path for every position at which value code can place a stream: also for a
member written after a spread, for two collections spread into one array, and
for a stream inside a value that the elements of a collection hold. A stream
that is an input of the pattern is a reference like any other input, and what
passes it on stores a link to its place. A sandboxed body that is handed a
marker in its computed argument gets a handle to the stream, and a stream that a
body returns into the result is stored as the link to it and checked against no
listed path (ruling Z20; `compare/fixtures/stream-returned.tsx`). This is the
same for an element body over an array of references, over an array of plain
values in place, and over the result of another per-element construct.

`compare/values.ts` compares the values the executor computes with those of
today's runtime: the members of the result and the state cells of the pattern's
own body, after the instance settled and after each event.
`compare/values-fixtures.ts` runs the fixtures, and `compare/values-corpus.ts`
the corpus:

```sh
deno run -A --no-check base/pattern-compiler/compare/values-fixtures.ts
deno run -A --no-check base/pattern-compiler/compare/values-corpus.ts run values.jsonl
deno run -A --no-check base/pattern-compiler/compare/values-corpus.ts report values.jsonl
deno run -A --no-check base/pattern-compiler/compare/values-corpus.ts again values.jsonl again.jsonl
```

`run` keeps what today's runtime computed in the results file, and `again` runs
the executor alone on the crate's current output against it. Before each event
the comparison seeds `Math.random` alike on both sides (`compare/random.ts`), so
a handler that draws a number, as the shuffle of
`patterns/showcase/card-piles/main.tsx` does, draws the same one in today's run
and in the executor's (`compare/fixtures/random.tsx`). Notes 281 on of
`SPEC-NOTES.md` list what the executor needed that the plan and the documents do
not give, and what the comparison found. Notes 307 on say what the rulings of
2026-11-16 on those needs changed in the crate and the executor, what they leave
undetermined, and the figures of the comparison after them. Notes 325 on do the
same for the rulings on `Cone.within` and on who places a stream, and for
`reduce`, the record of a key of a list, and the keys of the result of a
`flatMap`. Notes 344 on have what today's runtime stores when a record gets into
a list, and rulings Z12 to Z17.

## The parser

The crate parses with the [`oxc`](https://oxc.rs) crates and does not tokenize
or parse TypeScript itself. `oxc` was chosen over `swc` for three reasons: its
scope analysis (`oxc_semantic`) resolves every identifier to its declaration,
which the rule "resolve a name through its import" needs; its syntax tree keeps
TypeScript type syntax and JSX in one tree with byte spans; and it compiles in
seconds with few dependencies. The crates are pinned to `0.133.0`, the newest
release that builds with the Rust 1.93 toolchain.

## Layout

| Module                   | Holds                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `parse`                  | The call into the parser and the scope analysis                                                                                     |
| `module`                 | The module model: imports, definitions, exports                                                                                     |
| `api`                    | The `commonfabric` exports, the methods of a cell handle, and the standard-library surface of `language-subset.md` §9               |
| `tiers`                  | The records of bodies, captures, and call sites that the later stages read                                                          |
| `check`                  | The walk that classifies code into tiers and applies the rules                                                                      |
| `types`                  | The representation of types, the resolution of written types, and the rules it decides (`language-subset.md` §7, §8)                |
| `declared`               | The declared type of a binding and of an expression that names one                                                                  |
| `infer`                  | The types no declaration gives: call results, standard-library members, operators, literals, and callback parameters                |
| `narrow`                 | The type of a reference where a condition has been tested (`language-subset.md` §7.6)                                               |
| `assign`                 | Assignability (`language-subset.md` §7.5, §7.5.1, §7.5.2) and the sites it is checked at                                            |
| `typed`                  | The other catalog rules that read the type of an expression: property reads, casts, pattern results, generic calls                  |
| `footprint`              | What a function body reads and writes of its inputs (`footprint-analysis.md` §2 to §7), and where the analysis widens               |
| `plan`                   | The plan of a pattern as JSON: slots, bodies for each use, bindings, cones, outputs, and edges (`plan-and-label-templates.md` §1.1) |
| `emit`                   | The value code of a plan: the JavaScript of each module, and what an executor needs beside the plan                                 |
| `program`                | A set of modules, the resolution of imports between them, and the rules that follow a call into another function                    |
| `catalog`, `diagnostics` | The diagnostics catalog and the diagnostic record                                                                                   |
| `corpus`, `report`       | Which files are the corpus, and the report over them                                                                                |

Footprint analysis reads the body records of `tiers`. The corpus report prints
its counts under names that begin with `footprint:`, in the form of
`footprint-analysis.md` §11.3 to §11.5, and `footprint path/to/module.tsx`
prints the record of each body.

## What the corpus report counts for the type checker

Beside the diagnostics, `corpus` prints counts whose names begin with `types:`.
`types:receiver:` and `types:collection:` say, for the receiver of each method
call and for each per-element collection, whether it has a type, and if not,
why. `types:written:` says how far each written type was evaluated.
`types:assignability:` says, for each argument by its callee and by where the
call is written, and for each attribute of a pattern tag, returned value, and
initializer, whether it is assignable, refused (with the kind of difference), or
not decided. `types:rule:` says the same for the rules of `typed`.
`types:by-reference:` counts each value bound where a writable handle is
declared by what the value is, and `types:sites:` counts the sites the open
questions of the specification ask about: a handle of a known type given where a
handle of `unknown` is declared, a write through a handle of `unknown`, a type
name of the DOM library, and an argument of an authored function called in the
reactive tier that is not accepted. `corpus --sites` lists those sites with
their source text. The report also prints the promotion of `computed` by the
syntactic and by the typed criterion, and the calls the two decide differently.

`tests/narrowing.rs` reads the type of an expression through
`program::types_at_markers`, which takes a source text with `/*?*/` before each
expression of interest.

## Build, test, and run

```sh
cd base/pattern-compiler
cargo build --release
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check

cargo run --release -- catalog
cargo run --release -- check path/to/module.tsx path/to/other.ts
cargo run --release -- check --hints path/to/module.tsx
cargo run --release -- bodies path/to/module.tsx
cargo run --release -- footprint path/to/module.tsx path/to/other.ts
cargo run --release -- types path/to/module.tsx
cargo run --release -- corpus ../../patterns
cargo run --release -- corpus ../../patterns --json
cargo run --release -- corpus ../../patterns --files
cargo run --release -- corpus ../../patterns --diagnostics
cargo run --release -- corpus ../../patterns --sites
cargo run --release -- plan path/to/module.tsx
cargo run --release -- plan --corpus ../../patterns
cargo run --release -- plan --corpus ../../patterns --json
cargo run --release -- emit path/to/module.tsx
cargo run --release -- emit --corpus ../../patterns
```

`check` takes the modules of one program: an import between two of them is
resolved, and an import of a module that is not given is left unresolved.
`bodies` prints the body records as JSON. `corpus` takes the path of the
`patterns` directory, prints the report, and exits with a failure when a module
does not parse. The corpus is the set of files the corpus measurement beside the
specification uses: the files `deno task cfcheck` compiles, with what they
import by relative path, without the files that share no program with pattern
code.

## The specification it implements

The crate follows `language-subset.md` as it stands at commit `8bc4a3001a`.
`catalog-ids.txt` holds the identifiers of that document's catalog, and
`cargo test` fails when the document's catalog and the copy differ. To follow a
change of the catalog, edit `catalog-ids.txt` and the table in `src/catalog.rs`
together.
