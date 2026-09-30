import { OPENAI_WEB_SEARCH_NATIVE_MODEL_TOOL } from "../contracts/native-model-tool.ts";
import type { HarnessFetch } from "../contracts/http-fetch.ts";
import {
  type HarnessCredentialOwnerRef,
  harnessCredentialOwnersEqual,
} from "../contracts/run-manifest.ts";
import { defaultHarnessFetch } from "../contracts/http-fetch.ts";
import {
  describeProviderError,
  type HarnessProviderError,
  isTransientHttpStatus,
  isTransientProviderError,
  mapProviderError,
  providerErrorFromJsonText,
  providerErrorFromPayload,
} from "./provider-error.ts";
import {
  describeTerminalFailure,
  normalizeTerminalResponse,
  providerRunAffinityKey,
  toResponsesInput,
  toResponsesTools,
} from "./responses-protocol.ts";
import {
  type HarnessTransientFailureKind,
  type HarnessTransportRetryOptions,
  TransportRetrySchedule,
} from "./transport-retry.ts";
import type { OpenAICodexOAuthCredential } from "../auth/types.ts";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { HarnessControlError } from "../control-errors.ts";
import type {
  HarnessModelAttemptDiagnostic,
  HarnessModelCatalogEntry,
  HarnessModelClient,
  HarnessModelTurnRequest,
  HarnessModelTurnResult,
} from "./client.ts";
import { normalizeOpenAIUsage } from "./usage.ts";

export const OPENAI_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
export const OPENAI_CODEX_MODELS_URL =
  "https://chatgpt.com/backend-api/codex/models";
const OPENAI_CODEX_CLIENT_VERSION = "0.0.0";

export interface OpenAICodexCredentialResolverLike {
  readonly ownerKey?: string;
  readonly credentialOwner?: HarnessCredentialOwnerRef;
  resolve(signal?: AbortSignal): Promise<OpenAICodexOAuthCredential>;
}

export interface OpenAICodexResponsesClientOptions
  extends HarnessTransportRetryOptions {
  credentialResolver: OpenAICodexCredentialResolverLike;
  credentialOwner?: HarnessCredentialOwnerRef;
  fetchFn?: HarnessFetch;
  endpoint?: string;
  now?: () => Date;

  /**
   * Monotonic milliseconds, the source of every measured duration. Defaults to
   * `performance.now()`.
   */
  monotonicNowMs?: () => number;
}

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_RESPONSES_LABEL = "Codex Responses";

const providerUnavailable = (message: string): HarnessControlError =>
  new HarnessControlError("provider-unavailable", message);

const providerAuthRequired = (message: string): HarnessControlError =>
  new HarnessControlError("provider-auth-required", message);

const textBytes = (text: string): number =>
  new TextEncoder().encode(text).byteLength;

const redactCredentialValues = (
  text: string,
  credential: OpenAICodexOAuthCredential,
): string => {
  let redacted = text;
  for (
    const secret of [
      credential.accessToken,
      credential.refreshToken,
      credential.accountId,
    ]
  ) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("operation aborted", "AbortError");

/**
 * A stream that stopped before the provider finished with it: a read that
 * failed, or a body that ended mid-event or before the terminal event. The
 * connection went away, not the protocol, which is what makes the attempt
 * one to issue again.
 */
class StreamInterrupted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamInterrupted";
  }
}

async function* parseSse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    throw providerUnavailable("Codex Responses stream did not include a body");
  }
  const reader = response.body.getReader();
  if (signal?.aborted) {
    await reader.cancel(signal.reason).catch(() => {});
    throw abortReason(signal);
  }
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffered = "";
  let completed = false;
  try {
    while (true) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch {
        if (signal?.aborted) throw abortReason(signal);
        throw new StreamInterrupted("Codex Responses stream read failed");
      }
      const { value, done } = read;
      if (signal?.aborted) throw abortReason(signal);
      buffered += decoder.decode(value, { stream: !done });
      buffered = buffered.replaceAll("\r\n", "\n");
      let boundary: number;
      while ((boundary = buffered.indexOf("\n\n")) >= 0) {
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = block.split("\n").filter((line) =>
          line.startsWith("data:")
        )
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw providerUnavailable(
            "Codex Responses stream contained malformed JSON",
          );
        }
        if (!isObjectNotArray(parsed)) {
          throw providerUnavailable(
            "Codex Responses stream contained a non-object event",
          );
        }
        yield parsed as Record<string, unknown>;
      }
      if (done) break;
    }
    if (buffered.trim().length > 0) {
      throw new StreamInterrupted(
        "Codex Responses stream ended with an incomplete SSE event",
      );
    }
    completed = true;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

