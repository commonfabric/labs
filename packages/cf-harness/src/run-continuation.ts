/** Builds separate root runs from retained history and explicitly classified state. */
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  SEPARATOR,
} from "@std/path";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import type { CfHarnessStructuredResultConfig } from "./contracts/structured-result.ts";
import type { PromptSlotBinding } from "./contracts/prompt-slot.ts";
import type { BuiltinToolId } from "./contracts/tool-descriptor.ts";
import type { HarnessImageAttachment } from "./contracts/image.ts";
import {
  type HarnessTranscriptMessage,
  inspectHarnessTranscriptPairing,
} from "./contracts/transcript.ts";
import { assertInputCellNamesAvailable } from "./input-cells.ts";
import type { HarnessInputCellSpec } from "./contracts/input-cells.ts";
import { snapshotHarnessImageAttachment } from "./image-attachments.ts";
import { assertValidHarnessHandleTable } from "./handle-table.ts";
import { harnessResumeRefusal } from "./control-errors.ts";
import { recordedSandboxRuntime } from "./sandbox/runtime-selection.ts";
import { selectResearchContext } from "./research/context.ts";
import { createHarnessRunState, type HarnessRunState } from "./run-state.ts";
import {
  HARNESS_CHAT_INTERRUPTED_TURN_NOTICE,
  tableForNextTurn,
} from "./turn-history.ts";

/** Whether a binding authorizes one exact prompt value. */
export const isDigestBoundPromptSlot = (
  binding: PromptSlotBinding | undefined,
): boolean =>
  binding?.valueDigest !== undefined || binding?.slotDigest !== undefined ||
  binding?.snapshotDigest !== undefined;

/** The refusal for a child presented as a root source, on either recorded-run path. */
const rootSourceRefusal = (
  runState: HarnessRunState,
  mode: "resume" | "continue",
): Error | undefined =>
  runState.lineage?.role === "subagent"
    ? harnessResumeRefusal(
      `Cannot ${mode} subagent run ${runState.runId} as a top-level run; ${mode} root run ${runState.lineage.rootRunId} instead.`,
    )
    : undefined;

/** Holds a recorded source to the root-run boundary. */
export const assertHarnessRootSource = (
  runState: HarnessRunState,
  mode: "resume" | "continue",
): void => {
  const refusal = rootSourceRefusal(runState, mode);
  if (refusal !== undefined) throw refusal;
};

/** Why a source cannot authorize a separate root task. */
const nextRunRefusal = (runState: HarnessRunState): Error | undefined => {
  if (isDigestBoundPromptSlot(runState.promptSlotBinding)) {
    return new Error(
      "`--continue-run` cannot continue a digest-bound prompt-slot binding: " +
        "`valueDigest`, `slotDigest`, and `snapshotDigest` bind one exact prompt value.",
    );
  }
  return rootSourceRefusal(runState, "continue");
};

/** Why a recorded run cannot be continued through the batch surface. */
const continuationRefusal = ({ runState, transcript = [] }: {
  runState: HarnessRunState;
  transcript?: readonly HarnessTranscriptMessage[];
}): Error | undefined => {
  const refusal = nextRunRefusal(runState);
  if (refusal !== undefined) return refusal;
  if (runState.systemPromptInputs === undefined) {
    return new Error(
      `continue run ${runState.runId} has no recorded system-prompt inputs`,
    );
  }
  const boundary = inspectHarnessTranscriptPairing(transcript).safeBoundary;
  if (
    !transcript.slice(0, boundary).some((message) =>
      message.role === "assistant" || message.role === "tool"
    )
  ) {
    return new Error(
      `continue run ${runState.runId} has no complete checkpoint`,
    );
  }
};

/** Whether recorded artifacts can start another batch task. */
export const canContinueHarnessRun = (artifacts: {
  runState: HarnessRunState;
  transcript?: readonly HarnessTranscriptMessage[];
}): boolean => continuationRefusal(artifacts) === undefined;

const carriedContext = {
  kind: "carried",
  reason: "Continuation authority and durable context.",
} as const;

const sourceRunEvidence = {
  kind: "excluded",
  reason: "Evidence and artifact paths belong to the source run.",
} as const;

