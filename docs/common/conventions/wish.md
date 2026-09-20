<!-- @reviewed 2026-02-06 wish-result-shape -->

# wish()

`wish()` discovers and connects to other pieces at runtime. It searches
favorites, mentionables, and profile elements by tag, and returns a reactive
`WishState<T>`.

These are explicit discovery collections, not an index of every stored piece.
They can expose pieces outside the space's registry, but they cannot find an
orphan that was never published and is not reachable from a known piece. See
[Finding Pieces](../concepts/piece-discovery.md).

```tsx
// Shown inside a pattern body.
const wishResult = wish<{ content: string }>({ query: "#note" });
```

## Result Shape

`wish()` returns a `WishState<T>` with the following properties:

| Property     | Type    | Description                                           |
|--------------|---------|-------------------------------------------------------|
| `result`     | `T`     | The resolved piece (auto-confirmed or user-selected)  |
| `candidates` | `T[]`   | All matching pieces                                   |
| `[UI]?`      | `VNode` | Built-in UI: picker (multiple matches) or result cell |
| `error`      | `any`   | Error message if resolution failed                    |

Access the resolved piece via `wishResult.result`:

```tsx
// Shown for illustration only.
const wishResult = wish<{ content: string }>({ query: "#note" });

// Read a property from the resolved piece
const text = wishResult.result.content;

// Render the resolved piece's own UI
return { [UI]: <div>{wishResult.result}</div> };
```

### Single match auto-confirms

When exactly one piece matches, `result` is set immediately with no picker
shown. The `candidates` array will contain that single item.

### Multiple matches show a picker

When multiple pieces match, a picker UI is rendered via `wishResult[UI]`. The
user browses candidates and clicks "Confirm Selection". Until confirmed,
`result` reactively reflects the currently highlighted candidate.

