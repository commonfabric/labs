/**
 * A FabriChat room's deprecated `participantEntries` and
 * `participantPrincipals`, as a client that draws natively reads them from the
 * room's views: the room's `members` in the shapes clients read before it.
 * The principals are the members', each principal the space's access list
 * names, in DID order, whether or not they joined, and the entries pair each
 * member's own profile on the roster with the member's principal. A profile
 * that is no one's, or that only sent a message, has no entry. Each person
 * writes their own profile here, so its label names them, as a Fabric
 * profile's does. That a reader whom a profile's space refuses reads them
 * without a write fight is something only spaces other than the test's own
 * show, so `../../integration/fabrichat-room-members-multi-runtime.test.ts`
 * checks it.
 */
import {
  action,
  type AddIntegrity,
  assert,
  computed,
  currentPrincipal,
  equals,
  handler,
  multiUserTest,
  pattern,
  type RepresentsCurrentUser,
  TESTS,
  type TrustedActionWrite,
  VIEWS,
  Writable,
} from "commonfabric";
import type { ParticipantRoster } from "../loom/participants.tsx";
import { type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

/** The reviewed surface and action a person writes their own profile from. */
const PROFILE_SURFACE = "FabriChatTestProfileSurface";
const PROFILE_ACTION = "FabriChatTestWriteProfile";

/** The gesture writing a profile takes. */
const profileGesture = { surface: PROFILE_SURFACE, action: PROFILE_ACTION };

/**
 * A person's own profile, labeled with the principal who wrote it, which only
 * `writeOwnProfile` writes, from its reviewed surface.
 */
type OwnProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    ChatProfile,
    typeof writeOwnProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeOwnProfile` is bound to. */
interface ProfileWriteState {
  /** The profile to write. */
  profile: Writable<OwnProfile>;

  /** The name to write into it. */
  name: string;
}

/** Writes the acting person's own profile, under `name`. */
const writeOwnProfile = handler<unknown, ProfileWriteState>((
  _event,
  { profile, name },
) => {
  profile.set({ name } as OwnProfile);
});

/** A profile whose label names no principal. */
type UnclaimedProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** The room's records, which every participant's room shares. */
interface Records {
  messages: Writable<MessagesValue>;
  roster: Writable<ParticipantRoster>;
}

/** What every session receives from the setup. */
interface Setup {
  records: Records;

  /** Alice's principal, as her own run of a handler finds it. */
  aliceDid: Writable<string>;
}

export const setup = pattern(() => ({
  records: {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    roster: Writable.of<ParticipantRoster>({}),
  },
  aliceDid: Writable.of<string>(""),
}));

// Joins the room under her profile, adds one that attests no one, and sends a
// message under a second profile of her own, which makes it a participant
// that attests her again.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const otherProfile = Writable.of<OwnProfile>();
  const unclaimed = Writable.of<UnclaimedProfile>({ name: "Nobody" });
  const writeProfile = writeOwnProfile({ profile, name: "Alice" });
  const writeOtherProfile = writeOwnProfile({
    profile: otherProfile,
    name: "Alice at work",
  });
  const action_note_principal = action(() =>
    setup.aliceDid.set(currentPrincipal() ?? "")
  );
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const, title: "Team" },
    messages: setup.records.messages,
    roster: setup.records.roster,
  } as RoomArg);
  const otherRoom = FabriChatRoomCore({
    myProfile: otherProfile,
    about: { kind: "group" as const, title: "Team" },
    messages: setup.records.messages,
    roster: setup.records.roster,
  } as RoomArg);
  const action_join = action(() => room.addParticipant.send({ profile }));
  const action_add_unclaimed = action(() =>
    room.addParticipant.send({ profile: unclaimed })
  );

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: writeOtherProfile, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      { action: action_join },
      { action: action_add_unclaimed },
      {
        action: otherRoom.composerSend,
        event: typed("Hello from Alice at work"),
        trustedUi: sendGesture,
      },
      { label: "alice-done" },
    ],
  };
});

// Sends a message without joining, which makes him a participant only as an
// author, and reads the principals and entries through the room's views.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Bob" });
  const bobDid = Writable.of<string>("");
  const action_note_principal = action(() =>
    bobDid.set(currentPrincipal() ?? "")
  );
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const, title: "Team" },
    messages: setup.records.messages,
    roster: setup.records.roster,
  } as RoomArg);
  const expectedOrder = computed(() =>
    [setup.aliceDid.get(), bobDid.get()].sort()
  );

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: action_note_principal },
      { await: "alice-done" },
      {
        action: room.composerSend,
        event: typed("Hello from Bob"),
        trustedUi: sendGesture,
      },
      // Four participants: Alice's profile and the unclaimed one, as joined,
      // then the two authors, Alice's other profile and Bob's. The principals
      // are the two members, in DID order, though Bob never joined.
      {
        assertion: assert(() => {
          const principals = room[VIEWS].room.participantPrincipals;
          return setup.aliceDid.get() !== "" && bobDid.get() !== "" &&
            room.participants.length === 4 &&
            principals.length === 2 &&
            principals[0] === expectedOrder[0] &&
            principals[1] === expectedOrder[1];
        }),
      },
      // The room's own output offers the same list.
      {
        assertion: assert(() =>
          room.participantPrincipals.length === 2 &&
          room.participantPrincipals[0] === expectedOrder[0] &&
          room.participantPrincipals[1] === expectedOrder[1]
        ),
      },
      // One entry, for the one profile on the roster that is a member's own:
      // Alice's, with her principal. The unclaimed profile is no one's, and
      // Alice's other profile and Bob's are only authors.
      {
        assertion: assert(() => {
          const entries = room[VIEWS].room.participantEntries;
          return setup.aliceDid.get() !== "" && entries.length === 1 &&
            equals(entries[0]?.profile, room.participants[0]) &&
            entries[0]?.principal === setup.aliceDid.get();
        }),
      },
      // Bob, who never joined, has no entry for the profile he reads the room
      // with.
      {
        assertion: assert(() =>
          room.participantEntries.length === 1 &&
          room.participantEntries.every((entry) =>
            !equals(entry.profile, profile)
          )
        ),
      },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
