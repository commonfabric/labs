import { assertEquals, assertStringIncludes } from "@std/assert";
import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import router from "@/routes/ai/llm/llm.index.ts";
import { MODELS } from "@/routes/ai/llm/models.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

// A caller acts on the status before it reads the body: a request it must
// change, one it should make again later, and one this service or a provider
// broke all call for different handling. These drive the real router so the
// status a caller sees is what is asserted.

const app = createApp().route("/", router);

const MOCK_MODEL_NAME = "mock:status-model";

/** A model that turns the request down the way a provider does. */
function rejectingWith(statusCode: number, message: string): LanguageModel {
  return new MockLanguageModelV4({
    doStream: () => {
      throw new APICallError({
        message,
        url: "https://provider.example/v1/messages",
        requestBodyValues: {},
        statusCode,
        responseBody: `{"error":"${message}"}`,
      });
    },
  });
}

/** A model that answers without writing any text. */
function silentModel(): LanguageModel {
  return new MockLanguageModelV4({
    doStream: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "length", raw: "max_tokens" },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    },
  });
}

/**
 * Registers `model` under a name that `findModel` resolves, runs `body`, then
 * takes the registration back out of the shared model list.
 */
async function withMockModel<T>(
  model: LanguageModel | undefined,
  body: () => Promise<T>,
): Promise<T> {
  if (model) {
    MODELS[MOCK_MODEL_NAME] = {
      model,
      name: MOCK_MODEL_NAME,
      capabilities: {
        contextWindow: 1000,
        maxOutputTokens: 100,
        streaming: true,
        systemPrompt: true,
        stopSequences: true,
        prefill: false,
        images: false,
        reasoning: false,
      },
      aliases: [],
    };
  }
  try {
    return await body();
  } finally {
    delete MODELS[MOCK_MODEL_NAME];
  }
}

/** Posts a body and reads back the status and the error it carried. */
async function post(
  path: string,
  requestBody: unknown,
  contentType = "application/json",
): Promise<{ status: number; error: string }> {
  const response = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: typeof requestBody === "string"
      ? requestBody
      : JSON.stringify(requestBody),
  });
  const body = await response.json();
  return { status: response.status, error: body.error ?? "" };
}

function statusFor(
  model: LanguageModel | undefined,
  requestedModel = MOCK_MODEL_NAME,
  extraRequestFields: Record<string, unknown> = {},
): Promise<{ status: number; error: string }> {
  return withMockModel(model, () =>
    post("/api/ai/llm", {
      model: requestedModel,
      messages: [{ role: "user", content: "hi" }],
      cache: false,
      ...extraRequestFields,
    }));
}

Deno.test("a provider outage is not reported as the caller's mistake", async () => {
  const { status, error } = await statusFor(
    rejectingWith(500, "Internal server error"),
  );
  assertEquals(status, 502);
  assertStringIncludes(error, "Internal server error");
});

Deno.test("a rate limit is passed along so the caller can wait", async () => {
  const { status } = await statusFor(
    rejectingWith(429, "Rate limit exceeded"),
  );
  assertEquals(status, 429);
});

Deno.test("a provider timeout is reported as a gateway timeout", async () => {
  const { status } = await statusFor(rejectingWith(408, "Request timeout"));
  assertEquals(status, 504);
});

Deno.test("a request the provider refused stays the caller's to fix", async () => {
  const { status } = await statusFor(
    rejectingWith(400, "prompt is too long: 300000 tokens > 200000 maximum"),
  );
  assertEquals(status, 400);
});

Deno.test("an overloaded provider is reported as temporary", async () => {
  const { status } = await statusFor(rejectingWith(529, "Overloaded"));
  assertEquals(status, 503);
});

Deno.test("a key the provider rejected is this service's to fix", async () => {
  const { status } = await statusFor(rejectingWith(401, "invalid x-api-key"));
  assertEquals(status, 500);
});

Deno.test("an output budget spent before the first token is the caller's", async () => {
  const { status, error } = await statusFor(silentModel());
  assertEquals(status, 400);
  assertStringIncludes(error, "finish reason: length");
});

