import type { LLMNativeModelToolId } from "@commonfabric/llm/types";
import {
  defaultHarnessFetch,
  type HarnessFetch,
} from "../contracts/http-fetch.ts";
import {
  type HarnessProviderError,
  isTransientHttpStatus,
  providerErrorFromJsonText,
} from "../model/provider-error.ts";
import {
  type HarnessModelAttemptRetry,
  type HarnessTransportRetryOptions,
  TransportRetrySchedule,
} from "../model/transport-retry.ts";
import {
  currentProvenance,
  type HarnessProvenance,
  provenanceHeaders,
  provenanceUserAgent,
} from "../provenance.ts";

export interface OpenAICompatibleGatewayClientOptions
  extends HarnessTransportRetryOptions {
  baseUrl: string;
  authMode?: "bearer" | "none";
  apiKey?: string;
  apiKeySource?: string;
  fetchFn?: HarnessFetch;

  /**
   * Monotonic milliseconds, the source of every measured duration. Defaults to
   * `performance.now()`.
   */
  monotonicNowMs?: () => number;

  /**
   * What caused these requests. Resolved from the process when absent.
   */
  provenance?: HarnessProvenance;
}

export type OpenAIChatMessageRole = "system" | "user" | "assistant" | "tool";

export interface OpenAIChatCompletionFunctionTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown> | boolean;
}

export interface OpenAIChatCompletionTool {
  type: "function";
  function: OpenAIChatCompletionFunctionTool;
}

export interface OpenAIChatCompletionNativeModelTool {
  type: LLMNativeModelToolId;
  google_search?: Record<string, never>;
}

export type OpenAIChatCompletionRequestTool =
  | OpenAIChatCompletionTool
  | OpenAIChatCompletionNativeModelTool;

export interface OpenAIChatCompletionNativeModelToolResult {
  type: LLMNativeModelToolId;
  provider?: string;
  providerMetadata?: unknown;
  sources?: unknown;
}

export interface OpenAIChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type OpenAIChatMessageContentPart =
  | {
    type: "text";
    text: string;
  }
  | Record<string, unknown>;

export type OpenAIChatMessageContent =
  | string
  | readonly OpenAIChatMessageContentPart[]
  | null;

export interface OpenAIChatCompletionMessage {
  role: OpenAIChatMessageRole;

  /** Absent on tool-call-only turns from some providers, not just null. */
  content?: OpenAIChatMessageContent;

  tool_calls?: readonly OpenAIChatCompletionToolCall[];
  tool_call_id?: string;
  grounding_metadata?: unknown;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: readonly OpenAIChatCompletionMessage[];
  tools?: readonly OpenAIChatCompletionRequestTool[];
  native_model_tools?: readonly OpenAIChatCompletionNativeModelTool[];
  tool_choice?: "auto" | "none" | Record<string, unknown>;
}

/**
 * OpenAI Responses API payloads.
 *
 * The gateway serves `/v1/responses` for OpenAI-backed models. Unlike
 * `/v1/chat/completions`, it accepts function tools together with reasoning,
 * which is why cf-harness prefers it for reasoning models.
 */
export type OpenAIResponsesInputItem = Record<string, unknown>;

export interface OpenAIResponsesRequest {
  model: string;
  instructions?: string;
  input: readonly OpenAIResponsesInputItem[];
  tools?: readonly OpenAIResponsesInputItem[];
  tool_choice?: "auto" | "none" | Record<string, unknown>;
  parallel_tool_calls?: boolean;
  store?: boolean;
  stream?: boolean;
  include?: readonly string[];

  /**
   * Server-side compaction. When rendered tokens cross `compact_threshold`,
   * the provider folds prior context into an encrypted compaction item and
   * prunes before continuing inference.
   */
  context_management?: readonly {
    type: "compaction";
    compact_threshold: number;
  }[];

  prompt_cache_key?: string;
  prompt_cache_options?: {
    mode: "implicit" | "explicit";
    ttl?: "30m";
  };
  reasoning?: {
    effort: string;

    /** Asks for a readable summary of the reasoning in each reasoning item. */
    summary?: "auto" | "concise" | "detailed";
  };
}

export interface OpenAIResponsesResponse {
  id?: string;
  model?: string;
  status?: string;
  output?: readonly unknown[];
  usage?: Record<string, unknown>;
}

export interface OpenAIChatCompletionRequestDiagnosticSummary {
  model: string;
  messageCount: number;
  toolCount: number;
  nativeModelToolIds?: readonly LLMNativeModelToolId[];
  nativeModelToolCount: number;
  serializedBytes: number;
}

