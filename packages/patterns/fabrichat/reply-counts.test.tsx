/**
 * What a FabriChat room's data face says about each thread: the reply count
 * and the latest reply time `messages.threads` gives for each message of the
 * main conversation that roots one, as replies arrive, as a reply joins a
 * thread through another reply, and as replies are deleted and obliterated.
 */
import {
  type AddIntegrity,
  assert,
  equals,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { FabriChatMessageRow } from "./message-row.tsx";
import {
  type ActivityCounters,
  type ComposerState,
  type MessageRecord,
  type MessagesValue,
  type ReactionList,
  type RequestMemo,
  type SentActivity,
  type UsedTime,
} from "./room-records.tsx";
import { type ChatThreadSummary, FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  nsecOf,
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
const deleteGesture = {
  surface: CHAT_DELETE_SURFACE,
  action: CHAT_DELETE_ACTION,
};
const obliterateGesture = {
  surface: CHAT_OBLITERATE_SURFACE,
  action: CHAT_OBLITERATE_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** A message of the room's records, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

const stored = (messages: Writable<MessagesValue>): MessageRecord[] =>
  messages.get() as MessageRecord[];

/**
 * Each thread the room lists, in its order, as `<root>:<count>@<latest>`,
 * where `<latest>` is the index among the stored messages of the one whose
 * `sentAt` is the thread's latest reply time.
 */
const threadsText = (
  threads: readonly ChatThreadSummary[],
  messages: Writable<MessagesValue>,
): string =>
  threads.map((thread) => {
    const root = thread.root.get()?.body;
    const latest = stored(messages).findIndex((message) =>
      nsecOf(message.sentAt) === nsecOf(thread.latestReplyAt)
    );
    return `${
      typeof root === "string" ? root : "<gone>"
    }:${thread.replyCount}@${latest}`;
  }).join(" | ");

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const records = {
    about: { kind: "group" as const },
    messages,
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters[]>([]),
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const bob = FabriChatRoomCore(
    { myProfile: bobProfile, ...records } as RoomArg,
  );

  const rowRecords = {
    inThread: false,
    kind: "group" as const,
    composer: Writable.of<ComposerState>({}),
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
    ...records,
  };
  // Rows on the messages, at their places in the order the steps below send
  // them.
  const aliceOnRoot = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: aliceProfile,
    ...rowRecords,
  } as RowArg);
  const bobOnRoot = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: bobProfile,
    ...rowRecords,
  } as RowArg);
  const aliceOnOther = FabriChatMessageRow({
    message: messages.key(1),
    myProfile: aliceProfile,
    ...rowRecords,
  } as RowArg);
  const bobOnFirstReply = FabriChatMessageRow({
    message: messages.key(2),
    myProfile: bobProfile,
    ...rowRecords,
  } as RowArg);

  return {
    [TESTS]: [
      {
        action: alice.sendMessage,
        event: typed("Root"),
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: typed("Other"),
        trustedUi: sendGesture,
      },
      // A message with no replies roots no thread, so the list is empty.
      {
        assertion: assert(() =>
          threadsText(alice.messages.threads, messages) === ""
        ),
      },

      // Each reply in the thread raises its root's count, and moves the
      // latest reply time to its own `sentAt`.
      {
        action: bobOnRoot.replyInThread,
        event: typed("First reply"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          threadsText(alice.messages.threads, messages) === "Root:1@2" &&
          equals(alice.messages.threads[0]?.root, messages.key(0))
        ),
      },
      {
        action: aliceOnRoot.replyInBoth,
        event: typed("Second reply"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          threadsText(alice.messages.threads, messages) === "Root:2@3"
        ),
      },

      // A reply quoted in the main conversation is in no thread, so it
      // counts toward none.
      {
        action: aliceOnRoot.replyInMain,
        event: typed("Quoting the root"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          threadsText(alice.messages.threads, messages) === "Root:2@3"
        ),
      },

      // A reply to a reply in the thread joins the root's thread, and roots
      // none of its own.
      {
        action: bobOnFirstReply.replyInThread,
        event: typed("Nested reply"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          threadsText(alice.messages.threads, messages) === "Root:3@5"
        ),
      },

      // Each thread is counted on its own, oldest root first, and every
      // reader sees the same counts.
      {
        action: aliceOnOther.replyInThread,
        event: typed("Reply to other"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          threadsText(alice.messages.threads, messages) ===
            "Root:3@5 | Other:1@6" &&
          threadsText(bob.messages.threads, messages) ===
            "Root:3@5 | Other:1@6"
        ),
      },

      // A deleted reply and an obliterated one each stay in their thread as
      // tombstones, so the count and the latest reply time stand.
      {
        action: bobOnFirstReply.deleteMessage,
        event: {},
        trustedUi: deleteGesture,
      },
      // Obliterated through the room's own stream, which reads the room's
      // policy, as the OWNER this lane's user is may.
      {
        action: alice.obliterateMessage,
        event: { requestId: "o-nested", message: messageOf(messages.key(5)) },
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          typeof stored(messages)[2]?.body === "object" &&
          stored(messages)[5]?.authorProfile?.get() === undefined &&
          threadsText(alice.messages.threads, messages) ===
            "Root:3@5 | Other:1@6"
        ),
      },
    ],
  };
});
