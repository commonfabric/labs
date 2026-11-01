/**
 * Captures the decoder input and decision for an empty assistant reply. The
 * prompt loop writes this evidence only to the run's diagnostic artifacts.
 */

import type { HarnessAssistantTranscriptMessage } from "../contracts/transcript.ts";
import { responseBodyDiagnosticFields } from "../gateway/openai-client.ts";

/** Bounded provider payload and the decoded values that made a reply empty. */
export interface HarnessEmptyReplyDiagnostic {
  responseBodyBytes: number;
  responseBodyExcerpt: string;
  responseBodyTruncated: boolean;
  decision: {
    decoder: "chat-completions" | "responses";
    reason: "no-non-whitespace-text-or-tool-calls";
    contentCharacters: number;
    trimmedContentCharacters: number;
    toolCallCount: number;
  };
}

/** Returns artifact evidence only for replies the prompt loop judges empty. */
export const emptyReplyDiagnostic = (
  assistant: HarnessAssistantTranscriptMessage,
  decoder: HarnessEmptyReplyDiagnostic["decision"]["decoder"],
  rawPayload: unknown,
): HarnessEmptyReplyDiagnostic | undefined => {
  const trimmedContentCharacters = assistant.content.trim().length;
  const toolCallCount = assistant.toolCalls?.length ?? 0;
  if (trimmedContentCharacters > 0 || toolCallCount > 0) return undefined;
  return {
    ...responseBodyDiagnosticFields(JSON.stringify(rawPayload)),
    decision: {
      decoder,
      reason: "no-non-whitespace-text-or-tool-calls",
      contentCharacters: assistant.content.length,
      trimmedContentCharacters,
      toolCallCount,
    },
  };
};
