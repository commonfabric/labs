import type {
  CfcConfClause,
  CfcEnforcementMode,
  CfcFlowLabelsMode,
  CfcPostureReport,
  CfcReadOnExceed,
} from "@commonfabric/runner/cfc";
import type { HarnessCfcInvocationContext } from "./contracts/cfc-invocation-context.ts";
import {
  appendHarnessCfcModelContextObservations as appendCfcModelContextObservations,
  type HarnessCfcModelContext,
  type HarnessCfcModelContextObservationInput,
} from "./contracts/cfc-model-context.ts";
import type { HarnessCellLabels } from "./contracts/cell-labels.ts";
import type { HarnessDocsCorpusRecord } from "./contracts/docs-corpus.ts";
import type { HarnessCfcPolicySnapshot } from "./contracts/cfc-policy-snapshot.ts";
import type { HarnessHandleTable } from "./contracts/handle-table.ts";
import type { HarnessWellKnownGrant } from "./contracts/well-known-grants.ts";
import type { HarnessInputCell } from "./contracts/input-cells.ts";
import type { HarnessAssignedPiece } from "./contracts/assigned-piece.ts";
import type { HarnessPatternRef } from "./contracts/pattern-refs.ts";
import type { HarnessResearchRunSummary } from "./contracts/research.ts";
import type { HarnessPolicyEvent } from "./contracts/policy.ts";
import type {
  HarnessPolicyDecisionRecord,
  HarnessPolicyTrace,
} from "./contracts/policy-trace.ts";
import type {
  HarnessCredentialOwnerRef,
  HarnessRunManifest,
} from "./contracts/run-manifest.ts";
import type { PromptSlotBinding } from "./contracts/prompt-slot.ts";
import type {
  HarnessAcquiredSkills,
  HarnessSkillActivations,
  HarnessSkillRegistry,
  HarnessSkillResourceReads,
  HarnessSkillScriptExecutions,
  HarnessSkillsRootRecord,
} from "./contracts/skill.ts";
import type {
  HarnessSubagentLineage,
  HarnessSubagentRunRef,
} from "./contracts/subagent.ts";
import type { ToolResultRef } from "./contracts/tool-result.ts";
import type {
  HarnessCapabilitySnapshot,
  HarnessFailureRecord,
} from "./diagnostics.ts";
import { selectPrimaryHarnessFailure } from "./diagnostics.ts";
import type {
  HarnessFabricCfcFlowLabelsSource,
  HarnessModelAuthSource,
  HarnessModelProviderId,
} from "./config.ts";

export type HarnessRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "canceled"
  | "failed";

/** Durable driver checkpoint for research before a root task's first turn. */
export interface HarnessOpeningResearch {
  type: "cf-harness.opening-research";
  version: 1;
  status: "pending" | "completed" | "failed";
  task: string;
  toolCallId: string;
  toolOutputIndex: number;
  outputId?: string;
  handoffMessage?: string;
}

/**
 * How a run ended. `assistant_completed` means the model returned a final
 * answer or an admitted task outcome. `budget_finalized` is a partial answer
 * produced on the reserved final root turn. `setup_error` is a run that died before
 * its first model turn, while what it holds — skill registry, grants, input
 * cells — was being established; the others end the loop itself.
 */
export type HarnessRunTerminalReason =
  | "assistant_completed"
  | "budget_finalized"
  | "max_model_turns"
  | "prompt_loop_error"
  | "setup_error"
  | "canceled"
  | "process_interrupted";

/** Whether `status` is one a run leaves only by being resumed. */
export const isTerminalHarnessRunStatus = (
  status: HarnessRunStatus,
): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

/**
 * The resolved CFC posture of the run's fabric session — the Runtime that
 * `run_pattern` deploys patterns into. This is a different dial from the
 * run-level `cfcEnforcementMode`, which governs tool policy and the sandbox;
 * the two are set independently, so the artifacts state both. Absent when the
 * run has no fabric session configuration — including when a test injects a
 * session factory directly, whose runtime's posture the harness never saw.
 */
export interface HarnessFabricSessionCfcPosture {
  /** The rung the session's runtime resolves to, from the whole ladder. */
  enforcementMode: CfcEnforcementMode;

  /** `configured` when the operator set the dial; `preset-pin` otherwise. */
  enforcementModeSource: "configured" | "preset-pin";

