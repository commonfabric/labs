/**
 * A FabriChat room's members, as a client that draws natively reads them from
 * the room's views: its space's members, each principal the space's access
 * list names with the profiles on the room's roster that are their own, and
 * not the room's participants, which are claims. Alice, the space's OWNER,
 * joins under her profile, adds one whose label names no one, and sends under
 * a second profile of her own without joining under it. Bob, at WRITE, sends
 * without joining. Carol, at READ, does neither. Dave, whom the list leaves
 * out, joins anyway. The participants are all five profiles, and the members
 * are Alice, Bob and Carol, sorted by DID: Alice with the one profile she
 * joined under, and Bob and Carol with none. Each person writes their own
 * profile here, so its label names them, as a Fabric profile's does. That a
 * reader whom a profile's space refuses reads the members without a write
 * fight is something only spaces other than the test's own show, so
 * `../../integration/fabrichat-room-members-multi-runtime.test.ts` checks it.
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
import type { SpaceMember } from "../social-space/member-set.ts";
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

  /** Each person's principal, as their own run of a handler finds it. */
  aliceDid: Writable<string>;
  bobDid: Writable<string>;
  carolDid: Writable<string>;
  daveDid: Writable<string>;
}

export const setup = pattern(() => ({
  records: {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    roster: Writable.of<ParticipantRoster>({}),
  },
  aliceDid: Writable.of<string>(""),
  bobDid: Writable.of<string>(""),
  carolDid: Writable.of<string>(""),
  daveDid: Writable.of<string>(""),
}));

/** The member of `members` whose principal is `did`, if there is one. */
const memberOf = (
  members: readonly SpaceMember[] | undefined,
  did: string,
): SpaceMember | undefined =>
  members?.find((member) => member.principal === did);

// Joins the room under her profile, adds one that attests no one, and sends a
// message under a second profile of her own, which makes it a participant
// without joining under it.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const otherProfile = Writable.of<OwnProfile>();
  const unclaimed = Writable.of<UnclaimedProfile>({ name: "Nobody" });
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

  return {
    [TESTS]: [
      {
        action: writeOwnProfile({ profile, name: "Alice" }),
        event: {},
        trustedUi: profileGesture,
      },
      {
        action: writeOwnProfile({
          profile: otherProfile,
          name: "Alice at work",
        }),
        event: {},
        trustedUi: profileGesture,
      },
      { action: action(() => setup.aliceDid.set(currentPrincipal() ?? "")) },
      { action: action(() => room.addParticipant.send({ profile })) },
      {
        action: action(() => room.addParticipant.send({ profile: unclaimed })),
      },
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
// author, and reads the members through the room's views.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const, title: "Team" },
    messages: setup.records.messages,
    roster: setup.records.roster,
  } as RoomArg);
  const expectedOrder = computed(() =>
    [setup.aliceDid.get(), setup.bobDid.get(), setup.carolDid.get()].sort()
  );

  return {
    [TESTS]: [
      {
        action: writeOwnProfile({ profile, name: "Bob" }),
        event: {},
        trustedUi: profileGesture,
      },
      { action: action(() => setup.bobDid.set(currentPrincipal() ?? "")) },
      { await: "alice-done" },
      { await: "carol-noted" },
      { await: "dave-joined" },
      {
        action: room.composerSend,
        event: typed("Hello from Bob"),
        trustedUi: sendGesture,
      },
      // Five participants: Alice's profile, the unclaimed one and Dave's, as
      // joined, then the two authors, Alice's other profile and Bob's.
      { assertion: assert(() => room.participants.length === 5) },
      // Three members: everyone the access list names, in DID order, and not
      // Dave, whose profile is on the roster all the same.
      {
        assertion: assert(() => {
          const members = room[VIEWS].room.members;
          return setup.carolDid.get() !== "" && members !== undefined &&
            members.length === 3 &&
            members.every((member, index) =>
              member.principal === expectedOrder[index]
            );
        }),
      },
      // The room's own output offers the same list.
      {
        assertion: assert(() =>
          room.members?.length === 3 &&
          room.members.every((member, index) =>
            member.principal === expectedOrder[index]
          )
        ),
      },
      // Each member's level is their entry's.
      {
        assertion: assert(() =>
          memberOf(room.members, setup.aliceDid.get())?.level === "OWNER" &&
          memberOf(room.members, setup.bobDid.get())?.level === "WRITE" &&
          memberOf(room.members, setup.carolDid.get())?.level === "READ"
        ),
      },
      // Alice's one profile is the one she joined under: neither the profile
      // she only sent under nor the one that is no one's counts toward her.
      // Bob, who only sent, and Carol, who never joined, have none.
      {
        assertion: assert(() => {
          const own = memberOf(room.members, setup.aliceDid.get())?.profiles ??
            [];
          return own.length === 1 &&
            equals(own[0], room.participants[0]) &&
            memberOf(room.members, setup.bobDid.get())?.profiles.length ===
              0 &&
            memberOf(room.members, setup.carolDid.get())?.profiles.length ===
              0;
        }),
      },
    ],
  };
});

// Never joins.
export const carol = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { action: action(() => setup.carolDid.set(currentPrincipal() ?? "")) },
    { label: "carol-noted" },
  ],
}));

// Joins, though the list leaves him out, and is given no members to read.
export const dave = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const, title: "Team" },
    messages: setup.records.messages,
    roster: setup.records.roster,
  } as RoomArg);

  return {
    [TESTS]: [
      {
        action: writeOwnProfile({ profile, name: "Dave" }),
        event: {},
        trustedUi: profileGesture,
      },
      { action: action(() => setup.daveDid.set(currentPrincipal() ?? "")) },
      { await: "alice-done" },
      { action: action(() => room.addParticipant.send({ profile })) },
      { assertion: assert(() => room.members === undefined) },
      { label: "dave-joined" },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    alice,
    bob,
    carol: { pattern: carol, access: "READ" },
    dave: { pattern: dave, access: "none" },
  },
});
