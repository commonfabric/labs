/**
 * What the design fixes about the cost of running a plan, derived from the
 * plan's records and from the number of element keys of each collection.
 * Nothing executes a plan, so every number here is a count the documents
 * give a rule for, and none is a measurement.
 *
 * `execution-and-storage.md` is cited as ES and
 * `plan-and-label-templates.md` as PL.
 */

/** A step of `within` (PL §1.1, `WithinStep`). */
export type Step = { site?: string; element?: number };

type SlotRoot = {
  kind: string;
  collection?: number;
  cell?: number;
  handler?: number;
  operation?: number;
};

type TemplateNode = { op?: string };

/** The records of a plan that the derivation reads (PL §1.1). */
export type CostPlan = {
  cones: { slots: number[]; writes?: unknown[] }[];
  edges: { from: number; to: number; via: { kind: string } }[];
  slots: { root: SlotRoot; path: string[] }[];
  outputs: {
    cone?: number;
    kept: boolean;
    path: string[];
    template?: TemplateNode;
  }[];
  collections: {
    construct: string;
    within?: Step[];
    /** What the collection iterates: a slot, an output, or a collection. */
    source?: { slot?: number; output?: number; collection?: number };
  }[];
  stateCells: { within?: Step[] }[];
  operations: { kind?: string; within?: Step[] }[];
  children: { within?: Step[] }[];
  bindings: {
    within?: Step[];
    handler?: { body?: number };
    state?: { path: string[]; capture?: string; place?: { slot?: number } }[];
  }[];
  bodies: {
    kind: string;
    writes?: { target: { kind: string; slot?: number } }[];
  }[];
};

/** The number of element keys of the collection of an index. */
export type Sizes = (collection: number) => number;

/** A count the rules bound from both sides. */
export type Range = { min: number; max: number };

/**
 * How many times a record with the steps `within` exists in one instance:
 * once per combination of element keys of the collections that enclose it.
 */
export const instancesWithin = (
  within: Step[] | undefined,
  size: Sizes,
): number =>
  (within ?? []).reduce(
    (count, step) =>
      step.element === undefined ? count : count * size(step.element),
    1,
  );

/**
 * The collection whose element body each cone belongs to, or `undefined`
 * for a cone of no element body. A cone belongs to the innermost
 * collection among those an `element` or `index` slot of it names and
 * those the cones it has an incoming edge from belong to: a cone that
 * reads the output of an element cone is evaluated per element key, as
 * that cone is (ES §2.1, §2.5).
 */
export const coneCollections = (plan: CostPlan): (number | undefined)[] => {
  const depth = (collection: number | undefined): number =>
    collection === undefined ? 0 : 1 +
      (plan.collections[collection]?.within ?? []).filter((step) =>
        step.element !== undefined
      ).length;
  const deeper = (a: number | undefined, b: number | undefined) =>
    depth(b) > depth(a) ? b : a;
  const of: (number | undefined)[] = plan.cones.map((cone) =>
    cone.slots.reduce<number | undefined>((found, slot) => {
      const root = plan.slots[slot]?.root;
      return root?.kind === "element" || root?.kind === "index"
        ? deeper(found, root.collection)
        : found;
    }, undefined)
  );
  // An edge can only raise the depth of its target, and the depth is
  // bounded by the nesting of the collections, so this ends.
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of plan.edges) {
      if (edge.via.kind !== "output") continue;
      const next = deeper(of[edge.to], of[edge.from]);
      if (next !== of[edge.to]) {
        of[edge.to] = next;
        changed = true;
      }
    }
  }
  return of;
};

/** The cone instances of each cone: one per element key it is under. */
export const coneInstances = (plan: CostPlan, size: Sizes): number[] =>
  coneCollections(plan).map((collection) =>
    collection === undefined ? 1 : size(collection) *
      instancesWithin(plan.collections[collection]?.within, size)
  );

