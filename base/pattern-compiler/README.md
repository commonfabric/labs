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
stamp of the link without the entry of origin `link`. An event is sent where the
executor of `exec/`, which runs beside today's run, stored the link to the
stream ("Value code and the executor", below): a binding of an element body gets
its event at the last element of each enclosing collection whose row holds the
stream, and its write edges and state are evaluated with that element bound. A
state cell of another instance, an element's or a compiled-in pattern's, is read
from the manifest of that instance's result document. An output that passes on a
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
construct, skips the ones that request an effect, and appends one line per
module to the results file. A module that calls `wish` runs in a seeded home
(`compare/wish-home.ts`, under "The serving loop, error states and effects"
below), and is skipped where its executor resolves a `wish` the home does not
simulate. It sends the events of the handlers bound in no element body and no
pattern compiled in first, and with `--plan-order` it sends every event in the
order of the plan's bindings. `report` prints the modules run and skipped by
reason, the outputs and write edges compared by category, what was not compared
by reason, each output classified without the atom of a kept output and with it,
the events committed and refused with the runtime's reason for each refusal, the
looser rows by what differs, and the outputs the run holds no value at by what
the run stores there, with one example each. Notes 177 to 186, 191 to 193, and
197 on of `SPEC-NOTES.md` say what the comparison takes as each side's label and
what it found, notes 217 to 227 why the runtime refuses an event and what the
generator does about it, notes 228 to 240 what ruling U1 and the comparison
rules of PL §3.1 changed, notes 241 to 251 the events for handlers bound in an
element body or in a pattern compiled in, and notes 252 on the order of the
events and the state a write row is compared on.

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

## The interim acceptance of `patternTool`

By the owner's ruling of 2026-11-19 the crate accepts a call of `patternTool`
for an interim period, so that one pattern source runs in today's runtime and is
compiled by the crate. `src/tool_rewrite.rs` replaces the call in the module's
text before any other stage reads the module, by an inline pattern closure that
calls the pattern with the bound values (`language-subset.md` §4.4.2):

```text
patternTool(Search, { donuts })
pattern<Omit<Parameters<typeof Search>[0], "donuts">>((rest) => Search({ ...rest, donuts }))
```

The input type of the closure is the input type of the pattern without the bound
keys. A call with no second argument becomes
`pattern<Parameters<typeof Search>[0]>((rest) => Search(rest))`. For an inline
`pattern<I, O>(...)` as the first argument, the type is `I` as written, and the
inline pattern is the callee of the closure's call. The parameter is named
`rest`, or `rest2` and so on where the call already uses the name. Where the
name `pattern` is not bound at the call, the rewrite adds it to the import that
`patternTool` comes from.

An accepted call is reported with the warning
`removed-form:pattern-tool-interim`, whose message holds the closure. The
identifier is not in the catalog of `language-subset.md`, and `src/catalog.rs`
lists it as provisional. A rewritten call is counted as a `patternTool` call in
the corpus report.

A call is accepted where all of these hold: the callee is the name `patternTool`
imported from `commonfabric`, with no alias, no namespace and no type argument;
the call is in the reactive tier; the first argument is the name of a pattern
declared at module scope or imported, or an inline `pattern(...)` with a written
input type; the second argument is absent or is an object literal whose
properties are plain or shorthand with a key that is an identifier or a string
literal, each key once; and, where keys are bound, the input type of the pattern
is an object type that declares each of them. A call whose result is spread,
read by a member access or called is not accepted, since the closure is not the
record `{ pattern, extraParams }` that today's `patternTool` returns. A call
that holds another `patternTool` call is not accepted either, and the inner call
is decided on its own. Every other call stays in the text and is refused with
`removed-form:pattern-tool`, as `patternTool` used as a value is.

The rewrite is made on the text because the later stages read the text at the
spans of the syntax tree. A replacement holds as many line breaks as the text it
replaces, so every line keeps its number. A diagnostic of a rewritten module is
reported at its position in the text as written, and an offset inside a
replacement is reported at the start of the text that was replaced. The offsets
in a plan and the module text in value code are those of the rewritten text.
Deciding a call needs its tier and the input type of the pattern, so a program
in which some module names `patternTool` is parsed twice, and its modules that
name `patternTool` are walked twice by `src/check`.

The crate does not translate a pattern closure used as a value: the plan lists
it as the unsupported construct "the built-in `pattern` in the reactive tier",
`Plan.closures` is empty, no plan with slots of root `params` is made for the
inline pattern, and the write edge at the path that holds the closure has no
template. Value code for the closure is not what `plan-and-label-templates.md`
§3.15 describes, and the executor holds the request of
`compare/fixtures/pattern-tool.tsx` without the tool. So a module with a
rewritten call is accepted by the rules and has no complete plan.
`tests/pattern_tool.rs` states this for that fixture.

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

A `??`, `||` or `&&` of the reactive tier becomes
`$h.operand(operator, test, () => left, () => right)`. `test` is the left
operand read as its value, inside the `$h.select` that reports the selection
where the plan has a selector for the expression, and `left` and `right` are the
operands as the references they are. The executor passes on the operand that is
selected (PL §3.5): the right one as it is, and the left one as the reference
where it holds a record or an array, so an output that the operator computes
stores the link, and as its value where it holds a scalar
(`compare/fixtures/selected-operand.tsx`). A per-element construct over such a
result runs over the stored array where the left operand is an array of plain
values in place (`compare/fixtures/filter-of-computed.tsx`), and over an array
in memory where the right operand builds one
(`compare/fixtures/filter-of-fallback.tsx`).

The artifact's `code` has these members.

| Member                | Holds                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `modules`             | One JavaScript text per module: the module's own code of module scope, then a registration for each function the plan needs of it |
| `values`              | For each value a cone computes: its cone, its entry of `Plan.outputs`, and whether it has a value function                        |
| `outputsBelow`        | The interim outputs at a path below a value                                                                                       |
| `handlers`            | For each handler body: whether its state is its second parameter or what it captures                                              |
| `dataFiles`           | The files that the `dataFile` calls of the program name, each with its text, which the `emit` command reads                       |
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

Where the body declares a handle at the entry's place, the entry holds
`handle: true` and, where the crate has the type, `schema`: the schema of the
type the body declares for the handle, which is narrower than the slot's schema,
the type of the place, wherever the body names fewer fields. An `identity` entry
of `Body.computed` holds `schema` the same way. A read through the handle is
made under that schema: a member of a record that the schema does not declare is
left out, and the positions of the declared members are the ones read where the
record holds another member, so a change of a field the body's type does not
name evaluates nothing (`Store.locate`, `members`). The read of an `enumeration`
slot gives the members of its container as references, and reads none, where no
slot of the cone reads a child as a value or a shape, or where every body handed
the container is handed a handle at each child (`Host.slot`):
`items.get().length` and a `lift` over an array of references then depend on the
members the array has and not on what a member holds.

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
code of the callee stores it. A state path of a binding of the callee that is
bound to a name whose property the call writes as a literal holds the literal as
its constant. Where code of the caller names a path of the callee's result, the
crate resolves it to the caller's slot at compile time and writes a read of that
slot with no default, which is a defect of the crate.

A name that an `action`, an inline handler or a sandboxed body captures has the
type it is declared with: the slot of root `binding` of the name has the schema
of that type, a handle where a pattern declares one for the property of its
parameter. Where the call of a pattern compiled in binds such a name to a
constant, a literal or the default of a path it leaves out, the body is handed a
handle that reads the constant and refuses a write (`execution-and-storage.md`
§2.4). A handler written in place takes that name from its state, and a
sandboxed body is given `$h.constant(name)`
(`compare/fixtures/action-constant.tsx`, `compare/fixtures/body-constant.tsx`).
A callee that names its whole argument, as `(context) => context`, is given
every path that the call binds (`compare/fixtures/whole-argument.tsx`).

