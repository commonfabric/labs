/**
 * Obliteration in a FabriChat direct room: either person may obliterate their
 * own messages, and neither may obliterate the other's, the room's creator
 * included.
 */
import {
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import {
  type ActivityCounters,
  type ComposerState,
  FabriChatMessageRow,
  FabriChatRoomCore,
  type MessageRecord,
  type MessagesValue,
  type ReactionList,
  type RequestMemo,
  type RosterValue,
  type SentActivity,
  type UsedTime,
} from "./room.tsx";
import {
  CHAT_MESSAGE_ACTION,
  CHAT_MESSAGE_SURFACE,
  type ChatProfile,
  type ChatRoomNotice,
  type ProfileCell,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const messageGesture = {
  surface: CHAT_MESSAGE_SURFACE,
  action: CHAT_MESSAGE_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

// Each message's body, or how it was taken away.
const bodies = (messages: Writable<MessagesValue>): string =>
  ((messages.get() ?? []) as MessageRecord[]).map((message) =>
    typeof message?.body === "string"
      ? message.body
      : message?.authorProfile === undefined
      ? "<obliterated>"
      : "<deleted>"
  ).join(" | ");

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  // Alice created the room, so she is the one OWNER the room knows.
  const records = {
    about: { kind: "direct" as const },
    ownSpace: true,
    creatorProfile: aliceProfile,
    messages,
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters>({ nextSeq: 1, expiredThrough: 0 }),
    roster: Writable.of<RosterValue>({}),
    left: Writable.of<ProfileCell[]>([]),
    notices: Writable.of<ChatRoomNotice[]>([]),
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const bob = FabriChatRoomCore(
    { myProfile: bobProfile, ...records } as RoomArg,
  );
  const rowRecords = {
    inThread: false,
    kind: "direct" as const,
    composer: Writable.of<ComposerState>({}),
    ...records,
  };
  const aliceOnHers = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: aliceProfile,
    ...rowRecords,
  } as RowArg);
  const bobOnHers = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: bobProfile,
    ...rowRecords,
  } as RowArg);
  const aliceOnHis = FabriChatMessageRow({
    message: messages.key(1),
    myProfile: aliceProfile,
    ...rowRecords,
  } as RowArg);

  return {
    [TESTS]: [
      {
        action: alice.sendMessage,
        event: typed("From Alice"),
        trustedUi: messageGesture,
      },
      {
        action: bob.sendMessage,
        event: typed("From Bob"),
        trustedUi: messageGesture,
      },
      // Neither may obliterate the other's message, Alice's OWNER access
      // notwithstanding.
      {
        action: bobOnHers.obliterateMessage,
        event: {},
        trustedUi: messageGesture,
      },
      {
        action: aliceOnHis.obliterateMessage,
        event: {},
        trustedUi: messageGesture,
      },
      {
        assertion: assert(() => bodies(messages) === "From Alice | From Bob"),
      },
      // Each may obliterate their own.
      {
        action: aliceOnHers.obliterateMessage,
        event: {},
        trustedUi: messageGesture,
      },
      {
        assertion: assert(() =>
          bodies(messages) === "<obliterated> | From Bob"
        ),
      },
    ],
  };
});
