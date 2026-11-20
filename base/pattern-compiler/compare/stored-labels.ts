/**
 * Compares the labels the runtime stores from a compiled pattern's label
 * templates (milestone 4 of
 * `docs/plans/compiled-pattern-language-integration.md`, step 13) with
 * today's stored labels of the same rows and with the evaluator of
 * `template.ts`, over the corpus.
 *
 * Each module is run on today's runtime with the generated scenario of
 * `corpus.ts` (`runModule`), and then on the executor with its documents in
 * the runtime's storage, the labeled arm of `integrated.ts` (`inStorage`),
 * on the argument and the committed events of that run, twice: with the
 * experimental option `compiledPatterns` off and on, in a runtime that
 * serves the space. With the option on:
 *
 * - After each commit settles, the label stored at the target of each write
 *   record the commit recorded is compared with the label `template.ts`
 *   evaluates for the same template, from the same selections, picks and
 *   element groups, and from the slot labels the runtime's resolver gives
 *   the record's bindings (`observationLabelResolverFor`). A difference is
 *   a defect of the runtime's instantiation, of the evaluator, or of this
 *   comparison's reading of the slot labels, which reads them after the
 *   commit and so without the exclusions of the committing transaction.
 * - Once every event was handled, the label stored at each kept output and
 *   at each write-edge target is compared with today's label of the same
 *   row, in the categories of `corpus.ts report`.
 *
 * Per module it also records the commits refused with the option on that
 * are not refused with it off, the selections, picks and reads whose label
 * was the bound (`planLabelBounds`), and the preparations and their time
 * with the option off and on.
 *
 * ```sh
 * deno run -A --no-check base/pattern-compiler/compare/stored-labels.ts run <out.jsonl> [module text] [--emitted=<emit.jsonl>]
 * deno run -A --no-check base/pattern-compiler/compare/stored-labels.ts report <out.jsonl> [tables directory]
 * ```
 *
 * `run` appends one line per module and leaves out a module the file
 * already has, as `corpus.ts run` does. With `--emitted`, it reads the
 * modules from a file that holds what `pattern-compiler emit --corpus`
 * printed, and does not run the crate.
 */
