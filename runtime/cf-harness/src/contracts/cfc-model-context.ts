import type { JSONObject } from "@commonfabric/api";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type {
  CfcConfClause,
  CfcLabelView,
  IFCLabel,
} from "@commonfabric/runner/cfc";
import { isOrClause, normalizeClause } from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { HarnessCfcInvocationInputLabelPath } from "./cfc-invocation-context.ts";
import type { ToolOutputId } from "./tool-result.ts";

export type HarnessCfcModelContextChannel =
  | "stdout"
  | "stderr"
  | "exitCode"
  | "output";

/**
 * One read a host declared an output made of the person's data: the source's
 * reference, the revision it was read at (`null`, with
 * `coverage.revisionScope: "none"`, for a source that has none), how much of
 * it the read covered, the row's own label, and the author, title, and date
 * the host holds for it. The host decides every field; the harness records
 * them as declared. A read is provenance recorded beside the observation's
 * label, not an integrity atom, and the label algebra does not read it.
 */
export interface HarnessCfcModelContextRead {
  ref: string;
  revision: string | null;

  /**
   * `{kind: "query"}`, `{kind: "search-snippet"}`, or
   * `{kind: "body", pages?, offset?, limit?}`, with an optional
   * `revisionScope`; kept whole, so a field the host adds is kept too.
   */
  coverage: { kind: string } & JSONObject;
  ifc: IFCLabel;

  /**
   * The stores whose provisional default label `ifc` is, where it is one: a
   * label the host assigned a store that has no verified contract yet.
   * Absent for a verified or a public label.
   */
  provisional?: readonly string[];
  author?: JSONObject;
  title?: string;
  at?: string;
}

/**
 * Most reads one observation records. An output whose reads would pass it is
 * not shown to the model (`tools/loom-commands.ts`), so the record never
 * leaves out a read of something the model saw.
 */
export const HARNESS_CFC_MODEL_CONTEXT_READS_LIMIT = 512;

/**
 * Most UTF-8 bytes of JSON one read may hold; an output declaring a larger one
 * is not shown to the model. Loom bounds a read's text at 1,000 characters of
 * reference, 200 of revision, 3,000 of title and 100 of date, and its
 * coverage at 1,000 page numbers (`source_reads.py`). Serialized, a character
 * takes at most 6 bytes (a control character escaped as `\u00XX`) and a page
 * number at most 17 (a safe integer and its comma), so those fields take at
 * most 42,800 bytes, and this leaves about 22,700 for the label, the author,
 * the provisional stores and the keys.
 */
export const HARNESS_CFC_MODEL_CONTEXT_READ_MAX_BYTES = 65_536;

/**
 * Most reads one run's report carries. The run state keeps every one; a
 * report that would carry more says how many it left out (`readsOmitted`).
 */
export const HARNESS_CFC_MODEL_CONTEXT_REPORT_READS_LIMIT = 1_024;

export interface HarnessCfcModelContextObservation {
  type: "cf-harness.cfc-model-context-observation";
  sequence: number;
  at: string;
  toolCallId: string;
  toolId: string;
  outputId: ToolOutputId;
  channels: readonly HarnessCfcModelContextChannel[];
  policy: "observed";

  /** The output's confidentiality; `{confidentiality: []}` for a public one. */
  label: IFCLabel;
  truncated?: boolean;

  /**
   * The reads the host declared the output made, in its order: `[]` when it
   * declared it read nothing, and absent when it made no declaration, which
   * says nothing about what it read.
   */
  reads?: readonly HarnessCfcModelContextRead[];
}

export interface HarnessCfcModelContextObservationInput {
  toolCallId: string;
  toolId: string;
  outputId: ToolOutputId;
  channels: readonly HarnessCfcModelContextChannel[];
  label: IFCLabel;
  truncated?: boolean;
  reads?: readonly HarnessCfcModelContextRead[];
}

/**
 * The record of what entered the model through tool outputs: one observation
 * per output that reached it under a confidentiality label or that declares
 * the reads it made, whatever its label, and the running join of their
 * confidentiality as `label`. An output with no confidentiality that declares
 * no reads leaves no observation. A host that declares its reads makes this
 * the record of what the model was shown of the person's data, which a host
 * builds its receipts from (`harnessCfcModelContextReads`).
 *
 * Sensitive retained run metadata. Even without raw stdout/stderr bytes, these
 * labels, observation refs, and reads can reveal which confidential sources
 * influenced model-visible context, so treat this at least like transcript
 * metadata.
 */
