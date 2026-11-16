import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { GOOGLE_SEARCH_NATIVE_MODEL_TOOL } from "@commonfabric/llm/types";

import type { ResponseCache } from "./llm.handlers.ts";
import { createLLMRouter } from "./llm.router.ts";
import { createModelRegistry, type ModelRegistry } from "./models.ts";
import {
  memoryCache,
  MOCK_CAPABILITIES,
  objectModel,
  recordingLogger,
  refusingFetch,
  textModel,
} from "@/test/fixtures/llm-models.ts";

const MODEL = "mock:model";

/** A model that answers with the number of times it has been asked. */
function countingModel() {
  let asked = 0;
  const options: Parameters<MockLanguageModelV4["doStream"]>[0][] = [];
  const model = new MockLanguageModelV4({
    doStream: (callOptions) => {
      asked += 1;
      options.push(callOptions);
      return textModel(`Answer ${asked}`).doStream(callOptions);
    },
  });
  return { model, asked: () => asked, options };
}

/** A model that turns the request down with HTTP `status`. */
function refusingModel(status: number): LanguageModel {
  const refusal = () => {
    throw new APICallError({
      message: "Refused",
      url: "https://provider.test",
      requestBodyValues: {},
      statusCode: status,
      isRetryable: false,
    });
  };
  return new MockLanguageModelV4({ doStream: refusal, doGenerate: refusal });
}

/** A registry serving each model in `models` under its name. */
function registryOf(models: Record<string, LanguageModel>): ModelRegistry {
  const registry = createModelRegistry({
    fetch: refusingFetch,
    logger: recordingLogger(),
  });
  for (const [name, model] of Object.entries(models)) {
    registry.register({
      name,
      model,
      capabilities: MOCK_CAPABILITIES,
      aliases: [],
    });
  }
  return registry;
}

/** Routes over `models` and `cache`, and a way to post JSON to them. */
function routes(
  models: ModelRegistry,
  cache: ResponseCache = memoryCache(),
) {
  const router = createLLMRouter({ models, cache });
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    router.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { router, post };
}

/** A cache whose every save is refused. */
function refusingCache(): ResponseCache & { saves: () => number } {
  let saves = 0;
  return {
    load: () => Promise.resolve(null),
    save: () => {
      saves += 1;
      return Promise.reject(new Error("disk full"));
    },
    saves: () => saves,
  };
}

const conversation = [{ role: "user", content: "hi" }];

/**
 * Runs `send` inside an active span, as the server's tracing middleware does,
 * and returns its response with the span's id and recorded attributes.
 */
async function underActiveSpan(send: () => Response | Promise<Response>) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  try {
    const { response, spanId } = await provider.getTracer("test")
      .startActiveSpan("request", async (span) => {
        const response = await send();
        span.end();
        return { response, spanId: span.spanContext().spanId };
      });
    const recorded = exporter.getFinishedSpans().find((span) =>
      span.name === "request"
    );
    return { response, spanId, attributes: recorded?.attributes };
  } finally {
    context.disable();
    await provider.shutdown();
  }
}

