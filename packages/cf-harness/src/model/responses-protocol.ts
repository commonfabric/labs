import { encodeHex } from "@std/encoding/hex";

import { sha256 } from "@commonfabric/content-hash";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { OPENAI_WEB_SEARCH_NATIVE_MODEL_TOOL } from "../contracts/native-model-tool.ts";
import type { HarnessModelToolDescriptor } from "../contracts/tool-descriptor.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessProviderContinuation,
  HarnessToolCall,
  HarnessTranscriptMessage,
} from "../contracts/transcript.ts";
import { materializeImageAttachmentContentPart } from "../image-attachments.ts";
import { codexSearchSources } from "./codex-search-evidence.ts";
import {
  describeProviderError,
  providerErrorFromPayload,
} from "./provider-error.ts";

/**
 * Shared OpenAI Responses API wire mapping.
 *
 * Both the Codex client (owner-authenticated, pinned chatgpt.com endpoint) and
 * the OpenAI-compatible gateway client speak this protocol, so the transcript
 * conversion and terminal-response normalization live here. Provider-specific
 * pieces stay with each client: transport, auth, and streaming vs single-shot.
 *
 * `providerId` scopes continuation state so one provider never replays another
 * provider's reasoning items; `label` keeps error text in the caller's voice.
 */
export type ResponsesInputItem = Record<string, unknown>;

const MAX_PROVIDER_AFFINITY_KEY_LENGTH = 64;

/**
 * Bounds a run id for use as `prompt_cache_key`, which the provider caps at 64
 * characters and rejects outright above it.
 *
 * Subagent run ids are derived as `<parent>.subagent.<n>`, so they grow with
 * nesting depth and reach the cap on their own. Long ids keep a readable
 * prefix and a digest suffix so cache affinity stays stable per run.
 */
export const providerRunAffinityKey = (runId: string): string => {
  if (runId.length <= MAX_PROVIDER_AFFINITY_KEY_LENGTH) return runId;
  const digest = encodeHex(sha256(new TextEncoder().encode(runId))).slice(
    0,
    40,
  );
  const prefixLength = MAX_PROVIDER_AFFINITY_KEY_LENGTH - digest.length - 1;
  return `${runId.slice(0, prefixLength)}-${digest}`;
};

export const assertPromptCacheModeSupported = (
  model: string,
  mode: "implicit" | "explicit" | undefined,
): void => {
  if (mode !== undefined && !model.startsWith("gpt-5.6")) {
    throw new Error(
      `prompt cache mode ${mode} requires a GPT-5.6 model; received ${model}`,
    );
  }
};

/**
 * What to do when a stored continuation was produced by a different model.
 *
 * The encrypted reasoning is bound to the model that produced it, so it can
 * never be replayed to another one. Providers differ on whether that is fatal:
 * Codex pins the provider on resume and treats a mismatch as a caller error,
 * while the gateway lets `--resume-run X --model other` change models, where
 * the reasoning is optional and dropping it just costs continuity.
 */
export type ContinuationModelMismatch = "throw" | "drop";

/**
 * Opaque items the provider returns for replay on later turns.
 *
 * `reasoning` carries the model's thinking for the turn that produced it.
 * `compaction` carries *everything before it* — server-side compaction folds
 * the prior context into one encrypted item — which is why a compaction item
 * lets the transcript ahead of it be dropped.
 */
const REPLAYABLE_ITEM_TYPES = ["reasoning", "compaction"] as const;

const isReplayableItem = (item: unknown): item is ResponsesInputItem => {
  if (!isObjectOrArray(item)) return false;
  const record = item as Record<string, unknown>;
  return (REPLAYABLE_ITEM_TYPES as readonly string[]).includes(
    record.type as string,
  ) && typeof record.id === "string" &&
    typeof record.encrypted_content === "string";
};

const isCompactionItem = (item: unknown): boolean =>
  isReplayableItem(item) &&
  (item as Record<string, unknown>).type === "compaction";

export const continuationOutput = (
  continuation: HarnessProviderContinuation | undefined,
  model: string,
  providerId: string,
  onModelMismatch: ContinuationModelMismatch = "throw",
  // Compaction items are emitted once at the pruning boundary, so replaying
  // them again with their own message would duplicate them.
  include: "all" | "reasoning-only" = "all",
): ResponsesInputItem[] => {
  if (continuation?.providerId !== providerId) return [];
  const state = continuation.state;
  if (!isObjectNotArray(state)) {
    return [];
  }
  const record = state as Record<string, unknown>;
  if (
    (record.version !== 1 && record.version !== 2) ||
    typeof record.sourceModel !== "string"
  ) return [];
  if (record.sourceModel !== model) {
    if (onModelMismatch === "throw") {
      throw new Error(
        `${providerId} continuation model ${record.sourceModel} does not match requested model ${model}`,
      );
    }
    return [];
  }
  const output = record.output;
  if (!Array.isArray(output)) return [];
  return output.flatMap((item) =>
    isReplayableItem(item) &&
      !(include === "reasoning-only" && isCompactionItem(item))
      ? [structuredClone(item)]
      : []
  );
};

