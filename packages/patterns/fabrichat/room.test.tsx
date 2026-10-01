/**
 * A FabriChat group room of its own, as several viewers sharing it: what a
 * send stores, how edits, deletions, and obliterations change a message, how
 * replies divide into the conversation and its threads, and what the room's
 * recent activity records.
 */
import {
  type AddIntegrity,
  assert,
  equals,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findNodeByProp, propValue } from "../test/vnode-helpers.ts";
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
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_EDIT_ACTION,
  CHAT_EDIT_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  epochNsecFromMsec,
  nsecOf,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];

// A stand-in for a viewer's `#profile`, which a pattern test cannot resolve.
// It is labeled, as a Fabric profile is, because a message may link only a
// document that carries a label.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

// Every message write is a protected write, so each step carries the trusted
// gesture of the message surface: the headless equivalent of a click there.
const sendGesture = {
  surface: CHAT_SEND_SURFACE,
  action: CHAT_SEND_ACTION,
};
const editGesture = {
  surface: CHAT_EDIT_SURFACE,
  action: CHAT_EDIT_ACTION,
};
const deleteGesture = {
  surface: CHAT_DELETE_SURFACE,
  action: CHAT_DELETE_ACTION,
};
const obliterateGesture = {
  surface: CHAT_OBLITERATE_SURFACE,
  action: CHAT_OBLITERATE_ACTION,
};

// A composer delivers its field's text on the trusted click.
const typed = (text: string, requestId?: string) => ({
  type: "click",
  target: { value: text },
  ...(requestId === undefined ? {} : { requestId }),
});

const stored = (messages: Writable<MessagesValue>): MessageRecord[] =>
  messages.get() as MessageRecord[];

const bodies = (messages: Writable<MessagesValue>): string =>
  stored(messages).map((message) =>
    typeof message.body === "string"
      ? message.body
      : message.authorProfile === undefined
      ? "<obliterated>"
      : "<deleted>"
  ).join(" | ");

const times = (messages: Writable<MessagesValue>): bigint[] =>
  stored(messages).map((message) => nsecOf(message.sentAt));

const strictlyIncreasing = (values: readonly bigint[]): boolean =>
  values.every((value, index) => index === 0 || values[index - 1] < value);

// Each of the latest messages is a link to the stored message.
const mainTexts = (latest: readonly Writable<MessageRecord>[]): string =>
  latest.map((each) => {
    const message = each.get();
    return typeof message?.body === "string" ? message.body : "<gone>";
  }).join(" | ");

const activitySeqs = (activity: Writable<SentActivity[]>): number[] =>
  (activity.get() ?? []).map((entry) => entry.seq);

