/**
 * Regression tests for `$alias` records reaching the worker reconciler as
 * child content.
 *
 * `$alias` records are Pattern-binding vocabulary; in data they are inert
 * plain values (PR #4895). The old unresolved-alias special case rendered
 * them as empty text; now the reconciler warns and JSON-renders them like
 * any other unexpected object.
 */

import { assertEquals } from "@std/assert";

import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import type { Cell } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { WorkerRenderNode, WorkerVNode } from "../src/worker/types.ts";

/**
 * Helper to collect ops emitted by the reconciler.
 */
function createOpsCollector() {
  const allOps: VDomOp[] = [];
  return {
    onOps: (ops: VDomOp[]) => {
      for (const op of ops) allOps.push(op);
    },
    getOps: () => allOps,
    clear: () => {
      allOps.length = 0;
    },
    hasOp: (opType: string) => allOps.some((op) => op.op === opType),
    getOpsOfType: (opType: string) => allOps.filter((op) => op.op === opType),
  };
}

Deno.test("worker reconciler - $alias records in child position", async (t) => {
  // Setup minimal runtime to get CellImpl
  const signer = await Identity.fromPassphrase("test reconciler alias child");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });

  // Get CellImpl constructor
  const dummyTx = runtime.edit();
  const dummyCell = runtime.getCell(signer.did(), "dummy", undefined, dummyTx);
  const CellImplConstructor = dummyCell.constructor;

  // Define MockCell extending CellImpl
  class MockCell extends (CellImplConstructor as any) {
    #subscribers = new Set<(value: any) => void>();

    constructor(public value: any) {
      // CellImpl(runtime, tx, link, synced, causeContainer, kind)
      super(runtime, undefined, undefined, false, undefined, "cell");
      this.value = value;
    }

    sink(callback: (value: any) => void) {
      this.#subscribers.add(callback);
      callback(this.value);
      return () => {
        this.#subscribers.delete(callback);
      };
    }

    set(newValue: any) {
      this.value = newValue;
      for (const sub of this.#subscribers) {
        sub(newValue);
      }
    }

    isStream() {
      return false;
    }
  }

  await t.step(
    "JSON-renders a $alias-shaped child with a warning instead of empty text",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const aliasRecord = { $alias: { path: ["x"] } };
      const rootCell = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [aliasRecord as unknown as WorkerRenderNode],
        } satisfies WorkerVNode,
      );

      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      let cancel: (() => void) | undefined;
      try {
        cancel = reconciler.mount(rootCell as unknown as Cell<unknown>);
        await t.settle();

        const textOps = collector.getOpsOfType("create-text");
        assertEquals(
          textOps.some((op) =>
            "text" in op && op.text === JSON.stringify(aliasRecord)
          ),
          true,
          "$alias child should render its JSON serialization",
        );
        assertEquals(
          textOps.some((op) => "text" in op && op.text === ""),
          false,
          "$alias child must not render as empty text (the old unresolved-alias special case)",
        );
        assertEquals(
          warnings.length >= 1,
          true,
          "should warn about the unexpected object",
        );
      } finally {
        console.warn = originalWarn;
        cancel?.();
      }
    },
  );

  await dummyTx.commit();
});
