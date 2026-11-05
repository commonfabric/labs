# Lunch Coordinator: roadmap

`lunch-poll` started life as a collaborative "where should we eat?" poll (🟢
love it / 🟡 OK / 🔴 veto, fewest-reds-wins). The next evolution turns it into a
full **Lunch Coordinator** — the poll stays at the core, but it grows the
context a group actually needs to pick a place and go.

This doc separates shipped work from the remaining backlog so the roadmap stays
useful as the pattern evolves.

## Todo work

### 1. Per-option vote-history recap

Show a compact per-option history such as "last N times we did X: 🟢🟢🟡". This
likely needs a per-option query inside `options.map`, so it was deferred from
the durable vote-history snapshot work.

### 2. People's favorite foods

Let each participant record favorite foods / cuisines / dietary constraints on
their profile (per-user, in the space directory).

- Extend the `User` profile with `favorites: string[]` and
  `restrictions: string[]` (vegetarian, allergies, etc.).
- When an option is added, highlight whose favorites it matches and warn about
  restriction conflicts.
- Feeds future ranking/suggestion logic.

### 3. Calendar integration

Tie the poll to an actual lunch slot so coordination is real, not hypothetical.

- Read the group's availability / a shared lunch event from a calendar source.
- Show the target time alongside the poll; auto-close voting before that time.
- Optionally write the chosen place back as a calendar event with the location.

### 4. Map view

Show the candidate options on a map so distance and clustering are visible.

- Geocode each option (address / place name → lat-long).
- Render a map with pins for each option, colored by current vote standing.
- Show walking time / distance from a configurable origin (office).

### 5. Explorer mode

A discovery mode for when the group is bored of the usual rotation.

- Suggest nearby places the group hasn't tried (cross-reference the history log
  and the map).
- Pull in candidates by cuisine that match people's favorites.
- One-tap "add this as an option" from a suggestion into the live poll.

### 6. Open/closed days per location

Track which days of the week each place is closed (or open) so a location that's
shut today never even shows up as a votable option. Almost every spot in a real
rotation is dark at least one work day, and nothing's more deflating than the
poll picking a place that's closed when you walk over.

- Add a per-option `closedDays` field (e.g. a set of weekday indices, or
  `hours: PerWeekday<{ open, close } | "closed">` if we want open/close times
  later). Editable host-side when an option is added or via a per-option editor.