import type { CfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import { atomPropagationClass } from "../../../runtime/runner/src/cfc/atom-classes.ts";
import {
  consumedEntriesForRead,
  entriesForConsumedLabel,
  labelForConsumedEntries,
} from "../../../runtime/runner/src/cfc/consumed-label.ts";
import { deepLabelAlong, storedReader } from "./deep-label.ts";
import { cfcCommitmentNormalForm } from "../../../runtime/runner/src/cfc/label-representation.ts";
import { readStoredCfcMetadata } from "../../../runtime/runner/src/cfc/metadata.ts";
import { observationLabelResolverFor } from "../../../runtime/runner/src/cfc/prepare.ts";
import type {
  CfcAddress,
  PlanInputs,
  SlotBinding,
} from "../../../runtime/runner/src/cfc/types.ts";
import { parseLink } from "../../../runtime/runner/src/link-utils.ts";
import type { NormalizedFullLink } from "../../../runtime/runner/src/link-types.ts";
import type { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { normalizeCellScope } from "../../../runtime/runner/src/scope.ts";
import type { URI } from "../../../runtime/runner/src/sigil-types.ts";
import type { IExtendedStorageTransaction } from "../../../runtime/runner/src/storage/interface.ts";
import type { Artifact, Instance } from "../exec/executor.ts";
import {
  artifactsOf,
  type CorpusModule,
  corpusModules,
  mainPattern,
  type ResultRow,
  runModule,
  wishStubs,
} from "./corpus.ts";
import { generateInputs } from "./generate.ts";
import { scenarioAudience } from "./harness.ts";
import {
  type Figure,
  instanceOptions,
  inStorage,
  type Sent,
} from "./integrated.ts";
import type {
  RecordedPlanWrite,
  RuntimeTransactions,
} from "./runtime-transactions.ts";
import {
  type Atom,
  atomKey,
  type Category,
  categoryOf,
  compareLabels,
  type ElementBinding,
  evaluateTemplate,
  type Label,
  type Relation,
  type Template,
  type TemplateInputs,
  TRANSFORMED_BY,
} from "./template.ts";
import { argumentOf, ExecutorRun } from "./values.ts";

/** The members of a plan this comparison reads. */
export type LabelPlan = {
  patterns?: string[];
  outputs: {
    path: string[];
    kept?: boolean;
    template?: Template;
    collection?: number;
    interim?: unknown;
  }[];
  bodies?: { writes?: { template?: Template }[] }[];
  cones?: { writes?: { template?: Template }[] }[];
  stateCells?: { first?: { cone: number; write: number } }[];
  collections?: {
    membership?: Template;
    source: { slot?: number; collection?: number };
  }[];
  templates?: Template[];
  bindings?: { handler?: { body?: number } }[];
  slots?: { root: { kind: string }; path: string[]; observes: string }[];
};

/** The record of a write, as the write record names it. */
type PlanRecord = RecordedPlanWrite["record"];

/** One write record of a commit, checked against the evaluator. */
export type OracleCheck = {
  record: PlanRecord;
  /** The written path of the executor's document. */
  path: string[];
  /**
   * The label stored at the path after the commit: the entry of origin
   * `derived` and class `value` there (`templateEntryAt`).
   */
  stored: Label;
  /**
   * Whether the runtime stored an entry at the path. A commit that read no
   * labeled document is not prepared, and stores none.
   */
  entry: boolean;
  /**
   * The label a read of the value at the path consumes after the commit,
   * through the links stored there (`storedLabelAt`), which is what today's
   * rows are read as.
   */
  read: Label;
  /**
   * The label of everything the value at the path holds after the commit,
   * each link in it followed (`deepLabelAlong`), with where the walk found
   * each of its atoms.
   */
  deep: Stored;
  /** The evaluator's label, where it evaluated one. */
  oracle?: Label;
  /** The evaluator found a selection or a pick unreported. */
  bound: boolean;
  /** The nodes the evaluator had no input for. */
  unsupported: string[];
  /** Why the evaluator did not evaluate, where it did not. */
  error?: string;
  /** How the evaluator's label stands to the stored one, on each axis. */
  confidentiality?: Relation;
  integrity?: Relation;
  /**
   * The bindings of the record that cannot hold the label of what their
   * slot reads (`unsoundBindings`).
   */
  unsound: string[];
};

/** The template and keep flag of the record a write names. */
export const templateOfRecord = (
  plan: LabelPlan,
  record: PlanRecord,
): { template: Template | undefined; kept: boolean } => {
  if ("output" in record) {
    const output = plan.outputs[record.output];
    return { template: output?.template, kept: output?.kept === true };
  }
  if ("body" in record) {
    return {
      template: plan.bodies?.[record.body]?.writes?.[record.write]?.template,
      kept: false,
    };
  }
  if ("cone" in record) {
    return {
      template: plan.cones?.[record.cone]?.writes?.[record.write]?.template,
      kept: false,
    };
  }
  const first = plan.stateCells?.[record.stateFirst]?.first;
  return {
    template: first === undefined
      ? undefined
      : plan.cones?.[first.cone]?.writes?.[first.write]?.template,
    kept: false,
  };
};

/**
 * The slot that stands for an `output` node in a template this comparison
 * hands the evaluator. The runtime instantiates an output's template with
 * the inputs the write record reports for that output, and the evaluator
 * would evaluate it with the inputs of the place that names it.
 */
const OUTPUT_SLOT = 1_000_000;

/** A template with each `output` node a slot of `OUTPUT_SLOT` and above. */
const withOutputSlots = (template: Template): Template => {
  switch (template.op) {
    case "output":
      return { op: "slot", slot: OUTPUT_SLOT + template.output };
    case "derive":
      return { ...template, inputs: template.inputs.map(withOutputSlots) };
    case "select":
      return {
        ...template,
        condition: withOutputSlots(template.condition),
        branches: template.branches.map(withOutputSlots),
      };
    case "pick":
      return {
        ...template,
        choice: withOutputSlots(template.choice),
        body: withOutputSlots(template.body),
      };
    case "fold":
      return { ...template, body: withOutputSlots(template.body) };
    default:
      return template;
  }
};

/**
 * A `TransformedBy` atom the runtime mints for a compiled pattern, as the
 * evaluator writes it: of the body where it names one, and of the first
 * pattern of the plan otherwise. An atom with an input witness keeps its
 * witness, which `compareLabels` leaves out of the relation.
 */
const asEvaluatorAtom = (atom: Atom, patterns: readonly string[]): Atom => {
  const { type, identity, inputWitness } = atom as {
    type?: unknown;
    identity?: { kind?: unknown; body?: unknown };
    inputWitness?: unknown;
  };
  if (type !== TRANSFORMED_BY || identity?.kind !== "compiled") return atom;
  // The runtime names entry 0 of `Plan.patterns` by the identity it
  // registered the pattern under, and a pattern compiled in by its entry.
  const pattern = (identity as { pattern?: unknown }).pattern;
  const compiledIn = typeof pattern === "string" &&
    patterns.indexOf(pattern) > 0;
  return {
    type: TRANSFORMED_BY,
    identity: typeof identity.body === "number"
      ? { kind: "body", body: identity.body }
      : {
        kind: "pattern",
        pattern: compiledIn ? pattern : patterns[0] ?? "unlisted:0",
      },
    ...(inputWitness === undefined ? {} : { inputWitness }),
  };
};

/**
 * A clause with the alternatives of each `anyOf` in one order: two runs
 * store the alternatives of one clause in different orders, which
 * `compareLabels` would count as different clauses.
 */
const ordered = (atom: Atom): Atom => {
  if (Array.isArray(atom)) return atom.map(ordered);
  if (typeof atom !== "object" || atom === null) return atom;
  const fields = Object.entries(atom as Record<string, unknown>).map((
    [name, value],
  ): [string, unknown] => [name, ordered(value)]);
  const anyOf = fields.find(([name]) => name === "anyOf");
  if (anyOf !== undefined && Array.isArray(anyOf[1])) {
    anyOf[1] = [...anyOf[1]].sort((a, b) =>
      atomKey(a) < atomKey(b) ? -1 : atomKey(a) > atomKey(b) ? 1 : 0
    );
  }
  return Object.fromEntries(fields);
};

/**
 * A label with each clause's alternatives in one order (`ordered`), and
 * each atom in its commitment-normal form: a label that a commit derives
 * from a document of another space holds the committed form of an atom
 * whose plain form the label of that document holds, and the two are one
 * atom (`cfcCommitmentNormalForm()`).
 */
export const orderedLabel = (label: Label): Label => ({
  confidentiality: label.confidentiality.map((clause) =>
    ordered(cfcCommitmentNormalForm(clause as CfcAtom))
  ),
  integrity: label.integrity === "neutral"
    ? "neutral"
    : label.integrity.map((atom) =>
      cfcCommitmentNormalForm(atom as CfcAtom) as Atom
    ),
});

/** A stored label with the runtime's atoms of a compiled pattern mapped. */
export const asEvaluatorLabel = (
  label: Label,
  patterns: readonly string[],
): Label => ({
  confidentiality: label.confidentiality,
  integrity: label.integrity === "neutral"
    ? "neutral"
    : label.integrity.map((atom) => asEvaluatorAtom(atom, patterns)),
});

const union = (lists: readonly (readonly Atom[])[]): Atom[] => {
  const seen = new Map<string, Atom>();
  for (const list of lists) {
    for (const atom of list) seen.set(atomKey(atom), atom);
  }
  return [...seen.values()];
};

/** The runtime's link of an address. */
const linkOf = (address: CfcAddress): NormalizedFullLink =>
  ({
    space: address.space,
    id: address.id as URI,
    path: [...address.path],
    scope: "space",
  }) as NormalizedFullLink;

/**
 * The label a value read at an address consumes, from the labels stored in
 * its document: the entries at the path, above it and below it.
 */
const consumedAt = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): Label => {
  const metadata = readStoredCfcMetadata(tx, linkOf(address));
  const label = metadata === undefined ? undefined : labelForConsumedEntries(
    consumedEntriesForRead(metadata, address.path, {
      nonRecursive: false,
      consumes: "value",
    }),
    address.path,
    false,
  );
  return {
    confidentiality: [...label?.confidentiality ?? []],
    integrity: [...label?.integrity ?? []],
  };
};

/**
 * The label the runtime stored for a path a write record covers: the
 * entry of origin `derived` and class `value` at the path, or at a path
 * whose `*` segments match it where there is none at the path itself. The
 * entries above and below the path, and those of other origins, such as
 * what the document's type declares, are not part of it.
 */
const templateEntryAt = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): Label | undefined => {
  const entries = readStoredCfcMetadata(tx, linkOf(address))?.labelMap
    .entries ?? [];
  const of = (exact: boolean) =>
    entries.filter((entry) =>
      entry.origin === "derived" && entry.observes !== "shape" &&
      entry.path.length === address.path.length &&
      entry.path.every((segment, index) =>
        segment === address.path[index] || (!exact && segment === "*")
      )
    );
  const exact = of(true);
  const found = exact.length > 0 ? exact : of(false);
  if (found.length === 0) return undefined;
  return {
    confidentiality: union(
      found.map((entry) => [...entry.label.confidentiality ?? []]),
    ),
    integrity: union(found.map((entry) => [...entry.label.integrity ?? []])),
  };
};

