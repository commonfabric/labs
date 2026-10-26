import {
  isLLMNativeModelToolResults,
  LLMGenerateObjectRequest,
  LLMGenerateObjectResponse,
  type LLMNativeModelToolResult,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
  LLMToolResult,
} from "./types.ts";
import { assertJsonTransportSafe } from "./schema-transport.ts";

type PartialCallback = (text: string) => void;

export class LLMStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMStreamError";
  }
}

/**
 * Detect if we're running in a test environment.
 * Checks CI=true (CI runners) and ENV=test (set by deno task test).
 * Evaluated once at module load — these vars never change mid-process.
 */
const _isTestEnvironment = (() => {
  try {
    return Deno?.env?.get?.("CI") === "true" ||
      Deno?.env?.get?.("ENV") === "test";
  } catch {
    return false;
  }
})();

const TEST_GUARD_MESSAGE =
  "LLMClient: live LLM calls are blocked in test environments. " +
  "Use enableMockMode() and addMockResponse() to set up mocks.";

export function normalizeLLMResponse(data: unknown, id: string): LLMResponse {
  const message = data && typeof data === "object"
    ? data as Record<string, unknown>
    : {};
  const nativeModelToolResults = isLLMNativeModelToolResults(
      message.nativeModelToolResults,
    )
    ? message.nativeModelToolResults
    : undefined;
  const rest = { ...message };
  delete rest.nativeModelToolResults;

  return {
    ...rest,
    role: typeof message.role === "string" ? message.role : "assistant",
    content: message.content,
    id: typeof message.id === "string" ? message.id : id,
    ...(nativeModelToolResults !== undefined ? { nativeModelToolResults } : {}),
  } as LLMResponse;
}

function getInitialLLMUrl(): string {
  if (typeof globalThis.location !== "undefined") {
    return globalThis.location.protocol + "//" + globalThis.location.host +
      "/api/ai/llm";
  }
  try {
    const apiUrl = Deno?.env?.get?.("API_URL");
    if (apiUrl) {
      return new URL("/api/ai/llm", apiUrl).toString();
    }
  } catch {
    // Permission denied or Deno not available — fall through
  }
  return "//api/ai/llm";
}

let llmApiUrl = getInitialLLMUrl();

export const setLLMUrl = (toolshedUrl: string) => {
  llmApiUrl = new URL("/api/ai/llm", toolshedUrl).toString();
};

//
// Mock Mode for Testing
//

type MockResponseMatcher = (request: LLMRequest) => boolean;
type MockObjectResponseMatcher = (request: LLMGenerateObjectRequest) => boolean;

type MockEntry =
  | { type: "sendRequest"; matcher: MockResponseMatcher; response: LLMResponse }
  | {
    type: "generateObject";
    matcher: MockObjectResponseMatcher;
    response: LLMGenerateObjectResponse;
  };

class MockCatalog {
  #mocks: MockEntry[] = [];
  #enabled = false;

  enable(): void {
    this.#enabled = true;
  }

  disable(): void {
    this.#enabled = false;
  }

  clear(): void {
    this.#mocks = [];
  }

  reset(): void {
    this.disable();
    this.clear();
  }

  isEnabled(): boolean {
    return this.#enabled;
  }

  addResponse(matcher: MockResponseMatcher, response: LLMResponse): void {
    this.#mocks.push({ type: "sendRequest", matcher, response });
  }

  addObjectResponse(
    matcher: MockObjectResponseMatcher,
    response: LLMGenerateObjectResponse,
  ): void {
    this.#mocks.push({ type: "generateObject", matcher, response });
  }

  /**
   * Find a matching sendRequest mock. Skips generateObject entries.
   * Removes the matched mock (one-time use).
   */
  findResponse(request: LLMRequest): LLMResponse | undefined {
    const index = this.#mocks.findIndex((m) =>
      m.type === "sendRequest" && m.matcher(request)
    );
    if (index === -1) return undefined;
    const [mock] = this.#mocks.splice(index, 1);
    if (mock.type === "sendRequest") return mock.response;
  }

  /**
   * Find a matching generateObject mock. Skips sendRequest entries.
   * Removes the matched mock (one-time use).
   */
  findObjectResponse(
    request: LLMGenerateObjectRequest,
  ): LLMGenerateObjectResponse | undefined {
    const index = this.#mocks.findIndex((m) =>
      m.type === "generateObject" && m.matcher(request)
    );
    if (index === -1) return undefined;
    const [mock] = this.#mocks.splice(index, 1);
    if (mock.type === "generateObject") return mock.response;
  }
}

