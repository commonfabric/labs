/**
 * Main-thread DOM applicator.
 *
 * This module receives VDomOp batches from the worker thread and applies
 * them to the actual DOM. It maintains a mapping from node IDs to DOM nodes
 * and handles bidirectional bindings and event dispatch.
 */

import type { CellRef, RuntimeClient } from "@commonfabric/runtime-client";
import { CellHandle, cellRefToKey } from "@commonfabric/runtime-client";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { setPropDefault, type SetPropHandler } from "../render-utils.ts";
import { CONTAINER_NODE_ID, type VDomBatch, type VDomOp } from "../vdom-ops.ts";
import { serializeEvent } from "./events.ts";
import type { DomEventMessage } from "./events.ts";
import {
  clearPieceBoundary,
  provideElementSpace,
  providePieceBoundary,
} from "./space-context.ts";

const logger = getLogger("vdom-applicator", { enabled: false, level: "debug" });

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

interface PendingChildInsert {
  parentId: number;
  childId: number;
  beforeId: number | null;
}

function hasNodeType(node: unknown, nodeType: number): boolean {
  return isObjectOrArray(node) &&
    (node as { nodeType?: unknown }).nodeType === nodeType;
}

function isElementNode(node: unknown): node is HTMLElement {
  return hasNodeType(node, ELEMENT_NODE);
}

function isTextNode(node: unknown): node is Node {
  return hasNodeType(node, TEXT_NODE);
}

/**
 * Options for creating a DOM applicator.
 */
export interface DomApplicatorOptions {
  /** The document to create elements in */
  document?: Document;

  /** Callback when a DOM event needs to be sent back to the worker */
  onEvent: (message: DomEventMessage) => void;

  /**
   * `RuntimeClient` for turning a `CellRef` into a live handle. A host with no
   * client-side runtime proxy — the CLI, which drives the reconciler in its own
   * process and serializes the result — omits it, and a bidirectional binding
   * is then applied as the plain cell reference it names.
   */
  runtimeClient?: RuntimeClient;

  /** Optional callback for errors */
  onError?: (error: Error) => void;

  /** Optional custom property setter */
  setProp?: SetPropHandler;
}

/**
 * DOM applicator that applies VDomOps to the real DOM.
 */
export class DomApplicator {
  readonly #nodes = new Map<number, Node>();
  readonly #eventListeners = new Map<
    number,
    Map<string, EventListener>
  >();

  /** Parent tracking: childId → parentId for O(1) descendant lookup */
  readonly #nodeParents = new Map<number, number>();

  /** Children tracking: parentId → Set<childId> for O(n) descendant cleanup */
  readonly #nodeChildren = new Map<number, Set<number>>();

  readonly #document: Document;
  readonly #onEvent: (message: DomEventMessage) => void;
  readonly #runtimeClient?: RuntimeClient;
  readonly #onError?: (error: Error) => void;
  readonly #setPropHandler: SetPropHandler;
  #pendingChildInserts: PendingChildInsert[] = [];

  #rootNodeId: number | null = null;

  constructor(options: DomApplicatorOptions) {
    this.#document = options.document ?? globalThis.document;
    this.#onEvent = options.onEvent;
    this.#runtimeClient = options.runtimeClient;
    this.#onError = options.onError;
    this.#setPropHandler = options.setProp ?? setPropDefault;
  }

