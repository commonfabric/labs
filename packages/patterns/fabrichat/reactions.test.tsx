/** Exercises explicit, idempotent emoji add and remove requests. */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  FabricEpochNsec,
  pattern,
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
  ChatRoomPolicy,
} from "./schemas.ts";

export default pattern(() => {
  const profile = new Writable<AddIntegrity<ChatProfile, ["chat-test"]>>({
    name: "Alice",
  });
  const policy = new Writable<AddIntegrity<ChatRoomPolicy, ["chat-test"]>>(
    CHAT_POLICY,
  );
  const about = new Writable<AddIntegrity<ChatRoomAbout, ["chat-test"]>>();
  const records = new Writable<StoredMessage[]>([]);
  const memory = new Writable<StoredMemory>();
  const version = new Writable({
    body: "Emoji",
    sentAt: new FabricEpochNsec(0n),
  });
  const initialize = action(() => {
    about.set({ kind: "group", createdAt: new FabricEpochNsec(0n), policy });
    version.key("sentAt").set(
      new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
    );
  });
  const room = FabriChatRoom({ about, records, memory, myProfile: profile });
  const message: Cell<ChatMessage> = records.key(0);
  const gesture = { surface: "ChatReactSurface", action: "ChatReact" };
  return {
    [TESTS]: [
      { action: initialize },
      {
        action: room.sendMessage,
        event: { requestId: "message", version },
        trustedUi: { surface: "ChatSendSurface", action: "ChatSend" },
      },
      {
        action: room.sendReaction,
        event: { requestId: "add", message, emoji: "👩🏽‍💻" },
        trustedUi: gesture,
      },
      {
        action: room.sendReaction,
        event: { requestId: "same", message, emoji: "👩🏽‍💻" },
        trustedUi: gesture,
      },
      {
        assertion: assert(() =>
          message.get().reactions.length === 1 &&
          message.get().reactions[0].emoji === "👩🏽‍💻"
        ),
      },
      {
        action: room.sendReaction,
        event: { requestId: "invalid", message, emoji: "😺😺" },
        trustedUi: gesture,
      },
      { assertion: assert(() => message.get().reactions.length === 1) },
      {
        action: room.sendReaction,
        event: { requestId: "second", message, emoji: "😺" },
        trustedUi: gesture,
      },
      { assertion: assert(() => message.get().reactions.length === 2) },
      {
        action: room.deleteReaction,
        event: { requestId: "remove", message, emoji: "👩🏽‍💻" },
        trustedUi: gesture,
      },
      {
        action: room.deleteReaction,
        event: { requestId: "remove-again", message, emoji: "👩🏽‍💻" },
        trustedUi: gesture,
      },
      {
        assertion: assert(() =>
          message.get().reactions.length === 1 &&
          message.get().reactions[0].emoji === "😺"
        ),
      },
      {
        action: room.deleteMessage,
        event: { requestId: "delete", message },
        trustedUi: { surface: "ChatDeleteSurface", action: "ChatDelete" },
      },
      {
        action: room.sendReaction,
        event: { requestId: "deleted", message, emoji: "😺" },
        trustedUi: gesture,
      },
      { assertion: assert(() => message.get().reactions.length === 0) },
    ],
  };
});
