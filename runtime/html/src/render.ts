import {
  $conn,
  type Cancel,
  type CellHandle,
  type VNode,
} from "@commonfabric/runtime-client";

import type { SetPropHandler } from "./render-utils.ts";
import { VDomRenderer } from "./main/renderer.ts";

/** Tracks an active rendering for debug inspection. */
export interface ActiveRender {
  parent: HTMLElement;
  cell: CellHandle<VNode>;
  renderer: VDomRenderer;
}

const activeRenders = new Map<HTMLElement, ActiveRender>();

/** Get a read-only view of all active renderings. */
export function getActiveRenders(): ReadonlyMap<HTMLElement, ActiveRender> {
  return activeRenders;
}

export interface RenderOptions {
  setProp?: SetPropHandler;
  document?: Document;

  /** Optional error handler */
  onError?: (error: Error) => void;
}

/**
 * Render a `CellHandle<VNode>` into a parent element.
 *
 * The worker reconciles the VDOM and sends operations over IPC, and the main
 * thread applies those operations to the DOM. Reactive updates therefore cost
 * no IPC round trip, and the worker decides what may be shown: it holds the
 * cells, so it is the side that can evaluate the confidentiality policy
 * governing each one.
 */
export const render = (
  parent: HTMLElement,
  view: CellHandle<VNode>,
  options: RenderOptions = {},
): Cancel => {
  const runtimeClient = view.runtime();
  const connection = runtimeClient[$conn]();
  const cellRef = view.ref();

  const renderer = new VDomRenderer({
    runtimeClient,
    connection,
    document: options.document,
    onError: options.onError,
    setProp: options.setProp,
  });

  // Register in active renders registry
  const entry: ActiveRender = {
    parent,
    cell: view,
    renderer,
  };
  activeRenders.set(parent, entry);

  // When the connection is disposed, drop this render's registry entry. The
  // renderer tears itself down through its own disposal hook; this frees the
  // activeRenders bookkeeping, which the synchronous cancel path otherwise owns.
  const unregisterOnDispose = connection.onDispose(() => {
    if (activeRenders.get(parent) === entry) {
      activeRenders.delete(parent);
    }
  });

  // Start rendering asynchronously
  let disposed = false;

  renderer
    .render(parent, cellRef)
    .catch((error) => {
      // Swallow errors caused by teardown: this render being cancelled, or the
      // connection being disposed (which cancels an in-flight mount).
      if (!disposed && !connection.signal.aborted) {
        options.onError?.(error);
      }
    });

  // Return synchronous cancel function
  return () => {
    disposed = true;
    unregisterOnDispose();
    // Only remove if we're still the active render for this parent
    if (activeRenders.get(parent) === entry) {
      activeRenders.delete(parent);
    }
    // Local teardown must precede any pending mount or unmount response.
    renderer.dispose().catch(() => {});
  };
};

export default render;
