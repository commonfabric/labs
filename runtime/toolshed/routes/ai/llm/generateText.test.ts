import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { GOOGLE_SEARCH_NATIVE_MODEL_TOOL } from "@commonfabric/llm/types";
import env from "@/env.ts";
import {
  applyNativeModelTools,
  cleanJsonResponse,
  configureJsonMode,
  generateText,
} from "./generateText.ts";
import { LLMRequestError } from "./errors.ts";
import {
  MOCK_CAPABILITIES,
  registryWith,
  streamingModel,
  textModel,
} from "@/test/fixtures/llm-models.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("configureJsonMode", () => {
  it("configures JSON mode correctly for Groq models", () => {
    const streamParams: Record<string, unknown> = {};
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(streamParams, "groq:llama-3.3-70b", messages, false);

    assertEquals(streamParams.mode, undefined);
    assertEquals(streamParams.response_format, { type: "json_object" });
    assertEquals(
      (streamParams.providerOptions as Record<string, Record<string, object>>)
        .groq?.response_format,
      {
        type: "json_object",
      },
    );
    assertEquals(typeof streamParams.system, "string");
    assertEquals(
      (streamParams.system as string).includes(
        "respond with pure, correct JSON only",
      ),
      true,
    );
  });

  it("configures JSON mode correctly for OpenAI models", () => {
    const streamParams: Record<string, unknown> = {};
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(streamParams, "openai:gpt-4o", messages, false);

    assertEquals(streamParams.mode, undefined);
    assertEquals(streamParams.response_format, { type: "json_object" });
    assertEquals(
      (streamParams.providerOptions as Record<string, Record<string, object>>)
        .openai?.response_format,
      {
        type: "json_object",
      },
    );
  });

  it("configures JSON mode correctly for Anthropic models", () => {
    const streamParams: Record<string, unknown> = {};
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(
      streamParams,
      "anthropic:claude-3-7-sonnet",
      messages,
      false,
    );

    assertEquals(streamParams.mode, "json");
    assertEquals(
      (streamParams.system as string).includes("JSON generation assistant"),
      true,
    );
    assertEquals((streamParams.prefill as Record<string, string>)?.text, "{\n");
  });

  it("preserves existing system prompt while adding JSON instructions", () => {
    const streamParams: Record<string, unknown> = {
      system: "You are an expert assistant.",
    };
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(
      streamParams,
      "anthropic:claude-3-7-sonnet",
      messages,
      false,
    );

    assertEquals(
      (streamParams.system as string).includes(
        "You are a JSON generation assistant. You are an expert assistant.",
      ),
      true,
    );
    assertEquals(
      (streamParams.system as string).includes(
        "response must be ONLY valid JSON",
      ),
      true,
    );
  });

  it("configures JSON mode correctly for other providers", () => {
    const streamParams: Record<string, unknown> = {};
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(streamParams, "other:model", messages, false);

    assertEquals(streamParams.mode, "json");
    assertEquals(
      (streamParams.system as string).includes(
        "Ensure the response is valid JSON",
      ),
      true,
    );
  });

  it("adds JSON instructions to existing system prompt for other providers", () => {
    const streamParams: Record<string, unknown> = {
      system: "You are an expert assistant.",
    };
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(streamParams, "other:model", messages, false);

    assertEquals(
      streamParams.system,
      "You are an expert assistant.\nEnsure the response is valid JSON. DO NOT include any other text or formatting.",
    );
  });

  it("always adds JSON instructions even when system prompt already mentions JSON", () => {
    const streamParams: Record<string, unknown> = {
      system: "You are an expert assistant who responds in JSON format.",
    };
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(streamParams, "other:model", messages, false);

    // Should always add our JSON instructions
    assertEquals(
      streamParams.system,
      "You are an expert assistant who responds in JSON format.\nEnsure the response is valid JSON. DO NOT include any other text or formatting.",
    );
  });

  describe("streaming flag variations", () => {
    it("does not add prefill for Anthropic when streaming is true", () => {
      const streamParams: Record<string, unknown> = {};
      const messages = [{
        role: "user" as const,
        content: "Generate a JSON response",
      }];

      configureJsonMode(
        streamParams,
        "anthropic:claude-3-7-sonnet",
        messages,
        true,
      );

      assertEquals(streamParams.mode, "json");
      assertEquals(streamParams.prefill, undefined);
    });

    it("does not add prefill for Anthropic when last message is assistant", () => {
      const streamParams: Record<string, unknown> = {};
      const messages = [
        { role: "user" as const, content: "Generate a JSON response" },
        { role: "assistant" as const, content: "Sure" },
      ];

      configureJsonMode(
        streamParams,
        "anthropic:claude-3-7-sonnet",
        messages,
        false,
      );

      assertEquals(streamParams.prefill, undefined);
    });

    it("adds Groq system prompt even when streaming", () => {
      const streamParams: Record<string, unknown> = {};
      const messages = [{
        role: "user" as const,
        content: "Generate a JSON response",
      }];

      configureJsonMode(streamParams, "groq:model", messages, true);

      assertEquals(streamParams.mode, undefined);
      assertEquals(
        (streamParams.system as string).includes(
          "respond with pure, correct JSON only",
        ),
        true,
      );
    });

    it("appends Groq JSON prompt to existing system prompt", () => {
      const streamParams: Record<string, unknown> = {
        system: "You are a helper.",
      };
      const messages = [{
        role: "user" as const,
        content: "Generate a JSON response",
      }];

      configureJsonMode(streamParams, "groq:model", messages, false);

      assertEquals(
        (streamParams.system as string).startsWith("You are a helper."),
        true,
      );
      assertEquals(
        (streamParams.system as string).includes(
          "respond with pure, correct JSON only",
        ),
        true,
      );
    });
  });

  describe("gateway model JSON mode", () => {
    it("configures gateway models like OpenAI (response_format)", () => {
      const streamParams: Record<string, unknown> = {};
      const messages = [{
        role: "user" as const,
        content: "Generate a JSON response",
      }];

      configureJsonMode(streamParams, "gateway:some-model", messages, false);

      assertEquals(streamParams.mode, undefined);
      assertEquals(streamParams.response_format, { type: "json_object" });
    });
  });
});

