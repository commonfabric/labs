/**
 * Deleting and obliterating in a FabriChat direct room, whose policy, unless
 * configured otherwise, doesn't let its OWNERs obliterate. Either of its two
 * people, each an OWNER of its space, may delete and obliterate their own
 * messages and neither of the other's. Someone the space admits with WRITE
 * alone, as a direct room whose space has grown may, likewise obliterates
 * their own messages, and nobody else's. `owner-obliteration.test.tsx` covers
 * a direct room configured to let its OWNERs obliterate.
 *
 * The test lane doesn't enforce the access list, so what this checks is what
 * the room decides from the level `spaceAccess()` reports.
 */
import {
  type AddIntegrity,
  assert,
  type Cell,
  equals,
  multiUserTest,
  pattern,
  TESTS,
  VIEWS,
  Writable,
} from "commonfabric";
import {
  type ActivityCounters,
  type MessageRecord,
  type MessagesValue,
  type ReactionList,
  type RequestMemo,
  type SentActivity,
  type UsedTime,
} from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  type MessageActOutcome,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const deleteGesture = {
  surface: CHAT_DELETE_SURFACE,
  action: CHAT_DELETE_ACTION,
};
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

// Each message's body, or how it was taken away, in the order they were
// recorded.
const bodies = (messages: Cell<MessagesValue>): string =>
  ((messages.get() ?? []) as MessageRecord[]).map((message) =>
    typeof message?.body === "string"
      ? message.body
      : message?.authorProfile?.get() === undefined
      ? "<obliterated>"
      : "<deleted>"
  ).join(" | ");

/** The outcome `outcomes` records under `id`, as `status/code`. */
const outcomeOf = (
  outcomes: Record<string, MessageActOutcome> | undefined,
  id: string,
): string => {
  const outcome = outcomes?.[id];
  return outcome === undefined
    ? "none"
    : outcome.status === "refused"
    ? `refused/${outcome.code}`
    : outcome.status;
};

/** A message of the shared records, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

/** What makes the shared room a direct room of its own. */
const directRoom = { about: { kind: "direct" as const } };

// The room's creator, an OWNER, who sends first and obliterates her own
// message last.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  const room = FabriChatRoomCore({
    myProfile: profile,
    ...directRoom,
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
  } as RoomArg);

  return {
    [TESTS]: [
      {
        action: room.composerSend,
        event: typed("From Alice"),
        trustedUi: sendGesture,
      },
      { label: "alice-sent" },
      { await: "bob-done" },
      {
        action: room.obliterateMessage,
        event: {
          requestId: "o-own",
          message: messageOf(setup.records.messages.key(0)),
        },
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(room.messageRequests, "o-own") === "done" &&
          bodies(setup.records.messages) ===
            "<obliterated> | <obliterated> | <obliterated>"
        ),
      },
      { label: "alice-done" },
    ],
  };
});

// The other person, also an OWNER, who can neither delete nor obliterate
// Alice's message.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Bob" });
  const room = FabriChatRoomCore({
    myProfile: profile,
    ...directRoom,
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
  } as RoomArg);

  return {
    [TESTS]: [
      { await: "alice-sent" },
      {
        action: room.composerSend,
        event: typed("From Bob"),
        trustedUi: sendGesture,
      },
      { label: "bob-sent" },
      { await: "carol-done" },
      // A direct room's policy doesn't let its OWNERs obliterate, and his
      // view offers him nothing on Alice's message.
      {
        assertion: assert(() => {
          const hers = room[VIEWS].room.messageRights.find((entry) =>
            equals(entry.message, setup.records.messages.key(0))
          );
          return room.about.policy.get()?.ownersMayObliterate === false &&
            hers?.canEdit === false && hers?.canDelete === false &&
            hers?.canObliterate === false;
        }),
      },
      {
        action: room.deleteMessage,
        event: {
          requestId: "d-alices",
          message: messageOf(setup.records.messages.key(0)),
        },
        trustedUi: deleteGesture,
      },
      {
        action: room.obliterateMessage,
        event: {
          requestId: "o-alices",
          message: messageOf(setup.records.messages.key(0)),
        },
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(room.messageRequests, "d-alices") ===
            "refused/not-allowed" &&
          outcomeOf(room.messageRequests, "o-alices") ===
            "refused/not-allowed" &&
          bodies(setup.records.messages) ===
            "From Alice | From Bob | <obliterated>"
        ),
      },
      // He may obliterate his own.
      {
        action: room.obliterateMessage,
        event: {
          requestId: "o-own",
          message: messageOf(setup.records.messages.key(1)),
        },
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "From Alice | <obliterated> | <obliterated>"
        ),
      },
      { label: "bob-done" },
      { await: "alice-done" },
    ],
  };
});

// Someone the space admits with WRITE, who may take away only her own
// message.
export const carol = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Carol" });
  const room = FabriChatRoomCore({
    myProfile: profile,
    ...directRoom,
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
  } as RoomArg);

  return {
    [TESTS]: [
      { await: "bob-sent" },
      {
        action: room.composerSend,
        event: typed("From Carol"),
        trustedUi: sendGesture,
      },
      {
        action: room.deleteMessage,
        event: {
          requestId: "d-alices",
          message: messageOf(setup.records.messages.key(0)),
        },
        trustedUi: deleteGesture,
      },
      {
        action: room.obliterateMessage,
        event: {
          requestId: "o-alices",
          message: messageOf(setup.records.messages.key(0)),
        },
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(room.messageRequests, "d-alices") ===
            "refused/not-allowed" &&
          outcomeOf(room.messageRequests, "o-alices") ===
            "refused/not-allowed" &&
          bodies(setup.records.messages) ===
            "From Alice | From Bob | From Carol"
        ),
      },
      {
        action: room.obliterateMessage,
        event: {
          requestId: "o-own",
          message: messageOf(setup.records.messages.key(2)),
        },
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          bodies(setup.records.messages) ===
            "From Alice | From Bob | <obliterated>"
        ),
      },
      { label: "carol-done" },
      { await: "alice-done" },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    alice,
    bob: { pattern: bob, access: "OWNER" },
    carol,
  },
});
