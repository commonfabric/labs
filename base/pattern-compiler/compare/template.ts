/**
 * Evaluates a label template of a plan against labels read from a run, by
 * the table of `docs/specs/compiled-pattern-language/plan-and-label-templates.md`
 * §3.2, and compares the result with a label the runtime stored.
 *
 * This module holds no runtime state. `TemplateInputs` supplies what a
 * template names: the label of a slot, the branch a selector took, and the
 * elements a collection iterates.
 */

/** A confidentiality clause or an integrity atom, as the runtime stores it. */
export type Atom = unknown;

/**
 * A label. `integrity` is `"neutral"` for a value no observation
 * contributed to, the unit of the meet (§3.2, "`const` is neutral").
 */
export type Label = {
  confidentiality: Atom[];
  integrity: Atom[] | "neutral";
};

/** A node of a template, as the `plan` command of the crate emits it. */
export type Template =
  | { op: "const" }
  | { op: "slot"; slot: number }
  | { op: "derive"; inputs: Template[]; by: unknown }
  | {
    op: "select";
    selector: number;
    condition: Template;
    branches: Template[];
  }
  | { op: "pick"; pick: number; choice: Template; body: Template }
  | { op: "fold"; collection: number; body: Template }
  | { op: "dynamic"; reads: unknown };

/** One element of a collection: the collection, and the element's key. */
export type ElementBinding = { collection: number; key: string };

/** What a template is evaluated against. */
export type TemplateInputs = {
  /**
   * The label of slot `slot`. `elements` binds the element of each
   * collection the evaluation is inside, innermost last.
   */
  slot(slot: number, elements: readonly ElementBinding[]): Label;
  /** The branch selector `selector` took, or `undefined` where unobserved. */
  selected(
    selector: number,
    elements: readonly ElementBinding[],
  ): number | undefined;
  /** The keys of the elements collection `collection` iterates. */
  elementKeys(
    collection: number,
    elements: readonly ElementBinding[],
  ): string[];
  /** The label of what collection `collection` iterates (§3.2). */
  membership(collection: number, elements: readonly ElementBinding[]): Label;
  /** The key `pick` chose in its collection, where the pick names one. */
  picked?(
    pick: number,
    elements: readonly ElementBinding[],
  ): ElementBinding | undefined;
  /** The join of the labels the journaled reads of a `dynamic` consumed. */
  dynamic?(reads: unknown, elements: readonly ElementBinding[]): Label;
  /** Whether a `derive` keeps `atom` of an input (§8.9.3: hereditary). */
  hereditary(atom: Atom): boolean;
};

/** Options of an evaluation. */
export type EvaluationOptions = {
  /**
   * Whether a `derive` whose inputs carry no label mints its
   * `TransformedBy` atom. §3.2 mints without a condition, and the runtime
   * mints beside a label that exists (§3.1). Default `true`.
   */
  mintWithoutLabel?: boolean;
};

/** The result of evaluating a template. */
export type Evaluated = {
  label: Label;
  /**
   * True where a selector or a pick was not observed. The label is then a
   * bound: the confidentiality of every branch joined, and the integrity
   * every branch has.
   */
  bound: boolean;
  /** The nodes the evaluator has no input for, by `op`. */
  unsupported: string[];
};

export const TRANSFORMED_BY = "https://commonfabric.org/cfc/atom/TransformedBy";

/** A canonical string for an atom: JSON with sorted keys. */
export const atomKey = (atom: Atom): string =>
  JSON.stringify(
    atom,
    (_key, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
        )
        : value,
  );

const union = (lists: readonly (readonly Atom[])[]): Atom[] => {
  const seen = new Map<string, Atom>();
  for (const list of lists) {
    for (const atom of list) seen.set(atomKey(atom), atom);
  }
  return [...seen.values()];
};

/** The meet of integrity lists: the atoms every list has. */
const meet = (
  lists: readonly (readonly Atom[] | "neutral")[],
): Atom[] | "neutral" => {
  let result: Atom[] | "neutral" = "neutral";
  for (const list of lists) {
    if (list === "neutral") continue;
    if (result === "neutral") {
      result = union([list]);
      continue;
    }
    const keys = new Set(list.map(atomKey));
    result = result.filter((atom) => keys.has(atomKey(atom)));
  }
  return result;
};

/** The atom a `derive` mints. It names the plan's `by`, not a code hash. */
const minted = (by: unknown): Atom => ({
  type: TRANSFORMED_BY,
  identity: { kind: "template", by },
});

const NEUTRAL: Label = { confidentiality: [], integrity: "neutral" };

