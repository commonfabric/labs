import {
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  isLLMNativeModelToolId,
} from "@commonfabric/llm/types";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { HarnessNativeModelToolId } from "../contracts/native-model-tool.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessNativeModelToolResult,
  HarnessToolCall,
  HarnessTranscriptMessage,
} from "../contracts/transcript.ts";
import {
  type OpenAIChatCompletionAttemptDiagnostic,
  type OpenAIChatCompletionMessage,
  type OpenAIChatCompletionRequest,
  type OpenAIChatCompletionRequestTool,
  type OpenAIChatCompletionResponse,
  type OpenAIChatCompletionTool,
  type OpenAIChatMessageContent,
  OpenAICompatibleGatewayClient,
  type OpenAIResponsesRequest,
} from "../gateway/openai-client.ts";
import {
  addFirstUserPromptCacheBreakpoint,
  assertPromptCacheModeSupported,
  normalizeTerminalResponse,
  providerRunAffinityKey,
  type ResponsesInputItem,
  toResponsesInput,
  toResponsesTools,
} from "./responses-protocol.ts";
import { materializeImageAttachmentContentPart } from "../image-attachments.ts";
import type {
  HarnessModelAttemptDiagnostic,
  HarnessModelCatalogEntry,
  HarnessModelClient,
  HarnessModelTurnRequest,
  HarnessModelTurnResult,
} from "./client.ts";
import {
  normalizeOpenAIUsage,
  withEstimatedOpenAIModelUsageCost,
} from "./usage.ts";

const normalizeTextContent = (
  content: OpenAIChatMessageContent | undefined,
): string => {
  if (typeof content === "string") return content;
  // Vertex-backed models omit `content` entirely on tool-call-only turns
  // (gemini-3.5-flash returns just role/thinking_blocks/tool_calls), so this
  // has to treat "absent" the same as "null" rather than assume an array.
  if (content === null || content === undefined) return "";
  return content.flatMap((part) =>
    isObjectOrArray(part) && part.type === "text" &&
      typeof part.text === "string"
      ? [part.text]
      : []
  ).join("");
};

export const toOpenAIChatMessage = async (
  message: HarnessTranscriptMessage,
): Promise<OpenAIChatCompletionMessage> => {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      if (!message.imageAttachments?.length) {
        return { role: "user", content: message.content };
      }
      return {
        role: "user",
        content: [
          ...(message.content.length > 0
            ? [{ type: "text" as const, text: message.content }]
            : []),
          ...(await Promise.all(
            message.imageAttachments.map(materializeImageAttachmentContentPart),
          )),
        ],
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls
          ? { tool_calls: message.toolCalls.map((call) => ({ ...call })) }
          : {}),
      };
    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      };
  }
};

const toNativeModelTools = (
  ids: readonly HarnessNativeModelToolId[],
): OpenAIChatCompletionRequestTool[] =>
  ids.map((id) => {
    if (!isLLMNativeModelToolId(id)) {
      throw new Error(
        `openai-compatible-gateway does not support native tool ${id}`,
      );
    }
    return { type: id };
  });

const createAssistantMessage = (
  response: OpenAIChatCompletionResponse,
): HarnessAssistantTranscriptMessage => {
  const message = response.choices[0]?.message;
  if (!message) {
    throw new Error(
      "chat completion response did not include a message choice",
    );
  }
  const toolCalls: HarnessToolCall[] | undefined = message.tool_calls?.map(
    (call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    }),
  );
  const nativeResults: HarnessNativeModelToolResult[] = [
    ...(response.native_model_tool_results?.map((result) => ({
      type: "cf-harness.native-model-tool-result" as const,
      toolId: result.type,
      ...(result.provider !== undefined ? { provider: result.provider } : {}),
      ...(result.providerMetadata !== undefined
        ? { providerMetadata: result.providerMetadata }
        : {}),
      ...(result.sources !== undefined ? { sources: result.sources } : {}),
    })) ?? []),
    ...(message.grounding_metadata === undefined ? [] : [{
      type: "cf-harness.native-model-tool-result" as const,
      toolId: GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
      provider: "google",
      providerMetadata: message.grounding_metadata,
    }]),
  ];
  return {
    role: "assistant",
    content: normalizeTextContent(message.content),
    ...(toolCalls ? { toolCalls } : {}),
    ...(nativeResults.length > 0
      ? { nativeModelToolResults: nativeResults }
      : {}),
  };
};

export const OPENAI_COMPATIBLE_GATEWAY_PROVIDER_ID =
  "openai-compatible-gateway";
const GATEWAY_RESPONSES_LABEL = "gateway Responses";

