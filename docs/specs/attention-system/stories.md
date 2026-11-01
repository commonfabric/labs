# Worked stories: the fourteen walkthroughs

Companion to [`README.md`](./README.md), which keeps the grade table as the
index. Section references (§n) refer to the main spec.

### B.1 The school emergency (must-interrupt, novel source)

Priya's kid has an allergic reaction at school; the office texts "come now."
Quiet is the failure mode — and the *novel* emergency is downward bias's
structural blind spot, because interrupt requires a pre-adopted floor that
by definition doesn't exist for a first-time source. The design's answer is
two-part, and honest about its limits: (1) the **emergency pack** (§7) —
onboarding proposes break-glass floors for school/daycare/alarm/fraud
sources at the moment the user is thinking about setup, via the ordinary
propose/adopt flow, **bound to verified identities** (`match.actor` /
`subject` / `spaceDid` — never spoofable `kind`); (2) the **reserved
break-glass mapping** (§9.3) — that adopted policy compiles to the OS's
highest granted interruption level, upgrading to
`time-sensitive`/`critical` when entitlements land, with no policy
migration. What the design will *not* do is let the message's own urgency
raise its posture — that lever, once granted to emergencies, is granted to
everyone claiming to be one. The residual, stated without varnish: an
emergency from a source the user never adopted and has no relationship
with lands at **`review`** (the first-contact requests grouping if it's a
verified human; §7) — a full miss until the next check-in. That is the
price of the inversion; the pack exists to shrink it, and how an
SMS-ingress phone number gets verified as a known actor at all is open
question §12.12.

### B.2 The medication reminder (seeing must not satisfy)

Elena must take tacrolimus by 9pm; a glance must not silence the reminder.
Her one-time adopted policy carries `{clamp: {min: "interrupt"},
bypassQuietHours: true, realert: {everyMs: 600_000}}`, and `realert` does
the whole job on its own: a matched notice is **exempt from watcher
retraction** (§5.1) — glancing at the reminder does not clear it; only a
terminal disposition (logging the dose → `acted`, or an explicit dismiss)
does — and it re-alerts on the cadence while live (§7, §9.3). The med
pattern may still re-post as the deadline nears (fresh event key, same
`threadKey`, each rung displacing the last), but that is *content
escalation* ("30 minutes left"), not liveness — the nag no longer depends
on the source's own timer discipline. Logging the dose advances the
subject artifact and the steward terminally retracts every pending rung,
including embargoed ones (§4.7). Phase gating is real: the cadence firing
between commits needs timer wake (§10.5) — before phase 2 this story is
not safely servable and products should not pretend otherwise.

### B.3 On-call triage (exactly one person must act)