describe("llm.handlers", () => {
  describe("GET /api/ai/llm/models", () => {
    function catalog() {
      const registry = createModelRegistry({
        fetch: refusingFetch,
        logger: recordingLogger(),
      });
      const model = textModel("unused");
      registry.register({
        name: "anthropic:claude-sonnet-4-6",
        model,
        aliases: ["sonnet-4.6"],
        capabilities: { ...MOCK_CAPABILITIES, images: true },
      });
      registry.register({
        name: "openai:gpt-5",
        model,
        aliases: [],
        capabilities: { ...MOCK_CAPABILITIES, reasoning: true },
      });
      return routes(registry).router;
    }

    async function listed(query = ""): Promise<Record<string, any>> {
      const response = await catalog().request(`/api/ai/llm/models${query}`);
      expect(response.status).toBe(200);
      return await response.json();
    }

    it("lists each primary name with its aliases", async () => {
      const models = await listed();
      expect(Object.keys(models)).toEqual([
        "anthropic:claude-sonnet-4-6",
        "openai:gpt-5",
      ]);
      expect(models["anthropic:claude-sonnet-4-6"]).toMatchObject({
        name: "anthropic:claude-sonnet-4-6",
        aliases: ["sonnet-4.6"],
        capabilities: { images: true },
      });
      expect(models["openai:gpt-5"].aliases).toEqual([]);
    });

    it("narrows the list to names containing the search, in any case", async () => {
      expect(Object.keys(await listed("?search=SONNET"))).toEqual([
        "anthropic:claude-sonnet-4-6",
      ]);
      expect(Object.keys(await listed("?search=llama"))).toEqual([]);
    });

    it("narrows the list to models holding every named capability", async () => {
      expect(Object.keys(await listed("?capability=streaming,images")))
        .toEqual(["anthropic:claude-sonnet-4-6"]);
      expect(Object.keys(await listed("?capability=images,reasoning")))
        .toEqual([]);
    });

    it("narrows the list to the model chosen for a task", async () => {
      expect(Object.keys(await listed("?task=creative"))).toEqual([
        "openai:gpt-5",
      ]);
      expect(Object.keys(await listed("?task=vision"))).toEqual([]);
    });

    it("waits for gateway discovery before listing", async () => {
      const discovery = Promise.withResolvers<Response>();
      const registry = createModelRegistry({
        gatewayUrl: "https://gateway.test",
        fetch: () => discovery.promise,
        logger: recordingLogger(),
      });
      const response = routes(registry).router.request("/api/ai/llm/models");
      discovery.resolve(Response.json({
        object: "list",
        data: [{
          id: "late",
          object: "model",
          owned_by: "vendor",
          capabilities: {},
        }],
      }));
      expect(Object.keys(await (await response).json())).toEqual([
        "gateway:late",
      ]);
    });
  });

  describe("POST /api/ai/llm", () => {
    it("returns the model's message", async () => {
      const { post } = routes(registryOf({ [MODEL]: textModel("Hello") }));
      const response = await post("/api/ai/llm", {
        model: MODEL,
        messages: conversation,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-cf-llm-trace-id")).toBeNull();
      expect(await response.json()).toEqual({
        role: "assistant",
        content: "Hello",
      });
    });

    it("answers an identical request from the cache", async () => {
      const { model, asked } = countingModel();
      const cache = memoryCache();
      const { post } = routes(registryOf({ [MODEL]: model }), cache);
      const request = { model: MODEL, messages: conversation };

      const first = await (await post("/api/ai/llm", request)).json();
      const second = await (
        await post("/api/ai/llm", request, { "Tailscale-User-Login": "u" })
      ).json();

      expect(second).toEqual(first);
      expect(asked()).toBe(1);
      expect([...cache.entries.values()]).toEqual([{
        model: MODEL,
        messages: [...conversation, { role: "assistant", content: "Answer 1" }],
        maxTokens: MOCK_CAPABILITIES.maxOutputTokens,
      }]);
    });

    it("neither reads nor writes the cache for `cache: false`", async () => {
      const { model, asked } = countingModel();
      const cache = memoryCache();
      const { post } = routes(registryOf({ [MODEL]: model }), cache);
      const request = { model: MODEL, messages: conversation, cache: false };

      await post("/api/ai/llm", request);
      await post("/api/ai/llm", request);

      expect(asked()).toBe(2);
      expect(cache.entries.size).toBe(0);
    });

    it("answers a request using a native model tool live", async () => {
      const { model, asked } = countingModel();
      const registry = registryOf({});
      registry.register({
        name: MODEL,
        model,
        aliases: [],
        capabilities: MOCK_CAPABILITIES,
        nativeModelToolFactories: {
          [GOOGLE_SEARCH_NATIVE_MODEL_TOOL]: () => ({
            type: "provider",
            id: "google.google_search",
            args: {},
          }),
        },
      });
      const cache = memoryCache();
      const { post } = routes(registry, cache);
      const request = {
        model: MODEL,
        messages: conversation,
        nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
      };

      expect((await post("/api/ai/llm", request)).status).toBe(200);
      expect((await post("/api/ai/llm", request)).status).toBe(200);

      expect(asked()).toBe(2);
      expect(cache.entries.size).toBe(0);
    });

    it("answers even when the response cannot be cached", async () => {
      const cache = refusingCache();
      const { post } = routes(registryOf({ [MODEL]: textModel("Hi") }), cache);
      const response = await post("/api/ai/llm", {
        model: MODEL,
        messages: conversation,
      });
      expect(response.status).toBe(200);
      expect(cache.saves()).toBe(1);
    });

    it("asks the model for its output budget unless the request sets one", async () => {
      const { model, options } = countingModel();
      const { post } = routes(registryOf({ [MODEL]: model }));

      await post("/api/ai/llm", {
        model: MODEL,
        messages: conversation,
        cache: false,
      });
      await post("/api/ai/llm", {
        model: MODEL,
        messages: conversation,
        cache: false,
        maxTokens: 7,
      });

      expect(options.map((o) => o.maxOutputTokens)).toEqual([
        MOCK_CAPABILITIES.maxOutputTokens,
        7,
      ]);
    });

    it("streams the response and caches it once the stream ends", async () => {
      const cache = memoryCache();
      const { post } = routes(
        registryOf({ [MODEL]: textModel("Streamed") }),
        cache,
      );
      const response = await post("/api/ai/llm", {
        model: MODEL,
        messages: conversation,
        stream: true,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      expect(cache.entries.size).toBe(0);
      const lines = (await response.text()).trim().split("\n").map((line) =>
        JSON.parse(line)
      );
      expect(lines).toEqual([
        { type: "text-delta", textDelta: "Streamed" },
        { type: "finish" },
      ]);
      expect([...cache.entries.values()][0].messages.at(-1)).toEqual({
        role: "assistant",
        content: "Streamed",
      });
    });

    it("refuses a model it does not carry", async () => {
      const { post } = routes(registryOf({}));
      const response = await post("/api/ai/llm", {
        model: "mock:missing",
        messages: conversation,
        cache: false,
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "Unknown model 'mock:missing'. GET /api/ai/llm/models for available models.",
      );
    });

    it("refuses JSON mode streamed from Groq", async () => {
      const { post } = routes(registryOf({ "groq:mock": textModel("{}") }));
      const request = {
        model: "groq:mock",
        messages: conversation,
        mode: "json",
        cache: false,
      };

      const streamed = await post("/api/ai/llm?stream=true", request);
      expect(streamed.status).toBe(400);
      expect((await streamed.json()).error).toContain(
        "Groq models don't support streaming in JSON mode",
      );
      expect((await post("/api/ai/llm", request)).status).toBe(200);
    });

    it("reports the model's refusal with the status it maps to", async () => {
      const { post } = routes(registryOf({ [MODEL]: refusingModel(429) }));
      const response = await post("/api/ai/llm", {
        model: MODEL,
        messages: conversation,
        cache: false,
      });
      expect(response.status).toBe(429);
      expect((await response.json()).error).toContain("Refused");
    });

    it("reports a request that fails validation", async () => {
      const { router } = routes(registryOf({}));
      const response = await router.request("/api/ai/llm", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ model: MODEL, messages: [] }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/^Invalid request: /);
    });

    it("names the span it ran under and records the request's metadata", async () => {
      const { post } = routes(registryOf({ [MODEL]: textModel("Hi") }));
      const { response, spanId, attributes } = await underActiveSpan(() =>
        post("/api/ai/llm", {
          model: MODEL,
          messages: conversation,
          cache: false,
          metadata: { label: "x", count: 2, nested: { a: 1 } },
        }, { "Tailscale-User-Login": "user@test" })
      );

      expect(response.headers.get("x-cf-llm-trace-id")).toBe(spanId);
      expect(attributes).toMatchObject({
        "metadata.label": "x",
        "metadata.count": 2,
        "metadata.nested": '{"a":1}',
        "metadata.user": "user@test",
        "metadata.model": MODEL,
      });
    });
  });

  describe("POST /api/ai/llm/generateObject", () => {
    const schema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    };

    it("returns the object the model generated", async () => {
      const { post } = routes(
        registryOf({ [MODEL]: objectModel({ value: "v" }) }),
      );
      const response = await post("/api/ai/llm/generateObject", {
        model: MODEL,
        messages: conversation,
        schema,
        cache: false,
      });
      expect(response.status).toBe(200);
      expect((await response.json()).object).toEqual({ value: "v" });
    });

    it("answers an identical request from the cache", async () => {
      let asked = 0;
      const model = new MockLanguageModelV4({
        doGenerate: (options) => {
          asked += 1;
          return objectModel({ value: `v${asked}` }).doGenerate(options);
        },
      });
      const cache = memoryCache();
      const { post } = routes(registryOf({ [MODEL]: model }), cache);
      const request = { model: MODEL, messages: conversation, schema };

      const first = await (await post("/api/ai/llm/generateObject", request))
        .json();
      const second = await (await post("/api/ai/llm/generateObject", request))
        .json();

      expect(first.object).toEqual({ value: "v1" });
      expect(second).toEqual({ object: { value: "v1" } });
      expect(asked).toBe(1);
      expect([...cache.entries.values()][0].object).toEqual({ value: "v1" });
    });

    it("neither reads nor writes the cache for `cache: false`", async () => {
      const cache = memoryCache();
      const { post } = routes(
        registryOf({ [MODEL]: objectModel({ value: "v" }) }),
        cache,
      );
      await post("/api/ai/llm/generateObject", {
        model: MODEL,
        messages: conversation,
        schema,
        cache: false,
      });
      expect(cache.entries.size).toBe(0);
    });

    it("answers even when the object cannot be cached", async () => {
      const cache = refusingCache();
      const { post } = routes(
        registryOf({ [MODEL]: objectModel({ value: "v" }) }),
        cache,
      );
      const response = await post("/api/ai/llm/generateObject", {
        model: MODEL,
        messages: conversation,
        schema,
      });
      expect(response.status).toBe(200);
      expect(cache.saves()).toBe(1);
    });

    it("reports the model's refusal with the status it maps to", async () => {
      const { post } = routes(registryOf({ [MODEL]: refusingModel(503) }));
      const response = await post("/api/ai/llm/generateObject", {
        model: MODEL,
        messages: conversation,
        schema,
        cache: false,
      });
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain("Refused");
    });

    it("names the span it ran under and records the request's metadata", async () => {
      const { post } = routes(
        registryOf({ [MODEL]: objectModel({ value: "v" }) }),
      );
      const { response, spanId, attributes } = await underActiveSpan(() =>
        post("/api/ai/llm/generateObject", {
          model: MODEL,
          messages: conversation,
          schema,
          cache: false,
          metadata: { label: "x" },
        }, { "Tailscale-User-Login": "user@test" })
      );

      expect((await response.json()).id).toBe(spanId);
      expect(attributes).toMatchObject({
        "metadata.label": "x",
        "metadata.user": "user@test",
      });
    });

    it("reports an object that does not satisfy the schema as a bad gateway", async () => {
      const cache = memoryCache();
      const { post } = routes(
        registryOf({ [MODEL]: objectModel({ value: 5 }) }),
        cache,
      );
      const response = await post("/api/ai/llm/generateObject", {
        model: MODEL,
        messages: conversation,
        schema,
      });
      expect(response.status).toBe(502);
      expect((await response.json()).error).toContain("No object generated");
      expect(cache.entries.size).toBe(0);
    });

    it("reports a body that is not JSON", async () => {
      const { router } = routes(registryOf({}));
      const response = await router.request("/api/ai/llm/generateObject", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(
        /^Request body is not JSON: /,
      );
    });
  });
});
