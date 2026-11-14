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

The sibling documents are referred to by file name. `language-subset.md`
defines which source constructs lower to which operation, and
`builtin-inventory.md` places each built-in. `footprint-analysis.md` fills
in the record of a function body. `execution-and-storage.md` and
`scheduler-and-serving-loop.md` say how a plan is evaluated, stored and
scheduled. This document takes the operations as given and defines what
the plan records for them and what label each record yields.

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
- An **instance** is one running pattern with a result cell. A **cone** is a
  unit of evaluation. The compiler partitions what an instance computes
  into cones: every value is computed by exactly one cone, and a cone
  computes one or more outputs (section 1.4). A **cone instance** is one
  cone as it is evaluated for one scope instance and, inside element
  bodies, for one element key per enclosing collection
  (`execution-and-storage.md`, Terms). The body of an element construct is
  one or more cones, and an element key has one cone instance of each.
- A **cause** is what a transaction is opened for. There are four kinds: an
  event delivered to a handler, a set of changes, the completion of an
  effect, and a change of demand. A set of changes is the commits that
  arrived from storage, the commit of an effect's completion among them,
  and the writes of the events of a batch (section 5.4). The completion of
  an effect stores the effect's result in a commit of its own, and the
  derivations that read the result are evaluated in the transaction of the
  set of changes that commit joins (`scheduler-and-serving-loop.md` §10.2).
  A change of demand has a transaction of its own, which runs as the
  principal whose demand changed. Section 1.3 uses the word in a second
  sense, for what an identifier derives from, as in `.for(cause)`.

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

/** A position in source, for diagnostics. */
export interface SourcePosition {
  readonly file: string;
  readonly start: number;
}

/**
 * One step of where a declaration sits. The steps of a declaration, outermost
 * first, are part of the cause its identifier derives from (section 1.3).
 */
export type WithinStep =
  /** A call, compiled into this plan, of a pattern the compiler can see. */
  | { readonly site: string }
  /** The body of an element construct over a collection. */
  | { readonly element: Index };

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
  /** The state a handler was bound to: its captures. */
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
   * For an `identity` slot: the reference is observed after resolution, at
   * the cell where the chain of links that starts at the path ends
   * (section 2.5).
   */
  readonly resolved?: true;
  /**
   * For a `shape` slot: the observation is made in place. It observes
   * whether the position the path names holds anything, a link included,
   * and does not continue through a link stored there. A `shape` slot at a
   * position of handle type, or of reference type, has it (section 2.5).
   */
  readonly inPlace?: true;
  /**
   * The read is made with `sample()`. It is in the label, and a change at
   * the slot's address does not make a cone stale (section 2.5).
   */
  readonly sampled?: true;
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
   * that selector holds. The runtime supplies that position from its own
   * scan (section 3.13).
   */
  | {
    readonly op: "fold";
    readonly collection: Index;
    readonly body: Template;
    readonly through?: Index;
  }
  /**
   * One child chosen by a run-time key: an element of a collection, a child
   * of a container slot, or a child of a container the instance computed
   * (`Plan.outputs`). `pick` is the node's own choice point
   * (`Plan.picks`), as `selector` is a `select`'s. `body` is over the
   * chosen child's slots, and for a computed container it is the template
   * of the chosen child (section 3.18).
   */
  | {
    readonly op: "pick";
    readonly pick: Index;
    readonly from:
      | { readonly collection: Index }
      | { readonly container: Index }
      | { readonly output: Index };
    readonly choice: Template;
    readonly body: Template;
  }
  /** Reads whose addresses are known only at run time. */
  | { readonly op: "dynamic"; readonly reads: Index };

/**
 * A selection point: which branch of a `select` the value code took. A
 * selector that a `fold` names in `through` holds a position instead. The
 * runtime supplies it from its own scan, and the value code reports nothing
 * for it (section 3.13).
 */
export interface Selector {
  /**
   * Number of branches. The value code reports an index below this. For
   * the `through` of a `fold` it is 0.
   */
  readonly arity: number;
}

/**
 * A choice point: which child a `pick` chose. Two `pick` nodes are two
 * choice points, also where they choose from one container
 * (section 3.18).
 */
export interface Pick {
  /**
   * Who supplies the choice. `runtime`: the runtime chooses an element of a
   * collection from per-element results, and knows the element's key.
   * `valueCode`: the value code reports the key of the child it chose in a
   * container, or that it chose none.
   */
  readonly chosenBy: "runtime" | "valueCode";
}

/** A collection the instance maps, filters, or folds over. */
export interface Collection {
  /** The name an `element` step refers to it by (section 1.3). */
  readonly name: string;
  readonly within: readonly WithinStep[];
  /** The input collection, or what this one is derived from. */
  readonly source:
    | { readonly slot: Index }
    | {
      readonly collection: Index;
      readonly via: "map" | "filter" | "flatMap";
    }
    /** A bucket of a collection index (`Plan.operations`). */
    | { readonly operation: Index }
    /** An array the instance computed (`Plan.outputs`). */
    | { readonly output: Index };
  /** The label of which elements are present and in what order. */
  readonly membership: Template;
  /**
   * What a body applied to this collection does that makes the position
   * part of an element's key (section 1.3). `index`: the body uses the
   * element's index, and the position joins the key of every element.
   * `child`: the body instantiates a child, and the position joins the key
   * of every element that is a plain value. The element part of the key is
   * not recorded: it follows from each element at run time.
   */
  readonly bodyUses: {
    readonly index: boolean;
    readonly child?: true;
  };
}

/**
 * One use of a sandboxed function body and the result of footprint analysis.
 * Two calls of one function in the reactive tier are two records with the
 * same `code`. A handler is one record however many bindings name it.
 */
export interface Body {
  /** Content address of the body's source as the loader receives it. */
  readonly code: Hash;
  /** The name of this use, and where it sits (section 1.3). */
  readonly name: string;
  readonly within: readonly WithinStep[];
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
   * What the body observes of values the instance computed: the result of
   * another body, or of expression code (section 3.9).
   */
  readonly computed: readonly ComputedInput[];
  /**
   * The cell handles through which the body makes a read that no slot of
   * `reads` covers. Such a read is journaled while the body runs and enters
   * the label as a `dynamic` template. A handle the body only passes on,
   * writes through, or reads at slots of `reads` is not listed
   * (section 3.9).
   */
  readonly handles: readonly HandleReads[];
  /** The statically known targets the body writes, with their constraints. */
  readonly writes: readonly WriteEdge[];
  /** Where the body's writes that have no static target may land. */
  readonly envelopes: readonly WriteEnvelope[];
  /**
   * Result paths that are not plainly computed from the whole footprint
   * (section 3.9). A path with no entry is computed.
   */
  readonly outputs: readonly BodyOutput[];
  /** The runtime calls the body can make (section 3.14). */
  readonly calls: readonly BodyCall[];
  /** Where analysis gave up, for diagnostics (section 2.2). */
  readonly widenings: readonly Widening[];
}

/** One path of a computed value that a body observes in one way. */
export interface ComputedInput {
  /** Where the value sits in the body's argument. */
  readonly at: Path;
  readonly observes: ObservationClass;
  /** The label of what the body observes there. */
  readonly template: Template;
}

/**
 * A reference a body was given, named by where it reached the body: the
 * index of an `identity` slot, or an `identity` entry of that body's
 * `computed`, for a handle, a container or a factory value that reached the
 * body in a value the instance computed. The body is the one whose record
 * holds the name: for a `Binding`, a `Closure` or a `Child`, the body whose
 * site refers to it. A record of the reactive tier, which no site of a body
 * refers to, names a slot.
 */
export type GivenReference = Index | { readonly computed: Index };

/**
 * An `identity` entry of the `computed` of one body of the plan, where a
 * record of the plan and not of that body names it.
 */
export interface ComputedReference {
  readonly body: Index;
  readonly computed: Index;
}

/** A cell handle a body reads through at run time. */
export interface HandleReads {
  /**
   * The handle: its `identity` slot, an entry of `Body.reads`, or an entry
   * of `Body.computed` of class `identity` for a reference the instance
   * computed. A slot whose path has a `*` stands for every handle those
   * positions hold. `call` names a site of `Body.calls` that makes
   * something a later invocation of the body can find again: an
   * `instantiate` site of a body that is re-evaluated, an `instantiate`
   * site that is `identifiedBy: "tag"`, or a `createCell` site that is
   * `identifiedBy: "cause"`. The entry stands for the links to the
   * instances, or the handles to the cells, that site makes (sections 3.9
   * and 3.14).
   */
  readonly handle:
    | { readonly slot: Index }
    | { readonly computed: Index }
    | { readonly call: Index };
  /**
   * The read envelope: the schema every read through the handle is made
   * under. It admits the paths below the handle's cell that some read
   * through the handle may observe, each with its class, and nothing else.
   * Where it admits a position as a handle, the body may read through the
   * handle it finds there, and what the schema admits below that position
   * is the envelope of those reads (section 3.9).
   */
  readonly envelope: Hash;
}

/** How one path of a body's result relates to the body's inputs. */
export interface BodyOutput {
  readonly path: Path;
  /**
   * `passes`: the reference at this path is always one reference the body
   * was given, at an `identity` slot or at an `identity` entry of
   * `Body.computed`. `passes` names an entry whose path has no `*`.
   * `oneOf`: it is always one of several such references. An entry whose
   * path has a `*` stands for several references, so a reference taken
   * from it is named in `oneOf`, also where it is the only entry named.
   * The runtime verifies either by reference identity (section 3.9).
   */
  readonly reference?:
    | { readonly passes: GivenReference }
    | { readonly oneOf: readonly GivenReference[] };
  /** The result schema requires the path, so its existence is constant. */
  readonly required?: true;
}

/**
 * A site in a body that makes a runtime call. A site can run any number of
 * times in one invocation; each occurrence gets its own identifier
 * (section 1.3).
 */
export type BodyCall =
  /**
   * Instantiates a pattern and returns a link to the instance. `order`
   * identifies an occurrence by its order: among the requests of a
   * handler's invocation, or, in a body that is re-evaluated, among the
   * instantiations one evaluation makes at this site. `tag` identifies it
   * by the value given to `.for(...)` (section 1.3).
   */
  | {
    readonly kind: "instantiate";
    readonly child: Index;
    readonly identifiedBy: "order" | "tag";
  }
  /**
   * Creates a cell and returns a handle to it. Where the cause is a
   * constant, or the element key of the enclosing element body, in a body
   * that is re-evaluated, the cell is a state cell of the plan, and
   * `stateCell` names it (`Plan.stateCells`, section 3.14).
   */
  | {
    readonly kind: "createCell";
    readonly schema: Hash;
    readonly scope: "space" | "user" | "session";
    readonly identifiedBy: "order" | "cause";
    readonly stateCell?: Index;
  }
  /** Requests an effectful built-in and returns a link to its result. */
  | { readonly kind: "effect"; readonly builtin: string }
  /** Binds a handler to captured values and returns its stream. */
  | { readonly kind: "bind"; readonly binding: Index };

/** One place where footprint analysis gave up, and what covers it. */
export interface Widening {
  /**
   * The slots of `Body.reads` that stand for more than the body reads: a
   * `value` slot over a subtree, or the slots at `*` that stand for one
   * child the analysis could not name, with the `enumeration` slot of the
   * keyed container.
   */
  readonly slots: readonly Index[];
  /**
   * The entries of `Body.computed` that stand for more than the body reads,
   * in the same two ways, the `enumeration` entry of the keyed container
   * included, where the widened input is a value the instance computed.
   */
  readonly computed?: readonly Index[];
  /**
   * An entry of `Body.handles` the analysis lost track of. Its envelope is
   * then the handle's whole declared type.
   */
  readonly handle?: Index;
  /** Source position of the expression that caused it. */
  readonly at: SourcePosition;
}

/** A statically known write target of a body or cone. */
export interface WriteEdge {
  readonly target:
    | { readonly kind: "output"; readonly path: Path }
    | { readonly kind: "state"; readonly cell: Index; readonly path: Path }
    /**
     * The cell a handle links to, at a path below the handle's. `slot` is
     * the handle's `identity` slot: a handle in the event, in the state a
     * handler was bound to, in the argument, or in an element. With
     * `resolved`, the write is made through what `resolveAsCell()` returns
     * for the handle, and it lands in the cell where that resolution ends
     * (section 3.11).
     */
    | {
      readonly kind: "handle";
      readonly slot: Index;
      readonly path: Path;
      readonly resolved?: true;
    }
    /**
     * The same, for a handle that reached the writing body in a value the
     * instance computed. `computed` is the handle's `identity` entry of
     * that body's `computed`. The plan has no root and path for the cell
     * (section 3.11).
     */
    | {
      readonly kind: "handle";
      readonly computed: Index;
      readonly path: Path;
      readonly resolved?: true;
    }
    /** The argument document of a child instance. */
    | { readonly kind: "argument"; readonly child: Index; readonly path: Path }
    /** A cell the body creates at a `createCell` site (`Body.calls`). */
    | { readonly kind: "created"; readonly call: Index; readonly path: Path }
    /**
     * The stored request of an effect: of an operation of the plan, or of
     * an `effect` site of the body (`Body.calls`).
     */
    | {
      readonly kind: "request";
      readonly of: { readonly operation: Index } | { readonly call: Index };
      readonly path: Path;
    }
    /** The anchors document of the field at an `identity` slot. */
    | { readonly kind: "anchors"; readonly of: Index };
  /** The label of the value written. */
  readonly template: Template;
  /**
   * The value written at the target is a reference the body was given, as
   * `BodyOutput.reference` says of a result path. The runtime verifies it
   * by identity, and `template` applies where the check fails.
   */
  readonly reference?:
    | { readonly passes: GivenReference }
    | { readonly oneOf: readonly GivenReference[] };
  readonly constraints: readonly Index[];
}

/** Where writes that have no static target may land (section 3.11). */
export type WriteEnvelope =
  /**
   * At or below a path of the cell a handle links to. A `*` segment of
   * `path` stands for a child the analysis could not name. A slot whose own
   * path has a `*` stands for every cell an element links to. For a handle
   * the body finds by a read through another handle, `slot` is an
   * `identity` slot at the position where the handle is found, whose path
   * crosses the first handle's link. That slot is in no `reads`: it names
   * the place, is not materialized, and joins no template. `resolved` is
   * as for a `WriteEdge`.
   */
  | {
    readonly kind: "handle";
    readonly slot: Index;
    readonly path: Path;
    readonly resolved?: true;
  }
  /**
   * The same, for a handle that reached the body in a value the instance
   * computed: `computed` is its `identity` entry of the body's `computed`.
   * An entry whose own path has a `*` stands for every cell those
   * positions link to. For a handle the body finds by a read through the
   * entry's handle, `found` is the position where it is found: a path
   * below the cell the entry's handle links to, with `*` at each segment
   * the analysis cannot name. It is resolved as the path of an `identity`
   * slot is, so it crosses the link of a handle found on the way and stops
   * at its last segment. `path` is then at or below the cell the found
   * handle links to, and `resolved` applies to the found handle
   * (section 3.11).
   */
  | {
    readonly kind: "handle";
    readonly computed: Index;
    readonly found?: Path;
    readonly path: Path;
    readonly resolved?: true;
  }
  /** A cell a `createCell` site creates under a cause computed from data. */
  | { readonly kind: "created"; readonly call: Index };

/** A set of reads resolved at run time. */
export interface DynamicReads {
  readonly why:
    /**
     * The links followed from a reference: the one at an `identity` slot,
     * or one that reached a body in a value the instance computed.
     */
    | { readonly kind: "link"; readonly through: Index | ComputedReference }
    /** Reads through an entry of that body's `handles`. */
    | { readonly kind: "handle"; readonly body: Index; readonly handle: Index }
    /**
     * The access list of the space an `identity` slot's target lives in, or
     * of the space a `value` slot names. For an operand that reached a body
     * in a value the instance computed, its entry of that body's `computed`.
     */
    | { readonly kind: "space"; readonly of: Index | ComputedReference }
    /** Candidates a search found through links (section 3.19). */
    | { readonly kind: "search"; readonly body: Index }
    /**
     * Label-metadata observations a body made of targets no slot names
     * (section 3.16).
     */
    | { readonly kind: "labelMetadata"; readonly body: Index };
}

/**
 * What an input constraint is evaluated on: the inputs of the guarded
 * write's body whose path overlaps the annotated path (section 4.4).
 */
export interface ConstraintInputs {
  /** Slots of `Body.reads`. */
  readonly slots: readonly Index[];
  /**
   * Entries of `Body.handles` through which the body reads the annotated
   * path. `path` is the annotated path below the handle's cell. The
   * constraint is evaluated on the journaled reads through the entry
   * whose path overlaps it, in either prefix direction.
   */
  readonly handles?: readonly {
    readonly body: Index;
    readonly handle: Index;
    readonly path: Path;
  }[];
  /**
   * Entries of `Body.computed`, of any class, whose path overlaps the
   * annotated path. The constraint is evaluated on each entry's template,
   * instantiated.
   */
  readonly computed?: readonly {
    readonly body: Index;
    readonly computed: Index;
  }[];
}

/** A requirement on inputs or on a write (section 4.4). */
export type Constraint =
  | ({
    readonly kind: "requiredIntegrity";
    readonly patterns: readonly unknown[];
  } & ConstraintInputs)
  | ({
    readonly kind: "maxConfidentiality";
    readonly ceiling: readonly unknown[];
  } & ConstraintInputs)
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
  /**
   * For a kept output, its path in the result. For an interim output, a
   * path below the value `interim` names.
   */
  readonly path: Path;
  /** The name of the interim value this is a path of (section 1.3). */
  readonly interim?: string;
  /**
   * The cone that computes the value. For the assembled result of an
   * element construct, which no cone computes, see `collection`.
   */
  readonly cone: Index;
  /**
   * The output is the assembled result of this element construct
   * (`Plan.collections`). The runtime assembles the value and no value
   * function returns it. `path` is the path of the collection itself,
   * `template` is the collection's membership template, and `cone` is the
   * last cone of the construct's body in the order of `Plan.cones`
   * (section 1.4).
   */
  readonly collection?: Index;
  readonly template: Template;
  /** Whether the path is reachable from the result cell. */
  readonly kept: boolean;
  /**
   * The scope the plan knows the value to have. The scope at run time is
   * this one or a narrower one (section 1.4). Absent means `space`.
   */
  readonly scope?: "user" | "session";
  readonly constraints: readonly Index[];
}

/** One dependency cone: a unit of evaluation. */
export interface Cone {
  /** Name of the emitted value function for this cone. */
  readonly entry: string;
  /** Content address of that function's emitted source. */
  readonly code: Hash;
  /** Where the cone's code begins in source, for diagnostics. */
  readonly at: SourcePosition;
  /**
   * Every slot the value function receives, over all selections. The runtime
   * passes these, the outputs its incoming edges name, and nothing else
   * (sections 1.4 and 7).
   */
  readonly slots: readonly Index[];
  readonly bodies: readonly Index[];
  readonly selectors: readonly Index[];
  /** The choice points of the `pick` nodes the cone evaluates. */
  readonly picks: readonly Index[];
  /** Side-writes this cone performs besides its outputs. */
  readonly writes: readonly WriteEdge[];
  /**
   * Whether the cone's interim outputs are stored as a cache: always, or
   * never. Absent means the runtime decides (section 1.4).
   */
  readonly cache?: "always" | "never";
}

/** An edge between cones: `from` writes something `to` reads. */
export interface ConeEdge {
  readonly from: Index;
  readonly to: Index;
  readonly via:
    /** An output of `from` that the value function of `to` receives. */
    | { readonly kind: "output"; readonly output: Index }
    | { readonly kind: "state"; readonly cell: Index; readonly path: Path }
    /**
     * A cell `from` writes through a handle (`WriteEdge` target `handle`),
     * which a slot of `to` with the same root and an overlapping path reads.
     * `resolved` is as the write edge has it. A target that names its
     * handle by `computed` has no edge of this kind (section 3.11).
     */
    | {
      readonly kind: "handle";
      readonly slot: Index;
      readonly path: Path;
      readonly resolved?: true;
    };
}

/** A state cell and the cause its identifier derives from. */
export interface StateCell {
  /**
   * The name the cell's creation is caused by. For a cell that a
   * `createCell` site of a re-evaluated body creates under a constant
   * cause, or under the element key, the name is formed from the body's
   * `name` and the cause, and `within` is the body's (section 3.14).
   */
  readonly name: string;
  readonly scope: "space" | "user" | "session";
  /**
   * Where the cell is declared. Each `element` step adds that element's key
   * to the cause, which is legal only where the key is a cell's identity or
   * holds the position (section 1.3).
   */
  readonly within: readonly WithinStep[];
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
    | "materializer"
    /**
     * A `sqliteDatabase` declaration. It has no request and no
     * transaction of its own, and its state is the database's handle
     * (section 3.14).
     */
    | "database";
  /**
   * What implements it: a built-in; a body, which for a materializer is
   * the body whose `writes` and `envelopes` are its declared write envelope
   * (section 3.11); or, for a forced cache, the cone whose outputs it
   * stores.
   */
  readonly implementation:
    | { readonly builtin: string }
    | { readonly body: Index }
    | { readonly cone: Index };
  /**
   * The label of what the operation works from: for an effect, the join of
   * the templates of its request; for an aggregate, a `reduce` or an index,
   * the folded input; for a cache, the join over the slots of the cached
   * cone; for a materializer, the template of its body; for a database,
   * `const`, because its table declarations are constants of the plan. It
   * is also the label of the operation's bookkeeping state (section 2.6).
   */
  readonly input: Template;
  /**
   * A scope the operation has whatever the scope of the cone instance that
   * computes its request. For an effect, the scope its built-in declares
   * where it needs a requester or a reader, as `agent`, `navigateTo` and a
   * `sqliteQuery` on a database in another space or with `readClearance`
   * do (`builtin-inventory.md`, "The requester of a request"): the
   * operation then has a unit per demanding principal or session. For a
   * database, the scope the declared type of the handle gives. Absent, the
   * operation has the scope of that cone instance, and a database has
   * `space`.
   */
  readonly scope?: "user" | "session";
  /**
   * For a database: the table declarations, with the label rules they
   * hold, in the canonical form of the constant the source gives.
   */
  readonly tables?: unknown;
  /** The cause its state document's identifier derives from. */
  readonly name: string;
  readonly within: readonly WithinStep[];
}

/**
 * A pattern instantiated with a plan of its own: a pattern received as a
 * factory value, or any pattern a function body instantiates (section 3.15).
 */
