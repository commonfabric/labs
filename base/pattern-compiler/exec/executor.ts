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
  canonical,
  isLink,
  isStream,
  isStreamSchema,
  keySegment,
  markerOf,
  type Position,
  Ref,
  type Schema,
  schemaBelow,
  Store,
  StreamMarker,
  streamOf,
  StreamRef,
  withDefaults,
} from "./store.ts";

type Root = {
  kind: string;
  cell?: number;
  collection?: number;
  handler?: number;
  operation?: number;
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
    within: { element?: number; site?: string }[];
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
    kept: boolean;
    interim?: string;
  }[];
  edges: { from: number; to: number; via: { kind: string; output?: number } }[];
  collections: {
    name: string;
    construct: string;
    within: { element?: number; site?: string }[];
    source: { slot?: number; collection?: number; output?: number };
  }[];
  bodies: {
    kind: string;
    name: string;
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
    name: string;
    scope: string;
    within: { element?: number; site?: string }[];
    /** The schema of the cell's value, with a constant first value as
     * its default. */
    schema?: string;
    /** The cone and its write edge that give a first value that is not
     * a constant. */
    first?: { cone: number; write: number };
  }[];
  operations: {
    kind: string;
    name: string;
    within?: { element?: number; site?: string }[];
    /** For a `reduce`: the cone of its step. */
    implementation?: { cone?: number };
  }[];
  bindings: {
    name?: string;
    handler: { body?: number };
    within: { element?: number; site?: string }[];
    state: {
      path: string[];
      place?: {
        slot?: number;
        output?: number;
        stream?: number;
        constant?: unknown;
      };
      /**
       * For a binding of a pattern compiled in whose `place` is a slot
       * the call bound: the default the callee declares for the path
       * (PL §8, question 110, assumed).
       */
      default?: unknown;
    }[];
    /**
     * The paths of the result at which the instance stores a link to the
     * binding's stream, each with what its `*` stand for (PL §1.1,
     * `ResultPath`).
     */
    result?: ResultPath[];
  }[];
};

/**
 * What one `*` of a path of `Binding.result` stands for (PL §1.1,
 * `ResultStar`; ruling Z21): the positions of a collection for whose
 * keys the binding has an `element` step, every position of a collection
 * whose callback writes the stream, the one position of a member written
 * after a spread, with the number of entries written before it, or the
 * one element of a collection that holds the stream inside its value.
 */
export type ResultStar =
  | { kind: "element" | "every" | "inside" }
  | { kind: "member"; index: number };

/** One path of `Binding.result`, with one entry of `stars` for each `*`. */
export type ResultPath = { path: string[]; stars: ResultStar[] };

/**
 * Where a position of an array the executor assembled came from: the
 * entry the array was written with, counted over its members and its
 * spreads, whether the position is an element of what a spread entry
 * holds, and for an element of the result of a per-element construct
 * the element's key.
 */
export type Origin = { entry: number; spread: boolean; key?: string };

/** The origin of each position of an array the executor assembled. */
const origins = new WeakMap<object, readonly Origin[]>();

/**
 * The elements of the assembled result of a per-element construct, by
 * the array, each with its key, and the element keys the construct was
 * evaluated under.
 */
const assembledElements = new WeakMap<
  object,
  { members: readonly Element[]; context: Context }
>();

/** An entry of an array that is written as a spread. */
class Spread {
  constructor(readonly values: readonly unknown[]) {}
}

/**
 * The array a list of written entries stands for: a member at one
 * position, and what a spread holds at one position each. The array has
 * the origin of each position: a position spread from an array that has
 * origins has the origin it has there.
 */
const assembledFrom = (entries: readonly unknown[]): unknown[] => {
  if (origins.has(entries)) return entries as unknown[];
  const flat: unknown[] = [];
  const from: Origin[] = [];
  for (let entry = 0; entry < entries.length; entry++) {
    const written = entries[entry];
    if (!(written instanceof Spread)) {
      flat.push(written);
      from.push({ entry, spread: false });
      continue;
    }
    const inner = origins.get(written.values);
    written.values.forEach((value, index) => {
      flat.push(value);
      from.push(inner?.[index] ?? { entry, spread: true });
    });
  }
  origins.set(flat, from);
  return flat;
};

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
};

