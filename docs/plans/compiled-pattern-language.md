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
  | `footprint-analysis.md` | The analysis of a function body: the abstract domain, the transfer rule of each construct, the causes of a widening, the write side and what makes a computation a materializer, reads through cell handles, the soundness lemma |
  | `execution-and-storage.md` | The transaction of one cause for one instance, cone evaluation and the in-memory memo, the layout of a result document, causal identifiers, durable operation state, provenance, cache promotion, migration |
  | `scheduler-and-serving-loop.md` | What remains of the scheduler across instances: the address index, demand, events, effects, materializers, convergence bounds, links and commits across spaces, the serving loop, compiled artifacts, client speculation |

- **Cross-read record:**
  [`../history/specs/compiled-pattern-language/cross-read-2026-11-11.md`](../history/specs/compiled-pattern-language/cross-read-2026-11-11.md)
  lists every contradiction found by reading the seven documents against
  each other, with the side that governs and the smallest correction for
  each. None of it is applied yet. This plan cites its findings by number:
  K1 to K19, the numbers 1 to 26 of its section 3, F1 to F21, and the A, B,
  C, and D numbers of its section 5.
- **Specification change:** draft pull request #91 in `commonfabric/specs`
  (branch `claude/compiled-pattern-label-templates`) carries the label
  semantics as prose, pseudocode, and Lean statements. It includes the
  pattern closure, as prose. That repository is private; cite it from this
  one by section and chapter file only, as
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

Each entry names where the question is stated in full and the assumption the
documents make until it is answered. "ES", "SS", and "FA" are
`execution-and-storage.md`, `scheduler-and-serving-loop.md`, and
`footprint-analysis.md`; a question number is an entry of that document's
open-questions section, and the other numbers are findings of the cross-read
record.

**Findings that argue against a ruling.** The documents apply each ruling as
written. The owner decides whether it stands.

1. **How far a rejection reaches** (SS question 1). A cause's transaction
   covers every demanded instance of the space, for every demanding
   principal, so a send can be refused because an unrelated instance that
   reads the same list fails a constraint, and whether it is refused depends
   on which sessions have that instance open. Today a failing node's write
   is dropped alone.
2. **Derivations inside each event's transaction** (SS question 3). A body
   that reads a whole collection is evaluated once per event of a burst,
   where the serving loop today settles once behind several events.
   *Assumed:* accepted, and the storage changes of one drained batch are one
   cause.
3. **The size of a result document** (ES question 1). With the rendered tree
   as path entries of one document, a room's result holds every row's tree
   and a reader loads all of it. *Assumed:* one document, written by
   path-level patches, measured at stage 4.
4. **A client and `navigateTo`** (finding 23). SS has a client enact
   navigation from a speculative run; the ruling says clients never request
   effects.
5. **Runs that throw** (F9). A read through a handle is static when it is
   unconditional among the runs that return normally. On a run that throws
   before the read, today's transaction never makes it, and the labeled
   outcome then holds a label today's does not. This would be a second
   exception to "equal to or tighter".

**Label rules.** Each changes what Contextual Flow Control decides, so the
answer goes to the specification with the document.

6. **Ties among equal keys** (A2). `minBy`, `maxBy`, and a keyed lookup
   break a tie by the smallest element key and state that no element value
   enters the choice. For a plain-value element the key is a hash of the
   whole value. The proposed correction is the first position in source
   order.
7. **The integrity of a closure's factory value** (record, section 2).
   *Assumed, and written into the specification:* it takes no integrity
   from its captures.
8. **A closure given to a built-in as a tool** (K12). No rule gives the
   label of the argument the model supplies or of the result.
9. **Conditional reads through handles** (FA question 1). A third of the
   handle reads in the corpus are at a static place and conditional.
   *Assumed:* they stay dynamic, which keeps labels equal or tighter.
10. **A value passed on unchanged is a reference** (FA question 2).
    *Assumed:* yes, as today, which makes "the stored value is a link to
    the original" a rule of the language.
11. **A label-only change** (SS question 8). *Assumed:* a demanded kept
    output is instantiated again without running value code.

**Transactions, identity, and spaces.**

12. **A change of demand as a fourth kind of cause** (SS question 2,
    finding 17), with its own transaction, run as the demanding principal.
    ES assumes it is a cause of the second kind.
13. **A conflict on a derived write** (SS question 4, finding 5).
    *Assumed by SS:* the write is withdrawn alone. ES assumes the cause
    fails whole, and one prepared digest covers the cause.
14. **The identifier of a space an `inSpace` request creates** (K14,
    finding 16). The plan document derives it from the request; the
    implemented space identities are not derived from anything. The ruling
    on `inSpace` names the instantiation's identifiers and not the space's.
15. **Commits across spaces** (SS question 6). *Assumed:* one ordered,
    non-atomic sequence: access changes, then foreign batches, then home.
16. **Demand across spaces** (SS question 5). *Assumed:* a serving
    runtime's session on another space counts as demand there.
17. **`inSpace` on a statically resolved callee in the reactive tier**
    (A9). Such a callee is compiled into the surrounding instance and
    cannot be in another space. It either always makes a child instance or
    is refused.
18. **What identifies a handling** (K15, finding 15): the event key, which
    includes the acting principal, or the receipt, which does not. ES
    follows the receipt and SS the key.
19. **`.for(tag)` in a handler** (K13). The plan document and the inventory
    have it name the same thing across events; today every identifier
    minted in a handler derives from the event.
