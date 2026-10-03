import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { pullForInitialization } from "../src/cell.ts";
import { SpeculationLineage } from "../src/scheduler/lineage.ts";
import type { QueuedEvent } from "../src/scheduler/types.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("commit-readiness");

describe("commit-readiness", () => {
  it("selects a space value while a same-id user-scope commit remains pending", async () => {
    const server = newSharedServer();
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let committing: Promise<unknown> | undefined;
    let pulling: Promise<unknown> | undefined;
    try {
      const target = runtime.getCell<number>(signer.did(), "scope-readiness");
      await target.sync();
      const seed = runtime.edit();
      target.withTx(seed).set(6);
      expect((await seed.commit().settled).error).toBeUndefined();
      const user = runtime.getCell<number>(
        signer.did(),
        "scope-readiness",
        undefined,
        undefined,
        "user",
      );
      await user.sync();
      const tx = runtime.edit();
      tx.writeValueOrThrow(user.getAsNormalizedFullLink(), 7);
      const transact = server.transact.bind(server);
      using _held = stub(server, "transact", async (...args) => {
        entered.resolve();
        await release.promise;
        return transact(...args);
      });
      committing = tx.commit().settled;
      await entered.promise;
      pulling = pullForInitialization(target);
      await expect(pulling).resolves.toBe(6);
      expect(storage.hasPendingCommits()).toBe(true);
      expect(storage.hasPendingCommits([{
        space: signer.did(),
        id: target.getAsNormalizedFullLink().id,
      }])).toBe(true);
    } finally {
      release.resolve();
      await committing;
      await pulling;
      await runtime.dispose();
      await storage.close();
      await server.close();
    }
  });

  it("rechecks a disjoint origin promoted while a selected commit settles", async () => {
    const other = await Identity.fromPassphrase("late-readiness-origin");
    const server = newSharedServer();
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const entered = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const release = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const commits: Promise<unknown>[] = [];
    let barrier: Promise<void> | undefined;
    try {
      const target = runtime.getCell<number>(
        signer.did(),
        "late-readiness-target",
      );
      const unrelated = runtime.getCell<number>(
        other.did(),
        "late-readiness-origin",
      );
      await Promise.all([target.sync(), unrelated.sync()]);
      const transact = server.transact.bind(server);
      let index = 0;
      using _held = stub(server, "transact", async (...args) => {
        const current = index++;
        if (current < 2) {
          entered[current].resolve();
          await release[current].promise;
        }
        return transact(...args);
      });
      const selected = runtime.edit();
      target.withTx(selected).set(1);
      commits.push(selected.commit().settled);
      await entered[0].promise;
      const origin = runtime.edit();
      unrelated.withTx(origin).set(7);
      commits.push(origin.commit().settled);
      await entered[1].promise;
      await runtime.scheduler.idle();
      const documents = [target.getAsNormalizedFullLink()];
      const firstRound = Promise.withResolvers<void>();
      const secondRound = Promise.withResolvers<void>();
      const settled = storage.pendingCommitsSettled.bind(storage);
      let rounds = 0;
      using _observed = stub(storage, "pendingCommitsSettled", (targets) => {
        if (++rounds === 1) firstRound.resolve();
        if (rounds === 2) secondRound.resolve();
        return settled(targets);
      });
      barrier = runtime.scheduler.idleWithPendingCommits(() => documents);
      await firstRound.promise;
      // The lineage has no scheduler queue hooks: only scope promotion can
      // make the next readiness round wait for this origin.
      const lineage = new SpeculationLineage({
        dropQueuedEvent: () => {},
        queueExecution: () => {},
        onError: (error) => {
          throw error;
        },
      });
      lineage.recordPieceStop(origin, () => {});
      release[0].resolve();
      expect(
        await Promise.race([
          barrier.then(() => "ready"),
          secondRound.promise.then(() => "rechecked"),
        ]),
      ).toBe("rechecked");
      expect(origin.status().status).toBe("pending");
      expect(storage.hasPendingCommits(documents)).toBe(true);
      release[1].resolve();
      await barrier;
    } finally {
      for (const gate of release) gate.resolve();
      await Promise.allSettled(commits);
      await barrier;
      await runtime.dispose();
      await storage.close();
      await server.close();
    }
  });

  it("settles a document barrier while a disjoint commit remains pending", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const target = { space: signer.did(), id: "of:target" };
    const unrelated = { space: signer.did(), id: "of:unrelated" };
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const unknown = Promise.withResolvers<void>();
    try {
      storage.trackPendingCommit(
        first.promise,
        undefined,
        () => ({ kind: "documents", documents: [unrelated] }),
      );
      storage.trackPendingCommit(
        second.promise,
        undefined,
        () => ({ kind: "documents", documents: [target] }),
      );
      storage.trackPendingCommit(unknown.promise);
      expect(storage.hasPendingCommits([target])).toBe(true);
      const barrier = storage.pendingCommitsSettled([target]);
      second.resolve();
      unknown.resolve();
      await barrier;
      expect(storage.hasPendingCommits([target])).toBe(false);
      expect(storage.hasPendingCommits()).toBe(true);
    } finally {
      first.resolve();
      second.resolve();
      unknown.resolve();
      await storage.pendingCommitsSettled();
      await storage.close();
    }
  });

  it("retains an input repair that can create an undeclared producer output", async () => {
    const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    const peerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const peer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: peerStorage,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    let committing: Promise<unknown> | undefined;
    let pulling: Promise<unknown> | undefined;
    let cancel: (() => void) | undefined;
    let cancelValue: (() => void) | undefined;
    try {
      const source = runtime.getCell<number>(signer.did(), "repair-input");
      const target = runtime.getCell<number>(signer.did(), "undeclared-output");
      const declared = runtime.getCell<number>(signer.did(), "declared-output");
      const peerSource = peer.getCell<number>(signer.did(), "repair-input");
      const seed = peer.edit();
      peerSource.withTx(seed).set(1);
      expect(
        (await seed.commit({ holdSyncedUntilCovered: false }).verdict).error,
      )
        .toBeUndefined();
      await Promise.all([source.sync(), target.sync(), declared.sync()]);
      const stale = runtime.edit();
      expect(source.withTx(stale).get()).toBe(1);
      source.withTx(stale).set(2);
      const update = peer.edit();
      peerSource.withTx(update).set(3);
      expect(
        (await update.commit({ holdSyncedUntilCovered: false }).verdict).error,
      )
        .toBeUndefined();
      const receipt = stale.commit();
      committing = receipt.settled;
      expect((await receipt.verdict).error?.name).toBe("ConflictError");
      const action = (tx: IExtendedStorageTransaction) => {
        if (source.withTx(tx).get() === 3) target.withTx(tx).set(6);
      };
      cancel = runtime.scheduler.subscribe(action, {
        reads: [],
        shallowReads: [],
        writes: [{ ...declared.getAsNormalizedFullLink(), path: [] }],
      }, { isEffect: true, noDebounce: true });
      await runtime.scheduler.idle();
      expect(target.get()).toBeUndefined();
      const entered = Promise.withResolvers<void>();
      const settled = storage.pendingCommitsSettled.bind(storage);
      using _barrier = stub(storage, "pendingCommitsSettled", (documents) => {
        entered.resolve();
        return settled(documents);
      });
      pulling = pullForInitialization(target);
      expect(
        await Promise.race([
          pulling.then(() => "read"),
          entered.promise.then(() => "repair-barrier"),
        ]),
      ).toBe("repair-barrier");
      const valueReady = Promise.withResolvers<void>();
      cancelValue = target.sink((value) => {
        if (value === 6) valueReady.resolve();
      });
      await server.flushSessions();
      await valueReady.promise;
      await server.flushSessions();
      await expect(pulling).resolves.toBe(6);
    } finally {
      cancel?.();
      cancelValue?.();
      await server.flushSessions();
      await committing;
      await pulling;
      await runtime.dispose();
      await peer.dispose();
      await storage.close();
      await peerStorage.close();
      await server.close();
    }
  });

  for (const wrapped of [false, true]) {
    for (const accepted of [false, true]) {
      it(`observes the first pending origin before inline effects with wrapped=${wrapped} accepted=${accepted}`, async () => {
        const server = newSharedServer();
        const storage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
        });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const woke = Promise.withResolvers<void>();
        let committing: Promise<unknown> | undefined;
        try {
          const cell = runtime.getCell<number>(signer.did(), "late-origin");
          await cell.sync();
          const tx = runtime.edit();
          cell.withTx(tx).set(7);
          let effectRan = false;
          tx.enqueuePostCommitEffect({
            id: "wait-for-descendants",
            kind: "test",
            flush: async () => {
              await woke.promise;
              effectRan = true;
            },
          });
          const transact = server.transact.bind(server);
          using _transact = stub(
            server,
            "transact",
            async (message, publish) => {
              entered.resolve();
              await release.promise;
              if (accepted) return transact(message, publish);
              const response = {
                type: "response" as const,
                requestId: message.requestId,
                error: { name: "ConflictError", message: "reject late origin" },
              };
              publish?.(response);
              return response;
            },
          );
          const handle = wrapped ? new TransactionWrapper(tx) : tx;
          committing = handle.commit().settled;
          await entered.promise;
          expect((await handle.commit().settled).error).toBeDefined();
          const dropped: QueuedEvent[] = [];
          let stops = 0;
          const lineage = new SpeculationLineage({
            dropQueuedEvent: (event) => dropped.push(event),
            queueExecution: () => woke.resolve(),
            onError: (error) => {
              throw error;
            },
          });
          const event: QueuedEvent = {
            id: "late-origin-event",
            enqueueSeq: 1,
            originTx: handle,
            eventLink: cell.getAsNormalizedFullLink(),
            action: () => {},
            handler: () => {},
            event: 7,
            retry: false,
          };
          lineage.recordEvent(handle, event);
          lineage.recordPieceStop(handle, () => stops++);
          expect(lineage.originStatus(handle)).toBe("pending");
          release.resolve();
          await committing;
          await woke.promise;
          expect(dropped).toEqual(accepted ? [] : [event]);
          expect(stops).toBe(accepted ? 0 : 1);
          expect(effectRan).toBe(accepted);
        } finally {
          release.resolve();
          woke.resolve();
          await committing;
          await runtime.dispose();
          await storage.close();
          await server.close();
        }
      });
    }

    it(`requires commit hooks to be registered before storage starts with wrapped=${wrapped}`, async () => {
      const server = newSharedServer();
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let committing: Promise<unknown> | undefined;
      try {
        const cell = runtime.getCell<number>(signer.did(), "late-hook");
        await cell.sync();
        const tx = runtime.edit();
        cell.withTx(tx).set(7);
        const transact = server.transact.bind(server);
        using _transact = stub(server, "transact", async (...args) => {
          entered.resolve();
          await release.promise;
          return transact(...args);
        });
        const handle = wrapped ? new TransactionWrapper(tx) : tx;
        committing = handle.commit().settled;
        await entered.promise;
        const register = [
          () => handle.addCommitCallback(() => {}),
          () => handle.addVerdictCallback(() => {}),
          () =>
            handle.enqueuePostCommitEffect({
              id: "late",
              kind: "test",
              flush: () => {},
            }),
        ];
        for (const add of register) {
          expect(add).toThrow("must be registered before starting commit");
        }
        release.resolve();
        await committing;
        for (const add of register) {
          expect(add).toThrow("must be registered before starting commit");
        }
      } finally {
        release.resolve();
        await committing;
        await runtime.dispose();
        await storage.close();
        await server.close();
      }
    });
  }
});