/** Brings the instances of a side-writing cone up to date. */
type Writer = (context: Context) => void;

const sameRoot = (a: Root, b: Root): boolean =>
  a.kind === b.kind && a.cell === b.cell && a.collection === b.collection &&
  a.handler === b.handler && a.operation === b.operation;

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

const addressOf = (ref: Ref): string => `${ref.doc}:${canonical(ref.path)}`;

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

/**
 * Whether a path with `*` names a position: segment for segment, with
 * `*` for any index.
 */
const namesPosition = (listed: readonly string[], path: readonly string[]) =>
  listed.length === path.length &&
  listed.every((segment, index) =>
    segment === path[index] || (segment === "*" && /^\d+$/.test(path[index]))
  );

/**
 * Whether the key of a position starts with the key of an enclosing
 * collection: the key itself, or the key followed by the part that a
 * `flatMap` adds for a member of the segment (ruling Z22).
 */
const keyStartsWith = (key: string, prefix: string): boolean =>
  key === prefix || key.startsWith(`${prefix}/`);

/**
 * Whether a path `Binding.result` lists covers a position of the result
 * for a marker (PL §1.1, "What a `*` of a result path stands for"):
 * segment for segment, and at each `*` the position has to be of the
 * kind the path states. `trail` has the origin of each position of
 * `path` that is a position of an array the executor assembled, and
 * `keys` the keys of the marker's stream, one for each `element` step
 * of its binding.
 *
 * - `element`: an element of a collection, at a position whose key
 *   starts with the key of the marker for that step (ruling Z30). At the
 *   result of a `map` or a `filter` that is the position that holds the
 *   key, and at the result of a `flatMap` each member of the segment of
 *   that source key.
 * - `every` and `inside`: an element of a collection, and no member
 *   written beside it.
 * - `member`: the member written at the stated entry, and no element of
 *   a collection spread before it.
 */
export const coversPosition = (
  listed: ResultPath,
  path: readonly string[],
  trail: readonly (Origin | undefined)[],
  keys: readonly string[],
): boolean => {
  if (listed.path.length !== path.length) return false;
  let star = 0;
  let step = 0;
  for (let index = 0; index < path.length; index++) {
    const segment = listed.path[index];
    if (segment !== "*") {
      if (segment !== path[index]) return false;
      continue;
    }
    if (!/^\d+$/.test(path[index])) return false;
    const stated = listed.stars[star];
    star += 1;
    const origin = trail[index];
    if (stated === undefined || origin === undefined) return false;
    switch (stated.kind) {
      case "element": {
        const key = keys[step];
        step += 1;
        if (
          !origin.spread || key === undefined || origin.key === undefined ||
          !keyStartsWith(origin.key, key)
        ) {
          return false;
        }
        break;
      }
      case "every":
      case "inside":
        if (!origin.spread) return false;
        break;
      case "member":
        if (origin.spread || origin.entry !== stated.index) return false;
        break;
    }
  }
  return true;
};

/**
 * A value in stored form with `value` at a path of it, and with nothing
 * there where `value` is nothing.
 */
