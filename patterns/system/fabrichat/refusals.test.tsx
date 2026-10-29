/**
 * What a FabriChat room refuses, and what it takes as changing nothing. A
 * refused act's run throws, with a reason a person can read, and writes
 * nothing, so a client whose own event broke a stream's rules learns of it:
 * a send whose payload carries its text elsewhere than `body` among them.
 * The test requires every refusal here, each by its reason, and no other
 * runtime error, so a refusal that went back to a silent return, or gave
 * another reason, fails it. An act that would change nothing, such as a
 * reaction added twice or a message deleted twice, is no refusal and raises
 * nothing. Alice, Bob and Carol run as this lane's one principal, which holds
 * OWNER in every space it creates, so what tells them apart is their profiles;
 * Carol's has not resolved.
 */
import {
  type AddIntegrity,
  assert,
  type Cell,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { type MessageRecord, type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_DELETE_ACTION,
  CHAT_DELETE_SURFACE,
  CHAT_EDIT_ACTION,
  CHAT_EDIT_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  CHAT_UNREACT_ACTION,
  type ChatProfile,
  type ChatReaction,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const editGesture = { surface: CHAT_EDIT_SURFACE, action: CHAT_EDIT_ACTION };
const deleteGesture = {
  surface: CHAT_DELETE_SURFACE,
  action: CHAT_DELETE_ACTION,
};
const obliterateGesture = {
  surface: CHAT_OBLITERATE_SURFACE,
  action: CHAT_OBLITERATE_ACTION,
};
const reactGesture = { surface: CHAT_REACT_SURFACE, action: CHAT_REACT_ACTION };
const unreactGesture = {
  surface: CHAT_REACT_SURFACE,
  action: CHAT_UNREACT_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** A message's body, or how it was taken away. */
const bodyOf = (message: MessageRecord | undefined): string =>
  typeof message?.body === "string"
    ? message.body
    : message?.authorProfile === undefined
    ? "<obliterated>"
    : "<deleted>";

/** Each of `messages`' bodies, in the order they were recorded. */
const bodies = (messages: Cell<MessagesValue>): string =>
  ((messages.get() ?? []) as MessageRecord[]).map(bodyOf).join(" | ");

/** How many reactions the first message holds. */
const reactionCount = (messages: Cell<MessagesValue>): number => {
  const first = ((messages.get() ?? []) as MessageRecord[])[0];
  return ((first?.reactions?.get() ?? []) as ChatReaction[]).length;
};

/** A message, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

export default pattern(() => {
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });

  // A group room whose OWNERs may not obliterate, and the same messages seen
  // by a curator whose room lets OWNERs obliterate.
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const group = {
    about: { kind: "group" as const, title: "Team" },
    ownersMayObliterate: false,
    messages,
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...group } as RoomArg,
  );
  const bob = FabriChatRoomCore({ myProfile: bobProfile, ...group } as RoomArg);
  const carol = FabriChatRoomCore({ ...group } as RoomArg);
  // A direct room, whose OWNERs may not obliterate, with a message of
  // Alice's.
  const directMessages = Writable.of<MessagesValue>([] as MessagesValue);
  const direct = {
    about: { kind: "direct" as const },
    ownersMayObliterate: false,
    messages: directMessages,
  };
  const aliceDirect = FabriChatRoomCore(
    { myProfile: aliceProfile, ...direct } as RoomArg,
  );
  const bobDirect = FabriChatRoomCore(
    { myProfile: bobProfile, ...direct } as RoomArg,
  );
  const curator = FabriChatRoomCore(
    { myProfile: bobProfile, ...group, ownersMayObliterate: true } as RoomArg,
  );

  const first = messageOf(messages.key(0));
  const firstReaction = messages.key(0).key("reactions").key(0);

  return {
    [TESTS]: [
      // Sends: from a profile that hasn't resolved, and with the text where a
      // room before pushed messages read it (`version.body`), not in `body`.
      { action: carol.sendMessage, event: typed("Hi"), trustedUi: sendGesture },
      {
        action: alice.sendMessage,
        event: { requestId: "r1", version: { body: "Old shape" } },
        trustedUi: sendGesture,
      },
      { assertion: assert(() => bodies(messages) === "") },
      {
        action: alice.sendMessage,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      { assertion: assert(() => bodies(messages) === "Hello") },

      // Edits: someone else's message, an event naming no message, and no
      // text.
      {
        action: bob.editMessage,
        event: { message: first, target: { value: "Bob's words" } },
        trustedUi: editGesture,
      },
      {
        action: alice.editMessage,
        event: { target: { value: "Named nothing" } },
        trustedUi: editGesture,
      },
      {
        action: alice.editMessage,
        event: { message: first, target: { value: "   " } },
        trustedUi: editGesture,
      },
      // A deletion of someone else's message. Then an edit and a deletion
      // from a profile that hasn't resolved, which can't tell whose message
      // it is.
      {
        action: bob.deleteMessage,
        event: { message: first },
        trustedUi: deleteGesture,
      },
      {
        action: carol.editMessage,
        event: { message: first, target: { value: "Carol's words" } },
        trustedUi: editGesture,
      },
      {
        action: carol.deleteMessage,
        event: { message: first },
        trustedUi: deleteGesture,
      },
      { assertion: assert(() => bodies(messages) === "Hello") },

      // Reactions: from a profile that hasn't resolved, and text that isn't a
      // single emoji. Then one added twice is added once, raising nothing.
      {
        action: carol.sendReaction,
        event: { message: first, emoji: "👍" },
        trustedUi: reactGesture,
      },
      {
        action: bob.sendReaction,
        event: { message: first, emoji: "thumbs" },
        trustedUi: reactGesture,
      },
      { assertion: assert(() => reactionCount(messages) === 0) },
      {
        action: bob.sendReaction,
        event: { message: first, emoji: "👍" },
        trustedUi: reactGesture,
      },
      {
        action: bob.sendReaction,
        event: { message: first, emoji: "👍" },
        trustedUi: reactGesture,
      },
      { assertion: assert(() => reactionCount(messages) === 1) },

      // Removals: someone else's reaction, from a profile that hasn't
      // resolved, and an event naming no reaction. Then Bob's own, twice: the
      // second names one no longer there, and removes nothing.
      {
        action: alice.deleteReaction,
        event: { message: first, reaction: firstReaction },
        trustedUi: unreactGesture,
      },
      {
        action: carol.deleteReaction,
        event: { message: first, reaction: firstReaction },
        trustedUi: unreactGesture,
      },
      {
        action: bob.deleteReaction,
        event: { message: first },
        trustedUi: unreactGesture,
      },
      { assertion: assert(() => reactionCount(messages) === 1) },
      {
        action: bob.deleteReaction,
        event: { message: first, reaction: firstReaction },
        trustedUi: unreactGesture,
      },
      {
        action: bob.deleteReaction,
        event: { message: first, reaction: firstReaction },
        trustedUi: unreactGesture,
      },
      // One named by a place in the list that holds none removes nothing.
      {
        action: bob.deleteReaction,
        event: {
          message: first,
          reaction: messages.key(0).key("reactions").key(5),
        },
        trustedUi: unreactGesture,
      },
      { assertion: assert(() => reactionCount(messages) === 0) },

      // An obliteration in a room whose OWNERs may not obliterate.
      {
        action: alice.obliterateMessage,
        event: { message: first },
        trustedUi: obliterateGesture,
      },
      { assertion: assert(() => bodies(messages) === "Hello") },

      // Alice deletes her message, twice: the second changes nothing. Then the
      // deleted message takes no edit and no reaction, and none is removed.
      {
        action: alice.deleteMessage,
        event: { message: first },
        trustedUi: deleteGesture,
      },
      {
        action: alice.deleteMessage,
        event: { message: first },
        trustedUi: deleteGesture,
      },
      { assertion: assert(() => bodies(messages) === "<deleted>") },
      {
        action: alice.editMessage,
        event: { message: first, target: { value: "Undeleted" } },
        trustedUi: editGesture,
      },
      {
        action: bob.sendReaction,
        event: { message: first, emoji: "👍" },
        trustedUi: reactGesture,
      },
      {
        action: bob.deleteReaction,
        event: { message: first, reaction: firstReaction },
        trustedUi: unreactGesture,
      },

      // The curator obliterates it, twice: the second changes nothing.
      {
        action: curator.obliterateMessage,
        event: { message: first },
        trustedUi: obliterateGesture,
      },
      {
        action: curator.obliterateMessage,
        event: { message: first },
        trustedUi: obliterateGesture,
      },
      { assertion: assert(() => bodies(messages) === "<obliterated>") },

      // In a direct room, Bob can't obliterate Alice's message.
      {
        action: aliceDirect.sendMessage,
        event: typed("Just us"),
        trustedUi: sendGesture,
      },
      {
        action: bobDirect.obliterateMessage,
        event: { message: messageOf(directMessages.key(0)) },
        trustedUi: obliterateGesture,
      },
      { assertion: assert(() => bodies(directMessages) === "Just us") },
    ],
    // The reason for each refused act above, in the order the acts run.
    expectRuntimeErrors: [
      // Sends.
      "Your profile hasn't loaded yet.",
      "This send has no text in `body`, and no attachments.",
      // Edits.
      "Only its author can edit a message.",
      "That message isn't in this chat.",
      "This edit has no text in `body`.",
      // The deletion, then the edit and deletion from Carol.
      "Only its author can delete a message.",
      "Your profile hasn't loaded yet.",
      "Your profile hasn't loaded yet.",
      // Reactions.
      "Your profile hasn't loaded yet.",
      "A reaction is a single emoji.",
      // Removals.
      "Only the person who reacted can remove a reaction.",
      "Your profile hasn't loaded yet.",
      "This names no reaction.",
      // The obliteration in a room whose OWNERs may not obliterate.
      "Messages in this chat can't be removed.",
      // The deleted message's edit, reaction and removal.
      "That message was deleted.",
      "That message was deleted.",
      "That message was deleted.",
      // Bob's obliteration in the direct room.
      "Only its author can remove a message in this chat.",
    ],
  };
});