/** What one read of a Responses stream produced, up to where it stopped. */
interface StreamReading {
  /** Every completed output item the stream delivered, in order. */
  streamedItems: unknown[];

  /**
   * The terminal event's `response`, when the stream reached one. Absent when
   * the provider stated an error instead, or the stream ended first.
   */
  terminal?: Record<string, unknown>;

  /** The provider's stated error, when the stream ended on an `error` event. */
  providerError?: HarnessProviderError;
}

/**
 * Reads a Responses stream to its terminal event, its `error` event, or its
 * end. Throws the abort reason on abort, `StreamInterrupted` when the
 * connection goes before the provider is done, and a provider-unavailable
 * control error for a body that is not SSE-framed JSON events.
 */
const readResponsesStream = async (
  response: Response,
  signal: AbortSignal | undefined,
): Promise<StreamReading> => {
  // The ChatGPT Codex backend streams each completed output item via a
  // `response.output_item.done` event, but with `store: false` it returns an
  // EMPTY `output` array on the terminal `response.completed` event (it does
  // not assemble a stored response to echo back). Accumulate the streamed
  // items so the model's message and tool calls are not silently dropped.
  const streamedItems: unknown[] = [];
  for await (const event of parseSse(response, signal)) {
    const type = event.type;
    if (type === "response.output_item.done" && event.item !== undefined) {
      streamedItems.push(event.item);
    }
    if (type === "error") {
      return {
        streamedItems,
        providerError: providerErrorFromPayload(event) ??
          { message: "the provider stated no reason" },
      };
    }
    if (
      type === "response.completed" || type === "response.done" ||
      type === "response.incomplete" || type === "response.failed"
    ) {
      if (!isObjectNotArray(event.response)) {
        throw providerUnavailable(
          "Codex Responses terminal event did not include a response object",
        );
      }
      return {
        streamedItems,
        terminal: event.response as Record<string, unknown>,
      };
    }
  }
  return { streamedItems };
};

/**
 * The exchange one turn issues, fixed before the first attempt so every
 * attempt sends the same request.
 */
interface CodexExchange {
  request: HarnessModelTurnRequest;
  credential: OpenAICodexOAuthCredential;
  body: string;
  affinityKey: string;
}

/**
 * How one attempt ended: with a terminal response to normalize, or with the
 * error to throw and, when the schedule issues another attempt, the kind of
 * transient failure that justified it.
 */
type CodexAttemptOutcome =
  | { terminal: Record<string, unknown> }
  | { error: HarnessControlError; retry?: HarnessTransientFailureKind };

