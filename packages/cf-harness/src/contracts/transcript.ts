import type { HarnessNativeModelToolResult } from "./native-model-tool.ts";

import type { HarnessImageAttachment } from "./image.ts";
import type { HarnessSubagentProfile } from "./subagent.ts";
import type { ToolOutputId, ToolResultRef } from "./tool-result.ts";

export interface HarnessToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type { HarnessNativeModelToolResult } from "./native-model-tool.ts";

export interface HarnessProviderContinuation {
  providerId: string;
  state: unknown;
}

export interface HarnessSystemTranscriptMessage {
  role: "system";
  content: string;
}

/** Tool-result identity carried by host-supplied user context. */
export interface HarnessToolResultProvenance {
  type: "cf-harness.tool-result-provenance";
  toolCallId: string;
  toolId: string;
  outputId: ToolOutputId;
}

export interface HarnessUserTranscriptMessage {
  role: "user";
  content: string;
  imageAttachments?: readonly HarnessImageAttachment[];
  toolResultProvenance?: HarnessToolResultProvenance;
}

export interface HarnessAssistantTranscriptMessage {
  role: "assistant";
  content: string;
  toolCalls?: readonly HarnessToolCall[];
  nativeModelToolResults?: readonly HarnessNativeModelToolResult[];
  providerContinuation?: HarnessProviderContinuation;
}

export interface HarnessToolTranscriptMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  resultRef?: ToolResultRef;
}

export type HarnessTranscriptMessage =
  | HarnessSystemTranscriptMessage
  | HarnessUserTranscriptMessage
  | HarnessAssistantTranscriptMessage
  | HarnessToolTranscriptMessage;

/**
 * Which `delegate_task` child a forwarded transcript event came from. The
 * parent's tool call identifies the child the way the parent already names it,
 * so a consumer can nest the child's activity under the entry that started it
 * without holding a second index.
 */
export interface HarnessTranscriptSubagentContext {
  parentToolCallId: string;
  childRunId: string;
  profile: HarnessSubagentProfile;
  goal: string;
}

export interface HarnessTranscriptEvent {
  message: HarnessTranscriptMessage;
  transcript: readonly HarnessTranscriptMessage[];

  /**
   * Set when the message belongs to a `delegate_task` child loop rather than
   * to the loop the handler was passed to. The transcript is then the child's
   * own, whose length is unrelated to the parent's.
   */
  subagent?: HarnessTranscriptSubagentContext;
}

/** A way a transcript fails to be valid resumable model history. */
export type HarnessTranscriptDefect =
  | {
    kind: "unresolved_tool_calls";
    messageIndex: number;
    toolCallIds: readonly string[];
  }
  | { kind: "orphan_tool_result"; messageIndex: number; toolCallId: string }
  | { kind: "duplicate_tool_result"; messageIndex: number; toolCallId: string }
  | { kind: "duplicate_tool_call"; messageIndex: number; toolCallId: string };

export interface HarnessTranscriptPairing {
  valid: boolean;
  defects: readonly HarnessTranscriptDefect[];

  /**
   * Length of the longest prefix that is itself resumable: the prefix ends
   * where no tool call is left outstanding, and never reaches past a
   * structurally malformed message, whose damage no truncation undoes.
   *
   * Truncating to this boundary can drop an assistant message carrying
   * `providerContinuation` compaction. That is safe — the Responses projection
   * selects the newest surviving compaction boundary, so the cost is a longer
   * prompt, never invalid history.
   */
  safeBoundary: number;
}

/**
 * Report whether every tool call in `transcript` has exactly one matching tool
 * result, and where the longest resumable prefix ends.
 *
 * A provider rejects history whose tool calls and tool results do not pair, so
 * this is the invariant a durable session transcript must hold before it is
 * advertised as reusable or sent to a model.
 *
 * `nativeModelToolResults` are excluded: they are provider-side results already
 * embedded in the assistant message, and the Responses projection does not turn
 * them into a call that needs a partner.
 */
export const inspectHarnessTranscriptPairing = (
  transcript: readonly HarnessTranscriptMessage[],
): HarnessTranscriptPairing => {
  const defects: HarnessTranscriptDefect[] = [];
  const pending = new Map<string, number>();
  const seen = new Set<string>();
  let safeBoundary = 0;

  for (const [messageIndex, message] of transcript.entries()) {
    switch (message.role) {
      case "assistant":
        for (const call of message.toolCalls ?? []) {
          if (seen.has(call.id)) {
            defects.push({
              kind: "duplicate_tool_call",
              messageIndex,
              toolCallId: call.id,
            });
            continue;
          }
          seen.add(call.id);
          pending.set(call.id, messageIndex);
        }
        break;
      case "tool":
        if (!pending.delete(message.toolCallId)) {
          defects.push({
            kind: seen.has(message.toolCallId)
              ? "duplicate_tool_result"
              : "orphan_tool_result",
            messageIndex,
            toolCallId: message.toolCallId,
          });
        }
        break;
      case "system":
      case "user":
        // A user or system message neither answers an outstanding call nor
        // cancels it. Pairing is by id over the whole transcript, not by
        // adjacency, so a result still settles its call from further down;
        // what a message here does is hold the boundary back, which is what
        // leaves a turn abandoned mid-tool looking unresumable.
        break;
    }
    // Only a prefix free of defects is resumable. An unanswered call is
    // repaired by cutting the prefix short; an orphan or duplicate is not
    // repaired by any cut, so the boundary stops before it and stays there.
    if (pending.size === 0 && defects.length === 0) {
      safeBoundary = messageIndex + 1;
    }
  }

  const unresolvedByAssistant = new Map<number, string[]>();
  for (const [toolCallId, messageIndex] of pending) {
    const ids = unresolvedByAssistant.get(messageIndex) ?? [];
    ids.push(toolCallId);
    unresolvedByAssistant.set(messageIndex, ids);
  }
  for (const [messageIndex, toolCallIds] of unresolvedByAssistant) {
    defects.push({ kind: "unresolved_tool_calls", messageIndex, toolCallIds });
  }

  return { valid: defects.length === 0, defects, safeBoundary };
};

/** Whether `transcript` can be sent to a provider as model history. */
export const isResumableHarnessTranscript = (
  transcript: readonly HarnessTranscriptMessage[],
): boolean => inspectHarnessTranscriptPairing(transcript).valid;
