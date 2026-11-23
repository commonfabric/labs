/**
 * The record the executor gives with each change it reports through
 * `TransactionHooks.change`: which record of the plan the write belongs
 * to, and what the label template of that record is instantiated with
 * (`docs/specs/compiled-pattern-language/plan-and-label-templates.md`,
 * PL, §4.1 and §4.2). The runtime owns the type it reads this as; the
 * executor mirrors its structure here and imports nothing from
 * `runtime/`.
 *
 * The elements of a `fold` are reported in the two forms of provisional
 * decision P31: one set of bindings with the path segment `*` at the
 * element position, where every element is a plain value in place and
 * the body template has no node whose outcome differs by element, and
 * otherwise one entry per distinct group of element inputs with the
 * number of elements in it.
 *
 * What the inputs of a place name of other inputs and of slot bindings
 * they name by index into the table of inputs of the transaction
 * (`InputsTable`), which holds each distinct set of inputs and each
 * distinct binding once: the size of what a transaction records follows
 * the number of distinct inputs and of records, and not the number of paths
 * through named outputs that reach an input.
 */

/** A position of a document: the document and the path in it. */
export type Address = { doc: string; path: readonly string[] };

/**
 * What a slot of a template was bound to when the code that reads it last
 * ran. `chain` holds each position the read went through, the links it
 * crossed first and the slot's own position last, and `observes` the
 * slot's observation class. `output` stands for the value of an entry of
 * `Plan.outputs`, whose inputs `outputs` of the same place or of an
 * enclosing one reports: the slot of an element of the result of another
 * per-element construct, which has no stored address, reads that output of
 * the upstream element. A path may hold `*` at the position of an element,
 * in the bindings of the `uniform` form.
 */
export type SlotBinding =
  | {
    chain: Address[];
    observes: string;
    /**
     * The further chains of a read of a value that holds links: for each
     * position the read reached through a link stored in the value, the
     * link positions crossed on the way to it first and the position last.
     */
    below?: Address[][];
    /**
     * The containers whose members the read covered, each with the number
     * of its members and of the groups of members whose positions hold
     * equal labels (provisional decision P31, as for the elements of a
     * `fold`). `chain` and `below` hold the positions of one member of each
     * group, and of no other member: the label of the slot is the join
     * over the groups.
     */
    members?: { container: Address; count: number; groups: number }[];
  }
  | { staged: Address }
  | {
    output: number;
    /**
     * The positions a read of the value went through, where the output
     * holds a reference and the slot reads what the reference names: the
     * label of the slot is that of the output joined with the label of
     * this read.
     */
    through?: Extract<SlotBinding, { chain: Address[] }>;
  }
  /** A constant of the plan, which contributes no label. */
  | { constant: true };

/**
 * The bindings of the slots a template reaches, by the slot's index: each
 * the index of a binding in the table of inputs (`InputsTable.bindings`).
 */
export type SlotBindings = Record<number, number>;

/** Which record of the plan a write belongs to (PL §4.1). */
export type PlanRecord =
  /** An entry of `Plan.outputs`. */
  | { output: number }
  /** An entry of `Body.writes`, of a handler or of a body of a cone. */
  | { body: number; write: number }
  /** An entry of `Body.envelopes`, which has no template. */
  | { body: number; envelope: number }
  /** An entry of `Cone.writes`. */
  | { cone: number; write: number }
  /** The first value of a state cell, by `StateCell.first`. */
  | { stateFirst: number }
  /** The outcome of an entry of `Plan.operations` of kind `wish`. */
  | { operation: number };

