import {
  type FinishReason,
  jsonSchema,
  type LanguageModelUsage,
  ModelMessage,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { trace } from "@opentelemetry/api";
import {
  type LLMNativeModelToolId,
  type LLMNativeModelToolResult,
  type LLMRequest,
} from "@commonfabric/llm/types";
import { type BuiltInLLMMessage } from "@commonfabric/api";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  LLMRequestError,
  LLMUpstreamError,
  upstreamStatusOf,
} from "./errors.ts";
import { type ModelConfig, resolveModel } from "./models.ts";
import { normalizeSchemaForProvider } from "./schema.ts";
import {
  metadataAttributeValue,
  runtimeContextFromMetadata,
} from "@/lib/ai-telemetry.ts";
import { withGatewayOperation } from "@/lib/gateway-provenance.ts";

// Constants for JSON mode
const JSON_SYSTEM_PROMPTS = {
  DEFAULT:
    "Ensure the response is valid JSON. DO NOT include any other text or formatting.",
  CLAUDE:
    "You are a JSON generation assistant. Your task is to generate valid, properly formatted JSON according to the user's request. Follow these guidelines:\n\n1. Only output valid JSON - no other text, explanations, or markdown formatting\n2. Ensure all keys and string values are properly quoted with double quotes\n3. Maintain proper nesting and indentation\n4. Close all brackets and braces properly\n5. Use proper JSON syntax with commas between elements but not after the last element in arrays or objects\n\nYour entire response must be a single valid JSON object or array that could be directly parsed by JSON.parse().",
  GROQ:
    "You must respond with pure, correct JSON only - no text descriptions, no ```json code blocks, and no formatting outside of valid JSON. Your entire response should be a valid JSON object that can be parsed directly by JSON.parse() with no additional processing.",
};

// Core generation logic separated from HTTP handling
export interface GenerateTextParams extends LLMRequest {
  abortSignal?: AbortSignal;
  // Updated callback to receive complete data for caching
  onStreamComplete?: (result: {
    message: BuiltInLLMMessage;
    messages: BuiltInLLMMessage[];
    originalRequest: GenerateTextParams;
  }) => void;
}

export interface GenerateTextResult {
  message: BuiltInLLMMessage;
  messages: BuiltInLLMMessage[];
  stream?: ReadableStream;
  spanId?: string;
}

// Configure the model parameters for JSON mode based on provider
export function configureJsonMode(
  streamParams: Record<string, unknown>,
  modelName: string,
  messages: BuiltInLLMMessage[],
  isStreaming: boolean,
): void {
  // Default to using the generic JSON mode
  streamParams.mode = "json";

  // Apply provider-specific configurations
  if (modelName?.startsWith("groq:")) {
    // Groq uses response_format parameter
    streamParams.response_format = { type: "json_object" };

    // Ensure it's also passed through providerOptions for the Vercel AI SDK
    streamParams.providerOptions = {
      ...(streamParams.providerOptions as object | undefined),
      groq: {
        response_format: { type: "json_object" },
      },
    };

    // Add a stronger system prompt for Groq to prevent markdown code blocks
    if (!streamParams.system) {
      streamParams.system = JSON_SYSTEM_PROMPTS.GROQ;
    } else {
      streamParams.system = streamParams.system + "\n\n" +
        JSON_SYSTEM_PROMPTS.GROQ;
    }

    // Remove standard mode parameter as Groq doesn't support it
    delete streamParams.mode;
  } else if (
    modelName?.startsWith("openai:") || modelName?.startsWith("gateway:")
  ) {
    // OpenAI uses response_format parameter
    streamParams.response_format = { type: "json_object" };

    // Ensure it's also passed through providerOptions for the Vercel AI SDK
    streamParams.providerOptions = {
      ...(streamParams.providerOptions as object | undefined),
      openai: {
        response_format: { type: "json_object" },
      },
    };

    // Remove the mode parameter since OpenAI uses response_format instead
    delete streamParams.mode;
  } else if (modelName?.startsWith("anthropic:")) {
    // Update or set system prompt for Claude
    if (!streamParams.system) {
      streamParams.system = JSON_SYSTEM_PROMPTS.CLAUDE;
    } else {
      // Prepend the JSON assistant role and append the JSON-specific instructions
      streamParams.system = "You are a JSON generation assistant. " +
        streamParams.system +
        "\n\nImportant: Your response must be ONLY valid JSON - no other text, explanations, or markdown formatting. The output should be directly parseable by JSON.parse().";
    }

    // Use prefill for non-streaming responses to anchor the JSON structure
    if (
      !isStreaming && messages.length > 0 &&
      messages[messages.length - 1].role === "user"
    ) {
      streamParams.prefill = {
        text: "{\n",
      };
    }
  } else {
    // For other providers, set a standard system prompt if one isn't provided
    if (!streamParams.system) {
      streamParams.system = JSON_SYSTEM_PROMPTS.DEFAULT;
    } else {
      // Always append JSON instructions, even if the prompt already mentions JSON
      streamParams.system += "\n" + JSON_SYSTEM_PROMPTS.DEFAULT;
    }
  }
}