export interface Child {
  /**
   * The pattern: known at compile time; a factory value, named by its
   * `identity` slot or, where it reached the instantiating body in a value
   * the instance computed, by its `identity` entry of that body's
   * `computed`; or an inline pattern written as the callee of an
   * instantiation in a body, with what it captures (`Plan.closures`).
   */
  readonly callee:
    | { readonly compiled: Hash }
    | { readonly factory: GivenReference }
    | { readonly closure: Index };
  /** Declared by the callee's type; what the enclosing plan checks against. */
  readonly argumentSchema: Hash;
  readonly resultSchema: Hash;
  /** The cause the instance's identifier derives from. */
  readonly name: string;
  readonly within: readonly WithinStep[];
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
    /**
     * The space a cell lives in. The cell is named by its `identity` slot
     * or, where it reached the requesting body in a value the instance
     * computed, by its `identity` entry of that body's `computed`.
     */
    | { readonly kind: "spaceOf"; readonly cell: GivenReference }
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

/**
 * A value of an `inSpace` request: a constant of the site, a slot, or a
 * value the requesting body computes, which carries that body's template.
 * The request consumes the value, so the slot is of class `value`, over
 * the subtree where the value is a container. A value that is one
 * projection of an input bound to a value the instance computed has no
 * slot and is recorded as `body` (section 3.14).
 */
export type RequestValue =
  | { readonly constant: unknown }
  | { readonly slot: Index }
  | { readonly body: Index };

/**
 * A pattern closure: an inline pattern bound to what it captures
 * (section 3.15). Used as a value, it is what a `factory` slot holds when
 * the factory was written in this plan. Written as the callee of an
 * instantiation in a body, it is the callee of a `Child`.
 */
export interface Closure {
  /** The compiled identity of the inline pattern. */
  readonly pattern: Hash;
  /** What is bound to each path of the pattern's private parameters. */
  readonly params: readonly {
    readonly path: Path;
    readonly template: Template;
    /**
     * For a closure used as a value: a data value is copied into the
     * factory value, and a cell stays a link. For the callee of an
     * instantiation in a body, as `Binding.state` has it for a binding
     * made in a body. No class is recorded for a copied path: the copy
     * holds what the slots with root `params` of the inline pattern's
     * plan observe of it (section 3.15).
     */
    readonly capture: "copy" | "link";
    /** As `Binding.state` has it. */
    readonly reference?:
      | { readonly passes: GivenReference }
      | { readonly oneOf: readonly GivenReference[] };
  }[];
}

/**
 * A handler bound to state: in the reactive tier, or at a `bind` site of a
 * body (section 3.14). The handler is a body of this plan, or a handler
 * factory received as a value (section 3.21). A factory value is named by
 * its `identity` slot or, where it reached the binding body in a value the
 * instance computed, by its `identity` entry of that body's `computed`.
 */
export interface Binding {
  readonly handler:
    | { readonly body: Index }
    | { readonly factory: GivenReference };
  /** For a factory value, declared by the factory's type. */
  readonly eventSchema: Hash;
  readonly stateSchema: Hash;
  /**
   * What is bound to each path of the handler's state. A binding of the
   * reactive tier has no path with `capture: "copy"`.
   */
  readonly state: readonly {
    readonly path: Path;
    readonly template: Template;
    /**
     * `link`: the path is bound by reference. It holds a cell handle, or a
     * container that has a stored address. In the reactive tier every path
     * is bound this way, and resolves to the slot or the output `template`
     * names. `copy`: a scalar, or a container the body computed, stored in
     * the binding's state document. A path that holds a reference on some
     * runs only is `copy`, and the runtime stores a link on the runs on
     * which the value it is handed carries a stored address. No class is
     * recorded for a copied path: the copy holds what the bound handler's
     * slots with root `binding` observe of it (section 3.14).
     */
    readonly capture: "copy" | "link";
    /**
     * For a path bound by reference in a function body: the reference the
     * binding holds, or the references it is one of, as
     * `WriteEdge.reference` says of a written path. Each is an `identity`
     * slot, or an `identity` entry of the `computed` of the body whose
     * `bind` site refers to the binding.
     */
    readonly reference?:
      | { readonly passes: GivenReference }
      | { readonly oneOf: readonly GivenReference[] };
  }[];
  /**
   * For a binding in the reactive tier: the cause of its stream, with
   * `within`. For a binding made in a function body, `within` is where the
   * `bind` site's body sits, and it does not enter the identifier of the
   * stream (section 3.14).
   */
  readonly name?: string;
  readonly within: readonly WithinStep[];
}

export interface Plan {
  readonly version: 1;
  readonly argumentSchema: Hash;
  readonly resultSchema: Hash;
  readonly slots: readonly Slot[];
  readonly selectors: readonly Selector[];
  readonly picks: readonly Pick[];
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
output. The saving for such a value is that it is a path of the result with
a memoized label, written in the transaction that computed it, and not a
node with a document and a transaction of its own. The keep set is stored in
as many documents as serve its readers, and section 2.3 says what a split
has to preserve.

The keep set is a property of the pattern and not of a run: the compiler
knows which output paths the result cell's schema reaches.

A pattern compiled into another has no plan of its own: a `map` body, an
inline sub-pattern, and a call in the reactive tier of a pattern the compiler
can see. Its slots, bodies and cones are entries of the enclosing plan, with
`element` roots where it reads the element. A pattern the compiler cannot
see at the call, and any pattern a function body instantiates, is a `Child`
with a plan of its own (section 3.15).

This document defines the footprint *record* (`Body.reads`, `computed`,
`handles`, `writes`, `envelopes`, `outputs`, `calls`, `widenings`). The
analysis that fills it in is specified in `footprint-analysis.md`.

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
instance, the steps of `within`, outermost first, and `name`. A `site` step
contributes the name of a call that is compiled into the plan, and an
`element` step contributes the name of its collection and the key of the
element. A durable operation's state document, a child instance's result
cell, and the stream of a binding of the reactive tier are named the same
way. Section 2.6 says where the state of an operation inside an element
body may hold the element key as a path segment instead.

**Names.** A name is not a position among unrelated declarations, so that
adding or removing a declaration does not rename another one's stored state.

- A declaration assigned to a `const` takes the variable's name, as the
  transformer's `.for(...)` does today.
- A declaration assigned to nothing takes a **base name** from what it is:
  the callee's name for a call site, a child, or a use of a body; the
  built-in's or the method's name for an operation and a collection; the
  handler's name for a binding of a named handler; the attribute's name for
  an inline event handler.
- A declaration of the reactive tier written with `.for(cause)`, as
  `X.for(cause)` on a cell constructor or `h.for(cause)` on a handle,
  takes the cause in the place of the name the two rules above give it.
  The cause is a string literal there. A cause that is data is legal only
  in a function body (below). *Assumed,* and the project owner's to
  confirm (section 8, question 31): a cause that is data in the reactive
  tier would make the name of a record of the plan a run-time value, and
  the state that differs per element is named by the element key already.
- Where two declarations of one pattern body have the same name by these
  rules, each takes the name and its ordinal among them, in source order.
  Adding a declaration with another name moves no ordinal. Adding one with
  the same name before an existing one moves the ordinals after it.

Names are unique within one pattern body, and the steps of `within` tell two
bodies apart. The records that hold a name are `StateCell`, `Operation`,
`Child`, `Collection`, `Body`, a `Binding` of the reactive tier, and an
interim `Output`. A `site` step holds the name of its call by the same
rules. A body that creates a cell under an explicit cause names the cell by
its own `name` and `within` and the cause, and not by its code, so that
editing the body does not rename the cells it addresses. Where the cause
is a constant, or the element key, the cell is a `StateCell` whose `name`
is formed from those (section 3.14).

**Element keys.** An element of a collection is identified by a key the
runtime computes from the element itself:

- the element's **value**, canonicalized and hashed, when the slot holds a
  plain value;
- the **identity of the cell** the slot links to, when it holds a link.

A link to a plain value is keyed by the cell it links to, so two cells that
hold equal values are two elements. A hole has no key, gets no cone
instance, and stays a hole. An explicit `undefined` is a plain value. A
plain value edited in place is a new element.

A key derived from a value is salted with a secret of the space before it
enters a document identifier, as the row identifiers of `sqliteQuery` are
(`builtin-inventory.md`, "Element keys"). Without the salt an identifier
would reveal a low-entropy value to anyone who can see a link.

A client cannot read the salt. It therefore cannot derive the identifier of
per-element state whose key holds a value, or of a handler binding with a
copied path (section 3.14). It names either one only from a link the server
has stored.

A cause that a body gives explicitly, to `createCell` or with
`.for(...)`, enters the identifier unsalted, as it does today. The two
cases differ in what the label of a link covers. An explicit cause is a
value the body read, so the identity label of every link to what the body
created, which is the body's template, covers it (section 3.14). An
element key is a hash of the whole element, and the label of a link into
an element's state covers only what that state was computed from.
*Assumed:* an explicit cause stays unsalted, so that a client can derive
the identifier. An observer who sees identifiers without reading a link,
such as one who can list the documents of a space, can then test a guess
of a low-entropy cause (section 8, question 30).

The position is part of the key in two cases, and a key then is the pair of
the element part and the position.

- **The body uses the index** (`Collection.bodyUses.index`). The position
  joins the key of every element.
- **The body instantiates a child** (`Collection.bodyUses.child`), and the
  element is a plain value. Two positions that hold equal plain values
  then have two children, and a factory element in
  `factories.map((F) => F({ ... }))`, which is a plain value, has a child
  per position. An element that is a link is keyed by its cell alone, so
  two positions that link to one cell share the child, as they share
  state.

A body instantiates a child where a `Child` of the plan is named through
the body's element: a factory value called in the reactive tier of the
body, or a pattern that a `lift` or a `computed` written in the body
instantiates, whose instances are named through that body's `within`
(below). *Assumed* for the second kind, which the ruling does not name
(section 8, question 37). Two things do not count.

- An instance that only a `handler` or an `action` requests. It is
  identified by the handling, or by an explicit tag, and by no element
  key.
- A statically resolved pattern called in the reactive tier of the body.
  The call is compiled into the body: it is a `site` step of `within` and
  no `Child`, it has no result cell, and a state cell it declares is a
  state cell of the body for the rule on state below
  (`language-subset.md` §4.4.1). Its own body can instantiate a child,
  and that child counts.

Where element bodies nest, the `within` of the `Child`, or of the
instantiating body, has one `element` step per enclosing element body.
`bodyUses.child` is set on the collection of every one of those steps,
so the position joins the key at each level at which the element is a
plain value. Set on the innermost collection alone, two equal plain
elements of an outer collection would share the inner cone instances,
and with them the child. *Assumed,* with the second kind above (section
8, question 37).

The purpose of the rule is that an element that moves keeps its cone
instances, so reordering a collection recomputes nothing. Keeping the
identifiers of
per-element state that is already stored is not a goal: today's key is the
target's identity plus an occurrence count for a linked slot and the position
for an inline value (`listElementKeys` in
`runtime/runner/src/builtins/list-element-keys.ts`), and stored per-element
documents under those keys are not found again.

Consequences, which later sections rely on:

- **Equal elements share their cone instances.** Two positions that hold
  equal plain values, or links to the same cell, have the same key, unless
  the position is part of the key. The
  body's cones are evaluated once for the key and both positions receive
  the values. That is sound because a body is a
  function of its element, its captures, and the index only when it uses the
  index.
- **State needs an element with an identity.** A state cell with an
  `element` step in `within` exists only where the element's key is a
  cell's identity or holds the position. An element body over plain values
  that declares a state cell without using the index is a compile error
  (`collection:shared-element-state`):
  two rows that show the same value would otherwise share one flag. The
  author uses the index, or makes the elements cells, which a list of
  records written by a handler already is. Two positions that link to the
  same cell are the same element and do share its state.

  The compiler reports the error where the element type is a primitive, or
  the collection is one the instance constructs inline, or one a body of
  the instance built, whose record has no `reference` at the element's
  path (`language-subset.md` §4.4.1). For a record-typed
  input the compiler cannot tell a stored link from an inline record.
  *Assumed:* such an element body compiles, and an element that arrives
  inline at run time fails its cone instances (section 5.2), so that
  state is never shared silently.

  Where the body instantiates a child, the key of a plain element holds
  the position without the body using the index. A state cell the body
  declares is then per position, and the reason for the error is absent.
  *Assumed:* such a body is accepted, by the rule that a state cell needs
  a key that is a cell's identity or holds the position (section 8,
  question 34).
- **A handler does not.** An element body over plain values that binds a
  handler and declares no state cell is accepted, with or without the
  index. Equal elements bind equal state, and they share one stream: the
  stream of a binding of the reactive tier is named by its `name` and
  `within`, the `element` step of `within` contributes the key, and two
  equal plain values have one key. An event on that stream names no
  position. A handler that has to act on one occurrence among equal
  elements uses the index, which puts the position in the key. Where
  positions that share a stream resolve an element slot to different
  labels, the handler's slot carries the join (section 2.6).
- **Values are per key, labels are per position.** The two positions can
  carry different labels, because a label is stored at an address and the
  addresses differ. The element slots of a template are therefore bound per
  position, to the address the element was read from, and for a linked
  element additionally to the cell. A position's label is instantiated from
  its own binding. Equal bindings give equal instantiation keys, so the memo
  of section 4.3 makes the common case one instantiation.

  Three things follow for whatever holds the state of an evaluation. A
  binding of an element slot is held per slot and position, with the
  element's key as a tag, and not per key. What positions with one key share
  is the value, the selections, and the reads made through handles and
  links, which start from the element's value and are the same for every
  position that holds it. The label identifiers of the element slots are not
  shared: the instantiation key of a position is formed from the labels
  resolved at that position's addresses.
- **A move is a membership change and nothing else.** It dirties the
  collection's membership and rebinds the moved positions' element slots. The
  label identifiers at the new addresses are normally those at the old ones,
  and then no element is evaluated and no label is instantiated.
- **An index-using body does not have this property.** Its key holds the
  index, so a move recomputes the moved elements, and its element template
  includes the collection's `enumeration` (section 3.6).
- **A body that instantiates a child has it for linked elements only.** A
  plain element that moves has a new key. Its cone instances are evaluated
  again, and it has a new child, whose state is that of the new key. The
  element template does not include the collection's `enumeration` on
  that account, because the body does not observe the position (section
  3.6). That a child's state is not the state the element had at its
  earlier position is visible to a reader of the row, and section 5.5
  lists it.
- **Keying is the runtime's observation, not the body's.** Deciding which
  cone instances an element has compares element values. The comparison flows
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
| A handler, no explicit cause | The handling and the occurrence's ordinal among the handler's requests in that invocation. A retry of the same event on the same stream with the same control flow names the same things. A handler binding is the exception: it is identified as in the last row everywhere |
| A handler, `.for(tag)`, or a cell created under an explicit cause | The enclosing instance, the handler's `name` and `within`, for an instance the site, and the tag or the cause, and not the handling, so that different events name the same thing. Two handlers of one instance that pass equal causes name two things, as two bodies do. Such a request counts toward the ordinal of the handler's later requests, although its own identifier does not hold the ordinal. A later event then finds what an earlier one made, and a read through the link or the handle is dynamic (section 3.9). The existence label of what the first event made is fixed at that creation (section 3.14). Today every identifier a handler's frame mints derives from a cause that holds the event's identifier, the ones with an explicit cause included (`#ensureLink` in `runtime/runner/src/cell.ts`) |
| A `lift` or `computed` | A cell: an explicit cause (`createCell`). A binding: the enclosing instance, the handler, and what the binding holds, and not the place of the site, so no step of `within` (`bind`, section 3.14). An instance: the enclosing instance, the body's `name` and `within`, the site, and the ordinal of the instantiation among those the evaluation makes at that site, or, with `.for(cause)`, that cause in place of the ordinal (`instantiate`, section 3.14). No identifier holds an ordinal among all the requests of an evaluation, because such a body is re-evaluated. Such a body does not request an effect itself |

**A handling** is identified by its receipt: the event's identifier and the
stream the event was sent to (today `handlingReceiptId` in
`runtime/runner/src/scheduler/event-identity.ts`). The receipt leaves the
acting principal out, so one event on one stream is one handling whoever
sends it. The string `eventKey()` returns is a different thing: it is a
context read (section 3.16) and it names the acting principal too. An event
a handler sends on a stream is identified by the handling and the event's
order among the events that invocation sends.

### 1.4 Order, the inputs of a cone, scope, and the cache directive

**Order.** `Plan.cones` is listed so that every edge of `Plan.edges` that is
not on a cycle goes from a lower index to a higher one. `Plan.outputs` is
listed by cone in that order, and within a cone in source order. An edge
from a cone to itself or to a cone with a lower index is therefore on a
cycle, and a cycle exists only through a side-write (section 3.11).

**The inputs of a cone.** The compiler partitions what an instance
computes into cones. Every value the instance computes is computed by
exactly one cone, and a cone computes one or more outputs (`Output.cone`).
The body of an element construct is one or more cones whose slots include
`element` roots, each evaluated once per element key (section 1.3). A
cone's value function receives two kinds of
input: the slots in `Cone.slots`, and the outputs of other cones that its
incoming edges of kind `output` name. It receives nothing else. An output
that another cone, a `pick`, or a collection refers to is an entry of
`Plan.outputs` whether or not it is kept. An interim output has
`kept: false`, and its `path` is below the name in `interim`, which is not
a path of the result. A value that only the cone computing it uses has no
entry.

**The assembled result of an element construct.** The runtime assembles
the result of a `map`, a `filter` or a `flatMap` from per-element results
(sections 3.6 and 3.7), and no value function returns it. Two kinds of
entry of `Plan.outputs` concern such a construct.

- **Per element.** An output that a cone of the body computes is an entry
  whose `path` has `*` at the position of each enclosing collection. Its
  `cone` is that element cone and its `template` is over `element` slots.
  Inside the body, `host.output` of such an entry returns the value for
  the element the cone instance is evaluated for. No edge names such an
  entry from outside the body.
- **Assembled.** Where the collection is kept, or a cone or a body outside
  the construct uses it as a value, the plan has one further entry for
  the collection itself, with the member `collection` naming the
  `Collection`. Its `path` is the path of the collection, with no `*` for
  the collection's own elements. Its value is the array the runtime
  assembled: the positions in order, each with what the body's cone
  instances computed for the key at that position, or for a `filter` the
  source elements that were admitted. Its `template` is the collection's
  membership template, which is the label of the container itself and
  what the `enumerate` entry of a kept collection holds (section 2.3).
  The labels of the elements are those of the per-element entries. A
  consumer's template for what it observes of the elements is built from
  those: a `fold` over the collection, or the entries of `Body.computed`
  at paths below `*` (section 3.9).

  No cone computes the assembled entry, and `cone` is required, so it
  names the last cone of the construct's body in the order of
  `Plan.cones`: for a `filter`, of the cones of its predicate. Every
  cone of the body then has an index at or below it, and an edge of kind
  `output` from that cone to a consumer places the consumer after the
  whole body. The entry is current when every cone instance of the body
  is current for every key and the runtime has performed the structural
  step. `host.output` of the entry returns the assembled array, after the
  runtime has brought those cone instances up to date
  (`execution-and-storage.md` §2.5).

**Scope.** `Output.scope` is the narrowest scope the plan can show for the
value, in the order `space`, `user`, `session`. It is the narrowest among:

- the declared `scope` of every `StateCell` and `Child` whose slots the
  output's template reaches, and the `scope` of every `Operation` whose
  result it reaches;
- `user`, where the template has a `dynamic` node of kind `space` for a read
  that answers for the acting principal (`spaceAccess` and `spaceMembers`,
  section 3.16).

The scope an output has at run time can be narrower, because a slot can be
bound through a link to a document of narrower scope, and it is never
wider. The scope of a cone instance is the narrowest among `Output.scope`
of the cone's outputs, the addresses its slots are bound to, and the
addresses its `dynamic` nodes read. Which scope instances a cone is
evaluated for belongs to `execution-and-storage.md` (§1.8) and
`scheduler-and-serving-loop.md` (§2.1). A scope is not a
label: it says for whom a value is computed and stored, and the label of
each scope instance is instantiated from that instance's own slots.

**The cache directive.** `Cone.cache` says whether the cone's interim
outputs are stored between evaluations. `always` comes with an `Operation`
of kind `cache` whose `implementation` names the cone. `never` forbids the
runtime to store them. `language-subset.md` has no form by which an author
writes either, so a compiled plan leaves the member absent, and the runtime
decides. Section 2.6 gives the label of what a cache stores.

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
| `shape`, with `inPlace` | `followRef` where the position holds a link, `shape` where it does not | `followRef`; or `shape`, `enumerate` | At the slot's path, without continuing through a link stored there (section 2.5) |
| `enumeration` | `shape` | `shape`, `enumerate` | At the container's path |
| `identity` | `followRef` | `followRef` | At the slot's path, and for a `resolved` slot at every link resolution follows from there |

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
  recursive read consumes. Footprint analysis prefers narrower slots. Where
  it gives up, the slots it records cover the entries a precise analysis
  would have recorded (section 1.1, `Widening`): a `value` slot at the
  projection of a value it lost, which stands for the subtree below; slots
  at `*` for a key it could not name, which stand for every child, with
  the `enumeration` slot of the keyed container; and for a
  handle it lost, an entry of `Body.handles` whose envelope is the handle's
  whole declared type. On an input the instance computed, the wider entries
  are entries of `Body.computed`, and `Widening.computed` names them. This
  is the over-approximation the overview allows.
- **`identity` never reaches the target.** It observes which reference sits
  at the path. What the reference refers to is read at a path that
  continues past it: by a slot whose path crosses the link, where the plan
  names the path (section 2.5), and by a `dynamic` template where it does
  not (section 3.10).

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

**Several documents.** The keep set of an instance is stored in as many
documents as serve its readers. A kept subtree, such as a row of a kept
collection or a part of the rendered tree, can be stored in a document of
its own, a **part document**, with the place it has in the result holding a
link to it. Which subtrees are split off, how a part document is
identified, and what a reader of a part demands belong to
`execution-and-storage.md` (§4.10). A split changes neither a value nor a
label when the following hold.

- **The link is not a reference of the language.** The link from the result,
  or from one part to another, is a **storage link**, which the runtime
  writes and no pattern code holds. Resolving a path passes through it
  without observing it. It is never the reference an `identity` slot
  observes, it is not on a slot's chain (section 2.5), it gives an element
  no cell identity as a key (section 1.3), and a body that passes on a
  subtree which happens to be a part passes on what it would pass on if the
  subtree were stored in place. A reference to a kept path names the
  result cell and the path, whichever document stores the path.
- **The link carries no label.** A read that passes through a storage link
  consumes nothing for it. Every observation class at every kept path
  consumes what it would consume if the subtree were stored in place. A
  storage link to a part names the part document and holds nothing else:
  no path, no schema, no scope, and no label entry. Two labels concern the
  place a part
  has, and both are stored where a layout without the split stores them.
  Which rows a collection has is the `enumerate` entry of the collection's
  document, and that a row exists is the `shape` entry at the row's root,
  which is the root of the part.
- **Entries follow the paths they label.** The entries of a path inside a
  part document, the root of the part included, are stored in that
  document's envelope, at the path relative to the part's root: the `value`
  entry, the frozen `shape` entry, the `enumerate` and `*`-child entries of
  a collection inside the part, and the declared entries the result schema
  gives those paths. An entry at a path above the part, including the
  `enumerate` entry and the `*`-child entries of a collection whose
  elements are parts, stays with the document that stores that path. A read
  that covers a subtree with parts in it consumes the entries of every
  document the subtree is stored in.
- **A part's envelope is complete for its paths.** A part document has no
  label as a whole. For each kept path inside it, its envelope holds every
  entry that a layout without the split holds for that path: the `value`
  entry with the instantiated template of that output path, with the
  element slots bound for the row's position, the frozen `shape` entry,
  and the declared entries. Where a `*`-child entry of a collection above
  the part covers the path, the part's envelope holds an entry at the path
  with that entry's label all the same. A read of a part document by its
  own address then consumes what a read of the same paths through the
  result consumes, and no path is served under a label that only another
  document holds.
- **The repeated entry and the `*`-child entry agree.** A `*`-child entry
  stays in the collection's document, where it covers the positions stored
  in place. It is stored only while every position instantiates to its
  label, the positions that are parts included, and one transaction writes
  it and the entries of the parts. A read through the result that consumes
  both consumes one label twice, which a join absorbs. The entries of a
  part are those of the position its row has: a move that changes a label
  the row's slots resolve to rewrites them in the transaction that moves
  the row.
- **A storage link reveals no element key.** A storage link is part of what
  is stored, and a reader who may read the document that holds it can see
  it. For a row, that is a reader of the collection's membership. The
  identifier the link names is derived from the keys of the elements on the
  part's path (`execution-and-storage.md` §4.10), and an identifier derived
  from a cell's identity can be compared with one derived from a guessed
  cell. *Assumed:* the identifier of a part document is derived under the
  secret of the space for every key, a cell's identity included, as a
  value-derived key is (section 1.3). It then tells such a reader which
  positions hold the same row before and after a change of membership,
  which the membership label covers, and nothing of the cell or the value
  a row was computed from. No client needs to derive the identifier: a
  reader names the result cell and a path.
- **One transaction writes them.** An evaluation writes the result document
  and every part document it changed in one transaction, so no reader sees
  a value in one document under a label from another state.
- **The checks are on result paths.** The constraints of section 4.4 are
  evaluated per output path and per write edge, and do not depend on which
  document stores the path.

**A link between scope instances.** A kept output of narrower scope than
the scope instance that holds its path is stored in the narrower scope
instance of the same document, and the broader one holds a link in its
place (`execution-and-storage.md` §4.2). That link is a storage link too.
It names the same document and path and holds the narrower declared scope,
with no user or session identifier, and nothing else: no schema and no
label entry. The properties above hold for it.

- The runtime writes it and no pattern code holds it. An `identity` slot
  does not observe it, it is not on a slot's chain, and it gives an
  element no cell identity as a key: a row whose kept value is of session
  scope is keyed as it would be if the value were stored in place.
- A read that passes through it consumes nothing for it. Every
  observation class at the path consumes the entries that the narrower
  scope instance's envelope holds for the path, which are the ones the
  output's template instantiated to for that scope key.
- The transaction that stores a value in a narrower scope instance writes
  the link in the same transaction.

The scope an output has at run time can be narrower than the plan's
(section 1.4), so whether a path of the broader scope instance holds a
value or such a link can depend on data. Section 5.5 lists it.

Whether a subtree is split off follows a rule about size, and size is a
function of data. An observer who can list the documents of a space can
see it, and so can a reader of the document that holds the storage link.
Section 5.5 lists this with the residuals.

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

### 2.5 Paths that cross links, resolved references, and sampled reads

**A slot path may cross a link.** A slot's path is resolved from its root
the way a read resolves it. Where the value at a segment is a stored link,
resolution continues at the link's target. That is the case for an argument
path that holds a link to a cell of the parent, for a position of a data
type that storage holds as a link to a record's own document, and for a
path that continues below a cell handle. The addresses of the links crossed
are the slot's **chain**, and the address where resolution ends is where
the slot is **bound**.

- **Label.** The slot's confidentiality is the join of the `followRef`
  entries at each address of the chain with what the slot's class consumes
  at the bound address (section 2.2). Its integrity is that of the
  observation at the bound address alone: a pointer contributes
  confidentiality and no integrity
  ([CFC observation classes](../cfc-observation-classes.md) §6.1). This is
  what a journaled read through the same links consumes today, so the
  definition of section 2.2 already covers it, and §8.2.4
  (`08-02-pass-through-via-references.md`) requires it of a dereference.
  One case differs: a slot that reads as a default has the empty
  integrity ("A default belongs to the place", below).
- **`identity` stops at its last segment.** The chain of an `identity` slot
  holds the links crossed before the last segment, and the slot observes
  the reference stored there. Every other class resolves through a link at
  the last segment, with the one exception that follows.
- **A `shape` slot in place.** A `shape` slot with `inPlace` stops at its
  last segment too. It observes whether the position holds anything. A
  `shape` slot without the flag, at the same path, observes the root of the
  cell that a link at the position leads to. A body that writes
  `profile?.get()` on an optional handle makes both observations: the test
  of whether a handle is present is at the position, and the read is in
  the cell. Where the position holds a link, the slot in place resolves as
  a `followRef` read of the position, which is the read that hands a body
  the handle today. The label of which reference a position holds covers
  that it holds one. Where the position holds no link, the slot resolves
  as a `shape` read of the position.

  The flag is set on every `shape` slot at a position of handle type, and
  on every `shape` slot at a position of reference type, which is
  `unknown` in a data type (`language-subset.md` §7.8). A position typed
  `unknown` holds a reference whose target the code cannot read, so a test
  of presence or kind there is a test of the position, whatever is stored
  behind the reference. Without the flag the slot would resolve through
  the reference and take the label of the root of a cell that the code
  never observes.
- **A hop made by `key`.** `key` flattens every handle it passes through
  (`language-subset.md` §4.7): for `h` of type `Cell<{ a: Cell<T> }>`,
  `h.key("a")` is the handle at the position `a` of the cell `h` links
  to, written `h->a`. No `get()` makes the hop through `h`, and the path
  crosses the link all the same. The `identity` slot at `h->a` has the
  link of `h` on its chain and observes the reference stored at `a`, by
  the rule above. A slot below `h->a` has both links on its chain. The
  observation is made where the flattened handle is read, written
  through, passed on or bound (`footprint-analysis.md` §7.1).
- **Rebinding.** A change at an address of the chain changes where the slot
  is bound, and the slot's label is resolved again from the new chain. How
  a chain is watched belongs to `scheduler-and-serving-loop.md`.
- **Other instances and other spaces.** A chain can end in the result of
  another instance or in another space. The slot is a slot all the same,
  and its label is what a read at the bound address consumes there.
- **Storage links are not on a chain** (section 2.3).
- **A path that holds `*`.** A slot whose path has a `*` segment stands
  for every child the path reaches. It is bound at one address per child,
  and each of those bindings has a chain of its own: the links crossed on
  the way to that child, the link a position of the container holds
  included. The children are known once the container was read, so the
  bindings are made then, and a change of the container's children binds
  the slot again, as a change of membership binds element slots again
  (`scheduler-and-serving-loop.md` §3.2). The slot's confidentiality is
  the join, over the children, of what the rules above give each binding.
  Its integrity is the atoms that the observation at every one of the
  bound addresses carries. Which children there are is the membership of
  each container on the path. The slot's own label does not hold it: a
  footprint that has a slot below `*` has the `enumeration` slot of that
  container as well (`footprint-analysis.md` §3.1), and a template that
  joins the one joins the other. Where the runtime has verified by identity
  which child's reference a body passed on (section 3.9), the label of
  that reference is the label of that child's binding alone. This is what
  the journaled reads of the same children consume today.

A read stays `dynamic` where the plan cannot name its path ahead of the
evaluation: a read through a handle that happens on some runs only or at a
path the body computes (section 3.9), and a read through a reference the
instance computed (section 3.10).

**A resolved reference.** An `identity` slot with `resolved` observes the
reference where resolution ends: the links are followed from the slot's
path until a cell is reached whose value is not a link. Its chain includes
those further links, and its label joins the `followRef` entries at each.
The reference the runtime hands to code for such a slot is the resolved
one. `resolveAsCell()` at a static place, `spaceOf`, and the other calls
section 3.16 lists observe a reference this way.

**A sampled read.** A slot with `sampled` is a read made with `sample()`.
Its label joins the template like any slot's. A change at its address,
of the value or of the label, does not make a cone stale and gives no
output a new instantiation key: the label that enters the key is the one
resolved when the cone was last evaluated. A `sample()` through a handle
of `Body.handles` is journaled and joins the `dynamic` label in the same
way, and is not registered as something that makes the cone stale. Today a
sampled read is made through a transaction that journals it and marks it
as not scheduling (`sample` in `runtime/runner/src/cell.ts`), so the label
is **equal**.

**A default belongs to the place.** By ruling, a default belongs to the
stored place, and a reader bound to the place by reference gets a link and
not a copy. A link holds, beside the address it names, the schema of the
place it names, as the plan of the instance that wrote the link declares
it, and so the default that declaration has. A slot whose path crosses a
link is read under the schema of the slot, with one member taken from the
chain: the default of the link nearest the bound address whose schema
declares one. Where no link of the chain declares one, the default of the
slot's own schema applies. Everything else the read validates against is
the slot's schema alone. So where nothing is stored at the bound address,
the slot reads as the default of the place's declaration, for every
reader, a reader whose own schema declares no default included.

- **A path that resolves without a stored link.** A path of the state of
  a binding of the reactive tier resolves to a slot of the instance
  (section 3.14), and a slot of a pattern compiled into another is an
  entry of the enclosing plan (section 1.1). No link is stored for
  either. The rule is the same: the read is made under the reader's
  schema with the default of the schema of the slot it resolves to
  (`Slot.schema`), which is the place's declaration.
- **Which plan holds the default.** The reader's plan does not hold it.
  A handler is one `Body` however many bindings name it, and its
  `binding` slots have the schema its own state type declares. The
  default reaches a read at run time, from the link or from the slot the
  path resolves to. No record changes.
- **The confidentiality.** A default read through a link has the
  confidentiality of the slot, by the rules above and no further rule:
  the join of the `followRef` entries at each address of the chain with
  what the slot's class consumes at the bound address, where the read
  found nothing stored. This is the case of section 5.2 in which a slot
  reads as the default its schema declares, and the confidentiality is
  that of the slot there too. The link that holds the default is on the
  chain, so the label of which link the reader holds, and with it of
  which default, is joined. The default is a constant of the source of
  the pattern that declares the place. It does not enter the reader's
  templates as a `const`, because the reader's plan does not hold it: it
  is what the slot read.
- **The integrity.** By ruling, a read of a default carries no integrity.
  The rule holds for a default of each of the three origins: the place's
  declaration, the schema of a link of the chain, and the slot's own
  schema (section 5.2).
  - Where nothing is stored at the bound address, the slot has the empty
    integrity.
  - Where an object is stored at the bound address and one of its
    properties is absent and filled by a default, the defaulted part has
    the empty integrity and not the claims of the stored object. A slot
    bound at a property that is stored keeps the integrity of the
    observation there.
  - *Assumed* (section 8, question 43): a slot that reads the object
    whole takes the meet over the parts it read, so its integrity is
    empty where a part was filled by a default.

