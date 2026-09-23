/**
 * Cozy Lunch Poll - Scoped
 *
 * Collaborative voting with three colors:
 *   🟢 green  (love it)   🟡 yellow (OK)   🔴 red (veto)
 *
 * Winner: fewest reds, then most greens.
 *
 * Identity is the viewer's shared profile CELL, compared with `equals()`:
 * - `users` is a per-space roster; each entry carries the participant's
 *   `#profile` cell as its identity, plus a name/avatar snapshot that is
 *   purely cosmetic. Two people who share a display name are two participants,
 *   and renaming yourself orphans nothing.
 * - "Am I joined?" is DERIVED by comparing the viewer's profile against the
 *   roster — no per-user state is stored, so nothing can go stale and lock a
 *   returning viewer out, on any device.
 * - Joining requires a resolved profile. There is no typed-name path, so a
 *   participant cannot be impersonated by typing their name.
 * - `host` (per-space) points at the first joiner's profile. They can
 *   add/remove options and reset votes. `isAdmin` is derived, not stored.
 * - Open host takeover: any joined participant can `claimHost`, transferring
 *   the role (and the host controls) to themselves. Deliberately ungated
 *   beyond "must be joined"; see `ADMIN-FUTURE.md`.
 * - A vote carries its voter's profile cell, and its key is that profile's
 *   ENTITY paired with the option. So a vote is addressed rather than searched
 *   for: casting, recasting and clearing one read and write that vote alone,
 *   two viewers voting at once touch different keys, and their commits merge
 *   with no conflict and no retry.
 *
 * "We went here" history (Lunch Coordinator roadmap #1): the host logs where
 * the group actually ate via each option's "we went here" button. A host date
 * field backdates the next log (blank = today; `logVisit` also takes an
 * explicit `wentAt`). The log shows as a "Recently eaten" list below the
 * options (8 most recent); the host can delete a single mistaken entry
 * (`removeHistoryEntry`) or clear the whole log.
 *
 * Storage: visits live in a `PerSpace<HistoryEntry[]>` array, capped at the
 * MAX_HISTORY most recent (by date). Each `logVisit` embeds a snapshot of
 * everyone's current vote in the entry's `votes` list — the option title is
 * denormalized, so the snapshot survives the option being removed. The
 * "📊 Lunch stats" card derives per-place visit + green/yellow/red tallies from
 * those embedded snapshots via a plain `computed`.
 * Live voting stays on the in-cell `votes` array. Each history entry — and each
 * embedded vote — carries a frozen display name plus the profile cell of whoever
 * it refers to, so attribution stays correct through renames and roster
 * changes. It must never hold a `users.key(i)` handle: that follows the SLOT,
 * so removing an earlier participant would retarget it to the wrong person.
 *
 * History was briefly backed by the SQLite builtin (#4144/#4145, to dogfood it),
 * but that brought a deployed-piece "invalid database handle" failure plus a
 * stack of workarounds (a write-counter to force query re-runs, TEXT-encoded
 * timestamps, async settle races). It is now back on plain fabric storage.
 *
 * Current-day vote filter: every vote is stamped with `castAt` in `castVote`,
 * and the UI (tallies, swatches, per-option highlights, header count, logVisit
 * snapshots) only shows votes cast on the current day. Older votes stay stored
 * but hidden — the (voter, option) vote key means a re-cast overwrites the same
 * entity, so they don't accumulate. "Today" is the interval `#now/300` wish
 * (`nowTick`): the runtime's shared per-space clock, coarsened to five
 * minutes, written immediately on subscribe (and refreshed on reload), then
 * advanced on aligned boundaries — so an open tab rolls to the new day at
 * midnight on its own. An instant in the `clock` input takes the wish's place
 * wherever the clock is read, which is how a test puts the poll at a moment it
 * chooses; production supplies none. The clock reads null until the wish
 * resolves (shown as an empty vote view and a placeholder date) and stays null
 * on pre-#4740 runtimes, where the vote and visit handlers no-op rather than
 * read an ambient clock the runtime may not provide. Null is the only reading
 * that means unresolved: every instant is a day, epoch included. The day
 * boundary is the runtime's local timezone (the viewer's, in the browser); two
 * viewers in different timezones can see different vote sets around midnight.
 */

