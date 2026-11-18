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

/**
 * What computed a `derive`: a sandboxed body, or expression code of the
 * pattern at `pattern` in `Plan.patterns`, and of entry 0 where the member
 * is absent (§3.2, "The atom of the pattern").
 */
export type By = { body: number } | { expression: true; pattern?: number };

/** A node of a template, as the `plan` command of the crate emits it. */
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
  | { op: "dynamic"; reads: unknown }
  /**
   * The template of entry `output` of `Plan.outputs`, by reference
   * (ruling Z58): it denotes what that template denotes in its place.
   */
  | { op: "output"; output: number }
  /**
   * The entry `template` of `Plan.templates`: a template that the plan
   * holds at more than one position and writes once (provisional
   * decision P6). It denotes that template in its place.
   */
  | { op: "shared"; template: number };

/**
 * One element of a collection: the collection, and the element's key. For
 * the child a `pick` chose in a container, `container` is the slot the
 * node's `from` names and `collection` is -1.
 */
export type ElementBinding = {
  collection: number;
  key: string;
  container?: number;
};

/** What a template is evaluated against. */
export type TemplateInputs = {
  /**
   * The label of slot `slot`. `elements` binds the element of each
   * collection the evaluation is inside, innermost last. `passed` is true
   * where the slot stands for the value the template passes on: the `slot`
   * node that is the template, the selected branch of a `select`, or the
   * chosen child of a `pick` that is one (§3.1, "What is compared"). It is
   * false for an input of a `derive`, a condition, a choice, and the body
   * of a `fold`.
   */
  slot(
    slot: number,
    elements: readonly ElementBinding[],
    passed?: boolean,
  ): Label;
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
  /**
   * For a slot of root `index`: the collection it names. Such a slot has
   * no stored address, and its label "is defined by rule and not by a
   * read" (§2.2, "The label of a slot of root `index`").
   */
  indexOf?(slot: number): number | undefined;
  /**
   * The label of the array collection `collection` iterates: its length
   * and which link each slot holds, and nothing of what the links point
   * to (ruling Y2). Where it is absent, `membership` stands in.
   */
  array?(collection: number, elements: readonly ElementBinding[]): Label;
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
   * Whether a `derive` or a `fold` whose label has no confidentiality
   * clause and no hereditary atom mints its `TransformedBy` atom. §3.2
   * assumes (section 8, question 66) that it does not, which is the
   * condition the runtime applies (§3.1). Default `false`; `true` is the
   * alternative §3.2 names.
   */
  mintWithoutLabel?: boolean;
  /**
   * `Plan.patterns`: the identity of each pattern whose source the plan
   * holds code of. A `derive` by expression code and a `fold` mint the atom
   * of the entry their `pattern` names.
   */
  patterns?: readonly string[];
  /**
   * `Plan.outputs`: the template that a node of `op` `output` names.
   */
  outputs?: readonly { template?: Template }[];
  /** `Plan.templates`: the template that a node of `op` `shared` names. */
  templates?: readonly Template[];
  /**
   * Whether the template is that of a kept output. Its label then has the
   * atom of entry 0 of `patterns` added, with no condition (§3.2, "Every
   * kept output").
   */
  kept?: boolean;
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

/**
 * The `TransformedBy` atom of a pattern: its identity is the entry of
 * `Plan.patterns`, which in the crate's plans is a placeholder for the hash
 * of `{ module, binding }` (§1.5).
 */
export const patternAtom = (
  patterns: readonly string[] | undefined,
  pattern = 0,
): Atom => ({
  type: TRANSFORMED_BY,
  identity: {
    kind: "pattern",
    pattern: patterns?.[pattern] ?? `unlisted:${pattern}`,
  },
});

/**
 * The atom a `derive` mints: of the pattern for expression code, and for a
 * body one that names the body's index in the plan, not a code hash.
 */
const minted = (by: By, patterns: readonly string[] | undefined): Atom =>
  "expression" in by ? patternAtom(patterns, by.pattern) : {
    type: TRANSFORMED_BY,
    identity: { kind: "body", body: by.body },
  };

/**
 * The label of a kept output: the label of its template with the atom of
 * the pattern the plan is compiled from, once, and also beside no label
 * (§3.2, "Every kept output").
 */
export const keptOutputLabel = (
  label: Label,
  patterns: readonly string[] | undefined,
): Label => {
  const atom = patternAtom(patterns, 0);
  const integrity = label.integrity === "neutral" ? [] : label.integrity;
  return {
    confidentiality: label.confidentiality,
    integrity: integrity.some((other) => atomKey(other) === atomKey(atom))
      ? integrity
      : [...integrity, atom],
  };
};

const NEUTRAL: Label = { confidentiality: [], integrity: "neutral" };

/**
 * The template that `template` denotes at its root: a reference to the
 * template of an output is followed to that template (ruling Z58).
 */
export const namedTemplate = (
  template: Template | undefined,
  plan: {
    outputs: readonly { template?: Template }[];
    templates?: readonly Template[];
  },
): Template | undefined => {
  let found = template;
  for (
    let hops = 0;
    hops <= plan.outputs.length + (plan.templates?.length ?? 0);
    hops++
  ) {
    if (found?.op === "output") found = plan.outputs[found.output]?.template;
    else if (found?.op === "shared") found = plan.templates?.[found.template];
    else return found;
  }
  return undefined;
};

/** Evaluates `template` by §3.2. */
export const evaluateTemplate = (
  template: Template,
  inputs: TemplateInputs,
  elements: readonly ElementBinding[] = [],
  options: EvaluationOptions = {},
): Evaluated => {
  let bound = false;
  const unsupported: string[] = [];
  const mintWithoutLabel = options.mintWithoutLabel ?? false;

  const { patterns } = options;

  const derive = (parts: Label[], by: By): Label => {
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
      ? { confidentiality, integrity: [...integrity, minted(by, patterns)] }
      : { confidentiality, integrity };
  };

  // The label of each output that a reference names, for the element
  // bindings and the position it was read at: an output that several
  // templates name is evaluated once (ruling Z58).
  const named = new Map<
    string,
    { label: Label; bound: boolean; unsupported: string[] }
  >();
  const reference = (
    kind: "output" | "shared",
    index: number,
    at: readonly ElementBinding[],
    passed: boolean,
  ): Label => {
    const key = JSON.stringify([kind, index, at, passed]);
    let known = named.get(key);
    if (known === undefined) {
      const template = kind === "output"
        ? options.outputs?.[index]?.template
        : options.templates?.[index];
      const outer = { bound, unsupported: unsupported.length };
      bound = false;
      let label: Label;
      if (template === undefined) {
        unsupported.push(kind);
        label = NEUTRAL;
      } else {
        label = walk(template, at, passed);
      }
      known = {
        label,
        bound,
        unsupported: unsupported.slice(outer.unsupported),
      };
      named.set(key, known);
      bound = outer.bound || known.bound;
      return label;
    }
    bound ||= known.bound;
    for (const op of known.unsupported) unsupported.push(op);
    return known.label;
  };

  const walk = (
    node: Template,
    at: readonly ElementBinding[],
    passed: boolean,
  ): Label => {
    switch (node.op) {
      case "const":
        return NEUTRAL;
      case "output":
        return reference("output", node.output, at, passed);
      case "shared":
        return reference("shared", node.template, at, passed);
      case "slot": {
        const collection = inputs.indexOf?.(node.slot);
        if (collection === undefined) return inputs.slot(node.slot, at, passed);
        // The label of the index is that of the whole array, and is the
        // same for every element (ruling Y2): it is evaluated outside the
        // element of the collection.
        const inside = at.findIndex((element) =>
          element.collection === collection
        );
        const outside = inside < 0 ? at : at.slice(0, inside);
        return inputs.array === undefined
          ? inputs.membership(collection, outside)
          : inputs.array(collection, outside);
      }
      case "derive":
        return derive(
          node.inputs.map((input) => walk(input, at, false)),
          node.by,
        );
      case "select": {
        const condition = walk(node.condition, at, false);
        const taken = inputs.selected(node.selector, at);
        const branches = taken === undefined
          ? node.branches.map((branch) => walk(branch, at, passed))
          : [walk(node.branches[taken], at, passed)];
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
        const choice = walk(node.choice, at, false);
        const chosen = inputs.picked?.(node.pick, at);
        if (chosen === undefined) bound = true;
        const body = walk(
          node.body,
          chosen === undefined ? at : [...at, chosen],
          passed,
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
          walk(node.body, [...at, { collection: node.collection, key }], false)
        );
        const met = meet(bodies.map((body) => body.integrity));
        const kept = (met === "neutral" ? [] : met).filter((atom) =>
          inputs.hereditary(atom)
        );
        const confidentiality = union([
          membership.confidentiality,
          ...bodies.map((body) => body.confidentiality),
        ]);
        return mintWithoutLabel || confidentiality.length > 0 ||
            kept.length > 0
          ? {
            confidentiality,
            integrity: [...kept, patternAtom(patterns, node.pattern)],
          }
          : { confidentiality, integrity: kept };
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

  const label = walk(template, elements, true);
  return {
    label: options.kept ? keptOutputLabel(label, patterns) : label,
    bound,
    unsupported,
  };
};

/** How a template label stands to the runtime's on one axis. */
export type Relation = "equal" | "tighter" | "looser" | "incomparable";

export type Comparison = {
  confidentiality: Relation;
  integrity: Relation;
  overall: Relation;
  /** Witness-bearing `TransformedBy` atoms of the runtime's label. */
  runtimeInputWitnesses: number;
  /**
   * The atoms of the template that name a pattern and stand where the
   * runtime's label has an atom that names other code: the callback of a
   * promoted `computed` (§3.1, "An atom that names code"). The two are
   * taken as corresponding, so they are no difference in the count.
   */
  patternForOtherCode: number;
};

/**
 * The category a row of the comparison is counted in. A row that is not
 * looser and has an atom that names the pattern where the runtime's names
 * other code is counted apart from the equal and the tighter ones: the
 * atoms differ in what they name, and not in their number.
 */
export type Category = Relation | "atom names the pattern";

export const categoryOf = (comparison: Comparison): Category => {
  const axes = [comparison.confidentiality, comparison.integrity];
  return axes.includes("incomparable")
    ? "incomparable"
    : axes.includes("looser")
    ? "looser"
    : comparison.patternForOtherCode > 0
    ? "atom names the pattern"
    : comparison.overall;
};

const isTransformedBy = (atom: Atom): boolean =>
  typeof atom === "object" && atom !== null &&
  (atom as { type?: unknown }).type === TRANSFORMED_BY;

const namesPattern = (atom: Atom): boolean =>
  isTransformedBy(atom) &&
  (atom as { identity?: { kind?: unknown } }).identity?.kind === "pattern";

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
 * names a body by its index or a pattern, and the runtime a compiled
 * function: such atoms are counted, and `patternForOtherCode` says how many
 * of the template's name a pattern where the runtime's names other code.
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
  // A view lists an atom once for each entry that has it, so the atoms
  // are counted by identity.
  const mints = (atoms: Atom[]) =>
    keys(atoms.filter((a) => isTransformedBy(a) && !hasInputWitness(a))).size;
  const templatePlain = keys(plain(templateI));
  const runtimePlain = keys(plain(runtimeI));
  const mintDifference = mints(templateI) - mints(runtimeI);
  // The template's atoms that name a body correspond to the runtime's
  // first, and those that name a pattern to the runtime's that are left.
  const templatePatterns = mints(templateI.filter(namesPattern));
  const patternForOtherCode = Math.min(
    templatePatterns,
    Math.max(mints(runtimeI) - (mints(templateI) - templatePatterns), 0),
  );
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
    patternForOtherCode,
  };
};