// Add a helper function to clean up JSON responses from markdown code blocks
export function cleanJsonResponse(text: string): string {
  // Check if the response is wrapped in markdown code blocks
  const jsonCodeBlockRegex = /```(json)?\s*\n([\s\S]*?)\n```/;
  const match = text.match(jsonCodeBlockRegex);

  if (match && match[2]) {
    // Return just the JSON content inside the code block
    return match[2].trim();
  }

  return text;
}

export function applyNativeModelTools(
  streamParams: Record<string, unknown>,
  nativeModelToolIds: readonly LLMNativeModelToolId[] | undefined,
  modelConfig: Pick<ModelConfig, "name" | "nativeModelToolFactories">,
): void {
  if (nativeModelToolIds === undefined || nativeModelToolIds.length === 0) {
    return;
  }

  const tools = {
    ...((streamParams.tools as Record<string, unknown> | undefined) ?? {}),
  };
  for (const toolId of nativeModelToolIds) {
    if (tools[toolId] !== undefined) {
      throw new LLMRequestError(
        `Native model tool '${toolId}' conflicts with an existing tool definition`,
      );
    }
    const factory = modelConfig.nativeModelToolFactories?.[toolId];
    if (factory === undefined) {
      throw new LLMRequestError(
        `Native model tool '${toolId}' is not supported by model '${modelConfig.name}'`,
      );
    }
    tools[toolId] = factory();
  }
  streamParams.tools = tools;
}

// A description ends up in an HTTP response body as well as in the log, so
// cap it. A provider states a failure in a few hundred characters, but a proxy
// in front of one can answer with a whole HTML page.
const MAX_ERROR_DESCRIPTION_CHARS = 1000;

function truncateDescription(text: string): string {
  return text.length > MAX_ERROR_DESCRIPTION_CHARS
    ? `${text.slice(0, MAX_ERROR_DESCRIPTION_CHARS)}… (truncated)`
    : text;
}

/**
 * Renders a failure the AI SDK recorded as one line of text. An HTTP status
 * separates a request the provider turned down from a rate limit or an
 * outage. A normalized stream error includes the provider data the AI SDK
 * wrapped; raw response bodies stay in the cause that reaches the log.
 */
function describeStreamError(error: unknown): string {
  if (!isObjectOrArray(error)) {
    return truncateDescription(String(error));
  }
  if (!(error instanceof Error)) {
    // A provider can report a failure as a plain object lifted out of the
    // response rather than as an error.
    try {
      return truncateDescription(JSON.stringify(error));
    } catch {
      return truncateDescription(String(error));
    }
  }
  const { data, statusCode } = error as {
    data?: unknown;
    statusCode?: unknown;
  };
  const status = typeof statusCode === "number"
    ? `; HTTP status ${statusCode}`
    : "";
  const description = `${error.name}: ${
    truncateDescription(error.message)
  }${status}`;
  const providerData = error.name === "AI_StreamProviderError" &&
      data !== undefined && data !== error
    ? `; provider data: ${describeStreamError(data)}`
    : "";
  return providerData === ""
    ? description
    : truncateDescription(`${description}${providerData}`);
}

/**
 * Wraps a recorded stream failure for the caller to throw. The description
 * goes in the message because the message is all that reaches the client:
 * `llm.handlers.ts` puts it in the response body and drops the cause. The
 * cause carries the provider's own error, whose fields the log records.
 */
function streamFailureError(failure: unknown, modelName: string): Error {
  return new LLMUpstreamError(
    `LLM request to ${modelName} failed: ${describeStreamError(failure)}`,
    { cause: failure, upstreamStatus: upstreamStatusOf(failure) },
  );
}