/**
 * The label stored for the value at `address`, followed through each link
 * stored there, as a read of the value reaches it: the confidentiality of
 * each link position on the way, and the label the value consumes where
 * the way ends.
 */
export const storedLabelAt = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): Label => {
  const confidentiality: Atom[][] = [];
  let at = address;
  // A way longer than this is a cycle of links, and ends there.
  for (let depth = 0; depth < 16; depth++) {
    const link = parseLink(tx.readValueOrThrow(linkOf(at)), linkOf(at));
    const label = consumedAt(tx, at);
    confidentiality.push(label.confidentiality);
    if (link === undefined) {
      return {
        confidentiality: union(confidentiality),
        integrity: label.integrity,
      };
    }
    at = {
      space: link.space ?? at.space,
      id: link.id as string,
      scope: "space",
      path: [...link.path],
    };
  }
  return { confidentiality: union(confidentiality), integrity: [] };
};

/**
 * A label read with each link below its path followed, and for each of its
 * atoms the position the read found it at, with the stored entries that give
 * it there.
 */
export type Stored = { label: Label; found: Record<string, string> };

/** The entries that give the label a value read of `address` consumes. */
const entriesAt = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): string => {
  const metadata = readStoredCfcMetadata(tx, linkOf({ ...address, path: [] }));
  if (metadata === undefined) return "no metadata";
  return entriesForConsumedLabel(
    consumedEntriesForRead(metadata, address.path, {
      nonRecursive: true,
      consumes: "value",
    }),
    address.path,
    true,
  ).map((entry) =>
    `${entry.origin ?? "legacy"}/${entry.observes ?? ""}@/${
      entry.path.join("/")
    }`
  ).join(" ");
};

/**
 * `deepLabelAlong` over the runtime's storage, with its atoms in the
 * evaluator's form and where each was found (`Stored`). A read in the class
 * `shape` reads the entries of the container at the address, through the
 * links at its position, and nothing below it.
 */
export const deepStoredAt = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
  patterns: readonly string[],
  observes: "value" | "shape" = "value",
): Stored => {
  const found: Record<string, string> = {};
  const label = deepLabelAlong(
    storedReader(tx, observes),
    address,
    (axis, atom, at) => {
      const key = `${axis === "confidentiality" ? "C" : "I"} ${
        atomKey(asEvaluatorAtom(atom, patterns))
      }`;
      found[key] ??= `${at.id === address.id ? "" : `${at.id.slice(0, 16)} `}/${
        at.path.join("/")
      } ${entriesAt(tx, at)}`;
    },
    observes === "value",
  );
  return { label: asEvaluatorLabel(label, patterns), found };
};

/** The inputs of one place of a write record, with the enclosing place. */
type Place = { inputs: PlanInputs; enclosing?: Place };

/** Thrown for a write record the evaluator cannot be given. */
class NotEvaluated extends Error {}

/**
 * Evaluates the template of each write record of one commit with
 * `template.ts`, from the record's own inputs and the labels the runtime's
 * resolver gives its slot bindings after the commit, and compares it with
 * the label stored at the record's target.
 */