- Filter the live ballot by the **current weekday**: an option closed today is
  hidden from voting (or shown grayed-out and non-votable, "closed Mondays").
  Derive the weekday in a handler-fed cell, not inside a `computed`/`derive` —
  reading the clock in a derive is non-idempotent (same lesson as the history
  visit labels in feature #1).
- Keep hidden options in the data so they reappear automatically on a day
  they're open; don't delete them.
- Plays well with feature #3 (calendar): the target lunch slot's date decides
  which weekday we filter on, so a poll scheduled for tomorrow can already drop
  places closed tomorrow.

## Notes

- These features should layer on top of the existing profile-cell identity model
  (`users` per-space roster, the viewer's shared `#profile`, a per-space `host`
  profile pointer, and derived `isAdmin`). See
  [`ADMIN-FUTURE.md`](./ADMIN-FUTURE.md) for the planned move from pattern-level
  admin checks to CFC integrity claims — favorites and history writes are good
  candidates for the same authorship-claim treatment.
- Map, calendar, and explorer mode all imply external data sources; sequence
  those after local-only features that need no new capabilities.

## Completed work

Completed entries are ordered newest first. Dates use the local merge/commit
date for the completed work.

### 2026-07-22 — Restored host-side generated cuisine art (#4920)

Restored `generated-art.tsx` as a host-only browser request. The host may keep
the result on an option; once persisted, every viewer renders that stored image
instead of generating another one. Focused generated-art and persistence tests
cover the request and synchronization paths.

### 2026-07-12 — Day-scoped votes (#4661)

Votes now carry a `castAt` stamp; tallies, swatches, top choice, the header
count, and `logVisit` snapshots show only votes cast on the viewing session's
current local day. Older votes stay stored but hidden, and a same-color click on
a stale vote re-casts it rather than toggling off an invisible one. "Today" is
the pattern-body clock read, refreshed by a `PerSession` cell so a tab that
crosses midnight snaps forward on the next interaction.

### 2026-07-08 — Profile-first join with free-text fallback (#4597)

The join surface now leads with the viewer's shared profile: when `#profileName`
resolves it offers a one-click "Join as \<name\>" (carrying the profile name and
avatar), with "Use a different name" as an escape hatch. The manual "Your name…"
input is the fallback, shown only when no profile resolves. No change to the
`joinAs` handler or the pattern's inputs/outputs — purely which control the join
card offers first.

Superseded by the 2026-08 profile-cell identity migration: joining now requires
a resolved shared profile and the free-text escape hatch is gone. The empty
state renders the profile create/pick surface instead.

### 2026-06-23 — Removed generated cuisine-image and web-search homepage (#4325/#4326)

Dropped the then-current generated food thumbnail and the web-search homepage
enrichment, along with the per-option AI work they drove: image generation, web
search, `generateText` homepage verification, and the 30s mutex that serialized
them. Cold-load cost of a many-option poll became graph/runtime only. `city` and
`webSearchUrl` remain retired; generated cuisine art later returned in #4920 as
the narrower, host-only persisted flow above.

### 2026-06-16 — Pattern composition refactor and sub-pattern standards

The lunch poll now exercises pattern-to-pattern composition by factoring the
largest UI-bearing pieces out of `main.tsx` into sibling pattern modules:

- ✅ `generated-art.tsx`: fallback-backed generated food thumbnail. It exposes
  `[UI]`, `url`, and `fetchState`; callers can render it as JSX when they only
  need UI, or instantiate by function call when they need the generated URL.
- ✅ `poll-option-card.tsx`: one ranked restaurant option row, including vote
  buttons, vote-state styling, homepage display/edit/lookup, host-only
  remove/history actions, and generated-art persistence.
- ✅ `participant-identity-card.tsx`: join/admin identity surface. It exposes
  `isJoined`, `isAdmin`, `joinMessage`, `joinAs`, and `claimHost` for the parent
  to use when gating add-option controls, per-option voting, and host-only
  actions.

Standards established by this factoring:

- Each UI-bearing sub-pattern is its own module with `export default pattern`
  and exported `Input`/`Output` interfaces.
- Public contracts include `[NAME]` and static `[UI]: VNode`; `[UI]` is never
  wrapped in `computed`.
- The parent owns durable/shared state (`PerSpace`/`PerUser`/`PerSession` cells)
  and passes cells or resolved values down. Children may own only local
  per-session UI state.
- Use JSX instantiation when only embedding a child's UI; use function-call
  instantiation when the parent reads child outputs or streams.
- Field names are exact composition contracts, not auto-mapped. Imports are
  direct sibling imports, not barrel exports.
- Each factored pattern has an overview comment plus documented `Input` and
  `Output` fields so future consumers can evaluate functionality and contract.
- Focused pattern tests are part of the contract for non-trivial sub-patterns:
  test the public outputs, streams, and rendered states that would otherwise
  regress silently. Very small render-only wrappers can stay covered by parent
  or integration checks when a direct test would only assert VNode plumbing.

Gotchas preserved during extraction:

- The viewer's profile cell is resolved once in `main.tsx` before
  `options.map(...)`; per-option children receive that identity value, not a
  display name or raw scoped cell.
- The generated-art fallback remains a static CSS `background-image`; generated
  or stored `<img>` content is only overlaid once a safe non-empty URL resolves.

Verification added or run for this work:

- Focused tests for `poll-option-card.tsx` and `participant-identity-card.tsx`.
- Existing `main.test.tsx`, `multi-user.test.tsx`, and lunch-stats coverage kept
  green.
- Deployed locally to Toolshed and manually verified that the composed pattern
  loads and the extracted UI still runs.

### 2026-06-15 — "Last days we went" history

Keep a per-space log of where the group actually ended up eating, with dates, so
nobody suggests the same place three days running.

- ✅ Stored in a **`PerSpace<HistoryEntry[]>` array** (the `visits` input),
  capped at the most-recent `MAX_HISTORY` (200) entries by date. Each entry is
  `{ id, title, loggedByName (frozen), loggedBy (shared profile cell), wentAt,
  votes }`.
  Appended via the host-only `logVisit` (`visits.push`, then a cap-trim only on
  overflow). Each option still has a "✓ we went here" button.
  - History was briefly on a **SQLite `visits` table** (#4144/#4145, the team's
    first dogfood of the SQLite builtins, #3776/#3848). It surfaced real builtin
    bugs (below), but SQLite wasn't the right fit for a small in-cell collection
    — it's now back on plain fabric storage.
- ✅ **Backdating:** a host "Log 'we went here' as of:" date field (blank =
  today) backdates the entry; `logVisit` also accepts an explicit `wentAt`. The
  date draft clears after each log so it defaults back to today.
- ✅ **Editing:** `removeHistoryEntry({ id })` (a `visits.set(filter)`) drops a
  single mistaken entry via a per-row ✕; `clearHistory` (two-step confirm)
  empties the log (`visits.set([])`). Both host-only. The embedded vote snapshot
  goes with the entry — no separate cascade to keep aligned.
- ✅ Shown as a **"Recently eaten" list below the options** (8 most recent,
  newest first), a `computed` over `visits` rendered with the plain-JSX `.map`
  idiom, labeled with each visit's own date ("Tuesday, May 20").
- Implementation notes (hard-won):
  - Visit labels derive **only from the stored `wentAt`**, never from the
    current clock — `Date.now()` inside a `derive`/`computed` is non-idempotent
    and throws (it belongs in handlers, like the backdate parse).
  - Interactive `onClick` handlers must live in **plain-ternary JSX**, not
    inside a `computed/lift`-returned VNode, or they mis-lower as lifts
    (`$event in inputs`). `recentVisits` is an array-shaped `computed`, so the
    plain-JSX `.map` (where the handlers live) is preserved unchanged.
  - The SQLite era surfaced real builtin bugs, kept here as history (the
    fabric-array model has none of them): the `@db/sqlite` binding truncated
    bound JS numbers to 32 bits (worked around with TEXT-encoded timestamps);
    `reactOn: db` left queries stale after writes in the test runner (worked
    around with a `sqliteRev` write-counter); async query flushes landed after
    the light settle (needed `{ settle: true }` test steps); and a
    deployed-piece "invalid database handle" dispatch race (resolved by runtime
    PR #3967).

### 2026-06-15 — Durable vote-history snapshot

When the host logs a visit, snapshot **who voted what** at that moment, embedded
in the entry's `votes` list. Live voting stays on the in-cell `votes` array —
the log keeps its own frozen copy.

- ✅ Each entry's `votes` is
  `{ voter (frozen), voterProfile (shared profile cell),
  optionTitle (denormalized), color }[]`.
  `logVisit` loops the current votes and embeds one snapshot each (option title
  denormalized so the snapshot survives the option being removed).
- ✅ Surfaced as a read-only **"📊 Lunch stats"** card (the `summarizePlaces`
  group-by `computed`): per-place visit count + green/yellow/red tallies across
  the whole record, scoped to the votes cast for each visited place.
