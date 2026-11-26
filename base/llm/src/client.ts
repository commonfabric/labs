import {
  isLLMNativeModelToolResults,
  type LLMContent,
  LLMGenerateObjectRequest,
  LLMGenerateObjectResponse,
  type LLMNativeModelToolResult,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
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
const _isTestEnvironment = readEnv("CI") === "true" ||
  readEnv("ENV") === "test";

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

/**
 * The LLM endpoint a process starts with: the one on the host that served the
 * page at `location`, else the one on the API at `apiUrl`, else none. An
 * `apiUrl` that is not a URL is passed over the way a missing one is. A
 * process with none can be given one by `setLLMUrl()`; a call can also name
 * its own, as a runtime's builtins do for the deployment its host named.
 */
export function initialLLMUrl(
  location: Pick<Location, "protocol" | "host"> | undefined,
  apiUrl: string | undefined,
): string | undefined {
  // A Deno worker also has a location, but it is its module's file: URL, and
  // a POST there fails, so only an http(s) location names the toolshed.
  if (
    location &&
    (location.protocol === "http:" || location.protocol === "https:")
  ) {
    return location.protocol + "//" + location.host + "/api/ai/llm";
  }
  if (apiUrl && URL.canParse(apiUrl)) {
    return new URL("/api/ai/llm", apiUrl).toString();
  }
  return undefined;
}

/** The environment variable `name`, where there is one to read. */
function readEnv(name: string): string | undefined {
  try {
    return Deno?.env?.get?.(name);
  } catch {
    // Permission denied or Deno not available.
    return undefined;
  }
}

let llmApiUrl = initialLLMUrl(globalThis.location, readEnv("API_URL"));

export const setLLMUrl = (toolshedUrl: string) => {
  llmApiUrl = new URL("/api/ai/llm", toolshedUrl).toString();
};

/**
 * The endpoint LLM calls without a per-space endpoint are sent to, or
 * `undefined` while this process has none.
 */
export const getLLMUrl = (): string | undefined => llmApiUrl;

/**
 * The endpoint a call is sent to: its own, else the process's. A call with
 * neither is refused before anything is sent, naming what would have set one,
 * rather than sent to a URL no fetch can resolve.
 */
function endpointFor(endpoint: string | URL | undefined): string {
  const url = endpoint?.toString() ?? llmApiUrl;
  if (url === undefined) {
    throw new Error(
      "LLMClient: this call names no endpoint and this process has no LLM " +
        "endpoint. A runtime built from a deployment-facing preset names " +
        "its own; otherwise one comes from `setLLMUrl()`, the `API_URL` " +
        "environment variable, or the http(s) page the process runs in.",
    );
  }
  return url;
}

//
// Mock Mode for Testing
//

type MockResponseMatcher = (request: LLMRequest) => boolean;
type MockObjectResponseMatcher = (request: LLMGenerateObjectRequest) => boolean;

/**
 * Answers the requests an `LLMClient` makes in place of the LLM service. While
 * one is installed with `setLLMResponder()`, every request goes to it and none
 * reaches the network. The JSON-transport checks on schemas run first, so a
 * responder sees only requests the service could have received.
 */
export interface LLMResponder {
  /**
   * Answers a `sendRequest()`. A streamed request carries `callback`, which
   * the responder calls with the text so far, as the service's stream would.
   */
  sendRequest(
    request: LLMRequest,
    callback: PartialCallback | undefined,
    abortSignal: AbortSignal | undefined,
  ): Promise<LLMResponse>;

  /** Answers a `generateObject()`. */
  generateObject(
    request: LLMGenerateObjectRequest,
    abortSignal: AbortSignal | undefined,
  ): Promise<LLMGenerateObjectResponse>;
}

let responder: LLMResponder | undefined;

/**
 * Installs `next` as the answerer of every request any `LLMClient` in this
 * process makes, replacing the mock catalog or another responder. `undefined`
 * removes it, and requests go to the LLM service again.
 */
export function setLLMResponder(next: LLMResponder | undefined): void {
  responder = next;
}

type MockEntry =
  | { type: "sendRequest"; matcher: MockResponseMatcher; response: LLMResponse }
  | {
    type: "generateObject";
    matcher: MockObjectResponseMatcher;
    response: LLMGenerateObjectResponse;
  };

let mockGate: (() => Promise<void>) | undefined;

/**
 * The responder `enableMockMode()` installs: answers from registered mock
 * responses, each used once, the first registered match winning.
 */
class MockCatalog implements LLMResponder {
  #mocks: MockEntry[] = [];

  clear(): void {
    this.#mocks = [];
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

  async sendRequest(
    request: LLMRequest,
    callback: PartialCallback | undefined,
  ): Promise<LLMResponse> {
    const index = this.#mocks.findIndex((m) =>
      m.type === "sendRequest" && m.matcher(request)
    );
    const [mock] = index === -1 ? [] : this.#mocks.splice(index, 1);
    if (mock?.type !== "sendRequest") {
      throw new Error(
        "Mock mode enabled but no matching mock response found for sendRequest",
      );
    }
    if (mockGate) await mockGate();
    // The callback gets the whole text at once rather than in pieces.
    if (callback) {
      const content = mock.response.content;
      const text = typeof content === "string"
        ? content
        : content.find((part) => part.type === "text")?.text;
      if (text) callback(text);
    }
    return mock.response;
  }

  async generateObject(
    request: LLMGenerateObjectRequest,
  ): Promise<LLMGenerateObjectResponse> {
    const index = this.#mocks.findIndex((m) =>
      m.type === "generateObject" && m.matcher(request)
    );
    const [mock] = index === -1 ? [] : this.#mocks.splice(index, 1);
    if (mock?.type !== "generateObject") {
      throw new Error(
        "Mock mode enabled but no matching mock response found for generateObject request",
      );
    }
    if (mockGate) await mockGate();
    return mock.response;
  }
}

