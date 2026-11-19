/**
 * Instantiation of a compiled pattern's label templates (the plan format's
 * `Template`, `docs/specs/compiled-pattern-language/plan-and-label-templates.md`
 * sections 1.1 and 4.2): a pure function from a template, the labels of its
 * slots and the reported selections to a label.
 *
 * Labels are handled by identifier inside instantiation. A `LabelTable`
 * interns each label under the content hash of its normalized form, so equal
 * labels are one object, and it memoizes every join and meet by the set of
 * identifiers it combines: equal inputs cost one lookup and no comparison of
 * atoms. A `fold` is instantiated once per distinct group of element inputs,
 * not once per element (`ElementInputs`), so the cost of a fold's label is
 * the number of distinct groups.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import {
  compareByCanonicalHash,
  normalizeClause,
  uniqueCfcAtoms,
} from "@commonfabric/memory/v2/cfc-clause-identity";
import type { CfcConfClause } from "@commonfabric/memory/v2/cfc-release-authority";

import { atomPropagationClass } from "./atom-classes.ts";
import { retainedInputWitnesses } from "./input-witness.ts";
import type { IFCLabel } from "./types.ts";

/** Index into the array the field name says it indexes. */
export type TemplateIndex = number;

/**
 * A label in symbolic form, as the plan format writes it. Each node kind has
 * a confidentiality rule and an integrity rule.
 */
export type Template =
  /** A literal or frozen module-scope datum. Contributes nothing. */
  | { readonly op: "const" }
  /** The observation of one slot, passed through unchanged. */
  | { readonly op: "slot"; readonly slot: TemplateIndex }
  /** The label of another output of the plan, named and not written out. */
  | {
    readonly op: "output";
    readonly output: TemplateIndex;
    readonly site?: TemplateIndex;
  }
  /** An entry of the plan's template table, named and not written out. */
  | { readonly op: "shared"; readonly template: TemplateIndex }
  /** A new value computed from the inputs, by a body or expression code. */
  | {
    readonly op: "derive";
    readonly inputs: readonly Template[];
    readonly by: DerivedBy;
  }
  /** Conditional selection: the condition, and the branch taken. */
  | {
    readonly op: "select";
    readonly selector: TemplateIndex;
    readonly condition: Template;
    readonly branches: readonly Template[];
  }
  /**
   * A join over the elements of a collection: all of them, or, with
   * `through`, the leading elements up to the position that selector holds.
   */
  | {
    readonly op: "fold";
    readonly collection: TemplateIndex;
    readonly body: Template;
    readonly through?: TemplateIndex;
    readonly pattern?: TemplateIndex;
  }
  /** One child chosen by a run-time key, and the choice. */
  | {
    readonly op: "pick";
    readonly pick: TemplateIndex;
    readonly from: PickSource;
    readonly choice: Template;
    readonly body: Template;
  }
  /** Reads whose addresses are known only at run time. */
  | { readonly op: "dynamic"; readonly reads: TemplateIndex };

/** What a `pick` chooses from. */
export type PickSource =
  | { readonly collection: TemplateIndex }
  | { readonly container: TemplateIndex }
  | { readonly output: TemplateIndex; readonly site?: TemplateIndex };

/** What computed a derived value: a sandboxed body, or expression code. */
export type DerivedBy =
  | { readonly body: TemplateIndex }
  | { readonly expression: true; readonly pattern?: TemplateIndex };

/**
 * A label interned in a `LabelTable`: its normalized confidentiality and
 * integrity, and the content hash of that form. Two interned labels with
 * equal identifiers are one object.
 */
export interface InternedLabel {
  readonly id: string;
  readonly confidentiality: readonly CfcConfClause[];
  readonly integrity: readonly CfcAtom[];
}

/**
 * What a `const` instantiates to: no clause, and no part in a meet. A label
 * with no clause and no atom is not neutral: it empties a meet.
 */
export const NEUTRAL = "neutral";

/** The result of instantiating a template. */
export type Instantiated = InternedLabel | typeof NEUTRAL;

/**
 * The elements of a collection a `fold` covers, in one of two forms. Each
 * form names every element once, so the fold's label is the same as the
 * label of instantiating the body for each element in turn.
 */