/** Classification and reason for every field at the new-root boundary. */
export const NEXT_RUN_STATE_FIELDS = {
  runId: { kind: "re-derived", reason: "Fresh root identity." },
  status: { kind: "re-derived", reason: "The new run starts pending." },
  createdAt: { kind: "re-derived", reason: "New lifecycle clock." },
  updatedAt: { kind: "re-derived", reason: "New lifecycle clock." },
  endedAt: sourceRunEvidence,
  terminalReason: sourceRunEvidence,
  cancelReason: sourceRunEvidence,
  cfcEnforcementMode: carriedContext,
  sandboxRuntime: {
    kind: "re-derived",
    reason: "Validated against supported recorded runtimes.",
  },
  sandboxRuntimeChoice: {
    kind: "excluded",
    reason: "The new engine records its own runtime selection.",
  },
  fabricSessionCfc: carriedContext,
  promptSlotBinding: carriedContext,
  currentDir: carriedContext,
  model: carriedContext,
  modelProvider: carriedContext,
  modelAuthSource: carriedContext,
  credentialOwnerKey: carriedContext,
  credentialOwner: carriedContext,
  harnessHomeIdentity: carriedContext,
  artifactRoot: { kind: "re-derived", reason: "New run owns its outputs." },
  pieceOutputRequired: {
    kind: "excluded",
    reason: "Re-derived by the new loop from its tools and result contract.",
  },
  systemPromptInputs: {
    kind: "carried",
    reason: "Recorded additional instructions supply the continuation default.",
  },
  structuredResult: {
    kind: "re-derived",
    reason: "Same schema with a fresh output path.",
  },
  runManifest: carriedContext,
  runManifestPath: sourceRunEvidence,
  skillRegistry: sourceRunEvidence,
  skillRegistryPath: sourceRunEvidence,
  skillActivations: sourceRunEvidence,
  skillActivationsPath: sourceRunEvidence,
  skillResourceReads: sourceRunEvidence,
  skillResourceReadsPath: sourceRunEvidence,
  skillScriptExecutions: sourceRunEvidence,
  skillScriptExecutionsPath: sourceRunEvidence,
  acquiredSkills: sourceRunEvidence,
  acquiredSkillsPath: sourceRunEvidence,
  transcriptPath: sourceRunEvidence,
  runReportPath: sourceRunEvidence,
  capabilitySnapshot: sourceRunEvidence,
  capabilitiesPath: sourceRunEvidence,
  cfcPolicySnapshot: carriedContext,
  cfcPolicySnapshotPath: sourceRunEvidence,
  policyTrace: sourceRunEvidence,
  policyTracePath: sourceRunEvidence,
  cfcModelContext: carriedContext,
  cfcInvocationContexts: carriedContext,
  cellLabels: carriedContext,
  cellLabelsPath: sourceRunEvidence,
  handleTable: {
    kind: "re-derived",
    reason: "Drops skill acquisitions and invalidated descriptions.",
  },
  docsCorpus: carriedContext,
  skillsRoot: {
    kind: "excluded",
    reason: "Re-established from the configured skills tree.",
  },
  wellKnownGrants: {
    kind: "excluded",
    reason: "Re-established against current session grants.",
  },
  inputCells: {
    kind: "carried",
    reason:
      "Retains attachment names and tokens across follow-ups for collision checks.",
  },
  assignedPieces: {
    kind: "carried",
    reason: "Named pieces remain targets for follow-up requests.",
  },
  patternRefs: sourceRunEvidence,
  policyEvents: { kind: "re-derived", reason: "Fresh run policy evidence." },
  policyDecisions: sourceRunEvidence,
  researchRuns: {
    kind: "re-derived",
    reason: "Latest orientation and two answers, marked historical.",
  },
  researchGoal: carriedContext,
  openingResearch: {
    kind: "excluded",
    reason: "The prior task already completed its opening handoff.",
  },
  taskClassification: carriedContext,
  researchFailures: sourceRunEvidence,
  docsQueryFailures: sourceRunEvidence,
  toolOutputs: {
    kind: "re-derived",
    reason: "Fresh run tool output identities.",
  },
  lineage: {
    kind: "re-derived",
    reason: "Names the predecessor and original root.",
  },
  subagentRuns: sourceRunEvidence,
  failureRecords: sourceRunEvidence,
  primaryFailure: sourceRunEvidence,
} as const satisfies Record<
  keyof HarnessRunState,
  { kind: "carried" | "re-derived" | "excluded"; reason: string }
>;

/** Context established against the new run, including any handles it minted. */
export interface HarnessNextRunContext {
  messages: readonly string[];
  runState?: HarnessRunState;
}

/** Inputs for a new root task; context setup receives its retained state. */
export interface PrepareNextHarnessRunOptions {
  runState: HarnessRunState;
  transcript?: readonly HarnessTranscriptMessage[];
  prompt?: string;
  imageAttachments?: readonly HarnessImageAttachment[];
  imageSnapshotDir?: string;
  inputCells?: readonly HarnessInputCellSpec[];

