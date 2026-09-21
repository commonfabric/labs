/**
 * LLM pattern smoke tests.
 *
 * These exercise representative LLM usage patterns through the runtime,
 * verifying the full path from pattern → LLM client → mock response.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm/client";
import { GOOGLE_SEARCH_NATIVE_MODEL_TOOL } from "@commonfabric/llm/types";
import type { BuiltInLLMMessage } from "@commonfabric/api";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { waitForLlmSettled } from "./support/llm-result.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("LLM pattern smoke tests", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let generateText: ReturnType<
    typeof createBuilder
  >["commonfabric"]["generateText"];
  let generateObject: ReturnType<
    typeof createBuilder
  >["commonfabric"]["generateObject"];
  let dummyPattern: any;

  beforeEach(() => {
    enableMockMode();
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern, generateText, generateObject } = commonfabric);
    dummyPattern = pattern(() => ({}), { type: "object" });
  });

  afterEach(async () => {
    resetMockMode();
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("simple generateText with prompt and system", async () => {
    const prompt = "smoke-test-simple-generateText";
    const system = "You are a helpful assistant.";

    addMockResponse(
      (req) =>
        req.system === system &&
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        role: "assistant",
        content: "Hello from mock!",
        id: "smoke-1",
      },
    );

    const testPattern = pattern(() => {
      return generateText({ prompt, system });
    });

    const resultCell = runtime.getCell(
      space,
      "smoke-simple-generateText",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe("Hello from mock!");
  });

  it("generateText surfaces grounding sources from native search", async () => {
    const prompt = "smoke-test-generateText-grounding";

    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ) &&
        req.nativeModelToolIds?.length === 1 &&
        req.nativeModelToolIds[0] === GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
      {
        role: "assistant",
        content: "Searched the web.",
        id: "smoke-grounding",
        nativeModelToolResults: [{
          type: "cf-harness.native-model-tool-result",
          toolId: GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
          provider: "google",
          sources: [
            {
              url: "https://example.com/a",
              title: "A",
              snippet: "First source",
            },
            {
              url: "https://example.com/a",
              title: "Duplicate",
              snippet: "Duplicate source",
            },
            {
              title: "B",
              description: "Second source",
            },
          ],
        }],
      },
    );

    const testPattern = pattern(() => {
      return generateText({
        prompt,
        search: true,
        nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
      });
    });

    const resultCell = runtime.getCell(
      space,
      "smoke-generateText-grounding",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe("Searched the web.");
    expect(result.key("groundingSources").get()).toEqual([
      {
        url: "https://example.com/a",
        title: "A",
        snippet: "First source",
      },
      {
        title: "B",
        snippet: "Second source",
      },
    ]);
  });

  it("generateObject with typed schema returns structured object", async () => {
    const prompt = "smoke-test-generateObject-typed";
    const schema: JSONSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        score: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "score"],
    };

    addMockObjectResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        object: { title: "Test Item", score: 95, tags: ["fast", "reliable"] },
        id: "smoke-2",
      },
    );

    const testPattern = pattern(() => {
      return generateObject({ prompt, schema });
    });

    const resultCell = runtime.getCell(
      space,
      "smoke-generateObject-typed",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    const obj = result.key("result").get();
    expect(obj).toEqual({
      title: "Test Item",
      score: 95,
      tags: ["fast", "reliable"],
    });
  });

  it("preserves a closed schema and resolves nested references in the `generateObject` client request", async () => {
    const prompt = "smoke-test-generateObject-closed-schema";
    const entrySchema = {
      type: "object",
      additionalProperties: false,
      properties: { subject: { type: "string" } },
      required: ["subject"],
    } as const;
    const schema: JSONSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        messages: { type: "array", items: { $ref: "#/$defs/Mail" } },
      },
      required: ["messages"],
      $defs: { Mail: entrySchema },
    };
    const object = { messages: [{ subject: "Your weekly summary" }] };
    let observedSchema: unknown;

    addMockObjectResponse(
      (req) => {
        if (
          !req.messages.some((m) =>
            typeof m.content === "string" && m.content.includes(prompt)
          )
        ) return false;
        observedSchema = req.schema;
        return true;
      },
      { object, id: "smoke-closed-schema" },
    );

    const testPattern = pattern(() => generateObject({ prompt, schema }));
    const resultCell = runtime.getCell(
      space,
      "smoke-generateObject-closed-schema",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    await tx.commit();
    await waitForLlmSettled(runtime, result);

    expect(observedSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { messages: { type: "array", items: entrySchema } },
      required: ["messages"],
    });
    expect(result.key("result").get()).toEqual(object);
  });

  it("generateObject with tools and presentResult", async () => {
    const prompt = "smoke-test-generateObject-tools";
    const schema: JSONSchema = {
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
    };

    // Step 1: LLM calls a user tool
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ) &&
        req.tools?.["lookup"] !== undefined &&
        req.tools?.["presentResult"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_lookup_1",
            toolName: "lookup",
            input: {},
          },
        ],
        id: "smoke-tools-step1",
      },
    );

    // Step 2: After tool result, call presentResult
    addMockResponse(
      (req) =>
        req.messages.some((m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolCallId === "call_lookup_1"
          )
        ),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_presentResult_1",
            toolName: "presentResult",
            input: { answer: "Found the answer via tool" },
          },
        ],
        id: "smoke-tools-step2",
      },
    );

    const testPattern = pattern(() => {
      return generateObject({
        prompt,
        schema,
        tools: {
          lookup: {
            description: "Look up information",
            pattern: dummyPattern,
          },
        },
      });
    });

    const resultCell = runtime.getCell(
      space,
      "smoke-generateObject-tools",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toEqual({
      answer: "Found the answer via tool",
    });
  });

  it("generateText with context data appears in request", async () => {
    const prompt = "smoke-test-with-context";
    const contextData = "The user's name is Alice and they like cats.";

    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ) &&
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(contextData)
        ),
      {
        role: "assistant",
        content: "I see Alice likes cats!",
        id: "smoke-context",
      },
    );

    const testPattern = pattern(() => {
      const messages: BuiltInLLMMessage[] = [
        { role: "user", content: `Context: ${contextData}` },
        { role: "user", content: prompt },
      ];
      return generateText({ messages });
    });

    const resultCell = runtime.getCell(
      space,
      "smoke-generateText-context",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForLlmSettled(runtime, result);

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe("I see Alice likes cats!");
  });
});
