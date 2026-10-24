/**
 * A FabriChat group room of its own, as several viewers sharing it: what a
 * send stores, how edits, deletions, and obliterations change a message, and
 * how replies divide into the conversation and its threads. An act the room
 * refuses fails its run with a reason, and the test requires exactly those,
 * each by its reason.
 */
import {
  type AddIntegrity,
  assert,
  type Cell,
  equals,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findNodeByProp, propsOf, propValue } from "../test/vnode-helpers.ts";
import { FabriChatMessageRow } from "./message-row.tsx";
import {
  type ComposerState,
  type MessageCell,
  type MessageRecord,
  type MessagesValue,
} from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
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
const typed = (text: string) => ({ type: "click", target: { value: text } });

/** A message of the room's records, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

const stored = (messages: Cell<MessagesValue>): MessageRecord[] =>
  messages.get() as MessageRecord[];

const bodies = (messages: Cell<MessagesValue>): string =>
  stored(messages).map((message) =>
    typeof message.body === "string"
      ? message.body
      : message.authorProfile === undefined
      ? "<obliterated>"
      : "<deleted>"
  ).join(" | ");

// Each of the latest messages is a link to the stored message.
const mainTexts = (latest: readonly MessageCell[]): string =>
  latest.map((each) => {
    const message = each.get();
    return typeof message?.body === "string" ? message.body : "<gone>";
  }).join(" | ");

const composerDisabled = (root: unknown): unknown =>
  propValue(findNodeByProp(root, "inputId", "fabrichat-message"), "disabled");

// The default of the composer whose field is `inputId`, for its `disabled`:
// what it renders before the value has computed.
const composerDisabledDefault = (root: unknown, inputId: string): unknown =>
  (propsOf(findNodeByProp(root, "inputId", inputId))?.disabled as
    | { schema?: { default?: unknown } }
    | undefined)?.schema?.default;

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const pendingProfile = Writable.of<TestProfile | undefined>(undefined);
  const records = {
    about: { kind: "group" as const, title: "Team" },
    messages,
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
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
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

  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          alice.about.kind === "group" && alice.about.title === "Team" &&
          alice.about.createdAt === undefined &&
          alice.about.policy.get()?.maxWindowCount === 100 &&
          alice.about.policy.get()?.proposedTimeMaxAgeNsec.value ===
            600_000_000_000n &&
          alice.about.policy.get()?.ownersMayObliterate === true
        ),
      },
      { assertion: assert(() => composerDisabled(pending[UI]) === true) },
      { assertion: assert(() => composerDisabled(alice[UI]) === false) },
      // The conversation's composer and a thread's start out disabled, before
      // whether the viewer may send has computed.
      {
        assertion: assert(() =>
          composerDisabledDefault(alice[UI], "fabrichat-message") === true &&
          composerDisabledDefault(alice[UI], "fabrichat-thread-message") ===
            true
        ),
      },
      {
        assertion: assert(() =>
          alice.canSend === true && pending.canSend === false
        ),
      },

      // Sends: a blank one, and one from a viewer whose profile hasn't
      // resolved, are refused.
      {
        action: alice.sendMessage,
        event: typed("Hello, team"),
        trustedUi: sendGesture,
      },
      {
        action: alice.sendMessage,
        event: typed("   "),
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
          stored(messages)[0]?.editedAt === undefined
        ),
      },

      // Two sends of the same text are two messages.
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
      { assertion: assert(() => alice.messages.count === 3) },
      {
        assertion: assert(() =>
          alice.participants.length === 2 &&
          equals(alice.participants[0], aliceProfile) &&
          equals(alice.participants[1], bobProfile)
        ),
      },

      // Edits: only the sender's.
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
            first?.editedAt !== undefined;
        }),
      },

      // Deletion keeps the author and drops the text; `members.test.tsx`
      // covers who may delete someone else's message.
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
            second?.editedAt !== undefined;
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

      // Obliteration in a group room, whose policy lets its OWNERs
      // obliterate, by its OWNER, which this lane's user is;
      // `members.test.tsx` covers a member who isn't.
      {
        action: alice.obliterateMessage,
        event: { message: messageOf(messages.key(2)) },
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() => {
          const third = stored(messages)[2];
          return typeof third?.body === "object" &&
            third?.authorProfile === undefined;
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
              nsecOf(reply.sentAt) >= nsecOf(stored(messages)[0]?.sentAt)
            ) &&
            replies.map((reply) => reply.replyTo?.shownIn).join() ===
              "thread,both,main";
        }),
      },
      {
        assertion: assert(() =>
          stored(messages).length === 6 &&
          stored(messages)[0]?.body === "Hello, everyone"
        ),
      },
    ],
    expectRuntimeErrors: [
      // The blank send, and the send from a viewer whose profile hasn't
      // resolved.
      "This send has no text in `body`, and no attachments.",
      "Your profile hasn't loaded yet.",
      // Bob's edit of Alice's message, and the edit of a deleted one.
      "Only its author can edit a message.",
      "That message was deleted.",
    ],
  };
});
