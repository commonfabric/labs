# Compiled pattern language: continuing the specification

This plan carries the design work on the
[compiled pattern language](../specs/compiled-pattern-language/README.md) from
its current state to a set of specifications complete enough to prototype
against. It is written for an agent picking the work up with no other context:
it says where everything is, what is decided, what is open, and what to do
next.

## Where the work is

- **Branch:** `claude/fable-pattern-language-redesign-vvh48e` in
  `commonfabric/labs`. No pull request is open. The project owner decides when
  one is.
- **Documents**, all under `docs/specs/compiled-pattern-language/`:

  | Document | Owns |
  | --- | --- |
  | `README.md` | The overview: the design in outline, staging, and the open questions that cut across documents |
  | `language-subset.md` | The TypeScript subset: tiers, grammar, type rules, labels as annotations, diagnostics, standard-library surface, corpus measurements |
  | `plan-and-label-templates.md` | The plan format, slots and observation classes, the label rule of every operation, instantiation, error states, what rests on the compiler |
  | `builtin-inventory.md` | Every built-in and factory: what it does today, its class in the new design, its informal label rule, and the calls legal inside function bodies |

- **Specification change:** draft pull request #91 in `commonfabric/specs`
  (branch `claude/compiled-pattern-label-templates`) carries the label
  semantics as prose, pseudocode, and Lean statements. That repository is
  private; cite it from this one by section and chapter file only, as
  [`../development/cfc-spec-correspondence.md`](../development/cfc-spec-correspondence.md)
  requires.
- **Merged branches:** `claude/pattern-language-subset-spec`,
  `claude/pattern-language-plan-labels-spec`, and
  `claude/pattern-language-builtin-inventory` are fully merged into the branch
  above and carry nothing else. New work does not go on them.

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

Each ruling is written into the documents. This list exists so that none is
relitigated.

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
  compiled artifact, evaluate the same gates, and never request effects.
- One transaction per cause. A failed constraint rejects the cause's whole
  transaction. A failed cone takes a labeled error state and the rest
  commits.

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
- `any` is refused. Published label typings are identity aliases, and no
  editor plugin is part of the design.
- `streamData` and `llm` are removed. `wish` is structural.
- `patternTool` is removed in favor of a pattern closure: an inline
  `pattern(...)` in the reactive tier, used as a value, whose captures the
  compiler binds as private parameters.

**Calls inside a function body**

- Five kinds: instantiate a pattern, create a cell, request an effectful
  built-in, read context that is not a cell, and bind a handler.
- A `lift` or a `computed` does not instantiate a pattern and does not
  request an effect, so it has no indirect route to an effect. A `handler`
  or an `action` may do both, and so may the body of a pattern a handler
  instantiates.
- A function body may call two kinds of factory value: a pattern factory,
  which it instantiates, and a handler factory, which it binds. Both are
  resolved at run time from their own compiled records. A `lift` result is
  not a factory value.

**Identity and storage**

- The keep set of an instance is everything reachable from its result cell,
  the rendered `[UI]` tree included. Interim values are not stored and not
  labeled.
- A state cell's identifier derives from its cause, with the name taken from
  the assigned variable as the transformer's `.for(...)` does.
- A `map` element is keyed by its value when it is a plain value and by its
  cell identity otherwise. The index joins the key only when the callback
  uses it. A value-derived key is salted with a secret of the space.
- Equal plain values share a cone for computation only. A per-element body
  over plain values that declares a state cell or binds a handler without
  using the index is a compile error.
- Stored per-element state is not carried over from the current runtime.

**Labels**

- Template labels are equal to or tighter than today's, with one deliberate
  exception: the collection index, where the keys of absent elements join a
  bucket's membership label.
- `findIndex`, `some`, and `every` use the prefix rule: elements after the
  deciding one do not join the label.
- A factory value that changes under a child tears the child down and starts
  a new one under the same name. An `inSpace` instantiation's identifiers
  are known before the cross-space commit.

