import {
  UNAVAILABLE_PENDING,
  unavailableError,
  unavailableMismatch,
} from "@commonfabric/data-model/availability";
/**
 * Alignment tests verifying that runtime JSON schemas correctly materialize
 * values matching the TypeScript types defined in packages/api/index.ts.
 *
 * These tests guard against the schemas in llm-schemas.ts drifting from
 * the TS source-of-truth types (BuiltInLLMMessage, BuiltInGenerateTextParams,
 * BuiltInGenerateObjectParams, etc.).
 *
 * If you modify llm-schemas.ts or the TS types in packages/api/index.ts,
 * run this file to confirm alignment:
 *   deno test --allow-all packages/runner/test/llm-schema-alignment.test.ts
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type {
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
  BuiltInLLMMessage,
} from "@commonfabric/api";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  GenerateObjectParamsSchema,
  GenerateObjectResultSchema,
  GenerateTextParamsSchema,
  GenerateTextResultSchema,
  LLMContentSchema,
  LLMMessageSchema,
  LLMResultSchema,
} from "../src/builtins/llm-schemas.ts";

const signer = await Identity.fromPassphrase("schema-alignment-test");
const space = signer.did();

/**
 * `BuiltInLLMMessage`'s roles written out as values. The `satisfies` clause
 * refuses a role listed here that the type does not carry, and
 * `EveryRoleIsListed` below refuses one the type carries that is missing here.
 */
const MESSAGE_ROLES = [
  "user",
  "assistant",
  "tool",
] as const satisfies readonly BuiltInLLMMessage["role"][];

/** Its argument is `never` only while `MESSAGE_ROLES` names every role. */
type AssertNever<T extends never> = T;

type EveryRoleIsListed = AssertNever<
  Exclude<BuiltInLLMMessage["role"], typeof MESSAGE_ROLES[number]>
>;

/** Helper: create a cell with data, apply schema, read it back. */
function materialize<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  label: string,
  data: unknown,
  schema: any,
): T {
  const cell = runtime.getCell(space, label, undefined, tx);
  cell.set(data);
  const typed = cell.asSchema(schema);
  return typed.withTx(tx).get() as T;
}