  The value of a default is not stored at the bound address, and no
  principal wrote it there. It comes from a schema, and a pointer
  contributes no integrity. An empty integrity under-claims, which is
  the fail-safe direction (§8.9 of `08-09-runtime-label-propagation.md`).
  The specification has no rule for a default that is read and not
  stored, and needs this one. Its §8.15 (`08-15-write-authority.md`)
  separates initialization from attribution and mints no principal claim
  for a default, and its §3.7.2 (`03-core-concepts.md`) gives a link no
  integrity that was not minted for it; neither says what integrity a
  reader finds where a schema supplied the value. A rule that requires
  integrity of a value therefore refuses a default, and a place that has
  to satisfy such a rule holds a stored value.
- **A write.** A write through a handle to such a place stores a value at
  the place, under the label of the writing edge. Every reader then reads
  that value, and the default is no longer read.
- **A copy is not a link.** Where a binding made in a function body
  copies a scalar (section 3.14), the copy holds what the body read. A
  scalar read from a place where nothing is stored, and whose declaration
  has a default, is copied as the default, with `T_b`.

Today a read that crosses a link continues under the reader's schema and
takes the default of the last link crossed whose schema declares one,
the reader's own where none does (`combineSchemaForLink` in
`runtime/runner/src/traverse.ts`; a payload of a link has a `schema`
member, `CellLinkRefPayload` in `runtime/runner/src/sigil-types.ts`). An
absent value takes the default of that combined schema before it is
validated (`materializeSchemaView` in `runtime/runner/src/schema-view.ts`,
through `defaultForAbsentValue`), and the read of the path found empty is
registered in the transaction, so the default carries the join that the
read contributes. A binding a pattern makes is written as a link with the
schema of the path it names (`unwrapOneLevelAndBindToDoc` in
`runtime/runner/src/pattern-binding.ts`). The value and the
confidentiality are **equal**. The integrity is **tighter**: today the
read has the integrity of the observation at the bound address, and by
the rule above it has none.

**A handle to a position that holds nothing.** An `identity` slot at a
position of handle type yields a handle whether or not anything is stored
at the position. Where the position holds a link, the handle names the
cell the link leads to. Where it holds a plain value or nothing, the
handle names the position itself: that path of the document the slot's
root is in. So the body of a pattern is handed a handle for an optional
property of its input that the caller left out, and the handle names that
path of the instance's argument document. A read through it finds nothing
stored and gives the default of the declaration, by the rule above, or
what section 5.2 gives where there is none. A write through it lands at
that path. Whether such a position holds anything is observed by a `shape`
slot in place (above), and the `identity` slot's own label is that of the
`followRef` read of the position. Today a position declared as a cell is
handed to the body as a handle where nothing is stored
(`processDefaultValue` in `runtime/runner/src/schema.ts`, and the branch
for a link to an absent value of `#traversePointerWithSchema` in
`runtime/runner/src/traverse.ts`). **Equal.**

### 2.6 Stored state that is not an output

Beside outputs and write targets, the runtime stores state of its own: the
state of a durable operation, the entries of a cache, a provenance record
per kept output, the origin facts of a kept derived collection, the
record of the instances a computation made, and the rows a serving
runtime's scheduler keeps beside the documents of a space. Each is
derived from data, so each has a label. No template has a slot for any
of it except an operation's result, so these labels never join the label
of an output. They govern a reader that reaches the stored state by
another route, and what the runtime may show of it in a diagnostic or to a
tool.

| What is stored | Label |
| --- | --- |
| The result of an operation, a bucket of an index, a checkpoint of a `reduce` | The rule of the operation (sections 3.8, 3.11, 3.13, 3.17); for an effect, the declared rule of its boundary |
| Every other path of an operation's state document: a contribution per element key, an index key per element key, a count, and the request hash, the claim and the pending mark of an effect | The confidentiality of `Operation.input`, instantiated, and no integrity. For an effect it is joined with what following the references of the request consumed (section 3.14). An effect a handler requested has no `Operation` record, and the join is over the templates of the `request` write edges of its site |
| A cached output, of a cone the runtime promoted or of a forced cache | The output's own template, instantiated as for a kept output |
| Every other member of a cache entry: selections, the keys a `pick` chose, and what the entry records of the cone's reads | The confidentiality of the cone-level join (section 7.2), and no integrity |
| The provenance record of a kept output path: its selections, its instantiation key, the addresses of its dynamic reads | The confidentiality of the output's instantiated label, joined with the label of the label-metadata observation at the path, and no integrity |
| The origin facts of a kept derived collection | The collection's instantiated membership label |
| The record of which instances the last evaluation of a `lift` or a `computed` made at each site (section 3.14) | The confidentiality of the body's template, instantiated, and no integrity |
| The record of the children an element body has under an element key (`execution-and-storage.md` §2.5) | The collection's instantiated membership label, for each collection whose element key the record is stored under, and no integrity |
| The allocation record of a space an `inSpace` request creates (section 3.14) | The confidentiality of the requesting body's template, instantiated as section 3.14 says for a record that commits ahead of its unit, and no integrity |
| A path of any of these that holds label identifiers, such as the count per identifier a `fold` keeps (section 4.3) | The label of its row above, joined with the label of the label-metadata observation of each label it names |

Why each label covers what is stored:

- **Bookkeeping of an operation.** Every contribution is a function of the
  elements the operation folds, and `Operation.input` joins all of them and
  the membership. The label is wider than one contribution needs. Nothing
  the language has reads a contribution, so the width costs nothing.
- **The request hash of an effect.** `Operation.input` joins the templates
  of the request, and a path of the request that holds a reference has the
  label of the pointer. The hash is computed from the content behind those
  references, the operands that are hashed and not sent included. Its
  label is therefore the joined label of section 3.14, and the claim and
  the pending mark, which say that a request with that hash is being made,
  take the same label.
- **No integrity.** Bookkeeping is the runtime's own data structure and not
  a value an upstream claim describes, and the code named by a
  `TransformedBy` atom did not compute it. An empty integrity under-claims,
  which is the fail-safe direction (§8.9.3).
- **A cached output** is the value a kept output would be, so it has that
  label. A cache entry's other members are functions of what the cone
  read, which the cone-level join bounds.
- **A provenance record.** A selection is a function of the value of a
  condition, the instantiation key is a function of selections and labels,
  and an address a body read is a function of the body's inputs. The
  output's template joins the conditions and the body's footprint, and the
  label-metadata observation covers the labels. The label of the path's
  label metadata alone would not cover a selection.
- **Origin facts** say which elements a predicate admitted, or how long
  each segment was, which is what the derived collection's membership
  template joins (section 3.7).
- **The instances a computation made.** How many instances an evaluation
  makes at a site, and under which causes, is a function of what the body
  read, which the body's template joins.
- **The children of an element body.** A child that a factory value
  called in the reactive tier of an element body makes is no instance a
  computation made, and no body's template covers it. The runtime lists
  it all the same, per element key, in the instances document of the
  enclosing instance, so that a child whose key no position holds any
  more is found and torn down after a restart. The record says that the
  collection has an element with that key, which is what the membership
  label covers. Which child the record names follows from the key and
  the `Child` record, and adds nothing.
- **An allocation record.** That a space exists under a name, or for a
  request, is a function of what the requesting body read, and so is a
  name the body computed. The identifier the record holds is obtained and
  is a function of no data.

**Stores the runtime owns.** An operation's state document and a cache
document are written by the runtime alone, and no authored schema declares
a label for them. They are stores the runtime owns, in the sense in which
it owns a built-in's store today (`RuntimeOwnedStores` in
`runtime/runner/src/cfc/runtime-owned-stores.ts`): writer-fit has no
declared confidentiality to test a write against, no writer policy applies,
and what is stored is the derived label of the table above.

**Rows beside the documents.** The scheduler of a serving runtime keeps
three kinds of row in the space's store, beside the documents
(`scheduler-and-serving-loop.md` §10.4, §5.1 and §10.6): a basis row per
cone, scope instance and input document, which holds the sequence number
of that input at the last evaluation; a row of the stream index per
stream, which leads from the stream's identifier to its instance and its
binding; and a pending-effect row per effect operation that a handler
requested and that has a pending mark, which holds the operation's
state document, the result cell of the instance whose handler requested
it, and the requester, the principal the event was stamped with. The stream
index is ruled: an event is routed
through it to an instance that is not loaded. Its row takes the place of
the `result` back-link that setup stores on a stream's document today. A
row is not a document. It has no address a reference can name, no
envelope, and no stored label. That scheduler alone reads it: a row is
never sent to a client, never read at admission, and no pattern code
reaches it. A row is derived from data all the same. *Assumed:* where the
runtime shows one in a diagnostic or to a tool, it shows it under the
label below.

- **A row of the stream index** says that a stream exists. For a binding
  of the reactive tier in an element body it says that the collection has
  the element, so the row carries the collection's instantiated membership
  label, for each collection whose element key it holds. An element key
  derived from a value is held salted (section 1.3). For a binding made
  in a function body the row carries the identity label of the stream
  (section 3.14).
- **A pending-effect row** is written with the pending mark of the
  operation and deleted with it, and activation reads the rows to find
  the requests to make again. It says what the pending mark says, that a
  request of that operation is being made, so it carries the label of
  the pending mark: the joined label of section 3.14. The requester is
  the acting principal of the event, which the runtime attests and which
  carries no confidentiality (section 3.16), so it adds nothing to that
  label. The operation's
  state document holds a back-link to the same instance
  (`execution-and-storage.md` §6.4). The runtime writes that back-link
  and no pattern can write it, and which instance it names follows from
  the stream the event was sent to. Reading it joins no label, as reading
  the `result` back-link of a document joins none (section 3.16).
- **A basis row** says which documents a cone read, for one scope
  instance. For the reads
  of a `dynamic` node that is data, so the row carries the confidentiality
  of the cone-level join (section 7.2), as what a cache entry records of
  the cone's reads does. The scheduler also consults basis rows to decide
  whether a read returns a stored value without loading the instance that
  wrote it (section 5.4). That use shows no row to anyone and changes no
  label: the read joins the label stored at the address, as any read of a
  stored value does.

**The state of an operation inside an element body.** An `Operation` with
an `element` step in `within` has state per element key (section 1.3): an
aggregate declared in a row has one state per row. Whether that is one
document per key, or one document per operation with the state of each key
at a path of its own, changes no label. `execution-and-storage.md` chooses
one state document per key (its §6). The cause is the same in both: the
element key is a part of the identifier in the first layout and a path
segment in the second. Two things hold in either, and they hold for
everything else an element cone stores once per key.

- **Each key's state has its own entries.** The state of one key is labeled
  by the table above, instantiated for that element, and in a document
  that holds several keys the entries are at that key's paths. The key set
  of such a document says which elements the collection has, so it carries
  the collection's instantiated membership label. A key derived from a
  value is the salted one in every layout (section 1.3). Two documents
  hold several element keys: the cache document, with one entry per
  element key of a promoted element cone, and the instances document,
  with one record per element key of an element cone that makes
  instances, and one per element key under which an element body has
  children (`execution-and-storage.md` §8.4, §2.8 and §2.5). In each,
  the set of keys under one cone carries that membership label. Under a
  nested element body the keys of the inner collection carry the inner
  collection's membership label, instantiated for the outer element.
- **Positions that hold one key share what is stored once.** Positions
  hold one key where they hold equal plain values and the position is not
  part of the key, or where they link to one cell (section 1.3). Their
  slots are bound per position and can resolve to different labels. A
  kept output is stored per position, under that position's
  label. Everything else an element cone stores is stored once per key
  (`execution-and-storage.md` §2.5): the state of an operation, the
  stored request and the result of an effect, a path of the argument of a
  child or of an instance the cone makes, a side-write, a copied path of
  a binding or of an inline pattern's parameters, an entry of the cache
  document, and the record in the instances document. Each is labeled
  with the join over the positions that hold the key, and the join covers
  each: the value stored is the one each of those positions computes, and
  the join is at least the label each position gives it. For bookkeeping, a
  cache entry and the record of the instances made, the width costs
  nothing, because no template has a slot for them. For what a slot
  reads, the join reaches further: an output that reads the result of an
  effect or of a materializer, a cell a cone side-wrote, or the result of
  a child, and a handler that reads the copied state of its binding,
  carry the labels of the other positions that hold an equal element.
  Today each occurrence of an element has an element run of its own
  (`listElementKeys` in `runtime/runner/src/builtins/list-element-keys.ts`
  adds an occurrence count to the key), so this is looser than today
  where two positions hold an equal element under different labels. It is
  the third exception of section 3.1, accepted by ruling and **to be
  revisited**.

  A stream of a binding of the reactive tier in an element body is per
  key as well (section 1.3), and an event on it names no position. When
  an event arrives, each element slot of the handler's state resolves to
  the join over the positions that hold the key. *Assumed* to fall under
  the same ruling, which lists what is stored and not this slot (section
  8, question 35).

**A stored link that becomes a value.** When an instance stored by the
current runtime is first written in the compiled layout, a result path that
held a link to a node's document comes to hold the value
(`execution-and-storage.md`, section 9). The write is an overwrite of an
existing path. Its `value` entry is replaced by the instantiated template,
as on any overwrite. Its frozen `shape` entry is kept (§8.12.8,
`08-12-store-label-monotonicity.md`) and is joined with the confidentiality
of the `followRef` entries the link had: that the path exists was decided
by the write of that link, and a reader of the value consumes the `shape`
entry where it used to consume the pointer's. The stored label of the path
is then never looser after the migration than before it.

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
**There are three exceptions**, all deliberate.

- **The collection index** (section 3.17). A bucket's membership label
  includes the key of every element, where the runtime today stores only
  the labels of the elements in the bucket. Exclusion from a bucket is an
  observation, so the wider label is the correct one.
- **A static read through a handle, on a run that throws before it**
  (section 3.9). A read through a handle is a slot when every run of the
  body that returns normally makes it. A run that throws before reaching
  the read did not make it, and today its transaction does not carry the
  read's label. The template does: the error state of the failed body, or
  the outcome of the failed handler, is labeled with the whole footprint
  (section 5.2), that slot included.
- **What an element body stores once per element key** (section 2.6).
  Positions that hold equal plain values, or links to one cell, share one
  key, and their element slots can resolve to different labels. What is
  stored once for the key carries the join over those positions: the
  request and the result of an effect, the state of an operation, the
  argument of a child, a side-write, and the copied state of a binding.
  Today each occurrence of an element has a run of its own, whose writes
  carry that occurrence's label alone. An output at one position that
  reads what is stored once therefore carries the labels of the other
  positions that hold an equal element. This exception is accepted by
  ruling and is **to be revisited**: the alternative keys these as
  per-element state is keyed, by a cell's identity or with the position.

The stage 3 comparison expects these three differences and no other in
that direction (section 7.5).

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
list (section 1.1, `Cone.slots`), which lists what the value function may
receive over all selections. A slot that only the unselected branch reads
is not read, and so makes no cone instance stale
(`execution-and-storage.md` §2.2). The value and the instantiated label of
the result are functions of the condition and the selected branch alone.

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
- **A child.** A body that instantiates a child puts the position in the
  key of a plain element (section 1.3). That adds nothing to the element
  template: the body is not given the position and computes nothing from
  it.
- **Nothing else.** The label of element `i` does not include any slot of
  element `j`.

For a collection the instance computed (`Collection.source` of kind
`output`), a position has no stored address until the collection is kept.
The element's root slots then take the producing template: `shape` its
membership template, and `identity` the template of the reference at the
position. A slot below the root crosses that reference like any link
(section 2.5), with the producing template as the pointer's label.

Element cones are keyed as section 1.3 defines, and the element slots are
bound per position. The runtime, not the value code, iterates: it evaluates
the body's cones once per key with that element's slots, and assembles the
result. Section 1.4 says which entry of `Plan.outputs` stands for the
assembled result. Which input element an output position came from is therefore
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
evaluates the per-element cones (the predicate, or the body) and then performs
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
- A tie in `minBy` or `maxBy` goes to the element at the first position, in
  the source order of the collection, among the elements whose key
  function returns the winning key. The result therefore depends on the
  order of the collection where keys tie. The choice is labeled with the
  collection's membership, which includes order (section 3.18), so the
  label covers it. No element key enters the choice.
- An element with an equal key counts once per position it occupies.
- A hole contributes nothing.

**Durable state.** An aggregate is an `Operation` of kind `aggregate`. Its
state holds one contribution per element key with the number of positions
that hold it, the folded value, and the multiset of label identifiers the
fold joins (section 4.3). A change to one element costs one update. A
reorder costs nothing for `count`, `sum`, `min` and `max`. For `minBy` and
`maxBy` it changes the result only where it changes which of the elements
with the winning key comes first, so the state also has to give the first
position among those. The shape of that state is private to the runtime;
only the semantics above are part of the design. Section 2.6 gives the
label of the state beside the result.

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

A sandboxed body produces, for every path of its result and every path it
writes:

```text
derive(by: body) over
  slot r             for each r in Body.reads
  c.template         for each c in Body.computed
  dynamic h          for each h in Body.handles
  dynamic link       for each journaled resolution of the body
  dynamic space      for each journaled access-list read of the body
  dynamic metadata   where the body has journaled label-metadata observations
```

The last three are the journaled context reads of section 3.16 ("Static
and journaled"), and each is an entry of `Plan.dynamicReads`.

**The argument.** The runtime builds the body's argument from `Body.reads`
and `Body.computed` and from nothing else. A slot that is not listed is not
materialized, so the body cannot observe it.

**Computed inputs.** A body can receive a value the instance computed, the
result of another body or of expression code: as an argument of a call in
the reactive tier, or as a capture of a body written there. Such a value
has a template and no slot. `Body.computed` lists what
the body observes of it, one entry per path and class, each with the
template of the producing expression at that path. The cone's value
function passes the value, and the runtime copies into the argument the
paths the entries name, each narrowed to its class, as it
narrows a slot. The body's label joins the templates of the entries, and
not the template of the whole value.

A computed value passed whole would be looser than today. A body that
reads one member of an object the pattern body constructs reads that
member's document today and no other member's, so its label must not join
the other members' templates.

**Handles.** The runtime hands a body a cell handle for every position of
a handle type that its record names: an `identity` slot of `reads`, an
`identity` entry of `computed`, the handle of a write target or of a write
envelope, and every entry of `handles`. A handle the body finds through one
of those reaches it by the read that finds it. What the body can do with a
handle is bounded by the record:

- A read through the handle at a path that slots of `reads` cover returns
  the value the runtime materialized for those slots. `footprint-analysis.md`
  §7.2 says when a read through a handle is such a slot: the handle is one
  the body was given at a static place, the path below it is static, and
  every run that returns normally makes the read. The slot's path crosses
  the handle's link (section 2.5).
- A handle listed in `handles` reads through the transaction. Every read
  made through it is journaled, and it returns the value narrowed to the
  entry's `envelope`, so the journal holds the reads the envelope admits
  and no others. A read through it of a path that a slot also covers
  consumes that label a second time, which a join absorbs.
- A handle that is in neither group cannot be read through. It can be
  passed on, compared, and written through where a write target names it.
- A handle the body finds by a read through a listed handle has no entry
  of its own, because no slot names the place where it is. The body may
  read through it where the envelope of the listed entry admits the
  position as a handle. Finding it is a journaled read of the reference at
  that position. Reads through it are journaled with the reads of the entry
  it was found through, narrowed to what that entry's envelope admits
  below the position, and they join the same `dynamic` node. The same
  holds for a handle found through a found handle.
- A handle that `key` flattened is found in this sense where its use is
  not static. For `h` of type `Cell<{ a: Cell<T> }>`, a read through
  `h.key("a")` that is conditional, or through `h.key(k)` with a key the
  body computes, has no `get()` on `h`, and the runtime crosses the link
  at `a` when the flattened handle is used. That crossing is a journaled
  read of the reference at `a`, through the entry of `h` in `handles`,
  whose envelope admits the position `a` as a handle. The reads through
  the flattened handle are journaled under the same entry. Where the use
  is static, the hops are slots: `identity` at `h` and at `h->a`, and the
  slots of the read below them (section 2.5).
- A link to an instance that a `lift` or a `computed` made is a handle of
  this kind when the body reads through it. The instance outlives the
  evaluation that made it, so a later evaluation finds the child's result
  behind the link. That result is no input of the body. The entry of
  `handles` names the `instantiate` site, its envelope admits what the
  body reads of the results of the instances the site makes, and the reads
  are journaled and join the entry's `dynamic` node.
- The same holds for everything a site makes that a later invocation
  finds again: a cell created under an explicit cause, in a computation
  as in a handler, and an instance a handler requests with `.for(tag)`
  (section 1.3). A read through the handle or the link the site returns
  is dynamic, and it is an entry of `handles` that names the site
  (`HandleReads.handle` of kind `call`). A cell or an instance that is
  new on every invocation holds nothing but what the invocation itself
  wrote, and reading that back records nothing. Where a cell created
  under a constant cause is a `StateCell` (section 3.14), a read through
  its handle that is static is a slot with root `state`.
- A write through a handle is refused unless a `WriteEdge` or a
  `WriteEnvelope` of the body covers it (section 3.11).

`handles` exist so that a template is never looser than today. A body that
reads through a cell at a path it computes (`places.key(k).get()`), or on
some runs only, is journaled today read by read. A static footprint would
have to name the whole cell, or name a read that some runs do not make.
The plan keeps such reads dynamic: the runtime brackets the call, journals
the reads made through the handle, and joins what they consumed. The
envelope narrows what such a read can return, which today is whatever the
handle's declared schema reads.

**A run that throws.** A slot for a read through a handle is in the body's
template on every run. A run that throws before the read did not make it
today, and its error state or failed outcome carries the slot's label all
the same (section 5.2). This is the second of the three exceptions of
section 3.1.

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
  its own label at the target. For a slot with `resolved` the reference is
  the resolved one, which is what `resolveAsCell()` returns for the handle
  at that slot.
- **A reference chosen among inputs.** When the reference at a result path is
  always one of several input references, its template is the `slot` of the
  one actually returned, joined with the body's `derive` template as the
  label of the *choice*. A reference taken from a position under a `*`,
  such as an element the body picked out of a list by a predicate or by
  an index, is chosen in this sense: the entry stands for every reference
  those positions hold, and which one the body put at the path depends on
  what it read. The record names the entry in `oneOf`, and never in
  `passes`. The label of the one returned is that of its own binding
  (section 2.5). The chosen reference's own label and its target's
  label are untouched; what the body's inputs taint is which one sits at the
  path. §8.5.6.1 draws the same line for a selected collection: target content
  stays at its label while "Selected reference identity" is tainted by the
  selector.
- **A required path.** When the result schema requires a path, the path's
  `shape` template is `const`: it exists whatever the inputs were. Only its
  `value` carries the `derive` template. A body that fails to produce a
  required path is a failed body (section 5), and its error state occupies
  the path, so existence stays constant.

**A reference from a computed input.** A handle or a container that
reached the body in a value the instance computed has no slot. `passes`,
or a member of `oneOf`, then names its `identity` entry of `Body.computed`
(`GivenReference`), and the entry's template takes the place of the `slot`
in the first two rules. A reference passed through has that template and
nothing else: the label of which reference the producing expression put at
the position, with the integrity that template instantiates to, and
nothing from the body. A reference chosen among inputs has the template of
the one returned, joined with the body's `derive` template as the label of
the choice. The reference the runtime compares with is the one it placed
at the entry's position in the argument.

The first two are verified by the runtime, not trusted: it compares the
returned reference with the references it passed in, by identity, as
`exactCopyOf` is verified (§8.4, `08-04-exact-copy-verification.md`). A
returned reference that is none of the declared ones falls back to the
`derive` template. The third is enforced by validating the result against its
schema. The same two reference forms apply to a path of a value the body
writes, where the `WriteEdge` at that path records them (`reference`), and
to a path of a child's argument.

**A factory value passed on.** A position of factory type is treated as a
position of reference type is. A body that passes a factory value on
unchanged, or compares it, observes it for `identity`, and a factory
value at a result path, a written path or a bound path is recorded with
`passes` or `oneOf` like any reference the body was given
(`GivenReference`; `footprint-analysis.md` §2.2 and §8.5). Its label is
the label of the `identity` slot or entry it came from, which for a
pattern closure holds the labels of its captures (section 3.15).

**A reference found through a dynamic read.** A reference is one the body
was given only where the body's record has an `identity` entry for the
place it came from. A handle's path below a hop is such a place only
where every hop on it is a static read
(`footprint-analysis.md` §7.2). A reference the body found by a dynamic
read through a handle has no entry, and so nothing for `passes` or
`oneOf` to name.

- At a result path, at a written path, and at a path of a child's
  argument or of a request, such a reference has no `reference` member,
  and the path takes the body's `derive` template. That template holds
  the `dynamic` node of the handle the reference was found through, so it
  covers which reference was found.
- A write through such a handle is listed by a `WriteEnvelope` and not by
  a `WriteEdge` (section 3.11).
- A container found that way and bound in a binding, or captured by an
  inline pattern instantiated in the body, has `capture: "link"`, no
  `reference`, and the body's template, as a value the body created has
  (section 3.14).

**Today.** A `lift` or `computed` node reads what its argument schema
materializes plus what it reads through cells, and the whole join lands on
every written path. The static part of the footprint is the narrowed
argument schema. **Equal or tighter**: equal when the body reads everything
its schema materializes today, tighter when footprint analysis narrows the
schema further than the transformer does. The narrowing does not rest on the
compiler's analysis being right (section 7): a footprint that is too small
starves the body instead of leaking to it. One argument is not narrowed
today, a handler's event of an authored type; section 3.12 compares it. A
read through a handle is **equal** where it stays dynamic, **tighter**
where the envelope admits less than the handle's declared schema, and
**looser** in the one case above: a slot for such a read, on a run that
throws before it.

### 3.10 Link following

A read that follows a link takes one of two forms.

**Where the plan names the path**, the read is a slot whose path crosses
the link (section 2.5): an argument path stored as a link, a path below a
handle the instance was given, a data-typed position stored as a link. The
slot's label joins the link's pointer label with the observation at the
target. Nothing is journaled for the label, and no trigger read is needed:
the link's address is on the slot's chain, and the target is where the
slot is bound.

**Where the plan cannot name the path**, following the link at slot `l`
produces:

```text
derive over
  slot (l, identity)
  dynamic (link, through: l)
```

That is the case for a reference the instance computed and for the further
links `resolveAsCell()` follows where the resolution happens on some runs
only. For a reference that reached a body in a value the instance
computed, its `identity` entry of `Body.computed` takes the place of the
slot, in the template and in `through`. The target's address is data, so
no template names it. This is where trigger reads remain: when the target
changes, the cone is made stale through the address, and the recomputation
joins that address's current label, as §8.9.2 requires of a
dependency-scheduled rerun. Reads at the target are classified by the same
classes.

**Trigger reads across a restart.** The trigger reads of a `dynamic` node
are held in memory by the process that recorded the changes
(`scheduler-and-serving-loop.md` §3.4), and a process that starts later
holds none. After a restart a cone instance is evaluated because storage
is ahead of what its last stored evaluation read, and its `dynamic` nodes
join the labels of what that evaluation reads. The rule above is met by
that, with one exception.

- **Why it is met.** The address of every read of an evaluation is a
  function of the plan and of the values read before it. An evaluation
  therefore makes again each read of the evaluation before it, up to and
  including the first one whose value changed, and it joins the current
  label of that address. A change at an address that the evaluation no
  longer reads lies behind a changed read. Where the change of that
  earlier read makes the cone instance stale, the cone instance would be
  evaluated all the same without the later change, and would compute the
  same. The label then covers everything that the value, and the fact
  that it was computed again, depend on, and a `dynamic` node needs no
  further input after a restart. The same holds for an instance that is
  loaded again and for a materializer.
- **The exception: a body that makes a sampled read.** A change at the
  address of a sampled read does not make a cone instance stale (section
  2.5), and the value read can decide which reads follow. An evaluation
  can then be caused by a change at an address that it does not read
  again, because a sampled value changed in between. A process that
  recorded the change joins the label of that address as a trigger read.
  After a restart it is not joined, and the fact that the output was
  written again says that the address changed. This is the channel §8.9.2
  documents as "roughly one bit per change event", open across a restart
  for a body with a sampled read.
- **Today.** The current scheduler holds the addresses that invalidated a
  node in memory, with the node's record (`takeInvalidCauses` in
  `runtime/runner/src/scheduler/invalidation.ts`), and hands them to the
  transaction of the next run (`runSchedulerAction` in
  `runtime/runner/src/scheduler/run.ts`). A node that a new process runs
  carries none. **Equal.**