  /** Names retained by a session whose history spans multiple runs. */
  heldInputNames?: readonly string[];
  runId?: string;
  artifactRoot?: string;
  structuredResult?: HarnessRunState["structuredResult"];
  loomContext?: { loomId?: string };
  establishContext?: (
    state: HarnessRunState,
  ) => HarnessNextRunContext | Promise<HarnessNextRunContext>;
}

/** Attachment, assignment, and grant names already bound to held handles. */
export const inputNamesHeldByHarnessRun = (
  state: Pick<
    HarnessRunState,
    "inputCells" | "assignedPieces" | "wellKnownGrants"
  >,
): string[] => [
  ...(state.inputCells ?? []).map((cell) => cell.name),
  ...(state.assignedPieces ?? []).map((piece) => piece.slug),
  ...(state.wellKnownGrants ?? []).map((grant) => grant.name),
];

/**
 * Cuts history to its complete checkpoint, retains explicitly classified
 * state, and establishes the new task's local context before its input.
 */
export const prepareNextHarnessRun = async (
  options: PrepareNextHarnessRunOptions,
): Promise<{
  runState: HarnessRunState;
  transcript: HarnessTranscriptMessage[];
}> => {
  const prior = options.runState;
  const refusal = nextRunRefusal(prior);
  if (refusal !== undefined) throw refusal;
  if (prior.handleTable !== undefined) {
    assertValidHarnessHandleTable(prior.handleTable);
  }
  assertInputCellNamesAvailable(options.inputCells ?? [], [
    ...inputNamesHeldByHarnessRun(prior),
    ...(options.heldInputNames ?? []),
  ]);
  const source = options.transcript ?? [];
  const boundary = inspectHarnessTranscriptPairing(source).safeBoundary;
  const interrupted = boundary < source.length || prior.status !== "completed";
  const transcript = source.slice(0, boundary).filter((message) =>
    message.role !== "user" || !message.turnLocal
  );
  if (interrupted) {
    transcript.push({
      role: "user",
      content: HARNESS_CHAT_INTERRUPTED_TURN_NOTICE,
    });
  }
  const carried = Object.fromEntries(
    (Object.keys(NEXT_RUN_STATE_FIELDS) as (keyof HarnessRunState)[])
      .filter((key) =>
        NEXT_RUN_STATE_FIELDS[key].kind === "carried" &&
        prior[key] !== undefined
      )
      .map((key) => [key, structuredClone(prior[key])]),
  );
  const runState: HarnessRunState = {
    ...createHarnessRunState({
      currentDir: prior.currentDir,
      cfcEnforcementMode: prior.cfcEnforcementMode,
    }),
    ...carried,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.artifactRoot === undefined
      ? {}
      : { artifactRoot: options.artifactRoot }),
    lineage: {
      role: "continuation",
      rootRunId: prior.lineage?.rootRunId ?? prior.runId,
      parentRunId: prior.runId,
    },
    ...(options.structuredResult === undefined ? {} : {
      structuredResult: {
        schema: structuredClone(options.structuredResult.schema),
        path: options.structuredResult.path,
      },
    }),
    sandboxRuntime: recordedSandboxRuntime(prior, "continue"),
    ...(prior.researchRuns === undefined ? {} : {
      researchRuns: selectResearchContext(prior.researchRuns).map((run) => ({
        ...structuredClone(run),
        historical: true,
      })),
    }),
  };
  if (prior.handleTable !== undefined) {
    runState.handleTable = structuredClone(tableForNextTurn(prior.handleTable));
    if (boundary < source.length) {
      runState.handleTable.entries = runState.handleTable.entries.map((
        { described: _, ...entry },
      ) => entry);
    }
  }
  const context = await options.establishContext?.(runState) ??
    { messages: [] };
  if (options.loomContext !== undefined) {
    transcript.push({
      role: "user",
      turnLocal: true,
      content: options.loomContext.loomId === undefined
        ? "Host Loom context: this turn has no originating Loom. Use loom_authoring_context to recover historical receipts; history does not select a target or count as new work."
        : `Host Loom context: this turn originates in ${options.loomContext.loomId}. Inspect that exact target before extending it. A request to create a separate Loom still creates one. Historical receipts are not new work.`,
    });
  }
  for (const content of context.messages) {
    transcript.push({ role: "user", content, turnLocal: true });
  }
  const imageAttachments = await Promise.all(
    (options.imageAttachments ?? []).map((attachment) =>
      options.imageSnapshotDir === undefined
        ? attachment
        : snapshotHarnessImageAttachment(attachment, options.imageSnapshotDir)
    ),
  );
  if (options.prompt !== undefined) {
    transcript.push({
      role: "user",
      content: options.prompt,
      ...(imageAttachments.length ? { imageAttachments } : {}),
    });
  }
  return {
    runState: context.runState ?? runState,
    transcript,
  };
};

