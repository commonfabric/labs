import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { TransactionCommitReceipt } from "@commonfabric/runner";
import { waitForMarkerCommit } from "../lib/multi-user-marker-commit.ts";

const failure = {
  error: {
    name: "StorageTransactionAborted" as const,
    message: "marker refused",
    reason: "test refusal",
  },
};

/** Supplies independently controlled stages with the receipt's required guard. */
function markerReceipt(
  verdict: TransactionCommitReceipt["verdict"],
  settled: TransactionCommitReceipt["settled"],
): TransactionCommitReceipt {
  return {
    verdict,
    settled,
    then(): never {
      throw new TypeError("Select a marker commit stage");
    },
  };
}

describe("multi-user-marker-commit", () => {
  describe("waitForMarkerCommit()", () => {
    it("reports a refused marker while repair remains pending", async () => {
      const repair = Promise.withResolvers<
        Awaited<TransactionCommitReceipt["settled"]>
      >();
      const receipt = markerReceipt(Promise.resolve(failure), repair.promise);
      let repairRequested = false;
      Object.defineProperty(receipt, "settled", {
        get() {
          repairRequested = true;
          return repair.promise;
        },
      });
      const announcement = waitForMarkerCommit("ready", receipt);
      const rejected = expect(announcement).rejects.toThrow(
        'Announcing marker "ready" failed: marker refused',
      );
      try {
        await receipt.verdict;
        await Promise.resolve();
        expect(repairRequested).toBe(false);
        await rejected;
      } finally {
        repair.resolve(failure);
      }
    });

    it("waits for accepted coverage before completing an announcement", async () => {
      const coverage = Promise.withResolvers<
        Awaited<TransactionCommitReceipt["settled"]>
      >();
      const receipt = markerReceipt(
        Promise.resolve({ ok: {} }),
        coverage.promise,
      );
      let completed = false;
      const announcement = waitForMarkerCommit("ready", receipt).then(() => {
        completed = true;
      });
      // The stage reader has run, but the accepted write has no coverage yet.
      await receipt.verdict;
      await Promise.resolve();
      expect(completed).toBe(false);
      coverage.resolve({ ok: {} });
      await announcement;
      expect(completed).toBe(true);
    });

    it("reports a settlement error after an accepted verdict", async () => {
      const receipt = markerReceipt(
        Promise.resolve({ ok: {} }),
        Promise.resolve(failure),
      );
      await expect(waitForMarkerCommit("ready", receipt)).rejects.toThrow(
        "marker refused",
      );
    });

    it("propagates an internal settlement exception", async () => {
      const receipt = markerReceipt(
        Promise.resolve({ ok: {} }),
        Promise.reject(new Error("coverage failed")),
      );
      await expect(waitForMarkerCommit("ready", receipt)).rejects.toThrow(
        "coverage failed",
      );
    });
  });
});
