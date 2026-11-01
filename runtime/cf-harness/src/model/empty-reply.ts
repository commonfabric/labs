/**
 * Captures the decoder input and decision for an empty assistant reply. The
 * prompt loop writes this evidence only to the run's diagnostic artifacts.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { HarnessAssistantTranscriptMessage } from "../contracts/transcript.ts";

/** UTF-8 byte ceiling for the serialized empty-reply evidence. */
const MAX_EMPTY_REPLY_BYTES = 64 * 1024;

/** Bounded provider payload and the decoded values that made a reply empty. */
export interface HarnessEmptyReplyDiagnostic {
  /** Full serialized byte count of the selected response fields. */
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
  if (!isObjectNotArray(rawPayload)) {
    throw new Error("Empty-reply evidence requires a provider response object");
  }
  const terminal = isObjectNotArray(rawPayload.terminal)
    ? rawPayload.terminal
    : rawPayload;
  const response = decoder === "chat-completions"
    ? {
      choices: rawPayload.choices,
      usage: rawPayload.usage,
      model: rawPayload.model,
    }
    : {
      status: terminal.status,
      incomplete_details: terminal.incomplete_details,
      error: terminal.error,
      output: terminal.output,
      usage: terminal.usage,
      model: terminal.model,
    };
  // Echoed request fields can precede output and consume the entire bound.
  // Select response evidence first, retaining every field within each item.
  const payload = decoder === "responses" && terminal !== rawPayload
    ? { terminal: response, streamedItems: rawPayload.streamedItems }
    : response;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    responseBodyBytes: bytes.length,
    // Streaming decode omits a partial UTF-8 code point at the byte boundary.
    responseBodyExcerpt: new TextDecoder().decode(
      bytes.subarray(0, MAX_EMPTY_REPLY_BYTES),
      { stream: true },
    ),
    responseBodyTruncated: bytes.length > MAX_EMPTY_REPLY_BYTES,
    decision: {
      decoder,
      reason: "no-non-whitespace-text-or-tool-calls",
      contentCharacters: assistant.content.length,
      trimmedContentCharacters,
      toolCallCount,
    },
  };
};
