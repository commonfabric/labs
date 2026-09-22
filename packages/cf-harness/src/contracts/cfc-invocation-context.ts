import {
  CFC_ATOM_TYPE,
  type CfcPromptSlotInfluenceAtom,
} from "@commonfabric/api/cfc";
import type {
  CfcConfClause,
  CfcEnforcementMode,
  CfcLabelView,
  CfcReadOnExceed,
} from "@commonfabric/runner/cfc";
import { mergeCfcLabelViews } from "@commonfabric/runner/cfc";
import {
  createHarnessCfcModelContextInputLabels,
  type HarnessCfcModelContext,
} from "./cfc-model-context.ts";
import type { PromptSlotBinding, PromptSlotRole } from "./prompt-slot.ts";
import type { HarnessRunManifest } from "./run-manifest.ts";
import type { BuiltinToolId } from "./tool-descriptor.ts";
import type { ToolOutputId } from "./tool-result.ts";

export type HarnessCfcInvocationOperation = "command" | "shell";
export type HarnessCfcInvocationInputLabelRoot =
  | "command"
  | "argv"
  | "args"
  | "env"
  | "cwd"
  | "stdin";
export type HarnessCfcInvocationInputLabelPath = readonly [
  HarnessCfcInvocationInputLabelRoot,
  ...string[],
];

export const CF_HARNESS_PROMPT_SLOT_INFLUENCE_ATOM_TYPE =
  CFC_ATOM_TYPE.PromptSlotInfluence;

export type HarnessPromptSlotInfluenceAtom = CfcPromptSlotInfluenceAtom<
  PromptSlotRole
>;

export interface HarnessCfcRedactedTextSummary {
  type: "cf-harness.redacted-text-summary";
  bytes: number;
  digest: string;
}

export interface HarnessCfcRedactedSequenceSummary {
  type: "cf-harness.redacted-sequence-summary";
  count: number;
  totalBytes: number;
  digest: string;
}

export interface HarnessCfcEnvSummary {
  type: "cf-harness.env-summary";
  count: number;
  names: readonly string[];
}

export interface HarnessCfcInvocationInputSummary {
  command?: HarnessCfcRedactedTextSummary;
  argv?: HarnessCfcRedactedSequenceSummary;
  args?: HarnessCfcRedactedSequenceSummary;
  stdin?: HarnessCfcRedactedTextSummary;
  env?: HarnessCfcEnvSummary;
}

export interface HarnessCfcInvocationRunManifestSummary {
  present: boolean;
  path?: string;
  source?: string;
  wishId?: string;
  dispatchClass?: string;
  cfcEnforcementMode?: CfcEnforcementMode;

  /** The read ceiling the manifest declared for the run's fabric session. */
  cfcReadMaxConfidentiality?: readonly CfcConfClause[];

  /** Its `onExceed`, when the manifest declared one. */
  cfcReadOnExceed?: CfcReadOnExceed;

  promptSlotPresent?: boolean;
}

export interface HarnessCfcInvocationContext {
  type: "cf-harness.cfc-invocation-context";
  version: 1;
  sequence: number;
  runId: string;
  createdAt: string;
  toolId: BuiltinToolId | string;
  toolOutputId?: ToolOutputId;
  operation: HarnessCfcInvocationOperation;
  cfcEnforcementMode: CfcEnforcementMode;
  cwd: string;
  promptSlot?: PromptSlotBinding;
  runManifest: HarnessCfcInvocationRunManifestSummary;
  inputs: HarnessCfcInvocationInputSummary;

  /**
   * Confidentiality labels on the invocation's startup inputs. The sandbox
   * seeds the process taint from these, and refuses a view carrying
   * integrity claims.
   */
  cfcInputLabels?: CfcLabelView;

  /**
   * Integrity labels recording which inputs the run's prompt slot shaped, one
   * `PromptSlotInfluence` atom per path. They are provenance for influence
   * accounting, not taint, and so stay out of `cfcInputLabels`.
   */
  promptSlotInfluenceLabels?: CfcLabelView;
}

