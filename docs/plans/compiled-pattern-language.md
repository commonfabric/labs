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
  section 5. Applied so far are the corrections to the overview,
  `language-subset.md`, `plan-and-label-templates.md`, and
  `builtin-inventory.md` that need no ruling: section 5 of the record, K1,
  K2, K6, K8 to K11, and K16 to K19. Not applied from those are the ones
  that wait on the owner (A2, A9, the first item of A14, the two senses of
  "cause" in A17, K3, and K12 to K15), the corpus counts (K4, K5, A16), and
  the numbering gap after §3.19 of the plan document (K7), which stays
  because other documents cite the numbers after it. Sections 3 and 4 of
  the record, on the three newer documents, are not applied.
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

Each ruling is written into the documents. One marked *pending* is not yet
in every document it touches; the passes write it in. This list exists so that none is
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
  compiled artifact, evaluate the same gates, and never request effects,
  with one exception: a client enacts `navigateTo` from its speculative run,
  reconciled with the server's result as it is today. *(The exception is
  pending.)*
- One transaction per cause. A failed cone takes a labeled error state and
  the rest commits.
- A failed constraint on what a handler itself writes rejects the event's
  whole transaction. A failed constraint on a derived output drops that
  output's write alone: the output keeps what is stored, and the rest of
  the transaction commits. *(The second sentence is pending.)*
- Several events are handled in one batch. Before a handler body runs, the
  stale cones it reads are evaluated, the ones an earlier event of the batch
  made stale included. Every other derivation the batch made stale settles
  once behind the batch, not once per event. *(Pending.)*
- A change of demand is a cause of its own, the fourth kind. It has a
  transaction of its own, which runs as the demanding principal.
  *(Pending.)*
- A conflict on a derived write withdraws that write alone, and the rest
  of the cause's transaction commits. *(Pending.)*
- A handling is identified by the receipt, which leaves the acting
  principal out. *(Pending.)*
- A cone is evaluated at most ten times in one transaction. The number is
  a placeholder, fixed with the plan version. A cone that failed at the
  bound is not evaluated again until one of its inputs changes.
  *(Pending.)*
- The identifier of a space that an `inSpace` request creates is obtained
  and not derived from the request. The allocation is recorded in a step
  that commits before the step in the foreign space, so that a retry
  names the same space. *(Pending.)*
- A client cannot read the element-key salt. It cannot name value-keyed
  per-element state, or a binding with copied captures, before the server
  stores a link. *(Pending.)*

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
  *(Pending. Question 38 is what the first correction means in a `lift` or
  a `computed`.)*
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
- A handler binding made in a function body copies a scalar and a value
  the body computed. It binds a container that has a stored address by
  reference, as it is today: the handler reads the container when an event
  arrives, and a record the handler passes on links to the original. A
  binding made in the reactive tier copies nothing, the body of a
  per-element callback included: every path of the handler's state is a
  slot of the instance. *(Pending.)*

**Identity and storage**

- The keep set of an instance is everything reachable from its result cell,
  the rendered `[UI]` tree included. Interim values are not stored and not
  labeled.
- The keep set is stored in as many documents as serve its readers, not in
  one. A kept subtree, such as a row of a kept collection or a part of the
  rendered tree, can have a document of its own, linked from the result, so
  that a reader loads and subscribes to the parts it uses. One evaluation
  writes all the documents it changed in one transaction. The split can be
  fine, and the runtime decides it by a rule about size. *(Pending.)*
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
  *(The second is pending.)*
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
    non-atomic sequence: access changes, then foreign batches, then home.
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
38. **A reactive `map` in a `lift` or a `computed`**
    (`language-subset.md` §5.2 and §10.3). The correction "wrap it in
    `pattern(...)`" is an instantiation. A `handler` or an `action` may
    write it. A `lift` or a `computed` does not instantiate a pattern
    (decided above; `function-body:instantiation-in-computation`), so the
    wrap is refused there too. *Assumed:* that rule stands, and in a
    `lift` or a `computed` the diagnostic says to move the `map` to the
    pattern body, where a computation that chooses the list passes it on
    as a reference. The alternative lets a computation instantiate an
    inline pattern that requests no effect, directly or through what it
    instantiates, which the compiler can check because it has the body;
    the instance is then identified by its site, and a re-evaluation
    names the same instance.

## Open, and not needing the owner

The cross-read record lists each of these with the side that governs and the
correction. The ones more depends on:

- **Between `execution-and-storage.md` and `scheduler-and-serving-loop.md`**
  (section 3 of the record): one transaction or two for an effect's
  completion; when a kept output's value is staged and in what order labels
  are instantiated; slots resolved before a cone runs or on first read;
  what is current after a restart; what a rejection leaves in the memo;
  labels per position against a memo per key; how an event reaches its
  binding.
