/**
 * Tests demonstrating conversation fixtures for LLM testing.
 *
 * These tests use declarative JSON fixture files instead of inline
 * addMockResponse() calls, making multi-turn conversations easier
 * to read, write, and maintain.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type {
  BuiltInLLMMessage,
  BuiltInLLMTool,
  JSONSchema,
} from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  clearMockResponses,
  type ConversationFixture,
  loadConversationFixture,
  loadConversationFixtureFile,
} from "@commonfabric/llm/client";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import { generateObjectState } from "../src/builder/built-in.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { waitForLlmMessages, waitForLlmSettled } from "./support/llm-result.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator fixtures");
const space = signer.did();

const FIXTURES_DIR = join(import.meta.dirname!, "fixtures");

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
    pending: { type: "boolean" },
    error: { type: "object", additionalProperties: true },
    messages: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
  required: ["addMessage"],
} as const satisfies JSONSchema;

describe("conversation fixtures", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createBuilder>["commonfabric"]["Cell"];
  let patternTool: ReturnType<
    typeof createBuilder
  >["commonfabric"]["patternTool"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let generateObject: typeof generateObjectState;
  let llmDialog: ReturnType<typeof createBuilder>["commonfabric"]["llmDialog"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({
      pattern,
      llmDialog,
      Cell,
      patternTool,
    } = commonfabric);
    generateObject = generateObjectState;
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("simple multi-turn conversation loaded from file", async () => {
    await loadConversationFixtureFile(
      join(FIXTURES_DIR, "simple-multi-turn.json"),
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          messages,
        };
      },
      false,
      RESULT_SCHEMA,
    );

    const resultCell = runtime.getCell(
      space,
      "fixture-simple-multi-turn",
      RESULT_SCHEMA,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // Turn 1: send greeting
    addMessage.send({ role: "user", content: "Hello" });
    await waitForLlmMessages(runtime, result, 2);

    // Verify turn 1
    const msgs1 = (await result.key("messages").pull())!;
    expect(msgs1[0].content).toBe("Hello");
    expect(msgs1[1].content).toBe("Hi there!");

    // Turn 2: send follow-up
    addMessage.send({ role: "user", content: "How are you?" });
    await waitForLlmMessages(runtime, result, 4);

    // Verify turn 2
    const msgs2 = (await result.key("messages").pull())!;
    expect(msgs2[2].content).toBe("How are you?");
    expect(msgs2[3].content).toBe("I'm doing well, thanks!");
  });

  it("multi-turn conversation with tool calls loaded from file", async () => {
    await loadConversationFixtureFile(
      join(FIXTURES_DIR, "multi-turn-dialog.json"),
    );

    const getWeatherTool = pattern(
      ({ location: _location }: any) => {
        return "Sunny, 72°F";
      },
      {
        description: "Get current weather for a location",
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
      } as const satisfies JSONSchema,
      { type: "string" },
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          tools: {
            getWeather: patternTool(
              getWeatherTool,
            ) as unknown as BuiltInLLMTool,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          messages,
        };
      },
      false,
      RESULT_SCHEMA,
    );

    const resultCell = runtime.getCell(
      space,
      "fixture-multi-turn-tools",
      RESULT_SCHEMA,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // Turn 1: greeting
    addMessage.send({ role: "user", content: "Hello" });
    await waitForLlmMessages(runtime, result, 2);

    expect((await result.key("messages").pull())![1].content).toBe(
      "Hi there! How can I help you today?",
    );

    // Turn 2: ask about weather (triggers tool call chain)
    addMessage.send({
      role: "user",
      content: "What's the weather in San Francisco?",
    });
    // user msg + assistant tool-call + tool result + assistant final = 4 new msgs
    await waitForLlmMessages(runtime, result, 6);

    const msgs = (await result.key("messages").pull())!;
    // Verify tool call was made
    const toolCallMsg = msgs[3];
    expect(toolCallMsg.role).toBe("assistant");
    expect(Array.isArray(toolCallMsg.content)).toBe(true);
    expect((toolCallMsg.content as any[])[0].toolName).toBe("getWeather");

    // Verify final response
    const finalMsg = msgs[5];
    expect(finalMsg.role).toBe("assistant");
    expect(finalMsg.content).toBe(
      "The weather in San Francisco is sunny and 72°F. Anything else?",
    );
  });

  it("inline fixture without file", async () => {
    const fixture: ConversationFixture = {
      description: "Inline fixture for quick one-off tests",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            messagesContain: ["meaning of life"],
          },
          response: {
            role: "assistant",
            content: "The answer is 42.",
            id: "inline-1",
          },
        },
      ],
    };

    loadConversationFixture(fixture);

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          messages,
        };
      },
      false,
      RESULT_SCHEMA,
    );

    const resultCell = runtime.getCell(
      space,
      "fixture-inline",
      RESULT_SCHEMA,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    addMessage.send({
      role: "user",
      content: "What is the meaning of life?",
    });
    await waitForLlmMessages(runtime, result, 2);

    const msgs = (await result.key("messages").pull())!;
    expect(msgs[1].content).toBe("The answer is 42.");
  });

  it("fixture with generateObject responses", async () => {
    loadConversationFixture({
      responses: [
        {
          type: "generateObject",
          response: {
            object: { title: "Test Title", score: 95 },
            id: "gen-obj-1",
          },
        },
      ],
    });

    const testPattern = pattern(
      () => {
        return generateObject({
          prompt: "Generate a title",
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              score: { type: "number" },
            },
          },
        });
      },
    );

    const resultCell = runtime.getCell(
      space,
      "fixture-generate-object",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toEqual({
      title: "Test Title",
      score: 95,
    });
  });
});
