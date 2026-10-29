/**
 * Regression tests for worker reconciler root diffing.
 *
 * These tests verify that when a Cell<VNode> emits a new value with the same
 * element type, the reconciler updates in place instead of destroying and
 * recreating the DOM node.
 *
 * Bug: Modal flicker when opening because reconcileIntoWrapper
 * unconditionally destroyed and recreated the entire UI tree.
 */

import { assertEquals } from "@std/assert";

// Import the actual Cell implementation to create test cells
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import type { Cell, IExtendedStorageTransaction } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { WorkerRenderNode, WorkerVNode } from "../src/worker/types.ts";

const signer = await Identity.fromPassphrase("test reconciler diffing");
const space = signer.did();

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

Deno.test("worker reconciler diffing - same tag updates in place", async (t) => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  let tx: IExtendedStorageTransaction = runtime.edit();

  try {
    await t.step(
      "when Cell emits new VNode with same tag, no remove-node op is emitted",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        // Create a Cell using runtime.getCell (proper way to create linked cells)
        const vnodeCell = runtime.getCell<WorkerVNode>(
          space,
          "test-vnode-same-tag",
          undefined,
          tx,
        );

        // Set initial value and commit to trigger reactivity
        vnodeCell.set({
          type: "vnode",
          name: "div",
          props: { id: "test-div", className: "initial" },
          children: ["Hello"],
        } as WorkerVNode);
        await tx.commit().settled;
        tx = runtime.edit();

        // Mount the cell
        const cancel = reconciler.mount(vnodeCell as Cell<WorkerVNode>);

        // Wait for reactivity and ops to flush
        await runtime.idle();

        // Verify initial render created an element
        const createOps = collector.getOpsOfType("create-element");
        assertEquals(createOps.length, 1, "Should create one element");
        assertEquals(
          (createOps[0] as { tagName: string }).tagName,
          "div",
          "Should create a div",
        );

        // Clear ops to track only update ops
        collector.clear();

        // Update the Cell with a new VNode that has the SAME tag
        vnodeCell.withTx(tx).set({
          type: "vnode",
          name: "div", // Same tag!
          props: { id: "test-div", className: "updated" },
          children: ["Updated"],
        } as WorkerVNode);
        await tx.commit().settled;
        tx = runtime.edit();

        // Wait for reactivity to propagate
        await runtime.idle();

        // The root element (nodeId 1) should NOT be removed.
        // Text children may be removed/recreated when content changes - that's fine.
        // The key fix is that the ROOT ELEMENT stays in place.
        const removeOps = collector.getOpsOfType("remove-node");
        const rootNodeId = 1; // The div element
        const rootWasRemoved = removeOps.some(
          (op) => (op as { nodeId: number }).nodeId === rootNodeId,
        );
        assertEquals(
          rootWasRemoved,
          false,
          "Root element should NOT be removed when updating same tag",
        );

        // Verify we got prop update ops on the SAME node (nodeId 1)
        const propOps = collector.getOpsOfType("set-prop");
        const hasClassNameUpdate = propOps.some(
          (op) =>
            (op as { nodeId: number; key: string; value: unknown }).nodeId ===
              rootNodeId &&
            (op as { nodeId: number; key: string; value: unknown }).key ===
              "className" &&
            (op as { nodeId: number; key: string; value: unknown }).value ===
              "updated",
        );
        assertEquals(
          hasClassNameUpdate,
          true,
          "Should emit set-prop for className update on same node",
        );

        cancel();
      },
    );

    await t.step(
      "when Cell emits new VNode with different tag, remove-node IS emitted",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        // Create a Cell starting with a div
        const vnodeCell = runtime.getCell<WorkerVNode>(
          space,
          "test-vnode-different-tag",
          undefined,
          tx,
        );

        vnodeCell.set({
          type: "vnode",
          name: "div",
          props: { id: "test" },
          children: [],
        } as WorkerVNode);
        await tx.commit().settled;
        tx = runtime.edit();

        // Mount the cell
        const cancel = reconciler.mount(vnodeCell as Cell<WorkerVNode>);
        await runtime.idle();
        collector.clear();

        // Update the Cell with a DIFFERENT tag
        vnodeCell.withTx(tx).set({
          type: "vnode",
          name: "span", // Different tag!
          props: { id: "test" },
          children: [],
        } as WorkerVNode);
        await tx.commit().settled;
        tx = runtime.edit();
        await runtime.idle();

        // Verify remove-node WAS emitted (different tag requires recreate)
        const removeOps = collector.getOpsOfType("remove-node");
        assertEquals(
          removeOps.length,
          1,
          "Should emit remove-node when changing tag",
        );

        // And a new element was created
        const createOps = collector.getOpsOfType("create-element");
        assertEquals(createOps.length, 1, "Should create new element");
        assertEquals(
          (createOps[0] as { tagName: string }).tagName,
          "span",
          "Should create a span",
        );

        cancel();
      },
    );

    await t.step("children are updated in place when tag is same", async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      // Create a Cell with children
      const vnodeCell = runtime.getCell<WorkerVNode>(
        space,
        "test-vnode-children",
        undefined,
        tx,
      );

      vnodeCell.set({
        type: "vnode",
        name: "div",
        props: {},
        children: [
          {
            type: "vnode",
            name: "span",
            props: { id: "child1" },
            children: [],
          },
        ],
      } as WorkerVNode);
      await tx.commit().settled;
      tx = runtime.edit();

      // Mount
      const cancel = reconciler.mount(vnodeCell as Cell<WorkerVNode>);
      await runtime.idle();

      // Get the child's nodeId
      const initialCreateOps = collector.getOpsOfType("create-element");
      assertEquals(initialCreateOps.length, 2, "Should create div and span");

      collector.clear();

      // Update children (add a second child)
      vnodeCell.withTx(tx).set({
        type: "vnode",
        name: "div",
        props: {},
        children: [
          {
            type: "vnode",
            name: "span",
            props: { id: "child1" },
            children: [],
          },
          {
            type: "vnode",
            name: "span",
            props: { id: "child2" },
            children: [],
          },
        ],
      } as WorkerVNode);
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.idle();

      // Should NOT remove the parent div
      const parentRemoveOps = collector.getOps().filter(
        (op) => op.op === "remove-node",
      );
      // The parent div should not be removed
      assertEquals(
        parentRemoveOps.length === 0 ||
          !parentRemoveOps.some(
            (op) =>
              (op as { nodeId: number }).nodeId ===
                (initialCreateOps[0] as { nodeId: number }).nodeId,
          ),
        true,
        "Parent div should not be removed",
      );

      // Should create the new child
      const newCreateOps = collector.getOpsOfType("create-element");
      assertEquals(newCreateOps.length >= 1, true, "Should create new child");

      cancel();
    });

    await t.step(
      "conditional mapped children insert spans at first middle and last positions",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const vnodeCell = runtime.getCell<WorkerVNode>(
          space,
          "test-conditional-mapped-children",
          undefined,
          tx,
        );

        const voteSpan = (id: string): WorkerVNode => ({
          type: "vnode",
          name: "span",
          props: { "data-vote-swatch-name": id },
          children: [id],
        });

        const row = (
          id: string,
          children: WorkerRenderNode[],
        ): WorkerVNode => ({
          type: "vnode",
          name: "div",
          props: { "data-option-id": id },
          children,
        });

        vnodeCell.set({
          type: "vnode",
          name: "div",
          props: { id: "root" },
          children: [
            row("first", []),
            row("middle", []),
            row("last", []),
          ],
        } as WorkerVNode);
        await tx.commit().settled;
        tx = runtime.edit();

        const cancel = reconciler.mount(vnodeCell as Cell<WorkerVNode>);
        await runtime.idle();
        collector.clear();

        vnodeCell.withTx(tx).set({
          type: "vnode",
          name: "div",
          props: { id: "root" },
          children: [
            row("first", [voteSpan("Alice")]),
            row("middle", [null, voteSpan("Alice")]),
            row("last", [
              null,
              null,
              voteSpan("Alice"),
            ]),
          ],
        } as WorkerVNode);
        await tx.commit().settled;
        tx = runtime.edit();
        await runtime.idle();

        const spanCreates = collector.getOpsOfType("create-element").filter(
          (op) => "tagName" in op && op.tagName === "span",
        );
        assertEquals(
          spanCreates.length,
          3,
          "should create one swatch span for each conditional child position",
        );

        const swatchPropOps = collector.getOpsOfType("set-prop").filter(
          (op) =>
            op.op === "set-prop" && op.key === "data-vote-swatch-name" &&
            op.value === "Alice",
        );
        assertEquals(
          swatchPropOps.length,
          3,
          "each created swatch span should receive the voter data attribute",
        );

        cancel();
      },
    );

    await t.step("clears root when Cell emits undefined", async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const vnodeCell = runtime.getCell<WorkerVNode>(
        space,
        "test-vnode-root-clear",
        undefined,
        tx,
      );

      vnodeCell.set({
        type: "vnode",
        name: "div",
        props: { id: "root-clear" },
        children: ["Hello"],
      } as WorkerVNode);
      await tx.commit().settled;
      tx = runtime.edit();

      const cancel = reconciler.mount(vnodeCell as Cell<WorkerVNode>);
      await runtime.idle();
      collector.clear();

      vnodeCell.withTx(tx).set(undefined as unknown as WorkerVNode);
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.idle();

      const removeOps = collector.getOpsOfType("remove-node");
      assertEquals(removeOps.length, 1, "Should remove previous root node");
      assertEquals(
        reconciler.getRootNodeId(),
        null,
        "Root node should be null",
      );

      cancel();
    });
  } finally {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  }
});
