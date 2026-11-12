/**
 * One of the three request-and-response LLM builtins (`llm`, `generateText`,
 * `generateObject`) driven through its action by hand over emulated storage,
 * with every model response held until the test releases it.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { LLMClient, type LLMResponse } from "@commonfabric/llm";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";

import { generateObject, generateText, llm } from "../../src/builtins/llm.ts";
import type { Cell } from "../../src/cell.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveSettlementOf,
} from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

/** Output fields shared by the three LLM builtins. */
export type LLMBuiltinResult = {
  /** Whether the model response remains pending. */
  pending: boolean;

  /** Completed model output. */
  result?: unknown;

  /** Model output streamed so far. */
  partial?: string;

  /** Terminal model or dispatch failure. */
  error?: string;

  /** Selected or completed request. */
  requestHash?: string;
};

/** The operator every fixture's storage acts as. */
export const llmFixtureIdentity = await Identity.fromPassphrase(
  "llm lifecycle unit",
);

const builtins = { llm, generateText, generateObject };

/** The name of one of the builtins the fixture drives. */
export type LLMBuiltinName = keyof typeof builtins;

/** The names of the builtins the fixture drives. */
export const llmBuiltinNames = Object.keys(builtins) as LLMBuiltinName[];

/**
 * Builds a real transaction fixture with a model response held by the test.
 * `sendRequest` and the direct `generateObject` call each record a request
 * whose response the test resolves; `generateObject` answers
 * `{ answer: <content> }`.
 */
