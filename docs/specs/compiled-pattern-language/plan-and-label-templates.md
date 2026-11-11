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

export type ObservationClass =
  | "value"
  | "shape"
  | "enumeration"
  | "identity"
  /** The stored label of the path, not its content (section 2.4). */
  | "labelMetadata";

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
  | { readonly kind: "operation"; readonly operation: Index }
  /** The result of a child instance (`Plan.children`). */
  | { readonly kind: "child"; readonly child: Index }
  /** The state a handler was bound to: its copied captures. */
  | { readonly kind: "binding"; readonly handler: Index }
  /** A property of the cause: path `eventKey` or `principal`. */
  | { readonly kind: "cause" }
  /** The private parameters a pattern closure was bound to (section 3.15). */
  | { readonly kind: "params" };

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
  /**
   * Conditional selection. One of three nodes whose label depends on a
   * value, with a `fold` that has `through` and a `pick`.
   */
  | {
    readonly op: "select";
    readonly selector: Index;
    readonly condition: Template;
    readonly branches: readonly Template[];
  }
  /**
   * A join over the elements of a collection: all of them, or, when
   * `through` is set, the leading elements up to and including the position
   * that selector reports.
   */
  | {
    readonly op: "fold";
    readonly collection: Index;
    readonly body: Template;
    readonly through?: Index;
  }
  /**
   * One child chosen by a run-time key: an element of a collection, or a
   * child of a container slot. `body` is over the chosen child's slots.
   */
  | {
    readonly op: "pick";
    readonly from:
      | { readonly collection: Index }
      | { readonly container: Index };
    readonly choice: Template;
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
  /** The input collection, or what this one is derived from. */
  readonly source:
    | { readonly slot: Index }
    | {
      readonly collection: Index;
      readonly via: "map" | "filter" | "flatMap";
    }
    /** A bucket of a collection index (`Plan.operations`). */
    | { readonly operation: Index };
  /** The label of which elements are present and in what order. */
  readonly membership: Template;
  /**
   * Whether a body applied to this collection uses the element's index,
   * which makes the position part of an element's key (section 1.3). The
   * element part of the key is not recorded: it follows from each element
   * at run time.
   */
  readonly bodyUses: { readonly index: boolean };
}

/** One sandboxed function body and the result of footprint analysis. */
export interface Body {
  /** Content address of the body's source as the loader receives it. */
  readonly code: Hash;
  readonly kind:
    | "lift"
    | "computed"
    | "action"
    | "handler"
    | "assert"
    /** An authored module-scope function called from the reactive tier. */
    | "function"
    /** A function of an imported TypeScript module; its body is opaque. */
    | "imported";
  /** Slots the runtime materializes into the body's argument. */
  readonly reads: readonly Index[];
  /**
   * Cell handles the body receives. Reads through a handle are journaled
   * while the body runs and enter the label as a `dynamic` template.
   */
  readonly handles: readonly Index[];
  /** Paths the body writes, with the constraint set of each. */
  readonly writes: readonly WriteEdge[];
  /**
   * Result paths that are not plainly computed from the whole footprint
   * (section 3.9). A path with no entry is computed.
   */
  readonly outputs: readonly BodyOutput[];
  /** The runtime calls the body can make (section 3.14). */
  readonly calls: readonly BodyCall[];
  /** Where analysis gave up, for diagnostics. Each widened a `reads` slot. */
  readonly widenings: readonly Widening[];
}

/** How one path of a body's result relates to the body's inputs. */
export interface BodyOutput {
  readonly path: Path;
  /**
   * `passes`: the reference at this path is always the reference at one
   * `identity` slot. `oneOf`: it is always the reference at one of several.
   * The runtime verifies either by reference identity.
   */
  readonly reference?:
    | { readonly passes: Index }
    | { readonly oneOf: readonly Index[] };
  /** The result schema requires the path, so its existence is constant. */
  readonly required?: true;
}

/**
 * A site in a body that makes a runtime call. A site can run any number of
 * times in one invocation; each occurrence gets its own identifier
 * (section 1.3).
 */
export type BodyCall =
  /** Instantiates a pattern and returns a link to the instance. */
  | {
    readonly kind: "instantiate";
    readonly child: Index;
    readonly identifiedBy: "order" | "tag";
  }
  /** Creates a cell and returns a handle to it. */
  | {
    readonly kind: "createCell";
    readonly schema: Hash;
    readonly scope: "space" | "user" | "session";
    readonly identifiedBy: "order" | "cause";
  }
  /** Requests an effectful built-in and returns a link to its result. */
  | { readonly kind: "effect"; readonly builtin: string }
  /** Binds a handler to captured values and returns its stream. */
  | { readonly kind: "bind"; readonly binding: Index };

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
    | { readonly kind: "state"; readonly cell: Index; readonly path: Path }
    /** The argument document of a child instance. */
    | { readonly kind: "argument"; readonly child: Index; readonly path: Path }
    /** A cell the body creates at a `createCell` site (`Body.calls`). */
    | { readonly kind: "created"; readonly call: Index; readonly path: Path }
    /** The anchors document of the field at an `identity` slot. */
    | { readonly kind: "anchors"; readonly of: Index };
  /** The label of the value written. */
  readonly template: Template;
  readonly constraints: readonly Index[];
}

/** A set of reads resolved at run time. */
export interface DynamicReads {
  readonly why:
    | { readonly kind: "link"; readonly through: Index }
    | { readonly kind: "handle"; readonly body: Index; readonly handle: Index }
    /** The access list of the space an `identity` slot's target lives in. */
    | { readonly kind: "space"; readonly of: Index }
    /** Candidates a search found through links (section 3.19). */
    | { readonly kind: "search"; readonly body: Index };
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
  /** Content address of that function's emitted source. */
  readonly code: Hash;
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
  /**
   * The collection whose element key joins the cause, inside an element
   * body. Legal only where that key is a cell's identity or holds the
   * index (section 1.3).
   */
  readonly perElementOf?: Index;
  readonly schema: Hash;
}

