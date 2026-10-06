/**
 * Cozy Poll
 *
 * Collaborative voting with three colors:
 *   🟢 green  (love it)   🟡 yellow (OK)   🔴 red (veto)
 *
 * Winner: fewest reds, then most greens.
 *
 * Identity follows the scrabble idiom:
 * - `users` is a per-space directory of joined participants.
 * - Each viewer's `myName` is per-user; it is set once on join and treated as
 *   immutable thereafter. The join name/avatar come from the viewer's shared
 *   profile (`wish({ query: "#profile" })` — its built-in UI covers profile
 *   create/pick); programmatic callers can still pass an explicit name in the
 *   `joinAs` event.
 * - The first joiner's name is captured into `adminName` (per-space). They can
 *   add/remove options and reset votes. `isAdmin` is derived, not stored.
 * - Open host takeover: any joined participant can `claimHost`, transferring
 *   the role (and the host controls) to themselves. Deliberately ungated
 *   beyond "must be joined"; see `ADMIN-FUTURE.md`.
 */

import {
  computed,
  Default,
  handler,
  hasError,
  hasSchemaMismatch,
  isPending,
  isSyncing,
  NAME,
  observeAvailability,
  pattern,
  type PerSpace,
  type PerUser,
  resultOf,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

export interface User {
  name: string;

  /** Avatar URL or glyph, snapshotted from the joiner's shared profile. */
  avatar?: string;
  color: string;
  joinedAt: number;
}

export interface Option {
  id: string;
  title: string;
  addedByName: string;
}

export type VoteColor = "green" | "yellow" | "red";

export interface Vote {
  voterName: string;
  optionId: string;
  voteType: VoteColor;
}

export interface JoinEvent {
  name?: string;
}

export type ClaimHostEvent = Record<PropertyKey, never>;

export interface AddOptionEvent {
  title?: string;
}

export interface RemoveOptionEvent {
  optionId: string;
}

export interface CastVoteEvent {
  optionId: string;
  voteType: VoteColor;
}

export type ResetVotesEvent = Record<PropertyKey, never>;

type QuestionCell = Writable<string | Default<"What should we pick?">>;
type OptionsCell = Writable<Option[] | Default<[]>>;
type VotesCell = Writable<Vote[] | Default<[]>>;
type UsersCell = Writable<User[] | Default<[]>>;
type NameCell = Writable<string | Default<"">>;

const PLAYER_COLORS = [
  "#2f8a64",
  "#c2573a",
  "#3b4a6b",
  "#a33b35",
  "#b27722",
  "#7c3aed",
];

const POLL_THEME = {
  fontFamily:
    "'Avenir Next', 'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  borderRadius: "8px",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  colors: {
    primary: "#2f6f4e",
    primaryForeground: "#ffffff",
    secondary: "#3b4a6b",
    secondaryForeground: "#ffffff",
    background: "#f1f5ef",
    surface: "#ffffff",
    surfaceHover: "#f6faf4",
    text: "#1d2a1f",
    textMuted: "#5d6f63",
    border: "#cbd9cf",
    borderMuted: "#e2ebe5",
    accent: "#c2573a",
    accentForeground: "#ffffff",
    success: "#2f8a64",
    successForeground: "#ffffff",
    error: "#a33b35",
    errorForeground: "#ffffff",
    warning: "#b27722",
    warningForeground: "#ffffff",
  },
};

const VOTE_SWATCH: Record<VoteColor, string> = {
  green: "#2f8a64",
  yellow: "#d4a82f",
  red: "#a33b35",
};

const trimmedName = (n: string | undefined) => (n ?? "").trim();

const newOptionId = () =>
  `o_${Date.now().toString(36)}_${
    Math.floor(Math.random() * 1e6).toString(36)
  }`;

const colorForIndex = (i: number) => PLAYER_COLORS[i % PLAYER_COLORS.length];

const getInitials = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(
    0,
    2,
  );
};

