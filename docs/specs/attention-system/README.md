# Attention System

A canonical runtime substrate for managing user attention: a per-user
ledger of **notices** written by a single trusted **steward** under the user's
own **policies**, **seen-state over artifacts** derived from the version
history the runtime already keeps, and **surface adapters** that project the
ledger onto shell lanes, digests, and (eventually) OS notifications. An OS
push notification is the *most degraded projection* of this system, not its
model.

## Status

Draft — seeking framework author review. None of this is implemented in labs
today (§3 inventories what exists), and §10 names the net-new runtime surface
this design requires — most importantly the **changes projection** (§10.1), a
small read-only query primitive over shipped memory-v2 machinery, and a
cross-principal append gate for the notice inbox (§10.2). The Loom product's
in-flight attention framework and Pond's spatial shell are the first intended
consumers; this spec defines the runtime primitives their product surfaces
should compile onto, so each stops hand-rolling its own attention state
(Appendix A maps Loom's candidate shape onto the envelope; Appendix B walks
fourteen stress-case user stories). Derived from the 2026-05-21
multi-user/notifications design sessions and the 2026-07 attention reframe;
revised 2026-07-12 across five adversarial review rounds (runtime + product;
Android-as-gold-standard + primitive-shape + parsimony; user-story grading +
naming ergonomics; a second story round that re-verified fixes and added
first-contact, catch-up, profile, and cold-start coverage; a coherence +
idiomaticness + pragmatism round that consolidated the raise-authority rule,
merged phantom concepts, and split this spec into its current directory
form: [`changes-projection.md`](./changes-projection.md) — independently
approvable — plus [`prior-art.md`](./prior-art.md),
[`stories.md`](./stories.md), and [`loom-mapping.md`](./loom-mapping.md)).
Revised 2026-07-13 on framework-author review (PR #4691): the notice
lifecycle is decoupled from version machinery (once disposed, disposed;
new news is a new notice; **watchers** — §5.1 — bridge entity changes to
notices, with the generic seen watcher preserving cross-device
auto-retract); intake is split space-wide vs directed-via-profile with
home-space aggregation (§6.1); the pattern-author surface is specified
(§6.1b and [`authoring.md`](./authoring.md)); sqlite write-authorization
is assessed easy and the ledger's steady-state backing accordingly
(§4.5, §10.3).

## Last Updated

2026-07-12

## Summary

Every existing notification system is biased toward interruption because the
*emitter* chooses how loudly to surface, and emitters' incentives favor
loudness. This design inverts that: **sources only post notices with a
posture hint; the user's steward — running with the user's policies,
structurally on the user's side — decides**. The runtime's job is to make
that inversion enforceable (CFC write-gating on the canonical ledger), cheap
(derived queries over stores the user already holds, no second event
journal), and portable across surfaces (one envelope, per-platform
adapters).

Five load-bearing moves:

1. **One ledger, one posture scale.** Notices land on exactly one rung of an
   ordered scale — `silent` → `review` → `heads-up` → `interrupt` — and the
   rung is the promise made to the user (§4.2). The system is biased
   downward: a source earns its way up through **learned policies** the user
   can read and edit (§7), and every dismiss-without-open pushes its future
   notices back down.
2. **The steward is the only writer.** The canonical ledger carries a
   `writeAuthorizedBy` claim; untrusted patterns can post candidates and
   render their own local views, but cannot spam the ledger (§6).
3. **Attention over artifacts is derived, not posted.** The runtime already
   versions every entity (memory-v2 `seq`), and the version already crosses
   the wire on every query result; exposing it is one small read-only
   primitive, the changes projection (§10.1). Seen-state is one small
   relation — last observed version per (user, entity) — and "unseen
   change", "while you were away", and the artifact lifecycle all fall out
   as joins against it (§5), while **watchers** (§5.1) bridge it to
   notices without version machinery ever entering the notice contract. For in-fabric sources, a
   notice is a *view over* "an artifact you care about changed", which
   dissolves the "every pattern must remember to send notifications"
   problem.
4. **Policies are user-owned cells**, not steward code. The core ships a
   good-enough default fold; the bespoke last 20% ("library book due"
   escalations, quiet hours, per-thread mutes, nag-until-done) is data the
   user — or a pattern, on proposal, or the steward itself, legibly (§7) —
   writes.
5. **Multi-user needs almost nothing new.** A notice is a per-(user, notice)
   relation: a shared space posts one candidate and each member's steward
   lanes it independently. "Who has seen this" — and, per disclosure policy,
   "who has handled this" — is the same state contributed into shared space,
   read the other direction (§8).

### Division of labor

This spec owns **routing, terminal state, seen-state, and delivery**.
Everything upstream of a posted notice — deciding whether an agent may
*start* work, preparing material, continuity ownership, receipts, onboarding
interviews that seed policy — is product-side and stays there. A product
framework (e.g. Loom's attention framework) enters this pipeline as a
*trusted source* posting well-prepared candidates with a posture hint; the
runtime steward's job for such a source is cross-source arbitration and
enforcement of the user's posture clamps, not re-litigating the product's
preparation decisions.

### Vocabulary

*Notice* — the unit: a posted announcement with a destination, that waits to
be noticed. A **candidate** is a notice as posted, before the steward admits
it (assigning `id`, `posture`, `weight`) — the same envelope at an earlier
stage, exactly as `wish()` resolves `candidates` into a `result`.
*Disposition* — what the user (or the steward on their behalf) did with a
notice; the append-only log. *Steward* — the per-user trusted fold that admits
candidates, assigns postures, and guards the user's quiet; called a steward,
not a "ranker", because ranking is its most minor duty and it works for the
user, not the feed. (No relation to Loom's retired "Attention Steward"
auto-surfacing system — this is a routing fold, not a suggestion engine.)
*Ledger* — the notices store specifically. *Attention state* — the triple
of stores (notices, dispositions, seen — §4.5). *Lane* — a shell projection
over attention state (most lanes correspond to a posture rung; some, like
the snoozed lane, are lifecycle views). *Watch set* — the entity set whose
changes the user's attention system observes (§5). *Watcher* — steward-run
logic that turns watched changes into posted notices and reports moot
claims for retraction (§5.1); the generic seen watcher is built in,
per-kind watchers refine it. *Artifact* — a
user-meaningful entity, typically a piece's result cell; the spec says
"entity" where the memory-v2 identity (versioning, `seq`) is what matters.

## Goals

- A single canonical notice envelope and ledger that shell, product surfaces
  (Loom, Pond), patterns, and OS adapters all read.
- Make autonomous/agent work *visible* without interruption — the user can
  always see that something was done on their behalf, at zero notification
  cost ("quiet disposition" must not mean "invisible disposition").
- Structural downward bias: interruption is the exception and must be earned;
  the emitter cannot force it.
- User-owned, inspectable, editable routing policy — when the system
  mis-lanes something, the fix is a one-line policy edit, not a black box.
  This includes what the system learns on its own: learned policies are
  visible and editable, never hidden state.
- Close the loop without a context switch where the platform allows it:
  one-tap approve/deny/done and direct reply from the surface (§4.6).
- Per-viewer lanes over shared state: the same event can interrupt one member
  of a space and be texture for another.
- OS delivery (Web Push, APNs/FCM) as replaceable adapters over the same
  ledger, honoring per-platform replace/retract semantics and the notice's
  confidentiality labels (§9.3).

## Non-goals

- **Product surface design.** Which views exist (Today block, attention
  center, donut zones), their copy, and their capacity budgets are product
  decisions; this spec only guarantees the queries they need are cheap and
  the data they render is trustworthy.
- **Work-start authorization and preparation.** Policies governing whether
  an agent may autonomously begin work, budgets, authority ceilings, and
  continuity ownership are product-side (Division of labor, in the Summary). The runtime
  never decides what work happens — only how its results claim attention.
- **Policy seeding / onboarding flows.** How a product interviews the user
  and proposes an initial policy set is product-scope; the runtime primitive
  is only "patterns propose, the user disposes" (§7) — adoption *is* the
  write, and proposed-but-unadopted policies never enter the steward's fold.
  (One product obligation this spec *names* because safety depends on it:
  ship an emergency-sources policy pack through this same propose/adopt
  flow — §7, Appendix B.1.)
- **Coverage/miss measurement** ("earn the right to say all caught up") —
  product-layer analytics over the ledger; the ledger just has to be
  complete enough to measure.
- **V1 delivery breadth.** No SMS/email channels, no iOS Live Activities, no
  wearables. `time-sensitive`/`critical` OS interruption levels are not
  *implemented* in V1 (both need platform entitlements) but their adapter
  mapping is **reserved** (§9.3) so user-adopted break-glass policies have
  somewhere to compile when entitlements land.
- **A "list all members of a space" primitive.** The runtime deliberately
  lacks one (see `docs/specs/shared-profile-rosters.md`); multi-user features
  here are designed within that constraint, not around it.
- **Replacing source UIs.** A notice opens its focused destination (the
  artifact, the draft, the conversation); within a thread, the newest live
  notice displaces older ones (§6.4) rather than piling on.

## 3. Background

### 3.1 What exists in labs today

Effectively nothing:

- `packages/ui/src/v2/components/cf-toast/` and `cf-alert` are polished
  presentation components, but no toast provider is mounted anywhere in
  `packages/shell` — the only real usage is a demo pattern
  (`packages/patterns/mobile-app-demo.tsx`).
- The shell header (`packages/shell/src/views/HeaderView.ts`) has no bell, no
  badge, no activity surface.
- No read/seen tracking exists anywhere — `packages/patterns/group-chat-room.tsx`
  has no read receipts or unread counts.
- No push transport of any kind: no service-worker push, no APNs/FCM, no
  device registration in `packages/toolshed` or `packages/identity`.
- The two adjacent primitives are ingress- or scheduling-shaped, not
  attention-shaped: webhook ingress delivers external POSTs into a reactive
  stream (`docs/specs/webhook-ingress/`, `packages/toolshed/routes/webhooks/`),
  and `packages/background-piece-service` polls registered pieces every ~60s
  with documented reliability caveats.

Meanwhile the products above the runtime are already building attention
systems without runtime support: Loom's attention framework (in flight, on a
feature branch as of 2026-07-12) defines *prepared claims*, an
attention-posture ladder, a capacity-bounded Today block, and a
default-weekly digest — materialized in product-local storage; its current
"unseen" affordance is a localStorage last-seen timestamp per browser.
Pond's donut prototype ranks pieces spatially by an attention score. And
one surface is already *live*: Loom mobile's **Home Briefing** pipeline (a
curator agent authors a briefing; the daemon projects it into a fabric
cell; the mobile home renders headline + items) — a digest adapter waiting
for a ledger, whose `BriefingItem` is a near-degenerate notice and whose
recap section is a natural early changes-projection consumer
([`loom-mapping.md`](./loom-mapping.md)). All of them need the same
substrate: durable per-user seen-state, a trustworthy canonical ledger,
and per-user routing policy. This spec is that substrate —
and only that substrate; Loom's work-start machinery and stance-bearing
judgment policies stay product-side (Division of labor, in the Summary).

