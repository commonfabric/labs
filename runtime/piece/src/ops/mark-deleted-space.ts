/**
 * Records a deleted space in Home's shared-space catalog, as the runtime that
 * hears of the deletion does (`docs/features/shared-space-catalog.md`,
 * "Deleted spaces"). The memory server writes nothing in anyone's catalog
 * when a space is deleted; a runtime that is refused the space with the
 * `deleted` marker sends Home's `markDeleted` for the entry it holds, at the
 * revision it observed, and Home's handler asks the server itself before it
 * writes.
 */

import type { Cell, MemorySpace } from "@commonfabric/runner";
import { sendEvent } from "@commonfabric/runner";

/**
 * What a runtime decided about marking a space deleted in Home's catalog:
 * `sent` when it sent the mark; `no-command` for a Home older than the
 * command; `not-listed` when the catalog has no entry for the space; and
 * `not-saved` when the entry is in a state a mark does not apply to, deleted
 * already among them.
 */
export type DeletionMarkDecision =
  | "sent"
  | "no-command"
  | "not-listed"
  | "not-saved";

/** What the decision reads of Home's catalog: each entry's state and revision. */
const catalogSchema = {
  type: "object",
  properties: {
    entries: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          state: { type: "string" },
          revision: { type: "string" },
        },
        required: ["state", "revision"],
        additionalProperties: true,
      },
    },
  },
  required: ["entries"],
  additionalProperties: true,
} as const;

/**
 * Sends `home`'s `markSharedSpaceDeleted` a mark for `space`, at the revision
 * its catalog entry has now, when the catalog holds the space as saved or
 * archived, and returns what it decided. `home` is the root of the identity's
 * Home. The mark asks nothing of the server here: Home's handler asks it, so a
 * mark for a space that is not deleted changes nothing. Two runtimes often
 * race to record one deletion, and the loser's `conflict` is expected, so
 * nothing here waits for the handling.
 */
export async function markDeletedSpaceOf(
  home: Cell<unknown>,
  space: MemorySpace,
): Promise<DeletionMarkDecision> {
  const markDeleted = home.key("markSharedSpaceDeleted");
  if (markDeleted.getRaw() === undefined) return "no-command";
  const catalog = await home.key("sharedSpaceCatalog").asSchema(catalogSchema)
    .pull();
  const entry = catalog?.entries[space];
  if (entry === undefined) return "not-listed";
  if (entry.state !== "saved" && entry.state !== "archived") {
    return "not-saved";
  }
  sendEvent(markDeleted, { space, expectedRevision: entry.revision });
  return "sent";
}
