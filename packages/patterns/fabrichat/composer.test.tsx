/**
 * A FabriChat room's own composers: the main composer's send, a reply it
 * composes, and the thread composer's reply in the open thread.
 */
import {
  action,
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { clickButton, hasText } from "../test/vnode-helpers.ts";
import {
  type ActivityCounters,
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
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
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

const typed = (text: string) => ({ type: "click", target: { value: text } });

// Each stored message, as `body@shownIn`.
const summary = (messages: Writable<MessagesValue>): string =>
  (messages.get() as MessageRecord[]).map((message) =>
    `${message?.body}@${message?.replyTo?.shownIn ?? "-"}`
  ).join(" | ");

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const alice = FabriChatRoomCore({
    myProfile: aliceProfile,
    about: { kind: "group" as const },
    ownSpace: false,
    messages,
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters>({ nextSeq: 1, expiredThrough: 0 }),
    roster: Writable.of<RosterValue>({}),
    left: Writable.of<ProfileCell[]>([]),
    notices: Writable.of<ChatRoomNotice[]>([]),
  } as RoomArg);

  return {
    [TESTS]: [
      {
        action: alice.composerSend,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      { assertion: assert(() => summary(messages) === "Hello@-") },
      // "Reply" on the message composes a reply to it in the conversation.
      { action: action(() => clickButton(alice[UI], "Reply")) },
      { assertion: assert(() => hasText(alice[UI], "Replying to: Hello")) },
      {
        action: alice.composerSend,
        event: typed("Quoting"),
        trustedUi: sendGesture,
      },
      // "Thread" opens the message's thread, where the thread composer
      // replies.
      { action: action(() => clickButton(alice[UI], "Thread")) },
      {
        action: alice.threadComposerSend,
        event: typed("In the thread"),
        trustedUi: sendGesture,
      },
      // The reply once sent, the main composer composes none.
      {
        action: alice.composerSend,
        event: typed("Plain"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          summary(messages) ===
            "Hello@- | Quoting@main | In the thread@thread | Plain@-"
        ),
      },
    ],
  };
});