import {
  type Cell,
  computed,
  Default,
  entityRefToString,
  equals,
  getEntityId,
  type GroupIndex,
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
import PollOptionCard from "./poll-option-card.tsx";
import ParticipantIdentityCard from "./participant-identity-card.tsx";
import { safeImageUrl } from "./generated-art.tsx";
import { indexBy } from "./voter-index.ts";

/**
 * The minimal profile shape this pattern reads: the stable identity cell for
 * `<cf-profile-badge>` binding and `equals()` comparison. Deliberately just
 * `{ name?, avatar? }` — a richer wish schema (bio / externalLinks /
 * verifiedIdentities Cell[]) makes the cross-space `#profile` result fail to
 * resolve, so the badge falls back to "Unknown profile". The display NAME is
 * never read off this cell; it comes from the `#profileName` string wish and
 * is snapshotted at join.
 */
export interface LunchProfile {
  readonly name?: string;
  readonly avatar?: string;
}

/**
 * A participant's identity: their shared profile cell.
 *
 * Compare two of these with `equals()`, which follows links to the end. Never
 * compare display names — a name is mutable, may collide between distinct
 * people, and is not an address. Never key by list position either: a
 * `list.key(i)` handle follows the SLOT, so it silently retargets when an
 * earlier element is removed.
 */
export type LunchProfileCell = Cell<LunchProfile>;

/**
 * A participant who has joined. `profile` is the identity; everything else is
 * display, snapshotted at join and free to go stale or collide.
 */
export interface User {
  /**
   * Identity. Compare with `equals()`. Optional ONLY for rows stored by the
   * name-keyed predecessor of this pattern: every row THIS pattern writes
   * carries it (the join gate refuses an identity that does not read as
   * present). A row without one is a display ghost — it matches no viewer,
   * so its person can re-join with a profile and appear as themselves.
   */
  profile?: LunchProfileCell;

  /** Display name at join time — cosmetic, may duplicate another participant. */
  name: string;

  /** Avatar URL or glyph, snapshotted from the joiner's shared profile. */
  avatar?: string;
  color: string;
}

/**
 * Which participant hosts the poll, object-wrapped so the field reads as
 * absent rather than as an empty cell before anyone joins.
 */
export interface PollHost {
  readonly profile?: LunchProfileCell;
}

export const DEFAULT_HOST: PollHost = {};

/**
 * The clock override, object-wrapped so that "no instant" is the absence of a
 * field rather than a number standing for it. Every number is a valid instant,
 * so a bare number input would need one of them to mean "unset".
 */
export interface ClockOverride {
  /** The instant the poll reads as now, in milliseconds since the epoch. */
  readonly at?: number;
}

export const DEFAULT_CLOCK: ClockOverride = {};

export type ClockValue = ClockOverride | Default<typeof DEFAULT_CLOCK>;

/**
 * The viewer-identity override, claimed through the `overrideViewer` stream.
 *
 * A unit test has no `#profile` wish environment, so it claims the viewer's
 * profile cell here instead. A claim ALWAYS carries a name — the selection
 * predicate and the join gate key on the name string, because strings are
 * honestly "" when unset while a cell-typed field can read as a truthy empty
 * handle at `asCell` seams (lift bindings, handler inputs) even when absent.
 * Identity stores additionally require the profile to READ as present.
 */
export interface ViewerOverride {
  readonly profile?: LunchProfileCell;

  /** Stands in for `#profileName` / `#profileAvatar`, which also need a wish. */
  readonly name?: string;
  readonly avatar?: string;
}

export const DEFAULT_VIEWER: ViewerOverride = {};

export type ViewerOverrideValue =
  | ViewerOverride
  | Default<typeof DEFAULT_VIEWER>;

export type ViewerCell = Writable<ViewerOverrideValue>;

export type HostValue = PollHost | Default<typeof DEFAULT_HOST>;

export type HostCell = Writable<HostValue>;

export interface Option {
  id: string;
  title: string;
  addedByName: string;

  /**
   * Persisted generated-art data URL (`""` until the host's client generates
   * and syncs it). Every viewer renders this stored value; generation only
   * runs on the host's client for options where it is still empty.
   */
  imageUrl?: string;
}

export type VoteColor = "green" | "yellow" | "red";

export interface Vote {
  /**
   * Whose vote this is. Identity — found with `equals()`, never by name.
   * Optional ONLY for votes stored by the name-keyed predecessor; every vote
   * THIS pattern casts carries it. A legacy vote tallies anonymously and,
   * matching no voter, can never be toggled or recast by anyone.
   */
  voter?: LunchProfileCell;
  optionId: string;
  voteType: VoteColor;

  /**
   * When the vote was cast (ms epoch), stamped by `castVote`. Optional for
   * votes stored before this field existed — those count as not-today, so the
   * current-day filter hides them.
   */
  castAt?: number;
}

/**
 * Joining takes no arguments: identity comes from the viewer's resolved
 * `#profile`, so there is nothing for the joiner to type or spoof.
 */
export type JoinEvent = Record<PropertyKey, never>;

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

/**
 * Art persistence event: the host keeps a generated thumbnail by storing its
 * data URL onto the option. Sent by the option card's host-only keep action,
 * which reads the GeneratedArt sub-pattern's `imageDataUrl` output directly
 * (fetch-derived child outputs materialize for parents since CT-1836).
 */
export interface SetOptionImageEvent {
  optionId: string;
  imageUrl: string;
}

export type ResetVotesEvent = Record<PropertyKey, never>;

/**
 * A snapshot of one person's vote at the moment a visit was logged, embedded in
 * the visit's `votes` list. `optionTitle` is denormalized (options can be
 * removed later; the title is the meaningful record). `voter` is a frozen name
 * snapshot for legibility; `voterProfile` is the live identity link, so a badge
 * rendered from it stays correct after a rename or a roster change.
 */
export interface VoteSnapshot {
  /** Display name at snapshot time — cosmetic; the profile below is identity. */
  voter: string;

  /**
   * Live identity link, so a badge stays right even after a rename. Optional
   * only for snapshots stored by the name-keyed predecessor.
   */
  voterProfile?: LunchProfileCell;
  optionTitle: string;
  color: VoteColor;
}

/**
 * A place the group actually ate, logged by the host — one entry in the
 * `PerSpace<HistoryEntry[]>` visit log. `loggedByName` is a frozen name snapshot
 * (what the "Recently eaten" card renders); `loggedBy` is the live identity
 * link to whoever logged it. `votes` embeds the vote snapshot taken at log
 * time, so per-place stats survive an option's removal.
 */
export interface HistoryEntry {
  id: string;
  title: string;

  /**
   * Display name at log time — cosmetic. Defaulted so entries stored by the
   * name-keyed predecessor (which had no such field) read back as `""`.
   */
  loggedByName: string | Default<"">;

  /**
   * Live identity link to whoever logged it. Optional only for entries
   * stored by the name-keyed predecessor, which recorded no identity link.
   */
  loggedBy?: LunchProfileCell;

  /**
   * Both defaulted so entries stored by the SQL-era predecessor (separate
   * tables, text timestamps) read back — a zero `wentAt` sorts a legacy row
   * last rather than refusing the update, and its snapshot list reads empty.
   */
  wentAt: number | Default<0>;
  votes: VoteSnapshot[] | Default<[]>;
}

/**
 * A "Lunch stats" row — the `placeStats` aggregate. Per visited place: how many
 * times we went, and the green/yellow/red tallies of the votes cast FOR that
 * place (across all its visits' snapshots).
 */
export interface PlaceStat {
  title: string;

  /**
   * Counts are defaulted so rows stored by the SQL-era predecessor (whose
   * derived stat rows carried different fields) read back as zeros instead
   * of refusing the update.
   */
  visits: number | Default<0>;
  greens: number | Default<0>;
  yellows: number | Default<0>;
  reds: number | Default<0>;
}

/**
 * Log a visit — by existing option id, or a free-typed place title.
 * `wentAt` backdates the entry (ms epoch); omitted → the host's date draft,
 * which itself defaults to today.
 */
export interface LogVisitEvent {
  optionId?: string;
  title?: string;
  wentAt?: number;
}

export interface RemoveHistoryEntryEvent {
  id: string;
}

export type ClearHistoryEvent = Record<PropertyKey, never>;

type QuestionCell = Writable<string | Default<"Where should we eat?">>;
type OptionsCell = Writable<Option[] | Default<[]>>;
type VotesCell = Writable<Vote[] | Default<[]>>;
type UsersCell = Writable<User[] | Default<[]>>;

/** Free-text drafts (option title, visit date) — never identity. */
type DraftCell = Writable<string | Default<"">>;
type HistoryCell = Writable<HistoryEntry[] | Default<[]>>;

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

// Produce a stable unused id from action inputs and the current collection.
// This deliberately avoids Date.now()/Math.random(): pre-#4740 Loom runtimes
// reject those ambient capabilities in secure handlers.
const unusedId = (
  prefix: string,
  parts: readonly string[],
  existingIds: readonly string[],
): string => {
  const base = `${prefix}_${JSON.stringify(parts)}`;
  let id = base;
  let suffix = 2;
  while (existingIds.includes(id)) id = `${base}_${suffix++}`;
  return id;
};

// Guard against live options AND every optionId still referenced by a vote:
// without the vote sweep, a remove→re-add of the same (name, title) would mint
// the removed option's id again and adopt any stray votes that merged in after
// the removal cascade's read.
const newOptionId = (
  options: readonly Option[],
  votes: readonly Vote[],
  addedByName: string,
  title: string,
): string =>
  unusedId("o", [addedByName, title], [
    ...options.map((o) => o.id),
    ...votes.map((v) => v.optionId),
  ]);

/**
 * A vote's key: its voter's profile ENTITY and the option, in that order.
 *
 * One voter's vote for one option has a deterministic, content-only address, so
 * casting, recasting and clearing it read and write that vote alone. Two people
 * voting at once hold different keys and their commits merge. The same key
 * names the same vote in every session, at any time, which is what lets a
 * handler reach one vote without reading the list.
 *
 * Identity here is a profile cell, and a cell is not a string, so the key takes
 * the entity the cell points at. `getEntityId` parses the link a cell or a
 * read-back proxy carries, so this works both on `resolveAsCell()` in a caster
 * and on `vote.voter` in a sweep. A vote whose `voter` is absent has no key.
 *
 * The address is part of the poll's storage contract, so it is exported;
 * `packages/patterns/integration/lunch-poll-keyed-votes.test.ts` reads a cast
 * vote back at this key from a session that never observed the write.
 */
export const voteKeyFor = (
  voter: LunchProfileCell | undefined,
  optionId: string,
): string | undefined => {
  if (voter === undefined) return undefined;
  const ref = getEntityId(voter);
  if (ref === undefined) return undefined;
  return JSON.stringify([entityRefToString(ref), optionId]);
};

// Clear a vote's entity document. The entity outlives its membership link, so a
// removal that only drops the link would leave the entity holding the removed
// vote's content; a later read by the same key (the castVote toggle decision)
// would then see that stale content and treat the absent vote as present.
const clearVoteEntity = (votes: VotesCell, key: string): void => {
  const vote: Writable<Vote | undefined> = votes.elementById(key);
  vote.set(undefined);
};

const COMBINING_MARK = /^\p{Mark}$/u;
const EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u;
const REGIONAL_INDICATOR = /^\p{Regional_Indicator}$/u;
const ZERO_WIDTH_JOINER = "\u200D";

// Groups combining marks, emoji modifiers, joined emoji, and regional-indicator
// pairs into the characters displayed in participant labels.
const displayCharactersOf = (value: string): string[] => {
  const codePoints = Array.from(value);
  const characters: string[] = [];
  for (let index = 0; index < codePoints.length; index += 1) {
    let character = codePoints[index] ?? "";
    const next = codePoints[index + 1] ?? "";
    if (
      REGIONAL_INDICATOR.test(character) && REGIONAL_INDICATOR.test(next)
    ) {
      character += next;
      index += 1;
    }
    while (index + 1 < codePoints.length) {
      const continuation = codePoints[index + 1] ?? "";
      if (
        COMBINING_MARK.test(continuation) ||
        EMOJI_MODIFIER.test(continuation)
      ) {
        character += continuation;
        index += 1;
        continue;
      }
      if (
        continuation === ZERO_WIDTH_JOINER && index + 2 < codePoints.length
      ) {
        character += continuation + (codePoints[index + 2] ?? "");
        index += 2;
        continue;
      }
      break;
    }
    characters.push(character);
  }
  return characters;
};

const getDefaultInitials = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const initials = trimmed.split(/\s+/).map((word) =>
    displayCharactersOf(word)[0] ?? ""
  ).join("").toUpperCase();
  return displayCharactersOf(initials).slice(0, 2).join("");
};

