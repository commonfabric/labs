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
      reactionLists: records.reactionLists,
      requests: records.requests,
      usedTimes: records.usedTimes,
      activity: records.activity,
      counters: records.counters,
      about: { kind: "direct" },
      myProfile: profile,
    }),
    alternate: FabriChatRoomCore({
      messages: records.messages,
      reactionLists: records.reactionLists,
      requests: records.requests,
      usedTimes: records.usedTimes,
      activity: records.activity,
      counters: records.counters,
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
      event: { requestId: "alice-send", target: { value: "Alice's message" } },
      trustedUi: sendGesture,
    },
    { assertion: assert(() => setup.message.get().body === "Alice's message") },
    { label: "alice-sent" },
    { await: "bob-refused" },
    { assertion: assert(() => setup.message.get().body === "Alice's message") },
    {
      action: setup.alternate.editMessage,
      event: {
        requestId: "alice-edit",
        message: setup.message,
        target: { value: "Still Alice's message" },
      },
      trustedUi: editGesture,
    },
    {
      assertion: assert(() =>
        setup.message.get().body === "Still Alice's message" &&
        setup.message.get().earlierVersions.length === 1
      ),
    },
    {
      action: setup.alternate.deleteMessage,
      event: { requestId: "alice-delete", message: setup.message },
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
      event: { requestId: "alice-obliterate", message: setup.message },
      trustedUi: obliterateGesture,
    },
    {
      assertion: assert(() =>
        setup.message.get().authorProfile?.get() === undefined &&
        setup.message.get().earlierVersions.length === 0
      ),
    },
    {
      action: setup.room.sendMessage,
      event: { requestId: "alice-send", target: { value: "Resurrected" } },
      trustedUi: sendGesture,
    },
    {
      assertion: assert(() =>
        setup.room.messages.count === 1 &&
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
        requestId: "bob-edit",
        message: setup.message,
        target: { value: "Hijacked" },
      },
      trustedUi: editGesture,
    },
    { assertion: assert(() => setup.message.get().body === "Alice's message") },
    {
      action: setup.room.deleteMessage,
      event: { requestId: "bob-delete", message: setup.message },
      trustedUi: deleteGesture,
    },
    { assertion: assert(() => setup.message.get().body === "Alice's message") },
    {
      action: setup.room.obliterateMessage,
      event: { requestId: "bob-obliterate", message: setup.message },
      trustedUi: obliterateGesture,
    },
    { assertion: assert(() => setup.message.get().body === "Alice's message") },
    {
      assertion: assert(() =>
        ["bob-edit", "bob-delete", "bob-obliterate"].every((id) => {
          const outcome = setup.room.messageRequests[id];
          return outcome?.status === "refused" &&
            outcome.code === "not-allowed";
        })
      ),
    },
    { label: "bob-refused" },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
