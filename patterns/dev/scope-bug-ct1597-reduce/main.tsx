// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * CT-1597 Reduction Log
 *
 * MIGRATION NOTE (derive removal): the authored `derive()` calls below were
 * later replaced with plain reactive expressions (bare projections / ternaries),
 * which auto-wrap to the same lowered reactive computations. The repro is
 * preserved: the nullable reactive value (`string | null` / `OptionTally | null`)
 * captured by the JSX `computed()` block still emits the identical
 * `{ "anyOf": [..., { "type": "null" }] }` input schema (verified via
 * --show-transformed — same null-branch schema count as the original `derive()`
 * form). The STEP log below records the original bisection, which was performed
 * with `derive()`; the diagnosis (a null-typed reactive value captured by a
 * computed() generating a null-branch schema) is unchanged by the migration.
 *
 * STEP 0 - BASELINE: WIP from 93d545ad6 — BLANK (confirmed in browser)
 *
 * STEP 1: Replace <cf-screen> + slot="header" + <cf-vscroll> with plain <div>
 *   Hypothesis: The shell components cause the blank render
 *   Result: STILL BLANK — shell is NOT the trigger
 *
 * STEP 2: Strip mixed scopes — make all inputs PerSpace only
 *   Hypothesis: PerUser/PerSession scope mixing causes the blank render
 *   Result: STILL BLANK — mixed scopes NOT the trigger
 *
 * STEP 3: Replace ALL computed() blocks with stub <div>s
 *   Hypothesis: One or more computed() blocks causes the blank render
 *   Result: RENDERS — computed blocks ARE the trigger (or interaction with them)
 *
 * STEP 4: Restore computed blocks one at a time to isolate the offender.
 *   Restoring #3 (top choice — conditional null return) first.
 *   Result: BLANK AGAIN — computed #3 is load-bearing for the bug
 *
 * STEP 5: Simplify computed #3 — does computed(() => null) cause blanking?
 *   Hypothesis: ANY computed() returning null anywhere causes blanking
 *   Result: NO — computed(() => null) is fine, renders correctly
 *
 * STEP 6: Does accessing topChoice (a derived OptionTally|null) inside computed() cause blanking?
 *   Hypothesis: Reading topChoice (derived value containing complex object or null) triggers it
 *   Result: YES — reading topChoice inside computed() blanks the render even with unconditional <div> return
 *
 * STEP 7: Is it topChoice specifically (nullable derive result) or any derive result?
 *   Reading `ranked` (always an array, never null) inside computed() — RENDERS fine.
 *   Reading `topChoice` (nullable derive result: OptionTally|null) inside computed() — BLANKS.
 *   => The issue is specific to a derive() whose result type includes null.
 *
 * STEP 8: Minimal nullable derive (string|null from options) read inside computed() — BLANKS.
 *   => The trigger is: any derive() whose return type includes null, read inside computed().
 *   This reproduces with a simple string|null derive, not just complex OptionTally|null.
 *
 * STEP 9: (skipped — bisection complete, cause identified)
 *
 * ROOT CAUSE IDENTIFIED:
 *   The `ts-transformers` compiler, when transforming a `computed(() => {...})` block
 *   that closes over a `derive()` result whose TypeScript return type includes `null`
 *   (e.g. `OptionTally | null` or `string | null`), generates an input schema for the
 *   lowered `derive()` call that contains `{ "anyOf": [..., { "type": "null" }] }`.
 *
 *   Specifically, --show-transformed shows:
 *     computed block captures minimalNullable → schema: { anyOf: [{type:"string"},{type:"null"}] }
 *     computed block captures topChoice       → schema: { anyOf: [{$ref:"#/$defs/OptionTally"},{type:"null"}] }
 *
 *   The runtime's derive/schema machinery does not handle {type:"null"} in an anyOf
 *   when used as an input subscription schema — it causes the entire derived subtree
 *   (everything below the header) to render blank, silently.
 *
 *   Non-nullable derives (e.g. `ranked` which returns OptionTally[]) work fine in computed().
 *   Plain `computed(() => null)` (no captured nullable derive) also works fine.
 *   The bug only manifests when a nullable derive result is captured by a computed() block.
 *
 * PROPOSED FIX DIRECTION:
 *   In `ts-transformers` (the compiler): when generating the input schema for variables
 *   captured by a computed() closure, if a variable's schema contains {type:"null"} in
 *   an anyOf, either (a) strip the null branch from the input schema (null cells will
 *   simply pass null through), or (b) ensure the runtime's derive() subscription logic
 *   treats {type:"null"} in anyOf as "accept null values" rather than an unresolvable schema.
 *
 *   Alternatively, in the runtime: make the derive() input subscription tolerant of
 *   null in anyOf — treat it as optional/nullable rather than causing a silent failure.
 */

