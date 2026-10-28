/**
 * A FabriChat room's `ownersMayObliterate`, set against its kind's default: a
 * group room that doesn't let its OWNERs obliterate, and a direct room that
 * does. An OWNER obliterates someone else's message only where the setting
 * holds, and deletes no one else's message either way. Alice and Bob run here
 * as this lane's one principal, which holds OWNER in the room's space, so what
 * tells them apart is their profiles alone. Each act the room refuses fails
 * its run with a reason, and the test requires exactly those, each by its
 * reason. `members.test.tsx` and `direct.test.tsx` cover each kind's default.
 */
import {
  type AddIntegrity,
  assert,
  type Cell,
  equals,
  pattern,
  TESTS,
  VIEWS,
  Writable,
} from "commonfabric";
import { type MessageRecord, type MessagesValue } from "./room-records.tsx";
import { FabriChatMessageRow } from "./message-row.tsx";
import { type ChatMessageRights, FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];

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

// Each message's body, or how it was taken away, in the order they were
// recorded.
const bodies = (messages: Cell<MessagesValue>): string =>
  ((messages.get() ?? []) as MessageRecord[]).map((message) =>
    typeof message?.body === "string"
      ? message.body
      : message?.authorProfile === undefined
      ? "<obliterated>"
      : "<deleted>"
  ).join(" | ");

// The view's rights for the message at `index` of `messages`.
const rightsAt = (
  rights: readonly ChatMessageRights[],
  messages: Cell<MessagesValue>,
  index: number,
): ChatMessageRights | undefined =>
  rights.find((entry) => equals(entry.message, messages.key(index)));

/** A message of a room's records, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

export default pattern(() => {
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });

  // A group room whose OWNERs may not obliterate.
  const groupMessages = Writable.of<MessagesValue>([] as MessagesValue);
  const groupRecords = {
    about: { kind: "group" as const, title: "Team" },
    ownersMayObliterate: false,
    messages: groupMessages,
  };
  const aliceInGroup = FabriChatRoomCore(
    { myProfile: aliceProfile, ...groupRecords } as RoomArg,
  );
  const bobInGroup = FabriChatRoomCore(
    { myProfile: bobProfile, ...groupRecords } as RoomArg,
  );

  // A direct room whose OWNERs may obliterate.
  const directMessages = Writable.of<MessagesValue>([] as MessagesValue);
  const directRecords = {
    about: { kind: "direct" as const },
    ownersMayObliterate: true,
    messages: directMessages,
  };
  const aliceInDirect = FabriChatRoomCore(
    { myProfile: aliceProfile, ...directRecords } as RoomArg,
  );
  const bobInDirect = FabriChatRoomCore(
    { myProfile: bobProfile, ...directRecords } as RoomArg,
  );
  // Bob's control on Alice's message in the group room, bound to the room's
  // records but to no policy, where a group room's kind alone would let an
  // OWNER obliterate.
  const bobOnHersUnbound = FabriChatMessageRow({
    message: groupMessages.key(0),
    myProfile: bobProfile,
    inThread: false,
    kind: "group" as const,
    composer: Writable.of({}),
    places: {},
    cannotWrite: false,
    isOwner: true,
    messages: groupMessages,
  } as RowArg);

  return {
    [TESTS]: [
      // In the group room, Bob, an OWNER, can neither delete nor obliterate
      // Alice's message, nor obliterate his own.
      {
        action: aliceInGroup.sendMessage,
        event: typed("Alice in the group"),
        trustedUi: sendGesture,
      },
      {
        action: bobInGroup.sendMessage,
        event: typed("Bob in the group"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() => {
          const hers = rightsAt(
            bobInGroup[VIEWS].room.messageRights,
            groupMessages,
            0,
          );
          const his = rightsAt(
            bobInGroup[VIEWS].room.messageRights,
            groupMessages,
            1,
          );
          return bobInGroup.about.policy.get()?.ownersMayObliterate === false &&
            hers?.canEdit === false && hers?.canDelete === false &&
            hers?.canObliterate === false && his?.canEdit === true &&
            his?.canDelete === true && his?.canObliterate === false;
        }),
      },
      {
        action: bobInGroup.deleteMessage,
        event: {
          message: messageOf(groupMessages.key(0)),
        },
        trustedUi: deleteGesture,
      },
      {
        action: bobInGroup.obliterateMessage,
        event: {
          message: messageOf(groupMessages.key(0)),
        },
        trustedUi: obliterateGesture,
      },
      {
        action: bobInGroup.obliterateMessage,
        event: { message: messageOf(groupMessages.key(1)) },
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          bodies(groupMessages) === "Alice in the group | Bob in the group"
        ),
      },

      // In the direct room, Bob, an OWNER, obliterates Alice's message, but
      // still can't delete it.
      {
        action: aliceInDirect.sendMessage,
        event: typed("Alice in private"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() => {
          const hers = rightsAt(
            bobInDirect[VIEWS].room.messageRights,
            directMessages,
            0,
          );
          return bobInDirect.about.policy.get()?.ownersMayObliterate === true &&
            hers?.canEdit === false && hers?.canDelete === false &&
            hers?.canObliterate === true;
        }),
      },
      {
        action: bobInDirect.deleteMessage,
        event: {
          message: messageOf(directMessages.key(0)),
        },
        trustedUi: deleteGesture,
      },
      {
        assertion: assert(() => bodies(directMessages) === "Alice in private"),
      },
      {
        action: bobInDirect.obliterateMessage,
        event: {
          message: messageOf(directMessages.key(0)),
        },
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() => bodies(directMessages) === "<obliterated>"),
      },

      // An act bound to no policy lets no OWNER obliterate, though the room's
      // kind would.
      {
        action: bobOnHersUnbound.obliterateMessage,
        event: {},
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          bodies(groupMessages) === "Alice in the group | Bob in the group"
        ),
      },
    ],
    expectRuntimeErrors: [
      // In the group room, Bob's deletion and obliteration of Alice's message,
      // and his obliteration of his own.
      "Only its author can delete a message.",
      "Messages in this chat can't be removed.",
      "Messages in this chat can't be removed.",
      // In the direct room, his deletion of hers.
      "Only its author can delete a message.",
      // The obliteration bound to no policy.
      "Messages in this chat can't be removed.",
    ],
  };
});