// `profileName`/`profileAvatar` arrive as plain strings resolved from the
// viewer's shared profile (named `computed` values auto-unwrap as handler
// state). An explicit `name` in the event (tests, headless drivers) overrides
// the profile name — and then deliberately skips the profile avatar.
const joinAs = handler<JoinEvent, {
  users: UsersCell;
  myName: NameCell;
  adminName: NameCell;
  profileName: string;
  profileAvatar: string;
}>(({ name }, { users, myName, adminName, profileName, profileAvatar }) => {
  const override = trimmedName(name);
  const trimmed = override || trimmedName(profileName);
  if (!trimmed) return;
  const current = trimmedName(myName.get());
  if (current) return;
  const existing = users.get();
  if (existing.some((u) => u.name === trimmed)) return;
  const user: User = {
    name: trimmed,
    avatar: override ? "" : (profileAvatar ?? "").trim(),
    color: colorForIndex(existing.length),
    joinedAt: Date.now(),
  };
  users.push(user);
  myName.set(trimmed);
  if (trimmedName(adminName.get()) === "") {
    adminName.set(trimmed);
  }
});

// Open host takeover: any joined participant can claim the host role, which
// transfers it away from the current host (isAdmin is derived from this). This
// is deliberately ungated beyond "must be joined" — see ADMIN-FUTURE.md for the
// kernel-level authority model this pattern-level check is a placeholder for.
const claimHost = handler<ClaimHostEvent, {
  myName: NameCell;
  adminName: NameCell;
}>((_, { myName, adminName }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  if (trimmedName(adminName.get()) === me) return;
  adminName.set(me);
});

const addOption = handler<AddOptionEvent, {
  options: OptionsCell;
  myName: NameCell;
  adminName: NameCell;
  optionDraft: NameCell;
}>(({ title }, { options, myName, adminName, optionDraft }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  const trimmed = trimmedName(title ?? optionDraft.get());
  if (!trimmed) return;
  options.push({
    id: newOptionId(),
    title: trimmed,
    addedByName: me,
  });
  optionDraft.set("");
});

const removeOption = handler<RemoveOptionEvent, {
  options: OptionsCell;
  votes: VotesCell;
  myName: NameCell;
  adminName: NameCell;
}>(({ optionId }, { options, votes, myName, adminName }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  const current = options.get();
  const target = current.find((o) => o.id === optionId);
  if (!target) return;
  options.remove(target);
  votes.set(votes.get().filter((v) => v.optionId !== optionId));
});

const castVote = handler<CastVoteEvent, {
  votes: VotesCell;
  myName: NameCell;
}>(({ optionId, voteType }, { votes, myName }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  const current = votes.get();
  const existingIdx = current.findIndex(
    (v) => v.voterName === me && v.optionId === optionId,
  );
  if (existingIdx >= 0) {
    const existing = current[existingIdx];
    if (existing.voteType === voteType) {
      votes.remove(existing);
      return;
    }
    votes.key(existingIdx).key("voteType").set(voteType);
    return;
  }
  votes.push({ voterName: me, optionId, voteType });
});

const resetVotes = handler<ResetVotesEvent, {
  votes: VotesCell;
  myName: NameCell;
  adminName: NameCell;
}>((_, { votes, myName, adminName }) => {
  const me = trimmedName(myName.get());
  const admin = trimmedName(adminName.get());
  if (!me || me !== admin) return;
  votes.set([]);
});

export interface ClearVoteEvent {
  optionId: string;
}

const clearMyVote = handler<ClearVoteEvent, {
  votes: VotesCell;
  myName: NameCell;
}>(({ optionId }, { votes, myName }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  votes.set(
    votes.get().filter(
      (v) => !(v.voterName === me && v.optionId === optionId),
    ),
  );
});

interface OptionTally {
  option: Option;
  green: number;
  yellow: number;
  red: number;
  voters: Array<{ name: string; voteType: VoteColor; color: string }>;
}

const tallyOptions = (
  options: readonly Option[],
  votes: readonly Vote[],
  users: readonly User[],
): OptionTally[] => {
  const colorByName = new Map(users.map((u) => [u.name, u.color]));
  const tallies = options.map((option): OptionTally => {
    const optionVotes = votes.filter((v) => v.optionId === option.id);
    return {
      option,
      green: optionVotes.filter((v) => v.voteType === "green").length,
      yellow: optionVotes.filter((v) => v.voteType === "yellow").length,
      red: optionVotes.filter((v) => v.voteType === "red").length,
      voters: optionVotes.map((v) => ({
        name: v.voterName,
        voteType: v.voteType,
        color: colorByName.get(v.voterName) ?? "#888",
      })),
    };
  });
  return [...tallies].sort((a, b) => {
    if (a.red !== b.red) return a.red - b.red;
    return b.green - a.green;
  });
};

