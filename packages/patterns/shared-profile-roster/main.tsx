import {
  type Cell,
  computed,
  Default,
  equals,
  type FabricBytes,
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
import { profileLook } from "../system/profile-look.ts";

/**
 * Shared-profile participant roster (CT-1649).
 *
 * Reference pattern for chat rooms / multiplayer lobbies. There is no runtime
 * primitive for "list every user's profile in this space", so instead each user
 * contributes their OWN entry on join, sourced from their shared profile
 * (`wish({ query: "#profile" })`). See `docs/specs/shared-profile-rosters.md`.
 *
 * This pattern demonstrates the **snapshot** (self-containment) variant: name +
 * picture are copied at join time, so the roster is fully self-describing
 * inside the shared space and never depends on other users' profile spaces
 * being reachable. Participants render from those snapshots via `<cf-avatar>`,
 * and the current viewer's OWN live profile is shown with the trusted
 * `<cf-profile-badge>`.
 *
 * The recommended default is now the **live-link** variant — every participant
 * rendered with a live, visitable `<cf-profile-badge $profile={p.profile} />`
 * bound to their real profile cell (cross-space reads resolve for any authorized
 * viewer, CT-1667/1687). See `profile-roster-live-demo.tsx`. Prefer snapshotting
 * (this file) only when the roster must stay legible with remote profile spaces
 * offline, or when you deliberately want no live cross-space dependency.
 */

/**
 * Stable identity for a participant: the contributor's own `#profile` cell.
 * Display name is mutable and not unique (two different people can both be
 * "Alex"), so it must NOT be used as the identity key. The profile cell is the
 * one stable handle we have — it's a distinct entity per user (each lives in
 * that user's own profile space) and is compared with `equals()`, the pattern
 * idiom for cell identity. Only the renderable fields are surfaced; identity
 * comparison never depends on the value shape.
 */
export type ParticipantProfileCell = Cell<{ name?: string; avatar?: string }>;

/** One participant's contribution to the shared roster (a profile snapshot). */
export interface Participant {
  /**
   * Link to the contributor's profile cell — the stable identity key. Two
   * participants are "the same" iff `equals()` matches on this, never on name.
   */
  profile: ParticipantProfileCell;

  /** Display name, snapshotted from the joiner's profile at join time. */
  name: string;

  /** Avatar text, snapshotted instead when the joiner's profile has no
   * picture; otherwise "". */
  avatar: string;

  /** Picture bytes, snapshotted from the joiner's profile, if it has one. */
  picture?: FabricBytes;
  joinedAt: number;
}

export interface Roster {
  participants: Participant[] | Default<[]>;
}

/** Per-user marker so a viewer only joins once and can see "joined" state. */
export interface ViewerState {
  /** Set once this viewer has contributed their entry to the shared roster. */
  joined?: boolean;

  /** The display name shown on the join button after joining (cosmetic only). */
  joinedName?: string;
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

// The current viewer's name, picture, avatar text and live profile cell are
// resolved from their shared profile in the pattern body (via wish). The handler
// appends a snapshot to the shared roster and records that this viewer has
// joined. Identity is keyed on the `profile` CELL — never the display name,
// which is mutable and may collide between distinct users.
//
// `name`/`picture`/`avatar` arrive as plain values (named `computed` values
// auto-unwrap as handler state — do not call `.get()` on them). `profile` is a
// live cell reference: it round-trips through `push` as a link and is compared
// with `equals()`, the pattern idiom for cell identity (see profile-group-chat
// / fair-share / cfc-group-chat-demo).
const join = handler<JoinEvent, {
  roster: RosterCell;
  viewer: ViewerCell;
  // May be undefined until the viewer's `#profile` wish resolves; guarded below.
  profile: ParticipantProfileCell | undefined;
  name: string;
  picture?: FabricBytes;
  avatar?: string;
}>((_event, { roster, viewer, profile, name, picture, avatar }) => {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return; // No resolved profile name yet — nothing to contribute.
  if (!profile) return; // No resolved profile cell — no stable identity yet.

  // Idempotent: don't re-add this viewer. Compare by profile-cell identity so a
  // viewer who later renames themselves still counts as already-joined, and so
  // two distinct users who happen to share a display name don't block each other.
  const participants = roster.key("participants");
  const already = participants.get().some((p) => equals(p.profile, profile));
  if (!already) {
    participants.push({
      profile,
      name: trimmed,
      // Drawn with the picture, or else the avatar text.
      avatar: "",
      ...profileLook(picture, avatar),
      joinedAt: Date.now(),
    });
  }
  viewer.set({ joined: true, joinedName: trimmed });
});

export interface RosterDemoInput {
  /** Shared roster — every user in the space reads & appends to this. */
  roster?: PerSpace<Roster | Default<typeof DEFAULT_ROSTER>>;

  /** Current viewer's join marker — follows the user, not broadcast directly. */
  viewer?: PerUser<ViewerState | Default<typeof EMPTY_VIEWER>>;
}

export interface RosterDemoOutput {
  [NAME]: string;
  [UI]: VNode;
  roster: PerSpace<Roster | Default<typeof DEFAULT_ROSTER>>;
  viewer: PerUser<ViewerState | Default<typeof EMPTY_VIEWER>>;
  participantCount: number;
  join: Stream<JoinEvent>;
}

export default pattern<RosterDemoInput, RosterDemoOutput>(
  ({ roster, viewer }) => {
    // Resolve THIS viewer's shared profile. `#profile` yields the viewer's own
    // profile cell (the default profile / picker result under PR #3830). The
    // cell itself is the stable identity used to dedupe the roster; the
    // convenience targets give just the values for the snapshot.
    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profilePictureWish = wish<FabricBytes>({ query: "#profilePicture" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });

    const myName = computed(() => profileNameWish.result ?? "");
    const myPicture = computed(() => profilePictureWish.result);
    const myAvatar = computed(() => profileAvatarWish.result);
    // The live profile cell — passed to the join handler as the identity key.
    const myProfile = profileWish.result;

    const participants = roster.participants;
    const participantCount = participants.length;
    const hasJoined = computed(() => viewer.joined === true);
    // Inside a `computed` body, named `computed` values (hasJoined, myName)
    // auto-unwrap to their plain value — do NOT call `.get()` on them here.
    const joinLabel = computed(() =>
      hasJoined ? "Joined" : "Join as " + (myName || "…")
    );

    const boundJoin = join({
      roster,
      viewer,
      profile: myProfile,
      name: myName,
      picture: myPicture,
      avatar: myAvatar,
    });

    return {
      [NAME]: "Shared-profile roster",
      [UI]: (
        <cf-screen>
          <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "440px" }}>
            {
              /* The current viewer's OWN identity — a live profile cell, so the
                trusted cf-profile-badge applies. */
            }
            <cf-vstack gap="1">
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: "600",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "#6b7280",
                }}
              >
                You
              </span>
              <cf-profile-badge $profile={profileWish.result} size="md" />
            </cf-vstack>

            <cf-hstack justify="between" align="center">
              <cf-heading level={3}>
                Participants ({participantCount})
              </cf-heading>
              <cf-button onClick={boundJoin} disabled={hasJoined}>
                {joinLabel}
              </cf-button>
            </cf-hstack>

            {/* Other users render from the snapshot roster via cf-avatar. */}
            <cf-vstack gap="2">
              {participants.map((p) => (
                <cf-hstack gap="2" align="center">
                  <cf-avatar
                    bytes={p.picture}
                    src={p.avatar}
                    name={p.name}
                    size="sm"
                  />
                  <span style={{ fontSize: "0.875rem" }}>{p.name}</span>
                </cf-hstack>
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
