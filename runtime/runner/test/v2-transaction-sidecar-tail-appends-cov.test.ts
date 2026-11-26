/**
 * The commit-time claim check on a stream sidecar that took a tail append
 * after a transaction read and marked one of its entries.
 *
 * The store writes the sidecar here, as a serving host's commits do, so the
 * transaction's replica learns of the append from the store's fan-out. The
 * store refuses an authored write into a sidecar, so a commit the claim check
 * admits is still refused; what tells the cases apart is whether the refusal
 * is the claim check's own `StorageTransactionInconsistent`.
 */

import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
import { describe, it } from "@commonfabric/test-support/test";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type {
  IMemorySpaceAddress,
  IStorageTransaction,
  URI,
} from "../src/storage/interface.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("v2-transaction-sidecar-tail");
const space = signer.did();
const type = "application/json" as const;

/**
 * Stores the sidecar `id` holding one entry, opens a transaction that reads
 * that entry and has `mark` write to it, stores a second entry appended to
 * the log, and returns the name of the error the transaction's commit
 * settled with.
 */
const commitAfterAppend = async (
  id: URI,
  mark: (tx: IStorageTransaction, entry: IMemorySpaceAddress) => void,
): Promise<string | undefined> => {
  await using cleanup = new AsyncDisposableStack();
  const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
  cleanup.defer(() => server.close());
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  cleanup.defer(() => storage.close());
  const store = (entries: FabricValue[]) =>
    server.writeDocument(space, id, { entries });

  await store([{ eventId: "first" }]);
  expect(
    (await storage.open(space).sync(id, { path: [], schema: true })).error,
  )
    .toBeUndefined();
  const entry = { space, id, type, path: ["value", "entries", "0"] };
  const tx = storage.edit();
  expect(tx.read(entry).ok?.value).toEqual({ eventId: "first" });
  mark(tx, entry);

  await store([{ eventId: "first" }, { eventId: "second" }]);
  await server.flushSessions([space]);
  await storage.open(space).pullToServerHead?.();
  expect(
    storage.edit().read({ ...entry, path: ["value", "entries"] }).ok?.value,
  ).toEqual([{ eventId: "first" }, { eventId: "second" }]);

  return (await tx.commit().settled).error?.name;
};

const markConsequenced = (
  tx: IStorageTransaction,
  entry: IMemorySpaceAddress,
) => {
  expect(tx.write({ ...entry, path: [...entry.path, "consequenced"] }, true).ok)
    .toBeTruthy();
};

describe("v2-transaction", () => {
  describe("commit() over a stream sidecar that took a tail append", () => {
    it("passes the claim check for a mark written as a patch on an entry the transaction held", async () => {
      const name = await commitAfterAppend(
        "of:stream-events:tail-patch" as URI,
        markConsequenced,
      );

      expect(name).toBeDefined();
      expect(name).not.toBe("StorageTransactionInconsistent");
    });

    it("refuses the same mark written as a whole document as inconsistent", async () => {
      const name = await commitAfterAppend(
        "of:stream-events:tail-whole" as URI,
        (tx, entry) => {
          tx.markWholeDocumentWrites!();
          markConsequenced(tx, entry);
        },
      );

      expect(name).toBe("StorageTransactionInconsistent");
    });

    it("refuses the mark beside a mergeable op as inconsistent", async () => {
      const name = await commitAfterAppend(
        "of:stream-events:tail-mergeable" as URI,
        (tx, entry) => {
          markConsequenced(tx, entry);
          const hits = { ...entry, path: [...entry.path, "hits"] };
          expect(tx.write(hits, 1).ok).toBeTruthy();
          tx.recordMergeableOp!(hits, { op: "increment", by: 1 });
        },
      );

      expect(name).toBe("StorageTransactionInconsistent");
    });

    it("refuses the mark as inconsistent on a document that is not a stream sidecar", async () => {
      const name = await commitAfterAppend(
        "of:not-a-sidecar-tail" as URI,
        markConsequenced,
      );

      expect(name).toBe("StorageTransactionInconsistent");
    });
  });
});
