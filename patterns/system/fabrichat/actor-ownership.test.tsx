/**
 * Message ownership follows the authenticated actor across profile changes.
 * A second actor selecting the same profile cannot edit, delete, or obliterate
 * the sender's direct messages, even while holding OWNER access to the room.
 */
import {
  type AddIntegrity,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { type ChatRoomOutput, FabriChatRoomCore } from "./room.tsx";
import { testRoomStorage } from "./room-test-fixture.ts";
import type { MessageCell } from "./room-records.tsx";
import type { ChatProfile } from "./schemas.tsx";

interface Setup {
  /** The room under the profile both actors select. */
  room: ChatRoomOutput;

  /** The same room under another selected profile. */
  alternate: ChatRoomOutput;

  /** The first message, which Alice sends. */
  message: MessageCell;
}

export const setup = pattern<Record<string, never>, Setup>(() => {
  const profile = new Writable<AddIntegrity<ChatProfile, ["chat-test"]>>({
    name: "Shared profile",
  });
  const alternate = new Writable<AddIntegrity<ChatProfile, ["chat-test"]>>({
    name: "Other profile",
  });
  const records = testRoomStorage({});
  return {
    room: FabriChatRoomCore({
      messages: records.messages,
      about: { kind: "direct" },
      myProfile: profile,
    }),
    alternate: FabriChatRoomCore({
      messages: records.messages,
      about: { kind: "direct" },
      myProfile: alternate,
    }),
    message: records.messages.key(0),
  };
});

const sendGesture = { surface: "ChatSendSurface", action: "ChatSend" };
const editGesture = { surface: "ChatEditSurface", action: "ChatEdit" };
const deleteGesture = { surface: "ChatDeleteSurface", action: "ChatDelete" };
const obliterateGesture = {
  surface: "ChatObliterateSurface",
  action: "ChatObliterate",
};

export const alice = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    {
      action: setup.room.sendMessage,
      event: { target: { value: "Alice's message" } },
      trustedUi: sendGesture,
    },
    { assertion: assert(() => setup.message.get().body === "Alice's message") },
    { label: "alice-sent" },
    { await: "bob-refused" },
    { assertion: assert(() => setup.message.get().body === "Alice's message") },
    {
      action: setup.alternate.editMessage,
      event: {
        message: setup.message,
        target: { value: "  Still Alice's message  " },
      },
      trustedUi: editGesture,
    },
    {
      assertion: assert(() =>
        setup.message.get().body === "  Still Alice's message  " &&
        setup.message.get().editedAt !== undefined
      ),
    },
    {
      action: setup.alternate.deleteMessage,
      event: { message: setup.message },
      trustedUi: deleteGesture,
    },
    {
      assertion: assert(() =>
        typeof setup.message.get().body === "object" &&
        setup.message.get().authorProfile !== undefined
      ),
    },
    {
      action: setup.alternate.obliterateMessage,
      event: { message: setup.message },
      trustedUi: obliterateGesture,
    },
    {
      assertion: assert(() =>
        setup.message.get().authorProfile === undefined &&
        typeof setup.message.get().body === "object"
      ),
    },
    {
      action: setup.room.sendMessage,
      event: { target: { value: "A new message" } },
      trustedUi: sendGesture,
    },
    {
      assertion: assert(() =>
        setup.room.messages.count === 2 &&
        typeof setup.message.get().body === "object"
      ),
    },
  ],
}));

export const bob = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "alice-sent" },
    {
      action: setup.room.editMessage,
      event: {
        message: setup.message,
        target: { value: "Hijacked" },
      },
      trustedUi: editGesture,
    },
    { assertion: assert(() => setup.message.get().body === "Alice's message") },
    {
      action: setup.room.deleteMessage,
      event: { message: setup.message },
      trustedUi: deleteGesture,
    },
    { assertion: assert(() => setup.message.get().body === "Alice's message") },
    {
      action: setup.room.obliterateMessage,
      event: { message: setup.message },
      trustedUi: obliterateGesture,
    },
    { assertion: assert(() => setup.message.get().body === "Alice's message") },
    { label: "bob-refused" },
  ],
  expectRuntimeErrors: [
    "Only its author can edit a message.",
    "Only its author can delete a message.",
    "Only its author can remove a message in this chat.",
  ],
}));

export default multiUserTest({
  setup,
  participants: { alice, bob: { pattern: bob, access: "OWNER" } },
});
