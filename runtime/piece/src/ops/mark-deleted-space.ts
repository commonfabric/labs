/**
 * Records a deleted space in Home, as the runtime that hears of the deletion
 * does: in its shared-space catalog (`docs/features/shared-space-catalog.md`,
 * "Deleted spaces") and, for a profile's space, among its retired profiles
 * (`docs/common/conventions/HOME_SPACE.md`). The memory server writes nothing
 * in anyone's Home when a space is deleted; a runtime that is refused the
 * space with the `deleted` marker sends Home's `markDeleted` for the catalog
 * entry it holds, at the revision it observed, and Home's `retireProfile` for
 * the profile it lists, and Home's handlers ask the server themselves before
 * they write.
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

/**
 * What a runtime decided about retiring the profile whose space is deleted:
 * `sent` when it sent the retirement; `no-command` for a Home older than
 * `retireProfile`; `not-listed` when Home's `profiles` name no profile in the
 * space; and `retired` when that profile is retired already.
 */
export type ProfileRetirementDecision =
  | "sent"
  | "no-command"
  | "not-listed"
  | "retired";

/** A list of links, each read as the cell it names, its content unread. */
const linksSchema = {
  type: "array",
  items: { asCell: ["cell"] },
} as const;

/**
 * Sends `home`'s `retireProfile` for the profile its `profiles` list holds in
 * `space`, when one is listed and not retired already, and returns what it
 * decided. `home` is the root of the identity's Home. It asks nothing of the
 * server here: Home's handler asks whether the space is deleted, so a
 * retirement of a profile whose space is not deleted meets the handler's
 * usual refusals. Nothing here waits for the handling.
 */
export async function retireDeletedProfileOf(
  home: Cell<unknown>,
  space: MemorySpace,
): Promise<ProfileRetirementDecision> {
  const retire = home.key("retireProfile");
  if (retire.getRaw() === undefined) return "no-command";
  const [profiles, retired] = await Promise.all([
    home.key("profiles").asSchema(linksSchema).pull(),
    home.key("retiredProfiles").asSchema(linksSchema).pull(),
  ]);
  const inSpace = (link: Cell<unknown>) =>
    link.getAsNormalizedFullLink().space === space;
  const profile = (profiles ?? []).find(inSpace);
  if (profile === undefined) return "not-listed";
  if ((retired ?? []).some(inSpace)) return "retired";
  sendEvent(retire, { profile });
  return "sent";
}
