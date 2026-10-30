/** Demands the reads needed to construct a test action's event. */

import { type Cell, pullProjected } from "@commonfabric/runner";
import { buildActionEvent } from "./trusted-action-event.ts";

/**
 * Returns the ready-to-send event: a trusted wrapper when `trustedUi` is a valid
 * descriptor, or the unwrapped payload otherwise. Demand covers the root view and
 * fields copied into a wrapper. Resolving either can follow pointers; nested
 * query views retain their references for serialization and the handler's reads.
 */
export function pullActionEvent(
  event: Cell<unknown>,
  trustedUi: unknown,
): Promise<unknown> {
  return pullProjected(
    event.asSchema(true),
    (value) => buildActionEvent(value, trustedUi),
  );
}