export const checkWrites = (
  runtime: Runtime,
  plan: LabelPlan,
  writes: readonly RecordedPlanWrite[],
  /**
   * The clause of each input that the scenario gave one no other input
   * has (`generateInputs`), as text, by the input's name.
   */
  inputClauses: ReadonlyMap<string, string> = new Map(),
  /**
   * The instance the scenario's inputs are the argument of. The argument
   * of another instance, one a handler made, holds what its maker gave it.
   */
  main?: string,
): OracleCheck[] => {
  const tx = runtime.edit();
  try {
    const resolver = observationLabelResolverFor(tx);
    const patterns = plan.patterns ?? [];
    const templates = (plan.templates ?? []).map(withOutputSlots);
    const observed = (
      address: CfcAddress,
      observes: "value" | "shape" | "followRef",
    ): Label => {
      const { label } = resolver.resolve(
        {
          space: address.space,
          id: address.id as URI,
          scope: normalizeCellScope(address.scope),
        },
        "application/json",
        address.path,
        {
          shape: observes,
          // A `shape` and an `identity` slot observe their own position,
          // and a `value` slot the position and what is below it (PL
          // §2.2), as the runtime resolves the read the adapter journaled.
          nonRecursive: observes !== "value",
          coveredByTrace: false,
          machinery: false,
          declaredOnward: undefined,
        },
      );
      return {
        confidentiality: [...label?.confidentiality ?? []],
        integrity: observes === "followRef" ? [] : [...label?.integrity ?? []],
      };
    };

    /**
     * The label of a binding to addresses: every chain of it, as
     * `slotLabel` of `runtime/runner/src/cfc/plan-labels.ts` reads them.
     */
    const chainsLabel = (
      binding: Extract<SlotBinding, { chain: unknown }>,
    ): Label => {
      const { chain, observes } = binding;
      const clauses: Atom[][] = [];
      let integrity: Atom[] | undefined;
      for (const each of [chain, ...(binding.below ?? [])]) {
        if (each.length === 0) throw new NotEvaluated("an empty chain");
        for (const link of each.slice(0, -1)) {
          clauses.push(observed(link, "followRef").confidentiality);
        }
        const last = observed(each[each.length - 1], observes);
        clauses.push(last.confidentiality);
        const atoms = last.integrity as Atom[];
        const held = new Set(atoms.map(atomKey));
        integrity = integrity === undefined
          ? atoms
          : integrity.filter((atom) => held.has(atomKey(atom)));
      }
      return { confidentiality: union(clauses), integrity: integrity ?? [] };
    };

    /** Evaluates `template` at the place given. */
    const evaluate = (
      template: Template,
      place: Place,
      kept: boolean,
    ): { label: Label; bound: boolean; unsupported: string[] } => {
      // The place of each element binding the evaluation is inside.
      const places = new Map<string, Place>([["[]", place]]);
      const placeOf = (at: readonly ElementBinding[]) => {
        const found = places.get(JSON.stringify(at));
        if (found === undefined) {
          throw new NotEvaluated("an element the record does not report");
        }
        return found;
      };
      const find = <T>(
        from: Place,
        member: (inputs: PlanInputs) => T | undefined,
      ): { value: T; place: Place } | undefined => {
        for (let at: Place | undefined = from; at; at = at.enclosing) {
          const value = member(at.inputs);
          if (value !== undefined) return { value, place: at };
        }
        return undefined;
      };
      let bound = false;
      const unsupported: string[] = [];
      const nested = (inner: ReturnType<typeof evaluate>): Label => {
        bound ||= inner.bound;
        for (const op of inner.unsupported) unsupported.push(op);
        return inner.label;
      };
      const outputLabel = (output: number, from: Place): Label => {
        const reported = find(from, (inputs) => inputs.outputs?.[output]);
        const outputTemplate = plan.outputs[output]?.template;
        if (outputTemplate === undefined) {
          throw new NotEvaluated(`output ${output} has no template`);
        }
        return nested(evaluate(
          withOutputSlots(outputTemplate),
          reported === undefined ? from : { inputs: reported.value },
          false,
        ));
      };
      const bindingLabel = (binding: SlotBinding, from: Place): Label => {
        if ("output" in binding) return outputLabel(binding.output, from);
        if ("staged" in binding) return consumedAt(tx, binding.staged);
        if ("constant" in binding) {
          return { confidentiality: [], integrity: [] };
        }
        return chainsLabel(binding);
      };
      const slotLabel = (slot: number, from: Place): Label => {
        if (slot >= OUTPUT_SLOT) return outputLabel(slot - OUTPUT_SLOT, from);
        const found = find(from, (inputs) => inputs.slots[slot]);
        if (found === undefined) {
          throw new NotEvaluated(`slot ${slot} has no binding`);
        }
        return bindingLabel(found.value, found.place);
      };
      const membershipLabel = (collection: number, from: Place): Label => {
        const record = plan.collections?.[collection];
        if (record === undefined) {
          throw new NotEvaluated(`collection ${collection} is not in the plan`);
        }
        const membership = record.membership?.op === "shared"
          ? plan.templates?.[record.membership.template]
          : record.membership;
        // The membership template of a `filter` is the fold over its own
        // elements; what it iterates is the membership of its source.
        if (membership?.op === "fold" && membership.collection === collection) {
          if (record.source.collection !== undefined) {
            return membershipLabel(record.source.collection, from);
          }
          if (record.source.slot !== undefined) {
            return slotLabel(record.source.slot, from);
          }
          throw new NotEvaluated(`collection ${collection} iterates nothing`);
        }
        if (record.membership === undefined) {
          throw new NotEvaluated(`collection ${collection} has no membership`);
        }
        return nested(
          evaluate(withOutputSlots(record.membership), from, false),
        );
      };
      const inputs: TemplateInputs = {
        slot: (slot, at) => slotLabel(slot, placeOf(at)),
        selected: (selector, at) =>
          find(placeOf(at), (inputs) => inputs.selections?.[selector])?.value,
        elementKeys: (collection, at) => {
          const found = find(
            placeOf(at),
            (inputs) => inputs.elements?.[collection],
          );
          if (found === undefined) {
            throw new NotEvaluated(
              `collection ${collection} has no elements reported`,
            );
          }
          const { value: elements, place: holder } = found;
          const groups = "uniform" in elements
            ? [elements.uniform]
            : elements.groups.filter((group) => group.count > 0);
          return groups.map((group, index) => {
            const key = "uniform" in elements ? "*" : `group ${index}`;
            places.set(JSON.stringify([...at, { collection, key }]), {
              inputs: group,
              enclosing: holder,
            });
            return key;
          });
        },
        membership: (collection, at) =>
          membershipLabel(collection, placeOf(at)),
        picked: (pick, at) => {
          const found = find(placeOf(at), (inputs) => inputs.picks?.[pick]);
          if (found === undefined) return undefined;
          if (found.value === null) {
            throw new NotEvaluated(`pick ${pick} chose no child`);
          }
          const binding = { collection: -1, key: `pick ${pick}` };
          places.set(JSON.stringify([...at, binding]), {
            inputs: { slots: found.value.slots },
            enclosing: found.place,
          });
          return binding;
        },
        dynamic: (reads, at) => {
          const addresses = find(
            placeOf(at),
            (inputs) => inputs.dynamic?.[reads as number],
          )?.value;
          if (addresses === undefined) {
            throw new NotEvaluated(`dynamic reads ${reads} not reported`);
          }
          const parts = addresses.map((address) => observed(address, "value"));
          let met: Atom[] | "neutral" = "neutral";
          for (const part of parts) {
            const list = part.integrity as Atom[];
            if (met === "neutral") met = list;
            else {
              const keys = new Set(list.map(atomKey));
              met = met.filter((atom) => keys.has(atomKey(atom)));
            }
          }
          return {
            confidentiality: union(parts.map((part) => part.confidentiality)),
            integrity: met,
          };
        },
        hereditary: (atom) =>
          atomPropagationClass(atom as CfcAtom) === "hereditary",
      };
      const evaluated = evaluateTemplate(template, inputs, [], {
        patterns,
        templates,
        kept,
      });
      return {
        label: evaluated.label,
        bound: bound || evaluated.bound,
        unsupported: [...unsupported, ...evaluated.unsupported],
      };
    };

    /**
     * A check of the bindings that needs no template: every input of the
     * scenario is a cell with a clause of its own at its root, so the
     * label of a slot of the argument that observes more than a reference
     * holds the clause of the input it is below, and the position each of
     * its chains ends at holds no link (PL §2.5). Returns each binding of
     * `inputs`, and of the places in it, for which one of the two fails.
     */
    const unsoundBindings = (write: RecordedPlanWrite): string[] => {
      const inputs: PlanInputs = write;
      const found: string[] = [];
      const visit = (place: PlanInputs) => {
        for (const [slot, binding] of Object.entries(place.slots ?? {})) {
          const record = plan.slots?.[Number(slot)];
          if (
            record === undefined || !("chain" in binding) ||
            binding.observes === "followRef" ||
            record.root.kind !== "argument" || record.path.length === 0
          ) continue;
          const chains = [binding.chain, ...(binding.below ?? [])];
          for (const chain of chains) {
            const last = chain[chain.length - 1];
            if (last === undefined || last.path.includes("*")) continue;
            const held = tx.readValueOrThrow(linkOf(last));
            if (parseLink(held, linkOf(last)) !== undefined) {
              found.push(
                `slot ${slot} (${record.observes} at ${
                  record.path.join("/")
                }): a chain ends at a link, /${last.path.join("/")}`,
              );
            }
          }
          const clause = write.instance === main
            ? inputClauses.get(record.path[0])
            : undefined;
          if (
            clause === undefined || chains.some((each) => each.length === 0)
          ) {
            continue;
          }
          const label = chainsLabel(binding);
          if (
            !label.confidentiality.some((held) =>
              atomKey(ordered(held)) === clause
            )
          ) {
            found.push(
              `slot ${slot} (${record.observes} at ${
                record.path.join("/")
              }): the label has no clause of the input`,
            );
          }
        }
        for (const output of Object.values(place.outputs ?? {})) visit(output);
        for (const pick of Object.values(place.picks ?? {})) {
          if (pick !== null) visit({ slots: pick.slots });
        }
        for (const elements of Object.values(place.elements ?? {})) {
          if ("uniform" in elements) visit(elements.uniform);
          else for (const group of elements.groups) visit(group);
        }
      };
      visit(inputs);
      return [...new Set(found)];
    };

    return writes.map((write): OracleCheck => {
      const entry = templateEntryAt(tx, write.target);
      const stored = asEvaluatorLabel(
        entry ?? { confidentiality: [], integrity: [] },
        patterns,
      );
      const base = {
        record: write.record,
        path: [...write.target.path],
        stored,
        entry: entry !== undefined,
        read: storedLabelAt(tx, write.target),
        deep: deepStoredAt(tx, write.target, patterns),
        bound: false,
        unsupported: [],
        unsound: unsoundBindings(write),
      };
      const { template, kept } = templateOfRecord(plan, write.record);
      if (template === undefined) {
        return { ...base, error: "the record names no template" };
      }
      try {
        const evaluated = evaluate(
          withOutputSlots(template),
          { inputs: write },
          kept,
        );
        const comparison = compareLabels(
          orderedLabel(evaluated.label),
          orderedLabel(stored),
        );
        return {
          ...base,
          oracle: evaluated.label,
          bound: evaluated.bound,
          unsupported: evaluated.unsupported,
          confidentiality: comparison.confidentiality,
          integrity: comparison.integrity,
        };
      } catch (error) {
        if (!(error instanceof NotEvaluated)) throw error;
        return { ...base, error: error.message };
      }
    });
  } finally {
    tx.abort();
  }
};

