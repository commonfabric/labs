import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
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
import { MODELS } from "./models.ts";

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

/**
 * Registers `model` under a name that `findModel` resolves, runs `body`, then
 * takes the registration back out of the shared model list.
 */
async function withMockModel(
  model: LanguageModel,
  body: () => Promise<void>,
): Promise<void> {
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
  try {
    await body();
  } finally {
    delete MODELS[MOCK_MODEL_NAME];
  }
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
    await withMockModel(rejectingModel(), async () => {
      const error = await assertRejects(
        () =>
          generateText({
            model: MOCK_MODEL_NAME,
            messages: [{ role: "user", content: "hi" }],
          }),
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
    await withMockModel(silentModel(), async () => {
      const error = await assertRejects(
        () =>
          generateText({
            model: MOCK_MODEL_NAME,
            messages: [{ role: "user", content: "hi" }],
          }),
        Error,
      );

      assertStringIncludes(error.message, MOCK_MODEL_NAME);
      assertStringIncludes(error.message, "finish reason: length");
      assertStringIncludes(error.message, "output tokens: 0");
    });
  });

  it("fails rather than returning an answer that was cut short", async () => {
    await withMockModel(truncatingModel(), async () => {
      const error = await assertRejects(
        () =>
          generateText({
            model: MOCK_MODEL_NAME,
            messages: [{ role: "user", content: "hi" }],
          }),
        Error,
      );

      assertStringIncludes(error.message, MOCK_MODEL_NAME);
      assertStringIncludes(error.message, "connection reset");
    });
  });

  it("spells out a failure the provider reported as a plain object", async () => {
    const payload = { type: "overloaded_error", message: "Overloaded" };
    await withMockModel(failingWithPayload(payload), async () => {
      const error = await assertRejects(
        () =>
          generateText({
            model: MOCK_MODEL_NAME,
            messages: [{ role: "user", content: "hi" }],
          }),
        Error,
      );

      assertStringIncludes(error.message, JSON.stringify(payload));
      assertEquals(error.message.includes("[object Object]"), false);
    });
  });

  it("survives a failure reported without a value", async () => {
    await withMockModel(failingWithPayload(null), async () => {
      const error = await assertRejects(
        () =>
          generateText({
            model: MOCK_MODEL_NAME,
            messages: [{ role: "user", content: "hi" }],
          }),
        Error,
      );

      // The description of the failure must not itself fail; a TypeError from
      // this code would replace the report with its own stack.
      assertEquals(error instanceof TypeError, false);
      assertStringIncludes(error.message, MOCK_MODEL_NAME);
    });
  });

  it("reports the provider's failure on a streaming request", async () => {
    await withMockModel(rejectingModel(), async () => {
      const result = await generateText({
        model: MOCK_MODEL_NAME,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
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