/** An operation with durable state of its own. */
export interface Operation {
  readonly kind:
    | "effect"
    | "aggregate"
    | "reduce"
    | "index"
    | "cache"
    | "materializer";
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

/**
 * A pattern instantiated with a plan of its own: a pattern received as a
 * factory value, or any pattern a function body instantiates (section 3.15).
 */
export interface Child {
  /** The pattern: known at compile time, or the factory at a slot. */
  readonly callee:
    | { readonly compiled: Hash }
    | { readonly factory: Index };
  /** Declared by the callee's type; what the enclosing plan checks against. */
  readonly argumentSchema: Hash;
  readonly resultSchema: Hash;
  /** The cause the instance's identifier derives from. */
  readonly name: string;
  readonly perElementOf?: Index;
  /** `asScope`: the scope of the state the instance declares. */
  readonly scope?: "space" | "user" | "session";
  /** `inSpace`: the target space and the options of the request. */
  readonly space?: SpaceRequest;
}

/** What an `inSpace` request records (section 3.14). */
export interface SpaceRequest {
  /** Which space the instance is created in. */
  readonly target:
    /** A space identifier. */
    | { readonly kind: "identifier"; readonly space: RequestValue }
    /** The space the cell at an `identity` slot lives in. */
    | { readonly kind: "spaceOf"; readonly cell: Index }
    /** A name the calling space resolves. */
    | { readonly kind: "name"; readonly name: RequestValue }
    /** A space of the site's own, which has no name. */
    | { readonly kind: "anonymous" };
  /** The options written at the site. An absent member was not written. */
  readonly grants?: RequestValue;
  readonly root?: RequestValue;
  readonly spaceKind?: RequestValue;
  readonly selfOwned?: RequestValue;
}

/** A value of an `inSpace` request: a constant of the site, or a slot. */
export type RequestValue =
  | { readonly constant: unknown }
  | { readonly slot: Index };

/**
 * A pattern closure used as a value: an inline pattern bound to what it
 * captures (section 3.15). It is what a `factory` slot holds when the
 * factory was written in this plan.
 */
export interface Closure {
  /** The compiled identity of the inline pattern. */
  readonly pattern: Hash;
  /** What is bound to each path of the pattern's private parameters. */
  readonly params: readonly {
    readonly path: Path;
    readonly template: Template;
    /** A data value is copied into the factory value; a cell stays a link. */
    readonly capture: "copy" | "link";
  }[];
}

/**
 * A handler bound to state: in the reactive tier, or at a `bind` site of a
 * body (section 3.14). The handler is a body of this plan, or a handler
 * factory received as a value (section 3.21).
 */
export interface Binding {
  readonly handler:
    | { readonly body: Index }
    | { readonly factory: Index };
  /** For a factory value, declared by the factory's type. */
  readonly eventSchema: Hash;
  readonly stateSchema: Hash;
  /** What is bound to each path of the handler's state. */
  readonly state: readonly {
    readonly path: Path;
    readonly template: Template;
    /** A data value is copied into the binding; a cell stays a link. */
    readonly capture: "copy" | "link";
  }[];
  /** For a binding in the reactive tier: the cause of its stream. */
  readonly name?: string;
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
  readonly children: readonly Child[];
  readonly closures: readonly Closure[];
  readonly bindings: readonly Binding[];
}

/** What the compiler emits, addressed as one thing. */
export interface CompiledPattern {
  readonly plan: Hash;
  readonly valueCode: Hash;
  /**
   * Content address of the compiler build that produced both. A
   * deployment accepts a stated set of builds (section 7.2).
   */
  readonly compiler: Hash;
}
```

The **keep set** is the outputs with `kept: true`. The rendered tree under
`[UI]` is part of the result and is kept, so a value bound into it is a kept
output. The saving for such a value is that it is a path entry of the result
document with a memoized label, not a document and a transaction of its own.

The keep set is a property of the pattern and not of a run: the compiler
knows which output paths the result cell's schema reaches.

A pattern compiled into another has no plan of its own: a `map` body, an
inline sub-pattern, and a call in the reactive tier of a pattern the compiler
can see. Its slots, bodies and cones are entries of the enclosing plan, with
`element` roots where it reads the element. A pattern the compiler cannot
see at the call, and any pattern a function body instantiates, is a `Child`
with a plan of its own (section 3.15).

This document defines the footprint *record* (`Body.reads`, `handles`,
`writes`, `outputs`, `calls`, `widenings`). The analysis that fills it in is
specified in `footprint-analysis.md`.

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
  (`WriterPolicy.body`) and the identity a `TransformedBy` atom carries for a
  value the body computed.
- **Cone identity** is `Cone.code`, the hash of the cone's emitted value
  function. It is the identity a `TransformedBy` atom carries for a value
  computed by expression code, so the atom names the code that ran, as it
  does for a body.
- **Compiler identity** is `CompiledPattern.compiler`, a `CodeHash` atom over
  the compiler build.

### 1.3 Causal identities and element keys

A state cell's document identifier derives from the cause of its creation: the
instance, the element keys of the element bodies it is declared in, outermost
first, and `name`. The compiler derives `name` as the transformer does today,
from the variable the cell is assigned to. A durable operation's state
document and a child instance's result cell are named the same way.

**Element keys.** An element of a collection is identified by a key the
runtime computes from the element itself:

- the element's **value**, canonicalized and hashed, when the slot holds a
  plain value;
- the **identity of the cell** the slot links to, when it holds a link.

A link to a plain value is keyed by the cell it links to, so two cells that
hold equal values are two elements. A hole has no key, gets no cone, and
stays a hole. An explicit `undefined` is a plain value. A plain value edited
in place is a new element.

A key derived from a value is salted with a secret of the space before it
enters a document identifier, as the row identifiers of `sqliteQuery` are
(`builtin-inventory.md`, "Element keys"). Without the salt an identifier
would reveal a low-entropy value to anyone who can see a link.

The position is part of the key only when the body uses the index
(`Collection.bodyUses.index`). A key then is the pair of the element part and
the index.

The purpose of the rule is that an element that moves keeps its cone, so
reordering a collection recomputes nothing. Keeping the identifiers of
per-element state that is already stored is not a goal: today's key is the
target's identity plus an occurrence count for a linked slot and the position
for an inline value (`listElementKeys` in
`runtime/runner/src/builtins/list-element-keys.ts`), and stored per-element
documents under those keys are not found again.

Consequences, which later sections rely on:

- **Equal elements share one cone.** Two positions that hold equal plain
  values, or links to the same cell, have the same key. The value is computed
  once and both positions receive it. That is sound because a body is a
  function of its element, its captures, and the index only when it uses the
  index.
- **State and handlers need an element with an identity.** A state cell
  with `perElementOf`, and a handler bound in an element body, exist only
  where the element's key is a cell's identity or holds the index. An
  element body over plain values that declares a state cell or binds a
  handler without using the index is a compile error: two rows that show
  the same value would otherwise share one flag and one stream. The author
  uses the index, or makes the elements cells, which a list of records
  written by a handler already is. Two positions that link to the same cell
  are the same element and do share its state.

  The compiler reports the error where the element type is a primitive, or
  the collection is one the instance constructs inline. For a record-typed
  input the compiler cannot tell a stored link from an inline record.
  *Assumed:* such an element body compiles, and an element that arrives
  inline at run time fails its cone (section 5.2), so that sharing never
  happens silently.
- **Values are per key, labels are per position.** The two positions can
  carry different labels, because a label is stored at an address and the
  addresses differ. The element slots of a template are therefore bound per
  position, to the address the element was read from, and for a linked
  element additionally to the cell. A position's label is instantiated from
  its own binding. Equal bindings give equal instantiation keys, so the memo
  of section 4.3 makes the common case one instantiation.
- **A move is a membership change and nothing else.** It dirties the
  collection's membership and rebinds the moved positions' element slots. The
  label identifiers at the new addresses are normally those at the old ones,
  and then no element is evaluated and no label is instantiated.
- **An index-using body does not have this property.** Its key holds the
  index, so a move recomputes the moved elements, and its element template
  includes the collection's `enumeration` (section 3.6).
- **Keying is the runtime's observation, not the body's.** Deciding which
  cone an element belongs to compares element values. The comparison flows
  into no element's output, since each output is a function of its own
  element. It decides which positions share state, which is why the key is
  salted.
- **Derived collections carry their elements' keys.** The elements of a
  `filter` result are the source's elements, with their keys. The elements
  of a `map` or `flatMap` result are new values or references and are keyed
  by the same rule when another body is applied to them. Aggregates and
  collection indexes hold one contribution per key with a count (sections
  3.8 and 3.17). `reduce` is the exception: its steps are ordered and are not
  keyed (section 3.13).

**Identifiers of things a function body creates.** A site in a body
(`BodyCall`) can run any number of times. Each occurrence is identified as
follows.

| Created in | Identified by |
| --- | --- |
| A handler, no explicit cause | The event's key and the occurrence's ordinal among the handler's requests in that invocation. A retry of the same event with the same control flow names the same things. A handler binding is the exception: it is identified as in the last row everywhere |
| A handler, `.for(tag)` | The handler's instance and the tag, so that different events name the same thing |
| A `lift` or `computed` | An explicit cause (`createCell`), or the enclosing instance, the handler, and the captured values and cells (`bind`). Never an ordinal, because such a body is re-evaluated. Captured values are salted like element keys. Such a body neither instantiates a pattern nor requests an effect |

## 2. Slots and observation classes

### 2.1 The classes

A slot is one input at one path observed in one way. The class says what the
computation learns.

| Class | What is learned | Typical source construct |
| --- | --- | --- |
| `value` | The content at the path, recursively | Reading a scalar; passing a subtree to a body that reads all of it |
| `shape` | That the path exists, and its kind | `x !== undefined`, `typeof x`, truthiness of an object |
| `enumeration` | Which children a container has, their order and count | `.length`, iteration, `map` membership |
| `identity` | Which reference sits at the path, not what it refers to | Passing a link on, comparing two cells |
| `labelMetadata` | The label stored for the path | `principalOf`, `inspectConfLabel` (section 2.4) |

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

### 2.4 Label metadata, and the inventory's three unplaced reads

`builtin-inventory.md` (open question 1) lists three reads that do not fit
value, shape, enumeration, or identity. Each is placed as follows.

- **Truthiness at the root of a condition** needs no new class. It is `value`
  at the root for a scalar and `shape` at the root for a record or array,
  whose truthiness is its existence (section 3.5).
- **The pointer label of a link that is followed** is the `identity` slot of
  the link. It resolves to the slot's `followRef` entries, and following the
  link joins it with the target's observations (section 3.10).
- **Label metadata** is a fifth class, `labelMetadata`. The specification
  makes observing a label a labeled observation of its own (§4.6.4.1,
  `04-label-representation.md`), and the runtime already has the class
  (`LABEL_METADATA_OBSERVATION` in
  `runtime/runner/src/cfc/label-view-core.ts`).

A `labelMetadata` slot does not read the value at its path. Its label is the
label of the metadata observation, which the runtime resolves from the
label-metadata templates of the target's envelope and computes in hand where
there are none
([label metadata confidentiality](../cfc-label-metadata-confidentiality.md)
§3). Where that label cannot be established the observation fails closed and
the read returns the constant the built-in defines for "not available". The
runtime records such an observation on the transaction today
(`recordCfcLabelMetadataObservation`, called from `inspectStoredConfLabel` in
`runtime/runner/src/cfc/label-introspection.ts`), and the flow join consumes
its confidentiality; the template's `slot` node does the same.

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
integrity atoms. Each rule that is tighter says what the narrowing rests on.
**There is one exception.** The collection index (section 3.17) is looser
than today, deliberately: a bucket's membership label includes the key of
every element, where the runtime today stores only the labels of the
elements in the bucket. Exclusion from a bucket is an observation, so the
wider label is the correct one. The stage 3 comparison expects this
difference and no other in that direction (section 7.5).

### 3.2 Template semantics

For a template `t`, with `sel(i)` the branch the value code reported for
selector `i`:

| Node | `C(t)` | `I(t)` |
| --- | --- | --- |
| `const` | empty | neutral for `⊓` |
| `slot s` | `C(s)` | `I(s)`, unchanged |
| `derive` | `⊔` of `C` over `inputs` | `⊓` of `I` over `inputs`, plus `TransformedBy` for `by` |
| `select` | `C(condition) ⊔ C(branches[sel])` | `I(branches[sel])` |
| `fold` | `C(membership) ⊔` the `⊔` of `C(body)` over the elements it covers | `⊓` of `I(body)` over those elements, plus `TransformedBy` |
| `pick` | `C(choice) ⊔ C(body)` at the chosen child | `I(body)` at the chosen child |
| `dynamic` | `⊔` of the labels the journaled reads consumed | `⊓` over those reads |

Notes on the integrity column:

- **`slot` keeps every class of atom.** It is a pass-through, and §3.1.6.2
  (`03-core-concepts.md`) says of pass-through and exact copy that "the output
  integrity at the path MUST be the input integrity unchanged, across **all**
  propagation classes".
- **`derive` drops value-bound atoms and mints.** This is the default
  transition of §8.9.3 applied to the template's inputs instead of to a
  transaction's reads. The minted atom names `Body.code` for a sandboxed
  body, and `Cone.code` for emitted expression code (section 1.2).
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

The condition's slots have the class the test needs: `value` at the root for
a scalar condition, `shape` at the root for a record or array, whose
truthiness is its existence. Nothing below the root is observed (section
2.4).

When the selected arm of `&&` or `||` *is* the condition, the result carries
that operand's full template, not only its truthiness.

The result is the selected operand itself, not a copy: a reference stays the
same reference, and a default declared on the operand's schema reaches
readers of the result, as it does today.

The callable forms `ifElse`, `when` and `unless` are not operations of their
own. Where the compiler still accepts them it maps each to this operation,
and the `str` tag to a template literal (section 3.19).

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
- **Index.** A body that uses the index adds the collection's `enumeration`
  to its element template, because an element's index depends on the order
  of the others. A callback has no parameter for the whole array
  (`language-subset.md` §4.4.1). A body that needs the collection captures
  it by name, and the capture is an ordinary slot, like any other captured
  outer value.
- **Nothing else.** The label of element `i` does not include any slot of
  element `j`.

Element cones are keyed as section 1.3 defines, and the element slots are
bound per position. The runtime, not the value code, iterates: it evaluates
the body's cone once per key with that element's slots, and assembles the
result. Which input element an output position came from is therefore
something the runtime knows, not something the value code reports.

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

**Which element a position came from.** For both operations the runtime
evaluates the per-element cone (the predicate, or the body) and then performs
the structural step itself: it drops the elements whose predicate is falsy,
or concatenates the segments. The value code never builds the result
collection. The runtime records, with a derived collection, one fact per
source element: whether it was included, or the length of its segment. The
**origin** of each output position follows by prefix sum, and the runtime
binds the element slots of later templates through it. Nothing is reported by
emitted code and nothing needs
verifying, and element locality of these operations is a structural fact
(section 7.3).

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

The aggregates are `count`, `sum`, `min`, `max`, `minBy` and `maxBy`, as
`builtin-inventory.md` lists them. `some`, `every` and `find` are reactive
constructs too; they depend on order and are in section 3.13.

| Aggregate | Template |
| --- | --- |
| `count()`, `.length` | The collection's membership |
| `count(predicate)` | `fold` of the predicate's template, joined with membership |
| `sum()`, `min()`, `max()` | `fold` of the element's `value`, joined with membership |
| `minBy(keyFunction)`, `maxBy(keyFunction)` | `pick` (section 3.18): the winning element, with the choice labeled by a `fold` of the key function's template |

A predicate is observed for truthiness, with the classes of section 3.5. The
callback of `minBy` and `maxBy` is called the **key function**: it returns
the key the elements are compared by. The callback of a collection index
(section 3.17) is a key function too.

**Semantics the plan fixes.** Value code on a client and on the server has
to agree, so the result of an aggregate is defined independently of how it is
computed.

- `sum` is exact: the result is the correctly rounded sum of the members,
  whatever their order (`AggregateSum` in
  `runtime/runner/src/builtins/aggregate-sum.ts` is the current
  implementation of that).
- The empty results are `0` for `sum` and `count`, `Infinity` for `min`,
  `-Infinity` for `max`, and `undefined` for `minBy` and `maxBy`.
- A tie in `minBy` or `maxBy` goes to the element with the smallest key in
  the canonical order of keys, so the result does not depend on the order of
  the collection.
- An element with an equal key counts once per position it occupies.
- A hole contributes nothing.

**Durable state.** An aggregate is an `Operation` of kind `aggregate`. Its
state holds one contribution per element key with the number of positions
that hold it, the folded value, and the multiset of label identifiers the
fold joins (section 4.3). A change to one element costs one update, and a
reorder costs nothing. The shape of that state is private to the runtime;
only the semantics above are part of the design.

**Today.** `aggregate` (`runtime/runner/src/builtins/aggregate.ts`) builds a
tree of `aggregateNode` runs, each its own transaction, and labels accumulate
up the tree by the ordinary join. **Equal** for the value aggregates. For
`count` the coordinator reads the raw list; the template is the membership
alone. **Equal or tighter**, to be confirmed by the stage 3 comparison,
because what a raw list read consumes at its slots depends on the list's
stored entries. `minBy` and `maxBy` publish a link to the winning element
today. The link passes up the tree through node outputs, each labeled by a
transaction that read its members' key function results, so the choice
carries the join over all of them, as the `pick` template's choice does.
**Equal.**

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

The same node covers every kind of body (`Body.kind`). An authored
module-scope function called from the reactive tier (`function`) has a
footprint like a `lift`. A function of an imported TypeScript module
(`imported`) has every argument as a `value` slot at the argument's root and
no handles, because `language-subset.md` refuses cell-typed parameters for
it. `assert` is a `computed` whose result is a test verdict.

**References and required paths.** The `derive` template is right for a value
the body computed. Two kinds of result path are not computed in that sense,
and `Body.outputs` records them:

- **A reference passed through.** When the reference at a result path is
  always the reference the body received at one `identity` slot, the path's
  template is that `slot` and nothing else. The reference acquires no label
  from the body: it is the same reference, and what it refers to was never
  read. This is the pass-through of §8.2.1
  (`08-02-pass-through-via-references.md`), and the content it refers to keeps
  its own label at the target.
- **A reference chosen among inputs.** When the reference at a result path is
  always one of several input references, its template is the `slot` of the
  one actually returned, joined with the body's `derive` template as the
  label of the *choice*. The chosen reference's own label and its target's
  label are untouched; what the body's inputs taint is which one sits at the
  path. §8.5.6.1 draws the same line for a selected collection: target content
  stays at its label while "Selected reference identity" is tainted by the
  selector.
- **A required path.** When the result schema requires a path, the path's
  `shape` template is `const`: it exists whatever the inputs were. Only its
  `value` carries the `derive` template. A body that fails to produce a
  required path is a failed body (section 5), and its error state occupies
  the path, so existence stays constant.

The first two are verified by the runtime, not trusted: it compares the
returned reference with the references it passed in, by identity, as
`exactCopyOf` is verified (§8.4, `08-04-exact-copy-verification.md`). A
returned reference that is none of the declared ones falls back to the
`derive` template. The third is enforced by validating the result against its
schema.

**Today.** A `lift` or `computed` node reads what its argument schema
materializes plus what it reads through cells, and the whole join lands on
every written path. The static part of the footprint is the narrowed
argument schema. **Equal or tighter**: equal when the body reads everything
its schema materializes today, tighter when footprint analysis narrows the
schema further than the transformer does. The narrowing does not rest on the
compiler's analysis being right (section 7): a footprint that is too small
starves the body instead of leaking to it. One argument is not narrowed
today, a handler's event of an authored type; section 3.12 compares it.

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
classified by the same classes.

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
state it read lands on every written path. The state's schema is narrowed to
what the body uses, as a `lift`'s argument is. The event's schema is not,
where the author wrote the event's type: the transformer generates the
schema of the authored type whole and narrows only the capability of each
cell in it (the `contract` mode of `CapabilitySummaryApplicationMode` in
`base/ts-transformers/src/transformers/type-shrinking.ts`, applied by
`applyCapabilitySummaryToArgument` and `applyCapabilitySummaryToParameter`
in `schema-injection.ts` beside it). The handler's transaction then reads
the event through the whole declared type. An event whose type is inferred,
an inline event handler's among them, is narrowed like the state. The
template joins the event slots of the footprint. **Equal or tighter**: equal
for an inferred event type, and for a body that reads every field the
authored type declares; tighter when the authored type declares a field the
body does not read.

### 3.13 `findIndex`, `some`, `every`, `find`, and `reduce`

All five are reactive constructs. Unlike the operations above, their rule
depends on the *order* of the collection.

**`xs.findIndex((x) => pred)`.** The result is the position of the first
element whose predicate is truthy, or `-1`.

- **Template.** `fold` of the predicate's template with `through` set: over
  the leading elements up to and including the first match, or over all of
  them when there is none. It is joined with the collection's membership,
  which includes order.
- **Why the later elements are left out.** The value is a function of the
  prefix: no change to an element after the match can change it. The label
  is a function of the match position, which is the value, in the way a
  `select`'s label is a function of its condition. A change that moves the
  match changes both.
- **What it rests on.** The runtime evaluates the predicate cones in order
  and stops at the first match, so the prefix is what it evaluated, a
  structural fact. A runtime that evaluates predicates out of order, for
  example from a memo keyed by element, still joins only the prefix, and
  that is sound for the same reason.
- **State.** None is required. The per-element predicate cones are memoized
  by key like any other, so a scan after a change re-evaluates nothing
  unchanged.

**`xs.some((x) => pred)` and `xs.every((x) => pred)`.** The same prefix
rule. `some` is a `fold` of the predicate's template through the first
truthy element, and over all elements when the result is `false`. `every`
is a `fold` through the first falsy element, and over all elements when the
result is `true`. Each is joined with the collection's membership.

**`xs.find((x) => pred)`.** `pick` (section 3.18) over the collection. The
choice is the `fold` through the first match, joined with membership; the
body is the matching element, passed through with its own label. When
nothing matches the result is `undefined` and carries the choice, a fold
over every element.

**`xs.reduce((acc, x) => expr, init)`**, where the callback is an
expression.

- **Template.** `fold` over all elements of the template of `expr`, with the
  accumulator treated as `const` inside it, joined with the template of
  `init` and with the collection's membership. Each step is instantiated
  with its own selections.
- **Why the accumulator can be `const` in the body.** The accumulator at
  step `k` depends on the steps before it, and the fold joins every step's
  instantiation. A branch on the accumulator inside `expr` is covered the
  same way: what it depends on is already in the join.
- **Integrity.** The class-aware meet over every step and `init`, plus
  `TransformedBy`.
- **State.** An arbitrary expression is not associative, so the fold cannot
  be a tree and a step cannot be keyed by its element. `reduce` is an
  `Operation` of kind `reduce`. The baseline state is the result alone, and
  the value is recomputed in order when anything it read changed. The
  runtime may keep accumulators at checkpoint positions, each labeled with
  the join of its prefix; a change at position `k` then recomputes from the
  nearest checkpoint before `k`. The *label* is cheaper than the value: it
  is a join over the steps, so the multiset of step label identifiers is
  maintained as for an aggregate, and only the steps whose instantiation
  key changed are re-instantiated. The accumulator is a data type, so that
  this state can be stored (`language-subset.md` §4.4.1,
  `collection:reduce-accumulator`).

**Today.** `reduce` and `findIndex` on a cell mint a `lift` inline
(`reduce` and `findIndex` in `runtime/runner/src/cell.ts`), which reads the
whole array in one transaction. `some`, `every` and `find` are array methods
an author calls inside a `computed`, which reads the whole array too.
**Equal** for `reduce` without conditionals, **tighter** for the four
prefix operations (elements after the deciding one) and for a `reduce`
whose expression selects.

### 3.14 Runtime calls in a function body

A function body can make five kinds of runtime call. Context reads are
section 3.16. The other four create something, and `Body.calls` records the
sites. Section 1.3 says how an occurrence is identified.

In a sandboxed body every computed value has the body's `derive` template,
written `T_b` here. The rules below say what `T_b` attaches to, and where the
reference rules of section 3.9 keep it off.

**Instantiating a pattern** (`instantiate`, legal in a handler and an
action). The call records a request and returns a link. The runtime creates
the child instance (section 3.15) when the transaction commits.

| Part | Label |
| --- | --- |
| The link returned | Its identity carries `T_b`: that this instance exists, and which one it is, depends on what the body read |
| The argument | Each path is written into the child's argument document with `T_b`, or with the reference rules of section 3.9 for a reference the body was given |
| A link to an instance requested earlier in the same invocation, passed as an argument | A reference like any other: it carries its own identity label, `T_b`. It is legal before either instance exists, because both are created by the same commit |
| `.for(tag)` | The tag's value is part of the footprint. The instance's existence label is frozen when it is first created (§8.12.8, `08-12-store-label-monotonicity.md`); a later event that names the same instance creates nothing |
| `asScope(scope)` | A constant of the site. It sets the scope of the state the child declares |
| `inSpace(space, options)` | The target is a slot or a constant of the site: a space identifier, the space of a given cell, a name, or anonymous. `Child.space` records which of the four it is, and the options `grants`, `root`, `spaceKind` and `selfOwned` where the site writes them. The argument is written into another space, so the write-side checks of that space apply to the argument's templates joined with `T_b`. The new instance's and space's identifiers derive from the request and are known before the commit, which spans both spaces |

The instance becomes an instantiated pattern, with a result cell, when its
link is written into state or passed to `navigateTo`. A link the body drops
creates nothing.

**Creating a cell** (`createCell`).

- In a handler the cell is new on every invocation. Its initial value and
  its existence carry `T_b`, and so does the identity of the handle the body
  holds. Writing the handle into state is a reference write.
- In a `lift` or `computed` the cell needs an explicit cause. When the cause
  is a constant, or the element key of the enclosing element body, the cell
  is a `StateCell` of the plan and the write is a static side-write (section
  3.11). When the cause is computed from data, the target is not known
  statically and the body is a materializer, with its own transaction and
  today's rules. The existence of a document under a data-dependent
  identifier reveals the data, so its existence label is the body's
  template.

The initial value of a created cell is a `WriteEdge` with target `created`.

**Requesting an effect** (`effect`, legal in a handler and an action). The
request's arguments carry `T_b` and form the `input` of an `Operation` of
kind `effect`, on which the egress ceiling is checked (section 4.4). The
call returns a link to the operation's result, which is pending in the
requesting transaction. The occurrence is identified by the event and its
ordinal. A `lift` or a `computed` does not request an effect, and since it
does not instantiate a pattern either, it has no indirect way to: effects
are requested from the reactive tier and from handlers only.

**Binding a handler** (`bind`): an `action(...)`, an inline event handler in
JSX the body builds, or a handler factory applied to its state. For the
first two the compiler hoists the arrow to a handler `Body` whose state is
its captures. The site refers to a `Binding`, which records the handler and
the template and capture mode of each state path. A handler factory
received as a value is section 3.21.

| Part | Label |
| --- | --- |
| Captured data values | Copied into the binding's state document with `T_b` |
| Captured cell handles | Stay links, with the reference rules of section 3.9 |
| The stream returned | A reference whose identity is derived from the enclosing instance, the handler and the captures. Its identity label is the join of the captures' labels, which is `T_b` unless every capture is a passed reference |
| The bound handler's state | Slots with root `binding`. When an event arrives, the handler's own template is over those slots and its event |

Because the identity is derived from content, two bindings of the same
handler to equal captures are one stream, and a re-evaluation of a
`computed` that builds the same JSX names the same streams. This is the
element-key rule of section 1.3 applied to bindings, salt included, and it
is what makes a binding legal in a body that is re-evaluated. A handler that
has to act on one occurrence among equal ones needs the index or a cell in
its captures. In an element body of the reactive tier that is enforced
(section 1.3); in a function body, where a binding is made in an ordinary
loop, equal captures give one stream.

**Today.** A factory called in a running body creates a node in the run's
frame, and the runner turns the frame into a synthesized pattern after the
body returns (`patternFromFrame` in `runtime/runner/src/builder/pattern.ts`).
What the body's transaction writes carries its join, which is `T_b`.
**Equal**, and **tighter** for references the body passes on.

### 3.15 Child instances

A `Child` is a pattern instantiated with a plan of its own. There are two
cases: a pattern received as a factory value and called in the reactive
tier, whose plan the compiler cannot see, and any pattern a function body
instantiates, whose instantiation is a run-time event even when the callee
is known.

**What the enclosing plan records** (`Child`): the callee, as a compiled
pattern's identity or as the slot that holds the factory; the argument and
result schemas the callee's type declares; the cause its identifier derives
from; and the modifiers. It also records one `WriteEdge` with target
`argument` per argument path, holding that path's template, and it refers to
the child's result through slots with root `child`, at paths of the declared
result schema.

**The child is an instantiated pattern.** It has a result cell, named by its
cause, and an argument document. Its keep set is its own plan's. The
enclosing plan cannot inline it, so the two meet only at those two
documents.

**Labels going in.** An argument path that is a reference is written as a
reference and carries the reference's label. An argument path that is a
computed value is written into the argument document with its instantiated
template. Such a value is therefore stored even when the enclosing instance
would not otherwise keep it: the argument of a child is part of the keep
set.

**Labels inside.** The child's plan supplies its templates at run time. Its
`argument` slots are bound to the argument document and resolve to the
labels stored there, so what the parent's templates instantiated to is what
the child's templates start from.

**Labels coming back.** A `child` slot resolves to the label stored at that
path of the child's result, like any slot. When the callee is a factory
value, every template that reads the child also includes the `identity` slot
of the factory: which pattern produced the result is part of what the result
depends on. A parent output that passes a child's result path on unchanged
is a `slot` template and keeps the child's integrity.

**A changed factory.** The child's result cell is named from the enclosing
instance and the call site, not from the factory. When the factory at the
slot changes, the old child is torn down and a new one is started under the
same name, so the replacement takes the old one's place. The new child's
state cells are those of its own plan under that name, so stored state is
found again only where cell names agree.

**A pattern closure.** An inline pattern used as a value is a `Closure`:
the compiled inline pattern, with the values it captures bound as its
private parameters (`language-subset.md`, §4.4.2). The inline pattern has a
plan of its own, in which the captures are slots with root `params`. A
caller supplies the public argument only and cannot observe or supply the
parameters.

- **The label of the factory value.** A closure is a value computed from its
  captures. Its `value` template is the join of the templates of the
  captures that are copied, and the `identity` slots of the captures that
  are cells. Holding the factory reveals that those values were what they
  were, so the factory carries their labels wherever it is stored or passed.
- **Stored form.** A copied capture is stored with the factory value under
  its instantiated template. A captured cell is stored as a link. A closure
  that reaches a kept output therefore makes its copied captures kept.
- **Inside the child.** When a receiver calls the closure, the child's
  `params` slots resolve to the labels stored with the factory value, as
  its `argument` slots resolve to the argument document. A captured cell is
  read through its link, and the read is journaled where the child's plan
  does not name the path statically.
- **Coming back.** The rule above already joins the factory's `identity`
  slot into every template that reads the child. For a closure that slot's
  label includes the captures' labels, so a result that depends on a
  captured value carries that value's label even when the child's own
  template for the path names no `params` slot.
- **Called where it is written.** A closure called in the body that wrote
  it is a statically resolved callee. It is compiled into the surrounding
  instance, its captures are ordinary slots, and no `Closure` or `Child`
  record exists for the call.

**One transaction.** A child in the same space is evaluated in the cause's
transaction, by the pull that extends through its result. A child created
with `inSpace` is not (section 3.14).

The schemas a factory type declares are what the compiler checks the
argument against and types the result with. The runtime checks that the
plan the factory resolves to has those schemas, and fails the cone that
reads the child when it does not (section 5.2).

**Today.** A pattern call in a pattern body is a `pattern` node that runs a
sub-pattern instance with a result cell, and its documents carry the joins
of the transactions that wrote them. **Equal.** The inline case, where the
compiler can see the callee, is what stops needing an instance.

### 3.16 Context reads

A context read observes something that is not a cell's content. Each has a
slot or a dynamic read, so that a body's template accounts for it.

| Call | Recorded as | Label |
| --- | --- | --- |
| `eventKey()` | Slot, root `cause`, path `eventKey`, class `value` | None. The key names the event and carries nothing of its payload |
| `currentPrincipal()` | Slot, root `cause`, path `principal`, class `value` | No confidentiality. It is the authenticated actor of the event, which the runtime attests |
| `principalOf`, `principalsOf`, `profileOwnerOf` | The `identity` slot of the target and a `labelMetadata` slot on it (section 2.4) | The pointer labels of the links followed to the target, joined with the label of the metadata observation. A claim's kind and subject are classified public today, so the second part is empty. The target's value is not read |
| `resultOwnerOf` | `dynamic`, of kind `link`, through the `identity` slot of the operand | What the journaled read of the document's back-link consumes |
| `spaceOf(x)` | The `identity` slot of `x` | The reference's label. Which space a cell lives in is part of its address |
| `spaceAccess`, `spaceAccessOf`, `spaceMembers` | `dynamic`, of kind `space`, through the `identity` slot of the operand | What the journaled reads of that space's access list consume. `spaceAccess` and `spaceMembers` answer for the acting principal, so a computation that calls them is scoped to the user |
| `spaceDeleted` | `const` | None. It is runtime state from the server's answer, not a document |
| `linksOf(list)` | The `enumeration` slot of the list and the `identity` slot of each element | The join of those. No target is read |
| `equals(a, b)` | The `identity` slots of both operands | The join of both |
| `getPatternEnvironment()` | `const` | None. It is a constant of the deployment |

The access list of a space is state of that space, and which space is meant
is data, so those reads are journaled like a followed link (section 3.10)
and keep their trigger reads.

**`inspectConfLabel(target, path, query)`.** Its template is the `value`
slots of `path` and `query` and a label-metadata observation of the target.
What that observation reads depends on what the target is:

- For a **slot** (an input, a state cell, an operation's or a child's
  result), it reads the stored label metadata at the target's address, as
  today.
- For a **value the instance computes**, kept or interim, it reads the label
  the value's template instantiates to in the current transaction. An
  interim value has no stored label, and a kept one may be about to change,
  so the instantiated template is the one answer that is current for both.
  The observation's own label is the join of the label-metadata labels of
  every slot the template reaches under the current selections, and of the
  conditions that made those selections.

This answers the question `builtin-inventory.md` puts under
`inspectConfLabel`. In both cases the result fails closed to "not available"
as section 2.4 says.

`principalOf` on a claim that represents a principal also checks whether the
target's `name` holds a written name. That is a verifier read today and
stays outside the template.

**Today.** `builtin-inventory.md` ("What the plan records for calls in
bodies") lists what each of these reads and where its label comes from, from
`runtime/runner/src/builder/`. The rows above record the same observations.
**Equal.**

### 3.17 Collection indexes

`xs.groupBy((x) => key)` and `xs.keyBy((x) => key)` build an index, and
`lookup(k)`, `keys()` and `keyEntries()` read it.

The index is an `Operation` of kind `index`. Its state holds, per element
key, the index key the key function produced and the number of positions,
and per index key the bucket. The per-element key function cones write a
statically known target, so no materializer is involved.

| Part | Template |
| --- | --- |
| Membership of bucket `k` | The source's membership, order included, joined with a `fold` of the key function's template over every element: `value` for a primitive key, `identity` for a cell key. A `group` bucket lists its elements in source order |
| The elements of a bucket | The source elements, passed through (`slot` templates), with their root `shape` replaced by the bucket's membership |
| `lookup(k)` in `group` mode | A collection whose membership is the bucket's membership joined with the template of `k` |
| `lookup(k)` in `key` mode | `pick` (section 3.18): the winning element, with the choice labeled by the bucket's membership and the template of `k` |
| A lookup that misses | The same choice label, with no element |
| `keys()`, `keyEntries()` | A collection whose membership is the source's membership joined with the `fold` of the key function's template |

The winner among elements with equal index keys in `key` mode is the element
with the smallest element key in the canonical order, so no element value
beyond the index key enters the choice. A nullish index key omits the
element, which is part of what the fold observes.

Every element's key function result is in a bucket's membership, not only
those of the elements in the bucket: that an element is absent from bucket
`k` says its key is not `k`.

**This is the one rule that is looser than today.** Each
`collectionIndexMember` run reads its own key and writes one bucket, and its
reads of other members' records are machinery reads
(`runtime/runner/src/builtins/collection-index-member.ts`). A bucket's
stored label is therefore the join of the runs that wrote into it, which
covers the elements in the bucket and not the absent ones. The template
adds the keys of the absent ones. That is deliberate and decided: it is the
membership rule `filter` already has, under which exclusion is as much an
observation as inclusion (§8.5.6.1), and today's stored label under-states
it. The stage 3 comparison expects a wider label for every bucket,
`lookup`, `keys` and `keyEntries`, and treats it as conforming.

### 3.18 Chosen children

Three constructs yield one child chosen by a value: `minBy` and `maxBy`
(section 3.8), a `key`-mode `lookup` (section 3.17), and a dynamic key
`a[k]` in the reactive tier. All are `pick`.

```text
C(pick) = C(choice) ⊔ C(body at the chosen child)
I(pick) = I(body at the chosen child)
```

The result is the chosen child itself, so integrity is the child's, as for
`select`. When nothing is chosen (an empty collection, a missing key) the
result is `undefined` and its label is `C(choice)`.

This is the "reference chosen among inputs" rule of section 3.9 for an
operation the compiler understands: the chosen child's own label is
untouched, and `choice` labels which one it is.

| Construct | `from` | `choice` |
| --- | --- | --- |
| `minBy`, `maxBy` | The collection | Membership joined with a `fold` of the key function's template |
| `lookup(k)`, `key` mode | The bucket | The bucket's membership joined with the template of `k` |
| `a[k]` | The container slot of `a` | The template of `k` joined with the `shape` of the chosen child |

**A dynamic key.** `a[k]` observes the key and the one child it selects:
whether the child exists, and whatever the surrounding expression reads of
it. It does not observe the container's other children or its enumeration,
by the rule that child access is navigation (§4.6.3). The value code
reports the key, the runtime binds the body's child slots to that path, and
the label follows. The container's enumeration is not needed, so a dynamic
key in the reactive tier needs no refusal.

For a collection the runtime does the choosing from per-element results, as
it does the filtering in section 3.7, so the chosen element is known to it.

**Today.** A dynamic key in a `lift` reads the one path through `.key(k)`,
and the key's read is in the same transaction. **Equal.**

### 3.19 Other structural operations

**Template literal.** `derive` by expression code over the templates of the
substitutions. A substitution of scalar type contributes its `value`. A
substitution whose type is a record or an array contributes one `value` slot
at its root, covering the subtree, because conversion to a string can
observe all of it. Today a template literal lowers to a `lift` with one
label for the whole string. **Equal**, and **tighter** where the literal is
one member of a constructed object. The `str` tag maps to this operation.

**`anchorsOf(field)`.** A reference whose only slot is the `identity` of the
operand: the anchors document's identifier derives from where the field is
stored, and nothing the field holds is read. Reads and writes through the
reference use the anchors document's own label. Because it hands a body a
writable cell on a document the pattern did not declare, the plan lists that
document as a `WriteEdge` with target `anchors`, and it joins the instance's
static write targets. Today the built-in resolves the link and reads nothing
(`runtime/runner/src/builtins/anchors-of.ts`). **Equal.**

**The parsing half of `cellFromUrl`.** A reference whose identity is
computed from values: its identity label is `derive` over the `value` slots
of `url`, `hosts` and `spaceHost`. Content read through it is a followed
link (section 3.10). Resolving a space name or a host is an effect and is
not this operation.

**`wish`.** It is one structural operation with four parts, and a constant
query lets the compiler tell them apart.

| Part | Template |
| --- | --- |
| A path or a well-known target | A reference whose identity label is the template of the query and path. A home-space target also depends on which user the instance is evaluated for, which is the instance's scope and not a label |
| Hashtag search | A collection found through links. Its membership is a `dynamic` node of kind `search`: the name and schema of every candidate considered are journaled reads. The candidates are passed through |
| The clock | A reference to a clock cell the runtime writes. Reading it is a slot with no input label. Each tick is a cause. The one-shot timestamp is a `StateCell` written once when empty |
| A sidecar | A `Child` whose callee is one of the system patterns, with an identifier derived from the wish's cause |

A query computed at run time gets the join of all four, as
`builtin-inventory.md` assumes (open question 2). Today the result is a
reference and hashtag search joins every candidate it reads
(`runtime/runner/src/builtins/wish.ts`). **Equal.**

### 3.21 A handler factory received as a value

A handler can be passed by reference and bound where it arrives: in the
reactive tier, or at a `bind` site of a body. The compiler then knows the
handler's type and not the handler. This parallels the child instance of
section 3.15.

**What the enclosing plan records** (`Binding` with `handler.factory`): the
slot that holds the factory, observed for `identity`; the event and state
schemas the factory's type declares; and, for each state path, the template
of what is bound to it and whether it is copied or stays a link.

**What the handler's own record supplies.** A handler factory value names a
compiled handler by content address. The compiled module it comes from
holds the handler's `Body` record, and the runtime resolves it when the
binding is made:

- the **footprint**: which state and event paths the body reads, and the
  handles it reads through. The runtime narrows the argument to it, as for
  any body. The declared state schema bounds what the binder passes; the
  footprint can only be narrower.
- the **write edges**: the paths the body writes, relative to the cells in
  its state, with their constraints, and its `outputs` and `calls`.
- the **body identity**, `Body.code`, which is what a `WriterPolicy.body`
  names and what `TransformedBy` carries.

**Labels.** The handler's template, when an event arrives, is its own
record's `derive` over its event and `binding` slots, joined with the
`identity` slot of the factory: which handler runs is a function of that
slot, so its label is on everything the handler writes. The stream's
identity derives from the enclosing instance, the factory's content address
and the captures.

**Checks that move from compile time to run time.**

| Check | With a known handler | With a factory value |
| --- | --- | --- |
| The writer policy of a written path names this handler | Compile time, for a static write edge (section 4.4) | When the handler writes: the resolved `Body.code` against the policy of the cell it was bound to |
| The handler's schemas fit the binding | Compile time | When the binding is made: the resolved record's event and state schemas against the declared ones. A misfit fails the binding's cone, or the binding handler |
| Input requirements and ceilings on the handler's state | Compile time where the bound slots are declared | At instantiation, from the resolved record's constraints over the `binding` slots |
| Some element of the pattern binds the handler under the surface its UI contract names | Compile time, reported as a warning (section 4.4) | Not checkable; per event only |
| A write the handler's record does not list | Compile time | Refused by the runtime when attempted (section 7.4) |

**What is hard.**

- **The write surface of a pattern is no longer closed at compile time.** A
  cell passed as state to a handler value can be written by code the
  compiler never saw. Every analysis that asks "who writes this cell" has
  to count such a cell as written by an unknown handler: the detection of
  cycles through side-writes, and any classification of a cell as written
  only by computations.
- **The static error becomes a run-time refusal.** Passing the wrong
  handler to a cell whose policy names another is found when the handler
  first writes, not when the pattern is compiled.
- **The record has to be available where the binding runs.** A client that
  speculates the handler needs the handler's compiled module, which the
  binder's compiled pattern does not contain. It is fetched by content
  address, like a child's plan.
- **A handler's policy names it by type.** A type such as the one a write
  policy uses names a handler definition. A handler value satisfies it only
  if it *is* that definition, which the content address decides at run
  time; the type checker of the binder can check the declared schemas and
  nothing more.

**Today.** A handler factory read from a cell is plain data and cannot be
bound (`builtin-inventory.md`, "Factory values"). This is new, so there is
nothing to compare.

### 3.22 Summary

| Operation | Template | Against today |
| --- | --- | --- |
| Property access | Slot path extension | Equal |
| Object, array construction | Template per path | Equal in pattern bodies; tighter in promoted expressions |
| Conditional | `select` | Equal |
| `map` | Element template; membership slot | Equal; tighter within an element as above |
| `filter` | Pass-through elements; membership `fold` of predicates | Equal |
| `flatMap` | Element template; membership `fold` of segment lengths | Tighter (content of other segments excluded) |
| `count`, `sum`, `min`, `max` | `fold` | Equal; `count` equal or tighter |
| `minBy`, `maxBy` | `pick`, choice a `fold` of the key function | Equal |
| `findIndex`, `some`, `every` | `fold` through the deciding element | Tighter (later elements excluded) |
| `find` | `pick`, choice a prefix `fold` | Tighter (later elements excluded) |
| `reduce` | `fold` of the step expression, plus the initial value | Equal; tighter when the expression selects |
| `groupBy`, `keyBy`, `lookup`, `keys`, `keyEntries` | Bucket membership a `fold` of the key function; `pick` for `key` mode | **Looser**, the one exception: absent elements' keys are included |
| Dynamic key `a[k]` | `pick` over a container | Equal |
| Template literal | `derive` over substitutions | Equal; tighter inside a constructed object |
| Sandboxed call | `derive` over footprint and handles; references passed through | Equal or tighter |
| Link following | `identity` slot plus `dynamic` | Equal |
| Static side-write | Template of the written expression | Equal or tighter |
| Handler | `derive` over event and state footprint | Equal or tighter (an authored event type is read whole today) |
| Calls in a body | The body's template on what it creates | Equal; tighter for passed references |
| Child instance | Argument templates in; `child` slots out | Equal |
| Pattern closure | Join of the capture templates on the factory value; `params` slots inside | Equal |
| Handler factory value | The handler's own record, plus the factory's `identity` | New |
| Context reads | `cause`, `labelMetadata`, `identity` slots; `dynamic` for access lists | Equal |
| `anchorsOf`, `cellFromUrl` parsing, `wish` | References with computed identity; `dynamic` search | Equal |

One row is looser, the collection index, and section 3.17 says why; that is
decided and is the only exception. The other way a compiled label could be
looser than today's is a static footprint
standing in for reads that are dynamic today, and `handles` exclude it: a
read a body makes through a cell stays journaled. A widening affects only
slots the runtime materializes into the argument, which the body's argument
schema materializes today as well.

## 4. Instantiation

### 4.1 When it runs

Instantiation runs in the transaction of a cause, after the value code, and
only for the templates of what the transaction stores or checks:

- a kept output (`Output.template`);
- a write edge (`WriteEdge.template`): a side-write, a path of a child's
  argument, the initial value of a created cell;
- the `input` of an effect operation, on which the egress ceiling is checked
  (sections 3.14 and 4.4);
- a state path of a binding that is copied (`Binding.state`), which is
  stored in the binding's state document (section 3.14);
- a parameter of a pattern closure that is copied (`Closure.params`), which
  is stored with the factory value (section 3.15).

For each one:

1. If the cone or body that computes it was not evaluated in this
   transaction, do nothing.
2. Collect the label identifier of each slot the template reaches under the
   reported selections, and the selections themselves. This is the
   **instantiation key**.
3. If the key equals the key the stored label was instantiated from, reuse
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
  /** Elements of a collection in order, each with its own inputs. */
  elements(collection: Index): readonly TemplateInputs[];
  /** The child a `pick` chose, or undefined when it chose none. */
  chosen(from: PickSource): TemplateInputs | undefined;
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
    case "pick": {
      const choice = instantiateTemplate(t.choice, inp);
      const child = inp.chosen(t.from);
      if (child === undefined) {
        return { confidentiality: choice.confidentiality, integrity: [] };
      }
      const taken = instantiateTemplate(t.body, child);
      return {
        confidentiality: joinAll([
          choice.confidentiality,
          taken.confidentiality,
        ]),
        integrity: taken.integrity,
      };
    }
    case "fold": {
      const all = inp.elements(t.collection);
      const covered = t.through === undefined
        ? all
        : all.slice(0, inp.selection(t.through) + 1);
      const parts = covered.map((e) => instantiateTemplate(t.body, e));
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

A `fold` with `through` covers the leading elements up to the reported
position; the value code reports the collection's length less one when
nothing matched, so that the fold covers everything.

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
equal slot labels are one memo entry and one stored `*`-child entry. This is
also what makes the per-position binding of section 1.3 cheap: positions
that share a key share the value, and positions whose slot labels are equal
share the label.

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
| UI event integrity contract | `verifyTrustedEventRequirements` (`runtime/runner/src/cfc/prepare.ts`), with provenance recorded by `recordTrustedEventPolicyInputs` (`runtime/runner/src/cfc/ui-contract.ts`) | The event bound to the handler's `event` root satisfies the alternative's `uiContract` |
| Egress ceiling of an effect | `verifySinkRequestCeilings` over the whole transaction's consumed label | `C` of the effect operation's `input` template fits the ceiling |

The slots a `requiredIntegrity` or `maxConfidentiality` constraint lists are
the slots of the body's footprint whose path overlaps the annotated path, in
either prefix direction, which is the overlap the runtime uses today
(`buildWritePrefixBounds`).

**Where a constraint comes from.** `language-subset.md` §8.1 lists the keys
a label annotation adds to a type. The plan holds each as follows.

| Annotation key | In the plan |
| --- | --- |
| `confidentiality` | `Slot.declared.confidentiality` of a slot the annotation covers (`language-subset.md` §8.3), and a declared entry of the stored label (section 2.3). On a path a write edge targets, it is the declared confidentiality a `writerFit` constraint tests the edge's template against |
| `integrity` | `Slot.declared.integrity` of a slot the annotation covers, and a declared entry of the stored label |
| `requiredIntegrity` | A `requiredIntegrity` constraint with the annotation's patterns, over the slots that overlap the annotated path |
| `maxConfidentiality` | A `maxConfidentiality` constraint with the annotation's ceiling, over the slots that overlap the annotated path |
| `writeAuthorizedBy` | A `writer` constraint on each write edge to the annotated path, with one `WriterPolicy` whose `body` is the body the binding names |
| `writePolicyAnyOf` | A `writer` constraint on each write edge to the annotated path, with one `WriterPolicy` per policy of the list |
| `uiContract` | `WriterPolicy.uiContract` of the alternative it is declared with |
| `addIntegrity`, `exactCopyOf`, `projection` | No record and no rule (section 8, question 14) |

No key in this table yields a `writeFloor` constraint. Which one does is
question 15 of section 8.

**When a constraint is checked.**

- **At compile time**, when everything it reads is declared: every listed
  slot has a `declared` label for the dimension the constraint tests, or the
  constraint is about a body's identity. A violation is a compile error that
  names the slot and the annotation. The writer policy is always checkable at
  compile time for a static write edge, because both the body and the policy
  are in the source.
- **At instantiation** otherwise, with the labels the template was
  instantiated from. A failure rejects the cause's transaction, as a failed
  check rejects a transaction today (section 5.5 says what that reveals).
- **Per event** for a UI contract. Whether an event came from the named
  surface is a fact about that event (`trustedEventProvenanceMatchesUiContract`
  in `runtime/runner/src/cfc/ui-contract.ts`). The compiler reports, as a
  warning (`cfc-flow:ui-contract`, `language-subset.md` §10.5), the case
  where no element of the compiled pattern that binds the handler sits under
  a surface carrying the required pattern and integrity names, since then no
  event from this pattern's UI can satisfy the policy. It is not an error,
  because a handler bound to an exported stream also receives events from
  other patterns (section 6.3 has one).

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
  iteration bound; a slot the cone reads is itself in an error state; a slot
  cannot be resolved to an address and a label; stored data does not match
  the slot's schema (below); a child's plan does not have the schemas its
  factory type declares (section 3.15).
- **Data that does not match its declared type.** The runtime validates what
  it reads for a slot against the slot's schema before any emitted code sees
  it, as it validates a read against a schema today. Where the schema admits
  `undefined` at the mismatching path, or declares a default, the slot reads
  as that. Where it does not, the cone fails: the value code was compiled
  against the declared type, and handing it a value outside that type would
  void what the compiler checked. So a path projection in the reactive tier
  on mismatched data yields `undefined` exactly when the type allows
  `undefined` there, and an error state otherwise. `language-subset.md`
  (§13) relies on this for its strict `null` checks. Either outcome was
  decided by observing the stored value at that path, and its label is the
  label of that slot, which the output's template already contains.
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

The transaction of an event has three parts.

1. **Before the body.** A handler's read closure is static. The cones that
   compute what the handler reads, and that are stale, are evaluated first,
   so the body sees current values.
2. **The body.** It stages its writes and its requests: instantiations,
   cells, effects, bindings (section 3.14).
3. **After the body.** The cones the handler's writes dirtied, and that
   something demands, are evaluated; templates are instantiated and
   constraints checked; everything commits together.

A handler body that throws aborts the transaction, as it does today
(`finalizeFailure` in `runtime/runner/src/scheduler/events.ts`). Its staged
writes and requests are discarded, so no instance, cell, effect or binding
it asked for comes to exist, and part 3 does not happen. The results of part
1 are pure derivations of state that did not change. They are not stored by
the aborted transaction; the runtime's in-memory memo of evaluated cones
keeps them, and the next cause that demands them stores them.

A failure in part 1 or part 3 is a cone failure and follows section 5.2. If
the failed cone is one the handler reads, the handler receives an error
state for that input and fails in turn.

The handler's failure is an outcome with a label: the handler's template,
instantiated over what it read. It is reported to the party that delivered
the event, and it is stored only if the pattern reads the handler's status
as a state. A client that speculates the handler computes the same outcome
from the same plan.

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
- **Rejection.** A constraint that fails at instantiation rejects the whole
  transaction of its cause, so that no part of a cause commits when any part
  of it is not allowed. Every output of that cause then keeps its previous
  value, which is visible to their readers. Whether a constraint fails is a
  function of slot labels and selections, not of other values, so what the
  rejection reveals is bounded by those. An error state (section 5.2) is
  different: it is a value that passed its checks, and it does not reject
  anything.

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
3. resolves `event.attachments`, reads the file entry behind each, and
   throws when there are too many or one cannot be attached;
4. throws when there is neither text nor an attachment;
5. checks `event.replyTo` when it is set: it reads the messages the reply's
   `thread` and `quotes` links name, and compares their space with the space
   of `messages`;
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
- `isEdited = computed(() => …)`, whose body reads `message.get()` and
  returns `record?.editedAt !== undefined && typeof record.body === "string"`;
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
s4  argument  messages                 : identity
e0  event     body                     : value
e1  event     target/value             : value
e2  event     attachments              : enumeration
e3  event     attachments/*            : identity
e4  event     replyTo                  : shape
e5  event     replyTo/thread           : identity
e6  event     replyTo/quotes           : identity
e7  event     replyTo/shownIn          : value
e8  event     threadTitle              : value
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
      reads    e0 e1 e2 e3 e4 e5 e6 e7 e8 s2 s4
      handles  myProfile, threadInfo, attachments/*,
               replyTo/thread, replyTo/quotes
      writes   state messages/*      template T_send   constraints [k0, k1]
               state reactions       template T_send
B1  computed messageFacts
      reads    s0 s1 s3
      handles  messages, threadInfo
B2  function bodyText      reads m0 m1 m2 m4
B3  computed replies       reads m1          handles places
```

`messages` is a handle of `B1`, which walks each message cell through it.
`B0` does not read through `messages`. `sendInto` pushes onto it and passes
it to `spaceOf`, by way of `isInRoomOf`, which observes its identity (`s4`).
`B0` reads through five handles:

- `myProfile`: `resolvedProfile` resolves the link and tests whether the
  profile behind it holds a value;
- each element of `event.attachments`: `attachmentsIn` reads the file entry
  behind it;
- `event.replyTo/thread` and `event.replyTo/quotes`: `checkedReply` reads
  the messages behind them when the event names a reply;
- `threadInfo`: `threadTitleRecord` reads it under a key computed from the
  thread's root, when the event carries a `threadTitle`.

Of `event.replyTo` itself the body observes whether it is set (`e4`), the two
references (`e5`, `e6`), and `shownIn` (`e7`).

`text` and `isEdited` meet the promotion criterion of `language-subset.md`
§6.1, so neither `computed` is a body. `text` is a call of the authored
function `bodyText`, which is `B2`, a body of kind `function`. `isEdited`
calls nothing but `message.get()`, so it is expression code with a `select`
for its `&&`.

Templates:

```text
T_send   = derive(by B0)  [ e0 e1 e2 e3 e4 e5 e6 e7 e8 s2 s4
                            dynamic(handle B0.myProfile)
                            dynamic(handle B0.threadInfo)
                            dynamic(handle B0.attachments/*)
                            dynamic(handle B0.replyTo/thread)
                            dynamic(handle B0.replyTo/quotes) ]

T_facts  = derive(by B1)  [ s0 s1 s3
                            dynamic(handle B1.messages)
                            dynamic(handle B1.threadInfo) ]

T_empty  = derive(expression) [ T_facts, const ]

c1       = collection  source: facts.main   membership: T_facts
                       bodyUses: { index: false }

T_text   = derive(by B2)  [ m0 m1 m2 m4 ]
T_isSet  = derive(expression) [ m0 m1 m5 ]
T_edited = select( condition: T_isSet,
                   branches:  [ derive(expression) [ m3 ],
                                T_isSet ] )
T_repl   = derive(by B3)  [ m1  dynamic(handle B3.places) ]
T_label  = select( condition: derive(expression) [ T_repl, const ],
                   branches:  [ const,
                                derive(expression) [ const, T_repl ] ] )
```

The elements of `c1` are links to message cells, so each row's key is its
message cell's identity (section 1.3), and a row keeps its cone when the list
is reordered or a message is inserted before it.

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

`B0` also has `outputs` entries for the message it pushes: `authorProfile`
passes `s2`, the sender's profile reference, and each entry of `attachments`
is one of `e3`. So the stored `authorProfile` link carries the label of the
reference the handler was given and nothing from the event, and an attachment
link carries its own label plus the handler's template as the label of having
been chosen. `body`, `sentAt` and `reactions` are required by the message
schema, so their existence is constant.

Kept outputs in the slice: the room's `messages` output (from `facts.list`),
and the rendered tree under `[UI]`, which holds the empty-state branch and
each row's text, edited mark and thread label. `facts.entries`, `replies` and
the conditions of `T_edited` and `T_label` are interim.

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
that such an element exists for each handler the pattern binds to a control,
and it warns where none does (section 4.4). `commitSend` itself is bound to
the exported `sendMessage` stream, whose events come from other patterns, so
for it the check is per event only.

`sendInto` creates the reactions list with a cell constructor. That is a
`createCell` call of `B0`, identified by the event and its ordinal (section
1.3). The list's existence and the handle carry `T_send`, and the message's
`reactions` field is a reference write of that handle.

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
| New message (computed fields) | `C(e0..e8) ⊔ C(s2) ⊔ C(s4) ⊔ C(D(myProfile)) ⊔ C(D(threadInfo)) ⊔ C(D(attachments/*)) ⊔ C(D(replyTo/thread)) ⊔ C(D(replyTo/quotes))` | Declared authorship atom; `⊓` over the same inputs; `TransformedBy(commitSend)` when the join is not empty |
| `facts`, every path | `C(s0) ⊔ C(s1) ⊔ C(s3) ⊔ C(D(messages)) ⊔ C(D(threadInfo))` | `⊓` over the same; `TransformedBy(messageFacts)` |
| `isEmpty` | Same as `facts` | `⊓` over the same; `TransformedBy(pattern)` |
| Row `text` | `C(facts) ⊔ C(m1) ⊔ C(m2) ⊔ C(m4)` | `⊓` over the same; `TransformedBy(bodyText)` |
| Row `isEdited` | `C(facts) ⊔ C(m1) ⊔ C(m5)`, and `C(m3)` as well when `editedAt` is present | from the selected branch: `⊓` over its inputs; `TransformedBy(pattern)` |
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
| New message | Handler transaction's join over the whole declared event, the state reads and the reads through handles, plus the declared atom. `RoomStreamEvent` is an authored type, so its schema is not narrowed (section 3.12) | The same set, with the event slots `e0` to `e8` in place of the whole event: a field the handler does not use, such as `emoji` or `target/dataset`, is not read |
| `facts` | `computed` node's join | Same set |
| `isEmpty` | Its own node and document; the join of reading `facts.main`'s length | Same label; no node or document |
| Row `text` | The row node reads `message.get()`, the whole record as its schema materializes it: `body`, `sentAt`, `editedAt`, `replyTo`, and the slots of `authorProfile`, `attachments` and `reactions` | `body` and the presence of `authorProfile` |
| Row `isEdited` | The whole record, as above | The presence of `editedAt`, and the kind of `body` when `editedAt` is present |
| Row `threadLabel` | Its own node; reads `replies`, another node's document | The label of the `places` entry read, through the `select` |

For `text` and `isEdited` the template is tighter whenever a field the value
does not depend on carries a label the others do not. In FabriChat that
happens after an edit or a reaction: `commitEdit` rewrites `body` and
`editedAt` in a later transaction with its own join, and the reactions list is
a document of its own. For the new message the template is tighter whenever
an event field `commitSend` does not use carries a label. With FabriChat's
actual labels the instantiated labels are equal, because all of them are
empty.

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
runtime records itself.

### 7.2 Trust in the compiler is unconditional

The compiler is trusted, and the trust is a property of the deployment. It
is not a decision a user makes, per pattern or per compiler build, and the
design has no mode in which a runtime executes a compiled pattern while
distrusting the compiler that produced it. Without the compiler's claims
there are no per-path labels, no selection, and no separation between the
calls of one transaction, and one transaction per cause would give every
output of a cause one label.

So §8.9.1's test "for the acting user" cannot be a per-user grant here. The
specification already has the notion that fits. §8.9.1.2 lets a
runtime-owned executor apply a precision profile "under its own
implementation identity being trusted for `flow-taint-precision`", with the
executor's structural obligations "making that self-trust auditable". The
specification change expresses compiler trust that way:

- The compiler is part of the runtime's implementation identity. A user who
  uses a runtime trusts that runtime, kernel and compiler alike, and the
  test of §8.9.1 is met for every acting user of the deployment by that
  fact, not by a statement in the user's trust closure.
- A deployment states which compiler builds it accepts
  (`CompiledPattern.compiler`). The runtime executes a compiled pattern only
  when it compiled the source itself or the pattern names an accepted build
  and comes from a party the deployment trusts to supply compiled patterns.
  It refuses any other compiled pattern; it does not run it with coarser
  labels.
- The obligations that make the self-trust auditable are the executor
  obligations of the new profile section in chapter 18, which section 7.3
  lists.

There is consequently no fallback label. The cone-level join, the join over
every slot of a cone, is not a mode of operation. It keeps two uses:

- **As the bound on a compiler defect.** Section 7.3's cone narrowing means
  a miscompiled cone can at worst give an output the data of its own cone,
  so the cone-level join is what the output's label should have been at
  most. An audit of the compiler can reason per cone.
- **As a check.** Every instantiated template is, by construction, no more
  restrictive than its cone-level join and no less restrictive than any one
  of its slots. The stage 3 comparison and the differential oracle assert
  both bounds, and a violation is a defect in the compiler or the template
  evaluator.

### 7.3 What does not rest on compiler correctness

These hold whatever the compiler emitted, because the runtime enforces them.
They are this design's form of the obligations §8.9.1.2 places on a
runtime-owned executor: "explicit inputs, no hidden lexical capture,
bracketed dereferences, fail-closed on unresolved references".

- **Cone narrowing.** The runtime passes a cone's value function exactly the
  slots in `Cone.slots`. A cone cannot compute from data it was not given.
- **Body narrowing.** The runtime builds a sandboxed body's argument from
  `Body.reads` and hands it only the listed handles. A footprint that omits a
  slot starves the body. Data outside a body's footprint stays confidential
  from the body however wrong the analysis is.
- **Element locality of collection operations.** The runtime evaluates an
  element body once per key with that element's slots, and performs the
  filtering, concatenation, folding and choosing itself (sections 3.6 to
  3.8, 3.17, 3.18). No emitted code sees two elements of a mapped collection
  at once, unless the body captures the collection by name, and then the
  collection is a slot of its own in the body's template (section 3.6).
- **References a body passes on.** That a returned reference is one the body
  was given is checked by identity (section 3.9).
- **Dynamic reads.** Reads through handles and links, and of access lists,
  are journaled by the runtime, as they are today.
- **The template evaluator and the constraint checks.** `instantiateTemplate`
  and the checks of section 4.4 are the runtime's. Labels are resolved from
  stored envelopes by the runtime. No emitted code computes or compares a
  label.
- **Writer identity.** A write policy names a body by content address, and
  the runtime knows which body it invoked.
- **Schema conformance of what emitted code receives** (section 5.2).

### 7.4 What does rest on compiler correctness

These the runtime cannot check. They hold only if the compiler is correct.

- **Statelessness between calls.** Two calls in one transaction share no
  mutable state. For a module in the language subset the compiler's
  statelessness check is the enforcement, and no load-time verifier runs on
  it (`language-subset.md` §3.4). A defect in that check would let one call
  leave data for another, and the labels of the two would then be wrong.

