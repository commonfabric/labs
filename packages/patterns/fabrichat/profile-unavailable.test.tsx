/**
 * Profile availability changes no ownership and removes no participant links.
 * A sender can delete and obliterate a message after their profile disappears.
 */
import {
  action,
  type AddIntegrity,
  assert,
  equals,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import type { ParticipantRoster } from "../loom/participants.tsx";
import { bodyText } from "./message-row.tsx";
import type { MessageCell } from "./room-records.tsx";
import { testRoomStorage } from "./room-test-fixture.ts";
import { FabriChatRoomCore } from "./room.tsx";
import type { ChatProfile } from "./schemas.tsx";

export default pattern(() => {
  const profile = new Writable<
    AddIntegrity<ChatProfile | undefined, ["chat-test"]>
  >();
  const listed = new Writable<
    AddIntegrity<ChatProfile | undefined, ["chat-test"]>
  >();
  const roster = new Writable<ParticipantRoster>({});
  const records = testRoomStorage({});
  const room = FabriChatRoomCore({
    messages: records.messages,
    reactionLists: records.reactionLists,
    requests: records.requests,
    usedTimes: records.usedTimes,
    activity: records.activity,
    counters: records.counters,
    roster,
    about: { kind: "direct" },
    myProfile: profile,
  });
  const message: MessageCell = records.messages.key(0);
  const initializeProfiles = action(() => {
    profile.set({ name: "Alice" });
    listed.set({ name: "Listed participant" });
  });
  const clearProfiles = action(() => {
    profile.set(undefined);
    listed.set(undefined);
  });
  return {
    [TESTS]: [
      { action: initializeProfiles },
      { action: room.addParticipant, event: { profile: listed } },
      {
        action: room.sendMessage,
        event: { requestId: "send", target: { value: "Private text" } },
        trustedUi: { surface: "ChatSendSurface", action: "ChatSend" },
      },
      {
        assertion: assert(() =>
          message.get().body === "Private text" &&
          room.participants.length === 2
        ),
      },
      { action: clearProfiles },
      {
        assertion: assert(() =>
          profile.get() === undefined && listed.get() === undefined &&
          room.participants.length === 2 && room.participants.some((each) =>
            equals(each, profile)
          ) && room.participants.some((each) => equals(each, listed))
        ),
      },
      {
        action: room.deleteMessage,
        event: { requestId: "delete", message },
        trustedUi: { surface: "ChatDeleteSurface", action: "ChatDelete" },
      },
      {
        assertion: assert(() =>
          typeof message.get().body === "object" &&
          message.get().earlierVersions.length === 1 &&
          bodyText(message.get()) === "This message was deleted." &&
          room.participants.length === 2
        ),
      },
      {
        action: room.obliterateMessage,
        event: { requestId: "obliterate", message },
        trustedUi: {
          surface: "ChatObliterateSurface",
          action: "ChatObliterate",
        },
      },
      {
        assertion: assert(() =>
          message.get().authorProfile?.get() === undefined &&
          message.get().earlierVersions.length === 0 &&
          bodyText(message.get()) === "This message was removed." &&
          room.participants.length === 1 && equals(room.participants[0], listed)
        ),
      },
      {
        action: room.obliterateMessage,
        event: { requestId: "obliterate-again", message },
        trustedUi: {
          surface: "ChatObliterateSurface",
          action: "ChatObliterate",
        },
      },
      {
        assertion: assert(() =>
          room.recentActivity.length === 1 && room.recentActivity[0].seq === 3
        ),
      },
    ],
  };
});
