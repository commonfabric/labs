import {
  type Cell,
  computed,
  Default,
  equals,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

/**
 * LIVE multi-user profile roster demo (CT-1648/CT-1650 end-to-end check).
 *
 * Unlike `shared-profile-roster` (which SNAPSHOTS each participant's name+avatar
 * at join time and renders others with a plain `<cf-avatar>`), this demo stores
 * each participant's live `#profile` cell and renders EVERY participant — not
 * just the current viewer — with the trusted `<cf-profile-badge>` bound to that
 * cross-space profile cell. That exercises the full stack in a genuine
 * multi-user setting:
 *   - per-user profile spaces (CT-1650),
 *   - cross-space profile READ materialization (CT-1667/1687),
 *   - the badge's bio + pinned-count hover tooltip (CT-1648).
 *
 * If cross-space profile reads work across users, viewer A hovering viewer B's
 * badge sees B's bio + pinned-piece count. If they don't, this demo is exactly
 * the harness that surfaces the gap.
 */

export type ParticipantProfileCell = Cell<
  { name?: string; avatar?: string; bio?: string }
>;

export interface Participant {
  /** Live link to the contributor's profile cell — stable identity + live data. */
  profile: ParticipantProfileCell;

  /** Display name, snapshotted at join time (durable label; survives even if the live cell is momentarily unresolved on first render). */
  name: string;
  joinedAt: number;
}

export interface Roster {
  participants: Participant[] | Default<[]>;
}

export interface ViewerState {
  joined?: boolean;
}

const DEFAULT_ROSTER: Roster = { participants: [] };
const EMPTY_VIEWER: ViewerState = {};

type RosterCell = Writable<Roster | Default<typeof DEFAULT_ROSTER>>;
type ViewerCell = Writable<ViewerState | Default<typeof EMPTY_VIEWER>>;

// `void`, not the empty closed object it was: the runner's closed-world gate
// refuses any payload with an undeclared field against `additionalProperties:
// false`, and a rendered click arrives as the serialized DOM event (`type`,
// `provenance`, target scalars) — so `Record<PropertyKey, never>` made every
// Join from the button fail before the handler ran (seen on the
// fabric-profiles bench, 2026-09-12). The handler reads nothing from the
// event. `void` is the lobby's shape (`addSelfToLobby`); it changes the
// `join` stream's recorded contract, accepted in
// tasks/pattern-compat-accepted-breaks.ts.
export type JoinEvent = void;

const join = handler<JoinEvent, {
  roster: RosterCell;
  viewer: ViewerCell;
  profile: ParticipantProfileCell | undefined;
  name: string;
}>((_event, { roster, viewer, profile, name }) => {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return;
  if (!profile) return;
  const participants = roster.key("participants");
  const already = participants.get().some((p) => equals(p.profile, profile));
  if (!already) {
    participants.push({ profile, name: trimmed, joinedAt: Date.now() });
  }
  viewer.set({ joined: true });
});

export interface ProfileRosterLiveInput {
  roster?: PerSpace<Roster | Default<typeof DEFAULT_ROSTER>>;
  viewer?: PerUser<ViewerState | Default<typeof EMPTY_VIEWER>>;
}

export interface ProfileRosterLiveOutput {
  [NAME]: string;
  [UI]: VNode;
  roster: PerSpace<Roster | Default<typeof DEFAULT_ROSTER>>;
  viewer: PerUser<ViewerState | Default<typeof EMPTY_VIEWER>>;
  participantCount: number;
  join: Stream<JoinEvent>;
}

const headerLabel = {
  fontSize: "0.75rem",
  fontWeight: "600",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "#6b7280",
};

export default pattern<ProfileRosterLiveInput, ProfileRosterLiveOutput>(
  ({ roster, viewer }) => {
    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });

    const myName = computed(() => profileNameWish.result ?? "");
    const myProfile = profileWish.result;

    const participants = roster.participants;
    const participantCount = participants.length;
    const hasJoined = computed(() => viewer.joined === true);
    const joinLabel = computed(() =>
      hasJoined ? "Joined" : "Join as " + (myName || "…")
    );

    const boundJoin = join({
      roster,
      viewer,
      profile: myProfile,
      name: myName,
    });

    return {
      [NAME]: "Live profile roster",
      [UI]: (
        <cf-screen>
          <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "440px" }}>
            <cf-vstack gap="1">
              <span style={headerLabel}>You</span>
              {
                /* `#profile` is a wish RESULT (not the raw profile piece), so a
                click would route to a non-piece id and fail to load. The self
                badge is non-navigable (same convention as profile-home's self
                badge); the participant badges below bind raw profile cells and
                DO navigate. */
              }
              <cf-profile-badge
                $profile={profileWish.result}
                size="md"
                noNavigate
              />
            </cf-vstack>

            <cf-hstack justify="between" align="center">
              <cf-heading level={3}>
                Participants ({participantCount})
              </cf-heading>
              <cf-button onClick={boundJoin} disabled={hasJoined}>
                {joinLabel}
              </cf-button>
            </cf-hstack>

            {
              /* EVERY participant rendered as a LIVE badge bound to their own
              cross-space profile cell — hover to see their bio + pinned count. */
            }
            <cf-vstack gap="2">
              {participants.map((p) => (
                <cf-profile-badge $profile={p.profile} size="md" />
              ))}
            </cf-vstack>
          </cf-vstack>
        </cf-screen>
      ),
      roster,
      viewer,
      participantCount,
      join: boundJoin,
    };
  },
);