/**
 * Chooses the Responses API over Chat Completions for a turn.
 *
 * OpenAI's reasoning models reject function tools on `/v1/chat/completions`
 * unless reasoning is disabled outright, so every `gpt-*` turn goes to
 * `/v1/responses`, where tools and reasoning coexist.
 *
 * Two cases stay on Chat Completions because Responses cannot serve them:
 * provider-native tools such as `google_search` have no Responses equivalent
 * on this gateway, and non-OpenAI models (Vertex-backed `claude-*`/`gemini-*`)
 * are not translated to the Responses schema — the gateway answers 500. The
 * `web_search` subagent profile is exactly that combination.
 */
export const usesResponsesApi = (
  model: string,
  nativeModelToolIds: readonly HarnessNativeModelToolId[],
): boolean => nativeModelToolIds.length === 0 && model.startsWith("gpt-");

/**
 * Rejects a compaction threshold on a turn that cannot honor it.
 *
 * `context_management` is only sent on the Responses path, so a chat-routed
 * model would accept the option and silently ignore it — a user-supplied
 * control that appears to work while doing nothing. `0` stays legal
 * everywhere: its requested behavior is already "do not compact".
 */
export const assertCompactThresholdSupported = (
  model: string,
  nativeModelToolIds: readonly HarnessNativeModelToolId[],
  compactThreshold: number | undefined,
): void => {
  if (compactThreshold === undefined || compactThreshold === 0) return;
  if (!usesResponsesApi(model, nativeModelToolIds)) {
    throw new Error(
      `compact threshold ${compactThreshold} requires a model routed through ` +
        `the Responses API; received ${model}`,
    );
  }
};

/**
 * `gpt-*` models reason by default, and Chat Completions rejects function
 * tools whenever reasoning is active. Provider-native tools force a turn onto
 * Chat Completions, so combining them with an OpenAI model would route
 * straight into that 400 with cf-harness's function tools attached.
 *
 * The gateway's `web_search` profile overrides the model to Gemini. Reject
 * other combinations before dispatch rather than surfacing a provider error.
 */
const assertSupportedToolCombination = (
  model: string,
  nativeModelToolIds: readonly HarnessNativeModelToolId[],
): void => {
  if (model.startsWith("gpt-") && nativeModelToolIds.length > 0) {
    throw new Error(
      `openai-compatible-gateway cannot combine provider-native tools ` +
        `(${
          nativeModelToolIds.join(", ")
        }) with ${model}: native tools require ` +
        `chat completions, which rejects function tools while reasoning is on. ` +
        `Use a non-OpenAI model for native-tool turns.`,
    );
  }
};

const GPT_5_6_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const assertReasoningEffortSupported = (
  model: string,
  nativeModelToolIds: readonly HarnessNativeModelToolId[],
  effort: string | undefined,
): void => {
  if (effort === undefined) return;
  if (!usesResponsesApi(model, nativeModelToolIds)) {
    throw new Error(
      `reasoning effort ${effort} requires a model routed through the Responses API; received ${model}`,
    );
  }
  if (
    model.startsWith("gpt-5.6") &&
    !GPT_5_6_REASONING_EFFORTS.includes(
      effort as typeof GPT_5_6_REASONING_EFFORTS[number],
    )
  ) {
    throw new Error(
      `reasoning effort ${effort} is not supported by ${model}`,
    );
  }
};

/**
 * Fraction of the usable input budget at which server-side compaction fires.
 *
 * Chosen as a guard rather than an optimization: compacting costs extra on the
 * turn that does it, so firing early taxes short runs to benefit long ones. At
 * 75% it stays dormant for ordinary runs and engages once a built-up context
 * (large system prompt, preloaded skills, accumulated documents) approaches
 * the wall.
 */
export const COMPACT_THRESHOLD_FRACTION = 0.75;

/**
 * Derives the compaction threshold from the model's *input* budget.
 *
 * Deliberately not a fraction of `contextWindow`: the registry reports that as
 * input + output, and on the 400k models 75% of it is 300,000 against a hard
 * 272,000 input ceiling — a threshold past a wall the request can never reach,
 * so the guard would never fire in exactly the case it exists for.
 */
export const compactThresholdForBudget = (
  contextWindow: number | undefined,
  maxOutputTokens: number | undefined,
): number | undefined => {
  if (contextWindow === undefined || maxOutputTokens === undefined) {
    return undefined;
  }
  const inputBudget = contextWindow - maxOutputTokens;
  if (!Number.isFinite(inputBudget) || inputBudget <= 0) return undefined;
  return Math.floor(inputBudget * COMPACT_THRESHOLD_FRACTION);
};

const toModelAttempt = (
  attempt: OpenAIChatCompletionAttemptDiagnostic,
): HarnessModelAttemptDiagnostic => ({
  ...attempt,
  type: "cf-harness.model-attempt",
  providerId: OPENAI_COMPATIBLE_GATEWAY_PROVIDER_ID,
});

