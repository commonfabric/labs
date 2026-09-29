/**
 * Reactions in a FabriChat room: what a reaction stores, that adding or
 * removing one is idempotent rather than a toggle, which reactions are
 * refused, how a message tallies its own, and that deleting a message takes
 * its reactions with it.
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
  type ReactionTally,
  type RequestMemo,
  type RosterValue,
  type SentActivity,
  type UsedTime,
} from "./room.tsx";
import {
  CHAT_MESSAGE_ACTION,
  CHAT_MESSAGE_SURFACE,
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  type ChatProfile,
  type ChatReaction,
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
const reactGesture = { surface: CHAT_REACT_SURFACE, action: CHAT_REACT_ACTION };

const typed = (text: string) => ({ type: "click", target: { value: text } });

// A row's tallies, as `emoji count` with a `*` on the viewer's own, so that an
// assertion's failure shows the whole row.
const talliesText = (tallies: readonly ReactionTally[]): string =>
  tallies.map((tally) =>
    `${tally.emoji} ${tally.count}${tally.mine ? "*" : ""}`
  ).join(", ");

const reactionsOn = (
  messages: Writable<MessagesValue>,
  index: number,
): ChatReaction[] => {
  const message = (messages.get() as MessageRecord[])[index];
  return (message?.reactions?.get() ?? []) as ChatReaction[];
};

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const records = {
    about: { kind: "group" as const },
    ownSpace: false,
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
  const rowRecords = {
    threadReplies: 0,
    inThread: false,
    kind: "group" as const,
    composer: Writable.of<ComposerState>({}),
    ...records,
  };
  const aliceOnFirst = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: aliceProfile,
    ...rowRecords,
  } as RowArg);
  const bobOnFirst = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: bobProfile,
    ...rowRecords,
  } as RowArg);
  const aliceOnSecond = FabriChatMessageRow({
    message: messages.key(1),
    myProfile: aliceProfile,
    ...rowRecords,
  } as RowArg);

  return {
    [TESTS]: [
      {
        action: alice.sendMessage,
        event: typed("First"),
        trustedUi: messageGesture,
      },
      {
        action: alice.sendMessage,
        event: typed("Second"),
        trustedUi: messageGesture,
      },
      // Any single emoji is a reaction; text, and two emoji together, are not.
      {
        action: aliceOnFirst.sendReaction,
        event: { requestId: "a1", emoji: "👍🏽" },
        trustedUi: reactGesture,
      },
      {
        action: aliceOnFirst.sendReaction,
        event: { requestId: "a2", emoji: "cat" },
        trustedUi: reactGesture,
      },
      {
        action: aliceOnFirst.sendReaction,
        event: { requestId: "a3", emoji: "😺😺" },
        trustedUi: reactGesture,
      },
      {
        action: bobOnFirst.sendReaction,
        event: { requestId: "b1", emoji: "👍🏽" },
        trustedUi: reactGesture,
      },
      {
        action: bobOnFirst.sendReaction,
        event: { requestId: "b2", emoji: "🎉" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() =>
          talliesText(aliceOnFirst.tallies) === "👍🏽 2*, 🎉 1"
        ),
      },
      {
        assertion: assert(() =>
          talliesText(bobOnFirst.tallies) === "👍🏽 2*, 🎉 1*"
        ),
      },
      // Adding one already there changes nothing, even under a new request.
      {
        action: bobOnFirst.sendReaction,
        event: { requestId: "b3", emoji: "🎉" },
        trustedUi: reactGesture,
      },
      { assertion: assert(() => reactionsOn(messages, 0).length === 3) },
      // Removing is never a toggle: removing twice leaves it removed.
      {
        action: bobOnFirst.deleteReaction,
        event: { requestId: "b4", emoji: "🎉" },
        trustedUi: reactGesture,
      },
      {
        action: bobOnFirst.deleteReaction,
        event: { requestId: "b5", emoji: "🎉" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() => talliesText(bobOnFirst.tallies) === "👍🏽 2*"),
      },
      // A reaction on one message leaves the other's alone.
      {
        action: aliceOnSecond.sendReaction,
        event: { requestId: "a4", emoji: "😂" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() =>
          reactionsOn(messages, 1).length === 1 &&
          reactionsOn(messages, 0).length === 2
        ),
      },
      // Deleting a message takes its reactions out of the room's record, and
      // the deleted message takes no new ones.
      {
        action: aliceOnFirst.deleteMessage,
        event: {},
        trustedUi: messageGesture,
      },
      {
        action: bobOnFirst.sendReaction,
        event: { requestId: "b6", emoji: "😢" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() =>
          reactionsOn(messages, 0).length === 0 &&
          aliceOnFirst.tallies.length === 0
        ),
      },
    ],
  };
});