- **Where a result is split into documents.** The ruling leaves the rule
  about size to `execution-and-storage.md`: which subtrees get a document
  of their own, how such a document is identified so that a reorder moves
  a link and not a subtree, and what a reader of a part demands.
- **The pattern closure's remaining gaps** (K12): which output or argument
  path holds which entry of `Plan.closures`, a conditional between two
  closures, a closure called through `inSpace`, and the private parameters
  of an inline pattern instantiated from a function body.
- **Corpus counts** differ among `language-subset.md`,
  `builtin-inventory.md`, and `footprint-analysis.md` (K4, K5, A16, F20).

The open questions each document ends with stay where they are.

### What each document changes to agree with `plan-and-label-templates.md`

The plan document has the records and label rules the three newer
documents asked for, and five rulings written in. The other six documents
do not agree with it yet. Each list is the brief for that document's pass,
beside the findings of the cross-read record that name the document.

**`plan-and-label-templates.md`**, from the footprint pass
(`footprint-analysis.md`, request 16): six things the analysis produces
that the record cannot express.

- A `shape` observation at a position that holds a handle: whether a
  handle is present observes the position, and every class but `identity`
  resolves through a link at the last segment.
- A widening on a computed input, which `Widening.slots` cannot name.
- A write through `h.resolveAsCell()`, which lands where the resolution
  ends and not in the cell `h` links to.
- A handle found by a dynamic read, which has no slot for an entry of
  `handles` to name.
- The captures of an inline pattern instantiated in a body (K12).
- `equalLinks`, which has no row among the context reads.

And from the ruling on what a handler binding copies:

- §3.14, "Binding a handler": a captured container that has a stored
  address is a reference, and the stream's identity takes that address in
  place of the container's content.
- `Binding.state`: what `capture` records for such a container, and that a
  binding of the reactive tier has no copied path.
- §4.1: the list of places a template is instantiated names "a state path
  of a binding that is copied".

**`footprint-analysis.md`**, from the same ruling:

- §8.5: the rows of the table for a container. A container read from an
  input or a cell records `identity` in the body that makes the binding,
  and the binding holds a link. The rows that copy remain for a scalar and
  for a container the body computed.
- §8.5 "Against today" and the row for a handler binding in §12.4: equal.
- §3.8: the destination "into a handler binding".
- Owner question 3 is ruled, and request 15 is answered.

**`execution-and-storage.md`**

- §1.1, §1.2, §1.5, §10.1: an event's transaction has no derivation step
  behind the body; derivations run in one transaction behind the batch.
- §1.2, §1.7, §3.3: a failed constraint on a derived write drops that
  write alone; what the memo holds for it.
- §1.2 step 5, §1.6: the three conditions of §4.1 of the plan document;
  effect requests and cached outputs are instantiated; values are staged
  at evaluation; labels resolve against what the transaction staged
  (§4.5).
- §1.3, §2.3: a cone edge through a handle beside one through a state
  cell.
- §1.4, §2.4: which handles a body is handed, `get()` under the envelope,
  `sample()`.
- §1.8, §1.9: the output's scope; what the digest binds (§4.6).
- §2.1, §2.2: interim outputs; the runtime narrows a computed input;
  slots resolve through links.
- §2.5, §3.1, §3.2: label identifiers of element slots are per position.
- §2.7: withdrawn side-writes, and the error state of an argument or a
  request.
- §4.1 to §4.4, §4.9: several documents. The document owns which subtrees
  get a document, how a part is identified, and what a reader of a part
  demands. A link to another instance's output is a slot across the link.
- §4.1, §6: a materializer's state document and an effect's stored
  request.
- §5.2, §5.5: names as §1.3 of the plan document has them.
- §6.5, §7.4, §8.4 to §8.7, §9: the labels of §2.6 of the plan document.
  The assumption that provenance is protected as label metadata was
  unsound and is replaced there.
- Section 3 of the record: findings 1, 2, 3, 5, 6, 7, 10, 11, 12, 13, 18,
  21, and 26.
- From the footprint pass: the body is handed every handle its record
  names, and the resolved reference for a resolved entry; stand-ins for
  `shape`, `enumeration`, `identity`, and reference positions in an
  argument and in a binding's copy.

**`scheduler-and-serving-loop.md`**

- §1.4, §5.2, §5.4, §10.2: the batch ruling.
- §5.5, §5.6: only a handler's own writes reject its event; a failing
  constraint in another instance drops that write.
- §2.2: element bindings by slot and position.
- §2.4, §5.2, §7.2: a materializer's envelope is its body's `writes` and
  `envelopes`; what a creation-site envelope means for promotion.
