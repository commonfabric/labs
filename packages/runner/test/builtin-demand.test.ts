import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { LLMClient } from "@commonfabric/llm";
import {
  addMockResponse,
  clearMockResponses,
  enableMockMode,
} from "@commonfabric/llm/client";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { waitForLlmSettled } from "./support/llm-result.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test builtin demand");
const space = signer.did();

enableMockMode();

describe("builtin demand", () => {
  // A network built-in is a computation: until something reads what it would
  // produce, the node is a no-op. Each case counts the requests the mocked
  // model client receives, which is the observable side of the node running.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: ReturnType<typeof createTrustedBuilder>["commonfabric"];
  let requests = 0;
  const originalSendRequest = LLMClient.prototype.sendRequest;

  beforeEach(() => {
    clearMockResponses();
    addMockResponse(() => true, {
      role: "assistant",
      content: "answered",
      id: "mock-builtin-demand",
    });
    requests = 0;
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      requests++;
      return await originalSendRequest.apply(this, args as never);
    };
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    ({ commonfabric } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    LLMClient.prototype.sendRequest = originalSendRequest;
    if (tx.status().status === "ready") await tx.commit();
    await runtime.settled();
    await runtime.dispose();
    await storageManager.close();
  });

  describe("generateText", () => {
    const start = () => {
      const { generateText, pattern } = commonfabric;
      const Text = pattern(() => generateText({ prompt: "a prompt" }));
      const resultCell = runtime.getCell(
        space,
        "builtin-demand-text",
        Text.resultSchema,
        tx,
      );
      return runtime.run(tx, Text, {}, resultCell);
    };

    it("issues no request while nothing reads its result", async () => {
      start();
      await tx.commit();
      await runtime.settled();
      expect(requests).toBe(0);
    });

    it("issues the request once a reader demands its result", async () => {
      const result = start();
      await tx.commit();
      await runtime.settled();
      const settled = await waitForLlmSettled<string>(runtime, result);
      expect(settled.result).toBe("answered");
      expect(requests).toBe(1);
    });
  });

  describe("a pattern a handler returns", () => {
    it("issues no request for a `generateText` nothing reads", async () => {
      const { generateText, handler, pattern } = commonfabric;
      const Text = pattern(() => generateText({ prompt: "a prompt" }));
      const ask = handler(
        { type: "object", properties: {} },
        { type: "object", properties: {} },
        () => Text({}),
      );
      const Root = pattern(() => ({ ask: ask({}) }));
      const rootCell = runtime.getCell<{ ask: unknown }>(
        space,
        "builtin-demand-handler",
        undefined,
        tx,
      );
      const root = runtime.run(tx, Root, {}, rootCell);
      await tx.commit();
      await root.pull();

      root.key("ask").send({});
      await runtime.settled();
      expect(requests).toBe(0);
    });
  });
});