/**
 * Conservative text-byte footprint at which model-budget discovery starts.
 *
 * This is deliberately measured after Responses conversion rather than from
 * transcript text. The wire input also carries tool-call arguments, images,
 * encrypted continuation items, and tool schemas, any of which can dominate
 * the token count. UTF-8 bytes also vary less by script than characters do;
 * the floor only decides when one cached registry request becomes worthwhile.
 */
const BUDGET_DISCOVERY_FLOOR_BYTES = 200_000;

/**
 * Counts at most `limit` UTF-8 bytes without allocating an encoded copy.
 *
 * Unpaired surrogates follow `TextEncoder`: each becomes the three-byte
 * replacement character. Every UTF-16 code unit contributes at least one
 * byte, so a string already as long as the remaining limit can stop at once.
 */
const utf8ByteLengthUpTo = (text: string, limit: number): number => {
  if (limit <= 0 || text.length === 0) return 0;
  if (text.length >= limit) return limit;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index)!;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
      index += 1;
    }
    if (bytes >= limit) return limit;
  }
  return bytes;
};

/**
 * Walks the converted value graph rather than serializing it solely to
 * measure it. String values carry messages, tool arguments, image data, and
 * continuations; property names are included because schema keys are model
 * input too. The walk stops as soon as discovery becomes worthwhile.
 */
const responsesInputReachesDiscoveryFloor = (
  instructions: string | undefined,
  input: readonly ResponsesInputItem[],
  tools: readonly ResponsesInputItem[],
): boolean => {
  let remaining = BUDGET_DISCOVERY_FLOOR_BYTES;
  const pending: unknown[] = [input, tools];
  if (instructions !== undefined) pending.push(instructions);
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      remaining -= utf8ByteLengthUpTo(value, remaining);
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (isObjectOrArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        remaining -= utf8ByteLengthUpTo(key, remaining);
        if (remaining <= 0) return true;
        pending.push(child);
      }
    }
    if (remaining <= 0) return true;
  }
  return false;
};

export class OpenAICompatibleGatewayModelClient implements HarnessModelClient {
  readonly providerId = OPENAI_COMPATIBLE_GATEWAY_PROVIDER_ID;

  /** Input budgets by model id, keyed from the gateway registry. */
  readonly #compactThresholds = new Map<string, number>();

  /** Successful registry discovery is shared and cached per client. */
  #budgetDiscovery?: Promise<void>;

  constructor(readonly gatewayClient: OpenAICompatibleGatewayClient) {}

  /**
   * Populates model budgets so the default threshold applies without the
   * caller having to call `listModels()` first — nothing on the normal run
   * path does.
   *
   * A successful request runs at most once per client. A failed request never
   * fails the model turn, but is cleared so a later turn can try discovery
   * again instead of losing the compaction guard for the rest of the run.
   */
  #ensureBudgets(signal?: AbortSignal): Promise<void> {
    if (this.#budgetDiscovery !== undefined) return this.#budgetDiscovery;
    const discovery = this.listModels(signal)
      .then(() => {})
      .catch(() => {
        if (this.#budgetDiscovery === discovery) {
          this.#budgetDiscovery = undefined;
        }
      });
    this.#budgetDiscovery = discovery;
    return discovery;
  }

