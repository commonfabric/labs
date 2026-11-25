/**
 * A minimal executor of a compiled plan and its value code, as
 * `docs/specs/compiled-pattern-language/execution-and-storage.md` (ES)
 * describes a run: it instantiates the plan, evaluates its cones to a
 * settled state, stores the result in documents held in memory, evaluates
 * the body of an element construct once per element key, and handles
 * a batch of events, each in a transaction of its own, with one
 * derivation transaction behind the batch
 * (`docs/specs/compiled-pattern-language/scheduler-and-serving-loop.md`,
 * SS, §5).
 *
 * It computes values and nothing else. It instantiates no label, checks
 * no constraint of a plan, and persists nothing. A request of an effect
 * leaves for no network: it is held until a test delivers its completion.
 * `SPEC-NOTES.md` (notes 281 on, and 479 on for transactions, error
 * states and effects) lists what it needed that the plan and the
 * documents do not give.
 */
import {
  debugStr,
  deepFreeze,
  type FabricValue,
  toCompactDebugString,
  toIndentedDebugString,
} from "@commonfabric/data-model";

import {
  argumentOf,
  canonical,
  copyOfData,
  declaredMembers,
  type ElementPart,
  type ErrorState,
  errorState,
  type Handed,
  identifierOf,
  isDataPrimitive,
  isErrorState,
  isKeySegment,
  isLink,
  isStream,
  isStreamSchema,
  keyFieldsOf,
  type KeyOp,
  keySegment,
  keysOfParts,
  linkedSchema,
  markerOf,
  memberKey,
  membersInOrder,
  type Name,
  OUTPUT,
  type Position,
  type ReadThrough,
  recordOfKey,
  Ref,
  rekeyed,
  sameStored,
  type Schema,
  schemaBelow,
  spliceIn,
  Store,
  StreamMarker,
  streamOf,
  type StreamPosition,
  StreamRef,
  textOf,
  type Undo,
  withDefaults,
} from "./store.ts";
import type { PartsOptions, Sealed } from "./parts.ts";
import { InputsDigests } from "./inputs-digest.ts";
import {
  type Address,
  type FoldElements,
  InputsTable,
  isUniformBody,
  type NamedOutputInputs,
  type Observed,
  type PlanInputs,
  type PlanRecord,
  type PlanWrite,
  type Reached,
  reachedBy,
  type SlotBinding,
  type SlotBindings,
  type Template,
} from "./plan-write.ts";
import { freezeModuleData, hardenFunction } from "./frozen.ts";
import {
  narrowerThan,
  type Scope,
  scopedDocument,
  type ScopeInstancesOptions,
  scopeKeyReaches,
  scopeOfDocument,
  scopeOfKey,
} from "./scope-instances.ts";
import {
  boundInElement,
  type ElementReads,
  STORED_ROW,
  storedRowCollections,
  type StoredUnits,
} from "./stored-units.ts";

/** One step of where a declaration sits (PL §1.1, `WithinStep`). */
type Step = { element?: number; site?: Name };

type Root = {
  kind: string;
  cell?: number;
  collection?: number;
  handler?: number;
  operation?: number;
  child?: number;
};

/** The members of a plan the executor reads (PL §1.1). */
export type Plan = {
  /**
   * The patterns whose code the plan holds: the pattern the plan is
   * compiled from, by its identity, and then each pattern compiled in.
   */
  patterns?: string[];
  argumentSchema?: string;
  resultSchema?: string;
  slots: { root: Root; path: string[]; observes: string; schema?: string }[];
  cones: {
    entry: string;
    /**
     * Where the cone's code is written (ruling Z10): the `element` step
     * of each element body around it, outermost first, and the `site`
     * step of each pattern compiled in. An instance of the cone exists
     * for each combination of keys of the collections the `element`
     * steps name, and what the instance holds is kept under those keys.
     */
    within: Step[];
    slots: number[];
    bodies: number[];
    /**
     * For a cone with side-writes, its kind: `static` where every write
     * target is one the compiler names, and `materializer` where a target
     * is reached through data.
     */
    sideWrites?: "static" | "materializer";
    /**
     * The write edges of the cone: to the argument of a child, to the
     * request of an operation, and the first value of a state cell.
     */
    writes?: {
      target: {
        kind: string;
        cell?: number;
        child?: number;
        of?: { operation?: number };
        path?: string[];
      };
      template?: Template;
    }[];
    /** The entries of `Plan.selectors` whose branch the cone decides. */
    selectors?: number[];
    /** The entries of `Plan.picks` whose child the cone chooses. */
    picks?: number[];
  }[];
  outputs: {
    path: string[];
    cone: number;
    collection?: number;
    /**
     * The collection whose assembled result the output is on every
     * evaluation, passed on unchanged (ruling Z13): a construct over the
     * output has the element table of that collection.
     */
    passesCollection?: number;
    /**
     * The key fields that the type of the output's value declares with
     * `ArrayByKey`, in the order of their names: a copy, as that of a
     * collection, since the plan holds no schema of an output (ruling
     * Z54).
     */
    keyFields?: string[];
    kept: boolean;
    interim?: string;
    /** The label template of the output (PL §1.1, `Output.template`). */
    template?: Template;
  }[];
  edges: { from: number; to: number; via: { kind: string; output?: number } }[];
  collections: {
    name: Name;
    construct: string;
    within: Step[];
    /**
     * `entries`: the collection is over the entries of the record the slot
     * holds, `Object.entries(record)`: an element is the pair of an
     * entry's name and what the record holds under it, and its key is the
     * name.
     */
    source: {
      slot?: number;
      collection?: number;
      output?: number;
      entries?: true;
    };
    /** The label template of what the collection iterates (PL §3.2). */
    membership?: Template;
    /**
     * The key fields that the array type of the receiver declares with
     * `ArrayByKey`, in the order of their names, for a source that is a
     * slot or an output (PL §1.1, `Collection.keyFields`; rulings Z45
     * and Z49).
     */
    keyFields?: string[];
  }[];
  bodies: {
    kind: string;
    name: Name;
    /**
     * Each slot the body reads, with its place in the argument, and for a
     * body of a pattern compiled in the default the callee declares for
     * the path the call bound to the slot (PL §1.1, `ReadInput`).
     */
    /**
     * `handle`: the body declares a handle at `at` (provisional decision
     * P31). `schema`: the identifier of the schema of the type the body
     * declares for that handle, under which a read through it is made.
     */
    reads: {
      slot: number;
      at: string[];
      default?: unknown;
      handle?: true;
      schema?: string;
    }[];
    /**
     * `schema`: for an `identity` entry where the body declares a handle,
     * the identifier of the schema of the declared type, as on `reads`.
     */
    computed: { at: string[]; observes: string; schema?: string }[];
    writes: {
      target: { kind: string; slot?: number; cell?: number; path?: string[] };
      /** The label template of the write (PL §1.1, `WriteEdge.template`). */
      template?: Template;
    }[];
    envelopes: { kind: string; slot?: number; path?: string[] }[];
    /**
     * The paths of the body's result at which it gives a reference
     * (PL §1.1, `Body.outputs`): `*` stands for each member of an array.
     */
    outputs?: { path: string[]; reference?: unknown }[];
    /**
     * The handles the body is given: an entry of a slot names the
     * `identity` slot of the handle (PL §1.1, `Body.handles`).
     */
    handles?: { handle?: { slot?: number } }[];
  }[];
  stateCells: {
    name: Name;
    scope: string;
    within: Step[];
    /** The schema of the cell's value, with a constant first value as
     * its default. */
    schema?: string;
    /** The cone and its write edge that give a first value that is not
     * a constant. */
    first?: { cone: number; write: number };
  }[];
  /**
   * The patterns instantiated with a plan of their own (PL §1.1,
   * `Child`). The executor instantiates the ones called through the
   * factory modifier `asInstance()`, whose callee is a compiled pattern,
   * named by its identity.
   */
  children?: {
    callee: { compiled?: string | null; factory?: unknown };
    /**
     * `asInstance()`: under an `element` step of `within` the instance
     * is not torn down when its key leaves the collection, and an event
     * for one of its streams is handled while the key is away (rulings
     * Z35 and Z36).
     */
    asInstance?: true;
    name: Name;
    within: Step[];
  }[];
  operations: {
    kind: string;
    name: Name;
    within?: Step[];
    /** For a `reduce`: the cone of its step. For an effect and a `wish`:
     * the built-in. */
    implementation?: { cone?: number; builtin?: string };
    /** The template of the operands. */
    input?: Template;
    /**
     * The scope of the state of the operation: `user` for a `wish` whose
     * target resolves through the home of the acting principal.
     */
    scope?: string;
  }[];
  bindings: {
    name?: Name;
    handler: { body?: number };
    within: Step[];
    state: {
      path: string[];
      place?: {
        slot?: number;
        output?: number;
        stream?: number;
        constant?: unknown;
        /** The result of the instance: the name bound to `[SELF]`. */
        result?: true;
      };
      /**
       * For a binding of a pattern compiled in whose `place` is a slot
       * the call bound: the default the callee declares for the path
       * (PL §8, question 110, assumed).
       */
      default?: unknown;
    }[];
  }[];
  /**
   * The templates the plan holds at more than one position, each written
   * once (provisional decision P6): a node of `op` `shared` names one.
   */
  templates?: Template[];
  /** The constraints of the plan (PL §1.1); the executor checks none. */
  constraints?: unknown[];
  /** The reads through handles that a `dynamic` node names (PL §1.1). */
  dynamicReads?: unknown[];
  /** Each branch selector, with the number of its branches. */
  selectors?: { arity: number }[];
  /** Each pick, and what chooses its child: value code or the runtime. */
  picks?: { chosenBy: string }[];
};

/**
 * The elements of the assembled result of a per-element construct, by
 * the array, each with its key, and the element keys the construct was
 * evaluated under.
 */
const assembledElements = new WeakMap<
  object,
  { members: readonly Element[]; context: Context }
>();

/**
 * The elements of a bucket that a `lookup` gave, by the array: the
 * elements of the index's source that are in the bucket, each with the key
 * it has there.
 */
const bucketElements = new WeakMap<object, readonly Element[]>();

/**
 * Where the result of the instance stores the bucket that a `lookup` gave,
 * by the array of the bucket's members: the position below the record
 * `buckets` of a kept index whose buckets are documents of their own
 * (`Instance.bucketRecordOf`). An output that holds the array is stored as
 * a reference to that position (`Instance.#formOf`).
 */
const bucketPlaces = new WeakMap<object, Ref>();

/** The value code of a plan, as the crate's `emit` command prints it. */
export type Code = {
  modules: { module: number; path: string; source: string }[];
  main: number;
  /** For each value: its cone, its output, and whether it has a function. */
  values: {
    cone: number;
    output?: number;
    collection?: number;
    scan?: boolean;
    function?: boolean;
  }[];
  /** The interim outputs at a path below a value. */
  outputsBelow: { output: number; value: number; path: string[] }[];
  handlers: Record<string, { named: boolean; captures: string[] }>;
  /**
   * The files that the `dataFile` calls of the program name, each with
   * its text: constants of the program (BI, "Pure API functions").
   */
  dataFiles?: { file: string; text?: string }[];
  unlistedReads: unknown[];
  valuesWithoutOutput: number[];
  unsupported: { kind: string; file: string; start: number }[];
};

/**
 * Makes a function of the text of a module of value code: the statements
 * of `source` are its body, in strict mode, and `parameters` are the names
 * of its parameters, which the statements read as free names. What other
 * free names the statements can read is the evaluator's to decide.
 */
export type ModuleEvaluator = (
  module: { path: string; source: string },
  parameters: readonly string[],
) => (...given: unknown[]) => void;

/**
 * The evaluator that confines nothing: the function is made in the realm
 * the executor runs in, and its free names are the globals of that realm.
 */
export const evaluateWithFunction: ModuleEvaluator = (
  { path, source },
  parameters,
) =>
  new Function(
    ...parameters,
    `"use strict";\n${source}\n//# sourceURL=compiled:${path}`,
  ) as (...given: unknown[]) => void;

/** One pattern of the output of `pattern-compiler emit`. */
export type Artifact = {
  name?: string;
  plan: Plan;
  schemas: { id: string; schema?: Schema }[];
  unsupported: unknown[];
  code: Code;
};

/** Something the executor does not do: the kind says what. */
export class Unsupported extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}

/**
 * Whether two arrays of one length hold scalars alone and differ at more
 * than one position, as a list does that one member left and another
 * entered: such an array is written whole, as one of another length is,
 * and not position by position, which is a write and a record for each
 * position behind the member that left.
 */
const shiftedScalars = (
  form: readonly unknown[],
  held: readonly unknown[],
): boolean => {
  let differing = 0;
  for (let index = 0; index < form.length; index++) {
    const [now, was] = [form[index], held[index]];
    if (
      (now !== null && typeof now === "object") ||
      (was !== null && typeof was === "object") || typeof now === "symbol"
    ) return false;
    if (now !== was) differing += 1;
  }
  return differing > 1;
};

/**
 * The assembled result of a `map`, a `filter` or a `flatMap`, as value
 * code holds it where it places the result and observes nothing of it:
 * a reference to the collection for the element keys it was named
 * under. Code that observes the result is given the array
 * (`Host.settled`). A value that holds the reference does not change
 * when an element of the collection does, so the cone that placed the
 * result is not evaluated again for it, and the runtime stores each row
 * where the result stands (`Instance.#storeUnit`).
 */
/**
 * An output a change of the result document is recorded for
 * (`Instance.#recordedOutputs`): the output, the path of the result
 * document it is stored at, whether its records are `bound`, and whether
 * it holds the result of a per-element construct (`members`), whose
 * position takes the label of the collection's membership.
 */
type RecordedOutput = {
  output: number;
  path: readonly string[];
  bound?: true;
  members?: true;
};

/**
 * A node of the tree of the paths of the outputs a change of the result
 * document is recorded for (`Instance.#recordedTrie`): the output whose
 * path ends here, where one does, and the nodes of the next segments, `*`
 * among them for the position of an element.
 */
type RecordedTrie = {
  here?: RecordedOutput;
  children: Map<string, RecordedTrie>;
};

export class Assembled {
  constructor(
    readonly collection: number,
    readonly context: Context,
    /** The name of the memo entry of the assembly. */
    readonly name: string,
  ) {
    Object.freeze(this);
  }
}

/**
 * A collection index as the executor holds it (PL §3.17, ES §6.3): for
 * each element key the encoded index key that the key function gave, and
 * for each encoded index key its bucket. A bucket that emptied stays, with
 * no member, so that its count goes on from where it was.
 */
export class Index {
  /** The encoded index key of each element key that is in a bucket. */
  readonly of = new Map<string, string>();
  /**
   * By encoded index key: the index key, the element keys of the bucket in
   * source order, and a count that moves with each change of the bucket.
   */
  readonly buckets = new Map<
    string,
    { key: unknown; keys: string[]; version: number }
  >();
  /** Moves with each change of a bucket. */
  serial = 0;
  /**
   * The encoded keys of the buckets that changed since the index was last
   * stored bucket by bucket (`Instance.#storeIndex`), which empties it.
   */
  readonly changed = new Set<string>();
  constructor(
    readonly mode: "group" | "key",
    /** The name of the memo entry of the assembly. */
    readonly name: string,
  ) {}
}

/** The collection and the element keys an `IndexHandle` names. */
let indexPartsOf: (
  handle: IndexHandle,
) => { collection: number; context: Context };

/**
 * A collection index as value code holds it: a reference to the index for
 * the element keys it was named under. `Host.lookup` reads one bucket
 * through it and depends on that bucket alone.
 */
export class IndexHandle {
  /**
   * Private as the parts of a `Handle` are: a body that is handed the
   * index reads no member of it, and the context, a map the executor
   * holds, is not reached through it. The executor reads the two with
   * `indexPartsOf`.
   */
  readonly #collection: number;
  readonly #context: Context;

  static {
    indexPartsOf = (handle) => ({
      collection: handle.#collection,
      context: handle.#context,
    });
  }

  constructor(collection: number, context: Context) {
    this.#collection = collection;
    this.#context = context;
    Object.freeze(this);
  }
}

/** Whether a construct builds a collection index. */
const buildsIndex = (construct: string): boolean =>
  construct === "groupBy" || construct === "keyBy";

/** The name that stands for one bucket of an index. */
const bucketName = (assembly: string, encoded: string): string =>
  `bucket ${assembly}\n${encoded}`;

/**
 * The text an index key is filed under, by its kind, so that the number 1
 * and the text "1" have buckets of their own, and nothing for a key that
 * leaves its element out of the index (`null` and `undefined`). A cell is
 * filed under the position it names.
 */
const encodeIndexKey = (
  instance: Instance,
  key: unknown,
): string | undefined => {
  if (key === undefined || key === null) return undefined;
  if (typeof key === "string") return `s:${key}`;
  if (typeof key === "number") return `n:${key}`;
  if (typeof key === "boolean") return `b:${key}`;
  if (key instanceof Handle) return encodeIndexKey(instance, targetOf(key));
  if (key instanceof Ref) {
    return `c:${instance.store.addressText(instance.store.current(key))}`;
  }
  throw new Unsupported("an index key that is no primitive and no cell");
};

/** Whether a construct assembles an array of rows. */
const assemblesRows = (construct: string): boolean =>
  construct === "map" || construct === "filter" || construct === "flatMap" ||
  construct === "sortBy" || construct === "last" || construct === "first";

/**
 * How many elements a window holds, from what the function of its count
 * returned: a whole number that is not negative, and otherwise none.
 */
const windowCount = (count: unknown): number =>
  typeof count === "number" && count > 0 ? Math.floor(count) : 0;

/**
 * The positions `[start, end)` of the `length` elements of its source that
 * a window of `count` elements holds.
 */
const windowOf = (
  construct: "last" | "first",
  length: number,
  count: number,
): [number, number] =>
  construct === "last"
    ? [Math.max(0, length - count), length]
    : [0, Math.min(count, length)];

/**
 * The order of two keys of a sort (note 614 of `SPEC-NOTES.md`): numbers
 * by their value, texts by their code units, `false` before `true`; a key
 * of one kind before a key of another in the order number, text, boolean;
 * and `null`, `undefined` and `NaN` behind every other key. Zero for two
 * keys that the sort keeps in the order of the source.
 */
const compareSortKeys = (a: unknown, b: unknown): number => {
  const rank = (key: unknown) =>
    typeof key === "number"
      ? (Number.isNaN(key) ? 3 : 0)
      : typeof key === "string"
      ? 1
      : typeof key === "boolean"
      ? 2
      : 3;
  const [left, right] = [rank(a), rank(b)];
  if (left !== right) return left - right;
  if (left === 3) return 0;
  return (a as number) < (b as number)
    ? -1
    : (a as number) > (b as number)
    ? 1
    : 0;
};

/** Whether a value is one a sort orders by: no container and no reference. */
const isSortKey = (key: unknown): boolean =>
  key === null || typeof key !== "object";

/**
 * Whether two sources of the element of one key name the same place: a
 * reference names it by its document and path. A source of another kind
 * is no place a reader holds.
 */
const samePlace = (a: Element["source"], b: Element["source"]): boolean =>
  !(a instanceof Ref) || !(b instanceof Ref) ||
  (a.doc === b.doc && textOf(a.path) === textOf(b.path));

/** A value of the reactive tier held for a later host. */
class Thunk {
  constructor(readonly evaluate: (host: Host) => unknown) {}
}

/** One element of a collection as the element table holds it (ES §2.5). */
type Element = {
  key: string;
  index: number;
  /**
   * The reference to the element: to its cell, where the position holds a
   * link, and by key, where it holds a plain value in place (ruling Z12).
   * Or the element's value, where it has no place. Or, for an element of
   * the result of a per-element construct, the result of that construct's
   * body for the element's key, and a path below it.
   */
  source: Ref | { value: unknown } | { entry: Lazy; at: string[] };
};

type Context = ReadonlyMap<number, Element>;

/**
 * A place of the stored result that holds the rows of an assembled
 * collection, and what it holds: the key and the value of each row as
 * it was last stored.
 */
type Unit = {
  /** The name of the memo entry of the assembly. */
  name: string;
  collection: number;
  context: Context;
  /**
   * Where the array stands: at a path of the result, or in the row of
   * a key of another unit, at a path below the row.
   */
  place:
    | { path: string[] }
    | { unit: Unit; key: string; below: string[] };
  keys: string[];
  values: unknown[];
  /** The position of each key, formed when it is asked for. */
  positions?: Map<string, number>;
  /** The entry of the assembly as it was last stored. */
  seen?: Entry;
  /** The units in each row, by the key of the row and by their path. */
  inside: Map<string, Map<string, Unit>>;
  /** Tells the unit from the others of its instance. */
  serial: number;
  /**
   * The layout (`execution-and-storage.md` §4.10). `sizes` has the
   * bytes of each row as it is stored, a part below it counted as its
   * storage link. `parted` says which rows are stored in a part
   * document, `splits` which rows can be, `forced` which rows the rule
   * on the size of a document made parts. `sum` is the bytes that the
   * rows take in the array: a row that is a part takes those of its
   * storage link. `part` says whether the array is a part itself.
   */
  sizes: number[];
  parted: boolean[];
  splits: boolean[];
  forced: Set<string>;
  sum: number;
  part: boolean;
  partForced: boolean;
  /**
   * Every row that can be a part is one: nothing entered the array, and
   * no row was stored in place again, since the rule on the size of a
   * document last passed over the rows.
   */
  swept: boolean;
};

/**
 * A place of the stored result that holds a kept index whose buckets are
 * stored by themselves: the collection of the index, the element keys it
 * was named under, the path of the result it stands at, and the index as
 * it was last stored.
 */
type IndexUnit = {
  collection: number;
  context: Context;
  path: string[];
  index: Index;
};

/** A document of the layout: the result document, or a part. */
type Laid = { unit?: Unit; key?: string };

/**
 * The sizes of `execution-and-storage.md` §4.10, which are placeholders
 * there: a split point of at least `PART_SPLIT_BYTES` is stored in a
 * part document, a part of at most `PART_MERGE_BYTES` in place again,
 * and a document of more than `DOCUMENT_MAX_BYTES` has every split
 * point directly below it stored as a part.
 */
export const PART_SPLIT_BYTES = 1_024;
export const PART_MERGE_BYTES = 512;
export const DOCUMENT_MAX_BYTES = 65_536;

/** The bytes of the JSON text of a stored value. */
const bytesOf = (value: unknown): number =>
  (JSON.stringify(value) ?? "").length;

/** Whether a stored value can be a split point: a record or an array
 * that is no link. */
const splits = (form: unknown): boolean =>
  typeof form === "object" && form !== null && !isLink(form) &&
  !isStream(form);

/** Stands, in a stored form, for rows that are stored already. */
const KEPT = Symbol("kept");

/**
 * Stands, in a stored form, for a record or an array that is the value
 * placed at the same position before, whose form the position holds
 * already (`Instance.#place`).
 */
const SAME = Symbol("same");

/** Whether a stored form has `KEPT` at or below it. */
const holdsKept = (form: unknown): boolean =>
  form === KEPT ||
  (Array.isArray(form)
    ? form.some(holdsKept)
    : isRecord(form) && Object.values(form).some(holdsKept));

/**
 * A stored form with each `SAME` in it replaced by what `held`, which the
 * position of the form holds, holds at that place: the form that was
 * placed there before.
 */
const withSame = (form: unknown, held: unknown): unknown => {
  if (form === SAME) return held;
  if (Array.isArray(form)) {
    return form.map((member, index) =>
      withSame(member, Array.isArray(held) ? held[index] : undefined)
    );
  }
  if (isRecord(form)) {
    const members: Record<string, unknown> = {};
    for (const [name, member] of Object.entries(form)) {
      members[name] = withSame(member, isRecord(held) ? held[name] : undefined);
    }
    return members;
  }
  return form;
};

/**
 * Whether two arrays of one length, longer than one member, hold another
 * value at every position, as a window of the newest members of a list
 * does when a member enters the list: such an array is written whole, as
 * one of another length is, and not member by member, which is a write
 * and a record for each differing member of each position. The form holds
 * no `KEPT`, so what is written is the form. The first and the last
 * position are compared before the others, so that an array that kept its
 * first member, as nearly every one that is compared has, costs the text
 * of that one member.
 */
const differsThroughout = (
  form: readonly unknown[],
  held: readonly unknown[],
): boolean => {
  const differs = (index: number) =>
    !holdsKept(form[index]) &&
    canonical(withSame(form[index], held[index])) !== canonical(held[index]);
  if (form.length < 2 || !differs(0) || !differs(form.length - 1)) {
    return false;
  }
  for (let index = 1; index < form.length - 1; index++) {
    if (!differs(index)) return false;
  }
  return true;
};

/** A memo entry, brought up to date for the element keys of a context. */
type Lazy = (context: Context) => Entry;

/**
 * Something an evaluation used of another entry, and what it was then:
 * when the entry had last changed, or the value at a path of it.
 */
type Dependency = {
  stamp: (context: Context) => unknown;
  seen: unknown;
  /**
   * What the stamp is of, where a change of it marks the entries that
   * used it: the name of a memo entry of the same instance, or the name
   * that stands for the element table of a collection. A dependency
   * with none is compared on every pull.
   */
  on?: string;
};

/** What the name that stands for an element table begins with. */
const TABLE_PREFIX = "table ";

/** The name that stands for the element table of an assembly. */
const tableName = (assembly: string): string => `${TABLE_PREFIX}${assembly}`;

/**
 * What the assembly of a `map` or a `filter` over a stored array keeps
 * so that a change of the array, or of the result of the body for one
 * element, is applied to it, and the table and the result are not
 * formed again (`#reassemble`).
 */
type Rows = {
  construct: "map" | "filter" | "flatMap" | "sortBy" | "last" | "first";
  /**
   * For a collection over a stored array: the reference that the array
   * was found through, its name, and of the keys of the array the
   * count of the times they were formed whole and how many changes
   * since the assembly has applied.
   */
  stored?: {
    base: Ref;
    named: string;
    fields: readonly string[];
    formed: number;
    seen: number;
  };
  /**
   * For a collection over the result of another per-element construct:
   * that collection, the name of its assembly, and the version of the
   * entry that this one was formed from.
   */
  upstream?: { collection: number; name: string; version: number };
  /** The reads that found the array, and those that found an element. */
  arrayReads: Set<Position>;
  elementReads: Map<Position, string>;
  /** How many dependencies stand before those of the elements. */
  first: number;
  /** The result of the body for each element of the table. */
  results: unknown[];
  /** The key of the element that each name of an entry is of. */
  keyOf: Map<string, string>;
  /** The entry of each row of the result, in the order of the table. */
  members: Element[];
  /** For a `filter`: whether each element is kept. */
  flags?: boolean[];
  /**
   * For a `filter` whose elements are the rows of another per-element
   * construct, which the result holds as they are: the key of each member,
   * by the name of the entry of its row. The dependencies on those entries
   * stand behind those of the elements, in the order of the members.
   */
  kept?: Map<string, string>;
  /** For a collection index: the index, which the results are the keys of. */
  index?: Index;
  /**
   * For a `flatMap` whose body returned, for every element, the assembled
   * result of another per-element construct: how many members the segment
   * of each element has, in the order of the table, and the key of the
   * element that each name of an inner assembly is the segment of. The
   * dependency on the inner assembly of the element at a position of the
   * table stands behind those of the elements, at the same position.
   */
  segments?: { lengths: number[]; of: Map<string, string> };
  /**
   * For a sort by a key: the key each element was placed by, by the key of
   * the element. `members` holds the elements in the sorted order.
   */
  sortKeys?: Map<string, unknown>;
  /**
   * For a window (`last`, `first`): the count its elements were taken by.
   * `members` holds the elements of the window.
   */
  window?: number;
};

/**
 * The source of a member of a segment of a `flatMap` that is an element of
 * the assembled result of an inner per-element construct: the result of
 * the inner construct's body, for the element keys `inner` that the
 * callback was evaluated under.
 */
const segmentSource = (
  source: Element["source"],
  inner: Context,
): Element["source"] =>
  source instanceof Ref || !("entry" in source) ? source : {
    entry: () => source.entry(inner),
    at: source.at,
  };

/**
 * Whether the source of an element is the row of another per-element
 * construct that a result holds whole: the result of that construct's body
 * for the element's key, at no path below it.
 */
const isRowSource = (
  source: Element["source"],
): source is { entry: Lazy; at: string[] } =>
  !(source instanceof Ref) && "entry" in source && source.at.length === 0;

/** Stands for the source of an element that is not found yet. */
const PENDING = new Ref("", []);

/** One registration of a reader: at a position, or under a key. */
type Reg = { slot: Slot; position: Position };

/** The readers registered at one path of a document, and below it. */
type Readers = { regs?: Set<Reg>; below?: Map<string, Readers> };

/**
 * What is known of whether the memo entry of one name is current
 * (`scheduler-and-serving-loop.md` §3, "Dirty slots from the change
 * channel"): a write marks the entries that read what it changed, and a
 * mark passes on to the entries that used a marked one. An entry that
 * is not marked is current, and is not compared with anything.
 */
type Slot = {
  instance: Instance;
  key: string;
  marked: boolean;
  /** Moves with each mark. */
  serial: number;
  /** The names that it used and that may have changed. */
  suspects: Set<string>;
  /** The positions it read that may have changed. */
  reads: Set<Position>;
  /** Anything that it read or used may have changed. */
  all: boolean;
  /** Each set that holds a registration of the entry. */
  regs: { set: Set<Reg>; reg: Reg; keyed: boolean }[];
  /** The names that it is registered as a user of. */
  uses: Set<string>;
  /** The entry is compared on every pull. */
  always: boolean;
  /**
   * The scope key of the entry the slot is of, where the entry is of one:
   * a change of that key, or of the space, marks the slot, and a change of
   * another key does not (`scopeKeyReaches`).
   */
  scoped?: string;
  /**
   * The entry, while it is set aside for its scope key and the memo holds
   * the entry of another key under the same name (`Instance.#forActing`).
   * The slot stays registered as a reader of what the entry read and a user
   * of what it used, so a change marks it as it marks the entry in the
   * memo.
   */
  aside?: Entry;
};

type Entry = {
  /** The name of the entry in the memo of its instance. */
  key?: string;
  owner?: Instance;
  /**
   * The entry is compared with what it read on every pull, and no mark
   * stands for that: something it depends on has no place in an index.
   */
  always?: boolean;
  value: unknown;
  stored: string;
  reads: Position[];
  dependencies: Dependency[];
  indexes: Map<number, number>;
  /**
   * For the assembled result of a `map`, a `filter` or a `flatMap`: its
   * elements, each with the key of the element it came from.
   */
  members?: Element[];
  /**
   * For the assembly of a `map` or a `filter` over a stored array: what
   * bringing it up to date from the changes of the array needs.
   */
  rows?: Rows;
  /** Counts the entries that the name has had. */
  version?: number;
  /**
   * For an assembly that was brought up to date from the entry of the
   * version before: the splices of its rows, and the keys of the rows
   * that stand where they stood and hold another value.
   */
  delta?: { ops: KeyOp[]; rows: string[] };
  /**
   * The cones with static side-writes whose write target the evaluation
   * read or passed on: each is brought up to date before this entry is
   * taken as current (ES §2.3, "A cone with side-writes").
   */
  writers: Writer[];
  /** The value of a materializer that has not been evaluated yet. */
  pending?: boolean;
  /**
   * Something the evaluation used that the store does not hold is now
   * another (`Instance.markStale`): the entry is not current, whatever its
   * reads and its dependencies compare to.
   */
  stale?: boolean;
  /**
   * The scope key the entry was evaluated for, where the evaluation
   * touched a scope instance or used an entry of one
   * (`scope-instances.ts`). An entry with none is one for every key.
   */
  scoped?: string;
  /**
   * Where the cone instance failed: `value` is then the error state
   * (PL §5.2).
   */
  error?: string;
  /** The transaction in which the entry failed at the bound. */
  exhausted?: Transaction;
  evaluatedAt: number;
  changedAt: number;
  /**
   * The clock of the store when the entry was last found current. An
   * entry is stale by a write alone, so it stays current while the clock
   * stands.
   */
  checkedAt?: number;
};

/**
 * The schema of a position as a body is handed it: where the type is a
 * union of a handle type with `undefined` or `null`, the handle type,
 * which is what the body holds where the position is bound.
 */
const handleVariant = (schema: Schema | undefined): Schema | undefined => {
  if (typeof schema !== "object" || schema.asCell !== undefined) return schema;
  const variants = (schema.anyOf ?? []).filter((variant) =>
    typeof variant !== "object" ||
    (variant.type !== "undefined" && variant.type !== "null")
  );
  const [only] = variants;
  return variants.length === 1 && typeof only === "object" &&
      only.asCell !== undefined
    ? only
    : schema;
};

/**
 * The schema of a container for a read that gives its children and reads
 * none: each member of an array is typed as `unknown`, so a link there is
 * given as a reference and not followed (`Store.read`, `bound`).
 */
const membersUnread = (schema: Schema | undefined): Schema =>
  typeof schema === "object" ? { ...schema, items: {} } : { items: {} };

/**
 * The schema of a read of a container that gives which children it has,
 * of an array or of a record, and follows no link a child holds: it types
 * each element as `unknown` and declares no member.
 */
const CHILDREN_UNREAD: Schema = { items: {} };

/** Brings the instances of a side-writing cone up to date. */
type Writer = (context: Context) => void;

/**
 * What an evaluation bound a slot to: the positions its read went through,
 * and for an `identity` slot the reference it gave, which are turned into
 * addresses when a write record is made, so that an element that moved
 * since is found where it stands. The slot of an element of the result of
 * another per-element construct is bound to that upstream element.
 */
type Bound =
  | { observes: string; at: (Position | Ref)[] }
  | {
    upstream: { collection: number; keys: [number, string][] };
    /**
     * The stored positions that the read of the slot went through, where
     * the upstream element holds a reference there and the slot reads what
     * the reference names: the label of the slot is then that of the
     * upstream output, which says which reference the element holds,
     * joined with the label of the read at these positions.
     */
    through?: { observes: string; at: (Position | Ref)[] };
  }
  /** A constant of the plan, such as a literal a binding gives its state. */
  | { constant: true }
  /**
   * An output of the pattern, such as the value a binding gives its state
   * that the pattern computes: a value in memory, at no stored position.
   */
  | { output: number }
  /**
   * The slot a binding takes a member of its state from, with the path
   * below it, where the handler's read of the member went through no
   * stored position: the index of an element, or an element of the result
   * of another per-element construct.
   */
  | { place: { slot: number; rest: string[] } };

/**
 * The slots that each cone instance last bound, by the instance's name
 * (`Instance.#noteInputs`), and the identifier of what those bindings
 * consumed, formed when a group asks for it.
 */
/**
 * Where a write record finds what a template's slots, selectors and picks
 * were bound to: a cone instance's kept inputs, or the host of the code
 * that is writing. The first of a list that has an entry gives it.
 */
type Inputs = Pick<ConeInputs, "slots" | "selections" | "picks" | "dynamic">;

type ConeInputs = {
  slots: Map<number, Bound>;
  selections: Map<number, number>;
  picks: Map<number, string | null>;
  dynamic: Map<number, Address[]>;
  /** The identifier of what the bindings consumed (`#idOf`). */
  id?: string;
  /** The positions whose labels `id` holds, with those of upstream elements. */
  positions?: Address[];
};

/**
 * The elements of a `fold` that read positions of one document, by path:
 * the elements whose group reads a position at the node, and the nodes of
 * the paths below.
 */
type LabelReaders = {
  readers: Set<string>;
  children: Map<string, LabelReaders>;
};

/** The paths of the label entries of a document that changed. */
export type LabelChange = {
  doc: string;
  paths: readonly (readonly string[])[];
  /**
   * The paths of `paths` at which every entry that changed labels a read
   * of the path itself and no read below it: the membership of a container,
   * or the shape of a container node. The label of what a member holds, and
   * of the reference to it, did not change with one of them.
   */
  alone?: readonly (readonly string[])[];
  /**
   * Whether a read of the class `observes` at `path` of the document
   * consumes the label it consumed before the change, where the store can
   * tell: an entry added at a path under the label that a read of the path
   * consumed before changes the entries and no label. Without it, every
   * read at, above or below a path of `paths` counts as changed.
   */
  unchanged?: (path: readonly string[], observes: string) => boolean;
};

/**
 * The groups of the elements of one assembly of a collection that a
 * `fold` names (provisional decision P31): the group of each element
 * key, the elements of each group, and the keys of the elements that are
 * not plain values in place, for which no `*` path stands.
 */
type Groups = {
  byKey: Map<string, string>;
  groups: Map<string, Set<string>>;
  notInPlace: Set<string>;
};

/**
 * One member of a container that `MemberGroups` groups: the links a read of
 * the member crosses, the positions it ends at, each position as text, and
 * the key of the labels the positions hold, absent where the store names no
 * identifier for one of them.
 */
type Member = {
  links: Address[];
  ends: Address[];
  texts: string[];
  key: string | undefined;
};

/**
 * The groups of the members of one stored array of references, for the
 * reads of one observation class that reach, of what each member's link
 * leads to, the positions at `fields` (provisional decision P31, extended
 * from the elements of a `fold` to any read that covers the members of a
 * container; ruling Z85). Two members are in one group where the labels the
 * runtime observes at their positions are equal, so the label of a read
 * that covers the container is the join over one member of each group. The
 * table is formed by one walk of the members, and then brought up to date
 * for the members whose positions or labels changed, and for no other.
 */
type MemberGroups = {
  doc: string;
  path: readonly string[];
  observes: string;
  /** The paths read below the position each member's link leads to. */
  fields: readonly (readonly string[])[];
  members: Map<string, Member>;
  /** The members of each group, by the key of their labels. */
  groups: Map<string, Set<string>>;
  /** The members with no key: each is reported by itself. */
  unknown: Set<string>;
  /** The members whose positions or labels changed since they were placed. */
  dirty: Set<string>;
  /** The container changed otherwise than at a member: formed again whole. */
  stale: boolean;
  /** A member is no reference the table can place: the table covers none. */
  declined: boolean;
  /** The number of times the set of members changed. */
  membership: number;
  /** The members that have a position in each document other than `doc`. */
  byDoc: Map<string, Set<string>>;
  /**
   * The sets of positions of the records of outputs whose bindings name
   * the container.
   */
  records: Set<ReadSet>;
};

/**
 * The positions that the inputs of records given to the transaction hooks
 * read, with the keys of those records (`Instance.#noteRecord`): the
 * records whose inputs hold equal content share one, which is registered
 * once as a reader of its positions (`Instance.#recordReaders`).
 */
type ReadSet = {
  /** What names the content: the instance and the number of the inputs. */
  id: string;
  /** The positions, by their text. */
  positions: Map<string, Address>;
  /**
   * The folds over the elements of a collection whose groups the inputs
   * read, each as the instance and the collection.
   */
  folds: Set<string>;
  /** The tables of the groups of members of containers bindings name. */
  groups: Set<MemberGroups>;
  /** The keys of the records whose inputs these are. */
  keys: Set<string>;
};

/** The sets of positions that read a path, and those of its children. */
type RecordReaders = {
  readers: Set<ReadSet>;
  children: Map<string, RecordReaders>;
};

/**
 * A record noted since the sets of positions were brought up to date: what
 * names the content of its inputs, the instance, and the table and index
 * of its inputs, or the positions of its own element where it names the
 * inputs of another element.
 */
type PendingRead = {
  id: string;
  instance: string;
  table: InputsTable;
  inputs: number;
  own?: Address[];
};

/**
 * What a read that went through a list of positions covered of the
 * containers among them (`Instance.#coveredMembers`): the positions that
 * are of no covered member, and each container's table with the members
 * the read did not go through every position of, whose positions stay
 * among `rest`.
 */
type Cover = {
  rest: Address[];
  covers: { table: MemberGroups; uncovered: ReadonlySet<string> }[];
  /** The position the read ended at. */
  last: Address | undefined;
};

/**
 * The addresses of the positions that hold a link at which every read that
 * went there stopped (`Position.stopped`), among those `#addressesOf` gave.
 */
const stoppedAt = new WeakSet<Address>();

/**
 * The cover found for what an evaluation bound a slot to, with what it is
 * current against: the number of positions bound, the clock of the store,
 * and for each table the number of changes of its set of members.
 */
type KeptCover = {
  cover: Cover;
  positions: number;
  clock: number;
  memberships: number[];
};

/**
 * The records of the plan that the writes being made belong to: each with
 * its template, and the document and path of its target where the record
 * names one. A record with no `doc` covers whatever is written.
 */
type Writing = {
  instance: Instance;
  host: Host;
  records: {
    record: PlanRecord;
    template: Template | undefined;
    doc?: string;
    path?: readonly string[];
  }[];
  /**
   * The writes are made through a handle, with what the method that makes
   * them compared to decide which members a list keeps or gains: a splice
   * of a stored list is then recorded by position (`#memberWrites`).
   */
  members?: {
    decided: Observed[];
    /**
     * For each position of the list being changed, the position its member
     * stood at before the first splice of these writes, or `undefined` for
     * a member they added. Absent until a splice moves a member.
     */
    origin?: (number | undefined)[];
    /** A splice of these writes removed a member. */
    removes?: true;
    /** The first position a splice of these writes started at. */
    start?: number;
  };
  /** See `DeclaredWrite`. */
  declared?: DeclaredWrite;
  /** The writes are those of a handler, and not of the body of a cone. */
  handler?: true;
};

/**
 * What a handler declares for a write it makes through a handle: the
 * stored position the handle names, with every link on the way to it
 * resolved, and the schema of the handle's declared type. A write policy
 * the handler's own state type declares is in that schema and in no other
 * the write is made under.
 */
export type DeclaredWrite = {
  doc: string;
  path: readonly string[];
  schema: Schema;
};

/** A position of a document, as text. */
const positionText = (doc: string, path: readonly string[]): string =>
  JSON.stringify([doc, path]);

/** The name of the place of a container, by which its tables are found. */
const memberGroupsPlace = (doc: string, path: readonly string[]): string =>
  positionText(doc, path);

/**
 * Whether a schema declares a label, at its root or below it, with every
 * atom written out. The crate leaves a declaration it did not resolve to
 * atoms as the text of its type (`$source`), which no store can take: a
 * schema that holds one declares nothing here.
 */
const declaresLabel = (schema: unknown): boolean => {
  let declared = false;
  let unresolved = false;
  const visit = (value: unknown, inLabel: boolean, depth: number) => {
    if (typeof value !== "object" || value === null || depth > 32) return;
    if (Array.isArray(value)) {
      for (const member of value) visit(member, inLabel, depth + 1);
      return;
    }
    for (const [name, member] of Object.entries(value)) {
      if (name === "ifc") declared = true;
      if (inLabel && name === "$source") unresolved = true;
      visit(member, inLabel || name === "ifc", depth + 1);
    }
  };
  visit(schema, false, 0);
  return declared && !unresolved;
};

const sameRoot = (a: Root, b: Root): boolean =>
  a.kind === b.kind && a.cell === b.cell && a.collection === b.collection &&
  a.handler === b.handler && a.operation === b.operation &&
  a.child === b.child;

/** What an executed instance counted. */
export type Counts = {
  /** Buckets of a collection index that a change of the index changed. */
  bucketsChanged: number;
  /** Evaluations of a value function, of a per-element function, and of
   * the assembly of a collection. */
  evaluations: number;
  /** Of those, the evaluations of a cone instance of an element body. */
  elementEvaluations: number;
  /**
   * The rows that a resumed instance took as the storage holds them, with
   * no body evaluated, when it formed the table of their collection.
   */
  rowsLeftStored: number;
  /** Of those, the assemblies of a collection, which no cone computes. */
  assemblies: number;
  /**
   * Of the assemblies, those formed whole, from every element of the
   * source, and not brought up to date from the changes of the source.
   */
  assembliesFormed: number;
  /**
   * Segments of a `flatMap` formed: one for each element of the source
   * where the assembly is formed whole, and one for each element whose
   * segment changed where it is brought up to date.
   */
  segmentsFormed: number;
  /** Reads of a slot that the cone of the reading code does not list. */
  slotsNotListed: number;
  /** Reads by root and path, where the value code names no slot. */
  readsWithoutSlot: number;
  /** Reads of an output over no edge of `Plan.edges`. */
  outputsWithoutEdge: number;
  /** Writes of a handler that a write edge or an envelope covers. */
  writesCovered: number;
  writesNotCovered: number;
  /** Reads of the result of an operation, which is pending. */
  pendingOperations: number;
  /**
   * Evaluations that wrote a position they had read. ES §2.7 has such a
   * cone instance stale again; the executor evaluates it once.
   */
  staleByOwnWrite: number;
  /** Evaluations that ended in an error state (PL §5.2). */
  failures: number;
  /**
   * Updates of the group of an element of a collection that a `fold`
   * names, one per evaluation of the element's cone instance and one per
   * element that leaves (provisional decision P31).
   */
  groupUpdates: number;
  /**
   * Entries of a scope key that a derivation brought up to date because
   * nothing else demands them (`Instance.#pullScoped`): one per entry
   * visited, whether or not it was then evaluated.
   */
  scopedPulls: number;
  /**
   * Elements that bringing an assembly up to date from the changes of its
   * source looked at one by one (`Instance.#reassemble`): those numbered
   * again behind a splice of the source, and those of the source and of
   * the result that the membership of a `filter` was formed from; and the
   * rows that bringing the stored rows of a unit up to date compared by
   * key (`Instance.#storeUnit`). The probes of a binary search are not
   * counted.
   */
  elementsVisited: number;
  /**
   * Positions of a result document that storing a value there compared
   * with what the position held or wrote (`Instance.#place`), of every
   * instance of the executor: counted on the instance the executor was
   * started with.
   */
  positionsPlaced: number;
  /**
   * Records of outputs whose inputs were noted again for a change of a
   * label to find (`Instance.#noteRecord`), on the instance the executor
   * was started with.
   */
  recordsNoted: number;
  /**
   * The positions at which noting those records added or removed a
   * reader of a label (`Instance.#recordReaders`), on the instance the
   * executor was started with.
   */
  recordRegistrations: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/**
 * How many times one cone instance is evaluated in one transaction
 * (ES §2.7, "The bound"; SS §8.1). An evaluation that would be one more
 * does not run, and the cone instance fails.
 */
export const MAX_EVALUATIONS = 10;

/**
 * Thrown where a cone reads a value that is in an error state: the
 * reader fails in turn (PL §5.2, "What fails a cone").
 */
class ReadsFailure extends Error {
  constructor(readonly state: ErrorState) {
    super(state.$error.message);
  }
}

/**
 * Whether an error that value code threw is the failure of its cone
 * instance. An error that says what the executor does not do, a name
 * that the value code does not bind, and a stack that ran out stop the
 * instance: they are limits of the prototype and no behavior of the
 * pattern.
 */
const failsCone = (error: unknown): boolean =>
  !(error instanceof Unsupported) && !(error instanceof ReferenceError) &&
  !(error instanceof SyntaxError) && !ranOut(error);

/**
 * Whether an error is the stack of the process running out, and no
 * `RangeError` that the code of a pattern throws itself.
 */
const ranOut = (error: unknown): boolean =>
  error instanceof RangeError && /call stack|does not end/.test(error.message);

const messageOf = (error: unknown): string =>
  `${(error as Error)?.message ?? error}`.split("\n")[0];

/** Whether a schema declares a handle at a position below its own. */
const declaresHandle = (schema: Schema | undefined, depth: number): boolean => {
  if (typeof schema !== "object" || depth > 6) return false;
  const below = [
    ...(schema.items === undefined ? [] : [schema.items]),
    ...Object.values(schema.properties ?? {}),
  ];
  return below.some((member) =>
    typeof member === "object" &&
    (member.asCell !== undefined || declaresHandle(member, depth + 1))
  );
};

const matchesPath = (pattern: readonly string[], path: readonly string[]) =>
  pattern.length <= path.length &&
  pattern.every((segment, index) => segment === "*" || segment === path[index]);

/**
 * The parts of a handle that the executor reads and a body does not: what
 * it names, its `identity` slot with the path below its cell, the schema
 * of its declared type, and whether it refuses a write. `Handle` sets
 * both functions, which read its private fields.
 */
let partsOf: (handle: Handle) => {
  target: Ref | StreamRef;
  slot: number | undefined;
  below: readonly string[];
  declared: Schema | undefined;
  fixed: boolean;
};
/** What a handle names (`partsOf`). */
export let targetOf: (handle: Handle) => Ref | StreamRef;

/**
 * A cell handle given to a sandboxed body (ES §2.4, "Handles"): reads and
 * writes go to the position the handle names.
 */
export class Handle {
  /**
   * The instance, and the host of the cone the body runs in, which records
   * its reads. A body is handed the handle, so the two are private: what
   * reads a member of the handle reaches neither.
   */
  readonly #instance: Instance;
  readonly #host: Host | undefined;
  /**
   * What the handle names. Private as the instance is: a body that reads
   * a member of the handle reaches no reference, no path and no schema,
   * and the executor reads them with `partsOf`.
   */
  readonly #target: Ref | StreamRef;
  readonly #slot: number | undefined;
  readonly #below: readonly string[];
  readonly #declared: Schema | undefined;
  readonly #fixed: boolean;

  static {
    partsOf = (handle) => ({
      target: handle.#target,
      slot: handle.#slot,
      below: handle.#below,
      declared: handle.#declared,
      fixed: handle.#fixed,
    });
    targetOf = (handle) => handle.#target;
  }

  constructor(
    instance: Instance,
    target: Ref | StreamRef,
    host: Host | undefined,
    /** The `identity` slot of the handle, and the path below its cell. */
    slot: number | undefined,
    below: readonly string[],
    /**
     * The schema of the handle's declared type: a position it declares as
     * a handle is one in what a read through the handle gives.
     */
    declared?: Schema,
    /** The handle is to a value with no stored address: a write fails. */
    fixed = false,
  ) {
    this.#instance = instance;
    this.#host = host;
    this.#target = target;
    this.#slot = slot;
    this.#below = below;
    this.#declared = declared;
    this.#fixed = fixed;
    // A body adds no member to a handle and replaces none.
    Object.freeze(this);
  }

  /** A handle of `instance` to the same position that refuses a write. */
  refusingWrites(instance: Instance): Handle {
    return new Handle(
      instance,
      this.#target,
      this.#host,
      this.#slot,
      this.#below,
      this.#declared,
      true,
    );
  }

  get(): unknown {
    if (this.#target instanceof StreamRef) return { $stream: true };
    const target = this.#target;
    return this.#instance.readThrough(
      this,
      () => this.#typed(target, this.#declared, this.#host?.reads, 0),
    );
  }

  sample(): unknown {
    if (this.#target instanceof StreamRef) return { $stream: true };
    return this.#typed(this.#target, this.#declared, undefined, 0);
  }

  /** What a read gives under a schema that declares handles below it. */
  #typed(
    ref: Ref,
    schema: Schema | undefined,
    reads: Position[] | undefined,
    depth: number,
  ): unknown {
    const { store } = this.#instance;
    // A plain value in place that the body reads is a copy (ruling Z25).
    if (!declaresHandle(schema, depth)) {
      return store.read(ref, reads, true, schema);
    }
    const declared = declaredMembers(schema);
    const located = store.locate(ref, true, reads, false, declared);
    const member = (segment: string, at: Ref) => {
      const below = schemaBelow(schema, segment);
      return typeof below === "object" && below.asCell !== undefined
        ? new Handle(this.#instance, at, this.#host, undefined, [], below)
        : this.#typed(at, below, reads, depth + 1);
    };
    if (Array.isArray(located.value)) {
      // A member that is a plain value in place is named by its key, and
      // one that is a link by the position that holds the link (PL §1.3,
      // assumed there under question 115).
      // The key fields that the schema of the read declares, and
      // otherwise those of the array schema that a link on the way to
      // the array holds (ruling Z52).
      const keyFields = keyFieldsOf(schema);
      const keys = store.keysOf(
        located.value,
        located.ref,
        undefined,
        keyFields.length > 0 ? keyFields : keyFieldsOf(located.given),
      );
      return located.value.map((held, index) =>
        member(
          `${index}`,
          isLink(held)
            ? located.ref.key(`${index}`)
            : located.named.key(keySegment(keys[index])),
        )
      );
    }
    if (isRecord(located.value)) {
      // A member the schema does not declare is left out, as a read under
      // a schema that declares no handle leaves it out (`Store.read`).
      return Object.fromEntries(
        Object.keys(located.value).filter((name) =>
          declared === undefined || declared.includes(name)
        ).map((
          name,
        ) => [name, member(name, located.named.key(name))]),
      );
    }
    return store.read(ref, reads, true);
  }

  key(segment: string | number): Handle {
    if (this.#target instanceof StreamRef) return this;
    const target = this.#target.key(`${segment}`);
    const below = [...this.#below, `${segment}`];
    if (this.#host !== undefined && this.#slot !== undefined) {
      this.#instance.noteNamed(this.#host, this.#slot, below, target);
    }
    return new Handle(
      this.#instance,
      target,
      this.#host,
      this.#slot,
      below,
      schemaBelow(this.#declared, `${segment}`),
      this.#fixed,
    );
  }

  set(value: unknown): Handle {
    if (this.#target instanceof StreamRef) {
      this.send(value);
      return this;
    }
    if (this.#fixed) {
      throw new Unsupported(
        "a write through a handle to a value the instance holds no address for",
      );
    }
    const recorded = this.#instance.written(this);
    try {
      this.#instance.store.write(
        this.#target,
        this.#instance.detached(
          this.#target,
          this.#instance.anchored(
            this.#instance.stored(this.#instance.returned(value)),
          ),
        ),
      );
    } finally {
      recorded();
    }
    return this;
  }

  increment(by = 1): void {
    const held = this.get();
    this.set((typeof held === "number" ? held : 0) + by);
  }

  /**
   * Writes each member. It is one write for a reference by key: the key
   * is resolved once, and each member is written at the position found.
   */
  update(members: Record<string, unknown>): Handle {
    const at = this.#target instanceof Ref
      ? this.#instance.store.locate(this.#target, true)
      : undefined;
    const base = at === undefined || at.missing ? this : new Handle(
      this.#instance,
      at.ref,
      this.#host,
      this.#slot,
      this.#below,
      this.#declared,
      this.#fixed,
    );
    for (const [name, member] of Object.entries(members)) {
      base.key(name).set(member);
    }
    return this;
  }

  push(...members: unknown[]): void {
    this.#append(members);
  }

  /**
   * Appends `members` to the list. `decided` is what the caller compared
   * to decide that they are added, which the records of the write hold.
   */
  #append(members: unknown[], decided?: Observed[]): void {
    if (this.#target instanceof StreamRef) return;
    if (this.#fixed) {
      throw new Unsupported(
        "a write through a handle to a value the instance holds no address for",
      );
    }
    const located = this.#instance.store.locate(this.#target, true);
    // Where the place holds nothing, the array starts from the default
    // that the place declares, as a write below the root of a state cell
    // does: the default nearest the end of the links the handle resolves
    // through, or that of the handle's declared type (ruling Z27).
    const declared = located.value !== undefined
      ? undefined
      : located.fallback ??
        (typeof this.#declared === "object"
          ? this.#declared.default
          : undefined);
    const held = Array.isArray(located.value)
      ? located.value
      : Array.isArray(declared)
      ? copyOfData(declared)
      : [];
    const recorded = this.#instance.written(
      this.key("*"),
      decided,
      true,
      this,
    );
    try {
      // A record that is pushed gets a document of its own, as a record
      // in a list that is set does (`Instance.anchored`).
      const pushed = this.#instance.anchored(
        members.map((member) =>
          this.#instance.stored(this.#instance.returned(member))
        ),
      ) as unknown[];
      // An array that is stored is changed in place, as a splice.
      if (Array.isArray(located.value)) {
        this.#instance.store.splice(this.#target, held.length, 0, pushed);
      } else {
        this.#instance.store.write(this.#target, [...held, ...pushed]);
      }
    } finally {
      recorded();
    }
  }

  /**
   * The positions of this list that hold `member`, the first of them alone
   * with `first`: the positions a reference names, for a handle, a
   * reference stand-in or a value read from a cell, and the positions that
   * hold an equal value, for a copy of a plain value (ruling Z25). `read`
   * is what the comparison observed of the stored list: which positions it
   * has, the reference at each compared position that holds a link, whose
   * target it does not read, and the value at each compared position that
   * holds a plain value in place.
   */
  #positionsOf(
    member: unknown,
    first = false,
  ): { positions: number[]; read: Observed[]; list?: Address } {
    if (this.#target instanceof StreamRef) return { positions: [], read: [] };
    const { store } = this.#instance;
    const list = this.#target;
    const located = store.locate(list, true);
    if (!Array.isArray(located.value)) return { positions: [], read: [] };
    const { doc, path } = located.ref;
    const read: Observed[] = [{
      address: { doc, path: [...path] },
      observes: "enumeration",
    }];
    const positions: number[] = [];
    for (let index = 0; index < located.value.length; index++) {
      const held = located.value[index];
      const at = list.key(`${index}`);
      // A position that holds a link is compared as the reference it
      // holds, which reads nothing of the document the link names.
      let same = this.#instance.unreported(() =>
        this.#instance.same(at, member)
      );
      if (isLink(held)) {
        read.push({
          address: { doc, path: [...path, `${index}`] },
          observes: "identity",
        });
      } else {
        read.push({
          address: { doc, path: [...path, `${index}`] },
          observes: "value",
        });
        same ||= this.#instance.same(
          store.read(located.ref.key(`${index}`), undefined, true),
          member,
        );
      }
      if (!same) continue;
      positions.push(index);
      if (first) break;
    }
    return { positions, read, list: { doc, path: [...path] } };
  }

  /**
   * Reports that a method left the members of the stored list at `list`
   * as they were, because of what it compared (`decided`): a removal that
   * found no member to remove, and `addUnique` of a member the list holds.
   * `through` is the handle the method would have written through. The
   * membership of the list then stores what decided that it stays (ruling
   * Z67).
   */
  #kept(through: Handle, decided: Observed[], list: Address | undefined): void {
    if (list === undefined) return;
    const recorded = this.#instance.written(through, decided, false);
    try {
      this.#instance.membersKept(list);
    } finally {
      recorded();
    }
  }

  /**
   * Removes the members at `positions` from the stored list in place, each
   * as a splice of the list: no member the list keeps is written, and one
   * that is a reference stays the reference it was, to a document the
   * removal does not write. `decided` is what the comparison that found
   * the positions read, which the records of the removal hold.
   */
  #removeAt(positions: readonly number[], decided: Observed[]): void {
    if (this.#target instanceof StreamRef || positions.length === 0) return;
    if (this.#fixed) {
      throw new Unsupported(
        "a write through a handle to a value the instance holds no address for",
      );
    }
    const recorded = this.#instance.written(this, decided);
    try {
      // From the last position on, so that each position named is the one
      // the member holds when it is removed, and each run of positions next
      // to each other as one splice.
      const last = [...positions].sort((a, b) => b - a);
      for (let run = 0; run < last.length;) {
        let end = run;
        while (end + 1 < last.length && last[end + 1] === last[end] - 1) {
          end++;
        }
        this.#instance.store.splice(this.#target, last[end], end - run + 1, []);
        run = end + 1;
      }
    } finally {
      recorded();
    }
  }

  remove(member: unknown): void {
    const { positions, read, list } = this.#positionsOf(member, true);
    if (positions.length === 0) this.#kept(this, read, list);
    else this.#removeAt(positions, read);
  }

  send(event: unknown): void {
    if (this.#target instanceof StreamRef) {
      this.#instance.queue(this.#target, event);
      return;
    }
    const located = this.#instance.store.locate(this.#target, true);
    if (isStream(located.value)) {
      const { binding, keys, instance } = located.value.$stream;
      this.#instance.queue(new StreamRef(binding, keys, instance), event);
      return;
    }
    // A stream the instance was given, which the argument holds nothing
    // for, takes no event: the executor has no other instance. The send
    // is a write of the handler all the same.
    if (
      located.value === undefined &&
      isStreamSchema(located.ref.schema ?? this.#declared)
    ) {
      this.#instance.written(this)();
      return;
    }
    this.set(event);
  }

  removeAll(member: unknown): void {
    const { positions, read, list } = this.#positionsOf(member);
    if (positions.length === 0) this.#kept(this, read, list);
    else this.#removeAt(positions, read);
  }

  /** Removes each member that is `member` (`removeByValue` of a cell). */
  removeByValue(member: unknown): void {
    this.removeAll(member);
  }

  /** Appends `member` unless the list holds it (`addUnique` of a cell). */
  addUnique(member: unknown): void {
    const { positions, read, list } = this.#positionsOf(member, true);
    if (positions.length > 0) this.#kept(this.key("*"), read, list);
    else this.#append([member], read);
  }

  /**
   * The record of a key of this list (`elementById` of a cell): a cell of
   * its own, named by the address of the list and the key, which is no
   * member of the list until a body adds a reference to it, as
   * `addUnique` does (ES §2.4, "The record of a key of a list"; ruling
   * Z23). A write through the handle is a write to the record: it is at
   * no position of the list and makes no reader of the list stale. The
   * plan has no record for it. `footprint-analysis.md` §7 records the
   * handle at `*` below the list, so the handle has that path for the
   * count of the writes that a write edge or an envelope of the body
   * covers (`Instance.written`), and for nothing else.
   */
  elementById(key: unknown): Handle {
    if (this.#target instanceof StreamRef) return this;
    return new Handle(
      this.#instance,
      this.#instance.keyedElement(this.#target, `${key}`),
      this.#host,
      this.#slot,
      [...this.#below, "*"],
      schemaBelow(this.#declared, "0"),
    );
  }

  equals(other: unknown): boolean {
    return this.#instance.same(this, other);
  }

  resolveAsCell(): Handle {
    return this;
  }

  for(): Handle {
    return this;
  }

  asSchema(): Handle {
    return this;
  }

  withTx(): Handle {
    return this;
  }
}

/**
 * The stored containers that a body is handed with the address they were
 * read from, as the objects the store holds (`Store.handed`): the value
 * of each `value` entry of its argument, and each stored container in a
 * copy that such an entry holds. A container below one of them has the
 * address `Store.addressesBelow` gives, which is found for all of them
 * when one is first asked for, so a body that passes none of them on
 * costs nothing for them.
 */
class HandedValues {
  readonly #store: Store;
  readonly #roots = new Map<object, Handed>();
  #below: Map<object, Ref> | undefined;

  constructor(store: Store) {
    this.#store = store;
  }

  /** Notes what a read gave a body, straight after the read. */
  note(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    if (this.#store.holds(value)) {
      const handed = this.#store.handed.get(value);
      if (handed !== undefined) {
        this.#roots.set(value, handed);
        this.#below = undefined;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const member of value) this.note(member);
    } else if (
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    ) {
      for (const member of Object.values(value)) this.note(member);
    }
  }

  /** The address a container was handed with, where it was with one. */
  addressOf(value: object): Ref | undefined {
    const root = this.#roots.get(value);
    if (root !== undefined) return root.at;
    if (this.#roots.size === 0) return undefined;
    if (this.#below === undefined) {
      this.#below = new Map();
      for (const [container, handed] of this.#roots) {
        this.#store.addressesBelow(container, handed, this.#below);
      }
    }
    return this.#below.get(value);
  }
}

/**
 * What the runtime hands a cone's value function (ES §2.2, `ConeHost`),
 * with the reads its evaluation made.
 */
export class Host {
  readonly reads: Position[] = [];
  readonly dependencies: Dependency[] = [];
  readonly indexes = new Map<number, number>();
  /** The elements of the collection being assembled, with their keys. */
  members: Element[] | undefined;
  readonly writers: Writer[] = [];
  /**
   * For the evaluation of the step of a `reduce`: the operation, and the
   * value of its accumulator before this element.
   */
  accumulator: { operation: number; value: unknown } | undefined;
  /**
   * When the last cone this evaluation demanded through a write target
   * had been evaluated: the clock, and how many reads it had made.
   */
  demandedAt: { clock: number; reads: number } | undefined;
  /** What the evaluation bound each slot it read to, by the slot. */
  readonly bound = new Map<number, Bound>();
  /**
   * The slots of `bound` that no read bound, each to the positions a body
   * named through a handle (`Instance.noteNamed`).
   */
  readonly namedOnly = new Set<number>();
  /** The slots a body named too many positions of for `noteNamed` to bind. */
  readonly namedMany = new Set<number>();
  /** The branch each selector took, as the value code reported it. */
  readonly selections = new Map<number, number>();
  /** The key each pick chose, as the value code reported it. */
  readonly picks = new Map<number, string | null>();
  /**
   * The positions read through the handle each entry of
   * `Plan.dynamicReads` names, by the entry.
   */
  readonly dynamic = new Map<number, Address[]>();
  /**
   * The instance whose code is evaluated. Value code is handed the host
   * of each call, and reads no member of it that holds the executor.
   */
  readonly #instance: Instance;

  constructor(
    instance: Instance,
    readonly context: Context,
    /** The cone of the code being evaluated, where it belongs to one. */
    readonly cone: number | undefined,
    /** The name of the memo entry being evaluated, where it is one. */
    readonly key?: string,
  ) {
    this.#instance = instance;
  }

  /**
   * The value of a slot, or its reference for an `identity` slot, or of
   * the path `rest` below it. For the slot of the chosen child of a
   * `pick`, at `*`, the first segment of `rest` is the key the pick chose
   * and stands in the place of `*`, so that the read is of that child
   * alone; with no `rest` it yields every child of the container (ES
   * §2.2).
   */
  slot(index: number, rest: readonly unknown[] = []): unknown {
    const instance = this.#instance;
    if (
      this.cone !== undefined &&
      !instance.plan.cones[this.cone].slots.includes(index)
    ) {
      instance.counts.slotsNotListed += 1;
    }
    const slot = instance.plan.slots[index];
    const children = slot.path[slot.path.length - 1] === "*";
    const path = children ? slot.path.slice(0, -1) : slot.path;
    const below = rest.map((segment) => `${segment}`);
    this.demand(slot.root, [...path, ...below]);
    const from = this.reads.length;
    const found = this.at(
      instance.rootOf(slot.root, this, [...path, ...below]),
      [...path, ...below],
    );
    // Where nothing is stored, a slot reads as the default of the place
    // (ES §2.2): the default its schema declares, which for the slot of
    // the chosen child is that of the child.
    const schema = !children
      ? below.reduce(schemaBelow, instance.schemaOf(slot.schema))
      : below.length > 0
      ? below.slice(1).reduce(schemaBelow, instance.schemaOf(slot.schema))
      : undefined;
    if (slot.observes === "identity") {
      // A stream that is an input of the pattern is a reference like any
      // other: what passes it on stores a link to its place (ES §2.2, "A
      // stream that is an input of the pattern").
      instance.bindSlot(this, index, from, found);
      return found instanceof Ref ? found.withSchema(schema) : found;
    }
    const bound = this.#handsHandles(index) ? membersUnread(schema) : schema;
    const read = this.v(found, bound);
    // A stored container that the read gave as the object the store holds
    // lacks no default of the schema it was read under.
    const value =
      found instanceof Ref && bound === schema && instance.store.plain(read)
        ? read
        : withDefaults(read, schema);
    instance.bindSlot(this, index, from, found);
    return value;
  }

  /**
   * Whether the read of an `enumeration` slot gives which children its
   * container has and reads none of them. It does where no slot of the
   * cone reads a child, or below one, as a value or a shape, and where
   * every body of the cone that is handed the container is handed a handle
   * at each child: the body declares a handle at `*` below the place the
   * slot has in its argument (`Body.reads`, `handle`), and reaches a child
   * through that handle alone. Otherwise a body is handed the children
   * with the container, and the read follows them.
   */
  #handsHandles(index: number): boolean {
    const { plan } = this.#instance;
    if (
      this.cone === undefined || plan.slots[index].observes !== "enumeration"
    ) {
      return false;
    }
    const { root, path } = plan.slots[index];
    const cone = plan.cones[this.cone];
    // No slot of the cone reads a child, or below one, as anything but a
    // reference.
    if (
      !cone.slots.some((other) => {
        const slot = plan.slots[other];
        return slot.observes !== "identity" && sameRoot(slot.root, root) &&
          slot.path.length > path.length && slot.path[path.length] === "*" &&
          path.every((segment, at) => segment === slot.path[at]);
      })
    ) return true;
    let handed = false;
    for (const body of cone.bodies) {
      const { reads } = plan.bodies[body];
      for (const { slot, at } of reads) {
        if (slot !== index) continue;
        const child = JSON.stringify([...at, "*"]);
        if (
          !reads.some((read) =>
            read.handle === true && JSON.stringify(read.at) === child
          )
        ) return false;
        handed = true;
      }
    }
    return handed;
  }

  /**
   * Records the branch a selector of the cone took (PL §3.5), from the
   * value of its test: the first branch where the test is truthy, or
   * with `presence` where it holds something, and the second otherwise.
   * Gives the value back, so the test reads as it is written.
   */
  select(selector: number, test: unknown, presence = false): unknown {
    const taken = presence ? test !== undefined && test !== null : !!test;
    this.selections.set(selector, taken ? 0 : 1);
    return test;
  }

  /**
   * The operand that `??`, `||` or `&&` selects (PL §3.5), from the value
   * `test` that the left operand resolves to. Where the left operand is
   * selected and holds a record or an array, the result is what `left`
   * gives, which is the operand as the reference it is, and where it
   * holds a scalar the result is that value. The right operand is
   * evaluated where it is selected.
   */
  operand(
    operator: "??" | "||" | "&&",
    test: unknown,
    left: () => unknown,
    right: () => unknown,
  ): unknown {
    const takesRight = operator === "??"
      ? test === undefined || test === null
      : operator === "||"
      ? !test
      : Boolean(test);
    if (takesRight) return right();
    return typeof test === "object" && test !== null ? left() : test;
  }

  /**
   * Records the key a pick of the cone chose (PL §3.18), with
   * `chosenBy: "valueCode"`: the key as a text, and `null` for none.
   * Gives the key back.
   */
  pick(pick: number, key: unknown): unknown {
    this.picks.set(
      pick,
      key === undefined || key === null ? null : `${key as string}`,
    );
    return key;
  }

  /**
   * Fails the cone of the code being evaluated where it reads a value in
   * an error state (PL §5.2, "What fails a cone"). Code that places such
   * a value and reads nothing of it passes the error state on at the
   * position: a member of a record, a child of a view node, an element
   * of the result of a `map` (PL §5.3).
   */
  #reading<T>(value: T): T {
    if (this.cone !== undefined && isErrorState(value)) {
      throw new ReadsFailure(value);
    }
    return value;
  }

  /** A read of a place that the value code names no slot for. */
  read(root: Root, path: string[]): unknown {
    this.#instance.counts.readsWithoutSlot += 1;
    this.demand(root, path);
    return this.at(this.#instance.rootOf(root, this), path);
  }

  /**
   * Evaluates first the cones that write, as a static side-write, what a
   * read of `path` below `root` reads or passes on by reference: the
   * target of a write edge counts as an output of its cone for demand
   * (ES §2.3, "A cone with side-writes").
   */
  demand(root: Root, path: readonly string[]): void {
    const writers = this.#instance.writersOf(root, path, this.cone);
    if (writers.length === 0) return;
    for (const writer of writers) {
      if (!this.writers.includes(writer)) this.writers.push(writer);
      writer(this.context);
    }
    this.demandedAt = {
      clock: this.#instance.store.clock,
      reads: this.reads.length,
    };
  }

  /**
   * The value of an entry of `Plan.outputs`, or what it holds at `path`.
   * A reader of a path of the value a value function computes depends on
   * what the value holds there and on nothing else of it (`dependAt`).
   */
  output(index: number, path?: readonly unknown[]): unknown {
    const instance = this.#instance;
    const output = instance.plan.outputs[index];
    // The result holds a reference in the place of an output that was
    // evaluated for one scope key.
    if (this.key === RESULT && instance.store.scopes !== undefined) {
      const placed = instance.scopedOutput(index, this);
      if (placed !== undefined) return this.#below(placed, path);
    }
    // So does the cone of another value: a value of a scope key that a
    // cone of the space places, or reads through the reference, leaves
    // the cone of the space (P451), in an element body as outside every
    // one (P454). An evaluation that is no cone, as an assembly or the
    // place of an output in a scope instance, is given the value.
    if (
      this.key !== RESULT && instance.store.scopes !== undefined &&
      this.cone !== undefined && output.cone !== this.cone
    ) {
      const placed = instance.scopedValue(index, this);
      if (placed !== undefined) return this.#below(placed, path);
    }
    return this.#output(index, output, path);
  }

  /** What `value` holds at `path`, and `value` itself for no path. */
  #below(value: unknown, path: readonly unknown[] | undefined): unknown {
    return path === undefined ? value : this.at(value, path);
  }

  /** `output()`, for an output that is given as it was evaluated. */
  #output(
    index: number,
    output: Plan["outputs"][number],
    path: readonly unknown[] | undefined,
  ): unknown {
    const instance = this.#instance;
    if (
      this.cone !== undefined && output.cone !== this.cone &&
      !instance.plan.edges.some((edge) =>
        edge.to === this.cone && edge.via.kind === "output" &&
        edge.via.output === index
      )
    ) {
      instance.counts.outputsWithoutEdge += 1;
    }
    if (
      output.collection !== undefined &&
      buildsIndex(instance.plan.collections[output.collection].construct)
    ) {
      // An index is held by reference, so that a cone that looks up a key
      // depends on one bucket. The result of the instance holds the index
      // whole, unless its buckets are documents of their own: the result
      // then holds the reference, and the buckets that changed are stored
      // by themselves (`Instance.#storeIndex`).
      const handle = new IndexHandle(output.collection, this.context);
      return this.#below(
        this.cone === undefined &&
          instance.bucketRecordOf(output.collection) === undefined
          ? this.settled(handle)
          : handle,
        path,
      );
    }
    if (output.collection !== undefined) {
      // The result of a construct that assembles rows is held by
      // reference until something observes it.
      return this.#below(
        assemblesRows(
            instance.plan.collections[output.collection].construct,
          )
          ? instance.assembledBy(output.collection, this.context)
          : this.depend(instance.assembled(output.collection)),
        path,
      );
    }
    const value = instance.valueOfOutput.get(index);
    if (value === undefined) {
      const below = instance.code.outputsBelow.find((entry) =>
        entry.output === index
      );
      if (below !== undefined) {
        return this.value(below.value, [...below.path, ...(path ?? [])]);
      }
      throw new Unsupported(
        `an output that no value function computes: output ${index}, ${
          JSON.stringify(output).slice(0, 300)
        }`,
      );
    }
    if (path !== undefined && path.length > 0) return this.value(value, path);
    const held = this.value(value);
    if (Array.isArray(held)) {
      instance.returnedWhole.set(held, {
        output: index,
        context: this.context,
      });
    }
    return held;
  }

  /**
   * The value a value function computes, by the value's number, or what
   * it holds at `path`, on which alone the reader then depends.
   */
  value(value: number, path?: readonly unknown[]): unknown {
    const entry = this.#instance.evaluated(value);
    return path === undefined || path.length === 0
      ? this.depend(entry)
      : this.dependAt(entry, path);
  }

  /** The evaluation that the host was made for has ended. */
  done = false;

  /**
   * For the assembly of a collection over a stored array: the array as
   * it was found, and which reads found it and which an element.
   */
  found: {
    base: Ref;
    named: Ref;
    held: readonly unknown[];
    fields: readonly string[];
    arrayReads: Set<Position>;
    elementReads: Map<Position, string>;
  } | undefined;
  /** The assembly that the table of the collection was taken from. */
  from: { collection: number; entry: Entry } | undefined;
  rows: Rows | undefined;

  /**
   * The array that a reference to an assembled collection stands for,
   * which this evaluation then depends on, and any other value as it
   * is.
   */
  settled(value: unknown): unknown {
    if (value instanceof IndexHandle) {
      const instance = this.#instance;
      const assembled = instance.assembled(indexPartsOf(value).collection);
      const entry: Lazy = () =>
        assembled(instance.freshContext(indexPartsOf(value).context));
      const index = this.done ? entry(this.context).value : this.depend(entry);
      return instance.indexRecord(
        index as Index,
        this,
        indexPartsOf(value).collection,
      );
    }
    if (!(value instanceof Assembled)) return value;
    const instance = this.#instance;
    const assembled = instance.assembled(value.collection);
    const entry: Lazy = () => assembled(instance.freshContext(value.context));
    // A stamp of a dependency that looks below a reference after the
    // evaluation ended reads the array and records nothing.
    return this.done ? entry(this.context).value : this.depend(entry);
  }

  /** A value with each reference to an assembled collection settled. */
  whole(value: unknown): unknown {
    if (value instanceof Assembled || value instanceof IndexHandle) {
      return this.whole(this.settled(value));
    }
    // A stored container holds no reference to an assembled collection.
    if (this.#instance.store.plain(value)) return value;
    if (Array.isArray(value)) return value.map((member) => this.whole(member));
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([name, member]) => [
          name,
          this.whole(member),
        ]),
      );
    }
    return value;
  }

  /**
   * The value of another entry, which this evaluation then depends on:
   * on any change of it, or with `path` on a change of what it holds at
   * that path.
   */
  depend(entry: Lazy, path?: readonly string[]): unknown {
    return this.dependEntry(entry, path).value;
  }

  /**
   * What `entry` holds at `path`, which the evaluation depends on alone:
   * an evaluation of the entry that leaves what it holds there as it was
   * evaluates nothing here, as a write of another member of a stored
   * record evaluates nothing that read one member.
   */
  dependAt(entry: Lazy, path: readonly unknown[]): unknown {
    const segments = path.map((segment) => `${segment}`);
    return this.at(this.dependEntry(entry, segments).value, segments);
  }

  dependEntry(entry: Lazy, path?: readonly string[]): Entry {
    const used = entry(this.context);
    const on = used.owner === this.#instance ? used.key : undefined;
    if (on !== undefined && this.key !== undefined) {
      this.#instance.uses(this.key, on);
    }
    if (path === undefined) {
      this.dependencies.push({
        stamp: (context) => entry(context).changedAt,
        seen: used.changedAt,
        ...(on === undefined ? {} : { on }),
      });
    } else {
      const held = (from: Entry) =>
        canonical(this.#instance.stored(this.at(from.value, path)));
      this.dependencies.push({
        stamp: (context) => held(entry(context)),
        seen: held(used),
        ...(on === undefined ? {} : { on }),
      });
    }
    return used;
  }

  /**
   * `index.lookup(key)` (PL §3.17): the members of the bucket of `key` in
   * source order for an index in `group` mode, and the first of them, or
   * nothing, in `key` mode. The evaluation depends on that one bucket, by
   * the name that stands for it, which a change of the bucket marks: a
   * change of another bucket evaluates nothing here. A key that no element
   * has gives the empty bucket, and the evaluation depends on it as well.
   */
  lookup(index: unknown, key: unknown, pick?: number): unknown {
    const instance = this.#instance;
    const stored = index instanceof Handle ? targetOf(index) : index;
    if (stored instanceof Ref) {
      // An index that another instance keeps: the bucket is the member of
      // its `buckets` under the encoded key, given as a reference, so that
      // what reads it reads that position of the stored index and no
      // other bucket. A key that has no bucket names a position that
      // holds nothing.
      const encoded = encodeIndexKey(instance, key);
      if (pick !== undefined) this.pick(pick, encoded);
      return encoded === undefined ? [] : stored.key("buckets").key(encoded);
    }
    if (!(index instanceof IndexHandle)) {
      throw new Unsupported("a `lookup` on what is no collection index");
    }
    const assembled = instance.assembled(indexPartsOf(index).collection);
    const lazy: Lazy = () =>
      assembled(instance.freshContext(indexPartsOf(index).context));
    const entry = lazy(this.context);
    const held = entry.value as Index;
    const encoded = encodeIndexKey(instance, key);
    if (encoded === undefined || entry.key === undefined) {
      this.dependEntry(lazy);
      return held.mode === "group" ? [] : undefined;
    }
    const name = bucketName(entry.key, encoded);
    if (this.key !== undefined) instance.uses(this.key, name);
    const version = (from: Entry) =>
      (from.value as Index).buckets.get(encoded)?.version ?? 0;
    this.dependencies.push({
      stamp: (context) => version(lazy(context)),
      seen: version(entry),
      on: name,
    });
    // An index written in an element body is brought up to date when it is
    // read and by nothing else, so its readers depend on it whole.
    if (
      instance.plan.collections[indexPartsOf(index).collection].within.length >
        0
    ) {
      this.dependEntry(lazy);
    }
    const keys = held.buckets.get(encoded)?.keys ?? [];
    const members = keys.map((element) =>
      instance.indexMember(held, element, this)
    );
    if (held.mode !== "group") return members[0];
    // The members of a bucket are elements of the index's source, with the
    // keys they have there: a per-element construct over the bucket takes
    // them as its elements and forms no key from what a member holds.
    bucketElements.set(members, instance.indexElements(held, keys));
    const record = keys.length === 0
      ? undefined
      : instance.bucketRecordOf(indexPartsOf(index).collection);
    if (record !== undefined) {
      bucketPlaces.set(members, new Ref(instance.id, [...record, encoded]));
    }
    return members;
  }

  /**
   * A marker for the stream of a binding (ES §2.2, `ConeHost.stream`),
   * for the element keys this evaluation has at the `element` steps of
   * the binding's `within`. The code that is given it can place it in a
   * value and can do nothing else with it: the marker has no member, and
   * `v` and `at` read nothing through it.
   */
  stream(binding: number): StreamMarker {
    return markerOf(this.#instance.streamFor(binding, this.context));
  }

  /**
   * Whether two operands name one thing (PL §3.16): each reference is
   * resolved to the position it names now, and the two are compared
   * there (ruling Z26). The evaluation depends on the links each
   * reference crossed and on the outcome of the comparison, and on no
   * position: an element that moves with its key is the same element,
   * so a move evaluates nothing for a comparison of two references by
   * key.
   */
  equals(left: unknown, right: unknown): boolean {
    const [a, b] = [this.settled(left), this.settled(right)];
    for (const operand of [a, b]) {
      if (operand instanceof Ref) {
        this.#instance.store.locate(operand, true, this.reads, true);
      }
    }
    const seen = this.#instance.same(a, b, true);
    this.dependencies.push({
      stamp: () => this.#instance.same(a, b, true),
      seen,
    });
    return seen;
  }

  /**
   * A value with every reference in it replaced by what it refers to.
   * With `bound`, a stored value is read under that schema
   * (`Store.read`).
   */
  v(value: unknown, bound?: Schema): unknown {
    if (value instanceof Assembled || value instanceof IndexHandle) {
      return this.v(this.settled(value));
    }
    if (value instanceof Ref) {
      return this.#reading(
        this.#instance.store.read(value, this.reads, false, bound),
      );
    }
    this.#reading(value);
    if (value instanceof StreamRef) return { $stream: true };
    // A marker is read through by nothing: it stays the marker.
    if (value instanceof StreamMarker) return value;
    if (value instanceof Handle) return value.get();
    // A stored container holds no reference, and each record in it holds
    // its members in the order of the storage.
    if (this.#instance.store.plain(value)) return value;
    if (Array.isArray(value)) return value.map((member) => this.v(member));
    if (isRecord(value)) {
      // A record a computation made, in the order a read of it from the
      // storage gives (`membersInOrder`).
      return Object.fromEntries(
        membersInOrder(value).map((name) => [name, this.v(value[name])]),
      );
    }
    return value;
  }

  /**
   * The members `names` of a value another cone computes, spread into a
   * record (P454): where `value` is the reference to the place of a value
   * of a scope key, each member as a reference into that place, so the
   * record reads nothing of the scope, and otherwise the value read whole,
   * as a spread reads it.
   */
  spreadMembers(value: unknown, names: readonly string[]): unknown {
    if (value instanceof Ref && this.#instance.isScopedPlace(value)) {
      return Object.fromEntries(names.map((name) => [name, value.key(name)]));
    }
    return this.v(value);
  }

  /** A path below a value: a reference stays one, and nothing gives none. */
  at(value: unknown, path: readonly unknown[]): unknown {
    let found = value;
    for (const segment of path) {
      found = this.settled(found);
      this.#reading(found);
      if (found instanceof Ref) {
        found = found.key(`${segment}`);
      } else if (found instanceof Handle) {
        found = targetOf(found.key(`${segment}`));
      } else if (typeof found === "string") {
        found = segment === "length" ? found.length : undefined;
      } else if (typeof found !== "object" || found === null) {
        return undefined;
      } else if (found instanceof StreamRef || found instanceof StreamMarker) {
        return undefined;
      } else {
        const holder = found;
        found = (holder as Record<string, unknown>)[`${segment}`];
        // A member of a stored container that a read gave as the object
        // the store holds carries its address as the container does.
        this.#instance.store.handMember(holder, `${segment}`, found);
      }
    }
    return found;
  }

  /**
   * A reference with a default for where nothing is stored, and the
   * default in the place of nothing: a path of the argument of a pattern
   * compiled in that the callee passes on carries the default the callee
   * declares for it (ruling Z16).
   */
  withDefault(value: unknown, fallback: unknown): unknown {
    if (value instanceof Ref) return value.withDefault(fallback);
    return value === undefined ? copyOfData(fallback) : value;
  }

  /**
   * Runs a sandboxed body of the cone (ES §2.4). An entry of `Body.reads`
   * of a body of a pattern compiled in holds the default the callee
   * declares for the path the call bound to the slot: the body is handed
   * it at the entry's place where the slot yields nothing and no place
   * the slot resolves through declares a default of its own (ruling Z16).
   */
  invoke(body: number, computed: unknown): unknown {
    const instance = this.#instance;
    const run = instance.bodies.get(body);
    if (run === undefined) {
      throw new Unsupported("a body that has no function");
    }
    const handed = new HandedValues(instance.store);
    return instance.handing(
      handed,
      () => this.#invoke(body, run, computed, handed),
    );
  }

  /**
   * `invoke`, for the function `run` of the body and what the body is
   * handed with an address (`handed`).
   */
  #invoke(
    body: number,
    run: (...given: unknown[]) => unknown,
    computed: unknown,
    handed: HandedValues,
  ): unknown {
    const instance = this.#instance;
    // What the body reads as a value, of the computed part and of the
    // slot part: a reference the cone computed that leads to a place a
    // `value` entry of `Body.reads` is at or below is read as a value too,
    // since an `enumeration` or a `shape` entry of the slot part gives way
    // to what the argument holds at its path (`Instance.gives`).
    //
    // A path that an entry of `Body.reads` fills below is not read here:
    // the entry reads its slot once and puts the value or the handle
    // there, in the place of whatever the computed part held.
    const filled = new Set<string>();
    {
      const { reads } = instance.plan.bodies[body];
      const valuedAt = new Set(
        reads.filter(({ slot }) =>
          instance.plan.slots[slot].observes === "value"
        ).map(({ at }) => JSON.stringify(at)),
      );
      for (const { slot, at, handle } of reads) {
        if (at.includes("*")) continue;
        const { observes } = instance.plan.slots[slot];
        if (
          observes === "value" ||
          (observes === "identity" &&
            (handle !== undefined || !valuedAt.has(JSON.stringify(at))))
        ) filled.add(JSON.stringify(at));
      }
    }
    // An `identity` entry of `Body.computed` is a handle to the reference
    // the cone computed there (ES §2.4, "A handle or a reference from a
    // computed input"). An entry at a path through `*` stands for each
    // child the path reaches, as each row of the result of a `map` that
    // holds a reference: `pass` hands each such child as the handle and
    // reads nothing of what it names.
    const identities = instance.plan.bodies[body].computed.filter((
      { observes },
    ) => observes === "identity");
    let argument = this.pass(computed, {
      entries: [
        ...instance.plan.bodies[body].computed,
        ...instance.plan.bodies[body].reads.map(({ slot, at }) => ({
          at,
          observes: instance.plan.slots[slot].observes,
        })),
      ],
      filled,
      handles: identities.filter(({ at }) => at.includes("*")),
    });
    for (const { at, schema } of identities) {
      if (at.includes("*")) continue;
      const handle = this.#handleAt(this.at(computed, at), schema);
      if (handle !== undefined) {
        argument = instance.placed(argument, at, handle);
      }
    }
    // The slot part of the argument: each entry of `Body.reads` at its
    // place (PL §1.1, `ReadInput`).
    const layout = [...instance.plan.bodies[body].reads].sort((a, b) =>
      a.at.length - b.at.length
    );
    // The places where the body reads the value. Where the body declares
    // no handle at such a place, the `value` entry holds the value with
    // its address (ES §2.4, "What the argument holds at a path"), and an
    // `identity` entry there is the slot of the place that another body
    // declares a handle at.
    const valued = new Set(
      layout.filter(({ slot }) =>
        instance.plan.slots[slot].observes === "value"
      ).map(({ at }) => JSON.stringify(at)),
    );
    for (const { slot, at, default: declared, handle, schema } of layout) {
      const star = at.indexOf("*");
      // A slot at `*` stands for each element: the container is given
      // whole by the slot at its own path, where the body lists one.
      if (star >= 0) continue;
      const { observes } = instance.plan.slots[slot];
      if (
        observes === "identity" && handle === undefined &&
        valued.has(JSON.stringify(at))
      ) continue;
      // An entry that gives way to what the argument holds at its path
      // reads nothing.
      if (instance.gives(observes, argument, at)) continue;
      // The slot reads the default of its own place first.
      const read = declared === undefined
        ? this.slot(slot)
        : this.withDefault(this.slot(slot), declared);
      const given = observes === "identity"
        ? instance.handleOf(read, this, slot, handle && schema)
        : read;
      if (observes !== "identity") handed.note(given);
      if (given === undefined) {
        // The result of an operation is a record that is there while
        // its members hold nothing: a body that names `fetched.result`
        // is handed `fetched` (BI, "The refused globals").
        const { root, path } = instance.plan.slots[slot];
        const above = at.slice(0, at.length - path.length);
        if (
          root.kind === "operation" && above.length > 0 &&
          this.at(argument, above) === undefined
        ) {
          argument = instance.placed(argument, above, {});
        }
        continue;
      }
      argument = instance.placed(argument, at, given);
    }
    // An entry at `*` where the body declares a handle is placed at each
    // child the path reaches (ES §2.4): each element of a stored array,
    // and each member of a stored record, is a handle to its position,
    // over references and over plain values in place alike.
    for (const { slot, at, handle, schema } of layout) {
      const { root, path } = instance.plan.slots[slot];
      if (
        handle === undefined || at.indexOf("*") !== at.length - 1 ||
        path.indexOf("*") !== path.length - 1
      ) continue;
      const above = path.slice(0, -1);
      const container = this.at(instance.rootOf(root, this, above), above);
      const held = this.at(argument, at.slice(0, -1));
      if (!(container instanceof Ref)) continue;
      const child = (key: string) =>
        instance.handleOf(container.key(key), this, slot, schema);
      if (Array.isArray(held)) {
        argument = instance.placed(
          argument,
          at.slice(0, -1),
          held.map((_, index) => child(`${index}`)),
        );
      } else if (isRecord(held) && !(held instanceof Handle)) {
        argument = instance.placed(
          argument,
          at.slice(0, -1),
          Object.fromEntries(Object.keys(held).map((key) => [key, child(key)])),
        );
      }
    }
    const keyed = { body, keys: instance.contextKeys(this.context) };
    return instance.returned(
      instance.runBody(
        body,
        this,
        () =>
          instance.during(
            instance.runCause(keyed),
            () => run(argument),
            keyed,
          ),
      ),
    );
  }

  /**
   * What a body is handed for what the cone computed at the path of an
   * `identity` entry of `Body.computed`: a handle to the reference there,
   * or nothing where it holds none. A marker is handed as the reference
   * to its stream (ES §2.2, assumed there under question 78). An array
   * that a body returned whole is a handle to its place: the path of the
   * result where the output is kept, or the document of the output (FA
   * §6.2, "A handle bound to a value the instance computed"; ruling Z53).
   */
  #handleAt(reference: unknown, schema: string | undefined): unknown {
    const instance = this.#instance;
    if (
      reference instanceof Ref || reference instanceof StreamRef ||
      reference instanceof StreamMarker
    ) return instance.handleOf(reference, this, undefined, schema);
    const held = reference instanceof Assembled
      ? this.settled(reference)
      : reference;
    const output = Array.isArray(held)
      ? instance.placeOfOutput(held)
      : undefined;
    return output === undefined
      ? undefined
      : instance.handleOf(output, this, undefined, schema);
  }

  /**
   * The members of the operand of a spread in the reactive tier, each as
   * what its position holds: the reference to the cell where the position
   * holds a link, and the value where it holds one. So a spread of an
   * array of references stores the links, and a spread of plain values in
   * place stores the values. An operand that the instance computed gives
   * its members as they are, and one that holds nothing gives none.
   */
  spread(given: unknown): unknown[] {
    const value = this.settled(given);
    if (value instanceof Ref) {
      const { store } = this.#instance;
      const located = store.locate(value, true, this.reads);
      const held = located.value;
      if (Array.isArray(held)) {
        return held.map((member, index) =>
          isLink(member)
            ? new Ref(member.$link.doc, member.$link.path)
            : this.v(located.ref.key(`${index}`))
        );
      }
      return this.spread(this.v(value));
    }
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null) return [];
    return Array.from(value as Iterable<unknown>);
  }

  /**
   * A constant at a position of handle type, as a body is handed it: a
   * handle that reads the constant and refuses a write (ES §2.4).
   * Nothing gives nothing.
   */
  constant(value: unknown): unknown {
    return value === undefined
      ? undefined
      : this.#instance.handleOfConstant(this.v(value), this);
  }

  /**
   * A computed value as a body is handed it: what a reference names, read
   * as a value. A marker is handed as a handle to its stream, wherever it
   * is in the value: the body can send to it and can return it, and what
   * it returns holds the reference to the stream, which is stored as a
   * link (ruling Z20).
   */
  pass(
    value: unknown,
    /**
     * The entries of `Body.computed` that the value is narrowed to, and
     * the path of `value` in the computed value. A stored value at a path
     * with no `value` entry at or below it is read with the references in
     * it as stand-ins and not followed (ES §2.4: the computed part is
     * "narrowed to the entries of `Body.computed`").
     */
    narrowed?: {
      entries: readonly { at: string[]; observes: string }[];
      /**
       * The paths, as text, that the caller fills itself whatever the
       * value holds there: nothing is read or copied at one, and nothing
       * is given.
       */
      filled?: ReadonlySet<string>;
      /**
       * The `identity` entries of `Body.computed` at a path through `*`:
       * at each path one of them matches, the value is handed as the
       * handle `#handleAt` gives, where it gives one, and nothing of it is
       * read.
       */
      handles?: readonly { at: string[]; schema?: string }[];
    },
    path: readonly string[] = [],
  ): unknown {
    if (
      narrowed?.filled !== undefined && path.length > 0 &&
      narrowed.filled.has(JSON.stringify(path))
    ) return undefined;
    const identity = narrowed?.handles?.find(({ at }) =>
      at.length === path.length &&
      at.every((segment, index) => segment === "*" || segment === path[index])
    );
    if (identity !== undefined) {
      const handle = this.#handleAt(value, identity.schema);
      if (handle !== undefined) return handle;
    }
    if (value instanceof Assembled) {
      return this.pass(this.settled(value), narrowed, path);
    }
    if (value instanceof Ref || value instanceof StreamRef) {
      const valued = narrowed === undefined ||
        narrowed.entries.some(({ at, observes }) =>
          observes === "value" &&
          at.slice(0, path.length).every((segment, index) =>
            segment === "*" || segment === path[index]
          )
        );
      return this.v(value, valued ? undefined : SHALLOW);
    }
    // A body that would be handed a value in an error state is not run.
    this.#reading(value);
    if (value instanceof StreamMarker) {
      return this.#instance.handleOf(value, this);
    }
    // A handle that value code made for a constant stays the handle.
    if (value instanceof Handle) return value;
    // A stored container is frozen and holds no reference, no marker and
    // no error state: the body is handed the container itself, unless the
    // caller fills a path below it.
    if (
      this.#instance.store.plain(value) &&
      (narrowed?.filled === undefined || !filledBelow(narrowed.filled, path))
    ) return value;
    if (Array.isArray(value)) {
      return value.map((member, index) =>
        this.pass(member, narrowed, [...path, `${index}`])
      );
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map((
          [name, member],
        ) => [name, this.pass(member, narrowed, [...path, name])]),
      );
    }
    return value;
  }
}

/** Whether one of `filled`, paths as JSON text, is below `path`. */
const filledBelow = (
  filled: ReadonlySet<string>,
  path: readonly string[],
): boolean => {
  for (const text of filled) {
    const other = JSON.parse(text) as string[];
    if (
      other.length > path.length &&
      path.every((segment, index) => segment === other[index])
    ) return true;
  }
  return false;
};

/**
 * The schema a stored value is read under where a body observes nothing
 * of it but its shape or its members' presence: a container whose
 * references stay references.
 */
const SHALLOW: Schema = { type: ["array", "object"], items: {} };

/** A host that holds nothing: for a constant read where no cone runs. */
class NoHost extends Host {
  override slot(): unknown {
    return undefined;
  }
  override read(): unknown {
    return undefined;
  }
  override output(): unknown {
    return undefined;
  }
  override value(): unknown {
    return undefined;
  }
  override invoke(): unknown {
    return undefined;
  }
}

/**
 * The classes of this module whose instances value code is handed, makes
 * through `$rt`, or catches. An evaluator that confines value code freezes
 * each with its prototype, so that a body replaces no method that the
 * executor or another instance calls.
 */
export const HANDED_CLASSES: readonly object[] = [
  Unsupported,
  Assembled,
  Index,
  IndexHandle,
  Thunk,
  ReadsFailure,
  Handle,
  Host,
  NoHost,
];

/**
 * A position at which a reader of the stored result finds the link to a
 * stream (`Instance.streams`).
 */
export type StreamHeld = {
  binding: number;
  keys: string[];
  /** The instance the binding is of, where a function body made it. */
  instance?: string;
  /** The path from the root of the result. */
  path: string[];
  /** The document and the path the link is stored at. */
  at: { doc: string; path: string[] };
  /** The position of the element of each enclosing collection. */
  elements?: number[];
};

/**
 * The run of a `lift` or a `computed` that an instance evaluates: the
 * body, and the element keys it is evaluated for, by collection.
 */
type KeyedRun = { body: number; keys: [number, string][] };

/**
 * The run of a function body in progress: the cause that names it, how
 * many instances and bindings it has made, and for the run of a `lift`
 * or a `computed` the body and the element keys.
 */
type Running = { cause: FabricValue; made: number; keyed?: KeyedRun };

/** How a handled event ended. */
export type Outcome = {
  binding: number;
  /** Whether the handler's body ran to its end. */
  committed: boolean;
  error?: string;
};

/**
 * One transaction of an executor (ES §1.1): what opened it, the cones
 * whose value functions it evaluated, in the order the evaluations
 * ended, and the documents it wrote.
 */
export type Transaction = {
  /**
   * `creation` writes the argument document and the result document of
   * the instance the executor was started with and evaluates nothing
   * (ES §1.1, assumed there under question 77). `event` is the
   * transaction of one event, and `derivation` the one behind a batch or
   * for a set of changes.
   */
  cause: "creation" | "event" | "derivation" | "request" | "completion";
  /** For an event: the binding of its stream. */
  binding?: number;
  evaluated: string[];
  /** The identifiers of the documents written, in the order of the
   * first write to each. */
  written: string[];
  /**
   * The bytes of the documents written, each as the JSON text of what
   * it holds when the transaction ends, whatever part of it the
   * transaction changed. It is not counted under `measure: "patches"`.
   */
  bytes: number;
  /**
   * The bytes of what the changes of the transaction put into the
   * documents: for a write at a path the JSON text of the value
   * written, and for a splice of an array that of the members put in
   * (`PatchOp` in `runtime/memory/v2.ts`).
   */
  patchBytes: number;
  /** The changes of documents that the transaction made. */
  changes: number;
  /**
   * What the transaction wrote of the results of the instances, by the
   * documents that the layout of `execution-and-storage.md` §4.10
   * stores a result in: how many of them it wrote, the bytes that
   * those hold when it ends, the bytes it put into them, and how many
   * part documents it created and deleted.
   */
  stored: {
    documents: number;
    bytes: number;
    patchBytes: number;
    created: number;
    deleted: number;
  };
  /**
   * The part documents that the changes since the transaction before
   * this one wrote, by the layout of provisional decision P20
   * (`PartedDocuments.seal()`): absent where the store keeps none.
   */
  parted?: Sealed;
  /** The cones that took an error state, by their `entry`. */
  failed: string[];
  /** Whether what the transaction staged is stored. */
  committed: boolean;
  error?: string;
};

/**
 * What a store that keeps the executor's documents outside the executor
 * is told of each transaction, as the runtime's storage transactions
 * keep them (`docs/plans/compiled-pattern-language-integration.md`,
 * milestone 1). The executor computes on the documents it holds in
 * memory, and the store sees the same reads and changes.
 */
export type TransactionHooks = {
  /**
   * A transaction of the cause given opened. `send` is the append of an
   * event sent from outside the executor to its stream, which is the
   * sender's write and no transaction of the executor (ES §4.7), and
   * `watermark` the watermark of a stream passing an event, which the
   * executor moves after the event's transaction (SS §5.5).
   */
  begin(cause: Transaction["cause"] | "send" | "watermark"): void;

  /**
   * The executor made an instance of another artifact than the one it was
   * started with: one a function body instantiates, or one of a pattern
   * compiled alone. The write records of the instance (`plan-write.ts`,
   * `NamedOutputInputs.instance`) name the records of that artifact's
   * plan. Called before the instance writes.
   */
  instantiated?(instance: string, artifact: Artifact): void;

  /**
   * The transaction in progress read a position of a document: one a
   * link the read followed was at, or the one the read ended at. `by` is
   * the body and the entry of its `Body.handles` that a read through a
   * handle was made through, which a `dynamic` node of a template names
   * (PL §1.1, `DynamicRead`).
   */
  read(doc: string, path: readonly string[], by?: ReadThrough): void;

  /**
   * The identifier of the label at a position, where the store knows one:
   * equal labels have one identifier (provisional decision P31). The
   * executor groups the elements of a `fold` by it, and the positions a
   * slot's read reached through links; without it, every position is a
   * group of its own. A position the transaction in progress wrote has no
   * identifier: its label is the one the write stages. `observes` is the
   * class the position is observed in, `value` where it is absent: the
   * label of a link observed as a reference (`identity`) is not part of
   * the label of a read of the value at the link's position.
   */
  labelOf?(
    doc: string,
    path: readonly string[],
    observes?: string,
  ): string | undefined;

  /**
   * Registers what the store calls when the labels of documents changed
   * while their values may not have: for each document, the paths of the
   * label entries that changed. The executor then updates the group of
   * each element of a `fold` that read a position at, above or below one
   * of them, and of no other element, and forms again the label of each
   * record that read one and is not given again. `alone` says that no
   * value changed with the labels, and `stored` that the changes are what
   * the last transaction stored.
   */
  watchLabels?(
    changed: (
      changes: readonly LabelChange[],
      alone?: boolean,
      stored?: boolean,
    ) => void,
  ): void;

  /**
   * The transaction in progress changed a path of a document, which
   * `store` holds as it is after the change. A splice is a change of the
   * array's path, a document that was removed is a change of its root, and
   * a write below a value that held no container is a change of the
   * shortest path whose value it replaced. `schema` is the schema of the
   * reference the write was made through, where it has one. `writes`
   * holds the record of each path of the plan the change wrote
   * (`plan-write.ts`): one for a path that one record covers, several for
   * a change that wrote the paths of several, and none where no record of
   * the plan covers the path. `splice` is the splice of a change whose
   * records are those of the positions it changed and of the membership of
   * the array (`PlanWrite.enumeration`), and of a write through a handle
   * that added a member behind the last one: the position it starts at,
   * and how many members of the array it removed and put there. Whoever
   * stores the array then writes those positions and the number of
   * members, and no other position. `inputs` is the table the records name
   * their inputs in, one for the transaction, which gains entries as
   * records are given. `made` is the splice of every change that is one,
   * whatever its records are of: whoever stores the rows of an array apart
   * from the array needs it for each. `declared` is what the handler that
   * made the write declares for the handle it wrote through
   * (`DeclaredWrite`): whoever holds a write to the write policies of a
   * schema holds it to those of that one too.
   */
  change(
    doc: string,
    path: readonly string[],
    store: Store,
    schema?: Schema,
    writes?: readonly PlanWrite[],
    splice?: { start: number; removed: number; inserted: number },
    inputs?: InputsTable,
    made?: { start: number; removed: number; inserted: number },
    declared?: DeclaredWrite,
  ): void;

  /**
   * A write of a body of the transaction in progress left the value at a
   * path of a document as it was. `writes` holds the record of each path of
   * the plan the write covers, and `inputs` the table they name their inputs
   * in, as `change` has them. The value is not written
   * again; whoever stores labels stores the label of the records for the
   * value the path holds, since what the body read decided that the value
   * stays (ruling Z67). `attempt` is given where the write is one a
   * handler made through a handle, with what the handler declares for the
   * handle, as `change` has it: the write was attempted, and whoever holds
   * a write to a write policy holds the attempt to it. A record that is
   * given again for its label alone is no attempt.
   */
  unchanged?(
    doc: string,
    path: readonly string[],
    store: Store,
    schema: Schema | undefined,
    writes: readonly PlanWrite[],
    inputs: InputsTable,
    attempt?: { declared?: DeclaredWrite },
  ): void;

  /**
   * The transaction ended. Where it commits, `changes` holds every change
   * it made to a document, in order, and `store` holds the documents as
   * they are after it. `record` is the executor's record of the
   * transaction, which the append of a sent event has none of.
   */
  end(
    ended: {
      committed: boolean;
      changes: readonly Undo[];
      store: Store;
      record?: Transaction;
    },
  ): void;
};

/**
 * A request of an effect that left the executor and has no completion
 * yet (SS §6.2, step 6): what a test answers in place of the network.
 */
export type Outstanding = {
  id: number;
  /** The built-in of the operation, as `fetchJson`. */
  builtin: string;
  /**
   * The request as it left: the stored request with every reference in
   * it followed.
   */
  request: unknown;
  hash: string;
  /** The identifier of the state document of the operation. */
  operation: string;
};

/** How a request ended: its result, or its error. */
export type Completion = { result?: unknown; error?: unknown };

/**
 * The member of the state document of an operation that holds what a
 * reader of the operation's result reads: `pending`, `result` and
 * `error` (BI, "The refused globals"), or the error state that is the
 * operation's result, where its request was not made (SS §6.2, step 1).
 */
const OUTCOME = "outcome";

/**
 * The built-ins that request an effect and that a handler body may call
 * (SS §6.1).
 */
const EFFECTS = [
  "fetchBinary",
  "fetchText",
  "fetchJson",
  "fetchJsonUnchecked",
  "fetchProgram",
  "generateText",
  "generateObject",
  "sqliteQuery",
  "compileAndRun",
];

/** The identifier of the document of the clock (BI, `wish`). */
const CLOCK = "clock";

/** Whether a value holds an error state at some position. */
const holdsErrorState = (value: unknown): ErrorState | undefined => {
  if (isErrorState(value)) return value;
  if (Array.isArray(value)) {
    for (const member of value) {
      const found = holdsErrorState(member);
      if (found !== undefined) return found;
    }
  } else if (isRecord(value)) {
    for (const member of Object.values(value)) {
      const found = holdsErrorState(member);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/**
 * The name the bindings of the evaluation of the result are kept under
 * (`Instance.#inputs`): the value code of an output that has no value
 * function of its own runs there.
 */
const RESULT_INPUTS = "result";

/**
 * A value with an empty array at `path` of it, where it holds something on
 * the way there, and the value itself where it does not.
 */
const withNoRows = (held: unknown, path: readonly string[]): unknown => {
  if (path.length === 0) return [];
  const [first, ...rest] = path;
  if (Array.isArray(held)) {
    const index = Number(first);
    if (!(index < held.length)) return held;
    const members = [...held];
    members[index] = withNoRows(members[index], rest);
    return members;
  }
  if (isRecord(held) && Object.hasOwn(held, first)) {
    return { ...held, [first]: withNoRows(held[first], rest) };
  }
  return held;
};

/**
 * What the key of the records of the rows a body wrote begins with, where
 * the key of the record of an output begins with its instance.
 */
const CREATED = "created rows";

/** The name that the writes of a handler body are kept under. */
const HANDLER = "handler";

/** The name of the memo entry of the record of the result. */
const RESULT = "result";

/** A transaction in progress. */
type Open = {
  record: Transaction;
  /** How many times each cone instance was evaluated, by its name. */
  counts: Map<string, number>;
  /** What each change of a document replaced, in order. */
  journal: Undo[];
  /**
   * The documents of the layout of a result that were written: the
   * bytes put into each, and whether it was created (1) or deleted
   * (-1).
   */
  laid: Map<
    string,
    { instance: Instance; laid: Laid; patch: number; made: number }
  >;
  /** The documents written. */
  touched: Set<string>;
  /** The writes each evaluation made, by the name of its entry. */
  writes: Map<
    string,
    {
      instance: Instance;
      key: string;
      at: { doc: string; path: readonly string[] }[];
    }
  >;
  /** The entries that failed at the bound, each with its context. */
  exhausted: { entry: Entry; context: Context }[];
};

/** One instance of a compiled pattern. */
export class Instance {
  readonly store: Store;
  /**
   * The identifier of the instance, which is that of its result
   * document (ES §5.4): `result` for the instance the executor was
   * started with, unless it was given another, and for an instance that
   * this executor made the hash of the cause it was made under.
   */
  readonly id: string;
  /** The identifier of the argument document (ES §5.1). */
  readonly argument: string;
  /** The instance the executor was started with. */
  readonly root: Instance;
  /** On the root: every instance that this executor made, by its `id`. */
  readonly #instances = new Map<string, Instance>();
  /** The instances that this instance made. */
  readonly #children: Instance[] = [];
  /**
   * On the root: the instances that a handler made and that have had no
   * derivation yet, in the order they were made.
   */
  readonly #awaitingFirst = new Set<Instance>();
  /** The documents and declared places of this instance, by identifier. */
  readonly #documents = new Set<string>();
  /** The bindings that function bodies of this instance made, by key. */
  readonly #bindings = new Set<string>();
  /**
   * On the root: each binding a function body made, by the key of its
   * stream, with the handler and the state the body bound.
   */
  readonly #bound = new Map<
    string,
    {
      run: (...given: unknown[]) => unknown;
      state: unknown;
      /** What the body that bound the handler was handed with an address. */
      handed?: HandedValues;
    }
  >();
  /**
   * On the root: what each body being run was handed with an address,
   * the innermost last.
   */
  readonly #handing: HandedValues[] = [];

  /** Runs `run` as the work of a body that was handed `handed`. */
  handing<T>(handed: HandedValues, run: () => T): T {
    const { root } = this;
    root.#handing.push(handed);
    try {
      return run();
    } finally {
      root.#handing.pop();
    }
  }

  /**
   * The address a container was read from, where it carries one: a copy
   * that a read made, by `Store.addresses`, and a stored container that a
   * read gave as the object the store holds, by what the body being run
   * was handed. With `reactive` the asker is no body: such a container
   * then has the address its last read was made at (`Store.handed`).
   */
  addressRead(value: object, reactive = false): Ref | undefined {
    const read = this.store.addresses.get(value);
    if (read !== undefined) return read;
    if (reactive) return this.store.handed.get(value)?.at;
    return this.root.#handing.at(-1)?.addressOf(value);
  }
  /**
   * On the root: each instance a function body made, by the identifier
   * that the run and the ordinal give it now: the instance, the run,
   * and the ordinal among what the run made. `keyed` is absent for the
   * run of a handler. An instance that was re-keyed is held under
   * another identifier than its `id`, which its documents are named
   * from (ruling Z41).
   */
  readonly #made = new Map<
    string,
    { instance: Instance; keyed?: KeyedRun; ordinal: number }
  >();
  /** On the root: the transaction in progress. */
  #tx: Open | undefined;
  /**
   * On the root: a write outside the executor's transactions is being
   * made, which `transactions` is told of as a transaction of its own:
   * the append of an event sent from outside, and the watermark of a
   * stream passing an event.
   */
  #outside = false;
  /** On the root: the entries being evaluated, innermost last. */
  readonly #evaluating: { instance: Instance; key: string }[] = [];
  /**
   * On the root: the cone instances whose evaluation wrote a document as a
   * side-write, by the identifier of the document and then by the name of
   * the entry. `restore` drops the entries of the writers of a document it
   * takes from the storage. The map holds an entry for each document that
   * a cone instance wrote, for as long as the executor runs.
   */
  readonly #wroteAside = new Map<
    string,
    Map<string, { instance: Instance; key: string }>
  >();
  /** The run of a function body in progress (ES §2.8, "Identity"). */
  #running: Running | undefined;
  /** The events handled, which name the run of a handler. */
  #events = 0;
  readonly plan: Plan;
  readonly code: Code;
  readonly counts: Counts = {
    bucketsChanged: 0,
    segmentsFormed: 0,
    evaluations: 0,
    elementEvaluations: 0,
    rowsLeftStored: 0,
    assemblies: 0,
    assembliesFormed: 0,
    slotsNotListed: 0,
    readsWithoutSlot: 0,
    outputsWithoutEdge: 0,
    writesCovered: 0,
    writesNotCovered: 0,
    pendingOperations: 0,
    staleByOwnWrite: 0,
    failures: 0,
    groupUpdates: 0,
    scopedPulls: 0,
    elementsVisited: 0,
    positionsPlaced: 0,
    recordsNoted: 0,
    recordRegistrations: 0,
  };
  readonly valueOfOutput = new Map<number, number>();
  readonly bodies = new Map<number, (...given: unknown[]) => unknown>();
  readonly #values = new Map<number, (host: Host) => unknown>();
  readonly #elements = new Map<number, (host: Host) => unknown>();
  readonly #states = new Map<number, (host: Host) => unknown>();
  /** The functions of each `reduce` of the reactive tier. */
  readonly #reduces = new Map<number, {
    initialCone: number | undefined;
    initial: ((host: Host) => unknown) | undefined;
    stepCone: number;
    step: (host: Host) => unknown;
  }>();
  /**
   * The output that each array is the whole value of, with the element
   * keys it was read under: what a value function returned for an
   * output, by the identity of the array.
   */
  readonly returnedWhole = new WeakMap<
    object,
    { output: number; context: Context }
  >();
  /** The function of the argument of each child instance, by the child. */
  readonly #childArguments = new Map<number, (host: Host) => unknown>();
  /**
   * The instances that calls through `asInstance()` made, by the child
   * and the element keys of the site (ruling Z35). An entry stays when
   * its key leaves the collection.
   */
  readonly #asInstances = new Map<
    string,
    { child: number; keys: string[]; instance: Instance }
  >();
  /**
   * The function of the request of each effect, and of the operands of
   * each `wish`, by the operation.
   */
  readonly #requestFunctions = new Map<number, (host: Host) => unknown>();
  /**
   * On the root: the effect operations whose result something demanded,
   * by the identifier of their state document. `read` is the request,
   * with its references followed, as the last request transaction of
   * the operation read it.
   */
  readonly #operations = new Map<
    string,
    {
      instance: Instance;
      builtin: string;
      read?: string;
      /** A request of a handler, which is made once (SS §6.2). */
      once?: true;
    }
  >();
  /** On the root: how many requests left the executor. */
  #sent = 0;
  /** The function of a handler written in place, by its binding. */
  readonly #handlers = new Map<number, (...given: unknown[]) => unknown>();
  readonly #setups: ((given: unknown, host: Host) => unknown)[] = [];
  readonly #modules = new Map<number, Record<string, unknown>>();
  readonly #schemas = new Map<string, Schema>();
  readonly #memo = new Map<string, Entry>();
  readonly #open = new Set<string>();
  readonly #checking = new Set<string>();
  /** Each memo entry's cone and the element keys it is kept under. */
  readonly #kept = new Map<
    string,
    { cone: number | undefined; keys: string[] }
  >();
  /** The memo entries kept under one key of one collection. */
  readonly #underKey = new Map<string, Set<string>>();
  /**
   * The element table of each collection, by the name of its assembly:
   * the collection, the element keys around it, and the elements.
   */
  readonly #tables = new Map<
    string,
    {
      collection: number;
      around: readonly string[];
      elements: Element[];
      /** The element of each key. */
      byKey: Map<string, Element>;
    }
  >();

  /** Holds the element table of an assembly, with its index by key. */
  #setTable(
    name: string,
    collection: number,
    around: readonly string[],
    elements: Element[],
  ): void {
    const byKey = new Map<string, Element>();
    for (const element of elements) byKey.set(element.key, element);
    this.#tables.set(name, { collection, around, elements, byKey });
  }

  /** What is known of whether each memo entry is current, by its name. */
  readonly #slots = new Map<string, Slot>();
  /** The names of the entries that used each name. */
  readonly #users = new Map<string, Set<string>>();
  /**
   * The slots of the entries set aside for a scope key, by the name of the
   * entry and the key (`Slot.aside`).
   */
  readonly #asideSlots = new Map<string, Map<string, Slot>>();
  /** The slots set aside that used each name. */
  readonly #asideUsers = new Map<string, Set<Slot>>();
  /**
   * The entries that read the position of an element, by the name of
   * what is kept under the element's key.
   */
  readonly #indexReaders = new Map<string, Set<string>>();
  /** On the root: the readers of each document, by path. */
  readonly #readers = new Map<string, Readers>();
  /**
   * On the root: the readers through a reference by key, by the array
   * that the key was found in, as what stands for it through its changes
   * (`Store.lineageOf`), and the key.
   */
  #keyedReaders = new WeakMap<object, Map<string, Set<Reg>>>();
  /** On the root: how many registrations `#keyedReaders` holds. */
  #keyedCount = 0;
  /** Something of the instance is marked, or was never evaluated. */
  #due = true;
  /** Something of an instance that this one made is marked. */
  #dueBelow = false;
  /** How many entries of the instance are compared on every pull. */
  #alwaysCount = 0;
  /** The entries that were marked while they were being evaluated. */
  readonly #markedDuring = new Set<string>();

  #slot(key: string): Slot {
    let slot = this.#slots.get(key);
    if (slot === undefined) {
      slot = {
        instance: this,
        key,
        marked: false,
        serial: 0,
        suspects: new Set(),
        reads: new Set(),
        all: false,
        regs: [],
        uses: new Set(),
        always: false,
      };
      this.#slots.set(key, slot);
    }
    return slot;
  }

  /** Notes that the entry `user` used what `used` names. */
  uses(user: string, used: string): void {
    const slot = this.#slot(user);
    if (slot.uses.has(used)) return;
    slot.uses.add(used);
    const users = this.#users.get(used) ?? new Set();
    users.add(user);
    this.#users.set(used, users);
  }

  /** Something of the instance has to be brought up to date. */
  #nowDue(): void {
    if (this.#due) return;
    this.#due = true;
    for (let above = this.options.parent; above; above = above.options.parent) {
      if (above.#dueBelow) break;
      above.#dueBelow = true;
    }
  }

  /**
   * Marks an entry: a position it read, or something it used, may have
   * changed. The mark passes on to the entries that used this one.
   */
  #mark(slot: Slot, position?: Position, used?: string): void {
    slot.serial += 1;
    if (position !== undefined) slot.reads.add(position);
    else if (used !== undefined) slot.suspects.add(used);
    else slot.all = true;
    if (slot.aside !== undefined) {
      slot.aside.checkedAt = undefined;
    } else {
      if (this.#open.has(slot.key)) this.#markedDuring.add(slot.key);
      const entry = this.#memo.get(slot.key);
      if (entry !== undefined) entry.checkedAt = undefined;
      const units = this.#units.get(slot.key);
      if (units !== undefined) {
        for (const unit of units) this.#dueUnits.add(unit);
      }
    }
    if (slot.marked) return;
    slot.marked = true;
    this.#nowDue();
    this.#pullDue(slot);
    this.#markUsers(slot.key, slot.scoped);
  }

  /**
   * Marks the entries that used what `used` names, where the change of
   * `used` was one of the scope key `scoped` or of the space: those set
   * aside for a key as well as those in the memo, and of the keys the
   * change reaches alone (`scopeKeyReaches`).
   */
  #markUsers(used: string, scoped?: string): void {
    for (const user of this.#users.get(used) ?? []) {
      const slot = this.#slots.get(user);
      if (slot !== undefined && scopeKeyReaches(scoped, slot.scoped)) {
        this.#mark(slot, undefined, used);
      }
    }
    const aside = this.#asideUsers.get(used);
    if (aside === undefined) return;
    for (const slot of [...aside]) {
      if (scopeKeyReaches(scoped, slot.scoped)) {
        this.#mark(slot, undefined, used);
      }
    }
  }

  /**
   * Marks the entries of a scope key that used what `used` names, where the
   * entry of `used` for the scope key `scoped` is dropped: those set aside
   * as well as those in the memo, of the keys a change of `scoped` reaches
   * (`scopeKeyReaches`). An entry of no scope key holds a reference to
   * `used` at most, which stays what it was.
   */
  #markScopedUsers(used: string, scoped: string): void {
    for (const user of this.#users.get(used) ?? []) {
      const slot = this.#slots.get(user);
      if (slot?.scoped !== undefined && scopeKeyReaches(scoped, slot.scoped)) {
        this.#mark(slot, undefined, used);
      }
    }
    for (const slot of [...this.#asideUsers.get(used) ?? []]) {
      if (slot.scoped !== undefined && scopeKeyReaches(scoped, slot.scoped)) {
        this.#mark(slot, undefined, used);
      }
    }
  }

  /** Removes every registration of an entry. */
  #unregister(slot: Slot): void {
    const { root } = this;
    for (const { set, reg, keyed } of slot.regs) {
      set.delete(reg);
      if (keyed) root.#keyedCount -= 1;
    }
    slot.regs.length = 0;
    for (const used of slot.uses) {
      if (slot.aside === undefined) this.#users.get(used)?.delete(slot.key);
      else this.#asideUsers.get(used)?.delete(slot);
    }
    slot.uses.clear();
  }

  /**
   * Sets the slot of the entry `entry`, which the memo held, aside with
   * the entry: it stays registered, as a user of what the entry used by
   * the slot itself, and the memo has no slot for the name until another
   * entry is evaluated or brought back.
   */
  #toAside(slot: Slot, entry: Entry): void {
    this.#slots.delete(slot.key);
    slot.aside = entry;
    slot.scoped = entry.scoped;
    for (const used of slot.uses) {
      this.#users.get(used)?.delete(slot.key);
      let users = this.#asideUsers.get(used);
      if (users === undefined) {
        users = new Set();
        this.#asideUsers.set(used, users);
      }
      users.add(slot);
    }
    let byKey = this.#asideSlots.get(slot.key);
    if (byKey === undefined) {
      byKey = new Map();
      this.#asideSlots.set(slot.key, byKey);
    }
    byKey.set(entry.scoped!, slot);
  }

  /**
   * Makes a slot set aside the slot of its name again, with what marks it
   * holds, where its entry is brought back into the memo. A slot the memo
   * had for the name meanwhile is dropped.
   */
  #fromAside(slot: Slot): void {
    const held = this.#slots.get(slot.key);
    if (held !== undefined && held !== slot) {
      this.#unregister(held);
      if (held.always) this.#alwaysCount -= 1;
    }
    const byKey = this.#asideSlots.get(slot.key);
    byKey?.delete(slot.scoped!);
    if (byKey?.size === 0) this.#asideSlots.delete(slot.key);
    for (const used of slot.uses) {
      this.#asideUsers.get(used)?.delete(slot);
      const users = this.#users.get(used) ?? new Set();
      users.add(slot.key);
      this.#users.set(used, users);
    }
    slot.aside = undefined;
    this.#slots.set(slot.key, slot);
  }

  /**
   * Forgets the entries of the name `key` set aside for a scope key, with
   * their slots and registrations.
   */
  #forgetAside(key: string): void {
    for (const slot of this.#asideSlots.get(key)?.values() ?? []) {
      this.#unregister(slot);
      if (slot.always) this.#alwaysCount -= 1;
    }
    this.#asideSlots.delete(key);
    this.store.scopes?.forget(`${this.id}\n${key}`);
  }

  /**
   * Marks the entries of the name `key` set aside for a scope key as not
   * current: all of them, or those of the keys `of` accepts.
   */
  #staleAside(key: string, of?: (scoped: string) => boolean): void {
    this.store.scopes?.staleAside(`${this.id}\n${key}`, of);
    for (const [scoped, slot] of this.#asideSlots.get(key) ?? []) {
      if (of === undefined || of(scoped)) this.#mark(slot);
    }
  }

  /** On the root: the readers registered at a path of a document. */
  #readersAt(doc: string, path: readonly string[]): Set<Reg> {
    let node = this.#readers.get(doc);
    if (node === undefined) {
      node = {};
      this.#readers.set(doc, node);
    }
    for (const segment of path) {
      node.below ??= new Map();
      let next = node.below.get(segment);
      if (next === undefined) {
        next = {};
        node.below.set(segment, next);
      }
      node = next;
    }
    node.regs ??= new Set();
    return node.regs;
  }

  /**
   * Registers an entry as a reader of a position. Returns whether a
   * change of what the read gave marks the entry from here on.
   */
  #watch(slot: Slot, position: Position): boolean {
    const { root, store } = this;
    const add = (set: Set<Reg>, keyed: boolean) => {
      const reg = { slot, position };
      set.add(reg);
      slot.regs.push({ set, reg, keyed });
      if (keyed) root.#keyedCount += 1;
    };
    const { keyed } = position;
    if (keyed === undefined) {
      add(root.#readersAt(position.doc, position.path), false);
      return true;
    }
    // A read through a reference by key into the document of a computed
    // output brings the output up to date, which no write announces
    // (ruling Z53).
    if (keyed.array === undefined || store.sources.has(position.doc)) {
      return false;
    }
    let keys = root.#keyedReaders.get(keyed.array);
    if (keys === undefined) {
      keys = new Map();
      root.#keyedReaders.set(keyed.array, keys);
    }
    let set = keys.get(keyed.key);
    if (set === undefined) {
      set = new Set();
      keys.set(keyed.key, set);
    }
    add(set, true);
    let indexed = true;
    for (const other of keyed.others) {
      if (store.sources.has(other.doc)) indexed = false;
      add(root.#readersAt(other.doc, other.path), false);
    }
    return indexed;
  }

  /**
   * Registers an entry as a reader of what it read and a user of what
   * it used, so that a change marks it. Returns whether everything it
   * depends on has a place in an index: an entry for which it does not
   * is compared on every pull.
   */
  #register(slot: Slot, entry: Entry): boolean {
    let indexed = entry.writers.length === 0;
    for (const position of entry.reads) {
      if (!this.#watch(slot, position)) indexed = false;
    }
    for (const { on } of entry.dependencies) {
      if (on === undefined || this.#slots.get(on)?.always) indexed = false;
      else this.uses(slot.key, on);
    }
    for (const used of slot.uses) {
      if (this.#slots.get(used)?.always) indexed = false;
    }
    return indexed;
  }

  /**
   * On the root: marks the readers of what a change of a document
   * changed (`Store.onChange`).
   */
  #changed(
    change: {
      doc: string;
      path: readonly string[];
      old: unknown;
      splice?: { start: number; removed: number; inserted: number };
      keyed: { array: object; keys?: readonly string[]; now?: object }[];
      covers?: readonly string[];
      schema?: Schema;
    },
  ): void {
    const open = this.#tx;
    const hooks = this.options.transactions;
    if (this.#seeds.size > 0) this.#hydrate(change.doc, change.path);
    this.#memberDocumentChanged(change.doc, change.path, change.splice);
    if (hooks !== undefined && (open !== undefined || this.#outside)) {
      let path = change.covers ?? change.path;
      let { splice } = change;
      // A write through a handle at the position behind the last one of a
      // stored list adds a member, as a splice there does.
      if (
        splice === undefined && this.#writing?.members !== undefined &&
        change.old === undefined && /^\d+$/.test(path.at(-1) ?? "")
      ) {
        const list = this.store.peek(change.doc, path.slice(0, -1));
        const start = Number(path.at(-1));
        if (Array.isArray(list) && start === list.length - 1) {
          splice = { start, removed: 0, inserted: 1 };
          path = path.slice(0, -1);
        }
      }
      const added = splice !== change.splice;
      const writes = this.#writesOf(change.doc, path, splice);
      hooks.change(
        change.doc,
        path,
        this.store,
        change.schema,
        writes.length === 0 ? undefined : writes,
        added || writes.some(({ enumeration }) => enumeration)
          ? splice
          : undefined,
        this.#inputsTable,
        change.splice,
        this.#writing?.declared,
      );
    }
    if (open !== undefined) {
      const { store } = this;
      const now = store.peek(change.doc, change.path);
      const put = change.splice === undefined ? now : (now as unknown[]).slice(
        change.splice.start,
        change.splice.start + change.splice.inserted,
      );
      open.record.changes += 1;
      open.record.patchBytes += (JSON.stringify(put) ?? "").length;
    }
    // A change of a document of a scope is one of the instance of the scope
    // key that is evaluated for: an entry of another key read another
    // instance, and is not marked.
    const named = scopeOfDocument(change.doc);
    const writtenFor = named.scope === undefined
      ? undefined
      : named.key ?? this.store.scopes?.keyOf(named.scope);
    // `above` says that the readers are of a position above the change:
    // a read that found which position a reference names (`Position.own`)
    // is not one of what the position holds below it.
    const mark = (regs: Iterable<Reg> | undefined, above = false) => {
      if (regs === undefined) return;
      for (const reg of [...regs]) {
        if (above && reg.position.own) continue;
        if (!scopeKeyReaches(writtenFor, reg.slot.scoped)) continue;
        reg.slot.instance.#mark(reg.slot, reg.position);
      }
    };
    const below = (node: Readers) => {
      mark(node.regs);
      for (const next of node.below?.values() ?? []) below(next);
    };
    let node = this.#readers.get(change.doc);
    for (const segment of change.path) {
      if (node === undefined) break;
      mark(node.regs, true);
      node = node.below?.get(segment);
    }
    if (node !== undefined) {
      const { splice } = change;
      if (splice === undefined) {
        below(node);
      } else {
        // The positions before the splice hold what they held.
        mark(node.regs);
        for (const [segment, next] of node.below ?? []) {
          if (/^\d+$/.test(segment) && Number(segment) < splice.start) continue;
          below(next);
        }
      }
    }
    const moved = new Set<object>();
    for (const { array, keys, now } of change.keyed) {
      const readers = this.#keyedReaders.get(array);
      if (readers === undefined) continue;
      if (now !== undefined) {
        this.#keyedReaders.delete(array);
        this.#keyedReaders.set(now, readers);
        moved.add(array);
      }
      if (keys === undefined) {
        for (const set of readers.values()) mark(set);
      } else {
        for (const key of keys) mark(readers.get(key));
      }
    }
    if (this.#keyedCount === 0) return;
    // An array that the change removed from its document is one that no
    // later change names: a reader through a key of it is compared on
    // every pull from here on.
    const detach = (value: unknown, top: boolean) => {
      if (typeof value !== "object" || value === null || isLink(value)) return;
      if (Array.isArray(value)) {
        const lineage = this.store.lineageHeld(value);
        const readers = lineage === undefined || (top && moved.has(lineage))
          ? undefined
          : this.#keyedReaders.get(lineage);
        if (lineage !== undefined && readers !== undefined) {
          this.#keyedReaders.delete(lineage);
          for (const set of readers.values()) {
            for (const reg of [...set]) {
              const { slot } = reg;
              slot.instance.#setAlways(slot);
              slot.instance.#mark(slot, reg.position);
            }
          }
        }
        for (const member of value) detach(member, false);
        return;
      }
      for (const member of Object.values(value)) detach(member, false);
    };
    if (change.splice !== undefined && Array.isArray(change.old)) {
      for (const member of change.old) detach(member, false);
    } else {
      detach(change.old, true);
    }
  }

  /** The record of each key that a name of the memo holds, by its text. */
  readonly #keyRecords = new Map<string, FabricValue>();
  /** The state cells that exist, by the identifier of their document. */
  readonly #cells = new Map<string, { cell: number; keys: string[] }>();
  readonly #queue: {
    stream: StreamRef;
    event: unknown;
    /** The elements the event was queued for, where the sender chose. */
    context?: Context;
  }[] = [];
  #result: Thunk | undefined;
  #created = 0;
  /** The body whose writes are being counted, while a handler runs. */
  #handling: number | undefined;
  /** The cones with static side-writes, each with what it writes. */
  readonly #writers: {
    cone: number;
    targets: { root: Root; path: string[] }[];
    run: Writer;
  }[] = [];
  /** The cones whose body is a materializer. */
  readonly #materializers: Writer[] = [];
  /** Whether the materializers are being evaluated, after a wave. */
  #afterWave = false;
  /**
   * The cone of each value function evaluated, by its `entry`, and
   * `result` for the result, in the order the evaluations ended.
   */
  readonly trace: string[] = [];

  /**
   * On the root: each evaluation that ended in an error state, in order:
   * the `entry` of the cone, and the message of the error state.
   */
  readonly failed: { cone: string; message: string }[] = [];

  /**
   * How many times the reads and the dependencies of a memo entry were
   * compared with what the entry saw of them.
   */
  checks = 0;

  /**
   * The effects that the handlers of the instance requested, in order:
   * the kind, and what the request was given. The executor answers none
   * of them.
   */
  readonly requests: { kind: string; target: unknown }[] = [];

  constructor(
    readonly artifact: Artifact,
    argument: unknown,
    /**
     * `space`: the space the instance is in, which `spaceOf` gives.
     * The element part of a position that holds a link names it.
     * `secret`: the secret of that space, which the keys of plain
     * values are salted with; the store mints one where none is given.
     * `artifacts`: the artifact of a pattern, by the identity its plan
     * begins with (`Plan.patterns`), for a pattern that a function body
     * instantiates. `id`: the identifier of the instance, which is that
     * of its result document. `parent`: for an instance that this
     * executor made, the instance that made it.
     */
    readonly options: {
      space?: string;
      secret?: string;
      artifacts?: (id: string) => Artifact | undefined;
      parent?: Instance;
      id?: string;
      /**
       * What the memo entry of a cone instance that failed at the bound
       * is current against in a later transaction. `stored`: what is
       * stored when the transaction ends, after the withdrawals, so the
       * cone instance is evaluated again when something it read changes
       * after that. `reads`: what its last evaluation read, so a
       * withdrawal of something it read makes it stale. The default is
       * `stored`.
       */
      afterBound?: "stored" | "reads";
      /**
       * Which cones with static side-writes are evaluated before a
       * handler body where they are stale (ES §1.3, "A cell that a cone
       * writes statically"). `read`: those that write a cell that a slot
       * of the handler reads. `bound`: those that write a cell that any
       * slot of the handler is bound to, a slot that observes the
       * reference alone included, as the slot of a handle that the body
       * only writes through. The default is `read`.
       */
      beforeBody?: "read" | "bound";
      /**
       * A stand-in for the constraints on what a handler itself writes
       * (PL §4.4): called when a handler body returned, with each write
       * the body made, and a text it returns is the refusal that rejects
       * the event's transaction. The executor instantiates no label, so
       * it checks no constraint of a plan.
       */
      refuses?: (
        write: { binding: number; doc: string; path: readonly string[] },
      ) => string | undefined;
      /**
       * What each `wish` resolves to, by its operands: a test's stand-in
       * for the targets of a space. `result` is stored in a document of
       * its own, and the result of the `wish` is a reference to it.
       * `outcome` is what the state document holds as the outcome, member
       * by member, for a target that is a document of `documents`: a
       * link in it is stored as the reference it is. An `outcome` with no
       * member writes nothing: the outcome is then what another writer
       * stores in the state document.
       */
      wishes?: (
        operands: Record<string, unknown>,
        /**
         * `state`: the identifier of the state document of the `wish`,
         * which the executor gives with every call.
         */
        of?: { state: string },
      ) => {
        result?: unknown;
        error?: unknown;
        outcome?: Record<string, unknown>;
        /**
         * The positions the resolution read to find the outcome, which
         * the write record of the outcome reports (PL §3.19).
         */
        reads?: Address[];
      } | undefined;
      /**
       * Whether something outside the executor answers the request of an
       * effect of the reactive tier, by the built-in and the identifier of
       * the state document of the operation. Where it does, the executor
       * stages the request and no more: it writes no hash and no pending
       * mark, sends no request (`outbox`), and reads as the outcome what
       * another writer stores in the state document.
       */
      effects?: (builtin: string, of: { state: string }) => boolean;
      /** What the clock holds when the executor starts. */
      now?: number;
      /**
       * What a module of compiled code imports from `commonfabric` under
       * each name here, for a built-in the executor does not have: a
       * harness's stand-in for what the runtime answers, such as the
       * acting principal or the access list of a space. A name the
       * executor has is not replaced. Each member is frozen in place as
       * module data is, so that no body changes what the next one reads.
       * A function is called with the instance whose modules import them,
       * once for each module, and gives the record.
       */
      builtins?:
        | Record<string, unknown>
        | ((instance: Instance) => Record<string, unknown>);
      /**
       * What the value code reads under each name here in place of the
       * realm's global of that name, as `Date` and `crypto`: a caller
       * that needs two runs to hold the same values gives the sources of
       * the time of day and of random draws here.
       */
      globals?: Record<string, unknown>;
      /**
       * What makes a function of the text of a module of value code
       * (`ModuleEvaluator`). The default is `evaluateWithFunction`, which
       * gives the code the globals of the realm.
       */
      evaluate?: ModuleEvaluator;
      /**
       * `patches`: a transaction does not count the bytes of each
       * document it wrote as a whole (`Transaction.bytes`), which costs
       * a pass over the document.
       */
      measure?: "documents" | "patches";
      /**
       * Whether the key of a position that a write did not touch is
       * kept (`kept`, the default) or formed again (`formed`); see
       * `Store`.
       */
      keys?: "kept" | "formed";
      /**
       * Whether the assembly of a collection over a stored array is
       * brought up to date from the changes of the array (`applied`,
       * the default) or formed whole (`formed`).
       */
      assembly?: "applied" | "formed";
      /**
       * How the documents are laid out in part documents (provisional
       * decision P20); `false` keeps no part documents.
       */
      parts?: PartsOptions | false;
      /**
       * A store outside the executor that keeps its documents, told of
       * each transaction (`TransactionHooks`). Only the hooks of the
       * instance the executor was started with are called.
       */
      transactions?: TransactionHooks;
      /**
       * What an instance stores as its argument document, given the
       * argument it was made with, its artifact and its name: a host that
       * stores the defaults an argument type declares returns the argument
       * with them. Called for the instance the executor was started with
       * and for each one a body or a handler makes, before the document
       * exists. Without it the argument is stored as it was given, and a
       * default is what a read gives where nothing is stored.
       */
      argumentStored?: (
        argument: unknown,
        artifact: Artifact,
        instance: string,
      ) => unknown;
      /**
       * The collections whose rows are stored as documents of their own
       * (`rowDocumentCollections` of `row-documents.ts`). A bucket of an
       * index that the result keeps over the rows of one of them holds a
       * reference by key to each row, and a copy of the row otherwise.
       */
      rowDocuments?: ReadonlySet<number>;
      /**
       * The collections whose index the result keeps with each bucket
       * stored as a document of its own (`bucketDocumentCollections` of
       * `row-documents.ts`). The record of the buckets of one is written
       * member by member: a bucket that changed, came to exist or emptied
       * is one write, and the record is not written for it.
       */
      bucketDocuments?: ReadonlySet<number>;
      /**
       * With `resume`: the instances that handlers of a run before made
       * (`madeByHandlers`), each with the artifact of its pattern and the
       * argument the storage holds for it. Each is started again before
       * the first derivation of this instance, under the identifier it
       * has, from its stored argument and its stored state. An instance
       * that a `lift` or a `computed` made is made again by the body
       * that made it.
       */
      made?: readonly { id: string; artifact: Artifact; argument: unknown }[];
      /**
       * Where an event that a handler sends to a stream of the executor
       * is kept. `documents`, the default: it is appended to the document
       * of its stream and handled behind the events before it.
       * `queue`: it is kept for whoever runs the executor to take
       * (`takeQueued`) and to hand back one by one (`handleEvent`), and
       * no stream document is written.
       */
      events?: "documents" | "queue";
      /**
       * Gives a document that the store does not hold, by its identifier,
       * where a store outside the executor holds it: one that exists
       * outside the instance, which a reference leads to. The store asks
       * once for each identifier.
       */
      load?: (id: string) => { kind: string; value: unknown } | undefined;
      /**
       * Says which principal and session an evaluation is for, by the
       * scope key of each scope. With it, a document of the scope `user`
       * or `session` is held once for each key, and a memo entry that
       * touched one is kept for its key alone (`scope-instances.ts`).
       * Without it every document is the space's.
       */
      scopes?: ScopeInstancesOptions;
      /**
       * Whether the instance is one that a store outside the executor
       * holds from a run before: a state cell whose document `load` gives
       * keeps what that document holds, and is given neither its first
       * value nor the default of its schema.
       */
      resume?: boolean;
      /**
       * The store outside the executor as it holds the units of the
       * instance (`StoredUnits`). The executor tells it what the body of
       * each element of a collection of `storedRowCollections` read. With
       * `resume`, and where it names the documents that changed since the
       * run before, the rows of such a collection are left as stored
       * until a change reaches them.
       */
      units?: StoredUnits;
      /**
       * What a run before of this instance counted (`minted`), for one
       * that is resumed: the counts go on from there, so that an event and
       * a document a body makes get a name that no run before gave.
       */
      minted?: { events: number; created: number };
      /**
       * Documents that exist before the instance is created, each with
       * its identifier, its kind and its value: the documents of the
       * inputs that the argument links to. They are made outside any
       * transaction, so `transactions` is told of no change to them.
       * `space` is the space of a document that is in another space than
       * the instance.
       */
      documents?: {
        id: string;
        kind: string;
        value: unknown;
        space?: string;
      }[];
    } = {},
  ) {
    this.store = options.parent?.store ??
      new Store({
        secret: options.secret,
        space: options.space,
        keys: options.keys,
        parts: options.parts,
        load: options.load,
        scopes: options.scopes,
      });
    this.id = options.id ?? "result";
    this.argument = argumentOf(this.id);
    this.root = options.parent?.root ?? this;
    if (this.root === this && options.units !== undefined) {
      this.#listed = storedRowCollections(
        artifact,
        options.rowDocuments ?? new Set(),
      );
    }
    if (this.root === this && options.minted !== undefined) {
      this.#events = options.minted.events;
      this.#created = options.minted.created;
    }
    if (this.root !== this) {
      this.root.options.transactions?.instantiated?.(this.id, artifact);
    }
    this.plan = artifact.plan;
    this.code = artifact.code;
    for (const { id, schema } of artifact.schemas) {
      // A schema is frozen with all it holds: a link the instance stores
      // carries a schema of the plan, and the runtime keeps what it makes
      // of a link's schema for a schema that is frozen, where it would
      // make it again for each link.
      if (schema !== undefined) {
        this.#schemas.set(id, deepFreeze(linkedSchema(schema)));
      }
    }
    this.code.values.forEach((value, index) => {
      if (value.output !== undefined && value.function) {
        this.valueOfOutput.set(value.output, index);
      }
    });
    this.#documents.add(this.argument).add(this.id);
    if (this.root === this) {
      this.store.onWrite = (doc, path) => this.#wrote(doc, path);
      this.store.onChange = (change) => this.#changed(change);
      const hooks = options.transactions;
      if (hooks !== undefined) {
        this.store.onRead = (doc, path, by) => {
          if (this.#tx !== undefined) hooks.read(doc, path, by);
        };
        hooks.watchLabels?.((changes, alone, stored) =>
          this.labelsChanged(changes, alone, stored)
        );
        // A write of a body that leaves the value as it was is reported
        // with the records of the write being made: what the body read
        // decided that the value stays.
        this.store.onUnchanged = (doc, path, schema) => {
          if (this.#tx === undefined || this.#writing === undefined) return;
          const writes = this.#writesOf(doc, path, undefined);
          if (writes.length > 0) {
            hooks.unchanged?.(
              doc,
              path,
              this.store,
              schema,
              writes,
              this.#inputsTable,
              this.#writing.handler
                ? { declared: this.#writing.declared }
                : undefined,
            );
          }
        };
      }
    }
    // An instance that a function body makes is given the options of the
    // instance that made it, and the documents exist already.
    const given = this.root === this ? options.documents ?? [] : [];
    for (const { id, kind, value, space } of given) {
      this.store.create(id, kind, value);
      if (space !== undefined) this.store.spaces.set(id, space);
    }
    // The creation of an instance by something that is no handler is a
    // transaction that writes its two documents and evaluates nothing
    // (ES §1.1, assumed there under question 77). An instance that a
    // body makes gets them in the transaction the body runs in.
    const creation = this.root.#tx === undefined
      ? this.root.#begin("creation")
      : undefined;
    this.store.create(
      this.argument,
      "argument",
      this.stored(
        this.root.options.argumentStored?.(argument, artifact, this.id) ??
          argument,
      ),
    );
    this.store.create(this.id, "result", this.#heldResult());
    if (creation !== undefined) this.root.#end(creation, true);
    this.#load();
    this.#sideWriters();
    // An instance that a handler makes is evaluated in the derivation
    // transaction behind the batch, and not in the event's transaction
    // (ES §1.1, "From the creation of an instance to its settled
    // result").
    if (this.root.#tx?.record.cause === "event") {
      this.root.#awaitingFirst.add(this);
      return;
    }
    // A state cell of the pattern's own body exists from the start, and
    // one of an element body from when its key enters the element table.
    const first = () => {
      for (const { id, artifact, argument } of this.options.made ?? []) {
        if (this.root !== this || this.#instances.has(id)) continue;
        const child = new Instance(artifact, argument, {
          ...this.options,
          made: undefined,
          parent: this,
          id,
        });
        this.#instances.set(id, child);
        this.#made.set(id, { instance: child, ordinal: 0 });
        this.#children.push(child);
      }
      this.#declare(new Map());
      this.#settle();
    };
    if (this.root.#tx !== undefined) first();
    else this.root.#cycle(first);
  }

  // ----- transactions -----

  #begin(cause: Transaction["cause"], binding?: number): Open {
    const open: Open = {
      record: {
        cause,
        ...(binding === undefined ? {} : { binding }),
        evaluated: [],
        written: [],
        bytes: 0,
        patchBytes: 0,
        changes: 0,
        stored: {
          documents: 0,
          bytes: 0,
          patchBytes: 0,
          created: 0,
          deleted: 0,
        },
        failed: [],
        committed: false,
      },
      counts: new Map(),
      journal: [],
      laid: new Map(),
      touched: new Set(),
      writes: new Map(),
      exhausted: [],
    };
    this.#tx = open;
    this.store.journal = open.journal;
    this.root.#givenNow.clear();
    this.root.#inputsTable = new InputsTable();
    this.root.#sharedInputs.clear();
    this.options.transactions?.begin(cause);
    return open;
  }

  #end(open: Open, committed: boolean, error?: string): void {
    // A cone instance that failed at the bound is not evaluated again
    // until one of its inputs changes (SS §8.1, "After the bound"). Its
    // side-writes were withdrawn, so what its last evaluation read is no
    // longer what is stored. Under `stored` the entry is current against
    // what is stored now.
    if ((this.options.afterBound ?? "stored") === "stored") {
      for (const { entry, context } of open.exhausted) {
        entry.evaluatedAt = this.store.clock;
        entry.checkedAt = undefined;
        for (const dependency of entry.dependencies) {
          dependency.seen = dependency.stamp(context);
        }
        const slot = entry.key === undefined || entry.owner === undefined
          ? undefined
          : entry.owner.#slots.get(entry.key);
        if (slot !== undefined) {
          slot.marked = false;
          slot.all = false;
          slot.suspects.clear();
          slot.reads.clear();
        }
      }
    }
    open.record.committed = committed;
    if (error !== undefined) open.record.error = error;
    if (!committed) open.record.written = [];
    // The bytes of a document that is written whole follow its size,
    // so a measurement of time leaves them out.
    if (this.options.measure !== "patches") {
      for (const id of open.record.written) {
        open.record.bytes +=
          (JSON.stringify(this.store.docs.get(id)?.value) ?? "").length;
      }
    }
    if (committed) {
      const { stored } = open.record;
      for (const { instance, laid, patch, made } of open.laid.values()) {
        if (made > 0) stored.created += 1;
        if (made < 0) stored.deleted += 1;
        if (made < 0) continue;
        stored.documents += 1;
        stored.patchBytes += patch;
        stored.bytes += instance.#laidBytes(laid);
      }
    }
    const parted = this.store.parts?.seal();
    if (parted !== undefined) open.record.parted = parted;
    this.#tx = undefined;
    this.store.journal = undefined;
    this.#transactions.push(open.record);
    // The records the transaction gave read what its table of inputs
    // names, which the next transaction replaces.
    this.root.#flushReads();
    // What the hooks report of labels while they end the transaction is
    // what it stored, which the records it gave hold already.
    this.root.#ending = true;
    try {
      this.options.transactions?.end({
        committed,
        changes: committed ? open.journal : [],
        store: this.store,
        record: open.record,
      });
    } finally {
      this.root.#ending = false;
    }
  }

  /**
   * Runs `run` in the transaction in progress, or in one of its own of
   * the cause given where none is.
   */
  #within(cause: Transaction["cause"], run: () => void): void {
    if (this.#tx !== undefined) {
      run();
      return;
    }
    const open = this.#begin(cause);
    try {
      run();
    } finally {
      this.#end(open, true);
    }
  }

  /** Keeps what a document held before a transaction first wrote it. */
  #wrote(doc: string, path: readonly string[]): void {
    const open = this.#tx;
    if (open === undefined) return;
    if (!open.touched.has(doc)) {
      open.touched.add(doc);
      open.record.written.push(doc);
    }
    const writer = this.#evaluating[this.#evaluating.length - 1];
    if (writer === undefined) return;
    const name = `${writer.instance.id}\n${writer.key}`;
    const held = open.writes.get(name) ?? { ...writer, at: [] };
    held.at.push({ doc, path: [...path] });
    open.writes.set(name, held);
    let writers = this.#wroteAside.get(doc);
    if (writers === undefined) {
      writers = new Map();
      this.#wroteAside.set(doc, writers);
    }
    writers.set(name, writer);
  }

  /**
   * Withdraws the side-writes of a failed cone instance: each target
   * keeps what it had before the transaction (PL §5.2, "The write edges
   * of a failed cone").
   */
  #withdraw(open: Open, name: string): void {
    const written = open.writes.get(name);
    if (written === undefined) return;
    open.writes.delete(name);
    for (const { doc, path } of [...written.at].reverse()) {
      this.store.revert(doc, path, open.journal);
    }
  }

  /**
   * Undoes a transaction that does not commit: every document is as it
   * was, and the memo entry of each cone instance whose side-write is
   * undone is dropped, so a later evaluation performs the write
   * (ES §1.6).
   */
  #abort(open: Open): void {
    this.store.undo(open.journal);
    open.journal.length = 0;
    // A result document the transaction wrote holds what it held before,
    // and not what its store step placed: the next one places the whole
    // value.
    for (const doc of open.touched) {
      const owner = doc === this.id ? this : this.#instances.get(doc);
      if (owner !== undefined) owner.#storedResult = undefined;
    }
    for (const { instance, key } of open.writes.values()) {
      instance.#memo.delete(key);
      instance.#markUsers(key);
    }
    open.writes.clear();
  }

  /**
   * The cones with side-writes, by their kind (ruling Z7). A cone of kind
   * `static` has the targets of the write edges of its bodies that name a
   * state cell or the cell of a handle at a slot.
   */
  #sideWriters(): void {
    this.plan.cones.forEach((cone, index) => {
      if (cone.sideWrites === undefined) return;
      const run: Writer = (context) => {
        for (const instance of this.#contextsOf(index, context)) {
          this.code.values.forEach((value, number) => {
            if (value.cone !== index || !this.#values.has(number)) return;
            this.evaluated(number)(instance);
          });
        }
      };
      if (cone.sideWrites === "materializer") {
        this.#materializers.push(run);
        return;
      }
      const targets = cone.bodies.flatMap((body) =>
        this.plan.bodies[body].writes.flatMap(({ target }) => {
          if (target.kind === "state") {
            return [{
              root: { kind: "state", cell: target.cell },
              path: target.path ?? [],
            }];
          }
          if (target.kind === "handle" && target.slot !== undefined) {
            const slot = this.plan.slots[target.slot];
            return [{
              root: slot.root,
              path: [...slot.path, ...(target.path ?? [])],
            }];
          }
          return [];
        })
      );
      this.#writers.push({ cone: index, targets, run });
    });
  }

  /**
   * The cones with static side-writes that write at, above or below
   * `path` of `root`, other than the cone `reader`.
   */
  writersOf(
    root: Root,
    path: readonly string[],
    reader: number | undefined,
  ): Writer[] {
    if (this.#writers.length === 0) return [];
    return this.#writers.filter(({ cone, targets }) =>
      cone !== reader &&
      targets.some((target) =>
        sameRoot(target.root, root) &&
        (matchesPath(target.path, path) || matchesPath(path, target.path))
      )
    ).map(({ run }) => run);
  }

  /**
   * The element contexts a cone has an instance in, of those that extend
   * `context`: one for each key of each collection the cone is written
   * in that `context` does not bind.
   */
  #contextsOf(cone: number, context: Context): Context[] {
    let found: Context[] = [context];
    for (const collection of this.collectionsOf(cone)) {
      found = found.flatMap((known) => {
        if (known.has(collection)) return [known];
        const table = this.#tableOf(collection, known) ?? [];
        return table.map((element) =>
          new Map([...known, [collection, element]])
        );
      });
    }
    return found;
  }

  /** Creates the state cells declared for a context. */
  #declare(context: Context): void {
    const steps = [...context.keys()];
    this.plan.stateCells.forEach((cell, index) => {
      const within = cell.within.flatMap((step) =>
        step.element === undefined ? [] : [step.element]
      );
      if (canonical(within) !== canonical(steps)) return;
      // The function of the first value of a cell of a pattern compiled
      // in inside a cone is registered when that cone is first evaluated.
      if (cell.first !== undefined && !this.#states.has(index)) return;
      this.stateCell(index, new Host(this, context, undefined));
    });
  }

  // ----- the value code -----

  #runtime() {
    // deno-lint-ignore no-this-alias
    const instance = this;
    const none = new NoHost(this, new Map(), undefined);
    const force = (value: unknown, host: Host): unknown => {
      let found = value;
      while (found instanceof Thunk) found = found.evaluate(host);
      return found;
    };
    // Value code reads the host of no cone as a member of `$rt`.
    Object.freeze(none);
    return {
      nohost: none,
      // What `[SELF]` of the pattern's parameter names: the result.
      self: new Ref(this.id, []),
      // The value of a constant of frozen data, and an authored function
      // of module scope (`language-subset.md` §3.3, "Emitted code").
      data: freezeModuleData,
      fn: hardenFunction,
      // The body of a pattern compiled in, evaluated for one call of it.
      inline: (context: number, given: unknown, host: Host) => {
        const setup = this.#setups[context];
        if (setup === undefined) throw new Unsupported("no setup function");
        return setup(given, host);
      },
      external: (specifier: string) => instance.#external(specifier),
      dataFile: (index: number): string => {
        const text = instance.code.dataFiles?.[index]?.text;
        if (text === undefined) {
          throw new Unsupported(
            "a data file whose text the artifact does not hold",
          );
        }
        return text;
      },
      module: (index: number) => instance.#module(index),
      reexport: (exports: object, from: object) => {
        for (const name of Object.keys(from)) {
          if (name === "default") continue;
          Object.defineProperty(exports, name, {
            enumerable: true,
            get: () => (from as Record<string, unknown>)[name],
          });
        }
      },
      setup: (
        context: number,
        run: (given: unknown, host: Host) => unknown,
      ) => {
        this.#setups[context] = run;
      },
      value: (value: number, run: (host: Host) => unknown) => {
        this.#values.set(value, run);
      },
      element: (collection: number, run: (host: Host) => unknown) => {
        this.#elements.set(collection, run);
      },
      state: (cell: number, run: (host: Host) => unknown) => {
        this.#states.set(cell, run);
      },
      child: (child: number, run: (host: Host) => unknown) => {
        this.#childArguments.set(child, run);
      },
      request: (operation: number, run: (host: Host) => unknown) => {
        this.#requestFunctions.set(operation, run);
      },
      reduce: (
        operation: number,
        initialCone: number | undefined,
        initial: ((host: Host) => unknown) | undefined,
        stepCone: number,
        step: (host: Host) => unknown,
      ) => {
        this.#reduces.set(operation, { initialCone, initial, stepCone, step });
      },
      body: (body: number, run: (...given: unknown[]) => unknown) => {
        this.bodies.set(body, run);
      },
      handler: (binding: number, run: (...given: unknown[]) => unknown) => {
        this.#handlers.set(binding, run);
      },
      // A handler that a function body writes in place and binds.
      bound: (run: (...given: unknown[]) => unknown) =>
        instance.bind(run, undefined),
      thunk: (evaluate: (host: Host) => unknown) => new Thunk(evaluate),
      force,
      at: (root: unknown, path: string[], host: Host) => {
        let found = force(root, host);
        for (const segment of path) {
          found = host.settled(found);
          if (typeof found !== "object" || found === null) return undefined;
          found = force((found as Record<string, unknown>)[segment], host);
        }
        // The argument of a pattern compiled in, read whole: each path
        // that the call binds is held for the host that reads it.
        if (
          isRecord(found) &&
          Object.values(found).some((member) => member instanceof Thunk)
        ) {
          return Object.fromEntries(
            Object.entries(found).map((
              [name, member],
            ) => [name, force(member, host)]),
          );
        }
        return found;
      },
      or: (value: unknown, fallback: () => unknown) =>
        value === undefined ? fallback() : value,
      h: viewNode,
      hf: viewNodeOfBody,
      // The members of the operand of a spread in an array literal: none
      // for an operand that holds nothing.
      spread: (value: unknown): unknown[] =>
        Array.isArray(value)
          ? value
          : value === undefined || value === null
          ? []
          : Array.from(value as Iterable<unknown>),
    };
  }

  #runtimeObject: { nohost: Host } | undefined;

  /** Whether the modules of the value code are being evaluated. */
  loading = false;

  #load() {
    // Value code is handed this object and can replace none of its
    // members, and no function of it holds a property the code can set.
    const runtime = this.#runtime();
    for (const member of Object.values(runtime)) hardenFunction(member);
    this.#runtimeObject = Object.freeze(runtime);
    this.loading = true;
    this.#module(this.code.main);
    for (const { module } of this.code.modules) this.#module(module);
    this.loading = false;
    const setup = this.#setups[0];
    if (setup === undefined) throw new Unsupported("no setup function");
    const result = setup({}, this.#runtimeObject.nohost);
    this.#result = result instanceof Thunk ? result : new Thunk(() => result);
  }

  #module(index: number): Record<string, unknown> {
    const loaded = this.#modules.get(index);
    if (loaded !== undefined) return loaded;
    const exports: Record<string, unknown> = {};
    this.#modules.set(index, exports);
    const text = this.code.modules.find(({ module }) => module === index);
    if (text === undefined) {
      throw new Unsupported("an import of a module the artifact does not hold");
    }
    const globals = Object.entries(this.root.options.globals ?? {});
    const evaluate = this.root.options.evaluate ?? evaluateWithFunction;
    const run = evaluate(text, [
      "$rt",
      "$exports",
      ...globals.map(([name]) => name),
    ]);
    run(this.#runtimeObject, exports, ...globals.map(([, value]) => value));
    // The text has defined its exports. Another module is handed this
    // object for a namespace import, and adds or replaces no member.
    Object.freeze(exports);
    return exports;
  }

  #external(specifier: string): unknown {
    if (specifier === "commonfabric" || specifier.startsWith("commonfabric/")) {
      return commonfabric(this);
    }
    throw new Unsupported(`an import of \`${specifier}\``);
  }

  // ----- schemas and defaults -----

  schemaOf(id: string | undefined): Schema | undefined {
    return id === undefined ? undefined : this.#schemas.get(id);
  }

  // ----- places -----

  /**
   * The stream of a binding for the element keys a context has at the
   * `element` steps of the binding's `within`.
   */
  streamFor(binding: number, context: Context): StreamRef {
    const stream = new StreamRef(
      binding,
      this.keysOf(this.plan.bindings[binding].within, { context }),
      this.#owner,
    );
    const id = this.root.#streamIdentifier(stream);
    if (!this.root.#streamIndex.has(id)) {
      this.root.#streamIndex.set(id, {
        instance: this.id,
        binding,
        keys: [...stream.keys],
      });
    }
    return stream;
  }

  /**
   * What a stream names the instance of its binding by: nothing for the
   * instance the executor was started with, and the `id` of another.
   */
  get #owner(): string {
    return this === this.root ? "" : this.id;
  }

  /**
   * The identifier of a thing declared in the reactive tier (ES §5.2):
   * the hash of the cause that holds the instance, the type of the
   * thing, the steps of `within` outermost first, each `element` step
   * with the name of its collection and the key of the element as the
   * record it is, and the name. A state cell declared directly in the
   * pattern body under a name of one part has the cause of an internal
   * cell. `keys` has one key per `element` step. `again` tells an
   * instance from one that was re-keyed away from the same cause and
   * keeps its documents.
   */
  #identifier(
    type: string,
    within: readonly Step[],
    keys: readonly string[],
    name: Name,
    again = 0,
  ): string {
    if (type === "state" && within.length === 0 && typeof name === "string") {
      return identifierOf({ parent: this.id, type: "internal", cause: name });
    }
    let element = 0;
    const steps = within.map((step): FabricValue => {
      if (step.element === undefined) return { site: step.site };
      const key = keys[element];
      element += 1;
      return {
        element: this.plan.collections[step.element].name,
        // A step whose collection the context has no element for.
        ...(key === undefined || key === "?" ? {} : { key: recordOfKey(key) }),
      };
    });
    return identifierOf({
      parent: this.id,
      type,
      within: steps,
      cause: name,
      ...(again === 0 ? {} : { again }),
    });
  }

  /** The identifier of the document of a state cell under element keys. */
  stateCellDocument(cell: number, keys: readonly string[] = []): string {
    const record = this.plan.stateCells[cell];
    return this.#inScope(
      this.#identifier("state", record.within, keys, record.name),
      record.scope,
    );
  }

  /**
   * The identifier of the document that holds what an output returned
   * whole, under the element keys of its cone (`#generated()`). The
   * name is that of an interim output, and the index of another.
   */
  outputDocument(output: number, keys: readonly string[] = []): string {
    const record = this.plan.outputs[output];
    return this.#identifier(
      "output",
      this.plan.cones[record.cone].within,
      keys,
      record.interim ?? { output },
    );
  }

  /**
   * The cause that names the run of a `lift` or a `computed` (ES §5.5):
   * the instance, the name of the body, and the element keys that the
   * run is evaluated for.
   */
  runCause({ body, keys }: KeyedRun): FabricValue {
    return {
      parent: this.id,
      site: this.plan.bodies[body].name,
      within: keys.map(([collection, key]): FabricValue => ({
        element: this.plan.collections[collection].name,
        key: recordOfKey(key),
      })),
    };
  }

  /** The element keys of the `element` steps of a `within`. */
  keysOf(
    within: readonly { element?: number }[],
    host: { context: Context },
  ): string[] {
    return within.flatMap((step) =>
      step.element === undefined
        ? []
        : [host.context.get(step.element)?.key ?? "?"]
    );
  }

  /**
   * What a slot root is bound to in an evaluation. `path` is the path
   * the reader reads below the root: an element of the result of a
   * per-element construct is read from the result of that construct's
   * body for the element's key, and the reader depends on that path of
   * it alone.
   */
  rootOf(root: Root, host: Host, path: readonly string[] = []): unknown {
    switch (root.kind) {
      case "argument":
        return new Ref(this.argument, []);
      case "state":
        return this.stateCell(root.cell ?? 0, host);
      case "element": {
        const element = host.context.get(root.collection ?? -1);
        if (element === undefined) {
          throw new Unsupported("an element slot read outside its collection");
        }
        const { source } = element;
        // A reference to a cell, or a reference by key for a plain value
        // in place: a read through it is of the position that holds the
        // key now, and what passes it on stores it (ruling Z12).
        if (source instanceof Ref) return source;
        if ("entry" in source) {
          const upstream = host.depend(source.entry, [...source.at, ...path]);
          return host.at(upstream, source.at);
        }
        // A value with no place, as an element of an array that a
        // computation returned. Under a declared key field the element
        // of a key can hold another value in a later array, so the
        // reader depends on what the element of its key holds at the
        // path it reads (ruling Z38). The element is found in the table
        // of the collection by the key, whichever context the entry is
        // later checked under.
        const collection = root.collection ?? -1;
        const table = this.#name(
          "assembly",
          collection,
          this.#keysIn(this.#outerOf(collection), host.context),
        );
        const held = () => {
          const now = this.#tables.get(table)?.byKey.get(element.key)?.source ??
            source;
          return now instanceof Ref || !("value" in now)
            ? undefined
            : canonical(this.stored(host.at(now.value, path)));
        };
        const on = tableName(table);
        if (host.key !== undefined) this.uses(host.key, on);
        host.dependencies.push({ stamp: held, seen: held(), on });
        return source.value;
      }
      case "index": {
        const element = host.context.get(root.collection ?? -1);
        if (element === undefined) {
          throw new Unsupported("an index slot read outside its collection");
        }
        host.indexes.set(root.collection ?? -1, element.index);
        return element.index;
      }
      case "child":
        // The result of a child instance: the reader depends on the
        // evaluation that writes the child's argument, and reads the
        // result through the reference.
        return host.depend(this.#childResult(root.child ?? -1));
      case "operation": {
        const operation = root.operation ?? -1;
        if (this.#reduces.has(operation)) {
          // The accumulator, in the step of the `reduce`, and otherwise
          // what the `reduce` computed.
          return host.accumulator?.operation === operation
            ? host.accumulator.value
            : host.depend(this.reduced(operation));
        }
        if (this.#requestFunctions.has(operation)) {
          // The result of an effect or of a `wish`: the reader demands
          // the operation, and depends on the evaluation that stages its
          // request (SS §6.2, "When an operation of a plan is
          // demanded"). It holds the reference to the outcome and reads
          // nothing of the state document, which is of the scope of the
          // operation: a reader that passes the result on stays of its
          // own scope. A reader that reads through the reference reads
          // the error state of a request that was not made there.
          const state = host.depend(this.#operationState(operation)) as Ref;
          return state.key(OUTCOME);
        }
        // An operation with no function of its request: its result is
        // pending.
        this.counts.pendingOperations += 1;
        return { pending: true };
      }
      default:
        throw new Unsupported(`a slot of root \`${root.kind}\` read by a cone`);
    }
  }

  /**
   * A state cell, created when it is first named (PL §1.3, "The first
   * value of a state cell"). A first value that is a constant is the
   * default of the cell's schema: nothing is written, the cell has no
   * document until something writes it, and a read of it reads the
   * default. A first value that is not a constant is computed by the
   * cone `StateCell.first` names and written once, here.
   *
   * A cell whose schema declares a label is the exception to the first
   * rule: a label is stored with a document, so the constant is written
   * here under the schema, as the first value of the other kind is, and
   * the store that keeps the documents stores what the schema declares.
   */
  stateCell(cell: number, host: Host): Ref {
    const { scopes } = this.store;
    if (scopes === undefined) return this.#stateCellFor(cell, host);
    // A cell of a scope is given its first value once for each scope key,
    // and the evaluation that names the cell touched no scope instance by
    // naming it.
    return scopes.framed(() => this.#stateCellFor(cell, host)).value;
  }

  /** `stateCell()`, for the scope key that is evaluated for. */
  #stateCellFor(cell: number, host: Host): Ref {
    const record = this.plan.stateCells[cell];
    const keys = this.keysOf(record.within, host);
    const id = this.stateCellDocument(cell, keys);
    const instance = this.store.scopes?.resolve(id) ?? id;
    if (!this.#cells.has(instance)) {
      this.#cells.set(instance, { cell, keys });
      this.#documents.add(id);
      const schema = this.schemaOf(record.schema);
      this.store.declare(
        id,
        "state cell",
        typeof schema === "object" ? schema.default : undefined,
      );
      const first = record.first === undefined
        ? undefined
        : this.#states.get(cell);
      if (this.root.options.resume === true && this.store.docs.has(id)) {
        // The document holds what the run before stored.
      } else if (first !== undefined) {
        const reader = new Host(this, host.context, record.first?.cone);
        this.counts.evaluations += 1;
        // The edge of a first value always stores the value the cone
        // computed, and never a reference: a reference the value
        // function returns is stored as what it resolves to now, so a
        // write to the cell never lands in the input (ruling Z15).
        const value = this.stored(reader.v(first(reader)));
        const edge = record.first === undefined
          ? undefined
          : this.plan.cones[record.first.cone].writes?.[record.first.write];
        const recorded = this.#recording({
          instance: this,
          host: reader,
          records: [{
            record: { stateFirst: cell },
            template: edge?.template,
            doc: id,
            path: [],
          }],
        });
        try {
          this.store.write(
            new Ref(id, [], declaresLabel(schema) ? schema : undefined),
            value,
          );
        } finally {
          recorded();
        }
      } else if (
        typeof schema === "object" && schema.default !== undefined &&
        declaresLabel(schema) && this.root.#tx !== undefined
      ) {
        this.store.write(
          new Ref(id, [], schema),
          copyOfData(schema.default),
        );
      }
    }
    return new Ref(id, []);
  }

  /**
   * The instance of a call through `asInstance()` for the element keys
   * of a context, as the reference to its result document (PL §3.15, "A
   * call through `asInstance()`"; rulings Z35 and Z36). The instance is
   * one of the callee's own plan, with an argument document and a result
   * document of its own, identified by the child, which stands for the
   * site, and the key of each enclosing collection. It is made when the
   * key first appears. The evaluation writes the argument, and is made
   * again when what the argument holds changed. Nothing here is undone
   * when the key leaves: the memo entry of the evaluation is dropped
   * with the key, and the instance and its documents stay, so the key
   * that returns has the same instance.
   *
   * The argument, by case: a path bound to a reference to a cell holds
   * the link, which is the element over an array of references. A path
   * bound to a plain value in place, which the body names by a
   * reference by key, holds the value, and so does a path bound to a
   * value of the result of another per-element construct. A path bound
   * to a plain array generated from scratch, given whole, holds a link
   * to the stored output with the array schema (ruling Z54).
   */
  #childResult(child: number): Lazy {
    const record = this.plan.children?.[child];
    if (record === undefined || record.asInstance !== true) {
      throw new Unsupported(
        "a child that is not called through `asInstance()`",
      );
    }
    const within = record.within.flatMap((step) =>
      step.element === undefined ? [] : [step.element]
    );
    // The cone that holds the write edges of the argument.
    const found = this.plan.cones.findIndex((cone) =>
      (cone as { writes?: { target: { kind: string; child?: number } }[] })
        .writes?.some(({ target }) =>
          target.kind === "argument" && target.child === child
        )
    );
    const cone = found < 0 ? undefined : found;
    return (context) =>
      this.#ensureReference(
        this.#name("child", child, this.#keysIn(within, context)),
        context,
        cone,
        within.length > 0
          ? "element"
          : cone === undefined
          ? "assembly"
          : "value",
        (host) => {
          const run = this.#childArguments.get(child);
          const given = (placed: unknown): unknown => {
            const value = host.settled(placed);
            if (value instanceof Ref) {
              const { named } = this.store.locate(
                value,
                false,
                undefined,
                true,
              );
              return named.path.some(isKeySegment) ? host.v(value) : value;
            }
            if (Array.isArray(value)) {
              return this.linkToOutput(value) ?? value.map(given);
            }
            if (isRecord(value)) {
              return Object.fromEntries(
                Object.entries(value).map((
                  [name, member],
                ) => [name, given(member)]),
              );
            }
            return value;
          };
          const argument = this.stored(given(run?.(host)));
          const keys = within.map((collection) =>
            context.get(collection)?.key ?? "?"
          );
          const id = this.#identifier(
            "child",
            record.within,
            keys,
            record.name,
          );
          let held = this.#asInstances.get(id);
          if (held === undefined) {
            const artifact = typeof record.callee.compiled === "string"
              ? this.options.artifacts?.(record.callee.compiled)
              : undefined;
            if (artifact === undefined) {
              throw new Unsupported(
                "a child whose compiled pattern the executor was not given",
              );
            }
            // The identifier holds the key the instance was made under.
            // An instance that was re-keyed keeps its documents, so a
            // later instance of the same key gets an identifier beside
            // it.
            let made = id;
            for (let again = 1; this.root.#instances.has(made); again++) {
              made = this.#identifier(
                "child",
                record.within,
                keys,
                record.name,
                again,
              );
            }
            const recorded = this.#recording(
              this.#coneWrites(
                cone,
                host,
                argumentOf(made),
                [],
                (target) =>
                  target.kind === "argument" && target.child === child,
              ),
            );
            let instance: Instance;
            try {
              instance = new Instance(artifact, argument, {
                ...this.options,
                parent: this,
                id: made,
              });
            } finally {
              recorded();
            }
            this.root.#instances.set(made, instance);
            this.#children.push(instance);
            held = { child, keys, instance };
            this.#asInstances.set(id, held);
          } else {
            const recorded = this.#recording(
              this.#coneWrites(
                cone,
                host,
                held.instance.argument,
                [],
                (target) =>
                  target.kind === "argument" && target.child === child,
              ),
            );
            try {
              this.store.write(
                new Ref(held.instance.argument, []),
                argument,
              );
            } finally {
              recorded();
            }
          }
          return new Ref(held.instance.id, []);
        },
        within,
      );
  }

  /**
   * The reference to the stored output that an array is the whole value
   * of, for a plain array generated from scratch (ruling Z54): the
   * document of the output, under the schema of an array with the key
   * fields that the record of the output holds, so that a reader that
   * resolves the link learns them (ruling Z52). Nothing for another
   * array.
   */
  /**
   * The place of the output that an array is the whole value of: the
   * path of the result document where an output outside every element
   * body is kept, and otherwise the document of the output
   * (`linkToOutput()`). Nothing for another array.
   */
  placeOfOutput(array: readonly unknown[]): Ref | undefined {
    const from = this.returnedWhole.get(array);
    if (from === undefined) return undefined;
    const record = this.plan.outputs[from.output];
    if (
      record.kept && record.path.length > 0 &&
      this.plan.cones[record.cone].within.length === 0
    ) {
      return new Ref(this.id, record.path);
    }
    return this.linkToOutput(array);
  }

  linkToOutput(array: readonly unknown[]): Ref | undefined {
    const from = this.returnedWhole.get(array);
    if (from === undefined) return undefined;
    const place = this.#generated(from.output, array, from.context);
    if (place === undefined) return undefined;
    const { keyFields } = this.plan.outputs[from.output];
    return place.withSchema(
      keyFields === undefined ? undefined : { type: "array", keyFields },
    );
  }

  /**
   * The state document of an effect or of a `wish` for the element keys
   * of a context, as the reference to it (ES §6.4). The evaluation is
   * that of the cone that holds the write edges with target `request`:
   * it computes the request and stores it at `request` of the document,
   * a reference in it as a link. A request whose cone failed holds the
   * error state. The document is named from the instance, the element
   * keys and the name of the operation, so every evaluation names the
   * same one.
   *
   * The request of an effect is made by a request transaction of the
   * operation, behind the derivation transaction (`#requestTransactions`).
   * A `wish` is no effect (BI, `wish`): the same evaluation resolves it,
   * and stores a reference to what it resolved to at `result`.
   */
  #operationState(operation: number): Lazy {
    const record = this.plan.operations[operation];
    const within = (record.within ?? []).flatMap((step) =>
      step.element === undefined ? [] : [step.element]
    );
    const found = this.plan.cones.findIndex((cone) =>
      (cone as {
        writes?: { target: { kind: string; of?: { operation?: number } } }[];
      }).writes?.some(({ target }) =>
        target.kind === "request" && target.of?.operation === operation
      )
    );
    const cone = found < 0 ? undefined : found;
    const builtin = record.implementation?.builtin ?? record.kind;
    return (context) =>
      this.#ensureReference(
        this.#name("operation", operation, this.#keysIn(within, context)),
        context,
        cone,
        within.length > 0
          ? "element"
          : cone === undefined
          ? "assembly"
          : "value",
        (host) => {
          const keys = within.map((collection) =>
            context.get(collection)?.key ?? "?"
          );
          const id = this.#inScope(
            this.#identifier(
              "operation",
              record.within ?? [],
              keys,
              record.name,
            ),
            record.scope,
          );
          if (!this.#documents.has(id)) {
            this.#documents.add(id);
            this.store.declare(id, "operation state", undefined);
          }
          const run = this.#requestFunctions.get(operation);
          let request: unknown;
          try {
            // The request is the one argument of the call, and the
            // arguments in their order where the call has several.
            const given = run?.(host) as unknown[];
            request = given.length === 1 ? given[0] : given;
          } catch (error) {
            if (!failsCone(error)) throw error;
            request = error instanceof ReadsFailure
              ? error.state
              : errorState(messageOf(error));
          }
          const state = new Ref(id, []);
          request = host.whole(request);
          const recorded = this.#recording(
            this.#coneWrites(
              cone,
              host,
              id,
              ["request"],
              (target) => target.kind === "request" &&
                target.of?.operation === operation,
            ),
          );
          try {
            this.store.write(state.key("request"), this.stored(request));
          } finally {
            recorded();
          }
          if (record.kind === "wish") {
            this.#resolveWish(state, host.v(request), host, operation);
          } else if (
            !this.root.#operations.has(id) &&
            this.root.options.effects?.(builtin, { state: id }) !== true
          ) {
            this.root.#operations.set(id, { instance: this, builtin });
          }
          return state;
        },
        within,
      );
  }

  /**
   * Resolves a `wish` and stores the outcome in its state document. The
   * clock is a document that the runtime writes: `#now` reads it once,
   * into the state document, where that holds no time yet, and `#now/N`
   * resolves to a reference to it. Any other target is what the table of
   * the executor gives for the operands: an outcome whose links lead to
   * documents the executor was given, or a value, stored in a document of
   * its own, which the result is a reference to.
   */
  #resolveWish(
    state: Ref,
    operands: unknown,
    host: Host,
    operation: number,
  ): void {
    const { store } = this;
    const query = isRecord(operands) ? operands.query : operands;
    if (typeof query === "string" && /^#now(\/|$)/.test(query)) {
      if (!store.docs.has(CLOCK)) {
        store.create(CLOCK, "clock", this.root.options.now ?? 0);
      }
      const result = state.key(OUTCOME, "result");
      if (query === "#now") {
        if (store.read(result) === undefined) {
          store.write(result, store.read(new Ref(CLOCK, [])));
        }
      } else {
        store.write(result, this.stored(new Ref(CLOCK, [])));
      }
      return;
    }
    const answer = this.root.options.wishes?.(
      isRecord(operands) ? operands : { query: operands },
      { state: state.doc },
    );
    // The outcome is a write the plan has a record for: the operation, with
    // the slots its operands reach and the positions its resolution read
    // under the entry of `Plan.dynamicReads` that names it (PL §3.19, "The
    // outcome of each `wish` has a label of its own").
    const reads = (this.plan.dynamicReads ?? []).findIndex((held) => {
      const why = (held as { why?: { kind?: string; operation?: number } }).why;
      return why?.kind === "search" && why.operation === operation;
    });
    if (reads >= 0) host.dynamic.set(reads, [...answer?.reads ?? []]);
    const { input } = this.plan.operations[operation];
    const recorded = this.#recording({
      instance: this,
      host,
      records: [{
        record: { operation },
        // What the record reports: the slots of the operands, and the
        // reads of the resolution.
        template: {
          op: "derive",
          by: { expression: true },
          inputs: [
            ...(input === undefined ? [] : [input]),
            ...(reads < 0 ? [] : [{ op: "dynamic" as const, reads }]),
          ],
        },
        doc: state.doc,
        path: [...state.path, OUTCOME],
      }],
    });
    try {
      if (answer?.outcome !== undefined) {
        for (const [name, member] of Object.entries(answer.outcome)) {
          store.write(state.key(OUTCOME, name), this.stored(member));
        }
        return;
      }
      if (answer?.result === undefined) {
        store.write(
          state.key(OUTCOME, "error"),
          this.stored(answer?.error ?? `no target for \`${query}\``),
        );
        return;
      }
      const target = this.#inScope(
        identifierOf({ wish: this.id, target: `${query}` }),
        this.plan.operations[operation].scope,
      );
      if (!store.docs.has(target)) {
        store.create(target, "wish target", this.stored(answer.result));
      }
      store.write(
        state.key(OUTCOME, "result"),
        this.stored(new Ref(target, [])),
      );
    } finally {
      recorded();
    }
  }

  /**
   * Requests an effect for a handler body (SS §6.2, "In a handler"): the
   * event's transaction stages the request, its hash and the pending
   * mark in a state document named by the handling and the ordinal of
   * the request, with a link back to the result of the instance, and the
   * request leaves when the transaction commits, whatever reads its
   * result. It is made once. The body gets a handle to the result.
   */
  requestEffect(builtin: string, given: unknown[]): Handle {
    const { root, store } = this;
    const writer = root.#evaluating[root.#evaluating.length - 1];
    if (writer?.key !== HANDLER) {
      // A `lift` or a `computed` requests no effect itself (SS §6.1).
      throw new Unsupported(
        `the built-in \`${builtin}\` in a function body that is no handler`,
      );
    }
    const { cause, ordinal } = this.#next();
    const id = identifierOf(cause, { effect: ordinal });
    this.#documents.add(id);
    store.declare(id, "operation state", undefined);
    const state = new Ref(id, []);
    store.write(
      state.key("request"),
      this.stored(this.returned(given.length === 1 ? given[0] : given)),
    );
    store.write(state.key("of"), this.stored(new Ref(this.id, [])));
    const request = store.read(state.key("request"));
    const read = canonical(request);
    const hash = identifierOf({
      builtin,
      request: JSON.parse(read) as FabricValue,
    });
    store.write(state.key("requestHash"), hash);
    store.write(state.key(OUTCOME, "pending"), true);
    root.#operations.set(id, { instance: this, builtin, read, once: true });
    root.#sent += 1;
    root.#outbox.push({
      id: root.#sent,
      builtin,
      request,
      hash,
      operation: id,
    });
    return new Handle(this, state.key(OUTCOME), undefined, undefined, []);
  }

  /**
   * On the root: runs the request transaction of each demanded effect
   * whose request is stale (SS §6.2): the stored request changed, or
   * something behind a reference that it holds did. Each is a
   * transaction of its own. Returns whether one of them wrote.
   */
  #requestTransactions(): boolean {
    let wrote = false;
    for (const [doc, operation] of this.#operations) {
      if (operation.once) continue;
      const held = this.store.docs.get(doc)?.value;
      if (!isRecord(held) || !("request" in held)) continue;
      const state = new Ref(doc, []);
      // The references that the request holds are followed. The executor
      // follows every one, where BI gives each built-in the operands it
      // reads by value and how deep.
      const request = this.store.read(state.key("request"));
      const read = canonical(request);
      if (operation.read === read) continue;
      operation.read = read;
      const open = this.#begin("request");
      const failed = holdsErrorState(request);
      if (failed !== undefined) {
        // A request that holds an error state is not made, and the
        // operation's result is that error state: the outcome holds it,
        // and no request is outstanding, so the next request that holds
        // none is made.
        this.store.write(state.key(OUTCOME), failed);
        this.store.write(state.key("requestHash"), undefined);
      } else {
        const hash = identifierOf({
          builtin: operation.builtin,
          request: JSON.parse(read) as FabricValue,
        });
        if (isErrorState(this.store.read(state.key(OUTCOME)))) {
          this.store.write(state.key(OUTCOME), {});
        }
        if (held.requestHash !== hash) {
          // Neither a settled result of this request nor this request
          // outstanding: the hash and the pending mark are written, and
          // the request leaves.
          this.store.write(state.key("requestHash"), hash);
          this.store.write(state.key(OUTCOME, "pending"), true);
          this.#sent += 1;
          this.#outbox.push({
            id: this.#sent,
            builtin: operation.builtin,
            request,
            hash,
            operation: doc,
          });
        }
      }
      wrote ||= open.record.written.length > 0;
      this.#end(open, true);
    }
    return wrote;
  }

  /**
   * The instances that calls through `asInstance()` made, in the order
   * they were made, each with its child and the element keys it has now.
   */
  childInstances(): { child: number; keys: string[]; instance: Instance }[] {
    return [...this.#asInstances.values()];
  }

  /**
   * The place of the record of a key of a list. It holds nothing, and
   * has no document, until something writes it.
   */
  keyedElement(list: Ref, key: string): Ref {
    const id = identifierOf(
      { list: this.store.addressOf(this.store.locate(list, true).ref) },
      { key },
    );
    if (!this.store.declared.has(id)) {
      this.store.declare(id, "keyed element", undefined);
    }
    return new Ref(id, []);
  }

  /**
   * The identifier of a document that a function body of this instance
   * makes with no cause of its own: the instance, and the ordinal among
   * the documents that its bodies made. `kind` says what it is.
   */
  #fresh(kind: "cell" | "record" | "constant"): string {
    this.#created += 1;
    const id = identifierOf({ parent: this.id }, { [kind]: this.#created });
    this.#documents.add(id);
    return id;
  }

  /** A cell a function body made. */
  createCell(value: unknown): Handle {
    const id = this.#fresh("cell");
    this.#createdCells.add(id);
    this.store.create(id, "created cell", this.stored(value));
    return new Handle(this, new Ref(id, []), undefined, undefined, []);
  }

  /** A value in stored form: each reference in it as a link. */
  stored(
    value: unknown,
    /**
     * What stands in the place of a reference to an assembled
     * collection, by the path of the place in the value. Without it the
     * place holds a record of the name of the assembly, which is the
     * same for every state of the collection.
     */
    assembled?: (reference: Assembled | IndexHandle, path: string[]) => unknown,
    path: string[] = [],
    /**
     * The position that the result stores an array at already, where it
     * does: the place then holds a reference to that position, and no copy
     * of the array.
     */
    placed?: (array: readonly unknown[]) => Ref | undefined,
    /**
     * The value placed at the same position before, and what is told the
     * path of each record or array of `value` that is the value placed at
     * its position before: such a member is given as `SAME`, and nothing
     * below it is formed.
     */
    previous?: { was: unknown; same: (path: string[]) => void },
  ): unknown {
    // An index is compared by which bucket each element is in.
    if (value instanceof Index) return { $index: [...value.of] };
    if (value instanceof IndexHandle) {
      return assembled === undefined
        ? { $index: this.plan.collections[indexPartsOf(value).collection].name }
        : assembled(value, path);
    }
    if (value instanceof Assembled) {
      return assembled === undefined
        ? { $assembled: value.name }
        : assembled(value, path);
    }
    if (value instanceof Ref) {
      // A reference by key that the writer holds is stored with the key
      // the element has now (ruling Z24).
      const now = this.store.current(value);
      return {
        $link: {
          doc: now.doc,
          path: [...now.path],
          ...(now.schema === undefined ? {} : { schema: now.schema }),
        },
      };
    }
    if (value instanceof StreamRef) {
      return {
        $stream: {
          binding: value.binding,
          keys: [...value.keys],
          ...(value.instance === "" ? {} : { instance: value.instance }),
        },
      };
    }
    // The link to the stream a marker stands for, in the marker's place
    // (ES §2.2, "The replacement").
    if (value instanceof StreamMarker) return this.stored(streamOf(value));
    if (value instanceof Handle) return this.stored(targetOf(value));
    if (value instanceof Thunk) return undefined;
    if (typeof value === "function") return undefined;
    if (Array.isArray(value)) {
      const place = placed?.(value);
      if (place !== undefined) {
        return { $link: { doc: place.doc, path: [...place.path] } };
      }
      const before = Array.isArray(previous?.was) ? previous.was : undefined;
      return value.map((member, index) =>
        this.#storedMember(
          member,
          before?.[index],
          assembled,
          [...path, `${index}`],
          placed,
          previous,
        )
      );
    }
    if (isRecord(value)) {
      const before = isRecord(previous?.was) ? previous.was : undefined;
      const members: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(value)) {
        const kept = this.#storedMember(
          member,
          before?.[name],
          assembled,
          [...path, name],
          placed,
          previous,
        );
        if (kept !== undefined) members[name] = kept;
      }
      if (this.store.copies.has(value)) this.#copied.add(members);
      return members;
    }
    if (typeof value === "object" && value !== null) {
      // A primitive of the data model, such as a time, is stored as it
      // is.
      if (isDataPrimitive(value)) return value;
      throw new Unsupported(
        `a value that is no plain data: ${
          Object.getPrototypeOf(value)?.constructor?.name ?? "an object"
        } at ${path.join("/")}`,
      );
    }
    return value;
  }

  /**
   * Helper for `stored()`, which gives the stored form of a member of a
   * record or an array: `SAME` where a value placed before is given and
   * the member is the record or the array that it held at the member's
   * position, and the form of the member otherwise.
   */
  #storedMember(
    member: unknown,
    was: unknown,
    assembled:
      | ((reference: Assembled | IndexHandle, path: string[]) => unknown)
      | undefined,
    path: string[],
    placed: ((array: readonly unknown[]) => Ref | undefined) | undefined,
    previous: { was: unknown; same: (path: string[]) => void } | undefined,
  ): unknown {
    if (previous === undefined) {
      return this.stored(member, assembled, path, placed);
    }
    if (member === was && (Array.isArray(member) || isRecord(member))) {
      previous.same(path);
      return SAME;
    }
    return this.stored(member, assembled, path, placed, {
      was,
      same: previous.same,
    });
  }

  /**
   * The records in stored form that are a copy of a plain value in
   * place (ruling Z25): written into an array, such a record is stored
   * in place, as the value it is, and gets no document of its own.
   */
  readonly #copied = new WeakSet<object>();

  /**
   * A value in stored form that a body writes through a handle, with each
   * record that sits in an array of it put into a document of its own and
   * a link to that document in its place. Today's runtime does this for a
   * plain object that `Cell.set`, `Cell.push` or `Cell.addUnique` puts
   * into an array (`anchorValueAsEntity` in
   * `runtime/runner/src/data-updating.ts`), so an element that a handler
   * wrote is a cell, and the list is an array of references. A member the
   * body read from the list and writes back is a link already and is not
   * touched, and neither is a plain value that is no record. What the
   * creator of the instance wrote into the argument stays in place, and
   * so does the copy of a plain value in place that the body read and
   * writes back or writes into another array (ruling Z25).
   */
  anchored(value: unknown, inArray = false): unknown {
    if (isLink(value) || isStream(value)) return value;
    if (Array.isArray(value)) {
      return value.map((member) => this.anchored(member, true));
    }
    if (!isRecord(value)) return value;
    const members = Object.fromEntries(
      Object.entries(value).map((
        [name, member],
      ) => [name, this.anchored(member)]),
    );
    if (!inArray || this.#copied.has(value)) return members;
    const id = this.#fresh("record");
    this.store.create(id, "element record", members);
    return { $link: { doc: id, path: [] } };
  }

  /**
   * What a body returned or wrote: a handle in it as the reference it
   * holds, and a container that carries the address it was read from as
   * a reference to that address (ES §2.4, "A value passed on unchanged is
   * stored as a reference").
   */
  returned(value: unknown): unknown {
    if (value instanceof Handle) return targetOf(value);
    if (typeof value === "object" && value !== null) {
      const read = this.addressRead(value);
      if (read !== undefined) return new Ref(read.doc, read.path);
      // A stored container that the body was handed with no address is
      // the value it holds, as a copy of it is.
      if (this.store.holds(value)) return value;
    }
    if (Array.isArray(value)) {
      return value.map((member) => this.returned(member));
    }
    if (isRecord(value)) {
      const members = Object.fromEntries(
        Object.entries(value).map((
          [name, member],
        ) => [name, this.returned(member)]),
      );
      if (this.store.copies.has(value)) this.store.copies.add(members);
      return members;
    }
    return value;
  }

  /**
   * The handle a body is given for a reference. A position of handle type
   * that is bound to a value the instance holds no address for, such as a
   * constant written at the binding, gets a handle that reads the value
   * and refuses a write (PL §3.11, "A write through a handle to a value
   * the instance computes").
   */
  handleOf(
    value: unknown,
    host: Host | undefined,
    slot?: number,
    /**
     * The identifier of the schema of the type the body declares for the
     * handle (`Body.reads`, `schema`), where the plan holds it. Without it
     * the handle reads under the schema of the slot, the type of the place.
     */
    declaredBy?: string | false,
  ): unknown {
    const declared = handleVariant(
      typeof declaredBy === "string"
        ? this.schemaOf(declaredBy)
        : slot === undefined
        ? undefined
        : this.schemaOf(this.plan.slots[slot].schema),
    );
    if (value instanceof StreamMarker) {
      return new Handle(this, streamOf(value), host, slot, [], declared);
    }
    // A reference at a position whose declared type is no handle is a
    // reference stand-in (ES §2.4): the body can pass it on, and what it
    // passes on is stored as the reference. It has no member of its own,
    // and the entries below its path are placed in it. The schema of a
    // slot of a handler's state is that of the handler's declared type.
    // The schema of another slot is that of the place, which does not
    // say what the body declares, and the body is handed a handle.
    if (
      value instanceof Ref && typeof declared === "object" &&
      declared.asCell === undefined && slot !== undefined &&
      this.plan.slots[slot].root.kind === "binding"
    ) {
      const standIn = {};
      this.store.addresses.set(
        standIn,
        this.store.locate(value, true, undefined, true).named,
      );
      return standIn;
    }
    if (value instanceof Ref || value instanceof StreamRef) {
      return new Handle(this, value, host, slot, [], declared);
    }
    if (
      value !== undefined && typeof declared === "object" &&
      declared.asCell !== undefined
    ) {
      return this.handleOfConstant(value, host, slot, declared);
    }
    return value;
  }

  /**
   * A handle that reads `value`, a value the instance holds no address
   * for, and refuses a write.
   */
  handleOfConstant(
    value: unknown,
    host: Host | undefined,
    slot?: number,
    declared?: Schema,
  ): Handle {
    const id = this.#fresh("constant");
    this.store.create(id, "held constant", this.stored(value));
    return new Handle(this, new Ref(id, []), host, slot, [], declared, true);
  }

  /**
   * What `equals` compares of `value`: the text of the address it resolves
   * to, or `undefined` for a value with no place in the graph (provisional
   * decision P41, `equalsKey`).
   */
  equalsKey(value: unknown, reactive = false): string | undefined {
    const named = value instanceof Handle ? targetOf(value) : undefined;
    if (named instanceof StreamRef) {
      const { instance, binding, keys } = named;
      return textOf({
        stream: { instance, binding, keys: [...keys] },
      });
    }
    const ref = value instanceof Handle
      ? targetOf(value) as Ref
      : value instanceof Ref
      ? value
      : typeof value === "object" && value !== null
      ? this.addressRead(value, reactive)
      : undefined;
    // A key that no position holds resolves to no position: the
    // reference is compared as the key it holds.
    return ref === undefined
      ? undefined
      : this.store.addressText(this.store.locate(ref, true).ref);
  }

  /**
   * Whether two values a body holds are one: two handles or two values
   * read from one stored address, and otherwise two equal values. Each
   * reference is resolved to the position it names now and the two are
   * compared there (ruling Z26): a handle by position, as `items.key(i)`
   * is at the call and when stored (ruling Z33), is equal to a reference
   * by key to the element that is at the position at that time, and to
   * the cell of the element where the position holds a link.
   */
  same(a: unknown, b: unknown, reactive = false): boolean {
    const [left, right] = [
      this.equalsKey(a, reactive),
      this.equalsKey(b, reactive),
    ];
    if (left !== undefined && right !== undefined) return left === right;
    // A value read from a stored address and one that was not are two.
    if (left !== undefined || right !== undefined) return false;
    return canonical(a) === canonical(b);
  }

  /**
   * A value about to be stored at `target`, with each link in it that
   * leads into what the write replaces put as the value stored there now:
   * a list written back in another order holds its members and not links
   * to its own positions.
   */
  detached(target: Ref, value: unknown): unknown {
    const at = this.store.locate(target, true).ref;
    const inside = (link: { doc: string; path: string[] }) =>
      link.doc === at.doc &&
      at.path.every((segment, index) => segment === link.path[index]);
    const copy = (member: unknown, depth = 0): unknown => {
      if (isLink(member)) {
        const named = new Ref(member.$link.doc, member.$link.path);
        // A link to a position of what the write replaces that holds a
        // link itself, as the position of a record with a document of
        // its own does, is put as the link that position holds.
        const position = this.store.locate(named, false);
        if (
          depth < 64 && isLink(position.value) &&
          inside({ doc: position.ref.doc, path: [...position.ref.path] })
        ) {
          return copy(position.value, depth + 1);
        }
        const located = this.store.locate(named, true);
        return inside({ doc: located.ref.doc, path: [...located.ref.path] })
          ? copyOfData(located.value)
          : member;
      }
      if (Array.isArray(member)) return member.map((inner) => copy(inner));
      if (isRecord(member)) {
        return Object.fromEntries(
          Object.entries(member).map(([name, inner]) => [name, copy(inner)]),
        );
      }
      return member;
    };
    return copy(value);
  }

  /**
   * Whether an entry of class `observes` leaves what the argument holds
   * at its path already. A handle at the path or above it stays: the
   * entries at and below a handle's position are what a read through the
   * handle gives, and the body is handed the handle. A `shape` or an
   * `enumeration` entry gives way to what another entry holds there
   * (ES §2.4).
   */
  gives(observes: string, argument: unknown, at: readonly string[]): boolean {
    let held = argument;
    for (const segment of at) {
      if (held instanceof Handle) return true;
      held = isRecord(held) || Array.isArray(held)
        ? (held as Record<string, unknown>)[segment]
        : undefined;
    }
    if (held instanceof Handle) return true;
    return observes !== "identity" && observes !== "value" &&
      held !== undefined;
  }

  /** A record with `value` at a path of it. */
  placed(holder: unknown, at: readonly string[], value: unknown): unknown {
    if (at.length === 0) return value;
    const [first, ...rest] = at;
    const members: Record<string, unknown> = isRecord(holder)
      ? { ...holder }
      : {};
    members[first] = this.placed(members[first], rest, value);
    // A reference stand-in that gets a member is the stand-in still.
    const address = isRecord(holder) ? this.addressRead(holder) : undefined;
    if (address !== undefined) this.store.addresses.set(members, address);
    return members;
  }

  // ----- evaluation -----

  /** The element keys of a context, by collection. */
  contextKeys(context: Context): [number, string][] {
    return [...context].map(([collection, { key }]) => [collection, key]);
  }

  /** The key that a context has for each of `collections`, in order. */
  #keysIn(collections: readonly number[], context: Context): string[] {
    return collections.map((collection) => context.get(collection)?.key ?? "?");
  }

  /**
   * The name of a memo entry, of an element table, or of what is kept
   * under an element key: the text that the codec writes for the record
   * of the kind, its index in the plan, the element keys around it, and
   * for an element its own key (PL §1.2, "Written forms"). A key is in
   * the record as the record it is, and a step whose collection the
   * context has no element for as `null`.
   */
  #name(
    kind:
      | "value"
      | "child"
      | "operation"
      | "reduce"
      | "assembly"
      | "element"
      | "under",
    index: number,
    around: readonly string[],
    key?: string,
  ): string {
    // The names are formed once: a name is looked up for every pull of
    // its entry.
    const outer = around.length === 0
      ? `${kind} ${index}`
      : `${kind} ${index} ${around.join("\n")}`;
    let names = this.#names.get(outer);
    if (names === undefined) {
      names = new Map();
      this.#names.set(outer, names);
    }
    const known = names.get(key ?? "");
    if (known !== undefined) return known;
    const record = (text: string): FabricValue => {
      if (text === "?") return null;
      let found = this.#keyRecords.get(text);
      if (found === undefined) {
        found = recordOfKey(text);
        this.#keyRecords.set(text, found);
      }
      return found;
    };
    const name = textOf({
      [kind]: index,
      around: around.map(record),
      ...(key === undefined ? {} : { key: record(key) }),
    });
    names.set(key ?? "", name);
    return name;
  }

  /** The names that `#name` formed, by what they are of and by key. */
  readonly #names = new Map<string, Map<string, string>>();

  /** The element table of a collection for the keys of a context. */
  #tableOf(collection: number, context: Context): Element[] | undefined {
    return this.#tables.get(
      this.#name(
        "assembly",
        collection,
        this.#keysIn(this.#outerOf(collection), context),
      ),
    )?.elements;
  }

  /**
   * A reference to the assembled result of a collection, for the
   * element keys of a context.
   */
  assembledBy(collection: number, context: Context): Assembled {
    return new Assembled(
      collection,
      context,
      this.#name(
        "assembly",
        collection,
        this.#keysIn(this.#outerOf(collection), context),
      ),
    );
  }

  /**
   * A context with, for each collection, the element that the element
   * table holds under the key now: its position is the one it has now.
   */
  freshContext(context: Context): Context {
    if (context.size === 0) return context;
    const fresh = new Map<number, Element>();
    for (const [collection, element] of context) {
      const table = this.#tables.get(
        this.#name(
          "assembly",
          collection,
          this.#keysIn(this.#outerOf(collection), fresh),
        ),
      );
      fresh.set(collection, table?.byKey.get(element.key) ?? element);
    }
    return fresh;
  }

  // ----- the stored result -----

  /**
   * Each place of the stored result that holds the rows of an assembled
   * collection, by the name of the assembly: one collection can stand
   * at several places.
   */
  readonly #units = new Map<string, Set<Unit>>();
  /** The units that stand in no row of another, by their path. */
  readonly #rootUnits = new Map<string, Unit>();
  /** The units whose assembly may have changed since it was stored. */
  readonly #dueUnits = new Set<Unit>();
  /** The entry of the result as it was last stored. */
  #storedResult: Entry | undefined;

  /** The path of the result document at which a unit stores its rows. */
  #pathOf(unit: Unit): string[] {
    const { place } = unit;
    if ("path" in place) return place.path;
    return [
      ...this.#pathOf(place.unit),
      `${this.#positionIn(place.unit, place.key)}`,
      ...place.below,
    ];
  }

  /** The position at which a unit stores the row of a key. */
  #positionIn(unit: Unit, key: string): number {
    if (unit.positions === undefined) {
      unit.positions = new Map();
      unit.keys.forEach((held, index) => unit.positions?.set(held, index));
    }
    return unit.positions.get(key) ?? -1;
  }

  /** Whether a unit still stands where it was put. */
  #stands(unit: Unit): boolean {
    return this.#units.get(unit.name)?.has(unit) === true;
  }

  /** Forgets a unit and the units inside its rows. */
  #dispose(unit: Unit): void {
    const units = this.#units.get(unit.name);
    units?.delete(unit);
    if (units?.size === 0) this.#units.delete(unit.name);
    this.#dueUnits.delete(unit);
    this.#touched.delete(unit);
    this.#touchedRows.delete(unit);
    // Its part documents are deleted with it, and what holds it counts
    // its rows as stored in place, as the value that replaces it is.
    if (unit.part) {
      this.#wroteLaid({ unit }, 0, -1);
      const holder = "path" in unit.place ? undefined : unit.place;
      if (holder === undefined || this.#stands(holder.unit)) {
        unit.part = false;
        this.#growHolder(unit, this.#contentOf(unit) - Instance.LINK_BYTES);
      }
    }
    unit.parted.forEach((parted, index) => {
      if (parted) this.#wroteLaid({ unit, key: unit.keys[index] }, 0, -1);
    });
    for (const inside of unit.inside.values()) {
      for (const inner of inside.values()) this.#dispose(inner);
    }
    unit.inside.clear();
  }

  /**
   * The stored form of a value that stands at a place of the result
   * (`execution-and-storage.md` §4.2): a reference to an assembled
   * collection as the rows of the collection, each row in stored form.
   * `inside` holds the units of the holder of the place, by their path
   * below it. A reference that stands where the same collection stood
   * gives `KEPT`: its rows are stored already and are brought up to
   * date by themselves. `seen` gets the path of each reference. Where
   * `previous` gives the value placed at the place before, a record or
   * an array that is the one placed at its position gives `SAME`, and
   * `previous.same` gets its path below the holder.
   */
  #formOf(
    value: unknown,
    owner: { unit: Unit; key: string } | undefined,
    below: readonly string[],
    seen: Set<string>,
    previous?: { was: unknown; same: (path: string[]) => void },
  ): unknown {
    const inside = owner === undefined
      ? this.#rootUnits
      : owner.unit.inside.get(owner.key) ?? new Map<string, Unit>();
    if (owner !== undefined) owner.unit.inside.set(owner.key, inside);
    return this.stored(
      value,
      (reference, path) => {
        const at = [...below, ...path];
        if (reference instanceof IndexHandle) {
          return this.#indexForm(reference, at, owner === undefined);
        }
        const id = JSON.stringify(at);
        const placed = this.#scopedRows(reference, at, owner === undefined);
        if (placed !== undefined) return placed;
        seen.add(id);
        const known = inside.get(id);
        if (known !== undefined && known.name === reference.name) {
          this.#dueUnits.add(known);
          return KEPT;
        }
        if (known !== undefined) this.#dispose(known);
        const unit: Unit = {
          name: reference.name,
          collection: reference.collection,
          context: reference.context,
          place: owner === undefined
            ? { path: at }
            : { unit: owner.unit, key: owner.key, below: at },
          keys: [],
          values: [],
          inside: new Map(),
          serial: this.#unitSerial++,
          sizes: [],
          parted: [],
          splits: [],
          forced: new Set(),
          sum: 0,
          part: false,
          partForced: false,
          swept: false,
        };
        inside.set(id, unit);
        const units = this.#units.get(unit.name) ?? new Set();
        units.add(unit);
        this.#units.set(unit.name, units);
        if (owner === undefined) this.#claimStored(unit);
        const rows = this.#rowsOf(unit);
        if (owner === undefined) this.#unitPlaced(unit);
        return rows;
      },
      [],
      (array) => bucketPlaces.get(array),
      previous === undefined ? undefined : {
        was: previous.was,
        same: (path) => previous.same([...below, ...path]),
      },
    );
  }

  /** The rows of a unit in stored form, from its assembly as it is now. */
  #rowsOf(unit: Unit): unknown[] {
    const entry = this.assembled(unit.collection, this.#leftStored(unit))(
      this.freshContext(unit.context),
    );
    const values = Array.isArray(entry.value) ? entry.value : [];
    unit.seen = entry;
    unit.keys = (entry.members ?? []).map(({ key }) => key);
    unit.values = [...values];
    unit.positions = undefined;
    if ("path" in unit.place) {
      const at = JSON.stringify([this.id, unit.place.path]);
      this.store.rowKeys.set(at, () => unit.keys);
      this.store.rowCollections.set(at, unit.collection);
    }
    const forms = values.map((value, index) =>
      // A row the executor holds as stored is stored already.
      value === STORED_ROW ? KEPT : this.#formOf(
        value,
        { unit, key: unit.keys[index] ?? `${index}` },
        [],
        new Set(),
      )
    );
    unit.sizes = forms.map(bytesOf);
    unit.parted = forms.map(() => false);
    unit.splits = forms.map(splits);
    unit.forced.clear();
    unit.swept = false;
    unit.sum = unit.sizes.reduce((sum, size) => sum + size, 0);
    this.#touched.add(unit);
    this.#touchedRows.set(unit, new Set(unit.keys));
    return forms;
  }

  // ----- the layout of the stored result -----

  #unitSerial = 0;
  /** The bytes that the result document holds, a part as its link. */
  #rootSize = 0;
  /** The units that the transaction in progress changed. */
  readonly #touched = new Set<Unit>();
  /** The rows that it changed, by unit. */
  readonly #touchedRows = new Map<Unit, Set<string>>();

  /** The bytes of a storage link (`execution-and-storage.md` §4.10). */
  static readonly LINK_BYTES = bytesOf({ $part: identifierOf({}) });

  /** The bytes that the array of a unit takes, with its brackets. */
  #contentOf(unit: Unit): number {
    return 2 + unit.sum + Math.max(0, unit.keys.length - 1);
  }

  /** The bytes that a document of the layout holds. */
  #laidBytes({ unit, key }: Laid): number {
    if (unit === undefined) return this.#rootSize;
    if (key === undefined) return this.#contentOf(unit);
    return unit.sizes[this.#positionIn(unit, key)] ?? 0;
  }

  /** The document that stores the array of a unit. */
  #laidOfUnit(unit: Unit): Laid {
    if (unit.part) return { unit };
    return "path" in unit.place
      ? {}
      : this.#laidOfRow(unit.place.unit, unit.place.key);
  }

  /** The document that stores the row of a key. */
  #laidOfRow(unit: Unit, key: string): Laid {
    return unit.parted[this.#positionIn(unit, key)]
      ? { unit, key }
      : this.#laidOfUnit(unit);
  }

  /** Counts a write to a document of the layout for the transaction. */
  #wroteLaid(laid: Laid, patch: number, made = 0): void {
    const open = this.root.#tx;
    if (open === undefined) return;
    const id = laid.unit === undefined
      ? this.id
      : `${this.id} ${laid.unit.serial} ${laid.key ?? ""}`;
    const held = open.laid.get(id) ??
      { instance: this, laid, patch: 0, made: 0 };
    held.patch += patch;
    held.made += made;
    open.laid.set(id, held);
  }

  /** The bytes of a row changed by `delta`. */
  #growRow(unit: Unit, key: string, delta: number): void {
    const index = this.#positionIn(unit, key);
    if (index < 0) return;
    unit.sizes[index] += delta;
    const rows = this.#touchedRows.get(unit) ?? new Set();
    rows.add(key);
    this.#touchedRows.set(unit, rows);
    this.#touched.add(unit);
    if (!unit.parted[index]) this.#growUnit(unit, delta);
  }

  /** The bytes that the rows of a unit take in its array changed. */
  #growUnit(unit: Unit, delta: number): void {
    unit.sum += delta;
    this.#touched.add(unit);
    if (!unit.part) this.#growHolder(unit, delta);
  }

  /** The bytes of what holds the array of a unit changed. */
  #growHolder(unit: Unit, delta: number): void {
    if ("path" in unit.place) this.#rootSize += delta;
    else this.#growRow(unit.place.unit, unit.place.key, delta);
  }

  /**
   * Splices the stored rows of a unit: the store, what the unit holds
   * of its rows, and the sizes.
   */
  #spliceRows(
    unit: Unit,
    path: readonly string[],
    start: number,
    removed: readonly string[],
    inserted: readonly string[],
    values: readonly unknown[],
    /** Gives each row that enters in stored form. */
    formed: () => unknown[],
  ): void {
    // A row that leaves and enters again in the same splice is stored
    // anew, with what is in it.
    for (const key of removed) {
      for (const inner of unit.inside.get(key)?.values() ?? []) {
        this.#dispose(inner);
      }
      unit.inside.delete(key);
    }
    const forms = formed();
    const before = this.#contentOf(unit);
    const laid = this.#laidOfUnit(unit);
    let sum = 0;
    for (let index = start; index < start + removed.length; index++) {
      if (unit.parted[index]) {
        sum -= Instance.LINK_BYTES;
        this.#wroteLaid({ unit, key: unit.keys[index] }, 0, -1);
      } else {
        sum -= unit.sizes[index];
      }
    }
    const sizes = forms.map(bytesOf);
    for (const size of sizes) sum += size;
    const appended = start === unit.keys.length && removed.length === 0;
    spliceIn(unit.keys, start, removed.length, inserted);
    spliceIn(unit.values, start, removed.length, values);
    spliceIn(unit.sizes, start, removed.length, sizes);
    spliceIn(unit.parted, start, removed.length, forms.map(() => false));
    spliceIn(unit.splits, start, removed.length, forms.map(splits));
    for (const key of removed) unit.forced.delete(key);
    // The positions of the other rows stand where as many rows entered
    // as left.
    if (
      unit.positions !== undefined &&
      (appended || removed.length === inserted.length)
    ) {
      for (const key of removed) unit.positions.delete(key);
      inserted.forEach((key, offset) =>
        unit.positions?.set(key, start + offset)
      );
    } else {
      unit.positions = undefined;
    }
    // The store reports the splice to the transaction hooks as it makes
    // it, and the write records of the rows that entered take their
    // element keys from the unit (`#keysAlong`): the unit holds the new
    // keys first. A row whose key was formed from its value has another
    // key after a change of that value, at the same position.
    this.store.spliceAt(this.id, path, start, removed.length, forms);
    unit.sum += sum;
    this.#touched.add(unit);
    const rows = this.#touchedRows.get(unit) ?? new Set();
    for (const key of inserted) rows.add(key);
    this.#touchedRows.set(unit, rows);
    if (!unit.part) this.#growHolder(unit, this.#contentOf(unit) - before);
    this.#wroteLaid(laid, sizes.reduce((total, size) => total + size, 0));
  }

  /** Stores a row, or the array of a unit, in a part document. */
  #toPart(unit: Unit, key: string | undefined, forced: boolean): void {
    const link = Instance.LINK_BYTES;
    if (key === undefined) {
      const content = this.#contentOf(unit);
      const holder = this.#laidOfUnit(unit);
      unit.part = true;
      unit.partForced = forced;
      this.#growHolder(unit, link - content);
      this.#wroteLaid(holder, link);
      this.#wroteLaid({ unit }, content, 1);
      return;
    }
    const index = this.#positionIn(unit, key);
    const holder = this.#laidOfUnit(unit);
    unit.parted[index] = true;
    if (forced) unit.forced.add(key);
    this.#growUnit(unit, link - unit.sizes[index]);
    this.#wroteLaid(holder, link);
    this.#wroteLaid({ unit, key }, unit.sizes[index], 1);
  }

  /** Stores a part in place again, and deletes its document. */
  #toPlace(unit: Unit, key: string | undefined): void {
    const link = Instance.LINK_BYTES;
    if (key === undefined) {
      const content = this.#contentOf(unit);
      this.#wroteLaid({ unit }, 0, -1);
      unit.part = false;
      unit.partForced = false;
      this.#growHolder(unit, content - link);
      this.#wroteLaid(this.#laidOfUnit(unit), content);
      return;
    }
    const index = this.#positionIn(unit, key);
    this.#wroteLaid({ unit, key }, 0, -1);
    unit.parted[index] = false;
    unit.swept = false;
    unit.forced.delete(key);
    this.#growUnit(unit, unit.sizes[index] - link);
    this.#wroteLaid(this.#laidOfUnit(unit), unit.sizes[index]);
  }

  /** How many rows are above a unit. */
  #depthOf(unit: Unit): number {
    return "path" in unit.place ? 0 : 1 + this.#depthOf(unit.place.unit);
  }

  /**
   * Applies the rule on size to the split points on the paths that the
   * transaction wrote, from the innermost outward
   * (`execution-and-storage.md` §4.10, "The rule about size"). The
   * split points are the rows of a collection that stands in the
   * result, and the array of the collection, which is the root of a
   * kept output. A node of the rendered tree that is no row is none
   * here. The sizes are kept and are not measured again: the document
   * has them computed from the documents being written.
   */
  #arrange(): void {
    const link = Instance.LINK_BYTES;
    const half = DOCUMENT_MAX_BYTES / 2;
    for (let round = 0; round < 64 && this.#touched.size > 0; round++) {
      const units = [...this.#touched].filter((unit) => this.#stands(unit))
        .sort((a, b) => this.#depthOf(b) - this.#depthOf(a));
      const rowsOf = new Map(this.#touchedRows);
      this.#touched.clear();
      this.#touchedRows.clear();
      for (const unit of units) {
        for (const key of rowsOf.get(unit) ?? []) {
          const index = this.#positionIn(unit, key);
          if (index < 0 || !unit.splits[index]) continue;
          const size = unit.sizes[index];
          if (!unit.parted[index] && size >= PART_SPLIT_BYTES) {
            this.#toPart(unit, key, false);
          } else if (
            !unit.parted[index] && unit.swept && unit.part &&
            this.#contentOf(unit) > DOCUMENT_MAX_BYTES
          ) {
            // A row that entered an array which holds more than a
            // document may, and whose other rows are parts.
            this.#toPart(unit, key, true);
          } else if (
            unit.parted[index] && size <= PART_MERGE_BYTES &&
            (!unit.forced.has(key) ||
              this.#laidBytes(this.#laidOfUnit(unit)) + size - link <= half)
          ) {
            this.#toPlace(unit, key);
          }
        }
        const content = this.#contentOf(unit);
        if (!unit.part && content >= PART_SPLIT_BYTES) {
          this.#toPart(unit, undefined, false);
        } else if (unit.part && content <= PART_MERGE_BYTES) {
          const holder = "path" in unit.place
            ? {}
            : this.#laidOfRow(unit.place.unit, unit.place.key);
          if (
            !unit.partForced ||
            this.#laidBytes(holder) + content - link <= half
          ) this.#toPlace(unit, undefined);
        }
        // A part that holds more than a document may: each row that is
        // stored in place becomes a part, whatever its size.
        if (
          unit.part && !unit.swept &&
          this.#contentOf(unit) > DOCUMENT_MAX_BYTES
        ) {
          unit.keys.forEach((key, index) => {
            if (!unit.parted[index] && unit.splits[index]) {
              this.#toPart(unit, key, true);
            }
          });
          unit.swept = true;
        }
        // A row that is a part and holds more than a document may: the
        // arrays in it become parts.
        for (const key of rowsOf.get(unit) ?? []) {
          const index = this.#positionIn(unit, key);
          if (
            index < 0 || !unit.parted[index] ||
            unit.sizes[index] <= DOCUMENT_MAX_BYTES
          ) continue;
          for (const inner of unit.inside.get(key)?.values() ?? []) {
            if (!inner.part) this.#toPart(inner, undefined, true);
          }
        }
      }
      if (this.#rootSize > DOCUMENT_MAX_BYTES) {
        for (const unit of this.#rootUnits.values()) {
          if (!unit.part) this.#toPart(unit, undefined, true);
        }
      }
    }
    this.#touched.clear();
    this.#touchedRows.clear();
  }

  /** A salted name of a key, for the identifier of a part. */
  #hashedKey(key: string): FabricValue {
    return this.store.salted(recordOfKey(key));
  }

  /**
   * The documents that the layout stores the result in, by identifier
   * (`execution-and-storage.md` §4.10): the result document, and each
   * part with its value, the link back to the result, and the steps
   * and the path that it is named from. A part stands in its holder as
   * `{ $part: <identifier> }`. The executor reads the result from one
   * document that holds it whole (`Instance.id` in the store), and
   * forms these from it when asked.
   */
  laidOut(): Map<string, unknown> {
    const documents = new Map<string, unknown>();
    const within = (unit: Unit): FabricValue[] =>
      "path" in unit.place ? [] : [
        ...within(unit.place.unit),
        {
          element: this.plan.collections[unit.place.unit.collection].name,
          key: this.#hashedKey(unit.place.key),
        },
      ];
    const part = (steps: FabricValue[], cause: string[], value: unknown) => {
      const id = identifierOf({
        parent: this.id,
        type: "part",
        within: steps,
        cause,
      });
      documents.set(id, {
        value,
        result: { $link: { doc: this.id, path: [] } },
        within: steps,
        path: cause,
      });
      return { $part: id };
    };
    // A stored value with each unit in it as the layout stores it.
    const withUnits = (
      value: unknown,
      inside: Map<string, Unit> | undefined,
    ): unknown => {
      if (inside === undefined || inside.size === 0) return value;
      const copy = copyOfData(value);
      const holder = { value: copy } as Record<string, unknown>;
      for (const [id, unit] of inside) {
        const at = JSON.parse(id) as string[];
        let from = holder;
        let name = "value";
        for (const segment of at) {
          from = from[name] as Record<string, unknown>;
          name = segment;
        }
        from[name] = rowsOf(unit);
      }
      return holder.value;
    };
    const rowsOf = (unit: Unit): unknown => {
      const held = this.store.peek(this.id, this.#pathOf(unit));
      const steps = within(unit);
      const rows = (Array.isArray(held) ? held : []).map((row, index) => {
        const key = unit.keys[index];
        const value = withUnits(row, unit.inside.get(key));
        return unit.parted[index]
          ? part(
            [...steps, {
              element: this.plan.collections[unit.collection].name,
              key: this.#hashedKey(key),
            }],
            [],
            value,
          )
          : value;
      });
      return unit.part
        ? part(
          steps,
          "path" in unit.place ? unit.place.path : unit.place.below,
          rows,
        )
        : rows;
    };
    documents.set(
      this.id,
      withUnits(this.store.docs.get(this.id)?.value, this.#rootUnits),
    );
    return documents;
  }

  /**
   * Reports the record of the output at or above `at` of the result
   * document as that of a write that left the value as it was
   * (`TransactionHooks.unchanged`), its label alone to be formed again: an
   * evaluation that gives the value the path holds read what its inputs
   * hold now, which can be other positions than the ones the stored label
   * was formed from. An output whose template reads nothing has one label
   * whatever was read, and is not reported; nor is a record given earlier
   * in the transaction. `known` is the output nearest at or above `at`,
   * where the caller found it.
   */
  #unchangedOutput(at: readonly string[], known?: RecordedOutput): void {
    const { root } = this;
    const hooks = root.options.transactions;
    if (root.#tx === undefined || hooks?.unchanged === undefined) return;
    let nearest: { output: number; path: readonly string[] } | undefined =
      known;
    if (nearest === undefined) {
      for (const entry of this.#recordedOutputs()) {
        if (
          entry.path.length <= at.length && matchesPath(entry.path, at) &&
          (nearest === undefined || entry.path.length > nearest.path.length)
        ) nearest = entry;
      }
    }
    if (nearest === undefined) return;
    const template = this.plan.outputs[nearest.output].template;
    if (template === undefined) return;
    const reached = reachedBy(template, this.plan.templates ?? []);
    if (
      reached.slots.size === 0 && reached.outputs.size === 0 &&
      reached.folds.size === 0 && reached.dynamic.size === 0
    ) return;
    const path = at.slice(0, nearest.path.length);
    const key = this.#recordKey(nearest.output, path);
    if (root.#givenNow.has(key)) return;
    if (root.#placing) {
      if (root.#checkedNow.has(key)) return;
      root.#checkedNow.add(key);
    }
    if (!root.#placing) root.#namedIndex.clear();
    const write = this.#outputRecord(this.id, nearest.output, [...path]);
    // The record last given for the place had these inputs, and no label
    // one of them read changed since: the place holds the label the record
    // would form.
    if (
      !root.#relabels.has(key) &&
      root.#recordDigests.get(key) ===
        root.#digests.of(root.#inputsTable, write.inputs, write.keys)
    ) {
      root.#ownReads.delete(key);
      return;
    }
    root.#noteRecord(key, this.id, write);
    hooks.unchanged(
      this.id,
      path,
      this.store,
      undefined,
      [{ ...write, relabel: true }],
      root.#inputsTable,
    );
  }

  /**
   * Stores a value at a place of the result document, and writes only
   * what differs from what the place holds: a member of a record and a
   * position of an array of the same length are compared by themselves.
   * `previous` is the value placed at the place before, where the place
   * holds its form: a record or an array of `value` that is the one
   * `previous` held at its position is not formed or compared again, and
   * the records of the outputs it holds are given as those of places a
   * comparison left as they were (`#sameRecords`).
   */
  #place(
    path: readonly string[],
    value: unknown,
    owner: { unit: Unit; key: string } | undefined,
    below: readonly string[],
    previous?: unknown,
  ): void {
    const seen = new Set<string>();
    // The paths below the holder of the members that are the ones placed
    // before.
    const sames: (readonly string[])[] = [];
    const form = previous !== undefined && value === previous &&
        (Array.isArray(value) || isRecord(value))
      ? (sames.push(below), SAME)
      : this.#formOf(
        value,
        owner,
        below,
        seen,
        previous === undefined
          ? undefined
          : { was: previous, same: (at) => sames.push(at) },
      );
    const within = (outer: readonly string[], at: readonly string[]) =>
      outer.length <= at.length &&
      outer.every((segment, index) => segment === at[index]);
    // The units that stood at or below the place and stand there no
    // more. A unit below a member that is the one placed before stands
    // where it stood.
    const inside = owner === undefined
      ? this.#rootUnits
      : owner.unit.inside.get(owner.key);
    for (const [id, unit] of [...inside ?? []]) {
      if (seen.has(id)) continue;
      const at = "path" in unit.place ? unit.place.path : unit.place.below;
      if (!within(below, at)) continue;
      if (sames.some((same) => within(same, at))) {
        this.#dueUnits.add(unit);
        continue;
      }
      this.#dispose(unit);
      inside?.delete(id);
    }
    const { store, id: doc, root } = this;
    const bucketPaths = this.#bucketRecordPaths();
    // The form is whole: from here to the end of the comparison nothing is
    // evaluated, and each write forgets the inputs formed before it
    // (`#writesOf`), so the records of the places that are left as they
    // are name the inputs of a cone instance that were formed once.
    const outermost = !root.#placing;
    if (outermost) {
      root.#namedIndex.clear();
      root.#checkedNow.clear();
      root.#placing = true;
    }
    // What a place holds, where the form has `KEPT` or `SAME` at or below
    // it.
    const filled = (form: unknown, held: unknown): unknown => {
      if (form === KEPT || form === SAME) return held;
      if (Array.isArray(form)) {
        return form.map((member, index) =>
          filled(member, Array.isArray(held) ? held[index] : undefined)
        );
      }
      if (isRecord(form)) {
        const members: Record<string, unknown> = {};
        for (const [name, member] of Object.entries(form)) {
          members[name] = filled(
            member,
            isRecord(held) ? held[name] : undefined,
          );
        }
        return members;
      }
      return form;
    };
    const put = (at: readonly string[], form: unknown, held: unknown) => {
      if (form === KEPT) return;
      if (form === SAME) {
        this.#sameRecords(
          at,
          held,
          (position) => this.#unitAt(owner, path, below, position),
        );
        return;
      }
      root.counts.positionsPlaced += 1;
      if (
        Array.isArray(form) && Array.isArray(held) &&
        form.length === held.length && form.length > 0 &&
        !shiftedScalars(form, held) && !differsThroughout(form, held)
      ) {
        form.forEach((member, index) =>
          put([...at, `${index}`], member, held[index])
        );
        return;
      }
      if (
        isRecord(form) && isRecord(held) && !isLink(form) && !isLink(held) &&
        !isStream(form) && !isStream(held)
      ) {
        // The store holds the members of a record in the order of the
        // storage, whatever order the form has them in.
        const [names, were] = [Object.keys(form), Object.keys(held)];
        if (
          names.length > 0 && names.length === were.length &&
          names.every((name) => Object.hasOwn(held, name))
        ) {
          for (const name of names) put([...at, name], form[name], held[name]);
          return;
        }
        // The record of the buckets of an index whose buckets are
        // documents of their own: a bucket that emptied is removed, and
        // each other is compared by itself, so the record is written for
        // none of them.
        if (
          owner === undefined && bucketPaths.size > 0 &&
          bucketPaths.has(JSON.stringify(at))
        ) {
          for (const name of were) {
            if (!Object.hasOwn(form, name)) {
              store.put(doc, [...at, name], undefined);
            }
          }
          for (const name of names) put([...at, name], form[name], held[name]);
          return;
        }
      }
      const now = filled(form, held);
      if (sameStored(held, now)) {
        // A reference that stays names the cell it named.
        if (!isLink(now) && !isStream(now)) this.#unchangedOutput(at);
        return;
      }
      const [was, size] = [bytesOf(held), bytesOf(now)];
      store.put(doc, at, now);
      if (owner === undefined) {
        this.#rootSize += size - was;
        this.#wroteLaid({}, size);
      } else {
        this.#growRow(owner.unit, owner.key, size - was);
        this.#wroteLaid(this.#laidOfRow(owner.unit, owner.key), size);
        if (at.length === path.length) {
          owner.unit.splits[this.#positionIn(owner.unit, owner.key)] = splits(
            now,
          );
          owner.unit.swept = false;
        }
      }
    };
    try {
      put(path, form, store.peek(doc, path));
    } finally {
      if (outermost) root.#placing = false;
    }
  }

  /**
   * On the root: a place of a result document is being compared with its
   * form (`#place`), and the inputs formed for the records of the places
   * left as they are, are kept from one such record to the next.
   */
  #placing = false;

  /**
   * On the root: the keys of the records of places left as they were
   * that the comparison in progress (`#placing`) asked about already.
   * Nothing is evaluated while a place is compared, so the inputs of a
   * record are the same at each position it covers.
   */
  readonly #checkedNow = new Set<string>();

  /**
   * Whether a unit, or an index whose buckets are stored by themselves,
   * stores its rows at the path `position` of the result document, where
   * `#place` stores at `path` a value whose place is `below` in the holder
   * `owner`. Its rows are brought up to date by themselves.
   */
  #unitAt(
    owner: { unit: Unit; key: string } | undefined,
    path: readonly string[],
    below: readonly string[],
    position: readonly string[],
  ): boolean {
    if (owner === undefined) {
      const id = JSON.stringify(position);
      return this.#rootUnits.has(id) || this.#indexUnits.has(id);
    }
    if (position.length < path.length) return false;
    const relative = [...below, ...position.slice(path.length)];
    return owner.unit.inside.get(owner.key)?.has(JSON.stringify(relative)) ===
      true;
  }

  /**
   * The records of the places below `at` of the result document, where
   * `#place` found the value the one it placed there before: the record
   * of the output nearest at or above `at`, and that of each kept output
   * below it that holds a value, each given as that of a place a
   * comparison left as it was (`#unchangedOutput`), which forms its label
   * again where its inputs are other ones. These are the records that a
   * comparison of each position would give. `held` is what the place
   * holds, and `kept` says which positions store the rows of a unit,
   * which bring them up to date by themselves.
   */
  #sameRecords(
    at: readonly string[],
    held: unknown,
    kept: (position: readonly string[]) => boolean,
  ): void {
    this.#unchangedOutput(at);
    const visit = (
      node: RecordedTrie,
      position: string[],
      value: unknown,
      top: boolean,
    ): void => {
      if (value === undefined || kept(position)) return;
      if (
        !top && node.here !== undefined && !isLink(value) && !isStream(value)
      ) {
        this.#unchangedOutput(position, node.here);
      }
      for (const [segment, child] of node.children) {
        if (segment === "*") {
          if (!Array.isArray(value)) continue;
          value.forEach((member, index) =>
            visit(child, [...position, `${index}`], member, false)
          );
        } else {
          visit(
            child,
            [...position, segment],
            typeof value === "object" && value !== null && !isLink(value)
              ? (value as Record<string, unknown>)[segment]
              : undefined,
            false,
          );
        }
      }
    };
    for (const node of this.#trieAt(at)) visit(node, [...at], held, true);
  }

  /**
   * The nodes of the tree of the outputs a change of the result document
   * is recorded for (`#recordedTrie`) that the path `at` reaches, a `*`
   * of an output's path reaching any segment.
   */
  #trieAt(at: readonly string[]): RecordedTrie[] {
    let nodes = [this.#recordedTrie()];
    for (const segment of at) {
      const next: RecordedTrie[] = [];
      for (const node of nodes) {
        const exact = node.children.get(segment);
        if (exact !== undefined) next.push(exact);
        const any = segment === "*" ? undefined : node.children.get("*");
        if (any !== undefined) next.push(any);
      }
      nodes = next;
      if (nodes.length === 0) break;
    }
    return nodes;
  }

  /**
   * The outputs a change of the result document is recorded for
   * (`#recordedOutputs`), as a tree of the segments of their paths: each
   * node holds the output nearest at its path, as `#unchangedOutput`
   * finds it there.
   */
  #recordedTrie(): RecordedTrie {
    if (this.#trie !== undefined) return this.#trie;
    const root: RecordedTrie = { children: new Map() };
    for (const entry of this.#recordedOutputs()) {
      let node = root;
      for (const segment of entry.path) {
        let child = node.children.get(segment);
        if (child === undefined) {
          child = { children: new Map() };
          node.children.set(segment, child);
        }
        node = child;
      }
      node.here ??= entry;
    }
    this.#trie = root;
    return root;
  }

  /** The result of `#recordedTrie()`, made once. */
  #trie: RecordedTrie | undefined;

  /**
   * Brings the stored rows of a unit up to date with its assembly
   * (`execution-and-storage.md` §4.2, "A kept collection is stored as
   * an array at its path"): a row whose value is another one is stored
   * again, and the rows that left or entered are a splice of the stored
   * array.
   */
  #storeUnit(unit: Unit): void {
    const entry = this.assembled(unit.collection, this.#leftStored(unit))(
      this.freshContext(unit.context),
    );
    if (entry === unit.seen) return;
    if (entry.scoped !== undefined) {
      // An assembly found to be of a scope key after its rows were stored
      // for every reader: the place holds what `#formOf()` gives a
      // reference to such an assembly from the first, and the unit goes.
      const { place } = unit;
      const reference = new Assembled(unit.collection, unit.context, unit.name);
      if ("path" in place) {
        this.#place(place.path, reference, undefined, [...place.path]);
      } else {
        this.#place(this.#pathOf(unit), reference, place, place.below);
      }
      return;
    }
    if (
      unit.seen !== undefined && entry.version === unit.seen.version &&
      entry.value === unit.seen.value && entry.members === unit.seen.members
    ) {
      // Brought up to date with no change of its members.
      unit.seen = entry;
      return;
    }
    const values = Array.isArray(entry.value) ? entry.value : [];
    const path = this.#pathOf(unit);
    const { delta } = entry;
    if (
      delta !== undefined && unit.seen !== undefined &&
      entry.version === (unit.seen.version ?? 0) + 1 &&
      entry.members !== undefined
    ) {
      // The assembly says what changed: the splices, and the rows that
      // hold another value.
      const { members } = entry;
      for (const { start, removed, inserted } of delta.ops) {
        // The same keys at the same positions: the rows hold another
        // value, and the array holds what it held.
        if (
          removed.length === inserted.length &&
          removed.every((key, offset) => key === inserted[offset])
        ) {
          inserted.forEach((key, offset) => {
            const index = start + offset;
            if (members[index]?.key !== key || unit.keys[index] !== key) return;
            const previous = unit.values[index];
            unit.values[index] = values[index];
            this.#place(
              [...path, `${index}`],
              values[index],
              {
                unit,
                key,
              },
              [],
              previous,
            );
          });
          continue;
        }
        // A key that a later splice removed again has no row now.
        this.#spliceRows(
          unit,
          path,
          start,
          removed,
          inserted,
          inserted.map((_, offset) => values[start + offset]),
          () =>
            inserted.map((key, offset) => {
              const index = start + offset;
              return members[index]?.key === key
                ? this.#formOf(values[index], { unit, key }, [], new Set())
                : null;
            }),
        );
      }
      const settled = unit.keys.length === members.length;
      for (const key of settled ? delta.rows : []) {
        const index = this.#positionIn(unit, key);
        if (index < 0 || members[index]?.key !== key) continue;
        const previous = unit.values[index];
        unit.values[index] = values[index];
        this.#place(
          [...path, `${index}`],
          values[index],
          { unit, key },
          [],
          previous,
        );
      }
      if (settled && delta.ops.length <= 1) {
        unit.seen = entry;
        return;
      }
    }
    const keys = (entry.members ?? []).map(({ key }) => key);
    const were = unit.keys.length;
    let head = 0;
    while (
      head < were && head < keys.length && unit.keys[head] === keys[head]
    ) {
      head += 1;
    }
    let tail = 0;
    while (
      tail < were - head && tail < keys.length - head &&
      unit.keys[were - 1 - tail] === keys[keys.length - 1 - tail]
    ) tail += 1;
    this.counts.elementsVisited += head + tail;
    const row = (index: number) => {
      const previous = unit.values[index];
      if (values[index] === previous) return;
      unit.values[index] = values[index];
      this.#place(
        [...path, `${index}`],
        values[index],
        { unit, key: keys[index] },
        [],
        previous,
      );
    };
    for (let index = 0; index < head; index++) row(index);
    const removed = unit.keys.slice(head, were - tail);
    const inserted = keys.slice(head, keys.length - tail);
    if (removed.length > 0 || inserted.length > 0) {
      this.#spliceRows(
        unit,
        path,
        head,
        removed,
        inserted,
        values.slice(head, keys.length - tail),
        () =>
          inserted.map((key, offset) =>
            this.#formOf(values[head + offset], { unit, key }, [], new Set())
          ),
      );
    }
    for (let index = keys.length - tail; index < keys.length; index++) {
      row(index);
    }
    unit.seen = entry;
  }

  /**
   * The store step of a derivation transaction for this instance
   * (`execution-and-storage.md` §1.6, "Seal"): the value of the result
   * where it is another one, and the rows of each collection that
   * stands in the result and may have changed. A document, and a path
   * of one, that holds what it held is not written.
   */
  #storeResult(entry: Entry): void {
    if (entry !== this.#storedResult) {
      const previous = this.#storedResult?.value;
      this.#storedResult = entry;
      this.#place([], entry.value, undefined, [], previous);
    }
    if (this.#alwaysCount > 0) {
      for (const units of this.#units.values()) {
        for (const unit of units) this.#dueUnits.add(unit);
      }
    }
    while (this.#dueUnits.size > 0) {
      const [unit] = this.#dueUnits;
      this.#dueUnits.delete(unit);
      if (this.#stands(unit)) this.#storeUnit(unit);
    }
    for (const unit of this.#indexUnits.values()) this.#storeIndex(unit);
    this.#arrange();
    this.#noteRows();
  }

  /**
   * The kept indexes whose buckets are stored by themselves, by the path
   * of the result each stands at, as text.
   */
  readonly #indexUnits = new Map<string, IndexUnit>();

  /**
   * The stored form of a reference to an index that stands at the path
   * `at` of the result. Where the buckets of the index are documents of
   * their own and the index stands at the path of its kept output, the
   * index is stored whole the first time, and afterwards the form is
   * `KEPT`: the buckets that changed are stored by themselves
   * (`#storeIndex`). Otherwise the form is the index whole.
   */
  #indexForm(handle: IndexHandle, at: string[], atRoot: boolean): unknown {
    const { collection, context } = indexPartsOf(handle);
    const record = atRoot ? this.bucketRecordOf(collection) : undefined;
    const entry = this.assembled(collection)(this.freshContext(context));
    const index = entry.value as Index;
    const whole = () =>
      this.stored(
        this.indexRecord(index, new Host(this, context, undefined), collection),
      );
    if (
      record === undefined ||
      JSON.stringify(at) !== JSON.stringify(record.slice(0, -1))
    ) return whole();
    const id = JSON.stringify(at);
    const known = this.#indexUnits.get(id);
    if (known !== undefined && known.collection === collection) return KEPT;
    this.#indexUnits.set(id, { collection, context, path: at, index });
    index.changed.clear();
    return whole();
  }

  /**
   * Brings the stored buckets of a kept index up to date with the index:
   * each bucket that changed since the index was last stored is compared
   * and written by itself, and one that emptied is removed. An index that
   * was formed again whole is stored whole, each bucket compared by itself.
   * Where a bucket changed, the record of the index is given again at the
   * path of the index: its label is that of the membership of the index,
   * which a read of any bucket consumes there.
   */
  #storeIndex(unit: IndexUnit): void {
    const { collection, context, path } = unit;
    const entry = this.assembled(collection)(this.freshContext(context));
    const index = entry.value as Index;
    const host = new Host(this, context, undefined);
    if (index !== unit.index) {
      unit.index = index;
      index.changed.clear();
      this.#place(path, this.indexRecord(index, host, collection), undefined, [
        ...path,
      ]);
      this.#unchangedOutput(path);
      return;
    }
    if (index.changed.size === 0) return;
    for (const encoded of index.changed) {
      const at = [...path, "buckets", encoded];
      const bucket = this.#bucketOf(index, encoded, host, collection);
      if (bucket === undefined) {
        if (this.store.peek(this.id, at) !== undefined) {
          this.store.put(this.id, at, undefined);
        }
      } else {
        this.#place(at, bucket, undefined, at);
      }
    }
    index.changed.clear();
    this.#unchangedOutput(path);
  }

  // ----- rows left as stored at a resume -----

  /**
   * On the instance the executor was started with, where a store outside
   * it keeps the units: the collections whose rows a resumed executor can
   * leave as stored, each with the path of the result that keeps it
   * (`storedRowCollections`).
   */
  #listed: ReadonlyMap<number, readonly string[] | undefined> | undefined;

  /**
   * For a resumed instance, the arrays of links to whole documents that
   * the stored result holds at a path the plan does not name, by the text
   * of the path, until a unit of a collection of `#listed` is placed there
   * (`#claimStored`).
   */
  readonly #storedArrays = new Map<
    string,
    { path: readonly string[]; entities: readonly string[] }
  >();

  /**
   * For a resumed instance, the collections whose rows the storage holds
   * and whose assembly has not been evaluated: the path of the result that
   * keeps each, and the entity that each position of the stored array
   * links to.
   */
  readonly #storedRows = new Map<
    number,
    { path: readonly string[]; entities: readonly string[] }
  >();

  /**
   * The assemblies that hold `STORED_ROW` for a row, by name: the name
   * that the dependencies of the rows not evaluated are on, and the
   * positions that the links of the source array name, by document, each
   * with the key of its element.
   */
  readonly #seeds = new Map<
    string,
    {
      collection: number;
      /** The path of the result at which the rows are left as stored. */
      path: readonly string[];
      on: string;
      targets: Map<string, { path: readonly string[]; key: string }[]>;
      /**
       * For a collection whose source is no slot (`#storedIn`): the keys
       * whose rows no evaluation of this executor formed, and how many
       * dependencies of the assembly stand before those of the elements.
       */
      stored?: Set<string>;
      first?: number;
    }
  >();

  /**
   * Whether the result document was created with what the storage holds
   * (`#heldResult`), and not empty.
   */
  #resultHeld = false;

  /**
   * Whether a unit stores the rows of its collection where the executor
   * left them as stored: at the path of the result that keeps the
   * collection. A unit that stands anywhere else holds a row of its own
   * for each element.
   */
  #leftStored(unit: Unit): boolean {
    if (!("path" in unit.place)) return false;
    // Before the assembly is first evaluated, the path is the one the
    // stored rows were found at.
    const path = this.#seeds.get(unit.name)?.path ??
      (unit.name === this.#name("assembly", unit.collection, [])
        ? this.#storedRows.get(unit.collection)?.path
        : undefined);
    return path !== undefined && unit.place.path.length === path.length &&
      unit.place.path.every((segment, index) => segment === path[index]);
  }

  /**
   * A unit is being made at a place of the result document itself. Where
   * the stored result holds an array of links to whole documents there,
   * and the collection of the unit is one of `#listed` that the plan keeps
   * at no path, whose assembly has not been evaluated, the array is taken
   * as the stored rows of the collection: its assembly is then formed with
   * no body evaluated (`#seed`), where the links are those of the row
   * documents of its keys.
   */
  #claimStored(unit: Unit): void {
    if (this.#storedArrays.size === 0 || !("path" in unit.place)) return;
    const id = JSON.stringify(unit.place.path);
    const found = this.#storedArrays.get(id);
    if (found === undefined) return;
    this.#storedArrays.delete(id);
    const { collection, name } = unit;
    if (
      this.#listed?.has(collection) !== true ||
      this.#listed.get(collection) !== undefined ||
      name !== this.#name("assembly", collection, []) ||
      this.#memo.has(name) || this.#storedRows.has(collection) ||
      this.options.units?.listed(collection) !== true
    ) return;
    this.#storedRows.set(collection, found);
  }

  /**
   * A unit was made at a place of the result document itself. Where the
   * document was created with what the storage holds and the rows of the
   * unit are not left as stored, the place is emptied, with nothing told of
   * it as a change: what the storage holds there is the links of an array
   * of row documents, which the comparison of the place with its rows
   * would take for rows in place. The array is then stored whole.
   */
  #unitPlaced(unit: Unit): void {
    if (!this.#resultHeld || !("path" in unit.place)) return;
    if (this.#leftStored(unit)) return;
    this.store.adopt(this.id, unit.place.path, undefined);
  }

  /** The documents whose stored readers `#hydrate` has registered. */
  readonly #hydrated = new Set<string>();

  /**
   * What the result document of a resumed instance holds when it is
   * created: nothing, or, where a store outside the executor gives the
   * units (`Instance.options.units`), what the storage holds, with nothing
   * at the path of each array of row documents and of each record of
   * bucket documents. The assembly of a collection of `#storedRows` puts
   * the links of its rows there (`#seed`); every other such place is
   * stored again whole by the first derivation.
   */
  #heldResult(): unknown {
    const { units, resume, rowDocuments, bucketDocuments } = this.options;
    if (
      this.#listed === undefined || units?.stale === undefined ||
      resume !== true
    ) return undefined;
    // Nothing is read of the stored result where no collection can have
    // its rows left as stored: the result document is then derived whole.
    if (![...this.#listed.keys()].some((one) => units.listed(one))) {
      return undefined;
    }
    const paths: (readonly string[])[] = [];
    const of: (number | undefined)[] = [];
    for (const collection of rowDocuments ?? []) {
      const place = this.plan.outputs.find((output) =>
        output.collection === collection
      );
      if (place === undefined || place.path.includes("*")) continue;
      paths.push(place.path);
      of.push(collection);
    }
    for (const collection of bucketDocuments ?? []) {
      const record = this.bucketRecordOf(collection);
      if (record === undefined) continue;
      paths.push(record);
      of.push(undefined);
    }
    // A collection that the plan keeps at no path stands where the value
    // of the result holds it: every array of links to whole documents of
    // the stored result is then a place such a collection can stand at.
    const unplaced = [...this.#listed].some(([one, path]) =>
      path === undefined && units.listed(one)
    );
    const held = units.result(paths, unplaced);
    if (held === undefined) return undefined;
    of.forEach((collection, index) => {
      const entities = held.rows[index];
      if (
        collection === undefined || entities === undefined ||
        this.#listed?.get(collection) === undefined ||
        !units.listed(collection)
      ) return;
      this.#storedRows.set(collection, { path: paths[index], entities });
    });
    for (const found of held.found ?? []) {
      this.#storedArrays.set(JSON.stringify(found.path), found);
    }
    this.#resultHeld = true;
    return held.value;
  }

  /**
   * The assembled result of a collection of `#storedRows` with no body
   * evaluated, at the first evaluation of its assembly: the element table
   * from the links of the source array, and `STORED_ROW` for each row.
   * The key of an element is formed from the position its link names,
   * with no read of the document it names, and the table is taken only
   * where the row document of each key formed so is the one the stored
   * result links to at the same position. The body of an element is
   * evaluated here where a document that changed since the run before is
   * one the storage lists the element as a reader of. Gives nothing where
   * the rows are not left as stored, and the assembly is then formed
   * whole.
   */
  #seed(collection: number, name: string, host: Host): unknown[] | undefined {
    const held = this.#storedRows.get(collection);
    const units = this.options.units;
    if (held === undefined || units === undefined) return undefined;
    const { source, keyFields } = this.plan.collections[collection];
    // The table of a collection over an output or over another collection
    // is formed by an evaluation of what it is over (`#storedIn`).
    if (source.slot === undefined) return undefined;
    this.#storedRows.delete(collection);
    const slot = this.plan.slots[source.slot];
    host.demand(slot.root, slot.path);
    if (host.writers.length > 0) return undefined;
    const base = host.settled(host.at(this.rootOf(slot.root, host), slot.path));
    if (!(base instanceof Ref)) return undefined;
    const { store } = this;
    const reads: Position[] = [];
    const located = store.locate(base, true, reads);
    const array = located.value;
    if (
      !Array.isArray(array) || array.length !== held.entities.length ||
      !array.every(isLink)
    ) return undefined;
    const stale = new Set(units.stale ?? []);
    const parts: ElementPart[] = [];
    for (const { $link } of array) {
      const target = new Ref($link.doc, $link.path);
      const part = store.addressOf(target);
      // A document that changed can hold a link where it held none.
      if (
        stale.has($link.doc) &&
        textOf(
            store.addressOf(store.locate(target, true, undefined, true).named),
          ) !==
          textOf(part)
      ) return undefined;
      parts.push(part);
    }
    const keys = keysOfParts(parts);
    const rows = keys.map((key) => units.row(held.path, key));
    if (rows.some(({ entity }, index) => entity !== held.entities[index])) {
      return undefined;
    }
    const due = new Set<string>();
    for (const doc of stale) {
      for (const reader of units.readers(doc)) {
        if (reader.collection === collection) due.add(reader.key);
      }
    }
    for (const read of reads) host.reads.push(read);
    const fields = keyFields ?? keyFieldsOf(located.given);
    store.adoptKeys(array, located.ref, fields, parts, keys);
    const state = store.keyState(array, fields);
    if (state === undefined) return undefined;
    const targets = new Map<
      string,
      { path: readonly string[]; key: string }[]
    >();
    const elements = array.map(({ $link }, index): Element => {
      const at = targets.get($link.doc) ?? [];
      at.push({ path: $link.path, key: keys[index] });
      targets.set($link.doc, at);
      return {
        key: keys[index],
        index,
        source: new Ref($link.doc, $link.path),
      };
    });
    this.#setTable(name, collection, [], elements);
    this.#markUsers(tableName(name));
    const first = host.dependencies.length;
    const on = `stored ${name}`;
    const kept: Dependency = { stamp: () => Symbol(), seen: STORED_ROW, on };
    const keyOf = new Map<string, string>();
    const results = elements.map(({ key }) => {
      if (!due.has(key)) {
        host.dependencies.push(kept);
        return STORED_ROW;
      }
      const entry = host.dependEntry(this.#perElement(collection, key));
      if (entry.key !== undefined) keyOf.set(entry.key, key);
      return entry.value;
    });
    host.members = elements.map(({ key }, index) => ({
      key,
      index,
      source: { entry: this.#perElement(collection, key), at: [] },
    }));
    const arrayReads = new Set(reads);
    const elementReads = new Map<Position, string>();
    host.found = {
      base,
      named: located.named,
      held: array,
      fields,
      arrayReads,
      elementReads,
    };
    host.rows = {
      construct: "map",
      stored: {
        base,
        named: store.addressText(located.named),
        fields,
        formed: state.formed,
        seen: state.count,
      },
      arrayReads,
      elementReads,
      first,
      results,
      keyOf,
      members: host.members,
    };
    const value = [...results];
    assembledElements.set(value, {
      members: host.members,
      context: host.context,
    });
    // The result document holds the link to the document of each row, as
    // the storage does.
    store.adopt(
      this.id,
      held.path,
      rows.map(({ doc }) => ({ $link: { doc, path: [] } })),
    );
    units.held(held.path, keys);
    const bindings = boundInElement(this.artifact, collection);
    if (bindings.length > 0) units.bound(bindings, keys);
    this.counts.rowsLeftStored += keys.length - due.size;
    this.#seeds.set(name, { collection, path: held.path, on, targets });
    this.#watchPositions(collection, keys.filter((key) => !due.has(key)));
    return value;
  }

  /**
   * For the assembly `name` of a collection whose source is no slot, the
   * output of a `lift` or a `computed` or the result of a `filter` or a
   * `sortBy`, while it is being evaluated: the keys of `elements`, the
   * element table that the evaluation of the source gave, whose rows are
   * left as the storage holds them, each with the name of the entry of its
   * body where a reader of a document is registered under that name
   * (`#hydrate`). Gives nothing where every body is evaluated.
   *
   * At the first evaluation the rows are taken where every element is a
   * reference and the row document of each key is the one the stored result
   * links to at the same position, as `#seed` takes those of a collection
   * over a slot. At a later evaluation, which forms the assembly whole, a
   * row is left where no evaluation of this executor has formed it, nothing
   * marked its body, and it stands where the unit that stores the rows
   * holds it, before the first or behind the last position at which the
   * keys of the unit differ from those of the table: the store step then
   * writes nothing for it.
   */
  #storedIn(
    collection: number,
    name: string,
    elements: readonly Element[],
    host: Host,
  ): Map<string, string | undefined> | undefined {
    const units = this.options.units;
    if (units === undefined) return undefined;
    const seed = this.#seeds.get(name);
    const left = new Map<string, string | undefined>();
    if (seed === undefined) {
      const held = this.#storedRows.get(collection);
      if (held === undefined) return undefined;
      this.#storedRows.delete(collection);
      if (
        host.writers.length > 0 ||
        elements.length !== held.entities.length ||
        !elements.every(({ source }) => source instanceof Ref)
      ) return undefined;
      const keys = elements.map(({ key }) => key);
      const rows = keys.map((key) => units.row(held.path, key));
      if (rows.some(({ entity }, index) => entity !== held.entities[index])) {
        return undefined;
      }
      const due = new Set<string>();
      for (const doc of units.stale ?? []) {
        for (const reader of units.readers(doc)) {
          if (reader.collection === collection) due.add(reader.key);
        }
      }
      const stored = new Set(keys.filter((key) => !due.has(key)));
      for (const key of stored) left.set(key, undefined);
      // The result document holds the link to the document of each row, as
      // the storage does.
      this.store.adopt(
        this.id,
        held.path,
        rows.map(({ doc }) => ({ $link: { doc, path: [] } })),
      );
      units.held(held.path, keys);
      const bindings = boundInElement(this.artifact, collection);
      if (bindings.length > 0) units.bound(bindings, keys);
      this.counts.rowsLeftStored += stored.size;
      this.#seeds.set(name, {
        collection,
        path: held.path,
        on: `stored ${name}`,
        targets: new Map(),
        stored,
        first: host.dependencies.length,
      });
      this.#watchPositions(collection, [...stored]);
      return left;
    }
    if (seed.stored === undefined) return undefined;
    const unit = this.#rootUnits.get(JSON.stringify(seed.path));
    const before = unit?.name === name && host.writers.length === 0
      ? unit.keys
      : [];
    let head = 0;
    while (
      head < before.length && head < elements.length &&
      before[head] === elements[head].key
    ) head += 1;
    let tail = 0;
    while (
      tail < before.length - head && tail < elements.length - head &&
      before[before.length - 1 - tail] ===
        elements[elements.length - 1 - tail].key
    ) tail += 1;
    // A row that depends on the position of its element is left where the
    // position is the one the unit holds it at.
    const shifted = elements.length !== before.length &&
      units.positioned(collection);
    elements.forEach(({ key, source }, index) => {
      if (!seed.stored?.has(key) || !(source instanceof Ref)) return;
      if (index >= head && (shifted || index < elements.length - tail)) return;
      const body = this.#name("element", collection, [], key);
      if (this.#memo.has(body)) return;
      const slot = this.#slots.get(body);
      if (slot?.marked === true) return;
      left.set(key, slot === undefined ? undefined : body);
    });
    seed.stored = new Set(left.keys());
    seed.first = host.dependencies.length;
    return left;
  }

  /**
   * Where the rows of `collection` that the storage holds depend on the
   * position of their elements (`StoredUnits.positioned`): registers the
   * body of the element of each of `keys`, whose row is left as stored, as
   * a reader of the position of its element, so that a change of the
   * position evaluates the body (`#moved`).
   */
  #watchPositions(collection: number, keys: readonly string[]): void {
    if (this.options.units?.positioned(collection) !== true) return;
    for (const key of keys) {
      const under = this.#name("under", collection, [], key);
      const body = this.#name("element", collection, [], key);
      const readers = this.#indexReaders.get(under) ?? new Set();
      readers.add(body);
      this.#indexReaders.set(under, readers);
      this.#slot(body);
    }
  }

  /**
   * Has the assembly `name`, which holds `STORED_ROW` for a row, formed
   * whole by its next evaluation, with the body of every element
   * evaluated.
   */
  #unseed(name: string): void {
    if (!this.#seeds.delete(name)) return;
    this.#mark(this.#slot(name));
  }

  /**
   * Has the assembly of a collection whose rows are left as stored depend
   * on the entry `name` of the body of the element of `key`, where it
   * holds `STORED_ROW` for the row: a change of that entry then marks the
   * assembly, which evaluates the body and stores the row.
   */
  #adoptStored(collection: number, key: string, name: string): void {
    if (this.#seeds.size === 0) return;
    const assembly = this.#name("assembly", collection, []);
    // An evaluation of the assembly that is in progress takes the entry of
    // the body itself, at the position the element has now.
    if (this.#open.has(assembly)) return;
    const seed = this.#seeds.get(assembly);
    const entry = this.#memo.get(assembly);
    const element = this.#tables.get(assembly)?.byKey.get(key);
    // An assembly that keeps no rows to bring up to date is formed whole
    // by each evaluation, and its dependencies on the elements stand where
    // its last evaluation put them (`#storedIn`).
    const first = entry?.rows?.first ?? seed?.first;
    if (seed === undefined || entry === undefined || !element) return;
    if (first === undefined) return;
    const at = first + element.index;
    if (entry.dependencies[at]?.on !== seed.on) return;
    entry.dependencies[at] = {
      stamp: () => Symbol(),
      seen: STORED_ROW,
      on: name,
    };
    entry.rows?.keyOf.set(name, key);
    this.uses(assembly, name);
  }

  /**
   * Evaluates the body of each element of `context` that an `element`
   * step of `within` names and whose row an assembly holds as stored: a
   * handler that a body binds runs with the row of its element evaluated,
   * as a whole derivation would have left it.
   */
  #evaluateStoredRows(within: readonly Step[], context: Context): void {
    if (this.#seeds.size === 0) return;
    for (const { element: collection } of within) {
      if (collection === undefined) continue;
      const element = context.get(collection);
      const around = this.#keysIn(this.#outerOf(collection), context);
      const assembly = this.#name("assembly", collection, around);
      if (element === undefined || !this.#seeds.has(assembly)) continue;
      this.#perElement(collection, element.key)(context);
    }
  }

  /**
   * On the root, before the readers of a change of `doc` at `path` are
   * marked, while an assembly holds `STORED_ROW` for a row: registers the
   * elements that the storage lists as readers of the document, each at
   * the paths it read, so that the change marks them as it marks an entry
   * that was evaluated here. An assembly whose source array links to a
   * position at or below the change is formed whole where that position
   * names another one now.
   */
  #hydrate(doc: string, path: readonly string[]): void {
    const { store } = this;
    for (const [assembly, { targets }] of [...this.#seeds]) {
      for (const target of targets.get(doc) ?? []) {
        if (
          path.length > target.path.length ||
          !path.every((segment, index) => segment === target.path[index])
        ) continue;
        const at = new Ref(doc, target.path);
        const { named } = store.locate(at, true, undefined, true);
        if (store.addressText(named) !== store.addressText(at)) {
          this.#unseed(assembly);
          break;
        }
      }
    }
    if (this.#hydrated.has(doc) || this.#seeds.size === 0) return;
    this.#hydrated.add(doc);
    for (const reader of this.options.units?.readers(doc) ?? []) {
      const assembly = this.#name("assembly", reader.collection, []);
      if (!this.#seeds.has(assembly)) continue;
      if (!this.#tables.get(assembly)?.byKey.has(reader.key)) continue;
      const name = this.#name("element", reader.collection, [], reader.key);
      if (this.#memo.has(name)) continue;
      this.#adoptStored(reader.collection, reader.key, name);
      const slot = this.#slot(name);
      for (const read of reader.paths) this.#watch(slot, { doc, path: read });
      for (const read of reader.own) {
        this.#watch(slot, { doc, path: read, own: true });
      }
    }
  }

  /**
   * On the root, for a change of the documents `docs` that is no write to
   * a document the store holds, as a change of their labels or a change of
   * a document that this executor has not read: marks the body of each
   * element that the storage lists as a reader of one of them and whose
   * row an assembly holds as stored. The executor holds no entry and no
   * record of such a row, so the body is evaluated, and the row is stored
   * and given its record as a row evaluated here is. Returns whether it
   * marked one.
   */
  #evaluateStoredReaders(docs: readonly string[]): boolean {
    if (this.#seeds.size === 0) return false;
    let marked = false;
    for (const doc of docs) {
      for (const reader of this.options.units?.readers(doc) ?? []) {
        const assembly = this.#name("assembly", reader.collection, []);
        if (!this.#seeds.has(assembly)) continue;
        if (!this.#tables.get(assembly)?.byKey.has(reader.key)) continue;
        const name = this.#name("element", reader.collection, [], reader.key);
        if (this.#memo.has(name)) continue;
        this.#adoptStored(reader.collection, reader.key, name);
        this.#mark(this.#slot(name));
        marked = true;
      }
    }
    return marked;
  }

  /**
   * Another writer changed the documents `docs`, which the store of this
   * executor does not hold. Marks the body of each element whose row is
   * left as stored and which the storage lists as a reader of one of them
   * (`StoredUnits.readers`), and returns whether there was one: whoever
   * runs the executor then calls `settle()`.
   */
  changedUnread(docs: readonly string[]): boolean {
    return this.root.#evaluateStoredReaders(docs);
  }

  /**
   * The elements of the collections of `#listed` under whose key an entry
   * was evaluated since the store step last told the store that keeps the
   * units what their rows read, by the name of the entry of the body.
   */
  readonly #rowsDue = new Map<string, { collection: number; key: string }>();

  /**
   * An entry `name` that is kept under the key of an element of a
   * collection of `#listed` was evaluated under `context`. The store that
   * keeps the units is told what the row read once the store step ran
   * (`#noteRows`). Where the row is left as stored and the entry is no
   * part of an evaluation of its body, the body is marked: the row is
   * evaluated, so that the lists hold what the entry read now.
   */
  #underListed(collection: number, context: Context, name: string): void {
    const element = context.get(collection);
    if (element === undefined) return;
    const body = this.#name("element", collection, [], element.key);
    this.#rowsDue.set(body, { collection, key: element.key });
    if (name === body || this.#memo.has(body) || this.#open.has(body)) return;
    if (!this.#seeds.has(this.#name("assembly", collection, []))) return;
    this.#adoptStored(collection, element.key, body);
    this.#mark(this.#slot(body));
  }

  /**
   * Tells the store that keeps the units what the row of each element of
   * `#rowsDue` read: the body, and each entry that is kept under the key
   * of the element, as a cone of the body with an instance of its own, the
   * assembly of a collection inside the body and the bodies of its
   * elements. The stored row holds what those entries gave, whether the
   * body used them or returned a reference to them. The row is plain where
   * none of them used something that is kept elsewhere
   * (`ElementReads.plain`).
   */
  #noteRows(): void {
    const units = this.options.units;
    for (const [body, { collection, key }] of this.#rowsDue) {
      if (!this.#memo.has(body) || units === undefined) continue;
      const under = this.#underKey.get(
        this.#name("under", collection, [], key),
      ) ?? new Set([body]);
      let plain = true;
      let position = false;
      const reads: ElementReads["reads"] = [];
      for (const name of under) {
        const one = this.#memo.get(name);
        if (one === undefined) continue;
        if (one.writers.length > 0 || one.always === true) plain = false;
        for (const indexed of one.indexes.keys()) {
          if (indexed === collection) position = true;
          else if (!this.#outerOf(indexed).includes(collection)) plain = false;
        }
        for (const { doc, path, own, keyed } of one.reads) {
          if (keyed !== undefined) plain = false;
          reads.push({ doc, path, own: own === true });
        }
        for (const { on } of one.dependencies) {
          // The element table of a collection inside the body is formed
          // by its assembly.
          const used = on?.startsWith(TABLE_PREFIX)
            ? on.slice(TABLE_PREFIX.length)
            : on;
          if (used === undefined || !under.has(used)) plain = false;
        }
      }
      units.read({ collection, key, plain, position, reads });
    }
    this.#rowsDue.clear();
  }

  /** The entry of a computation that has not been evaluated. */
  #none(key?: string): Entry {
    return {
      ...(key === undefined ? {} : { key, owner: this }),
      value: undefined,
      stored: "undefined",
      reads: [],
      dependencies: [],
      indexes: new Map(),
      writers: [],
      evaluatedAt: this.store.clock,
      changedAt: this.store.clock,
    };
  }

  /**
   * The name of a document of this instance in the scope the plan declares
   * for it, where the executor was told which scope key it evaluates for:
   * the name of its instances for every key (`scopedDocument`).
   */
  #inScope(id: string, scope: string | undefined): string {
    if (this.store.scopes === undefined) return id;
    return scope === "user" || scope === "session"
      ? scopedDocument(id, scope)
      : id;
  }

  /**
   * The names of the entries whose value is a reference to documents
   * their evaluation made, the same for every scope key.
   */
  readonly #references = new Set<string>();

  /**
   * Like `#ensure()`, except that what uses the entry is of no scope key
   * on its account: its value is a reference to documents its evaluation
   * made, which is the same for every scope key.
   */
  #ensureReference(
    key: string,
    context: Context,
    cone: number | undefined,
    kind: "element" | "assembly" | "value",
    compute: (host: Host) => unknown,
    within: readonly number[] = [],
  ): Entry {
    this.#references.add(key);
    return this.#ensure(key, context, cone, kind, compute, within);
  }

  /**
   * What brings each entry of a scope key up to date for the key that is
   * evaluated for, by the name of the entry (`#pullScoped`).
   */
  readonly #scopedPulls = new Map<string, () => void>();
  /**
   * The names of `#scopedPulls` whose entry of a scope key may not be
   * current, by that key: a change marked the slot of the entry
   * (`#pullDue`), or the pull was registered after the key was first
   * evaluated for.
   */
  readonly #pullsDue = new Map<string, Set<string>>();
  /** The scope keys that `#pullScoped` was run for. */
  readonly #pullsSeen = new Set<string>();
  /**
   * The names of `#scopedPulls` that have an entry compared on every pull
   * (`Slot.always`): nothing marks it when what it depends on changes, so
   * it is pulled for every key at every pass.
   */
  readonly #alwaysPulls = new Set<string>();
  /**
   * The stored text and the time of the last change of each entry whose
   * value is a reference to documents its evaluation made
   * (`#references`), whichever scope key it was last evaluated for: the
   * reference is the same for every key, so an entry evaluated for a key
   * for the first time is no change of it where it holds the same.
   */
  readonly #referenceStamps = new Map<
    string,
    { stored: string; changedAt: number }
  >();

  /** The pulls due for the scope key `scoped` (`#pullsDue`). */
  #dueFor(scoped: string): Set<string> {
    let due = this.#pullsDue.get(scoped);
    if (due === undefined) {
      due = new Set();
      this.#pullsDue.set(scoped, due);
    }
    return due;
  }

  /**
   * Notes that the entry of a slot that was marked may not be current for
   * its scope key, where the entry is one `#pullScoped` brings up to date:
   * for the key of the slot, and for every key where the slot is of none.
   */
  #pullDue(slot: Slot): void {
    if (!this.#scopedPulls.has(slot.key)) return;
    if (slot.scoped !== undefined) {
      this.#dueFor(slot.scoped).add(slot.key);
      return;
    }
    for (const scoped of this.#pullsSeen) this.#dueFor(scoped).add(slot.key);
  }

  /**
   * The scope key of the evaluation of the entry `key` in progress: the
   * narrowest scope it touched so far, or that the name was found to have
   * before, for the key evaluated for.
   */
  #scopedNow(key: string): string | undefined {
    const { scopes } = this.store;
    if (scopes === undefined) return undefined;
    const touched = scopes.touched;
    const known = scopes.narrowed(`${this.id}\n${key}`);
    const narrow = touched === undefined || (known !== undefined &&
        !narrowerThan(touched, known))
      ? known
      : touched;
    return narrow === undefined ? undefined : scopes.keyOf(narrow);
  }

  /**
   * The kinds of the documents that hold what one evaluation derived, and
   * that are the space's unless they are named for a scope.
   */
  static readonly #DERIVED = new Set([
    OUTPUT,
    "operation state",
    "argument",
    "held constant",
    "element record",
    "wish target",
  ]);

  /**
   * The memo entry of a computation for the scope key that is evaluated
   * for (`#ensureOne`). Without scope keys every entry is one for every
   * reader.
   *
   * An entry whose evaluation touched a scope instance, or used an entry
   * of a scope key, is of that key. The entry another key was given is
   * set aside before the evaluation, with its slot, which stays
   * registered, so a change marks it while it is set aside; it is brought
   * back when its key is evaluated for again, and is then current where
   * nothing marked it. The assembly of a collection is not set aside: its
   * element table stands beside the entry, so it is formed again. An entry
   * that was one for every key and is now of one counts as changed, so
   * that what used it is evaluated again and is of a key as well.
   */
  #ensure(
    key: string,
    context: Context,
    cone: number | undefined,
    kind: "element" | "assembly" | "value",
    compute: (host: Host) => unknown,
    within: readonly number[] = [],
    refresh?: (held: Entry, slot: Slot) => Entry | undefined,
  ): Entry {
    const { scopes } = this.store;
    if (scopes === undefined) {
      return this.#ensureOne(
        key,
        context,
        cone,
        kind,
        compute,
        within,
        refresh,
      );
    }
    const reference = this.#references.has(key);
    if (this.#open.has(key) || this.#checking.has(key)) {
      // A pull that reaches an evaluation or a check in progress.
      const entry = this.#ensureOne(key, context, cone, kind, compute, within);
      if (entry.scoped !== undefined && !reference) {
        scopes.touch(scopeOfKey(entry.scoped));
      }
      return entry;
    }
    const name = `${this.id}\n${key}`;
    this.#forActing(key, name);
    const before = this.#memo.get(key);
    const { value: entry, scope } = scopes.framed(() =>
      this.#ensureOne(key, context, cone, kind, compute, within, refresh)
    );
    const known = scopes.narrowed(name);
    const found = scope ??
      (entry.scoped === undefined ? known : scopeOfKey(entry.scoped));
    if (found === undefined) return entry;
    // The scope of an entry only narrows.
    scopes.narrow(name, found);
    const narrow = scopes.narrowed(name)!;
    const scoped = scopes.keyOf(narrow);
    if (entry.scoped !== scoped) {
      if (entry !== before) this.#refuseStoredForEveryKey(entry, name, narrow);
      entry.scoped = scoped;
      if (before !== undefined && before.scoped !== scoped) {
        this.store.clock += 1;
        entry.changedAt = this.store.clock;
        this.#markUsers(key);
      }
    }
    const slot = this.#slots.get(key);
    if (slot !== undefined) slot.scoped = scoped;
    if (context.size === 0 || reference) {
      if (!this.#scopedPulls.has(key)) {
        // A key evaluated for before the entry existed has none of it.
        const acting = new Set([scopes.keyOf("user"), scopes.keyOf("session")]);
        for (const seen of this.#pullsSeen) {
          if (!acting.has(seen)) this.#dueFor(seen).add(key);
        }
        if (slot?.always === true) this.#alwaysPulls.add(key);
      }
      this.#scopedPulls.set(key, () => {
        this.#ensure(
          key,
          this.freshContext(context),
          cone,
          kind,
          compute,
          within,
          refresh,
        );
      });
    }
    if (!reference) scopes.touch(narrow);
    return entry;
  }

  /**
   * Helper for `#ensure()`, which has the memo hold the entry of `key`
   * for the scope key that is evaluated for: an entry of another key is
   * set aside, and the one set aside for this key is brought back.
   */
  #forActing(key: string, name: string): void {
    const scopes = this.store.scopes!;
    const held = this.#memo.get(key);
    if (held?.scoped !== undefined && !scopes.acting(held.scoped)) {
      const slot = this.#slots.get(key);
      if (
        held.members === undefined && held.rows === undefined &&
        !this.#tables.has(key)
      ) {
        scopes.setAside(name, held);
        if (slot !== undefined) this.#toAside(slot, held);
      } else if (slot !== undefined) {
        // An assembly is formed again for each key. What used the entry of
        // the other key, set aside or not, is marked for that key: no mark
        // can reach it through the assembly of its key, which is gone, and
        // the assembly that key's next run forms differs from what it used.
        this.#unregister(slot);
        slot.marked = false;
        slot.all = false;
        slot.suspects.clear();
        slot.reads.clear();
        slot.scoped = undefined;
        this.#markScopedUsers(key, held.scoped);
      }
      this.#memo.delete(key);
    }
    if (this.#memo.has(key) || scopes.narrowed(name) === undefined) return;
    const back = scopes.takeBack<Entry>(name);
    if (back === undefined) return;
    this.#memo.set(key, back);
    const aside = this.#asideSlots.get(key)?.get(back.scoped!);
    if (aside !== undefined) {
      // The slot stayed registered while the entry was set aside: what
      // changed since marked it.
      this.#fromAside(aside);
      return;
    }
    const slot = this.#slot(key);
    if (!this.#register(slot, back)) this.#setAlways(slot);
    slot.scoped = back.scoped;
    // No change marked the entry while it was set aside: everything it
    // read and used is compared.
    back.checkedAt = undefined;
    slot.marked = true;
    slot.all = true;
    slot.serial += 1;
  }

  /**
   * Helper for `#ensure()`, which refuses an evaluation that was found to
   * be of a scope key and wrote what it derived into a document of the
   * space: the writes are withdrawn and the entry takes an error state. A
   * write to a cell lands in the scope of the cell and is no such write.
   */
  #refuseStoredForEveryKey(entry: Entry, name: string, scope: Scope): void {
    const open = this.root.#tx;
    const kinds = new Set<string>();
    for (const { doc } of open?.writes.get(name)?.at ?? []) {
      if (scopeOfDocument(doc).scope !== undefined) continue;
      const kind = this.store.docs.get(doc)?.kind;
      if (kind !== undefined && Instance.#DERIVED.has(kind)) kinds.add(kind);
    }
    if (open === undefined || kinds.size === 0) return;
    this.root.#withdraw(open, name);
    const message = `a computation of the scope \`${scope}\` stored what it ` +
      `derived in a document of the space (${[...kinds].join(", ")})`;
    entry.value = errorState(message);
    entry.stored = canonical(entry.value);
    entry.error = message;
    this.counts.failures += 1;
    this.root.failed.push({ cone: name.slice(this.id.length + 1), message });
  }

  /**
   * The scope the entry of the value of the output `output` was found to
   * have, under the element keys `keys`: the scope of the document that
   * holds what the output returned whole.
   */
  #scopeOfOutput(output: number, keys: readonly string[]): Scope | undefined {
    const value = this.valueOfOutput.get(output);
    if (value === undefined || this.store.scopes === undefined) {
      return undefined;
    }
    return this.store.scopes.narrowed(
      `${this.id}\n${this.#name("value", value, keys)}`,
    );
  }

  /**
   * Brings the entries that were found to be of a scope key up to date
   * for the key that is evaluated for: nothing else demands the entry of
   * a key where what holds it by reference is current. For a key evaluated
   * for before, those are the entries a change marked since, for that key
   * or for the space (`#pullsDue`), and those compared on every pull; for
   * a key not evaluated for before, every one. So a derivation for one key
   * visits the places whose inputs changed for that key, and not every
   * row's place of every key.
   */
  #pullScoped(): void {
    const { scopes } = this.store;
    if (scopes === undefined) return;
    const keys = [scopes.keyOf("user"), scopes.keyOf("session")];
    // A key not evaluated for before has no entry of any pull; a key
    // evaluated for before has those whose entry a change may have left
    // not current, and those compared on every pull.
    let pulls: string[];
    if (keys.some((scoped) => !this.#pullsSeen.has(scoped))) {
      for (const scoped of keys) this.#pullsSeen.add(scoped);
      pulls = [...this.#scopedPulls.keys()];
    } else {
      pulls = [
        ...new Set([
          ...this.#dueFor(keys[0]),
          ...this.#dueFor(keys[1]),
          ...this.#alwaysPulls,
        ]),
      ];
    }
    for (const key of pulls) {
      for (const scoped of keys) this.#pullsDue.get(scoped)?.delete(key);
      const pull = this.#scopedPulls.get(key);
      if (pull === undefined) continue;
      if (this.#kept.has(key)) {
        this.counts.scopedPulls += 1;
        pull();
      } else {
        this.#scopedPulls.delete(key);
        this.#alwaysPulls.delete(key);
        this.#forgetAside(key);
      }
    }
  }

  /**
   * The narrowest scope that each path of the result was stored in a
   * scope instance of the document of the scoped outputs in
   * (`#scopedOutputs`), by the text of the path.
   */
  readonly #placeScopes = new Map<string, Scope>();

  /**
   * The narrowest scope that each value a cone of another value placed
   * was stored in a scope instance of its own document in
   * (`#valueDocument`), by the text of `["values", output, ...keys]`.
   * Each such place is a document of its own, so a refused commit of the
   * document of the scoped outputs leaves it as it is.
   */
  readonly #valueScopes = new Map<string, Scope>();

  /**
   * The reference the result holds in the place of the output `index`,
   * where the output was evaluated for one scope key, and nothing where
   * it is one for every key: the value is stored at the path of the
   * output in the scope instance of the document of the scoped outputs
   * (`#scopedOutputs`), and the result document holds a link of that
   * scope to it. `execution-and-storage.md` §4.1 assumes the scope
   * instance of the result document in that place.
   */
  scopedOutput(index: number, host: Host): unknown {
    const output = this.plan.outputs[index];
    if (output.path.includes("*")) return undefined;
    const value = this.valueOfOutput.get(index);
    const lazy = output.collection !== undefined
      ? buildsIndex(this.plan.collections[output.collection].construct)
        ? undefined
        // The rows an assembly holds as stored were stored for every
        // scope key: asking for the scope of the assembly evaluates none.
        : this.assembled(output.collection, true)
      : value !== undefined && this.#values.has(value)
      ? this.evaluated(value)
      : undefined;
    if (lazy === undefined) return undefined;
    const scopes = this.store.scopes!;
    if (!this.#placeScopes.has(JSON.stringify(output.path))) {
      // The result is of no scope key on account of an output it holds
      // by reference.
      const probed = scopes.framed(() => lazy(host.context)).value;
      if (probed.scoped === undefined) return undefined;
    }
    // The dependency is on the reference, which is the same for every
    // scope key: the result is not evaluated again because the entry of
    // another key holds it.
    return host.depend(
      this.#scopedPlace(output.path, (inner) => inner.output(index)),
      [],
    );
  }

  /**
   * The reference to the place of the value of the output `index`, under
   * the element keys its cone has in the context of `host`, where the cone
   * `host` evaluates is another one and the value was evaluated for one
   * scope key, and nothing where it is one for every key (P451, P454). The
   * place is a document of its own for each output and element keys
   * (`#valueDocument`), with an instance for each scope key that evaluated
   * the value. The cone then depends on the reference, which is the same
   * for every scope key: it is of no scope key on its account, and a read
   * of what the reference leads to is a read of the scope instance, which
   * makes the reader one of that key. A row of a per-element construct
   * that places such a value so stays a row of the space.
   */
  scopedValue(index: number, host: Host): unknown {
    const output = this.plan.outputs[index];
    if (output.path.includes("*") || output.collection !== undefined) {
      return undefined;
    }
    const value = this.valueOfOutput.get(index);
    if (value === undefined || !this.#values.has(value)) return undefined;
    const scopes = this.store.scopes!;
    const within = this.collectionsOf(output.cone);
    const keys = this.#keysIn(within, host.context);
    if (keys.includes("?")) return undefined;
    if (!this.#valueScopes.has(JSON.stringify(["values", index, ...keys]))) {
      const probed = scopes.framed(() => this.evaluated(value)(host.context))
        .value;
      if (probed.scoped === undefined) return undefined;
    }
    return host.depend(this.#valuePlace(index, value, keys, within), []);
  }

  /**
   * The entry that stores the value `value` of the output `index`, under
   * the element keys `keys` of the collections `within`, in the scope
   * instance of its document for the scope key evaluated for: its value is
   * the reference to that place, which is the same for every key. The
   * entry is kept under the element keys, so it is dropped with them.
   */
  #valuePlace(
    index: number,
    value: number,
    keys: readonly string[],
    within: readonly number[],
  ): Lazy {
    const text = JSON.stringify(["values", index, ...keys]);
    const key = `scoped ${text}`;
    return (context) =>
      this.#ensureReference(key, context, undefined, "value", (inner) => {
        const scopes = this.store.scopes!;
        const held = this.stored(inner.whole(inner.value(value)));
        const before = this.#valueScopes.get(text);
        const touched = scopes.touched ?? "user";
        const scope = before === "session" ? before : touched;
        if (before !== scope) {
          this.#valueScopes.set(text, scope);
          // The place moved to the instances of a narrower scope: each
          // key stores its value there.
          this.#staleAside(key);
        }
        const doc = scopedDocument(this.#valueDocument(index, keys), scope);
        this.#putScoped(doc, [], held);
        return new Ref(doc, []);
      }, within);
  }

  /**
   * The name, without a scope, of the document whose scope instances hold
   * the value of the output `index` under the element keys `keys`, where a
   * cone of another value placed it and it was evaluated for one scope key
   * (`scopedValue`): one document for each output and element keys, as
   * today's runtime keeps the result of a node of a row that reads a cell
   * of a scope in a cell of its own for the row.
   */
  #valueDocument(index: number, keys: readonly string[]): string {
    const { cone } = this.plan.outputs[index];
    const id = this.#identifier(
      "scoped value",
      this.plan.cones[cone].within,
      keys,
      { output: index },
    );
    this.root.#scopedValuesOf.set(id, { instance: this, output: index, keys });
    return id;
  }

  /**
   * The stored form of a reference to the rows of the assembled
   * collection `reference` that stands at the path `at` of the result,
   * where the assembly is of a scope key, and nothing where it is one for
   * every key. The rows are stored whole in the scope instance of the
   * document of the scoped outputs. Below a row of another collection
   * they have no path
   * of the result, and the form is an error state.
   */
  #scopedRows(
    reference: Assembled,
    at: string[],
    atRoot: boolean,
  ): unknown {
    const { scopes } = this.store;
    if (scopes === undefined) return undefined;
    if (!atRoot || !this.#placeScopes.has(JSON.stringify(at))) {
      // A piece that was started with rows left as stored learns where
      // the rows of a collection stand when the unit is placed, and its
      // assembly is first evaluated then, with the rows it can leave. Such
      // rows were stored for every scope key, so an assembly that has no
      // entry yet is asked nothing here. The rows an assembly holds as
      // stored are left so in every other case too.
      const held = this.#memo.get(reference.name);
      const assembly = held === undefined &&
          this.options.units?.stale !== undefined &&
          this.#listed?.has(reference.collection) === true
        ? undefined
        : scopes.framed(() =>
          this.assembled(reference.collection, true)(
            this.freshContext(reference.context),
          )
        ).value;
      if (assembly?.scoped === undefined) return undefined;
    }
    if (!atRoot) {
      return errorState(
        "a collection of a scope narrower than the space, in a row of " +
          "another collection",
      );
    }
    return this.stored(
      this.#scopedPlace(at, () => reference)(new Map()).value,
    );
  }

  /**
   * The entry that stores what `valueOf` gives at the path `path` of the
   * scope instance of the document of the scoped outputs, for the scope
   * key evaluated for: its value is the reference to that place, which is
   * the same for
   * every key. The value is stored with each reference to an assembled
   * collection in it settled, member by member where it differs from
   * what the place holds.
   */
  #scopedPlace(
    path: readonly string[],
    valueOf: (host: Host) => unknown,
  ): Lazy {
    const text = JSON.stringify(path);
    const key = `scoped ${text}`;
    return (context) =>
      this.#ensureReference(key, context, undefined, "value", (inner) => {
        const scopes = this.store.scopes!;
        const value = this.stored(inner.whole(valueOf(inner)));
        const before = this.#placeScopes.get(text);
        const touched = scopes.touched ?? "user";
        const scope = before === "session" ? before : touched;
        if (before !== scope) {
          this.#placeScopes.set(text, scope);
          // The place moved to the instances of a narrower scope: each
          // key stores its value there.
          this.#staleAside(key);
        }
        const doc = scopedDocument(this.#scopedOutputs(), scope);
        this.#putScoped(doc, path, value);
        return new Ref(doc, [...path]);
      });
  }

  /**
   * Whether a reference names the place of a value of a scope key that
   * the cone of another value placed (`scopedValue`).
   */
  isScopedPlace(ref: Ref): boolean {
    const { base, scope } = scopeOfDocument(ref.doc);
    return scope !== undefined && this.root.#scopedValuesOf.has(base);
  }

  /**
   * On the root: the instance whose outputs of a scope each document of
   * `#scopedOutputs()` holds, by the name of the document without its
   * scope.
   */
  readonly #scopedOutputsOf = new Map<string, Instance>();

  /**
   * The name, without a scope, of the document whose scope instances hold
   * the outputs of this instance that were evaluated for one scope key,
   * each at the path it has in the result. It is a document of its own
   * and not the result document: the label of an instance of a scope is
   * read with the instance of the space of the same document, which every
   * transaction that writes an output of the space writes.
   */
  #scopedOutputs(): string {
    const id = identifierOf({ parent: this.id, type: "scoped outputs" });
    this.root.#scopedOutputsOf.set(id, this);
    return id;
  }

  /**
   * On the root: the instance, the output and the element keys whose value
   * each document of `#valueDocument()` holds, by the name of the document
   * without its scope.
   */
  readonly #scopedValuesOf = new Map<
    string,
    { instance: Instance; output: number; keys: readonly string[] }
  >();

  /**
   * The records of a write to a scope instance of the document of a value
   * of a scope key (`#valueDocument`): the value of the output at the
   * root, under the record of that output for its element keys, and each
   * interim output of the same cone below it, under its own.
   */
  #valueWrites(
    doc: string,
    path: readonly string[],
    place: { output: number; keys: readonly string[] },
  ): PlanWrite[] {
    const output = this.plan.outputs[place.output];
    if (output === undefined) return [];
    const keyed = this.collectionsOf(output.cone).map((
      collection,
      at,
    ): [number, string] => [collection, place.keys[at]]);
    const found: { output: number; at: string[] }[] = [];
    this.plan.outputs.forEach((other, number) => {
      if (
        other.cone !== output.cone || other.kept || other.path.includes("*")
      ) {
        return;
      }
      const at = other.path;
      const covers = at.length <= path.length
        ? at.every((segment, position) => segment === path[position])
        : path.every((segment, position) => segment === at[position]);
      if (!covers) return;
      if (at.length > path.length && this.store.peek(doc, at) === undefined) {
        return;
      }
      found.push({
        output: number,
        at: at.length < path.length ? [...path] : [...at],
      });
    });
    return found.map(({ output, at }) => {
      const write = this.#outputRecord(doc, output, at, keyed);
      this.root.#noteRecord(
        this.#recordKey(output, [doc, ...at]),
        this.id,
        write,
      );
      return write;
    });
  }

  /**
   * Stores `value` at `path` of the scope instance `doc` of the document
   * of the scoped outputs: a member of a record with the same members,
   * and a position of an array of the same length, is compared by itself.
   */
  #putScoped(doc: string, path: readonly string[], value: unknown): void {
    const { store } = this;
    if (!store.docs.has(doc)) store.create(doc, "scope instance", {});
    for (let depth = 1; depth < path.length; depth++) {
      const above = path.slice(0, depth);
      if (!isRecord(store.peek(doc, above))) store.put(doc, above, {});
    }
    const put = (at: readonly string[], now: unknown, held: unknown) => {
      if (sameStored(held, now)) return;
      if (
        Array.isArray(now) && Array.isArray(held) &&
        now.length === held.length && now.length > 0
      ) {
        now.forEach((member, index) =>
          put([...at, `${index}`], member, held[index])
        );
        return;
      }
      // An array that gained or lost members: the one run of positions
      // that differs is spliced, and the members before and behind it are
      // not written again, as a write of today's runtime diffs an array.
      if (Array.isArray(now) && Array.isArray(held) && held.length > 0) {
        let head = 0;
        while (
          head < now.length && head < held.length &&
          sameStored(now[head], held[head])
        ) head += 1;
        let tail = 0;
        while (
          tail < now.length - head && tail < held.length - head &&
          sameStored(now[now.length - 1 - tail], held[held.length - 1 - tail])
        ) tail += 1;
        store.splice(
          new Ref(doc, [...at]),
          head,
          held.length - head - tail,
          now.slice(head, now.length - tail),
        );
        return;
      }
      if (isRecord(now) && isRecord(held) && !isLink(now) && !isLink(held)) {
        const names = Object.keys(now);
        if (
          names.length > 0 && names.length === Object.keys(held).length &&
          names.every((name) => Object.hasOwn(held, name))
        ) {
          for (const name of names) put([...at, name], now[name], held[name]);
          return;
        }
      }
      store.put(doc, at, now);
    };
    put(path, value, store.peek(doc, path));
  }

  /**
   * The memo entry of a computation, evaluated where it is not current: a
   * position it read was written since, an entry it used changed since,
   * or an index it read is another one now (ES §2.6). `kind` says what
   * is evaluated: a cone instance of an element body, the assembly of a
   * collection, or another value.
   */
  #ensureOne(
    key: string,
    context: Context,
    cone: number | undefined,
    kind: "element" | "assembly" | "value",
    compute: (host: Host) => unknown,
    within: readonly number[] = [],
    /**
     * Brings an entry that is not current up to date from the one it
     * has, where it can: the entry it gives is the entry of the name,
     * and with none the entry is computed.
     */
    refresh?: (held: Entry, slot: Slot) => Entry | undefined,
  ): Entry {
    const held = this.#memo.get(key);
    if (held !== undefined && !held.pending) {
      // The check of an entry brings the cones it demanded up to date,
      // and one of them can demand this entry's cone in turn: a pull that
      // reaches a check in progress gets what the entry holds.
      if (this.#checking.has(key)) return held;
      this.#checking.add(key);
      try {
        if (this.#current(held, context)) return held;
      } finally {
        this.#checking.delete(key);
      }
    }
    if (this.#open.has(key)) {
      // A pull that reaches an evaluation in progress gets what it last
      // had (ES §2.7, "Detection").
      return held ?? this.#none(key);
    }
    const { root } = this;
    const open = root.#tx;
    const name = `${this.id}\n${key}`;
    // The bound is on a cone instance (PL §5.2, "The bound"). The
    // assembly of a collection and the record of the result belong to no
    // cone.
    if (open !== undefined && cone !== undefined) {
      const times = open.counts.get(name) ?? 0;
      if (times >= MAX_EVALUATIONS) {
        // A materializer that reaches its budget stays as it is and
        // takes no error state (SS §8.3).
        if (this.plan.cones[cone].sideWrites === "materializer") {
          return held ?? this.#none(key);
        }
        return this.#exhausted(open, key, name, held, context, cone, within);
      }
      open.counts.set(name, times + 1);
    }
    const slot = this.#slot(key);
    if (refresh !== undefined && held !== undefined && !held.pending) {
      this.#open.add(key);
      this.#markedDuring.delete(key);
      const serial = slot.serial;
      let next: Entry | undefined;
      try {
        next = refresh(held, slot);
      } finally {
        this.#open.delete(key);
      }
      if (next !== undefined) {
        this.counts.evaluations += 1;
        this.counts.assemblies += 1;
        this.#memo.set(key, next);
        if (!this.#markedDuring.delete(key) && slot.serial === serial) {
          slot.marked = false;
          slot.suspects.clear();
          slot.reads.clear();
        } else {
          slot.all = true;
        }
        if (next.changedAt !== held.changedAt) this.#markUsers(key);
        return next;
      }
    }
    this.#open.add(key);
    root.#evaluating.push({ instance: this, key });
    this.#unregister(slot);
    this.#markedDuring.delete(key);
    const host = new Host(this, context, cone, key);
    const evaluatedAt = this.store.clock;
    let value: unknown;
    let failure: string | undefined;
    try {
      value = compute(host);
    } catch (error) {
      // A cone instance whose code throws, or reads a value in an error
      // state, takes an error state, and the rest of the transaction goes
      // on (PL §5.2).
      if (cone === undefined || !failsCone(error)) throw error;
      failure = messageOf(error);
      value = error instanceof ReadsFailure ? error.state : errorState(failure);
    } finally {
      this.#open.delete(key);
      root.#evaluating.pop();
      host.done = true;
    }
    this.counts.evaluations += 1;
    if (kind === "element") this.counts.elementEvaluations += 1;
    if (kind === "assembly") {
      this.counts.assemblies += 1;
      this.counts.assembliesFormed += 1;
    }
    const entryName = cone === undefined
      ? "result"
      : this.plan.cones[cone].entry;
    if (kind === "value") this.trace.push(entryName);
    if (kind !== "assembly") open?.record.evaluated.push(entryName);
    if (failure !== undefined) {
      this.counts.failures += 1;
      root.failed.push({ cone: entryName, message: failure });
      if (open !== undefined) {
        open.record.failed.push(entryName);
        // Its side-writes are withdrawn (PL §5.2).
        root.#withdraw(open, name);
      }
    }
    const stored = canonical(this.stored(value));
    // An entry whose value is a reference made by its evaluation, which is
    // the same for every scope key, evaluated for a key for the first time
    // is no change where it holds what the entry of another key held.
    const stamp = held === undefined && this.#references.has(key)
      ? this.#referenceStamps.get(key)
      : undefined;
    const changed = stamp !== undefined
      ? stamp.stored !== stored
      : held === undefined || held.pending === true || held.stored !== stored;
    // What a cone demanded through its write target wrote before the
    // reads that followed is what those reads saw. A read made before it
    // that it wrote at is stale, and the entry is evaluated again.
    const demanded = host.demandedAt;
    const early = demanded === undefined
      ? []
      : host.reads.slice(0, demanded.reads);
    const staleByDemand = demanded !== undefined &&
      this.store.changedSince(evaluatedAt, early) &&
      !this.store.changedSince(demanded.clock, early);
    const readAt = demanded === undefined || staleByDemand
      ? evaluatedAt
      : demanded.clock;
    // A body that wrote a position it read is not evaluated again on
    // account of its own write.
    const ownWrite = !staleByDemand &&
      this.store.changedSince(readAt, host.reads);
    if (ownWrite) this.counts.staleByOwnWrite += 1;
    if (changed) this.store.clock += 1;
    const entry: Entry = {
      key,
      owner: this,
      value,
      stored,
      reads: host.reads,
      dependencies: host.dependencies,
      indexes: host.indexes,
      members: host.members,
      ...(host.rows === undefined ? {} : { rows: host.rows }),
      version: (held?.version ?? 0) + 1,
      writers: host.writers,
      ...(failure === undefined ? {} : { error: failure }),
      evaluatedAt: ownWrite ? this.store.clock : readAt,
      changedAt: changed
        ? this.store.clock
        : held?.changedAt ?? stamp!.changedAt,
    };
    if (this.#references.has(key)) {
      this.#referenceStamps.set(key, { stored, changedAt: entry.changedAt });
    }
    this.#memo.set(key, entry);
    this.#keep(key, cone, within, context);
    if (within.length > 0 && this.#listed?.has(within[0]) === true) {
      this.#underListed(within[0], context, key);
    }
    // The bindings are kept for the write records of a store outside the
    // executor (`TransactionHooks`), and for nothing else.
    if (this.root.options.transactions !== undefined) {
      if (cone !== undefined) this.#noteInputs(cone, context, host);
      else if (key === "result") {
        this.#inputs.set(RESULT_INPUTS, {
          slots: host.bound,
          selections: host.selections,
          picks: host.picks,
          dynamic: host.dynamic,
        });
      }
    }
    this.#evaluated(slot, entry, host, changed);
    return entry;
  }

  /**
   * Ends the evaluation of an entry: registers what it read and used,
   * so that a change marks it, and marks the entries that used it where
   * its value changed.
   */
  #evaluated(slot: Slot, entry: Entry, host: Host, changed: boolean): void {
    const key = slot.key;
    slot.marked = false;
    slot.all = false;
    slot.suspects.clear();
    slot.reads.clear();
    const always = !this.#register(slot, entry);
    if (slot.always && !always) {
      slot.always = false;
      this.#alwaysCount -= 1;
    }
    if (always) this.#setAlways(slot);
    for (const collection of host.indexes.keys()) {
      const element = host.context.get(collection);
      if (element === undefined) continue;
      const under = this.#name(
        "under",
        collection,
        this.#keysIn(this.#outerOf(collection), host.context),
        element.key,
      );
      const readers = this.#indexReaders.get(under) ?? new Set();
      readers.add(key);
      this.#indexReaders.set(under, readers);
    }
    // A write to something that the evaluation had read, and a change
    // of something it had used, while it ran.
    if (
      this.#markedDuring.delete(key) ||
      this.store.changedSince(entry.evaluatedAt, entry.reads)
    ) {
      slot.marked = true;
      slot.all = true;
      slot.serial += 1;
      this.#nowDue();
      this.#pullDue(slot);
    }
    if (changed) this.#markUsers(key, this.#scopedNow(key));
  }

  /**
   * Has an entry compared on every pull, and with it every entry that
   * used it: nothing marks them when what the entry depends on changes.
   */
  #setAlways(slot: Slot): void {
    const entry = slot.aside ?? this.#memo.get(slot.key);
    if (entry !== undefined) entry.always = true;
    if (slot.always) return;
    slot.always = true;
    this.#alwaysCount += 1;
    if (this.#scopedPulls.has(slot.key)) this.#alwaysPulls.add(slot.key);
    for (const user of this.#users.get(slot.key) ?? []) {
      const other = this.#slots.get(user);
      if (other !== undefined) this.#setAlways(other);
    }
    for (const other of [...this.#asideUsers.get(slot.key) ?? []]) {
      this.#setAlways(other);
    }
  }

  /**
   * Marks what read the position of an element whose position changed
   * (`execution-and-storage.md` §2.5, step 4).
   */
  #moved(collection: number, around: readonly string[], key: string): void {
    const readers = this.#indexReaders.get(
      this.#name("under", collection, around, key),
    );
    if (readers === undefined) return;
    for (const reader of readers) {
      const slot = this.#slots.get(reader);
      if (slot !== undefined) this.#mark(slot);
      for (const aside of this.#asideSlots.get(reader)?.values() ?? []) {
        this.#mark(aside);
      }
    }
  }

  /**
   * Marks as not current what is kept under an element key whose element
   * is now at another place than when it was evaluated, with the key
   * unchanged: an element of an array whose document was named again in
   * the scope its value was found to have (`#generated()`). A row that
   * passed the reference to its element on holds the reference to the old
   * place and read nothing there that a change would mark.
   */
  #placeMoved(
    collection: number,
    around: readonly string[],
    key: string,
  ): void {
    const id = this.#name("under", collection, around, key);
    for (const entry of this.#underKey.get(id) ?? []) this.markStale(entry);
  }

  /**
   * Fails a cone instance whose next evaluation would be one more than
   * the bound allows (SS §8.1 and §8.2): the evaluation does not run, the
   * entry takes the error state, and the side-writes the cone instance
   * staged in the transaction are withdrawn. The entry keeps the reads of
   * its last evaluation.
   */
  #exhausted(
    open: Open,
    key: string,
    name: string,
    held: Entry | undefined,
    context: Context,
    cone: number,
    within: readonly number[],
  ): Entry {
    if (held !== undefined && held.exhausted === open.record) return held;
    const message = `the cone \`${
      this.plan.cones[cone].entry
    }\` did not settle within ${MAX_EVALUATIONS} evaluations`;
    const value = errorState(message);
    this.counts.failures += 1;
    this.root.failed.push({ cone: this.plan.cones[cone].entry, message });
    open.record.failed.push(this.plan.cones[cone].entry);
    this.root.#withdraw(open, name);
    this.store.clock += 1;
    const entry: Entry = {
      ...(held ?? this.#none(key)),
      value,
      stored: canonical(value),
      error: message,
      exhausted: open.record,
      changedAt: this.store.clock,
      checkedAt: undefined,
    };
    delete entry.pending;
    this.#memo.set(key, entry);
    this.#keep(key, cone, within, context);
    this.#markUsers(key);
    open.exhausted.push({ entry, context });
    return entry;
  }

  /**
   * Records under which element keys an entry is kept: the keys of the
   * collections `within` names. The entry is dropped with each of them.
   */
  #keep(
    key: string,
    cone: number | undefined,
    within: readonly number[],
    context: Context,
  ): void {
    if (this.#kept.has(key)) return;
    this.#kept.set(key, {
      cone,
      keys: within.map((collection) => context.get(collection)?.key ?? "?"),
    });
    for (const collection of within) {
      const id = this.#name(
        "under",
        collection,
        this.#keysIn(this.#outerOf(collection), context),
        context.get(collection)?.key ?? "?",
      );
      const under = this.#underKey.get(id) ?? new Set();
      under.add(key);
      this.#underKey.set(id, under);
    }
  }

  /**
   * Drops what is kept under an element key that left its collection:
   * the instances of every cone whose `within` names the collection, and
   * the element tables and assemblies of the collections inside it
   * (ES §2.5, "Which cones are the body's").
   */
  #drop(collection: number, around: readonly string[], key: string): void {
    const id = this.#name("under", collection, around, key);
    const table = this.#groups.get(this.#name("assembly", collection, around));
    this.#indexReader(
      `${this.#name("assembly", collection, around)}\n${key}`,
      { collection, around, key },
      undefined,
    );
    if (table?.byKey.has(key)) {
      if (this.#leaveGroup(table, key)) {
        this.#regroupEnclosing(collection, around);
      }
      this.counts.groupUpdates += 1;
    }
    for (const entry of this.#underKey.get(id) ?? []) {
      const kept = this.#kept.get(entry);
      if (kept?.cone !== undefined) {
        this.#inputs.delete(this.#coneInstance(kept.cone, kept.keys));
      }
      this.#groups.delete(entry);
      this.#memo.delete(entry);
      this.#kept.delete(entry);
      this.#tables.delete(entry);
      const slot = this.#slots.get(entry);
      if (slot !== undefined) {
        this.#unregister(slot);
        if (slot.always) this.#alwaysCount -= 1;
        this.#slots.delete(entry);
      }
      this.#forgetAside(entry);
      this.#scopedPulls.delete(entry);
      this.#alwaysPulls.delete(entry);
      this.#referenceStamps.delete(entry);
      if (entry.startsWith("scoped ")) {
        this.#placeScopes.delete(entry.slice("scoped ".length));
        this.#valueScopes.delete(entry.slice("scoped ".length));
      }
      this.#markUsers(entry);
      this.#markUsers(tableName(entry));
    }
    this.#underKey.delete(id);
    this.#indexReaders.delete(id);
    if (this.#listed?.has(collection) === true) {
      this.options.units?.left(collection, key);
      // The lists no longer name the element as a reader, so a row of the
      // key is not left as stored where the key enters again.
      this.#seeds.get(this.#name("assembly", collection, around))?.stored
        ?.delete(key);
    }
  }

  /**
   * The collections a cone has an instance per element key of: the
   * `element` steps of `Cone.within`, outermost first (ruling Z10).
   */
  collectionsOf(cone: number): number[] {
    return this.plan.cones[cone].within.flatMap((step) =>
      step.element === undefined ? [] : [step.element]
    );
  }

  /**
   * The instances of a cone that exist: the element keys of each, one
   * key per `element` step of `Cone.within`.
   */
  coneInstances(cone: number): string[][] {
    const found = new Map<string, string[]>();
    for (const kept of this.#kept.values()) {
      if (kept.cone === cone) found.set(textOf(kept.keys), kept.keys);
    }
    return [...found.values()];
  }

  #current(entry: Entry, context: Context): boolean {
    if (entry.stale) return false;
    for (const [collection, index] of entry.indexes) {
      if (context.get(collection)?.index !== index) return false;
    }
    // An entry that no change marked is current: a write marks what
    // read the position, and a mark passes on to what used the entry
    // (SS §3).
    const slot = entry.key === undefined || entry.owner !== this
      ? undefined
      : this.#slots.get(entry.key);
    if (slot !== undefined && !slot.marked && !entry.always) return true;
    const clock = this.store.clock;
    if (entry.checkedAt === clock) return true;
    // The cones whose write target the entry read or passed on are
    // brought up to date first, as an upstream output is (ES §2.3).
    for (const writer of entry.writers) writer(context);
    this.checks += 1;
    const serial = slot?.serial;
    // What is compared: what the marks name, and everything where a
    // mark names nothing.
    const all = slot === undefined || entry.always === true || slot.all;
    const reads = all ? entry.reads : [...slot.reads];
    // A key that moved keeps its entries: nothing of an element is
    // evaluated on a move but what read the index (ES §2.6).
    if (
      reads.length > 0 && this.store.changedSince(entry.evaluatedAt, reads)
    ) {
      return false;
    }
    const current = entry.dependencies.every((dependency) =>
      (!all && dependency.on !== undefined &&
        !slot.suspects.has(dependency.on)) ||
      dependency.stamp(context) === dependency.seen
    );
    // A dependency brought up to date while it was compared can write a
    // position the entry read, as the place of a value of a scope that the
    // entry reads through the reference it depends on: the position is
    // compared too, and the entry is not current where it changed.
    if (
      current && slot !== undefined && slot.serial !== serial &&
      slot.reads.size > 0 &&
      this.store.changedSince(entry.evaluatedAt, [...slot.reads])
    ) {
      return false;
    }
    // A check that evaluated something that wrote is no check at the
    // clock it ended at.
    if (current && this.store.clock === clock) entry.checkedAt = clock;
    if (current && slot !== undefined && slot.serial === serial) {
      slot.marked = false;
      slot.all = false;
      slot.suspects.clear();
      slot.reads.clear();
    }
    return current;
  }

  /** The entry of a value function, for the element keys of a context. */
  evaluated(value: number): Lazy {
    const run = this.#values.get(value);
    if (run === undefined) {
      throw new Unsupported("a value that has no value function");
    }
    const { cone } = this.code.values[value];
    const within = this.collectionsOf(cone);
    const materializer = this.plan.cones[cone].sideWrites === "materializer";
    return (context) => {
      const key = this.#name("value", value, this.#keysIn(within, context));
      // A materializer is evaluated after the rest of a wave, and a
      // reader of its value in the wave gets what it last returned.
      if (materializer && !this.#afterWave) {
        const held = this.#memo.get(key) ??
          { ...this.#none(key), pending: true };
        this.#memo.set(key, held);
        return held;
      }
      return this.#ensure(
        key,
        context,
        cone,
        within.length > 0 ? "element" : "value",
        run,
        within,
      );
    };
  }

  /**
   * What a `reduce` of the reactive tier computes (PL §3.13): the initial
   * value, and then the step once per element of the collection of the
   * `reduce`, in the order the collection iterates, with the accumulator
   * as the value of the slot of root `operation`. The collection is the
   * one whose element body the step is written in, the last `element`
   * step of the `within` of the step's cone. The whole fold is one entry:
   * it is evaluated again when something a step read changed, or the
   * membership or the order of the collection.
   */
  reduced(operation: number): Lazy {
    const fold = this.#reduces.get(operation);
    if (fold === undefined) {
      throw new Unsupported("a `reduce` that has no function");
    }
    const within = this.collectionsOf(fold.stepCone);
    const collection = within[within.length - 1];
    const outer = within.slice(0, -1);
    return (context) => {
      const key = this.#name(
        "reduce",
        operation,
        this.#keysIn(outer, context),
      );
      // The fold is the runtime's step over the collection, as the
      // assembly of an element construct is, and belongs to no cone.
      return this.#ensure(key, context, undefined, "assembly", (host) => {
        const used = (other: Host) => {
          for (const read of other.reads) host.reads.push(read);
          for (const dependency of other.dependencies) {
            host.dependencies.push(dependency);
          }
          for (const writer of other.writers) {
            if (!host.writers.includes(writer)) host.writers.push(writer);
          }
        };
        let value: unknown;
        if (fold.initial !== undefined) {
          const first = new Host(this, context, fold.initialCone);
          value = fold.initial(first);
          used(first);
        }
        for (const element of this.#table(collection, host)) {
          const step = new Host(
            this,
            new Map([...context, [collection, element]]),
            fold.stepCone,
          );
          step.accumulator = { operation, value };
          value = fold.step(step);
          used(step);
        }
        return value;
      }, outer);
    };
  }

  /** The `element` steps around a collection, outermost first. */
  #outerOf(collection: number): number[] {
    return this.plan.collections[collection].within.flatMap((step) =>
      step.element === undefined ? [] : [step.element]
    );
  }

  /**
   * The entry of the body of an element construct for one element key.
   * The element is the one the table of the collection holds under the
   * key now, so an entry that depends on this one is checked against the
   * position the key has now.
   */
  #perElement(collection: number, key: string): Lazy {
    const outer = this.#outerOf(collection);
    const cone = this.code.values.find((value) =>
      value.collection === collection
    )?.cone;
    return (context) => {
      const around = this.#keysIn(outer, context);
      const name = this.#name("element", collection, around, key);
      const element = this.#tables.get(
        this.#name("assembly", collection, around),
      )?.byKey.get(key);
      const run = this.#elements.get(collection);
      if (element === undefined || run === undefined) {
        return this.#memo.get(name) ?? this.#none(name);
      }
      const inner = new Map<number, Element>();
      for (const step of outer) {
        const bound = context.get(step);
        if (bound !== undefined) inner.set(step, bound);
      }
      inner.set(collection, element);
      this.#declare(inner);
      if (this.#listed?.has(collection) !== true) {
        return this.#ensure(name, inner, cone, "element", run, [
          ...outer,
          collection,
        ]);
      }
      this.#adoptStored(collection, key, name);
      return this.#ensure(name, inner, cone, "element", run, [
        ...outer,
        collection,
      ]);
    };
  }

  /**
   * The assembled result of an element construct (ES §2.5): the element
   * table, the body's function once per key, and the structural step.
   * The entry holds the elements of the result with their keys: an
   * element of the result of a `map`, a `filter` or a `flatMap` has the
   * key of the element it came from (PL §1.3, "Derived collections carry
   * their elements' keys").
   */
  assembled(collection: number, stored = false): Lazy {
    const record = this.plan.collections[collection];
    const outer = this.#outerOf(collection);
    return (context) => {
      const around = this.#keysIn(outer, context);
      const key = this.#name("assembly", collection, around);
      const entry = this.#ensure(
        key,
        context,
        undefined,
        "assembly",
        (host) => {
          const held = this.#seed(collection, key, host);
          if (held !== undefined) return held;
          const elements = this.#table(collection, host);
          // The instances of a key that left the collection are dropped,
          // and those of a key that entered are made when they are first
          // evaluated (ruling Z10).
          const before = this.#tables.get(key);
          this.#setTable(key, collection, around, elements);
          const now = this.#tables.get(key)?.byKey;
          for (const { key: left, index, source } of before?.elements ?? []) {
            const stays = now?.get(left);
            if (stays === undefined) {
              this.#drop(collection, around, left);
              continue;
            }
            if (!samePlace(source, stays.source)) {
              this.#placeMoved(collection, around, left);
            }
            if (stays.index !== index) this.#moved(collection, around, left);
          }
          // What reads the value of an element from the table.
          this.#markUsers(tableName(key));
          if (!this.#elements.has(collection)) {
            throw new Unsupported("an element construct that has no function");
          }
          const first = host.dependencies.length;
          const keyOf = new Map<string, string>();
          // The rows that are left as the storage holds them, and how many
          // of them have no name of an entry among `keyOf`.
          const left = around.length > 0
            ? undefined
            : this.#storedIn(collection, key, elements, host);
          let unnamed = 0;
          const results = elements.map((element) => {
            if (left?.has(element.key)) {
              const on = left.get(element.key);
              if (on === undefined) unnamed += 1;
              else keyOf.set(on, element.key);
              host.dependencies.push({
                stamp: () => Symbol(),
                seen: STORED_ROW,
                on: on ?? `stored ${key}`,
              });
              return STORED_ROW;
            }
            const entry = host.dependEntry(
              this.#perElement(collection, element.key),
            );
            if (entry.key !== undefined) keyOf.set(entry.key, element.key);
            return entry.value;
          });
          // What a later change of the array or of one row is applied to.
          const rows = (
            construct: Rows["construct"],
            members: Element[],
            flags?: boolean[],
            segmentDependencies = 0,
          ) => {
            const { found, from } = host;
            if (
              host.writers.length > 0 ||
              host.dependencies.length !==
                first + elements.length + segmentDependencies ||
              keyOf.size !== elements.length - unnamed ||
              !this.#mayRefresh
            ) return;
            const state = found === undefined
              ? undefined
              : this.store.keyState(found.held, found.fields);
            const upstream = from?.entry.key === undefined ? undefined : {
              collection: from.collection,
              name: from.entry.key,
              version: from.entry.version ?? 0,
            };
            if (state === undefined && upstream === undefined) return;
            host.rows = {
              construct,
              ...(found === undefined || state === undefined ? { upstream } : {
                stored: {
                  base: found.base,
                  named: this.store.addressText(found.named),
                  fields: found.fields,
                  formed: state.formed,
                  seen: state.count,
                },
              }),
              arrayReads: found?.arrayReads ?? new Set(),
              elementReads: found?.elementReads ?? new Map(),
              first,
              results,
              keyOf,
              members,
              ...(flags === undefined ? {} : { flags }),
            };
          };
          // What the result holds for an element it passes on: what the
          // element is, a reference to a cell or a reference by key
          // included.
          const given = ({ source }: Element) =>
            source instanceof Ref
              ? source
              : "entry" in source
              ? host.at(host.depend(source.entry, source.at), source.at)
              : source.value;
          const holds = (index: number) => Boolean(host.v(results[index]));
          const numbered = (members: Omit<Element, "index">[]) =>
            members.map((member, index) => ({ ...member, index }));
          // Each position of the assembled array is an element of the
          // collection, with its key.
          const keyed = (array: unknown[]) => {
            assembledElements.set(array, {
              members: host.members ?? [],
              context,
            });
            return array;
          };
          switch (record.construct) {
            case "map":
              host.members = numbered(elements.map(({ key }) => ({
                key,
                source: { entry: this.#perElement(collection, key), at: [] },
              })));
              rows("map", host.members);
              return keyed([...results]);
            case "groupBy":
            case "keyBy": {
              const before = this.#memo.get(key)?.value;
              const index = new Index(
                record.construct === "groupBy" ? "group" : "key",
                key,
              );
              elements.forEach((element, at) => {
                const encoded = encodeIndexKey(this, results[at]);
                if (encoded === undefined) return;
                index.of.set(element.key, encoded);
                const bucket = index.buckets.get(encoded) ??
                  { key: results[at], keys: [], version: 0 };
                bucket.keys.push(element.key);
                index.buckets.set(encoded, bucket);
              });
              // A bucket that holds the element keys it held in the index
              // this one replaces keeps its count, and what looked it up
              // is not marked. Every other bucket, one that emptied
              // included, takes the next count, which goes on from that
              // of the index before, and its users are marked. The work
              // is the number of elements, with no evaluation for a
              // bucket that stayed.
              const was = before instanceof Index ? before : undefined;
              if (was !== undefined) index.serial = was.serial;
              const changed = (encoded: string) => {
                const now = index.buckets.get(encoded)?.keys ?? [];
                const then = was?.buckets.get(encoded)?.keys;
                return then === undefined || then.length !== now.length ||
                  then.some((element, at) => element !== now[at]);
              };
              for (const [encoded, held] of was?.buckets ?? []) {
                if (!index.buckets.has(encoded)) {
                  index.buckets.set(encoded, { ...held, keys: [] });
                }
              }
              for (const [encoded, bucket] of index.buckets) {
                if (changed(encoded)) {
                  bucket.version = ++index.serial;
                  this.#markUsers(bucketName(key, encoded));
                  if (was !== undefined) this.counts.bucketsChanged += 1;
                } else {
                  bucket.version = was?.buckets.get(encoded)?.version ?? 0;
                }
              }
              host.members = numbered(elements.map(({ key }) => ({
                key,
                source: { entry: this.#perElement(collection, key), at: [] },
              })));
              rows("map", host.members);
              if (host.rows !== undefined) host.rows.index = index;
              return index;
            }
            case "filter": {
              const flags = elements.map((_, index) => holds(index));
              const kept = elements.filter((_, index) => flags[index]);
              host.members = numbered(kept);
              // Each kept row of another per-element construct is a
              // dependency, behind those of the elements.
              const before = host.dependencies.length;
              const values = kept.map(given);
              const ofRows = kept.length > 0 &&
                kept.every(({ source }) => isRowSource(source));
              if (
                results.every((result) =>
                  result === null || typeof result !== "object"
                ) && (ofRows || host.dependencies.length === before)
              ) {
                rows(
                  "filter",
                  host.members,
                  flags,
                  host.dependencies.length - before,
                );
                if (host.rows !== undefined && ofRows) {
                  const named = host.dependencies.slice(before)
                    .map(({ on }) => on);
                  if (named.every((on) => on !== undefined)) {
                    host.rows.kept = new Map(
                      named.map((on, index) => [on!, kept[index].key]),
                    );
                  } else host.rows = undefined;
                }
              }
              return keyed(values);
            }
            case "sortBy": {
              // The elements of the source in the order of their keys,
              // and in the order of the source among equal keys (note 614
              // of `SPEC-NOTES.md`). An element of the result is the
              // source element, passed through, with its key.
              const sortKeys = results.map((result) => host.v(result));
              const order = elements.map((_, index) => index).sort((a, b) =>
                compareSortKeys(sortKeys[a], sortKeys[b]) || a - b
              );
              const sorted = order.map((index) => elements[index]);
              host.members = numbered(sorted);
              // A later change of one key moves one element
              // (`#reassemble`), where every key is a scalar the body
              // gave as the value it is.
              if (results.every(isSortKey)) {
                rows("sortBy", host.members);
                if (host.rows !== undefined) {
                  host.rows.sortKeys = new Map(
                    elements.map(({ key }, index) => [key, sortKeys[index]]),
                  );
                }
              }
              return keyed(sorted.map(given));
            }
            case "last":
            case "first": {
              // A window (note 921 of `SPEC-NOTES.md`): the last or the
              // first elements of the source, by the count the function
              // returned, each passed through with its key.
              const count = windowCount(host.v(results[0]));
              const [start, end] = windowOf(
                record.construct,
                elements.length,
                count,
              );
              const held = elements.slice(start, end);
              host.members = numbered(held);
              // A later change of the source moves the window
              // (`#reassemble`), where every element gave the one count.
              if (results.every((result) => windowCount(result) === count)) {
                rows(record.construct, host.members);
                if (host.rows !== undefined) host.rows.window = count;
              }
              return keyed(held.map(given));
            }
            case "flatMap": {
              // An element of the result has the key of its source
              // element together with a part formed from the member (PL
              // §1.3, "The key of an element that a `flatMap`
              // contributes"; ruling Z22).
              const members: Omit<Element, "index">[] = [];
              const lengths: number[] = [];
              // The inner assembly that the body returned for each
              // element, by its name, while every body returned one.
              const segmentOf = new Map<string, string>();
              const flat = results.flatMap((result, index) => {
                const { key } = elements[index];
                const entry = this.#perElement(collection, key);
                const inner = new Map([...context, [
                  collection,
                  elements[
                    index
                  ],
                ]]);
                this.counts.segmentsFormed += 1;
                let resolved: { value: unknown } | undefined;
                if (result instanceof Assembled && !host.done) {
                  const used = host.dependEntry(this.#assemblyOf(result));
                  resolved = { value: used.value };
                  if (used.key !== undefined && used.owner === this) {
                    segmentOf.set(used.key, key);
                  }
                }
                const segment = this.#segment(
                  result,
                  entry,
                  inner,
                  host,
                  resolved,
                );
                for (const { part, source } of segment.members) {
                  members.push({ key: memberKey(key, part), source });
                }
                lengths.push(segment.members.length);
                return segment.values;
              });
              host.members = numbered(members);
              // A later mark that names no element whose segment changed
              // leaves the assembly as it is, and one that names an
              // element or the inner assembly of one splices the segment
              // of that element (`#reassemble`).
              if (segmentOf.size === elements.length && elements.length > 0) {
                rows("flatMap", host.members, undefined, elements.length);
                if (host.rows !== undefined) {
                  host.rows.segments = { lengths, of: segmentOf };
                }
              } else {
                rows("flatMap", host.members);
              }
              return keyed(flat);
            }
            case "some":
              return elements.some((_, index) => holds(index));
            case "every":
              return elements.every((_, index) => holds(index));
            case "find": {
              const found = elements.find((_, index) => holds(index));
              return found === undefined ? undefined : given(found);
            }
            case "findIndex":
              return elements.findIndex((_, index) => holds(index));
            default:
              throw new Unsupported(
                `an element construct \`${record.construct}\``,
              );
          }
        },
        outer,
        (held, slot) =>
          this.#reassemble(collection, key, around, context, held, slot),
      );
      // A caller that takes no row as stored gets every row evaluated.
      if (stored || !this.#seeds.has(key)) return entry;
      this.#unseed(key);
      return this.assembled(collection, true)(context);
    };
  }

  /**
   * What a bucket of an index holds for the element of one key: the
   * reference to the element, or for an element of the result of another
   * per-element construct the row, which the evaluation then depends on.
   */
  indexMember(index: Index, key: string, host: Host): unknown {
    const source = this.#tables.get(index.name)?.byKey.get(key)?.source;
    if (source === undefined) return undefined;
    if (source instanceof Ref) return source;
    return "entry" in source
      ? host.at(host.depend(source.entry, source.at), source.at)
      : source.value;
  }

  /** The elements of the source of an index under `keys`, in that order. */
  indexElements(index: Index, keys: readonly string[]): Element[] {
    const byKey = this.#tables.get(index.name)?.byKey;
    return keys.flatMap((key, at) => {
      const element = byKey?.get(key);
      return element === undefined ? [] : [{ ...element, index: at }];
    });
  }

  /**
   * An index as a value, in the shape of today's `CollectionIndexData`
   * without its array of the occupied index keys: each bucket that has a
   * member by its encoded key. The occupied keys are the names of the
   * members of `buckets`, so a key that enters or leaves is a change of
   * one member and of no array as long as the index.
   */
  indexRecord(
    index: Index,
    host: Host,
    collection: number,
  ): Record<string, unknown> {
    const occupied = [...index.buckets].filter(([, { keys }]) =>
      keys.length > 0
    );
    return {
      kind: "collection-index",
      mode: index.mode,
      buckets: Object.fromEntries(
        occupied.map((
          [encoded],
        ) => [encoded, this.#bucketOf(index, encoded, host, collection)]),
      ),
    };
  }

  /**
   * What the stored index holds for the bucket of an encoded key: its
   * members in `group` mode, the first of them in `key` mode, and nothing
   * for a bucket with no member.
   *
   * Where the index is over the rows of another per-element construct that
   * the result keeps and that are stored as documents of their own, a
   * bucket holds a reference by key to each row at its place in the
   * result, and no copy of the row (note 611 of `SPEC-NOTES.md`): the index
   * is then written when a member enters or leaves a bucket and not when a
   * row changes, and what reads a member reads the row where it is stored,
   * under the row's label.
   */
  #bucketOf(
    index: Index,
    encoded: string,
    host: Host,
    collection: number,
  ): unknown {
    const keys = index.buckets.get(encoded)?.keys ?? [];
    if (keys.length === 0) return undefined;
    const rows = this.#keptRowsOf(collection);
    const members = keys.map((key) =>
      rows === undefined
        ? this.indexMember(index, key, host)
        : new Ref(this.id, [...rows, keySegment(key)])
    );
    return index.mode === "group" ? members : members[0];
  }

  /**
   * The paths of the result document, as text, at which the instance keeps
   * the record of the buckets of an index whose buckets are stored as
   * documents of their own (`bucketDocuments`). Made once.
   */
  #bucketRecordPaths(): ReadonlySet<string> {
    if (this.#bucketPaths !== undefined) return this.#bucketPaths;
    const found = new Set<string>();
    const collections = this === this.root
      ? this.options.bucketDocuments
      : undefined;
    for (const output of collections === undefined ? [] : this.plan.outputs) {
      if (
        output.kept === true && output.collection !== undefined &&
        collections?.has(output.collection) && !output.path.includes("*")
      ) found.add(JSON.stringify([...output.path, "buckets"]));
    }
    this.#bucketPaths = found;
    return found;
  }

  /** The result of `#bucketRecordPaths()`. */
  #bucketPaths: ReadonlySet<string> | undefined;

  /**
   * The path of the result document at which the instance keeps the record
   * of the buckets of the index of `collection`, where the buckets are
   * stored as documents of their own (`bucketDocuments`).
   */
  bucketRecordOf(collection: number): readonly string[] | undefined {
    if (this !== this.root || !this.options.bucketDocuments?.has(collection)) {
      return undefined;
    }
    return this.#bucketOutputs().find((kept) => kept.collection === collection)
      ?.record;
  }

  /**
   * The kept indexes whose buckets are stored as documents of their own:
   * the output of each, its collection, and the path of the record of its
   * buckets. Made once.
   */
  #bucketOutputs(): readonly {
    output: number;
    collection: number;
    record: readonly string[];
  }[] {
    if (this.#bucketKept !== undefined) return this.#bucketKept;
    const collections = this === this.root
      ? this.options.bucketDocuments
      : undefined;
    const found: { output: number; collection: number; record: string[] }[] =
      [];
    this.plan.outputs.forEach((output, index) => {
      if (
        output.kept === true && output.collection !== undefined &&
        collections?.has(output.collection) && !output.path.includes("*")
      ) {
        found.push({
          output: index,
          collection: output.collection,
          record: [...output.path, "buckets"],
        });
      }
    });
    this.#bucketKept = found;
    return found;
  }

  /** The result of `#bucketOutputs()`. */
  #bucketKept:
    | readonly { output: number; collection: number; record: string[] }[]
    | undefined;

  /**
   * The path of the result at which the instance keeps the rows of the
   * collection that the index of `collection` is over, where that source
   * is another per-element construct whose rows are stored as documents
   * of their own and whose assembled result is a kept output.
   */
  #keptRowsOf(collection: number): string[] | undefined {
    const record = this.plan.collections[collection];
    const source = record?.source.collection;
    if (source === undefined || record.within.length > 0) return undefined;
    // The collections named are those of the plan the executor was started
    // with.
    if (this !== this.root || this.options.rowDocuments?.has(source) !== true) {
      return undefined;
    }
    const kept = this.plan.outputs.find((output) =>
      output.kept === true && !output.path.includes("*") &&
      (output.collection === source || output.passesCollection === source)
    );
    return kept === undefined ? undefined : [...kept.path];
  }

  /**
   * Whether an assembly is brought up to date from the changes of its
   * array (`assembly: "applied"`, the default), or formed again whole
   * (`assembly: "formed"`), as `scheduler-and-serving-loop.md` §3.2 has
   * it: "The evaluation it causes rebuilds the table".
   */
  get #mayRefresh(): boolean {
    return (this.root.options.assembly ?? "applied") === "applied";
  }

  /**
   * Brings the assembly of a `map` or a `filter` over a stored array up
   * to date from the entry it has (`Rows`): the splices of the array
   * are applied to the element table and to the result, the body is
   * evaluated for the keys that entered and for those whose entry is
   * marked, and nothing is done for another element. Gives nothing
   * where what marked the entry is something else, and the assembly is
   * then formed whole.
   */
  /**
   * The value of the row of another per-element construct that `lazy`
   * gives, and the dependency of an assembly that holds the row as one of
   * its members: on the row's entry, by the stored form of its value, as
   * `Host.depend` gives one for a path. Nothing where the entry is of
   * another instance.
   */
  #rowDependency(
    lazy: Lazy,
    context: Context,
  ): { dependency: Dependency; value: unknown } | undefined {
    const entry = lazy(context);
    if (entry.owner !== this || entry.key === undefined) return undefined;
    const held = (from: Entry) => canonical(this.stored(from.value));
    return {
      value: entry.value,
      dependency: {
        stamp: (now) => held(lazy(now)),
        seen: held(entry),
        on: entry.key,
      },
    };
  }

  #reassemble(
    collection: number,
    name: string,
    around: readonly string[],
    context: Context,
    held: Entry,
    slot: Slot,
  ): Entry | undefined {
    const rows = held.rows;
    const table = this.#tables.get(name);
    if (
      rows === undefined || table === undefined || slot.all || held.always ||
      !slot.marked || !this.#mayRefresh ||
      table.elements.length !== rows.results.length
    ) return undefined;
    const { store } = this;
    const began = store.clock;
    const relocate = new Set<string>();
    for (const position of slot.reads) {
      if (rows.arrayReads.has(position)) continue;
      const key = rows.elementReads.get(position);
      if (key === undefined) return undefined;
      relocate.add(key);
    }
    const changed = new Set<string>();
    // The members of a `filter` whose row holds another value.
    const rowsChanged = new Set<string>();
    for (const used of slot.suspects) {
      const key = rows.keyOf.get(used) ?? rows.segments?.of.get(used);
      const row = rows.kept?.get(used);
      if (key !== undefined) changed.add(key);
      else if (row !== undefined) rowsChanged.add(row);
      else if (used !== rows.upstream?.name) return undefined;
    }
    // The changes of what the collection is over, and how the element
    // that stands at a position now is found.
    let ops: KeyOp[];
    let keyAt: (index: number) => string | undefined;
    let sourceAt: (index: number, key: string) => Element["source"] | undefined;
    let length: number;
    let seen: () => void;
    const dependencies = [...held.dependencies];
    if (rows.stored !== undefined) {
      const { stored } = rows;
      const located = store.locate(stored.base, true);
      const array = located.value;
      if (
        !Array.isArray(array) ||
        store.addressText(located.named) !== stored.named
      ) return undefined;
      const state = store.keyState(array, stored.fields);
      if (state === undefined || state.formed !== stored.formed) {
        return undefined;
      }
      const since = state.since(stored.seen);
      if (since === undefined) return undefined;
      ops = since;
      length = array.length;
      keyAt = (index) => state.keys[index];
      sourceAt = (index, key) => {
        const member = array[index];
        if (!isLink(member)) return located.named.key(keySegment(key));
        const reads: Position[] = [];
        const { named } = store.locate(
          new Ref(member.$link.doc, member.$link.path),
          true,
          reads,
        );
        for (const read of reads) {
          read.own = true;
          rows.elementReads.set(read, key);
          held.reads.push(read);
          this.#watch(slot, read);
        }
        return named;
      };
      seen = () => {
        stored.seen = state.count;
      };
      for (const key of relocate) {
        const element = table.byKey.get(key);
        if (element === undefined) continue;
        const member = array[element.index];
        if (!isLink(member) || !(element.source instanceof Ref)) {
          return undefined;
        }
        const { named } = store.locate(
          new Ref(member.$link.doc, member.$link.path),
          true,
        );
        if (store.addressText(named) !== store.addressText(element.source)) {
          return undefined;
        }
      }
    } else if (rows.upstream !== undefined) {
      const { upstream } = rows;
      if (relocate.size > 0) return undefined;
      this.#users.get(upstream.name)?.delete(name);
      slot.uses.delete(upstream.name);
      const from = this.assembled(upstream.collection)(context);
      this.uses(name, upstream.name);
      const members = from.members;
      if (members === undefined) return undefined;
      if (from.version === upstream.version) ops = [];
      else if (
        from.version === upstream.version + 1 && from.delta !== undefined
      ) ops = from.delta.ops;
      else return undefined;
      length = members.length;
      keyAt = (index) => members[index]?.key;
      sourceAt = (index) => members[index]?.source;
      const at = dependencies.findIndex(({ on }) => on === upstream.name);
      if (at < 0 || at >= rows.first) return undefined;
      dependencies[at] = { ...dependencies[at], seen: from.changedAt };
      seen = () => {
        upstream.version = from.version ?? 0;
      };
    } else {
      return undefined;
    }
    // A change of the source of a `flatMap`, or of what an element's body
    // returned, forms the assembly whole where the segments are not kept
    // apart (`Rows.segments`). Where they are, the segment of an element
    // that left the source is taken out, and that of an element that
    // entered or changed is formed and put at its place. What is left
    // otherwise is a mark that changes neither, as a write to a document an
    // element refers to at a path that no body of the collection read.
    if (
      rows.construct === "flatMap" && rows.segments === undefined &&
      (ops.length > 0 || changed.size > 0)
    ) return undefined;
    const { elements, byKey } = table;
    const { results, members, flags } = rows;
    // For a `flatMap` whose source changed: the members and the values
    // with the segments of the elements that left taken out, and the
    // splices that took them out.
    let segmentMembers: Element[] | undefined;
    let segmentValues: unknown[] | undefined;
    const segmentOps: KeyOp[] = [];
    const left = new Set<string>();
    let low = elements.length;
    // The positions that hold another element than before: those of
    // the splices where each put in as many members as it removed,
    // and otherwise every position from the first splice on.
    let high = 0;
    // How many positions at the end of the source no splice touched: the
    // same elements in the same order before and after.
    let untouched = elements.length;
    for (const op of ops) {
      const fresh = op.inserted.map((key): Element => ({
        key,
        index: -1,
        source: PENDING,
      }));
      const gone = spliceIn(elements, op.start, op.removed.length, fresh);
      spliceIn(
        results,
        op.start,
        op.removed.length,
        fresh.map(() => undefined),
      );
      if (flags !== undefined) {
        spliceIn(
          flags,
          op.start,
          op.removed.length,
          fresh.map(() => false),
        );
      }
      if (rows.construct === "map") {
        spliceIn(
          members,
          op.start,
          op.removed.length,
          fresh.map(({ key }): Element => ({
            key,
            index: -1,
            source: { entry: this.#perElement(collection, key), at: [] },
          })),
        );
      }
      spliceIn(
        dependencies,
        rows.first + op.start,
        op.removed.length,
        fresh.map((): Dependency => ({ stamp: () => undefined, seen: 0 })),
      );
      if (rows.construct === "flatMap" && rows.segments !== undefined) {
        const { segments } = rows;
        if (!Array.isArray(held.value)) return undefined;
        segmentMembers ??= [...members];
        segmentValues ??= [...held.value];
        // The dependencies on the inner assemblies stand behind those on
        // the elements, in the order of the elements.
        const inner = spliceIn(
          dependencies,
          rows.first + elements.length + op.start,
          op.removed.length,
          fresh.map((): Dependency => ({ stamp: () => undefined, seen: 0 })),
        );
        for (const { on } of inner) {
          if (on === undefined) continue;
          this.#users.get(on)?.delete(name);
          slot.uses.delete(on);
          segments.of.delete(on);
        }
        let start = 0;
        for (let before = 0; before < op.start; before++) {
          start += segments.lengths[before];
        }
        const count = spliceIn(
          segments.lengths,
          op.start,
          op.removed.length,
          fresh.map(() => 0),
        ).reduce((sum, length) => sum + length, 0);
        if (count > 0) {
          const taken = spliceIn(segmentMembers, start, count, []);
          spliceIn(segmentValues, start, count, []);
          segmentOps.push({
            start,
            removed: taken.map(({ key }) => key),
            inserted: [],
          });
        }
      }
      for (const element of gone) {
        byKey.delete(element.key);
        left.add(element.key);
      }
      for (const element of fresh) {
        byKey.set(element.key, element);
        changed.add(element.key);
      }
      low = Math.min(low, op.start);
      high = op.removed.length === op.inserted.length && high >= 0
        ? Math.max(high, op.start + op.inserted.length)
        : -1;
      untouched = Math.min(
        untouched,
        elements.length - op.start - op.inserted.length,
      );
    }
    if (elements.length !== length) return undefined;
    const indexed = this.#indexReaders.size > 0;
    const end = high < 0 ? elements.length : Math.min(high, elements.length);
    for (let index = low; index < end; index++) {
      this.counts.elementsVisited += 1;
      const element = elements[index];
      if (element.source === PENDING) {
        if (keyAt(index) !== element.key) return undefined;
        const source = sourceAt(index, element.key);
        if (source === undefined) return undefined;
        element.source = source;
        left.delete(element.key);
      } else if (element.index !== index && indexed) {
        const under = this.#name("under", collection, around, element.key);
        if (this.#indexReaders.has(under)) {
          this.#moved(collection, around, element.key);
          changed.add(element.key);
        }
      }
      element.index = index;
      if (rows.construct === "map") members[index].index = index;
    }
    for (const key of left) {
      // The assembly no longer uses the entry of a key that left.
      const entry = this.#name("element", collection, around, key);
      this.#users.get(entry)?.delete(name);
      slot.uses.delete(entry);
      rows.keyOf.delete(entry);
      this.#drop(collection, around, key);
    }
    const dirty: string[] = [];
    let flagged = false;
    // The first and the last position of the source whose flag changed.
    let flippedFrom = elements.length;
    let flippedTo = -1;
    for (const key of changed) {
      const element = byKey.get(key);
      if (element === undefined) continue;
      const lazy = this.#perElement(collection, key);
      // The evaluation that this brings about marks the users of the
      // entry, and the assembly is taking what it gives here.
      const used = this.#name("element", collection, around, key);
      this.#users.get(used)?.delete(name);
      slot.uses.delete(used);
      const entry = lazy(context);
      const { index } = element;
      const dependency = dependencies[rows.first + index];
      if (dependency.on !== undefined && dependency.seen !== entry.changedAt) {
        dirty.push(key);
      }
      results[index] = entry.value;
      dependencies[rows.first + index] = {
        stamp: (now) => lazy(now).changedAt,
        seen: entry.changedAt,
        ...(entry.key === undefined ? {} : { on: entry.key }),
      };
      if (entry.key === undefined) return undefined;
      this.uses(name, entry.key);
      rows.keyOf.set(entry.key, key);
      if (flags !== undefined) {
        const result = entry.value;
        if (result !== null && typeof result === "object") return undefined;
        if (flags[index] !== Boolean(result)) {
          flagged = true;
          flippedFrom = Math.min(flippedFrom, index);
          flippedTo = Math.max(flippedTo, index);
        }
        flags[index] = Boolean(result);
      }
    }
    let value = held.value;
    let rowsNow = members;
    let delta: Entry["delta"];
    const moved = ops.length > 0;
    let differs = moved;
    if (rows.index !== undefined) {
      // A collection index: each element that left, entered, moved or has
      // another key leaves the bucket it was in and enters the bucket of
      // its key at its place in the source order, and what looked up
      // either bucket is marked. No other element is looked at.
      const index = rows.index;
      const touched = new Set<string>();
      const leave = (key: string) => {
        const was = index.of.get(key);
        if (was === undefined) return;
        index.of.delete(key);
        const bucket = index.buckets.get(was);
        const at = bucket?.keys.indexOf(key) ?? -1;
        if (bucket !== undefined && at >= 0) {
          bucket.keys.splice(at, 1);
          touched.add(was);
        }
      };
      for (const key of left) leave(key);
      for (const key of changed) {
        const element = byKey.get(key);
        if (element === undefined) continue;
        const result = results[element.index];
        const encoded = encodeIndexKey(this, result);
        const fresh = ops.some((op) => op.inserted.includes(key));
        if (index.of.get(key) === encoded && !fresh) continue;
        leave(key);
        if (encoded === undefined) continue;
        const bucket = index.buckets.get(encoded) ??
          { key: result, keys: [], version: 0 };
        index.buckets.set(encoded, bucket);
        let low = 0;
        let high = bucket.keys.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          const other = byKey.get(bucket.keys[middle])?.index ?? -1;
          if (other < element.index) low = middle + 1;
          else high = middle;
        }
        bucket.keys.splice(low, 0, key);
        index.of.set(key, encoded);
        touched.add(encoded);
      }
      for (const encoded of touched) {
        const bucket = index.buckets.get(encoded);
        if (bucket !== undefined) bucket.version = ++index.serial;
        index.changed.add(encoded);
        this.#markUsers(bucketName(name, encoded));
      }
      this.counts.bucketsChanged += touched.size;
      differs = touched.size > 0;
    } else if (rows.construct === "map") {
      differs ||= dirty.length > 0;
      if (differs) {
        value = [...results];
        delta = { ops, rows: dirty.filter((key) => byKey.has(key)) };
      }
    } else if (rows.construct === "sortBy") {
      // Each element that left is taken out of the order, and each that
      // entered or whose key changed is put at the place of its key, found
      // by binary search: behind the elements with a smaller key and behind
      // those with an equal key that stand before it in the source. No
      // other element is looked at. An element that only moved in the
      // source could have changed places with one of an equal key, so the
      // assembly is then formed whole.
      const { sortKeys } = rows;
      if (sortKeys === undefined || !Array.isArray(held.value)) {
        return undefined;
      }
      const entered = new Set(ops.flatMap(({ inserted }) => inserted));
      if (ops.some(({ removed }) => removed.some((key) => byKey.has(key)))) {
        return undefined;
      }
      rowsNow = [...members];
      const sorted = [...held.value];
      const spliced: KeyOp[] = [];
      // The position of an element in the order, found from the key it
      // was placed by.
      const placeOf = (key: string): number => {
        const placed = sortKeys.get(key);
        let low = 0;
        let high = rowsNow.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          const other = sortKeys.get(rowsNow[middle].key);
          if (compareSortKeys(other, placed) < 0) low = middle + 1;
          else high = middle;
        }
        for (
          let at = low;
          at < rowsNow.length &&
          compareSortKeys(sortKeys.get(rowsNow[at].key), placed) === 0;
          at++
        ) {
          if (rowsNow[at].key === key) return at;
        }
        return rowsNow.findIndex((member) => member.key === key);
      };
      const take = (key: string) => {
        const at = placeOf(key);
        sortKeys.delete(key);
        if (at < 0) return;
        rowsNow.splice(at, 1);
        sorted.splice(at, 1);
        spliced.push({ start: at, removed: [key], inserted: [] });
      };
      for (const key of left) take(key);
      for (const key of changed) {
        const element = byKey.get(key);
        if (element === undefined) continue;
        const now = results[element.index];
        if (!isSortKey(now) || !(element.source instanceof Ref)) {
          return undefined;
        }
        const known = sortKeys.has(key) && !entered.has(key);
        if (known && compareSortKeys(sortKeys.get(key), now) === 0) {
          sortKeys.set(key, now);
          continue;
        }
        if (known) take(key);
        let low = 0;
        let high = rowsNow.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          const other = rowsNow[middle];
          const order = compareSortKeys(sortKeys.get(other.key), now) ||
            (byKey.get(other.key)?.index ?? -1) - element.index;
          if (order < 0) low = middle + 1;
          else high = middle;
        }
        sortKeys.set(key, now);
        rowsNow.splice(low, 0, element);
        sorted.splice(low, 0, element.source);
        spliced.push({ start: low, removed: [], inserted: [key] });
      }
      differs = spliced.length > 0;
      if (differs) {
        let first = rowsNow.length;
        for (const { start } of spliced) first = Math.min(first, start);
        for (let index = first; index < rowsNow.length; index++) {
          if (rowsNow[index].index !== index) {
            rowsNow[index] = { ...rowsNow[index], index };
          }
        }
        rows.members = rowsNow;
        value = sorted;
        delta = { ops: spliced, rows: [] };
      }
    } else if (rows.construct === "last" || rows.construct === "first") {
      // A window: the elements at the positions of the window now, against
      // those it held, as one splice. The work is the count of the window,
      // and no element outside it is looked at. Another count, and an
      // element of the window that is no reference, form the assembly
      // whole.
      const count = rows.window;
      if (count === undefined || !Array.isArray(held.value)) return undefined;
      for (const key of changed) {
        const element = byKey.get(key);
        if (
          element !== undefined &&
          windowCount(results[element.index]) !== count
        ) return undefined;
      }
      const [start, end] = windowOf(rows.construct, elements.length, count);
      const now = elements.slice(start, end);
      const [were, length] = [members.length, now.length];
      let head = 0;
      while (
        head < were && head < length && members[head].key === now[head].key
      ) head += 1;
      let tail = 0;
      while (
        tail < were - head && tail < length - head &&
        members[were - 1 - tail].key === now[length - 1 - tail].key
      ) tail += 1;
      differs = head !== were || head !== length;
      if (differs) {
        if (now.some(({ source }) => !(source instanceof Ref))) {
          return undefined;
        }
        rowsNow = now.map((element, index) => ({ ...element, index }));
        rows.members = rowsNow;
        value = now.map(({ source }) => source);
        delta = {
          ops: [{
            start: head,
            removed: members.slice(head, were - tail).map(({ key }) => key),
            inserted: now.slice(head, length - tail).map(({ key }) => key),
          }],
          rows: [],
        };
      }
    } else if (rows.construct === "flatMap") {
      const { segments } = rows;
      if (changed.size > 0 || segmentOps.length > 0) {
        if (segments === undefined || !Array.isArray(held.value)) {
          return undefined;
        }
        // The segment of each element that entered or changed, in the
        // order of the table, is put in the place of the one it had: one
        // splice of the members and of the values for each. The members
        // behind the first splice are numbered again, and no other work
        // is done for an element whose segment stayed.
        const positions = [...changed].flatMap((key) => {
          const element = byKey.get(key);
          return element === undefined ? [] : [element.index];
        }).sort((a, b) => a - b);
        rowsNow = segmentMembers ?? [...members];
        const flat = segmentValues ?? [...held.value];
        const spliced: KeyOp[] = segmentOps;
        let start = 0;
        let from = 0;
        for (const position of positions) {
          while (from < position) start += segments.lengths[from++];
          const element = elements[position];
          const result = results[position];
          if (!(result instanceof Assembled)) return undefined;
          const lazy = this.#assemblyOf(result);
          const inner = lazy(context);
          if (
            inner.key === undefined || inner.owner !== this ||
            inner.members === undefined || !Array.isArray(inner.value)
          ) return undefined;
          this.counts.segmentsFormed += 1;
          const at = rows.first + elements.length + position;
          const before = dependencies[at]?.on;
          if (before !== undefined && before !== inner.key) {
            this.#users.get(before)?.delete(name);
            slot.uses.delete(before);
            segments.of.delete(before);
          }
          dependencies[at] = {
            stamp: (now) => lazy(now).changedAt,
            seen: inner.changedAt,
            on: inner.key,
          };
          this.uses(name, inner.key);
          segments.of.set(inner.key, element.key);
          const within = new Map([...context, [collection, element]]);
          const fresh = inner.members.map(({ key: part, source }): Element => ({
            key: memberKey(element.key, part),
            index: -1,
            source: segmentSource(source, within),
          }));
          const gone = spliceIn(
            rowsNow,
            start,
            segments.lengths[position],
            fresh,
          );
          spliceIn(flat, start, segments.lengths[position], inner.value);
          spliced.push({
            start,
            removed: gone.map(({ key }) => key),
            inserted: fresh.map(({ key }) => key),
          });
          segments.lengths[position] = fresh.length;
        }
        let first = rowsNow.length;
        for (const { start } of spliced) first = Math.min(first, start);
        for (let index = first; index < rowsNow.length; index++) {
          if (rowsNow[index].index !== index) {
            rowsNow[index] = { ...rowsNow[index], index };
          }
        }
        rows.members = rowsNow;
        value = flat;
        delta = { ops: spliced, rows: [] };
        differs = true;
      } else {
        differs = false;
      }
    } else if (moved || flagged || rowsChanged.size > 0) {
      // A `filter`: its members are the elements of the source whose flag
      // holds, in the order of the source. The positions of the source
      // that a splice put in or whose flag changed are looked at, and no
      // other: the members before the first of them and behind the last
      // are those that stood there, found by binary search over the
      // members by where their elements stand now. A member that is a row
      // of another per-element construct is held as the row's value, which
      // the assembly depends on (`Rows.kept`): a row that holds another
      // value is put at its member's place. Any other element that is no
      // reference forms the assembly whole, as it does for a window.
      if (flags === undefined || !Array.isArray(held.value)) return undefined;
      const count = elements.length;
      const from = Math.min(low, flippedFrom);
      const end = Math.max(
        from,
        count - Math.min(untouched, count - 1 - flippedTo),
      );
      const placeOf = (member: Element) => byKey.get(member.key)?.index;
      // The first member whose element left or stands at `from` or behind.
      let head = 0;
      for (let above = members.length; head < above;) {
        const middle = (head + above) >> 1;
        const place = placeOf(members[middle]);
        if (place !== undefined && place < from) head = middle + 1;
        else above = middle;
      }
      // The first member of the positions behind `end`, which no change
      // touched.
      let behind = head;
      for (let above = members.length; behind < above;) {
        const middle = (behind + above) >> 1;
        const place = placeOf(members[middle]);
        if (place !== undefined && place >= end) above = middle;
        else behind = middle + 1;
      }
      const fresh: Element[] = [];
      const freshValues: unknown[] = [];
      // The dependencies on the rows of the fresh members, where the
      // members are rows.
      const freshRows: Dependency[] = [];
      const { kept } = rows;
      for (let index = from; index < end; index++) {
        this.counts.elementsVisited += 1;
        if (!flags[index]) continue;
        const element = elements[index];
        const { source } = element;
        if (kept !== undefined && isRowSource(source)) {
          const row = this.#rowDependency(source.entry, context);
          if (row === undefined) return undefined;
          freshRows.push(row.dependency);
          freshValues.push(row.value);
        } else if (kept === undefined && source instanceof Ref) {
          freshValues.push(source);
        } else return undefined;
        fresh.push({ ...element, index: head + fresh.length });
      }
      // The members that left or entered, as one splice: what stands
      // before and after it holds the keys it held.
      const were = behind - head;
      this.counts.elementsVisited += were;
      let same = 0;
      while (
        same < were && same < fresh.length &&
        members[head + same].key === fresh[same].key
      ) same += 1;
      let sameEnd = 0;
      while (
        sameEnd < were - same && sameEnd < fresh.length - same &&
        members[behind - 1 - sameEnd].key ===
          fresh[fresh.length - 1 - sameEnd].key
      ) sameEnd += 1;
      differs = same + sameEnd < were || same + sameEnd < fresh.length;
      if (differs) {
        rowsNow = [
          ...members.slice(0, head),
          ...fresh,
          ...members.slice(behind),
        ];
        // The members behind the splice stand at other positions where
        // it put in another number than it took out.
        for (
          let index = fresh.length === were
            ? rowsNow.length
            : head + fresh.length;
          index < rowsNow.length;
          index++
        ) {
          this.counts.elementsVisited += 1;
          rowsNow[index] = { ...rowsNow[index], index };
        }
        rows.members = rowsNow;
        value = [
          ...held.value.slice(0, head),
          ...freshValues,
          ...held.value.slice(behind),
        ];
        delta = {
          ops: [{
            start: head + same,
            removed: members.slice(head + same, behind - sameEnd).map((
              { key },
            ) => key),
            inserted: fresh.slice(same, fresh.length - sameEnd).map((
              { key },
            ) => key),
          }],
          rows: [],
        };
        if (kept !== undefined) {
          // The dependencies on the rows of the members put in take the
          // place of those of the members they replace.
          const base = rows.first + elements.length;
          const gone = spliceIn(dependencies, base + head, were, freshRows);
          for (const { on } of gone) {
            if (on === undefined) continue;
            kept.delete(on);
            this.#users.get(on)?.delete(name);
            slot.uses.delete(on);
          }
          freshRows.forEach(({ on }, offset) => {
            if (on === undefined) return;
            kept.set(on, fresh[offset].key);
            this.uses(name, on);
          });
        }
      }
      // A member whose row holds another value holds that value, at its
      // place, which is found by binary search over the members by where
      // their elements stand.
      const entered = new Set(fresh.map(({ key }) => key));
      const replaced: string[] = [];
      for (const key of rowsChanged) {
        const element = byKey.get(key);
        if (
          kept === undefined || element === undefined || entered.has(key) ||
          !flags[element.index]
        ) continue;
        let at = 0;
        for (let above = rowsNow.length; at < above;) {
          const middle = (at + above) >> 1;
          if ((placeOf(rowsNow[middle]) ?? -1) < element.index) at = middle + 1;
          else above = middle;
        }
        const member = rowsNow[at];
        if (member?.key !== key || !isRowSource(member.source)) {
          return undefined;
        }
        const row = this.#rowDependency(member.source.entry, context);
        if (row === undefined || !Array.isArray(value)) return undefined;
        if (value === held.value) value = [...value];
        (value as unknown[])[at] = row.value;
        dependencies[rows.first + elements.length + at] = row.dependency;
        replaced.push(key);
      }
      if (replaced.length > 0) {
        differs = true;
        delta = { ops: delta?.ops ?? [], rows: replaced };
      }
    } else {
      differs = false;
    }
    if (differs && Array.isArray(value)) {
      assembledElements.set(value, { members: rowsNow, context });
    }
    seen();
    if (differs) store.clock += 1;
    // The count of the changes of the members, which a reader brought up
    // to date from the delta of each (`Rows.upstream`) compares with the
    // count it saw: a pass that changed nothing is none.
    const version = (held.version ?? 0) + (differs ? 1 : 0);
    return {
      ...held,
      value,
      // No canonical text is formed of the rows: the next entry that is
      // formed whole is taken to differ.
      stored: differs ? `\u0000${version}` : held.stored,
      dependencies,
      members: rowsNow,
      version,
      delta,
      evaluatedAt: began,
      changedAt: differs ? store.clock : held.changedAt,
      checkedAt: undefined,
    };
  }

  /**
   * The members of the segment that the callback of a `flatMap` returned
   * for one source element: what the result holds for each, and for each
   * the part of its key that is formed from the member itself, by the
   * rule for any array (ruling Z22). The part is the identity of the cell
   * for a member that is a reference and the value for a member that is
   * a plain value, with the count of the earlier members of the segment
   * with the same identity or value. The position in the segment is in
   * no part.
   *
   * - A segment that is a stored array, which the callback passed on, is
   *   keyed as a stored array is, and a member that is a plain value in
   *   place is named by the array and its key.
   * - A segment that is the assembled result of another per-element
   *   construct has the keys of that result (assumed in PL §8, question
   *   101).
   * - A segment the callback wrote is keyed by what each member is. A
   *   member that is a plain value is read from the callback's result
   *   at the position that holds its key now, so two members that change
   *   places are read as the values they were.
   * - A callback that returns one value yields a segment of one member.
   */
  #segment(
    returned: unknown,
    entry: Lazy,
    inner: Context,
    host: Host,
    resolved?: { value: unknown },
  ): {
    values: unknown[];
    members: { part: string; source: Element["source"] }[];
  } {
    const result = resolved !== undefined
      ? resolved.value
      : Array.isArray(returned)
      ? returned.map((member) => host.settled(member))
      : host.settled(returned);
    if (Array.isArray(returned) && Array.isArray(result)) {
      const assembled = assembledElements.get(returned);
      if (assembled !== undefined) assembledElements.set(result, assembled);
    }
    const read = result !== null && typeof result === "object"
      ? this.addressRead(result, true)
      : undefined;
    const stored = result instanceof Ref ? result : read;
    if (stored !== undefined) {
      const held = this.store.locate(stored, true).value;
      if (Array.isArray(held)) {
        const values = host.v(stored) as unknown[];
        return {
          values: Array.isArray(values) ? values : [],
          members: this.#stored(stored, host).map(({ key, source }) => ({
            part: key,
            source,
          })),
        };
      }
    }
    const assembled = Array.isArray(result)
      ? assembledElements.get(result)
      : undefined;
    if (assembled !== undefined) {
      return {
        values: result as unknown[],
        members: assembled.members.map(({ key, source }) => ({
          part: key,
          source: segmentSource(source, inner),
        })),
      };
    }
    const written = Array.isArray(result) ? result : [result];
    const parts = this.#parts(written);
    return {
      values: host.v(written) as unknown[],
      members: written.map((member, index) => {
        if (member instanceof Ref) {
          return { part: parts[index], source: member };
        }
        const part = parts[index];
        const whole = Array.isArray(result);
        return {
          part,
          source: {
            entry: (context: Context) => {
              const current = entry(context);
              const now = Array.isArray(current.value)
                ? current.value
                : [current.value];
              const position = whole ? this.#parts(now).indexOf(part) : 0;
              return { ...current, value: now[position] };
            },
            at: [],
          },
        };
      }),
    };
  }

  /**
   * The entry of the assembly that a body returned as the handle
   * `assembled`, for the element keys the body was evaluated under.
   */
  #assemblyOf(assembled: Assembled): Lazy {
    const entry = this.assembled(assembled.collection);
    return () => entry(this.freshContext(assembled.context));
  }

  /**
   * The part of the key of each member of an array the instance holds
   * that is formed from the member itself: what a reference names, or the
   * value, with the count of the earlier members with the same part.
   */
  #parts(members: readonly unknown[]): string[] {
    return keysOfParts(members.map((member): ElementPart => {
      if (member instanceof Ref) {
        const { named } = this.store.locate(member, true, undefined, true);
        return this.store.addressOf(named);
      }
      return this.store.partOf(this.stored(member));
    }));
  }

  /**
   * The elements of what a collection iterates, each with its key. An
   * element of the result of another construct has the key that result
   * gives it. Otherwise the key is the identity of the cell where the
   * position holds a link, the value where it holds one, and the count
   * of the earlier positions with the same element part. The position is
   * in no key (PL §1.3).
   */
  #table(collection: number, host: Host): Element[] {
    const { source, keyFields } = this.plan.collections[collection];
    let members: (Ref | { value: unknown })[] = [];
    if (source.slot !== undefined) {
      const slot = this.plan.slots[source.slot];
      host.demand(slot.root, slot.path);
      const base = host.settled(
        host.at(this.rootOf(slot.root, host), slot.path),
      );
      if (source.entries === true) return this.#entries(base, host);
      if (base instanceof Ref) return this.#stored(base, host, keyFields);
      if (Array.isArray(base)) {
        members = base.map((member) =>
          member instanceof Ref ? member : { value: member }
        );
      }
    } else if (source.collection !== undefined) {
      const upstream = host.dependEntry(this.assembled(source.collection));
      if (upstream.members !== undefined) {
        host.from = { collection: source.collection, entry: upstream };
        return upstream.members.map((member, index) => ({ ...member, index }));
      }
      const held = upstream.value;
      members = (Array.isArray(held) ? held : []).map((member) =>
        member instanceof Ref ? member : { value: member }
      );
    } else {
      const held = host.settled(
        source.output !== undefined ? host.output(source.output) : undefined,
      );
      // An output the plan marks as passing a derived collection on
      // unchanged is that collection for keying: its elements have the
      // keys of the collection's elements and the places they came from
      // (PL §1.3). The mark is checked by the identity of the array the
      // cone returned with the one that was assembled.
      const passes = source.output === undefined
        ? undefined
        : this.plan.outputs[source.output].passesCollection;
      if (passes !== undefined) {
        const upstream = host.dependEntry(this.assembled(passes));
        if (upstream.value !== held) {
          throw new Unsupported(
            "an output marked as passing a collection on that holds another array",
          );
        }
        if (upstream.members !== undefined) {
          return upstream.members.map((member, index) => ({
            ...member,
            index,
          }));
        }
      }
      if (held instanceof Ref) return this.#stored(held, host, keyFields);
      // The bucket a `lookup` gave: its members are elements of the
      // index's source, with their keys (`Host.lookup`).
      const bucket = Array.isArray(held) ? bucketElements.get(held) : undefined;
      if (bucket !== undefined) {
        return bucket.map((member, index) => ({ ...member, index }));
      }
      if (source.output !== undefined && Array.isArray(held)) {
        const place = this.#generated(source.output, held, host.context);
        if (place !== undefined) {
          return this.#stored(place, host, keyFields ?? []);
        }
      }
      members = (Array.isArray(held) ? held : []).map((member) =>
        member instanceof Ref ? member : { value: member }
      );
    }
    // A reference is keyed by what it names, and a value by itself:
    // by the declared key fields, where the collection has them, and
    // otherwise by the whole value.
    const keys = keysOfParts(members.map((member): ElementPart => {
      if (member instanceof Ref) {
        const { named } = this.store.locate(member, true);
        return this.store.addressOf(named);
      }
      return this.store.partOf(this.stored(host.v(member.value)), keyFields);
    }));
    return members.map((member, index) => ({
      key: keys[index],
      index,
      source: member,
    }));
  }

  /**
   * The place of a plain array generated from scratch, what the body of
   * a `lift` or a `computed` returned whole for an output: a document
   * that holds the array, so that an element of it has a reference by
   * key with the address of the output as its collection, as an
   * element of an array of plain values in place has (ruling Z53). The
   * document is stored again when the array is another one. None for
   * an output that no function body computes whole. A read that
   * reaches the document through a link stored elsewhere brings the
   * output up to date first, inside an element body as outside one
   * (rulings Z53 and Z56).
   */
  #generated(
    output: number,
    held: readonly unknown[],
    context: Context,
  ): Ref | undefined {
    const record = this.plan.outputs[output];
    if (
      record.path.length > 0 ||
      this.plan.cones[record.cone].bodies.length === 0
    ) {
      return undefined;
    }
    const within = this.collectionsOf(record.cone);
    const keys = within.map((collection) =>
      context.get(collection)?.key ?? "?"
    );
    // A value found to be of a scope after its array was stored is stored
    // in the instances of that scope from then on, as the place of a value
    // moves (`#valuePlace`).
    const base = this.outputDocument(output, keys);
    const named = () => this.#inScope(base, this.#scopeOfOutput(output, keys));
    const id = named();
    this.#documents.add(id);
    const store = (array: readonly unknown[]) => {
      const stored = this.stored(array);
      if (canonical(this.store.docs.get(id)?.value) !== canonical(stored)) {
        this.store.create(id, OUTPUT, stored);
      }
    };
    store(held);
    // The executor evaluates on demand, and a link stored elsewhere is
    // no dependency on the output: the read that reaches the document
    // evaluates the output for the elements that hold the keys now. A
    // value that this evaluation finds to be of a scope narrower than the
    // document's is not stored in it, as every reader of a document of the
    // space reads one value: the document named before is no place of it.
    const value = this.valueOfOutput.get(output);
    if (value !== undefined) {
      this.store.sources.set(id, () => {
        const current = this.#contextOfKeys(within, keys);
        if (current === undefined) return;
        const now = this.evaluated(value)(current).value;
        if (Array.isArray(now) && named() === id) store(now);
      });
    }
    return new Ref(id, []);
  }

  /**
   * The context in which each of `collections`, outermost first, has
   * the element that holds the key of `keys` at its place now, with
   * the element table of each brought up to date. Nothing where a key
   * is in no table: the key left its collection.
   */
  #contextOfKeys(
    collections: readonly number[],
    keys: readonly string[],
  ): Context | undefined {
    const context = new Map<number, Element>();
    for (const [index, collection] of collections.entries()) {
      this.assembled(collection)(context);
      const element = this.#tableOf(collection, context)?.find((member) =>
        member.key === keys[index]
      );
      if (element === undefined) return undefined;
      context.set(collection, element);
    }
    return context;
  }

  /**
   * The elements of a stored array. An element whose position holds a
   * link is the cell the link leads to. An element that is a plain value
   * in place is named by the array and its key, and its `source` is that
   * reference by key (ruling Z12). With `fields`, the key fields that
   * the collection's record holds, the key of a plain value is formed
   * from the fields and names them (rulings Z44 and Z45). Without
   * them, it is formed from the key fields of the array schema that a
   * link on the way to the array holds, and from the whole value where
   * no link holds one (ruling Z52).
   */
  /**
   * The element table of a collection over the entries of a record: one
   * element for each name the record has, in the order the store holds
   * them, keyed by the name. The element is the pair of the name and of
   * what the record holds under it: the reference to the cell where the
   * entry is a link, and the reference to the entry's position otherwise.
   * The read finds which names the record has and reads no entry.
   */
  #entries(record: unknown, host: Host): Element[] {
    const pairs: [string, unknown][] = [];
    if (record instanceof Ref) {
      const located = this.store.locate(record, true, host.reads);
      const held = isRecord(located.value) && !isLink(located.value)
        ? located.value
        : {};
      for (const [name, member] of Object.entries(held)) {
        pairs.push([
          name,
          isLink(member)
            ? new Ref(member.$link.doc, member.$link.path)
            : located.named.key(name),
        ]);
      }
    } else if (isRecord(record)) {
      for (const pair of Object.entries(record)) pairs.push(pair);
    }
    // The key of an entry is that of its name as a plain value: a name
    // stands once in a record.
    const keys = keysOfParts(
      pairs.map(([name]): ElementPart => this.store.partOf(name, undefined)),
    );
    return pairs.map((pair, index) => ({
      key: keys[index],
      index,
      source: { value: pair },
    }));
  }

  #stored(array: Ref, host: Host, fields?: readonly string[]): Element[] {
    const before = host.reads.length;
    const located = this.store.locate(array, true, host.reads);
    const held = Array.isArray(located.value) ? located.value : [];
    const given = fields ?? keyFieldsOf(located.given);
    const keys = this.store.keysOf(held, located.ref, undefined, given);
    const arrayReads = new Set(host.reads.slice(before));
    const elementReads = new Map<Position, string>();
    const elements = held.map((member, index) => {
      const from = host.reads.length;
      const element = {
        key: keys[index],
        index,
        source: isLink(member)
          ? this.store.locate(
            new Ref(member.$link.doc, member.$link.path),
            true,
            host.reads,
          ).named
          : located.named.key(keySegment(keys[index])),
      };
      for (let read = from; read < host.reads.length; read++) {
        // What a member that is a link names is found from the links on
        // the way: a write below the position it names changes nothing
        // of the table.
        if (isLink(member)) host.reads[read].own = true;
        elementReads.set(host.reads[read], keys[index]);
      }
      return element;
    });
    host.found = {
      base: array,
      named: located.named,
      held,
      fields: given,
      arrayReads,
      elementReads,
    };
    return elements;
  }

  /**
   * One wave after another: evaluates every kept output in the order of
   * `Plan.outputs` (ES §2.3), and then the result, and stores the result
   * document. The executor has no reader, so every kept output and the
   * result are what is demanded. A cone with static side-writes is
   * evaluated when something demanded reads its write target or passes
   * it on by reference, before that reader. A cone whose body is a
   * materializer is evaluated after the rest of the wave, where an input
   * of it changed, and what it writes makes its readers stale, which the
   * next wave evaluates (ES §2.3, "A cone with side-writes"). The waves
   * repeat while an evaluation wrote something, at most as often as a
   * cone instance is evaluated in one transaction (ES §2.7).
   */
  settle(): void {
    const { root } = this;
    if (root.#tx !== undefined) {
      this.#settle();
      return;
    }
    root.#cycle(() => this.#settle());
  }

  /**
   * Brings up to date, in one derivation transaction, each instance that a
   * handler made and that has had no derivation yet, and nothing else:
   * what read a document of such an instance stays marked, for `settle()`.
   * Returns whether there was such an instance. Whoever runs the executor
   * calls it before `settle()` where the first derivation of an instance
   * is to be committed before the derivations that read its result, so
   * that those find the labels of the result stored.
   */
  settleMade(): boolean {
    const { root } = this;
    if (root.#awaitingFirst.size === 0) return false;
    root.#within("derivation", () => {
      for (const made of [...root.#awaitingFirst]) made.#settle();
    });
    return true;
  }

  /**
   * On the root: one derivation transaction, and behind it the request
   * transactions of the effects whose request is stale. What a request
   * transaction writes is a change like any other, so a further
   * derivation transaction follows it (SS §6.2). An operation has at
   * most ten request transactions in one call (SS §8.3).
   */
  #cycle(first: () => void): void {
    this.#within("derivation", first);
    for (let round = 0; round < MAX_EVALUATIONS; round++) {
      if (!this.#requestTransactions()) return;
      this.#within("derivation", () => this.#settle());
    }
  }

  /**
   * The evaluation step of a derivation transaction (ES §1.2): it
   * repeats while an evaluation wrote something, to a fixed point that
   * the bound on the evaluations of a cone instance ends (ES §2.7).
   */
  #settle(): void {
    this.root.#awaitingFirst.delete(this);
    const none: Context = new Map();
    const result = this.#result;
    if (result === undefined) return;
    // A write from outside a handler, as through a member bound both
    // ways, is a transaction of its own.
    this.root.#rekey();
    for (let pass = 0;; pass++) {
      this.#due = false;
      this.#dueBelow = false;
      // The bound ends every cycle through a cone instance, so the
      // passes end. A count far past what the bound allows says that
      // something that is no cone instance keeps writing.
      if (pass > 10_000) {
        throw new RangeError("a derivation transaction that does not end");
      }
      const before = this.store.clock;
      // A collection index of the pattern body is brought up to date
      // first: that marks what looked up a bucket that changed, which
      // depends on no other part of the index.
      this.plan.collections.forEach((collection, index) => {
        if (
          buildsIndex(collection.construct) && collection.within.length === 0 &&
          this.#elements.has(index) &&
          this.#memo.has(this.#name("assembly", index, []))
        ) this.assembled(index)(none);
      });
      this.plan.outputs.forEach((output, index) => {
        if (!output.kept || output.path.includes("*")) return;
        const value = this.valueOfOutput.get(index);
        if (output.collection !== undefined) {
          this.assembled(output.collection, true)(none);
        } else if (value !== undefined && this.#values.has(value)) {
          this.evaluated(value)(none);
        }
      });
      // A `navigateTo` of the reactive tier is made in order to act, and
      // is demanded whenever its instance is (SS §6.2).
      this.plan.operations.forEach((operation, index) => {
        if (
          operation.implementation?.builtin === "navigateTo" &&
          (operation.within ?? []).length === 0 &&
          this.#requestFunctions.has(index)
        ) {
          this.#operationState(index)(none);
        }
      });
      const entry = this.#ensure(
        "result",
        none,
        undefined,
        "value",
        (host) => result.evaluate(host),
      );
      // Each marker in the value is stored as the link to its stream,
      // wherever it is: no position is checked (ruling Z43).
      this.#storeResult(entry);
      // After the collections are brought up to date: an entry kept under
      // an element key that left is dropped with it, and is not pulled.
      this.#pullScoped();
      // The instances that function bodies of this one made.
      // An instance of which nothing is marked holds what it held.
      for (const child of this.#children) {
        if (child.#due || child.#dueBelow) child.#settle();
      }
      this.#afterWave = true;
      try {
        for (const materializer of this.#materializers) materializer(none);
      } finally {
        this.#afterWave = false;
      }
      this.#declare(none);
      if (this.store.clock === before) break;
    }
    // An instance with an entry that is compared on every pull, or
    // with a materializer, is visited by every derivation transaction.
    if (this.#alwaysCount > 0 || this.#materializers.length > 0) {
      this.#nowDue();
    }
  }

  /**
   * Writes through the reference the result document holds at a path, as
   * the rendered tree does at an attribute bound both ways, and evaluates
   * what read the position written.
   */
  writeThrough(path: string[], value: unknown): void {
    this.store.write(new Ref(this.id, path), this.stored(value));
    this.settle();
  }

  /**
   * Writes a path of the argument document, as a writer outside the
   * instance does, and evaluates what read it.
   */
  writeArgument(path: string[], value: unknown): void {
    this.store.write(new Ref(this.argument, path), this.stored(value));
    this.settle();
  }

  /**
   * Changes the members of an array of the argument document in place,
   * as a writer outside the instance that appends, inserts or removes
   * does, and evaluates what read it.
   */
  spliceArgument(
    path: string[],
    start: number,
    removed: number,
    members: unknown[],
  ): void {
    this.store.splice(
      new Ref(this.argument, path),
      start,
      removed,
      members.map((member) => this.stored(member)),
    );
    this.settle();
  }

  /** The result, with every link in it followed. */
  result(): unknown {
    return this.store.read(new Ref(this.id, []));
  }

  /**
   * The value of each state cell that exists: what its document holds,
   * or the default of its schema where nothing wrote it.
   */
  stateCells(): {
    cell: number;
    id: string;
    name: Name;
    keys: string[];
    value: unknown;
  }[] {
    return [...this.#cells].map(([id, { cell, keys }]) => ({
      cell,
      id,
      name: this.plan.stateCells[cell].name,
      keys,
      value: this.store.read(new Ref(id, [])),
    }));
  }

  /**
   * Writes a path of a state cell of the pattern's own body, as a writer
   * that holds a handle to the cell does, and evaluates what read it.
   */
  writeState(name: string, path: string[], value: unknown): void {
    const cell = this.plan.stateCells.findIndex((record) =>
      record.name === name &&
      record.within.every((step) => step.element === undefined)
    );
    if (cell < 0) throw new Unsupported(`no state cell named \`${name}\``);
    const ref = this.stateCell(cell, new Host(this, new Map(), undefined));
    this.store.write(ref.key(...path), this.stored(value));
    this.settle();
  }

  /**
   * Where a reader of the stored result finds the link to a stream
   * (ruling Z43, "it reads the stored result"): each position of the
   * result document that holds one, and each position that a link of the
   * result leads to, in the order of the stored value. `path` is the
   * path from the root of the result, through the links on the way.
   * `at` is the position the store recorded the link at
   * (`Store.streams`). `elements` has, for a stream of this instance
   * whose binding is in an element body, the position of the element of
   * each enclosing collection, outermost first, and is absent where a
   * key is in no element table.
   */
  streams(): StreamHeld[] {
    const found: StreamHeld[] = [];
    const open = new Set<string>();
    const walk = (value: unknown, path: string[], at: Ref) => {
      if (isStream(value)) {
        const { binding, keys, instance } = value.$stream;
        const elements = (instance ?? "") === this.#owner
          ? this.#positionsOf(binding, keys)
          : undefined;
        found.push({
          binding,
          keys,
          ...(instance === undefined ? {} : { instance }),
          path,
          at: { doc: at.doc, path: [...at.path] },
          ...(elements === undefined ? {} : { elements }),
        });
      } else if (isLink(value)) {
        const located = this.store.locate(
          new Ref(value.$link.doc, value.$link.path),
          true,
        );
        const id = this.store.addressText(located.ref);
        if (open.has(id)) return;
        open.add(id);
        walk(located.value, path, located.ref);
        open.delete(id);
      } else if (Array.isArray(value)) {
        value.forEach((member, index) =>
          walk(member, [...path, `${index}`], at.key(`${index}`))
        );
      } else if (isRecord(value)) {
        for (const [name, member] of Object.entries(value)) {
          walk(member, [...path, name], at.key(name));
        }
      }
    };
    const result = new Ref(this.id, []);
    walk(this.store.docs.get(result.doc)?.value, [], result);
    return found;
  }

  /**
   * The position, in the element table of each enclosing collection, of
   * the element whose key a stream of a binding has for it, outermost
   * first. Nothing where a key is in no table: the key left its
   * collection.
   */
  #positionsOf(binding: number, keys: readonly string[]): number[] | undefined {
    const record = this.plan.bindings[binding];
    if (record === undefined) return undefined;
    const context = new Map<number, Element>();
    const positions: number[] = [];
    for (const { element } of record.within) {
      if (element === undefined) continue;
      const table = this.#tableOf(element, context) ?? [];
      const position = table.findIndex((member) =>
        member.key === keys[positions.length]
      );
      if (position < 0) return undefined;
      context.set(element, table[position]);
      positions.push(position);
    }
    return positions;
  }

  /** The documents the instance holds, by kind (ES §4.1). */
  documents(): Record<string, number> {
    const kinds: Record<string, number> = {};
    for (const { kind } of this.store.docs.values()) {
      // A constant held for a handle is no document of the instance.
      if (kind === "held constant") continue;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    return kinds;
  }

  // ----- events -----

  /**
   * The requests of effects that left the executor and have no
   * completion yet, in the order they left.
   */
  get outbox(): readonly Outstanding[] {
    return this.root.#outbox;
  }

  readonly #outbox: Outstanding[] = [];

  /**
   * Delivers the completion of a request: the completion transaction of
   * its operation (SS §6.5), which commits by itself. Returns whether it
   * wrote. What reads the result is evaluated by the derivation
   * transaction of the next `settle()` or `batch()`.
   */
  complete(id: number, completion: Completion): boolean {
    const { root, store } = this;
    const at = root.#outbox.findIndex((request) => request.id === id);
    if (at < 0) throw new Error(`no outstanding request ${id}`);
    const [request] = root.#outbox.splice(at, 1);
    const state = new Ref(request.operation, []);
    const held = store.docs.get(request.operation)?.value;
    const operation = root.#operations.get(request.operation);
    const open = root.#begin("completion");
    // A completion writes nothing where its hash is no longer the
    // request that the operation selects, or the instance of the
    // operation is gone (SS §6.5).
    const selected = isRecord(held) && held.requestHash === request.hash &&
      operation !== undefined &&
      (operation.instance === root ||
        root.#instances.has(operation.instance.id));
    if (selected) {
      const outcome = state.key(OUTCOME);
      store.write(outcome.key("result"), this.stored(completion.result));
      store.write(outcome.key("error"), this.stored(completion.error));
      store.write(outcome.key("pending"), false);
    }
    root.#end(open, true);
    return selected;
  }

  /**
   * Answers the outstanding requests from a table, as a test's stand-in
   * for the network: each request the table has a completion for is
   * completed in a transaction of its own, one derivation transaction
   * follows, and the requests that this made are answered in turn.
   * Returns how many requests were answered.
   */
  answer(table: (request: Outstanding) => Completion | undefined): number {
    let answered = 0;
    for (;;) {
      let now = 0;
      for (const request of [...this.root.#outbox]) {
        const completion = table(request);
        if (completion === undefined) continue;
        this.complete(request.id, completion);
        now += 1;
      }
      if (now === 0) return answered;
      answered += now;
      this.root.settle();
    }
  }

  /**
   * Writes the clock that the ticking `wish` targets resolve to, as the
   * runtime does on a tick (BI, `wish`), and evaluates what read it.
   */
  tick(to: number): void {
    if (!this.store.docs.has(CLOCK)) this.store.create(CLOCK, "clock", to);
    else this.store.write(new Ref(CLOCK, []), to);
    this.root.settle();
  }

  /**
   * The transactions of the executor that this instance was started
   * with, in the order they ended.
   */
  get transactions(): readonly Transaction[] {
    return this.root.#transactions;
  }

  readonly #transactions: Transaction[] = [];

  /**
   * Puts an event for the stream of a binding of the reactive tier into
   * the queue and handles nothing (SS §5.1). For a binding of an element
   * body, `positions` gives the position of the element in each
   * enclosing collection, outermost first, and the last element where it
   * gives none. Returns why the event has no stream, where it has none.
   */
  enqueue(
    binding: number,
    event: unknown,
    positions: number[] = [],
  ): string | undefined {
    const record = this.plan.bindings[binding];
    const context = new Map<number, Element>();
    const keys: string[] = [];
    let step = 0;
    for (const { element } of record.within) {
      if (element === undefined) continue;
      const table = this.#tableOf(element, context) ?? [];
      const chosen = table[positions[step] ?? table.length - 1];
      step += 1;
      if (chosen === undefined) return "no element holds the stream";
      context.set(element, chosen);
      keys.push(chosen.key);
    }
    const stream = new StreamRef(binding, keys, this.#owner);
    this.root.#append(stream, event);
    this.root.#queue.push({ stream, event, context });
    return undefined;
  }

  /**
   * Handles the queued events as one batch (SS §5.1): each in a
   * transaction of its own, with the events that their handlers send to
   * streams of the executor, in the order they joined the queue, and one
   * derivation transaction behind them. Returns how each ended.
   */
  batch(): Outcome[] {
    const outcomes: Outcome[] = [];
    this.root.#drain(outcomes);
    this.root.settle();
    this.root.#relabel();
    return outcomes;
  }

  /**
   * On the root: the sets of positions the inputs of the records given to
   * the transaction hooks read, by what each read: for each document, the
   * paths read, each with the sets that read it. A path may hold `*` at the
   * position of an element.
   */
  readonly #recordReaders = new Map<string, RecordReaders>();

  /** On the root: each set of positions in `#recordReaders`, by its name. */
  readonly #readSets = new Map<string, ReadSet>();

  /** On the root: the set of positions each record's inputs read, by key. */
  readonly #readSetOf = new Map<string, ReadSet>();

  /**
   * On the root: the records noted since the sets were last brought up to
   * date (`#flushReads`), each with what names the content of its inputs
   * and where to find them.
   */
  readonly #pendingReads = new Map<string, PendingRead>();

  /**
   * On the root: the sets of positions whose inputs fold over the elements
   * of a collection of an instance, by the instance and the collection.
   */
  readonly #recordFolds = new Map<string, Set<ReadSet>>();

  /**
   * On the root: the records whose inputs read a label that changed while
   * the values did not (`labelsChanged`), and whose labels were not formed
   * again since.
   */
  readonly #relabels = new Set<string>();

  /**
   * On the root: the records given since the transaction in progress, or
   * the last one, began. Their labels were formed from what that
   * transaction stored.
   */
  readonly #givenNow = new Set<string>();

  /** On the root: the transaction hooks are ending a transaction. */
  #ending = false;

  /** On the root: what names the content of the inputs of a record. */
  readonly #digests = new InputsDigests();

  /**
   * On the root: the number `#digests` gave the inputs of the record last
   * given under each key (`#noteRecord`). A record of a place that a
   * comparison left as it was is not given again while its inputs have
   * that number (`#unchangedOutput`).
   */
  readonly #recordDigests = new Map<string, number>();

  /** The key of the record of an output of this instance at a path. */
  #recordKey(output: number, at: readonly string[]): string {
    return JSON.stringify([this.id, output, at]);
  }

  /**
   * On the root: keeps what the inputs of a record given for an output
   * read, in place of what the record given for it before read, so that a
   * change of a label finds the records that read it. Records whose inputs
   * hold equal content share one set of positions, registered once
   * (`ReadSet`), and the sets are brought up to date when they are next
   * asked for (`#flushReads`): a record whose inputs are those it had costs
   * nothing more, and a set whose records all moved to other inputs is
   * changed where the positions differ.
   */
  #noteRecord(key: string, instance: string, write: PlanWrite): void {
    this.counts.recordsNoted += 1;
    this.#givenNow.add(key);
    this.#relabels.delete(key);
    const digest = this.#digests.of(
      this.#inputsTable,
      write.inputs,
      write.keys,
    );
    this.#recordDigests.set(key, digest);
    // A record that names the inputs of another element read its own
    // element's positions, and none of that element's: a change of a label
    // there changes the label of that element's record alone.
    const own = this.#ownReads.get(key);
    this.#ownReads.delete(key);
    const id = own === undefined
      ? `${instance}\n${digest}`
      : `${instance}\nown ${JSON.stringify(own)}`;
    if (this.#readSetOf.get(key)?.id === id) {
      this.#pendingReads.delete(key);
      return;
    }
    this.#pendingReads.set(key, {
      id,
      instance,
      table: this.#inputsTable,
      inputs: write.inputs,
      ...(own === undefined ? {} : { own }),
    });
  }

  /**
   * On the root: brings the sets of positions up to date with the records
   * noted since (`#pendingReads`). The records that take inputs of one
   * content share a set. A set none of whose records keeps its inputs, all
   * of them taking the same new ones, is changed where the positions
   * differ; any other new content gets a set of its own, and a set no
   * record names any more is dropped.
   */
  #flushReads(): void {
    if (this.#pendingReads.size === 0) return;
    const byId = new Map<string, { pending: PendingRead; keys: string[] }>();
    for (const [key, pending] of this.#pendingReads) {
      const group = byId.get(pending.id);
      if (group === undefined) byId.set(pending.id, { pending, keys: [key] });
      else group.keys.push(key);
    }
    this.#pendingReads.clear();
    for (const [id, { pending, keys }] of byId) {
      let set = this.#readSets.get(id);
      if (set === undefined) {
        const read = this.#readsOf(pending);
        // The number of each set's records that take these inputs.
        const moving = new Map<ReadSet, number>();
        for (const key of keys) {
          const old = this.#readSetOf.get(key);
          if (old !== undefined) moving.set(old, (moving.get(old) ?? 0) + 1);
        }
        set = [...moving].find(([old, count]) => old.keys.size === count)?.[0];
        if (set === undefined) {
          set = {
            id,
            positions: new Map(),
            folds: new Set(),
            groups: new Set(),
            keys: new Set(),
          };
          this.#readSets.set(id, set);
        }
        this.#retarget(set, id, read);
      }
      for (const key of keys) {
        const old = this.#readSetOf.get(key);
        if (old === set) continue;
        if (old !== undefined) {
          old.keys.delete(key);
          if (old.keys.size === 0) this.#dropReadSet(old);
        }
        set.keys.add(key);
        this.#readSetOf.set(key, set);
      }
    }
  }

  /**
   * On the root, helper for `#flushReads()`, which gives a set of positions
   * the name `id` and what `read` holds, registering and unregistering it
   * where the positions, the folds and the tables of member groups differ
   * from those it held.
   */
  #retarget(
    set: ReadSet,
    id: string,
    read: Pick<ReadSet, "positions" | "folds" | "groups">,
  ): void {
    if (this.#readSets.get(set.id) === set) this.#readSets.delete(set.id);
    set.id = id;
    this.#readSets.set(id, set);
    for (const [text, address] of set.positions) {
      if (!read.positions.has(text)) this.#readAt(set, address, false);
    }
    for (const [text, address] of read.positions) {
      if (!set.positions.has(text)) this.#readAt(set, address, true);
    }
    set.positions = read.positions;
    for (const fold of set.folds) {
      if (!read.folds.has(fold)) this.#recordFolds.get(fold)?.delete(set);
    }
    for (const fold of read.folds) {
      const held = this.#recordFolds.get(fold) ?? new Set();
      held.add(set);
      this.#recordFolds.set(fold, held);
    }
    set.folds = read.folds;
    for (const groups of set.groups) {
      if (!read.groups.has(groups)) groups.records.delete(set);
    }
    for (const groups of read.groups) groups.records.add(set);
    set.groups = read.groups;
  }

  /** On the root: forgets a set of positions no record names any more. */
  #dropReadSet(set: ReadSet): void {
    this.#retarget(set, set.id, {
      positions: new Map(),
      folds: new Set(),
      groups: new Set(),
    });
    this.#readSets.delete(set.id);
  }

  /**
   * On the root: registers `set` as a reader of the position `address`, or
   * unregisters it where `add` is false.
   */
  #readAt(set: ReadSet, { doc, path }: Address, add: boolean): void {
    this.counts.recordRegistrations += 1;
    const held = this.#recordReaders.get(doc);
    if (held === undefined && !add) return;
    let node: RecordReaders = held ??
      { readers: new Set(), children: new Map() };
    if (held === undefined) this.#recordReaders.set(doc, node);
    for (const segment of path) {
      const child = node.children.get(segment);
      if (child !== undefined) {
        node = child;
        continue;
      }
      if (!add) return;
      const made: RecordReaders = { readers: new Set(), children: new Map() };
      node.children.set(segment, made);
      node = made;
    }
    if (add) node.readers.add(set);
    else node.readers.delete(set);
  }

  /**
   * On the root: what the inputs of a noted record read: each position, by
   * its text, the folds over the elements of a collection it reads the
   * groups of, and the tables of the groups of members of the containers
   * its bindings name.
   */
  #readsOf(
    pending: PendingRead,
  ): Pick<ReadSet, "positions" | "folds" | "groups"> {
    const positions = new Map<string, Address>();
    const folds = new Set<string>();
    const groups = new Set<MemberGroups>();
    const read = (address: Address) => {
      const text = JSON.stringify([address.doc, address.path]);
      if (!positions.has(text)) positions.set(text, address);
    };
    if (pending.own !== undefined) {
      for (const address of pending.own) read(address);
      return { positions, folds, groups };
    }
    const { table, instance } = pending;
    const bindings = (slots: SlotBindings) => {
      for (const at of Object.values(slots)) {
        const binding = table.bindings[at];
        if ("staged" in binding && typeof binding.staged === "object") {
          read(binding.staged);
        }
        if (!("chain" in binding)) continue;
        // A change of the label of a member no chain names changes the
        // label of the record where it makes or empties a group, which the
        // table of the container's groups finds.
        for (const { container } of binding.members ?? []) {
          for (
            const table of this.#memberGroupsAt.get(
              memberGroupsPlace(container.doc, container.path),
            ) ?? []
          ) {
            if (table.observes === binding.observes) groups.add(table);
          }
        }
        for (const address of binding.chain) read(address);
        for (const chain of binding.below ?? []) {
          for (const address of chain) read(address);
        }
      }
    };
    // Each entry of the table once, however many entries name it.
    const visited = new Set<number>();
    const visit = (index: number) => {
      if (visited.has(index)) return;
      visited.add(index);
      const place = table.inputs[index];
      bindings(place.slots);
      for (const addresses of Object.values(place.dynamic ?? {})) {
        for (const address of addresses) read(address);
      }
      for (const chosen of Object.values(place.picks ?? {})) {
        if (chosen !== null) bindings(chosen.slots);
      }
      for (
        const [collection, elements] of Object.entries(place.elements ?? {})
      ) {
        // A `fold` that is given no element reads no group of the
        // collection (`#heldByReference`).
        if ("groups" in elements && elements.groups.length === 0) continue;
        folds.add(`${instance}\n${collection}`);
        if ("uniform" in elements) visit(elements.uniform);
        else for (const group of elements.groups) visit(group.inputs);
      }
      for (const inputs of Object.values(place.outputs ?? {})) visit(inputs);
    };
    visit(pending.inputs);
    return { positions, folds, groups };
  }

  /**
   * On the root: the positions the inputs of the record of `key` read, as
   * the records noted so far have them.
   */
  #readsOfRecord(key: string): Address[] | undefined {
    this.#flushReads();
    const set = this.#readSetOf.get(key);
    return set === undefined ? undefined : [...set.positions.values()];
  }

  /**
   * On the root: the keys of the records whose inputs read a position at,
   * above or below a label entry of `changes`. A `*` in a path a record
   * read stands for every element, and a `*` in a changed path for every
   * position a record read there.
   */
  #recordsReading(changes: readonly LabelChange[]): Set<string> {
    this.#flushReads();
    const sets = new Set<ReadSet>();
    const collect = (node: RecordReaders) => {
      for (const reader of node.readers) sets.add(reader);
      for (const child of node.children.values()) collect(child);
    };
    const walk = (node: RecordReaders, rest: readonly string[]) => {
      if (rest.length === 0) {
        collect(node);
        return;
      }
      for (const reader of node.readers) sets.add(reader);
      const [segment, ...more] = rest;
      if (segment === "*") {
        for (const child of node.children.values()) walk(child, more);
        return;
      }
      for (const name of [segment, "*"]) {
        const child = node.children.get(name);
        if (child !== undefined) walk(child, more);
      }
    };
    for (const { doc, paths } of changes) {
      const root = this.#recordReaders.get(doc);
      if (root === undefined) continue;
      for (const path of paths) walk(root, path);
    }
    const found = new Set<string>();
    for (const set of sets) for (const key of set.keys) found.add(key);
    return found;
  }

  /**
   * On the root: whether a position of the set `read` consumes another
   * label than before `changes`, in a class a slot observes a position in.
   * It does where the store cannot tell (`LabelChange.unchanged`), and at a
   * path that names every element.
   */
  #readsChangedLabel(read: ReadSet, changes: readonly LabelChange[]): boolean {
    for (const { doc, unchanged } of changes) {
      for (const position of read.positions.values()) {
        if (position.doc !== doc) continue;
        if (unchanged === undefined || position.path.includes("*")) return true;
        for (const observes of ["value", "identity", "shape"]) {
          if (!unchanged(position.path, observes)) return true;
        }
      }
    }
    return false;
  }

  /**
   * On the root: where a label changed alone, gives the transaction hooks
   * the record of each output whose inputs read it, in a derivation
   * transaction of its own, as that of a write that leaves the value as it
   * is and forms the label alone again (`PlanWrite.relabel`): the label
   * entries below the output's path stay, and no value code runs. The work
   * is the number of records that read the changed label.
   */
  #relabel(): void {
    const hooks = this.options.transactions;
    if (this.#relabels.size === 0 || hooks?.unchanged === undefined) return;
    const keys = [...this.#relabels];
    this.#relabels.clear();
    this.#within("derivation", () => {
      this.#namedIndex.clear();
      const byInstance = new Map<Instance, PlanWrite[]>();
      for (const key of keys) {
        if (this.#relabelCreated(key)) continue;
        const [id, output, at] = JSON.parse(key) as [string, number, string[]];
        const instance = id === this.id ? this : this.#instances.get(id);
        // An output whose path holds nothing now has no label to form.
        if (
          instance === undefined ||
          this.store.peek(id, at) === undefined
        ) continue;
        const writes = byInstance.get(instance) ?? [];
        writes.push({
          ...instance.#outputRecord(id, output, at),
          relabel: true,
        });
        byInstance.set(instance, writes);
      }
      for (const [instance, writes] of byInstance) {
        hooks.unchanged?.(
          instance.id,
          [],
          this.store,
          undefined,
          writes,
          this.#inputsTable,
        );
      }
    });
  }

  /**
   * On the root, helper for `#relabel()`: where `key` names the rows a
   * body wrote, gives the record of each row again as one that forms the
   * label alone, with the inputs the body last had. Returns whether `key`
   * names such rows.
   */
  #relabelCreated(key: string): boolean {
    const created = this.#createdRows.get(key);
    if (created === undefined) return key.startsWith(`["${CREATED}",`);
    const hooks = this.options.transactions;
    const { instance, body, write, keys, bound, rows } = created;
    const { template } = instance.plan.bodies[body].writes[write];
    const inputs = instance.#inputsFor(template, keys, [bound]);
    const writes: PlanWrite[] = [...rows.values()].flatMap(({ target }) =>
      this.store.docs.has(target.doc)
        ? [{ target, record: { body, write }, ...inputs, relabel: true }]
        : []
    );
    if (writes.length === 0) return true;
    this.#createdStale.delete(key);
    this.#noteRecord(key, instance.id, writes[0]);
    created.labels = instance.#labelsRead(
      this.#readsOfRecord(key) ?? [],
      undefined,
      undefined,
      true,
    );
    hooks?.unchanged?.(
      writes[0].target.doc,
      writes[0].target.path,
      this.store,
      undefined,
      writes,
      this.#inputsTable,
    );
    return true;
  }

  queue(stream: StreamRef, event: unknown): void {
    if (this.root.options.events !== "queue") {
      this.root.#append(stream, event);
    }
    this.root.#queue.push({ stream, event });
  }

  /**
   * Takes the events that handlers sent to streams of the executor and
   * that are not handled yet, each with what the stored form of its
   * stream holds (`options.events: "queue"`).
   */
  takeQueued(): { stream: StreamPosition["stream"]; event: unknown }[] {
    return this.root.#queue.splice(0).map(({ stream, event }) => ({
      stream: {
        binding: stream.binding,
        keys: [...stream.keys],
        ...(stream.instance === "" ? {} : { instance: stream.instance }),
      },
      event,
    }));
  }

  /**
   * Handles one event for a stream, named by what the stored form of the
   * stream holds, in a transaction of its own, and evaluates nothing
   * behind it: whoever runs the executor calls `settle()` (SS §5.1).
   * The event is appended to no stream document and no watermark moves.
   */
  handleEvent(stream: StreamPosition["stream"], event: unknown): Outcome {
    const { root } = this;
    const ref = new StreamRef(
      stream.binding,
      [...stream.keys],
      stream.instance ?? "",
    );
    const target = ref.instance === ""
      ? root
      : root.#instances.get(ref.instance);
    if (target === undefined) {
      return {
        binding: ref.binding,
        committed: false,
        error: "the stream of an instance that does not exist",
      };
    }
    return target.#handle(ref, event, target.#contextOf(ref));
  }

  /**
   * Forms again the labels of the outputs that read a label that changed
   * while no value did, as `batch()` does behind its derivation. Returns
   * whether there was one to form.
   */
  relabel(): boolean {
    const pending = this.root.#relabels.size > 0;
    this.root.#relabel();
    return pending;
  }

  /** Whether `relabel()` has a label to form. */
  get relabelPending(): boolean {
    return this.root.#relabels.size > 0;
  }

  /**
   * On the root: the stream index (ES §4.7): one row per stream whose
   * identifier an evaluation computed, from the identifier to the
   * instance, the binding and the element keys.
   */
  readonly #streamIndex = new Map<
    string,
    { instance: string; binding: number; keys: string[] }
  >();

  /** The rows of the stream index, in the order they were written. */
  streamRows(): { stream: string; binding: number; keys: string[] }[] {
    return [...this.root.#streamIndex].map(([stream, { binding, keys }]) => ({
      stream,
      binding,
      keys,
    }));
  }

  /**
   * The identifier of a stream, which is that of its document (ES §5.2):
   * for a binding of the reactive tier, the hash of the instance, the
   * steps of `within` with the element keys, and the name of the
   * binding; for a binding that a function body made, the hash of what
   * names the binding.
   */
  #streamIdentifier(stream: StreamRef): string {
    const owner = stream.instance === ""
      ? this.root
      : this.root.#instances.get(stream.instance);
    const record = owner?.plan.bindings[stream.binding];
    if (owner === undefined || record === undefined) {
      return identifierOf({ stream: stream.keys[0] ?? "" });
    }
    return owner.#identifier(
      "stream",
      record.within,
      stream.keys,
      record.name ?? { binding: stream.binding },
    );
  }

  /**
   * On the root: appends an event to the document of its stream, which
   * the first event creates (ES §4.7, "The stream document"). The
   * document holds the entries and the watermark and nothing else.
   */
  #append(stream: StreamRef, event: unknown): void {
    // An event sent from outside the executor is the sender's write; an
    // event a handler sends is part of the handler's transaction.
    this.#writeOutside("send", () => {
      const id = this.#streamIdentifier(stream);
      const held = this.store.docs.get(id)?.value as
        | { entries: unknown[] }
        | undefined;
      const entry = { event: this.stored(event) };
      if (held === undefined) {
        this.store.create(id, "stream", {
          entries: [entry],
          eventWatermark: 0,
        });
      } else {
        this.store.write(new Ref(id, ["entries"]), [...held.entries, entry]);
      }
    });
  }

  /**
   * On the root: makes a write, which is part of the transaction in
   * progress where one is, and otherwise one that a store outside the
   * executor commits by itself (`TransactionHooks`).
   */
  #writeOutside(cause: "send" | "watermark", write: () => void): void {
    const hooks = this.#tx === undefined
      ? this.options.transactions
      : undefined;
    if (hooks !== undefined) {
      this.#inputsTable = new InputsTable();
      this.#sharedInputs.clear();
    }
    hooks?.begin(cause);
    this.#outside = hooks !== undefined;
    let committed = false;
    try {
      write();
      committed = true;
    } finally {
      this.#outside = false;
      hooks?.end({ committed, changes: [], store: this.store });
    }
  }

  /** On the root: moves the watermark of a stream past one entry. */
  #passed(stream: StreamRef): void {
    const id = this.#streamIdentifier(stream);
    const held = this.store.docs.get(id)?.value as
      | { eventWatermark: number }
      | undefined;
    if (held === undefined) return;
    this.#writeOutside("watermark", () =>
      this.store.write(
        new Ref(id, ["eventWatermark"]),
        held.eventWatermark + 1,
      ));
  }

  /**
   * Names what the run of a function body in progress makes next: the
   * run, and the ordinal among what it has made (ES §2.8, "Identity").
   * The run of a `lift` or a `computed` is named by the body and the
   * element keys it is evaluated for, so an evaluation that makes the
   * same things again names the same ones. The run of a handler is named
   * by its event, so each event makes its own.
   */
  #next(): { cause: FabricValue; ordinal: number; keyed?: KeyedRun } {
    const running: Running = this.#running ??
      { cause: { parent: this.id }, made: 0 };
    const ordinal = running.made;
    running.made += 1;
    return {
      cause: running.cause,
      ordinal,
      ...(running.keyed === undefined ? {} : { keyed: running.keyed }),
    };
  }

  /**
   * Runs a function body under the cause that names what it makes.
   * `keyed` is the body and the element keys of the run of a `lift` or
   * a `computed`.
   */
  /** The cause of the run of a body under way (`during()`). */
  get runningCause(): FabricValue | undefined {
    return this.#running?.cause;
  }

  /**
   * The memo entry whose evaluation is under way, with its instance, and
   * nothing while a handler body runs or nothing is evaluated: for a
   * built-in that an adapter answers from outside the store, which keeps
   * who used an answer.
   */
  evaluationInProgress(): { instance: Instance; key: string } | undefined {
    const { root } = this;
    const top = root.#evaluating[root.#evaluating.length - 1];
    return top === undefined || top.key === HANDLER ? undefined : top;
  }

  /**
   * Marks the memo entry `key` of this instance as a change of something
   * it read marks it: something it used that the store does not hold is
   * now another, as the answer of a built-in an adapter gave
   * (`evaluationInProgress()`). The entry is evaluated when it is next
   * demanded, and what used it is marked with it.
   */
  markStale(key: string, scoped?: string | ((key: string) => boolean)): void {
    const entry = this.#memo.get(key);
    const of = typeof scoped === "string"
      ? (key: string) => key === scoped
      : scoped;
    // The entry of another scope key than those named is set aside.
    this.#staleAside(key, of);
    if (of !== undefined && entry?.scoped !== undefined && !of(entry.scoped)) {
      return;
    }
    if (entry !== undefined) entry.stale = true;
    const slot = this.#slots.get(key);
    if (slot !== undefined) this.#mark(slot);
  }

  during<T>(cause: FabricValue, run: () => T, keyed?: KeyedRun): T {
    const outer = this.#running;
    this.#running = {
      cause,
      made: 0,
      ...(keyed === undefined ? {} : { keyed }),
    };
    try {
      return run();
    } finally {
      this.#running = outer;
    }
  }

  /**
   * Instantiates a pattern in a function body (ES §2.8): an instance of
   * the callee's plan, with documents of its own in the same store,
   * named from this instance, the run that makes it, and the ordinal.
   * The body gets a handle to the instance's result. The argument is
   * stored as the body wrote it: a handle in it as a link, so a write of
   * the callee through it lands in the caller's cell. A run that names
   * an instance that exists writes its argument and makes nothing. The
   * documents of an instance begin with the name it was made under, and
   * keep it when the instance is re-keyed, so an instance made later
   * under that name gets a name beside it.
   */
  instantiate(id: unknown, argument: unknown): Handle {
    const artifact = typeof id === "string"
      ? this.options.artifacts?.(id)
      : undefined;
    if (artifact === undefined) {
      throw new Unsupported("a pattern called in a function body");
    }
    const { cause, ordinal, keyed } = this.#next();
    const name = identifierOf(cause, { instance: ordinal });
    const given = this.stored(this.returned(argument));
    let child = this.root.#made.get(name)?.instance;
    if (child === undefined) {
      let made = name;
      for (let again = 1; this.root.#instances.has(made); again++) {
        made = identifierOf(cause, { instance: ordinal, again });
      }
      child = new Instance(artifact, given, {
        ...this.options,
        parent: this,
        id: made,
      });
      this.root.#instances.set(made, child);
      this.root.#made.set(name, {
        instance: child,
        ordinal,
        ...(keyed === undefined ? {} : { keyed }),
      });
      this.#children.push(child);
    } else {
      this.store.write(new Ref(child.argument, []), given);
    }
    return new Handle(
      this,
      new Ref(child.id, []),
      undefined,
      undefined,
      [],
    );
  }

  /**
   * Binds a handler in a function body (PL §3.14): a stream of its own,
   * named as an instance a body makes is, with the state the body bound.
   * An event for the stream runs the handler with that state.
   */
  bind(run: (...given: unknown[]) => unknown, state: unknown): StreamRef {
    const { cause, ordinal } = this.#next();
    const key = identifierOf(cause, { bound: ordinal });
    const handed = this.root.#handing.at(-1);
    this.root.#bound.set(key, {
      run,
      state,
      ...(handed === undefined ? {} : { handed }),
    });
    this.#bindings.add(key);
    return new StreamRef(-1, [key], this.#owner);
  }

  // ----- write records -----

  /**
   * Records what an evaluation bound a slot to: the positions that its
   * read went through since `from`, and for an `identity` slot the
   * reference the read gave. The slot of an element of the result of
   * another per-element construct is bound to the upstream element.
   */
  bindSlot(host: Host, index: number, from: number, found: unknown): void {
    if (this.root.options.transactions === undefined) return;
    const slot = this.plan.slots[index];
    if (slot.root.kind === "element") {
      const collection = slot.root.collection ?? -1;
      const element = host.context.get(collection);
      const upstream = this.plan.collections[collection]?.source.collection;
      if (
        element !== undefined && upstream !== undefined &&
        !(element.source instanceof Ref) && "entry" in element.source
      ) {
        // A read of a value through a reference that the upstream element
        // holds went through stored positions, which the label of the
        // upstream output, the label of the reference, does not cover.
        const read = slot.observes === "identity" ? [] : host.reads.slice(from);
        const held = host.bound.get(index);
        const through = held !== undefined && "upstream" in held
          ? held.through
          : undefined;
        if (through !== undefined) {
          for (const position of read) through.at.push(position);
        }
        host.bound.set(index, {
          upstream: {
            collection: upstream,
            keys: [
              ...this.#pairsIn(this.#outerOf(upstream), host.context),
              [upstream, element.key],
            ],
          },
          ...(through !== undefined
            ? { through }
            : read.length === 0
            ? {}
            : { through: { observes: slot.observes, at: read } }),
        });
        return;
      }
    }
    const at: (Position | Ref)[] = host.reads.slice(from);
    if (slot.observes === "identity" && found instanceof Ref) at.push(found);
    // What a `reduce` computed is read from its memo entry, which reads no
    // position: the slot is bound to every position the steps of the
    // `reduce` read, in this transaction or an earlier one, and to those
    // that the entries its steps used read, as the elements of the result
    // of another per-element construct, which are at no stored position.
    const operation = slot.root.kind === "operation"
      ? slot.root.operation ?? -1
      : -1;
    if (
      at.length === 0 && this.#reduces.has(operation) &&
      host.accumulator?.operation !== operation
    ) {
      for (
        const read of this.#readsBehind(this.reduced(operation)(host.context))
      ) {
        at.push(read);
      }
    }
    const held = host.bound.get(index);
    if (held !== undefined && "at" in held) {
      for (const position of at) held.at.push(position);
      return;
    }
    host.bound.set(index, { observes: slot.observes, at });
  }

  /**
   * For `noteNamed()`: the `identity` slot of the plan for the member that
   * a handle names below the cell of its own slot, by that slot and the
   * path below with each position of a member written as `*`; -1 where
   * the plan has none.
   */
  readonly #namedSlots = new Map<string, number>();

  /**
   * The most positions that `noteNamed()` binds one slot to in one
   * evaluation. A body that names more, as one that walks a whole array
   * does, leaves the slot to the position that names every member
   * (`#elementsBound`), which one address covers.
   */
  static readonly #NAMED_MOST = 8;

  /**
   * Records that a body named, through the handle of `slot`, the member at
   * the path `below` of the handle's cell, which is at `named`: the plan's
   * slot for the reference at a member of that cell (its path ends in `*`
   * where the handle's ends) is bound to the position named. A body that
   * takes the cell of a member and does not read it, as
   * `list.key(index).resolveAsCell()` does, makes no read that binds the
   * slot. Without this the slot is bound to the position that names every
   * member, and the label of what the body returned follows the labels of
   * all of them.
   */
  noteNamed(
    host: Host,
    slot: number,
    below: readonly string[],
    named: Ref,
  ): void {
    if (this.root.options.transactions === undefined) return;
    const isMember = (segment: string) =>
      /^(0|[1-9][0-9]*)$/.test(segment) || isKeySegment(segment);
    const text = `${slot}\n${
      below.map((segment) => isMember(segment) ? "*" : JSON.stringify(segment))
        .join("\n")
    }`;
    let found = this.#namedSlots.get(text);
    if (found === undefined) {
      const of = this.plan.slots[slot];
      const path = [...of.path, ...below];
      found = this.plan.slots.findIndex((candidate, index) =>
        index !== slot && candidate.observes === "identity" &&
        candidate.path.includes("*") && sameRoot(candidate.root, of.root) &&
        candidate.path.length === path.length &&
        candidate.path.every((segment, at) =>
          segment === "*" ? isMember(path[at]) : segment === path[at]
        )
      );
      this.#namedSlots.set(text, found);
    }
    if (found < 0 || host.namedMany.has(found)) return;
    const held = host.bound.get(found);
    if (held === undefined) {
      host.bound.set(found, { observes: "identity", at: [named] });
      host.namedOnly.add(found);
      return;
    }
    if (!("at" in held) || !host.namedOnly.has(found)) return;
    if (
      held.at.some((one) =>
        one instanceof Ref && one.doc === named.doc &&
        one.path.length === named.path.length &&
        one.path.every((segment, at) => segment === named.path[at])
      )
    ) return;
    if (held.at.length >= Instance.#NAMED_MOST) {
      host.bound.delete(found);
      host.namedOnly.delete(found);
      host.namedMany.add(found);
      return;
    }
    held.at.push(named);
  }

  /**
   * Runs `run` with no read reported, to the read through a handle in
   * progress or to a store outside the executor: the comparison of two
   * references resolves each to the position it names, which is no read
   * of what the position holds.
   */
  unreported<T>(run: () => T): T {
    const { store } = this;
    const outer = store.reader;
    store.reader = undefined;
    try {
      return this.#quietly(run);
    } finally {
      store.reader = outer;
    }
  }

  /**
   * The positions an entry read, and those the memo entries it used read,
   * each entry once: every stored position its value was computed from.
   */
  #readsBehind(entry: Entry): Position[] {
    const found: Position[] = [];
    const seen = new Set<Entry>();
    const visit = (each: Entry) => {
      if (seen.has(each)) return;
      seen.add(each);
      for (const read of each.reads) found.push(read);
      for (const { on } of each.dependencies) {
        if (on === undefined) continue;
        // The name of an element table stands for its assembly.
        const used = this.#memo.get(
          on.startsWith(TABLE_PREFIX) ? on.slice(TABLE_PREFIX.length) : on,
        );
        if (used !== undefined) visit(used);
      }
    };
    visit(entry);
    return found;
  }

  /**
   * Runs a read through a handle, attributed to the body being run and
   * the entry of its `Body.handles` that is the handle (`Store.reader`).
   * What the read went through is kept, in the host of the body, under
   * the entry of `Plan.dynamicReads` that names the handle.
   */
  readThrough<T>(handle: Handle, run: () => T): T {
    const invoking = this.#invoking.at(-1);
    const body = this.#handling ?? invoking?.body;
    const host = this.#handling === undefined
      ? invoking?.host
      : this.#handlerHost;
    const entry = body === undefined || partsOf(handle).slot === undefined
      ? -1
      : (this.plan.bodies[body].handles ?? []).findIndex((held) =>
        held.handle?.slot === partsOf(handle).slot
      );
    if (body === undefined || entry < 0) return run();
    const { store } = this;
    const outer = store.reader;
    const reader = { by: { body, handle: entry }, seen: [] };
    store.reader = reader;
    try {
      return run();
    } finally {
      store.reader = outer;
      // An enclosing read through a handle went through these too.
      if (outer !== undefined) {
        for (const position of reader.seen) outer.seen.push(position);
      }
      const read = (this.plan.dynamicReads ?? []).findIndex((held) => {
        const why = (held as { why?: { kind?: string } & ReadThrough }).why;
        return why?.kind === "handle" && why.body === body &&
          why.handle === entry;
      });
      if (read >= 0 && host !== undefined) {
        const seen = host.dynamic.get(read) ?? [];
        for (const position of reader.seen) seen.push(position);
        host.dynamic.set(read, seen);
      }
    }
  }

  /**
   * Runs a sandboxed body of a cone, so that a write it makes through a
   * handle is recorded under the body's write edge (`written`).
   */
  runBody<T>(body: number, host: Host, run: () => T): T {
    this.#invoking.push({ body, host });
    let returned = false;
    try {
      const value = run();
      returned = true;
      return value;
    } finally {
      this.#invoking.pop();
      const written = this.#createdWrites.get(host);
      this.#createdWrites.delete(host);
      if (returned && written !== undefined) {
        this.#recordCreated(body, host, written);
      }
    }
  }

  /** The documents that the bodies of this instance made as cells. */
  readonly #createdCells = new Set<string>();

  /**
   * The positions of cells it made that the body being run with a host
   * wrote, each once, in the order of the first write, with the write
   * edge of the body that covers them (`#noteCreatedWrite`).
   */
  readonly #createdWrites = new Map<
    Host,
    { write: number; targets: Map<string, Address> }
  >();

  /**
   * Notes a write through `handle` by the body of a cone being run, where
   * the handle is to a cell that a body of this instance made and the
   * body has write edges for the cells of one call site: the record of
   * the write is given when the body has returned (`#recordCreated`). A
   * body whose edges name several call sites gives no record, since the
   * executor does not know which site made a cell, and the runtime gives
   * the path the label of a write it has no record of.
   */
  #noteCreatedWrite(handle: Handle): void {
    const invoking = this.#invoking.at(-1);
    if (
      this.#handling !== undefined || invoking === undefined ||
      !(targetOf(handle) instanceof Ref) ||
      !this.#createdCells.has((targetOf(handle) as Ref).doc)
    ) return;
    const { writes } = this.plan.bodies[invoking.body];
    const calls = new Set<number>();
    let found = -1;
    writes.forEach(({ target }, index) => {
      if (target.kind !== "created") return;
      calls.add((target as { call?: number }).call ?? -1);
      if (found < 0) found = index;
    });
    if (found < 0 || calls.size !== 1) return;
    const { doc, path } = targetOf(handle) as Ref;
    const held = this.#createdWrites.get(invoking.host) ??
      { write: found, targets: new Map<string, Address>() };
    this.#createdWrites.set(invoking.host, held);
    held.targets.set(canonical([doc, path]), { doc, path: [...path] });
  }

  /**
   * Gives the records of the cells that `body` made and wrote while it
   * ran with `host`: each written position has the record of the body's
   * write edge for a cell it makes, whose template is instantiated with
   * what the body was bound to and read, once for all of them. So a
   * document a `lift` writes for a row of its result takes the label of
   * what that `lift` read, and not the join of what the transaction read.
   * The records are given as those of a write that left the value as it
   * was (`TransactionHooks.unchanged`): the write itself was reported when
   * it was made, and the record gives the path its label either way. A row
   * that holds what it held when the body last ran, under the labels the
   * body had read then, is given no record: it has the one it was given.
   */
  #recordCreated(
    body: number,
    host: Host,
    written: { write: number; targets: Map<string, Address> },
  ): void {
    const { root } = this;
    const hooks = root.options.transactions;
    if (root.#tx === undefined || hooks?.unchanged === undefined) return;
    const { template } = this.plan.bodies[body].writes[written.write];
    if (template === undefined) return;
    root.#namedIndex.clear();
    const keys = this.contextKeys(host.context);
    const bound: Inputs = {
      slots: host.bound,
      selections: host.selections,
      picks: host.picks,
      dynamic: host.dynamic,
    };
    const inputs = this.#inputsFor(template, keys, [bound]);
    const targets = [...written.targets].filter(([, target]) =>
      this.store.docs.has(target.doc)
    );
    if (targets.length === 0) return;
    const record = { body, write: written.write };
    const key = JSON.stringify([CREATED, this.id, body, written.write, keys]);
    const before = root.#createdRows.get(key);
    const relabeling = root.#relabels.has(key);
    const stale = root.#createdStale.delete(key) || relabeling;
    const readBefore = root.#readsOfRecord(key);
    // The rows are readers of the labels of what the body read, as the
    // record of an output is.
    root.#noteRecord(key, this.id, {
      target: targets[0][1],
      record,
      ...inputs,
    });
    const read = root.#readsOfRecord(key) ?? [];
    const labels = this.#labelsRead(read, readBefore, before?.labels, stale);
    // Every row has the label of everything the body read. Where that is
    // the label the rows were last given, a row that holds what it held
    // then has its record.
    const kept = before !== undefined && labels !== undefined &&
      before.labels !== undefined && labels.size === before.labels.size &&
      [...labels].every((label) => before.labels!.has(label));
    const rows = new Map<string, { target: Address; held: string }>();
    const writes: PlanWrite[] = [];
    for (const [text, target] of targets) {
      const held = canonical(this.store.peek(target.doc, target.path));
      rows.set(text, { target, held });
      if (kept && before.rows.get(text)?.held === held) continue;
      writes.push({ target, record, ...inputs });
    }
    root.#createdRows.set(key, {
      instance: this,
      body,
      write: written.write,
      keys,
      bound,
      rows,
      labels,
    });
    if (writes.length === 0) return;
    const [{ target }] = writes;
    hooks.unchanged(
      target.doc,
      target.path,
      this.store,
      undefined,
      writes,
      root.#inputsTable,
    );
  }

  /**
   * The identifiers of the labels at the positions `read`, in each class a
   * slot observes a position in, or nothing where the store names none for
   * one of them. Where the positions `before` were read under the labels
   * `known`, no label changed since (`stale`) and no position left, the
   * positions that entered are asked alone: where their labels are among
   * `known`, the set is `known`.
   */
  #labelsRead(
    read: readonly Address[],
    before: readonly Address[] | undefined,
    known: ReadonlySet<string> | undefined,
    stale: boolean,
  ): Set<string> | undefined {
    const hooks = this.root.options.transactions;
    const labelsOf = (positions: readonly Address[]) => {
      const labels = new Set<string>();
      for (const { doc, path } of positions) {
        for (const observes of ["value", "identity", "shape"]) {
          const label = hooks?.labelOf?.(doc, path, observes);
          if (label === undefined) return undefined;
          labels.add(`${observes}:${label}`);
        }
      }
      return labels;
    };
    if (before === undefined) return labelsOf(read);
    const text = ({ doc, path }: Address) => positionText(doc, path);
    const was = new Set(before.map(text));
    // A position that entered is the one most likely to have no identifier,
    // as one the transaction in progress wrote has none: these are asked
    // first, and nothing else where one of them has none.
    const entered = labelsOf(
      read.filter((position) => !was.has(text(position))),
    );
    if (entered === undefined) return undefined;
    if (known !== undefined && !stale) {
      const now = new Set(read.map(text));
      if (
        before.every((position) => now.has(text(position))) &&
        [...entered].every((label) => known.has(label))
      ) return new Set(known);
    }
    return labelsOf(read);
  }

  /**
   * On the root: what the body of a cone instance last gave the rows it
   * wrote, by the key of its records (`#recordCreated`): what forms their
   * inputs again, each row with the text of what it held, and the labels
   * the body had read (`#labelsRead`).
   */
  readonly #createdRows = new Map<string, {
    instance: Instance;
    body: number;
    write: number;
    keys: [number, string][];
    bound: Inputs;
    rows: Map<string, { target: Address; held: string }>;
    labels: Set<string> | undefined;
  }>();

  /**
   * On the root: the keys of `#createdRows` whose body read a label that
   * changed since it last ran.
   */
  readonly #createdStale = new Set<string>();

  /**
   * On the root: the table the write records of the transaction in
   * progress name their inputs in.
   */
  #inputsTable = new InputsTable();
  /**
   * On the root: the index in `#inputsTable` of the inputs of each cone instance
   * of an output formed for the records being given, by the instance, the
   * output and the element keys. It holds what was formed since the records
   * of one change, or of one write that left a value as it was, began to be
   * formed: nothing is evaluated or written in between, so the inputs of a
   * cone instance are formed once for every record and every other set of
   * inputs that names them.
   */
  readonly #namedIndex = new Map<string, number>();
  /**
   * On the root: the index in `#inputsTable` of the inputs the first record
   * of the transaction with a given key was given (`#shareKey`), which the
   * records of the other elements with that key name too: N elements whose
   * inputs hold equal labels are given one set of inputs, and so are one
   * record for the runtime. `-1` for inputs no other record names.
   */
  readonly #sharedInputs = new Map<string, number>();
  /**
   * On the root: the stored positions that the element of a record read,
   * for a record that names the inputs of another element, by the record's
   * key. `#noteRecord` keeps them, so that a change of a label at one of
   * them finds the record.
   */
  readonly #ownReads = new Map<string, Address[]>();
  /** What `#shareKey` needs of each output's template, by the output. */
  readonly #shareShapes = new Map<
    number,
    { reached: Reached; shareable: boolean; identity: boolean }
  >();

  /** The bodies of cones being run, innermost last, each with its host. */
  readonly #invoking: { body: number; host: Host }[] = [];
  /** The host of the handler being run, which bound its slots. */
  #handlerHost: Host | undefined;
  /** On the root: the records the writes being made belong to. */
  #writing: Writing | undefined;
  /** The bindings each cone instance last made, by its name. */
  readonly #inputs = new Map<string, ConeInputs>();
  /** The groups of the elements of each assembly a `fold` names. */
  readonly #groups = new Map<string, Groups>();
  /** The collections that a `fold` of some template names. */
  #foldedCollections: Set<number> | undefined;
  /** The cones of the element body of each collection. */
  readonly #elementConesOf = new Map<number, number[]>();
  /** The folded collections directly inside each collection. */
  readonly #innerFoldsOf = new Map<number, number[]>();
  /** The elements of a `fold` that read positions, by document and path. */
  readonly #labelReaders = new Map<string, LabelReaders>();
  /**
   * The element each reader in `#labelReaders` stands for, by the name of
   * its assembly and its key, with the positions its group read.
   */
  readonly #readerOf = new Map<
    string,
    {
      collection: number;
      around: readonly string[];
      key: string;
      positions: readonly Address[];
    }
  >();

  /**
   * The records of the write edges of a cone that `matches` selects, each
   * with its target at `base` below the document given.
   */
  #coneWrites(
    cone: number | undefined,
    host: Host,
    doc: string,
    base: readonly string[],
    matches: (
      target: NonNullable<Plan["cones"][number]["writes"]>[number]["target"],
    ) => boolean,
  ): Writing | undefined {
    if (cone === undefined) return undefined;
    const records = (this.plan.cones[cone].writes ?? []).flatMap((
      { target, template },
      write,
    ) =>
      matches(target)
        ? [{
          record: { cone, write },
          template,
          doc,
          path: [...base, ...target.path ?? []],
        }]
        : []
    );
    return records.length === 0 ? undefined : { instance: this, host, records };
  }

  /**
   * On the root: makes the records of the writes being made those given,
   * and returns what puts back the records there were before.
   */
  #recording(writing: Writing | undefined): () => void {
    const { root } = this;
    const before = root.#writing;
    root.#writing = writing;
    return () => {
      root.#writing = before;
    };
  }

  /** The element key of each of `collections` in a context, as pairs. */
  #pairsIn(
    collections: readonly number[],
    context: Context,
  ): [number, string][] {
    return collections.map((collection) => [
      collection,
      context.get(collection)?.key ?? "?",
    ]);
  }

  /** The name of a cone instance, by the cone and its element keys. */
  #coneInstance(cone: number, keys: readonly string[]): string {
    return `${cone}\n${textOf(keys)}`;
  }

  /** The keys of `pairs` for the collections a cone is within. */
  #keysFor(cone: number, pairs: readonly [number, string][]): string[] {
    const byCollection = new Map(pairs);
    return this.collectionsOf(cone).map((collection) =>
      byCollection.get(collection) ?? "?"
    );
  }

  /** The collections that a `fold` node of the plan names. */
  #folded(): Set<number> {
    if (this.#foldedCollections !== undefined) return this.#foldedCollections;
    const found = new Set<number>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const member of value) walk(member);
      } else if (typeof value === "object" && value !== null) {
        const node = value as Record<string, unknown>;
        if (node.op === "fold" && typeof node.collection === "number") {
          found.add(node.collection);
        }
        for (const member of Object.values(node)) walk(member);
      }
    };
    walk(this.plan);
    this.#foldedCollections = found;
    return found;
  }

  /** The cones whose innermost `element` step is a collection. */
  #elementCones(collection: number): number[] {
    let cones = this.#elementConesOf.get(collection);
    if (cones === undefined) {
      cones = this.plan.cones.flatMap((_, cone) =>
        this.collectionsOf(cone).at(-1) === collection ? [cone] : []
      );
      this.#elementConesOf.set(collection, cones);
    }
    return cones;
  }

  /**
   * Keeps what an evaluation of a cone instance bound its slots to, and
   * for the cone of the element body of a collection that a `fold` names,
   * updates the group of the element.
   */
  #noteInputs(cone: number, context: Context, host: Host): void {
    const within = this.collectionsOf(cone);
    const name = this.#coneInstance(cone, this.#keysIn(within, context));
    const held: ConeInputs = this.#inputs.get(name) ?? {
      slots: new Map(),
      selections: new Map(),
      picks: new Map(),
      dynamic: new Map(),
    };
    for (const [at, read] of host.dynamic) held.dynamic.set(at, read);
    for (const [slot, bound] of host.bound) held.slots.set(slot, bound);
    for (const [at, branch] of host.selections) held.selections.set(at, branch);
    for (const [at, key] of host.picks) held.picks.set(at, key);
    delete held.id;
    delete held.positions;
    this.#inputs.set(name, held);
    const collection = within.at(-1);
    if (collection !== undefined && this.#folded().has(collection)) {
      this.#regroup(collection, context);
    }
  }

  /** The bindings a cone instance last made. */
  /**
   * What another cone instance bound a slot to, for the element keys
   * given: a slot names a position whichever cone reads it, and a template
   * that holds a copy of another cone's, as the output of a pattern
   * compiled in that passes its interim output on does, reaches slots its
   * own cone did not read.
   */
  #otherConeBound(
    slot: number,
    keys: readonly [number, string][],
  ): Bound | undefined {
    for (const [cone, record] of this.plan.cones.entries()) {
      if (!(record as { slots?: number[] }).slots?.includes(slot)) continue;
      const bound = this.#inputsOf(cone, this.#keysFor(cone, keys))?.slots
        .get(slot);
      if (bound !== undefined) return bound;
    }
    return undefined;
  }

  #inputsOf(cone: number, keys: readonly string[]): ConeInputs | undefined {
    return this.#inputs.get(this.#coneInstance(cone, keys));
  }

  /**
   * The identifier of what a cone instance's bindings consumed: the label
   * identifier of each position each slot was bound to, and for the slot
   * of an upstream element the identifier of that element's cone
   * instances. Equal identifiers stand for equal inputs of a template.
   */
  #idOf(inputs: ConeInputs): string {
    if (inputs.id !== undefined) return inputs.id;
    const parts: string[] = [];
    const positions: Address[] = [];
    const slots = [...inputs.slots].sort(([a], [b]) => a - b);
    for (const [slot, bound] of slots) {
      if ("constant" in bound) {
        parts.push(`${slot}:constant`);
        continue;
      }
      if ("output" in bound) {
        const { cone } = this.plan.outputs[bound.output];
        const upstream = this.#inputsOf(cone, this.#keysFor(cone, []));
        if (upstream !== undefined) {
          for (const at of upstream.positions ?? []) positions.push(at);
        }
        parts.push(
          `${slot}>${bound.output}<${
            upstream === undefined ? "" : this.#idOf(upstream)
          }>`,
        );
        continue;
      }
      if ("place" in bound) {
        // The state of a handler's binding: no cone instance binds one.
        parts.push(
          `${slot}@${bound.place.slot}/${bound.place.rest.join("/")}`,
        );
        continue;
      }
      if ("upstream" in bound) {
        const { collection, keys } = bound.upstream;
        const ids = this.#elementCones(collection).map((cone) => {
          const upstream = this.#inputsOf(cone, this.#keysFor(cone, keys));
          if (upstream === undefined) return "";
          const id = this.#idOf(upstream);
          for (const at of upstream.positions ?? []) positions.push(at);
          return id;
        });
        const through = bound.through === undefined
          ? []
          : this.#addressesOf(bound.through.at);
        for (const at of through) positions.push(at);
        const read = through.map((address) =>
          this.#labelKey(address, bound.through?.observes ?? "value") ??
            JSON.stringify([address.doc, address.path])
        );
        parts.push(
          `${slot}<${ids.join("|")}>${
            read.length === 0 ? "" : `@${[...new Set(read)].join(",")}`
          }`,
        );
        continue;
      }
      const addresses = this.#addressesOf(bound.at);
      for (const at of addresses) positions.push(at);
      const labels = addresses.map((address) =>
        this.#labelKey(address, bound.observes) ??
          JSON.stringify([address.doc, address.path])
      );
      parts.push(`${slot}:${bound.observes}:${[...new Set(labels)].join(",")}`);
    }
    for (
      const [selector, branch] of [...inputs.selections].sort(([a], [b]) =>
        a - b
      )
    ) {
      parts.push(`s${selector}=${branch}`);
    }
    for (const [pick, key] of [...inputs.picks].sort(([a], [b]) => a - b)) {
      parts.push(`p${pick}=${JSON.stringify(key)}`);
    }
    inputs.id = parts.join(";");
    inputs.positions = positions;
    return inputs.id;
  }

  /**
   * Forgets the identifier of what a cone instance's bindings consumed, and
   * of what the upstream elements its slots read consumed, so that the
   * next `#idOf` asks for the labels again.
   */
  #forget(inputs: ConeInputs): void {
    delete inputs.id;
    delete inputs.positions;
    for (const bound of inputs.slots.values()) {
      if (!("upstream" in bound)) continue;
      const { collection, keys } = bound.upstream;
      for (const cone of this.#elementCones(collection)) {
        const upstream = this.#inputsOf(cone, this.#keysFor(cone, keys));
        if (upstream !== undefined) this.#forget(upstream);
      }
    }
  }

  /**
   * On the root: the labels of documents changed (`watchLabels`). Updates
   * the group of each element of a `fold`, in this instance and in every
   * instance it made, that read a position at, above or below a label
   * entry that changed. The work is the number of those elements and the
   * length of the paths, and not the number of elements. `stored` says
   * that the changes are what the last transaction stored, where the
   * store reports them after that transaction ended.
   *
   * The label of each record that read a changed label is formed again
   * (`#relabel`) unless the record is given again first. Whether values
   * changed with the labels (`_alone`) does not decide that: a change of a
   * value runs the cones that read the value, and a record that read the
   * label through another position is not among them.
   */
  labelsChanged(
    changes: readonly LabelChange[],
    _alone = false,
    stored = false,
  ): void {
    this.#evaluateStoredReaders(changes.map(({ doc }) => doc));
    // The folds and the tables of member groups below name the sets of
    // positions as the records noted so far have them.
    this.#flushReads();
    const regrouped = new Set<string>();
    for (const instance of new Set([this, ...this.#instances.values()])) {
      for (const key of instance.#regroupReaders(changes)) regrouped.add(key);
    }
    // The records whose bindings name a container with a group that the
    // change made or emptied.
    for (const key of this.#memberLabelsChanged(changes)) regrouped.add(key);
    const reading = this.#recordsReading(changes);
    // A record whose own positions consume the labels they consumed before
    // has the label it was given.
    // The records that share a set of positions share the answer.
    const answered = new Map<ReadSet, boolean>();
    for (const key of [...reading]) {
      const set = this.#readSetOf.get(key);
      if (set === undefined) {
        reading.delete(key);
        continue;
      }
      let reads = answered.get(set);
      if (reads === undefined) {
        reads = this.#readsChangedLabel(set, changes);
        answered.set(set, reads);
      }
      if (!reads) reading.delete(key);
    }
    // The rows a body wrote are given their record again when the body
    // next runs, whatever they hold.
    for (const key of reading) {
      if (
        this.#createdRows.has(key) &&
        !((this.#ending || stored) && this.#givenNow.has(key))
      ) this.#createdStale.add(key);
    }
    // The label of a record that read a changed label, or that folds over
    // a collection with an element that did, is formed again behind the
    // batch in progress, or the next one (`#relabel`), unless the record is
    // given again before: a change that came with a change of values
    // (`alone` not set) runs again the cones that read those values, and
    // leaves a record that read the label alone as it was.
    for (const key of [...regrouped, ...reading]) {
      // A record given in the transaction that stored the label holds it.
      if (!((this.#ending || stored) && this.#givenNow.has(key))) {
        this.#relabels.add(key);
      }
    }
  }

  /**
   * Helper for `labelsChanged()`, for the folds of this instance. Returns
   * the keys of the records whose template folds over a collection with an
   * element it regrouped.
   */
  #regroupReaders(changes: readonly LabelChange[]): Set<string> {
    const regrouped = new Set<string>();
    const readers = new Set<string>();
    const collect = (node: LabelReaders) => {
      for (const reader of node.readers) readers.add(reader);
      for (const child of node.children.values()) collect(child);
    };
    for (const { doc, paths } of changes) {
      const root = this.#labelReaders.get(doc);
      if (root === undefined) continue;
      for (const path of paths) {
        let node: LabelReaders | undefined = root;
        for (const segment of path) {
          for (const reader of node.readers) readers.add(reader);
          if (segment === "*") break;
          node = node.children.get(segment);
          if (node === undefined) break;
        }
        if (node !== undefined) collect(node);
      }
    }
    for (const reader of readers) {
      const at = this.#readerOf.get(reader);
      if (at === undefined) continue;
      const keys = [...at.around, at.key];
      for (const cone of this.#elementCones(at.collection)) {
        const inputs = this.#inputsOf(cone, keys);
        if (inputs !== undefined) this.#forget(inputs);
      }
      // The records whose template folds over the collection hold its
      // groups. An element whose cone instances consume what they consumed
      // before is in the group it was in, and those records hold the
      // label they were given.
      if (!this.#regroupKey(at.collection, at.around, at.key)) continue;
      for (
        const set of this.root.#recordFolds.get(
          `${this.id}\n${at.collection}`,
        ) ?? []
      ) {
        for (const key of set.keys) regrouped.add(key);
      }
    }
    return regrouped;
  }

  /**
   * Keeps the positions the group of an element read in the index of
   * label readers, in place of those it read before; none removes it.
   */
  #indexReader(
    reader: string,
    at: { collection: number; around: readonly string[]; key: string },
    positions: readonly Address[] | undefined,
  ): void {
    const before = this.#readerOf.get(reader);
    for (const { doc, path } of before?.positions ?? []) {
      let node = this.#labelReaders.get(doc);
      for (const segment of path) node = node?.children.get(segment);
      node?.readers.delete(reader);
    }
    if (positions === undefined) {
      this.#readerOf.delete(reader);
      return;
    }
    this.#readerOf.set(reader, { ...at, positions });
    for (const { doc, path } of positions) {
      let node = this.#labelReaders.get(doc);
      if (node === undefined) {
        node = { readers: new Set(), children: new Map() };
        this.#labelReaders.set(doc, node);
      }
      for (const segment of path) {
        let child: LabelReaders | undefined = node.children.get(segment);
        if (child === undefined) {
          child = { readers: new Set(), children: new Map() };
          node.children.set(segment, child);
        }
        node = child;
      }
      node.readers.add(reader);
    }
  }

  /**
   * Updates the group of the element of `collection` that a context
   * binds, after its cone instance was evaluated: one update, whatever the
   * number of elements.
   */
  #regroup(collection: number, context: Context): void {
    const element = context.get(collection);
    if (element === undefined) return;
    const inPlace = element.source instanceof Ref &&
      element.source.path.some(isKeySegment);
    this.#regroupKey(
      collection,
      this.#keysIn(this.#outerOf(collection), context),
      element.key,
      inPlace,
    );
  }

  /**
   * Updates the group of the element of `collection` under `key`, in the
   * assembly of the keys `around` it. The group is that of the
   * identifiers of what the element's cone instances consumed and of the
   * set of groups of each folded collection inside it, so two elements
   * whose inner folds differ are in two groups. `inPlace` says whether
   * the element is a plain value in place, where it is known. Where the
   * set of groups changes, the element of the enclosing collection that
   * holds this one is updated in turn. The work is the number of groups
   * of the folded collections inside the element. Returns whether the
   * element is in another group than before.
   */
  #regroupKey(
    collection: number,
    around: readonly string[],
    key: string,
    inPlace?: boolean,
  ): boolean {
    const name = this.#name("assembly", collection, around);
    let table = this.#groups.get(name);
    if (table === undefined) {
      table = { byKey: new Map(), groups: new Map(), notInPlace: new Set() };
      this.#groups.set(name, table);
    }
    const keys = [...around, key];
    const positions: Address[] = [];
    const own = this.#elementCones(collection).map((cone) => {
      const inputs = this.#inputsOf(cone, keys);
      if (inputs === undefined) return "";
      const id = this.#idOf(inputs);
      for (const at of inputs.positions ?? []) positions.push(at);
      return id;
    });
    this.#indexReader(
      `${name}\n${key}`,
      { collection, around, key },
      positions,
    );
    const inner = this.#innerFolds(collection).map((folded) => {
      const ids = [
        ...this.#groups.get(this.#name("assembly", folded, keys))?.groups
          .keys() ?? [],
      ].sort();
      return `f${folded}<${ids.join("|")}>`;
    });
    const id = [...own, ...inner].join("|");
    this.counts.groupUpdates += 1;
    const was = table.byKey.get(key);
    let changed = false;
    if (was !== id) {
      const notInPlace = table.notInPlace.has(key);
      if (was !== undefined) changed = this.#leaveGroup(table, key);
      if (notInPlace) table.notInPlace.add(key);
      table.byKey.set(key, id);
      let members = table.groups.get(id);
      if (members === undefined) {
        members = new Set();
        table.groups.set(id, members);
        changed = true;
      }
      members.add(key);
    }
    if (inPlace === true) table.notInPlace.delete(key);
    else if (inPlace === false) table.notInPlace.add(key);
    if (changed) this.#regroupEnclosing(collection, around);
    return was !== id;
  }

  /**
   * Updates the group of the element of the collection enclosing
   * `collection` that holds the assembly of the keys `around`, where that
   * collection is folded and the element has a group already.
   */
  #regroupEnclosing(collection: number, around: readonly string[]): void {
    const outer = this.#outerOf(collection).at(-1);
    const key = around.at(-1);
    if (outer === undefined || key === undefined) return;
    if (!this.#folded().has(outer)) return;
    const outerAround = around.slice(0, -1);
    const table = this.#groups.get(
      this.#name("assembly", outer, outerAround),
    );
    if (!table?.byKey.has(key)) return;
    this.#regroupKey(outer, outerAround, key);
  }

  /**
   * What the slot of an element is bound to where no evaluation bound it,
   * for the element keys given: the position the element is at, for an
   * element that is a reference or a plain value in place, and the
   * upstream element, for an element of the result of another
   * per-element construct. A kept output of each element of a `filter`
   * reads its element in this way, in no cone of the element body.
   */
  #elementBound(
    slot: number,
    byCollection: ReadonlyMap<number, string>,
  ): Bound | undefined {
    const record = this.plan.slots[slot];
    if (record.root.kind !== "element") return undefined;
    const collection = record.root.collection ?? -1;
    const key = byCollection.get(collection);
    if (key === undefined) return undefined;
    const outer = this.#outerOf(collection);
    const pairs = outer.map((step): [number, string] => [
      step,
      byCollection.get(step) ?? "?",
    ]);
    const upstream = this.plan.collections[collection]?.source.collection;
    if (upstream !== undefined) {
      return {
        upstream: {
          collection: upstream,
          keys: [
            ...this.#outerOf(upstream).map((step): [number, string] => [
              step,
              byCollection.get(step) ?? "?",
            ]),
            [upstream, key],
          ],
        },
      };
    }
    const element = this.#tables.get(
      this.#name("assembly", collection, pairs.map(([, at]) => at)),
    )?.byKey.get(key);
    if (!(element?.source instanceof Ref)) return undefined;
    const { source } = element;
    return {
      observes: record.observes,
      at: [new Ref(source.doc, [...source.path, ...record.path])],
    };
  }

  /**
   * What a slot is bound to where no evaluation bound it and an evaluation
   * bound another slot with the same root and path: the value code read the
   * position once, in the other slot's class. The condition of a selector
   * that is the left operand of `??` is such a `shape` slot, read only
   * through the read of its value. The positions are those that read went
   * through, and for an `identity` read the reference it gave, which is
   * where the value whose shape the slot observes is.
   */
  #samePositionBound(
    slot: number,
    boundOf: (slot: number) => Bound | undefined,
  ): Bound | undefined {
    const record = this.plan.slots[slot];
    for (const other of this.#slotsAtPosition(slot)) {
      const bound = boundOf(other);
      if (bound === undefined || !("at" in bound)) continue;
      return this.#derivedBound(
        bound,
        `same ${slot}`,
        () => ({ observes: record.observes, at: [...bound.at] }),
      );
    }
    return undefined;
  }

  /**
   * What a slot below the elements of a collection, whose path holds `*`,
   * is bound to where no element was read for it, as where the collection
   * is empty: the position the read would have read, `*` below the
   * collection where a slot that reads the collection itself through to
   * its stored array was bound. The runtime takes there the join of the
   * element entries `*` covers, none for an empty collection, with the
   * entries above it, so an absent element has the label of the nearest
   * stored entry above it.
   */
  #elementsBound(
    slot: number,
    boundOf: (slot: number) => Bound | undefined,
  ): Bound | undefined {
    const record = this.plan.slots[slot];
    const star = record.path.indexOf("*");
    if (star < 0) return undefined;
    const above = canonical([record.root, record.path.slice(0, star)]);
    for (const other of this.#valueSlotsAt(above)) {
      if (other === slot) continue;
      const bound = boundOf(other);
      if (bound === undefined || !("at" in bound)) continue;
      // An `enumeration` slot of one container observes the container,
      // whatever the value code read below it (`#enumerated`).
      const container = this.#enumerated(other, bound)?.chain;
      // Otherwise the collection is at the last position the read
      // observed. A link of a member at which the read stopped is below
      // it, and `*` covers it.
      const reached = container ??
        bound.at.filter((position) =>
          position instanceof Ref || position.stopped !== true
        );
      const last = reached[reached.length - 1];
      if (last === undefined || last instanceof Ref) continue;
      return this.#derivedBound(bound, `elements ${slot}`, () => ({
        observes: record.observes,
        at: [
          ...reached.slice(0, -1),
          { doc: last.doc, path: [...last.path, ...record.path.slice(star)] },
        ],
      }));
    }
    return undefined;
  }

  /**
   * What the source slot of a collection is bound to where no cone read it:
   * the stored array the collection's assembly found, for the element keys
   * of the collections around it. The template of the result of a `map`, an
   * output with a `collection`, is that slot, which the assembly reads and
   * no cone instance does.
   */
  #sourceBinding(
    slot: number,
    byCollection: ReadonlyMap<number, string>,
    collections: Iterable<number> = this.plan.collections.keys(),
  ): SlotBinding | undefined {
    for (const collection of collections) {
      if (this.plan.collections[collection].source.slot !== slot) continue;
      const around = this.#outerOf(collection).map((step) =>
        byCollection.get(step) ?? "?"
      );
      const chain = this.#arrayChain(
        this.#name("assembly", collection, around),
      );
      if (chain.length > 0) {
        return { chain, observes: this.plan.slots[slot].observes };
      }
    }
    return undefined;
  }

  /**
   * What a slot of the argument or of a state cell is bound to where no
   * evaluation bound it, as the condition of `a?.b ?? c` that the value
   * code reads only through the read of `b`: the position the slot names,
   * through the links on the way to it. The runtime observes the label
   * stored there at commit.
   */
  #positionBinding(
    slot: number,
    keys: readonly [number, string][],
  ): SlotBinding | undefined {
    const { root, path, observes } = this.plan.slots[slot];
    let doc: string | undefined;
    if (root.kind === "argument") doc = this.argument;
    else if (root.kind === "state") {
      const wanted = canonical(keys.map(([, key]) => key));
      for (const [id, { cell, keys: held }] of this.#cells) {
        if (cell === (root.cell ?? 0) && canonical(held) === wanted) doc = id;
      }
    }
    if (doc === undefined) return undefined;
    // Every class but `identity` resolves through a link at the last
    // segment (PL §2.5).
    const chain = this.#addressesOf(
      [new Ref(doc, path)],
      observes !== "identity",
    );
    return chain.length === 0 ? undefined : this.#chainsOf(chain, observes);
  }

  /**
   * The binding of a slot to the positions its read went through, in
   * order. A position that holds a link is one the read crossed, and a
   * position that holds none is one it observed: the positions up to the
   * first observed one are the slot's chain, and each further run of
   * crossed links with the position it ends in is a chain below it, which
   * a read of a value that holds links makes. An `identity` slot observes
   * the reference at its last position and has one chain.
   */
  #chainsOf(
    given: Address[],
    observes: string,
    /** Containers whose members the read is known to have covered. */
    presumed: readonly MemberGroups[] = [],
  ): SlotBinding {
    return this.#chainsOver(
      this.#coveredMembers(given, observes, presumed),
      observes,
    );
  }

  /**
   * The binding of a slot of the class `observes` to what a read covered
   * (`#chainsOf`). The members of each container the read covered are named
   * by one member of each group of the container's table, and by no other.
   */
  #chainsOver(cover: Cover, observes: string): SlotBinding {
    const addresses = cover.rest;
    const reported = cover.covers.map(({ table, uncovered }) => {
      const members = this.#memberOfEachGroup(table, uncovered);
      return {
        members,
        stated: {
          container: { doc: table.doc, path: [...table.path] },
          count: table.members.size - uncovered.size,
          groups: members.length,
        },
      };
    });
    const stated = reported.length === 0
      ? {}
      : { members: reported.map((each) => each.stated) };
    if (observes === "identity") {
      if (reported.length === 0) return { chain: addresses, observes };
      const chain = [...addresses];
      for (const { members } of reported) {
        for (const { links, ends } of members) {
          for (const address of links) chain.push(address);
          for (const address of ends) chain.push(address);
        }
      }
      // The position the read ended at stays the last of the chain.
      const { last } = cover;
      const end = chain[chain.length - 1];
      if (
        last !== undefined &&
        (end.doc !== last.doc || canonical(end.path) !== canonical(last.path))
      ) chain.push(last);
      return { chain, observes, ...stated };
    }
    const chains: Address[][] = [];
    let current: Address[] = [];
    // The links at which the read stopped (`Position.stopped`), as where
    // the schema declares a handle at each member of a record: the read
    // observed each as a reference, and no chain goes on to where one
    // leads (provisional decision P46).
    const references: Address[] = [];
    for (const address of addresses) {
      if (
        stoppedAt.has(address) &&
        isLink(this.store.peek(address.doc, address.path))
      ) {
        references.push(address);
        continue;
      }
      current.push(address);
      if (!isLink(this.store.peek(address.doc, address.path))) {
        chains.push(current);
        current = [];
      }
    }
    // The positions end at a link where they are those of another slot's
    // read that stopped there, as an `identity` slot's does. Every other
    // class resolves through a link at the last segment (PL §2.5): the
    // chain goes on to where the link leads.
    const stopped = current.at(-1);
    if (stopped !== undefined) {
      const seen = new Set(
        addresses.map(({ doc, path }) => JSON.stringify([doc, path])),
      );
      this.#quietly(() => {
        const crossed: Position[] = [];
        const located = this.store.locate(
          new Ref(stopped.doc, stopped.path),
          true,
          crossed,
        );
        for (
          const { doc, path } of [
            ...crossed.filter(({ keyed }) => keyed === undefined),
            located.ref,
          ]
        ) {
          const id = JSON.stringify([doc, path]);
          if (seen.has(id)) continue;
          seen.add(id);
          current.push({ doc, path: [...path] });
        }
      });
      // Where the link leads to a position an earlier chain ends at, the
      // links are crossed on the way to that position, and no chain ends
      // at a link.
      const [first] = chains;
      const last = current[current.length - 1];
      if (
        first !== undefined &&
        isLink(this.store.peek(last.doc, last.path))
      ) {
        chains[0] = [...current, ...first];
      } else {
        chains.push(current);
      }
    }
    const [first = [], ...rest] = chains;
    // The runtime observes every position of a chain but its last as a
    // reference, so the links the read stopped at stand before the
    // position the first chain ends at, one for each label they hold as
    // references. A read that observed nothing but such links observed
    // references alone.
    const distinct = this.#distinctByLabel(
      references.map((address) => [address]),
      "identity",
    ).map(([address]) => address);
    if (first.length === 0 && distinct.length > 0) {
      return { chain: distinct, observes: "identity", ...stated };
    }
    const chain = [...distinct, ...first];
    for (const { members } of reported) {
      for (const { links, ends } of members) {
        ends.forEach((end, index) =>
          rest.push(index === 0 ? [...links, end] : [end])
        );
      }
    }
    const below = this.#distinctByLabel(rest, observes);
    return {
      chain,
      observes,
      ...(below.length === 0 ? {} : { below }),
      ...stated,
    };
  }

  /** On the root: the table of each container and class of read, by name. */
  readonly #memberGroups = new Map<string, MemberGroups>();
  /** On the root: the tables of each container, by its position. */
  readonly #memberGroupsAt = new Map<string, Set<MemberGroups>>();
  /**
   * On the root: the tables with a position in each document, that of the
   * container or one a member's link leads to.
   */
  readonly #memberGroupsOf = new Map<string, Set<MemberGroups>>();

  /**
   * What a read of the class `observes` that went through `addresses`
   * covered: the containers among them whose members it went through, each
   * by its table, and the addresses that are no position of a covered
   * member. A container is a stored array of references through most of
   * whose members the read went, to the same positions of what each link
   * leads to; a member the read did not go through every position of is
   * not covered, and its positions stay among the rest. The members of
   * each of `presumed`, tables of another class of read of the same
   * positions, are covered without being looked for. No container is
   * covered where the store names no label identifiers.
   */
  #coveredMembers(
    given: Address[],
    observes: string,
    presumed: readonly MemberGroups[] = [],
  ): Cover {
    const last = given[given.length - 1];
    const covered = new Set<string>();
    const covers: Cover["covers"] = [];
    const taken = new Set<string>();
    let addresses = given;
    for (const other of presumed) {
      const { doc, path, fields } = other;
      const table = this.root.#memberGroupsFor(doc, path, observes, fields);
      if (table === undefined) {
        // No table of this class of read places the members: the read
        // went through the positions of each of them.
        addresses = [
          ...addresses,
          ...[...other.members.values()].flatMap(({ links, ends }) => [
            ...links,
            ...ends,
          ]),
        ];
        continue;
      }
      taken.add(memberGroupsPlace(doc, path));
      for (const member of table.members.values()) {
        for (const text of member.texts) covered.add(text);
      }
      covers.push({ table, uncovered: new Set() });
    }
    const none: Cover = { rest: addresses, covers: [], last };
    if (this.root.options.transactions?.labelOf === undefined) return none;
    if (covers.length === 0 && addresses.length < 3) return none;
    const texts = addresses.map(({ doc, path }) => positionText(doc, path));
    const read = new Set(texts);
    addresses.forEach(({ doc, path }, at) => {
      if (covered.has(texts[at]) || addresses.length < 3) return;
      const held = this.store.peek(doc, path);
      if (!Array.isArray(held) || held.length === 0 || !isLink(held[0])) {
        return;
      }
      if (taken.has(memberGroupsPlace(doc, path))) return;
      const fields = this.#fieldsRead(doc, path, addresses);
      if (fields === undefined) return;
      const table = this.root.#memberGroupsFor(doc, path, observes, fields);
      if (table === undefined) return;
      const uncovered = new Set<string>();
      for (const [name, member] of table.members) {
        if (!member.texts.every((text) => read.has(text))) uncovered.add(name);
      }
      // A read that went through few of the members covers none.
      if (uncovered.size * 2 > table.members.size) return;
      for (const [name, member] of table.members) {
        if (uncovered.has(name)) continue;
        for (const text of member.texts) covered.add(text);
      }
      covers.push({ table, uncovered });
    });
    if (covers.length === 0) return none;
    return {
      rest: addresses.filter((_, at) => !covered.has(texts[at])),
      covers,
      last,
    };
  }

  /**
   * The paths, below the position the link of the first member of the
   * array at `path` of `doc` leads to, of the positions among `addresses`
   * in that document: what a read that went through `addresses` reached of
   * the member. Nothing where the link leads into `doc` itself, or the read
   * reached no position of the member.
   */
  #fieldsRead(
    doc: string,
    path: readonly string[],
    addresses: readonly Address[],
  ): string[][] | undefined {
    const { ref } = this.#quietly(() =>
      this.store.locate(new Ref(doc, [...path, "0"]), true)
    );
    if (ref.doc === doc) return undefined;
    const fields: string[][] = [];
    const seen = new Set<string>();
    for (const address of addresses) {
      if (
        address.doc !== ref.doc || address.path.length < ref.path.length ||
        !ref.path.every((segment, index) => segment === address.path[index])
      ) continue;
      const field = address.path.slice(ref.path.length);
      const text = canonical(field);
      if (seen.has(text)) continue;
      seen.add(text);
      fields.push(field);
    }
    return fields.length === 0 ? undefined : fields;
  }

  /**
   * On the root: the table of the groups of the members of the array at
   * `path` of `doc`, for the reads of the class `observes` that reach the
   * positions at `fields` of each member, brought up to date. Nothing where
   * a member is no reference the table can place.
   */
  #memberGroupsFor(
    doc: string,
    path: readonly string[],
    observes: string,
    fields: readonly (readonly string[])[],
  ): MemberGroups | undefined {
    const place = memberGroupsPlace(doc, path);
    const name = `${observes}\n${place}\n${canonical(fields)}`;
    let table = this.#memberGroups.get(name);
    if (table === undefined) {
      table = {
        doc,
        path: [...path],
        observes,
        fields,
        members: new Map(),
        groups: new Map(),
        unknown: new Set(),
        dirty: new Set(),
        stale: true,
        declined: false,
        membership: 0,
        byDoc: new Map(),
        records: new Set(),
      };
      this.#memberGroups.set(name, table);
      const held = this.#memberGroupsAt.get(place) ?? new Set();
      held.add(table);
      this.#memberGroupsAt.set(place, held);
      this.#indexGroups(table, doc);
    }
    return this.#refreshGroups(table) ? table : undefined;
  }

  /** On the root: keeps `table` as one with a position in `doc`. */
  #indexGroups(table: MemberGroups, doc: string): void {
    const held = this.#memberGroupsOf.get(doc) ?? new Set();
    held.add(table);
    this.#memberGroupsOf.set(doc, held);
  }

  /**
   * On the root: brings a table up to date: places again the members
   * whose positions or labels changed and those with no key, and forms the
   * table again whole where the container changed otherwise than at a
   * member. Returns whether the table covers the container. The work is
   * the number of members placed.
   */
  #refreshGroups(table: MemberGroups): boolean {
    // A table that covers nothing stays so until something changes.
    if (table.declined && !table.stale && table.dirty.size === 0) return false;
    const array = this.store.peek(table.doc, table.path);
    if (!Array.isArray(array)) {
      this.#clearGroups(table);
      table.declined = true;
      return false;
    }
    let whole = table.stale || table.declined;
    if (!whole) {
      for (const member of [...table.dirty, ...table.unknown]) {
        if (!/^(0|[1-9][0-9]*)$/.test(member)) continue;
        if (Number(member) >= array.length) {
          if (table.members.has(member)) {
            this.#leaveGroups(table, member);
            table.membership += 1;
          }
        } else if (!this.#placeMember(table, member)) {
          whole = true;
          break;
        }
      }
      table.dirty.clear();
      if (table.members.size !== array.length) whole = true;
    }
    if (!whole) return true;
    this.#clearGroups(table);
    for (let index = 0; index < array.length; index++) {
      if (!this.#placeMember(table, `${index}`)) {
        this.#clearGroups(table);
        table.declined = true;
        return false;
      }
    }
    return true;
  }

  /** On the root: empties a table, as one that is formed again whole. */
  #clearGroups(table: MemberGroups): void {
    table.members.clear();
    table.groups.clear();
    table.unknown.clear();
    table.dirty.clear();
    table.byDoc.clear();
    table.stale = false;
    table.declined = false;
    table.membership += 1;
  }

  /** On the root: takes a member out of its group and out of the table. */
  #leaveGroups(table: MemberGroups, member: string): void {
    const held = table.members.get(member);
    if (held === undefined) return;
    table.members.delete(member);
    table.unknown.delete(member);
    if (held.key === undefined) return;
    const group = table.groups.get(held.key);
    group?.delete(member);
    if (group?.size === 0) table.groups.delete(held.key);
  }

  /**
   * On the root: finds the positions a read of a member goes through and
   * the key of their labels, and puts the member in the group of that key.
   * Returns whether the member is a reference the table can place: one
   * that holds a link, whose positions at the table's fields hold none.
   */
  #placeMember(table: MemberGroups, member: string): boolean {
    const { doc, path, observes } = table;
    if (!isLink(this.store.peek(doc, [...path, member]))) return false;
    const crossed: Position[] = [];
    const { ref } = this.#quietly(() =>
      this.store.locate(new Ref(doc, [...path, member]), true, crossed)
    );
    const links: Address[] = [];
    for (const { doc: at, path: below, keyed } of crossed) {
      if (keyed !== undefined) continue;
      if (at === ref.doc && canonical(below) === canonical(ref.path)) continue;
      links.push({ doc: at, path: [...below] });
    }
    const ends = table.fields.map((field) => ({
      doc: ref.doc,
      path: [...ref.path, ...field],
    }));
    if (
      links.length === 0 ||
      ends.some((end) => isLink(this.store.peek(end.doc, end.path)))
    ) return false;
    const keys = [...links, ...ends].map((address) =>
      this.#labelKey(address, observes)
    );
    const key = keys.includes(undefined) ? undefined : JSON.stringify(keys);
    const added = !table.members.has(member);
    this.#leaveGroups(table, member);
    table.members.set(member, {
      links,
      ends,
      texts: [...links, ...ends].map(({ doc: at, path: below }) =>
        positionText(at, below)
      ),
      key,
    });
    if (added) table.membership += 1;
    if (key === undefined) table.unknown.add(member);
    else {
      const group = table.groups.get(key) ?? new Set();
      group.add(member);
      table.groups.set(key, group);
    }
    for (const { doc: at } of [...links, ...ends]) {
      if (at === doc) continue;
      const held = table.byDoc.get(at) ?? new Set();
      held.add(member);
      table.byDoc.set(at, held);
      this.#indexGroups(table, at);
    }
    return true;
  }

  /**
   * One member of each group of a table, and each member with no key, of
   * the members that are not in `uncovered`: the members whose positions a
   * binding names for the container. The work is the number of groups and
   * of uncovered members.
   */
  #memberOfEachGroup(
    table: MemberGroups,
    uncovered: ReadonlySet<string>,
  ): Member[] {
    const found: Member[] = [];
    for (const group of table.groups.values()) {
      for (const member of group) {
        if (uncovered.has(member)) continue;
        found.push(table.members.get(member)!);
        break;
      }
    }
    for (const member of table.unknown) {
      if (!uncovered.has(member)) found.push(table.members.get(member)!);
    }
    return found;
  }

  /**
   * On the root: a document changed at `path`. A table with a position of
   * a member in the document places that member again, a table whose
   * container the change is below places the member it is at or below, one
   * whose container gained members at its end places those, and one whose
   * container changed otherwise is formed again whole. The work is the
   * number of tables with a position in the document.
   */
  #memberDocumentChanged(
    doc: string,
    path: readonly string[],
    splice: { start: number; removed: number; inserted: number } | undefined,
  ): void {
    for (const table of this.#memberGroupsOf.get(doc) ?? []) {
      for (const member of table.byDoc.get(doc) ?? []) table.dirty.add(member);
      if (doc !== table.doc) continue;
      const shared = Math.min(path.length, table.path.length);
      if (
        !table.path.slice(0, shared).every((segment, at) =>
          segment === path[at]
        )
      ) continue;
      if (path.length > table.path.length) {
        table.dirty.add(path[table.path.length]);
      } else if (
        path.length === table.path.length && splice !== undefined &&
        splice.removed === 0 && splice.start === table.members.size &&
        !table.stale
      ) {
        for (let added = 0; added < splice.inserted; added++) {
          table.dirty.add(`${splice.start + added}`);
        }
      } else table.stale = true;
    }
  }

  /**
   * On the root: the labels of documents changed. Places again the members
   * of each table that have a position at, above or below a changed label
   * entry, and returns the records that read a table where that made or
   * emptied a group: the label of a read that covers the container is the
   * join over its groups, which a member that moves between two groups
   * that both stay leaves as it was. The work is the number of members
   * placed.
   */
  #memberLabelsChanged(changes: readonly LabelChange[]): Set<string> {
    const found = new Set<string>();
    const touched = new Set<MemberGroups>();
    for (const { doc, paths, alone } of changes) {
      const own = new Set((alone ?? []).map((path) => canonical(path)));
      for (const table of this.#memberGroupsOf.get(doc) ?? []) {
        if (doc !== table.doc) {
          touched.add(table);
          for (const member of table.byDoc.get(doc) ?? []) {
            table.dirty.add(member);
          }
          continue;
        }
        // An entry at the container or above it that labels a read of its
        // own path alone, as that of the container's membership, is one no
        // member's link position takes its label from.
        const below = paths.filter((path) =>
          path.length > table.path.length || !own.has(canonical(path))
        );
        if (below.length === 0) continue;
        touched.add(table);
        for (const member of table.byDoc.get(doc) ?? []) {
          table.dirty.add(member);
        }
        for (const path of below) {
          const shared = Math.min(path.length, table.path.length);
          if (
            !table.path.slice(0, shared).every((segment, at) =>
              segment === path[at]
            )
          ) continue;
          const member = path[table.path.length];
          // An entry at the container, above it, or at `*` below it is
          // one every member's link position can take its label from.
          if (member === undefined || member === "*") {
            for (const each of table.members.keys()) table.dirty.add(each);
          } else table.dirty.add(member);
        }
      }
    }
    for (const table of touched) {
      if (table.records.size === 0) continue;
      const before = canonical([...table.groups.keys()].sort());
      const unknown = table.unknown.size;
      const covers = this.#refreshGroups(table);
      if (
        !covers || table.unknown.size !== unknown ||
        canonical([...table.groups.keys()].sort()) !== before
      ) {
        for (const set of table.records) {
          for (const key of set.keys) found.add(key);
        }
      }
    }
    return found;
  }

  /**
   * One chain of each set of chains whose positions hold equal labels, in
   * order (provisional decision P31): the label of a slot is the join over
   * its chains, to which chains of equal labels add nothing, so a read of an
   * array of references whose labels are equal reports one chain, however
   * many elements it has. A chain with a position whose label the store
   * names no identifier for is kept. The labels compared are those of the
   * observations the runtime makes of the positions of a chain
   * (`#labelKey`), for a slot of the class `observes`.
   */
  #distinctByLabel(chains: Address[][], observes: string): Address[][] {
    const hooks = this.root.options.transactions;
    if (chains.length < 2 || hooks?.labelOf === undefined) return chains;
    const seen = new Set<string>();
    return chains.filter((chain) => {
      const labels = chain.map((address) => this.#labelKey(address, observes));
      if (labels.includes(undefined)) return true;
      const key = JSON.stringify(labels);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * The identifiers of the labels the runtime observes at a position a
   * slot of the class `observes` is bound to, as one text, or nothing where
   * the store names no identifier. The runtime observes a link a read
   * crossed as a reference, and the label of that observation is not part
   * of the label of a read of the value there: two links written under
   * different labels have one identifier for a read of their values. A
   * position that holds a link is one a read crossed or one it ended at,
   * so its text holds the identifier of both observations.
   */
  #labelKey({ doc, path }: Address, observes: string): string | undefined {
    const hooks = this.root.options.transactions;
    const own = hooks?.labelOf?.(doc, path, observes);
    if (own === undefined) return undefined;
    if (observes === "identity" || !isLink(this.store.peek(doc, path))) {
      return own;
    }
    const crossed = hooks?.labelOf?.(doc, path, "identity");
    return crossed === undefined ? undefined : `${own}|${crossed}`;
  }

  /** The other slots with the root and the path of `slot`, by its index. */
  #slotsAtPosition(slot: number): number[] {
    if (this.#atPosition === undefined) {
      const byPosition = new Map<string, number[]>();
      this.plan.slots.forEach(({ root, path }, index) => {
        const key = canonical([root, path]);
        byPosition.set(key, [...byPosition.get(key) ?? [], index]);
      });
      this.#atPosition = this.plan.slots.map(({ root, path }, index) =>
        (byPosition.get(canonical([root, path])) ?? []).filter((other) =>
          other !== index
        )
      );
    }
    return this.#atPosition[slot];
  }

  /** The result of `#slotsAtPosition()` for every slot, made once. */
  #atPosition: number[][] | undefined;

  /**
   * The slots of the plan at a root and path, given as the canonical text
   * of the pair, in the order of the plan, without those of the class
   * `identity`: such a slot stops at the link to the cell at its path, and
   * its last position is not that of the value there.
   */
  #valueSlotsAt(position: string): readonly number[] {
    if (this.#valueSlots === undefined) {
      this.#valueSlots = new Map();
      this.plan.slots.forEach(({ root, path, observes }, index) => {
        if (observes === "identity") return;
        const key = canonical([root, path]);
        const held = this.#valueSlots!.get(key);
        if (held === undefined) this.#valueSlots!.set(key, [index]);
        else held.push(index);
      });
    }
    return this.#valueSlots.get(position) ?? [];
  }

  /** The result of `#valueSlotsAt()` for every position, made once. */
  #valueSlots: Map<string, number[]> | undefined;

  /**
   * The slots the membership of a collection reaches: those of its
   * membership template, or, for a `filter`, whose membership template is
   * the fold over its own elements, those of the membership of its source
   * (`membership` of `runtime/runner/src/cfc/plan-labels.ts`). `source`
   * names the collection a slot is the source of.
   */
  #membershipSlots(
    collection: number,
  ): { slot: number; source?: number }[] {
    const templates = this.plan.templates ?? [];
    const { membership, source } = this.plan.collections[collection];
    const expanded = membership?.op === "shared"
      ? templates[membership.template]
      : membership;
    if (expanded?.op === "fold" && expanded.collection === collection) {
      if (source.collection !== undefined) {
        return this.#membershipSlots(source.collection);
      }
      return source.slot === undefined
        ? []
        : [{ slot: source.slot, source: collection }];
    }
    return [...reachedBy(membership, templates).slots].map((slot) => ({
      slot,
      ...(source.slot === slot ? { source: collection } : {}),
    }));
  }

  /**
   * The output whose array a collection iterates, through the collections
   * it is over whose membership is that of their source: a `filter`, whose
   * membership template is the fold over its own elements.
   */
  #sourceOutput(collection: number): number | undefined {
    const templates = this.plan.templates ?? [];
    let at = collection;
    for (let depth = 0; depth < 64; depth++) {
      const { membership, source } = this.plan.collections[at];
      const expanded = membership?.op === "shared"
        ? templates[membership.template]
        : membership;
      if (expanded?.op !== "fold" || expanded.collection !== at) {
        return undefined;
      }
      if (source.collection === undefined) return source.output;
      at = source.collection;
    }
    return undefined;
  }

  /** The folded collections whose innermost enclosing one is `collection`. */
  #innerFolds(collection: number): number[] {
    let found = this.#innerFoldsOf.get(collection);
    if (found === undefined) {
      found = [...this.#folded()].filter((folded) =>
        this.#outerOf(folded).at(-1) === collection
      ).sort((a, b) => a - b);
      this.#innerFoldsOf.set(collection, found);
    }
    return found;
  }

  /**
   * Removes an element key from its group, and returns whether that
   * emptied the group.
   */
  #leaveGroup(table: Groups, key: string): boolean {
    const id = table.byKey.get(key);
    if (id === undefined) return false;
    table.byKey.delete(key);
    table.notInPlace.delete(key);
    const members = table.groups.get(id);
    members?.delete(key);
    if (members?.size !== 0) return false;
    table.groups.delete(id);
    return true;
  }

  /**
   * Runs `run` with no read reported to a store outside the executor:
   * what a write record resolves is no read of the transaction.
   */
  #quietly<T>(run: () => T): T {
    const { store } = this;
    const reported = store.onRead;
    store.onRead = undefined;
    try {
      return run();
    } finally {
      store.onRead = reported;
    }
  }

  /**
   * The addresses of the positions a slot was bound to, each once, in
   * order: a reference by key is resolved to the position that holds the
   * key now, and a reference to the links it crosses and its position.
   */
  #addressesOf(
    at: readonly (Position | Ref)[],
    /** Whether a link at the last segment of a reference is followed. */
    through = false,
  ): Address[] {
    const found: Address[] = [];
    // The addresses found, by their text, from the second one on: a slot
    // bound to one position needs no text of it.
    let seen: Map<string, Address> | undefined;
    const textOfAddress = (doc: string, path: readonly string[]) =>
      JSON.stringify([doc, path]);
    const add = (doc: string, path: readonly string[], stopped = false) => {
      if (found.length > 0) {
        seen ??= new Map(
          found.map((address) => [
            textOfAddress(address.doc, address.path),
            address,
          ]),
        );
        const held = seen.get(textOfAddress(doc, path));
        if (held !== undefined) {
          // A position one read stopped at and another crossed is crossed.
          if (!stopped) stoppedAt.delete(held);
          return;
        }
      }
      const address = { doc, path: [...path] };
      seen?.set(textOfAddress(doc, path), address);
      if (stopped) stoppedAt.add(address);
      found.push(address);
    };
    this.#quietly(() => {
      for (const position of at) {
        if (position instanceof Ref || position.keyed !== undefined) {
          const ref = position instanceof Ref
            ? position
            : (position.keyed as { ref: Ref }).ref;
          // The links crossed, and the position that holds the key now
          // in the place of the read by key.
          const crossed: Position[] = [];
          const located = this.store.locateCrossed(
            ref,
            through && position instanceof Ref,
            crossed,
          );
          for (const { doc, path } of crossed) add(doc, path);
          add(located.ref.doc, located.ref.path);
        } else {
          add(position.doc, position.path, position.stopped === true);
        }
      }
    });
    return found;
  }

  /**
   * The output that holds, for an element of the result of the
   * per-element construct of `collection`, what is at `path` below the
   * element: the output of the construct's element body at the longest
   * path above it.
   */
  #upstreamOutput(collection: number, path: readonly string[]) {
    const cone = this.code.values.find((value) =>
      value.collection === collection
    )?.cone;
    const base = this.plan.outputs.find((output) =>
      output.collection === collection
    )?.path;
    if (cone === undefined || base === undefined) return undefined;
    let best: number | undefined;
    this.plan.outputs.forEach((output, index) => {
      if (output.cone !== cone || output.collection !== undefined) return;
      const rest = output.path.slice(base.length + 1);
      if (
        output.path.length <= base.length ||
        output.path[base.length] !== "*" ||
        !base.every((segment, at) => output.path[at] === segment) ||
        !rest.every((segment, at) => segment === path[at])
      ) return;
      if (
        best === undefined ||
        output.path.length > this.plan.outputs[best].path.length
      ) best = index;
    });
    return best;
  }

  /**
   * The binding a write record reports for a slot. The slot of an upstream
   * element names the output that holds it, and `outputs` gets the inputs
   * of that output.
   */
  #bindingOf(
    slot: number,
    bound: Bound,
    outputs: Record<number, number>,
    depth: number,
    keys: [number, string][] = [],
  ): SlotBinding {
    if ("constant" in bound) return { constant: true };
    if ("output" in bound) {
      outputs[bound.output] ??= this.#namedInputs(
        bound.output,
        keys,
        depth + 1,
      );
      return { output: bound.output };
    }
    if ("place" in bound) {
      return this.#placeBinding(
        bound.place.slot,
        bound.place.rest,
        this.plan.slots[slot].observes,
        outputs,
        depth,
        keys,
      ) ?? { chain: [], observes: this.plan.slots[slot].observes };
    }
    if ("upstream" in bound) {
      const { collection, keys } = bound.upstream;
      const output = this.#upstreamOutput(
        collection,
        this.plan.slots[slot].path,
      );
      const through = bound.through === undefined
        ? undefined
        : this.#bindingOf(slot, bound.through, outputs, depth);
      const read = through !== undefined && "chain" in through &&
          through.chain.length > 0
        ? through
        : undefined;
      if (output !== undefined) {
        outputs[output] ??= this.#namedInputs(output, keys, depth + 1);
        return read === undefined ? { output } : { output, through: read };
      }
      return read ?? { chain: [], observes: this.plan.slots[slot].observes };
    }
    const { root } = this.plan.slots[slot];
    const wish = root.kind === "operation" &&
      this.plan.operations[root.operation ?? -1]?.kind === "wish";
    if (!wish) {
      const container = this.#enumerated(slot, bound);
      if (container !== undefined) return container;
    }
    // What the read covered is found once for the bound positions, while
    // the documents of the positions outside the covered containers and
    // the sets of members of those containers stay as they are.
    const kept = wish ? undefined : this.root.#covers.get(bound);
    if (
      kept !== undefined && kept.positions === bound.at.length &&
      kept.cover.covers.every(({ table }, at) =>
        this.root.#refreshGroups(table) &&
        table.membership === kept.memberships[at]
      ) && !this.store.changedSince(kept.clock, kept.cover.rest)
    ) {
      return this.#chainsOver(kept.cover, bound.observes);
    }
    const chain = this.#addressesOf(bound.at);
    if (chain.length === 0) {
      const source = this.#sourceReadBinding(slot, keys) ??
        this.#indexBinding(slot, keys);
      if (source !== undefined) return source;
    }
    if (wish) return this.#chainsOf(chain, bound.observes);
    const cover = this.#coveredMembers(chain, bound.observes);
    if (cover.covers.length > 0) {
      this.root.#covers.set(bound, {
        cover,
        positions: bound.at.length,
        clock: this.store.clock,
        memberships: cover.covers.map(({ table }) => table.membership),
      });
    }
    return this.#chainsOver(cover, bound.observes);
  }

  /**
   * The binding of an `enumeration` slot of one container, one whose path
   * holds no `*`: the links the read crossed on the way to the container
   * and the container, the first position it observed. The value code
   * reads the container as a value, through the references it holds, which
   * is a wider read than the slot's: a slot of this class consumes nothing
   * below its bound address and has no further binding (PL §2.5). Nothing
   * where the positions do not begin so.
   */
  #enumerated(
    slot: number,
    bound: Extract<Bound, { at: unknown }>,
  ): { chain: Address[]; observes: string } | undefined {
    if (
      bound.observes !== "enumeration" ||
      this.plan.slots[slot].path.includes("*")
    ) return undefined;
    const chain: Address[] = [];
    for (const position of bound.at) {
      if (position instanceof Ref || position.keyed !== undefined) break;
      chain.push({ doc: position.doc, path: [...position.path] });
      if (!isLink(this.store.peek(position.doc, position.path))) {
        return { chain, observes: bound.observes };
      }
    }
    return undefined;
  }

  /**
   * On the root: the cover found for what an evaluation bound a slot to,
   * where the read covered a container, by the bound positions.
   */
  readonly #covers = new WeakMap<object, KeptCover>();

  /**
   * On the root: what `#elementsBound` and `#samePositionBound` made of
   * what another slot was bound to, by that and by the slot, so that the
   * cover of one bound is found once.
   */
  readonly #derived = new WeakMap<object, Map<string, Bound>>();

  /**
   * What `make` gives for `slot` from `source`, what another slot was
   * bound to: made once while `source` holds the positions it held.
   */
  #derivedBound(
    source: Extract<Bound, { at: unknown }>,
    slot: string,
    make: () => Bound,
  ): Bound {
    const held = this.root.#derived.get(source) ?? new Map<string, Bound>();
    this.root.#derived.set(source, held);
    const name = `${slot}\n${source.at.length}`;
    let bound = held.get(name);
    if (bound === undefined) {
      bound = make();
      held.set(name, bound);
    }
    return bound;
  }

  /**
   * What a slot of root `index` is bound to: the index of an element is at
   * no stored position and depends on the order of what the collection
   * iterates, so the slot reads, in the class `enumeration`, the stored
   * array the collection is over, through each `map` between them. A
   * collection that a `filter` or a `flatMap` is on the way to has an index
   * that depends on what that construct keeps: the slot stays unbound, and
   * the preparation refuses the commit.
   */
  #indexBinding(
    slot: number,
    keys: readonly [number, string][],
  ): SlotBinding | undefined {
    const { root } = this.plan.slots[slot];
    if (root.kind !== "index") return undefined;
    let at = root.collection ?? -1;
    // A chain of collections is as long as the plan is deep.
    for (let depth = 0; depth < 64; depth++) {
      const record = this.plan.collections[at];
      if (record === undefined || record.construct !== "map") return undefined;
      if (record.source.collection === undefined) break;
      at = record.source.collection;
    }
    const source = this.plan.collections[at].source.slot;
    if (source === undefined) return undefined;
    const found = this.#sourceBinding(source, new Map(keys), [at]);
    return found === undefined || !("chain" in found)
      ? undefined
      : { chain: found.chain, observes: "enumeration" };
  }

  /**
   * What a slot of a binding's state is bound to where the handler's read
   * of it went through no stored position (`Bound.place`): what the slot
   * the member is taken from reads, at the path below it. An index is bound
   * as `#indexBinding` binds it. An element is bound to the position it is
   * at, for a reference or a plain value in place, and to the output of the
   * upstream element that holds it, for an element of the result of another
   * per-element construct. An element of an array a computation returned
   * is bound to nothing (`#readComputedSource`).
   */
  #placeBinding(
    place: number,
    rest: readonly string[],
    observes: string,
    outputs: Record<number, number>,
    depth: number,
    keys: [number, string][],
  ): SlotBinding | undefined {
    const record = this.plan.slots[place];
    if (record.root.kind === "index") return this.#indexBinding(place, keys);
    if (record.root.kind !== "element") return undefined;
    // An element of an array that a computation returned is at no stored
    // position, and the handler's transaction read none for it: the slot
    // stays unbound, and the transaction reads what the computation read,
    // so that the bound a record with an unbound slot takes, the join of
    // what the transaction read, holds what the element holds.
    const computed = (): undefined => {
      this.#readComputedSource(record.root.collection ?? -1, keys);
      return undefined;
    };
    const bound = this.#elementBound(place, new Map(keys));
    if (bound === undefined) return computed();
    if ("upstream" in bound) {
      const output = this.#upstreamOutput(
        bound.upstream.collection,
        [...record.path, ...rest],
      );
      if (output === undefined) return undefined;
      outputs[output] ??= this.#namedInputs(
        output,
        bound.upstream.keys,
        depth + 1,
      );
      return { output };
    }
    if (!("at" in bound)) return computed();
    const [at] = bound.at;
    if (!(at instanceof Ref)) return computed();
    const chain = this.#addressesOf(
      [new Ref(at.doc, [...at.path, ...rest])],
      observes !== "identity",
    );
    return chain.length === 0 ? computed() : this.#chainsOf(chain, observes);
  }

  /**
   * Has the transaction in progress read every stored position that the
   * computation of the array `collection` iterates read (`#readBy`). The
   * work is the number of those positions, which for an array made from a
   * list grows with the list.
   */
  #readComputedSource(
    collection: number,
    keys: readonly [number, string][],
  ): void {
    const hooks = this.root.options.transactions;
    const output = this.plan.collections[collection]?.source.output;
    if (hooks === undefined || output === undefined) return;
    this.#readBy(output, keys, ({ doc, path }) => hooks.read(doc, path), true);
  }

  /**
   * Calls `read` with each stored position that the computation of an
   * output read, for the element keys given, once: those its cone instance
   * bound, those of the outputs it reads by name or that its slots are
   * bound to, and those of the upstream elements its slots read. With
   * `passed`, where an output passes the elements of another collection
   * on, also those the cone instances of each of that collection's
   * elements bound, with what gives its membership.
   */
  #readBy(
    output: number,
    keys: readonly [number, string][],
    read: (address: Address) => void,
    passed: boolean,
  ): void {
    const seen = new Set<string>();
    const once = (address: Address) => {
      const id = JSON.stringify([address.doc, address.path]);
      if (seen.has(id)) return;
      seen.add(id);
      read(address);
    };
    const visited = new Set<ConeInputs>();
    const outputsSeen = new Set<string>();
    const readBound = (bound: Bound, pairs: readonly [number, string][]) => {
      if ("constant" in bound || "place" in bound) return;
      if ("output" in bound) {
        readOutput(bound.output, pairs);
      } else if ("upstream" in bound) {
        const { collection, keys } = bound.upstream;
        for (const each of this.#elementCones(collection)) {
          readInputs(this.#inputsOf(each, this.#keysFor(each, keys)), keys);
        }
        for (const at of this.#addressesOf(bound.through?.at ?? [])) once(at);
      } else {
        for (const at of this.#addressesOf(bound.at)) once(at);
      }
    };
    const readInputs = (
      inputs: ConeInputs | undefined,
      pairs: readonly [number, string][],
    ) => {
      if (inputs === undefined || visited.has(inputs)) return;
      visited.add(inputs);
      for (const bound of inputs.slots.values()) readBound(bound, pairs);
    };
    const readOutput = (
      index: number,
      pairs: readonly [number, string][],
    ) => {
      const name = JSON.stringify([index, pairs]);
      if (outputsSeen.has(name)) return;
      outputsSeen.add(name);
      const byCollection = new Map(pairs);
      const { cone, passesCollection, template } = this.plan.outputs[index];
      const inputs = this.#inputsOf(cone, this.#keysFor(cone, pairs));
      readInputs(inputs, pairs);
      const reached = reachedBy(template, this.plan.templates ?? []);
      // A slot of the template that the cone instance did not bind is one
      // the result's own evaluation bound.
      const result = this.#inputs.get(RESULT_INPUTS);
      for (const slot of reached.slots) {
        const bound = inputs?.slots.has(slot)
          ? undefined
          : result?.slots.get(slot);
        if (bound !== undefined) readBound(bound, pairs);
      }
      // The outputs the computation read by name bind no slot of its cone.
      for (const named of reached.outputs) readOutput(named, pairs);
      if (!passed || passesCollection === undefined) return;
      const around = this.#outerOf(passesCollection).map((step) =>
        byCollection.get(step) ?? "?"
      );
      for (const { slot, source } of this.#membershipSlots(passesCollection)) {
        const found = (source === undefined
          ? undefined
          : this.#sourceBinding(slot, byCollection, [source])) ??
          this.#positionBinding(slot, pairs);
        if (found !== undefined && "chain" in found) {
          for (const at of found.chain) {
            once(at);
          }
        }
      }
      const elements = this.#tables.get(
        this.#name("assembly", passesCollection, around),
      );
      for (const key of elements?.byKey.keys() ?? []) {
        for (const each of this.#elementCones(passesCollection)) {
          readInputs(this.#inputsOf(each, [...around, key]), [
            ...pairs,
            [passesCollection, key],
          ]);
        }
      }
    };
    readOutput(output, keys);
  }

  /**
   * What the slot of an element at no stored position is bound to, as an
   * element of an array that a computation returned from what it read:
   * where the computation the collection takes its elements from read one
   * position, the value at that position, whose label covers every element
   * of what it returned. A wider bound than the element's own position,
   * which the computation does not report. Where it read several, the slot
   * stays unbound and the preparation refuses the commit.
   */
  #sourceReadBinding(
    slot: number,
    keys: readonly [number, string][],
  ): SlotBinding | undefined {
    const { root } = this.plan.slots[slot];
    if (root.kind !== "element") return undefined;
    const output = this.plan.collections[root.collection ?? -1]?.source.output;
    if (output === undefined) return undefined;
    const { cone } = this.plan.outputs[output];
    const inputs = this.#inputsOf(cone, this.#keysFor(cone, keys));
    let found: Address[] | undefined;
    for (const bound of inputs?.slots.values() ?? []) {
      if (!("at" in bound)) return undefined;
      const chain = this.#addressesOf(bound.at);
      const last = chain.at(-1);
      if (last === undefined) continue;
      const known = found?.at(-1);
      if (
        known !== undefined &&
        (known.doc !== last.doc ||
          canonical(known.path) !== canonical(last.path))
      ) return undefined;
      found ??= chain;
    }
    return found === undefined ? undefined : this.#chainsOf(found, "value");
  }

  /**
   * What a template is instantiated with, for the element keys given:
   * the binding of each slot it reaches, the inputs of each output it
   * names, and the elements of each `fold`.
   */
  #inputsFor(
    template: Template | undefined,
    keys: [number, string][],
    sources: readonly (Inputs | undefined)[],
    depth = 0,
  ): NamedOutputInputs {
    const first = <T>(of: (source: Inputs) => T | undefined): T | undefined => {
      for (const source of sources) {
        const found = source === undefined ? undefined : of(source);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    const templates = this.plan.templates ?? [];
    const table = this.root.#inputsTable;
    const reached = reachedBy(template, templates);
    const slots: SlotBindings = {};
    const outputs: Record<number, number> = {};
    const elements: Record<number, FoldElements> = {};
    const selections: Record<number, number> = {};
    const picks: Record<number, { slots: SlotBindings } | null> = {};
    const dynamic: Record<number, Address[]> = {};
    // A chain of outputs is as long as the plan is deep; one that is
    // longer than this is a cycle of the plan, and is not followed.
    if (depth < 64) {
      const byCollection = new Map(keys);
      const bindingsOf = (reaching: Iterable<number>, into: SlotBindings) => {
        for (const slot of [...reaching].sort((a, b) => a - b)) {
          const bound = first((source) => source.slots.get(slot)) ??
            this.#elementBound(slot, byCollection) ??
            this.#samePositionBound(
              slot,
              (other) => first((source) => source.slots.get(other)),
            ) ??
            this.#elementsBound(
              slot,
              (other) => first((source) => source.slots.get(other)),
            ) ??
            this.#otherConeBound(slot, keys);
          if (bound !== undefined) {
            into[slot] = table.binding(
              this.#bindingOf(slot, bound, outputs, depth, keys),
            );
            continue;
          }
          const source = this.#sourceBinding(slot, byCollection) ??
            this.#positionBinding(slot, keys);
          if (source !== undefined) into[slot] = table.binding(source);
        }
        return into;
      };
      bindingsOf(reached.slots, slots);
      // The label of a fold takes the membership of its collection, whose
      // template reaches slots of its own.
      // A collection's source slot that no cone read is the stored array
      // its assembly found.
      for (const folded of reached.folds.keys()) {
        for (const { slot, source } of this.#membershipSlots(folded)) {
          if (slots[slot] !== undefined) continue;
          const bound = first((inputs) => inputs.slots.get(slot));
          if (bound !== undefined) {
            slots[slot] = table.binding(
              this.#bindingOf(slot, bound, outputs, depth, keys),
            );
          } else {
            // A source whose assembly found no stored array, as that of a
            // `flatMap` before its first element, is read at the position
            // the slot names.
            const found = (source === undefined
              ? undefined
              : this.#sourceBinding(slot, byCollection, [source])) ??
              this.#positionBinding(
                slot,
                this.#outerOf(folded).map((step): [number, string] => [
                  step,
                  byCollection.get(step) ?? "?",
                ]),
              );
            if (found !== undefined) {
              slots[slot] = table.binding(found);
            }
          }
        }
      }
      for (const selector of [...reached.selectors].sort((a, b) => a - b)) {
        const branch = first((source) => source.selections.get(selector));
        if (branch !== undefined) selections[selector] = branch;
      }
      // The slots of a pick's body are bound to the child the value code
      // chose, which is the child it read.
      for (
        const [pick, body] of [...reached.picks].sort(([a], [b]) => a - b)
      ) {
        const key = first((source) =>
          source.picks.has(pick) ? { key: source.picks.get(pick) } : undefined
        );
        if (key === undefined) continue;
        picks[pick] = key.key === null || key.key === undefined
          ? null
          : { slots: bindingsOf(reachedBy(body, templates).slots, {}) };
      }
      for (const read of [...reached.dynamic].sort((a, b) => a - b)) {
        const seen = first((source) => source.dynamic.get(read));
        if (seen !== undefined) dynamic[read] = [...seen];
      }
      for (const output of reached.outputs) {
        outputs[output] ??= this.#namedInputs(output, keys, depth + 1);
      }
      // A folded collection over the array an output computes iterates
      // that output, whose inputs the membership is instantiated with.
      for (const folded of reached.folds.keys()) {
        const output = this.#sourceOutput(folded);
        if (output !== undefined) {
          outputs[output] ??= this.#namedInputs(output, keys, depth + 1);
        }
      }
      for (const [collection, body] of reached.folds) {
        elements[collection] = this.#foldElements(
          collection,
          body,
          keys,
          depth,
        );
      }
    }
    return {
      instance: this.id,
      keys,
      inputs: table.place({
        slots,
        ...(Object.keys(selections).length === 0 ? {} : { selections }),
        ...(Object.keys(picks).length === 0 ? {} : { picks }),
        ...(Object.keys(dynamic).length === 0 ? {} : { dynamic }),
        ...(Object.keys(outputs).length === 0 ? {} : { outputs }),
        ...(Object.keys(elements).length === 0 ? {} : { elements }),
      }),
    };
  }

  /**
   * The inputs of the cone instance of an output, for the keys given: their
   * index in the table of inputs of the transaction, formed once for the
   * records being given (`#namedIndex`).
   */
  #namedInputs(
    index: number,
    pairs: readonly [number, string][],
    depth: number,
  ): number {
    const name = JSON.stringify([this.id, index, pairs]);
    const known = this.root.#namedIndex.get(name);
    if (known !== undefined) return known;
    const formed = this.#formNamedInputs(index, pairs, depth);
    this.root.#namedIndex.set(name, formed);
    return formed;
  }

  /** Helper for `#namedInputs()`, which forms the inputs. */
  #formNamedInputs(
    index: number,
    pairs: readonly [number, string][],
    depth: number,
  ): number {
    const output = this.plan.outputs[index];
    const own = this.#keysFor(output.cone, pairs);
    const inputs = this.#inputsOf(output.cone, own);
    const result = this.#inputs.get(RESULT_INPUTS);
    const within = this.collectionsOf(output.cone);
    // The keys of the collections the output is within, and the others
    // given: the element an output of each element of a collection is of,
    // where its cone is within none.
    return this.#inputsFor(
      output.template,
      [
        ...within.map((collection, at): [number, string] => [
          collection,
          own[at],
        ]),
        ...pairs.filter(([collection]) => !within.includes(collection)),
      ],
      [inputs, result],
      depth,
    ).inputs;
  }

  /**
   * The elements of a `fold` over a collection, for the keys of the
   * collections around it (provisional decision P31): one set of bindings
   * at `*` where the collection is over a stored array whose elements are
   * all plain values in place and the body allows it, and otherwise the
   * groups the assembly keeps, each with the bindings of one of its
   * elements and its count. The work is the number of groups.
   */
  #foldElements(
    collection: number,
    body: Template,
    pairs: readonly [number, string][],
    depth: number,
  ): FoldElements {
    const templates = this.plan.templates ?? [];
    const inputsTable = this.root.#inputsTable;
    const outer = this.#outerOf(collection);
    const byCollection = new Map(pairs);
    const around = outer.map((step) => byCollection.get(step) ?? "?");
    const name = this.#name("assembly", collection, around);
    const table = this.#groups.get(name);
    const reached = reachedBy(body, templates);
    const cones = this.#elementCones(collection);
    const sourcesFor = (key: string) =>
      cones.map((cone) => this.#inputsOf(cone, [...around, key]));
    const keysOf = (key: string): [number, string][] => [
      ...outer.map((step, at): [number, string] => [step, around[at]]),
      [collection, key],
    ];
    if (
      this.plan.collections[collection].source.slot !== undefined &&
      isUniformBody(body, templates) && (table?.notInPlace.size ?? 0) === 0
    ) {
      const array = this.#arrayChain(name);
      const [first] = table?.byKey.keys() ?? [];
      const uniform: SlotBindings = {};
      const outputs: Record<number, number> = {};
      for (const slot of [...reached.slots].sort((a, b) => a - b)) {
        const record = this.plan.slots[slot];
        if (
          record.root.kind === "element" &&
          record.root.collection === collection
        ) {
          const last = array.at(-1);
          uniform[slot] = inputsTable.binding({
            chain: last === undefined ? [] : [
              ...array.slice(0, -1),
              { doc: last.doc, path: [...last.path, "*", ...record.path] },
            ],
            observes: record.observes,
          });
          continue;
        }
        const bound = first === undefined
          ? undefined
          : sourcesFor(first).map((source) => source?.slots.get(slot))
            .find((found) => found !== undefined);
        if (bound !== undefined) {
          uniform[slot] = inputsTable.binding(
            this.#bindingOf(slot, bound, outputs, depth),
          );
        }
      }
      return {
        uniform: inputsTable.place({
          slots: uniform,
          ...(Object.keys(outputs).length === 0 ? {} : { outputs }),
        }),
      };
    }
    const groups = [...table?.groups.values() ?? []].map((members) => {
      const [key] = members;
      const { inputs } = this.#inputsFor(
        body,
        keysOf(key),
        sourcesFor(key),
        depth,
      );
      return { inputs, count: members.size };
    });
    return { groups };
  }

  /**
   * The links an assembly crossed to its stored array, and the array's
   * position last: from the reference it found the array through.
   */
  #arrayChain(assembly: string): Address[] {
    const base = this.#memo.get(assembly)?.rows?.stored?.base;
    if (base === undefined) return [];
    const crossed: Position[] = [];
    this.#quietly(() => this.store.locate(base, true, crossed));
    return crossed.map(({ doc, path }) => ({ doc, path: [...path] }));
  }

  /**
   * On the root: the records of the paths a change wrote. A change of the
   * result document of an instance writes outputs; another change writes
   * the records of the writes being made (`#writing`).
   */
  #writesOf(
    doc: string,
    path: readonly string[],
    splice: { start: number; removed: number; inserted: number } | undefined,
  ): PlanWrite[] {
    this.#namedIndex.clear();
    const owner = doc === this.id ? this : this.#instances.get(doc);
    if (owner !== undefined && owner.id === doc) {
      return owner.#outputWrites(doc, path, splice);
    }
    // A scope instance of the document of the scoped outputs of an
    // instance holds the paths of its outputs of that scope, under the
    // records of those outputs.
    const scoped = this.store.scopes === undefined
      ? undefined
      : this.#scopedOutputsOf.get(scopeOfDocument(doc).base);
    if (scoped !== undefined) return scoped.#outputWrites(doc, path, splice);
    const valued = this.store.scopes === undefined
      ? undefined
      : this.#scopedValuesOf.get(scopeOfDocument(doc).base);
    if (valued !== undefined) {
      return valued.instance.#valueWrites(doc, path, valued);
    }
    const writing = this.#writing;
    if (writing === undefined) return [];
    const keys = writing.instance.contextKeys(writing.host.context);
    if (splice !== undefined && writing.members !== undefined) {
      return this.#memberWrites(doc, path, splice, writing, keys);
    }
    return writing.records.flatMap(({ record, template, ...target }) => {
      // A write edge the plan has no template for has no record either.
      if (template === undefined) return [];
      let at = path;
      if (target.doc !== undefined) {
        const to = target.path ?? [];
        const above = to.length <= path.length &&
          to.every((segment, index) => segment === path[index]);
        const below = path.length <= to.length &&
          path.every((segment, index) => segment === to[index]);
        if (target.doc !== doc || (!above && !below)) return [];
        if (below) at = to;
      }
      return [{
        target: { doc, path: [...at] },
        record,
        ...writing.instance.#storedInPlace(
          template,
          writing.instance.#inputsFor(
            template,
            keys,
            [{
              slots: writing.host.bound,
              selections: writing.host.selections,
              picks: writing.host.picks,
              dynamic: writing.host.dynamic,
            }],
          ),
          { doc, path: [...at] },
        ),
      }];
    });
  }

  /**
   * On the root: the records of a splice that a write through a handle made
   * of the stored list at `path` (provisional decision P39). Each member
   * added is recorded at its own position. A member the splice moved has no
   * record: the record of the membership names the runs of members that
   * moved, and the stored labels move with them (ruling Z72). The number
   * of members and the membership of the list are recorded with what the
   * list stored of its membership. Every record holds what the method
   * compared to find the members. A position before the splice is not
   * recorded: the splice left it as it was. With no splice given, the
   * method left every member as it was.
   */
  #memberWrites(
    doc: string,
    path: readonly string[],
    given: { start: number; removed: number; inserted: number } | undefined,
    writing: Writing,
    keys: [number, string][],
  ): PlanWrite[] {
    const members = writing.members!;
    const now = this.store.peek(doc, path);
    if (!Array.isArray(now)) return [];
    // With no splice, the members stay as they are: the number of members
    // and the membership are recorded, and no position.
    const kept = given === undefined;
    const splice = given ?? { start: now.length, removed: 0, inserted: 0 };
    const end = splice.start + splice.inserted;
    const moves = splice.removed !== splice.inserted && end < now.length;
    if (splice.removed > 0) members.removes = true;
    if (!kept) {
      members.start = Math.min(members.start ?? splice.start, splice.start);
    }
    if (members.origin === undefined && (moves || splice.removed > 0)) {
      members.origin = Array.from(
        { length: now.length - splice.inserted + splice.removed },
        (_, index) => index,
      );
    }
    if (members.origin !== undefined) {
      spliceIn(
        members.origin,
        splice.start,
        splice.removed,
        Array.from({ length: splice.inserted }, () => undefined),
      );
    }
    const { origin, decided } = members;
    const held = decided.length === 0 ? {} : { decided };
    // The members the writes kept at another position than the one they
    // stood at before the first splice, as runs of positions.
    const runs: { from: number; to: number; count: number }[] = [];
    (origin ?? []).forEach((from, to) => {
      if (from === undefined || from === to) return;
      const last = runs.at(-1);
      if (
        last !== undefined && last.from + last.count === from &&
        last.to + last.count === to
      ) last.count += 1;
      else runs.push({ from, to, count: 1 });
    });
    const inputsOf = (template: Template) =>
      writing.instance.#inputsFor(
        template,
        keys,
        [{
          slots: writing.host.bound,
          selections: writing.host.selections,
          picks: writing.host.picks,
          dynamic: writing.host.dynamic,
        }],
      );
    // What the list stored of its membership: the label of its number of
    // members, read at that position alone, and that of its enumeration.
    const membership: Observed[] = [
      {
        address: { doc, path: [...path, "length"] },
        observes: "value",
        alone: true,
      },
      { address: { doc, path: [...path] }, observes: "enumeration" },
    ];
    return writing.records.flatMap(({ record, template }) => {
      const writes: PlanWrite[] = [];
      // A record the plan has no template for has no inputs, and is given
      // as bound.
      if (template === undefined) {
        const bound = (target: Address) => ({
          target,
          record,
          instance: writing.instance.id,
          keys,
          inputs: this.#inputsTable.place({ slots: {} }),
          bound: true as const,
          ...held,
        });
        for (let at = splice.start; at < end; at++) {
          writes.push(bound({ doc, path: [...path, `${at}`] }));
        }
        if (kept || splice.removed !== splice.inserted) {
          writes.push({
            ...bound({ doc, path: [...path, "length"] }),
            observed: membership,
          });
        }
        writes.push({
          ...bound({ doc, path: [...path] }),
          observed: membership,
          enumeration: true,
          ...(members.removes ? { removes: true as const } : {}),
          ...(runs.length === 0 ? {} : { moves: runs }),
          ...(members.start === undefined || origin === undefined
            ? {}
            : { start: members.start }),
        });
        return writes;
      }
      // A member added is recorded at its own position with the label of
      // the write and of what the method compared, and with nothing of
      // what the list stored of its membership: an addition at the end
      // reads no member (ruling Z74).
      for (let at = splice.start; at < end; at++) {
        const target = { doc, path: [...path, `${at}`] };
        writes.push({
          target,
          record,
          ...writing.instance.#storedInPlace(
            template,
            inputsOf(template),
            target,
          ),
          ...held,
        });
      }
      const inputs = inputsOf(template);
      if (kept || splice.removed !== splice.inserted) {
        writes.push({
          target: { doc, path: [...path, "length"] },
          record,
          ...inputs,
          ...held,
          observed: membership,
        });
      }
      writes.push({
        target: { doc, path: [...path] },
        record,
        ...inputs,
        ...held,
        observed: membership,
        enumeration: true,
        ...(members.removes ? { removes: true as const } : {}),
        ...(runs.length === 0 ? {} : { moves: runs }),
        ...(members.start === undefined || origin === undefined
          ? {}
          : { start: members.start }),
      });
      return writes;
    });
  }

  /**
   * Reports the records of the membership of the stored list at `list` as
   * those of a write that left it as it was (`TransactionHooks.unchanged`),
   * for the writes being recorded through a handle.
   */
  membersKept(list: Address): void {
    const { root } = this;
    const hooks = root.options.transactions;
    const writing = root.#writing;
    if (
      root.#tx === undefined || writing?.members === undefined ||
      hooks?.unchanged === undefined
    ) return;
    root.#namedIndex.clear();
    const writes = root.#memberWrites(
      list.doc,
      list.path,
      undefined,
      writing,
      writing.instance.contextKeys(writing.host.context),
    );
    if (writes.length > 0) {
      hooks.unchanged(
        list.doc,
        list.path,
        this.store,
        undefined,
        writes,
        root.#inputsTable,
        writing.handler ? { declared: writing.declared } : undefined,
      );
    }
  }

  /**
   * The records of the outputs that a change of the result document at
   * `path` wrote: the kept output nearest at or above the path, and each
   * kept output below it, at each position the change wrote. A splice
   * wrote the positions it inserted.
   */
  #outputWrites(
    doc: string,
    path: readonly string[],
    splice: { start: number; removed: number; inserted: number } | undefined,
  ): PlanWrite[] {
    const outputs = this.#recordedOutputs();
    const found: { output: number; at: string[]; members?: true }[] = [];
    let nearest: number | undefined;
    outputs.forEach((output, index) => {
      if (
        output.path.length <= path.length &&
        matchesPath(output.path, path) &&
        (nearest === undefined ||
          output.path.length > outputs[nearest].path.length)
      ) nearest = index;
    });
    if (nearest !== undefined) {
      const { output, path: at, members } = outputs[nearest];
      found.push({
        output,
        at: [...path],
        ...(members && at.length === path.length ? { members } : {}),
      });
    }
    const held = this.store.peek(doc, path);
    outputs.forEach((output) => {
      const index = output.output;
      if (
        output.path.length <= path.length ||
        !matchesPath(output.path.slice(0, path.length), path)
      ) return;
      const expand = (
        at: string[],
        rest: readonly string[],
        value: unknown,
        first: boolean,
      ): void => {
        if (rest.length === 0) {
          if (value !== undefined) {
            found.push({
              output: index,
              at,
              ...(output.members ? { members: output.members } : {}),
            });
          }
          return;
        }
        const [segment, ...more] = rest;
        if (segment !== "*") {
          expand(
            [...at, segment],
            more,
            typeof value === "object" && value !== null && !isLink(value)
              ? (value as Record<string, unknown>)[segment]
              : undefined,
            false,
          );
          return;
        }
        if (!Array.isArray(value)) return;
        const [start, end] = first && splice !== undefined
          ? [splice.start, splice.start + splice.inserted]
          : [0, value.length];
        for (let position = start; position < end; position++) {
          expand([...at, `${position}`], more, value[position], false);
        }
      };
      expand([...path], output.path.slice(path.length), held, true);
    });
    // An output the plan has no template for has a record with no inputs:
    // the runtime gives its path the label of a write it has no record of,
    // where it would otherwise take the label of a kept output above it.
    // A change that wrote the array of a kept output that holds the result
    // of a per-element construct, at the array or above it, other than by
    // an addition at its end, decides anew which member stands at each
    // position, and an addition at its end leaves each member before it
    // where it stood. A write above the array writes it whole.
    const appends = splice !== undefined && Array.isArray(held) &&
      splice.removed === 0 && splice.start + splice.inserted === held.length;
    return found.map(({ output, at, members }) => {
      const write = this.#outputRecord(doc, output, at);
      this.root.#noteRecord(this.#recordKey(output, at), this.id, write);
      if (members !== true || !Array.isArray(this.store.peek(doc, at))) {
        return write;
      }
      return appends && at.length === path.length
        ? { ...write, membersAppended: true as const }
        : { ...write, membersChanged: true as const };
    });
  }

  /**
   * The outputs a change of the result document is recorded for, each with
   * the path of the result document it is stored at: every kept output,
   * and for a kept output that holds the result of a per-element construct
   * of another output with no entry of its own for an element, each entry
   * of that construct's elements, at its path below the kept output. The
   * label of what an element holds is then that of the element's own
   * entry, and not that of the collection's membership. A kept output
   * that holds such a result as a branch of a `select` has no entry for
   * an element: its records are `bound`, and the runtime gives their
   * paths the label of a write it has no record of.
   */
  #recordedOutputs(): RecordedOutput[] {
    if (this.#recorded !== undefined) return this.#recorded;
    const { outputs } = this.plan;
    const templates = this.plan.templates ?? [];
    const found: RecordedOutput[] = [];
    const hasElementEntry = (path: readonly string[]) =>
      outputs.some((output) =>
        output.kept && output.path.length > path.length &&
        output.path[path.length] === "*" &&
        path.every((segment, index) => output.path[index] === segment)
      );
    // The output with a collection that a template gives the label of,
    // and whether it does so through no `select`.
    const collectionOf = (
      template: Template | undefined,
      direct: boolean,
      depth: number,
    ): { output: number; direct: boolean } | undefined => {
      // A chain of outputs is as long as the plan is deep.
      if (template === undefined || depth > 64) return undefined;
      switch (template.op) {
        case "shared":
          return collectionOf(templates[template.template], direct, depth + 1);
        case "output": {
          const named = outputs[template.output];
          return named?.collection !== undefined
            ? { output: template.output, direct }
            : collectionOf(named?.template, direct, depth + 1);
        }
        case "select":
          for (const branch of template.branches) {
            const through = collectionOf(branch, false, depth + 1);
            if (through !== undefined) return through;
          }
          return undefined;
        default:
          return undefined;
      }
    };
    const add = (output: number, path: readonly string[], depth: number) => {
      const record = outputs[output];
      const entry: RecordedOutput = { output, path };
      found.push(entry);
      if (record.collection !== undefined && record.kept) entry.members = true;
      if (record.collection !== undefined || depth > 64) return;
      if (record.kept && hasElementEntry(record.path)) return;
      const held = collectionOf(record.template, true, 0);
      if (held === undefined) return;
      if (!held.direct) {
        entry.bound = true;
        return;
      }
      entry.members = true;
      const source = outputs[held.output];
      outputs.forEach((element, index) => {
        if (
          index !== held.output && element.cone === source.cone &&
          element.path.length > source.path.length &&
          element.path[source.path.length] === "*" &&
          source.path.every((segment, at) => element.path[at] === segment)
        ) {
          add(
            index,
            [...path, ...element.path.slice(source.path.length)],
            depth + 1,
          );
        }
      });
    };
    // An interim output is no path of the result document.
    outputs.forEach((output, index) => {
      if (output.kept) add(index, output.path, 0);
    });
    this.#recorded = found;
    return found;
  }

  /** The result of `#recordedOutputs()`, made once. */
  #recorded: RecordedOutput[] | undefined;

  /**
   * What names the inputs of the cone instance of an output for the element
   * keys given, such that two elements with one name are given one label by
   * the output's template: the output, and for each slot its cone instance
   * bound the identifiers of the labels at the positions it was bound to
   * (`TransactionHooks.labelOf`), with the branches and the children
   * chosen, and the same of each output the template names. Nothing where
   * the template has a `fold` or a `dynamic` node, where it reaches a slot
   * no evaluation bound, where the store names no identifier for a
   * position, as for one the transaction in progress wrote, or where the
   * target holds a value in place and the template has a slot of the class
   * `identity`, which `#storedInPlace` binds again by the target. The
   * identifiers are asked for at each call: a label can change while the
   * bindings stay.
   */
  #shareKey(
    index: number,
    pairs: readonly [number, string][],
    linked: boolean,
    depth = 0,
  ): string | undefined {
    if (this.root.options.transactions?.labelOf === undefined) return undefined;
    // A chain of outputs is as long as the plan is deep.
    if (depth > 64) return undefined;
    const output = this.plan.outputs[index];
    const templates = this.plan.templates ?? [];
    let shape = this.#shareShapes.get(index);
    if (shape === undefined) {
      const reached = reachedBy(output.template, templates);
      const slots = [
        ...reached.slots,
        ...[...reached.picks.values()].flatMap((body) => [
          ...reachedBy(body, templates).slots,
        ]),
      ];
      shape = {
        reached,
        shareable: reached.folds.size === 0 && reached.dynamic.size === 0,
        identity: slots.some((slot) =>
          this.plan.slots[slot].observes === "identity"
        ),
      };
      this.#shareShapes.set(index, shape);
    }
    if (!shape.shareable || (!linked && shape.identity)) return undefined;
    const inputs = this.#inputsOf(
      output.cone,
      this.#keysFor(output.cone, pairs),
    );
    const result = this.#inputs.get(RESULT_INPUTS);
    if (inputs === undefined) return undefined;
    const bound = (slot: number) =>
      inputs.slots.has(slot) || result?.slots.has(slot) === true;
    for (const slot of shape.reached.slots) {
      if (!bound(slot)) return undefined;
    }
    for (const body of shape.reached.picks.values()) {
      for (const slot of reachedBy(body, templates).slots) {
        if (!bound(slot)) return undefined;
      }
    }
    const own = this.#labelsOf(inputs, pairs, 0);
    if (own === undefined) return undefined;
    const parts = [`${index}`, own];
    for (const named of [...shape.reached.outputs].sort((a, b) => a - b)) {
      const below = this.#shareKey(named, pairs, linked, depth + 1);
      if (below === undefined) return undefined;
      parts.push(`(${below})`);
    }
    return parts.join(" ");
  }

  /**
   * Helper for `#shareKey()`: the identifiers of the labels at the
   * positions a cone instance bound its slots to, as `#idOf` forms them,
   * asked for at this call and kept nowhere. Nothing where the store names
   * no identifier for one of the positions.
   */
  #labelsOf(
    inputs: ConeInputs,
    pairs: readonly [number, string][],
    depth: number,
  ): string | undefined {
    if (depth > 64) return undefined;
    const parts: string[] = [];
    for (const [slot, bound] of [...inputs.slots].sort(([a], [b]) => a - b)) {
      if ("constant" in bound) {
        parts.push(`${slot}:constant`);
        continue;
      }
      if ("place" in bound) return undefined;
      if ("output" in bound) {
        const { cone } = this.plan.outputs[bound.output];
        const upstream = this.#inputsOf(cone, this.#keysFor(cone, pairs));
        const id = upstream === undefined
          ? undefined
          : this.#labelsOf(upstream, pairs, depth + 1);
        if (id === undefined) return undefined;
        parts.push(`${slot}>${bound.output}<${id}>`);
        continue;
      }
      if ("upstream" in bound) {
        const { collection, keys } = bound.upstream;
        const ids: string[] = [];
        for (const cone of this.#elementCones(collection)) {
          const upstream = this.#inputsOf(cone, this.#keysFor(cone, keys));
          const id = upstream === undefined
            ? undefined
            : this.#labelsOf(upstream, keys, depth + 1);
          if (id === undefined) return undefined;
          ids.push(id);
        }
        const read = new Set<string>();
        if (bound.through !== undefined) {
          for (const address of this.#addressesOf(bound.through.at)) {
            const label = this.#labelKey(address, bound.through.observes);
            if (label === undefined) return undefined;
            read.add(label);
          }
        }
        parts.push(
          `${slot}<${ids.join("|")}>${
            read.size === 0 ? "" : `@${[...read].sort().join(",")}`
          }`,
        );
        continue;
      }
      const labels = new Set<string>();
      for (const address of this.#addressesOf(bound.at)) {
        const label = this.#labelKey(address, bound.observes);
        if (label === undefined) return undefined;
        labels.add(label);
      }
      parts.push(`${slot}:${bound.observes}:${[...labels].sort().join(",")}`);
    }
    for (
      const [selector, branch] of [...inputs.selections].sort(([a], [b]) =>
        a - b
      )
    ) parts.push(`s${selector}=${branch}`);
    for (const [pick, key] of [...inputs.picks].sort(([a], [b]) => a - b)) {
      parts.push(`p${pick}=${JSON.stringify(key)}`);
    }
    return parts.join(";");
  }

  /**
   * Whether no binding the inputs at `index` name, directly or through the
   * inputs they name, covers the members of a container: such a binding
   * names the container of one element, and the records that read it are
   * found by that container.
   */
  #namesNoMembers(index: number): boolean {
    const table = this.root.#inputsTable;
    const visited = new Set<number>();
    const none = (at: number): boolean => {
      if (visited.has(at)) return true;
      visited.add(at);
      const place = table.inputs[at];
      const plain = (slots: SlotBindings) =>
        Object.values(slots).every((binding) => {
          const found = table.bindings[binding];
          return !("chain" in found) || found.members === undefined;
        });
      return plain(place.slots) &&
        Object.values(place.picks ?? {}).every((chosen) =>
          chosen === null || plain(chosen.slots)
        ) &&
        Object.values(place.outputs ?? {}).every(none) &&
        Object.values(place.elements ?? {}).every((elements) =>
          "uniform" in elements
            ? none(elements.uniform)
            : elements.groups.every(({ inputs }) => none(inputs))
        );
    };
    return none(index);
  }

  /**
   * The record of the output `output` of this instance at the path `at`:
   * of the cone instance of the element keys along the path, or of
   * `keysOfPlace` where the document holds the value of those keys alone.
   */
  #outputRecord(
    doc: string,
    output: number,
    at: string[],
    keysOfPlace?: readonly [number, string][],
  ): PlanWrite {
    const record = this.plan.outputs[output];
    // The path the output is stored at, which for the entry of an element
    // is below the kept output that holds the collection.
    const stored =
      this.#recordedOutputs().filter((entry) =>
        entry.output === output && entry.path.length <= at.length &&
        matchesPath(entry.path, at)
      ).sort((a, b) => b.path.length - a.path.length)[0];
    const stars = (stored?.path ?? record.path).flatMap((segment, index) =>
      segment === "*" ? [index] : []
    );
    const pairs = keysOfPlace === undefined
      ? this.#keysAlong(at, stars)
      : [...keysOfPlace];
    const ownKeys = this.#keysFor(record.cone, pairs);
    const inputs = this.#inputsOf(record.cone, ownKeys);
    const result = this.#inputs.get(RESULT_INPUTS);
    const keyed = this.collectionsOf(record.cone).map((
      collection,
      index,
    ): [number, string] => [collection, ownKeys[index]]);
    // The entry of an element whose inputs hold the labels another
    // element's hold names that element's inputs: the template gives both
    // the same label, and the runtime is given one record for the two.
    const held = this.store.peek(doc, at);
    const shared = pairs.length === 0 ? undefined : this.#shareKey(
      output,
      keyed,
      held === undefined || isLink(held) || isStream(held),
    );
    const sharing = shared === undefined
      ? undefined
      : `${this.id}\n${stored?.bound === true}\n${shared}`;
    const first = sharing === undefined
      ? undefined
      : this.root.#sharedInputs.get(sharing);
    let given: NamedOutputInputs;
    if (first !== undefined && first >= 0) {
      given = { instance: this.id, keys: keyed, inputs: first };
      const own: Address[] = [];
      this.#readBy(output, keyed, (address) => own.push(address), false);
      this.root.#ownReads.set(this.#recordKey(output, at), own);
    } else {
      given = this.#heldByReference(
        this.#storedInPlace(
          record.template,
          this.#inputsFor(record.template, keyed, [inputs, result]),
          { doc, path: at },
        ),
        held,
      );
      if (sharing !== undefined && first === undefined) {
        this.root.#sharedInputs.set(
          sharing,
          this.#namesNoMembers(given.inputs) ? given.inputs : -1,
        );
      }
    }
    // The entry of an element held below a kept output, with a slot the
    // executor has no position for, as that of an element of an array a
    // computation returned: the record is given as bound, and the path
    // takes the label of a write with no record, where the template could
    // only be refused.
    const templates = this.plan.templates ?? [];
    const table = this.root.#inputsTable;
    const own = table.inputs[given.inputs];
    const lacks = (
      template: Template | undefined,
      place: PlanInputs | undefined,
      depth: number,
    ): boolean => {
      // A chain of outputs is as long as the plan is deep.
      if (template === undefined || depth > 64) return false;
      switch (template.op) {
        case "slot": {
          const at = place?.slots[template.slot] ?? own.slots[template.slot];
          const binding = at === undefined ? undefined : table.bindings[at];
          return binding === undefined ||
            ("chain" in binding && binding.chain.length === 0);
        }
        case "derive":
          return template.inputs.some((input) =>
            lacks(input, place, depth + 1)
          );
        case "select":
          return lacks(template.condition, place, depth + 1) ||
            template.branches.some((branch) => lacks(branch, place, depth + 1));
        case "shared":
          return lacks(templates[template.template], place, depth + 1);
        case "output": {
          const at = place?.outputs?.[template.output] ??
            own.outputs?.[template.output];
          return lacks(
            this.plan.outputs[template.output]?.template,
            at === undefined ? undefined : table.inputs[at],
            depth + 1,
          );
        }
        default:
          return false;
      }
    };
    const unbound = !record.kept && lacks(record.template, own, 0);
    return {
      target: { doc, path: at },
      record: { output },
      ...given,
      ...(stored?.bound || unbound ? { bound: true as const } : {}),
    };
  }

  /**
   * The inputs of a write that stored, at its target, a reference to the
   * position of a bucket of a kept index whose buckets are documents of
   * their own (`bucketPlaces`): the inputs given, with those of the output
   * of the index replaced by inputs under which that output has no label,
   * every slot a constant and every `fold` without an element. The label
   * of the index is stored once, at the output of the index, which stands
   * above the position the reference names, and a read through the
   * reference consumes it there. The label of the target is then that of
   * the key the bucket was looked up by, and a change of the membership of
   * the index gives no record of the target again.
   */
  #heldByReference<T extends { inputs: number }>(inputs: T, held: unknown): T {
    if (!isLink(held) || held.$link.doc !== this.id) return inputs;
    const record = JSON.stringify(held.$link.path.slice(0, -1));
    const index = this.#bucketOutputs().find((kept) =>
      JSON.stringify(kept.record) === record
    );
    const table = this.root.#inputsTable;
    const place = table.inputs[inputs.inputs];
    const named = index === undefined
      ? undefined
      : place.outputs?.[index.output];
    if (index === undefined || named === undefined) return inputs;
    // A chain of outputs is as long as the plan is deep.
    const without = (at: number, depth: number): number => {
      const { slots, selections, picks, elements, dynamic, outputs } =
        table.inputs[at];
      const each = <T, U>(of: Record<number, T>, to: (value: T) => U) =>
        Object.fromEntries(
          Object.entries(of).map(([name, value]) => [name, to(value)]),
        );
      const constant = table.binding({ constant: true });
      return table.place({
        slots: each(slots, () => constant),
        ...(selections === undefined ? {} : { selections }),
        ...(picks === undefined ? {} : { picks: each(picks, () => null) }),
        ...(dynamic === undefined ? {} : { dynamic: each(dynamic, () => []) }),
        ...(outputs === undefined || depth > 64 ? {} : {
          outputs: each(outputs, (below) => without(below, depth + 1)),
        }),
        ...(elements === undefined ? {} : {
          elements: each(elements, (): FoldElements => ({ groups: [] })),
        }),
      });
    };
    return {
      ...inputs,
      inputs: table.place({
        ...place,
        outputs: { ...place.outputs, [index.output]: without(named, 0) },
      }),
    };
  }

  /**
   * The inputs of a write whose template gives the label of one slot of
   * the class `identity`, directly, through the outputs it names or as a
   * branch of a `select`, with that slot bound in the class `value` where
   * the write stored a value at `target` and no reference: what a `reduce`
   * computed, a copy of an array that a spread child holds, or the value
   * of a cell that `a.get() ?? b` gives. The label of the stored value is
   * then that of what the slot's positions hold, and not that of the
   * reference alone.
   */
  #storedInPlace<T extends { inputs: number }>(
    template: Template | undefined,
    inputs: T,
    target: Address,
  ): T {
    const held = this.store.peek(target.doc, target.path);
    if (held === undefined || isLink(held) || isStream(held)) return inputs;
    const templates = this.plan.templates ?? [];
    const table = this.root.#inputsTable;
    // The index of the inputs at `index` with the slot bound again, which
    // is `index` where nothing is.
    const rebound = (
      at: Template | undefined,
      index: number | undefined,
      depth: number,
    ): number | undefined => {
      // A chain of outputs is as long as the plan is deep.
      if (at === undefined || index === undefined || depth > 64) return index;
      const place = table.inputs[index];
      switch (at.op) {
        case "shared":
          return rebound(templates[at.template], index, depth + 1);
        case "output": {
          const named = place.outputs?.[at.output];
          const again = rebound(
            this.plan.outputs[at.output]?.template,
            named,
            depth + 1,
          );
          return again === undefined || again === named ? index : table.place({
            ...place,
            outputs: { ...place.outputs, [at.output]: again },
          });
        }
        case "select": {
          let now: number | undefined = index;
          for (const branch of at.branches) {
            now = rebound(branch, now, depth + 1);
          }
          return now;
        }
        case "slot": {
          const bound = place.slots[at.slot];
          const binding = bound === undefined
            ? undefined
            : table.bindings[bound];
          if (
            binding === undefined || !("chain" in binding) ||
            binding.observes !== "identity" || binding.chain.length === 0
          ) return index;
          // A read of the value goes through each link the value holds.
          const last = binding.chain[binding.chain.length - 1];
          const reads: Position[] = [];
          this.#quietly(() =>
            this.store.read(new Ref(last.doc, last.path), reads)
          );
          const seen = new Set<string>();
          const addresses = [
            ...binding.chain,
            ...this.#addressesOf(reads),
          ].filter(({ doc, path }) => {
            const id = JSON.stringify([doc, path]);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          });
          // The members of a container the reference's read covered are
          // covered by the read of the value: the positions are the same,
          // and their labels as values are grouped by a table of their own.
          const presumed = (binding.members ?? []).flatMap(({ container }) =>
            [
              ...this.root.#memberGroupsAt.get(
                memberGroupsPlace(container.doc, container.path),
              ) ?? [],
            ].filter((groups) => groups.observes === "identity")
          );
          return table.place({
            ...place,
            slots: {
              ...place.slots,
              [at.slot]: table.binding(
                this.#chainsOf(addresses, "value", presumed),
              ),
            },
          });
        }
        default:
          return index;
      }
    };
    const again = rebound(template, inputs.inputs, 0);
    return again === undefined || again === inputs.inputs
      ? inputs
      : { ...inputs, inputs: again };
  }

  /**
   * The element keys of the rows a path of the result document passes
   * through, at the positions `stars` names: each from the unit that
   * stores the rows of a collection there.
   */
  #keysAlong(
    path: readonly string[],
    stars: readonly number[],
  ): [number, string][] {
    const keys: [number, string][] = [];
    let inside: Map<string, Unit> | undefined = this.#rootUnits;
    let base = 0;
    for (const star of stars) {
      if (star >= path.length) break;
      const unit: Unit | undefined = inside?.get(
        JSON.stringify(path.slice(base, star)),
      );
      const key = unit?.keys[Number(path[star])];
      if (unit === undefined || key === undefined) break;
      // The body of a `flatMap` runs once for a source element, and each
      // member of the segment it gave has that element's key in its own.
      const source =
        this.plan.collections[unit.collection].construct === "flatMap"
          ? recordOfKey(key).source
          : undefined;
      keys.push([unit.collection, source !== undefined ? textOf(source) : key]);
      inside = unit.inside.get(key);
      base = star + 1;
    }
    return keys;
  }

  /**
   * What the handler being run declares for a write through `through`
   * (`DeclaredWrite`), as the member of a `Writing`, or nothing where the
   * handle has no declared type or names no stored position.
   */
  #declaredWrite(through: Handle): { declared?: DeclaredWrite } {
    const { target, declared } = partsOf(through);
    if (!(target instanceof Ref) || typeof declared !== "object") return {};
    const located = this.store.locate(target, true);
    if (located.missing) return {};
    const { doc, path } = located.ref;
    return { declared: { doc, path, schema: declared } };
  }

  /**
   * Counts a write of the handler being run against its record, and
   * makes the write edge that covers it, of the handler or of the body of
   * a cone being run, the record of the writes until the returned
   * function is called.
   */
  written(
    handle: Handle,
    decided?: Observed[],
    /** Whether a write is made, which is counted. */
    counted = true,
    /**
     * The handle whose declared type the write is made under, where that
     * is another than `handle`: the list, for a write of its members.
     */
    through: Handle = handle,
  ): () => void {
    const invoking = this.#invoking.at(-1);
    const index = this.#handling ?? invoking?.body;
    const host = this.#handling === undefined
      ? invoking?.host
      : this.#handlerHost;
    if (index === undefined) return () => {};
    if (counted) this.#noteCreatedWrite(handle);
    const body = this.plan.bodies[index];
    const covers = (target: { slot?: number; path?: string[] }) =>
      target.slot === partsOf(handle).slot &&
      (matchesPath(target.path ?? [], partsOf(handle).below) ||
        matchesPath(partsOf(handle).below, target.path ?? []));
    const write = body.writes.findIndex(({ target }) =>
      target.kind === "handle" && covers(target)
    );
    if (this.#handling !== undefined && counted) {
      const covered = write >= 0 ||
        body.envelopes.some((envelope) =>
          envelope.kind === "handle" && covers(envelope)
        );
      if (covered) this.counts.writesCovered += 1;
      else this.counts.writesNotCovered += 1;
    }
    // A write that no write edge covers has the record of the envelope
    // that covers it, which has no template: a change it makes of a list's
    // members is recorded with no inputs, and the runtime gives each record
    // the label of a write it has no record of.
    const envelope = body.envelopes.findIndex((each) =>
      each.kind === "handle" && covers(each)
    );
    return this.#recording(
      host === undefined ? undefined : {
        instance: this,
        host,
        records: write >= 0
          ? [{
            record: { body: index, write },
            template: body.writes[write].template,
          }]
          : envelope >= 0
          ? [{ record: { body: index, envelope }, template: undefined }]
          : [],
        members: { decided: decided ?? [] },
        ...(this.#handling === undefined
          ? {}
          : { handler: true as const, ...this.#declaredWrite(through) }),
      },
    );
  }

  /**
   * Sends an event to the stream of a binding of the reactive tier. For a
   * binding of an element body, `positions` gives the position of the
   * element in each enclosing collection, outermost first, and the last
   * element where it gives none.
   */
  send(binding: number, event: unknown, positions: number[] = []): Outcome {
    const refused = this.enqueue(binding, event, positions);
    if (refused !== undefined) {
      return { binding, committed: false, error: refused };
    }
    const [outcome] = this.batch();
    return outcome;
  }

  /**
   * Handles the events that are queued, as one that a writer outside the
   * instance sent through a stored link to a stream, and evaluates what
   * read a position their handlers wrote. Returns how each ended.
   */
  dispatch(): Outcome[] {
    return this.batch();
  }

  /** Handles the queued events, each in the instance its stream is of. */
  #drain(outcomes: Outcome[]): void {
    for (let next = this.#queue.shift(); next; next = this.#queue.shift()) {
      const target = next.stream.instance === ""
        ? this
        : this.#instances.get(next.stream.instance);
      const handled = target === undefined
        ? {
          binding: next.stream.binding,
          committed: false,
          error: "the stream of an instance that does not exist",
        }
        : target.#handle(
          next.stream,
          next.event,
          next.context ?? target.#contextOf(next.stream),
        );
      // The watermark of the stream passes the entry, whatever became
      // of the event (SS §5.5).
      this.#passed(next.stream);
      outcomes.push(handled);
    }
  }

  /**
   * The elements a stream's keys name, outermost first: each from the
   * element table that its collection has for the elements found
   * around it, so a key that two tables of an inner collection hold
   * names the element of the enclosing element of the stream.
   */
  #contextOf(stream: StreamRef): Context {
    const context = new Map<number, Element>();
    let step = 0;
    for (
      const { element } of this.plan.bindings[stream.binding]?.within ?? []
    ) {
      if (element === undefined) continue;
      const key = stream.keys[step];
      step += 1;
      const found = this.#tables.get(
        this.#name(
          "assembly",
          element,
          this.#keysIn(this.#outerOf(element), context),
        ),
      )?.byKey.get(key);
      if (found !== undefined) context.set(element, found);
    }
    return context;
  }

  /**
   * Handles one event in a transaction of its own (SS §5.2): the stale
   * cone instances that compute what the handler reads, and then the
   * body. An event whose handler does not run to its end, or whose
   * write the stand-in for the constraints refuses, stores nothing
   * (SS §5.5).
   */
  #handle(stream: StreamRef, event: unknown, context: Context): Outcome {
    const { root } = this;
    const open = root.#begin("event", stream.binding);
    const queued = root.#queue.length;
    const requested = root.requests.length;
    const sent = root.#outbox.length;
    // The instances are held in the order they were made, so those of
    // an event that does not commit are the ones behind this count.
    const instances = root.#instances.size;
    const bound = root.#bound.size === 0 ? undefined : new Map(root.#bound);
    const children = this.#children.length;
    let outcome: Outcome;
    try {
      outcome = this.#attempt(stream, event, context);
    } catch (error) {
      root.#tx = undefined;
      this.store.journal = undefined;
      root.options.transactions?.end({
        committed: false,
        changes: [],
        store: this.store,
      });
      throw error;
    }
    if (outcome.committed) {
      const { refuses } = root.options;
      const own = refuses === undefined
        ? []
        : open.writes.get(`${this.id}\n${HANDLER}`)?.at ?? [];
      for (const write of own) {
        const refusal = refuses?.({ binding: stream.binding, ...write });
        if (refusal === undefined) continue;
        outcome = { binding: stream.binding, committed: false, error: refusal };
        break;
      }
    }
    if (outcome.committed) {
      root.#rekey();
    } else {
      root.#abort(open);
      root.#queue.length = queued;
      root.requests.length = requested;
      // A request of the body does not leave.
      for (const { operation } of root.#outbox.splice(sent)) {
        root.#operations.delete(operation);
      }
      if (root.#instances.size > instances) {
        for (const id of [...root.#instances.keys()].slice(instances)) {
          const made = root.#instances.get(id);
          if (made !== undefined) root.#awaitingFirst.delete(made);
          root.#instances.delete(id);
        }
        for (const [name, { instance }] of [...root.#made]) {
          if (!root.#instances.has(instance.id)) root.#made.delete(name);
        }
      }
      root.#bound.clear();
      for (const [key, held] of bound ?? []) root.#bound.set(key, held);
      this.#children.length = children;
      this.store.rekeys.length = 0;
    }
    root.#end(open, outcome.committed, outcome.error);
    return outcome;
  }

  #attempt(stream: StreamRef, event: unknown, context: Context): Outcome {
    const binding = stream.binding;
    const record = this.plan.bindings[binding];
    if (record === undefined) {
      // A binding a function body made: the handler, with the state the
      // body bound.
      const bound = this.root.#bound.get(stream.keys[0]);
      if (bound === undefined) {
        return {
          binding,
          committed: false,
          error: "the stream of a binding that does not exist",
        };
      }
      return this.handing(
        bound.handed ?? new HandedValues(this.store),
        () => this.#run(binding, undefined, bound.run, event, bound.state),
      );
    }
    // A binding of an element body has its stream while its key is in
    // the collection: an event for the stream of a key that left is
    // refused (ES §2.6; ruling Z35). An instance called through
    // `asInstance()` has its bindings in its own plan, with no step of
    // the enclosing collection, and is not concerned.
    const away = record.within.some((step) =>
      step.element !== undefined && !context.has(step.element)
    );
    if (away) {
      return {
        binding,
        committed: false,
        error: "no element holds the stream",
      };
    }
    this.#evaluateStoredRows(record.within, context);
    const body = record.handler.body;
    const run = body === undefined
      ? undefined
      : this.#handlers.get(binding) ?? this.bodies.get(body);
    if (body === undefined || run === undefined) {
      return { binding, committed: false, error: "the handler has no body" };
    }
    // A handler is given the reference its row's cones hold for the
    // element (ES §2.6, "A handler bound in the body").
    const host = new Host(this, context, undefined);
    const handed = new HandedValues(this.store);
    // The state: each slot of the body with root `binding`, resolved to
    // the place the binding's state entry names (PL §1.1).
    let state: unknown = {};
    const slots = this.plan.bodies[body].reads
      .map(({ slot }) => ({ slot, record: this.plan.slots[slot] }))
      .filter(({ record }) => record.root.kind === "binding")
      .sort((a, b) => a.record.path.length - b.record.path.length);
    for (const { slot, record: read } of slots) {
      const star = read.path.indexOf("*");
      if (star >= 0) continue;
      const entry = record.state
        .filter((entry) => matchesPath(entry.path, read.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (entry?.place === undefined) continue;
      const rest = read.path.slice(entry.path.length);
      const { place } = entry;
      const from = host.reads.length;
      let found: unknown;
      // The state entry is a reference to a kept output's stored position.
      let reference = false;
      if (place.slot !== undefined) {
        const bound = this.plan.slots[place.slot];
        // A cell that a cone writes statically: the writing cone
        // instance is evaluated first where it is stale (ES §1.3). A
        // slot that observes the reference alone reads nothing that the
        // cone computes.
        if (
          read.observes !== "identity" ||
          this.root.options.beforeBody === "bound"
        ) {
          host.demand(bound.root, [...bound.path, ...rest]);
        }
        found = host.at(this.rootOf(bound.root, host), [
          ...bound.path,
          ...rest,
        ]);
        if (found instanceof Ref) {
          found = found.withSchema(
            rest.reduce(schemaBelow, this.schemaOf(bound.schema)),
          );
        }
        // The default the callee declares for the path, applied when
        // the state path is resolved (PL §8, question 110, assumed).
        if (entry.default !== undefined) {
          const declared = rest.reduce(
            (below: unknown, segment) =>
              typeof below === "object" && below !== null
                ? (below as Record<string, unknown>)[segment]
                : undefined,
            entry.default,
          );
          if (declared !== undefined) {
            found = found instanceof Ref
              ? found.withDefault(declared)
              : host.withDefault(found, declared);
          }
        }
      } else if (place.output !== undefined) {
        // A kept output of the pattern that the handler observes as a
        // reference alone: the reference is to the position of the result
        // document that holds the output, which the plan and the instance
        // decide and nothing the output holds does (PL §2.2). A read
        // through the handle is a read of that position, under the label
        // stored there.
        const held = read.observes === "identity"
          ? this.#keptPlace(place.output, record.within.length)
          : undefined;
        if (held !== undefined) reference = true;
        found = held !== undefined
          ? new Ref(this.id, [...held, ...rest])
          : host.whole(host.at(host.output(place.output), rest));
      } else if (place.stream !== undefined) {
        found = this.streamFor(place.stream, context);
      } else if (place.result === true) {
        // The name bound to `[SELF]`: a reference to the result cell of
        // the instance, as value code is given one (ruling Z28).
        found = host.at(new Ref(this.id, []), rest);
      } else {
        found = host.at(place.constant, rest);
      }
      // A handler that receives an error state for one of its inputs
      // fails (SS §5.5).
      if (isErrorState(found)) {
        return {
          binding,
          committed: false,
          error: `the handler reads a failed value: ${found.$error.message}`,
        };
      }
      // An `enumeration` or a `shape` entry gives way to a handle the
      // state holds at or above its path (`gives`): the body reaches each
      // child through that handle. The read is then of which children the
      // container has, and follows no link a child holds.
      const givesWay = read.observes !== "identity" &&
        read.observes !== "value" &&
        this.gives(read.observes, state, read.path);
      let given = read.observes === "identity"
        ? this.handleOf(found, undefined, slot)
        : host.v(found, givesWay ? CHILDREN_UNREAD : undefined);
      if (read.observes !== "identity") handed.note(given);
      // A write through a handle to a value the instance computes fails
      // (PL §3.11).
      if (reference && given instanceof Handle) {
        given = given.refusingWrites(this);
      }
      this.bindSlot(host, slot, from, found);
      // A literal the binding gives its state is a constant of the plan:
      // the slot contributes no label, where it read nothing else. A value
      // the pattern computes is an output, which read no stored position.
      const held = host.bound.get(slot);
      if (
        held !== undefined && "at" in held && held.at.length === 0
      ) {
        if (place.constant !== undefined) {
          host.bound.set(slot, { constant: true });
        } else if (place.output !== undefined) {
          // A reference to the stored position of a kept output is a
          // constant of the plan: an `identity` slot does not reach the
          // target (PL §2.2). A copy of what the output holds, which the
          // handler is given where the output has no stored position of
          // its own, carries the output's label.
          host.bound.set(
            slot,
            reference ? { constant: true } : { output: place.output },
          );
        } else if (place.slot !== undefined) {
          host.bound.set(slot, { place: { slot: place.slot, rest } });
        }
      }
      if (this.gives(read.observes, state, read.path)) continue;
      // An entry that yields nothing places nothing: an entry below a
      // path that is absent does not make a container there (ES §2.4,
      // "A path the body does not read is absent from the argument").
      if (given === undefined) continue;
      state = this.handing(
        handed,
        () => this.placed(state, read.path, given),
      );
    }
    this.#bindEvent(host, body, stream);
    return this.handing(
      handed,
      () => this.#run(binding, body, run, event, state, host),
    );
  }

  /**
   * The path of the result document that holds the output `index`, where
   * a binding written within `depth` elements can name it by a reference
   * that the plan decides: the output is kept, at a path with no element
   * position, and the binding is in no element. Otherwise nothing.
   */
  #keptPlace(index: number, depth: number): readonly string[] | undefined {
    const output = this.plan.outputs[index];
    return output.kept && depth === 0 && !output.path.includes("*")
      ? output.path
      : undefined;
  }

  /**
   * Binds each slot of root `event` of a handler's body to the position
   * of the event in its stream's document: the entry the watermark stands
   * at, which is the event being handled. An event that no entry of the
   * document holds binds nothing.
   */
  #bindEvent(host: Host, body: number, stream: StreamRef): void {
    const id = this.root.#streamIdentifier(stream);
    const held = this.store.docs.get(id)?.value as
      | { entries?: unknown[]; eventWatermark?: number }
      | undefined;
    const at = held?.eventWatermark ?? 0;
    if (!Array.isArray(held?.entries) || held.entries[at] === undefined) {
      return;
    }
    for (const { slot } of this.plan.bodies[body].reads) {
      const record = this.plan.slots[slot];
      if (record.root.kind !== "event") continue;
      host.bound.set(slot, {
        observes: record.observes,
        at: [{ doc: id, path: ["entries", `${at}`, "event", ...record.path] }],
      });
    }
  }

  /**
   * Runs the body of a handler for an event, and says whether it ran to
   * its end.
   */
  #run(
    binding: number,
    body: number | undefined,
    run: (...given: unknown[]) => unknown,
    event: unknown,
    state: unknown,
    host?: Host,
  ): Outcome {
    const { root } = this;
    root.#events += 1;
    this.#handling = body;
    const outer = this.#handlerHost;
    this.#handlerHost = host;
    // What the body writes is the handler's own (SS §5.6).
    root.#evaluating.push({ instance: this, key: HANDLER });
    try {
      this.during(
        { handling: { parent: root.id, event: root.#events } },
        () => run(event, state),
      );
    } catch (error) {
      if (ranOut(error)) throw error;
      return { binding, committed: false, error: messageOf(error) };
    } finally {
      this.#handling = undefined;
      this.#handlerHost = outer;
      root.#evaluating.pop();
    }
    return { binding, committed: true };
  }

  /**
   * Ends a transaction that re-keyed elements (ruling Z24): for each
   * element that a write through a reference by key left with another
   * key, moves what the old key holds to the new key, in this instance
   * and in every instance a function body made. What is moved is the
   * state cells declared under the key, in the body over the array and
   * in the bodies over the results of the constructs applied to it,
   * which have the upstream key. The cone instances of the old key are
   * dropped, and those of the new key are evaluated when they are next
   * demanded. A reference that was stored elsewhere under the old key is
   * not found and keeps the old key.
   */
  #rekey(): void {
    const rekeys = this.store.rekeys.splice(0);
    for (const rekey of rekeys) {
      for (const instance of [this, ...this.#instances.values()]) {
        instance.#moveKey(rekey);
      }
    }
  }

  /**
   * Removes an instance that a function body of this instance made,
   * which an instance that was moved to its name replaced (ruling Z41):
   * its documents, the instances and the bindings that its own function
   * bodies made, and the names that lead to them. An event for one of
   * its streams finds no instance.
   */
  #remove(replaced: Instance): void {
    const { root, store } = this;
    const removed = new Set<Instance>();
    const collect = (instance: Instance) => {
      removed.add(instance);
      for (const child of instance.#children) collect(child);
    };
    collect(replaced);
    for (const instance of removed) {
      for (const id of instance.#documents) {
        if (store.docs.has(id) || store.declared.has(id)) store.remove(id);
      }
      root.#instances.delete(instance.id);
      for (const key of instance.#bindings) root.#bound.delete(key);
    }
    for (const [name, { instance }] of [...root.#made]) {
      if (removed.has(instance)) root.#made.delete(name);
    }
    const at = this.#children.indexOf(replaced);
    if (at >= 0) this.#children.splice(at, 1);
  }

  /**
   * On the root: a commit was refused, so the storage holds the label of no
   * record given in its transaction. The record of each place that a
   * comparison leaves as it was is given at that comparison, whatever
   * inputs the record last given for it had (`#unchangedOutput`).
   */
  recordsRefused(): void {
    this.root.#recordDigests.clear();
  }

  /**
   * On the root: takes what the storage holds for a document in place of
   * what the store holds, after a commit that wrote the document was
   * refused, and marks what read the document. `value` is what the storage
   * holds, or `undefined` where it holds nothing.
   *
   * A document the storage does not hold is removed, and with the result
   * document of an instance that a function body made, the instance: a
   * handler that runs again makes them again. The result document of an
   * instance that the storage holds is taken with the rows of each of its
   * collections left out, and nothing of it counts as stored: the next
   * derivation stores each path that differs and every row. The work
   * follows the size of the result, which a refused commit is taken to
   * allow.
   *
   * The memo entry of each cone instance that wrote the document as a
   * side-write is dropped, as `#abort` drops it for a transaction that
   * the executor undoes: the entry is current against what the cone read,
   * and the document no longer holds what the cone wrote, so a later
   * evaluation performs the write (ES §1.6). The cone instance stays
   * known as a writer of the document: an evaluation that writes what the
   * document already holds changes nothing and is not seen as a write.
   */
  restore(doc: string, value: unknown): void {
    const { root, store } = this;
    for (
      const { instance, key } of root.#wroteAside.get(doc)?.values() ?? []
    ) {
      // The write that was taken back was made for the scope key that is
      // evaluated for now. Where the memo holds the entry of another key,
      // that entry stays, and the entry set aside for this key is the one
      // that is no longer current.
      const { scopes } = store;
      const held = instance.#memo.get(key);
      if (scopes !== undefined) {
        instance.#staleAside(key, (scoped) => scopes.acting(scoped));
      }
      if (
        scopes === undefined || held?.scoped === undefined ||
        scopes.acting(held.scoped)
      ) instance.#memo.delete(key);
      instance.#markUsers(key);
      instance.#nowDue();
    }
    root.recordsRefused();
    const owner = doc === root.id ? root : root.#instances.get(doc);
    // What stored an output in a scope instance stores it again.
    const { base, scope } = scopeOfDocument(doc);
    const scoped = scope === undefined
      ? undefined
      : root.#scopedOutputsOf.get(base);
    if (scoped !== undefined && store.scopes !== undefined) {
      for (const text of scoped.#placeScopes.keys()) {
        for (const each of ["user", "session"] as const) {
          scoped.markStale(`scoped ${text}`, store.scopes.keyOf(each));
        }
      }
    }
    // What stored a value in the scope instance of the document of that
    // value alone stores it again, for the key the refused commit was of.
    const valued = scope === undefined
      ? undefined
      : root.#scopedValuesOf.get(base);
    if (valued !== undefined && store.scopes !== undefined) {
      const text = JSON.stringify(["values", valued.output, ...valued.keys]);
      for (const each of ["user", "session"] as const) {
        valued.instance.markStale(`scoped ${text}`, store.scopes.keyOf(each));
      }
    }
    if (owner === undefined) {
      if (value === undefined) {
        // A place that the refused transaction first wrote, as a state
        // cell, has no document again and keeps what it was declared as,
        // so a read of it gives the default of its schema.
        const declared = store.declared.get(doc);
        if (store.docs.has(doc)) store.remove(doc);
        if (declared !== undefined) {
          store.declare(doc, declared.kind, declared.default);
        }
        return;
      }
      if (store.docs.has(doc)) store.write(new Ref(doc, []), value);
      else store.create(doc, "external", value);
      return;
    }
    const parent = owner.options.parent;
    if (value === undefined && parent !== undefined) {
      parent.#remove(owner);
      parent.#nowDue();
      return;
    }
    let held: unknown = value ?? {};
    for (const unit of [...owner.#rootUnits.values()]) {
      const path = owner.#pathOf(unit);
      if (unit.keys.length > 0) {
        owner.#spliceRows(unit, path, 0, [...unit.keys], [], [], () => []);
      }
      unit.seen = undefined;
      owner.#dueUnits.add(unit);
      held = withNoRows(held, path);
    }
    owner.#storedResult = undefined;
    store.write(new Ref(doc, []), held);
    owner.#nowDue();
  }

  /**
   * The events this instance handled and the documents its bodies made
   * with no cause of their own, counted: what the names of the runs of its
   * handlers and of those documents are formed from. A store outside the
   * executor keeps them for a resume (`options.minted`).
   */
  get minted(): { events: number; created: number } {
    return { events: this.#events, created: this.#created };
  }

  /**
   * The instances that handlers of this instance made and that exist, each
   * by its identifier with the identity of its pattern. No body makes one
   * of them again, so a store outside the executor keeps the list for a
   * resume (`options.made`).
   */
  madeByHandlers(): { id: string; pattern: string }[] {
    const made: { id: string; pattern: string }[] = [];
    for (const { instance, keyed } of this.root.#made.values()) {
      const pattern = instance.plan.patterns?.[0];
      if (keyed === undefined && pattern !== undefined) {
        made.push({ id: instance.id, pattern });
      }
    }
    return made;
  }

  /** The identifiers of the documents and declared places of the instance. */
  documentIds(): string[] {
    return [...this.#documents];
  }

  #moveKey(
    rekey: { doc: string; array: readonly string[]; from: string; to: string },
  ): void {
    const element = [...rekey.array, keySegment(rekey.from)];
    const isElement = (path: readonly string[]) =>
      path.length === element.length &&
      path.every((segment, index) => segment === element[index]);
    // The collections over the array: those whose element table holds
    // the reference by key, and the constructs applied to them.
    const over = new Set<number>();
    for (const table of this.#tables.values()) {
      const source = table.byKey.get(rekey.from)?.source;
      if (
        source instanceof Ref && source.doc === rekey.doc &&
        isElement(source.path)
      ) over.add(table.collection);
    }
    if (over.size === 0) return;
    for (let grown = true; grown;) {
      grown = false;
      this.plan.collections.forEach(({ source }, index) => {
        const upstream = source.collection ??
          (source.output === undefined
            ? undefined
            : this.plan.outputs[source.output].passesCollection);
        if (upstream !== undefined && over.has(upstream) && !over.has(index)) {
          over.add(index);
          grown = true;
        }
      });
    }
    // The key itself, and the key of a member of the segment that a
    // `flatMap` gave the element (ruling Z22).
    const renamed = (key: string) => rekeyed(key, rekey.from, rekey.to);
    // Whether a key can be the old key or hold it: the key itself, or
    // the key of a member of a segment.
    const may = (key: string) => key === rekey.from || key.includes('"source"');
    for (const [name, table] of [...this.#tables]) {
      const { collection, around } = table;
      if (!over.has(collection)) continue;
      // A table that holds the key itself and no key of a member of a
      // segment has one element to rename.
      const one = table.byKey.get(rekey.from);
      if (
        one !== undefined &&
        !table.elements.some(({ key }) => key.includes('"source"'))
      ) {
        this.#drop(collection, around, one.key);
        table.byKey.delete(one.key);
        one.key = rekey.to;
        if (one.source instanceof Ref && isElement(one.source.path)) {
          one.source = new Ref(rekey.doc, [
            ...rekey.array,
            keySegment(rekey.to),
          ]);
        }
        table.byKey.set(one.key, one);
        continue;
      }
      this.#setTable(
        name,
        collection,
        around,
        table.elements.map((member) => {
          const key = may(member.key) ? renamed(member.key) : member.key;
          if (key === member.key) return member;
          this.#drop(collection, around, member.key);
          return {
            ...member,
            key,
            source: member.source instanceof Ref &&
                isElement(member.source.path)
              ? new Ref(rekey.doc, [...rekey.array, keySegment(rekey.to)])
              : member.source,
          };
        }),
      );
    }
    // An instance called through `asInstance()` is re-keyed with the
    // element, as the rest of what the old key holds is (PL §3.15,
    // assumed there under question 123). It keeps its documents.
    for (const [id, held] of [...this.#asInstances]) {
      const steps = (this.plan.children?.[held.child].within ?? []).flatMap((
        step,
      ) => step.element === undefined ? [] : [step.element]);
      if (!held.keys.some(may)) continue;
      const moved = held.keys.map((key, index) =>
        over.has(steps[index]) ? renamed(key) : key
      );
      if (canonical(moved) === canonical(held.keys)) continue;
      this.#asInstances.delete(id);
      const record = this.plan.children?.[held.child];
      if (record === undefined) continue;
      this.#asInstances.set(
        this.#identifier("child", record.within, moved, record.name),
        { ...held, keys: moved },
      );
    }
    // An instance that a `lift` or a `computed` of the body made moves
    // to the new key as a child, and replaces one that is named there
    // (ruling Z41). It keeps its documents. A binding that a function
    // body made is named by its run and is not moved.
    for (const [name, made] of [...this.root.#made]) {
      const { instance, keyed, ordinal } = made;
      if (keyed === undefined || instance.options.parent !== this) continue;
      if (!keyed.keys.some(([, key]) => may(key))) continue;
      const keys = keyed.keys.map(([collection, key]): [number, string] => [
        collection,
        over.has(collection) ? renamed(key) : key,
      ]);
      if (canonical(keys) === canonical(keyed.keys)) continue;
      const moved = { body: keyed.body, keys };
      const to = identifierOf(this.runCause(moved), { instance: ordinal });
      this.root.#made.delete(name);
      const replaced = this.root.#made.get(to)?.instance;
      if (replaced !== undefined && replaced !== instance) {
        this.#remove(replaced);
      }
      this.root.#made.set(to, { instance, ordinal, keyed: moved });
    }
    for (const [id, { cell, keys }] of [...this.#cells]) {
      if (!keys.some(may)) continue;
      const steps = this.plan.stateCells[cell].within.flatMap((step) =>
        step.element === undefined ? [] : [step.element]
      );
      const moved = keys.map((key, index) =>
        over.has(steps[index]) ? renamed(key) : key
      );
      if (canonical(moved) === canonical(keys)) continue;
      const to = this.stateCellDocument(cell, moved);
      this.#cells.delete(id);
      this.#cells.set(to, { cell, keys: moved });
      this.#documents.delete(id);
      this.#documents.add(to);
      this.store.move(id, to);
    }
  }
}

/**
 * A view node of the reactive tier, with its children as value code
 * wrote them: one position for each child. A child that is an array, the
 * assembled result of a per-element construct among them, is one nested
 * child, and its elements are at `children/<n>/*` (ruling Z31). Value
 * code writes the members of an array literal as children of their own.
 */
const viewNode = (
  name: unknown,
  props: Record<string, unknown> | null,
  children: unknown[],
): unknown => {
  if (typeof name === "function") {
    return name({ ...(props ?? {}), children });
  }
  return { type: "vnode", name, props: props ?? {}, children };
};

/**
 * A view node that a function body builds, as the JSX factory builds one
 * (`h` in `runtime/runner/src/builder/h.ts`): a child that is an array
 * the body holds is flattened into the children.
 */
const viewNodeOfBody = (
  name: unknown,
  props: Record<string, unknown> | null,
  children: unknown[],
): unknown => viewNode(name, props, children.flat());

/** A helper that is a host element with the data attribute it sets. */
const uiHelper = (
  tag: string,
  attributes: [string, string][],
  own: string[],
) =>
(props: Record<string, unknown>) => {
  const { as, children, ...rest } = props;
  const given: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rest)) {
    if (!own.includes(name)) given[name] = value;
  }
  for (const [name, attribute] of attributes) {
    if (rest[name] !== undefined) given[attribute] = rest[name];
  }
  return viewNode(
    as ?? tag,
    given,
    children === undefined || children === null
      ? []
      : Array.isArray(children)
      ? children
      : [children],
  );
};

/**
 * A built-in that the executor does not have. While the modules are
 * evaluated, a call of it and a read of a member of it give such a value
 * again, so a declaration at module scope that nothing of a run reads is
 * evaluated. A call in a function body throws.
 */
const absent = (instance: Instance, name: string): unknown =>
  new Proxy(function () {}, {
    get: (_target, member) =>
      typeof member === "string" ? absent(instance, name) : undefined,
    apply: () => {
      if (instance.loading) return absent(instance, name);
      throw new Unsupported(`the built-in \`${name}\` in a function body`);
    },
  });

/**
 * What a module of compiled code imports from `commonfabric`: the
 * constants, the cell constructors a function body may call, and a marker
 * for each builder, whose function the value code holds already.
 */
const commonfabric = (instance: Instance): unknown => {
  const marker = (kind: string) => (..._given: unknown[]) =>
    hardenFunction(() => {
      throw new Unsupported(`a ${kind} called in a function body`);
    });
  const caused = new Map<string, Handle>();
  // A cell constructor is called with `new` or through `of`.
  const cells = Object.assign(function (value: unknown) {
    return instance.createCell(value);
  }, {
    equals: (a: unknown, b: unknown) => instance.same(a, b),
    of: (value: unknown) => instance.createCell(value),
    // A cell a body makes under a cause is the same cell for the same
    // cause in the same run (PL §1.3). A cause that is a reference is its
    // identity.
    for: (cause: unknown) => {
      const key = `${JSON.stringify(instance.runningCause ?? null)}\n${
        instance.equalsKey(cause) ?? JSON.stringify(cause) ?? "undefined"
      }`;
      const made = caused.get(key) ?? instance.createCell(undefined);
      caused.set(key, made);
      return made;
    },
    perSpace: undefined as unknown,
    perUser: undefined as unknown,
    perSession: undefined as unknown,
  });
  cells.perSpace = cells;
  cells.perUser = cells;
  cells.perSession = cells;
  for (const member of Object.values(cells)) hardenFunction(member);
  hardenFunction(cells);
  const known: Record<string, unknown> = {
    UI: "$UI",
    NAME: "$NAME",
    TYPE: "$TYPE",
    TILE_UI: "$TILE_UI",
    CHIP_UI: "$CHIP_UI",
    FS: "$FS",
    TESTS: "$TESTS",
    VIEWS: "$VIEWS",
    // A pattern is, in value code, a factory that holds the identity of
    // the pattern: a function body that calls it instantiates the
    // pattern (ES §2.8).
    pattern: (id: unknown) =>
      hardenFunction((argument: unknown) => {
        if (instance.loading) {
          throw new Unsupported("a pattern called at module scope");
        }
        return instance.instantiate(id, argument);
      }),
    // A handler is a factory that a function body can call with the
    // state: the call binds the handler (PL §3.14).
    handler: (...given: unknown[]) => {
      const run = given.findLast((member) => typeof member === "function") as
        | ((...given: unknown[]) => unknown)
        | undefined;
      return hardenFunction((state: unknown) => {
        if (instance.loading || run === undefined) {
          throw new Unsupported("a handler called in a function body");
        }
        return instance.bind(run, state);
      });
    },
    lift: marker("lift"),
    action: marker("action"),
    Writable: cells,
    Cell: cells,
    OpaqueCell: cells,
    Stream: cells,
    cell: (value: unknown) => instance.createCell(value),
    str: (strings: TemplateStringsArray, ...values: unknown[]) =>
      String.raw({ raw: strings }, ...values),
    toSchema: () => ({}),
    // A request of an effect (BI, `navigateTo`): the handler makes it
    // and commits with it, and the executor answers no effect.
    navigateTo: (target: unknown) => {
      if (instance.loading) return absent(instance, "navigateTo");
      instance.root.requests.push({
        kind: "navigateTo",
        target: target instanceof Handle ? targetOf(target) : target,
      });
      return undefined;
    },
    // A request of another effect (SS §6.2, "In a handler").
    ...Object.fromEntries(EFFECTS.map((builtin) => [
      builtin,
      (...given: unknown[]) =>
        instance.loading
          ? absent(instance, builtin)
          : instance.requestEffect(builtin, given),
    ])),
    // The debug renderers are conversions to a string (FA §3.3).
    debugStr,
    toCompactDebugString,
    toIndentedDebugString,
    equals: (a: unknown, b: unknown) => instance.same(a, b),
    equalsKey: (value: unknown) => instance.equalsKey(value),
    // Every cell of an executed instance is in the instance's space.
    spaceOf: () => {
      if (instance.options.space === undefined) {
        throw new Unsupported("`spaceOf` with no space given");
      }
      return instance.options.space;
    },
    UiAction: uiHelper("ct-button", [["action", "data-ui-action"]], [
      "as",
      "action",
    ]),
    UiPromptSlot: uiHelper(
      "ct-textarea",
      [["surface", "data-ui-surface"], ["role", "data-ui-role"]],
      ["as", "surface", "role"],
    ),
    UiDisclosure: uiHelper("ct-card", [["kind", "data-ui-disclosure-kind"]], [
      "as",
      "kind",
    ]),
  };
  // What a module imports is the same for every call of its functions:
  // no function of it holds a property a body can set, and a namespace
  // import adds or replaces no member.
  for (const member of Object.values(known)) hardenFunction(member);
  Object.freeze(known);
  // The same holds of what a harness gives (`options.builtins`): each
  // member is frozen as module data is, in place, so a function or a
  // class given here holds no property a body can set and a record given
  // here keeps its members. The names are read from a frozen copy, and
  // the import has no member to set, since `known` takes none.
  const handed = instance.root.options.builtins ?? {};
  const given: Record<string, unknown> = Object.freeze(
    Object.fromEntries(
      Object.entries(typeof handed === "function" ? handed(instance) : handed)
        .map((
          [name, member],
        ) => [name, freezeModuleData(member)]),
    ),
  );
  return new Proxy(known, {
    get: (target, name) => {
      if (typeof name !== "string" || name in target) {
        return target[name as string];
      }
      if (Object.hasOwn(given, name)) return given[name];
      // At module scope a built-in the executor does not have gives a
      // value nothing of a run reads, such as a declaration of policy.
      return absent(instance, name);
    },
  });
};

/** The artifacts of the output of `pattern-compiler emit`. */
export const artifactsOf = (
  emitted: { module: string; patterns: Artifact[] }[],
): Artifact[] => emitted.flatMap(({ patterns }) => patterns);