const compactName = (name: string): string =>
  name.trim().split(/\s+/).join("").toUpperCase();

const getInitials = (
  name: string,
  participantNames: readonly string[],
): string => {
  const compact = compactName(name);
  const characters = displayCharactersOf(compact);
  if (characters.length === 0) return "?";
  const peers = participantNames
    .map(compactName)
    .filter((candidate) =>
      candidate !== compact &&
      displayCharactersOf(candidate)[0] === characters[0]
    );
  if (peers.length === 0) return getDefaultInitials(name);

  const distinguishingIndex = characters.findIndex((_, index) =>
    index > 0 &&
    peers.every((peer) =>
      !peer.startsWith(characters.slice(0, index + 1).join(""))
    )
  );
  const secondInitial = distinguishingIndex >= 1
    ? characters[distinguishingIndex]
    : characters[1];
  return `${characters[0]}${secondInitial ?? ""}`;
};

const getInitialsByName = (
  participantNames: readonly string[],
): Map<string, string> => {
  const provisionalByName = new Map<string, string>();
  const countByInitials = new Map<string, number>();
  for (const name of participantNames) {
    const initials = getInitials(name, participantNames);
    provisionalByName.set(name, initials);
    countByInitials.set(initials, (countByInitials.get(initials) ?? 0) + 1);
  }

  const expandedByName = new Map<string, string>();
  const countByExpanded = new Map<string, number>();
  for (const name of participantNames) {
    const initials = provisionalByName.get(name) ?? getDefaultInitials(name);
    const expanded = (countByInitials.get(initials) ?? 0) > 1
      ? compactName(name)
      : initials;
    expandedByName.set(name, expanded);
    countByExpanded.set(expanded, (countByExpanded.get(expanded) ?? 0) + 1);
  }

  const result = new Map<string, string>();
  const usedLabels = new Set<string>();
  for (const name of participantNames) {
    const expanded = expandedByName.get(name) ?? getDefaultInitials(name);
    if ((countByExpanded.get(expanded) ?? 0) <= 1) {
      result.set(name, expanded);
      usedLabels.add(expanded);
    }
  }

  const nextSuffixByExpanded = new Map<string, number>();
  for (const name of participantNames) {
    const expanded = expandedByName.get(name) ?? getDefaultInitials(name);
    if ((countByExpanded.get(expanded) ?? 0) <= 1) continue;
    let suffix = nextSuffixByExpanded.get(expanded) ?? 1;
    let label = `${expanded}${suffix}`;
    while (usedLabels.has(label)) {
      suffix += 1;
      label = `${expanded}${suffix}`;
    }
    nextSuffixByExpanded.set(expanded, suffix + 1);
    result.set(name, label);
    usedLabels.add(label);
  }
  return result;
};

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Local-calendar day key ("YYYY-MM-DD") for a timestamp — pure given its input
// (plus the runtime's timezone), so it is safe inside computeds. Local, not
// UTC, matching parseVisitDate's local-midnight convention. Exported for the
// tests, which assert against the same day-boundary rule.
export const dayKeyOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")
  }`;
};

// Header label for the current day ("Thursday, Jul 10"). Formatted from
// the name tables, not toLocaleDateString: SES localeTaming ("safe") aliases
// toLocale* methods to their non-locale forms, so option-driven locale
// formatting is unreliable under lockdown.
const dayLabelOf = (ms: number): string => {
  const d = new Date(ms);
  return `${DAY_NAMES[d.getDay()]}, ${
    MONTH_NAMES[d.getMonth()]
  } ${d.getDate()}`;
};

const newHistoryId = (
  visits: readonly HistoryEntry[],
  loggedByName: string,
  title: string,
  wentAt: number,
): string =>
  unusedId(
    "h",
    [loggedByName, title, String(wentAt)],
    visits.map((visit) => visit.id),
  );

// Parse a "YYYY-MM-DD" draft (from the host's date input) into a timestamp,
// anchored to local midnight. Blank or unparseable → the caller's current
// `#now/300` tick, i.e. today.
const parseVisitDate = (
  draft: string | undefined,
  fallbackNow: number,
): number => {
  const s = (draft ?? "").trim();
  if (!s) return fallbackNow;
  const t = new Date(`${s}T00:00:00`).getTime();
  return Number.isNaN(t) ? fallbackNow : t;
};

// Cap the stored visit log at the most-recent MAX_HISTORY entries (by date). A
// fabric array lives in one cell, so an unbounded log would grow every computed
// that reads it; 200 is generous for a lunch poll.
const MAX_HISTORY = 200;

// Label for a visit derived purely from its own timestamp — never from the
// current clock, so it stays idempotent inside reactive computations (timestamps
// read against "now" belong in handlers, not computeds). Reads like
// "Tuesday, May 20".
const visitLabel = (wentAt: number): string => {
  const d = new Date(wentAt);
  return `${DAY_NAMES[d.getDay()]}, ${
    d.toLocaleDateString([], { month: "short", day: "numeric" })
  }`;
};

/**
 * Is this viewer the host? Compares the host pointer against the viewer's own
 * profile cell — never a name.
 */
const isHost = (
  host: HostCell,
  me: LunchProfileCell | undefined,
): boolean => {
  if (!me) return false;
  const current = host.get().profile;
  return current !== undefined && equals(current, me);
};

/**
 * Test seam: claim the sender's viewer identity — the headless stand-in for
 * the `#profile` / `#profileName` / `#profileAvatar` wishes, which have no
 * resolving environment in a unit test. The handler runs in the SENDING
 * session's runtime, so the write lands in the sender's own per-user slot: a
 * multi-user test claims a distinct identity per participant on one shared
 * piece by sending this from each runtime (the lot-watch `setReporterName`
 * idiom). Production UI never sends it, so the wishes rule there.
 */
