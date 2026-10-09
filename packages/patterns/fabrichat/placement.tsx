/**
 * Places one conversation in a container using a room link. The placement
 * offers the room's data face and sends every writer directly to the room.
 */

import {
  type Cell,
  computed,
  type Default,
  NAME,
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
  ChatRoomFacts,
  ChatRoomOutput,
} from "./schemas.tsx";

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

/** The room protocol, including optional capabilities a placement never calls. */
export type PlacedRoom =
  & Omit<
    ChatRoomOutput,
    "addMember" | "addParticipant" | typeof NAME | typeof VIEWS
  >
  & {
    [NAME]?: string;
    addMember?: ChatRoomOutput["addMember"];
    addParticipant?: ChatRoomOutput["addParticipant"];
    [VIEWS]: {
      room: Omit<ChatRoomFacts, "addParticipant"> & {
        addParticipant?: ChatRoomFacts["addParticipant"];
      };
    };
  };

/** One immutable room reference in a container. */
export interface ChatPlacementOutput {
  [NAME]: Default<string, "Chat">;
  room: PerSpace<Cell<PlacedRoom>>;
  [VIEWS]: { chat: ChatPlacementView };
}

/** A placement that retains room data behind its original cross-space links. */
export const FabriChatPlacement = pattern<
  { room: PerSpace<Cell<PlacedRoom>> },
  ChatPlacementOutput
>(({ room }) => {
  const state = computed(() => {
    const access = spaceAccess(room);
    if (access === undefined) return "unavailable";
    if (access === "none") return "not-member";
    const about = room.key("about").get();
    if (!about?.kind) return "unavailable";
    return "member";
  });
  return {
    [NAME]: "Chat",
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