/** A row of today's run beside the label the executor's path stored. */
export type StoredRow = {
  kind: "output" | "write";
  /** The row's path, as `ResultRow.path` writes it. */
  path: string;
  /** The label the labeled arm stored, with the option on. */
  stored: string;
  /** Today's label. */
  today: string;
  /**
   * The category and the relations of the two labels each read with every
   * link below the row's path followed, on both sides (`deepLabel`), where
   * today's row has that label; of `stored` and `today` otherwise.
   */
  category: Category;
  confidentiality: Relation;
  integrity: Relation;
  /** The stored and today's labels read with every link followed. */
  storedDeep?: string;
  todayDeep?: string;
  /** Where the stored deep label's atoms were found (`Stored`). */
  found?: Record<string, string>;
  /**
   * The category and relations of `stored` and `today`, each read
   * recursively below the row's path and through a link at the path only.
   */
  shallow?: {
    category: Category;
    confidentiality: Relation;
    integrity: Relation;
  };
};

/** One write record whose stored label is not the evaluator's. */
export type Difference = {
  what: string;
  record: string;
  path: string;
  stored: string;
  oracle?: string;
};

/** The figures of one arm, summed over the settle and the events. */
export type Totals = {
  commits: number;
  preparations: number;
  prepareMs: number;
  planLabelBounds: number;
};

/** The results of one module, as the results file holds them. */
export type ModuleLabels = {
  module: string;
  pattern?: string;
  skipped?: string;
  /** Today's rows beside the labels stored with the option on. */
  rows?: StoredRow[];
  /** Today's rows the labeled arm stored nothing for, by reason. */
  unmatched?: Record<string, number>;
  /** The write records checked against the evaluator. */
  oracle?: {
    checked: number;
    agree: number;
    differs: Difference[];
    /**
     * Each write record checked: the record, the written path, whether an
     * entry was stored there, and whether the evaluator found a selection
     * or a pick unreported, or did not evaluate.
     */
    records?: (string | boolean)[][];
    /**
     * Each binding that cannot hold the label of what its slot reads
     * (`OracleCheck.unsound`): the record, the written path, and what
     * fails.
     */
    unsound?: string[][];
  };
  /** Commits refused with the option on and not with it off. */
  refusedOnly?: string[];
  /** Commits refused with the option off. */
  refusedOff?: number;
  /**
   * The transactions today's runtime committed to its storage in its run
   * of the module, counted at the storage layer: before the instance was
   * started, which is the compile cache; from there until every kept
   * output was read, one transaction per node that ran; and from the first
   * event on. `reverted` counts the commits the storage took back.
   */
  todayCommits?: {
    compile: number;
    settle: number;
    events: number;
    reverted: number;
  };
  /**
   * Why the run with the option on stopped before its last event, where it
   * did: a write the executor made after a refused commit, which the
   * storage does not hold the document of.
   */
  failedOn?: string;
  off?: Totals;
  on?: Totals;
};

const totals = (figures: readonly Figure[]): Totals => {
  const sum = (key: keyof Totals) =>
    figures.reduce((total, figure) => total + figure[key], 0);
  return {
    commits: sum("commits"),
    preparations: sum("preparations"),
    prepareMs: sum("prepareMs"),
    planLabelBounds: sum("planLabelBounds"),
  };
};

/** A label as one line of text. */
const show = (label: Label): string =>
  `C ${JSON.stringify(label.confidentiality)} I ${
    JSON.stringify(label.integrity)
  }`;

/** A refusal reason without the identifiers, indices and paths in it. */
export const refusalReason = (reason: string): string =>
  reason.replace(/of:fid1:[\w-]+/g, "<doc>").replace(/ at \/\S*/g, "")
    .replace(/\/\S*/g, "<path>").replace(
      /\b(slot|collection|output) \d+/g,
      "$1 N",
    )
    .slice(0, 200);

/** Whether a check found the stored label to be the evaluator's. */
const agrees = (check: OracleCheck): boolean =>
  check.error === undefined && check.confidentiality === "equal" &&
  check.integrity === "equal";

/** A check that does not agree, as the results file holds it. */
export const differenceOf = (check: OracleCheck): Difference => ({
  what: !check.entry
    ? "no entry stored at the path"
    : check.error !== undefined
    ? `not evaluated: ${refusalReason(check.error)}`
    : `C ${check.confidentiality}, I ${check.integrity}${
      check.bound ? ", the evaluator's label a bound" : ""
    }${
      check.unsupported.length > 0
        ? `, the evaluator lacks ${check.unsupported.join(" ")}`
        : ""
    }`,
  record: JSON.stringify(check.record),
  path: check.path.join("/"),
  stored: show(check.stored),
  ...(check.oracle === undefined ? {} : { oracle: show(check.oracle) }),
});

/**
 * Compares the stored labels of the labeled arm with today's rows of a
 * run: an output row with the label stored at its path of the result
 * document, a write row with the label stored at the target of the last
 * write record of the same body and write whose path ends with the row's.
 */
