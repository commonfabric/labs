/** Verifies that selecting another reactor's profile grants no removal authority. */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  FabricEpochNsec,
  multiUserTest,
  pattern,
  type Stream,
  TESTS,
  Writable,
} from "commonfabric";
import {
  FabriChatRoom,
  type StoredMemory,
  type StoredMessage,
} from "./room.tsx";
import { CHAT_POLICY } from "./records.ts";
import type {
  ChatMessage,
  ChatProfile,
  ChatRoomAbout,
  ChatRoomOutput,
  ChatRoomPolicy,
} from "./schemas.tsx";

interface Setup {
  room: ChatRoomOutput;
  message: Cell<ChatMessage>;
  initialize: Stream<void>;
}

export const setup = pattern<Record<string, never>, Setup>(() => {
  const profile = new Writable<AddIntegrity<ChatProfile, ["chat-test"]>>({
    name: "Shared selected profile",
  });
  const policy = new Writable<AddIntegrity<ChatRoomPolicy, ["chat-test"]>>(
    CHAT_POLICY,
  );
  const about = new Writable<AddIntegrity<ChatRoomAbout, ["chat-test"]>>();
  const records = new Writable<StoredMessage[]>([]);
  const memory = new Writable<StoredMemory>();
  return {
    room: FabriChatRoom({ about, records, memory, myProfile: profile }),
    message: records.key(0),
    initialize: action(() =>
      about.set({ kind: "group", createdAt: new FabricEpochNsec(0n), policy })
    ),
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
      { action: setup.initialize },
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
      { assertion: assert(() => setup.message.get().reactions.length === 1) },
      { label: "alice-reacted" },
      { await: "bob-tried-removal" },
      { assertion: assert(() => setup.message.get().reactions.length === 1) },
      {
        action: setup.room.deleteReaction,
        event: { requestId: "remove", message: setup.message, emoji: "😺" },
        trustedUi: gesture,
      },
      { assertion: assert(() => setup.message.get().reactions.length === 0) },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "alice-reacted" },
    { assertion: assert(() => setup.message.get().reactions.length === 1) },
    {
      action: setup.room.deleteReaction,
      event: { requestId: "remove", message: setup.message, emoji: "😺" },
      trustedUi: gesture,
    },
    { assertion: assert(() => setup.message.get().reactions.length === 1) },
    { label: "bob-tried-removal" },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
