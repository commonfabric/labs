/// <reference path="../clock.d.ts" />

/** Exercises dialog refusal and cancellation at transaction boundaries. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { BuiltInLLMMessage, CellScope } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { LLMClient, type LLMResponse } from "@commonfabric/llm";

import { llmDialog } from "../../src/builtins/llm-dialog.ts";
import { LLMMessageSchema } from "../../src/builtins/llm-schemas.ts";
import type { Cell } from "../../src/cell.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveSettlementOf,
} from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("dialog transaction lifecycle");

/** Constructs one raw node with real cells and controllable model work. */
async function fixture(
  served = true,
  inputScope: CellScope = "space",
  bindingScope: CellScope = "space",
) {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    servingPosture: served,
    experimental: { serverExecution: served },
  });
  const input = runtime.getCell<any>(
    signer.did(),
    "dialog-input",
    undefined,
    undefined,
    inputScope,
  );
  const parent = runtime.getCell<any>(
    signer.did(),
    "dialog-parent",
    undefined,
    undefined,
    bindingScope,
  );
  const handlers = new Map<
    string,
    (tx: IExtendedStorageTransaction, event: any) => void
  >();
  const cancellations: (() => void)[] = [];
  const requests: {
    response: ReturnType<typeof Promise.withResolvers<LLMResponse>>;
    signal?: AbortSignal;
  }[] = [];
  const works: Promise<unknown>[] = [];
  const held: ((tx?: IExtendedStorageTransaction) => unknown)[] = [];
  const publications: { identity: unknown; scope: CellScope }[] = [];
  const cells = new Map<CellScope, Cell<BuiltInLLMMessage[]>>();
  let output: Cell<any>;
  let changed = Promise.withResolvers<void>();
  const originalSend = LLMClient.prototype.sendRequest;
  const originalHandler = runtime.scheduler.addEventHandler;
  try {
    await input.sync();
    await parent.sync();
    runtime.scheduler.addEventHandler = (handler, ref) => {
      handlers.set(`${ref.scope ?? "space"}/${ref.path.at(-1)}`, handler);
      return () => {};
    };
    LLMClient.prototype.sendRequest = (_request, _partial, signal) => {
      const response = Promise.withResolvers<LLMResponse>();
      requests.push({ response, signal });
      const prior = changed;
      changed = Promise.withResolvers<void>();
      prior.resolve();
      return response.promise;
    };
    runtime.asyncWorkObserver = (work) => works.push(work);
    const { action } = llmDialog(
      input,
      (tx, result) => {
        output = result;
        publications.push({
          identity: tx.tx.scopeKeyIdentity,
          scope: result.getAsNormalizedFullLink().scope ?? "space",
        });
        parent.withTx(tx).set({ output: result });
      },
      (cancel) => cancellations.push(cancel),
      "dialog-test",
      parent,
      runtime,
      undefined,
      undefined,
      parent.key("output").getAsNormalizedFullLink(),
    );

    return {
      runtime,
      input,
      parent,
      requests,
      works,
      held,
      publications,
      action,
      cancellations,
      get output() {
        return output;
      },
      async select(scope: CellScope, identity = runtime.scopeKeyIdentity) {
        const tx = runtime.edit();
        tx.tx.scopeKeyIdentity = identity;
        let messages = cells.get(scope);
        if (!messages) {
          messages = runtime.getCell<BuiltInLLMMessage[]>(
            signer.did(),
            "messages",
            { type: "array", items: LLMMessageSchema },
            tx,
            scope,
          );
          messages.withTx(tx).set([]);
          cells.set(scope, messages.withTx());
        }
        input.withTx(tx).set({ messages, builtinTools: false });
        action(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
      },
      stage(
        scope: CellScope,
        content: string,
        identity = runtime.scopeKeyIdentity,
        hold = false,
      ) {
        const tx = runtime.edit();
        tx.tx.scopeKeyIdentity = identity;
        if (hold) {
          const enqueue = tx.enqueuePostCommitEffect.bind(tx);
          tx.enqueuePostCommitEffect = (effect) =>
            enqueue({
              ...effect,
              flush: (committed) => {
                held.push((override) => effect.flush(override ?? committed));
              },
            });
        }
        const handler = handlers.get(`${scope}/addMessage`);
        expect(handler).toBeDefined();
        handler!(tx, { role: "user", content });
        return tx;
      },
      cancel(tx: IExtendedStorageTransaction, scope: CellScope) {
        handlers.get(`${scope}/cancelGeneration`)!(tx, undefined);
        action(tx);
      },
      async issued(count: number) {
        while (requests.length < count) await changed.promise;
      },
      async close() {
        runtime.clearSealDestination();
        for (const request of requests) {
          request.response.resolve({
            role: "assistant",
            content: "cleanup",
            id: "cleanup",
          });
        }
        try {
          await runtime.settled();
        } finally {
          try {
            await runtime.dispose({ closeStorage: false });
          } finally {
            try {
              await storage.close();
            } finally {
              LLMClient.prototype.sendRequest = originalSend;
              runtime.scheduler.addEventHandler = originalHandler;
            }
          }
        }
      },
    };
  } catch (error) {
    try {
      await runtime.dispose({ closeStorage: false });
    } finally {
      try {
        await storage.close();
      } finally {
        LLMClient.prototype.sendRequest = originalSend;
        runtime.scheduler.addEventHandler = originalHandler;
      }
    }
    throw error;
  }
}