- §2.6, §8.2: the writer map and the cycle report include targets through
  a handle and stored requests.
- §3.1 to §3.5: resolved slots, storage links left out of chains, sampled
  reads, journaled label-metadata reads, the deletion answer reported at
  the access-list address, labels staged within a transaction and a batch.
- §4.2: demand per path over several documents.
- §5.3: a static read through a handle is a slot.
- §6.2, §6.3: a request is a write edge and not a kept output; the request
  transaction follows references and runs again when their content
  changes.
- §2.5, §6.7: `navigateTo` on a client (ruled).
- §7: a materializer's result through an `operation` slot.
- Section 3 of the record: findings 1, 3, 8, 9, 14, 19, 20, 23, and 24.
- From the footprint pass: open question 24 is answered in
  `footprint-analysis.md` §8.5; §5.3 does not order by a read envelope.

**`builtin-inventory.md`**

- "Element keys": `within` steps in place of `perElementOf`.
- Each effectful built-in: which operands of a request are references,
  and how deep the rest is serialized.
- "An effect request made from a body": the request is a write edge, and
  the ceiling covers the content followed.
- "Context reads": `resultOwnerOf`, the resolved reads, `spaceDeleted`,
  and journaled label-metadata reads.
- Open questions 10 and 11, which the plan document answers.
- "An instantiation request from a handler": "whether the value is copied
  or is a cell handle" against the reference rule.
- "A handler binding made in a body": the ruling on what a binding copies,
  in the static record, the identity, and the label.

**`language-subset.md`**

- §4.7: `resolveAsCell()` observes a resolved reference; `get()`,
  `key(k)`, and `elementById` in the reactive tier.
- §5.4, §10.3: a widening covers the entries it replaced.
- §4.4.1, §4.6: the naming rule of §1.3 of the plan document.
- Open questions 9 and 10.
- §4.7, §10.2: `cell:collection-method-in-function` names both
  corrections, the inline `pattern(...)` and `get()` first (ruled; see
  question 38 for a `lift` or a `computed`).
- §5.2: a binding made in a function body copies a scalar and a computed
  value and binds a stored container by reference (ruled). The identity of
  a binding takes the address of a container bound by reference, so two
  bindings to equal records stored in two places are two streams. A
  binding of the reactive tier copies nothing. §7.8: what a kind test or a string conversion
  sees at an `unknown` data position. §10.3: `footprint:widened` names one
  input path where a widening covers several entries or a handle.

**The overview**

- "One transaction per cause": the batch, and the two outcomes of a failed
  constraint.
- Staging and "Label templates": two exceptions to equal or tighter.
- "Pull and dependency cones": the widening sentence.
- "What is stored" and the example: several documents.
- Clients: the `navigateTo` exception.
- "Where footprint analysis gives up it widens a static slot, and no
  dynamic tracking is involved" does not hold for a handle the analysis
  loses.

### Found while correcting the first four documents

These are not in the cross-read record. Each is left as it was found.

- **`setSchema`** is removed by `language-subset.md` §4.7 and has no
  catalog entry. That document also does not say whether a cell handle
  type is a data type or a code type, which its rule for imported
  signatures depends on.
- **The overview** still says a `map` element is a cone with a key, where
  an element body is one or more cones; that the scheduler's rule P7
  applies to cycles, where the proposal fails the cone at the bound; that
  a handler's read closure is static, which does not hold for the reads
  footprint analysis leaves dynamic; and that the compiler checks
  statelessness in all three tiers, where imported modules keep the
  load-time verifier.
- **Wording that the pass left uneven.** `plan-and-label-templates.md` now
  calls the callback of `minBy`, `maxBy`, and the indexes the key
  function; `language-subset.md` and `builtin-inventory.md` say selector.
  `language-subset.md` cites open questions of the newer documents by
  number.

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
  It has the pattern closure, the rulings on batches and on a failed
  constraint, slot paths through references, and the labels of state the
  runtime stores. Section 2 of the record lists what it still lacks: among
  others the changed-factory rule and the `inSpace` rule of the Decided
  list, most context reads, and the group-mode rules of the collection
  index. It has not been reviewed. Its Lean development states the two
  target theorems; everything added after the first draft is prose and
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
2. **The remaining reconciliation passes,** each document by one author,
   from the lists under
   [What each document changes](#what-each-document-changes-to-agree-with-plan-and-label-templatesmd)
   and the findings of the record: `execution-and-storage.md` and
   `scheduler-and-serving-loop.md`, by authors who each read the other in
   full; then `plan-and-label-templates.md` for what the footprint pass
   found it cannot express, with the specification; then
   `builtin-inventory.md` and `language-subset.md`; the overview last. A
   pass keeps the stated assumption wherever a question above is still
   open.
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
