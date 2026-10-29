import { assert, computed, pattern, TESTS, UI, Writable } from "commonfabric";
import Lobby, {
  addSelfToLobby,
  commitTrustedLobbyAction,
  currentLobbyUserIsAdmin,
  DEFAULT_LOBBY_ROSTER,
  type LobbyAdminRegistryValue,
  lobbyAdminRolesValue,
  lobbyEveryoneIsAdmin,
  lobbyParticipantsValue,
  type LobbyProfile,
  type LobbyRosterCell,
  type LobbyRosterValue,
  LobbyViewerState,
  TRUSTED_LOBBY_ACTION,
  TRUSTED_LOBBY_SURFACE,
} from "./main.tsx";

const trustedLobbyGesture = {
  surface: TRUSTED_LOBBY_SURFACE,
  action: TRUSTED_LOBBY_ACTION,
};

type LobbyInputArg = Parameters<typeof Lobby>[0];

const participantNames = (roster: LobbyRosterCell): string[] =>
  lobbyParticipantsValue(roster).map((participant) => participant.name);

export default pattern(() => {
  const roster = Writable.of<LobbyRosterValue>(DEFAULT_LOBBY_ROSTER);
  const adminRegistry = Writable.of<LobbyAdminRegistryValue>(
    {} as LobbyAdminRegistryValue,
  );
  const aliceProfile = Writable.of<LobbyProfile>({ name: "Alice" });
  const bobProfile = Writable.of<LobbyProfile>({ name: "Bob" });
  const firstAlexProfile = Writable.of<LobbyProfile>({ name: "Alex" });
  const secondAlexProfile = Writable.of<LobbyProfile>({ name: "Alex" });
  const blankProfile = Writable.of<LobbyProfile>({ name: "   " });

  const viewerRoster = Writable.of<LobbyRosterValue>(DEFAULT_LOBBY_ROSTER);
  const viewerAdminRegistry = Writable.of<LobbyAdminRegistryValue>(
    {} as LobbyAdminRegistryValue,
  );
  // Lobby transports the original assertion cell without interpreting it;
  // profile publication and downstream consumers enforce its integrity.
  const selectedVerifiedIdentity = Writable.of({
    type: "github.login",
    value: "octocat",
    verifiedAt: "2026-07-15T22:03:28.000Z",
  });
  const selectedProfile = computed((): LobbyProfile => ({
    initialNameApplied: "Selected Profile",
    externalLinks: [{ label: "GitHub", url: "https://github.com/octocat" }],
    verifiedIdentities: [selectedVerifiedIdentity],
  }));
  const selectedViewer = LobbyViewerState({
    viewerProfile: selectedProfile,
    roster: viewerRoster,
    adminRegistry: viewerAdminRegistry,
  });
  const missingProfileViewer = LobbyViewerState({
    roster: viewerRoster,
    adminRegistry: viewerAdminRegistry,
  });
  const selectedAddSelf = addSelfToLobby({
    roster: viewerRoster,
    viewerProfile: selectedProfile,
    viewerName: selectedViewer.myName,
  });
  const selectedSetEveryone = commitTrustedLobbyAction({
    kind: "set-everyone-admin",
    roster: viewerRoster,
    adminRegistry: viewerAdminRegistry,
    viewerProfile: selectedProfile,
    viewerName: selectedViewer.myName,
  });

  const aliceAddSelf = addSelfToLobby({
    roster,
    viewerProfile: aliceProfile,
    viewerName: "Alice",
  });
  const bobJoin = commitTrustedLobbyAction({
    kind: "join",
    roster,
    adminRegistry,
    viewerProfile: bobProfile,
    viewerName: "Bob",
  });
  const blankJoin = commitTrustedLobbyAction({
    kind: "join",
    roster,
    adminRegistry,
    viewerProfile: blankProfile,
    viewerName: "",
  });
  const firstAlexJoin = commitTrustedLobbyAction({
    kind: "join",
    roster,
    adminRegistry,
    viewerProfile: firstAlexProfile,
    viewerName: "Alex",
  });
  const secondAlexJoin = commitTrustedLobbyAction({
    kind: "join",
    roster,
    adminRegistry,
    viewerProfile: secondAlexProfile,
    viewerName: "Alex",
  });

  const aliceSetEveryone = commitTrustedLobbyAction({
    kind: "set-everyone-admin",
    roster,
    adminRegistry,
    viewerProfile: aliceProfile,
    viewerName: "Alice",
  });
  const bobSetEveryone = commitTrustedLobbyAction({
    kind: "set-everyone-admin",
    roster,
    adminRegistry,
    viewerProfile: bobProfile,
    viewerName: "Bob",
  });
  const bobRemoveAlice = commitTrustedLobbyAction({
    kind: "remove",
    roster,
    adminRegistry,
    viewerProfile: bobProfile,
    viewerName: "Bob",
    targetProfile: aliceProfile,
  });
  const aliceToggleBobAdmin = commitTrustedLobbyAction({
    kind: "toggle-admin",
    roster,
    adminRegistry,
    viewerProfile: aliceProfile,
    viewerName: "Alice",
    targetProfile: bobProfile,
  });
  const bobToggleSelfAdmin = commitTrustedLobbyAction({
    kind: "toggle-admin",
    roster,
    adminRegistry,
    viewerProfile: bobProfile,
    viewerName: "Bob",
    targetProfile: bobProfile,
  });

  const lobby = Lobby({ roster, adminRegistry } as LobbyInputArg);

  const assert_selected_profile_drives_viewer_state = assert(() =>
    selectedViewer.myName === "Selected Profile" &&
    selectedViewer.hasProfile === true &&
    selectedViewer.hasJoined === false &&
    selectedViewer.joinLabel === "Join as Selected Profile" &&
    selectedViewer.joinDisabled === false &&
    selectedViewer.everyoneIsAdmin === true &&
    selectedViewer.currentUserIsAdmin === false &&
    selectedViewer.adminSummary ===
      "Open fallback: every joined person is an admin." &&
    selectedViewer.adminBadgeColor === "accent" &&
    selectedViewer.adminBadgeLabel === "Open" &&
    missingProfileViewer.myName === "" &&
    missingProfileViewer.hasProfile === false &&
    missingProfileViewer.hasJoined === false &&
    missingProfileViewer.joinLabel === "Choose a profile" &&
    missingProfileViewer.joinDisabled === true &&
    missingProfileViewer.currentUserIsAdmin === false
  );
  const assert_selected_profile_joined = assert(() =>
    participantNames(viewerRoster).join(",") === "Selected Profile" &&
    lobbyParticipantsValue(viewerRoster)[0]?.profile.get()
        ?.externalLinks?.[0]?.url === "https://github.com/octocat" &&
    lobbyParticipantsValue(viewerRoster)[0]?.profile.get()
        ?.verifiedIdentities?.length === 1 &&
    selectedViewer.hasJoined === true &&
    selectedViewer.joinLabel === "You’re here" &&
    selectedViewer.joinDisabled === true &&
    selectedViewer.currentUserIsAdmin === true
  );
  const assert_selected_admin_lockdown = assert(() =>
    selectedViewer.everyoneIsAdmin === false &&
    selectedViewer.currentUserIsAdmin === true &&
    selectedViewer.adminSummary ===
      "Only explicitly named admins can manage this lobby." &&
    selectedViewer.adminBadgeColor === "neutral" &&
    selectedViewer.adminBadgeLabel === "Explicit admins"
  );

  const assert_initial_open_fallback = assert(() =>
    lobbyParticipantsValue(roster).length === 0 &&
    lobbyAdminRolesValue(adminRegistry).length === 0 &&
    lobbyEveryoneIsAdmin(adminRegistry) === true
  );
  const assert_alice_joined_once = assert(() =>
    participantNames(roster).join(",") === "Alice" &&
    currentLobbyUserIsAdmin(aliceProfile, roster, adminRegistry)
  );
  const assert_blank_profile_rejected = assert(() =>
    participantNames(roster).join(",") === "Alice"
  );
  const assert_both_are_admin_by_fallback = assert(() =>
    participantNames(roster).join(",") === "Alice,Bob" &&
    currentLobbyUserIsAdmin(aliceProfile, roster, adminRegistry) &&
    currentLobbyUserIsAdmin(bobProfile, roster, adminRegistry)
  );
  const assert_bob_removed_alice_while_open = assert(() =>
    participantNames(roster).join(",") === "Bob"
  );
  const assert_lockdown_bootstraps_alice = assert(() => {
    const roles = lobbyAdminRolesValue(adminRegistry);
    return lobbyEveryoneIsAdmin(adminRegistry) === false &&
      roles.length === 1 &&
      currentLobbyUserIsAdmin(aliceProfile, roster, adminRegistry) &&
      !currentLobbyUserIsAdmin(bobProfile, roster, adminRegistry);
  });
  const assert_non_admin_remove_is_blocked = assert(() =>
    participantNames(roster).join(",") === "Bob,Alice"
  );
  const assert_bob_promoted = assert(() =>
    lobbyAdminRolesValue(adminRegistry).length === 2 &&
    currentLobbyUserIsAdmin(bobProfile, roster, adminRegistry)
  );
  const assert_public_output_explicit_policy = assert(() =>
    lobby.everyoneIsAdmin === false &&
    lobby.allParticipants[0]?.isAdmin === true &&
    lobby.allParticipants[1]?.isAdmin === true
  );
  const assert_bob_removed_alice_and_role = assert(() =>
    participantNames(roster).join(",") === "Bob" &&
    lobbyAdminRolesValue(adminRegistry).length === 1 &&
    currentLobbyUserIsAdmin(bobProfile, roster, adminRegistry)
  );
  const assert_last_admin_removal_blocked = assert(() =>
    lobbyAdminRolesValue(adminRegistry).length === 1 &&
    currentLobbyUserIsAdmin(bobProfile, roster, adminRegistry)
  );
  const assert_open_policy_restored = assert(() =>
    lobbyEveryoneIsAdmin(adminRegistry) === true &&
    currentLobbyUserIsAdmin(bobProfile, roster, adminRegistry)
  );
  const assert_same_name_profiles_both_join = assert(() =>
    participantNames(roster).filter((name) => name === "Alex").length === 2
  );
  const assert_public_output_count = assert(() =>
    lobby.participantCount === 3 &&
    lobby.allParticipants.length === 3 &&
    lobby.participants.length === 3
  );
  const assert_public_output_policy = assert(() =>
    lobby.everyoneIsAdmin === true
  );
  const assert_public_output_is_profile_free = assert(() =>
    lobby.allParticipants[0]?.name === "Bob" &&
    lobby.allParticipants[1]?.name === "Alex" &&
    lobby.allParticipants[2]?.name === "Alex" &&
    lobby.participants[0]?.name === lobby.allParticipants[0]?.name
  );

  return {
    [TESTS]: [
      { assertion: assert_selected_profile_drives_viewer_state },
      { action: selectedAddSelf },
      { assertion: assert_selected_profile_joined },
      {
        action: selectedSetEveryone,
        event: { everyoneIsAdmin: false },
        trustedUi: trustedLobbyGesture,
      },
      { assertion: assert_selected_admin_lockdown },
      { assertion: assert_initial_open_fallback },
      { action: aliceAddSelf },
      { action: aliceAddSelf },
      { assertion: assert_alice_joined_once },
      { action: blankJoin, trustedUi: trustedLobbyGesture },
      { assertion: assert_blank_profile_rejected },
      { action: bobJoin, trustedUi: trustedLobbyGesture },
      { assertion: assert_both_are_admin_by_fallback },
      { action: bobRemoveAlice, trustedUi: trustedLobbyGesture },
      { assertion: assert_bob_removed_alice_while_open },
      { action: aliceAddSelf },
      {
        action: aliceSetEveryone,
        event: { everyoneIsAdmin: false },
        trustedUi: trustedLobbyGesture,
      },
      { assertion: assert_lockdown_bootstraps_alice },
      { action: bobRemoveAlice, trustedUi: trustedLobbyGesture },
      { assertion: assert_non_admin_remove_is_blocked },
      { action: aliceToggleBobAdmin, trustedUi: trustedLobbyGesture },
      { assertion: assert_bob_promoted },
      { assertion: assert_public_output_explicit_policy },
      // Materialize rows while explicit-role checks are active.
      { render: lobby[UI] },
      { action: bobRemoveAlice, trustedUi: trustedLobbyGesture },
      { assertion: assert_bob_removed_alice_and_role },
      { action: bobToggleSelfAdmin, trustedUi: trustedLobbyGesture },
      { assertion: assert_last_admin_removal_blocked },
      {
        action: bobSetEveryone,
        event: { everyoneIsAdmin: true },
        trustedUi: trustedLobbyGesture,
      },
      { assertion: assert_open_policy_restored },
      { action: firstAlexJoin, trustedUi: trustedLobbyGesture },
      { action: secondAlexJoin, trustedUi: trustedLobbyGesture },
      { assertion: assert_same_name_profiles_both_join },
      { assertion: assert_public_output_count },
      { assertion: assert_public_output_policy },
      { assertion: assert_public_output_is_profile_free },
      // With no profile wish resolved, this materializes the non-admin branch.
      { render: lobby[UI] },
    ],
    roster,
    adminRegistry,
  };
});
