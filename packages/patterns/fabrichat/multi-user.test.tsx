/** Verifies that independent viewers render the same authored messages. */
import {
  action,
  type AddIntegrity,
  assert,
  FabricEpochNsec,
  handler,
  multiUserTest,
  pattern,
  type RepresentsCurrentUser,
  type Stream,
  TESTS,
  type TrustedActionWrite,
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
} from "./schemas.tsx";
import { clickButton, hasText } from "../test/vnode-helpers.ts";

interface Setup {
  room: ChatRoomOutput;
  initialize: Stream<void>;
  initializeProfile: Stream<void>;
}

/** A profile attested by the authenticated participant's own gesture. */
type OwnProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    ChatProfile,
    typeof writeProfile,
    "FabriChatTestWriteProfile",
    "FabriChatTestProfileSurface"
  >
>;

/** The independently scoped profile the writer initializes. */
interface ProfileState {
  profile: Writable<OwnProfile>;
}

/** Gives each participant a profile whose label names their own principal. */
const writeProfile = handler<void, ProfileState>(
  (_, { profile }) => {
    profile.set({ name: "Reader" } as OwnProfile);
  },
);

const profileGesture = {
  surface: "FabriChatTestProfileSurface",
  action: "FabriChatTestWriteProfile",
};

export const setup = pattern<Record<string, never>, Setup>(() => {
  const profile = new Writable.perUser<OwnProfile>();
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
    initializeProfile: writeProfile({ profile }),
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
      { action: setup.initializeProfile, trustedUi: profileGesture },
      { action: setup.initialize },
      {
        action: action(() =>
          version.key("sentAt").set(
            new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
          )
        ),
      },
      {
        render: setup.room[UI],
      },
      {
        action: setup.room.sendMessage,
        event: { requestId: "alice-message", version },
        trustedUi: { surface: "ChatSendSurface", action: "ChatSend" },
      },
      { render: setup.room[UI] },
      { assertion: assert(() => hasText(setup.room[UI], "Hello from Alice")) },
      { assertion: assert(() => hasText(setup.room[UI], "Edit")) },
      { assertion: assert(() => setup.room.canSend) },
      { label: "alice-sent" },
      { await: "bob-read" },
      { await: "reader-read" },
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
    { action: setup.initializeProfile, trustedUi: profileGesture },
    { await: "alice-sent" },
    { assertion: assert(() => setup.room.messages.count === 1) },
    { render: setup.room[UI] },
    { assertion: assert(() => hasText(setup.room[UI], "Hello from Alice")) },
    { assertion: assert(() => !hasText(setup.room[UI], "Edit")) },
    { assertion: assert(() => setup.room.canSend) },
    { action: action(() => clickButton(setup.room[UI], "Reply")) },
    { render: setup.room[UI] },
    {
      assertion: assert(() => hasText(setup.room[UI], "Replying to a message")),
    },
    { label: "bob-read" },
  ],
}));

export const reader = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { action: setup.initializeProfile, trustedUi: profileGesture },
    { await: "alice-sent" },
    { render: setup.room[UI] },
    { assertion: assert(() => hasText(setup.room[UI], "Hello from Alice")) },
    { assertion: assert(() => !setup.room.canSend) },
    {
      assertion: assert(() =>
        hasText(
          setup.room[UI],
          "A profile and write access are required to send.",
        )
      ),
    },
    { label: "reader-read" },
  ],
}));

export default multiUserTest({
  setup,
  participants: { alice, bob, reader: { pattern: reader, access: "READ" } },
});