  async #resolveCompactThreshold(
    request: HarnessModelTurnRequest,
    instructions: string | undefined,
    input: readonly ResponsesInputItem[],
    tools: readonly ResponsesInputItem[],
  ): Promise<number | undefined> {
    if (request.compactThreshold !== undefined) {
      return request.compactThreshold > 0
        ? request.compactThreshold
        : undefined;
    }
    if (
      !this.#compactThresholds.has(request.model) &&
      responsesInputReachesDiscoveryFloor(instructions, input, tools)
    ) {
      await this.#ensureBudgets(request.signal);
    }
    return this.#compactThresholds.get(request.model);
  }

  async complete(
    request: HarnessModelTurnRequest,
  ): Promise<HarnessModelTurnResult> {
    toNativeModelTools(request.nativeModelToolIds);
    assertSupportedToolCombination(request.model, request.nativeModelToolIds);
    assertCompactThresholdSupported(
      request.model,
      request.nativeModelToolIds,
      request.compactThreshold,
    );
    assertPromptCacheModeSupported(request.model, request.promptCacheMode);
    assertReasoningEffortSupported(
      request.model,
      request.nativeModelToolIds,
      request.reasoningEffort,
    );
    return usesResponsesApi(request.model, request.nativeModelToolIds)
      ? await this.#completeViaResponses(request)
      : await this.#completeViaChatCompletions(request);
  }

  async #completeViaChatCompletions(
    request: HarnessModelTurnRequest,
  ): Promise<HarnessModelTurnResult> {
    const tools: OpenAIChatCompletionTool[] = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.toolId,
        description: tool.description,
        parameters: typeof tool.inputSchema === "boolean"
          ? tool.inputSchema
          : { ...tool.inputSchema },
      },
    }));
    const payload: OpenAIChatCompletionRequest = {
      model: request.model,
      messages: await Promise.all(request.transcript.map(toOpenAIChatMessage)),
      tools: [...tools, ...toNativeModelTools(request.nativeModelToolIds)],
      tool_choice: "auto",
    };
    const response = await this.gatewayClient.createChatCompletionJson(
      payload,
      {
        signal: request.signal,
        onChatCompletionAttempt: async (attempt) => {
          await request.onAttempt?.(toModelAttempt(attempt));
        },
      },
    );
    const usage = withEstimatedOpenAIModelUsageCost(
      request.model,
      normalizeOpenAIUsage(response.usage),
    );
    return {
      assistant: createAssistantMessage(response),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  async #completeViaResponses(
    request: HarnessModelTurnRequest,
  ): Promise<HarnessModelTurnResult> {
    const converted = await toResponsesInput(
      request.transcript,
      request.model,
      this.providerId,
      GATEWAY_RESPONSES_LABEL,
      undefined,
      // `--resume-run X --model other` is allowed here (the CLI pins the
      // provider on resume, not the model), so a continuation from the old
      // model is dropped rather than failing the run. Reasoning replay is an
      // optimization; the turn is still correct without it.
      "drop",
    );
    const tools = toResponsesTools(request.tools);
    const input = request.promptCacheMode === "explicit"
      ? addFirstUserPromptCacheBreakpoint(
        converted.input,
        GATEWAY_RESPONSES_LABEL,
      )
      : converted.input;
    const compactThreshold = await this.#resolveCompactThreshold(
      request,
      converted.instructions,
      input,
      tools,
    );
    const payload: OpenAIResponsesRequest = {
      model: request.model,
      store: false,
      ...(converted.instructions !== undefined
        ? { instructions: converted.instructions }
        : {}),
      input,
      ...(tools.length > 0 ? { tools } : {}),
      tool_choice: "auto",
      parallel_tool_calls: true,
      // Reasoning items are only replayable across turns when the provider
      // returns them encrypted, which `store: false` requires.
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: providerRunAffinityKey(
        request.cacheAffinityKey ?? request.runId,
      ),
      ...(compactThreshold !== undefined
        ? {
          context_management: [{
            type: "compaction" as const,
            compact_threshold: compactThreshold,
          }],
        }
        : {}),
      ...(request.promptCacheMode !== undefined
        ? {
          prompt_cache_options: {
            mode: request.promptCacheMode,
            ttl: "30m",
          } as const,
        }
        : {}),
      ...(request.reasoningEffort !== undefined
        ? { reasoning: { effort: request.reasoningEffort } }
        : {}),
    };
    const response = await this.gatewayClient.createResponseJson(
      payload,
      {
        signal: request.signal,
        onChatCompletionAttempt: async (attempt) => {
          await request.onAttempt?.(toModelAttempt(attempt));
        },
      },
    );
    const usage = withEstimatedOpenAIModelUsageCost(
      request.model,
      normalizeOpenAIUsage(response.usage),
    );
    return {
      assistant: normalizeTerminalResponse(
        response as unknown as Record<string, unknown>,
        request.model,
        this.providerId,
        GATEWAY_RESPONSES_LABEL,
      ),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  async listModels(
    signal?: AbortSignal,
  ): Promise<readonly HarnessModelCatalogEntry[]> {
    const response = await this.gatewayClient.listModels(signal);
    if (!response.ok) {
      throw new Error(`model list request failed (${response.status})`);
    }
    const json = await response.json() as {
      data?: Array<{ id?: unknown; capabilities?: Record<string, unknown> }>;
    };
    return (json.data ?? []).flatMap((item) => {
      if (typeof item.id !== "string") return [];
      const contextWindow = typeof item.capabilities?.contextWindow === "number"
        ? item.capabilities.contextWindow
        : undefined;
      const maxOutputTokens =
        typeof item.capabilities?.maxOutputTokens === "number"
          ? item.capabilities.maxOutputTokens
          : undefined;
      // Cache the derived threshold so `complete()` needs no registry fetch.
      const threshold = compactThresholdForBudget(
        contextWindow,
        maxOutputTokens,
      );
      if (threshold !== undefined) {
        this.#compactThresholds.set(item.id, threshold);
      }
      return [{
        id: item.id,
        displayName: item.id,
        inputModalities: item.capabilities?.images === true
          ? ["text", "image"]
          : ["text"],
        supportedReasoningEfforts: item.id.startsWith("gpt-5.6")
          ? GPT_5_6_REASONING_EFFORTS
          : [],
        supportsParallelToolCalls: false,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      }];
    });
  }
}
