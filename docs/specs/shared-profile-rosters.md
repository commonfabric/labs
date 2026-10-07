# Shared-Profile Participant Rosters

## Status

Guidance + reference demo. Tracks **CT-1649** ("Document shared-profile
participant rosters"). Builds directly on the shared profile space work in
**CT-1645** ([Shared Profile Space](shared-profile-space.md)) and the
multi-profile `#profile` resolution described there and in PR #3830.

## The problem

Multiplayer surfaces — chat rooms, lobbies, turn-based games — need to show
*who is here*: a roster of every participant with their name and avatar.

There is **no runtime primitive for "list all users' profiles in this space."**
Profiles live in each user's own profile space (CT-1645), reachable only from
that user's home space. A pattern running in a shared space cannot enumerate the
profile spaces of everyone who has visited. `wish({ query: "#profile" })`
resolves *the current viewer's* profile and nothing else.

## The recommended pattern

Keep the roster as ordinary, app-level shared state and have **each user
contribute their own entry when they join**:

- A `participants: PerSpace<...>` array is the shared roster. Everyone in the
  space reads and appends to it.
- Current-viewer identity (have-I-joined, my draft name) stays `PerUser<>` or
  `PerSession<>` — it is never broadcast directly; it only gates the join.
- The **join flow resolves the current viewer's shared profile** via
  `wish({ query: "#profile" })` (and the convenience targets `#profileName` /
  `#profileAvatar`). Under PR #3830 a user can have multiple profiles; the wish
  resolves the user's **default** profile in the headless/single-profile case
  and launches the framework picker when there are two or more. Patterns retain
  the Wish state, inspect `state.result` with availability guards when needed,
  and use `resultOf(state.result)` for the selected profile.
- The join handler writes that viewer's contribution into the shared roster —
  by default a **link** to their live profile cell (rendered with
  `<cf-profile-badge>`), or a **stable snapshot** of name/avatar for the
  self-containment case (see next section).
- Every other user renders each participant from `participants` — a live
  `<cf-profile-badge $profile={p.profile} />` bound to the contributed profile
  cell, which resolves cross-space for any authorized viewer (CT-1667/1687) and
  is **visitable** (clicking it opens that user's live profile). No cross-user
  profile enumeration is ever required.

This is the same shape used by `packages/patterns/scrabble/scrabble.tsx`
(a `PerSpace` `players` roster + a join handler that `push`es the current
player — its join now sources name/avatar from the shared profile this way) and
`packages/patterns/scoped-user-directory/main.tsx` (a `PerSpace` `directory` +
a `PerUser` `me` pointer). The only addition here is sourcing the display
name/avatar from the shared profile instead of a free-text field.

## Why links vs snapshots

A roster entry can store a **live link** to the contributor's profile cell (the
default — rendered with the trusted, visitable `<cf-profile-badge>`) or a
**snapshot** of the values copied at join time (a self-containment fallback).
They are different trade-offs.

### Live link (recommended)

Store a reference to the contributor's profile cell (the `result` of their
`#profile` wish) and render it with `<cf-profile-badge $profile={p.profile} />`:

```ts
// Shown inside a handler.
participants.push({ profile: myProfile, joinedAt: Date.now() });
// render: <cf-profile-badge $profile={p.profile} />
```

