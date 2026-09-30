/**
 * Main-thread VDOM renderer.
 *
 * This class integrates the DomApplicator with the RuntimeConnection,
 * handling VDomBatch notifications from the worker and sending DOM events
 * back to the worker.
 */

import type {
  CellRef,
  RuntimeClient,
  RuntimeConnection,
  VDomBatchNotification,
  VDomConnection,
} from "@commonfabric/runtime-client";
import { getLogger } from "@commonfabric/utils/logger";

import type { SetPropHandler } from "../render-utils.ts";
import { DomApplicator } from "./applicator.ts";
import type { DomEventMessage } from "./events.ts";

const logger = getLogger("vdom-renderer", { enabled: false, level: "debug" });

/**
 * Options for creating a VDomRenderer.
 */
export interface VDomRendererOptions {
  /** The RuntimeClient for creating CellHandles */
  runtimeClient: RuntimeClient;

  /** The RuntimeConnection for IPC */
  connection: RuntimeConnection;

  /** The document to render into */
  document?: Document;

  /** Optional error handler */
  onError?: (error: Error) => void;

  /** Optional custom property setter */
  setProp?: SetPropHandler;
}

/**
 * VDOM renderer that bridges the worker reconciler and main-thread DOM.
 *
 * Usage:
 * ```ts
 * const renderer = new VDomRenderer({
 *   runtimeClient,
 *   connection,
 * });
 *
 * // Mount a cell into a container - returns a cancel function
 * const cancel = await renderer.render(containerElement, cellRef);
 *
 * // Later, to stop rendering:
 * cancel();
 * ```
 */
export class VDomRenderer {
  /** Instance counter for unique mount IDs across all renderer instances */
  static #nextMountId = 1;

  readonly #applicator: DomApplicator;
  readonly #session: VDomConnection;
  readonly #onError?: (error: Error) => void;

  #mountId: number | null = null;
  #containerElement: HTMLElement | null = null;
  #rootNodeId: number | null = null;
  #disposed = false;