A `const` of the block body of a promoted `computed` is a variable of the block
in value code. Where a per-element construct inside the block names it, as its
receiver or in its callback, the crate also registers a value function for it,
and code that is registered outside the block reads it as an output
(`compare/fixtures/block-const.tsx`, over arrays of plain values in place).

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
of a binding that captures the name has the place `{ result: true }` (ruling
Z28), and the executor hands the handler a reference to the result cell there,
for a binding of the pattern's body and for one of an element body over an array
of references and over an array of plain values in place.

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
element body). A `push` through a handle to a path of the argument that holds
nothing starts from the default that the place declares in the same way (ruling
Z27; `compare/fixtures/push-default.tsx`, with an array of plain values in place
and an array whose default record stays in place while the pushed record is a
reference).

`exec/executor.ts` runs an artifact on an argument, with Deno: it loads the
module texts, makes the argument document and the result document in memory,
writes a first value that is not a constant once when its cell is created, makes
the document of a state cell with the first write to it and reads the default of
the cell's schema until then, evaluates the kept outputs and the result,
evaluates the body of an element construct once per element key, and handles an
event by running the handler's body and evaluating again what read a position
the body wrote. It instantiates no label, checks no constraint of a plan, and
persists nothing. It does not narrow a slot to its observation class and
validates no read against its schema. "The serving loop, error states and
effects" below says how it handles events, a body that throws, and a request of
an effect. `navigateTo` in a handler is a request that the instance holds
(`Instance.requests`) and does not answer. The debug renderers are those of
`@commonfabric/data-model`, and value code gives each operand of one as its
value. A built-in that the executor does not have gives, while the modules are
evaluated, a value whose members can be read and called, so a declaration of
policy at module scope is evaluated, and a call of it in a function body throws.
A function body can instantiate a pattern and bind a handler (ES §2.8). In value
code the marker of each `pattern(...)` holds the identity of the pattern, the
entry that the pattern's own `Plan.patterns` begins with, so the factory value a
body calls names the callee, in whichever module it is written. The executor is
given the artifacts of the program (`options.artifacts` of `Instance`), finds
the callee's among them, and makes an instance of it with documents of its own
in the same store, named from the instance that made it, the run of the body,
and the ordinal among what that run made. The run of a `lift` or a `computed` is
named by the body and its element keys, and the run of a handler by its event. A
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
The executor has no state of an operation to keep. An event for the stream of a
binding of an element body is refused while the key is away. A pattern called
through `asInstance()` is the exception to both, below.

An element that is a plain value in place is named by its collection and its key
(ruling Z12). The executor holds such a reference as a path whose segment at the
array is the key and not a position (`keySegment` in `exec/store.ts`), and a
read or a write through it finds the position that holds the key at that time
(`Store.locate`). A cone, a handler bound in the body and a function body that
read the array through a handle are all given that reference, and what passes
the element or a member of it on stores it. A read through it depends on the
value at the key and the path and on no position, so a move evaluates nothing.
`equals` resolves each operand to the position it names at that time and
compares the two there (ruling Z26). `items.key(i)` is a handle by position, at
the call and when it is stored (ruling Z33), so it is equal to a reference by
key to the element that is at position `i` then, and over an array of references
to the element's cell. An evaluation that calls `equals` depends on the outcome
of the comparison and on no position, so a move evaluates nothing for two
references by key. After the element is removed a read gives nothing, and a
write is refused, which rejects a handler's event.

A write through a reference by key that changes the value leaves the position
with another key, and the element is re-keyed in the same transaction (ruling
Z24). Until the transaction ends, a reference that holds the old key resolves to
the position (`Store.rekeys`), so the writer's later writes succeed and a handle
it stores afterwards is stored with the new key. When the transaction ends the
executor moves the state cells of the old key to the new key, in the body over
the array and in the bodies over the results of the constructs applied to it,
and re-keys an instance called through `asInstance()` with the element. A
reference that was stored elsewhere under the old key reads as nothing
(`compare/fixtures/rekey.tsx`, beside an array of references, where no key
changes).

A function body that reads a plain value in place through a handle holds a copy
(ruling Z25): the value carries no address, writing it to a cell stores the
value, and writing it into an array stores it in place and makes no document for
it. A handle or a state entry that a handler bound in the element body is given
for its element is a reference by key. `compare/fixtures/value-copy.tsx` moves
values between two arrays, keeps one in a cell, and finds the element of a row
with `left.key(at).equals(card)`, and is compared with today's runtime.
`compare/fixtures/value-identity.tsx` and the tests of "an element that is a
plain value in place" in `exec/test/executor.test.ts` show each of these over an
array of plain values in place, and beside it what holds over an array of
references, where the element is a cell and nothing of this applies. An element
of the result of a `map` whose body computes a value is passed on as that value:
the executor stores no assembled result at an address a reference could name.

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
the cone instance that called, wherever the marker is. It checks no position,
and no evaluation fails for where a stream is (ruling Z43). The plan record has
no `Binding.result`: a binding names no path of the result, and a reader that
has the plan alone cannot say where a stream is stored. The store records the
position of each link to a stream that it stores, in whichever document
(`Store.streams`), and `Instance.streams()` gives the positions at which a
reader of the stored result finds one, each with the binding, the keys, and the
position of the element of each enclosing collection. That is the same over an
array of references, over an array of plain values in place, and over the result
of another per-element construct. `compare/fixtures/flat-inner.tsx` has a
`flatMap` whose callback returns an inner `map` that binds a handler, over
references and over plain values in place: the result of the `flatMap` has one
level of positions, and each holds the link for the keys of both collections.

A collection among the children of a view node is stored as one nested child
(ruling Z31), over an array of references, over an array of plain values in
place, and over the result of another per-element construct. A child written
after it has its own position, and two collections among the children of one
node are two child positions. A JSX spread child, and an array literal with a
spread or a hole among the children, is each one child at its written position,
and the literal is stored as one nested array value (ruling Z39;
`compare/fixtures/spread-child.tsx`). Value code writes the members of an array
literal with no spread and no hole among the children as children of their own,
and a view node that a function body builds flattens the arrays it is handed
(`$rt.hf`), as the JSX factory of today does. An array literal with a spread is
an array literal in value code, and a spread in the reactive tier, in a literal
or as a JSX spread child, is given its operand as the reference it is
(`$h.spread`): a position of the operand that holds a link gives the reference
to its cell, so a spread of an array of references stores the links, and a
position that holds a plain value in place gives the value. The result of
another per-element construct gives its members as it assembled them. The
comparison of values flattens the children of a view node on both sides. Today's
runtime runs neither form in the body of a pattern: its transformer refuses a
spread of a pattern value in an array literal, and its JSX factory throws at a
spread child. `compare/fixtures/spread-stream.tsx` writes both in a `computed`,
with a stream at a member after the spread and at a child after two spread
children, and is compared with today's runtime.

A stream that is an input of the pattern is a reference like any other input,
and what passes it on stores a link to its place. A sandboxed body that is
handed a marker in its computed argument gets a handle to the stream, and a
stream that a body returns into the result is stored as the link to it (ruling
Z20; `compare/fixtures/stream-returned.tsx`).

The harness of the comparison finds the stream to send an event to from the
executor's record (`Scenario.streams`, `streamAt` in `compare/harness.ts`). An
executor runs beside today's run and handles each event that today's run
committed, so its record is that of the same events when the next one is sent.
For a binding, the harness takes the positions at which the executor's stored
result holds the link, the last element of each enclosing collection first, and
sends the event at the first of them at which today's run holds a stream. Two
layouts of today's run differ from the executor's, and the harness translates
both: today's run holds the result of a pattern at a child position, with its
tree under `$UI`, and it nests the children of a view node differently, as where
a `map` over an array written in place runs when the pattern is built. A child
is found by the number of children before it, counted with each nested array
flat. A scenario with events and no executor sends none. A binding whose stream
the executor's result does not hold, and a module the executor does not run, get
no event.

