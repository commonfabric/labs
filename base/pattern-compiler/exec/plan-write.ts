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
 */

/** A position of a document: the document and the path in it. */
export type Address = { doc: string; path: readonly string[] };

/**
 * What a slot of a template was bound to when the code that reads it last
 * ran. `chain` holds each position the read went through, the links it
 * crossed first and the slot's own position last, and `observes` the
 * slot's observation class. `output` stands for the value of an entry of
 * `Plan.outputs` for the element keys given: the slot of an element of the
 * result of another per-element construct, which has no stored address,
 * reads that output of the upstream element. A path may hold `*` at the
 * position of an element, in the bindings of the `uniform` form.
 */
export type SlotBinding =
  | { chain: Address[]; observes: string }
  | { staged: Address }
  | { output: number; keys: [number, string][] };

/** The bindings of the slots a template reaches, by the slot's index. */
export type SlotBindings = Record<number, SlotBinding>;

/** Which record of the plan a write belongs to (PL §4.1). */
export type PlanRecord =
  /** An entry of `Plan.outputs`. */
  | { output: number }
  /** An entry of `Body.writes`, of a handler or of a body of a cone. */
  | { body: number; write: number }
  /** An entry of `Cone.writes`. */
  | { cone: number; write: number }
  /** The first value of a state cell, by `StateCell.first`. */
  | { stateFirst: number };

/** One group of the elements of a `fold` (provisional decision P31). */
export type ElementGroup = {
  /** The bindings of one element of the group. */
  bindings: SlotBindings;
  /** The branch each selector of the body took for that element. */
  selections?: Record<number, number>;
  /** The key each pick of the body chose for that element. */
  picks?: Record<number, string | null>;
  /** The inputs of the outputs the bindings name, for that element. */
  outputs?: Record<number, NamedOutputInputs>;
  /** How many elements have these inputs. */
  count: number;
};

/** The elements of a `fold`, in one of the two forms of decision P31. */
export type FoldElements =
  | { uniform: SlotBindings }
  | { groups: ElementGroup[] };

/**
 * What the template of a cone instance is instantiated with: the instance
 * of the pattern, the element keys, outermost first, and what each node of
 * the template that needs an input reaches.
 */
export type NamedOutputInputs = {
  /** The identifier of the instance, which is that of its result document. */
  instance: string;
  /** The element key of each enclosing collection, outermost first. */
  keys: [number, string][];
  /** The binding of each slot the template reaches outside a `fold`. */
  slots: SlotBindings;
  /** The branch taken at each selector; an absent one is not reported. */
  selections?: Record<number, number>;
  /** The key chosen at each pick; an absent one is not reported. */
  picks?: Record<number, string | null>;
  /** The elements of each `fold`, by its collection. */
  elements?: Record<number, FoldElements>;
  /** The inputs of the cone instance of each output an `output` node names. */
  outputs?: Record<number, NamedOutputInputs>;
  /** The positions read through each entry of `Plan.dynamicReads`. */
  dynamic?: Record<number, Address[]>;
};

/** The record of one written path (PL §4.1, `PlanWrite` without labels). */
export type PlanWrite = NamedOutputInputs & {
  /** The written document and path. */
  target: Address;
  /** The record of the plan whose template gives the label of the write. */
  record: PlanRecord;
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
  /** The picks of `pick` nodes. */
  picks: Set<number>;
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
    picks: new Set(),
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
      into.picks.add(template.pick);
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
 * with `shared` expanded. It has no `output` node either: the label of a
 * named output can differ by element in a way no `*` path states.
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
    case "shared":
      return isUniformBody(templates[template.template], templates);
    default:
      return false;
  }
};