const myVoteFor = (
  votes: readonly Vote[],
  me: string,
  optionId: string,
): VoteColor | undefined => {
  if (!me) return undefined;
  return votes.find(
    (v) => v.voterName === me && v.optionId === optionId,
  )?.voteType;
};

export interface CozyPollInput {
  question?: PerSpace<string | Default<"What should we pick?">>;
  options?: PerSpace<Option[] | Default<[]>>;
  votes?: PerSpace<Vote[] | Default<[]>>;
  users?: PerSpace<User[] | Default<[]>>;
  adminName?: PerSpace<string | Default<"">>;
  myName?: PerUser<string | Default<"">>;
  // optionDraft etc. are internal form drafts, declared as local
  // per-session cells in the pattern body (parking-coordinator idiom).
}

export interface CozyPollOutput {
  [NAME]: string;
  [UI]: VNode;
  question: string;
  options: readonly Option[];
  votes: readonly Vote[];
  users: readonly User[];
  adminName: string;
  myName: string;
  userCount: number;
  optionCount: number;
  voteCount: number;
  isJoined: boolean;
  isAdmin: boolean;
  joinAs: Stream<JoinEvent>;
  claimHost: Stream<ClaimHostEvent>;
  addOption: Stream<AddOptionEvent>;
  removeOption: Stream<RemoveOptionEvent>;
  castVote: Stream<CastVoteEvent>;
  clearMyVote: Stream<ClearVoteEvent>;
  resetVotes: Stream<ResetVotesEvent>;
}

// Stable empty fallbacks for the output snapshots below — fresh `[]` per
// recompute would make the computed results non-idempotent.
const EMPTY_OPTIONS: Option[] = [];
const EMPTY_VOTES: Vote[] = [];
const EMPTY_USERS: User[] = [];

