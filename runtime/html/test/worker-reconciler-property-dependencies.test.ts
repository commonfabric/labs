import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";

const signer = await Identity.fromPassphrase("renderer property dependencies");
const space = signer.did();

describe("worker-reconciler-property-dependencies", () => {
  it("renders nested cell values in ordinary properties and updates on their edits", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    const ops: VDomOp[] = [];
    const reconciler = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
      },
    });
    try {
      const label = runtime.getCell<string>(space, "payload label", {
        type: "string",
      });
      const payload = runtime.getCell(space, "payload", {
        type: "object",
        properties: { label: { type: "string" } },
      });
      const root = runtime.getCell(space, "view", undefined);
      await runtime.editWithRetry((tx) => {
        label.withTx(tx).set("first");
        payload.withTx(tx).set({ label });
        root.withTx(tx).set({
          $UI: {
            type: "vnode",
            name: "div",
            props: { "@payload": payload },
            children: [],
          },
        });
      });
      reconciler.mount(root.asSchema(rendererVDOMSchema));
      await runtime.idle();
      await runtime.storageManager.synced();
      await runtime.idle();
      const propertyValues = () =>
        ops.flatMap((op) =>
          op.op === "set-prop" && op.key === "@payload" ? [op.value] : []
        );
      expect(propertyValues().at(-1)).toEqual({ label: "first" });
      ops.length = 0;
      await runtime.editWithRetry((tx) => label.withTx(tx).set("second"));
      await runtime.idle();
      expect(propertyValues().at(-1)).toEqual({ label: "second" });
    } finally {
      reconciler.unmount();
      await runtime.dispose();
    }
  });
});