// Global mock catalog — module-level singleton. Tests that share a process
// must coordinate via enableMockMode/resetMockMode to avoid interference.
// Deno runs test files in separate processes by default, so this is safe
// as long as tests within a single file don't run in parallel.
const mockCatalog = new MockCatalog();

let mockGate: (() => Promise<void>) | undefined;

/**
 * Hold every matched mock response open until `gate` resolves.
 *
 * A mock normally answers within a microtask, which is far quicker than a real
 * model call and leaves no window in which a request is genuinely outstanding.
 * A test that needs that window — one asking whether a quiescence barrier
 * covers an in-flight request, rather than whether the answer eventually
 * arrives — installs a gate, looks at the system while the request is held,
 * then releases it.
 *
 * The gate is awaited before the streaming callback runs, so a held request has
 * produced nothing at all. Pass `undefined` to remove it;
 * `clearMockResponses()` and `resetMockMode()` also clear it.
 */
export function setMockResponseGate(
  gate: (() => Promise<void>) | undefined,
): void {
  mockGate = gate;
}

/**
 * Enable mock mode for testing. When enabled, all LLM requests will be
 * intercepted and matched against registered mock responses.
 *
 * Example:
 * ```ts
 * import { enableMockMode, addMockResponse } from "@commonfabric/llm/client";
 *
 * enableMockMode();
 * addMockResponse(
 *   (req) => req.messages[0]?.content?.includes("test"),
 *   { role: "assistant", content: "mock response", id: "mock-1" }
 * );
 * ```
 */
export function enableMockMode(): void {
  mockCatalog.enable();
}

/**
 * Disable mock mode - requests will go to the real API.
 */
export function disableMockMode(): void {
  mockCatalog.disable();
}

/**
 * Clear all registered mock responses without disabling mock mode.
 */
export function clearMockResponses(): void {
  mockCatalog.clear();
  mockGate = undefined;
}

/**
 * Reset mock mode - disable and clear all responses.
 */
export function resetMockMode(): void {
  mockCatalog.reset();
  mockGate = undefined;
}

/**
 * Register a mock response for sendRequest calls.
 *
 * @param matcher Function that returns true if this mock should be used for the given request
 * @param response The LLM response to return
 *
 * Example:
 * ```ts
 * addMockResponse(
 *   (req) => req.messages.some(m => m.content?.includes("hello")),
 *   { role: "assistant", content: "Hi there!", id: "mock-1" }
 * );
 * ```
 */
export function addMockResponse(
  matcher: MockResponseMatcher,
  response: LLMResponse,
): void {
  mockCatalog.addResponse(matcher, response);
}

/**
 * Register a mock response for generateObject calls.
 *
 * @param matcher Function that returns true if this mock should be used for the given request
 * @param response The generate object response to return
 *
 * Example:
 * ```ts
 * addMockObjectResponse(
 *   (req) => req.schema.type === "object",
 *   { object: { name: "Test", value: 42 } }
 * );
 * ```
 */
export function addMockObjectResponse(
  matcher: MockObjectResponseMatcher,
  response: LLMGenerateObjectResponse,
): void {
  mockCatalog.addObjectResponse(matcher, response);
}

//
// Conversation Fixtures for Testing
//

/**
 * Optional assertions to validate the request when a fixture entry is matched.
 * If any assertion fails, the test gets a descriptive error.
 */
export interface ConversationFixtureAssertions {
  /** Assert request has exactly this many messages */
  messageCount?: number;

  /** Assert each string appears in at least one message (strings may match different messages) */
  messagesContain?: string[];

  /** Assert the last message content contains this string */
  lastMessageContains?: string;

  /** Assert these tool names are present in the request */
  hasTools?: string[];

  /** Assert system prompt contains this string */
  systemContains?: string;
}

export type ConversationFixtureEntry =
  | {
    type: "sendRequest";
    expectRequest?: ConversationFixtureAssertions;
    response: LLMResponse;
  }
  | {
    type: "generateObject";
    expectRequest?: ConversationFixtureAssertions;
    response: LLMGenerateObjectResponse;
  };

/**
 * A declarative fixture describing a sequence of LLM responses.
 * Responses are consumed in order (sequential matching).
 */
export interface ConversationFixture {
  description?: string;
  responses: ConversationFixtureEntry[];
}

/**
 * What a failed request points at, read off its status. The service reports a
 * request the caller has to change apart from a provider that was busy or
 * broken, so the hint follows the status rather than blaming the caller for
 * everything.
 */
