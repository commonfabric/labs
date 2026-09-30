import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("query-result-array-iteration");

describe("createQueryResultProxy()", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  it("iterates the same rows reported by length and indexed reads", async () => {
    const seed = runtime.edit();
    const cell = runtime.getCell<number[]>(
      signer.did(),
      "rows",
      undefined,
      seed,
    );
    cell.set([3, 5, 8]);
    expect((await seed.commit()).error).toBeUndefined();
    const tx = runtime.edit();
    try {
      const rows = createQueryResultProxy<number[]>(
        runtime,
        tx,
        cell.getAsNormalizedFullLink(),
        0,
      );
      expect(rows.length).toBe(3);
      expect(rows[0]).toBe(3);
      const iterated: number[] = [];
      for (const row of rows) iterated.push(row);
      expect(iterated).toEqual([3, 5, 8]);
      expect(Array.from(rows)).toEqual([3, 5, 8]);
      expect(rows.map((row) => row * 2)).toEqual([6, 10, 16]);
    } finally {
      tx.abort();
    }
  });
});
