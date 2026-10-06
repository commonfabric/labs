import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { BuiltInGenerateObjectParams } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { LLMClient } from "@commonfabric/llm";
import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  enableMockMode,
} from "@commonfabric/llm/client";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import { createBuilder } from "../src/builder/factory.ts";
import { generateObjectState } from "../src/builder/built-in.ts";
import { generateObject as rawGenerateObject } from "../src/builtins/llm.ts";
import { Runtime } from "../src/runtime.ts";
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { refuseAtCommitBoundary } from "./refused-commit.ts";
import { waitForLlmSettled } from "./support/llm-result.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test generate-object outbox");
const space = signer.did();

enableMockMode();

describe("generateObject outbox mechanism", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let dummyPattern: any;
  let generateObject: typeof generateObjectState;

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern } = commonfabric);
    generateObject = generateObjectState;
    dummyPattern = pattern(() => ({}), { type: "object" });
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("enqueues generateObject work behind the post-commit outbox", async () => {
    const prompt = "generate object outbox";
    addMockObjectResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        object: {
          title: "gated title",
          description: "gated description",
        },
        id: "mock-generate-object-outbox",
      },
    );

    const testPattern = pattern(() => {
      return generateObject({
        prompt,
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
          },
          required: ["title"],
        },
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateObject-outbox-test",
      testPattern.resultSchema,
      tx,
    );

    const txPrototype = ExtendedStorageTransaction.prototype;
    const wrapperPrototype = TransactionWrapper.prototype;
    const originalTxEnqueue = txPrototype.enqueuePostCommitEffect;
    const originalWrapperEnqueue = wrapperPrototype.enqueuePostCommitEffect;
    const originalGenerateObject = LLMClient.prototype.generateObject;
    const outboxEffects: Array<{ id: string; kind: string }> = [];
    const generateObjectCalls: number[] = [];

    txPrototype.enqueuePostCommitEffect = function (...args) {
      outboxEffects.push(args[0] as { id: string; kind: string });
      return originalTxEnqueue.apply(this, args as never);
    };
    wrapperPrototype.enqueuePostCommitEffect = function (...args) {
      outboxEffects.push(args[0] as { id: string; kind: string });
      return originalWrapperEnqueue.apply(this, args as never);
    };
    LLMClient.prototype.generateObject = async function (...args: unknown[]) {
      generateObjectCalls.push(Date.now());
      return await originalGenerateObject.apply(this, args as never);
    };

    try {
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      expect(generateObjectCalls).toEqual([]);

      await waitForLlmSettled(runtime, result);

      expect(outboxEffects.length).toBeGreaterThan(0);
      expect(outboxEffects[0].kind).toBe("generateObject-start");
      expect(generateObjectCalls.length).toBeGreaterThan(0);
      expect(result.key("result").get()).toEqual({
        title: "gated title",
        description: "gated description",
      });
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
      LLMClient.prototype.generateObject = originalGenerateObject;
    }
  });

  it("enqueues generateObject tool-calling work behind the post-commit outbox", async () => {
    const prompt = "generate object tool outbox";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ) && req.tools?.["presentResult"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_presentResult_tool_outbox",
            toolName: "presentResult",
            input: {
              title: "tool gated title",
              description: "tool gated description",
            },
          },
        ],
        id: "mock-presentResult-tool-outbox",
      },
    );

    const testPattern = pattern(() => {
      return generateObject({
        prompt,
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
          },
          required: ["title"],
        },
        tools: {
          dummy: {
            description: "A dummy tool to force tool-calling path",
            pattern: dummyPattern,
          },
        },
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateObject-tool-outbox-test",
      testPattern.resultSchema,
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
      expect(sendRequestCalls).toEqual([]);

      tx.commit();

      expect(sendRequestCalls).toEqual([]);

      await waitForLlmSettled(runtime, result);

      expect(outboxEffects.length).toBeGreaterThan(0);
      expect(outboxEffects[0].kind).toBe("generateObject-start");
      expect(sendRequestCalls.length).toBeGreaterThan(0);
      expect(result.key("result").get()).toEqual({
        title: "tool gated title",
        description: "tool gated description",
      });
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("retries generateObject work after a rejected post-commit transaction", async () => {
    const prompt = "generate object rejected outbox retry";
    addMockObjectResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        object: {
          title: "retry title",
          description: "retry description",
        },
        id: "mock-generate-object-retry-outbox",
      },
    );

    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      "generateObject-retry-parent",
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<BuiltInGenerateObjectParams>(
      space,
      "generateObject-retry-inputs",
      undefined,
      setupTx,
    );
    inputsCell.set({
      prompt,
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["title"],
      },
    });
    const setupResult = await setupTx.commit().settled;
    expect(setupResult.ok).toBeDefined();

    let resultCell: any;
    const action = rawGenerateObject(
      inputsCell,
      (_resultTx, result) => {
        resultCell = result;
      },
      () => {},
      [],
      parentCell,
      runtime,
    );

    const originalGenerateObject = LLMClient.prototype.generateObject;
    const generateObjectCalls: number[] = [];
    const firstGenerateObject = defer<void>();
    LLMClient.prototype.generateObject = async function (...args: unknown[]) {
      generateObjectCalls.push(Date.now());
      if (generateObjectCalls.length === 1) firstGenerateObject.resolve();
      return await originalGenerateObject.apply(this, args as never);
    };

    try {
      const rejectedTx = runtime.edit();
      refuseAtCommitBoundary(
        rejectedTx,
        space,
        "generateObject retry regression",
      );
      action(rejectedTx);
      const rejectedResult = await rejectedTx.commit().settled;
      expect(isCfcEnforcementRejection(rejectedResult.error)).toBe(true);
      await runtime.idle();
      expect(generateObjectCalls).toEqual([]);

      const retryTx = runtime.edit();
      action(retryTx);
      const retryResult = await retryTx.commit().settled;
      expect(retryResult.ok).toBeDefined();
      await firstGenerateObject.promise;
      await waitForLlmSettled(runtime, resultCell);

      expect(generateObjectCalls.length).toBe(1);
    } finally {
      LLMClient.prototype.generateObject = originalGenerateObject;
    }
  });

  it("retries generateObject tool work after a rejected post-commit transaction", async () => {
    const prompt = "generate object tool rejected outbox retry";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ) && req.tools?.["presentResult"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_presentResult_tool_retry_outbox",
            toolName: "presentResult",
            input: {
              title: "tool retry title",
              description: "tool retry description",
            },
          },
        ],
        id: "mock-presentResult-tool-retry-outbox",
      },
    );

    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      "generateObject-tool-retry-parent",
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<BuiltInGenerateObjectParams>(
      space,
      "generateObject-tool-retry-inputs",
      undefined,
      setupTx,
    );
    inputsCell.set({
      prompt,
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["title"],
      },
      tools: {
        dummy: {
          description: "A dummy tool to force tool-calling path",
          pattern: dummyPattern,
        },
      },
    });
    const setupResult = await setupTx.commit().settled;
    expect(setupResult.ok).toBeDefined();

    let resultCell: any;
    const action = rawGenerateObject(
      inputsCell,
      (_resultTx, result) => {
        resultCell = result;
      },
      () => {},
      [],
      parentCell,
      runtime,
    );

    const originalSendRequest = LLMClient.prototype.sendRequest;
    const sendRequestCalls: number[] = [];
    const firstSendRequest = defer<void>();
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      sendRequestCalls.push(Date.now());
      if (sendRequestCalls.length === 1) firstSendRequest.resolve();
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      const rejectedTx = runtime.edit();
      refuseAtCommitBoundary(
        rejectedTx,
        space,
        "generateObject tool retry regression",
      );
      action(rejectedTx);
      const rejectedResult = await rejectedTx.commit().settled;
      expect(isCfcEnforcementRejection(rejectedResult.error)).toBe(true);
      await runtime.idle();
      expect(sendRequestCalls).toEqual([]);

      const retryTx = runtime.edit();
      action(retryTx);
      const retryResult = await retryTx.commit().settled;
      expect(retryResult.ok).toBeDefined();
      await firstSendRequest.promise;
      await waitForLlmSettled(runtime, resultCell);

      expect(sendRequestCalls.length).toBe(1);
    } finally {
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });
});
