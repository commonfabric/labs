/**
 * LLM builtin error-surfacing tests.
 *
 * The smoke and outbox suites cover the success path — a request that returns a
 * response. These cover the other half: when the LLM call itself fails, the
 * builtin has to write the failure back to the result cell as `error`, clear
 * `pending`, and leave `result` undefined so a retry can run. The builtins
 * funnel every rejection through one `handleLLMError`, but each wires it up at
 * its own catch site (`llm`, `generateText`, the direct `generateObject` path,
 * and the tool-calling `generateObject` path), so each site needs a request
 * that rejects to exercise it.
 *
 * The failure is injected by replacing the client method the builtin awaits
 * with one that throws. The builtin cannot tell that apart from a real upstream
 * error — both surface as a rejected `sendRequest`/`generateObject` — so this
 * drives the same writeback a live API failure would.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  clearMockResponses,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm/client";
import { LLMClient } from "@commonfabric/llm";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { waitForLlmSettled } from "./support/llm-result.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("LLM builtin error surfacing", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let builder: ReturnType<typeof createTrustedBuilder>["commonfabric"];
  // deno-lint-ignore no-explicit-any
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
    ({ commonfabric: builder } = createTrustedBuilder(runtime));
    dummyPattern = builder.pattern(() => ({}), { type: "object" });
  });

  afterEach(async () => {
    resetMockMode();
    await tx.commit().settled;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("`llm` surfaces a failed request as `error`", async () => {
    const original = LLMClient.prototype.sendRequest;
    LLMClient.prototype.sendRequest = () =>
      Promise.reject(new Error("upstream llm failure"));
    try {
      const testPattern = builder.pattern(() =>
        builder.llm({ messages: [{ role: "user", content: "err-llm" }] })
      );
      const resultCell = runtime.getCell(
        space,
        "err-llm",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const settled = await waitForLlmSettled(runtime, result);

      expect(settled.pending).toBe(false);
      expect(settled.error).toBe("upstream llm failure");
      expect(result.key("result").get()).toBeUndefined();
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`generateText` surfaces a failed request as `error`", async () => {
    const original = LLMClient.prototype.sendRequest;
    LLMClient.prototype.sendRequest = () =>
      Promise.reject(new Error("upstream generateText failure"));
    try {
      const testPattern = builder.pattern(() =>
        builder.generateText({ prompt: "err-generateText" })
      );
      const resultCell = runtime.getCell(
        space,
        "err-generateText",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const settled = await waitForLlmSettled(runtime, result);

      expect(settled.pending).toBe(false);
      expect(settled.error).toBe("upstream generateText failure");
      expect(result.key("result").get()).toBeUndefined();
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`generateObject` (direct path) surfaces a failed request as `error`", async () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    const original = LLMClient.prototype.generateObject;
    LLMClient.prototype.generateObject = () =>
      Promise.reject(new Error("upstream generateObject failure"));
    try {
      const testPattern = builder.pattern(() =>
        builder.generateObject({ prompt: "err-generateObject", schema })
      );
      const resultCell = runtime.getCell(
        space,
        "err-generateObject-direct",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const settled = await waitForLlmSettled(runtime, result);

      expect(settled.pending).toBe(false);
      expect(settled.error).toBe("upstream generateObject failure");
      expect(result.key("result").get()).toBeUndefined();
    } finally {
      LLMClient.prototype.generateObject = original;
    }
  });

  it("`generateObject` (tool-calling path) surfaces a failed request as `error`", async () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    const original = LLMClient.prototype.sendRequest;
    LLMClient.prototype.sendRequest = () =>
      Promise.reject(new Error("upstream generateObject tools failure"));
    try {
      const testPattern = builder.pattern(() =>
        builder.generateObject({
          prompt: "err-generateObject-tools",
          schema,
          tools: {
            lookup: {
              description: "Look up information",
              pattern: dummyPattern,
            },
          },
        })
      );
      const resultCell = runtime.getCell(
        space,
        "err-generateObject-tools",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const settled = await waitForLlmSettled(runtime, result);

      expect(settled.pending).toBe(false);
      expect(settled.error).toBe("upstream generateObject tools failure");
      expect(result.key("result").get()).toBeUndefined();
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });
});
