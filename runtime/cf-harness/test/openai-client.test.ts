import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type OpenAIChatCompletionAttemptDiagnostic,
  OpenAICompatibleGatewayClient,
} from "../src/gateway/openai-client.ts";

Deno.test("OpenAICompatibleGatewayClient resolves endpoint URLs against the base URL", () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
  });

  assertEquals(
    client.endpoint("/v1/models").toString(),
    "https://llm.stage.commontools.dev/v1/models",
  );
  assertEquals(
    client.endpoint("/v1/chat/completions").toString(),
    "https://llm.stage.commontools.dev/v1/chat/completions",
  );
});

Deno.test("OpenAICompatibleGatewayClient forwards requests through the injected fetch implementation", async () => {
  const calls: Array<{ input: URL | RequestInfo; init?: RequestInit }> = [];
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    fetchFn: (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    },
  });

  const controller = new AbortController();
  await client.listModels(controller.signal);
  await client.createChatCompletion({ model: "gpt-5.4", messages: [] });

  assertEquals(
    (calls[0].input as URL).toString(),
    "https://llm.stage.commontools.dev/v1/models",
  );
  assertEquals(calls[0].init?.signal, controller.signal);
  assertEquals(
    (calls[1].input as URL).toString(),
    "https://llm.stage.commontools.dev/v1/chat/completions",
  );
  assertEquals(calls[1].init?.method, "POST");
  assertEquals(
    new Headers(calls[1].init?.headers).get("authorization"),
    "Bearer test-key",
  );
});

Deno.test("OpenAICompatibleGatewayClient forwards abort signals to chat completion fetch", async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | null | undefined;
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    fetchFn: (_input, init) => {
      seenSignal = init?.signal;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              index: 0,
              message: { role: "assistant", content: "ok" },
            }],
          }),
          { status: 200 },
        ),
      );
    },
  });

  await client.createChatCompletionJson({
    model: "gpt-5.4",
    messages: [],
  }, {
    signal: controller.signal,
  });

  assertEquals(seenSignal, controller.signal);
});

Deno.test("OpenAICompatibleGatewayClient omits authorization headers in no-auth mode", async () => {
  const calls: Array<{ input: URL | RequestInfo; init?: RequestInit }> = [];
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    authMode: "none",
    fetchFn: (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    },
  });

  await client.createChatCompletion({ model: "gpt-5.4", messages: [] });

  assertEquals(
    new Headers(calls[0].init?.headers).get("authorization"),
    null,
  );
});

Deno.test("OpenAICompatibleGatewayClient forwards native model tools and summarizes them in diagnostics", async () => {
  const attempts: OpenAIChatCompletionAttemptDiagnostic[] = [];
  let requestBody: unknown;
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    fetchFn: (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              index: 0,
              message: { role: "assistant", content: "ok" },
            }],
          }),
          { status: 200 },
        ),
      );
    },
  });

  await client.createChatCompletionJson({
    model: "google:gemini-3.5-flash",
    messages: [],
    native_model_tools: [{ type: "google_search" }],
  }, {
    onChatCompletionAttempt: (attempt) => {
      attempts.push(attempt);
    },
  });

  assertEquals(requestBody, {
    model: "google:gemini-3.5-flash",
    messages: [],
    native_model_tools: [{ type: "google_search" }],
  });
  assertEquals(attempts[0].request.nativeModelToolIds, ["google_search"]);
  assertEquals(attempts[0].request.nativeModelToolCount, 1);
});

Deno.test("OpenAICompatibleGatewayClient parses successful chat completion JSON responses", async () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              index: 0,
              message: { role: "assistant", content: "ok" },
            }],
          }),
          { status: 200 },
        ),
      ),
  });

  const response = await client.createChatCompletionJson({
    model: "gpt-5.4",
    messages: [],
  });

  assertEquals(response.choices[0]?.message.content, "ok");
});

Deno.test("OpenAICompatibleGatewayClient retries a chat completion transport failure by default", async () => {
  let calls = 0;
  const attempts: OpenAIChatCompletionAttemptDiagnostic[] = [];
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    transportRetryDelayMs: 0,
    fetchFn: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("connection error: timed out"));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              index: 0,
              message: { role: "assistant", content: "ok" },
            }],
          }),
          { status: 200 },
        ),
      );
    },
  });

  const response = await client.createChatCompletionJson({
    model: "gpt-5.4",
    messages: [],
  }, {
    onChatCompletionAttempt: (attempt) => {
      attempts.push(attempt);
    },
  });

  assertEquals(calls, 2);
  assertEquals(response.choices[0]?.message.content, "ok");
  assertEquals(attempts.map((attempt) => attempt.outcome), [
    "transport_error",
    "http_response",
  ]);
  assertEquals(attempts.map((attempt) => attempt.attempt), [1, 2]);
  assertEquals(attempts[0].errorDetail, "connection error: timed out");
  assertEquals(attempts[1].httpStatus, 200);
});