const sum = (counts: number[]) => counts.reduce((a, b) => a + b, 0);

/** What is derived for an instance that was started and has settled. */
export type SettledCost = {
  /** The records of the plan, counted. */
  records: {
    cones: number;
    bodies: number;
    bindings: number;
    effects: number;
    operations: number;
    stateCells: number;
    children: number;
    collections: number;
    keptOutputs: number;
  };
  /** Cone instances: each is evaluated once to settle (ES §2.1, §2.5). */
  coneInstances: number;
  /** Streams: one per binding and combination of element keys (ES §4.7). */
  streams: number;
  /**
   * Transactions from nothing stored to settled (ES §1.1, §1.2): the one
   * that creates the instance and writes its argument, and one derivation
   * transaction for the change of demand, which evaluates every demanded
   * cone instance of the instance and of its children in the same space.
   * An effect operation has transactions of its own beside these.
   */
  transactions: number;
  /**
   * The documents of the instance (ES §4.1), without part documents and
   * without the documents of a child's own plan.
   */
  documents: {
    result: 1;
    argument: 1;
    /** One per durable operation and combination of element keys. */
    operationState: number;
    /**
     * One per state cell and combination of element keys, written when
     * the cell is first assigned (ES §4.5): none where nothing assigned
     * one yet.
     */
    stateCells: Range;
    /**
     * The result and the argument document of each child (ES §4.6): none
     * where no child is instantiated, as for a child in a branch that is
     * not selected. The documents of the child's own plan are not counted.
     */
    children: Range;
    /**
     * The rows of the kept collections. Each is a split point (ES §4.10)
     * and is a part document where its subtree is at least
     * `PART_SPLIT_BYTES`. The nodes of a rendered tree are split points
     * too and are not counted here.
     */
    rows: Range;
    total: Range;
  };
  /**
   * The label entries the instance's kept outputs contribute (ES §4.3).
   * `min` is the one entry of the pattern's atom at the root of the result
   * document, which is all there is where every template instantiates to
   * a label with nothing in it. `shared` and `max` add a `value` and a
   * `shape` entry for each kept output whose template is not `const` and
   * an `enumerate` entry for each kept collection: `shared` with the two
   * entries of a kept path below `*` once, as where every element
   * instantiates to the same label, and `max` with them once per element
   * key. Declared entries, which come from the result schema, are not
   * counted.
   */
  labelEntries: Range & { shared: number };
};

/** The derivation for an instance that settled. */
export const settledCost = (plan: CostPlan, size: Sizes): SettledCost => {
  const instances = coneInstances(plan, size);
  const collections = coneCollections(plan);
  const cells = sum(
    plan.stateCells.map((cell) => instancesWithin(cell.within, size)),
  );
  const operationState = sum(
    plan.operations.map((operation) => instancesWithin(operation.within, size)),
  );
  const children = 2 * sum(
    plan.children.map((child) => instancesWithin(child.within, size)),
  );
  // A kept collection is a path with `*` in it. Its rows are counted once
  // per collection that some kept output with such a path is computed in.
  const keptCollections = new Set<number>();
  const entries = { min: 1, shared: 1, max: 1 };
  for (const output of plan.outputs) {
    if (!output.kept) continue;
    const collection = output.cone === undefined
      ? undefined
      : collections[output.cone];
    const below = output.path.includes("*");
    if (below && collection !== undefined) keptCollections.add(collection);
    if (output.template === undefined || output.template.op === "const") {
      continue;
    }
    entries.shared += 2;
    entries.max += 2 *
      (below && output.cone !== undefined ? instances[output.cone] : 1);
  }
  entries.shared += keptCollections.size;
  entries.max += keptCollections.size;
  const rows = sum(
    [...keptCollections].map((collection) =>
      size(collection) *
      instancesWithin(plan.collections[collection]?.within, size)
    ),
  );
  const fixed = 2 + operationState;
  return {
    records: {
      cones: plan.cones.length,
      bodies: plan.bodies.length,
      bindings: plan.bindings.length,
      effects:
        plan.operations.filter((operation) => operation.kind === "effect")
          .length,
      operations: plan.operations.length,
      stateCells: plan.stateCells.length,
      children: plan.children.length,
      collections: plan.collections.length,
      keptOutputs: plan.outputs.filter((output) => output.kept).length,
    },
    coneInstances: sum(instances),
    streams: sum(
      plan.bindings.map((binding) => instancesWithin(binding.within, size)),
    ),
    transactions: 2,
    documents: {
      result: 1,
      argument: 1,
      operationState,
      stateCells: { min: 0, max: cells },
      children: { min: 0, max: children },
      rows: { min: 0, max: rows },
      total: { min: fixed, max: fixed + children + cells + rows },
    },
    labelEntries: entries,
  };
};

