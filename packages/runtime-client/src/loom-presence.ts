/**
 * The presence room of a Loom: where every client with a socialized Loom
 * open meets, in the memory relay's presence rooms. A Loom's room is derived
 * from an anchor cell its space derives from a fixed cause and that nothing
 * writes, so the room is the space's, and a client that knows the space
 * joins it with no record of the Loom in hand. The anchor exists only to
 * name the room: the shared note's editors meet in the room of the note's
 * text field, a different room of the same relay.
 */

import type { DID } from "@commonfabric/identity";

import type { PresenceRoomHandle, RuntimeClient } from "./runtime-client.ts";

/**
 * The cause the anchor cell of `space`'s Loom presence room is derived from.
 * Every client derives the same anchor from it, which is what makes the room
 * a rendezvous; the cell it names holds nothing.
 */
export const loomPresenceAnchorCause = (
  space: DID,
): { loomPresence: DID } => ({ loomPresence: space });

/**
 * Joins the presence room of the Loom whose space is `space`, through
 * `runtime`'s session, and returns the handle on it. The room is derived
 * from the anchor {@link loomPresenceAnchorCause} names, so a second join
 * of the same space's room shares its membership, as
 * `RuntimeClient.joinPresenceRoom()` says. Rejects as that join does: when
 * the runtime's storage or its server does not support presence, or when
 * the session has no access to the space.
 */
export async function joinLoomPresenceRoom(
  runtime: RuntimeClient,
  space: DID,
): Promise<PresenceRoomHandle> {
  const anchor = await runtime.getCell(space, loomPresenceAnchorCause(space));
  return await runtime.joinPresenceRoom(anchor);
}