/**
 * Compaction items recorded on an assistant message, if any.
 *
 * Used to find the pruning boundary: the newest assistant turn whose
 * continuation carries compaction supersedes everything before it.
 */
export const continuationCompaction = (
  continuation: HarnessProviderContinuation | undefined,
  model: string,
  providerId: string,
): ResponsesInputItem[] => {
  const items = continuationOutput(continuation, model, providerId, "drop");
  return items.filter(isCompactionItem);
};

export const continuationFunctionCallItemId = (
  continuation: HarnessProviderContinuation | undefined,
  callId: string,
  model: string,
  providerId: string,
): string | undefined => {
  if (
    continuation?.providerId !== providerId ||
    !isObjectNotArray(continuation.state)
  ) return undefined;
  const record = continuation.state as Record<string, unknown>;
  if (
    (record.version !== 1 && record.version !== 2) ||
    record.sourceModel !== model
  ) return undefined;
  const ids = record.functionCallItemIds;
  if (!isObjectNotArray(ids)) {
    return undefined;
  }
  const itemId = (ids as Record<string, unknown>)[callId];
  return typeof itemId === "string" ? itemId : undefined;
};

/**
 * Search-bearing output is replayed in its original order only while its
 * assistant projection remains unchanged. Filters may rewrite text, calls, or
 * native evidence; reconstruction must not resurrect the provider's old answer.
 */
const unchangedSearchOutput = (
  message: HarnessAssistantTranscriptMessage,
  model: string,
  providerId: string,
): ResponsesInputItem[] | undefined => {
  const continuation = message.providerContinuation;
  if (
    providerId !== "openai-codex" || continuation?.providerId !== providerId
  ) return undefined;
  const state = continuation.state;
  if (!isObjectNotArray(state)) {
    return undefined;
  }
  const record = state as Record<string, unknown>;
  if (
    record.version !== 2 || record.sourceModel !== model ||
    !Array.isArray(record.searchOutput)
  ) return undefined;
  if (
    !record.searchOutput.every((item) => {
      if (
        typeof item !== "object" || item === null || Array.isArray(item)
      ) return false;
      return isReplayableItem(item) ||
        (item.type === "message" && item.role === "assistant" &&
          Array.isArray(item.content)) ||
        (item.type === "web_search_call" && typeof item.id === "string" &&
          typeof item.status === "string") ||
        (item.type === "function_call" && typeof item.call_id === "string" &&
          typeof item.name === "string" && typeof item.arguments === "string");
    })
  ) return undefined;
  // Use the same projection as ingestion rather than trusting a second saved
  // copy of the text, calls, or evidence. Invalid optional replay state falls
  // back to the current transcript rather than replacing it with stale text.
  let projection: HarnessAssistantTranscriptMessage;
  try {
    projection = normalizeTerminalResponse(
      { status: "completed", output: record.searchOutput },
      model,
      providerId,
      "stored search",
    );
  } catch {
    return undefined;
  }
  if (
    projection.content !== message.content ||
    JSON.stringify(projection.toolCalls ?? []) !==
      JSON.stringify(message.toolCalls ?? []) ||
    JSON.stringify(projection.nativeModelToolResults ?? []) !==
      JSON.stringify(message.nativeModelToolResults ?? [])
  ) return undefined;
  return structuredClone(record.searchOutput);
};

export const materializeUserContent = async (
  message: Extract<HarnessTranscriptMessage, { role: "user" }>,
  label: string,
): Promise<ResponsesInputItem[]> => {
  const content: ResponsesInputItem[] = message.content.length > 0
    ? [{ type: "input_text", text: message.content }]
    : [];
  for (const attachment of message.imageAttachments ?? []) {
    const part = await materializeImageAttachmentContentPart(attachment);
    const partRecord = part as Record<string, unknown>;
    const imageUrl = isObjectOrArray(partRecord.image_url)
      ? (partRecord.image_url as Record<string, unknown>).url
      : undefined;
    if (typeof imageUrl !== "string") {
      throw new Error(
        `failed to materialize image attachment for ${label}`,
      );
    }
    content.push({ type: "input_image", detail: "auto", image_url: imageUrl });
  }
  return content;
};

