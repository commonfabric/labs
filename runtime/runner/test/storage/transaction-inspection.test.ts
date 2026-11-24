import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { toDocumentPath } from "@commonfabric/memory/v2";

import type {
  Activity,
  IAttestation,
  ITransactionJournal,
  MemorySpace,
} from "../../src/storage/interface.ts";
import { StoreObjectManager } from "../../src/storage/query.ts";
import {
  getTransactionReadDetails,
  getTransactionWrittenSpaces,
} from "../../src/storage/transaction-inspection.ts";
import { ManagedStorageTransaction } from "../../src/traverse.ts";

const space: MemorySpace = "did:key:z6Mk-transaction-inspection";
const otherSpace: MemorySpace = "did:key:z6Mk-transaction-inspection-other";

/**
 * A journal holding `history` for `space` alone and the activity stream
 * `activity`, for a transaction that keeps no native records of its own.
 */
function journalOf(
  history: IAttestation[],
  activity: Activity[] = [],
): ITransactionJournal {
  return {
    activity: () => activity,
    novelty: () => [],
    history: (asked) => asked === space ? history : [],
  };
}

describe("transaction-inspection", () => {
  // `ManagedStorageTransaction` keeps neither read details nor a write
  // attempt log, so each case reaches the journal the transaction holds.

  describe("getTransactionReadDetails()", () => {
    it("returns the journal's history in the asked space, each address naming the space", () => {
      const tx = new ManagedStorageTransaction(
        new StoreObjectManager(),
        journalOf([
          { address: { id: "of:a", path: ["value"] }, value: { n: 1 } },
          { address: { id: "of:b", path: ["value", "x"] }, value: 2 },
        ]),
      );

      expect([...getTransactionReadDetails(tx, space)]).toEqual([
        { address: { id: "of:a", path: ["value"], space }, value: { n: 1 } },
        { address: { id: "of:b", path: ["value", "x"], space }, value: 2 },
      ]);
      expect([...getTransactionReadDetails(tx, otherSpace)]).toEqual([]);
    });
  });

  describe("getTransactionWrittenSpaces()", () => {
    it("returns each space the journal's write activity names once, and none it only read", () => {
      const write = (inSpace: MemorySpace, id: `${string}:${string}`) => ({
        write: { space: inSpace, id, path: toDocumentPath(["value"]) },
      });
      const tx = new ManagedStorageTransaction(
        new StoreObjectManager(),
        journalOf([], [
          write(space, "of:a"),
          {
            read: {
              space: "did:key:z6Mk-only-read",
              id: "of:c",
              path: toDocumentPath(["value"]),
              meta: {},
            },
          },
          write(otherSpace, "of:b"),
          write(space, "of:d"),
        ]),
      );

      expect(getTransactionWrittenSpaces(tx)).toEqual([space, otherSpace]);
    });
  });
});
