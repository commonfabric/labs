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
  type FabricValue,
  toCompactDebugString,
  toIndentedDebugString,
} from "@commonfabric/data-model";

import {
  argumentOf,
  canonical,
  type ElementPart,
  type ErrorState,
  errorState,
  identifierOf,
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
  type Name,
  OUTPUT,
  type Position,
  recordOfKey,
  Ref,
  rekeyed,
  type Schema,
  schemaBelow,
  spliceIn,
  Store,
  StreamMarker,
  streamOf,
  StreamRef,
  textOf,
  type Undo,
  withDefaults,
} from "./store.ts";
import type { PartsOptions, Sealed } from "./parts.ts";

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
  }[];
  edges: { from: number; to: number; via: { kind: string; output?: number } }[];
  collections: {
    name: Name;
    construct: string;
    within: Step[];
    source: { slot?: number; collection?: number; output?: number };
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
    reads: { slot: number; at: string[]; default?: unknown }[];
    computed: { at: string[]; observes: string }[];
    writes: {
      target: { kind: string; slot?: number; cell?: number; path?: string[] };
    }[];
    envelopes: { kind: string; slot?: number; path?: string[] }[];
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
 * The assembled result of a `map`, a `filter` or a `flatMap`, as value
 * code holds it where it places the result and observes nothing of it:
 * a reference to the collection for the element keys it was named
 * under. Code that observes the result is given the array
 * (`Host.settled`). A value that holds the reference does not change
 * when an element of the collection does, so the cone that placed the
 * result is not evaluated again for it, and the runtime stores each row
 * where the result stands (`Instance.#storeUnit`).
 */
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

/** Whether a construct assembles an array of rows. */
const assemblesRows = (construct: string): boolean =>
  construct === "map" || construct === "filter" || construct === "flatMap";

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

/** The name that stands for the element table of an assembly. */
const tableName = (assembly: string): string => `table ${assembly}`;

/**
 * What the assembly of a `map` or a `filter` over a stored array keeps
 * so that a change of the array, or of the result of the body for one
 * element, is applied to it, and the table and the result are not
 * formed again (`#reassemble`).
 */
type Rows = {
  construct: "map" | "filter";
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
};

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

/** Brings the instances of a side-writing cone up to date. */
type Writer = (context: Context) => void;

const sameRoot = (a: Root, b: Root): boolean =>
  a.kind === b.kind && a.cell === b.cell && a.collection === b.collection &&
  a.handler === b.handler && a.operation === b.operation &&
  a.child === b.child;

/** What an executed instance counted. */
export type Counts = {
  /** Evaluations of a value function, of a per-element function, and of
   * the assembly of a collection. */
  evaluations: number;
  /** Of those, the evaluations of a cone instance of an element body. */
  elementEvaluations: number;
  /** Of those, the assemblies of a collection, which no cone computes. */
  assemblies: number;
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
 * A cell handle given to a sandboxed body (ES §2.4, "Handles"): reads and
 * writes go to the position the handle names.
 */
export class Handle {
  constructor(
    readonly instance: Instance,
    readonly target: Ref | StreamRef,
    /** The host of the cone the body runs in, which records its reads. */
    readonly host: Host | undefined,
    /** The `identity` slot of the handle, and the path below its cell. */
    readonly slot: number | undefined,
    readonly below: readonly string[],
    /**
     * The schema of the handle's declared type: a position it declares as
     * a handle is one in what a read through the handle gives.
     */
    readonly declared?: Schema,
    /** The handle is to a value with no stored address: a write fails. */
    readonly fixed = false,
  ) {}

  get(): unknown {
    if (this.target instanceof StreamRef) return { $stream: true };
    return this.#typed(this.target, this.declared, this.host?.reads, 0);
  }

  sample(): unknown {
    if (this.target instanceof StreamRef) return { $stream: true };
    return this.#typed(this.target, this.declared, undefined, 0);
  }

  /** What a read gives under a schema that declares handles below it. */
  #typed(
    ref: Ref,
    schema: Schema | undefined,
    reads: Position[] | undefined,
    depth: number,
  ): unknown {
    const { store } = this.instance;
    // A plain value in place that the body reads is a copy (ruling Z25).
    if (!declaresHandle(schema, depth)) return store.read(ref, reads, true);
    const located = store.locate(ref, true, reads);
    const member = (segment: string, at: Ref) => {
      const below = schemaBelow(schema, segment);
      return typeof below === "object" && below.asCell !== undefined
        ? new Handle(this.instance, at, this.host, undefined, [], below)
        : this.#typed(at, below, reads, depth + 1);
    };
    if (Array.isArray(located.value)) {
      // A member that is a plain value in place is named by its key, and
      // one that is a link by the position that holds the link (PL §1.3,
      // assumed there under question 115).
      // The key fields that the schema of the read declares, and
      // otherwise those of the array schema that a link on the way to
      // the array holds (ruling Z52).
      const declared = keyFieldsOf(schema);
      const keys = store.keysOf(
        located.value,
        located.ref,
        undefined,
        declared.length > 0 ? declared : keyFieldsOf(located.given),
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
      return Object.fromEntries(
        Object.keys(located.value).map((
          name,
        ) => [name, member(name, located.named.key(name))]),
      );
    }
    return store.read(ref, reads, true);
  }

  key(segment: string | number): Handle {
    if (this.target instanceof StreamRef) return this;
    return new Handle(
      this.instance,
      this.target.key(`${segment}`),
      this.host,
      this.slot,
      [...this.below, `${segment}`],
      schemaBelow(this.declared, `${segment}`),
      this.fixed,
    );
  }

  set(value: unknown): Handle {
    if (this.target instanceof StreamRef) {
      this.send(value);
      return this;
    }
    if (this.fixed) {
      throw new Unsupported(
        "a write through a handle to a value the instance holds no address for",
      );
    }
    this.instance.written(this);
    this.instance.store.write(
      this.target,
      this.instance.detached(
        this.target,
        this.instance.anchored(
          this.instance.stored(this.instance.returned(value)),
        ),
      ),
    );
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
    const at = this.target instanceof Ref
      ? this.instance.store.locate(this.target, true)
      : undefined;
    const base = at === undefined || at.missing ? this : new Handle(
      this.instance,
      at.ref,
      this.host,
      this.slot,
      this.below,
      this.declared,
      this.fixed,
    );
    for (const [name, member] of Object.entries(members)) {
      base.key(name).set(member);
    }
    return this;
  }

  push(...members: unknown[]): void {
    if (this.target instanceof StreamRef) return;
    if (this.fixed) {
      throw new Unsupported(
        "a write through a handle to a value the instance holds no address for",
      );
    }
    const located = this.instance.store.locate(this.target, true);
    // Where the place holds nothing, the array starts from the default
    // that the place declares, as a write below the root of a state cell
    // does: the default nearest the end of the links the handle resolves
    // through, or that of the handle's declared type (ruling Z27).
    const declared = located.value !== undefined
      ? undefined
      : located.fallback ??
        (typeof this.declared === "object" ? this.declared.default : undefined);
    const held = Array.isArray(located.value)
      ? located.value
      : Array.isArray(declared)
      ? structuredClone(declared)
      : [];
    this.instance.written(this.key("*"));
    // A record that is pushed gets a document of its own, as a record in
    // a list that is set does (`Instance.anchored`).
    const pushed = this.instance.anchored(
      members.map((member) =>
        this.instance.stored(this.instance.returned(member))
      ),
    ) as unknown[];
    // An array that is stored is changed in place, as a splice.
    if (Array.isArray(located.value)) {
      this.instance.store.splice(this.target, held.length, 0, pushed);
    } else {
      this.instance.store.write(this.target, [...held, ...pushed]);
    }
  }

  /**
   * The positions of this list that hold `member`: the positions a
   * reference names, for a handle, a reference stand-in or a value read
   * from a cell, and the positions that hold an equal value, for a copy
   * of a plain value (ruling Z25).
   */
  #positionsOf(member: unknown): number[] {
    if (this.target instanceof StreamRef) return [];
    const held = this.get();
    if (!Array.isArray(held)) return [];
    const list = this.target;
    return held.flatMap((other, index) =>
      this.instance.same(list.key(`${index}`), member) ||
        this.instance.same(other, member)
        ? [index]
        : []
    );
  }

  remove(member: unknown): void {
    const [at] = this.#positionsOf(member);
    if (at === undefined) return;
    this.set((this.get() as unknown[]).filter((_, index) => index !== at));
  }

  send(event: unknown): void {
    if (this.target instanceof StreamRef) {
      this.instance.queue(this.target, event);
      return;
    }
    const located = this.instance.store.locate(this.target, true);
    if (isStream(located.value)) {
      const { binding, keys, instance } = located.value.$stream;
      this.instance.queue(new StreamRef(binding, keys, instance), event);
      return;
    }
    // A stream the instance was given, which the argument holds nothing
    // for, takes no event: the executor has no other instance. The send
    // is a write of the handler all the same.
    if (
      located.value === undefined &&
      isStreamSchema(located.ref.schema ?? this.declared)
    ) {
      this.instance.written(this);
      return;
    }
    this.set(event);
  }

  removeAll(member: unknown): void {
    const found = this.#positionsOf(member);
    if (found.length === 0) return;
    this.set(
      (this.get() as unknown[]).filter((_, index) => !found.includes(index)),
    );
  }

  /** Removes each member that is `member` (`removeByValue` of a cell). */
  removeByValue(member: unknown): void {
    this.removeAll(member);
  }

  /** Appends `member` unless the list holds it (`addUnique` of a cell). */
  addUnique(member: unknown): void {
    if (this.#positionsOf(member).length > 0) return;
    this.push(member);
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
    if (this.target instanceof StreamRef) return this;
    return new Handle(
      this.instance,
      this.instance.keyedElement(this.target, `${key}`),
      this.host,
      this.slot,
      [...this.below, "*"],
      schemaBelow(this.declared, "0"),
    );
  }

  equals(other: unknown): boolean {
    return this.instance.same(this, other);
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

  constructor(
    readonly instance: Instance,
    readonly context: Context,
    /** The cone of the code being evaluated, where it belongs to one. */
    readonly cone: number | undefined,
    /** The name of the memo entry being evaluated, where it is one. */
    readonly key?: string,
  ) {}

  /** The value of a slot, or its reference for an `identity` slot. */
  slot(index: number, rest: string[] = []): unknown {
    const { instance } = this;
    if (
      this.cone !== undefined &&
      !instance.plan.cones[this.cone].slots.includes(index)
    ) {
      instance.counts.slotsNotListed += 1;
    }
    const slot = instance.plan.slots[index];
    // The slot of the chosen child of a `pick`, at `*`, yields every
    // child of the container (ES §2.2).
    const path = slot.path[slot.path.length - 1] === "*" && rest.length === 0
      ? slot.path.slice(0, -1)
      : slot.path;
    this.demand(slot.root, [...path, ...rest]);
    const found = this.at(
      instance.rootOf(slot.root, this, [...path, ...rest]),
      [...path, ...rest],
    );
    // Where nothing is stored, a slot reads as the default of the place
    // (ES §2.2): the default its schema declares.
    const schema = path === slot.path
      ? rest.reduce(schemaBelow, instance.schemaOf(slot.schema))
      : undefined;
    if (slot.observes === "identity") {
      // A stream that is an input of the pattern is a reference like any
      // other: what passes it on stores a link to its place (ES §2.2, "A
      // stream that is an input of the pattern").
      return found instanceof Ref ? found.withSchema(schema) : found;
    }
    return withDefaults(this.v(found), schema);
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
    this.instance.counts.readsWithoutSlot += 1;
    this.demand(root, path);
    return this.at(this.instance.rootOf(root, this), path);
  }

  /**
   * Evaluates first the cones that write, as a static side-write, what a
   * read of `path` below `root` reads or passes on by reference: the
   * target of a write edge counts as an output of its cone for demand
   * (ES §2.3, "A cone with side-writes").
   */
  demand(root: Root, path: readonly string[]): void {
    const writers = this.instance.writersOf(root, path, this.cone);
    if (writers.length === 0) return;
    for (const writer of writers) {
      if (!this.writers.includes(writer)) this.writers.push(writer);
      writer(this.context);
    }
    this.demandedAt = {
      clock: this.instance.store.clock,
      reads: this.reads.length,
    };
  }

  /** The value of an entry of `Plan.outputs`. */
  output(index: number): unknown {
    const { instance } = this;
    const output = instance.plan.outputs[index];
    if (
      this.cone !== undefined && output.cone !== this.cone &&
      !instance.plan.edges.some((edge) =>
        edge.to === this.cone && edge.via.kind === "output" &&
        edge.via.output === index
      )
    ) {
      instance.counts.outputsWithoutEdge += 1;
    }
    if (output.collection !== undefined) {
      // The result of a construct that assembles rows is held by
      // reference until something observes it.
      return assemblesRows(
          instance.plan.collections[output.collection].construct,
        )
        ? instance.assembledBy(output.collection, this.context)
        : this.depend(instance.assembled(output.collection));
    }
    const value = instance.valueOfOutput.get(index);
    if (value === undefined) {
      const below = instance.code.outputsBelow.find((entry) =>
        entry.output === index
      );
      if (below !== undefined) {
        return this.at(this.value(below.value), below.path);
      }
      throw new Unsupported("an output that no value function computes");
    }
    const held = this.value(value);
    if (Array.isArray(held)) {
      instance.returnedWhole.set(held, {
        output: index,
        context: this.context,
      });
    }
    return held;
  }

  /** The value a value function computes, by the value's number. */
  value(value: number): unknown {
    return this.depend(this.instance.evaluated(value));
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
    if (!(value instanceof Assembled)) return value;
    const { instance } = this;
    const assembled = instance.assembled(value.collection);
    const entry: Lazy = () => assembled(instance.freshContext(value.context));
    // A stamp of a dependency that looks below a reference after the
    // evaluation ended reads the array and records nothing.
    return this.done ? entry(this.context).value : this.depend(entry);
  }

  /** A value with each reference to an assembled collection settled. */
  whole(value: unknown): unknown {
    if (value instanceof Assembled) return this.whole(this.settled(value));
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

  dependEntry(entry: Lazy, path?: readonly string[]): Entry {
    const used = entry(this.context);
    const on = used.owner === this.instance ? used.key : undefined;
    if (on !== undefined && this.key !== undefined) {
      this.instance.uses(this.key, on);
    }
    if (path === undefined) {
      this.dependencies.push({
        stamp: (context) => entry(context).changedAt,
        seen: used.changedAt,
        ...(on === undefined ? {} : { on }),
      });
    } else {
      const held = (from: Entry) =>
        canonical(this.instance.stored(this.at(from.value, path)));
      this.dependencies.push({
        stamp: (context) => held(entry(context)),
        seen: held(used),
        ...(on === undefined ? {} : { on }),
      });
    }
    return used;
  }

  /**
   * A marker for the stream of a binding (ES §2.2, `ConeHost.stream`),
   * for the element keys this evaluation has at the `element` steps of
   * the binding's `within`. The code that is given it can place it in a
   * value and can do nothing else with it: the marker has no member, and
   * `v` and `at` read nothing through it.
   */
  stream(binding: number): StreamMarker {
    return markerOf(this.instance.streamFor(binding, this.context));
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
        this.instance.store.locate(operand, true, this.reads, true);
      }
    }
    const seen = this.instance.same(a, b);
    this.dependencies.push({
      stamp: () => this.instance.same(a, b),
      seen,
    });
    return seen;
  }

  /** A value with every reference in it replaced by what it refers to. */
  v(value: unknown): unknown {
    if (value instanceof Assembled) return this.v(this.settled(value));
    if (value instanceof Ref) {
      return this.#reading(this.instance.store.read(value, this.reads));
    }
    this.#reading(value);
    if (value instanceof StreamRef) return { $stream: true };
    // A marker is read through by nothing: it stays the marker.
    if (value instanceof StreamMarker) return value;
    if (value instanceof Handle) return value.get();
    if (Array.isArray(value)) return value.map((member) => this.v(member));
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([name, member]) => [name, this.v(member)]),
      );
    }
    return value;
  }

  /**
   * The operand that `??`, `||` or `&&` selects (PL §3.5). The left
   * operand is tested by the value it resolves to. Where it is selected,
   * a record, an array and a handle are passed on as the operand that was
   * given, so a reference stays the same reference, and a scalar is
   * passed on as its value. The right operand is evaluated where it is
   * selected.
   */
  selected(
    operator: "??" | "||" | "&&",
    left: unknown,
    right: () => unknown,
  ): unknown {
    const value = this.v(left);
    const takesRight = operator === "??"
      ? value === undefined || value === null
      : operator === "||"
      ? !value
      : Boolean(value);
    if (takesRight) return right();
    return left instanceof Handle ||
        (typeof value === "object" && value !== null)
      ? left
      : value;
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
        found = found.key(`${segment}`).target;
      } else if (typeof found === "string") {
        found = segment === "length" ? found.length : undefined;
      } else if (typeof found !== "object" || found === null) {
        return undefined;
      } else if (found instanceof StreamRef || found instanceof StreamMarker) {
        return undefined;
      } else {
        found = (found as Record<string, unknown>)[`${segment}`];
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
    return value === undefined ? structuredClone(fallback) : value;
  }

  /**
   * Runs a sandboxed body of the cone (ES §2.4). An entry of `Body.reads`
   * of a body of a pattern compiled in holds the default the callee
   * declares for the path the call bound to the slot: the body is handed
   * it at the entry's place where the slot yields nothing and no place
   * the slot resolves through declares a default of its own (ruling Z16).
   */
  invoke(body: number, computed: unknown): unknown {
    const { instance } = this;
    const run = instance.bodies.get(body);
    if (run === undefined) {
      throw new Unsupported("a body that has no function");
    }
    let argument = this.pass(computed);
    // An `identity` entry of `Body.computed` is a handle to the reference
    // the cone computed there (ES §2.4, "A handle or a reference from a
    // computed input").
    for (const { at, observes } of instance.plan.bodies[body].computed) {
      if (observes !== "identity" || at.includes("*")) continue;
      // A marker at such a path is handed to the body as the reference
      // to its stream (ES §2.2, assumed there under question 78).
      const reference = this.at(computed, at);
      if (
        reference instanceof Ref || reference instanceof StreamRef ||
        reference instanceof StreamMarker
      ) {
        argument = instance.placed(
          argument,
          at,
          instance.handleOf(reference, this),
        );
      }
    }
    // The slot part of the argument: each entry of `Body.reads` at its
    // place (PL §1.1, `ReadInput`).
    const layout = [...instance.plan.bodies[body].reads].sort((a, b) =>
      a.at.length - b.at.length
    );
    for (const { slot, at, default: declared } of layout) {
      const star = at.indexOf("*");
      // A slot at `*` stands for each element: the container is given
      // whole by the slot at its own path, where the body lists one.
      if (star >= 0) continue;
      const { observes } = instance.plan.slots[slot];
      // The slot reads the default of its own place first.
      const read = declared === undefined
        ? this.slot(slot)
        : this.withDefault(this.slot(slot), declared);
      const given = observes === "identity"
        ? instance.handleOf(read, this, slot)
        : read;
      if (instance.gives(observes, argument, at)) continue;
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
    const keyed = { body, keys: instance.contextKeys(this.context) };
    return instance.returned(
      instance.during(instance.runCause(keyed), () => run(argument), keyed),
    );
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
      const { store } = this.instance;
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
      : this.instance.handleOfConstant(this.v(value), this);
  }

  /**
   * A computed value as a body is handed it: what a reference names, read
   * as a value. A marker is handed as a handle to its stream, wherever it
   * is in the value: the body can send to it and can return it, and what
   * it returns holds the reference to the stream, which is stored as a
   * link (ruling Z20).
   */
  pass(value: unknown): unknown {
    if (value instanceof Assembled) return this.pass(this.settled(value));
    if (value instanceof Ref || value instanceof StreamRef) {
      return this.v(value);
    }
    // A body that would be handed a value in an error state is not run.
    this.#reading(value);
    if (value instanceof StreamMarker) {
      return this.instance.handleOf(value, this);
    }
    // A handle that value code made for a constant stays the handle.
    if (value instanceof Handle) return value;
    if (Array.isArray(value)) return value.map((member) => this.pass(member));
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map((
          [name, member],
        ) => [name, this.pass(member)]),
      );
    }
    return value;
  }
}

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
 * The member of the state document of an operation that holds the error
 * state that is the operation's result, where its request was not made
 * (SS §6.2, step 1).
 */
