# Plan format and label templates (proposed)

**Status:** proposed. Nothing here is implemented. This document details the
semantic core of the [compiled pattern language](README.md): the plan the
compiler emits beside value code, and the label templates from which the
runtime computes Contextual Flow Control (CFC) labels.

The label rules below change what CFC decides, so they are a semantic gap in
the sense of
[the correspondence procedure](../../development/cfc-spec-correspondence.md)
and are ruled on in `commonfabric/specs` before any of them binds the runtime.
This document describes the design and how this runtime would arrange it. It
cites the specification by section and chapter file. Where this document and a
ruling disagree, the ruling governs and this document is corrected.

Two documents beside this one are referred to by name:
`language-subset.md` defines which source constructs lower to which operation,
and `builtin-inventory.md` places each built-in. This document takes the
operations as given and defines what the plan records for them.

## Contents

1. [The plan](#1-the-plan)
2. [Slots and observation classes](#2-slots-and-observation-classes)
3. [Label rules of the structural operations](#3-label-rules-of-the-structural-operations)
4. [Instantiation](#4-instantiation)
5. [Error states and termination](#5-error-states-and-termination)
6. [Worked example: FabriChat](#6-worked-example-fabrichat)
7. [What rests on the compiler](#7-what-rests-on-the-compiler)
8. [Open questions](#8-open-questions)

## Notation

- `C(x)` is the confidentiality of `x`, a conjunction of clauses, and `I(x)`
  its integrity, a set of atoms (§3.1.1, §3.1.6, `03-core-concepts.md`).
- `a ⊔ b` joins confidentiality: the clauses of both, deduplicated under
  canonical equality (§3.1.2; §8.9.3, `08-09-runtime-label-propagation.md`,
  allows the deduplication).
- `a ⊓ b` is the class-aware integrity meet: the atoms present in both whose
  family is hereditary (§3.1.6.2, `03-core-concepts.md`: "Hereditary atoms
  survive **both combination and transformation** via intersection across
  inputs.").
- A **path** is a list of segments. A segment is a property name, or `*` for
  "each element", as in the stored envelope's entry paths.
- An **instance** is one running pattern with a result cell. A **cone** is the
  part of an instance one output path depends on.

## 1. The plan

The plan is data. The compiler emits one plan per pattern, the runtime's CFC
kernel and scheduler read it, and no emitted code computes a label. Every
record is plain JSON so that it can be canonicalized and hashed.

### 1.1 Records

The declarations below are the whole format. Field comments state what a field
means and are part of the definition.

```ts
/** A path segment: a property name, or "*" for each element. */
export type Segment = string;
export type Path = readonly Segment[];

/** Content address of a canonicalized record (section 1.2). */
export type Hash = string;

/** Index into the array the field name says it indexes. */
export type Index = number;

export type ObservationClass = "value" | "shape" | "enumeration" | "identity";

/** Where a slot's data lives. */
export type SlotRoot =
  /** The instance's argument. */
  | { readonly kind: "argument" }
  /** A state cell of this instance (`Plan.stateCells`). */
  | { readonly kind: "state"; readonly cell: Index }
  /** The payload of the event a handler was invoked with. */
  | { readonly kind: "event"; readonly handler: Index }
  /** The current element of a collection (`Plan.collections`). */
  | { readonly kind: "element"; readonly collection: Index }
  /** The stored result of a durable operation (`Plan.operations`). */
  | { readonly kind: "operation"; readonly operation: Index };

/** One input observed at one path in one way. */
export interface Slot {
  readonly root: SlotRoot;
  readonly path: Path;
  readonly observes: ObservationClass;
  /** Schema of the value at this path, by content address. */
  readonly schema: Hash;
  /**
   * The label the schema declares for this observation, when it declares
   * one. A declared label is what makes a constraint checkable at compile
   * time (section 4.4).
   */
  readonly declared?: DeclaredLabel;
}

export interface DeclaredLabel {
  readonly confidentiality?: readonly unknown[];
  readonly integrity?: readonly unknown[];
}

/**
 * A label in symbolic form. Each node kind has a confidentiality rule and an
 * integrity rule (section 3).
 */
export type Template =
  /** A literal or frozen module-scope datum. Contributes nothing. */
  | { readonly op: "const" }
  /** The observation of one slot, passed through unchanged. */
  | { readonly op: "slot"; readonly slot: Index }
  /** A new value computed from the inputs. */
  | {
    readonly op: "derive";
    readonly inputs: readonly Template[];
    /** What computed it: a sandboxed body, or emitted expression code. */
    readonly by: { readonly body: Index } | { readonly expression: true };
  }
  /** Conditional selection. The one node that depends on a value. */
  | {
    readonly op: "select";
    readonly selector: Index;
    readonly condition: Template;
    readonly branches: readonly Template[];
  }
  /** A join over every element of a collection. */
  | {
    readonly op: "fold";
    readonly collection: Index;
    readonly body: Template;
  }
  /** Reads whose addresses are known only at run time. */
  | { readonly op: "dynamic"; readonly reads: Index };

/** A selection point: which branch of a `select` the value code took. */
export interface Selector {
  /** Number of branches. The value code reports an index below this. */
  readonly arity: number;
}

/** A collection the instance maps, filters, or folds over. */
export interface Collection {
  /** The input collection, or the collection this one is derived from. */
  readonly source:
    | { readonly slot: Index }
    | { readonly collection: Index; readonly via: "filter" | "flatMap" };
  /** The label of which elements are present and in what order. */
  readonly membership: Template;
  /** How an element is identified across runs (section 1.3). */
  readonly key: "identity" | { readonly path: Path };
}

/** One sandboxed function body and the result of footprint analysis. */
export interface Body {
  /** Content address of the body's source as the loader receives it. */
  readonly code: Hash;
  readonly kind: "lift" | "computed" | "action" | "handler";
  /** Slots the runtime materializes into the body's argument. */
  readonly reads: readonly Index[];
  /**
   * Cell handles the body receives. Reads through a handle are journaled
   * while the body runs and enter the label as a `dynamic` template.
   */
  readonly handles: readonly Index[];
  /** Paths the body writes, with the constraint set of each. */
  readonly writes: readonly WriteEdge[];
  /** Where analysis gave up, for diagnostics. Each widened a `reads` slot. */
  readonly widenings: readonly Widening[];
}

export interface Widening {
  /** The slot that now stands for a whole subtree. */
  readonly slot: Index;
  /** Source position of the expression that caused it. */
  readonly at: { readonly file: string; readonly start: number };
}

/** A statically known write target of a body or cone. */
export interface WriteEdge {
  readonly target:
    | { readonly kind: "output"; readonly path: Path }
    | { readonly kind: "state"; readonly cell: Index; readonly path: Path };
  /** The label of the value written. */
  readonly template: Template;
  readonly constraints: readonly Index[];
}

/** A set of reads resolved at run time. */
export interface DynamicReads {
  readonly why:
    | { readonly kind: "link"; readonly through: Index }
    | { readonly kind: "handle"; readonly body: Index; readonly handle: Index };
}

/** A requirement on slots or on a write (section 4.4). */
export type Constraint =
  | {
    readonly kind: "requiredIntegrity";
    readonly slots: readonly Index[];
    readonly patterns: readonly unknown[];
  }
  | {
    readonly kind: "maxConfidentiality";
    readonly slots: readonly Index[];
    readonly ceiling: readonly unknown[];
  }
  | { readonly kind: "writeFloor"; readonly patterns: readonly unknown[] }
  | { readonly kind: "writerFit" }
  | { readonly kind: "writer"; readonly anyOf: readonly WriterPolicy[] };

export interface WriterPolicy {
  /** The body that may write, by content address. */
  readonly body?: Hash;
  /** The UI contract an event has to satisfy for this alternative. */
  readonly uiContract?: {
    readonly helper: "UiAction" | "UiPromptSlot" | "UiDisclosure";
    readonly action?: string;
    readonly trustedPattern?: string;
    readonly requiredEventIntegrity?: readonly string[];
  };
}

/** One output path of the instance and how its value and label are made. */
export interface Output {
  readonly path: Path;
  readonly cone: Index;
  readonly template: Template;
  /** Whether the path is reachable from the result cell. */
  readonly kept: boolean;
  readonly constraints: readonly Index[];
}

/** One dependency cone: a unit of evaluation. */
export interface Cone {
  /** Name of the emitted value function for this cone. */
  readonly entry: string;
  /**
   * Every slot the value function receives, over all selections. The runtime
   * passes these and nothing else (section 7).
   */
  readonly slots: readonly Index[];
  readonly bodies: readonly Index[];
  readonly selectors: readonly Index[];
  /** Side-writes this cone performs besides its outputs. */
  readonly writes: readonly WriteEdge[];
}

/** An edge between cones: `from` writes something `to` reads. */
export interface ConeEdge {
  readonly from: Index;
  readonly to: Index;
  readonly via:
    | { readonly kind: "output"; readonly path: Path }
    | { readonly kind: "state"; readonly cell: Index; readonly path: Path };
}

/** A state cell and the cause its identifier derives from. */
export interface StateCell {
  /** The name the cell's creation is caused by. */
  readonly name: string;
  readonly scope: "space" | "user" | "session";
  /** The collection whose element key joins the cause, inside a `map`. */
  readonly perElementOf?: Index;
  readonly schema: Hash;
}

/** An operation with durable state of its own. */
export interface Operation {
  readonly kind: "effect" | "aggregate" | "cache" | "materializer";
  /** The built-in or body that implements it. */
  readonly implementation: { readonly builtin: string } | {
    readonly body: Index;
  };
  /** The label of the operation's request or folded input. */
  readonly input: Template;
  /** The cause its state document's identifier derives from. */
  readonly name: string;
  readonly perElementOf?: Index;
}

export interface Plan {
  readonly version: 1;
  readonly argumentSchema: Hash;
  readonly resultSchema: Hash;
  readonly slots: readonly Slot[];
  readonly selectors: readonly Selector[];
  readonly collections: readonly Collection[];
  readonly bodies: readonly Body[];
  readonly dynamicReads: readonly DynamicReads[];
  readonly constraints: readonly Constraint[];
  readonly outputs: readonly Output[];
  readonly cones: readonly Cone[];
  readonly edges: readonly ConeEdge[];
  readonly stateCells: readonly StateCell[];
  readonly operations: readonly Operation[];
}

/** What the compiler emits, addressed as one thing. */
export interface CompiledPattern {
  readonly plan: Hash;
  readonly valueCode: Hash;
  /** Identity of the compiler build that produced both. */
  readonly compiler: Hash;
}
```

The **keep set** is the outputs with `kept: true`. It is a property of the
pattern and not of a run: the compiler knows which output paths the result
cell's schema reaches.

A pattern compiled into another, such as a `map` body or an inline
sub-pattern, has no plan of its own. Its slots, bodies and cones are entries
of the enclosing plan, with `element` roots where it reads the element.

### 1.2 Identity and content addressing

- **Canonical form.** A record is canonicalized the way label documents are
  ([content-addressed CFC labels](../content-addressed-cfc-labels.md),
  "Label documents"): keys sorted, absent members dropped, and hashed with the
  same tagged hash (`cfcLabelDocumentHash` in
  `runtime/runner/src/cfc/label-documents.ts` shows the function for labels).
- **Plan identity** is the hash of the canonical `Plan`. The identity of a
  compiled pattern is the hash of the canonical `CompiledPattern`, so value
  code and plan cannot be exchanged separately.
- **Template identity.** Inside a plan, templates refer to slots by index.
  For memoization across plans (section 4.3) a template is hashed in
  *slot-free* form: each slot index is replaced by its position in the
  template's own ordered slot list, and each selector index likewise. Two
  patterns with structurally equal templates then share memo entries.
- **Slot keys.** At run time a slot is bound to an address. The binding's key
  is the address, the path and the class, which is exactly what the stored
  envelope is resolved by (section 2.2). The schema hash is not part of the
  key, because a label is resolved by address and class.
- **Body identity** is `Body.code`. It is the identity a write policy names
  (`WriterPolicy.body`) and the identity a `TransformedBy` atom carries.

### 1.3 Causal identities

A state cell's document identifier derives from the cause of its creation: the
instance, the element key when `perElementOf` is set, and `name`. The compiler
derives `name` exactly as the transformer does today, from the variable the
cell is assigned to, so stored state keeps its identifiers. A durable
operation's state document is named the same way.

An element key is the element's cell identity when the collection's `key` is
`"identity"`, which is how the list coordinator keys a per-element result
today (`listElementResultCell` in
`runtime/runner/src/builtins/list-coordinator-plan.ts`), and otherwise the
value at the given path.

## 2. Slots and observation classes

### 2.1 The four classes

A slot is one input at one path observed in one way. The class says what the
computation learns.

| Class | What is learned | Typical source construct |
| --- | --- | --- |
| `value` | The content at the path, recursively | Reading a scalar; passing a subtree to a body that reads all of it |
| `shape` | That the path exists, and its kind | `x !== undefined`, `typeof x`, truthiness of an object |
| `enumeration` | Which children a container has, their order and count | `.length`, iteration, `map` membership |
| `identity` | Which reference sits at the path, not what it refers to | Passing a link on, comparing two cells |

These are the observations of §4.6.3 (`04-label-representation.md`), which
defines `shape`, `value` and `iterate` entries per path and states: "Static
child access `p/sel` is navigation plus observations at `p/sel`; it does
**not** implicitly materialize or declassify the parent `p`." That rule is
what makes a slot per path meaningful: reading `message.body` is a `value`
slot at `body` and no observation of `message`.

`identity` is §4.6.3's standalone reference-identity read, which consumes "the
reference scalar's `value(p)`" and "never any observation of the referenced
target".

### 2.2 Mapping to the runtime's vocabulary

The runtime stores labels as envelope entries with an `observes` class and
resolves a read by its shape. The types are `LabelObservationClass` in
`runtime/runner/src/cfc/label-view-core.ts` (`"value" | "shape" | "enumerate"
| "followRef"`) and `ReadObservationShape` in
`runtime/runner/src/cfc/observation-classes.ts`
(`"value" | "shape" | "followRef"`). The table `CONSUMED_CLASSES` there says
which entry classes each read shape consumes.

| Slot class | Read shape it resolves as | Entry classes consumed | Where |
| --- | --- | --- | --- |
| `value` | `value` | `value`, `shape`, `enumerate` | At the slot's path, recursively |
| `shape` | `shape` | `shape`, `enumerate` | At the slot's path |
| `enumeration` | `shape` | `shape`, `enumerate` | At the container's path |
| `identity` | `followRef` | `followRef` | At the slot's path |

The label of a slot is defined as **the label a journaled read of that shape
at that address consumes today**: the entries
`consumedEntriesForRead` selects and `labelForConsumedEntries` joins
(`runtime/runner/src/cfc/consumed-label.ts`), resolved as
[CFC observation classes](../cfc-observation-classes.md) §4 describes. This
definition is what the precision comparison in section 3 rests on. A template
joins the labels of a set of slots, and each of those labels is the label one
read contributes to the per-transaction join today.

Three consequences of the mapping:

- **`shape` and `enumeration` resolve alike.** The runtime has no entry class
  that separates a key-presence probe from an enumeration: a `shape` read at a
  container consumes its `enumerate` entries
  ([CFC observation classes](../cfc-observation-classes.md) §4). The plan
  keeps the two classes apart because the specification does (§4.6.3 gives a
  count-shaped read its own row), so that a runtime which later stores a
  separate count entry can resolve `enumeration` more narrowly without a
  change to compiled plans.
- **A `value` slot at a container covers its children.** It consumes what a
  recursive read consumes. Footprint analysis prefers narrower slots; a
  widening (section 1.1, `Widening`) replaces several narrow slots by one
  `value` slot at their common ancestor, which is the over-approximation the
  overview allows.
- **`identity` never reaches the target.** A slot that follows the reference
  is two things: the `identity` slot at the link, and a `dynamic` template for
  the reads at the target (section 3.9).

### 2.3 The stored form of an instantiated label

An instantiated label is stored as envelope entries of the existing shape
([CFC stored envelope](../cfc-stored-envelope.md)): `LabelMapEntry` with
`origin: "derived"` and an `observes` class. One kept output path produces the
entries the persist step of `prepareBoundaryCommitSteps`
(`runtime/runner/src/cfc/prepare.ts`) produces for a written path today:

- a `value` entry holding the instantiated label, replaced on overwrite;
- a `shape` entry holding its confidentiality, frozen at the path's creation
  (§8.12.8, `08-12-store-label-monotonicity.md`);
- for a kept collection, an `enumerate` entry at the container holding the
  instantiated membership template, and `*`-child entries for the element
  template where every element instantiates to the same label.

Declared entries (`origin: "declared"`) are unchanged: they come from the
schema, not from a template. The format of the stored bytes is a host
arrangement and does not change.

## 3. Label rules of the structural operations

Each rule gives the template the compiler emits, the confidentiality and
integrity it instantiates to, and how that compares with what the runtime
computes today.

### 3.1 The baseline: what the runtime computes today

Today a reactive node run is one transaction, and every path the transaction
writes gets one label:

- `deriveFlowJoin` (`deriveFlowJoinImpl` in
  `runtime/runner/src/cfc/prepare.ts`) computes one join per transaction over
  the reads `forEachFlowObservation` yields, and
  `prepareBoundaryCommitSteps` stamps it on every written path. The kernel
  manifest states it in its `propagateLabels` row
  (`runtime/runner/src/cfc/kernel/manifest.ts`).
- Confidentiality is the union of what every counted read consumed, trigger
  reads included
  ([CFC observation classes](../cfc-observation-classes.md) §6).
- Integrity is the hereditary meet over the content observations, plus a
  `TransformedBy` atom minted by `mintTransformedBy`
  (`runtime/runner/src/cfc/input-witness.ts`) when the writing implementation
  is known and the join is not empty. The
  [conformance statement](../cfc-conformance-statement.md) §4 records this as
  the third stage of §8.9.3 with deviations.
- Input gates (`verifyInputRequirements`) quantify over the reads before the
  last overlapping write
  ([write-prefix provenance](../cfc-write-prefix-provenance.md)); the join
  itself stays transaction-global
  ([value-level provenance](../cfc-value-level-provenance.md) §1).

So today the label of a written path is a function of *which transaction
wrote it*, and precision comes from giving each node its own transaction. In
the comparisons below, "today" means that per-node arrangement.

The comparison criterion is the overview's: a template label is **equal or
tighter, never looser**. Tighter means fewer confidentiality clauses, or more
integrity atoms. Each row that is tighter says what the narrowing rests on.

### 3.2 Template semantics

For a template `t`, with `sel(i)` the branch the value code reported for
selector `i`:

| Node | `C(t)` | `I(t)` |
| --- | --- | --- |
| `const` | empty | neutral for `⊓` |
| `slot s` | `C(s)` | `I(s)`, unchanged |
| `derive` | `⊔` of `C` over `inputs` | `⊓` of `I` over `inputs`, plus `TransformedBy` for `by` |
| `select` | `C(condition) ⊔ C(branches[sel])` | `I(branches[sel])` |
| `fold` | `C(membership) ⊔` the `⊔` of `C(body)` over all elements | `⊓` of `I(body)` over all elements, plus `TransformedBy` |
| `dynamic` | `⊔` of the labels the journaled reads consumed | `⊓` over those reads |

Notes on the integrity column:

- **`slot` keeps every class of atom.** It is a pass-through, and §3.1.6.2
  (`03-core-concepts.md`) says of pass-through and exact copy that "the output
  integrity at the path MUST be the input integrity unchanged, across **all**
  propagation classes".
- **`derive` drops value-bound atoms and mints.** This is the default
  transition of §8.9.3 applied to the template's inputs instead of to a
  transaction's reads. The minted atom names `Body.code` for a sandboxed
  body. For emitted expression code it names the compiled pattern, because
  the expression has no separate identity.
- **`const` is neutral.** A literal is not an observation, so it does not
  empty the meet. This matches the runtime, where a literal in a function
  body is not a read.
- **`select` does not combine its branches.** The result *is* the selected
  branch's value, so integrity is that branch's. The condition contributes
  confidentiality only, which is the flow-path rule of §8.11.3
  (`08-11-content-vs-flow-labels.md`): "When data flows through a decision
  point influenced by labeled inputs, the *decision itself* inherits that
  label." Condition integrity is control integrity (§3.4), which the
  specification keeps apart from value integrity.

### 3.3 Property access

`a.b` on an input is not an operation. It extends the slot's path: the
template is `slot (root, path + b, class)`.

`a.b` on a derived value selects the sub-template at `b` when the producer has
per-path templates (object construction, section 3.4). When the producer is
one opaque call, every path of its result has the call's template.

**Today.** A read at a path consumes the entries resolved at that path
(section 2.2), so a node that reads only `a.b` already gets only that label.
**Equal.** The difference is that no node, transaction or document exists for
the access.

### 3.4 Object and array construction

`{ x: e1, y: e2 }` and `[e1, e2]` produce a template per path: the template of
path `x` is the template of `e1`. The container's own `shape` and
`enumeration` are `const` when the key set is static, and otherwise the
template of whatever decides it (a spread of a labeled object, a conditional
key).

**Today.** In a pattern body, a constructed object is structure: each member
is a link to the node that computes it, and each node output is a document
with its own label. **Equal**, at the cost of a document per member. Inside a
`computed` that returns an object, one transaction writes every path, so
every path carries the join of everything the body read. A promoted
expression gets a template per path instead. **Tighter**; this rests on the
compiler (section 7).

### 3.5 Conditional selection

`c ? a : b` produces `select` with `condition` the template of `c` and two
branches. `a && b` is `select(a, [b, a])`: when `a` is falsy the result is
`a` itself. `a || b` and `??` are analogous.

The condition's slots have the class the test needs: `value` for a scalar
condition, `shape` for an object or array, whose truthiness is its existence.

The unselected branch contributes nothing. Its slots are in the cone's slot
list (section 1.1, `Cone.slots`), so they can dirty the cone, but a kept
output is rewritten only when its value or its instantiated label changed, and
both are functions of the condition and the selected branch alone.

**Today.** `ifElse`, `when` and `unless` share `forwardReference`
(`runtime/runner/src/builtins/forward-reference.ts`). It reads the
condition's truthiness at its root (`readsTruthyAtRoot`), resolves only the
selected input, and writes a link to it. The result slot's label is that
transaction's join, which holds the condition's label; a reader that follows
the link consumes the selected branch's label at its own document. **Equal.**

### 3.6 `map`

`xs.map((x) => body)` creates a `Collection` and compiles `body` once against
`element` slots.

- **Element template.** The template of output path `p` of element `i` is the
  body's template for `p`, with `element` slots bound to element `i`. It
  includes two slots at the element's root: `shape`, which is the element's
  membership in the collection, and `identity`, which is the reference at
  slot `i` when elements are links. Captured outer values are ordinary slots.
- **Membership template.** For a `map` over an input collection, the
  `enumeration` slot of that collection. `map` preserves the domain, so the
  result's membership is its source's.
- **Nothing else.** The label of element `i` does not include any slot of
  element `j`.

This is the split of §8.5.6.1 (`08-05-collection-transitions.md`): "Child
paths like `/items/0` carry `shape` (membership/domain) and `value` (member
payload)."

**Today.** `map` (`runtime/runner/src/builtins/map.ts`) runs one sub-pattern
instance per element. The coordinator reads the list's membership and the
per-slot references but no element value, and its membership read is declared
onward (`listMembershipRead` in `list-coordinator-plan.ts`), so the container
carries membership and each element result carries its own element's label
plus its slot's
([CFC observation classes](../cfc-observation-classes.md) §6.2). **Equal**
for labels. The specification calls this arrangement decomposition and
prefers it (§8.5.4.3): "Each **element op** runs in its own transaction that
reads only its element." The template arrives at the same labels without the
transactions. Within one element's body, a `computed` that returns several
paths is **tighter** as in section 3.4.

### 3.7 `filter` and `flatMap`

`xs.filter((x) => pred)` creates a derived `Collection`.

- **Membership template.** `fold` over the source with body the template of
  `pred`, joined with the source's membership. Which elements are present,
  and at which index, depends on the predicate's result for *every* element,
  dropped ones included.
- **Element template.** An element of the result is the source element,
  passed through: `slot` templates over the source's `element` root, so every
  class of integrity survives. Its root `shape` slot is replaced by the
  derived collection's membership template, because being at index `k` of the
  result depends on all the predicates.

`xs.flatMap((x) => body)`:

- **Membership template.** `fold` over the source with body the
  `enumeration` of the segment `body` returns, joined with the source's
  membership. Position and multiplicity depend on every segment's *length*,
  not on its content.
- **Element template.** The body's template for the originating element,
  with the root `shape` replaced by the membership template.

These follow §8.5.4.2, which separates membership, order and multiplicity
confidentiality from item content and notes that the two helpers "usually
still taint output positions by other elements even when each emitted item is
element-local".

**Today.** The `filter` coordinator (`runtime/runner/src/builtins/filter.ts`)
reads every predicate result, so all of them are in its one join, and
`recordCfcStructureContainer` has prepare mint the container's structure
entries from that join. Its output slots are links to the source elements.
**Equal.** The `flatMap` coordinator
(`runtime/runner/src/builtins/flatmap.ts`) reads every child *result*, so the
content label of every segment joins the container and the slots. The
template joins segment lengths only. **Tighter**, deliberately: this is the
precision §8.5.4.2 describes, and it rests on the compiler's claim that the
positions depend on lengths alone.

### 3.8 Aggregates

An aggregate over a collection (`sum`, `min`, `max`, `some`, `every`, and the
rest that `builtin-inventory.md` lists) is `fold` with body the template of
the per-element contribution: the result depends on membership and on every
element's contribution.

`count` and `.length` are the membership template alone.

A fold is incremental: its state is durable (`Operation` of kind
`aggregate`), and so is the multiset of element label identifiers it joins
(section 4.3), so a change to one element costs one update.

**Today.** `aggregate` (`runtime/runner/src/builtins/aggregate.ts`) builds a
tree of `aggregateNode` runs, each its own transaction, and labels accumulate
up the tree by the ordinary join. **Equal** for the value aggregates. For
`count` the coordinator reads the raw list; the template is the
`enumeration` slot. **Equal or tighter**, to be confirmed by the stage 3
comparison, because what a raw list read consumes at its slots depends on
the list's stored entries.

### 3.9 Opaque sandboxed calls

A sandboxed body with footprint `reads` and `handles` produces, for every
path of its result and every path it writes:

```text
derive(by: body) over
  slot r           for each r in Body.reads
  dynamic h        for each h in Body.handles
```

The runtime builds the body's argument from exactly `Body.reads`. A slot that
is not listed is not materialized, so the body cannot observe it.

`handles` exist so that a template is never looser than today. A body that
receives a cell and reads through it at a path it computes
(`places.key(k).get()`) is journaled today read by read. A static footprint
would have to widen to the whole cell. The plan therefore keeps such reads
dynamic: the runtime brackets the call, journals the reads made through the
handle, and joins what they consumed.

An imported function outside the subset is the same node with every argument
as a `value` slot at the argument's root.

**Today.** A `lift` or `computed` node reads what its argument schema
materializes plus what it reads through cells, and the whole join lands on
every written path. The static part of the footprint is the narrowed
argument schema. **Equal or tighter**: equal when the body reads everything
its schema materializes today, tighter when footprint analysis narrows the
schema further than the transformer does. The narrowing does not rest on the
compiler's analysis being right (section 7): a footprint that is too small
starves the body instead of leaking to it.

### 3.10 Link following

Following a link at slot `l` to read a target produces:

```text
derive over
  slot (l, identity)
  dynamic (link, through: l)
```

The target's address is data, so no template names it. This is where trigger
reads remain: when the target changes, the cone is dirtied through the
address, and the recomputation joins that address's current label, as
§8.9.2 requires of a dependency-scheduled rerun. Reads at the target are
classified by the same four classes.

The rule is §8.2.4's (`08-02-pass-through-via-references.md`): a dereference
consumes "Every applicable reference restriction along the traversed path,
plus the current labels of the target observations actually made."

A link that is passed on without being followed is a `slot` template of class
`identity`, with the pass-through integrity rule.

**Today.** The probe of the followed slot is a `followRef` observation and
the target's content arrives through ordinary reads journaled at the target
(`forEachFlowObservation`;
[CFC observation classes](../cfc-observation-classes.md) §6). **Equal**, by construction: the
`dynamic` part is the same journal mechanism.

### 3.11 Static side-writes

A cone that writes through a cell it was passed has a `WriteEdge` for each
statically known target. The label of the written value is the edge's
template, which is the template of the written expression: the body's
template when a sandboxed body performs the write.

The checks a write is subject to (section 4.4) are evaluated on that
template: the write floor on `I(template)`, writer-fit on `C(template)`, and
the writer policy on the writing body's identity.

A write whose target is dynamic or too broad to predict is a materializer and
keeps its own transaction and today's label rule.

**Today.** A side-write is one more written path of the node's transaction
and carries the transaction's join. **Equal or tighter**, as for the cone's
primary output.

### 3.12 Event handlers

A handler is a sandboxed body with an `event` root. Its template is the
`derive` of section 3.9 over its event slots, its state slots and its
handles. Every path it writes has that template. The schema's declared
integrity for the written path, such as an authorship atom for the acting
principal, is a declared entry and is added as it is today.

**Today.** The handler's transaction join over the event payload and the
state it read lands on every written path. **Equal.**

### 3.13 Summary

| Operation | Template | Against today |
| --- | --- | --- |
| Property access | Slot path extension | Equal |
| Object, array construction | Template per path | Equal in pattern bodies; tighter in promoted expressions |
| Conditional | `select` | Equal |
| `map` | Element template; membership slot | Equal; tighter within an element as above |
| `filter` | Pass-through elements; membership `fold` of predicates | Equal |
| `flatMap` | Element template; membership `fold` of segment lengths | Tighter (content of other segments excluded) |
| Aggregate | `fold` | Equal; `count` equal or tighter |
| Sandboxed call | `derive` over footprint and handles | Equal or tighter |
| Link following | `identity` slot plus `dynamic` | Equal |
| Static side-write | Template of the written expression | Equal or tighter |
| Handler | `derive` over event and state footprint | Equal |

No row is looser. The one way a compiled label could be looser than today's
is a static footprint standing in for reads that are dynamic today, and
`handles` exclude it: a read a body makes through a cell stays journaled. A
widening affects only slots the runtime materializes into the argument, which
the body's argument schema materializes today as well.

## 4. Instantiation

### 4.1 When it runs

Instantiation runs in the transaction of a cause, after the value code, and
only for kept outputs and write edges. For each one:

1. If the output's cone was not evaluated in this transaction, do nothing.
2. Collect the label identifier of each slot the template reaches under the
   reported selections, and the selections themselves. This is the
   **instantiation key**.
3. If the key equals the key stored with the output's current label, reuse
   that label. A change of value alone ends here.
4. Otherwise instantiate (section 4.2), look the result up in the memo
   (section 4.3), check the constraints (section 4.4), and stage the label
   with the write.

An interim value that is not kept is never labeled. Its template is not lost:
it is a sub-template of every kept output that depends on it.

A label can change without its value changing, when a slot's label changed.
Step 2 notices, and the output's label entry is rewritten. This is the
re-derivation of §8.9.4 ("When a live reactive node recomputes, the new
attempt's journal sees the source's *current* labels") without the
recomputation. A cone nothing demands is not re-instantiated, which that
section permits: "There is **no retroactive relabeling obligation**".

### 4.2 The algorithm

`instantiateTemplate` is a kernel function in the sense of the correspondence
procedure: pure, named after its pseudocode, and the only place the runtime
decides what that pseudocode decides. It takes labels and selections and
returns a label. It takes no transaction and no slot value.

```ts
// Shown for illustration only.
interface TemplateInputs {
  /** Label of a slot, already resolved by address, path and class. */
  slotLabel(slot: Index): Label;
  /** The branch the value code took at a selector. */
  selection(selector: Index): number;
  /** Elements of a collection, each with its own inputs. */
  elements(collection: Index): readonly TemplateInputs[];
  /** Membership label of a collection. */
  membership(collection: Index): Label;
  /** Join of what a journaled read set consumed. */
  dynamicLabel(reads: Index): Label;
  /** The `TransformedBy` atoms for a derivation, minted by the runtime. */
  mint(by: { body: Index } | { expression: true }): readonly Atom[];
}

function instantiateTemplate(t: Template, inp: TemplateInputs): Label {
  switch (t.op) {
    case "const":
      return NEUTRAL; // empty confidentiality; identity of the meet
    case "slot":
      return inp.slotLabel(t.slot);
    case "dynamic":
      return inp.dynamicLabel(t.reads);
    case "derive": {
      const parts = t.inputs.map((i) => instantiateTemplate(i, inp));
      return {
        confidentiality: joinAll(parts.map((p) => p.confidentiality)),
        integrity: [
          ...hereditaryMeet(parts.map((p) => p.integrity)),
          ...inp.mint(t.by),
        ],
      };
    }
    case "select": {
      const cond = instantiateTemplate(t.condition, inp);
      const taken = instantiateTemplate(
        t.branches[inp.selection(t.selector)],
        inp,
      );
      return {
        confidentiality: joinAll([cond.confidentiality, taken.confidentiality]),
        integrity: taken.integrity,
      };
    }
    case "fold": {
      const parts = inp.elements(t.collection).map((e) =>
        instantiateTemplate(t.body, e)
      );
      const member = inp.membership(t.collection);
      return {
        confidentiality: joinAll([
          member.confidentiality,
          ...parts.map((p) => p.confidentiality),
        ]),
        integrity: [
          ...hereditaryMeet(parts.map((p) => p.integrity)),
          ...inp.mint({ expression: true }),
        ],
      };
    }
  }
}
```

`NEUTRAL` is dropped by `hereditaryMeet`, so a `derive` over one slot and one
literal keeps the slot's hereditary atoms. A `derive` with no non-neutral
input has no inherited integrity.

The adapter around this function gathers the inputs: it resolves each slot's
address to a label through the existing consumed-label index
(`ConsumedLabelIndex`, `runtime/runner/src/cfc/consumed-label-index.ts`),
reads selections from the value code's result, and reads journaled handle and
link reads from the transaction.

### 4.3 Memoization

With labels held by content address
([content-addressed CFC labels](../content-addressed-cfc-labels.md)), a slot
label is an identifier and an instantiation is a function of identifiers:

```text
key   = (template hash, selections, slot label ids in template order)
value = label id
```

- The memo is a pure cache, shared across instances and patterns. Template
  hashes are slot-free (section 1.2), so equal templates over different slots
  share entries.
- A `fold` contributes the *set* of its elements' body label identifiers,
  because join and meet are idempotent. The runtime keeps a count per
  identifier with the fold's durable state, so adding or removing an element
  updates the set in constant time, and the fold's label changes only when an
  identifier's count crosses zero.
- A `dynamic` node contributes the identifiers of the labels its journaled
  reads consumed.
- That design holds label identifiers only above an inline size limit
  (`CFC_LABEL_INLINE_LIMIT` in `runtime/runner/src/cfc/label-documents.ts`).
  The memo key uses the hash of the label either way; whether the stored
  entry holds the label inline or by reference is unchanged.

For a `map` over `n` elements whose body has one template, `n` elements with
equal slot labels are one memo entry and one stored `*`-child entry.

### 4.4 Constraints

A constraint that today is checked against a transaction's reads becomes a
constraint on slots or on a write edge.

| Constraint | Today | In the plan |
| --- | --- | --- |
| `requiredIntegrity` on an input path | `verifyInputRequirements` over the reads before the last overlapping write | `I` of each listed slot satisfies the patterns, with one coherent witness across them |
| `maxConfidentiality` on an input path | Same function, same read set | `⊔` of `C` over the listed slots fits the ceiling |
| Write floor on a target | `verifyWriteFloor` on the written value's integrity | `I(template)` of the write edge satisfies the patterns |
| Writer-fit | Persist region of `prepareBoundaryCommitSteps`: the join fits the target's declared confidentiality | `C(template)` of the write edge fits it |
| `writeAuthorizedBy`, `writePolicyAnyOf` | `writeAuthorizedByReason`, `writePolicyAnyOfReason` at prepare | `Body.code` of the writing body is one the policy names |
| UI event integrity contract | `verifyTrustedEventRequirements`, with provenance recorded by `recordTrustedEventPolicyInputs` (`runtime/runner/src/cfc/ui-contract.ts`) | The event bound to the handler's `event` root satisfies the alternative's `uiContract` |
| Egress ceiling of an effect | `verifySinkRequestCeilings` over the whole transaction's consumed label | `C` of the effect operation's `input` template fits the ceiling |

The slots a `requiredIntegrity` or `maxConfidentiality` constraint lists are
the slots of the body's footprint whose path overlaps the annotated path, in
either prefix direction, which is the overlap the runtime uses today
(`buildWritePrefixBounds`).

**When a constraint is checked.**

- **At compile time**, when everything it reads is declared: every listed
  slot has a `declared` label for the dimension the constraint tests, or the
  constraint is about a body's identity. A violation is a compile error that
  names the slot and the annotation. The writer policy is always checkable at
  compile time for a static write edge, because both the body and the policy
  are in the source.
- **At instantiation** otherwise, with the labels the template was
  instantiated from. A failure refuses the write it guards.
- **Per event** for a UI contract. Whether an event came from the named
  surface is a fact about that event (`trustedEventProvenanceMatchesUiContract`
  in `runtime/runner/src/cfc/ui-contract.ts`). The compiler can still report
  the case where no element of the compiled pattern that binds the handler
  sits under a surface carrying the required pattern and integrity names,
  since then no event from this pattern's UI can satisfy the policy.

A compile-time check does not replace the run-time one. Declared labels are a
lower bound on what a slot carries: a derived component can add
confidentiality the schema does not declare (§8.12.8). So a compile-time pass
on `maxConfidentiality` settles nothing, and only a compile-time *failure* is
final: a requirement no label of the declared shape can meet. For
`requiredIntegrity` and the write floor a declared atom that satisfies the
pattern does settle it, because integrity is not unioned across components.

**Two deliberate changes.**

- The input gates quantify over the slots the guarded write depends on,
  instead of over every read before it. The set is a subset of today's, so a
  write is refused less often. What this rests on is in section 7.
- The egress ceiling moves from the transaction's whole consumed set to the
  effect's own inputs. §8.9.1.2 allows this move and requires it to be
  stated: "Each such move is an independent conformance choice and MUST be
  stated by the deployment profile."

## 5. Error states and termination

### 5.1 What the specification says

The normative chapters state no termination property. The formal development's
noninterference results are termination-insensitive: `FORMALIZATION.md`
describes the boundary theorem as "termination-insensitive observational
noninterference for committed trusted-boundary release". For a handler that
throws, §8.10.1 (`08-10-validation-at-boundaries.md`) has the attempt aborted
and reports `handler_failed`, and assigns no label to that outcome. For an
error that is *returned*, §5.4.1 (`05-policy-architecture.md`) gives the rule
this design follows: "the error response inherits the **full input
confidentiality**". The developer guide's treatment (§11.1.4, informative)
rests on one assumption, stated in §11.1.8: "Termination-insensitivity holds
when the observer is the same principal whose data influences the
computation."

One transaction per cause makes that assumption matter more. Today a node
that throws stops its own transaction and no other. If a cause's single
transaction aborted whenever any cone failed, a failure that depends on one
principal's data would withhold every other output of the same cause from
everyone, and the absence would be observable by principals who may not read
that data.

### 5.2 An error is a value with a label

A cone that fails does not abort the cause's transaction. Its outputs take an
**error state**, and the transaction commits the other cones' outputs
normally.

- **What fails a cone.** A sandboxed body throws; a body exceeds its time or
  memory budget; a cycle through side-writes does not converge within the
  iteration bound; a slot the cone reads is itself in an error state.
- **The label of an error state** is the label the output would have had: the
  output's template, instantiated with the selections taken up to the failure.
  A failed body contributes its whole footprint, the `reads` slots and
  whatever its handles had read. This is §5.4.1's rule. An error message is
  data computed from the body's inputs and has the same label.
- **Integrity.** An error state carries no inherited integrity: the
  `derive` rule's meet is replaced by the empty set. An error is not a value
  of the kind any upstream claim describes, and under-claiming integrity is
  the fail-safe direction (§8.9.3, staged conformance).
- **Storage.** For a kept output the error state is stored at the output's
  path with that label, like any value. An interim error is not stored.

### 5.3 Propagation stops unless something reads the error

An error state is an ordinary value to the plan. A cone that reads an errored
slot fails in turn, with its own template as the label, and that template
already contains the errored slot. A `select` whose unselected branch is in
an error state is unaffected, because it does not read it. A collection with
one errored element has one errored element: a `map` passes it on per
element, and a `fold` over it fails, since it reads every element.

So a failure reaches exactly the outputs whose template reaches it, and each
carries a label that covers the failure's cause.

### 5.4 Handlers

A handler body that throws writes nothing: its writes are discarded as they
are today (`finalizeFailure` in `runtime/runner/src/scheduler/events.ts`
aborts the transaction). Nothing else was in the transaction, because the
cones a handler dirties run after its writes.

The failure itself is an outcome with a label: the handler's template,
instantiated over what it read. It is reported to the party that delivered
the event, and it is stored only if the pattern reads the handler's status as
a state. A client that speculates the handler computes the same outcome from
the same plan.

### 5.5 What remains termination-insensitive

Turning failure into a labeled value closes the channel for failures the
runtime can detect. It does not close these, which the design accepts and a
deployment documents:

- **Divergence inside the budget.** A body that runs long delays the commit of
  its cause's transaction, and with it every output of that cause. The
  delay is observable to anyone who can read any of them. Budgets bound it.
  The specification treats timing as a residual in the same way: §8.9.2
  documents the trigger channel as "roughly one bit per change event", and
  §9.3.2 (`09-threat-model.md`) puts physical timing out of scope.
- **Demand.** Whether a cone is evaluated at all depends on whether something
  demands it. An output nothing demands keeps its last value and label.
- **Refusal.** A constraint that fails at instantiation refuses one write.
  The target keeps its previous value, and that it did not change is visible
  to its readers.

The two target theorems of the specification change are stated
termination-insensitively for this reason: bodies are total functions there,
and the commit outcome is an input both runs share.

## 6. Worked example: FabriChat

FabriChat lives in `patterns/system/fabrichat/` and is specified under
[`docs/specs/fabrichat/`](../fabrichat/README.md). This section takes a slice
of the room pattern: the send handler, the derivation that lists messages, the
empty-state test, and the per-row `map` with three of a row's derived values.

Two facts about the pattern shape the example:

- FabriChat declares integrity and write policy, and no confidentiality. Its
  specification says a message "is admitted only from a reviewed surface" and
  that the runtime "labels it with the principal who wrote it"
  ([FabriChat README](../fabrichat/README.md), Purpose).
- The trusted-UI gate is not a requirement on the handler's event schema. It
  is the write policy of the stored element type, `SentMessage` in
  `room-records.tsx`, which names each permitted handler together with the
  action and surface its event has to come from.

### 6.1 The source slice

The handler `commitSend` calls `sendInto`, which in outline:

1. resolves the sender's profile from `myProfile` and throws when there is
   none;
2. takes the text from `event.body`, or else `event.target.value`;
3. resolves `event.attachments` and throws when there are too many;
4. throws when there is neither text nor an attachment;
5. checks `event.replyTo` against `messages` when it is set;
6. creates a reactions list, and pushes
   `{ authorProfile, body, attachments?, sentAt, replyTo?, reactions }` onto
   `messages`;
7. optionally writes a thread title record, and sends on the `joined` stream.

The room pattern then derives, in `room.tsx`:

- `facts = computed(() => messageFacts(messages, threadTitles(threadInfo)))`,
  whose `main` field is the list of message cells shown in the main view;
- `isEmpty = computed(() => facts.main.length === 0)`;
- `facts.main.map((message) => <FabriChatMessageRow message={message} … />)`.

Each row, in `message-row.tsx`, derives among others:

- `text = computed(() => bodyText(message.get()))`, where `bodyText` returns
  the body when it is a string and otherwise one of two fixed sentences,
  chosen by whether `authorProfile` is present;
- `isEdited`, true when `editedAt` is present and the body is a string;
- `replies`, read from `places.key(key).get()?.replies` with `key` computed
  from the message's identity, and `threadLabel`, which is
  `replies === 1 ? "1 reply" : …`.

### 6.2 The plan for the slice

Slots, written `root path : class`:

```text
s0  argument  messages                 : enumeration
s1  argument  messages/*               : identity
s2  argument  myProfile                : identity
s3  argument  threadInfo               : identity
e0  event     body                     : value
e1  event     target/value             : value
e2  event     attachments              : enumeration
e3  event     attachments/*            : identity
e4  event     replyTo                  : value
e5  event     threadTitle              : value
m0  element   (root)                   : shape      of collection c1
m1  element   (root)                   : identity
m2  element   body                     : value
m3  element   body                     : shape
m4  element   authorProfile            : shape
m5  element   editedAt                 : shape
p0  argument  places                   : identity   (row argument)
```

Bodies:

```text
B0  handler  commitSend
      reads    e0 e1 e2 e3 e4 e5 s2
      handles  myProfile, messages, threadInfo
      writes   state messages/*      template T_send   constraints [k0, k1]
               state reactions       template T_send
B1  computed messageFacts
      reads    s0 s1 s3
      handles  messages, threadInfo
B2  computed bodyText      reads m0 m1 m2 m4
B3  computed isEdited      reads m0 m1 m3 m5
B4  computed replies       reads m1          handles places
```

`messages` is a handle of `B0` and `B1` because both read through it at
addresses they compute: `B0` checks a reply against the list, and `B1` walks
each message cell. `myProfile` is a handle of `B0` because the handler
resolves the link and reads the profile behind it.

Templates:

```text
T_send   = derive(by B0)  [ e0 e1 e2 e3 e4 e5 s2
                            dynamic(handle B0.myProfile)
                            dynamic(handle B0.messages)
                            dynamic(handle B0.threadInfo) ]

T_facts  = derive(by B1)  [ s0 s1 s3
                            dynamic(handle B1.messages)
                            dynamic(handle B1.threadInfo) ]

T_empty  = derive(expression) [ T_facts, const ]

c1       = collection  source: facts.main   membership: T_facts
                       key: identity

T_text   = derive(by B2)  [ m0 m1 m2 m4 ]
T_edited = derive(by B3)  [ m0 m1 m3 m5 ]
T_repl   = derive(by B4)  [ m1  dynamic(handle B4.places) ]
T_label  = select( condition: derive(expression) [ T_repl, const ],
                   branches:  [ const,
                                derive(expression) [ const, T_repl ] ] )
```

`facts` is one opaque call, so every path of its result has `T_facts`,
`facts.main` included. `isEmpty` is a pure expression over `facts.main.length`
and is promoted; its template is the template of what it reads. `m0`, the
element's membership, resolves to the collection's membership template
`T_facts` (section 3.7 states the same substitution for derived
collections).

Constraints on the write to `messages/*`:

```text
k0  writer  anyOf [ { body: hash(commitSend),
                      uiContract: { helper: UiAction, action: ChatSend,
                                    trustedPattern: ChatSendSurface,
                                    requiredEventIntegrity:
                                      [ChatSendSurface] } },
                    … the other six handlers the type names … ]
k1  writerFit
```

Kept outputs in the slice: the room's `messages` output (from `facts.list`),
and the rendered tree under `[UI]`, which holds the empty-state branch and
each row's text, edited mark and thread label. `facts.entries`, `replies` and
the condition of `T_label` are interim.

### 6.3 The gate on the send handler

`k0` has two parts, checked at different times.

- **The writer.** `commitSend` is the body that performs the write edge, and
  the first alternative of the policy names it. The compiler checks this, and
  a handler that pushed a `SentMessage` without being named in the type would
  not compile. Today this is `writePolicyAnyOfReason` at prepare.
- **The event.** Whether the event came from an element under the
  `ChatSendSurface` pattern with the `ChatSend` action is a fact about the
  event. The runtime checks it when it instantiates the handler's write
  edge, with the same predicate as today
  (`trustedEventProvenanceMatchesUiContract`). A client that speculates the
  handler evaluates the same constraint from the same plan and refuses
  locally what the server will refuse.

In the room's rendered tree the composer is a submit input inside an element
that carries the surface's pattern and integrity names, and it binds
`commitComposerSend`, which the policy also names. The compiler can verify
that such an element exists for each handler the pattern binds to a control.
`commitSend` itself is bound to the exported `sendMessage` stream, whose
events come from other patterns, so for it the check is per event only.

`sendInto` throws in five places. Each is a handler failure in the sense of
section 5.4: nothing is written, and the outcome's label is `T_send`
instantiated over what had been read. The first throw, for a missing profile,
happens before the event is read, and its outcome still carries the whole
static footprint: an opaque body's label does not depend on how far it got.

### 6.4 Instantiated labels

Write `L(x)` for the label of slot `x`, and `D(h)` for the join of what the
journaled reads through handle `h` consumed.

| Output | Instantiated confidentiality | Instantiated integrity |
| --- | --- | --- |
| New message (every field) | `C(e0..e5) ⊔ C(s2) ⊔ C(D(myProfile)) ⊔ C(D(messages)) ⊔ C(D(threadInfo))` | Declared authorship atom; `⊓` over the same inputs; `TransformedBy(commitSend)` when the join is not empty |
| `facts`, every path | `C(s0) ⊔ C(s1) ⊔ C(s3) ⊔ C(D(messages)) ⊔ C(D(threadInfo))` | `⊓` over the same; `TransformedBy(messageFacts)` |
| `isEmpty` | Same as `facts` | `⊓` over the same; `TransformedBy(pattern)` |
| Row `text` | `C(facts) ⊔ C(m1) ⊔ C(m2) ⊔ C(m4)` | `⊓` over the same; `TransformedBy(bodyText)` |
| Row `isEdited` | `C(facts) ⊔ C(m1) ⊔ C(m3) ⊔ C(m5)` | likewise |
| Row `threadLabel` | `C(m1) ⊔ C(D(places))` | from the selected branch |

**In the deployed configuration** every one of these confidentialities is
empty, because FabriChat declares none and a room's messages, events and
roster carry none. The stored label of a new message is then the declared
entry alone: integrity holding the authorship atom for the sender, origin
`declared`. The test `runtime/runner/test/cfc-boundary.test.ts` pins that
shape for this schema idiom (its `commitTrustedMessageSend` cases), and
`patterns/system/fabrichat/labels.test.tsx` asserts the authorship through
`principalOf`. The authorship atom is value-bound, not hereditary
(`runtime/runner/src/cfc/atom-classes.ts`), so no derived row value inherits
it, today or under templates. A row shows authorship by binding the message's
own `body` and `authorProfile` cells into the authorship component, which is
a pass-through and keeps the atom under both.

### 6.5 Against what the runtime stores today

| Output | Today | Template |
| --- | --- | --- |
| New message | Handler transaction's join over the event and state reads, plus the declared atom | Same set |
| `facts` | `computed` node's join | Same set |
| `isEmpty` | Its own node and document; the join of reading `facts.main`'s length | Same label; no node or document |
| Row `text` | The row node reads `message.get()`, the whole record as its schema materializes it: `body`, `sentAt`, `editedAt`, `replyTo`, and the slots of `authorProfile`, `attachments` and `reactions` | `body` and the presence of `authorProfile` |
| Row `isEdited` | The whole record, as above | The presence of `editedAt` and the kind of `body` |
| Row `threadLabel` | Its own node; reads `replies`, another node's document | The label of the `places` entry read, through the `select` |

For `text` and `isEdited` the template is tighter whenever a field the value
does not depend on carries a label the others do not. In FabriChat that
happens after an edit or a reaction: `commitEdit` rewrites `body` and
`editedAt` in a later transaction with its own join, and the reactions list is
a document of its own. With FabriChat's actual labels the instantiated labels
are equal, because all of them are empty.

What differs in the deployed configuration is the amount of work and storage.
The measured second load of a thirty-message room made 615 CFC preparations
for 190 commits, with about four or five session-scoped derivation commits
per row
([row-instance investigation](../../history/development/performance/2026-10-16-fabrichat-row-instances.md)).
Under the plan:

- A load is one cause. It instantiates `T_facts` once, and the row templates
  once per distinct instantiation key. Thirty rows whose slot labels are equal
  are one memo entry per row template.
- A send is one cause and one transaction: the handler's writes, `facts`,
  `isEmpty` if its value changed, and one new row. The other rows are not
  evaluated, because the cones are keyed by element identity.
- Row derivations that only feed other derivations, such as `replies`, have
  no document and no label.

## 7. What rests on the compiler

### 7.1 The specification's requirement

§8.9.1 (`08-09-runtime-label-propagation.md`) lets a runtime apply a label
less restrictive than the conservative one only on a trust decision: "If
`L_claim` is less restrictive than `L_default`, runtime MUST require that the
executing implementation identity … is trusted for concept
`https://commonfabric.org/cfc/concepts/flow-taint-precision` for the acting
user." §8.9.2 says the same of excluding an observed input from the
flow-path join.

§8.5.4.3 anticipates where such claims come from: "a trusted compiler or
transformer asserting element-locality of code it lowered".

A template is such a claim wherever it is narrower than a structural fact the
runtime records itself. The rest of this section separates the two.

### 7.2 What does not rest on compiler correctness

These hold whatever the compiler emitted, because the runtime enforces them.

- **Cone narrowing.** The runtime passes a cone's value function exactly the
  slots in `Cone.slots`. A cone cannot compute from data it was not given. So
  for any output of a cone, the join over *all* of the cone's slots, every
  branch included, is a sound label, and it is a structural fact of the
  decomposition class of §8.9.1, like a per-element journal. This is the
  design's `L_default`.
- **Body narrowing.** The runtime builds a sandboxed body's argument from
  `Body.reads` and hands it only the listed handles. A footprint that omits a
  slot starves the body. Data outside a body's footprint stays confidential
  from the body however wrong the analysis is.
- **Dynamic reads.** Reads through handles and links are journaled by the
  runtime, as they are today.
- **Statelessness between calls.** Two calls in one transaction do not share
  mutable state. The loader verifies this property of the sandbox itself
  ([SES sandboxing](../sandboxing/SES_SANDBOXING_SPEC.md)); the compiler's
  check produces diagnostics, and the loader's is the enforcement. This is
  what lets one transaction hold many calls without their labels merging: it
  is the instance rule of §8.9.1.2 with the instance's shared state empty.
- **The template evaluator and the constraint checks.** `instantiateTemplate`
  and the checks of section 4.4 are the runtime's. Labels are resolved from
  stored envelopes by the runtime. No emitted code computes or compares a
  label.
- **Writer identity.** A write policy names a body by content address, and
  the runtime knows which body it invoked.

### 7.3 What does rest on compiler correctness

These are narrower than the cone-level join, and the runtime cannot check
them. They hold only if the value code computes what the plan says.

- **Per-path templates inside a cone.** That output path `p` depends on the
  slots of its template and not on the cone's other slots.
- **Selection.** That the unselected branch of a `select` did not influence
  the result, and that the reported selection is the one taken.
- **Element locality inside one value function.** Where the runtime invokes
  a `map` body per element with only that element's slots, locality is
  structural and belongs to section 7.2. Where the emitted value function
  iterates itself, locality is the compiler's claim.
- **Membership of `flatMap`.** That positions depend on segment lengths and
  not on segment contents.
- **Wiring.** That the result of body `B` is what flows to the outputs whose
  templates name `B`.
- **Gating sets.** That a guarded write depends only on the slots its
  constraint lists (section 4.4).

### 7.4 The `flow-taint-precision` claim

The asserting component is the compiler. Its identity is
`CompiledPattern.compiler`, the build that produced the plan and the value
code together.

- When that identity is trusted for `flow-taint-precision` for the acting
  user, the runtime applies templates as emitted.
- When it is not, the runtime uses the cone-level join of section 7.2 for
  every output of the cone, and the gating set of every constraint is the
  cone's slot list. Values are unaffected. This is the fail-closed branch of
  `deriveLabelWithTrustGate` in §8.9.1, with `L_default` the cone-level join.

Because the compiler is trusted, a runtime compiles from source itself or
accepts a compiled pattern from a party it already trusts to execute the
pattern. The claim is about propagation precision only: §8.9.1 says of the
mechanism that "it does not grant declassification", and a template never
removes a clause any of its slots carries.

### 7.5 How the trust is kept small

- **The calculus is mechanized.** The specification change carries a Lean
  development of the plan's operations with two target theorems: that
  instantiating a template yields the label of labeled evaluation, and
  noninterference for one transaction per cause. Which parts are proved is
  recorded with that change. The theorems are about the plan's semantics,
  not about the compiler's lowering of source into a plan.
- **The plan's types come from the proof.** The record types of section 1.1
  are to be generated from the Lean definitions, so the runtime, the compiler
  and the proof read one definition.
- **A differential oracle.** The Lean evaluator is executable. For every
  pattern in the corpus, the labels the runtime instantiates are compared
  with the labels the Lean evaluator computes from the same plan and inputs.
- **Stage 3 of the overview** compares template labels with the labels the
  current runtime computes, over the whole corpus, before any template is
  enforced. That comparison is the test of every row of section 3.13.

## 8. Open questions

Each entry states the assumption this document made.

1. **Is the rendered tree kept?** The overview defines the keep set as
   everything reachable from the result cell, and `[UI]` is part of the
   result. *Assumed:* yes, so a row's rendered values are kept outputs, and
   the storage saving is that they are path entries of one document instead
   of a document per node. If the rendered tree were recomputed by each
   client and not stored, the keep set of a UI-heavy pattern would be much
   smaller, and the render boundary would take its labels from local
   instantiation alone.
2. **Per-write templates for sandboxed bodies.** The overview gives a body's
   outputs one template, the union of its footprint. A handler that writes
   two cells from disjoint inputs then gives both the join. *Assumed:* one
   template per body, which equals today's label. Footprint analysis could
   emit a template per written path; that would be a further claim under
   section 7.3.
3. **The identity a `TransformedBy` atom names for expression code.**
   *Assumed:* the compiled pattern. Today the atom names the node's
   implementation. Whether consumers of the atom
   ([`TransformedBy` input witnesses](../cfc-transformed-by-input-witnesses.md))
   need a finer identity, such as pattern and output path, is not settled.
4. **Which atom identifies the compiler.** §8.9.1 names `CodeHash` and
   `Builtin` as implementation identities. *Assumed:* the compiler build's
   content address, as a `CodeHash`. A runtime that compiles from source
   itself could instead treat the compiler as part of its own identity, in
   the manner of the runtime-owned interpreter of §8.9.1.2.
5. **The interpreter-profile obligations.** §8.9.1.2 refers to "the
   obligations of a conforming interpreter profile" in chapter 18, and
   chapter 18 has no such section. The cone-narrowing and body-narrowing
   rules of section 7.2 are this design's candidates for those obligations.
   *Assumed:* the specification change states them as a new profile.
6. **Refusal granularity.** When a constraint fails at instantiation, this
   document refuses the one write it guards and commits the rest of the
   cause's transaction. Today prepare rejects the whole transaction. For a
   handler the two coincide. For derived outputs, rejecting the whole
   transaction would reopen the channel of section 5.1. *Assumed:* per
   write.
7. **Demand as a channel.** Section 5.5 lists it as accepted. Whether a
   kept output that nothing demands should be marked stale, so that a later
   reader can tell, is undecided.
8. **`shape` versus `enumeration` in storage.** The plan separates them and
   the runtime's entry classes do not (section 2.2). *Assumed:* both resolve
   as a `shape` read until a count entry exists.
9. **Literals and integrity in the proof.** The existing Lean expression
   language gives a literal an empty integrity, which empties the meet of
   anything combined with it. Section 3.2 makes `const` neutral, as the
   runtime does. The Lean development of the specification change keeps the
   existing convention, which under-claims integrity. *Assumed:* acceptable
   for the confidentiality theorems; an integrity theorem needs the neutral
   element.
10. **`count` over a raw list.** Section 3.8 marks `count` "equal or
    tighter" pending the stage 3 comparison.
11. **Nondeterministic inputs.** A handler reads the clock (`sendInto` stamps
    `sentAt`). *Assumed:* the clock and random sources are unlabeled inputs
    with no slot. If any of them should carry a label, it needs a slot root
    of its own.
12. **Where provenance is stored.** The overview says a kept output carries
    its template, the identities bound to its slots, and the compiled
    pattern's identity. *Assumed:* beside the envelope's label map, keyed by
    output path, with the instantiation key of section 4.1 derived from it.
    The stored format is a host arrangement and is not specified here.
13. **Label metadata observations.** Today the flow join includes label
    metadata a transaction observed
    ([label metadata confidentiality](../cfc-label-metadata-confidentiality.md)).
    A body that inspects labels needs a slot for it. *Assumed:* such reads
    are dynamic and journaled, like handle reads.
