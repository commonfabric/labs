/** Exercises request acceptance, withdrawal, and refusal without model I/O. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

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
type Result = {
  /** Whether the model response remains pending. */
  pending: boolean;

  /** Completed model output. */
  result?: unknown;

  /** Terminal model or dispatch failure. */
  error?: string;

  /** Selected or completed request. */
  requestHash?: string;
};

const identity = await Identity.fromPassphrase("llm lifecycle unit");
const builtins = { llm, generateText, generateObject };

/** Builds a real transaction fixture with a model response held by the test. */
async function fixture(
  name: keyof typeof builtins,
  served = true,
  bindingScope: "space" | "user" = "space",
  writeParent = true,
) {
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
  let output: Cell<Result>;
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
    const action = builtins[name](
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
    const works: Promise<unknown>[] = [];
    let changed = Promise.withResolvers<void>();
    LLMClient.prototype.sendRequest = () => {
      const response = Promise.withResolvers<LLMResponse>();
      requests.push(response);
      changed.resolve();
      changed = Promise.withResolvers<void>();
      return response.promise;
    };
    LLMClient.prototype.generateObject = async () => {
      const response = Promise.withResolvers<LLMResponse>();
      requests.push(response);
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
      requests,
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

describe("llm-served-lifecycle", () => {
  for (const name of Object.keys(builtins) as Array<keyof typeof builtins>) {
    for (const completed of [false, true]) {
      it(`announces ${name} for an actor sharing another actor's ${completed ? "completed" : "pending"} result`, async () => {
        // The publication callback records its identity without storing two
        // user instances through this non-lease-holder storage fixture.
        const f = await fixture(name, true, "user", false);
        const tx = f.runtime.edit();
        try {
          const alice = { principal: identity.did(), sessionId: "alice" };
          const bob = {
            principal: (await Identity.fromPassphrase("lifecycle bob")).did(),
            sessionId: "bob",
          };
          tx.tx.scopeKeyIdentity = alice;
          f.stage(tx, "shared");
          await f.run("shared", bob);
          await f.issued(1);
          expect(f.bindingCount).toBe(1);
          if (completed) {
            f.release();
            await f.runtime.settled();
          }
          const refusal = {
            name: "StorageTransactionAborted",
            message: "Alice staging refused",
            reason: "Alice staging refused",
          } as const;
          tx.abort(refusal);
          tx.abandonStagedWork(refusal);
          await f.works.at(-1);
          expect(f.announcements).toHaveLength(3);
          expect(f.announcements.at(-1)).toEqual(alice);
          expect(f.output.key("pending").get()).toBe(!completed);
          expect(f.output.key("error").get()).toBeUndefined();
          f.release();
          await f.runtime.settled();
          expect(f.output.key("result").get()).toEqual(
            name === "generateObject" ? { answer: "A-result" } : "A-result",
          );
          expect(f.instanceCount).toBe(0);
        } finally {
          tx.abort();
          await f.close();
        }
      });
    }

    it(`preserves ${name} memoized output when another binding's duplicate is refused`, async () => {
      // The publication callback records its identity without storing two
      // user instances through this non-lease-holder storage fixture.
      const f = await fixture(name, true, "user", false);
      const tx = f.runtime.edit();
      try {
        const alice = { principal: identity.did(), sessionId: "alice" };
        const bob = {
          principal: (await Identity.fromPassphrase("lifecycle bob")).did(),
          sessionId: "bob",
        };
        await f.run("shared", bob);
        await f.issued(1);
        tx.tx.scopeKeyIdentity = alice;
        f.stage(tx, "shared");
        expect(f.bindingCount).toBe(1);
        f.release();
        await f.runtime.settled();
        await f.run("shared", bob);
        expect(f.requests).toHaveLength(1);
        const refusal = {
          name: "StorageTransactionAborted",
          message: "Alice staging refused",
          reason: "Alice staging refused",
        } as const;
        tx.abort(refusal);
        tx.abandonStagedWork(refusal);
        await f.works.at(-1);
        expect(f.announcements).toHaveLength(4);
        expect(f.announcements.at(-1)).toEqual(alice);
        expect(f.output.key("pending").get()).toBe(false);
        expect(f.output.key("error").get()).toBeUndefined();
        expect(f.output.key("result").get()).toEqual(
          name === "generateObject" ? { answer: "A-result" } : "A-result",
        );
        expect(f.instanceCount).toBe(0);
      } finally {
        tx.abort();
        await f.close();
      }
    });

    for (const served of [false, true]) {
      it(`preserves ${name} queue publication order with serving ${served ? "on" : "off"}`, async () => {
        const f = await fixture(name, served);
        f.runtime.configureQueue("ordered-llm-queue", { maxConcurrency: 1 });
        try {
          const first = f.runtime.edit();
          f.stage(first, "A", false, "ordered-llm-queue");
          expect((await first.commit().settled).error).toBeUndefined();
          await first.postCommitEffectsSettled();
          await f.issued(1);
          const firstWork = f.works.at(-1)!;
          const second = f.runtime.edit();
          f.stage(second, "B", false, "ordered-llm-queue");
          expect((await second.commit().settled).error).toBeUndefined();
          await second.postCommitEffectsSettled();
          f.requests[0].resolve({
            role: "assistant",
            content: "A-result",
            id: "A",
          });
          await firstWork;
          await f.issued(2);
          expect(f.output.key("result").get()).toEqual(
            name === "llm"
              ? undefined
              : name === "generateObject"
              ? { answer: "A-result" }
              : "A-result",
          );
          f.release("B-result");
          await f.runtime.settled();
          expect(f.output.key("result").get()).toEqual(
            name === "generateObject" ? { answer: "B-result" } : "B-result",
          );
        } finally {
          await f.close();
        }
      });

      it(`finishes queued ${name} after inputs are cleared with serving ${served ? "on" : "off"}`, async () => {
        const f = await fixture(name, served);
        const barrier = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        const queue = f.runtime.getOrCreateQueue("held-llm-queue", {
          maxConcurrency: 1,
        });
        const blocking = queue.enqueue(async () => {
          entered.resolve();
          await barrier.promise;
        });
        const tx = f.runtime.edit();
        try {
          await entered.promise;
          f.stage(tx, "A", false, "held-llm-queue");
          expect((await tx.commit().settled).error).toBeUndefined();
          await tx.postCommitEffectsSettled();
          await f.runtime.idle();
          expect(f.requests).toHaveLength(0);
          await f.clear();
          barrier.resolve();
          await blocking;
          await f.issued(1);
          f.release();
          await f.runtime.settled();
          expect(f.output.key("result").get()).toEqual(
            name === "generateObject" ? { answer: "A-result" } : "A-result",
          );
          expect(f.output.key("error").get()).toBeUndefined();
        } finally {
          barrier.resolve();
          await blocking;
          tx.abort();
          await f.close();
        }
      });
    }

    it(`retires ${name} state after each completed request`, async () => {
      const f = await fixture(name);
      try {
        for (let index = 0; index < 5; index++) {
          await f.run(`request-${index}`);
          await f.issued(index + 1);
          expect(f.instanceCount).toBe(1);
          f.release();
          await f.runtime.settled();
          expect(f.instanceCount).toBe(0);
        }
        expect(f.requests).toHaveLength(5);
      } finally {
        await f.close();
      }
    });

    it(`retains ${name} ownership while newer staging is uncommitted`, async () => {
      const f = await fixture(name);
      const tx = f.runtime.edit();
      try {
        await f.run("A");
        await f.issued(1);
        const firstWork = f.works.at(-1)!;
        f.stage(tx, "B");
        f.release();
        await firstWork;
        expect(f.instanceCount).toBe(1);
        const refusal = {
          name: "StorageTransactionAborted",
          message: "Newer staging refused",
          reason: "Newer staging refused",
        } as const;
        tx.abort(refusal);
        tx.abandonStagedWork(refusal);
        await f.runtime.settled();
        expect(f.instanceCount).toBe(0);
        expect(f.output.key("error").get()).toBe(
          `${name} request was refused before it started`,
        );
      } finally {
        tx.abort();
        await f.close();
      }
    });

    it(`retires ${name} state for empty inputs`, async () => {
      const f = await fixture(name);
      try {
        await f.clear();
        expect(f.requests).toHaveLength(0);
        expect(f.instanceCount).toBe(0);
      } finally {
        await f.close();
      }
    });

    for (const completed of [false, true]) {
      it(`preserves ${name} ${completed ? "completion" : "pending state"} when an identical staging attempt is refused`, async () => {
        const f = await fixture(name);
        const tx = f.runtime.edit();
        try {
          await f.run("A");
          await f.issued(1);
          const originalWork = f.works.at(-1)!;
          f.stage(tx, "A");
          if (completed) {
            f.release();
            await originalWork;
          }
          const refusal = {
            name: "StorageTransactionAborted",
            message: "Duplicate staging refused",
            reason: "Duplicate staging refused",
          } as const;
          tx.abort(refusal);
          tx.abandonStagedWork(refusal);
          await f.works.at(-1);
          expect(f.output.key("pending").get()).toBe(!completed);
          expect(f.output.key("error").get()).toBeUndefined();
          f.release();
          await f.runtime.settled();
          expect(f.output.key("result").get()).toEqual(
            name === "generateObject" ? { answer: "A-result" } : "A-result",
          );
        } finally {
          tx.abort();
          await f.close();
        }
      });
    }

    it(`does not let an uncommitted ${name} refusal replace a newer scoped binding`, async () => {
      const f = await fixture(name);
      const tx = f.runtime.edit();
      try {
        f.stage(tx, "refused");
        const scoped = f.runtime.getCell<string>(
          identity.did(),
          "uncommitted-new-scope",
          undefined,
          undefined,
          "user",
        );
        await scoped.sync();
        const seed = f.runtime.edit();
        scoped.withTx(seed).set("new scope");
        expect((await seed.commit().settled).error).toBeUndefined();
        await f.run(scoped);
        await f.issued(1);
        f.release("current-scope");
        await f.runtime.settled();
        const refusal = {
          name: "StorageTransactionAborted",
          message: "Older scope refused",
          reason: "Older scope refused",
        } as const;
        tx.abort(refusal);
        tx.abandonStagedWork(refusal);
        await f.runtime.settled();
        expect(f.parent.key("output").key("result").get()).toEqual(
          name === "generateObject"
            ? { answer: "current-scope" }
            : "current-scope",
        );
        expect(f.instanceCount).toBe(0);
      } finally {
        tx.abort();
        await f.close();
      }
    });

    it(`keeps ${name} scope selected by a newer terminal refusal`, async () => {
      const f = await fixture(name);
      const older = f.runtime.edit();
      const newer = f.runtime.edit();
      const refusal = {
        name: "StorageTransactionAborted",
        message: "Staged request refused",
        reason: "Staged request refused",
      } as const;
      try {
        f.stage(older, "older");
        const scoped = f.runtime.getCell<string>(
          identity.did(),
          "refusal-scope",
          undefined,
          undefined,
          "user",
        );
        await scoped.sync();
        const seed = f.runtime.edit();
        scoped.withTx(seed).set("newer");
        expect((await seed.commit().settled).error).toBeUndefined();
        f.stage(newer, scoped);
        newer.abort(refusal);
        newer.abandonStagedWork(refusal);
        await f.runtime.settled();
        older.abort(refusal);
        older.abandonStagedWork(refusal);
        await f.runtime.settled();
        expect(
          f.parent.key("output").resolveAsCell().getAsNormalizedFullLink()
            .scope,
        ).toBe("user");
        expect(f.instanceCount).toBe(0);
        expect(f.requests).toHaveLength(0);
      } finally {
        older.abort();
        newer.abort();
        await f.close();
      }
    });

    for (const empty of [false, true]) {
      it(`keeps ${name} ${empty ? "empty-input" : "memo-hit"} publication when an older scope is refused`, async () => {
        const f = await fixture(name);
        const tx = f.runtime.edit();
        try {
          const scoped = f.runtime.getCell<unknown>(
            identity.did(),
            "idle-publication",
            undefined,
            undefined,
            "user",
          );
          await scoped.sync();
          const seed = f.runtime.edit();
          scoped.withTx(seed).set(empty ? name === "llm" ? [] : "" : "memo");
          expect((await seed.commit().settled).error).toBeUndefined();
          if (!empty) {
            await f.run(scoped);
            await f.issued(1);
            f.release("memo-result");
            await f.runtime.settled();
          }
          f.stage(tx, "old scope");
          await f.run(scoped, undefined, empty && name === "llm");
          expect(f.requests).toHaveLength(empty ? 0 : 1);
          const refusal = {
            name: "StorageTransactionAborted",
            message: "Old scope refused after idle publication",
            reason: "Old scope refused after idle publication",
          } as const;
          tx.abort(refusal);
          tx.abandonStagedWork(refusal);
          await f.runtime.settled();
          expect(f.parent.key("output").key("error").get()).toBeUndefined();
          expect(
            f.parent.key("output").resolveAsCell().getAsNormalizedFullLink()
              .scope,
          ).toBe("user");
          expect(f.requests).toHaveLength(empty ? 0 : 1);
          expect(f.instanceCount).toBe(0);
        } finally {
          tx.abort();
          await f.close();
        }
      });
    }

    it(`keeps ${name} refusal ownership when a newer scope publication is withdrawn`, async () => {
      const f = await fixture(name);
      const tx = f.runtime.edit();
      try {
        f.stage(tx, "refused");
        const scoped = f.runtime.getCell<string>(
          identity.did(),
          "withdrawn-publication",
          undefined,
          undefined,
          "user",
        );
        await scoped.sync();
        const seed = f.runtime.edit();
        scoped.withTx(seed).set("new scope");
        expect((await seed.commit().settled).error).toBeUndefined();
        const { settlement } = await f.seal(scoped);
        f.wave.abandon("New scope withdrawn");
        expect((await settlement).error).toBeDefined();
        await f.wave.settled();
        const refusal = {
          name: "StorageTransactionAborted",
          message: "Old request refused",
          reason: "Old request refused",
        } as const;
        tx.abort(refusal);
        tx.abandonStagedWork(refusal);
        await f.runtime.settled();
        expect(f.parent.key("output").key("error").get()).toBe(
          `${name} request was refused before it started`,
        );
        expect(
          f.parent.key("output").resolveAsCell().getAsNormalizedFullLink()
            .scope,
        ).toBe("space");
        expect(f.requests).toHaveLength(0);
      } finally {
        tx.abort();
        await f.close();
      }
    });

    it(`retains only the latest ${name} refusal after retryable attempts`, async () => {
      const f = await fixture(name);
      const attempts: IExtendedStorageTransaction[] = [];
      const refusal = {
        name: "StorageTransactionAborted",
        message: "Attempt refused",
        reason: "Attempt refused",
      } as const;
      try {
        for (let index = 0; index < 10; index++) {
          const tx = f.runtime.edit();
          attempts.push(tx);
          f.stage(tx, `attempt-${index}`);
          tx.abort(refusal);
          expect(f.instanceCount).toBe(1);
          expect(f.bindingCount).toBe(1);
        }
        for (const tx of attempts.slice(0, -1)) tx.abandonStagedWork(refusal);
        await f.runtime.settled();
        expect(f.parent.key("output").key("error").get()).toBeUndefined();
        attempts.at(-1)!.abandonStagedWork(refusal);
        await f.runtime.settled();
        expect(f.parent.key("output").key("error").get()).toBe(
          `${name} request was refused before it started`,
        );
        expect(f.instanceCount).toBe(0);
      } finally {
        for (const tx of attempts) tx.abort();
        await f.close();
      }
    });

    it(`keeps ${name} accepted request order when an older callback is delayed`, async () => {
      const f = await fixture(name);
      const older = f.runtime.edit();
      const refused = f.runtime.edit();
      try {
        const callbacks: Array<() => void> = [];
        const addCommitCallback = older.addCommitCallback.bind(older);
        older.addCommitCallback = (callback) => {
          addCommitCallback((committed, outcome) => {
            callbacks.push(() => callback(committed, outcome));
          });
        };
        f.stage(older, "A");
        expect((await older.commit().settled).error).toBeUndefined();
        await older.postCommitEffectsSettled();
        await f.run("B");
        for (const callback of callbacks) callback();
        f.stage(refused, "A");
        const refusal = {
          name: "StorageTransactionAborted",
          message: "New A refused after accepted B",
          reason: "New A refused after accepted B",
        } as const;
        refused.abort(refusal);
        refused.abandonStagedWork(refusal);
        await f.works.at(-1);
        expect(f.output.key("error").get()).toBe(
          `${name} request was refused before it started`,
        );
      } finally {
        older.abort();
        refused.abort();
        await f.close();
      }
    });

    it(`retires ${name} memo-hit state without another model request`, async () => {
      const f = await fixture(name);
      try {
        await f.run("A");
        await f.issued(1);
        f.release();
        await f.runtime.settled();
        expect(f.instanceCount).toBe(0);
        await f.run("A");
        await f.runtime.settled();
        expect(f.instanceCount).toBe(0);
        expect(f.requests).toHaveLength(1);
      } finally {
        await f.close();
      }
    });

    it(`settles ${name} refusal after wave withdrawal`, async () => {
      const f = await fixture(name);
      try {
        const { settlement } = await f.seal("A");
        f.wave.abandon("Request withdrawn");
        expect((await settlement).error).toBeDefined();
        await f.wave.settled();
        for (const refuse of f.refusals) refuse();
        await f.runtime.settled();
        expect(f.parent.get()).toMatchObject({ announced: true });
        expect(f.output.key("error").get()).toBe(
          `${name} request was refused before it started`,
        );
        expect(f.requests).toHaveLength(0);
        expect(f.instanceCount).toBe(0);
      } finally {
        await f.close();
      }
    });

    it(`does not let a retired ${name} refusal replace a newer scoped binding`, async () => {
      const f = await fixture(name);
      const tx = f.runtime.edit();
      try {
        f.stage(tx, "refused");
        const refusal = {
          name: "StorageTransactionAborted",
          message: "Delayed refusal",
          reason: "Delayed refusal",
        } as const;
        tx.abort(refusal);
        await f.run("A");
        await f.issued(1);
        f.release();
        await f.runtime.settled();
        expect(f.instanceCount).toBe(0);
        const scoped = f.runtime.getCell<string>(
          identity.did(),
          "new-scope",
          undefined,
          undefined,
          "user",
        );
        await scoped.sync();
        const seed = f.runtime.edit();
        scoped.withTx(seed).set("new scope");
        expect((await seed.commit().settled).error).toBeUndefined();
        await f.run(scoped);
        await f.issued(2);
        f.release("current-scope");
        await f.runtime.settled();
        tx.abandonStagedWork(refusal);
        await f.runtime.settled();
        expect(f.parent.key("output").key("result").get()).toEqual(
          name === "generateObject"
            ? { answer: "current-scope" }
            : "current-scope",
        );
        expect(f.instanceCount).toBe(0);
      } finally {
        tx.abort();
        await f.close();
      }
    });

    for (const served of [false, true]) {
      it(`republishes ${name} when its output returns to an earlier scope with serving ${served ? "on" : "off"}`, async () => {
        const f = await fixture(name, served);
        try {
          const scoped = f.runtime.getCell<string>(
            identity.did(),
            "scope-return-user",
            undefined,
            undefined,
            "user",
          );
          const shared = f.runtime.getCell<string>(
            identity.did(),
            "scope-return-space",
          );
          await Promise.all([scoped.sync(), shared.sync()]);
          const seed = f.runtime.edit();
          scoped.withTx(seed).set("B");
          shared.withTx(seed).set("C");
          expect((await seed.commit().settled).error).toBeUndefined();
          let index = 0;
          for (const prompt of ["A", scoped, shared]) {
            await f.run(prompt);
            await f.issued(++index);
            f.release(`${["A", "B", "C"][index - 1]}-result`);
            await f.runtime.settled();
          }
          expect(f.requests).toHaveLength(3);
          expect(f.parent.key("output").key("result").get()).toEqual(
            name === "generateObject" ? { answer: "C-result" } : "C-result",
          );
        } finally {
          await f.close();
        }
      });
    }

    for (const superseded of [false, true]) {
      it(`settles ${name} refusal${superseded ? " without replacing a newer result" : " and announces its result"}`, async () => {
        const f = await fixture(name);
        try {
          const tx = f.runtime.edit();
          f.stage(tx, "refused");
          const refusal = {
            name: "StorageTransactionAborted",
            message: "Controlled request refusal",
            reason: "Controlled request refusal",
          } as const;
          tx.abort(refusal);
          if (superseded) {
            await f.run("A");
            await f.issued(1);
            f.release();
            await f.runtime.settled();
            expect(f.parent.key("output").key("result").get()).toEqual(
              name === "generateObject" ? { answer: "A-result" } : "A-result",
            );
          }
          tx.abandonStagedWork(refusal);
          await f.runtime.settled();
          expect(f.parent.get()).toMatchObject({ announced: true });
          expect(f.requests).toHaveLength(superseded ? 1 : 0);
          expect(f.output.get()).toMatchObject(
            superseded
              ? {
                pending: false,
                result: name === "generateObject"
                  ? { answer: "A-result" }
                  : "A-result",
              }
              : {
                pending: false,
                error: `${name} request was refused before it started`,
              },
          );
          if (superseded) expect(f.output.key("error").get()).toBeUndefined();
        } finally {
          await f.close();
        }
      });
    }

    it(`does not dispatch ${name} from a withdrawn wave`, async () => {
      const f = await fixture(name);
      try {
        const { settlement } = await f.seal("A");
        f.wave.abandon("Request withdrawn");
        expect((await settlement).error).toBeDefined();
        await f.wave.settled();
        expect(f.deferred).toHaveLength(1);
        for (const flush of f.deferred) flush();
        await f.runtime.settled();
        expect(f.requests).toHaveLength(0);
        await f.run("A");
        await f.issued(1);
        expect(f.requests).toHaveLength(1);
        f.release();
        await f.runtime.settled();
        expect(f.parent.get()).toMatchObject({ announced: true });
        expect(f.output.get()).toMatchObject({
          pending: false,
          result: name === "generateObject"
            ? { answer: "A-result" }
            : "A-result",
        });
      } finally {
        await f.close();
      }
    });

    it(`reissues ${name} after a newer sealed request is withdrawn`, async () => {
      const f = await fixture(name);
      try {
        await f.run("A");
        await f.issued(1);
        expect(f.requests).toHaveLength(1);
        const firstWork = f.works.at(-1)!;
        const { settlement } = await f.seal("B");
        f.release();
        await firstWork;
        f.wave.abandon("Newer request withdrawn");
        expect((await settlement).error).toBeDefined();
        await f.wave.settled();
        await f.run("A");
        await f.issued(2);
        expect(f.requests).toHaveLength(2);
        f.release();
        await f.runtime.settled();
        expect(f.parent.get()).toMatchObject({ announced: true });
        expect(f.output.get()).toMatchObject({
          pending: false,
          result: name === "generateObject"
            ? { answer: "A-result" }
            : "A-result",
        });
      } finally {
        await f.close();
      }
    });
  }
});
