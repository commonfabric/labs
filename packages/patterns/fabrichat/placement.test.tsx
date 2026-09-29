/**
 * A FabriChat room placed in a container: what the placement offers a viewer
 * who can read the room, and a viewer who can't, and what the adapter that
 * renders it shows and re-exports.
 */
import {
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  UI,
  VIEWS,
  Writable,
} from "commonfabric";
import { findElement } from "../test/vnode-helpers.ts";
import FabriChatAdapter from "./adapter.tsx";
import FabriChatPlacement, {
  type PlacedRoom,
  type PlacedTallies,
} from "./placement.tsx";
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
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  type ChatProfile,
  type ChatRoomNotice,
  type ProfileCell,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];
type PlacementArg = Parameters<typeof FabriChatPlacement>[0];
type AdapterArg = Parameters<typeof FabriChatAdapter>[0];

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

const reactionCount = (messages: Writable<MessagesValue>): number =>
  ((messages.get() as MessageRecord[])[0]?.reactions?.get() ?? []).length;

const talliesText = (all: readonly PlacedTallies[]): string =>
  all.map((each) =>
    each.tallies.map((tally) => `${tally.emoji}${tally.count}`).join(",")
  ).join(";");

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const records = {
    about: { kind: "group" as const, title: "Team" },
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
  const room = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const aliceOnFirst = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: aliceProfile,
    threadReplies: 0,
    inThread: false,
    kind: "group" as const,
    composer: Writable.of<ComposerState>({}),
    ...records,
  } as RowArg);

  const placement = FabriChatPlacement({ room } as PlacementArg);
  const adapter = FabriChatAdapter({ placement } as AdapterArg);
  // A room the viewer can't read: its link reaches nothing.
  const unreadable = FabriChatPlacement(
    { room: Writable.of<PlacedRoom>({}) } as PlacementArg,
  );
  const unreadableAdapter = FabriChatAdapter(
    { placement: unreadable } as AdapterArg,
  );

  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          placement[VIEWS].chat.state === "member" &&
          placement[VIEWS].chat.about?.title === "Team" &&
          placement[VIEWS].chat.canSend === true
        ),
      },
      {
        action: room.sendMessage,
        event: { type: "click", target: { value: "Hello" } },
        trustedUi: messageGesture,
      },
      {
        action: aliceOnFirst.sendReaction,
        event: { requestId: "r-1", emoji: "🎉" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() => placement[VIEWS].chat.messages?.count === 1),
      },
      { assertion: assert(() => reactionCount(messages) === 1) },
      {
        assertion: assert(() =>
          placement[VIEWS].chat.reactionTallies !== undefined
        ),
      },
      {
        assertion: assert(() =>
          placement[VIEWS].chat.recentActivity.length === 2
        ),
      },
      {
        assertion: assert(() =>
          placement[VIEWS].chat.reactionTallies.length === 1 &&
          talliesText(placement[VIEWS].chat.reactionTallies) === "🎉1" &&
          placement[VIEWS].chat.reactionTallies[0].tallies[0]?.count === 1
        ),
      },
      // The adapter shows the room's own rendering, and re-exports the
      // placement's data face.
      {
        assertion: assert(() =>
          adapter[VIEWS].chat.state === "member" &&
          findElement(adapter[UI], "cf-render") !== undefined
        ),
      },
      // A room the viewer can't read offers nothing of itself.
      {
        assertion: assert(() =>
          unreadable[VIEWS].chat.state === "unavailable" &&
          unreadable[VIEWS].chat.about === undefined &&
          unreadable[VIEWS].chat.recentActivity.length === 0 &&
          unreadable[VIEWS].chat.canSend === false &&
          findElement(unreadableAdapter[UI], "cf-render") === undefined
        ),
      },
    ],
  };
});
