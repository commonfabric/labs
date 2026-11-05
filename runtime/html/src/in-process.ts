/**
 * Rendering with the reconciler and the applicator in one process.
 *
 * In a browser the reconciler runs in the worker, where cell values are
 * available synchronously, and the operations it emits travel to the
 * applicator on the main thread. A host that already holds the runner has no
 * boundary to cross: the CLI turning a piece's UI into HTML runs both halves
 * itself. This module connects them directly, so such a host renders through
 * the same reconciler and the same applicator as a browser does.
 */

import type { Cancel, Cell } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { DomApplicator } from "./main/applicator.ts";
import type { SetPropHandler } from "./render-utils.ts";
import { WorkerReconciler } from "./worker/reconciler.ts";

export interface InProcessRenderOptions {
  /** The document to create nodes in. Defaults to the ambient document. */
  document?: Document;

  /** Custom property setter, as for a browser render. */
  setProp?: SetPropHandler;

  /** Called for reconciliation and application errors. */
  onError?: (error: Error) => void;

  /**
   * Called after each batch of operations has been applied, so a host that
   * watches the rendered result learns when the container changed. Several
   * batches can make up one logical update; a caller that wants the settled
   * tree waits for the runtime to go idle before reading.
   */
  onApplied?: () => void;
}

/** A mounted in-process render. */
export interface InProcessRender {
  /**
   * Apply everything the reconciler has produced so far. Reconciliation
   * batches its output onto a microtask, so a caller that is about to read the
   * container calls this to fix the point it is reading.
   */
  flush(): void;

  /** Unmount the tree and drop the applicator's nodes and listeners. */
  cancel: Cancel;
}

/**
 * Render a VDOM cell into `container`.
 *
 * The cell is read through the renderer's own schema, so cell-valued props and
 * children arrive as cells the reconciler subscribes to, exactly as they do
 * for a mounted browser render. Handlers registered by the reconciler are
 * never invoked here: no events reach a host that only reads the result.
 */
export function renderInProcess(
  container: HTMLElement,
  vdomCell: Cell<unknown>,
  options: InProcessRenderOptions = {},
): InProcessRender {
  const applicator = new DomApplicator({
    document: options.document,
    setProp: options.setProp,
    onError: options.onError,
    onEvent: () => {},
  });
  applicator.setContainer(container);

  let batchId = 0;
  const reconciler = new WorkerReconciler({
    onOps: (ops) => {
      const id = batchId++;
      applicator.applyBatch({ batchId: id, ops });
      options.onApplied?.();
      return id;
    },
    onError: options.onError,
  });

  reconciler.mount(vdomCell.asSchema(rendererVDOMSchema));

  return {
    flush: () => reconciler.flush(),
    cancel: () => {
      reconciler.unmount();
      applicator.dispose();
    },
  };
}