const replaced = (
  holder: unknown,
  path: readonly string[],
  value: unknown,
): unknown => {
  if (path.length === 0) return value;
  const [first, ...rest] = path;
  if (Array.isArray(holder)) {
    const copy = [...holder];
    copy[Number(first)] = replaced(copy[Number(first)], rest, value);
    return copy;
  }
  if (!isRecord(holder)) return holder;
  const { [first]: held, ...others } = holder;
  const member = replaced(held, rest, value);
  return member === undefined ? others : { ...others, [first]: member };
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
      const keys = store.keysOf(located.value, located.ref);
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
    const held = Array.isArray(located.value) ? located.value : [];
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
    return this.value(value);
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
    if (Array.isArray(value)) {
      // The copy is the array the executor assembled, position for
      // position.
      const copy = value.map((member) => this.v(member));
      const from = origins.get(value);
      if (from !== undefined) origins.set(copy, from);
      return copy;
    }
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
    return instance.returned(
      instance.during(
        `body:${body}:${canonical(instance.contextKeys(this.context))}`,
        () => run(argument),
      ),
    );
  }

  /**
   * A computed value as a body is handed it: what a reference names, read
   * as a value. A marker is handed as a handle to its stream, wherever it
   * is in the value: the body can send to it and can return it, and what
   * it returns holds the reference to the stream, which is stored as a
   * link and not checked against `Binding.result` (ruling Z20).
   */
  pass(value: unknown): unknown {
    if (value instanceof Ref || value instanceof StreamRef) {
      return this.v(value);
    }
    if (value instanceof StreamMarker) {
      return this.instance.handleOf(value, this);
    }
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
 * A marker at a position of the result that no listed path of its
 * binding covers: the binding, the position, and the top-level property
 * of the result that holds the position.
 */
export type StreamError = { property: string; binding: number; path: string[] };

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
   * What the identifier of each document of the instance begins with:
   * nothing for the instance the executor was started with, and for an
   * instance a function body made the name of that instance.
   */
  readonly prefix: string;
  /** The instance the executor was started with. */
  readonly root: Instance;
  /** On the root: every instance a function body made, by its prefix. */
  readonly #instances = new Map<string, Instance>();
  /** The instances that a function body of this instance made. */
  readonly #children: Instance[] = [];
  /**
   * On the root: each binding a function body made, by the key of its
   * stream, with the handler and the state the body bound.
   */
  readonly #bound = new Map<
    string,
    { run: (...given: unknown[]) => unknown; state: unknown }
  >();
  /**
   * The run of a function body in progress: what names it, and how many
   * instances and bindings it has made (ES §2.8, "Identity").
   */
  #running: { name: string; made: number } | undefined;
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
  /** The element table of each collection, by the keys around it. */
  readonly #tables = new Map<string, Element[]>();
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
   * The markers that failed the check of where a stream is stored
   * (rulings Z11, Z19 and Z29): one entry for each marker at a position
   * no listed path of the marker's binding covers, in each evaluation
   * that stored the result. The evaluation that fails is the one that
   * stores the value. `property` is the top-level property of the result
   * that holds the position: nothing at or below it is written, and it
   * keeps what was stored.
   */
  readonly failures: StreamError[] = [];
  /**
   * The errors recorded on the instance (ruling Z29): for each top-level
   * property of the result that the last evaluation did not store, the
   * markers that failed the check. The next evaluation that stores the
   * property clears its errors (ES §2.2, "What fails", assumed there).
   */
  errors: StreamError[] = [];
  /** Every such position, over all failed evaluations, once each. */
  readonly misplaced: { binding: number; path: string[] }[] = [];
  readonly #checked = new WeakMap<Entry, StreamError[]>();

  constructor(
    readonly artifact: Artifact,
    argument: unknown,
    /**
     * `space`: the space the instance is in, which `spaceOf` gives.
     * `artifacts`: the artifact of a pattern, by the identity its plan
     * begins with (`Plan.patterns`), for a pattern that a function body
     * instantiates. `parent` and `prefix`: for an instance a function
     * body made, the instance that made it and the name of this one.
     */
    readonly options: {
      space?: string;
      artifacts?: (id: string) => Artifact | undefined;
      parent?: Instance;
      prefix?: string;
    } = {},
  ) {
    this.store = options.parent?.store ?? new Store();
    this.prefix = options.prefix ?? "";
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
    this.store.create(this.doc("argument"), "argument", this.stored(argument));
    this.store.create(this.doc("result"), "result", undefined);
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
        const around = this.#contextKey(this.#outerOf(collection), known);
        const table = this.#tables.get(`a${collection}|${around}`) ?? [];
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
      self: new Ref(this.doc("result"), []),
      setups: this.#setups,
      external: (specifier: string) => instance.#external(specifier),
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
      // An array written with a spread: the executor assembles it, and
      // has the entry each position came from (ruling Z21).
      spread: (value: unknown) =>
        new Spread(
          Array.isArray(value)
            ? value
            : value === undefined || value === null
            ? []
            : Array.from(value as Iterable<unknown>),
        ),
      list: (entries: unknown[]) => assembledFrom(entries),
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
      this.prefix,
    );
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
        return new Ref(this.doc("argument"), []);
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
    const id = this.doc(`state:${cell}:${canonical(keys)}`);
    if (!this.#cells.has(id)) {
      this.#cells.set(id, { cell, keys });
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
   * The place of the record of a key of a list. It holds nothing, and
   * has no document, until something writes it.
   */
  keyedElement(list: Ref, key: string): Ref {
    const id = `keyed:${addressOf(this.store.locate(list, true).ref)}:${key}`;
    if (!this.store.declared.has(id)) {
      this.store.declare(id, "keyed element", undefined);
    }
    return new Ref(id, []);
  }

  /** A cell a function body made. */
  createCell(value: unknown): Handle {
    this.#created += 1;
    const id = this.doc(`created:${this.#created}`);
    this.store.create(id, "created cell", this.stored(value));
    return new Handle(this, new Ref(id, []), undefined, undefined, []);
  }

  /** A value in stored form: each reference in it as a link. */
  stored(value: unknown): unknown {
    if (value instanceof Ref) {
      return {
        $link: {
          doc: value.doc,
          path: [...value.path],
          ...(value.schema === undefined ? {} : { schema: value.schema }),
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
    this.#created += 1;
    const id = this.doc(`record:${this.#created}`);
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
      this.#created += 1;
      const id = this.doc(`constant:${this.#created}`);
      this.store.create(id, "held constant", this.stored(value));
      return new Handle(this, new Ref(id, []), host, slot, [], declared, true);
    }
    return value;
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
        return `stream:${value.target.instance}:${value.target.binding}:${
          canonical(value.target.keys)
        }`;
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
        : addressOf(this.store.locate(ref, true).ref);
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

  #contextKey(collections: readonly number[], context: Context): string {
    return collections.map((collection) => context.get(collection)?.key ?? "?")
      .join("\u0001");
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
      const id = this.#keyId(
        collection,
        this.#contextKey(this.#outerOf(collection), context),
        context.get(collection)?.key ?? "?",
      );
      const under = this.#underKey.get(id) ?? new Set();
      under.add(key);
      this.#underKey.set(id, under);
    }
  }

  #keyId(collection: number, around: string, key: string): string {
    return `${collection}|${around}|${key}`;
  }

  /**
   * Drops what is kept under an element key that left its collection:
   * the instances of every cone whose `within` names the collection, and
   * the element tables and assemblies of the collections inside it
   * (ES §2.5, "Which cones are the body's").
   */
  #drop(collection: number, around: string, key: string): void {
    const id = this.#keyId(collection, around, key);
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
      if (kept.cone === cone) found.set(canonical(kept.keys), kept.keys);
    }
    return [...found.values()];
  }

  #current(entry: Entry, context: Context): boolean {
    for (const [collection, index] of entry.indexes) {
      if (context.get(collection)?.index !== index) return false;
    }
    // The cones whose write target the entry read or passed on are
    // brought up to date first, as an upstream output is (ES §2.3).
    for (const writer of entry.writers) writer(context);
    // A key that moved keeps its entries: nothing of an element is
    // evaluated on a move but what read the index (ES §2.6).
    if (this.store.changedSince(entry.evaluatedAt, entry.reads)) return false;
    return entry.dependencies.every((dependency) =>
      dependency.stamp(context) === dependency.seen
    );
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
      const key = `v${value}|${this.#contextKey(within, context)}`;
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
      const key = `r${operation}|${this.#contextKey(outer, context)}`;
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
      const around = this.#contextKey(outer, context);
      const name = `e${collection}|${around}|${key}`;
      const element = this.#tables.get(`a${collection}|${around}`)?.find((
        member,
      ) => member.key === key);
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
      const key = `a${collection}|${this.#contextKey(outer, context)}`;
      const around = this.#contextKey(outer, context);
      return this.#ensure(key, context, undefined, "assembly", (host) => {
        const elements = this.#table(collection, host);
        // The instances of a key that left the collection are dropped,
        // and those of a key that entered are made when they are first
        // evaluated (ruling Z10).
        for (const { key: left } of this.#tables.get(key) ?? []) {
          if (!elements.some((element) => element.key === left)) {
            this.#drop(collection, around, left);
          }
        }
        this.#tables.set(key, elements);
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
          origins.set(
            array,
            (host.members ?? []).map(({ key }) => ({
              entry: 0,
              spread: true,
              key,
            })),
          );
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
                members.push({ key: `${key}/${part}`, source });
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
    const seen = new Map<string, number>();
    return members.map((member) => {
      let part: string;
      if (member instanceof Ref) {
        const { named } = this.store.locate(member, true, undefined, true);
        part = `cell:${named.doc}:${canonical(named.path)}`;
      } else {
        part = `value:${canonical(this.stored(member))}`;
      }
      const count = seen.get(part) ?? 0;
      seen.set(part, count + 1);
      return `${part}#${count}`;
    });
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
    const { source } = this.plan.collections[collection];
    let members: (Ref | { value: unknown })[] = [];
    if (source.slot !== undefined) {
      const slot = this.plan.slots[source.slot];
      host.demand(slot.root, slot.path);
      const base = host.at(this.rootOf(slot.root, host), slot.path);
      if (base instanceof Ref) return this.#stored(base, host);
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
      if (held instanceof Ref) return this.#stored(held, host);
      members = (Array.isArray(held) ? held : []).map((member) =>
        member instanceof Ref ? member : { value: member }
      );
    }
    const seen = new Map<string, number>();
    return members.map((member, index) => {
      // A reference is keyed by what it names, and a value by itself.
      let part: string;
      if (member instanceof Ref) {
        const { named } = this.store.locate(member, true);
        part = `cell:${named.doc}:${canonical(named.path)}`;
      } else {
        part = `value:${canonical(host.v(member.value))}`;
      }
      const count = seen.get(part) ?? 0;
      seen.set(part, count + 1);
      return { key: `${part}#${count}`, index, source: member };
    });
  }

  /**
   * The elements of a stored array. An element whose position holds a
   * link is the cell the link leads to. An element that is a plain value
   * in place is named by the array and its key, and its `source` is that
   * reference by key (ruling Z12).
   */
  #stored(array: Ref, host: Host): Element[] {
    const located = this.store.locate(array, true, host.reads);
    const held = Array.isArray(located.value) ? located.value : [];
    const keys = this.store.keysOf(held, located.ref);
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
      // A marker at a position of the result that no listed path of its
      // binding covers fails the evaluation that stores it: the output
      // that holds the position keeps what was stored, and the other
      // outputs are stored (ES §2.2, "The check" and "What fails").
      let stored = this.stored(entry.value);
      const failed = this.#check(entry);
      for (const property of new Set(failed.map((error) => error.property))) {
        stored = replaced(stored, [property], this.#storedAt([property]));
      }
      this.errors = failed;
      this.store.write(new Ref(this.doc("result"), []), stored);
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
   * Checks the markers in the value of the result against
   * `Binding.result` (PL §1.1, "The listed paths are complete"): each
   * marker has to be at a position that a listed path of its binding
   * covers. A `*` of a listed path matches a position of the kind the
   * path states for it (`coversPosition`; ruling Z21).
   * A listed path below a conditional is listed whichever branch is
   * selected, so it matches under either selection. The check is of the
   * positions of the result alone: a reference in the value is not
   * followed, and a marker stored in another document is not checked.
   * Returns one error for each marker that no listed path covers, with
   * the top-level property of the result that holds its position
   * (ruling Z29). The property is defined for every position: also for
   * one that no entry of `Plan.outputs` is at or above.
   */
  #check(entry: Entry): StreamError[] {
    const known = this.#checked.get(entry);
    if (known !== undefined) return known;
    const found: StreamError[] = [];
    const walk = (
      value: unknown,
      path: string[],
      trail: (Origin | undefined)[],
    ) => {
      if (value instanceof StreamMarker) {
        const { binding, keys } = streamOf(value);
        const listed = this.plan.bindings[binding]?.result ?? [];
        if (!listed.some((entry) => coversPosition(entry, path, trail, keys))) {
          found.push({ property: path[0], binding, path });
        }
      } else if (Array.isArray(value)) {
        const from = origins.get(value);
        value.forEach((member, index) =>
          walk(member, [...path, `${index}`], [...trail, from?.[index]])
        );
      } else if (isRecord(value)) {
        for (const [name, member] of Object.entries(value)) {
          walk(member, [...path, name], [...trail, undefined]);
        }
      }
    };
    // A marker that is the whole result has no property to hold it, and
    // is not checked: a pattern's result is a record.
    if (!(entry.value instanceof StreamMarker)) walk(entry.value, [], []);
    for (const error of found) {
      this.failures.push(error);
      const position = { binding: error.binding, path: error.path };
      const id = canonical(position);
      if (!this.misplaced.some((other) => canonical(other) === id)) {
        this.misplaced.push(position);
      }
    }
    this.#checked.set(entry, found);
    return found;
  }

  /** What the result document stores at a path, with no link followed. */
  #storedAt(path: readonly string[]): unknown {
    let held = this.store.docs.get(this.doc("result"))?.value;
    for (const segment of path) {
      if (Array.isArray(held)) held = held[Number(segment)];
      else if (isRecord(held)) held = held[segment];
      else return undefined;
    }
    return held;
  }

  /**
   * Writes through the reference the result document holds at a path, as
   * the rendered tree does at an attribute bound both ways, and evaluates
   * what read the position written.
   */
  writeThrough(path: string[], value: unknown): void {
    this.store.write(new Ref(this.doc("result"), path), this.stored(value));
    this.settle();
  }

  /**
   * Writes a path of the argument document, as a writer outside the
   * instance does, and evaluates what read it.
   */
  writeArgument(path: string[], value: unknown): void {
    this.store.write(new Ref(this.doc("argument"), path), this.stored(value));
    this.settle();
  }

  /** The result, with every link in it followed. */
  result(): unknown {
    return this.store.read(new Ref(this.doc("result"), []));
  }

  /**
   * The value of each state cell that exists: what its document holds,
   * or the default of its schema where nothing wrote it.
   */
  stateCells(): { name: string; keys: string[]; value: unknown }[] {
    return [...this.#cells].map(([id, { cell, keys }]) => ({
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
   * Compares where the stored result holds a link to the stream of a
   * binding with the paths `Binding.result` lists (PL §1.1): the
   * positions that a listed path names, the positions no listed path
   * names, and the listed paths without `*` at which the result holds
   * the stream and at which it holds none.
   */
  streamPositions(): {
    atListedPath: number;
    atNoListedPath: number;
    listedPathsHeld: number;
    listedPathsNotHeld: number;
  } {
    const found: { binding: number; path: string[] }[] = [];
    const open = new Set<string>();
    const walk = (value: unknown, path: string[]) => {
      if (isStream(value)) {
        found.push({ binding: value.$stream.binding, path });
      } else if (isLink(value)) {
        const located = this.store.locate(
          new Ref(value.$link.doc, value.$link.path),
          true,
        );
        const id = addressOf(located.ref);
        if (open.has(id)) return;
        open.add(id);
        walk(located.value, path);
        open.delete(id);
      } else if (Array.isArray(value)) {
        value.forEach((member, index) => walk(member, [...path, `${index}`]));
      } else if (isRecord(value)) {
        for (const [name, member] of Object.entries(value)) {
          walk(member, [...path, name]);
        }
      }
    };
    walk(this.store.docs.get(this.doc("result"))?.value, []);
    const names = (listed: ResultPath, path: string[]) =>
      namesPosition(listed.path, path);
    const counts = {
      atListedPath: 0,
      atNoListedPath: 0,
      listedPathsHeld: 0,
      listedPathsNotHeld: 0,
    };
    for (const { binding, path } of found) {
      const listed = this.plan.bindings[binding]?.result ?? [];
      if (listed.some((entry) => names(entry, path))) counts.atListedPath += 1;
      else counts.atNoListedPath += 1;
    }
    this.plan.bindings.forEach((record, binding) => {
      for (const listed of record.result ?? []) {
        if (listed.path.includes("*")) continue;
        const held = found.some((entry) =>
          entry.binding === binding && names(listed, entry.path)
        );
        if (held) counts.listedPathsHeld += 1;
        else counts.listedPathsNotHeld += 1;
      }
    });
    return counts;
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

  /** The identifier of a document of this instance. */
  doc(name: string): string {
    return `${this.prefix}${name}`;
  }

  /**
   * Names what the run of a function body in progress makes next: the
   * run, and the ordinal among what it has made (ES §2.8, "Identity").
   * The run of a `lift` or a `computed` is named by the body and the
   * element keys it is evaluated for, so an evaluation that makes the
   * same things again names the same ones. The run of a handler is named
   * by its event, so each event makes its own.
   */
  #made(): string {
    const running = this.#running ?? { name: "outside", made: 0 };
    const name = `${running.name}/${running.made}`;
    running.made += 1;
    return name;
  }

  /** Runs a function body under a name for what it makes. */
  during<T>(name: string, run: () => T): T {
    const outer = this.#running;
    this.#running = { name, made: 0 };
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
   * an instance that exists writes its argument and makes nothing.
   */
  instantiate(id: unknown, argument: unknown): Handle {
    const artifact = typeof id === "string"
      ? this.options.artifacts?.(id)
      : undefined;
    if (artifact === undefined) {
      throw new Unsupported("a pattern called in a function body");
    }
    const prefix = `${this.prefix}instance:${this.#made()}:`;
    const given = this.stored(this.returned(argument));
    let child = this.root.#instances.get(prefix);
    if (child === undefined) {
      child = new Instance(artifact, given, {
        ...this.options,
        parent: this,
        prefix,
      });
      this.root.#instances.set(prefix, child);
      this.#children.push(child);
    } else {
      this.store.write(new Ref(child.doc("argument"), []), given);
    }
    return new Handle(
      this,
      new Ref(child.doc("result"), []),
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
    const key = `${this.prefix}bound:${this.#made()}`;
    this.root.#bound.set(key, { run, state });
    return new StreamRef(-1, [key], this.prefix);
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
      const outer = this.plan.collections[element].within.flatMap((within) =>
        within.element === undefined ? [] : [within.element]
      );
      const table = this.#tables.get(
        `a${element}|${this.#contextKey(outer, context)}`,
      ) ?? [];
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
    this.queue(new StreamRef(binding, keys, this.prefix), event);
    const outcome = this.root.#drain(context, binding);
    this.root.settle();
    return outcome;
  }

  /**
   * Handles the events that are queued, as one that a writer outside the
   * instance sent through a stored link to a stream, and evaluates what
   * read a position their handlers wrote.
   */
  dispatch(): void {
    this.root.#drain(undefined, -1);
    this.root.settle();
  }

  /** Handles the queued events, each in the instance its stream is of. */
  #drain(first: Context | undefined, binding: number): Outcome {
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
      for (const [name, table] of this.#tables) {
        if (!name.startsWith(`a${element}|`)) continue;
        const found = table.find((member) => member.key === key);
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
      this.during(`event:${root.#events}`, () => run(event, state));
    } catch (error) {
      this.store.docs.clear();
      for (const [id, document] of before) this.store.docs.set(id, document);
      this.store.clock += 1;
      for (const [id] of before) {
        this.store.log.push({ doc: id, path: [], at: this.store.clock });
      }
      root.#queue.length = queued;
      for (const prefix of [...root.#instances.keys()]) {
        if (!instances.has(prefix)) root.#instances.delete(prefix);
      }
      root.#bound.clear();
      for (const [key, held] of bound) root.#bound.set(key, held);
      this.#children.length = children;
      return {
        binding,
        committed: false,
        error: `${(error as Error)?.message ?? error}`.split("\n")[0],
      };
    } finally {
      this.#handling = undefined;
    }
    return { binding, committed: true };
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