const overrideViewer = handler<ViewerOverride, {
  viewer: ViewerCell;
}>((event, { viewer }) => {
  const { profile, name, avatar } = event;
  viewer.set({
    ...(profile !== undefined ? { profile } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(avatar !== undefined ? { avatar } : {}),
  });
});

const addOption = handler<AddOptionEvent, {
  options: OptionsCell;
  votes: VotesCell;
  myProfile: LunchProfileCell | undefined;
  myName: string;
  host: HostCell;
  optionDraft: DraftCell;
}>(
  (
    { title },
    { options, votes, myProfile, myName, host, optionDraft },
  ) => {
    if (!isHost(host, myProfile)) return;
    const trimmed = trimmedName(title ?? optionDraft.get());
    if (!trimmed) return;
    // Address the option by its id so later edits and removal reach it without
    // a positional index. addUnique merges concurrent adds (distinct ids) and
    // is idempotent on the id. The votes read joins the id-freshness guard
    // into this transaction's conflict set — a concurrent cast retries the add.
    const id = newOptionId(options.get(), votes.get(), myName, trimmed);
    const option = options.elementById(id);
    option.set({
      id,
      title: trimmed,
      addedByName: myName,
      imageUrl: "",
    });
    options.addUnique(option);
    optionDraft.set("");
  },
);

// Host persists the generated cuisine thumbnail (a data URL read from the
// GeneratedArt sub-pattern by the card's keep action) onto its option.
// Idempotent on the stored value, keyed-collection addressed, and admin-gated
// like every other mutation — only the host's client generates, but the gate
// holds regardless.
const setOptionImage = handler<SetOptionImageEvent, {
  options: OptionsCell;
  myProfile: LunchProfileCell | undefined;
  host: HostCell;
}>(({ optionId, imageUrl }, { options, myProfile, host }) => {
  if (!isHost(host, myProfile)) return;
  const option = options.elementById(optionId);
  const current = option.get();
  if (!current) return;
  const safe = safeImageUrl(imageUrl);
  if (!safe || trimmedName(current.imageUrl) === safe) return;
  option.key("imageUrl").set(safe);
});

const removeOption = handler<RemoveOptionEvent, {
  options: OptionsCell;
  votes: VotesCell;
  myProfile: LunchProfileCell | undefined;
  host: HostCell;
}>(({ optionId }, { options, votes, myProfile, host }) => {
  if (!isHost(host, myProfile)) return;
  const option = options.elementById(optionId);
  if (!option.get()) return;
  options.removeByValue(option);
  // Cascade: drop every vote for this option, each by its own key, so votes
  // for other options merge through. The read of the vote list this sweep
  // needs stays in the commit's conflict set, so a concurrent change to the
  // list makes this commit retry, which is what catches a vote cast for this
  // option after the read.
  for (const v of votes.get()) {
    if (v.optionId !== optionId) continue;
    const key = voteKeyFor(v.voter, optionId);
    if (key === undefined) continue;
    votes.removeByValue(votes.elementById(key));
    clearVoteEntity(votes, key);
  }
});

const castVote = handler<CastVoteEvent, {
  votes: VotesCell;
  users: UsersCell;
  myProfile: LunchProfileCell | undefined;
  nowTick: number | null;
}>(({ optionId, voteType }, { votes, users, myProfile, nowTick }) => {
  if (!myProfile) return;
  // Terminal cell for storage, and it must READ as present: at `asCell` seams
  // an absent profile arrives as a truthy empty handle, which `!myProfile`
  // cannot catch, and a pinned empty handle would store a floating identity.
  const voter = myProfile.resolveAsCell();
  if (voter.get() === undefined) return;
  // Voting is for participants. The UI only offers the control to a joined
  // viewer, but this is a public stream: a headless caller reaches it with
  // nothing but a resolved profile, and a vote from a non-member counts in
  // every tally while its caster shows as unjoined. Membership is asked of
  // the roster by profile cell, the same comparison joined-ness itself uses.
  if (!(users.get() ?? []).some((u) => equals(u.profile, voter))) return;
  // Stamp with the shared `#now/300` tick — fresh to five minutes, all a
  // day-granularity stamp needs, and it keeps the deployed source compatible
  // with Loom runtimes from before handler-scoped Date.now(). Null until the
  // wish resolves (and always on pre-#4740 runtimes, which also show no
  // votes): voting no-ops rather than reading an ambient clock.
  const now = nowTick;
  if (typeof now !== "number") return;
  // My vote for this option has a deterministic address, so this reads and
  // edits just that one vote — never the whole list. Clicking the current
  // color toggles the vote off; any other color sets it.
  const key = voteKeyFor(voter, optionId);
  if (key === undefined) return;
  const myVote = votes.elementById(key);
  const existing = myVote.get();
  // Toggle off only when the same color was cast TODAY. A same-color click on
  // a stale (hidden) vote re-casts it with a fresh timestamp instead of
  // removing a vote the voter cannot see.
  const sameColorToday = existing !== undefined &&
    existing.voteType === voteType &&
    typeof existing.castAt === "number" &&
    dayKeyOf(existing.castAt) === dayKeyOf(now);
  if (sameColorToday) {
    votes.removeByValue(myVote);
    clearVoteEntity(votes, key);
    return;
  }
  myVote.set({ voter, optionId, voteType, castAt: now });
  // Membership is the entity's presence: every path that drops a vote's link
  // clears its entity too, so a vote that reads as present is already in the
  // list. Recasting one therefore writes only that vote's own document, and
  // touches the list on the cast that first puts the vote there. The read of
  // this voter's own entity above stays a dependency, so a removal racing this
  // recast still refuses the commit, and the retry sees an absent vote and
  // adds the membership back.
  if (existing === undefined) votes.addUnique(myVote);
});

const resetVotes = handler<ResetVotesEvent, {
  votes: VotesCell;
  myProfile: LunchProfileCell | undefined;
  host: HostCell;
}>((_, { votes, myProfile, host }) => {
  if (!isHost(host, myProfile)) return;
  // Clearing the board is an intentional whole-list overwrite, so it empties
  // the list itself and reaches rows no key names. Each vote's entity is
  // cleared too, so a voter who re-casts their pre-reset color afterwards is
  // not toggled off against content the reset left behind.
  for (const v of votes.get()) {
    const key = voteKeyFor(v.voter, v.optionId);
    if (key !== undefined) clearVoteEntity(votes, key);
  }
  votes.set([]);
});

export interface ClearVoteEvent {
  optionId: string;
}

const clearMyVote = handler<ClearVoteEvent, {
  votes: VotesCell;
  myProfile: LunchProfileCell | undefined;
}>(({ optionId }, { votes, myProfile }) => {
  if (!myProfile) return;
  const voter = myProfile.resolveAsCell();
  if (voter.get() === undefined) return;
  const key = voteKeyFor(voter, optionId);
  if (key === undefined) return;
  votes.removeByValue(votes.elementById(key));
  clearVoteEntity(votes, key);
});

// Host-only, same gate as the other mutating admin actions. Logs where the
// group actually ate — by option id (resolved to its title) or a free title —
// appending an entry to the `visits` array with everyone's current vote
// snapshotted inline. Capped at the MAX_HISTORY most-recent entries (by date).
const logVisit = handler<LogVisitEvent, {
  visits: HistoryCell;
  options: OptionsCell;
  votes: VotesCell;
  users: UsersCell;
  myProfile: LunchProfileCell | undefined;
  myName: string;
  host: HostCell;
  visitDate: DraftCell;
  nowTick: number | null;
}>(
  (
    { optionId, title, wentAt },
    {
      visits,
      options,
      votes,
      users,
      myProfile,
      myName,
      host,
      visitDate,
      nowTick,
    },
  ) => {
    if (!isHost(host, myProfile) || !myProfile) return;
    // Terminal cell for storage, and it must READ as present (see castVote).
    const logger = myProfile.resolveAsCell();
    if (logger.get() === undefined) return;
    let place = trimmedName(title);
    if (!place && optionId) {
      const opt = options.get().find((o) => o.id === optionId);
      place = opt ? trimmedName(opt.title) : "";
    }
    if (!place) return;
    const fallbackNow = nowTick || 0;
    const when = typeof wentAt === "number"
      ? wentAt
      : parseVisitDate(visitDate.get(), fallbackNow);
    if (!when) return;

    // A history entry records WHO by holding their profile cell, the same
    // identity the roster and the votes use. It must not hold a `users.key(i)`
    // handle: that follows the SLOT, so removing an earlier participant would
    // silently retarget every stored attribution to the wrong person.
    const us = users.get();
    const displayNameOf = (voter: LunchProfileCell): string => {
      const entry = us.find((u) => equals(u.profile, voter));
      return entry ? entry.name : "";
    };

    // Snapshot the current live votes, embedded in the entry. Denormalize the
    // option title (options can be removed later; the title is the record).
    // Only today's votes are "current opinion": stale votes are hidden from
    // the UI, so they stay out of the snapshot too. Same day source as the
    // UI's `todaysVotes` (the shared `#now/300` tick), so the snapshot
    // captures exactly what the host is looking at, by construction. While
    // the wish is still unresolved (null `nowTick`) the board shows no votes,
    // so the snapshot stays empty for that window too.
    const nowRef = nowTick;
    const nowDay = typeof nowRef === "number" ? dayKeyOf(nowRef) : null;
    const titleById = new Map(options.get().map((o) => [o.id, o.title]));
    const voteSnapshot: VoteSnapshot[] = [];
    for (const v of votes.get()) {
      if (
        nowDay === null || v.voter === undefined ||
        typeof v.castAt !== "number" ||
        dayKeyOf(v.castAt) !== nowDay
      ) {
        // Stale (previous-day or pre-castAt) vote → not current. A legacy
        // voterless vote has no attributable snapshot either — and it also
        // has no castAt, so the day filter already excludes it.
        continue;
      }
      const optTitle = trimmedName(titleById.get(v.optionId));
      if (!optTitle) continue; // vote for an already-removed option → skip
      voteSnapshot.push({
        voter: displayNameOf(v.voter),
        voterProfile: v.voter,
        optionTitle: optTitle,
        color: v.voteType,
      });
    }

    // The id and cap both depend on the current list, so this is deliberately
    // one read-modify-write. A mergeable push would keep the explicit read in
    // the conflict set anyway and would mix an append with a whole-list trim.
    const currentVisits = visits.get();
    const entry: HistoryEntry = {
      id: newHistoryId(currentVisits, myName, place, when),
      title: place,
      loggedByName: myName,
      // The snapshot voters above come from the stored votes, so they are
      // already terminal.
      loggedBy: logger,
      wentAt: when,
      votes: voteSnapshot,
    };
    const nextVisits = [...currentVisits, entry];
    visits.set(
      nextVisits.length > MAX_HISTORY
        ? [...nextVisits]
          .sort((a, b) => b.wentAt - a.wentAt)
          .slice(0, MAX_HISTORY)
        : nextVisits,
    );

    // Reset the date draft so the next log defaults back to today.
    visitDate.set("");
  },
);

const removeHistoryEntry = handler<RemoveHistoryEntryEvent, {
  visits: HistoryCell;
  myProfile: LunchProfileCell | undefined;
  host: HostCell;
}>(({ id }, { visits, myProfile, host }) => {
  if (!isHost(host, myProfile)) return;
  // The embedded vote snapshot goes with the entry — no separate cascade.
  visits.set(visits.get().filter((v) => v.id !== id));
});

const clearHistory = handler<ClearHistoryEvent, {
  visits: HistoryCell;
  myProfile: LunchProfileCell | undefined;
  host: HostCell;
}>((_, { visits, myProfile, host }) => {
  if (!isHost(host, myProfile)) return;
  visits.set([]);
});

interface OptionTally {
  option: Option;
  green: number;
  yellow: number;
  red: number;
  voters: Array<{
    name: string;
    voteType: VoteColor;
    color: string;
    initials: string;

    /**
     * Whether this vote is the viewer's own, decided by profile cell.
     * Resolved here rather than in the view, which has only a display name
     * to compare — and two participants may share one.
     */
    isSelf: boolean;
  }>;
}

/**
 * The key a roster row and a vote's voter are indexed under, so a vote reaches
 * its row without searching the roster. The key is a hint, not an identity: it
 * is built from the entity id and path alone, so two profile cells in
 * different spaces or scopes can share one, and the `equals` comparison the
 * lookup makes is what tells them apart.
 */
const voterKey = (voter: LunchProfileCell): string | undefined => {
  const id = getEntityId(voter);
  return id === undefined ? undefined : entityRefToString(id);
};

/** Maintains linked vote groups for per-option tally consumers. */
const indexVotesByOption = pattern<
  { votes: Cell<Vote[]> },
  { index: GroupIndex<string, Vote> }
>(
  ({ votes }) => ({ index: votes.groupBy((vote) => vote.optionId) }),
);

/** Tallies one option from its maintained vote group. */
const tallyOption = (
  option: Option,
  votes: readonly Vote[],
  users: readonly User[],
  // The union the call site actually has: inside a `computed` the viewer's
  // profile arrives unwrapped, and `equals` compares either form. Narrowing
  // to the cell alone would only push a cast to the caller.
  viewer: LunchProfile | LunchProfileCell | undefined,
): OptionTally => {
  // A vote carries its voter's identity, so the display name and swatch color
  // are looked up from the roster by comparison. The roster is read once per
  // option and indexed by voter key, so a vote whose voter is on the roster
  // costs the comparisons its key narrows to. A voter who has left the roster
  // still tallies: their key names no row, so the lookup compares the whole
  // roster and they render without a name.
  const roster = users.map((u) => {
    const profile = u.profile;
    return {
      name: u.name,
      color: u.color,
      ...(profile === undefined ? {} : { profile }),
    };
  });
  const participantNames = roster.map((u) => u.name);
  const initialsByName = getInitialsByName(participantNames);
  const rosterEntryOf = indexBy(
    roster,
    (u) => u.profile === undefined ? undefined : voterKey(u.profile),
    voterKey,
    (u, voter) => u.profile !== undefined && equals(u.profile, voter),
  );
  const rosterOf = (
    voter: LunchProfileCell | undefined,
  ): (typeof roster)[number] | undefined =>
    voter === undefined ? undefined : rosterEntryOf(voter);
  // One comparison per vote. The poll addresses a vote by its voter and
  // option, so a voter holds at most one vote in the group tallied here.
  const isSelf = (voter: LunchProfileCell | undefined): boolean =>
    viewer !== undefined && voter !== undefined && equals(voter, viewer);
  let green = 0;
  let yellow = 0;
  let red = 0;
  const voters = votes.map((v) => {
    const voteType = v.voteType;
    const voter = v.voter;
    if (voteType === "green") green++;
    else if (voteType === "yellow") yellow++;
    else if (voteType === "red") red++;
    const entry = rosterOf(voter);
    const name = entry?.name ?? "";
    return {
      name,
      voteType,
      color: entry?.color ?? "#888",
      initials: initialsByName.get(name) ??
        getInitials(name, participantNames),
      isSelf: isSelf(voter),
    };
  });
  return { option, green, yellow, red, voters };
};

// 📊 Lunch stats: per-place visit count + green/yellow/red tallies, derived from
// the embedded vote snapshots. Each entry's `votes` already hold the snapshot
// taken at log time, denormalized by option title; we count only the votes cast
// FOR the visited place (`vote.optionTitle === entry.title`) so a snapshot's
// votes for OTHER options don't leak into this place's tally. Top 5 by visits
// then greens (mirrors the old SQL ORDER BY). A visit with no votes for its own
// place still counts as a visit (the LEFT JOIN semantics it replaces).
const summarizePlaces = (visits: readonly HistoryEntry[]): PlaceStat[] => {
  const byTitle = new Map<string, PlaceStat>();
  for (const entry of visits) {
    let stat = byTitle.get(entry.title);
    if (!stat) {
      stat = { title: entry.title, visits: 0, greens: 0, yellows: 0, reds: 0 };
      byTitle.set(entry.title, stat);
    }
    stat.visits += 1;
    for (const vote of entry.votes) {
      if (vote.optionTitle !== entry.title) continue; // scope to this place
      if (vote.color === "green") stat.greens += 1;
      else if (vote.color === "yellow") stat.yellows += 1;
      else if (vote.color === "red") stat.reds += 1;
    }
  }
  return [...byTitle.values()]
    .sort((a, b) => (b.visits - a.visits) || (b.greens - a.greens))
    .slice(0, 5);
};

export interface CozyPollInput {
  question?: PerSpace<string | Default<"Where should we eat?">>;
  options?: PerSpace<Option[] | Default<[]>>;
  votes?: PerSpace<Vote[] | Default<[]>>;
  users?: PerSpace<User[] | Default<[]>>;

  /** Which participant hosts the poll — the first to join, transferable. */
  host?: PerSpace<HostValue>;

  /**
   * Allocation site for the viewer-identity override slot — per-user, so ONE
   * shared piece holds a separate override per viewer (a multi-user test
   * claims two identities on the same poll). ALWAYS leave this absent: tests
   * claim identity by sending `overrideViewer`, whose handler runs in the
   * sending session's runtime and so writes the sender's own slot; a value
   * passed here would materialize under whichever user instantiates the
   * piece. Production sends nothing, so the wish path rules there.
   */
  viewer?: PerUser<ViewerOverrideValue>;
  // Durable "we went here" log; each entry embeds its own vote snapshot. Capped
  // at MAX_HISTORY most-recent entries in `logVisit`. optionDraft etc. are
  // internal form drafts, declared as local per-session cells in the pattern
  // body (parking-coordinator idiom).
  visits?: PerSpace<HistoryEntry[] | Default<[]>>;

  /**
   * Allocation site for the clock override. Leave this absent outside a test:
   * an instant written here replaces the `#now/300` wish everywhere the poll
   * reads the clock, which fixes the day the poll shows and the day every
   * later vote and visit is stamped with, for every viewer of that poll, until
   * it is cleared. A runner-owned timer writes that wish on aligned five-minute
   * boundaries, which a pattern body cannot make happen, so a test that needs
   * the poll at a chosen instant, or at two instants one tick apart, writes
   * them here. Per space rather than per user, because the day a poll runs on
   * is one day for everyone looking at it. Production leaves it absent and the
   * wish rules.
   */
  clock?: PerSpace<ClockValue>;
}

export interface CozyPollOutput {
  [NAME]: string;
  [UI]: VNode;
  question: string;
  options: readonly Option[];
  // `votes`/`voteCount` are the RAW stored list (all days); the UI displays
  // only `todaysVotes` — see the current-day filter note in the file header.
  votes: readonly Vote[];
  users: readonly User[];

  /** The host's display name, resolved from the roster ("" when unhosted). */
  hostName: string;

  /** This viewer's display name from their profile ("" before it resolves). */
  myName: string;
  userCount: number;
  optionCount: number;
  voteCount: number;
  // The current local day ("YYYY-MM-DD") that votes are filtered to; ""
  // until the `#now/300` wish resolves.
  todayDate: string;
  // Votes cast on the current day — the only votes the UI shows and tallies.
  todaysVotes: readonly Vote[];
  // Count of today's votes (what the header shows).
  todayVoteCount: number;
  historyCount: number;
  // The "Recently eaten" list — the 8 most-recent visits, newest first. Exposed
  // so tests and consumers can read the durable visit log.
  recentVisits: readonly HistoryEntry[];
  // Title of the most-recent visit ("" when empty) — a plain scalar that's the
  // most reliable signal for tests (vs. asserting on the array shape).
  mostRecentTitle: string;
  // Total number of embedded vote snapshots across all visits.
  voteHistoryCount: number;
  // The "Lunch stats" aggregate (per-place visit + green/yellow/red tallies of
  // votes cast for that place). Exposed so tests/consumers can read it.
  placeStats: readonly PlaceStat[];
  isJoined: boolean;
  isAdmin: boolean;

  /**
   * Why this viewer's last join attempt was rejected, or "" — the join
   * gate's loud counterpart. The deploy doc's CLI smoke test reads this.
   */
  joinMessage: string;
  joinAs: Stream<JoinEvent>;
  claimHost: Stream<ClaimHostEvent>;

  /** Test seam: claim this viewer's identity (see the handler's doc). */
  overrideViewer: Stream<ViewerOverride>;
  addOption: Stream<AddOptionEvent>;
  removeOption: Stream<RemoveOptionEvent>;
  castVote: Stream<CastVoteEvent>;
  clearMyVote: Stream<ClearVoteEvent>;
  resetVotes: Stream<ResetVotesEvent>;
  setOptionImage: Stream<SetOptionImageEvent>;
  logVisit: Stream<LogVisitEvent>;
  removeHistoryEntry: Stream<RemoveHistoryEntryEvent>;
  clearHistory: Stream<ClearHistoryEvent>;
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
      host,
      viewer,
      visits,
      clock,
    },
  ) => {
    // Internal per-session form drafts — local to each browser session,
    // not exposed as pattern inputs. Uses the scoped-constructor idiom
    // introduced by parking-coordinator (PR #3610).
    const optionDraft = Writable.perSession.of<string>("");
    // Host's backdate field for "we went here" — a "YYYY-MM-DD" draft, blank
    // means today. Per-session like the other form drafts.
    const visitDate = Writable.perSession.of<string>("");
    // The clock the poll runs on — the interval `#now/300` wish: the
    // runtime's shared per-space tick, coarsened to five minutes, written
    // immediately on subscribe (and refreshed on reload), then advanced on
    // aligned boundaries by a runner-owned timer (builtins/wish.ts). Five
    // minutes is plenty for day-granularity stamps and keeps tick writes
    // negligible. Deliberately NOT the bare one-shot `#now`: that wish
    // durably captures the piece's FIRST-EVER load time and never advances
    // again, which would freeze the current-day filter (and every new
    // `castAt`) at the poll's birth day. The body cannot read the ambient
    // clock, so `nowTick` reads null until the wish resolves — and forever on
    // pre-#4740 runtimes, which lack `#now` — and every downstream read
    // guards that window (an empty vote view, a placeholder date, and vote /
    // visit handlers that no-op).
    // The `clock` input stands in front of the wish so a test can put the poll
    // at a chosen instant. It carries no instant in production, and the wish
    // rules there.
    const nowTickWish = wish<number>({ query: "#now/300" });
    const nowTick = computed(() => clock.at ?? nowTickWish.result ?? null);
    // Two-step confirmation for destructive actions. Stores the optionId
    // pending remove-confirm (null or undefined = nothing pending). Same idiom as
    // parking-coordinator's `removePersonConfirmTarget`.
    const removeConfirmTarget = Writable.perSession.of<
      string | null | undefined
    >(null);
    const resetConfirmPending = Writable.perSession.of<boolean>(false);
    const clearHistoryConfirmPending = Writable.perSession.of<boolean>(false);
    // Resolve the viewer's shared profile at the TOP LEVEL, per the
    // shared-profile-rosters spec (docs/specs/shared-profile-rosters.md): the
    // `#profile` cell is the stable identity (badge + `equals()` dedup), and
    // `#profileName` / `#profileAvatar` are the display strings. Simple schema
    // on purpose — a rich schema fails to resolve the cross-space result. The
    // claimed override (tests) takes precedence over the wish cell. These pass
    // DOWN into the identity card; the card no longer wishes for itself, so
    // resolution happens in this piece's top-level context where it works.
    const profileWish = wish<LunchProfile>({ query: "#profile" });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
    // The override cell when a test has claimed an identity, else the resolved
    // wish. The predicate gates on the claim's NAME STRING, never on the
    // profile cell: a presence test on a cell-typed field lowers to an
    // `asCell` lift binding, where an ABSENT field reads as a present-but-
    // empty cell handle — truthy — so `viewer.profile !== undefined` was TRUE
    // on an empty slot, parking every browser viewer on the empty override
    // path instead of the wish (stored floating aliases; badges stuck on
    // "Unknown profile"). Strings lower as values and are honestly "" when
    // unset; the seam's contract is that a claim always carries a name. The
    // ternary lowers to a reactive ifElse, so production (which never sends
    // the override) stays on the wish, and a test's claim takes effect when
    // written. Profile-backed rendering is verified at the browser tier (the
    // scrabble/battleship precedent).
    const hasViewerOverride = computed(() =>
      trimmedName(viewer.name ?? "") !== ""
    );
    const viewerProfileCell = hasViewerOverride
      ? viewer.profile
      : profileWish.result;
    // Strings, unlike cells, are honestly absent when unset, so `??` is safe.
    const viewerProfileName = computed(() =>
      trimmedName(viewer.name ?? profileNameWish.result ?? "")
    );
    const viewerProfileAvatar = computed(() =>
      (viewer.avatar ?? profileAvatarWish.result ?? "").trim()
    );
    // Who this viewer is in THIS poll: their roster entry, found by comparing
    // profile cells. Derived, never stored per-user — so a viewer is recognised
    // on any device the moment their profile resolves, and no per-user state
    // can go stale and lock them out.
    const myEntry = computed(() => {
      const mine = viewerProfileCell;
      if (!mine) return undefined;
      return users.find((u: User) => equals(u.profile, mine));
    });
    const isJoined = computed(() => myEntry !== undefined);
    const isAdmin = computed(() => {
      const mine = viewerProfileCell;
      const current = host.profile;
      if (!mine || current === undefined) return false;
      return equals(current, mine);
    });
    // The host's display name is resolved from the roster, so a rename shows up
    // everywhere at once instead of stranding a stale copy.
    const hostName = computed(() => {
      const current = host.profile;
      if (current === undefined) return "";
      const entry = users.find((u: User) => equals(u.profile, current));
      return entry ? entry.name : "";
    });
    const participantIdentity = ParticipantIdentityCard({
      users,
      host,
      profile: viewerProfileCell,
      profileName: viewerProfileName,
      profileAvatar: viewerProfileAvatar,
      profileSetupUI: profileWish[UI],
    });
    const boundOverrideViewer = overrideViewer({ viewer });
    const boundAddOption = addOption({
      options,
      votes,
      myProfile: viewerProfileCell,
      myName: viewerProfileName,
      host,
      optionDraft,
    });
    const boundRemoveOption = removeOption({
      options,
      votes,
      myProfile: viewerProfileCell,
      host,
    });
    const boundCastVote = castVote({
      votes,
      users,
      myProfile: viewerProfileCell,
      nowTick,
    });
    const boundSetOptionImage = setOptionImage({
      options,
      myProfile: viewerProfileCell,
      host,
    });
    const boundClearMyVote = clearMyVote({
      votes,
      myProfile: viewerProfileCell,
    });
    const boundResetVotes = resetVotes({
      votes,
      myProfile: viewerProfileCell,
      host,
    });
    const boundLogVisit = logVisit({
      visits,
      options,
      votes,
      users,
      myProfile: viewerProfileCell,
      myName: viewerProfileName,
      host,
      visitDate,
      nowTick,
    });
    const boundRemoveHistoryEntry = removeHistoryEntry({
      visits,
      myProfile: viewerProfileCell,
      host,
    });
    const boundClearHistory = clearHistory({
      visits,
      myProfile: viewerProfileCell,
      host,
    });
    const userCount = users.length;
    const optionCount = options.length;
    const voteCount = votes.length;
    // Current-day filter: the UI only shows votes cast on the current day
    // (local calendar), per the shared tick. While `#now/300` is still
    // resolving, the day key reads "" and the current-day vote set is empty.
    // The filter is keyed on the day, so a tick that advances within one day
    // leaves the key equal and the vote set is not recomputed. Keying it on the
    // tick itself would rescan every vote every five minutes.
    const todayKey = computed(() =>
      typeof nowTick === "number" ? dayKeyOf(nowTick) : ""
    );
    // The scan reads the day key rather than the tick, so it runs when the
    // day changes rather than on every tick within a day.
    const todaysVotes = computed(() => {
      const key = todayKey;
      if (!key) return EMPTY_VOTES;
      return votes.filter((v) =>
        typeof v.castAt === "number" && dayKeyOf(v.castAt) === key
      );
    });
    const todayVoteCount = computed(() => todaysVotes.length);
    // The visit log newest first, sorted once for every reader below.
    const newestFirstVisits = computed(() =>
      [...visits].sort((a, b) => b.wentAt - a.wentAt)
    );
    // The "Recently eaten" card: the 8 most-recent visits. An array-shaped
    // computed (not a lift-returned VNode) is what lets the card keep its
    // plain-JSX `.map(...)` with interactive onClick delete buttons — those
    // must NOT live inside a lift (they'd mis-lower as "$event in inputs" / a
    // non-idempotent write).
    const recentVisits = computed(() => newestFirstVisits.slice(0, 8));
    // Total visit count + "is there any history?" — derived directly from the
    // array, so they always agree (no two queries settling independently).
    const historyCount = visits.length;
    const hasHistory = computed(() => visits.length > 0);
    const mostRecentTitle = computed(() => newestFirstVisits[0]?.title ?? "");
    // 📊 Lunch stats — per-place visit + green/yellow/red tallies from the
    // embedded vote snapshots (see summarizePlaces for the per-place scoping).
    const placeStats = computed(() => summarizePlaces(visits));
    // Total embedded vote snapshots across all visits.
    const voteHistoryCount = computed(() =>
      visits.reduce((n, v) => n + v.votes.length, 0)
    );
    // The viewer's display name, resolved from their STORED roster entry so a
    // The viewer's own roster entry as a 0-or-1 array: the header chip renders
    // it with a plain static map, which keeps the `$profile` binding free of
    // conditionals (a `$`-binding inside an authored computed blanks the
    // render — pattern-critique-guide §5).
    const viewerEntries = computed((): readonly User[] => {
      const mine = viewerProfileCell;
      if (!mine) return EMPTY_USERS;
      return users.filter((u: User) => equals(u.profile, mine));
    });
    // Hoisted booleans for the JSX ternaries below (the file's reset-confirm
    // idiom): conditions in JSX stay bare computed refs.
    const hasParticipants = computed(() => users.length > 0);
    // Hoist a boolean cell for the reset-confirm JSX ternary so TS doesn't
    // narrow `resetConfirmPending` itself and lose the `.set` method in
    // the false branch.
    const isResetConfirm = computed(() => resetConfirmPending.get());
    const isClearHistoryConfirm = computed(() =>
      clearHistoryConfirmPending.get()
    );
    // Rank from today's votes only — the tallies, swatches, and top choice all
    // reflect the current day.
    const votesByOption = indexVotesByOption({ votes: todaysVotes });
    const optionTallies = options.map((option) => {
      const optionVotes = votesByOption.index.lookup(option.id);
      return computed(() =>
        tallyOption(option, optionVotes, users, viewerProfileCell)
      );
    });
    const ranked = computed(() =>
      [...optionTallies].sort((a, b) => (a.red - b.red) || (b.green - a.green))
    );

    const topChoice = todayVoteCount > 0 && ranked.length > 0
      ? ranked[0]
      : null;

    return {
      [NAME]: "Cozy lunch poll",
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
                    const v = todayVoteCount ?? 0;
                    const todayLabel = typeof nowTick === "number"
                      ? dayLabelOf(nowTick)
                      : "…";
                    const admin = hostName;
                    const joined = isJoined;
                    const amAdmin = isAdmin;
                    // "you are the host" is handled by the HOST chip in the
                    // top right; only call out the host's name to non-admins.
                    const hostNote = !amAdmin && joined && admin !== ""
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
                        <span
                          data-poll-today
                          style={{ fontWeight: 600, color: "#374151" }}
                        >
                          📅 {todayLabel}
                        </span>{" "}
                        · {u} joined · {o} options · {v} votes today{hostNote}
                      </div>
                    );
                  })}
                  {hasParticipants
                    ? (
                      <div
                        data-participants-strip
                        style={{
                          marginTop: "8px",
                          display: "flex",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: "6px",
                        }}
                      >
                        {
                          /* Every profile-backed participant renders from
                            their STORED live cell (the canonical-roster
                            idiom, multi-user-patterns.md#presenting-identity).
                            A row written before the space had profiles holds
                            no cell to bind, and renders the name it stored
                            rather than "Unknown profile". Static maps on
                            purpose — `$profile` bindings cannot live inside
                            the tally computed below. These badges navigate;
                            only the viewer's own chip is noNavigate. */
                        }
                        {users.map((entry: User) => (
                          <cf-profile-badge
                            variant="chip"
                            size="sm"
                            $profile={entry.profile}
                            fallback-name={entry.name}
                            data-participant-badge={entry.name}
                          />
                        ))}
                      </div>
                    )
                    : null}
                </div>
                {
                  /* Static JSX only in this cluster: the viewer badge carries
                    a `$profile` binding, and a `$`-binding inside an authored
                    `computed(() => …)` VNode is materialized by the lift and
                    blanks the whole render (pattern-critique-guide §5). JSX
                    ternaries compile to static-branch `ifElse`, the safe
                    conditional shape at a `$`-binding position. */
                }
                {isJoined
                  ? (
                    <div
                      style={{
                        display: "flex",
                        gap: "6px",
                        alignItems: "center",
                      }}
                    >
                      {isAdmin
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
                      {
                        /* The viewer's chip binds the STORED directory entry
                          (never the live `#profile` wish), so a profile
                          switch after joining keeps the joined identity.
                          `viewerEntries` is pre-filtered to 0-or-1 entries, so
                          this map stays conditional-free at the binding. */
                      }
                      {viewerEntries.map((entry: User) => (
                        <cf-profile-badge
                          variant="chip"
                          size="sm"
                          $profile={entry.profile}
                          noNavigate
                          data-viewer-badge
                        />
                      ))}
                    </div>
                  )
                  : null}
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
                {
                  /* Always-on live self-badge, at the TOP LEVEL co-located with
                    the `#profile` wish — the profile-roster-live-demo idiom. A
                    `<cf-profile-badge>` rendered here keeps the viewer's profile
                    pattern running in this runtime, which is what materializes
                    the cross-space profile so EVERY badge (this one, the header
                    viewer chip, and the participants strip's stored-cell badges)
                    resolves instead of falling back to "Unknown profile", and it
                    reliably primes the `#profileName` string the join label and
                    roster snapshot read. A badge rendered inside the identity
                    sub-pattern does NOT achieve this — it must be top-level.
                    Static JSX position: the `$profile` binding must not sit
                    inside an authored `computed(() => …)` VNode. */
                }
                <div
                  data-viewer-self-badge
                  style={{ marginBottom: "12px" }}
                >
                  <cf-profile-badge
                    variant="chip"
                    size="sm"
                    $profile={viewerProfileCell}
                    noNavigate
                  />
                </div>
                {participantIdentity[UI]}

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
                {options.length > 0
                  ? (
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
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "4px",
                        }}
                      >
                        {ranked.map((tally) => (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              padding: "6px 10px",
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
                              {tally.voters.map((voter) => (
                                <span
                                  title={voter.name}
                                  role="img"
                                  aria-label={`${voter.name}: ${voter.voteType} vote`}
                                  data-vote-swatch-name={voter.name}
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    minWidth: "22px",
                                    height: "22px",
                                    padding: "0 6px",
                                    borderRadius: "9999px",
                                    backgroundColor:
                                      VOTE_SWATCH[voter.voteType],
                                    color: "white",
                                    fontSize: "11px",
                                    fontWeight: 700,
                                    boxShadow: voter.isSelf
                                      ? "0 0 0 2px white, 0 0 0 3px #111827"
                                      : "none",
                                  }}
                                >
                                  {voter.initials}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                  : null}

                {/* Empty state */}
                {computed(() => {
                  if (options && options.length > 0) return null;
                  const admin = hostName;
                  const hint = isAdmin
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
                      <div
                        style={{
                          fontSize: "32px",
                          marginBottom: "8px",
                        }}
                      >
                        🍽️
                      </div>
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
                  // Touch the full option shape here so the mapWithPattern
                  // element schema includes every field the child reads.
                  const cardOption: Option = {
                    id: option.id,
                    title: option.title,
                    addedByName: option.addedByName,
                    ...(option.imageUrl === undefined
                      ? {}
                      : { imageUrl: option.imageUrl }),
                  };
                  const rank = computed(() => {
                    const idx = ranked.findIndex(
                      (t) => t.option.id === oid,
                    );
                    return idx >= 0 ? idx + 1 : undefined;
                  });
                  return (
                    <PollOptionCard
                      option={cardOption}
                      rank={rank}
                      viewerProfile={viewerProfileCell}
                      isJoined={isJoined}
                      isAdmin={isAdmin}
                      votes={todaysVotes}
                      removeConfirmTarget={removeConfirmTarget}
                      castVote={boundCastVote}
                      removeOption={boundRemoveOption}
                      logVisit={boundLogVisit}
                      setOptionImage={boundSetOptionImage}
                    />
                  );
                })}

                {
                  /* Recently eaten — the visit log, shown below the options.
                  Everyone sees it; the host can delete a single mistaken entry
                  (✕) or clear the whole log. Plain JSX with derived-boolean
                  ternaries (the host-controls idiom), NOT a computed-returned
                  VNode, so the interactive onClick handlers lower as handlers
                  rather than lifts ("$event in inputs" / non-idempotent trap). */
                }
                {hasHistory
                  ? (
                    <div
                      style={{
                        marginBottom: "16px",
                        padding: "12px 16px",
                        backgroundColor: "#fdf6ec",
                        border: "1px solid #f0e0c8",
                        borderRadius: "8px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                          marginBottom: "10px",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "11px",
                            fontWeight: 700,
                            letterSpacing: "0.05em",
                            textTransform: "uppercase",
                            color: "#92702a",
                          }}
                        >
                          🗓 Recently eaten
                        </div>
                        {isAdmin
                          ? (isClearHistoryConfirm
                            ? (
                              <span
                                style={{
                                  display: "inline-flex",
                                  gap: "6px",
                                  alignItems: "center",
                                }}
                              >
                                <cf-button
                                  size="sm"
                                  variant="primary"
                                  onClick={() => {
                                    boundClearHistory.send({});
                                    clearHistoryConfirmPending.set(false);
                                  }}
                                >
                                  Clear all
                                </cf-button>
                                <cf-button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    clearHistoryConfirmPending.set(false)}
                                >
                                  Cancel
                                </cf-button>
                              </span>
                            )
                            : (
                              <button
                                type="button"
                                aria-label="Clear all history (host)"
                                style={{
                                  background: "none",
                                  border: "none",
                                  padding: 0,
                                  color: "#b08642",
                                  fontSize: "11px",
                                  textDecoration: "underline",
                                  cursor: "pointer",
                                }}
                                onClick={() =>
                                  clearHistoryConfirmPending.set(true)}
                              >
                                clear all
                              </button>
                            ))
                          : null}
                      </div>
                      {recentVisits.map((entry) => {
                        const entryId = entry.id;
                        return (
                          <div
                            data-recent-visit-title={entry.title}
                            style={{
                              display: "flex",
                              alignItems: "baseline",
                              justifyContent: "space-between",
                              gap: "8px",
                              padding: "4px 0",
                              fontSize: "13px",
                              color: "#5b4a2c",
                            }}
                          >
                            <span style={{ fontWeight: 500 }}>
                              {entry.title}
                            </span>
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "baseline",
                                gap: "8px",
                              }}
                            >
                              <span
                                style={{ fontSize: "12px", color: "#a08552" }}
                              >
                                {visitLabel(entry.wentAt)}
                              </span>
                              {isAdmin
                                ? (
                                  <button
                                    type="button"
                                    aria-label="Delete this visit (host)"
                                    title="We didn't actually eat there"
                                    style={{
                                      background: "none",
                                      border: "none",
                                      padding: 0,
                                      color: "#b08642",
                                      fontSize: "13px",
                                      lineHeight: 1,
                                      cursor: "pointer",
                                    }}
                                    onClick={() =>
                                      boundRemoveHistoryEntry.send({
                                        id: entryId,
                                      })}
                                  >
                                    ✕
                                  </button>
                                )
                                : null}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )
                  : null}

                {
                  /* Lunch stats — a read-only recap from the embedded vote
                  snapshots: per-place visit count + how the group leaned
                  (greens / reds) across every logged visit. Shown to everyone
                  whenever there's any history. No interactive handlers, so the
                  whole-array `.map` is plain and free of the lift hazard the
                  "Recently eaten" card has to dodge. */
                }
                {hasHistory
                  ? (
                    <div
                      style={{
                        marginBottom: "16px",
                        padding: "12px 16px",
                        backgroundColor: "#f3f0fb",
                        border: "1px solid #ddd2f0",
                        borderRadius: "8px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                          color: "#5b3fa3",
                          marginBottom: "10px",
                        }}
                      >
                        📊 Lunch stats
                      </div>
                      {placeStats.map((stat) => (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            justifyContent: "space-between",
                            gap: "8px",
                            padding: "4px 0",
                            fontSize: "13px",
                            color: "#473266",
                          }}
                        >
                          <span style={{ fontWeight: 500 }}>{stat.title}</span>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "baseline",
                              gap: "10px",
                              fontSize: "12px",
                            }}
                          >
                            <span style={{ color: "#8a7bb0" }}>
                              {stat.visits}×
                            </span>
                            <span style={{ color: "#2f8a64" }}>
                              🟢 {stat.greens}
                            </span>
                            <span style={{ color: "#b27722" }}>
                              🟡 {stat.yellows}
                            </span>
                            <span style={{ color: "#a33b35" }}>
                              🔴 {stat.reds}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                  : null}

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
                          id="lp-add-option-input"
                          $value={optionDraft}
                          placeholder="Add an option (e.g. Sushi place)…"
                          aria-label="Option title"
                          timing-strategy="immediate"
                          style="flex:1"
                        />
                        <cf-button
                          id="lp-add-option-button"
                          aria-label="Add option"
                          onClick={boundAddOption}
                        >
                          Add
                        </cf-button>
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
                      {
                        /* Backdates the next "✓ we went here" you click on an
                        option above. Blank = today; cleared after each log. */
                      }
                      <div
                        style={{
                          marginTop: "8px",
                          display: "flex",
                          gap: "8px",
                          alignItems: "center",
                          flexWrap: "wrap",
                          fontSize: "12px",
                          color: "#1e40af",
                        }}
                      >
                        <span>Date for "✓ we went here":</span>
                        <cf-input
                          type="date"
                          $value={visitDate}
                          aria-label="Visit date (blank = today)"
                          timing-strategy="immediate"
                        />
                        <span style={{ color: "#64748b" }}>
                          (blank = today)
                        </span>
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
      // constants keep the fallback idempotent across recomputes). The visit
      // history lives in the `visits` PerSpace input and is surfaced here via
      // the derived `recentVisits`/`mostRecentTitle` below, not as a raw cell.
      options: computed(() => options ?? EMPTY_OPTIONS),
      votes: computed(() => votes ?? EMPTY_VOTES),
      users: computed(() => users ?? EMPTY_USERS),
      hostName,
      myName: viewerProfileName,
      userCount,
      optionCount,
      voteCount,
      todayDate: todayKey,
      todaysVotes,
      todayVoteCount,
      historyCount,
      recentVisits,
      mostRecentTitle,
      voteHistoryCount,
      placeStats,
      isJoined,
      isAdmin,
      joinMessage: participantIdentity.joinMessage,
      joinAs: participantIdentity.joinAs,
      claimHost: participantIdentity.claimHost,
      overrideViewer: boundOverrideViewer,
      addOption: boundAddOption,
      removeOption: boundRemoveOption,
      castVote: boundCastVote,
      clearMyVote: boundClearMyVote,
      resetVotes: boundResetVotes,
      setOptionImage: boundSetOptionImage,
      logVisit: boundLogVisit,
      removeHistoryEntry: boundRemoveHistoryEntry,
      clearHistory: boundClearHistory,
    };
  },
);
