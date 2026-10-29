/**
 * A FabriChat room whose viewer's profile is the person's own, held per user
 * as a Home holds the profile a `#profile` wish finds, readable by that person
 * alone, and read through it as a room reads its viewer's profile. A session
 * whose reads stop short of the person's own data reads no profile, as a
 * session whose wish hasn't resolved does. The room's messages live in the
 * harness's space, whose owner can grant another person READ in it. The
 * fixture's rendering is the room's own. Fixture for
 * `fabrichat-room-viewer-multi-runtime.test.ts`.
 */

import {
  type Cell,
  type Confidential,
  type CurrentPrincipal,
  type DID,
  grantSpaceAccess,
  handler,
  NAME,
  pattern,
  type PerSession,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  type ChatMessageRights,
  type ChatRoomViewer,
  FabriChatRoomCore,
} from "../../../system/fabrichat/room.tsx";
import type {
  MessagesValue,
  RoomStreamEvent,
} from "../../../system/fabrichat/room-records.tsx";
import type {
  AboutRecord,
  ChatProfile,
  ProfileCell,
} from "../../../system/fabrichat/schemas.tsx";

/** A value readable only by the principal whose instance holds it. */
type PersonPrivate<T> = Confidential<
  T,
  readonly [{
    type: "https://commonfabric.org/cfc/atom/User";
    subject: CurrentPrincipal;
  }]
>;

/** Where the person's profile is held, for every session of theirs. */
type ProfileHolder = Writable<PersonPrivate<ProfileCell | undefined>>;

/** The person's profile as a room's viewer, which holds none until it's set. */
function viewerProfileOf(holder: ProfileHolder): ProfileCell | undefined;
function viewerProfileOf(holder: ProfileHolder): unknown {
  return holder;
}

/** What using a profile asks: the profile, as the link a session holds. */
interface UseProfileEvent {
  /** The profile. */
  profile: Cell<ChatProfile>;
}

/** Makes the event's profile the person's own, for every session of theirs. */
const useProfile = handler<UseProfileEvent, { profile: ProfileHolder }>(
  (event, { profile }) => {
    profile.set(event.profile);
  },
);

/** What granting READ asks: the person to grant it to. */
interface GrantReadEvent {
  /** The principal granted READ. */
  principal: DID;
}

/** Grants the event's principal READ in the space the room's messages live in. */
const grantRead = handler<
  GrantReadEvent,
  { messages: Writable<MessagesValue> }
>((event, { messages }) => {
  grantSpaceAccess(messages, event.principal, "READ");
});

export interface MainOutput {
  [NAME]: string;
  [UI]: VNode;

  /** Whether the reader can send in the room. */
  canSend: PerSession<boolean>;

  /** Who the room says is reading it. */
  viewer: PerSession<ChatRoomViewer>;

  /** What the reader may do to each of the room's messages. */
  messageRights: PerSession<ChatMessageRights[]>;

  /** Whether the reader can add someone to the room. */
  canAdd: PerSession<boolean>;

  /** Makes a profile the person's own. */
  useProfile: Stream<UseProfileEvent>;

  /** Grants a principal READ in the room's space. */
  grantRead: Stream<GrantReadEvent>;

  /** Sends a message to the room. */
  sendMessage: Stream<RoomStreamEvent>;
}

export default pattern<Record<string, never>, MainOutput>(() => {
  const profile: ProfileHolder = new Writable.perUser<
    PersonPrivate<ProfileCell | undefined>
  >(undefined).for("profile");
  const messages = new Writable<MessagesValue>([]).for("messages");
  const about = new Writable<AboutRecord>({ kind: "group" }).for("about");
  const room = FabriChatRoomCore({
    myProfile: viewerProfileOf(profile),
    about,
    messages,
  });
  return {
    [NAME]: "FabriChat room viewer fixture",
    [UI]: room[UI],
    canSend: room.canSend,
    viewer: room.viewer,
    messageRights: room.messageRights,
    canAdd: room.canAdd,
    useProfile: useProfile({ profile }),
    grantRead: grantRead({ messages }),
    sendMessage: room.sendMessage,
  };
});
