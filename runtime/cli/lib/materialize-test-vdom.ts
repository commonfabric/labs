import { isWorkerVNode, WorkerReconciler } from "@commonfabric/html/worker";
import { type Cell, isCell } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";

function isRenderableRoot(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) return true;
  if (isCell(value) || isWorkerVNode(value)) return true;
  if (Array.isArray(value)) return value.every(isRenderableRoot);
  return typeof value === "object" && "$UI" in value;
}

/**
 * Materialize a test step's VDOM through the worker reconciler.
 *
 * The emitted DOM operations are intentionally discarded: pattern tests stay
 * headless, while the reconciler installs the same recursive demand graph that
 * a mounted renderer would. The demand exists only for the duration of this
 * call and is removed before the next test step begins.
 */
export async function materializeTestVDOM(
  vdomCell: Cell<unknown>,
  settle: () => Promise<void>,
): Promise<void> {
  const errors: Error[] = [];
  let cancel: (() => void) | undefined;

  try {
    cancel = await mountTestVDOM(vdomCell, (error) => errors.push(error));
    await settle();
    if (errors.length > 0) {
      throw new Error(`VDOM materialization failed: ${errors[0]!.message}`, {
        cause: errors[0],
      });
    }
  } finally {
    cancel?.();
  }
}

/**
 * Mount a headless VDOM demand that remains active until the caller cancels it.
 * Reconciliation errors are reported for the caller to fold into its own test
 * health channel.
 */
export async function mountTestVDOM(
  vdomCell: Cell<unknown>,
  onError: (error: Error) => void,
): Promise<() => void> {
  // Demand the same bounded shape the renderer consumes. Root validation reads
  // the original value so a schema mismatch still reports invalid VDOM.
  await vdomCell.asSchema(rendererVDOMSchema).pull();
  const root = vdomCell.get();
  if (!isRenderableRoot(root)) {
    throw new Error(
      `VDOM materialization failed: Invalid VDOM content: expected ` +
        `WorkerVNode, string, number, boolean, array, or $UI object, got ${typeof root}`,
    );
  }

  const reconciler = new WorkerReconciler({
    onOps: () => {},
    onError,
  });
  return reconciler.mount(vdomCell.asSchema(rendererVDOMSchema));
}
