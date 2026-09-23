import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessBrowserAccessLease } from "./browser-access.ts";
import type { HarnessImageAttachment } from "./image.ts";
import type { HarnessInputCellSpec } from "./input-cells.ts";
import type { HarnessPatternRefSpec } from "./pattern-refs.ts";
import type { PromptSlotBinding } from "./prompt-slot.ts";
import type { LoomLocalHostBinding } from "./run-manifest.ts";
import {
  type BuiltinToolId,
  DEFAULT_PARENT_TOOL_IDS,
  LOOM_AUTHORING_TOOL_IDS,
} from "./tool-descriptor.ts";
import {
  DEFAULT_SUBAGENT_PROFILE,
  type HarnessSubagentProfile,
} from "./subagent.ts";
import type { HarnessTaskOutcome } from "./task-outcome.ts";
import type { HarnessModelUsage } from "../model/client.ts";

export const HARNESS_CHAT_PROTOCOL_VERSION = 1 as const;
export const HARNESS_CHAT_REQUEST_TYPE = "cf-harness.chat.request" as const;
export const HARNESS_CHAT_RESPONSE_TYPE = "cf-harness.chat.response" as const;
export const HARNESS_CHAT_EVENT_TYPE = "cf-harness.chat.event" as const;

export const READONLY_INTERACTIVE_CHAT_TOOL_IDS = [
  "read_file",
  "view_image",
  "read_skill_resource",
] as const satisfies readonly BuiltinToolId[];

export type HarnessChatRequestMethod =
  | "start_session"
  | "start_turn"
  | "cancel_turn"
  | "close_session"
  | "status"
  | "list_events"
  | "list_turns";

export type HarnessChatSessionLifecycle =
  | "idle"
  | "turn_running"
  | "canceling"
  | "closed"
  | "failed";

export type HarnessChatTurnLifecycle =
  | "running"
  | "canceling"
  | "canceled"
  | "completed"
  | "failed";

export type HarnessChatToolPolicyMode = "workspace-write" | "read-only";

export type HarnessChatContext =
  | {
    type: "workspace";
  }
  | {
    type: "comment-thread";
    threadId?: string;
    subject?: string;
  };

export interface HarnessChatCapabilities {
  partialTextStream: boolean;
  toolTelemetry: boolean;
  fileMutationEvents: boolean;
  browserProfile: boolean;
  browserAccessLease: boolean;
  delegation: boolean;
  readonlyMode: boolean;
  imageAttachments: boolean;
  cfcEnforcement: boolean;
  structuredErrors: boolean;
}

export const DEFAULT_HARNESS_CHAT_CAPABILITIES: HarnessChatCapabilities = {
  partialTextStream: false,
  toolTelemetry: true,
  fileMutationEvents: true,
  browserProfile: true,
  browserAccessLease: true,
  delegation: true,
  readonlyMode: true,
  imageAttachments: true,
  cfcEnforcement: true,
  structuredErrors: true,
};

export const resolveHarnessChatCapabilities = (
  input: Partial<HarnessChatCapabilities> = {},
): HarnessChatCapabilities => ({
  ...DEFAULT_HARNESS_CHAT_CAPABILITIES,
  ...input,
});

export interface HarnessChatWorkspace {
  hostPath: string;
  cwd?: string;
  sandboxPath?: string;
}

export type HarnessChatBrowserAccessLease = HarnessBrowserAccessLease;

export interface HarnessChatPolicy {
  type: "cf-harness.chat-policy";
  toolMode: HarnessChatToolPolicyMode;
  allowedToolIds: readonly BuiltinToolId[];
  allowedSubagentProfiles: readonly HarnessSubagentProfile[];
  cfcEnforcementMode?: CfcEnforcementMode;
  promptSlot?: PromptSlotBinding;
}

export const DEFAULT_HARNESS_CHAT_POLICY: HarnessChatPolicy = {
  type: "cf-harness.chat-policy",
  toolMode: "workspace-write",
  allowedToolIds: DEFAULT_PARENT_TOOL_IDS,
  allowedSubagentProfiles: [DEFAULT_SUBAGENT_PROFILE],
};

export const READONLY_HARNESS_CHAT_POLICY: HarnessChatPolicy = {
  type: "cf-harness.chat-policy",
  toolMode: "read-only",
  allowedToolIds: READONLY_INTERACTIVE_CHAT_TOOL_IDS,
  allowedSubagentProfiles: [],
};