/** What is derived for one event sent to the stream of a binding. */
export type EventCost = {
  /**
   * The event's transaction, and at most one derivation transaction
   * behind the batch, which runs where a demanded cone instance became
   * stale (ES §1.1). An event the handler sends has a transaction of its
   * own, which is not counted.
   */
  transactions: Range;
  /**
   * The cone instances a write of the handler can make stale: the cones
   * with a slot of the same root as the place a written path of the
   * handler's state is bound to, and the cones that have a path of
   * `output` edges from one. Every element key of such a cone is counted,
   * so this is an upper bound (ES §1.5, §2.6).
   */
  coneEvaluations: Range;
  /** The documents the event adds: its stream document once (ES §4.7). */
  streamDocuments: 1;
};

const sameRoot = (a: SlotRoot, b: SlotRoot) =>
  a.kind === b.kind && a.cell === b.cell && a.collection === b.collection &&
  a.operation === b.operation;

const overlaps = (a: string[], b: string[]) =>
  a.every((segment, index) => index >= b.length || b[index] === segment);

/** The derivation for one event of the handler of `binding`. */
export const eventCost = (
  plan: CostPlan,
  binding: number,
  size: Sizes,
): EventCost => {
  const record = plan.bindings[binding];
  const body = plan.bodies[record?.handler?.body ?? -1];
  // The places the handler writes: the slot a written path of its state
  // is bound to.
  const written: { root: SlotRoot; path: string[] }[] = [];
  for (const write of body?.writes ?? []) {
    const slot = plan.slots[write.target.slot ?? -1];
    if (slot === undefined) continue;
    if (slot.root.kind !== "binding") {
      written.push(slot);
      continue;
    }
    for (const state of record?.state ?? []) {
      const place = plan.slots[state.place?.slot ?? -1];
      if (place === undefined || !overlaps(state.path, slot.path)) continue;
      written.push({
        root: place.root,
        path: [...place.path, ...slot.path.slice(state.path.length)],
      });
    }
  }
  const stale = plan.cones.map((cone) =>
    cone.slots.some((index) => {
      const slot = plan.slots[index];
      return slot !== undefined && written.some((place) =>
        sameRoot(place.root, slot.root) && overlaps(place.path, slot.path)
      );
    })
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of plan.edges) {
      if (edge.via.kind === "output" && stale[edge.from] && !stale[edge.to]) {
        stale[edge.to] = true;
        changed = true;
      }
    }
  }
  const instances = coneInstances(plan, size);
  const evaluations = sum(instances.filter((_, cone) => stale[cone]));
  return {
    transactions: { min: 1, max: evaluations > 0 ? 2 : 1 },
    coneEvaluations: { min: 0, max: evaluations },
    streamDocuments: 1,
  };
};

/**
 * The bytes of the label envelope of `entries` entries stored by
 * reference: about 25 bytes of path, origin and class and a reference of
 * 63 bytes for each (ES §4.9). The label documents the references name
 * are shared and are not counted.
 */
export const ENTRY_BYTES = 25 + 63;
