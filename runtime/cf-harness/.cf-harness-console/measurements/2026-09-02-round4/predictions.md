# Round 4 pre-registration — DRAFT for Ben's review before any provider turn

The system under measurement changed (patternRefs #6667, honest tool
descriptions, Sol default #6636, skills pipeline #6644/#6668, completion
contract #6663), so the 2026-08-31 baselines describe a system that no longer
exists. This round re-baselines and decides three ships: the parent default,
the child bullets, and whether the structural channel pays.

Operator rulings folded in: the skill cell uses an INNOCUOUS skill, not Plaid
(candidate found: `phuryn/pm-skills/swot-analysis`, single SKILL.md, passes
the whitelist; its neighbour `deanpeters/.../swot-analysis` carries examples/
and template.md and will refuse — same query, both behaviours). V's seams wait
for this round. Contract is safekept as CT-2155.

## Fixed conditions
Model: gpt-5.6-sol (the new default; terra comparison NOT in this round — one
variable at a time, and tier effects are already characterized). Fabric:
fresh current-main toolshed, TOOLSHED_GIT_SHA supplied, --expect-git-sha +
--base=origin/main on every batch. Substrate pre-flight (docker, meta sha,
sacrificial probe) before every block; admissibility re-read before every
composition batch. Publishes are recorded-only; corpus expected 29
discoverable throughout, verified per cell. Console restarted per prompt
condition; flag checks in both directions from artifacts per V2-style cell.

## Block 1 — parent prompt: none vs historic vs default-candidate
Suites: composition four + standing six (over-fire lives on the reuse suite).
Cells: P-none (no parent prompt), P-hist (byte-identical 2026-08-29 prompt),
P-cand (NEW text below, written from the audit's dispositions).

Predictions/falsifiers:
- P-none: composition ~0 (replicates); patternRefs unused or nearly (the
  field is schema-visible — spontaneous use >2 delegations would be a real
  surprise worth its own note).
- P-hist: composes (replicates V2) but through prose handoff; refs unused;
  compile burn comparable to 2026-08-31 V2 (9-22 per composing cell).
- P-cand: composes at >= P-hist rate AND compile burn per composing task
  drops >= 30% vs P-hist (shapes now cross) AND over-fire drops (reuse suite:
  fewer whole-wraps where run-whole was right; friends-birthdays/trip
  mockup-wraps are the canaries) AND >= half of composing delegations carry
  patternRefs. Falsified by: burn not dropping, or composition rate dropping,
  or refs unused (then the channel needs the prompt to teach it harder — a
  finding, not a failure).

### The default-candidate parent prompt (the text under test)
Drafted from the audit: keep the historic prompt's decompose-and-search core,
replace the blanket import instruction with a decision policy, teach the
channel. ~14 lines:

> You are working in a Common Fabric harness console. You build what the user
> asks for by delegating to a pattern-author subagent, which authors and runs
> pattern source and hands you back a reference to a result cell.
>
> There is a pattern index of published patterns. Search it yourself with
> search_patterns before you delegate anything. It answers with each
> pattern's kind — "part" (composable, carries schemas) or "app" (a finished
> whole) — plus its shapes and import specifier. Source never appears and you
> never need it.
>
> Take the request apart before you build. Search on the verbs — "sort table
> column", "toggle item done" — not only the user's nouns.
>
> Then decide, per hit you intend to use: if one entry answers the whole
> request, run it by patternId — do not wrap a working whole in new source.
> If entries answer parts, attach them to your delegation as patternRefs so
> the author receives their real shapes; say in the goal how they combine.
> Building from scratch is the fallback when the index answers nothing, not
> the default.

## Block 2 — V1: the child's composition bullets
Under the Block-1 winner only. Cells: child bullets present (default) vs
withheld (--no-child-composition-guidance). Prediction: no significant
difference (audit hypothesis: the bullets are dead weight once the parent
decides). Falsifier: composition rate or burn moves materially with bullets
withheld — then they stay. Decides delete-or-keep.

## Block 3 — the skill cell (innocuous, per Ben)
Config: CF_HARNESS_SKILLS_REGISTRY_URL set. One task, phrased with no mention
of skills or the registry: "Give me a SWOT analysis worksheet for a small
bakery — somewhere I can fill in each quadrant and see the whole picture."
Measured: does the session search_skills, acquire (expect: phuryn accepted
OR deanpeters refused-with-reason — either path is machinery working),
delegate with the skillHandle, and produce a pattern? Success = the pipeline
exercised end to end with the refusal/custody properties visible in
artifacts. Prediction: acquisition succeeds on the single-file skill;
composition of the worksheet uses index parts if any fit. This cell is
smoke-plus-provenance, not a rate measurement: n=1, stated as such.

## Block 4 — demo dry-runs through the landed contract
The five phrases (poll, RSVP, emails*, research*, budget*) via POST
/api/task under the Block-1 winner; judged by GET /api/turns/<id>/result:
pieces[0].url present AND opens AND is interactive in a browser
(browser-verified by me, not tool-output-verified). *emails/research/budget
run expecting partial results — no seeded data, no web search, no Plaid
skill; their value is seeing WHERE each stops, recorded per phrase as the
gap list for demo prep. Poll and RSVP are the two that must fully pass.
Falsifier for the contract itself: any completed turn whose piece exists in
artifacts but is absent from result.pieces.

## Order and stop rules
Blocks 1 -> 2 -> 3 -> 4, serial batches. A provider error stops the round
(never retried into). Substrate failure invalidates the cell, never counted.
Every cell: corpus before/after, flag checks, provenance ledger, and the
report path handed to the analysis record. Estimated: ~12 batches, one
evening.

## What this round deliberately does not do
No terra cells. No V-seam changes. No prompt variants beyond the three. No
Plaid. No index/service changes. No script execution.