export const compareWithToday = (
  plan: LabelPlan,
  today: readonly ResultRow[],
  storedAt: (
    record: "output" | PlanRecord,
    path: readonly string[],
  ) => Label | { shallow: Label; deep: Stored } | undefined,
): { rows: StoredRow[]; unmatched: Record<string, number> } => {
  const rows: StoredRow[] = [];
  const unmatched: Record<string, number> = {};
  const miss = (reason: string) => {
    unmatched[reason] = (unmatched[reason] ?? 0) + 1;
  };
  const patterns = plan.patterns ?? [];
  for (const row of today) {
    if (row.runtimeLabel === undefined) {
      miss("today's row has no label");
      continue;
    }
    let stored: Label | { shallow: Label; deep: Stored } | undefined;
    if (row.kind === "output") {
      stored = storedAt("output", row.path === "" ? [] : row.path.split("/"));
    } else {
      const body = plan.bindings?.[row.binding ?? -1]?.handler?.body;
      const [edge, ...rest] = row.path.split("/");
      const write = Number(edge.slice(edge.lastIndexOf("#") + 1));
      if (body === undefined || Number.isNaN(write)) {
        miss("a write row of no body");
        continue;
      }
      stored = storedAt({ body, write }, rest.filter((part) => part !== ""));
    }
    if (stored === undefined) {
      miss(`no stored ${row.kind}`);
      continue;
    }
    const shallow = "shallow" in stored ? stored.shallow : stored;
    const deep = "deep" in stored ? stored.deep : undefined;
    const mapped = orderedLabel(asEvaluatorLabel(shallow, patterns));
    const comparison = compareLabels(mapped, orderedLabel(row.runtimeLabel));
    const base = {
      kind: row.kind,
      path: row.path,
      stored: show(mapped),
      today: show(row.runtimeLabel),
      category: categoryOf(comparison),
      confidentiality: comparison.confidentiality,
      integrity: comparison.integrity,
    };
    if (deep === undefined || row.runtimeDeepLabel === undefined) {
      rows.push(base);
      continue;
    }
    const deepComparison = compareLabels(
      orderedLabel(deep.label),
      orderedLabel(row.runtimeDeepLabel),
    );
    rows.push({
      ...base,
      category: categoryOf(deepComparison),
      confidentiality: deepComparison.confidentiality,
      integrity: deepComparison.integrity,
      storedDeep: show(orderedLabel(deep.label)),
      todayDeep: show(orderedLabel(row.runtimeDeepLabel)),
      found: deep.found,
      shallow: {
        category: base.category,
        confidentiality: base.confidentiality,
        integrity: base.integrity,
      },
    });
  }
  return { rows, unmatched };
};

/** The key a stored label is held under: the record and the path. */
const storedKey = (
  record: "output" | PlanRecord,
  path: readonly string[],
): string => JSON.stringify([record, path]);

/**
 * Reads, once every event was handled, the label stored at each kept
 * output's path of the result document, and keeps the label stored at the
 * target of each write record of a write edge, under every suffix of the
 * target's path, the last record first.
 */
const readStored = (
  runtime: Runtime,
  hooks: RuntimeTransactions,
  instance: Instance,
  plan: LabelPlan,
  checks: readonly OracleCheck[],
  into: Map<string, { shallow: Label; deep: Stored }>,
): void => {
  const tx = runtime.edit();
  try {
    const space = instance.options.space as CfcAddress["space"];
    const result = hooks.entityOf(instance.id);
    for (const output of plan.outputs) {
      if (!output.kept || output.path.includes("*")) continue;
      const address: CfcAddress = {
        space,
        id: result,
        scope: "space",
        path: output.path,
      };
      // A collection's entry and a constructed value's container entry are
      // read in the class `shape`, as today's rows read them (`harness.ts`).
      const container = plan.outputs.some((other) =>
        other.kept !== false && other.interim === undefined &&
        other.path.length > output.path.length &&
        output.path.every((segment, index) => other.path[index] === segment)
      );
      into.set(storedKey("output", output.path), {
        shallow: storedLabelAt(tx, address),
        deep: deepStoredAt(
          tx,
          address,
          plan.patterns ?? [],
          output.collection === undefined && !container ? "value" : "shape",
        ),
      });
    }
    for (const check of [...checks].reverse()) {
      if (!("body" in check.record)) continue;
      for (let start = 0; start <= check.path.length; start++) {
        const key = storedKey(check.record, check.path.slice(start));
        if (!into.has(key)) {
          into.set(key, { shallow: check.read, deep: check.deep });
        }
      }
    }
  } finally {
    tx.abort();
  }
};

