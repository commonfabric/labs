/** Verifies that selecting another reactor's profile grants no removal authority. */
import {
  action,
  type AddIntegrity,
  assert,
  FabricEpochNsec,
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
  room: ChatRoomOutput;
  message: MessageCell;
}

export const setup = pattern<Record<string, never>, Setup>(() => {
  const profile = new Writable<AddIntegrity<ChatProfile, ["chat-test"]>>({
    name: "Shared selected profile",
  });
  const records = testRoomStorage({});
  return {
    room: FabriChatRoomCore({
      about: { kind: "group" },
      messages: records.messages,
      reactionLists: records.reactionLists,
      requests: records.requests,
      usedTimes: records.usedTimes,
      activity: records.activity,
      counters: records.counters,
      myProfile: profile,
    }),
    message: records.messages.key(0),
  };
});

const gesture = { surface: "ChatReactSurface", action: "ChatReact" };

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const version = new Writable({
    body: "Reaction ownership",
    sentAt: new FabricEpochNsec(0n),
  });
  return {
    [TESTS]: [
      {
        action: action(() =>
          version.key("sentAt").set(
            new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
          )
        ),
      },
      {
        action: setup.room.sendMessage,
        event: { requestId: "send", version },
        trustedUi: { surface: "ChatSendSurface", action: "ChatSend" },
      },
      {
        action: setup.room.sendReaction,
        event: { requestId: "react", message: setup.message, emoji: "😺" },
        trustedUi: gesture,
      },
      {
        assertion: assert(() =>
          setup.message.get().reactions!.get().length === 1
        ),
      },
      { label: "alice-reacted" },
      { await: "bob-tried-removal" },
      {
        assertion: assert(() =>
          setup.message.get().reactions!.get().length === 1
        ),
      },
      {
        action: setup.room.deleteReaction,
        event: { requestId: "remove", message: setup.message, emoji: "😺" },
        trustedUi: { surface: "ChatReactSurface", action: "ChatUnreact" },
      },
      {
        assertion: assert(() =>
          setup.message.get().reactions!.get().length === 0
        ),
      },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "alice-reacted" },
    {
      assertion: assert(() =>
        setup.message.get().reactions!.get().length === 1
      ),
    },
    {
      action: setup.room.deleteReaction,
      event: { requestId: "remove", message: setup.message, emoji: "😺" },
      trustedUi: { surface: "ChatReactSurface", action: "ChatUnreact" },
    },
    {
      assertion: assert(() =>
        setup.message.get().reactions!.get().length === 1
      ),
    },
    { label: "bob-tried-removal" },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