Deno.test("a model this service does not carry is the caller's mistake", async () => {
  const { status, error } = await statusFor(undefined, "mock:no-such-model");
  assertEquals(status, 400);
  assertStringIncludes(error, "Unknown model 'mock:no-such-model'");
});

Deno.test("a tool the model cannot serve is the caller's mistake", async () => {
  const { status, error } = await statusFor(
    rejectingWith(500, "unreached"),
    MOCK_MODEL_NAME,
    { nativeModelToolIds: ["google_search"] },
  );
  assertEquals(status, 400);
  assertStringIncludes(error, "is not supported by model");
});

Deno.test("a request that leaves `cache` out reaches the provider", async () => {
  // `cache` is optional, so the status is the provider's refusal rather than
  // the guard's. The body posted here is the one the OpenAPI document
  // publishes as valid: a model and a conversation, and nothing else.

  const { status } = await withMockModel(
    rejectingWith(429, "Rate limit exceeded"),
    () =>
      post("/api/ai/llm", {
        model: MOCK_MODEL_NAME,
        messages: [{ role: "user", content: "hi" }],
      }),
  );
  assertEquals(status, 429);
});

//
// A body sent as JSON is parsed by the route's own validator, which answers
// its own 422 before the handler runs. A body sent as anything else reaches
// the handler unparsed.
//

Deno.test("a body that is not JSON is the caller's mistake", async () => {
  const response = await app.request("/api/ai/llm", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "hello",
  });
  assertEquals(response.status, 400);
  assertStringIncludes((await response.json()).error, "not JSON");
});

Deno.test("a body that does not match the schema is reported as unprocessable", async () => {
  const { status } = await post("/api/ai/llm", { messages: "not an array" });
  assertEquals(status, 422);
});

Deno.test("a system-role message names the field it belongs in", async () => {
  const response = await app.request("/api/ai/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MOCK_MODEL_NAME,
      cache: false,
      messages: [{ role: "system", content: "Be brief" }],
    }),
  });
  assertEquals(response.status, 422);
  const issues = (await response.json()).error.issues;
  assertEquals(issues[0].path, ["messages", 0, "role"]);
  assertStringIncludes(issues[0].message, "'system' field");
});

Deno.test("a schema that cannot compile is the caller's mistake", async () => {
  const { status, error } = await withMockModel(
    rejectingWith(500, "unreached"),
    () =>
      post("/api/ai/llm/generateObject", {
        messages: [{ role: "user", content: "hi" }],
        schema: { type: "notatype" },
        model: MOCK_MODEL_NAME,
        cache: false,
      }),
  );
  assertEquals(status, 400);
  assertStringIncludes(error, "Schema cannot be compiled");
});

Deno.test("a model generateObject does not carry is the caller's mistake", async () => {
  const response = await app.request("/api/ai/llm/generateObject", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      schema: { type: "object" },
      model: "mock:no-such-model",
      cache: false,
    }),
  });
  assertEquals(response.status, 400);
  assertStringIncludes(
    (await response.json()).error,
    "Unsupported model: mock:no-such-model",
  );
});

//
// The two routes read their bodies with `c.req.json()`, which parses whatever
// arrives, while the route validator only reads `application/json`. A body
// sent as anything else meets the handler's own guard and nothing before it,
// which is the path these three cover.
//

Deno.test("a system-role message sent as text is refused by generateObject", async () => {
  const { status, error } = await post(
    "/api/ai/llm/generateObject",
    {
      messages: [{ role: "system", content: "Be brief" }],
      schema: { type: "object" },
      cache: false,
    },
    "text/plain",
  );
  assertEquals(status, 400);
  assertStringIncludes(error, "Message 0");
  assertStringIncludes(error, "'system' field");
});

Deno.test("a generateObject body that is not an object is the caller's mistake", async () => {
  const { status, error } = await post(
    "/api/ai/llm/generateObject",
    null,
    "text/plain",
  );
  assertEquals(status, 400);
  assertStringIncludes(error, "must be an object");
});

Deno.test("an empty conversation sent to generateObject is the caller's mistake", async () => {
  const { status, error } = await post(
    "/api/ai/llm/generateObject",
    { messages: [], schema: { type: "object" }, cache: false },
    "text/plain",
  );
  assertEquals(status, 400);
  assertStringIncludes(error, "'messages'");
});
