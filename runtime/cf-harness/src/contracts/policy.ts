import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { BrowserHostHandoffReason } from "./browser-host.ts";
import type { ObservationDenied } from "./observation.ts";
import type { PromptSlotBinding } from "./prompt-slot.ts";
import type { HarnessSubagentProfile } from "./subagent.ts";
import type { BuiltinToolId } from "./tool-descriptor.ts";

export type HarnessPolicyEventSeverity = "warning" | "denied";

export interface HarnessBashToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "bash";
  cwd?: string;
  timeoutMs?: number;
  commandBytes?: number;
  commandDigest?: string;
}

/**
 * The action, its inert selectors, and digests where free text rides: a URL
 * or a fill value is what a run would disclose to the web, so the summary
 * carries its size and digest rather than the text itself.
 */
export interface HarnessBrowserToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "browser";
  action?: string;
  kind?: string;
  ref?: string;

  /** A bound handle, carried whole: it names an address, not a value. */
  valueHandle?: string;

  /** A bound handle, carried whole: it names an address, not a value. */
  urlHandle?: string;

  /** Why a hand-off gave the page to the owner: one of a fixed few. */
  reason?: BrowserHostHandoffReason;

  direction?: string;
  x?: number;
  y?: number;
  timeoutMs?: number;
  urlBytes?: number;
  urlDigest?: string;
  valueBytes?: number;
  valueDigest?: string;
}

export interface HarnessReadFileToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "read_file";
  path?: string;
  maxBytes?: number;
}

export interface HarnessReadSkillResourceToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "read_skill_resource";
  skill?: string;
  path?: string;
  maxBytes?: number;
}

export interface HarnessRunSkillScriptToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "run_skill_script";
  skill?: string;
  path?: string;
  argsCount?: number;
  cwd?: string;
  timeoutMs?: number;
}

export interface HarnessWebFetchToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "web_fetch";
  url?: string;
  maxBytes?: number;
  maxTextChars?: number;
  timeoutMs?: number;
}

export interface HarnessWriteFileToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "write_file";
  path?: string;
  mode?: "replace" | "append";
  createParents?: boolean;
  contentBytes?: number;
  contentDigest?: string;
}

export interface HarnessEditFileToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "edit_file";
  path?: string;
  editCount?: number;
  expectedDigest?: string;
  oldTextBytes?: number;
  oldTextDigest?: string;
  newTextBytes?: number;
  newTextDigest?: string;
}

export interface HarnessDelegateTaskToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "delegate_task";
  profile?: HarnessSubagentProfile;
  goalBytes?: number;
  goalDigest?: string;
  contextBytes?: number;
  contextDigest?: string;
  returnSchemaBytes?: number;
  returnSchemaDigest?: string;
  maxModelTurns?: number;
}

export interface HarnessRunPatternToolInputSummary {
  type: "cf-harness.tool-input-summary";
  toolId: "run_pattern";
  sourceTextBytes?: number;
  sourceTextDigest?: string;

  /** The indexed pattern run, when the call named one instead of source. */
  patternId?: string;

  inputCount?: number;
  resultSchemaBytes?: number;
  resultSchemaDigest?: string;
}

export type HarnessToolInputSummary =
  | HarnessBashToolInputSummary
  | HarnessBrowserToolInputSummary
  | HarnessReadFileToolInputSummary
  | HarnessReadSkillResourceToolInputSummary
  | HarnessRunSkillScriptToolInputSummary
  | HarnessWebFetchToolInputSummary
  | HarnessEditFileToolInputSummary
  | HarnessWriteFileToolInputSummary
  | HarnessDelegateTaskToolInputSummary
  | HarnessRunPatternToolInputSummary
  | {
    type: "cf-harness.tool-input-summary";
    toolId: BuiltinToolId;
  };

export interface HarnessPolicyEvent {
  type: "cf-harness.policy-event";
  severity: HarnessPolicyEventSeverity;
  mode: CfcEnforcementMode;
  toolId: string;
  detail: string;
  at: string;
  toolCallId?: string;
  promptSlot?: PromptSlotBinding;
  toolInputSummary?: HarnessToolInputSummary;
  observationDenied?: ObservationDenied;
}

export const createHarnessPolicyEvent = (
  input: Omit<HarnessPolicyEvent, "type">,
): HarnessPolicyEvent => ({
  type: "cf-harness.policy-event",
  ...input,
});