20. **Bounds** (SS question 9, findings 11 and 12). *Assumed:* ten
    evaluations of a cone per transaction, fixed with the plan version. Open
    beside the number: whether the next cause evaluates a failed cone again,
    and whether an effect whose completion changes its own request, or a
    cycle across two spaces, is bounded at all.
21. **Event order per space** (SS question 10). *Assumed:* the proposal of
    Scheduler v2 §7.5.

**Clients.**

22. **The element-key salt** (finding 14). *Assumed by ES:* a client cannot
    read it, so it cannot name value-keyed per-element state or a binding
    with copied captures before the server stores a link.
23. **A predicted refusal** (SS question 7). *Assumed:* no speculative
    result, a mark on the control, and the event is still sent.

**Migration.**

24. **Compiled and builder-path instances in one space** (finding 20). ES
    migrates instances one at a time; SS removes the mechanisms a
    builder-path instance needs. Whether one serving runtime runs both is a
    question of scope.
25. **Settled effect results** (ES question 2). *Assumed:* copied forward,
    so that a migrated instance does not request again.
26. **Retired documents and refused sources** (ES questions 3 and 4).
    *Assumed:* deletion after thirty days without a read, and an instance
    whose source the compiler refuses stays on the builder path.
27. **State inside a compiled-in sub-pattern** (ES §5.7, §9.3). Matching it
    to a call site needs the builder form, so an instance migrated after
    stage 6 loses that state.

**The language.**

28. **When the identity-alias typings are published** (A14). Until they
    are, an accepted program can show an editor error, against rule 2 of
    the language subset.
29. **Two senses of "cause"** (A17): what a transaction is opened for, and
    the seed of an identifier, as in `.for(cause)`.

## Open, and not needing the owner

The cross-read record lists each of these with the side that governs and the
correction. The ones more depends on:

- **An effect request that holds a container by reference** (F1). The
  footprint records only the reference, the egress ceiling is checked on
  the request's label, and nothing follows the link. The correction is in
  `footprint-analysis.md`: a request reads the content of its members.
- **Between `execution-and-storage.md` and `scheduler-and-serving-loop.md`**
  (section 3 of the record): one transaction or two for an effect's
  completion; when a kept output's value is staged and in what order labels
  are instantiated; slots resolved before a cone runs or on first read;
  what is current after a restart; what a rejection leaves in the memo;
  labels per position against a memo per key; how an event reaches its
  binding.
- **Records the three new documents need in `plan-and-label-templates.md`:**
  computed captures on `Body`, which handles a body is handed, a write
  target and a cone edge for a write through a handle, a read envelope per
  handle, a flag for sampled reads, a materializer's envelope and the home
  of its return value, a scope on `Output`, a promotion directive on
  `Cone`, the options of `inSpace` on `Child`, and names that are not
  positional.
- **Label rules that do not exist yet,** each for
  `plan-and-label-templates.md` and the specification together: operation
  bookkeeping state, a cached output, provenance records, what the prepared
  digest binds, the frozen `shape` entry at migration, cache promotion as a
  channel, which transaction a failed egress ceiling rejects, what a failed
  cone's side-write targets take, and a journaled label-metadata
  observation.
- **Among the first four documents** (section 5 of the record): the array
  parameter in the element key (A1), when a received handler's writer
  policy is checked (A3), the durable state of `reduce` (A4), diagnostics
  with no catalog entry (A6, A13), and fourteen sentences of the overview.
- **Corpus counts** differ among `language-subset.md`,
  `builtin-inventory.md`, and `footprint-analysis.md` (K4, K5, A16, F20).

The open questions each document ends with stay where they are.

## Known limits of what exists

- **The cross-read did not cover every section.** Each reader states what
  was not read in full at the end of its section of the record. The
  overview was checked against the three new documents only in part.
- **Claims about the current system in the three new documents are
  verified unevenly.** Each author cited source by file and function. The
  author of `scheduler-and-serving-loop.md` read parts of the
  serving-loop and events specifications by search, and knows the
  render-boundary document from a summary.
- **Specs pull request #91 is behind `plan-and-label-templates.md`.**
  Section 2 of the record lists where: among others the changed-factory
  rule and the `inSpace` rule of the Decided list, most context reads, and
  the group-mode rules of the collection index. It has not been reviewed.
  Its Lean development states the two target theorems; the operations
  added after the first draft, the closure included, are prose and
  pseudocode only.
- **Corpus numbers are syntactic.** They come from throwaway scripts over
  the parse tree with no type information, and three runs disagree on the
  totals. The share of `computed` calls that promote, the count of
  per-element callbacks that bind a handler without the index, and how
  often footprint analysis widens (83 of 1,962 bodies, 4.2%, counting
  helpers) all need the type-checker prototype.
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
2. **One reconciliation pass per document,** each by one author, applying
   the corrections of the cross-read record that need no ruling and the
   rulings that exist by then. The order follows what governs:
   `plan-and-label-templates.md` first, because most requests are addressed
   to it, with specs pull request #91 changed in the same pass; then
   `builtin-inventory.md` and `language-subset.md`; then the three newer
   documents, where `execution-and-storage.md` and
   `scheduler-and-serving-loop.md` are reconciled by authors who each read
   the other in full; the overview last.
3. **Bring specs pull request #91 up to `plan-and-label-templates.md`**
   (section 2 of the record), and add the label rules listed above.
4. **One corpus measurement** with one stated method, so that the three
   documents quote the same totals.
5. **Read the documents against each other again** after the passes, and
   record the result beside the first record.
6. **Begin stage 2 of the overview's staging:** prototype the subset type
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
