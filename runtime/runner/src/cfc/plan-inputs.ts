/**
 * The table of inputs that the write records of a compiled pattern name by
 * index (`PlanInputsTable` of `types.ts`), and the form in which a place's
 * inputs hold what they name by value (`NestedPlanInputs`), which a writer
 * that has no table of its own builds one from (`PlanInputsInterner`) and
 * which a reader of recorded writes gets back (`nestedPlanInputs`).
 *
 * Each distinct set of inputs and each distinct slot binding stands in the
 * table once, whatever the number of records and of paths through named
 * outputs that reach it, so the size of what a transaction records follows
 * the number of distinct inputs and of records, and equal inputs have one
 * index.
 */

import type {
  CfcAddress,
  PlanElements,
  PlanInputs,
  PlanInputsTable,
  PlanWrite,
  SlotBinding,
  SlotBindings,
} from "./types.ts";

/** The bindings of a template's slots, each held by value. */
export type NestedSlotBindings = { readonly [slot: number]: SlotBinding };

/** The inputs of one place, with everything they name held by value. */
export type NestedPlanInputs = {
  readonly slots: NestedSlotBindings;
  readonly selections?: { readonly [selector: number]: number };
  readonly picks?: {
    readonly [pick: number]: { readonly slots: NestedSlotBindings } | null;
  };
  readonly elements?: { readonly [collection: number]: NestedPlanElements };
  readonly dynamic?: { readonly [reads: number]: readonly CfcAddress[] };
  readonly dynamicGroups?: PlanInputs["dynamicGroups"];
  readonly outputs?: { readonly [output: number]: NestedPlanInputs };
};

/** The elements of a collection, each set of inputs held by value. */
export type NestedPlanElements =
  | { readonly uniform: NestedPlanInputs }
  | {
    readonly groups: readonly (NestedPlanInputs & { readonly count: number })[];
  };

/** A write record with its inputs held by value. */
export type NestedPlanWrite = Omit<PlanWrite, "inputs"> & NestedPlanInputs;

/** The entries of `record` in the order of their indices. */
const ordered = <T>(
  record: { readonly [index: number]: T },
): [string, T][] =>
  Object.entries(record).sort(([a], [b]) => Number(a) - Number(b));

/**
 * Builds a table of inputs: gives each distinct slot binding and each
 * distinct set of inputs one index, by its content, and hands out the
 * entries added since it last did (`take`), which a writer records as one
 * `plan-inputs` write-policy input.
 */
export class PlanInputsInterner {
  readonly #inputs: PlanInputs[] = [];
  readonly #bindings: SlotBinding[] = [];
  readonly #inputIndex = new Map<string, number>();
  readonly #bindingIndex = new Map<string, number>();
  #takenInputs = 0;
  #takenBindings = 0;

