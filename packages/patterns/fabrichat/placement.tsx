/**
 * Places one conversation in a container using a room link. The placement
 * offers the room's data face and sends every writer directly to the room.
 */

import {
  type Cell,
  computed,
  pattern,
  type PerSpace,
  VIEWS,
} from "commonfabric";
import type {
  ChatMessageList,
  ChatProfile,
  ChatRoomAbout,
  ChatRoomActivity,
  ChatRoomOutput,
} from "./schemas.ts";

/** The facts exposed by a placed conversation. */
export interface ChatPlacementView {
  state: "member" | "not-member" | "unavailable";
  messages: Cell<ChatMessageList>;
  canSend: Cell<boolean>;
  about: Cell<ChatRoomAbout>;
  recentActivity: Cell<ChatRoomActivity[]>;
  participants: Cell<Cell<ChatProfile>[]>;
}

/** One immutable room reference in a container. */
export interface ChatPlacementOutput {
  room: PerSpace<Cell<ChatRoomOutput>>;
  [VIEWS]: { chat: ChatPlacementView };
}

/** A placement that retains room data behind its original cross-space links. */
export const FabriChatPlacement = pattern<
  { room: PerSpace<Cell<ChatRoomOutput>> },
  ChatPlacementOutput
>(({ room }) => ({
  room,
  [VIEWS]: {
    chat: {
      state: computed(() => room.key("about").get() ? "member" : "unavailable"),
      messages: room.key("messages"),
      canSend: room.key("canSend"),
      about: room.key("about"),
      recentActivity: room.key("recentActivity"),
      participants: room.key("participants"),
    },
  },
}));

export default FabriChatPlacement;
