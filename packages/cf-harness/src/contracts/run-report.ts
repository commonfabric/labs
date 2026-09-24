import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessCfcPolicySnapshot } from "./cfc-policy-snapshot.ts";
import type { HarnessFailureRecord } from "../diagnostics.ts";
import type { HarnessPolicyEvent, HarnessToolInputSummary } from "./policy.ts";
import type {
  HarnessPolicyDecisionCounts,
  HarnessPolicyDecisionRecord,
  HarnessPolicyTrace,
} from "./policy-trace.ts";
import { countHarnessPolicyDecisions } from "./policy-trace.ts";
import type { PromptSlotBinding } from "./prompt-slot.ts";
import type { HarnessFabricSessionCfcPosture } from "../run-state.ts";
import type { HarnessSubagentRunRef } from "./subagent.ts";
import type { HarnessTaskOutcome } from "./task-outcome.ts";
import type { HarnessToolEffectClass } from "./tool-descriptor.ts";
import type { HarnessTranscriptMessage } from "./transcript.ts";
import type { ToolResultRef } from "./tool-result.ts";
import type {
  HarnessModelAttemptDiagnostic,
  HarnessModelUsage,
} from "../model/client.ts";
import type {
  HarnessModelAuthSource,
  HarnessModelProviderId,
} from "../config.ts";
import type { HarnessCredentialOwnerRef } from "./run-manifest.ts";

/**
 * How policy answered one tool call. `invalid` is not one of policy's answers
 * about authority: it records a call whose arguments the loop could not read,
 * which never reached a policy question at all. It is kept in this union so
 * every tool activity carries an outcome, and told apart from `denied` so a
 * malformed call is not counted as a mediated refusal.
 *
 * `withheld` is a confidentiality boundary's answer about a call's own
 * result: the call ran, it answered with the reference to the result, and
 * only the values were held back. `denied` is reserved for a call that did
 * not run.
 */
export type HarnessToolPolicyDecision =
  | "allowed"
  | "warned"
  | "denied"
  | "invalid"
  | "withheld";

export type HarnessToolExecutionStatus =
  | "completed"
  | "failed"
  | "canceled"
  | "not-run";
export type HarnessToolInvocationOrigin = "model" | "opening-research";
export type HarnessRunTimelineKind =
  | "run_started"
  | "transcript_message"
  | "tool_activity"
  | "subagent_run"
  | "policy_event"
  | "failure_record"
  | "run_finished";

export interface HarnessToolActivity {
  type: "cf-harness.tool-activity";
  runId: string;
  sequence: number;
  startedAt: string;
  endedAt: string;
  toolCallId: string;
  toolId: string;

  /** Absent for legacy and model-authored calls; set for driver-authored calls. */
  origin?: HarnessToolInvocationOrigin;

  /** Absent when the call named a tool the run offers no descriptor for. */
  effectClass?: HarnessToolEffectClass;

  cfcEnforcementMode: CfcEnforcementMode;
  policyDecision: HarnessToolPolicyDecision;
  executionStatus: HarnessToolExecutionStatus;
  promptSlot?: PromptSlotBinding;
  toolInputSummary?: HarnessToolInputSummary;
  policyEventIndexes?: number[];
  resultRef?: ToolResultRef;
  errorDetail?: string;
}

export interface HarnessModelAttempt extends HarnessModelAttemptDiagnostic {
  runId: string;
  sequence: number;
  modelTurn: number;
}

export interface HarnessModelTurnUsage {
  modelTurn: number;
  usage: HarnessModelUsage;
}

export interface HarnessRunTimelineEntry {
  type: "cf-harness.timeline-entry";
  sequence: number;
  at: string;
  kind: HarnessRunTimelineKind;
  endedAt?: string;
  status?: string;
  terminalReason?: string;
  transcriptIndex?: number;
  role?: HarnessTranscriptMessage["role"];
  modelTurn?: number;
  toolCallIds?: string[];
  toolCallId?: string;
  toolId?: string;
  origin?: HarnessToolInvocationOrigin;
  toolActivitySequence?: number;
  policyDecision?: HarnessToolPolicyDecision;
  executionStatus?: HarnessToolExecutionStatus;
  policyEventIndex?: number;
  severity?: HarnessPolicyEvent["severity"];
  failureRecordIndex?: number;
  failureKind?: string;
  source?: string;
  childRunId?: string;
  subagentStatus?: string;
}