Deno.test("OpenAICompatibleGatewayClient does not retry aborted chat completion requests", async () => {
  let calls = 0;
  const attempts: OpenAIChatCompletionAttemptDiagnostic[] = [];
  const controller = new AbortController();
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    transportRetryDelayMs: 0,
    fetchFn: (_input, init) => {
      calls += 1;
      assertEquals(init?.signal, controller.signal);
      const reason = new DOMException("user canceled", "AbortError");
      controller.abort(reason);
      return Promise.reject(reason);
    },
  });

  let rejected: unknown;
  try {
    await client.createChatCompletionJson({
      model: "gpt-5.4",
      messages: [],
    }, {
      signal: controller.signal,
      onChatCompletionAttempt: (attempt) => {
        attempts.push(attempt);
      },
    });
  } catch (error) {
    rejected = error;
  }

  assert(rejected instanceof DOMException);
  assertEquals(rejected.name, "AbortError");
  assertEquals(rejected.message, "user canceled");
  assertEquals(calls, 1);
  assertEquals(attempts.length, 1);
  assertEquals(attempts[0].outcome, "transport_error");
});

Deno.test("OpenAICompatibleGatewayClient surfaces exhausted chat completion transport retries", async () => {
  let calls = 0;
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    transportRetryDelayMs: 0,
    fetchFn: () => {
      calls += 1;
      return Promise.reject(new Error("connection error: timed out"));
    },
  });

  await assertRejects(
    () =>
      client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [],
      }),
    Error,
    "chat.completions transport request failed after 4 attempts",
  );
  assertEquals(calls, 4);
});

Deno.test("OpenAICompatibleGatewayClient surfaces chat completion errors with response text", async () => {
  const attempts: OpenAIChatCompletionAttemptDiagnostic[] = [];
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    fetchFn: () =>
      Promise.resolve(
        new Response("bad request", {
          status: 400,
          statusText: "Bad Request",
          headers: {
            "x-request-id": "req-bad-request",
          },
        }),
      ),
  });

  await assertRejects(
    () =>
      client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
        tools: [{
          type: "function",
          function: {
            name: "read_file",
          },
        }],
      }, {
        onChatCompletionAttempt: (attempt) => {
          attempts.push(attempt);
        },
      }),
    Error,
    "chat completion request failed (400): bad request",
  );
  assertEquals(attempts.length, 1);
  const attempt = attempts[0];
  assertEquals(attempt.type, "cf-harness.gateway.chat-completion-attempt");
  assertEquals(attempt.operation, "chat.completions");
  assertEquals(attempt.outcome, "http_response");
  assertEquals(attempt.attempt, 1);
  assertEquals(attempt.maxTransportAttempts, 4);
  assertEquals(attempt.request.model, "gpt-5.4");
  assertEquals(attempt.request.messageCount, 1);
  assertEquals(attempt.request.toolCount, 1);
  assert(attempt.request.serializedBytes > 0);
  assertEquals(attempt.httpStatus, 400);
  assertEquals(attempt.httpStatusText, "Bad Request");
  assertEquals(attempt.requestId, "req-bad-request");
  assertEquals(attempt.responseHeaders?.["x-request-id"], "req-bad-request");
  assertEquals(attempt.responseBodyBytes, 11);
  assertEquals(attempt.responseBodyExcerpt, "bad request");
  assertEquals(attempt.responseBodyTruncated, false);
  assert(attempt.durationMs >= 0);
  assert(new Date(attempt.startedAt).toString() !== "Invalid Date");
  assert(new Date(attempt.endedAt).toString() !== "Invalid Date");
});

Deno.test("OpenAICompatibleGatewayClient fails clearly when no API key is configured", async () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    fetchFn: () =>
      Promise.resolve(
        new Response("should not be called", {
          status: 500,
        }),
      ),
  });

  await assertRejects(
    () =>
      client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [],
      }),
    Error,
    "no API key configured; set CF_HARNESS_API_KEY or OPENAI_API_KEY",
  );
});

Deno.test("OpenAICompatibleGatewayClient fails clearly on placeholder API keys", async () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "...",
    apiKeySource: "CF_HARNESS_API_KEY",
    fetchFn: () =>
      Promise.resolve(
        new Response("should not be called", {
          status: 500,
        }),
      ),
  });

  await assertRejects(
    () =>
      client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [],
      }),
    Error,
    "CF_HARNESS_API_KEY is set to a placeholder value ('...'); provide a real API key",
  );
});

Deno.test("OpenAICompatibleGatewayClient surfaces 401s with API key source context", async () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    apiKey: "test-key",
    apiKeySource: "CF_HARNESS_API_KEY",
    fetchFn: () =>
      Promise.resolve(
        new Response("organization rejected", {
          status: 401,
          statusText: "Unauthorized",
        }),
      ),
  });

  await assertRejects(
    () =>
      client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [],
      }),
    Error,
    "chat completion request failed (401, api key source: CF_HARNESS_API_KEY; backend rejected the supplied key): organization rejected",
  );
});

Deno.test("OpenAICompatibleGatewayClient surfaces 401s in no-auth mode without implying caller auth", async () => {
  const client = new OpenAICompatibleGatewayClient({
    baseUrl: "https://llm.stage.commontools.dev/",
    authMode: "none",
    fetchFn: () =>
      Promise.resolve(
        new Response("organization rejected", {
          status: 401,
          statusText: "Unauthorized",
        }),
      ),
  });

  await assertRejects(
    () =>
      client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [],
      }),
    Error,
    "chat completion request failed (401, unauthenticated caller mode was used; gateway or upstream credentials rejected the request): organization rejected",
  );
});
