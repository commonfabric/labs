/**
 * A FabriChat room as a person's runtime runs it, reading its viewer from the
 * person's own `#profile` wish, beside a place to hold a profile that the
 * person's home can then list. Fixture for
 * `fabrichat-room-profile-wish-multi-runtime.test.ts`.
 */

import {
  type Cell,
  handler,
  NAME,
  pattern,
  type PerSession,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import FabriChatRoom, {
  type ChatMessageRights,
  type ChatRoomViewer,
} from "../../../system/fabrichat/room.tsx";
import type { RoomStreamEvent } from "../../../system/fabrichat/room-records.tsx";
import type { ChatProfile } from "../../../system/fabrichat/schemas.tsx";

/** What holding a profile asks: the profile, as the link a session holds. */
interface HoldProfileEvent {
  /** The profile. */
  profile: Cell<ChatProfile>;
}

/** Holds the event's profile where the person's home can be pointed at it. */
const holdProfile = handler<
  HoldProfileEvent,
  { profile: Writable<Cell<ChatProfile> | undefined> }
>((event, { profile }) => {
  profile.set(event.profile);
});

export interface MainOutput {
  [NAME]: string;
  [UI]: VNode;

  /** Whether the reader can send in the room: each session's own. */
  canSend: PerSession<boolean>;

  /** Who the room says is reading it: each session's own. */
  viewer: PerSession<ChatRoomViewer>;

  /** What the reader may do to each message: each session's own. */
  messageRights: PerSession<ChatMessageRights[]>;

  /** Sends a message to the room. */
  sendMessage: Stream<RoomStreamEvent>;

  /** The profile held for the person's home to list. */
  profile: Cell<ChatProfile> | undefined;

  /** Holds a profile for the person's home to list. */
  holdProfile: Stream<HoldProfileEvent>;
}

export default pattern<Record<string, never>, MainOutput>(() => {
  const profile = new Writable<Cell<ChatProfile> | undefined>(undefined)
    .for("profile");
  const room = FabriChatRoom({});
  return {
    [NAME]: "FabriChat room profile wish fixture",
    [UI]: room[UI],
    canSend: room.canSend,
    viewer: room.viewer,
    messageRights: room.messageRights,
    sendMessage: room.sendMessage,
    profile,
    holdProfile: holdProfile({ profile }),
  };
});