export type OpenAIChatCompletionAttemptOutcome =
  | "http_response"
  | "transport_error";

export type OpenAIGatewayOperation = "chat.completions" | "responses";

export interface OpenAIChatCompletionAttemptDiagnostic {
  type: "cf-harness.gateway.chat-completion-attempt";
  operation: OpenAIGatewayOperation;
  endpoint: string;
  attempt: number;
  maxTransportAttempts: number;
  startedAt: string;
  endedAt: string;

  /**
   * Elapsed time from request dispatch until the response headers arrive. A
   * gateway that sends headers ahead of the generated tokens ends this long
   * before the model is done, so it measures the transport rather than the
   * turn.
   */
  durationMs: number;

  /**
   * Elapsed time from request dispatch until the whole response body has been
   * read — the model's own working time, and the number to compare a turn
   * against wall clock with. Absent when the caller was handed the response
   * before its body was read, so this client never saw the exchange end.
   */
  responseCompleteDurationMs?: number;

  request: OpenAIChatCompletionRequestDiagnosticSummary;
  outcome: OpenAIChatCompletionAttemptOutcome;
  httpStatus?: number;
  httpStatusText?: string;
  requestId?: string;
  responseHeaders?: Record<string, string>;
  responseBodyBytes?: number;
  responseBodyExcerpt?: string;
  responseBodyTruncated?: boolean;
  errorDetail?: string;

  /** The provider's stated reason, when a non-2xx body carried one. */
  providerError?: HarnessProviderError;

  /**
   * Present when this attempt failed transiently and the client issued
   * another: what was transient, and the backoff before the next attempt.
   */
  retry?: HarnessModelAttemptRetry;
}

export interface OpenAIChatCompletionAttemptOptions {
  signal?: AbortSignal;
  onChatCompletionAttempt?: (
    diagnostic: OpenAIChatCompletionAttemptDiagnostic,
  ) => void | Promise<void>;
}

export interface OpenAIChatCompletionChoice {
  index: number;
  message: OpenAIChatCompletionMessage;
  finish_reason?: string | null;
}

export interface OpenAIChatCompletionResponse {
  id?: string;
  model?: string;
  choices: readonly OpenAIChatCompletionChoice[];
  usage?: Record<string, unknown>;
  native_model_tool_results?:
    readonly OpenAIChatCompletionNativeModelToolResult[];
  provider_metadata?: Record<string, unknown>;
  sources?: readonly unknown[];
}

const MAX_ERROR_BODY_EXCERPT_CHARS = 2_048;
const SELECTED_RESPONSE_HEADERS = [
  "x-request-id",
  "x-openai-request-id",
  "x-cf-request-id",
  "cf-ray",
  "retry-after",
  "content-type",
  "date",
] as const;
const REQUEST_ID_HEADER_NAMES = [
  "x-request-id",
  "x-openai-request-id",
  "x-cf-request-id",
  "cf-ray",
] as const;

const chatCompletionAbortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException(
    "chat completion request aborted",
    "AbortError",
  );

const throwIfChatCompletionAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw chatCompletionAbortReason(signal);
  }
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const textByteLength = (input: string): number =>
  new TextEncoder().encode(input).byteLength;

const summarizeChatCompletionRequest = (
  payload: OpenAIChatCompletionRequest,
  serializedPayload: string,
): OpenAIChatCompletionRequestDiagnosticSummary => {
  const nativeModelToolIds = [
    ...(payload.native_model_tools?.map((tool) => tool.type) ?? []),
    ...(payload.tools?.flatMap((tool) =>
      tool.type === "function" ? [] : [tool.type]
    ) ?? []),
  ];
  return {
    model: payload.model,
    messageCount: payload.messages.length,
    toolCount: payload.tools?.length ?? 0,
    ...(nativeModelToolIds.length > 0
      ? { nativeModelToolIds: [...nativeModelToolIds] }
      : {}),
    nativeModelToolCount: nativeModelToolIds.length,
    serializedBytes: textByteLength(serializedPayload),
  };
};

const summarizeResponsesRequest = (
  payload: OpenAIResponsesRequest,
  serializedPayload: string,
): OpenAIChatCompletionRequestDiagnosticSummary => ({
  model: payload.model,
  // `instructions` carries the system prompt, so count it alongside input items
  // to keep this comparable with the chat-completions message count.
  messageCount: payload.input.length +
    (payload.instructions !== undefined ? 1 : 0),
  toolCount: payload.tools?.length ?? 0,
  nativeModelToolCount: 0,
  serializedBytes: textByteLength(serializedPayload),
});

