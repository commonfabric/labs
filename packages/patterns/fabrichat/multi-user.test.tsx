/**
 * A FabriChat room shared by two people, each in a runtime of their own with
 * an identity of their own: each one's message, and each one's reaction,
 * reaches the other, and each one's windows stay their own session's.
 */
import {
  type AddIntegrity,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import FabriChatRoom, {
  type ActivityCounters,
  type ChatRoomOutput,
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
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  type ChatReaction,
  type ChatRoomNotice,
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
const reactGesture = { surface: CHAT_REACT_SURFACE, action: CHAT_REACT_ACTION };

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** The room's stored records, shared by everyone in the space. */
interface Records {
  messages: Writable<MessagesValue>;
  reactionLists: Writable<ReactionList[]>;
  requests: Writable<RequestMemo[]>;
  usedTimes: Writable<UsedTime[]>;
  activity: Writable<SentActivity[]>;
  counters: Writable<ActivityCounters>;
  roster: Writable<RosterValue>;
  left: Writable<string[]>;
  notices: Writable<ChatRoomNotice[]>;
}

/** What every session receives from the setup. */
interface Setup {
  shared: ChatRoomOutput;
  records: Records;
}

// The messages' bodies, in the order they were recorded.
const bodies = (messages: Writable<MessagesValue>): string =>
  ((messages.get() ?? []) as MessageRecord[]).map((message) =>
    typeof message?.body === "string" ? message.body : "<gone>"
  ).join(" | ");

const reactionsOnFirst = (messages: Writable<MessagesValue>): number => {
  const first = ((messages.get() ?? []) as MessageRecord[])[0];
  return ((first?.reactions?.get() ?? []) as ChatReaction[]).length;
};

// The ids of a session's windows, as the room's output offers them.
const windowIds = (windows: unknown): string[] => {
  const cell = windows as { get?: () => unknown } | undefined;
  const value = typeof cell?.get === "function" ? cell.get() : windows;
  return Object.keys((value ?? {}) as Record<string, unknown>);
};

// One room instance both sessions share, for the windows: its default export
// resolves no profile here, and opening a window needs none.
export const setup = pattern(() => ({
  shared: FabriChatRoom({}),
  records: {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters>({ nextSeq: 1, expiredThrough: 0 }),
    roster: Writable.of<RosterValue>({}),
    left: Writable.of<string[]>([]),
    notices: Writable.of<ChatRoomNotice[]>([]),
  },
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    ownSpace: false,
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
    roster: setup.records.roster,
    left: setup.records.left,
    notices: setup.records.notices,
  } as RoomArg);

  return {
    [TESTS]: [
      {
        action: room.composerSend,
        event: typed("Hello from Alice"),
        trustedUi: sendGesture,
      },
      // A window Alice's session opens is hers alone.
      {
        action: setup.shared.messages.openWindow,
        event: {
          requestId: "alice-w",
          windowId: "alice-w",
          from: { before: "end" },
          count: 10,
        },
      },
      {
        assertion: assert(() =>
          windowIds(setup.shared.messages.windows).includes("alice-w")
        ),
      },
      { label: "alice-sent" },
      { await: "bob-reacted" },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "Hello from Alice | Hi Alice, Bob here"
        ),
      },
      {
        assertion: assert(() => reactionsOnFirst(setup.records.messages) === 1),
      },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Bob" });
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    ownSpace: false,
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
    roster: setup.records.roster,
    left: setup.records.left,
    notices: setup.records.notices,
  } as RoomArg);
  const onFirst = FabriChatMessageRow({
    message: setup.records.messages.key(0),
    myProfile: profile,
    inThread: false,
    kind: "group" as const,
    ownSpace: false,
    composer: Writable.of({}),
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
    roster: setup.records.roster,
    left: setup.records.left,
    notices: setup.records.notices,
  } as RowArg);

  return {
    [TESTS]: [
      { await: "alice-sent" },
      {
        assertion: assert(() =>
          !windowIds(setup.shared.messages.windows).includes("alice-w")
        ),
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) === "Hello from Alice"
        ),
      },
      {
        action: room.composerSend,
        event: typed("Hi Alice, Bob here"),
        trustedUi: sendGesture,
      },
      {
        action: onFirst.sendReaction,
        event: { requestId: "bob-1", emoji: "👍" },
        trustedUi: reactGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "Hello from Alice | Hi Alice, Bob here" &&
          reactionsOnFirst(setup.records.messages) === 1
        ),
      },
      { label: "bob-reacted" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
