import {
  isUnavailable,
  UNAVAILABLE_SYNCING,
} from "@commonfabric/data-model/availability";

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type {
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
  BuiltInLLMParams,
  BuiltInLLMTool,
} from "@commonfabric/api";

import { Identity } from "@commonfabric/identity";
import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  enableMockMode,
  LLMClient,
} from "@commonfabric/llm/client";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { generateObject, generateText, llm } from "../src/builtins/llm.ts";
import { llmDialogTestHelpers } from "../src/builtins/llm-dialog.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "llm availability race coverage test",
);
const space = signer.did();

enableMockMode();

type GenerationHarness<P> = {
  action: Action;
  cause: readonly unknown[];
  inputsCell: Cell<P>;
  parentCell: Cell<unknown>;
  readonly state: Cell<any>;
};

describe("LLM availability race coverage", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let nextId = 0;

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
  });

  afterEach(async () => {
    await runtime?.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function makeHarness<P>(
    params: P,
    factory: (
      inputsCell: Cell<P>,
      sendResult: (
        tx: IExtendedStorageTransaction,
        result: Cell<any>,
      ) => void,
      cause: readonly unknown[],
      parentCell: Cell<unknown>,
      runtime: Runtime,
    ) => Action,
  ): Promise<GenerationHarness<P>> {
    const id = nextId++;
    const setupTx = runtime.edit();
    const parentCell = runtime.getCell<unknown>(
      space,
      `llm-availability-parent-${id}`,
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<P>(
      space,
      `llm-availability-inputs-${id}`,
      undefined,
      setupTx,
    );
    inputsCell.set(params);
    await setupTx.commit().settled;

    const cause = ["llm-availability", id] as const;
    let state: Cell<any> | undefined;
    const action = factory(
      inputsCell,
      (_tx, result) => state = result,
      cause,
      parentCell,
      runtime,
    );
    return {
      action,
      cause,
      inputsCell,
      parentCell,
      get state() {
        if (!state) throw new Error("Generation state was not initialized");
        return state;
      },
    };
  }

  function objectFactory(
    inputsCell: Cell<BuiltInGenerateObjectParams>,
    sendResult: (
      tx: IExtendedStorageTransaction,
      result: Cell<any>,
    ) => void,
    cause: readonly unknown[],
    parentCell: Cell<unknown>,
    runtime: Runtime,
  ) {
    return generateObject(
      inputsCell,
      sendResult,
      () => {},
      cause,
      parentCell,
      runtime,
    );
  }

  function llmFactory(
    inputsCell: Cell<BuiltInLLMParams>,
    sendResult: (
      tx: IExtendedStorageTransaction,
      result: Cell<any>,
    ) => void,
    cause: readonly unknown[],
    parentCell: Cell<unknown>,
    runtime: Runtime,
  ) {
    return llm(
      inputsCell,
      sendResult,
      () => {},
      cause,
      parentCell,
      runtime,
    );
  }

  function textFactory(
    inputsCell: Cell<BuiltInGenerateTextParams>,
    sendResult: (
      tx: IExtendedStorageTransaction,
      result: Cell<any>,
    ) => void,
    cause: readonly unknown[],
    parentCell: Cell<unknown>,
    runtime: Runtime,
  ) {
    return generateText(
      inputsCell,
      sendResult,
      () => {},
      cause,
      parentCell,
      runtime,
    );
  }

  function rehydrateObject(
    generation: GenerationHarness<BuiltInGenerateObjectParams>,
  ): GenerationHarness<BuiltInGenerateObjectParams> {
    let state: Cell<any> | undefined;
    const action = objectFactory(
      generation.inputsCell,
      (_tx, result) => state = result,
      generation.cause,
      generation.parentCell,
      runtime,
    );
    return {
      ...generation,
      action,
      get state() {
        if (!state) throw new Error("Rehydrated state was not initialized");
        return state;
      },
    };
  }

  async function commitAction(action: Action): Promise<void> {
    const tx = runtime.edit();
    action(tx);
    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
  }

  function replaceAndRun<P>(
    generation: GenerationHarness<P>,
    tx: IExtendedStorageTransaction,
    params: P,
  ): void {
    generation.inputsCell.withTx(tx).set(params);
    generation.action(tx);
  }

  function rawResult(state: Cell<any>): unknown {
    return state.key("result").resolveAsCell().getRaw();
  }

  function schema() {
    return {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    } as const;
  }

  function dummyTools(): Record<string, BuiltInLLMTool> {
    const { commonfabric } = createTrustedBuilder(runtime);
    const dummy = commonfabric.pattern(() => ({}), { type: "object" });
    return {
      dummy: {
        description: "Unused test tool",
        pattern: dummy,
      },
    } as unknown as Record<string, BuiltInLLMTool>;
  }

  function addPresentResultResponse(prompt: string, title: string): void {
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === prompt) &&
        request.tools?.presentResult !== undefined,
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: `present-${title}`,
          toolName: "presentResult",
          input: { title },
        }],
        id: `response-${title}`,
      },
    );
  }

  it("publishes invalid input when structured inputs are incomplete", async () => {
    const generation = await makeHarness<BuiltInGenerateObjectParams>(
      { prompt: "missing-schema" },
      objectFactory,
    );
    const tx = runtime.edit();
    generation.action(tx);

    expect(
      generation.state.key("result").withTx(tx).resolveAsCell().getRaw(),
    ).toMatchObject({ reason: "error", errorKind: "invalidInput" });
    expect(generation.state.key("requestHash").withTx(tx).get())
      .toBeUndefined();
    await tx.commit().settled;
  });

  it("classifies syncing, absent, and usable child tool results", () => {
    expect(
      llmDialogTestHelpers.classifyToolResult(
        UNAVAILABLE_SYNCING,
        undefined,
      ),
    ).toEqual({ status: "wait" });
    expect(
      llmDialogTestHelpers.classifyToolResult(undefined, undefined),
    ).toEqual({ status: "wait" });
    expect(
      llmDialogTestHelpers.classifyToolResult("raw", { answer: 42 }),
    ).toEqual({ status: "value", value: { answer: 42 } });
  });

  it("writes a typed structured result while CFC is disabled", async () => {
    const prompt = "disabled-cfc-typed-result";
    addMockObjectResponse(
      (request) =>
        request.messages.some((message) => message.content === prompt),
      { object: { title: "usable" }, id: "disabled-cfc-result" },
    );
    const generation = await makeHarness<BuiltInGenerateObjectParams>(
      {
        prompt,
        schema: schema(),
        schemaSanitizePromptInjection: true,
      },
      objectFactory,
    );

    await commitAction(generation.action);
    await waitForCellValue(
      runtime,
      generation.state,
      () =>
        (rawResult(generation.state) as { title?: unknown })?.title ===
          "usable",
    );
    expect(rawResult(generation.state)).toEqual({ title: "usable" });
  });

  it("upgrades a legacy tools-path generation error without retrying", async () => {
    const prompt = "legacy-tools-result";
    addPresentResultResponse(prompt, "seed");
    const generation = await makeHarness<BuiltInGenerateObjectParams>(
      { prompt, schema: schema(), tools: dummyTools() },
      objectFactory,
    );
    const originalSendRequest = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      calls++;
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      await commitAction(generation.action);
      await waitForCellValue(
        runtime,
        generation.state,
        () =>
          (rawResult(generation.state) as { title?: unknown })?.title ===
            "seed",
      );
      expect(calls).toBe(1);

      const legacyTx = runtime.edit();
      generation.state.key("result").withTx(legacyTx).setRawUntyped(undefined);
      generation.state.key("error").withTx(legacyTx).set(
        "persisted tools failure",
      );
      generation.state.key("pending").withTx(legacyTx).set(false);
      await legacyTx.commit().settled;

      const rehydrated = rehydrateObject(generation);
      const reconcileTx = runtime.edit();
      rehydrated.action(reconcileTx);
      const marker = rehydrated.state.key("result").withTx(reconcileTx)
        .resolveAsCell().getRaw();
      expect(isUnavailable(marker)).toBe(true);
      expect(marker.reason).toBe("error");
      if (marker.reason === "error") {
        expect(marker.errorMessage).toBe("persisted tools failure");
      }
      expect(rehydrated.state.key("pending").withTx(reconcileTx).get()).toBe(
        false,
      );
      await reconcileTx.commit().settled;
      expect(calls).toBe(1);
    } finally {
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("retains the legacy undefined llm result alongside a provider error", async () => {
    const generation = await makeHarness<BuiltInLLMParams>(
      { messages: [{ role: "user", content: "unmatched-llm-error" }] },
      llmFactory,
    );

    await commitAction(generation.action);
    await waitForCellValue(
      runtime,
      generation.state,
      () => (generation.state.key("pending").get() as unknown) === false,
    );

    expect(rawResult(generation.state)).toBeUndefined();
    expect(generation.state.key("error").get()).toContain(
      "no matching mock response",
    );
  });

  it("abandons an llm error when a newer request arrives during idle", async () => {
    const firstPrompt = "stale-llm-error";
    const secondPrompt = "fresh-after-llm-error";
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === secondPrompt),
      { role: "assistant", content: "fresh reply", id: "fresh-error-reply" },
    );
    const generation = await makeHarness<BuiltInLLMParams>(
      { messages: [{ role: "user", content: firstPrompt }] },
      llmFactory,
    );
    const originalSendRequest = LLMClient.prototype.sendRequest;
    const originalIdle = runtime.idle.bind(runtime);
    const idleEntered = Promise.withResolvers<void>();
    const releaseIdle = Promise.withResolvers<void>();
    let shouldBlockIdle = false;
    let blockedIdle = false;

    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      const request = args[0] as { messages: readonly { content?: unknown }[] };
      if (request.messages.some((message) => message.content === firstPrompt)) {
        shouldBlockIdle = true;
        throw new Error("stale provider failure");
      }
      return await originalSendRequest.apply(this, args as never);
    };
    runtime.idle = (() => {
      if (shouldBlockIdle && !blockedIdle) {
        blockedIdle = true;
        idleEntered.resolve();
        return releaseIdle.promise;
      }
      return originalIdle();
    }) as typeof runtime.idle;

    try {
      await commitAction(generation.action);
      await idleEntered.promise;

      const nextTx = runtime.edit();
      replaceAndRun(generation, nextTx, {
        messages: [{ role: "user", content: secondPrompt }],
      });
      await nextTx.commit().settled;
      releaseIdle.resolve();
      runtime.idle = originalIdle;

      await waitForCellValue(
        runtime,
        generation.state,
        () => rawResult(generation.state) === "fresh reply",
      );
      expect(generation.state.key("error").get()).toBeUndefined();
    } finally {
      releaseIdle.resolve();
      runtime.idle = originalIdle;
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("revalidates an llm completion inside the write transaction", async () => {
    const firstPrompt = "llm-write-cas-old";
    const secondPrompt = "llm-write-cas-new";
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === firstPrompt),
      { role: "assistant", content: "stale reply", id: "llm-cas-old" },
    );
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === secondPrompt),
      { role: "assistant", content: "fresh reply", id: "llm-cas-new" },
    );
    const generation = await makeHarness<BuiltInLLMParams>(
      { messages: [{ role: "user", content: firstPrompt }] },
      llmFactory,
    );
    const originalSendRequest = LLMClient.prototype.sendRequest;
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let interceptWrite = false;

    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      const response = await originalSendRequest.apply(this, args as never);
      const request = args[0] as { messages: readonly { content?: unknown }[] };
      if (request.messages.some((message) => message.content === firstPrompt)) {
        interceptWrite = true;
      }
      return response;
    };
    runtime.editWithRetry = ((
      fn: (tx: IExtendedStorageTransaction) => unknown,
      maxRetries?: number,
    ) => {
      if (!interceptWrite) return originalEditWithRetry(fn, maxRetries);
      interceptWrite = false;
      return originalEditWithRetry((tx) => {
        replaceAndRun(generation, tx, {
          messages: [{ role: "user", content: secondPrompt }],
        });
        return fn(tx);
      }, maxRetries);
    }) as typeof runtime.editWithRetry;

    try {
      await commitAction(generation.action);
      await waitForCellValue(
        runtime,
        generation.state,
        () => rawResult(generation.state) === "fresh reply",
      );
      expect(rawResult(generation.state)).toBe("fresh reply");
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("abandons a text completion when superseded during idle", async () => {
    const firstPrompt = "text-idle-old";
    const secondPrompt = "text-idle-new";
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === firstPrompt),
      { role: "assistant", content: "stale text", id: "text-idle-old" },
    );
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === secondPrompt),
      { role: "assistant", content: "fresh text", id: "text-idle-new" },
    );
    const generation = await makeHarness<BuiltInGenerateTextParams>(
      { prompt: firstPrompt },
      textFactory,
    );
    const originalSendRequest = LLMClient.prototype.sendRequest;
    const originalIdle = runtime.idle.bind(runtime);
    const idleEntered = Promise.withResolvers<void>();
    const releaseIdle = Promise.withResolvers<void>();
    let firstReturned = false;
    let blockedIdle = false;

    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      const response = await originalSendRequest.apply(this, args as never);
      const request = args[0] as { messages: readonly { content?: unknown }[] };
      if (request.messages.some((message) => message.content === firstPrompt)) {
        firstReturned = true;
      }
      return response;
    };
    runtime.idle = (() => {
      if (firstReturned && !blockedIdle) {
        blockedIdle = true;
        idleEntered.resolve();
        return releaseIdle.promise;
      }
      return originalIdle();
    }) as typeof runtime.idle;

    try {
      await commitAction(generation.action);
      await idleEntered.promise;
      const nextTx = runtime.edit();
      replaceAndRun(generation, nextTx, { prompt: secondPrompt });
      await nextTx.commit().settled;
      releaseIdle.resolve();
      runtime.idle = originalIdle;

      await waitForCellValue(
        runtime,
        generation.state,
        () => rawResult(generation.state) === "fresh text",
      );
    } finally {
      releaseIdle.resolve();
      runtime.idle = originalIdle;
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("abandons a direct object completion when superseded during idle", async () => {
    const firstPrompt = "object-idle-old";
    const secondPrompt = "object-idle-new";
    addMockObjectResponse(
      (request) =>
        request.messages.some((message) => message.content === firstPrompt),
      { object: { title: "stale" }, id: "object-idle-old" },
    );
    addMockObjectResponse(
      (request) =>
        request.messages.some((message) => message.content === secondPrompt),
      { object: { title: "fresh" }, id: "object-idle-new" },
    );
    const generation = await makeHarness<BuiltInGenerateObjectParams>(
      { prompt: firstPrompt, schema: schema() },
      objectFactory,
    );
    const originalGenerateObject = LLMClient.prototype.generateObject;
    const originalIdle = runtime.idle.bind(runtime);
    const idleEntered = Promise.withResolvers<void>();
    const releaseIdle = Promise.withResolvers<void>();
    let firstReturned = false;
    let blockedIdle = false;

    LLMClient.prototype.generateObject = async function (...args: unknown[]) {
      const response = await originalGenerateObject.apply(this, args as never);
      const request = args[0] as { messages: readonly { content?: unknown }[] };
      if (request.messages.some((message) => message.content === firstPrompt)) {
        firstReturned = true;
      }
      return response;
    };
    runtime.idle = (() => {
      if (firstReturned && !blockedIdle) {
        blockedIdle = true;
        idleEntered.resolve();
        return releaseIdle.promise;
      }
      return originalIdle();
    }) as typeof runtime.idle;

    try {
      await commitAction(generation.action);
      await idleEntered.promise;
      const nextTx = runtime.edit();
      replaceAndRun(generation, nextTx, {
        prompt: secondPrompt,
        schema: schema(),
      });
      await nextTx.commit().settled;
      releaseIdle.resolve();
      runtime.idle = originalIdle;

      await waitForCellValue(
        runtime,
        generation.state,
        () =>
          (rawResult(generation.state) as { title?: unknown })?.title ===
            "fresh",
      );
    } finally {
      releaseIdle.resolve();
      runtime.idle = originalIdle;
      LLMClient.prototype.generateObject = originalGenerateObject;
    }
  });

  it("revalidates a direct object completion inside the write transaction", async () => {
    const firstPrompt = "object-write-cas-old";
    const secondPrompt = "object-write-cas-new";
    addMockObjectResponse(
      (request) =>
        request.messages.some((message) => message.content === firstPrompt),
      { object: { title: "stale" }, id: "object-cas-old" },
    );
    addMockObjectResponse(
      (request) =>
        request.messages.some((message) => message.content === secondPrompt),
      { object: { title: "fresh" }, id: "object-cas-new" },
    );
    const generation = await makeHarness<BuiltInGenerateObjectParams>(
      { prompt: firstPrompt, schema: schema() },
      objectFactory,
    );
    const originalGenerateObject = LLMClient.prototype.generateObject;
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let interceptWrite = false;

    LLMClient.prototype.generateObject = async function (...args: unknown[]) {
      const response = await originalGenerateObject.apply(this, args as never);
      const request = args[0] as { messages: readonly { content?: unknown }[] };
      if (request.messages.some((message) => message.content === firstPrompt)) {
        interceptWrite = true;
      }
      return response;
    };
    runtime.editWithRetry = ((
      fn: (tx: IExtendedStorageTransaction) => unknown,
      maxRetries?: number,
    ) => {
      if (!interceptWrite) return originalEditWithRetry(fn, maxRetries);
      interceptWrite = false;
      return originalEditWithRetry((tx) => {
        replaceAndRun(generation, tx, {
          prompt: secondPrompt,
          schema: schema(),
        });
        return fn(tx);
      }, maxRetries);
    }) as typeof runtime.editWithRetry;

    try {
      await commitAction(generation.action);
      await waitForCellValue(
        runtime,
        generation.state,
        () =>
          (rawResult(generation.state) as { title?: unknown })?.title ===
            "fresh",
      );
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
      LLMClient.prototype.generateObject = originalGenerateObject;
    }
  });

  it("publishes queued tools results in queue order", async () => {
    const firstPrompt = "tools-queued-old";
    const secondPrompt = "tools-queued-new";
    const queue = "llm-availability-tools-queue";
    runtime.configureQueue(queue, { maxConcurrency: 1 });
    const tools = dummyTools();
    addPresentResultResponse(firstPrompt, "stale");
    addPresentResultResponse(secondPrompt, "fresh");
    const generation = await makeHarness<BuiltInGenerateObjectParams>(
      { prompt: firstPrompt, schema: schema(), tools, queue },
      objectFactory,
    );
    const originalSendRequest = LLMClient.prototype.sendRequest;
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();

    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      const request = args[0] as { messages: readonly { content?: unknown }[] };
      if (request.messages.some((message) => message.content === firstPrompt)) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      await commitAction(generation.action);
      await firstStarted.promise;
      const nextTx = runtime.edit();
      replaceAndRun(generation, nextTx, {
        prompt: secondPrompt,
        schema: schema(),
        tools,
        queue,
      });
      await nextTx.commit().settled;
      releaseFirst.resolve();

      await waitForCellValue(
        runtime,
        generation.state,
        () =>
          (rawResult(generation.state) as { title?: unknown })?.title ===
            "fresh",
      );
    } finally {
      releaseFirst.resolve();
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("drops a tools result superseded during writeback idle", async () => {
    const firstPrompt = "tools-idle-old";
    const secondPrompt = "tools-idle-new";
    const tools = dummyTools();
    addPresentResultResponse(firstPrompt, "stale");
    addPresentResultResponse(secondPrompt, "fresh");
    const generation = await makeHarness<BuiltInGenerateObjectParams>(
      { prompt: firstPrompt, schema: schema(), tools },
      objectFactory,
    );
    const originalSendRequest = LLMClient.prototype.sendRequest;
    const originalIdle = runtime.idle.bind(runtime);
    const idleEntered = Promise.withResolvers<void>();
    const releaseIdle = Promise.withResolvers<void>();
    let firstReturned = false;
    let blockedIdle = false;

    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      const response = await originalSendRequest.apply(this, args as never);
      const request = args[0] as { messages: readonly { content?: unknown }[] };
      if (request.messages.some((message) => message.content === firstPrompt)) {
        firstReturned = true;
      }
      return response;
    };
    runtime.idle = (() => {
      if (firstReturned && !blockedIdle) {
        blockedIdle = true;
        idleEntered.resolve();
        return releaseIdle.promise;
      }
      return originalIdle();
    }) as typeof runtime.idle;

    try {
      await commitAction(generation.action);
      await idleEntered.promise;
      const nextTx = runtime.edit();
      replaceAndRun(generation, nextTx, {
        prompt: secondPrompt,
        schema: schema(),
        tools,
      });
      await nextTx.commit().settled;
      releaseIdle.resolve();
      runtime.idle = originalIdle;

      await waitForCellValue(
        runtime,
        generation.state,
        () =>
          (rawResult(generation.state) as { title?: unknown })?.title ===
            "fresh",
      );
    } finally {
      releaseIdle.resolve();
      runtime.idle = originalIdle;
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("revalidates a tools result inside the write transaction", async () => {
    const firstPrompt = "tools-write-cas-old";
    const secondPrompt = "tools-write-cas-new";
    const tools = dummyTools();
    addPresentResultResponse(firstPrompt, "stale");
    addPresentResultResponse(secondPrompt, "fresh");
    const generation = await makeHarness<BuiltInGenerateObjectParams>(
      { prompt: firstPrompt, schema: schema(), tools },
      objectFactory,
    );
    const originalSendRequest = LLMClient.prototype.sendRequest;
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let interceptWrite = false;

    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      const response = await originalSendRequest.apply(this, args as never);
      const request = args[0] as { messages: readonly { content?: unknown }[] };
      if (request.messages.some((message) => message.content === firstPrompt)) {
        interceptWrite = true;
      }
      return response;
    };
    runtime.editWithRetry = ((
      fn: (tx: IExtendedStorageTransaction) => unknown,
      maxRetries?: number,
    ) => {
      if (!interceptWrite) return originalEditWithRetry(fn, maxRetries);
      interceptWrite = false;
      return originalEditWithRetry((tx) => {
        replaceAndRun(generation, tx, {
          prompt: secondPrompt,
          schema: schema(),
          tools,
        });
        return fn(tx);
      }, maxRetries);
    }) as typeof runtime.editWithRetry;

    try {
      await commitAction(generation.action);
      await waitForCellValue(
        runtime,
        generation.state,
        () =>
          (rawResult(generation.state) as { title?: unknown })?.title ===
            "fresh",
      );
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("revalidates a batched partial write inside the transaction", async () => {
    const firstPrompt = "partial-write-cas-old";
    const secondPrompt = "partial-write-cas-new";
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === firstPrompt),
      { role: "assistant", content: "stale final", id: "partial-cas-old" },
    );
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === secondPrompt),
      { role: "assistant", content: "fresh final", id: "partial-cas-new" },
    );
    const generation = await makeHarness<BuiltInGenerateTextParams>(
      { prompt: firstPrompt },
      textFactory,
    );
    const originalSendRequest = LLMClient.prototype.sendRequest;
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const releaseFirst = Promise.withResolvers<void>();
    const partialWriteCommitted = Promise.withResolvers<void>();
    let interceptPartialWrite = false;

    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      const request = args[0] as { messages: readonly { content?: unknown }[] };
      if (request.messages.some((message) => message.content === firstPrompt)) {
        const updatePartial = args[1] as (text: string) => void;
        updatePartial("stale partial");
        interceptPartialWrite = true;
        await releaseFirst.promise;
      }
      return await originalSendRequest.apply(this, args as never);
    };
    runtime.editWithRetry = ((
      fn: (tx: IExtendedStorageTransaction) => unknown,
      maxRetries?: number,
    ) => {
      if (!interceptPartialWrite) {
        return originalEditWithRetry(fn, maxRetries);
      }
      interceptPartialWrite = false;
      const write = originalEditWithRetry((tx) => {
        replaceAndRun(generation, tx, { prompt: secondPrompt });
        return fn(tx);
      }, maxRetries);
      write.then(() => partialWriteCommitted.resolve());
      return write;
    }) as typeof runtime.editWithRetry;

    try {
      await commitAction(generation.action);
      await partialWriteCommitted.promise;
      releaseFirst.resolve();

      await waitForCellValue(
        runtime,
        generation.state,
        () => rawResult(generation.state) === "fresh final",
      );
      expect(generation.state.key("partial").get()).not.toBe("stale partial");
    } finally {
      releaseFirst.resolve();
      runtime.editWithRetry = originalEditWithRetry;
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });
});