A pager event lands in a three-person ops space at 11pm. Each on-call
member's rotation adopted `{match: {spaceDid: ops-space, kind: "pager"},
clamp: {min: "interrupt"}, bypassQuietHours: true}` — the `spaceDid` bound
matters: a bare kind-matched interrupt floor would be claimable by any new
source declaring `kind: "pager"` (§7). Bea acks from her lockscreen via
`actions` (§4.6): terminal `acted`, appended to the pattern's `replyTo`
cell under her session authority. Her runtime discloses the disposition
into `PerSpace` state; the space's opt-in policy "acted-by-any demotes to
silent for all" re-lanes Dana's and Sam's notices; posture demotion
retracts their banners (§9.3). If nobody acts in 15 minutes, the space's
escalation policy raises the owner's notice — a deadline evaluation that
needs timer wake (§10.5). One pager event, three independent ledgers,
collective quiet from one policy record — the part no siloed platform can
express.

### B.4 The overnight agent run (quiet work, visible)

Tomás's filing agent renames 200 documents at 3am. It posts *one*
receipt-shaped notice (`threadKey` = run id, `progress` ticking silently),
laned `silent` by the agent-completions default. The 200 changes are never
posted at all — they are derived: the while-you-were-away view runs one
`changes(watchSet, basis, attribution: true)` call and folds every entity
whose change `author` is the run's session under the receipt. Tomás sees
one line, expands it, jumps into anything suspicious with the changed
region emphasized. Zero buzz, full visibility, and the trust that makes
overnight agents acceptable — the design's home turf, strong from phase 1
(phase 0 gives the dots without the run grouping).

### B.5 The 2FA code (time-critical, worthless in minutes)

Marcus is mid-login on his laptop; the code arrives via his SMS forwarder.
Webhook ingress persists durably at the handler (§6.1); the candidate
carries `expiresAt: +5min` and a `postureHint: "heads-up"` (or `interrupt`
via a one-time adopted policy the OTP pattern proposed at setup — a
realistic single config). A second code coalesces silently over the first
(`id`-keyed replace, §9.3). Expiry hides the notice immediately on read;
the OS tray copy goes stale until timer wake lands — the spec's own §9.3
honesty note, and tolerable here because the user is at a client by
construction (they're logging in). One friction worth product attention: a
cautious confidentiality label pushes the code behind the generic envelope
— the rare notice whose whole value is lockscreen visibility; the OTP
pattern should set `redacted` to carry the code deliberately.

### B.6 The social stream (high-volume, low-value; downward bias earns its keep)

Nina's social importer posts ~80 like/follow events daily; she never opens
them. Intake quotas bound the flood at the write gate against verified
writer identity (§10.2). Her dismiss-without-open pattern becomes a
**learned policy** she can read — `{match: {kind: "social"}, clamp: {max:
"silent"}, author: steward, reason: "37 of 40 dismissed without open over
30d"}` — and the source can never buy its way back up (learned policies
only lower; §7). The review lane stays bounded; the weekly digest groups
the residue by `kind`. This is the reputation loop as a legible artifact
rather than a black-box feed model — strong from phase 1.

### B.7 Medical results on a shared-visibility lockscreen (privacy)

Ray's clinic portal posts test results; his partner sometimes sees his
lockscreen. The notice's confidentiality labels forbid egress to the push
relay, so the adapter sends the generic envelope unconditionally — full
content fetched on unlock/app-open (§9.3) — and `redacted` lets the product
choose neutral copy. Tray-dismiss on the shared-visibility device is
per-device (§9.3), so dismissing there doesn't clear his laptop. Muting the
thread is a policy write in his home space — never readable by the clinic
or anyone else, with the behavioral-inference bound §7 states honestly.

### B.8 Approving the agent's rebooking (act from the surface)

Grace's travel agent drafted a rebooking; the fare hold expires soon. The
notice carries `attachment` (the itinerary diff), `expiresAt` (the hold),
and `actions: [approve, deny]` with a `replyTo` cell (§4.6). Approve from
the lockscreen: terminal `acted` disposition + `{key: "approve", noticeId,
at}` appended to the pattern's reply cell under her ordinary session
authority; the acted terminal retracts the notice on every device. Two
honest caveats: acting from a locked device presumes an authenticated
session on-device, and a stale tray (§9.3) means she could approve a
just-expired fare between wakes — the reply cell's consumer must treat
replies as requests, not facts.

### B.9 The visa renewal (long-lived deadline ladder)

Hana's visa expires in October; she wants `review` at T−90, `heads-up` at
T−30, `interrupt` at T−7. The **deadline ladder** idiom (§7): the pattern
posts all three candidates ahead of time with ascending `notBefore` dates,
the same `threadKey` (each admission displaces the prior rung), ascending
hints, plus a proposed min she adopts once — at setup, when she's thinking
about it. Renewal filed → subject advances → the steward retracts every
pending rung including embargoed ones (§4.7). The gate is timeliness:
`notBefore` materialization is evaluate-on-read until timer wake (§10.5) —
nearly harmless at 90-day horizons for a daily shell user, unacceptable for
B.2's same-day cadence, which is why both stories hang on the same §10.5
line item.

### B.10 The adversarial source (spam defense)