import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type PerSession as _PerSession,
  type PerSpace,
  type PerUser as _PerUser,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface User {
  name: string;
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

type QuestionCell = Writable<string | Default<"Where should we eat?">>;
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

const _VOTE_SWATCH: Record<VoteColor, string> = {
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

const _getInitials = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(
    0,
    2,
  );
};

const joinAs = handler<JoinEvent, {
  users: UsersCell;
  myName: NameCell;
  adminName: NameCell;
  joinName: NameCell;
}>(({ name }, { users, myName, adminName, joinName }) => {
  const trimmed = trimmedName(name ?? joinName.get());
  if (!trimmed) return;
  const current = trimmedName(myName.get());
  if (current) return;
  const existing = users.get();
  if (existing.some((u) => u.name === trimmed)) return;
  const user: User = {
    name: trimmed,
    color: colorForIndex(existing.length),
    joinedAt: Date.now(),
  };
  users.push(user);
  myName.set(trimmed);
  joinName.set("");
  if (trimmedName(adminName.get()) === "") {
    adminName.set(trimmed);
  }
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
  question?: PerSpace<string | Default<"Where should we eat?">>;
  options?: PerSpace<Option[] | Default<[]>>;
  votes?: PerSpace<Vote[] | Default<[]>>;
  users?: PerSpace<User[] | Default<[]>>;
  adminName?: PerSpace<string | Default<"">>;
  myName?: PerSpace<string | Default<"">>;
  joinName?: PerSpace<string | Default<"">>;
  optionDraft?: PerSpace<string | Default<"">>;
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
  addOption: Stream<AddOptionEvent>;
  removeOption: Stream<RemoveOptionEvent>;
  castVote: Stream<CastVoteEvent>;
  clearMyVote: Stream<ClearVoteEvent>;
  resetVotes: Stream<ResetVotesEvent>;
}

export default pattern<CozyPollInput, CozyPollOutput>(
  (
    {
      question,
      options,
      votes,
      users,
      adminName,
      myName,
      joinName,
      optionDraft,
    },
  ) => {
    const boundJoin = joinAs({ users, myName, adminName, joinName });
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
    const isJoined = trimmedName(myName) !== "";
    const isAdmin = trimmedName(myName) !== "" &&
      trimmedName(myName) === trimmedName(adminName);
    const ranked = tallyOptions(options, votes, users);

    const _topChoice = voteCount > 0 && ranked.length > 0 ? ranked[0] : null;

    // STEP 8: minimal nullable reactive value — simple string|null from options
    const minimalNullable = options.length > 0 ? options[0].title : null;

    return {
      [NAME]: "Cozy lunch poll",
      [UI]: (
        <cf-theme theme={POLL_THEME}>
          <div>
            {/* Header */}
            <div
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
                  {/* STUB: computed #1 (stats summary) */}
                  <div>stats stub</div>
                </div>
                {/* STUB: computed #2 (user badge) */}
                <div>user-badge stub</div>
              </div>
            </div>

            <div style={{ overflow: "auto" }}>
              <div
                style={{
                  padding: "16px 20px",
                  maxWidth: "720px",
                  margin: "0 auto",
                }}
              >
                {
                  /* Join card — always rendered (cf-input $value bindings
                    must stay at static JSX level). Visually fine because
                    once joined the user largely interacts elsewhere. */
                }
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
                      display: "flex",
                      gap: "8px",
                      alignItems: "center",
                    }}
                  >
                    <cf-input
                      $value={joinName}
                      placeholder="Your name"
                      aria-label="Your name"
                      timing-strategy="immediate"
                      style="flex:1"
                    />
                    <cf-button onClick={boundJoin}>Join</cf-button>
                  </div>
                </div>

                {/* Top choice — only when there are votes */}
                {/* STEP 8: does reading a simple string|null reactive value inside computed() blank? */}
                {computed(() => {
                  const v = minimalNullable;
                  return <div>minimal nullable: {v ?? "null"}</div>;
                })}

                {/* All options summary — only when there are options */}
                {/* STUB: computed #4 (all options summary) */}
                <div>all-options stub</div>

                {
                  /* Host controls — always rendered; the handlers themselves
                    enforce admin via myName === adminName checks. Non-admins
                    can see the controls but their Add will no-op. (UX wart
                    to fix once cf-input binding inside conditionals works.) */
                }
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
                      placeholder="Add an option (e.g. Sushi place)…"
                      aria-label="Option title"
                      timing-strategy="immediate"
                      style="flex:1"
                    />
                    <cf-button onClick={boundAddOption}>Add</cf-button>
                    <cf-button onClick={boundResetVotes}>
                      Reset votes
                    </cf-button>
                  </div>
                </div>

                {/* Empty state */}
                {/* STUB: computed #5 (empty state) */}
                <div>empty-state stub</div>

                {/* Interactive options — vote per option */}
                {options.map((option) => {
                  const oid = option.id;
                  const optionTitle = option.title;
                  const myVote = myVoteFor(votes, trimmedName(myName), oid);
                  const rank = computed(() => {
                    const idx = ranked.findIndex(
                      (t) => t.option.id === oid,
                    );
                    return idx >= 0 ? idx + 1 : 0;
                  });
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
                          }}
                        >
                          added by {option.addedByName}
                        </div>
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
                              aria-label="Love it"
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
                              aria-label="Okay with it"
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
                              aria-label="Veto"
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
                            {myVote
                              ? (
                                <cf-button
                                  aria-label="Clear my vote"
                                  onClick={() =>
                                    boundClearMyVote.send({
                                      optionId: oid,
                                    })}
                                >
                                  Clear
                                </cf-button>
                              )
                              : null}
                            {isAdmin
                              ? (
                                <cf-button
                                  aria-label="Remove option"
                                  onClick={() =>
                                    boundRemoveOption.send({ optionId: oid })}
                                >
                                  ✕
                                </cf-button>
                              )
                              : null}
                          </div>
                        )
                        : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </cf-theme>
      ),
      question,
      options,
      votes,
      users,
      adminName,
      myName,
      userCount,
      optionCount,
      voteCount,
      isJoined,
      isAdmin,
      joinAs: boundJoin,
      addOption: boundAddOption,
      removeOption: boundRemoveOption,
      castVote: boundCastVote,
      clearMyVote: boundClearMyVote,
      resetVotes: boundResetVotes,
    };
  },
);
