/**
 * Places one conversation in a container using a room link. The placement
 * offers the room's data face and sends every writer directly to the room.
 */

import {
  type Cell,
  computed,
  pattern,
  type PerSpace,
  spaceAccess,
  VIEWS,
} from "commonfabric";
import type {
  ChatMessageList,
  ChatProfile,
  ChatReactionTallies,
  ChatRoomAbout,
  ChatRoomActivity,
  ChatRoomOutput,
} from "./schemas.ts";

/** The facts exposed by a placed conversation. */
export interface ChatPlacementView {
  state: "member" | "not-member" | "unavailable";
  messages?: Cell<ChatMessageList>;
  canSend?: Cell<boolean>;
  about?: Cell<ChatRoomAbout>;
  recentActivity?: Cell<ChatRoomActivity[]>;
  participants?: Cell<Cell<ChatProfile>[]>;
  reactionTallies?: Cell<ChatReactionTallies[]>;
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
>(({ room }) => {
  const state = computed(() => {
    const access = spaceAccess(room);
    return access === "member" && !room.key("about").get()
      ? "unavailable"
      : access;
  });
  return {
    room,
    [VIEWS]: {
      chat: {
        state,
        messages: computed(() =>
          state === "member" ? room.key("messages") : undefined
        ),
        canSend: computed(() =>
          state === "member" ? room.key("canSend") : undefined
        ),
        about: computed(() =>
          state === "member" ? room.key("about") : undefined
        ),
        recentActivity: computed(() =>
          state === "member" ? room.key("recentActivity") : undefined
        ),
        participants: computed(() =>
          state === "member" ? room.key("participants") : undefined
        ),
        reactionTallies: computed(() =>
          state === "member" ? room.key("reactionTallies") : undefined
        ),
      },
    },
  };
});

export default FabriChatPlacement;