const selectedHeaders = (
  headers: Headers,
): Record<string, string> | undefined => {
  const selected: Record<string, string> = {};
  for (
    const name of [
      "x-request-id",
      "x-openai-request-id",
      "content-type",
    ]
  ) {
    const value = headers.get(name);
    if (value) selected[name] = value;
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
};

const emitAttempt = async (
  observer: HarnessModelTurnRequest["onAttempt"],
  attempt: HarnessModelAttemptDiagnostic,
): Promise<void> => {
  try {
    await observer?.(attempt);
  } catch {
    // Diagnostics cannot change provider behavior.
  }
};

/**
 * The control error for a non-2xx response. A usage-limit response stays
 * concise because its body is the account's, not the operator's; the
 * provider's stated reason for any other failure rides along, since a `503`
 * alone says nothing about whether waiting will help.
 */
const httpFailure = (
  status: number,
  providerError: HarnessProviderError | undefined,
): HarnessControlError => {
  if (status === 429) {
    return providerUnavailable("OpenAI Codex usage limit reached");
  }
  if (status === 401 || status === 403) {
    return providerAuthRequired(
      "OpenAI Codex authentication is no longer accepted",
    );
  }
  return providerUnavailable(
    `OpenAI Codex Responses request failed (${status})` +
      (providerError === undefined
        ? ""
        : `: ${describeProviderError(providerError)}`),
  );
};

/**
 * With `store: false` the ChatGPT Codex backend returns no assembled output
 * on the terminal event — an empty array, or (also observed on this backend)
 * `null` — even though it streamed the items. Fall back to what was
 * accumulated so downstream parsing sees the model's message and tool calls.
 * A POPULATED terminal output always wins (no double-counting); any other
 * malformed shape is left for `normalizeTerminalResponse()` to reject.
 */
const withStreamedOutput = (
  terminal: Record<string, unknown>,
  streamedItems: readonly unknown[],
): Record<string, unknown> => {
  const terminalOutputEmpty = terminal.output === null ||
    terminal.output === undefined ||
    (Array.isArray(terminal.output) && terminal.output.length === 0);
  return terminalOutputEmpty && streamedItems.length > 0
    ? { ...terminal, output: [...streamedItems] }
    : terminal;
};

export class OpenAICodexResponsesClient implements HarnessModelClient {
  readonly providerId = "openai-codex";
  readonly credentialOwner?: HarnessCredentialOwnerRef;
  readonly #resolver: OpenAICodexCredentialResolverLike;
  readonly #fetchFn: HarnessFetch;
  readonly #endpoint: string;
  readonly #now: () => Date;
  readonly #monotonicNowMs: () => number;
  readonly #retrySchedule: TransportRetrySchedule;

  constructor(options: OpenAICodexResponsesClientOptions) {
    this.#resolver = options.credentialResolver;
    const resolverOwner = options.credentialResolver.credentialOwner;
    const credentialOwner = options.credentialOwner ?? resolverOwner;
    if (
      credentialOwner !== undefined && resolverOwner !== undefined &&
      !harnessCredentialOwnersEqual(credentialOwner, resolverOwner)
    ) {
      throw new Error(
        "Codex credential resolver owner does not match the client owner",
      );
    }
    if (
      credentialOwner !== undefined &&
      options.credentialResolver.ownerKey !== undefined &&
      credentialOwner.ownerKey !== options.credentialResolver.ownerKey
    ) {
      throw new Error(
        "Codex credential resolver owner does not match the client owner",
      );
    }
    this.credentialOwner = credentialOwner === undefined
      ? undefined
      : structuredClone(credentialOwner);
    this.#fetchFn = options.fetchFn ?? defaultHarnessFetch;
    this.#endpoint = options.endpoint ?? OPENAI_CODEX_RESPONSES_URL;
    if (this.#endpoint !== OPENAI_CODEX_RESPONSES_URL) {
      throw new Error(
        "OpenAI Codex credentials may only be sent to the pinned Responses endpoint",
      );
    }
    this.#now = options.now ?? (() => new Date());
    this.#monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());
    this.#retrySchedule = new TransportRetrySchedule(options);
  }

  /** Whole milliseconds elapsed since a monotonic reading. */
  #elapsedMsSince(startedAtMs: number): number {
    return Math.max(0, Math.round(this.#monotonicNowMs() - startedAtMs));
  }

  async listModels(
    signal?: AbortSignal,
  ): Promise<readonly HarnessModelCatalogEntry[]> {
    const credential = await this.#resolver.resolve(signal);
    if (signal?.aborted) throw abortReason(signal);
    const url = new URL(OPENAI_CODEX_MODELS_URL);
    url.searchParams.set("client_version", OPENAI_CODEX_CLIENT_VERSION);
    let response: Response;
    try {
      response = await this.#fetchFn(url, {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "chatgpt-account-id": credential.accountId,
          originator: "cf-harness",
          "User-Agent": "cf-harness",
        },
        signal,
      });
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      throw providerUnavailable("OpenAI Codex model discovery failed");
    }
    if (signal?.aborted) {
      await response.body?.cancel(signal.reason).catch(() => {});
      throw abortReason(signal);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw providerAuthRequired(
          "OpenAI Codex authentication is no longer accepted",
        );
      }
      throw providerUnavailable(
        `OpenAI Codex model discovery failed (${response.status})`,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      throw providerUnavailable(
        "OpenAI Codex model discovery returned invalid JSON",
      );
    }
    if (signal?.aborted) throw abortReason(signal);
    if (!Array.isArray(body.models)) {
      throw providerUnavailable(
        "OpenAI Codex model discovery omitted the models array",
      );
    }
    return body.models.map((raw): HarnessModelCatalogEntry => {
      if (!isObjectNotArray(raw)) {
        throw providerUnavailable(
          "OpenAI Codex model discovery returned an invalid model",
        );
      }
      const model = raw as Record<string, unknown>;
      if (
        typeof model.slug !== "string" ||
        typeof model.display_name !== "string"
      ) {
        throw providerUnavailable(
          "OpenAI Codex model discovery returned an invalid model",
        );
      }
      const efforts = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.flatMap((entry) =>
          isObjectOrArray(entry) &&
            typeof (entry as Record<string, unknown>).effort === "string"
            ? [(entry as Record<string, unknown>).effort as string]
            : []
        )
        : [];
      const modalities = Array.isArray(model.input_modalities)
        ? model.input_modalities.filter((value): value is string =>
          typeof value === "string"
        )
        : [];
      return {
        id: model.slug,
        displayName: model.display_name,
        ...(typeof model.description === "string"
          ? { description: model.description }
          : {}),
        inputModalities: modalities,
        supportedReasoningEfforts: efforts,
        supportsParallelToolCalls: model.supports_parallel_tool_calls === true,
      };
    });
  }

  async complete(
    request: HarnessModelTurnRequest,
  ): Promise<HarnessModelTurnResult> {
    if (request.promptCacheMode !== undefined) {
      throw new Error(
        "prompt cache mode controls are not supported by openai-codex; omit promptCacheMode to use the subscription backend's implicit prompt cache",
      );
    }
    if (
      request.nativeModelToolIds.some((id) =>
        id !== OPENAI_WEB_SEARCH_NATIVE_MODEL_TOOL
      )
    ) {
      throw new Error(
        `openai-codex does not support native tools: ${
          request.nativeModelToolIds.join(", ")
        }`,
      );
    }
    // Accepting this silently would make a user-supplied control look
    // effective while nothing sends `context_management` on this path.
    if (
      request.compactThreshold !== undefined && request.compactThreshold > 0
    ) {
      throw new Error(
        "openai-codex does not support server-side compaction in this release",
      );
    }
    if (request.signal?.aborted) throw abortReason(request.signal);
    const converted = await toResponsesInput(
      request.transcript,
      request.model,
      OPENAI_CODEX_PROVIDER_ID,
      OPENAI_CODEX_RESPONSES_LABEL,
      "You are a helpful assistant.",
    );
    if (request.signal?.aborted) throw abortReason(request.signal);
    const credential = await this.#resolver.resolve(request.signal);
    if (request.signal?.aborted) throw abortReason(request.signal);
    const responseTools = toResponsesTools(request.tools);
    if (
      request.nativeModelToolIds.includes(OPENAI_WEB_SEARCH_NATIVE_MODEL_TOOL)
    ) {
      responseTools.push({ type: "web_search", external_web_access: true });
    }
    const affinityKey = providerRunAffinityKey(
      request.cacheAffinityKey ?? request.runId,
    );
    const body = JSON.stringify({
      model: request.model,
      store: false,
      stream: true,
      instructions: converted.instructions,
      input: converted.input,
      ...(responseTools.length > 0 ? { tools: responseTools } : {}),
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: affinityKey,
      ...(request.reasoningEffort !== undefined
        ? { reasoning: { effort: request.reasoningEffort } }
        : {}),
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    const exchange: CodexExchange = { request, credential, body, affinityKey };
    // Nothing leaves this loop until an attempt reaches a completed terminal
    // response, so a tool call streamed by an attempt that failed is never
    // the one the harness dispatches.
    for (let attempt = 1;; attempt += 1) {
      const outcome = await this.#attempt(exchange, attempt);
      if ("terminal" in outcome) {
        return this.#turnResult(outcome.terminal, request.model);
      }
      if (outcome.retry === undefined) throw outcome.error;
      await this.#retrySchedule.waitBefore(attempt + 1, request.signal);
    }
  }

  /**
   * Issues the exchange once and records the attempt, however it ends. A
   * transient failure comes back with the kind that makes it one when the
   * schedule has an attempt left; abort and protocol failures are thrown.
   */
  async #attempt(
    exchange: CodexExchange,
    attempt: number,
  ): Promise<CodexAttemptOutcome> {
    const { request, credential, body, affinityKey } = exchange;
    const redact = (text: string): string =>
      redactCredentialValues(text, credential);
    const startedAt = this.#now();
    const startedAtMs = this.#monotonicNowMs();
    const attemptBase = {
      type: "cf-harness.model-attempt" as const,
      providerId: this.providerId,
      operation: "responses.stream",
      endpoint: this.#endpoint,
      attempt,
      maxTransportAttempts: this.#retrySchedule.maxAttempts,
      startedAt: startedAt.toISOString(),
      request: {
        model: request.model,
        messageCount: request.transcript.length,
        toolCount: request.tools.length,
        nativeModelToolCount: request.nativeModelToolIds.length,
        nativeModelToolIds: request.nativeModelToolIds,
        serializedBytes: textBytes(body),
      },
    };
    // Records the attempt as failed and settles whether another follows. An
    // aborted attempt is followed by nothing, so its record claims no retry;
    // the abort itself is thrown after the record so an abort landing during
    // it is not reported as a provider failure.
    const failed = async (
      kind: HarnessTransientFailureKind | undefined,
      record: Omit<HarnessModelAttemptDiagnostic, keyof typeof attemptBase>,
      error: HarnessControlError,
    ): Promise<CodexAttemptOutcome> => {
      const retry = request.signal?.aborted
        ? undefined
        : this.#retrySchedule.retryAfter(attempt, kind);
      await emitAttempt(request.onAttempt, {
        ...attemptBase,
        ...record,
        ...(retry !== undefined ? { retry } : {}),
      });
      if (request.signal?.aborted) throw abortReason(request.signal);
      return retry === undefined ? { error } : { error, retry: retry.kind };
    };
    let response: Response;
    try {
      response = await this.#fetchFn(this.#endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "chatgpt-account-id": credential.accountId,
          originator: "cf-harness",
          "User-Agent": "cf-harness",
          "OpenAI-Beta": "responses=experimental",
          accept: "text/event-stream",
          "content-type": "application/json",
          "session-id": affinityKey,
          "x-client-request-id": crypto.randomUUID(),
        },
        body,
        signal: request.signal,
      });
      if (request.signal?.aborted) {
        await response.body?.cancel(request.signal.reason).catch(() => {});
        throw abortReason(request.signal);
      }
    } catch (error) {
      // A transport failure ends the exchange where it is thrown, so the two
      // durations are one measurement.
      const durationMs = this.#elapsedMsSince(startedAtMs);
      return await failed("transport_error", {
        endedAt: this.#now().toISOString(),
        durationMs,
        responseCompleteDurationMs: durationMs,
        outcome: "transport_error",
        errorDetail: redact(
          error instanceof Error ? error.message : String(error),
        ),
      }, providerUnavailable("OpenAI Codex transport request failed"));
    }
    const httpAttempt = {
      endedAt: this.#now().toISOString(),
      durationMs: this.#elapsedMsSince(startedAtMs),
      outcome: "http_response" as const,
      httpStatus: response.status,
      httpStatusText: response.statusText,
      ...(selectedHeaders(response.headers) !== undefined
        ? { responseHeaders: selectedHeaders(response.headers) }
        : {}),
    };
    if (!response.ok) {
      let responseBodyBytes: number | undefined;
      let providerError: HarnessProviderError | undefined;
      try {
        const text = await response.text();
        responseBodyBytes = textBytes(text);
        const stated = providerErrorFromJsonText(text);
        providerError = stated === undefined
          ? undefined
          : mapProviderError(stated, redact);
      } catch {
        if (request.signal?.aborted) throw abortReason(request.signal);
      }
      return await failed(
        isTransientHttpStatus(response.status) ? "http_status" : undefined,
        {
          ...httpAttempt,
          responseCompleteDurationMs: this.#elapsedMsSince(startedAtMs),
          ...(responseBodyBytes !== undefined ? { responseBodyBytes } : {}),
          ...(providerError !== undefined ? { providerError } : {}),
        },
        httpFailure(response.status, providerError),
      );
    }
    let reading: StreamReading;
    try {
      reading = await readResponsesStream(response, request.signal);
    } catch (error) {
      const completed = {
        ...httpAttempt,
        responseCompleteDurationMs: this.#elapsedMsSince(startedAtMs),
      };
      if (error instanceof StreamInterrupted) {
        return await failed(
          "transport_error",
          completed,
          providerUnavailable(error.message),
        );
      }
      // The generation happens across the stream, so the attempt is recorded
      // however the stream ended.
      await emitAttempt(request.onAttempt, { ...attemptBase, ...completed });
      throw error;
    }
    const completed = {
      ...httpAttempt,
      responseCompleteDurationMs: this.#elapsedMsSince(startedAtMs),
    };
    const transientKind = (
      providerError: HarnessProviderError | undefined,
    ): HarnessTransientFailureKind | undefined =>
      providerError !== undefined && isTransientProviderError(providerError)
        ? "provider_error"
        : undefined;
    if (reading.providerError !== undefined) {
      const providerError = mapProviderError(reading.providerError, redact);
      return await failed(
        transientKind(providerError),
        { ...completed, providerError },
        providerUnavailable(
          "OpenAI Codex Responses stream returned an error event: " +
            describeProviderError(providerError),
        ),
      );
    }
    if (reading.terminal === undefined) {
      return await failed(
        "transport_error",
        completed,
        providerUnavailable(
          "Codex Responses stream ended without a terminal response event",
        ),
      );
    }
    const terminal = withStreamedOutput(
      reading.terminal,
      reading.streamedItems,
    );
    const terminalFailure = describeTerminalFailure(
      terminal,
      OPENAI_CODEX_RESPONSES_LABEL,
    );
    if (terminalFailure !== undefined) {
      const stated = providerErrorFromPayload(terminal);
      const providerError = stated === undefined
        ? undefined
        : mapProviderError(stated, redact);
      return await failed(
        terminal.status === "failed" ? transientKind(providerError) : undefined,
        {
          ...completed,
          ...(providerError !== undefined ? { providerError } : {}),
        },
        providerUnavailable(redact(terminalFailure)),
      );
    }
    await emitAttempt(request.onAttempt, { ...attemptBase, ...completed });
    // Emitting the attempt is the last await the stream's own abort handling
    // does not cover, so an abort landing during it would otherwise surface as
    // a completed turn.
    if (request.signal?.aborted) throw abortReason(request.signal);
    return { terminal };
  }

  /** Normalizes a completed terminal response into the turn's result. */
  #turnResult(
    terminal: Record<string, unknown>,
    model: string,
  ): HarnessModelTurnResult {
    const rawUsage = isObjectNotArray(terminal.usage)
      ? terminal.usage
      : undefined;
    const normalizedUsage = normalizeOpenAIUsage(rawUsage);
    const usage = normalizedUsage === undefined ? undefined : {
      ...normalizedUsage,
      estimateWithheldReason: "provider-pricing-unavailable" as const,
    };
    let assistant: ReturnType<typeof normalizeTerminalResponse>;
    try {
      assistant = normalizeTerminalResponse(
        terminal,
        model,
        OPENAI_CODEX_PROVIDER_ID,
        OPENAI_CODEX_RESPONSES_LABEL,
      );
    } catch (error) {
      throw providerUnavailable(
        "OpenAI Codex returned an invalid terminal response: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    return {
      assistant,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}
