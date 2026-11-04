/**
 * The dialog's error paths substitute an assistant message when a turn cannot
 * produce a real reply. None of them had end-to-end coverage, so nothing pinned
 * either the message reaching `messages` or its landing in a document of its
 * own -- the latter being what the LlmDerived stamping downstream depends on,
 * and what keeps the array from mixing bare values with links.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { BuiltInLLMMessage } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  clearMockResponses,
  LLMClient,
  loadConversationFixture,
} from "@commonfabric/llm/client";

import { type JSONSchema } from "../src/builder/types.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { waitForLlmMessages } from "./support/llm-result.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("llm dialog error messages");

describe("llmDialog error-path messages", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    clearMockResponses();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("appends an assistant error message, in its own document", async () => {
    // Empty content fails `hasValidContent()`, which is what selects the
    // branch under test.
    loadConversationFixture({
      description: "invalid content: empty assistant reply",
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "", id: "empty-1" },
        },
      ],
    });

    const tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, llmDialog, Cell } = commonfabric;

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      signer.did(),
      "llm-invalid-content",
      resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    await tx.commit().settled;
    await runtime.idle();

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "Hello" });

    // The user message plus the substituted error message.
    await waitForLlmMessages(runtime, result, 2);

    const messagesCell = result.key("messages");
    const rtx = runtime.edit();
    const messages = messagesCell.withTx(rtx).get() as
      | readonly BuiltInLLMMessage[]
      | undefined;

    expect(messages?.length).toBe(2);
    const errorMessage = messages![1]!;
    expect(errorMessage.role).toBe("assistant");
    expect(String(errorMessage.content)).toContain(
      "I encountered an error generating a response",
    );

    // Its own document: the stored element is a link, which is exactly what
    // the LlmDerived stamping requires of every pushed message.
    for (const index of [0, 1]) {
      const raw = messagesCell.withTx(rtx).key(index).getRaw();
      const link = parseLink(raw);
      expect(link).not.toBe(undefined);
      expect(link?.id).not.toBe(undefined);
    }

    await rtx.commit().settled;
  });

  it("stores a failed-request error message in its own document", async () => {
    // The `.catch` path substitutes a message when the request itself rejects.
    // It is reached by no other test, and it pushes on its own rather than
    // through the shared model-message path, so it is exactly where an
    // inconsistently stored element can hide.
    const original = LLMClient.prototype.sendRequest;
    LLMClient.prototype.sendRequest = () =>
      Promise.reject(new Error("upstream exploded"));

    try {
      const tx = runtime.edit();
      const { commonfabric } = createTrustedBuilder(runtime);
      const { pattern, llmDialog, Cell } = commonfabric;

      const resultSchema = {
        type: "object",
        properties: {
          addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
          pending: { type: "boolean" },
          messages: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
        },
        required: ["addMessage"],
      } as const satisfies JSONSchema;

      const testPattern = pattern(
        () => {
          const messages = Cell.of<BuiltInLLMMessage[]>([]);
          const dialog = llmDialog({ messages });
          return {
            addMessage: dialog.addMessage,
            pending: dialog.pending,
            messages,
          };
        },
        false,
        resultSchema,
      );

      const resultCell = runtime.getCell(
        signer.did(),
        "llm-request-failure",
        resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      await tx.commit().settled;
      await runtime.idle();

      const addMessage = await result.key("addMessage").pull();
      addMessage.send({ role: "user", content: "Hello" });

      await waitForLlmMessages(runtime, result, 2);

      const messagesCell = result.key("messages");
      const rtx = runtime.edit();
      const messages = messagesCell.withTx(rtx).get() as
        | readonly BuiltInLLMMessage[]
        | undefined;

      expect(messages?.length).toBe(2);
      expect(String(messages![1]!.content)).toContain("upstream exploded");

      // Every element is a link. `Cell.push` assigns identity to objects in
      // arrays, so this holds whether or not the caller chose the cause --
      // which is what keeps the stamping from skipping elements.
      for (const index of [0, 1]) {
        const raw = messagesCell.withTx(rtx).key(index).getRaw();
        expect(parseLink(raw)?.id).not.toBe(undefined);
      }

      await rtx.commit().settled;
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });
});
