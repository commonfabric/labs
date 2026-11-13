/**
 * Retiring and restoring a profile through Home's streams, the two bindings
 * of `setProfileRetired`, over profiles Home's create made in spaces of their
 * own: the one `#profile` returns and the user's only live profile are never
 * retired, a profile already retired is left as it is, and a restore takes it
 * out of the retired list again. A binding over lists that are not one Home's
 * own retires nothing.
 *
 * Run: deno task cf test patterns/system/profile-create/profile-create.retire.test.tsx --verbose
 */
import {
  action,
  assert,
  type Cell,
  linksOf,
  pattern,
  spaceOf,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import Home from "../home/home.tsx";
import ProfileHome, {
  type BackwardsCompatibleProfile,
} from "../profile-home/profile-home.tsx";
import {
  setProfileRetired,
  TRUSTED_PROFILE_CREATE_ACTION,
  TRUSTED_PROFILE_CREATE_SURFACE,
} from "./profile-create.tsx";

const CREATE = {
  surface: TRUSTED_PROFILE_CREATE_SURFACE,
  action: TRUSTED_PROFILE_CREATE_ACTION,
};

/** The spaces of the profiles `list` links. */
const spacesOf = (list: Cell<unknown[]>): string =>
  (linksOf(list) ?? []).map((entry) => spaceOf(entry)).join();

export default pattern(() => {
  const home = Home({});
  // A profile in Home's own space, which no list of Home's names.
  const stranger = ProfileHome({ initialName: "Stranger" });
  // Lists of no Home's.
  const loose = setProfileRetired({
    profiles: Writable.of<BackwardsCompatibleProfile[]>([]),
    mru: Writable.of<BackwardsCompatibleProfile[]>([]),
    retiredProfiles: Writable.of<unknown[]>([]),
    retired: true,
  });

  const action_retire_ada = action(() =>
    home.retireProfile.send({ profile: home.profiles.get()[0] })
  );
  const action_retire_alan = action(() =>
    home.retireProfile.send({ profile: home.profiles.get()[1] })
  );
  const action_restore_alan = action(() =>
    home.restoreProfile.send({ profile: home.profiles.get()[1] })
  );
  const action_retire_nothing = action(() => home.retireProfile.send({}));
  const action_retire_stranger = action(() =>
    home.retireProfile.send({ profile: stranger })
  );
  const action_retire_loosely = action(() =>
    loose.send({ profile: home.profiles.get()[1] })
  );

  return {
    [TESTS]: [
      { action: home.createProfile, event: { name: "Ada" }, trustedUi: CREATE },
      {
        action: home.createProfile,
        event: { name: "Alan" },
        trustedUi: CREATE,
      },
      {
        assertion: assert(() =>
          home.profiles.get().length === 2 &&
          spaceOf(home.profiles.get()[0]) !== spaceOf(home.profiles.get()[1])
        ),
      },
      // Ada, listed first with no default or recent use, is the profile
      // `#profile` returns, so she is not retired.
      { action: action_retire_ada },
      { assertion: assert(() => spacesOf(home.retiredProfiles) === "") },
      { action: action_retire_alan },
      {
        assertion: assert(() =>
          spacesOf(home.retiredProfiles) === spaceOf(home.profiles.get()[1])
        ),
      },
      // Retiring him again leaves the list as it is, and Ada, now the only
      // live profile, is still not retired.
      { action: action_retire_alan },
      { action: action_retire_ada },
      {
        assertion: assert(() =>
          spacesOf(home.retiredProfiles) === spaceOf(home.profiles.get()[1])
        ),
      },
      { action: action_restore_alan },
      { assertion: assert(() => spacesOf(home.retiredProfiles) === "") },
      // Restoring a profile that is not retired changes nothing.
      { action: action_restore_alan },
      { assertion: assert(() => spacesOf(home.retiredProfiles) === "") },
      // Neither a send naming no profile, nor one naming a profile that is
      // not one of the user's, nor one through lists of no Home's retires
      // anything.
      { action: action_retire_nothing },
      { action: action_retire_stranger },
      { action: action_retire_loosely },
      { assertion: assert(() => spacesOf(home.retiredProfiles) === "") },

      // Home's picker offers Remove on every row but the one `#profile`
      // returns, asks before it retires, and lists the profile it retired
      // with a Restore.
      { press: home[UI], control: "Remove…" },
      {
        assertion: assert(() => hasText(home[UI], "Remove this profile?")),
      },
      { press: home[UI], control: "Remove profile" },
      {
        assertion: assert(() =>
          spacesOf(home.retiredProfiles) === spaceOf(home.profiles.get()[1])
        ),
      },
      { assertion: assert(() => hasText(home[UI], "Removed profiles")) },
      { press: home[UI], control: "Restore" },
      { assertion: assert(() => spacesOf(home.retiredProfiles) === "") },
    ],
    home,
    // Ada as the profile `#profile` returns, then as the only live one; the
    // send naming nothing; the stranger; and the loose binding.
    expectRuntimeErrors: 5,
  };
});