/** Abandons a request after its transaction rolls back. */
function refuse(tx: IExtendedStorageTransaction) {
  const reason = {
    name: "StorageTransactionAborted",
    message: "Test refusal",
    reason: "Test refusal",
  } as const;
  tx.abort(reason);
  tx.abandonStagedWork(reason);
}

describe("llm-dialog-served", () => {
  it("settles an initially refused turn without adding a transcript entry", async () => {
    const f = await fixture();
    try {
      await f.select("user");
      const tx = f.stage("user", "refused");
      refuse(tx);
      await f.runtime.settled();
      expect(f.requests).toHaveLength(0);
      expect(f.output.key("pending").get()).toBe(false);
      expect(
        f.input.key("messages").asSchema({
          type: "array",
          items: LLMMessageSchema,
        }).get(),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("keeps a newer scope selected when an older turn is refused", async () => {
    const f = await fixture();
    try {
      await f.select("space");
      const tx = f.stage("space", "refused");
      await f.select("user");
      expect(
        f.parent.key("output").resolveAsCell().getAsNormalizedFullLink().scope,
      ).toBe("user");
      refuse(tx);
      await f.runtime.settled();
      expect(f.requests).toHaveLength(0);
      expect(
        f.parent.key("output").resolveAsCell().getAsNormalizedFullLink().scope,
      ).toBe("user");
    } finally {
      await f.close();
    }
  });

  it("retains a live turn when its cancellation wave is withdrawn", async () => {
    const f = await fixture();
    const wave = new WaveAccumulator({
      space: signer.did(),
      basisSeq: 0,
      scopeKeyIdentity: f.runtime.scopeKeyIdentity,
      replicaFor: (space) => f.runtime.storageManager.open(space).replica,
    });
    try {
      await f.select("user");
      const start = f.stage("user", "accepted");
      expect((await start.commit().settled).error).toBeUndefined();
      await start.postCommitEffectsSettled();
      await f.issued(1);
      f.runtime.installSealDestination({
        seal: (tx) => wave.seal(tx),
        deferSealedEffects: () => true,
      });
      const cancel = f.runtime.edit();
      stampWaveRunContext(cancel, {
        actionId: "withdrawn-cancel",
        kind: "derivation",
      });
      f.cancel(cancel, "user");
      expect((await cancel.commit().settled).error).toBeUndefined();
      f.runtime.clearSealDestination();
      wave.abandon("Withdraw cancellation");
      await waveSettlementOf(cancel);
      expect(f.requests[0].signal?.aborted).toBe(false);
      f.requests[0].response.resolve({
        role: "assistant",
        content: "accepted reply",
        id: "accepted",
      });
      await f.runtime.settled();
      expect(f.output.key("pending").get()).toBe(false);
      expect(
        f.input.key("messages").asSchema({
          type: "array",
          items: LLMMessageSchema,
        }).get()?.at(-1)?.content,
      ).toBe("accepted reply");
    } finally {
      wave.abandon("Fixture complete");
      await wave.settled();
      await f.close();
    }
  });
  for (const served of [false, true]) {
    it(`returns to the existing output scope with execution ${served ? "on" : "off"}`, async () => {
      const f = await fixture(served);
      try {
        await f.select("space");
        const first = f.stage("space", "first");
        expect((await first.commit().settled).error).toBeUndefined();
        await first.postCommitEffectsSettled();
        await f.issued(1);
        await f.select("user");
        const second = f.stage("user", "second");
        expect((await second.commit().settled).error).toBeUndefined();
        await second.postCommitEffectsSettled();
        await f.issued(2);
        await f.select("space");
        expect(f.requests.map((request) => request.signal?.aborted)).toEqual([
          false,
          false,
        ]);
        f.requests[1].response.resolve({
          role: "assistant",
          content: "second reply",
          id: "second",
        });
        f.requests[0].response.resolve({
          role: "assistant",
          content: "first reply",
          id: "first",
        });
        await f.runtime.settled();
        expect(
          f.parent.key("output").resolveAsCell().getAsNormalizedFullLink()
            .scope,
        ).toBe("space");
        expect(f.output.key("pending").get()).toBe(false);
        expect(
          f.input.key("messages").asSchema({
            type: "array",
            items: LLMMessageSchema,
          }).get()?.at(-1)?.content,
        ).toBe("first reply");
      } finally {
        await f.close();
      }
    });
  }

  it("aborts every live turn when one teardown transaction throws", async () => {
    const f = await fixture();
    const edit = f.runtime.edit;
    try {
      for (const scope of ["space", "user"] as const) {
        await f.select(scope);
        const tx = f.stage(scope, scope);
        expect((await tx.commit().settled).error).toBeUndefined();
        await tx.postCommitEffectsSettled();
      }
      await f.issued(2);
      let attempts = 0;
      f.runtime.edit = (...args) => {
        if (++attempts === 1) throw new Error("teardown failure");
        return edit.apply(f.runtime, args);
      };
      f.cancellations[0]();
      expect(attempts).toBe(2);
      expect(f.requests.map((request) => request.signal?.aborted)).toEqual([
        true,
        true,
      ]);
    } finally {
      f.runtime.edit = edit;
      await f.close();
    }
  });

  it("retains async ownership until a failed model turn finishes its error write", async () => {
    const f = await fixture();
    const originalEdit = f.runtime.editWithRetry;
    const edit = originalEdit.bind(f.runtime);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      await f.select("user");
      const tx = f.stage("user", "fails");
      expect((await tx.commit().settled).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      await f.issued(1);
      f.runtime.editWithRetry = (fn, maxRetries, options) => {
        entered.resolve();
        return release.promise.then(() => edit(fn, maxRetries, options));
      };
      let settled = false;
      f.works[0].then(() => {
        settled = true;
      });
      f.requests[0].response.reject(new Error("model failed"));
      await entered.promise;
      await clock.settle();
      expect(settled).toBe(false);
      release.resolve();
      await f.works[0];
      expect(f.output.key("pending").get()).toBe(false);
      expect(
        f.input.key("messages").asSchema({
          type: "array",
          items: LLMMessageSchema,
        }).get()?.at(-1)?.content,
      ).toContain("model failed");
    } finally {
      release.resolve();
      f.runtime.editWithRetry = originalEdit;
      await f.close();
    }
  });
  it("preserves another actor's accepted selection of a shared physical binding", async () => {
    const f = await fixture(true, "user");
    const alice = {
      principal: (await Identity.fromPassphrase("dialog-alice")).did(),
      sessionId: "alice-one",
    };
    const bob = {
      principal: (await Identity.fromPassphrase("dialog-bob")).did(),
      sessionId: "bob-one",
    };
    try {
      await f.select("user", alice);
      const old = f.stage("user", "refused", alice);
      await f.select("session", bob);
      expect(
        f.parent.key("output").resolveAsCell().getAsNormalizedFullLink().scope,
      ).toBe("session");
      refuse(old);
      await f.runtime.settled();
      expect(
        f.parent.key("output").resolveAsCell().getAsNormalizedFullLink().scope,
      ).toBe("session");
    } finally {
      await f.close();
    }
  });

  it("restores a refused actor's distinct binding to a shared result", async () => {
    const f = await fixture(true, "space", "user");
    const alice = {
      principal: (await Identity.fromPassphrase("dialog-alice")).did(),
      sessionId: "alice-one",
    };
    const bob = {
      principal: (await Identity.fromPassphrase("dialog-bob")).did(),
      sessionId: "bob-one",
    };
    try {
      await f.select("space", alice);
      const clear = f.runtime.edit();
      clear.tx.scopeKeyIdentity = alice;
      f.parent.withTx(clear).set(undefined);
      expect((await clear.commit().settled).error).toBeUndefined();
      const old = f.stage("space", "refused", alice);
      f.action(old);
      await f.select("space", bob);
      refuse(old);
      await f.runtime.settled();
      expect(f.publications.at(-1)).toEqual({
        identity: alice,
        scope: "space",
      });
    } finally {
      await f.close();
    }
  });

  it("does not dispatch an accepted turn after graph teardown", async () => {
    const f = await fixture();
    try {
      await f.select("user");
      const tx = f.stage("user", "held", undefined, true);
      expect((await tx.commit().settled).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      expect(f.requests).toHaveLength(0);
      f.cancellations[0]();
      await f.runtime.settled();
      expect(f.output.key("pending").get()).toBe(false);
      await f.held[0]();
      await clock.settle();
      expect(f.requests).toHaveLength(0);
      expect(f.output.key("pending").get()).toBe(false);
    } finally {
      await f.close();
    }
  });

  for (const activePredecessor of [false, true]) {
    it(`retains an accepted local turn beyond the heartbeat age${activePredecessor ? " while its predecessor settles" : ""}`, async () => {
      const f = await fixture();
      try {
        await f.select("user");
        if (activePredecessor) {
          const predecessor = f.stage("user", "predecessor");
          expect((await predecessor.commit().settled).error).toBeUndefined();
          await predecessor.postCommitEffectsSettled();
          await f.issued(1);
          const cancel = f.runtime.edit();
          f.cancel(cancel, "user");
          expect((await cancel.commit().settled).error).toBeUndefined();
        }
        const first = f.stage("user", "held", undefined, true);
        expect((await first.commit().settled).error).toBeUndefined();
        await first.postCommitEffectsSettled();
        await clock.tick(6 * 60 * 1000);
        const second = f.stage("user", "ignored", undefined, true);
        expect(second.getCfcState().outbox).toHaveLength(0);
        expect((await second.commit().settled).error).toBeUndefined();
        await f.held[0]();
        await f.issued(activePredecessor ? 2 : 1);
      } finally {
        await f.close();
      }
    });
  }

  it("clears an accepted claim when its provider release check rejects", async () => {
    const f = await fixture();
    try {
      await f.select("user");
      const tx = f.stage("user", "rejected release", undefined, true);
      expect((await tx.commit().settled).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      expect(f.output.key("pending").get()).toBe(true);
      let rejected = 0;
      await f.held[0]({
        getCfcState: () => ({
          writePolicyInputs: [],
          prepare: {
            status: "prepared",
            digest: "test",
            input: { writePolicyInputs: [] },
          },
        }),
        noteCfcSinkReleaseReject: () => rejected++,
      } as unknown as IExtendedStorageTransaction);
      await f.runtime.settled();
      expect(rejected).toBe(1);
      expect(f.requests).toHaveLength(0);
      expect(f.output.key("pending").get()).toBe(false);
      const edit = f.runtime.edit;
      let cleanup = 0;
      f.runtime.edit = (...args) => {
        cleanup++;
        return edit.apply(f.runtime, args);
      };
      try {
        f.cancellations[0]();
        expect(cleanup).toBe(0);
      } finally {
        f.runtime.edit = edit;
      }
    } finally {
      await f.close();
    }
  });

  it("clears a handler claim accepted after the graph stops", async () => {
    const f = await fixture();
    try {
      await f.select("user");
      const tx = f.stage("user", "late acceptance", undefined, true);
      f.cancellations[0]();
      expect((await tx.commit().settled).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      await f.runtime.settled();
      expect(f.output.key("pending").get()).toBe(false);
      await f.held[0]();
      expect(f.requests).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it("aborts a teardown transaction whose stamping fails", async () => {
    const f = await fixture();
    const edit = f.runtime.edit;
    const stamp = f.runtime.stampServerRun;
    let cleanupTx: IExtendedStorageTransaction | undefined;
    let aborted = false;
    try {
      await f.select("user");
      const tx = f.stage("user", "active");
      expect((await tx.commit().settled).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      await f.issued(1);
      f.runtime.edit = (...args) => {
        cleanupTx = edit.apply(f.runtime, args);
        const abort = cleanupTx.abort.bind(cleanupTx);
        cleanupTx.abort = (reason) => {
          aborted = true;
          return abort(reason);
        };
        return cleanupTx;
      };
      f.runtime.stampServerRun = () => {
        throw new Error("stamp failed");
      };
      f.cancellations[0]();
      expect(cleanupTx).toBeDefined();
      expect(aborted).toBe(true);
      expect(f.requests[0].signal?.aborted).toBe(true);
    } finally {
      f.runtime.edit = edit;
      f.runtime.stampServerRun = stamp;
      await f.close();
    }
  });

  it("preserves refusal ownership when a different-target publication is withdrawn", async () => {
    const f = await fixture();
    const wave = new WaveAccumulator({
      space: signer.did(),
      basisSeq: 0,
      scopeKeyIdentity: f.runtime.scopeKeyIdentity,
      replicaFor: (space) => f.runtime.storageManager.open(space).replica,
    });
    try {
      await f.select("user");
      const userInputs = f.input.get();
      await f.select("space");
      const old = f.stage("space", "old refusal");
      f.runtime.installSealDestination({
        seal: (tx) => wave.seal(tx),
        deferSealedEffects: () => true,
      });
      const publish = f.runtime.edit();
      stampWaveRunContext(publish, {
        actionId: "withdrawn-publication",
        kind: "derivation",
      });
      f.input.withTx(publish).set(userInputs);
      f.action(publish);
      expect((await publish.commit().settled).error).toBeUndefined();
      f.runtime.clearSealDestination();
      wave.abandon("Withdraw publication");
      await waveSettlementOf(publish);
      const before = f.publications.length;
      refuse(old);
      await f.runtime.settled();
      expect(f.publications).toHaveLength(before + 1);
      expect(f.publications.at(-1)?.scope).toBe("space");
    } finally {
      wave.abandon("Fixture complete");
      await wave.settled();
      await f.close();
    }
  });

  it("lets an accepted refusal announcement supersede an older target", async () => {
    const f = await fixture(true, "user");
    const alice = {
      principal: (await Identity.fromPassphrase("dialog-alice")).did(),
      sessionId: "alice-one",
    };
    const bob = {
      principal: (await Identity.fromPassphrase("dialog-bob")).did(),
      sessionId: "bob-one",
    };
    try {
      await f.select("session", bob);
      await f.select("user", alice);
      const older = f.stage("user", "older", alice);
      const newer = f.stage("session", "newer", bob);
      f.action(newer);
      refuse(newer);
      await f.runtime.settled();
      const before = f.publications.length;
      refuse(older);
      await f.runtime.settled();
      expect(f.publications).toHaveLength(before);
      expect(
        f.parent.key("output").resolveAsCell().getAsNormalizedFullLink().scope,
      ).toBe("session");
    } finally {
      await f.close();
    }
  });
  it("keeps a dispatched turn when a duplicate release check rejects", async () => {
    const f = await fixture();
    try {
      await f.select("user");
      const tx = f.stage("user", "held", undefined, true);
      expect((await tx.commit().settled).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      await f.held[0]();
      await f.issued(1);
      let rejected = 0;
      await f.held[0]({
        getCfcState: () => ({
          writePolicyInputs: [],
          prepare: {
            status: "prepared",
            digest: "test",
            input: { writePolicyInputs: [] },
          },
        }),
        noteCfcSinkReleaseReject: () => rejected++,
      } as unknown as IExtendedStorageTransaction);
      await clock.settle();
      expect(rejected).toBe(1);
      expect(f.output.key("pending").get()).toBe(true);
      expect(f.requests[0].signal?.aborted).toBe(false);
      f.requests[0].response.resolve({
        role: "assistant",
        content: "accepted reply",
        id: "accepted",
      });
      await f.runtime.settled();
      expect(f.output.key("pending").get()).toBe(false);
      expect(
        f.input.key("messages").asSchema({
          type: "array",
          items: LLMMessageSchema,
        }).get()?.at(-1)?.content,
      ).toBe("accepted reply");
    } finally {
      await f.close();
    }
  });
  it("recovers a pending dialog with no durable claim", async () => {
    const f = await fixture();
    try {
      await f.select("user");
      const pending = f.runtime.edit();
      f.output.withTx(pending).key("pending").set(true);
      expect((await pending.commit().settled).error).toBeUndefined();
      const tx = f.stage("user", "recovered");
      expect(tx.getCfcState().outbox).toHaveLength(1);
      expect((await tx.commit().settled).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      await f.issued(1);
    } finally {
      await f.close();
    }
  });
});
