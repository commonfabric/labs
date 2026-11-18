import { computed, NAME, pattern, UI, wish } from "commonfabric";

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
    const displayName = computed(() =>
      displayNameFor(profileWish.result, profileNameWish.result)
    );
    const status = computed(() => statusFor(profileNameWish.result));
    return {
      [NAME]: "Shared Profile Demo",
      [UI]: (
        <cf-screen>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <h2 style={{ margin: 0, fontSize: "16px" }}>
              Shared Profile Demo
            </h2>
            <div id="shared-profile-name">{displayName}</div>
            <div id="shared-profile-status">{status}</div>
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
