import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("start-commit");

describe("start-commit", () => {
  for (const wrapped of [false, true]) {
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
        const committing = wrapped
          ? new TransactionWrapper(new TransactionWrapper(tx))
          : tx;
        const receipt = committing.startCommit();
        settlement = receipt.settled;
        expect(receipt).not.toHaveProperty("then");
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

  for (const wrapped of [false, true]) {
    it(`reports the verdict before coverage and inline effects with wrapped=${wrapped}`, async () => {
      const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      const releaseEffect = Promise.withResolvers<void>();
      const effectEntered = Promise.withResolvers<void>();
      let settlement: Promise<unknown> | undefined;
      try {
        const cell = runtime.getCell<number>(signer.did(), "commit-stages");
        const seed = runtime.edit();
        cell.withTx(seed).set(1);
        expect((await seed.commit({ resolveAt: "verdict" })).error)
          .toBeUndefined();
        await cell.sync();
        const tx = runtime.edit();
        cell.withTx(tx).set(2);
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
        const committing = wrapped
          ? new TransactionWrapper(new TransactionWrapper(tx))
          : tx;
        const receipt = committing.startCommit();
        let settled = false;
        settlement = receipt.settled.then((result) => {
          settled = true;
          return result;
        });
        expect((await receipt.verdict).error).toBeUndefined();
        await effectEntered.promise;
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
      const original = tx.startCommit();
      for (
        const receipt of [
          tx.startCommit(),
          new TransactionWrapper(tx).startCommit(),
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
          tx.startCommit(),
          new TransactionWrapper(tx).startCommit(),
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
      const receipt = aborted.startCommit();
      expect((await receipt.verdict).error?.name).toBe(
        "StorageTransactionAborted",
      );
      expect((await receipt.settled).error?.name).toBe(
        "StorageTransactionAborted",
      );
      const empty = runtime.edit().startCommit();
      expect((await empty.verdict).error).toBeUndefined();
      expect((await empty.settled).error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  it("preserves internal rejection when only settlement is observed", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const tx = runtime.edit();
      const failure = new Error("internal commit failure");
      using _commit = stub(tx, "commit", () => Promise.reject(failure));
      const receipt = new TransactionWrapper(tx).startCommit();
      await expect(receipt.settled).rejects.toBe(failure);
      await clock.settle();
      tx.abort("done");
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
});
