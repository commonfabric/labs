import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime, type VNode } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { VDomOp } from "../src/vdom-ops.ts";

type SyncCall = {
  id: string;
  path: string[];
};

type RenderResult = {
  syncCalls: SyncCall[];
  updateOps: VDomOp[];
};

async function renderAndCollect(
  settle: () => Promise<void>,
  vnode: VNode,
  update?: (rootCell: Cell<VNode>, runtime: Runtime) => Promise<void>,
): Promise<RenderResult> {
  const signer = await Identity.fromPassphrase(
    "worker reconciler sync regression",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const syncCalls: SyncCall[] = [];
  const originalSyncCell = storageManager.syncCell.bind(storageManager);
  storageManager.syncCell = async function <T>(
    cell: Cell<T>,
  ): Promise<Cell<T>> {
    const { id, path } = cell.getAsNormalizedFullLink();
    syncCalls.push({ id, path: path.map(String) });
    return await originalSyncCell(cell);
  };

  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const tx = runtime.edit();
  const rootCell = runtime.getCell<VNode>(
    signer.did(),
    "worker-reconciler-sync-root",
    undefined,
    tx,
  );
  rootCell.set(vnode);
  await tx.commit().settled;
  syncCalls.length = 0;

  const updateOps: VDomOp[] = [];
  const reconciler = new WorkerReconciler({
    onOps: (ops) => {
      for (const op of ops) updateOps.push(op);
    },
  });
  const cancel = reconciler.mount(
    rootCell.asSchema(rendererVDOMSchema) as Cell<never>,
  );
  try {
    await settle();
    if (update !== undefined) {
      updateOps.length = 0;
      await update(rootCell, runtime);
      await settle();
    }
    return { syncCalls, updateOps };
  } finally {
    cancel();
    await runtime.dispose();
  }
}

Deno.test(
  "worker reconciler preserves sync state across VDOM asCell cuts",
  async (t) => {
    const { syncCalls } = await renderAndCollect(t.settle, {
      type: "vnode",
      name: "main",
      props: {},
      children: [{
        type: "vnode",
        name: "section",
        props: {},
        children: [{
          type: "vnode",
          name: "span",
          props: {},
          children: ["leaf"],
        }],
      }],
    });

    assertEquals(
      syncCalls.length,
      1,
      `Expected only the mounted root to sync, got ${
        JSON.stringify(syncCalls)
      }`,
    );
    assertEquals(syncCalls[0]?.path, []);
  },
);

Deno.test(
  "worker reconciler reuses VDOM schema coverage for style objects",
  async (t) => {
    const { syncCalls, updateOps } = await renderAndCollect(
      t.settle,
      {
        type: "vnode",
        name: "div",
        props: { style: { color: "red" } },
        children: [],
      },
      async (rootCell, runtime) => {
        const tx = runtime.edit();
        rootCell.withTx(tx).key("props", "style", "color").set("blue");
        await tx.commit().settled;
      },
    );

    assertEquals(
      syncCalls.length,
      1,
      `Expected style to reuse the root query, got ${
        JSON.stringify(syncCalls)
      }`,
    );
    assertEquals(syncCalls[0]?.path, []);
    assertEquals(
      updateOps.flatMap((op) =>
        op.op === "set-prop" && op.key === "style" ? [op.value] : []
      ),
      ["color: blue"],
    );
  },
);
