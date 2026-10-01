/**
 * A FabriChat room placed in a container: what the placement offers a viewer
 * who can read the room, and a viewer who can't, and what the adapter that
 * renders it shows and re-exports.
 */
import {
  type AddIntegrity,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  VIEWS,
  Writable,
} from "commonfabric";
import { findNodeById, propValue, readValue } from "../test/vnode-helpers.ts";
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
  type SentActivity,
  type UsedTime,
} from "./room.tsx";
import {
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
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

const sendGesture = {
  surface: CHAT_SEND_SURFACE,
  action: CHAT_SEND_ACTION,
};
const reactGesture = { surface: CHAT_REACT_SURFACE, action: CHAT_REACT_ACTION };

const reactionCount = (messages: Writable<MessagesValue>): number =>
  ((messages.get() as MessageRecord[])[0]?.reactions?.get() ?? []).length;

// How the element `id` under `root` is displayed.
const displayOf = (root: unknown, id: string): unknown =>
  readValue(
    (propValue(findNodeById(root, id), "style") as { display?: unknown })
      ?.display,
  );

// Which of an adapter's two parts it shows: the room, or why there is none.
const shownPart = (root: unknown): string =>
  `room:${displayOf(root, "fabrichat-adapter-room")} ` +
  `unavailable:${displayOf(root, "fabrichat-adapter-unavailable")}`;

const talliesText = (all: readonly PlacedTallies[]): string =>
  all.map((each) =>
    each.tallies.map((tally) => `${tally.emoji}${tally.count}`).join(",")
  ).join(";");

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const records = {
    about: { kind: "group" as const, title: "Team" },
    messages,
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters[]>([]),
  };
  const room = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const aliceOnFirst = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: aliceProfile,
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
        trustedUi: sendGesture,
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
          adapter[NAME] === "Team" &&
          shownPart(adapter[UI]) === "room:block unavailable:none"
        ),
      },
      // A room the viewer can't read offers nothing of itself.
      {
        assertion: assert(() =>
          unreadable[VIEWS].chat.state === "unavailable" &&
          unreadable[VIEWS].chat.about === undefined &&
          unreadable[VIEWS].chat.recentActivity.length === 0 &&
          unreadable[VIEWS].chat.canSend === false &&
          unreadableAdapter[NAME] === "Chat (unavailable)" &&
          shownPart(unreadableAdapter[UI]) === "room:none unavailable:block"
        ),
      },
    ],
  };
});