export interface HarnessCfcModelContext {
  type: "cf-harness.cfc-model-context";
  version: 1;
  updatedAt: string;
  label: IFCLabel;
  observations: readonly HarnessCfcModelContextObservation[];
}

const cloneJsonValue = <T>(value: T): T => structuredClone(value);

export const cloneIfcLabel = (label: IFCLabel): IFCLabel => {
  const cloned: IFCLabel = {};
  if (
    Array.isArray(label.confidentiality) &&
    label.confidentiality.length > 0
  ) {
    cloned.confidentiality = cloneJsonValue(label.confidentiality);
  }
  if (Array.isArray(label.integrity) && label.integrity.length > 0) {
    cloned.integrity = cloneJsonValue(label.integrity);
  }
  return cloned;
};

export const confidentialityOnlyIfcLabel = (
  label: IFCLabel,
): IFCLabel | undefined => {
  if (
    !Array.isArray(label.confidentiality) ||
    label.confidentiality.length === 0
  ) {
    return undefined;
  }
  return { confidentiality: cloneJsonValue(label.confidentiality) };
};

export const mergeConfidentialityOnlyLabels = (
  labels: readonly (IFCLabel | undefined)[],
): IFCLabel | undefined => {
  const confidentiality: CfcConfClause[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const confidentialityOnly = label === undefined
      ? undefined
      : confidentialityOnlyIfcLabel(label);
    for (const value of confidentialityOnly?.confidentiality ?? []) {
      const key = JSON.stringify(value);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      confidentiality.push(cloneJsonValue(value) as CfcConfClause);
    }
  }
  return confidentiality.length > 0 ? { confidentiality } : undefined;
};

/**
 * The observation `input` records, or `undefined` when it reached the model
 * through no channel, or carried no confidentiality and declares no read.
 * Reads past {@link HARNESS_CFC_MODEL_CONTEXT_READS_LIMIT} are refused: the
 * tool that made the output bounds them before the model sees it.
 */
export const createHarnessCfcModelContextObservation = (
  input: HarnessCfcModelContextObservationInput & {
    sequence: number;
    at: string;
  },
): HarnessCfcModelContextObservation | undefined => {
  const label = confidentialityOnlyIfcLabel(input.label);
  const { reads } = input;
  if (
    input.channels.length === 0 ||
    (label === undefined && (reads === undefined || reads.length === 0))
  ) {
    return undefined;
  }
  if (
    reads !== undefined && reads.length > HARNESS_CFC_MODEL_CONTEXT_READS_LIMIT
  ) {
    throw new RangeError(
      `An observation records at most ${HARNESS_CFC_MODEL_CONTEXT_READS_LIMIT} reads; ${input.toolId} declared ${reads.length}.`,
    );
  }
  return {
    type: "cf-harness.cfc-model-context-observation",
    sequence: input.sequence,
    at: input.at,
    toolCallId: input.toolCallId,
    toolId: input.toolId,
    outputId: input.outputId,
    channels: [...input.channels],
    policy: "observed",
    label: label ?? { confidentiality: [] },
    ...(input.truncated === true ? { truncated: true } : {}),
    ...(reads !== undefined ? { reads: cloneJsonValue(reads) } : {}),
  };
};

/** One observation that declares reads, as a run's report carries it. */
export interface HarnessCfcModelContextReadsEntry {
  sequence: number;
  toolCallId: string;
  outputId: ToolOutputId;
  label: IFCLabel;
  reads: readonly HarnessCfcModelContextRead[];
}

/** The reads one run's report carries, and how many it left out. */
export interface HarnessCfcModelContextReportReads {
  reads: HarnessCfcModelContextReadsEntry[];

  /** Reads this run declared past the report's bound; absent when none. */
  readsOmitted?: number;
}

/**
 * The reads a run made, as its report carries them: each observation of
 * `context` that declares at least one read and records an output among
 * `outputs`, the run's own, in sequence order, with its sequence, tool call,
 * output, label, and reads. A continued run's context holds its
 * predecessors' observations too, and their outputs are not this run's, so
 * the report is the run's own. Observations are taken whole while their
 * reads fit {@link HARNESS_CFC_MODEL_CONTEXT_REPORT_READS_LIMIT}; the reads
 * of the first one that does not, and of every one after it, are counted in
 * `readsOmitted`, so the list is always a prefix of the run's reads. Empty
 * for a run that declared none.
 */