  /** The rung the session's runtime resolves to, from the whole ladder. */
  flowLabels: CfcFlowLabelsMode;

  /**
   * `configured` when the operator set the dial; `posture` when the named
   * bundle below supplied it; `default` otherwise.
   */
  flowLabelsSource: HarnessFabricCfcFlowLabelsSource;

  /**
   * The named CFC posture bundle the session's runtime opted into, when the
   * operator selected one (`--fabric-cfc-posture`). The bundle sets more
   * dials than the two this record itemizes — the full set is
   * `MAX_ENFORCEMENT_CFC_OPTIONS` in the runner's presets.
   */
  posture?: "max-enforcement";

  /**
   * The read ceiling the session's runtime bounds cell payload reads and every
   * `sqliteQuery` by:
   * the run manifest's, met with any the operator configured. Absent when
   * the session reads unbounded.
   */
  readMaxConfidentiality?: readonly CfcConfClause[];

  /** The ceiling's `onExceed` default, when one was configured. */
  readOnExceed?: CfcReadOnExceed;

  /**
   * Where the ceiling came from: the operator's session config, the run
   * manifest, or both met. Absent with the ceiling.
   */
  readMaxConfidentialitySource?: "session" | "run-manifest" | "both";

  /**
   * The session runtime's whole posture, as the shared record every surface
   * publishes (`cfc-posture.ts`). The itemized fields above are the dials an
   * operator or a run manifest sets and where each came from; this is what
   * the enforcement and flow-label dials, the named bundle, and the runtime's
   * own defaults resolve to — every dial, the policy digest, every known sink
   * governed or explicitly not, and every published deviation. The read
   * ceiling is not part of the record; the itemized fields carry it.
   *
   * Absent on a run recorded before the record existed. Such a run stays
   * frozen as history rather than being backfilled: the values would be this
   * checkout's resolution, not the run's.
   *
   * Absent too when a host supplied its own session factory. That factory
   * overrides the configuration this record is projected from, so the
   * configuration no longer describes the runtime that will execute, and a
   * record from it would assert a posture nothing honors. The exception is a
   * host that says whose session it handed over: a delegated child runs on
   * its parent's session, so it carries the parent's record stamped
   * `inherited` rather than none.
   */
  record?: CfcPostureReport;
}

export interface HarnessRunState {
  runId: string;
  status: HarnessRunStatus;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  terminalReason?: HarnessRunTerminalReason;

  /** Reason supplied by the run's controlling abort signal. */
  cancelReason?: string;

  cfcEnforcementMode: CfcEnforcementMode;
  fabricSessionCfc?: HarnessFabricSessionCfcPosture;
  promptSlotBinding?: PromptSlotBinding;
  currentDir: string;
  model?: string;
  modelProvider?: HarnessModelProviderId;
  modelAuthSource?: HarnessModelAuthSource;
  credentialOwnerKey?: string;
  credentialOwner?: HarnessCredentialOwnerRef;
  harnessHomeIdentity?: string;
  artifactRoot?: string;
  runManifest?: HarnessRunManifest;
  runManifestPath?: string;
  skillRegistry?: HarnessSkillRegistry;
  skillRegistryPath?: string;
  skillActivations?: HarnessSkillActivations;
  skillActivationsPath?: string;
  skillResourceReads?: HarnessSkillResourceReads;
  skillResourceReadsPath?: string;
  skillScriptExecutions?: HarnessSkillScriptExecutions;
  skillScriptExecutionsPath?: string;

  /**
   * The skills this run acquired scripts for, by pin, with where each script's
   * bytes sit and the digest taken at acquisition. A run that acquired none
   * has no record rather than an empty one.
   */
  acquiredSkills?: HarnessAcquiredSkills;

  acquiredSkillsPath?: string;
  transcriptPath?: string;
  runReportPath?: string;
  capabilitySnapshot?: HarnessCapabilitySnapshot;
  capabilitiesPath?: string;
  cfcPolicySnapshot?: HarnessCfcPolicySnapshot;
  cfcPolicySnapshotPath?: string;
  policyTrace?: HarnessPolicyTrace;
  policyTracePath?: string;
  cfcModelContext?: HarnessCfcModelContext;
  cfcInvocationContexts?: HarnessCfcInvocationContext[];