// Reasons a response holds no text that say what the caller asked for rather
// than that the provider failed: an output budget spent before the first
// token, a turn the model answered with tool calls, a filter that refused the
// content. This route returns text alone, so a turn of tool calls arrives here
// as an empty response.
const CALLER_OWNED_FINISH_REASONS: ReadonlySet<FinishReason> = new Set(
  ["length", "tool-calls", "content-filter"],
);

/**
 * Describes a response that carried neither text nor a failure. The finish
 * reason says where it came from and the token counts show whether the model
 * wrote anything at all.
 */
async function emptyResponseError(
  llmStream: {
    finishReason: PromiseLike<FinishReason>;
    totalUsage: PromiseLike<LanguageModelUsage>;
  },
  modelName: string,
): Promise<Error> {
  const finishReason = await llmStream.finishReason;
  const usage = await llmStream.totalUsage;
  const message = `No text in the response from ${modelName} ` +
    `(finish reason: ${finishReason}, ` +
    `input tokens: ${usage.inputTokens ?? "unknown"}, ` +
    `output tokens: ${usage.outputTokens ?? "unknown"})`;
  return CALLER_OWNED_FINISH_REASONS.has(finishReason)
    ? new LLMRequestError(message)
    : new LLMUpstreamError(message);
}

async function readNativeModelToolResults(
  llmStream: unknown,
  nativeModelToolIds: readonly LLMNativeModelToolId[] | undefined,
  modelName: string,
): Promise<LLMNativeModelToolResult[] | undefined> {
  if (nativeModelToolIds === undefined || nativeModelToolIds.length === 0) {
    return undefined;
  }
  const stream = llmStream as {
    providerMetadata?: Promise<unknown> | unknown;
    sources?: Promise<unknown> | unknown;
  };
  const providerMetadata = await Promise.resolve(stream.providerMetadata);
  const sources = await Promise.resolve(stream.sources);
  if (providerMetadata === undefined && sources === undefined) {
    return undefined;
  }
  const provider = modelName.includes(":")
    ? modelName.split(":")[0]
    : undefined;
  return nativeModelToolIds.map((toolId) => ({
    type: "cf-harness.native-model-tool-result",
    toolId,
    ...(provider !== undefined ? { provider } : {}),
    ...(providerMetadata !== undefined ? { providerMetadata } : {}),
    ...(sources !== undefined ? { sources } : {}),
  }));
}

/**
 * A gateway-bound request reports the route it came from. The scope reaches
 * every request made while the call is awaited, which covers the SDK's
 * tool-calling steps on the non-streaming path. A streaming response is read
 * by its caller after this returns, so the steps it drives report no route.
 */
export function generateText(
  params: GenerateTextParams,
): Promise<GenerateTextResult> {
  return withGatewayOperation("generate-text", () => generateTextCall(params));
}

