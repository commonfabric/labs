/**
 * A FabriChat room shared by two people, each in a runtime of their own with
 * an identity of their own: each one's message, and each one's reaction,
 * reaches the other.
 */
import {
  type AddIntegrity,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import {
  type ActivityCounters,
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

/** The room's stored records, shared by everyone in the space. */
interface Records {
  messages: Writable<MessagesValue>;
  reactionLists: Writable<ReactionList[]>;
  requests: Writable<RequestMemo[]>;
  usedTimes: Writable<UsedTime[]>;
  activity: Writable<SentActivity[]>;
  counters: Writable<ActivityCounters>;
  roster: Writable<RosterValue>;
  left: Writable<ProfileCell[]>;
  notices: Writable<ChatRoomNotice[]>;
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

export const setup = pattern(() => ({
  records: {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters>({ nextSeq: 1, expiredThrough: 0 }),
    roster: Writable.of<RosterValue>({}),
    left: Writable.of<ProfileCell[]>([]),
    notices: Writable.of<ChatRoomNotice[]>([]),
  },
}));

export const alice = pattern<{ setup: { records: Records } }>(({ setup }) => {
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
        trustedUi: messageGesture,
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

export const bob = pattern<{ setup: { records: Records } }>(({ setup }) => {
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
          bodies(setup.records.messages) === "Hello from Alice"
        ),
      },
      {
        action: room.composerSend,
        event: typed("Hi Alice, Bob here"),
        trustedUi: messageGesture,
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