export const harnessCfcModelContextReads = (
  context: HarnessCfcModelContext | undefined,
  outputs: readonly { outputId: string }[],
): HarnessCfcModelContextReportReads => {
  const own = new Set(outputs.map((output) => output.outputId));
  const reads: HarnessCfcModelContextReadsEntry[] = [];
  let carried = 0;
  let omitted = 0;
  for (const observation of context?.observations ?? []) {
    const declared = observation.reads ?? [];
    if (declared.length === 0 || !own.has(observation.outputId)) continue;
    if (
      omitted > 0 ||
      carried + declared.length > HARNESS_CFC_MODEL_CONTEXT_REPORT_READS_LIMIT
    ) {
      omitted += declared.length;
      continue;
    }
    carried += declared.length;
    reads.push({
      sequence: observation.sequence,
      toolCallId: observation.toolCallId,
      outputId: observation.outputId,
      label: cloneJsonValue(observation.label),
      reads: cloneJsonValue(declared),
    });
  }
  return omitted > 0 ? { reads, readsOmitted: omitted } : { reads };
};

export const appendHarnessCfcModelContextObservations = (
  context: HarnessCfcModelContext | undefined,
  inputs: readonly HarnessCfcModelContextObservationInput[],
  at: string,
): HarnessCfcModelContext | undefined => {
  if (inputs.length === 0) {
    return context;
  }
  const existingObservations = [...(context?.observations ?? [])];
  const newObservations: HarnessCfcModelContextObservation[] = [];
  for (const input of inputs) {
    const observation = createHarnessCfcModelContextObservation({
      ...input,
      sequence: existingObservations.length + newObservations.length + 1,
      at,
    });
    if (observation !== undefined) {
      newObservations.push(observation);
    }
  }
  if (newObservations.length === 0) {
    return context;
  }
  const label = withoutConfidentialityPromptSlotInfluence(
    mergeConfidentialityOnlyLabels([
      context?.label,
      ...newObservations.map((observation) => observation.label),
    ]),
  );
  // An observation that declares a read is kept whatever its label; one that
  // declares none and whose only confidentiality was prompt-slot influence
  // is not.
  if (
    label === undefined &&
    !newObservations.some((observation) => (observation.reads?.length ?? 0) > 0)
  ) {
    return context;
  }
  return {
    type: "cf-harness.cfc-model-context",
    version: 1,
    updatedAt: at,
    label: label ?? { confidentiality: [] },
    observations: [...existingObservations, ...newObservations],
  };
};

const isPromptSlotInfluenceAtom = (atom: unknown): boolean =>
  isObjectNotArray(atom) &&
  (atom as { type?: unknown }).type === CFC_ATOM_TYPE.PromptSlotInfluence;

/**
 * `clause` without any `PromptSlotInfluence` atom, or `undefined` when nothing
 * else was in it. Dropping an alternative of an OR-clause leaves the clause
 * admitting fewer readers, never more.
 */
const withoutPromptSlotInfluenceClause = (
  clause: CfcConfClause,
): CfcConfClause | undefined => {
  if (!isOrClause(clause)) {
    return isPromptSlotInfluenceAtom(clause) ? undefined : clause;
  }
  const anyOf = clause.anyOf.filter((atom) => !isPromptSlotInfluenceAtom(atom));
  return anyOf.length === 0 ? undefined : normalizeClause({ anyOf });
};

/**
 * Removes `PromptSlotInfluence` atoms from a confidentiality label, bare or
 * inside an OR-clause. The atom is integrity (CFC spec §15.4), so one in a
 * confidentiality position marks nothing secret. Retained run state can still
 * hold one there, and left in place it would taint every input the model
 * context is stamped on.
 */
const withoutConfidentialityPromptSlotInfluence = (
  label: IFCLabel | undefined,
): IFCLabel | undefined => {
  // TODO(seefeldb): Remove once no run whose saved model context holds the
  // atom as confidentiality can still be resumed.
  const confidentiality = (label?.confidentiality ?? []).flatMap((clause) => {
    const kept = withoutPromptSlotInfluenceClause(clause);
    return kept === undefined ? [] : [kept];
  });
  return confidentiality.length === 0 ? undefined : { confidentiality };
};

export const createHarnessCfcModelContextInputLabels = (options: {
  modelContext?: HarnessCfcModelContext;
  paths?: readonly HarnessCfcInvocationInputLabelPath[];
}): CfcLabelView | undefined => {
  if (
    options.modelContext === undefined ||
    options.paths === undefined ||
    options.paths.length === 0
  ) {
    return undefined;
  }
  const label = withoutConfidentialityPromptSlotInfluence(
    confidentialityOnlyIfcLabel(options.modelContext.label),
  );
  if (label === undefined) {
    return undefined;
  }
  return {
    version: 1,
    entries: options.paths.map((path) => ({
      path: [...path],
      label: cloneIfcLabel(label),
    })),
  };
};