### 3.2 Prior art, compressed

Full reviewer background on the OS notification stacks — Android's channels
and `notify(id)` model, iOS's interruption levels and Notification Service
Extension, Web Push, and the seven things the shared
emitter-priced-snapshot-to-device-tray architecture structurally cannot do —
lives in [`prior-art.md`](./prior-art.md). The relationship in three lines:

- **Adopted**: stable-id replace/retract; only-alert-once (made unconditional
  for the emitter); lockscreen visibility tiers (generalized to CFC labels);
  actions + inline reply (re-based on session authority); the
  interruption-level vocabulary as the posture scale's OS compile target.
- **Inverted**: the emitter never prices loudness (`postureHint` is
  advisory; the steward assigns; raising is policy, §4.2/§7); binary app
  permission becomes condition-bearing policy data; invisible adaptive
  ranking becomes legible learned policies.
- **Added** (structurally impossible there): notices live-tied to their
  subject (handle anywhere → retract everywhere); derived notices (no
  forgot-to-notify failure mode); cross-person quiet and escalation as
  single policy records; one queryable ledger with OS trays as degraded
  projections. Inherited honestly: delivery still rides APNs/FCM/Web Push
  and their entitlement gates — we compile down, we don't replace.


## 4. Model

### 4.1 The unit: a notice

A notice is a **posted announcement with a focused destination** — it waits
to be noticed; it does not get to decide how loudly. Borrowing the product
framing: a raw source occurrence, or the bare fact that an agent ran, does
not deserve a notice. The envelope therefore always carries *where to go*
(`subject`, and optionally a distinct `target`) and *what is ready there*
(title/body describing the prepared result or the change), never just
"something happened".

The runtime does not — cannot — enforce that notices are well-prepared; it
enforces the things preparation depends on: who may write the ledger, which
posture a notice actually gets, and that handled notices retract everywhere.

### 4.2 The posture scale

One ordered scale:

```text
suppress < silent < review < heads-up < interrupt
```

`suppress` is rank zero: never materialized for this user (distinct from
`silent`, which is recorded and findable). Every materialized notice
occupies exactly one rung, and the rung is a promise:

| Posture | Promise to the user | Typical projection |
|---|---|---|
| `silent` | "Recorded; you'll find it if you look." | seen-state dots on artifacts, history views |
| `review` | "Batched for your next review; no urgency." | digest, review queue — bounded history, not a feed |
| `heads-up` | "Look when you next check in; we'll hold it." | shell bell/badge count, quiet OS delivery |
| `interrupt` | "Worth breaking your flow for." | OS banner/sound, in-shell takeover |

Two invariants:

- **Downward bias — the raise-authority rule.** This is the spec's central
  invariant; it has exactly four tiers, and this bullet is its one canonical
  home (other sections reference it, never restate it):
  1. **Emitter fields never raise.** No field a source writes — hints,
     urgency copy, expiry times, self-declared `kind` — can raise posture.
     An emitter cannot buy `interrupt` with enthusiasm.
  2. **Shipped defaults may set floors up to `heads-up`**, and only when
     matching on **steward-verified facts** (e.g. `actor` is a verified
     human DID with an established relationship) — never on self-declared
     fields like `kind`, since declaring a kind would *be* choosing a
     baseline.
  3. **`interrupt` floors are user-adopted only** — hand-written or
     accepted through the propose/adopt flow (§7).
  4. **Learned policies only lower** (§7) — the system's own adaptation can
     quiet a source, never amplify one.
- **Attention ≠ confidence.** How sure the system is about a notice and how
  loudly it surfaces are separate axes. Uncertain-but-urgent goes to
  `heads-up` with its uncertainty stated (product copy; `ext` if
  structured); certain-but-routine stays in `review`.

**Why these names.** The rungs match the posture vocabulary the Loom
product already uses (silent memory → daily review → timely heads-up →
interrupt), so the first consumer maps 1:1; each is an everyday English
word whose plain meaning *is* the promise; and the scale is ordinal in
exactly one dimension — how much of the user's present moment the notice
claims (none / none-unless-sought / a scheduled batch / the next voluntary
check-in / right now). That is deliberate contrast with the OS
vocabularies: Android's `MIN < LOW < DEFAULT < HIGH` are magnitudes in an
unnamed dimension, and iOS names its sound-making default `active` — a
word that conceals the cost. Naming the top rung `interrupt` makes the
cost legible where it matters most: **the name is the consent dialog**
("allow this source to *interrupt* you?"). Where the wider ecosystem has
converged on a word, we use it: `silent` is Web Push's `silent: true` and
Android's shade section of the same name (iOS calls this `passive`). One
term-of-art collision, named so no adapter author discovers it the hard
way: Android's "heads-up notification" is their *peek banner* — loudest
delivery, our `interrupt` — whereas this spec's `heads-up` is the plain
English idiom ("just a heads-up"): quiet, held, non-interrupting; the
compile targets in §9.3 disambiguate. And `review` has no OS analog
because the capability doesn't exist there: no OS has a party that can
batch across sources (prior-art.md, structural gap 4); the tier exists
here because the steward does.

Within a rung, ordering is the steward-assigned `weight` (§4.4) — an
opaque scalar that never crosses rungs and never gates delivery; it exists
so continuous surfaces (Pond's radial layout, "ordered by the steward"
lists) don't have to invent one.

### 4.3 The pipeline

```text
Sources                          post candidates (postureHint = advisory)
  agents/pieces running as me      │
  pieces I joined, running         │  per-source prefilter: "important within
    as others (group chat)         │   my world?" — cannot judge cross-source
  sharing directed at me           │
  artifact changes (derived, §5)   │
  external ingress (webhooks)      ▼
Notice inbox (durable; quota-gated append)       §6.1, §10.2
  ▼
Steward (per-user, trusted single writer)          §6
  folds candidates × policy cells (§7)
  assigns posture + weight; coalesces; writes the ledger
  ── writeAuthorizedBy gate: only the steward's verified
     module identity may write the canonical ledger ──
Ledger (per-user, durable, queryable)            §4.5
  ▼
Surfaces (pull-based readers)                    §9
  shell lanes / bell · product views (Today, donut, digest)
  · patterns rendering their own slices · OS adapters (push)
```

Untrusted patterns are not locked out of *rendering* — any pattern may show
its own local, clearly-attributed view of its own events. What untrusted code
cannot do is write the canonical ledger the shell and OS adapters trust.

### 4.4 The envelope

A source **posts a candidate**; the steward **admits it as a notice**. Same
envelope, two stages — and the stage split is structural: a candidate
*cannot carry* an assigned posture, because `posture`, `weight`, and `id`
exist only on the admitted type.

