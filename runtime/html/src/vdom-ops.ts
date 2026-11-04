/**
 * VDOM operation types for IPC between worker and main thread.
 *
 * These operations describe DOM mutations that need to be applied
 * on the main thread. They are batched and sent as a single message.
 */

import type { FabricValue } from "@commonfabric/data-model";
import type { CellRef } from "@commonfabric/runtime-client";

/**
 * Reserved node ID for the container element. The main thread registers the
 * container DOM element under it, and the worker names it as the parent when
 * inserting a child directly into the container. It lives here, with the rest
 * of the vocabulary the two sides share, because agreeing on it is the whole
 * of its job.
 */
export const CONTAINER_NODE_ID = 0;

/**
 * Create a new DOM element.
 */
export type CreateElementOp = {
  op: "create-element";
  nodeId: number;
  tagName: string;

  /**
   * The space of the cell whose render produced this element, present
   * only when it differs from the nearest ancestor element that
   * carried one. The applicator turns it into the element's context
   * space, so components inside a rendered pattern act in the PIECE's
   * space — correct across cross-space transclusion.
   */
  space?: string;
};

/**
 * Create a new text node.
 */
export type CreateTextOp = {
  op: "create-text";
  nodeId: number;
  text: string;
};

/**
 * Update the text content of a text node.
 */
export type UpdateTextOp = {
  op: "update-text";
  nodeId: number;
  text: string;
};

/**
 * Set a property on an element.
 */
export type SetPropOp = {
  op: "set-prop";
  nodeId: number;
  key: string;

  /**
   * The value to set, which is whatever a pattern put on a render node and so
   * is a `FabricValue` entire. The batch crosses inside the envelope's
   * encoding, which carries a `FabricPrimitive` with its class where a bare
   * structured clone stripped one to `{}`.
   */
  value: FabricValue;
};

/**
 * Remove a property from an element.
 */
export type RemovePropOp = {
  op: "remove-prop";
  nodeId: number;
  key: string;
};

/**
 * Set up an event listener on an element.
 * Events will be serialized and sent back to the worker.
 */
export type SetEventOp = {
  op: "set-event";
  nodeId: number;
  eventType: string;
  handlerId: number;
};

/**
 * Remove an event listener from an element.
 */
export type RemoveEventOp = {
  op: "remove-event";
  nodeId: number;
  eventType: string;
};

/**
 * Set up a bidirectional binding on an element.
 * The main thread will create a CellHandle from the cellRef
 * and pass it to the element's property.
 */
export type SetBindingOp = {
  op: "set-binding";
  nodeId: number;
  propName: string;
  cellRef: CellRef;
};

/** Associate a rendered nested pattern root with its whole result cell. */
export type SetPieceBoundaryOp = {
  op: "set-piece-boundary";
  nodeId: number;
  cellRef: CellRef;
};

/** Remove a nested pattern association from a reused root element. */
export type ClearPieceBoundaryOp = {
  op: "clear-piece-boundary";
  nodeId: number;
};

/**
 * Insert a child node into a parent.
 * If beforeId is null, appends to the end.
 */
export type InsertChildOp = {
  op: "insert-child";
  parentId: number;
  childId: number;
  beforeId: number | null;
};

/**
 * Remove a node from the DOM.
 */
export type RemoveNodeOp = {
  op: "remove-node";
  nodeId: number;
};

/**
 * Union of all VDOM operations.
 */
export type VDomOp =
  | CreateElementOp
  | CreateTextOp
  | UpdateTextOp
  | SetPropOp
  | RemovePropOp
  | SetEventOp
  | RemoveEventOp
  | SetBindingOp
  | SetPieceBoundaryOp
  | ClearPieceBoundaryOp
  | InsertChildOp
  | RemoveNodeOp;

/**
 * A batch of VDOM operations to be applied atomically.
 */
export type VDomBatch = {
  /** Identifier for this batch (for debugging/logging) */
  batchId: number;

  /** The operations to apply, in order */
  ops: readonly VDomOp[];

  /**
   * The root node ID for this render tree; `null` while the tree has no root
   * child, which the reconciler reports as a value rather than by omission.
   * Absent when the batch says nothing about the root at all.
   */
  rootId?: number | null;
};