const FAILED = "failed";

/**
 * The member of the state document of an operation that holds what a
 * reader of the operation's result reads: `pending`, `result` and
 * `error` (BI, "The refused globals").
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

/** The name that the writes of a handler body are kept under. */
const HANDLER = "handler";

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
    { run: (...given: unknown[]) => unknown; state: unknown }
  >();
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
  /** On the root: the entries being evaluated, innermost last. */
  readonly #evaluating: { instance: Instance; key: string }[] = [];
  /** The run of a function body in progress (ES §2.8, "Identity"). */
  #running: Running | undefined;
  /** The events handled, which name the run of a handler. */
  #events = 0;
  readonly plan: Plan;
  readonly code: Code;
  readonly counts: Counts = {
    evaluations: 0,
    elementEvaluations: 0,
    assemblies: 0,
    slotsNotListed: 0,
    readsWithoutSlot: 0,
    outputsWithoutEdge: 0,
    writesCovered: 0,
    writesNotCovered: 0,
    pendingOperations: 0,
    staleByOwnWrite: 0,
    failures: 0,
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
   * The entries that read the position of an element, by the name of
   * what is kept under the element's key.
   */
  readonly #indexReaders = new Map<string, Set<string>>();
  /** On the root: the readers of each document, by path. */
  readonly #readers = new Map<string, Readers>();
  /**
   * On the root: the readers through a reference by key, by the array
   * that the key was found in and the key.
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
    if (this.#open.has(slot.key)) this.#markedDuring.add(slot.key);
    const entry = this.#memo.get(slot.key);
    if (entry !== undefined) entry.checkedAt = undefined;
    const units = this.#units.get(slot.key);
    if (units !== undefined) {
      for (const unit of units) this.#dueUnits.add(unit);
    }
    if (slot.marked) return;
    slot.marked = true;
    this.#nowDue();
    this.#markUsers(slot.key);
  }

  /** Marks the entries that used what `used` names. */
  #markUsers(used: string): void {
    const users = this.#users.get(used);
    if (users === undefined) return;
    for (const user of users) {
      const slot = this.#slots.get(user);
      if (slot !== undefined) this.#mark(slot, undefined, used);
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
    for (const used of slot.uses) this.#users.get(used)?.delete(slot.key);
    slot.uses.clear();
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
    },
  ): void {
    const open = this.#tx;
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
    const mark = (regs: Iterable<Reg> | undefined) => {
      if (regs === undefined) return;
      for (const reg of [...regs]) {
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
      mark(node.regs);
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
        const readers = top && moved.has(value)
          ? undefined
          : this.#keyedReaders.get(value);
        if (readers !== undefined) {
          this.#keyedReaders.delete(value);
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
       */
      wishes?: (
        operands: Record<string, unknown>,
      ) => { result?: unknown; error?: unknown } | undefined;
      /** What the clock holds when the executor starts. */
      now?: number;
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
    } = {},
  ) {
    this.store = options.parent?.store ??
      new Store({
        secret: options.secret,
        space: options.space,
        keys: options.keys,
        parts: options.parts,
      });
    this.id = options.id ?? "result";
    this.argument = argumentOf(this.id);
    this.root = options.parent?.root ?? this;
    this.plan = artifact.plan;
    this.code = artifact.code;
    for (const { id, schema } of artifact.schemas) {
      if (schema !== undefined) this.#schemas.set(id, linkedSchema(schema));
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
    }
    // The creation of an instance by something that is no handler is a
    // transaction that writes its two documents and evaluates nothing
    // (ES §1.1, assumed there under question 77). An instance that a
    // body makes gets them in the transaction the body runs in.
    const creation = this.root.#tx === undefined
      ? this.root.#begin("creation")
      : undefined;
    this.store.create(this.argument, "argument", this.stored(argument));
    this.store.create(this.id, "result", undefined);
    if (creation !== undefined) this.root.#end(creation, true);
    this.#load();
    this.#sideWriters();
    // An instance that a handler makes is evaluated in the derivation
    // transaction behind the batch, and not in the event's transaction
    // (ES §1.1, "From the creation of an instance to its settled
    // result").
    if (this.root.#tx?.record.cause === "event") return;
    // A state cell of the pattern's own body exists from the start, and
    // one of an element body from when its key enters the element table.
    const first = () => {
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
    return {
      nohost: none,
      // What `[SELF]` of the pattern's parameter names: the result.
      self: new Ref(this.id, []),
      setups: this.#setups,
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
    this.#runtimeObject = this.#runtime();
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
    const run = new Function(
      "$rt",
      "$exports",
      `"use strict";\n${text.source}\n//# sourceURL=compiled:${text.path}`,
    );
    run(this.#runtimeObject, exports);
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
    return this.#identifier("state", record.within, keys, record.name);
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
          // demanded"). It reads the result through the reference to the
          // state document. An operation whose request holds an error
          // state has that error state as its result.
          const state = host.depend(this.#operationState(operation)) as Ref;
          const failed = this.store.read(state.key(FAILED), host.reads);
          return isErrorState(failed) ? failed : state.key(OUTCOME);
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
   */
  stateCell(cell: number, host: Host): Ref {
    const record = this.plan.stateCells[cell];
    const keys = this.keysOf(record.within, host);
    const id = this.stateCellDocument(cell, keys);
    if (!this.#cells.has(id)) {
      this.#cells.set(id, { cell, keys });
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
      if (first !== undefined) {
        const reader = new Host(this, host.context, record.first?.cone);
        this.counts.evaluations += 1;
        // The edge of a first value always stores the value the cone
        // computed, and never a reference: a reference the value
        // function returns is stored as what it resolves to now, so a
        // write to the cell never lands in the input (ruling Z15).
        this.store.write(
          new Ref(id, []),
          this.stored(reader.v(first(reader))),
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
      this.#ensure(
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
              return this.#linkToOutput(value) ?? value.map(given);
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
            const instance = new Instance(artifact, argument, {
              ...this.options,
              parent: this,
              id: made,
            });
            this.root.#instances.set(made, instance);
            this.#children.push(instance);
            held = { child, keys, instance };
            this.#asInstances.set(id, held);
          } else {
            this.store.write(
              new Ref(held.instance.argument, []),
              argument,
            );
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
  #linkToOutput(array: readonly unknown[]): Ref | undefined {
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
      this.#ensure(
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
          const id = this.#identifier(
            "operation",
            record.within ?? [],
            keys,
            record.name,
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
          this.store.write(state.key("request"), this.stored(request));
          if (record.kind === "wish") {
            this.#resolveWish(state, host.v(request));
          } else if (!this.root.#operations.has(id)) {
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
   * the executor gives for the operands, stored in a document of its
   * own, which the result is a reference to.
   */
  #resolveWish(state: Ref, operands: unknown): void {
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
    );
    if (answer?.result === undefined) {
      store.write(
        state.key(OUTCOME, "error"),
        this.stored(answer?.error ?? `no target for \`${query}\``),
      );
      return;
    }
    const target = identifierOf({ wish: this.id, target: `${query}` });
    if (!store.docs.has(target)) {
      store.create(target, "wish target", this.stored(answer.result));
    }
    store.write(
      state.key(OUTCOME, "result"),
      this.stored(new Ref(target, [])),
    );
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
        // operation's result is that error state.
        this.store.write(state.key(FAILED), failed);
        this.store.write(state.key(OUTCOME, "pending"), false);
      } else {
        const hash = identifierOf({
          builtin: operation.builtin,
          request: JSON.parse(read) as FabricValue,
        });
        this.store.write(state.key(FAILED), undefined);
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
    assembled?: (reference: Assembled, path: string[]) => unknown,
    path: string[] = [],
  ): unknown {
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
    if (value instanceof Handle) return this.stored(value.target);
    if (value instanceof Thunk) return undefined;
    if (typeof value === "function") return undefined;
    if (Array.isArray(value)) {
      return value.map((member, index) =>
        this.stored(member, assembled, [...path, `${index}`])
      );
    }
    if (isRecord(value)) {
      const members: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(value)) {
        const kept = this.stored(member, assembled, [...path, name]);
        if (kept !== undefined) members[name] = kept;
      }
      if (this.store.copies.has(value)) this.#copied.add(members);
      return members;
    }
    if (typeof value === "object" && value !== null) {
      throw new Unsupported("a value that is no plain data");
    }
    return value;
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
    if (value instanceof Handle) return value.target;
    if (typeof value === "object" && value !== null) {
      const read = this.store.addresses.get(value);
      if (read !== undefined) return new Ref(read.doc, read.path);
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
  handleOf(value: unknown, host: Host | undefined, slot?: number): unknown {
    const declared = handleVariant(
      slot === undefined
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
   * Whether two values a body holds are one: two handles or two values
   * read from one stored address, and otherwise two equal values. Each
   * reference is resolved to the position it names now and the two are
   * compared there (ruling Z26): a handle by position, as `items.key(i)`
   * is at the call and when stored (ruling Z33), is equal to a reference
   * by key to the element that is at the position at that time, and to
   * the cell of the element where the position holds a link.
   */
  same(a: unknown, b: unknown): boolean {
    const address = (value: unknown): string | undefined => {
      if (value instanceof Handle && value.target instanceof StreamRef) {
        const { instance, binding, keys } = value.target;
        return textOf({
          stream: { instance, binding, keys: [...keys] },
        });
      }
      const ref = value instanceof Handle
        ? value.target as Ref
        : value instanceof Ref
        ? value
        : typeof value === "object" && value !== null
        ? this.store.addresses.get(value)
        : undefined;
      // A key that no position holds resolves to no position: the
      // reference is compared as the key it holds.
      return ref === undefined
        ? undefined
        : this.store.addressText(this.store.locate(ref, true).ref);
    };
    const [left, right] = [address(a), address(b)];
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
          ? structuredClone(located.value)
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
    const address = isRecord(holder)
      ? this.store.addresses.get(holder)
      : undefined;
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
   * date by themselves. `seen` gets the path of each reference.
   */
  #formOf(
    value: unknown,
    owner: { unit: Unit; key: string } | undefined,
    below: readonly string[],
    seen: Set<string>,
  ): unknown {
    const inside = owner === undefined
      ? this.#rootUnits
      : owner.unit.inside.get(owner.key) ?? new Map<string, Unit>();
    if (owner !== undefined) owner.unit.inside.set(owner.key, inside);
    return this.stored(value, (reference, path) => {
      const at = [...below, ...path];
      const id = JSON.stringify(at);
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
      return this.#rowsOf(unit);
    });
  }

  /** The rows of a unit in stored form, from its assembly as it is now. */
  #rowsOf(unit: Unit): unknown[] {
    const entry = this.assembled(unit.collection)(
      this.freshContext(unit.context),
    );
    const values = Array.isArray(entry.value) ? entry.value : [];
    unit.seen = entry;
    unit.keys = (entry.members ?? []).map(({ key }) => key);
    unit.values = [...values];
    unit.positions = undefined;
    if ("path" in unit.place) {
      this.store.rowKeys.set(
        JSON.stringify([this.id, unit.place.path]),
        () => unit.keys,
      );
    }
    const forms = values.map((value, index) =>
      this.#formOf(
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
    this.store.spliceAt(this.id, path, start, removed.length, forms);
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
      const copy = structuredClone(value);
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
   * Stores a value at a place of the result document, and writes only
   * what differs from what the place holds: a member of a record and a
   * position of an array of the same length are compared by themselves.
   */
  #place(
    path: readonly string[],
    value: unknown,
    owner: { unit: Unit; key: string } | undefined,
    below: readonly string[],
  ): void {
    const seen = new Set<string>();
    const form = this.#formOf(value, owner, below, seen);
    // The units that stood at or below the place and stand there no
    // more.
    const inside = owner === undefined
      ? this.#rootUnits
      : owner.unit.inside.get(owner.key);
    for (const [id, unit] of [...inside ?? []]) {
      if (seen.has(id)) continue;
      const at = "path" in unit.place ? unit.place.path : unit.place.below;
      if (
        below.length <= at.length &&
        below.every((segment, index) => segment === at[index])
      ) {
        this.#dispose(unit);
        inside?.delete(id);
      }
    }
    const { store, id: doc } = this;
    // What a place holds, where the form has `KEPT` at or below it.
    const filled = (form: unknown, held: unknown): unknown => {
      if (form === KEPT) return held;
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
      if (
        Array.isArray(form) && Array.isArray(held) &&
        form.length === held.length && form.length > 0
      ) {
        form.forEach((member, index) =>
          put([...at, `${index}`], member, held[index])
        );
        return;
      }
      if (isRecord(form) && isRecord(held) && !isLink(form) && !isLink(held)) {
        const [names, were] = [Object.keys(form), Object.keys(held)];
        if (
          names.length > 0 && names.length === were.length &&
          names.every((name, index) => name === were[index])
        ) {
          for (const name of names) put([...at, name], form[name], held[name]);
          return;
        }
      }
      const now = filled(form, held);
      if (held === now || JSON.stringify(held) === JSON.stringify(now)) return;
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
    put(path, form, store.peek(doc, path));
  }

  /**
   * Brings the stored rows of a unit up to date with its assembly
   * (`execution-and-storage.md` §4.2, "A kept collection is stored as
   * an array at its path"): a row whose value is another one is stored
   * again, and the rows that left or entered are a splice of the stored
   * array.
   */
  #storeUnit(unit: Unit): void {
    const entry = this.assembled(unit.collection)(
      this.freshContext(unit.context),
    );
    if (entry === unit.seen) return;
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
            unit.values[index] = values[index];
            this.#place([...path, `${index}`], values[index], {
              unit,
              key,
            }, []);
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
        unit.values[index] = values[index];
        this.#place([...path, `${index}`], values[index], { unit, key }, []);
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
    const row = (index: number) => {
      if (values[index] === unit.values[index]) return;
      unit.values[index] = values[index];
      this.#place(
        [...path, `${index}`],
        values[index],
        { unit, key: keys[index] },
        [],
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
      this.#storedResult = entry;
      this.#place([], entry.value, undefined, []);
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
    this.#arrange();
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
   * The memo entry of a computation, evaluated where it is not current: a
   * position it read was written since, an entry it used changed since,
   * or an index it read is another one now (ES §2.6). `kind` says what
   * is evaluated: a cone instance of an element body, the assembly of a
   * collection, or another value.
   */
  #ensure(
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
    if (kind === "assembly") this.counts.assemblies += 1;
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
    const changed = held === undefined || held.pending === true ||
      held.stored !== stored;
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
      changedAt: changed ? this.store.clock : held.changedAt,
    };
    this.#memo.set(key, entry);
    this.#keep(key, cone, within, context);
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
    }
    if (changed) this.#markUsers(key);
  }

  /**
   * Has an entry compared on every pull, and with it every entry that
   * used it: nothing marks them when what the entry depends on changes.
   */
  #setAlways(slot: Slot): void {
    const entry = this.#memo.get(slot.key);
    if (entry !== undefined) entry.always = true;
    if (slot.always) return;
    slot.always = true;
    this.#alwaysCount += 1;
    for (const user of this.#users.get(slot.key) ?? []) {
      const other = this.#slots.get(user);
      if (other !== undefined) this.#setAlways(other);
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
    }
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
    for (const entry of this.#underKey.get(id) ?? []) {
      this.#memo.delete(entry);
      this.#kept.delete(entry);
      this.#tables.delete(entry);
      const slot = this.#slots.get(entry);
      if (slot !== undefined) {
        this.#unregister(slot);
        if (slot.always) this.#alwaysCount -= 1;
        this.#slots.delete(entry);
      }
      this.#markUsers(entry);
      this.#markUsers(tableName(entry));
    }
    this.#underKey.delete(id);
    this.#indexReaders.delete(id);
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
  assembled(collection: number): Lazy {
    const record = this.plan.collections[collection];
    const outer = this.#outerOf(collection);
    return (context) => {
      const around = this.#keysIn(outer, context);
      const key = this.#name("assembly", collection, around);
      return this.#ensure(
        key,
        context,
        undefined,
        "assembly",
        (host) => {
          const elements = this.#table(collection, host);
          // The instances of a key that left the collection are dropped,
          // and those of a key that entered are made when they are first
          // evaluated (ruling Z10).
          const before = this.#tables.get(key);
          this.#setTable(key, collection, around, elements);
          const now = this.#tables.get(key)?.byKey;
          for (const { key: left, index } of before?.elements ?? []) {
            const stays = now?.get(left);
            if (stays === undefined) {
              this.#drop(collection, around, left);
            } else if (stays.index !== index) {
              this.#moved(collection, around, left);
            }
          }
          // What reads the value of an element from the table.
          this.#markUsers(tableName(key));
          if (!this.#elements.has(collection)) {
            throw new Unsupported("an element construct that has no function");
          }
          const first = host.dependencies.length;
          const keyOf = new Map<string, string>();
          const results = elements.map((element) => {
            const entry = host.dependEntry(
              this.#perElement(collection, element.key),
            );
            if (entry.key !== undefined) keyOf.set(entry.key, element.key);
            return entry.value;
          });
          // What a later change of the array or of one row is applied to.
          const rows = (
            construct: "map" | "filter",
            members: Element[],
            flags?: boolean[],
          ) => {
            const { found, from } = host;
            if (
              host.writers.length > 0 ||
              host.dependencies.length !== first + elements.length ||
              keyOf.size !== elements.length ||
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
            case "filter": {
              const flags = elements.map((_, index) => holds(index));
              const kept = elements.filter((_, index) => flags[index]);
              host.members = numbered(kept);
              if (
                results.every((result) =>
                  result === null || typeof result !== "object"
                )
              ) rows("filter", host.members, flags);
              return keyed(kept.map(given));
            }
            case "flatMap": {
              // An element of the result has the key of its source
              // element together with a part formed from the member (PL
              // §1.3, "The key of an element that a `flatMap`
              // contributes"; ruling Z22).
              const members: Omit<Element, "index">[] = [];
              const flat = results.flatMap((result, index) => {
                const { key } = elements[index];
                const entry = this.#perElement(collection, key);
                const inner = new Map([...context, [
                  collection,
                  elements[
                    index
                  ],
                ]]);
                const segment = this.#segment(result, entry, inner, host);
                for (const { part, source } of segment.members) {
                  members.push({ key: memberKey(key, part), source });
                }
                return segment.values;
              });
              host.members = numbered(members);
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
    };
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
    for (const used of slot.suspects) {
      const key = rows.keyOf.get(used);
      if (key !== undefined) changed.add(key);
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
    const { elements, byKey } = table;
    const { results, members, flags } = rows;
    const left = new Set<string>();
    let low = elements.length;
    // The positions that hold another element than before: those of
    // the splices where each put in as many members as it removed,
    // and otherwise every position from the first splice on.
    let high = 0;
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
    }
    if (elements.length !== length) return undefined;
    const indexed = this.#indexReaders.size > 0;
    const end = high < 0 ? elements.length : Math.min(high, elements.length);
    for (let index = low; index < end; index++) {
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
        if (flags[index] !== Boolean(result)) flagged = true;
        flags[index] = Boolean(result);
      }
    }
    let value = held.value;
    let rowsNow = members;
    let delta: Entry["delta"];
    const moved = ops.length > 0;
    let differs = moved;
    if (rows.construct === "map") {
      differs ||= dirty.length > 0;
      if (differs) {
        value = [...results];
        delta = { ops, rows: dirty.filter((key) => byKey.has(key)) };
      }
    } else if (moved || flagged) {
      differs = true;
      rowsNow = [];
      const kept: unknown[] = [];
      elements.forEach((element, index) => {
        if (!flags?.[index]) return;
        rowsNow.push({ ...element, index: rowsNow.length });
        kept.push(element.source);
      });
      rows.members = rowsNow;
      value = kept;
      // The rows that left or entered, as one splice: what stands
      // before and after it holds the keys it held.
      const [were, now] = [members.length, rowsNow.length];
      let head = 0;
      while (
        head < were && head < now && members[head].key === rowsNow[head].key
      ) head += 1;
      let tail = 0;
      while (
        tail < were - head && tail < now - head &&
        members[were - 1 - tail].key === rowsNow[now - 1 - tail].key
      ) tail += 1;
      delta = {
        ops: head === were && head === now ? [] : [{
          start: head,
          removed: members.slice(head, were - tail).map(({ key }) => key),
          inserted: rowsNow.slice(head, now - tail).map(({ key }) => key),
        }],
        rows: [],
      };
    } else {
      differs = false;
    }
    if (differs && Array.isArray(value)) {
      assembledElements.set(value, { members: rowsNow, context });
    }
    seen();
    if (differs) store.clock += 1;
    const version = (held.version ?? 0) + 1;
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
  ): {
    values: unknown[];
    members: { part: string; source: Element["source"] }[];
  } {
    const result = Array.isArray(returned)
      ? returned.map((member) => host.settled(member))
      : host.settled(returned);
    if (Array.isArray(returned) && Array.isArray(result)) {
      const assembled = assembledElements.get(returned);
      if (assembled !== undefined) assembledElements.set(result, assembled);
    }
    const read = result !== null && typeof result === "object"
      ? this.store.addresses.get(result)
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
          // The result of the inner construct's body, for the element
          // keys the callback was evaluated under.
          source: source instanceof Ref || !("entry" in source) ? source : {
            entry: () => source.entry(inner),
            at: source.at,
          },
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
    const id = this.outputDocument(output, keys);
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
    // evaluates the output for the elements that hold the keys now.
    const value = this.valueOfOutput.get(output);
    if (value !== undefined) {
      this.store.sources.set(id, () => {
        const current = this.#contextOfKeys(within, keys);
        if (current === undefined) return;
        const now = this.evaluated(value)(current).value;
        if (Array.isArray(now)) store(now);
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
      this.plan.outputs.forEach((output, index) => {
        if (!output.kept || output.path.includes("*")) return;
        const value = this.valueOfOutput.get(index);
        if (output.collection !== undefined) {
          this.assembled(output.collection)(none);
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
    return outcomes;
  }

  queue(stream: StreamRef, event: unknown): void {
    this.root.#append(stream, event);
    this.root.#queue.push({ stream, event });
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
    const id = this.#streamIdentifier(stream);
    const held = this.store.docs.get(id)?.value as
      | { entries: unknown[] }
      | undefined;
    const entry = { event: this.stored(event) };
    if (held === undefined) {
      this.store.create(id, "stream", { entries: [entry], eventWatermark: 0 });
    } else {
      this.store.write(new Ref(id, ["entries"]), [...held.entries, entry]);
    }
  }

  /** On the root: moves the watermark of a stream past one entry. */
  #passed(stream: StreamRef): void {
    const id = this.#streamIdentifier(stream);
    const held = this.store.docs.get(id)?.value as
      | { eventWatermark: number }
      | undefined;
    if (held === undefined) return;
    this.store.write(
      new Ref(id, ["eventWatermark"]),
      held.eventWatermark + 1,
    );
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
    this.root.#bound.set(key, { run, state });
    this.#bindings.add(key);
    return new StreamRef(-1, [key], this.#owner);
  }

  /** Counts a write of the handler being run against its record. */
  written(handle: Handle): void {
    if (this.#handling === undefined) return;
    const body = this.plan.bodies[this.#handling];
    const covers = (target: { slot?: number; path?: string[] }) =>
      target.slot === handle.slot &&
      (matchesPath(target.path ?? [], handle.below) ||
        matchesPath(handle.below, target.path ?? []));
    const covered =
      body.writes.some(({ target }) =>
        target.kind === "handle" && covers(target)
      ) || body.envelopes.some((envelope) =>
        envelope.kind === "handle" && covers(envelope)
      );
    if (covered) this.counts.writesCovered += 1;
    else this.counts.writesNotCovered += 1;
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
      return this.#run(binding, undefined, bound.run, event, bound.state);
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
      let found: unknown;
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
        found = host.whole(host.at(host.output(place.output), rest));
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
      const given = read.observes === "identity"
        ? this.handleOf(found, undefined, slot)
        : host.v(found);
      if (this.gives(read.observes, state, read.path)) continue;
      // An entry that yields nothing places nothing: an entry below a
      // path that is absent does not make a container there (ES §2.4,
      // "A path the body does not read is absent from the argument").
      if (given === undefined) continue;
      state = this.placed(state, read.path, given);
    }
    return this.#run(binding, body, run, event, state);
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
  ): Outcome {
    const { root } = this;
    root.#events += 1;
    this.#handling = body;
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
  const marker = (kind: string) => (..._given: unknown[]) => {
    const made = () => {
      throw new Unsupported(`a ${kind} called in a function body`);
    };
    return made;
  };
  const caused = new Map<string, Handle>();
  // A cell constructor is called with `new` or through `of`.
  const cells = Object.assign(function (value: unknown) {
    return instance.createCell(value);
  }, {
    equals: (a: unknown, b: unknown) => instance.same(a, b),
    of: (value: unknown) => instance.createCell(value),
    // A cell a body makes under a cause is the same cell for the same
    // cause (PL §1.3).
    for: (cause: unknown) => {
      const key = JSON.stringify(cause) ?? "undefined";
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
    pattern: (id: unknown) => (argument: unknown) => {
      if (instance.loading) {
        throw new Unsupported("a pattern called at module scope");
      }
      return instance.instantiate(id, argument);
    },
    // A handler is a factory that a function body can call with the
    // state: the call binds the handler (PL §3.14).
    handler: (...given: unknown[]) => {
      const run = given.findLast((member) => typeof member === "function") as
        | ((...given: unknown[]) => unknown)
        | undefined;
      return (state: unknown) => {
        if (instance.loading || run === undefined) {
          throw new Unsupported("a handler called in a function body");
        }
        return instance.bind(run, state);
      };
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
        target: target instanceof Handle ? target.target : target,
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
  return new Proxy(known, {
    get: (target, name) => {
      if (typeof name !== "string" || name in target) {
        return target[name as string];
      }
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
