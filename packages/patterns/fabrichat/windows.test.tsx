/**
 * A FabriChat room's windows and participants: how a session opens, moves,
 * and closes windows onto the main conversation, and who the room lists as
 * taking part.
 */
import {
  type AddIntegrity,
  assert,
  equals,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import {
  type ActivityCounters,
  type ChatMessageWindow,
  type ChatMessageWindows,
  FabriChatRoomCore,
  type MessagesValue,
  type ReactionList,
  type RequestMemo,
  type SentActivity,
  type UsedTime,
} from "./room.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = {
  surface: CHAT_SEND_SURFACE,
  action: CHAT_SEND_ACTION,
};
// Enough windows, with the one already open, to pass the room's limit by one.
const MORE_WINDOWS = Array.from({ length: 50 }, (_, index) => ({
  requestId: `many-${index}`,
  windowId: `many-${index}`,
  from: { before: "end" as const },
  count: 1,
}));

// Enough sends, with the three below, to pass the room's window limit by one.
const MORE_MESSAGES = Array.from(
  { length: 98 },
  (_, index) => ({ type: "click", target: { value: `More ${index}` } }),
);

const typed = (text: string) => ({ type: "click", target: { value: text } });

// The session's windows, as the room's output offers them.
const windowsOf = (windows: unknown): ChatMessageWindows => {
  const cell = windows as { get?: () => unknown } | undefined;
  const value = typeof cell?.get === "function" ? cell.get() : windows;
  return (value ?? {}) as ChatMessageWindows;
};

// A window's bodies, oldest first, with `<` and `>` where there is more.
const windowText = (window: ChatMessageWindow | undefined): string =>
  window === undefined ? "<closed>" : [
    window.hasOlder ? "<" : "",
    ...window.messages.map((each) => each.get()?.body),
    window.hasNewer ? ">" : "",
  ].filter((part) => part !== "").join(" ");

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const activity = Writable.of<SentActivity[]>([]);
  const records = {
    about: { kind: "group" as const },
    messages,
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity,
    counters: Writable.of<ActivityCounters[]>([]),
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );

  return {
    [TESTS]: [
      {
        action: alice.sendMessage,
        event: typed("One"),
        trustedUi: sendGesture,
      },
      {
        action: alice.sendMessage,
        event: typed("Two"),
        trustedUi: sendGesture,
      },
      {
        action: alice.sendMessage,
        event: typed("Three"),
        trustedUi: sendGesture,
      },
      {
        action: alice.messages.openWindow,
        event: {
          requestId: "w-1",
          windowId: "w",
          from: { before: "end" },
          count: 2,
        },
      },
      {
        assertion: assert(() =>
          windowText(windowsOf(alice.messages.windows).w) === "< Two Three" &&
          windowsOf(alice.messages.windows).w?.requestId === "w-1"
        ),
      },
      // Paging is opening the same window again.
      {
        action: alice.messages.openWindow,
        event: {
          requestId: "w-2",
          windowId: "w",
          from: { after: "start" },
          count: 2,
        },
      },
      {
        assertion: assert(() =>
          windowText(windowsOf(alice.messages.windows).w) === "One Two >"
        ),
      },
      // A count beyond the view gets the whole view.
      {
        action: alice.messages.openWindow,
        event: {
          requestId: "x-1",
          windowId: "x",
          from: { before: "end" },
          count: 5000,
        },
      },
      {
        action: alice.messages.closeWindow,
        event: { requestId: "w-3", windowId: "w" },
      },
      {
        assertion: assert(() =>
          windowText(windowsOf(alice.messages.windows).w) === "<closed>" &&
          windowText(windowsOf(alice.messages.windows).x) === "One Two Three"
        ),
      },
      // A session holds at most `maxOpenWindows` windows; one beyond is
      // refused.
      ...MORE_WINDOWS.map((event) => ({
        action: alice.messages.openWindow,
        event,
      })),
      {
        assertion: assert(() =>
          Object.keys(windowsOf(alice.messages.windows)).length === 50 &&
          windowsOf(alice.messages.windows)["many-49"] === undefined
        ),
      },

      // A count beyond the room's limit gets the limit: moving a window in a
      // view of 101 messages, asking for 5000, gets the newest 100.
      ...MORE_MESSAGES.map((event) => ({
        action: alice.sendMessage,
        event,
        trustedUi: sendGesture,
      })),
      {
        action: alice.messages.openWindow,
        event: {
          requestId: "x-2",
          windowId: "x",
          from: { before: "end" },
          count: 5000,
        },
      },
      {
        assertion: assert(() => {
          const window = windowsOf(alice.messages.windows).x;
          return window?.messages.length === 100 && window.hasOlder &&
            !window.hasNewer && window.messages[0]?.get()?.body === "Two";
        }),
      },

      // With no default pattern listing anyone, the room's participants are
      // its authors: Alice, who sent every message.
      {
        assertion: assert(() =>
          alice.participants.length === 1 &&
          equals(alice.participants[0], aliceProfile)
        ),
      },
    ],
  };
});
