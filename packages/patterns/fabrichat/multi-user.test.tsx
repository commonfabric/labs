/** Verifies that independent viewers render the same authored messages. */
import {
  action,
  type AddIntegrity,
  assert,
  FabricEpochNsec,
  multiUserTest,
  pattern,
  type Stream,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { FabriChatRoom, type StoredMemory } from "./room.tsx";
import { CHAT_POLICY } from "./records.ts";
import type {
  ChatProfile,
  ChatRoomAbout,
  ChatRoomOutput,
  ChatRoomPolicy,
} from "./schemas.ts";
import { clickButton, hasText } from "../test/vnode-helpers.ts";

interface Setup {
  room: ChatRoomOutput;
  initialize: Stream<void>;
}

export const setup = pattern<Record<string, never>, Setup>(() => {
  const profile = new Writable.perUser<
    AddIntegrity<ChatProfile, ["chat-test"]>
  >({ name: "Reader" });
  const policy = new Writable<AddIntegrity<ChatRoomPolicy, ["chat-test"]>>(
    CHAT_POLICY,
  );
  const about = new Writable<AddIntegrity<ChatRoomAbout, ["chat-test"]>>();
  const initialize = action(() =>
    about.set({
      kind: "group",
      title: "Shared room",
      createdAt: new FabricEpochNsec(0n),
      policy,
    })
  );
  const memory = new Writable<StoredMemory>();
  return {
    initialize,
    room: FabriChatRoom({ about, memory, myProfile: profile }),
  };
});

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const version = new Writable({
    body: "Hello from Alice",
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
        event: { requestId: "alice-message", version },
        trustedUi: { surface: "ChatSendSurface", action: "ChatSend" },
      },
      { render: setup.room[UI] },
      { assertion: assert(() => hasText(setup.room[UI], "Hello from Alice")) },
      { assertion: assert(() => hasText(setup.room[UI], "Edit")) },
      { label: "alice-sent" },
      { await: "bob-read" },
      { render: setup.room[UI] },
      {
        assertion: assert(() =>
          !hasText(setup.room[UI], "Replying to a message")
        ),
      },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "alice-sent" },
    { assertion: assert(() => setup.room.messages.count === 1) },
    { render: setup.room[UI] },
    { assertion: assert(() => hasText(setup.room[UI], "Hello from Alice")) },
    { assertion: assert(() => !hasText(setup.room[UI], "Edit")) },
    { action: action(() => clickButton(setup.room[UI], "Reply")) },
    { render: setup.room[UI] },
    {
      assertion: assert(() => hasText(setup.room[UI], "Replying to a message")),
    },
    { label: "bob-read" },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