/** Evaluates `template` by §3.2. */
export const evaluateTemplate = (
  template: Template,
  inputs: TemplateInputs,
  elements: readonly ElementBinding[] = [],
  options: EvaluationOptions = {},
): Evaluated => {
  let bound = false;
  const unsupported: string[] = [];
  const mintWithoutLabel = options.mintWithoutLabel ?? true;

  const derive = (parts: Label[], by: unknown): Label => {
    const confidentiality = union(parts.map((part) => part.confidentiality));
    const kept = meet(
      parts.map((part) =>
        part.integrity === "neutral"
          ? "neutral"
          : part.integrity.filter((atom) => inputs.hereditary(atom))
      ),
    );
    const integrity = kept === "neutral" ? [] : kept;
    return mintWithoutLabel || confidentiality.length > 0 ||
        integrity.length > 0
      ? { confidentiality, integrity: [...integrity, minted(by)] }
      : { confidentiality, integrity };
  };

  const walk = (node: Template, at: readonly ElementBinding[]): Label => {
    switch (node.op) {
      case "const":
        return NEUTRAL;
      case "slot":
        return inputs.slot(node.slot, at);
      case "derive":
        return derive(node.inputs.map((input) => walk(input, at)), node.by);
      case "select": {
        const condition = walk(node.condition, at);
        const taken = inputs.selected(node.selector, at);
        const branches = taken === undefined
          ? node.branches.map((branch) => walk(branch, at))
          : [walk(node.branches[taken], at)];
        if (taken === undefined) bound = true;
        return {
          confidentiality: union([
            condition.confidentiality,
            ...branches.map((branch) => branch.confidentiality),
          ]),
          integrity: meet(branches.map((branch) => branch.integrity)),
        };
      }
      case "pick": {
        const choice = walk(node.choice, at);
        const chosen = inputs.picked?.(node.pick, at);
        if (chosen === undefined) bound = true;
        const body = walk(
          node.body,
          chosen === undefined ? at : [...at, chosen],
        );
        return {
          confidentiality: union([
            choice.confidentiality,
            body.confidentiality,
          ]),
          integrity: body.integrity,
        };
      }
      case "fold": {
        const membership = inputs.membership(node.collection, at);
        const bodies = inputs.elementKeys(node.collection, at).map((key) =>
          walk(node.body, [...at, { collection: node.collection, key }])
        );
        const kept = meet(bodies.map((body) => body.integrity));
        return {
          confidentiality: union([
            membership.confidentiality,
            ...bodies.map((body) => body.confidentiality),
          ]),
          integrity: [...(kept === "neutral" ? [] : kept), minted("fold")],
        };
      }
      case "dynamic": {
        const label = inputs.dynamic?.(node.reads, at);
        if (label === undefined) {
          unsupported.push("dynamic");
          return NEUTRAL;
        }
        return label;
      }
    }
  };

  const label = walk(template, elements);
  return { label, bound, unsupported };
};

/** How a template label stands to the runtime's on one axis. */
export type Relation = "equal" | "tighter" | "looser" | "incomparable";

export type Comparison = {
  confidentiality: Relation;
  integrity: Relation;
  overall: Relation;
  /** Witness-bearing `TransformedBy` atoms of the runtime's label. */
  runtimeInputWitnesses: number;
};

const isTransformedBy = (atom: Atom): boolean =>
  typeof atom === "object" && atom !== null &&
  (atom as { type?: unknown }).type === TRANSFORMED_BY;

const hasInputWitness = (atom: Atom): boolean =>
  isTransformedBy(atom) &&
  (atom as { inputWitness?: unknown }).inputWitness !== undefined;

const relation = (onlyTemplate: number, onlyRuntime: number, more: Relation) =>
  onlyTemplate === 0 && onlyRuntime === 0
    ? "equal"
    : onlyTemplate > 0 && onlyRuntime > 0
    ? "incomparable"
    : (onlyTemplate > 0) === (more === "tighter")
    ? "tighter"
    : "looser";

/**
 * Compares a template's label with the runtime's by §3.1: tighter is fewer
 * confidentiality clauses, or more integrity atoms. Clauses and atoms are
 * compared structurally, with two exceptions for `TransformedBy`. The
 * identity of an atom without a witness is not compared, since the plan
 * names a cone and the runtime a compiled function: such atoms are counted.
 * An atom with an input witness is not part of §3.2, so it is left out of
 * the relation and counted in `runtimeInputWitnesses`.
 */
export const compareLabels = (template: Label, runtime: Label): Comparison => {
  const keys = (atoms: readonly Atom[]) => new Set(atoms.map(atomKey));
  const templateC = keys(template.confidentiality);
  const runtimeC = keys(runtime.confidentiality);
  const confidentiality = relation(
    [...templateC].filter((key) => !runtimeC.has(key)).length,
    [...runtimeC].filter((key) => !templateC.has(key)).length,
    "looser",
  );

  const list = (integrity: Atom[] | "neutral") =>
    integrity === "neutral" ? [] : integrity;
  const templateI = list(template.integrity);
  const runtimeI = list(runtime.integrity);
  const plain = (atoms: Atom[]) => atoms.filter((a) => !isTransformedBy(a));
  const mints = (atoms: Atom[]) =>
    atoms.filter((a) => isTransformedBy(a) && !hasInputWitness(a)).length;
  const templatePlain = keys(plain(templateI));
  const runtimePlain = keys(plain(runtimeI));
  const mintDifference = mints(templateI) - mints(runtimeI);
  const integrity = relation(
    [...templatePlain].filter((key) => !runtimePlain.has(key)).length +
      Math.max(mintDifference, 0),
    [...runtimePlain].filter((key) => !templatePlain.has(key)).length +
      Math.max(-mintDifference, 0),
    "tighter",
  );

  // Any axis on which the template is not equal or tighter makes the whole
  // label looser: the criterion of §3.1 is "never looser".
  const axes = [confidentiality, integrity];
  const overall: Relation =
    axes.includes("looser") || axes.includes("incomparable")
      ? "looser"
      : axes.includes("tighter")
      ? "tighter"
      : "equal";
  return {
    confidentiality,
    integrity,
    overall,
    runtimeInputWitnesses: runtimeI.filter(hasInputWitness).length,
  };
};
