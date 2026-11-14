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
  prototype commit `def495749e`, on 426 corpus modules, it accepts 335
  without an error and reports 384 errors: `any` in a type (182), 73
  type mismatches, a function type in data from one declaration (35),
  and `patternTool` (31) are most of them. Footprint analysis covers
  `footprint-analysis.md` §2 to §8, with the record of each use of a
  body, and finds 90 of 1,972 bodies widening (4.6%) where the
  document's script found 83 of 1,962. Its listing for FabriChat's
  `commitEdit` equals the one in §12.3. Plan emission is started: a
  `plan` command emits slots, state cells, collections, bodies per use,
  bindings, operations, selectors, picks, cones, outputs, edges, and
  dynamic reads as JSON, with no label templates, hashes, or
  constraints. It emits a plan with no unsupported construct for 183 of
  the 288 accepted modules that hold a pattern; the most frequent
  unsupported constructs are a call the emitter does not resolve,
  `wish`, and an element construct over a constant. Six of the twelve
  diagnostics that need more than types are emitted; the six
  `cfc-flow:*` need label templates. The prototype differs from the
  documents in three known places: it reports `addUnique` under
  read-then-push, its constant cause is narrower, and it misses
  destructuring and keyed access for widening by a recursive type. The
  crate's `SPEC-NOTES.md` lists the places where it found the documents
  ambiguous; notes 86 to 97 are not yet written into the documents.
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
- A read of a default carries no integrity. Where a stored object has
  an absent property and a default fills it, the defaulted part carries
  the empty integrity, not the object's claims. The specification has no
  rule for a default that is read and not stored, and needs this one.
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
- A `map` element is keyed by its value when it is a plain value and by its
  cell identity otherwise. The index joins the key only when the callback
  uses it. A value-derived key is salted with a secret of the space.
- Equal plain values share a cone for computation only. A per-element body
  over plain values that declares a state cell without using the index is
  a compile error. A body that binds a handler and declares no state cell
  is accepted: equal elements bind equal state, and they share one
  stream.
- Where a per-element body over plain values instantiates a child, the
  position joins the element key, so equal elements have a child each.
- Stored per-element state is not carried over from the current runtime.

**Labels**

- Template labels are equal to or tighter than today's, with three
  deliberate exceptions. One is the collection index, where the keys of
  absent elements join a bucket's membership label. The second is a read
  through a handle that is static because every run that returns normally
  makes it: a run that throws before the read carries the read's label
  all the same. The third is what is stored once for an element key (an
  effect's request and result, operation state, a child's argument, a
  side-write, a binding's copied state): where positions that hold equal
  plain values resolve to different labels, it carries the join. The
  third is to be revisited.
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
    the original" a rule of the language.
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
    torn-down instance held elsewhere reads the last stored values.
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

72. **A state cell beside a child in a per-element body over plain
    values** (PL §8 question 34; LS question 21). *Assumed:* accepted,
    because the key holds the position.
73. **Which instantiations put the position in the key** (PL question
    37; FA question 3). *Assumed:* a factory value called in the body's
    reactive tier, and a pattern a `lift` or `computed` in the body
    instantiates; not a handler's instance and not a statically resolved
    pattern; under nested bodies, at every enclosing level over plain
    values.
74. **A cell a computation creates under the element key over plain
    values** (FA question 4). *Assumed:* the compile error covers it
    where the body does not use the index.
75. **The element slots of a handler whose stream several positions
    share** (PL question 35). *Assumed:* they resolve to the join over
    the positions.
76. **The child of a plain element that moved** (PL question 36; ES
    question 67). A child does not move with its value: a reorder tears
    down the child of each key that left and sets up a new one, and an
    insertion at the head of n distinct plain values replaces n children.
    *Assumed:* accepted, with the advice to make the elements cells.
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

95. **A write through a handle bound to a value the instance computes**
    (PL question 42; LS question 28): a `computed` result or an operator
    result given where a handler, a `lift`, or a compiled-in pattern
    declares a writable handle. The corpus has 21 such arguments in the
    reactive tier, of which 2 are written through (one is a test of this
    behavior, one is in `topics/topic.tsx`), and 13 more given to a
    pattern instantiated in a function body, all written through, in
    `notebook.tsx`, `daily-journal.tsx`, and `weekly-calendar.tsx`.
    *Assumed:* the runtime refuses the write. The alternative lets it
    land and be replaced at the next evaluation, which is understood to
    be what happens today.
96. **The integrity of a slot that reads a stored object whole where a
    default fills one of its properties** (PL question 43). *Assumed:*
    the meet over the parts read, which is empty, so one defaulted
    property removes the object's claims from a whole read. The
    alternative keeps a label per path below the slot.
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
  tier of an element body is addressed by no document.
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
- **A container bound by reference from an inline plain element that two
  positions share** has two addresses and one shared evaluation. No
  document examines it.
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
  How often footprint analysis widens (83 of those 1,962 bodies, 4.2%),
  and which per-element callbacks run over plain values, need the type
  checker.
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
