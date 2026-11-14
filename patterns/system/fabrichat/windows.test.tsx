/**
 * A session's windows onto a room's messages: `openWindow` sets a window to
 * the newest or the oldest run of the main conversation or of one thread,
 * with what lies beyond it on either side, and `closeWindow` removes it. A
 * request the room can't fulfill changes nothing, and one instance of the
 * room holds no other's windows.
 */
import {
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import {
  type ChatMessageWindow,
  FABRICHAT_POLICY,
  type MessageRecord,
  type MessagesValue,
} from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
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

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** A message, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

/**
 * What the window `id` of `windows` shows: the body of each message it holds,
 * then whether the view holds older and newer messages beyond it; `none` for a
 * window not open.
 */
const shown = (
  windows: Readonly<Record<string, ChatMessageWindow>> | undefined,
  id: string,
): string => {
  const window = windows !== undefined && Object.hasOwn(windows, id)
    ? windows[id]
    : undefined;
  if (window === undefined) return "none";
  const bodies = window.messages.map((message) => String(message?.get()?.body));
  return [
    ...bodies,
    window.hasOlder ? "older" : "-",
    window.hasNewer ? "newer" : "-",
  ].join(" ");
};

/**
 * Opens of further windows, which with the two the test holds open by then
 * fill a session's `maxOpenWindows`.
 */
const FILL_EVENTS = Array.from(
  { length: FABRICHAT_POLICY.maxOpenWindows - 2 },
  (_, index) => ({
    requestId: `fill-${index}`,
    windowId: `fill-${index}`,
    from: { before: "end" as const },
    count: 1,
  }),
);

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const records = {
    about: { kind: "group" as const },
    messages,
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const bob = FabriChatRoomCore(
    { myProfile: bobProfile, ...records } as RoomArg,
  );
  // The first message, which roots a thread, and the reply in it.
  const root = messageOf(messages.key(0));
  const reply = messageOf(messages.key(1));

  return {
    [TESTS]: [
      { action: alice.sendMessage, event: typed("A"), trustedUi: sendGesture },
      {
        action: alice.sendMessage,
        event: {
          body: "In A",
          replyTo: { thread: root, shownIn: "thread" },
        },
        trustedUi: sendGesture,
      },
      { action: bob.sendMessage, event: typed("B"), trustedUi: sendGesture },
      { action: bob.sendMessage, event: typed("C"), trustedUi: sendGesture },

      // The newest two of the main conversation, which a thread-only reply
      // is not in, and the oldest two.
      {
        action: alice.messages.openWindow,
        event: {
          requestId: "r1",
          windowId: "newest",
          from: { before: "end" },
          count: 2,
        },
      },
      {
        action: alice.messages.openWindow,
        event: {
          requestId: "r2",
          windowId: "oldest",
          from: { after: "start" },
          count: 2,
        },
      },
      // A thread's window holds its root first, then its replies.
      {
        action: alice.messages.openWindow,
        event: {
          requestId: "r3",
          windowId: "thread",
          root,
          from: { before: "end" },
          count: 10,
        },
      },
      {
        assertion: assert(() => {
          const windows = alice.messages.windows.get();
          return shown(windows, "newest") === "B C older -" &&
            shown(windows, "oldest") === "A B - newer" &&
            shown(windows, "thread") === "A In A - -" &&
            windows?.newest?.requestId === "r1" &&
            Writable.equalLinks(windows?.thread?.root, root.resolveAsCell());
        }),
      },

      // Moving a window sets it as the newest request says.
      {
        action: alice.messages.openWindow,
        event: {
          requestId: "r4",
          windowId: "newest",
          from: { before: "end" },
          count: 1,
        },
      },
      {
        assertion: assert(() =>
          shown(alice.messages.windows.get(), "newest") === "C older -" &&
          alice.messages.windows.get()?.newest?.requestId === "r4"
        ),
      },

      // A root in a thread roots none, and an open names an end of its view:
      // neither request opens a window.
      {
        action: alice.messages.openWindow,
        event: {
          requestId: "r5",
          windowId: "reply",
          root: reply,
          from: { before: "end" },
          count: 2,
        },
      },
      {
        action: alice.messages.openWindow,
        event: { requestId: "r6", windowId: "nowhere", count: 2 },
      },
      {
        assertion: assert(() =>
          shown(alice.messages.windows.get(), "reply") === "none" &&
          shown(alice.messages.windows.get(), "nowhere") === "none"
        ),
      },

      // Closing a window removes it alone, and another instance of the room,
      // Bob's here, holds windows of its own (`window-sessions.test.tsx` holds
      // two sessions of one room to theirs).
      {
        action: alice.messages.closeWindow,
        event: { requestId: "r7", windowId: "oldest" },
      },
      {
        assertion: assert(() =>
          shown(alice.messages.windows.get(), "oldest") === "none" &&
          shown(alice.messages.windows.get(), "newest") === "C older -" &&
          shown(bob.messages.windows.get(), "newest") === "none"
        ),
      },

      // A session holds at most `maxOpenWindows` windows: with that many open,
      // an open of another opens none, and moving one still sets it.
      ...FILL_EVENTS.map((event) => ({
        action: alice.messages.openWindow,
        event,
      })),
      {
        assertion: assert(() =>
          Object.keys(alice.messages.windows.get() ?? {}).length ===
            FABRICHAT_POLICY.maxOpenWindows
        ),
      },
      {
        action: alice.messages.openWindow,
        event: {
          requestId: "r8",
          windowId: "one-too-many",
          from: { before: "end" },
          count: 1,
        },
      },
      // A `windowId` an object inherits a member under is a window like any
      // other: none is open under it, so it is one more.
      {
        action: alice.messages.openWindow,
        event: {
          requestId: "r10",
          windowId: "toString",
          from: { before: "end" },
          count: 1,
        },
      },
      {
        action: alice.messages.openWindow,
        event: {
          requestId: "r9",
          windowId: "newest",
          from: { after: "start" },
          count: 1,
        },
      },
      {
        assertion: assert(() =>
          shown(alice.messages.windows.get(), "one-too-many") === "none" &&
          shown(alice.messages.windows.get(), "toString") === "none" &&
          shown(alice.messages.windows.get(), "newest") === "A - newer"
        ),
      },
    ],
  };
});