```ts
// Shown for illustration only.
// An entity version: an OPAQUE per-entity token read via the changes
// projection (§10.1) — the runtime provides ordering within one entity
// and equality; tokens from different entities are not comparable, and
// the encoding is not part of the contract (internally the space's commit
// clock, opaque precisely so global commit activity is not
// pattern-observable — see changes-projection.md). Used by the seen-state
// track (§5) and by watchers (§5.1); never by the notice lifecycle
// itself.
type EntityVersion = { space: string; token: string };

// What a source posts (into the notice inbox, §6.1). Everything on the
// candidate is descriptive or advisory — no field a source writes can
// raise loudness (§4.2).
type NoticeCandidate = {
  // THE entity this notice is about (a stored cell link, not a query
  // string). The notice is the invitation; the subject is the truth —
  // navigation, policy matching, and watcher-driven retraction (§5.1)
  // all key on it.
  subject: unknown;           // asCell: ["cell"]
  // OPTIONAL seen-watcher metadata: the subject's version, stamped by the
  // deriving watcher (§5.1) — or, for explicitly posted candidates, BY THE
  // STEWARD AT ADMISSION (one head read through the changes projection,
  // in the fold where cross-space reads already happen) whenever the
  // subject resolves to a versioned entity. That admission stamp is what
  // makes the generic seen watcher's auto-retract cover explicit posters
  // too (§5.1, authoring.md). Deliberately NOT part of the notice
  // contract — a notice's lifecycle never requires reading versions (the
  // contract: once disposed, disposed; new news is a new notice).
  subjectVersion?: EntityVersion;
  // Distinguishes claims from the same source about the same subject —
  // THE coalesce-vs-new-news switch: re-posting with the same eventKey
  // (or none) refreshes the prior claim in place; a new eventKey is a new
  // notice (which thread displacement then reconciles, §6.4). Feeds the
  // steward's id derivation (provenance × subject × eventKey), so it can
  // scope only your own claims. Contract-testable: same key never
  // re-alerts, new key never silently merges.
  eventKey?: string;
  // Source classification ("group-chat", "importer", "agent-run", ...).
  // BOUND BY THE STEWARD to the source's verified identity as a per-source
  // SET: first use of a kind adds it to the source's set (set growth is
  // itself a reputation signal), so a multi-genre trusted source (one
  // product emitting agent-run, calendar-prep, email-draft, ...) is
  // first-class, while kind churn still cannot launder anything —
  // kind-matched clamps follow the source identity, and kind can never
  // raise posture regardless (§4.2). Policy matching (§7) and
  // digest grouping (§9.2) key on it. Self-declared — see §4.2's
  // raise-authority tiers and the match-schema comment (§7) for what may
  // therefore never key on it.
  kind: string;
  // Grouping key for presentation AND displacement: within a threadKey,
  // only the newest live notice is visible (§6.4). One conversation, one
  // task, one agent run (threadKey = run id).
  threadKey?: string;
  // Who this notice is from/about (a DID when known): "Ana: running late"
  // vs "New message". Serves OS payloads, digest grouping, and §5's
  // "by whom" in one field.
  actor?: string;

  // Content. Snapshot at posting (title/body) plus the live destinations.
  title: string;
  body: string;
  // Variant for untrusted displays: lockscreens and push relays (§9.3).
  // When absent and labels forbid egress, adapters send a generic
  // envelope and fetch full content on unlock/open.
  redacted?: { title: string; body: string };
  // Where opening the notice goes, when that differs from subject
  // (default: subject). Navigation grain: navigateTo() navigates to a
  // PIECE — when the subject is finer-grain (one message, one entity of
  // twelve), target must resolve to the containing piece, with the
  // specific entity carried as a focus hint the destination renders
  // (changed-region emphasis rides the same hint).
  target?: unknown;           // asCell: ["cell"]
  // Prepared material (draft, diff, packet) when it is a different
  // artifact than the destination.
  attachment?: unknown;       // asCell: ["cell"]
  // Close-the-loop affordances rendered on the surface itself (§4.6):
  // approve/deny, done/later, inline reply — act without opening the app.
  actions?: NoticeAction[];
  // Live progress for ongoing work ("agent is 60% through your
  // refactor"). Progress updates are same-rung coalesces and therefore
  // silent (§9.3). Absent total = indeterminate. Rich live chrome (Live
  // Activities) is a later adapter track; this field is the floor every
  // surface can render.
  progress?: { done: number; total?: number };

  // Advisory only — the "requested" loudness. The steward assigns the real
  // posture; surfaces never read the hint.
  postureHint: "silent" | "review" | "heads-up" | "interrupt";

  postedAt: number;
  notBefore?: number;         // embargo: hold materialization until then
  expiresAt?: number;         // evaluate-on-read; swept terminally by the
                              // steward (§4.7, §9.3)

  // Opaque product round-trip channel. Disciplined by invariant: NO
  // runtime-derived predicate, NO steward fold step, and NO policy match
  // may read ext — it carries product fields (Loom's why_now, channel,
  // authorization_state — Appendix A), not routing inputs. An ext key
  // consumed by two independent products is a candidate for promotion to
  // the envelope (or a sign the envelope is wrong).
  ext?: Record<string, unknown>;
};

// An admitted notice IS a candidate plus the three fields only the steward
// may write. Two stages, one envelope, enforced by the type.
type Notice = NoticeCandidate & {
  // Identity — THE load-bearing field. Every surface adapter targets it
  // for replace/retract (iOS UNNotificationRequest.identifier +
  // apns-collapse-id, Android notify(id), Web Push options.tag). Derived
  // by the STEWARD from verified provenance (source space DID + entity id
  // + eventKey) — never from raw candidate-supplied strings alone, so a
  // hostile
  // source cannot collide another source's id to hijack coalescing or OS
  // replace/retract.
  id: string;
  // The promise made to the user (§4.2) — the only loudness surfaces read.
  posture: "silent" | "review" | "heads-up" | "interrupt";
  // Intra-rung ordering. Opaque; never crosses rungs; never gates
  // delivery (§4.2). Write discipline: assigned at admission and updated
  // only during coalesce — never by standalone re-ranking writes (ledger
  // writes wake lanes, §4.5); surfaces wanting continuous re-ordering
  // derive it at read.
  weight?: number;
};

// One button on a notice: approve/deny, done/later, inline reply (§4.6).
type NoticeAction = {
  key: string;                // semantic key, recorded in the disposition
  label: string;
  input?: "text";             // direct reply / free-text input
  // Durable endpoint in the source space — a durable array cell, NEVER a
  // Stream (stream payloads don't persist, §4.5). Acting appends
  // {key, input?, noticeId, at} under the user's ordinary session
  // authority — the same authority the user would have acting in-app.
  // No new trust surface.
  replyTo?: unknown;          // asCell: ["cell"]
};

// Append-only per-notice disposition log — what the user (or the steward,
// on the user's behalf) did with the notice. Deliberately small: opening
// a notice records as acted {key: "open"}; entity-level seen-state is NOT
// notice state (it lives in the seen store, §5, and feeds the generic
// seen watcher); "muted" is NOT a disposition (mute IS a policy write,
// §7). Cause-preservation across the three terminal types is the point:
// undo, history, and calibration all key on it.
type NoticeDisposition = {
  noticeId: string;
  at: number;
  // Which surface the disposition came from (shell, os-tray, digest,
  // ...). Lets policy decide e.g. "os-tray dismiss clears that device
  // only" (§9.3).
  surface: string;
  // Who did it: the user's DID, or the steward's module identity for
  // system dispositions (expiry sweep, thread displacement, watcher
  // retraction — §4.7, §5.1).
  actor: string;
  ext?: Record<string, unknown>; // product extension (e.g. calibration
                              // feedback like "not-useful"); same
                              // discipline as NoticeCandidate.ext
} & (
  | { type: "dismissed" }
  | { type: "archived" }
  | { type: "snoozed"; until: number }
  | { type: "acted"; key: string; input?: string }
);
```

Nothing stores `active`, `dismissed`, or `unread` flags — dispositions are
derived, and the lifecycle contract is deliberately simple (framework-author
review tightened it): **once a notice is disposed, it stays disposed; new
news is a new notice** (fresh event key, same `threadKey` — thread
displacement retires the old one, §6.4). No tombstone versioning, no
re-emergence, no version reads anywhere in the read path:

```ts
// Shown for illustration only.
const terminal = (n: Notice, log: NoticeDisposition[]) =>
  log.some((d) =>
    d.type === "dismissed" || d.type === "archived" || d.type === "acted"
  );
const visible = (n: Notice, log: NoticeDisposition[], now: number) =>
  !terminal(n, log) && !snoozed(log, now) &&
  (n.notBefore === undefined || now >= n.notBefore) &&
  (n.expiresAt === undefined || now < n.expiresAt);
```

Opening a notice (focused open of its target, from any surface) writes an
`acted {key: "open"}` disposition — terminal, so a notice handled on one
device retracts on every device and OS tray via ordinary store sync.
Satisfaction that doesn't go through the notice — you read the conversation
in the source UI; someone else handled it; the trip ended — is
**watcher-driven** (§5.1): the steward retracts with a system disposition
when a watcher reports the claim moot. The generic seen watcher covers the
common case (your own seen mark on the subject advanced past the notice's
posting) without any per-kind code; the Android auto-retract behavior —
view the source anywhere, the notification clears everywhere — survives
intact, just steward-side instead of read-path-side. Notices that must
outlive observation (medication must nag) carry a user-adopted `realert`
policy (§7): matched notices are exempt from watcher retraction and clear
only on an explicit terminal disposition.

A caveat on "cheap": pull-based scheduling makes *unobserved* queries free
(`docs/specs/pull-based-scheduler/README.md`), not observed ones. A mounted
lane is a live subscription over the user's own three stores — no per-notice
cross-space reads (cross-space reading happens once, in the steward's fold) —
and §4.5's write discipline bounds how often those stores change.

### 4.5 Storage

Attention state lives in the **user's home space** (home space DID = user
identity DID; the established home for durable per-user state, alongside
favorites and journal — see `docs/common/conventions/HOME_SPACE.md`). It is
three stores, and the three backings are not ad-hoc — they derive from a
2×2 of **writer authority × reactivity coupling**:

| | wakes lane queries | must never wake lane queries |
|---|---|---|
| **steward-only writes** | `notices` | *(learned policies live with §7 policies, not here — they are user-visible data)* |
| **any-surface writes** | `dispositions` | `seen` |

1. **`notices`** (the ledger) — written *only* by the steward. Backing for
   phase 1: a **durable array cell carrying the `writeAuthorizedBy`
   claim**, the mechanism already protecting profile links in production
   (`docs/common/conventions/HOME_SPACE.md`,
   `packages/runner/src/cfc/prepare.ts`). Coalescing (same `id`, subject
   advanced) is an in-place element update by the single leased steward
   instance (§6.2); coalescing **refreshes** content, `expiresAt`, and
   `progress` — but never resurrects a disposed notice: a dismissed `id`
   stays dismissed, and genuinely new news arrives as a new notice. This starts as an array cell rather than sqlite because
   `writeAuthorizedBy` is enforced on the cell-write prepare path and
   **does not gate `db.exec`** today — sqlite's implemented CFC covers
   confidentiality ceilings and row-label rules, not write authorization
   (`docs/specs/sqlite-builtin/06-cfc.md`). Framework-author review
   assessed adding that gate as easy (§10.3), so sqlite (better
   ranking/pagination/retention at volume) is the likely steady-state
   backing rather than a distant maybe; the remaining constraint is giving
   the ledger **its own database**: every
   `db.exec` serializes on the database handle cell's `rev`, so one shared
   db cannot hold both a steward-only table and an everyone-writes table
   without gating both or neither.
2. **`dispositions`** — written by every surface on every device. Backing: a
   durable array cell appended with **mergeable ops only** (`push`,
   `addUnique`), so concurrent dispositions from two devices merge against
   durable state instead of clobbering (memory is optimistic-concurrency
   with path-aware validation, not CRDT — and this design needs no CRDT:
   the canonical writer is singular per store, and dispositions are
   mergeable appends). The steward periodically compacts dispositions for
   terminal, swept notices.
