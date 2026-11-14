# Built-in inventory (proposed)

**Status:** proposed. This document details one part of the
[compiled pattern language](README.md). It lists every built-in and every
factory that an author or the transformer can call, states what each one does
as implemented, and says what each becomes in the compiled design. The
project owner's rulings on the classification are listed under
[Decisions](#decisions), and what remains undecided under
[Open questions](#open-questions).

The sibling documents specify the neighboring parts. This document refers to
them by file name and does not define their content:

- `language-subset.md`: the grammar, type rules, and diagnostics;
- `plan-and-label-templates.md`: the plan format, slots, observation classes,
  and the formal label rule of each operation. Each "Label rule" paragraph
  below states the facts that document needs, informally;
- `footprint-analysis.md`: what a function body's record holds for the
  reads, the writes, and the runtime calls the body makes;
- `execution-and-storage.md`: the transaction of a cause, causal
  identifiers, and the durable state of operations;
- `scheduler-and-serving-loop.md`: when an effect is requested and
  completed, commits across spaces, and client speculation.

## Scope and method

The inventory has three sources, and every entry was written from the
implementation and not from the name:

- the 31 modules that `registerBuiltins` registers in
  `runtime/runner/src/builtins/index.ts`, and the helper modules beside them;
- the authoring surface: the `surface` object that `createBuilder` assembles
  in `runtime/runner/src/builder/factory.ts`, which is both the `commonfabric`
  module a pattern imports and the `__cfHelpers` object the transformer
  refers to, with its declarations in `base/api/index.ts`, and the methods of
  `CellImpl` in `runtime/runner/src/cell.ts`;
- the forms the transformer emits, from `base/ts-transformers/src/` and
  `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`.

Citations name a file and a function or section. Paths that begin with
`builtins/`, `builder/`, `cfc/`, or `storage/` are relative to
`runtime/runner/src/`.

### The four classes

Each entry is placed in one class.

- **A, structural operation.** It becomes a compiler operation with a label
  rule and stops being a callable factory. Authors write a construct of the
  language instead.
- **B, effectful operation.** It stays a durable boundary with a declared
  label rule and its own transactions. Requesting one from the reactive tier
  or from a function body behaves like instantiating a built-in pattern.
- **C, authoring marker.** It stays in the language as syntax the compiler
  recognizes: `pattern`, `handler`, `computed`, and the like.
- **D, removed.** It has no counterpart, and the entry names the replacement.

Several built-ins mix structural and effectful behavior. Their entries say how
they split, and the summary table lists both halves.

### Fields of an entry

- **Does:** behavior, inputs, and outputs.
- **Reads:** what is read and how. The five observation classes of
  `plan-and-label-templates.md` §2.1 are used: *value*, *shape*,
  *enumeration* (length or key set), *identity* (a link is resolved and its
  target is not read), and, as the fifth, *label metadata* (the label stored
  for a path is read and its content is not). The entry also names the read
  markers the implementation applies, all from `storage/reactivity-log.ts`:
  - `linkResolutionProbe`: a "is there a link here" probe that consumes the
    pointer's label and never the target's;
  - `machineryRead`: a read the runtime makes for its own bookkeeping, left
    out of the labels the transaction consumes;
  - `ignoreReadForScheduling`: a read that does not subscribe the action;
  - `internalVerifierRead`: a read through the runtime's verifier seam, left
    out of flow derivation;
  - `declaredOnwardRead(target)`: a read whose confidentiality lands on the
    membership stamp of `target` instead of on everything the transaction
    writes;
  - `writeDestinationRead`: a read of the document the transaction is about
    to write, left out of the flow join.
- **Writes and state:** what is written, whether the write surface is static,
  and which durable documents exist under which causes.
- **CFC:** how labels stay precise, what integrity is minted, and any special
  handling in `cfc/`.
- **Execution:** where it runs under
  [server-primary execution](../server-side-execution/README.md) (§3.5) and
  whether clients speculate it, and how the scheduler treats it
  ([Scheduler v2](../scheduler-v2/README.md), §4): as a computation, an
  effect, or a materializer.
- **New design:** the class, with the reason.
- **Label rule:** for class A, which inputs flow to which outputs with which
  observation class. For class B, the declared rule at the boundary and the
  state that must be stored.
- **Request operands:** for class B, which operands of a request are
  references and how deep the others are serialized, as the implementation
  reads them. [Effectful built-ins](#effectful-built-ins) says what the
  compiled design does with those facts.

## What every built-in shares

These facts hold for every registered built-in and are not repeated per entry.

- **Shape.** A built-in is a `raw` module (`raw` in
  `runtime/runner/src/module.ts`). Its implementation is called once per node
  instantiation with the inputs cell, a `sendResult` function, a cancel
  registrar, a cause, the parent cell, and the runtime, and it returns an
  action or a `RawBuiltinResult`. The inputs cell is an immutable document
  that holds the node's bound inputs as links.
- **Cause.** The cause (`RawNodeCause` in `runtime/runner/src/module.ts`) is
  `{ inputs, parents, outputSpot? }`. The `inputs` part is content-addressed
  over the serialized inputs, so it changes with literals and schemas. The
  `parents` and `outputSpot` parts are stable while the node keeps its place
  in the pattern. Built-ins differ in which parts they key their stores on,
  and the entries say which.
- **Scheduler kind.** `#instantiateRawNode` in `runtime/runner/src/runner.ts`
  registers the action as an effect only when the module or the returned
  result sets `isEffect`. One built-in does (`navigateTo`). Every other
  built-in is a computation, including the ones that perform network
  requests: their requests leave through the post-commit outbox, not from the
  action. Two built-ins declare materializer envelopes
  (`collectionIndexMember` and `llmDialog`), one sets `deferUntilDemand`
  (`collectionIndexKeys`), and one is debounced (`wish`, 50 ms).
- **Owned stores.** A built-in that keeps state mints it with `ownedCell` in
  `builtins/runtime-owned-store.ts`. The store is a document in the parent's
  space, named to CFC's write-side fit check as a runtime-owned store
  (`CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE`) and enrolled until the
  owning piece is cancelled. The marker exists because a built-in's store
  holds whatever its transactions read, which no authored schema declares.
  Stores whose identity follows from the node alone are declared at setup as
  `storeWrites` and join the scheduler's static side-write tier.
- **Implementation identity.** A registered built-in resolves to the CFC
  implementation identity `{ kind: "builtin", builtinId }`
  (`resolvePolicyFacingImplementationIdentity` in
  `cfc/implementation-identity.ts`). The runtime-minted integrity family
  `LlmDerived` is admitted only from a write under such an identity.
- **Name special-casing.** No structural built-in is special-cased by name in
  `cfc/` or in the scheduler. Precision comes from the read markers and from
  running separate transactions. `runner.ts` special-cases `map`, `filter`,
  and `flatMap` by name in two places: `#substituteOpPatternRefs`, which
  replaces the `op` input with a `$patternRef` sentinel, and the resume
  pre-sync of list coordinator plans.
- **Replayability.** `builder/builtin-replayability.ts` lists by name the
  built-ins whose writes a re-run reproduces
  (`REPLAYABLE_BUILTIN_REFS`). The computed-cell classifier trusts only those
  names.
- **Effect requests.** An effectful built-in stages its request with
  `enqueueSinkRequestPostCommitEffect` in `cfc/sink-request.ts`. The call
  records a `sink-request` write-policy input that holds a frozen snapshot of
  the request, and queues a post-commit effect. The effect runs only after
  the staging transaction commits and `verifySinkRequestRelease` finds the
  recorded snapshot equal to the request. The egress check is
  `verifySinkRequestCeilings` in `cfc/prepare.ts`. It compares the
  confidentiality the *whole staging transaction* consumed with a ceiling
  configured per sink name, so it is not a measure of the request alone. The
  default configuration has no ceilings
  (`DEFAULT_SINK_MAX_CONFIDENTIALITY` in `cfc/sink-inventory.ts`). Results are
  written by separate transactions (`runtime.editWithRetry`) marked with
  `markEffectCompletion`, from
  `runtime/runner/src/executor/effect-completion.ts`.
- **Speculation.** On a client that speculates, the action of an effectful
  built-in still runs and writes its pending state into the overlay. What is
  suppressed is the effect: `deferSealedEffects` in
  `runtime/runner/src/speculation/overlay-destination.ts` enacts effects of
  kind `navigateTo` and drops every other kind. In the view-scoped client
  mode no raw built-in factory is constructed, and the client reads stored
  output links
  ([built-in contracts](../server-side-execution/builtins.md), "Anchors").

## Structural built-ins

### `ifElse`, `when`, `unless`

- **Source:** `builtins/if-else.ts`, `builtins/when.ts`, `builtins/unless.ts`,
  and the shared `forwardReference` in `builtins/forward-reference.ts`.
  Authored as `ifElse(condition, ifTrue, ifFalse)`, `when(condition, value)`,
  and `unless(condition, fallback)` in `builder/built-in.ts`, each with a
  second form that takes schemas first. The transformer emits them for `?:`,
  `&&`, and `||` at pattern-owned sites (`createIfElseCall`, `createWhenCall`,
  and `createUnlessCall` in
  `base/ts-transformers/src/transformers/builtins/ifelse.ts`).
- **Does:** selects one input by the truthiness of `condition` and writes a
  *reference* to it. `ifElse` selects `ifTrue` or `ifFalse`. `when` selects
  `value` when truthy and the condition itself otherwise. `unless` selects the
  condition itself when truthy and `fallback` otherwise.
- **Reads:** the condition's truthiness at its root only
  (`readsTruthyAtRoot`), decided under the schema the condition's link
  carries, so a declared default stands in for an absent value. Nothing below
  the root of a record or array condition is read. The selected input is
  resolved as a link and never read by value. One read of the node's own
  store is marked `ignoreReadForScheduling` and `internalVerifierRead`
  (`forwardsNothingToUnwrittenStore`). For `ifElse`, the argument schema
  `IF_ELSE_ARGUMENT_SCHEMA` marks both branches `asCell: ["opaque"]`, which
  removes them from the node's declared reads so that the writer of the
  unselected branch is not pulled. `when` and `unless` are registered without
  an argument schema, so their second input stays a declared read although
  the action never reads its value.
- **Writes and state:** one store per node with cause
  `{ <name>: parents, outputSpot }` (`ownedResultCause` in
  `builtins/scope-policy.ts`), at the scope of the resolved condition. The
  value is a link to the selected input that carries the schema the target
  resolved to. A run that selects the reference already stored writes
  nothing. The write surface is static and declared as `storeWrites`.
- **CFC:** the transaction reads the condition's root and link topology, so
  its join holds the condition's label and the pointer's, and neither
  branch's content label. Where the selected branch is a literal, the store
  holds the literal's value and `derived` entries with that join. Where the
  selected branch is a reference, no entry holds the join: the store's
  write and the write of the link at the node's output binding are not
  recorded as link writes, so `prepareBoundaryCommitSteps`
  (`cfc/prepare.ts`) stamps neither slot. A reader that follows the
  reference consumes the selected branch's label at that point. No
  integrity is minted. The document the output binding names also holds,
  as an entry of origin `declared`, the confidentiality that the schemas of
  the condition and of both branches declare, whichever branch is selected
  (`applyInputIfcToOutput` in `builder/node-utils.ts`). For a conditional
  over references that entry is the one place the condition's label
  reaches a reader from. By ruling the template does not join that static
  part, and is tighter there; the template joins the condition, and the
  missing stamp is a finding against the runtime
  (`plan-and-label-templates.md` §3.1 and §3.5, and its question 69).
- **Execution:** pure structural: served, and speculated by clients.
  Computation; replayable.
- **New design:** class A. The conditional expressions `?:`, `&&`, and `||`
  are reactive constructs of the language, and the callable forms are
  removed, so that no new pattern is written in the old way. Nothing here is
  effectful, and the store exists only to hold a link. The compiler may
  accept `ifElse`, `when`, and `unless` for an interim period, with a
  warning that names the replacement, only as long as doing so costs it
  nothing beyond mapping each call to the same operation as `?:`, `&&`, and
  `||`. The schema-first forms the transformer emits are not accepted.
- **Label rule:** the output's slots are the condition slot plus the slots of
  the selected operand, as `plan-and-label-templates.md` §3.5 defines for
  `select`. Three facts refine it.
  - The condition is observed for *truthiness at the root*
    (`readsTruthyAtRoot`). `plan-and-label-templates.md` gives that read the
    class `value` for a scalar condition and `shape` for a record or array,
    whose truthiness is its existence. This matches the implementation:
    nothing below the root of a record or array is read, and under that
    document's definitions a `value` slot at a container would cover its
    children, which is more than the read learns. A condition whose static
    type admits both a scalar and a container needs both slots.
  - For `&&` and `||`, one arm *is* the condition. When that arm is selected,
    the output carries the condition's full value slots, not only its
    truthiness.
  - The output is a reference to the selected operand, not a copy. A default
    declared on the selected operand's schema reaches readers of the result.
    `plan-and-label-templates.md` §3.5 keeps that behavior: the result of a
    `select` is the selected operand itself.

### `str`

- **Source:** `builtins/str.ts`. Authored as a tagged template in
  `builder/built-in.ts`. The transformer never emits it: a plain template
  literal with reactive substitutions lowers to a `lift`
  (`createReactiveWrapperForExpression` in `rewrite-helpers.ts` under
  `base/ts-transformers/src/transformers/expression-rewrite/`).
- **Does:** concatenates `strings` and `values` exactly as a native template
  literal does, including how `undefined`, `null`, and objects render.
- **Reads:** one value read of both arrays through `STR_ARGUMENT_SCHEMA`. The
  `values` array has no item schema, so a substitution that is a record is
  read in full.
- **Writes and state:** the primary output only. No store.
- **CFC:** the ordinary transaction join of everything read. No integrity.
- **Execution:** pure structural; computation; replayable.
- **New design:** class A, merged with template literals. A template literal
  is a reactive expression of the language, and the `str` tag is removed in
  its favor, since the two differ only in spelling. The compiler may accept
  the tag for an interim period, with a warning, on the same condition as
  the conditional helpers: it maps to the operation of a template literal
  and costs nothing more.
- **Label rule:** the output's slots are the value slots of every
  substitution. A substitution whose static type is a record or array
  contributes its whole subtree as one slot, because string conversion
  observes all of it.

### `map`

- **Source:** `builtins/map.ts` (`map`, `createMapInstance`), with the shared
  coordinator modules `builtins/list-coordinator-plan.ts`,
  `builtins/list-element-keys.ts`, `builtins/list-instance-coordinator.ts`,
  `builtins/list-element-rollback.ts`, `builtins/list-result-container.ts`,
  `builtins/list-op-argument-usage.ts`, and `builtins/op-pattern-ref.ts`.
  Reached through `mapWithPattern(op, params)` in `runtime/runner/src/cell.ts`.
  The function form `map(fn)` throws at run time
  (`throwOpFunctionFormMessage`); the transformer lowers an authored
  `.map(fn)` on a reactive receiver to `mapWithPattern` with a hoisted
  pattern (`array-method-transform.ts` under
  `base/ts-transformers/src/closures/strategies/`).
- **Does:** runs one sub-pattern instance per list element and publishes an
  array of links to the per-element result cells. Sparse holes get no run and
  stay holes. An undefined list yields `[]`.
- **Reads:** the raw slot array of the list (enumeration and per-slot
  reference identity), under `declaredOnwardRead` naming the result
  container, so the list's membership label lands on the container's
  membership stamp. Each slot is resolved as a link
  (`listSlotResolutions`). The result container is read only for presence
  and prior length, under `linkResolutionProbe` and `machineryRead`. Element
  content is never read by the coordinator, with one exception: when a child
  result links to a narrower scope, `exposedResultCell` in
  `builtins/scope-policy.ts` reads the value and copies it into a re-scoped
  cell. The op's argument schema decides which of `element`, `index`,
  `array`, and `params` the child receives (`inferListOpArgumentUsage`), and
  a field the op does not name is not passed.
- **Writes and state:** the result container, with cause
  `{ map: parents, outputSpot }` at the list's scope, declared as
  `storeWrites`. One result cell per element with cause
  `{ map: container, elementKey }`, each holding a full sub-pattern instance
  started with `runtime.runner.run`. The element key
  (`listElementKeys`) is the identity of the slot's resolved target plus an
  occurrence count for a linked slot, and the slot's position for an inline
  value. A linked element therefore keeps its instance across reordering,
  and an inline value that shifts gets a new one. An existing element is
  re-run only when its setup is owed or when the op uses `index` and the
  index changed. Removed elements are released
  (`runtime.runner.releaseChild`), and their documents are not deleted. The
  set of child documents is dynamic. On resume the coordinator also issues
  transactions outside any scheduler run (`awaitInputThenSettle`).
- **CFC:** per-element precision is structural: each element's op is its own
  pattern run in its own transactions that read only that element
  (`builtins/list-result-schema.ts`). The coordinator's transaction joins
  the per-slot references and not element content. No integrity is minted.
  The container also holds, as an entry of origin `declared`, the
  confidentiality that the schema of the list and of its elements
  declares (`applyInputIfcToOutput` in `builder/node-utils.ts`). By ruling
  the template of the container does not join that static part, and is
  tighter there (`plan-and-label-templates.md` §3.1 and §3.6).
- **Execution:** pure structural: served and speculated. Computation;
  replayable. `SUBPATTERN_ARGUMENT_BUILTIN_REFS` in
  `builder/builtin-replayability.ts` additionally disqualifies every cell
  bound into its inputs from the computed kind, because the op may contain
  handlers that write the source elements.
- **New design:** class A. `map` is a reactive construct of the language.
  `mapWithPattern` has no counterpart, as the overview says: the body is
  compiled once against an element slot and is not a sub-pattern with a
  result cell. No container document and no per-element documents exist
  unless something outside the instance reaches them.
- **Label rule:**
  - Element `i` of the output depends on element `i` of the input at the
    paths the body's footprint names, on the captures the body reads, and on
    the membership of the input. It depends on the index only when the body
    uses the index. A callback has no array parameter (`language-subset.md`
    §4.4.1), so a body that reads the whole input captures it by name, and it
    counts among the captures.
  - Membership of the output equals membership of the input (enumeration and
    slot identity). Holes are preserved.
  - Element cones are keyed as [Element keys](#element-keys) specifies.
  - A body that only forwards the element (identity observation) contributes
    no value slot of the element.

### `filter`

- **Source:** `builtins/filter.ts` (`filter`, `createFilterInstance`), the
  same coordinator modules as `map`, and `builtins/resume-republish.ts`.
  Reached through `filterWithPattern(op, params)`.
- **Does:** runs a predicate sub-pattern per element and publishes a dense
  array of references to the *original element cells* whose predicate result
  is truthy.
- **Reads:** the list as for `map`, but not declared onward. The coordinator
  reads every child predicate result by value, unmarked, because membership
  depends on it.
- **Writes and state:** container `{ filter: parents, outputSpot }`, seeded
  with `[]` when absent; children `{ filter: container, elementKey }`. A new
  element's predicate is undefined on the first pass, so the element is
  excluded until the predicate run re-triggers the coordinator. On resume the
  coordinator holds a durable larger value instead of publishing a shrink
  while predicates are pending (`createResumeRepublisher`).
- **CFC:** the coordinator calls `tx.recordCfcStructureContainer` on the
  container each reconcile, so the container's structure label is re-derived
  from what the coordinator read: the list's membership and every predicate
  result. Output slots are links to the original elements, so an element's
  content label is consumed only by a reader that follows the link.
- **Execution:** as `map`.
- **New design:** class A.
- **Label rule:**
  - Membership of the output depends on the membership of the input and on
    the truthiness of the predicate for *every* element, which in turn
    depends on each element at the paths the predicate's footprint names and
    on the predicate's captures.
  - Each output element is the input element itself (identity). Its content
    slots are those of the input element; the predicate's slots are not added
    to the element's content, only to membership.
  - Order follows input order. The output is dense.

### `flatMap`

- **Source:** `builtins/flatmap.ts` (`flatMap`, `createFlatMapInstance`,
  `flatMapContribution`). Reached through `flatMapWithPattern(op, params)`.
- **Does:** runs a sub-pattern per element. A result that is an array is
  spread one level, a scalar is pushed, and `undefined` is skipped. The
  output is dense.
- **Reads:** the list as for `filter`. The coordinator reads every child
  result by value.
- **Writes and state:** container `{ flatMap: parents, outputSpot }`,
  children `{ flatMap: container, elementKey }`. The coordinator writes the
  flattened values it read into the container.
- **CFC:** `tx.recordCfcStructureContainer` on the container. Because one
  transaction reads every child result and writes the flattened array, every
  element's result label joins into that one write. `flatMap` is the list
  operation with the coarsest labels today.
- **Execution:** as `map`.
- **New design:** class A.
- **Label rule:**
  - Membership, order, and multiplicity of the output depend on the
    membership of the input and on the *enumeration* of every body result:
    whether it is an array, a scalar, or undefined, and its length.
  - An output element that came from input element `i` depends on the body's
    slots for element `i` only. This is tighter than the label the runtime
    computes today, which the staging rule of the overview permits.
  - The mapping from an output position to the input element it came from
    is data. The coordinators compute it today. In the compiled design the
    runtime computes it and the value code reports nothing
    (`plan-and-label-templates.md` §3.7): the runtime evaluates the
    per-element cone and performs the structural step itself, recording one
    fact per input element. `filter` walks the input in order and appends
    element `i` when its predicate result is truthy, so the fact is one
    included flag per input element, and output position `k` is the `k`-th
    flagged element. `flatMap` walks the input in order and appends the
    segment `flatMapContribution` returns for element `i`: nothing for
    `undefined`, one entry for a scalar, and the entries of an array with
    holes dropped. The fact is one segment length per input element, and the
    origin of output position `k` is found from the running sum. Both facts
    are `enumeration` observations of the per-element results and nothing
    more, which is why the membership template needs no element content.

### Element keys

The collection operations compile a body once and evaluate it per element.
The element key decides which evaluation an element gets, and it joins the
cause of every state cell and durable operation the body declares.

**Today.** `listElementKeys` in `builtins/list-element-keys.ts` keys an
element by the identity of the slot's resolved target when the slot holds a
link, and by the slot's position in the list when it holds a value. Both
carry an occurrence count, so the same identity twice gets two instances. A
plain value that moves therefore gets a new instance, and every plain value
after an insertion is re-run.

**The rule.** Backward compatibility of stored per-element state is not a
requirement. The goal is that an entry that moves does not cause the map to
be recomputed.

- An element that is a plain value, stored in the list itself, is keyed by
  its value.
- An element that is not a fixed value, a link to a cell, is keyed by the
  identity of that cell.
- The index is part of the key only when the callback takes the index and
  uses it.

Which elements are plain values follows from how lists are written.
`diffAndUpdate` in `runtime/runner/src/data-updating.ts` gives a plain
object written into an array by `set`, `push`, or `addUnique` a document of
its own and stores a link (`nextAnchorId`). A list of records built by
handlers therefore holds links, and its elements are keyed by identity.
Plain-value elements are primitives, and records in an array that a
computation built, which are stored inline. A record that a computation
read and passes on unchanged is a reference
([What the plan records](#what-the-plan-records-for-calls-in-bodies),
"References"): the array holds a link to where the record was read, and
the element is keyed by the identity of that cell.

**Consequences.**

- *Equal plain values share one cone.* `["glazed", "plain", "glazed"]` has
  two cones. The body is evaluated once per distinct value, and both
  positions receive the same result. That is sound because the body is a
  function of the element, its captures, and the index only when it uses
  the index.
- *A state cell over plain values needs the index.* A state cell declared
  in the body has the cause instance, element key, and name. Rows that
  show the same plain value would therefore share it: two rows showing
  `"glazed"` would open together. That sharing is not allowed. A body over
  plain-value elements that declares a state cell without using the index
  is a compile error (`collection:shared-element-state` in
  `language-subset.md` §10.3). The author either uses the index, which
  puts it in the key, or makes the elements cells, which a list of
  records written by a handler already is. Sharing a cone for pure
  computation is unaffected.
  Whether an element is a plain value is a fact of storage that a type such
  as `Donut[]` does not state; see open question 5.
- *A handler bound over plain values is shared.* A body over plain-value
  elements that binds a handler and declares no state cell is accepted
  without the index. The stream of the binding is named by where it is
  declared, the element key included, because a binding made in the
  reactive tier copies nothing
  ([A handler binding](#a-handler-binding-made-in-a-body)). Equal elements
  therefore bind equal state and share one stream: an event from either
  of two rows that show `"glazed"` is handled with the same state. The
  compile error above, and its entry in the diagnostic catalog, cover the
  state cell only.
- *A child instantiated over plain values has the position in its key.*
  Where a body over plain-value elements instantiates a child, the
  position joins the element key, as it does when the callback uses the
  index. Two equal plain elements then have two children, and a factory
  element in `factories.map((F) => F({ ... }))` has a child per position.
  The plan records it in `Collection.bodyUses.child`
  (`plan-and-label-templates.md` §1.1 and §1.3). A statically resolved
  pattern called in the body is compiled into the body and is no child,
  so it does not put the position in the key, and a state cell it
  declares is a state cell of the body. Under nested bodies the position
  joins the key at every enclosing level whose elements are plain
  values, which that document assumes (its §8, question 37). An element
  that is a link is keyed by its cell alone, so two positions that link
  to one cell share the child. The cost is the one of using the index:
  an entry that moves is a new element for that body. *Assumed:* a state
  cell that such a body declares is accepted, because the position is in
  the key and no two positions share the cell (open question 14).
- *The same cell twice shares one cone.* The occurrence count is dropped,
  for the same reason: two positions that hold the same cell are the same
  element.
- *A link to a plain value is keyed by the link's target.* Two cells that
  hold equal values are two elements. When the value behind the link
  changes, the cone is dirtied and the key, and with it the state, stays.
- *A plain value edited in place is a new element.* Its old cone and state
  are released.
- *A hole has no key.* It has neither a value nor an identity, gets no
  cone, and stays a hole in the output, as today. An explicit `undefined`
  is a plain value and is keyed as one.
- *Using the index gives up the goal for that body.* With the index in the
  key, an entry that moves is a new element: its cone is recomputed and its
  state cells are new. Today a moved linked element whose body uses the
  index is re-run in the same instance and keeps its state.
- *A value-derived key is salted.* A key derived from a value would put
  element content into document identifiers, and an identifier is visible
  to anyone who can see a link, which for a low-entropy confidential value
  is a disclosure. A value is therefore combined with a secret of the space
  before it enters an identifier, as `sqliteQuery` does for row documents
  (`SQLITE_ROW_SALT`, `resultRowKeys`).
- *A client cannot read the salt.* A client therefore cannot derive an
  identifier that holds a value-derived key. It cannot name per-element
  state over plain values, which exists only where the position is also in
  the key, the stream of a handler bound in a body over plain values, or a
  handler binding with a copied path, before the server stores a link to
  it. Until that link arrives, what reads such state on a client is
  pending. `scheduler-and-serving-loop.md` owns what a client shows
  meanwhile.
- *Keying by value is a `value` observation by the runtime, not by the
  body.* Deciding which cone an element belongs to compares element values.
  The comparison does not flow into any element's output, since each output
  is a function of its own element.

**The other operations.**

- `filter` and `flatMap` use the same rule for their per-element cones. A
  predicate or body evaluated once per distinct key is correct for the same
  reason as in `map`, and the output keeps one entry per input position.
- The aggregates use the same rule for the per-element contribution that a
  callback computes (`count(pred)`, `minBy`, `maxBy`), and the fold counts
  multiplicity: a key that occurs three times contributes three times.
  Today the tree's leaves list each occurrence separately
  (`aggregateNode`'s leaf key).
- The collection-index family uses the same rule for key extraction, and
  keeps input order and multiplicity for the contents of a bucket: a
  `group` bucket lists an element once per occurrence, in input order,
  which the key alone does not give.
- *Ties.* `minBy`, `maxBy`, and a lookup in an index in `key` mode break a
  tie by position. Among the elements whose keys are equal (the values of
  the key function for `minBy` and `maxBy`, the index keys for a lookup),
  the winner is the one at the first position in the source order of the
  collection. The element key does not decide a tie. For an element that
  is a plain value the element key is a salted hash of the whole value,
  so a choice by element key would depend on element values that the
  label of the choice does not hold. A choice by position depends on the
  order of the collection and on the keys that tie, and on no other
  element value. Two occurrences of one element key are the same element,
  and the first of them counts. Today a tie goes to the smallest identity
  key in an aggregate (`chooseAggregateCandidate` in
  `builtins/aggregate-extremum.ts`) and to the smallest occurrence
  identity in an index (`firstMember`). The fold and the index therefore
  keep, as part of their state, the first position of each element key.
- `reduce` has no per-element cone, because the callback's result depends
  on the accumulator. Its entry says what it stores instead.
- `findIndex`, `some`, `every`, and `find` use the same rule for their
  predicate.

`plan-and-label-templates.md` §1.3 states the same rule. The plan does not
record the element part of the key, which the runtime computes from each
element. It records in `Collection.bodyUses.index` whether a body uses the
index, and in `Collection.bodyUses.child` whether it instantiates a child,
which are the two things that put the position in the key. The key joins a cause
through the `within` steps of the declaration (`WithinStep` in its §1.1): a
state cell, an operation, a child, a body, or a binding declared in an
element body has an `element` step that names the collection, and each
such step, outermost first, adds the name of its collection and the key of
the element to the cause.

### `aggregate` and `aggregateNode`

- **Source:** `builtins/aggregate.ts` (`aggregate`, `aggregateNode`),
  `builtins/aggregate-sum.ts`, `builtins/aggregate-extremum.ts`. Reached
  through the cell methods `count()`, `sum()`, `min()`, `max()`,
  `countWithPattern`, `minByWithPattern`, and `maxByWithPattern`
  (`createAggregate` in `runtime/runner/src/cell.ts`). The forms that take
  a predicate or a key function first run `mapWithPattern` and aggregate
  its output.
  `aggregateNode` has no authored entry point; `aggregate` instantiates it
  through a one-node pattern (`getNodePattern`).
- **Does:** `aggregate` builds a balanced tree of `aggregateNode` runs over
  the list's members, sorted by identity key, with leaves of at most 32
  members, and publishes a link to the root. The operations are `count`,
  `countTruthy`, `sum`, `min`, `max`, `minBy`, and `maxBy`. Four behaviors
  differ from a JavaScript reduction:
  - `count` builds no tree: the coordinator writes the number of non-hole
    slots directly.
  - `sum` keeps exact partial state as a `bigint` in units of 2^-1074 with
    separate flags for NaN and the infinities (`AggregateSum`), and rounds
    once at the root, so the result does not depend on order.
  - The empty results are `0` for `sum` and `countTruthy`, `Infinity` for
    `min`, `-Infinity` for `max`, and `undefined` for `minBy` and `maxBy`.
  - A leaf with an undefined member publishes nothing, so the aggregate
    stays pending.
- **Reads:** the coordinator reads the operation by value, the raw list
  (enumeration and slot identity), and for `minBy` and `maxBy` the slot
  identities of the source elements. It does not read member values. Its
  final write of the root link runs under `linkResolutionProbe` and
  `machineryRead`, so the coordinator depends on membership and not on which
  element wins. Each leaf reads its members' values. Each combine node reads
  two partial states.
- **Writes and state:** the coordinator's result store
  `{ aggregate: parents, outputSpot }`, declared as `storeWrites`, and one
  document per tree node with cause `{ aggregateNode: result, key }`. The key
  encodes the node's membership, so a membership change mints new node
  documents instead of updating old ones. The fold state lives in the node
  outputs (`AggregateState`). `minBy` and `maxBy` publish a link to the
  winning source element. Superseded nodes are released and their documents
  are not deleted.
- **CFC:** precision by decomposition: each leaf is its own run over at most
  32 values and each combine reads two partial states. The label of the
  result is the join through the tree, which equals the join over all
  members. No integrity is minted.
- **Execution:** pure structural in effect, although neither server-execution
  document places it. Both are computations and replayable. On resume the
  `aggregate` action is asynchronous: it awaits synchronization and opens
  read transactions that it aborts.
- **New design:** class A, with durable fold state. The overview already
  says that the fold state of aggregates over collections is always stored.
  `aggregateNode` is an implementation detail of that fold and has no
  counterpart in the language.
- **Label rule:**
  - `count()`: the enumeration of the input only. No member value flows.
  - `count(predicate)`: the membership of the input and the truthiness of the
    predicate for every element.
  - `sum()`, `min()`, `max()`: the membership of the input and the value of
    every member.
  - `minBy(keyFunction)`, `maxBy(keyFunction)`: the membership of the
    input and the key function's value for every element decide *which*
    element is referenced. The output is that element (identity), so its
    content slots are the winning element's own.
  - State to store: the fold. `plan-and-label-templates.md` §3.8 keeps the
    shape of that state private to the runtime and fixes the exact-sum
    semantics. A tie in `minBy` or `maxBy` goes to the first position in
    the source order ([Element keys](#element-keys), "The other
    operations"), on the client as on the server. Which element wins
    therefore depends on the order of the input as well.

### `collectionIndex`, `collectionIndexMember`, `collectionIndexKeys`

- **Source:** `builtins/collection-index.ts`,
  `builtins/collection-index-member.ts`, `builtins/collection-index-keys.ts`,
  `builtins/collection-index-key.ts`, and
  `builtins/collection-index-membership.ts`. Reached through
  `groupByWithPattern` and `keyByWithPattern` in `runtime/runner/src/cell.ts`,
  which run `mapWithPattern` to extract keys and pass the keys and the source
  list to `collectionIndex`. The read side is the plain cell methods
  `lookup(key)`, `keys()`, and `keyEntries()`, which are not built-ins. The
  member and keys built-ins have no authored entry point. See
  [collection indexes](../../features/collection-indexes.md).
- **Does:** maintains a public index descriptor with one bucket per key, and
  a private membership document. In `group` mode a bucket is an array of
  links to the source elements in occurrence order. In `key` mode a bucket is
  a link to one element, and when several elements share a key the winner is
  the one with the smallest occurrence identity, not the last written. A
  nullish key omits the element. Keys may be primitives or cells; a cell key
  is compared by resolved identity (`resolveCollectionKey`).
- **Reads:** the coordinator reads slot identities of the keys and the
  source list, and enumerates the assignment ids under `machineryRead`. Each
  member reads its own extracted key by value, or by identity when the key is
  a cell, and the source element by identity. All maintenance reads of the
  shared documents run under `ignoreReadForScheduling` and `machineryRead`,
  so they take part in conflict detection without subscribing the member to
  other members' writes. `collectionIndexKeys` reads the `occupied` map by
  value.
- **Writes and state:** two owned stores, the descriptor
  `{ collectionIndex: parents, outputSpot, mode }` and the membership state
  `{ collectionIndexState: index }`. Neither is declared as `storeWrites`.
  Every member writes into both shared documents. `collectionIndexMember`
  declares materializer envelopes for `index.buckets` and `state.occupied`
  and also writes `assignments`, `members`, `winners`, and `orders` in the
  state document, which lie outside the declared envelopes.
- **CFC:** key extraction per element is a separate map child. A member's
  transaction reads its own key and writes one bucket. Reads of other
  members' records are machinery reads. No integrity is minted.
- **Execution:** not placed by either server-execution document; pure
  structural in effect. `collectionIndex` and `collectionIndexKeys` are
  computations, the latter with `deferUntilDemand`. `collectionIndexMember`
  is a materializer: standing demand at idle priority, promoted when a
  reader touches a bucket. All three are listed as replayable.
- **New design:** class A, with durable index state. `groupBy` and `keyBy`
  are reactive constructs, and `lookup`, `keys`, and `keyEntries` are
  reactive reads of their result. The member and keys built-ins are
  implementation details with no counterpart. The index is the second kind
  of fold state the overview says is always stored. The materializer goes
  away: per-element cones write a statically known target, which is the
  case the overview describes as turning a materializer into a computation
  with static targets.
- **Label rule:**
  - The membership of bucket `k` depends on the membership of the input and
    on the key of *every* element: its value for a primitive key and its
    identity for a cell key.
  - The elements of a bucket are the input elements themselves (identity).
  - `lookup(key)` depends on the value of `key`, or its identity for a cell
    key, and on the membership of that one bucket. A lookup that misses
    depends on the same two things.
  - `keys()` and `keyEntries()` depend on the enumeration of the occupied
    keys, which depends on the key of every element.
  - In `key` mode the winner among elements with equal index keys is the
    one at the first position in the source order
    ([Element keys](#element-keys), "The other operations"). The choice
    depends on the order of the input and on the index keys. No other
    element value flows into it, for plain-value elements as for elements
    keyed by the identity of their cells.
  - State to store: the index and the membership bookkeeping.

### `reduce`

- **Source:** `reduce` on `CellImpl` in `runtime/runner/src/cell.ts`. It is
  a cell method and not a registered built-in.
- **Does:** mints a `lift` at the call and applies it to the cell. The lift
  runs `Array.prototype.reduce` with the author's callback and the initial
  value over the whole list, and returns the initial value when the input is
  not an array. Holes are skipped, as the array method skips them.
- **Reads:** the whole list by value, as one argument of the lift.
- **Writes and state:** the lift's output. No fold state: every change to
  the list recomputes the fold from the start.
- **CFC:** one label for the result, the join of everything the lift read,
  which is the whole list.
- **Execution:** a `javascript` node, so a computation. Because the lift is
  minted where the method is called, it throws inside a running action
  (`assertNotInActionExecution`), and it has no content-addressed identity.
  In the corpus the method form is not used on a reactive receiver in a
  pattern body. Authors write `reduce` on a plain array inside a function
  body: 8 times in a `computed`, once in a `lift`, and 20 times in helper
  functions.
- **New design:** class A. `reduce` is a reactive construct, and its
  callback is restricted to an expression over the accumulator, the element,
  and optionally the index.
- **Label rule:**
  - The result depends on the initial value, on the captures the callback
    reads, on the membership *and order* of the input, and on every element
    at the paths the callback's footprint names. `plan-and-label-templates.md`
    §3.13 gives the rule: a `fold`, which its §3.2 defines.
  - An arbitrary expression is not associative, so the balanced tree of
    `aggregate` does not apply: a tree combines partial results of disjoint
    halves, and here the contribution of an element depends on the
    accumulator that reached it. The value of a `reduce` is therefore
    recomputed in input order.
  - Two kinds of durable state remain possible. The *label* of the fold is
    a join, which is associative and commutative, so the multiset of element
    labels can be maintained incrementally exactly as for an aggregate. The
    *value* can be checkpointed as the accumulator after each prefix, so a
    change at position `k` recomputes from `k`; that costs one stored
    accumulator per checkpoint, each labeled with the join of its prefix.
    The baseline durable state is the result and the multiset of step label
    identifiers, with no value checkpoints (`plan-and-label-templates.md`
    §3.13): the value is recomputed in input order when anything it read
    changed.
  - A moved entry changes the result in general, so the goal of the element
    key rule does not apply to `reduce`.
- **Plan record:** an `Operation` of kind `reduce` whose implementation
  is the cone of the step expression, with a `Collection` of its own for
  the receiver. The step cone is handed the accumulator through a slot
  that names the operation, and the initial value is stored with the
  operation's state. `plan-and-label-templates.md` §3.13 has the record,
  as an assumption (its question 49).

### `findIndex`

- **Source:** `findIndex` on `CellImpl` in `runtime/runner/src/cell.ts`.
- **Does:** mints a `lift` that runs `Array.prototype.findIndex` with the
  author's predicate over the whole list. It throws a `TypeError` when the
  input is not an array. The implementation's comment states the tradeoff:
  it reruns the full search on any change to the array.
- **Reads:** the whole list by value.
- **Writes and state:** the lift's output, a number. No state.
- **CFC:** one label, the join of the whole list.
- **Execution:** as `reduce`. In the corpus, `findIndex` with a callback
  appears 8 times in a `computed`, 50 times in handlers, and 12 times in
  actions, always on a plain array.
- **New design:** class A. `findIndex` is a reactive construct with a
  predicate callback in the form `map` and `filter` take.
- **Label rule:**
  - The answer depends on the membership and order of the input and on the
    predicate's result for every element up to and including the first
    match. When nothing matches, it depends on the predicate's result for
    every element.
  - Which elements those are is data, so the rule is value-dependent in the
    way a conditional is: the label joins the predicate results of the
    prefix that ends at the first match, and the elements after it do not
    join. `plan-and-label-templates.md` §3.13 defines it. The lift reads the
    whole list today, so the rule is tighter.
  - The predicate's per-element results use the element key rule, so a
    moved entry re-evaluates no predicate. The answer itself is a position
    and changes when entries before the match move.
- **Plan record:** the record of a scan, which `findIndex`, `some`,
  `every`, and `find` share (`plan-and-label-templates.md` §3.13). It is a
  `Collection` of its own, named as the method is, whose source is the
  receiver; the cones of the predicate, evaluated per element key; a
  `Selector` of arity 0 that holds the position the runtime's scan
  found; and an `Output` for the result, which the runtime produces and
  no value function returns. `find` has in addition a `Pick` that the
  runtime decides. No operation and no durable state is involved.

### `some` and `every`

- **Source:** none in the runtime. They are array methods that authors call
  on plain arrays inside function bodies, so today each is part of a
  `computed`, `lift`, or handler body and has that body's label.
- **Does:** `some(pred)` is true when the predicate is truthy for at least
  one element, and `every(pred)` when it is truthy for all. Both stop at
  the first element that decides the result. On an empty list `some` is
  false and `every` is true. Holes are skipped.
- **Corpus:** with a callback, in source files, `some` appears 31 times in
  a `computed` (18 files) and twice directly in a pattern body; `every`
  appears twice in a `computed`. In handlers and actions `some` appears 63
  times, where it stays an ordinary method.
- **Execution:** as part of the enclosing body: a computation.
- **New design:** class A. Both are reactive constructs with a predicate
  callback in the form `filter` takes.
- **Label rule:** the result depends on the membership of the input and on
  the predicate's truthiness for the prefix that ends at the first deciding
  element: the first truthy one for `some`, the first falsy one for
  `every`. When no element decides, it depends on the predicate for every
  element. Elements after the deciding one do not join. Order affects only
  which prefix that is, not the result. The predicate's per-element results
  use the element key rule. No durable state is needed.
- **Plan record:** the record of a scan ([`findIndex`](#findindex)).

### `find`

- **Source:** none in the runtime, as for `some`.
- **Does:** returns the first element for which the predicate is truthy, or
  `undefined`.
- **Corpus:** with a callback, in source files, 17 times in a `computed`
  (12 files), and 26 times in handlers and actions.
- **Execution:** as part of the enclosing body.
- **New design:** class A, a reactive construct.
- **Label rule:**
  - The result is the matching element *itself*, passed through as a
    reference: its content keeps the element's own label, and every class
    of its integrity survives. This is what `filter` gives each of its
    elements, and what a `computed` cannot give, since a `computed` that
    returns the found element joins everything its body read into the
    result.
  - The *choice* of element depends on the membership and order of the
    input and on the predicate's result for the prefix that ends at the
    match, or for every element when the result is `undefined`.
  - `findLast` and `findLastIndex` stay in the function tier: no pattern
    module uses them. The Topics command-line tools, which are not patterns,
    use them three times.
- **Plan record:** the record of a scan ([`findIndex`](#findindex)), with
  a `Pick` whose choice the runtime makes.

### `anchorsOf`

- **Source:** `builtins/anchors-of.ts`, with `anchorsDocumentLink` in
  `runtime/runner/src/field-anchors.ts`. Authored as `anchorsOf(field)`.
- **Does:** returns a write-redirect link to the anchors document of a
  collaborative string field. The document's identifier is derived from the
  field's stored address. The built-in neither creates nor writes that
  document.
- **Reads:** identity only: it resolves where the field is stored and reads
  nothing of what the field holds. While a hop on the link chain is still
  loading it throws `UnresolvedInputError`, and it throws for an input that
  is stored in no document.
- **Writes and state:** the primary output only. No store.
- **CFC:** nothing specific. What a reader of the anchors learns is decided
  by the anchors document's own label.
- **Execution:** not placed by the server-execution documents; pure
  structural. Computation; replayable.
- **New design:** class A. It is an address computation: a reactive
  expression whose result is an alias to a document derived from its
  operand's identity.
- **Label rule:** the output is a reference whose only slot is the identity
  of the operand. Reads and writes through it use the anchors document's own
  label. It gives a function body a writable cell on a document the pattern
  did not declare, so the plan lists that document among the instance's
  static write targets, as a `WriteEdge` with the target `anchors`
  (`plan-and-label-templates.md` §1.1 and §3.19).

### `inspectConfLabel`

- **Source:** `builtins/inspect-conf-label.ts`, with `inspectStoredConfLabel`
  in `cfc/label-introspection.ts`. Authored as
  `inspectConfLabel(target, targetPath, query)`.
- **Does:** returns the confidentiality atoms stored for a target at a path,
  filtered by a query, or the constant `notAvailable`.
- **Reads:** `path` and `query` by value. The target arrives as a cell and
  is never read by value: only its link chain is resolved and its stored
  label metadata consulted through the verifier seam. Each consulted
  metadata path is then recorded explicitly with
  `tx.recordCfcLabelMetadataObservation`, with `observes: "labelMetadata"`.
- **Writes and state:** one owned store with cause
  `{ inspectConfLabel: cause }`, keyed on the whole cause including the
  inputs document, at the scope of the resolved target.
- **CFC:** this is the one built-in the CFC kernel names
  (`cfc/kernel/manifest.ts`). It fails closed: a result that consumed
  protected metadata is returned only when flow labels are persisted and
  enforcement is on, and otherwise the result is `notAvailable`.
- **Execution:** classed pure structural by the server-execution documents.
  Computation. It is the only non-effectful built-in listed as
  non-replayable, because stored label metadata changes independently of the
  node's inputs.
- **New design:** class A, as a kernel operation. It is not effectful: it
  has no request and no transactions of its own. It is also not an ordinary
  expression, because its input is a label and not a value.
- **Label rule:** the output depends on the values of `path` and `query` and
  on the *label metadata* of the target at that path.
  - What the read observes: the stored confidentiality clauses of the
    target's label at the payload path, as stored-form atoms, filtered by
    the query. It observes nothing of the target's value. Each consulted
    metadata path is recorded as an observation with class `labelMetadata`
    and a confidentiality of its own, the label of the label
    (`tx.recordCfcLabelMetadataObservation` in `inspectStoredConfLabel`),
    and those observations join the flow of the transaction that wrote the
    result. Metadata classified as public contributes nothing.
  - `plan-and-label-templates.md` §2.4 gives this read a fifth observation
    class, `labelMetadata`: a slot that does not read the value at its
    path and whose label is the label of the metadata observation. Which
    metadata paths are consulted depends on the query and on the stored
    clauses, so the slot stands for the label metadata at the payload path
    as a whole.
  - A target that is not kept has no stored label: the plan document says
    an interim value is never labeled. The operation therefore takes a
    target with an address: a state cell, an argument, a kept output, or
    whatever a link leads to. *Assumed:* for an interim value of the same
    instance the result is `notAvailable`, which is what the implementation
    returns today for missing metadata, and the compiler reports the case
    when it can see it statically. Inspecting a value does not make it
    kept. `plan-and-label-templates.md` §3.16 has the other reading: for a
    value the instance computes, kept or interim, the operation reads the
    label the value's template instantiates to in the current transaction.
    The choice is with the project owner (open question 1).

## Effectful built-ins

Each entry of this section has a **Request operands** paragraph. It says
how the implementation reads each operand of a request. An operand is read
*by value*, and the entry says how deep, or it is a *reference*: its content
is not read, and what is stored or leaves is a link. The compiled design
uses these facts in two places.

- **The request is a set of write edges.** A request is written into the
  effect's state, one `WriteEdge` with the target `request` per path
  (`plan-and-label-templates.md` §1.1 and §3.14). A path that holds a
  container or a cell the requester passes on unchanged holds a reference,
  by the rule for a value passed on unchanged (`footprint-analysis.md`
  §3.8). The template of such a path has the label of the pointer and not
  the label of the content.
- **The egress ceiling covers the content followed.** The transaction that
  checks the ceiling follows the references the request holds as far as the
  built-in serializes them, and checks the ceiling on the request's
  templates joined with what those reads consume
  (`plan-and-label-templates.md` §3.14). An operand that an entry declares
  a reference is not followed: it leaves as a link, and its content is not
  serialized. An operand that an entry says is serialized or read in full
  is followed through every link below it. A depth in between is stated in
  the entry. Where the declared rule of a boundary takes the label of the
  request, it takes this joined label.
- **What is hashed is followed too.** Some operands enter the request hash
  and are not sent, such as `reactOn` of `sqliteQuery`. The stored hash is
  a function of their content. The transaction that checks the ceiling
  follows such an operand as it follows one that is sent, as far as the
  hash reads it, so that the label of the stored hash covers what the hash
  was computed from (`plan-and-label-templates.md` §3.14, "What is hashed
  is followed too").

These paragraphs state what is read when the request is made. The
`streamData` and `llm` entries have no such paragraph, because both are
removed.

**What a language-model built-in sends after its request.** A
language-model built-in sends content that no request held: the result of
a tool call, sent back to the model by the next model call of the tool
loop; a system prompt rendered again from the live context; and, for a
dialog, the live transcript on each model call. The check at the request
alone is therefore not sufficient. The egress ceiling is checked again on
each send, on the content of that send as it is then, with references
followed as the **Request operands** paragraph of the entry says
(`plan-and-label-templates.md` §3.14, "Each later send is checked"). The
boundary makes the reads of a send in a transaction of its own, the send
transaction, which checks the ceiling before the send is made. A send
that fails the check is not made:

- the failure rejects the send transaction and no other;
- the effect makes no further send for that request;
- the built-in's result takes the error state;
- what the effect stored before the refused send stays stored;
- the event whose handler requested the effect, where a handler did, has
  committed and is not rejected.

The entries [`generateText`](#llm-generatetext),
[`generateObject`](#generateobject), and [`llmDialog`](#llmdialog) each
have a **Sends** paragraph that lists the sends of the built-in and says
what its result is on a refused send. The checks are not part of a
template, because what a tool returns depends on data.

**A pattern closure given to a language model as a tool.** A model's call
of a tool that is a pattern closure instantiates the pattern. The
argument the model supplies carries the label of the model's output: the
label of the generation that produced the tool call. The captures of the
closure are private parameters, bound where the closure is written, and
the model does not supply them (`language-subset.md` §4.4.2). The result
of the call carries the label of the instance's own result, by the
ordinary rules for the outputs of an instance. What the built-in sends
back to the model of that result is a send, checked as the paragraph
above says. `plan-and-label-templates.md` §3.15 ("A pattern closure given
to a language model as a tool") states the rule, and each of the three
entries says under **Tools** what the label of a generation is for that
built-in. A handler given as a tool, and the tools a dialog has built
in, are not covered by this rule.

**The instance of a tool call.** The plan has no `Child` and no
`instantiate` site for it: whether it is made, and how often, follows
from the model's output. Today the instance runs into a result cell in
the space of the built-in whose cause is the tool-call identifier the
model supplied, and it is left running (`handleInvoke` in
`builtins/llm-dialog.ts`). In the compiled design:

- **Which transaction.** The boundary's transaction that handles the tool
  call creates the instance and writes the argument the model supplied
  into the instance's argument document, each path under the label of the
  generation that produced the call. No body's template joins it.
- **Identity.** *Assumed:* the identifier derives from the identity of the
  built-in's operation, the request (the request hash of a one-shot
  built-in, the turn of a dialog), the ordinal of the model call within
  that request, and the position of the tool call in that generation. It
  does not hold the identifier the model supplied, so two executions name
  the same instance and the model chooses no document identifier.
- **Space and scope.** *Assumed:* the instance is made in the space of
  the built-in's operation and at the scope of the built-in's result, as
  the result cell is today. An `asScope` on the closure sets the scope of
  the state the instance declares, as for any child.
- **Teardown.** *Assumed:* the instance is torn down when the request
  that made it settles: when a one-shot built-in has its result or its
  error, and when the turn of a dialog ends, a refused send included.
  What the instance wrote into cells it was given stays. Today it is not
  torn down.

The three assumptions are open question 6.

The staged changes are effect requests too, and their operands are under
[Staged changes](#staged-changes).

**When an effect is demanded, and its time gates.** The demand rule is for
an operation of a plan: an effect written in the reactive tier, or in the
body of a pattern that a handler or a computation instantiates. Such an
operation is demanded when something demands a path of its result, and
its request transaction runs when the request of a demanded operation is
stale. A `navigateTo` written in the reactive tier has no result that a
pattern reads, and is demanded whenever its instance is. A request that a
handler makes waits for no demand: every request a handler makes is sent
when its event's transaction commits, a `fetchJson` or a `generateText` as
much as a `navigateTo`, and it is made once
(`scheduler-and-serving-loop.md` §6.2). A request of a handler that is
still pending when the serving runtime restarts is made again at
activation: the references of the stored request are followed again, and
the egress ceiling is checked on the content as it is then (its §10.6;
`plan-and-label-templates.md` §3.14, "Which transaction"). It is made in
a request transaction of its own. Such a request can therefore be refused
at activation although it passed when the event committed: the failure
rejects that transaction alone, the result takes the error state, and
the event's other writes stay stored. The
staged changes are requests of
a handler and differ from the others in what the commit does with them.
A staged access change is a step of the commit of the event's
transaction. `nameBlob` stages a document in the event's transaction: it
has no request transaction and no completion, it is not a unit of the
scheduler, and its document commits with the handler's other writes
([Staged changes](#staged-changes)). The time gates are the
ones the entries state, and they stay as they are: the claim of the fetch
family goes stale after five seconds or `options.mutexTimeoutMs`
(`MUTEX_STALE_AFTER` in `builtins/fetch-utils.ts`), and the turn claim of
`llmDialog` after five minutes (`REQUEST_TIMEOUT` in
`builtins/llm-dialog.ts`). No other entry declares one. *Assumed:* the
50 ms debounce of `wish` (`WISH_DEBOUNCE_MS` in `builtins/index.ts`) has no
counterpart. `wish` is structural, its parts are evaluated on demand like
any cone, and no action remains for a debounce to apply to.

**The requester of a request.** A request that a handler makes is part of
the event's transaction, which has the actor of the event. The request
transaction of an operation of a plan acts as the principal of the scope
key of the cone instance that staged the request
(`scheduler-and-serving-loop.md` §6.2). A cone instance of space scope has
no such principal. The table says, for each effectful built-in, whether it
needs a requester and what it does without one. The column "Today" is the
behavior of a run on a serving runtime that carries no principal, by
source. *Assumed:* the compiled design keeps each row's behavior, and
where a row has none the request is refused, as
`scheduler-and-serving-loop.md` §9.3 refuses an `inSpace` instantiation
by a computation of space scope. A refused request has the outcome that a
failed egress ceiling has for an operation of a plan: the request is not
made, and the operation's result takes the refusal as an error state.
The question is with the project owner (the continuation plan, question
45, which this extends).

| Built-in | Needs a requester for | Today, with no principal | Compiled design, at space scope |
| --- | --- | --- | --- |
| The fetch family, `fetchProgram` | Nothing. A request to a protected first-party route is signed with the runtime's identity, not a user's | The request is made. The identity of the run is used only to address the result stores at the scope the input read touched (`fetchBuiltin` in `builtins/fetch.ts`, `fetchProgram` in `builtins/fetch-program.ts`) | The request is made, with no principal |
| `generateText`, `generateObject` | Nothing in the request. In enforcing modes the integrity gate of a tool call resolves a floor that names a concept against the runtime's ambient acting principal, which is not the principal of the run (`executeToolCalls` in `builtins/llm-dialog.ts`) | The request is made (`generateText` and `generateObject` in `builtins/llm.ts` use the run's identity only to address the result store) | The request is made, with no principal. *Assumed:* a tool call's gate resolves such a floor for no principal |
| `llmDialog` | The actor of the `addMessage` event, which every turn has, because a turn starts from an event | Not reached: no turn starts without an event | Not reached, for the same reason |
| `agent` | The requester's home space, whose queue lists the run, and the record, which is stored at user scope | Resolving the requester narrows the run's read scope to the user (`Runtime.homeSpacePrincipalFor` in `runtime/runner/src/runtime.ts`), so the node is evaluated per demanding principal. A run that still has no principal settles with an error and stages nothing (`agent` in `builtins/agent.ts`: "the agent request has no requesting identity whose home space could index its run") | The operation has user scope whatever the scope of the cone instance that computes its request: its unit exists per principal that demands its result, and its request transaction acts as that principal. With no demanding principal it is not requested |
| `sqliteQuery`, same space, no `readClearance` | Nothing | The request is made | The request is made, with no principal |
| `sqliteQuery`, a database in another space, or with `readClearance` | The reader: the other space admits the read for the reader, and a clearance read filters rows for the reader | The result is forced to user scope or narrower (`narrowestScope` in `sqliteQuery`, `builtins/sqlite-builtins.ts`). A served run on a database in another space with no principal throws ("cross-space served queries require a complete scoped reader identity"), and a clearance read with no reader fails the query (`computeRowLabelRead` in `builtins/sqlite/row-label-read.ts`) | The operation has user scope, or session scope where the result is declared so, as for `agent`. With no demanding principal it is refused |
| `navigateTo` | The session that fired the event: the intent is appended to that session's effects document, and the result is a session-scoped cell | A served run with no event context, or with an event that no client session fired, throws (`servedNavigate` in `builtins/navigate-to.ts`) | The operation has session scope. A request that is not a consequence of an event a client fired is refused, which is the boundary's declared rule ([`navigateTo`](#navigateto)) |
| `compileAndRun`, compilation | Nothing | The request is made; the run's identity addresses the result stores (`compileAndRun` in `builtins/compile-and-run.ts`) | The request is made, with no principal. The instantiation half follows the rule for an instantiation |
| `cellFromUrl`, resolution | Nothing | The resolution is made (`builtins/cell-from-url.ts` reads no principal) | The request is made, with no principal |
| The staged changes | The actor of the event | Not reached: each is legal in a handler only | Not reached |

Two entries that are not effect requests read a principal as well.
`sqliteDatabase` writes the `owner` of its handle once, from the acting
principal of the transaction that first writes the handle, and a
transaction with no principal writes a handle with no owner, which stays
without one ([`sqliteDatabase`](#sqlitedatabase)). The home-space targets
of `wish` resolve against the demanding principal and make the output
user-scoped, and a run with no principal resolves none of them
(`homeSpaceUserDID` in `builtins/wish.ts`).

**The refused globals.** `language-subset.md` §9.11 refuses `Promise`,
`fetch`, timers, and `structuredClone` among others. This inventory has a
counterpart for two of the four. `fetch` is replaced by the fetch family,
which is class B. A timer is replaced by the clock of
[`wish`](#wish), which is class A: a reference to a clock cell that the
runtime writes. `Promise` has no counterpart: a function body is
synchronous, and the result of an effect is read as the fields `pending`,
`result`, and `error` of the boundary's result. `structuredClone` has no
counterpart in this inventory.

### `fetchBinary`, `fetchText`, `fetchJson`, `fetchJsonUnchecked`

- **Source:** `builtins/fetch.ts` (`fetchBuiltin`, `startFetch`) and
  `builtins/fetch-utils.ts` (`tryClaimMutex`, `tryWriteResult`). Authored
  under the same four names. No `fetchData` export exists, although the
  server-execution documents use that name for the family.
- **Does:** performs one HTTP request and publishes
  `{ pending, result, error }`. `fetchJson` validates the response against
  the schema the compiler injects from its type argument, and a failure
  becomes the error. `fetchJsonUnchecked` does not validate. Requests to
  protected first-party routes are signed with the runtime's identity.
- **Reads:** the inputs by value (`url`, `options`, and for `fetchJson` the
  schema). The action also reads its own four stores.
- **Writes and state:** four owned stores with causes
  `{ <name>: { pending | result | error | internal: cause } }`, keyed on the
  whole cause, at the narrowest scope the input read touched. The internal
  store holds `{ requestId, lastActivity, inputHash }`. The input hash is
  the memo: a stored hash equal to the current one with a result or error
  present means nothing is sent. The claim (`pending` and `requestId`) is
  written by the first post-commit transaction and goes stale after five
  seconds or `options.mutexTimeoutMs`. The write surface is static.
- **CFC:** sink names equal the built-in names, in sink class `network`. The
  egress check is the transaction-wide ceiling check described above. No
  integrity is minted and nothing records where the response came from. The
  result's label is the flow join of the completion transaction, which
  re-reads the inputs, so a response carries the label of its request and
  nothing else. The whole result is one document with one label.
- **Execution:** effectful: server only, never speculated; a speculating
  client reads through to the last committed result. Computation; not
  replayable.
- **Request operands:** no operand is a reference. The action reads the
  inputs under the input schema of the built-in and builds the request from
  them (`snapshotInputsFor` in `builtins/fetch.ts`).
  - `url` is a string.
  - Of `options` the schema names `method`, `cache`, and `redirect`, which
    are strings, `headers`, a record of strings, `body`, and
    `mutexTimeoutMs` (`fetchOptionsSchemaProperties`). A member the schema
    does not name is dropped, and `mutexTimeoutMs` is removed before the
    request is built.
  - `body` has the open schema `{}` and is serialized in full: a body that
    is not a string is passed to `JSON.stringify`, which reads every path
    below it, through every link.
  - For `fetchJson`, `schema` is an open object or a boolean and is read
    in full. It is part of the request and of its hash. It is applied to
    the response and is not sent.

  The request that leaves is the one the action built (`startFetch`),
  with two additions the runtime makes: a relative `url` is resolved
  against the host of the space the inputs live in, and a request to a
  protected first-party route gets signed headers. So the egress check
  follows `body` and `schema` in full and each value of `headers`, and
  nothing else.
- **New design:** class B.
- **Label rule:** the request slots are the values of `url`, `options`, and
  the schema. The egress check applies the join of exactly those slots,
  and of what following the references in `body` consumes, to the sink's
  ceiling, which is tighter than the transaction-wide check. The result's
  confidentiality is that join; a declared schema may add constants.
  Integrity is whatever the boundary declares for the network origin,
  which today is nothing. `pending` and `error` carry the request label
  too, since both reveal that the request was made. State to store: the
  request hash, the claim, and the settled result or error.

### `fetchProgram`

- **Source:** `builtins/fetch-program.ts`.
- **Does:** fetches a program's main file and its dependency closure over
  HTTP, without compiling or running it, and publishes
  `{ pending, result: { files, main }, error }`.
- **Reads:** `url` by value, and its own cache store.
- **Writes and state:** four owned stores
  `{ fetchProgram: { pending | result | error | cache: cause } }`. The cache
  keeps one entry per input hash, so returning to an earlier URL uses its
  stored result. The action itself writes the `fetching` claim and projects
  the outputs from the cache; the completion writes only the cache.
- **CFC:** sink `fetchProgram`, class `network`. The output's label is set by
  the action transaction that projects the cache entry, which read the
  inputs and the cache. No integrity.
- **Execution:** effectful: server only. Computation; not replayable.
- **Request operands:** `url` is the only operand, a string
  (`fetchProgramInputSchema` and `snapshotFetchProgramInputs` in
  `builtins/fetch-program.ts`). Nothing is a reference and nothing is
  followed. The addresses of the dependencies come from the responses and
  not from the request.
- **New design:** class B, the same boundary as the fetch family with a
  multi-entry memo.
- **Label rule:** as the fetch family, with `url` as the only request slot.
  State to store: the cache keyed by request hash.

### `streamData`

- **Source:** `builtins/stream-data.ts`, which describes itself as a hack
  for demonstrations.
- **Does:** reads a server-sent event stream and writes each complete event
  to `result`, the last event replacing the one before.
- **Reads:** `url` and `options` by value.
- **Writes and state:** three owned stores
  `{ streamData: { pending | result | error: cause } }`. There is no request
  hash and no durable memo. Each event is its own transaction. `pending` is
  not cleared when the stream ends normally, and stopping the piece does not
  abort the stream.
- **CFC:** sink `streamData`, class `network`. The transaction that writes
  an event reads nothing, so a stored event carries no label from the
  request.
- **Execution:** disabled: the action throws when server execution is
  enabled ([built-in contracts](../server-side-execution/builtins.md), §5).
  Computation; not replayable.
- **New design:** class D, removed. Its partial commits contradict the rule
  that effect results are settled values, its events are stored unlabeled,
  and it is unused. The replacement for request and response is the fetch
  family. A streaming boundary, if one is wanted, is a new class B design
  with a declared rule for partial results.

### `llm`, `generateText`

- **Source:** `builtins/llm.ts` (`llm`, `generateText`) and
  `builtins/llm-schemas.ts`. `llm` is marked deprecated in `base/api/index.ts`
  in favor of the other two.
- **Does:** sends one request to a language model, optionally running a tool
  loop, and publishes
  `{ pending, result, error, partial, requestHash }`.
- **Reads:** the parameters by value. For each entry of `context` it reads
  the cell's identity, schema, and value; when an observation ceiling is
  declared the value read is marked `ignoreReadForScheduling` and
  `internalVerifierRead` (`readCellValueForObservation` in
  `builtins/llm-dialog.ts`) and the cell's label is read. It enumerates the
  tools. After commit it reads further cells outside any scheduler tracking.
- **Writes and state:** one owned store `{ <name>: { result: cause } }` at
  the narrowest read scope. The request hash is the memo. Partial text is
  written in separate unstamped transactions batched at one second, and not
  at all on a serving runtime. The tool-loop conversation is kept in memory
  only. Tool calls can write anywhere; see `llmDialog`.
- **CFC:** sinks `llm` and `generateText`, class `network`. The strictest
  runtime preset declares both as ungated (`ungatedSink` in
  `runtime/runner/src/runtime-presets.ts`), so no confidentiality ceiling
  applies to a prompt; [LLM sink admission](../../plans/cfc-llm-sink-admission.md)
  tracks the replacement. The settled result and partial are stamped with
  the integrity atom `LlmDerived` (`cfc/llm-derived-stamp.ts`), which the
  persist-time gate admits only from a built-in implementation identity. No
  prompt-influence caveat is minted on results.
- **Execution:** effectful: server only, never speculated. Computation; not
  replayable.
- **Request operands,** for `generateText`: the action reads the
  parameters under `GenerateTextParamsSchema` in `builtins/llm-schemas.ts`.
  - `system`, `model`, `maxTokens`, and the other scalar parameters are
    read by value. `prompt` and `messages` are read by value to the depth
    that `LLMContentSchema` and `LLMMessageSchema` name: the role, the
    content, and the named fields of each content part.
  - An entry of `context` is held as a cell (`LLMContextEntrySchema` marks
    it `asCell`), and it is not a reference in the sense of this section:
    its content is serialized into the system prompt
    (`buildAvailableCellsDocumentationWithObservation` in
    `builtins/llm-dialog.ts`). The serializer, `serializeForLLMObservation`,
    walks the entry's value to any depth, up to a bound of 100 levels. A
    position that holds a cell handle, and a link at a position the
    entry's schema leaves open, are rendered as links and are not
    followed. A link at any other position is followed, and what it leads
    to is content. The rendered text of one entry is cut at 2,000
    characters, which bounds what is sent and not what is read. With an
    observation ceiling declared, a node whose label exceeds the ceiling
    is rendered as a link or redacted.
  - Of each tool the catalog holds the `description` and the
    `inputSchema`, read in full (`buildToolCatalog`, under
    `LLMToolSchema`). For a pattern tool the stored pattern is read for
    its argument schema. The `handler`, `pattern`, and `piece` of a tool
    are references. `extraParams` are not part of the request: they are
    read when the model calls the tool (`handleInvoke`).

  The recorded request is the scalar parameters, the system prompt with
  the rendered context, the messages, and the tool catalog, which holds
  the six built-in tools unless they are switched off. What leaves after
  the first model call is in no recorded request: the result of each tool
  call, and whatever a `read` or an `invoke` call serializes of a cell the
  model names by link (`handleRead`, `handleInvoke`). So the egress check
  follows each entry of `context` as the serializer does, through links to
  any depth and stopping at cell handles, and follows the description and
  the input schema of each tool in full. It follows nothing else.
- **New design:** class B. `llm` is class D, replaced by `generateText` and
  `generateObject`, which its deprecation already says.
- **Tools:** a tool that is a pattern closure is instantiated when the
  model calls it ([Effectful built-ins](#effectful-built-ins), "A pattern
  closure given to a language model as a tool"). The label of a
  generation is the join of the request slots and of everything sent back
  to the model before that generation. The argument the model supplies
  carries the label of the generation that produced the tool call. The
  result of the call carries the label of the instance's own result. What
  is sent back to the model of that result joins the label of every later
  generation, and so the label of the settled result.
- **Sends:** two kinds.
  - The request: the first model call, which sends the recorded request.
  - Each later model call of a tool loop. It sends the messages of the
    request, the model's output so far, and the result of every tool call
    so far, with what a `read` or an `invoke` call serialized
    (`executeWithToolsLoop` in `builtins/llm.ts`). The system prompt and
    the tool catalog are those of the request and are not rendered again.

  The egress ceiling is checked on the request, and again on each later
  model call, on the content of that call, in a send transaction. The
  content of each later send is what its send transaction read: the
  built-in does not read a tool result or a cell again between the
  check and the send (`scheduler-and-serving-loop.md` §6.3). A call
  that fails the check is not made, and no further call is made for the
  request. The result is the one result of the request,
  `{ pending, result, error, partial, requestHash }`: `pending` becomes
  false, `error` holds the refusal, and `result` stays unset. The request
  hash stays stored, so the refused request is not made again until the
  request changes. What the tool calls before the refused send wrote
  stays stored. Where a handler made the request, its event has committed
  and is not rejected.
- **Label rule:** the request slots are every parameter read by value, the
  value of every context cell, and the tool catalog. The result's
  confidentiality is the join of the request slots; its integrity is the
  declared `LlmDerived`. After a tool loop the result's confidentiality
  also joins what the tools returned, which depends on data: it is
  computed in the boundary's own transactions, not from a template. State
  to store: the request hash, the settled result or error, and, if a tool
  loop is to survive a restart, the conversation.

### `generateObject`

- **Source:** `builtins/llm.ts` (`generateObject`).
- **Does:** as `generateText`, with a result that conforms to a schema. It
  has two paths: a direct structured request, and a tool loop with an
  injected `presentResult` tool.
- **Reads:** as `generateText`. After commit it pulls the inputs and context
  again and rebuilds the system prompt, so what is sent can differ from the
  snapshot that was hashed and released.
- **Writes and state:** the same store, plus the conversation in `messages`.
  The result is written through `withLlmDerivedStamp(resultSchema)` and can
  split into child documents.
- **CFC:** as `generateText`. With `schemaSanitizePromptInjection` the
  result is validated and written with `InjectionSafe` annotations
  (`schemaWithInjectionSafeAnnotations`).
- **Execution:** as `generateText`.
- **Request operands:** as `generateText`, under
  `GenerateObjectParamsSchema`. `schema` is read in full and is sent.
  Because the system prompt is rendered again from the live `context`
  after commit, the content of a context entry that leaves can differ from
  the content the recorded request holds.
- **New design:** class B.
- **Tools:** as `generateText`. The injected `presentResult` tool is not a
  pattern closure. Its input is the result, and it carries the label of
  the generation that produced it.
- **Sends:**
  - The first model call. Today it sends a system prompt rendered again
    from the live `context` after the commit, on both paths, in place of
    the one the recorded request holds.
  - On the tool-loop path, each later model call, as for `generateText`.

  The egress ceiling is checked on each of them. A system prompt that is
  rendered again is checked as it is rendered for that send, so the
  content that leaves is the content that was checked. The content of
  each later send is what its send transaction read, and the built-in
  reads neither the context nor a tool result again between the check
  and the send (`scheduler-and-serving-loop.md` §6.3). A send that fails
  the check is not made, and no further send is made for the request. The
  result is the one result of the request, as for `generateText`: `error`
  holds the refusal and `result` stays unset, at every path of the result
  schema. The conversation stored in `messages` before the refused send
  stays stored.
- **Label rule:** as `generateText`. The result has per-path labels declared
  by the result schema, so the boundary's declared rule is per output path.

### `llmDialog`

- **Source:** `builtins/llm-dialog.ts` (`llmDialog`, `startRequest`,
  `handleInvoke`).
- **Does:** maintains a conversation. A turn starts when an event arrives on
  the `addMessage` stream, not when an input changes. Four event handlers
  are registered directly with the scheduler (`addMessage`,
  `cancelGeneration`, `pinCell`, and `unpinAllCells`).
- **Reads:** the parameters, the tools, the context and pinned cells by
  value, and the live transcript. The messages sent are the live ones and
  not the snapshot's.
- **Writes and state:** three owned stores
  `{ llmDialog: { result | internal | pinnedCells: cause } }`. It writes
  *through its input*: each message is a new document with cause
  `{ llmDialog: { message: cause, id } }`, where `id` is a random UUID,
  minted in the space and scope of the resolved `messages` array and pushed
  onto it. The reconcile action declares that array as its materializer
  envelope. The turn claim is `pending` plus a random `requestId`, with a
  heartbeat and a five-minute timeout. An interrupted turn is not resumed.
  Only the first model call of a turn stages a sink request.
- **Tools:** shared with the one-shot model built-ins. A pattern tool
  *instantiates a pattern* with `runtime.run` into a result cell whose cause
  is the tool-call identifier the model supplied, and the instance is left
  running. A handler tool sends an event to the handler's stream. The
  built-in tools `read`, `invoke`, `schema`, `pin`, `unpin`, and
  `updateArgument` let the model read any cell, invoke any handler or stored
  pattern, and write any pattern's argument cell that it can name by link.
  In the compiled design a tool that is a pattern closure follows the rule
  under [Effectful built-ins](#effectful-built-ins) ("A pattern closure
  given to a language model as a tool"). The label of a generation is the
  label of the model message that holds the tool call: the join of
  everything the model had observed when it produced the message. The
  argument the model supplies carries that label, and the result of the
  call carries the label of the instance's own result.
- **CFC:** sink `llmDialog`, ungated as above. Model messages are stamped
  `LlmDerived`; user messages and error literals are not. Before a tool call
  two gates run: the tool's declared maximum confidentiality against what
  the model has observed (`toolAllowsObservedConfidentiality`), and in
  enforcing modes the target's required integrity against the model-supplied
  input (`toolInputRequiredIntegrityFailure`). Both functions are in
  `builtins/llm-dialog.ts`.
- **Execution:** effectful: server only. A computation that is a
  materializer; not replayable. It reads the clock and generates random
  identifiers.
- **Request operands:** the parameters are read under `LLMParamsSchema`.
  - `messages` is read by value: the whole transcript, with the document
    of each message followed, to the depth `LLMMessageSchema` names.
  - The entries of `context` and the pinned cells are serialized as the
    context of `generateText` is.
  - Tools are read as for `generateText`.
  - The streams `addMessage`, `cancelGeneration`, `pinCell`, and
    `unpinAllCells` are references.

  The request is recorded in the transaction of the `addMessage` handler
  (`materializeDialogRequestSnapshot`), for the first model call of a turn
  only, and it has no request hash: the effect is named by a random
  identifier. Every model call of the turn sends the live transcript and a
  system prompt rendered from the live context and pins (`startRequest`),
  so a cell pinned during the turn is serialized by a later call that no
  request recorded.
- **Sends:** every model call of a turn is a send, and no call after the
  first is in a recorded request. Each call sends
  - the live transcript, which holds the messages added since the turn
    started, the results of the turn's tool calls among them;
  - a system prompt rendered from the live context and the pinned cells.

  The egress ceiling is checked on each model call, on the transcript and
  the prompt as they are at that call, in a send transaction. The
  content of each send after the first is what its send transaction
  read: the dialog does not read the transcript, the context or the
  pinned cells again between the check and the send
  (`scheduler-and-serving-loop.md` §6.3). A dialog
  has a result per turn, and the result that takes the error state is the
  one of the turn the refused call belongs to. The call is not made, no
  further call is made for that turn, the turn's claim is released, and
  the turn ends with the refusal as its error. The messages the turn
  added to the transcript before the refused call, tool results among
  them, stay stored, and so do the results of earlier turns. The
  `addMessage` event that started the turn has committed and is not
  rejected. A later `addMessage` event starts a new turn, whose calls are
  checked on the content as it is then.
- **New design:** class B. It is the clearest case of a built-in pattern:
  it has handlers, state cells, and effects, and its write surface is the
  caller's `messages` cell plus whatever its tools write. It splits three
  ways: the conversation state is a pattern with state cells and handlers;
  the model call is the same boundary as `generateText`; and tool execution
  is pattern instantiation and event sending by an effect.
- **Label rule:** the declared rule is per turn, evaluated in the turn's own
  transactions: a model message's confidentiality is the join of everything
  the model had observed when it produced the message, which the built-in
  already records per transcript index (`messageObservations`). State to
  store: the transcript, the turn claim, the pinned cells, and the per-message
  observations. Message identifiers should derive from the turn and the
  position instead of from a random value, so that two executions arrive at
  the same identifier, which the overview requires of state cells.

### `agent`

- **Source:** `builtins/agent.ts` and `builtins/agent-schemas.ts`, behind
  the experimental flag `agentBuiltin`.
- **Does:** queues a task for an agent runner and publishes
  `{ progress, pending, result, error, requestHash, run }`. It sends nothing
  itself. Its post-commit effect creates an `AgentRun` record and lists it in
  the requester's home-space queue. A separate runner process claims the
  record and writes the terminal fields.
- **Reads:** `task`, `resultSchema`, `maxConfidentiality`, and `tools` by
  value. The input cells are read by identity only. It reads the run record
  by value, which is what re-runs the action when the runner moves the
  record.
- **Writes and state:** an owned store `{ agent: { result: cause } }`; the
  record at `{ agentRun: cause, requestHash }` in the piece's space at user
  scope; and an entry in the home-space queue, which can be a write to
  another space. The record's existence is the memo.
- **CFC:** sink `agent`, class `agent`, with a public-only ceiling in the
  strictest preset. Before staging, the consumed label is compared with the
  request's own `maxConfidentiality`. The built-in mints no integrity.
- **Execution:** effectful: server only. Computation; not replayable.
- **Request operands:** each entry of `inputs` is a reference.
  `AgentParamsSchema` in `builtins/agent-schemas.ts` reads it as a cell,
  the request holds the address of its link (`inputLinkSnapshot` in
  `builtins/agent.ts`), and the run record stores the link
  (`AgentRunRecordSchema`). `task` is a string, `tools` is an array of
  tool names, and `progress` is a boolean. `resultSchema` and
  `maxConfidentiality` are read in full. No entry of `inputs` is
  followed. `tools` names tools of the runner and holds no pattern
  closure, so the rule for a closure given to a model as a tool does not
  apply here. The built-in has one send, the record it queues, and it is
  the request. What the runner sends to a model is outside this boundary.
- **New design:** class B. The operation has user scope, because the
  request needs a requester
  ([Effectful built-ins](#effectful-built-ins), "The requester of a
  request").
- **Label rule:** the request slots are the task text, the tool names, the
  result schema, and the *identity* of each input. The record carries links,
  so input values cross the boundary by reference and are labeled where the
  runner reads them. The result is a link to a document the runner wrote
  under its own label. State to store: the request hash and the record.

### `sqliteQuery`

- **Source:** `builtins/sqlite-builtins.ts` (`sqliteQuery`) and
  `builtins/sqlite/`. Authored as `sqliteQuery(...)` and as `db.query(...)`.
  See the [SQLite built-in](../sqlite-builtin/README.md).
- **Does:** runs a read-only SQL statement on the server and publishes one
  state document `{ pending, result, error, requestHash, requestKey,
  withheld }`, where `result` is an array of links to per-row documents.
- **Reads:** the inputs by value, including the database handle. `reactOn`
  is read only to enter the request hash. Reads of its own destination are
  marked `writeDestinationRead` and `ignoreReadForScheduling`. It reads the
  transaction's flow join to label the request.
- **Writes and state:** an owned store `{ sqliteQuery: { result: cause } }`,
  and one document per row. Row identifiers are content-addressed with a
  per-space secret salt, so unchanged rows keep their documents. The set of
  row documents is dynamic. The claim is written in the action's own
  transaction. The request hash includes the reader's identity when rows
  are cleared per reader.
- **CFC:** it is the only built-in that declares its result labels itself
  instead of inheriting the transaction join: per column from each column's
  origin (`labelResultSchema`), per row from row rules, and the request
  label on the result's enumeration and on each slot as a pointer label
  (`withSlotIdentityLabel`). A labeled request to a database in another
  space is refused before staging. Declared ceilings filter or fail rows.
- **Execution:** effectful: server only; a speculating run deduplicates
  instead of issuing. Computation; not replayable.
- **Request operands:** the action reads the inputs without a schema
  (`sqliteQuery` in `builtins/sqlite-builtins.ts`).
  - The database handle is read by value: its `id`, `scope`, and `owner`,
    and its `tables` in full, linked label rules included (`readDbRef`).
    Its `rev` is not read. The space the database is in is taken from the
    identity of the handle.
  - The statement is a string.
  - `params` are serialized in full: `encodeSqliteParams` in
    `runtime/runner/src/cell.ts` walks arrays and plain objects to any
    depth. A cell among them is a reference. At the top level a cell is
    accepted only for a `_cf_link` column and is encoded as a link, and a
    cell nested in a parameter becomes a link too.
  - `reactOn`, `maxConfidentiality`, `onExceed`, `readClearance`, and
    `requestKey` are read in full and enter the request hash. None of them
    is sent. The row schema is read for the ceiling it declares, which
    does not enter the hash.

  The recorded request holds the space and the identifier of the
  database, the statement, the parameters, and, for a database in another
  space, the reader. The provider also receives the table declarations of
  the handle. So the egress check follows `params` in full, stopping at
  cells, the table declarations, and the operands that are hashed and
  not sent.
- **New design:** class B. It is the model for a declared label rule at a
  boundary, because it already has one. A query on a database in another
  space, or with `readClearance`, needs a reader and has user scope or a
  narrower one
  ([Effectful built-ins](#effectful-built-ins), "The requester of a
  request").
- **Label rule:** the request slots are the statement, the parameters, the
  handle, `reactOn`, and the reader. The result's enumeration carries the
  request label. Each column carries the label its table schema declares,
  and each row its row label. State to store: the request hash, the state
  document, and the row documents.

### `navigateTo`

- **Source:** `builtins/navigate-to.ts` and `builtins/navigate-context.ts`.
- **Does:** asks the host to navigate to a target cell and publishes a
  boolean that latches to true once navigation was issued. It does not
  instantiate anything: the target must already be a cell.
- **Reads:** the target by identity only, through a schema with
  `asCell: ["cell"]`.
- **Writes and state:** a session-scoped boolean cell with cause
  `{ navigateTo: { result: cause } }`, which is not an owned store. On a
  serving runtime it appends a navigation intent to the firing session's
  effects document in a transaction of its own.
- **CFC:** no sink request and no egress check; it enqueues its post-commit
  effect directly. No integrity.
- **Execution:** client-enacted: the server computes the intent and the
  client enacts it; a speculating client may navigate optimistically. It is
  the only built-in registered as a scheduler effect. A served `navigateTo`
  that is not a consequence of a client-fired event is a runtime error.
- **Request operands:** the target is the only operand, and it is a
  reference. The action reads it through `targetCellSchema` in
  `builtins/navigate-to.ts`, which marks it `asCell`, and resolves its
  link. The intent a serving runtime appends holds the address of the
  target and nothing of its content. Nothing is followed.
- **New design:** class B, as a client-enacted effect. It is the one
  effect a client enacts. A client enacts it from its speculative run of
  the event, in the handler or in a derivation that follows from it, and
  the navigation is reconciled with the server's result as it is today:
  `deferSealedEffects` in
  `runtime/runner/src/speculation/overlay-destination.ts` enacts a
  speculative run's effects of kind `navigateTo` and of no other kind. A
  client requests no other effect.
- **Label rule:** the only request slot is the identity of the target. The
  boundary's declared rule is the constraint that the request is reachable
  only from an event's consequences. The fact that navigation happened is an
  observable of the handler's inputs, so the intent carries the label of the
  transaction that requested it. State to store: the intent and its
  acknowledgment.

### `compileAndRun`

- **Source:** `builtins/compile-and-run.ts`.
- **Does:** compiles a program given as source files and instantiates the
  resulting pattern into its own result cell, publishing
  `{ pending, result, error, errors }`.
- **Reads:** the program by value. `input` is not part of the request hash,
  so a change to it does not recompile.
- **Writes and state:** five owned stores under
  `{ compile: { pending | result | error | errors | internal: cause } }`;
  the namespace is `compile`. The child piece's documents are its own and
  are dynamic. On a serving runtime the internal store holds
  `{ requestHash, phase }`. Without server execution there is no sink
  request, no outbox, and no durable memo: compilation starts inside the
  action.
- **CFC:** on a serving runtime it records a sink request named
  `compileAndRun`, which is not in `KNOWN_SINKS`. The instantiation passes
  `attributeInitialization: false`.
- **Execution:** compile and instantiate: server only, not speculated.
  Computation; not replayable.
- **Request operands:** the program is read by value under `programSchema`
  in `builtins/compile-and-run.ts`: `files`, each a name and its contents,
  `main`, and `dataFiles`, all strings. A key the schema does not name is
  dropped. `input` is a reference: the action takes it as a cell, it is in
  neither the request nor its hash, and it is passed to the instance as
  its argument. Nothing is followed.
- **New design:** it splits.
  - Compilation is class B: an effect whose request is the program and
    whose result is the identity of a compiled artifact, or errors.
  - Instantiation is the ordinary instantiation of a pattern received as a
    factory value, which the overview already allows in the reactive tier
    and in function bodies.
  - Because the overview makes the compiler trusted, a runtime either
    compiles from source itself or accepts an artifact from a trusted
    party. This boundary is therefore where source supplied at run time
    meets the trusted compiler, and its declared rule must say so.
- **Label rule:** the request slots are the files, the main name, and the
  data files. The compiled artifact's identity carries the request label.
  The instance's outputs follow the compiled pattern's own templates with
  `input` bound to its slots. State to store: the request hash, the phase,
  and the artifact identity.

### `cellFromUrl`

- **Source:** `builtins/cell-from-url.ts`.
- **Does:** parses a URL that names a cell and publishes `{ pending, cell }`,
  where `cell` holds a link to the addressed cell. A URL that names no cell
  resolves with no `cell`. The `writable` input is not read by the
  implementation.
- **Reads:** `url`, `hosts`, and `spaceHost` by value. The target's value is
  never read.
- **Writes and state:** two stores `{ cellFromUrl: { pending | cell: cause } }`.
  It also changes ambient runtime state by registering a space's host
  (`runtime.registerSpaceHostDetailed`). When a space name or host is
  unresolved it sets `pending` and resolves asynchronously.
- **CFC:** it stages nothing, so no egress check applies. No integrity.
- **Execution:** not placed by either server-execution document.
  Computation; listed as non-replayable because name resolution reads an
  ambient cache.
- **Request operands:** `url`, `hosts`, and `spaceHost` are read by value,
  without a schema: a string, an array, and a string
  (`targetOf` and the action in `builtins/cell-from-url.ts`). The cell the
  URL names is a reference: the built-in stores a link to it and never
  reads its content. The request of the effectful half is a space name or
  a host, which are strings, and nothing is followed. Today that half
  stages no request. The runtime resolves a host of another origin
  itself, and may read that origin's deployment metadata over the network
  to do so (`Runtime.resolveSpaceHost`).
- **New design:** it splits.
  - Parsing a URL into an address is class A: a reactive expression whose
    result is a reference with identity derived from the URL's value.
  - Resolving a space name or a host is class B: it is asynchronous, reads
    ambient state, and is expected to probe hosts over the network.
- **Label rule:** the reference's identity depends on the values of `url`,
  `hosts`, and `spaceHost`. Content read through it carries the target's own
  label. For the effectful half, the request slots are the space name and
  host. State to store: the resolution.

### `wish`

- **Source:** `builtins/wish.ts`, `builtins/wish-schema.ts`, and
  `builtins/scope-policy.ts`.
- **Does:** five different things under one name, selected by the query
  (`parseWishTarget`, `resolveBase`):
  1. resolves a path in the current space, or a named well-known target of
     the space or of the user's home space, to a reference;
  2. searches by hashtag over favorites, mentionable pieces, and profile
     elements, and returns candidates;
  3. provides a clock: a one-shot timestamp, or a ticking one driven by a
     per-runtime timer;
  4. launches one of three system patterns as a "sidecar" (suggestion,
     profile creation, profile picker) and returns its user interface;
  5. bootstraps profile state in the user's home space through those
     sidecars.
- **Reads:** path targets by identity and shape. Hashtag search reads every
  candidate's name and schema by value. The view slot of a found piece is
  read non-recursively for its type only. The clock is read with
  `Cell.sample()`, which does not subscribe. A document that is still
  loading makes the action return without writing and re-arm when the load
  settles (`createDocumentReadiness`).
- **Writes and state:** a state store with cause
  `{ wish: { state: { parents, outputSpot } } }`, keyed on position and not
  on the inputs document, unlike the other effectful built-ins. Further
  stores are keyed by the demanding user, by the suggestion's situation, or
  by the clock interval, and only two of the stores are declared as
  `storeWrites`. Two stores are shared across nodes and keyed on constants:
  the interval clock and the shared hashtag state. `result` and `candidates`
  are references to what was found.
- **CFC:** no sink request and no egress check. The result is a reference,
  so the target's labels are consumed where the result is read. Hashtag
  search joins the labels of every candidate it reads into the candidate
  list. Timestamps are coarsened. No integrity is minted.
- **Execution:** classed pure structural and speculable by the
  server-execution documents, with exceptions: on a serving runtime
  home-space targets resolve against the demanding identity, and sidecars
  are instantiated by the server and only referenced by a client.
  Computation, debounced by 50 ms; not replayable.
- **New design:** class A. `wish` is not an effect. Everything it creates is
  created idempotently under an identifier derived from its cause, so a
  reader cannot tell a target the wish created from one that already
  existed. Its parts read as follows.
  - Path and well-known-target resolution is a reference whose identity
    depends on the query and, for home targets, on the acting user.
  - Hashtag search is a filter over a collection that lives in another
    instance, with a label rule that names every candidate.
  - A sidecar is the instantiation of one of three system patterns with a
    deterministic identity, which the reactive tier expresses directly.
  - The clock is the one part with an external input. The wish resolves to
    a reference to a clock cell and does not read it; the runtime writes
    that cell, and each tick arrives as a cause like any other change from
    storage. The one-shot timestamp is a state cell written once when
    empty, so concurrent first writers converge on one value.
- **Label rule:** for path resolution, the reference's identity depends on
  the value of the query and path. For search, the membership of the
  candidates depends on the name and schema of every candidate considered.
  A clock value carries no input label, and its granularity is fixed by the
  target. State to store: the one-shot timestamp and whatever the sidecars
  keep.
- **Plan record:** one `Operation` of kind `wish` per call
  (`plan-and-label-templates.md` §3.19, as an assumption: its question
  47). The operands are stored with the operation, and a reader reads
  `result`, `candidates`, `error`, `errorCode`, and `[UI]` through slots
  on the operation's result. Every path of the result carries the label
  of the operands joined with the reads the resolution made, which the
  runtime journals: the links followed along a path, the tests of whether
  a target holds anything, and the name and schema of every candidate.
  That section has the table from a constant query to its part, by the
  key `parseWishTarget` splits off and the kinds `getResolutionKind`
  gives, and says what the plan has for each: user scope for a home
  target and for a search that can reach the home space
  (`wishTargetMayUseHomeSpace`), a state cell for the one-shot clock,
  and a `Child` per sidecar the query can launch.

## Declarations that produce cells

### `sqliteDatabase`

- **Source:** `builtins/sqlite-builtins.ts` (`sqliteDatabase`).
- **Does:** publishes a handle `{ id, tables, scope, owner, rev }` for a
  database. It does not create the database file.
- **Reads:** its options by value, and its own prior output. It also reads
  the acting principal of the run (`sqliteRunActingPrincipal` in
  `builtins/sqlite-builtins.ts`): the runtime's user on a client, and on a
  serving runtime the actor the run carries, never the service's own
  identity.
- **Writes and state:** one handle cell with cause
  `{ sqliteDatabase: { result: cause } }` at the author-declared scope. The
  `owner` is minted once from the acting principal of the first run and
  never changed. A first run on a serving runtime that carries no actor
  mints no owner, and the handle stays without one: a rule that names the
  owner of the database then admits nobody. Table labels merge grow-only
  across re-derivations (`growOnlyMergeDbTables`).
- **CFC:** the handle carries the per-column label declarations that queries
  and writes later enforce.
- **Execution:** computation; listed as replayable although it reads ambient
  identity and its own prior output.
- **New design:** class C. It is a declaration, in the same family as the
  cell constructors below: it receives a causal identifier, its handle is
  written when first assigned, and it has no request. The plan records it
  as an `Operation` with no request, whose state is the handle
  (`plan-and-label-templates.md` §1.1 and §3.14 have the form of the
  record). Its identifier must not depend on the inputs document, so that
  a change to the table declarations does not name a different database:
  it derives from the name of the variable the declaration is assigned to
  and the `within` steps of the declaration, as a state cell's does (open
  question 8). The handle's `id` is that identifier without its scheme
  where the compiled path first writes the handle. For an instance of a
  space switched from the builder path, the switch copies the stored
  handle, so its `id` names the database the instance had and is not
  the identifier of the document that holds the handle
  (`execution-and-storage.md` §6.8, where the copy is an assumption).
- **Where it is legal.** In the reactive tier only, as the initializer of
  a `const` of a pattern body, like a cell declaration. It is not legal
  at module scope, where no instance exists to name it, and not in a
  function body: no body in the corpus calls it
  ([What the corpus calls inside bodies](#what-the-corpus-calls-inside-bodies)),
  and a body would have to name the same database on every evaluation.
  *Assumed;* `language-subset.md` §4.7 owns the row.
- **Operands.** The options are read by value and in full: `tables`,
  with the label rules the declarations hold. They must be constants of
  the plan, so that the table declarations are known to the compiler. The
  scope is not an operand: it is the scope the declared type of the
  binding gives, `PerUser<SqliteDb>` for example, as for a cell. No
  operand is read for identity. The value the declaration yields is a
  handle: `db.query(...)` reads it by value as an operand of
  the request ([`sqliteQuery`](#sqlitequery), "Request operands"), and
  `db.exec(...)` is a write to it.
- **Label rule:** none of its own. The table declarations are constants of
  the plan. The `owner` is state written once, from the acting principal
  of the transaction that first writes the handle. The state document
  that holds the handle carries no label beyond what the table
  declarations declare, which `plan-and-label-templates.md` assumes (its
  §3.14 and §8, question 40). *Assumed:* where that
  transaction has no principal, which is the case for a declaration of
  space scope first written in a derivation transaction, the handle has
  no owner and stays without one, as today
  ([Effectful built-ins](#effectful-built-ins), "The requester of a
  request").

### `SqliteDb.exec`

- **Source:** `exec` in `runtime/runner/src/cell.ts`. It is a method and not
  a registered built-in.
- **Does:** records an SQL write in the caller's transaction
  (`recordSqliteWrite`), atomic with the caller's cell writes, and
  increments `rev` on the handle, which re-triggers queries that react to
  the handle.
- **CFC:** `checkSqliteWriteCeiling` and `checkSqliteRowLabelWrite` in
  `builtins/sqlite/`.
- **New design:** a write through a cell, legal in a handler body like any
  other cell write. The footprint analysis treats it as a write to the
  handle. It is listed here because its target, the database, is state the
  scheduler does not see beyond the handle.

## The authoring surface

The entries below cover the values the `commonfabric` module exports that are
not registered built-ins, and the cell methods that create graph nodes.

### How the builder works today

Three facts about the builder explain most of the entries.

- **A pattern body builds a graph.** `pattern` in `builder/pattern.ts` runs
  its callback once, eagerly, inside a frame. Every call to a factory inside
  it creates a node record and returns a proxy for the node's output
  (`createNodeFactory` in `builder/module.ts`). `factoryFromPattern` then
  serializes the nodes. The builder mints three module types: `javascript`
  for `lift`, `handler`, `computed`, and `assert`; `ref` for every built-in;
  and `pattern` for a call to a pattern factory.
- **A function body may also build a graph.** Calling a factory inside a
  running lift or handler creates a node in the run's frame. When the body
  returns, the runner collects every cell and node reachable from the result
  or created in the frame into a synthesized pattern (`patternFromFrame` in
  `builder/pattern.ts`) and runs it. For a lift the synthesized pattern runs
  into a cell with cause `{ inputs, outputs, fn }`, and the lift's output
  becomes a link to it (`#writeJavaScriptActionResult` in
  `runtime/runner/src/runner.ts`). For a handler it runs into the event's
  receipt cell (`#handleJavaScriptHandlerResult`). This mechanism, called
  result-as-pattern in the
  [built-in contracts](../server-side-execution/builtins.md) (§3), is how a
  handler instantiates a pattern today. The instance's identity derives from
  the receipt cell, which derives from the durable event identifier, so a
  retry of the same event names the same instance.
- **Minting is guarded, calling is not.** `assertNotInActionExecution` in
  `builder/action-context.ts` throws when `lift`, `handler`, `computed`, or
  `assert` is called to create a new factory inside a running action. Calling
  an existing factory, and calling any built-in, is not guarded.

### Authoring markers

| Name | Today | New design |
| --- | --- | --- |
| `pattern(fn)` | Runs `fn` eagerly to build a graph and returns a `PatternFactory` (`builder/pattern.ts`). | C. The callback is the reactive tier. |
| `PatternFactory.asScope(scope)`, `.inSpace(space, options)` | Derived copies of a pattern factory that set the instance's scope, or its target space with grants (`noteDerivedCopy`). | C, as modifiers of an instantiation. |
| `handler(fn)` | Mints a `javascript` module with `wrapper: "handler"` (`handlerInternal` in `builder/module.ts`). Applying the factory to its state creates a stream and a node, and returns the stream. | C. Binding a handler to state is legal in the reactive tier and in function bodies. |
| `action(fn)` | Throws at run time. The transformer lowers it to `handler(fn)(captures)` (`base/ts-transformers/src/closures/utils/capture-scaffold.ts`). | C. A handler whose state is its captures. |
| `computed(fn)` | The transformer lowers it to `lift(fn)(captures)` (`base/ts-transformers/src/lift/transformer.ts`). | C. Promoted to the reactive tier when its body meets the criterion of `language-subset.md` §6.1: a pure expression that, among other conditions, instantiates no pattern and binds no handler. |
| `lift(fn)` | Mints a `javascript` module factory; calling the factory creates a node. | C. |
| `assert(fn)` | A `javascript` node that returns `{ ok, source, parts }`; used by pattern tests. | C. |
| Inline JSX event handlers | The transformer lowers `onClick={() => ...}` to a handler with captures. | C. A handler binding, in the reactive tier and in function bodies. |
| JSX and `h` | `h` in `builder/h.ts` returns a plain view-node object. | C. Value code constructs view nodes. |
| `SELF`, `NAME`, `UI`, `VIEWS`, and the other well-known keys | String constants used as property keys. | C. |

`derive` is no longer part of the surface: `base/api/index.ts` does not
export it and the pattern corpus does not call it.

### Cell constructors and `.for(...)`

- **Source:** `cellConstructorFactory` in `runtime/runner/src/cell.ts`, bound
  in `builder/factory.ts` as `Cell` and `Writable` (the same constructor),
  `cell` (deprecated in favor of `Cell.of`), `OpaqueCell`, `Stream`,
  `ComparableCell`, `ReadonlyCell`, and `WriteonlyCell`. Each has the forms
  `new X(value)`, `X.of(value)`, and `X.for(cause)`, and the scoped variants
  `X.perSpace`, `X.perUser`, and `X.perSession`. `Default`, `PerSpace`,
  `PerUser`, and `PerSession` are types only and act through the generated
  schema.
- **Does:** creates an unlinked cell whose initial value becomes the schema's
  default. No node is created. The cell's identifier is derived when a link
  is first needed (`#ensureLink`), from a cause and the frame's cause.
- **Identity today**, which differs by where the cell is created:
  - *In a pattern body* the cell stays unlinked until `factoryFromPattern`
    assigns it a partial cause: the name the transformer attached with
    `.for(name, true)` (`ReactiveVariableForTransformer`), a generated
    ordinal for an anonymous cell, or an instance name. The runner derives
    the identifier from the instance's result cell
    ([computed cell identity](../computed-cell-identity.md)).
  - *In a handler* a cell with no cause takes `{ count: n }` from a counter
    on the frame, combined with the frame's cause, which includes the event
    identifier. The identifier is stable across retries of one event only
    while the order of creation is stable. A cell with `.for(cause)` takes
    that cause in place of the counter and is combined with the frame's
    cause in the same way, so it too derives from the event (`#ensureLink`).
  - *In a lift* a cell with no cause throws when it needs a link. With
    `.for(cause)` its identifier derives from that cause and the lift's
    `{ inputs, outputs, fn }` record.
- **`.for(cause, allowIfSet?)`:** stores the cause on a container shared with
  the cell's `.key()` and `.asSchema()` siblings. It throws when a cause is
  already set unless the second argument is true, which the transformer
  always passes.
- **New design:** class C. A cell declaration in the reactive tier is a state
  cell of the plan with the identifier the overview specifies. Creating a
  cell in a function body is one of the calls that remain legal, and the two
  regimes stay:
  - A handler invocation is a new frame for each event. A cell it creates
    with no explicit cause is new on every event: an identifier from the
    handling of the event, which its receipt identifies, and a
    per-invocation counter is sufficient. A cell it creates under an
    explicit cause, `X.for(cause)`, is the same cell on every event: its
    identifier derives from the enclosing instance, the handler's name
    and `within` steps, and the cause, and not from the event
    ([What the plan records](#what-the-plan-records-for-calls-in-bodies)).
  - A pattern body and a lift are re-evaluated, so their cells need
    identifiers that are the same on every evaluation: the variable name in
    a pattern body, and an explicit cause in a lift.

### Cell methods that create nodes

| Method | Today | New design |
| --- | --- | --- |
| `map(fn)`, `filter(fn)`, `flatMap(fn)` | Throw at run time (`throwOpFunctionFormMessage`); lowered by the transformer. | A: the reactive constructs. |
| `mapWithPattern`, `filterWithPattern`, `flatMapWithPattern` | Create `ref` nodes for `map`, `filter`, `flatMap`. | D. No counterpart; authors never wrote them. |
| `count()`, `sum()`, `min()`, `max()` | Create an `aggregate` node. | A. |
| `count(pred)`, `minBy(fn)`, `maxBy(fn)` | Throw; lowered to the `WithPattern` forms. | A. |
| `countWithPattern`, `minByWithPattern`, `maxByWithPattern` | A `map` node and an `aggregate` node. | D. |
| `groupBy(fn)`, `keyBy(fn)` | Throw; lowered. | A. |
| `groupByWithPattern`, `keyByWithPattern` | A `map` node and a `collectionIndex` node. | D. |
| `lookup(key)`, `keys()`, `keyEntries()` | Plain reads of an index; no node. | A: reactive reads of an index. |
| `reduce(fn, initial)`, `findIndex(fn)` | Mint a `lift` inline and apply it to the cell, so they throw inside a running action and the lift has no content-addressed identity. | A: reactive constructs. See their entries. |
| `db.query(sql)` | Creates a `sqliteQuery` node. | B: sugar for `sqliteQuery`, and legal where a request of `sqliteQuery` is: in the reactive tier, and in a `handler` or an `action`. |
| `key(...)`, `get()`, `set(...)`, `push(...)`, `send(...)`, and the other transactional methods | No node. | Cell operations. `language-subset.md` owns the method surface. |
| `asSchema(...)` | No node; returns the cell under another schema. | D. It is not part of the language (`cell:unsupported-method`, `language-subset.md` §4.7). |

The class A rows hold in the reactive tier. In a function body a collection
method called on a cell handle, such as `aCell.map(...)`, is a compile
error (`cell:collection-method-in-function`, `language-subset.md` §4.7).
The compiler refuses the call and does not rewrite it to a reactive form,
the way the transformer rewrites an authored `.map(fn)` on a reactive
receiver to `mapWithPattern` today. The diagnostic names two corrections.

- Wrap the expression in an inline `pattern(...)` and instantiate it. The
  collection method is then in a pattern body, where it is the reactive
  construct, and the result stays reactive. This is legal in every
  function body, a `lift` and a `computed` included
  ([Which body may make which call](#which-body-may-make-which-call)).
- Read first, `aCell.get().map(...)`. The method is then the ordinary
  array method over the values the read returned, and it processes them
  synchronously.

A `WithPattern` method written by an author is refused in every tier
(`removed-form:builtin`), and its correction is the method without the
suffix, with a callback written at the call.

### Context reads

These functions read the frame they are called in and create no node. Each
throws outside the frames named.

| Name | Legal in | Reads |
| --- | --- | --- |
| `eventKey()` | handler | A string naming the event being handled, equal across retries and across the speculative and served runs (`builder/event-key.ts`). Unlabeled. |
| `currentPrincipal()` | handler | The authenticated actor of the event (`builder/current-principal.ts`). |
| `principalOf`, `principalsOf`, `profileOwnerOf`, `resultOwnerOf` | lift, handler | The stored *label* of a target, for attested principals (`builder/principal-of.ts`). The target's value is not read. |
| `linksOf` | lift, handler | The links a value holds (`builder/links-of.ts`). |
| `spaceOf`, `spaceAccess`, `spaceAccessOf`, `spaceMembers`, `spaceDeleted` | lift, handler | A space's identity and access list (`builder/space-access.ts`). |
| `equals(a, b)`, `Cell.equals(a, b)` | anywhere | Whether two cells or values name the same cell. In a frame with a transaction the links both hold are resolved through it before they are compared (`equals` on the constructor that `cellConstructorFactory` in `runtime/runner/src/cell.ts` returns, with `areLinksSame` in `runtime/runner/src/link-equality.ts`). |
| `a.equalLinks(b)`, `Cell.equalLinks(a, b)` | anywhere | Whether two cells or values hold the same link as it is stored. No link is resolved and no transaction is used (`equalLinks` on `CellImpl` and on the constructor in `runtime/runner/src/cell.ts`, with `areLinksSame`). |
| `getPatternEnvironment()` | anywhere | A frozen `{ apiUrl }` (`builder/env.ts`). |

- **New design:** context reads are one of the five kinds of call that are
  legal inside a function body. Each has an
  entry in the body's footprint so that its label is accounted for.
  `principalOf`, `principalsOf`, and `profileOwnerOf` observe a resolved
  reference and its label metadata, the same observation class as
  `inspectConfLabel`. `spaceOf` and `equals` observe resolved references,
  and `linksOf` the enumeration of a list and the identity of each
  element. `equalLinks` observes two references as they are stored.
  `resultOwnerOf` follows links from its operand, and its read of the
  back-link joins no label. The access-list reads `spaceAccess`,
  `spaceAccessOf`, and `spaceMembers`, and `spaceDeleted`, are journaled
  reads of a space's access list. `eventKey` and `currentPrincipal` are
  properties of the cause. The "Context reads" table under
  [What the plan records](#what-the-plan-records-for-calls-in-bodies) has
  the record of each, and
  [Which body may make which call](#which-body-may-make-which-call) says
  where each is legal in the compiled design, the pattern body included.

### Staged changes

| Name | Legal in | Does |
| --- | --- | --- |
| `grantSpaceAccess(target, principal, level)`, `revokeSpaceAccess(target, principal)` | handler | Stage a change to a space's access list on the handler's frame. Each space's staged changes commit as a commit of the list alone, ahead of the handler's writes, and where they commit depends on the runtime (`settleSpaceAccessChanges` in `builder/space-access-change.ts`; [space access changes](../../features/space-access-changes.md)). The two arrangements are described below the table. |
| `nameBlob(target, blobId, name)` | handler | Names a blob: stages a content-addressed document under the given name in the handler's transaction (`nameBlob` in `builder/blob-name.ts`). |

The staged access changes commit in one of two arrangements, which
`settleSpaceAccessChanges` chooses after the handler body returns.

- **On a client** the runner commits them itself, one commit per space,
  before the handler's own transaction commits (`commitSpaceAccessChanges`
  in `builder/space-access-change.ts`). A conflict on the list runs the
  handler again.
- **On a serving runtime** they commit nowhere at that point. They are
  staged on the handler's transaction (`stageSpaceAccessChanges` in
  `runtime/runner/src/executor/wave.ts`) and go with it into the serving
  loop's wave. The memory server checks them when the transaction seals,
  and the wave's commit step applies them first, ahead of every batch that
  carries a run's writes or the events it sends to other spaces
  (`WaveAccumulator.commitWave` in the same file). A change the commit step
  refuses requeues the run's event.

A client's speculative run of a handler that a serving runtime runs for the
same event commits no access change.

- **New design:** class B. Each is requested from a handler, and the
  handler does not read a result. The two kinds differ in what the commit
  does with them.
  - The access changes are a commit of their own because the memory
    server admits a change to an access list only as the single operation
    of a commit (the header comment of `builder/space-access-change.ts`).
    On a serving runtime, where execution is authoritative in the compiled
    design, that commit is already a step of the wave's commit, and the
    batches an `inSpace` instantiation writes to other spaces are steps
    of the same commit. *Assumed:* the commit of a cause that crosses
    spaces is one ordered sequence of five steps, which is not atomic:
    the genesis commit of each space a request of the transaction
    creates; the allocation record of each such space; the staged changes
    to access lists, in the order the handler staged them; the batch of
    writes for each other space; and the home writes
    (`scheduler-and-serving-loop.md` §9.4,
    `plan-and-label-templates.md` §3.14). The access changes are the
    third step. They come after the first two because a handler can stage
    a change to the access list of a space it creates in the same
    invocation, and before every batch of writes because a grant can be
    what admits a batch. The sequence is with the project owner (open
    question 3).
  - `nameBlob` is not a step of that sequence. It stages a document in
    the event's transaction, and the document commits with the handler's
    other writes to its space. It has no request transaction and no
    completion, and it is not a unit of the scheduler.
- **Request operands:** `target` is a reference in all three calls. Only
  the space it lives in is taken, from the identity of the cell
  (`spaceOfTarget` in `builder/space-access.ts`), and a target that is not
  a cell is refused. `principal` and `level`, and `blobId` and `name`, are
  strings. Nothing is followed. `nameBlob` also reads the stored record of
  the blob, which is a document of the blob and not an operand, and stages
  a content-addressed document that holds the record's type and body
  under the given name, in the handler's transaction (`nameBlob` in
  `builder/blob-name.ts`).

### Tool and factory helpers

| Name | Today | New design |
| --- | --- | --- |
| `patternTool(pattern, extraParams?)` | Returns the plain descriptor `{ pattern, extraParams }`; no node. A model built-in instantiates the pattern at tool-call time. | D. Replaced by a pattern closure: an inline `pattern(...)` that captures the bound values, which the compiler binds as private parameters (`language-subset.md`, §4.4.2). |
| `byRef(name)` | A factory for a registered built-in by name. Not used in the pattern corpus. | D. Built-ins are not addressed by name from authored code. |
| `uiVariant(piece, kind)` | Returns the view node `<cf-render variant={kind} $cell={piece} />`; no graph node (`uiVariant` in `builder/built-in.ts`). | Unchanged; a pure function. It is view-node construction in value code, the same as writing the element in JSX, and is legal wherever JSX is: in the reactive tier and in a function body. It reads nothing of `piece`: the operand is passed on unchanged into the node's `$cell` property, so it is observed for `identity`. `kind` is read by `value`. |
| `nameInstance(value, name)` | Records an instance name consumed by `factoryFromPattern`; emitted by the transformer only with the `instanceNames` option. | D. The compiler records instance names in the plan. |

### Pure functions and constants

The remaining exports create nothing and read no frame. They are unaffected
by the design and are listed so that the inventory is complete:
`valueEqual`, `schema`, `getEntityId`, `entityRefToString`,
`renderCellReference`, `isWellFormedDID`, `parseDID`, the debug formatters
(`toCompactDebugString`, `toIndentedDebugString`, `debugStr`), `dataFile`,
`table`, `cfLink`, the `cfSqlite` helpers, the Fabric value classes,
`AuthSchema`, `WebhookConfigSchema`, `multiUserTest`, and the label
vocabulary of `commonfabric/cfc` (`cfcAtom`, `cfcPattern`, `exchangeRule`,
`exchangeRules`, `v`, and the constant tables in `base/api/cfc.ts`).
`equals` is not among them: it compares identity and is a context read, as
`plan-and-label-templates.md` §3.16 lists it.

The table says where a call of each is legal and what the call observes of
its operands, which is what `language-subset.md` §4.4 and §5.1 need for a
row and `footprint-analysis.md` §3.4 for a transfer rule. The tiers are
those of `language-subset.md`: M is module scope, R the reactive tier, and
F a function body. A call in tier R is a pure function of the values it
is given, like a call of a standard-library function. Each function is
pure: none reads a frame, a transaction, or a cell, and none writes. The
column "Today" is by source. The tiers are *assumed*, since
`language-subset.md` owns where a call is legal: each function is given
every tier in which its operands can exist.

| Function | Tiers | Observes of its operands | Today |
| --- | --- | --- | --- |
| `valueEqual(a, b)` | M, R, F | Both operands by `value`, over the whole subtree of each. It follows no link and resolves no cell, so at a position that holds a handle or a reference it compares the two references as they are stored: `identity`, not resolved | Deep structural equality by hash, with `Object.is` for primitives (`valueEqual` in `base/data-model/src/comparison/valueEqual.ts`) |
| `getEntityId(value)` | R, F | A handle or a reference operand by `identity`, not resolved: the identifier and path of the link it holds. Nothing the link leads to is read. A string operand by `value`. *Assumed,* with `footprint-analysis.md` §3.4: a container operand that the body read from an input or a cell is observed by `identity` as well, the result is the identifier of the stored address the value carries, and no content is read; a container the body computed gives `undefined` | `parseLink` on the operand, then the entity reference of the link's identifier, or one derived from the identifier and the path (`getEntityId` in `runtime/runner/src/create-ref.ts`) |
| `entityRefToString(ref)` | M, R, F | The operand by `value`. It is an entity reference, which is plain data | Formats the reference (`entityRefToString` in `base/data-model`) |
| `renderCellReference(link, context?)` | M, R, F | Both operands by `value`. Each is a plain record of a space, an identifier, a path, and a scope, and not a handle: the function resolves nothing and reads no cell | Formats the record as a cell address relative to the context (`renderCellReference` in `runtime/runner/src/cell-reference.ts`) |
| `isWellFormedDID(value)`, `parseDID(value)` | M, R, F | The operand by `value` | String parsing (`base/identity`) |
| `toCompactDebugString(value, options?)`, `toIndentedDebugString(value, options?)`, the `debugStr` tag | M, R, F | Every operand by `value`, over its whole subtree: rendering reads all of it, as a template literal reads a substitution | Render a value as text (`base/data-model/src/value-debug/`) |
| `schema(...)`, `table(...)`, `cfLink(...)`, the `cfSqlite` helpers, `cfcAtom`, `cfcPattern`, `v`, the Fabric value classes | M, R, F | Every operand by `value`, in full. Each constructs plain data from plain data | Plain functions over data |
| `AuthSchema`, `WebhookConfigSchema`, the constant tables of `base/api/cfc.ts` | M, R, F | Constants: no operand | Frozen data |
| `exchangeRule(...)`, `exchangeRules([...])` | M | Operands by `value`, which are constants | Freeze and return a rule declaration, which the CFC authoring contract requires to be exported and static (`language-subset.md` §3.2) |
| `dataFile(path)` | M, R, F | `path` by `value`. *Assumed:* the path is a string literal, so that the files a program reads are known when it is compiled. The result is a constant of the program and carries no label of an input | A per-module binding that returns the text of a file attached to the program (`dataFile` in `builder/factory.ts`) |
| `multiUserTest(descriptor)` | M, in a test file | The operand is returned unchanged | The identity function (`builder/factory.ts`) |

Two rules cover the table for the footprint analysis. A function of the
first kind reads its operands by `value` over the whole subtree, with
`identity` at each position of handle or reference type inside it; every
row but `getEntityId` is of this kind. `getEntityId`, with
[`uiVariant`](#tool-and-factory-helpers) for its first operand, is of the
second kind: it observes a handle, a reference, or a container operand
for `identity` and reads nothing below it. `toSchema<T>()` is not in the
table: it is a compile-time intrinsic with a type argument and no
operand.

In the grammar of `language-subset.md` §3.2, a module-scope *builder* is a
call that takes a callback and yields a definition the compiler hoists and
addresses: `pattern`, `lift`, and `handler`, and nothing else on this
surface. `exchangeRules` and `exchangeRule` are plain functions that freeze
the data they are given, and the compiler gives the declaration its
identity. `toSchema` is a compile-time intrinsic that the compiler replaces
with a schema literal. `dataFile` is a plain function whose per-module
binding reads a file attached to the program. `schema`, `table`, `cfLink`,
and the `cfSqlite` helpers are plain functions over data. A module-scope
`const` initialized by any of these is frozen data, not a builder
definition.

## Forms the transformer emits

The transformer's output refers to the surface through the `__cfHelpers`
import that `transformCfDirective` injects
(`base/ts-transformers/src/core/cf-helpers.ts`). The compiled design retires
this builder form (stage 6 of the overview), so every row is class D in the
sense that authors never wrote it and the compiler emits a plan instead.

| Emitted form | Authored source | Becomes |
| --- | --- | --- |
| `__cfHelpers.lift(fn, argSchema, resultSchema)(captures)` | `computed(fn)`; any reactive expression at a lowerable site, including a template literal; an authored `lift` with captures | A promoted expression, or a sandboxed body with a footprint |
| `__cfHelpers.handler(eventSchema, stateSchema, fn)(captures)` | `action(fn)`; an inline JSX event handler; an authored `handler` | A handler entry in the plan |
| `__cfHelpers.pattern(fn)` as the first argument of a `WithPattern` method | The callback of `map`, `filter`, `flatMap`, `count`, `minBy`, `maxBy`, `groupBy`, `keyBy` | A body compiled once against an element slot |
| `__cfHelpers.ifElse`, `.when`, `.unless`, with schemas prepended | `?:`, `&&`, `\|\|` in pattern context | Conditional operations |
| `recv.key("a", "b")` | Property access on a reactive value | A path in a slot |
| `.for(cause, true)` | A named `const`, or a pattern result (rooted at `"__patternResult"`) | The causal identity of a state cell in the plan, with the same derivation |
| `toSchema<T>()`, replaced by a schema literal `satisfies __cfHelpers.JSONSchema` | Every schema slot of a builder call | Schemas in the plan |
| `__cfHelpers.__cf_data(literal)` | Module-scope plain data | The freezing wrappers the compiler emits |
| `__cfHelpers.tagCollectionKey(value)` | The result of the key function of `groupBy` and `keyBy` | Part of the index operation |
| `__cfHelpers.nameInstance(value, name)` | `const child = Child(...)`, with the `instanceNames` option | An instance name in the plan |
| `__cfHelpers.assertCapture`, `.assertRenderParts` | Operands inside `assert` bodies | Compiler-generated test diagnostics |
| `__cfLift_N`, `__cfHandler_N`, `__cfPattern_N`, and the trailing `__cfReg({...})` | Hoisted builder calls (`BuilderCallHoistingTransformer`) | Content-addressed entries of the compiled artifact |
| `__cfHardenFn(...)` | Module-scope functions | The compiler's statelessness check and wrappers |
| `__cfHelpers.h` | JSX | View-node construction in value code |

Two details matter for the label rules. A template literal lowers to a
`lift` today, so it has one label for the whole string, the same as `str`.
And the schemas prepended to `ifElse`, `when`, and `unless` are passed as
extra inputs that the runtime implementation never reads.

## Calls inside function bodies

The overview keeps five kinds of runtime call inside a function body:
instantiating a pattern, creating a cell with a causal identifier,
requesting an effectful built-in, reading context, and binding a handler.
This section says which bodies may make which, with the pattern body beside
them, and measures the pattern corpus against the rule.

### Which body may make which call

A `handler` or `action` body runs once per event, in a frame of its own. A
`lift` or `computed` body is a computation: the scheduler may run it any
number of times, and it must produce the same writes each time
([Scheduler v2](../scheduler-v2/README.md), §4.2). That difference decides
most rows. The pattern body is the reactive tier and not a function body.
Its column is here because `language-subset.md` §4.4 refers to this
document for the context reads that are legal there, and the other four
rows state what the documents already say of it. `language-subset.md` §5.2
has the same table for the two kinds of function body.

| Call | `handler`, `action` | `lift`, `computed` | Pattern body | Status |
| --- | --- | --- | --- | --- |
| Instantiate a pattern | Yes | Yes. The instance belongs to the computation | Yes | Decided |
| Create a cell | Yes. With no explicit cause the cell is new on every event; with `X.for(cause)` it is the same cell on every event | Only with an explicit cause, `X.for(cause)` | Yes, as a state cell of the plan | Recommended for function bodies; decided for the pattern body, and for what an explicit cause in a handler names |
| Request an effect | Yes | Not directly. A pattern the computation instantiates may request effects in its own body | Yes, except the staged changes, which only a handler requests | Decided |
| Read context | Yes, all of them | All except `eventKey` and `currentPrincipal` | All except `eventKey` and `currentPrincipal`; see the table below | Recommended; the implementation's rule for function bodies. For the pattern body, partly assumed (open question 10) |
| Bind a handler | Yes | Yes | Yes | Decided |

Context reads in the pattern body, read by read:

| Read | Pattern body | From |
| --- | --- | --- |
| `eventKey()`, `currentPrincipal()` | No | `language-subset.md` §10.3 refuses both in the pattern body, as in a `lift` or a `computed` (`function-body:event-context-in-computation`). There is no event |
| `equals(a, b)` | Yes | `language-subset.md` §4.7 lists `X.equals(a, b)` for the reactive tier, and its §5.2 says the function form means the same. `plan-and-label-templates.md` §3.16 records the resolved `identity` slots of both operands |
| `a.equalLinks(b)`, `X.equalLinks(a, b)` | Yes | `language-subset.md` §4.7 lists both for the reactive tier. `plan-and-label-templates.md` §3.16 records the plain `identity` slots of both operands |
| `getPatternEnvironment()` | Yes | It is legal in every frame today ([Context reads](#context-reads)), and `plan-and-label-templates.md` §3.16 records it as a `const` |
| `principalOf`, `principalsOf`, `profileOwnerOf`, `spaceOf`, `linksOf` | Yes. *Assumed* | The legality is with the project owner (open question 10). `plan-and-label-templates.md` §3.16 gives the record of each call in the reactive tier: slots, which a template of the reactive tier holds as it holds any slot |
| `resultOwnerOf`, `spaceAccess`, `spaceAccessOf`, `spaceMembers`, `spaceDeleted` | Yes. *Assumed* | The legality is with the project owner (open question 10). `plan-and-label-templates.md` §3.16 records each with a `dynamic` node, which the reactive tier has for a followed link (its §3.10). `spaceAccess` and `spaceMembers` return a result for the acting principal, so an output that depends on them has the scope `user`, which the plan records in `Output.scope` (its §1.4) |

The reasons, from the implementation:

- **Instantiation.** A handler's instance is identified by the handling
  of its event, or by an explicit cause where the site has `.for(tag)`,
  and is written into state. A computation is evaluated
  again, so an instance it makes has to be named the same on every
  evaluation. The instance belongs to the computation: an evaluation that
  instantiates the same pattern at the same place names the same instance
  and updates its argument, and an instance that an evaluation no longer
  makes is torn down.
  [An instantiation request from a `lift` or a `computed`](#an-instantiation-request-from-a-lift-or-a-computed)
  has the record, the identity, and what the runtime does today, which
  also keeps such an instance from one evaluation to the next
  (`#writeJavaScriptActionResult`).
- **Cell creation.** A handler frame numbers the cells it creates with no
  cause (`#ensureLink` uses the frame's counter when `inHandler` is set).
  In the compiled design a cell that a handler creates under an explicit
  cause is the same cell on every event
  ([A cell created in a handler](#a-cell-created-in-a-handler)). In a
  lift the same code throws unless the cell has a cause, because a
  re-evaluation has to name the same cell. The 10 corpus sites in lifts all
  pass a cause and write the cell at once. A cell so created is a
  side-write whose target depends on data, so the computation is a
  materializer. `footprint-analysis.md` §8.2 makes the write a static
  target only for a constant cause.
- **Effect requests.** Three facts are the reasons to refuse a direct
  request from a computation. A computation may run any number of times,
  and the scheduler's specification places irreversible effects in event
  handlers and post-commit outboxes. A served `navigateTo` outside the
  consequences of an event is a runtime error
  ([built-in contracts](../server-side-execution/builtins.md), §4). And the
  staged changes check for a handler frame and throw elsewhere. No
  computation in the corpus requests an effect. A `lift` or a
  `computed` does not request an effect directly
  (`function-body:effect-in-computation`). It has an indirect route: a
  pattern it instantiates may request effects in its own body, as a
  pattern that a handler instantiates may. Such an effect is a durable
  operation of the child's plan with a memo, and it is requested again
  when its request changes, as any effect is whose input changed. What the
  computation read reaches the request through the argument the
  computation writes, and the label of the argument reaches it too
  (`plan-and-label-templates.md` §3.14 and §3.15). An effect that depends
  on computed data can also be requested in the reactive tier, with the
  computed value as its input.
- **Context reads.** `eventKey` and `currentPrincipal` throw outside a
  handler: a computation has no event, and a value computed from the viewer
  would have to be scoped to that viewer
  (`builder/current-principal.ts`). The label, link, and space reads accept
  both kinds of frame. `spaceAccess` and `spaceMembers` in a computation
  narrow the computation's read scope to the user, since the answer depends
  on who asks.
- **Handler binding.** A binding creates a stream and the state the handler
  is bound to. In a computation it has to be the same stream on every
  evaluation, which the identity under
  [A handler binding made in a body](#a-handler-binding-made-in-a-body)
  gives: it derives from what the binding holds and not from an ordinal. A
  binding made in a handler is identified the same way
  (`plan-and-label-templates.md` §1.3). A binding made in the pattern body
  copies nothing and is named by where it is declared.
- **The pattern body.** Instantiating a pattern, declaring a cell, and
  binding a handler are constructs of the reactive tier
  (`language-subset.md` §4.4 and §4.7): the call of a pattern is a
  sub-pattern or a child instance, a cell constructor declares a state cell
  of the plan, and a handler applied to its state yields a stream. An
  effectful built-in requested there is a durable operation of the plan.
  The staged changes are the exception, since each is requested from a
  handler ([Staged changes](#staged-changes)). A pattern body has no event,
  which rules out `eventKey` and `currentPrincipal`. Today every other
  context read except `equals` and `getPatternEnvironment` also throws in a
  pattern body, because each checks for the frame of a handler or a
  computation (`spaceOf` and `ownCall` in `builder/space-access.ts`,
  `readingFrame` in `builder/principal-of.ts`, `linksOf` in
  `builder/links-of.ts`, `resultOwnerOf` in `builder/result-owner-of.ts`).
  The message of `spaceOf` gives the reason: "a pattern body's references
  name no space yet". That reason belongs to a body that builds a graph. An
  expression of the compiled reactive tier is evaluated with its slots
  bound, so the assumption of the table above is that these reads are legal
  there. `plan-and-label-templates.md` §3.16 gives the record of each call
  in the reactive tier, so the assumption needs no record the plan lacks.

### Method

The corpus, and the way a construct is counted, are those of
`language-subset.md` §11.1: one script that uses the TypeScript parser and
no type checker, over 425 modules. Each call is attributed to its innermost
enclosing body. A body is the function argument of a call to `handler`,
`action`, `lift`, or `computed` imported from `commonfabric`, or an inline
JSX event handler. A call in a plain helper function is counted apart. The
script does not follow a helper to the bodies that call it, so a figure
given as "through helpers" is not reproduced by the measurement. A figure
marked "needs types" depends on a type the script does not have. The corpus
contains 621 handler bodies, 249 action bodies, 73 lift bodies, 1,493
computed bodies, and 188 inline JSX event handlers. The 281 pattern-test
modules and the 64 integration-fixture modules are counted apart. Counts
below are for the corpus unless a row says otherwise.

### What the corpus calls inside bodies

| Call | Sites | Enclosing bodies | Legal under the rule | Rewrite |
| --- | --- | --- | --- | --- |
| Pattern instantiation `P({...})` | 121 | 64 in one computed, 28 in handlers, 28 in actions, 1 in an inline JSX handler | Yes | None in syntax; see below for timing and for the computed |
| `P.inSpace(space, options)({...})` | 3 (plus 19 in fixtures and 8 in tests) | handlers | Yes | None in syntax; a cross-space request |
| `P.asScope("user")({...})` | 2 | computeds | Yes | None. The instance belongs to the computed; see below |
| `navigateTo(target)` | 48 | 33 in handlers, 13 in actions, 2 in inline JSX handlers | Yes, an effect request | None |
| Handler binding `h({ state })` | 16 | computeds | Yes | None |
| `new Writable(value)` | 3, plus 4 through helpers (not reproduced) | handlers | Yes | None |
| `Cell.for(cause)`, `Writable.for(cause)` | 9, plus 1 through a helper (not reproduced) | lifts | Yes | None |
| `.map(fn)` on a cell | 2 found (needs types) | handlers | No (`cell:collection-method-in-function`) | Either wrap the expression in an inline `pattern(...)` and instantiate it, which keeps it reactive, or read first, `cell.get().map(...)`, which maps the values synchronously |
| `grantSpaceAccess`, `revokeSpaceAccess` | 4 | handlers | Yes, effect requests | None |
| `nameBlob` | 2 | handlers | Yes, a staged change: a document staged in the event's transaction | None |
| Context reads | `equals` 109, `spaceOf` 28, `profileOwnerOf` 12, `eventKey` 9, `resultOwnerOf` 9, `spaceAccess` 6, `linksOf` 6, `currentPrincipal` 5, `principalOf` 3, `spaceDeleted` 3, `spaceMembers` 1 | handlers, lifts, computeds | Yes, context reads | None |

Everything else is absent. No body in the sources, tests, or fixtures calls
`computed`, `lift`, `handler`, `action`, `ifElse`, `when`, `unless`, `str`,
an inline `pattern(...)`, `wish`, any of the fetch family, any language-model
built-in, `sqliteDatabase`, `compileAndRun`, or `cellFromUrl`. Those built-ins
are requested in pattern scope: `wish` 111 times, `ifElse` 156, the fetch
family 15, the language-model built-ins 35, `patternTool` 31. The corpus
never uses `unless`, `llm`, `streamData`, `byRef`, `uiVariant`, or `cell`.

Two conclusions follow.

- The rule fits the corpus. Removing the reactive constructs from function
  bodies requires rewriting the 2 cell maps, each by one of the two
  corrections of `cell:collection-method-in-function`. The three computeds
  that instantiate patterns are legal as written.
- The third kind, requesting an effectful built-in from a body, has no
  precedent in the corpus except `navigateTo` and the staged changes. Its
  semantics can therefore be designed without a compatibility constraint, but
  also without evidence of demand.

### Pattern instantiation in bodies

The 126 source sites (121 direct, 3 through `inSpace`, 2 through `asScope`)
are in 28 files. Every callee is a pattern imported by name or a `const` in
the same file. No source instantiates an inline `pattern(...)` in a body, and
none calls a factory received as a value; one integration fixture does
(`patterns/integration/fixtures/owner-private-inbox/main.tsx`).

What happens to the instance, for the 62 sites outside the one large
computed. The split is by reading, and the measurement reproduces the total
only:

| Use of the result | Sites | Representative path |
| --- | --- | --- |
| Pushed into a list cell | 35 | `patterns/system/notes/notebook.tsx`; `patterns/apps/weekly-calendar/weekly-calendar.tsx`; `patterns/examples/reading-list/reading-list.tsx` |
| Passed to `navigateTo` only | 12 | `patterns/system/default-app/default-app.tsx`; `patterns/apps/shopping-list/shopping-list.tsx` |
| Written into a cell with `set` | 2 | `ensureChatRoom` in `patterns/system/loom/main.tsx`; `ensureFileStore` in `patterns/system/fabrifile/store.tsx` |
| Given an explicit cause with `.for(tag)`, then appended | 4 | `mutateElements` in `patterns/system/profile-home/profile-home.tsx` |
| Created in a nested callback | 4 | `createNamed(names, (allocated) => Item({...}))` in `patterns/apps/topics/main.tsx` and `patterns/product/collection-naming/board.tsx` |
| Created in another space with `inSpace` | 3 | `patterns/system/profile-create/profile-create.tsx`; `createPrivateInbox` in `patterns/system/private-inbox/private-inbox.tsx`; `createRoom` in `patterns/system/fabrichat/manager.tsx` |
| Returned from a computed with `asScope` | 2 | `patterns/apps/recommend-a-book/main.tsx` |

Six of the pushed instances are also passed to `navigateTo`, and five are
also returned from the handler as its result. No instance is discarded.

The rewrites, by case:

- **Handler and action sites (57).** The syntax is unchanged. The semantics
  change from result-as-pattern, where the runner sweeps the frame after the
  body returns, to a recorded request with a causal identifier that returns
  a link at once. Writing the link into state, which most of these sites
  do, is what the overview says makes the instance an instantiated pattern.
  The 12 sites that only navigate write the link nowhere. `navigateTo`
  requires a result cell, so passing a link to it also assigns the instance
  one.
- **The causal identifier.** Each handler invocation is a new frame, so the
  handling of the event and the order of requests within the invocation
  identify an instance. The handling is identified by its receipt, which
  is also what an instance derives from today
  ([An instantiation request from a handler](#an-instantiation-request-from-a-handler)).
  The four `.for(tag)` sites show the explicit form. An explicit cause in
  a handler names the same thing across events: the tag names the same
  instance from different events (`plan-and-label-templates.md` §1.3).
  Today it does not: the instance of a `.for(tag)` site is minted under
  the receipt cell of the event like any other, so it derives from the
  event. The four sites therefore change meaning: an event that gives a
  tag an earlier event gave finds the instance the earlier event made.
- **Modifiers.** `P.asScope(scope)` and `P.inSpace(space, options)` are
  legal callees. `inSpace` makes the request a cross-space one: the new
  instance, and often its space, are created by a commit to another space.
- **Reading from a fresh instance in the same run.** `createRoom` in
  `patterns/system/fabrichat/manager.tsx` instantiates a room in a new space
  and reads `spaceOf(room)` from the returned link in the same handler run.
  Today the first run finds the space pending, is discarded, and runs again.
  In the compiled design the identifiers of an `inSpace` request are known
  before the cross-space commit. The identifier of the instance derives
  from the request's causal identifier. The identifier of a space the
  request creates is obtained and not derived
  ([An instantiation request from a handler](#an-instantiation-request-from-a-handler)).
  *Assumed,* as `execution-and-storage.md` §5.6 has it: the runtime that
  runs the handler authoritatively obtains the identifier when the request
  is made, so the handler reads the space in the same invocation with no
  re-run. A client's speculative run of a handler that names a space with
  no allocation record does not speculate
  (`scheduler-and-serving-loop.md` §9.4).
- **Nested instances.** `patterns/dev/gideon-tests/notebook-nest-bug/main.tsx`
  builds twelve instances in one action and passes inner ones as inputs of
  outer ones. Each request needs its own identifier, and a link to an
  instance not yet created must be a legal input of another request.
- **Instantiation in a computed (66 sites, 3 computeds).** One computed in
  `patterns/dev/catalog/ui/story-renderer.tsx` selects one of 64 patterns in
  a `switch` and returns the instance. Two computeds in
  `patterns/apps/recommend-a-book/` return an `asScope("user")` instance.
  All three are legal as written: a `lift` or a `computed` may instantiate
  a pattern, and the instance belongs to the computation
  ([An instantiation request from a `lift` or a `computed`](#an-instantiation-request-from-a-lift-or-a-computed)).
  No rewrite is required. Each site makes at most one instance per
  evaluation, so the ordinal among the instantiations of the site
  identifies it, and none needs an explicit cause. No site is in a loop
  or a callback of its body, so none gets the warning for an
  instantiation there that has no `.for(cause)`. In the computed that
  selects among 64 patterns each `case` is a site of its own: an
  evaluation that takes another `case` tears down the instance of the
  `case` it took before and makes one at the new site. An author may still
  move such a selection to the reactive tier, as a conditional expression
  or an index into a record of sub-patterns, where a statically resolved
  callee is compiled into the surrounding instance and has no result cell
  of its own.
- **No lift returns a pattern.** The 73 lift bodies in the sources contain
  no instantiation.

### Handler bindings in computeds

Sixteen sites bind a handler inside JSX that a computed returns:
`patterns/apps/base/person.tsx` (7), `patterns/apps/base/family-member.tsx`
(6), and `patterns/apps/store-mapper/store-mapper.tsx` (3). Eight more
inline JSX event handlers sit inside a computed. All are legal and need no
rewrite. A `computed` that binds a handler is not promoted
(`language-subset.md` §6.1), so each of these bindings is one made while
a function body runs and follows the rule for such a binding.

All sixteen have the form `h({ state })`, where `h` is a handler defined at
module scope: `removeAddress({ person, index: i })` inside an array `map`,
for example. `language-subset.md` §5.2 specifies both spellings of a
binding: the inline arrow and `action(...)` forms, and a named handler
applied to its state, which is the one the corpus uses in bodies. The
object argument is the state, and the same state rules hold for both. In
the example, `person` is a cell handle and stays a link, and `index` is a
scalar and is copied
([A handler binding made in a body](#a-handler-binding-made-in-a-body)).

Today such a binding creates a stream and a node in the computation's frame.
The runner sweeps both into a synthesized pattern, runs it into a cell whose
cause is the lift's `{ inputs, outputs, fn }` record, and makes the lift's
output a link to that cell. When the computation re-runs, the synthesized
pattern is hashed, and the child is replaced only if the hash changed
(`#writeJavaScriptActionResult`). In the compiled design a binding is a
record of the plan and a stream whose identity derives from what the
binding holds, with no synthesized pattern.

### Cell creation in bodies

- Handlers create cells with `new Writable(value)` and no cause:
  `patterns/apps/base/contacts.tsx`, `patterns/system/loom/admission.tsx`,
  and through helpers `patterns/apps/shared-note/main.tsx` and `sendInto` in
  `patterns/system/fabrichat/room-records.tsx`. Their identifiers come from
  the frame's counter, which is sufficient because each invocation is a new
  frame. The measurement found no handler that creates a cell under an
  explicit cause.
- Lifts create cells with an explicit cause and write them at once,
  `Cell.for(input.id).set(...)`:
  `patterns/examples/cfc-spec-gallery/main.tsx`,
  `patterns/examples/cfc-trusted-component-examples/disclaimer-examples.tsx`,
  `patterns/product/collection-naming/naming.ts`, and
  `patterns/apps/topics/main.tsx`. A lift that writes a cell it names by
  cause is a computation with a side-write whose target depends on data. In
  the compiled design that is a materializer. `footprint-analysis.md` §8.2
  makes the write a static target only for a constant cause. It stays
  legal, with the explicit cause required.

### FabriChat

FabriChat (`patterns/system/fabrichat/`, specified in
[`docs/specs/fabrichat/`](../fabrichat/README.md)) is the overview's
reference pattern. Its sources define 14 patterns and 25 module-level
handlers. They apply a handler to its state at 50 sites, 47 of them for
those 25 and 3 for two handlers imported from other modules, and call
`computed` 112 times, `action` 10 times, and `wish` 8 times. They use no
`lift`, `ifElse`, `when`, `unless`, `str`, fetch, language-model built-in,
SQLite built-in, or `navigateTo`.

- **Per-row instances are already reactive constructs.** The message rows
  are `facts.main.map((message) => <FabriChatMessageRow ... />)` in the
  pattern body of `patterns/system/fabrichat/room.tsx`, and the per-user room
  lookups are `savedRooms.map((entry) => FoundRoom.asScope("user")({...}))`
  in `patterns/system/fabrichat/manager.tsx`. Neither is in a function body.
  Under the compiled design these 16 `map` calls are where the saving lands:
  a row is a cone keyed by element identity, with no sub-pattern instance.
  The `asScope` modifier inside a `map` body is a modifier of the anonymous
  sub-pattern: it sets the scope of the state the sub-pattern declares.
- **One instantiation in a body.** `createRoom`, described above.
- **One cell created in a body.** `sendInto` creates the reactions list of a
  message with `new Writable([])` before pushing the message that links it.
  It needs no explicit cause, being created in a handler.
- **The send gate is declared in types and attributes, not by a call.** The
  stored message type `SentMessage` in
  `patterns/system/fabrichat/room-records.tsx` wraps the record type in
  `AuthoredByCurrentUser` and `WritePolicyAnyOf`, with one
  `TrustedActionWrite` entry per permitted writer.
  Each entry names a module-level handler by `typeof`, an action name, and a
  surface name. The surface is marked in JSX with `data-ui-pattern`,
  `data-ui-event-integrity`, and `data-ui-action` attributes
  ([clients](../fabrichat/clients.md), "Writing: the reviewed-gesture
  requirement"). No built-in is involved, so the gate does not appear in
  this inventory as an operation. It does constrain the design: the policy
  names the writing handler by the type of a `handler(...)` value, so the
  compiler's label annotations must be able to name a handler, and the plan
  must give each handler an identity the gate can be checked against on the
  client and on the server.
- **Other calls in bodies.** `grantSpaceAccess` in `commitAddMember`
  (`patterns/system/fabrichat/room.tsx`), an effect request, and the context
  reads `eventKey` and `currentPrincipal` in several handlers.

## What the plan records for calls in bodies

`plan-and-label-templates.md` defines the plan's records. Its `Body` record
lists the sites of four of these calls in `Body.calls`, as `BodyCall`
entries of the kinds `instantiate`, `createCell`, `effect`, and `bind`
(§1.1), and its §3.14 gives their label rules. Context reads are recorded
as its §3.16 says. For each call, this section states the facts those
records hold, from what the implementation does today. Each has a *static*
part, known to the compiler per call site, and a *run-time* part, known per
invocation.

**The handling.** Where this section says an identifier derives from the
handling, it derives from the receipt of the handling: the durable
identifier of the event and the stream the event was sent to, and not the
acting principal (`handlingReceiptId` in
`runtime/runner/src/scheduler/event-identity.ts`;
`plan-and-label-templates.md` §1.3). One event on one stream is one
handling whoever sends it. The string that `eventKey()` returns is a
different thing. It binds the actor as well (`deriveEventKey` in the same
file), and it is a context read and not the seed of an identifier. An
event that a handler sends on a stream is identified by the handling and
the event's order among the events that invocation sends.

**References.** A value a body passes on unchanged is a reference: a cell
handle, and a container the body read from an input or a cell and hands on
whole, are stored as a link to where they were read, and the body does not
read their content (`footprint-analysis.md` §3.8). The rule applies to the
argument of an instantiation, to a request, and to the state of a binding
made in a function body. *Assumed:* the rule stands as it is today, where
such a value carries the address it was read from
(`annotateWithBackToCellSymbols` in `runtime/runner/src/schema.ts`). The
question is with the project owner (the continuation plan, question 10).

### An instantiation request from a handler

Today the instance's result cell is minted under the event's receipt cell
(`handlingReceiptLink`), with a cause of the form `{ resultFor: outputSpot }`
(`#mintChildResultCell` in `runtime/runner/src/runner.ts`). The output spot
is an internal cell of the synthesized pattern, whose partial cause is the
name the author or the transformer attached with `.for(...)`, an instance
name, or a generated ordinal (`factoryFromPattern`).

- **Static:**
  - the call site, an entry of `Body.calls` of the kind `instantiate`;
  - the callee: a compiled pattern by content address, the slot that
    holds a pattern factory value (see
    [Factory values](#factory-values)), or an inline `pattern(...)` written
    at the call, with what it captures;
  - the argument binding: for each path of the callee's argument, a
    `WriteEdge` with the target `argument` that holds the template of the
    expression bound to the path, so that labels flow into the instance's
    argument slots;
  - the scope, when the callee carries `asScope(scope)`, which is a
    constant;
  - the space request, when the callee carries `inSpace(space, options)`:
    whether the target is a space identifier, the space of a given cell, a
    name the calling space resolves, or anonymous; and the options `grants`,
    `root`, `spaceKind`, and `selfOwned` (`InSpaceRequest` in
    `builder/pattern.ts`);
  - whether the site has an explicit cause, `.for(tag)`, and the template
    of the tag, since an identifier derived from data carries that data's
    label.
- **What an argument path holds.** The site does not choose between a copy
  and a link. The reference rule above decides it per path. A path bound to
  a cell handle, or to a container the body read and passes on unchanged,
  is written as a reference: the write edge records which `identity` slot
  the reference is (`WriteEdge.reference`), the path carries the label of
  the reference, and the content keeps its own label where it is stored. A
  path bound to a scalar, or to a value the body computed, is written as a
  value with the body's template. A reference inside a computed container
  stays a reference.
- **Run time:** the handling and the order of the request within the
  invocation, or, for a site with an explicit cause, the value of the
  cause; the resolved target space.
- **Identity.** Without an explicit cause the identifier derives from the
  handling and the order of the request, so it derives from the event, as
  today. With `.for(tag)` it derives from the enclosing instance, the
  handler's name and `within` steps, the site, and the tag, and not from
  the handling: the tag names the same instance on every event, and two
  handlers that pass equal tags name two instances
  (`plan-and-label-templates.md` §1.3). Such a request counts toward the
  order of the handler's later requests. An event that names
  an instance an earlier event made creates nothing, and the existence
  label of the instance is fixed when it is first created. *Assumed,*
  with that document (its §8, question 39): such an event does not write
  the argument again, so the instance keeps the argument of the event
  that created it. Today the
  identifier of a `.for(tag)` site derives from the event as well
  ([Pattern instantiation in bodies](#pattern-instantiation-in-bodies)).
- **Links to instances not yet created.** A request returns a link whose
  identifier is derived from the facts above before anything is created. An
  argument of a later request in the same invocation may hold that link, so
  the argument binding has to be able to name an earlier request of the same
  body. `patterns/dev/gideon-tests/notebook-nest-bug/main.tsx` nests twelve
  requests this way.
- **Cross-space requests.** `inSpace` already opts the handler's
  transaction into a commit that spans the child's space and the parent's,
  with child spaces ordered first (`enableCrossSpaceChildCommit` in
  `runtime/runner/src/runner.ts`, called from
  `optIntoInSpaceMultiSpaceCommit`). A named or anonymous space that is not
  yet resolved is recorded on the frame (`pendingSpaceNames`), resolved
  after the run through the calling space's allocation record
  (`Runtime.resolveInSpaceNameSync`), and the handler is run again. An
  anonymous space is named from the frame's cause and a per-frame counter
  (`anonymousSpaceName`). The record therefore also needs the request's
  position among the body's `inSpace` requests.
- **The identifiers of an `inSpace` request.** Both are known to the body
  when it makes the request, before the commit that spans the spaces, and
  they come about in two ways.
  - The identifier of the instance is derived: from the request's causal
    identifier, in the target space, or it is the root the target space
    reserves when the request has `root`.
  - The identifier of a space the request creates is obtained and is not
    derived from the request. Creating a space returns a new identifier
    ([random space identities](../random-space-identities.md)). The
    runtime records the allocation in the calling space: the obtained
    identifier under the name the request gives, or, for an anonymous
    space, under the request's own identifier. That record is written in a
    step that commits before the step in the foreign space, so that a
    retry finds the record and names the same space
    (`plan-and-label-templates.md` §3.14). A space identifier derived from
    the request would make a retry converge without the record, and it is
    not what creating a space gives.

  Which sequence of commits carries those steps is open question 3.

### An instantiation request from a `lift` or a `computed`

A `lift` or a `computed` may instantiate a pattern: a named pattern, an
inline `pattern(...)` written at the call, or a pattern factory value. The
pattern may request effects in its own body. The instance belongs to the
computation.

Today a computation whose result holds an instance already keeps the
instance from one evaluation to the next.

- **The cell.** The runner turns the frame of the run into a synthesized
  pattern (`patternFromFrame` in `builder/pattern.ts`) and runs it into a
  cell whose cause is the computation's `{ inputs, outputs, fn }` record:
  its input and output bindings and the source of its function
  (`#writeJavaScriptActionResult` in `runtime/runner/src/runner.ts`). The
  record is the same on every evaluation, so every evaluation names the
  same cell, one for each scope the output is evaluated for. The
  computation's output is a link to that cell.
- **Identity.** The instance takes its result cell from its place in the
  synthesized pattern. The cause is `{ resultFor: outputSpot }`
  (`#mintChildResultCell`), and the output spot is an internal cell of the
  synthesized pattern's cell, named by a `.for(...)` name, an instance
  name, or an ordinal that `factoryFromPattern` generates. An evaluation
  that builds the same graph names the same instance.
- **Argument.** The values the body computed for the argument are inputs
  of the instance's node in the synthesized pattern. On each evaluation
  the runner hashes the synthesized pattern. With the hash of the
  evaluation before, nothing is set up again. With another hash, which a
  changed argument value gives, the runner runs the new synthesized
  pattern on the same cell (`run`): the piece running there cancels its
  nodes and instantiates the new ones (the swap in `#startCore`), and the
  node of the instance sets its child up again at the same result cell,
  with the new argument (`#instantiatePatternNode`). An argument that is a
  cell is a link in the node's inputs, so a change of the cell's content
  changes no hash, and the instance reads the content through the link.
- **Teardown.** The node of an instance releases its child when the node
  is canceled (`releaseChild`). An instance the new synthesized pattern
  does not have is therefore released when the nodes of the old one are
  canceled, and everything the computation started is released when the
  computation's own node is canceled.

In the compiled design the request is a record of the plan, with no
synthesized pattern.

- **Static:** as for a handler's request: the call site, an entry of
  `Body.calls` of the kind `instantiate`; the callee; one `WriteEdge` with
  the target `argument` per argument path, each holding a reference or a
  value by the reference rule; the scope; and whether the site has an
  explicit cause, `.for(cause)`, with the template of the cause.
- **Run time:** the occurrences the evaluation made at each site, in
  order, or the value of each explicit cause, and the argument of each.
- **Identity.** The instance is identified by the enclosing instance,
  the body's name and the calls and callbacks the site is written in
  (the body's `within` steps), the site, and the ordinal of the
  instantiation among those the evaluation makes at that site. Where the
  author writes `.for(cause)`, the cause takes the place of the ordinal
  (`plan-and-label-templates.md` §1.3 and §3.14). Four things follow.
  - A site that an evaluation runs once needs no cause. An evaluation that
    reaches the site again names the same instance.
  - A site in a loop names its instances by the order in which the loop
    makes them. When the first item of a list is removed, each instance
    takes the argument of the next item, and the last instance is torn
    down. An author who wants each instance to stay with its item writes
    `.for(cause)` with a cause taken from the item.
  - The compiler warns on an instantiation inside a loop or a callback
    in a function body that has no `.for(cause)`, because of the case
    above (`function-body:instantiation-without-cause`). It is a warning
    and not an error, and `language-subset.md` §10.3 has its entry in
    the diagnostic catalog. *Assumed,* with that document (its §13,
    question 26): the warning is reported in a `lift`, a `computed`, an
    `assert`, and an authored function that one of them or the reactive
    tier calls, and not in a `handler`, an `action`, or an inline event
    handler.
  - The ordinal is per site, where today's generated ordinal counts every
    anonymous cell of the frame. A branch that makes an instance on some
    evaluations only therefore does not rename the instances of the other
    sites.
- **The argument.** Each evaluation writes the argument of every instance
  it makes, through the write edges. An evaluation that names an instance
  that exists updates its argument and creates nothing, and the instance
  keeps its state. The edges belong to the cone that runs the body. They
  are derived writes: a failed constraint on one drops that write alone,
  and they do not make the body a materializer
  (`plan-and-label-templates.md` §3.14).
- **Label.** The link the call returns carries the body's template: that
  the instance exists, and which one it is, depends on what the body read.
  Each argument path carries the body's template, or the label of a
  reference the body passes on. Where the identifier holds an explicit
  cause, the template of the cause is the label of the instance's
  existence, as for a cell created under a cause. The runtime keeps, with
  the cone, which instances the last evaluation made at each site, and
  that record has the confidentiality of the body's template
  (`plan-and-label-templates.md` §2.6).
- **Teardown.** An instance that an evaluation no longer makes is torn
  down: a branch that is not taken, or a loop that runs fewer times, ends
  the instances the last evaluation made there. The cones of a torn-down
  instance are not evaluated again and its effects are not requested
  again. An evaluation that fails makes no instance and tears none down,
  and the arguments of the instances the last evaluation made take the
  error state (`plan-and-label-templates.md` §3.14 and §5.2).
  When the callee is a factory value that differs from the one of the last
  evaluation, the instance at that place is torn down and a new one is
  started under the same name, as for a child of the reactive tier
  ([A pattern factory value in the reactive tier](#a-pattern-factory-value-in-the-reactive-tier)).
- **Effects.** The computation requests no effect itself
  ([Which body may make which call](#which-body-may-make-which-call)). A
  pattern it instantiates may. Such an effect is an operation of the
  child's plan. A cone of the child computes its request from the child's
  argument, so what the computation read reaches the request through the
  argument the computation writes, and so does its label. The effect is
  requested again when its request changes, as any effect is whose input
  changed, and its egress ceiling is checked in the operation's own
  request transaction
  ([An effect request made from a body](#an-effect-request-made-from-a-body)).
- **`inSpace`.** *Assumed:* the modifier is legal on such a callee, as it
  is today, where a reactive action that names an unresolved space runs
  again a bounded number of times (`Runtime.resolveInSpaceNameSync` in
  `runtime/runner/src/runtime.ts`). The ruling does not mention it, and
  the corpus has `inSpace` in handlers only. The identifiers are those of
  a handler's `inSpace` request, with the computation's identity of the
  instance in place of the handling. The question is with the project
  owner (the continuation plan, question 50). A computation of space
  scope has no acting principal, and its `inSpace` instantiation is
  refused; what crosses to the other space when a later evaluation
  changes the argument of such an instance or tears it down is
  `scheduler-and-serving-loop.md` §9.3.
- **Against today.** An instance is named by its place today as well, and
  its argument carries the join of the computation's transaction, which
  is the body's template. What differs is that today a synthesized
  pattern that changed replaces the one running, where the compiled
  design updates the argument of an instance that stays.

### A cell created in a handler

Today the identifier is `createRef({ frame: { count: n } }, frameCause)`,
where `n` counts the cells the frame has linked and the frame's cause holds
the event identifier (`#ensureLink` in `runtime/runner/src/cell.ts`). The
initial value is stored as the schema's default.

- **Static:** the creation site; the schema; the scope, for the scoped
  constructors; the template of the initial value. The initial value is a
  `WriteEdge` whose target has the kind `created` and names the
  `createCell` site (`plan-and-label-templates.md` §1.1 and §3.14).
- **Run time:** the handling and the cell's order within the invocation,
  or, for a cell created under an explicit cause, the value of the cause.
- **Label:** the initial value is a write by the handler body and carries
  the body's template, as any path the handler writes does.
- **An explicit cause.** A cell that a handler creates with
  `X.for(cause)` is the same cell on every event. Its identifier derives
  from the enclosing instance, the handler's name and `within` steps,
  and the cause, and not from the handling
  (`plan-and-label-templates.md` §1.3). Two handlers of one instance
  that pass equal causes name two cells. An event that names a cell an
  earlier event created creates nothing and finds the cell as it is
  stored. The existence label of the cell is fixed when it is first
  created: it is the template of the cause as the creating event
  instantiated it, since which document exists reveals the cause's value,
  and a later event does not change it. A read through the handle of such
  a cell is dynamic, because the cell can hold what an earlier event
  wrote (`footprint-analysis.md` §8.2). Without an explicit cause an
  identifier minted in a handler derives from the event, as today. Today
  an explicit cause in a handler is combined with the frame's cause,
  which holds the event identifier, so each event names a cell of its
  own (`#ensureLink`).

### A cell created with an explicit cause in a lift

Today the identifier is `createRef({ frame: cause }, resultFor)`, where
`resultFor` is the lift's `{ inputs, outputs, fn }` record. All ten corpus
sites write the cell in the same statement.

- **Static:** the site; the schema and scope; the template of the cause
  expression; the template of the value written.
- **Run time:** the value of the cause.
- **Label:** two things carry a label. The value written carries the body's
  template. The *identifier* is derived from the cause, which is data, so
  which document exists reveals the cause's value; the cause's template is
  the label of the document's existence.
- **Scheduling:** the target is not static, so the write is a materializer
  write. `footprint-analysis.md` §8.2 makes it a static target only for a
  constant cause.

### A handler binding made in a body

Today applying a handler factory creates a stream cell with the event schema
and a node whose inputs are `{ $ctx, $event }` (`handlerInternal` in
`builder/module.ts`), and returns the stream. A value the body read from an
input carries the address it was read from, and the builder puts the cell
at that address into the node's inputs in place of the value
(`connectInputAndOutputs` in `builder/node-utils.ts`). So a container the
body passes on unchanged is bound by reference today, and the handler
reads it through the link when an event arrives.

What a binding holds depends on where it is made.

**A binding made in the reactive tier copies nothing.** The reactive tier
is the pattern body and everything compiled in it, the body of a
per-element callback of `map`, `filter`, and the other collection
constructs included. Every path of the handler's state resolves to a slot
or an output of the instance. In
`list.map((el) => ... action(() => otherList.push(el)))`, written in a
pattern body, `el` is bound by reference: the handler's state path is the
element's slot, and the push stores a link to the original element.

**A binding made while a function body runs** is a `bind` site in a
`lift`, a `computed`, a `handler`, an `action`, an inline event handler, or
an authored function one of them calls. Each path of the handler's state
is bound by what the body has there (`language-subset.md` §5.2).

| What the body binds at the path | The binding holds | `capture` |
| --- | --- | --- |
| A cell handle | A link to the cell | `link` |
| A scalar: a primitive, a literal, `null`, `undefined` | A copy, in the binding's state document | `copy` |
| A container (an object, an array, or a tuple) that the body read from an input or a cell and passes on unchanged; a reference at a position typed `unknown`, likewise | A link to the address the container is stored at. The body records `identity` at the path and does not read the container's content | `link` |
| A container the body computed: an object or array literal, a spread, the result of a call or of an operator | A copy, in the binding's state document. A cell handle inside it stays a link, and so does a container inside it that the body read and passes on unchanged | `copy` |

The handler reads a container bound by reference when an event arrives, in
the event's transaction, at the paths and in the classes of its own
footprint. A record it passes on, for example by pushing it onto a list,
is a link to the original and not a second record. A scalar and a computed
container are as they were when the binding was made. How much of a
computed container the copy holds is decided by what the bound handler
reads of it: the paths the handler's footprint names, and, for a handler
received as a factory value, the paths its declared state type covers
(`footprint-analysis.md` §8.5).

A path can hold a reference on some runs only, for example where the body
binds a conditional between a container it read and one it computed. The
plan records such a path as copied, with no reference named, and the
runtime decides per run from the value it is handed: a value that carries
a stored address is stored as a link, and any other value is copied. The
identity of the stream takes the address on the first kind of run and the
salted value on the second (`plan-and-label-templates.md` §3.14).

- **Static:** the binding site, an entry of `Body.calls` of the kind
  `bind` that names a `Binding`; the handler, as an index of the plan's
  bodies or, for a handler received as a value, the slot that holds the
  factory; and for each path of the handler's state the template of what
  is bound to it and its `capture` (`Binding.state` in
  `plan-and-label-templates.md` §1.1). `capture` is `link` for a cell
  handle and for a container bound by reference, and `copy` for a scalar
  and for a computed container. For a path bound by reference the record
  names the `identity` slot whose reference the binding holds, and the
  runtime verifies it by identity, as it verifies a reference a body
  writes. A binding of the reactive tier has no path with `copy`, and it
  has a name and `within` steps.
- **Run time:** for a binding made in a function body, the copied values,
  the linked cells, and the addresses of the containers bound by
  reference.
- **Identity.** For a binding made in a function body, the stream's
  identifier derives from the enclosing instance, the handler, and what
  the binding holds: the copied values, the identities of the linked
  cells, and the addresses of the containers bound by reference. A copied
  value is salted before it enters the identifier, as an element key is.
  The identifier holds no ordinal and nothing of the handling. Then:
  - a computation that is evaluated again with the same state binds the
    same streams;
  - a binding made in a loop is told from its neighbors by what it holds
    and not by its position;
  - two bindings of one handler to equal copied values and to the same
    cells and addresses are one stream, which is harmless because they
    behave alike;
  - two bindings of one handler to equal records stored in two places are
    two streams, because the addresses differ;
  - a binding made in a handler is identified the same way, so the same
    binding made for two events is one stream.

  A binding made in the reactive tier is not identified by what it holds.
  Its stream is named by where it is declared: the instance, the `within`
  steps with the keys of the enclosing elements, and the binding's name
  (`plan-and-label-templates.md` §1.3).
- **Clients.** A client cannot read the salt. It cannot name the stream
  of a binding with a copied path before the server stores a link to it.
  A binding with no copied path has an identifier a client derives, unless
  an element key among its `within` steps holds a value.
- **Label:** a copied path is stored in the binding's state document and
  carries the body's template. A path bound by reference holds a
  reference and carries the label of that reference: the body observes
  the cell or the container for identity, and the content keeps its own
  label where it is stored. The identity label of the stream is the join
  of the templates of the state paths, which is the body's template
  unless every path is a reference the body passes on. For a handler
  received as a factory value, the label of the slot that holds the
  factory joins it (`plan-and-label-templates.md` §3.14 and §3.21). An
  event later handled by the binding reads its state as slots with the
  root `binding`: a copied path resolves to the binding's state document,
  and a path bound by reference crosses the link the binding holds, so
  its label joins the pointer's label with what the handler observes at
  the target.
- **Against today.** Equal or tighter. A container passed on unchanged
  stays a link today, and a scalar and a computed container are copied
  today. For an inline event handler the transformer rewrites a captured
  container into the paths the handler reads, which the body that makes
  the binding then reads; a binding by reference reads none of them in
  that body, which is tighter. `footprint-analysis.md` §8.5 has the
  comparison case by case. The rule is not an exception to "equal to or
  tighter".

### An effect request made from a body

Today a built-in called in a handler body becomes a node of the synthesized
result pattern and runs as it would in a pattern body.

- **Static:** the request site, an entry of `Body.calls` of the kind
  `effect`; the built-in, named statically; and the request, as write
  edges. Each path of the request is a `WriteEdge` with the target
  `request` that names the site (`plan-and-label-templates.md` §1.1 and
  §3.14). A path that holds a scalar or a value the body computed carries
  the body's template: a sandboxed body has one template for every value
  it computes. A path that holds a reference the body passes on is
  written as a reference and carries the label of the reference, by the
  reference rule above.
- **The egress ceiling covers the content followed.** The templates of
  the request hold the label of a pointer where the request holds a
  reference, and the effect serializes the content. The ceiling is
  therefore checked on the join of the request's templates, instantiated,
  with what following the references of the request consumes. The
  transaction that checks the ceiling follows each reference as far as
  the built-in serializes it, which the **Request operands** paragraph of
  the built-in's entry states, and does not follow an operand that entry
  declares a reference
  ([Effectful built-ins](#effectful-built-ins)). Those reads belong to
  the check and not to the body: the label of the content reaches the
  ceiling and the effect's result, and does not reach what else the
  handler writes.
- **Which transaction checks.** For a request a handler makes, the event's
  transaction on the server. It is a check on what the handler itself
  stages, so a failure rejects the event's whole transaction. A client
  cannot make this check, because the ceiling of a sink is configuration
  of the serving runtime. For a request of the reactive tier, or of a
  pattern that a computation instantiates, the effect is an operation of
  the plan and a cone computes its request. The check is then made in the
  operation's own request transaction, when it reads the stored request. A
  failure rejects that transaction and no other: the request is not made,
  and the operation's result takes the refusal as an error state.
- **Run time:** the handling and the request's order within the
  invocation, which identify the boundary's state; the request's value.
- **Result:** a link to the boundary's result, pending in the requesting
  transaction.
- **Clients.** A client's speculative run of the handler stages the
  request and requests no effect. `navigateTo` is the one exception: a
  client enacts it from its speculative run of the event, in the handler
  or in a derivation that follows from it
  ([`navigateTo`](#navigateto)).

### Context reads

| Read | Observes | Labeled | Where the label comes from today |
| --- | --- | --- | --- |
| `eventKey()` | A string that names the event, its actor, and its stream | No | The comment in `builder/event-key.ts` calls it unlabeled runtime output that carries no trust |
| `currentPrincipal()` | The authenticated actor of the event | No | `Runtime.actingPrincipalFor`. `builder/current-principal.ts` notes that the value has no label saying who may see it |
| `principalOf`, `principalsOf` | The principals that claims of one kind in the target's stored label attest, and for a `represents-principal` claim whether the target's `name` holds a written name | Pointer labels only | The link chain to the target is followed by ordinary reads, so the pointers' labels join. The label metadata read adds nothing, because a claim's kind and subject are classified public; the function throws if that classification changes. The read of `name` is a verifier read (`builder/principal-of.ts`) |
| `profileOwnerOf` | Whose own profile the target is, by the rule of `profileOwnerAt` | As `principalOf` | The same reads, of the profile's label and name |
| `resultOwnerOf` | The address of the pattern result that the document a write to the target lands in belongs to, from the `result` back-link on that document. With a field, also whether that field of the owning result is the same document | Pointer labels only | The target is resolved to the document a write to it lands in, and with a field that field of the owning result is resolved, both by ordinary reads of links (`resolveLink` with `writeRedirect`), so the pointers' labels join. The read of the back-link is a verifier read (`internalVerifierRead` in `builder/result-owner-of.ts`), which takes no part in flow derivation. Setup writes the back-link and no pattern can write it |
| `linksOf` | The elements of a list as the cells its links name: the list's enumeration and each slot's identity, and no target | Yes | An ordinary read of the list's own document through a schema that reads each element as a cell (`builder/links-of.ts`) |
| `spaceOf` | The space the target's value lives in, after following links | Pointer labels only | Link resolution. Returns `undefined` while an `inSpace` name of the same run is unresolved |
| `spaceAccess`, `spaceMembers` | The acting principal's level in the space's access list; the list itself | Yes | A read of the space's access-list document through the call's transaction. The answer depends on who asks, so a computation's read scope narrows to the user (`ownCall` in `builder/space-access.ts`) |
| `spaceAccessOf` | A named principal's level in the access list | Yes | The same read; the answer does not depend on who asks |
| `spaceDeleted` | Whether the memory server refused this runtime the space as deleted | Yes, by the read that opens the space | The result is runtime state, from what the server answered (`runtime.spaceAccessWatch`), not a document. Every call also reads the space's access list through the call's transaction, which is what opens a space the runtime has not opened, and that journaled read carries a label (`spaceDeleted` and `aclOf` in `builder/space-access.ts`). The result is the same for every principal, so a computation's read scope stays as it is |
| `equals` | Whether two cells or values name the same cell, after the links both hold are resolved | Pointer labels only | Link resolution through the frame's transaction (`areLinksSame` in `runtime/runner/src/link-equality.ts`). No target is read |
| `equalLinks` | Whether two cells or values hold the same link as it is stored | Pointer labels only | No read at the call. The label is that of the reads that handed the body the two references (`equalLinks` in `runtime/runner/src/cell.ts`) |
| `getPatternEnvironment()` | A frozen `{ apiUrl }` | No | A constant of the runtime |

The records follow from the table, as `plan-and-label-templates.md` §3.16
lists them.

- An observation of a *resolved reference* (`spaceOf`, `equals`, and the
  operand of `principalOf`, `principalsOf`, `profileOwnerOf`, and the
  access-list reads): the `identity` slot of the operand with `resolved`
  set (its §2.5). The slot observes the reference where resolution ends,
  and its label joins the pointer label of every link followed on the way.
  `spaceOf(x)` is that slot of `x`, and `equals(a, b)` is that slot of
  each operand. No target is read.
- An observation of *enumeration and identity* (`linksOf`): the
  `enumeration` slot of the list and the plain `identity` slot of each
  element.
- An observation of a *stored reference* (`equalLinks`): the plain
  `identity` slot of each operand, not resolved. The call compares the two
  references as they are stored and follows no link, so nothing is
  journaled, in a function body as in the reactive tier.
- A read of *label metadata* (`principalOf`, `principalsOf`,
  `profileOwnerOf`): a `labelMetadata` slot on the resolved operand, as
  for `inspectConfLabel`.
- A read of a *space's access list* (`spaceAccess`, `spaceAccessOf`,
  `spaceMembers`, `spaceDeleted`): a `dynamic` node of kind `space` through
  the resolved `identity` slot of a cell operand, or, for `spaceDeleted`,
  through the `value` slot of an operand that names a space. Which space
  is read is data, so the read is journaled. `spaceAccess` and
  `spaceMembers` return a result for the acting principal, so an output
  that depends on them has the scope `user` (`Output.scope`, its §1.4).
  `spaceDeleted` returns the same for every principal. Its result is
  runtime state, and what its node stands for is the journaled read of the
  access list that the call makes. When the server's answer for a space
  changes, the runtime reports a change at the address of that space's
  access list, which makes a cone that asked stale.
- `resultOwnerOf`: the plain `identity` slot of the operand, and a
  `dynamic` node of kind `link` through it for the links the call follows.
  The slot is not `resolved`, because those links lead to the document a
  write to the operand lands in, and not to the cell that holds the
  operand's value. The read of the back-link contributes no label. The
  runtime journals it with the node's reads, so that a change of the
  back-link makes the cone stale, and leaves it out of the node's label.
  Whether a result that a pattern sees may come from a read that joins no
  label is with the project owner (the continuation plan, question 35).
  *Assumed:* it may, as today.
- A read of the *cause or the runtime* (`eventKey`, `currentPrincipal`,
  `getPatternEnvironment`): unlabeled today. `eventKey` and
  `currentPrincipal` are slots with the root `cause`, which carry no
  confidentiality, and `getPatternEnvironment` is `const`. The open
  question on nondeterministic inputs in `plan-and-label-templates.md`
  makes the same assumption for the clock.

**Static and journaled.** The records above are those of a call in the
reactive tier, and of a call in a function body whose operand is one
handle the body was given at a static place and which every run that
returns normally makes (`footprint-analysis.md` §7.2 and §8.4). Any other
call in a body is journaled, as the runtime records it today. The
operand's `identity` slot is then not `resolved`, the links the call
follows below the operand's reference are a `dynamic` node of kind `link`
through that slot, and an observation of label metadata joins the body's
`dynamic` node of kind `labelMetadata`: the label of that node is the join
of the labels of the observations the runtime recorded while the body ran.
A change of the label stored at an observed path makes the cone stale.
`equalLinks` has no journaled form, because it follows no link.

## Factory values

### Kinds that exist today

- **Pattern factories.** `PatternFactory`, made by `pattern` and derived by
  `asScope` and `inSpace`.
- **Module factories.** `ModuleFactory`, made by `lift` and `byRef`. Some
  built-ins are module factory values (`llm`, the fetch family,
  `navigateTo`, `compileAndRun`, `agent`, `generateText`, `generateObject`,
  `streamData`, `cellFromUrl`, `sqliteDatabase`, `sqliteQuery`). Others are
  plain functions that wrap a factory and are not factory values (`ifElse`,
  `when`, `unless`, `str`, `wish`, `anchorsOf`, `inspectConfLabel`).
- **Handler factories.** `HandlerFactory`, made by `handler`. A *bound*
  handler is not a factory: it is a stream, shipped as an ordinary link.
- **Tool descriptors.** `patternTool` returns `{ pattern, extraParams }`, the
  only partially applied pattern value today.

Every verified module-scope factory is addressable by a content-addressed
`{ identity, symbol }` pair
([content-addressed action identity](../content-addressed-action-identity.md)).
Serialization is one-way (`patternToEncodableForm` and
`moduleToEncodableForm` in `builder/to-encodable-form.ts`): a pattern becomes
a `$patternRef` with its schemas, and a module becomes a descriptor. No
generic read turns the stored form back into something callable. Three
readers do so for their own purposes: the list built-ins for `op`
(`resolveOpPattern` in `builtins/op-pattern-ref.ts`), the language-model
built-ins for tools, and the harness for function implementations. A factory
read from a cell in a handler or lift body is therefore plain data and
cannot be called. The first-class factory design
([node factory shipping](../pattern-construction/node-factory-shipping.md))
supplies callable factory values. Its
[implementation plan](../../plans/first-class-serializable-factories.md) is
carried out by pull request #4687 in this repository, which is not merged.

### What a function body may call

A function body may use two kinds of factory value: a pattern factory, which
it instantiates, and a handler factory, which it binds to state to obtain a
stream. Every kind of function body may do both, a `lift` and a `computed`
included. Module factories are not callable as values: an imported function is
called as a function, and inside a function body a lifted function is an
ordinary call with no reactivity, so a module factory value would add
nothing a function value does not. Built-ins are not factory values at all;
an effect request names its built-in statically, so that the compiler knows
the boundary's declared label rule.

Pattern closures replace `patternTool`: the bound parameters become
captures of an inline pattern, private to it, so a model that is given the
closure as a tool supplies the public input only. Pattern factory values
also give `compileAndRun` an ordinary reading: compilation returns a pattern
factory value, and the author instantiates it. The corpus has no source
site that calls or binds a received factory in a body (by reading; it needs
types to confirm), so nothing has to be rewritten.

### Binding a handler received by reference

A handler factory value is a handler passed by reference: the receiver
chooses the state and binds it.

- **What the binding site knows statically.** The factory's declared type:
  the event type and the state type. The compiler checks the bound values
  against the state type, records for each path of the state whether it is
  copied or bound by reference
  ([A handler binding made in a body](#a-handler-binding-made-in-a-body)),
  and knows the type of the stream the binding yields. It does not know
  which handler will arrive, so for a container the body computed it
  copies the paths the declared state type covers.
- **What is resolved at run time.** The factory value names a handler by
  content address. The handler's own compiled record supplies the rest: its
  footprint over state and event, its write edges, and its body identity,
  which is the identity a write policy names when it lists a permitted
  writer by `typeof` a handler.
- **Identity of the binding.** For a binding made in a function body, the
  stream's identifier derives from the enclosing instance, the handler's
  content address, and what the binding holds: the copied values, salted,
  the identities of the linked cells, and the addresses of the containers
  bound by reference. A site that receives a different handler therefore
  binds a different stream, and two sites that bind the same handler to
  the same state are one stream. Which stream exists reveals which handler
  arrived, so the label of the slot that holds the factory joins the
  identity label of the stream (`plan-and-label-templates.md` §3.21).

Three things are hard about it, and they are the cost.

- **Factory values have to exist as values.** Today a handler factory
  serializes one way, to a module descriptor, and no read turns the stored
  form back into something that can be bound (`moduleToEncodableForm` in
  `builder/to-encodable-form.ts`). The first-class factory design supplies
  a durable factory value, and its
  [implementation plan](../../plans/first-class-serializable-factories.md)
  is carried out by pull request #4687, which is not merged. That work is a
  prerequisite. In this design only pattern and handler factories are
  values; a module factory made by `lift` is not one. Holding a factory
  value reveals which code a party chose, so the value has a label:
  `plan-and-label-templates.md` §3.21 observes the slot that holds a
  handler factory for identity and joins its label into everything the
  bound handler writes and into the identity label of the stream, as
  §3.15 does for what is read from a child instance of a pattern factory
  value.
- **Checks move from compile time to run time at that site.** For a
  named handler the compiler checks, against the plan, that every path the
  handler writes is one its bound state permits and that it satisfies each
  write policy naming it. For a received handler neither the write edges
  nor the body identity is known when the binding site is compiled.
  `plan-and-label-templates.md` §3.21 says when each check then runs. The
  fit of the handler's event and state schemas to the declared ones is
  checked when the binding is made, and a misfit is a run-time refusal of
  the binding. The writer policy of a written path is checked when the
  handler writes, against the body identity its record resolved to, and a
  write its record does not list is refused when it is attempted. The
  author sees each of these later than a compile error. The footprint is
  known only when the binding is made as well, so the labels of what the
  handler writes come from its own record and cannot be summarized in the
  enclosing plan.
- **The receiver grants write access to code it did not name.** Binding a
  received handler to the receiver's cells lets another module's code write
  them, within the state type. Instantiating a received pattern with cells
  as arguments grants the same, so this is not a new kind of grant, but for
  a handler it is the whole purpose. A gate such as FabriChat's send gate
  is unaffected: it names permitted writers by identity, and a received
  handler that is not listed fails the check when it writes.

### A pattern factory value in the reactive tier

A call to a pattern in the reactive tier has two readings, decided by what
the compiler can resolve.

- **A statically resolved callee** (a pattern imported by name, declared in
  the module, or written inline) is compiled into the surrounding instance.
  It has no plan of its own: its slots, bodies, and cones are entries of the
  enclosing plan, and it has no result cell.
- **A callee that is a value of a pattern factory type** (a parameter, a
  field of the argument, the result of an effect such as compilation)
  cannot be compiled in, because which pattern it is depends on data. It is
  a *child instance* with its own plan, resolved at run time, and a result
  cell of its own.

For the second the enclosing plan records:

- the call site, which is the identity anchor: the child's result cell is
  named from the enclosing instance and the site, and keeps that name when
  the factory value changes, so that the replacement instance takes the
  place of the old one. The
  [factory plan](../../plans/first-class-serializable-factories.md) (stage
  2) makes the same choice for its dynamic factory node;
- the slot that holds the factory value, observed for identity: which
  pattern runs is a function of that slot, so the slot's label joins the
  label of everything read from the child;
- the argument binding, one template per argument path, checked against
  the argument schema of the factory's declared type;
- the result schema of the factory's declared type, with the labels it
  declares, which is all the compiler knows of the child's outputs. A read
  of a child output is recorded as a slot with the root `child`, at a path
  of that declared schema, and resolves to the label stored at that path
  of the child's result, like any slot (`plan-and-label-templates.md`
  §3.15);
- the element key, when the site is inside a collection body.

The child's own labels come from its own plan and are instantiated by the
runtime as for any instantiated pattern. When the factory value changes,
the old child is torn down and a new one started at the same name.

## Summary

Classes: A structural, B effectful, C authoring marker, D removed. A cell
with two letters splits.

### Registered built-ins

| Built-in | Class | Scheduler today | Server placement today | Durable state |
| --- | --- | --- | --- | --- |
| `ifElse` | A (callable form removed) | computation | structural, speculated | link store per node |
| `when` | A (callable form removed) | computation | structural, speculated | link store per node |
| `unless` | A (callable form removed) | computation | structural, speculated | link store per node |
| `str` | A (tag removed) | computation | not placed | none |
| `map` | A | computation | structural, speculated | container, instance per element |
| `filter` | A | computation | structural, speculated | container, instance per element |
| `flatMap` | A | computation | structural, speculated | container, instance per element |
| `aggregate` | A | computation | not placed | result store, fold tree |
| `aggregateNode` | D (internal to `aggregate`) | computation | not placed | fold state per tree node |
| `collectionIndex` | A | computation | not placed | index and membership documents |
| `collectionIndexMember` | D (internal) | materializer | not placed | writes the shared index |
| `collectionIndexKeys` | D (internal) | computation, deferred until demand | not placed | none |
| `anchorsOf` | A | computation | not placed | none |
| `inspectConfLabel` | A (kernel operation) | computation | structural, speculated | result store |
| `fetchBinary` | B | computation | server only | request hash, claim, result |
| `fetchText` | B | computation | server only | request hash, claim, result |
| `fetchJson` | B | computation | server only | request hash, claim, result |
| `fetchJsonUnchecked` | B | computation | server only | request hash, claim, result |
| `fetchProgram` | B | computation | server only | cache keyed by request hash |
| `streamData` | D | computation | disabled | none durable |
| `llm` | D (use `generateText`) | computation | server only | request hash, result |
| `generateText` | B | computation | server only | request hash, result |
| `generateObject` | B | computation | server only | request hash, result, conversation |
| `llmDialog` | B (a built-in pattern) | materializer | server only | transcript, claim, pinned cells |
| `agent` | B | computation | server only | request hash, run record |
| `sqliteQuery` | B | computation | server only | state document, row documents |
| `sqliteDatabase` | C (state cell declaration) | computation | not placed | handle |
| `navigateTo` | B (client-enacted) | effect | server computes, client enacts | latch, intent |
| `compileAndRun` | B + instantiation | computation | server only | request hash, phase, child instance |
| `cellFromUrl` | A + B | computation | not placed | pending flag, link |
| `wish` | A | computation, debounced | structural with exceptions | state store, sidecars, clock |

The table has one row per `addModuleByRef` call in `registerBuiltins`, 31 in
all.

### Authoring surface

| Entry | Class |
| --- | --- |
| `pattern`, `handler`, `action`, `computed`, `lift`, `assert`, inline JSX handlers, JSX | C |
| `asScope`, `inSpace` | C (instantiation modifiers) |
| Cell constructors, scoped constructors, `.for(...)` | C |
| `map`, `filter`, `flatMap`, `reduce`, `findIndex`, `some`, `every`, `find`, `count`, `sum`, `min`, `max`, `minBy`, `maxBy`, `groupBy`, `keyBy`, `lookup`, `keys`, `keyEntries` | A |
| The eight `WithPattern` methods | D |
| `db.query` | B |
| `SqliteDb.exec` | a cell write |
| `eventKey`, `currentPrincipal`, `principalOf`, `principalsOf`, `profileOwnerOf`, `resultOwnerOf`, `linksOf`, `spaceOf`, `spaceAccess`, `spaceAccessOf`, `spaceMembers`, `spaceDeleted`, `equals`, `equalLinks`, `getPatternEnvironment` | context reads |
| `grantSpaceAccess`, `revokeSpaceAccess` | B (steps of the event's commit) |
| `nameBlob` | B (a document staged in the event's transaction, with no transactions of its own) |
| `uiVariant` | unchanged, a pure function |
| `patternTool`, `byRef`, `nameInstance`, `cell` | D |
| Every transformer-emitted form | D |

### Counts

Of the 31 registered built-ins: 12 are class A, 12 are class B, 1 is class
C, 5 are class D, and 1 splits across classes (`cellFromUrl`).
`compileAndRun` is counted in B, with its instantiation half an ordinary
instantiation.

## Decisions

The project owner has decided the following, except where an entry says
that it is stated by the documents and is not a ruling. The rulings are
those of the "Decided" list of the
[continuation plan](../../plans/compiled-pattern-language.md). The entries
above already reflect them.

- **Calls in function bodies.** Five kinds are legal: instantiating a
  pattern, creating a cell, requesting an effectful built-in, reading
  context, and binding a handler. Staged access changes and `nameBlob` are
  effect requests.
- **Which body may instantiate a pattern and request an effect.** A
  `handler` or an `action` may do both, and so may the pattern body. A
  `lift` or a `computed` may instantiate a pattern, and that pattern may
  request effects. An evaluation that instantiates the same pattern at
  the same place names the same instance and updates its argument, an
  instance that an evaluation no longer makes is torn down, and an effect
  in the instance is requested again when its request changes. Such an
  instance is identified by the enclosing instance, the body's name and
  the calls and callbacks it is written in, the site, and the ordinal of
  the instantiation among those the evaluation makes at that site, or by
  an explicit cause where the author writes `.for(cause)`. A `lift` or a
  `computed` does not request an effect directly. The compiler warns on
  an instantiation inside a loop or a callback in a function body that
  has no `.for(cause)`.
- **Factory values.** A function body may instantiate a pattern factory
  value and bind a handler factory value. Module factories are not callable
  as values.
- **The label of a factory value.** The slot that holds a factory value is
  observed for identity, because which code runs is a function of it. For
  a handler factory its label joins everything the bound handler writes
  and the identity label of the stream (`plan-and-label-templates.md`
  §3.21). For a pattern factory it joins every template that reads the
  child instance (§3.15). This entry is stated by that document and is
  not a ruling of the project owner.
- **What a handler binding holds.** A binding made in the reactive tier
  copies nothing, the body of a per-element callback included: every path
  of the handler's state is a slot or an output of the instance. A binding
  made while a function body runs copies a scalar and a container the
  body computed. It binds a cell handle, and a container that has a
  stored address, by reference: the handler reads the container when an
  event arrives, and a record the handler passes on links to the
  original. The identity of such a binding takes the address of a
  container bound by reference, so two bindings to equal records stored
  in two places are two streams.
- **A collection method on a cell handle in a function body is a compile
  error.** The compiler does not rewrite the call to a reactive form. The
  diagnostic names two corrections: an inline `pattern(...)`, which keeps
  the expression reactive and is legal in every function body, or
  `get()` first, which processes the values synchronously.
- **The callable conditionals and the `str` tag are removed.** The compiler
  may accept them for an interim period with a warning, only if that costs
  it nothing beyond mapping each to the operation of `?:`, `&&`, `||`, or a
  template literal.
- **`reduce`, `findIndex`, `some`, `every`, and `find` are reactive
  constructs.** The callback of `reduce` is restricted to an expression.
  `findIndex`, `some`, `every`, and the choice made by `find` join the
  prefix up to the deciding element and nothing after it.
- **Element keys.** A plain value is keyed by its value, anything else by
  the identity of its cell, and the index joins the key only when the
  callback uses it. Stored per-element state need not stay compatible.
  A body over plain values that declares a state cell without using the
  index is an error. A body over plain values that binds a handler and
  declares no state cell is accepted: equal elements bind equal state and
  share one stream. Where a body over plain values instantiates a child,
  the position joins the element key, so two equal plain elements have
  two children.
- **Ties among equal keys.** `minBy`, `maxBy`, and a keyed lookup break a
  tie by the first position in the source order of the collection, and
  not by the smallest element key.
- **Value-derived identifiers are salted** with a secret of the space. A
  client cannot read the salt. It cannot name per-element state whose key
  holds a value, or a binding with a copied path, before the server stores
  a link.
- **`inSpace` identifiers are known before the cross-space commit.** The
  identifier of the instance is derived. The identifier of a space the
  request creates is obtained and not derived from the request, and the
  allocation is recorded in a step that commits before the step in the
  foreign space, so that a retry names the same space.
- **`wish` is structural.** What it creates, it creates idempotently, and
  the result reads as if the data had already existed.
- **`streamData` and `llm` are removed.**
- **`navigateTo` requires a result cell,** so an instance that is only
  navigated to is an instantiated pattern. This entry is stated by this
  document, from what `navigateTo` does today, and is not a ruling of the
  project owner.
- **`navigateTo` is the one effect a client enacts.** A client enacts it
  from its speculative run, reconciled with the server's result as it is
  today. A client requests no other effect.
- **Identifiers.** Cells and instances created in a handler with no
  explicit cause need no stable identifier beyond the invocation, since
  each invocation is a new frame. They derive from the handling, which is
  identified by its receipt, and the receipt leaves the acting principal
  out. Patterns and lifts need identifiers that are the same on every
  evaluation.
- **An explicit cause in a handler** names the same thing across events.
  A cell that a handler creates under an explicit cause is the same cell
  on every event, an instance requested with `.for(tag)` is the same
  instance on every event, and the existence label of each is fixed at
  first creation.
- **A pattern closure given to a language model as a tool.** The argument
  the model supplies carries the label of the generation that produced
  the tool call. The result of the call carries the label of the
  instance's own result.
- **What a language-model built-in sends after its request.** The egress
  ceiling is checked again on each send: a tool-loop result sent back to
  the model, a system prompt rendered again from live context, and each
  send of a dialog's live transcript. A send that fails the check is not
  made, and the built-in's result takes the error state.
- **A handler's pending effect after a restart.** The request is made
  again at activation, with the references followed and the egress
  ceiling checked on the content as it is then.
- **A failed constraint.** One on what a handler itself writes, the egress
  ceiling of a request the handler makes included, rejects the event's
  whole transaction. One on a derived write, such as the argument a
  computation writes for an instance it makes, drops that write alone:
  the target keeps what is stored, and the rest of the transaction
  commits.
- **`asScope` and `inSpace`** are part of the instantiation syntax. This
  entry is stated by the documents (`language-subset.md` §4.4 and
  `plan-and-label-templates.md` §3.14) and is not a ruling of the project
  owner. Where the two modifiers are legal is open in two cases: on a
  statically resolved callee in the reactive tier (the continuation plan,
  question 17) and on an instantiation in a computation (its question
  50).
- **Migration is out of scope** for this document.

## Open questions

Each question states the assumption this document made. A question that is
with the project owner names its entry in the
[continuation plan](../../plans/compiled-pattern-language.md).

1. **`inspectConfLabel` on a value that is not kept.** The three reads
   this inventory found outside the four observation classes are placed by
   `plan-and-label-templates.md` §2.4: truthiness as `value` or `shape`,
   a followed pointer as `identity`, and label metadata as a fifth class.
   An interim value has no stored label. *Assumed:* inspecting one reads as
   `notAvailable`, the compiler reports it where it can see it, and
   inspecting a value does not make it kept.
   `plan-and-label-templates.md` §3.16 has the other reading, in which the
   operation reads the label the value's template instantiates to. The
   choice is with the project owner (question 30 of the plan).
2. **How `wish` is spelled.** `wish` stays one structural operation.
   Whether the compiler requires a constant query, so that it can tell a
   path from a search from a clock at compile time and give each its label
   rule, is undecided. *Assumed:* a constant query gets the precise rule,
   and a computed query gets the join of all of them. In the record of
   `plan-and-label-templates.md` §3.19 the label has one form for both,
   the operands joined with the reads the resolution made. A constant
   query lets the compiler leave out the user scope, the state cell of
   the clock, and the sidecars the query cannot reach, and a computed
   query has all of them (its question 48).
3. **Access changes and the cross-space commit.** An `inSpace`
   instantiation commits across the child's space and the parent's
   (`enableCrossSpaceChildCommit`). A staged access change commits as a
   commit of the list alone, ahead of the handler's writes: on a client
   before the handler's transaction commits, and on a serving runtime as
   the first step of the wave's commit
   ([Staged changes](#staged-changes)). `scheduler-and-serving-loop.md`
   §9.4 proposes one ordered sequence for both, which is not atomic. It
   has five steps: the genesis commit of each space a request creates,
   the allocation record of each such space, the staged access changes,
   the batches for other spaces, and the home writes. The record of a
   space that an `inSpace` request creates has its place in that
   sequence by ruling: it commits before the step in the foreign space.
   The sequence itself is with the project owner (question 15 of the
   plan). *Assumed:* that sequence, with the access changes third, ahead
   of every batch of writes and of the home writes.
4. **The label of a factory value.** Not open.
   `plan-and-label-templates.md` §3.21 and §3.15 state it, the identity
   label of a stream bound from a received handler included, and it is
   listed under [Decisions](#decisions). The entry keeps its number
   because other documents cite the entries after it by number.
5. **Knowing statically that elements are plain values.** The error for
   a state cell over plain values needs the compiler to know whether a
   collection's elements are stored inline or as links. A primitive element
   type is always inline. A record element type is a link when a handler
   wrote the list, or when a computation passed the records on unchanged,
   and inline when a computation built the records, and the type does not
   say which. `language-subset.md` §4.4.1 decides it statically, from the
   element type and from where the collection comes from: a record-typed
   collection is plain where the program built its records, which for the
   result of a body is where the body's record has no reference at the
   element path, and not plain when it is read from the pattern's input
   or from a cell. The case
   that rule cannot decide is a stored array that holds inline records
   because a computation elsewhere produced it. *Assumed:* the runtime
   puts the element's cone in an error state there, as
   `plan-and-label-templates.md` §1.3 says, so that sharing never happens
   without notice.
6. **Tool calls as instantiation.** A model tool call instantiates a
   pattern with a result cell whose cause is an identifier the model
   supplies, and the dialog's built-in tools let a model read, invoke, and
   write whatever it can name by link. The labels of the argument and of
   the result of a pattern closure, and the check of each send, are
   decided ([Effectful built-ins](#effectful-built-ins)). Four things are
   left, and the first three are stated under "The instance of a tool
   call" there. *Assumed:* the identifier of the instance derives from
   the built-in's operation, the request or the turn, the ordinal of the
   model call, and the position of the tool call, and not from the
   identifier the model supplies. *Assumed:* the instance is made in the
   space of the built-in's operation, at the scope of the built-in's
   result. *Assumed:* it is torn down when the request or the turn that
   made it settles. *Assumed:* what the dialog's built-in tools may read,
   invoke, and write is out of scope for the language and is specified
   with the model boundary's declared rule.
7. **Value checkpoints for `reduce`.** *Assumed:* none in the baseline; the
   fold is recomputed, and only its label is maintained incrementally.
8. **`sqliteDatabase` identity.** Its handle is keyed on the whole cause,
   including the inputs document, so changing the table declarations names
   a different handle today. *Assumed:* its identifier derives from the
   variable it is assigned to, as a state cell's does. The plan records
   the declaration as an `Operation` with no request, which has a `name`
   and `within` steps for that purpose (`plan-and-label-templates.md`
   §1.1).
9. **Document inconsistencies found.** They do not affect the design and
   are recorded for correction where the documents are owned:
   - the server-execution documents call the fetch family `fetchData`,
     which is not an exported name;
   - [built-in contracts](../server-side-execution/builtins.md) §2 says
     the SQLite built-in enqueues its effect by hand, and the code uses the
     sink-request seam;
   - neither server-execution document places `str`, `aggregate`, the
     collection-index family, `anchorsOf`, `cellFromUrl`, or
     `sqliteDatabase`;
   - `cancelGeneration` is declared on the state types of the one-shot
     model built-ins in `base/api/index.ts` and is not implemented by them;
   - a comment in `sqliteQuery` says the recorded request holds what goes
     to the provider and not the handle's table declarations, and the
     provider is sent those declarations as well.
10. **Context reads in the pattern body.** `language-subset.md` §4.4 leaves
    to this document which context reads the pattern body may make. Three
    entries are stated elsewhere: `language-subset.md` §10.3 refuses
    `eventKey` and `currentPrincipal` there, its §4.7 lists `equals` for
    the reactive tier, and `getPatternEnvironment` is legal in every frame
    today. *Assumed:* every other context read is legal in the pattern
    body, as it is in a `lift` or a `computed`. Today each of them throws
    in a pattern body
    ([Which body may make which call](#which-body-may-make-which-call)).
    The records the assumption needs exist: `plan-and-label-templates.md`
    §3.16 gives the record of each call in the reactive tier, and its §1.4
    records in `Output.scope` that an output which depends on
    `spaceAccess` or `spaceMembers` is scoped to the user. What is left is
    the legality itself, which is with the project owner (question 32 of
    the plan).
11. **An instance made in a `lift` or a `computed`.** How the instance
    is identified, and that a `lift` or a `computed` does not request an
    effect directly, are decided
    ([An instantiation request from a `lift` or a `computed`](#an-instantiation-request-from-a-lift-or-a-computed)).
    One thing is left. *Assumed:* `inSpace` and `asScope` are legal on
    the callee of such an instantiation, as they are today and as in a
    handler, which is question 50 of the plan.
12. **`.for(tag)` on an instantiation in a handler.** Not open. The tag
    names the same instance on every event
    ([An instantiation request from a handler](#an-instantiation-request-from-a-handler)),
    and the rule is listed under [Decisions](#decisions). The entry keeps
    its number so that the entries after it keep theirs.
13. **Ties among equal keys.** Not open. A tie goes to the first position
    in the source order ([Element keys](#element-keys)), and the rule is
    listed under [Decisions](#decisions). The entry keeps its number so
    that the entry after it keeps its own.
14. **A state cell in a body whose key holds the position because the
    body instantiates a child.** Where a body over plain values
    instantiates a child, the position joins the element key
    ([Element keys](#element-keys)). The error for a state cell over
    plain values is stated for a body that does not use the index, and
    such a body can instantiate a child without using the index.
    *Assumed:* its state cell is accepted, because the position is in the
    key and no two positions share the cell. The other reading keeps the
    error wherever the source does not use the index. The question is
    with the project owner (`plan-and-label-templates.md` §8, question
    34, which makes the same assumption).
