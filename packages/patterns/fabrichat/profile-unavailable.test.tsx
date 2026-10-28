/**
 * Deletion requires a resolved profile. Owner moderation remains available
 * after the selected profile is cleared.
 */

import {
  action,
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import { bodyText } from "./message-row.tsx";
import type { MessageCell } from "./room-records.tsx";
import { testRoomStorage } from "./room-test-fixture.ts";
import { FabriChatRoomCore } from "./room.tsx";
import type { ChatProfile } from "./schemas.tsx";

export default pattern(() => {
  const profile = new Writable<
    AddIntegrity<ChatProfile | undefined, ["chat-test"]>
  >();
  const records = testRoomStorage({});
  const room = FabriChatRoomCore({
    messages: records.messages,
    about: { kind: "group" },
    myProfile: profile,
  });
  const message: MessageCell = records.messages.key(0);
  const initializeProfile = action(() => {
    profile.set({ name: "Alice" });
  });
  const clearProfile = action(() => {
    profile.set(undefined);
  });
  return {
    [TESTS]: [
      { action: initializeProfile },
      {
        action: room.sendMessage,
        event: { target: { value: "Private text" } },
        trustedUi: { surface: "ChatSendSurface", action: "ChatSend" },
      },
      {
        assertion: assert(() => message.get().body === "Private text"),
      },
      { action: clearProfile },
      {
        assertion: assert(() => profile.get() === undefined),
      },
      {
        action: room.deleteMessage,
        event: { message },
        trustedUi: { surface: "ChatDeleteSurface", action: "ChatDelete" },
      },
      {
        assertion: assert(() => message.get().body === "Private text"),
      },
      {
        action: room.obliterateMessage,
        event: { message },
        trustedUi: {
          surface: "ChatObliterateSurface",
          action: "ChatObliterate",
        },
      },
      {
        assertion: assert(() =>
          message.get().authorProfile === undefined &&
          bodyText(message.get()) === "This message was removed."
        ),
      },
      {
        action: room.obliterateMessage,
        event: { message },
        trustedUi: {
          surface: "ChatObliterateSurface",
          action: "ChatObliterate",
        },
      },
      {
        assertion: assert(() =>
          bodyText(message.get()) === "This message was removed."
        ),
      },
    ],
    expectRuntimeErrors: ["Your profile hasn't loaded yet."],
  };
});
