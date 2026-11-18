/**
 * A minimal executor of a compiled plan and its value code, as
 * `docs/specs/compiled-pattern-language/execution-and-storage.md` (ES)
 * describes a run: it instantiates the plan, evaluates its cones to a
 * settled state, stores the result in documents held in memory, evaluates
 * the body of an element construct once per element key, and handles
 * events by running the handler's body and evaluating again what read a
 * position the body wrote.
 *
 * It computes values and nothing else. It instantiates no label, checks
 * no constraint, persists nothing, and answers every effect as pending.
 * `SPEC-NOTES.md` (notes 281 on) lists what it needed that the plan and
 * the documents do not give.
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
  identifierOf,
  isKeySegment,
  isLink,
  isStream,
  isStreamSchema,
  keyFieldsOf,
  keySegment,
  keysOfParts,
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
  Store,
  StreamMarker,
  streamOf,
  StreamRef,
  textOf,
  withDefaults,
} from "./store.ts";

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
    name: string;
    within?: Step[];
    /** For a `reduce`: the cone of its step. */
    implementation?: { cone?: number };
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

/** A memo entry, brought up to date for the element keys of a context. */
type Lazy = (context: Context) => Entry;

/**
 * Something an evaluation used of another entry, and what it was then:
 * when the entry had last changed, or the value at a path of it.
 */
type Dependency = { stamp: (context: Context) => unknown; seen: unknown };

