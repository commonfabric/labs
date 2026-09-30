/**
 * A FabriChat room's windows and membership: how a session opens, moves, and
 * closes windows onto the main conversation, and how showing a profile,
 * adding a member, reporting a notice delivered, and leaving change the
 * room's record.
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
  type RosterValue,
  type SentActivity,
  type UsedTime,
} from "./room.tsx";
import {
  CHAT_MEMBERS_ACTION,
  CHAT_MEMBERS_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  type ChatRoomActivity,
  type ChatRoomNotice,
  type ProfileCell,
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
const membersGesture = {
  surface: CHAT_MEMBERS_SURFACE,
  action: CHAT_MEMBERS_ACTION,
};

// Enough windows, with the one already open, to pass the room's limit by one.
const MORE_WINDOWS = Array.from({ length: 50 }, (_, index) => ({
  requestId: `many-${index}`,
  windowId: `many-${index}`,
  from: { before: "end" as const },
  count: 1,
}));

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

// Whether the newest activity entry's `what` reads as a list.
const newestLinksList = (activity: Writable<SentActivity[]>): boolean => {
  const entries = (activity.get() ?? []) as ChatRoomActivity[];
  const newest = entries[entries.length - 1];
  return Array.isArray(newest?.what?.get());
};

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const roster = Writable.of<RosterValue>({});
  const activity = Writable.of<SentActivity[]>([]);
  const left = Writable.of<ProfileCell[]>([]);
  const notices = Writable.of<ChatRoomNotice[]>([]);
  const records = {
    about: { kind: "group" as const },
    ownSpace: true,
    creatorProfile: aliceProfile,
    messages,
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity,
    counters: Writable.of<ActivityCounters>({ nextSeq: 1, expiredThrough: 0 }),
    roster,
    left,
    notices,
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const bob = FabriChatRoomCore(
    { myProfile: bobProfile, ...records } as RoomArg,
  );
  // The same room as a space's own chat, which nobody leaves.
  const bobInSpaceChat = FabriChatRoomCore(
    { myProfile: bobProfile, ...records, ownSpace: false } as RoomArg,
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
      // A count beyond the room's limit gets the limit.
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

      // Adding comes first, before anyone has shown a profile. Only an OWNER
      // adds a member, and adding one leaves a notice for a
      // client to deliver.
      {
        action: bob.add,
        event: { requestId: "add-b", principal: "did:key:z6MkBob" },
        trustedUi: membersGesture,
      },
      {
        action: alice.add,
        event: { requestId: "add-a", principal: "not a did" },
        trustedUi: membersGesture,
      },
      {
        action: alice.add,
        event: { requestId: "add-a2", principal: "did:key:z6MkCarol" },
        trustedUi: membersGesture,
      },
      {
        assertion: assert(() =>
          alice.outgoingNotices.length === 1 &&
          alice.outgoingNotices[0].recipient === "did:key:z6MkCarol"
        ),
      },
      // The add's activity entry links the roster's list, which it creates.
      { assertion: assert(() => newestLinksList(activity)) },
      // Showing a profile lists it once, however often it is shown.
      { action: alice.showProfile, event: { requestId: "show-a" } },
      { action: bob.showProfile, event: { requestId: "show-b" } },
      { action: bob.showProfile, event: { requestId: "show-b2" } },
      {
        assertion: assert(() =>
          alice.roster.length === 2 && equals(alice.roster[1], bobProfile)
        ),
      },

      // Removing is refused, since nothing could revoke the access, and the
      // room records nothing for it: its activity is still the three sends,
      // the two profiles shown, and the one person added.
      {
        action: alice.remove,
        event: { requestId: "remove-a", principal: "did:key:z6MkCarol" },
        trustedUi: membersGesture,
      },
      {
        assertion: assert(() => alice.recentActivity.length === 6),
      },
      // Only the OWNER reports the notice delivered.
      {
        action: bob.delivered,
        event: { requestId: "d-b", id: '["did:key:z6MkCarol","add-a2"]' },
      },
      { assertion: assert(() => alice.outgoingNotices.length === 1) },
      {
        action: alice.delivered,
        event: { requestId: "d-a", id: '["did:key:z6MkCarol","add-a2"]' },
      },
      { assertion: assert(() => alice.outgoingNotices.length === 0) },

      // Leaving takes the member's roster entry with it, from a room of its
      // own; a space's own chat is left by leaving the space.
      { action: bobInSpaceChat.leave, event: { requestId: "leave-0" } },
      { assertion: assert(() => alice.roster.length === 2) },
      { action: bob.leave, event: { requestId: "leave-1" } },
      {
        assertion: assert(() =>
          alice.roster.length === 1 && equals(alice.roster[0], aliceProfile) &&
          (left.get() ?? []).length === 1
        ),
      },
    ],
  };
});