export function failureHint(status: number, parameters: string): string {
  if (status === 429 || status === 503) {
    return "The model provider is busy. Make the request again later.";
  }
  if (status >= 500) {
    return "The LLM service or the model provider failed. The request was not the problem.";
  }
  if (status === 400 || status === 422) {
    return `The LLM server or the model provider rejected the request. Check that you're passing the correct parameters (${parameters})`;
  }
  return "The LLM service turned the request down.";
}

function extractMessageText(
  content: unknown,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text ?? "")
      .join(" ");
  }
  return "";
}

function runAssertions(
  assertions: ConversationFixtureAssertions,
  request: LLMRequest | LLMGenerateObjectRequest,
  entryIndex: number,
  fixtureDescription?: string,
): void {
  const label = fixtureDescription
    ? `Fixture "${fixtureDescription}" entry ${entryIndex}`
    : `Fixture entry ${entryIndex}`;

  if (assertions.messageCount !== undefined) {
    if (request.messages.length !== assertions.messageCount) {
      throw new Error(
        `${label}: expected ${assertions.messageCount} messages, got ${request.messages.length}`,
      );
    }
  }

  if (assertions.messagesContain) {
    for (const needle of assertions.messagesContain) {
      const found = request.messages.some((m) =>
        extractMessageText(m.content).includes(needle)
      );
      if (!found) {
        throw new Error(
          `${label}: expected some message to contain "${needle}"`,
        );
      }
    }
  }

  if (assertions.lastMessageContains) {
    const last = request.messages[request.messages.length - 1];
    const text = last ? extractMessageText(last.content) : "";
    if (!text.includes(assertions.lastMessageContains)) {
      throw new Error(
        `${label}: expected last message to contain "${assertions.lastMessageContains}", got "${text}"`,
      );
    }
  }

  if (assertions.hasTools) {
    const tools = "tools" in request && request.tools
      ? Object.keys(request.tools)
      : [];
    for (const toolName of assertions.hasTools) {
      if (!tools.includes(toolName)) {
        throw new Error(
          `${label}: expected tool "${toolName}" in request, got [${
            tools.join(", ")
          }]`,
        );
      }
    }
  }

  if (assertions.systemContains) {
    const system = request.system ?? "";
    if (!system.includes(assertions.systemContains)) {
      throw new Error(
        `${label}: expected system prompt to contain "${assertions.systemContains}"`,
      );
    }
  }
}

/**
 * Load a conversation fixture, queueing all responses as sequential mocks.
 * Enables mock mode automatically.
 *
 * Example:
 * ```ts
 * import { loadConversationFixture } from "@commonfabric/llm/client";
 *
 * loadConversationFixture({
 *   responses: [
 *     { type: "sendRequest", response: { role: "assistant", content: "Hi!", id: "1" } },
 *     { type: "sendRequest", response: { role: "assistant", content: "Bye!", id: "2" } },
 *   ]
 * });
 * ```
 */
export function loadConversationFixture(fixture: ConversationFixture): void {
  mockCatalog.enable();

  const description = fixture.description;

  for (let i = 0; i < fixture.responses.length; i++) {
    const entry = fixture.responses[i];
    const entryIndex = i;

    if (entry.type === "sendRequest") {
      const assertions = entry.expectRequest;
      mockCatalog.addResponse(
        (request) => {
          if (assertions) {
            runAssertions(assertions, request, entryIndex, description);
          }
          return true;
        },
        entry.response,
      );
    } else if (entry.type === "generateObject") {
      const assertions = entry.expectRequest;
      mockCatalog.addObjectResponse(
        (request) => {
          if (assertions) {
            runAssertions(assertions, request, entryIndex, description);
          }
          return true;
        },
        entry.response,
      );
    }
  }
}

/**
 * Load a conversation fixture from a JSON file path.
 * Enables mock mode automatically.
 */
export async function loadConversationFixtureFile(
  path: string,
): Promise<void> {
  const text = await Deno.readTextFile(path);
  const fixture: ConversationFixture = JSON.parse(text);
  if (
    !fixture || typeof fixture !== "object" || !Array.isArray(fixture.responses)
  ) {
    throw new Error(
      `Invalid fixture at ${path}: "responses" must be an array`,
    );
  }
  loadConversationFixture(fixture);
}

