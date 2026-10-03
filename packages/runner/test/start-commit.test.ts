import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { stampSpeculationRunContext } from "../src/speculation/overlay-destination.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import type { IStorageTransaction } from "../src/storage/interface.ts";

/** Compiler checks for selecting a receipt stage; this function is never run. */
export async function commitStageTypeChecks(
  tx: IStorageTransaction,
): Promise<void> {
  const receipt = tx.commit();
  // @ts-expect-error a receipt is not a completion promise
  await receipt;
  // @ts-expect-error promise assimilation cannot wait for a receipt
  await Promise.resolve(receipt);
  // @ts-expect-error a race must select a receipt stage
  await Promise.race([receipt]);
  await receipt.verdict;
  await receipt.settled;
}

const signer = await Identity.fromPassphrase("start-commit");

describe("start-commit", () => {
  it("rejects promise assimilation without cancelling the commit attempt", async () => {
    const completion = Promise.withResolvers<{ ok: object }>();
    const receipt = createTransactionCommitReceipt(completion.promise);
    const untyped: unknown = receipt;
    const attempts = [
      async () => await untyped,
      // An async return also assimilates receipts without an explicit await.
      // deno-lint-ignore require-await
      async () => untyped,
      () => Promise.resolve(untyped),
      () => Promise.all([receipt]),
      () => Promise.race([receipt]),
      () => Promise.resolve().then(() => untyped),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow(
        "Select receipt.verdict or receipt.settled",
      );
    }
    const outcome = { ok: {} };
    completion.resolve(outcome);
    expect(await receipt.verdict).toBe(outcome);
    expect(await receipt.settled).toBe(outcome);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  for (const wrapped of [false, true, "raw"] as const) {
    it(`applies a single-space write before remote confirmation with wrapped=${wrapped}`, async () => {
      const server = newSharedServer();
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let settlement: Promise<unknown> | undefined;
      try {
        const cell = runtime.getCell<number>(signer.did(), "local-read");
        await cell.sync();
        const tx = runtime.edit();
        cell.withTx(tx).set(7);
        const transact = server.transact.bind(server);
        using _transact = stub(server, "transact", async (...args) => {
          entered.resolve();
          await release.promise;
          return transact(...args);
        });
        const committing = wrapped === "raw"
          ? tx.tx
          : wrapped
          ? new TransactionWrapper(new TransactionWrapper(tx))
          : tx;
        const receipt = committing.commit();
        settlement = receipt.settled;
        expect(typeof receipt.then).toBe("function");
        expect(cell.withTx().get()).toBe(7);
        expect(storage.hasPendingCommits()).toBe(true);
        await entered.promise;
        expect(await cell.pull()).toBe(7);
        release.resolve();
        expect((await receipt.verdict).error).toBeUndefined();
        expect((await receipt.settled).error).toBeUndefined();
      } finally {
        release.resolve();
        await settlement;
        await runtime.dispose();
        await storage.close();
        await server.close();
      }
    });
  }

  for (const holdSyncedUntilCovered of [true, false]) {
    it(`keeps raw settlement on coverage with holdSyncedUntilCovered=${holdSyncedUntilCovered}`, async () => {
      const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      let settlement: Promise<unknown> | undefined;
      try {
        const cell = runtime.getCell<number>(signer.did(), "raw-stages");
        const seed = runtime.edit();
        cell.withTx(seed).set(1);
        const seeded = seed.commit({ holdSyncedUntilCovered: false });
        expect((await seeded.verdict).error).toBeUndefined();
        await cell.sync();
        await server.flushSessions();
        await seeded.settled;
        const tx = runtime.edit();
        cell.withTx(tx).set(2);
        const receipt = tx.tx.commit({ holdSyncedUntilCovered });
        let settled = false;
        settlement = receipt.settled.then(() => {
          settled = true;
        });
        expect((await receipt.verdict).error).toBeUndefined();
        let synced = false;
        const synchronization = storage.synced().then(() => {
          synced = true;
        });
        await clock.settle();
        expect(settled).toBe(false);
        expect(synced).toBe(!holdSyncedUntilCovered);
        expect(storage.hasPendingCommits()).toBe(true);
        await server.flushSessions();
        expect((await receipt.settled).error).toBeUndefined();
        await synchronization;
        expect(cell.get()).toBe(2);
      } finally {
        await server.flushSessions();
        await settlement;
        await runtime.dispose();
        await storage.close();
        await server.close();
      }
    });
  }

  for (const wrapped of [false, true, "unstamped", "bookkeeping"] as const) {
    it(`reports the verdict before coverage and inline effects with wrapped=${wrapped}`, async () => {
      const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        experimental: { serverExecution: typeof wrapped === "string" },
      });
      const releaseEffect = Promise.withResolvers<void>();
      const effectEntered = Promise.withResolvers<void>();
      let settlement: Promise<unknown> | undefined;
      try {
        const cell = runtime.getCell<number>(signer.did(), "commit-stages");
        const seed = runtime.edit();
        cell.withTx(seed).set(1);
        expect(
          (await seed.commit({ holdSyncedUntilCovered: false }).verdict).error,
        )
          .toBeUndefined();
        await cell.sync();
        const tx = runtime.edit();
        cell.withTx(tx).set(2);
        if (wrapped === "bookkeeping") {
          stampSpeculationRunContext(tx, {
            actionId: "stage-bookkeeping",
            kind: "bookkeeping",
          });
        }
        if (typeof wrapped === "string") {
          expect(runtime.speculationOverlay).toBeDefined();
        }
        let verdictCallbackFired = false;
        tx.addVerdictCallback(() => {
          verdictCallbackFired = true;
        });
        tx.enqueuePostCommitEffect({
          id: "held-effect",
          kind: "test",
          flush: () => {
            effectEntered.resolve();
            return releaseEffect.promise;
          },
        });
        let callbackFired = false;
        tx.addCommitCallback(() => {
          callbackFired = true;
        });
        const committing = wrapped === true
          ? new TransactionWrapper(new TransactionWrapper(tx))
          : tx;
        const receipt = committing.commit();
        let settled = false;
        settlement = receipt.settled.then((result) => {
          settled = true;
          return result;
        });
        expect((await receipt.verdict).error).toBeUndefined();
        await effectEntered.promise;
        expect(verdictCallbackFired).toBe(true);
        expect(callbackFired).toBe(false);
        expect(settled).toBe(false);
        expect(storage.hasPendingCommits()).toBe(true);
        await server.flushSessions();
        await clock.settle();
        expect(callbackFired).toBe(true);
        expect(settled).toBe(false);
        releaseEffect.resolve();
        expect((await receipt.settled).error).toBeUndefined();
        expect(cell.get()).toBe(2);
      } finally {
        releaseEffect.resolve();
        await server.flushSessions();
        await settlement;
        await runtime.dispose();
        await storage.close();
        await server.close();
      }
    });
  }

  it("reports a store-forwarding seal rejection before repair", async () => {
    const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    const storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    const storageB = EmulatedStorageManager.connectTo(server, { as: signer });
    const peer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
      experimental: { serverExecution: true },
    });
    let settlement: Promise<unknown> | undefined;
    try {
      const source = peer.getCell<number>(signer.did(), "sealed-rejection");
      const seed = peer.edit();
      source.withTx(seed).set(1);
      expect(
        (await seed.commit({ holdSyncedUntilCovered: false }).verdict).error,
      ).toBeUndefined();
      const target = runtime.getCell<number>(signer.did(), "sealed-rejection");
      await target.sync();
      await target.pull();
      const tx = runtime.edit();
      expect(target.withTx(tx).get()).toBe(1);
      target.withTx(tx).set(2);
      const update = peer.edit();
      source.withTx(update).set(3);
      expect(
        (await update.commit({ holdSyncedUntilCovered: false }).verdict).error,
      ).toBeUndefined();
      expect(target.get()).toBe(1);
      let verdictFired = false;
      let commitFired = false;
      let effectFired = false;
      tx.addVerdictCallback(() => {
        verdictFired = true;
      });
      tx.addCommitCallback(() => {
        commitFired = true;
      });
      tx.enqueuePostCommitEffect({
        id: "refused-seal-effect",
        kind: "test",
        flush: () => {
          effectFired = true;
        },
      });
      const receipt = tx.commit();
      let settled = false;
      settlement = receipt.settled.then(() => {
        settled = true;
      });
      expect((await receipt.verdict).error?.name).toBe("ConflictError");
      await clock.settle();
      expect(verdictFired).toBe(true);
      expect(commitFired).toBe(false);
      expect(effectFired).toBe(false);
      expect(settled).toBe(false);
      await server.flushSessions();
      expect((await receipt.settled).error?.name).toBe("ConflictError");
      expect(commitFired).toBe(true);
      expect(effectFired).toBe(false);
      expect(target.get()).toBe(3);
    } finally {
      await server.flushSessions();
      await settlement;
      await runtime.dispose();
      await peer.dispose();
      await storageB.close();
      await storageA.close();
      await server.close();
    }
  });

  it("waits for earlier spaces' coverage after a later space throws", async () => {
    const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const otherSpace = (await Identity.fromPassphrase("receipt other space"))
      .did();
    const otherReplica = storage.open(otherSpace).replica;
    const commitNative = otherReplica.commitNative;
    let settlement: Promise<unknown> | undefined;
    try {
      const first = runtime.getCell<number>(signer.did(), "partial-first");
      const second = runtime.getCell<number>(otherSpace, "partial-second");
      const seed = runtime.edit();
      seed.enableMultiSpaceWrites?.([signer.did(), otherSpace]);
      first.withTx(seed).set(1);
      second.withTx(seed).set(1);
      const seeded = seed.commit({ holdSyncedUntilCovered: false });
      expect((await seeded.verdict).error).toBeUndefined();
      await first.sync();
      await second.sync();
      await server.flushSessions();
      await seeded.settled;
      const tx = runtime.edit();
      tx.enableMultiSpaceWrites?.([signer.did(), otherSpace]);
      first.withTx(tx).set(2);
      second.withTx(tx).set(2);
      otherReplica.commitNative = undefined;
      const receipt = tx.tx.commit();
      let settled = false;
      settlement = receipt.settled.then(() => {
        settled = true;
      });
      expect((await receipt.verdict).error?.message).toContain("commitNative");
      await clock.settle();
      expect(settled).toBe(false);
      expect(storage.hasPendingCommits()).toBe(true);
      await server.flushSessions();
      expect((await receipt.settled).error?.message).toContain("commitNative");
      expect(first.get()).toBe(2);
      expect(second.get()).toBe(1);
    } finally {
      otherReplica.commitNative = commitNative;
      await server.flushSessions();
      await settlement;
      await runtime.dispose();
      await storage.close();
      await server.close();
    }
  });

  it("reports each repeated attempt's error instead of the original verdict", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const cell = runtime.getCell<number>(signer.did(), "repeated");
      await cell.sync();
      const tx = runtime.edit();
      cell.withTx(tx).set(7);
      const original = tx.commit();
      for (
        const receipt of [
          tx.commit(),
          new TransactionWrapper(tx).commit(),
          tx.tx.commit(),
        ]
      ) {
        expect((await receipt.verdict).error?.name).toBe(
          "StorageTransactionCompleteError",
        );
        expect((await receipt.settled).error?.name).toBe(
          "StorageTransactionCompleteError",
        );
      }
      expect((await original.settled).error).toBeUndefined();
      for (
        const receipt of [
          tx.commit(),
          new TransactionWrapper(tx).commit(),
          tx.tx.commit(),
        ]
      ) {
        expect((await receipt.verdict).error?.name).toBe(
          "StorageTransactionCompleteError",
        );
        expect((await receipt.settled).error?.name).toBe(
          "StorageTransactionCompleteError",
        );
      }
      const aborted = runtime.edit();
      aborted.abort("cancelled");
      const receipt = aborted.commit();
      expect((await receipt.verdict).error?.name).toBe(
        "StorageTransactionAborted",
      );
      expect((await receipt.settled).error?.name).toBe(
        "StorageTransactionAborted",
      );
      const empty = runtime.edit().commit();
      expect((await empty.verdict).error).toBeUndefined();
      expect((await empty.settled).error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  for (const ready of [false, true]) {
    it(`reports an internal exception when neither receipt stage is observed with ready=${ready}`, async () => {
      const storage = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      try {
        const tx = runtime.edit();
        if (!ready) tx.abort("closed");
        const failure = new Error("unobserved commit failure");
        using reported = stub(console, "error", () => {});
        using _commit = stub(
          tx,
          "commit",
          () => createTransactionCommitReceipt(Promise.reject(failure)),
        );
        new TransactionWrapper(tx).commit();
        await clock.settle();
        expect(reported.calls).toHaveLength(1);
        expect(reported.calls[0].args).toContain(failure);
        if (ready) tx.abort("done");
      } finally {
        await runtime.dispose();
        await storage.close();
      }
    });
  }

  for (const serverExecution of [false, true]) {
    it(
      serverExecution
        ? "preserves internal rejection with one report through a store-forwarding seal"
        : "preserves internal rejection when only settlement is observed",
      async () => {
        const storage = StorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
          experimental: { serverExecution },
        });
        try {
          const tx = runtime.edit();
          const failure = new Error("internal commit failure");
          using reported = stub(console, "error", () => {});
          using _commit = stub(
            tx.tx,
            "commit",
            () => createTransactionCommitReceipt(Promise.reject(failure)),
          );
          const receipt = new TransactionWrapper(tx).commit();
          await expect(receipt.settled).rejects.toBe(failure);
          await clock.settle();
          expect(reported.calls).toHaveLength(1);
          tx.abort("done");
        } finally {
          await runtime.dispose();
          await storage.close();
        }
      },
    );
  }

  it("reports a settlement exception after a successful verdict", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const accepted = await runtime.edit().commit().settled;
      const tx = runtime.edit();
      const completion = Promise.withResolvers<
        Awaited<ReturnType<typeof tx.commit>["settled"]>
      >();
      const failure = new Error("late settlement failure");
      using reported = stub(console, "error", () => {});
      using _commit = stub(
        tx.tx,
        "commit",
        () =>
          createTransactionCommitReceipt(
            completion.promise,
            Promise.resolve(accepted),
          ),
      );
      const receipt = tx.commit();
      expect((await receipt.verdict).error).toBeUndefined();
      completion.reject(failure);
      await clock.settle();
      expect(reported.calls).toHaveLength(1);
      expect(reported.calls[0].args).toContain(failure);
      await expect(receipt.settled).rejects.toBe(failure);
      tx.abort("done");
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
});
