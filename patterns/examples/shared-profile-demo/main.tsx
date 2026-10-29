import { computed, NAME, pattern, UI, wish } from "commonfabric";

export default pattern(
  () => {
    const profileWish = wish<{ initialNameApplied?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const displayName = computed(() =>
      profileWish.result?.initialNameApplied ??
        profileNameWish.result ?? "No profile"
    );
    const status = computed(() =>
      profileNameWish.result
        ? `Profile: ${profileNameWish.result}`
        : "No profile"
    );
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
