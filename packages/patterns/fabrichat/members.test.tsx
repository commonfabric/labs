/**
 * A FabriChat group room of its own, as its space's access list decides who
 * may do what in it: its OWNER adds and removes members, reports notices
 * delivered, and obliterates anyone's messages; a member with WRITE sends but
 * does none of those; a reader with READ can't send; and someone the list
 * leaves out sees a placement of the room as not theirs.
 *
 * The test lane doesn't enforce the list, so what this checks is what the room
 * decides from the level `spaceAccess()` reports, not what the memory server
 * would refuse.
 */
import {
  type AddIntegrity,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  VIEWS,
  Writable,
} from "commonfabric";
import FabriChatPlacement from "./placement.tsx";
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
  CHAT_MEMBERS_ACTION,
  CHAT_MEMBERS_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  type ChatRoomActivity,
  type ChatRoomNotice,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];
type PlacementArg = Parameters<typeof FabriChatPlacement>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const CAROL = "did:key:z6MkCarol";

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const obliterateGesture = {
  surface: CHAT_OBLITERATE_SURFACE,
  action: CHAT_OBLITERATE_ACTION,
};
const membersGesture = {
  surface: CHAT_MEMBERS_SURFACE,
  action: CHAT_MEMBERS_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** The room's records, which every participant's room shares. */
interface Records {
  messages: Writable<MessagesValue>;
  reactionLists: Writable<ReactionList[]>;
  requests: Writable<RequestMemo[]>;
  usedTimes: Writable<UsedTime[]>;
  activity: Writable<SentActivity[]>;
  counters: Writable<ActivityCounters[]>;
  roster: Writable<RosterValue>;
  left: Writable<string[]>;
  notices: Writable<ChatRoomNotice[]>;
}

/** What every session receives from the setup. */
interface Setup {
  records: Records;
}

// The messages' bodies, in the order they were recorded.
const bodies = (messages: Writable<MessagesValue>): string =>
  ((messages.get() ?? []) as MessageRecord[]).map((message) =>
    typeof message?.body === "string" ? message.body : "<gone>"
  ).join(" | ");

const noticeCount = (notices: Writable<ChatRoomNotice[]>): number =>
  (notices.get() ?? []).length;

const activityCount = (activity: Writable<SentActivity[]>): number =>
  (activity.get() ?? []).length;

// Whether the newest activity entry's `what` reads as a list.
const newestLinksList = (activity: Writable<SentActivity[]>): boolean => {
  const entries = (activity.get() ?? []) as ChatRoomActivity[];
  const newest = entries[entries.length - 1];
  return Array.isArray(newest?.what?.get());
};

/** What makes the shared room a group room of its own. */
const groupRoom = {
  about: { kind: "group" as const, title: "Team" },
  ownSpace: true,
};

export const setup = pattern(() => ({
  records: {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters[]>([]),
    roster: Writable.of<RosterValue>({}),
    left: Writable.of<string[]>([]),
    notices: Writable.of<ChatRoomNotice[]>([]),
  },
}));

// The OWNER: the first participant.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  const records = {
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
    roster: setup.records.roster,
    left: setup.records.left,
    notices: setup.records.notices,
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...groupRoom, ...records } as RoomArg,
  );
  const onBobs = FabriChatMessageRow({
    message: setup.records.messages.key(1),
    myProfile: profile,
    inThread: false,
    kind: "group" as const,
    ownSpace: true,
    composer: Writable.of({}),
    ...records,
  } as RowArg);

  return {
    [TESTS]: [
      {
        action: room.composerSend,
        event: typed("From Alice"),
        trustedUi: sendGesture,
      },
      { label: "alice-sent" },
      { await: "bob-tried" },
      // Bob, with WRITE, could neither obliterate her message nor add anyone.
      {
        assertion: assert(() =>
          bodies(setup.records.messages) === "From Alice | From Bob" &&
          noticeCount(setup.records.notices) === 0
        ),
      },
      // Adding a member grants them access, and leaves a notice for them.
      {
        action: room.add,
        event: { requestId: "add-c", principal: CAROL, access: "WRITE" },
        trustedUi: membersGesture,
      },
      {
        assertion: assert(() =>
          noticeCount(setup.records.notices) === 1 &&
          (setup.records.notices.get() ?? [])[0]?.recipient === CAROL
        ),
      },
      // No profile has been shown yet, and the add's activity entry links the
      // roster's list all the same, which the add creates.
      { assertion: assert(() => newestLinksList(setup.records.activity)) },
      {
        action: room.delivered,
        event: { requestId: "del-c", id: JSON.stringify([CAROL, "add-c"]) },
      },
      { assertion: assert(() => noticeCount(setup.records.notices) === 0) },
      // Removing revokes the access, and records it: the two sends and the
      // add are the three entries before it.
      {
        action: room.remove,
        event: { requestId: "rm-c", principal: CAROL },
        trustedUi: membersGesture,
      },
      { assertion: assert(() => activityCount(setup.records.activity) === 4) },
      // The OWNER may obliterate anyone's message in a group room.
      {
        action: onBobs.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) === "From Alice | <gone>"
        ),
      },
      { assertion: assert(() => room.canSend === true) },
      { label: "alice-done" },
    ],
  };
});

// A member with WRITE, the default.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Bob" });
  const records = {
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
    roster: setup.records.roster,
    left: setup.records.left,
    notices: setup.records.notices,
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...groupRoom, ...records } as RoomArg,
  );
  const onAlices = FabriChatMessageRow({
    message: setup.records.messages.key(0),
    myProfile: profile,
    inThread: false,
    kind: "group" as const,
    ownSpace: true,
    composer: Writable.of({}),
    ...records,
  } as RowArg);

  return {
    [TESTS]: [
      { await: "alice-sent" },
      { assertion: assert(() => room.canSend === true) },
      {
        action: room.composerSend,
        event: typed("From Bob"),
        trustedUi: sendGesture,
      },
      {
        action: onAlices.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        action: room.add,
        event: { requestId: "add-b", principal: CAROL, access: "WRITE" },
        trustedUi: membersGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) === "From Alice | From Bob" &&
          noticeCount(setup.records.notices) === 0
        ),
      },
      { label: "bob-tried" },
      { await: "alice-done" },
    ],
  };
});

// A reader with READ, who can't send.
export const carol = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Carol" });
  const records = {
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
    roster: setup.records.roster,
    left: setup.records.left,
    notices: setup.records.notices,
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...groupRoom, ...records } as RoomArg,
  );

  return {
    [TESTS]: [
      { assertion: assert(() => room.canSend === false) },
    ],
  };
});

// Someone the access list leaves out, looking at a placement of the room.
export const stranger = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Stranger" });
  const records = {
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
    roster: setup.records.roster,
    left: setup.records.left,
    notices: setup.records.notices,
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...groupRoom, ...records } as RoomArg,
  );
  const placement = FabriChatPlacement({ room } as PlacementArg);

  return {
    [TESTS]: [
      {
        assertion: assert(() => placement[VIEWS].chat.state === "not-member"),
      },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    alice,
    bob,
    carol: { pattern: carol, access: "READ" },
    stranger: { pattern: stranger, access: "none" },
  },
});