On a re-key of a plain value in place (ruling Z24), what the old key holds moves
to the new key: the state cells, the `asInstance()` instance, and the instance
that a `lift` or a `computed` of the element body made, which moves as a child
and keeps its documents (ruling Z41; `compare/fixtures/rekey-made.tsx`). What is
moved replaces what is stored under the new key: the executor removes a state
cell and an instance that a function body made that are named there, the
instance with its documents and with what its own function bodies made. An
`asInstance()` instance that is replaced stays in the store. Nothing moves for a
binding that a function body made, and nothing for another element whose
occurrence count the write changed. A write that is not through a reference by
key re-keys nothing.

A call of a pattern through the factory modifier `asInstance()`, as
`Row.asInstance()({ item })`, is an instance of its own (rulings Z35 and Z36).
The front end accepts the modifier beside `asScope` and `inSpace`. The plan
records the call as an entry of `Plan.children` with `asInstance: true` and the
identity of the compiled pattern as its callee, a write edge with target
`argument` for each path of the argument on the cone the call is written in, and
slots of root `child` for the reads of the result. Nothing of the callee is
compiled into the plan, and no `site` step stands for the call. Value code
registers the function of the argument (`$rt.child`). The executor makes an
instance of the callee's plan with an argument document and a result document of
its own, identified by the child, which stands for the site, and the key of each
enclosing collection. It writes the argument again when what the argument holds
changed. The instance is not torn down when its key leaves, the key that returns
has the same instance, and an event for one of its streams is handled while the
key is away. Over an array of references the argument holds the link to the
element's cell. Over an array of plain values in place, and over the result of
another per-element construct whose position holds a value, it holds the value.
`compare/fixtures/as-instance.tsx` has the call over an array that a test gives
as references and as plain values in place, over an array of plain values, over
the result of a `filter`, and outside an element body, beside the same pattern
compiled in with no modifier. Today's runtime has no `asInstance()`, so the
tests of it are of the executor alone. `Child` of the crate's plan has no
`argumentSchema` and no `resultSchema`, and the documents of an instance that
was re-keyed keep the identifier of the key it was made under.

The array type `ArrayByKey<T, "field">` declares the key of the plain values of
an array (rulings Z37 and Z49), and `ArrayByKey<T, "a" | "b">` declares several
key fields, across which an element has one key (ruling Z45). The front end
reads it as an array of `T` with a key annotation on the array, and the type of
an element carries no key. `KeyedBy` is no type of the language. The schema of
the array has the keyword `keyFields` beside `items`, the names of the fields in
the order of their code points. The record of a collection whose source is a
slot or an output holds a copy (`Collection.keyFields`), and so does the record
of an output whose value has a type that declares the key (`Output.keyFields`),
since the plan holds no schema of an output. Where the receiver of a construct
is typed as a plain array, as the parameter of a pattern compiled in can be, the
record of the collection has the key fields of the array that the place holds.
For a computed value the crate notes them wherever an expression of a type that
declares them denotes the value, so they reach the reader through a property of
an object literal, a record held in a variable, a spread of it, and a second
pattern compiled in between. The type of a `filter` result and that of a `map`
result declare the key fields of the receiver (ruling Z55), and that of a
`flatMap` result declares none. The crate reports `array-by-key:declaration`
where the second argument is not a string literal type or a union of them, or
where a field is not a required top-level property of type `string` or `number`,
and `array-by-key:mismatch` where an array whose type declares one key is given
where the type declares another key. A type that declares no key, on either
side, is no mismatch. It reports the warning `array-by-key:state-without-key`
(provisional decision P21) at a `map`, a `filter` or a `flatMap` whose body
holds a state cell, a handler binding, an operation or a child instance for each
element, where the body reads a member of the element and neither the array nor
the array that a chain of constructs starts at declares a key. The type does not
say whether an array holds plain values in place or references, so the warning
is reported for both: 168 times in 80 modules of the corpus.
`language-subset.md` in this tree has neither identifier, and it does not have
`element-body:result-stored-outside`, which the crate does not report, and it
does not have the warning. The four are in `PROVISIONAL` of `src/catalog.rs`, in
the order of the catalog that has them.

A key is a fabric value, the record of `element`, the element part, and
`occurrence`, the occurrence count, and its written form is the text that the
JSON codec of fabric values gives the record (`jsonFromFabricValue()` in
`base/data-model/src/codecs.ts`). The executor joins no parts with a separator
of its own, in a key or anywhere else (ruling Z51). The element part of a plain
value is the salted hash of the value: the hash that the value hasher
(`hashOf()` in `base/data-model/src/value-hash/impl.ts`) returns for the record
of `salt`, the secret of the space, and `value`, the value as the fabric value
it is (ruling Z57). With declared key fields the element part is the record of
`fields`, the names in the order of their names, and `hash`, the salted hash of
the array of the values of those fields in that order (rulings Z47 and Z48). It
holds no value of a field. The element part of a position that holds a link is
the record of the address that the link names: `space`, where the store was
given one, `document` and `path`, and for a link to an element by key the record
of `collection`, `key` and `path`. The key of a member of a `flatMap` segment is
the record of `source`, the key of the upstream element, and `member`, that of
the member. A plain value with no declared key, and one that does not hold a
string or a number at every declared field, is keyed whole. So the key of a
field `id` that holds 7 is not the key of a whole value 7, and the number 7 and
the string `7` have two keys. The secret is an option of `Store` and of
`Instance`; without it the store mints one. In a stored path a key stands as its
text, and a segment is a key where it decodes to the record of one
(`keyOfSegment` in `exec/store.ts`).

The identifier of a document is the hash of the cause of its creation
(`identifierOf` in `exec/store.ts`), as `execution-and-storage.md` §5.1 has
`createRef` form one: the record of the instance, the type, the steps of
`within` and the name for a state cell, the document of an output, and an
instance called through `asInstance()`; the result document and the type for an
argument document; and the run and an ordinal for what a function body makes. A
key in a cause is the record it is, so no identifier holds the text of a key.
The instance the executor is started with has the identifier `result`, or the
one its `id` option gives. A name of several parts in a plan is a record
(`plan-and-label-templates.md` §1.1, `Name`): `{ name, ordinal }` for one of
several declarations of one name, `{ body, site }` for a thing that a site of a
body makes, and `{ operation, sidecar }` for a sidecar. The names of the memo
and of the element tables are the texts that the codec gives a record. The
identifier of a schema is a placeholder that begins with `unhashed:schema/`,
where the documents have a hash that the crate does not form. The identifier of
a pattern is the hash PL §1.5 states, of the record `{ module, binding }` with
the content-addressed identity of the pattern's module in it, written `sha256:`
and hex (SPEC-NOTES note 208).

The store resolves a reference by key from the key alone (`Store.locate`,
`fieldsOfKey` in `exec/store.ts`): it forms the keys of the array with the
fields that the key names, and with none for a key that names none, and takes
the position whose key is the key. It keeps no schema for a document. That is
the same for a reference to a member below the element, as the one
`owner.set(repo.owner)` stores, and for every reader, whatever key the reader's
type declares. Forming a key uses a declaration: an element table is keyed with
`Collection.keyFields`, and an array that is read whole gives each member a
reference by key formed with the key fields that the schema of the read declares
beside `items`. A reader whose schema declares none forms keys with the key
fields of the array schema that a link on the way to the array holds, and with
the whole value where no link holds one (ruling Z52). A change of a member that
is no key field changes no key: the cone instances that read the changed member
are evaluated, and the state cells and the `asInstance()` instance of the key
stay, for a new array from a computation, a `set` of the whole array in another
order, and a write through a reference by key, which then re-keys nothing. A
write to a key field through a reference by key re-keys the element. A position
that holds a link is keyed by its cell, with or without declared fields, and a
construct over the result of another construct has the upstream key.

