/**
 * The principals a FabriChat room's participants stand for, as a client that
 * draws natively reads them from the room's views: an entry for each
 * participant, in the order of `participants`, pairing their profile with the
 * principal its label attests, and with none for a profile that attests no
 * principal; and each principal once, in that order. Each person writes their
 * own profile here, so its label names them, as a Fabric profile's does.
 * That a reader whom a profile's space refuses reads the list without a write
 * fight is something only spaces other than the test's own show, so
 * `../integration/fabrichat-room-principals-multi-runtime.test.ts` checks it.
 */
import {
  action,
  type AddIntegrity,
  assert,
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
import {
  type ActivityCounters,
  type MessagesValue,
  type ReactionList,
  type RequestMemo,
  type SentActivity,
  type UsedTime,
} from "./room-records.tsx";
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
  reactionLists: Writable<ReactionList[]>;
  requests: Writable<RequestMemo[]>;
  usedTimes: Writable<UsedTime[]>;
  activity: Writable<SentActivity[]>;
  counters: Writable<ActivityCounters[]>;
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
    reactionLists: Writable.of<ReactionList[]>([] as ReactionList[]),
    requests: Writable.of<RequestMemo[]>([]),
    usedTimes: Writable.of<UsedTime[]>([]),
    activity: Writable.of<SentActivity[]>([]),
    counters: Writable.of<ActivityCounters[]>([]),
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
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
    roster: setup.records.roster,
  } as RoomArg);
  const otherRoom = FabriChatRoomCore({
    myProfile: otherProfile,
    about: { kind: "group" as const, title: "Team" },
    messages: setup.records.messages,
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
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
// author, and reads the principals through the room's views.
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
    reactionLists: setup.records.reactionLists,
    requests: setup.records.requests,
    usedTimes: setup.records.usedTimes,
    activity: setup.records.activity,
    counters: setup.records.counters,
    roster: setup.records.roster,
  } as RoomArg);

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
      // then the two authors, Alice's other profile and Bob's. They attest
      // Alice, no one, Alice, and Bob.
      {
        assertion: assert(() => {
          const principals = room[VIEWS].room.participantPrincipals;
          return setup.aliceDid.get() !== "" && bobDid.get() !== "" &&
            room.participants.length === 4 &&
            principals.length === 2 &&
            principals[0] === setup.aliceDid.get() &&
            principals[1] === bobDid.get();
        }),
      },
      // The room's own output offers the same list.
      {
        assertion: assert(() =>
          room.participantPrincipals.length === 2 &&
          room.participantPrincipals[0] === setup.aliceDid.get() &&
          room.participantPrincipals[1] === bobDid.get()
        ),
      },
      // One entry for each participant, in order, each with its profile, and
      // with the principal it attests, or none for the unclaimed profile.
      {
        assertion: assert(() => {
          const entries = room[VIEWS].room.participantEntries;
          const aliceDid = setup.aliceDid.get();
          const expected = [aliceDid, undefined, aliceDid, bobDid.get()];
          return aliceDid !== "" && bobDid.get() !== "" &&
            entries.length === room.participants.length &&
            entries.length === expected.length &&
            entries.every((entry, index) =>
              equals(entry.profile, room.participants[index]) &&
              entry.principal === expected[index]
            ) &&
            !("principal" in entries[1]);
        }),
      },
      // The reader's own entry, the one for the profile they read the room
      // with, carries their principal, which is how a client tells which
      // participant is them.
      {
        assertion: assert(() =>
          room.participantEntries.find((entry) =>
              equals(entry.profile, profile)
            )?.principal === bobDid.get() && bobDid.get() !== ""
        ),
      },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