*Assumed:* the residual is accepted and listed (section 5.5), which is
what §8.9.2 requires of a profile that skips trigger joining. Closing it
needs the trigger reads of a cone instance whose last evaluation made a
sampled read to be stored, with the rows the scheduler keeps for it
(section 8, question 29).

Both forms follow §8.2.4 (`08-02-pass-through-via-references.md`): a
dereference consumes "Every applicable reference restriction along the
traversed path, plus the current labels of the target observations actually
made."

A link that is passed on without being followed is a `slot` template of class
`identity`, with the pass-through integrity rule.

**Today.** The probe of the followed slot is a `followRef` observation and
the target's content arrives through ordinary reads journaled at the target
(`forEachFlowObservation`;
[CFC observation classes](../cfc-observation-classes.md) §6). **Equal** for
both forms. The `dynamic` form is the same journal mechanism. The slot form
joins the same entries, the pointer's and the target's, and takes its
integrity from the target alone, as today's hereditary meet does
(§6.1 there).

### 3.11 Static side-writes

A cone that writes through a cell it was passed has a `WriteEdge` for each
statically known target. The label of the written value is the edge's
template, which is the template of the written expression: the body's
template when a sandboxed body performs the write.

**Targets.** A static target is a state cell of the instance (`state`), a cell
created under a constant cause, which is a `StateCell` too and whose edge has
the target `state` (section 3.14), an anchors document, or a cell reached
through a handle (`handle`): a handle the instance or the body was given at a
static place, in the argument, an element, the event, or the state a handler was
bound to, with a static path below it. Where the handle's own path has a hop
through another handle, every hop on it is a static read
(`footprint-analysis.md` §7.2); otherwise the handle is one found by a dynamic
read, and the write is listed by an envelope (below). A `handle` target names
the handle's `identity` slot, and so a root and a path, which makes it
comparable with the slots that read the cell: a slot with the same root whose
path overlaps the written path, in either prefix direction, reads what the edge
writes. A handle that reached the body in a value the instance computed is named
by its entry of `Body.computed` (below).

**A write through a handle that `key` flattened.** For `h` of type
`Cell<{ a: Cell<T> }>`, a write through `h.key("a")` lands in the cell
the inner handle links to, and does not replace the link stored at `a`.
The hop through `h` is made by the `key` chain and the write, with no
`get()`. It is a static hop where `h` is a handle the body was given at a
static place, the keys are static, and the write is unconditional
(`footprint-analysis.md` §6.2). The `handle` target then names the
`identity` slot at `h->a`, or that `identity` entry of `Body.computed`
where `h` reached the body in a value the instance computed, and its
`path` is below the inner cell. The slot is an entry of the body's
footprint, so the edge's template joins the pointer label of the link of
`h` and the label of the reference at `a`: which cell is written depends
on both. Where one of the three conditions fails, the write is listed by
a `handle` envelope whose slot is at the position `h->a`, as for a handle
found by a read through another handle (below), and the link at `a` is a
journaled read through the entry of `h` in `Body.handles`, whose envelope
admits `a` as a handle (section 3.9). The write-side checks are those of
the cell where the write lands.

**A write through a resolved reference.** A write through a handle `h`
lands in the cell `h` links to. A link stored there as the value is not
followed: the write replaces it. A write through `h.resolveAsCell()` lands
in the cell where the resolution ends. The two differ when the cell `h`
links to holds a link. A `handle` target with `resolved` is the second
form. Its `slot` is the `identity` slot the body has at the handle's
position: the resolved one where the resolution is static, and the plain
one where the body journals it (section 3.16, "Static and journaled").

- **Where it lands.** The runtime resolves the reference when the write is
  made, and the write lands at the address where the resolution ends. That
  is the address a slot through the handle is bound to, since every class
  but `identity` resolves through the links (section 2.5). So a slot with
  the same root and an overlapping path reads what a resolved edge writes.
  Where the cell `h` links to holds a link, a target without `resolved`
  writes at an address on the chain of those slots, and the write can
  change where they are bound.
- **The label.** Which cell is written depends on the reference at the
  handle and on every link the resolution follows. The edge's template
  holds both: the body that calls `resolveAsCell()` has the resolved
  `identity` slot in its footprint, or the plain slot and the `dynamic`
  node of kind `link` through it. The written value therefore carries the
  pointer labels of the links followed.
- **The checks.** The write-side checks are those of the cell where the
  write lands: its declared confidentiality for writer-fit, its floor, and
  its writer policy.

Today `resolveAsCell()` follows the links by reads the transaction
journals, and the write goes to the cell it returns (`resolveWriteTarget`
in `runtime/runner/src/cell.ts` states the difference between the two
targets). **Equal.**

**A write through a handle to a value the instance computes.** In the
reactive tier an argument that is a value may stand where the callee
declares a handle that can write (`language-subset.md` §7.5.2), and the
value can be one the instance computes: the result of a `computed` or of
an operator, an assembled collection, a literal. Where the write lands
depends on what the callee is.

- **A child.** The enclosing plan writes a computed argument path into
  the child's argument document (section 3.15), so the child's handle
  names that path of its own argument document, and the write lands
  there. Section 3.15 ("A handle to a path of the argument") has the
  rule, and no rule is added for it.
- **A handler bound in the reactive tier, a `lift` result, and a pattern
  compiled into the enclosing instance.** The path resolves to an
  `Output` of the instance (`Binding.state`). The records do not
  determine the write. A `handle` target names a cell that a handle
  links to, an output is not a cell, and an interim output is stored
  nowhere. *Assumed* (section 8, question 42): the runtime refuses the
  write, as it refuses a write that neither an edge nor an envelope of
  the body covers (below). In a handler the refusal rejects the event's
  transaction, and a cone whose write is refused fails, with the error
  state of section 5.2. No label rule is needed, because nothing is
  written. The refusal is decided by
  what the path resolves to and reads no data.

Today no refusal of this kind was found. A value a node computes is
stored in a document of its own, a handle to it writes like any handle,
and the node's next run writes its result over what was written. The one
refusal by the kind of address is of a write to a `data:` or `snapshot:`
address (`IReadOnlyAddressError` in
`runtime/runner/src/storage/interface.ts`). The assumed rule is therefore
narrower than today in what a program may do, and it changes no label.

**A handle from a computed input.** A body can write through a handle that
reached it in a value the instance computed, such as a handle another body
returned or one a `pick` chose. Such a handle has no slot. A `handle`
target, and a `handle` envelope, then names the handle's `identity` entry
of the body's `computed`.

- **Where it lands.** In the cell that the reference at the entry's
  position links to, at the target's `path`, and with `resolved` at the
  address where the resolution of that reference ends. The runtime knows
  the cell once the cone that produces the value has been evaluated, which
  is before the body runs.
- **The label.** The edge's template. A body's template joins the template
  of every entry of `Body.computed` (section 3.9), so the written value
  carries the label of which reference the instance computed, and which
  cell is written depends on nothing else. A resolution of such a
  reference is journaled, so with `resolved` the links it follows are a
  `dynamic` node of kind `link` through the entry (`DynamicReads`), which
  the body's template joins as well.
- **The checks** are those of the cell where the write lands, as for any
  `handle` target.
- **No edge to a reader.** The target has no root and no path, so the plan
  cannot compare it with a slot, and no `ConeEdge` of kind `handle` names
  it. Which cones read the cell is found at run time, from the address the
  reference leads to and the addresses the slots are bound to, as it is
  for two places of a plan that link to one cell. The compile-time report
  of cycles does not see such a write. A cycle through it ends at the
  bound of section 5.2.
- **The tier of a computation.** Whether a `lift` or a `computed` is a
  materializer is decided on the body alone (`footprint-analysis.md`
  §6.3), and one body can be used with a handle that is a slot in one
  place and a computed value in another. A write edge that names its
  handle by `computed` is therefore a static side-write, as one that names
  a slot is, and does not make the body a materializer.

For a write a cone performs, the plan lists a `ConeEdge` from the writing
cone to each cone that has such a slot, with `via` of kind `state` or
`handle`. The order of evaluation and the compile-time report of cycles
are computed from `Plan.edges`, so they see a write through an argument
handle as they see a write to a state cell. Two places of a plan can link
to one cell without the plan showing it. That overlap is found at run
time, from the addresses the slots and targets are bound to.

A handler is not a cone, so its write edges are not in `Plan.edges`. They
say what the body may write, and through the bound addresses which cones
its writes make stale. Where the handler is bound in the reactive tier,
`Binding.state` gives the slot of the instance that each handle of the
handler's state is.

The checks a write is subject to (section 4.4) are evaluated on the edge's
template: the write floor on `I(template)`, writer-fit on `C(template)`, and
the writer policy on the writing body's identity.

**Writes with no static target.** A write whose target depends on data the
body read, or whose narrowest static path is a proper prefix of what is
written, has no `WriteEdge`. The body lists a `WriteEnvelope` for it in
`Body.envelopes`, and the runtime refuses a write that neither an edge nor
an envelope of the body covers.

- In a **handler**, the write is made in the event's transaction and
  carries the body's template. The write-side checks of the target's own
  schema are evaluated when the write is made.
- In a **`lift` or a `computed`**, the body is a materializer: an
  `Operation` of kind `materializer` implemented by the body, for all of
  its writes. It keeps a transaction per run and today's label rule: every
  path it writes carries the join over everything the run read, trigger
  reads included. A computed input of a materializer joins that label with
  its instantiated template.

The declared write envelope of a materializer is the `writes` and the
`envelopes` of its body.

- A `handle` envelope names a cell, or the cells the elements of a list
  link to, and a path prefix. Once the handle's slot is bound it names
  addresses, so a reader can be found inside it before the body runs. For
  a handle the body finds by a read through another handle (section 3.9),
  the envelope's slot is at the position where the handle is found: its
  path crosses the first handle's link and has `*` at each segment the
  analysis cannot name. That slot is in no `reads`. Nothing is
  materialized for it and it joins no template. It names the positions
  the written cells are linked from.

  Where the first handle reached the body in a value the instance
  computed, no slot path leads to that position. The envelope then names
  the first handle's `identity` entry of `Body.computed`, and its `found`
  member holds the position: a path below the cell that handle links to,
  resolved as the path of an `identity` slot is, with `*` at each segment
  the analysis cannot name. The envelope's `path` is below the cell the
  found handle links to. `found` is no entry of the footprint: nothing is
  materialized for it and it joins no template. The envelope names
  addresses once the cone that produces the computed value has been
  evaluated, which is before the body runs. No label rule is added. The
  read that finds the handle is a journaled read through the first handle
  (section 3.9), so the label of which cell is written is in the `dynamic`
  node of that handle's entry of `Body.handles`, which the label of every
  write of the body joins.
- A `created` envelope names a creation site and no address: the cells the
  site creates are named by causes the body computes from data. It bounds
  what the body may write, since the runtime refuses a write to a created
  cell of a site the body does not list. It gives nothing to order by. A
  reader of such a cell reads what is stored, and the materializer's write
  then makes that reader stale. Whether anything waits for a materializer
  is decided in `scheduler-and-serving-loop.md`.

**What a materializer returns.** The value a materializer body returns is
the result of its `Operation`. The materializer's transaction stores it at
the result path of the operation's state document, under that
transaction's join. A cone that uses the value reads it through a slot
with root `operation`, and its template for the value is that `slot`.

**A failed cone.** Section 5.2 says what the targets of a failed cone's
write edges take.

**Today.** A side-write is one more written path of the node's transaction
and carries the transaction's join. **Equal or tighter**, as for the cone's
primary output. A materializer's result is the output document of its node
today, written by the same transaction as its other writes. **Equal.**

### 3.12 Event handlers

A handler is a sandboxed body with an `event` root. Its state is the slots with
root `binding`, which resolve through the binding it was invoked for (section
3.14). Its template is the `derive` of section 3.9 over its event slots, its
state slots, its handles, and its journaled context reads. Every path it writes
has that template, apart from the references of section 3.9. The schema's
declared integrity for the written path, such as an authorship atom for the
acting principal, is a declared entry and is added as it is today.

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

**Instantiating a pattern** (`instantiate`, legal in every function body).
The call records a request and returns a link. The callee is a pattern the
compiler can see, an inline `pattern(...)` written at the call, or a
pattern factory value. The runtime creates the child instance (section
3.15) when the transaction commits.

| Part | Label |
| --- | --- |
| The link returned | Its identity carries `T_b`: that this instance exists, and which one it is, depends on what the body read |
| The argument | Each path is written into the child's argument document with `T_b`, or with the reference rules of section 3.9 for a reference the body was given |
| The captures of an inline `pattern(...)` written at the call | The private parameters of the child (section 3.15). Each path is bound as a path of a handler's state is bound in a function body (below), and is stored with the instance |
| A link to an instance requested earlier in the same invocation, passed as an argument | A reference like any other: it carries its own identity label, `T_b`. It is legal before either instance exists, because both are created by the same commit |
| `.for(tag)` | The tag's value is part of the footprint. The instance's existence label is frozen when it is first created (§8.12.8, `08-12-store-label-monotonicity.md`); a later event that names the same instance creates nothing. *Assumed:* it does not write the argument again either, so the instance keeps the argument the creating event wrote, as a cell created under an explicit cause keeps its initial value (section 8, question 39) |
| `asScope(scope)` | A constant of the site. It sets the scope of the state the child declares |
| `inSpace(space, options)` | The target is a space identifier, the space of a given cell, a name, or anonymous. `Child.space` records which of the four it is, and the options `grants`, `root`, `spaceKind` and `selfOwned` where the site writes them. The target and each option is a constant of the site, a slot, or a value the body computes at the request (`RequestValue`). A computed one carries `T_b`. The argument is written into another space, so the write-side checks of that space apply to the argument's templates joined with `T_b`. The instance's identifier is known at the request, as for any instantiation. The identifier of a space the request creates is obtained when the request is made, and is not derived from the request (below) |

An instance that a `handler` or an `action` requests becomes an
instantiated pattern, with a result cell, when its link is written into
state or passed to `navigateTo`. A link the body drops creates nothing:
the request stages no result document and no argument document, and no
constraint on its argument is evaluated, so none can fail (section 4.4).
An instance that a `lift` or a `computed` makes exists whether or not the
body keeps the link (below).

**The values of an `inSpace` request.** `Child.space` records the target
and each option as a `RequestValue`, and the cell of a target of kind
`spaceOf` as a `GivenReference`.

- **A value is consumed.** The runtime reads the target's identifier or
  name and each option to act on it: `grants`, for one, becomes the
  access list of the space. So a value of the request is observed as
  `value`, over its subtree where it is a container, and not by the
  reference rule that keeps a container passed on whole as a link.
- **One projection of an input bound to a slot root** is recorded as that
  slot, of class `value`.
- **One projection of an input bound to a value the instance computed**
  has no slot. It is recorded as `body`, like a value the body computes,
  and carries `T_b`, which joins the template of the projection's entry
  of `Body.computed` (section 3.9). The record has no form that names the
  entry alone. `T_b` is wider than the entry's template, and it is the
  label the request carries today, the join of the body's transaction.
- **The cell of a `spaceOf` target.** Which space is the target is what
  `spaceOf` of the cell observes (section 3.16): the reference at the
  cell's position and every link below it that resolution follows. `cell`
  names the `identity` slot the body has at that position: the resolved
  one where the resolution is static, and the plain one where the body
  journals it, with a `dynamic` node of kind `link` through the slot for
  the links followed. For a cell that reached the body in a value the
  instance computed, `cell` names its `identity` entry of
  `Body.computed`. The resolution is then always journaled, and the
  `dynamic` node names the entry (`ComputedReference`). The slot or the
  entry, and the node, are in `T_b`, which the allocation record, the
  link returned and the computed paths of the argument carry.

**A space an `inSpace` request creates.** Creating a space returns a new
identifier ([random space identities](../random-space-identities.md)), so
the identifier of a space the request creates is obtained and is not
derived from the request. The runtime obtains it when the request is
made, and the request returns it. The runtime records the allocation in
the calling space: the obtained identifier, under the name the request
gives, or for an anonymous space under the request's own identifier. The
request's own identifier is the one section 1.3 gives the occurrence of
the site. It is the identifier of the instance requested, with one
exception: with `root: true` the instance takes the root the target space
reserves, which derives from the identifier of that space
(`inSpaceRootCause` in `runtime/runner/src/in-space-root-cause.ts`) and
so cannot name the record that yields that identifier. The record is one
of the writes the body stages, and it carries `T_b`: that a space exists
under a name depends on what the body read.

**The allocation record commits ahead of its unit.** The record is a
write of the unit that makes the request (section 4.6): the unit of a
handler's own writes, or, for a request a computation makes, the unit of
the record of the instances its cone made. It is the one write that does
not commit with its unit. It commits in step 2 below, ahead of the home
writes, and it stays when the unit does not commit: when a conflict at
the home commit withdraws the unit, or withdraws a unit that the unit
uses. That is an exception to the property of section 4.6, and it is
bounded as follows.

- **What stays.** The record holds an identifier that was obtained and a
  name or a request identifier. A record that stays makes a retry name
  the same space, which is what the ruling asks of it. Where no retry
  follows, a space exists that no instance uses.
- **Its label is instantiated from stored labels only.** A slot of `T_b`
  can be bound to an address at which this transaction, or an earlier
  transaction of the batch, staged a label (section 4.5). For the
  record, such a slot does not resolve to the staged label as a label of
  its own. It resolves to what that label was instantiated from, followed
  through every staged label in turn down to labels that are stored, to
  the labels of the events of the batch, and to the labels of journaled
  reads. The record's label is therefore a join of labels that exist
  whether or not any staged write commits, and it covers what the record
  was computed from. *Assumed* (section 8, question 32).
- **Its checks.** The record is stored in a store the runtime owns
  (section 2.6; `execution-and-storage.md` §5.6 says in which document
  and under which identifier), so no declared label and no writer policy
  applies to it, and no constraint can fail on it. It is recorded only
  where every constraint of the transaction was checked before the first
  step (below).

When the transaction commits, its steps are applied in this order
(`execution-and-storage.md` §5.6; `scheduler-and-serving-loop.md` §9.4):

1. the genesis commit of each space a request creates, which makes the
   acting principal its owner;
2. the allocation record of each such space, in a commit of the calling
   space that holds the allocation records and nothing else;
3. the staged changes to access lists;
4. the batch of writes for each other space, which holds the documents of
   the instances requested there;
5. the home writes.

The ruling has the allocation recorded in a step that commits before the
step in the foreign space. Those documents read that step as step 4, the
one that writes the instance's documents, and this document follows them:
the record is step 2, so a retry after a failure in a later step finds
the record and names the same space. Every constraint is checked before
the first step, so a transaction that is rejected or aborted applies none
of them.

**In a body that is re-evaluated.** A `lift` or a `computed` may
instantiate a pattern, and that pattern may request effects. The rows
above apply, with the following differences.

- **Identity.** The instance is identified by the enclosing instance, the
  body's `name` and `within`, the site, and the ordinal of the
  instantiation among those the evaluation makes at that site. With
  `.for(cause)`, the cause takes the place of the ordinal (section 1.3).
  An evaluation that instantiates the same pattern at the same place
  therefore names the same instance. A site in a loop names its instances
  by their order in the loop, so when the items change order, an instance
  and the state it holds go to the item that takes its position. A cause
  taken from the item keeps the instance with the item. The compiler
  therefore warns, and does not refuse, where an instantiation sits in a
  loop or a callback of a function body and has no `.for(cause)`
  (`function-body:instantiation-without-cause`; `language-subset.md`
  §10.3 has the catalog entry). *Assumed,* with that document (its §13,
  question 26): the warning is reported in a `lift`, a `computed`, an
  `assert`, and an authored function that one of them or the reactive
  tier calls. It is not reported in a `handler`, an `action`, or an
  inline event handler, where each event makes its instances anew.
- **When the instance exists.** The condition on the link does not apply.
  The first evaluation that makes an instance stages its result document
  and its argument, whatever the body does with the link, and the instance
  exists once that transaction commits (`execution-and-storage.md` §2.8;
  `scheduler-and-serving-loop.md` §2.7). The condition serves a handler,
  whose invocation is the one occasion to create the instance and leaves
  no record of it but the link. A computation keeps a record of the
  instances it made and tears them down (below), so an instance whose link
  the body drops is still accounted for, and a later evaluation can read
  through the link of an instance that no document links to. Existing
  costs no evaluation: the instance's cones are evaluated when something
  demanded reads its result. That the instance exists carries `T_b`, as
  the identity of the link does.
- **The argument.** Each evaluation writes the argument of every instance
  it makes, through the write edges with target `argument`, as an
  instantiation from a handler does. Each path carries `T_b`, or follows
  the reference rules of section 3.9. An evaluation that names an instance
  that exists updates its argument and creates nothing.
