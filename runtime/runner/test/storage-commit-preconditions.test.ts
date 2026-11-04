import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import {
  resetCommitPreconditionsConfig,
  setCommitPreconditionsConfig,
} from "@commonfabric/memory/v2";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type {
  IStorageTransaction,
  NativeStorageCommit,
  Result,
  StorageTransactionRejected,
  Unit,
} from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("storage-commit-preconditions");
const space = signer.did();

const captureNativeDrafts = () => {
  const storage = StorageManager.emulate({
    as: signer,
  });
  const provider = storage.open(space);
  const replica = provider.replica as typeof provider.replica & {
    commitNative(
      transaction: NativeStorageCommit,
      source?: unknown,
    ): Promise<Result<Unit, StorageTransactionRejected>>;
  };
  const originalCommitNative = replica.commitNative?.bind(replica);
  assertExists(originalCommitNative);

  const drafts: NativeStorageCommit[] = [];
  replica.commitNative = async (transaction, source) => {
    drafts.push(structuredClone(transaction));
    return await originalCommitNative(transaction, source);
  };

  return { storage, drafts };
};

Deno.test("precondition-only transactions send and validate their commit", async () => {
  setCommitPreconditionsConfig(true);
  const { storage, drafts } = captureNativeDrafts();

  try {
    // A transaction whose only staged work is an origin-committed
    // precondition must still send a commit: silently resolving ok would
    // drop the lineage gate.
    const tx = storage.edit();
    tx.addCommitPrecondition?.(space, {
      kind: "origin-committed",
      originLocalSeq: 99,
    });
    const result = await tx.commit().settled;

    assertEquals(drafts.length, 1);
    assertEquals(drafts[0].operations, []);
    assertEquals(drafts[0].preconditions, [{
      kind: "origin-committed",
      originLocalSeq: 99,
    }]);
    // The referenced origin never committed, so the engine must reject.
    assert(result.error, "missing-origin precondition must reject the commit");
  } finally {
    resetCommitPreconditionsConfig();
    await storage.close();
  }
});

Deno.test("extended transaction refuses preconditions the storage cannot enforce", () => {
  // The wrapper must fail closed: silently ignoring a gating precondition
  // because the inner transaction does not support it would let a
  // descendant of an unconfirmed origin commit ungated.
  const innerWithoutSupport = {} as IStorageTransaction;
  const tx = new ExtendedStorageTransaction(innerWithoutSupport);
  assertThrows(
    () =>
      tx.addCommitPrecondition(space, {
        kind: "origin-committed",
        originLocalSeq: 1,
      }),
    Error,
    "does not support",
  );
});

Deno.test("extended transaction refuses create-only marks the storage cannot enforce", () => {
  // Same fail-closed posture as addCommitPrecondition above: a create-only
  // mark is a commit gate — the exactly-once witness for event receipts and
  // single-use grant consumption — so a wrapper that swallowed it over an
  // inner transaction without markCreateOnly would let a duplicate commit
  // through unguarded (cubic P1 on #4649).
  const innerWithoutSupport = {} as IStorageTransaction;
  const tx = new ExtendedStorageTransaction(innerWithoutSupport);
  assertThrows(
    () => tx.markCreateOnly({ space, id: "of:receipt-probe" }),
    Error,
    "does not support",
  );
});
