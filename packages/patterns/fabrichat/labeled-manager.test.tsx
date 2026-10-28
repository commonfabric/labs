/**
 * A FabriChat room whose viewer's manager carries a confidentiality label the
 * room's space doesn't admit: a manager in a person's Home can come to carry
 * their `PersonalSpace` label. Nothing the room records about itself reads
 * the manager, so a send, a reaction, and a retitle still land; only what the
 * room derives from the manager is refused. That an add lands too is something only a room
 * in a space other than the test's own shows, so
 * `../integration/fabrichat-labeled-manager-multi-runtime.test.ts` checks it.
 */
import {
  type AddIntegrity,
  assert,
  type Confidential,
  pattern,
  SELF,
  TESTS,
  Writable,
} from "commonfabric";
import type { ParticipantRoster } from "../loom/participants.tsx";
import type { SharedSpaceCatalogStorage } from "../system/shared-space-catalog.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import { FabriChatMessageRow } from "./message-row.tsx";
import { type ComposerState, type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore, type RoomManager } from "./room.tsx";
import {
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_RETITLE_ACTION,
  CHAT_RETITLE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomLink,
  type TitleRecord,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];
type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

// A stand-in for a viewer's `#profile`, labeled as a Fabric profile is.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

// The label of the space a person's Home lives in, naming someone other than
// the test's space.
const HOME_LABEL = {
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
} as const;

/** The part of a manager a room reaches, carrying `HOME_LABEL`. */
type LabeledManager = Confidential<RoomManager, readonly [typeof HOME_LABEL]>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const reactGesture = { surface: CHAT_REACT_SURFACE, action: CHAT_REACT_ACTION };
const retitleGesture = {
  surface: CHAT_RETITLE_SURFACE,
  action: CHAT_RETITLE_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** A manager's room-facing part, as a document carrying `HOME_LABEL`. */
const LabelManager = pattern<{ manager: RoomManager }, LabeledManager>(
  ({ manager }) => manager as LabeledManager,
);

/** A room's own result, as the link a manager names the room by. */
function roomLinkOf(room: unknown): ChatRoomLink;
function roomLinkOf(room: unknown): unknown {
  return room;
}

export default pattern((input) => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const records = {
    messages,
    titles: Writable.of<TitleRecord[]>([]),
  };
  const core = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: Writable.of<SharedSpaceCatalogStorage>({
      entries: {},
      offers: {},
    }),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: Writable.of<Record<string, ChatRequestOutcome>>({}),
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const manager = LabelManager({
    manager: {
      offerRoom: core.offerRoom,
      requests: core.requests,
      people: core.people,
      joinRoom: core.joinRoom,
    } as RoomManager,
  });
  const self = roomLinkOf(input[SELF]);
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const, title: "Team" },
    ...records,
    roster: Writable.of<ParticipantRoster>({}),
    self,
    manager,
  } as RoomArg);
  const first = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: profile,
    inThread: false,
    kind: "group" as const,
    composer: Writable.of<ComposerState>({}),
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    openThreadKey: "",
    cannotWrite: false,
    isOwner: false,
    ...records,
    canJoin: true,
    manager,
    self,
  } as RowArg);

  return {
    [TESTS]: [
      {
        action: room.sendMessage,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      { assertion: assert(() => messages.get().length === 1) },
      {
        action: first.sendReaction,
        event: { emoji: "🎉" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() =>
          (messages.key(0).get()?.reactions?.get() ?? []).length === 1
        ),
      },
      {
        action: room.setTitle,
        event: { requestId: "t-1", title: "Plans" },
        trustedUi: retitleGesture,
      },
      {
        assertion: assert(() =>
          room.about.title === "Plans" &&
          room.titleRequests["t-1"]?.status === "done"
        ),
      },
    ],
    // What the room derives from the manager, such as whether it can ask the
    // manager anything, is refused, and so reported.
    allowRuntimeErrors: true,
    allowConsoleWarnings: true,
  };
});
