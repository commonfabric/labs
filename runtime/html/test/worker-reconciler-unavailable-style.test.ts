import { UNAVAILABLE_PENDING } from "@commonfabric/data-model/availability";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { WorkerProps } from "../src/worker/types.ts";

describe("WorkerReconciler unavailable style", () => {
  it("retains the usable style while pending and recovers on the same node", async () => {
    const signer = await Identity.fromPassphrase("unavailable style");
    const runtime = new Runtime({
      storageManager: StorageManager.emulate({ as: signer }),
      apiUrl: new URL("http://localhost"),
    });
    const ops: VDomOp[] = [];
    const reconciler = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
        return 0;
      },
    });
    const props = runtime.getCell<WorkerProps>(signer.did(), "style-props");
    const publish = async (
      style: { color: string } | typeof UNAVAILABLE_PENDING,
      title: string,
    ) => {
      const tx = runtime.edit();
      props.withTx(tx).setRawUntyped({ style, title });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).ok).toBeDefined();
      await runtime.idle();
      reconciler.flush();
    };
    let cancel: (() => void) | undefined;
    try {
      await publish({ color: "red" }, "Ready");
      cancel = reconciler.mount({
        type: "vnode",
        name: "div",
        props,
        children: [],
      });
      await runtime.idle();
      reconciler.flush();
      const styleOps = () =>
        ops.filter((op): op is Extract<VDomOp, { op: "set-prop" }> =>
          op.op === "set-prop" && op.key === "style"
        );
      expect(styleOps()).toHaveLength(1);
      expect(styleOps()[0]).toMatchObject({ value: "color: red" });
      const nodeId = styleOps()[0]!.nodeId;
      ops.length = 0;

      await publish(UNAVAILABLE_PENDING, "Waiting");
      expect(styleOps()).toEqual([]);
      expect(ops.filter((op) => op.op === "remove-prop" && op.key === "style"))
        .toEqual([]);
      expect(ops.filter((op) => op.op === "set-prop" && op.key === "title"))
        .toEqual([{ op: "set-prop", nodeId, key: "title", value: "Waiting" }]);
      expect(
        ops.filter((op) =>
          op.op === "create-element" || op.op === "remove-node"
        ),
      )
        .toEqual([]);
      ops.length = 0;

      await publish(UNAVAILABLE_PENDING, "Waiting");
      expect(ops.filter((op) => op.op === "set-prop"))
        .toEqual([]);
      ops.length = 0;

      await publish({ color: "blue" }, "Waiting");
      expect(styleOps()).toEqual([
        { op: "set-prop", nodeId, key: "style", value: "color: blue" },
      ]);
      expect(
        ops.filter((op) =>
          op.op === "create-element" || op.op === "remove-node"
        ),
      )
        .toEqual([]);
    } finally {
      cancel?.();
      await runtime.dispose();
    }
  });
});
