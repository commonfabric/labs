import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  addMockResponse,
  clearMockResponses,
  enableMockMode,
} from "@commonfabric/llm/client";
import { LLMClient } from "@commonfabric/llm";
import type { BuiltInLLMMessage } from "@commonfabric/api";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { waitForLlmSettled } from "./support/llm-result.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Enable mock mode once for all tests
enableMockMode();

describe("generateText", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let generateText: ReturnType<
    typeof createBuilder
  >["commonfabric"]["generateText"];

  let dummyPattern: any;

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern, generateText } = commonfabric);
    dummyPattern = pattern(() => ({}), { type: "object" });
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should generate text from a simple prompt", async () => {
    const testPrompt = "Say hello";
    const expectedResponse = "Hello world!";

    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      {
        role: "assistant",
        content: expectedResponse,
        id: "mock-simple-prompt",
      },
    );

    const testPattern = pattern(() => {
      return generateText({
        prompt: testPrompt,
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-simple-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe(expectedResponse);
  });

  it("starts the LLM request only after the transaction commits", async () => {
    const testPrompt = "post-commit-gated-generateText";

    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      {
        role: "assistant",
        content: "gated response",
        id: "mock-post-commit",
      },
    );

    const originalSendRequest = LLMClient.prototype.sendRequest;
    const sendRequestCalls: number[] = [];
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      sendRequestCalls.push(Date.now());
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      const testPattern = pattern(() => {
        return generateText({
          prompt: testPrompt,
        });
      });

      const resultCell = runtime.getCell(
        space,
        "generateText-post-commit-gated-test",
        testPattern.resultSchema,
        tx,
      );

      const result = runtime.run(tx, testPattern, {}, resultCell);

      expect(sendRequestCalls).toEqual([]);

      const commitPromise = tx.commit().settled;
      expect(sendRequestCalls).toEqual([]);

      await commitPromise;
      await waitForLlmSettled(runtime, result);

      expect(sendRequestCalls.length).toBeGreaterThan(0);
      expect(result.key("result").get()).toBe("gated response");
    } finally {
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("should generate text from messages", async () => {
    const messages: BuiltInLLMMessage[] = [
      { role: "user", content: "Knock knock" },
      { role: "assistant", content: "Who's there?" },
      { role: "user", content: "Orange" },
    ];
    const expectedResponse = "Orange who?";

    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes("Orange")
        ),
      {
        role: "assistant",
        content: expectedResponse,
        id: "mock-messages",
      },
    );

    const testPattern = pattern(() => {
      return generateText({
        messages,
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-messages-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe(expectedResponse);
  });

  it("should support system parameter", async () => {
    const testPrompt = "Who are you?";
    const systemPrompt = "You are a pirate.";
    const expectedResponse = "I be a pirate!";

    addMockResponse(
      (req) =>
        req.system === systemPrompt &&
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      {
        role: "assistant",
        content: expectedResponse,
        id: "mock-system-prompt",
      },
    );

    const testPattern = pattern(() => {
      return generateText({
        prompt: testPrompt,
        system: systemPrompt,
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-system-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe(expectedResponse);
  });

  it("should support tools", async () => {
    const testPrompt = "What is the weather?";
    const expectedResponse = "The weather is Sunny.";

    // Mock tool call
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && req.tools?.["getWeather"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_weather",
            toolName: "getWeather",
            input: {},
          },
        ],
        id: "mock-tool-call",
      },
    );

    // Mock tool result processing and final response
    addMockResponse(
      (req) =>
        req.messages.some((m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolCallId === "call_weather"
          )
        ),
      {
        role: "assistant",
        content: expectedResponse,
        id: "mock-tool-result",
      },
    );

    const testPattern = pattern(() => {
      return generateText({
        prompt: testPrompt,
        tools: {
          getWeather: {
            description: "Get the weather",
            pattern: dummyPattern,
          },
        },
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-tools-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe(expectedResponse);
  });
});

describe("generateText with queue", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let generateText: ReturnType<
    typeof createBuilder
  >["commonfabric"]["generateText"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern, generateText } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should work with a queue parameter", async () => {
    const testPrompt = "Queued hello";
    const expectedResponse = "Queued world!";

    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      {
        role: "assistant",
        content: expectedResponse,
        id: "mock-queued",
      },
    );

    const testPattern = pattern(() => {
      return generateText({
        prompt: testPrompt,
        queue: "test-queue",
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-queue-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe(expectedResponse);
  });

  it("should create the named queue in the runtime", async () => {
    addMockResponse(
      () => true,
      {
        role: "assistant",
        content: "response",
        id: "mock-queue-creation",
      },
    );

    const testPattern = pattern(() => {
      return generateText({
        prompt: "test",
        queue: "my-named-queue",
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-queue-creation-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);
    // The queue records completion after the writeback's commit round trip;
    // drain the in-flight transport frames before reading the stats.
    await clock.settle();

    // Verify the queue was created in the runtime registry
    const queue = runtime.getOrCreateQueue("my-named-queue");
    expect(queue.stats.completed).toBeGreaterThanOrEqual(1);
  });

  it("should allow pre-configuring queue concurrency", async () => {
    // Pre-configure the queue before any patterns use it
    runtime.configureQueue("pre-configured", { maxConcurrency: 5 });

    addMockResponse(
      () => true,
      {
        role: "assistant",
        content: "response",
        id: "mock-preconfigured",
      },
    );

    const testPattern = pattern(() => {
      return generateText({
        prompt: "test",
        queue: "pre-configured",
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-preconfigured-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe("response");

    // Verify configureQueue actually applied the concurrency limit.
    const queue = runtime.getOrCreateQueue("pre-configured");
    expect(queue.maxConcurrency).toBe(5);
  });
});
