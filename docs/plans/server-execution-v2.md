# Server-primary execution v2 — implementation plan

Executes the [v2 spec](../specs/server-side-execution/README.md). The spec
is the authority on *what*; this plan sequences *when* and carries the
progress state. Tick a box in the PR that lands the item. Success criteria
are measurable gates — a phase is done when its criteria are ticked, not
when its tasks are.

Conventions inherited from the v1 learning run (details in the
[archived orchestration log](../history/specs/server-side-execution/passivity-arc-orchestration.md)):
measure through `deno task integration --port-offset=NNN`, uninstrumented
workloads, byte-identical across arms, adjacent runs, counters over
latencies, no latency quoted above load ~5, causation by ablation.

The executor and its two execution postures are implemented in the current
repository. The first-party default is OFF; explicit `true` selects ON.
OW28's served `compileAndRun` path and scoped child lifecycle have direct
acceptance coverage. The coverage register tracks the Phase 7 gate evidence
and independently scoped follow-ups.
The initial stack inventory and stage records are historical evidence, not
an inventory of current main.

## Coordination state — read this first

The arc's coordination state is carried HERE, on the branch, not in any
agent's memory (owner directive 2026-08-18). This block is LIVE: update
it in the PR that moves the state.

**Current work:** revalidate applicable Phase 7 ordered gates for a renewed
rollout and investigate the separately scoped builtin follow-ups. OW28 covers
fresh compilation through a real serving host,
durable completion, child execution, recovery, supersession, and demanded
instances. The
[coverage register](../specs/server-side-execution/verification-coverage.md#current-status)
records the current dispositions; the
[coverage status audit](../history/plans/server-execution-v2/optimize/coverage-status-audit-2026-09-09.md)
records the omission evidence and the bounded status investigation.
The first-party default and flip records belong to the
[`serverExecution` registry](../development/EXPERIMENTAL_OPTIONS.md#serverexecution).
The ON soak is paused. A renewed ON rollout follows the Phase 7 gate
dispositions and the owner's rollout decision; the flip record alone does not
establish current readiness.

**Delta 2026-09-11 (the served source update): `setsrc` is a served verb.
Under ON, `cf piece setsrc` sends the resolved program to
`/api/pattern-lifecycle/setsrc`; the serving runtime uploads it as a verb
of its own and, in the cycle after, commits the update's setup transaction
DIRECTLY to the store — the loop's own derived-class commit outside the
wave, its written docs re-verified against the seq it was stamped at — so
the update's module authority publishes from a durable verdict as
`docs/specs/module-loading.md` requires (`docs/features/server-pattern-lifecycle.md`,
"Direct commits"). A wave open at such a commit exempts contributions
sealed after it from the conflict on the docs it wrote. `--check` stays
client-side. OFF is byte-identical.**

**Delta 2026-09-09 (the lifecycle verbs as server calls): the seed archived
at `docs/history/plans/server-pattern-verbs-seed.md` is BUILT for `upload`
and `instantiate`. Under ON, `cf piece new` sends the resolved program to
`/api/pattern-lifecycle/*`, and the space's serving runtime compiles,
materializes, and commits inside a wave cycle
(`docs/features/server-pattern-lifecycle.md`), the registry entry and the
slug in the creation's own transaction; the receipt returns once that wave
has committed and the verb's durability read has passed, ahead of the
piece's first derivation. The client keeps only its start; the shell and the background piece
service keep the client-side shape until their own migration. `setsrc`
stayed client-side at this delta, served by the 2026-09-11 delta above. OFF
is byte-identical.**

**Delta 2026-09-03 (the ROLLBACK): the first-party default returned to OFF
via the rollback PR (#6840) — the first data-only flip:
`SERVER_EXECUTION_DEFAULT_ENABLED` → `false` plus current-status prose, with
no workflow, test, or role edit (the 2026-09-02 hygiene's promise,
exercised). Everything #6535 built stays: the serving-side machinery, the
deployed-topology gates, and the two-arm lanes, now `default` = OFF and
`opposite` = ON (an ON-built shell, carrying the EMPTY ON skip registry and
the `server-execution` record marker). Explicit `true` selects ON per
deployment. The ON soak that began at #6535's merge is paused; re-flipping
is the same two-surface change back, against the flip's ordered gates.**

**Delta 2026-09-02 (post-flip toggle hygiene): #6535 is MERGED and the soak
was running with the default ON. This follow-up keeps that behavior unchanged
while replacing the hard-coded ON-default/OFF-guard workflow inversion with
stable `default` and `opposite` roles resolved by
`tasks/server-execution-ci.ts`. The binary define, server/test environment,
posture probes, ON skip placement, OFF authored coverage, topology capability,
and non-default record variant now follow that one mapping. Once it lands, a
default rollback is the constant change plus its current-status documentation;
the workflow does not need another role swap. #6552 remains available as the
pre-hygiene emergency rollback and can be superseded by that smaller follow-up
when appropriate.**

**Delta 2026-08-28, last updated 2026-08-29 (the FLIP PR —
[#6535](https://github.com/commonfabric/labs/pull/6535), now MERGED; the
soak started at its merge): `SERVER_EXECUTION_DEFAULT_ENABLED` →
`true`. This is the flip's execution record; it does not establish the current
OW28 gate verdict. Its recorded checks included the
ON-skip registry EMPTY across all four suites (the ruled-3b-close lift,
#6528), OW31's ruled posture BUILT, OW45–OW53 CLOSED, and the OW38(ii)
bar RULED met ("topics numbers are fine", 2026-08-24).** The 2026-08-29
updates this block carries, since the events they record post-date its
2026-08-28 heading: the two rebases above; the DECLARED-RESULT STOP
RULED (task 6's block — the serving side writes the verb
receipt/result); and the bot-review AMENDMENT (the deployed-topology
gates' startup wait made event-driven, their temporary identity no
longer leaked, the CLI health probes bounded, and the CLI lane's gate
now cross-checking `cf`'s resolved arm against the server's published
one). The OFF-world half of those same findings landed separately on
main as
[#6545](https://github.com/commonfabric/labs/pull/6545) — the GitHub
connector host adopting the deployment's posture, and the pattern
shard selectors failing loudly on an empty selection — which landed before
the flip. The PR carries,
beside the one-liner and the absolute pin's re-tense: the LANE-ROLE SWAP
(default lanes = the ON arm, probed serving-loop-present +
shell-define-unset, carrying the empty ON skip list; the opposite lanes
are the explicit-`false` OFF regression guard on
`build-toolshed-opposite`, with variant `server-execution-off`, per
testing.md §2's identity contract);
the DEPLOYED-TOPOLOGY obligation discharged (the Phase 7 table row):
a new `deployed-topology-gate` job runs the REAL `bg-piece-service`
binary (startup posture log line asserted; clean SIGTERM) and
cf-harness's production fabric-session factory (posture adopted ON; one
genuine piece flow) against the default toolshed, both red-first against
forced-OFF; the CLI lanes gain the server posture probe (`cf` adopts the
published posture — its gate); `PiecesController` hosts ride the default
lanes (sx2-scale et al.). The Deno-side integration clients (4 runner
files; the runtime-client host + its step-skip guard) resolve
env-else-default via the now-exported `withServerExecutionDefault`, so
the default lanes stay UNIFORM (the P7 finding-7 mixed posture does not
resurrect). The topics multi-user LANE-POSTURE item (the measurement
report's §5.1 flip-decision question) is discharged as recorded: the
no-server pattern-tests lane resolves the AMBIENT baseline (OFF) by
construction — the `patternTest` preset does not read the constant
(conformance-golden-pinned) — verified live at the flipped head
(`topics/multi-user.test.tsx` 7/7 with env unset); "grow the in-process
serving role" stays the not-taken alternative. testing.md §2,
EXPERIMENTAL_OPTIONS.md, and the register's FLIP PR block re-tensed
with it. The OFF path is NOT removed — it is the soak's rollback lever;
the post-soak removal PR (task 2) deletes it with the OFF lanes. The
deltas below are the prior PRs' records.**

**Delta 2026-08-28 (the ruled-3b-close PR): THE OWNER RULED THE 3B FORK
— "go with (1) plus the (2-D) kick" — both mechanisms are LANDED
red-first, and lunch-poll-vote's FILE entry is LIFTED: the ON-skip
registry is EMPTY across ALL FOUR SUITES (the third lift; B1's
list-EMPTY precondition met again).** (1) event-driven re-supply
(pattern-manager.ts): a supply-class replication failure parks under the
WANTED identity — the failing frame's own, the dependency's in a
recursion frame — and `recordPersistedClosureSpaces` re-issues it on the
next matching persist record (once per event, no timers, bounded; the
failure line stays byte-identical and the park/re-issue/heal are loud);
failure registration checks the map once so a record that landed inside
the read window re-issues immediately (review-6502 F1-(b)); the one-shot
contract now reads "…and on the next persist event", exactly the
register's pre-drafted sentence. (2-D) serve-time kick (wish.ts): a
cached sidecar pattern served for a space it did not compile into
replicates its closure there at page-serve time, so the demanding
space's supplier is REGISTERED before any create-profile click and the
child replication's ticket await covers the lunch class by registration,
with (1) as the structural backstop. Pins red-first at bare main
d569f3722 (`pattern-replication-sibling-race.test.ts` steps 7–10 — heal,
module-wake, registration-check, dependency-frame park; the
executor-cross-space late-carriage pin — a parked §2b delegation rides
the heal through the accept gate; the wish-side kick's own pins, retired
with the process-global sidecar cache they covered);
new mutations N1/N2/N3/N3b/N4 pairwise isolated; the existing kill
matrix re-verified cell-for-cell, with K1's kill REBOUND to step 1's
zero-failure-lines assertion (the heal masks its end-state by design —
the F1 class recreated and closed before landing). The register's
RULING block records the ruling, the landed mechanism, and what stays
open (cross-replica never-records supplier — heals at the server's
first matching persist; prior-session third-space closures; the
recursive-(b) sliver). Lift evidence per the ruled local-plus-CI-probe
bar: campaign R 8/8 quiet-and-loaded at the lift head (fresh store +
posture probe per run, ensure-ON default, self-sourced sha-verified
binary, LLM masked; structureLoadStuck 0, closure-replication-failed 0 —
the heal machinery dormant locally, exactly the model), full runner
suite green at the head, and THIS PR's own ON-lane board as the
direct-CI unskip probe (PROBE 6) under the ruled SURFACE reading — a
red at that surface restores the entry with the accumulated map and the
honest classification. PROBE 6 VERDICT (run 33222653635 at 1a5f3e66e,
settle-confirmed): GREEN AT THE SURFACE — all ten ON shards succeeded,
shard 7 RUNNING lunch-poll-vote; the lift STANDS and B1's list-EMPTY
precondition is MET (the register's PROBE 6 block carries the full
reading, including the board's sole red — a packages/cli view test this
diff cannot reach, second observation with the merge gate). The deltas
below are the prior PRs' records.**

**Delta 2026-08-28 (the geometry-3 close PR, FINAL disposition — PROBE 5
red at the surface, GEOMETRY 3B CONFIRMED on its pre-declared signature;
the entry is RESTORED and the owner fork is the live decision.** The
close itself stands (geometry 3 fixed red-first, pinned, kept): probe 5 =
this PR's own board, run 33198257149, ON shard 7 job 98941298566, the
same external surface (`:271`, `#lp-join-button`, "Unknown profile
#AykQuk", 11 co-residents green) — and the artifact discriminates it
from every prior probe: ONE `closure-replication-failed` (same
profile-home module Jlzs…, parent→profile, 18:16:15.616) with **ZERO
`closure-replication-await-inflight` lines**, the once-await's
announcement that prints whenever either compile registry is non-empty
at a dry consult (pattern-manager logger defaults to level "info";
verified) — so both registries were EMPTY: the supplier compile had NOT
STARTED, the exact 3b property pre-declared in the register BEFORE the
probe ran. Fallback counters 0; 80 `structure-load-stuck`
18:16:50–18:20:50. A once-await structurally cannot see a compile that
has not begun; the full close — event-driven re-supply on each persist
record — TOUCHES THE ONE-SHOT CONTRACT and now sits with the owner (the
register's 3b fork; alternatives include a deeper supply redesign such
as compiling the home-env into the parent space before serving profile
creation). The census returns to ONE patterns entry, its reason carrying
the four-geometry map and probe 5's coordinates. The lift text below is
this PR's superseded proposal, kept for the record.**

**Delta 2026-08-28 (the geometry-3 close PR, original lift text —
superseded above): the lunch forever-park's
THIRD supplier geometry — the supplier COMPILE still mid-flight at
child-replication time (probe 4's residue, run 33165960083) — is CLOSED
red-first, and lunch-poll-vote's FILE entry is LIFTED: the ON-skip
registry is EMPTY across ALL FOUR SUITES again.** The close (the #6484
register's designed move, built with the independent review's three
sharpenings): on a dry origin AND dry fallback map, the replication
snapshots BOTH in-flight compile registries (`inProgressCompilations`
AND `inProgressByIdentityLoads`; never `compileCacheWrites`, its own
set), allSettles the snapshot once, re-observes a fresh
`pendingCacheWriteBacks` snapshot (a settled load's recovery persist is
fire-and-forget but registers there before the load resolves), and
re-consults primary + fallbacks; still dry keeps the byte-identical
one-shot throw. An EMPTY registry snapshot takes NO retry — nothing
could have recorded, and the build's own mutation ladder caught the
unconditional-retry draft re-rescuing the sibling race and masking the
sibling-await pin (the F1 class): the short-circuit restored that kill.
Pin: `pattern-replication-sibling-race.test.ts` step 5 (latch-gated
mid-flight supplier compile, second-runtime construction, no sleeps),
watched RED at pre-fix `bd9b1c10b` with the production error;
once-await mutation reds it alone 5/5; the four existing kills
re-verified. GEOMETRY 3b (a supplier compile not yet STARTED at consult
time) is PRE-DECLARED residue in the register — signature:
`closure-replication-failed` with NO `closure-replication-await-inflight`
line, fallback counter 0, closure arriving shortly after; the full
event-driven close (re-issue failed replications on each persist
record) TOUCHES THE ONE-SHOT CONTRACT and is recorded as an OWNER-COURT
fork, not built. Lift evidence per the ruled local-plus-CI-probe bar:
campaign I 8/8 quiet-and-loaded at the fix head (fresh store + posture
probe per run, ensure-ON default, self-sourced binary sha256
`a483b13f70b8…` re-verified per run, LLM masked; `structureLoadStuck`
0, `closure-replication-failed` 0, walls 18–19 s), full runner suite
green at the head, and THIS PR's own ON-lane board as the direct-CI
unskip probe under the ruled SURFACE reading — ON shard 7 RUNS
lunch-poll-vote; the probed surface's verdict decides (red at the
surface restores the entry with the 3b classification, per the arc's
standing method). The flip PR's list-EMPTY precondition is met again;
its bar remains a green ON lane. The delta below is #6484's record,
kept as history.**

**Delta 2026-08-28 (PR #6484, FINAL disposition): the lunch forever-park's
WRITE PATH is mapped THREE GEOMETRIES DEEP on four direct-CI probe boards,
the first two geometries FIXED red-first — and the entry is RESTORED: every
probe went red at the probed surface, the fourth under the declared hard
stop. The census returns to ONE patterns entry.** The three geometries, each
caught by its probe's own toolshed artifact: (1) the in-flight sibling
replication supplying the parent space — fixed, the sibling-await
(`replicationsIntoSpace`, ticket-ordered, acyclic); (2) the parent space
closure-less BY ORDER — `loadPatternByIdentity` serves patterns from the
in-memory artifact index with no per-space persist, so when another space's
compile warms the index first nothing ever supplies the parent — fixed, the
module-keyed fallback origins (`persistedClosureSpaces`; probe 3 caught the
first cut's entry-keying defect, probe-pinned); (3) the supplier COMPILE
itself still mid-flight at child-replication time (probe 4): no persist of
the profile-home module had completed anywhere server-side, the fallback map
was correctly empty, and the one-shot died — UNFIXED; the designed next move
(on a dry map, await the manager's in-flight compilations once — their E4
persists record before resolving — then re-consult, then throw; event-driven,
no deadlock) is recorded in the register, not landed. Signature identical in
all four probes: one `closure-replication-failed` parent→profile, 80
`structure-load-stuck` (40 roots, `pattern-unloadable`), the name
placeholder, `:271` at 300 s, fallback counter 0. Local 30/30 green across
campaigns F/G/H + smokes at the fix heads — the park is a CI boot ORDER
(locally the parent's own sidecar compile always persists first), not a race
or load artifact. The fixes stay in (both pinned, both real defect classes);
the entry's reason carries the map; the original delta text follows for the
record.**

**Delta 2026-08-28 (this PR, original lift text — superseded above): the
lunch forever-park ROOT-CAUSED from the
phase-3 probe's own artifact and FIXED red-first; lunch-poll-vote's FILE
entry LIFTED under the ruled bar — the ON-skip registry is EMPTY across
ALL FOUR SUITES for the first time since stage F.** The park's mechanism,
read off run 33138358110 shard 7's published toolshed log (the artifact
the phase-3 delta added): the runner's cross-space child replication —
the CT-1687/S-A write that supplies a child space's program closure
(`replicate(parentSpace -> profileSpace)`) — raced the SIBLING replication
still supplying the parent space itself (`compileOrGetPattern`'s
content-cache hit fires `replicate(cached.space -> parentSpace)`
fire-and-forget), one-shot-died on "source closure unavailable in origin
space" (the shard's single pattern-manager error, 33 s before the first
stuck warn), and nothing re-issues a failed replication — so the profile
space never received its closure, its 40 demanded roots deferred
`pattern-unloadable` forever (the 80 OW46 warns = 40 roots x streaks
8+16), the name rendered the `#MjhprA` placeholder, and `#lp-join-button`
never appeared (:271). Local greens ride the SAME machinery with the
sibling winning by ~3 s — the store witness is the commit classes (sibling
replications land DERIVED via the target's wave; child replications land
AUTHORED with §2b carriage), and CI's slow boot flips the ~1 s edge, which
is WHY two campaigns split local-8/8 vs CI-red: the park was
CI-timing-armed, exactly as the method finding predicted. The layered view
was verified en route (a same-runtime wave-staged write IS readable before
the wave commits), which is what pinned the sibling — not wave durability —
as the mechanism. FIX (runner package): a replication awaits the
strictly-older replications registered INTO its origin space before
reading it (`pattern-manager.ts` `replicationsIntoSpace`, monotonic
tickets — acyclic by construction; genuine absence still fails loud and
settles). Red-first pin
`packages/runner/test/pattern-replication-sibling-race.test.ts`
(deterministic-by-construction race; watched red pre-fix with the exact
production error; mutation-killed), plus a working-tree fault injection
that reproduced the FULL CI signature locally (80 stuck warns over 40
`pattern-unloadable` roots, join dead, 300 s). Lift evidence: requirement
(1) — 8/8 quiet-and-loaded at the fix head (17–18 s walls,
`structureLoadStuck` 0, `closure-replication-failed` 0, the tolerated
refusal storm unchanged at 40/40); requirement (2) — THIS lift PR's own
ON-lane board runs the un-skipped file as the direct-CI unskip probe,
green at the probed surface per the ruled SURFACE reading. The flip PR's
list-EMPTY precondition is now MET. The flip bar remains a green ON lane —
unlisted debt still blocks the flip on its own accountability (the
co-resident `cfc-group-chat-demo.test.ts:133` blocker is PAID by #6477,
the delta below). **PROBE 2 UPDATE (same PR): the first board went RED at the probed
surface (run 33160430927 shard 7 — same chain, sibling-await inert), the
attempt withdrew per the bar, and the classification found the SECOND
supplier geometry: on CI no compile ever targets the parent space (the
identity-home compiles warm the manager's in-memory artifact index first,
and index hits persist NOTHING per-space), so the parent is closure-less
by ORDER, not by race. Second fix, same PR, red-first: the replication
records every durable persist target per entry and falls back to reading
those spaces when the heuristic origin is dry (content-addressed —
byte-identical, integrity-gated, fail-closed; genuine absence still fails
loud). The v4 board went RED at the surface and caught the fix's own
defect — the fallback map keyed by persist ENTRY while the replicated
identity is a MODULE of that closure, so the lookup missed and the
fallback never fired; fixed to per-module keying with the exact geometry
pinned red-first (importer/lib program, index-served lib pattern, dry
origin). The keying-fix board is the attempt's probe; a red at the
surface there restores the entry — no further iteration on this PR.**
Recorded residual,
flagged not filled: a CROSS-REPLICA supplier (a client/harness write-back
arriving over the wire) is outside both the await and the recorded-target
fallback — never observed in any red. Register: verification-coverage.md
OW45's lunch ROOT-CAUSE, PROBE-2, and LIFT blocks.

**Delta 2026-08-28 (#6477): the co-resident debt is PAID —
`cfc-group-chat-demo.test.ts:133` root-caused and green.** The unlisted
flip-blocker the surface-reading delta below leaves live is fixed. NOT
§2b's standing echo: a `stale confirmed read` conflict on the blind
draft write (the room-add wave's first `/cfc` stamp + sibling structure
add on the argument doc, racing a pre-wave client basis), dropped
because no UI-write path consumed the RETRYABLE rejection — compounded
by the fill's second same-value write succeeding vacuously against the
first's optimistic layer, so even a token-guarded retry declined toward
a no-op owner. Fixed red-first in the runner: `Runtime.commitUiCellWrite`
(`editWithRetry` + value-following supersede lanes for BLIND writes — a
conflicted CAS push takes one attempt, never a retry — + the counted
`runtime.ui-cell-write`/`lost` channel), `applyCellWrite` rewired, the
S-G wait added at `:133`. Baseline 5/6 red running alone → 18/18 green
across three post-fix gate rounds, the draft durable in every store.
The file was never skip-listed — NO census change; the flip's
green-ON-lane bar loses this blocker. Full mechanism + evidence:
verification-coverage.md OW45's PHASE-3 block (the FIXED paragraph).

**Delta 2026-08-28: the probe bar's OPEN interpretation question is RULED —
"lane green" means the probed SURFACE — and default-app's reload STEP entry
LIFTED on it. The ON skip list is now ONE entry: lunch-poll-vote's FILE
entry.** The coordinator recommended that requirement (2) of the ruled bar
binds the PROBED SURFACE, and that a co-resident failure is a separate
defect carrying its own accountability rather than a veto on an unrelated
entry's lift; the owner ruled **"agreed with your recommendations,
proceed" (2026-08-28)**. Under that reading the default-app step's bar was
already fully met by evidence in hand — 10/10 quiet-and-loaded locally at
main `1fc841b6e` with every fixed-mechanism counter zero, AND its direct-CI
unskip probe running the exact step to `ok (18s)` on a green file (run
33138358110, ON shard 5, job 98743591519, head `95f313835`) — so the lift
took NO new measurement. The entry and its bound in-file guard are removed
together; the pin suite now binds the lift (list length ONE, the step's
guard lookup `undefined`, no `SKIP-STEP` line). Two things the ruling does
NOT license, both live: the co-resident `cfc-group-chat-demo.test.ts` red is
NOT forgiven — it is unlisted debt with its own accountability and a flip
blocker in its own right (the flip's bar is a green ON lane, not merely an
empty skip list) — and a probe that reds AT the probed surface still
withdraws that entry's lift, which is exactly where lunch-poll-vote stands.
Register: verification-coverage.md OW45's SURFACE READING and LIFT blocks.

**Delta 2026-08-27 (phase 3, #6469): the lift bar CHANGED by owner ruling
— an ON-skip entry lifts only on its local campaign AND a green direct-CI
unskip probe — and both entries were campaigned again under it. NEITHER
lifted, and they now fail for OPPOSITE reasons.** The bar: the register had
already reached "the lift bar should require a green DIRECT CI unskip
probe, not a local count alone. That is a bar change, so it is the owner's
call, flagged not taken"; RULED 2026-08-27, owner: "agreed", and it binds
every entry, not only the file that provoked it. Both campaigns ran at main
`1fc841b6e` on one ON binary (sha256 `a93047a461c0c4d8…`), fresh store + own
97xx port + ON posture probe per run, ensure defaulting ON, toolshed
self-sourced, quiet and loaded interleaved; the probe was head `95f313835`
(both entries and the default-app guard removed in one commit), CI run
[33138358110](https://github.com/commonfabric/labs/actions/runs/33138358110)
— 8 of 10 ON pattern shards green, red on exactly the two shards carrying
the two probed files.
**default-app's reload STEP: 10/10 local AND its CI probe of the step
GREEN (`ok (18s)`, server window clean) — the entry's own charge did not
reproduce in either arm.** It is held ONLY by the lane: shard 5 red on a
CO-RESIDENT file, `cfc-group-chat-demo.test.ts:133`, which is not
skip-listed, is untouched by the probe diff, and reproduces 4/6 red locally
at the same head running alone. **That raises the bar's first
interpretation question, and it is the coordinator's/owner's, flagged not
filled: does "the probed lane GREEN" mean the probed SURFACE green or every
test in the shard green?** Under the first reading this entry lifts today —
**and it did: RULED 2026-08-28 for the surface reading, entry LIFTED; see
the delta above.**
**lunch-poll-vote's FILE entry: 8/8 local, probe RED at the probed
surface** — line 271, the HOST's `#lp-join-button`, 300000 ms, 5m5s, the
same signature as the 2026-08-26 probe, with the OFF lane green on the same
run. What is genuinely new is the evidence position: **CI now publishes the
toolshed log as a job artifact**, closing the 2026-08-26 disposition's
stated blind spot, and it shows this row's ORIGINAL mechanism end to end —
80 `structure-load-stuck` WARNs on the profile space (the parked root's id
suffix is literally the `#MjhprA` the placeholder rendered) behind 20
`seal-space-commit-failed`/`foreign-write-refused` pairs. **The refusal is
not the discriminator** — every local GREEN carries more of it than the CI
red does, with `structureLoadStuck` 0 — **the PARK is.** Also surfaced, not
owed here: `cfc-group-chat-demo.test.ts` is failing ON at current main 4/6
and is NOT skip-listed, so it is a flip blocker in its own right (the
flip's bar is a green ON lane, not merely an empty skip list). Full
ledgers, classifications, and the co-resident finding:
verification-coverage.md OW45's PHASE 3 block.

**Delta 2026-08-27: BOTH remaining entries were campaigned for a lift and
NEITHER lifted. default-app's reload STEP is 7/10 locally. lunch-poll-vote
passed its local re-baseline 8/8 — and then the lift PR's own CI ran the
un-skipped file in the true lane and it went RED (ON shard 7, run
33085668531, at the HOST's join, a stage no red for this file had ever
been recorded at). The census stays TWO entries; the flip's list-EMPTY bar
is unmoved.** Both campaigns ran
at main `4b70949ac` on one ON-built binary, fresh store + own 97xx port +
ON posture probe per run, PID-only teardown, `gtimeout 600` never raised,
quiet and loaded interleaved — and at **two posture changes from every
archived campaign, both strictly harder**: the space-root ensure is ON
(the production default the CI ON lanes returned to at #6248, so the
archived `SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false` no longer matches the
lane), and the toolshed self-sources its pattern `API_URL` on the run port
— the corrected source authority the 2026-08-26 default-app RCA
prescribed, which removes the split-source artifact that produced that
campaign's only red. Lunch: 8/8 green in 17–18 s, and the member's own
store discriminator negative in all eight (every space carries
`patternIdentity` and a 141–198-op materialization commit; the red
signature is a 4-commit guest space with none). Default-app: 7/10, three
reds all carrying the entry's current charge verbatim
(`eventInvocationCount: 7`, `notebookActionCount: 0`, no bound notebook
action state) — two of them (a03, a07) with r06/r09's keyless
`pattern-load-error` discriminator, which is the first fresh OBSERVATION
of that never-root-caused member since it went to
absence-of-observation on 2026-08-24, and one (a04) with a live but
incomplete piece matching no stated member.
**The method finding, which outranks both ledgers: a local campaign is not
the lane.** Both posture corrections above were made precisely to close
that gap, and the gap survived them. This row already carried one member
with the same profile (the fifth-face load-park member: local control
0/12, CI 2/2 red across two shards); lunch-poll-vote now makes two. A lift
bar of "N local runs" is therefore weaker evidence than it reads, and the
natural repair — require a green DIRECT CI unskip probe as part of the bar
— is a bar change and so the owner's call. Flagged, not taken. Full
ledgers, the CI probe, classifications, and posture rationale:
verification-coverage.md OW45's STEP-ENTRY and LUNCH-POLL blocks.

**Delta 2026-08-26: the default-app reload STEP's post-#6292 gate is
9/10 — NO LIFT. The older read-side residues are likely closed; the
sole red is a new store-incomplete `pattern-swap-setup-error` shape.**
The re-measure used the CI ON lane's ensure-off posture, one ON binary,
a fresh store and posture probe per run, and five quiet plus five loaded
runs. Nine steps greened in 7–24 seconds. The one red reached the target
step and exhausted the unchanged 600-second harness bound after six
durable note appends; the log held one recursive-schema
`pattern-swap-setup-error`, zero `pattern-load-error`, and a real root
pattern identity. It is neither the earlier complete-store silent r01
shape nor r06/r09's keyless-identity whole-piece shape. The earlier
residues are “likely closed” on different evidence: r01 has #6292's
matching client-absorb mechanism plus no recurrence, while r06/r09 have
absence-of-observation only because their mechanism was never
root-caused. The STEP entry and guard therefore stay, reworded to the
new observed charge; the 10/10 lift bar is unchanged. Full ledger and
store/log discriminators:
[`ow45-default-app-reload-post-6292-remeasure-2026-08-26.md`](../history/plans/server-execution-v2/optimize/ow45-default-app-reload-post-6292-remeasure-2026-08-26.md).
That census — THREE patterns entries: this default-app STEP, the
lunch-poll-vote FILE entry, and the topic-board pivot-baseline STEP — is
now TWO: #6316 lifted the topic-board STEP on 2026-08-26 without updating
this sentence. The flip still requires the list to be empty.

**Delta 2026-08-24 (this PR): the b04 client-start DEATH closed by
CATCH-UP-AND-START (RULED 2026-08-24); the 10/10 gate found the arm-B
residue is TWO read-side members the start fix does not reach — the
reload-step skip STAYS (7/10), reworded to the narrowed charge.** The
ruled mechanism (coordinator recommendation, owner ack): in the
deferred start's stale-confirmed-read error arm, treat the refusal as
"the server won the race" — await the conflict's readiness (the
wire-attached `readyToRetry` catch-up + the named document's pull),
then START the piece from the served documents through the ordinary
load walk, COMMITTING NOTHING in the recovery arm. Not #6208's
re-commit retry (census-proved non-convergent, closed — its
`isStaleConfirmedReadConflict` discriminator and
`awaitCommitRetryReadiness` extraction are cherry-picked as live
pieces of this build); not the old refuse-to-start. ON-only (the
coordinator's conservative default; OFF byte-identical, pinned —
under OFF the refusal means another CLIENT raced and cross-tab mutex
semantics own that story). OW62 is RE-FRAMED from adopt-not-start to
START-WITHOUT-COMMIT (clients start speculatively; server-state
wins); its remaining open piece is the stage-2
unmaterialized-fallback question. Binding sentence: serving-loop.md
§3d's RULED 2026-08-24 refusal-arm paragraph; full record: the
register's OW45 CATCH-UP-AND-START block (ruling + owner model
statements verbatim, design-check findings, red-first + mutation
evidence, the campaign ledger) and OW62's re-framing block. The gate
(ensure-off — the CI ON lanes' posture, i.e. what a lifted step
would actually run under; fresh store + posture probe per run,
quiet-and-loaded): the recovery arm fired live in EVERY run with
zero terminal deferred-start deaths, and in the green runs it
demonstrably resurrected the NOTEBOOK space's refused root start
(catchup → step green, steps 22–46 s). The three reds are NOT the
client-start death: r01 is the single-chain readCell starvation
(notebook context fully live, store holds all 7 appends,
argument-notes read undefined for the whole net, silent) and
r06/r09 are the stranded whole-piece mid-session read death — the
recovery fired for the notebook space, no start died terminally,
then one watcher `pattern-load-error` for a KEYLESS identity (the
CT-1923 stranded shape) and every read of the piece returned
nothing at diagnostics time — which disproves the fork memo's
working hypothesis that h01/h05/rf2 were "the same die-off" as the
start class. The flip's list-EMPTY bar hangs on this step plus the
lunch-poll-vote FILE entry #5744 landed mid-review (the same
client-start class, its reds recorded BEFORE this recovery landed —
it lifts on its own gate evidence at the merged head).

**Delta 2026-08-23: OW45 arm-B server-ensure STAGE 1 BUILT —
the space-root ensure runs at the
SpaceServer's activation as a lease-guarded, single-flight owed step —
non-blocking at activation, DEADLINE-BOUNDED in the first cycle
(rootEnsureDeadlineMs, default 30 s: a wedged fetch must never hold a
tenure's lease — the build review's F2).** Its current obligation is
root existence only: `ensureSpaceRootPattern` returns an existing root without
following its source. Source following belongs to the opener under
piece-source-lifecycle.md and serving-loop.md §3e. The
design of record is PR #6209
(`docs/history/plans/server-execution-v2/optimize/ow45-armb-server-ensure-design.md`,
owner-green-lit 2026-08-23); the build report with the four
owner-may-veto operating assumptions (owner-resolved fail-closed
attribution via the memory server's new `resolveSpaceOwner`;
custom-`defaultAppUrl` log-and-use-system-default interim; the
runnability-repair pair NOT moved — recorded as a STAGE-2 GATE: the ON
client's creation retirement must not ship before the pair moves;
ARM-B out of scope) is
`ow45-armb-server-ensure-stage1-report.md` beside it. The ensure core
is EXTRACTED into the runner (`ensure-space-root.ts`, beside
pattern-updater/ensure-piece-running) and the client controller's
creation arm now delegates to it, so OFF stays one code path; OFF
witnesses: the toolshed bootstrap pin (flag off → no host, the seat's
only reachability chain severed at its first link) and the piece-side
OFF-arm creation pin, both mutation-checked. The ARM-A refusal class
does NOT close in stage 1 (the ON client still creates; the server now
wins most races) and the reload step's ON skip STAYS — the measurement
section of the build report carries the before/after numbers.

**Delta 2026-08-22: OW45 arm B triaged on an instrumented
client — the starvation family is THREE defects: two FIXED red-first,
one isolated live and FORKED to the owner; the last skip entry STAYS.**
The instrumented bench (worker console forwarded, fresh store per run,
merged-main ON binary) caught two reds in four runs, each a different
member. FIXED: (1) the event drain's deferral arm let a later-arrived
event overtake a deferred earlier one — run b01's store-verified
cross-stream inversion of one user's last two clicks, against
events.md §2's stated arrival order; the drain now processes across
sidecars in append commit-seq order with deferral as a BARRIER
(red-first pin `executor-events-down.test.ts` "arrival order across
streams", watched `A,B,A` → `A,A,B`). (2) The graph walk's
absent-hop-target demand hole — a link-hop target absent at
evaluation was tracked NOWHERE server-side, so its birth never passed
the session wake pass's touched check and the watch never delivered
it, while the client's selector tracker answered every re-read
locally: the row's "first-read lottery", permanent on a quiet space;
the walk now records the dead-end in a MISS SET on the graph state —
wake-reactivity only, never delivered — so the birth re-evaluates and
delivers the real document while the wire stays byte-identical until
then (red-first pin `v2-watch-absent-arrival.test.ts`, the hop pin
watched starving at its net). FORKED (the remaining charge): run b04 caught the
whole-piece shape live — the flag-ON client's navigate-deferred piece
start dies terminally on a `ConflictError` whose basis read the
served piece's computed docs at seq 0, PRE-BIRTH (the first-hydration
race), and the deferred-start error arm has no retry; the piece never
starts client-side and every dependent read is undefined for the
session. Dispositions + recommendation ((a) retry-on-conflict now,
(b) adopt-not-start under ON as the destination):
[`optimize/ow45-armb-client-start-fork.md`](../history/plans/server-execution-v2/optimize/ow45-armb-client-start-fork.md).
The ON skip list still holds exactly ONE entry (the reload step, its
reason updated to the refined map); the flip's list-EMPTY bar hangs on
the client-start close. Full evidence: verification-coverage.md OW45
(the ARM-B TRIAGE block).

**Delta 2026-08-22 (#6197): the arrival-witness fork RULED (candidate
(B)) and BUILT — the runner `pattern-and-data-persistence` skip LIFTED,
the LAST file-level ON skip.** The overlay's arrival gate now witnesses
a cover AT an entry's floor only when the covering commit is
DERIVED-class (strictly above the floor any class witnesses; unknown
class at the floor fails closed toward the standing echo) — the
class-blind gate had retired first-run speculations on their own
AUTHORED setup cover at the floor, 40–260 ms before the served value
landed (the OW33 rotating flake, both arms). The covering commit's
class rides session frames as the flag-gated `coverClass` field (OFF
wire byte-identical) into the replica's confirmed record and the
sweep. Lift: 10/10 green at the true ON topology (ON-built binary,
fresh store + posture probe per run). Binding sentence:
speculation.md §4's arrival-witness predicate; ruling + build record:
the register's OW33 row and
[`optimize/ow33-arrival-witness-fork.md`](../history/plans/server-execution-v2/optimize/ow33-arrival-witness-fork.md).
The ON skip list now holds ONE entry, the default-app reload STEP
(OW45) — the flip PR's list-EMPTY bar hangs on that step alone.

**Delta 2026-08-22 (#6198): the default-app reload STEP's charge
SPLIT — its test half CLOSED, its product half ISOLATED; the skip
entry STAYS, reworded.** The step's red population was BIMODAL and
the old post-wait single-shot read could not tell the halves apart.
The test-side pass binds the step's assertions to the summary its
`waitForCondition` predicate approves and hands back (re-approved
after the sync barrier), closing the OW51-interim race half
(red-first watched at the true ON topology; 16 greens across
regimes; mutation-checked that a missing note reds the wait's net;
OFF control 2/2). On the FIXED step the residue proved REAL and is
now store-verified in the OW45 row: sticky client-side unresolved
reads on FIRST HYDRATION of freshly created served state (no reload
sits between the creates and the reads) — `readCell` of the
argument's redirect-linked `notes` undefined across the full
5-minute net at 500 ms cadence, or every client read of the piece
returning nothing mid-session (rf2's shape) — while the store
holds all 7 appends and the reactive render path serves the same
notes; 3/5 at ambient-to-spike loads on a churning shared box, zero
data loss; repro is create-then-read under serving. The patterns
ON-skip list therefore still holds exactly ONE entry (the reload
step, now naming the starvation; its in-file guard is unchanged
from main except the comment, and the pin test pins the single
entry);
the runner and runtime-client lists are as the OW33 triage left
them. Full evidence chain: verification-coverage.md OW45.

**Delta 2026-08-22 (#6194): OW53 CLOSED — the sqlite identity pair
LIFTED.** The triage determined BOTH halves IMPLEMENTATION (no model
fork): the sqlite builtins consumed the RUNTIME's ambient identity —
the SERVICE, on a serving runtime — at the db-owner mint, the
cleared-read hash keying, the flush's reader/ceiling reads, and the
completion writeback's partition, where the ruled model
(serving-loop.md §3c/§4, protocol.md §1, builtins.md §2, 06-cfc.md's
dbOwner) carries the RUN's acting principal. Re-pointed
(`sqliteRunActingPrincipal` + the flush's captured identity on the
OW17 seam); red-first unit pins + both integration files 5/5
fresh-store true-ON; the two `patterns` FILE skips are LIFTED — the
first-ON-CI-gate set is now fully lifted at the FILE level. The ON
skip list is down to: patterns `topics-navigation` + the default-app
reload STEP (OW45), runner `pattern-and-data-persistence` (OW33),
runtime-client 2 steps (OW33). One flagged, severable arm rides the
register row for owner ratification: an actor-less served creation
mints NO owner (fail closed — never the service DID). Full trail:
verification-coverage.md OW53 +
[`optimize/ow53-triage-report.md`](../history/plans/server-execution-v2/optimize/ow53-triage-report.md).

**State as of 2026-08-21 (evening): OPTIMIZE ON MAIN.** The train is
LANDED dark (#6096 merged as `71e99fc33`; OW31's ruled identity posture
followed as #6156 `9d989c0c1`); the phase is the register's OW rows
(verification-coverage.md §3) plus the flip gates below. Today's delta:

- **The two parked rulings are RULED.** OW51 = **option 3** (this PR,
  #6179): the refusal's re-trigger is independent of the root-level
  arrival re-arm; verification found the re-fire contract already held
  and the deadlock was the refusal mis-firing on SCOPED-row absence —
  the scoped carve-out + the mutation-verified re-fire pin are the
  build (ow51-build-report.md §8). The §8.5b surfaced residual
  (schema-examples red on both bases) is root-caused and CLOSED
  (§8.5c): the consumer was the test's own missed assertion-churn
  site — no product-code consumer; the row is CLOSED and #6179 holds
  only for the coordinator's delta review. OW34 = all seven §10
  recommendations ACCEPTED; its implementation train launched
  separately.
- **Four PRs MERGED tonight** (latest `572b07cbc`): **#6187** — the
  §2b send-axis fix (a served run's send to a foreign stream crosses
  via the outbox; profile-embed's gate 4/10 → 7/10, skip re-scoped to
  the name-draft OW47-family residual); **#6186** — a served event
  refused pre-storage by CFC seals an error consequence (OW54; OW58
  minted, OW57's closure withdrawn); **#6189** — chained test events
  gated on arrived consequences (settle stimulus-effect text waits);
  **#6190** — a served run's CFC trust snapshot carries the acting
  principal (OW34-family; the group-chat skip lifted under OW59).
  This PR (#6179) carries the default-app lift.
- **Trains in flight:** verifier-read-basis; warm-request; the
  name-draft triage; arrival-wait hardening.

Prior state (kept for the trail — the paragraphs below describe the
land itself): **LAND-OFF — the integration PR was
[#6096](https://github.com/commonfabric/labs/pull/6096)
(`claude/server-exec-v2-land-off` = the train tip `45cca4167` + the
merge of `origin/main` `bbcc7a348` + the reconciliation + the catch-up
merges), and its FIRST CI RUN — the stack's first-ever CI execution —
is in: two jobs red, all else green. The ON pattern lanes found SEVEN
real ON red surfaces (every one reproduced locally on the ON-built
binary; the OFF lanes untouched; the lunch and chat ON gates PASSED in
CI): the headline is NO DEMAND HOLE — the (d′) machinery held on every
surface it could be observed; every red is a WRITE-PATH defect under
ON, and two of the seven are the already-owed OW31/§2b write-authority
carriage build surfacing. Disposition: SKIP-AND-LAND — the seven
surfaces carry honest ON-skip entries (SIX file + TWO step-level,
`tasks/server-execution-on-skips.ts`; the skip-list test pins the set)
with owed rows OW45–OW53 (verification-coverage.md §3, the 2026-08-21
delta; OW31's two converging surfaces point at OW31, nothing
re-minted); ONE code fix rides the push — the multi-runtime harness's
posture (it self-hosted an OFF-arm store under ON workers, a mixed
topology no deployment produces; ON now targets the lane's toolshed),
which repairs cfc-group-chat-demo-multi-runtime outright and narrows
cellset-lww/convergence-storm to their one honest red step each; and
coverage-check's runner amount re-baselined +1267 → +1276 in the PR
body (the ON lanes' first-ever coverage profiles moved the
measurement). The skips gate the FLIP — whose bar is the skip list
back to EMPTY — not the land. Gate record:
[`stage-c/first-on-ci-gate.md`](../history/plans/server-execution-v2/stage-c/first-on-ci-gate.md);
the render-stall mechanisms with fix seats S-A..S-J:
[`stage-c/on-render-stall-rootcause.md`](../history/plans/server-execution-v2/stage-c/on-render-stall-rootcause.md).
The coordinator merges on green.** The merge's conflict ledger, the five tx-boundary
interaction findings (lead: the all-no-op wave is safe-by-construction,
pinned green by `packages/runner/test/executor-no-op-wave.test.ts`),
the full suite counts, the reproduced ON gates (lunch 3/3 {1:16}, chat
n=20, note n=20), and the W4-lite re-anchor live in
[the land-off reconciliation report](../history/plans/server-execution-v2/stage-c/land-off-reconciliation-report.md).
Before that: **W4 (the
acceptance measurement) is DONE — 6 of 7 bars PASS** (ordered next
action (5) below carries the numbers and the report link); next
action (6), the coordinator's confidence verdict, fed the owner's
approval of the landing strategy this PR executes. The consolidated stage-C record —
benchmark verdicts, attribution, the tuning trio, the double-dispatch
dossier, the design-pass state, the process rules — is the frozen
[stage-C closeout](../history/plans/server-execution-v2/stage-c-closeout.md),
with the evidence files beside it; the owed rows are the register's
(`verification-coverage.md` §3, the 2026-08-18 coordination delta).

The stack's branch topology and local validation record are preserved in the
[stage-C closeout](../history/plans/server-execution-v2/stage-c-closeout.md).
The integrated serving stack includes the compile outbox and completion path.
The current acceptance work and independent follow-ups are the register's
OW28 rows.

**The owner's landing posture (2026-08-18, verbatim intent):** *"get
confidence that we're on the right track, then merge everything to main
with flag OFF, then continue optimizing. I don't want to land this stack
if there are fundamental issues that warrant big changes."* So the
near-term goal is a CONFIDENCE VERDICT (are there fundamental issues?)
→ land the stack OFF → optimize on main; the flip is later and keeps its
ordered gates (Phase 7 task 1), which no longer gate landing.

**Stage C outcomes:**

- **OW28 — CLOSED**: served compilation uses the accepted outbox and
  completion path described in `builtins.md` §3. Compilation readiness and
  child setup are separate transactions; setup resolves the request inside
  the serving graph. The coverage register owns the acceptance cases and
  the remaining family investigations.

  A deterministic scoped child owns one shared piece registration with node
  groups keyed by canonical program identity. Instances selecting the same
  program share a group; the stored selection is a dependency and basis read
  before authored work. User and session identity also keys setup evidence
  and keyless pointers. Handler dispatch, wave withdrawal, parent release,
  and restart must preserve the selected program of every other instance.

  Acceptance covers independently reactive user and session inputs,
  divergence and rejoining with graph-sharing assertions, clear and restart,
  accepted and withdrawn setup, and handler dispatch. Closing OW28 does not
  close its other-builtin or default-writable-handle follow-ups, or authorize
  an ON rollout independently of the owner's rollout decision.
- **The lunch gate (#5969) — RE-CHARACTERIZED, skip STAYS**: not
  `nowTick` timing (refuted; two positive pins) but a served-handler
  DOUBLE DISPATCH of one durable event (2–5× per click) plus a late
  divergent client echo the arrival gate strands; no production code;
  the dossier is the PR's Flag 1; the invariant RULED 2026-08-18 and
  the late-echo rule RATIFIED (below); the arrival gate KEEP.
- **The tuning trio (#5991) — DONE, ledger comment POSTED 2026-08-18
  (<https://github.com/commonfabric/labs/pull/5991#issuecomment-5337935897>;
  the second review round's report recovered on-branch beside the
  closeout, `stage-c/stage-c-tuning-independent-review.md`)**: T1 one CFC
  probe per commit; T2 retirement on arrival + the late-echo rule; T3
  honest deadline + mid-wave renew; the drain's in-flight guard. Every
  target met: two-browsers gate 16/16 at night-like conditions,
  `lease.lost` 0 in 22 runs, deadline lateness p50 25 ms, note
  createToView p50 8.9/5.8 s → 3.9–4.2 s.
- **Benchmarks (the gates table below carries the rows)**: FIRST
  (fan-out B tip) — ON could not COMPLETE the two-user journeys (chat
  0/3 series; lunch 0/1), note 5.4–8.2× slower: SLOWER / UNMEASURABLE.
  ATTRIBUTION — steady state masked by daytime LLM churn; two dominant
  terms: the server's per-demander DEMAND WALK and the client's
  whole-sidecar INTENT WATCH; the lease feedback loop; the chat "no-op"
  was the CLIENT arrival gate holding a correctly served value.
  RE-BENCHMARK (trio tip `b54bf5215`) — ON COMPLETES everything (chat
  2/2 n=20, lunch 2/2, note 2/2; `lease.lost` 0) but SLOWER: chat
  cross-user p50 7.4–9.7 s vs OFF 0.22–0.24 s; note createToView
  3.9–4.2 s vs 1.13–1.19 s. Flip performance gate NOT MET.
- **The owner's MEASUREMENT CAVEAT (2026-08-18)**: the OFF "4–42 ms"
  client-local number may not be the right comparator — speculative
  client-side execution stays (and stays fast); the honest server metric
  is TIME-TO-SETTLE ON THE SERVER; the several-second chat sends are
  clearly far too high regardless. The next benchmark measures server
  settle time EXPLICITLY (register OW38); the flip's performance BAR is
  an owner ruling.
- **The design pass — report LANDED; ruling set ACCEPTED 2026-08-18
  (owner, verbatim: "ruling set is accepted"); W0 DONE 2026-08-19 —
  PROCEED (d′) (the next bullet; the build train launched — see the
  ordered next actions below). Design (d)
  SUPERSEDED by (d′) per owner direction 2026-08-18 (same day).** The
  reconciled design is
  [`server-execution-v2/stage-c-design.md`](server-execution-v2/stage-c-design.md)
  (LIVE — a design + build work order for unexecuted work; it archives
  beside the closeout when the build lands); the three lens reports it
  reconciles sit beside the closeout
  (`stage-c/stage-c-lens-{spec-blind,d-server-walk,e-client-intent}.md`).
  Two design-class terms: **(d′) — the demand WALK is DELETED**: demand
  is the memory server's per-session TRACKED-IDS closure
  (`session.trackedIds` — the instance-keyed set of every doc a
  session's watches reach, narrowed by the selectors' schemas,
  maintained on every push, accumulated across overlapping watches,
  coarse on unsubscribe — RULED acceptable), exposed as the union over a
  space's client sessions with each row's demanding pair
  (`demandedInstancesForSpace`, the successor of `watchedRootsForSpace`);
  the serving loop marks the WRITERS of demanded instances as demand
  roots (a new `isDemandRoot` disjunct, bracketed per serving-loop.md
  §8) and runs the ones NOT CURRENT for a demanding pair (B7's
  per-instance clean bit; the basis index is the same predicate at
  activation); those runs' own reads pull upstream and dirty downstream
  — the client-side scheduler's model; structure changes ride the
  tracker's push-time re-traversal and a run's own read of a newly
  linked doc; NO structural-versus-value distinction anywhere. The
  former (d) — the STRUCTURAL WALK (one walk node per (scope-name, root
  id); a read-class traversal value-only changes do not fire) — is the
  FALLBACK (design §2F), reached only if (d′)'s refutation experiment
  finds a real hole (a value the client renders that goes dark with the
  walk gone and the schema right) or its one-push-late structural-growth
  cycle breaks the settle bar. (e) the intent watch → a NON-REACTIVE
  storage-notification listener keyed on the outstanding intent set
  (O(outstanding); zero txs, zero CFC probes, no scheduler node;
  interim: a schema-narrowed sink). Plus (α) the RULED double-dispatch
  implementation as a work item (deadline-time purge of unrun LT1
  leftovers; drain skip against a `streamEntry`-bearing copy;
  derivation-emitter orphan REFUSAL; a per-event run-count pin). Build
  acceptance = SERVER SETTLE TIME on the cross-user chat/lunch journeys
  sub-second at p50, measured explicitly (`waitForSettled`), plus
  client-local speculation latency preserved, note createToView flat in
  history, the §7 `demand` counter block ((d′) version), the OFF
  byte-identity witness; the refutation experiments run FIRST — W0 is
  (d′)'s cheap experiment (expose the closure, delete the walk on a
  scratch branch, run chat/lunch/note: do the demanded derivations
  still land, does anything go dark, what is the settle — including
  the one-push-late cycle and the 300 ms demand-wake grace) — RAN
  2026-08-19, PROCEED (d′) (next bullet); W1 is (d′)
  proper (memory-server exposure + push-growth `demandChanged`, the
  registry over the closure + the currency check, the demand-root
  bracket, deleting the walk, the pins) with the structural walk as the
  fallback branch W1-F (not taken); recommended shape: a train of three
  stacked PRs
  ((d′) → (e) → (α)). The design's ruling set (its §5) is **ACCEPTED
  2026-08-18 in full** (owner, verbatim: "ruling set is accepted"):
  the FOUR already-RULED items stand (no lazy demand — RULED in
  substance; the double-dispatch invariant; the measurement caveat;
  R-D — the coarse unsubscribe accepted for now, fine-grained future);
  the front-loaded demand sentence is RULED (a) — descriptive — and
  the (d′) text ("demand is the union of the demanding sessions'
  tracked instances (memory v2's schema-narrowed closure); the serving
  loop runs the stale writers of demanded instances; there is no
  demand walk") LANDED in serving-loop.md §1 the same day, RULED,
  AHEAD of the code — its implementation is W1 (register OW39; the
  SB/W "structural subscription" text stays the fallback's wording,
  now a re-ruling if taken); MOOT under (d′): the reach gap, Q3.3, no
  basis rows for the walk, the walk-node key; the one-liners all RULED
  per recommendation (no scheduler effect for the intent watch — with
  step 4's rebase RULED owed, register OW40; tracked-entry-only read;
  the tracked entry's mark SANCTIONED as the client's consequence
  carrier, with its guards; drops/errors ride `consequenceOf`; the
  stream stays subscribed while intents are outstanding; the
  W/eventWatermark backstop; scopes.md §9 → "ragged at the space→user
  hop"; the effects channel follows as (e)'s second step; the CFC
  zero-write probe skip is a CFC-owner rider, not this stage;
  `storageManager.subscribe`; the schema-narrowed sink only as an
  interim if two steps) — the spec text those unlock (events.md §5's
  pin, speculation.md §4 step 2's sentence, scopes.md §9's amendment)
  is RULED text that rides the build PRs, not landed with the
  acceptance (register: the ruling-acceptance delta). Flagged, not
  filled (design §2.8): the
  one-push-late structural growth (+ grace); the push-growth notify is
  a new site; the standing root kind is a new disjunct; the structure
  load stays root-scoped (linked pieces visible now); demander
  resolution for linked pieces' writers; `#demandersFor`'s key scan;
  the monotone growth of `trackedIds`.
- **W0 — (d′)'s refutation experiment — DONE 2026-08-19, verdict
  PROCEED (d′)** (report
  [`stage-c/w0-dprime-report.md`](../history/plans/server-execution-v2/stage-c/w0-dprime-report.md)
  beside the closeout, cherry-picked onto this branch, raw series under
  `stage-c/w0-dprime-raw/`; scratch
  `origin/claude/server-exec-v2-w0-dprime-scratch` @ `81b190820`, off
  `ed9e1cb2c`, no PR): no dark value; the closure OVER-demands, never
  under-demands (it follows a piece root's `source`/process wiring — a
  schema-narrowed watch still demands the piece's whole internal graph;
  an owner-visible cost property, recommendation: accept the tracker's
  set as the demand set, filtering by id class is a future row); server
  settle value-only p50 15–35 ms, structural-growth p50 220–510 ms
  (chat 220–253; ≤ 1.3 s p95) — the sub-second bar holds; chat n=20 ON
  2/2 with cross-user steps 2–43 ms (trio tip 2.6–10 s); note
  createToView unchanged 4.1 s (the (e) client term; slope 0.9 → 16 s);
  lunch 1/3 green on the scratch tip — the two reds are the
  DUPLICATE-CONSEQUENCE family ((α) double dispatch toggling a vote off;
  a duplicate join rendered), not stale values → W3 (α) is on the lunch
  gate's critical path. Three non-optional W1 obligations: the demand
  pass runs on deltas / off the wave's settle race, never per-row reads;
  keep the `#demandersFor` index; accumulate the demand-root counters
  in stats. The fallback W1-F is NOT taken; the report's §4 flags 9–14
  are additional W1 inputs.

- **The design build train W1/W2/W3 — BUILT, REVIEWED, FIXED,
  LEDGERED, RE-STACKED (2026-08-19).** W1 (d′) #6029 @ `963ff600e`:
  review 0 BLOCKER / 3 MAJOR / 9 MINOR / 6 NIT → ALL dispositioned
  (the vacuous-pin MAJORs became real pins — P-arrival-closure,
  P-release, the cross-piece/array-growth landing AS the assertion;
  the push-growth notify principal-filtered; OW41 minted = the
  O(closure)-per-wave demand pass, the incremental-delta exposure).
  W2 (e) #6039 @ `ac30dd233`: review 0/1/7/6 → all dispositioned
  (MAJ-1 — re-entrant `trackIntent` double-applying a retired id —
  fixed with the per-entry LIVE tracked-set gate; OW42 minted = the
  tracked-set drain, trigger OW24, RENUMBERED from OW41 at the
  re-stack); plus **W2.1**, the cascade-echo fix, shape (a):
  `retireIntent(P)` also retires P's client cascade descendants (pins
  W2.1-1..4 + the e2e pin; the lunch gate's "both join lands" step now
  asserts the CONFIRMED roster — exactly {Alice, Bob} chips on both
  browsers — not the count the stranded echo satisfied in 7–16 ms).
  W3 (α) #6043 @ `42674af15`: review 1 BLOCKER / 2 MAJOR / 3 MINOR /
  4 NIT → B1, the α1b LOST-DELIVERY regression (a same-eventId
  sibling's survival marked the entry processed; the drain never
  re-delivered) FIXED + pinned (F1: only the LT1 copy's OWN run marks
  its seq-less entry), F2 the orphan refusal folds same-eventId
  siblings (neither half of an orphan lands), OW35 re-read honestly,
  OW37's direction corrected with the loads.
- **The critical-path item — the SWATCH STALL — ROOT-CAUSED
  2026-08-19** (report:
  [`stage-c/swatch-stall-rootcause.md`](../history/plans/server-execution-v2/stage-c/swatch-stall-rootcause.md);
  read-only investigation, mechanism reproduced instrumented on both
  the builder's configuration and the F1-fixed tip,
  heal-probe-confirmed). Mechanism (the report's §0): under (α) the
  lagging voter's purged castVote child makes its click a MARK-ONLY
  commit (the drained child's votes land one commit later); W2.1
  retires the click's cascade echo at that mark, and with nothing
  confirmed covering the echo's docs the flip visibly regresses the
  client, whose re-derivation from the regressed base seals a
  DIVERGED speculation layer — a literal `splice remove@1` tombstone
  over the swatch VDOM doc, deleting the voter's own span; the
  server's healed derivation ARRIVES under that layer (delivery is
  fine — the doc's confirmedSeq advances past the healed write), and
  BOTH convergence paths are dead: the swatch computed is an
  UNDEMANDED pull computation the scheduler legally never re-runs
  (liveRefs 0; an explicit settle does not run it — probe-verified),
  and the tombstone cannot retire because the space-server's
  watermark FREEZES below its floor on a quiet space (i10: W 71 vs
  floor 72; f1: W 67 vs 68) until ANY authored commit advances it —
  probe-verified: one keystroke in an unrelated input healed the
  stalled browser within one 500 ms poll, while two explicit settles
  did nothing. Classification: the builder's 5/5 reds plus 8
  instrumented reproductions (arm A i6/i7/i10/i15 + arm B
  f1/f7/f9/f10; the digit was recorded as 7 here and in the register
  when the row was minted — corrected by W3.1 per the report's own
  tables) are ONE class — delivered-but-masked; 0
  never-delivered; 0 B1; F1 tested and ORTHOGONAL (4/10 on the F1
  arm vs 5/13 builder / 4/15 arm A — no movement). Named defect: **a
  diverged speculation layer with no reachable retirement on a quiet
  space** — W2.1 + (α) is the (currently only known) producer; the
  retirement hole is general and pre-exists W2.1. Fix seats (report
  §4), the choice OWNER-LEVEL: **S1** — advance the watermark over
  the tail derivations at drain-settle (cheapest; the CLASS fix for
  every producer, and it drains the 30–40-entry lingering stacks;
  also makes W honest at quiescence, which W4's `waitForSettled`
  metric needs; OWNER-LEVEL because W's "covers inputs" meaning is
  RULED text — ruling request (10) below); **S2** — shape (b)
  deterministic cascade ids (identity-level; removes the producer AND
  the flicker; already owner-flagged, ruling (8)); **S3** —
  arrival-gated cascade retirement inside W2.1 (the flicker witness's
  existing predicate as the gate; buildable NOW without a ruling if
  the rulings lag, but it changes stated W2.1 semantics — flagged,
  not chosen unilaterally); **S4** — demand sink-rendered computeds
  (NOT recommended: reverses the deliberate server-execution
  narrowing; the OW32 re-derive-forever class). Coordinator
  recommendation ON FILE: **S1 now (once ruled), S2 stays the flagged
  follow-on, S3 only as a stopgap**; register row OW43 (the sweep's
  accepted-lingering premise) minted with the report. The lunch ON
  skip STAYS (lift rule unchanged: the stall resolved + 3/3 green on
  the train tip). **W4 — the settle-time re-benchmark — remains
  gated until the chosen seat lands and the lunch gate is 3/3 with
  honest swatch walls.** The three re-stack lunch runs at the train
  tip — the first evidence on the TRUE combined configuration
  (W2.1 + α + F1) — are read by the report (§5).
  **Recorded (2026-08-19, tip `b2ecd93b0` = code `42674af15`; ON binary
  sha256 `66182d7638de4ea4…`, gitSha read back per run, `No default
  model available` per run, fresh store per run, ports 8975/8976/8977,
  `gtimeout --kill-after=30 520`; the box carried the investigation's
  own workloads — loads recorded, not excused): 3/3 GREEN, and the
  stall SHAPE appeared once WITHOUT reaching the timeout** — r1 total
  5.65 s (join 254 ms, merge 493 ms, swatches 1 ms; load 271→148); r2
  total 3.96 s (join 254, merge 394, swatches 1 ms; load 67→54); r3
  total 46.3 s — the swatch step took **28,266 ms** (join 253, merge
  429; the only run with commit conflicts/reverts — host 1/17, guest
  1/2; server settle structural-growth max 11.3 s vs r1's 2.6 s; load
  45–94). Every run: events appended 11 / processed 12 (1 purged LT1
  leftover), consequence multiplicity {1: 16} — the (α) exactly-once
  invariant HELD; `users` spliced exactly twice; votes 3 adds / 0
  removes — NO toggle; flicker counters host 2/1, guest 2–3/0; the
  join step honest (confirmed roster) in all three. r3 is the stall
  mechanism RECOVERING inside the 60-s timeout — read by the report's
  §5 as an accidental layer-lifting path (the only run with commit
  reverts: a rejection cascade drops speculation layers), consistent
  with the §3 endgame; not a lift basis.
  **S1 LANDED + the skip LIFTED (2026-08-19, W3.1, tip `f250feacd`):**
  the ruling at owner item (10) below; protocol.md §4's
  quiescence-advance amendment + the space-server seat + red-first
  pins (`executor-settle-advance.test.ts`; OW43 CLOSED); the lunch
  gate 6/6 green with every swatch wall at 1 ms (item (9) above
  carries the ledger); the chat n=20 smoke at the tip: PROVISIONAL,
  one run, load 4.3–4.4 — series complete, median 544 ms (q1 459 /
  q3 563 / max 622), events 28/28, purge/refusal/orphan 0/0/0,
  settleAdvances 54 over 193 waves (quiescence-only, never
  per-wave). W4's gate condition — "the chosen seat lands and the
  lunch gate is green with honest swatch walls" — is now MET.

**Ordered next actions:** (1) #5991's ledger comment — DONE 2026-08-18
(posted; the second review round's report recovered on-branch); (2) the
design BUILD stage per the design's §6 work order — **DONE
2026-08-19**: the §5 rulings DONE (ruling set ACCEPTED 2026-08-18; the
(d′) demand sentence landed), W0 DONE (PROCEED (d′), above), then
W1 (d′), W2 (e) — its own W0 gate PASSED (the narrowed sink collapsed
the per-note client `scheduler/run` from 0.84 → 14–20 s to a flat
~0.1 s; createToView p50 4.03 → 0.81 s), then (a) replaced the sink
outright, the effects channel followed — plus W2.1 (the cascade-echo
fix), and W3 (α) (the l3 duplicate join root-caused and closed at the
three seats), EACH built → independently reviewed → fixed → ledgered
(the train-map links above), and the train RE-STACKED into its final
order design → W1 → W2 → W3 the same day (every suite green at the
train tip `42674af15`; the tip counts in PR #6043's body); (3) the
SWATCH-STALL root cause — **DONE 2026-08-19, ROOT-CAUSED** (the
critical-path item above; report
`stage-c/swatch-stall-rootcause.md`); (4) its fix in the RIGHT seat —
**DONE 2026-08-19 (W3.1)**: S1 RULED (item (10)) and LANDED
(protocol.md §4's quiescence-advance amendment, the space-server
seat, red-first pins, OW43 CLOSED, the lunch skip LIFTED on 6/6 —
items (9)/(10)); S2 stays the flagged follow-on, acknowledged and
deferred (ruling (8)), S3 not
taken; (4′) the owner-rulings batch — **DONE 2026-08-19, NO OPEN
OWNER QUESTIONS** (α1b RATIFIED; flag 9 accepted, OW44 minted; OW31's
read side RULED; shape (b) acknowledged/deferred — the rulings block
below carries each); (4″) the combined W2.1+S1 INDEPENDENT REVIEW —
**DONE 2026-08-20**: read-only at `4bf914a70`, verdict
**LANDABLE-WITH-FIXES (2 MAJOR / 5 MINOR / 8 notes)** — no blocker,
no lost/duplicated delivery, no OFF change; OW43's closure verified
justified and the skip lift corroborated (an independent 7th green
lunch run, {1:16}); the FIX ROUND landed the same day on the train
tip: **F1 FIXED** (the seal-time jobless checks walk the cascade
thread — the late-grandchild-of-silent-child strand closed, pins
W2.1-3-ext/6/7 red-first) and **F2 FIXED** (the latch consume gated
on bookkeeping-only advance waves — the mid-seal content fold no
longer strands the folded tail; deterministic pin 6 red-first),
F3/F5/F6/F7 fixed, F4 register-noted on the (b) row; reports
on-branch (`stage-c/combined-w21-s1-review-report.md` verbatim +
`…-fix-report.md`); both PR ledgers updated (#6039 notes the F1 fix
rides the train tip); the fix-tip gates: lunch 3/3 with every swatch
wall 1 ms and {1:16}, chat n=20 median 375 ms with settleAdvances
quiescence-only → (5) W4 — the
settle-time re-benchmark (server settle measured explicitly,
`waitForSettled`) — its gate (**not before the chosen seat lands and
the lunch gate is 3/3 with honest swatch walls**) MET 2026-08-19 and
RE-MET 2026-08-20 at the fix tip — **DONE 2026-08-20 (verdict: 6 of 7
acceptance bars PASS)**: server settle all-inputs p50 **18/15 ms chat,
17/20/17 ms lunch** (sub-second bar PASS both journeys; growth-to-landing
p50 258–520 ms); the several-second sends GONE (chat arrival median
520/421 ms vs OFF 217–253, was 7.4–9.7 s; lunch 3/3 green, joins 254 ms,
swatch walls 1 ms, {1:16}); note createToView FLAT and below OFF at p50
(991/829 vs 1 100–1 193); `lease.lost` 0 in 7/7, no `walkRuns` key, OFF
witness held, OW37 re-read 1.55–2.22 advance-subtracted; the ONE failed
bar is the sender echo as worded (not ms-class in either arm; ON 1.5–2.4×
OFF on chat — attributed to the client (e) term, absolute values
sub-half-second) — report
[`stage-c/w4-acceptance-report.md`](../history/plans/server-execution-v2/stage-c/w4-acceptance-report.md),
raw under `stage-c/w4-raw/`; OW38 (i) LANDED with it, (ii) the flip bar
stays the owner's;
(6) the CONFIDENCE VERDICT to
the owner — the W4 readout carried it, and the owner approved the
landing strategy; (7) land the train on main with
the flag OFF — **IN PROGRESS 2026-08-21: integration PR
[#6096](https://github.com/commonfabric/labs/pull/6096) OPEN (one
merge of main into the train tip, both intents preserved; the
reconciliation report beside the closeout carries the ledger,
findings, and verification), and the FIRST-ON-CI GATE is in
(2026-08-21, run 32447348664): seven real ON red surfaces, no demand
hole, all write-path defects (two = the owed OW31/§2b build
surfacing), lunch + chat ON gates GREEN in CI — resolved
SKIP-AND-LAND: honest ON-skip entries + owed rows OW45–OW53 + the
harness posture fix + the coverage re-baseline ride the branch (gate
record:
[`stage-c/first-on-ci-gate.md`](../history/plans/server-execution-v2/stage-c/first-on-ci-gate.md));
the coordinator merges on green** — then continue on main; (8) the
flip's ordered gates as listed under Phase 7, unchanged by the gate
and now concretely enumerated: the ON skip list back to **EMPTY**
(2026-08-22: patterns 1 file + 1 step, runner 1 file, runtime-client
2 steps — every entry naming its owed row), **OW31's ruled posture
BUILT**,
the gate's **owed rows OW45–OW53 CLOSED**, deployed binaries
exercised ON, and the **benchmark against the owner's ruled bar**
(OW38 (ii)) — then the flip PR and the soak.

**Owner rulings (state at 2026-08-19 — NO OPEN OWNER QUESTIONS: the
2026-08-19 batch ruled OW31's read side (3), flag 9 (6) and α1b (7),
and acknowledged/deferred shape (b) (8); #5968's Flags (5) stay on
file awaiting ratify-or-direct, flagged, not blocking):** (1)
served-handler DOUBLE-DISPATCH parity gap — **RULED
2026-08-18** ("agreed with your recommendations"): events.md §4 states
the one-entry-one-COMPLETED-delivery invariant (not completed in its
appending wave → the drain alone dispatches; a derivation-kind
emitter's superseded LT1 leftover re-arms nothing and its orphan
delivery is REFUSED), enforced by the deadline-time purge of unrun LT1
leftovers + the per-eventId drain skip (the trio's guard is the drain
half; the (α) purge is OWED to the design build stage — register OW35);
(2) the late-echo arrival-gate rule — **RATIFIED 2026-08-18** as
written (speculation.md §4 step 2 RULED; OW36 closed); (3) OW31's
write-authority posture — **RULED 2026-08-18**: the serving identity
never writes into users' home spaces, the USER's identity does (wish
provisioning, `.inSpace()` genesis); genesis is signed by the new
space's own keys and names the acting user OWNER in that same first
commit, the service neither owner nor actor; the served writes are
already delegated, the one defect is the served genesis ACL's content
(service-owned); the READ side — **RULED 2026-08-19** (owner,
verbatim: "ACL can be read with service identity, but all other reads
must be user identity (but if this is wrong, flag for follow-up work
after merging to main if criteria succeeds)"): the service identity
may read the ACL ONLY, every other served read runs under the USER's
identity (mirroring the ruled write posture), SUPERSEDING the scoping
report's read-only-service-class recommendation (the report stays as
history); if the posture proves wrong during the build, FLAG for
follow-up after merging to main (the merge happening if the
confidence criteria succeed) rather than blocking — work order
recorded (register OW31; the
scoping report beside the closeout), implementation OWED POST-MERGE,
BEFORE the flip PR, OFF-invisible; (4) the design-pass set —
**ACCEPTED 2026-08-18** (owner, verbatim: "ruling set is accepted";
the design's §5, `server-execution-v2/stage-c-design.md`): every open
item RULED per its stated recommendation — the (d′) demand sentence
RULED (a), descriptive, and LANDED in serving-loop.md §1 the same day
ahead of the code (implementation W1 — register OW39); the one-liners
as recommended; step 4's rebase RULED owed (register OW40); the other
spec sentences the rulings unlock ride the build PRs as RULED text —
with the FOUR already ruled and folded in (no lazy demand, the
double-dispatch invariant, the measurement caveat, and — by the
2026-08-18 direction that superseded (d) with (d′) — R-D, the coarse
unsubscribe accepted for now with fine-grained future) and four items
MOOT under (d′) (reach gap, Q3.3, no basis rows for the walk, the
walk-node key) unchanged;
(4′) the **(d′) direction itself — 2026-08-18** — "the client-side
scheduler seems to work well without differentiating structural changes
from just value changes … the set of documents the client cares about
… memory v2 has all that implemented … it doesn't unsubscribe in a
fine-grained way … acceptable … we keep that list, for each document
there see whether it is current via scheduler metadata and if not
update it. that then creates new reads that trigger later updating" —
adopted as the design premise (design §2.0), the structural walk
demoted to fallback (§2F);
(5) #5968's Flags (instantiation seat, `resolvedHash`, fetch-parity on
live completion failure, `plainProgramOf`), UNRULED;
(6) W0's flag 9 — the closure follows `source` wiring (a schema-narrowed
root watch demands the piece's whole internal graph; over-demand, never
under-demand — the W0 report's §2(b)/§4) — **RULED 2026-08-19,
accepted as recommended** (owner, verbatim: "log as a future
improvement, together with not running the pattern on the client
immediately"): the tracker's closure IS the demand set; register row
OW44 minted as the future improvement, pairing the closure filtering
(id class / value reach) WITH lazy client instantiation (the client
not running the pattern immediately), trigger the optimize-on-main
phase;
(7) **α1b ratification — RULED 2026-08-19, RATIFIED as it stands**
(owner, verbatim: "ack", to the ratify-as-written recommendation):
events.md §4's DATED clarification (the late-seal refusal of
in-flight LT1 copies) —
including the AMENDED sibling paragraph from W3's fix pass: the
lt1-only survivor marking (B1/F1), the orphan refusal's same-eventId
sibling fold, the late-seal SPLIT residual stated, and the
named-not-built tightening — now carries the RULED marker with the
attributed quote, the DATED/AMENDED trail kept as history; the
split-residual tightening stays a named follow-on;
(8) **cascade-id shape (b) — ACKNOWLEDGED / DEFERRED 2026-08-19**
(owner, verbatim: "ack, revisit later if flicker is too high or as
optimization. honestly, flicker might be acceptable for a first
launch since status quo flickers as well."): deterministic
cascade ids derived from the parent event id + the send ordinal, both
sides; the register's FUTURE row beside W2.1 — structurally removes
the swatch-stall exposure (the echo stands until the child's own
landing), and its register trigger names the stall; the trigger is
CONFIRMED, and the owner's recorded judgment — first-launch flicker
likely acceptable, the status quo flickers as well — SOFTENS W4's
flicker bar (W4 still reports the flicker counters, so "too high" is
a number);
(9) **the lunch ON-skip lift — DONE 2026-08-19 (W3.1)**: the stall
resolved (S1 landed, ruling (10) below) and the gate ran 6/6 GREEN
fresh-store on the ON-built binary at tip `f250feacd` (sha256
`53a712cede690b6e…`, `No default model available` per run, loads
2.3–3.7): totals 3 467–4 334 ms, joins honest 254–256 ms, the stalled
step ("both voters' swatches visible") **1 ms in every run** — no
28-s recovery, no timeout; events 11/12 with the purged LT1 leftover
×4 and 11/11 ×2 (clicks coalesced); consequence multiplicity {1:16}
in all six stores; settleAdvances 10–13 per run. The entry is removed
from `tasks/server-execution-on-skips.ts` (the lift ledger lives in
that file's header comment and the skip-list test asserts the
one-entry state);
(10) **the S1 watermark ruling — RULED 2026-08-19** (the swatch-stall
report's fix seat S1; register OW43). The request: amend the RULED
"W covers inputs" sentence so the space-server's watermark also
covers the TAIL DERIVATIONS at drain-settle on a quiet space —
advance/emit W past the settled tail's derived seqs, making "each new
input lifts the previous generation" hold without requiring a NEXT
input; server-local and small, the CLASS fix for the diverged-layer
retirement hole (and it makes W honest at quiescence, which W4's
`waitForSettled` metric needs). The owner, in chat, responding to the
coordinator's recommendation of S1:

> S1 sounds good.

— owner (Berni), 2026-08-19. That rules seat S1 and nothing else
(α1b's ratification (7) and flag 9 (6), then still pending, are RULED
by the later 2026-08-19 batch above; shape (b) (8) stays the flagged
follow-on, acknowledged/deferred the same day; S3 not taken). Landed
by W3.1: the
protocol.md §4 quiescence-advance amendment (the governing sentence
quoted there, the extension dated and attributed), the serving-loop
§3 drain-settle step, the space-server seat with `settleAdvances`
counters, and the `executor-settle-advance.test.ts` pins (red-first
on the pre-S1 tip; register OW43 CLOSED).

## Phase 0 — Rulings and guardrails

Tasks:

- [x] Owner confirms or amends **D-v2-1** (events are the client's only
      computational commit) on PR #5269 — **RULED YES 2026-08-02:
      events-down from day one.**
- [x] Owner rules Q1 (offline event queueing) and Q6 (effect authority
      for multi-user triggers) far enough to unblock Phases 3 and 1
      respectively — **RULED 2026-08-02**: offline events discharge on
      reconnect and a conflicting discharge is dropped with a client
      notice (events.md §5, speculation.md §5); effect run cardinality
      follows cell scopes, quota attribution deferred (README §3.8,
      §6).
- [x] Owner + spec review of cell SCOPES (`user`/`session`) end to
      end — v1's scope confusion must not carry into v2; answered the
      user/session-derived-state question (README §6 Q7, was ledger
      L10; runtime-mapping.md N56): the SpaceServer derives EVERY
      instance of every scoped node — RULED 2026-08-02 (batch 3,
      scopes.md §1) — and its run-supply half (one instance per
      demanding principal, materialized on demand, ragged below the
      space→user hop) RULED 2026-08-16 and LANDED by fan-out stages A
      and B 2026-08-16/17 (scopes.md §2; verification-coverage.md OW17,
      CLOSED as a row — its flagged residuals, the served-host wish
      pin, the sidecar per-demander refinement, and the unstamped
      non-sqlite effect writebacks, stay owed THERE, as refinements to
      the built mechanism; `packages/runner/src/scheduler/fan-out.ts`).
      What the scopes review itself still owes is session-data GC
      (scopes.md §8 item 2), a deferred design, not a blocker. Q6's
      non-quota remainder —
      per-run identity for served effects — RULED 2026-08-02, R-Q6b:
      service-identity envelope, attribution within the derived
      commit (protocol.md §1/§7; runtime-mapping.md N57 resolved).
      **In progress 2026-08-02**: the batch-3 rulings are drafted as
      [scopes.md](../specs/server-side-execution/scopes.md) (scope
      keys instances, never authority). Scout complete 2026-08-02:
      scopes.md anchored (§Anchors verified), the five
      main-vs-SpaceServer mismatches M1–M5 recorded (scopes.md §7).
      Batch-4 closures 2026-08-02: watermark × fan-out (composition
      — undemanded instances never hold W back; corrected below),
      `scheduler_context_floor` (deletes with the
      observation machinery), the M3 write path (R-Q6b). Adversary
      round 3, 2026-08-02: the M3 ruling's READ half is now closed
      too — reads may name an explicit `entity_scope_key`,
      admissible only for the space's live lease holder (scopes.md
      §7 M1, protocol.md §2), and run identity for
      non-handler runs is per DEMANDED INSTANCE (scopes.md §5). The
      batch-4 fan-out closure was CORRECTED: the discovering wave
      writes the redirect AND its own run's instance, and W waits on
      demanded siblings (scopes.md §2). The residual open that
      remains is session-data GC — the basis-index DDL is authored
      in serving-loop.md §3b — and that GC must cover non-session
      keys too. **Owner modeling ruling 2026-08-03 — the transaction
      identity model (protocol.md §1) — closed the two remaining
      ledger items:** LD5 (the read row is RATIFIED as the read half
      of the server-driven commit variant — a protocol change, and
      the intended one) and LD3 (the `scope_key` format is PROTOCOL
      vocabulary, defined once in the wire-shape module
      `packages/memory/v2.ts` beside `CellScope`, imported by engine
      and runner alike; the runner constructs keys from demand-/
      `firedAt`-supplied identity and never resolves them from
      ambient state — key-vocabulary.md §3). Phase 1 stage E is
      unblocked.
- [x] Name the single flag — NAMED 2026-08-02:
      `EXPERIMENTAL_SERVER_EXECUTION` (RuntimeOptions key
      `serverExecution`), deliberately distinct from v1's
      `SERVER_PRIMARY_EXECUTION` so archived docs never alias it —
      and register it in `EXPERIMENTAL_OPTIONS.md` with both states
      defined; OFF is today byte-for-byte. REGISTERED 2026-08-04
      (stage A): env → runtime → ambient control point in
      `packages/memory/v2.ts`, both states defined in the registry.
- [x] CI runs a flag-ON arm of the integration suites from the first PR
      that has anything to test (v1 lesson: the flags-on branch never went
      through CI) — STOOD UP 2026-08-04 (stage A): the pattern and package
      integration suites run a second, flag-ON arm with the explicit
      per-phase skip lists in `tasks/server-execution-on-skips.ts` (empty
      as of stage A).
- [x] Stand up the scenario-trace suite
      ([scenario-traces.md](../specs/server-side-execution/scenario-traces.md),
      2026-08-03) — twelve end-to-end journeys, cell-by-cell with
      citations, executed by smaller-model agents under the
      cite-or-GAP / flag-don't-fix protocol with owner-tier
      adjudication. STANDING RULE: re-run affected traces after
      every ruling batch that edits a detail doc; unexplained
      reference-answer drift is a finding. First run's LT1–LT9 all
      RULED 2026-08-03 (scenario-traces.md §6): same-space cascade
      appends are wave-carried write-level entries (unblocks
      Phase 3's spec side); sessions client-global under
      inter-server trust; cross-space navigateTo deferred with the
      client-vended-stream future note; inheritance uniform across
      run kinds; plus the LT4/5/7/8/9 one-liners. Companion
      instrument
      [field-provenance.md](../specs/server-side-execution/field-provenance.md)
      (2026-08-03): per-field producer→carrier→consumer→retirement
      chains closure-checked across six path families — targets
      the destroyed-in-transit defect class the trace run showed
      dominant; same protocol, same re-run cadence.
- [x] Audit what server-execution surface, if any, exists on main
      (executor remnants, stats routes, doc references) and record it in
      this plan — RECORDED: runtime-mapping.md IS that audit (its
      N59–N61 note says so in terms); no executor exists on main,
      and the certificate/observation surface is measured in this
      plan's preamble (~25 files, five packages, ~110 goldens).

Success criteria:

- [x] Flag registered; a no-op ON arm passes CI identically to OFF
      (stage A, 2026-08-04).

## Interim postures — who does what, in the arm you are building

One table, one lookup: per milestone, who runs and who commits each
class of work. Postures BETWEEN the named milestones do not exist as
shipped states (spec §3.4 — no shippable intermediates); Phase 6
hardens without changing the posture, so it adds no row. Three
rulings shape the surprising cells: **L14** — the old Phases 1+2
merged, so "server derives" and "client does not" ship as ONE state
and a two-deriver interim never ships (owner, 2026-08-02; Phase 2
below); **F10** — client HANDLER writes stay authored-class until
Phase 3, a handler interim, never a derivation interim
(protocol.md §1's authored row); **D-v2-1** — events become the
client's only computational commit (spec §3.6).

| milestone | derivations: run by / committed by | handlers: run by / the client commits | effects performed by | scoped state (user/session instances) | client posture |
| --- | --- | --- | --- | --- | --- |
| OFF baseline (the OFF arm of every phase until Phase 7) | every client runtime / the clients | the firing client / the handler's writes, as today | the client running the node (cross-tab mutex arbitrates — runtime-mapping.md N44) | cardinality 1 per runtime: each client derives ONLY its own instance, keyed by scope NAME (scopes.md §7 M2) — sound because the identity is the runtime's own | today, byte-for-byte; any OFF-arm diff is a phase-gate failure (testing.md §2). Commits carry a `class`, and every client commit is `authored` — `derived` is never claimed off the flag (protocol.md §1) |
| Phase 1 stages A–G (flag OFF throughout) | as OFF baseline — the serving loop lands dark | as OFF baseline | as OFF baseline | as OFF baseline; stage E re-keys the vocabulary per instance WITHOUT changing OFF-arm behavior (at cardinality 1 the instance dimension is derivable from the session) | unchanged; a local ON flip CAS-storms against still-deriving clients — expected, local-only, never shipped (L14) |
| Phase 2 ON — server derives, client does not (first ON milestone; L14) | SpaceServer / SpaceServer, derived-class under lease; the client runs the same graph as overlay speculation only | the firing client, authoritatively / its handler writes, still authored-class (F10 — protocol.md §1) | server only (stage G outbox); the client reads effectful nodes through to last committed results | SpaceServer derives EVERY demanded instance: per-instance run identity (M1, stage F), per-instance keys (M2, stage E), per-`scope_key` push filtering (M4, stage F) — all three MUST be in before this gate | loses exactly one right — committing derivations (by construction); still commits UI-binding writes and handler writes; receives only its own applicable `scope_key`s (protocol.md §3) |
| Phase 3 ON — events down (D-v2-1) | unchanged | SpaceServer, reacting to the event commit / ONLY the event append; the local run is speculative echo, and the client handler-write commit path DELETES (events.md §7 — F10's interim ends) | unchanged | handler consequences land in the ACTING principal's instances, resolved from the server-stamped `firedAt` (scopes.md §5, protocol.md §2) | commits nothing but intent: event appends + UI-binding writes; echo via overlay |
| Phase 4 ON — effect channel | unchanged | unchanged | external effects: server only; session effects (navigate): the server COMPUTES the intent, the client ENACTS and acks by nonce (protocol.md §5) | the effects doc is itself a session-scoped instance; the ack is written into the session's own instance (protocol.md §5) | adds the effects-doc subscription and the enact/ack duty (the ack is an authored write) |
| Phase 5 ON — cross-space | home SpaceServer over foreign reads, under the piece's granted authority / commits HOME only — never derived into a foreign space (protocol.md §2b) | unchanged; cross-space mutation leaves ONLY as outbox event appends; `.inSpace` provisioning lands authored-class, foreign-first, under the event's acting principal | unchanged; the outbox also carries the cross-space appends | foreign reads name their instance explicitly, lease-holder-only (protocol.md §2's read row) | unchanged |
| Phase 7 flip (FLIP-READY landed DARK 2026-08-16; flipped ON by #6535 2026-08-28 after the ordered gates; since then a data-only toggle whose flips are dated deltas in the coordination block; removal is the split-out post-soak PR). **Every cell in this row describes the ON arm; whenever the default is OFF, the default arm is the OFF baseline row above and explicit `true` selects this one** | SpaceServer | SpaceServer / events only | server, plus the client-enacted channel | unchanged from Phase 5; session-data GC is the remaining owed design (scopes.md §8 item 2) | final: speculate freely, commit only intent; flag retires after the soak |

A surface a milestone has not yet landed (navigateTo before
Phase 4, cross-space before Phase 5) has no defined interim
posture: the ON arm skips it via explicit per-phase skip lists
(testing.md §2), never silently.

## Phase 1 — The serving loop, landed dark (seven stages, flag OFF)

The executor hosts one committing runtime per space: wake on accepted
commit, run the affected graph to fixpoint, commit derived changes. No
shadow pass, no claims, no evidence log. Placement from input links;
activation resolves demanded values and queued events — there is no
piece-start policy (serving-loop.md §1, RULED 2026-08-02).

The seven-stage cut below lands with the FLAG OFF THROUGHOUT: every
stage merges with the OFF arm byte-identical to today, and no stage
makes the ON arm a shipped state. The first ON-arm milestone is
Phase 2's,
merged from the old Phases 1+2 (owner, 2026-08-02): server derives
AND client does not — a two-deriver interim never ships. A dev may
flip the flag locally mid-Phase-1 and will see CAS storming between
the server and still-deriving clients; expected, local-only, fine.

Stages, one PR each except C, which is a three-PR train (below):

- [x] **A — flag + commit class + CI**: register the single flag
      (Phase 0's naming; `EXPERIMENTAL_OPTIONS.md`, OFF is today
      byte-for-byte); land the `class` commit metadata (protocol.md
      §1, §7); stand up the OFF+ON CI arms with explicit skip lists
      (testing.md §2); disable `stream-data` under the flag (spec
      §3.5). LANDED 2026-08-04: the class rides the commit record
      (`class` column, stamped per admission path — transact
      `authored`, the server's direct writes `system`; `derived`
      tripwired until stage B's lease check), and the ON arms run
      the full suites (skip lists empty).
- [x] **B — lease**: create the `execution_lease` table (engine-v3
      migration — none existed before it; v1-branch shape as prior
      art), the acquire/renew/expire cycle, and the derived-class
      admission equality check (serving-loop.md §2). `holder` is a
      PER-PROCESS identity — service identity + process-instance
      component, minted at process start (DR1, RULED 2026-08-03;
      serving-loop §2) — with the abort-before-reacquire discipline
      enforced in-process. LANDED 2026-08-04: the table is
      `(space, holder, expires_at)` — exactly three fields, the v1
      shape reduced away; acquire/renew/release are direct engine-table
      writes (`packages/memory/v2/execution-lease.ts` — a renewal is
      never a commit), the in-memory tenure counter makes a reacquire
      unreachable without first ending the lapsed tenure, and admission
      enforces the one equality check under the flag, judged by the
      memory server's clock (an expired row matches nobody). Landed
      dark: nothing drives the renew cadence until stage F's
      SpaceServer.
- [x] **C — main reduction** (a THREE-PR TRAIN, not one PR — the
      surface is ~25 source files across five packages plus ~110
      goldens, and the seams below are where it cuts cleanly):
  - [x] **C.1 — emission + consumers + goldens**: delete
        `completeSchedulerScopeSummary` /
        `completeActionScopeSummary` emission (ts-transformers) and
        every consumer (runner), and REGENERATE the ~110 fixtures
        under `packages/ts-transformers/test/fixtures/` in the same
        PR. Deleting at the source collapses the rest (spec §4's
        measured lesson).
  - [x] **C.2 — protocol + engine + client + tools**: replace the
        observation tables with the v2 basis index — standalone
        `(action, entity, seq)` rows keyed per scope INSTANCE
        (scopes.md §8), NOT reshaped from `scheduler_read_index` /
        `scheduler_action_state`, which drop with the rest
        (serving-loop.md §3b). Drive the migration off §3b's
        SEVEN-table list, not off `CORE_SCHEDULER_TABLES`
        (`packages/memory/v2/engine.ts:1275-1282`), which enumerates
        six and omits `scheduler_context_floor`. NO BACKFILL — the
        new table starts empty and opted-in stores lose warm start
        once (§3b). Carry the protocol-layer deletions that fall out
        with it: the `persistentSchedulerState` flag, its
        `serverFlags` hello negotiation, the
        `scheduler.snapshot.list` RPC, and
        `CommitData.schedulerObservation`; old-client compat is the
        existing hello-degrade path
        (`packages/runner/src/storage/v2.ts:2142`). Collateral that
        no byte-identical gate covers: `packages/state-inspector`
        (`scheduler.ts:15-19`, `246-281`), the `cf inspect` surface
        that renders it, and
        `packages/memory/v2/sqlite/guard.ts:16-33` — drop the dead
        names from the `CORE_TABLE_NAMES` blocklist and ADD
        `scheduler_basis`.
  - [x] **C.3 — flag retirement + doc archival**: retire the
        `persistentSchedulerState` entry in
        `EXPERIMENTAL_OPTIONS.md`, and archive
        `docs/specs/persistent-scheduler-state.md` plus
        `docs/specs/scheduler-v2/per-doc-rehydration.md`'s account of
        the persisted form per the documentation lifecycle.
- [x] **D — seal-into-wave**: action transactions seal into the wave
      accumulator server-side; per-doc CAS with per-write-class
      conflict handling; CFC stays per action RUN — `action ×
      instance`, never per action (serving-loop.md §3c–§3d).
- [x] **E — instance re-keying (scopes.md §7 M2)**, declared
      **OFF-ARM NEUTRAL**: re-key the scheduler, the dependency
      graph, and the basis index from scope NAME to scope INSTANCE
      at every site in
      [key-vocabulary.md](../specs/server-side-execution/key-vocabulary.md).
      (Scope note, 2026-08-03 dry-run: the basis index's key SHAPE
      is stage C.2's DDL — E feeds it instance VALUES through the
      engine-side writer, an engine identity consumer, not a tenth
      runner-side site; key-vocabulary.md §4's nine-site closure
      stands.)
      Neutrality is structural, not a hope: in the OFF arm scoped
      cardinality is 1 per runtime, so the instance dimension is
      derivable from the authenticated session and the re-keyed form
      computes the same partition today's name-keyed form does.
      This is the single biggest scope cost of the arc (scopes.md §7
      M2) and it is landed DARK, ahead of anything that depends on
      it — which is why it is its own stage rather than a task
      inside F. LD3 is RULED (owner 2026-08-03, key-vocabulary.md
      §3): the `scope_key` format moves to the wire-shape module
      (`packages/memory/v2.ts`) as ONE shared definition imported by
      engine and runner alike; the nine sites construct keys from
      demand-/`firedAt`-supplied identity, never from ambient state
      (OFF arm: the identity is the runtime's own authenticated
      session — key-vocabulary.md §3). The stage LEADS with that
      definition move. LANDED 2026-08-04: the vocabulary (constructor
      + parse/inspect helpers + `ProtocolError`) lives in
      `packages/memory/v2.ts` beside `CellScope`, and the engine
      re-exports the same objects — no twin exists; all nine sites
      (plus the server's query/watch doc keys, which share the
      tracker strings with sites 5–6) construct instance keys from an
      explicitly supplied identity — `Runtime.scopeKeyIdentity` /
      `IStorageManager.scopeKeyIdentity()` in the OFF arm, the
      querying session's on the server query path; the wave
      accumulator takes a `ScopeKeyIdentity` and constructs through
      the shared definition, so basis-index instance VALUES flow
      through the engine-side writer as specced.
- [x] **F — host + SpaceServer + watermark + gates**: executor host,
      per-space activation/park with demand-driven value pull — no
      per-piece start/stop (serving-loop.md §1, §3); pure structural
      built-ins served (spec §3.5 row 1); **M1 — per-instance run
      identity**: a derivation runs per DEMANDED instance and the
      demand supplies the identity, handlers take the event's
      server-stamped actor, and reads name their
      `entity_scope_key` explicitly under the lease (scopes.md §5,
      §7 M1; protocol.md §2); narrowing-redirect writes gain the
      EAGER VIA-USER HOP (scopes.md §2's MUST — differs from
      main's one-hop-per-event; assigned here by the 2026-08-03
      dry-run, which found the requirement owner-less), flag-gated
      so the OFF arm keeps today's behavior; **M4 — push keyed by `scope_key`**:
      dirtiness and delivery both key by `scope_key`, and a
      subscriber receives only its applicable set (protocol.md §3);
      pattern-source watcher +
      hot-swap in the SpaceServer (serving-loop.md §3e;
      `pattern-update-testing.md` scenarios are the acceptance
      surface — following a piece's origin is not a serving concern, so
      only the swap half lands here); the watermark doc + `derivedThrough` +
      `waitForSettled(space, seq)` (protocol.md §4, testing.md §3);
      the §7 counters; engine-side derived-envelope admission check —
      a derived commit's producing session must be the holder's own
      service session (defense-in-depth, RULED 2026-08-05;
      protocol.md §2). LANDED 2026-08-05: ExecutorHost + SpaceServer
      (activation on session open / authored admission via the
      admission-side observer, lease renewed on stage B's cadence,
      waves through stage D's machinery with per-run stamping at the
      scheduler's choke points, demand = live readers over the watch
      registry's roots, idle park honoring gate wakes), the
      `bookkeeping` stamp kind named (serving-loop §3d), the
      derived-envelope mapping `sessionKey == holder`, the read row
      (`GraphQueryRoot.entityScopeKey`, lease-holder-only), M4
      instance-keyed dirtiness/delivery with wire frames unchanged,
      the M1-cluster re-keys, the eager via-user hop (flag-gated),
      derivedThrough + the watermark doc + `waitForSettled`, the §7
      `servingLoop` health block, the schema-memo identity guard
      (OW10), both dischargeable stage-D bounds discharged (delegated
      foreign admission; read-only-space read sets folding into
      withdrawals), and toolshed wiring so the ON CI arm actually
      serves. Server-side hot-swap is verified end to end. Explicit opens
      follow source origins under piece-source-lifecycle.md, including served
      wish-sidecar opens. Tenure activation owes root existence, not a general
      network source-check.
- [x] **G — effectful + outbox**: serve `fetch*`, `generate*`,
      `sqlite*` behind request-hash memoization; the outbox; egress
      performed only here (effect authority per README §3.8; quota
      attribution deferred); recovery = basis-index re-marking,
      recompute pure nodes, reuse memoized effect results, no replay
      (serving-loop.md §4–§6). LANDED 2026-08-06: sealed post-commit
      effects defer to the per-space outbox and fire POST-wave-commit;
      the builtins' writebacks — marked with their effect key — commit
      as their OWN derived-class COMPLETION commits (never through
      §3d's sealing), annotations sourced from the outbox carriage
      captured at the original run's seal; the builtins' existing
      request-hash memo IS §4's hit rule (recovery re-runs memo-hit,
      no re-fire — pinned across park/re-activate with one external
      call per key); failures commit error-shaped results and retry
      only on input change (OW7 → T14); the DURABLE outbox rows (FP1)
      land inside the wave's engine transaction, deliver under the
      delegated row (`firedAt` from the carried actor, LT5 service
      envelope), delete on delivery-ack, and re-send on activation
      (§6 step 5) with eventId-horizon dedupe at the target; the
      stage-D sqlite bound is discharged (per-run scope keys +
      `attachWaveCommitSqliteDbs`, atomic in the wave tx); §7's
      memo/outbox counters are live. LLM partial-token writes stay
      un-marked by design — refused under the flag, which IS protocol
      §6's settled-results-only baseline (the OFF arm commits them as
      today).

M1, M2 and M4 (scopes.md §7) are therefore all landed BEFORE the
first ON gate, by name: M2 is stage E, M1 and M4 are stage F tasks.
Phase 2 flips ON with the SpaceServer deriving scoped instances on
per-instance machinery — never on scope-NAME-keyed machinery.

Success criteria (flag OFF — the ON gates are Phase 2's):

- [x] Every stage lands with the OFF arm byte-identical to today
      (testing.md §2, as amended — byte-identical up to the recorded
      acceptances: key-vocabulary §5's, and stage G's claim-guard
      delta recorded in verification-coverage §2, all RATIFIED
      2026-08-05); the ON arm
      runs in CI from stage A with explicit skip lists, never silent
      filtering (ticked with stage G, the phase's last stage,
      2026-08-06: every stage's PR carried its OFF-arm witness — the
      full runner + memory suites — and the ON-arm skip list AT THAT
      POINT held ONE entry, the two-browsers Phase 2 gate. Phase 2
      then retired that entry — the gate runs, and passes, ON — and
      listed its own: sx2-serving-loop, the demand-cycle starvation
      reproducer, at phase-2-followup; see
      tasks/server-execution-on-skips.ts for the current list).
- [x] Stage C leaves no `completeSchedulerScopeSummary` or
      `completeActionScopeSummary` reference on
      main, no full-JSON observation payload tables, and no
      `scheduler_context_floor`; the basis index is the only
      persisted scheduler state besides W and `eventWatermark`
      (landed 2026-08-04 as the C.1–C.3 train).
- [x] Stage E lands with the OFF arm byte-identical: the re-keyed
      vocabulary partitions state exactly as the scope-NAME form did
      at cardinality 1 (2026-08-04: partition equivalence pinned by
      `packages/runner/test/scope-key-rekeying.test.ts` against the
      name-keyed form; full runner + memory unit suites green; the
      runner package integration suite run in BOTH arms —
      flag-OFF and flag-ON toolshed — 14/14 each, ON-arm skip list
      still empty).

## Phase 2 — Flag ON: server derives and the client does not

The first ON-arm milestone, MERGED from the old Phases 1+2 (owner,
2026-08-02): the SpaceServer committing derivations and the client
losing its derivation-commit path ship as ONE state — a two-deriver
interim never ships (local bring-up runs of it are fine, per
Phase 1's note). Client HANDLER writes still commit authored-class
until Phase 3 lands events — that interim is Phase-3-related, not a
derivation interim, and stays (protocol.md §1).

Tasks:

- [x] Remove the client's derivation-commit path under the flag (by
      construction, not firewall). LANDED 2026-08-07: the speculation
      overlay is the DEFAULT seal destination of every non-serving
      flag-ON runtime (`packages/runner/src/speculation/
      overlay-destination.ts`) — a stamped derivation-kind run's
      writes redirect into the replica's pending layer and no code
      path from a derivation run to the wire exists; serving runtimes
      are marked `servingPosture` at construction and never default
      to it (the SpaceServer refuses activation without the mark).
- [x] Speculation overlay: run the derived graph locally, render
      immediately, replace on authoritative arrival (drop authority,
      never the ability to run). LANDED 2026-08-07: overlay entries
      apply through `sealNative` (speculative — outside the
      `synced()` barrier), render through the ordinary pending
      materialization, and retire on watermark coverage of the
      entry's read basis + acked origins via success-shaped
      `superseded` withdrawals (no cascade — an authored commit that
      read the echo is decided by CAS); chained entries re-sweep on
      settlement.
- [x] Effectful nodes read through to last committed results — never
      speculated. Result-as-pattern children may instantiate
      overlay-locally, converging by cause-derived identity
      (speculation.md §2, owner 2026-08-02). LANDED 2026-08-07: a
      speculative run's egress effect kinds are OWNED AND DROPPED at
      the destination (memo hits keep reading through; misses render
      pending), `navigateTo` stays enactable (reversible),
      `compile-and-run` clients observe committed results. The serving
      runtime compiles through the accepted outbox, records completion
      readiness, and instantiates the child in a derivation. Its acceptance
      coverage is the register's OW28 row;
      result-as-pattern children ride the derivation run's overlay
      writes.
- [x] UI bindings untouched: authored writes under existing ACL + CAS
      (unstamped transactions never divert; pinned in
      `speculation-overlay.test.ts` with the store-attribution query
      — the client's committed footprint grows by exactly the
      authored write).

Carried-in revisits (stage-F residual, accepted for Phase 1 — owner,
2026-08-05; both must be resolved before this phase's gates rely on
W):

- [x] The settle input-barrier distinction: `inputSynced` cannot tell
      a frame parked on the loop's OWN sealed commit from foreign
      novelty, so a foreign authored frame in that position can be
      claimed by W one wave early (self-healing next wave — the
      documented residual at `packages/runner/src/storage/v2.ts`,
      `inputSynced`). Either distinguish parked-on-own-seal frames
      from foreign novelty, or exclude unapplied frames' seqs from
      the wave's `batchHead`. RESOLVED 2026-08-07 via the exclusion
      alternative: `ISpaceReplica.unappliedForeignSeqFloor` +
      the SpaceServer's W-advance clamp (`watermarkClamped`,
      serving-loop.md §7) + the flag-gated shadow-flip notification
      in `confirmPending`, with the own-echo and seq-0 exemptions
      pinned both arms (verification-coverage.md's Phase-2 delta).
- [x] Source-check ownership is settled by piece-source-lifecycle.md and
      serving-loop.md §3e: the opener follows a piece's origin, and the server
      ensures root existence and reacts to accepted pointer changes. The
      tenure-wide source-probe obligation is superseded (OW18). Served wish
      sidecars follow their origins through explicit runtime opens. Current root
      coverage is `executor-space-root-ensure.test.ts`, including leaving an
      existing root's source alone across reactivation. Source-lifecycle and
      hot-swap coverage remain separate from the serving-loop's propagation
      and amplification gate.

**Follow-on stage (APPROVED — owner nod, 2026-08-07; its own PR
after this phase's, the way stage C's train was cut):**

- [x] **P2-F — the scheduler instance dimension + demand-cycle
      terminal state**: LANDED 2026-08-13. The per-(action ×
      instance) run SUPPLY: the N-run settle loop over demanded
      identities (the scheduler's reactive-action choke point
      consumes the SpaceServer's demanded-identity registry through
      the widened seam and runs a demanded action once per instance,
      each run stamped with its instance's identity and ACTING pair —
      instances live in keys/basis rows/stamps, never as extra graph
      nodes, C11b), the LT6 acting inheritance at the event-dispatch
      choke point, and the F1 piece-start surfacing (§3d's
      piece-start site, RULED 2026-08-13). The demand-cycle terminal
      state with commit-triggered re-arm (settle-gated retry) landed
      with the load pass moved under the flush deadline
      (verification-coverage.md's closed OW19 row), and the
      `sx2-serving-loop` ON-skip is LIFTED — the in-CI
      amplification-ratio gate runs. Deliberately narrowed, flagged
      not filled: the replica-level per-instance READ keying (one
      doc, N instances read locally) and per-(action × instance)
      LOCAL read-set/dirtiness precision remain owed together —
      they are one leg (a scoped doc's local state still collapses
      per scope name at cardinality > 1), tracked as the narrowed
      OW17 residue; engine-side instancing (keys, basis rows,
      annotations, carriages) is exact at any cardinality.

Success criteria (the old Phase-1 ON gates land here, merged):

- [ ] `counter` and `cfc-group-chat-demo-multi-runtime` green in the
      ON arm (client handler writes still authored-class until
      Phase 3).
- [ ] Byte-identical workload tests pass in both arms.
- [ ] `sx2-` gate tests settle on `waitForSettled`, no text-polling
      (testing.md §3).
- [ ] One authoritative run per upstream change (scheduler-run and
      commit counters, not logs).
- [ ] **~1 protocol commit per logical write** on the lunch-poll
      workload (v1 measured 60×; the counters exist — use them; the
      gate metric is testing.md §4's single ratio, ≤ 2 on pure
      workloads — a trigger, not a hard gate: a breach fails until a
      human inspects the why).
- [ ] Server restart mid-test: derived state reconverges, effectful
      nodes do not re-fire (store shows no duplicate effect results).
- [ ] Actor-side interactive latency at parity (v1 measured 292 vs
      318 ms).
- [ ] Client derivation commits gone: the store session-attribution
      query shows zero client-committed derived writes in the ON arm.

## Phase 3 — Events-down handlers (D-v2-1)

Tasks:

- [x] Handler fire commits the event only (payload + target stream);
      admission = append authority + CAS. LANDED 2026-08-10: the fire
      fork (cell.ts) commits a stamped append to the stream's sidecar
      doc via the fired-order event queue. LT9's persistence rides an
      injectable STORE SEAM whose default is in-memory (Phase 7,
      2026-08-15: LT9 RE-RULED process-lifetime — reload loss accepted
      this round; the durable adapter is retired, the manager-shared
      in-memory store stays). The
      scheduler tell is the discriminator — a send from a
      scheduler-stamped run commits nothing.
- [x] Server processes events — client-committed and server-originated
      (`stream.send()`) through the same path. LANDED 2026-08-10: the
      SpaceServer's sidecar scan drains BOTH producers (and delegated
      deliveries, and crash recovery) through one path; same-space
      emissions ride LT1's wave carriage AND process in their own wave
      (the emitted entry commits already-consequenced when its
      handler's contribution survived; a requeued run leaves it
      unmarked for the next wave's drain — C8b/C8d); cross-space
      emissions stage FP1 rows with acting carriage.
- [x] Client handler run demoted to speculative echo. LANDED
      2026-08-10: F10 deleted — the overlay destination diverts
      event-handler runs like derivation runs, tagged
      `intent(eventId)`; the echo retires on the consequence signal
      (the sidecar's value plane) with the watermark sweep as
      backstop, and drop/error notices signal subscribers.
- [x] Idempotent processing on durable event IDs: consequence committed ⇒
      event not re-run across restarts. LANDED 2026-08-10: the
      consequenced mark rides the handler's own transaction, the
      engine maintains the contiguous per-stream `eventWatermark`
      frontier inside the wave commit, and at-or-below-horizon
      duplicates skip as `skippedIdempotent` (the restart pins in
      `executor-events-down.test.ts`).
- [x] Ephemeral-value rule: values captured into the payload at fire time
      (transformer lint can trail as a follow-up). The fire commits the
      binding layer's converted payload verbatim (the capture); the
      lint TRAILS as the named follow-up.

Success criteria:

- [ ] Two-user lunch poll green with server-processed handlers; both
      votes survive, tallies correct.
- [ ] **Event commit → observing client's derived update ≤ 300 ms p50**
      on a quiet box (v1 baseline: 92–294 ms client-computed;
      306–453 ms was v1's residual with scaffolding half-off).
- [ ] Kill the server between event commit and consequence commit: on
      restart, exactly-once consequences, no lost events.

## Phase 4 — Client-effect channel

Tasks:

- [x] Session-scoped effect cells with ack/nonce retirement (spec §3.7).
      LANDED 2026-08-11: the effects doc is ONE well-known id
      (`SERVER_EXECUTION_EFFECTS_DOC_ID`, wire-shape module) whose
      per-session instances are keyed by `scope_key` (protocol.md §5,
      T9); intents append via tail-relative mergeable appends with
      ENGINE-side nonce dedupe against the stored instance (the
      serving replica's scope-name-keyed local view collapses
      instances at cardinality > 1 — the OW17 residual — so the store
      is the idempotency authority) and engine-stamped `issuedIn` (the
      stream-entry `seq` precedent); the ack is the session's own
      authored `acks[nonce] = true` mark (per-nonce marks — a scalar
      last-ack field would lose an earlier unretired ack under two
      quick intents; RATIFIED 2026-08-13: the owner ruled the map
      shape normative and protocol.md §5 now specifies it — the
      scalar `{ ackedNonce }` draft is retired, closing the
      2026-08-12 owner-review P1 flag); the next wave retires
      acked entries via a
      bookkeeping-stamped SpaceServer write per instance (addressing,
      no acting principal — protocol.md §1; serving-loop.md §3d),
      armed at activation and on ack admission, self-healing across
      bookkeeping drops; `effectAcks` counts ack commits at the feed
      drain (testing.md §4's amplification exclusion).
- [x] `navigateTo` served: computes the target, writes navigation intent;
      client enacts and acks; optimistic enactment allowed. LANDED
      2026-08-11 as the split contract (builtins.md §4): the acting
      event context travels from the handler tx to the builtin's
      action via the deferred-start capture
      (`builtins/navigate-context.ts`), the served half writes the
      intent in its own event-handler-stamped tx (the event's actor as
      `scopeKeyIdentity` — seal-time annotations address the acting
      session's instance), sessionless chains and LT3-disconnected
      sessions refuse loudly, and the deterministic nonce
      (`effectIntentNonce(eventId, instance)`) is what the flag-ON
      client's OPTIMISTIC enactment records so the authoritative
      intent converges without re-enacting — and what stands that
      optimistic enactment down when the intent got there first, so
      the journey navigates once in either order; the client half
      (`speculation/effects-channel.ts`) subscribes per space, enacts
      unacked intents, re-reads on resubscribe (the LT8 reload
      journey), and acks by nonce.

Success criteria:

- [ ] `topics-navigation` and the navigateTo paths green under the
      FULL flag-ON posture: server, test processes, AND the browser
      shell all flag-ON. A mixed-posture run — the ON-arm CI lane's
      current shape, whose binary ships the OFF-built shell — CANNOT
      satisfy this criterion, whatever its color: an OFF-shell green
      asserts nothing about the browser-ON behavior this phase added,
      and locally (where the harness bakes the flag into the shell
      define) `topics-navigation` is red on the unmodified Phase-3
      base (the inherited browser-ON red the P3 triage tracks). Tick
      only when `topics-navigation` runs green UNSKIPPED in a CI lane
      that builds the shell flag-ON (the owed ON shell build,
      verification-coverage.md OW25; the interim skip entry is in
      tasks/server-execution-on-skips.ts with the mixed-posture
      reason). The runner-level navigateTo paths are green —
      `executor-effect-channel.test.ts`, an ON-posture suite under
      both CI arms — and the `sx2-effect-channel` gate is green live
      in BOTH arms locally under the full posture.
- [x] An intent is enacted exactly once per nonce, including across a
      client reload between intent and ack (2026-08-11:
      `executor-effect-channel.test.ts` pins the optimistic/
      authoritative convergence at one navigation, and the LT8 reload
      journey — re-enact across the reload-wiped record, ack once,
      retire once, nothing resurrects; the full cold-process reload
      additionally rides protocol §5's owed client-side session
      persistence, OW20's trigger).

## Phase 5 — Cross-space and clearance by construction

Tasks:

- [x] Home-space runtime reads foreign spaces with the piece's granted
      authority; foreign commits wake the home runtime (server-internal
      subscription). LANDED 2026-08-14: foreign SPACE-scope reads flow
      on the serving runtime's ordinary storage plane (per-space
      loopback sessions), and the wake needed NO host machinery — a
      fan-out built for it was mutation-probed redundant and REMOVED
      (survival test): the foreign commit's frames arrive on the home
      runtime's own foreign loopback session, the scheduler re-runs
      autonomously off storage notifications, and the re-run's seal
      wakes the loop (the §3b server-internal wake — never home
      input; W stays per home space); activation's basis re-mark
      judges foreign rows against their own co-hosted engines
      (serving-loop.md §6 step 2, pinned at the helper —
      `selectForeignStaleInstances`).
      Foreign SCOPED reads are FAIL-CLOSED refused at both ends — the
      RULED 2026-08-13 delegated-scoped-read precondition: the
      grant-scoped read design landed in protocol.md §2 (carried actor
      + grant; resolution refuses, never envelope fallback), its
      fail-closed interim is the producer-side provider refusal + the
      admission-side unnamed-scoped refusal, and the read row gained
      FP2's cross-engine widening + the per-process full-DR1-holder
      sharpening (`v2-explicit-read.test.ts`'s Phase-5 arms,
      red-first).
- [ ] Per-reader clearance enforced where the read is served (sqlite row
      admissibility, CFC labels). (The per-reader memo/materialization
      machinery is builtins.md §2's landed base; cross-space label
      metadata flows with reads on the existing per-run CFC path.
      Foreign-batch sqlite attachment stays refused — no producer; its
      identity design rides the grant-scoped read design. Ticks with
      the acceptance gate below.)
- [x] `.inSpace()` provisioning server-side: foreign-first split at the
      wave commit step, event-derived deterministic DIDs (CT-1650),
      replay-idempotent (protocol.md §2b). LANDED 2026-08-14: the
      serving loop runs the wave's accept posture as an AUTHORIZATION
      boundary — a foreign write is admitted at accumulation iff the
      run carries the §2b delegated carriage (acting + capabilityRef)
      AND the acting identity holds a structural write grant for the
      TARGET space (the memory server's `foreignWriteAuthorityFor`:
      owner-by-identity, fresh-store creation with a DID-shape check,
      or the target's own ACL grant — fail-closed otherwise; the
      accept posture cannot be configured without the probe). A
      carriage-less or ungranted foreign write keeps the ruled
      action-scoped refusal. Foreign co-hosted engines resolve ahead
      of the commit step with per-space failure ISOLATION (an
      unresolvable target fails only its own contributions, counted —
      never a home-space park). The RULED wish line item rides the
      same crossing: per-demanding-identity wish resolution
      (builtins.md §5 — `homeSpacePrincipalFor`; the serving wish
      resolves the demanding user's home space, never the service
      identity's; sidecar surfaces AND their closure caches key per
      demanding identity, so two demanders never share a create
      surface).

Success criteria:

- [ ] The three v1 stragglers are the acceptance tests, green in the ON
      arm: `shared-profile`, `profile-embed`,
      `sqlite-read-clearance-multi-runtime`.
- [ ] Profile creation (the `.inSpace()` flow: `profile-create`,
      `home-profile`) green in the ON arm, including a kill between the
      foreign and home commits — replay converges on the same DIDs, no
      orphans, no duplicates. (The wave-level kill/replay halves are
      pinned — foreign-failure-withholds-home and
      requeue-after-foreign-landed in `executor-wave.test.ts`; the
      browser-flow gates carry the E2E.)

## Phase 6 — Push priority, budgets, scale

The watermark and `waitForSettled` land in Phase 1; this phase keeps
only push priority and the budget/backpressure hardening.

Tasks:

- [x] Push priority on the subscription channel: subscribed-doc
      `derived` commits flush first (protocol.md §3) — LANDED
      2026-08-14: two-phase fan-out (derived-subscribed sessions
      before bulk-only, across every connection), `servingLoop.push`
      counters; ordering pinned in
      `packages/memory/test/v2-push-priority.test.ts`
      (verification-coverage OW8).
- [x] Per-space budgets in the executor (CPU per wave, outstanding LLM
      calls, egress rate); a runaway pattern degrades only its own
      space — LANDED 2026-08-14: T_flush (stage D) is the per-wave
      compute bound — it bounds a wave's wall-clock accumulation
      between seals, not a single non-yielding action, which escapes
      any budget in both arms (pre-existing) — and is now env-tunable
      (`SERVER_EXECUTION_FLUSH_DEADLINE_MS`); the outbox gained the
      outstanding-network-effect cap (toolshed default 16,
      `SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS` — literal `0` opts
      out; unparseable values fall back to the default, loudly) and
      the egress-rate token bucket (`SERVER_EXECUTION_EGRESS_RATE_PER_S`,
      default unpaced) — serving-loop.md §5,
      `executor-outbox-budget.test.ts`,
      `toolshed/lib/server-execution.test.ts`.
- [x] Event/binding backpressure shaping ahead of the commit stream —
      RULED (a) and LANDED with Phase 7 (2026-08-15; verification-
      coverage OW27): per-stream token-bucket pacing in the client's
      event-append queue, pace-never-drop; the default posture (20/s,
      burst 20) is a flagged dial. (Original Phase-6 flag: the §3.8
      shaping's semantics were an unstated fork — pace vs batch vs
      drop, the hold-latency bound, per-stream keying, UI-default
      visibility.)

Success criteria:

- [ ] No integration test needs a poll-loop for "is the server done."
      (Gate landed: `sx2-scale` audits the sx2 family — watermark
      settles, no `waitForCondition`; ticks on CI green.)
- [ ] `cf-checkbox` in-suite ≈ isolated (v1 measured 4 s vs 138 s; flat
      accumulation is the requirement, whatever the v1 mechanism was).
      (Gate landed: `sx2-scale`'s accumulation test measures the
      requirement's substance headlessly — a late fresh space's settle
      latency stays in the first space's ballpark; ticks on CI green.)
- [ ] A deliberate LLM fan-out loop in one space leaves a second space's
      propagation latency inside budget. (Gate landed: `sx2-scale`'s
      isolation test — a 20-wide fetch fan-out against a slow local
      endpoint, the same egress class as an LLM loop, CI-runnable
      keyless; space B's settle stays inside the calibrated envelope
      and space A's `outbox.budgetDeferrals` proves the budget
      engaged; ticks on CI green.)

## Phase 7 — Flip and retire

**Current scoping (updated 2026-09-03): Phase 7's flip mechanism is landed
and the first-party default is a data-only toggle. The coordination-state
deltas above are the dated record of each flip (#6535 flipped ON 2026-08-28
after the ordered gates; every later flip adds a delta), and the registry's
summary table states the current value. Stable `default` and `opposite` CI
roles follow the one constant, so a flip in either direction is the
constant, the registry's cell and dated entry, and a delta above — never a
workflow edit. The ordered gates below are the bar for any flip to ON.
Task 2's OFF-path removal stays split into a separate post-soak PR, and
task 3 remains the final archive.** The original 2026-08-16
ruling landed the mechanism dark first because, at that time, with
the constant `true` the REQUIRED default CI lanes went red on merge
(two two-browser gates stall 300 s under the full ON posture, neither
skip-listed), the ON posture at that time broke every two-user browser
journey (OW32's client-side non-settling loop, unattributed) and the
piece-creation/compiler surfaces (OW28), and "flip-ready (true) and hold
the merge" parks the train behind several stages of work; landing dark
keeps the mechanism reviewable and revertable in small pieces and gives
CI an honest meaning on main.

Preconditions (all RULED 2026-08-15, all landed with this phase):

- [x] **OW27 — event-flood shaping, RULED (a)**: per-stream token-bucket
      pacing in the client's event-append queue, PACE-NEVER-DROP
      (README §3.8's implementation sentence; verification-coverage
      OW27 → LANDED). Default posture 20/s sustained, 20 burst — a dial,
      flagged. Red-first flood test (bounded rate, zero loss, fired
      order) + the disabled-pacing mutation witness. OFF arm untouched
      by construction (it never enqueues).
- [x] **The wish bootstrap write path — RULED `.inSpace()` chain**: the
      served create surface's `.inSpace()` provisioning stays on the
      existing chain (`optIntoInSpaceMultiSpaceCommit` →
      `enableCrossSpaceChildCommit` → the wave's grant-gated §2b accept
      posture; crossing count stays at two). What the lunch gate ACTUALLY
      needed, peeled in order and landed: (1) served-wish READ
      authority — under the flag the toolshed process identity is a
      memory service principal, so the loopback plane reads the
      demanding user's home space (`memoryServiceDidsFor`; OFF the
      configured list verbatim) — *this posture was later RETIRED by
      OW31's build (2026-08-21): the process identity became a
      DELEGATING principal whose serving sessions read as the space's
      owner via the `actingAs` binding, `memoryAclPrincipalsFor`;
      verification-coverage.md OW31*; (2) a flag-ON client's wish REFERENCES
      the served sidecar cell instead of fetching/instantiating it
      itself (the bookkeeping-authored instantiation raced the server's
      derived one — the ~13/s stale-basis loop); (3) the nested-piece
      DEMAND-ROOT CHAIN in the run supply
      (`SchedulerObservationIdentity.demandRootIds`) — the lunch
      pattern's `#profile` wish lives in a sub-pattern whose runs had no
      demanded instances and fell to the SERVICE identity's instances
      (`user:<serviceDID>` rows in the store) — the chain also carries
      through the LIST builtins' child instantiation since the fixer pass
      (review finding 4; the wish-sidecar sites are FLAGGED, not chained
      — verification-coverage OW29). Gate state: see the table — RED;
      the build's "(1)+(2)+(3) reaches the join UI" claim did NOT
      reproduce at head (the served wish throws identity-less at step 1;
      OW17's correction); the #5612 gate row NOT edited.
- [x] **LT9 simplification — RE-RULED (owner)**: reload survival is a
      non-goal this round; the queue is process-lifetime. Retired: the
      Web-Storage adapter and Phase 5's coupling seam; kept: the
      manager-shared in-memory store (in-process replacement survival)
      and its pins. events.md §5 / scenario-traces LT9 re-tensed with
      the owner's rationale; OW20 CLOSED as out-of-scope-this-round with
      the recorded future shape (per-tab persistence + orphan adoption).

Tasks:

- [x] **The flip — landed by #6535 (2026-08-28); the default has since
      been a data-only toggle, each flip a dated delta in the coordination
      block above.** The ONE first-party default `SERVER_EXECUTION_DEFAULT_ENABLED`
      (`packages/memory/v2/server-execution-default.ts`; the registry's
      summary table states its current value) is resolved by the
      `productionServer` / `remoteClient`
      presets, the shell define fallback, and toolshed's serving-host
      gate + memory ACL principal lists (the DELEGATING class since
      OW31's build); explicit `true` = the ON arm,
      explicit `false` = the OFF arm; the single-process presets keep the
      OFF baseline by construction (EXPERIMENTAL_OPTIONS.md). CI
      (testing.md §2) now uses stable `default` and `opposite` roles:
      default follows the constant with its shell define unset, and
      opposite is the explicit inverse, which the `toolshed-baked-opposite`
      capability serves and the `binaries-opposite` suite builds.
      Both postures are verified before each suite: `/api/meta` must match
      the resolved role and `/api/health/stats.servingLoop` must be present
      exactly on the ON arm. Deno-side test clients declare the posture from
      the environment (uniform, not mixed);
      the ON skip list — made EFFECTIVE by the fixer (it had been inert
      since Phase 4: `deno test --ignore` never applied to explicitly
      listed files) — held `phase-7` entries at this ruling's date:
      patterns ×3
      (`topics-navigation`, `cfc-group-chat-demo-two-browsers`,
      `lunch-poll-vote`), runner ×1 (`pattern-and-data-persistence`),
      runtime-client ×2 STEP entries (`tasks/server-execution-on-skips.
      ts`, each with its loud reason; verification-coverage OW30/OW32/
      OW33) *— since lifted arc-by-arc: the ON-skip registry is EMPTY
      across all four suites (#6528, the ruled-3b-close lift — the
      Coordination-state delta above), so gate (5)'s list-EMPTY half
      below is MET*. **The flip PR landed only after these ORDERED GATES,
      in this order:** (1) OW32 —
      the client-side scheduler-non-settling loop TRIAGED and fixed (the
      two two-browser gates green 5/5 fresh-store under the full ON
      posture) — *triaged 2026-08-16 (a client speculation
      retire-to-nothing loop on per-user derivations, cause = the
      identity-less space-root demand); the client ARRIVAL GATE landed
      with fan-out stage A (the symptom); the CAUSE FIXED by fan-out
      stage B (2026-08-17): the loop is gone at both gates — the
      two-browsers gate GREEN 3/3 fresh-store and UN-SKIPPED; the lunch
      gate boots, joins, and votes but is BIMODAL 1/2 on a served-vote
      no-op residual (its skip entry names it) — the "5/5" bar is met
      by the first gate and owed by the second*;
      (2) OW17 — the SpaceReplica per-instance re-keying (with
      OW29's space-root demanders + arrival re-runs; P2-F-sized) — *SPLIT
      by the fan-out design (owner-ruled 2026-08-16): STAGE A = the
      instance-keyed serving replica + wire + tx→replica seam + scheduler
      union/name-keyed indexes + S4 by full instance address — LANDED
      (`claude/server-exec-v2-fanout-a`); STAGE B = the fan-out run
      supply (identity on space-root demands, demanders resolver,
      known-scope ratchet + discovery/arrival re-arms, per-demander demand
      walk + wish-sidecar chain, output-scope attribution, B7, OW34's
      trust carriage) — LANDED (`claude/server-exec-v2-fanout-b`; OW17
      and OW29 CLOSED, OW32 CLOSED as a cause, OW34 CLOSED); STAGE C =
      closeout (the lunch gate's residual, the honest benchmark) — *RUN
      2026-08-17/18 as three sibling PRs off fan-out B plus two
      benchmarks and an attribution (the "Coordination state" block
      above; the closeout record): the lunch residual RE-CHARACTERIZED
      as served-handler double dispatch (#5969, skip STAYS; the
      invariant RULED 2026-08-18, its (α) purge owed to the design build
      — OW35); the tuning trio (#5991) restored COMPLETION (ON
      finishes every journey, `lease.lost` 0); latency remains
      design-class — the design pass RAN (report landed; its ruling
      set ACCEPTED 2026-08-18, the (d′) sentence in serving-loop.md
      §1); the design BUILD is under way — W0 RAN 2026-08-19 (PROCEED
      (d′)), W1/W2 launched (the "Coordination state" block above)*; (3)
      OW28 — compile-and-run as an outbox effect kind + stamped completion
      writeback — **CLOSED**. The durable child/result/pending journey and
      scoped lifecycle are covered through a real host. The independently
      scoped `OW28-*` follow-ups are recorded in the register;
      (4) the HONEST propagation benchmark (criterion below)
      once the two-user family works — *MEASURED TWICE (stage C, rows in
      the table below): NOT MET — first at the fan-out B tip (ON could
      not complete the two-user journeys), then at the trio tip (ON
      completes; chat cross-user p50 7.4–9.7 s vs OFF 0.22–0.24 s;
      note createToView 3.9–4.2 s vs 1.13–1.19 s); the owner's
      2026-08-18 measurement caveat re-frames the comparator — the next
      benchmark measures SERVER SETTLE TIME explicitly and the BAR is an
      owner ruling (OW38)*; (5) the ON skip list EMPTY and the
      deployed-topology binaries the presets flip
      (`background-piece-service`, the CLI, cf-harness, every
      `PiecesController`) exercised ON by a gate — the flip PR's own
      obligation (review finding 8: at the flip-ready landing nothing
      exercised them ON) — *DISCHARGED BY THE FLIP PR (2026-08-28, the
      four-topology dispositions in its register block and PR body:
      `deployed-topology-gate` job for the bg-piece-service binary and
      cf-harness's fabric session; the CLI lanes probed as `cf`'s gate
      via posture adoption; `PiecesController` hosts on the default
      package/pattern lanes)*;
      then (6) the flip PR, and the soak starts at ITS merge — **DONE:
      [#6535](https://github.com/commonfabric/labs/pull/6535) is MERGED;
      the default has since been a data-only toggle, each flip a dated
      delta in the coordination block above (whichever arm is not the
      default stays selectable explicitly).
      Its first board surfaced ONE owner-court STOP — RULED AND BUILT,
      no longer standing: the verb DECLARED-RESULT surface was absent
      under ON, because receipts went unwritten under the flag by
      events.md §4/N26's exactly-once subsumption, which replaced only
      that role and left the receipt's result-carriage
      (plainResultReceipts; `cf call`'s `.result`) with no substitute.
      The owner RULED it 2026-08-29 — "yes, Serving-side receipt/result
      write, as that is indeed what i said before" — and the PR's
      result-carriage commit (its fourth) builds it: the served handler
      run writes the receipt in its OWN transaction (same wave as the
      entry's `consequenced` mark) at the same cause-derived address the
      client-era write used, write-once by CAS with a lost CAS a loud
      no-op. The register's FLIP block item (5) carries the mechanism
      and its pins; the CLI piece-call lane's umbrella-create assert —
      the witness that was red — is GREEN (board 33239003881)**. OW31
      (the service-principal write-authority posture) was RULED
      2026-08-18 —
      the serving identity never writes users' home spaces; genesis
      under the space's own keys, owner := the acting user — and its
      build (register OW31's work order) was owed post-merge, BEFORE
      the flip: BUILT 2026-08-21 (the register's OW31 row).
- [ ] Retire the flag; OFF path removed; `EXPERIMENTAL_OPTIONS.md` entry
      closed out — **SPLIT OUT: the post-soak removal PR** (named here as
      the flip's follow-up; it also removes the OFF regression-guard suites of
      the test topology (the `*-opposite` suites, the `binaries-opposite` suite
      among them) and the `toolshed-baked-opposite` capability, while the
      `deployed-topology` suite STAYS: it gates the surviving default posture,
      not the OFF path).
- [ ] Archive this plan to `docs/history/plans/` per the lifecycle
      (close-out, after the soak and the removal PR).

Success criteria:

- [ ] The integration suites run ON-only and green. (NOT ticked — but no
      longer for the old reason, which was the six `phase-7` skip
      entries the explicit-ON lanes needed. The ON-skip registry has
      been EMPTY across all four suites since #6528, and the flip PR
      swaps the lane roles: the DEFAULT lanes ARE the ON arm and run the
      full suite carrying that empty list. What stays untrue is
      ON-ONLY — the `*-opposite` suites, the explicit-`false` OFF
      regression guard, are the soak's rollback lever and run beside them
      by design. They retire with the post-soak removal PR, which is when
      this box can be ticked.)
- [ ] Cross-user propagation beats the client-computed baseline on the
      byte-identical workloads (the §1 "faster, not tolerably slower"
      requirement). (NOT ticked — UNMEASURED: the measurement leg is
      BUILT — `CF_CHAT_MESSAGE_SERIES=N CF_CHAT_MESSAGE_DELAY_MS=ms` on
      `cfc-group-chat-demo-two-browsers` posts N messages from the first
      browser and times each send→other-browser-renders, printing
      median/quartiles/max + load; protocol: fresh store per arm,
      adjacent ON/OFF pairs, n ≥ 20 per arm, load recorded — but its
      HARNESS is red under the full ON posture at the unmodified Phase-6
      base AND at head — the two-browsers gate stalls at the first
      per-user write with 40–56 k client action runs on the CLIENT-side
      scheduler-non-settling loop (OW32; NOT evidenced as OW17 — the
      serving loop is quiet), so no honest ON browser number exists yet.
      The harness must not be tuned to pass; the criterion waits for the
      two-user family (OW32 → OW17+OW29). An HONEST PARTIAL number has a
      shape, not built (review finding 12): `sx2-scale.test.ts` already
      builds N `PiecesController` clients with a timed `settleWrite`; two
      controllers (distinct identities) on ONE space — A appends an event,
      B's replica sinks the served consequence — timed under explicit ON
      vs explicit OFF, fresh store per arm, n ≥ 20, gives a byte-identical
      cross-user propagation number for the Deno client posture today.)
      **Stage C (2026-08-17/18) — MEASURED, still NOT ticked.** The
      harness is no longer red under ON: after the tuning trio the
      two-browsers series COMPLETES (n=20, 2/2 fresh-store), so an honest
      ON browser number exists — and it is SLOWER: chat send→other-browser
      p50 7 397 / 9 734 ms vs OFF 220–242 ms (31–44×), every cross-user
      step 2.6–10 s vs 2–120 ms, note createToView 3.9–4.2 s vs
      1.13–1.19 s (rows below; the closeout's §4). Attributed to two
      design-class terms (the per-demander demand walk; the client's
      whole-sidecar intent watch), which the design pass owns. The
      owner's measurement caveat: the OFF client-local number is not
      necessarily the comparator (speculative client execution stays);
      the honest server metric is time-to-SETTLE on the server — the next
      benchmark measures it explicitly and the bar is an owner ruling.

**Phase-7 gates table (re-tensed 2026-08-16 by the fixer pass; the
independent review's re-runs at head `97cb7aa47` and the unmodified
Phase-6 base `c75f04f37`, plus the fixer's local runs on the fixed tree;
fresh store per run, private port offset, loaded box; the STAGE-C
benchmark / attribution / re-benchmark rows appended 2026-08-18 —
their protocol and full numbers are in the
[stage-C closeout](../history/plans/server-execution-v2/stage-c-closeout.md)
and the reports beside it):**

*Reading the posture column after the flip: every `DEFAULT` row records
the default AS OF THAT RUN — OFF, by the 2026-08-16 dark-landing ruling
— not the default today. The flip PR makes the DEFAULT lanes the ON
arm, so those gates re-run under ON on its own board rather than being
re-tensed in place here; the `explicit ON` rows are what the ON arm
exercised at the time.*

| gate | posture | result |
| --- | --- | --- |
| `sx2-serving-loop`, `sx2-speculation`, `sx2-events`, `sx2-effect-channel`, `sx2-scale` | explicit `EXPERIMENTAL_SERVER_EXECUTION=true` everywhere (the ON arm — the sx2 arm detection reads env-else-default) | see the PR's bar (fixer re-run, fresh store) |
| same five | DEFAULT at the run's date (unset = OFF by the dark-landing ruling; the flip makes DEFAULT the ON arm) | see the PR's bar (fixer re-run) |
| runner package integration (14) | DEFAULT at the run's date (OFF) | 14/14 GREEN |
| runner package integration | explicit ON, UNIFORM (the 4 tests that talk to the lane's toolshed declare ON; the 8 in-process-app harness tests are OFF by construction) | 13/14 GREEN + `pattern-and-data-persistence` RED → ON-skip-listed (OW33); the pre-fix "14/14 under ON" was a MIXED posture (OFF clients) |
| runtime-client package integration | DEFAULT at the run's date (OFF) | 45 steps GREEN |
| runtime-client package integration | explicit ON, UNIFORM (the worker declares ON) | 43 steps GREEN + 2 STEP entries ignored loudly (CT-1606 PerUser header render 3/3 red; single-navigateTo dispatch 1/3 red — OW33) |
| `counter` | full ON | 1 red / 3 green in the build's runs (OW30's controller write-destination race — intermittent); green in the review's run; server exhausts 2/5 waves with no client loop |
| `topics-navigation` | full ON | The initial `myName` failure is an execution record. Stream sibling validation is fixed (OW30), and the barriered capture lifts the Topics skip (OW33). OW60's missing client echo remains separate. |
| `cfc-group-chat-demo-two-browsers` (the Phase-2 gate + the benchmark harness) | full ON — HEAD 2/2 and the unmodified Phase-6 BASE 1/1 (review); **fan-out stage B: 3/3 fresh-store, ON-built binary (2026-08-17)** | Phase 7: RED (300 s stall; the OW32 client loop, 40–56 k action runs / 5 min). **Fan-out stage B: GREEN 3/3 (1m08s / 1m21s / 1m23s), every step in seconds; client action runs 401–586 per browser; zero non-settling; serving loop waves 48–58, derivedCommits = waves, watermarkLag ≤ 12; UN-SKIPPED** |
| lunch (`lunch-poll-vote`) | full ON — HEAD 2/2 (review); **fan-out stage B: 2 fresh-store runs on the final binary (2026-08-17)** | Phase 7: RED (the identity-less served `#profile` wish + the OW32 loop). **Fan-out stage B: BIMODAL 1/2 — run 4 GREEN 2m28s (login 1.6 s, runtimes idle 1.0 s, joins 12–640 ms, votes and merges in seconds); run 5 RED at "both browsers see 2 love it (merge)" — both vote events consequenced with no error, one vote's served `castVote` no-op'd (`nowTick` null in the actor's run); stays ON-skip-listed with that residual named** |
| the deployed-topology binaries the presets flip (`background-piece-service`, CLI, cf-harness, `PiecesController` hosts) | ON | NO gate exercised them ON at the flip-ready landing (review finding 8) — recorded as the flip PR's own obligation. **DISCHARGED by the flip PR (2026-08-28)**: bg-piece-service + cf-harness get the `deployed-topology-gate` job (the real binary starts/serves and asserts its posture log line; the fabric-session factory resolves ON by adoption and serves one piece flow — both red-first against forced-OFF), the CLI's gate is the probed `cli-integration-test` lanes (`cf` adopts the server's published posture), and `PiecesController` hosts ride the default package/pattern lanes (sx2-scale's controllers; the pieces-controller helper) |
| OFF-arm neutrality | full runner suite (OFF ambient) + memory + toolshed unit suites + explicit-OFF sx2 | see the PR's bar |
| **STAGE-C BENCHMARK 1** (2026-08-17, `59b5329ae` ≡ fan-out B runtime; built binaries, posture-verified, fresh store, OFF→ON→OFF, loads 3–9; [report](../history/plans/server-execution-v2/stage-c/stage-c-benchmark-report.md)) — chat two-browsers series n=20 @2 s | OFF ×3 / ON ×3 (+1 at `fadc2efb1b`) | OFF median **227 / 328 / 477 ms** (p95 498–1 069); ON **0 series** — lockdown stall 300 s (t1, smoke0) or lease churn from t≈0 (t2: `lease.lost` 33, load 3.9); per-step ON 3.0–7.2 s vs OFF 4–47 ms where ON reached the step |
| same benchmark — lunch two-user vote | OFF ×2 / ON ×1 | OFF ✓ 11 s, 16 s; ON **RED** at "both browsers see 2 love it (merge)" 300 s (option A propagates 7 873 ms vs 53/80; both cast green 22 943 ms vs 440/843) |
| same benchmark — note-create n=20 (actor-side) | OFF ×3 / ON ×2 | createToView p50 OFF **1 085 / 1 171 / 1 090 ms**, ON **8 927 / 5 841 ms** (rep 2 capped at 17/20 by 780 s), p95 23–26 s vs 1.3–1.5 s; per-note cost monotone 1.6 → 25 s; §4 ratio 1.7–2.8 (met); **verdict SLOWER / UNMEASURABLE; flip gate NOT MET** |
| **STAGE-C ATTRIBUTION** (2026-08-18, instrumented, `fb2292a24`; [report](../history/plans/server-execution-v2/stage-c/stage-c-attribution-report.md)) | ON, night vs day | two-browsers gate bimodal ~40 % stall on a quiet space, 5/12 night vs 0/7 day (masked by a configured LLM model's SummaryIndex churn); dominant terms: server per-demander demand walk (96 % of an event wave's settle; deadline 2.5–8.3 s late, no macrotask yield), client whole-sidecar intent sink + double CFC probe (65 % of a saturated worker); lease loop confirmed (renew gaps to 10 s / 15-s TTL); the chat "no-op" = the CLIENT arrival gate holding a correctly served + pushed value 48 s; double dispatch ≤1.2× chat/note, 1.15–1.67× lunch |
| **STAGE-C RE-BENCHMARK** (2026-08-18, trio tip `b54bf5215`, no LLM model, loads 2–5; [report](../history/plans/server-execution-v2/stage-c/stage-c-rebenchmark-report.md)) — chat series n=20 @2 s | OFF ×3 / ON ×2 | ON **COMPLETES 2/2** (272 s, 251 s walls): p50 **9 734 / 7 397 ms**, p95 14 020 / 13 805 vs OFF p50 **242 / 221 / 220 ms**, p95 400 / 288 / 367 (31–44×); steps: message propagation 2.6–3.0 s vs 6–17 ms, lockdown 3.3–4.1 s vs 3–21 ms, room 9.5–10.2 s vs 2–3 ms; `overlayArrivalSweeps` 85–95 per browser, `overlayLateEchoDrops` 0; ON per-post cost climbs 5 → 14 s across the series |
| same re-benchmark — lunch | OFF ×2 / ON ×2 | ON **GREEN 2/2** (43 s, 57 s); `events.appended 11 / processed 17` both runs (the (α) class, intact, did not break the merge); merge 3.7–6.3 s vs 35–42 ms |
| same re-benchmark — note-create n=20 | OFF ×3 / ON ×2 | ON series **2/2 complete** (214 s, 237 s): createToView p50 **4 154 / 3 879 ms** vs OFF **1 185 / 1 133 / 1 145** (3.4–3.7×), p95 6.6–10.5 s vs 1.24–1.34; per-note cost still monotone 1 → 13 s; `lease.lost` 0 in 6/6 ON runs; `processed == appended` chat/note; §4 ratio chat 2.05/2.14, lunch 2.11/2.15, note 3.07/3.20 — a hair over the ≤2/≤3 TRIGGER by the honest-deadline cycle-count mechanism (total commits 2.1–3.1× BELOW OFF; OW37); **verdict SLOWER (attributed); flip gate NOT MET; the design pass's baseline. Owner caveat: measure server settle time next (OW38)** |
| **STAGE-C W4 ACCEPTANCE** (2026-08-20, train tip code `44bb76b05` = fix tip + the sender-echo instrument; built binaries posture-probed per run, fresh store, OFF₁→ON→OFF₂ brackets + extra ON reps with trailing OFF, loads 1.4–4.8, `No default model available` per run; [report](../history/plans/server-execution-v2/stage-c/w4-acceptance-report.md), raw under `stage-c/w4-raw/`) — chat series n=20 @2 s | OFF ×3 / ON ×2 | **SERVER SETTLE (the acceptance metric): all-inputs coverage p50 18 / 15 ms** (value-only 19/16, n=39/38; growth-to-landing p50 487/314 ms, n=25/26; p95 229/214; event-append p50 15/11) — **sub-second bar PASS**; arrival median **520 / 421 ms** vs OFF 217/253/223 (trio tip: 7 397–9 734 — the several-second sends GONE); lockdown 3–4 ms, message 5 ms (were 2.6–4.1 s); `wavesBudgetExhausted` 79/33 over 191/168 waves (was 777/739); `settleAdvances` 53/54 quiescence-only; sender echo (NEW instrument) ON p50 264/166 ms vs OFF 108–114 — **not ms-class either arm, ON 1.5–2.4× OFF (bar 3 FAIL as worded; attributed to the client (e) term — Alice actionRuns 2 818/2 725 vs ~950 OFF)**; flickers 0 |
| same W4 — lunch (3 ON reps) | OFF ×3 / ON ×3 | **3/3 GREEN** at totals 3.8/4.0/4.3 s (OFF 3.0–3.1): joins **254/254/254 ms**, merge 396/331/305 ms (was 3.7–6.3 s), **every swatch wall 1 ms**; settle all-inputs p50 **17/20/17 ms**, growth p50 258–520 ms — **sub-second bar PASS**; events 11/12, 11/12, 11/11 with `lt1LeftoversPurged` 1,1,0 (the (α) machinery; the re-benchmark's pre-(α) 11/17 shape gone); **{1:16} multiplicity in all three stores**; flickers host 1/1/0 (nonzero = real, a FLOOR per the F4 bias note; ms-class — the owner's pre-judged-acceptable class); join echoes ON ≤ OFF (41–63 vs 63–88 ms), veto echo 2–8× OFF in 2/3 (max 181 ms) |
| same W4 — note-create n=20 | OFF ×3 / ON ×2 (+1 labeled instrumented pair) | createToView p50 ON **991 / 829 ms** — **BELOW OFF (1 193/1 100/1 178)** and **FLAT**: first→last-10 medians 797→1 194 / 779→1 174 vs OFF 376–495→1 204–1 253 (same plateau; the monotone 1→13 s witness GONE — ON max 2.1 s); per-note client `scheduler/run` flat 64–147 ms ON vs 40–112 OFF (instrumented pair); totals p50 ON 2 623–2 869 vs OFF 3 087–3 748; settle value-only p50 21/17 ms; `undemandedNarrowingRuns` 57/53 (the flag-5 shape, unchanged); both ON reps rc=1 on the PRE-EXISTING `splitDefinitions` console-gate error (re-benchmark precedent at `b54bf5215`; attributed, series complete and valid); **`lease.lost` 0 in 7/7 ON runs; NO `walkRuns` key in any run's stats; OFF witness HELD** (no `servingLoop` key OFF; lunch stores 398×3 byte-equal to the recorded shape; chat 608/612/612 the recorded family; note 971/989/971 vs 989×3 — one byte-equal, the −18 variant repeating); OW37 re-read: raw 1.97–2.98, **advance-subtracted 1.55–2.22** (chat c1 2.16 a hair over ≤2 at the high-load rep; note ≤3 effectful met; commits still 2.1–4.7× below OFF); **acceptance readout 6 of 7 bars PASS** (the sender-echo bar the one FAIL, attributed client-side); the confidence verdict is the coordinator's |
