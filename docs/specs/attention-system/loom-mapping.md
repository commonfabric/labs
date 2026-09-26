# Adoption mapping: Loom's `attention-candidate-v1`

Companion to [`README.md`](./README.md). Section references (§n) refer to the
main spec. This file churns on Loom's schedule, not the spec's.

For the first consumer's adoption review. Loom fields → envelope. (Naming
flag: Loom's `claim_kind` vocabulary includes a value `notice`; product-side
that value should be renamed — e.g. `fyi` — before the runtime noun lands.)

| Loom candidate field | Envelope home |
|---|---|
| `id` / source identity | `id` (re-derived by steward from verified provenance) |
| subject / focused target | `subject` (cell link); distinct destination → `target`; `focused_view_fallback` → `ext` |
| prepared material | `attachment` |
| `title`, body copy | `title`, `body` (+ `redacted` where the product wants lockscreen-safe copy) |
| `why_now` | `ext.why_now` (product copy, runtime-opaque) |
| `claim_kind` (act-now / review / notice→fyi / …) | `kind` + `postureHint` (kind is classification; the hint is the loudness request derived from it) |
| `channel` (important-and-urgent / yours-in-progress / might-interest-you) | `ext.channel` — audience/genre, orthogonal to posture; product lanes render it |
| `relation_to_trigger` (augments / supersedes / resolves / …) | `ext.relation_to_trigger`, whole; *supersedes* additionally = share the trigger's `threadKey` (thread displacement, §6.4, does the retraction) |
| `authorization_state: proposal-required` | `actions: [{key:"approve"…},{key:"deny"…}]` (§4.6) + `ext.authorization_state` — the approval affordance travels with the notice |
| `authority_class` | `ext` (work-start domain, product-side per §Division of labor) |
| `not_before` | `notBefore` |
| sender / subject person | `actor` |
| delivery/interrupt eligibility | `postureHint`, clamped by user policy (§7) |
| feedback: done / later | dispositions `acted` / `snoozed` |
| feedback: never-for-this-class | a policy write (`clamp.max`) via the trusted surface |
| feedback: not-useful | disposition `dismissed` + `ext.feedback: "not-useful"` (calibration signal round-trips to the product) |

Not mapped, deliberately: Work-start Policies, continuity owners, typed
receipts' internals, stance vocabularies — upstream product machinery
(§Division of labor); stance policies compile down to plain clamps/watches
(§7). A receipt *summary* enters as an ordinary candidate.


## Already live: the Home Briefing pipeline

The mapping above targets the `attention-candidate-v1` draft, but the
surface actually shipping today is Loom mobile's **Home Briefing**: a
curator agent authors a briefing (`.Fabric/briefing.json`), the daemon
validates and projects it into a dedicated fabric cell, and the mobile
Home renders headline + blocks/items with tap targets and a staleness
label (`commontoolsinc/loom`: `.ops/prompts/sweep-curator.md`,
`.ops/patterns/cf-loom-mobile/briefing.ts`,
`.ops/services/loom-daemon/sync/briefing-cell.ts`). Fit with this spec:

- The curator's governing rules (*write about the user's world, never the
  machine*; *"you're clear" is a real answer — never manufacture content*)
  are the calm thesis, currently enforced in a prompt with no runtime
  underneath.
- `BriefingItem` (`label`/`sublabel`/`badge`/`target`) is a near-degenerate
  notice (`title`/`body`/`kind`/`subject`); the briefing's end-state under
  this spec is a *view over the notice ledger* (a §9.2 digest surface),
  not a bespoke store.
- The recap section is a natural early consumer of the changes projection.

Adoption path: the briefing folds into the notice/seen-state model from
the Loom side as phases land; no spec changes required.
