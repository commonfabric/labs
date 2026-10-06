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
import { FabriChatMessageRow } from "./message-row.tsx";
import {
  type ActivityCounters,
  type ComposerState,
  type MessageRecord,
  type MessagesValue,
  type ReactionList,
  type RequestMemo,
  type SentActivity,
  type UsedTime,
} from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = {
  surface: CHAT_SEND_SURFACE,
  action: CHAT_SEND_ACTION,
};
const obliterateGesture = {
  surface: CHAT_OBLITERATE_SURFACE,
  action: CHAT_OBLITERATE_ACTION,
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
  // Alice and Bob run here as this lane's one principal, which holds OWNER in
  // the room's space, so what tells them apart is their profiles alone.
  const records = {
    about: { kind: "direct" as const },
    messages,
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters[]>([]),
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
  const bobOnHis = FabriChatMessageRow({
    message: messages.key(1),
    myProfile: bobProfile,
    ...rowRecords,
  } as RowArg);

  return {
    [TESTS]: [
      {
        action: alice.sendMessage,
        event: typed("From Alice"),
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: typed("From Bob"),
        trustedUi: sendGesture,
      },
      // Neither may obliterate the other's message, OWNER access
      // notwithstanding.
      {
        action: bobOnHers.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        action: aliceOnHis.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() => bodies(messages) === "From Alice | From Bob"),
      },
      // Each may obliterate their own.
      {
        action: aliceOnHers.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          bodies(messages) === "<obliterated> | From Bob"
        ),
      },
      {
        action: bobOnHis.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          bodies(messages) === "<obliterated> | <obliterated>"
        ),
      },
    ],
  };
});