/** Validates batch continuation contracts and prepares its next root task. */
export const prepareHarnessContinuation = async (
  options: PrepareNextHarnessRunOptions & {
    prompt: string;
    artifactRoot: string;
    workspace: string;
    structuredResult?: CfHarnessStructuredResultConfig;
    schemaExplicit: boolean;
    allowedToolIds?: readonly BuiltinToolId[];
  },
): Promise<{
  runState: HarnessRunState;
  transcript: HarnessTranscriptMessage[];
  structuredResult?: CfHarnessStructuredResultConfig;
}> => {
  const prior = options.runState;
  const refusal = continuationRefusal(options);
  if (refusal !== undefined) throw refusal;
  const runId = crypto.randomUUID();
  const runRoot = join(options.artifactRoot, runId);
  const schema = options.schemaExplicit
    ? options.structuredResult?.schema
    : prior.structuredResult?.schema;
  if (
    prior.structuredResult !== undefined && options.schemaExplicit &&
    !deepEqual(prior.structuredResult.schema, schema)
  ) {
    throw new Error(
      "continued run structured-result schema does not match the recorded schema",
    );
  }
  let structuredResult: CfHarnessStructuredResultConfig | undefined;
  if (schema !== undefined) {
    const path = options.structuredResult?.path ?? join(runRoot, "result.json");
    structuredResult = {
      schema,
      path,
      sandboxPath: options.structuredResult?.sandboxPath ??
        join("/workspace", relative(options.workspace, path)),
    };
  } else if (options.structuredResult !== undefined) {
    throw new Error(
      "--structured-result-path requires a recorded or explicit schema",
    );
  }
  assertStructuredResultToolConfigured(
    options.allowedToolIds,
    structuredResult,
  );
  const next = await prepareNextHarnessRun({
    ...options,
    runId,
    artifactRoot: runRoot,
    imageSnapshotDir: join(runRoot, "image-attachments"),
    structuredResult,
  });
  return { ...next, structuredResult };
};

/** Canonicalizes an output even when its final components do not exist yet. */
export const resolveHostPathThroughNearestRealParent = (
  hostPath: string,
): string => {
  const suffix: string[] = [];
  let candidate = hostPath;
  while (true) {
    try {
      const realCandidate = Deno.realPathSync(candidate);
      return suffix.length === 0
        ? realCandidate
        : join(realCandidate, ...suffix);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return hostPath;
    }
    suffix.unshift(basename(candidate));
    candidate = parent;
  }
};

/** Whether a canonical path stays inside a canonical root. */
export const isHostPathWithinRoot = (root: string, path: string): boolean => {
  const relativePath = relative(root, path);
  return relativePath !== ".." && !relativePath.startsWith(`..${SEPARATOR}`) &&
    !isAbsolute(relativePath);
};

/** Refuses outward artifact links and returns the canonical run root. */
export const validateContinuationArtifacts = async (
  runRoot: string,
): Promise<string> => {
  const root = resolveHostPathThroughNearestRealParent(runRoot);
  const directories = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const path = resolveHostPathThroughNearestRealParent(entry);
    if (!isHostPathWithinRoot(root, path)) {
      throw harnessResumeRefusal(
        `cannot continue prior run: artifact entry \`${entry}\` links outside its run root`,
      );
    }
    const stat = await Deno.stat(path);
    if (!stat.isDirectory || directories.has(path)) continue;
    directories.add(path);
    for await (const child of Deno.readDir(path)) {
      pending.push(join(path, child.name));
    }
  }
  return root;
};

/** Refuses new outputs that could replace any predecessor artifact or result. */
export const assertContinuationOutputPaths = (
  root: string,
  prior: HarnessRunState,
  paths: readonly (string | undefined)[],
): void => {
  const priorResult = prior.structuredResult === undefined
    ? undefined
    : resolveHostPathThroughNearestRealParent(prior.structuredResult.path);
  if (
    paths.filter((path): path is string => path !== undefined).map(
      resolveHostPathThroughNearestRealParent,
    ).some((path) => isHostPathWithinRoot(root, path) || path === priorResult)
  ) {
    throw new Error(
      "continued run outputs must not modify the prior run's artifacts or result",
    );
  }
};

/** Requires the result contract whenever the caller explicitly offers submission. */
export const assertStructuredResultToolConfigured = (
  allowedToolIds: readonly BuiltinToolId[] | undefined,
  structuredResult: CfHarnessStructuredResultConfig | undefined,
): void => {
  if (
    allowedToolIds?.includes("submit_result") === true &&
    structuredResult === undefined
  ) {
    throw new Error(
      "--allow-tool submit_result requires --structured-result-path and a schema",
    );
  }
};