The array that the body of a `lift` or a `computed` returns whole for an output
is stored in a document of the output, and an element of it has a reference by
key whose collection is that document, with or without a declared key (ruling
Z53). A read that reaches the document through a link stored elsewhere brings
the output up to date first, for an output inside an element body as for one
outside (ruling Z56), and a write to the document is refused, which fails the
handler that makes it. Such an array that is given whole to an instance called
through `asInstance()` is given as a link to that document, under the schema of
an array with the key fields of `Output.keyFields`, so the instance keys its
rows by the declared fields (ruling Z54). The result of another per-element
construct that is given whole to such an instance is given as the values. An
array at a path below a value that a function body returns, and an array that
the reactive tier writes, have no document, and their elements have no place.

`compare/fixtures/array-by-key.tsx` has one key field and
`compare/fixtures/array-by-key-fields.tsx` two, each over a plain array
generated from scratch with a `filter` and a `map` after it and over an array of
plain values in place. `compare/fixtures/array-by-key-form.tsx` has a key field
whose name holds a `:` and whose value is a number in one element and a string
in another. `compare/fixtures/array-by-key-reader.tsx` gives an array with a
declared key to a pattern whose parameter is typed as a plain array, compiled in
and called through `asInstance()`, and gives such an instance the result of a
`filter`. `compare/fixtures/generated-reference.tsx` stores a reference to an
element of a plain array generated from scratch that declares no key, and
`compare/fixtures/generated-inner.tsx` one to an element of such an array that
is computed inside an element body. Today's runtime has no `ArrayByKey`, so the
tests of these fixtures are of the executor alone.
`compare/fixtures/set-over-link.tsx` writes a plain value to a cell that holds a
link, which writes the record that the link names in the executor and in today's
runtime alike.

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
the executor alone on the crate's current output against it, with each event
sent for the elements that `run` recorded. The file holds a member or a position
of today's values that holds nothing as a record that stands for it, so `again`
compares what `run` compared. Before each event the comparison seeds
`Math.random` alike on both sides (`compare/random.ts`), so a handler that draws
a number, as the shuffle of `patterns/showcase/card-piles/main.tsx` does, draws
the same one in today's run and in the executor's
(`compare/fixtures/random.tsx`). Notes 281 on of `SPEC-NOTES.md` list what the
executor needed that the plan and the documents do not give, and what the
comparison found. Notes 307 on say what the rulings of 2026-11-16 on those needs
changed in the crate and the executor, what they leave undetermined, and the
figures of the comparison after them. Notes 325 on do the same for the rulings
on `Cone.within` and on who places a stream, and for `reduce`, the record of a
key of a list, and the keys of the result of a `flatMap`. Notes 344 on have what
today's runtime stores when a record gets into a list, and rulings Z12 to Z17.
Notes 367 on have rulings Z18 to Z23, the seeded `Math.random`, and the
instances and bindings a function body makes. Notes 387 on have rulings Z24 to
Z38: the layout of the children of a view node, the re-key of a plain value in
place, the copy a function body holds, `asInstance()` and `KeyedBy`. Notes 406
on have rulings Z39 to Z43: the plan without `Binding.result`, the key that does
not name its field, and what a re-key moves. Notes 419 on have rulings Z44 and
Z45, and notes 432 on rulings Z47 to Z53: `ArrayByKey`, the salted hash in a
key, the written form of a key, where a reader with no declared key gets the key
fields, and the reference to an element of a plain array generated from scratch.
Notes 446 on have rulings Z54 to Z57 and what brought the keys, the identifiers
and the names in line with the documents. Notes 461 on class every module that
was not executed, every event that was not handled and every value that differed
at commit `682b918ed1`, and say what was fixed, what needs a ruling, and what is
left.

## The serving loop, error states and effects

The executor handles events as `scheduler-and-serving-loop.md` §5 has a runtime
with no serving loop handle them. `Instance.enqueue` queues an event and
`Instance.batch` handles the queued events and those that their handlers send,
each in a transaction of its own, with one derivation transaction behind them.
`Instance.send` is a batch of one event. Before a handler body runs, the stale
cone instances that compute what the handler reads are evaluated in its
transaction. `Instance.transactions` holds a record of each transaction: its
cause, the cones it evaluated, the documents it wrote and their bytes, and the
cones that took an error state. A body that throws, a handler that reads a
failed value, and a write that the option `refuses` refuses, each store nothing
of their event. The option stands for the constraints on what a handler writes,
which the executor does not check.

A cone instance is evaluated at most ten times in one transaction
(`MAX_EVALUATIONS`). One whose next evaluation would be the eleventh, and one
whose value code throws, takes an error state, the record
`{ $error: { message } }`, and the rest of the transaction commits. Its
side-writes are withdrawn. A cone that observes a failed value fails in turn,
and one that places it in a record or among the children of a view node passes
it on. `Instance.failed` lists the failures.

An effect of the reactive tier has a state document that holds its request, the
hash of the request, and under `outcome` the `pending`, `result` and `error`
that a reader reads. The crate registers the function of each request
(`$rt.request`). The request is stored when something reads the result, a
request transaction behind the derivation transaction puts it into
`Instance.outbox`, and nothing leaves the process: a test delivers the
completion with `Instance.complete`, or answers from a table with
`Instance.answer`. A handler requests an effect by calling the built-in, and the
request leaves when the event commits. A `wish` resolves to a reference to what
the option `wishes` gives for its operands, and the clock is a document that
`Instance.tick` writes. The option gives either a value, which the executor
stores in a document of its own, or the outcome itself, whose links lead to
documents the instance was given (`options.documents`); such a document can be
in another space, which the address of a reference to it then names. A stream
has a document from its first event (`execution-and-storage.md` §4.7).

`exec/test/serving.test.ts`, `effects.test.ts` and `growth.test.ts` test these,
and `compare/test/batch.test.ts` compares a batch with today's runtime under its
serving posture. From the repository root:

```sh
deno run -A --no-check base/pattern-compiler/compare/values-corpus.ts alone alone.jsonl
deno run -A --no-check base/pattern-compiler/compare/values-corpus.ts stubbed stubbed.jsonl
deno run -A base/pattern-compiler/compare/sizes.ts
deno run -A --no-check base/pattern-compiler/compare/growth.ts 100 1000 10000
```

`alone` runs the modules that need `wish` or request an effect on the executor,
with the answers of `compare/stubs.ts`, and `stubbed` runs them on today's
runtime as well, with `fetch` replaced by a function that answers the same. A
line of a run whose executor had stubs holds whether they had the table of
`compare/stubs.ts` and what their clock held, and `again` runs such a line with
the same stubs and that clock, and compares a number within a day of that clock
as a time. `sizes.ts` prints the size of each plan of the corpus with its
largest members, and `growth.ts` what one change of a list costs the executor at
several lengths. Notes 479 on of `SPEC-NOTES.md` have what was tested, what the
documents do not decide, and the figures.