  /**
   * The per-cell CFC labels the run's space holds for the cells it touched.
   * Every other artifact a run writes is the run's own record of itself; this
   * one is read out of the space, and it is the only place a reader working
   * from the tree can learn what a cell is labelled.
   */
  cellLabels?: HarnessCellLabels;

  cellLabelsPath?: string;
  handleTable?: HarnessHandleTable;
  docsCorpus?: HarnessDocsCorpusRecord;
  skillsRoot?: HarnessSkillsRootRecord;
  wellKnownGrants?: HarnessWellKnownGrant[];
  inputCells?: HarnessInputCell[];

  /** Pieces successfully named by this run, retained for session follow-ups. */
  assignedPieces?: HarnessAssignedPiece[];

  patternRefs?: HarnessPatternRef[];
  policyEvents: HarnessPolicyEvent[];
  policyDecisions?: HarnessPolicyDecisionRecord[];

  /** Admitted research kits and host-confirmed records retained by this run. */
  researchRuns?: HarnessResearchRunSummary[];

  /** Current user goal carried into research and delegated work. */
  researchGoal?: string;

  /** Opening-research intent and recoverable model-context handoff. */
  openingResearch?: HarnessOpeningResearch;

  /**
   * How many `research` calls in this run and its descendants returned no kit.
   * An incomplete kit is still a successful answer and does not increment it.
   */
  researchFailures?: number;

  /**
   * Legacy failed documentation-query count retained for resumed runs. New
   * calls record {@link researchFailures}; this field remains readable so an
   * older run's operator evidence is not rewritten or dropped.
   */
  docsQueryFailures?: number;

  toolOutputs: ToolResultRef[];
  lineage?: HarnessSubagentLineage;
  subagentRuns?: HarnessSubagentRunRef[];
  failureRecords?: HarnessFailureRecord[];
  primaryFailure?: HarnessFailureRecord;
}

export interface CreateHarnessRunStateOptions {
  runId?: string;
  status?: HarnessRunStatus;
  endedAt?: string;
  terminalReason?: HarnessRunTerminalReason;

  /** Reason supplied by the run's controlling abort signal. */
  cancelReason?: string;

  cfcEnforcementMode: CfcEnforcementMode;
  fabricSessionCfc?: HarnessFabricSessionCfcPosture;
  promptSlotBinding?: PromptSlotBinding;
  currentDir: string;
  model?: string;
  modelProvider?: HarnessModelProviderId;
  modelAuthSource?: HarnessModelAuthSource;
  credentialOwnerKey?: string;
  credentialOwner?: HarnessCredentialOwnerRef;
  harnessHomeIdentity?: string;
  artifactRoot?: string;
  runManifest?: HarnessRunManifest;
  runManifestPath?: string;
  skillRegistry?: HarnessSkillRegistry;
  skillRegistryPath?: string;
  skillActivations?: HarnessSkillActivations;
  skillActivationsPath?: string;
  skillResourceReads?: HarnessSkillResourceReads;
  skillResourceReadsPath?: string;
  skillScriptExecutions?: HarnessSkillScriptExecutions;
  skillScriptExecutionsPath?: string;

  /**
   * The skills this run acquired scripts for, by pin, with where each script's
   * bytes sit and the digest taken at acquisition. A run that acquired none
   * has no record rather than an empty one.
   */
  acquiredSkills?: HarnessAcquiredSkills;

  acquiredSkillsPath?: string;
  transcriptPath?: string;
  runReportPath?: string;
  capabilitySnapshot?: HarnessCapabilitySnapshot;
  capabilitiesPath?: string;
  cfcPolicySnapshot?: HarnessCfcPolicySnapshot;
  cfcPolicySnapshotPath?: string;
  policyTrace?: HarnessPolicyTrace;
  policyTracePath?: string;
  cfcModelContext?: HarnessCfcModelContext;
  cfcInvocationContexts?: HarnessCfcInvocationContext[];
  cellLabels?: HarnessCellLabels;
  cellLabelsPath?: string;
  handleTable?: HarnessHandleTable;
  docsCorpus?: HarnessDocsCorpusRecord;
  skillsRoot?: HarnessSkillsRootRecord;
  wellKnownGrants?: HarnessWellKnownGrant[];
  inputCells?: HarnessInputCell[];
  assignedPieces?: HarnessAssignedPiece[];
  patternRefs?: HarnessPatternRef[];
  policyDecisions?: HarnessPolicyDecisionRecord[];
  researchRuns?: HarnessResearchRunSummary[];
  researchGoal?: string;
  openingResearch?: HarnessOpeningResearch;
  researchFailures?: number;
  docsQueryFailures?: number;
  lineage?: HarnessSubagentLineage;
  subagentRuns?: HarnessSubagentRunRef[];
  failureRecords?: HarnessFailureRecord[];
  primaryFailure?: HarnessFailureRecord;
  now?: string;
}

