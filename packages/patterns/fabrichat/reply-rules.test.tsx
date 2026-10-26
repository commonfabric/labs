/**
 * The rules a FabriChat room holds a send's reply to, and a thread's title.
 * A message names the root of the thread it joins and the message it quotes,
 * each by its own cell: a plain post in a thread names its root alone, a
 * reply in a thread names both, and a reply in the main conversation names
 * what it quotes alone. The room refuses a reply whose links don't fit where
 * it is shown, a root that is in a thread itself, and a quote outside the
 * thread it joins. A thread is titled by the send that starts it, by a
 * retitle, or else by the start of its root's text. The room's view says
 * which reply shape it takes. Every refused send below is required, each by
 * its reason, and no other runtime error.
 */
import {
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  VIEWS,
  Writable,
} from "commonfabric";
import {
  type MessageRecord,
  type MessagesValue,
  type StoredThreadInfo,
} from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_RETITLE_ACTION,
  CHAT_RETITLE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  type SetThreadTitleOutcome,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const retitleGesture = {
  surface: CHAT_RETITLE_SURFACE,
  action: CHAT_RETITLE_ACTION,
};

/** A message, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

/** The message at `index` of `messages`, by its own cell. */
const ownCell = (messages: Writable<MessagesValue>, index: number) =>
  messages.key(index).resolveAsCell();

/** What the message at `index` of `messages` stores as its reply. */
const storedReply = (messages: Writable<MessagesValue>, index: number) =>
  (messages.get() as MessageRecord[])[index]?.replyTo;

/** The refusal code of a thread retitle's outcome, if it was refused. */
const codeOf = (outcome: SetThreadTitleOutcome | undefined) =>
  outcome?.status === "refused" ? outcome.code : undefined;

const LONG =
  "Where should we go for the team lunch on Friday afternoon, and who books?";

