// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * A Loom whose space's owner can lower a member to READ: fixture for
 * `integration/loom-chat-room-multi-runtime.test.ts`. It lives outside
 * `integration/` because the Loom root it composes is checked by `cfcheck`, in
 * the environment patterns compile under, and not by `deno task check`.
 */

import {
  Default,
  type DID,
  grantSpaceAccess,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import Loom from "../loom/main.tsx";
import type {
  ChatRoomChoice,
  LinkedChatRoom,
  Panel,
} from "../loom/schemas.tsx";

interface MemberEvent {
  principal: DID;
}

const lowerToRead = handler<MemberEvent, { members: Writable<DID[]> }>(
  (event, { members }) => {
    grantSpaceAccess(members, event.principal, "READ");
    members.addUnique(event.principal);
  },
);

interface ChatRoomFixtureInput {
  members: Writable<Default<DID[], []>>;
}

interface ChatRoomFixtureOutput {
  [NAME]: string;
  [UI]: VNode;
  panels: Writable<Panel>[];
  pieceRegistry: Writable<unknown>[];
  chatRoom?: Writable<LinkedChatRoom>;
  setChatRoom: Stream<ChatRoomChoice>;
  ensureChatRoom: Stream<void>;

  /** Lowers `principal` to READ in the Loom's space, as a trusted gesture. */
  lowerToRead: Stream<MemberEvent>;
}

export default pattern<ChatRoomFixtureInput, ChatRoomFixtureOutput>((
  { members },
) => {
  const loom = Loom({});
  return {
    [NAME]: "Loom chat room fixture",
    [UI]: <div />,
    panels: loom.panels,
    pieceRegistry: loom.pieceRegistry,
    chatRoom: loom.chatRoom,
    setChatRoom: loom.setChatRoom,
    ensureChatRoom: loom.ensureChatRoom,
    lowerToRead: lowerToRead({ members }),
  };
});
