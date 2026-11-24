/**
 * Shows the viewer's profile name and status, along with the profile's own
 * rendered view. It finds them with `wish` using the `#profile` and
 * `#profileName` tags, and shows "No profile" when the viewer has none.
 */

import {
  computed,
  hasError,
  NAME,
  pattern,
  resultOf,
  UI,
  wish,
} from "commonfabric";

type Profile = { initialNameApplied?: string };

/** The name shown for the viewer: the name their profile was created with,
 * then their profile name, then a placeholder when they have no profile. */
export const displayNameFor = (
  profile: Profile | undefined,
  profileName: string | undefined,
): string => profile?.initialNameApplied ?? profileName ?? "No profile";

/** The status line for the viewer's profile name. */
export const statusFor = (profileName: string | undefined): string =>
  profileName ? `Profile: ${profileName}` : "No profile";

export default pattern(
  () => {
    const profileWish = wish<Profile>({ query: "#profile" });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profile = hasError(profileWish.result)
      ? undefined
      : resultOf(profileWish.result);
    const profileName = hasError(profileNameWish.result)
      ? undefined
      : resultOf(profileNameWish.result);
    const failure = computed(() => {
      if (
        hasError(profileWish.result) && profileWish.errorCode !== "no-match"
      ) {
        return profileWish.result.message;
      }
      if (
        hasError(profileNameWish.result) &&
        profileNameWish.errorCode !== "no-match"
      ) return profileNameWish.result.message;
      return "";
    });
    const displayName = computed(() => displayNameFor(profile, profileName));
    const status = computed(() => failure || statusFor(profileName));
    return {
      [NAME]: "Shared Profile Demo",
      [UI]: (
        <cf-screen>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <h2 style={{ margin: 0, fontSize: "16px" }}>
              Shared Profile Demo
            </h2>
            <div id="shared-profile-name">{displayName}</div>
            <div id="shared-profile-status" role={failure ? "alert" : "status"}>
              {status}
            </div>
            <div id="shared-profile-wish-ui">{profileWish[UI]}</div>
          </cf-vstack>
        </cf-screen>
      ),
    };
  },
  false as const,
  {
    type: "object",
    properties: {
      [NAME]: { type: "string" },
      [UI]: true,
    },
    required: [NAME, UI],
  },
);
