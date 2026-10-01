/**
 * A FabriChat group room, as its space's access list decides who may do what
 * in it: its OWNER obliterates anyone's messages; a member with WRITE sends
 * but can't obliterate someone else's; a reader with READ is offered no way to
 * write; and someone the list leaves out sees a placement of the room as not
 * theirs. Who is in the space is the space's business, not the room's.
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
  UI,
  VIEWS,
  Writable,
} from "commonfabric";
import { findNodeByProp, propValue } from "../test/vnode-helpers.ts";
import FabriChatPlacement from "./placement.tsx";
import {
  type ActivityCounters,
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
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];
type PlacementArg = Parameters<typeof FabriChatPlacement>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const obliterateGesture = {
  surface: CHAT_OBLITERATE_SURFACE,
  action: CHAT_OBLITERATE_ACTION,
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

// Whether a message row's reaction field, one of its write controls, is
// disabled.
const reactingDisabled = (row: unknown): unknown =>
  propValue(findNodeByProp(row, "placeholder", "Any emoji"), "disabled");

// Whether a room's main composer is disabled.
const composerDisabled = (room: unknown): unknown =>
  propValue(findNodeByProp(room, "inputId", "fabrichat-message"), "disabled");

/** What makes the shared room a group room of its own. */
const groupRoom = {
  about: { kind: "group" as const, title: "Team" },
};

export const setup = pattern(() => ({
  records: {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters[]>([]),
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
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...groupRoom, ...records } as RoomArg,
  );
  const onBobs = FabriChatMessageRow({
    message: setup.records.messages.key(1),
    myProfile: profile,
    inThread: false,
    kind: "group" as const,
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
      // Bob, with WRITE, couldn't obliterate her message.
      {
        assertion: assert(() =>
          bodies(setup.records.messages) === "From Alice | From Bob"
        ),
      },
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
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...groupRoom, ...records } as RoomArg,
  );
  const onAlices = FabriChatMessageRow({
    message: setup.records.messages.key(0),
    myProfile: profile,
    inThread: false,
    kind: "group" as const,
    composer: Writable.of({}),
    ...records,
  } as RowArg);

  return {
    [TESTS]: [
      { await: "alice-sent" },
      {
        assertion: assert(() =>
          room.canSend === true && composerDisabled(room[UI]) === false &&
          reactingDisabled(onAlices[UI]) === false
        ),
      },
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
        assertion: assert(() =>
          bodies(setup.records.messages) === "From Alice | From Bob"
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
  };
  const room = FabriChatRoomCore(
    { myProfile: profile, ...groupRoom, ...records } as RoomArg,
  );
  const onAlices = FabriChatMessageRow({
    message: setup.records.messages.key(0),
    myProfile: profile,
    inThread: false,
    kind: "group" as const,
    composer: Writable.of({}),
    ...records,
  } as RowArg);

  return {
    [TESTS]: [
      { await: "alice-sent" },
      // Carol's profile resolves, but her access is READ, so the room offers
      // her no way to write.
      {
        assertion: assert(() =>
          room.canSend === false && composerDisabled(room[UI]) === true &&
          reactingDisabled(onAlices[UI]) === true
        ),
      },
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