3. **`seen`** — the seen store (§5), highest write rate in the system,
   ships in phase 0 and gets its own store so its writes never wake lane
   queries eagerly (lanes sample it; the join is evaluated on lane
   re-render, not per seen-write). One mark per entity, upserted:
   recommended backing is a small **sqlite database private to seen-state**
   (upsert-by-key is what SQL is for; no trust gating needed — every
   surface of the *user's own runtime* may write the user's own marks),
   with an array-cell fallback. The handle is instantiated and owned by
   the shell's home-context attention pattern (a trusted surface); other
   surfaces write marks through it, not via their own handles. Write
   discipline is part of the spec, not
   an optimization: seen = focused open (defined in §5), a mark is written **only
   when it advances** (`newSeq > seenSeq` — re-renders and repeat views are
   no-ops, which is also what breaks any render→write→render cycle) and
   **debounced per focus session** (at most one write per entity per
   focused open). A focused open of an entity writes the seen mark;
   opening *via a notice* additionally writes that notice's
   `acted {key: "open"}` disposition (§4.4) — two stores, two facts, no
   duplication: the mark is about the entity, the disposition about the
   notice.

Two rules regardless of backing:

- **Never model a store as `asCell: ["stream"]`** — stream cells are
  ephemeral (only the marker persists; payloads do not — see
  `docs/specs/space-model/4-cells.md`). Streams are append *endpoints*, not
  logs. This matters doubly for ingress: webhook payloads ride an ephemeral
  stream, so a **receiving handler must persist candidates durably at
  ingress** — otherwise external candidates arriving while no steward is
  live are lost permanently, not delayed (§6.1). The same rule is why
  `NoticeAction.replyTo` must be a durable cell, never a stream.
- **Never `set()` a whole array** that has more than one writer.

Retention: the steward's sweep terminally retracts expired notices (system
disposition — this is the *one* expiry mechanism; `visible()`'s expiry check
is the read-side shadow of it, so an expired notice is hidden immediately
and reaped eventually), **ages the bell** — unhandled `heads-up` notices
older than N days (default 7; realert-matched notices exempt) demote to
`review` as a posture transition, so a long absence returns to a digest,
not a wall of stale urgency — and reaps notices that have been terminal
longer than a retention window, plus their dispositions. Sweeping is an
steward duty (it owns the ledger), bounded and boring by design. Because
sweeping only reaps terminal rows, per-source intake quotas (§6.1) are what
bound a flooding source, not retention.

### 4.6 Actions on the notice

The most attention-respecting affordance in existing systems (Android
actions + direct reply) is closing the loop *without opening the app* —
approve/deny, done/later, reply, from the shade or the bell. The envelope's
`actions` field carries it:

- Rendering: shell lanes and OS adapters render `actions` as buttons (plus
  an inline input when `input: "text"`). Android compiles to
  `Notification.Action`/`RemoteInput`; Web Push to `showNotification`
  actions (buttons; inline text where supported); the shell renders
  natively. The PWA floor holds — Web Push supports action buttons.
- Acting: writes the ordinary `acted` disposition (`{key, input?}`), which
  is terminal; and, when `replyTo` is present, appends
  `{key, input?, noticeId, at}` to the reply cell in the source space
  **under the user's ordinary session authority** — exactly the authority
  the user would exercise replying in-app. No new trust surface: the
  source granted itself read on its own cell, and the user could always
  write there through the source's own UI.