/** What the template of one place is instantiated with. */
export type PlanInputs = {
  /** The binding of each slot the template reaches outside a `fold`. */
  slots: SlotBindings;
  /** The branch taken at each selector; an absent one is not reported. */
  selections?: Record<number, number>;
  /**
   * The child chosen at each pick, with the bindings of the slots of the
   * pick's body, or `null` where none was chosen; an absent one is not
   * reported.
   */
  picks?: Record<number, { slots: SlotBindings } | null>;
  /** The elements of each `fold`, by its collection. */
  elements?: Record<number, FoldElements>;
  /** The positions read through each entry of `Plan.dynamicReads`. */
  dynamic?: Record<number, Address[]>;
  /**
   * The inputs of the cone instance of each output named here, by index
   * into the table of inputs (`InputsTable.inputs`).
   */
  outputs?: Record<number, number>;
};

/** One group of the elements of a `fold` (provisional decision P31). */
export type ElementGroup = {
  /** The inputs of the group's elements, by index into the table. */
  inputs: number;
  /** How many elements have these inputs. */
  count: number;
};

/**
 * The elements of a `fold`, in one of the two forms of decision P31, each
 * set of inputs named by its index in the table.
 */
export type FoldElements =
  | { uniform: number }
  | { groups: ElementGroup[] };

/**
 * What the template of a cone instance is instantiated with: the instance
 * of the pattern, the element keys, outermost first, and the index, in the
 * table of inputs, of what each node of the template that needs an input
 * reaches.
 */
export type NamedOutputInputs = {
  /** The inputs, by index into the table (`InputsTable.inputs`). */
  inputs: number;
  /** The identifier of the instance, which is that of its result document. */
  instance: string;
  /** The element key of each enclosing collection, outermost first. */
  keys: [number, string][];
};

/**
 * The table of inputs of one transaction: each distinct slot binding and
 * each distinct set of inputs, at the index the write records and the other
 * entries name it by. Two entries with equal content have one index.
 */
export class InputsTable {
  /** The sets of inputs, by index. */
  readonly inputs: PlanInputs[] = [];
  /** The slot bindings, by index. */
  readonly bindings: SlotBinding[] = [];
  readonly #inputIndex = new Map<string, number>();
  readonly #bindingIndex = new Map<string, number>();
  readonly #bindingTexts: string[] = [];

  /** The index of a slot binding. */
  binding(binding: SlotBinding): number {
    const text = JSON.stringify(binding);
    let index = this.#bindingIndex.get(text);
    if (index === undefined) {
      index = this.bindings.length;
      this.bindings.push(binding);
      this.#bindingTexts.push(text);
      this.#bindingIndex.set(text, index);
    }
    return index;
  }

  /**
   * The text the binding at `index` was told from every other binding of
   * the table by: two bindings of two tables hold the same content exactly
   * where their texts are equal.
   */
  bindingText(index: number): string {
    return this.#bindingTexts[index];
  }

  /** The index of a set of inputs. */
  place(inputs: PlanInputs): number {
    const text = JSON.stringify(inputs);
    let index = this.#inputIndex.get(text);
    if (index === undefined) {
      index = this.inputs.length;
      this.inputs.push(inputs);
      this.#inputIndex.set(text, index);
    }
    return index;
  }
}

/** The bindings of slots, each held by value. */
export type NestedSlotBindings = Record<number, SlotBinding>;

/** The inputs of one place, with everything they name held by value. */
export type NestedPlanInputs = {
  slots: NestedSlotBindings;
  selections?: Record<number, number>;
  picks?: Record<number, { slots: NestedSlotBindings } | null>;
  elements?: Record<number, NestedFoldElements>;
  dynamic?: Record<number, Address[]>;
  outputs?: Record<number, NestedPlanInputs>;
};

/** The elements of a `fold`, each set of inputs held by value. */
export type NestedFoldElements =
  | { uniform: NestedPlanInputs }
  | { groups: (NestedPlanInputs & { count: number })[] };

/**
 * The inputs at `index` of `table` with everything they name held by
 * value. An entry that several entries name is one object in each of them.
 */
