import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import { ManagedStorageTransaction } from "../src/traverse.ts";

const SPACE = "did:key:zManagedTx" as MemorySpace;

const ADDRESS: IMemorySpaceAddress = {
  space: SPACE,
  id: "of:managed-tx-doc",
  type: "application/json",
  path: ["value"],
};

const newTransaction = () =>
  new ManagedStorageTransaction({ load: () => null });

describe("ManagedStorageTransaction", () => {
  describe("instance members", () => {
    describe("isReadOnly()", () => {
      it("returns `false` for a new transaction", () => {
        expect(newTransaction().isReadOnly()).toBe(false);
      });

      it("returns `true` after `setReadOnly()` and `false` again after `clearReadOnly()`", () => {
        const tx = newTransaction();
        tx.setReadOnly();
        expect(tx.isReadOnly()).toBe(true);
        tx.clearReadOnly();
        expect(tx.isReadOnly()).toBe(false);
      });
    });

    describe("status()", () => {
      it("returns `ready` with a journal that has recorded nothing", () => {
        const { status, journal } = newTransaction().status();
        expect(status).toBe("ready");
        expect([...journal.activity()]).toEqual([]);
        expect([...journal.novelty(SPACE)]).toEqual([]);
        expect([...journal.history(SPACE)]).toEqual([]);
      });
    });

    describe("write(), abort() and commit()", () => {
      // The transaction only serves reads for query traversal, so the three
      // mutating methods have no implementation. Marked read-only, each
      // refuses with the error a read-only transaction raises instead, naming
      // the method and what made the transaction read-only.

      const calls = {
        "write()": (tx: ManagedStorageTransaction) => tx.write(ADDRESS, 1),
        "abort()": (tx: ManagedStorageTransaction) => tx.abort(),
        "commit()": (tx: ManagedStorageTransaction) => tx.commit(),
      };

      for (const [method, call] of Object.entries(calls)) {
        it(`\`${method}\` throws that it is not implemented on a writable transaction`, () => {
          expect(() => call(newTransaction())).toThrow(
            "Method not implemented.",
          );
        });

        it(`\`${method}\` throws a read-only error naming the default source`, () => {
          const tx = newTransaction();
          tx.setReadOnly();
          let thrown: unknown;
          try {
            call(tx);
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toMatchObject({
            name: "ReadOnlyTransactionError",
            message: expect.stringContaining(
              `Cannot call ${method} on a read-only transaction returned by ` +
                "runtime.readTx()",
            ),
          });
        });

        it(`\`${method}\` throws a read-only error naming the source it was given`, () => {
          const tx = newTransaction();
          tx.setReadOnly("a test reader");
          expect(() => call(tx)).toThrow("returned by a test reader");
        });
      }
    });
  });
});
