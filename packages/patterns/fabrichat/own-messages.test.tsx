/**
 * A FabriChat room's acts on a message, and its replies, take only a message
 * of the room's own space. Handed a message that lives elsewhere, an edit and
 * an obliteration are refused, so a room's rules, its kind and its policy,
 * never reach a message another room's rules govern, and so is a reply to it,
 * so the room links no document of another space. Refused means the act's run
 * throws, with its reason, and writes nothing; the test requires exactly these
 * three refusals, each by its reason, so a refusal that went back to a silent
 * return, or gave another reason, fails it. The same acts on the room's own
 * messages land. Alice and Bob run here as this lane's one principal, which
 * holds OWNER in every space it creates, so what tells them apart is their
 * profiles alone.
 */
import {
  action,
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
  CHAT_EDIT_ACTION,
  CHAT_EDIT_SURFACE,
  CHAT_OBLITERATE_ACTION,
  CHAT_OBLITERATE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  epochNsec,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const editGesture = { surface: CHAT_EDIT_SURFACE, action: CHAT_EDIT_ACTION };
const obliterateGesture = {
  surface: CHAT_OBLITERATE_SURFACE,
  action: CHAT_OBLITERATE_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** A message held by a piece in a space of its own, outside every room. */
const Elsewhere = pattern<
  { message: MessageRecord },
  { message: MessageRecord }
>(({ message }) => ({ message }));

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

/** A message, as an event names it. */
function messageOf(cell: unknown): Writable<MessageRecord>;
function messageOf(cell: unknown): unknown {
  return cell;
}

export default pattern(() => {
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });

  // A group room whose OWNERs may obliterate.
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const records = {
    about: { kind: "group" as const, title: "Team" },
    ownersMayObliterate: true,
    messages,
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const bob = FabriChatRoomCore(
    { myProfile: bobProfile, ...records } as RoomArg,
  );

  // Alice's message in a space of its own.
  const elsewhere = Writable.of<{ message: MessageRecord } | undefined>(
    undefined,
  );
  const placeElsewhere = action(() =>
    elsewhere.set(
      Elsewhere.inSpace()({
        message: {
          authorProfile: aliceProfile,
          body: "Alice elsewhere",
          sentAt: epochNsec(1n),
        },
      }),
    )
  );
  const foreign = elsewhere.key("message");

  return {
    [TESTS]: [
      { action: placeElsewhere },
      {
        action: alice.sendMessage,
        event: typed("Alice in the room"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          bodyOf(elsewhere.get()?.message) === "Alice elsewhere" &&
          bodies(messages) === "Alice in the room"
        ),
      },

      // Handed the message elsewhere, Alice's edit and Bob's obliteration,
      // which this room's policy would let him make, are refused.
      {
        action: alice.editMessage,
        event: {
          message: messageOf(foreign),
          target: { value: "Edited from the room" },
        },
        trustedUi: editGesture,
      },
      {
        action: bob.obliterateMessage,
        event: { message: messageOf(foreign) },
        trustedUi: obliterateGesture,
      },
      {
        assertion: assert(() =>
          bodyOf(elsewhere.get()?.message) === "Alice elsewhere"
        ),
      },

      // A reply to the message elsewhere is refused.
      {
        action: alice.sendMessage,
        event: {
          body: "A reply to elsewhere",
          replyTo: { message: messageOf(foreign), shownIn: "main" },
        },
        trustedUi: sendGesture,
      },
      { assertion: assert(() => bodies(messages) === "Alice in the room") },

      // The same acts on the room's own message land.
      {
        action: alice.editMessage,
        event: {
          message: messageOf(messages.key(0)),
          target: { value: "Alice, edited" },
        },
        trustedUi: editGesture,
      },
      { assertion: assert(() => bodies(messages) === "Alice, edited") },
      {
        action: bob.obliterateMessage,
        event: { message: messageOf(messages.key(0)) },
        trustedUi: obliterateGesture,
      },
      { assertion: assert(() => bodies(messages) === "<obliterated>") },
    ],
    // The edit, the obliteration and the reply handed the message elsewhere.
    expectRuntimeErrors: [
      "That message isn't in this chat.",
      "That message isn't in this chat.",
      "That message isn't in this chat.",
    ],
  };
});