export const createHarnessRunState = (
  options: CreateHarnessRunStateOptions,
): HarnessRunState => {
  const now = options.now ?? new Date().toISOString();
  return {
    runId: options.runId ?? crypto.randomUUID(),
    status: options.status ?? "pending",
    createdAt: now,
    updatedAt: now,
    ...(options.endedAt !== undefined ? { endedAt: options.endedAt } : {}),
    ...(options.terminalReason !== undefined
      ? { terminalReason: options.terminalReason }
      : {}),
    ...(options.cancelReason !== undefined
      ? { cancelReason: options.cancelReason }
      : {}),
    cfcEnforcementMode: options.cfcEnforcementMode,
    ...(options.fabricSessionCfc !== undefined
      ? { fabricSessionCfc: options.fabricSessionCfc }
      : {}),
    ...(options.promptSlotBinding !== undefined
      ? { promptSlotBinding: options.promptSlotBinding }
      : {}),
    currentDir: options.currentDir,
    ...(options.model !== undefined ? { model: options.model } : {}),
    modelProvider: options.modelProvider ?? "openai-compatible-gateway",
    ...(options.modelAuthSource !== undefined
      ? { modelAuthSource: options.modelAuthSource }
      : {}),
    ...(options.credentialOwnerKey !== undefined
      ? { credentialOwnerKey: options.credentialOwnerKey }
      : {}),
    ...(options.credentialOwner !== undefined
      ? { credentialOwner: structuredClone(options.credentialOwner) }
      : {}),
    ...(options.harnessHomeIdentity !== undefined
      ? { harnessHomeIdentity: options.harnessHomeIdentity }
      : {}),
    ...(options.artifactRoot !== undefined
      ? { artifactRoot: options.artifactRoot }
      : {}),
    ...(options.runManifest !== undefined
      ? { runManifest: options.runManifest }
      : {}),
    ...(options.runManifestPath !== undefined
      ? { runManifestPath: options.runManifestPath }
      : {}),
    ...(options.skillRegistry !== undefined
      ? { skillRegistry: options.skillRegistry }
      : {}),
    ...(options.skillRegistryPath !== undefined
      ? { skillRegistryPath: options.skillRegistryPath }
      : {}),
    ...(options.skillActivations !== undefined
      ? { skillActivations: options.skillActivations }
      : {}),
    ...(options.skillActivationsPath !== undefined
      ? { skillActivationsPath: options.skillActivationsPath }
      : {}),
    ...(options.skillResourceReads !== undefined
      ? { skillResourceReads: options.skillResourceReads }
      : {}),
    ...(options.skillResourceReadsPath !== undefined
      ? { skillResourceReadsPath: options.skillResourceReadsPath }
      : {}),
    ...(options.skillScriptExecutions !== undefined
      ? { skillScriptExecutions: options.skillScriptExecutions }
      : {}),
    ...(options.skillScriptExecutionsPath !== undefined
      ? { skillScriptExecutionsPath: options.skillScriptExecutionsPath }
      : {}),
    ...(options.acquiredSkills !== undefined
      ? { acquiredSkills: structuredClone(options.acquiredSkills) }
      : {}),
    ...(options.acquiredSkillsPath !== undefined
      ? { acquiredSkillsPath: options.acquiredSkillsPath }
      : {}),
    ...(options.transcriptPath !== undefined
      ? { transcriptPath: options.transcriptPath }
      : {}),
    ...(options.runReportPath !== undefined
      ? { runReportPath: options.runReportPath }
      : {}),
    ...(options.capabilitySnapshot !== undefined
      ? { capabilitySnapshot: options.capabilitySnapshot }
      : {}),
    ...(options.capabilitiesPath !== undefined
      ? { capabilitiesPath: options.capabilitiesPath }
      : {}),
    ...(options.cfcPolicySnapshot !== undefined
      ? { cfcPolicySnapshot: options.cfcPolicySnapshot }
      : {}),
    ...(options.cfcPolicySnapshotPath !== undefined
      ? { cfcPolicySnapshotPath: options.cfcPolicySnapshotPath }
      : {}),
    ...(options.policyTrace !== undefined
      ? { policyTrace: options.policyTrace }
      : {}),
    ...(options.policyTracePath !== undefined
      ? { policyTracePath: options.policyTracePath }
      : {}),
    ...(options.cfcModelContext !== undefined
      ? { cfcModelContext: structuredClone(options.cfcModelContext) }
      : {}),
    ...(options.cfcInvocationContexts !== undefined
      ? { cfcInvocationContexts: [...options.cfcInvocationContexts] }
      : {}),
    ...(options.cellLabels !== undefined
      ? { cellLabels: structuredClone(options.cellLabels) }
      : {}),
    ...(options.cellLabelsPath !== undefined
      ? { cellLabelsPath: options.cellLabelsPath }
      : {}),
    ...(options.handleTable !== undefined
      ? { handleTable: structuredClone(options.handleTable) }
      : {}),
    ...(options.docsCorpus !== undefined
      ? { docsCorpus: structuredClone(options.docsCorpus) }
      : {}),
    ...(options.skillsRoot !== undefined
      ? { skillsRoot: structuredClone(options.skillsRoot) }
      : {}),
    ...(options.wellKnownGrants !== undefined
      ? { wellKnownGrants: structuredClone(options.wellKnownGrants) }
      : {}),
    ...(options.inputCells !== undefined
      ? { inputCells: structuredClone(options.inputCells) }
      : {}),
    ...(options.assignedPieces !== undefined
      ? { assignedPieces: structuredClone(options.assignedPieces) }
      : {}),
    ...(options.patternRefs !== undefined
      ? { patternRefs: structuredClone(options.patternRefs) }
      : {}),
    ...(options.lineage !== undefined
      ? { lineage: structuredClone(options.lineage) }
      : {}),
    policyEvents: [],
    ...(options.policyDecisions !== undefined
      ? { policyDecisions: [...options.policyDecisions] }
      : {}),
    ...(options.researchGoal === undefined
      ? {}
      : { researchGoal: options.researchGoal }),
    ...(options.researchRuns !== undefined
      ? { researchRuns: structuredClone(options.researchRuns) }
      : {}),
    ...(options.openingResearch !== undefined
      ? { openingResearch: structuredClone(options.openingResearch) }
      : {}),
    ...(options.researchFailures !== undefined
      ? { researchFailures: options.researchFailures }
      : {}),
    ...(options.docsQueryFailures !== undefined
      ? { docsQueryFailures: options.docsQueryFailures }
      : {}),
    toolOutputs: [],
    ...(options.subagentRuns !== undefined
      ? { subagentRuns: [...options.subagentRuns] }
      : {}),
    failureRecords: [...(options.failureRecords ?? [])],
    ...(options.primaryFailure !== undefined
      ? { primaryFailure: options.primaryFailure }
      : {}),
  };
};