export type HarnessRunTimelineEntryInput = Omit<
  HarnessRunTimelineEntry,
  "type" | "sequence"
>;

export interface HarnessRunReport {
  type: "cf-harness.run-report";
  runId: string;
  generatedAt: string;
  status: string;
  model: string;

  /** Requested effort; provider clients reject routes that cannot apply it. */
  reasoningEffort?: string;

  /** Effort requested for the `research` tool's own model calls. */
  researchReasoningEffort?: string;

  promptCacheMode?: "implicit" | "explicit";
  cacheAffinity?: "run" | "custom";
  modelProvider?: HarnessModelProviderId;
  modelAuthSource?: HarnessModelAuthSource;
  credentialOwner?: HarnessCredentialOwnerRef;
  harnessHomeIdentity?: string;
  modelTurns: number;

  /** Usage from model turns executed directly by this run. */
  usage?: HarnessModelUsage;

  /** Direct usage plus reported research and descendant calls, even on failure. */
  totalUsage?: HarnessModelUsage;

  modelUsage?: HarnessModelTurnUsage[];
  cfcEnforcementMode: CfcEnforcementMode;

  /** The fabric session's resolved CFC posture, when the run had a session. */
  fabricSessionCfc?: HarnessFabricSessionCfcPosture;

  createdAt?: string;
  updatedAt?: string;
  endedAt?: string;
  terminalReason?: string;
  finalAssistantText?: string;

  /** Reason supplied by the run's controlling abort signal. */
  cancelReason?: string;

  /** User-facing disposition of a normally completed model loop. */
  taskOutcome?: HarnessTaskOutcome;

  artifactRoot?: string;
  transcriptPath?: string;
  promptSlotBinding?: PromptSlotBinding;
  cfcPolicySnapshot?: HarnessCfcPolicySnapshot;
  policyTrace?: HarnessPolicyTrace;
  policyTracePath?: string;
  primaryFailure?: HarnessFailureRecord;
  failureRecords?: HarnessFailureRecord[];
  policyEventCounts: {
    total: number;
    warnings: number;
    denied: number;
  };
  policyDecisionCounts: HarnessPolicyDecisionCounts;
  policyEvents: HarnessPolicyEvent[];
  policyDecisions: HarnessPolicyDecisionRecord[];
  timeline: HarnessRunTimelineEntry[];
  toolActivity: HarnessToolActivity[];
  modelAttempts?: HarnessModelAttempt[];
  toolOutputs: ToolResultRef[];
  subagentRuns?: HarnessSubagentRunRef[];
}

export interface CreateHarnessRunReportOptions {
  runState: {
    runId: string;
    status: string;
    createdAt?: string;
    updatedAt: string;
    endedAt?: string;
    terminalReason?: string;

    /** Reason supplied by the run's controlling abort signal. */
    cancelReason?: string;

    cfcEnforcementMode: CfcEnforcementMode;
    fabricSessionCfc?: HarnessFabricSessionCfcPosture;
    artifactRoot?: string;
    transcriptPath?: string;
    promptSlotBinding?: PromptSlotBinding;
    cfcPolicySnapshot?: HarnessCfcPolicySnapshot;
    policyTrace?: HarnessPolicyTrace;
    policyTracePath?: string;
    primaryFailure?: HarnessFailureRecord;
    failureRecords?: HarnessFailureRecord[];
    policyEvents: HarnessPolicyEvent[];
    policyDecisions?: HarnessPolicyDecisionRecord[];
    toolOutputs: ToolResultRef[];
    modelProvider?: HarnessModelProviderId;
    modelAuthSource?: HarnessModelAuthSource;
    credentialOwner?: HarnessCredentialOwnerRef;
    harnessHomeIdentity?: string;
    subagentRuns?: HarnessSubagentRunRef[];
  };
  model: string;
  reasoningEffort?: string;
  researchReasoningEffort?: string;
  promptCacheMode?: "implicit" | "explicit";
  cacheAffinity?: "run" | "custom";
  modelTurns: number;
  finalAssistantText?: string;

