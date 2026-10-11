import {
  type AddIntegrity,
  type Cell,
  computed,
  Default,
  equals,
  handler,
  NAME,
  pattern,
  type PerSpace,
  RequiresIntegrity,
  Stream,
  type TrustedActionWrite,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import {
  activeAdminRoleForSubject,
  adminRegistryEntries,
  adminRegistryEveryoneIsAdmin,
  type SeededAdminRegistryValue,
} from "../cfc/admin/mod.ts";
/**
 * A small shared lobby: people join with their Fabric profile, everyone can
 * see who is present, and trusted admins can remove people or change the admin
 * policy.
 *
 * The empty admin registry intentionally means "everyone is admin". Turning
 * that fallback off seeds the acting participant as the first explicit admin,
 * so the lobby cannot be locked accidentally with no administrator.
 */

export const TRUSTED_LOBBY_SURFACE = "TrustedLobbySurface";
export const TRUSTED_LOBBY_ACTION = "TrustedLobbyAction";
export const LOBBY_ADMIN_INTEGRITY = "lobby-admin" as const;

type LobbyExternalProfileLink = {
  readonly label: string;
  readonly url: string;
};

export interface LobbyProfile {
  readonly initialNameApplied?: string;
  readonly name?: string;
  readonly avatar?: string;
  readonly bio?: string;
  /** Connector-facing identity hints retained on the stored profile link. */
  readonly externalLinks?: readonly LobbyExternalProfileLink[];
  /** Transport original assertion cells; consumers validate their integrity. */
  readonly verifiedIdentities?: readonly Cell<unknown>[];
}

/** Stable participant identity: the contributor's live `#profile` cell. */
export type LobbyProfileCell = Cell<LobbyProfile>;

export interface LobbyParticipant {
  readonly profile: LobbyProfileCell;
  /** Durable fallback label for policy rows if the live profile is offline. */
  readonly name: string;
}

export interface LobbyAdminRoleAssignment {
  readonly subject: LobbyProfileCell;
  readonly displayName: string;
}

export type LobbyAdminRole = AddIntegrity<
  LobbyAdminRoleAssignment,
  readonly [typeof LOBBY_ADMIN_INTEGRITY]
>;

/**
 * Membership stays open for joins. The same trusted handler performs removals,
 * but its admin decision is enforced against the protected role registry.
 */
export type LobbyParticipantList = LobbyParticipant[] | Default<[]>;

export interface LobbyRoster {
  readonly participants: LobbyParticipantList;
}

export const DEFAULT_LOBBY_ROSTER = {
  participants: [] as LobbyParticipantList,
} satisfies LobbyRoster;

export type LobbyRosterValue =
  | LobbyRoster
  | Default<typeof DEFAULT_LOBBY_ROSTER>;
export type LobbyRosterCell = Writable<LobbyRosterValue>;

/**
 * The roster of explicit lobby-admin roles. It carries three contracts:
 *
 * - `RequiresIntegrity` is the floor: a value landing at this path has to
 *   carry a `lobby-admin` endorsement;
 * - `AddIntegrity` on the list mints that endorsement, so a write through this
 *   schema meets the floor. The endorsement each entry carries through
 *   `LobbyAdminRole` labels the entries, and does not reach the list path the
 *   roster is written at. With the mint on the list, the floor accepts every
 *   write this schema makes, the profile links stored under `subject`
 *   included;
 * - `TrustedActionWrite`, so `commitTrustedLobbyAction` is the only handler
 *   that may modify the roster, and only from a gesture on the trusted lobby
 *   surface. That binding is what decides who may write. Pattern setup and
 *   seed materialization install a value here without going through it.
 */
export type LobbyAdminList = RequiresIntegrity<
  TrustedActionWrite<
    AddIntegrity<
      LobbyAdminRole[],
      readonly [typeof LOBBY_ADMIN_INTEGRITY]
    >,
    typeof commitTrustedLobbyAction,
    typeof TRUSTED_LOBBY_ACTION,
    typeof TRUSTED_LOBBY_SURFACE
  >,
  readonly [typeof LOBBY_ADMIN_INTEGRITY]
>;

/** First explicit role minted while leaving the open bootstrap policy. */
export type LobbyAdminBootstrapRole = AddIntegrity<
  LobbyAdminRoleAssignment,
  readonly [typeof LOBBY_ADMIN_INTEGRITY]
>;

/** Both directions are committed by the role-checking trusted handler. */
export type LobbyEveryoneAdminFlag = TrustedActionWrite<
  boolean,
  typeof commitTrustedLobbyAction,
  typeof TRUSTED_LOBBY_ACTION,
  typeof TRUSTED_LOBBY_SURFACE
>;

export interface LobbyAdminRegistryStoredValue {
  readonly admins?: LobbyAdminList;
  readonly bootstrapAdmin?: LobbyAdminBootstrapRole;
  readonly everyoneIsAdmin?: LobbyEveryoneAdminFlag;
}

export type LobbyAdminRegistryValue =
  | LobbyAdminRegistryStoredValue
  | Default<SeededAdminRegistryValue>;
export type LobbyAdminRegistryCell = Writable<LobbyAdminRegistryValue>;

const EMPTY_PARTICIPANTS: LobbyParticipant[] = [];
const EMPTY_PARTICIPANT_VIEWS: LobbyParticipantView[] = [];

export const lobbyProfileDisplayName = (
  profile: LobbyProfile | undefined,
): string => (profile?.initialNameApplied ?? profile?.name ?? "").trim();

export const lobbyParticipantsValue = (
  roster: LobbyRosterCell,
): LobbyParticipant[] => {
  const stored = roster.get() as LobbyRoster | undefined;
  const participants = stored?.participants as
    | readonly LobbyParticipant[]
    | undefined;
  return participants?.length ? Array.from(participants) : EMPTY_PARTICIPANTS;
};

export const lobbyAdminRolesValue = (
  adminRegistry: LobbyAdminRegistryCell,
): LobbyAdminRole[] => {
  const explicitAdmins = adminRegistryEntries<LobbyAdminRole>(adminRegistry);
  if (explicitAdmins.length > 0) return explicitAdmins;

  const bootstrapAdmin = (
    adminRegistry.get() as LobbyAdminRegistryStoredValue | undefined
  )?.bootstrapAdmin;
  if (bootstrapAdmin === undefined) return [];

  const subject: LobbyProfileCell = adminRegistry.key("bootstrapAdmin").key(
    "subject",
  ).resolveAsCell();
  return [{ ...bootstrapAdmin, subject } as LobbyAdminRole];
};

export const lobbyEveryoneIsAdmin = (
  adminRegistry: LobbyAdminRegistryCell,
): boolean => adminRegistryEveryoneIsAdmin<LobbyAdminRole>(adminRegistry);

export const currentLobbyAdminRole = (
  profile: LobbyProfileCell | undefined,
  roster: LobbyRosterCell,
  adminRegistry: LobbyAdminRegistryCell,
): LobbyAdminRole | undefined => {
  if (profile === undefined) return undefined;

  const participant = lobbyParticipantsValue(roster).find((entry) =>
    equals(entry.profile, profile)
  );
  if (participant === undefined) return undefined;

  const explicitRole = activeAdminRoleForSubject(
    lobbyAdminRolesValue(adminRegistry),
    profile,
  );
  if (explicitRole !== undefined) return explicitRole;
  if (!lobbyEveryoneIsAdmin(adminRegistry)) return undefined;

  return {
    subject: profile,
    displayName: participant.name,
  } as LobbyAdminRole;
};

/**
 * Render-time authorization check. Inside `computed()`, a captured profile
 * cell is observed as its current object value; `equals(cell, cell.get())`
 * intentionally preserves the same graph identity for this boolean lookup.
 */
export const currentLobbyUserIsAdmin = (
  profile: LobbyProfileCell | LobbyProfile | undefined,
  roster: LobbyRosterCell,
  adminRegistry: LobbyAdminRegistryCell,
): boolean => {
  if (profile === undefined) return false;
  const isParticipant = lobbyParticipantsValue(roster).some((participant) =>
    equals(participant.profile, profile)
  );
  if (!isParticipant) return false;
  return lobbyEveryoneIsAdmin(adminRegistry) ||
    lobbyAdminRolesValue(adminRegistry).some((role) =>
      equals(role.subject, profile)
    );
};

export interface LobbyTrustedActionEvent {
  /** Headless/test seam; real UI bindings supply profile cells as state. */
  readonly profile?: LobbyProfileCell;
  readonly everyoneIsAdmin?: boolean;
  readonly detail?: { readonly checked?: boolean };
}

export type LobbyTrustedActionKind =
  | "join"
  | "remove"
  | "toggle-admin"
  | "set-everyone-admin";

export interface LobbyTrustedActionState {
  readonly kind: LobbyTrustedActionKind;
  readonly roster: LobbyRosterCell;
  readonly adminRegistry: LobbyAdminRegistryCell;
  readonly viewerProfile?: LobbyProfileCell;
  readonly viewerName: string;
  readonly targetProfile?: LobbyProfileCell;
}

export interface LobbyAddSelfState {
  readonly roster: LobbyRosterCell;
  readonly viewerProfile?: LobbyProfileCell;
  readonly viewerName: string;
}

interface LobbyAdminPolicyChange {
  readonly admins?: LobbyAdminRole[];
  readonly bootstrapAdmin?: LobbyAdminRole;
  readonly everyoneIsAdmin?: boolean;
}

export const prepareTrustedLobbyAdminChange = (
  currentAdminRole: LobbyAdminRole | undefined,
  adminRegistry: LobbyAdminRegistryCell,
  targetProfile: LobbyProfileCell | undefined,
  targetName: string | undefined,
  nextEveryoneIsAdmin?: boolean,
): LobbyAdminPolicyChange | null => {
  if (currentAdminRole === undefined) return null;

  const adminRoles = lobbyAdminRolesValue(adminRegistry);
  if (nextEveryoneIsAdmin !== undefined) {
    if (nextEveryoneIsAdmin) return { everyoneIsAdmin: true };
    return {
      ...(adminRoles.length === 0 ? { bootstrapAdmin: currentAdminRole } : {}),
      everyoneIsAdmin: false,
    };
  }

  if (lobbyEveryoneIsAdmin(adminRegistry)) return null;
  if (targetProfile === undefined || !targetName) return null;

  const withoutTarget = adminRoles.filter((role) =>
    !equals(role.subject, targetProfile)
  );
  if (withoutTarget.length !== adminRoles.length) {
    // Never leave an explicit policy with no administrator.
    return withoutTarget.length === 0 ? null : { admins: withoutTarget };
  }

  return {
    admins: [
      ...adminRoles,
      {
        subject: targetProfile,
        displayName: targetName,
      } as LobbyAdminRole,
    ],
  };
};

const addLobbyParticipant = (
  roster: LobbyRosterCell,
  profile: LobbyProfileCell | undefined,
  name: string,
): void => {
  const participantName = name.trim() ||
    lobbyProfileDisplayName(profile?.get());
  if (profile === undefined || !participantName) return;

  const participants = roster.key("participants");
  const currentParticipants =
    (participants.get() as LobbyParticipant[] | undefined) ?? [];
  const alreadyJoined = currentParticipants.some((participant) =>
    equals(participant.profile, profile)
  );
  if (alreadyJoined) return;

  // The append depends on the identity read above. A read-modify-write is
  // deliberate: concurrent joins conflict and retry instead of bypassing the
  // uniqueness check.
  participants.set([
    ...currentParticipants,
    { profile, name: participantName },
  ]);
};

/** Agent-facing, no-payload action that joins as the active Fabric profile. */
export const addSelfToLobby = handler<void, LobbyAddSelfState>((_, {
  roster,
  viewerProfile,
  viewerName,
}) => {
  addLobbyParticipant(roster, viewerProfile, viewerName);
});

/**
 * One reviewed binding owns the trusted admin writes. The legacy join branch
 * shares the same open membership operation as `addSelfToLobby`; removal and
 * policy branches fail closed unless the acting profile is both in the roster
 * and active under the current admin policy.
 */
export const commitTrustedLobbyAction = handler<
  LobbyTrustedActionEvent,
  LobbyTrustedActionState
>((event, {
  kind,
  roster,
  adminRegistry,
  viewerProfile,
  viewerName,
  targetProfile,
}) => {
  const participants = roster.key("participants");
  const actorProfile = viewerProfile ?? event?.profile;
  const actorName = viewerName.trim() ||
    lobbyProfileDisplayName(actorProfile?.get());

  if (kind === "join") {
    addLobbyParticipant(roster, actorProfile, actorName);
    return;
  }

  const currentAdminRole = currentLobbyAdminRole(
    actorProfile,
    roster,
    adminRegistry,
  );
  if (currentAdminRole === undefined) return;

  const selectedProfile = targetProfile ?? event?.profile;
  const selectedParticipant = selectedProfile === undefined
    ? undefined
    : ((participants.get() as LobbyParticipant[] | undefined) ?? []).find(
      (participant) => equals(participant.profile, selectedProfile),
    );

  if (kind === "remove") {
    if (selectedParticipant === undefined) return;

    // Address the stored element itself. Rewriting the whole list would also
    // rewrite every surviving cross-space profile link.
    const selectedIndex = (
      (participants.get() as LobbyParticipant[] | undefined) ?? []
    ).findIndex((participant) =>
      equals(participant.profile, selectedParticipant.profile)
    );
    if (selectedIndex < 0) return;
    participants.removeByValue(participants.key(selectedIndex));

    // A removed participant also loses an explicit admin role when another
    // role remains. The final role is retained to avoid a policy lockout.
    const adminRoles = lobbyAdminRolesValue(adminRegistry);
    const remainingAdmins = adminRoles.filter((role) =>
      !equals(role.subject, selectedParticipant.profile)
    );
    if (
      remainingAdmins.length > 0 &&
      remainingAdmins.length !== adminRoles.length
    ) {
      adminRegistry.key("admins").set(remainingAdmins as LobbyAdminList);
    }
    return;
  }

  const nextEveryoneIsAdmin = kind === "set-everyone-admin"
    ? event?.everyoneIsAdmin ?? event?.detail?.checked ??
      !lobbyEveryoneIsAdmin(adminRegistry)
    : undefined;
  const nextPolicy = prepareTrustedLobbyAdminChange(
    currentAdminRole,
    adminRegistry,
    selectedParticipant?.profile,
    selectedParticipant?.name,
    nextEveryoneIsAdmin,
  );
  if (nextPolicy === null) return;

  if (nextPolicy.bootstrapAdmin !== undefined) {
    adminRegistry.key("bootstrapAdmin").set(
      nextPolicy.bootstrapAdmin as LobbyAdminBootstrapRole,
    );
  }
  if (nextPolicy.admins !== undefined) {
    adminRegistry.key("admins").set(nextPolicy.admins as LobbyAdminList);
  }
  if (nextPolicy.everyoneIsAdmin !== undefined) {
    adminRegistry.key("everyoneIsAdmin").set(
      nextPolicy.everyoneIsAdmin as LobbyEveryoneAdminFlag,
    );
  }
});

export interface LobbyInput {
  /** Shared durable presence list. */
  roster?: PerSpace<LobbyRosterValue>;
  /** Shared durable trusted-admin policy. */
  adminRegistry?: PerSpace<LobbyAdminRegistryCell>;
}

export interface LobbyParticipantView {
  readonly name: string;
  readonly isAdmin: boolean;
}

export interface LobbyOutput {
  [NAME]: string;
  [UI]: VNode;
  /** Agent-facing action: add the active Fabric profile, with no payload. */
  addSelf: Stream<void>;
  /** Agent-facing, profile-free snapshot for downstream processing. */
  allParticipants: readonly LobbyParticipantView[];
  /** Backward-compatible alias for `allParticipants`. */
  participants: readonly LobbyParticipantView[];
  participantCount: number;
  currentUserIsAdmin: boolean;
  everyoneIsAdmin: boolean;
  join: Stream<LobbyTrustedActionEvent>;
  removeParticipant: Stream<LobbyTrustedActionEvent>;
  toggleParticipantAdmin: Stream<LobbyTrustedActionEvent>;
  setEveryoneIsAdmin: Stream<LobbyTrustedActionEvent>;
}

const LOBBY_THEME = {
  fontFamily: "'Avenir Next', 'Trebuchet MS', sans-serif",
  borderRadius: "18px",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  colors: {
    primary: "#174c4a",
    primaryForeground: "#fffdf7",
    secondary: "#d9e8df",
    secondaryForeground: "#173a36",
    background: "#f3eee3",
    surface: "#fffaf0",
    surfaceHover: "#f6efdf",
    text: "#18312f",
    textMuted: "#6f7d75",
    border: "#d9d2c3",
    borderMuted: "#e9e2d5",
    accent: "#d97736",
    accentForeground: "#fffaf0",
    success: "#2e7d5b",
    successForeground: "#ffffff",
    error: "#a33b36",
    errorForeground: "#ffffff",
    warning: "#a96b21",
    warningForeground: "#ffffff",
  },
};

const PORCH_LIGHT = {
  width: "12px",
  height: "12px",
  borderRadius: "999px",
  background: "#d97736",
  boxShadow: "0 0 0 6px rgba(217, 119, 54, 0.14)",
  flexShrink: "0",
};

interface LobbyParticipantRowInput {
  participant: LobbyParticipant;
  roster: LobbyRosterCell;
  adminRegistry: LobbyAdminRegistryCell;
  viewerProfile?: LobbyProfileCell;
  viewerName: string;
  currentUserIsAdmin: boolean;
  everyoneIsAdmin: boolean;
}

interface LobbyParticipantRowOutput {
  [UI]: VNode;
}

export interface LobbyViewerStateInput {
  viewerProfile?: LobbyProfileCell;
  roster: LobbyRosterCell;
  adminRegistry: LobbyAdminRegistryCell;
}

export interface LobbyViewerStateOutput {
  myName: string;
  hasProfile: boolean;
  hasJoined: boolean;
  joinLabel: string;
  joinDisabled: boolean;
  everyoneIsAdmin: boolean;
  currentUserIsAdmin: boolean;
  adminSummary: string;
  adminBadgeColor: "accent" | "neutral";
  adminBadgeLabel: "Open" | "Explicit admins";
}

/** Viewer-specific state, split from the wish wrapper so it is testable. */
export const LobbyViewerState = pattern<
  LobbyViewerStateInput,
  LobbyViewerStateOutput
>(({ viewerProfile, roster, adminRegistry }) => {
  const myName = computed(() => lobbyProfileDisplayName(viewerProfile?.get()));
  const hasProfile = computed(() => myName !== "");
  const hasJoined = computed(() =>
    viewerProfile !== undefined &&
    lobbyParticipantsValue(roster).some((participant) =>
      equals(participant.profile, viewerProfile)
    )
  );
  const everyoneIsAdmin = computed(() => lobbyEveryoneIsAdmin(adminRegistry));
  const currentUserIsAdmin = computed(() =>
    currentLobbyUserIsAdmin(viewerProfile, roster, adminRegistry)
  );
  const joinLabel = computed(() =>
    hasJoined
      ? "You’re here"
      : hasProfile
      ? `Join as ${myName}`
      : "Choose a profile"
  );
  const joinDisabled = computed(() => !hasProfile || hasJoined);
  const adminSummary = computed(() =>
    everyoneIsAdmin
      ? "Open fallback: every joined person is an admin."
      : "Only explicitly named admins can manage this lobby."
  );
  const adminBadgeColor = computed(() =>
    everyoneIsAdmin ? "accent" as const : "neutral" as const
  );
  const adminBadgeLabel = computed(() =>
    everyoneIsAdmin ? "Open" as const : "Explicit admins" as const
  );

  return {
    myName,
    hasProfile,
    hasJoined,
    joinLabel,
    joinDisabled,
    everyoneIsAdmin,
    currentUserIsAdmin,
    adminSummary,
    adminBadgeColor,
    adminBadgeLabel,
  };
});

/** Stable subgraph per participant; keeps row-specific handler bindings calm. */
const LobbyParticipantRow = pattern<
  LobbyParticipantRowInput,
  LobbyParticipantRowOutput
>(({
  participant,
  roster,
  adminRegistry,
  viewerProfile,
  viewerName,
  currentUserIsAdmin,
  everyoneIsAdmin,
}) => {
  const rowIsMe = computed(() =>
    viewerProfile !== undefined &&
    equals(participant.profile, viewerProfile)
  );
  const rowIsAdmin = computed(() =>
    everyoneIsAdmin ||
    lobbyAdminRolesValue(adminRegistry).some((role) =>
      equals(role.subject, participant.profile)
    )
  );
  const adminLabel = computed(() =>
    everyoneIsAdmin ? "Admin via everyone" : rowIsAdmin ? "Admin" : "Member"
  );
  const adminColor = computed(() => rowIsAdmin ? "accent" : "neutral");
  const toggleLabel = computed(() =>
    rowIsAdmin ? "Remove admin" : "Make admin"
  );
  const remove = commitTrustedLobbyAction({
    kind: "remove",
    roster,
    adminRegistry,
    viewerProfile,
    viewerName,
    targetProfile: participant.profile,
  });
  const toggleAdmin = commitTrustedLobbyAction({
    kind: "toggle-admin",
    roster,
    adminRegistry,
    viewerProfile,
    viewerName,
    targetProfile: participant.profile,
  });

  return {
    [UI]: (
      <cf-card>
        <cf-hstack
          slot="content"
          align="center"
          justify="between"
          gap="3"
          wrap
        >
          <cf-hstack align="center" gap="2" wrap>
            <cf-profile-badge $profile={participant.profile} size="md" />
            {rowIsMe ? <cf-badge color="primary">You</cf-badge> : null}
            <cf-badge color={adminColor} variant="outline">
              {adminLabel}
            </cf-badge>
          </cf-hstack>
          {currentUserIsAdmin
            ? (
              <cf-hstack align="center" gap="2" wrap>
                <cf-button
                  data-ui-action={TRUSTED_LOBBY_ACTION}
                  color="neutral"
                  variant="outline"
                  size="sm"
                  disabled={everyoneIsAdmin}
                  onClick={toggleAdmin}
                >
                  {toggleLabel}
                </cf-button>
                <cf-button
                  data-ui-action={TRUSTED_LOBBY_ACTION}
                  color="danger"
                  variant="ghost"
                  size="sm"
                  onClick={remove}
                >
                  Remove
                </cf-button>
              </cf-hstack>
            )
            : null}
        </cf-hstack>
      </cf-card>
    ),
  };
});

const Lobby = pattern<LobbyInput, LobbyOutput>(({ roster, adminRegistry }) => {
  const adminRegistryCell: LobbyAdminRegistryCell = adminRegistry!;
  const profileWish = wish<LobbyProfile>({ query: "#profile" });
  const myProfile = profileWish.result;
  const viewerState = LobbyViewerState({
    viewerProfile: myProfile,
    roster,
    adminRegistry: adminRegistryCell,
  });
  const myName = viewerState.myName;
  const participantCount = roster.participants.length;
  const everyoneIsAdmin = viewerState.everyoneIsAdmin;
  const currentUserIsAdmin = viewerState.currentUserIsAdmin;

  const participants = roster.participants;
  const participantViews = computed(() => {
    const values = roster.participants;
    if (values.length === 0) return EMPTY_PARTICIPANT_VIEWS;
    const roles = lobbyAdminRolesValue(adminRegistryCell);
    return values.map((participant) => ({
      name: participant.name,
      isAdmin: everyoneIsAdmin ||
        roles.some((role) => equals(role.subject, participant.profile)),
    }));
  });

  const actionState = {
    roster,
    adminRegistry: adminRegistryCell,
    viewerProfile: myProfile,
    viewerName: myName,
  };
  const addSelf = addSelfToLobby({
    roster,
    viewerProfile: myProfile,
    viewerName: myName,
  });
  const join = commitTrustedLobbyAction({ kind: "join", ...actionState });
  const removeParticipant = commitTrustedLobbyAction({
    kind: "remove",
    ...actionState,
  });
  const toggleParticipantAdmin = commitTrustedLobbyAction({
    kind: "toggle-admin",
    ...actionState,
  });
  const setEveryoneIsAdmin = commitTrustedLobbyAction({
    kind: "set-everyone-admin",
    ...actionState,
  });

  return {
    [NAME]: "Lobby",
    [UI]: (
      <cf-theme theme={LOBBY_THEME}>
        <cf-screen
          data-ui-pattern={TRUSTED_LOBBY_SURFACE}
          data-ui-event-integrity={TRUSTED_LOBBY_SURFACE}
        >
          <cf-hstack slot="header" align="center" justify="between" gap="3">
            <cf-hstack align="center" gap="3">
              <span style={PORCH_LIGHT} aria-hidden="true" />
              <cf-vstack gap="0">
                <cf-heading level={2}>Lobby</cf-heading>
                <cf-text variant="caption" tone="muted">
                  A shared place to arrive
                </cf-text>
              </cf-vstack>
            </cf-hstack>
            <cf-badge color="accent" variant="outline">
              {participantCount} here
            </cf-badge>
          </cf-hstack>

          <cf-vstack
            gap="4"
            padding="4"
            style={{ width: "min(720px, 100%)", margin: "0 auto" }}
          >
            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-vstack gap="1">
                  <cf-heading level={3}>Your Fabric profile</cf-heading>
                  <cf-text tone="muted">
                    Pick the identity you want to bring into this lobby.
                  </cf-text>
                </cf-vstack>
                {profileWish[UI]}
                <cf-button
                  data-ui-action={TRUSTED_LOBBY_ACTION}
                  onClick={addSelf}
                  disabled={viewerState.joinDisabled}
                >
                  {viewerState.joinLabel}
                </cf-button>
              </cf-vstack>
            </cf-card>

            <cf-vstack gap="2">
              <cf-hstack align="center" justify="between" gap="2">
                <cf-heading level={3}>Who’s here</cf-heading>
                <cf-text variant="caption" tone="muted">
                  Live Fabric identities
                </cf-text>
              </cf-hstack>

              {participantCount === 0
                ? (
                  <cf-card>
                    <cf-empty-state message="No one is here yet. Choose your profile and be the first to join.">
                      <span slot="icon">○</span>
                    </cf-empty-state>
                  </cf-card>
                )
                : (
                  <cf-vstack gap="2">
                    {participants.map((participant) => (
                      <LobbyParticipantRow
                        participant={participant}
                        roster={roster}
                        adminRegistry={adminRegistryCell}
                        viewerProfile={myProfile}
                        viewerName={myName}
                        currentUserIsAdmin={currentUserIsAdmin}
                        everyoneIsAdmin={everyoneIsAdmin}
                      />
                    ))}
                  </cf-vstack>
                )}
            </cf-vstack>

            {currentUserIsAdmin
              ? (
                <cf-card>
                  <cf-vstack slot="content" gap="3">
                    <cf-hstack
                      align="start"
                      justify="between"
                      gap="3"
                      wrap
                    >
                      <cf-vstack gap="1">
                        <cf-heading level={3}>Admin access</cf-heading>
                        <cf-text tone="muted">
                          {viewerState.adminSummary}
                        </cf-text>
                      </cf-vstack>
                      <cf-badge color={viewerState.adminBadgeColor}>
                        {viewerState.adminBadgeLabel}
                      </cf-badge>
                    </cf-hstack>
                    <cf-checkbox
                      data-ui-action={TRUSTED_LOBBY_ACTION}
                      checked={everyoneIsAdmin}
                      onClick={setEveryoneIsAdmin}
                    >
                      Everyone is admin
                    </cf-checkbox>
                    <cf-text variant="caption" tone="muted">
                      This is on by default when no explicit admins exist.
                      Turning it off keeps you as the first admin.
                    </cf-text>
                  </cf-vstack>
                </cf-card>
              )
              : null}
          </cf-vstack>
        </cf-screen>
      </cf-theme>
    ),
    addSelf,
    allParticipants: participantViews,
    participants: participantViews,
    participantCount,
    currentUserIsAdmin,
    everyoneIsAdmin,
    join,
    removeParticipant,
    toggleParticipantAdmin,
    setEveryoneIsAdmin,
  };
});

export default Lobby;