export interface CreateHarnessCfcInvocationContextOptions {
  sequence: number;
  runId: string;
  createdAt: string;
  toolId: BuiltinToolId | string;
  toolOutputId?: ToolOutputId;
  operation: HarnessCfcInvocationOperation;
  cfcEnforcementMode: CfcEnforcementMode;
  cwd: string;
  promptSlot?: PromptSlotBinding;
  runManifest: HarnessCfcInvocationRunManifestSummary;
  command?: string;
  argv?: readonly string[];
  args?: readonly string[];
  stdinText?: string;
  env?: Record<string, string>;
  cfcInputLabels?: CfcLabelView;
  cfcInputLabelPaths?: readonly HarnessCfcInvocationInputLabelPath[];
  cfcPromptSlotInputLabelPaths?: readonly HarnessCfcInvocationInputLabelPath[];
  cfcModelContextInputLabelPaths?:
    readonly HarnessCfcInvocationInputLabelPath[];
  cfcModelContext?: HarnessCfcModelContext;
}

const textEncoder = new TextEncoder();

const bytesForText = (text: string): Uint8Array => textEncoder.encode(text);

const sha256Digest = async (input: Uint8Array): Promise<string> => {
  const digestInput = input.buffer.slice(
    input.byteOffset,
    input.byteOffset + input.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
};

export const summarizeCfcInvocationText = async (
  text: string,
): Promise<HarnessCfcRedactedTextSummary> => {
  const bytes = bytesForText(text);
  return {
    type: "cf-harness.redacted-text-summary",
    bytes: bytes.byteLength,
    digest: await sha256Digest(bytes),
  };
};

export const summarizeCfcInvocationSequence = async (
  values: readonly string[],
): Promise<HarnessCfcRedactedSequenceSummary> => {
  const totalBytes = values.reduce(
    (total, value) => total + bytesForText(value).byteLength,
    0,
  );
  return {
    type: "cf-harness.redacted-sequence-summary",
    count: values.length,
    totalBytes,
    digest: await sha256Digest(bytesForText(JSON.stringify(values))),
  };
};

export const summarizeCfcInvocationEnv = (
  env: Record<string, string> | undefined,
): HarnessCfcEnvSummary | undefined => {
  if (env === undefined) {
    return undefined;
  }
  return {
    type: "cf-harness.env-summary",
    count: Object.keys(env).length,
    names: Object.keys(env).sort(),
  };
};

export const summarizeCfcInvocationRunManifest = (
  manifest: HarnessRunManifest | undefined,
  path: string | undefined,
): HarnessCfcInvocationRunManifestSummary => ({
  present: manifest !== undefined || path !== undefined,
  ...(path !== undefined ? { path } : {}),
  ...(manifest !== undefined
    ? {
      source: manifest.source,
      ...(manifest.wishId !== undefined ? { wishId: manifest.wishId } : {}),
      ...(manifest.dispatchClass !== undefined
        ? { dispatchClass: manifest.dispatchClass }
        : {}),
      ...(manifest.cfc?.enforcementMode !== undefined
        ? { cfcEnforcementMode: manifest.cfc.enforcementMode }
        : {}),
      ...(manifest.cfc?.maxConfidentiality !== undefined
        ? { cfcReadMaxConfidentiality: manifest.cfc.maxConfidentiality }
        : {}),
      ...(manifest.cfc?.onExceed !== undefined
        ? { cfcReadOnExceed: manifest.cfc.onExceed }
        : {}),
      promptSlotPresent: manifest.promptSlot !== undefined,
    }
    : {}),
});

const createPromptSlotInfluenceAtom = (
  promptSlot: PromptSlotBinding,
  runManifest: HarnessCfcInvocationRunManifestSummary,
): HarnessPromptSlotInfluenceAtom => ({
  type: CF_HARNESS_PROMPT_SLOT_INFLUENCE_ATOM_TYPE,
  version: 1,
  role: promptSlot.role,
  kernelName: promptSlot.kernelName,
  surface: promptSlot.surface,
  ...(promptSlot.subject !== undefined ? { subject: promptSlot.subject } : {}),
  ...(promptSlot.eventId !== undefined ? { eventId: promptSlot.eventId } : {}),
  ...(promptSlot.valueDigest !== undefined
    ? { valueDigest: promptSlot.valueDigest }
    : {}),
  ...(promptSlot.slotDigest !== undefined
    ? { slotDigest: promptSlot.slotDigest }
    : {}),
  ...(promptSlot.snapshotDigest !== undefined
    ? { snapshotDigest: promptSlot.snapshotDigest }
    : {}),
  ...(promptSlot.targetPath !== undefined
    ? { targetPath: promptSlot.targetPath }
    : {}),
  ...(runManifest.source !== undefined ||
      runManifest.wishId !== undefined ||
      runManifest.dispatchClass !== undefined
    ? {
      runManifest: {
        ...(runManifest.source !== undefined
          ? { source: runManifest.source }
          : {}),
        ...(runManifest.wishId !== undefined
          ? { wishId: runManifest.wishId }
          : {}),
        ...(runManifest.dispatchClass !== undefined
          ? { dispatchClass: runManifest.dispatchClass }
          : {}),
      },
    }
    : {}),
});

/**
 * Labels each of `paths` with a `PromptSlotInfluence` integrity atom minted
 * from the run's prompt-slot binding, per the atom registry's integrity kind
 * (CFC spec §15.4). Returns `undefined` when there is no binding or no path.
 */
export const createHarnessPromptSlotInfluenceLabels = (options: {
  promptSlot?: PromptSlotBinding;
  runManifest: HarnessCfcInvocationRunManifestSummary;
  paths?: readonly HarnessCfcInvocationInputLabelPath[];
}): CfcLabelView | undefined => {
  if (options.promptSlot === undefined || options.paths === undefined) {
    return undefined;
  }
  if (options.paths.length === 0) {
    return undefined;
  }
  const atom = createPromptSlotInfluenceAtom(
    options.promptSlot,
    options.runManifest,
  );
  return {
    version: 1,
    entries: options.paths.map((path) => ({
      path: [...path],
      label: { integrity: [atom] },
    })),
  };
};

export const createHarnessCfcInvocationContext = async (
  options: CreateHarnessCfcInvocationContextOptions,
): Promise<HarnessCfcInvocationContext> => {
  const command = options.command === undefined
    ? undefined
    : await summarizeCfcInvocationText(options.command);
  const argv = options.argv === undefined
    ? undefined
    : await summarizeCfcInvocationSequence(options.argv);
  const args = options.args === undefined
    ? undefined
    : await summarizeCfcInvocationSequence(options.args);
  const stdin = options.stdinText === undefined
    ? undefined
    : await summarizeCfcInvocationText(options.stdinText);
  const env = summarizeCfcInvocationEnv(options.env);
  const promptSlotInputLabelPaths = options.cfcPromptSlotInputLabelPaths ??
    options.cfcInputLabelPaths;
  const modelContextInputLabelPaths = options.cfcModelContextInputLabelPaths ??
    options.cfcInputLabelPaths;
  const cfcInputLabels = mergeCfcLabelViews([
    options.cfcInputLabels,
    createHarnessCfcModelContextInputLabels({
      modelContext: options.cfcModelContext,
      paths: modelContextInputLabelPaths,
    }),
  ]);
  const promptSlotInfluenceLabels = createHarnessPromptSlotInfluenceLabels({
    promptSlot: options.promptSlot,
    runManifest: options.runManifest,
    paths: promptSlotInputLabelPaths,
  });

  return {
    type: "cf-harness.cfc-invocation-context",
    version: 1,
    sequence: options.sequence,
    runId: options.runId,
    createdAt: options.createdAt,
    toolId: options.toolId,
    ...(options.toolOutputId !== undefined
      ? { toolOutputId: options.toolOutputId }
      : {}),
    operation: options.operation,
    cfcEnforcementMode: options.cfcEnforcementMode,
    cwd: options.cwd,
    ...(options.promptSlot !== undefined
      ? { promptSlot: options.promptSlot }
      : {}),
    runManifest: options.runManifest,
    inputs: {
      ...(command !== undefined ? { command } : {}),
      ...(argv !== undefined ? { argv } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(stdin !== undefined ? { stdin } : {}),
      ...(env !== undefined ? { env } : {}),
    },
    ...(cfcInputLabels !== undefined ? { cfcInputLabels } : {}),
    ...(promptSlotInfluenceLabels !== undefined
      ? { promptSlotInfluenceLabels }
      : {}),
  };
};
