/**
 * Room descriptors follow titles and roster references independently of the
 * conversation's messages. The integration tests cover the descriptor's own
 * address and its storage dependencies.
 */

import {
  action,
  type AddIntegrity,
  assert,
  equals,
  pattern,
  TESTS,
  VIEWS,
  Writable,
} from "commonfabric";
import type { ParticipantRoster } from "../loom/participants.tsx";
import type { MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_RETITLE_ACTION,
  CHAT_RETITLE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  type TitleRecord,
} from "./schemas.tsx";

/** The factory's accepted cell bindings. */
type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

/** A labeled stand-in for the viewer's profile. */
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

export default pattern(() => {
  const alice = Writable.of<TestProfile>({ name: "Alice" });
  const bob = Writable.of<TestProfile>({ name: "Bob" });
  const roster = Writable.of<ParticipantRoster>({});
  const room = FabriChatRoomCore({
    myProfile: alice,
    about: { kind: "group", title: "Team" },
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    titles: Writable.of<TitleRecord[]>([]),
    roster,
  } as RoomArg);
  const direct = FabriChatRoomCore({
    myProfile: alice,
    about: { kind: "direct" },
    messages: Writable.of<MessagesValue>([] as MessagesValue),
  } as RoomArg);
  const untitled = FabriChatRoomCore({
    myProfile: alice,
    messages: Writable.of<MessagesValue>([] as MessagesValue),
  } as RoomArg);
  const renameBob = action(() => bob.key("name").set("Robert"));

  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          room.metadata?.kind === "group" &&
          room.metadata?.title === "Team" &&
          room.metadata?.room === undefined &&
          room.metadata?.roster.length === 0 &&
          direct.metadata?.kind === "direct" &&
          direct.metadata?.title === undefined &&
          untitled.metadata?.kind === "group" &&
          untitled.metadata?.title === undefined
        ),
      },
      {
        action: room.sendMessage,
        event: { body: "A message leaves the descriptor unchanged" },
        trustedUi: { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION },
      },
      {
        assertion: assert(() =>
          room.messages.count === 1 &&
          room.metadata?.kind === "group" &&
          room.metadata?.title === "Team" &&
          room.metadata?.roster.length === 0
        ),
      },
      {
        action: room.setTitle,
        event: { requestId: "rename", title: "Plans" },
        trustedUi: {
          surface: CHAT_RETITLE_SURFACE,
          action: CHAT_RETITLE_ACTION,
        },
      },
      {
        assertion: assert(() =>
          room.metadata?.title === "Plans" &&
          room[VIEWS].room.metadata?.title === "Plans"
        ),
      },
      { action: room.addParticipant, event: { profile: bob } },
      { action: room.addParticipant, event: { profile: alice } },
      { action: room.addParticipant, event: { profile: bob } },
      {
        assertion: assert(() =>
          room.metadata?.roster.length === 2 &&
          equals(room.metadata?.roster[0], bob) &&
          equals(room.metadata?.roster[1], alice)
        ),
      },
      { action: renameBob },
      {
        assertion: assert(() =>
          room.metadata?.roster.length === 2 &&
          room.metadata?.roster[0].get().name === "Robert" &&
          equals(room.metadata?.roster[0], bob) &&
          room.metadata?.title === "Plans"
        ),
      },
    ],
  };
});