const selectResponseHeaders = (
  headers: Headers,
): Record<string, string> | undefined => {
  const selected: Record<string, string> = {};
  for (const header of SELECTED_RESPONSE_HEADERS) {
    const value = headers.get(header);
    if (value !== null) {
      selected[header] = value;
    }
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
};

const selectRequestId = (headers: Headers): string | undefined => {
  for (const header of REQUEST_ID_HEADER_NAMES) {
    const value = headers.get(header);
    if (value !== null && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
};

const responseBodyDiagnosticFields = (body: string) => ({
  responseBodyBytes: textByteLength(body),
  responseBodyExcerpt: body.slice(0, MAX_ERROR_BODY_EXCERPT_CHARS),
  responseBodyTruncated: body.length > MAX_ERROR_BODY_EXCERPT_CHARS,
});

const emitChatCompletionAttempt = async (
  options: OpenAIChatCompletionAttemptOptions | undefined,
  diagnostic: OpenAIChatCompletionAttemptDiagnostic,
): Promise<void> => {
  try {
    await options?.onChatCompletionAttempt?.(diagnostic);
  } catch {
    // Diagnostics must not change gateway request behavior.
  }
};

const transportErrorAfterRetries = (
  operation: OpenAIGatewayOperation,
  endpoint: URL,
  attempts: number,
  error: unknown,
): Error =>
  // Names the operation so a Responses failure is not reported as a chat
  // completion one. `diagnostics.ts` classifies timeouts by matching
  // "transport request failed", which stays stable across both operations.
  new Error(
    `${operation} transport request failed after ${attempts} ${
      attempts === 1 ? "attempt" : "attempts"
    } for ${endpoint.toString()}: ${errorMessage(error)}`,
  );

interface ChatCompletionFetchResult {
  response: Response;
  diagnostic: OpenAIChatCompletionAttemptDiagnostic;

  /** Monotonic reading taken as the returned attempt was dispatched. */
  dispatchedAtMs: number;

  /**
   * The body of a non-2xx response, read to classify and record the failure.
   * Absent for a 2xx response, whose body is left for the caller.
   */
  errorBody?: string;
}

export class OpenAICompatibleGatewayClient {
  readonly baseUrl: URL;
  readonly authMode: "bearer" | "none";
  readonly apiKey?: string;
  readonly apiKeySource?: string;
  readonly #fetchFn: HarnessFetch;
  readonly #retrySchedule: TransportRetrySchedule;
  readonly #provenance?: HarnessProvenance;
  readonly #monotonicNowMs: () => number;

  constructor(options: OpenAICompatibleGatewayClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.authMode = options.authMode ?? "bearer";
    this.apiKey = options.apiKey;
    this.apiKeySource = options.apiKeySource;
    this.#fetchFn = options.fetchFn ?? defaultHarnessFetch;
    this.#provenance = options.provenance;
    this.#retrySchedule = new TransportRetrySchedule(options);
    this.#monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());
  }

  /** Whole milliseconds elapsed since a monotonic reading. */
  #elapsedMsSince(startedAtMs: number): number {
    return Math.max(0, Math.round(this.#monotonicNowMs() - startedAtMs));
  }

  #requireApiKey(): string {
    const apiKey = this.apiKey?.trim();
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        "no API key configured; set CF_HARNESS_API_KEY or OPENAI_API_KEY",
      );
    }
    if (apiKey === "...") {
      const sourceText = this.apiKeySource !== undefined
        ? `${this.apiKeySource} is set to a placeholder value ('...'); provide a real API key`
        : "the configured API key is a placeholder value ('...'); provide a real API key";
      throw new Error(sourceText);
    }
    return apiKey;
  }

  endpoint(path: `/v1/${string}`): URL {
    return new URL(path, this.baseUrl);
  }

  /**
   * The headers every request carries, including the provenance that tells the
   * gateway what caused it.
   */
  headers(): HeadersInit {
    const provenance = this.#provenance ?? currentProvenance();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": provenanceUserAgent(provenance),
      ...provenanceHeaders(provenance),
    };
    if (this.authMode === "none") return headers;
    headers.Authorization = `Bearer ${this.#requireApiKey()}`;
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<Response> {
    return await this.#fetchFn(this.endpoint("/v1/models"), {
      headers: this.headers(),
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Issues a chat completion and returns the response for the caller to read.
   * A non-2xx response has already been read to record it, and comes back
   * with its body restored; a 2xx body is untouched.
   */
  async createChatCompletion(
    payload: OpenAIChatCompletionRequest,
    options: OpenAIChatCompletionAttemptOptions = {},
  ): Promise<Response> {
    const { response, diagnostic, errorBody } = await this
      .#fetchChatCompletion(payload, options);
    if (errorBody !== undefined) {
      return new Response(errorBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    await emitChatCompletionAttempt(options, diagnostic);
    return response;
  }

  async #fetchChatCompletion(
    payload: OpenAIChatCompletionRequest,
    options: OpenAIChatCompletionAttemptOptions,
  ): Promise<ChatCompletionFetchResult> {
    const serializedPayload = JSON.stringify(payload);
    return await this.#fetchOperation(
      this.endpoint("/v1/chat/completions"),
      "chat.completions",
      serializedPayload,
      summarizeChatCompletionRequest(payload, serializedPayload),
      options,
    );
  }

  async #fetchResponses(
    payload: OpenAIResponsesRequest,
    options: OpenAIChatCompletionAttemptOptions,
  ): Promise<ChatCompletionFetchResult> {
    const serializedPayload = JSON.stringify(payload);
    return await this.#fetchOperation(
      this.endpoint("/v1/responses"),
      "responses",
      serializedPayload,
      summarizeResponsesRequest(payload, serializedPayload),
      options,
    );
  }

  /**
   * Issues one operation until an attempt gets a 2xx response, a non-2xx
   * response the schedule does not retry, or the schedule runs out. Every
   * attempt is recorded; a non-2xx response is recorded here with its body,
   * and a 2xx response by whichever caller reads the body.
   */
  async #fetchOperation(
    endpoint: URL,
    operation: OpenAIGatewayOperation,
    serializedPayload: string,
    request: OpenAIChatCompletionRequestDiagnosticSummary,
    options: OpenAIChatCompletionAttemptOptions,
  ): Promise<ChatCompletionFetchResult> {
    const init: RequestInit = {
      method: "POST",
      headers: this.headers(),
      body: serializedPayload,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    const maxTransportAttempts = this.#retrySchedule.maxAttempts;
    for (let attempt = 1;; attempt += 1) {
      throwIfChatCompletionAborted(options.signal);
      const startedAt = new Date();
      const startedAtMs = this.#monotonicNowMs();
      const attemptBase = {
        type: "cf-harness.gateway.chat-completion-attempt" as const,
        operation,
        endpoint: endpoint.toString(),
        attempt,
        maxTransportAttempts,
        startedAt: startedAt.toISOString(),
        request,
      };
      let response: Response;
      try {
        response = await this.#fetchFn(endpoint, init);
      } catch (error) {
        const endedAt = new Date();
        // A transport failure ends the exchange where it is thrown, so the
        // two durations are one measurement.
        const durationMs = this.#elapsedMsSince(startedAtMs);
        // An aborted attempt is followed by nothing, so its record claims no
        // retry.
        const retry = options.signal?.aborted
          ? undefined
          : this.#retrySchedule.retryAfter(attempt, "transport_error");
        await emitChatCompletionAttempt(options, {
          ...attemptBase,
          endedAt: endedAt.toISOString(),
          durationMs,
          responseCompleteDurationMs: durationMs,
          outcome: "transport_error",
          errorDetail: errorMessage(error),
          ...(retry !== undefined ? { retry } : {}),
        });
        if (options.signal?.aborted) {
          throw chatCompletionAbortReason(options.signal);
        }
        if (retry === undefined) {
          throw transportErrorAfterRetries(operation, endpoint, attempt, error);
        }
        await this.#retrySchedule.waitBefore(attempt + 1, options.signal);
        continue;
      }
      const endedAt = new Date();
      const responseHeaders = selectResponseHeaders(response.headers);
      const requestId = selectRequestId(response.headers);
      const diagnostic: OpenAIChatCompletionAttemptDiagnostic = {
        ...attemptBase,
        endedAt: endedAt.toISOString(),
        durationMs: this.#elapsedMsSince(startedAtMs),
        outcome: "http_response",
        httpStatus: response.status,
        httpStatusText: response.statusText,
        ...(requestId !== undefined ? { requestId } : {}),
        ...(responseHeaders !== undefined ? { responseHeaders } : {}),
      };
      if (response.ok) {
        return { response, diagnostic, dispatchedAtMs: startedAtMs };
      }
      const errorBody = await response.text();
      const providerError = providerErrorFromJsonText(errorBody);
      const retry = this.#retrySchedule.retryAfter(
        attempt,
        isTransientHttpStatus(response.status) ? "http_status" : undefined,
      );
      const recorded: OpenAIChatCompletionAttemptDiagnostic = {
        ...diagnostic,
        responseCompleteDurationMs: this.#elapsedMsSince(startedAtMs),
        ...responseBodyDiagnosticFields(errorBody),
        ...(providerError !== undefined ? { providerError } : {}),
        ...(retry !== undefined ? { retry } : {}),
      };
      await emitChatCompletionAttempt(options, recorded);
      throwIfChatCompletionAborted(options.signal);
      if (retry === undefined) {
        return {
          response,
          diagnostic: recorded,
          dispatchedAtMs: startedAtMs,
          errorBody,
        };
      }
      await this.#retrySchedule.waitBefore(attempt + 1, options.signal);
    }
  }

  async createChatCompletionJson(
    payload: OpenAIChatCompletionRequest,
    options: OpenAIChatCompletionAttemptOptions = {},
  ): Promise<OpenAIChatCompletionResponse> {
    const { response, diagnostic, dispatchedAtMs, errorBody } = await this
      .#fetchChatCompletion(payload, options);
    if (errorBody !== undefined) {
      const body = errorBody;
      if (response.status === 401) {
        const sourceText = this.authMode === "none"
          ? "unauthenticated caller mode was used; gateway or upstream credentials rejected the request"
          : this.apiKeySource !== undefined
          ? `api key source: ${this.apiKeySource}; backend rejected the supplied key`
          : "supplied API key was rejected by the backend";
        throw new Error(
          `chat completion request failed (401, ${sourceText}): ${body}`,
        );
      }
      throw new Error(
        `chat completion request failed (${response.status}): ${body}`,
      );
    }
    return await this.#readJsonEmittingAttempt<OpenAIChatCompletionResponse>(
      response,
      diagnostic,
      dispatchedAtMs,
      options,
    );
  }

  async createResponseJson(
    payload: OpenAIResponsesRequest,
    options: OpenAIChatCompletionAttemptOptions = {},
  ): Promise<OpenAIResponsesResponse> {
    const { response, diagnostic, dispatchedAtMs, errorBody } = await this
      .#fetchResponses(payload, options);
    if (errorBody !== undefined) {
      const body = errorBody;
      if (response.status === 401) {
        const sourceText = this.authMode === "none"
          ? "unauthenticated caller mode was used; gateway or upstream credentials rejected the request"
          : this.apiKeySource !== undefined
          ? `api key source: ${this.apiKeySource}; backend rejected the supplied key`
          : "supplied API key was rejected by the backend";
        throw new Error(
          `responses request failed (401, ${sourceText}): ${body}`,
        );
      }
      // Gateways that front non-OpenAI providers (for example Vertex-backed
      // Claude and Gemini) cannot translate the Responses API and fail without
      // a usable body. Name that case so the model choice is the obvious fix.
      if (response.status >= 500 && body.trim() === "") {
        throw new Error(
          `responses request failed (${response.status}) with an empty body for model ${payload.model}; ` +
            "the gateway may not support the Responses API for this model's provider",
        );
      }
      throw new Error(
        `responses request failed (${response.status}): ${body}`,
      );
    }
    return await this.#readJsonEmittingAttempt<OpenAIResponsesResponse>(
      response,
      diagnostic,
      dispatchedAtMs,
      options,
    );
  }

  /**
   * Parses the body of a successful response and emits the one record this
   * attempt gets, whichever way the parse goes. A body that fails to arrive or
   * to parse never completed, so its record carries no
   * `responseCompleteDurationMs`.
   */
  async #readJsonEmittingAttempt<T>(
    response: Response,
    diagnostic: OpenAIChatCompletionAttemptDiagnostic,
    dispatchedAtMs: number,
    options: OpenAIChatCompletionAttemptOptions,
  ): Promise<T> {
    let parsed: T;
    try {
      parsed = await response.json() as T;
    } catch (error) {
      await emitChatCompletionAttempt(options, diagnostic);
      throw error;
    }
    await emitChatCompletionAttempt(options, {
      ...diagnostic,
      responseCompleteDurationMs: this.#elapsedMsSince(dispatchedAtMs),
    });
    return parsed;
  }
}
