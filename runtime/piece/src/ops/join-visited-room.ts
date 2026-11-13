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
 * The room `space` declares, as a `joinRoom` names it, once it passes
 * vetting: a vetted standalone room, or the room its writable root's explicit
 * `chatRoom` link names, with the root as `container`.
 */
export interface VisitedRoom {
  /** The room. */
  room: Cell<unknown>;

  /** The root declaring the room, for a room its space's root declares. */
  container?: Cell<unknown>;
}

/**
 * Vets the room `space` declares for `identity`, as `joinVisitedRoomOf()`
 * says, and returns it, or the reason vetting gives for refusing it. A
 * refusal for want of a declaration, `chat-room-missing` or
 * `chat-room-invalid`, comes with the writable root it read, as `root`.
 *
 * @throws When reading what vetting needs fails other than by a refusal of
 *   access, or when the host cannot tell the space's kind.
 */
export async function visitedRoomOf(
  runtime: Runtime,
  identity: DID,
  space: DID,
): Promise<
  | VisitedRoom
  | { refusal: "chat-room-missing" | "chat-room-invalid"; root: Cell<unknown> }
  | { refusal: SpaceRefusal }
> {
  const vetted = await vetSpace(runtime, space, identity, CHAT_ROOM_SPACE_KIND);
  if (isCell(vetted)) return { room: vetted };
  if (vetted !== "space-kind-undeclared" && vetted !== "space-kind-mismatch") {
    return { refusal: vetted };
  }
  const root = await vetWritableSpaceRoot(runtime, space, identity);
  if (!isCell(root)) return { refusal: root };

  const declaration = root.key("chatRoom");
  try {
    await declaration.pull();
  } catch (error) {
    if (accessRefused(runtime, declaration.resolveAsCell().space)) {
      return { refusal: "recipient-access-refused" };
    }
    throw error;
  }
  if (declaration.getRaw() == null) {
    return { refusal: "chat-room-missing", root };
  }
  const room = declaration.resolveAsCell();
  if (room.getAsNormalizedFullLink().path.length !== 0) {
    return { refusal: "chat-room-invalid", root };
  }
  if (room.space !== space) {
    const vetted = await vetSpace(
      runtime,
      room.space,
      identity,
      CHAT_ROOM_SPACE_KIND,
    );
    if (!isCell(vetted)) return { refusal: vetted };
    if (!room.equalLinks(vetted)) return { refusal: "chat-room-invalid", root };
  }
  if (room.getRaw() == null) return { refusal: "chat-room-missing", root };
  return { room, container: root };
}

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
  const visited = await visitedRoomOf(runtime, identity, space);
  if ("refusal" in visited) return visited.refusal;
  sendEvent(joinRoom, visited);
  return "sent";
}
