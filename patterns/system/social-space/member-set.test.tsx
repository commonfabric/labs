/**
 * A social space's members, as `memberSet()` joins its access list and its
 * roster. Alice, the space's OWNER, joins under two profiles of their own,
 * and adds one whose label names no one and one whose name is borrowed from
 * Alice's own profile, which is no one's by the ownership rule though its
 * label names Alice. Bob, at WRITE, joins under their own profile. Carol, at
 * READ, never joins. Dave, whom the list leaves out, joins anyway. The members
 * are Alice, Bob and Carol, sorted by DID: Alice with two profiles in roster
 * order, Bob with one, and Carol with none, while the two profiles that are no
 * one's and Dave's count toward no one. Once Alice revokes Bob, Bob is no
 * longer a member, though Bob's profile stays on the roster.
 */
import {
  action,
  type AddIntegrity,
  assert,
  computed,
  currentPrincipal,
  equals,
  handler,
  isWellFormedDID,
  multiUserTest,
  pattern,
  principalOf,
  type RepresentsCurrentUser,
  revokeSpaceAccess,
  spaceMembers,
  TESTS,
  type TrustedActionWrite,
  Writable,
} from "commonfabric";
import {
  addParticipant,
  type ParticipantRoster,
  rosterProfiles,
} from "../loom/participants.tsx";
import { memberSet } from "./member-set.ts";

/** The reviewed surface a person writes their own profile from. */
const PROFILE_SURFACE = "SocialSpaceTestProfileSurface";

/** The reviewed action a person writes their own profile with. */
const PROFILE_ACTION = "SocialSpaceTestWriteProfile";

/** The gesture writing a profile takes. */
const profileGesture = { surface: PROFILE_SURFACE, action: PROFILE_ACTION };

/** The gesture an OWNER's revocation takes. */
const revokeGesture = {
  surface: "SocialSpaceTestMembersSurface",
  action: "SocialSpaceTestRevoke",
};

/** What a profile holds. */
interface Profile {
  /** The name its owner goes by. */
  name?: string;

  /** A picture of its owner. */
  avatar?: string;
}

/**
 * A person's own profile, labeled with the principal who wrote it, which only
 * `writeOwnProfile` writes, from its reviewed surface.
 */
type OwnProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    Profile,
    typeof writeOwnProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** A profile whose label names no principal, so it is no one's. */
type UnclaimedProfile = AddIntegrity<
  Profile,
  readonly ["social-space-test-profile"]
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
  profile.set({ name });
});

/**
 * A person's own profile, as `OwnProfile` is, whose `name` holds a link, which
 * only `writeBorrowingProfile` writes, from the same reviewed surface.
 */
type BorrowingProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    Profile,
    typeof writeBorrowingProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeBorrowingProfile` is bound to. */
interface BorrowingProfileWriteState {
  /** The profile to write. */
  profile: Writable<BorrowingProfile>;

  /** The name, in another document, that its `name` is to link. */
  name: Writable<string | undefined>;
}

/** Writes the acting person's `BorrowingProfile`, its `name` linking `name`. */
const writeBorrowingProfile = handler<unknown, BorrowingProfileWriteState>((
  _event,
  { profile, name },
) => {
  profile.set({ name });
});

/** What `notePrincipal` is bound to. */
interface NoteState {
  /** Where to record the acting principal. */
  did: Writable<string>;
}

/** Records the acting principal, as its own run of a handler finds it. */
const notePrincipal = handler<unknown, NoteState>((_event, { did }) => {
  did.set(currentPrincipal() ?? "");
});

/** What `revokeMember` is bound to. */
interface RevokeState {
  /** A cell in the space whose access list loses the entry. */
  roster: Writable<ParticipantRoster>;

  /** The principal whose entry is removed. */
  principal: Writable<string>;
}

/** Removes `principal`'s entry from the space's access list. */
const revokeMember = handler<unknown, RevokeState>((
  _event,
  { roster, principal },
) => {
  const did = principal.get();
  if (!isWellFormedDID(did)) {
    throw new Error("The principal to revoke is not recorded yet.");
  }
  revokeSpaceAccess(roster, did);
});

/** What every session receives from the setup. */
interface Setup {
  /** The space's roster, which every participant shares. */
  roster: Writable<ParticipantRoster>;

  /** Each person's principal, as their own run of a handler finds it. */
  aliceDid: Writable<string>;
  bobDid: Writable<string>;
  carolDid: Writable<string>;
  daveDid: Writable<string>;
}

export const setup = pattern(() => ({
  roster: Writable.of<ParticipantRoster>({}),
  aliceDid: Writable.of<string>(""),
  bobDid: Writable.of<string>(""),
  carolDid: Writable.of<string>(""),
  daveDid: Writable.of<string>(""),
}));

// Joins under two profiles of their own, the second-written first, and adds the
// two that are no one's between them; checks the members once everyone has
// acted, then revokes Bob and checks them again.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const workProfile = Writable.of<OwnProfile>();
  const unclaimed = Writable.of<UnclaimedProfile>({ name: "Nobody" });
  const borrowing = Writable.of<BorrowingProfile>();
  const join = addParticipant({ roster: setup.roster });
  const members = computed(() =>
    memberSet(rosterProfiles(setup.roster), spaceMembers(setup.roster))
  );
  const fromAnyoneOnly = computed(() =>
    memberSet(rosterProfiles(setup.roster), {
      principals: {},
      anyone: "WRITE",
    })
  );
  const expectedOrder = computed(() =>
    [setup.aliceDid.get(), setup.bobDid.get(), setup.carolDid.get()].sort()
  );

  return {
    [TESTS]: [
      {
        action: writeOwnProfile({ profile, name: "Alice" }),
        event: {},
        trustedUi: profileGesture,
      },
      {
        action: writeOwnProfile({
          profile: workProfile,
          name: "Alice at work",
        }),
        event: {},
        trustedUi: profileGesture,
      },
      {
        action: writeBorrowingProfile({
          profile: borrowing,
          name: profile.key("name"),
        }),
        event: {},
        trustedUi: profileGesture,
      },
      { action: notePrincipal({ did: setup.aliceDid }), event: {} },
      { action: action(() => join.send({ profile: workProfile })) },
      { action: action(() => join.send({ profile: unclaimed })) },
      { action: action(() => join.send({ profile: borrowing })) },
      { action: action(() => join.send({ profile })) },
      { label: "alice-joined" },
      { await: "bob-joined" },
      { await: "carol-noted" },
      { await: "dave-joined" },
      // The borrowing profile's label names Alice, so only the ownership rule
      // tells it from Alice's own.
      {
        assertion: assert(() =>
          setup.aliceDid.get() !== "" &&
          principalOf(borrowing, "represents-principal") ===
            setup.aliceDid.get()
        ),
      },
      // Six roster entries, and three members: everyone the list names, in
      // DID order, and no one else.
      {
        assertion: assert(() =>
          rosterProfiles(setup.roster).length === 6 &&
          members !== undefined &&
          members.length === 3 &&
          members.every((member, index) =>
            member.principal === expectedOrder[index]
          )
        ),
      },
      // Each member's level is their entry's.
      {
        assertion: assert(() =>
          members?.find((member) => member.principal === setup.aliceDid.get())
              ?.level === "OWNER" &&
          members?.find((member) => member.principal === setup.bobDid.get())
              ?.level === "WRITE" &&
          members?.find((member) => member.principal === setup.carolDid.get())
              ?.level === "READ"
        ),
      },
      // Alice's two profiles, in roster order rather than the order Alice wrote
      // them, so the first is the one a reader shows.
      {
        assertion: assert(() => {
          const own = members?.find((member) =>
            member.principal === setup.aliceDid.get()
          )?.profiles ?? [];
          return own.length === 2 && equals(own[0], workProfile) &&
            equals(own[1], profile);
        }),
      },
      // Bob's one profile, and Carol, who never joined, with none. The two
      // profiles that are no one's and Dave's count toward no member.
      {
        assertion: assert(() =>
          members?.find((member) => member.principal === setup.bobDid.get())
              ?.profiles.length === 1 &&
          members?.find((member) => member.principal === setup.carolDid.get())
              ?.profiles.length === 0 &&
          members?.reduce(
              (count, member) => count + member.profiles.length,
              0,
            ) === 3
        ),
      },
      // A list whose only entry is `"*"` names no one, so it has no members,
      // which is an empty list rather than none.
      { assertion: assert(() => fromAnyoneOnly?.length === 0) },
      {
        action: revokeMember({
          roster: setup.roster,
          principal: setup.bobDid,
        }),
        event: {},
        trustedUi: revokeGesture,
      },
      // Bob is no longer a member, though Bob's profile is still on the roster.
      {
        assertion: assert(() =>
          rosterProfiles(setup.roster).length === 6 &&
          members?.length === 2 &&
          members.every((member) => member.principal !== setup.bobDid.get())
        ),
      },
    ],
  };
});

// Joins under their own profile.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const join = addParticipant({ roster: setup.roster });

  return {
    [TESTS]: [
      {
        action: writeOwnProfile({ profile, name: "Bob" }),
        event: {},
        trustedUi: profileGesture,
      },
      { action: notePrincipal({ did: setup.bobDid }), event: {} },
      { await: "alice-joined" },
      { action: action(() => join.send({ profile })) },
      { label: "bob-joined" },
    ],
  };
});

// Never joins.
export const carol = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { action: notePrincipal({ did: setup.carolDid }), event: {} },
    { label: "carol-noted" },
  ],
}));

// Joins, though the list leaves them out, and is given no members to read.
export const dave = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const join = addParticipant({ roster: setup.roster });
  const members = computed(() =>
    memberSet(rosterProfiles(setup.roster), spaceMembers(setup.roster))
  );

  return {
    [TESTS]: [
      {
        action: writeOwnProfile({ profile, name: "Dave" }),
        event: {},
        trustedUi: profileGesture,
      },
      { action: notePrincipal({ did: setup.daveDid }), event: {} },
      { await: "alice-joined" },
      { action: action(() => join.send({ profile })) },
      { assertion: assert(() => members === undefined) },
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
