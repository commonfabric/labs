# Modeling hidden-information games with CFC — it's already expressible (field-level labels + label-gated sync + reducers)

**Status:** Design exploration / motivating sketch (non-normative)
**For:** CFC designers (`../specs/cfc`) and anyone weighing what belongs on the CFC roadmap
**Companion:** working demo pattern at `packages/patterns/poker-sanitization-demo/main.tsx` (type-checks; click-through)

> **Reflects review by @seefeldb.** Earlier drafts billed "graded, per-reader projection" as a
> missing primitive. It isn't: per-field secrecy is **field-level CFC**; reader-relative delivery is
> **label-gated per-recipient sync** — a *known, planned* memory-engine step (not shipping a
> reader's-confidential data to that client), which we simply **assume** here; and the one
> genuinely-CFC-native piece is a **reducer + relabel** for coarser single-field summaries. There is
> no missing projection primitive.

---

## What this is, and the decision it informs

This memo uses a board game as a **forcing function** for hidden-information modeling in CFC, and
concludes that CFC's existing model **already covers it** — no new label primitive, and no new
"per-reader projection" layer. The pieces:

- **Per-field secrecy** ("some aspects of a value are more secret than others") → **field-level
  confidentiality labels**, and **field-level opaque/not-opaque** for blind pass-through.
- **Reader-relative delivery** (Alice gets her cards, Bob doesn't) → **label-gated per-recipient
  sync**: the memory engine simply doesn't sync a reader-confidential field to a client that can't
  read it. This is a *known, planned* memory-engine step; this memo **assumes** it.
- **A coarser summary of a single field** ("Bob sees the *count*, not the cards") — the one case
  field-level labels don't cover — → a **trusted reducer + integrity-guarded relabel policy**.

So boardgame's `SanitizedForPlayer` ≈ **label-gated per-recipient sync (planned) + reducers**, not a
new projection mechanism.

It is **not** a proposal to ship a poker game. The decisions this memo informs are narrow:

> 1. Is a small **reducer library + authoring affordance** (`count`/`exists`/`order` + "for audience
>    X serve reduction R") worth adding as ergonomics over the existing label model?
> 2. How is the **recombination** hazard (§14.3.2) bounded when one secret has several reducers?
> 3. Is **unlinkability** (shuffles) worth a research track, or explicitly out of scope?

**Central claim, in one sentence.** CFC access is binary per `(value, principal)`; per-viewer
hidden-information is **field-level labels + opaque + label-gated per-recipient sync (assumed,
planned) + reducers** for coarser single-field summaries — with **no** new projection primitive, and
only **recombination** (§14.3.2) and **unlinkability** as open/out-of-scope concerns.

---

## Why this matters beyond games

A hidden-information game is the purest instance of a pattern that recurs across collaboration
and privacy features: **the same stored value must appear in different, *partially* redacted forms
to different people, and the redaction is graded, not all-or-nothing.**

The "reveal only the count / only that it exists / only the order" moves a card game needs are
exactly:

- a shared document where a collaborator may see **that a field exists** but not its value;
- a per-recipient **summary** that reveals aggregate facts (how many items, what categories)
  without the items;
- a roster where teammates see **names** and outsiders see only a **headcount**;
- an audit view that proves **a record was touched** without disclosing the record.

CFC today reaches for **scopes** (`PerUser` / `PerSpace`) for all of these — which forces a
binary partition (you're in the scope or you're not) and turns every change in visibility into a
data migration. The game makes vivid what scopes can't express: a *graded* reveal that *changes
over time* (deal → hidden, showdown → visible, fold → "existed") on a *single* canonical value.

If CFC can express the game cleanly, it can express all of the above with one mechanism.

---

## The model we're emulating: `github.com/jkomoros/boardgame`

`boardgame` is a mature Go framework for turn-based board/card games. Among its subsystems is a
small, unusually sharp **state-sanitization model**, and that subsystem — not the game engine —
is what we want to learn from.

### The core idea in one screen

The server holds **one** true game state. When it sends state to a particular client, it emits a
**redacted projection tailored to that viewer**. The true state is never mutated; each player
simply receives a different lossy view of the same thing.

Consider a hand of two cards that Alice holds. One declaration governs every viewer:

```go
// In Alice's player-state struct. "len" applies to the "other" group by default.
Hand boardgame.Stack `sanitize:"len"`
```

From that single tag, the framework computes, *per recipient*:

| Viewer | What they receive for `Alice.Hand` |
|---|---|
| **Alice herself** (`self`) | `[A♠, K♥]` — the real cards |
| **Bob / any other player** (`other`) | two face-down placeholders — *"Alice holds 2 cards"*, no faces |
| **A spectator** (`other`) | same as Bob — count only |
| **Admin / game log** | full true state |

That is the whole "aha": **one policy declaration → a correct, per-viewer, partially-redacted
projection, for free.** No hand-written "build Bob's view" code; no separate count cell to keep in
sync. (Source: `state.SanitizedForPlayer` at `sanitization.go:170`; tag parsing in
`struct_inflater.go`; `Game.JSONForPlayer` is the egress boundary, `game.go:212`.)

### The reveal lattice

The redaction is **graded**. Each field is assigned one policy from an ordered lattice (for
collections; scalars collapse to visible-or-hidden):

| Policy | A non-privileged viewer learns… | Rank |
|---|---|---|
| `PolicyVisible` | everything | 0 (most revealing) |
| `PolicyOrder` | positions/order, **values replaced** by placeholders | 1 |
| `PolicyLen` | **count only**, order destroyed | 2 |
| `PolicyNonEmpty` | **one bit**: empty or not | 3 |
| `PolicyHidden` | nothing; field looks absent | 4 (most restrictive) |

### Groups and resolution

A policy binds to a *(field, group)* pair. Built-in groups are `self` (the viewer owns this
substate), `other` (everyone else), and `all`; games can define custom enum groups and computed
`same-TEAM` / `different-TEAM` groups. When a viewer is in several groups, the
**least-restrictive matching policy wins** (`base/game_delegate.go:325`).

### The clever part: identity that survives moves but not shuffles

Each card carries an unguessable id, `sha1(gameID + secretSalt + deck + index + secretMoveCount)`
(`component.go:319`); the salt is never sent to clients, so an unobserved id is uncomputable. Two
properties make this powerful:

- **Stable across public moves**: a card keeps its id as it slides between visible piles, so a UI
  can animate "the *same* card" moving — without anyone needing to know its face.
- **Scrambled on shuffles and secret moves**: `Shuffle()` bumps `secretMoveCount`, changing every
  id, and records old↔new ids in `IDsLastSeen` (`stack.go:1272`). A viewer learns "these N cards
  became those N cards" (so the shuffle still animates) but **cannot recover which became which**
  — exactly the unlinkability a shuffle should create. A *public* shuffle reorders *without*
  scrambling, so cards remain trackable; the framework distinguishes the two on purpose.

So a card's identity carries two policy-relevant facts: a **stable animation token** and a
**linkability relation that can be deliberately severed.**

---

## What CFC already expresses

Reading `../specs/cfc`, the *group/labeling* half of this maps onto existing machinery with no
new mechanism:

| Boardgame | CFC today | Reference |
|---|---|---|
| Groups `self`/`other`/`all`/`team` | **Spaces + roles**; "any reader can view" emerges from role membership, not DNF labels | `03-core-concepts.md` §3.6 |
| "least-restrictive policy wins" | CNF access check: satisfy ≥1 alternative per clause | §3.1.4 |
| Faceless placeholder + opaque id | **Opaque inputs / opaque handles** — a reference you can pass but not read | `08-13-opaque-inputs.md`; `14.2.2.7` |
| `PolicyOrder` / `PolicyLen` as *structural facts* | **Collection constraints** `permutationOf` / `lengthPreserved`, and the **membership-vs-member confidentiality split** | `08-05-collection-transitions.md` §8.5.3–8.5.6 |
| "order/selection leaks info" | **Selection-decision integrity** | §8.5.7 |

The most encouraging single find: **§8.5.6.1 already separates *membership confidentiality*
(which / how-many items) from *member confidentiality* (each item's value).** That is precisely
the axis `len`/`order` live on — i.e. *per-field* secrecy, which field-level CFC already labels.

### Why the "graded, reader-relative projection" framing was wrong

Earlier drafts argued CFC was missing a *graded, reader-relative, read-time projection* primitive.
Per review (@seefeldb), each of those three is already covered — by **field-level CFC**, by
**field-level opaque**, and by the **planned label-gated sync**:

- **Per-field / "graded".** "Some aspects of a value are more secret than others" is just
  **field-level confidentiality labels** — different subpaths carry different labels (`ifc` is
  path-granular). A structured value with public and secret fields needs no new mechanism. The
  *only* thing field-level labels don't give you is a **coarser value derived from a single field**
  (the *count* of a list, the *existence* bit) — and that's the reducer (below). So "graded" isn't a
  gap; the narrow real case is single-field summarisation.
- **Reader-relative.** Delivering different fields to different readers is **field-level labels +
  per-recipient sync**: label a field confidential-to-Alice and the engine simply doesn't sync it to
  Bob's client. Field-level **opaque/not-opaque** covers the blind-pass-through case. There is no
  need for a per-reader *projection* primitive.
- **Read-time projection / "the render boundary doesn't stop reading the bytes".** Correct today,
  but **not shipping a reader's-confidential data to that client is a known, planned memory-engine
  step**. For the purpose of this experiment it is reasonable to **assume confidentiality labels
  control what gets synced** to each client. So this is planned infrastructure, not a fundamental
  gap — and it *is* the same thing as "reader-relative" above.

Net: `SanitizedForPlayer`'s goal, re-expressed in CFC terms, is **(a) label-gated per-recipient sync
(planned) + (b) reducers for coarser single-field summaries** — not a new projection layer.

### A note on scopes

`PerUser`/`PerSpace` scopes are *coarse* data-addressing boundaries (and "addressing, not
authorization" — multi-user docs). They can give binary hidden-vs-visible, but the
confidentiality-label path above is the right tool for field-level, reader-relative secrecy and for
the time-varying relabels (deal → showdown) a game needs; you don't want to scatter one logical
card across scopes over its lifetime.

---

## How CFC already models this: trusted reducers + relabel policies

> **Correction.** An earlier draft of this memo proposed a *new ordered "reveal" label dimension*
> (`hidden ≺ existence ≺ cardinality ≺ order ≺ values`). That was a modeling error. CFC access is
> **binary** per `(value, principal)` — you satisfy a value's label and read the whole thing, or
> you don't (§3.1.4; projecting a field *inherits*, never reduces, confidentiality — §8.3.1).
> "Gradation" lives on the **label lattice** (more CNF clauses = more restrictive; join =
> concatenation), not on a graded read of one value; even classic MLS levels are *modeled as
> policy*, not a built-in axis (§4.7.2). So a graded reveal is **already expressible** with two
> things CFC has, and needs no new label dimension.

The idiom is a **reducer + a relabel policy**:

1. **A reducer is an ordinary transform** that takes the secret and emits a less-informative
   value: `count(hand) = hand.length`, `exists(hand) = hand.length > 0`,
   `orderSkeleton(hand) = hand.map(_ => BLANK)`, … By the transition rules the reducer's output
   **inherits the input's confidentiality** (the count starts out as secret as the cards — §8.7,
   §8.1 table) and gains **new integrity *from the reducer itself*** — specifically a
   *semantic-correctness / resolution-reduction* integrity atom, which the spec names explicitly
   (§3.3, class 2: "unit conversions, **resolution reduction**"). Call it
   `ReducedBy{ reducer: CodeHash, kind: "count" }`.

2. **A policy trusts that reducer to relabel its output.** An integrity-guarded exchange rule
   (§5.3.2) fires when the value carries `ReducedBy{reducer: H}` and **relaxes the
   confidentiality**: `removeMatchedClauses` drops `[Alice]`, `addAlternatives` adds the lower
   audience (e.g. `[table]`). In the spec author's words: *"I trust the count-reducer (hash H);
   when its output is so labelled, that output may carry `[table]`."* This is **robust
   declassification** (§10 inv. 7): the relabel is gated on integrity that **only the trusted
   reducer's code identity can mint** (§3.3: integrity facts are minted only by trusted code and
   are non-malleable), so untrusted pattern code cannot forge "this is now public." The GPS
   **"round to city"** declassifier (§3.1.5) is the same shape; §8.5.6.1's membership-vs-member
   split is exactly why `count` is separable from the cards in the first place.

```ts
// 1. Reducer (a normal trusted transform). Output inherits the card's confidentiality and gains
//    a resolution-reduction integrity atom naming this reducer.
const countReducer = trustedTransform("poker.count", (hand: Card[]) => hand.length);
//    → output value: number,  integrity: [ReducedBy{ reducer: <hash>, kind: "count" }]

// 2. Relabel policy (an exchange rule keyed to the reducer's identity).
const releaseCountToTable = {
  integrityPre: [{ type: ".../ReducedBy", reducer: countReducerHash }],
  confidentialityPre: [HoleCards(player)],     // matches the hand's secret clause
  removeMatchedClauses: true,                  // drop the player-only secrecy
  addAlternatives: [TableReader(table)],       // ... and release to the table
};
```

So **"reveal level" = which reducer you run; "audience" = the new label its policy grants.** Both
are ordinary CFC. The boardgame ladder is just a *family of canned reducers*: `exists` (≈
PolicyNonEmpty), `count` (≈ PolicyLen), `orderSkeleton` (≈ PolicyOrder), identity (≈ PolicyVisible).
No new primitive.

## What's left (no missing label primitive)

Given the above, there's no missing label-model primitive. What remains is one **assumed (planned)
dependency**, one **ergonomics** opportunity, and two **out-of-scope** concerns.

### Assumed (planned) — label-gated per-recipient sync

Reader-relative delivery depends on the engine not syncing a reader-confidential field to a client
that can't read it. That is a **known, planned memory-engine step**, not something this experiment
needs to invent — so we **assume** it: confidentiality labels control what is synced to each client.
(The `cf-cfc-render-boundary` we use in the demo is a *trusted-host UI gate* standing in for this;
the real boundary is the sync layer.) With that assumption, boardgame's `SanitizedForPlayer` is
nothing more than **label-gated sync + reducers** — no bespoke per-recipient projection layer.

### Ergonomics — a canned reducer/projection library

Authors must hand-write one reducer + one relabel rule per level. A small standard library
(`exists`/`count`/`orderSkeleton`) plus an authoring affordance ("for audience X serve reduction
R") would make the common cases declarative. This is sugar over the model above, not new
semantics.

### Out of scope — recombination and unlinkability

- **Recombination.** Exposing several reducers' outputs at once can leak more than any one
  intended — the spec's own city+grid example is *literally two reducers composing* (§14.3.2,
  explicitly unsolved; §14.4.1). A poker table with many simultaneous partial reveals lands here.
  This bounds how many reducers you can safely publish for one secret.
- **Unlinkability** (boardgame's shuffle/`scrambleIds`: "you may see a card move, but not that it
  is the same card"). This is a *relational* property — not who-may-read-a-value but
  whether-two-values-correlate — which CFC's lattice does not model and the spec does not address
  (nearest acknowledgement: the composition/contamination problems, §14.3.2/§14.4.2). It is the
  one boardgame behaviour with **no** CFC home today; treat it as an open research question, not a
  primitive to bolt on.

---

## Worked example: Texas Hold'em

Each hand is `Confidential<Card[], [HoleCards(player)]>`. "Reveal level" = which trusted reducer's
output a policy releases to the table; "audience" = the label it's released to. (S) marks where
**label-gated sync** does the per-reader delivery (assumed/planned); (R) the open **recombination**
caveat; (U) the open **unlinkability** problem.

| Field | Label | How others learn anything | Mechanism |
|---|---|---|---|
| `holeCards[p]` | `[HoleCards(p)]` | table gets `count` only | `countReducer` + relabel `[HoleCards(p)]→[table]` |
| `board` (flop/turn/river) | `[HoleCards(deck)] → [table]` | everyone, once dealt | identity reducer relabelled by a trusted "deal community" action |
| `pot`, `bets`, `toAct` | `[table]` | everyone | public; no reducer |
| `muck` (folded hand) | `[HoleCards(p)]` | table learns a hand exists | `existsReducer` + relabel to `[table]` |

1. **Deal** → `holeCards[p]` is `[HoleCards(p)]`-secret. A `countReducer` emits `length` (inherits
   the secret, mints `ReducedBy{count}`); `releaseCountToTable` relabels *that derived value* to
   `[table]`. Alice (who satisfies `HoleCards(Alice)`) sees her cards; the table sees `{count: 2}`.
   **(S)** Alice gets the cards and Bob only the count because **label-gated sync** ships each field
   to the clients that can read it — the planned memory-engine behaviour we assume here.
2. **Flop/Turn/River** → community cards start `[HoleCards(deck)]`-secret; a trusted "deal
   community card" action (§3.8/§6) authorizes an identity-reducer relabel to `[table]`. A normal
   declassification event.
3. **Showdown** → the *same* `holeCards[p]` are relabelled `[HoleCards(p)] → [table]` by the
   trusted Showdown action — the identity reducer this time (full cards). Folded hands simply don't
   get this relabel, so they stay secret. **(R)** publishing both `count` (step 1) and full cards
   (here) over a session is multiple reducers on one secret — fine sequentially, but a caution if
   many partial reveals coexist.
4. **Muck (fold without showing)** → `existsReducer` releases one bit (`[table]`); the cards' full
   label is never relaxed, so contents stay secret forever. **(U)** "you can't tell *which* cards
   were folded even after the deck is shown" is the unlinkability property CFC has no home for.

Every mechanic except unlinkability is `{trusted reducer} + {relabel policy}` over the binary
lattice, delivered by label-gated sync; no new projection machinery is required.

---

## Expressible today vs needs adding

| Capability | CFC today | Verdict |
|---|---|---|
| Per-player hidden vs visible hands | `Confidential` label + binary access | ✅ already |
| "Any table member sees the board" | spaces + roles | ✅ already |
| "Opponent has N cards" (count, not cards) | `countReducer` + integrity-guarded relabel (§8.7, §3.3, §5.3.2) | ✅ already expressible (label model) |
| "Positions visible, faces hidden" (order) | `orderSkeletonReducer` + relabel | ✅ already expressible (label model) |
| Reveal that changes over time (deal→showdown) | trusted action fires the relabel exchange rule | ✅ already (a relabel, not a data move) |
| The right fields served to each reader | label-gated per-recipient sync | ✅ assumed (planned memory-engine step) |
| Canned `count`/`order`/`exists` reducers + declarative authoring | hand-write reducer + rule each | ⚠️ ergonomic gap (library) |
| Publish several partial reveals of one secret safely | — | ⚠️ recombination, open (§14.3.2) |
| Can't trace a card through a shuffle (unlinkability) | — | ❌ out of scope / open research |

---

## Open questions for CFC designers

1. **Confirm the framing.** Per-viewer hidden-info = field-level labels + opaque + label-gated
   per-recipient sync (planned) + reducers for single-field summaries. Agreed there's no missing
   projection primitive, and the earlier "ordered reveal dimension" is retired?
2. **A standard reducer library + authoring affordance.** Worth a `count`/`exists`/`order` library
   and sugar like *"for audience X, serve reduction R"* lowering to a reducer + exchange rule? (This
   is the only net-new ask, and it's ergonomics.)
3. **Recombination budget.** When one secret has several reducers (count *and* later full cards,
   etc.), how is the composition hazard (§14.3.2) bounded — per-secret reducer allow-lists,
   linkage tracking, a DP-style budget?
4. **Unlinkability — research or out of scope?** Boardgame's scramble has no CFC analogue (it's a
   relational, not who-may-read, property). Worth a research track, or explicitly out of scope?

---

## The companion pattern

`packages/patterns/poker-sanitization-demo/main.tsx` makes the memo concrete, and is deliberately
split into **what CFC enforces today** vs **what this memo proposes** — so it demonstrates real CFC
idiomatically rather than faking the extension.

**Enforced (idiomatic, real CFC):**

- Each hand is a real `Confidential<Card[], readonly [PokerHoleCards]>` cell, created the idiomatic
  way (`lift` → `Cell.for(id).set(...)`), so it carries a genuine `ifc.confidentiality` label.
- A `cf-cfc-render-boundary` with `maxConfidentiality={[]}` **actually blocks every hand from
  rendering** — this is the one CFC mechanism the runtime enforces today.
- The **showdown is a real integrity-gated declassification**: a trusted-action surface
  (`data-ui-surface` / `data-ui-event-integrity` / `data-ui-action` + a `TrustedActionWrite` output)
  flips the cell that drives `declassifyConfidentiality`. Only that trusted gesture reveals the
  hands; **folded hands are never declassified.**
- `cf-cfc-label` shows a hand's live label (the real `ifc.confidentiality`).

**The reducer + relabel story (the corrected model, made concrete):** a `🔢 Reducer + relabel`
pipeline shows `count = hand.length` as a **second `Confidential` cell** (its own `PokerHandCount`
atom) behind its **own** render boundary, released to the table by its **own** trusted action — so
"the table sees the count, not the cards" is demonstrably *a separate binary-access cell relabelled
by policy*, not a graded level. Each stage is badged **ENFORCED** (the two real confidential cells +
their boundaries + the trusted relabels) or **SIMULATED** (the reducer minting `ReducedBy{count}`
and the relabel being *gated* on it — no such runtime primitive exists).

**Honest panels:** a `🧭 per-recipient sync` panel (Alice→cards / Bob→count is the *planned*
label-gated sync, simulated here on one host) and a `⚠️ scope & limitations` panel (the
render-boundary is a trusted-host stand-in for the sync layer; **recombination** and
**unlinkability** out of scope).

It **type-checks, deploys, and runs** (`deno task cf check … --no-run`, exit 0; deployed to a local
toolshed and driven in-browser, 0 console errors).

### Live demo

Deploy `packages/patterns/poker-sanitization-demo/main.tsx` and click through it: act as a
player (per-reader view), deal the streets in order, release just the count, or run the Showdown.
Verified in-browser (light + dark), type-checks via `deno task cf check`.