  constructor(options: VDomRendererOptions) {
    this.#onError = options.onError;

    // Create the DOM applicator
    this.#applicator = new DomApplicator({
      document: options.document,
      runtimeClient: options.runtimeClient,
      onEvent: (message) => this.#handleDomEvent(message),
      onError: options.onError,
      setProp: options.setProp,
    });

    // Attach as a VDOM consumer. attachVDom requires the teardown, which runs
    // synchronously when the connection is disposed (dropping local listeners
    // and DOM without a per-mount unmount round-trip), and is the only way to
    // obtain VDOM capability — so a renderer cannot exist without being torn
    // down on disposal.
    this.#session = options.connection.attachVDom(() => this.#disposeLocal());
    // If the connection is already disposed, attachVDom runs the teardown
    // synchronously, so `disposed` is set before `session` is assigned above.
    // Subscribe to batches only while still live.
    if (!this.#disposed) this.#session.onBatch(this.#handleVDomBatch);
  }

  /**
   * Start rendering a cell into a container element.
   *
   * @param container - The DOM element to render into
   * @param cellRef - The cell reference to render
   * @returns A cancel function to stop rendering
   */
  async render(
    container: HTMLElement,
    cellRef: CellRef,
  ): Promise<() => Promise<void>> {
    if (this.#disposed) {
      // The connection was disposed before this render began (its teardown ran
      // during construction). A torn-down renderer does not mount.
      return async () => {};
    }
    if (this.#mountId !== null) {
      throw new Error(
        "VDomRenderer already has an active mount. Call cancel first.",
      );
    }

    this.#containerElement = container;
    this.#mountId = VDomRenderer.#nextMountId++;

    // Register container so the worker can insert children directly into it
    this.#applicator.setContainer(container);

    // Request the worker to start rendering
    const mountId = this.#mountId;
    logger.timeStart("mount", String(mountId));
    try {
      const response = await this.#session.mount(mountId, cellRef);
      const elapsed = logger.timeEnd("mount", String(mountId));
      if (this.#disposed) return async () => {};
      this.#rootNodeId = response.rootId;

      logger.debug("render-mount", () => [
        `Mounted VDOM ${mountId} in ${elapsed?.toFixed(2)}ms`,
        `rootId=${response.rootId}`,
      ]);
    } catch (error) {
      // Reset state on failure so the renderer can be reused
      logger.timeEnd("mount", String(mountId));
      this.#mountId = null;
      this.#containerElement = null;
      throw error;
    }

    // Return a cancel function
    return async () => {
      await this.stopRendering();
    };
  }

  /**
   * Stop rendering and clean up.
   */
  async stopRendering(): Promise<void> {
    if (this.#mountId === null) {
      return;
    }

    const mountId = this.#mountId;
    logger.timeStart("unmount", String(mountId));
    this.#mountId = null;

    // Request the worker to stop rendering
    await this.#session.unmount(mountId);

    // Remove the root node from DOM
    if (this.#rootNodeId !== null) {
      const rootNode = this.#applicator.getNode(this.#rootNodeId);
      if (
        rootNode &&
        rootNode !== this.#containerElement &&
        rootNode.parentNode
      ) {
        rootNode.parentNode.removeChild(rootNode);
      }
      this.#rootNodeId = null;
    }

    this.#containerElement = null;

    const elapsed = logger.timeEnd("unmount", String(mountId));
    logger.debug("stop-rendering", () => [
      `Stopped VDOM ${mountId} in ${elapsed?.toFixed(2)}ms`,
    ]);
  }

  /**
   * Dispose of the renderer and clean up all resources. Used when this render
   * is cancelled while the connection is still alive (e.g. a cell or variant
   * change). Local teardown is synchronous; the worker unmount completes afterward.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    // We are tearing ourselves down, so detach from the connection's disposal.
    this.#session.detach();
    const unmount = this.stopRendering();
    this.#disposeLocal();
    await unmount;
  }

  /**
   * Synchronous local teardown: detach listeners and drop DOM. Does not issue
   * an unmount round-trip. Safe to call during connection disposal, and run
   * directly from the connection's disposal hook.
   */
  #disposeLocal = (): void => {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#mountId = null;
    this.#rootNodeId = null;
    this.#containerElement = null;
    // `session` is still unassigned when this runs as the synchronous teardown
    // during attachVDom against an already-disposed connection.
    this.#session?.offBatch(this.#handleVDomBatch);
    this.#applicator.dispose();
  };

  /**
   * Get the root DOM node if available.
   */
  getRootNode(): Node | null {
    return this.#rootNodeId !== null
      ? this.#applicator.getNode(this.#rootNodeId) ?? null
      : null;
  }

  /**
   * Get the underlying DomApplicator for debug inspection.
   */
  getApplicator(): DomApplicator {
    return this.#applicator;
  }

  /**
   * Get the current mount ID, or null if not mounted.
   */
  getMountId(): number | null {
    return this.#mountId;
  }

  //
  // Private Methods
  //

  #handleVDomBatch = (notification: VDomBatchNotification): void => {
    if (this.#disposed) return;

    // Filter for our mount ID
    if (
      notification.mountId !== undefined &&
      notification.mountId !== this.#mountId
    ) {
      return;
    }

    logger.timeStart("batch", String(notification.batchId));
    try {
      // Apply the batch to the DOM
      // Children are inserted directly into the container (CONTAINER_NODE_ID)
      this.#applicator.applyBatch({
        batchId: notification.batchId,
        ops: notification.ops,
        rootId: notification.rootId,
      });

      // Track the root node for cleanup. An absent `rootId` says nothing
      // about the root and leaves the tracked one standing; `null` is the
      // reconciler reporting a tree with no root child, and clears it.
      if (notification.rootId !== undefined) {
        this.#rootNodeId = notification.rootId;
      }

      if (notification.mountId !== undefined) {
        this.#session.ackBatch(
          notification.mountId,
          notification.batchId,
        );
      }

      const elapsed = logger.timeEnd("batch", String(notification.batchId));
      logger.debug("vdom-batch", () => [
        `Batch ${notification.batchId}: ${notification.ops.length} ops in ${
          elapsed?.toFixed(2)
        }ms`,
      ]);
    } catch (error) {
      logger.timeEnd("batch", String(notification.batchId));
      this.#onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };

  #handleDomEvent(message: DomEventMessage): void {
    if (this.#disposed || this.#mountId === null) return;

    // Send the event to the worker via the VDOM session
    this.#session.sendEvent(
      this.#mountId,
      message.handlerId,
      message.event,
      message.nodeId,
    );
  }
}
