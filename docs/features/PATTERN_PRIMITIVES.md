# Pattern Primitives: Factoring the Corpus into Composable Features

**Status:** Draft for discussion (v2 — hardened against two adversarial reviews)
**Date:** 2026-06-10
**Author:** Claude (research: six parallel survey agents over packages/patterns, the runtime, CFC specs, loom-files strategy docs, and the card-web corpus; fact-checked + devil's-advocated by two further agents)
**Companion doc:** `docs/features/CANONICAL_BASE_PATTERNS.md` covers the *data-type* axis (schelling-point interfaces, fork-on-demand, containers). This doc covers the complementary *functionality* axis: which features should be factored out of today's chonky patterns into small reusable primitive patterns, and how the existing patterns get reimplemented on top of them.

---

## 1. Executive summary

The pattern corpus has two populations. One is a thriving family of genuine
primitives — 27 field modules behind `container-protocol.ts`, 17 CFC trusted
surfaces, the `suggestable/` LLM widgets — each small, single-purpose, and
recombinable. The other is a belt of single-file applications (2,000–3,000
lines each: `parking-coordinator`, `lot-watch`, `gmail-agentic-search`,
`self-improving-classifier`, `lunch-poll`, the ~17 Google extractors) that
re-implement the same dozen features inline, over and over.

The survey found **~27 primitive candidates** (§6), each appearing in 2–19
places today. The catalog is a census, not a commitment list — §8 proposes a
first wave of four and a process for the rest.

Why factor, in order of how little each argument depends on the future:

1. **Banked correctness.** Most of this corpus is LLM-authored, and
   regeneration is cheap — but regenerated code re-steps on known landmines
   (the reactive-scoping hazard that *forces* monolithic authoring, §3.2;
   the name-based-identity bug shipped in `profile-group-chat`, §5.4). A
   primitive is where a fix lands once. §2.6 confronts the LLM-economics
   objection directly.
2. **The CFC audit economy.** The taint quantum is the transaction, and every
   write of a transaction inherits the join of everything it read (S16, D1).
   Small handlers, small schemas, and stable code identities are what labels,
   trusted-write contracts, and (eventually) one-time vetting attach to.
   "Taint containment effectiveness degrades super-linearly as black box
   size increases" (card.web:c-443-fce753). §4 states this per-tier, because
   the payoff differs by kind of primitive.
3. **Recombination odds.** A pattern bundling ten features needs all ten to
   fit a new use case; ten one-feature patterns can be re-glued in any
   subset — combinatorial coverage of the adjacent possible
   (card.web:c-863-eac691).
4. **The ranking flywheel — the horizon, not the dependency.** Small safe
   patterns are the unit the savvy-user → everyone pipeline will eventually
   distribute: "the image onebox technique, but for turing complete things"
   (card.web:c-421-afc285). None of the ranking machinery exists yet (wish()
   is unranked, there is no usage telemetry, and today's authors are us and
   our LLMs). This work is justified by 1–3 even if the flywheel never
   spins; it also happens to be the only shape the flywheel *can* distribute
   when it does — nobody reuses a bespoke whole; everybody reuses blocks
   (card.web:c-906-ada936).

The method is **primitive archeology** (card.web:c-840-ece996): don't design
primitives top-down — look at the chonky patterns that already exist (most
born in `factory-outputs/` or from `tools/generate-importer.ts`) and
"explain" them as compositions of primitives that, had they existed, would
have produced the same outcome. One honesty requirement the census must meet
(§6): duplication only counts as demand evidence when the copies arose
independently. A generator stamping one template 17 times, or one identity
block hand-copied down a documented lineage, is *one* authoring decision —
the census tags provenance accordingly.

This is a process, not a one-time decomposition (§8): "If you build a search
engine as a linear process, it will never catch up with the compounding
momentum of the ecosystem" (card.web:c-608-ecc937).

---

## 2. Strategic frame

Five claims from the strategy corpus, then the objection the strategy itself
raises.

1. **Apps are bundles forced by production cost; the bundles dissolve.**
   "The equilibrium point of 'chunkiness of app' that we see today is based on
   the fixed cost of software production and the marginal cost of
   distribution" (card.web:c-831-bde286; the Coasian twin is c-887-fbc491).
   With near-zero creation cost, the minimum viable market for a bit of
   software approaches zero — patterns are what apps unbundle *into*.
2. **Granularity is a stated design pull, not an aesthetic.** "Patterns should
   have a consistent pull towards being granular and composable"
   (card.web:c-714-dfe813, quoted in `Work/Strategy/synthesis/02-core-thesis`).
   "Apps are chonky and dangerous. Writing them safely will never work for
   infinite personal software" (c-396-fbb660).
3. **Small blocks are the only shape CFC scales to.** "The smaller you can
   make the blocks of computation, the more you can minimize taint"
   (talk-cultivating-infinite-software, slides 72–73). One bit of taint in a
   box taints the whole box (c-443-fce753). The micro-app pivot (slides
   94–98) happened precisely because "a little taint… would taint it all."
4. **Safety is what makes ranking code possible at all.** Swarm-sift ranking
   "only works for declarative information, not code. Code is dangerous,
   because it can do things. Imagine how powerful it would be if we could
   rank running code, safely" (c-543-ffc925). Patterns + CFC are the
   containerization that closes that gap (c-603-cfc845), and ranking can
   bootstrap on bare usage counts (c-773-cda780).
5. **Savvy users supply the patterns; ranking smears them to everyone.**
   The incentive question is meaningless — savvy users create to solve their
   own problems, and "those creations just so happen to help others"
   (c-800-cfe410). The staged rollout (1 → 12 → 1,000 → 1M gated on
   acceptance) presupposes the unit being rolled out is small enough to be
   evaluated and accepted on its own — a ten-feature app can't win an
   acceptance vote on the strength of its one good feature.

Claims 4–5 describe a market with no external participants yet. They set the
*direction* (what shape the supply side must have when demand arrives); the
*justification* for doing the work now is §1's claims 1–3. A reader who
discounts the flywheel entirely should still find §4 and §7.1 sufficient.

### 2.6 The LLM-authorship objection, head-on

Objection: these patterns are written by LLMs. LLMs regenerate cheaply and
don't feel the human pain of writing FormBuffer a sixth time, so a
duplication census measures human-economics pain in an LLM-economics world.
Why build a library when you could just improve the generator's prompt?

Three answers, and one concession:

- **Vet-once beats vet-every-generation.** Fresh generation is a fresh audit
  surface. The entire CFC end-game — `writeAuthorizedBy`, trusted-pattern
  identity, the pending verified-code trust anchor — amortizes review over a
  *stable* code identity. You cannot attach an attestation to code that is
  regenerated per use. This is the genuinely LLM-proof argument for shared
  primitives, and it's why the trusted-surfaces library already works this
  way.
- **Regeneration re-steps on landmines.** The corpus's worst bugs are not
  random: the perSession-in-computed-in-`.map()` hazard has its own gotcha
  doc and *shaped* parking-coordinator's monolithic layout; the identity
  idiom was copied wrong (name-Set dedup) even with a correct reference
  implementation in tree. Primitives bank the fix; prompts merely lower its
  probability.
- **Behavioral drift is a migration cost.** Regenerating a deployed pattern
  against live user data risks silent behavior change; swapping an inlined
  block for the primitive it duplicates is a reviewable, parity-testable
  diff.
- **The concession:** for pure conventions and one-screen UI idioms, fixing
  the generator/skill docs *is* the cheaper fix, and LLMs are worse at
  discovering-and-correctly-using libraries than at writing fresh code —
  `suggestable/` (8 widgets, one consumer, and that consumer is a test file)
  proves extraction without adoption mechanics strands work. Hence two hard
  rules in §7/§8: the generator and skills must be taught every primitive
  that lands (no landing without it), and candidates whose only payoff is
  "less code" stay in the generator's instructions rather than becoming
  library surface.

---

## 3. State of the corpus

### 3.1 The proof points (the thesis already works here)

- **`container-protocol.ts` + the field-module family** — 27 patterns
  (address, email, phone, birthday, tags, rating, social, relationship,
  timeline, occurrence-tracker, …) each export `MODULE_METADATA`, carry their
  own extraction schema, have **zero cross-facet imports**, and recombine
  through `record/registry.ts` into Record containers. Features-as-patterns
  at scale, in production today.
- **`cfc/trusted-surfaces/`** — 17 single-action sub-patterns (save, review,
  publish, forward, redacted-release, …), each ~95–180 lines, each owning one
  protected slot's CFC write contract; hosts embed the UI and re-export the
  handler. `cfc-trusted-component-examples` shows ~50 host instantiations.
  This is the strongest existing evidence that *small vetted patterns are
  exactly the unit CFC meaning attaches to*.
- **`budget-tracker/`** — a 27-line `main.tsx` composing `ExpenseForm` (324)
  and `DataView` (124) over shared Writables declared in `schemas.tsx`. The
  structural template for multi-file decomposition.
- **`battleship/shared/game-logic.tsx`** — the only pure-algorithm module
  extracted from a game/app; two variants (pass-and-play, multiplayer) share
  it. The model for §6.E.
- **`auth/create-auth-manager.tsx`** — a descriptor-parameterized OAuth state
  machine reused by the Airtable and Google stacks (via thin
  `airtable-auth-manager.tsx` / `google-auth-manager.tsx` descriptors). The
  factory exists; what provider files still duplicate is the UI-helper layer
  — `airtable/core/airtable-auth.tsx` re-implements scope-summary, expiry
  warning, and status-chip logic that `auth/auth-ui-helpers.tsx` provides.
- **`lot-with-coordinator-demo/main.tsx`** (145 lines) — instantiates
  parking-coordinator and lot-watch against the *same* perSpace `people` and
  `spots` cells; tagging a plate in one app makes the person appear in the
  other. Shared-cell composition across two apps works today — and its five
  `as never` casts (each app privately re-declares structurally identical
  types) are the measurable cost of not having shared schema modules.
- **Orphaned primitives that prove demand but lack distribution:**
  `google/core/processing-status.tsx` (86 lines; consumers: the google
  extractors and `experimental/email-task-engine.tsx`) and `suggestable/`
  (8 LLM widgets, one test consumer). Extraction without a discovery/adoption
  story strands the primitive — see §2.6 and §7.

### 3.2 The counter-specimens

| Pattern | Lines | Features bundled |
|---|---|---|
| `factory-outputs/parking-coordinator/main.tsx` | 2,914 | spot+people registries, vehicle sub-lists, request workflow, auto-allocation engine, week grid, admin registry, ~6 hand-rolled form buffers (~50 perSession cells), confirm dialogs, date utils |
| `self-improving-classifier.tsx` | 2,925 | LLM classify, example store, correction tracking, regex-rule store + precision-weighted voting, rule-suggestion loop, confidence tiers |
| `google/core/experimental/gmail-agentic-search.tsx` | 2,898 | agent loop, community query registry, third bespoke auth idiom, search UI |
| `factory-outputs/lot-watch/main.tsx` | 2,493 | capture wizard, photo→LLM plate extraction, classification engine, dedupe/grouping, reports, person-picker, profile identity, admin registry |
| `record.tsx` | 2,267 | (the good kind of big — a meta-container; but still inlines trash logic, label-dedup, 3 modal states) |
| `store-mapper.tsx` | 2,219 | layout editor, correction memory, LLM categorization |
| `lunch-poll/main.tsx` | 2,091 | voting, user directory, join-with-profile, admin/host takeover, visit history |
| ~17 `google/` extractors | 240–1,830 each | auth glue + fetch + paginate + dedupe + LLM extract + bespoke dashboard — only the query, schema, and view genuinely differ |

Three structural notes from the survey worth internalizing:

- **Chonkiness is partly *forced* by reactive-scoping hazards.** Inline
  comments in parking-coordinator (and
  `docs/development/debugging/gotchas/persession-read-in-mapped-computed.md`)
  document that perSession cells read inside `computed()` nested in `.map()`
  silently fail, so all reads get hoisted to the top of one giant pattern.
  Smaller patterns with narrower state are the *safer* authoring unit, not
  just the prettier one. (Caveat: the documented workaround is an authoring
  fix; decomposition reduces exposure but doesn't remove the hazard — hence
  the §7.6 ask to fix or lint it.)
- **The growth engine currently mass-produces chonk.** `tools/generate-importer.ts`
  fetches an OpenAPI spec and has an LLM write a *new standalone importer*
  per integration. Every run adds another 1,000-line specimen. Retargeting
  this tool to emit compositions over the §6.A pipeline is the single
  highest-leverage change in this doc — and is therefore in the first wave
  (§8).
- **Much duplication is propagated, not convergent.** The 17 extractors are
  one template stamped repeatedly; the identity block was hand-copied along
  a documented lineage (scrabble → lunch-poll → scoped-group-chat →
  group-chat-lobby). The §6 census tags provenance so propagated copies
  aren't mistaken for independent demand — though note that propagated
  duplication still argues for a primitive on §2.6 grounds (the copies
  drift, and fixes don't propagate back).

### 3.3 Composition mechanics: what's cheap, what's missing

Cheap today: authoring-time sub-pattern instantiation (import + JSX, free
two-way cell sync, `[UI]` renders anywhere); multi-file programs deploying as
one piece; wish-tag discovery (`#profile` ×19, `#mentionable` ×11, plus a
long tail); `cf piece link` cell rewiring; `patternTool`/`llmDialog` exposing
patterns as LLM tools.

Missing or expensive (the runtime asks in §7 derive from these):

- **wish() has no ranking.** Exact tag matching, candidates in scope order,
  first match auto-selected; multi-match falls to a picker; freeform queries
  delegate to an LLM dialog (`packages/runner/src/builtins/wish.ts`,
  `system/suggestion.tsx`). The strategy's ranking flywheel has no flywheel
  yet — fine for now (usage counts first, per c-773-cda780), but it means
  primitive *discovery* must initially ride on imports, the catalog, and the
  generator/skill docs, not wishes.
- **Cross-space composition is broken in the ways a runtime broker needs.**
  `CROSS_SPACE_STREAM_HANDLER_INVESTIGATION.md` catalogs the blockers:
  cross-space stream markers don't resolve (CT-1188), handlers can't write
  another DID's cells (CT-1105/CT-1202), wished cross-space data can be
  unreadable (CT-1090). Until these land, primitives compose at authoring
  time (same piece) or same-space; cross-space request/response designs are
  aspirational.
- **Registry boilerplate.** `record/registry.ts` header: "ADDING A NEW
  MODULE? You need to update THREE places."
- **The serializability wall.** No functions in cells; cross-piece behavior
  only via Streams. Any primitive protocol must be data-only (this is why
  `ContainerCoordinationContext` is serializable-only — a constraint, and a
  CFC-friendly one).
- **The rich `ContainerProtocol<T>`** (subLists, `availablePatterns`,
  record upgrade) exists only in CANONICAL_BASE_PATTERNS.md; the implemented
  protocol is the narrow two-interface version.
- **No shared-schema convention.** `packages/home-schemas/` is consumed by
  zero patterns (its consumers are runtime/shell); patterns share types via
  sibling-file imports (`notes/schemas.tsx`, gmail-importer's `Email`) or
  duplicate them inline (`system/journal.tsx` re-declares `JournalEntry`).
  The lot-with-coordinator `as never` casts are the symptom.

---

## 4. The CFC case for factoring — stated per-tier

This section exists because "bonus points for CFC making sense to attach"
turns out to be a primary argument. But it must be stated precisely, because
the CFC unit is **not the pattern** — there is no pattern-level label.
Labels attach to schemas, to stored paths, and (for sqlite) to rows and
columns; taint propagates per *transaction*.

**The mechanics.** One handler/computed run = one transaction; at commit the
runner computes one joined label J = union of the confidentiality of
everything the run read, and every path it writes gets J — to first order
there is no intra-transaction precision (S16, D1; the persisted picture is
slightly finer: declared/link/derived label components with different update
disciplines, replace-on-overwrite for derived taint, and per-path
`maxConfidentiality` write ceilings — none of which rescue a fat handler).
Reading one field of a fat state document joins the whole document's labels
(doc-root reads; within-doc precision is deferred to observation classes).
The runtime's own risk table names the failure mode: "UI state, scaffolding,
instantiation writes all inherit J of busy handler txs" (S16 §9).

**Why factoring helps — and what kind of factoring.** Because the quantum is
the *run*, the benefit comes from smaller handlers/computeds and narrower
schemas — and authoring-time composition delivers that **without separate
pieces**: sub-patterns compiled into one piece still run their handlers and
computeds as separate transactions ("one action = one fresh tx"; lift/
computed/derive each go through the same one-tx-per-run path). You could in
principle split fat handlers inside a 1,400-line file; factoring into
sub-patterns is how that split actually happens and *stays* split, because
the boundary is structural rather than disciplinary. Three further
mechanisms:

1. **Link-passing keeps coordinators clean.** A host that wires cells into a
   sub-pattern *without reading them* picks up no taint (D4.2: "not reading
   is what avoids taint"). Composition-by-cell-wiring is CFC-native: hosts
   route confidential data through primitives while staying clean. The
   runtime's own precision strategy is identical — `map`/`filter` run each
   element in its own transaction, and `flowPrecisionClaim` was *deleted*
   because transaction decomposition supersedes it. Pattern factoring is the
   author-level instance of the same principle.
2. **Small honest schemas are where declared labels live.** A primitive whose
   Output is `Confidential<Email[], [GMAIL_ATOM]>` plus one
   `RequiresIntegrity<…>` action slot *is* a CFC contract. The corpus shows
   what happens without that: the big Google patterns contain a dead stub
   `type Confidential<T> = T;` (`google/core/gmail-importer.tsx:17`, also the
   calendar importer and viewer) — authors *wanted* to mark confidentiality
   and the chonky shape gave them nowhere real to put it. Live CFC
   annotations outside the cfc-* demos appear only in
   `system/profile-home.tsx` and — notably — the two factory-output admin
   registries (`lot-watch`, `parking-coordinator` both apply
   `RequiresIntegrity` to their admin lists), which is itself evidence that
   the admin registry is the one slice of those apps already shaped like a
   primitive.
3. **Stable identity is the precondition for vet-once.** The pending
   verified-code-identity work (`writeAuthorizedBy` for user code fails
   closed today; trust-anchor is phase-C) will want to vet a small stable
   pattern once and reuse the attestation everywhere — an audit economy that
   only exists if primitives exist (§2.6).

**Payoff by tier** (this matters for sequencing):

- **Pure TS modules** (§6.E, #7): no CFC story. Justified on §2.6 grounds
  only (banked correctness, generator quality).
- **Authoring-time sub-patterns** (§6.C/D, most of B): real flow-label
  benefit (small J per run, link-passing hosts) but no separate code
  identity — they compile into the host piece.
- **Runtime pieces and trusted surfaces** (#1, #4, #5, #14): where contracts,
  `uiContract` trusted-pattern identity, row/column labels, and eventual
  attestations attach — and also the tier that pays deployment and
  cross-space costs (§3.3). The trusted-surfaces library shows the model:
  one cell, one surface — a cell's `uiContract` must stay stable, so the
  natural granularity is one primitive per protected slot
  (`cfc/trusted-surfaces/main.test.tsx`). The promotion bar in
  `packages/patterns/cfc/README.md` — generic name, no local fixture data,
  at least one migrated caller — is the governance template §8 adopts.

---

## 5. Reimplementation case studies

Each case names the primitives (by number from §6) that the existing pattern
decomposes into — primitive archeology run on our own tree.

### 5.1 Gmail importer → labeled mail pipeline

`google/core/gmail-importer.tsx` (1,424) becomes:

- **AuthManager consolidation now, TokenBroker later** (#1). v1 is
  unglamorous: collapse the three coexisting auth idioms onto
  `auth/create-auth-manager` descriptors and shared UI helpers, composed at
  authoring time (same piece or same space). The full TokenBroker — token as
  an `OpaqueInput` cell guarded by `WriteAuthorizedBy`, consumers passing
  request descriptors by link, never reading the secret — is the right end
  state but is **blocked today**: `writeAuthorizedBy` for user code is
  hard-rejected in enforcing modes pending verified code identity, non-export
  is authoring-time visibility (not runtime confinement), and a cross-space
  request/response broker needs the CT-1188/CT-1105/CT-1090 fixes (§3.3).
  Design toward it; don't ship a fourth idiom in the meantime. One taint
  caveat regardless of version: whichever transaction *uses* the token to
  fetch produces token-tainted content — so the broker's own handler should
  do the fetch, returning content whose label is the resource atom rather
  than the raw token.
- **GmailFetch** (#2/#3) — fetch + pagination + incremental history sync,
  Output typed `Confidential<Email[], [resource("GmailMessage", account)]>`.
- **MessageStore** (#4) — the sqlite builtin with per-row sender/recipient
  data-derived labels. `cfc-row-label-mailbox` (275 lines) *is* this
  primitive already, demoed and implemented (per-row labels replace one
  blanket label on the whole array; scoped queries drop out-of-scope rows;
  aggregates refuse).
- **HtmlToMarkdown, mime/base64url normalizers** (#7) — plain shared modules.
- **SyncStatus** (#6) — `processing-status.tsx`, promoted out of `google/`.
- A view pattern that reads only what it shows.

The 17 extractors then collapse to *query + extraction schema + view* over
this pipeline plus **LlmExtract** (#5), and `tools/generate-importer.ts`
generates that triple instead of a fresh monolith (no runtime blockers:
budget-tracker is the compositional model the generator should emit).

### 5.2 Calendar importer → column-labeled event store

`google-calendar-importer.tsx` (1,064) + `imported-calendar.tsx` (1,390):
attendee emails (PII) and the public event skeleton currently share one
`Confidential<CalendarEvent[]>` cell, so a "next event title" derivation
inherits attendee taint. Factored: an **EventStore** with column labels
(attendees labeled; title/time not — exactly the `cfc-row-label-records`
shape) gives free/busy and schedule summaries clean labels while "who's
attending" stays behind the attendee atom.

### 5.3 Parking coordinator + Lot watch → shared registries + ten primitives

The two prime specimens (5,400 lines combined) decompose into: shared
people/spots schema modules (the demo already forces this — §3.1),
**PiecePicker** (#12), **FormBuffer** (#13, i.e. adopt cf-form),
**RoleGate** (#9 — note both apps already attach `RequiresIntegrity` to
their admin lists; the primitive finishes what they started),
**ConfirmAction** (#14), **WizardFlow** (#18), **PhotoExtract** (#5
specialization), pure modules for `runAutoAllocation`, `classifyPlate`,
`groupSightingsByPlate` (#23), **ProfileIdentity** (#8), and a **WeekGrid**
view. What remains *per app* is the genuinely distinct part: the
coordinator's request workflow and the lot-watch report views — each
plausibly a few hundred lines.

### 5.4 Group chat → trusted-surface composition

`group-chat-room.tsx` (872, zero CFC) has a ready-made factored rewrite in
tree: `cfc-group-chat-demo` — four trusted surfaces (profile-save, chat-send,
room-add, admin-panel), messages typed `AuthoredByCurrentUser<…>`, admin
writes requiring an integrity atom only the admin panel mints. The before/
after pair for the doc's whole argument, already written. Consolidating the
five chat implementations (§6.B #10) onto this shape also kills the
name-based-dedup identity bug in `profile-group-chat`.

### 5.5 Data-heavy field modules → data + autocomplete

`dietary-restrictions.tsx` (1,616; ~900 lines embedded domain DB) and
`emoji-picker.tsx` (2,723; ~2,600 lines data) become thin patterns over (a)
standalone data modules (the existing `vehicles.ts` shows the shape) and (b)
one shared **Autocomplete/multi-select** primitive. Mechanical, high-yield,
low-risk — a good first extraction to exercise the process.

### 5.6 Self-improving classifier → four primitives

`self-improving-classifier.tsx` (2,925) = LLM-classify step (#5) +
example/correction store + rule store with voting (#28, shared with
`text-swapper.tsx`) + rule-suggestion loop. Notable because the
*crystallization* dynamic it implements (expensive LLM judgments
precipitating into cheap regex rules) is itself the strategy's
"Don't Frack. Precipitate!" loop — this pattern wants to be the showcase, and
as a monolith it can't be reused as one.

---

## 6. The primitive catalog (census, not commitments)

Numbered for reference. Each entry carries evidence and, where real, the CFC
attachment story. **Provenance tags** on the evidence: [I] independently
converged, [L] lineage-copied, [G] generator-stamped. Only [I] counts as
convergent-demand evidence; [L]/[G] entries are justified on §2.6 grounds
(drifted copies, unbanked fixes) and need a stronger adoption argument
before promotion. Tiers per §4: (m) pure module, (s) authoring-time
sub-pattern, (p) runtime piece / trusted surface — the promotion bar and
discovery story differ per tier (§8.2).

### A. Integration pipeline (highest value — feeds every future connector)

1. **TokenBroker** (p; end-state) / **auth consolidation** (s; now) — replace
   the three coexisting idioms (wish `#googleAuth` + `createGoogleAuth()`;
   linked `overrideAuth` cell + 401 refresh; the bespoke cross-piece refresh
   in gmail-agentic-search) [L — one stack's evolution, but the drift is the
   problem]. Builds on `auth/create-auth-manager.tsx`; close the UI-helper
   duplication in `airtable/core/airtable-auth.tsx`. **CFC (aspirational,
   phase-C-gated):** `OpaqueInput` token, `WriteAuthorizedBy` refresh,
   broker-does-the-fetch confinement — see §5.1 for what's blocked and why.
2. **PaginatedFetch** (m/s) — 401-refresh-retry + backoff (4 Google clients
   [G]), offset-pagination do-while ×3 in `airtable-client.ts` [L], loading/
   error/banner state in airtable-importer ×3, create-auth-manager ×3,
   cheeseboard, fetch-data, github-activity [I].
3. **IncrementalSync** (s) — gmail-client history sync vs calendar refetch;
   dedupe-key generation in bill-extractor, berkeley-library, others [G].
4. **LabeledRowStore** (p) — sqlite builtin wrapper with per-row/per-column
   labels. `cfc-row-label-mailbox` / `cfc-row-label-records` are working
   references; the sqlite CFC machinery is implemented, not flag-gated.
   **CFC:** this is where row/column granularity beats any whole-array label.
5. **LlmExtract** (s→p) — generalize `google/core/gmail-extractor.tsx`
   (already reused by 10+ extractors [G]; reuse incomplete) and lot-watch's
   photo extraction [I]. **CFC:** the unit the prompt-injection atoms were
   designed for — confidential input schema, result-schema-constrained
   output, consequential actions typed `RequiresIntegrity<[kernel,
   userSurfaceInput, promptSlotBound, INJECTION_SAFE]>`, per
   `cfc/prompt-injection/subAgentPattern`.
6. **ProcessingStatus** (s) — exists (`google/core/processing-status.tsx`);
   promote out of google/ (current consumers: extractors [G] +
   email-task-engine [I]).
7. **Normalizer modules** (m) — HTML→Markdown (~80 lines inline in
   gmail-importer), base64url ×3 [G], MIME parsing ×2 [G], date parsing ×4
   [G/I]. Plain TS modules; per §2.6 these may live as generator-known
   shared modules rather than patterns.

### B. Identity & collaboration

8. **ProfileIdentity / JoinRoster** (s) — the "who am I" block (wish
   `#profile`/`#profileName`/`#profileAvatar` + PerUser override + avatar
   fallback) copied along a documented lineage [L: scrabble → lunch-poll →
   scoped-group-chat → group-chat-lobby] *and* independently hand-rolled in
   battleship lobby, cozy-poll, fair-share, lot-watch [I]. The correct
   implementation exists: `shared-profile-roster/main.tsx` (profile-cell
   identity, `equals()` comparison, idempotent join); `profile-group-chat`
   still ships the wrong (name-Set) version — the canonical §2.6 unbanked
   fix. **CFC:** `RepresentsCurrentUser` belongs here, once.
9. **RoleGate / AdminRegistry surface** (p) — parking-coordinator and
   lot-watch each re-declare ~90 lines of admin types over
   `cfc/admin/mod.ts` plus ~10 inline gate checks [L — same factory run];
   cozy-poll and lunch-poll roll their own host-takeover variants [I].
   **CFC:** the trusted admin-panel surface from `cfc-group-chat-demo`
   (writes requiring an admin integrity atom) is the finished form, and both
   factory apps already type their admin lists `RequiresIntegrity`.
10. **ChatThread** (s/p) — send-handler logic ×3
    (`group-chat-room.tsx:82`, `scoped-group-chat/main-plain-inputs.tsx:124`,
    `profile-group-chat/main.tsx:55`) [L/I mixed], author-grouped rendering
    ×2, image-upload unwrap ×2, plus an entire file duplicated for an
    accessor-style difference (`scoped-group-chat/` two variants). **CFC:**
    `AuthoredByCurrentUser` messages + conversation-send trusted surface.
11. **UserDirectory / Presence** (s) — lunch-poll's per-space directory,
    scoped-user-directory, battleship lobby presence [I].

### C. Interaction primitives

12. **PiecePicker** (s) — the strongest single candidate: search Writable →
    filtered computed (top-N) → selectable list → set-and-clear. Written
    inline ≥6 times across unrelated authors and eras [I]: annotation.tsx ×2
    (target + blocker), lot-watch (assign-to-person), base/person +
    base/family-member (sameAs, ~120 lines each), battleship lobby,
    examples/cf-picker.
13. **FormBuffer** (s) — adopt `cf-form` (form-demo.tsx) everywhere the
    perSession-cell-per-field idiom is hand-rolled: parking-coordinator (~6
    forms, ~50 draft cells), cozy-poll, fair-share, lot-watch, base/person
    [I]. Biggest pure-LOC win; mostly a generator/skill-docs fix plus
    migrations (§2.6 concession applies).
14. **ConfirmAction** (s→p) — two-step destructive confirm (perSession
    `confirmTarget` idiom) in parking-coordinator, lot-watch [L], cozy-poll
    [I]. **CFC:** as a trusted surface this *is* the reviewed-action
    contract — `recipient-confirm` / `disclaimer-ack` already exist as
    templates.
15. **FilterTabs** (s) — chip/tab filter with live counts: activity-log,
    annotation-manager, airtable-importer, reading-list [I].
16. **StatusBadge** (m/s) — ≥5 hand-rolled status→color maps [I]. Likely a
    generator-docs fix, not library surface.
17. **TagEditor** (s) — `tags.tsx` field module exists; family-member
    carries 4 near-identical inline copies [L], contacts and folksonomy-tags
    more [I]. Adoption problem, not extraction problem.
18. **WizardFlow** (s) — lot-watch's photo→spot→review→saved step machine;
    single site today — watchlist until a second independent user appears.

### D. Collection machinery

19. **PieceCollection** (s/p) — the parent→child machinery (create child
    piece, push handle, navigateTo, bulk ops) copied three times
    [L — weekly-calendar's header admits copying notebook]: notebook→note,
    weekly-calendar→event, reading-list→detail. This is where the
    *implemented* container protocol should grow toward the *documented*
    `ContainerProtocol<T>` (CANONICAL_BASE_PATTERNS.md).
20. **ListCRUD** (s) — 6+ independent implementations of "checkbox row + add
    input + remove" [I]. Candidate convention: do-list's title-addressed
    handlers (`addItems`, `updateItemByTitle`, …) are the most
    agent-driveable variant — but title-as-identity is the same bug class as
    the name-Set roster dedup §5.4 kills. The primitive must use stable
    identity (ids or `equals()`-cells) internally, with title-addressed
    handlers as an explicit fuzzy-matching convenience layer for agents, not
    as the identity model. Reconcile before this becomes canon.
21. **TrashRestore** (s) — the `{...entry, trashedAt}` soft-delete shape in
    record.tsx, container-protocol, record-backup, notebook bulk-delete
    [L/I].
22. **RegistryBackup** (s) — generalize `record-backup.tsx`'s
    registry-driven serialize/deserialize. Single site today — watchlist.

### E. Pure logic & data modules (mechanical; §2.6 concession applies to all)

23. **Inline algorithms → pure modules** (m) — fair-share
    (largest-remainder allocation + settle-up), parking-coordinator
    (auto-allocation), lot-watch (classifyPlate, groupSightingsByPlate),
    cozy-poll (tally/rank), lunch-poll (vote resolution) [I].
    `battleship/shared/game-logic.tsx` is the proven model.
24. **Static datasets → data modules** (m) — dietary restrictions (~900
    lines), emoji data (~2,600 lines); `vehicles.ts` (438) already shows the
    shape.
25. **Date/time utils** (m) — ≥8 independent reimplementations [I]. No
    shared date module exists in patterns today.
26. **Streak/occurrence math** (m) — habit-tracker vs occurrence-tracker [I].

### F. LLM primitives

27. **One LLM step = one pattern** (s) — the `suggestable/` family (topic +
    context → generateObject → cells + pending) is the right granularity and
    is almost unused. Promote it, and migrate the inline generateObject/
    generateText glue in github-activity, image-analysis, store-mapper,
    shopping-list, suggestion, classifier, and the extractors onto it [I].
    **CFC:** observed-confidentiality joins and opaque-link serialization
    already gate LLM calls at the runtime level; a dedicated pattern per
    step gives the sink request one honest read-set.
28. **RuleStore** (s) — regex rules + voting + confidence shared by
    self-improving-classifier and text-swapper [I]; the crystallization
    mechanism (§5.6) deserves to be reusable.

---

## 7. Runtime & tooling asks

Numbered by priority:

1. **Retarget `tools/generate-importer.ts`** to emit query + schema + view
   compositions over the §6.A pipeline instead of standalone monoliths. The
   growth engine should mass-produce compositions, not chonk. (First wave —
   §8.)
2. **Teach the authors.** Every primitive that lands must same-PR update the
   pattern-dev skill docs, the catalog/index, and the generator prompt. The
   primary authors are LLMs; their discovery channel is instructions, not
   wish(). No primitive lands without its adoption surface (this is the
   §2.6/`suggestable/` lesson with teeth).
3. **Migration & versioning policy** (the gap both reviews flagged hardest):
   - Deployed pieces of a rewritten pattern keep running old code; decide
     per-rewrite whether to migrate state (schema-compatible cells), offer a
     record-level upgrade path (CANONICAL_BASE_PATTERNS' `compileAndRun`
     mechanism), or strand-and-deprecate.
   - A primitive's contract change after N hosts embed it needs a stated
     compatibility rule (additive-only outputs? versioned tags?).
   - Each §5 rewrite needs a parity story: golden-transcript or
     side-by-side-piece comparison against the monolith before the monolith
     is retired.
4. **Fix or lint the reactive-scoping hazard** (perSession reads inside
   `computed()`-in-`.map()` failing silently) — it actively pushes authors
   toward monoliths (§3.2) and plausibly outranks every other ask as a root
   cause of chonk. A `cf check` diagnostic is the minimum.
5. **Shared schema module convention.** Bless the family-schema idiom
   (`notes/schemas.tsx`, `agent/schemas.tsx`) as the documented mechanism;
   extract the `PeopleCell`/`SpotsCell` shapes the lot/coordinator demo
   bridges with `as never`. Recommendation (not a punt): `home-schemas`
   stays runtime-only; pattern-shared types live in pattern-side schema
   modules, because patterns version with the pattern tree, not the runtime.
6. **Registry self-description.** Kill "update THREE places" — a module's
   `MODULE_METADATA` should suffice for registration, and the registry
   should generalize beyond Record (the §6.D PieceCollection work, growing
   the implemented protocol toward the documented `ContainerProtocol<T>` or
   formally descoping the latter).
7. **Usage-count telemetry for patterns/pieces** — the minimum viable
   ranking signal (c-773-cda780): which patterns are instantiated, wished
   for, accepted. No scoring algorithm yet; just start the ledger. wish()'s
   unranked first-match resolution is fine until then.
8. **Cross-space request/response** (CT-1188, CT-1105/CT-1202, CT-1090) —
   prerequisite for any runtime-piece broker (TokenBroker end-state,
   cross-space LabeledRowStore consumers). Owned by the runtime team's
   existing cross-space workstream; this doc just registers the dependency.

---

## 8. Process: archeology as a loop, not a project

Sequencing principle: "lump clay on the thing and then once you see what is
valuable, spend the time to carve out the primitives post hoc"
(card.web:c-006-edf579) — but carve continuously, and only where the clay
has actually accumulated.

1. **Dig sites.** `factory-outputs/` and generator output are where chonk
   accumulates by design — that's fine; they're the clay. Periodically re-run
   the duplication census (§6 is the first run) over new arrivals, with
   provenance tags.
2. **Promotion bar, per tier** (extending `packages/patterns/cfc/README.md`):
   - (m) modules: generic name, no fixture data, generator/skill docs
     updated. One migrated caller.
   - (s) sub-patterns: the above plus **two** migrated callers from
     different families (one caller just reproduces that caller's needs
     with the serial numbers filed off).
   - (p) pieces/surfaces: the above plus a stated label/contract story and
     a deployment/migration note (§7.3).
   No speculative primitives: single-site candidates (#18, #22) sit on the
   watchlist until a second independent site appears.
3. **Reimplement, don't just extract.** Each extraction lands with a chonky
   source pattern rewritten as a composition (§5 is the first batch), plus
   the §7.3 parity check. The rewrite is the test that the contract is real;
   the shrunken host is the advertisement.
4. **Keep shipping assembled sets.** The end-user artifact remains the
   pre-assembled lego set (c-959-dcd257); factoring changes what sets are
   *made of*, not what users see. parking-coordinator should still exist as
   a deployable thing — a few-hundred-line composition instead of a
   2,914-line monolith.
5. **Measure — including a kill criterion.**
   - Reuse count per primitive, *excluding migrations we performed
     ourselves* — organic adoption (a new pattern or generator run choosing
     the primitive) is the real signal; team-driven migrations measure
     effort, not validity.
   - Novel-LOC fraction of each new integration (the §6.A pipeline should
     drive a new connector toward "query + schema + view").
   - Escape-hatch metric (c-765-faf061): fraction of new patterns that
     re-implement a §6 primitive inline — drive down.
   - Taint blast radius, once flow labels run in `persist` mode (today's
     default is `observe`): written paths carrying a given atom per user
     action. Factoring should visibly shrink it (§4).
   - **Kill criterion:** a primitive that, two quarters after landing, has
     no organic adopters *and* has forced a contract-breaking change on its
     migrated callers gets re-inlined and the census entry annotated. The
     library must be allowed to shrink.

**First wave** (one of each kind, to exercise the loop end-to-end):

1. **Generator retarget** (§7.1) — stop the bleeding before hand-carving;
   the factory must emit compositions while the rest of the wave proceeds.
2. **#12 PiecePicker** — pure interaction sub-pattern, 6 independent call
   sites, no platform dependencies.
3. **#24 dataset split** (dietary/emoji) — mechanical, de-risks the process
   and the migration/parity machinery on the easiest case.
4. **§5.4 group-chat consolidation** — the CFC before/after with the
   rewrite already in tree; lands #8 (ProfileIdentity, banking the
   identity-bug fix) and #10 as a side effect.

Auth consolidation (#1 v1) follows as wave 2 once the parity machinery
exists; TokenBroker's CFC end-state waits on §7.8 + phase-C, by design.

---

## 9. Risks and counterweights

1. **The recipe problem.** Bare blocks don't sell; "most people need recipes,
   not just a well-stocked kitchen" (c-264-fca167). Mitigation is §8.4 —
   primitives are supply-side infrastructure; the demand side keeps seeing
   assembled sets.
2. **Over-archeology.** "Primitive archeology is hard because you're trying
   to post-hoc rationalize a constructed/built object out of an organic,
   fractal, wrinkled thing… not guaranteed to be possible" (c-899-cda737).
   Guards: provenance-tagged evidence, per-tier promotion bars, the
   watchlist, and the kill criterion. A numbered catalog exerts gravity
   toward completing itself — hence §6's explicit "census, not commitments"
   framing and a first wave of four, not twenty-seven. When in doubt, leave
   it in the clay another quarter.
3. **Discovery gap.** Until telemetry and ranking exist, primitives spread
   by instructions (skills, catalog, generator prompt) and imports. The
   orphaned `suggestable/` case shows extraction without adoption mechanics
   strands work — §7.2 makes the adoption surface a landing requirement.
4. **Per-piece overhead and cross-space breakage.** More patterns per
   program is cheap (multi-file programs deploy as one piece); more *pieces*
   with cross-space wiring hits the CT-1188/CT-1105/CT-1090 class of
   blockers (§3.3). Default to authoring-time composition; reserve runtime
   piece-linking for genuinely independent lifecycles.
5. **Fork vs attestation tension.** The strategy celebrates savvy users
   tweaking patterns — but a tweaked primitive is a fork that loses any
   future `writeAuthorizedBy` attestation, cutting against the vet-once
   economy of §4. Data-flow provenance doubles as remix attribution
   ("which creator deserves the credit", c-360-fdc390), so the remix graph
   and the trust story can share machinery — but someone must design that
   intersection; this doc only names it.
6. **Amplification grotesqueness** (c-075-ffb292). Ranking amplifies biases;
   when the ranking layer arrives, accept-into-your-own-fabric as the
   costly, aligned signal (c-421-afc285) is the existing mitigation — out of
   scope here but named so the primitive layer doesn't pretend it solves it.
7. **Integrity is staged.** CFC integrity propagation (`TransformedBy`
   minting, verified code identity for `writeAuthorizedBy`) is phase-C;
   §4 leans on confidentiality mechanics implemented today (flow labels —
   currently `observe` mode by default — sink gating, trusted surfaces,
   row/column labels) and degrades gracefully if integrity lands late. The
   "vet a primitive once" payoff explicitly waits on it.

---

## Appendix A: source map

- **Corpus surveys:** packages/patterns A–F and G–Z sweeps (§3, §6 evidence;
  file paths inline). Headline line counts, the `Confidential<T> = T` stub
  location, the registry "THREE places" comment, the cfc/README promotion
  bar, the five `as never` casts, and the identity-idiom bug were
  independently re-verified by a fact-checking agent against the tree.
- **Runtime composition model:** `docs/common/patterns/composition.md`,
  `packages/runner/src/builtins/wish.ts`, `container-protocol.ts`,
  `record/registry.ts`, `packages/home-schemas/`,
  `CROSS_SPACE_STREAM_HANDLER_INVESTIGATION.md`.
- **CFC:** `docs/specs/cfc-s16-default-transition-design.md`,
  `docs/plans/runner_cfc_implementation.md`,
  `docs/specs/sqlite-builtin/06-cfc.md`, `packages/patterns/cfc/`
  (INDEX.md, README.md, trusted-surfaces/, admin/, prompt-injection/),
  `packages/api/cfc.ts`.
- **Strategy:** `~/Code/loom-files/Work/Strategy/synthesis/` (02, 04, 05, 06,
  08, 10), `context/talk-cultivating-infinite-software.md`,
  `research/payments/ecosystem-payments-revised-architecture.md`,
  `Unfiled/Loom/` (enricher-ecosystem docs); card-web refs cited inline as
  `card.web:c-…` (resolve via `python3 -m card_web get <ref>` from
  `loom-files/.scripts/shared/`).

## Appendix B: load-bearing card citations

c-899-cda737 (primitive archeology defined) · c-840-ece996 (archeology as
strategy) · c-443-fce753 (taint vs box size) · c-714-dfe813 (granular pull) ·
c-421-afc285 (onebox for turing-complete things) · c-543-ffc925 (rank running
code safely) · c-773-cda780 (usage counts first) · c-800-cfe410 (savvy-user
incentives) · c-906-ada936 (killer building blocks) · c-959-dcd257 /
c-264-fca167 / c-324-dbf673 (lego sets & the recipe problem) · c-831-bde286 /
c-887-fbc491 (Coasian chunkiness) · c-071-fbd448 (rot vs LOC) ·
c-603-cfc845 (patterns as containerization) · c-719-bfa931 (IFC needs a swarm
of tagged blocks) · c-075-ffb292 (amplification grotesqueness) ·
c-006-edf579 (clay first) · c-765-faf061 / c-638-ebd134 (escape-hatch
sublimation) · c-265-aec140 (escape-hatch abduction) · c-863-eac691
(combinatorial coverage) · c-360-fdc390 (provenance as remix attribution) ·
c-734-aed291 / c-447-fbe816 / c-165-fed920 (named primitive wishes).
