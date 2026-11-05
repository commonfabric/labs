/**
 * Main-thread VDOM module.
 *
 * This module provides the DOM applicator and renderer for applying
 * VDomOp operations from the worker thread to the actual DOM.
 */

export { DomApplicator } from "./applicator.ts";
export type { DomApplicatorOptions } from "./applicator.ts";

export { VDomRenderer } from "./renderer.ts";
export {
  clearPieceBoundary,
  getPieceBoundary,
  type PieceBoundaryContext,
  provideElementSpace,
  providePieceBoundary,
  SPACE_CONTEXT_KEY,
  subscribePieceBoundary,
} from "./space-context.ts";
export type { VDomRendererOptions } from "./renderer.ts";

export {
  ALLOWLISTED_EVENT_PROPERTIES,
  ALLOWLISTED_TARGET_PROPERTIES,
  isDomEventMessage,
  serializeEvent,
} from "./events.ts";
export type {
  DomEventMessage,
  EventProvenance,
  SerializedEvent,
  SerializedEventTarget,
} from "./events.ts";