export const nestedInputs = (
  table: InputsTable,
  index: number,
  /** The entries expanded so far, by index. */
  expanded: Map<number, NestedPlanInputs> = new Map(),
): NestedPlanInputs => {
  const known = expanded.get(index);
  if (known !== undefined) return known;
  const inputs = table.inputs[index];
  const slots = (bindings: SlotBindings): NestedSlotBindings =>
    Object.fromEntries(
      Object.entries(bindings).map(([slot, at]) => [slot, table.bindings[at]]),
    );
  const within = (at: number) => nestedInputs(table, at, expanded);
  const nested: NestedPlanInputs = {
    slots: slots(inputs.slots),
    ...(inputs.selections === undefined
      ? {}
      : { selections: inputs.selections }),
    ...(inputs.picks === undefined ? {} : {
      picks: Object.fromEntries(
        Object.entries(inputs.picks).map(([pick, chosen]) => [
          pick,
          chosen === null ? null : { slots: slots(chosen.slots) },
        ]),
      ),
    }),
    ...(inputs.dynamic === undefined ? {} : { dynamic: inputs.dynamic }),
    ...(inputs.outputs === undefined ? {} : {
      outputs: Object.fromEntries(
        Object.entries(inputs.outputs).map(([output, at]) => [
          output,
          within(at),
        ]),
      ),
    }),
    ...(inputs.elements === undefined ? {} : {
      elements: Object.fromEntries(
        Object.entries(inputs.elements).map((
          [collection, elements],
        ): [string, NestedFoldElements] => [
          collection,
          "uniform" in elements ? { uniform: within(elements.uniform) } : {
            groups: elements.groups.map(({ inputs: at, count }) => ({
              ...within(at),
              count,
            })),
          },
        ]),
      ),
    }),
  };
  expanded.set(index, nested);
  return nested;
};

/**
 * A stored position with the class it is observed in: one whose stored label
 * the label of a write holds beside what its template gives.
 */
export type Observed = {
  address: Address;
  observes: string;
  /** The position alone is observed, and nothing below it. */
  alone?: true;
};

/** The record of one written path (PL §4.1, `PlanWrite` without labels). */
export type PlanWrite = NamedOutputInputs & {
  /** The written document and path. */
  target: Address;
  /** The record of the plan whose template gives the label of the write. */
  record: PlanRecord;
  /**
   * What a change of the members of a container in place compared to find
   * the members, as a removal and `addUnique` do: stored positions whose
   * labels the label of the write is joined with. The records of one change
   * hold one array (provisional decision P39).
   */
  decided?: Observed[];
  /**
   * Further stored positions whose labels the label of the write is joined
   * with: the position a member that the change moved to the target stood
   * at, and for the membership of the container, what the container stored
   * of it.
   */
  observed?: Observed[];
  /**
   * The record is of the membership of the container at the target, which
   * a change of its members in place decided anew: its label is stored for
   * a read of the container's members, their order and their number, and
   * for no read of a member.
   */
  enumeration?: true;
  /**
   * With `enumeration`: the change removed members of the container, so
   * what decided it decides what every position holds (ruling Z71).
   */
  removes?: true;
  /**
   * With `enumeration`: the members the change kept at another position,
   * as runs of positions next to each other: `count` members that stood
   * from `from` on stand from `to` on. The stored labels of a member move
   * with it, and no record is given for it (ruling Z72).
   */
  moves?: { from: number; to: number; count: number }[];
  /**
   * With `moves` or `removes`: the first position the change wrote. The
   * members before it stay, and a member that stood at it or behind it and
   * is in no run of `moves` was removed.
   */
  start?: number;
  /**
   * The record is given again because a label its inputs read changed and
   * no value did: the label of the target alone is formed again, and what
   * is stored of the labels below the target stays.
   */
  relabel?: true;
  /**
   * The target holds the result of a per-element construct, and the write
   * changed its members otherwise than by adding at its end, or wrote it
   * whole as part of a write above it.
   */
  membersChanged?: true;
  /**
   * The target holds the result of a per-element construct, and the write
   * added members at its end and changed no other: each member before them
   * stands where it stood.
   */
  membersAppended?: true;
  /**
   * The executor has no inputs that give the label of what the target
   * holds: the label is that of a write with no record, the join of what
   * the transaction read.
   */
  bound?: true;
};