  /**
   * Apply a batch of VDOM operations.
   */
  applyBatch(batch: VDomBatch): void {
    logger.timeStart("apply-batch");
    const opCount = batch.ops.length;

    for (const op of batch.ops) {
      try {
        this.#applyOp(op);
        this.#replayPendingChildInserts();
      } catch (error) {
        this.#onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    this.#replayPendingChildInserts();

    if (batch.rootId !== undefined) {
      this.#rootNodeId = batch.rootId;
    }
    const elapsed = logger.timeEnd("apply-batch");
    logger.debug("apply-batch", () => [
      `Applied ${opCount} ops in ${elapsed?.toFixed(2)}ms`,
      `(${((elapsed ?? 0) / opCount).toFixed(3)}ms/op)`,
      `nodes=${this.#nodes.size}`,
      { ops: batch.ops },
    ]);
  }

  /**
   * Apply a single VDOM operation.
   */
  #applyOp(op: VDomOp): void {
    switch (op.op) {
      case "create-element":
        this.#createElement(op.nodeId, op.tagName, op.space);
        break;

      case "create-text":
        this.#createText(op.nodeId, op.text);
        break;

      case "update-text":
        this.#updateText(op.nodeId, op.text);
        break;

      case "set-prop":
        this.#setProp(op.nodeId, op.key, op.value);
        break;

      case "remove-prop":
        this.#removeProp(op.nodeId, op.key);
        break;

      case "set-event":
        this.#setEvent(op.nodeId, op.eventType, op.handlerId);
        break;

      case "remove-event":
        this.#removeEvent(op.nodeId, op.eventType);
        break;

      case "set-binding":
        this.#setBinding(op.nodeId, op.propName, op.cellRef);
        break;

      case "set-piece-boundary":
        this.#setPieceBoundary(op.nodeId, op.cellRef);
        break;

      case "clear-piece-boundary":
        this.#clearPieceBoundary(op.nodeId);
        break;

      case "insert-child":
        if (!this.#insertChild(op.parentId, op.childId, op.beforeId)) {
          this.#deferChildInsert(op.parentId, op.childId, op.beforeId);
        }
        break;

      case "remove-node":
        this.#removeNode(op.nodeId);
        break;
    }
  }

  /**
   * Get the root DOM node.
   */
  getRootNode(): Node | null {
    return this.#rootNodeId !== null
      ? this.#nodes.get(this.#rootNodeId) ?? null
      : null;
  }

  /**
   * Get a DOM node by ID.
   */
  getNode(nodeId: number): Node | undefined {
    return this.#nodes.get(nodeId);
  }

  /**
   * Register the container element.
   * The container is where rendered content will be inserted.
   * Must be called before applying any batches.
   */
  setContainer(container: HTMLElement): void {
    this.#nodes.set(CONTAINER_NODE_ID, container);
  }

  /**
   * Dispose of all tracked nodes and listeners.
   */
  dispose(): void {
    logger.timeStart("dispose");
    const nodeCount = this.#nodes.size;
    const listenerCount = this.#eventListeners.size;

    // Remove all event listeners (skip container)
    for (const [nodeId, listeners] of this.#eventListeners) {
      if (nodeId === CONTAINER_NODE_ID) continue;
      const node = this.#nodes.get(nodeId);
      if (node) {
        for (const [eventType, listener] of listeners) {
          (node as EventTarget).removeEventListener(eventType, listener);
        }
      }
    }
    this.#eventListeners.clear();

    // Remove all nodes except the container (it's owned by the caller)
    for (const [nodeId, node] of this.#nodes) {
      if (nodeId === CONTAINER_NODE_ID) continue;
      if (isElementNode(node)) clearPieceBoundary(node);
      if (
        node.parentNode &&
        typeof (node.parentNode as ParentNode & { removeChild?: unknown })
            .removeChild === "function"
      ) {
        node.parentNode.removeChild(node);
      }
    }
    this.#nodes.clear();
    this.#nodeParents.clear();
    this.#nodeChildren.clear();
    this.#pendingChildInserts = [];
    this.#rootNodeId = null;

    const elapsed = logger.timeEnd("dispose");
    logger.debug("dispose", () => [
      `Disposed ${nodeCount} nodes, ${listenerCount} listeners in ${
        elapsed?.toFixed(2)
      }ms`,
    ]);
  }

  /**
   * Return a snapshot of internal state for debugging.
   * Returns live maps directly (no clone cost, fine for debug).
   */
  getDebugInfo(): {
    nodeCount: number;
    listenerCount: number;
    totalListeners: number;
    rootNodeId: number | null;
    nodes: Map<number, Node>;
    nodeParents: Map<number, number>;
    nodeChildren: Map<number, Set<number>>;
  } {
    let totalListeners = 0;
    for (const listeners of this.#eventListeners.values()) {
      totalListeners += listeners.size;
    }
    return {
      nodeCount: this.#nodes.size,
      listenerCount: this.#eventListeners.size,
      totalListeners,
      rootNodeId: this.#rootNodeId,
      nodes: this.#nodes,
      nodeParents: this.#nodeParents,
      nodeChildren: this.#nodeChildren,
    };
  }

  //
  // Operation Implementations
  //

  #createElement(nodeId: number, tagName: string, space?: string): void {
    const element = this.#document.createElement(tagName);
    if (space !== undefined) {
      provideElementSpace(element, space);
    }
    this.#nodes.set(nodeId, element);
  }