export class LLMClient {
  async generateObject(
    request: LLMGenerateObjectRequest,
    abortSignal?: AbortSignal,
    opts?: {
      /**
       * Full LLM endpoint URL for THIS call (e.g.
       * `new URL("/api/ai/llm", host)`); the module-level default
       * (setLLMUrl) is the fallback. Lets one runtime route per-space
       * work to that space's host.
       */
      endpoint?: string | URL;
    },
  ): Promise<LLMGenerateObjectResponse> {
    // The request crosses to the provider as ordinary JSON. Refuse a schema
    // holding a value that would not survive that intact, before anything is
    // sent -- this is the last point where the schema is still the faithful
    // in-memory object rather than its JSON rendering. Checked ahead of the
    // mock and test-environment paths too: such a request is malformed for its
    // purpose regardless of where it would have gone.
    assertJsonTransportSafe(request.schema, "The generateObject schema");

    // Check for mock mode
    if (mockCatalog.isEnabled()) {
      const mockResponse = mockCatalog.findObjectResponse(request);
      if (mockResponse) {
        if (mockGate) await mockGate();
        // Simulate async behavior
        await new Promise((resolve) => setTimeout(resolve, 0));
        return mockResponse;
      }
      throw new Error(
        "Mock mode enabled but no matching mock response found for generateObject request",
      );
    }

    // Guard: block live calls in test environments
    if (_isTestEnvironment) {
      throw new Error(TEST_GUARD_MESSAGE);
    }

    const endpoint = opts?.endpoint?.toString() ?? llmApiUrl;
    // TODO(danfuzz): `assertJsonTransportSafe` above covers the SCHEMA, but
    // the request's `messages` cross unchecked: a `FabricValue` in message
    // content (assembled runner-side from live cell reads) stringifies to
    // `{}` here, silently. The payload wants the same transport-safety
    // check the schema gets.
    const response = await fetch(endpoint + "/generateObject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `%c[generateObject Error]%c HTTP ${response.status}\n` +
          `Response: ${errorText}\n` +
          `%c${failureHint(response.status, "messages, schema, model, etc.")}`,
        "color: red; font-weight: bold",
        "color: inherit",
        "color: gray; font-style: italic",
      );
      throw new Error(
        `HTTP error! status: ${response.status}, body: ${errorText}`,
      );
    }

    const data = await response.json();
    return data;
  }

  /**
   * Sends a request to the LLM service.
   *
   * @param request The LLM request object.
   * @param callback Receives the text so far after each streamed text event.
   *   Without one, a streamed reply is read whole once all of it has arrived.
   * @param abortSignal Optional signal that abandons the request.
   * @param opts Optional per-call overrides, currently the endpoint.
   * @returns The full LLM response with content and tool information.
   * @throws If the request fails. The request is issued once, against the
   *   model `request` names; no other model is tried in its place.
   */
  async sendRequest(
    request: LLMRequest,
    callback?: PartialCallback,
    abortSignal?: AbortSignal,
    opts?: {
      /** Per-call LLM endpoint; module-level default is the fallback. */
      endpoint?: string | URL;
    },
  ): Promise<LLMResponse> {
    if (!request.stream && callback) {
      throw new Error(
        "Requested an LLM request with callback, but not configured as a stream.",
      );
    }

    // Each tool's input schema rides the same JSON-serialized request to the
    // provider, so it faces the same transport hazard as a `generateObject`
    // schema. Refuse one that would not survive intact, naming the tool.
    for (const [name, tool] of Object.entries(request.tools ?? {})) {
      assertJsonTransportSafe(
        tool.inputSchema,
        `The input schema for tool "${name}"`,
      );
    }

    // Check for mock mode
    if (mockCatalog.isEnabled()) {
      const mockResponse = mockCatalog.findResponse(request);
      if (mockResponse) {
        if (mockGate) await mockGate();
        // NOTE: Streaming simulation calls the callback once with the full
        // text rather than delivering incremental chunks. Tests that depend on
        // partial-chunk behavior will need a more granular mock.
        if (callback && request.stream) {
          let text = "";
          if (typeof mockResponse.content === "string") {
            text = mockResponse.content;
          } else if (Array.isArray(mockResponse.content)) {
            const textPart = mockResponse.content.find((p: any) =>
              p.type === "text"
            ) as any;
            text = textPart?.text || "";
          }

          if (text) {
            callback(text);
          }
        }

        // Simulate async behavior
        await new Promise((resolve) => setTimeout(resolve, 0));
        return mockResponse;
      }
      throw new Error(
        "Mock mode enabled but no matching mock response found for sendRequest",
      );
    }

    // Guard: block live calls in test environments
    if (_isTestEnvironment) {
      throw new Error(TEST_GUARD_MESSAGE);
    }

    // TODO(danfuzz): same gap as `generateObject` above — tool input schemas
    // are checked with `assertJsonTransportSafe`, but the request's
    // `messages`/`system` data is not, and a `FabricValue` in it stringifies
    // to `{}` here, silently.
    const response = await fetch(opts?.endpoint?.toString() ?? llmApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `%c[generateText Error]%c HTTP ${response.status}\n` +
          `Response: ${errorText}\n` +
          `%c${failureHint(response.status, "messages, prompt, model, etc.")}`,
        "color: red; font-weight: bold",
        "color: inherit",
        "color: gray; font-style: italic",
      );
      throw new Error(
        `HTTP error! status: ${response.status}, body: ${errorText}`,
      );
    }

    return await readLLMResponse(response, callback);
  }
}