describe("cleanJsonResponse", () => {
  it("extracts JSON from markdown code blocks", () => {
    const input = '```json\n{"name": "Test", "value": 123}\n```';
    const expected = '{"name": "Test", "value": 123}';
    assertEquals(cleanJsonResponse(input), expected);
  });

  it("extracts JSON from code blocks without language specifier", () => {
    const input = '```\n{"name": "Test", "value": 123}\n```';
    const expected = '{"name": "Test", "value": 123}';
    assertEquals(cleanJsonResponse(input), expected);
  });

  it("handles multiline JSON in code blocks", () => {
    const input = '```json\n{\n  "name": "Test",\n  "value": 123\n}\n```';
    const expected = '{\n  "name": "Test",\n  "value": 123\n}';
    assertEquals(cleanJsonResponse(input), expected);
  });

  it("returns original text if no code blocks found", () => {
    const input = '{"name": "Test", "value": 123}';
    assertEquals(cleanJsonResponse(input), input);
  });

  it("returns original text if code block format is incorrect", () => {
    const input = '```json {"name": "Test", "value": 123}```';
    assertEquals(cleanJsonResponse(input), input);
  });
});

describe("applyNativeModelTools", () => {
  it("adds provider-native Google Search tools to stream params", () => {
    const googleSearchTool = { providerTool: "google-search" };
    const streamParams: Record<string, unknown> = {
      tools: { existing_tool: { description: "existing" } },
    };

    applyNativeModelTools(
      streamParams,
      [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
      {
        name: "google:gemini-3.5-flash",
        nativeModelToolFactories: {
          [GOOGLE_SEARCH_NATIVE_MODEL_TOOL]: () => googleSearchTool,
        },
      },
    );

    assertEquals(streamParams.tools, {
      existing_tool: { description: "existing" },
      google_search: googleSearchTool,
    });
  });

  it("rejects native tools unsupported by the selected model", () => {
    assertThrows(
      () =>
        applyNativeModelTools(
          {},
          [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
          {
            name: "openai:gpt-5",
            nativeModelToolFactories: {},
          },
        ),
      Error,
      "Native model tool 'google_search' is not supported by model 'openai:gpt-5'",
    );
  });

  it("rejects name collisions with client-side tools", () => {
    assertThrows(
      () =>
        applyNativeModelTools(
          { tools: { google_search: { description: "existing" } } },
          [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
          {
            name: "google:gemini-3.5-flash",
            nativeModelToolFactories: {
              [GOOGLE_SEARCH_NATIVE_MODEL_TOOL]: () => ({}),
            },
          },
        ),
      Error,
      "Native model tool 'google_search' conflicts with an existing tool definition",
    );
  });
});

// The AI SDK reports a request that fails after it starts as an `error` part
// carried inside the response stream, not as a rejection, and the text side of
// that stream drops every part that is not text. A reader that only collects
// text therefore sees an empty response with no trace of the provider's
// complaint. These tests run generations against a mock model to check that
// the provider's complaint reaches the caller.

const MOCK_MODEL_NAME = "mock:test-model";

/** Runs `body` against a registry holding `model` alone. */
function withRegistry(
  model: LanguageModel,
  body: (models: ReturnType<typeof registryWith>) => Promise<void>,
): Promise<void> {
  return body(registryWith(MOCK_MODEL_NAME, model));
}

/**
 * A model that turns down the request the way a provider does when it rejects
 * one outright. The error is marked as not retryable so the generation reports
 * it rather than retrying behind the test's back.
 */
function rejectingModel(): LanguageModel {
  return new MockLanguageModelV4({
    doStream: () => {
      throw new APICallError({
        message: "Overloaded",
        url: "https://provider.example/v1/messages",
        requestBodyValues: {},
        statusCode: 529,
        responseBody: '{"type":"error","error":{"type":"overloaded_error"}}',
        isRetryable: false,
      });
    },
  });
}

/**
 * A model that answers without writing any text, which is what happens when a
 * model spends its whole output budget before producing a first token.
 */
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
                total: 7,
                noCache: 7,
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
 * A model that writes part of an answer and then fails, which is what happens
 * when a connection drops partway through a response.
 */
function truncatingModel(): LanguageModel {
  return new MockLanguageModelV4({
    doStream: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "1" });
          controller.enqueue({
            type: "text-delta",
            id: "1",
            delta: "Half an ans",
          });
          controller.enqueue({
            type: "error",
            error: new Error("connection reset"),
          });
          controller.close();
        },
      }),
    },
  });
}

