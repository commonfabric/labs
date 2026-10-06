import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { readOnlyCfcView } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("runner-cfc-tx-state-contracts");

describe("CFC tx state contracts", () => {
  // Contracts of the transaction's CFC control surface that no other suite pins
  // directly: the flow-labels anti-downgrade pin, the write-once sink ceiling,
  // late-activity invalidation of a prepared transaction, and the diagnostics
  // seams. All are part of the audit-S3 posture the read-only state view
  // (#4517) completes.

  const withTx = async (
    fn: (runtime: Runtime, tx: ExtendedStorageTransaction) => Promise<void>,
  ) => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The strengthen-after-prepare test raises each of these modes a rung
      // and asserts the prepared digest turns from "prepared" to
      // "invalidated". That transition needs the transaction to start on a
      // rung below the top of each ladder.
      cfcFlowLabels: "off",
      cfcWriteFloor: "off",
    });
    try {
      await fn(runtime, runtime.edit() as ExtendedStorageTransaction);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  };

  it("the flow-labels persist pin cannot be weakened mid-transaction", async () => {
    await withTx(async (_runtime, tx) => {
      tx.setCfcFlowLabelsMode("persist");
      expect(() => tx.setCfcFlowLabelsMode("observe")).toThrow(
        "cannot be weakened",
      );
      expect(() => tx.setCfcFlowLabelsMode("off")).toThrow(
        "cannot be weakened",
      );
      // Re-asserting persist is fine.
      tx.setCfcFlowLabelsMode("persist");
      expect(tx.getCfcState().flowLabelsMode).toBe("persist");
      await tx.commit().settled;
    });
  });

  it("the sink confidentiality ceiling is write-once (a later call is ignored)", async () => {
    // The Runtime establishes the ceiling at tx creation; code holding a
    // Cell must not be able to relax it afterwards.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      tx.setCfcSinkMaxConfidentiality({ fetchJson: ["anything"] });
      expect(tx.getCfcState().sinkMaxConfidentiality).toEqual({
        fetchJson: [],
      });
      await tx.commit().settled;
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("late trigger reads and writes invalidate a prepared transaction; reasons accumulate", async () => {
    await withTx(async (runtime, tx) => {
      runtime.getCell(signer.did(), "tx-contracts-out", undefined, tx).set({
        v: 1,
      });
      tx.prepareCfc();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      // Trigger reads arriving after prepare invalidate the digest.
      tx.addCfcTriggerReads([{
        space: signer.did(),
        id: "of:tx-contracts-late" as `${string}:${string}`,
        type: "application/json",
        path: ["value"],
      }]);
      const prepare = tx.getCfcState().prepare;
      expect(prepare.status).toBe("invalidated");
      expect(
        (prepare as { status: string; reasons: readonly string[] }).reasons,
      ).toContainEqual("trigger-reads-after-prepare");
      // A second invalidation appends to the existing reasons rather than
      // replacing them.
      tx.invalidateCfc("test-second-reason");
      expect(
        (tx.getCfcState().prepare as {
          status: string;
          reasons: readonly string[];
        }).reasons,
      ).toEqual(["trigger-reads-after-prepare", "test-second-reason"]);
      await tx.commit().settled;
    });
  });

  it("strengthening the flow-labels or write-floor mode after prepare invalidates", async () => {
    // Both modes drive prepareBoundaryCommit but are absent from
    // PreparedDigestInput, so a strengthen-after-prepare must invalidate the
    // prepared decision — otherwise the stale (weaker) decision survives the
    // commit-time digest recheck while the tx reports the stronger mode
    // (review of #4566, same class as the policy-evaluation setter). A no-op
    // re-set of the same mode does not invalidate.
    await withTx(async (runtime, tx) => {
      runtime.getCell(signer.did(), "tx-contracts-flow", undefined, tx).set({
        v: 1,
      });
      tx.prepareCfc();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      tx.setCfcFlowLabelsMode("off"); // no change from the pinned off → no-op
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      tx.setCfcFlowLabelsMode("observe"); // real change → invalidate
      const flow = tx.getCfcState().prepare;
      expect(flow.status).toBe("invalidated");
      expect(
        (flow as { status: string; reasons: readonly string[] }).reasons,
      ).toContainEqual("flow-labels-mode-changed");
      await tx.commit().settled;
    });

    await withTx(async (runtime, tx) => {
      runtime.getCell(signer.did(), "tx-contracts-floor", undefined, tx).set({
        v: 1,
      });
      tx.prepareCfc();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      tx.setCfcWriteFloorMode("off"); // no change → no-op
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      tx.setCfcWriteFloorMode("enforce"); // strengthen → invalidate
      const floor = tx.getCfcState().prepare;
      expect(floor.status).toBe("invalidated");
      expect(
        (floor as { status: string; reasons: readonly string[] }).reasons,
      ).toContainEqual("write-floor-mode-changed");
      await tx.commit().settled;
    });
  });

  it("a write after prepare invalidates the prepared digest", async () => {
    await withTx(async (runtime, tx) => {
      const cell = runtime.getCell(
        signer.did(),
        "tx-contracts-write-late",
        undefined,
        tx,
      );
      cell.set({ v: 1 });
      const id = cell.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      // Read-free write (cell.set journals a read first, which would
      // invalidate as read-after-prepare before the write is seen).
      tx.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id,
        path: [],
      }, { value: { v: 2 } });
      const prepare = tx.getCfcState().prepare;
      expect(prepare.status).toBe("invalidated");
      expect(
        (prepare as { status: string; reasons: readonly string[] }).reasons,
      ).toContainEqual("write-after-prepare");
      await tx.commit().settled;
    });
  });

  it("the read-only view closes the descriptor and Map-iteration bypasses", () => {
    // Cubic round-3 findings on #4517: without a getOwnPropertyDescriptor
    // trap, `Object.getOwnPropertyDescriptor(view, k).value` recovers the
    // raw nested object; and Map read APIs (forEach's third argument,
    // get/entries/values results) leaked the mutable backing map and its
    // values.
    const backing = {
      arr: [{ n: 1 }],
      map: new Map<object, { id: string }>([[{ k: 1 }, { id: "x" }]]),
      nested: { flag: true },
    };
    const view = readOnlyCfcView(backing);
    // Descriptor values are re-wrapped, through both Object and Reflect.
    const desc = Object.getOwnPropertyDescriptor(view, "arr")!;
    expect(() => (desc.value as unknown[]).push(0)).toThrow("read-only");
    expect(() => {
      (desc.value as { n: number }[])[0].n = 2;
    }).toThrow("read-only");
    const rdesc = Reflect.getOwnPropertyDescriptor(view, "nested")!;
    expect(() => {
      (rdesc.value as { flag: boolean }).flag = false;
    }).toThrow("read-only");
    // Map.forEach receives the view as its third argument, not the backing
    // map; values arrive wrapped.
    let visited = 0;
    view.map.forEach((v, _k, m) => {
      visited++;
      expect(() => (m as Map<object, object>).clear()).toThrow("read-only");
      expect(() => {
        (v as { id: string }).id = "y";
      }).toThrow("read-only");
    });
    expect(visited).toBe(1);
    // get/entries/values results are wrapped; keys keep reference identity.
    for (const [k, v] of view.map) {
      expect(() => {
        (v as { id: string }).id = "y";
      }).toThrow("read-only");
      expect(view.map.get(k)).toBeDefined();
      expect(() => {
        (view.map.get(k) as { id: string }).id = "y";
      }).toThrow("read-only");
    }
    for (const v of view.map.values()) {
      expect(() => {
        (v as { id: string }).id = "y";
      }).toThrow("read-only");
    }
    // The backing state never moved.
    expect(backing.arr.length).toBe(1);
    expect(backing.arr[0].n).toBe(1);
    expect(backing.map.size).toBe(1);
    expect([...backing.map.values()][0].id).toBe("x");
    expect(backing.nested.flag).toBe(true);
  });

  it("noteCfcSinkReleaseReject lands in diagnostics", async () => {
    await withTx(async (_runtime, tx) => {
      tx.noteCfcSinkReleaseReject({
        sink: "fetchJson",
        effectId: "fetchJson:tx-contracts",
        detail: "test-detail",
      });
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          d.includes("fetchJson:tx-contracts") && d.includes("test-detail")
        ),
      ).toBe(true);
      await tx.commit().settled;
    });
  });
});
