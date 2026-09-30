/**
 * Channel 6 (builtin progress) coarsening: the LLM partial-streaming batch
 * window is one second (>=1s), so an untrusted pattern cannot watch the partial
 * cell for a sub-second token-arrival cadence. See
 * docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { LLMClient, type LLMResponse } from "@commonfabric/llm";
import {
  clearMockResponses,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm/client";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PARTIAL_BATCH_MS } from "../src/builtins/llm.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type LlmResultState,
  waitForLlmSettled,
} from "./support/llm-result.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("llm partial batch");
const space = signer.did();

describe("LLM partial batch coarsening (channel 6)", () => {
  it("batches partial writes at >=1s so the cadence is <=1 Hz", () => {
    expect(PARTIAL_BATCH_MS).toBeGreaterThanOrEqual(1000);
  });

  it("writes a streamed partial to the cell once one batch window has elapsed", async () => {
    // The request streams one partial and stays open for the rest of the
    // test, so the only way the text reaches the cell is the batch window.
    // The claim is the window: the clock advances through it once the loop
    // is idle, and the wait is on the cell.
    enableMockMode();
    clearMockResponses();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const original = LLMClient.prototype.sendRequest;
    const response = Promise.withResolvers<LLMResponse>();
    LLMClient.prototype.sendRequest = (_request, partial) => {
      partial?.("hel");
      return response.promise;
    };
    try {
      const tx = runtime.edit();
      const { commonfabric: builder } = createTrustedBuilder(runtime);
      const testPattern = builder.pattern(() =>
        builder.llm({ messages: [{ role: "user", content: "stream" }] })
      );
      const resultCell = runtime.getCell(
        space,
        "llm-partial-batch",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      // A plain sink, not a quiescent read: the request is open, and the
      // scheduler is not idle while it is.
      const started = Date.now();
      const streamed = Promise.withResolvers<LlmResultState>();
      const stop = result.sink((value: LlmResultState) => {
        if (value?.partial === "hel") streamed.resolve(value);
      });
      try {
        expect((await streamed.promise).pending).toBe(true);
      } finally {
        stop();
      }
      expect(Date.now() - started).toBeGreaterThanOrEqual(PARTIAL_BATCH_MS);
    } finally {
      response.resolve({
        id: "partial-batch",
        role: "assistant",
        content: "hello",
      });
      LLMClient.prototype.sendRequest = original;
      resetMockMode();
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });

  it("reads the serving-posture flags in the partial batch window", async () => {
    // The batch body checks `servingPosture && serverExecution` before it
    // writes. With serving posture on and server execution OFF the check is
    // false, so the write still happens — the same as the plain path. The
    // request dispatches plainly (server execution is what routes it to the
    // served outbox), so this stays deterministic on the fake clock.
    enableMockMode();
    clearMockResponses();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
    });
    const original = LLMClient.prototype.sendRequest;
    const response = Promise.withResolvers<LLMResponse>();
    LLMClient.prototype.sendRequest = (_request, partial) => {
      partial?.("hel");
      return response.promise;
    };
    try {
      const tx = runtime.edit();
      const { commonfabric: builder } = createTrustedBuilder(runtime);
      const testPattern = builder.pattern(() =>
        builder.llm({ messages: [{ role: "user", content: "posture" }] })
      );
      const resultCell = runtime.getCell(
        space,
        "llm-partial-posture",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const streamed = Promise.withResolvers<LlmResultState>();
      const stop = result.sink((value: LlmResultState) => {
        if (value?.partial === "hel") streamed.resolve(value);
      });
      try {
        expect((await streamed.promise).pending).toBe(true);
      } finally {
        stop();
      }
    } finally {
      response.resolve({ id: "posture", role: "assistant", content: "hi" });
      LLMClient.prototype.sendRequest = original;
      resetMockMode();
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });

  for (const afterBatchWindow of [false, true]) {
    it(
      afterBatchWindow
        ? "drops a superseded partial while its batch waits for idle"
        : "drops a partial the batch window would write for a superseded run",
      async () => {
        // The batch body checks the run it belongs to against the current run. A
        // newer request supersedes the first before its window elapses or while
        // its batch waits for idle. The request messages come from a cell, so
        // changing them re-runs the node; both requests are held open.
        enableMockMode();
        clearMockResponses();
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        const original = LLMClient.prototype.sendRequest;
        const held: Array<() => void> = [];
        const partials: Array<(text: string) => void> = [];
        LLMClient.prototype.sendRequest = (request, partial) => {
          const response = Promise.withResolvers<LLMResponse>();
          held.push(() =>
            response.resolve({
              id: "superseded",
              role: "assistant",
              content: String(request.messages[0]?.content ?? ""),
            })
          );
          if (partial) partials.push(partial);
          return response.promise;
        };
        try {
          const tx = runtime.edit();
          const { commonfabric: builder } = createTrustedBuilder(runtime);
          type Msg = { role: "user" | "assistant" | "tool"; content: string };
          const messages = runtime.getCell<Msg[]>(
            space,
            "llm-superseded-messages",
            undefined,
            tx,
          );
          messages.set([{ role: "user", content: "first" }]);
          const testPattern = builder.pattern<{ messages: Msg[] }>(
            ({ messages }) => builder.llm({ messages }),
          );
          const resultCell = runtime.getCell(
            space,
            "llm-superseded",
            testPattern.resultSchema,
            tx,
          );
          const result = runtime.run(tx, testPattern, { messages }, resultCell);
          tx.commit();
          // A sink is the demand that runs the node and dispatches its request.
          const observedPartials: Array<string | undefined> = [];
          const stop = result.sink((value: LlmResultState) => {
            observedPartials.push(value?.partial);
          });
          const releaseIdle = Promise.withResolvers<void>();
          try {
            await clock.settle();

            const enteredIdle = Promise.withResolvers<void>();
            const originalIdle = runtime.idle.bind(runtime);
            let holdNextIdle = true;
            using _idle = afterBatchWindow
              ? stub(runtime, "idle", (...args) => {
                if (!holdNextIdle) return originalIdle(...args);
                holdNextIdle = false;
                enteredIdle.resolve();
                return releaseIdle.promise;
              })
              : undefined;

            expect(partials.length).toBe(1);
            partials[0]("stale");
            if (afterBatchWindow) {
              await clock.tick(PARTIAL_BATCH_MS);
              await enteredIdle.promise;
            }
            const bump = runtime.edit();
            messages.withTx(bump).set([{ role: "user", content: "second" }]);
            await bump.commit();
            await clock.settle();
            expect(partials.length).toBe(2);

            releaseIdle.resolve();
            if (!afterBatchWindow) await clock.tick(PARTIAL_BATCH_MS);
            await clock.settle();
            expect(observedPartials).not.toContain("stale");
            expect((result.get() as LlmResultState)?.partial).not.toBe("stale");

            partials[1]("fresh");
            await clock.tick(PARTIAL_BATCH_MS);
            await clock.settle();
            expect(observedPartials).toContain("fresh");
            expect((result.get() as LlmResultState)?.partial).toBe("fresh");
          } finally {
            releaseIdle.resolve();
            stop();
          }
        } finally {
          for (const release of held) release();
          LLMClient.prototype.sendRequest = original;
          resetMockMode();
          await runtime.dispose({ closeStorage: false });
          await storageManager.close();
        }
      },
    );
  }

  it("writes the response of a request whose batched partial has landed", async () => {
    // The batch window's commit re-runs this node: the run that issued the
    // request read `partial` in resetting it, so the partial it writes is a
    // change to something it read. That re-run finds the request in flight
    // and issues nothing, and the request it found stays the current one, so
    // the response lands as the result once it arrives.
    enableMockMode();
    clearMockResponses();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const original = LLMClient.prototype.sendRequest;
    const response = Promise.withResolvers<LLMResponse>();
    LLMClient.prototype.sendRequest = (_request, partial) => {
      partial?.("hel");
      return response.promise;
    };
    try {
      const tx = runtime.edit();
      const { commonfabric: builder } = createTrustedBuilder(runtime);
      const testPattern = builder.pattern(() =>
        builder.llm({ messages: [{ role: "user", content: "settle" }] })
      );
      const resultCell = runtime.getCell(
        space,
        "llm-partial-settles",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const streamed = Promise.withResolvers<LlmResultState>();
      const stop = result.sink((value: LlmResultState) => {
        if (value?.partial === "hel") streamed.resolve(value);
      });
      try {
        expect((await streamed.promise).pending).toBe(true);
        response.resolve({ id: "settle", role: "assistant", content: "hello" });
        const settled = await waitForLlmSettled(runtime, result);
        expect(settled.result).toBe("hello");
        expect(settled.partial).toBe("hello");
      } finally {
        stop();
      }
    } finally {
      LLMClient.prototype.sendRequest = original;
      resetMockMode();
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });
});