export const COMMENT_THREAD_HARNESS_CHAT_POLICY: HarnessChatPolicy = {
  ...READONLY_HARNESS_CHAT_POLICY,
};

const READONLY_INTERACTIVE_CHAT_TOOL_ID_SET = new Set<BuiltinToolId>(
  READONLY_INTERACTIVE_CHAT_TOOL_IDS,
);

export const resolveHarnessChatPolicy = (
  policy: HarnessChatPolicy = DEFAULT_HARNESS_CHAT_POLICY,
  context?: HarnessChatContext,
  allowCommentLoomAuthoring = false,
): HarnessChatPolicy => {
  // Durable sessions can retain the legacy tool id in their policy bytes.
  // Normalize only at the use boundary so that allowlist grants the replacement
  // capability without rewriting session history.
  const normalizedPolicy: HarnessChatPolicy = {
    ...policy,
    allowedToolIds: [
      ...new Set(
        (policy.allowedToolIds as readonly string[]).map((toolId) =>
          toolId === "query_docs" ? "research" : toolId
        ),
      ),
    ] as BuiltinToolId[],
  };
  if (context?.type === "comment-thread") {
    return {
      ...COMMENT_THREAD_HARNESS_CHAT_POLICY,
      ...(allowCommentLoomAuthoring
        ? {
          allowedToolIds: [
            ...READONLY_INTERACTIVE_CHAT_TOOL_IDS,
            ...normalizedPolicy.allowedToolIds.filter((id) =>
              LOOM_AUTHORING_TOOL_IDS.has(id)
            ),
          ],
        }
        : {}),
      ...(normalizedPolicy.cfcEnforcementMode !== undefined
        ? { cfcEnforcementMode: normalizedPolicy.cfcEnforcementMode }
        : {}),
      ...(normalizedPolicy.promptSlot !== undefined
        ? { promptSlot: normalizedPolicy.promptSlot }
        : {}),
    };
  }
  if (normalizedPolicy.toolMode !== "read-only") {
    return normalizedPolicy;
  }
  return {
    ...normalizedPolicy,
    toolMode: "read-only",
    allowedToolIds: normalizedPolicy.allowedToolIds.filter((toolId) =>
      READONLY_INTERACTIVE_CHAT_TOOL_ID_SET.has(toolId)
    ),
    allowedSubagentProfiles: [],
  };
};

export interface HarnessChatTurnInput {
  text: string;

  /** Originating Loom supplied by the caller, persisted with this turn only. */
  loomId?: string;
  imageAttachments?: readonly HarnessImageAttachment[];
}

export interface HarnessChatStartSessionParams {
  sessionId?: string;
  workspace: HarnessChatWorkspace;
  context?: HarnessChatContext;
  model?: string;
  artifactRoot?: string;
  policy?: HarnessChatPolicy;
  capabilities?: Partial<HarnessChatCapabilities>;
  browserAccess?: HarnessChatBrowserAccessLease;
  metadata?: Record<string, unknown>;
}

export interface HarnessChatStartTurnParams {
  sessionId: string;
  turnId?: string;
  context?: HarnessChatContext;
  input: HarnessChatTurnInput;
  policy?: HarnessChatPolicy;
  browserAccess?: HarnessChatBrowserAccessLease;

  /**
   * Cells the caller attaches to this turn by reference, each under a name the
   * model sees. A turn is its own run with its own handle table, so input
   * cells are named per turn rather than per session: the tokens the model is
   * given are the ones this turn's run minted. Omission reuses session-retained
   * named targets; an explicit empty list attaches none and clears those targets
   * when the turn completes without naming a new piece.
   */
  inputCells?: readonly HarnessInputCellSpec[];

  /**
   * Published patterns the caller attaches to this turn by index id, resolved
   * before the turn's first model turn and seeded into its run as searched
   * hits. Named per turn for the same reason an input cell is: the run that
   * holds them is this turn's.
   */
  patternRefs?: readonly HarnessPatternRefSpec[];

  metadata?: Record<string, unknown>;
}

export interface HarnessChatCancelTurnParams {
  sessionId: string;
  turnId?: string;
  reason?: string;
}

export interface HarnessChatCloseSessionParams {
  sessionId: string;
  reason?: string;
}

