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
  labelForConsumedEntries,
} from "../../../runtime/runner/src/cfc/consumed-label.ts";
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
  outputs: { path: string[]; kept?: boolean; template?: Template }[];
  bodies?: { writes?: { template?: Template }[] }[];
  cones?: { writes?: { template?: Template }[] }[];
  stateCells?: { first?: { cone: number; write: number } }[];
  collections?: {
    membership?: Template;
    source: { slot?: number; collection?: number };
  }[];
  templates?: Template[];
  bindings?: { handler?: { body?: number } }[];
};

/** The record of a write, as the write record names it. */
type PlanRecord = RecordedPlanWrite["record"];

/** One write record of a commit, checked against the evaluator. */
export type OracleCheck = {
  record: PlanRecord;
  /** The written path of the executor's document. */
  path: string[];
  /** The label stored at the path after the commit. */
  stored: Label;
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
  return {
    type: TRANSFORMED_BY,
    identity: typeof identity.body === "number"
      ? { kind: "body", body: identity.body }
      : { kind: "pattern", pattern: patterns[0] ?? "unlisted:0" },
    ...(inputWitness === undefined ? {} : { inputWitness }),
  };
};

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
          nonRecursive: false,
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
        const { chain, observes } = binding;
        if (chain.length === 0) throw new NotEvaluated("an empty chain");
        const links = chain.slice(0, -1).map((link) =>
          observed(link, "followRef")
        );
        const last = observed(chain[chain.length - 1], observes);
        return {
          confidentiality: union([
            ...links.map((link) => link.confidentiality),
            last.confidentiality,
          ]),
          integrity: last.integrity,
        };
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

    return writes.map((write): OracleCheck => {
      const stored = asEvaluatorLabel(consumedAt(tx, write.target), patterns);
      const base = {
        record: write.record,
        path: [...write.target.path],
        stored,
        bound: false,
        unsupported: [],
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
        const comparison = compareLabels(evaluated.label, stored);
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
  category: Category;
  confidentiality: Relation;
  integrity: Relation;
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
  oracle?: { checked: number; agree: number; differs: Difference[] };
  /** Commits refused with the option on and not with it off. */
  refusedOnly?: string[];
  /** Commits refused with the option off. */
  refusedOff?: number;
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
  what: check.error !== undefined
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
  ) => Label | undefined,
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
    let stored: Label | undefined;
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
    const mapped = asEvaluatorLabel(stored, patterns);
    const comparison = compareLabels(mapped, row.runtimeLabel);
    rows.push({
      kind: row.kind,
      path: row.path,
      stored: show(mapped),
      today: show(row.runtimeLabel),
      category: categoryOf(comparison),
      confidentiality: comparison.confidentiality,
      integrity: comparison.integrity,
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
  into: Map<string, Label>,
): void => {
  const tx = runtime.edit();
  try {
    const space = instance.options.space as CfcAddress["space"];
    const result = hooks.entityOf(instance.id);
    for (const output of plan.outputs) {
      if (!output.kept || output.path.includes("*")) continue;
      into.set(
        storedKey("output", output.path),
        storedLabelAt(tx, {
          space,
          id: result,
          scope: "space",
          path: output.path,
        }),
      );
    }
    for (const check of [...checks].reverse()) {
      if (!("body" in check.record)) continue;
      for (let start = 0; start <= check.path.length; start++) {
        const key = storedKey(check.record, check.path.slice(start));
        if (!into.has(key)) into.set(key, check.stored);
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
  // Today's run finds each stream where the executor stored it (ruling
  // Z43).
  const today = await runModule(
    module,
    "outside first",
    undefined,
    new ExecutorRun(artifact, argument, artifacts),
  );
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
  const stored = new Map<string, Label>();
  const off = await inStorage(
    artifact,
    argument,
    events,
    options,
    undefined,
    true,
    false,
  );
  const on = await inStorage(
    artifact,
    argument,
    events,
    options,
    undefined,
    true,
    true,
    {
      committed: (runtime, _hooks, writes) => {
        for (const check of checkWrites(runtime, plan, writes)) {
          checks.push(check);
        }
      },
      end: (runtime, hooks, instance) =>
        readStored(runtime, hooks, instance, plan, checks, stored),
    },
  );
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
    },
    refusedOnly: refused(on).filter((reason) =>
      !offReasons.has(refusalReason(reason))
    ),
    refusedOff: refused(off).length,
    off: totals([off.arm.settle, ...off.arm.events]),
    on: totals([on.arm.settle, ...on.arm.events]),
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
  if (tables === undefined) return;
  await Deno.mkdir(tables, { recursive: true });
  await writeTable(`${tables}/rows-beside-today.tsv`, rows);
  await writeTable(`${tables}/evaluator-differences.tsv`, differs);
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
