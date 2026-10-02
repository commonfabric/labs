/**
 * Worker-side VDOM module.
 *
 * This module provides the reconciler and utilities for worker-thread
 * VDOM rendering. It emits VDomOp operations that are sent to the main
 * thread for DOM application.
 */

export { WorkerReconciler } from "./reconciler.ts";
export {
  admitsEverything,
  canRenderCellUnderPolicy,
  canRenderLabelUnderPolicy,
  cellLabelRefusal,
  cellLabelSources,
  type DisplayFitSources,
  type MembershipWatch,
  readRefusal,
  type RenderLabelSummary,
  rootRenderPolicyFor,
} from "./display-fit.ts";
export { generateChildKeys, generateKey } from "./keying.ts";
export { CFC_POLICY_PLACEHOLDER_TEXT } from "../render-utils.ts";
export type {
  BindingCellRef,
  ChildNodeState,
  NodeState,
  ReconcileContext,
  RenderConfidentialityCeiling,
  RenderDeclassificationPolicy,
  RenderPolicy,
  SpaceAccessProvider,
  WorkerJSXElement,
  WorkerProps,
  WorkerReconcilerOptions,
  WorkerRenderNode,
  WorkerVNode,
} from "./types.ts";
export {
  isWorkerVNode,
  normalizeRenderConfidentialityCeiling,
  normalizeRenderDeclassificationPolicy,
} from "./types.ts";