/**
 * A model that fails with `payload` in place of an error. The AI SDK passes a
 * stream's error part through untouched, so whatever a provider put there is
 * what the reporting code has to render.
 */
function failingWithPayload(payload: unknown): LanguageModel {
  return new MockLanguageModelV4({
    doStream: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "error", error: payload });
          controller.close();
        },
      }),
    },
  });
}

/** Reads a streaming generation's response body into one line per chunk. */
async function readStreamLines(stream: ReadableStream): Promise<string[]> {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk as Uint8Array, { stream: true });
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) {
      if (line !== "") lines.push(line);
    }
  }
  if (pending !== "") lines.push(pending);
  return lines;
}

describe("generateText failure reporting", () => {
  it("reports the provider's failure for a non-streaming request", async () => {
    await withRegistry(rejectingModel(), async (models) => {
      const error = await assertRejects(
        () =>
          generateText({
            model: MOCK_MODEL_NAME,
            messages: [{ role: "user", content: "hi" }],
          }, models),
        Error,
      );

      assertStringIncludes(error.message, MOCK_MODEL_NAME);
      assertStringIncludes(error.message, "Overloaded");
      assertStringIncludes(error.message, "HTTP status 529");
      assert(
        APICallError.isInstance(error.cause),
        "the provider's error should stay reachable as the cause",
      );
      // The response body is reported through the cause, which the log
      // records, rather than through the message, which reaches the client.
      assertEquals(
        (error.cause as APICallError).responseBody,
        '{"type":"error","error":{"type":"overloaded_error"}}',
      );
    });
  });

  it("reports the finish reason when a response carries no text", async () => {
    await withRegistry(silentModel(), async (models) => {
      const error = await assertRejects(
        () =>
          generateText({
            model: MOCK_MODEL_NAME,
            messages: [{ role: "user", content: "hi" }],
          }, models),
        Error,
      );

      assertStringIncludes(error.message, MOCK_MODEL_NAME);
      assertStringIncludes(error.message, "finish reason: length");
      assertStringIncludes(error.message, "output tokens: 0");
    });
  });

  it("fails rather than returning an answer that was cut short", async () => {
    await withRegistry(truncatingModel(), async (models) => {
      const error = await assertRejects(
        () =>
          generateText({
            model: MOCK_MODEL_NAME,
            messages: [{ role: "user", content: "hi" }],
          }, models),
        Error,
      );

      assertStringIncludes(error.message, MOCK_MODEL_NAME);
      assertStringIncludes(error.message, "connection reset");
    });
  });

  it("spells out a failure the provider reported as a plain object", async () => {
    const payload = { type: "overloaded_error", message: "Overloaded" };
    await withRegistry(failingWithPayload(payload), async (models) => {
      const error = await assertRejects(
        () =>
          generateText({
            model: MOCK_MODEL_NAME,
            messages: [{ role: "user", content: "hi" }],
          }, models),
        Error,
      );

      assertStringIncludes(error.message, JSON.stringify(payload));
      assertEquals(error.message.includes("[object Object]"), false);
    });
  });

  it("survives a failure reported without a value", async () => {
    await withRegistry(failingWithPayload(null), async (models) => {
      const error = await assertRejects(
        () =>
          generateText({
            model: MOCK_MODEL_NAME,
            messages: [{ role: "user", content: "hi" }],
          }, models),
        Error,
      );

      // The description of the failure must not itself fail; a TypeError from
      // this code would replace the report with its own stack.
      assertEquals(error instanceof TypeError, false);
      assertStringIncludes(error.message, MOCK_MODEL_NAME);
    });
  });

  it("reports the provider's failure on a streaming request", async () => {
    await withRegistry(rejectingModel(), async (models) => {
      const result = await generateText({
        model: MOCK_MODEL_NAME,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }, models);
      assert(result.stream, "a streaming request should return a stream");
      const lines = await readStreamLines(result.stream);

      assertEquals(lines.length, 1);
      const event = JSON.parse(lines[0]);
      assertEquals(event.type, "error");
      assertStringIncludes(event.error, MOCK_MODEL_NAME);
      assertStringIncludes(event.error, "Overloaded");
      assertStringIncludes(event.error, "HTTP status 529");
      assertEquals(
        lines.some((line) => line.includes('"finish"')),
        false,
        "a failed stream should not report itself finished",
      );
    });
  });
});