  /** User-facing disposition of a normally completed model loop. */
  taskOutcome?: HarnessTaskOutcome;

  timeline?: readonly HarnessRunTimelineEntryInput[];
  toolActivity: readonly HarnessToolActivity[];
  modelAttempts?: readonly HarnessModelAttempt[];
  usage?: HarnessModelUsage;
  totalUsage?: HarnessModelUsage;
  modelUsage?: readonly HarnessModelTurnUsage[];
}

export const createHarnessRunTimeline = (
  options: Pick<CreateHarnessRunReportOptions, "runState" | "toolActivity"> & {
    timeline?: readonly HarnessRunTimelineEntryInput[];
  },
): HarnessRunTimelineEntry[] => {
  let insertionOrder = 0;
  const entries: Array<HarnessRunTimelineEntryInput & { order: number }> = [];
  const push = (entry: HarnessRunTimelineEntryInput): void => {
    if (!entry.at) {
      return;
    }
    insertionOrder += 1;
    entries.push({ ...entry, order: insertionOrder });
  };

  if (options.runState.createdAt !== undefined) {
    push({
      kind: "run_started",
      at: options.runState.createdAt,
      status: "created",
    });
  }
  for (const entry of options.timeline ?? []) {
    push(entry);
  }
  for (const activity of options.toolActivity) {
    push({
      kind: "tool_activity",
      at: activity.startedAt,
      endedAt: activity.endedAt,
      toolActivitySequence: activity.sequence,
      toolCallId: activity.toolCallId,
      toolId: activity.toolId,
      ...(activity.origin !== undefined ? { origin: activity.origin } : {}),
      policyDecision: activity.policyDecision,
      executionStatus: activity.executionStatus,
    });
  }
  for (const subagentRun of options.runState.subagentRuns ?? []) {
    const childState = subagentRun.runState;
    push({
      kind: "subagent_run",
      at: childState?.endedAt ?? childState?.updatedAt ??
        subagentRun.manifest.createdAt,
      toolCallId: subagentRun.parentToolCallId,
      childRunId: subagentRun.childRunId,
      subagentStatus: subagentRun.status,
      status: childState?.status ?? subagentRun.status,
      terminalReason: childState?.terminalReason,
    });
  }
  for (
    const [policyEventIndex, event] of options.runState.policyEvents.entries()
  ) {
    push({
      kind: "policy_event",
      at: event.at,
      policyEventIndex,
      severity: event.severity,
      toolCallId: event.toolCallId,
      toolId: event.toolId,
    });
  }
  for (
    const [failureRecordIndex, failure]
      of (options.runState.failureRecords ?? []).entries()
  ) {
    push({
      kind: "failure_record",
      at: failure.at,
      failureRecordIndex,
      failureKind: failure.kind,
      source: failure.source,
      toolId: failure.toolId,
    });
  }
  if (options.runState.endedAt !== undefined) {
    push({
      kind: "run_finished",
      at: options.runState.endedAt,
      status: options.runState.status,
      ...(options.runState.terminalReason !== undefined
        ? { terminalReason: options.runState.terminalReason }
        : {}),
    });
  }

  return entries
    .sort((left, right) =>
      left.at === right.at ? left.order - right.order : left.at.localeCompare(
        right.at,
      )
    )
    .map(({ order: _order, ...entry }, index) => ({
      type: "cf-harness.timeline-entry",
      sequence: index + 1,
      ...entry,
    }));
};

