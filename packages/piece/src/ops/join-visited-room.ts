/**
 * Joining a FabriChat room the user visits: the host vets the visited space
 * and its declared room, and tells Home's chat manager the
 * user has joined it, through its `joinRoom`. The manager makes the room one
 * of the user's chats, lists a forgotten one again, and leaves one they have
 * as it is. Which visits count as joining is the host's choice;
 * `docs/features/private-inbox.md` describes the labs shell's.
 */

import type { DID } from "@commonfabric/identity";
import {
  type Cell,
  isCell,
  type Runtime,
  sendEvent,
} from "@commonfabric/runner";
import { accessRefused } from "./space-access.ts";
import {
  CHAT_ROOM_SPACE_KIND,
  type SpaceRefusal,
  vetSpace,
  vetWritableSpaceRoot,
} from "./space-vetting.ts";

/**
 * What came of a visit: `sent` to the chat manager's `joinRoom`, skipped as
 * `no-chat-manager` for a Home whose chat manager has no `joinRoom`, or
 * refused, for the reason vetting gives.
 */
export type JoinVisitDecision =
  | "sent"
  | "no-chat-manager"
  | "chat-room-missing"
  | "chat-room-invalid"
  | SpaceRefusal;

/**
 * Tells the chat manager of `home`, the Home of `identity`, that the identity
 * has joined the room declared by `space`. A `fabrichat-room` space passes
 * strict `vetSpace()` vetting. Any other kind, including an undeclared kind,
 * uses its writable root's explicit `chatRoom` link. That link must name a
 * document in the same space, or a standalone room passing strict vetting.
 * A declaration-based event includes the root as `container`. Neither event
 * names a `requestId`, so the manager records nothing for an existing join.
 *
 * Resolves once the event is sent, which is before the manager has handled
 * it.
 *
 * @throws When reading what vetting needs fails other than by a refusal of
 *   access, or when the host cannot tell the space's kind.
 */
export async function joinVisitedRoomOf(
  runtime: Runtime,
  home: Cell<unknown>,
  identity: DID,
  space: DID,
): Promise<JoinVisitDecision> {
  const joinRoom = home.key("chatManager").key("joinRoom");
  if (joinRoom.getRaw() === undefined) return "no-chat-manager";
  const vetted = await vetSpace(runtime, space, identity, CHAT_ROOM_SPACE_KIND);
  if (isCell(vetted)) {
    sendEvent(joinRoom, { room: vetted });
    return "sent";
  }
  if (vetted !== "space-kind-undeclared" && vetted !== "space-kind-mismatch") {
    return vetted;
  }
  const root = await vetWritableSpaceRoot(runtime, space, identity);
  if (!isCell(root)) return root;

  const declaration = root.key("chatRoom");
  try {
    await declaration.pull();
  } catch (error) {
    if (accessRefused(runtime, declaration.resolveAsCell().space)) {
      return "recipient-access-refused";
    }
    throw error;
  }
  if (declaration.getRaw() == null) return "chat-room-missing";
  const room = declaration.resolveAsCell();
  if (room.getAsNormalizedFullLink().path.length !== 0) {
    return "chat-room-invalid";
  }
  if (room.space !== space) {
    const vetted = await vetSpace(
      runtime,
      room.space,
      identity,
      CHAT_ROOM_SPACE_KIND,
    );
    if (!isCell(vetted)) return vetted;
    if (!room.equalLinks(vetted)) return "chat-room-invalid";
  }
  if (room.getRaw() == null) return "chat-room-missing";
  sendEvent(joinRoom, { room, container: root });
  return "sent";
}
