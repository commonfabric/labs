import {
  computed,
  Default,
  equals,
  handler,
  hasError,
  hasSchemaMismatch,
  isPending,
  isSyncing,
  NAME,
  observeAvailability,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type {
  ClaimHostEvent,
  HostCell,
  JoinEvent,
  LunchProfileCell,
  User,
} from "./main.tsx";

/** Parent-owned roster cell shared by all viewers. */
export type ParticipantIdentityUsersCell = Writable<User[] | Default<[]>>;

const PLAYER_COLORS = [
  "#2f8a64",
  "#c2573a",
  "#3b4a6b",
  "#a33b35",
  "#b27722",
  "#7c3aed",
];

const trimmedName = (n: string | undefined) => (n ?? "").trim();
const colorForIndex = (i: number) => PLAYER_COLORS[i % PLAYER_COLORS.length];

/**
 * What a rejected join says, verbatim — exported so the tests pin the same
 * string the deploy doc's smoke test tells an operator to expect.
 */
export const JOIN_NEEDS_PROFILE =
  "Join needs a resolved profile — create or pick one first.";

/**
 * Join as the viewer's shared profile.
 *
 * There is nothing to type: identity is the profile cell, so the roster entry
 * is derived from it rather than from anything the joiner can supply. Joining
 * twice is idempotent — the entry is found by `equals()`, so a second press,
 * a second device, or a rename all resolve to the same participant.
 */
const joinAs = handler<JoinEvent, {
  users: ParticipantIdentityUsersCell;
  host: HostCell | undefined;
  profile: LunchProfileCell | undefined;
  profileAvailable: boolean;
  // Display strings arrive pre-resolved from `#profileName` / `#profileAvatar`.
  // Field reads off the live `#profile` result are not a reliable display
  // source; the dedicated string wishes are.
  profileName: string;
  profileAvatar: string;
  joinMessage: Writable<string>;
}>(
  (
    _event,
    {
      users,
      host,
      profile,
      profileAvailable,
      profileName,
      profileAvatar,
      joinMessage,
    },
  ) => {
    // Gate on the NAME, not on `profile` being falsy: an unset optional CELL
    // input reads as a present-but-empty cell, so `!profile` never fires and a
    // viewer with no resolved profile would join with an empty identity. The
    // name string is honestly "" when nothing resolved.
    const name = trimmedName(profileName);
    if (!name || !profile) {
      // Say WHY, instead of silently doing nothing: a headless caller (the
      // deploy doc's CLI smoke test) has no other signal, and in the browser
      // this is reachable during the transient where one wish has resolved
      // and the other has not.
      joinMessage.set(JOIN_NEEDS_PROFILE);
      return;
    }
    // STORE the terminal cell, never the bound alias: the binding reaches the
    // profile through per-viewer state (the override slot or the wish), so
    // storing it as-is stores "whoever the READER resolves", which reads as a
    // different person in every runtime. `equals()` comparisons resolve the
    // chain either way; only storage needs the pin.
    if (!profileAvailable) {
      joinMessage.set(JOIN_NEEDS_PROFILE);
      return;
    }
    const identity: LunchProfileCell = profile.resolveAsCell();
    // And the identity must READ as present before it may be stored: at
    // `asCell` seams an ABSENT profile arrives as a truthy empty handle
    // (`!profile` above cannot catch it), and pinning that handle stores an
    // empty — or worse, per-reader — identity. A real profile has a value.
    if (identity.get() === undefined) {
      joinMessage.set(JOIN_NEEDS_PROFILE);
      return;
    }
    // Any resolved-identity attempt clears a stale complaint, including the
    // already-joined no-op below.
    joinMessage.set("");
    // A `Default<[]>` cell reads undefined until something writes it.
    const existing = users.get() ?? [];
    // Already joined — on any device, under any name. Nothing to do.
    if (existing.some((u) => equals(u.profile, identity))) return;
    users.set([...existing, {
      profile: identity,
      name,
      avatar: (profileAvatar ?? "").trim(),
      color: colorForIndex(existing.length),
    }]);
    // First to join hosts the poll. (`host` is typed optional only for the
    // legacy-instantiation schema; the pattern always binds it.)
    if (host !== undefined && (host.get() ?? {}).profile === undefined) {
      host.set({ profile: identity });
    }
  },
);

const claimHost = handler<ClaimHostEvent, {
  users: ParticipantIdentityUsersCell;
  host: HostCell | undefined;
  profile: LunchProfileCell | undefined;
  profileAvailable: boolean;
}>((_event, { users, host, profile, profileAvailable }) => {
  // No display-name gate here, unlike `joinAs`. That gate exists because a
  // JOIN has nothing else to prove a profile resolved; a takeover has the
  // roster, and a participant whose name is momentarily unresolved is still
  // the participant their stored entry names by cell.
  if (!profile || host === undefined) return;
  // Terminal cell for storage, and it must READ as present — both per the
  // joinAs comments (a truthy handle is not an identity).
  if (!profileAvailable) return;
  const identity: LunchProfileCell = profile.resolveAsCell();
  if (identity.get() === undefined) return;
  // Only a participant may host, and taking a host role you already hold is a
  // no-op rather than a redundant write.
  if (!(users.get() ?? []).some((u) => equals(u.profile, identity))) return;
  const current = (host?.get() ?? {}).profile;
  if (current !== undefined && equals(current, identity)) return;
  host.set({ profile: identity });
});

/**
 * ParticipantIdentityCard renders the join and host-claim surface.
 *
 * Joining is profile-only: identity is the viewer's `#profile` cell, so two
 * people who share a display name are still distinct participants, a rename
 * never orphans anything, and no per-user state exists to go stale and lock
 * someone out. When no profile resolves, the card renders the `#profile`
 * wish's own create/pick surface, passed down by the parent.
 */

/** Inputs for the participant identity/host controls. */
export interface ParticipantIdentityCardInput {
  /** Shared roster of participants who have joined. */
  users: ParticipantIdentityUsersCell;

  /**
   * Shared pointer to whoever hosts the poll. Optional ONLY so card
   * instantiations stored by the name-keyed predecessor (which had no host
   * pointer) still satisfy this schema; the pattern always passes it.
   */
  host?: HostCell;

  /**
   * The viewer's resolved `#profile` cell — their identity. Undefined until it
   * resolves, or when the viewer has no profile yet.
   */
  profile?: LunchProfileCell;

  /** The viewer's resolved display name ("" until `#profileName` resolves). */
  profileName: string;

  /** The viewer's resolved avatar. */
  profileAvatar: string;

  /**
   * The `#profile` wish's built-in create/pick surface, rendered by the parent
   * and passed down so the card can show it when no profile resolves.
   */
  profileSetupUI?: VNode;
}

/** Outputs for the participant identity/host controls. */
export interface ParticipantIdentityCardOutput {
  [NAME]: string;
  [UI]: VNode;

  /** Whether the viewer has joined this poll. */
  isJoined: boolean;

  /** Whether the viewer hosts this poll. */
  isAdmin: boolean;

  /**
   * Why this viewer's last join attempt was rejected, or "" — the loud
   * counterpart of the join gate. Headless callers read it (a CLI smoke test
   * has no other signal); the card also renders it.
   */
  joinMessage: string;
  joinAs: Stream<JoinEvent>;
  claimHost: Stream<ClaimHostEvent>;
}

export default pattern<
  ParticipantIdentityCardInput,
  ParticipantIdentityCardOutput
>(
  ({ users, host, profile, profileName, profileAvatar, profileSetupUI }) => {
    // Per-user so the complaint follows the identity, not the tab: the CLI
    // invocation that sent the join and the one that reads the answer are
    // different sessions of the same user (the lot-watch `reporterName`
    // scoping).
    const joinMessage = new Writable.perUser("");
    const profileState = observeAvailability(profile?.get());
    const profileAvailable = computed(() =>
      profileState !== undefined && !hasError(profileState) &&
      !isPending(profileState) && !isSyncing(profileState) &&
      !hasSchemaMismatch(profileState)
    );
    const boundJoin = joinAs({
      users,
      host,
      profile,
      profileAvailable,
      profileName,
      profileAvatar,
      joinMessage,
    });
    const boundClaimHost = claimHost({
      users,
      host,
      profile,
      profileAvailable,
    });

    // Identity is derived, never stored per-user: compare the viewer's profile
    // cell against the roster. `equals()` follows links to the end, and a
    // comparison is position-independent — unlike a `list.key(i)` handle, which
    // follows the slot and retargets when an earlier entry is removed.
    const isJoined = computed(() => {
      if (!profileAvailable || profile === undefined) return false;
      const mine: LunchProfileCell = profile;
      return (users.get() ?? []).some((u) => equals(u.profile, mine));
    });
    const isAdmin = computed(() => {
      const current = (host?.get() ?? {}).profile;
      if (
        !profileAvailable || profile === undefined || current === undefined
      ) return false;
      const mine: LunchProfileCell = profile;
      return equals(current, mine);
    });
    const hasProfile = computed(() => trimmedName(profileName) !== "");
    // The profile DOCUMENT must read as present before a join can land, and
    // `#profileName` resolving does not say that it does: the `#profile` wish
    // hands the cell out as a reference, and under a slow link its document
    // is still on its way from the viewer's own space when the name string
    // has already arrived. A click in that window reached `joinAs`, read the
    // profile as absent, and left the complaint below on screen with a live
    // button beside it; the next click succeeded. Reading the document here
    // is what asks the runtime to pull it, and re-runs when it arrives, so the
    // button waits for the identity it would store.
    const profileLoaded = computed(() => profileAvailable);
    const canJoin = computed(() => hasProfile && profileLoaded);
    // The exported verdict is the handler's, unchanged: a headless caller
    // (the deploy doc's CLI smoke test) reads it to learn whether its join
    // landed, and a refusal that raced the profile document is still a
    // refusal — that caller has not joined, and `isJoined` says so too. The
    // rendered notice is the derived one: on screen, a complaint left by such
    // a race is stale the moment a join would succeed, which is when the
    // name and the document both read present and the button is live.
    const joinVerdict = computed(() => joinMessage.get() ?? "");
    const joinNotice = computed(() => canJoin ? "" : joinVerdict);
    const canonicalProfileName = computed(() => trimmedName(profileName));
    const hostName = computed(() => {
      const current = (host?.get() ?? {}).profile;
      if (current === undefined) return "";
      const entry = (users.get() ?? []).find((u) => equals(u.profile, current));
      return entry ? entry.name : "";
    });
    const joinHint = computed(() =>
      hostName === ""
        ? "First to join becomes the host."
        : `Hosted by ${hostName}.`
    );
    const canClaimHost = computed(() => isJoined && !isAdmin);

    return {
      [NAME]: "Participant identity",
      [UI]: (
        <div style="display:contents">
          {isJoined ? null : (
            <div
              style={{
                padding: "16px",
                marginBottom: "16px",
                border: "1px solid #fde68a",
                backgroundColor: "#fef3c7",
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color: "#92400e",
                  marginBottom: "8px",
                }}
              >
                Join the poll
              </div>
              <div
                style={{
                  fontSize: "13px",
                  color: "#78350f",
                  marginBottom: "12px",
                }}
              >
                {joinHint}
              </div>
              {hasProfile
                ? (
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <div
                      data-profile-identity="canonical"
                      style={{ display: "inline-flex", alignItems: "center" }}
                    >
                      <cf-profile-badge
                        $profile={profile}
                        size="sm"
                        noNavigate
                      />
                    </div>
                    <cf-button
                      id="lp-join-button"
                      variant="primary"
                      aria-label="Join the poll with your profile"
                      disabled={!canJoin}
                      onClick={() => boundJoin.send({})}
                    >
                      {profileLoaded
                        ? `Join as ${canonicalProfileName}`
                        : "Loading your profile…"}
                    </cf-button>
                  </div>
                )
                : (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                    {
                      /* The wish's own create/pick surface. Joining needs a
                        profile, so this is the only path in — there is no
                        typed-name fallback to collide or be spoofed. */
                    }
                    <div data-profile-setup>{profileSetupUI}</div>
                  </div>
                )}
              {joinNotice !== ""
                ? (
                  <div
                    data-join-message
                    style={{
                      marginTop: "10px",
                      fontSize: "12px",
                      color: "#92400e",
                    }}
                  >
                    {joinNotice}
                  </div>
                )
                : null}
            </div>
          )}
          {canClaimHost
            ? (
              <div style={{ marginBottom: "12px" }}>
                <cf-button
                  id="lp-claim-host"
                  variant="ghost"
                  size="sm"
                  aria-label="Take over hosting"
                  onClick={() => boundClaimHost.send({})}
                >
                  Take over hosting
                </cf-button>
              </div>
            )
            : null}
        </div>
      ),
      isJoined,
      isAdmin,
      joinMessage: joinVerdict,
      joinAs: boundJoin,
      claimHost: boundClaimHost,
    };
  },
);
