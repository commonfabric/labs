/** Demands the reads needed to construct a test action's event. */

import { type Cell, pullProjected } from "@commonfabric/runner";
import { buildActionEvent } from "./trusted-action-event.ts";

/**
 * Waits for fields copied into a trusted event wrapper. Nested query views
 * retain their references for event serialization and the handler's reads.
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
