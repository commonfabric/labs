import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { describe, it } from "@commonfabric/test-support/test";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

// A transaction's read and write activity is consumed while it is open: the
// scheduler takes the reactivity log when the action that opened the
// transaction finishes, and the commit path takes the write details before the
// result is known. Holding that activity past a completed commit pins every
// address the transaction touched, so anything that keeps the transaction — a
// cell bound to it, a cleanup closure that captured it — keeps those too. A
// list projecting a window that moves opens one transaction per move, so this
// is the difference between a bounded working set and one that grows with
// every page turn.
//
// A transaction that never reached storage is the other case. The scheduler
// re-establishes an action's dependencies from the reads of the transaction it
// aborted or had rejected, and retries the action; releasing those would leave
// it with no dependencies and nothing to wake it.

const signer = await Identity.fromPassphrase("storage transaction completion");
const space = signer.did();

describe("a completed storage transaction", () => {
  it("releases its activity once its commit completes", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const cell = runtime.getCell<{ value: number }>(
        space,
        "transaction-completion",
        undefined,
      );
      const tx = runtime.edit();
      cell.withTx(tx).set({ value: 1 });
      cell.withTx(tx).get();
      expect(tx.getReactivityLog().writes.length).toBeGreaterThan(0);

      const result = await tx.commit().settled;
      expect(result.error).toBeUndefined();

      const completed = tx.getReactivityLog();
      expect(completed.reads.length).toBe(0);
      expect(completed.writes.length).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps the activity of a commit rejected before it reached storage", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const cell = runtime.getCell<{ value: number }>(
        space,
        "transaction-completion-rejected",
        undefined,
      );
      const seed = runtime.edit();
      cell.withTx(seed).set({ value: 0 });
      await seed.commit().settled;

      // Two transactions read and write the same document. The second one is
      // rejected: the document moved underneath it.
      const first = runtime.edit();
      const second = runtime.edit();
      cell.withTx(first).get();
      cell.withTx(first).set({ value: 1 });
      cell.withTx(second).get();
      cell.withTx(second).set({ value: 2 });

      expect((await first.commit().settled).error).toBeUndefined();
      const rejected = await second.commit().settled;
      expect(rejected.error?.name).toBe("StorageTransactionInconsistent");

      const completed = second.getReactivityLog();
      expect(completed.reads.length).toBeGreaterThan(0);
      expect(completed.writes.length).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps the activity of a transaction it aborted", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const cell = runtime.getCell<{ value: number }>(
        space,
        "transaction-completion-abort",
        undefined,
      );
      const tx = runtime.edit();
      cell.withTx(tx).set({ value: 1 });
      cell.withTx(tx).get();

      tx.abort("test");

      const completed = tx.getReactivityLog();
      expect(completed.reads.length).toBeGreaterThan(0);
      expect(completed.writes.length).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