- **Pros:** Always current — a profile rename or avatar change propagates to
  every roster that links it, with no refresh path. The runtime materializes
  cross-space link targets on read (a read that finds the target absent kicks an
  async load and re-renders on arrival — CT-1667/1687, PR #4019), so the link
  resolves for any viewer with access to the profile's space. The badge is
  **visitable** — clicking it opens the contributor's live profile — and carries
  the runtime-attested verified-identity seal plus the bio / pinned-count
  tooltip. This is the idiom: wish for `#profile`, key identity with `equals()`,
  render the real cell.
- **Cons:** First render shows blanks until the cross-space load lands, and
  the roster's freshness couples to the remote space's availability — offline
  or unreachable profile spaces render empty rather than stale.

### Snapshot (self-containment fallback)

Copy the resolved `name` and `avatar` strings into the roster entry when the user
joins:

```ts
// Shown inside a handler.
participants.push({ name, avatar, joinedAt: Date.now() });
```

- **Pros:** Self-contained — every other viewer renders from plain strings
  already in the shared space, no cross-space resolution, no dependency on the
  joiner's profile space being reachable later. Cheap, durable, and trivially
  serializable. Renders identically and immediately for all viewers. Best when
  the roster must stay legible with remote profile spaces offline, or when you
  explicitly do not want a live cross-space dependency.
- **Cons:** Goes stale. If the user renames themselves or changes their avatar
  after joining, the roster keeps the old values until they re-join / you add a
  refresh path. Renders a plain `<cf-avatar>` — no verified seal, not visitable.

### Verdict

**Default to a live link rendered with `<cf-profile-badge>`.** Cross-space reads
now resolve for any authorized viewer (CT-1667/1687, verified end-to-end across
multiple real identities), so the live badge gives current data, a verified
identity seal, the bio/pinned tooltip, and a visitable link to each
contributor's profile — for the whole price of storing one cell reference.
Reach for a **snapshot** when the roster must render with remote profile spaces
unreachable, or when you deliberately want no live cross-space dependency; a
**hybrid** (snapshot for immediate, availability-independent text *plus* the
live link for the badge and freshness) gives both.

## Reference demos

The **canonical live-link reference** is
[`packages/patterns/profile-roster-live-demo.tsx`](../../packages/patterns/profile-roster-live-demo.tsx):
every participant renders with a live, visitable `<cf-profile-badge>` bound to
their real profile cell, identity is keyed with `equals()`, and it was verified
end-to-end across multiple real identities. Prefer it as the starting point.

The snapshot pattern below is the **self-containment variant** — it renders
name/avatar from strings copied at join time (no live cross-space dependency)
and additionally stores each joiner's profile **cell as the stable identity
key**, deduped with `equals()`. Here the cell is used only for *identity
comparison*, not dereferenced for cross-space render, so it never depends on
other users' profile spaces being reachable. Every API used below is exercised
elsewhere in the repo:

- `wish<string>({ query: "#profileName" | "#profileAvatar" })` and reading
  `.result` — `packages/patterns/shared-profile-demo/main.tsx`,
  `packages/patterns/chatbot.tsx`.
- `PerSpace` / `PerUser` roster + writable-cell aliases + a join handler that
  writes the roster — `packages/patterns/scrabble/scrabble.tsx`,
  `packages/patterns/scoped-group-chat/main-plain-inputs.tsx`.
- `Date.now()` for timestamps in handlers —
  `packages/patterns/scoped-group-chat/main-plain-inputs.tsx`.
- avatar rendering from snapshot strings — `<img src={...}>` here for
  self-containment; production patterns use `<cf-avatar src name>`
  (`packages/patterns/group-chat-room.tsx`,
  `packages/patterns/profile-group-chat/main.tsx`).

```tsx
import {
  type Cell,
  computed,
  Default,
  equals,
  handler,
  hasError,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  resultOf,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

// ---------------------------------------------------------------------------
// Roster shapes
// ---------------------------------------------------------------------------

/**
 * Stable identity for a participant: the contributor's own `#profile` cell.
 * Display name is mutable and not unique (two different people can both be
 * "Alex"), so it must NOT be the identity key. The profile cell is the stable
 * handle — a distinct entity per user — compared with `equals()`.
 */
export type ParticipantProfileCell = Cell<{ name?: string; avatar?: string }>;

/** One participant's contribution to the shared roster (a profile snapshot). */
export interface Participant {
  /** Link to the contributor's profile cell — the stable identity key. */
  profile: ParticipantProfileCell;
  /** Display name, snapshotted from the joiner's profile at join time. */
  name: string;
  /** Avatar URL/text, snapshotted from the joiner's profile (may be empty). */
  avatar: string;
  joinedAt: number;
}

export interface Roster {
  participants: Participant[] | Default<[]>;
}

/** Per-user marker so a viewer only joins once and can see "joined" state. */
export interface ViewerState {
  /** Set once this viewer has contributed their entry to the shared roster. */
  joined?: boolean;
  /** Display name shown on the join button after joining (cosmetic only). */
  joinedName?: string;
}

// Use explicit type annotations (not `satisfies`): a `{}` inferred from
// `satisfies ViewerState` loses the optional `joinedName`, so `viewer.joinedName`
// fails to type-check in the pattern body.
const DEFAULT_ROSTER: Roster = { participants: [] };
const EMPTY_VIEWER: ViewerState = {};

type RosterCell = Writable<Roster | Default<typeof DEFAULT_ROSTER>>;
type ViewerCell = Writable<ViewerState | Default<typeof EMPTY_VIEWER>>;

// `void`: the handler reads nothing from its event, and the button delivers the
// serialized DOM click (`type`, `provenance`, target scalars). An empty CLOSED
// object here (`Record<PropertyKey, never>`) is refused by the runner's
// closed-world gate before the handler runs.
export type JoinEvent = void;

// ---------------------------------------------------------------------------
// Join handler: contribute the current viewer's profile snapshot
// ---------------------------------------------------------------------------
//
// `name` / `avatar` (plain strings) and the live `profile` cell are resolved
// from the viewer's shared profile in the pattern body (via wish). The handler
// appends a snapshot to the shared roster and records that this viewer joined.
// Identity is keyed on the `profile` CELL — never the display name, which is
// mutable and may collide between distinct users. `profile` round-trips through
// the roster write as a link and is compared with `equals()`, the cell-identity
// idiom.
//
// The join reads the roster to decide whether to append, so it is a
// read-modify-write `set` and not a mergeable `push`: a push drops its own read
// of the list from conflict detection, which is what makes disjoint appends
// merge, and pairing it with a dedup read of the same list is what the
// mergeable-push diagnostic reports (see
// docs/features/migrating-collection-writes.md). The keyed `elementById` +
// `addUnique` form does not apply here — it needs a key derived from the
// element, and pattern code cannot read a profile cell's link. Two viewers
// joining at once therefore conflict and the loser retries, which is what makes
// the dedup hold.

const join = handler<JoinEvent, {
  roster: RosterCell;
  viewer: ViewerCell;
  profile: ParticipantProfileCell;
  name: string;
  avatar: string;
}>((_event, { roster, viewer, profile, name, avatar }) => {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return; // No resolved profile name yet — nothing to contribute.
  // Idempotent: dedupe by profile-cell identity so a viewer who later renames
  // still counts as joined, and two distinct users sharing a display name don't
  // block each other.
  const participants = roster.key("participants");
  const existing = participants.get();
  const already = existing.some((p) => equals(p.profile, profile));
  if (!already) {
    participants.set([...existing, {
      profile,
      name: trimmed,
      avatar: (avatar ?? "").trim(),
      joinedAt: Date.now(),
    }]);
  }
  viewer.set({ joined: true, joinedName: trimmed });
});

// ---------------------------------------------------------------------------
// Pattern input / output
// ---------------------------------------------------------------------------

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
    // Resolve THIS viewer's shared profile. Under PR #3830 this yields the
    // user's default profile (or the picker result if they have >= 2). `#profile`
    // gives the live profile CELL (the stable identity used to dedupe); the
    // convenience targets give just the snapshot strings.
    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });

    // Explicitly handle the no-profile error. Pending values still wait.
    const myName = hasError(profileNameWish.result)
      ? ""
      : resultOf(profileNameWish.result);
    const myAvatar = hasError(profileAvatarWish.result)
      ? ""
      : resultOf(profileAvatarWish.result);
    // The live profile cell — passed to the join handler as the identity key.
    const myProfile = resultOf(profileWish.result);

    const participants = roster.participants;
    const participantCount = participants.length;
    const hasJoined = computed(() => viewer.joined === true);
    // Inside a `computed` body, named `computed` values (hasJoined, myName)
    // auto-unwrap to their plain value — do NOT call `.get()` on them here.
    const joinLabel = computed(() =>
      hasJoined ? "Joined" : "Join as " + (myName || "...")
    );

    const boundJoin = join({
      roster,
      viewer,
      profile: myProfile,
      name: myName,
      avatar: myAvatar,
    });

    return {
      [NAME]: "Shared-profile roster",
      [UI]: (
        <cf-screen>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-hstack justify="between" align="center">
              <cf-heading level={3}>
                Participants ({participantCount})
              </cf-heading>
              <cf-button onClick={boundJoin} disabled={hasJoined}>
                {joinLabel}
              </cf-button>
            </cf-hstack>

            {/* Other users' names/avatars rendered straight from the roster. */}
            <cf-vstack gap="2">
              {participants.map((p) => (
                <cf-hstack gap="2" align="center">
                  {p.avatar
                    ? (
                      <img
                        src={p.avatar}
                        style={{
                          width: "28px",
                          height: "28px",
                          borderRadius: "50%",
                          objectFit: "cover",
                        }}
                      />
                    )
                    : (
                      <div
                        style={{
                          width: "28px",
                          height: "28px",
                          borderRadius: "50%",
                          background: "var(--cf-theme-color-border, #ccc)",
                        }}
                      />
                    )}
                  <span>{p.name}</span>
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
```

### Notes on the demo

- **`myName` / `myAvatar` are passed as plain string state to the handler.** The
  CTS transformer auto-unwraps named `computed` values when used as handler
  state, so the handler receives the resolved string, not a cell. Do not call
  `.get()` on them inside the handler.
- **`participants.map(...)` runs on a direct input cell** (`roster.participants`),
  which is the form the transformer lowers to `.mapWithPattern(...)`. Mapping a
  cell reached through a nested map entry would not convert — keep the roster
  array a direct field as shown.
- **`viewer` stays `PerUser`.** Switch it to `PerSession` if "joined" should
  reset in a fresh tab; the join logic is unchanged either way.
- **No `.set()` before the pattern takes over.** The roster/viewer cells use
  `Default<>` so they start empty without any imperative seeding.

### Live-link variant (the recommended idiom)

The live-link approach — store each joiner's profile **cell** and render it with
a visitable `<cf-profile-badge>` — is the recommended idiom; see
[`profile-roster-live-demo.tsx`](../../packages/patterns/profile-roster-live-demo.tsx)
for the complete pattern. The shape:

```tsx
// Shown inside a pattern body.
const profileWish = wish({ query: "#profile" }); // result is ProfileHomeOutput-shaped
const profile = resultOf(profileWish.result);
// In the join handler, push { profile, joinedAt }.
// Render each entry with: <cf-profile-badge $profile={entry.profile} />
//   — live, carries the verified-identity seal + bio/pinned tooltip, visitable.
```

Cross-space resolution works for any viewer with access to the profile's space
(CT-1667/1687, PR #4019); the trade-off is availability — entries render blank
while the remote space is unreachable. A hybrid (snapshot strings for immediate,
availability-independent text + the link for the badge and freshness) gives
both.

## Recommended approach for chat/game patterns

1. Make the roster `participants: PerSpace<{ ... }[] | Default<[]>>`. Keep
   "have I joined" / draft text as `PerUser<>` (persists across the user's tabs)
   or `PerSession<>` (resets per tab). Never put user/session ids into ordinary
   shared data to fake isolation — use the scope wrappers.
2. On join, resolve the current viewer's shared profile with
   `wish({ query: "#profile" })` (or `#profileName` / `#profileAvatar` for just
   the fields). This returns the user's default profile under PR #3830, with the
   framework picker handling the multi-profile case.
3. **Store a live link** to each joiner's profile cell by default and render it
   with `<cf-profile-badge $profile={p.profile} />` (live, visitable, verified
   seal + tooltip). Fall back to a snapshot (name + avatar copied at join time)
   when the roster must render with remote profile spaces unreachable; a hybrid
   gives availability-independent text plus the live badge.
4. Append idempotently — guard on "already joined" (keyed on the profile cell
   with `equals()`, never the mutable display name) so re-renders and reconnects
   don't duplicate entries (see the `join` handler above).
5. Render every participant directly from `participants`. Do not attempt to
   enumerate other users' profiles — there is no runtime primitive for it, and
   the contributed roster already has everything you need.

## Runnable patterns

Two deployable versions:

- **Live link (canonical):**
  [`packages/patterns/profile-roster-live-demo.tsx`](../../packages/patterns/profile-roster-live-demo.tsx)
  renders *every* participant with a live, visitable
  **`<cf-profile-badge $profile={p.profile} />`** bound to their real profile
  cell — current data, verified seal, bio/pinned tooltip, navigable to each
  contributor's profile. Verified end-to-end across multiple real identities.
- **Snapshot (self-containment variant):**
  [`packages/patterns/shared-profile-roster/main.tsx`](../../packages/patterns/shared-profile-roster/main.tsx)
  renders participants via **`<cf-avatar src={p.avatar} name={p.name} />`** from
  strings copied at join time, with the current viewer's own identity on a
  trusted `<cf-profile-badge>`. Verified deployed (`cf piece new … main.tsx`): 0
  console errors; participant rows show image/emoji/initials avatars; the viewer
  badge shows the profile (or a graceful "Unknown profile" fallback).

## References

- [Shared Profile Space](shared-profile-space.md) — CT-1645 shared profile
  space, `wish` profile targets, owner-protected profile writes.
- `packages/runner/src/builtins/wish.ts` — `#profile`, `#profileName`,
  `#profileAvatar` resolution and the `WishState` result shape.
- `packages/patterns/system/profile-home.tsx` — `ProfileHomeOutput`
  (`name`, `avatar`, `elements`, `initialNameApplied`) that `#profile` resolves
  to.
- `packages/patterns/profile-roster-live-demo.tsx` — canonical live-link roster:
  every participant on a visitable `<cf-profile-badge>` bound to their real cell.
- `packages/patterns/shared-profile-demo/main.tsx` — minimal `#profile` consumer.
- `packages/ui/src/v2/components/cf-profile-badge/` — trusted, visitable identity
  badge (verified seal + bio / pinned-piece tooltip).
- `packages/patterns/scrabble/scrabble.tsx`,
  `packages/patterns/scoped-user-directory/main.tsx`,
  `packages/patterns/scoped-group-chat/main-plain-inputs.tsx` — `PerSpace`
  roster + join-handler precedents.
- `docs/common/patterns/multi-user-patterns.md` — scope-boundary guidance.