export type ElementInputs =
  /**
   * One set of inputs for every element, whose element slots resolve to the
   * join over the entries their `*` path covers. Allowed only where the body
   * holds no node whose label depends on a value (`select`, `pick`, `fold`,
   * `dynamic`) or that names a table entry (`shared`): for those, the join
   * of the elements' labels and the label over the joined inputs differ.
   */
  | { readonly uniform: TemplateInputs }
  /**
   * One set of inputs per distinct group of elements, with the number of
   * elements in it. A group with no element contributes nothing. The order
   * of the elements is not kept, so a fold with `through` covers every
   * group (the bound) and says so through `noteBound`.
   */
  | {
    readonly groups: readonly {
      readonly inputs: TemplateInputs;
      readonly count: number;
    }[];
  };

/** The inputs `instantiateTemplate` takes in place of a transaction. */
export interface TemplateInputs {
  /**
   * The label of a slot, resolved by address, path and class, with its
   * chain. For an address the transaction wrote, the label staged there.
   */
  slotLabel(slot: TemplateIndex): InternedLabel;

  /**
   * The branch the value code took at a selector, or `undefined` where it
   * was not reported. For the `through` of a `fold`, the position the
   * runtime's own scan found.
   */
  selection(selector: TemplateIndex): number | undefined;

  /** The elements of a collection. */
  elements(collection: TemplateIndex): ElementInputs;

  /**
   * The child chosen at a choice point: `{ chosen: undefined }` where none
   * was chosen, `undefined` where the choice was not reported.
   */
  chosen(
    pick: TemplateIndex,
  ): { readonly chosen: TemplateInputs | undefined } | undefined;

  /**
   * Every child a choice point can choose from, for the bound of a choice
   * that was not reported. `from` is what the `pick` node chooses from.
   */
  children(pick: TemplateIndex, from: PickSource): ElementInputs;

  /** The label of the membership a collection iterates. */
  membership(collection: TemplateIndex): InternedLabel;

  /**
   * The label of an output's template for these inputs, without the atom of
   * a kept output. The caller instantiates it at most once per transaction
   * and set of inputs.
   */
  outputLabel(output: TemplateIndex, site?: TemplateIndex): Instantiated;

  /** The label of an entry of the plan's template table for these inputs. */
  sharedLabel(template: TemplateIndex): Instantiated;

  /** The join of what a journaled read set consumed. */
  dynamicLabel(reads: TemplateIndex): InternedLabel;

  /**
   * The `TransformedBy` atoms the runtime mints for a derivation, as a label
   * with integrity only. `witnesses` holds, as integrity, the input
   * witnesses met over the inputs that carry a clause, and is `undefined`
   * where no input carries one.
   */
  mint(by: DerivedBy, witnesses: InternedLabel | undefined): InternedLabel;

  /**
   * Notes that a `select`, a `pick` or a `fold` with `through` was
   * instantiated as its bound because its selection was not available.
   */
  noteBound(kind: "select" | "pick" | "fold", index: TemplateIndex): void;
}

/** Work counted while instantiating, without affecting the result. */
export interface TemplateWork {
  /** Templates instantiated: each call, and each body of a fold or pick. */
  instantiations: number;
  /** Template nodes visited. */
  nodes: number;
  /** Slot labels asked for. */
  slotLabels: number;
  /** Joins and meets a `LabelTable` returned from its memo. */
  memoHits: number;
}

/** Returns a record of work with every count at zero. */
export const emptyTemplateWork = (): TemplateWork => ({
  instantiations: 0,
  nodes: 0,
  slotLabels: 0,
  memoHits: 0,
});

/** Thrown when a template cannot be instantiated from the inputs given. */
export class TemplateInstantiationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateInstantiationError";
  }
}

/**
 * Interns labels and memoizes the label operations instantiation uses, by
 * the identifiers of their operands. One table serves one runtime; what it
 * holds is a function of label content alone, so it is shared across
 * transactions, instances and patterns.
 */
export class LabelTable {
  readonly #byId = new Map<string, InternedLabel>();
  readonly #byObject = new WeakMap<object, InternedLabel>();
  readonly #memo = new Map<string, unknown>();
  #work: TemplateWork | undefined;

