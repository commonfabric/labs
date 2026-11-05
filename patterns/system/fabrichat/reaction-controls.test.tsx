/**
 * Reaction controls follow the selected profile's verified owner. Profiles
 * can change while the reaction keeps its actor, and a profile shared by two
 * actors grants neither actor the other's removal rights.
 */
import {
  action,
  assert,
  equals,
  multiUserTest,
  pattern,
  type Stream,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findNodeByProp,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import { FabriChatMessageRow } from "./message-row.tsx";
import type {
  ComposerState,
  MessageCell,
  MessagesCell,
} from "./room-records.tsx";
import {
  profileGesture,
  testRoomProfile,
  testRoomStorage,
} from "./room-test-fixture.ts";
import { FabriChatRoomCore } from "./room.tsx";
import type { ChatProfile, ProfileCell } from "./schemas.tsx";

/** A profile and the gesture that attests its initializing actor. */
interface ProfileFixture {
  /** The profile's live reference. */
  profile: ProfileCell;

  /** Initializes the profile from its reviewed surface. */
  initialize: Stream<void>;
}

/** The room and profile references shared by the participants. */
interface Setup {
  /** Shared room records. */
  records: { messages: MessagesCell };

  /** Alice's original profile, also selected by Bob when he reacts. */
  original: ProfileFixture;

  /** Another profile owned by Alice. */
  alternate: ProfileFixture;
}

/** Shared records and two profiles initialized by Alice. */
export const setup = pattern<Record<string, never>, Setup>(() => ({
  records: testRoomStorage({}),
  original: testRoomProfile({}),
  alternate: testRoomProfile({}),
}));

/** The display of the row's removal control for its single emoji tally. */
const removalDisplay = (view: unknown): unknown => {
  const style = propValue(
    findNodeByProp(view, "aria-label", "Remove my reaction"),
    "style",
  );
  return readValue((style as { display?: unknown } | undefined)?.display);
};

const reactGesture = { surface: "ChatReactSurface", action: "ChatReact" };
const unreactGesture = { surface: "ChatReactSurface", action: "ChatUnreact" };

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const messages = setup.records.messages;
  const message: MessageCell = messages.key(0);
  const selected = new Writable<{ profile?: ProfileCell }>({});
  const room = FabriChatRoomCore({
    messages,
    myProfile: setup.original.profile,
    about: { kind: "group" },
  });
  const rowState = {
    messages,
    message,
    kind: "group" as const,
    inThread: false,
    composer: new Writable.perSession<ComposerState>({}),
    places: new Writable({}),
    cannotWrite: false,
    rowFacts: {},
  };
  const row = FabriChatMessageRow({
    ...rowState,
    myProfile: selected.key("profile"),
  });
  const originalRow = FabriChatMessageRow({
    ...rowState,
    myProfile: setup.original.profile,
  });
  const unownedRow = FabriChatMessageRow({
    ...rowState,
    myProfile: new Writable<ChatProfile>({ name: "Unattested" }),
  });
  const unresolvedRow = FabriChatMessageRow({
    ...rowState,
    myProfile: new Writable<ChatProfile>(),
  });
  return {
    [TESTS]: [
      { action: setup.original.initialize, trustedUi: profileGesture },
      { action: setup.alternate.initialize, trustedUi: profileGesture },
      {
        action: action(() =>
          selected.key("profile").set(setup.alternate.profile)
        ),
      },
      {
        action: room.sendMessage,
        event: { body: "Reaction controls" },
        trustedUi: { surface: "ChatSendSurface", action: "ChatSend" },
      },
      { label: "message-ready" },
      { await: "bob-reacted" },
      {
        assertion: assert(() =>
          originalRow.tallies[0]?.mine === false &&
          originalRow.tallies[0]?.own === undefined &&
          removalDisplay(originalRow[UI]) === "none"
        ),
      },
      {
        assertion: assert(() =>
          unownedRow.tallies[0]?.mine === false &&
          unownedRow.tallies[0]?.own === undefined &&
          removalDisplay(unownedRow[UI]) === "none" &&
          unresolvedRow.tallies[0]?.mine === false &&
          unresolvedRow.tallies[0]?.own === undefined &&
          removalDisplay(unresolvedRow[UI]) === "none"
        ),
      },
      {
        action: row.sendReaction,
        event: { emoji: "😺" },
        trustedUi: reactGesture,
      },
      {
        action: action(() =>
          selected.key("profile").set(setup.original.profile)
        ),
      },
      {
        assertion: assert(() =>
          row.tallies[0]?.count === 2 &&
          row.tallies[0]?.mine === true &&
          equals(row.tallies[0]?.own, message.key("reactions").key(1)) &&
          removalDisplay(row[UI]) === "inline-flex"
        ),
      },
      {
        action: row.deleteReaction,
        event: { reaction: row.tallies[0]?.own },
        trustedUi: unreactGesture,
      },
      {
        assertion: assert(() =>
          message.get().reactions!.get().length === 1 &&
          row.tallies[0]?.count === 1 &&
          row.tallies[0]?.mine === false &&
          row.tallies[0]?.own === undefined &&
          removalDisplay(row[UI]) === "none"
        ),
      },
      { label: "alice-removed" },
      { await: "bob-removed" },
      { assertion: assert(() => row.tallies.length === 0) },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const ownProfile = testRoomProfile({});
  const messages = setup.records.messages;
  const message: MessageCell = messages.key(0);
  const room = FabriChatRoomCore({
    messages,
    myProfile: setup.original.profile,
    about: { kind: "group" },
  });
  const row = FabriChatMessageRow({
    messages,
    message,
    myProfile: ownProfile.profile,
    kind: "group",
    inThread: false,
    composer: new Writable.perSession<ComposerState>({}),
    places: new Writable({}),
    cannotWrite: false,
    rowFacts: {},
  });
  return {
    [TESTS]: [
      { action: ownProfile.initialize, trustedUi: profileGesture },
      { await: "message-ready" },
      {
        action: room.sendReaction,
        event: { message, emoji: "😺" },
        trustedUi: reactGesture,
      },
      { label: "bob-reacted" },
      { await: "alice-removed" },
      {
        assertion: assert(() =>
          row.tallies[0]?.mine === true &&
          equals(row.tallies[0]?.own, message.key("reactions").key(0)) &&
          removalDisplay(row[UI]) === "inline-flex"
        ),
      },
      {
        action: row.deleteReaction,
        event: { reaction: row.tallies[0]?.own },
        trustedUi: unreactGesture,
      },
      { assertion: assert(() => message.get().reactions!.get().length === 0) },
      { label: "bob-removed" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