export async function llmBuiltinFixture(
  name: LLMBuiltinName,
  served = true,
  bindingScope: "space" | "user" = "space",
  writeParent = true,
) {
  const identity = llmFixtureIdentity;
  const storage = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: { serverExecution: served },
    servingPosture: served,
    cfcFlowLabels: "off",
  });
  const input = runtime.getCell<any>(
    identity.did(),
    "lifecycle-input",
  );
  const parent = runtime.getCell(
    identity.did(),
    "lifecycle-parent",
    undefined,
    undefined,
    bindingScope,
  );
  const announcements: Array<ScopeKeyIdentity | undefined> = [];
  let output: Cell<LLMBuiltinResult>;
  const instanceMaps = new Set<Map<unknown, unknown>>();
  const mapSet = Map.prototype.set;
  const send = LLMClient.prototype.sendRequest;
  const object = LLMClient.prototype.generateObject;
  try {
    await input.sync();
    Map.prototype.set = function (key, value) {
      if (
        value && typeof value === "object" &&
        Object.hasOwn(value, "currentRun") &&
        Object.hasOwn(value, "lastRequestQueued")
      ) {
        instanceMaps.add(this);
      }
      return mapSet.call(this, key, value);
    };
    const { action } = builtins[name](
      input,
      (tx, result) => {
        announcements.push(tx.tx.scopeKeyIdentity);
        output = result;
        if (writeParent) {
          parent.withTx(tx).set({ announced: true, output: result });
        }
      },
      () => {},
      "lifecycle",
      parent,
      runtime,
      parent.key("output").getAsNormalizedFullLink(),
      undefined,
      parent.key("output").getAsNormalizedFullLink(),
    );
    const requests: Array<
      ReturnType<typeof Promise.withResolvers<LLMResponse>>
    > = [];
    /** The parameters each recorded request was sent with. */
    const params: unknown[] = [];
    /** The partial-text callback each `sendRequest` was handed. */
    const partials: Array<((text: string) => void) | undefined> = [];
    const works: Promise<unknown>[] = [];
    let changed = Promise.withResolvers<void>();
    LLMClient.prototype.sendRequest = (request, onPartial) => {
      const response = Promise.withResolvers<LLMResponse>();
      requests.push(response);
      params.push(request);
      partials.push(onPartial);
      changed.resolve();
      changed = Promise.withResolvers<void>();
      return response.promise;
    };
    LLMClient.prototype.generateObject = async (request) => {
      const response = Promise.withResolvers<LLMResponse>();
      requests.push(response);
      params.push(request);
      partials.push(undefined);
      changed.resolve();
      changed = Promise.withResolvers<void>();
      const result = await response.promise;
      return { object: { answer: result.content }, id: "response" };
    };
    runtime.asyncWorkObserver = (work) => works.push(work);

    /** Stages the builtin's request in the selected transaction. */
    const stage = (
      tx: IExtendedStorageTransaction,
      prompt: unknown,
      messages = false,
      queue?: string,
    ) => {
      input.withTx(tx).set(
        {
          ...(name === "llm"
            ? {
              messages: messages ? prompt : [{ role: "user", content: prompt }],
            }
            : name === "generateObject"
            ? { prompt, schema: { type: "object" } }
            : { prompt }),
          ...(queue ? { queue } : {}),
        },
      );
      action(tx);
    };

    /** Commits a request and waits for its post-commit dispatch boundary. */
    const run = async (
      prompt: unknown,
      as?: ScopeKeyIdentity,
      messages = false,
    ) => {
      const tx = runtime.edit();
      if (as) tx.tx.scopeKeyIdentity = as;
      stage(tx, prompt, messages);
      expect((await tx.commit().settled).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      await runtime.idle();
    };

    const wave = new WaveAccumulator({
      space: identity.did(),
      basisSeq: 0,
      scopeKeyIdentity: runtime.scopeKeyIdentity,
      replicaFor: (space) => storage.open(space).replica,
    });
    const deferred: Array<() => void> = [];
    const refusals: Array<() => void> = [];

    return {
      runtime,
      input,
      action,
      requests,
      params,
      partials,
      announcements,
      works,
      run,
      async clear() {
        const tx = runtime.edit();
        input.withTx(tx).set(
          name === "llm"
            ? { messages: [] }
            : { prompt: "", schema: { type: "object" } },
        );
        action(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await tx.postCommitEffectsSettled();
        await runtime.idle();
      },
      stage,
      parent,
      wave,
      deferred,
      refusals,
      async issued(count: number) {
        while (requests.length < count) await changed.promise;
      },
      get instanceCount() {
        return [...instanceMaps].reduce((sum, map) => sum + map.size, 0);
      },
      get bindingCount() {
        return [...instanceMaps].flatMap((map) => [...map.values()]).reduce(
          (sum: number, state) =>
            sum + (state as { staging: Map<unknown, unknown> }).staging.size,
          0,
        );
      },
      get output() {
        return output;
      },
      async seal(prompt: unknown) {
        runtime.installSealDestination({
          seal: (tx) => wave.seal(tx),
          deferSealedEffects: (tx, effects) => {
            for (const effect of effects) {
              deferred.push(() => effect.flush(tx));
              refusals.push(() =>
                effect.abandon?.({
                  name: "StorageTransactionAborted",
                  message: "Withdrawn request refused",
                  reason: "Withdrawn request refused",
                })
              );
            }
            return true;
          },
        });
        const tx = runtime.edit();
        stampWaveRunContext(tx, { actionId: "held-llm", kind: "derivation" });
        stage(tx, prompt);
        expect((await tx.commit().settled).error).toBeUndefined();
        runtime.clearSealDestination();
        expect(waveSettlementOf(tx)).toBeDefined();
        return { settlement: waveSettlementOf(tx)! };
      },
      release(text = "A-result") {
        requests.at(-1)!.resolve({
          role: "assistant",
          content: text,
          id: "response",
        });
      },
      async close() {
        runtime.clearSealDestination();
        wave.abandon("Fixture complete");
        await wave.settled();
        for (const request of requests) {
          request.resolve({
            role: "assistant",
            content: "cleanup",
            id: "cleanup",
          });
        }
        try {
          await runtime.settled();
          await runtime.dispose().catch(async (error) => {
            await storage.close();
            throw error;
          });
        } finally {
          Map.prototype.set = mapSet;
          LLMClient.prototype.sendRequest = send;
          LLMClient.prototype.generateObject = object;
        }
      },
    };
  } catch (error) {
    Map.prototype.set = mapSet;
    LLMClient.prototype.sendRequest = send;
    LLMClient.prototype.generateObject = object;
    await runtime.dispose().catch(async (error) => {
      await storage.close();
      throw error;
    });
    throw error;
  }
}

/** A fixture built by {@link llmBuiltinFixture}. */
export type LLMBuiltinFixture = Awaited<ReturnType<typeof llmBuiltinFixture>>;