"DealBlaster," installed for price tracking, turns hostile: floods
candidates, hints `interrupt` with `ext.urgency: "CRITICAL"`, tries to
collide the banking source's notification id, re-declares its kind as
"group-chat" to catch the human-messages default. Every defense is
structural, not heuristic: hints can't raise (§4.2); `ext` is quarantined
from routing (§4.4); `id` is steward-derived from verified provenance, so the
collision is impossible by construction; quotas bind to verified writer
identity (§10.2); dismiss-without-open writes a legible learned max (§7);
unconditional alert-once means even fresh-event-key spam can't re-buzz past
its clamped rung; thread displacement is scoped per verified source
(§6.4), so posting into the victim's `threadKey` cannot retract the
victim's live notices; and the kind-lie fails because above-`review` defaults
key on verified facts, never self-declared `kind` (§4.2) — declaring
yourself "group-chat" buys nothing without a verified human `actor` the
user actually knows.

### B.11 The marketplace stranger (first contact from an unknown human)

Maya lists a couch; a legitimate buyer — verified human DID, zero prior
relationship — messages her, and the first responder wins the sale. Before
the first-contact default existed, this story graded C: the buyer failed
the established-relationship test and sank indistinguishably into `review`
alongside importer noise, and Maya couldn't even hand-write a fix because
`match` had no `actor` dimension. As specced now: the message lands in the
**requests grouping** (`review` lane, distinguished presentation, quota-bounded — §7),
where it reads as a person, not noise; one tap on the promote affordance
writes `{match: {actor}, clamp: {min: "heads-up"}}` and the conversation is
loud thereafter. For time-critical listings, the sanctioned louder path is
the pattern proposing a listing-scoped min at listing time (the
moment-of-intent idiom). Downward bias holds: minting DIDs buys a stranger
nothing above the requests grouping. Note `threadKey` must be per-buyer, not
per-listing — thread displacement (§6.4) would otherwise let buyer #2's
inquiry retract buyer #1's.

### B.12 Return from vacation (bulk catch-up must be bounded)

Jonas is offline 16 days: ~300 notices, ~80 unseen artifact changes across
12 spaces. The joins do most of the collapsing for free — 16 days of one
chat is *one* notice (coalescing + thread displacement), everything he
handled from his phone abroad is already retracted everywhere (the seen watcher, §5.1),
expired 2FA/fare-holds are hidden and swept, matured ladder rungs displaced
each other. Two rules close the rest: the sweep's **aging** demotes
unhandled `heads-up` older than 7 days to `review` (§4.5), so the bell
shows this week, not a 16-day wall; and the dispatcher's **reconnect
damping** (§9.3) alerts only for notices newer than the gap — the return is
a quiet shelf plus one "while you were away" view (which is *specified* as
the every-return view, §5), not a buzz storm. Residual: whether
"touched-recently" survives 16 days in the watch set is open question
§12.2 — the vacation is the case that forces that answer.

### B.13 Work and personal (context separation)

Sofia keeps work and personal profiles and wants work quiet on evenings
and weekends, family always through, one device. Profiles are the coarse
cut: profile ≡ own home space ≡ own attention state (§8) — her work
steward and personal steward are independent by construction, and one
shell merging two ledgers is presentation, not runtime. Within the work
profile, context is ordinary policy: `{match: {spaceDid: work-space},
effect: {quietHours: {start: "18:00", end: "09:00"}}}` for evenings plus
`{quietHours: {start: "00:00", end: "24:00", days: ["sat","sun"], max:
"suppress"}}` for weekends (§7's day-scoped, max-bearing quietHours), and
`{match: {threadKey: family}, clamp: {min: "heads-up"}, bypassQuietHours:
true}` for the always-through exception. Every piece is a legible record
she can read back.

### B.14 Day one (defaults before any learning)

Riley is brand new: no learned policies, no adopted packs, defaults only.
The load-bearing line is §7's composition ceiling — `baseline =
min(postureHint, "review")` — without which a day-one source hinting
`interrupt` would simply get it (no learned history, no matching max: the
formula's original cold-start hole, now closed). The week then looks like:
messages from imported contacts → `heads-up` from day one (rosters are
seeded by contact import, §7 — without that, the established-relationship
default fires for nobody and the app reads as broken silence exactly when
it's being judged); strangers → the requests grouping; importers and agents →
`review`/`silent`, bounded by intake quotas until learned clamps
accumulate evidence. Honest weakness: the review lane is at its noisiest
in week one, before any learning — the propose/adopt idiom (patterns
proposing their own sensible clamps at install) is the mitigation, and
§12.8's evidence thresholds decide how fast learning kicks in.