A pattern that calls `wish` is compared in a seeded home
(`compare/wish-home.ts`), by `corpus.ts run`, `values-corpus.ts run`,
`integrated.ts` and `stored-labels.ts` alike. Before the pattern is compiled,
today's runtime is given a profile in a space of its own, under a schema whose
confidentiality is a user atom, and a root of the home space that lists the
profile and holds an empty list of mentionable pieces and an empty piece
registry; today's `wish` resolves against them. The profile holds the data
members of the result of `patterns/system/profile-home/profile-home.tsx` and is
no running instance of it. The executor is given the same documents and a table
that answers `#profile`, `#profileName`, `#profileBio`, `#mentionable`,
`#pieceRegistry` and a search for a tag with the outcome today's runtime stores
for them, so a read of the profile is a read through a reference into the other
space. Where the executor's documents are in the runtime's storage, the profile
is the document the storage holds, with its label. A module whose executor
resolves any other `wish` is not run, and its result names the query.
`compare/fixtures/wish-home.tsx` and `compare/test/wish-home.test.ts` hold one
`wish` of each kind.

A template names the template of another output by a node
`{ op: "output", output }` (ruling Z58), a template that a plan holds at more
than one position is written once in `Plan.templates` and named by
`{ op: "shared", template }`, and a schema that a schema document holds at more
than one position is written once under `$defs`.

## What a change costs the executor, and the documents of a result

The executor finds what a change makes stale by marking, as
`scheduler-and-serving-loop.md` §3 has the scheduler do it. Each memo entry is
registered as a reader of the positions it read and as a user of the entries it
used. A write marks the readers of the path it wrote, of a path above it and of
a path below it, and a mark passes on to the users of a marked entry. An entry
that is not marked is taken as current and is compared with nothing. A read
through a reference by key is registered under the array and the key, so a write
to one element marks the readers of that element. `Instance.checks` counts the
comparisons that are still made. An entry whose evaluation called `equals`, has
a cone with static side-writes among what it demanded, or read through a key
into the document of a computed output is compared on every pull, and so is each
entry that used one.

The store keeps the key of each position of a stored array and brings the keys
up to date with a change of the array: a write below an element forms the key of
that element, a splice (`Store.splice`, `Instance.spliceArgument`, and the
`push` of a handle) forms the keys of the members it put in, and an array that
is written whole keeps the keys of the members that stand at its start and at
its end as they stood. With the option `keys: "formed"` the keys of an array are
formed again after each write to it.

A cone that places the result of a `map`, a `filter` or a `flatMap` in a value,
and observes nothing of it, holds a reference to the collection (`Assembled`),
over an array of references, over an array of plain values in place and over the
result of another per-element construct alike. The executor stores the rows
where the reference stands in the result, and stores a row again when the body's
result for its key is another value, so the cone that placed the collection, and
the result, are not evaluated for a change of one row. Code that observes the
collection is given the array. The assembly of a `map` or a `filter` over a
stored array, or over the result of such a construct, is brought up to date from
the changes of the array: the element table and the result are spliced, and the
body is evaluated for the keys that entered and for the keys whose entry is
marked. With the option `assembly: "formed"` an assembly is formed whole.

A transaction keeps what each of its changes replaced (`Store.journal`) and no
copy of a document. `Transaction.patchBytes` has the bytes that the changes put
into the documents, and `Transaction.stored` what the transaction wrote of the
results by the layout of `execution-and-storage.md` §4.10: the rows of a
collection that stands in the result, and the array of the collection, are split
points, a split point of 1,024 bytes is a part, a part of 512 bytes is stored in
place again, and a document of more than 65,536 bytes has each split point
directly below it stored as a part. The executor reads the result from one
document that holds it whole, and `Instance.laidOut()` gives the result document
and the part documents of the layout, formed from it. A node of the rendered
tree that is no row is no split point here.

Beside that accounting the store keeps part documents as documents
(`exec/parts.ts`, provisional decisions P20, P25 and P26): for every document,
the argument and a state cell included, a holder, a part document for each row
of an array from 1,024 bytes on, and for an array over 65,536 bytes chunk
documents under lists of links that hold the count of rows below each link.
`Store` applies each change of a document to them, `Transaction.parted` has the
part documents that a transaction wrote and their bytes, and
`PartedDocuments.read()` reads a path through the holder, the lists, the chunk
and the part and counts them. The executor's own reads go to the value that the
store holds for each document, and a test compares what the part documents give
with that value after each change. One change of a list writes at most 6
documents and 149,137 bytes at 100,000 rows, and one row is read through at most
3 documents. An edit of one row of 23 bytes writes its chunk whole, 122,242
bytes at 10,000 rows for a patch of 24.

```sh
deno run -A --no-check base/pattern-compiler/compare/growth.ts 100 1000 10000
deno run -A --no-check base/pattern-compiler/compare/growth.ts --formed 100 1000
deno run -A --no-check base/pattern-compiler/compare/growth-today.ts 100 1000
deno run -A --no-check base/pattern-compiler/compare/rekey-cost.ts keystrokes 100 1000
deno run -A --no-check base/pattern-compiler/compare/rekey-cost.ts polled 100 100
deno run -A --no-check base/pattern-compiler/compare/growth-today.ts keystrokes 100
deno run -A base/pattern-compiler/compare/sites.ts
deno run -A --no-check base/pattern-compiler/compare/parts-growth.ts 100 1000 10000
deno run -A --no-check base/pattern-compiler/compare/parts-growth.ts --wide --max=4096 10000
deno run -A base/pattern-compiler/compare/times.ts again.jsonl run.jsonl compile.jsonl crate-time.jsonl
```

`growth.ts` prints what one change of a list costs the executor, and
`growth-today.ts` the same for today's runtime, as far as it has the counter.
`rekey-cost.ts` prints what one keystroke in a row that has state costs, and
what a list that is replaced again and again leaves stored
(`fixtures/rows-state.tsx`). `sites.ts` estimates the size of the plans with a
pattern that is compiled in written once, which the crate does not do.
`times.ts` prints the table of run times. `parts-growth.ts` prints what one
change of a list writes and reads in part documents, with rows of 23 bytes and,
with `--wide`, of 2,000; `--max` and `--min` give the two sizes of the layout,
`--counts=none` leaves the counts out of the lists, and `--identity=minted`
names the part of a row by an ordinal. The crate still writes a pattern that is
compiled in out at each call site: plans of 2,261 to 103,508 bytes for 1 to 6
levels of two sites, which an ignored test of `tests/plan.rs` states. Notes 523
on have the figures of the part documents, where the decision is incomplete, and
what the copies of one callee in the plans of the corpus differ in. Notes 505 on
of `SPEC-NOTES.md` have the figures, what the documents' rules make follow the
length of a list, and the provisional choices.

## The executor on the runtime's storage

Milestone 1 of
[`compiled-pattern-language-integration.md`](../../docs/plans/compiled-pattern-language-integration.md)
runs the executor with its documents in the runtime's storage. The executor
tells a store outside it of each transaction through `TransactionHooks`
(`exec/executor.ts`, option `transactions` of `Instance`): when a transaction
begins and with which cause, each position it reads (`Store.onRead`), each
change it makes, and whether it committed. The append of an event sent from
outside and the watermark that passes an event are writes outside the executor's
transactions, and the hooks are told of each as a transaction of its own, of
cause `send` and `watermark`. The option `documents` makes documents that exist
before the instance, outside any transaction, such as the input cells an
argument links to.