// Applies an immutable update to a run state and stamps `updatedAt`. A key
// whose value is undefined is left out of the result instead of being written
// as an explicit undefined, so a caller can pass an optional artifact path
// through without testing it first.
export const patchHarnessRunState = (
  state: HarnessRunState,
  patch: Partial<HarnessRunState>,
  now = new Date().toISOString(),
): HarnessRunState => {
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  return Object.assign({ ...state }, defined, { updatedAt: now });
};

type HarnessRunStateListField = {
  [K in keyof HarnessRunState]-?: NonNullable<HarnessRunState[K]> extends
    readonly unknown[] ? K : never;
}[keyof HarnessRunState];

type HarnessRunStateListEntry<K extends HarnessRunStateListField> =
  NonNullable<HarnessRunState[K]> extends readonly (infer TEntry)[] ? TEntry
    : never;

// Appends one entry to a list-valued run state field, treating an absent list
// as empty.
export const appendToHarnessRunState = <K extends HarnessRunStateListField>(
  state: HarnessRunState,
  field: K,
  entry: HarnessRunStateListEntry<K>,
  now = new Date().toISOString(),
): HarnessRunState =>
  patchHarnessRunState(
    state,
    { [field]: [...(state[field] ?? []), entry] } as Partial<HarnessRunState>,
    now,
  );

