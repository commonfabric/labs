import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  NativeStorageCommit,
  Result,
  StorageTransactionRejected,
  Unit,
} from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("memory-v2-commit-rejection");
const space = signer.did();
const type = "application/json" as const;

Deno.test("commitNative rejection is caught and surfaced as Result error", async () => {
  const storage = StorageManager.emulate({
    as: signer,
  });

  try {
    const provider = storage.open(space);
    const replica = provider.replica as typeof provider.replica & {
      commitNative(
        transaction: NativeStorageCommit,
        source?: unknown,
      ): Promise<Result<Unit, StorageTransactionRejected>>;
    };

    // Replace commitNative with one that rejects (throws)
    replica.commitNative = () =>
      Promise.reject(new Error("simulated storage crash"));

    const tx = storage.edit();
    const writeResult = tx.write({
      space,
      id: "of:memory-v2-commit-rejection",
      type,
      path: [],
    }, { value: { count: 1 } });
    assert(writeResult.ok);

    // commit() should resolve with an error result, NOT reject/throw
    const commitResult = await tx.commit().settled;
    assert(commitResult.error, "commit should return an error result");
    assertEquals(commitResult.error.name, "StoreError");

    // After commit completes (with error), the transaction should be "done",
    // so abort() should return an InactiveTransactionError
    const abortResult = tx.abort();
    assert(abortResult.error, "abort after failed commit should return error");
  } finally {
    await storage.close();
  }
});
