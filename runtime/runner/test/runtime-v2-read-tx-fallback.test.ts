import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("runtime-v2-read-tx-fallback");
const space = signer.did();

describe("Runtime v2 read transaction fallback", () => {
  it("creates a fresh read transaction for repeated reads", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    let editCalls = 0;
    const instrumented = storageManager as typeof storageManager & {
      edit: typeof storageManager.edit;
    };
    const originalEdit = storageManager.edit.bind(storageManager);
    instrumented.edit = () => {
      editCalls += 1;
      return originalEdit();
    };

    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    try {
      const seed = runtime.edit();
      const cell = runtime.getCell(
        space,
        "runtime-v2-fresh-read-tx",
        { type: "number" } as const,
        seed,
      );
      cell.set(42);
      await seed.commit().settled;

      const baseline = editCalls;
      expect(cell.get()).toBe(42);
      expect(cell.get()).toBe(42);
      expect(cell.get()).toBe(42);
      expect(editCalls - baseline).toBe(3);
    } finally {
      await runtime.dispose();
    }
  });

  it("uses a fresh read transaction for top-level query result proxy reads when no tx is provided", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    try {
      const seed = runtime.edit();
      const cell = runtime.getCell(
        space,
        "runtime-v2-query-result-proxy-read",
        { type: "number" } as const,
        seed,
      );
      cell.set(1);
      await seed.commit().settled;

      const staleTx = runtime.edit();
      expect(cell.withTx(staleTx).get()).toBe(1);

      const update = runtime.edit();
      cell.withTx(update).set(2);
      await update.commit().settled;
      expect(cell.withTx(staleTx).get()).toBe(1);

      const freshTx = runtime.edit();
      const instrumented = runtime as Runtime & {
        readTx: typeof runtime.readTx;
        edit: typeof runtime.edit;
      };
      const originalReadTx = instrumented.readTx;
      const originalEdit = instrumented.edit;
      instrumented.readTx = () => staleTx;
      instrumented.edit = () => freshTx;

      try {
        expect(
          createQueryResultProxy<number>(
            runtime,
            undefined,
            cell.getAsNormalizedFullLink(),
          ),
        ).toBe(2);
      } finally {
        instrumented.readTx = originalReadTx;
        instrumented.edit = originalEdit;
        staleTx.abort();
        freshTx.abort();
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("returns fresh read-only fallback transactions", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    try {
      const seed = runtime.edit();
      const cell = runtime.getCell(
        space,
        "runtime-v2-read-only-fallback-read",
        { type: "number" } as const,
        seed,
      );
      cell.set(3);
      await seed.commit().settled;

      const readTx1 = runtime.readTx();
      const readTx2 = runtime.readTx();

      expect(readTx1).not.toBe(readTx2);
      expect(cell.withTx(readTx1).get()).toBe(3);
      expect(cell.withTx(readTx2).get()).toBe(3);
      expect(() => readTx1.writeValueOrThrow(cell.getAsNormalizedFullLink(), 4))
        .toThrow(/runtime\.edit\(\)/);
      expect(() =>
        readTx1.tx.write(
          toMemorySpaceAddress(cell.getAsNormalizedFullLink()),
          4,
        )
      )
        .toThrow(/runtime\.edit\(\)/);
      expect(() => readTx1.abort()).toThrow(/runtime\.edit\(\)/);
      await expect(readTx1.commit().settled).resolves.toEqual({ ok: {} });

      const readTx3 = runtime.readTx();
      await expect(readTx3.tx.commit().settled).rejects.toThrow(
        /runtime\.edit\(\)/,
      );
    } finally {
      await runtime.dispose();
    }
  });
});