describe("LLM schema alignment", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let testIndex = 0;

  function label() {
    return `schema-align-${testIndex++}`;
  }

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("LLMMessageSchema", () => {
    it("materializes a message with string content", () => {
      const msg: BuiltInLLMMessage = { role: "user", content: "hello" };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        msg,
        LLMMessageSchema,
      );
      expect(value.role).toBe("user");
      expect(value.content).toBe("hello");
    });

    it("materializes a message with text content part", () => {
      const msg: BuiltInLLMMessage = {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        msg,
        LLMMessageSchema,
      );
      expect(value.role).toBe("user");
      expect(Array.isArray(value.content)).toBe(true);
      expect(value.content[0].type).toBe("text");
      expect(value.content[0].text).toBe("hello");
    });

    it("materializes a message with image content part", () => {
      const msg: BuiltInLLMMessage = {
        role: "user",
        content: [{ type: "image", image: "data:image/png;base64,abc123" }],
      };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        msg,
        LLMMessageSchema,
      );
      expect(value.content[0].type).toBe("image");
      expect(value.content[0].image).toBe("data:image/png;base64,abc123");
    });

    it("materializes a message with tool-call content part", () => {
      const msg: BuiltInLLMMessage = {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "myTool",
          input: { key: "value" },
        }],
      };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        msg,
        LLMMessageSchema,
      );
      expect(value.content[0].type).toBe("tool-call");
      expect(value.content[0].toolCallId).toBe("call_1");
      expect(value.content[0].toolName).toBe("myTool");
      expect(value.content[0].input).toEqual({ key: "value" });
    });

    it("materializes a message with tool-result content part", () => {
      const msg: BuiltInLLMMessage = {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "myTool",
          output: { type: "text", value: "result text" },
        }],
      };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        msg,
        LLMMessageSchema,
      );
      expect(value.content[0].type).toBe("tool-result");
      expect(value.content[0].toolCallId).toBe("call_1");
      expect(value.content[0].output).toEqual({
        type: "text",
        value: "result text",
      });
    });

    it("materializes every role value", () => {
      for (const role of MESSAGE_ROLES) {
        const msg: BuiltInLLMMessage = { role, content: "test" };
        const value = materialize<any>(
          runtime,
          tx,
          label(),
          msg,
          LLMMessageSchema,
        );
        expect(value.role).toBe(role);
      }
    });

    it("declares the roles `BuiltInLLMMessage` carries and no others", () => {
      // `MESSAGE_ROLES` is held to the type's own role union by the compiler,
      // so the two cannot drift apart; the comparison then holds the schema to
      // that same list. `system` is absent from all three: a system
      // instruction travels in the request's `system` field, which
      // `llmRequestProblem()` in `packages/llm/src/types.ts` enforces and the
      // model-provider SDK requires.
      expect(LLMMessageSchema?.properties?.role).toEqual({
        type: "string",
        enum: MESSAGE_ROLES,
      });
    });
  });

  describe("LLMContentSchema", () => {
    it("materializes string content", () => {
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        "just text",
        LLMContentSchema,
      );
      expect(value).toBe("just text");
    });

    it("materializes mixed content parts array", () => {
      const content = [
        { type: "image" as const, image: "data:image/png;base64,abc" },
        { type: "text" as const, text: "describe this" },
      ];
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        content,
        LLMContentSchema,
      );
      expect(Array.isArray(value)).toBe(true);
      expect(value.length).toBe(2);
      expect(value[0].type).toBe("image");
      expect(value[0].image).toBe("data:image/png;base64,abc");
      expect(value[1].type).toBe("text");
      expect(value[1].text).toBe("describe this");
    });
  });

  describe("GenerateTextParamsSchema", () => {
    it("materializes prompt-as-string params", () => {
      const params: BuiltInGenerateTextParams = { prompt: "Say hello" };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        params,
        GenerateTextParamsSchema,
      );
      expect(value.prompt).toBe("Say hello");
    });

    it("materializes prompt-as-content-parts params", () => {
      const params: BuiltInGenerateTextParams = {
        prompt: [
          { type: "image", image: "data:image/png;base64,abc" },
          { type: "text", text: "what is this?" },
        ],
      };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        params,
        GenerateTextParamsSchema,
      );
      const prompt = value.prompt;
      expect(Array.isArray(prompt)).toBe(true);
      expect(prompt[0].type).toBe("image");
      expect(prompt[1].type).toBe("text");
    });

    it("materializes messages variant params", () => {
      const params: BuiltInGenerateTextParams = {
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        params,
        GenerateTextParamsSchema,
      );
      expect(Array.isArray(value.messages)).toBe(true);
      expect(value.messages[0].role).toBe("user");
    });

    it("preserves a multimodal prompt through schema application", () => {
      const params: BuiltInGenerateTextParams = {
        prompt: [
          { type: "image", image: "data:image/png;base64,longbase64data" },
          { type: "text", text: "Describe this image" },
        ],
      };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        params,
        GenerateTextParamsSchema,
      );
      const prompt = value.prompt;
      expect(Array.isArray(prompt)).toBe(true);
      expect(prompt.length).toBe(2);
      expect(prompt[0].type).toBe("image");
      expect(prompt[0].image).toBe("data:image/png;base64,longbase64data");
      expect(prompt[1].type).toBe("text");
      expect(prompt[1].text).toBe("Describe this image");
    });
  });

  describe("GenerateObjectParamsSchema", () => {
    it("materializes prompt-based params with schema", () => {
      const params: BuiltInGenerateObjectParams = {
        prompt: "Generate a person",
        schema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        params,
        GenerateObjectParamsSchema,
      );
      expect(value.prompt).toBe("Generate a person");
      expect(value.schema).toBeTruthy();
    });

    it("materializes messages-based params with schema", () => {
      const params: BuiltInGenerateObjectParams = {
        messages: [{ role: "user", content: "Generate a person" }],
        schema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        params,
        GenerateObjectParamsSchema,
      );
      expect(Array.isArray(value.messages)).toBe(true);
    });

    it("preserves a multimodal prompt in `generateObject` through schema application", () => {
      const params: BuiltInGenerateObjectParams = {
        prompt: [
          { type: "image", image: "data:image/png;base64,abc" },
          { type: "text", text: "Extract data from this image" },
        ],
        schema: {
          type: "object",
          properties: { data: { type: "string" } },
        },
      };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        params,
        GenerateObjectParamsSchema,
      );
      const prompt = value.prompt;
      expect(Array.isArray(prompt)).toBe(true);
      expect(prompt.length).toBe(2);
      expect(prompt[0].type).toBe("image");
      expect(prompt[1].type).toBe("text");
    });
  });

  describe("result schemas", () => {
    it("materializes generateText unavailable results", () => {
      const marker = UNAVAILABLE_PENDING;
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        { pending: true, result: marker },
        GenerateTextResultSchema,
      );

      expect(value.result).toBe(marker);
    });

    it("materializes generateObject unavailable results", () => {
      const marker = unavailableMismatch();
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        { pending: false, result: marker },
        GenerateObjectResultSchema,
      );

      expect(value.result).toBe(marker);
    });

    it("materializes llm string errors", () => {
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        {
          pending: false,
          error: "model unavailable",
        },
        LLMResultSchema,
      );

      expect(value.error).toBe("model unavailable");
    });

    it("materializes generateText string errors", () => {
      const marker = unavailableError(new Error("rate limited"));
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        {
          pending: false,
          result: marker,
          error: "rate limited",
        },
        GenerateTextResultSchema,
      );

      expect(value.error).toBe("rate limited");
      expect(value.result).toBe(marker);
    });

    it("materializes generateObject string errors", () => {
      const marker = unavailableError(
        new Error("invalid structured output"),
      );
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        {
          pending: false,
          result: marker,
          error: "invalid structured output",
        },
        GenerateObjectResultSchema,
      );

      expect(value.error).toBe("invalid structured output");
      expect(value.result).toBe(marker);
    });

    it("materializes legacy generateText state without result", () => {
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        { pending: false, error: "legacy text failure" },
        GenerateTextResultSchema,
      );

      expect(value.error).toBe("legacy text failure");
      expect(value.result).toBeUndefined();
    });

    it("materializes legacy generateObject state without result", () => {
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        { pending: false, error: "legacy object failure" },
        GenerateObjectResultSchema,
      );

      expect(value.error).toBe("legacy object failure");
      expect(value.result).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("empty content parts array materializes as empty array", () => {
      const msg: BuiltInLLMMessage = { role: "user", content: [] };
      const value = materialize<any>(
        runtime,
        tx,
        label(),
        msg,
        LLMMessageSchema,
      );
      expect(Array.isArray(value.content)).toBe(true);
      expect(value.content.length).toBe(0);
    });
  });
});