- The "needs your approval" genre (Loom's `authorization_state:
  proposal-required`) compiles to `actions: [approve, deny]` — the approval
  affordance travels with the notice instead of forcing navigation.

### 4.7 Lifecycle

For review clarity, the full per-(user, notice) state machine, every
transition named once:

```text
(candidate) --steward fold: clamp > suppress--> ADMITTED
ADMITTED --now < notBefore--> EMBARGOED --time--> VISIBLE
EMBARGOED --steward: subject satisfied / superseded--> TERMINAL
         (a pre-scheduled reminder is retracted when its reason ends)
VISIBLE --user: dismissed|archived|acted (incl. acted{open})--> TERMINAL
VISIBLE --steward: watcher reports claim moot (§5.1) / thread displaced /
         expiry sweep (system disposition)--> TERMINAL
         (realert-matched notices are exempt from watcher retraction —
         they clear only on an explicit terminal disposition, §7)
VISIBLE --user: snoozed--> SNOOZED --until--> VISIBLE
VISIBLE --now ≥ expiresAt--> hidden immediately (read-side),
         TERMINAL at next sweep (write-side)
TERMINAL --(no exit for this id: disposed stays disposed; new news is a
         new notice in the same threadKey)
TERMINAL + past retention window --sweep--> reaped
```

Posture may change after admission (escalation raises it, collective
handling demotes it — §8); §9.3 defines alerting and retraction in terms of
these posture transitions. **Policy changes re-fold**: policy cells are fold
inputs, so a policy commit wakes the steward and admitted notices re-lane —
muting a thread demotes its existing notices, not just future ones.

## 5. Seen-state and attention over artifacts

The most common attention event in practice is not "interrupt me" — it is
"an agent (or another member) did work while I wasn't looking, and I need to
be able to *see that it happened*". That is not a notification; it is
seen-state.

**The seen store** is one small relation per user: the last version of an
entity the user actually observed. "Observed" is defined strictly:
**seen = focused open** — the user navigated to the entity (or a notice
whose subject is the entity) and it was the focus of their attention.
Scrolling past a row in a list is *not* seen; rendering a lane is *not*
seen. This single definition is load-bearing three ways: it keeps unseen
dots honest, it keeps disclosed read-receipts meaningful (§8), and it keeps
seen writes rare (§4.5, seen store).

```ts
// Shown for illustration only.
type SeenMark = {
  entity: unknown;            // asCell: ["cell"] — the artifact/piece
  seenVersion: EntityVersion; // last observed version
  at: number;
};
```

Everything else is the **changes projection** (§10.1) joined against marks:

- `unseen(entity)` = `changes([entity], sinceBasis: seenMark.basis)` is
  non-empty → change dots on artifacts and their containers (space lists,
  home).
- **"While you were away"** = one `changes(watchSet, basis: seenWatermark,
  attribution: true)` call, grouped by run/thread then space, ordered by
  the steward. Renders as a pattern on the home context. This is the
  first-run view and the every-return view — the same query. The affordance
  must answer *what changed, by whom, since you looked* — the projection's
  `author` token gives session-grain, equality-comparable attribution
  from day one (§10.1; identity resolution is separately gated) —
  with a jump-in to the destination. Emphasizing the changed region at the
  destination (memory-v2 holds both versions; the diff is derivable) is
  the phase-1 stretch of this bar, not its phase-0 gate — but a bare dot
  that says "something happened" does not meet it at any phase (§4.1).
- **Artifact lifecycle** falls out of the same two numbers plus a timestamp:
  *fresh* (unseen changes) → *seen* → *stale* (untouched for N) →
  *archived*. No new subsystem.

**Derivation beats posting.** For in-fabric sources, a candidate is *derived
from* artifact-change + watch set — the attention system watches; patterns
just write their artifacts. The mechanism is the watcher (§5.1): version
machinery stays inside watchers and the seen-state track, never in the
notice contract. Explicit posting remains for sources with no artifact
(external ingress, transient events), but it is the minority path. This is
the platform's grain: derived state over stored state, and no parallel
event journal duplicating what memory-v2's commit log already records.

**Run-level grouping.** One agent run touching twelve artifacts must not be
twelve scattered dots. From phase 1, agent-shaped sources post one
receipt-shaped notice per run (`threadKey` = run id), and the
while-you-were-away view folds entity changes under the run's receipt by
**attribution**: changes whose `author` is the run's session group beneath
the receipt rather than appearing as free-floating dots.
(Attribution-based folding, not an envelope field — the changes projection
already carries the join key.) Phase 0 — dots only — does not have this,
which is a stated limitation, not an oversight: phase 0 makes agent work
*visible*; run-level legibility is phase 1's tracked follow-through (§11).

**The watch set** is not a fourth kind of policy — it is the entity set
handed to the changes projection, seeded by derived defaults
(*touched-recently ∪ agent-did-it-for-you*) and extended by explicit
watch/unwatch policies (§7). Getting the defaults right is an open question
(§12.2); getting them wrong in the "too broad" direction is the failure
mode to avoid (dots everywhere = dots nowhere).

### 5.1 Watchers — turning changes into notices

The bridge between the two tracks (seen-state over entities; notices) is
the **watcher**: steward-run logic that observes sources and, when a change
is *newsworthy for this user*, posts a notice — and, when a claim has
become moot, reports it so the steward retracts (system disposition). This
is the framework-author-preferred shape: entity watching is scoped out of
the notice contract entirely; a watcher per kind turns changes into
messages.

- **Per-kind watchers** know their world: a chat watcher posts one notice
  per burst of unread messages (fresh event key per burst, thread-displaced
  by the next) and reports the claim moot when the conversation's own
  read-marker advances; a deadline watcher posts the ladder rungs; an
  agent-run watcher posts the receipt. Watchers are ordinary pattern code
  folded by the steward — proposable, inspectable, per-source.
- **The generic seen watcher** is built in and covers every source with no
  per-kind watcher: it compares the user's seen marks against
  `subjectVersion` stamps — placed by the deriving watcher, or by the
  steward at admission for explicitly posted candidates with a versioned
  subject (§4.4) — and reports moot any notice whose subject the user has
  since focused-open. This is what preserves
  the cross-device auto-retract (read it anywhere → clears everywhere)
  as a default, with zero source cooperation. One carve-out: it **skips
  notices that carry `actions`** — an approval must not vanish because
  the user glanced at the itinerary; action-bearing notices clear on a
  disposition, expiry, thread displacement, or a per-kind watcher's moot
  report (someone else approved). The residual gaming surface — adding a
  decorative button to extend liveness — buys an emitter nothing above
  the `review` ceiling and spends the same quota and reputation as any
  other notice.
- Watchers run *in the steward's fold* (wake-on-commit / on-lease), read
  through the changes projection (§10.1), and write nothing directly —
  they produce candidates and mootness reports; the steward remains the
  only ledger writer (§6.2).

## 6. The steward

**One logical steward per user.** It admits candidates, folds policies,
assigns postures and weights, coalesces (same `id`, content refresh only —
never resurrection), applies thread displacement (§6.4), runs watchers and
retracts moot notices on their reports (§5.1), and sweeps retention (§4.5).

### 6.1 Intake: space-wide, directed, derived

Candidates must be **durable before admission**: the steward may be asleep or
absent (interim mode, closed clients), and ephemeral candidates would be
silently lost, not delayed. Three intake shapes, split by *addressing* —
the key multi-user fact being that another user's home space is unknowable
(only their **profile** is addressable):

- **Space-wide candidates** (the default): the poster stores the candidate
  **in the shared space itself** — a durable per-space notice list, written
  once under the poster's ordinary authority (Alice's DID posts; she never
  enumerates recipients, which the platform forbids anyway). Every member's
  steward reads the spaces the user has joined and lanes per its own
  policies. This is the cheap path and scales to public and
  many-reader spaces: posting cost is O(1), and paying attention is the
  *reader's* choice, which is the whole design.
- **Directed candidates** (mentions, DMs, explicit shares): addressed to a
  **profile** — the recipient's addressable identity — via the profile's
  notice inbox, a cross-principal, quota-gated append surface (net-new,
  §10.2): the write gate enforces per-source quotas against the *verified
  writer identity*, not self-reported fields. Each profile's inbox feeds
  **that profile's own steward and ledger** — there is no cross-profile
  aggregation in the runtime (a work source never learns the personal
  profile exists, §8); what looks like aggregation is the *device shell*
  holding sessions for all the user's profiles and rendering one bell over
  N independent ledgers.
  Until §10.2 lands, directed candidates rest in a durable per-source cell
  in the space where they arise and the steward reads them there
  (client-side interim), with quotas enforced at fold time — weaker (a
  flood bloats the source-space cell, not the inbox) but sound.
- **Derived candidates** need no posting at all — watchers turn watched
  changes into notices (§5, §5.1). They do need *reach*: a client-side
  steward reads joined spaces directly through the user's ordinary
  sessions; a server-side steward needs change notifications from other
  spaces, which is the **space-to-space change-notification** need —
  moving just a dirty bit between spaces — noted in §10.2 as shared
  infrastructure (the same need surfaces in other cross-space contexts;
  it should be designed once, not as an attention special).
- Webhook ingress: the receiving handler persists the payload durably at
  ingress (§4.5); the ephemeral stream is transport, not storage.
- Quota pressure and dismiss-without-open feed the same **learned-policy**
  signal (§7): the source's baseline clamps down, legibly.

### 6.1b Posting from a pattern

The authoring surface is deliberately the platform's most ordinary shape —
**a stream returned by a handler**: a pattern wishes or is handed a posting
endpoint; calling `.send()` with a `NoticeCandidate` invokes the endpoint's
handler, which appends the candidate to the right durable list (the shared
space's notice list, or a profile inbox for directed notices). The stream
is transport; the handler owns durability (§4.5's stream rule); the
steward folds from the durable lists. Pattern authors never touch the
ledger, never pick posture, and never track recipients — post once,
per-viewer routing is not their business. The full pattern-author guide —
what to post, threading, actions/replyTo, proposing policies, what you
cannot do — is [`authoring.md`](./authoring.md).

### 6.2 Trust and instance discipline

The ledger carries a CFC `writeAuthorizedBy` claim. Two viable bindings:

1. **Verified module identity** (recommended): the steward ships as a pattern
   with a content-addressed module identity; `writeAuthorizedBy` binds to it.
   The steward stays in pattern-space — inspectable, forkable in principle,
   updated like any pattern — and "trusted" means *this exact code*, not
   "runs on a server".
2. **Trusted builtin**: a runtime builtin id in the claim. Stronger, but
   moves the fold out of pattern-space and makes policy-fold evolution a
   runtime release.

Recommendation: (1), with the fold's *inputs* (policies) as data so the code
rarely needs to change. Note the identity subtlety: *acting as the user*
(session `as` / `actingPrincipal` = the user's DID) and *being authorized to
write the ledger* (module identity matching the claim) are two separate
checks, and the design uses both — every steward write is attributable
`onBehalfOf` the user and provably from the steward's code.

`writeAuthorizedBy` authorizes *code*, not an *instance*: two devices running
the steward both pass the claim. The single-writer premise therefore needs
instance discipline, not just CFC: **the interim client-side steward takes a
lease** (a mutex cell claimed with an expiry — the `tryClaimMutex` shape from the
fetch builtin's utilities, `packages/runner/src/builtins/fetch-utils.ts`) and only the leaseholder folds. Independent of the
lease, the fold is specified **idempotent and commutative over the notice
inbox** (deterministic ids; coalescing recomputes from subject state rather
than incrementally mutating), so a lease handoff or a brief double-writer
window degrades to wasted work, not divergence.

### 6.3 Execution

- **Target: the server-primary execution model**
  (`docs/specs/server-side-execution/`). With intake home-space-local
  (§6.1), the steward is a *standing registration on the user's home space* —
  work whose value is its effects rather than client-read output — woken by
  commits to the notice inbox, the policy cells, or forwarded watch-set
  events. Execution is attributed `onBehalfOf` the user. Named
  dependencies, since that spec's workers, registrations, and wake-on-commit
  are all **per-space**: standing registrations are its own later phase;
  scoped (`PerUser`) state claims are gated (its G16); server-side
  *cross-space* reads/wake are explicitly deferred there — which is exactly
  why intake forwards into the home space instead of the steward reading N
  spaces.
- **Interim: client-side, under lease** (§6.2). Until standing registrations
  land, the leaseholder client runs the steward as an ordinary piece. This
  degrades gracefully for in-fabric state (candidates are durable; folding
  happens on next lease) — what's lost is only *timeliness* while no client
  is open, which matters from phase 2 (OS delivery) onward and not before.
- **Not: `background-piece-service` as-is.** It is per-space (the steward is
  per-user), ~60s polling (the steward is wake-on-commit shaped), and its own
  README documents async-completion unreliability. If bps is pressed into
  interim service, treat that as scaffolding, not the design.

**Laziness.** The steward materializes *rows*; it does not keep derived
predicates hot. `visible()` evaluates on surface demand over the user's own
stores (§4.4). The one push-shaped duty is OS delivery (§9.3), which is
explicitly an edge adapter fed by wake-on-commit, not a hot loop.

### 6.4 Coalescing and thread displacement

Two mechanisms at two altitudes:

- **`id` is identity**: the same claim, refreshed. Coalescing updates the
  notice in place (content, expiry, progress) and never resurrects a
  disposed one — a source with genuinely new news posts a new event key.
  Identity is steward-derived from verified provenance (§4.4), so it
  cannot be forged.
- **`threadKey` is the thread**, and displacement is a *derived rule over
  it* — **scoped per verified source**: within (source identity ×
  threadKey), only the newest live notice is visible; older live notices
  in that scope are terminally retracted by the steward (system
  disposition) when a newer one is admitted. The scoping is load-bearing:
  `threadKey` is emitter-chosen and guessable (`conv:<id>`), so an
  unscoped rule would let a hostile source terminally retract a victim's
  live notice by posting into its thread — a quota-cheap
  denial-of-attention. Scoped, a source can only displace *its own*
  claims. `threadKey` may still *group* notices from different sources
  for presentation (§9.1); displacement never crosses sources. A prepared result
  therefore displaces the raw occurrence by *sharing its thread*, not by
  naming notice ids — no displacement chains, no tombstone bookkeeping for
  the emitter, and "the displaced notice's subject advances again" needs no
  special case (it is simply the thread's newest notice again).
  Cross-thread or multi-target displacement is deliberately not
  expressible; a consumer who needs it should make the case with a concrete
  scenario (§12.7).

## 7. Policies

A policy is a small declarative record the steward folds over — **data, not
steward code**:

```ts
// Shown for illustration only.
type AttentionPolicy = {
  match: {
    subject?: unknown;        // asCell: ["cell"] — a specific source/thread
    // Verified actor identity (DID). THE dimension for interrupt-bearing
    // floors: "messages from this person/number → heads-up". Steward-
    // verified, unlike kind.
    actor?: string;
    kind?: string;            // as bound by the steward, §4.4 — but note:
                              // self-declared at first posting, so an
                              // interrupt-bearing min matched on kind is
                              // first-declaration-spoofable by a NEW
                              // source; bind alert floors to actor,
                              // subject, or spaceDid instead
    spaceDid?: string;
    threadKey?: string;
  };
  effect: {
    // One clamp on the one ordered scale (§4.2):
    // suppress < silent < review < heads-up < interrupt.
    clamp?: { min?: "review" | "heads-up" | "interrupt";
              max?: "suppress" | "silent" | "review" | "heads-up" };
    // Exempts this policy's min from quiet-hours clamping (the babysitter
    // thread breaks through). User-authored only.
    bypassQuietHours?: boolean;
    // Nag-until-done: a matched notice is EXEMPT from watcher retraction
    // (§5.1) — it clears only on an explicit terminal disposition
    // (acted/dismissed/archived), never because a watcher judged it moot
    // or the user glanced at the subject — and re-alerts on this cadence
    // while live. The one consented exception to §9.3's alert-once rule.
    // User-authored only; the cadence needs timer wake (§10.5) to fire
    // between commits.
    realert?: { everyMs: number };
    coalesceWindowMs?: number;
    // Time-conditional clamp sugar: during these hours/days, apply
    // `max` (default "review"). days omitted = every day.
    quietHours?: { start: string; end: string; days?: string[];
                   max?: "suppress" | "silent" | "review" };
    watch?: boolean;          // extend/prune the watch set (§5)
  };
  reason?: string;            // human-legible: why this policy exists
  author: string;             // user DID; a pattern's module identity for
                              // proposals; the STEWARD's module identity for
                              // learned policies (see below)
};
```

**Composition is one formula, with a hard ceiling.** Effective posture =
`clampScale(baseline, max(matching mins), min(matching maxes))` where
**`baseline = min(postureHint, "review")`**. The ceiling is load-bearing:
absent it, a brand-new source with no matching max would get whatever it
hinted — the exact cold-start hole §4.2's tier 1 forbids. Raising above
the ceiling happens only through policy mins, under §4.2's raise-authority
tiers (shipped verified-fact defaults up to `heads-up`; `interrupt`
user-adopted only). Learned demotion needs no term of its own: learned
policies *are* maxes, absorbed by `min(matching maxes)`. **Maxes dominate
mins** on conflict, with one exception — a user-authored min marked
`bypassQuietHours` survives the quiet-hours max. `quietHours` is defined
as nothing more than a time-conditional max (default `"review"`; `days`
scopes it — "work sources suppressed on weekends" is `{quietHours:
{start: "00:00", end: "24:00", days: ["sat","sun"], max: "suppress"}}`).
The canonical case — "quiet hours 22:00–07:00, but the babysitter thread
always breaks through" — is two records and zero ambiguity.

- **User attention policies live in the user's home space** as ordinary
  cells (the space is single-user; no scope wrapper is needed). Two other
  policy kinds live *with the shared space they govern*, as `PerSpace`
  cells: the disclosure policy and escalation proposals (§8) — see §8 for
  how they reach the fold. The core ships a handful of defaults: messages
  from **verified human actors with an established relationship** (rosters,
  prior threads — rosters seeded by contact import at onboarding, so this
  works on day one) → `heads-up`; **first contact** from a verified human
  actor with no established relationship → `review`, presented as a
  distinct requests grouping in the review lane (§9.1) with a one-tap
  promote affordance that writes `{match: {actor}, clamp: {min:
  "heads-up"}}` through the trusted surface — legitimate strangers (the
  marketplace buyer, the new-school-year parent) are distinguishable from
  importer noise without being handed loudness, and both facts are
  steward-verifiable (DID checked; roster/thread absence checked);
  agent-completions → `silent` (visible as seen-state, never buzzing).
  All defaults obey §4.2's raise-authority tiers; there is deliberately
  no default involving `interrupt`.
- **Mute is a policy, not a special relation** (and not a disposition).
  "Mute this thread" writes `{match: {threadKey}, effect: {clamp: {max:
  "suppress"}}}`; the re-fold rule (§4.7) demotes existing notices too.
- **Patterns propose, the user disposes.** A pattern can ship a suggested
  policy with its artifacts ("library book due → heads-up 3 days before");
  adoption goes through a trusted surface, exactly like other user-consented
  writes — adoption *is* the write, and unadopted proposals never enter the
  fold. Two idioms this primitive must carry, because users won't write
  these policies unaided:
  - **The emergency pack** (product guidance; the runtime carries two
    invariants). Nobody writes an interrupt floor for their kid's school
    until the day it's too late, so products should propose a small
    break-glass set at onboarding — `{match: {actor | subject | spaceDid},
    clamp: {min: "interrupt"}, bypassQuietHours: true}` per source. The
    runtime invariants: interrupt floors bind to **verified identities**,
    never `kind` (a kind-matched floor is first-declaration-spoofable by a
    new source — the schema comment in `match` is this rule's home), and
    adopted floors compile to the OS's highest available interruption
    level (§9.3's reserved mapping). Honest residual: an emergency from a
    source the user never adopted and doesn't know lands at `review` — the
    price of the inversion, which the pack shrinks, not erases
    (walkthrough: `stories.md` B.1).
  - **The deadline ladder** (pure composition, zero new mechanism):
    long-lived obligations post their escalation ladder ahead of time —
    candidates at `notBefore` T-90/T-30/T-7, same `threadKey` (each new
    admission displaces the prior rung), ascending hints, plus a proposed
    min adopted once. Obligation met → subject advances → the steward
    retracts the pending rungs (§4.7). Walkthrough: `stories.md` B.9.
- **Learned policies: the reputation loop, made legible** *(phase 2 — the
  adaptive loop needs signal volume and its dynamics are open, §12.8;
  phase 1 ships only the invariant and the `author` slot)*. The downward
  feedback the spec promises (dismiss-without-open, quota pressure ⇒ the
  source's notices sink) has to live *somewhere*, and hidden steward state
  would break the inspectability goal. It lives here: the steward — which is
  already the trusted fold, not a third party petitioning for adoption —
  writes ordinary policy records (`author` = its module identity, `reason`
  = the evidence, e.g. "7 of 8 notices dismissed without open over 30d")
  into a designated **learned** section of the policy store. They are
  visible, editable, and deletable exactly like hand-written policies; a
  user deleting one is itself a signal. **Learned policies are maxes** —
  §4.2 tier 4: the system's own adaptation only lowers. This follows the
  platform's existing precedent for system-inferred-but-user-owned data
  (`packages/home-schemas/learned.ts`).
- **Product policy dimensions compile down.** Stance-like vocabularies
  (Loom's `attention-policy-v1`) do not ride an opaque field on runtime
  policies — there is deliberately no `AttentionPolicy.ext`, because an
  opaque blob on the user's routing rules would imply a second, shadow
  interpreter of the same cells. Product policy systems keep their own
  records and *compile* to plain runtime clamps/watches, exactly as a
  trusted source compiles its channel semantics to posture hints.
- **Policy privacy, honestly stated.** Policy cells are never directly
  readable by other principals — they are ordinary confidential home-space
  data. But *behavioral* inference cannot be fully prevented: in a space
  that discloses read receipts, a muted member's persistent silence is
  statistically visible to a patient observer. The runtime's guarantee is
  scoped: no direct exposure, and inference surface bounded by the space's
  own disclosure policy (§8, §12.5). Steward *output* ordering/timing is not
  considered a protected channel in v1.

## 8. Multi-user

Three properties, all falling out of "a notice is a per-(user, notice)
relation" plus existing constraints:

- **One candidate, N ledgers.** A shared space posts one candidate per
  event; each member's own steward lanes it under their own policies. A new
  message can be `interrupt` for the on-call member and `silent` for the
  member who muted the thread. The emitter cannot know or decide this —
  correctly so.
- **"Who has seen this" — and "who handled this" — is contributed, not
  enumerated.** There is no runtime primitive for listing a space's members
  or reaching into their home spaces
  (`docs/specs/shared-profile-rosters.md`), and this design does not add
  one. Shared attention state follows the roster idiom: members' runtimes
  write their own **seen marks and, per disclosure policy, terminal
  dispositions** into `PerSpace` state in the shared space — *if* the
  space's disclosure policy says to. Read receipts, "3 people haven't seen
  the new plan", and *"Bea already handled this"* are queries over that
  contributed state. Disclosing terminal dispositions matters because
  handling often doesn't touch the source artifact (triaged verbally,
  replied off-fabric): when the subject *is* mutated, everyone's notices
  coalesce or satisfy for free; when it isn't, a disclosed `acted` is the
  only retraction signal others can get. A per-space opt-in policy —
  *"acted-by-any-member demotes to `silent` for all"* — turns that signal
  into collective quiet. Disclosure is a per-space policy cell (some spaces
  want receipts, some don't); a member who discloses nothing simply doesn't
  appear — and, corollary, silently opts out of collective quiet, which the
  space's members should understand when choosing the policy.
- **Escalation across people is a policy — adopted, not imposed.** "If
  nobody attends to this within 2h, raise it to `heads-up` for the space
  owner" is a policy cell on the shared space. But a shared-space cell must
  not be able to raise posture for a member who never agreed (§4.2 tier 3),
  so escalation records are **proposals**: they enter a member's fold only
  once that member adopts them (a home-space policy referencing the space,
  written through the ordinary adopt flow — for the owner, typically at
  space creation). Shared-space policy cells (disclosure, escalation) reach
  the fold the same way candidates do: forwarded/read through the member's
  ordinary sessions (§6.1) — no new cross-space capability. Once adopted,
  it is evaluated by the owner's steward against contributed
  state. No siloed notification system can express this; here it is one
  record. (Escalation is a posture *raise* after admission; §9.3's
  transition rule makes it alert exactly once. Deadline-shaped escalation —
  "nobody acted" produces no commits — needs timer wake, §10.5.)

**Profiles.** A user with multiple profiles (work, personal) has one
attention system *per profile*: profile ≡ its own space graph ≡ its own
home space, so attention state, policies, and steward are independent per
profile by construction — nothing new to build, and no
cross-profile leakage to prevent (a work source cannot learn it's quiet on
the personal profile because it never met the personal profile). Merging
the two into one device's shell — one bell over N profiles' lanes — is a
shell/product presentation concern over N independent ledgers, not a
runtime concept. Context separation *within* one profile ("work spaces
quiet on weekends") is ordinary policy: `spaceDid`-matched `quietHours`
with `days` and a `max` of choice (§7).

## 9. Surfaces

### 9.1 Shell

The shell renders attention state; it does not own attention logic. Per the
"pattern on the context" resolution: the home/shell context declares how the
attention surface renders, so it is replaceable like the rest of the home
experience. Concretely:

- lanes: `interrupt` (modal-adjacent), `heads-up` (bell + badge count),
  `review` (digest entry point), `silent` (dots via seen-state, §5);
- unseen-change dots on artifacts and containers;
- a snoozed lane (snoozed notices must stay discoverable);
- notice `actions` rendered in place (§4.6);
- **focused opens** — never renders — write the seen mark, under §4.5's
  advance-only + debounced discipline. Rendering a lane writes nothing.

Presentation components exist (`cf-toast`/`cf-toast-provider`, `cf-alert`,
badge conventions); the net-new work is mounting them against ledger
queries. One CFC note for badge counts: aggregates over a rule-bearing
store refuse unless every row is readable by the counting principal —
for a home-space ledger this holds as long as notice rows' clauses always
include the owner; state that invariant in the schema rather than
discovering it when someone adds a per-row rule.

### 9.2 Digests

A digest is **bounded history, not a feed**: a periodic artifact-shaped
summary over the ledger and seen-state — quiet dispositions, artifact
updates, prepared material, grouped by `kind` — rendered by a pattern. The
runtime contribution is only that the queries behind it (terminal notices
since T, unseen changes since T, dispositions by surface) are cheap and
complete. Whether a digest's *summary* may itself claim `heads-up` is a
policy decision, default no.

### 9.3 OS delivery

Only `interrupt` (and optionally `heads-up`, quietly) ever reaches the OS.
The posture → platform compile table (which also disambiguates the
Android "heads-up notification" term-of-art collision, §4.2):

| Posture | iOS | Android | Web Push |
|---|---|---|---|
| `suppress`, `silent`, `review` | not delivered to the OS — in-fabric projections only (dots, lanes, digest) | — | — |
| `heads-up` | `passive` interruption level (quiet, Notification Center) | Silent-section importance (`LOW`) — **never** the "heads-up" peek banner | `silent: true` |
| `interrupt` | `active` | `DEFAULT`/`HIGH` (the peek banner Android calls a heads-up notification) | standard `showNotification` |
| `interrupt` + user-adopted break-glass floor (§7) | `timeSensitive` / `critical` (entitlement-gated; reserved mapping) | `HIGH` + DND-bypass channel | `requireInteraction` (weak approximation) |

Adapters compile the envelope down; the ledger stays canonical and
"Android-shaped" (live update + auto-retract), and platforms degrade from
there:

- **Alerting rides posture transitions, not writes.** A delivered notice
  alerts when it first materializes at an alert-bearing rung and again only
  when the steward *raises* its posture (escalation, §8); every same-rung
  coalesce — new message in the thread, progress tick, content refresh —
  **replaces silently** on every surface (Android `setOnlyAlertOnce`
  semantics, made unconditional: the emitter cannot choose to re-buzz).
  The invariant bends in exactly **one consented way**: a user-authored
  `realert` policy (§7) re-alerts a live matched notice on its cadence
  (and exempts it from watcher retraction, §5.1) — nag-until-done for
  medication-grade obligations, grantable only by the user. (A *fresh* notice first materializing at an alert-bearing rung
  alerting is the base rule, not an exception — but state its consequence
  honestly: alert-once is per-*notice*, so a source holding a user-granted
  floor can alert once per genuinely new event; per-*source* frequency is
  governed by intake quotas (§6.1) plus the user's grant, revocable by
  editing the floor.)
  Posture *demotion* and visibility flips are retraction triggers: the
  dispatcher retracts or downgrades the delivered surface when either
  occurs. And on device (re)registration after an offline gap, the
  dispatcher **damps the backlog**: it alerts only for notices newer than
  the gap start (newest per thread); older live notices land silently in
  lanes — the delivery log already records what was never delivered, so
  "returning from vacation" is a quiet catch-up, not a buzz storm.
  Without the base rule a coalescing thread would legally buzz on every
  advance — louder than Android, inverting the spec's promise.
- **Break-glass compiles to the platform's ceiling.** A user-adopted
  `{clamp: {min: "interrupt"}, bypassQuietHours: true}` policy (the
  emergency pack, §7) maps to the highest interruption level the platform
  grants us: today a maximally-prominent standard alert; when
  `time-sensitive` / `critical` (iOS) and DND-bypass channels (Android)
  entitlements land, *this same policy* compiles to them with no policy
  migration — the mapping is reserved now precisely so the novel emergency
  isn't re-designed later. (Implementing those entitlements stays a
  non-goal for V1; reserving their compile target is not.)
- **Replace/retract rides `id`** everywhere: iOS
  `UNNotificationRequest.identifier` / `apns-collapse-id`, Android
  `notify(id)`, Web Push `options.tag`. Two honesty notes. First,
  transitions are evaluated on commit-driven wakes and on read — **nothing
  wakes anything at `expiresAt`**: server-side timers don't exist yet (they
  are "(Future)" in `docs/specs/server-side-execution/`), so an expired
  notice may linger on an OS tray until the next wake re-evaluates it.
  Timer registrations that feed the dispatcher are named net-new work
  (§10.5); until they land, expiry is evaluate-on-read with explicitly
  stale OS surfaces (the steward's sweep is the terminal write-side, §4.5).
  Second, iOS replaces but does not tick (text refreshes when the shade
  reopens); genuinely-live notices (`progress`) render best-effort per
  platform, and rich live chrome (Live Activities) is a separate later
  track.
- **Confidentiality crosses the push boundary explicitly.** Push payloads
  and lockscreens are untrusted displays: they carry `redacted` when
  present, otherwise a generic envelope ("Update from <kind>"), with full
  content fetched on unlock/app-open (the conventional
  mutable-content/fetch-on-receive shape). Notices whose confidentiality
  labels forbid egress to the push relay get the generic envelope
  unconditionally — the same CFC labels that govern every other flow govern
  this one; a system that gates reading a version number (§10.1) does not
  get to mail full message bodies through third-party relays unexamined.
- **Two transports, not one.** Browser/PWA: Web Push (VAPID + service
  worker). Wrapped mobile apps: native APNs/FCM via the wrapper's plugin —
  embedded webviews do not get Web Push. The server side (toolshed) needs a
  device-registration table `{userDid, deviceId, transport, token}` and a
  delivery log `{noticeId, deviceId, platformIdentifier, deliveredAt,
  retractedAt}` so retraction can target what was actually delivered.
  Ship Web Push first; the envelope is transport-agnostic.
- **The PWA is the floor.** The canonical shape includes nothing that cannot
  be expressed on the most-constrained surface (action buttons included —
  Web Push has them); richer platforms are adapter opt-ins, not envelope
  fields.
- **Tray-dismiss is per-device by default.** An OS-tray dismissal writes a
  disposition with `surface: "os-tray"`; whether it terminates the notice
  globally is policy (default: clears that device only; the shell is
  canonical).

## 10. Net-new runtime surface

This design mostly composes existing primitives, but not entirely. Naming
the gaps is the point of this section — each is a prerequisite of the phase
that first needs it (§11), and each needs its own (small) design pass.

1. **Changes projection** *(phase 0)*. One read-only, one-shot,
   session-independent memory-v2 query —
   `changes(roots, branch, sinceBasis?, attribution?) → {basis, entries:
   [{id, version, deleted?, author?}]}` — giving a non-reactive head read,
   the changed-since enumeration behind "while you were away", and
   session-grain, equality-comparable "by whom" via opaque author tokens
   derived from the commit log. Versions and basis are **opaque tokens**
   (per-entity ordering only; the space's commit clock is deliberately not
   pattern-observable), the basis never samples the branch head (empty
   results return the caller's basis; late-readable entities replay), and
   unauthorized entities are indistinguishable from unchanged ones.
   Small because every load-bearing piece is shipped (the `head` table, the
   session catch-up delta, `FactEntry.seq`); a **security surface** because
   it exposes versions to pattern-space and adds an enumeration read, gated
   by exactly the read authority of the entities themselves. Full
   mini-spec, CFC story, and non-attention consumers:
   [`changes-projection.md`](./changes-projection.md) — deliberately
   independently approvable.

2. **Profile notice inbox append gate** *(phase 1; hardened by phase 2)*.
   A **profile-space** inbox cell with **restricted cross-principal
   append**: other principals' patterns may append directed candidates
   (the rosters contribute-your-own idiom, reversed) but the write gate
   enforces per-source quotas against the verified writer identity. It
   lives on the profile because that is the recipient's only addressable
   identity — home spaces are unknowable to others — and the home space
   aggregates across the user's profiles (§6.1). This is what makes
   dead-device delivery an authority question with an answer: "someone
   DMs me while all my devices are closed → my phone buzzes" is inbox
   append → aggregation → steward fold → dispatcher push. Related shared
   infrastructure, needed for derived candidates to reach a server-side
   steward at scale: **space-to-space change notification** (moving a
   dirty bit between spaces) — wanted in other cross-space contexts too;
   design once.
3. **Write-authorization for sqlite** *(pre-migration of the ledger to
   sqlite; not needed for phase 1's array-cell backing)*.
   `writeAuthorizedBy` is enforced on the cell-write prepare path only;
   `db.exec` today checks confidentiality ceilings and row-label rules but
   not write authorization. Framework-author review (PR #4691) assessed
   adding this gate as easy — so treat it as near-term, not speculative;
   it still needs a short security review of its own (whether any sqlite
   write path bypasses the `rev` cell write the prepare path would gate).
4. **Steward lease** *(phase 1)*. A small mutex-cell convention (claim with
   expiry, renew, steal-on-expiry) for single-instance election of the
   interim client-side steward (§6.2). Generalizes beyond attention.
5. **Timer wake** *(phase 2+)*. Executor-pool timer registrations
   (`notBefore`, `expiresAt`, snooze expiry, `realert` cadences, escalation
   deadlines, digest cadence) feeding wake-on-commit's machinery, so
   time-driven transitions don't depend on coincidental commits. Until
   then: evaluate-on-read, stale OS surfaces acknowledged (§9.3). Note this
   is the single load-bearing dependency for every deadline-shaped story
   (2FA expiry, medication, on-call escalation, visa ladder — Appendix B);
   it is small, but it is not optional for phase 2.
6. **Push transports** *(phase 2/3)*. Web Push then APNs/FCM: device
   registration, delivery log, retraction dispatch (§9.3). Net-new but
   conventional. The break-glass entitlements (`time-sensitive`/`critical`,
   DND-bypass channels) are a named later extension with their compile
   target reserved now (§9.3).

## 11. Phasing

Each phase is independently shippable and none re-shapes the data model.

- **Phase 0 — seen-state.** The changes projection (§10.1), the seen store
  with its write discipline (§4.5, seen store), unseen dots in the shell, and a
  "while you were away" home pattern. No steward, no candidates, no push.
  Acceptance bar: the user can see *what changed, by whom (session-grain),
  and since when*, and jump in — not merely that a dot exists.
  (Changed-region emphasis at the destination is a phase-1 stretch.) This
  makes agent work **visible** — the single most-requested product gap —
  while run-level *legibility* (one notice per agent run, not twelve dots)
  is explicitly phase 1's follow-through. Rough cost: ~9–13 eng-weeks,
  dominated by the changes projection's CFC review and focused-open
  instrumentation across shell and pattern surfaces.
- **Phase 1 — ledger + lanes.** Envelope, home-space `notices` (array cell
  + `writeAuthorizedBy`) and `dispositions` stores, notice intake (inbox
  gate §10.2, or interim source-space cells), a minimal client-executed
  steward under lease (verified-fact defaults + clamp composition + thread
  displacement), shell bell/lanes with notice actions (§4.6),
  receipt-shaped notices for agent runs with attribution folding (§5), the
  changed-region-emphasis stretch from phase 0. Policies v0: hand-written
  and proposed/adopted only (emergency-pack and deadline-ladder idioms,
  §7) — the learned-policy loop is phase 2. Rough cost: ~19–24 eng-weeks;
  the sleeper is the propose/adopt trusted-surface UX. Fund against a
  named first consumer surface (Appendix A note).
- **Phase 2 — server steward + first transport.** Steward as a standing
  registration on the home space under server-primary execution
  (dependencies named in §6.3 — high schedule risk: this sits behind
  another in-flight spec's later phases); Web Push with device
  registration, redaction rules, and retraction; digest queries; timer
  wake (§10.5), which activates `realert`, escalation deadlines, and
  timely `notBefore` materialization; the learned-policy loop (§7), which
  by now has signal volume to learn from.
- **Phase 3 — breadth.** Wrapped-app APNs/FCM; shared seen-state +
  disclosed terminal dispositions + escalation policies (§8); the ledger
  on sqlite once §10.3 lands; snooze/archive surfaced fully; `progress`
  rich chrome (Live Activities) and the break-glass OS entitlements as
  their own tracks.

## 12. Open questions

1. **Steward trust binding.** Verified module identity is recommended (§6.2),
   but the "wholly-system service" alternative keeps resurfacing; if the
   server executor itself writes the ledger, is that a builtin identity, and
   does that preempt user-forkable stewards? Resolve before phase 1.
2. **Watch-set defaults.** Touched ∪ agent-authored ∪ watched is the
   working answer (§5); validate against real spaces before hardening, and
   decide whether "touched" decays.
3. **Forwarder contract.** Cross-space reach for a server-side steward
   (§6.1, §6.3): who runs the forwarding (the emitting pattern? the user's
   runtime on visit?), and what happens for spaces the user hasn't opened
   in weeks? Partially subsumed by §10.2's inbox gate; the residue is
   *derived* watch-set events from spaces with no cooperating emitter.
4. **Seen-mark granularity.** Per-entity marks are the floor. Do container
   views (a space list showing N dots) warrant container-level marks, and
   does "seen the container" imply anything about members?
5. **Disclosure defaults** for shared seen-state and terminal dispositions
   (§8): receipts on or off by default, what the non-disclosing member's
   absence reveals, and how much of §7's policy-privacy bound this sets.
6. **Policy expressiveness boundary.** V1 is plain predicates. Content
   regexes and LLM-judged predicates ("only interrupt if actually urgent")
   are clearly coming — as steward inputs they inherit the steward's authority,
   so they need their own integrity story before admission.
7. **Displacement scope.** Thread displacement (§6.4) deliberately cannot
   express cross-thread or multi-target displacement. If a real consumer
   produces a scenario that needs it, revisit with that scenario on the
   table; until then the simpler rule stands.
8. **Learned-policy dynamics.** Decay (does a learned clamp relax after N
   weeks of the user opening that source's notices?), evidence thresholds,
   and whether a user deleting a learned policy suppresses re-learning for
   a period.
9. **Digest self-promotion.** May a digest claim `heads-up` on a schedule
   (§9.2)? Leaning policy-gated, default off.
10. **Convergence with product stores.** Loom currently materializes
    attention candidates in product-local storage with localStorage
    seen-timestamps. Appendix A is the field mapping; the remaining
    question is sequencing — which loom surface adopts the runtime ledger
    first, and whether loom's materializer becomes the trusted source or a
    second steward (the Division of labor section says: trusted source).
11. **`realert` bounds.** Minimum cadence, maximum duration, and whether a
    realert policy requires re-confirmation after N fires — the exception
    to alert-once must not become a resharpened nag machine (§7, §9.3).
12. **Ingress-actor verification.** The first-contact default and the
    emergency pack both bind to verified `actor` identities — but an actor
    arriving via external ingress (an SMS number, an email address) is not
    a fabric DID. What vouches an ingress identity into "verified human"
    (importer attestation? user confirmation on first sight?) decides how
    much of B.1 and B.11 external sources can actually reach.

## Appendix A — Loom mapping (pointer)

The field-by-field mapping of Loom's `attention-candidate-v1` onto the
envelope — including what deliberately does *not* cross the boundary
(Work-start Policies, continuity owners, stance vocabularies) — lives in
[`loom-mapping.md`](./loom-mapping.md). It is the first consumer's adoption
review artifact and churns on Loom's schedule. Adoption sequencing is open
question §12.10; phase-1 funding should be contingent on a named first Loom
surface (durable seen-state, then digest or bell — not the Today block).


## Appendix B — fourteen worked stories

Fourteen deliberately diverse stress cases from two rounds of user-story
review, each walking the mechanism end to end, with honest grades: **fully
built** (phase 3) and **phase 1 reality**. Grades were adversarially
re-verified against the spec *as revised* — where a fix earned a grade, the
fix is in the spec, and where a story still fails, the failure is stated.
The pattern in the grades is itself a finding: stories whose essence is
*time* or *other people* are phase-gated on timer wake (§10.5) and push
(§10.6); stories derivable from state the user already holds are strong
almost immediately.

| # | Story | Axis | Fully built | Phase 1 |
|---|---|---|---|---|
| B.1 | School emergency | must-interrupt, novel source | B− (actor-bound pack + reserved mapping; honest residual = `review`) | F (no push) |
| B.2 | Medication | seeing must not satisfy | A− (`realert` = terminal-only satisfaction) | D (no timer wake) |
| B.3 | On-call triage | multi-user coordination | A− | D (shared state is phase 3) |
| B.4 | Overnight agent run | quiet agent work | A | A− |
| B.5 | 2FA code | time-critical, brief | B | B− |
| B.6 | Social stream | high-volume, low-value | A | A− (quotas only; learning is P2) |
| B.7 | Medical privacy | lockscreen leakage | A | A− (trivially — no push yet) |
| B.8 | Approve rebooking | act from the surface | A− | B (shell only) |
| B.9 | Visa renewal | long-lived deadline ladder | B | C+ (evaluate-on-read only) |
| B.10 | Adversarial source | spam defense | A− | A− |
| B.11 | Marketplace stranger | first contact, unknown human | B+ (requests grouping + promote) | B− (shell only) |
| B.12 | Return from vacation | bulk catch-up boundedness | B (aging + reconnect damping) | B− |
| B.13 | Work/personal split | context separation | B (per-profile state + day-scoped quietHours) | B− |
| B.14 | Day-one cold start | defaults before any learning | B− (ceiling + roster seeding) | C+ |

The fourteen walkthroughs live in [`stories.md`](./stories.md); the table
above is the index and the honest summary.


## References

- `docs/specs/shared-profile-rosters.md`, `docs/specs/shared-profile-space.md`,
  `docs/common/conventions/HOME_SPACE.md` — multi-user substrate; the
  contribute-your-own idiom; `writeAuthorizedBy` in production.
- `docs/specs/server-side-execution/README.md` — standing registrations,
  wake-on-commit, `onBehalfOf` attribution (steward execution home; §6.3
  names this spec's dependencies on it).
- `docs/specs/memory-v2/` — `01-data-model.md` (seq, heads),
  `03-commit-model.md` (optimistic concurrency; commit-log `sessionId` /
  reserved `invocationRef`), `04-protocol.md` + `05-queries.md`
  (`SessionSync` catch-up, `FactEntry.seq` — the shipped machinery behind
  §10.1), `07-op-views-and-annotations.md` (the projection-family framing
  §10.1 borrows; the annotations plane it deliberately does not build on),
  `08-conflict-granularity.md` (mergeable ops).
- `docs/specs/sqlite-builtin/` (esp. `05-reactivity.md`, `06-cfc.md`) —
  seen-store backing; why trust-bearing tables wait on §10.3; `reactOn`
  coarseness; the rev-serialized write path.
- `docs/specs/space-model/4-cells.md` — stream-cell ephemerality.
- `docs/specs/pull-based-scheduler/README.md` — demand-driven evaluation
  (and its limits for observed queries, §4.4).
- `docs/specs/webhook-ingress/README.md` — external candidate ingress
  (durable persistence at the handler required, §6.1).
- `packages/home-schemas/` (`journal.ts`, `favorites.ts`, `learned.ts`,
  `home.ts`) — the durable-array + stream-append precedent; stable-key
  discipline; the `subject` field-naming precedent; the
  system-inferred-but-user-owned precedent for learned policies (§7).
- `packages/runner/src/cfc/prepare.ts`, `packages/runner/src/cfc/ui-contract.ts`
  — `writeAuthorizedBy` enforcement (cell-write path); trusted surfaces.
- `packages/runner/src/builtins/navigate-to.ts`,
  `docs/common/conventions/wish.md` — navigation from stored cell links;
  the `candidates` → `result` lifecycle precedent for candidate → notice.
- `packages/ui/src/v2/components/cf-toast/`, `cf-alert`, `cf-badge` —
  existing presentation components.
- `packages/background-piece-service/README.md` — why the steward does not
  run there.
- PR #4132 (annotation-primitive prototype, draft) — the documented
  anti-precedent for storage-side reverse indexes invisible to the reactive
  graph; §10.1's design constraint.
