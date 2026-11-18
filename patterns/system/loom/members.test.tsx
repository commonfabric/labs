/**
 * The Loom's members, as `members` offers them: each principal the space's
 * access list names, with the profiles on `participants` that are their own,
 * and not the participants themselves, which are claims. Alice, the space's
 * OWNER, joins under her profile and adds one whose label names no one. Bob,
 * at WRITE, never joins. Dave, whom the list leaves out, joins anyway. The
 * participants are three profiles, and the members are Alice and Bob, sorted
 * by DID: Alice with the one profile she joined under, and Bob with none. Each
 * person writes their own profile here, so its label names them, as a Fabric
 * profile's does.
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
  Writable,
} from "commonfabric";
import type { SpaceMember } from "../social-space/member-set.ts";
import Loom from "./main.tsx";
import type { LoomOutput } from "./schemas.tsx";

/** The reviewed surface a person writes their own profile from. */
const PROFILE_SURFACE = "LoomTestMembersProfileSurface";

/** The reviewed action a person writes their own profile with. */
const PROFILE_ACTION = "LoomTestMembersWriteProfile";

/** The gesture writing a profile takes. */
const profileGesture = { surface: PROFILE_SURFACE, action: PROFILE_ACTION };

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

/** A profile whose label names no principal, so it is no one's. */
type UnclaimedProfile = AddIntegrity<
  Profile,
  readonly ["loom-test-members-profile"]
>;

/** What every session receives from the setup. */
interface Setup {
  /** The Loom, which every participant shares. */
  loom: LoomOutput;

  /** Each person's principal, as their own run of an action finds it. */
  aliceDid: Writable<string>;
  bobDid: Writable<string>;
  daveDid: Writable<string>;
}

export const setup = pattern(() => ({
  loom: Loom({}),
  aliceDid: Writable.of<string>(""),
  bobDid: Writable.of<string>(""),
  daveDid: Writable.of<string>(""),
}));

/** The member of `members` whose principal is `did`, if there is one. */
const memberOf = (
  members: readonly SpaceMember[] | undefined,
  did: string,
): SpaceMember | undefined =>
  members?.find((member) => member.principal === did);

// Joins under her profile, and adds one that attests no one.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const unclaimed = Writable.of<UnclaimedProfile>({ name: "Nobody" });

  return {
    [TESTS]: [
      {
        action: writeOwnProfile({ profile, name: "Alice" }),
        event: {},
        trustedUi: profileGesture,
      },
      { action: action(() => setup.aliceDid.set(currentPrincipal() ?? "")) },
      { action: action(() => setup.loom.addParticipant.send({ profile })) },
      {
        action: action(() =>
          setup.loom.addParticipant.send({ profile: unclaimed })
        ),
      },
      { label: "alice-done" },
    ],
  };
});

// Never joins, and reads the members.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const expectedOrder = computed(() =>
    [setup.aliceDid.get(), setup.bobDid.get()].sort()
  );

  return {
    [TESTS]: [
      { action: action(() => setup.bobDid.set(currentPrincipal() ?? "")) },
      { await: "alice-done" },
      { await: "dave-joined" },
      // Three participants: Alice's profile, the unclaimed one and Dave's.
      { assertion: assert(() => setup.loom.participants.length === 3) },
      // Two members: everyone the access list names, in DID order, and not
      // Dave, whose profile is on the roster all the same.
      {
        assertion: assert(() => {
          const members = setup.loom.members;
          return setup.aliceDid.get() !== "" && members !== undefined &&
            members.length === 2 &&
            members.every((member, index) =>
              member.principal === expectedOrder[index]
            );
        }),
      },
      // Each member's level is their entry's.
      {
        assertion: assert(() =>
          memberOf(setup.loom.members, setup.aliceDid.get())?.level ===
            "OWNER" &&
          memberOf(setup.loom.members, setup.bobDid.get())?.level === "WRITE"
        ),
      },
      // Alice's one profile is the one she joined under: the one that is no
      // one's doesn't count toward her. Bob, who never joined, has none.
      {
        assertion: assert(() => {
          const own =
            memberOf(setup.loom.members, setup.aliceDid.get())?.profiles ??
              [];
          return own.length === 1 &&
            equals(own[0], setup.loom.participants[0]) &&
            memberOf(setup.loom.members, setup.bobDid.get())?.profiles
                .length === 0;
        }),
      },
    ],
  };
});

// Joins, though the list leaves him out, and is given no members to read.
export const dave = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();

  return {
    [TESTS]: [
      {
        action: writeOwnProfile({ profile, name: "Dave" }),
        event: {},
        trustedUi: profileGesture,
      },
      { action: action(() => setup.daveDid.set(currentPrincipal() ?? "")) },
      { await: "alice-done" },
      { action: action(() => setup.loom.addParticipant.send({ profile })) },
      { assertion: assert(() => setup.loom.members === undefined) },
      { label: "dave-joined" },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: {
    alice,
    bob,
    dave: { pattern: dave, access: "none" },
  },
});