/** What computed a `derive` (PL §1.1). */
export type By = { body: number } | { expression: true; pattern?: number };

/** A node of a label template, as the crate emits it (PL §1.1). */
export type Template =
  | { op: "const" }
  | { op: "slot"; slot: number }
  | { op: "derive"; inputs: Template[]; by: By }
  | {
    op: "select";
    selector: number;
    condition: Template;
    branches: Template[];
  }
  | { op: "pick"; pick: number; choice: Template; body: Template }
  | { op: "fold"; collection: number; body: Template; pattern?: number }
  | { op: "dynamic"; reads: number }
  | { op: "output"; output: number }
  | { op: "shared"; template: number };

/**
 * What one template reaches without entering a `fold` body or the
 * template of an output an `output` node names: those are reported apart,
 * as the elements of the fold and as the inputs of the named output.
 */
export type Reached = {
  /** The slots of `slot` nodes. */
  slots: Set<number>;
  /** The outputs of `output` nodes. */
  outputs: Set<number>;
  /** The body of each `fold`, by its collection. */
  folds: Map<number, Template>;
  /** The selectors of `select` nodes. */
  selectors: Set<number>;
  /** The body of each `pick` node, by its pick. */
  picks: Map<number, Template>;
  /** The entries of `Plan.dynamicReads` that `dynamic` nodes name. */
  dynamic: Set<number>;
};

/** Collects what a template reaches into `into`, with `shared` expanded. */
export const reachedBy = (
  template: Template | undefined,
  templates: readonly Template[],
  into: Reached = {
    slots: new Set(),
    outputs: new Set(),
    folds: new Map(),
    selectors: new Set(),
    picks: new Map(),
    dynamic: new Set(),
  },
): Reached => {
  if (template === undefined) return into;
  switch (template.op) {
    case "const":
      break;
    case "slot":
      into.slots.add(template.slot);
      break;
    case "derive":
      for (const input of template.inputs) {
        reachedBy(input, templates, into);
      }
      break;
    case "select":
      into.selectors.add(template.selector);
      reachedBy(template.condition, templates, into);
      for (const branch of template.branches) {
        reachedBy(branch, templates, into);
      }
      break;
    case "pick":
      into.picks.set(template.pick, template.body);
      reachedBy(template.choice, templates, into);
      reachedBy(template.body, templates, into);
      break;
    case "fold":
      into.folds.set(template.collection, template.body);
      break;
    case "dynamic":
      into.dynamic.add(template.reads);
      break;
    case "output":
      into.outputs.add(template.output);
      break;
    case "shared":
      reachedBy(templates[template.template], templates, into);
      break;
  }
  return into;
};

/**
 * Whether the body of a `fold` allows the `uniform` form (provisional
 * decision P31): it has no `select`, `pick`, `fold` or `dynamic` node,
 * and no `shared` node, whose label the runtime keeps per place. It has no
 * `output` node either: the label of a named output can differ by element
 * in a way no `*` path states.
 */
export const isUniformBody = (
  template: Template | undefined,
  templates: readonly Template[],
): boolean => {
  if (template === undefined) return true;
  switch (template.op) {
    case "const":
    case "slot":
      return true;
    case "derive":
      return template.inputs.every((input) => isUniformBody(input, templates));
    default:
      return false;
  }
};

/** A write record with its inputs held by value. */
export type NestedPlanWrite = Omit<PlanWrite, "inputs"> & NestedPlanInputs;

/** `write` with the inputs it names in `table` held by value. */
export const nestedWrite = (
  write: PlanWrite,
  table: InputsTable,
  expanded?: Map<number, NestedPlanInputs>,
): NestedPlanWrite => {
  const { inputs, ...rest } = write;
  return { ...rest, ...nestedInputs(table, inputs, expanded) };
};