export const toResponsesInput = async (
  transcript: readonly HarnessTranscriptMessage[],
  model: string,
  providerId: string,
  label: string,
  // Used only when the transcript carries no system message. Callers that omit
  // it send no `instructions` at all, so a run without a system prompt is not
  // silently given one.
  defaultInstructions?: string,
  onModelMismatch: ContinuationModelMismatch = "throw",
): Promise<
  { instructions: string | undefined; input: ResponsesInputItem[] }
> => {
  // Instructions always come from the whole transcript: pruning drops earlier
  // turns from `input`, and the system prompt must survive that.
  const systemText = transcript.filter((message) => message.role === "system")
    .map((message) => message.content).join("\n\n");
  const instructions = systemText.length > 0 ? systemText : defaultInstructions;

  // Prune at the newest assistant turn carrying compaction: that item already
  // encodes everything before it. Starting at an assistant message keeps
  // `function_call`/`function_call_output` pairs intact — slicing anywhere
  // else could orphan a tool result from the call that produced it.
  let boundary = 0;
  let carried: ResponsesInputItem[] = [];
  for (const [index, message] of transcript.entries()) {
    if (message.role !== "assistant") continue;
    const compaction = continuationCompaction(
      message.providerContinuation,
      model,
      providerId,
    );
    if (compaction.length > 0) {
      boundary = index;
      carried = compaction;
    }
  }

  const input: ResponsesInputItem[] = [...carried];
  for (const [index, message] of transcript.entries()) {
    if (index < boundary) continue;
    switch (message.role) {
      case "system":
        break;
      case "user": {
        const content = await materializeUserContent(message, label);
        if (content.length > 0) input.push({ role: "user", content });
        break;
      }
      case "assistant": {
        // Run the existing model/provider guard even when exact replay is possible.
        const carriedOutput = continuationOutput(
          message.providerContinuation,
          model,
          providerId,
          onModelMismatch,
          index === boundary && carried.length > 0 ? "reasoning-only" : "all",
        );
        const searchOutput = unchangedSearchOutput(message, model, providerId);
        if (searchOutput !== undefined) {
          input.push(
            ...searchOutput.filter((item) =>
              !(index === boundary && carried.length > 0 &&
                isCompactionItem(item))
            ),
          );
          break;
        }
        input.push(
          ...carriedOutput,
        );
        if (message.content.length > 0) {
          input.push({
            type: "message",
            id: `msg_cf_${index}`,
            role: "assistant",
            status: "completed",
            content: [{
              type: "output_text",
              text: message.content,
              annotations: [],
            }],
          });
        }
        for (const call of message.toolCalls ?? []) {
          const itemId = continuationFunctionCallItemId(
            message.providerContinuation,
            call.id,
            model,
            providerId,
          );
          input.push({
            type: "function_call",
            ...(itemId !== undefined ? { id: itemId } : {}),
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        break;
      }
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.content,
        });
        break;
    }
  }
  return { instructions, input };
};

export const toResponsesTools = (
  tools: readonly HarnessModelToolDescriptor[],
): ResponsesInputItem[] =>
  tools.map((tool) => ({
    type: "function",
    name: tool.toolId,
    description: tool.description,
    parameters: typeof tool.inputSchema === "boolean"
      ? tool.inputSchema
      : { ...tool.inputSchema },
    strict: null,
  }));

/**
 * Marks the first user-message prefix as the stable explicit cache boundary.
 *
 * The initial user message is immutable as the harness appends assistant and
 * tool messages, so later model turns can reuse this prefix without creating a
 * new cache write for every growing transcript.
 */
export const addFirstUserPromptCacheBreakpoint = (
  input: readonly ResponsesInputItem[],
  providerLabel: string,
): ResponsesInputItem[] => {
  const copied = [...input];
  for (let itemIndex = 0; itemIndex < input.length; itemIndex += 1) {
    const item = input[itemIndex];
    if (item.role !== "user" || !Array.isArray(item.content)) continue;
    const content = item.content;
    for (let index = content.length - 1; index >= 0; index -= 1) {
      const block = content[index];
      if (!isObjectOrArray(block)) continue;
      if (
        !("type" in block) ||
        (block.type !== "input_text" && block.type !== "input_image" &&
          block.type !== "input_file")
      ) continue;
      const copiedContent = [...content];
      copiedContent[index] = {
        ...block,
        prompt_cache_breakpoint: { mode: "explicit" },
      };
      copied[itemIndex] = { ...item, content: copiedContent };
      return copied;
    }
  }
  throw new Error(
    `${providerLabel} explicit prompt caching requires a cacheable user content block`,
  );
};

/**
 * The message for a terminal response whose status says the provider did not
 * finish — `failed`, `incomplete`, or `cancelled` — carrying the provider's
 * stated reason when the response has one, or `undefined` for any other
 * status.
 */
export const describeTerminalFailure = (
  response: Record<string, unknown>,
  label: string,
): string | undefined => {
  const status = response.status;
  if (
    status !== "incomplete" && status !== "failed" && status !== "cancelled"
  ) {
    return undefined;
  }
  const providerError = providerErrorFromPayload(response);
  return `${label} ended with status ${status}` +
    (providerError === undefined
      ? ""
      : `: ${describeProviderError(providerError)}`);
};

export const normalizeTerminalResponse = (
  response: Record<string, unknown>,
  sourceModel: string,
  providerId: string,
  label: string,
): HarnessAssistantTranscriptMessage => {
  const failure = describeTerminalFailure(response, label);
  if (failure !== undefined) throw new Error(failure);
  const status = response.status;
  if (status !== "completed") {
    throw new Error(`${label} terminal event has an unknown status`);
  }
  const output = response.output;
  if (!Array.isArray(output)) {
    throw new Error(`${label} terminal event did not include output`);
  }
  const text: string[] = [];
  const toolCalls: HarnessToolCall[] = [];
  const toolCallById = new Map<string, HarnessToolCall>();
  const continuation: ResponsesInputItem[] = [];
  const functionCallItemIds: Record<string, string> = {};
  const orderedOutput: ResponsesInputItem[] = [];
  const searchCalls: ResponsesInputItem[] = [];
  for (const rawItem of output) {
    if (!isObjectNotArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type === "message" && Array.isArray(item.content)) {
      orderedOutput.push(structuredClone(item));
      for (const rawContent of item.content) {
        if (!isObjectOrArray(rawContent)) continue;
        const content = rawContent as Record<string, unknown>;
        if (
          content.type === "output_text" && typeof content.text === "string"
        ) {
          text.push(content.text);
        } else if (
          content.type === "refusal" && typeof content.refusal === "string"
        ) {
          text.push(content.refusal);
        }
      }
    } else if (item.type === "function_call") {
      if (
        typeof item.call_id !== "string" || typeof item.name !== "string" ||
        typeof item.arguments !== "string"
      ) {
        throw new Error(`${label} included an incomplete tool call`);
      }
      const call: HarnessToolCall = {
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      };
      if (typeof item.id === "string") {
        functionCallItemIds[call.id] = item.id;
      }
      const previous = toolCallById.get(call.id);
      if (previous !== undefined) {
        if (JSON.stringify(previous) !== JSON.stringify(call)) {
          throw new Error(
            `${label} included conflicting duplicate tool-call ids`,
          );
        }
        continue;
      }
      toolCallById.set(call.id, call);
      toolCalls.push(call);
      orderedOutput.push(structuredClone(item));
    } else if (
      providerId === "openai-codex" && item.type === "web_search_call" &&
      typeof item.id === "string" && typeof item.status === "string"
    ) {
      searchCalls.push(structuredClone(item));
      orderedOutput.push(structuredClone(item));
    } else if (isReplayableItem(item)) {
      // Compaction carries the context before it; retain it for pruning too.
      continuation.push(structuredClone(item));
      orderedOutput.push(structuredClone(item));
    }
  }
  const content = text.join("");
  const sources = providerId === "openai-codex"
    ? codexSearchSources(orderedOutput)
    : [];
  const hasSearchEvidence = searchCalls.length > 0 || sources.length > 0;
  return {
    role: "assistant",
    content,
    ...(hasSearchEvidence
      ? {
        nativeModelToolResults: [{
          type: "cf-harness.native-model-tool-result" as const,
          toolId: OPENAI_WEB_SEARCH_NATIVE_MODEL_TOOL,
          provider: "openai-codex" as const,
          providerMetadata: { searchCalls },
          sources,
        }],
      }
      : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(hasSearchEvidence || continuation.length > 0 ||
        Object.keys(functionCallItemIds).length > 0
      ? {
        providerContinuation: {
          providerId,
          state: {
            version: hasSearchEvidence ? 2 : 1,
            sourceModel,
            output: continuation,
            ...(hasSearchEvidence
              ? {
                searchOutput: orderedOutput,
              }
              : {}),
            ...(Object.keys(functionCallItemIds).length > 0
              ? { functionCallItemIds }
              : {}),
          },
        },
      }
      : {}),
  };
};