/** Runs one module of the corpus, as the head of this file says. */
export const compareModule = async (
  module: CorpusModule,
  artifacts: (id: string) => Artifact | undefined,
): Promise<ModuleLabels> => {
  const chosen = await mainPattern(module);
  if (chosen === undefined) {
    return { module: module.module, skipped: "exports no pattern" };
  }
  const base = { module: module.module, pattern: chosen.pattern.name };
  const artifact = chosen.pattern as unknown as Artifact;
  if (artifact.code === undefined || artifact.code.unsupported.length > 0) {
    return { ...base, skipped: "no value code" };
  }
  const plan = artifact.plan as unknown as LabelPlan;
  const inputs = generateInputs(
    artifact.plan as Parameters<typeof generateInputs>[0],
    artifact.schemas as Parameters<typeof generateInputs>[1],
    await scenarioAudience(),
  );
  const argument = argumentOf({ argument: {}, inputs });
  const clauses = new Map(
    Object.entries(inputs).flatMap(([name, input]) =>
      input.declared?.clause === undefined ? [] : [
        [
          name,
          atomKey(ordered(input.declared.clause as Atom)),
        ] as const,
      ]
    ),
  );
  // Today's run finds each stream where the executor stored it (ruling
  // Z43). Its commits are counted at the storage layer: each notification
  // of a commit the storage manager of the run broadcasts is one
  // transaction written to the replica, and a revert takes one back. The
  // counts are kept at the points of the run, so that the commits of the
  // compile cache, of the start with the reads of the rows, and of the
  // events are told apart.
  const seen = { commits: 0, reverted: 0 };
  const at: Record<string, number> = {};
  let subscribed = false;
  const today = await runModule(
    module,
    "outside first",
    {
      at: (point, { storageManager }) => {
        if (!subscribed) {
          subscribed = true;
          storageManager.subscribe({
            next: (notification) => {
              if (notification.type === "commit") seen.commits += 1;
              if (notification.type === "revert") seen.reverted += 1;
              return undefined;
            },
          });
        }
        at[point] ??= seen.commits;
      },
    },
    new ExecutorRun(
      artifact,
      argument,
      artifacts,
      await wishStubs(artifact.plan),
    ),
  );
  const todayCommits = {
    compile: at["compiled"] ?? 0,
    settle: (at["settled"] ?? seen.commits) - (at["compiled"] ?? 0),
    events: seen.commits - (at["settled"] ?? seen.commits),
    reverted: seen.reverted,
  };
  if (today.skipped !== undefined) return { ...base, skipped: today.skipped };
  const events: Sent[] = (today.outcomes ?? []).flatMap((outcome, index) =>
    outcome.outcome !== "committed" ? [] : [{
      index,
      binding: outcome.binding,
      event: outcome.event === "" ? undefined : JSON.parse(outcome.event),
      at: (outcome.elements ?? []).map(({ key }) => Number(key)),
    }]
  );
  const space = (await Identity.fromPassphrase("pattern-compiler-compare"))
    .did();
  const options = instanceOptions(module.module, space, artifacts);
  const checks: OracleCheck[] = [];
  const stored = new Map<string, { shallow: Label; deep: Stored }>();
  const refusedOn: string[] = [];
  const off = await inStorage(
    artifact,
    argument,
    events,
    options,
    undefined,
    true,
    false,
  );
  // A refused commit leaves the storage without what the executor holds,
  // and a later write of the executor can fail on that: the run with the
  // option on reports what it found up to there.
  let failed: string | undefined;
  let main: string | undefined;
  let on: Awaited<ReturnType<typeof inStorage>> | undefined;
  try {
    on = await inStorage(
      artifact,
      argument,
      events,
      options,
      undefined,
      true,
      true,
      {
        committed: (runtime, _hooks, writes) => {
          // The first commit is of the instance the scenario starts.
          main ??= writes[0]?.instance;
          for (
            const check of checkWrites(runtime, plan, writes, clauses, main)
          ) {
            checks.push(check);
          }
        },
        refused: (reasons) => {
          for (const reason of reasons) refusedOn.push(reason);
        },
        end: (runtime, hooks, instance) =>
          readStored(runtime, hooks, instance, plan, checks, stored),
      },
    );
  } catch (error) {
    failed = `${(error as Error)?.message ?? error}`.split("\n")[0]
      .slice(0, 160);
  }
  const { rows, unmatched } = compareWithToday(
    plan,
    today.rows ?? [],
    (record, path) => stored.get(storedKey(record, path)),
  );
  const refused = (arm: typeof off) =>
    [arm.arm.settle, ...arm.arm.events].flatMap((figure) => figure.refused);
  const offReasons = new Set(refused(off).map(refusalReason));
  return {
    ...base,
    rows,
    unmatched,
    oracle: {
      checked: checks.length,
      agree: checks.filter(agrees).length,
      differs: checks.filter((check) => !agrees(check)).map(differenceOf),
      records: checks.map((check) => [
        JSON.stringify(check.record),
        check.path.join("/"),
        check.entry,
        check.bound,
        ...(check.error === undefined ? [] : [check.error]),
      ]),
      unsound: checks.flatMap((check) =>
        check.unsound.map((what) => [
          JSON.stringify(check.record),
          check.path.join("/"),
          what,
        ])
      ),
    },
    refusedOnly: refusedOn.filter((reason) =>
      !offReasons.has(refusalReason(reason))
    ),
    refusedOff: refused(off).length,
    todayCommits,
    off: totals([off.arm.settle, ...off.arm.events]),
    ...(on === undefined ? {} : {
      on: totals([on.arm.settle, ...on.arm.events]),
    }),
    ...(failed === undefined ? {} : { failedOn: failed }),
  };
};