/**
 * Moves a run to `status`. A terminal status stamps `endedAt` and
 * `terminalReason`; `running` clears both, which is how a resumed run
 * re-enters its loop. A run's outcome is written once, by its driver, so a
 * terminal status on a run that is already terminal is an invariant
 * violation and throws rather than overwriting the outcome on record.
 *
 * @throws Error when `status` is terminal and `state` already is.
 */
export const setHarnessRunStatus = (
  state: HarnessRunState,
  status: HarnessRunStatus,
  now = new Date().toISOString(),
  terminalReason?: HarnessRunTerminalReason,
): HarnessRunState => {
  if (isTerminalHarnessRunStatus(status)) {
    if (isTerminalHarnessRunStatus(state.status)) {
      throw new Error(
        `run ${state.runId} is already ${state.status}; its outcome is written once`,
      );
    }
    return patchHarnessRunState(
      state,
      { status, endedAt: now, terminalReason },
      now,
    );
  }
  const {
    endedAt: _endedAt,
    terminalReason: _terminalReason,
    cancelReason: _cancelReason,
    ...nonTerminal
  } = state;
  return patchHarnessRunState(nonTerminal, { status }, now);
};

export const appendHarnessCfcModelContextObservations = (
  state: HarnessRunState,
  observations: readonly HarnessCfcModelContextObservationInput[],
  now = new Date().toISOString(),
): HarnessRunState => {
  const cfcModelContext = appendCfcModelContextObservations(
    state.cfcModelContext,
    observations,
    now,
  );
  if (cfcModelContext === state.cfcModelContext) {
    return state;
  }
  return patchHarnessRunState(state, { cfcModelContext }, now);
};

export const setHarnessSubagentRun = (
  state: HarnessRunState,
  subagentRun: HarnessSubagentRunRef,
  now = new Date().toISOString(),
): HarnessRunState => {
  const existingIndex =
    state.subagentRuns?.findIndex((existing) =>
      existing.childRunId === subagentRun.childRunId
    ) ?? -1;
  const subagentRuns = [...(state.subagentRuns ?? [])];
  if (existingIndex >= 0) {
    subagentRuns[existingIndex] = subagentRun;
  } else {
    subagentRuns.push(subagentRun);
  }
  return patchHarnessRunState(state, { subagentRuns }, now);
};

/**
 * The run with `count` more legacy documentation-query failures against it.
 * Kept for resumed state and child rollup; new research failures use
 * {@link addHarnessResearchFailures}.
 */
export const addHarnessDocsQueryFailures = (
  state: HarnessRunState,
  count: number,
  now = new Date().toISOString(),
): HarnessRunState =>
  count <= 0 ? state : patchHarnessRunState(state, {
    docsQueryFailures: (state.docsQueryFailures ?? 0) + count,
  }, now);

/** Appends one host-admitted research kit and its confirmed records. */
export const appendHarnessResearchRun = (
  state: HarnessRunState,
  run: HarnessResearchRunSummary,
  now = new Date().toISOString(),
): HarnessRunState =>
  appendToHarnessRunState(state, "researchRuns", structuredClone(run), now);

/** Replaces the durable opening-research driver checkpoint. */
export const setHarnessOpeningResearch = (
  state: HarnessRunState,
  openingResearch: HarnessOpeningResearch,
  now = new Date().toISOString(),
): HarnessRunState =>
  patchHarnessRunState(
    state,
    { openingResearch: structuredClone(openingResearch) },
    now,
  );

/** Adds failed bounded research calls to the run-family summary. */
export const addHarnessResearchFailures = (
  state: HarnessRunState,
  count: number,
  now = new Date().toISOString(),
): HarnessRunState =>
  count <= 0 ? state : patchHarnessRunState(state, {
    researchFailures: (state.researchFailures ?? 0) + count,
  }, now);

export const appendHarnessFailureRecord = (
  state: HarnessRunState,
  failure: HarnessFailureRecord,
  now = new Date().toISOString(),
): HarnessRunState => {
  const failureRecords = [...(state.failureRecords ?? []), failure];
  return patchHarnessRunState(
    state,
    {
      failureRecords,
      primaryFailure: selectPrimaryHarnessFailure(failureRecords),
    },
    now,
  );
};
