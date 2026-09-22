import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type {
  CfcConfClause,
  CfcLabelView,
  IFCLabel,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { HarnessCfcInvocationInputLabelPath } from "./cfc-invocation-context.ts";
import type { ToolOutputId } from "./tool-result.ts";

export type HarnessCfcModelContextChannel =
  | "stdout"
  | "stderr"
  | "exitCode"
  | "output";

export interface HarnessCfcModelContextObservation {
  type: "cf-harness.cfc-model-context-observation";
  sequence: number;
  at: string;
  toolCallId: string;
  toolId: string;
  outputId: ToolOutputId;
  channels: readonly HarnessCfcModelContextChannel[];
  policy: "observed";
  label: IFCLabel;
  truncated?: boolean;
}

export interface HarnessCfcModelContextObservationInput {
  toolCallId: string;
  toolId: string;
  outputId: ToolOutputId;
  channels: readonly HarnessCfcModelContextChannel[];
  label: IFCLabel;
  truncated?: boolean;
}

/**
 * Sensitive retained run metadata. Even without raw stdout/stderr bytes, these
 * labels and observation refs can reveal which confidential sources influenced
 * model-visible context, so treat this at least like transcript metadata.
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

const labelValueKey = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
      const key = labelValueKey(value);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      confidentiality.push(cloneJsonValue(value) as CfcConfClause);
    }
  }
  return confidentiality.length > 0 ? { confidentiality } : undefined;
};

export const createHarnessCfcModelContextObservation = (
  input: HarnessCfcModelContextObservationInput & {
    sequence: number;
    at: string;
  },
): HarnessCfcModelContextObservation | undefined => {
  const label = confidentialityOnlyIfcLabel(input.label);
  if (label === undefined || input.channels.length === 0) {
    return undefined;
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
    label,
    ...(input.truncated === true ? { truncated: true } : {}),
  };
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
  const label = mergeConfidentialityOnlyLabels([
    context?.label,
    ...newObservations.map((observation) => observation.label),
  ]);
  if (label === undefined) {
    return context;
  }
  return {
    type: "cf-harness.cfc-model-context",
    version: 1,
    updatedAt: at,
    label,
    observations: [...existingObservations, ...newObservations],
  };
};

/**
 * Removes `PromptSlotInfluence` atoms from a confidentiality label. The atom
 * is integrity (CFC spec §15.4), so one in a confidentiality position marks
 * nothing secret. Retained run state can still hold one there, and left in
 * place it would taint every input the model context is stamped on.
 */
const withoutConfidentialityPromptSlotInfluence = (
  label: IFCLabel | undefined,
): IFCLabel | undefined => {
  // TODO(seefeldb): Remove once no retained run state holds the atom as
  // confidentiality.
  const confidentiality = label?.confidentiality?.filter((clause) =>
    !(isObjectNotArray(clause) && "type" in clause &&
      clause.type === CFC_ATOM_TYPE.PromptSlotInfluence)
  );
  return confidentiality === undefined || confidentiality.length === 0
    ? undefined
    : { confidentiality };
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
