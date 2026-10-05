import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessCfcInvocationContext } from "./cfc-invocation-context.ts";
import type {
  HarnessReleaseDecision,
  HarnessReleaseDecisionReasonCode,
} from "./policy-refusal.ts";
import type { PromptSlotBinding } from "./prompt-slot.ts";
import type { HarnessToolEffectClass } from "./tool-descriptor.ts";
import type { HarnessToolInputSummary } from "./policy.ts";
import type {
  HarnessToolInvocationOrigin,
  HarnessToolPolicyDecision,
} from "./run-report.ts";
import type { ToolResultRef } from "./tool-result.ts";

export type HarnessPolicyDecisionReasonCode =
  | "tool_not_allowed"
  | "cfc_disabled"
  | "cfc_observe_read"
  | "cfc_observe_direct_command"
  | "cfc_observe_requires_direct_command"
  | "cfc_enforce_explicit_read"
  | "cfc_enforce_explicit_direct_command"
  | "cfc_enforce_explicit_requires_direct_command"
  | "cfc_enforce_strict_direct_command"
  | "cfc_enforce_strict_requires_direct_command"
  | "write_file_disabled"
  | "write_file_observe_direct_command"
  | "write_file_observe_requires_direct_command"
  | "write_file_enforce_explicit_direct_command"
  | "write_file_enforce_explicit_requires_direct_command"
  | "write_file_enforce_strict_direct_command"
  | "write_file_enforce_strict_requires_direct_command"
  | "structured_result_return"
  | "subagent_profile_allowed"
  | "subagent_profile_not_allowed"
  | "invalid_tool_call"
  | HarnessReleaseDecisionReasonCode;

export interface HarnessPolicyDecisionRecord {
  type: "cf-harness.policy-decision";
  sequence: number;
  runId: string;
  at: string;
  toolActivitySequence: number;
  toolCallId: string;
  toolId: string;
  origin?: HarnessToolInvocationOrigin;
  effectClass?: HarnessToolEffectClass;
  cfcEnforcementMode: CfcEnforcementMode;
  decision: HarnessToolPolicyDecision;
  reasonCodes: readonly HarnessPolicyDecisionReasonCode[];
  detail?: string;
  promptSlot?: PromptSlotBinding;
  toolInputSummary?: HarnessToolInputSummary;
  policyEventIndexes?: readonly number[];
  subagentProfile?: string;

  /**
   * What a confidentiality boundary decided about the call's own result, on
   * the decision that records it. A label decided this one; every other
   * decision in the trace turns on authority, and the two are told apart by
   * this field rather than by reading a reason code for a shape it does not
   * carry.
   */
  release?: HarnessReleaseDecision;

  /**
   * The tool result the decision belongs to, as the tool activity names it:
   * the output id and, where the run persists artifacts, the path of the
   * tool-output file. Present on a decision made from a result rather than
   * before one existed, which is every release decision and no allow-side
   * one.
   */
  resultRef?: ToolResultRef;
}

export interface HarnessPolicyDecisionCounts {
  total: number;
  allowed: number;
  warned: number;
  denied: number;

  /**
   * Calls rejected for their arguments rather than by policy. Absent on a run
   * recorded before the outcome existed, which is why every reader of this
   * field reads it as `?? 0` rather than as a number.
   */
  invalid?: number;

  /**
   * Results a confidentiality boundary held the values of, on calls that ran
   * and answered. Read as `?? 0` for the same reason `invalid` is.
   */
  withheld?: number;
}

export interface HarnessPolicyTrace {
  type: "cf-harness.policy-trace";
  version: 1;
  generatedAt: string;
  runId: string;
  cfcEnforcementMode: CfcEnforcementMode;
  cfcPolicySnapshotPath?: string;
  cfcPolicySnapshotDigest?: string;
  decisionCounts: HarnessPolicyDecisionCounts;
  decisions: readonly HarnessPolicyDecisionRecord[];
  cfcInvocationContexts?: readonly HarnessCfcInvocationContext[];
}

export interface CreateHarnessPolicyDecisionRecordOptions
  extends Omit<HarnessPolicyDecisionRecord, "type" | "sequence" | "runId"> {
  sequence: number;
  runId: string;
}

export interface CreateHarnessPolicyTraceOptions {
  generatedAt: string;
  runId: string;
  cfcEnforcementMode: CfcEnforcementMode;
  cfcPolicySnapshotPath?: string;
  cfcPolicySnapshotDigest?: string;
  decisions?: readonly HarnessPolicyDecisionRecord[];
  cfcInvocationContexts?: readonly HarnessCfcInvocationContext[];
}

export const createHarnessPolicyDecisionRecord = (
  options: CreateHarnessPolicyDecisionRecordOptions,
): HarnessPolicyDecisionRecord => ({
  type: "cf-harness.policy-decision",
  sequence: options.sequence,
  runId: options.runId,
  at: options.at,
  toolActivitySequence: options.toolActivitySequence,
  toolCallId: options.toolCallId,
  toolId: options.toolId,
  ...(options.origin !== undefined ? { origin: options.origin } : {}),
  ...(options.effectClass !== undefined
    ? { effectClass: options.effectClass }
    : {}),
  cfcEnforcementMode: options.cfcEnforcementMode,
  decision: options.decision,
  reasonCodes: [...options.reasonCodes],
  ...(options.detail !== undefined ? { detail: options.detail } : {}),
  ...(options.promptSlot !== undefined
    ? { promptSlot: options.promptSlot }
    : {}),
  ...(options.toolInputSummary !== undefined
    ? { toolInputSummary: options.toolInputSummary }
    : {}),
  ...(options.policyEventIndexes !== undefined &&
      options.policyEventIndexes.length > 0
    ? { policyEventIndexes: [...options.policyEventIndexes] }
    : {}),
  ...(options.subagentProfile !== undefined
    ? { subagentProfile: options.subagentProfile }
    : {}),
  ...(options.release !== undefined ? { release: options.release } : {}),
  ...(options.resultRef !== undefined ? { resultRef: options.resultRef } : {}),
});

export const countHarnessPolicyDecisions = (
  decisions: readonly HarnessPolicyDecisionRecord[] = [],
): HarnessPolicyDecisionCounts => ({
  total: decisions.length,
  allowed: decisions.filter((decision) => decision.decision === "allowed")
    .length,
  warned: decisions.filter((decision) => decision.decision === "warned")
    .length,
  denied: decisions.filter((decision) => decision.decision === "denied")
    .length,
  invalid: decisions.filter((decision) => decision.decision === "invalid")
    .length,
  withheld: decisions.filter((decision) => decision.decision === "withheld")
    .length,
});

export const createHarnessPolicyTrace = (
  options: CreateHarnessPolicyTraceOptions,
): HarnessPolicyTrace => {
  const decisions = [...(options.decisions ?? [])];
  return {
    type: "cf-harness.policy-trace",
    version: 1,
    generatedAt: options.generatedAt,
    runId: options.runId,
    cfcEnforcementMode: options.cfcEnforcementMode,
    ...(options.cfcPolicySnapshotPath !== undefined
      ? { cfcPolicySnapshotPath: options.cfcPolicySnapshotPath }
      : {}),
    ...(options.cfcPolicySnapshotDigest !== undefined
      ? { cfcPolicySnapshotDigest: options.cfcPolicySnapshotDigest }
      : {}),
    decisionCounts: countHarnessPolicyDecisions(decisions),
    decisions,
    ...(options.cfcInvocationContexts !== undefined
      ? { cfcInvocationContexts: [...options.cfcInvocationContexts] }
      : {}),
  };
};