Each change comes with the record of each path of the plan it wrote
(`exec/plan-write.ts`, the shape of `PlanWrite` in PL §4.1 without labels): the
record of the plan whose template gives the path's label (an entry of
`Plan.outputs` for a write of the result, of `Body.writes` for a write through a
handle, of `Cone.writes` for the argument of a child or the request of an
operation, and `StateCell.first`), the instance, the element keys, and the
binding of each slot the template reaches: the positions the read of the slot
went through when the cone instance, the handler or the body last read it, with
the slot's observation class. A change of the result at a path above several
outputs has one record per output and per row written. An `output` node of the
template is reported with the inputs of the named output, and a `fold` with its
elements in the two forms of provisional decision P31: one set of bindings whose
paths hold `*` at the element, for a collection over a stored array whose
elements are all plain values in place when the body has no `select`, `pick`,
`fold`, `dynamic` or `output` node; otherwise one group per distinct set of
element inputs with its count. The groups are kept with the assembly of the
collection and updated when an element's cone instance is evaluated or the
element leaves, so a change of one element updates one group whatever the length
of the list (`Counts.groupUpdates`), over an array of references and over the
result of another per-element construct alike. Elements are grouped by the label
identifier the hook `labelOf` gives for each position; without it every position
is a group of its own. The slot of an element of the result of another
per-element construct is bound to the output of the upstream element that holds
it. Value code reports the branch each selector of its cone takes and the key
each pick it chooses takes (`$h.select` around the test of a conditional
expression, `&&`, `||`, `??` and an `if` of a block, and `$h.pick` around a
computed key; `Facts.selector` and `Facts.pick` in `src/emit.rs` say which
selector or pick the code at a span has), and a record carries `selections` and
`picks` for those its template reaches. A selector the runtime decides, such as
the `through` of a scan or the `select` over the keys of a constructed record,
is not reported. A read through a handle of a handler or a body is reported to
the hook `read` with the body and the entry of its `Body.handles`
(`Store.reader`), and a record carries, at each `dynamic` node of kind `handle`,
the positions the body read through that handle before the write. The executor
keeps none of this when it is given no hooks.

`runtime/runner/src/compiled/transactions.ts` (which
`compare/runtime-transactions.ts` re-exports for the harnesses here) implements
the hooks with the runtime's own transactions (`Runtime.edit()`): each read is
read through the transaction, each change is written into it as it is made, and
the transaction commits with the runtime's commit and its CFC preparation, or is
aborted where the executor did not commit. A document of the executor is the
entity `of:<identifier>`, and a link is written as the runtime's link. An
instance the executor makes of another artifact, one a function body
instantiates or one of a pattern compiled alone, gives write records of that
artifact's plan: the executor names the instance and its artifact to the hook
`instantiated`, and the adapter registers the artifact and records the
instance's write records under it, with a table of inputs per compiled pattern.
`RuntimeTransactions.stored()` reads the documents back, and
`compare/test/runtime-transactions.test.ts` checks that they are the executor's,
that one runtime transaction commits for each of the executor's, and that a
handler that reads a labeled input commits labels on what it writes.

`compare/integrated.ts` runs each module of a values run three ways on the
argument and the committed events of today's run: in memory, in storage with the
argument in place, and in storage with each input a labeled cell. It checks that
the runs in storage compute the values of the run in memory, and reports the
times with the commits and CFC preparations the runtime counted, beside
`cost.ts run`:

```sh
deno run -A --no-check base/pattern-compiler/compare/values-corpus.ts run values.jsonl
deno run -A --no-check base/pattern-compiler/compare/cost.ts run run.jsonl
deno run -A --no-check base/pattern-compiler/compare/integrated.ts run values.jsonl integrated.jsonl
deno run -A --no-check base/pattern-compiler/compare/integrated.ts report integrated.jsonl run.jsonl
```

## A compiled piece in the runner

Milestone 3 of the same plan runs a compiled pattern as a piece of the runtime,
behind the experimental option `compiledPatterns`.
`startCompiledPiece(runtime, tx, artifact, argument, resultCell)` of
`runtime/runner/src/compiled/piece.ts` is the call beside `Runtime.run`: the
entity of `resultCell` is the result document, every other document of the
executor is an entity of the same space, and the caller commits `tx`. The runner
imports `exec/` by relative path, and `exec/` imports nothing of the runtime.

- **The load.** The creation and the first derivation are written in bounded
  transactions (`RuntimeTransactions.within` with `loadRows`). The piece commits
  the documents the instance makes for itself first, in a transaction that makes
  the reads the caller had made in `tx`. It then commits each row document whose
  write records name stored positions alone and include one for the row whole,
  in transactions of at most `CompiledPieceOptions.loadRows` rows, 250 unless
  given. Everything else, the links to the rows among it, is written into `tx`.
  Until the caller commits `tx`, the storage holds row documents that nothing
  links to, each under the label it has when the load is done. A load whose `tx`
  the caller wrote into before the start is written into `tx` whole, since a
  position staged there is readable there alone, and so is one with `loadRows`
  set to `Infinity`. The documents a `lift` writes for its rows stay in `tx`.

- **Events.** A stream of the executor is stored as a link to an entity that
  holds the runtime's stream marker, and the piece registers an event handler of
  the scheduler for it. `Cell.send` on the member of the result queues an event,
  and the handler runs the compiled handler in the scheduler's transaction
  (`Instance.handleEvent`), which the scheduler commits. An event a handler
  sends to a stream of the piece is queued with the scheduler as well
  (`Instance.takeQueued`). No event is appended to a stream document.
- **The derivation.** One action of the scheduler, an effect, runs
  `Instance.settle()` in the scheduler's transaction. The piece invalidates it
  after an event, after a change by another writer, when a commit of another
  writer changed a label the executor read, and after a refused commit.
  `Runtime.idle()` therefore resolves when the piece is up to date. The action
  opts out of the scheduler's delay for actions that are slow on average. Where
  a handler made instances, the action first derives those alone
  (`Instance.settleMade`), and runs again for the rest in a transaction of its
  own: a `lift` over a list then finds the labels of a new member stored and
  gives no record again for the rows of the members before.
- **Labels that change.** The label of a write record is formed again when a
  label that its inputs read changed and the record was not given again, whether
  or not a value changed with the label (`Instance.labelsChanged`). The store
  says for each change whether a read at a position consumes the label it
  consumed before (`LabelChange.unchanged`), so an entry added under the label
  of its ancestor forms no label again. The row documents a `lift` writes are
  such readers too, and a row that holds what it held under the labels the
  `lift` had read is given no record when the `lift` runs again.
- **The store.** The executor keeps its documents in memory. A document it did
  not make, such as an input cell the argument links to, is read from the
  replica when a reference first leads to it (`Store` option `load`), and a
  commit of another writer replaces what it changed: the piece subscribes to the
  storage notifications and applies each change, a change of the members of an
  array as the one splice that makes it, which marks the readers.
- **Rows as documents.** For a `map` in no element body over a slot whose schema
  declares the array or its members as cells, whose rows are records or view
  nodes (`rowDocumentCollections` of `exec/row-documents.ts`), each row is an
  entity of its own, named by the array and the key of the row, and the array
  holds links, which the runtime follows. The array can stand below a member of
  an array, as the rows among the children of a view node do.
  `CompiledPieceOptions.rows` set to `in-place` keeps the rows in the array. The
  rows of every other collection stay in place. A member added at the end of
  such an array writes the number of members and one link; any other change of
  the members writes the array of links whole. A write by another writer into
  the document of a row is applied to the row the executor holds; a write of the
  array of links is reported (`CompiledPiece.refusals`) and not applied.
- **A refused commit.** The executor has gone on when a commit of the piece is
  refused. The piece then takes, for each document the transaction wrote, what
  the storage holds in place of what the executor holds (`Instance.restore`),
  and derives again. The result document of an instance is taken with the rows
  of its collections left out, and the next derivation stores every row again.

- **Value code in a compartment.** The executor makes the functions of a
  module's text with the evaluator it is given (`ModuleEvaluator`, the option
  `evaluate` of `Instance`), by default `new Function` (`evaluateWithFunction`).
  A compiled piece gives it `compartmentEvaluator()` of
  `runtime/runner/src/compiled/value-code.ts`: one SES compartment with a frozen
  global object and the globals a module of today's bundles has, in a realm that
  is locked down. A handler runs under a frame of a handler, so the gated `Date`
  and `Math` give it the time of its event, to the second, and a random draw;
  the derivation and the code of module scope have neither.
  `CompiledPieceOptions.evaluate` takes another evaluator, which the harnesses
  use to measure what the compartment costs. A handle keeps the instance in
  private fields, and the classes of what a function body is given are frozen.
  The names `$rt` and `$h` are kept from a pattern by the crate's check alone.