## Open, and needing the owner

1. **Whether to start the next three documents**, listed under
   [Next work](#next-work).

## Open, and not needing the owner

Each document ends with its own list, and every entry states the assumption
made. The entries that another document or the prototype has to settle:

- **Inline records in a stored list.** A record-typed list read from an
  input is assumed to hold links. Where it holds inline records, the plan
  and the inventory assume the element's cone fails at run time; the
  alternative is distinct types for the two kinds of list.
- **How fine footprint analysis is for computed values**
  (`plan-and-label-templates.md`, open question 1).
- **Re-typing overloads and instance-to-view assignability**
  (`language-subset.md`, open questions 1 and 4), both for the type-checker
  prototype.
- **Whether `wish` requires a constant query** (`builtin-inventory.md`,
  open question 2).
- **Unifying staged access changes with the cross-space commit**
  (`builtin-inventory.md`, open question 3).

The overview lists the cross-cutting ones: gates under speculation, residual
termination channels, cycles through side-writes, cache promotion, and
migration.

## Known limits of what exists

- **The documents have not been read against each other in full since their
  last revision.** Every ruled point was checked by search across the four,
  and each open-question section was read. A full read of all four together
  is owed before more is built on them.
- **Specs pull request #91 is one change behind.** The pattern closure
  (`Closure`, the `params` slot root, and its label rule in
  `plan-and-label-templates.md` §3.15) is not in it yet and has to be added
  there.
- **Specs pull request #91 has not been reviewed.** Its Lean development
  states the two target theorems; the operations added after the first draft
  (element keys, the prefix fold, chosen children, body calls, child
  instances) are prose and pseudocode only.
- **Corpus numbers are syntactic.** They come from throwaway scripts over
  the parse tree with no type information. The share of `computed` calls
  that promote (1,351 of 1,466), and the count of per-element callbacks that
  bind a handler without the index (6 certain, 95 undecided), both need the
  type-checker prototype.
- **Factory values depend on pending work.** On this branch a factory can be
  stored but not read back as something callable. Pull request #4687 in this
  repository implements
  [first-class serializable factories](first-class-serializable-factories.md)
  and is not merged. It is where the pattern closure comes from. As
  described it also makes `lift` factories values, which this design does
  not; the owner is asking for that pull request to cover patterns only.

## Next work

Three documents remain to be written, each beside the others and each by one
author. They can be written in parallel.

1. **`footprint-analysis.md`.** The analysis that computes a function body's
   footprint: the abstract domain over paths and the four observation
   classes plus label metadata, where it gives up and how it widens, the
   write-path side that decides between a static side-write target and a
   materializer, and the treatment of cell handles. It takes the footprint
   record from `plan-and-label-templates.md` §1.1 as given, and it measures
   how often it gives up on the corpus.
2. **`execution-and-storage.md`.** One transaction per cause in detail: what
   is evaluated before and after a handler body, cone evaluation and the
   in-memory memo, the keep set and the layout of a result document, causal
   identifiers, durable fold and index state, cache promotion and its cost
   model, and the migration of stored instances.
3. **`scheduler-and-serving-loop.md`.** What remains of
   [Scheduler v2](../specs/scheduler-v2/README.md) across instances: dirty
   slots from the change channel, demand, the event queue, effects with
   their gates and retries, materializers, convergence bounds, links across
   spaces, and how this joins the
   [serving loop](../specs/server-side-execution/serving-loop.md). It also
   covers client speculation and which gates a client evaluates.

After those:

4. Add the pattern closure to specs pull request #91.
5. Read all the documents against each other and list the contradictions
   for the owner, as was done after the first three.
6. Begin stage 2 of the overview's staging: prototype the subset type
   checker and footprint analysis, and replace the syntactic corpus numbers
   with type-checked ones.

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

When this plan's work is done or abandoned, archive it as
[`../README.md`](../README.md) describes.
