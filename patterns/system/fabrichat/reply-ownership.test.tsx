/** Authors can edit and delete their replies to another person's message. */
import { assert, equals, multiUserTest, pattern, TESTS } from "commonfabric";
import type { MessageCell, MessagesCell } from "./room-records.tsx";
import {
  profileGesture,
  testRoomProfile,
  testRoomStorage,
} from "./room-test-fixture.ts";
import { FabriChatRoomCore } from "./room.tsx";

interface Setup {
  /** The shared conversation records. */
  messages: MessagesCell;

  /** Bob's thread root. */
  root: MessageCell;

  /** Alice's reply to edit. */
  edited: MessageCell;

  /** Alice's reply to delete. */
  deleted: MessageCell;
}

export const setup = pattern<Record<string, never>, Setup>(() => {
  const records = testRoomStorage({});
  return {
    messages: records.messages,
    root: records.messages.key(0),
    edited: records.messages.key(1),
    deleted: records.messages.key(2),
  };
});

const sendGesture = { surface: "ChatSendSurface", action: "ChatSend" };

/** A stored message passed through the room's public reader contract. */
function messageOf(cell: unknown): MessageCell;
function messageOf(cell: unknown): unknown {
  return cell;
}

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const own = testRoomProfile({});
  const room = FabriChatRoomCore({
    messages: setup.messages,
    about: { kind: "group" },
    myProfile: own.profile,
  });
  return {
    [TESTS]: [
      { action: own.initialize, trustedUi: profileGesture },
      {
        action: room.sendMessage,
        event: { body: "Bob's root" },
        trustedUi: sendGesture,
      },
      { assertion: assert(() => setup.root.get().body === "Bob's root") },
      { label: "bob-sent" },
    ],
  };
});

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const own = testRoomProfile({});
  const room = FabriChatRoomCore({
    messages: setup.messages,
    about: { kind: "group" },
    myProfile: own.profile,
  });
  return {
    [TESTS]: [
      { action: own.initialize, trustedUi: profileGesture },
      { await: "bob-sent" },
      {
        action: room.sendMessage,
        event: {
          body: "Alice's edit reply",
          replyTo: {
            thread: messageOf(setup.messages.key(0)),
            shownIn: "thread",
          },
        },
        trustedUi: sendGesture,
      },
      {
        action: room.sendMessage,
        event: {
          body: "Alice's delete reply",
          replyTo: {
            thread: messageOf(setup.messages.key(0)),
            shownIn: "thread",
          },
        },
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          setup.edited.get().body === "Alice's edit reply" &&
          setup.deleted.get().body === "Alice's delete reply" &&
          equals(setup.edited.get().replyTo?.thread, setup.root) &&
          equals(setup.deleted.get().replyTo?.thread, setup.root)
        ),
      },
      {
        action: room.editMessage,
        event: {
          message: room.messages.threads[0].messages[1],
          body: "Alice's revised reply",
        },
        trustedUi: { surface: "ChatEditSurface", action: "ChatEdit" },
      },
      {
        action: room.deleteMessage,
        event: { message: room.messages.threads[0].messages[2] },
        trustedUi: { surface: "ChatDeleteSurface", action: "ChatDelete" },
      },
      {
        assertion: assert(() =>
          setup.edited.get().body === "Alice's revised reply" &&
          setup.edited.get().editedAt !== undefined
        ),
      },
      {
        assertion: assert(() =>
          typeof setup.deleted.get().body === "object" &&
          setup.deleted.get().authorProfile !== undefined
        ),
      },
      {
        assertion: assert(() =>
          setup.root.get().body === "Bob's root" &&
          setup.root.get().editedAt === undefined &&
          equals(setup.edited.get().replyTo?.thread, setup.root) &&
          equals(setup.deleted.get().replyTo?.thread, setup.root)
        ),
      },
    ],
  };
});

export default multiUserTest({ setup, participants: { bob, alice } });