- **Compile on load.** `PatternCompiler` of
  `runtime/runner/src/compiled/compile.deno.ts` writes the files of a program to
  a directory of their own, runs the crate's release binary there with
  `emit --accepted`, and returns the artifacts. With a cache directory it keeps
  what the binary printed under the hash of the binary and the hash of the
  source. An absent binary is `PatternCompilerMissingError`, and a program the
  crate refuses is `PatternCompileError` with the diagnostics. Nothing in the
  runtime calls it: a harness compiles and hands the artifact to
  `startCompiledPiece`.

`compare/runner-path.ts` starts today's piece and the compiled piece with the
same calls of the runtime over the lists of `fixtures/runner-lists.tsx`, makes
each change through a cell, and reports what a change costs each from the write
until the scheduler is idle with no commit pending:

```sh
deno run -A --no-check base/pattern-compiler/compare/runner-path.ts 100 1000
deno run -A --no-check base/pattern-compiler/compare/runner-path.ts --arms=compiled --case=declared --rows=in-place 100 1000
deno run -A --no-check base/pattern-compiler/compare/runner-path.ts --arms=alone --case=declared --no-pull 100 1000
deno run -A --no-check base/pattern-compiler/compare/runner-path.ts --arms=compiled --case=declared --no-pull --inputs-first 100 1000 10000
```

The arm `alone` starts no piece and makes the same changes: its time is that of
the harness's own writes, which a change of the members of a long array is most
of. With `--inputs-first` the inputs are committed before the piece is started,
which is what lets the piece load in bounded transactions.

`compare/runner-corpus.ts` runs each module of the corpus as a compiled piece
with the generated inputs and events, and beside it on the executor with its
documents in memory, and reports how many pieces start, handle every event, have
no commit refused and hold the values the executor in memory holds:

```sh
deno run -A --no-check base/pattern-compiler/compare/runner-corpus.ts run runner.jsonl
deno run -A --no-check base/pattern-compiler/compare/runner-corpus.ts report runner.jsonl
```

`compare/sandbox-cost.ts` measures the evaluators, one call of a value function,
the patterns of `fixtures/sandbox-cost.tsx` on the executor in memory, and the
crate's binary beside today's compile; `runner-path.ts` and `runner-corpus.ts`
take `--evaluate=function` for the same comparison on the runner path:

```sh
deno run -A --no-check base/pattern-compiler/compare/sandbox-cost.ts calls
deno run -A --no-check base/pattern-compiler/compare/sandbox-cost.ts executor --arm=function
deno run -A --no-check base/pattern-compiler/compare/sandbox-cost.ts compile
```

The tests are in `runtime/runner/test/compiled/`: `piece.test.ts`,
`row-documents.test.ts`, which holds those of the load in bounded transactions,
`layout-labels.test.ts`, which compares what a read consumes with rows as
documents and in place, `refused-commit.test.ts`, and `created-members.test.ts`
for an instance that a handler makes, `value-code.test.ts` for the compartment,
and `compile.test.ts` for `PatternCompiler`, with a shell script in the place of
the binary. They load the artifacts of `compare/fixtures/`, so they need no
build of the crate. `compare/test/compile-on-load.test.ts` and
`compare/test/serving-compile.test.ts` run the release binary. Notes 579 on of
`SPEC-NOTES.md` have what is stubbed and the figures.

## A compiled piece under server execution

Milestone 6 of the same plan runs a compiled piece in the serving runtime of its
space, and starts one from what the storage holds.

- **The basis.** A piece keeps a document that records the documents its
  derivation read and does not derive, its sources, with the sequence number
  each had when the stored result was derived from it
  (`runtime/runner/src/compiled/basis.ts`). A source the piece itself wrote,
  whose commit the replica has not confirmed, is listed apart: the transaction
  that writes the basis reads it, and it counts as unchanged while its head is
  not behind the head of the basis. The basis also lists the documents the piece
  made that are no rows.
- **Resume.** `resumeCompiledPieceFromBasis(runtime, artifact, resultCell)` of
  `runtime/runner/src/compiled/resume.ts` brings the basis and the sources it
  names, without what they link to, and compares the numbers. Where they match
  it evaluates nothing, reads no row, starts no executor and commits nothing,
  and the returned `ResumedPiece` waits until it is woken: by its caller before
  an event, or by a commit that changes a source. Where they do not match, and
  at a wake, `resumeCompiledPiece` brings the documents of the piece and of its
  inputs, evaluates the whole derivation again against the stored argument and
  the stored state cells, and writes the paths whose value differs, in one
  transaction. The executor keeps which cone instances are current in memory
  alone, so that evaluation is made whole.
- **The documents of a piece.** Each document the executor makes carries the
  `result` link to the result document. A resumed piece tells by it a document
  the executor named from one that exists outside the piece, and the serving
  loop finds the piece of a document by it. The counts that the names of handler
  runs and of the documents handlers make are formed from are kept in a document
  of the piece, and a resume goes on from them.
- **Setup by a client.**
  `setUpCompiledPiece(runtime, tx, program, argument, resultCell)` of
  `compiled/setup.ts` writes the source of the pattern (the files of the program
  and the name of the main file), the document that names it for the result
  document, and the argument document. A client with server execution on then
  appends events with `Cell.send` and runs nothing of the piece.
- **The serving runtime.** `serveCompiledPieces(runtime)` of
  `compiled/serving.ts` installs `Runtime.compiledPieceLoader`, which
  `ensurePieceRunningVerdict` asks for a result document that names no pattern.
  The loader compiles the source the storage names for the piece with the
  compiler it was given (`ServeCompiledPiecesOptions.compile`, for which
  `listenCompiledServingMemoryServer()` takes one `PatternCompiler`), keeps what
  the compiler gave by the document of the source, and starts the piece from the
  storage: a load where the result document is empty, and otherwise a resume
  from the basis, which starts no executor for a piece that is only read. The
  value code is evaluated in a compartment. Where the document names no source,
  or the compiler refuses it, nothing is evaluated and the reason is written
  into the document `compiledFailureOf(result)`, which the client reads. The
  handlers and the derivation are the scheduler's, so the loop's event drain
  reaches the handlers and its waves hold what they write. A wave that is
  rejected takes its writes back from the replica, and the piece then restores
  the documents the withdrawn transactions wrote from the storage.
  `listenCompiledServingMemoryServer()` of
  `compiled/serving-memory-server.deno.ts` gives a test a memory server on a
  websocket with such a serving loop.

Nothing but the helper for tests installs the loader. Note 812 of
`SPEC-NOTES.md` lists what a toolshed needs before it may.

```sh
COMPILED_PIECE_STORAGE=socket deno test --no-check -A runtime/runner/test/compiled/
deno run -A --no-check base/pattern-compiler/compare/runner-path.ts --server=socket --no-pull --inputs-first --case=declared 100 1000
deno run -A --no-check base/pattern-compiler/compare/runner-corpus.ts run resume.jsonl --resume
deno run -A --no-check base/pattern-compiler/compare/runner-corpus.ts run serving.jsonl --serving
deno run -A --no-check base/pattern-compiler/compare/serving-path.ts --events=7 100 1000
deno run -A --no-check base/pattern-compiler/compare/serving-path.ts --arms=compiled --events=7 10000
deno run -A --no-check base/pattern-compiler/compare/serving-path.ts --arms=compiled --events=7 --profile=appends.cpuprofile 1000
```

