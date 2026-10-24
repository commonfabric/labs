/**
 * How a FabriChat room's views name its messages: every field that names a
 * message holds the link to that message's own cell, never to its slot in the
 * room's messages, so a client that compares the links a view hands it, rather
 * than calling `equals()`, finds one message under one link wherever a view
 * names it. Each comparison below is `equalLinks()`, which does not resolve.
 */
import {
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  VIEWS,
  Writable,
} from "commonfabric";
import { FabriChatMessageRow } from "./message-row.tsx";
import { type ComposerState, type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
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

const sendGesture = {
  surface: CHAT_SEND_SURFACE,
  action: CHAT_SEND_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const records = {
    about: { kind: "group" as const },
    messages,
  };
  const alice = FabriChatRoomCore(
    { myProfile: aliceProfile, ...records } as RoomArg,
  );
  const bob = FabriChatRoomCore(
    { myProfile: bobProfile, ...records } as RoomArg,
  );
  // Bob's row on the first message, from which he replies to it.
  const bobOnRoot = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: bobProfile,
    inThread: false,
    kind: "group" as const,
    composer: Writable.of<ComposerState>({}),
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
    ...records,
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
      // A reply shown in both places: the main conversation lists it, it
      // roots a thread on "Root", and it names "Root" as what it replies to.
      {
        action: bobOnRoot.replyInBoth,
        event: typed("Reply"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() => {
          const view = alice[VIEWS].room;
          const latest = view.messages.latest.messages;
          const rights = view.messageRights;
          const own = [0, 1, 2].map((index) =>
            messages.key(index).resolveAsCell()
          );
          return latest.length === 3 && rights.length === 3 &&
            [0, 1, 2].every((index) =>
              Writable.equalLinks(latest[index], own[index]) &&
              Writable.equalLinks(rights[index]?.message, own[index])
            ) &&
            Writable.equalLinks(view.messages.threads[0]?.root, own[0]) &&
            Writable.equalLinks(
              latest[2]?.get()?.replyTo?.message,
              latest[0],
            ) &&
            !Writable.equalLinks(latest[0], latest[1]);
        }),
      },
    ],
  };
});