> **Exception — well-known profile targets.** `wish({ query: "#profile" })` does
> _not_ follow the "result reflects the highlighted candidate" rule. Its
> `.result` is **the single current profile** (default → MRU → first) in every
> mode once profile data is loaded and a profile exists. The picker there is
> only a switching affordance. Selecting a profile changes `.result` by
> reordering candidates (MRU/default writes), not by
> a confirm gesture. See [Well-Known Profile Targets](#well-known-profile-targets)
> (CT-1829). Generalizing this "single-best by default; picker opt-in" shape to
> all wishes is a future step.

You can render the built-in UI directly. `[UI]` is optional — a wish that has
resolved to nothing to show leaves it unset — so read the slot rather than
rendering the whole state. Hand it over as the slot itself, rather than wrapping
it: an element around it is still an element when the slot is unset, and shows
as an empty box.

```tsx
// Shown inside a pattern body.
return { [UI]: wishResult[UI] };
```

## Wishing for a Specific Piece

Decorate your schema with a jsdoc comment containing a `#tag`:

```tsx
// Shown at module scope.
/** Represents a small #note a user took to remember some text. */
type Output = {
  content: string | Default<"">;
};
```

Then wish for that tag from another pattern:

```tsx
// Shown inside a pattern body.
const wishResult = wish<{ content: string }>({ query: "#note" });
```

## Scope Parameter

The `scope` parameter controls where wish searches for matching pieces:

- `"~"` - Search favorites in the [home space](HOME_SPACE.md) (global, cross-space)
- `"."` - Search [mentionable](mentionable.md) items in the current space
- `"profile"` - Search elements in the current user's shared profile

By default (no scope), wish searches **favorites only** for backward
compatibility.

Home-dependent wishes resolve under the requesting user's transaction, including
headless hashtag searches. Their results are at least user scoped unless the
requested schema explicitly selects a scope. Use `PerUser<>` for a shared
consumer's home-derived resource selection. The shared hashtag scan optimization
applies only to home-independent, space-scoped searches.

### Examples

```tsx
// Shown inside a pattern body.
// Search only favorites (default behavior)
wish({ query: "#note" })
wish({ query: "#note", scope: ["~"] })

// Search only mentionables in current space
wish({ query: "#note", scope: ["."] })

// Search both favorites AND mentionables (favorites first)
wish({ query: "#note", scope: ["~", "."] })

// Search the current user's shared profile elements
wish({ query: "#portfolio", scope: ["profile"] })
```

### Well-Known Profile Targets

A user may have multiple profiles, stored on the home default pattern at
`homeSpaceCell.defaultPattern.profiles` (a list), with `defaultProfile` and a
recency-ordered `mru`. The well-known wishes enumerate that list and resolve,
ordered **default first, then by MRU, then list order**:

```tsx
// Shown at module scope.
wish({ query: "#profile" }) // the single current profile; see [UI] below
wish({ query: "#profileName" }) // default profile's initialNameApplied
wish({ query: "#profileAvatar" }) // default profile's avatar
wish({ query: "#profileBio" }) // default profile's bio (free-text description)
wish({ query: "#profileSpace" }) // default profile's space cell
```

Once profile data is loaded and at least one profile exists,
`wish({ query: "#profile" }).result` is **the single current profile** —
the best of the ordered candidates (default → MRU → first) — in **every** mode
(interactive, headless, and the blessed read). It does not depend on the picker
sidecar pattern running, so
consumers can gate on `.result` without stranding in the multi-profile case
(CT-1829). The `candidates` array holds all ordered profiles.

Profile resolution waits for the Home root, default pattern, roster, and
referenced profile documents to load before publishing a new result or opening
profile creation.
While those reads are pending, the existing wish state is retained; a new wish
can remain unset. Confirmation re-runs the wish even when a document is absent
and no data arrives. A confirmed empty roster opens profile creation. An entry
confirmed absent is skipped when another valid profile remains. A failed load,
or absent entries leaving no valid profile, produces an error surface instead.
Failed confirmations do not schedule another load on their own. Every re-run
checks the current document before consulting a cached failure, so document
arrival allows the same Wish instance to recover. A fresh Wish instance or a
replica reset can request another load.

The picker is the **switching affordance**, not the source of `.result`:
selection is _state_, not a channel. When the picker's "Use" writes `mru` or
"Set default" writes `defaultProfile`, it reorders the candidates, so
`ordered[0]` — and therefore `.result` — updates reactively. The optional `[UI]`
for `wish({ query: "#profile" })`:

- **0 profiles:** the trusted profile-create surface (same input as the home
  Profile tab). Submitting a name creates the viewer's first profile and leaves
  the current view in place; the wish reacts once the link exists. `.result` is
  `undefined` and `error` is set until the first profile exists.
- **1 profile:** a link to that profile.
- **2+ profiles, a valid default set:** a link to the default profile.
- **2+ profiles, no valid default:** the **profile picker**
  (`profile-picker.tsx`) — lists profiles, sets the default, stamps MRU, and
  creates more inline — rendered purely as the switcher. `.result` still
  resolves to the ordered best (MRU-or-first) immediately; picking a profile is
  what changes it.

The create surface and the picker are patterns the runtime fetches and runs
behind the `[UI]` it has already sent, so both slots start empty and fill in
once that launch lands. The launch counts as scheduler work while it is in
flight, so `runtime.idle()` — and every settle built on it, including the
shell's `commonfabric.viewSettled()` — covers it: a settled view is one whose
wish surfaces have arrived, not one that is about to grow them. A launch that
cannot load its pattern writes that into the same slot rather than leaving it
blank.

Each surface is an ordinary piece in the space of the piece that wished, and it
records the `system:` ref naming the file it was made from — the same kind of
origin a space root records. So the piece menu shows where its code came from,
its history holds the source it was created with, and it follows that origin
through the ordinary source lifecycle: the launch opens the piece, which
resolves the ref against the host serving its space and adopts the source it
names when the deployment has shipped a new version. Opening happens once per
surface per process, not on every re-run of the wish behind it.
`docs/specs/piece-source-lifecycle.md` is the design of record.

When rendering profile data from a shared piece, use a user-scoped result schema
for the rendered output so each viewer sees their own home profile projection.

### Favorites vs Mentionables vs Profile

| Feature    | Favorites (`~`)            | Mentionables (`.`)              | Profile (`profile`)              |
|------------|----------------------------|---------------------------------|----------------------------------|
| Storage    | Home default pattern       | Current space                   | Profile default pattern          |
| Scope      | Cross-space                | Per-space                       | Cross-space, per-user            |
| Source     | User's favorites list      | Pattern's `mentionable` export  | User's profile element list      |
| Tag source | Snapshotted when favorited | Computed from schema            | `userTags` first, then `tag`     |

### Accessing the Favorites List Itself

Favorites are pieces added to the user's home space; they are accessible from
any space. You can wish for the favorites list directly (see
`system/favorites-manager.tsx` for a full example):

```tsx
// Shown at module scope.
type Favorite = { cell: { [NAME]?: string }; tags: string[] };
const wishResult = wish<Array<Favorite>>({ query: "#favorites" });
```

The `tags` field holds the discovery tags of the piece pointed to by `cell` —
the hashtags from its schema's doc comment, lowercased and without the leading
`#`. The favorites client derives them from the piece's schema when the
favorite is added (the schema is not reachable from inside the home pattern's
handler), and the wish system matches against them.

Favorites created before the `tags` field instead carry a `tag` field holding
the piece's serialized result schema; the wish system still reads it,
extracting hashtags from the serialized text. The `tag` field is deprecated;
do not write it.

### When to Use Each Scope

- **Favorites only (default)**: Globally available pieces the user has explicitly saved
- **Mentionables only**: Space-specific features that discover pieces created within that space
- **Profile only**: User-owned profile pieces that should follow the viewer
  across shared spaces
- **Both**: Find any relevant piece regardless of where it lives

## Call wish() at Pattern Level

Always call `wish()` at the pattern body level, not inside `computed()` or other
reactive constructs:

```tsx
// Shown at module scope.
export default pattern<Input>(({ enableSearch }) => {
  // ✅ Call wish() once at pattern level
  const searchPiece = wish<SearchOutput>({ query: "#search" });

  // Use computed() to conditionally process the result
  const searchData = computed(() => {
    if (!enableSearch) return null;
    return searchPiece.result?.data;
  });

  return { searchData, [UI]: <div>{searchData}</div> };
});
```

This ensures the wish is established once. Conditional logic belongs in how you
*use* the result, not in whether you *create* the wish.

## Built-in Targets

These query strings resolve to well-known cells without a search. The
`#`-prefixed targets resolve against the current space by default, except
`#favorites`, `#journal`, `#learned`, `#learnedSummary`, and the `#profile*`
targets, which require a signed-in user and resolve from that user's home space.
The `scope` parameter can redirect or fan the others out across other spaces.

| Target              | Description                                             |
|---------------------|---------------------------------------------------------|
| `/`                 | Current space cell                                      |
| `/path/to/prop`     | Nested property of the current space cell               |
| `#default`          | Default pattern of the current space                    |
| `#mentionable`      | Mentionable pieces in the current space                 |
| `#pieceRegistry`    | All pieces registered in the current space              |
| `#suggestions`      | Suggestion history of the current space                 |
| `#summaryIndex`     | Summary index of the current space                      |
| `#knowledgeGraph`   | Knowledge graph of the current space                    |
| `#now`              | Piece's first-ever load time, durable — never advances  |
| `#now/N`            | Reactive timestamp, every N seconds (N must be 1-86400) |
| `#favorites`        | User's favorites list (home space)                      |
| `#favorites/<term>` | First favorite matching `<term>` (legacy search)        |
| `#journal`          | User's journal (home space)                             |
| `#learned`          | User's learned data (home space)                        |
| `#learnedSummary`   | Free-form learned summary string (home space)           |
| `#profile`          | Profile default pattern object                          |
| `#profileName`      | User's profile display name                             |
| `#profileAvatar`    | User's profile avatar                                   |
| `#profileSpace`     | User's profile space cell                               |

The `#profile*` targets are detailed under
[Well-Known Profile Targets](#well-known-profile-targets). Any other `#tag` is a
hashtag *search* rather than a well-known target: it returns every piece tagged
`#tag`, scoped per the `scope` parameter (favorites only by default). A query
that is neither a `/path` nor a `#tag` is treated as a free-form request and
routed to the suggestion picker.

```tsx
// Shown inside a pattern body.
// One-shot: durably captures the piece's FIRST-EVER load time — a reload, or
// any other runtime opening the same piece, reads the original capture. It
// never updates; use it for created-at stamps, never as a clock.
const createdAt = wish<number>({ query: "#now" });

// Reactive: updates every 60 seconds, re-triggering downstream computed()s.
const now = wish<number>({ query: "#now/60" });
const timeAgo = computed(() => {
  if (now.result == null || createdAt.result == null) return "";
  const ms = now.result - createdAt.result;
  return `${Math.floor(ms / 60000)} minutes ago`;
});
```

For a one-off timestamp of the **triggering event** — not the piece's first
load, and not a reactive tick — call `Date.now()` / `new Date()` directly
**inside a handler or action**. There the sandbox exposes the event's own
instant, frozen for the whole handler cascade and coarsened to one-second
resolution; it is not a live wall-clock read (shaped/delayed delivery can make
it lag real time). The three sit on a spectrum: `#now` is the piece's first-load
instant, the handler clock is the current event's instant (a single frozen
reading), and `#now/N` is a reading that keeps refreshing. Reach for `#now` only
for a created-at stamp; use the handler clock to stamp an event, or `#now/N` for
a value that must track the current time.

### Periodic work: polling a data source on a `#now/N` tick

`#now/N` is also how a pattern does periodic *work* — "check this feed every five
minutes", "re-run this query every minute". The `#now/N` cell flips every `N`
seconds; feed that tick into the input of a **reactive** fetch builtin
(`fetchJson` / `fetchText` / `fetchData`), and the builtin re-runs each window
because its input changed. Vary the request by the tick (a `since` parameter, or
a cache-busting query value) so each window is a fresh request rather than a
memoized repeat:

```tsx
// Shown inside a pattern body.
// Poll a feed every 5 minutes. The #now/300 tick changes `url` each window, so
// the reactive fetch re-runs; its result lands in a cell the UI reads. No clock
// is read in reactive code — the tick is a cell, and the fetch is a reactive
// builtin, so the graph still quiesces between windows.
const tick = wish<number>({ query: "#now/300" });
const feed = fetchJson<{ items: string[] }>({
  url: computed(() =>
    tick.result == null ? "" : `/api/my-feed?window=${tick.result}`
  ),
});
const items = computed(() => feed.result?.items ?? []);
```

This stays inside the timing model: reactive fetch settlement is observed in a
lift/computed context where the clock is denied, so a periodic re-fetch grants no
fine clock (see `docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md`).

**What a `#now/N` tick cannot do: trigger a handler.** A tick is a cell flip.
Reactive code (lifts, computeds, the pattern body) cannot emit an event, so there
is no way to make a `#now/N` tick *fire a handler* on a timer. Periodic work that
can be expressed as "re-derive this value / re-read this source" fits the
reactive-fetch shape above; periodic work that must *push* on a timer is
deliberately not expressible, because an unattended background side-effect is a
larger capability than a background read.

## Intended Usage

Keep a handle to important information in a piece, e.g. user
preferences/biography, cross-cutting data (calendar).

### Adding Pieces via `#default`

To add new pieces to the space, wish for the `addPiece` handler as a `Stream`:

```tsx
// Shown for illustration only.
const defaultApp = wish<{ addPiece: Stream<{ piece: MentionablePiece }> }>({
  query: "#default",
});
defaultApp.result.addPiece.send({ piece: newPiece });
```

Do **not** wish for `pieceRegistry` as a `Writable` — see
[Adding Pieces](adding-pieces.md).
