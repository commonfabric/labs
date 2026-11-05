import { assertEquals, assertRejects } from "@std/assert";
import { OpenAICompatibleGatewayClient } from "../src/gateway/openai-client.ts";
import { OpenAICompatibleGatewayModelClient } from "../src/model/openai-compatible-gateway.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";

/**
 * The Chat Completions path is now reached only by Vertex-backed models and
 * provider-native tools, so it is no longer exercised incidentally by the
 * prompt-loop suites. These cover it directly: transcript mapping in both
 * directions, model discovery, and the Responses error branches that name the
 * failure modes callers actually hit.
 */

const GATEWAY = "https://gateway.test";
const CHAT_MODEL = "gemini-3.5-flash";

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

const clientWith = (
  captured: Captured[],
  respond: (call: number) => { body: unknown; status?: number },
) => {
  let call = 0;
  return new OpenAICompatibleGatewayModelClient(
    new OpenAICompatibleGatewayClient({
      baseUrl: GATEWAY,
      authMode: "none",
      transportRetries: 0,
      fetchFn: (input, init) => {
        const url = String(input);
        if (init?.body !== undefined) {
          captured.push({
            url,
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
          });
        } else {
          captured.push({ url, body: {} });
        }
        const { body, status } = respond(call);
        call += 1;
        return Promise.resolve(
          new Response(
            typeof body === "string" ? body : JSON.stringify(body),
            { status: status ?? 200 },
          ),
        );
      },
    }),
  );
};

const turn = (
  overrides: Partial<HarnessModelTurnRequest> = {},
): HarnessModelTurnRequest => ({
  model: CHAT_MODEL,
  transcript: [{ role: "user", content: "Read the notes." }],
  tools: [{
    toolId: "read_file",
    title: "Read file",
    description: "Read a file",
    effectClass: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  }],
  nativeModelToolIds: [],
  runId: "run-chat",
  ...overrides,
});

const assistantText = (text: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content: text } }],
});

Deno.test("chat requests map a full transcript, including tool turns", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, () => ({
    body: assistantText("All done."),
  }));

  await client.complete(turn({
    transcript: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Read it." },
      {
        role: "assistant",
        content: "Calling the tool.",
        toolCalls: [{
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "read_file",
        content: "file contents",
      },
    ],
  }));

  assertEquals(captured[0].url, `${GATEWAY}/v1/chat/completions`);
  const messages = captured[0].body.messages as Array<Record<string, unknown>>;
  assertEquals(messages.map((m) => m.role), [
    "system",
    "user",
    "assistant",
    "tool",
  ]);
  assertEquals(messages[2].content, "Calling the tool.");
  assertEquals(
    (messages[2].tool_calls as Array<{ id: string }>)[0].id,
    "call-1",
  );
  assertEquals(messages[3].tool_call_id, "call-1");
  // Chat tools keep the nested function shape.
  const tools = captured[0].body.tools as Array<Record<string, unknown>>;
  assertEquals(
    (tools[0].function as { name: string }).name,
    "read_file",
  );
});

Deno.test("chat responses with array content are flattened to text", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, () => ({
    body: {
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Part one. " },
            { type: "image_url", image_url: { url: "data:..." } },
            { type: "text", text: "Part two." },
          ],
        },
      }],
    },
  }));

  const result = await client.complete(turn());
  // Non-text parts are dropped rather than stringified into the transcript.
  assertEquals(result.assistant.content, "Part one. Part two.");
});

Deno.test("chat responses preserve cache and reasoning usage", async () => {
  const client = clientWith([], () => ({
    body: {
      ...assistantText("Done."),
      usage: {
        prompt_tokens: 1_500,
        prompt_tokens_details: {
          cached_tokens: 1_024,
          cache_write_tokens: 0,
        },
        completion_tokens: 100,
        completion_tokens_details: { reasoning_tokens: 40 },
        total_tokens: 1_600,
      },
    },
  }));

  const result = await client.complete(turn());

  assertEquals(result.usage, {
    inputTokens: 1_500,
    cachedInputTokens: 1_024,
    cacheWriteTokens: 0,
    outputTokens: 100,
    reasoningTokens: 40,
    totalTokens: 1_600,
    estimateWithheldReason: "unknown-model",
  });
});

