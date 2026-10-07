import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type {
  BuiltInGenerateTextParams,
  BuiltInLLMParams,
} from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { LLMClient } from "@commonfabric/llm";
import {
  addMockResponse,
  clearMockResponses,
  enableMockMode,
} from "@commonfabric/llm/client";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import { createBuilder } from "../src/builder/factory.ts";
import { generateTextState } from "../src/builder/built-in.ts";
import {
  generateText as rawGenerateText,
  llm as rawLlm,
} from "../src/builtins/llm.ts";
import { createCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { waitForLlmSettled } from "./support/llm-result.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test generate-text outbox");
const space = signer.did();

enableMockMode();

describe("generateText outbox mechanism", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let generateText: typeof generateTextState;

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
    generateText = generateTextState;
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("enqueues generateText work behind the post-commit outbox", async () => {
    const prompt = "generate text outbox";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        role: "assistant",
        content: "gated response",
        id: "mock-generate-text-outbox",
      },
    );

    const testPattern = pattern(() => {
      return generateText({ prompt });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-outbox-test",
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
      tx.commit();

      expect(sendRequestCalls).toEqual([]);

      await waitForLlmSettled(runtime, result);

      expect(outboxEffects.length).toBeGreaterThan(0);
      expect(outboxEffects[0].kind).toBe("generateText-start");
      expect(sendRequestCalls.length).toBeGreaterThan(0);
      expect(result.key("result").get()).toBe("gated response");
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("retries generateText work after a rejected post-commit transaction", async () => {
    const prompt = "generate text rejected outbox retry";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        role: "assistant",
        content: "retry response",
        id: "mock-generate-text-retry-outbox",
      },
    );

    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      "generateText-retry-parent",
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<BuiltInGenerateTextParams>(
      space,
      "generateText-retry-inputs",
      undefined,
      setupTx,
    );
    inputsCell.set({ prompt });
    const setupResult = await setupTx.commit().settled;
    expect(setupResult.ok).toBeDefined();

    let resultCell: any;
    const action = rawGenerateText(
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
      action(rejectedTx);
      // Advancing the inputs document after the action has read it makes the
      // staged transaction's commit fail, which is the rejection the outbox
      // has to survive.
      const conflictTx = runtime.edit();
      inputsCell.withTx(conflictTx).set({ prompt, maxTokens: 128 });
      expect((await conflictTx.commit().settled).ok).toBeDefined();
      const rejectedResult = await rejectedTx.commit().settled;
      expect(rejectedResult.error?.name).toBe("StorageTransactionInconsistent");
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

  it("retries llm work after a rejected post-commit transaction", async () => {
    const prompt = "legacy llm rejected outbox retry";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        role: "assistant",
        content: "legacy retry response",
        id: "mock-llm-retry-outbox",
      },
    );

    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      "llm-retry-parent",
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<BuiltInLLMParams>(
      space,
      "llm-retry-inputs",
      undefined,
      setupTx,
    );
    inputsCell.set({
      messages: [{ role: "user", content: prompt }],
    });
    const setupResult = await setupTx.commit().settled;
    expect(setupResult.ok).toBeDefined();

    let resultCell: any;
    const action = rawLlm(
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
      action(rejectedTx);
      // Advancing the inputs document after the action has read it makes the
      // staged transaction's commit fail, which is the rejection the outbox
      // has to survive.
      const conflictTx = runtime.edit();
      inputsCell.withTx(conflictTx).set({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 128,
      });
      expect((await conflictTx.commit().settled).ok).toBeDefined();
      const rejectedResult = await rejectedTx.commit().settled;
      expect(rejectedResult.error?.name).toBe("StorageTransactionInconsistent");
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

  it("starts generateText again when identical inputs move to a narrower scope", async () => {
    const prompt = "generate text same prompt narrower scope";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        role: "assistant",
        content: "scoped response",
        id: "mock-generate-text-scope-change",
      },
    );
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        role: "assistant",
        content: "scoped response again",
        id: "mock-generate-text-scope-change-again",
      },
    );

    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      "generateText-scope-change-parent",
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<BuiltInGenerateTextParams>(
      space,
      "generateText-scope-change-inputs",
      undefined,
      setupTx,
    );
    inputsCell.set({ prompt });
    const setupResult = await setupTx.commit().settled;
    expect(setupResult.ok).toBeDefined();

    let resultCell: any;
    const action = rawGenerateText(
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
    const secondSendRequest = defer<void>();
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      sendRequestCalls.push(Date.now());
      if (sendRequestCalls.length === 1) firstSendRequest.resolve();
      if (sendRequestCalls.length === 2) secondSendRequest.resolve();
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      const firstTx = runtime.edit();
      action(firstTx);
      const firstResult = await firstTx.commit().settled;
      expect(firstResult.ok).toBeDefined();
      await firstSendRequest.promise;
      await waitForLlmSettled(runtime, resultCell);

      const linkTx = runtime.edit();
      const userPromptBase = runtime.getCell<string>(
        space,
        "generateText-scope-change-user-prompt",
        undefined,
        linkTx,
      );
      const userPrompt = createCell<string>(
        runtime,
        { ...userPromptBase.getAsNormalizedFullLink(), scope: "user" },
        linkTx,
      );
      userPrompt.set(prompt);
      inputsCell.withTx(linkTx).key("prompt").set(userPrompt);
      const linkResult = await linkTx.commit().settled;
      expect(linkResult.ok).toBeDefined();

      const secondTx = runtime.edit();
      action(secondTx);
      const secondResult = await secondTx.commit().settled;
      expect(secondResult.ok).toBeDefined();
      await secondSendRequest.promise;
      await waitForLlmSettled(runtime, resultCell);

      expect(sendRequestCalls.length).toBe(2);
    } finally {
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });
});