export interface HarnessChatStatusParams {
  sessionId?: string;
}

export interface HarnessChatListEventsParams {
  sessionId?: string;
  afterSequence?: number;
  limit?: number;
}

export interface HarnessChatListTurnsParams {
  sessionId?: string;
  status?: HarnessChatTurnLifecycle;
}

export type HarnessChatRequestParamsByMethod = {
  start_session: HarnessChatStartSessionParams;
  start_turn: HarnessChatStartTurnParams;
  cancel_turn: HarnessChatCancelTurnParams;
  close_session: HarnessChatCloseSessionParams;
  status: HarnessChatStatusParams;
  list_events: HarnessChatListEventsParams;
  list_turns: HarnessChatListTurnsParams;
};

export type HarnessChatRequestEnvelope<
  Method extends HarnessChatRequestMethod = HarnessChatRequestMethod,
> = {
  [K in Method]: {
    type: typeof HARNESS_CHAT_REQUEST_TYPE;
    protocolVersion: typeof HARNESS_CHAT_PROTOCOL_VERSION;
    requestId: string;
    method: K;
    params: HarnessChatRequestParamsByMethod[K];
  };
}[Method];

export interface HarnessChatError {
  code:
    | "invalid_request"
    | "session_exists"
    | "session_not_found"
    | "turn_exists"
    | "turn_not_found"
    | "turn_already_running"
    | "turn_canceled"
    | "session_closed"
    | "incomplete_transcript"
    | "browser_access_required"
    | "policy_denied"
    | "provider-configuration-required"
    | "provider-auth-required"
    | "provider-mismatch"
    | "provider-unavailable"
    | "internal_error";
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface HarnessChatOkResponse<Result = unknown> {
  type: typeof HARNESS_CHAT_RESPONSE_TYPE;
  protocolVersion: typeof HARNESS_CHAT_PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: Result;
}

export interface HarnessChatErrorResponse {
  type: typeof HARNESS_CHAT_RESPONSE_TYPE;
  protocolVersion: typeof HARNESS_CHAT_PROTOCOL_VERSION;
  requestId: string;
  ok: false;
  error: HarnessChatError;
}

export type HarnessChatResponse<Result = unknown> =
  | HarnessChatOkResponse<Result>
  | HarnessChatErrorResponse;

export interface HarnessChatTurnStatus {
  turnId: string;
  status: HarnessChatTurnLifecycle;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  cancelReason?: string;
  error?: HarnessChatError;
}

/** Elapsed wall time on the durable turn clock, when both stamps are valid. */
export const harnessChatTurnElapsedMs = (
  startedAt: string | undefined,
  observedAt: string | undefined,
): number | undefined => {
  if (startedAt === undefined || observedAt === undefined) return undefined;
  const elapsed = Date.parse(observedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
};

export interface HarnessChatSessionStatus {
  sessionId: string;
  status: HarnessChatSessionLifecycle;
  reusable: boolean;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  activeTurnId?: string;
  activeTurn?: HarnessChatTurnStatus;
  workspace?: HarnessChatWorkspace;
  context?: HarnessChatContext;
  model?: string;
  loomLocalHostBinding?: LoomLocalHostBinding;
  artifactRoot?: string;
  capabilities: HarnessChatCapabilities;
  policy: HarnessChatPolicy;
  browserAccess?: HarnessChatBrowserAccessLease;
  metadata?: Record<string, unknown>;
}

export interface HarnessChatStatusResult {
  sessions: readonly HarnessChatSessionStatus[];
}

export interface HarnessChatTurnRecord {
  sessionId: string;
  turn: HarnessChatTurnStatus;
  input: HarnessChatTurnInput;
  context?: HarnessChatContext;
  policy: HarnessChatPolicy;
  browserAccess?: HarnessChatBrowserAccessLease;
  metadata?: Record<string, unknown>;
}

export interface HarnessChatToolCallSummary {
  toolCallId: string;
  toolId: BuiltinToolId | string;
  title?: string;
  inputSummary?: Record<string, unknown>;
}

export interface HarnessChatFileChange {
  kind: "create" | "update" | "delete" | "move";
  path: string;
  oldPath?: string;
  oldContent?: string;
  newContent?: string;
  summary?: string;
}

/**
 * The `delegate_task` child an event belongs to. Events derived from a child's
 * transcript carry it so a consumer can nest them under the parent tool call
 * that started the child, which is the only identifier the parent feed already
 * shows.
 */
export interface HarnessChatSubagentRef {
  parentToolCallId: string;
  childRunId?: string;
  profile: HarnessSubagentProfile;
}

export interface HarnessChatSubagentSummary extends HarnessChatSubagentRef {
  /** The task the parent delegated, as the parent worded it. */
  goal?: string;

  summary?: string;
}

export type HarnessChatGatewayUsage = HarnessModelUsage;

export type HarnessChatStructuredEvent =
  | {
    kind: "session_started";
    session: HarnessChatSessionStatus;
  }
  | {
    kind: "turn_started";
    turn: HarnessChatTurnStatus;
  }
  | {
    kind: "assistant_delta";
    text: string;
    subagent?: HarnessChatSubagentRef;
  }
  | {
    kind: "assistant_completed";
    text: string;
    subagent?: HarnessChatSubagentRef;
  }
  | {
    kind: "tool_started";
    tool: HarnessChatToolCallSummary;
    subagent?: HarnessChatSubagentRef;
  }
  | {
    kind: "tool_progress";
    toolCallId: string;
    message: string;
    data?: Record<string, unknown>;
    subagent?: HarnessChatSubagentRef;
  }
  | {
    kind: "tool_completed";
    tool: HarnessChatToolCallSummary;
    status: "completed" | "failed" | "denied";
    resultSummary?: string;
    error?: HarnessChatError;
    subagent?: HarnessChatSubagentRef;
  }
  | {
    kind: "file_changed";
    change: HarnessChatFileChange;
    subagent?: HarnessChatSubagentRef;
  }
  | {
    kind: "subagent_started";
    subagent: HarnessChatSubagentSummary;
  }
  | {
    kind: "subagent_completed";
    subagent: HarnessChatSubagentSummary;
    status: "completed" | "failed";
  }
  | {
    kind: "browser_access_required";
    reason: string;
  }
  | {
    /** Cumulative turn usage after one parent, research, or child model call. */
    kind: "turn_usage";
    turnId: string;
    usage?: HarnessChatGatewayUsage;
    elapsedMs?: number;
  }
  | {
    kind: "turn_canceled";
    turnId: string;
    reason?: string;
  }
  | {
    kind: "turn_completed";
    turnId: string;
    finalText?: string;
    usage?: HarnessChatGatewayUsage;
  } & (HarnessTaskOutcome | { outcome?: undefined })
  | {
    kind: "turn_failed";
    turnId: string;
    error: HarnessChatError;
  }
  | {
    kind: "status_changed";
    session: HarnessChatSessionStatus;
  }
  | {
    kind: "session_closed";
    reason?: string;
  }
  | {
    kind: "error";
    error: HarnessChatError;
    fatal?: boolean;
  };

export interface HarnessChatEventEnvelope<
  Event extends HarnessChatStructuredEvent = HarnessChatStructuredEvent,
> {
  type: typeof HARNESS_CHAT_EVENT_TYPE;
  protocolVersion: typeof HARNESS_CHAT_PROTOCOL_VERSION;
  sessionId: string;
  turnId?: string;
  sequence: number;
  emittedAt: string;
  event: Event;
}

export interface HarnessChatListEventsResult {
  events: readonly HarnessChatEventEnvelope[];
  latestSequence: number;
}

export interface HarnessChatListTurnsResult {
  turns: readonly HarnessChatTurnRecord[];
}

export interface CreateHarnessChatSessionStatusOptions {
  sessionId: string;
  createdAt?: string;
  workspace?: HarnessChatWorkspace;
  context?: HarnessChatContext;
  model?: string;
  loomLocalHostBinding?: LoomLocalHostBinding;
  artifactRoot?: string;
  capabilities?: Partial<HarnessChatCapabilities>;
  policy?: HarnessChatPolicy;
  browserAccess?: HarnessChatBrowserAccessLease;
  metadata?: Record<string, unknown>;
}

export const createHarnessChatSessionStatus = (
  options: CreateHarnessChatSessionStatusOptions,
): HarnessChatSessionStatus => {
  const createdAt = options.createdAt ?? new Date().toISOString();
  return {
    sessionId: options.sessionId,
    status: "idle",
    reusable: true,
    turnCount: 0,
    createdAt,
    updatedAt: createdAt,
    ...(options.workspace !== undefined
      ? { workspace: options.workspace }
      : {}),
    ...(options.context !== undefined ? { context: options.context } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.loomLocalHostBinding !== undefined
      ? { loomLocalHostBinding: structuredClone(options.loomLocalHostBinding) }
      : {}),
    ...(options.artifactRoot !== undefined
      ? { artifactRoot: options.artifactRoot }
      : {}),
    capabilities: resolveHarnessChatCapabilities(options.capabilities),
    policy: options.policy ?? DEFAULT_HARNESS_CHAT_POLICY,
    ...(options.browserAccess !== undefined
      ? { browserAccess: options.browserAccess }
      : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  };
};

export const createHarnessChatEventEnvelope = <
  Event extends HarnessChatStructuredEvent,
>(
  options:
    & Omit<
      HarnessChatEventEnvelope<Event>,
      "type" | "protocolVersion" | "emittedAt"
    >
    & {
      emittedAt?: string;
    },
): HarnessChatEventEnvelope<Event> => ({
  type: HARNESS_CHAT_EVENT_TYPE,
  protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
  emittedAt: options.emittedAt ?? new Date().toISOString(),
  sessionId: options.sessionId,
  ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
  sequence: options.sequence,
  event: options.event,
});

export const createHarnessChatOkResponse = <Result>(
  requestId: string,
  result: Result,
): HarnessChatOkResponse<Result> => ({
  type: HARNESS_CHAT_RESPONSE_TYPE,
  protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
  requestId,
  ok: true,
  result,
});

export const createHarnessChatErrorResponse = (
  requestId: string,
  error: HarnessChatError,
): HarnessChatErrorResponse => ({
  type: HARNESS_CHAT_RESPONSE_TYPE,
  protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
  requestId,
  ok: false,
  error,
});

const clearSessionActiveTurn = (
  status: HarnessChatSessionStatus,
): Omit<HarnessChatSessionStatus, "activeTurn" | "activeTurnId"> => {
  const { activeTurn: _activeTurn, activeTurnId: _activeTurnId, ...rest } =
    status;
  return rest;
};

export const reduceHarnessChatSessionStatus = (
  status: HarnessChatSessionStatus,
  envelope: HarnessChatEventEnvelope,
): HarnessChatSessionStatus => {
  const updatedAt = envelope.emittedAt;
  switch (envelope.event.kind) {
    case "session_started":
      return envelope.event.session;
    case "turn_started":
      return {
        ...status,
        status: "turn_running",
        reusable: true,
        activeTurnId: envelope.event.turn.turnId,
        activeTurn: envelope.event.turn,
        turnCount: status.turnCount + 1,
        updatedAt,
      };
    case "turn_canceled": {
      return {
        ...status,
        status: "canceling",
        reusable: false,
        activeTurnId: envelope.event.turnId,
        ...(status.activeTurn !== undefined
          ? {
            activeTurn: {
              ...status.activeTurn,
              status: "canceling",
              updatedAt,
              cancelReason: envelope.event.reason,
            },
          }
          : {}),
        updatedAt,
      };
    }
    case "turn_completed": {
      const rest = clearSessionActiveTurn(status);
      if (status.status === "closed" || status.status === "failed") {
        return {
          ...rest,
          reusable: false,
          updatedAt,
        };
      }
      return {
        ...rest,
        status: "idle",
        reusable: true,
        updatedAt,
      };
    }
    case "turn_failed": {
      const rest = clearSessionActiveTurn(status);
      if (status.status === "closed" || status.status === "failed") {
        return {
          ...rest,
          reusable: false,
          updatedAt,
        };
      }
      return {
        ...rest,
        status: "idle",
        reusable: true,
        updatedAt,
      };
    }
    case "status_changed":
      return envelope.event.session;
    case "session_closed": {
      const rest = clearSessionActiveTurn(status);
      return {
        ...rest,
        status: "closed",
        reusable: false,
        closedAt: updatedAt,
        updatedAt,
      };
    }
    case "error":
      if (!envelope.event.fatal) {
        return {
          ...status,
          updatedAt,
        };
      }
      {
        const rest = clearSessionActiveTurn(status);
        return {
          ...rest,
          status: "failed",
          reusable: false,
          updatedAt,
        };
      }
    default:
      return {
        ...status,
        updatedAt,
      };
  }
};