`COMPILED_PIECE_STORAGE=socket` runs the tests of a compiled piece against a
memory server reached over a websocket of the process, and `--server=socket`
does the same for `runner-path.ts`. `runner-corpus.ts --resume` hands each
module to a second runtime after half of its events, which resumes it from its
basis and then wakes it, and `--serving` runs each under the serving loop with
one client. `serving-path.ts` times one event of `fixtures/serving-list.tsx`
from the send on a client until that client and a second one read the result,
for a compiled piece and for today's piece of the same pattern, and then what
another serving loop reads and evaluates when it takes the space over. The tests
are `resume.test.ts`, `basis.test.ts` and `compiled-serving.test.ts` in
`runtime/runner/test/compiled/`, and `compare/test/resume-corpus.test.ts`. Notes
800 on of `SPEC-NOTES.md` have what is stubbed, where the serving loop differs
from the specification, and the figures.

## Topics

Topics (`patterns/apps/topics/`) is the target both tracks of the integration
work toward. Its program is seven files, rewritten to the subset in the
repository's own source (notes 550 on of `SPEC-NOTES.md`), so the crate and
today's runtime run one source. The comparison runs on it like on any module:

```sh
deno run -A --no-check base/pattern-compiler/compare/values-corpus.ts stubbed values.jsonl apps/topics/
deno run -A --no-check base/pattern-compiler/compare/corpus.ts run labels.jsonl apps/topics/ --stubbed
```

`compare/topics/scale.ts` runs the board at a size of 100, 1,000 or 2,000
topics, on one of its arms, in a process of its own: the load, three edits of
one topic by a writer outside the board, and three creates through `addTopic`,
each timed until the board is up to date and the read of its result apart, with
the facts of the result the arms are compared on. The arms are `executor`, the
executor with its documents in memory; `storage`, the executor with its
documents in the runtime's storage, the experimental option `compiledPatterns`
on, and each topic and each input of the board under a schema with a clause;
`today`, today's runtime with no label stored; and `today-labeled`, today's
runtime with the same clauses and `cfcFlowLabels` at `persist`. On the branch
that holds the boards the crate emits, the arm `runner` runs the board as a
compiled piece in the runner with the calls of the arm `today-labeled`. The arm
`storage` reports per step the commits, the preparations and their time, the
write records and their size, the label entries of the documents the step
changed, the bounds, and the time in each hook of the storage apart from the
executor's own. With `SCALE_TOPIC_LABELS=distinct` each topic has a clause of
its own; with `SCALE_CHECK` set an edit checks that each stored position it
changed holds the clause of the topic it wrote; `SCALE_LABEL_PATHS` adds the
label entries by form of path, and `SCALE_RECORDS` prints each committed write
record with the size of its members. Each topic is a document that holds what
the board demands of a topic and references to the two topics before it, and the
board's argument holds a reference to each. With `--v8-flags=--expose-gc` each
step also reports the heap in use after a full collection, beside a baseline
taken before any topic exists. Run one size per process, since a process that
has run a larger board keeps more heap:

```sh
deno run -A --no-check --v8-flags=--expose-gc base/pattern-compiler/compare/topics/scale.ts executor 1000
deno run -A --no-check --v8-flags=--expose-gc base/pattern-compiler/compare/topics/scale.ts today 1000
deno run -A --no-check base/pattern-compiler/compare/topics/scale.ts storage 1000
deno run -A --no-check base/pattern-compiler/compare/topics/scale.ts today-labeled 1000
```

The same steps run on a real board with `--seed`. `compare/topics/board-seed.ts`
reads a board out of a snapshot of its space, a store file named `<did>.sqlite`,
without writing to it, and writes a seed: what the board demands of each topic,
its mentions as indexes of topics, and the namespace. A seed holds the board's
content, so keep it beside the snapshot and out of the repository:

```sh
deno run -A --no-check base/pattern-compiler/compare/topics/board-seed.ts <did>.sqlite of:<board> seed.json
deno run -A --no-check --v8-flags=--expose-gc,--max-old-space-size=8192 base/pattern-compiler/compare/topics/scale.ts executor --seed seed.json
```

With `SCALE_HEAP_SNAPSHOTS=<dir>`, `scale.ts` also writes a V8 heap snapshot at
the baseline, after the load and after the last create, for the heap tools of
`skills/perf-investigation/scripts/`. `compare/topics/board-load.ts` loads the
same snapshot in today's runtime as a runner would, reading the board's result
(`pull`) or starting the stored board piece (`start`), and reports the memory it
keeps; with `BOARD_LOAD_HOLD` set it waits for `SIGUSR2` at each measuring
point, so that an inspector snapshot can be taken there.

## FabriChat and Home

`compare/fabrichat/` and `compare/home/` hold copies of the 26 modules of the
programs of `patterns/system/fabrichat/room.tsx`,
`patterns/system/fabrichat/manager.tsx` and `patterns/system/home/home.tsx`,
changed where the language refuses a form or the crate does not translate one.
Both programs pass `check`, and `emit` gives every pattern value code with
nothing unsupported. Notes 720 to 731 of `SPEC-NOTES.md` list each change and
what it stands in for.

`compare/fabrichat/scale.ts` starts the room, the manager and Home on the
executor in memory and as a compiled piece in the runner, sends messages into
the room and reads them back. It hands the instance what the runtime answers and
the executor does not: the outcome of each `wish` (the option `wishes`), and the
built-ins that read the acting principal, the owner of a profile and the access
list of a space (the option `builtins`), each answered for one fixed user. It
removes the write policies from the schemas, which the preparation of Contextual
Flow Control refuses in the form the crate emits. So its runs say what the
executor evaluates and how long that takes, and nothing of labels or of access.

```sh
deno run -A --no-check base/pattern-compiler/compare/fabrichat/scale.ts runner room 10,100
deno run -A --no-check base/pattern-compiler/compare/fabrichat/scale.ts executor home
```

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
cargo run --release -- emit --unchecked path/to/module.tsx
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

## Collection indexes and the entries of a record

The plan emitter takes `xs.groupBy((x) => key)` and `xs.keyBy((x) => key)` as a
collection whose body is the key function, and `index.lookup(k)` as a read of
one bucket (`plan-and-label-templates.md` §3.17). The executor keeps the index
by element key and by bucket, brings it up to date from the changes of its
source, and has what looked up a key depend on that one bucket
(`exec/executor.ts`, `Index`, `Host.lookup`). A keyed join is a `map` whose body
calls `lookup` (`compare/fixtures/keyed-join.tsx`); an index a pattern returns
is stored in the shape of today's index data, and another instance that is
handed it looks up a key by reading that bucket
(`compare/fixtures/kept-index.tsx`). `Object.entries(record).map(f)` over a
record that is an input is a collection keyed by the entry's name
(`compare/fixtures/record-entries.tsx`), and its rows are documents of their own
where the record declares its values as cells
(`compare/fixtures/names-table.tsx`).

The key of an index, and the key of a `lookup` in an index of the same instance,
is observed as a value where its type is a scalar and as the reference it is
where its type is a cell. A key whose type the crate does not resolve, and a
`lookup` by a cell in an index the instance is handed, are listed as
unsupported. The members of a bucket that a `lookup` gave are elements with the
keys they have in the index's source, so a per-element construct over a bucket
forms no key of its own. A kept index over rows that are documents holds a
reference by key to each row (`Instance` option `rowDocuments`), and holds a
copy of the row otherwise. `compare/fixtures/crossref.tsx` is the inverse of a
relation of references built from these: a `flatMap` into pairs, a `groupBy` of
the pairs by a cell, a `map` that looks up each member, and an index of the rows
that the result keeps.

`keys()`, `keyEntries()`, a sort by a key and one label entry for all buckets of
an index are not built (`SPEC-NOTES.md`, notes 610 to 635).