  /** The table as built so far. */
  get table(): PlanInputsTable {
    return { inputs: this.#inputs, bindings: this.#bindings };
  }

  /** The index of a slot binding. */
  binding(binding: SlotBinding): number {
    const text = JSON.stringify(binding);
    let index = this.#bindingIndex.get(text);
    if (index === undefined) {
      index = this.#bindings.length;
      this.#bindings.push(binding);
      this.#bindingIndex.set(text, index);
    }
    return index;
  }

  /** The index of a set of inputs that names what it holds by index. */
  inputs(inputs: PlanInputs): number {
    const text = JSON.stringify(inputs);
    let index = this.#inputIndex.get(text);
    if (index === undefined) {
      index = this.#inputs.length;
      this.#inputs.push(inputs);
      this.#inputIndex.set(text, index);
    }
    return index;
  }

  /** The index of a set of inputs given by value. */
  nested(nested: NestedPlanInputs): number {
    const slots = (bindings: NestedSlotBindings): SlotBindings =>
      Object.fromEntries(
        ordered(bindings).map(([slot, binding]) => [
          slot,
          this.binding(binding),
        ]),
      );
    const elements = (given: NestedPlanElements): PlanElements =>
      "uniform" in given ? { uniform: this.nested(given.uniform) } : {
        groups: given.groups.map(({ count, ...inputs }) => ({
          inputs: this.nested(inputs),
          count,
        })),
      };
    return this.inputs({
      slots: slots(nested.slots),
      ...(nested.selections === undefined
        ? {}
        : { selections: Object.fromEntries(ordered(nested.selections)) }),
      ...(nested.picks === undefined ? {} : {
        picks: Object.fromEntries(
          ordered(nested.picks).map(([pick, chosen]) => [
            pick,
            chosen === null ? null : { slots: slots(chosen.slots) },
          ]),
        ),
      }),
      ...(nested.elements === undefined ? {} : {
        elements: Object.fromEntries(
          ordered(nested.elements).map(([collection, given]) => [
            collection,
            elements(given),
          ]),
        ),
      }),
      ...(nested.dynamic === undefined
        ? {}
        : { dynamic: Object.fromEntries(ordered(nested.dynamic)) }),
      ...(nested.dynamicGroups === undefined ? {} : {
        dynamicGroups: Object.fromEntries(ordered(nested.dynamicGroups)),
      }),
      ...(nested.outputs === undefined ? {} : {
        outputs: Object.fromEntries(
          ordered(nested.outputs).map(([output, inputs]) => [
            output,
            this.nested(inputs),
          ]),
        ),
      }),
    });
  }

  /**
   * The entries added since the last call, with the index of the first of
   * each kind, or `undefined` where none was added.
   */
  take():
    | (PlanInputsTable & { firstInput: number; firstBinding: number })
    | undefined {
    if (
      this.#takenInputs === this.#inputs.length &&
      this.#takenBindings === this.#bindings.length
    ) return undefined;
    const segment = {
      firstInput: this.#takenInputs,
      inputs: this.#inputs.slice(this.#takenInputs),
      firstBinding: this.#takenBindings,
      bindings: this.#bindings.slice(this.#takenBindings),
    };
    this.#takenInputs = this.#inputs.length;
    this.#takenBindings = this.#bindings.length;
    return segment;
  }
}

/**
 * The inputs at `index` of `table` with everything they name held by
 * value. An entry that several entries name is one object in each of them.
 * Throws for an index the table has no entry at.
 */
export const nestedPlanInputs = (
  table: PlanInputsTable,
  index: number,
  /** The entries expanded so far, by index. */
  expanded: Map<number, NestedPlanInputs> = new Map(),
): NestedPlanInputs => {
  const known = expanded.get(index);
  if (known !== undefined) return known;
  const inputs = table.inputs[index];
  if (inputs === undefined) {
    throw new Error(`The table of inputs has no entry ${index}.`);
  }
  const slots = (bindings: SlotBindings): NestedSlotBindings =>
    Object.fromEntries(
      Object.entries(bindings).map(([slot, at]) => {
        const binding = table.bindings[at];
        if (binding === undefined) {
          throw new Error(`The table of inputs has no binding ${at}.`);
        }
        return [slot, binding];
      }),
    );
  const within = (at: number) => nestedPlanInputs(table, at, expanded);
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
    ...(inputs.elements === undefined ? {} : {
      elements: Object.fromEntries(
        Object.entries(inputs.elements).map((
          [collection, elements],
        ): [string, NestedPlanElements] => [
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
    ...(inputs.dynamic === undefined ? {} : { dynamic: inputs.dynamic }),
    ...(inputs.dynamicGroups === undefined
      ? {}
      : { dynamicGroups: inputs.dynamicGroups }),
    ...(inputs.outputs === undefined ? {} : {
      outputs: Object.fromEntries(
        Object.entries(inputs.outputs).map(([output, at]) => [
          output,
          within(at),
        ]),
      ),
    }),
  };
  expanded.set(index, nested);
  return nested;
};

/**
 * `write` with the inputs it names in `table` held by value
 * (`nestedPlanInputs`).
 */
export const nestedPlanWrite = (
  write: PlanWrite,
  table: PlanInputsTable,
  expanded?: Map<number, NestedPlanInputs>,
): NestedPlanWrite => {
  const { inputs, ...rest } = write;
  return { ...rest, ...nestedPlanInputs(table, inputs, expanded) };
};