type Entry = {
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
   * The cones with static side-writes whose write target the evaluation
   * read or passed on: each is brought up to date before this entry is
   * taken as current (ES §2.3, "A cone with side-writes").
   */
  writers: Writer[];
  /** The value of a materializer that has not been evaluated yet. */
  pending?: boolean;
  evaluatedAt: number;
  changedAt: number;
  /**
   * The clock of the store when the entry was last found current. An
   * entry is stale by a write alone, so it stays current while the clock
   * stands.
   */
  checkedAt?: number;
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
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/**
 * How often the cones of an instance are brought up to date before the
 * executor stops: the bound on the evaluations of a cone instance in one
 * transaction (ES §2.7, "The bound").
 */
const MAX_PASSES = 10;

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
    this.instance.store.write(this.target, [...held, ...pushed]);
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
      return this.depend(instance.assembled(output.collection));
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
    if (path === undefined) {
      this.dependencies.push({
        stamp: (context) => entry(context).changedAt,
        seen: used.changedAt,
      });
    } else {
      const held = (from: Entry) =>
        canonical(this.instance.stored(this.at(from.value, path)));
      this.dependencies.push({
        stamp: (context) => held(entry(context)),
        seen: held(used),
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
  equals(a: unknown, b: unknown): boolean {
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
    if (value instanceof Ref) {
      return this.instance.store.read(value, this.reads);
    }
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

  /** A path below a value: a reference stays one, and nothing gives none. */
  at(value: unknown, path: readonly unknown[]): unknown {
    let found = value;
    for (const segment of path) {
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
      if (given === undefined) continue;
      argument = instance.placed(argument, at, given);
    }
    const keyed = { body, keys: instance.contextKeys(this.context) };
    return instance.returned(
      instance.during(instance.runCause(keyed), () => run(argument), keyed),
    );
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
    if (value instanceof Ref || value instanceof StreamRef) {
      return this.v(value);
    }
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
    { collection: number; around: readonly string[]; elements: Element[] }
  >();
  /** The record of each key that a name of the memo holds, by its text. */
  readonly #keyRecords = new Map<string, FabricValue>();
  /** The state cells that exist, by the identifier of their document. */
  readonly #cells = new Map<string, { cell: number; keys: string[] }>();
  readonly #queue: { stream: StreamRef; event: unknown }[] = [];
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
   * How many times the reads and the dependencies of a memo entry were
   * compared with what the entry saw of them.
   */
  checks = 0;

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
    } = {},
  ) {
    this.store = options.parent?.store ??
      new Store({ secret: options.secret, space: options.space });
    this.id = options.id ?? "result";
    this.argument = argumentOf(this.id);
    this.root = options.parent?.root ?? this;
    this.plan = artifact.plan;
    this.code = artifact.code;
    for (const { id, schema } of artifact.schemas) {
      if (schema !== undefined) this.#schemas.set(id, schema);
    }
    this.code.values.forEach((value, index) => {
      if (value.output !== undefined && value.function) {
        this.valueOfOutput.set(value.output, index);
      }
    });
    this.#documents.add(this.argument).add(this.id);
    this.store.create(this.argument, "argument", this.stored(argument));
    this.store.create(this.id, "result", undefined);
    this.#load();
    this.#sideWriters();
    // A state cell of the pattern's own body exists from the start, and
    // one of an element body from when its key enters the element table.
    this.#declare(new Map());
    this.settle();
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
          if (typeof found !== "object" || found === null) return undefined;
          found = force((found as Record<string, unknown>)[segment], host);
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
    return new StreamRef(
      binding,
      this.keysOf(this.plan.bindings[binding].within, { context }),
      this.#owner,
    );
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
          const now =
            this.#tables.get(table)?.elements.find((member) =>
              member.key === element.key
            )?.source ?? source;
          return now instanceof Ref || !("value" in now)
            ? undefined
            : canonical(this.stored(host.at(now.value, path)));
        };
        host.dependencies.push({ stamp: held, seen: held() });
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
        // No effect runs: the result of an operation is pending.
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
          const given = (value: unknown): unknown => {
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
  stored(value: unknown): unknown {
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
      return value.map((member) => this.stored(member));
    }
    if (isRecord(value)) {
      const members: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(value)) {
        const kept = this.stored(member);
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
    const declared = slot === undefined
      ? undefined
      : this.schemaOf(this.plan.slots[slot].schema);
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
    kind: "value" | "child" | "reduce" | "assembly" | "element" | "under",
    index: number,
    around: readonly string[],
    key?: string,
  ): string {
    const record = (text: string): FabricValue => {
      if (text === "?") return null;
      let found = this.#keyRecords.get(text);
      if (found === undefined) {
        found = recordOfKey(text);
        this.#keyRecords.set(text, found);
      }
      return found;
    };
    return textOf({
      [kind]: index,
      around: around.map(record),
      ...(key === undefined ? {} : { key: record(key) }),
    });
  }

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

  /** The entry of a computation that has not been evaluated. */
  #none(): Entry {
    return {
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
      return held ?? this.#none();
    }
    this.#open.add(key);
    const host = new Host(this, context, cone);
    const evaluatedAt = this.store.clock;
    let value: unknown;
    try {
      value = compute(host);
    } finally {
      this.#open.delete(key);
    }
    this.counts.evaluations += 1;
    if (kind === "element") this.counts.elementEvaluations += 1;
    if (kind === "assembly") this.counts.assemblies += 1;
    if (kind === "value") {
      this.trace.push(
        cone === undefined ? "result" : this.plan.cones[cone].entry,
      );
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
      value,
      stored,
      reads: host.reads,
      dependencies: host.dependencies,
      indexes: host.indexes,
      members: host.members,
      writers: host.writers,
      evaluatedAt: ownWrite ? this.store.clock : readAt,
      changedAt: changed ? this.store.clock : held.changedAt,
    };
    this.#memo.set(key, entry);
    this.#keep(key, cone, within, context);
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
    }
    this.#underKey.delete(id);
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
    const clock = this.store.clock;
    if (entry.checkedAt === clock) return true;
    // The cones whose write target the entry read or passed on are
    // brought up to date first, as an upstream output is (ES §2.3).
    for (const writer of entry.writers) writer(context);
    this.checks += 1;
    // A key that moved keeps its entries: nothing of an element is
    // evaluated on a move but what read the index (ES §2.6).
    if (this.store.changedSince(entry.evaluatedAt, entry.reads)) return false;
    const current = entry.dependencies.every((dependency) =>
      dependency.stamp(context) === dependency.seen
    );
    // A check that evaluated something that wrote is no check at the
    // clock it ended at.
    if (current && this.store.clock === clock) entry.checkedAt = clock;
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
        const held = this.#memo.get(key) ?? { ...this.#none(), pending: true };
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
      )?.elements.find((member) => member.key === key);
      const run = this.#elements.get(collection);
      if (element === undefined || run === undefined) {
        return this.#memo.get(name) ?? this.#none();
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
      return this.#ensure(key, context, undefined, "assembly", (host) => {
        const elements = this.#table(collection, host);
        // The instances of a key that left the collection are dropped,
        // and those of a key that entered are made when they are first
        // evaluated (ruling Z10).
        for (const { key: left } of this.#tables.get(key)?.elements ?? []) {
          if (!elements.some((element) => element.key === left)) {
            this.#drop(collection, around, left);
          }
        }
        this.#tables.set(key, { collection, around, elements });
        if (!this.#elements.has(collection)) {
          throw new Unsupported("an element construct that has no function");
        }
        const results = elements.map((element) =>
          host.depend(this.#perElement(collection, element.key))
        );
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
            return keyed(results);
          case "filter": {
            const kept = elements.filter((_, index) => holds(index));
            host.members = numbered(kept);
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
      }, outer);
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
    result: unknown,
    entry: Lazy,
    inner: Context,
    host: Host,
  ): {
    values: unknown[];
    members: { part: string; source: Element["source"] }[];
  } {
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
      const base = host.at(this.rootOf(slot.root, host), slot.path);
      if (base instanceof Ref) return this.#stored(base, host, keyFields);
      if (Array.isArray(base)) {
        members = base.map((member) =>
          member instanceof Ref ? member : { value: member }
        );
      }
    } else if (source.collection !== undefined) {
      const upstream = host.dependEntry(this.assembled(source.collection));
      if (upstream.members !== undefined) {
        return upstream.members.map((member, index) => ({ ...member, index }));
      }
      const held = upstream.value;
      members = (Array.isArray(held) ? held : []).map((member) =>
        member instanceof Ref ? member : { value: member }
      );
    } else {
      const held = source.output !== undefined
        ? host.output(source.output)
        : undefined;
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
    const located = this.store.locate(array, true, host.reads);
    const held = Array.isArray(located.value) ? located.value : [];
    const keys = this.store.keysOf(
      held,
      located.ref,
      undefined,
      fields ?? keyFieldsOf(located.given),
    );
    return held.map((member, index) => ({
      key: keys[index],
      index,
      source: isLink(member)
        ? this.store.locate(
          new Ref(member.$link.doc, member.$link.path),
          true,
          host.reads,
        ).named
        : located.named.key(keySegment(keys[index])),
    }));
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
    const none: Context = new Map();
    const result = this.#result;
    if (result === undefined) return;
    // A write from outside a handler, as through a member bound both
    // ways, is a transaction of its own.
    this.root.#rekey();
    for (let pass = 0; pass < MAX_PASSES; pass++) {
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
      const entry = this.#ensure(
        "result",
        none,
        undefined,
        "value",
        (host) => result.evaluate(host),
      );
      // Each marker in the value is stored as the link to its stream,
      // wherever it is: no position is checked (ruling Z43).
      this.store.write(
        new Ref(this.id, []),
        this.stored(entry.value),
      );
      // The instances that function bodies of this one made.
      for (const child of this.#children) child.settle();
      this.#afterWave = true;
      try {
        for (const materializer of this.#materializers) materializer(none);
      } finally {
        this.#afterWave = false;
      }
      this.#declare(none);
      if (this.store.clock === before) break;
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
        const recorded = this.store.streams.get(at.doc)?.some((entry) =>
          canonical(entry.path) === canonical(at.path)
        );
        if (!recorded) {
          throw new Error("a stream link the store did not record");
        }
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

  queue(stream: StreamRef, event: unknown): void {
    this.root.#queue.push({ stream, event });
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
    const record = this.plan.bindings[binding];
    const context = new Map<number, Element>();
    const keys: string[] = [];
    let step = 0;
    for (const { element } of record.within) {
      if (element === undefined) continue;
      const table = this.#tableOf(element, context) ?? [];
      const chosen = table[positions[step] ?? table.length - 1];
      step += 1;
      if (chosen === undefined) {
        return {
          binding,
          committed: false,
          error: "no element holds the stream",
        };
      }
      context.set(element, chosen);
      keys.push(chosen.key);
    }
    this.queue(new StreamRef(binding, keys, this.#owner), event);
    const outcome = this.root.#drain(context, binding);
    this.root.settle();
    return outcome;
  }

  /**
   * Handles the events that are queued, as one that a writer outside the
   * instance sent through a stored link to a stream, and evaluates what
   * read a position their handlers wrote. Returns how each ended.
   */
  dispatch(): Outcome[] {
    const outcomes: Outcome[] = [];
    this.root.#drain(undefined, -1, outcomes);
    this.root.settle();
    return outcomes;
  }

  /** Handles the queued events, each in the instance its stream is of. */
  #drain(
    first: Context | undefined,
    binding: number,
    outcomes?: Outcome[],
  ): Outcome {
    let outcome: Outcome = { binding, committed: true };
    let context: Context | undefined = first;
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
          context ?? target.#contextOf(next.stream),
        );
      outcomes?.push(handled);
      if (context !== undefined) outcome = handled;
      context = undefined;
    }
    return outcome;
  }

  /** The elements a stream's keys name, from the element tables. */
  #contextOf(stream: StreamRef): Context {
    const context = new Map<number, Element>();
    let step = 0;
    for (
      const { element } of this.plan.bindings[stream.binding]?.within ?? []
    ) {
      if (element === undefined) continue;
      const key = stream.keys[step];
      step += 1;
      for (const table of this.#tables.values()) {
        if (table.collection !== element) continue;
        const found = table.elements.find((member) => member.key === key);
        if (found !== undefined) context.set(element, found);
      }
    }
    return context;
  }

  #handle(stream: StreamRef, event: unknown, context: Context): Outcome {
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
        found = host.at(host.output(place.output), rest);
      } else if (place.stream !== undefined) {
        found = this.streamFor(place.stream, context);
      } else if (place.result === true) {
        // The name bound to `[SELF]`: a reference to the result cell of
        // the instance, as value code is given one (ruling Z28).
        found = host.at(new Ref(this.id, []), rest);
      } else {
        found = host.at(place.constant, rest);
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
   * Runs a handler for an event. A handler that throws commits nothing
   * (PL §5.4): the documents are as they were, and what the run queued,
   * instantiated and bound is gone.
   */
  #run(
    binding: number,
    body: number | undefined,
    run: (...given: unknown[]) => unknown,
    event: unknown,
    state: unknown,
  ): Outcome {
    const { root } = this;
    const before = [...this.store.docs].map((
      [id, document],
    ) => [id, structuredClone(document)] as const);
    const queued = root.#queue.length;
    const instances = new Set(root.#instances.keys());
    const bound = new Map(root.#bound);
    const children = this.#children.length;
    root.#events += 1;
    this.#handling = body;
    try {
      this.during(
        { handling: { parent: root.id, event: root.#events } },
        () => run(event, state),
      );
    } catch (error) {
      this.store.docs.clear();
      for (const [id, document] of before) this.store.docs.set(id, document);
      this.store.clock += 1;
      for (const [id] of before) {
        this.store.log.push({ doc: id, path: [], at: this.store.clock });
      }
      root.#queue.length = queued;
      for (const id of [...root.#instances.keys()]) {
        if (!instances.has(id)) root.#instances.delete(id);
      }
      for (const [name, { instance }] of [...root.#made]) {
        if (!root.#instances.has(instance.id)) root.#made.delete(name);
      }
      root.#bound.clear();
      for (const [key, held] of bound) root.#bound.set(key, held);
      this.#children.length = children;
      this.store.rekeys.length = 0;
      return {
        binding,
        committed: false,
        error: `${(error as Error)?.message ?? error}`.split("\n")[0],
      };
    } finally {
      this.#handling = undefined;
    }
    root.#rekey();
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
      const held = table.elements.some(({ source }) =>
        source instanceof Ref && source.doc === rekey.doc &&
        isElement(source.path)
      );
      if (held) over.add(table.collection);
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
    for (const [name, table] of [...this.#tables]) {
      const { collection, around } = table;
      if (!over.has(collection)) continue;
      this.#tables.set(name, {
        collection,
        around,
        elements: table.elements.map((member) => {
          const key = renamed(member.key);
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
      });
    }
    // An instance called through `asInstance()` is re-keyed with the
    // element, as the rest of what the old key holds is (PL §3.15,
    // assumed there under question 123). It keeps its documents.
    for (const [id, held] of [...this.#asInstances]) {
      const steps = (this.plan.children?.[held.child].within ?? []).flatMap((
        step,
      ) => step.element === undefined ? [] : [step.element]);
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
      return (..._given: unknown[]) => {
        if (instance.loading) return undefined;
        throw new Unsupported(`the built-in \`${name}\` in a function body`);
      };
    },
  });
};

/** The artifacts of the output of `pattern-compiler emit`. */
export const artifactsOf = (
  emitted: { module: string; patterns: Artifact[] }[],
): Artifact[] => emitted.flatMap(({ patterns }) => patterns);