Deno.test("chat-routed models reject reasoning effort before provider traffic", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, () => ({
    body: assistantText("unused"),
  }));

  await assertRejects(
    () => client.complete(turn({ reasoningEffort: "low" })),
    Error,
    "reasoning effort low requires a model routed through the Responses API",
  );
  assertEquals(captured.length, 0);
});

Deno.test("chat responses surface native model tool results", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, () => ({
    body: {
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "Searched.",
          grounding_metadata: { webSearchQueries: ["eiffel tower height"] },
        },
      }],
    },
  }));

  const result = await client.complete(
    turn({ nativeModelToolIds: ["google_search"] }),
  );

  // Native tools are advertised alongside function tools on this path.
  const tools = captured[0].body.tools as Array<Record<string, unknown>>;
  assertEquals(tools.map((t) => t.type), ["function", "google_search"]);
  const native = result.assistant.nativeModelToolResults ?? [];
  assertEquals(native.length, 1);
  assertEquals(native[0].toolId, "google_search");
  assertEquals(native[0].provider, "google");
});

Deno.test("a chat response without a message choice is rejected", async () => {
  const client = clientWith([], () => ({ body: { choices: [] } }));
  await assertRejects(
    () => client.complete(turn()),
    Error,
    "chat completion response did not include a message choice",
  );
});

Deno.test("listModels maps the gateway registry", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, () => ({
    body: {
      object: "list",
      data: [
        { id: "gpt-5.6-sol", capabilities: { images: true } },
        { id: "claude-opus-5", capabilities: { images: false } },
        { notAnId: true },
      ],
    },
  }));

  const models = await client.listModels();

  assertEquals(captured[0].url, `${GATEWAY}/v1/models`);
  assertEquals(models.map((m) => m.id), ["gpt-5.6-sol", "claude-opus-5"]);
  assertEquals(models[0].inputModalities, ["text", "image"]);
  assertEquals(models[1].inputModalities, ["text"]);
  assertEquals(models[0].supportedReasoningEfforts, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assertEquals(models[1].supportedReasoningEfforts, []);
});

Deno.test("listModels surfaces a failed registry fetch", async () => {
  const client = clientWith([], () => ({ body: "nope", status: 503 }));
  await assertRejects(
    () => client.listModels(),
    Error,
    "model list request failed (503)",
  );
});

Deno.test("a Responses 5xx with an empty body names the provider mismatch", async () => {
  // Vertex-backed models answer this way on /v1/responses; the message has to
  // point at the model choice rather than look like a transient outage.
  const client = clientWith([], () => ({ body: "", status: 500 }));
  await assertRejects(
    () => client.complete(turn({ model: "gpt-5.6-terra" })),
    Error,
    "the gateway may not support the Responses API for this model's provider",
  );
});

Deno.test("a Responses 401 explains which credential was rejected", async () => {
  const client = clientWith([], () => ({ body: "denied", status: 401 }));
  await assertRejects(
    () => client.complete(turn({ model: "gpt-5.6-terra" })),
    Error,
    "unauthenticated caller mode was used",
  );
});

Deno.test("transport failures name the operation that failed", async () => {
  // A Responses timeout reported as a "chat completion" failure sends anyone
  // reading the log to the wrong endpoint.
  const failing = new OpenAICompatibleGatewayModelClient(
    new OpenAICompatibleGatewayClient({
      baseUrl: GATEWAY,
      authMode: "none",
      transportRetries: 0,
      fetchFn: () => Promise.reject(new Error("connection error: timed out")),
    }),
  );

  await assertRejects(
    () => failing.complete(turn({ model: "gpt-5.6-terra" })),
    Error,
    "responses transport request failed after 1 attempt",
  );
  await assertRejects(
    () => failing.complete(turn()),
    Error,
    "chat.completions transport request failed after 1 attempt",
  );
});

Deno.test("other Responses failures pass the body through", async () => {
  const client = clientWith([], () => ({
    body: '{"error":{"message":"bad request"}}',
    status: 400,
  }));
  await assertRejects(
    () => client.complete(turn({ model: "gpt-5.6-terra" })),
    Error,
    "responses request failed (400)",
  );
});