  /** The label with no clause and no atom. */
  readonly empty: InternedLabel;

  constructor() {
    this.empty = this.intern({});
  }

  /** The number of distinct labels interned. */
  get size(): number {
    return this.#byId.size;
  }

  /**
   * Returns the interned form of `label`: clauses normalized, de-duplicated
   * and ordered by canonical hash, atoms de-duplicated and ordered the same
   * way. The same label object interns once.
   */
  intern(label: IFCLabel): InternedLabel {
    const seen = this.#byObject.get(label);
    if (seen !== undefined) return seen;
    const interned = this.#internParts(
      label.confidentiality ?? [],
      label.integrity ?? [],
    );
    this.#byObject.set(label, interned);
    return interned;
  }

  /**
   * Runs `run` with `work` counting this table's memo hits, and returns what
   * it returns.
   */
  counting<T>(work: TemplateWork, run: () => T): T {
    const outer = this.#work;
    this.#work = work;
    try {
      return run();
    } finally {
      this.#work = outer;
    }
  }

  /**
   * Returns the join of `parts` for a derivation: the union of their
   * confidentiality, the hereditary atoms every part carries, and the input
   * witnesses met over the parts that carry a clause (`undefined` where none
   * does). No part gives the empty label. Memoized by the set of the parts'
   * identifiers.
   */
  combine(parts: readonly InternedLabel[]): {
    readonly label: InternedLabel;
    readonly witnesses: InternedLabel | undefined;
  } {
    const ids = [...new Set(parts.map((part) => part.id))].sort();
    return this.#memoized(`combine\u0000${ids.join("\u0000")}`, () => {
      const distinct = ids.map((id) => this.#byId.get(id)!);
      let meet: CfcAtom[] | undefined;
      let witnesses: CfcAtom[] | undefined;
      const clauses: CfcConfClause[] = [];
      for (const part of distinct) {
        for (const clause of part.confidentiality) clauses.push(clause);
        const hereditary = part.integrity.filter((atom) =>
          atomPropagationClass(atom) === "hereditary"
        );
        meet = meet === undefined
          ? hereditary
          : meet.filter((atom) => hereditary.includes(atom));
        if (part.confidentiality.length > 0) {
          const retained = retainedInputWitnesses(part.integrity);
          witnesses = witnesses === undefined
            ? retained
            : witnesses.filter((atom) => retained.includes(atom));
        }
      }
      return {
        label: this.#internParts(clauses, meet ?? []),
        witnesses: witnesses === undefined
          ? undefined
          : this.#internParts([], witnesses),
      };
    });
  }

  /**
   * Returns the label of a selection: the confidentiality of `condition`
   * joined with that of `taken`, and the integrity of `taken`. A neutral
   * condition contributes no clause, and a neutral `taken` gives no
   * integrity.
   */
  select(condition: Instantiated, taken: Instantiated): InternedLabel {
    const conditionId = condition === NEUTRAL ? NEUTRAL : condition.id;
    const takenId = taken === NEUTRAL ? NEUTRAL : taken.id;
    return this.#memoized(
      `select\u0000${conditionId}\u0000${takenId}`,
      () =>
        this.#internParts(
          [
            ...(condition === NEUTRAL ? [] : condition.confidentiality),
            ...(taken === NEUTRAL ? [] : taken.confidentiality),
          ],
          taken === NEUTRAL ? [] : taken.integrity,
        ),
    );
  }

  /**
   * Returns the bound of a choice among `options`: their confidentiality
   * joined with the condition's, and the atoms of integrity every option
   * carries. A neutral option gives no integrity, as a neutral selected
   * branch does.
   */
  bound(
    condition: Instantiated,
    options: readonly Instantiated[],
  ): InternedLabel {
    const ids = [
      ...new Set(
        options.map((option) => option === NEUTRAL ? NEUTRAL : option.id),
      ),
    ].sort();
    const conditionId = condition === NEUTRAL ? NEUTRAL : condition.id;
    return this.#memoized(
      `bound\u0000${conditionId}\u0000${ids.join("\u0000")}`,
      () => {
        const clauses: CfcConfClause[] = condition === NEUTRAL
          ? []
          : [...condition.confidentiality];
        let integrity: readonly CfcAtom[] | undefined;
        for (const id of ids) {
          if (id === NEUTRAL) {
            integrity = [];
            continue;
          }
          const option = this.#byId.get(id)!;
          for (const clause of option.confidentiality) clauses.push(clause);
          integrity = integrity === undefined
            ? option.integrity
            : integrity.filter((atom) => option.integrity.includes(atom));
        }
        return this.#internParts(clauses, integrity ?? []);
      },
    );
  }

  /** Returns `label` with the integrity atoms of `atoms` added. */
  withIntegrity(label: InternedLabel, atoms: InternedLabel): InternedLabel {
    if (atoms.integrity.length === 0) return label;
    return this.#memoized(
      `with\u0000${label.id}\u0000${atoms.id}`,
      () =>
        this.#internParts(label.confidentiality, [
          ...label.integrity,
          ...atoms.integrity,
        ]),
    );
  }

  /** Returns the memoized result under `key`, computing it on a miss. */
  #memoized<T>(key: string, compute: () => T): T {
    if (this.#memo.has(key)) {
      if (this.#work !== undefined) this.#work.memoHits++;
      return this.#memo.get(key) as T;
    }
    const result = compute();
    this.#memo.set(key, result);
    return result;
  }

  /**
   * Interns a label from its parts. Atoms that are equal are one object
   * across the table, so a later meet compares them by reference.
   */
  #internParts(
    confidentiality: readonly CfcConfClause[],
    integrity: readonly CfcAtom[],
  ): InternedLabel {
    const clauses = uniqueCfcAtoms(confidentiality.map(normalizeClause))
      .sort(compareByCanonicalHash) as CfcConfClause[];
    const atoms = uniqueCfcAtoms(integrity).sort(compareByCanonicalHash);
    const id = hashStringOf({ confidentiality: clauses, integrity: atoms });
    const existing = this.#byId.get(id);
    if (existing !== undefined) return existing;
    const interned: InternedLabel = Object.freeze({
      id,
      confidentiality: Object.freeze(
        clauses.map((clause) => this.#atom(clause)),
      ),
      integrity: Object.freeze(atoms.map((atom) => this.#atom(atom))),
    }) as InternedLabel;
    this.#byId.set(id, interned);
    return interned;
  }

  readonly #atoms = new Map<string, CfcAtom>();

  /** Returns the one object the table holds for an atom equal to `atom`. */
  #atom<T extends CfcAtom>(atom: T): T {
    const key = hashStringOf(atom);
    const existing = this.#atoms.get(key);
    if (existing !== undefined) return existing as T;
    this.#atoms.set(key, atom);
    return atom;
  }
}

/**
 * Templates under which elements may not be given in the uniform form,
 * memoized by template object: those holding a `select`, `pick`, `fold`,
 * `dynamic` or `shared` node.
 */
const valueDependent = new WeakMap<Template, boolean>();

/** Whether `template` holds a node the uniform element form excludes. */
const dependsOnValue = (template: Template): boolean => {
  const seen = valueDependent.get(template);
  if (seen !== undefined) return seen;
  let result: boolean;
  switch (template.op) {
    case "select":
    case "pick":
    case "fold":
    case "dynamic":
    case "shared":
      result = true;
      break;
    case "derive":
      result = template.inputs.some(dependsOnValue);
      break;
    default:
      result = false;
  }
  valueDependent.set(template, result);
  return result;
};

/**
 * Instantiates `template` for `inputs`: the label of one write, or of one
 * output, from its slots' labels and the selections the value code reported.
 * A selection or choice that was not reported is instantiated as its bound,
 * which is wider than any selected branch, and `inputs.noteBound` hears of
 * it. `work` counts what the instantiation did. Throws a
 * `TemplateInstantiationError` where the inputs do not fit the template.
 */
// SPEC-PENDING https://github.com/commonfabric/specs/pull/91
// The label of a compiled pattern's write is instantiated from its template,
// as the pull request's instantiation pseudocode has it, behind the
// experimental option `compiledPatterns`, which defaults off.
export const instantiateTemplate = (
  template: Template,
  inputs: TemplateInputs,
  table: LabelTable,
  work: TemplateWork,
): Instantiated =>
  table.counting(work, () => instantiate(template, inputs, table, work));

/** Helper for `instantiateTemplate`, counting one instantiation. */
const instantiate = (
  template: Template,
  inputs: TemplateInputs,
  table: LabelTable,
  work: TemplateWork,
): Instantiated => {
  work.instantiations++;
  return node(template, inputs, table, work);
};

/** Instantiates one node of a template. */
const node = (
  template: Template,
  inputs: TemplateInputs,
  table: LabelTable,
  work: TemplateWork,
): Instantiated => {
  work.nodes++;
  switch (template.op) {
    case "const":
      return NEUTRAL;
    case "slot":
      work.slotLabels++;
      return inputs.slotLabel(template.slot);
    case "output":
      return inputs.outputLabel(template.output, template.site);
    case "shared":
      return inputs.sharedLabel(template.template);
    case "dynamic":
      return inputs.dynamicLabel(template.reads);
    case "derive": {
      const parts: InternedLabel[] = [];
      for (const input of template.inputs) {
        const part = node(input, inputs, table, work);
        if (part !== NEUTRAL) parts.push(part);
      }
      return derived(table.combine(parts), template.by, inputs, table);
    }
    case "select": {
      const condition = node(template.condition, inputs, table, work);
      const selected = inputs.selection(template.selector);
      if (selected === undefined) {
        inputs.noteBound("select", template.selector);
        return table.bound(
          condition,
          template.branches.map((branch) => node(branch, inputs, table, work)),
        );
      }
      const branch = template.branches[selected];
      if (branch === undefined) {
        throw new TemplateInstantiationError(
          `selection ${selected} of selector ${template.selector} names no branch of ${template.branches.length}`,
        );
      }
      return table.select(condition, node(branch, inputs, table, work));
    }
    case "pick": {
      const choice = node(template.choice, inputs, table, work);
      const reported = inputs.chosen(template.pick);
      if (reported === undefined) {
        inputs.noteBound("pick", template.pick);
        return table.bound(
          choice,
          eachElement(
            template.body,
            inputs.children(template.pick, template.from),
            table,
            work,
          ),
        );
      }
      return table.select(
        choice,
        reported.chosen === undefined
          ? NEUTRAL
          : instantiate(template.body, reported.chosen, table, work),
      );
    }
    case "fold": {
      if (template.through !== undefined) {
        // The groups keep no order, so a prefix cannot be told from them;
        // covering every element is the bound.
        inputs.noteBound("fold", template.through);
      }
      const parts = eachElement(
        template.body,
        inputs.elements(template.collection),
        table,
        work,
      ).filter((part): part is InternedLabel => part !== NEUTRAL);
      const combined = table.combine(parts);
      const withMembership = {
        label: table.select(
          inputs.membership(template.collection),
          combined.label,
        ),
        witnesses: combined.witnesses,
      };
      return derived(
        withMembership,
        template.pattern === undefined
          ? { expression: true }
          : { expression: true, pattern: template.pattern },
        inputs,
        table,
      );
    }
  }
};

/**
 * Instantiates `body` once per element group, or once for uniform elements.
 */
const eachElement = (
  body: Template,
  elements: ElementInputs,
  table: LabelTable,
  work: TemplateWork,
): Instantiated[] => {
  if ("uniform" in elements) {
    if (dependsOnValue(body)) {
      throw new TemplateInstantiationError(
        "elements given in the uniform form under a body whose label depends on a value",
      );
    }
    return [instantiate(body, elements.uniform, table, work)];
  }
  const parts: Instantiated[] = [];
  for (const group of elements.groups) {
    if (group.count <= 0) continue;
    parts.push(instantiate(body, group.inputs, table, work));
  }
  return parts;
};

/**
 * Adds the `TransformedBy` atoms of a derivation to its combined label, when
 * the label has a clause or a hereditary atom to stand beside.
 */
const derived = (
  combined: {
    readonly label: InternedLabel;
    readonly witnesses: InternedLabel | undefined;
  },
  by: DerivedBy,
  inputs: TemplateInputs,
  table: LabelTable,
): InternedLabel => {
  const { label } = combined;
  if (label.confidentiality.length === 0 && label.integrity.length === 0) {
    return label;
  }
  return table.withIntegrity(label, inputs.mint(by, combined.witnesses));
};
