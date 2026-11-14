import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findNodeById,
  hasExactText,
} from "../../tools/test-support/vnode-helpers.ts";
import SharedProfileDemo, { displayNameFor, statusFor } from "./main.tsx";

export default pattern(() => {
  // A pattern test cannot resolve the viewer's `#profile` or `#profileName`
  // wish, so the demo renders as it does for a viewer with no profile, and
  // the naming rules are checked against stand-in profile values.
  const demo = SharedProfileDemo({});

  const assert_names_itself = assert(() =>
    demo[NAME] === "Shared Profile Demo"
  );
  const assert_viewer_without_profile_sees_placeholder = assert(() =>
    hasExactText(findNodeById(demo[UI], "shared-profile-name"), "No profile") &&
    hasExactText(findNodeById(demo[UI], "shared-profile-status"), "No profile")
  );

  // The name a profile was created with wins over the profile name, which
  // stands in when the profile records none.
  const assert_display_name_prefers_created_name = assert(() =>
    displayNameFor({ initialNameApplied: "Ada Lovelace" }, "Ada") ===
      "Ada Lovelace" &&
    displayNameFor({}, "Grace Hopper") === "Grace Hopper" &&
    displayNameFor(undefined, "Grace Hopper") === "Grace Hopper" &&
    displayNameFor(undefined, undefined) === "No profile"
  );
  const assert_status_names_the_profile = assert(() =>
    statusFor("Grace Hopper") === "Profile: Grace Hopper" &&
    statusFor("") === "No profile" &&
    statusFor(undefined) === "No profile"
  );

  return {
    [TESTS]: [
      { assertion: assert_names_itself },
      { assertion: assert_viewer_without_profile_sees_placeholder },
      { assertion: assert_display_name_prefers_created_name },
      { assertion: assert_status_names_the_profile },
    ],
    demo,
  };
});
