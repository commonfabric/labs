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
import type { BuiltInLLMMessage, JSONSchema } from "@commonfabric/api";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";
import { waitForLlmMessages } from "./support/llm-result.ts";

const signer = await Identity.fromPassphrase("test llm-dialog outbox");
const space = signer.did();

enableMockMode();

describe("llmDialog outbox mechanism", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createBuilder>["commonfabric"]["Cell"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
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
    ({ pattern, llmDialog, Cell } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("enqueues llmDialog work behind the post-commit outbox", async () => {
    const prompt = "hello outbox";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        role: "assistant",
        content: "hi there",
        id: "mock-llm-dialog-outbox",
      },
    );

    const resultSchema = {
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
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-outbox-test",
      resultSchema,
      tx,
    );

    const txPrototype = ExtendedStorageTransaction.prototype;
    const wrapperPrototype = TransactionWrapper.prototype;
    const originalTxEnqueue = txPrototype.enqueuePostCommitEffect;
    const originalWrapperEnqueue = wrapperPrototype.enqueuePostCommitEffect;
    const originalSendRequest = LLMClient.prototype.sendRequest;
    const outboxEffects: Array<{ id: string; kind: string }> = [];
    const sendRequestCalls: number[] = [];

    txPrototype.enqueuePostCommitEffect = function (...args) {
      outboxEffects.push(args[0] as { id: string; kind: string });
      return originalTxEnqueue.apply(this, args as never);
    };
    wrapperPrototype.enqueuePostCommitEffect = function (...args) {
      outboxEffects.push(args[0] as { id: string; kind: string });
      return originalWrapperEnqueue.apply(this, args as never);
    };
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      sendRequestCalls.push(Date.now());
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const addMessage = await result.key("addMessage").pull();
      addMessage.send({ role: "user", content: prompt });

      await waitForLlmMessages(runtime, result, 2);

      expect(outboxEffects.length).toBeGreaterThan(0);
      expect(outboxEffects[0].kind).toBe("llmDialog-start");
      expect(sendRequestCalls.length).toBeGreaterThan(0);
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });
});
