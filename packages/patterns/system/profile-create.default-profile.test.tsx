/**
 * Test Pattern: setDefaultProfile re-points home's default.
 *
 * Home keeps its default profile as a link under `profile` in a slot of its
 * own (`DefaultProfileSlot`). Choosing a second profile must re-point that link
 * and leave the first profile as it was. A link stored at the slot's root
 * instead makes the handler's handle denote the profile chosen first, so the
 * second choice writes a link to the new profile into the old one; across
 * spaces, as home's profiles are, that write is refused.
 *
 * Run: deno task cf test packages/patterns/system/profile-create.default-profile.test.tsx --verbose
 */
import { assert, pattern, TESTS, Writable } from "commonfabric";
import {
  type DefaultProfileSlot,
  setDefaultProfile,
} from "./profile-create.tsx";
import ProfileHome from "./profile-home.tsx";

export default pattern(() => {
  const ada = ProfileHome({ initialName: "Ada Lovelace" });
  const alan = ProfileHome({ initialName: "Alan Turing" });
  const defaultProfile = new Writable<DefaultProfileSlot>({});

  // deno-lint-ignore no-explicit-any
  const chooseAda = setDefaultProfile({ defaultProfile, profile: ada as any });
  const chooseAlan = setDefaultProfile({
    defaultProfile,
    // deno-lint-ignore no-explicit-any
    profile: alan as any,
  });

  const assert_no_default_yet = assert(() =>
    defaultProfile.get()?.profile === undefined
  );
  const assert_default_is_ada = assert(() =>
    defaultProfile.get()?.profile?.initialNameApplied === "Ada Lovelace"
  );
  const assert_default_is_alan = assert(() =>
    defaultProfile.get()?.profile?.initialNameApplied === "Alan Turing"
  );
  const assert_ada_keeps_her_profile = assert(() =>
    ada.initialNameApplied === "Ada Lovelace"
  );
  const assert_alan_keeps_his_profile = assert(() =>
    alan.initialNameApplied === "Alan Turing"
  );

  return {
    [TESTS]: [
      { assertion: assert_no_default_yet },
      { action: chooseAda },
      { assertion: assert_default_is_ada },
      { action: chooseAlan },
      { assertion: assert_default_is_alan },
      { assertion: assert_ada_keeps_her_profile },
      { action: chooseAda },
      { assertion: assert_default_is_ada },
      { assertion: assert_alan_keeps_his_profile },
    ],
  };
});
