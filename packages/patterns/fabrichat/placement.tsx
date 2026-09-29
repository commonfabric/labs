/**
 * `FabriChatPlacement`: one room placed in a container, a space that shows
 * chats among other things (`docs/specs/fabrichat/FabriChatPlacement.md`).
 *
 * It holds a link to its room and nothing read from it, and it has no
 * rendering. Everything it offers is read through the link when it is read,
 * under the viewer's own access, and offered as the `chat` group of its
 * `[VIEWS]`. `FabriChatAdapter` renders it.
 */
import {
  type Cell,
  computed,
  equals,
  NAME,
  pattern,
  VIEWS,
  wish,
} from "commonfabric";
import {
  type ChatReaction,
  type ChatRoomAbout,
  type ChatRoomActivity,
  type ProfileCell,
} from "./schemas.tsx";

/** How one emoji stands on one message, as a placement offers it. */
export interface PlacedTally {
  /** The emoji. */
  emoji: string;

  /** How many people reacted with it. */
  count: number;

  /** Whether the viewer is one of them. */
  mine: boolean;

  /** Their profiles. */
  reactors: ProfileCell[];
}

/** One message's reaction tallies. */
export interface PlacedTallies {
  /** The message. */
  message: Cell<unknown>;

  /** Its reactions, by emoji, in the order each was first used. */
  tallies: PlacedTally[];
}

/** A message as a placement reads it: only its reactions. */
interface PlacedMessage {
  /** Everyone's reactions to the message. */
  reactions?: ChatReaction[];
}

/** A room's message list as a placement reads it. */
export interface PlacedMessageList {
  /** How many messages the room holds. */
  count?: number;

  /** The newest messages of the main conversation. */
  latest?: { messages?: Cell<PlacedMessage>[]; hasOlder?: boolean };

  /** The reading session's windows. */
  windows?: Record<string, { messages?: Cell<PlacedMessage>[] }>;
}

/**
 * A room as a placement reads it through its link: only the part of
 * `ChatRoomOutput` it offers.
 */
export interface PlacedRoom {
  /** What the room says about itself. */
  about?: ChatRoomAbout;

  /** What the room recorded recently. */
  recentActivity?: ChatRoomActivity[];

  /** The room's participants. */
  participants?: ProfileCell[];

  /** The room's messages. */
  messages?: PlacedMessageList;

  /** Whether the reader can send. */
  canSend?: boolean;
}

/** Whether the viewer can read a placed room. */
export type PlacementState = "member" | "not-member" | "unavailable";

/** A placement's data face: what a placed chat holds, and what the viewer may see. */
export interface FabriChatPlacementView {
  /** Whether the viewer can read the room. */
  state: PlacementState;

  /** What the room says about itself; absent unless `state` is `"member"`. */
  about?: ChatRoomAbout;

  /** The room's messages; absent unless `state` is `"member"`. */
  messages?: PlacedMessageList;

  /** Whether the viewer can send. */
  canSend: boolean;

  /** What the room recorded recently. */
  recentActivity: ChatRoomActivity[];

  /** The room's participants. */
  participants: ProfileCell[];

  /** Reactions on the newest messages and on the session's windows. */
  reactionTallies: PlacedTallies[];
}

/** What a placement holds. */
export interface FabriChatPlacementInput {
  /** The room, set when the placement is created. */
  room: Cell<PlacedRoom>;
}

/** What a placement offers. */
export interface FabriChatPlacementOutput {
  /**
   * The placed room's title, for lists of pieces: `"Chat"` for a room with no
   * title, and `"Chat (unavailable)"` for a room the viewer can't read.
   */
  [NAME]: string;

  /** The room, so a client can reach its own streams. */
  room: Cell<PlacedRoom>;

  /** The placement's data face. */
  [VIEWS]: { chat: FabriChatPlacementView };
}

/**
 * `reactions`, by emoji, in the order each was first used, with whether
 * `viewer` is among each emoji's reactors.
 */
export const talliesOf = (
  reactions: readonly ChatReaction[],
  viewer: ProfileCell | undefined,
): PlacedTally[] => {
  const ordered = [...reactions]
    .filter((reaction) => reaction?.sentAt !== undefined)
    .sort((a, b) =>
      a.sentAt.value < b.sentAt.value
        ? -1
        : a.sentAt.value > b.sentAt.value
        ? 1
        : 0
    );
  return ordered.reduce<string[]>(
    (found, reaction) =>
      found.includes(reaction.emoji) ? found : [...found, reaction.emoji],
    [],
  ).map((emoji) => {
    const onThis = ordered.filter((reaction) => reaction.emoji === emoji);
    return {
      emoji,
      count: onThis.length,
      mine: viewer !== undefined &&
        onThis.some((reaction) => equals(reaction.reactorProfile, viewer)),
      reactors: onThis.map((reaction) => reaction.reactorProfile),
    };
  });
};

/**
 * A room placed in a container. The viewer's own access decides what it
 * offers: a viewer who can't read the room sees that there is one, and
 * nothing of it.
 */
const FabriChatPlacement = pattern<
  FabriChatPlacementInput,
  FabriChatPlacementOutput
>(({ room }) => {
  // Wished for as a cell, which the tallies compare reactors against; the
  // placement never tests it for absence, which a cell's handle would defeat.
  const profileWish = wish<ProfileCell>({ query: "#profile" });
  const viewer = profileWish.result;
  const about = computed(() => room.get()?.about);
  // A pattern can't read its viewer's access, so a room it can't read is
  // unavailable to it, whether or not the viewer is a member.
  const state = computed((): PlacementState =>
    about?.kind === undefined ? "unavailable" : "member"
  );
  const isMember = computed(() => state === "member");
  const messages = computed(() => isMember ? room.get()?.messages : undefined);
  const reactionTallies = computed((): PlacedTallies[] => {
    const list = isMember ? room.get()?.messages : undefined;
    const shown = [
      ...(list?.latest?.messages ?? []),
      ...Object.values(list?.windows ?? {}).flatMap((window) =>
        window?.messages ?? []
      ),
    ];
    const distinct = shown.reduce<Cell<PlacedMessage>[]>(
      (found, message) =>
        found.some((known) => equals(known, message))
          ? found
          : [...found, message],
      [],
    );
    return distinct.map((message) => ({
      message,
      tallies: talliesOf(message.get()?.reactions ?? [], viewer),
    }));
  });
  const chat = {
    state,
    about: computed(() => (isMember ? about : undefined)),
    messages,
    canSend: computed(() => isMember && room.get()?.canSend === true),
    recentActivity: computed(() =>
      isMember ? [...(room.get()?.recentActivity ?? [])] : []
    ),
    participants: computed(() =>
      isMember ? [...(room.get()?.participants ?? [])] : []
    ),
    reactionTallies,
  };

  return {
    [NAME]: computed(() =>
      isMember ? about?.title ?? "Chat" : "Chat (unavailable)"
    ),
    room,
    [VIEWS]: { chat },
  };
});

export default FabriChatPlacement;