// Global mock catalog — module-level singleton. Tests that share a process
// must coordinate via enableMockMode/resetMockMode to avoid interference.
// Deno runs test files in separate processes by default, so this is safe
// as long as tests within a single file don't run in parallel.
const mockCatalog = new MockCatalog();

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
  responder = mockCatalog;
}

/**
 * Disable mock mode - requests will go to the real API.
 */
export function disableMockMode(): void {
  if (responder === mockCatalog) responder = undefined;
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
  disableMockMode();
  clearMockResponses();
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

/** The text parts of a message's content, joined by spaces. */
export function extractMessageText(
  content: LLMContent | undefined,
): string {
  if (content === undefined || typeof content === "string") {
    return content ?? "";
  }
  return content.flatMap((part) => part.type === "text" ? [part.text] : [])
    .join(" ");
}

/**
 * The first of `assertions` that `request` fails, described, or `undefined`
 * when it meets them all.
 */
export function requestMismatch(
  assertions: ConversationFixtureAssertions,
  request: LLMRequest | LLMGenerateObjectRequest,
): string | undefined {
  if (
    assertions.messageCount !== undefined &&
    request.messages.length !== assertions.messageCount
  ) {
    return `expected ${assertions.messageCount} messages, got ${request.messages.length}`;
  }
  for (const needle of assertions.messagesContain ?? []) {
    if (
      !request.messages.some((m) =>
        extractMessageText(m.content).includes(needle)
      )
    ) {
      return `expected some message to contain "${needle}"`;
    }
  }
  if (assertions.lastMessageContains !== undefined) {
    const last = request.messages[request.messages.length - 1];
    const text = extractMessageText(last?.content);
    if (!text.includes(assertions.lastMessageContains)) {
      return `expected last message to contain "${assertions.lastMessageContains}", got "${text}"`;
    }
  }
  if (assertions.hasTools) {
    const tools = "tools" in request && request.tools
      ? Object.keys(request.tools)
      : [];
    for (const toolName of assertions.hasTools) {
      if (!tools.includes(toolName)) {
        return `expected tool "${toolName}" in request, got [${
          tools.join(", ")
        }]`;
      }
    }
  }
  if (
    assertions.systemContains !== undefined &&
    !(request.system ?? "").includes(assertions.systemContains)
  ) {
    return `expected system prompt to contain "${assertions.systemContains}"`;
  }
  return undefined;
}

function runAssertions(
  assertions: ConversationFixtureAssertions,
  request: LLMRequest | LLMGenerateObjectRequest,
  entryIndex: number,
  fixtureDescription?: string,
): void {
  const mismatch = requestMismatch(assertions, request);
  if (mismatch === undefined) return;
  const label = fixtureDescription
    ? `Fixture "${fixtureDescription}" entry ${entryIndex}`
    : `Fixture entry ${entryIndex}`;
  throw new Error(`${label}: ${mismatch}`);
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
  enableMockMode();

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
  readonly #fetch: typeof fetch | undefined;

  /**
   * Constructs a client that sends its requests with `fetchFn`. Without one it
   * sends them with the global `fetch`. A test environment refuses a request
   * sent with the global `fetch`, however the client was given it.
   */
  constructor(fetchFn?: typeof fetch) {
    this.#fetch = fetchFn;
  }

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

    if (responder) return await responder.generateObject(request, abortSignal);

    // TODO(danfuzz): `assertJsonTransportSafe` above covers the SCHEMA, but
    // the request's `messages` cross unchecked: a `FabricValue` in message
    // content (assembled runner-side from live cell reads) stringifies to
    // `{}` here, silently. The payload wants the same transport-safety
    // check the schema gets.
    const response = await this.#post(
      opts?.endpoint,
      "/generateObject",
      request,
      abortSignal,
      "generateObject",
      "messages, schema, model, etc.",
    );
    return await response.json();
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

    if (responder) {
      return await responder.sendRequest(request, callback, abortSignal);
    }

    // TODO(danfuzz): same gap as `generateObject` above — tool input schemas
    // are checked with `assertJsonTransportSafe`, but the request's
    // `messages`/`system` data is not, and a `FabricValue` in it stringifies
    // to `{}` here, silently.
    const response = await this.#post(
      opts?.endpoint,
      "",
      request,
      abortSignal,
      "generateText",
      "messages, prompt, model, etc.",
    );
    return await readLLMResponse(response, callback);
  }

  /**
   * POSTs `request` as JSON to `path` under `endpoint` (the process's endpoint
   * where the call names none), and returns the response once it has
   * succeeded. A failed response is logged under `label`, with a hint naming
   * `parameters` where the request is to blame, and thrown.
   */
  async #post(
    endpoint: string | URL | undefined,
    path: string,
    request: LLMRequest | LLMGenerateObjectRequest,
    abortSignal: AbortSignal | undefined,
    label: string,
    parameters: string,
  ): Promise<Response> {
    const send = this.#fetch ?? fetch;
    // Block live calls in test environments.
    if (_isTestEnvironment && send === globalThis.fetch) {
      throw new Error(TEST_GUARD_MESSAGE);
    }
    const response = await send(endpointFor(endpoint) + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: abortSignal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `%c[${label} Error]%c HTTP ${response.status}\n` +
          `Response: ${errorText}\n` +
          `%c${failureHint(response.status, parameters)}`,
        "color: red; font-weight: bold",
        "color: inherit",
        "color: gray; font-style: italic",
      );
      throw new Error(
        `HTTP error! status: ${response.status}, body: ${errorText}`,
      );
    }
    return response;
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
