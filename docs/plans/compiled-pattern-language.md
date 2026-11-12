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
  each. This plan cites its findings by number: K1 to K19, the numbers 1
  to 26 of its section 3, F1 to F21, and the A, B, C, and D numbers of its
  section 5. Its corrections are applied in every document, in two rounds
  of passes. Not applied are the ones that wait on the owner (A2, A9, the
  first item of A14, the two senses of "cause" in A17, K3, K13, and what
  remains of K12), the corpus counts (K4, K5, A16, F20), and the numbering
  gap after §3.19 of the plan document (K7), which stays because other
  documents cite the numbers after it.
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
  over plain values that declares a state cell or binds a handler without
  using the index is a compile error.
- Stored per-element state is not carried over from the current runtime.

**Labels**

- Template labels are equal to or tighter than today's, with two deliberate
  exceptions. One is the collection index, where the keys of absent elements
  join a bucket's membership label. The other is a read through a handle
  that is static because every run that returns normally makes it: a run
  that throws before the read carries the read's label all the same.
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

19. **`.for(tag)` in a handler** (K13). The plan document and the inventory
    have it name the same thing across events; today every identifier
    minted in a handler derives from the event.
20. **Bounds beyond one transaction** (SS question 9, findings 11 and
    12). The bound on a cone within a transaction is ruled. Open: whether
    an effect whose completion changes its own request, or a cycle across
    two spaces, is bounded at all.
21. **Event order per space** (SS question 10). *Assumed:* the proposal of
    Scheduler v2 §7.5.

**Clients.**

23. **A predicted refusal** (SS question 7). *Assumed:* no speculative
    result, a mark on the control, and the event is still sent.

**Migration.**

24. **Compiled and builder-path instances in one space** (finding 20,
    SS §10.8). ES migrates instances one at a time. *Assumed:* one serving
    runtime hosts Scheduler v2 and this scheduler side by side until the
    builder form is retired.
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
30. **`inspectConfLabel` on an interim value** (K3). The plan document
    instantiates the value's template when asked; the inventory answers
    `notAvailable`. The ruling says an interim value is not labeled.
31. **A child instantiated per element over equal plain values.** The
    compile error for shared per-element state covers a body that declares
    a state cell or binds a handler. A body that instantiates a child is
    not covered: the child's result cell is named by the element key, so
    two equal plain elements share one child and its state. A
    factory-typed element is a plain value, so
    `factories.map((F) => F({ ... }))` is the plain case. *Assumed:* the
    error is as ruled and does not cover it.
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
38. **An instance made in a `lift` or a `computed`.** The ruling allows
    the instantiation and leaves two things to assume. *Assumed:* the
    instance is identified by the enclosing instance, the body's name
    and the calls and callbacks it is written in, the site, and the
    ordinal of the instantiation among those the evaluation makes at that
    site, or by an explicit cause where the author writes
    `.for(cause)`; and a `lift` or a `computed` still does not request an
    effect directly, so an effect that depends on computed data is
    written in a pattern, inline or named, that the computation
    instantiates. With the ordinal, a site in a loop names its instances
    by loop order: removing the first record gives each instance the
    argument of the next record and tears down the last one, unless the
    author writes `.for(cause)`.

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
40. **What is stored once per element key** (PL §2.6, question 27; ES
    §2.5). Positions that hold equal plain values share one key. An
    effect's request and result, operation state, a child's argument, a
    side-write, and a binding's copied state are stored once for the key.
    *Assumed:* where the positions resolve to different labels, what is
    stored carries the join. That is looser than today, where each
    occurrence has its own run, and would be a third exception to "equal
    to or tighter". The alternative keys these as per-element state is
    keyed.
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
51. **What a language-model built-in sends that no checked request held**
    (BI question 6): tool-loop results, a system prompt rendered again
    from live context after the commit, and the live transcript of a
    dialog. The egress ceiling checked at the request covers none of it.
    *Assumed:* the boundary's own transactions label it.
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

## Open, and not needing the owner

Both rounds of passes are done, and each document's requests to the others
are marked met where they are. What is left:

- **The pattern closure's remaining gaps** (K12): which output or argument
  path holds which entry of `Plan.closures`, a conditional between two
  closures, and a closure called through `inSpace`.
- **Corpus counts** differ among `language-subset.md`,
  `builtin-inventory.md`, and `footprint-analysis.md` (K4, K5, A16, F20).
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
- **`setSchema`** is removed by `language-subset.md` §4.7 and has no
  catalog entry. That document also does not say whether a cell handle
  type is a data type or a code type, which its rule for imported
  signatures depends on.
- **Uneven wording.** `language-subset.md` says selector where the other
  documents say key function, and it cites open questions of the newer
  documents by number.

The open questions each document ends with stay where they are.

## Known limits of what exists

- **The cross-read did not cover every section.** Each reader states what
  was not read in full at the end of its section of the record. The
  overview was checked against the three new documents only in part.
- **Specs pull request #91 is behind `plan-and-label-templates.md`** in
  what section 2 of the record lists and the passes did not reach:
  stateful element bodies; the run-time schema check of a child instance
  and that its argument is always stored; `.for(tag)` with its frozen
  existence label, `asScope`, and a cell cause computed from data; the
  declared-default exception of error states; most context reads; the
  array capture of `map`; the group-mode rules, tie rules, and nullish
  keys of the collection index and the aggregates; and the pull request's
  description. It does not state the bound of ten evaluations, the
  handling identified by its receipt, or that a client cannot read the
  salt. It has not been reviewed. Its Lean development states the two
  target theorems; everything added after the first draft is prose and
  pseudocode only, and the calculus models no body calls, references, or
  bindings.
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
- **No one has read the seven documents against each other since the
  passes.** The overview's author read the six detailed documents and
  the differences found were corrected, but that was not a full
  cross-read.
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
2. **Read the documents against each other again,** with readers briefed
   as below, and record the result beside the first record.
3. **Bring specs pull request #91 up to `plan-and-label-templates.md`**
   for what [Known limits](#known-limits-of-what-exists) lists, and for
   each ruling.
4. **One corpus measurement** with one stated method, so that the three
   documents quote the same totals.
5. **Begin stage 2 of the overview's staging:** prototype the subset type
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