- **The edges are the cone's.** The write edges belong to the cone that
  runs the body. They are derived writes, so a failed constraint on one
  drops that write alone (section 4.4). They do not make the body a
  materializer: the cone is the one writer of the argument among the
  cones of the enclosing instance, and the child reads
  the argument through its own `argument` slots, in the pull that extends
  through its result (section 3.15). The child can write a path of its own
  argument through a handle it declares there, and the next evaluation of
  the cone replaces what it wrote (section 3.15, "A handle to a path of
  the argument").
- **Teardown.** The instances a computation makes belong to it: to the
  cone that runs the body, for the element and the scope it is evaluated
  for. An instance that an evaluation no longer makes is torn down, as a
  child is whose factory changed (section 3.15): its cones are not
  evaluated again and its effects are not requested again. The runtime
  keeps, with the cone, which instances the last evaluation made at each
  site. Section 2.6 gives the label of that record.
- **A callee that differs between evaluations.** Where the callee is a
  factory value, the factory at an occurrence can differ from the one the
  evaluation before had there. The instance is then torn down and a new
  one is started under the same name, by the rule for a changed factory
  (section 3.15).
- **A failed evaluation** makes no instance and tears none down. The
  arguments of the instances the last evaluation made take the error
  state, by the rule of section 5.2 for a path of a child's argument.
- **Effects.** The body requests no effect itself (below). An effect in
  the instance is an `Operation` of the child's plan. A cone of the child
  computes its request from the child's `argument` slots, which resolve to
  the labels the computation's write edges stored. The computation's label
  therefore reaches the request through the argument. The effect is
  requested again when its request changes, as any effect is whose input
  changed. The egress ceiling is checked at the request, in the
  operation's own request transaction, and again at each later send
  (below).

**Creating a cell** (`createCell`).

- In a handler a cell created without an explicit cause is new on every
  invocation. Its initial value and its existence carry `T_b`, and so
  does the identity of the handle the body holds. Writing the handle into
  state is a reference write. A cell created under an explicit cause is
  identified by the enclosing instance, the handler's `name` and
  `within`, and the cause (section 1.3), so a
  later event names the same cell and creates nothing. Its
  existence label is frozen when it is first created, as an instance's is
  with `.for(tag)`, and a read through its handle is dynamic (section
  3.9).
- In a `lift` or `computed` the cell needs an explicit cause. When the cause
  is a constant, or the element key of the enclosing element body, the cell
  is a `StateCell` of the plan and the write is a static side-write (section
  3.11). When the cause is computed from data, the target is not known
  statically and the body is a materializer, with its own transaction and
  today's rules. The existence of a document under a data-dependent
  identifier reveals the data, so its existence label is the body's
  template.

**A cell that is a `StateCell`.** For a constant cause, or the element
key, the plan records the cell as follows.

- The `StateCell` has the site's `schema` and `scope`, the `within` of the
  body, and a `name` formed from the body's `name` and the cause: the
  body's name, a `/`, and the canonical form of the constant. Where the
  cause is the element key, the name is the body's name alone, and the
  `element` step of `within` contributes the key. The identifier is the
  one a cell created under an explicit cause has
  (`execution-and-storage.md` §5.5).
- The `createCell` site stays in `Body.calls`, with
  `identifiedBy: "cause"`, and its `stateCell` member is the index of the
  `StateCell`.
- A write to the cell, its initial value included, is a `WriteEdge` with
  target `state`, and the plan lists a `ConeEdge` of kind `state` from
  the writing cone to each cone that reads the cell (section 3.11).
- A cone that reads the cell has a slot with root `state`.

The initial value of any other created cell is a `WriteEdge` with target
`created`.

**Declaring a database** (`sqliteDatabase`). The declaration is legal in
the reactive tier only (`builtin-inventory.md`, "`sqliteDatabase`"), so it
is not a site of `Body.calls`. It is an `Operation` of kind `database`,
with `implementation: { builtin: "sqliteDatabase" }`, named by `name` and
`within` as a state cell is. Its `tables` member holds the table
declarations, which are constants of the plan, and its `scope` the scope
the declared type of the handle gives. It has no request: no write edge
has the target `request` for it, no transaction is its own, and its
`input` is `const`. Its state document holds the handle, and a slot with
root `operation` reads it: `db.query(...)` holds the handle by value as
an operand of a `sqliteQuery` request, and `db.exec(...)` in a handler is
a write through the handle, a `WriteEdge` with target `handle` whose slot
is the handle's `identity` slot. The declaration has no label rule of its
own. The handle's `owner` is written once, from the acting principal of
the transaction that first writes the handle. *Assumed:* the state
document carries what section 2.6 gives the bookkeeping of an operation,
the confidentiality of `Operation.input`, which is `const` here and so
empty, and no integrity. The handle then carries no label beyond what
the table declarations in it declare, as today
(`execution-and-storage.md` §6.8; section 8, question 40).

**Requesting an effect** (`effect`, legal in a handler and an action). The
request is staged in the event's transaction. Each path of it is a
`WriteEdge` with target `request`, which carries `T_b`, or the reference
rules of section 3.9 for a reference the body was given. The call returns
a link to the effect's result, which is pending in the requesting
transaction. The occurrence is identified by the handling and its ordinal
(section 1.3). A `lift` or a `computed` does not request an effect itself,
and neither does an authored function called from the reactive tier or
an `assert`, which are held to the rules of a `lift`
(`language-subset.md` §5.2). A computation reaches an effect through a
pattern it instantiates (above), and an effect that depends on computed
data can also be requested in the reactive tier, with the computed value
as its input.

In the reactive tier an effect is an `Operation` of kind `effect`. A cone
computes its request, and the request is written into the operation's
state by write edges with target `request`, one per path, each with the
template of the expression at that path. `Operation.input` is the join of
those templates.

**What the egress ceiling is checked on.** A request holds a container or a
cell by reference, as the argument of an instantiation does. The request's
own templates then hold the pointer's label and not the label of the
content, and the effect serializes the content. So the ceiling is checked
on the label of everything the effect serializes or computes its request
hash from:

```text
C(the request's templates, instantiated)
  ⊔ C(what following the references the request holds consumes)
```

- **Following.** The transaction that checks the ceiling resolves each
  reference the request holds, as far as the built-in serializes, and
  joins what those reads consume. An operand that the built-in's entry in
  `builtin-inventory.md` declares a reference is not followed: it leaves
  as a reference and its content is not serialized, as with the target of
  `navigateTo`.
- **What is hashed is followed too.** An operand can enter the request
  hash without being sent, as `reactOn`, `maxConfidentiality`, `onExceed`,
  `readClearance` and `requestKey` of `sqliteQuery` do
  (`builtin-inventory.md`, "Effectful built-ins"). The transaction follows
  such an operand as it follows one that is sent, as far as the hash reads
  it, and what those reads consume joins the same label. The stored hash is
  a function of that content. Whether and when the request is made again
  is a function of the hash, so the content is part of what the sink can
  observe and of what the result depends on. Today the action reads such
  an operand in its own transaction (`sqliteQuery` in
  `runtime/runner/src/builtins/sqlite-builtins.ts` reads `reactOn` into
  the request hash), and the ceiling is measured on that transaction's
  whole consumed label, so the label is **equal**.
- **The label of the stored hash.** The request hash, the claim and the
  pending mark of the effect carry the joined label (section 2.6).
- **These reads are the check's.** They are not in `T_b`. The label of the
  content reaches the ceiling and the effect's result, and does not reach
  what else the handler writes. The alternative, a request that reads the
  content of its members, would put the content's label on every write of
  the handler, which is looser than today.
- **The label of the result.** Where the declared rule of a built-in's
  boundary takes the request's label, it takes this joined label.
- **What leaves is what was checked.** The release check of today compares
  the request about to leave with the one that was checked
  (`verifySinkRequestRelease` in `runtime/runner/src/cfc/sink-request.ts`),
  and it stays.
- **Which transaction.** For a request a handler makes, the check is made
  in the event's transaction on the server. It is a check on what the
  handler itself stages, so a failure rejects the event (section 4.4). For
  a request of the reactive tier, the check is made in the operation's own
  request transaction, when it reads the stored request. A failure rejects
  that transaction and no other: the request is not made, and the
  operation's result takes the refusal as an error state under the joined
  label. A request a handler made that is still pending when a process
  activates the space is made again in a request transaction of its own
  (`scheduler-and-serving-loop.md` §2.3). That transaction follows the
  references again and checks the ceiling on the content as it is then,
  as the request transaction of an operation of the plan does, and a
  failure there rejects that transaction and gives the result the error
  state. A request that passed the check when the event committed can
  therefore be refused then, and the content sent can differ from the
  content the event's transaction checked.

**Each later send is checked.** The check at the request is not
sufficient for a built-in that sends content after its request was
checked. The language-model built-ins do so in three ways
(`builtin-inventory.md`, `generateText` and `llmDialog`): the result of a
tool call is sent back to the model, a system prompt is rendered again
from live context, and a dialog sends its live transcript with each model
call. No checked request held that content. The egress ceiling is
therefore checked again on each send.

- **What is checked.** The label of everything the send serializes. It is
  the join of what the boundary's reads for that send consume, with the
  references followed as far as the built-in serializes, by the rule
  above for a request. For the result of a tool call it is the label of
  the result as the boundary reads it (section 3.15 for a pattern
  closure). For a prompt rendered again it is what reading the live
  context consumes at that time, and for a transcript what reading the
  messages consumes at that time. Content the effect holds from an
  earlier send of the same request, or received from the model, enters
  under the label it was checked or received under.
- **Which transaction.** The boundary makes the reads of a send in a
  transaction of its own, a **send transaction**, as it makes the reads
  of a request in a request transaction. The send transaction checks the
  ceiling of the built-in's sink before the send is made, and the release
  check compares what leaves with what that transaction checked. The
  reads are the check's: they join the label of nothing that a handler or
  a cone writes.
- **A refused send.** A send that fails the check is not made. The
  failure rejects the send transaction and no other. The effect makes no
  further send for that request, and the built-in's result takes the
  error state: the refusal, under the join of the request's joined label,
  the labels of what was sent and received before, and the label the
  refused check was evaluated on. What the effect stored before the
  refused send stays stored. The event whose handler requested the effect
  has committed and is not rejected.
- **Per built-in.** Which sends a built-in makes, and what its result is
  where it has several, as a dialog has a result per turn, is in the
  built-in's entry in `builtin-inventory.md`.

**Binding a handler** (`bind`): an `action(...)`, an inline event handler in
JSX the body builds, or a handler factory applied to its state. For the
first two the compiler hoists the arrow to a handler `Body` whose state is
its captures. The site refers to a `Binding`, which records the handler
and, for each path of the handler's state, the template of what is bound
to it and whether the path is copied or bound by reference (`capture`). A
handler factory received as a value is section 3.21. What a binding holds
depends on where it is made.

**A binding made in the reactive tier copies nothing.** The reactive tier
is the pattern body and everything compiled in it, the body of a
per-element callback of `map`, `filter` and the other collection
constructs included. Every path of the handler's state resolves to a slot
or an output of the instance, and every entry of `Binding.state` has
`capture: "link"`. In
`list.map((el) => … action(() => otherList.push(el)))`, written in a
pattern body, `el` is bound by reference: the handler's state path is the
element's slot, and the push stores a link to the original element. The
stream is named by the binding's `name` and `within` (section 1.3), and
not by what the binding holds. A path so bound reads the default that the
declaration of the slot it resolves to has, where nothing is stored there,
whatever the handler's own state type declares (section 2.5, "A default
belongs to the place").

**A binding made while a function body runs** is a `bind` site in a
`lift`, a `computed`, a `handler`, an `action`, or an authored function
they call. Each path of the handler's state is bound by what the body has
there.

| What the body binds at a path | What the binding holds | `capture` | Label |
| --- | --- | --- | --- |
| A cell handle | A link | `link` | The reference rules of section 3.9 |
| A scalar | The value, in the binding's state document | `copy` | `T_b` |
| A container (an object, an array, a tuple) that the body computed | The value, in the binding's state document. A reference inside it stays a reference, by the rule for a value passed on unchanged | `copy` | `T_b`, and the reference rules of section 3.9 for a reference inside it |
| A container that the body read from an input or a cell and passes on unchanged, a reference at a position typed `unknown`, or a factory value the body was given and passes on unchanged | A link to the address the container is stored at. For a reference, the reference itself. For a factory value, the factory value | `link` | The reference rules of section 3.9. The body observes the container for `identity` and does not read its content |

A copied scalar is what the body read. A scalar the body read from a
place where nothing is stored, and whose declaration has a default, is
copied as the default (section 2.5).

A container the body read and passes on unchanged has a stored address,
which is why it can be bound by reference. `Binding.state` records the
reference of such a path in `reference`: its `identity` slot, or, for a
handle or a container that reached the body in a value the instance
computed, its `identity` entry of `Body.computed`. The runtime verifies it
by identity, as it verifies a reference a body writes. The link the
binding stores carries the label the reference rules give the path: the
label of the slot, or the entry's template, instantiated. That is the
pointer label a `binding` slot joins when its path crosses the link.

**How much a copy holds.** A copied path holds what the bound handler
observes of it and no more. `Binding.state` records no observation class
for a copied path, because the handler's own record has it: the runtime
narrows the copy by the handler's slots with root `binding` at or below
the path, as it narrows the handler's argument (section 3.9).

| The handler's slot | What the copy holds at the slot's path |
| --- | --- |
| `value` | The value |
| `shape` | A stand-in of the same kind |
| `enumeration` | A container with the same keys, or the same length |
| `identity` | The subtree. The reference the handler observes is the reference to the copy |
| `labelMetadata` | Nothing on its own account. The handler observes the label stored for the copy |
| No slot at or below a path | Nothing |

Every copied path carries `T_b`, whatever the class.
`footprint-analysis.md` §8.5 has what the body that makes the binding
records for each row. The copied values that enter the identity of the
stream (below) are the copy as narrowed, so two bindings whose computed
containers differ only at paths the handler does not observe are one
stream.

For a handler received as a factory value the compiler does not have the
handler's record (section 3.21). The copy then holds the subtree that the
declared state type covers (`Binding.stateSchema`), as `value`. The record
the runtime resolves when the binding is made narrows what the handler's
argument takes from the copy when an event arrives, and does not narrow
the copy.

**A path that is a reference on some runs only.** A conditional between a
container passed on unchanged and a container the body computed gives a
path that holds a reference on some runs and a computed value on the
others. `Binding.state` records such a path with `capture: "copy"` and no
`reference`, and its template is `T_b`. The runtime decides per run from
the value it is handed: a value that carries a stored address is stored as
a link, as any write of a value passed on unchanged is, and any other
value is copied. The identity of the stream takes the address on the first
kind of run and the salted value on the second.

| Part | Label |
| --- | --- |
| The stream returned | A reference whose identity derives from the enclosing instance, the handler, the copied values, the identities of the linked cells, and the addresses of the containers bound by reference. A copied value is salted before it enters the identifier, as an element key is (section 1.3). The identity label is the join of the templates of the state paths, which is `T_b` unless every path is a reference the body passes on. For a handler received as a factory value, the label of the `identity` slot of the factory joins it (section 3.21) |
| The bound handler's state | Slots with root `binding`. A copied path resolves to the binding's state document. A path bound by reference crosses the link the binding holds (section 2.5): the handler reads the cell or the container when an event arrives, in the event's transaction, and the slot's label joins the pointer label with the observation at the target. A path of a binding of the reactive tier resolves to the slot or the output it names. When an event arrives, the handler's own template is over those slots and its event |

A handler that passes on a container it was bound to by reference passes
on the reference the binding holds, so the record it writes links to the
original.

Two bindings of one handler are one stream when their copied values are
equal and their linked cells and addresses are the same, and a
re-evaluation of a `computed` that builds the same JSX names the same
streams. For the copied values this is the element-key rule of section 1.3
applied to bindings, salt included, and it is what makes a binding legal
in a body that is re-evaluated. Two bindings to equal records stored in
two places are two streams, because the addresses differ. A handler that
has to act on one occurrence among equal copied values needs the index or
a cell in its state. The same holds in an element body of the reactive
tier over plain values, where equal elements share one stream unless the
position is part of the key (section 1.3), and in a function body, where
a binding is made in an ordinary loop and equal state gives one stream.

The identifier of the stream of a binding made in a function body does
not hold the place of the `bind` site: no step of `within` and no name
enters it. A binding made in an element body by a `computed`, or in a
call compiled into the plan, that holds equal state is therefore the
same stream for every element and every call.

A client cannot read the salt (section 1.3). It cannot name the stream of
a binding that has a copied path before the server stores a link to it. A
binding with no copied path, which every binding of the reactive tier is,
has an identifier a client derives, unless an element key among its
`within` steps holds a value (section 1.3).

**Today.** A factory called in a running body creates a node in the run's
frame, and the runner turns the frame into a synthesized pattern after the
body returns (`patternFromFrame` in `runtime/runner/src/builder/pattern.ts`).
What the body's transaction writes carries its join, which is `T_b`.
**Equal**, and **tighter** for references the body passes on.

- **An instance made by a computation.** The frame of a `lift` or a
  `computed` that called a pattern is such a synthesized pattern
  (`#writeJavaScriptActionResult` in `runtime/runner/src/runner.ts`). It
  runs on a result cell whose identifier derives from the node's inputs,
  outputs and function, which is the same on every evaluation. It is set
  up again on that cell when its content differs from the content the
  evaluation before produced, and what it started is released when the
  node stops. So an instance is named by the computation and by its place
  in what the evaluation built, and an evaluation that builds the same
  graph changes nothing. One that builds another graph stops the first
  and starts the second, where this design updates the argument of an
  instance that stays (`language-subset.md` §5.2). **Equal** for labels:
  the argument carries the join of the computation's transaction.
- **A binding.** A handler applied to its state in a running body binds
  that state by reference today, and a container a handler uses whole
  stays a link. A value read through a schema carries the cell it was read
  from (`annotateWithBackToCellSymbols` in `runtime/runner/src/schema.ts`),
  and the builder puts that cell in the place of the value when the
  handler is applied (`connectInputAndOutputs` in
  `runtime/runner/src/builder/node-utils.ts`). What the binding holds and
  what the handler observes are **equal**. What the body that makes the
  binding reads is **equal or tighter**, and `footprint-analysis.md` §8.5
  compares the cases: the argument schema of a body that applies a handler
  keeps the container's declared type today, and for an inline handler
  the transformer rewrites a captured container to the paths the handler
  reads, which the body then reads and the binding copies. A binding by
  reference reads none of that content in the body.
- **An effect.** A built-in requested in a handler runs as a node of that
  synthesized pattern, in a transaction of its own that reads the
  request's content, and the ceiling is measured on that transaction's
  consumed label (`verifySinkRequestCeilings` in
  `runtime/runner/src/cfc/prepare.ts`). The ceiling here is checked on the
  request and its content. **Equal or tighter.** The check on each later
  send is an additional check: `builtin-inventory.md` records that a
  dialog stages a sink request for the first model call of a turn only.
  It refuses more than today and changes no label.

### 3.15 Child instances

A `Child` is a pattern instantiated with a plan of its own. There are two
cases: a pattern received as a factory value and called in the reactive
tier, whose plan the compiler cannot see, and any pattern a function body
instantiates, whose instantiation is a run-time event even when the callee
is known.

**What the enclosing plan records** (`Child`): the callee, as a compiled
pattern's identity, as the slot that holds the factory, as the entry of
`Body.computed` that holds it where a body received it in a value the
instance computed (below), or as the closure
of an inline pattern written at an instantiation in a body; the argument and
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
reference and carries the reference's label. The link written holds the
schema of the place it names, as the enclosing plan declares it
(`Slot.schema` of the slot the path names), the default included, so the
child reads that default where nothing is stored at the place (section
2.5, "A default belongs to the place"). An argument path that is a
computed value is written into the argument document with its instantiated
template. Such a value is therefore stored even when the enclosing instance
would not otherwise keep it: the argument of a child is part of the keep
set.

**A handle to a path of the argument.** Where the child's plan has an
`identity` slot with root `argument` at a position of handle type, what
the handle names follows from what the argument document holds there
(section 2.5).

- **The path holds a link**: the request gave a handle, or a value bound
  by reference in the reactive tier, or a container a function body read
  and passes on unchanged. The handle names the cell the link leads to,
  and a write lands there (section 3.11).
- **The path holds a value**: a value the enclosing instance computed, a
  literal, or a scalar or a computed container a function body gave
  (`language-subset.md` §7.5.3). The handle names that path of the
  child's own argument document. A write through it is a `handle` target
  of the child's plan, lands at that path, and carries the template of
  the child's edge. It changes nothing the requester holds.
- **The path holds nothing**: the handle names the path all the same
  (section 2.5, "A handle to a position that holds nothing").

A path of the second kind has two writers: the child, through the handle,
and the cone of the enclosing instance whose write edge with target
`argument` names the path. The path holds what was written last, under
the label of that write. An evaluation of the cone writes the path again,
so it replaces what the child wrote. That is the case for a child of the
reactive tier and for an instance a `lift` or a `computed` makes: each
evaluation that names the instance writes its argument (section 3.14, "In
a body that is re-evaluated"). An instance a handler made is not written
again by a later event (section 3.14). The cone is evaluated when one of
its inputs changed, so the child's write stays until then. The slots of
the child that read the path resolve to the label stored there, whichever
writer stored it. The error state of section 5.2 for a path of a child's
argument is unchanged: a failed cone gives the path the error state,
whatever the child wrote there.

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
found again only where cell names agree. The rule covers an instance a
`lift` or a `computed` makes with a factory value as the callee: when an
evaluation has another factory at an occurrence than the evaluation before
had, the instance is replaced in the same way (section 3.14).

**A factory from a computed input.** A body can instantiate a factory
value that reached it in a value the instance computed, such as the one a
conditional of the pattern body chose among two factories. Such a factory
has no slot.
`Child.callee` then names its `identity` entry of the `computed` of the
body whose `instantiate` site refers to the child (`GivenReference`).

- **The factory the runtime uses** is the one it placed at the entry's
  position in the body's argument. It resolves that factory to a plan,
  checks the plan's schemas against the declared ones, and compares it
  with the factory the evaluation before had at the occurrence, as it does
  for a factory at a slot.
- **The label.** The entry's template takes the place of the label of the
  factory's `identity` slot. It is the label of which factory the
  producing expression put at the position. A child that a body
  instantiates is read through the link the call returns, by that body or
  by whatever the link is passed to, and the identity of that link carries
  `T_b` (section 3.14). `T_b` joins the template of every entry of
  `Body.computed` (section 3.9), as it joins the `identity` slot of a
  factory at a slot. So every read of the child's result carries the label
  of which pattern produced it, as the rule above requires, and no
  template needs a further input.

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
- **How much a copy holds.** A copied capture holds what the inline
  pattern observes of it and no more. The inline pattern's plan has the
  captures as slots with root `params`, and the compiler has that plan
  where it compiles the closure. The copy holds the paths at which that
  plan has such a slot, each narrowed to the slot's class by the table of
  section 3.14 for a binding's copy, with the inline pattern's `params`
  slots in the place of the handler's `binding` slots. `Closure.params`
  lists the copied paths, and the `value` template of the factory value
  joins the templates of those paths and of no other path of a captured
  value.
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
- **Written at an instantiation in a function body.** An inline
  `pattern(...)` that is the callee of an instantiation in a function body
  is a `Closure` as well, and the `Child` of the site names it as its
  callee. It is not a value. Nothing holds a factory, so the rules above
  for the factory value and for "coming back" do not apply: the link the
  body gets carries `T_b` (section 3.14). Each parameter path is bound as
  a path of a handler's state is bound in a function body (section 3.14):
  a cell handle, and a container the body read and passes on unchanged,
  stay links with the reference rules; a scalar, and a container the body
  computed, are copied with `T_b`. A computed container is copied as far
  as the inline pattern's plan reads below its `params` root, by the rule
  above ("How much a copy holds"), and `footprint-analysis.md` §8.1 has
  what the instantiating body records for it. The parameters are stored
  with the instance, beside its argument, and each evaluation that makes
  the instance writes them as it writes the argument. The child's `params`
  slots resolve to what is stored there. *Assumed:* the ruling on what a
  handler binding holds is applied to these captures, on which the owner
  has not ruled (section 8, question 23).

**A pattern closure given to a language model as a tool.** A
language-model built-in that takes tools can be given a pattern closure
as one (`builtin-inventory.md`, `generateText`, `generateObject` and
`llmDialog`). The closure is a factory value at a path of the built-in's
request. The model's output can hold a tool call, which names the tool
and supplies an argument, and the boundary of the built-in then
instantiates the closure with that argument. The enclosing plan has no
`Child` and no `instantiate` site for the instance: whether it is made,
and how often, follows from the model's output at run time. The rule
uses records that exist for other purposes.

| Part | Label | Record |
| --- | --- | --- |
| The tool in the request | The label of the factory value (above): the join of the templates of the copied captures and the `identity` slots of the captured cells. `builtin-inventory.md` declares the pattern of a tool a reference, so the egress check at the request does not follow it | The `WriteEdge` with target `request` at the tool's path. Its `template` is the factory value's, and where a body passes the factory on, its `reference` names it (`GivenReference`, section 3.9) |
| That the instance exists | The label of the model's output: of the generation that produced the tool call. Whether a call is made, and of which tool, is the model's choice | None in a plan. The label is given by the declared rule of the boundary (section 2.6), in the boundary's transaction that handles the tool call |
| The argument the model supplies | The label of the model's output, as in the row above: the confidentiality that the declared rule of the boundary gives the generation that produced the tool call, and the integrity that rule declares for model output. Each path of the argument is written into the instance's argument document under it. No template is instantiated for the argument, and the template of no body joins it | The argument document of the instance. The `argument` slots of the inline pattern's plan resolve to the labels stored there |
| The private parameters | As for any call of the closure: the labels stored with the factory value. The model supplies the public argument only, and cannot observe or supply a parameter | `Closure.params`, and the slots with root `params` of the inline pattern's plan |
| The result of the call | The label of the instance's own result: the label stored at each path of it, which the inline pattern's plan instantiates by the ordinary rules, from its `argument` slots, its `params` slots, its state and its operations. What the boundary reads of the result joins the label of the factory value, by the rule for labels coming back (above) | The `Output` records of the inline pattern's plan. The boundary reads a path of the result as a slot with root `child` reads it |

Three things follow from the rows.

- **The model's label reaches the result through the argument.** A path
  of the result that depends on the argument has a template that reaches
  an `argument` slot, so it carries the label of the model's output. A
  path that does not depend on it does not.
- **Constraints of the inline pattern on its argument** are evaluated on
  the label of the model's output. A `requiredIntegrity` or a
  `maxConfidentiality` constraint of the inline pattern's plan lists
  `argument` slots like any other slots (section 4.4), and the integrity
  it tests is the one the boundary declares for model output.
- **Sending the result back to the model** is a later send of the
  built-in. The egress ceiling is checked on the label of the result as
  the boundary reads it, with the references followed as far as the
  built-in serializes (section 3.14, "Each later send is checked"). The
  label of what the model produces afterward is given by the declared
  rule of the boundary, which joins what the model had observed, that
  result included.

How the instance is identified, in which space and scope it is made, and
when it is torn down are in the built-in's entry in
`builtin-inventory.md`. A handler given as a tool, and the tools a dialog
has built in, are not covered by this rule.

The rule leaves three gaps of the closure records open.

- **Which path holds which closure.** No record says which output path,
  argument path or request path holds which entry of `Plan.closures`.
  `Child.callee` is the one member that names an entry by index. The rule
  does not need the link, because it applies to the factory value the
  request holds at run time, with the labels stored with that value. A
  reader of a plan still cannot tell from the records which closure a
  request passes as a tool.
- **A conditional between two closures.** Where a request holds
  `c ? closureA : closureB`, the rule applies to the factory value the
  conditional selected, under the label the `select` gives it. Whether
  such a conditional is a factory value at all, or a callee resolved
  where it is written, is not decided here (`language-subset.md` §4.4.2).
- **A closure called through `inSpace`.** A tool call instantiates the
  closure with no modifier. What an `inSpace` call of a closure records
  for the private parameters, which then cross into another space, is
  not decided, and neither is whether a tool can be instantiated in
  another space.

**Today.** `builtin-inventory.md` (`llmDialog`, "Tools") describes what a
pattern tool does in the current runtime: it instantiates the stored
pattern into a result cell whose cause is the tool-call identifier the
model supplied. A pattern closure does not exist today, so this rule has
nothing to be compared with.

**One transaction.** A child in the same space is evaluated in the
transaction that pulls its result, by the pull that extends through that
result. A child created with `inSpace` is not (section 3.14).

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
| `principalOf`, `principalsOf`, `profileOwnerOf` | The `identity` slot of the target, resolved, and a `labelMetadata` slot on it (section 2.4) | The pointer labels of the links followed to the target, joined with the label of the metadata observation. A claim's kind and subject are classified public today, so the second part is empty. The target's value is not read |
| `resultOwnerOf` | The `identity` slot of the operand, and a `dynamic` node of kind `link` through it for the links the call follows | The pointer labels of the links followed to the document the cell is, and, where the call names a field, of the links followed from that field of the owning result. The read of the document's back-link contributes nothing (below) |
| `spaceOf(x)` | The `identity` slot of `x`, resolved | The pointer labels of the links followed from `x` to the cell that holds its value: the label of the reference at `x` and of every link below it that resolution follows. Which space that cell lives in is part of its address. No content is read |
| `spaceAccess`, `spaceAccessOf`, `spaceMembers` | `dynamic`, of kind `space`, through the `identity` slot of the operand, resolved | What the journaled reads of that space's access list consume, joined with the slot. `spaceAccess` and `spaceMembers` answer for the acting principal, so an output that depends on them has the scope `user` (section 1.4) |
| `spaceDeleted(x)` | `dynamic`, of kind `space`, through the `identity` slot of a cell operand, resolved, or the `value` slot of an operand that names a space | What the journaled read of that space's access list consumes, joined with the slot. The answer does not depend on who asks (below) |
| `linksOf(list)` | The `enumeration` slot of the list and the `identity` slot of each element | The join of those. No target is read |
| `equals(a, b)` | The `identity` slots of both operands, resolved | The join of both |
| `a.equalLinks(b)`, `X.equalLinks(a, b)` | The `identity` slots of both operands, not resolved | The join of both: the label of the reference each position holds, as stored. No link below either reference is followed, and no target is read |
| `getPatternEnvironment()` | `const` | None. It is a constant of the deployment |

The access list of a space is state of that space, and which space is meant
is data, so those reads are journaled like a followed link (section 3.10)
and keep their trigger reads.

**Static and journaled.** The rows above give the record of a call in the
reactive tier, and of a call in a body whose operand is one handle the body
was given at a static place and which every run that returns normally
makes. `footprint-analysis.md` §7.2 has that condition for a read through a
handle, and it applies to these observations in the same way. Any other
call in a body is journaled, as the runtime records it today. The
operand's `identity` slot is then not `resolved`: the links the call
follows below the operand's reference are a `dynamic` node of kind `link`
through that slot, and a label-metadata observation joins the body's
`dynamic` node of kind `labelMetadata`. An operand that reached the body
in a value the instance computed is always journaled, and the node names
its `identity` entry of `Body.computed` in the place of a slot. The
label of that node is the join of the labels of the observations the
runtime recorded while the body ran. A change of the label stored at an
observed path makes the cone stale, as a change at a `labelMetadata`
slot's address does.

**`equalLinks`.** The call compares the two references as they are stored
and follows no link, so it has no journaled part: in a body as in the
reactive tier, its record is the plain `identity` slot of each operand.
`equals` resolves both operands first, which is why its slots are
resolved. Today `equalLinks` compares the links without a transaction
(`equalLinks` in `runtime/runner/src/cell.ts`), and the label it joins is
that of the reads that handed the body the two references.

**`resultOwnerOf`.** The call resolves the operand to the document a write
to it lands in, reads that document's `result` back-link, and with a field
resolves that field of the owning result. The two resolutions are ordinary
reads of links, and their pointer labels join. The read of the back-link is
a verifier read (`resultOwnerOf` in
`runtime/runner/src/builder/result-owner-of.ts` passes
`internalVerifierRead`), and a verifier read takes no part in flow
derivation today (`forEachFlowObservation` in
`runtime/runner/src/cfc/prepare.ts` skips it). Setup writes the back-link
and no pattern can write it, so it carries nothing of a pattern's data. In
the plan it contributes no label. The runtime journals it with the reads
of the `dynamic` node, so that a change of the back-link makes the cone
stale as it reruns a computation today, and leaves it out of the node's
label.

**`spaceDeleted`.** Whether a space is deleted is state of the runtime, from
the memory server's answer, and not a document. The call still reads the
space's access list through the transaction today, which is what opens the
space (`spaceDeleted` in `runtime/runner/src/builder/space-access.ts`), and
that journaled read is what the `dynamic` node stands for. When the
server's answer for a space changes, the runtime reports it as a change at
the address of that space's access list, so a cone that asked about the
space is made stale by it. A template of `const` would join less than
today and would leave nothing to make the cone stale.

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
`runtime/runner/src/builder/`. The rows above record the same observations,
and leave out the verifier reads that flow derivation leaves out today.
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

The winner among elements with equal index keys in `key` mode is the
element at the first position among them, in the source order of the
collection. No element value beyond the index key enters the choice, and
no element key does. The order is part of the bucket's membership label,
which the choice carries. A nullish index key omits the
element, which is part of what the fold observes.

Every element's key function result is in a bucket's membership, not only
those of the elements in the bucket: that an element is absent from bucket
`k` says its key is not `k`.

**This is one of the three rules that are looser than today (section 3.1).**
Each
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
| `minBy`, `maxBy` | The collection | Membership, order included, joined with a `fold` of the key function's template. A tie goes to the first position in source order (section 3.8) |
| `lookup(k)`, `key` mode | The bucket | The bucket's membership, order included, joined with the template of `k`. Among elements with the index key `k` the first position in source order wins (section 3.17) |
| `a[k]` | The container slot of `a`, or the output that computes `a` | The template of `k` joined with the `shape` of the chosen child |

**A dynamic key.** `a[k]` observes the key and the one child it selects:
whether the child exists, and whatever the surrounding expression reads of
it. It does not observe the container's other children or its enumeration,
by the rule that child access is navigation (§4.6.3). The value code
reports the key, the runtime binds the body's child slots to that path, and
the label follows. The container's enumeration is not needed, so a dynamic
key in the reactive tier needs no refusal.

**The choice point.** Every `pick` node has a choice point of its own,
`Template.pick`, an index into `Plan.picks`, as a `select` has a
selector. `Cone.picks` lists the choice points a cone evaluates. Two
picks over one container, `a[j]` and `a[k]`, are two choice points, and
so is a pick whose `from` is an output, which has no slot. Where
`Pick.chosenBy` is `valueCode`, the value code reports the chosen key
per choice point, or that no child was chosen. Where it is `runtime`,
the runtime chose the element and knows its key. The chosen children
enter the instantiation key by choice point (section 4.6).

A reader that reaches a container only through picks depends on the
children it chose and on no other. For a container that is a slot this
follows from the binding: the child slots are bound to the chosen path.
For a container another cone computed, the reader receives the whole
output, and the runtime compares the chosen children: a cone instance
that reaches an upstream output only through picks is stale when a child
it chose changed, and not when another child of the output changed
(`execution-and-storage.md` §3.3). A change of what the key was computed
from makes it stale as a change of any input does.

**A container the instance computed.** Where `a` is a value another
expression of the instance computed, `from` names its output and `body` is
the template of the chosen child. When one opaque call produced `a`, every
path of `a` has the call's template (section 3.3), so `body` is that
template whichever child is chosen, and the label is the template of `k`
joined with the call's. When `a` is a constructed object with a static key
set, the compiler emits a `select` over its keys in place of a `pick`, and
each branch is the template of that member.

**Handle methods in the reactive tier.** `language-subset.md` §4.7 allows
`get()`, `key(k)` and `elementById(k)` on a handle in the reactive tier.
They are the operations above and add no rule. `h.key("b")` extends the
path, like `a.b` (section 3.3). `h.key(k)` and `h.elementById(k)` with a
key that is not a constant are a `pick` with the template of `k` as the
choice. `h.get()` reads the value at the handle's path: for a handle that
is a slot, the slot's path continues through the handle's link (section
2.5), and for a handle that stands for a value the instance computed, as
the parameter of a pattern compiled into the instance does, it is that
value.

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
slot that holds the factory, observed for `identity`, or the entry of
`Body.computed` that holds it (below); the event and state
schemas the factory's type declares; and, for each state path, the template
of what is bound to it and whether it is copied or bound by reference. The
rule of section 3.14 decides that from the value the binder has at the
path and not from the handler, so it needs no knowledge of the handler.

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
and what the binding holds (section 3.14). Which stream exists therefore
reveals which handler arrived, so the stream's identity label is the join
of the templates of the state paths and the label of the factory's
`identity` slot.

**A factory bound in a function body.** At a `bind` site,
`handler.factory` names the `identity` slot the body has at the factory's
position. For a factory that reached the body in a value the instance
computed, it names the factory's `identity` entry of that body's
`computed` (`GivenReference`), and the entry's template takes the place of
the slot's label in the identity label of the stream.

Which handler such a binding holds is fixed when the binding is made. The
stream's identifier holds the factory's content address, so another
factory at the same place is another stream. The label of which handler
it is is fixed with it. *Assumed:* the transaction that makes the binding
instantiates the label of the factory's `identity` slot, or the template
of its entry, and stores it in the binding's state document with the
factory's content address, as it stores the label of a copied path. When
an event arrives, the handler's template joins the label stored there,
where the rule above has the label of the slot. Two things make the
stored label necessary. An entry of `Body.computed` has no address at
which a label could be resolved when an event arrives. And a slot of the
binding body can have a root that is bound only while that body runs,
such as the event of the handler that made the binding. For a binding of
the reactive tier the factory's slot is a slot of the instance, and its
label is resolved when the event arrives.

**Checks that move from compile time to run time.**

| Check | With a known handler | With a factory value |
| --- | --- | --- |
| The writer policy of a written path names this handler | Compile time, for a static write edge (section 4.4) | When the handler writes: the resolved `Body.code` against the policy of the cell it was bound to |
| The handler's schemas fit the binding | Compile time | When the binding is made: the resolved record's event and state schemas against the declared ones. A misfit fails the binding's cone, or the binding handler |
| Input requirements and ceilings on the handler's state | Compile time where the bound slots are declared | At instantiation, from the resolved record's constraints over the `binding` slots |
| Some element of the pattern binds the handler under the surface its UI contract names | Compile time, reported as a warning (section 4.4) | Not checkable; per event only |
| A write the handler's record does not list | Compile time | Refused by the runtime when attempted (section 7.3) |

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
| `groupBy`, `keyBy`, `lookup`, `keys`, `keyEntries` | Bucket membership a `fold` of the key function; `pick` for `key` mode | **Looser**, the first exception: absent elements' keys are included |
| Dynamic key `a[k]` | `pick` over a container | Equal |
| Template literal | `derive` over substitutions | Equal; tighter inside a constructed object |
| Sandboxed call | `derive` over slots, computed inputs and handles; references passed through | Equal or tighter; **looser**, the second exception, for a static read through a handle on a run that throws before it |
| Link following | A slot whose path crosses the link; `identity` slot plus `dynamic` where the path is not named | Equal |
| Static side-write | Template of the written expression | Equal or tighter |
| Write through a resolved reference | Template of the written expression, which holds the links the resolution follows; lands where the resolution ends | Equal |
| Materializer | Today's join on every path it writes, its result included | Equal |
| Handler | `derive` over event and state footprint | Equal or tighter (an authored event type is read whole today); the second exception applies |
| Calls in a body | The body's template on what it creates; the egress ceiling on a request and the content it holds by reference, sent or only hashed, and on each later send | Equal; tighter for passed references. The check on a later send is new |
| Instance made by a `lift` or a `computed` | The body's template on the argument, written by each evaluation; the instance named by the site and an ordinal, or by an explicit cause | Equal |
| Handler binding | Nothing copied in the reactive tier; in a body, a scalar and a computed container copied with the body's template, a handle and a stored container bound by reference | Equal or tighter: the body that makes the binding does not read a container it binds by reference |
| Child instance | Argument templates in; `child` slots out | Equal |
| Pattern closure | Join of the capture templates on the factory value; `params` slots inside | Equal |
| Pattern closure given to a language model as a tool | The label of the model's output on the argument and on the existence of the instance; the instance's own result labels on the result | New |
| What an element body stores once per element key (section 2.6) | The join over the positions that hold the key | **Looser**, the third exception, where positions that hold an equal element resolve to different labels. To be revisited |
| Handler factory value | The handler's own record, plus the factory's `identity` | New |
| Context reads | `cause`, `labelMetadata`, `identity` slots; `dynamic` for access lists and journaled observations | Equal |
| `anchorsOf`, `cellFromUrl` parsing, `wish` | References with computed identity; `dynamic` search | Equal |
| Stored state that is not an output (section 2.6) | The operation's input, the cone-level join, or the output's label | New |

Three things are looser, and all three are decided: the collection index, a
slot for a read through a handle on a run that throws before the read, and
what an element body stores once per element key, which is to be revisited
(section 3.1). There is no fourth. Another way a compiled label could be
looser than today's is a static footprint standing in for reads that are
dynamic today, and `handles` exclude it: a read a body makes through a cell
on some runs only, or at a path it computes, stays journaled. A widening
that covers data slots affects only what the runtime materializes into the
argument, which the body's argument schema materializes today as well. A
widening on a handle turns its reads into journaled ones under the handle's
declared type, which is what the runtime records for them today. A read
through a handle at a static place that is conditional stays dynamic for the
same reason. A handler binding is not a fourth either: a binding made in a
function body copies a scalar and a container the body computed, and binds a
stored container by reference, as the runtime does today (section 3.14).

## 4. Instantiation

### 4.1 When it runs

Instantiation runs in the transaction that evaluated a value, after the
value code, and only for the templates of what the transaction stores or
checks:

- a kept output (`Output.template`);
- a write edge (`WriteEdge.template`): a side-write, a write through a
  handle, a path of a child's argument, the initial value of a created
  cell, a path of an effect's stored request;
- the request of an effect, where the transaction checks the egress
  ceiling: the join of the request's templates and of what its references
  lead to, as far as the effect serializes or hashes them (section 3.14).
  A later send of the effect is checked in a send transaction on the
  labels its reads consume, and no template is instantiated for it;
- a state path that a binding made in a function body stores
  (`Binding.state`): a copied path, which is a scalar or a container the
  body computed, and the link of a path bound by reference, whose pointer
  label is the path's template. Both are stored in the binding's state
  document (section 3.14). For a handler factory value bound in a function
  body, the label of which factory it is is instantiated and stored there
  as well (section 3.21). A binding of the reactive tier has no state
  document, so nothing is instantiated for it;
- a parameter of a pattern closure that is copied (`Closure.params`), which
  is stored with the factory value, or with the instance where the closure
  is the callee of an instantiation in a function body (section 3.15);
- an output a cache stores (section 2.6);
- the other stored state of section 2.6, each under the label its row of
  the table there gives: the bookkeeping of an operation, the other
  members of a cache entry, a provenance record, the origin facts of a
  kept derived collection, the record of the instances a computation
  made, and an allocation record.

This list is the whole of what is instantiated.
`execution-and-storage.md` §1.6 and §1.9 refer to it.

For each one:

1. Decide whether there is anything to do. There is when one of these
   holds, and otherwise the step ends:
   - the cone or body that computes it was evaluated in this transaction;
   - something demands it, and a slot its template reaches under its last
     selections has a new label and an unchanged value;
   - it is a kept output, something demands it, and its current value was
     computed in a transaction that did not store it: one that a handler's
     failure aborted, one that a failed constraint rejected, an attempt
     that was withdrawn whole or whose event was queued again (section
     5.4; `scheduler-and-serving-loop.md` §5.5), or one whose commit
     withdrew the write on a conflict while nothing the value was computed
     from changed (section 4.6).
2. Collect the label identifier of each slot the template reaches under the
   reported selections, the selections themselves, and the children the
   template's `pick` nodes chose. With the slot-free hash of the template
   and the labels of its `dynamic` nodes (section 4.6), this is the
   **instantiation key**.
3. If the key equals the key the stored label was instantiated from, reuse
   that label. A change of value alone ends here.
4. Otherwise instantiate (section 4.2), look the result up in the memo
   (section 4.3), check the constraints (section 4.4), and stage the label
   with the write.

An interim value that is not kept is never labeled. Its template is not lost:
it is a sub-template of every kept output that depends on it.

**A label that changes alone.** A label can change without its value
changing, when a slot's label changed. *Assumed,* as
`scheduler-and-serving-loop.md` §3.6 proposes and pending the owner's
answer: the second condition of step 1 then holds for a demanded output,
no value code runs, and steps 2 to 4 instantiate the template from the
value and the selections of the last evaluation. The label entry is
rewritten and the constraints are checked again. This is the re-derivation
of §8.9.4 ("When a live reactive node recomputes, the new attempt's journal
sees the source's *current* labels") without the recomputation. An output
nothing demands is not re-instantiated, which that section permits: "There
is **no retroactive relabeling obligation**". Its next evaluation
instantiates with the labels current then. A slot with `sampled` never
makes the second condition hold (section 2.5).

### 4.2 The algorithm

`instantiateTemplate` is a kernel function in the sense of the correspondence
procedure: pure, named after its pseudocode, and the only place the runtime
decides what that pseudocode decides. It takes labels and selections and
returns a label. It takes no transaction and no slot value.

```ts
// Shown for illustration only.
interface TemplateInputs {
  /**
   * Label of a slot, already resolved by address, path and class, with its
   * chain. For an address this transaction or its batch wrote, the label
   * staged there (section 4.5).
   */
  slotLabel(slot: Index): Label;
  /**
   * The branch the value code took at a selector. For the `through` of a
   * `fold`, the position the runtime's own scan found (section 3.13).
   */
  selection(selector: Index): number;
  /** Elements of a collection in order, each with its own inputs. */
  elements(collection: Index): readonly TemplateInputs[];
  /**
   * The child chosen at a choice point (`Plan.picks`), or undefined when
   * none was chosen.
   */
  chosen(pick: Index): TemplateInputs | undefined;
  /** Membership label of a collection. */
  membership(collection: Index): Label;
  /** Join of what a journaled read set consumed. */
  dynamicLabel(reads: Index): Label;
  /** The `TransformedBy` atoms for a derivation, minted by the runtime. */
  mint(by: { body: Index } | { expression: true }): readonly Atom[];
}

/** What a `const` instantiates to: no clause, and no part in the meet. */
const NEUTRAL = "neutral";
type Instantiated = Label | typeof NEUTRAL;

function instantiateTemplate(t: Template, inp: TemplateInputs): Instantiated {
  switch (t.op) {
    case "const":
      return NEUTRAL;
    case "slot":
      return inp.slotLabel(t.slot);
    case "dynamic":
      return inp.dynamicLabel(t.reads);
    case "derive": {
      const parts = t.inputs
        .map((i) => instantiateTemplate(i, inp))
        .filter((l): l is Label => l !== NEUTRAL);
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
      const condConf = cond === NEUTRAL ? [] : cond.confidentiality;
      if (taken === NEUTRAL) {
        return { confidentiality: condConf, integrity: [] };
      }
      return {
        confidentiality: joinAll([condConf, taken.confidentiality]),
        integrity: taken.integrity,
      };
    }
    case "pick": {
      const choice = instantiateTemplate(t.choice, inp);
      const choiceConf = choice === NEUTRAL ? [] : choice.confidentiality;
      const child = inp.chosen(t.pick);
      const taken = child === undefined
        ? NEUTRAL
        : instantiateTemplate(t.body, child);
      if (taken === NEUTRAL) {
        return { confidentiality: choiceConf, integrity: [] };
      }
      return {
        confidentiality: joinAll([choiceConf, taken.confidentiality]),
        integrity: taken.integrity,
      };
    }
    case "fold": {
      const all = inp.elements(t.collection);
      const covered = t.through === undefined
        ? all
        : all.slice(0, inp.selection(t.through) + 1);
      const parts = covered
        .map((e) => instantiateTemplate(t.body, e))
        .filter((l): l is Label => l !== NEUTRAL);
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

A `fold` with `through` covers the leading elements up to the position
its selector holds. The runtime supplies that position from its own scan
of the predicate cones (section 3.13): the position of the deciding
element, or the collection's length less one when no element decides, so
that the fold covers everything. The value code reports neither the
selection of a `through` selector nor the position that bounds a prefix
fold.

A `const` instantiates to `NEUTRAL`, and every node that takes a part
handles it. A `derive` and a `fold` leave neutral parts out of the join
and of the meet, so a `derive` over one slot and one literal keeps the
slot's hereditary atoms, and a `derive` with no other input has no
inherited integrity. A `select` or a `pick` whose selected branch or
chosen child is neutral yields the confidentiality of the condition or
of the choice and no integrity, and a neutral condition or choice
contributes no clause.

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
  reads consumed, and of its trigger reads (section 3.10).
- A slot contributes the identifier of its whole label, the pointer labels
  of its chain included (section 2.5). A `sampled` slot contributes the
  identifier resolved at the cone's last evaluation.
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
constraint on the inputs of a body or on a write edge.

| Constraint | Today | In the plan |
| --- | --- | --- |
| `requiredIntegrity` on an input path | `verifyInputRequirements` over the reads before the last overlapping write | `I` of each listed input satisfies the patterns, with one coherent witness across them |
| `maxConfidentiality` on an input path | Same function, same read set | `⊔` of `C` over the listed inputs fits the ceiling |
| Write floor on a target | `verifyWriteFloor` on the written value's integrity | `I(template)` of the write edge satisfies the patterns |
| Writer-fit | Persist region of `prepareBoundaryCommitSteps`: the join fits the target's declared confidentiality | `C(template)` of the write edge fits it |
| `writeAuthorizedBy`, `writePolicyAnyOf` | `writeAuthorizedByReason`, `writePolicyAnyOfReason` at prepare | `Body.code` of the writing body is one the policy names |
| UI event integrity contract | `verifyTrustedEventRequirements` (`runtime/runner/src/cfc/prepare.ts`), with provenance recorded by `recordTrustedEventPolicyInputs` (`runtime/runner/src/cfc/ui-contract.ts`) | The event bound to the handler's `event` root satisfies the alternative's `uiContract`, checked per event (below) |
| Egress ceiling of an effect | `verifySinkRequestCeilings` over the whole transaction's consumed label | `C` of the request's templates, joined with what following the references the request holds consumes, as far as the effect serializes or hashes them, fits the ceiling. For each later send of the effect, `C` of everything that send serializes fits the ceiling (section 3.14) |

**What an input constraint lists.** A `requiredIntegrity` or a
`maxConfidentiality` constraint lists the inputs of the body's footprint
whose path overlaps the annotated path, in either prefix direction, which
is the overlap the runtime uses today (`buildWritePrefixBounds`). A body
reads an annotated path in three ways, and the constraint lists each
(`ConstraintInputs`).

- **Through a slot of `Body.reads`.** The constraint lists the slot
  (`slots`), and is evaluated on the slot's label.
- **Through an entry of `Body.handles`,** where the read is dynamic. The
  constraint lists the entry with the annotated path below the handle's
  cell (`handles`). It is evaluated on the journaled reads made through
  the entry whose path overlaps that path: on the label each of those
  reads consumed. The read envelope keeps the label annotations of the
  paths it admits (`footprint-analysis.md` §7.3), so a read through the
  entry is known to be at an annotated path. On a run that made no such
  read the entry contributes nothing, as an attempt with no such read
  contributes nothing today.
- **In a value the instance computed,** an entry of `Body.computed`. The
  constraint lists the entry (`computed`), and is evaluated on the
  entry's template, instantiated.

`requiredIntegrity` requires the patterns of the integrity of each of
these, and `maxConfidentiality` tests the join of the confidentiality of
all of them. A constraint that lists nothing is not emitted: an
annotation on a path the body does not read constrains nothing. Today
the gate quantifies over the journaled reads of the transaction, the
ones made through cells included, so the three forms together are what
it covers.

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
  instantiated from. What a failure does depends on whose write the
  constraint guards (below).
- **Per event** for a UI contract. A write that a `writer` constraint
  admits through an alternative with a `uiContract` is admitted only
  where the event the handler was invoked with satisfies that contract:
  it came from an element under the surface the contract names, with the
  action and the event integrity the contract requires. The check is a
  check on what the handler itself writes, so a failure rejects the
  event's transaction. Whether an event came from the named
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

**What a failed constraint does.** There are two cases.

- **A constraint on what a handler itself writes rejects the event's whole
  transaction.** What a handler itself writes is everything its body
  stages: its write edges, the arguments of the instances it requests, the
  requests of the effects it asks for with their egress ceilings, the
  copied state of the bindings it makes, and the copied parameters of the
  inline patterns it instantiates. A request for an instance whose link
  the body dropped stages nothing (section 3.14), so it has no constraint
  to fail. No part of what the handler asked
  for commits when any part of it is not allowed. The refusal is the
  event's outcome and is reported to the party that delivered the event,
  under the handler's template (section 5.4).
- **A constraint on a derived write drops that write alone.** A derived
  write is a kept output, or a write edge of a cone: a side-write of a
  computation, a path of a child's argument or of an effect's request that
  a cone computes. The dropped write is not staged, its target keeps the
  value and the label that are stored, and the rest of the transaction
  commits. The cone instance that computed it is current, and its output
  is unstored: the runtime holds the value in memory, and a later
  transaction that demands the output stores it from there without an
  evaluation (`execution-and-storage.md` §3.3;
  `scheduler-and-serving-loop.md` §3.5). For a dropped write that happens
  once the verdict can differ (below). Other outputs of the same
  cone commit when their own constraints hold. The value stays available
  to the transaction that computed it: a cone that receives it through an
  `output` edge, and a handler whose state names the output, read the
  current value, and their own labels hold the output's template. A reader
  by address reads what is stored (section 4.6).

A dropped derived write is not an event's outcome, and no party delivered it. It
is reported to the scheduler, which records the refusal with the instance: the
constraint that failed, and the instantiation key of the write's template
(section 4.1, step 2). The same write, to the same address, is not attempted
again while its instantiation key is the same, since the verdict would be the
same, and it is attempted again when the key changes
(`scheduler-and-serving-loop.md` §5.6). The key holds everything a verdict
depends on for every kind of constraint: the labels of the slots the template
reaches, the selections and chosen children, and the labels of the `dynamic`
nodes. A `writerFit` or a `writeFloor` constraint, which lists no input, is
evaluated on the label the key determines, and an input constraint is evaluated
on labels the key holds. The refusal is a fact about labels and selections. It
carries the label section 3.16 gives an inspection of the output's label, and it
is shown only where that label permits.

A cause that is not an event has derived writes only, so a failed
constraint never rejects its transaction whole.

**A conflict.** A commit can conflict with a concurrent commit. A conflict
on a derived write withdraws that write alone, as a failed constraint on
it does: the target keeps what the concurrent commit stored, the output
is unstored, and the rest of the cause's transaction
commits. "The rest" leaves out the writes that used a value or a label the
withdrawn write staged. They are withdrawn with it, because their labels
and verdicts were computed from something that is not stored (sections 4.5
and 4.6). Where the conflict was on something the withdrawn value was
computed from, the change that caused it makes the cone instance stale,
and it is evaluated again. Where the conflict was on the target alone,
the cone instance is current: the runtime holds the value in memory, and
the next transaction that demands the output stores it from there without
an evaluation (section 4.1, step 1). A cone instance whose side-write a
conflict withdrew is evaluated again, so that the write is performed
(`execution-and-storage.md` §3.3). What a conflict on a handler's own
write does to the event is in `scheduler-and-serving-loop.md` §5.5.

**Two deliberate changes.**

- The input gates quantify over the inputs the guarded write's body has
  at the annotated path, its slots, its dynamic reads and its computed
  inputs, instead of over every read of the transaction before the
  write. The set is a subset of today's, so a write is refused less
  often. What this rests on is in section 7.
- The egress ceiling moves from the transaction's whole consumed set to the
  effect's request and the content it holds by reference. §8.9.1.2 allows
  this move and requires it to be stated: "Each such move is an independent
  conformance choice and MUST be stated by the deployment profile." The
  ceiling is also checked on each later send of the effect, in a send
  transaction (section 3.14). A failure there is not a failed constraint
  in the two senses above: it rejects the send transaction, and the
  built-in's result takes the error state.

### 4.5 Order inside a transaction and across a batch

A slot can be bound to an address that the same transaction writes: a
state cell the handler wrote, the target of a side-write, a path of a
child's argument, a kept output of another instance that the same cause
evaluated.

- **Staged labels.** Such a slot resolves to the label staged for that
  address in this transaction, and not to the stored one. A consumer would
  otherwise take the label of the value that was there before, which can be
  looser or tighter than the label of the value it read.
- **Order.** A write is therefore instantiated before every template that
  has a slot bound to its target. In an event's transaction the order is:
  the derived writes instantiated early (below), each before the read
  that needs it and after the staged writes it uses; then the handler's
  write edges; then producers before consumers, in the order the cones
  were evaluated. A derivation transaction has the last part alone.
- **What is instantiated early.** A handler body runs once, so nothing it
  reads, and nothing a value it receives was computed from, may be a
  write that a later check drops. Three groups of derived writes that the
  event's transaction staged before the body are therefore instantiated,
  and their constraints checked, ahead of the handler's write edges.
  - A derived write whose target the body reads by address, through a
    slot of `Body.reads` or through a journaled read. It is instantiated
    before that read returns.
  - A derived write staged at an address that was read by a cone
    instance whose value the handler receives, directly, for a state
    path that names an output, or through any number of `output` edges.
    The handler's template holds that cone instance's template, which
    has a slot bound to the address. It is instantiated before the
    handler's argument is built.
  - Every staged write that one of these uses (below), before it.

  An unstored kept output that carries no refusal, at an address the body
  reads by address, is staged from the value the runtime holds before the
  read and is instantiated early like any other
  (`execution-and-storage.md` §1.3). A write the early check drops is
  unstaged. A cone instance that had read it is stale, and is evaluated
  again before the body, against what is stored (section 4.6).
- **A write instantiated early** is instantiated from the labels stored or
  staged at that time, and the preparation does not instantiate it again
  (`execution-and-storage.md` §1.6). The body can afterward write
  something the cone instance of that write had read. Three things then
  hold.
  - The label staged by the body's write does not enter the early write's
    label. A slot of its template bound to that address stays resolved to
    the label that was there when its value was computed. This is the one
    case in which a slot does not resolve to the label the transaction
    staged last for its address.
  - The early write is not withdrawn. It commits with the event's
    transaction under the label instantiated early.
  - Its cone instance is stale, and the derivation transaction behind the
    batch evaluates it again and stores the result under the labels
    current then.

  This is sound for the label rules. The label that commits is the
  template instantiated over the labels of what the value was computed
  from, which is what the label of any derived write is. The handler's
  template holds that label through the slot or the journaled read, so
  what the handler writes covers what it read. The handler's unit uses
  the early write, and the early write uses nothing the body staged, so
  the relation below has no cycle between the two.
- **A derived write the body overtakes.** A derived write that was staged
  before the body and was not instantiated early, and whose cone instance
  read something the body then wrote, has no label yet when the body
  writes. Instantiating it in the preparation would give a value computed
  from the earlier state the label of the later one, so it is withdrawn
  instead. The rule holds for every derived write of that cone instance:
  a kept output, a side-write, a path of a child's argument, and a path
  of an effect's request. The cone instance is stale, and the derivation
  transaction behind the batch evaluates it again. Where a side-write is
  among the writes withdrawn, the runtime drops what it holds of that
  evaluation, so that the evaluation behind the batch performs the write
  (`execution-and-storage.md` §1.6 and §3.3;
  `scheduler-and-serving-loop.md` §3.5 and §5.2).
- **Across a batch.** Several events are handled in one batch (section
  5.4). A slot bound to an address that an earlier transaction of the batch
  wrote resolves to the label that transaction staged, in the same way.
- **Cycles.** Where side-writes form a cycle, no order instantiates each
  write before its readers. The labels of the addresses written on the
  cycle are then instantiated together: in the first round those addresses
  contribute nothing to one another, and the round is repeated with the
  labels of the round before until no staged label changes. Each round can
  only add confidentiality clauses from the finite set the templates reach
  and can only remove inherited integrity atoms, so the rounds end. The
  result is the least confidentiality that satisfies every template on the
  cycle, and an integrity atom is inherited on the cycle only when every
  input from outside the cycle that the templates reach carries it.
- **What a write uses.** A staged write **uses** another staged write, of
  the same transaction or of an earlier transaction of the batch, when one
  of these holds:
  - a slot of its template, of one of its constraints, or of an egress
    check on it resolved to a label the other write staged, a round of a
    cycle included;
  - its value was computed from a value read at an address the other write
    staged, by a slot, by a journaled read, or by the following of a
    reference;
  - a label-metadata observation that joins its label read a label the
    other write staged;
  - its target exists only through the other write, as a path does below
    a path that write creates.

  The relation is taken transitively. A value that a cone receives through
  an edge of kind `output` from another cone of its instance is not a use:
  the consumer's template holds the producer's template, so its label is
  instantiated from the producer's slots and from no label the producer's
  write staged (section 1.4). The same holds for a value a handler
  receives for a state path that names an output of its instance
  (`Binding.state`). Section 4.6 commits no write that uses a write the
  commit leaves out.

### 4.6 What the commit preparation binds

The runtime verifies a transaction when it prepares the commit, and binds
what it verified in a digest that the commit checks again
([CFC commit preparation](../cfc-commit-preparation.md), "The prepared
digest and the commit-time recheck"). Today the labels it stamps are a
function of the transaction's journal. Under templates they are a function
of the plan and of each instantiation key as well. The preparation
therefore records as decision inputs, and the digest binds:

- the identity of the `CompiledPattern` of every instance the transaction
  evaluated;
- for every template it instantiated, the instantiation key: the slot-free
  hash of the template, the selections and the children a `pick` chose, the
  label identifiers of the slots, the staged ones among them, and the
  labels of the `dynamic` nodes with their trigger reads;
- which derived writes a failed constraint dropped, and which a conflict
  withdrew, so that the digest is over the writes that commit.

The preparation performs the instantiation itself and accepts no label
from a caller, which keeps the property that no caller supplies what the
verifier verifies. A read, a write, or a new decision input after the
preparation invalidates it, as today. The withdrawal of a derived write at
the commit is the one exception, and the rest of this section says why it
needs no second verification.

**Units.** A conflict is found at the commit, after the preparation, and
it withdraws a derived write without rejecting the transaction (section
4.4). The preparation therefore records what it verified per **unit**.

- **What a unit is.** Everything a handler itself stages for one event is one
  unit (section 4.4 lists it). Each derived write is a unit of its own, with the
  stored state of section 2.6 that describes that write alone: its provenance
  record, and for a cached output the other members of its cache entry. Stored
  state that describes several writes is a unit of its own: the bookkeeping of
  an operation, the origin facts of a collection, the record of the instances a
  cone made, with the allocation records of the spaces those instances' requests
  create. The writes computed from such state use that unit. A derived write
  that a failed constraint dropped is a unit that holds the verdict and no
  write. Every write the transaction stages is in exactly one unit.
- **What a unit holds.** Its writes, the instantiation keys of their
  templates, the verdicts of their constraints, what it read from storage,
  and the units it uses (section 4.5).
- **The digest** is computed over the digests of the units that commit,
  with the identities of the compiled patterns and the list of the units
  that were dropped or withdrawn.
- **A dropped write is used by no unit.** It is not staged. A slot bound
  to its target resolves to what is stored, and a cone instance that had
  read the staged value is stale again. In a derivation transaction, and
  before a handler body, it is evaluated again in the same transaction,
  against what is stored. After a handler body it is not evaluated again
  in the event's transaction: the writes it staged there are unstaged
  with the dropped one, and the derivation transaction behind the batch
  evaluates it (`execution-and-storage.md` §1.7;
  `scheduler-and-serving-loop.md` §3.5). A handler body is not run again.
  That is why the early step of section 4.5 covers every derived write
  the body reads by address and every derived write that a cone instance
  read whose value the handler receives: a write the early check drops
  is not what the body reads, and no value the handler receives was
  computed from it.
- **The allocation record** of a space an `inSpace` request creates is a
  write of the unit that makes the request, and commits ahead of that
  unit, in a step of its own. It is the one write that can stay when its
  unit does not commit. Section 3.14 states the exception and bounds it.
- **A withdrawn write takes the units that use it.** When the commit
  withdraws a derived write, it withdraws every unit that uses that
  write's unit, and computes the digest again over the units that remain.
  It instantiates nothing and checks nothing again. The withdrawal is
  recorded as a decision input, as a dropped write is. A dropped write
  among the units withdrawn loses its verdict with them, and its refusal
  is not recorded with the instance (section 4.4), because the verdict was
  reached on a label that is not stored.
- **A handler's unit.** A withdrawal that reaches the unit of a handler's
  own writes withdraws the event's transaction whole. What then becomes
  of the event is in `scheduler-and-serving-loop.md` §5.5.

**Why nothing is verified again.** The value of a unit, its labels and its
verdicts are functions of the plan, of its selections, of what it read
from storage, and of what the units it uses staged. A unit that remains
uses no unit that was left out, so each of those inputs is stored, or
commits with it.

- Its label is the label the preparation would have instantiated had the
  withdrawn writes never been staged, and it covers what the unit's value
  was computed from. No label that commits was instantiated from a label
  that does not.
- The addresses on a cycle of side-writes (section 4.5) use one another,
  so they commit together or not at all.
- A value received through an `output` edge is not a use, and it needs
  none: the reads of the producing cone are reads of the consumer's unit.
  When a conflict is on something the producer read, it is a conflict on
  the consumer as well. When it is on the producer's target alone, the
  consumer's value and label are functions of inputs that did not move.
- What a unit read from storage is checked by the commit as it is today.

The units are an arrangement of the preparation
(`execution-and-storage.md` §1.9). What this document requires of any
arrangement is the property: no write commits whose value, label or
verdict was computed from a value or a label staged by a write that does
not commit. The allocation record of section 3.14 is the one exception.

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
- **The bound.** A cone instance is evaluated at most ten times in one
  transaction. The bound is on a cone instance and not on a cone: an element
  cone has one cone instance per key, and each has its own count. The number is
  a placeholder. It is fixed with the plan version (`Plan.version`), so that a
  client and the server fail the same cone instances. A cone instance that
  failed at the bound keeps its error state and is not evaluated again until one
  of its inputs changes: with the same inputs a later cause would reach the
  bound again. Which cone instances of a cycle fail when the bound is reached
  belongs to `execution-and-storage.md` (§2.7) and
  `scheduler-and-serving-loop.md` (§8.1).
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
  decided by observing the stored value at that path, and its
  confidentiality is that of the slot, which the output's template already
  contains. Where the slot reads as a default, the read has the empty
  integrity, as every read of a default has (section 2.5, "A default
  belongs to the place").
- **The label of an error state** is the label the output would have had: the
  output's template, instantiated with the selections taken up to the failure.
  A failed body contributes its whole footprint: the `reads` slots, the
  computed inputs, and whatever its handles had read. A slot for a read
  through a handle is part of it on a run that threw before the read
  (section 3.1). This is §5.4.1's rule. An error message is
  data computed from the body's inputs and has the same label.
- **Integrity.** An error state carries no inherited integrity: the
  `derive` rule's meet is replaced by the empty set. An error is not a value
  of the kind any upstream claim describes, and under-claiming integrity is
  the fail-safe direction (§8.9.3, staged conformance).
- **Storage.** For a kept output the error state is stored at the output's
  path with that label, like any value. An interim error is not stored.
- **The write edges of a failed cone.** What the target of a write edge
  takes depends on the target.
  - *A path of a child's argument, and a path of an effect's request.*
    These are values the instance passes on, and the cone is their one
    writer. The target takes the error state under the edge's template,
    like a kept output. The child's cones that read the path fail in turn,
    and an effect whose request holds an error state is not requested: its
    result is that error state.
  - *A state cell, a cell reached through a handle, a created cell, an
    anchors document.* These are side-writes to cells that other writers
    share. The write is withdrawn, and the target keeps the value and the
    label it had before the transaction. A state cell that a handler also
    writes does not come to hold an error state because a computation that
    normalizes it failed. A cone that reads the target reads the earlier
    value and does not fail on that account.

  Today a node that throws commits none of its writes, so the second case
  is **equal**. That the write did not happen is visible to readers of the
  target, and section 5.5 lists it.

### 5.3 Propagation stops unless something reads the error

An error state is an ordinary value to the plan. A cone that reads an errored
slot fails in turn, with its own template as the label, and that template
already contains the errored slot. A `select` whose unselected branch is in
an error state is unaffected, because it does not read it. A collection with
one errored element has one errored element: a `map` passes it on per
element, and a `fold` over it fails, since it reads every element.

So a failure reaches exactly the outputs whose template reaches it, and each
carries a label that covers the failure's cause.

### 5.4 Handlers, and events in a batch

Several events are handled in one batch. Each event has a transaction of
its own, and that transaction has two parts.

1. **Before the body.** The stale cones that compute what the handler reads are
   evaluated, so the body sees current values. They include the cones that an
   earlier event of the same batch made stale. What the handler reads is known
   from its record: the slots of `Body.reads`, which for a binding of the
   reactive tier resolve through `Binding.state` to slots and outputs of the
   instance, and the entries of `Body.computed`. A read through a handle of
   `Body.handles` is not known before the body runs. It is made current when it
   is made (`execution-and-storage.md` §1.4; `scheduler-and-serving-loop.md`
   §5.3). A stale cone instance of a loaded instance of the same space that
   writes the address is evaluated first, and its write is instantiated and
   checked before the read returns (section 4.5). Where the writer is in an
   instance of the same space that is not loaded, the scheduler's basis rows
   decide, by ruling (`scheduler-and-serving-loop.md` §10.4). Where they show
   the stored value current, the read returns it and the instance is not loaded
   on account of the read. Where they show it stale, the attempt is withdrawn
   whole, the instance is loaded, and the event is dispatched again under the
   same handling. An attempt is withdrawn in the same way where the writer is an
   invalid materializer, which runs before the event is dispatched again. Where
   that materializer cannot run ahead of the derivation transaction, because a
   cone instance that produces one of its computed inputs performs a side-write,
   the event holds its place in the queue, the batch ends before it, and it is
   handled after the derivation transaction and the materializer have run
   (`scheduler-and-serving-loop.md` §7.2). Where the writer is in an instance
   that is marked as torn down, or in another space, the read returns what is
   stored. It does so as well where nothing stored names the writer and the
   writing instance is not loaded: for a cell written through a handle, and for
   a child's argument document, whose writer is a cone of the parent. The
   runtime cannot tell that such a value is stale. *Assumed,* as question 57 of
   the continuation plan has it for the first of the two. Nothing of a withdrawn
   attempt commits, and nothing is instantiated for it: the handler's label is
   its template over what the attempt that commits read. The two cases change no
   label rule. A read that returns a stored current value joins the label stored
   at the address, as any read of a stored value does. That label is the one the
   writer's last evaluation instantiated, and rows at the heads say that no
   document that evaluation read has changed, in value or in label. A slot of
   `Body.reads` whose writer is in an instance that is not loaded is decided by
   the same rows, before the transaction opens.
2. **The body.** It stages its writes and its requests: instantiations,
   cells, effects, bindings (section 3.14). Its write edges are
   instantiated and their constraints checked, and a failure rejects the
   event's transaction (section 4.4).

The event's transaction covers no other derivation. **Behind the batch,** every
other derivation that the batch's events made stale and that something demands
is evaluated once, in one transaction whose cause is a set of changes: the
writes of the batch's events, with the commits that arrived from storage in the
same cycle, the commit of an effect's completion among them
(`scheduler-and-serving-loop.md` §10.2). It is not evaluated once per event.
What that transaction writes is derived, so a failed constraint there drops one
write and rejects nothing else (section 4.4).

A value computed before a body is a derivation too. A kept output among
them is a derived write of whichever transaction stores it, the event's or
the one behind the batch, which `execution-and-storage.md` decides (§1.6).
A failed constraint on it drops that write and does not reject the event.

What the batch changes for labels:

- **Nothing in what a label is.** Each derived output is instantiated from
  its own slots and selections in the transaction that stores it. Those are
  the slots and selections of the state after the whole batch, which is
  the state that settling after each event would have reached last.
- **Staged labels cross events.** A cone evaluated before a later body can
  read what an earlier event of the batch wrote. Its slots resolve to the
  labels that event's transaction staged (section 4.5).
- **States between two events of a batch are not derived from.** No
  derived output is computed or checked against a state that held only
  between two events of one batch, apart from what a later handler reads.

A handler body that throws aborts its event's transaction, as it does today
(`finalizeFailure` in `runtime/runner/src/scheduler/events.ts`). Its staged
writes and requests are discarded, so no instance, cell, effect or binding
it asked for comes to exist. The other events of the batch are not
affected. The values computed before the body are pure derivations of
state that did not change. The aborted transaction does not store them.
The runtime holds them, and the next transaction that demands them stores
them (section 4.1, step 1).

A failure before a body or behind the batch is a cone failure and follows
section 5.2. If the failed cone is one the handler reads, the handler
receives an error state for that input and fails in turn: the event's
transaction is aborted, as for a body that throws, and it stores neither
the error state nor the other values computed before the body. Where the
handler does not read the failed cone, the error state is stored and the
rest commits.

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
- **A trigger read lost at a restart.** The trigger reads of a `dynamic`
  node are held in memory. After a restart, an evaluation of a body that
  made a sampled read can be caused by a change at an address that it
  does not read again, and the label of that address is then not joined
  (section 3.10). The current scheduler loses the same addresses at a
  restart.
- **A handler run again.** A handler's attempt is withdrawn and the event
  dispatched again when a journaled read reaches an invalid materializer,
  or an address that an instance that is not loaded writes and that the
  basis rows show stale (section 5.4). That delays the event. Whether it
  happens depends on which address the body read, on which instances the
  process holds, and on whether an input of such an instance changed
  since its last evaluation. What the handler reads does not depend on
  it: a read that returns a stored value returns it only where the rows
  show it current.
- **A cone that reads a stale stored value.** In a derivation
  transaction, a journaled read of a body inside a cone whose writer is
  in an instance that is not loaded returns what is stored, also where
  the basis rows show it stale. The instance is then loaded, the writer
  is evaluated, and the reading cone is evaluated again
  (`scheduler-and-serving-loop.md` §4.4). A kept output computed from
  the stale value can be stored meanwhile. Its label joins the label
  stored at the address read, which covers what it was computed from.
  This is the delay of a dynamic read by one evaluation, which a
  computation has today.
- **Rejection.** A constraint that fails on what a handler itself writes
  rejects the event's whole transaction, so that no part of what the
  handler asked for commits when any part of it is not allowed. Every
  target the handler would have written then keeps its previous value,
  which is visible to their readers. Whether a constraint fails is a
  function of slot labels and selections, not of other values, so what the
  rejection reveals is bounded by those. An error state (section 5.2) is
  different: it is a value that passed its checks, and it does not reject
  anything.
- **A dropped derived write.** A constraint that fails on a derived write
  drops that write (section 4.4). Its target keeps the stored value and
  label while the values around it change, which is visible to the
  target's readers. What that reveals is bounded as for a rejection: the
  verdict is a function of slot labels and selections.
- **A derived write withdrawn on a conflict.** A conflict on a derived
  write withdraws that write (section 4.4), with the writes that used what
  it staged (section 4.6), and its target keeps what the concurrent commit
  stored. Whether a commit conflicts depends on when other commits arrive,
  and on no label.
- **An instance torn down.** An instance that a computation no longer
  makes is torn down (section 3.14), which a holder of a link to it can
  see. Whether an evaluation makes an instance is a function of what the
  body read, which the label of the link covers.
- **A child of a plain element that moved.** Where an element body
  instantiates a child, the key of a plain element holds the position
  (section 1.3). An element that moves has a new child, whose state is
  not the state the child at the earlier position had. A reader of the
  row can see that, and whether an element moved depends on the order of
  the other elements, which the row's own label does not hold.
  *Assumed:* accepted (section 8, question 36). The alternative joins the
  collection's `enumeration` into every template that reads such a child,
  which no element result carries today (section 3.6) and which would be
  a further exception to "equal or tighter".
- **A refused send.** A later send of an effect that fails the egress
  check is not made, and the built-in's result takes the error state
  (section 3.14). Whether the check fails is a function of the labels of
  what the send would serialize, and the error state carries their join.
- **A withdrawn side-write.** The side-writes of a failed cone are
  withdrawn (section 5.2), so a reader of the target can see that the
  write did not happen. Whether the cone failed is a function of what the
  cone read. Today a failing node leaves its targets as they were in the
  same way.
- **The batch.** Derivations settle once behind a batch of events. How
  many events a batch holds decides which states are derived from, and it
  depends on arrival times.
- **Cache promotion.** Whether the runtime stores a cone's interim outputs
  is a function of how long the cone takes and how often it is evaluated
  (`execution-and-storage.md`, section 8), and both can depend on data. An
  observer who can list the documents of a space, or time a load, can see
  that a cache exists. No value and no label depends on it.
- **Splitting.** Whether a kept subtree has a document of its own follows
  a rule about size (section 2.3). The same observer can see it, and so
  can a reader of the document that holds the storage link.
- **A link between scope instances.** Whether a kept path of a broader
  scope instance holds a value or a storage link to a narrower scope
  instance follows from the scope the output has at run time (section
  2.3), which can be narrower than the plan's where a slot is bound
  through a link to a document of narrower scope. A reader of the broader
  scope instance can see which it is. It learns that the value is kept
  per user or per session, and nothing of the value, which it reads only
  for its own scope key.
- **An allocation record that stays.** The allocation record of a space
  an `inSpace` request creates commits ahead of the unit that makes the
  request, and stays when that unit does not commit (section 3.14). An
  observer who can list the spaces, or read the record, can then see
  that a request was made whose other writes did not commit. Whether
  they commit depends on when other commits arrive.

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

The room binds the handler in its pattern body, as
`sendMessage = commitSend({ myProfile, messages, threadInfo, joined })`,
and exports the stream. The handler `commitSend` calls `sendInto`, which in
outline:

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
  whose `main` field is the list of message cells shown in the main view
  and whose `places` field holds, per message, how many replies its thread
  has;
- `isEmpty = computed(() => facts.main.length === 0)`;
- `facts.main.map((message) => <FabriChatMessageRow message={message} … />)`,
  which passes `facts.places` to each row as `places`.

Each row, in `message-row.tsx`, derives among others:

- `text = computed(() => bodyText(message.get()))`, where `bodyText` returns
  the body when it is a string and otherwise one of two fixed sentences,
  chosen by whether `authorProfile` is present;
- `isEdited = computed(() => …)`, whose body reads `message.get()` and
  returns `record?.editedAt !== undefined && typeof record.body === "string"`;
- `replies`, read from `places.key(key).get()?.replies` with
  `key = viewKeyOf(message)`, the key of the cell the message link resolves
  to, and `threadLabel`, which is `replies === 1 ? "1 reply" : …`.

### 6.2 The plan for the slice

Slots, written `root path : class`:

```text
s0  argument  messages                 : identity
s1  argument  myProfile                : identity
s2  argument  threadInfo               : identity
e0  event     body                     : value
e1  event     target/value             : value
e2  event     attachments              : enumeration
e3  event     attachments/*            : identity
e4  event     replyTo                  : shape
e5  event     replyTo/thread           : identity
e6  event     replyTo/quotes           : identity
e7  event     replyTo/shownIn          : value
e8  event     threadTitle              : value
b0  binding   myProfile                : identity, resolved
b1  binding   myProfile                : shape
b2  binding   messages                 : identity
b3  binding   threadInfo               : identity
b4  binding   joined                   : identity
m0  element   (root)                   : shape      of collection c1
m1  element   (root)                   : identity
m2  element   body                     : value
m3  element   body                     : shape
m4  element   authorProfile            : shape
m5  element   editedAt                 : shape
m6  element   (root)                   : identity, resolved
```

`b1` is a slot whose path crosses a link: the handler's state holds a link
at `myProfile`, and the slot observes whether the cell it leads to holds a
value. `m2` to `m5` cross the element's link in the same way (section 2.5).

The listing is a slice. It leaves out the `shape` slots that footprint
analysis records at optional positions (`footprint-analysis.md` §12.5).
One is at a data position, `event target`. The others are in place
(`inPlace`), at the positions of the optional handles: among them
`binding myProfile`, `binding joined`, `event replyTo/thread` and
`event replyTo/quotes`. Each of those observes whether the position holds
a handle, and the `identity` slot at the same position is listed. Where
the position holds a handle, the slot in place resolves to the label of
which reference it holds (section 2.5), which that `identity` slot joins
already. All of them are in the footprint of `B0` and join `T_send`. With
FabriChat's labels none changes an instantiated label.

The listings of this section leave out four more things that the rules
of section 3 and of `footprint-analysis.md` give the record of the same
source (`footprint-analysis.md` §12.5 lists the same). None changes
an instantiated label with FabriChat's labels.

- `T_send` has three further `dynamic` nodes of kind `link`, through
  `e3`, `e5` and `e6`. `attachmentsIn` resolves each attachment link, and
  `checkedReply` resolves the reply's `thread` and `quotes` links, each
  on some runs only, so each resolution is journaled (section 3.16).
- `B0` has two further reference edges, at `*/replyTo/thread` and
  `*/replyTo/quotes` of the pushed value. Each holds the handle a
  journaled resolution returned for `e5` or `e6`.
- `B2` reads `titles[key]` on a record, so its computed inputs include
  `titles : enumeration` beside `titles/* : value`, and its `widenings`
  has an entry that names both (`Widening.computed`).
- `m4` is at a position of handle type, so it has `inPlace`, as the
  omitted `shape` slots of `B0` have.

The binding, an entry of `Plan.bindings`:

```text
sendMessage  handler B0
      state  myProfile    slot s1                         link
             messages     slot s0                         link
             threadInfo   slot s2                         link
             joined       the stream of another binding   link
```

The binding is made in the reactive tier, so nothing is copied (section
3.14). Every path of the handler's state is a slot of the instance, and the
handler's `binding` slots resolve to the labels of the slots the binding
names: `b0` and `b1` through `s1`, `b2` through `s0`, `b3` through `s2`.

Bodies:

```text
B0  handler   commitSend
      reads      e0 e1 e2 e3 e4 e5 e6 e7 e8 b0 b1 b2 b3 b4
      handles    h0  slot e3   each attachment
                 h1  slot e5   the reply's thread root
                 h2  slot e6   the quoted message
                 h3  slot b3   threadInfo
      calls      n0  createCell, identified by order
      writes     w0  handle b2  *                 T_send   constraints [k0, k1]
                 w1  handle b2  */authorProfile   passes b0
                 w2  handle b2  */attachments/*   one of e3
                 w3  created n0                   T_send
                 w4  handle b3                    T_send
                 w5  handle b4                    T_send
      envelopes  handle b3  *
B1  function  threadTitles
      reads      s2
      handles    h0  slot s2   threadInfo
B2  function  messageFacts
      reads      s0
      computed   titles/* : value   T_titles
      handles    h0  slot s0   messages
B3  function  bodyText     reads m0 m1 m2 m4
B4  function  viewKeyOf    reads m6
```

What `B0` does with each handle:

- `myProfile` is not in `handles`. `resolvedProfile` opens `sendInto`: it
  resolves the link (`b0`) and tests whether the profile behind it holds a
  value (`b1`). Every run makes both observations, so both are slots.
- each element of `event.attachments` (`h0`): `attachmentsIn` reads the
  file entry behind it, when the event carries attachments;
- `event.replyTo/thread` and `event.replyTo/quotes` (`h1`, `h2`):
  `checkedReply` reads the messages behind them when the event names a
  reply;
- `threadInfo` (`h3`): `threadTitleRecord` reads it under a key computed
  from the thread's root, when the event carries a `threadTitle`;
- `messages` is not read through. `sendInto` pushes onto it (`w0`) and
  passes it to `spaceOf`, by way of `isInRoomOf`, on the runs that check an
  attachment or a reply. The links `spaceOf` follows below the reference
  `b2` on those runs are a `dynamic` node of kind `link`.

Each entry of `handles` has a read envelope, which admits the paths the
helper reads and nothing else of the record behind the handle. Of
`event.replyTo` itself the body observes whether it is set (`e4`), the two
references (`e5`, `e6`), and `shownIn` (`e7`).

The writes of `B0`:

- `w0` is the push. Its target is the list behind the handle `b2`, and the
  constraints are those of the stored element type.
- `w1` and `w2` are paths of the pushed value that hold a reference the
  handler was given (`WriteEdge.reference`). `authorProfile` is what
  `myProfile.resolveAsCell()` returned, which is the reference `b0`
  observes. Each attachment is one of the references at `e3`.
- `w3` is the initial value of the reactions list, a cell the handler
  creates at `n0`. The message's `reactions` field holds the handle of that
  cell, a reference the body created.
- `w4` adds a thread title record to `threadInfo`, and the record itself is
  written through `threadInfo.elementById(key)`, whose target the analysis
  cannot name: the envelope `handle b3 *` covers it.
- `w5` is the event sent on the `joined` stream.

Every `computed` call of the slice meets the promotion criterion of
`language-subset.md` §6.1, so none of them is a body. `facts` is two calls
of authored functions, `B1` and `B2`, bodies of kind `function`, and the
result of `B1` is a computed input of `B2`. `text` is a call of `bodyText`,
which is `B3`. `isEdited` calls nothing but `message.get()`, so it is
expression code with a `select` for its `&&`. `replies` is a call of
`viewKeyOf`, which is `B4`, a dynamic key on `places`, and a `select` for
its `??`.

Templates:

```text
T_send   = derive(by B0)  [ e0 e1 e2 e3 e4 e5 e6 e7 e8 b0 b1 b2 b3 b4
                            dynamic(handle B0.h0)
                            dynamic(handle B0.h1)
                            dynamic(handle B0.h2)
                            dynamic(handle B0.h3)
                            dynamic(link through b2) ]

T_titles = derive(by B1)  [ s2  dynamic(handle B1.h0) ]
T_facts  = derive(by B2)  [ s0  T_titles  dynamic(handle B2.h0) ]

T_empty  = derive(expression) [ T_facts, const ]

c1       = collection  source: output facts.main   membership: T_facts
                       bodyUses: { index: false }

T_text   = derive(by B3)  [ m0 m1 m2 m4 ]
T_isSet  = derive(expression) [ m0 m1 m5 ]
T_edited = select( condition: T_isSet,
                   branches:  [ derive(expression) [ m3 ],
                                T_isSet ] )
T_key    = derive(by B4)  [ m6 ]
T_place  = pick( p0, from: output facts.places, choice: T_key,
                 body: T_facts )
T_repl   = select( condition: T_place, branches: [ T_place, const ] )
T_label  = select( condition: derive(expression) [ T_repl, const ],
                   branches:  [ const,
                                derive(expression) [ const, T_repl ] ] )
```

The elements of `c1` are links to message cells, so each row's key is its
message cell's identity (section 1.3), and a row keeps its cone instances
when the list is reordered or a message is inserted before it.

`facts` is the result of one opaque call, so every path of it has
`T_facts`, `facts.main` and `facts.places` included. `B2` reads its second
argument at the keys it looks up, so its computed input is
`titles/* : value`, with the template of what `B1` returned. `isEmpty` is a
pure expression over `facts.main.length`; its template is the template of
what it reads. `c1` is a collection the instance computed: `m0`, the
element's membership, resolves to `T_facts`, and so does `m1`, the
reference at a position of `facts.main` (section 3.6).

`places.key(key).get()` is a dynamic key on a container the instance computed
(section 3.18). Its producer is the opaque call `B2`, so the chosen child has
`T_facts` whichever key is chosen, and the key adds `T_key`. `p0` is the pick's
choice point, an entry of `Plan.picks` with `chosenBy: "valueCode"`: the value
code reports the key each row chose. `T_repl` leaves out the guard on a missing
key, which is one more `select` on `T_key`.

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

The stored `authorProfile` link carries the label of `b0`, the pointer
labels of the links from the handler's state to the profile cell, and
nothing from the event. An attachment link carries its own label plus the
handler's template as the label of having been chosen. `body`, `sentAt` and
`reactions` are required by the message schema, so their existence is
constant.

Kept outputs in the slice: the room's `messages` output (from `facts.list`),
and the rendered tree under `[UI]`, which holds the empty-state branch and
each row's text, edited mark and thread label. The result of `B1`,
`facts.entries`, `facts.places`, the row's key, `replies`, and the
conditions of `T_edited` and `T_label` are interim.

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

Both guard what the handler itself writes, so a failure of either rejects
the event's transaction (section 4.4).

In the room's rendered tree the composer is a submit input inside an element
that carries the surface's pattern and integrity names, and it binds
`commitComposerSend`, which the policy also names. The compiler can verify
that such an element exists for each handler the pattern binds to a control,
and it warns where none does (section 4.4). `commitSend` itself is bound to
the exported `sendMessage` stream, whose events come from other patterns, so
for it the check is per event only.

`sendInto` creates the reactions list with a cell constructor. That is the
`createCell` site `n0` of `B0`, identified by the handling and its ordinal
(section 1.3). The list's initial value is the write edge `w3`, with target
`created`. The list's existence and the handle carry `T_send`, and the
message's `reactions` field is a reference write of that handle.

`sendInto` has four `throw` statements, and the helpers it calls,
`attachmentsIn`, `checkedReply` and `threadTitleRecord`, have twelve more
(`patterns/system/fabrichat/room-records.tsx`). Each is a handler failure
in the sense of section 5.4: nothing is written, and the outcome's label is
`T_send` instantiated over what had been read. The first throw, for a
missing profile, happens before the event is read, and its outcome still
carries the whole static footprint: an opaque body's label does not depend
on how far it got. For the event slots that equals today, where the
argument is materialized before the body runs. The second exception of
section 3.1 does not arise here: the one read through a handle that is a
slot, `b1`, is made by the first statement, before any throw.

### 6.4 Instantiated labels

Write `L(x)` for the label of slot `x`, and `D(h)` for the join of what the
journaled reads through handle `h` consumed. `C(b0..b4)` are the labels of
the slots the binding names, `s0` to `s2`, with the pointer labels of the
links crossed. `C(facts)` stands in for `C(m0)` and `C(m1)`, which resolve
to `T_facts`.

| Output | Instantiated confidentiality | Instantiated integrity |
| --- | --- | --- |
| New message (computed fields) | `C(e0..e8) ⊔ C(b0..b4) ⊔ C(D(attachments/*)) ⊔ C(D(replyTo/thread)) ⊔ C(D(replyTo/quotes)) ⊔ C(D(threadInfo)) ⊔ C(D(links below messages))`, and what the journaled resolutions through `e3`, `e5` and `e6` consumed, which the listing of section 6.2 leaves out | Declared authorship atom; `⊓` over the same inputs; `TransformedBy(commitSend)` when the join is not empty |
| `facts`, every path | `C(s0) ⊔ C(s2) ⊔ C(D(messages)) ⊔ C(D(threadInfo))` | `⊓` over the same; `TransformedBy(messageFacts)` |
| `isEmpty` | Same as `facts` | `⊓` over the same; `TransformedBy(pattern)` |
| Row `text` | `C(facts) ⊔ C(m2) ⊔ C(m4)` | `⊓` over the same; `TransformedBy(bodyText)` |
| Row `isEdited` | `C(facts) ⊔ C(m5)`, and `C(m3)` as well when `editedAt` is present | from the selected branch: `⊓` over its inputs; `TransformedBy(pattern)` |
| Row `threadLabel` | `C(facts) ⊔ C(m6)` | from the selected branch |

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
| Row `threadLabel` | Its own node; reads `replies`, another node's document, whose label is the join of a read of one entry of `facts.places` and of the message link | The label of `facts` and of the row's key, through the `select`s |

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
- A send is one event. Its transaction holds the handler's writes. Behind
  the batch the event is in, one transaction evaluates `facts`, `isEmpty`
  if its value changed, and one new row. Several sends in one batch
  evaluate `facts` once. The other rows are not evaluated. Their cones
  are keyed by element identity, and the one that reads `facts.places`
  reaches it only through the pick `p0`, so it is stale only when the
  entry its row chose changed (section 3.18).
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

There is consequently no fallback label. The **cone-level join** is the
join over every slot of a cone and, since a cone also receives outputs of
other cones (section 1.4), over every slot of the cones those outputs come
from, transitively. It is not a mode of operation. It keeps two uses:

- **As the bound on a compiler defect.** Section 7.3's cone narrowing means
  a miscompiled cone can at worst give an output the data of its own cone
  and of the cones it receives outputs from, so the cone-level join is what
  the output's label should have been at most. An audit of the compiler can
  reason per cone and its incoming edges.
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
  slots in `Cone.slots` and the outputs its incoming edges name. A cone
  cannot compute from data it was not given.
- **Body narrowing.** The runtime builds a sandboxed body's argument from
  `Body.reads` and from the entries of `Body.computed`, to which it narrows
  the captured values a cone passes. A footprint that omits a slot or an
  entry starves the body. Data outside a body's footprint stays
  confidential from the body however wrong the analysis is.
- **Handles.** A body is handed a handle only for a position its record
  names, or one the envelope of a listed handle admits as a handle. A read
  through a handle returns the slots the record lists for it, or is
  journaled under the handle's envelope, and a handle with neither cannot
  be read through. A write through a handle is refused unless an
  edge or an envelope of the body covers it (sections 3.9 and 3.11).
- **Writes and calls.** A body writes only the paths, and makes only the
  calls, its `Body` record lists: the runtime refuses a write or a call
  the record does not list. A record that lists too little fails closed.
- **Element locality of collection operations.** The runtime evaluates an
  element body once per key with that element's slots, and performs the
  filtering, concatenation, folding and choosing itself (sections 3.6 to
  3.8, 3.17, 3.18). No emitted code sees two elements of a mapped collection
  at once, unless the body captures the collection by name, and then the
  collection is a slot of its own in the body's template (section 3.6).
- **References a body passes on.** That a returned reference is one the body
  was given is checked by identity (section 3.9). The same check covers a
  container that a binding made in a body holds by reference (section
  3.14).
- **Dynamic reads.** Reads through handles and links, of access lists, and
  of label metadata at targets no slot names, are journaled by the runtime,
  as they are today.
- **Slot resolution.** The runtime resolves a slot's path, links included,
  and joins the pointer labels of the chain (section 2.5). Emitted code
  does not follow a link.
- **The egress check.** The runtime follows the references a request
  holds, in the operands that are sent and in the ones that only enter the
  request hash, and checks the ceiling on what it finds. It checks the
  ceiling again on each later send of the effect, on what that send
  serializes, and does not make a send that fails (section 3.14).
- **What commits.** The runtime commits no write whose value, label or
  verdict was computed from something staged by a write it leaves out,
  an allocation record excepted (section 4.6).
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
  templates name `B`, and that the value a cone passes to a body for a
  computed input is the value the input's template describes. The runtime
  narrows such a value to the entries of `Body.computed`, so a defect here
  can at worst give the body data of the cone that called it, which the
  cone-level join bounds.
- **Gating sets.** That a guarded write depends only on the inputs its
  constraint lists (section 4.4). The reads through a listed handle are
  journaled by the runtime; that the constraint lists every slot, handle
  and computed input at the annotated path is the compiler's claim.
- **That the record is the author's.** The runtime holds a body to the
  writes and calls its record lists (section 7.3). That those are the
  writes and calls the author's source makes, and no others, is the
  compiler's claim.
- **Static reads through handles.** That a read through a handle which the
  record makes a slot is made by every run that returns normally. A defect
  here puts a label on runs that did not make the read, which is wider and
  not narrower.

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
  expects equal or tighter labels everywhere except in the three cases of
  section 3.1: for collection indexes it expects the wider membership label
  of section 3.17, for a failed body it expects the labels of the
  body's static reads through handles, including the ones the run did not
  reach, and for what an element body stores once per element key it
  expects the join over the positions that hold the key (section 2.6).

## 8. Open questions

The project owner has decided the following, and the sections above state the
outcomes: equal plain values share their cone instances and never a state
cell, and a handler bound over them shares one stream (1.3); a per-element
body over plain values that instantiates a child has the position in its
key (1.3); the prefix rule (3.13); `some`, `every` and `find` as operations
(3.13); the wider collection-index label (3.17); a failed constraint on a
handler's own write rejects the event's transaction, and one on a derived write
drops that write (4.4); several events are handled in one batch (5.4); the keep
set is stored in several documents (2.3); a static read through a handle carries
its label on a run that throws before it (3.1); what an element body stores
once per element key carries the join over the positions that hold the key,
the third exception to "equal or tighter", to be revisited (2.6, 3.1); a
conditional read through a handle stays dynamic (2.5, 3.9); a tie in `minBy`,
`maxBy` and a keyed lookup goes to the first position in source order (3.8,
3.18); a child replaced under the same
name (3.15); the identifier of an `inSpace` instance known at the request, and
the identifier of a space the request creates obtained and recorded in a step
that commits before the step in the foreign space (3.14); salted value-derived
identifiers, which a client cannot derive (1.3); a handling identified by its
receipt (1.3); an explicit cause in a handler names the same thing across
events, with the existence label fixed at first creation (1.3, 3.14); a `lift`
or a `computed` may instantiate a pattern, which may request effects, the
instance is named by the site and an ordinal or by an explicit cause, and the
computation requests no effect itself (3.14); the argument a model supplies to
a pattern closure used as a tool carries the label of the model's output, and
the result the label of the instance's own result (3.15); the egress ceiling is
checked again on each later send of an effect, and a refused send gives the
result the error state (3.14); a handler's effect that is pending at a restart
is requested again at activation, with the ceiling checked on the content as
it is then (3.14); what a handler binding holds (3.14); a conflict on a
derived write withdraws that write (4.4); the bound of ten evaluations of a cone
instance in one transaction (5.2); a change of demand is a cause (Notation);
handler factories bindable as values (3.21); the accumulator of `reduce` is a
data type, which `language-subset.md` §4.4.1 requires (3.13); an event is routed
to an instance that is not loaded through a stream index (2.6); a read of a cell
whose writer is in an instance that is not loaded returns the stored value where
the basis rows show it current, and loads the instance only where they show it
stale (5.4); a default belongs to the stored place, and a reader bound by
reference reads it through the schema the link holds (2.5); a read of a
default carries no integrity (2.5, 5.2).

What remains is for the project owner, the sibling documents, the
specification change, or the prototype. Each entry states the assumption
this document made.

1. **How fine footprint analysis is for computed values.** Section 3.9
   gives a body's computed result paths one template and refines only
   references and required paths. `footprint-analysis.md` §4.1 settles it
   that way: one template per body, which equals today's label. A template
   per computed path would be a further claim under section 7.4, and unlike
   the reference rules the runtime could not verify it.
2. **References reached through data.** Answered: section 3.9 ("A
   reference found through a dynamic read") gives a reference the body
   found by a dynamic read through a handle no `reference` member and the
   `derive` template, at a result path, a written path and a bound path
   alike, and `footprint-analysis.md` §3.8, §6.2 and §8.5 record it so.
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
9. **Where provenance and origins are stored.** Answered:
   `execution-and-storage.md` §7.2 and §7.3 say where, and section 2.6 here
   gives their labels.
10. **A record in a template literal.** Section 3.19 gives a record
    substitution a `value` slot over its subtree. If the language renders a
    record as JavaScript does, only its `shape` is observed, and the slot can
    be narrower.
11. **An inline record in a stateful element body.** Section 1.3 makes it a
    compile error to declare a state cell over plain values without the
    index, and assumes that where the compiler cannot tell (a record-typed
    input) an inline element fails its cone instances at run time.
    `language-subset.md`
    §4.4.1 has the static rule and its diagnostic
    (`collection:shared-element-state`): it decides "plain value" from the
    element type and from where the collection comes from, and treats an
    object-typed element of a list read from an input or a cell as identified
    by its cell. The run-time failure covers the inline record that rule
    cannot see. A body that binds a handler and declares no state cell is
    accepted by ruling, so the diagnostic and the run-time failure concern
    the state cell alone.
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
16. **The label metadata of a label that depends on a value.** The label a
    `select`, a `pick` or a prefix `fold` instantiates to is a function of
    a condition, a choice or a match position. Reading the stored label of
    such a path then reveals something of that value. Section 3.16 joins
    the conditions into the label of an inspection inside the instance.
    For a reader in another instance, which reads the stored label
    metadata of the path, no rule says the same. *Assumed:* the
    label-metadata entry the runtime stores for such a path carries the
    join section 3.16 gives. Section 2.6 does not rely on it: a provenance
    record carries the output's own label.
17. **A verifier read whose result a pattern sees.** `resultOwnerOf` reads a
    back-link as a verifier read, which joins no label, returns what it
    found to the caller, and reruns the caller when the back-link changes
    (section 3.16). §8.2.6 (`08-02-pass-through-via-references.md`) says a
    verification result "exposed to the handler or another observer" is
    "an observation with appropriate labels", and §8.9.2 has a rerun join
    the label of the read that scheduled it. *Assumed:* the back-link is
    unlabeled structure that setup writes, and reading it joins nothing,
    neither as a read nor as a trigger read, as today. The specification
    change records the choice as open.
18. **Names with an ordinal.** Section 1.3 tells two declarations of one
    name apart by their order among declarations of that name. Adding one
    before another renames the later ones, and state stored under them is
    not found again. *Assumed:* accepted. The prototype measures how many
    declarations of the corpus take an ordinal.
19. **To `execution-and-storage.md`.** Section 2.3 leaves to it which
    subtrees get a part document, how one is identified, how a storage
    link is told from a reference in what is stored, and what a reader of
    a part demands. Section 5.4 leaves to it which transaction stores a
    kept output that was computed before a handler body, and whether a
    stale cone is evaluated at a read through a handle. Section 3.11
    leaves to it, with `scheduler-and-serving-loop.md`, how a
    materializer's transaction obtains its computed inputs. Met: its
    §4.10 has the part documents, its §1.6 the kept output computed before
    a body, its §1.4 and §2.4 the read through a handle, and its §6.7 the
    computed inputs of a materializer. Its requests 41 and 42 are answered
    in sections 4.6 and 2.3 here, and its request 24 in section 2.6. Its
    requests 49 to 51 are answered here: the key sets of the cache
    document and of the instances document carry the collection's
    membership label (section 2.6); a derived write that a handler body
    reads by address is instantiated ahead of the handler's write edges
    and not again (section 4.5); and the join over the positions that
    hold a key covers everything an element cone stores once per key
    (section 2.6). Its §4.10 derives the identifier of a
    part document under the secret of the space for every key, its §1.6
    has the early instantiation, and its §6 stores the state of an
    operation in an element body in one document per key. Its §2.8
    stages the result document and the argument of an instance a
    computation makes whether or not the body keeps the link, which
    section 3.14 states as well. Three further things are met:
    - the units of its §1.9 include the stored state of section 2.6 and a
      dropped write, and what a unit uses is as section 4.5 lists it;
    - the binding state document of a handler factory value bound in a
      function body holds the factory's content address under the label
      of which factory it is, instantiated by the transaction that makes
      the binding (its §4.7; section 3.21 here, where the label is an
      assumption);
    - the allocation record of an anonymous `inSpace` target is named by
      the request's own identifier, which is not the identifier of the
      instance where the request has `root: true` (its §5.6; section 3.14
      here).
20. **To `scheduler-and-serving-loop.md`.** Met, item by item, in the
    sections of that document named in parentheses. It watches the chain
    of a slot and of a `resolved` slot (§3.2). It leaves a `sampled` read
    out of what makes a cone stale (§3.1). It makes a cone stale when the
    label stored at a path its `dynamic` node of kind `labelMetadata`
    observed changes (§3.4). It reports a change of a space's deletion
    answer at the address of that space's access list (§3.4). It runs an
    effect's request transaction again when content behind a reference of
    the request changes (§6.2). It decides what waits for a materializer
    whose envelope is a creation site (§7.2). It finds, from bound
    addresses, the cones that read a cell written through a handle the
    instance computed, for which the plan has no edge (§2.6). And it says
    what becomes of an event when a withdrawal reaches the unit of its
    handler's own writes (§5.5). Its open questions 31 and 32 are answered
    in sections 3.10 and 4.4 here. Three further things are met:
    - a row of the stream index and a basis row are shown, where the
      runtime shows one at all, under the labels section 2.6 gives them
      (its §5.1 and §10.4). Those labels are an assumption of section
      2.6;
    - the trigger reads lost at a restart are an accepted residual for a
      body that makes a sampled read (its §3.4; section 3.10 here, and
      question 29, which is the owner's);
    - its §9.4 names the allocation record of an anonymous `inSpace`
      target by the request's own identifier, as section 3.14 does.
21. **To `builtin-inventory.md`.** Section 3.14 follows the references of
    an effect's request as far as the built-in serializes, and leaves out
    an operand the inventory declares a reference. Met: the entry of each
    effectful built-in has a "Request operands" paragraph, which says
    which operands are references, how deep the others are serialized, and
    which enter the request hash without being sent. Section 3.14 follows
    the last kind as well, as that document assumes.
22. **To `footprint-analysis.md`.** It decides when an observation of a
    resolved reference is a slot (section 2.5), which its §7.1 does under
    the conditions of its §7.2. It fills `Widening.slots`,
    `Widening.computed` and `Widening.handle`, and emits a `WriteEdge` with
    `reference` for a path of a written value that holds a reference the
    body was given. This document gives a form to each thing its request
    16 lists, and the analysis has to emit them:
    - a `shape` slot with `inPlace` for a test of whether a handle is
      present (section 2.5);
    - `Widening.computed` for a widening on a computed input;
    - a `handle` target with `resolved` for a write through
      `resolveAsCell()`, naming the `identity` slot the body has at the
      handle's position (section 3.11);
    - for a handle found by a dynamic read, no entry of `handles`, an
      envelope of the first handle that admits the position as a handle,
      and a write envelope whose slot is in no `reads` (sections 3.9 and
      3.11);
    - a `Child` whose callee is a `Closure` for an inline pattern
      instantiated in a body (section 3.15);
    - plain `identity` slots for `equalLinks` (section 3.16);
    - an entry of `handles` that names an `instantiate` site, for a read
      through the link of an instance a computation made (section 3.9).

    For a binding made in a body it records `capture` and `reference` per
    state path, and `copy` for a path that is a reference on some runs
    only (section 3.14).

    Seven further forms follow from sections 1.1, 3.9, 3.14 and 4.4:
    - `oneOf`, and never `passes`, for a reference taken from an entry
      whose path has a `*` (section 3.9);
    - no `reference`, the body's template, and for a bound container
      `capture: "link"`, for a reference found by a dynamic read; and an
      envelope, not an edge, for a write through a handle below a hop
      that is not a static read (sections 3.9 and 3.11);
    - an entry of `handles` whose `handle` is `{ call }` for a read
      through what a `createCell` site with an explicit cause, or an
      `instantiate` site with a tag, returns (section 3.9);
    - `stateCell` on a `createCell` site whose cause is a constant or
      the element key, a `StateCell` for it, and a `WriteEdge` with
      target `state` for its writes (section 3.14);
    - a `value` entry, over the subtree for a container, for a value of
      an `inSpace` request (section 3.14);
    - the members `handles` and `computed` of an input constraint, for
      an annotated path the body reads through an entry of
      `Body.handles` or in a computed input, and a read envelope that
      keeps the label annotations of the paths it admits (section 4.4);
    - the `enumeration` entry of the keyed container in
      `Widening.slots` and `Widening.computed` (section 1.1).

    Four further forms are for it to emit or to state:
    - a reference, a write target, a write envelope, and the operand of a
      journaled resolution or of an access-list read name an `identity`
      entry of `Body.computed` where the handle or the container reached
      the body in a value the instance computed (`GivenReference`,
      `ComputedReference`; sections 3.9 and 3.11);
    - no class is recorded for a copied path of `Binding.state` or of
      `Closure.params`: the runtime narrows the copy by the handler's
      `binding` slots, or by the inline pattern's `params` slots, as its
      §8.5 and §8.1 assume (sections 3.14 and 3.15);
    - a `shape` slot at a position of reference type has `inPlace`, as one
      at a position of handle type has (section 2.5);
    - a write edge that names its handle by `computed` is a static
      side-write, and its §6.2 and §6.3 have to say so (section 3.11).

    Its request 20 lists five places that named a slot only. Each has a
    form for a body used with the input bound to a value the instance
    computed:
    - `Child.callee` of kind `factory`, `Binding.handler` of kind
      `factory`, and the cell of a `SpaceRequest` target of kind `spaceOf`
      are a `GivenReference`, so each names the `identity` entry of
      `Body.computed` as `{ computed }` (sections 3.15, 3.21 and 3.14);
    - a `RequestValue` that is one projection of such an input is
      recorded as `body`, and the record has no form that names the entry
      (section 3.14);
    - a `handle` envelope for a handle found by a read through a handle
      from a computed input names the first handle's entry as `computed`
      and holds the position of the found handle in `found`. Its `path`
      is below the cell the found handle links to, and not a path from
      the first handle's cell that crosses the link (section 3.11).
23. **The captures of an inline pattern instantiated in a function body.**
    Section 3.15 binds them per path as the ruling binds the state of a
    handler in a function body: a cell handle and a stored container stay
    links, a scalar and a computed container are copied. The owner ruled
    on bindings and not on these captures. *Assumed:* the same rule. A
    copy of a stored container would read the container in the
    instantiating body, which the reference rule avoids for the argument
    of the same call.
24. **What a pattern closure of the reactive tier copies.** Section 3.15
    copies a captured data value into the factory value, where a handler
    binding of the reactive tier copies nothing (section 3.14). *Assumed:*
    the closure rule stands. A factory value can be stored and called in
    another instance, which has no slot of the instance that wrote it.
25. **`.for(tag)` in a handler.** Not open: it is listed with the settled
    outcomes above. The entry keeps its number.
26. **The modifiers of an instance made in a `lift` or a `computed`.**
    How such an instance is named, and that the computation requests no
    effect itself, are listed with the settled outcomes above. *Assumed:*
    the modifiers `asScope` and `inSpace` apply as in a handler, and the
    allocation of an anonymous space such an instance creates is recorded
    under the request's own identifier, as in a handler (section 3.14).
27. **What is stored once per element key, where positions differ in
    label.** Not open: it is listed with the settled outcomes above, as the
    third exception of section 3.1, to be revisited. The entry keeps its
    number.
28. **A withdrawn write and the writes that used it.** The ruling has a
    conflict on a derived write withdraw that write alone. Section 4.6
    withdraws with it the writes of the transaction that used a value or
    a label it staged, because their labels and verdicts were computed
    from something that is not stored, and nothing is verified again
    after the preparation. *Assumed:* the ruling admits this. A write that
    used nothing of the withdrawn one commits. The alternative is to
    evaluate and verify the dependent writes again at the commit, against
    what the concurrent commit stored.
29. **Trigger reads lost at a restart.** The trigger reads of a `dynamic`
    node are held in memory and are lost with the process. Section 3.10
    shows that the evaluation the scheduler then causes joins every label
    its value depends on, with one exception: a body that makes a sampled
    read can be evaluated because of a change at an address that it does
    not read again, and the label of that address is not joined. That
    reveals that the address changed, to a reader of the output. The
    current scheduler has the same residual. *Assumed:* accepted, and
    listed in section 5.5. The alternative stores the trigger reads of a
    cone instance whose last evaluation made a sampled read, with its
    basis rows, and joins them at the first evaluation after a restart.
30. **An explicit cause is not salted.** A value-derived element key is
    salted before it enters an identifier, and a cause a body gives to
    `createCell` or with `.for(...)` is not (section 1.3). A reader of a
    link to what the body created is cleared for the body's template,
    which covers the cause. An observer who sees identifiers without
    reading a link, such as one who can list the documents of a space,
    can test a guess of a low-entropy cause. *Assumed:* unsalted, as
    today, so that a client can derive the identifier. Salting it would
    close that and would make such a cell or instance one a client cannot
    name before the server stores a link, as a binding with a copied path
    is.
31. **`.for(cause)` in the reactive tier.** Section 1.3 has `X.for(cause)`
    and `h.for(cause)` take a string literal in the reactive tier, which
    takes the place of the declaration's name, and leaves a cause that is
    data to function bodies. *Assumed.* A cause that is data would make
    the name of a `StateCell` a run-time value, which the record has no
    form for, and per-element state is named by the element key without
    it. The alternative gives `StateCell` a cause that is a slot or a
    template, with the label rule a cell created under a computed cause
    has in a function body.
32. **The allocation record commits ahead of its unit.** The ruling has
    the allocation of a created space recorded in a step that commits
    before the step in the foreign space. The record therefore stays
    when the unit that made the request does not commit, which is an
    exception to the property of section 4.6. *Assumed:* the exception
    is accepted, and the record's label is instantiated from stored
    labels only, in the sense section 3.14 gives: a staged label is
    followed down to the stored labels, event labels and journaled reads
    it was instantiated from, so that the record's label does not depend
    on whether a staged write commits. The alternative holds the request
    back until every write it used has committed, which costs a
    transaction and delays the instance.
33. **The pending-effect row and the back-link of a handler's effect.**
    Section 2.6 gives the row the label of the pending mark, and has the
    back-link from the operation's state document to the requesting
    instance join no label, as the `result` back-link joins none
    (question 17). *Assumed.*
34. **A state cell in an element body that instantiates a child.** The
    ruling makes a state cell over plain values a compile error where the
    body does not use the index. Where the body instantiates a child, the
    key of a plain element holds the position without the index being
    used, so the state is per position. *Assumed:* the body is accepted
    (section 1.3). `language-subset.md` §4.4.1 has to leave such a body
    out of `collection:shared-element-state`. The alternative keeps the
    error as worded and has the author use the index.
35. **The element slots of a handler whose stream several positions
    share.** A handler bound in an element body over plain values has one
    stream per key, and an event names no position. *Assumed:* an element
    slot of the handler's state resolves to the join over the positions
    that hold the key, under the ruling on what is stored once per element
    key (sections 1.3 and 2.6). That ruling lists what is stored, and this
    slot is resolved when an event arrives and is not stored.
36. **The child of a plain element that moved.** A plain element of a
    body that instantiates a child has the position in its key, so a move
    gives it a new child with the state of the new key. A reader of the
    row can see that, and whether the element moved depends on the order
    of the other elements. *Assumed:* accepted as a residual (section
    5.5), and the element template does not join the collection's
    `enumeration` on that account. The alternative joins it into every
    template that reads such a child, which would be a fourth exception
    to "equal or tighter".
37. **Which instantiations put the position in the key.** The ruling
    names a per-element body that instantiates a child. *Assumed:* that
    is a factory value called in the reactive tier of the body, and also a
    pattern that a `lift` or a `computed` written in the body
    instantiates, because its instances are named through the element key
    as well; an instance a handler requests does not count, and neither
    does a statically resolved pattern compiled into the body; and where
    element bodies nest, the position joins the key at every enclosing
    level at which the element is a plain value (section 1.3).
    Under the narrower reading, two equal plain elements share the
    instances a computation in the body makes, and the arguments of those
    instances carry the join of section 2.6.
38. **The label of a refused send.** Section 3.14 gives the error state
    of a built-in whose later send was refused the join of the request's
    joined label, the labels of what was sent and received before, and
    the label the refused check was evaluated on. The ruling says the
    result takes the error state and names no label. *Assumed.*
39. **The argument of an instance a later event names.** By ruling, an
    instantiation with `.for(tag)` in a handler names the same instance
    on every event, and a later event creates nothing. The ruling does
    not say whether the later event writes the argument it passes.
    *Assumed:* it does not. The request returns the link, and the
    instance keeps the argument the creating event wrote, as a cell
    created under an explicit cause keeps its initial value (sections
    1.3 and 3.14). The alternative writes the argument on every event,
    as an evaluation of a `lift` or a `computed` does for an instance it
    names again. A handler that has to change what such an instance
    reads passes a cell in the argument and writes the cell.
40. **The label of a database declaration's state document.** Section
    3.14 gives a `sqliteDatabase` declaration no label rule of its own.
    *Assumed:* its state document, which holds the handle, carries the
    label section 2.6 gives the bookkeeping of an operation, which is
    empty for an `input` of `const`. The `owner` is a principal the
    runtime attests (section 3.16), and the `rev` counts the writes made
    through the handle. `execution-and-storage.md` §6.8 stores the
    document on this assumption.
41. **The integrity of a default.** Not open: ruled, and section 2.5
    states it. A read of a default carries the empty integrity, whether
    the default is that of the place's declaration, of a link's schema,
    or of the slot's own schema. The entry keeps its number because
    other documents cite the entries around it by number.
42. **A write through a handle to an output of the instance** (from
    `language-subset.md` §13, question 28). A handler bound in the
    reactive tier, a `lift` result, or a pattern compiled into the
    enclosing instance can declare a handle that writes at a path that
    resolves to a value the instance computes. *Assumed:* the runtime
    refuses the write (section 3.11). The alternative lets the write land
    at the path of a kept output, where the next evaluation of the
    output's cone replaces it, as a write to a child's argument path is
    replaced (section 3.15). It needs the output kept wherever such a
    handle names it, a rule for the label memoized for the output
    (sections 4.1 and 4.3), and a `WriteEdge` target that names an output from
    another body. Today the write is understood to land and to be
    replaced by the node's next run. The prototype has to count the
    arguments that name a computed value where a writable handle is
    declared.
43. **The integrity of a slot that reads an object with a defaulted
    part.** By ruling, the defaulted part of a stored object has the
    empty integrity and not the claims of the object (section 2.5). The
    ruling does not say what a `value` slot bound at the object has,
    which reads the stored properties and the defaulted one together.
    *Assumed:* the meet over the parts read, which is empty. The
    alternative keeps a label per path below the slot, so that a
    template that projects a stored property of the slot keeps that
    property's claims; `footprint-analysis.md` would then have to
    record such a projection as a slot of its own.