export default pattern<CozyPollInput, CozyPollOutput>(
  (
    {
      question,
      options,
      votes,
      users,
      adminName,
      myName,
    },
  ) => {
    // Internal per-session form drafts — local to each browser session,
    // not exposed as pattern inputs. Uses the scoped-constructor idiom
    // introduced by parking-coordinator (PR #3610).
    const optionDraft = Writable.perSession.of<string>("");
    // Two-step confirmation for destructive actions. Stores the optionId
    // pending remove-confirm (null = nothing pending). Same idiom as
    // parking-coordinator's `removePersonConfirmTarget`.
    const removeConfirmTarget = Writable.perSession.of<string | null>(null);
    const resetConfirmPending = Writable.perSession.of<boolean>(false);
    // Click-to-reveal for the host-takeover control, so it stays out of the
    // way until a non-host clicks the "Hosted by …" label.
    const claimHostRevealed = Writable.perSession.of<boolean>(false);

    // Resolve THIS viewer's shared profile. The `#profile` wish's built-in UI
    // covers the whole lifecycle: a create surface when the viewer has no
    // profile, a link when they have one, and a picker (with inline create)
    // when they have several. The field targets give the snapshot strings.
    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
    const observedProfileName = observeAvailability(profileNameWish.result);
    const observedProfileAvatar = observeAvailability(
      profileAvatarWish.result,
    );
    const profileName = computed(() => {
      if (
        hasError(observedProfileName) || isPending(observedProfileName) ||
        isSyncing(observedProfileName) ||
        hasSchemaMismatch(observedProfileName)
      ) return "";
      return resultOf(observedProfileName);
    });
    const profileAvatar = computed(() => {
      if (
        hasError(observedProfileAvatar) || isPending(observedProfileAvatar) ||
        isSyncing(observedProfileAvatar) ||
        hasSchemaMismatch(observedProfileAvatar)
      ) return "";
      return resultOf(observedProfileAvatar);
    });
    const hasProfile = computed(() => profileName.trim() !== "");
    const joinLabel = computed(() =>
      hasProfile ? `Join as ${profileName}` : "Create a profile to join"
    );

    const boundJoin = joinAs({
      users,
      myName,
      adminName,
      profileName,
      profileAvatar,
    });
    const boundClaimHost = claimHost({ myName, adminName });
    const boundAddOption = addOption({
      options,
      myName,
      adminName,
      optionDraft,
    });
    const boundRemoveOption = removeOption({
      options,
      votes,
      myName,
      adminName,
    });
    const boundCastVote = castVote({ votes, myName });
    const boundClearMyVote = clearMyVote({ votes, myName });
    const boundResetVotes = resetVotes({ votes, myName, adminName });

    const userCount = users.length;
    const optionCount = options.length;
    const voteCount = votes.length;
    // Resolve the viewer's name ONCE here at the top level. PerUser `myName`
    // resolves in this scope, but NOT inside the per-option `options.map(...)`
    // lift — there `trimmedName(myName)` was handed an unresolved ref and threw
    // `(n ?? "").trim is not a function`, silently nulling out each option's
    // `myVote` (so nothing dimmed). Passing this resolved value down avoids it.
    const me = trimmedName(myName);
    const isJoined = trimmedName(myName) !== "";
    const isAdmin = trimmedName(myName) !== "" &&
      trimmedName(myName) === trimmedName(adminName);
    const joinHint = trimmedName(adminName) === ""
      ? "First to join becomes the host."
      : `Hosted by ${trimmedName(adminName)}.`;
    // Hoist a boolean cell for the reset-confirm JSX ternary so TS doesn't
    // narrow `resetConfirmPending` itself and lose the `.set` method in
    // the false branch.
    const isResetConfirm = computed(() => resetConfirmPending.get());
    const isClaimHostRevealed = computed(() => claimHostRevealed.get());
    const ranked = tallyOptions(options, votes, users);

    const topChoice = voteCount > 0 && ranked.length > 0 ? ranked[0] : null;
    // A joined viewer who is not the current host can take the host role.
    const canClaimHost = trimmedName(myName) !== "" &&
      trimmedName(myName) !== trimmedName(adminName);

    return {
      [NAME]: "Cozy poll",
      [UI]: (
        <cf-theme theme={POLL_THEME}>
          <cf-screen>
            {/* Header */}
            <div
              slot="header"
              style={{
                padding: "16px 20px 12px",
                borderBottom: "1px solid #e5e7eb",
                background: "white",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: "12px",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: "20px",
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    {question}
                  </h2>
                  {computed(() => {
                    const u = userCount ?? 0;
                    const o = optionCount ?? 0;
                    const v = voteCount ?? 0;
                    const admin = trimmedName(adminName);
                    const me = trimmedName(myName);
                    const amAdmin = me !== "" && me === admin;
                    // "you are the host" is handled by the HOST chip in the
                    // top right; only call out the host's name to non-admins.
                    const hostNote = !amAdmin && me !== "" && admin !== ""
                      ? ` · hosted by ${admin}`
                      : "";
                    return (
                      <div
                        style={{
                          marginTop: "4px",
                          fontSize: "13px",
                          color: "#6b7280",
                        }}
                      >
                        {u} joined · {o} options · {v} votes{hostNote}
                      </div>
                    );
                  })}
                </div>
                {computed(() => {
                  const me = trimmedName(myName);
                  if (me === "") return null;
                  const admin = trimmedName(adminName);
                  const amAdmin = me !== "" && me === admin;
                  return (
                    <div
                      style={{
                        display: "flex",
                        gap: "6px",
                        alignItems: "center",
                      }}
                    >
                      {amAdmin
                        ? (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              padding: "4px 10px",
                              borderRadius: "9999px",
                              background: "#dbeafe",
                              border: "1px solid #93c5fd",
                              fontSize: "11px",
                              fontWeight: 700,
                              letterSpacing: "0.05em",
                              color: "#1e40af",
                              whiteSpace: "nowrap",
                            }}
                          >
                            HOST
                          </span>
                        )
                        : null}
                      <span
                        title={me}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "4px 10px",
                          borderRadius: "9999px",
                          background: "#f3f4f6",
                          border: "1px solid #e5e7eb",
                          fontSize: "12px",
                          fontWeight: 600,
                          color: "#374151",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <span style={{ fontSize: "10px", color: "#10b981" }}>
                          ●
                        </span>
                        {me}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <cf-vscroll flex showScrollbar fadeEdges>
              <div
                style={{
                  padding: "16px 20px",
                  maxWidth: "720px",
                  margin: "0 auto",
                }}
              >
                {/* Join card — hidden after the viewer joins. */}
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
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                      }}
                    >
                      {
                        /* Built-in profile UI: create a profile when there is
                          none, pick between existing profiles otherwise. */
                      }
                      <div>{profileWish[UI]}</div>
                      <cf-button
                        onClick={boundJoin}
                        disabled={computed(() => !hasProfile)}
                      >
                        {joinLabel}
                      </cf-button>
                    </div>
                  </div>
                )}

                {
                  /* Open host takeover — kept out of the way: a non-host sees a
                  subtle "Hosted by …" label and clicks it to reveal the
                  "Become host" button. Plain JSX with a per-session toggle so
                  the onClicks lower as handlers (not lifts). */
                }
                {canClaimHost
                  ? (isClaimHostRevealed
                    ? (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          flexWrap: "wrap",
                          padding: "8px 12px",
                          marginBottom: "16px",
                          backgroundColor: "#eef2ff",
                          border: "1px solid #c7d2fe",
                          borderRadius: "8px",
                          fontSize: "13px",
                          color: "#3730a3",
                        }}
                      >
                        <span>{joinHint}</span>
                        <cf-button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            boundClaimHost.send({});
                            claimHostRevealed.set(false);
                          }}
                        >
                          Become host
                        </cf-button>
                        <cf-button
                          size="sm"
                          variant="ghost"
                          onClick={() => claimHostRevealed.set(false)}
                        >
                          Cancel
                        </cf-button>
                      </div>
                    )
                    : (
                      <div style={{ marginBottom: "16px" }}>
                        <button
                          type="button"
                          aria-label="Hosting info — click to take over as host"
                          title="Click to take over as host"
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            fontSize: "13px",
                            color: "#6b7280",
                            cursor: "pointer",
                            textDecoration: "underline dotted",
                            textUnderlineOffset: "3px",
                          }}
                          onClick={() => claimHostRevealed.set(true)}
                        >
                          {joinHint}
                        </button>
                      </div>
                    ))
                  : null}

                {/* Top choice — only when there are votes */}
                {computed(() => {
                  const tally = topChoice;
                  if (!tally) return null;
                  const parts: string[] = [];
                  if (tally.green > 0) parts.push(`${tally.green} love it`);
                  if (tally.yellow > 0) {
                    parts.push(`${tally.yellow} okay with it`);
                  }
                  if (tally.red > 0) parts.push(`${tally.red} can't accept`);
                  const summary = parts.join(", ");
                  const hasReds = tally.red > 0;
                  return (
                    <div
                      style={{
                        padding: "16px",
                        marginBottom: "16px",
                        border: "2px solid #10b981",
                        borderRadius: "8px",
                        backgroundColor: "#ecfdf5",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          marginBottom: "6px",
                        }}
                      >
                        <span style={{ fontSize: "22px" }}>🏆</span>
                        <span
                          style={{
                            fontSize: "12px",
                            fontWeight: 700,
                            letterSpacing: "0.05em",
                            textTransform: "uppercase",
                            color: "#065f46",
                          }}
                        >
                          Top choice
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: "20px",
                          fontWeight: 700,
                          color: "#064e3b",
                          marginBottom: "4px",
                        }}
                      >
                        {tally.option.title}
                      </div>
                      <div
                        style={{
                          fontSize: "13px",
                          color: hasReds ? "#b91c1c" : "#047857",
                        }}
                      >
                        {summary}
                      </div>
                    </div>
                  );
                })}

                {/* All options summary — only when there are options */}
                {computed(() => {
                  const list = ranked;
                  if (!list || list.length === 0) return null;
                  const me = trimmedName(myName);
                  return (
                    <div
                      style={{
                        marginBottom: "16px",
                        padding: "12px 16px",
                        backgroundColor: "#f9fafb",
                        border: "1px solid #e5e7eb",
                        borderRadius: "8px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                          color: "#6b7280",
                          marginBottom: "10px",
                        }}
                      >
                        All options
                      </div>
                      {list.map((tally) => (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "6px 10px",
                            marginBottom: "4px",
                            backgroundColor: "white",
                            border: "1px solid #e5e7eb",
                            borderRadius: "6px",
                          }}
                        >
                          <div
                            style={{
                              flex: 1,
                              fontSize: "13px",
                              fontWeight: 500,
                              color: "#111827",
                            }}
                          >
                            {tally.option.title}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              gap: "4px",
                              flexWrap: "wrap",
                              justifyContent: "flex-end",
                            }}
                          >
                            {tally.voters.map((v) => (
                              <span
                                title={v.name}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  minWidth: "22px",
                                  height: "22px",
                                  padding: "0 6px",
                                  borderRadius: "9999px",
                                  backgroundColor: VOTE_SWATCH[v.voteType],
                                  color: "white",
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  boxShadow: v.name === me
                                    ? "0 0 0 2px white, 0 0 0 3px #111827"
                                    : "none",
                                }}
                              >
                                {getInitials(v.name)}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}

                {/* Empty state */}
                {computed(() => {
                  if (options && options.length > 0) return null;
                  const me = trimmedName(myName);
                  const admin = trimmedName(adminName);
                  const amAdmin = me !== "" && me === admin;
                  const hint = amAdmin
                    ? "Add the first one above."
                    : admin !== ""
                    ? `${admin} can add the first option.`
                    : "Waiting for a host to join.";
                  return (
                    <div
                      style={{
                        padding: "32px 20px",
                        border: "1px dashed #d1d5db",
                        borderRadius: "8px",
                        textAlign: "center",
                        color: "#6b7280",
                      }}
                    >
                      <div style={{ fontSize: "14px", fontWeight: 600 }}>
                        No options yet
                      </div>
                      <div style={{ fontSize: "13px", marginTop: "4px" }}>
                        {hint}
                      </div>
                    </div>
                  );
                })}

                {/* Interactive options — vote per option */}
                {options.map((option) => {
                  const oid = option.id;
                  const optionTitle = option.title;
                  // Use the top-level-resolved `me`, not `trimmedName(myName)`:
                  // the raw PerUser ref doesn't resolve inside this per-option
                  // lift (see `me` above).
                  const myVote = myVoteFor(votes, me, oid);
                  const rank = computed(() => {
                    const idx = ranked.findIndex(
                      (t) => t.option.id === oid,
                    );
                    return idx >= 0 ? idx + 1 : 0;
                  });
                  const isRemoveConfirm = removeConfirmTarget.get() === oid;
                  // The castVote handler toggles per-color: clicking your
                  // active color clears, a different color updates, none
                  // pushes. JSX dispatches one event per click; the handler
                  // decides what to do. The onClick lambdas are inlined
                  // (not assigned to locals) so the transformer lifts each
                  // into a handler-with-bindings — same idiom as
                  // parking-coordinator's per-item action dispatch.
                  return (
                    <div
                      style={{
                        marginBottom: "10px",
                        padding: "10px 12px",
                        border: "1px solid #e5e7eb",
                        borderRadius: "8px",
                        backgroundColor: "white",
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                      }}
                    >
                      <span
                        style={{
                          minWidth: "28px",
                          height: "28px",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: "9999px",
                          backgroundColor: "#f3f4f6",
                          color: "#374151",
                          fontSize: "12px",
                          fontWeight: 700,
                        }}
                      >
                        #{rank}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: "14px",
                            color: "#111827",
                          }}
                        >
                          {optionTitle}
                        </div>
                        <div
                          style={{
                            fontSize: "11px",
                            color: "#6b7280",
                            display: "flex",
                            gap: "6px",
                            alignItems: "baseline",
                          }}
                        >
                          <span>added by {option.addedByName}</span>
                          {
                            /* Admin-only Remove — muted, far from the vote
                              chips. Two-step confirm when the option has
                              votes (same idiom as parking-coordinator). */
                          }
                          {isAdmin
                            ? (
                              <button
                                type="button"
                                aria-label="Remove option (host)"
                                style={{
                                  background: "none",
                                  border: "none",
                                  padding: 0,
                                  color: "#9ca3af",
                                  fontSize: "11px",
                                  textDecoration: "underline",
                                  cursor: "pointer",
                                }}
                                onClick={() => removeConfirmTarget.set(oid)}
                              >
                                · remove
                              </button>
                            )
                            : null}
                        </div>
                        {isRemoveConfirm
                          ? (
                            <div
                              style={{
                                marginTop: "8px",
                                padding: "8px 10px",
                                backgroundColor: "#fef2f2",
                                border: "1px solid #fecaca",
                                borderRadius: "6px",
                                fontSize: "12px",
                                color: "#991b1b",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                flexWrap: "wrap",
                              }}
                            >
                              <span>
                                Remove "{optionTitle}" and discard its votes?
                              </span>
                              <cf-button
                                size="sm"
                                variant="primary"
                                onClick={() => {
                                  boundRemoveOption.send({ optionId: oid });
                                  removeConfirmTarget.set(null);
                                }}
                              >
                                Yes, remove
                              </cf-button>
                              <cf-button
                                size="sm"
                                variant="ghost"
                                onClick={() => removeConfirmTarget.set(null)}
                              >
                                Cancel
                              </cf-button>
                            </div>
                          )
                          : null}
                      </div>
                      {isJoined
                        ? (
                          <div
                            style={{
                              display: "flex",
                              gap: "6px",
                              alignItems: "center",
                            }}
                          >
                            <cf-button
                              aria-label={myVote === "green"
                                ? "Clear my green vote"
                                : "Love it"}
                              style={myVote === "green"
                                ? "background-color: #22c55e; color: white; font-weight: bold; border: 2px solid #16a34a;"
                                : myVote
                                ? "opacity: 0.4;"
                                : ""}
                              onClick={() =>
                                boundCastVote.send({
                                  optionId: oid,
                                  voteType: "green",
                                })}
                            >
                              🟢
                            </cf-button>
                            <cf-button
                              aria-label={myVote === "yellow"
                                ? "Clear my yellow vote"
                                : "Okay with it"}
                              style={myVote === "yellow"
                                ? "background-color: #eab308; color: white; font-weight: bold; border: 2px solid #ca8a04;"
                                : myVote
                                ? "opacity: 0.4;"
                                : ""}
                              onClick={() =>
                                boundCastVote.send({
                                  optionId: oid,
                                  voteType: "yellow",
                                })}
                            >
                              🟡
                            </cf-button>
                            <cf-button
                              aria-label={myVote === "red"
                                ? "Clear my red vote"
                                : "Veto"}
                              style={myVote === "red"
                                ? "background-color: #ef4444; color: white; font-weight: bold; border: 2px solid #dc2626;"
                                : myVote
                                ? "opacity: 0.4;"
                                : ""}
                              onClick={() =>
                                boundCastVote.send({
                                  optionId: oid,
                                  voteType: "red",
                                })}
                            >
                              🔴
                            </cf-button>
                          </div>
                        )
                        : null}
                    </div>
                  );
                })}

                {/* Host controls — only the admin sees this card. */}
                {isAdmin
                  ? (
                    <div
                      style={{
                        marginBottom: "16px",
                        padding: "12px 16px",
                        backgroundColor: "#eff6ff",
                        border: "1px solid #bfdbfe",
                        borderRadius: "8px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                          color: "#1e40af",
                          marginBottom: "8px",
                        }}
                      >
                        Host controls
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: "8px",
                          alignItems: "center",
                        }}
                      >
                        <cf-input
                          $value={optionDraft}
                          placeholder="Add an option…"
                          aria-label="Option title"
                          timing-strategy="immediate"
                          style="flex:1"
                        />
                        <cf-button onClick={boundAddOption}>Add</cf-button>
                        {isResetConfirm
                          ? (
                            <>
                              <cf-button
                                variant="primary"
                                onClick={() => {
                                  boundResetVotes.send({});
                                  resetConfirmPending.set(false);
                                }}
                              >
                                Yes, reset
                              </cf-button>
                              <cf-button
                                variant="ghost"
                                onClick={() => resetConfirmPending.set(false)}
                              >
                                Cancel
                              </cf-button>
                            </>
                          )
                          : (
                            <cf-button
                              onClick={() => resetConfirmPending.set(true)}
                            >
                              Reset votes
                            </cf-button>
                          )}
                      </div>
                    </div>
                  )
                  : null}
              </div>
            </cf-vscroll>
          </cf-screen>
        </cf-theme>
      ),
      question,
      // Output snapshots readable from OTHER runtimes (multi-user tests,
      // remote viewers): raw scoped values read as undefined in runtimes that
      // didn't write them, and a computed that RETURNS undefined is
      // indistinguishable from "not yet computed" for cross-runtime readers —
      // so every snapshot yields a real, stable value (the shared EMPTY
      // constants keep the fallback idempotent across recomputes).
      options: computed(() => options ?? EMPTY_OPTIONS),
      votes: computed(() => votes ?? EMPTY_VOTES),
      users: computed(() => users ?? EMPTY_USERS),
      adminName: computed(() => trimmedName(adminName)),
      myName: computed(() => trimmedName(myName)),
      userCount,
      optionCount,
      voteCount,
      isJoined,
      isAdmin,
      joinAs: boundJoin,
      claimHost: boundClaimHost,
      addOption: boundAddOption,
      removeOption: boundRemoveOption,
      castVote: boundCastVote,
      clearMyVote: boundClearMyVote,
      resetVotes: boundResetVotes,
    };
  },
);
