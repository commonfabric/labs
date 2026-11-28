/**
 * A tree mounted on a worker reconciler of its own, and readings of the
 * operations it emits, for tests that judge a render by what it emitted.
 */

import type { Cell } from "@commonfabric/runner";
import type { CellRef } from "@commonfabric/runtime-client";
import { clock } from "@commonfabric/test-support/fake-clock";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type {
  WorkerReconcilerOptions,
  WorkerVNode,
} from "../src/worker/types.ts";

/** A tree {@link mountTree} mounted, and what it has emitted so far. */
export interface MountedTree {
  /** Every operation emitted, in order, including those of later updates. */
  readonly ops: readonly VDomOp[];

  /** Returns the text of each text node created. */
  texts(): string[];

  /** Returns each value set on the prop `key` of any element. */
  propsSet(key: string): unknown[];

  /** Returns the cell each binding names. */
  bindings(): CellRef[];

  /** Unmounts the tree. */
  cancel(): void;
}

/**
 * Mounts `tree` on a new reconciler made with `options`, waits for the
 * reconciler to settle, and returns the mounted tree.
 */
export async function mountTree(
  tree: WorkerVNode | Cell<unknown>,
  options: Omit<WorkerReconcilerOptions, "onOps"> = {},
): Promise<MountedTree> {
  const ops: VDomOp[] = [];
  const cancel = new WorkerReconciler({
    ...options,
    onOps: (batch) => {
      for (const op of batch) ops.push(op);
    },
  }).mount(tree);
  await clock.settle();
  return {
    ops,
    texts: () => ops.flatMap((op) => op.op === "create-text" ? [op.text] : []),
    propsSet: (key) =>
      ops.flatMap((op) =>
        op.op === "set-prop" && op.key === key ? [op.value] : []
      ),
    bindings: () =>
      ops.flatMap((op) => op.op === "set-binding" ? [op.cellRef] : []),
    cancel,
  };
}
