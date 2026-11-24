/**
 * Parking Coordinator — admin roster authority
 *
 * Who may change who is a parking admin, and what a role is bound to. A role
 * names the viewer's profile cell rather than their name, so these tests are
 * about identities: an open first grant, a role surviving a rename, a role
 * dropped with the person who held it, a viewer who holds no role being
 * refused, and the claim that makes a person identifiable in the first place.
 *
 * Split out of `main.test.tsx`, which covers the parking behavior itself and
 * runs long enough on its own.
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findNodeByProp,
  propValue,
} from "../../../tools/test-support/vnode-helpers.ts";
import ParkingCoordinator, { DEFAULT_SPOTS } from "./main.tsx";
import type { ParkingProfile, Person } from "./main.tsx";

const len = <T,>(arr: T[]): number => arr.filter(() => true).length;

// Whether a person row has been claimed by a Fabric identity.
const hasProfile = (people: Person[], name: string): boolean =>
  people.find((person) => person.name === name)?.profile !== undefined;

// The Admin Access card renders one row per person, with a chip reading
// "Admin" or "Member".
const adminRowIsAdmin = (ui: unknown, name: string): boolean =>
  findNodeByProp(
    findNodeByProp(ui, "data-parking-admin-row", name),
    "label",
    "Admin",
  ) !== undefined;

export default pattern(() => {
  // ============================================================
  // Subject 1: Admin roster authority
  // ============================================================

  // The roster is the source of parking-admin authority, so the first grant is
  // open and every later one needs an admin. The acting person is people[0].
  const rosterAliceProfile = Writable.of<ParkingProfile>({ name: "Alice" });
  const rosterBobProfile = Writable.of<ParkingProfile>({ name: "Bob" });
  const rosterAlice: Person = {
    profile: rosterAliceProfile,
    name: "Alice",
    email: "alice@co.com",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 1,
  };
  const rosterBob: Person = {
    profile: rosterBobProfile,
    name: "Bob",
    email: "bob@co.com",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 2,
  };

  // The roster is wired in so the test can read it. The chip on a re-added
  // row says "Member" whether or not a role was dropped — that row carries no
  // profile either way — so the drop is only observable here.
  const s10Registry = Writable.of<{ admins?: { displayName: string }[] }>({});
  const s10 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [rosterAlice, rosterBob],
    requests: [],
    adminRegistry: s10Registry as never,
    viewer: { name: "Alice", profile: rosterAliceProfile },
  });

  const action_s10_enable_manager = action(() => s10.enableAdminManager.send());
  const action_s10_bootstrap_alice = action(() =>
    s10.togglePersonAdmin.send({ profile: rosterAliceProfile })
  );
  const action_s10_rename_alice = action(() => {
    s10.editPerson.send({
      originalName: "Alice",
      name: "Alicia",
      email: "alice@co.com",
      commuteMode: "drive",
      priorityRank: 1,
      defaultSpot: "",
      preferences: "",
    });
  });
  const action_s10_grant_bob = action(() =>
    s10.togglePersonAdmin.send({ profile: rosterBobProfile })
  );
  const action_s10_remove_bob = action(() =>
    s10.removePerson.send({ name: "Bob" })
  );
  const action_s10_re_add_bob = action(() => {
    s10.addPerson.send({
      name: "Bob",
      email: "bob@co.com",
      commuteMode: "drive",
      priorityRank: 2,
      defaultSpot: "",
      preferences: "",
    });
  });

  const assert_s10_bootstrap_open = assert(() =>
    s10.currentUserCanManageAdmins === true
  );
  const assert_s10_alice_is_admin = assert(() =>
    s10.currentPersonIsAdmin === true && adminRowIsAdmin(s10[UI], "Alice")
  );
  // The role follows the rename, so the renamed person keeps their authority.
  const assert_s10_role_followed_rename = assert(() =>
    len(s10.people.filter((p: Person) => p.name === "Alicia")) === 1 &&
    s10.currentPersonIsAdmin === true && adminRowIsAdmin(s10[UI], "Alicia")
  );
  const assert_s10_bob_is_admin = assert(() => adminRowIsAdmin(s10[UI], "Bob"));
  const assert_s10_bob_removed = assert(() =>
    len(s10.people.filter((p: Person) => p.name === "Bob")) === 0
  );
  // Removing a person drops their role. Read the roster itself: a re-added row
  // carries no profile, so its chip says "Member" whether or not the role was
  // dropped, and asserting on the chip alone cannot see the difference.
  const assert_s10_role_dropped_with_person = assert(() => {
    const roles = s10Registry.get()?.admins ?? [];
    return len(roles) === 1 &&
      !roles.some((role) => role.displayName === "Bob");
  });
  const assert_s10_re_added_bob_is_member = assert(() =>
    len(s10.people.filter((p: Person) => p.name === "Bob")) === 1 &&
    !adminRowIsAdmin(s10[UI], "Bob")
  );

  // ============================================================
  // Subject 2: Only an admin may grant once the roster is filled
  // ============================================================

  const rosterCarolProfile = Writable.of<ParkingProfile>({ name: "Carol" });
  const rosterDaveProfile = Writable.of<ParkingProfile>({ name: "Dave" });
  const rosterCarol: Person = {
    profile: rosterCarolProfile,
    name: "Carol",
    email: "carol@co.com",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 1,
  };
  const rosterDave: Person = {
    profile: rosterDaveProfile,
    name: "Dave",
    email: "dave@co.com",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 2,
  };

  // Carol acts; the bootstrap grant goes to Dave, so Carol is left holding no
  // role while the roster is no longer empty.
  const s11 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [rosterCarol, rosterDave],
    requests: [],
    viewer: { name: "Carol", profile: rosterCarolProfile },
  });

  const action_s11_enable_manager = action(() => s11.enableAdminManager.send());
  const action_s11_bootstrap_dave = action(() =>
    s11.togglePersonAdmin.send({ profile: rosterDaveProfile })
  );
  const action_s11_carol_grants_self = action(() =>
    s11.togglePersonAdmin.send({ profile: rosterCarolProfile })
  );

  const assert_s11_dave_is_admin = assert(() =>
    adminRowIsAdmin(s11[UI], "Dave")
  );
  const assert_s11_carol_locked_out = assert(() =>
    s11.currentUserCanManageAdmins === false &&
    propValue(
        findNodeByProp(s11[UI], "data-parking-admin-toggle", "Carol"),
        "disabled",
      ) === true
  );
  const assert_s11_carol_still_member = assert(() =>
    !adminRowIsAdmin(s11[UI], "Carol")
  );

  // A role names the profile cell, not the name on the row, so renaming a
  // person moves nothing: the same identity holds the same role afterwards,
  // and no new name inherits it.
  const action_s11_rename_dave = action(() => {
    s11.editPerson.send({
      originalName: "Dave",
      name: "Mallory",
      email: "dave@co.com",
      commuteMode: "drive",
      priorityRank: 2,
      defaultSpot: "",
      preferences: "",
    });
  });
  const action_s11_carol_removes_admin = action(() =>
    s11.removePerson.send({ name: "Mallory" })
  );

  const assert_s11_role_survives_rename = assert(() =>
    len(s11.people.filter((p: Person) => p.name === "Dave")) === 0 &&
    len(s11.people.filter((p: Person) => p.name === "Mallory")) === 1 &&
    adminRowIsAdmin(s11[UI], "Mallory")
  );
  // Dropping an admin drops their role, so a viewer who may not change the
  // roster may not remove one either.
  const assert_s11_admin_still_there = assert(() =>
    len(s11.people.filter((p: Person) => p.name === "Mallory")) === 1 &&
    adminRowIsAdmin(s11[UI], "Mallory")
  );

  // ============================================================
  // Subject 3: A role is only ever granted to a person who exists
  // ============================================================

  const rosterErinProfile = Writable.of<ParkingProfile>({ name: "Erin" });
  // An identity nobody here answers to: a profile on no person row.
  const unclaimedProfile = Writable.of<ParkingProfile>({ name: "Nobody" });
  const rosterErin: Person = {
    profile: rosterErinProfile,
    name: "Erin",
    email: "erin@co.com",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 1,
  };

  const s12 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [rosterErin],
    requests: [],
    viewer: { name: "Erin", profile: rosterErinProfile },
  });

  const action_s12_enable_manager = action(() => s12.enableAdminManager.send());
  const action_s12_grant_phantom = action(() =>
    s12.togglePersonAdmin.send({ profile: unclaimedProfile })
  );
  const action_s12_grant_erin = action(() =>
    s12.togglePersonAdmin.send({ profile: rosterErinProfile })
  );

  // A role for a name nobody answers to would fill the roster with authority
  // no actor can hold, closing the bootstrap for good.
  const assert_s12_phantom_refused = assert(() =>
    !adminRowIsAdmin(s12[UI], "Erin") &&
    s12.currentUserCanManageAdmins === true
  );
  const assert_s12_erin_is_admin = assert(() =>
    adminRowIsAdmin(s12[UI], "Erin")
  );

  // ============================================================
  // Subject 4: Claiming a row is what makes a person identifiable
  // ============================================================

  const frankProfile = Writable.of<ParkingProfile>({ name: "Frank" });
  const unclaimedFrank: Person = {
    name: "Frank",
    email: "frank@co.com",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 1,
  };
  const unclaimedGina: Person = {
    name: "Gina",
    email: "gina@co.com",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 2,
  };

  const s13 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [unclaimedFrank, unclaimedGina],
    requests: [],
    viewer: { name: "Frank", profile: frankProfile },
  });

  const action_s13_enable_manager = action(() => s13.enableAdminManager.send());
  const action_s13_grant_before_claim = action(() =>
    s13.togglePersonAdmin.send({ profile: frankProfile })
  );
  const action_s13_claim_frank = action(() =>
    s13.claimPerson.send({ name: "Frank" })
  );
  const action_s13_grant_after_claim = action(() =>
    s13.togglePersonAdmin.send({ profile: frankProfile })
  );
  const action_s13_claim_gina_too = action(() =>
    s13.claimPerson.send({ name: "Gina" })
  );

  // Nobody has claimed a row, so no row can be granted a role and the toggle
  // says so.
  const assert_s13_unclaimed_has_no_profile = assert(() =>
    !hasProfile(s13.people, "Frank")
  );
  const assert_s13_unclaimed_is_not_admin = assert(() =>
    !adminRowIsAdmin(s13[UI], "Frank")
  );
  const assert_s13_unclaimed_toggle_disabled = assert(() =>
    propValue(
      findNodeByProp(s13[UI], "data-parking-admin-toggle", "Frank"),
      "disabled",
    ) === true
  );
  const assert_s13_frank_claimed = assert(() =>
    hasProfile(s13.people, "Frank") &&
    findNodeByProp(s13[UI], "data-parking-admin-claim", "Frank") === undefined
  );
  const assert_s13_claimed_can_be_granted = assert(() =>
    adminRowIsAdmin(s13[UI], "Frank")
  );
  // One viewer, one row: a second claim leaves the other row alone.
  const assert_s13_gina_unclaimed = assert(() =>
    !hasProfile(s13.people, "Gina")
  );

  // ============================================================
  // Subject 5: With no identity resolved there is nothing to offer
  // ============================================================

  // No viewer at all, which is what a fresh browser session looks like before
  // a profile resolves. The card offers the profile-setup surface instead, and
  // neither the claim nor the grant is on offer, because both would be
  // refused.
  const s14 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [unclaimedFrank],
    requests: [],
  });

  const action_s14_enable_manager = action(() => s14.enableAdminManager.send());

  const assert_s14_claim_offered_but_disabled = assert(() =>
    propValue(
      findNodeByProp(s14[UI], "data-parking-admin-claim", "Frank"),
      "disabled",
    ) === true
  );
  const assert_s14_cannot_manage = assert(() =>
    s14.currentUserCanManageAdmins === false &&
    propValue(
        findNodeByProp(s14[UI], "data-parking-admin-toggle", "Frank"),
        "disabled",
      ) === true
  );

  // ============================================================
  // Subject 6: A name without a profile is not an identity
  // ============================================================

  // The two halves of an identity resolve independently, so a viewer can hold
  // a name while the profile behind it has not arrived. The surface cannot
  // tell — an empty cell handle reads as present at render time — so it still
  // offers the claim, and the handler refuses it, which is where the question
  // can actually be asked.
  const s15 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [unclaimedFrank],
    requests: [],
    viewer: { name: "Frank" },
  });

  const action_s15_enable_manager = action(() => s15.enableAdminManager.send());
  const action_s15_claim_frank = action(() =>
    s15.claimPerson.send({ name: "Frank" })
  );

  const assert_s15_claim_offered = assert(() =>
    propValue(
      findNodeByProp(s15[UI], "data-parking-admin-claim", "Frank"),
      "disabled",
    ) === false
  );
  // The refusal is the load-bearing half: a row never gets bound to an
  // identity that carries nothing.
  const assert_s15_claim_refused = assert(() =>
    !hasProfile(s15.people, "Frank")
  );

  // ============================================================
  // Subject 7: The bootstrap grant needs a real actor too
  // ============================================================

  // An empty roster says yes to whoever asks — that is what lets a first admin
  // exist. It still has to be someone: a viewer holding a name whose profile
  // resolved to nothing must not be able to hand out the first role, even
  // though the row it points at is real and claimed.
  const s16Profile = Writable.of<ParkingProfile>({ name: "Hana" });
  const claimedHana: Person = {
    profile: s16Profile,
    name: "Hana",
    email: "hana@co.com",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 1,
  };

  const s16 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [claimedHana],
    requests: [],
    viewer: { name: "Nameless" },
  });

  const action_s16_enable_manager = action(() => s16.enableAdminManager.send());
  const action_s16_grant_hana = action(() =>
    s16.togglePersonAdmin.send({ profile: s16Profile })
  );

  const assert_s16_bootstrap_refused = assert(() =>
    !adminRowIsAdmin(s16[UI], "Hana")
  );

  // ============================================================
  // Subject 8: A claimed row is not up for grabs
  // ============================================================

  // Overwriting a claimed row would point it at a second identity and strand
  // the first: the role bound to the identity that held the row stays in the
  // roster while no row carries it, which is authority nobody can exercise
  // and nobody can drop. Ann holds the row and the role; Ben tries to take it.
  const annProfile = Writable.of<ParkingProfile>({ name: "Ann" });
  const benProfile = Writable.of<ParkingProfile>({ name: "Ben" });
  const claimedAnn: Person = {
    profile: annProfile,
    name: "Ann",
    email: "ann@co.com",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 1,
  };
  const unclaimedBen: Person = {
    name: "Ben",
    email: "ben@co.com",
    commuteMode: "drive",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 2,
  };

  const s17 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [claimedAnn, unclaimedBen],
    requests: [],
    viewer: { name: "Ben", profile: benProfile },
  });

  const action_s17_ben_claims_anns_row = action(() =>
    s17.claimPerson.send({ name: "Ann" })
  );
  const action_s17_ben_claims_his_own = action(() =>
    s17.claimPerson.send({ name: "Ben" })
  );

  // Whether Ben took Ann's row is not visible on Ann's row — it carries a
  // profile either way — so it is read from what it would cost him: a viewer
  // holds at most one row, so had the first claim landed, this one would be
  // refused and Ben's own row would stay unclaimed.
  const assert_s17_ben_can_still_claim_his_own = assert(() =>
    hasProfile(s17.people, "Ben")
  );

  return {
    [TESTS]: [
      // Admin roster authority
      { action: action_s10_enable_manager },
      { assertion: assert_s10_bootstrap_open },
      { action: action_s10_bootstrap_alice },
      { assertion: assert_s10_alice_is_admin },
      { action: action_s10_rename_alice },
      { assertion: assert_s10_role_followed_rename },
      { action: action_s10_grant_bob },
      { assertion: assert_s10_bob_is_admin },
      { action: action_s10_remove_bob },
      { assertion: assert_s10_bob_removed },
      { assertion: assert_s10_role_dropped_with_person },
      { action: action_s10_re_add_bob },
      { assertion: assert_s10_re_added_bob_is_member },

      // Only an admin may grant once the roster is filled
      { action: action_s11_enable_manager },
      { action: action_s11_bootstrap_dave },
      { assertion: assert_s11_dave_is_admin },
      { assertion: assert_s11_carol_locked_out },
      { action: action_s11_carol_grants_self },
      { assertion: assert_s11_carol_still_member },
      { action: action_s11_rename_dave },
      { assertion: assert_s11_role_survives_rename },
      { action: action_s11_carol_removes_admin },
      { assertion: assert_s11_admin_still_there },

      // A role is only ever granted to a person who exists
      { action: action_s12_enable_manager },
      { action: action_s12_grant_phantom },
      { assertion: assert_s12_phantom_refused },
      { action: action_s12_grant_erin },
      { assertion: assert_s12_erin_is_admin },

      // Claiming a row is what makes a person identifiable
      { action: action_s13_enable_manager },
      { action: action_s13_grant_before_claim },
      { assertion: assert_s13_unclaimed_has_no_profile },
      { assertion: assert_s13_unclaimed_is_not_admin },
      { assertion: assert_s13_unclaimed_toggle_disabled },
      { action: action_s13_claim_frank },
      { assertion: assert_s13_frank_claimed },
      { action: action_s13_grant_after_claim },
      { assertion: assert_s13_claimed_can_be_granted },
      { action: action_s13_claim_gina_too },
      { assertion: assert_s13_gina_unclaimed },

      // With no identity resolved there is nothing to offer
      { action: action_s14_enable_manager },
      { assertion: assert_s14_claim_offered_but_disabled },
      { assertion: assert_s14_cannot_manage },

      // A name without a profile is not an identity
      { action: action_s15_enable_manager },
      { assertion: assert_s15_claim_offered },
      { action: action_s15_claim_frank },
      { assertion: assert_s15_claim_refused },

      // The bootstrap grant needs a real actor too
      { action: action_s16_enable_manager },
      { action: action_s16_grant_hana },
      { assertion: assert_s16_bootstrap_refused },

      // A claimed row is not up for grabs
      { action: action_s17_ben_claims_anns_row },
      { action: action_s17_ben_claims_his_own },
      { assertion: assert_s17_ben_can_still_claim_his_own },
    ],
    s10,
    s11,
    s12,
    s13,
    s14,
    s15,
    s16,
    s17,
    // TODO(cfc-schema-ref): the CFC schema-ref resolver warns about
    // unsupported/unresolved $ref(s) in this pattern's schemas (logger "cfc",
    // fail-closed). Fix the schema(s), then drop this opt-out.
    allowConsoleWarnings: true,
  };
});