const composerDisabled = (root: unknown): unknown =>
  propValue(findNodeByProp(root, "inputId", "fabrichat-message"), "disabled");

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const reactionLists = Writable.of<ReactionList[]>([] as ReactionList[]);
  const requests = Writable.of<RequestMemo[]>([]);
  const usedTimes = Writable.of<UsedTime[]>([]);
  const activity = Writable.of<SentActivity[]>([]);
  const counters = Writable.of<ActivityCounters[]>([]);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const pendingProfile = Writable.of<TestProfile | undefined>(undefined);
  const records = {
    about: { kind: "group" as const, title: "Team" },
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
  };

  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const bob = FabriChatRoomCore(
    { myProfile: bobProfile, ...records } as RoomArg,
  );
  const pending = FabriChatRoomCore(
    { myProfile: pendingProfile, ...records } as RoomArg,
  );

  const rowRecords = {
    inThread: false,
    kind: "group" as const,
    composer: Writable.of<ComposerState>({}),
    ...records,
  };
  const aliceOnFirst = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: aliceProfile,
    ...rowRecords,
  } as RowArg);
  const bobOnFirst = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: bobProfile,
    ...rowRecords,
  } as RowArg);
  const bobOnSecond = FabriChatMessageRow({
    message: messages.key(1),
    myProfile: bobProfile,
    ...rowRecords,
  } as RowArg);
  const aliceOnSecond = FabriChatMessageRow({
    message: messages.key(1),
    myProfile: aliceProfile,
    ...rowRecords,
  } as RowArg);
  const aliceOnThird = FabriChatMessageRow({
    message: messages.key(2),
    myProfile: aliceProfile,
    ...rowRecords,
  } as RowArg);
  // The thread-only reply that the replies below send first.
  const bobOnThreadReply = FabriChatMessageRow({
    message: messages.key(3),
    myProfile: bobProfile,
    ...rowRecords,
  } as RowArg);

  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          alice.about.kind === "group" && alice.about.title === "Team" &&
          alice.about.createdAt === undefined &&
          alice.about.policy.get().maxWindowCount === 100 &&
          alice.about.policy.get().proposedTimeMaxAgeNsec.value ===
            600_000_000_000n
        ),
      },
      { assertion: assert(() => composerDisabled(pending[UI]) === true) },
      { assertion: assert(() => composerDisabled(alice[UI]) === false) },
      {
        assertion: assert(() =>
          alice.canSend === true && pending.canSend === false
        ),
      },

      // Sends: a blank one, and one with a proposal far older than the
      // room's window, are refused.
      {
        action: alice.sendMessage,
        event: typed("Hello, team", "alice-1"),
        trustedUi: sendGesture,
      },
      {
        action: alice.sendMessage,
        event: typed("   "),
        trustedUi: sendGesture,
      },
      {
        action: alice.sendMessage,
        event: {
          requestId: "alice-stale",
          version: { body: "Very late", sentAt: epochNsecFromMsec(1000) },
        },
        trustedUi: sendGesture,
      },
      {
        action: pending.sendMessage,
        event: typed("From nobody"),
        trustedUi: sendGesture,
      },
      { assertion: assert(() => bodies(messages) === "Hello, team") },
      {
        assertion: assert(() =>
          equals(stored(messages)[0]?.authorProfile, aliceProfile) &&
          stored(messages)[0]?.earlierVersions.length === 0
        ),
      },

      // The same request, delivered again, changes nothing.
      {
        action: alice.sendMessage,
        event: typed("Hello, team", "alice-1"),
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: typed("Hi, Alice"),
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: typed("Hi, Alice"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          bodies(messages) === "Hello, team | Hi, Alice | Hi, Alice"
        ),
      },
      // Sends in the same clock tick still get times unique in the room.
      { assertion: assert(() => strictlyIncreasing(times(messages))) },
      { assertion: assert(() => alice.messages.count === 3) },
      {
        assertion: assert(() =>
          alice.participants.length === 2 &&
          equals(alice.participants[0], aliceProfile) &&
          equals(alice.participants[1], bobProfile)
        ),
      },

      // Edits: only the sender's, and each keeps the version it replaces.
      {
        action: bobOnFirst.editMessage,
        event: typed("Hijacked"),
        trustedUi: editGesture,
      },
      {
        action: aliceOnFirst.editMessage,
        event: typed("Hello, everyone"),
        trustedUi: editGesture,
      },
      {
        assertion: assert(() => {
          const first = stored(messages)[0];
          return first?.body === "Hello, everyone" &&
            first?.editedAt !== undefined &&
            first?.earlierVersions.length === 1 &&
            first?.earlierVersions[0].body === "Hello, team" &&
            nsecOf(first?.earlierVersions[0].sentAt) === nsecOf(first?.sentAt);
        }),
      },

      // Deletion: only the sender's, and the deleted text stays in history.
      {
        action: aliceOnSecond.deleteMessage,
        event: {},
        trustedUi: deleteGesture,
      },
      {
        action: bobOnSecond.deleteMessage,
        event: {},
        trustedUi: deleteGesture,
      },
      {
        assertion: assert(() => {
          const second = stored(messages)[1];
          return typeof second?.body === "object" &&
            equals(second?.authorProfile, bobProfile) &&
            second?.earlierVersions.length === 1 &&
            second?.earlierVersions[0].body === "Hi, Alice";
        }),
      },
      // A deleted message takes no edit.
      {
        action: bobOnSecond.editMessage,
        event: typed("Back again"),
        trustedUi: editGesture,
      },
      {
        assertion: assert(() => typeof stored(messages)[1]?.body === "object"),
      },

      // Obliteration in a group room by its OWNER, which this lane's user is;
      // `members.test.tsx` covers a member who isn't.
      {
        action: aliceOnThird.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() => {
          const third = stored(messages)[2];
          return typeof third?.body === "object" &&
            third?.authorProfile === undefined &&
            third?.earlierVersions.length === 0;
        }),
      },

      // Replies: a thread reply stays out of the conversation, a "both" reply
      // shows in each, and a "main" reply quotes its target there.
      {
        action: aliceOnFirst.replyInThread,
        event: typed("In the thread"),
        trustedUi: sendGesture,
      },
      {
        action: aliceOnFirst.replyInBoth,
        event: typed("In both"),
        trustedUi: sendGesture,
      },
      {
        action: bobOnFirst.replyInMain,
        event: typed("Quoting you"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          mainTexts(alice.messages.latest.messages) ===
            "Hello, everyone | <gone> | <gone> | In both | Quoting you"
        ),
      },
      {
        assertion: assert(() => {
          const replies = stored(messages).slice(3);
          return replies.length === 3 &&
            replies.every((reply) =>
              reply.replyTo !== undefined &&
              nsecOf(reply.sentAt) > nsecOf(stored(messages)[0]?.sentAt)
            ) &&
            replies.map((reply) => reply.replyTo?.shownIn).join() ===
              "thread,both,main";
        }),
      },

      // Refused: a reply to a deleted message, a reply quoted in the main
      // conversation to a message shown only in a thread, and an edit whose
      // proposed time is far older than the room's window.
      {
        action: bobOnSecond.replyInThread,
        event: typed("To the deleted one"),
        trustedUi: sendGesture,
      },
      {
        action: bobOnThreadReply.replyInMain,
        event: typed("Quoting a thread reply"),
        trustedUi: sendGesture,
      },
      {
        action: aliceOnFirst.editMessage,
        event: {
          requestId: "alice-stale-edit",
          version: { body: "Very late edit", sentAt: epochNsecFromMsec(1000) },
        },
        trustedUi: editGesture,
      },
      {
        assertion: assert(() =>
          stored(messages).length === 6 &&
          stored(messages)[0]?.body === "Hello, everyone"
        ),
      },

      // Every recorded change has an activity entry, numbered without gaps
      // but for the obliterated message's earlier entries.
      {
        assertion: assert(() =>
          activitySeqs(activity).join() === "1,2,4,5,6,7,8,9"
        ),
      },
      { assertion: assert(() => alice.recentActivityExpiredThrough === 0) },
    ],
  };
});
