/**
 * Exercises message versions and exact request identity through the room's
 * writer streams under the pattern test runner's reviewed gestures.
 */

import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  FabricEpochNsec,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { hasText } from "../test/vnode-helpers.ts";
import { CHAT_POLICY } from "./records.ts";
import {
  FabriChatRoom,
  type StoredMemory,
  type StoredMessage,
} from "./room.tsx";
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
  const version = new Writable({
    body: "  Hello  ",
    sentAt: new FabricEpochNsec(0n),
  });
  const editVersion = new Writable({
    body: "Edited",
    sentAt: new FabricEpochNsec(0n),
  });
  const initialize = action(() => {
    version.key("sentAt").set(
      new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
    );
    editVersion.key("sentAt").set(version.get().sentAt);
    about.set({
      kind: "direct",
      createdAt: new FabricEpochNsec(0n),
      policy,
    });
  });
  const records = new Writable<StoredMessage[]>([]);
  const memory = new Writable<StoredMemory>();
  const room = FabriChatRoom({
    myProfile: profile,
    about,
    records,
    memory,
  });
  const reader = FabriChatRoom({ about, records, memory });
  const firstMessage: Cell<ChatMessage> = records.key(0);
  const sendEvent = { requestId: "send-1", version };
  const editEvent = {
    requestId: "edit-1",
    message: firstMessage,
    version: editVersion,
  };
  const reactEvent = {
    requestId: "react-1",
    message: firstMessage,
    emoji: "👩🏽‍💻",
  };
  const sendGesture = { surface: "ChatSendSurface", action: "ChatSend" };
  const reactGesture = { surface: "ChatReactSurface", action: "ChatReact" };
  return {
    [TESTS]: [
      { action: initialize },
      { render: room[UI] },
      { action: room.sendMessage, event: sendEvent, trustedUi: sendGesture },
      { assertion: assert(() => room.messages.latest.messages.length === 1) },
      { render: room[UI] },
      { assertion: assert(() => hasText(room[UI], "Hello")) },
      { render: reader[UI] },
      { assertion: assert(() => hasText(reader[UI], "Hello")) },
      {
        assertion: assert(() =>
          records.get().length === 1 && records.get()[0].body === "  Hello  "
        ),
      },
      { action: room.sendMessage, event: sendEvent, trustedUi: sendGesture },
      { assertion: assert(() => records.get().length === 1) },
      {
        action: room.messages.openWindow,
        event: {
          requestId: "window-1",
          windowId: "main",
          from: { before: "end" },
          count: 10,
        },
      },
      {
        assertion: assert(() =>
          room.messages.windows.get()?.main?.messages.length === 1 &&
          !room.messages.windows.get()?.main?.hasNewer
        ),
      },
      {
        action: room.sendMessage,
        event: { ...sendEvent, requestId: "send-2" },
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          records.get().length === 2 &&
          records.get()[0].sentAt.value !== records.get()[1].sentAt.value
        ),
      },
      {
        action: room.editMessage,
        event: editEvent,
        trustedUi: { surface: "ChatEditSurface", action: "ChatEdit" },
      },
      {
        assertion: assert(() =>
          records.get()[0].body === "Edited" &&
          records.get()[0].earlierVersions[0].body === "  Hello  "
        ),
      },
      {
        assertion: assert(() =>
          room.messages.windows.get()?.main?.messages.length === 1 &&
          room.messages.windows.get()?.main?.messages[0].body === "Edited" &&
          room.messages.windows.get()?.main?.hasNewer
        ),
      },
      { action: room.sendReaction, event: reactEvent, trustedUi: reactGesture },
      {
        action: room.sendReaction,
        event: { ...reactEvent, requestId: "react-2" },
        trustedUi: reactGesture,
      },
      { assertion: assert(() => records.get()[0].reactions.length === 1) },
      {
        action: room.deleteMessage,
        event: { requestId: "delete-1", message: firstMessage },
        trustedUi: { surface: "ChatDeleteSurface", action: "ChatDelete" },
      },
      {
        assertion: assert(() =>
          typeof records.get()[0].body === "object" &&
          records.get()[0].earlierVersions[1].body === "Edited" &&
          records.get()[0].reactions.length === 0
        ),
      },
      {
        action: room.obliterateMessage,
        event: { requestId: "obliterate-1", message: firstMessage },
        trustedUi: {
          surface: "ChatObliterateSurface",
          action: "ChatObliterate",
        },
      },
      {
        assertion: assert(() =>
          records.get()[0].authorProfile?.get() === undefined &&
          records.get()[0].earlierVersions.length === 0
        ),
      },
      { action: room.sendMessage, event: sendEvent, trustedUi: sendGesture },
      { assertion: assert(() => records.get().length === 2) },
    ],
    room,
  };
});