/**
 * Reads the reply the service sent in `response`: a JSON reply, which is how
 * a cached answer arrives, whole; a streamed reply through its stream when
 * `callback` wants the text as it arrives, and otherwise whole as well.
 */
export async function readLLMResponse(
  response: Response,
  callback?: PartialCallback,
): Promise<LLMResponse> {
  const id = response.headers.get("x-cf-llm-trace-id") as string;
  if (response.headers.get("content-type")?.includes("application/json")) {
    return normalizeLLMResponse(await response.json(), id);
  }
  if (callback) {
    if (!response.body) {
      throw new Error("No response body");
    }
    return await readLLMStream(response.body, id, callback);
  }
  // With nothing waiting on partial text, the body is read whole, and
  // `response.body` is never touched. In WebKit that getter creates the
  // `ReadableStream` a later `text()` then drains, and a body drained through
  // a stream whose last pull is still pending when the load ends stays
  // reachable for the life of the realm; `text()` on an untouched body reads
  // it without a stream. A body that reads as nothing, which is what a
  // bodyless response reads as, is refused the way a missing stream is above.
  const text = await response.text();
  if (!text) {
    throw new Error("No response body");
  }
  return parseLLMReply(text, id);
}

/**
 * Assembles one LLM reply from the newline-delimited JSON events the service
 * streams, in whatever pieces the body arrives, reporting the text so far to
 * `callback` after each text event.
 */
function assembleLLMReply(id: string, callback?: PartialCallback) {
  let buffer = "";
  let text = "";
  const toolCalls: LLMToolCall[] = [];
  const toolResults: LLMToolResult[] = [];
  let nativeModelToolResults: LLMNativeModelToolResult[] | undefined;

  const takeEvent = (line: string, place: "line" | "final") => {
    try {
      const event = JSON.parse(line);
      // The event types are those of the AI SDK's `fullStream`.
      if (typeof event === "string") {
        // Legacy text delta format
        text += event;
        if (callback) callback(text);
      } else if (event.type === "text-delta") {
        text += event.textDelta;
        if (callback) callback(text);
      } else if (event.type === "tool-call") {
        toolCalls.push({
          id: event.toolCallId,
          name: event.toolName,
          input: event.args,
        });
      } else if (event.type === "tool-result") {
        toolResults.push({
          toolCallId: event.toolCallId,
          result: event.result,
          error: event.error,
        });
      } else if (event.type === "finish") {
        if (isLLMNativeModelToolResults(event.nativeModelToolResults)) {
          nativeModelToolResults = event.nativeModelToolResults;
        }
      } else if (event.type === "error") {
        throw new LLMStreamError(event.error ?? "LLM stream error");
      }
    } catch (error) {
      if (error instanceof LLMStreamError) throw error;
      console.error(
        place === "final"
          ? "Failed to parse final JSON line:"
          : "Failed to parse JSON line:",
        line,
        error,
      );
    }
  };

  return {
    /** Takes the next piece of the body's text. */
    push(chunk: string): void {
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) takeEvent(line, "line");
      }
    },

    /** Returns the reply, once every piece of the body has been pushed. */
    finish(): LLMResponse {
      const last = buffer.trim();
      buffer = "";
      if (last) takeEvent(last, "final");

      const content: any[] = [];
      if (text.trim()) {
        content.push({ type: "text", text });
      }
      for (const toolCall of toolCalls) {
        content.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input,
        });
      }
      return {
        role: "assistant",
        content: content.length > 0 ? content : text,
        id,
        ...(nativeModelToolResults !== undefined
          ? { nativeModelToolResults }
          : {}),
      };
    },
  };
}

/**
 * Reads one streamed LLM reply to completion, reporting the text so far to
 * `callback` as it arrives.
 */
export async function readLLMStream(
  body: ReadableStream,
  id: string,
  callback?: PartialCallback,
): Promise<LLMResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const reply = assembleLLMReply(id, callback);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    reply.push(decoder.decode(value, { stream: true }));
  }
  return reply.finish();
}

/**
 * Assembles one LLM reply from the whole body of a streamed reply, read after
 * all of it has arrived.
 */
export function parseLLMReply(text: string, id: string): LLMResponse {
  const reply = assembleLLMReply(id);
  reply.push(text);
  return reply.finish();
}