describe("generateText generation", () => {
  // These run generations to completion against mock models and check what
  // the caller receives: the message, the conversation it extends, and on a
  // streaming request the events written to the stream.

  const user = (content = "hi") => ({ role: "user" as const, content });

  /** A model that records the options of each call and streams `parts`. */
  function recordingModel(
    parts: Parameters<typeof streamingModel>[0],
    reason: Parameters<typeof streamingModel>[1] = "stop",
  ) {
    const calls: Parameters<MockLanguageModelV4["doStream"]>[0][] = [];
    const model = new MockLanguageModelV4({
      doStream: (options) => {
        calls.push(options);
        return streamingModel(parts, reason).doStream(options);
      },
    });
    return { model, calls };
  }

  const text = (delta: string) => [
    { type: "text-start" as const, id: "t" },
    { type: "text-delta" as const, id: "t", delta },
    { type: "text-end" as const, id: "t" },
  ];

  async function streamEvents(
    params: Parameters<typeof generateText>[0],
    model: LanguageModel,
    capabilities: Parameters<typeof registryWith>[2] = {},
  ): Promise<unknown[]> {
    const result = await generateText(
      { ...params, model: MOCK_MODEL_NAME, stream: true },
      registryWith(MOCK_MODEL_NAME, model, capabilities),
    );
    assert(result.stream, "a streaming request should return a stream");
    return (await readStreamLines(result.stream)).map((line) =>
      JSON.parse(line)
    );
  }

  describe("without streaming", () => {
    it("returns the model's text appended to the conversation", async () => {
      const result = await generateText(
        { model: MOCK_MODEL_NAME, messages: [user()] },
        registryWith(MOCK_MODEL_NAME, textModel("Hello")),
      );
      expect(result.message).toEqual({ role: "assistant", content: "Hello" });
      expect(result.messages).toEqual([
        user(),
        { role: "assistant", content: "Hello" },
      ]);
      expect(result.stream).toBeUndefined();
    });

    it("appends the stop sequence to a response that stopped on it", async () => {
      const models = registryWith(MOCK_MODEL_NAME, textModel("Hello"));
      const stopped = await generateText(
        { model: MOCK_MODEL_NAME, messages: [user()], stop: "</a>" },
        models,
      );
      expect(stopped.message.content).toBe("Hello</a>");

      const cut = await generateText(
        { model: MOCK_MODEL_NAME, messages: [user()], stop: "</a>" },
        registryWith(MOCK_MODEL_NAME, textModel("Hello", "length")),
      );
      expect(cut.message.content).toBe("Hello");
    });

    it("unwraps a fenced JSON response in JSON mode and appends no stop", async () => {
      const result = await generateText(
        {
          model: MOCK_MODEL_NAME,
          messages: [user()],
          mode: "json",
          stop: "</a>",
        },
        registryWith(MOCK_MODEL_NAME, textModel('```json\n{"a":1}\n```')),
      );
      expect(result.message.content).toBe('{"a":1}');
    });

    it("replaces a prefilled assistant message with the response", async () => {
      const result = await generateText(
        {
          model: MOCK_MODEL_NAME,
          messages: [user(), { role: "assistant", content: "{" }],
        },
        registryWith(MOCK_MODEL_NAME, textModel('"a":1}')),
      );
      expect(result.messages).toEqual([
        user(),
        { role: "assistant", content: '"a":1}' },
      ]);
    });

    it("refuses a model the registry does not hold", async () => {
      await assertRejects(
        () =>
          generateText(
            { model: "mock:missing", messages: [user()] },
            registryWith(MOCK_MODEL_NAME, textModel("unused")),
          ),
        LLMRequestError,
        "Unsupported model: mock:missing",
      );
    });

    it("refuses JSON mode streamed from Groq", async () => {
      await assertRejects(
        () =>
          generateText(
            {
              model: "groq:mock",
              messages: [user()],
              mode: "json",
              stream: true,
            },
            registryWith("groq:mock", textModel("unused")),
          ),
        LLMRequestError,
        "Groq models don't support streaming in JSON mode",
      );
    });
  });

  describe("request shaping", () => {
    it("hands the model the caller's tools and stop sequence", async () => {
      const { model, calls } = recordingModel(text("ok"));
      await generateText(
        {
          model: MOCK_MODEL_NAME,
          messages: [user()],
          stop: "END",
          tools: {
            lookup: {
              description: "Looks a word up",
              inputSchema: {
                type: "object",
                properties: { word: { type: "string" } },
              },
            },
          },
        },
        registryWith(MOCK_MODEL_NAME, model),
      );
      expect(calls[0].stopSequences).toEqual(["END"]);
      expect(calls[0].tools).toMatchObject([{
        type: "function",
        name: "lookup",
        description: "Looks a word up",
      }]);
    });

    it("drops the stop sequence for a model without stop sequences", async () => {
      const { model, calls } = recordingModel(text("ok"));
      await generateText(
        { model: MOCK_MODEL_NAME, messages: [user()], stop: "END" },
        registryWith(MOCK_MODEL_NAME, model, { stopSequences: false }),
      );
      expect(calls[0].stopSequences).toBeUndefined();
    });

    it("sends the system prompt as its own message where the model takes one", async () => {
      const { model, calls } = recordingModel(text("ok"));
      await generateText(
        { model: MOCK_MODEL_NAME, messages: [user()], system: "Be brief" },
        registryWith(MOCK_MODEL_NAME, model),
      );
      expect(calls[0].prompt[0]).toEqual({
        role: "system",
        content: "Be brief",
      });
    });

    it("prepends the system prompt to a first message given as text", async () => {
      const { model, calls } = recordingModel(text("ok"));
      await generateText(
        { model: MOCK_MODEL_NAME, messages: [user()], system: "Be brief" },
        registryWith(MOCK_MODEL_NAME, model, { systemPrompt: false }),
      );
      expect(calls[0].prompt).toEqual([{
        role: "user",
        content: [{ type: "text", text: "Be brief\n\nhi" }],
      }]);
    });

    it("prepends the system prompt to a first message given as parts", async () => {
      const { model, calls } = recordingModel(text("ok"));
      await generateText(
        {
          model: MOCK_MODEL_NAME,
          messages: [{
            role: "user",
            content: [{ type: "text", text: "hi" }],
          }],
          system: "Be brief",
        },
        registryWith(MOCK_MODEL_NAME, model, { systemPrompt: false }),
      );
      expect(calls[0].prompt).toEqual([{
        role: "user",
        content: [
          { type: "text", text: "Be brief" },
          { type: "text", text: "hi" },
        ],
      }]);
    });
  });

  describe("native model tool results", () => {
    const search = () => ({
      type: "provider" as const,
      id: "google.google_search" as const,
      args: {},
    });

    function searchingRegistry() {
      const models = registryWith("google:mock", textModel("unused"));
      const { model } = recordingModel([
        {
          type: "source",
          sourceType: "url",
          id: "s1",
          url: "https://example.test/",
        },
        ...text("Found it"),
      ]);
      models.register({
        name: "google:mock",
        model,
        aliases: [],
        capabilities: { ...MOCK_CAPABILITIES },
        nativeModelToolFactories: { [GOOGLE_SEARCH_NATIVE_MODEL_TOOL]: search },
      });
      return models;
    }

    const expected = [{
      type: "cf-harness.native-model-tool-result",
      toolId: GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
      provider: "google",
      sources: [expect.objectContaining({ url: "https://example.test/" })],
    }];

    it("attaches the tool's results to the message", async () => {
      const result = await generateText(
        {
          model: "google:mock",
          messages: [user()],
          nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
        },
        searchingRegistry(),
      );
      expect(result.message).toMatchObject({
        content: "Found it",
        nativeModelToolResults: expected,
      });
    });

    it("reports the tool's results in the finish event of a stream", async () => {
      const result = await generateText(
        {
          model: "google:mock",
          messages: [user()],
          nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
          stream: true,
        },
        searchingRegistry(),
      );
      const events = (await readStreamLines(result.stream!)).map((line) =>
        JSON.parse(line)
      );
      expect(events.at(-1)).toMatchObject({
        type: "finish",
        nativeModelToolResults: expected,
      });
    });

    it("attaches nothing to a message that used no native tool", async () => {
      const result = await generateText(
        { model: MOCK_MODEL_NAME, messages: [user()] },
        registryWith(MOCK_MODEL_NAME, textModel("Hello")),
      );
      expect(result.message).not.toHaveProperty("nativeModelToolResults");
    });
  });

  describe("streaming", () => {
    it("writes each text delta and then a finish event", async () => {
      const completed: unknown[] = [];
      const events = await streamEvents(
        {
          model: MOCK_MODEL_NAME,
          messages: [user()],
          onStreamComplete: (result) => completed.push(result.messages),
        },
        streamingModel([
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Hel" },
          { type: "text-delta", id: "t", delta: "lo" },
          { type: "text-end", id: "t" },
        ]),
      );
      expect(events).toEqual([
        { type: "text-delta", textDelta: "Hel" },
        { type: "text-delta", textDelta: "lo" },
        { type: "finish" },
      ]);
      expect(completed).toEqual([[
        user(),
        { role: "assistant", content: "Hello" },
      ]]);
    });

    it("writes the stop sequence after a response that stopped on it", async () => {
      const events = await streamEvents(
        { model: MOCK_MODEL_NAME, messages: [user()], stop: "END" },
        textModel("Hi"),
      );
      expect(events).toEqual([
        { type: "text-delta", textDelta: "Hi" },
        "END",
        { type: "finish" },
      ]);
    });

    it("unwraps a fenced JSON response in JSON mode", async () => {
      const completed: unknown[] = [];
      await streamEvents(
        {
          model: MOCK_MODEL_NAME,
          messages: [user()],
          mode: "json",
          onStreamComplete: (result) => completed.push(result.message),
        },
        textModel('```json\n{"a":1}\n```'),
      );
      expect(completed).toEqual([{ role: "assistant", content: '{"a":1}' }]);
    });

    it("writes a prefilled assistant message first and extends it", async () => {
      const completed: unknown[] = [];
      const events = await streamEvents(
        {
          model: MOCK_MODEL_NAME,
          messages: [user(), { role: "assistant", content: "{" }],
          onStreamComplete: (result) => completed.push(result.messages),
        },
        textModel("}"),
      );
      expect(events).toEqual([
        "{",
        { type: "text-delta", textDelta: "}" },
        { type: "finish" },
      ]);
      expect(completed).toEqual([[
        user(),
        { role: "assistant", content: "{}" },
      ]]);
    });

    it("reports a prefilled assistant message given as parts", async () => {
      const events = await streamEvents(
        {
          model: MOCK_MODEL_NAME,
          messages: [user(), {
            role: "assistant",
            content: [{ type: "text", text: "{" }],
          }],
        },
        textModel("}"),
      );
      expect(events).toEqual([{
        type: "error",
        error: "Structured content not supported in responses.",
      }]);
    });

    it("writes tool calls and records them in the message", async () => {
      const completed: unknown[] = [];
      const events = await streamEvents(
        {
          model: MOCK_MODEL_NAME,
          messages: [user()],
          tools: {
            lookup: {
              description: "Looks a word up",
              inputSchema: {
                type: "object",
                properties: { word: { type: "string" } },
              },
            },
          },
          onStreamComplete: (result) => completed.push(result.message),
        },
        streamingModel([
          ...text("Let me look."),
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "lookup",
            input: '{"word":"fabric"}',
          },
        ], "tool-calls"),
      );
      expect(events).toEqual([
        { type: "text-delta", textDelta: "Let me look." },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "lookup",
          args: { word: "fabric" },
        },
        { type: "finish" },
      ]);
      expect(completed).toEqual([{
        role: "assistant",
        content: [
          { type: "text", text: "Let me look." },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "lookup",
            input: { word: "fabric" },
          },
        ],
      }]);
    });

    it("records a turn of tool calls alone without a text part", async () => {
      const completed: unknown[] = [];
      await streamEvents(
        {
          model: MOCK_MODEL_NAME,
          messages: [user()],
          tools: {
            lookup: {
              description: "Looks a word up",
              inputSchema: { type: "object" },
            },
          },
          onStreamComplete: (result) => completed.push(result.message),
        },
        streamingModel([{
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "lookup",
          input: "{}",
        }], "tool-calls"),
      );
      expect(completed).toEqual([{
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "lookup",
          input: {},
        }],
      }]);
    });

    it("writes the result of a tool the provider ran", async () => {
      const models = registryWith(MOCK_MODEL_NAME, textModel("unused"));
      models.register({
        name: MOCK_MODEL_NAME,
        model: streamingModel([
          {
            type: "tool-call",
            toolCallId: "search-1",
            toolName: GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
            input: "{}",
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "search-1",
            toolName: GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
            result: { hits: 1 },
          },
          ...text("Found"),
        ]),
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
      const result = await generateText({
        model: MOCK_MODEL_NAME,
        messages: [user()],
        nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
        stream: true,
      }, models);
      const events = (await readStreamLines(result.stream!)).map((line) =>
        JSON.parse(line)
      );
      expect(events).toContainEqual({
        type: "tool-result",
        toolCallId: "search-1",
        result: { hits: 1 },
      });
    });
  });

  describe("failure descriptions", () => {
    async function failureMessage(payload: unknown): Promise<string> {
      const error = await assertRejects(
        () =>
          generateText(
            { model: MOCK_MODEL_NAME, messages: [user()] },
            registryWith(MOCK_MODEL_NAME, failingWithPayload(payload)),
          ),
        Error,
      );
      return error.message;
    }

    it("includes the provider data a stream provider error carries", async () => {
      const failure = Object.assign(new Error("stream broke"), {
        name: "AI_StreamProviderError",
        data: { code: "overloaded" },
      });
      expect(await failureMessage(failure)).toBe(
        `LLM request to ${MOCK_MODEL_NAME} failed: AI_StreamProviderError: ` +
          'stream broke; provider data: {"code":"overloaded"}',
      );
    });

    it("truncates a long description", async () => {
      const message = await failureMessage(new Error("x".repeat(5000)));
      expect(message).toContain("… (truncated)");
      expect(message.length).toBeLessThan(1100);
    });

    it("describes a plain object that cannot be serialized", async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(await failureMessage(circular)).toBe(
        `LLM request to ${MOCK_MODEL_NAME} failed: [object Object]`,
      );
    });

    it("describes a failure reported as a string", async () => {
      expect(await failureMessage("plain failure")).toBe(
        `LLM request to ${MOCK_MODEL_NAME} failed: plain failure`,
      );
    });
  });
});