async function generateTextCall(
  params: GenerateTextParams,
): Promise<GenerateTextResult> {
  // Validate and configure model
  const modelConfig = await resolveModel(params.model!);
  if (!modelConfig) {
    console.error("Unsupported model:", params.model);
    throw new LLMRequestError(`Unsupported model: ${params.model}`);
  }

  // Groq models don't support streaming in JSON mode
  if (params.mode && params.stream && params.model?.startsWith("groq:")) {
    throw new LLMRequestError(
      "Groq models don't support streaming in JSON mode",
    );
  }

  // Since our BuiltInLLMMessage types are now aligned with Vercel AI SDK, no conversion needed
  const messages = params.messages as ModelMessage[];

  const streamParams: Parameters<typeof streamText>[0] = {
    model: modelConfig.model || params.model,
    messages,
    system: params.system,
    stopSequences: params.stop ? [params.stop] : undefined,
    abortSignal: params.abortSignal,
    telemetry: { isEnabled: true },
    maxOutputTokens: params.maxTokens,
    // The AI SDK otherwise sleeps and sends the request again twice before
    // reporting a failure, holding the caller's connection open meanwhile and
    // replacing the provider's answer with a wrapper that carries no status.
    // One attempt, reported as it happened, leaves the decision to retry with
    // the caller, who now has a status to make it on.
    maxRetries: 0,
    stopWhen: stepCountIs(8), // TODO(bf): low limit to prevent runaway process
  };

  // Convert client-side tools to AI SDK format (without execute functions for client-side execution)
  if (params.tools && Object.keys(params.tools).length > 0) {
    const aiSdkTools: Record<string, any> = {};

    for (const [name, toolDef] of Object.entries(params.tools)) {
      aiSdkTools[name] = tool({
        description: toolDef.description,
        inputSchema: jsonSchema(
          normalizeSchemaForProvider(toolDef.inputSchema),
        ),
        // NO execute function - this makes it client-side execution
      });
    }

    (streamParams as any).tools = aiSdkTools;
  }

  applyNativeModelTools(
    streamParams as Record<string, unknown>,
    params.nativeModelToolIds,
    modelConfig,
  );

  // remove stopSequences if the model doesn't support them
  if (!modelConfig.capabilities.stopSequences) {
    streamParams.stopSequences = undefined;
  }

  // Apply JSON mode configuration if requested
  if (params.mode) {
    configureJsonMode(
      streamParams,
      params.model,
      messages as BuiltInLLMMessage[],
      params.stream || false,
    );
  }

  // Handle models that don't support system prompts
  if (
    !modelConfig.capabilities.systemPrompt && params.system &&
    messages.length > 0
  ) {
    // Prepend system prompt to first message content
    // Content can be a string or an array of content parts
    const firstMessage = messages[0];
    if (typeof firstMessage.content === "string") {
      firstMessage.content = `${params.system}\n\n${firstMessage.content}`;
    } else if (Array.isArray(firstMessage.content)) {
      // Use type assertion to handle the union type properly
      firstMessage.content = [
        { type: "text" as const, text: params.system },
        ...firstMessage.content,
      ] as typeof firstMessage.content;
    } else {
      // Handle edge case: single object or unexpected type
      firstMessage.content = [
        { type: "text" as const, text: params.system },
        firstMessage.content,
      ] as typeof firstMessage.content;
    }
    streamParams.system = undefined;
  }

  // Add model-specific configuration
  if (modelConfig.model) {
    streamParams.model = modelConfig.model;
  }

  // Per-request metadata reaches the spans as runtime context.
  const { runtimeContext, includeRuntimeContext } = runtimeContextFromMetadata(
    params.metadata,
  );
  streamParams.runtimeContext = runtimeContext;
  streamParams.telemetry = { isEnabled: true, includeRuntimeContext };

  // Anything that goes wrong once the request is under way — a provider
  // rejecting it, a rate limit, a connection dropping mid-response, a stream
  // that ends without a finish chunk — reaches the caller as an `error` part
  // inside the stream instead of as a rejection. Both `textStream` and the
  // parts of `fullStream` read below drop those parts, so record the first
  // one here. Both paths then fail on it, including when text had already
  // arrived: a response cut short is reported rather than passed off as a
  // whole one.
  let streamFailure: unknown;
  streamParams.onError = ({ error }) => {
    streamFailure ??= error;
  };

  // This is where the LLM API call is made
  const llmStream = await streamText(streamParams);

  // Get the active span from OpenTelemetry and set attributes
  const activeSpan = trace.getActiveSpan();
  const spanId = activeSpan?.spanContext().spanId;

  // Attach the same metadata to the root span. This span is the HTTP request
  // span rather than one of the AI SDK spans, so it does not receive the runtime
  // context; recording it here through the same conversion keeps it consistent
  // with the AI SDK spans.
  if (activeSpan && params.metadata) {
    for (const [key, value] of Object.entries(params.metadata)) {
      const attribute = metadataAttributeValue(value);
      if (attribute !== undefined) {
        activeSpan.setAttribute(`metadata.${key}`, attribute);
      }
    }
  }

  // If not streaming, handle regular response
  if (!params.stream) {
    let result = "";
    for await (const delta of llmStream.textStream) {
      result += delta;
    }

    if (streamFailure !== undefined) {
      throw streamFailureError(streamFailure, modelConfig.name);
    }

    if (!result) {
      throw await emptyResponseError(llmStream, modelConfig.name);
    }

    // Clean up JSON responses when mode is enabled
    if (params.mode) {
      result = cleanJsonResponse(result);
    }

    // Only add stop token if not in JSON mode to avoid breaking JSON structure
    if (
      (await llmStream.finishReason) === "stop" && params.stop &&
      !params.mode
    ) {
      result += params.stop;
    }

    if (messages[messages.length - 1].role === "user") {
      messages.push({ role: "assistant", content: result });
    } else {
      messages[messages.length - 1].content = result;
    }
    const nativeModelToolResults = await readNativeModelToolResults(
      llmStream,
      params.nativeModelToolIds,
      modelConfig.name,
    );
    if (nativeModelToolResults !== undefined) {
      (messages[messages.length - 1] as any).nativeModelToolResults =
        nativeModelToolResults;
    }

    return {
      message: messages[messages.length - 1] as BuiltInLLMMessage,
      messages: [...messages] as BuiltInLLMMessage[],
      spanId,
    };
  }

  // Create streaming response
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        let result = "";
        const toolCalls: Array<{
          toolCallId: string;
          toolName: string;
          input: any;
        }> = [];

        // If last message was from assistant, send it first
        if (
          messages.length > 0 &&
          messages[messages.length - 1].role === "assistant"
        ) {
          const content = messages[messages.length - 1].content;
          // This `content` could be a structured content array, which isn't supported here.
          if (typeof content !== "string") {
            throw new Error("Structured content not supported in responses.");
          }
          result = content;
          controller.enqueue(encoder.encode(JSON.stringify(result) + "\n"));
        }

        // Stream each event from the full AI SDK stream
        for await (const part of llmStream.fullStream) {
          if (part.type === "text-delta") {
            result += part.text;
            // Send text delta event to client
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: "text-delta",
                  textDelta: part.text,
                }) + "\n",
              ),
            );
          } else if (part.type === "tool-call") {
            // Track tool calls for message history
            toolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            });
            // Send tool call event to client
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: "tool-call",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  args: part.input,
                }) + "\n",
              ),
            );
          } else if (part.type === "tool-result") {
            // Send tool result event to client
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: "tool-result",
                  toolCallId: part.toolCallId,
                  result: part.output,
                }) + "\n",
              ),
            );
          }
        }

        // Check before reading `finishReason`, which reports a failed stream
        // as a generic "no output generated" rejection that has lost the cause.
        if (streamFailure !== undefined) {
          throw streamFailureError(streamFailure, modelConfig.name);
        }

        // Only add stop token if not in JSON mode to avoid breaking JSON structure
        if (
          (await llmStream.finishReason) === "stop" && params.stop &&
          !params.mode
        ) {
          result += params.stop;
          controller.enqueue(
            encoder.encode(JSON.stringify(params.stop) + "\n"),
          );
        }

        // For JSON mode, clean the result to strip any markdown code blocks
        if (params.mode) {
          result = cleanJsonResponse(result);
        }

        // Update message history with proper content structure
        let assistantContent: BuiltInLLMMessage["content"];

        if (toolCalls.length > 0) {
          // Build structured content when tool calls are present
          const contentParts: BuiltInLLMMessage["content"] = [];
          if (result.trim()) {
            contentParts.push({ type: "text", text: result } as any);
          }
          for (const tc of toolCalls) {
            contentParts.push({
              type: "tool-call",
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.input,
            } as any);
          }
          assistantContent = contentParts as any;
        } else {
          // Plain text response
          assistantContent = result;
        }

        // Update message history
        if (messages[messages.length - 1].role === "user") {
          messages.push({
            role: "assistant",
            content: assistantContent,
          } as any);
        } else {
          messages[messages.length - 1].content = assistantContent as any;
        }
        const nativeModelToolResults = await readNativeModelToolResults(
          llmStream,
          params.nativeModelToolIds,
          modelConfig.name,
        );
        if (nativeModelToolResults !== undefined) {
          (messages[messages.length - 1] as any).nativeModelToolResults =
            nativeModelToolResults;
        }

        // Send finish event to client
        const finishEvent: {
          type: "finish";
          nativeModelToolResults?: LLMNativeModelToolResult[];
        } = { type: "finish" };
        if (nativeModelToolResults !== undefined) {
          finishEvent.nativeModelToolResults = nativeModelToolResults;
        }
        controller.enqueue(
          encoder.encode(
            JSON.stringify(finishEvent) + "\n",
          ),
        );

        // Call the onStreamComplete callback with all the data needed for caching
        if (params.onStreamComplete) {
          params.onStreamComplete({
            message: messages[messages.length - 1] as BuiltInLLMMessage,
            messages: [...messages] as BuiltInLLMMessage[],
            originalRequest: params,
          });
        }

        controller.close();
      } catch (error) {
        // Log error server-side for debugging
        console.error("[generateText Stream Error]:", error);
        // Send error event to client before closing stream
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              type: "error",
              error: errorMessage,
            }) + "\n",
          ),
        );
        controller.close();
      }
    },
  });

  return {
    message: messages[messages.length - 1] as BuiltInLLMMessage,
    messages: [...messages] as BuiltInLLMMessage[],
    stream,
    spanId,
  };
}