export default pattern(() => {
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const threadInfo = Writable.of<StoredThreadInfo[]>([]);
  const records = { about: { kind: "group" as const }, messages, threadInfo };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const bob = FabriChatRoomCore(
    { myProfile: bobProfile, ...records } as RoomArg,
  );

  const root = messageOf(messages.key(0));
  const other = messageOf(messages.key(1));
  const post = messageOf(messages.key(2));

  return {
    [TESTS]: [
      {
        action: alice.sendMessage,
        event: { body: "Root" },
        trustedUi: sendGesture,
      },
      {
        action: alice.sendMessage,
        event: { body: LONG },
        trustedUi: sendGesture,
      },

      // A plain post in "Root"'s thread, which titles the thread it starts; a
      // reply in that thread quoting the post, also sent to the conversation;
      // and a reply in the conversation quoting the long message.
      {
        action: bob.sendMessage,
        event: {
          body: "Plain post",
          replyTo: { thread: root, shownIn: "thread" },
          threadTitle: "  Planning  ",
        },
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: {
          body: "Quoting the post",
          replyTo: { thread: root, quotes: post, shownIn: "both" },
        },
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: {
          body: "Quoting the long one",
          replyTo: { quotes: other, shownIn: "main" },
        },
        trustedUi: sendGesture,
      },
      // A plain post in the long message's thread, untitled.
      {
        action: bob.sendMessage,
        event: {
          body: "Another post",
          replyTo: { thread: other, shownIn: "thread" },
        },
        trustedUi: sendGesture,
      },

      // The room says which reply shape it takes.
      {
        assertion: assert(() =>
          alice[VIEWS].room.replyShape === "thread-quotes"
        ),
      },
      // Each stores the links it was sent with, as the messages' own cells.
      {
        assertion: assert(() =>
          Writable.equalLinks(
            storedReply(messages, 2)?.thread,
            ownCell(messages, 0),
          ) &&
          storedReply(messages, 2)?.quotes === undefined &&
          Writable.equalLinks(
            storedReply(messages, 3)?.thread,
            ownCell(messages, 0),
          ) &&
          Writable.equalLinks(
            storedReply(messages, 3)?.quotes,
            ownCell(messages, 2),
          ) &&
          storedReply(messages, 4)?.thread === undefined &&
          Writable.equalLinks(
            storedReply(messages, 4)?.quotes,
            ownCell(messages, 1),
          )
        ),
      },
      // Each thread lists its root and its messages, and is titled by the
      // send that started it, or by the start of its root's text.
      {
        assertion: assert(() => {
          const threads = alice[VIEWS].room.messages.threads;
          const [planning, lunch] = threads;
          return threads.length === 2 &&
            planning?.title === "Planning" && planning.replyCount === 2 &&
            planning.messages.length === 3 &&
            Writable.equalLinks(planning.messages[0], ownCell(messages, 0)) &&
            Writable.equalLinks(planning.messages[1], ownCell(messages, 2)) &&
            Writable.equalLinks(planning.messages[2], ownCell(messages, 3)) &&
            planning.hasOlder === false &&
            lunch?.title ===
              "Where should we go for the team lunch on Friday…" &&
            lunch.replyCount === 1;
        }),
      },

      // Refused: a root that is in a thread itself; a quote outside the
      // thread the reply joins; links that don't fit where the reply is
      // shown, three ways.
      {
        action: bob.sendMessage,
        event: { body: "Nested", replyTo: { thread: post, shownIn: "thread" } },
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: {
          body: "Quoting outside",
          replyTo: { thread: root, quotes: other, shownIn: "thread" },
        },
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: {
          body: "Main thread",
          replyTo: { thread: root, shownIn: "main" },
        },
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: {
          body: "Thread quote",
          replyTo: { quotes: other, shownIn: "thread" },
        },
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: { body: "Neither", replyTo: { shownIn: "both" } },
        trustedUi: sendGesture,
      },
      // Refused: a title for a thread that has one, a title on a message in no
      // thread, and a title with no text.
      {
        action: bob.sendMessage,
        event: {
          body: "Retitling by post",
          replyTo: { thread: root, shownIn: "thread" },
          threadTitle: "Again",
        },
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: { body: "Titled main", threadTitle: "Main" },
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: {
          body: "Blank title",
          replyTo: { thread: other, shownIn: "thread" },
          threadTitle: "   ",
        },
        trustedUi: sendGesture,
      },
      // None of them stored anything.
      { assertion: assert(() => (messages.get() as unknown[]).length === 6) },

      // A retitle names its thread's root; one naming a message in a thread,
      // or with no text, is refused with its code, and changes nothing.
      {
        action: alice.setThreadTitle,
        event: { requestId: "t1", root: other, title: "Lunch" },
        trustedUi: retitleGesture,
      },
      {
        action: alice.setThreadTitle,
        event: { requestId: "t2", root: post, title: "Nested" },
        trustedUi: retitleGesture,
      },
      {
        action: alice.setThreadTitle,
        event: { requestId: "t3", root: root, title: "  " },
        trustedUi: retitleGesture,
      },
      {
        assertion: assert(() => {
          const outcomes = alice[VIEWS].room.threadTitleRequests;
          const threads = alice[VIEWS].room.messages.threads;
          return outcomes.t1?.status === "done" &&
            codeOf(outcomes.t2) === "not-a-root" &&
            codeOf(outcomes.t3) === "invalid-title" &&
            threads[0]?.title === "Planning" && threads[1]?.title === "Lunch";
        }),
      },
    ],
    // The reason for each refused send above, in the order the sends run.
    expectRuntimeErrors: [
      "That message is in a thread, so it can't start one.",
      "A reply in a thread can quote only a message of that thread.",
      "A reply in a thread names the thread's root, and one in the conversation names the message it quotes.",
      "A reply in a thread names the thread's root, and one in the conversation names the message it quotes.",
      "A reply in a thread names the thread's root, and one in the conversation names the message it quotes.",
      "This thread has a title already; rename it instead.",
      "Only a send in a thread can give the thread a title.",
      "A thread's title needs some text.",
    ],
  };
});
