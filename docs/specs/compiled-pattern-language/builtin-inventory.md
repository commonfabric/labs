# Built-in inventory (proposed)

**Status:** proposed. This document details one part of the
[compiled pattern language](README.md). It lists every built-in and every
factory that an author or the transformer can call, states what each one does
as implemented, and says what each becomes in the compiled design. The
project owner's rulings on the classification are listed under
[Decisions](#decisions), and what remains undecided under
[Open questions](#open-questions).

Two sibling documents specify the neighboring parts. This document refers to
them by file name and does not define their content:

- `language-subset.md`: the grammar, type rules, and diagnostics;
- `plan-and-label-templates.md`: the plan format, slots, observation classes,
  and the formal label rule of each operation. Each "Label rule" paragraph
  below states the facts that document needs, informally.

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
- **Reads:** what is read and how. The overview's four observation classes are
  used: *value*, *shape*, *enumeration* (length or key set), and *identity*
  (a link is resolved and its target is not read). The entry also names the
  read markers the implementation applies, all from
  `storage/reactivity-log.ts`:
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
  the store carries the condition's label and the pointer's, and neither
  branch's content label. A reader that follows the reference consumes the
  selected branch's label at that point. No integrity is minted.
- **Execution:** pure structural: served, and speculated by clients.
  Computation; replayable.
- **New design:** class A. The conditional expressions `?:`, `&&`, and `||`
  are reactive constructs of the language, and the callable forms are
  removed. Nothing here is effectful, and the store exists only to hold a
  link.
- **Label rule:** the output's slots are the condition slot plus the slots of
  the selected operand, as the overview states for conditionals. Three facts
  refine it.
  - The condition is observed for *truthiness at the root*. For a record or
    array condition that is weaker than a value read of the subtree. The
    plan needs either a fifth observation class or a statement that
    truthiness is a value observation of the root path only.
  - For `&&` and `||`, one arm *is* the condition. When that arm is selected,
    the output carries the condition's full value slots, not only its
    truthiness.
  - The output is a reference to the selected operand, not a copy. A default
    declared on the selected operand's schema reaches readers of the result.
    The compiled form must keep that behavior or the type rules must make it
    unobservable.

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
  its favor, since the two differ only in spelling.
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
    uses the index, and on the whole input only when the body uses the array
    argument.
  - Membership of the output equals membership of the input (enumeration and
    slot identity). Holes are preserved.
  - Element cones are keyed by element identity plus occurrence for linked
    elements and by position for inline values. A state cell created in the
    body derives its identifier from that key. `language-subset.md` and
    `plan-and-label-templates.md` must keep this key, since stored
    per-element state depends on it.
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
  - The plan needs a way to say which input element an output position came
    from, since the mapping is data-dependent.

### `aggregate` and `aggregateNode`

- **Source:** `builtins/aggregate.ts` (`aggregate`, `aggregateNode`),
  `builtins/aggregate-sum.ts`, `builtins/aggregate-extremum.ts`. Reached
  through the cell methods `count()`, `sum()`, `min()`, `max()`,
  `countWithPattern`, `minByWithPattern`, and `maxByWithPattern`
  (`createAggregate` in `runtime/runner/src/cell.ts`). The predicate and
  selector forms first run `mapWithPattern` and aggregate its output.
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
  - `minBy(selector)`, `maxBy(selector)`: the membership of the input and
    the selector's value for every element decide *which* element is
    referenced. The output is that element (identity), so its content slots
    are the winning element's own.
  - State to store: the fold. The plan must say whether the fold's shape is
    part of the plan or private to the runtime, and it must fix the tie
    rules (`chooseAggregateCandidate`) and the exact-sum semantics, because
    value code on the client and the server must agree.

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
  - In `key` mode the winner among equal keys is decided by element identity,
    so no element value beyond the key flows into the choice.
  - State to store: the index and the membership bookkeeping.

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
  did not declare, so the plan must list that document among the instance's
  static write targets.

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
  on the *label metadata* of the target at that path. That is an observation
  class outside the overview's four. In the compiled design a kept output's
  label comes from its template, so the plan must say whether this operation
  reads the stored label of a kept output, the instantiated template of an
  output that is not kept, or only the former.

## Effectful built-ins

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
- **New design:** class B.
- **Label rule:** the request slots are the values of `url`, `options`, and
  the schema. The egress check applies the join of exactly those slots to
  the sink's ceiling, which is tighter than the transaction-wide check. The
  result's confidentiality is the join of the request slots; a declared
  schema may add constants. Integrity is whatever the boundary declares for
  the network origin, which today is nothing. `pending` and `error` carry
  the request label too, since both reveal that the request was made. State
  to store: the request hash, the claim, and the settled result or error.

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
- **New design:** class B. `llm` is class D, replaced by `generateText` and
  `generateObject`, which its deprecation already says.
- **Label rule:** the request slots are every parameter read by value, the
  value of every context cell, and the tool catalog. The result's
  confidentiality is the join of the request slots; its integrity is the
  declared `LlmDerived`. The rule for results after a tool loop must add
  what the tools returned, which is data-dependent: it belongs to the
  boundary's own transactions, not to a template. State to store: the
  request hash, the settled result or error, and, if a tool loop is to
  survive a restart, the conversation.

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
- **New design:** class B.
- **Label rule:** as `generateText`. The result has per-path labels declared
  by the result schema, so the boundary's declared rule is per output path.
  The request that leaves must be the snapshot that was checked; the rebuild
  after commit is a defect the boundary's contract should exclude.

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
- **CFC:** sink `llmDialog`, ungated as above. Model messages are stamped
  `LlmDerived`; user messages and error literals are not. Before a tool call
  two gates run: the tool's declared maximum confidentiality against what
  the model has observed (`toolAllowsObservedConfidentiality`), and in
  enforcing modes the target's required integrity against the model-supplied
  input (`toolInputRequiredIntegrityFailure`).
- **Execution:** effectful: server only. A computation that is a
  materializer; not replayable. It reads the clock and generates random
  identifiers.
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
- **New design:** class B.
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
- **New design:** class B. It is the model for a declared label rule at a
  boundary, because it already has one.
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
- **New design:** class B, as a client-enacted effect.
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

## Declarations that produce cells

### `sqliteDatabase`

- **Source:** `builtins/sqlite-builtins.ts` (`sqliteDatabase`).
- **Does:** publishes a handle `{ id, tables, scope, owner, rev }` for a
  database. It does not create the database file.
- **Reads:** its options by value, and its own prior output. It also reads
  the acting principal, which is ambient.
- **Writes and state:** one handle cell with cause
  `{ sqliteDatabase: { result: cause } }` at the author-declared scope. The
  `owner` is minted once from the acting principal of the first run and
  never changed. Table labels merge grow-only across re-derivations
  (`growOnlyMergeDbTables`).
- **CFC:** the handle carries the per-column label declarations that queries
  and writes later enforce.
- **Execution:** computation; listed as replayable although it reads ambient
  identity and its own prior output.
- **New design:** class C. It declares a state cell of kind SQLite, in the
  same family as the cell constructors below: it receives a causal
  identifier, is written when first assigned, and has no request. Its
  identifier must not depend on the inputs document, so that a change to the
  table declarations does not name a different database.
- **Label rule:** none of its own. The table declarations are constants of
  the plan. The `owner` is state written once.

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
| `handler(fn)` | Mints a `javascript` module with `wrapper: "handler"` (`handlerInternal` in `builder/module.ts`). Applying the factory to its state creates a stream and a node, and returns the stream. | C. Binding a handler to state is a construct of the reactive tier. |
| `action(fn)` | Throws at run time. The transformer lowers it to `handler(fn)(captures)` (`base/ts-transformers/src/closures/utils/capture-scaffold.ts`). | C. A handler whose state is its captures. |
| `computed(fn)` | The transformer lowers it to `lift(fn)(captures)` (`base/ts-transformers/src/lift/transformer.ts`). | C. Promoted to the reactive tier when its body is a pure expression. |
| `lift(fn)` | Mints a `javascript` module factory; calling the factory creates a node. | C. |
| `assert(fn)` | A `javascript` node that returns `{ ok, source, parts }`; used by pattern tests. | C. |
| Inline JSX event handlers | The transformer lowers `onClick={() => ...}` to a handler with captures. | C. |
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
    while the order of creation is stable.
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
  - A handler invocation is a new frame for each event, so every cell it
    creates is new. An identifier from the event and a per-invocation
    counter is sufficient, and a handler needs no explicit cause.
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
| `reduce(fn, initial)`, `findIndex(fn)` | Mint a `lift` inline and apply it to the cell, so they throw inside a running action and the lift has no content-addressed identity. | D. An ordinary array method inside a `computed`, or a reactive expression where the compiler supports one. |
| `db.query(sql)` | Creates a `sqliteQuery` node. | B: sugar for `sqliteQuery`. |
| `key(...)`, `asSchema(...)`, `get()`, `set(...)`, `push(...)`, `send(...)`, and the other transactional methods | No node. | Cell operations, specified by `language-subset.md`. |

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
| `getPatternEnvironment()` | anywhere | A frozen `{ apiUrl }` (`builder/env.ts`). |

- **New design:** context reads are a fourth kind of call that is legal
  inside a function body, beside the three the overview names. Each has an
  entry in the body's footprint so that its label is accounted for.
  `principalOf` and its siblings observe label metadata, the same
  observation class as `inspectConfLabel`. The space functions read
  access-list state. `eventKey` and `currentPrincipal` are properties of the
  cause.

### Staged changes

| Name | Legal in | Does |
| --- | --- | --- |
| `grantSpaceAccess(target, principal, level)`, `revokeSpaceAccess(target, principal)` | handler | Stage a change to a space's access list on the handler's frame. The staged changes commit as a commit of their own ahead of the handler's writes (`settleSpaceAccessChanges` in `builder/space-access-change.ts`; [space access changes](../../features/space-access-changes.md)). |
| `nameBlob(target, blobId, name)` | handler | Names a blob (`builder/blob-name.ts`). |

- **New design:** class B. Each is an effect requested from a handler whose
  result the handler does not read. The access changes exist as a separate
  commit because a transaction covers one space and an access list belongs
  to a space of its own. Two shapes are possible: keep the separate commit
  ahead of the handler's transaction, or make it one case of a general
  two-step commit across spaces, which instantiation with `inSpace` also
  needs. See open question 3.

### Tool and factory helpers

| Name | Today | New design |
| --- | --- | --- |
| `patternTool(pattern, extraParams?)` | Returns the plain descriptor `{ pattern, extraParams }`; no node. A model built-in instantiates the pattern at tool-call time. | D. Replaced by a pattern factory value that closes over the bound parameters, as the factory plan's stage 4 already intends. |
| `byRef(name)` | A factory for a registered built-in by name. Not used in the pattern corpus. | D. Built-ins are not addressed by name from authored code. |
| `uiVariant(piece, kind)` | Returns a view node for `cf-render`; no graph node. | Unchanged; a pure function. |
| `nameInstance(value, name)` | Records an instance name consumed by `factoryFromPattern`; emitted by the transformer only with the `instanceNames` option. | D. The compiler records instance names in the plan. |

### Pure functions and constants

The remaining exports create nothing and read no frame. They are unaffected
by the design and are listed so that the inventory is complete: `equals` and
`Cell.equals`, `valueEqual`, `schema`, `getEntityId`, `entityRefToString`,
`renderCellReference`, `isWellFormedDID`, `parseDID`, the debug formatters
(`toCompactDebugString`, `toIndentedDebugString`, `debugStr`), `dataFile`,
`table`, `cfLink`, the `cfSqlite` helpers, the Fabric value classes,
`AuthSchema`, `WebhookConfigSchema`, `multiUserTest`, and the label
vocabulary of `commonfabric/cfc` (`cfcAtom`, `cfcPattern`, `exchangeRule`,
`exchangeRules`, `v`, and the constant tables in `base/api/cfc.ts`).
`equals` compares identity and so observes identity only; the footprint
analysis should know that.

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
| `__cfHelpers.tagCollectionKey(value)` | The selector result of `groupBy` and `keyBy` | Part of the index operation |
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

The overview keeps three kinds of runtime call inside the body of a `lift`,
`handler`, `computed`, or `action`: instantiating a pattern, creating a cell
with a causal identifier, and requesting an effectful built-in. This section
measures the pattern corpus against that rule.

### Method

A script parsed every TypeScript file under `patterns/` and attributed each
call to its innermost enclosing body. A body is the function argument of a
call to `handler`, `action`, `lift`, or `computed` imported from
`commonfabric`, or an inline JSX event handler. Calls in plain helper
functions were followed through a call graph over same-file and relative
imports. The analysis resolves names and does not run the type checker.
Fifteen sampled instantiation sites were all classified correctly. The corpus
holds 467 pattern source files, 486 test files, and 89 integration fixtures.
The source files contain 619 handler bodies, 249 action bodies, 72 lift
bodies, 1,499 computed bodies, and 193 inline JSX event handlers. Counts
below are for source files unless a row says otherwise.

### What the corpus calls inside bodies

| Call | Sites | Enclosing bodies | Legal under the rule | Rewrite |
| --- | --- | --- | --- | --- |
| Pattern instantiation `P({...})` | 121 | 64 in one computed, 28 in handlers, 28 in actions, 1 in an inline JSX handler | Yes | None in syntax; see below for timing |
| `P.inSpace(space, options)({...})` | 3 (plus 21 in fixtures and 8 in tests) | handlers | Yes | None in syntax; a cross-space request |
| `P.asScope("user")({...})` | 2 | computeds | Not in a computed | Move to the reactive tier |
| `navigateTo(target)` | 48 | 33 in handlers, 13 in actions, 2 in inline JSX handlers | Yes, an effect request | None |
| Handler binding `h({ state })` | 16 | computeds | No | Move the JSX out of the computed |
| `new Writable(value)` | 3, plus 4 through helpers | handlers | Yes | None |
| `Cell.for(cause)`, `Writable.for(cause)` | 9, plus 1 through a helper | lifts | Yes | None |
| `.map(fn)` on a cell | 2 found | handlers | No | Read the value first, then map the array |
| `grantSpaceAccess`, `revokeSpaceAccess` | 4 | handlers | Yes, effect requests | None |
| `nameBlob` | 2 | handlers | Yes, an effect request | None |
| Context reads | `equals` 108, `spaceOf` 28, `profileOwnerOf` 11, `eventKey` 9, `resultOwnerOf` 9, `spaceAccess` 6, `linksOf` 6, `currentPrincipal` 5, `principalOf` 3, `spaceDeleted` 3, `spaceMembers` 1 | handlers, lifts, computeds | Yes, context reads | None |

Everything else is absent. No body in the sources, tests, or fixtures calls
`computed`, `lift`, `handler`, `action`, `ifElse`, `when`, `unless`, `str`,
an inline `pattern(...)`, `wish`, any of the fetch family, any language-model
built-in, `sqliteDatabase`, `compileAndRun`, or `cellFromUrl`. Those built-ins
are requested in pattern scope: `wish` 121 times, `ifElse` 155, the fetch
family 15, the language-model built-ins 35, `patternTool` 31. The corpus
never uses `unless`, `llm`, `streamData`, `byRef`, `uiVariant`, or `cell`.

Two conclusions follow.

- The rule fits the corpus. Removing the reactive constructs from function
  bodies requires rewriting 18 sites (16 handler bindings and 2 cell maps)
  and the three computeds that instantiate patterns.
- The third legal kind, requesting an effectful built-in from a body, has no
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
computed:

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
  event and the order of requests within the invocation identify an
  instance, as they do today. The four `.for(tag)` sites show the explicit
  form, for an author who wants the same instance from different events.
- **Modifiers.** `P.asScope(scope)` and `P.inSpace(space, options)` are
  legal callees. `inSpace` makes the request a cross-space one: the new
  instance, and often its space, are created by a commit to another space.
- **Reading from a fresh instance in the same run.** `createRoom` in
  `patterns/system/fabrichat/manager.tsx` instantiates a room in a new space
  and reads `spaceOf(room)` from the returned link in the same handler run.
  Today the first run finds the space pending, is discarded, and runs again.
  With instantiation performed at commit, the space's identity has to be
  derivable from the request's causal identifier before the commit, or the
  dependent sends have to move to a later cause. This is part of open
  question 3.
- **Nested instances.** `patterns/dev/gideon-tests/notebook-nest-bug/main.tsx`
  builds twelve instances in one action and passes inner ones as inputs of
  outer ones. Each request needs its own identifier, and a link to an
  instance not yet created must be a legal input of another request.
- **Instantiation in a computed (66 sites, 3 computeds).** One computed in
  `patterns/dev/catalog/ui/story-renderer.tsx` selects one of 64 patterns in
  a `switch` and returns the instance. Two computeds in
  `patterns/apps/recommend-a-book/` return an `asScope("user")` instance. A
  `computed` or `lift` body does not instantiate. These sites move to the
  reactive tier: a conditional expression, or an index into a record of
  sub-patterns. In all three the instance is part of the enclosing
  pattern's result, so it is reachable from the result cell and is kept;
  whether it is then an instantiated pattern with a result cell of its own
  or an inline sub-pattern whose kept outputs are stored makes no
  difference to the author.
- **No lift returns a pattern.** The 72 lift bodies in the sources contain
  no instantiation.

### Handler bindings in computeds

Sixteen sites bind a handler inside JSX that a computed returns:
`patterns/apps/base/person.tsx` (7), `patterns/apps/base/family-member.tsx`
(6), and `patterns/apps/store-mapper/store-mapper.tsx` (3). A binding creates
a stream, so it is graph construction inside a function body. The rewrite is
to move the JSX into the reactive tier, where a list rendering becomes a
`map` and the binding is per element. A computed whose body is pure is
promoted to the reactive tier anyway, so the compiler can accept these sites
when the surrounding computed is promotable and reject them with a
diagnostic otherwise; `language-subset.md` decides.

### Cell creation in bodies

- Handlers create cells with `new Writable(value)` and no cause:
  `patterns/apps/base/contacts.tsx`, `patterns/system/loom/admission.tsx`,
  and through helpers `patterns/apps/shared-note/main.tsx` and `sendInto` in
  `patterns/system/fabrichat/room-records.tsx`. Their identifiers come from
  the frame's counter, which is sufficient because each invocation is a new
  frame.
- Lifts create cells with an explicit cause and write them at once,
  `Cell.for(input.id).set(...)`:
  `patterns/examples/cfc-spec-gallery/main.tsx`,
  `patterns/examples/cfc-trusted-component-examples/disclaimer-examples.tsx`,
  `patterns/product/collection-naming/naming.ts`, and
  `patterns/apps/topics/main.tsx`. A lift that writes a cell it names by
  cause is a computation with a side-write whose target depends on data. In
  the compiled design that is a materializer unless the write-path analysis
  can bound the target.

### FabriChat

FabriChat (`patterns/system/fabrichat/`, specified in
[`docs/specs/fabrichat/`](../fabrichat/README.md)) is the overview's
reference pattern. Its sources define 14 patterns and 24 module-level
handlers bound at 49 sites, and call `computed` 111 times, `action` 10
times, and `wish` 8 times. They use no `lift`, `ifElse`, `when`, `unless`,
`str`, fetch, language-model built-in, SQLite built-in, or `navigateTo`.

- **Per-row instances are already reactive constructs.** The message rows
  are `facts.main.map((message) => <FabriChatMessageRow ... />)` in the
  pattern body of `patterns/system/fabrichat/room.tsx`, and the per-user room
  lookups are `savedRooms.map((entry) => FoundRoom.asScope("user")({...}))`
  in `patterns/system/fabrichat/manager.tsx`. Neither is in a function body.
  Under the compiled design these 15 `map` calls are where the saving lands:
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
is proposed, and its
[implementation plan](../../plans/first-class-serializable-factories.md) has
not started.

### What a function body should be able to call

The corpus gives one data point: no source pattern calls a received factory
in a body. The options, from narrowest to widest:

1. **Named patterns only.** A body may instantiate a pattern imported by
   name or declared in the same module. Factory values cannot be called in
   bodies; they can be passed on and instantiated in the reactive tier. This
   covers every source site in the corpus. It leaves `compileAndRun`'s
   instantiation half and model tool calls as runtime-internal
   instantiation.
2. **Pattern factory values.** As option 1, plus a pattern received as a
   value, including one that closes over parameters. This is what the
   overview lists. It replaces `patternTool` and gives `compileAndRun` an
   ordinary reading: compilation returns a pattern factory value, and the
   author instantiates it. The compiler cannot see the callee's plan at the
   call site, so the label rule of such an instantiation uses the declared
   schemas of the factory's type and the instance's own plan at run time.
3. **Pattern and handler factory values.** As option 2, plus binding a
   received handler factory to state in a body. Binding creates a stream,
   which is the graph construction the overview removes from function
   bodies, and the corpus has it only in the 16 computed sites that move to
   the reactive tier.
4. **All factory kinds.** As option 3, plus calling a received module
   factory. Inside a function body a lifted function is an ordinary function
   call with no reactivity, so a module factory value adds nothing a plain
   function value does not, while requiring the footprint analysis to treat
   the call as opaque.

**Decision: option 2.** Pattern factory values are the unit of
instantiation everywhere else in the design, they are what the factory plan
needs for tools, and they keep function bodies free of graph construction.
Handler factories stay bindable in the reactive tier only. Module factories
stop being values that cross a boundary: an imported function is called as a
function. Built-ins are not factory values at all in the compiled design;
an effect request names its built-in statically, so that the compiler knows
the boundary's declared label rule.

## Summary

Classes: A structural, B effectful, C authoring marker, D removed. A cell
with two letters splits.

### Registered built-ins

| Built-in | Class | Scheduler today | Server placement today | Durable state |
| --- | --- | --- | --- | --- |
| `ifElse` | A | computation | structural, speculated | link store per node |
| `when` | A | computation | structural, speculated | link store per node |
| `unless` | A | computation | structural, speculated | link store per node |
| `str` | A | computation | not placed | none |
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
| `map`, `filter`, `flatMap`, `count`, `sum`, `min`, `max`, `minBy`, `maxBy`, `groupBy`, `keyBy`, `lookup`, `keys`, `keyEntries` | A |
| The eight `WithPattern` methods | D |
| `reduce`, `findIndex` on a cell | D |
| `db.query` | B |
| `SqliteDb.exec` | a cell write |
| `eventKey`, `currentPrincipal`, `principalOf`, `principalsOf`, `profileOwnerOf`, `resultOwnerOf`, `linksOf`, `spaceOf`, `spaceAccess`, `spaceAccessOf`, `spaceMembers`, `spaceDeleted`, `getPatternEnvironment` | context reads |
| `grantSpaceAccess`, `revokeSpaceAccess`, `nameBlob` | B |
| `patternTool`, `byRef`, `nameInstance`, `cell` | D |
| Every transformer-emitted form | D |

### Counts

Of the 31 registered built-ins: 12 are class A, 12 are class B, 1 is class
C, 5 are class D, and 1 splits across classes (`cellFromUrl`).
`compileAndRun` is counted in B, with its instantiation half an ordinary
instantiation.

## Decisions

The project owner has decided the following. The entries above already
reflect them.

- **Calls in function bodies.** Four kinds are legal: instantiating a
  pattern, creating a cell, requesting an effectful built-in, and a context
  read. Staged access changes and `nameBlob` are effect requests.
- **Factory values.** A function body may call pattern factory values and
  no other kind.
- **`wish` is structural.** What it creates, it creates idempotently, and
  the result reads as if the data had already existed.
- **`streamData` and `llm` are removed.**
- **A `computed` or `lift` body does not instantiate a pattern.** Selection
  among patterns happens in the reactive tier.
- **`navigateTo` requires a result cell,** so an instance that is only
  navigated to is an instantiated pattern.
- **Identifiers.** Cells and instances created in a handler need no stable
  identifier beyond the invocation, since each invocation is a new frame.
  Patterns and lifts need identifiers that are the same on every evaluation.
- **`asScope` and `inSpace`** are part of the instantiation syntax.
- **Migration is out of scope** for this document.

## Open questions

Each question states the assumption this document made.

1. **Observation classes beyond the overview's four.** The inventory finds
   three reads that do not fit value, shape, enumeration, or identity:
   truthiness at the root of a condition (`ifElse`, `when`, `unless`),
   label metadata (`inspectConfLabel`, `principalOf` and its siblings), and
   the pointer label of a link that is followed (`sqliteQuery`'s slot
   labels). *Assumed:* `plan-and-label-templates.md` either adds classes or
   maps each onto an existing one, and truthiness maps onto a value
   observation of the root path only.
2. **How `wish` is spelled.** `wish` stays one structural operation.
   Whether the compiler requires a constant query, so that it can tell a
   path from a search from a clock at compile time and give each its label
   rule, is undecided. *Assumed:* a constant query gets the precise rule,
   and a computed query gets the join of all of them.
3. **Commits that span spaces.** A transaction covers one space. Two things
   a handler does reach another space: a staged access change, which today
   commits ahead of the handler's transaction, and an `inSpace`
   instantiation, whose space may not exist until the request is performed.
   One mechanism could serve both: a two-step commit across spaces. Its
   design decides what a handler can read from a cross-space request in the
   same invocation, which `createRoom` in FabriChat does today by being
   discarded and run again. *Assumed:* the space's identity derives from
   the request's causal identifier and is available before the commit, and
   the access change keeps committing first until the two-step commit is
   specified.
4. **Effect requests from bodies.** No pattern requests a fetch, a
   language-model call, or a query from a function body today. *Assumed:*
   all class B built-ins are allowed there, since the overview says so, and
   a request returns a link to the boundary's result, which is pending in
   the requesting transaction.
5. **Tool calls as instantiation.** A model tool call instantiates a
   pattern with a result cell whose cause is an identifier the model
   supplies, and the dialog's built-in tools let a model read, invoke, and
   write whatever it can name by link. *Assumed:* out of scope for the
   language, and specified with the model boundary's declared rule. The
   identifier should derive from the turn and the call's position.
6. **Label rules that become tighter.** `flatMap` and a promoted template
   literal get per-element and per-path labels where the runtime computes
   one label today. The overview's staging rule allows tighter labels. The
   comparison in stage 3 must expect a difference for these operations.
7. **`sqliteDatabase` identity.** Its handle is keyed on the whole cause,
   including the inputs document, so changing the table declarations names
   a different handle today. *Assumed:* as a state cell it takes the
   identifier of the variable it is assigned to.
8. **Document inconsistencies found.** They do not affect the design and
   are recorded for correction where the documents are owned:
   - the overview lists `wish` among the effectful operations and names
     three kinds of call in function bodies, and this document governs on
     both;
   - the server-execution documents call the fetch family `fetchData`,
     which is not an exported name;
   - [built-in contracts](../server-side-execution/builtins.md) §2 says
     the SQLite built-in enqueues its effect by hand, and the code uses the
     sink-request seam;
   - neither server-execution document places `str`, `aggregate`, the
     collection-index family, `anchorsOf`, `cellFromUrl`, or
     `sqliteDatabase`;
   - `cancelGeneration` is declared on the state types of the one-shot
     model built-ins in `base/api/index.ts` and is not implemented by them.