  This is what the instance rule of §8.9.1.2 rests on here. That rule says
  executions sharing an executor instance share one label, because "Heap
  state flows freely within a live instance". The design gives each call its
  own label inside one instance, which is sound only when the instance holds
  no mutable state a call can reach. For subset modules that is the
  compiler's claim. The load-time verifier remains for imported TypeScript
  modules, whose bodies the compiler does not analyze, and the frozen shared
  intrinsics of the sandbox remain the runtime's
  ([SES sandboxing](../sandboxing/SES_SANDBOXING_SPEC.md)).
- **Per-path templates inside a cone.** That output path `p` depends on the
  slots of its template and not on the cone's other slots.
- **Selection.** That the unselected branch of a `select` did not influence
  the result, and that the reported selection is the one taken. The same
  holds for the key a `pick` over a container reports.
- **Element locality where the body asks for more.** A body that uses the
  index is given it, and what it does with it is the compiler's claim.
- **Wiring.** That the result of body `B` is what flows to the outputs whose
  templates name `B`.
- **Gating sets.** That a guarded write depends only on the slots its
  constraint lists (section 4.4).
- **Footprints of writes and calls.** That a body writes only the paths, and
  makes only the calls, its `Body` record lists. The runtime refuses a write
  or a call the record does not list, so a defect here fails closed.

The claim is about propagation precision only. §8.9.1 says of the mechanism
that "it does not grant declassification", and a template never removes a
clause any of its slots carries.

### 7.5 How the trusted part is kept small

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
  enforced. That comparison is the test of every row of section 3.22. It
  expects equal or tighter labels everywhere except for collection indexes,
  where it expects the wider membership label of section 3.17.

## 8. Open questions

The project owner has decided the questions earlier drafts listed, and the
sections above state the outcomes: equal plain values share a cone and never
state or handlers (1.3); the prefix rule (3.13); `some`, `every` and `find`
as operations (3.13); the wider collection-index label (3.17); rejection of
a cause's whole transaction (4.4); a child replaced under the same name
(3.15); identifiers of a cross-space request known before its commit (3.14);
salted value-derived identifiers (1.3); no effect request from a `lift` or
`computed` (3.14); handler factories bindable as values (3.21); the
accumulator of `reduce` is a data type, which `language-subset.md` §4.4.1
requires (3.13).

What remains is for the sibling documents, the specification change, or the
prototype. Each entry states the assumption this document made.

1. **How fine footprint analysis is for computed values.** Section 3.9
   gives a body's computed result paths one template and refines only
   references and required paths. `footprint-analysis.md` §4.1 settles it
   that way: one template per body, which equals today's label. A template
   per computed path would be a further claim under section 7.4, and unlike
   the reference rules the runtime could not verify it.
2. **References reached through data.** Section 3.9 covers a reference at a
   result path that equals an input reference. A reference the body found by
   reading through a handle is not an input slot. *Assumed:* it gets the
   `derive` template.
3. **The accumulator of `reduce`.** Not open: it is listed with the settled
   outcomes above. The entry keeps its number because other documents cite
   the entries after it by number.
4. **Demand as a channel.** Section 5.5 lists it as accepted. Whether a kept
   output that nothing demands should be marked stale, so that a later reader
   can tell, is undecided.
5. **`shape` versus `enumeration` in storage.** The plan separates them and the
   runtime's entry classes do not (section 2.2). *Assumed:* both resolve as a
   `shape` read until a count entry exists.
6. **Literals and integrity in the proof.** The existing Lean expression
   language gives a literal an empty integrity, which empties the meet of
   anything combined with it. Section 3.2 makes `const` neutral, as the runtime
   does. The Lean development of the specification change keeps the existing
   convention, which under-claims integrity.
7. **`count` over a raw list.** Section 3.8 marks `count` "equal or tighter"
   pending the stage 3 comparison.
8. **Nondeterministic inputs.** A handler reads the clock (`sendInto` stamps
   `sentAt`). *Assumed:* the coarse clock a handler may read, and entropy, are
   unlabeled inputs with no slot. The clock a pattern reads through `wish` is a
   cell (section 3.19).
9. **Where provenance and origins are stored.** A kept output carries its
   template, the identities bound to its slots, and the compiled pattern's
   identity; a kept derived collection carries the origin of each position
   (section 3.7). `execution-and-storage.md` specifies both: §7.2 has the
   provenance record of a kept output, held in the result envelope beside
   the label map, and §7.3 has the origins of a kept derived collection,
   held with its `enumerate` entry. The stored format is a host arrangement.
10. **A record in a template literal.** Section 3.19 gives a record
    substitution a `value` slot over its subtree. If the language renders a
    record as JavaScript does, only its `shape` is observed, and the slot can
    be narrower.
11. **An inline record in a stateful element body.** Section 1.3 makes it a
    compile error to declare state or bind a handler over plain values without
    the index, and assumes that where the compiler cannot tell (a record-typed
    input) an inline element fails its cone at run time. `language-subset.md`
    §4.4.1 has the static rule and its diagnostic
    (`collection:shared-element-state`): it decides "plain value" from the
    element type and from where the collection comes from, and treats an
    object-typed element of a list read from an input or a cell as identified
    by its cell. The run-time failure covers the inline record that rule
    cannot see.
12. **The cost of handler factory values.** Section 3.21 lists what moves to
    run time. Whether cycle detection and write classification stay useful when
    any cell handed to a handler value counts as written is for the prototype.
13. **The severity of the report for a surface no element carries.** Section
    4.4 has the compiler report a handler whose UI contract names a surface
    that no element binding the handler sits under. *Assumed:* a warning. The
    report shows that no event from this pattern's UI can satisfy the policy,
    and an event can still reach the handler from another pattern, through an
    exported stream. `language-subset.md` §10.5 has the catalog entry,
    `cfc-flow:ui-contract`.
14. **Label annotations with no rule here.** `language-subset.md` §8.1 lists
    the keys `addIntegrity`, `exactCopyOf` and `projection` (the aliases
    `AddIntegrity`, `RepresentsCurrentUser`, `AuthoredByCurrentUser`,
    `ExactCopy`, `ProjectionPath`, `ProjectionOf` and `Projection`) beside
    the keys section 4.4 places. The plan has no record for them and section
    3 has no template rule. *Assumed:* the annotation stays in the schema of
    the written path and the runtime applies it at the write as it does
    today. It adds the `addIntegrity` atoms as a declared entry, which is
    what section 3.12 relies on for an authorship atom. It verifies a copy or
    projection claim and carries the source's label
    (`verifyExactCopyRequirements` and `verifyProjectionRequirements` in
    `runtime/runner/src/cfc/prepare.ts`). How each combines with the
    template of a write edge is for the specification change.
15. **Which annotation yields a write floor.** `Constraint` has a
    `writeFloor` kind, and section 4.4 checks it on `I(template)` of a write
    edge. No annotation key of `language-subset.md` §8.1 is named for it.
    *Assumed:* `requiredIntegrity` on a path a body writes. That is the
    specification's rule (§8.12.4.1, `08-12-store-label-monotonicity.md`:
    "on a write target this declaration is a **floor**") and the key
    `verifyWriteFloor` (`runtime/runner/src/cfc/prepare.ts`) reads today.
    One annotation then yields a `requiredIntegrity` constraint over the
    slots that read the path and a `writeFloor` constraint on the edges that
    write it.