  #createText(nodeId: number, text: string): void {
    const textNode = this.#document.createTextNode(text);
    this.#nodes.set(nodeId, textNode);
  }

  #updateText(nodeId: number, text: string): void {
    const node = this.#nodes.get(nodeId);
    if (isTextNode(node)) {
      node.textContent = text;
    }
  }

  #setProp(nodeId: number, key: string, value: unknown): void {
    const node = this.#nodes.get(nodeId);
    if (!isElementNode(node)) return;

    // Use the configured property setter (defaults to setPropDefault)
    this.#setPropHandler(node, key, value);
  }

  #removeProp(nodeId: number, key: string): void {
    const node = this.#nodes.get(nodeId);
    if (!isElementNode(node)) return;

    if (key.startsWith("on") && key.length > 2) {
      this.#removeEvent(nodeId, key.slice(2).toLowerCase());
    } else if (key.startsWith("$") && key.length > 1) {
      (node as any)[key.slice(1)] = undefined;
    } else if (key.startsWith("data-") || key.startsWith("aria-")) {
      node.removeAttribute(key);
    } else if (key === "style") {
      node.removeAttribute("style");
    } else {
      (node as any)[key] = undefined;
    }
  }

  #setEvent(nodeId: number, eventType: string, handlerId: number): void {
    const node = this.#nodes.get(nodeId);
    if (!node) return;

    // Remove existing listener for this event type
    this.#removeEvent(nodeId, eventType);
    this.#removeEventForNode(node, eventType);

    // Create new listener
    const listener: EventListener = (event: Event) => {
      const serialized = serializeEvent(event);
      const message: DomEventMessage = {
        type: "dom-event",
        handlerId,
        event: serialized,
        nodeId,
      };
      this.#onEvent(message);
    };

    // Track listener
    let listeners = this.#eventListeners.get(nodeId);
    if (!listeners) {
      listeners = new Map();
      this.#eventListeners.set(nodeId, listeners);
    }
    listeners.set(eventType, listener);

    // Add to DOM
    (node as EventTarget).addEventListener(eventType, listener);
  }

  #removeEventForNode(node: Node, eventType: string): void {
    for (const [trackedNodeId, listeners] of this.#eventListeners) {
      const trackedNode = this.#nodes.get(trackedNodeId);
      if (trackedNode !== node) continue;

      const listener = listeners.get(eventType);
      if (!listener) continue;

      (node as EventTarget).removeEventListener(eventType, listener);
      listeners.delete(eventType);
      if (listeners.size === 0) {
        this.#eventListeners.delete(trackedNodeId);
      }
    }
  }

  #removeEvent(nodeId: number, eventType: string): void {
    const listeners = this.#eventListeners.get(nodeId);
    if (!listeners) return;

    const listener = listeners.get(eventType);
    if (!listener) return;

    const node = this.#nodes.get(nodeId);
    if (node) {
      (node as EventTarget).removeEventListener(eventType, listener);
    }
    listeners.delete(eventType);
  }

  #setBinding(nodeId: number, propName: string, cellRef: CellRef): void {
    const node = this.#nodes.get(nodeId);
    if (!isElementNode(node)) return;

    if (!this.#runtimeClient) {
      // No client-side runtime to hand the element a live handle; the
      // reference is what this host can say about the binding.
      this.#setPropHandler(node, propName, cellRef);
      return;
    }

    const existing = (node as any)[propName];
    if (
      existing instanceof CellHandle &&
      cellRefToKey(existing.ref()) === cellRefToKey(cellRef)
    ) {
      return;
    }

    // Create a CellHandle from the CellRef
    const cellHandle = new CellHandle(this.#runtimeClient, cellRef);

    // Set the CellHandle on the element's property
    // Custom elements like cf-input and cf-checkbox expect this
    (node as any)[propName] = cellHandle;
    this.#notifyBoundProperty(node, propName);
  }

  #setPieceBoundary(nodeId: number, cellRef: CellRef): void {
    const node = this.#nodes.get(nodeId);
    if (!isElementNode(node) || !this.#runtimeClient) return;
    providePieceBoundary(node, new CellHandle(this.#runtimeClient, cellRef));
  }

  #clearPieceBoundary(nodeId: number): void {
    const node = this.#nodes.get(nodeId);
    if (isElementNode(node)) clearPieceBoundary(node);
  }

  #notifyBoundProperty(
    node: HTMLElement,
    propName: string,
  ): void {
    const element = node as HTMLElement & {
      requestUpdate?: (name?: PropertyKey, oldValue?: unknown) => void;
    };

    if (typeof element.requestUpdate === "function") {
      element.requestUpdate(propName, undefined);
      return;
    }

    const tagName = element.localName ?? element.tagName?.toLowerCase();
    if (!tagName || !tagName.includes("-")) {
      return;
    }
    void globalThis.customElements?.whenDefined(tagName).then(() => {
      element.requestUpdate?.(propName, undefined);
    });
  }

  #insertChild(
    parentId: number,
    childId: number,
    beforeId: number | null,
  ): boolean {
    const parent = this.#nodes.get(parentId);
    const child = this.#nodes.get(childId);
    if (!parent || !child) return false;

    const beforeNode = beforeId === null ? null : this.#nodes.get(beforeId);
    if (
      beforeId !== null && (!beforeNode || beforeNode.parentNode !== parent)
    ) {
      return false;
    }

    this.#discardPendingForChild(childId);

    // Update parent/children tracking
    // Remove from old parent if any
    const oldParentId = this.#nodeParents.get(childId);
    if (oldParentId !== undefined) {
      this.#nodeChildren.get(oldParentId)?.delete(childId);
    }
    // Add to new parent
    this.#nodeParents.set(childId, parentId);
    let children = this.#nodeChildren.get(parentId);
    if (!children) {
      children = new Set();
      this.#nodeChildren.set(parentId, children);
    }
    children.add(childId);

    if (beforeNode) {
      parent.insertBefore(child, beforeNode);
    } else {
      parent.appendChild(child);
    }
    return true;
  }

  #deferChildInsert(
    parentId: number,
    childId: number,
    beforeId: number | null,
  ): void {
    this.#discardPendingForChild(childId);
    this.#pendingChildInserts.push({ parentId, childId, beforeId });
  }

  #discardPendingForChild(childId: number): void {
    this.#pendingChildInserts = this.#pendingChildInserts.filter((pending) =>
      pending.childId !== childId
    );
  }

  #discardPendingForNodeIds(nodeIds: ReadonlySet<number>): void {
    const remaining: PendingChildInsert[] = [];
    for (const pending of this.#pendingChildInserts) {
      if (nodeIds.has(pending.parentId) || nodeIds.has(pending.childId)) {
        continue;
      }

      remaining.push(
        pending.beforeId !== null && nodeIds.has(pending.beforeId)
          ? { ...pending, beforeId: null }
          : pending,
      );
    }
    this.#pendingChildInserts = remaining;
  }

  #replayPendingChildInserts(): void {
    if (this.#pendingChildInserts.length === 0) return;

    const remaining: PendingChildInsert[] = [];
    for (const pending of this.#pendingChildInserts) {
      if (
        !this.#insertChild(
          pending.parentId,
          pending.childId,
          pending.beforeId,
        )
      ) {
        remaining.push(pending);
      }
    }
    this.#pendingChildInserts = remaining;
  }

  #removeNode(nodeId: number): void {
    const node = this.#nodes.get(nodeId);
    const removedNodeIds = new Set([nodeId]);
    this.#collectDescendantNodeIds(nodeId, removedNodeIds);
    this.#discardPendingForNodeIds(removedNodeIds);
    if (!node) return;

    logger.timeStart("remove-node", String(nodeId));

    // Recursively clean up descendants first (O(n) via parent/children tracking)
    const descendantCount = this.#cleanupDescendants(nodeId);

    // Remove event listeners for this node
    const listeners = this.#eventListeners.get(nodeId);
    if (listeners) {
      for (const [eventType, listener] of listeners) {
        (node as EventTarget).removeEventListener(eventType, listener);
      }
      this.#eventListeners.delete(nodeId);
    }

    if (isElementNode(node)) clearPieceBoundary(node);

    // Remove from DOM
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }

    // Remove from parent tracking
    const parentId = this.#nodeParents.get(nodeId);
    if (parentId !== undefined) {
      this.#nodeChildren.get(parentId)?.delete(nodeId);
      this.#nodeParents.delete(nodeId);
    }
    this.#nodeChildren.delete(nodeId);

    // Remove from tracking
    this.#nodes.delete(nodeId);

    const elapsed = logger.timeEnd("remove-node", String(nodeId));
    if (descendantCount > 0) {
      logger.debug("remove-node", () => [
        `Removed node ${nodeId} with ${descendantCount} descendants in ${
          elapsed?.toFixed(2)
        }ms`,
      ]);
    }
  }

  /**
   * Clean up tracked descendants of a node using parent/children tracking.
   * This is O(n) where n is the number of descendants, not O(n*m) like DOM traversal.
   * @returns The number of descendants cleaned up
   */
  #cleanupDescendants(nodeId: number): number {
    const children = this.#nodeChildren.get(nodeId);
    if (!children || children.size === 0) return 0;

    let count = 0;
    // Process children recursively (depth-first)
    for (const childId of children) {
      // Recurse first to clean up grandchildren
      count += this.#cleanupDescendants(childId);

      // Clean up this child
      const childNode = this.#nodes.get(childId);

      if (isElementNode(childNode)) clearPieceBoundary(childNode);

      // Remove event listeners
      const listeners = this.#eventListeners.get(childId);
      if (listeners && childNode) {
        for (const [eventType, listener] of listeners) {
          (childNode as EventTarget).removeEventListener(eventType, listener);
        }
        this.#eventListeners.delete(childId);
      }

      // Remove from tracking maps
      this.#nodes.delete(childId);
      this.#nodeParents.delete(childId);
      this.#nodeChildren.delete(childId);
      count++;
    }

    return count;
  }

  #collectDescendantNodeIds(nodeId: number, into: Set<number>): void {
    const children = this.#nodeChildren.get(nodeId);
    if (!children || children.size === 0) return;

    for (const childId of children) {
      into.add(childId);
      this.#collectDescendantNodeIds(childId, into);
    }
  }
}