const readResults = async (file: string): Promise<ModuleLabels[]> => {
  try {
    return (await Deno.readTextFile(file)).split("\n").filter((line) =>
      line.startsWith("{")
    ).map((line) => JSON.parse(line) as ModuleLabels);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
};

/**
 * The modules of a file that holds what `pattern-compiler emit --corpus`
 * printed, one module per line, read a line at a time.
 */
const emittedModules = async (file: string): Promise<CorpusModule[]> => {
  const modules: CorpusModule[] = [];
  const handle = await Deno.open(file);
  // The whole output can be longer than a string can be. The pieces of the
  // line being read are joined once its end is read.
  let pieces: string[] = [];
  const take = (line: string) => {
    if (line.length > 0) modules.push(JSON.parse(line));
  };
  for await (
    const chunk of handle.readable.pipeThrough(new TextDecoderStream())
  ) {
    const lines = chunk.split("\n");
    if (lines.length === 1) {
      pieces.push(chunk);
      continue;
    }
    take([...pieces, lines[0]].join(""));
    for (const line of lines.slice(1, -1)) take(line);
    pieces = [lines[lines.length - 1]];
  }
  take(pieces.join(""));
  return modules;
};

const run = async (
  file: string,
  only: string | undefined,
  emittedFile: string | undefined,
) => {
  const emitted = emittedFile === undefined
    ? await corpusModules()
    : await emittedModules(emittedFile);
  const artifacts = artifactsOf(emitted);
  const done = new Set((await readResults(file)).map(({ module }) => module));
  for (const module of emitted) {
    if (
      module.patterns.length === 0 ||
      module.patterns.some((pattern) => pattern.unsupported.length > 0) ||
      (only !== undefined && !module.module.includes(only)) ||
      done.has(module.module)
    ) continue;
    console.error(module.module);
    let result: ModuleLabels;
    // What the runtime logs of a refused write is in the results.
    const { error: consoleError, warn: consoleWarn } = console;
    console.error = () => {};
    console.warn = () => {};
    try {
      result = await compareModule(module, artifacts);
    } catch (error) {
      result = {
        module: module.module,
        skipped: `the comparison fails: ${
          `${(error as Error)?.message ?? error}`.split("\n")[0].slice(0, 160)
        }`,
      };
    } finally {
      console.error = consoleError;
      console.warn = consoleWarn;
    }
    await Deno.writeTextFile(file, `${JSON.stringify(result)}\n`, {
      append: true,
    });
  }
};

const count = <T>(items: readonly T[], key: (item: T) => string) => {
  const counts = new Map<string, T[]>();
  for (const item of items) {
    const at = key(item);
    counts.set(at, [...counts.get(at) ?? [], item]);
  }
  return [...counts].sort((a, b) => b[1].length - a[1].length);
};

/** Writes rows as tab-separated text, one line per row. */
const writeTable = (
  file: string,
  rows: readonly Record<string, unknown>[],
): Promise<void> =>
  Deno.writeTextFile(
    file,
    rows.length === 0 ? "" : [
      Object.keys(rows[0]).join("\t"),
      ...rows.map((row) =>
        Object.values(row).map((value) =>
          `${typeof value === "string" ? value : JSON.stringify(value)}`
            .replaceAll("\t", " ").replaceAll("\n", " ")
        ).join("\t")
      ),
    ].join("\n") + "\n",
  );

/**
 * Prints the summary, and with `tables` writes the full tables there: the
 * rows beside today's, the records that differ from the evaluator, the
 * refusals with the option on alone, and the figures of each module.
 */
const report = async (file: string, tables: string | undefined) => {
  const results = await readResults(file);
  const ran = results.filter((result) => result.rows !== undefined);
  console.log(`modules attempted: ${results.length}, run: ${ran.length}`);
  for (
    const [reason, group] of count(
      results.filter((result) => result.skipped !== undefined),
      (result) => result.skipped!,
    )
  ) console.log(`  not run, ${group.length}: ${reason}`);
  const rows = ran.flatMap((result) =>
    result.rows!.map((row) => ({ module: result.module, ...row }))
  );
  for (const kind of ["output", "write"] as const) {
    const of = rows.filter((row) => row.kind === kind);
    console.log(`${kind} rows beside today's: ${of.length}`);
    for (const [category, group] of count(of, (row) => row.category)) {
      console.log(`  ${category}: ${group.length}`);
    }
  }
  const unmatched = new Map<string, number>();
  for (const result of ran) {
    for (const [reason, number] of Object.entries(result.unmatched ?? {})) {
      unmatched.set(reason, (unmatched.get(reason) ?? 0) + number);
    }
  }
  for (const [reason, number] of unmatched) {
    console.log(`today's rows not compared, ${reason}: ${number}`);
  }
  const checked = ran.reduce((sum, r) => sum + (r.oracle?.checked ?? 0), 0);
  const agree = ran.reduce((sum, r) => sum + (r.oracle?.agree ?? 0), 0);
  const differs = ran.flatMap((result) =>
    (result.oracle?.differs ?? []).map((entry) => ({
      module: result.module,
      ...entry,
    }))
  );
  console.log(
    `write records checked against the evaluator: ${checked}, agree ${agree}`,
  );
  for (const [what, group] of count(differs, (entry) => entry.what)) {
    const [example] = group;
    console.log(
      `  ${group.length} in ${
        new Set(group.map(({ module }) => module)).size
      } modules: ${what}\n      e.g. ${example.module} ${example.record} /${example.path}\n      stored ${
        example.stored.slice(0, 300)
      }\n      oracle ${example.oracle?.slice(0, 300)}`,
    );
  }
  const unsound = ran.flatMap((result) =>
    (result.oracle?.unsound ?? []).map(([record, path, what]) => ({
      module: result.module,
      record,
      path,
      what,
    }))
  );
  console.log(
    `bindings that cannot hold the label of what their slot reads: ${unsound.length} in ${
      new Set(unsound.map(({ module }) => module)).size
    } modules`,
  );
  for (
    const [what, group] of count(
      unsound,
      (entry) =>
        entry.what.replace(/^slot \d+ \(([a-z]+) at [^)]*\)/, "$1 slot")
          .replace(/, \/.*$/, ""),
    )
  ) {
    console.log(
      `  ${group.length} in ${
        new Set(group.map(({ module }) => module)).size
      } modules: ${what}\n      e.g. ${group[0].module} ${group[0].record} /${
        group[0].path
      }: ${group[0].what}`,
    );
  }
  const refusedOnly = ran.flatMap((result) =>
    (result.refusedOnly ?? []).map((reason) => ({
      module: result.module,
      reason,
    }))
  );
  console.log(
    `commits refused with the option on and not off: ${refusedOnly.length} in ${
      new Set(refusedOnly.map(({ module }) => module)).size
    } modules`,
  );
  for (
    const [reason, group] of count(
      refusedOnly,
      (entry) => refusalReason(entry.reason),
    )
  ) {
    console.log(
      `  ${group.length} in ${
        new Set(group.map(({ module }) => module)).size
      } modules: ${reason}\n      e.g. ${group[0].module}`,
    );
  }
  const stopped = ran.filter((result) => result.failedOn !== undefined);
  console.log(
    `runs with the option on that stopped after a refused commit: ${stopped.length}`,
  );
  for (const [reason, group] of count(stopped, (r) => r.failedOn!)) {
    console.log(`  ${group.length}: ${reason}`);
  }
  const sum = (arm: "off" | "on", key: keyof Totals) =>
    ran.reduce((total, result) => total + (result[arm]?.[key] ?? 0), 0);
  for (const arm of ["off", "on"] as const) {
    console.log(
      `option ${arm}: commits ${sum(arm, "commits")}, preparations ${
        sum(arm, "preparations")
      }, preparation ${sum(arm, "prepareMs").toFixed(0)} ms, bounds used ${
        sum(arm, "planLabelBounds")
      }`,
    );
  }
  const today = (key: "compile" | "settle" | "events" | "reverted") =>
    ran.reduce((total, result) => total + (result.todayCommits?.[key] ?? 0), 0);
  console.log(
    `today's runtime, transactions committed to storage: ${
      today("settle")
    } from the start of the instance until every kept output was read, ${
      today("events")
    } from the first event on, ${
      today("compile")
    } before the start (the compile cache), ${today("reverted")} reverted`,
  );
  if (tables === undefined) return;
  await Deno.mkdir(tables, { recursive: true });
  await writeTable(`${tables}/rows-beside-today.tsv`, rows);
  await writeTable(`${tables}/evaluator-differences.tsv`, differs);
  await writeTable(`${tables}/unsound-bindings.tsv`, unsound);
  await writeTable(`${tables}/refused-with-option-on.tsv`, refusedOnly);
  await writeTable(
    `${tables}/modules.tsv`,
    ran.map((result) => ({
      module: result.module,
      rows: result.rows?.length ?? 0,
      checked: result.oracle?.checked ?? 0,
      agree: result.oracle?.agree ?? 0,
      refusedOnly: result.refusedOnly?.length ?? 0,
      refusedOff: result.refusedOff ?? 0,
      offPreparations: result.off?.preparations ?? 0,
      offPrepareMs: (result.off?.prepareMs ?? 0).toFixed(1),
      onPreparations: result.on?.preparations ?? 0,
      onPrepareMs: (result.on?.prepareMs ?? 0).toFixed(1),
      bounds: result.on?.planLabelBounds ?? 0,
      offCommits: result.off?.commits ?? 0,
      onCommits: result.on?.commits ?? 0,
      todayStartCommits: result.todayCommits?.settle ?? 0,
      todayEventCommits: result.todayCommits?.events ?? 0,
    })),
  );
};

if (import.meta.main) {
  const emitted = Deno.args.find((argument) =>
    argument.startsWith("--emitted=")
  )
    ?.slice("--emitted=".length);
  const [command, file, extra] = Deno.args.filter((argument) =>
    !argument.startsWith("--")
  );
  if (command === "run" && file !== undefined) {
    await run(file, extra, emitted);
  } else if (command === "report" && file !== undefined) {
    await report(file, extra);
  } else {
    console.error(
      "usage: stored-labels.ts run <out.jsonl> [module text] [--emitted=<emit.jsonl>] | report <out.jsonl> [tables directory]",
    );
    Deno.exit(2);
  }
  Deno.exit(0);
}