export const createHarnessRunReport = (
  options: CreateHarnessRunReportOptions,
): HarnessRunReport => {
  const warnings =
    options.runState.policyEvents.filter((event) =>
      event.severity === "warning"
    ).length;
  const denied =
    options.runState.policyEvents.filter((event) => event.severity === "denied")
      .length;
  const policyDecisions = [...(options.runState.policyDecisions ?? [])];
  return {
    type: "cf-harness.run-report",
    runId: options.runState.runId,
    generatedAt: options.runState.updatedAt,
    status: options.runState.status,
    model: options.model,
    ...(options.reasoningEffort !== undefined
      ? { reasoningEffort: options.reasoningEffort }
      : {}),
    ...(options.researchReasoningEffort !== undefined
      ? { researchReasoningEffort: options.researchReasoningEffort }
      : {}),
    ...(options.promptCacheMode !== undefined
      ? { promptCacheMode: options.promptCacheMode }
      : {}),
    cacheAffinity: options.cacheAffinity ?? "run",
    ...(options.runState.modelProvider !== undefined
      ? { modelProvider: options.runState.modelProvider }
      : {}),
    ...(options.runState.modelAuthSource !== undefined
      ? { modelAuthSource: options.runState.modelAuthSource }
      : options.runState.modelProvider === "openai-codex"
      ? { modelAuthSource: "owner-bound-oauth" as const }
      : {}),
    ...(options.runState.credentialOwner !== undefined
      ? { credentialOwner: structuredClone(options.runState.credentialOwner) }
      : {}),
    ...(options.runState.harnessHomeIdentity !== undefined
      ? { harnessHomeIdentity: options.runState.harnessHomeIdentity }
      : {}),
    modelTurns: options.modelTurns,
    ...(options.usage !== undefined ? { usage: options.usage } : {}),
    ...(options.totalUsage !== undefined
      ? { totalUsage: options.totalUsage }
      : {}),
    ...((options.modelUsage?.length ?? 0) > 0
      ? { modelUsage: [...(options.modelUsage ?? [])] }
      : {}),
    cfcEnforcementMode: options.runState.cfcEnforcementMode,
    ...(options.runState.fabricSessionCfc !== undefined
      ? { fabricSessionCfc: options.runState.fabricSessionCfc }
      : {}),
    ...(options.runState.createdAt !== undefined
      ? { createdAt: options.runState.createdAt }
      : {}),
    updatedAt: options.runState.updatedAt,
    ...(options.runState.endedAt !== undefined
      ? { endedAt: options.runState.endedAt }
      : {}),
    ...(options.runState.terminalReason !== undefined
      ? { terminalReason: options.runState.terminalReason }
      : {}),
    ...(options.runState.cancelReason !== undefined
      ? { cancelReason: options.runState.cancelReason }
      : {}),
    ...(options.taskOutcome !== undefined
      ? { taskOutcome: options.taskOutcome }
      : {}),
    ...(options.finalAssistantText !== undefined
      ? { finalAssistantText: options.finalAssistantText }
      : {}),
    ...(options.runState.artifactRoot !== undefined
      ? { artifactRoot: options.runState.artifactRoot }
      : {}),
    ...(options.runState.transcriptPath !== undefined
      ? { transcriptPath: options.runState.transcriptPath }
      : {}),
    ...(options.runState.promptSlotBinding !== undefined
      ? { promptSlotBinding: options.runState.promptSlotBinding }
      : {}),
    ...(options.runState.cfcPolicySnapshot !== undefined
      ? { cfcPolicySnapshot: options.runState.cfcPolicySnapshot }
      : {}),
    ...(options.runState.policyTrace !== undefined
      ? { policyTrace: options.runState.policyTrace }
      : {}),
    ...(options.runState.policyTracePath !== undefined
      ? { policyTracePath: options.runState.policyTracePath }
      : {}),
    ...(options.runState.primaryFailure !== undefined
      ? { primaryFailure: options.runState.primaryFailure }
      : {}),
    ...(options.runState.failureRecords !== undefined
      ? { failureRecords: options.runState.failureRecords }
      : {}),
    policyEventCounts: {
      total: options.runState.policyEvents.length,
      warnings,
      denied,
    },
    policyDecisionCounts: countHarnessPolicyDecisions(policyDecisions),
    policyEvents: [...options.runState.policyEvents],
    policyDecisions,
    timeline: createHarnessRunTimeline({
      runState: options.runState,
      timeline: options.timeline,
      toolActivity: options.toolActivity,
    }),
    toolActivity: [...options.toolActivity],
    ...((options.modelAttempts?.length ?? 0) > 0
      ? { modelAttempts: [...(options.modelAttempts ?? [])] }
      : {}),
    toolOutputs: [...options.runState.toolOutputs],
    ...(options.runState.subagentRuns !== undefined &&
        options.runState.subagentRuns.length > 0
      ? { subagentRuns: [...options.runState.subagentRuns] }
      : {}),
  };
};
