/**
 * Retiring and restoring a profile whose space is deleted, through Home's
 * streams: a deleted profile is retired even where a live one would be
 * refused, as the profile `#profile` returns is, and it is not restored.
 *
 * Run: deno task cf test patterns/system/profile-create/profile-create.deleted-profile.test.tsx --verbose
 */
import {
  action,
  assert,
  type Cell,
  linksOf,
  pattern,
  spaceOf,
  TESTS,
} from "commonfabric";
import Home from "../home/home.tsx";
import {
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
  // Typed as a plain profile link, so that the step holding it names none of
  // the list's write policy.
  const ada: Cell<unknown> = home.profiles.key(0);

  const action_retire_ada = action(() =>
    home.retireProfile.send({ profile: home.profiles.get()[0] })
  );
  const action_restore_ada = action(() =>
    home.restoreProfile.send({ profile: home.profiles.get()[0] })
  );

  return {
    [TESTS]: [
      { action: home.createProfile, event: { name: "Ada" }, trustedUi: CREATE },
      {
        action: home.createProfile,
        event: { name: "Alan" },
        trustedUi: CREATE,
      },
      { assertion: assert(() => home.profiles.get().length === 2) },
      // Ada, listed first with no default or recent use, is the profile
      // `#profile` returns, so while her space is live she is not retired.
      { action: action_retire_ada },
      { assertion: assert(() => spacesOf(home.retiredProfiles) === "") },
      // Once her space is deleted she is retired all the same.
      { deleteSpace: ada },
      { action: action_retire_ada },
      {
        assertion: assert(() =>
          spacesOf(home.retiredProfiles) === spaceOf(home.profiles.get()[0])
        ),
      },
      // A deleted profile is not restored.
      { action: action_restore_ada },
      {
        assertion: assert(() =>
          spacesOf(home.retiredProfiles) === spaceOf(home.profiles.get()[0])
        ),
      },
    ],
    home,
    // Ada as the profile `#profile` returns, and the restore of her deleted
    // profile.
    expectRuntimeErrors: 2,
    // Deleting Ada's space ends the sessions open on it, which logs errors.
    allowConsoleErrors: true,
  };
});
