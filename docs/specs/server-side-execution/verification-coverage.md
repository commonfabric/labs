# v2 verification: coverage register — the stopping criterion

**Verification instrument, NON-NORMATIVE** — the closing audit of
the spec-time verification arc. Every BINDING rule (MUST / NEVER /
FORBIDDEN / closed-set / RULED semantics) across the ten governing
docs was enumerated (2026-08-03, four mapping agents + adjudication)
and assigned to the instrument that checks it — or to an adjudicated
reason none does. The claim this register makes: **no binding rule
is unverified by accident.** When that claim stops holding (a new
rule lands without a row here), this file is stale and the next
mapping pass is due.

## Current status

The first-party default is OFF and the ON soak is paused. The
[`serverExecution` registry](../../development/EXPERIMENTAL_OPTIONS.md#serverexecution)
owns the current default and flip records. A renewed ON rollout must satisfy
the plan's ordered gates. OW28 tracks served compilation and its scoped child
execution coverage; implementing that path does not discharge the other gates.

The status corrections in this register are bounded to the rows below:

| Row | Current disposition |
| --- | --- |
| OW18 / OW45 source freshness | Tenure activation ensures root existence; explicit opens follow source, including served wish-sidecar opens. |
| OW28 | Closed: accepted compile effects, child execution, restart, supersession, and independently reactive user/session program selection have direct coverage. |
| OW28-createRef | Closed: the compile cache snapshots program content, separates compilation with and without a space, and persists shared compiles into each requested space when CFC is enforced. |
| OW28-supersession-family / OW28-instance-family | Partial: shared fetch, `fetchProgram`, and direct LLM user/session isolation are covered. Caller-specific lifecycle, initialization, and remaining provider/tool read obligations are detailed below. |
| OW30 | Stream sibling validation is fixed; the non-Stream counter/container observation remains unresolved. |
| OW31 residual (vii) | Read-triggered remount is implemented; automatic replay of the entire watch set remains separate. |
| OW55 | Open: serving pattern-source trust, with root creation and wish sidecars among its consumers. |
| OW56 finding 2 | Closed: source following has one owner, the opener. ON upload and instantiate run on the serving runtime; source updates, other client creation paths, and compiled-byte trust remain separate OW56 work. |
| OW58 | Closed: resolved-error notice commits release the drain guard. |
| OW60 | Open: unresolved flag-ON client echoes are still skipped. |
| OW64 | Closed: a client's read ceiling rides its signed `session.open` descriptor, the SpaceServer stamps it onto every run served as that session, and the served `sqliteQuery` reads under it; pinned end to end. |

The [coverage status audit](../../history/plans/server-execution-v2/optimize/coverage-status-audit-2026-09-09.md)
records the investigation's inspected head, provenance, probes, and limits.
It is a historical record; the row's current implementation and tests govern
its disposition. In particular, runtime-supplied sidecars are explicitly opened
by the serving wish builtin; the audit's blanket statement that serving tenures
open no pieces is too broad. The dated execution records below do not describe
the current deployment posture or establish that every owed row has been
re-audited.

## 1. The map

300 binding rules. Instruments: the scenario traces (T1–T12), the
field-provenance chains, the executable model (C1–C10 property
families), the Phase 1 dry-run, and the doc-review panels
(weak — counted only where nothing else applies).

| doc | rules | instrument-covered | impl-gate | deferral | derivable | owed |
| --- | --- | --- | --- | --- | --- | --- |
| README | 31 | 17 | 9 | 1 | 2 | 2* |
| protocol | 63 | 47 | 8 | 3 | 4 | 1* |
| events | 34 | 25 | 4 | 2 | 2 | 1 |
| scopes | 25 | 17 | 3 | 1 | 2 | 2 |
| builtins | 15 | 6 | 3 | 1 | 4 | 1 |
| serving-loop | 79 | 46 | 21 | 1 | 5 | 6 |
| key-vocabulary | 9 | 5 | 3 | 0 | 0 | 1 |
| speculation | 16 | 11 | 2 | 0 | 1 | 2 |
| testing | 14 | 4 | 10 | 0 | 0 | 0 |
| runtime-mapping | 17 | 5 | 3 | 1 | 5 | 3 |

(*push-priority appears in two docs — counted once in §3. The
scheduler-tell classification rule likewise appears in two docs —
protocol §1 primary, speculation §2 cross-reference — and is counted
once, under protocol.)

**Adjudication notes on the three big buckets:**

- **Implementation-gate (~56 rules)** is not a hole — it is the
  HANDOFF. These rules bind code and CI, not prose: the stage-C
  deletion lists and golden regeneration, the amplification budget,
  the harness MUSTs (testing.md §1 is gates about gates), the
  transformer lints, no-static-analysis, flag registration, the §8
  grep tripwires. Their verification home is the stage PRs and the
  `sx2-` surface (testing.md §5); each stage's pre-flight should
  pull its rows from this register.
- **Deferral (~9)**: explicitly deferred semantics (streaming,
  quota attribution, session-data GC, basis-row retention bound,
  resume-republish end state). Deferrals are answers.
- **Derivable (~24)**: follows from a covered rule; each mapping
  run named the covering cell. Spot-checked in adjudication.

## 2. Verified-by-instrument highlights (what "covered" means)

The identity/commit core is now checked three ways deep: envelope vs
annotation identity (traces T1–T5, provenance clusters A–C, model
C1–C3), the lease including DR1's fence and its residue (C6/C7),
mid-wave conflict classes and exactly-once (C8–C10, T9), crash
recovery and the FP1 closure (T10, C2-FP1), push filtering and
settledness (T1/T4/T6, C4), the effect channel with LT8's window
(T2, C1-LT8), cross-space carriage end to end (T4, cluster B,
C2/C2-dedupe).

Delta 2026-08-04 — the consequence-flush deadline (serving-loop
§3): both new binding sentences are covered without a new
instrument. The flush SEMANTICS (commit-early, W pinned,
continuation completes, exactly-once across the boundary) are
trigger-agnostic and C10-verified — the clockless model's count
budget is the deadline's proxy — and the sealing-order MUST is the
same property family (C1/C10's event-first processing). The
`T_flush` VALUE is a Phase 6 implementation gate alongside the
other budgets. The recorded write-class fallback is not built —
no instrument owed unless it is ever adopted.

Delta 2026-08-04/05 — stage D's carriage sentences and the
2026-08-05 ruling pair (protocol 53 → 58):

- §7's stored-representation sentences (the annotation pair's
  carriage is server-internal admission input; its stored form is a
  per-op-indexed sidecar on the commit row — recorded, never wire,
  never pushed; admission consumes only the addressing half): +2
  rules, impl-gate, verification home = the stage-D PR's engine
  tests (`packages/memory/test/v2-wave-commit.test.ts` pins the
  stored pair, the addressing-keyed rows, the
  space-scoped-annotation refusal, and the non-derived refusal).
- §1's `system`-row widening (RULED 2026-08-05): the
  new-direct-write-caller-is-a-spec-decision sentence is
  panel-covered (+1 instrument-covered — a prose-discipline rule,
  the same instrument family as §7's "spec edit here first"); the
  accepted no-user-attribution posture with its named blob-write
  hardening is a deferral (+1) — deferrals are answers.
- §2's derived-envelope defense-in-depth sentence (RULED
  2026-08-05): +1 rule, impl-gate, assigned to Phase 1 stage F —
  the plan's stage F bullet carries the task. The MODEL side needs
  no extension: `admitDerived` already compares the envelope
  principal to `holderId`; the impl-side operand mapping is the
  stage F design question.

The same review recorded a model/impl asymmetry in §3d's conflict
handling — the impl's three-way drop/rebase/requeue disposition is
pinned by impl tests only — now owed as OW9 below.

Delta 2026-08-05 — the stage-D review's Q1/Q2/Q4 ruling batch
(serving-loop 71 → 76):

- Q1 (§3d recompute-by-dependency, RULED 2026-08-05): the weakened
  recompute sentence is a CHANGED rule, model-covered as before —
  C8a's recompute flows through the model derivation's own read of
  the raced doc (its fire predicate consults the output's current
  value), and the model has no drop-triggered re-arm mechanism, so
  it verifies exactly the ruled semantics. Two NEW rules: the drop
  re-arms nothing / no recompute-owed mark exists (+1,
  instrument-covered, the same C8a family); a survivor whose writes
  were dropped per-doc still lands its basis rows (+1, impl-gate —
  the mixed-disposition test in
  `packages/runner/test/executor-wave.test.ts` asserts the
  dropped-write survivor's rows land).
- Q2 (per-run write classification, RULED 2026-08-05): +1 rule,
  instrument-covered — the model's C8 contributions carry writes per
  producing run, and the impl's per-(contribution,doc) disposition
  test pins one handler write rebasing while a derivation's write to
  the same doc drops.
- Q4 (unstamped seals refused, RULED 2026-08-05): +1 rule,
  impl-gate — the refusal throw at the seal destination is pinned
  red-first in `packages/runner/test/executor-wave.test.ts`; the
  stage-F half (naming the sanctioned internal stamp kinds when the
  seal destination is installed) is +1 impl-gate assigned to Phase 1
  stage F, alongside §2's derived-envelope check.

Delta 2026-08-05 (follow-up) — Q1-ruling propagation (serving-loop
76 → 77; no other rows move):

- The retracted unconditional "next wave recomputes" sentence
  survived outside §3d — protocol §1 (threat model) and §2
  (admission note), README §1, runtime-mapping N15/N17 — and two
  trace cells (T9.Q1, T12.Q4) had drifted. All now state the
  dependency-only rule and cite serving-loop §3d (RULED
  2026-08-05). CHANGED sentences only: every location keeps its
  existing row; no counts move for these.
- Completion-path clarification (adjudicated 2026-08-05, vetoable):
  the completion commit (serving-loop §4) never passes §3d's
  sealing, but its identity annotations are sourced from outbox
  carriage captured at the ORIGINAL run's seal — necessarily
  stamped under Q4's refusal — so completion commits inherit
  stamped provenance transitively and no unstamped derived path
  exists. +1 rule, DERIVABLE — covering cells: the Q4 refusal row
  (impl-gate, above) and §4's identity-carriage miss rule (FP6,
  RULED 2026-08-03).

Delta 2026-08-05 — the name-keyed boundary surface
(key-vocabulary §5, stage E's review batch): three new rules
(key-vocabulary 6 → 9). The §4 tripwire extension (a new
name-keyed identity key, or a change to a listed boundary site,
must update §5) is an implementation gate of the same grep-tripwire
class as the rest of §4. The coverage-memo enablement gate
(unscoped-link coverage stays off until the html reconciler's
`get({ traverseCells: true })` value consumption is resolved —
key-vocabulary §5) is an implementation gate on the PR that flips
it. The schema-memo single-identity invariant (cross-identity memo
sharing FORBIDDEN) is OWED an explicit guard — OW10.

Delta 2026-08-05 — stage F lands (the serving loop; this PR):

- §2's derived-envelope defense-in-depth row: impl-gate → COVERED.
  The operand mapping landed (`resolveCommitSessionKey(sessionId,
  principal) == holder` — the sink commits under the holder's own
  service session) with negative tests
  (`packages/memory/test/v2-wave-commit.test.ts`: a user session and
  a non-holder internal session naming the right holder are both
  refused; the holder's own session admits). protocol.md §2 records
  the landed mapping — a CHANGED sentence, same row.
- §3d's stage-F stamp-kind naming duty: impl-gate → COVERED. The
  sanctioned internal kind is named (`bookkeeping`, serving-loop.md
  §3d — a NEW binding sentence, this row is its coverage), stamped
  at the three scheduler/runner choke points, with BOTH conflict
  dispositions pinned in
  `packages/runner/test/executor-wave.test.ts`: a bookkeeping PATCH
  racing a disjoint authored patch REBASES and commits (the live
  rebase arm — the loop's steady-state watermark advance is a
  key-path patch), and a semantic conflict (whole-doc authored
  intrusion) DROPS the contribution whole with nothing requeued.
  The drop arm's recorded acceptance, stated truthfully
  (2026-08-05): the wave's commit metadata (`derivedThrough`) and
  the loop's in-memory W still advance when the DOC write drops —
  the doc lags until the next INPUT-driven advance (a quiet space
  stays lagged), which is conservative for clients because
  `waitForSettled` reads the doc. Accepted under protocol §1's
  authored-intrusion threat model; the code comments at the
  bookkeeping write and the WaveRunKind doc state the same.
- §2's read row (LD5): the admission half is now impl-covered —
  `packages/memory/test/v2-explicit-read.test.ts` pins
  holder-admitted / non-holder-refused / off-flag-refused on both
  the query and watch paths. The trace/model coverage stands
  unchanged. One recorded Phase-1 acceptance rides this row
  (2026-08-05): the landed operand check compares the
  SERVICE-IDENTITY component of the live holder, not the full
  per-process DR1 holder, so a second process sharing the service
  DID would pass on the first process's lease row — no instances
  exist co-hosted in Phase 1 (one serving process per memory
  server); the per-process sharpening lands with Phase 5's
  cross-engine lease lookup design, alongside FP2's widening.
- serving-loop §2's renew cadence + stop-committing MUST: the
  serving loop drives them for real; lease-loss and idle-park pinned
  end to end in `packages/runner/test/executor-serving-loop.test.ts`
  (C6/C7's impl witnesses at the loop level) — including the
  renew-blip arm (2026-08-05): when the reacquire SUCCEEDS but a
  wave sealed under the lapsed tenure aborts at its commit step, the
  space PARKS rather than continuing (a continued loop would mint a
  watermark-only advance over the withdrawn derivations;
  re-activation's fresh-runtime recompute-on-demand is the only
  post-abort arm), pinned with a deterministic mid-wave interleave.
- serving-loop §6 step 2's re-mark: PARTIAL by design in Phase 1 —
  activation runs `selectStaleBasisInstances` and surfaces the stale
  set (counted, logged), and recovery CORRECTNESS rides
  recompute-on-demand over a fresh runtime (sound: an absent warm
  graph means demanded pulls recompute regardless). The
  skip-still-current warm-start VALUE of the index materializes when
  a later stage carries a materialized graph across activation;
  until then the scan is the recovery input, not yet an optimizer.
- protocol §4's watermark: impl-gate rows land — the doc + metadata
  carriage (`derived_through`), same-transaction watermark write,
  W-advance-at-quiescence-only, and `waitForSettled` — pinned in the
  serving-loop tests.
- scopes §2's eager via-user hop: impl-gate → PARTIALLY COVERED
  (`packages/runner/test/eager-via-user-hop.test.ts`: both
  `data-updating.ts` shapes — the declared-scope narrowing and the
  eager omitted-property redirect — under the flag, one hop pinned
  in the OFF arm). The DISCOVERED-narrowing site
  (`pattern-binding.ts`'s `narrowestReadScope` branch) carries the
  same gated chain but has no direct test yet — owed as OW12 below.
- key-vocabulary §5's boundary re-keys (M4-coupled + serving-identity
  lists): dispositions moved to RE-KEYED in the same change, per §4's
  tripwire; the server-side partition equivalence is witnessed by the
  full memory suite (wire frames byte-identical via `toWireUpsert`)
  and the client-side by the full runner suite. TWO RECORDED
  OFF-arm acceptances ride this row, both RATIFIED (owner,
  2026-08-05; testing §2's byte-identity gate now carries the
  matching "up to the recorded key-vocabulary §5 acceptances"
  clause):
  - the `fromSeq` resume-marker delta — the M4 re-key removes the
    cross-session SPURIOUS WAKE the name-keyed form produced
    (principal A's scoped commit no longer re-evaluates principal
    B's session), so under multi-principal scoped workloads a later
    frame's `fromSeq` can differ from the old arm's. No client
    consumes server-frame `fromSeq` (an unconsumed integer); the
    observable residue is a marker-latency shift of roughly the
    refresh cadence (~5 ms) in the staged-ack race window, and the
    removed wake is the M4 defect itself.
  - the shaper-bucket merge — the `${scope}:${id}` normalization
    merges the two buckets that previously DISAGREED about one
    piece's identity (the `pieceId` constructions in
    `Runner.#schedulerObservationIdentity()` and
    `Runner.#instantiateJavaScriptHandlerNode()`,
    `packages/runner/src/runner.ts`; key-vocabulary §5's parenthetical
    carries the same ratification stamp).
- stage D's documented bounds: the delegated-admission bound is
  DISCHARGED for its LANDED half only — carriage presence +
  completeness (authored class, non-empty actor + grant, the
  sessionless session-scope refusal) and carried-identity keying,
  pinned in `executor-wave.test.ts` and
  `packages/memory/test/v2-wave-commit.test.ts` — while grant
  RESOLUTION against the target doc/stream remains OWED hardening
  (OW13 below; protocol §2's delegated row carries the same
  Phase-1-bound parenthetical). The read-only-read-set bound is
  DISCHARGED with tests (read-only reads folding into withdrawals).
  The sqlite bound stays stage G.

Delta 2026-08-05 — the stage-F independent review's ruling batch
(three flags RULED by the owner; changed sentences and recorded
acceptances only — no rule counts move):

- Flag 1 (the `inputSynced` input-barrier residual — a frame parked
  on the loop's own sealed commit vs foreign novelty): ACCEPTED for
  Phase 1, revisit trigger Phase 2. The two named revisit items —
  the parked-on-own-seal distinction (or excluding unapplied frames'
  seqs from `batchHead`) and source-check verification — are carried in
  the plan's Phase 2 section. The source-check obligation is superseded by
  explicit-open source following (OW18); it is not an owed tenure-wide probe.
- Flag 2 (watermark-only derived commits): CONFIRMED — protocol §4's
  "never its own commit" now carries the ruled parenthetical: an
  advance-only wave commits the advance as the batch's ONE derived
  commit; the phrase bans bookkeeping-as-its-own-commit (the
  push-priority rule), not advance-only waves. CHANGED sentence,
  same row.
- Flag 3 (OFF-arm byte-identity deltas): RATIFIED — testing §2's
  gate sentence now reads byte-identical "up to the recorded
  key-vocabulary §5 acceptances", and the recorded-acceptance row
  above names both deltas.

Delta 2026-08-06 — stage G lands (effect serving + the outbox; this
PR):

- serving-loop §4's memoization contract: impl-gate → COVERED. The
  hit rule, in-flight dedupe, error-shaped results, and the
  no-re-fire-on-recovery property are pinned end to end in
  `packages/runner/test/executor-serving-loop.test.ts` (the effectful
  node journey: one external call per key across park/re-activate;
  the failure leg retries only on input change) and
  `packages/runner/test/executor-outbox.test.ts` (dedupe + counters).
  The builtins' own memo checks now REPORT hits (`effectMemoObserver`
  — fetch*, generate*, sqliteQuery; fetchProgram and llmDialog count
  misses via the outbox and report no hit events yet, recorded in
  stats.ts).
- serving-loop §4's completion-commit clarification (2026-08-05,
  was DERIVABLE): now impl-covered — the completion commits as its
  OWN derived-class commit (never through §3d's sealing), its
  annotations sourced from the outbox carriage captured at the
  original run's seal, pinned with a scoped write + acting identity
  in `executor-serving-loop.test.ts` (T7.Q4's impl witness). Stated
  for Phase 1: T7.Q4's carriage-sourced `scope_key` is STRUCTURAL —
  the E2E pins the cardinality-1 fallback (carriage identity ==
  wave identity), and the per-run demanded identity that makes the
  carriage carry a DIFFERENT key arrives with Phase 2's stamper.
- serving-loop §5's FP1 rows: impl-gate → COVERED. Durable rows
  land INSIDE the wave's engine transaction (surviving contributions
  only — a dependency-dropped contribution's appends are excluded, a
  per-doc-superseded survivor's still ride, matching §3d's
  drop-re-arms-nothing ruling), delivery admits at the target under
  the delegated row with `firedAt` from the CARRIED actor (LT5's
  service envelope), the row deletes on delivery-ack
  (admit-before-delete), a re-sent duplicate dedupes at the eventId
  horizon, and an LT4 deterministic rejection deletes without
  retrying (`executor-outbox.test.ts`; the model's C2/FP1 closure
  stays the oracle).
- serving-loop §1 plane (c): CHANGED sentence — the direct-engine
  plane now also carries the outbox's delivery-acked row retirement
  (the rows are WRITTEN on plane (a) inside the wave transaction;
  only the delete rides plane (c)). This row is its coverage; the
  retirement behavior is pinned by the delivery tests above.
- serving-loop §7's memo/outbox counters: structurally-zero note
  retired — the counters are live and asserted by the stage-G tests
  (stats.ts documents the exact semantics, including that
  `outbox.failed` counts INFRASTRUCTURE failures while effect-level
  failures commit error-shaped results per §4).
- stage D's last documented bound (sqlite ops in wave batches):
  DISCHARGED for HOME batches — the accumulator resolves each folded
  op's db scope against its RUN's identity (M1), the sink attaches
  through the memory server's `attachWaveCommitSqliteDbs` (same
  validations as the transact path) and applies atomically inside
  the wave transaction; hook-less sinks, key-less ops, and FOREIGN
  batches with sqlite ops are refused loudly (`executor-outbox.
  test.ts`). Foreign-batch sqlite lands with Phase 5's cross-space
  design.
- OW7 → LANDED as trace T14 (scenario-traces §3/§4) plus the
  serving-loop failure-leg test above; the owed entry below is
  flipped.
- The stage-G adversarial review's fix batch (2026-08-06), coverage
  where it added binding behavior: (i) the deferred-flush window the
  serving posture opens — a stale action re-run re-admitting a key
  whose first effect already completed — is closed by TWO mechanisms
  in series, stated truthfully after the independent review's
  captured double-fire showed the claim guard alone does NOT close
  it: `tryClaimMutex`'s completed-request guard (skip the claim when
  the stored hash matches and a result/error is READABLE —
  unit-pinned in `fetch-claim-takeover.test.ts`) plus the
  READABILITY-GATED in-flight retirement (serving-loop §5's ruled
  idempotence sentence): the outbox holds the key until every
  completion commit's writes are applied to the serving replica
  (`ISpaceReplica.whenApplied` over CT-1927's parked accepts), so
  the stale re-admit that used to arrive inside the ~15 ms
  absorption window — reading a view without the completion, where
  the guard structurally passes — now DEDUPES. Pinned by the
  `whenApplied` unit (`memory-v2-stacked-commit.test.ts`), the
  deterministic hold-absorption/re-admit/dedupe interleave
  (`executor-outbox.test.ts`), and the E2E's exactly-once
  external-call pins under repeated load runs; (ii) the sqliteQuery
  memo decision distinguishes a SETTLED result (a hit) from a bare
  claim marker — a pending claim with no local in-flight read re-issues
  in serving and direct execution, while speculative execution continues
  to dedupe the effect it cannot enact (`sqliteQueryMemoDecision`, unit- and
  multi-runtime-pinned), restoring §6 step 3's re-miss premise for the one
  builtin whose key commits ahead of its result; (iii) userless/grantless outbound appends
  are refused at the SOURCE (`enqueueOutboundAppend`), fail-closed
  ahead of the delegated floor that would deterministically destroy
  them at delivery — the Phase-3 floor carve-out for sessionless
  space-scope emissions is now SHAPE-RULED (2026-08-05, protocol §2;
  implementation is Phase 3's, owed below); (iv) admit-before-delete
  is now pinned by a transport-failure test (the row survives a
  non-deterministic delivery failure; the next drain delivers
  exactly one entry).

Delta 2026-08-06 — the stage-G INDEPENDENT review's fix batch, plus
the owner's 2026-08-05 ruling batch (five rulings recorded; changed
sentences, one recorded acceptance, three owed entries):

- serving-loop §5's effect-idempotence sentence: AMENDED (RULED
  2026-08-05). The old "a duplicate completion writes an identical
  key and is a CAS no-op" described a mechanism the completion path
  does not have; the section now states the true one — the
  builtins' request-hash guards plus the all-no-op short-circuit,
  completion commits deliberately at `basisSeq = NOW` (no per-doc
  CAS), and the readability-gated in-flight retirement closing the
  absorption-window race. CHANGED sentence; its coverage is the
  fix-batch row above.
- serving-loop §3d's sanctioned-stamp-kinds sentence: the
  "acked-effect retirement when stage G lands it" clause was a
  MIS-ATTRIBUTION (reviewer-verified): the write it describes is
  Phase 4's client-effect retirement (protocol §5 — a
  bookkeeping-stamped wave write among protocol §1's
  service-identity writes). §3d now attributes it to Phase 4 and
  notes stage G's own retirement is plane (c)'s unstamped
  engine-table ROW delete (§1 already said so). CHANGED sentence,
  same rows.
- ONE RECORDED OFF-arm acceptance rides stage G (RATIFIED
  2026-08-05; testing §2's gate clause widened the same day to name
  this register's recorded-acceptance rows alongside
  key-vocabulary §5's): `tryClaimMutex`'s completed-request guard
  changes the OFF arm's cross-writer race corner. Old behavior:
  a claimant racing another writer's completed result for the SAME
  inputs claimed anyway, transiently cleared result/error, and
  re-fetched (a redundant refetch plus a visible clearing blip).
  New behavior: the claim is skipped — the stored value stands.
  Post-B-1 shape, stated precisely: the guard reads the claimant's
  view, so it engages exactly when the completed writeback is
  READABLE there; the serving posture's unreadable-window case is
  closed by the retirement gate (above), not by this guard, and
  client-side the guard only removes the redundant-refetch corner
  (inline flushing already made in-process ordering safe). (A SECOND
  recorded acceptance — Phase 2's R4 written-subtree narrowing — is
  recorded in the Phase-2 independent-review delta below.)
- FIVE MORE recorded rows ride stage G's 2026-08-12 review round
  (ALL RATIFIED by the owner 2026-08-13, alongside the §4
  per-(key, result target) amendment):
  (1) per-target idempotency keys make the OFF arm's tx-level
  outbox dedupe (`outboxIdempotencyKeys`) finer — two distinct
  nodes enqueueing byte-identical inputs in ONE transaction now
  BOTH flush where the second was silently dropped (reachable
  only when one tx runs multiple actions; a bug-fix delta);
  (2) OFF-arm fetch writebacks whose commit fails terminally now
  REJECT the tracked-work promise (previously silent), and the
  error-shaped-result conversion applies OFF-arm too;
  (3) tryClaimMutex marker placement is OFF-inert (a WeakMap
  write plus a destination-gated authoritative call) — listed
  for completeness;
  (4) the authoritative-write completion path (container
  assertions + whole-doc set/delete) is gated on the serving
  posture — OFF byte-identical — with ONE ratified ON-arm
  widening: a serving completion's whole-doc write of a builtin
  `internal` doc can stomp a concurrent CLIENT replica's mutex
  claim fields (requestId/lastActivity); it self-heals via the
  5s staleness bound and is strictly better than the wedged
  completion it replaces;
  (5) llm hit-observer gating shifts OFF-arm counters only
  (settled re-evaluations now count as hits; no behavioral
  consumer today).
- FP6's register row (field-provenance.md): the label basis is
  STRUCTURAL, not frozen (RULED 2026-08-05) — tightening mid-flight
  yields the stricter label, loosening matches the OFF arm's
  write-time derivation, a frozen snapshot would write stale labels
  over a re-labeled basis. Recorded on the row; no mechanism moved.
- protocol §2: the Phase-3 floor carve-out for sessionless
  space-scope emissions is SHAPE-RULED (2026-08-05) and recorded in
  the delegated-row region — absent acting principal admitted iff
  declared sessionless-space-scope (`firedAt = { session: "server"
  }`, no user key), grant presence still mandatory. events §2 and
  the model already carry the semantics; implementation is owed
  (Phase 3, below).
- builtins §2's fetch row: the "migrate requestHash onto the result
  doc" prescription now carries its deferral note (the
  internal-cell hash is functionally equivalent committed state per
  T10.Q1; the migration is an OFF-arm cell-shape change waiting for
  an OFF-arm ruling batch that wants it — plausibly never).
  CHANGED sentence, same row.
- stats.ts's memo.hits note now states the hit unit (a
  re-evaluation touching a settled effect node, NOT a suppressed
  fire) so Phase 2's gate arithmetic cannot read hits as "avoided
  calls". Code-comment clarification; no counter moved.
- FP1 fold completeness (the review's M-A): appends and consequence
  coverage now fold for EVERY surviving contribution — the
  foreign-only-seal survivor and the zero-seal emitter (minted as a
  zero-write contribution, the model's committed-`writes: []`
  shape) both land their appends and `consequenceOf`; both shapes
  red-first pinned in `executor-outbox.test.ts`.
- The SpaceServer's recovery seams (the review's M-B): the §6-step-5
  activation re-send and the owed post-wave drain are now pinned at
  the SpaceServer level (`executor-space-server.test.ts` — deleting
  the activation re-send call turns the test red), and a
  transport-failed ACTIVATION re-send now arms the owed re-drain so
  surviving rows ride the next wave instead of waiting for the next
  appends-carrying wave or re-activation.

Delta 2026-08-07 — the completion-visibility wedge fix batch (F1a +
F2, mechanism-triaged from the serving-loop soak's ~11%-red wedge
population):

- Retirement LIVENESS (F1a): sealed commits — waves and effect
  completions alike — now CONFIRM on the serving replica at verdict
  time (`settleSealedCommit` → `confirmPending`) instead of taking
  the parkable path. Parking guards a REMOTE mirror against
  promoting over missing foreign novelty, but engine-plane commits
  bypass the transact path — the only place catch-up marker
  obligations are staged — so a parked sealed accept could NEVER
  promote: `whenApplied` waiters never resolved, every served
  effect leaked one permanently-in-flight outbox entry, and any
  A→B→A input cycle starved deduping against the dead entry.
  CT-1927 parking for pushed (socket) commits is untouched. The
  earlier fix-batch row's "whenApplied over CT-1927's parked
  accepts" mechanism reads accordingly: readability is now
  immediate for completions and the retirement barrier is the BELT
  over the structural guarantee (its hold/re-admit/dedupe pins are
  unchanged and still green). Red-first pinned by the deterministic
  A→B→A starvation test and the N-effects in-flight-baseline test
  (`executor-serving-loop.test.ts`).
- Completion writebacks are AUTHORITATIVE (F2): a completion-marked
  transaction's writes commit even where the replica's optimistic
  view calls them no-ops — that view can layer a DOOMED sealed
  overlay (a derivation write a later wave-commit supersede-drops,
  §3d), and eliding the completion's `inputHash`/`pending` writes
  against it durably landed `result present + inputHash stale`,
  which the next run's memo guard read as "inputs changed" and
  destroyed the just-served value (the observed ~30 ms
  arrive-then-wipe). Mechanism: `markEffectCompletion` flips the
  transaction into authoritative-writes mode
  (`markAuthoritativeWrites`, gated on the serving posture's seal
  destination so the OFF arm stays byte-identical), which is
  honored at every elision layer — the value-diff leaf
  (`normalizeAndDiff`), the transaction write paths, the doc-level
  no-op skip and the initial-vs-current patch diff
  (`getNativeCommit`/`buildPatchOperation`, which emits forced
  full-cover `replace` asserts). All effectful builtins already
  route their writebacks through `markEffectCompletion`
  (fetch/fetch-program/llm/llm-dialog/sqlite), so the audit
  reduces to that single seam. Ordinary transactions keep the
  elision everywhere. Red-first pinned by the torn-hash
  supersede-drop interleave (`executor-wave.test.ts`).
- The parked-overlay stale-read machine (the triage's independent
  observation — a never-promoted sealed overlay replaying over
  advancing confirmed state until a later drop flips visible
  state): structurally unreachable post-F1a — sealed verdicts
  either confirm immediately or withdraw-and-roll-back, and
  `settleAccept`'s parking branch is reachable only from the
  socket-transact paths, where CT-1927's marker machinery
  guarantees eventual promotion. No test forced; recorded here.

Delta 2026-08-07 — Phase 2 lands (flag ON: the server derives, the
client does not; this PR):

- speculation §1/§2/§4/§6's impl-gated rules: the implementation they
  gated on LANDED, with the pins cited below. Stated precisely
  (r3739139527 — the earlier "impl-gate rows → COVERED" overstated
  against the §1 map, whose speculation row still counts them
  impl-gate): this delta records the landing evidence; the map's
  COLUMN moves (impl-gate → instrument-covered where the cited pins
  bind the rule text) belong to the next full mapping pass, which §4's
  standing rule already schedules. The overlay is
  the runtime's DEFAULT seal destination under the flag for every
  non-serving runtime (`packages/runner/src/speculation/
  overlay-destination.ts`): stamped derivation-kind runs redirect into
  the replica's pending layer (`sealNative` speculative — outside the
  `synced()` barrier), handler runs kept committing authored (F10 —
  Phase 2's interim posture; ENDED with Phase 3's events-down, which
  INVERTED these pins: a handler fire commits only the event and the
  handler run diverts — the same suite now asserts that posture),
  unstamped/binding writes untouched, egress effect kinds dropped
  with `navigateTo` enacting (the egress rule), `compile-and-run`
  observing committed results on clients while the serving runtime owns
  compilation and child setup (OW28; `executor-compile-and-run.test.ts`
  and `builtins/compile-and-run-served.test.ts`) —
  retirement on watermark coverage of the entry's read basis + acked
  origins via success-shaped `superseded` withdrawals that cascade
  nothing. Pinned in
  `packages/runner/test/speculation-overlay.test.ts` (echo with zero
  client commits; the store-attribution query — zero derived-class
  commits from any client session; watermark-coverage retirement;
  F10; egress suppression) and live in
  `packages/patterns/integration/sx2-speculation.test.ts` — scoped
  honestly (the review's m6): the acked-origins component (§4 step
  3's KEEP half — an unacked origin holds the echo) is NOT directly
  pinned by these suites; it rides OW4's scoping below, with direct
  pins owed alongside the Phase-3 offline machinery that builds the
  origin-queue fixtures they need.
- The Phase-2 revisit (a) — the settle input barrier: RESOLVED by the
  plan's sanctioned exclusion alternative.
  `ISpaceReplica.unappliedForeignSeqFloor` reports inbound foreign
  seqs still shadowed by parked own writes; the SpaceServer clamps
  its W advance below them (`watermarkClamped` counter, serving-loop
  §7 — edited with this delta) and the shadow-flip notification in
  `confirmPending` (flag ON) registers the dirtiness the moment the
  overlay leaves, so the next wave derives over the foreign value
  before W claims it. Two exemptions the serving loop's own frames
  forced, both pinned: an own-echo upsert (its seq IS a pending
  accept's ack seq, with the verdict-race repair) and the seq-0
  absent-doc marker never shadow. Pinned in
  `packages/runner/test/memory-v2-stacked-commit.test.ts` (flag-ON
  shadow + flip notification; flag-OFF silent-flip byte-identity;
  own-echo exemption). The stage-F residual comment at `inputSynced`
  is rewritten to the resolved posture.
- The Phase-2 revisit (b) — the source-following half: RETIRED, not
  covered as a tenure-wide source probe. Tenure activation ensures root
  existence without following the root's origin. Runtime-supplied wish
  sidecars are explicitly opened and follow their origins through that open;
  their lifecycle is a separate surface from root ensuring. The
  `sx2-serving-loop` integration surface
  (`packages/patterns/integration/sx2-serving-loop.test.ts`) keeps its
  remaining gates and runs in both arms, its ON-arm skip having been
  retired with the demand-cycle starvation fork (the skip-list row
  below). A full stale-pointer roll-forward journey remains the named
  follow-up.
- M1's Phase-2 seam — per-run demanded identities: the demand
  carriage (watchedRootsForSpace per-instance entries + the
  SpaceServer's demanded-identity registry), the widened
  `ServerRunInfo` (`scopeKeyIdentity`/`actionScopeKey`) passed
  through `#stampRun`, and the tx-carried identity consulted at the
  traversal-context and result-cell sites. Cardinality 2 pinned at
  three levels (`executor-wave.test.ts`: the sink/engine same-doc
  two-instance fold and two stamped runs folding into one wave with
  per-run keys; `executor-serving-loop.test.ts`: the production-seam
  journey whose per-run outbox carriages carry two DIFFERENT keys
  into the completions — the m-4 note's "arrives with Phase 2's
  stamper" DISCHARGED). The per-run SUPPLY — the scheduler running a
  scoped action once per demanded instance — LANDED with stage P2-F
  (the N-run settle loop through the `runInstanceResolver` seam;
  OW17 below carries the narrowed residue: the replica-level
  per-instance read keying and the local dirtiness precision that
  depends on it).
- The ON-arm skip list: Phase 2 RETIRED the two-browsers entry (its
  named unskipping condition — the client derivation-commit path
  removed — is this PR; that gate now runs and passes ON) and ADDED
  one entry, `sx2-serving-loop`, under `phase-2-followup` — the
  demand-cycle starvation fork's reproducer. Stage P2-F
  (2026-08-13) RETIRED that entry too: the terminal state closed
  the fork (the OW19 row below records the closure), and the ON-arm
  skip list was EMPTY again — the full patterns suite runs both
  arms. (Dated history: Phase 4 re-added `topics-navigation`, Phase 7's
  fixer added five more `phase-7` entries — and found the mechanism
  had been INERT since Phase 4, so "runs and passes ON" for the
  two-browsers gate was true only of the MIXED-posture lane; see OW25
  and the 2026-08-16 delta.)
- testing §4's single-deriver envelope gate: impl-covered — the
  store-attribution query pinned in `speculation-overlay.test.ts`
  (every derived commit's holder is the service identity; none from a
  client session).
- The standing rule's trigger has FIRED: Phase 2 flips ON, so the
  next full mapping pass is DUE — owed as a follow-up alongside the
  Phase-3 pre-flight, not carried in this PR.

**Phase 2 pre-gate — LANDED with Phase 2 (2026-08-07):**

- OW3 — LANDED as the model's narrowing/fan-out sub-model
  (`packages/spec-model/server-execution/model.ts`, C11a–C11c in
  `properties.test.ts`): instance sets stay clean products (never
  ragged, exhaustively), the fan-out unit is the RUN
  (`action × instance`, never merged), and W never forks — one
  integer whose ADVANCE waits on demanded siblings only (protocol
  §4's fresh-demand-after-W allowance modeled explicitly), undemanded
  instances never holding it back.
- OW4 — LANDED as trace T15 (scenario-traces §3/§4, count 14 → 15)
  plus impl witnesses, scoped precisely: input-origin RETIREMENT
  (acked AND W ≥ seq — the retire-after-coverage half) and
  never-serialized are pinned in `speculation-overlay.test.ts` /
  `sx2-speculation.test.ts`; unreplicated-doc-reads-pending and the
  KEEP half of §4 step 3 (an unacked origin holds the echo) are
  covered by T15's cited answers and speculation §2's normative text,
  with direct pins owed alongside the Phase-3 offline machinery
  (which builds the origin-queue fixtures they need).
- OW12 — LANDED: the discovered-narrowing eager via-user hop now has
  its direct test (`packages/runner/test/eager-via-user-hop.test.ts`,
  the OW12 case — a compiled pattern whose run READS a `PerSession`
  cell and discovers session narrowing at its result binding;
  space→user→session chain pinned, value at session).

Delta 2026-08-07 — the scheduler-tell classification batch (owner
ruling 2026-08-07; this PR):

- protocol §1's scheduler-tell rule (+1 rule, map edited with this
  delta; speculation §2 carries the cross-reference, counted once):
  → COVERED by the existing stamping-boundary pins — the ruling NAMES
  the landed boundary rather than changing it, and the boundary is
  already witnessed end to end in
  `packages/runner/test/speculation-overlay.test.ts` (stamped
  derivation-kind runs divert; handler runs committed authored — F10,
  the interim Phase 3 INVERTED: those pins now assert a handler fire
  commits only the event and the handler run diverts; UNSTAMPED
  setup/binding transactions commit as today; the
  store-attribution query — zero derived-class commits from any
  client session) and live in
  `packages/patterns/integration/sx2-speculation.test.ts`. The
  no-creation-carve-out corollary rides the same pins (a lift
  instantiation's run is stamped derivation-kind by construction);
  the imperative-creation `.pull`-for-round-one flow is exercised by
  the serving-loop demand path
  (`packages/runner/test/executor-serving-loop.test.ts`).
- speculation §4's retirement honesty sentence (+1 rule, map edited
  with this delta): → COVERED — the retirement trigger (watermark
  coverage of basis + acked origins, value arrival NOT awaited) is
  pinned in `speculation-overlay.test.ts`, and the safety machinery
  the sentence names — the demand-cycle ensure-retry on deferred
  structure loads — is pinned red-first in
  `packages/runner/test/executor-serving-loop.test.ts` (the
  demand-cycle ensure-retries test, c766ef453).

Delta 2026-08-07 — the Phase-2 INDEPENDENT review's fix batch (this
PR):

- A SECOND RECORDED OFF-arm acceptance rides Phase 2's R4 fix (RULED
  2026-08-07, owner — complexity-adjudicated: the whole-result
  validation's over-reach was latent on BOTH arms, and narrowing was
  chosen over carrying it; testing §2's gate clause already names
  this register's recorded-acceptance rows, so this row is the
  stage-G `tryClaimMutex` row's sibling). The delta:
  `PiecePropIo.set`'s non-stream branch moved from WHOLE-RESULT
  validation to WRITTEN-SUBTREE validation (`linkPathContracts`, the
  sibling stream branch's long-standing approach) — property writes
  that formerly threw on UNRELATED-property staleness (an absent or
  invalid sibling the write never touched — the ON arm's
  server-derived-late `$NAME` flake, and the same latent over-reach
  OFF) now succeed, while an invalid WRITTEN value still throws and
  correlated-anyOf paths keep the whole-result fallback (the one
  shape path contracts cannot decompose). Pinned in
  `packages/piece/test/pull-materialization.test.ts`: the ruled
  absent-unrelated-required and invalid-unrelated-sibling shapes
  (both RULED-2026-08-07-named tests), the explicit-undefined alias
  still surfaced by the write-destination validator, the
  derived-Cell-root pin reconciled to the narrowed contract, and the
  correlated-union path still validated.
- The settle input barrier's review pins (M2/M3/m4), landed with
  probe evidence: the own-echo VERDICT-RACE repair (a frame
  outrunning its verdict mis-records the echo as foreign; the
  settleAccept repair lifts it — deleting the repair turns the new
  `memory-v2-stacked-commit.test.ts` test red); the SpaceServer
  W-clamp's counter now matches serving-loop §7's binding sentence —
  it counts every wave whose advance the floor held below an
  otherwise-advancing batch head, FULL suppression and the
  remove-sentinel floor included (the pre-fix `advanceTo > W` guard
  missed exactly those; no spec change — the code moved to the
  sentence); and the clamp's min/max advance composition, the
  counter, and the PROMPT lift are pinned at the SpaceServer level
  (`executor-space-server.test.ts`, stubbed floor — either inverted
  Math.min/Math.max turns it red). The prompt lift is new mechanism
  (the review's m4): `ISpaceReplica.shadowFlipObserver`, installed at
  activation and fired by `confirmPending`'s flip, resolves the
  loop's input wait directly — without it a clamped-then-quiet space
  waited out IDLE_PARK_MS before the catch-up wave (probe: wake
  disabled, the prompt-lift pin times out red). The shadowed-REMOVE
  sentinel (floor 1) gained its replica-level pin, and the R2
  never-a-piece exclusion test now exercises the `cid:` class
  (dropping it from the exclusion turns the test red).
- `sx2-speculation`'s bounded destination-validator retry is now
  VISIBLE when it engages (a loud engagement log) and scoped to the
  cold-view creation window it exists for: the gate's new
  steady-state edit runs with ZERO retries, so the open
  set-validation fork engaging outside its window fails the gate
  instead of riding the mask (the review's m9).
- Provenance note for protocol §1's owner blockquote (the scheduler
  tell): its primary source is the owner's coordination-channel
  message of 2026-08-07 (off-GitHub), attested by the coordinator —
  the quote's fidelity is not independently verifiable from repo
  artifacts.

## 3. The owed register (every genuine orphan, with its trigger)

Nothing here blocks Phase 1. Each item names the instrument
extension owed and WHEN it earns its cost:

**Next model commit (cheap, do with the next ruling batch):**

- OW1 — forged `firedAt` admission negative: a client-supplied
  `firedAt` disagreeing with the envelope is REJECTED (events §1,
  scopes §5). One C6-style negative.
- OW2 — a lease renewal is NEVER a commit (serving-loop §2): renew
  transition asserts zero commit records.
  Implementation coverage in `executor/activation-lease.test.ts` verifies renewal
  without commits while the
  runtime factory and delegated append recovery are held beyond the lease's
  initial lifetime, then checks the first derived commit's actual wave verdict
  and stored value. Controlled-clock refusal cases cover takeover before and
  at renewal, lease-store errors, factory and runtime validation failures,
  disposal despite observer cleanup errors, and host shutdown waiting for the
  returning runtime's disposal. A factory read-through control verifies that
  another user's stored instance becomes unavailable after lease takeover.
  Host controls also require fresh-runtime activation and an accepted stored
  result after initialization lease loss with surviving session, event, or warm
  demand. They cover warm notices arriving during initialization and cleanup,
  no-demand and rival refusal, closed hosts, and controlled exponential backoff
  whose pending rebuild is canceled by shutdown.

- OW9 — the §3d rebase arm: the model's conflict machinery requeues
  EVERY raced consequence — it has no field-level-merge disposition —
  so the impl's three-way drop/rebase/requeue split (serving-loop
  §3d) is pinned by impl tests alone
  (`packages/runner/test/executor-wave.test.ts`). Owed: a model
  rebase-arm extension (commuting-patch merge plus the
  re-CAS-at-the-observed-head rule).

**Phase 2 pre-gate — LANDED with Phase 2 (2026-08-07; the delta
above carries the coverage):**

- OW3 — LANDED (the C11 narrowing/fan-out model family).
- OW4 — LANDED (trace T15 + the speculation impl witnesses).

**Stage F pre-gate — LANDED with stage F (2026-08-05):**

- OW5 — LANDED as trace T13 (scenario-traces §3/§4) plus the
  serving-loop tests: activation loads demand + queued events, never
  a piece-start step; auto-activation on authored admission /
  session open; parking honors pending gate wakes (N9's default,
  adopted). One residue stays owed, carried DELIBERATELY as T13.Q8's
  GAP: wish `#now` timers vs quiescence needs its own owner ruling
  first (N50) — see OW11 below.
- OW6 — LANDED: trace T13.Q5 + the end-to-end server-side hot-swap
  test (`executor-serving-loop.test.ts`): the pointer write is
  authored input, the SpaceServer swaps, the swapped derivation
  serves as a derived commit.
- OW10 — LANDED: `assertSchemaMemoIdentity`
  (`packages/runner/src/traverse.ts`) binds a shared memo to its
  first traversal's identity at the SchemaObjectTraverser choke
  point and throws on any other — the future-sharing change now
  trips loudly instead of silently value-bleeding.

**Still owed from the stage-F bucket:**

- OW11 — the N50 owner ruling (wish `#now` timers vs quiescence and
  the amplification budget), carried out of OW5: a space with an
  interval `#now` never quiesces and every tick is a derived
  commit; parking policy and the testing §4 gate need the ruling
  before builtins §1 ships `wish` as "port cost: none". T13.Q8
  holds the trace cell open.
- OW12 — LANDED with Phase 2 (2026-08-07): the discovered-narrowing
  fixture exists (`eager-via-user-hop.test.ts`'s OW12 case) and pins
  the `pattern-binding.ts` chain directly.
- OW13 — delegated-grant RESOLUTION (protocol §2's delegated row,
  carved out 2026-08-05): admission today validates carriage
  PRESENCE + COMPLETENESS (class, non-empty actor + grant, the
  sessionless session-scope refusal) and keys scoped writes from the
  carried identity; it does NOT resolve `capabilityRef` against the
  target doc/stream — today's ACL model holds no per-doc grants to
  resolve against. Owed: the grant-resolution check and its negative
  tests when a per-doc grant store lands. Trigger: the first
  producer of grant-scoped capabilities (protocol §2's anticipated
  grant-scoped checks) — no later than the outbox/provisioning
  producers going live (Phase 3 events; Phase 5 cross-space).
  RULED 2026-08-13 (owner; the delegated-scoped-reads deferral): NO
  refusal machinery lands in Phases 1–4 — no delegated-scoped-read
  producer exists through Phase 4 (verified), so there is nothing
  to refuse. Phase 5 MUST land the grant-scoped read design
  (protocol §2's anticipated grant-scoped checks), or an explicit
  fail-closed admission refusal, BEFORE any delegated-scoped-read
  producer ships — a Phase-5 work-order PRECONDITION, and the
  producer and its refusal/design land together as one stack, so no
  interim exposure window exists. DISCHARGED with Phase 5
  (2026-08-14): the design landed in protocol §2 and its fail-closed
  interim landed at both ends of the stack (the 2026-08-14 delta
  below carries the coverage); the grant-RESOLUTION obligation stays
  owed on its original trigger.

**Stage G pre-gate — LANDED with stage G (2026-08-06):**

- OW7 — LANDED as trace T14 (effect failure and retry: input-driven,
  never timers — scenario-traces §3/§4) plus the impl witness in
  `executor-serving-loop.test.ts` (the failure leg: an error-shaped
  result commits with the key, no timer retry fires, and only an
  input change re-fires).

**Phase 3 pre-gate (when events land; pulled by Phase 3's
pre-flight):**

- OW14 — LANDED with Phase 3 (2026-08-10): the LT4 arm writes the
  events §5 failure notice onto the SOURCE event's entry (protocol
  §2b's ruling) BEFORE deleting the refused row — a small derived
  commit of the loop's own, deduped by the refused append's eventId;
  the crash-window pin (re-send → re-notice deduped → retire) and the
  unsourced fallback live in `executor-outbox.test.ts`. The notice's
  FIELD SHAPE (`StreamEventEntry.deliveryFailures`) is an
  implementation choice FLAGGED for ratification in the Phase-3 PR.
  Original obligation: the LT4 arm's source-side notice ORDER: when Phase 3 lands
  events.md §5's failure-notice machinery, the deterministic-
  rejection arm must write the events §5 notice BEFORE deleting the
  refused outbox row — today the delete discards
  `eventId`/`target`/`reason` except a warn log, and the obligation
  lives only in outbox.ts's LT4 comment. Owed: the write-then-delete
  ordering plus its test (a crash between the two must re-send and
  re-notice, deduped, never lose the notice). Trigger: Phase 3's
  events §5 machinery landing.
- OW15 — LANDED with Phase 3 (2026-08-10): the engine floor admits a
  userless batch iff declared sessionless-space-scope (negatives both
  ways + both contradiction refusals + the user-scope chimera twin in
  `memory/test/v2-event-append.test.ts`); the source refusal in
  `enqueueOutboundAppend` lifted symmetrically; the delivery path
  forwards the declaration and stores NULL — never "" — for the
  absent principal; the delivered entry stamps
  `firedAt = { session: "server" }` with no user key (pinned end to
  end in `executor-outbox.test.ts`); the model pin rides C0-guards.
  Original obligation: the sessionless space-scope floor carve-out's
  IMPLEMENTATION (SHAPE-RULED 2026-08-05, protocol §2): lift the
  source refusal in `enqueueOutboundAppend` for declared
  sessionless-space-scope entries, fix the delivery path's `?? ""`
  acting-principal mapping, land the floor negatives BOTH ways
  (userless space-scope-declared admitted with
  `firedAt = { session: "server" }`; userless without the
  declaration still refused) and the model pin. Trigger: Phase 3's
  event producers going live.
- OW16 — LANDED with Phase 3 (2026-08-10): pin/unpin route through
  `markEffectCompletion` as COMPLETION-class turn-lifecycle state
  (their own derived commits, lifecycle subkeys so the turn's
  in-flight entry never tears) and updateArgument stamps as a
  HANDLER-class event-handler contribution (§3d's rebase-don't-drop
  class; no eventId — the no-event requeue corner is the class's
  inherent shape, noted at the call site).
  Original obligation: the llm-dialog tool mutations' RULED classifications
  (2026-08-05), implemented: pin and unpin commit as
  COMPLETION-CLASS turn-lifecycle state; updateArgument commits as
  a HANDLER-CLASS consequence. The three call sites carry the
  ruling in comments (llm-dialog.ts — awaited and surfaced since
  the stage-G review batch); the stamping/classing itself is
  Phase-3 events territory. Trigger: Phase 3's pre-flight.

**Phase 2 follow-up (APPROVED as its own follow-on stage — owner
nod, 2026-08-07; recorded in the plan's stage list):**

- OW17 — the scheduler instance dimension, NARROWED by stage P2-F
  (2026-08-13; the supply LANDED): the N-run settle loop over
  demanded identities is BUILT — the scheduler's reactive-action
  choke point resolves an action's piece root against the
  SpaceServer's demanded-identity registry (the
  `runInstanceResolver` seam installed beside the §3d stamper) and
  runs once per demanded instance, each run stamped with that
  instance's identity AND acting pair; the LT6 inheritance hands an
  emitting run's identity to its dispatched handler run. Pinned:
  `executor-run-supply.test.ts` (the N-run loop at cardinality 2
  through the production choke point; LT6 inheritance; both
  red-first at the P2 base), `executor-serving-loop.test.ts`
  ("supplies the demanded (user, session) identity … END TO END" —
  registry → auto-stamped run → acting annotations + per-instance
  basis rows in the engine, red-first;
  `executor-space-server.test.ts` adds the argument-doc demand — the
  ensure-resolved owning root differs from the demanded id — reaching
  the same observable through the resolved-root mapping). What
  REMAINS owed — one leg,
  together: the replica-level per-instance READ keying (one doc, N
  instances read locally — the replica still keys scoped docs by
  scope name, the cardinality-1 collapse the sink-level fold test
  documents) and the per-(action × instance) LOCAL read-set/
  dirtiness precision that depends on it (until the replica holds
  distinct instances, per-instance local dirtiness is
  behaviorally unobservable; the node re-runs its current instance
  set and equality cutoffs/memo hits absorb the siblings — those two
  are the ONLY absorbers: event ids mint per origin transaction, so
  sibling instance runs mint DISTINCT ids and a derivation body
  calling `.send()` would dispatch once per demanded instance, with
  no eventId-level dedupe absorbing it. Handler dispatch is a
  separate non-fanned path (C11b), and derivation-emitted events are
  an anti-pattern today; that surface is unpinned either way — a pin
  is owed when they become legal). The read collapse has a VALUE
  half, stated explicitly so Phase 5's trigger is legible: sibling
  runs read the SAME collapsed local scoped doc, so at
  cardinality ≥ 2 with genuinely divergent scoped inputs one user's
  per-instance engine rows hold values derived from the OTHER user's
  data, stamped acting = the wrong user — a consequence stage P2-F
  SHARPENS (pre-P2-F, scoped writes never landed in user instances
  at all). Trigger:
  no later than Phase 5's cross-space serving (foreign scoped
  instances make the local collapse load-bearing); flag-don't-fill
  until then.
  **Phase 7 evidence (2026-08-15) — the collapse is LOAD-BEARING NOW,
  and it is the flip's honest blocker for multi-user browser
  scenarios.** Three mechanisms peeled on the lunch gate under the full
  ON posture, in order: (1) the served `#profile` wish could not READ
  the demanding user's home space (memory ACL — the process identity
  was not a service principal; fixed: `memoryServiceDidsFor`);
  (2) a flag-ON client's wish also fetched + instantiated the create
  sidecar through bookkeeping-stamped AUTHORED commits, racing the
  server's derived ones on the same docs (fixed: the client references
  the served sidecar cell only — builtins.md §5); (3) the lunch
  pattern's `#profile` wish lives in a NESTED sub-pattern whose actions
  carried the CHILD root as `pieceRootId`, so the run supply found no
  demanded instances and the runs fell to the wave-level identity —
  the served scoped writes landed under `user:<serviceDID>` /
  `session:<serviceDID>:…` (store dump: 34 user rows + 7 session rows
  keyed by the SERVICE identity in the lunch space) — the
  silent-empty-instance trap for WRITES, protocol §2's S1 ("there is
  no third source of run identity") violated in practice (fixed: the
  demand-root CHAIN, `SchedulerObservationIdentity.demandRootIds` —
  nested pieces resolve through the outer root; `executor-run-supply.
  test.ts`, red-first). The build report's "with (1)–(3) the gate
  reaches the join UI ('host name filled') and stalls at the join
  click" DID NOT REPRODUCE at head (P7 independent review, 0/2 runs;
  `review-p7-logs/lunch-head-default-run{1,2}`): at head the served
  `#profile` wish ran once identity-less and threw at STEP 1
  (`home-space resolution on a serving runtime requires the run's
  demanding identity`) — the client's demand supplies NO identity for
  the wish's piece root (the OW29 space-root-demander gap is live at
  FIRST demand, not at the join click) — and because fix (2) makes the
  flag-ON client REFERENCE-ONLY, the client wish churns (~13.6/s,
  `wish/phase/send-error` n=4078 / 300 s) waiting for a sidecar the
  server cannot produce: fix (2) without OW29 converts a racy-but-
  rendering client into a wait-forever client. The builder's join-UI
  observation was on his tree WITH the reverted extensions applied.
  Two further extensions were BUILT AND REVERTED because they make
  cardinality ≥ 2 real on the collapsed replica: (4) SPACE-ROOT
  DEMANDERS — a client watching only the space-scoped piece root
  registers NO identity (`watchedRootsForSpace` records identity for
  scoped roots only), so the second browser was never demanded; a
  registry of (principal, session) demanders per space root + a
  demand-ARRIVAL re-run (`Scheduler.invalidateActionsForDemandRoots`,
  needed because a clean action never re-runs for an instance that did
  not exist when it last ran); (5) the OW17 WRITE-half mitigation — a
  per-instance run's scoped patch ops sealed as whole-doc SETS (the
  patch was diffed against a SIBLING instance's collapsed local value,
  so the engine rejected the whole wave: "wave commit rejected …
  missing path /value/$UI/props/$cell"). With (4)+(5) both users'
  instances materialize (store: `user:alice` 37, `session:alice:*` 2,
  `user:bob` …) and the serving replica OSCILLATES: two instances of
  one node write the same collapsed local doc alternately, each
  re-dirtying the other — a wave STORM (4,427 waves / 4,426 derived
  commits in 5 min, watermarkLag 1,685) — the OW17 VALUE half in its
  purest form. (4)+(5) are recorded here as the designed shape and are
  GATED on this row's owed leg (replica-level per-instance keying);
  they must land WITH it, not before. CORRECTION (P7 independent
  review, 2026-08-15; fixer 2026-08-16): the two-browsers gate's stall
  under the full ON posture — at the unmodified Phase-6 base AND at the
  Phase-7 head — is NOT evidenced as this collapse. Its server stats are
  QUIET (waves 20–26, derivedCommits 19–25, events 2/2 appended/
  processed, watermarkLag 1–2; `wavesBudgetExhausted` 12–16 of those
  waves — but the single-browser `counter` gate exhausts 2/5 with no
  client loop, so exhaustion alone is not the discriminator) while BOTH
  browsers run a CLIENT-side `scheduler-non-settling` loop (every
  ~6.6 s; 40–56 k client action runs / 5 min at head and base;
  `runner/start/resumeCellSync` n=458–644 piece re-starts). The
  4,427-wave storm signature above exists ONLY with (4)+(5) applied.
  The client loop is its own UNATTRIBUTED row (OW32) whose triage comes
  FIRST in the flip's ordered gates; "the browser-ON red family IS this
  collapse" is withdrawn.
  **CLASS VERDICT (P7 independent review, 2026-08-15): a bounded
  architectural LEG — not a bug, not a redesign.** ONE layer was never
  re-keyed: the runner-side local view. `SpaceReplica` keys every local
  doc by scope NAME (`docKey(id, scope)` = `${normalizeCellScope(scope)}
  \0${id}`, `packages/runner/src/storage/v2.ts` — used by `#docs`,
  `#sinks`, `#staleFloor`, `#watchedIds`, `#shadowedForeignSeqs`,
  `#syncTasks`: ~20 sites in one class); the wire upsert cannot name an
  instance (`SessionSyncUpsert.scope?: CellScope`, `packages/memory/
  v2.ts` — no scope key); `IMemoryAddress` carries no instance; and the
  scheduler dependency graph resolves reads/writes against the
  runtime's OWN identity (`scheduling-writes.ts`; C11b's singular node).
  Everything else already speaks per instance (engine rows and dirty
  keys `toDirtyKey(id, scopeKey)`, the lease-holder explicit-instance
  reads, `DerivedWriteAnnotation.scopeKey`, the P2-F run supply's N
  stamped runs). Fix SHAPE, with precedent (stage F/M2 re-keyed the
  scheduler's `entityKey` from name to scope key with the cardinality-1
  partition unchanged): (1) `SessionSyncUpsert`/`Remove` gain
  `scopeKey`, populated by the memory server for lease-holder-exempt
  sessions (the value is already `entry.scopeKey` at the push site);
  (2) `docKey` takes the scope KEY, resolved from the replica's own
  identity when no explicit key rides (OFF-arm neutral by
  construction); (3) the tx→replica read/write seam passes the run's
  stamped identity (`waveRunContextOf(tx).scopeKeyIdentity`) so an
  instance run reads/writes ITS doc; (4) scoped-doc change notification
  fans in to the singular node (any instance's change dirties the node;
  the N-run loop re-runs; equality cutoffs absorb siblings — the "local
  dirtiness precision" half stays an optimization). Nothing in C11b
  forbids this ("instances live in keys" — the local doc map is a key
  space); no serving-loop, demand, or wave redesign is implied. Size:
  P2-F-shaped (a stage), cross-cutting but mechanical; not a one-site
  fix. OW29's two extensions are prerequisites for user #2 to be served
  at all, and the whole-doc-set write-half hack becomes unnecessary once
  the diff base is the right instance's doc. Landing OW17+OW29 alone is
  NOT shown to green the two-user journeys (OW32 first).
  Trigger, re-stated: the flip's ordered gates (plan Phase 7 task 1):
  OW32 triage → THIS leg (with OW29) → OW28 → the honest benchmark →
  the flip PR.
  **IN PROGRESS — leg 1 of 2 LANDED (fan-out stage A, 2026-08-16;
  owner-ruled 2026-08-16 on the fan-out design + panel).** The
  serving replica and the wire are INSTANCE-keyed: `SpaceReplica`
  keys every local doc by `scope_key` (`docKey(id, instance)`;
  key-vocabulary.md §3b) — one replica holds the service instance
  AND per-principal instances of one doc; the wire carries
  `scope_key` on lease-holder frames/snapshots only, the collapse
  guard is scoped to non-holders, `WatchView` keys by instance; the
  tx→replica identity seam threads the run's demand-supplied identity
  (`IStorageTransaction.scopeKeyIdentity`, set by the wave stamp)
  through reads, the commit-time claim, seals and verdicts, the
  reactivity log (`IMemoryAddress.scopeKey` — the scheduler's
  dependency/trigger keys per instance), and the runner's
  explicit-instance loads (`Cell.sync` / `syncCell` / `syncInstance`
  / the transaction-layer kick / `ensureLinkedDocLoaded` / the served
  event's presync+preflight as its actor); the writer and
  materializer indexes are NAME-keyed by design (the one fan-in);
  the N-run loop resubscribes to the union of its instance logs after
  each instance (including while later instances run, pinned by
  `scheduler-empty-reactive-reads.test.ts`); S4 keys basis rows by
  the run's FULL instance address and clears the stranded stamp and
  broader-chain keys in both directions (the RAGGED amendment,
  scopes.md §2 — narrowing below the space→user hop is per
  principal). Pinned red-first at the P7 head:
  `executor-instance-keyed-replica.test.ts` (two demanded runs read
  their OWN per-user inputs → divergent per-instance derived rows
  with the right values and the serving replica holds both instances
  — the VALUE half CLOSED; **R7** — Alice's authored draft + save
  event → the served handler runs as Alice, reads HER draft, writes
  her per-user consequence with the typed value; the resubscribe path
  instance-aware — Bob's input change wakes the node; S4 — a
  session-scoped demand on a user-discovering node records `user:<p>`
  rows and no session-keyed zombie, a space-discovering node records
  `space`), `storage-instance-keying.test.ts` (OFF-arm neutrality per
  site: keys/compaction/logged addresses/notification addresses
  byte-identical without an explicit instance; the two-instance
  replica; the union resubscribe; per-instance watches and kicks),
  memory `v2-explicit-read.test.ts` (a lease holder names two
  instances of one (branch, id, scope) and receives both KEYED on
  watch.set/watch.add/graph.query/push; a non-holder's read set is
  still refused; a non-holder's frames carry no key). What REMAINS
  (leg 2, stage B): the fan-out run SUPPLY — identity on space-scoped
  demand rows, the demanders resolver, the known-scope ratchet with
  discovery/arrival re-arms, the per-demander demand walk (+ the
  wish-sidecar `parentPieceRootId` chain), output-scope-derived
  attribution, and B7 precise dirtiness (the name-keyed fan-in's O(N)
  cost is recorded, not a correctness need). Stage-A residuals,
  FLAGGED (not filled): (i) an effect COMPLETION for a per-instance
  run seals its local layer under the outbox carriage's identity
  (matching its engine row) but a builtin that leaves its writeback transaction unstamped reads the
  service's instances in its hash guard. OW28-instance-family records the
  remaining callers and the fetch/compile closure; (ii) a
  handler-only write to a never-written PerUser slot lands at the
  slot's base scope (the handler's handle carries no scope cap until
  the slot redirects — pre-existing OFF behavior, verified at OFF;
  the group-chat drafts avoid it because the client types first);
  (iii) two P2-F basis-key pins moved to the S4 truth (a demanded run
  reading only space input keys `space`, its `user:<p>` stamp cleared —
  the acting annotations still witness the supply); (iv) the
  wave-level fallback still runs a demanded piece before any
  identity-bearing demand exists and leaves the `user:<serviceDID>`
  garbage instance (stage B's B5 residual).
  **Independent review + fix round (2026-08-17; review verdict
  LANDABLE-WITH-FIXES, 24 mutations / 17 caught / 7 untested; fixer:
  every finding dispositioned, 24/24 archived mutations + M1 caught).**
  CLOSED by the fix round: (1) the review's MAJOR correctness finding —
  the keyed wire hung from a bit any lapsed push pass cleared and only
  a fresh admission re-armed, so a former/blipped holder's
  full-evaluation catch-up sent UNKEYED removes for keyed-delivered
  foreign instances (the runner replica wiped its OWN instance and kept
  the stale foreign one — reproduced end to end) and a survived
  renew-blip left the loopback session's foreign instances withheld for
  the session's life (silent-stale). Invariant as landed: the session's
  keying is STICKY wire vocabulary (a keyed delivery is always keyed-
  retracted); foreign-instance DELIVERY stays the per-pass live-lease
  question; a lapse is recorded and the first live pass RE-ARMS with a
  full evaluation; the SpaceServer's renew arm reports a survived blip
  (`noteLeaseReacquired`) so that pass runs promptly (protocol.md §3 as
  amended). Pinned red-first: memory `v2-explicit-read.test.ts` (keyed
  retraction with the own instance untouched; the re-arm via the notice
  and via the first evaluating pass; the notice inert when nothing
  lapsed), `storage-instance-keying.test.ts` (the replica half),
  `executor-space-server.test.ts` (the renew arm's notice — once per
  blip, never on a plain tick, never on a park),
  `executor-instance-keyed-replica.test.ts` (the lapse withholds Alice's
  write, the notice re-delivers it keyed to the serving replica, her
  instance re-derives, Bob's untouched); each half mutation-verified.
  (2) The TRUE R7 shape (type, then save; no derivation ever loaded the
  actor's draft instance) is now pinned — the shipped R7 pin was
  green with the presync AND preflight actor identity removed (a
  derivation had pre-loaded the instance); the new pin asserts the
  no-load precondition and goes red with both removed. (3) S4's
  clearance half is pinned in BOTH directions with pre-existing
  stranded rows plus the same-wave real-row guard
  (`executor-wave.test.ts`); the earlier "pinned in both directions"
  claim was an over-claim (only not-written was asserted). (4) The A3
  seed-memo re-key is pinned (Bob's default seeded after Alice's run
  memoized presence). (5) The individually-redundant seams have their
  own pins (served preflight/presync identity, `Cell.sync` identity,
  the traversal kick identity, `SpaceReplica.#buildReads()` identity,
  `WatchView` key). Residuals SHARPENED, still flagged: (i) effect
  completion — remaining unstamped builtin writebacks read the service's
  instances while the seal is under the carriage identity (the current
  caller boundary is OW28-instance-family);
  `SpaceReplica.#buildReads()` then attests the CARRIAGE identity's records (a
  never-
  loaded record yields seq-0 confirmed reads); the engine does not
  reject a mis-attested basis on derived commits today, so the
  consequence is confined to local cascade/hash-guard tracking — but
  those remaining per-user effect paths have an unattested basis;
  fix shape: stamp the completion tx with the carriage identity at
  `markEffectCompletion` (needs the runtime's outbox carriage — a
  stamper hook, threaded through the builtins), NOT filled here;
  trigger: before stage B adds per-user effect nodes. (v) The served
  event stamp sets a NON-RESOLVING identity for a userless `firedAt`
  (`{session:"server"}`) while preflight/presync read the own instance
  — deliberately NOT aligned: the non-resolving identity is what makes
  a userless run's scoped WRITE fail closed (`resolveScopeKey` throws;
  the events.md §2 sessionless-actor class), dropping it would key the
  write under the service silently, and aligning the guards the other
  way buys nothing (loads land only in resolvable instances); the shape
  itself — a declared sessionless space-scope chain touching user
  scope — is illegal and its reads are empty either way. (vi) The
  arrival gate's sweep has no arrival trigger of its own (speculation.md
  §4 now states the frame-coupling assumption); an arrival re-sweep is
  owed if that coupling loosens — LANDED, stage C tuning T2 (2026-08-18;
  the coupling loosened by construction under the honest flush deadline
  — see the stage-C tuning delta below). (vii) Two PRE-EXISTING SpaceServer
  blip-window shapes surfaced by the fix round's E2E, not stage A's and
  not filled: (a) with the lease row expired but the in-process tenure
  live, the loop re-attempts its watermark advance every cycle and each
  is refused by the engine's derived-class rule (a hot spin — 471
  `wave-commit-rejected` in 2.7 s observed) until the row is live again
  or the tick parks; (b) an EMPTY seal (a read probe, a no-op
  derivation) opens a `#currentWave` that outlives zero-delta cycles
  with the pre-blip tenure, so the first real seal after a same-process
  reacquire aborts `lease-lost` and PARKS the space — the "survived
  blip keeps serving" path is reachable only on a space quiet across the
  tick; owner: the P7 renew-blip / wedge arms.
  **CLOSED — leg 2 of 2 LANDED (fan-out stage B, 2026-08-17; owner
  ruling 2026-08-16 "if a space scoped calculation gets narrowed to
  user, it'll have to run for all users that demand it").** The
  per-demander run SUPPLY: the demand registry keeps every demanding
  (user, session) pair on every root a client watches — space-scoped
  roots included (`watchedRootsForSpace` returns one row per demanding
  session; the SpaceServer's `#demandersByKey`); the resolver seam
  returns DEMANDERS (`runDemanderResolver` / `serverRunDemandersFor`,
  replacing the instance-returning P2-F seam that decided instances
  from the demand's own scope — F10's over-keying); the scheduler owns
  the KNOWN-SCOPE RATCHET (`scheduler/fan-out.ts`: the top hop a
  node-level bit, session depth per principal — ragged, scopes.md §2
  as amended; only narrows; forgotten with the node) and derives
  `instances(ratchet, demanders)` — one probe (min pair, key `space`)
  while unnarrowed, one per demanding principal at user depth, one per
  demanding session for a session-deep principal; the discovery
  RE-ARM runs the siblings a moved ratchet exposes in the SAME pass;
  the ARRIVAL RE-ARM (`invalidateActionsForDemandRoots`, keeping the
  per-instance record) runs a late demander's instances only, woken
  by the memory server's new `demandChanged` observer with a 300 ms
  coalescing grace; the demand WALK runs per demander (an effect node
  registered per demand key with the root as its demand root, so the
  ordinary supply fans it out); B7 precise per-instance dirtiness (per
  instance: the last committed log + a clean bit; a keyed notification
  address dirties exactly the instances whose identity covers it; the
  node's one subscription is the union; retries dirty only their own
  instance); scope-derived ATTRIBUTION with the early-emit guard
  (protocol.md §1 as amended); the wish sidecars chained to their
  wish's piece (`parentPieceRootId`); the ragged redirect fix
  (pattern-binding.ts: a session hop below an existing user redirect
  lands in the run's own user slot, never on the shared space slot);
  the service identity runs NO demanded work (fallback only when no
  principal demands the roots; a narrowing fallback counted as
  `undemandedNarrowingRuns`). Pinned red-first at the stage-A tip:
  `executor-fan-out.test.ts` — (a) two users watching ONLY the space
  root → two instances with their own values, user-only attribution,
  no service row; (b) the arrival re-arm (Bob's instance on demand,
  Alice's untouched); (c) RAGGED (Bob per session, Alice per user, no
  session-keyed run for Alice); (d)+(e) a space node runs ONCE for
  three demanders, stamped as a demander; (f-walk) a subtree
  reachable only through a demander's value materializes under her
  instance; (h) the B7 probe — N=4 × M=3: ONE user's change re-ran
  exactly that user's 3 instances (naive 12), derivation node count
  35 → 35; (i) the OW29 storm pin — 20 divergent edits per user,
  waves bounded, quiescent, values never crossed; `scheduler-fan-out.
  test.ts` (the pure core: instance function, ratchet, run outcomes,
  mid-run causes, B7 dirtiness, union/prune); `executor-run-supply.
  test.ts` (probe once, then per principal in the same pass; the
  nested/list/grandchild chains per principal); `executor-space-server.
  test.ts` (LT6 as a user-instance run: `firedAt.session = "server"`;
  the EARLY-EMIT GUARD — send-then-read refused fail-closed, retry
  attributed at the learned scope, one durable entry); the P2-F pins
  moved to the ruled attribution (a user-scoped instance carries the
  user only). PINNING (review F3, fix round 2026-08-17): the RAGGED
  redirect fix now carries a DETERMINISTIC unit pin at
  `sendValueToBinding` (`pattern-binding.test.ts` "RAGGED redirect": an
  existing space→user redirect + a session discovery → the run's own
  USER slot is re-pointed at session, the SHARED space slot untouched;
  M9 — revert to writing the shared slot — kills it 4/4, replacing the
  timing-sensitive (c)/(f-walk) coverage the review found M9 surviving
  3/4). The WISH-SIDECAR demand-root chain (`sidecarRunOptions`) stays
  covered only by the bimodal lunch gate: a runner-suite pin needs the
  profile-create sidecar to actually RUN, and its fetch→compile→run
  `.then` does not complete under the suite's mandatory fake clock (the
  fetch fires, but `runSidecarInOwnTx`'s run never does), so a reliable
  MWISH pin is OWED as a served-host wish E2E (the fan-out E2E's
  ExecutorHost shape) — a named follow-up, not landed here.
  Stage-B residuals, FLAGGED: (viii) the wish sidecar's
  instance SET is the chain's demanders, not only the demander the
  sidecar was minted for (a sibling's runs of a per-user sidecar's
  narrowed nodes are inert but not free) — a per-demander pin
  (`demandedBy` on the run options → a resolver filter) is the
  refinement, an unstated semantic left for the owner; (ix) ~~the walk
  re-fires per changed doc it read (an effect; N × walk per changed
  root — the design's stated cost), not covered by B7's derivation
  claim~~ **RESTATED 2026-08-19 (stage-C build W1): there is no walk.**
  The demand walk is deleted; the demand pass reconciles the tracked-ids
  closure in O(rows) on registry deltas (no per-row engine read), and the
  structural-growth path lands one derived commit later than the link that
  reaches it (W0's measured cost: chat 220–253 ms p50 to the landing,
  ≤ 1.24 s p95, mostly the 300 ms demand-wake grace of (x)). B7's
  per-instance clean bit is now the currency check's substrate; (x) the demand wake's 300 ms grace is a coalescing choice,
  not a ruling — without it the lunch gate's browsers hung at login
  (the loop's eager first structure load + derivations of a piece its
  creator was still setting up made the creator's deferred-start
  reads stale; the client's `piece-instantiate` then failed
  `piece-start-commit-failed` and the shells never idled) — the
  client-instantiate-vs-server-derive race at piece creation is
  still possible, but its one-shot loss arms are bounded in the runner:
  a deferred client start that loses a stale-read race catches up from
  served state, while a serving `piece-instantiate` contribution that
  is dropped cancels only its exact speculative node group and
  re-instantiates once in the next wave. The grace still reduces the
  contention rate; correctness no longer depends on winning that first
  bookkeeping wave. Whole-wave aborts and abandons keep their existing
  lifecycle recovery instead of retrying in place.
- OW19 — the demand-cycle terminal state: CLOSED by stage P2-F
  (2026-08-13; the RULED 2026-08-07 direction, built whole). A
  demanded root CONFIRMED synced with no pattern meta parks TERMINAL
  (`structureLoadTerminal`) — no per-cycle ensure churn — and a
  commit touching one of the load's observed docs RE-ARMS it
  (`structureLoadRearmed`); the retry follows replica application within the
  settle loop and finishes its demanded derivations before watermark coverage.
  Admissions racing confirmation also invalidate a missing-metadata verdict.
  The
  demanded-structure load pass moved UNDER the wave's flush deadline
  (single-flighted across cycles; completion wakes the loop), so a
  slow ensure no longer throttles input consumption. The conflation
  hazard is discharged exactly as ruled: not-yet (creation race —
  the instantiation commit re-arms, the settled retry loads and the
  piece serves) vs never (a plain value doc stays parked) are
  distinguished by the re-arm, never by id. Pinned red-first:
  `executor-space-server.test.ts` ("terminalizes … STOPS the
  per-cycle churn" — deferred/terminal counters flat across driven
  cycles; "re-arms … and LOADS a piece created after the terminal
  decision" — the full terminal → re-arm → settle-gated retry →
  serve journey), and the serving-loop E2E's creation-race test
  reconciled to the new classification (terminal + re-arm counters,
  failures still zero). The `sx2-serving-loop` skip-list entry is
  RETIRED with this row — the surface runs in CI's ON arm, carrying
  the amplification-ratio gate. Source-following ownership and the
  server's root-existence coverage are recorded by OW18 below.
  The `executor/space-server-terminal-structure.test.ts` controls observe the
  real engine's durable result at every covering commit for creation during
  a structure load, across a flush deadline, at each deadline check the settle
  loop makes once its input barrier has passed — the re-armed structure retry
  and the scheduler probe — through an owning backlink, and with sealed
  writes pending. `executor/space-server-terminal-confirmation.test.ts`
  covers the engine-settled confirmation and its traversed-address demand,
  the re-ask a replica behind the store still gets, departure and return,
  sync failure, and teardown. `ensure-piece-running-scope.test.ts`
  distinguishes same-ID links across scopes from true cycles under both
  execution postures.

- OW18 — CLOSED as a move-everything obligation. Tenure activation ensures
  that the space root exists without following the root's source. Source
  following belongs to whoever explicitly opens a piece, as specified by
  [piece-source-lifecycle.md](../piece-source-lifecycle.md) and serving-loop.md
  §3e. Under ON, the serving wish builtin opens its runtime-supplied sidecars
  through `openSidecarSurface` → `SourceReconciler.open`; existing sidecars
  reconcile their origins there. ON clients reference those served sidecars
  without opening them. The server still reacts to accepted pattern-pointer
  writes by swapping the served graph. Coverage belongs to
  `packages/runner/test/executor-space-root-ensure.test.ts`,
  `packages/runner/test/ensure-space-root.test.ts`, and
  `packages/piece/test/piece-source-lifecycle.test.ts`. OW45's root-existence
  work and explicit-open lifecycle gaps retain their own scope; no tenure-wide
  source updater move is owed here.

**Phase 3 follow-ups (the independent review's owed rows,
2026-08-11):**

- OW20 — CLOSED with Phase 7 (2026-08-15) as OUT-OF-SCOPE-THIS-ROUND
  (not deferred-owed): the owner RE-RULED LT9 — queued events surviving
  a client reload is a NON-GOAL this round ("the status quo doesn't
  survive client + server reload either"), the queue is
  PROCESS-LIFETIME (events.md §5), and the durable adapter that carried
  this row (Phase 3's Web-Storage store, Phase 5's
  `InitializationData.eventAppendQueuePersistence` coupling seam) is
  RETIRED. Kept: the manager-shared in-memory store and its in-process
  replacement-survival pins (`event-append-client.test.ts`,
  `space-host-late-hint.test.ts`) — machinery loss, not reload loss.
  The recorded FUTURE shape, if reload survival is ever wanted:
  per-tab persistence + orphan adoption (per-tab sessions, one writer
  per session by construction, no leader election, no shared persisted
  session). Original obligation, for the record: the LT9 BROWSER
  ADAPTER (the durable `EventAppendQueueStore`, landing with protocol
  §5's sessionId persistence it depends on) carried two queue debts —
  (i) queue SELF-START on reconnect; (ii) the save-ordering contract
  (`#persist` serializes saves behind the previous save — review m6,
  still pinned; an async adapter MUST keep resolving `save()` per
  call).
- OW21 — updateArgument's FULL EVENT-ROUTING (per OW16's
  classification): the tool mutation stamps HANDLER-class with NO
  eventId, so on a flag-ON client the overlay REFUSES the seal
  loudly (review m5 — surfacing what was silent loss: the divert
  reported ok, nothing landed, no server run reproduced it, the
  entry could never intent-retire). The refusal is the honest
  interim, not the design: routing the mutation as a real event
  (minted id, appended intent, server-authoritative run) is owed.
  Interim mitigation, now ASSERTED (`speculation-overlay.test.ts`):
  the llm-dialog tool loop's egress is dropped under speculation, so
  a speculative turn cannot reach the tool call client-side.
  Trigger: the first flag-ON client surface that drives llm-dialog
  turns (the dialog moves server-side with the loop, which may
  retire this row instead).
- OW22 — `leaseHolderReads` is STICKY and the wire upsert path
  strips scope keys (pre-existing adjacencies, surfaced by the
  Phase-4 independent review's isolation trace): (i) the flag
  (`session-registry.ts` — set once when a session is admitted an
  explicit `entity_scope_key` read, lease holders only) is never
  retired, so a session that ONCE held the lease keeps its push
  applicable-set exemption — every instance's rows keep flowing to
  it — after the lease expires or hands over; (ii) the recovery
  path's wire upserts carry scope NAMES, so a lease-holder
  session's explicit foreign instances mis-resolve to its OWN
  identity (`server.ts`'s instanceKeyFor recovery — mitigated today
  by forcing a full resync, itself keyed on the sticky flag). Owed:
  retire the flag with the lease (or re-verify at push time), and a
  test that a post-handover session stops receiving other
  instances' rows. Trigger: Phase 5's grant-scoped read hardening
  (FP2's named follow-up), or the first multi-server lease
  handover work, whichever lands first. DISCHARGED with Phase 5
  (2026-08-14; the delta below carries the evidence — the re-verify
  and the post-handover tests exist, the half-(ii) mitigation
  stands).
- OW23 — unvalidated scope strings reach `resolveScopeKey` with no
  default arm (pre-existing adjacency): the switch covers the three
  `CellScope` members and TypeScript exhaustiveness assumes the
  closed union, but wire-supplied scope strings are not narrowed
  before the call at every site — an out-of-vocabulary string falls
  through to `undefined` typed as `ScopeKey`, silently keying rows
  under an impossible instance instead of refusing. Owed: a default
  arm that THROWS (the fail-closed twin of the session/user arms)
  plus a wire-boundary negative. Trigger: the next
  `key-vocabulary.md` touch, or the first wire surface that accepts
  scope strings from untrusted clients into scoped-row keying.
- OW24 — stream-entry compaction's latent skip-vs-re-execute flip
  (pre-existing adjacency): events §4 allows entries at or below
  `eventWatermark` to COMPACT, and admission's dedupe horizon
  already excludes them — but the serving drain's duplicate arm
  (`space-server.ts`'s already-consequenced-eventId skip) consults
  the STORED log, so the day compaction lands, a reused eventId
  re-admitted above the horizon flips from "skip (its consumed twin
  is visible)" to "re-execute (the twin compacted away)". Which
  behavior is contractual is UNPINNED — events §4's dedupe-horizon
  paragraph sanctions the re-admission without saying whether the
  drain may re-run it. Owed: the ruling (one sentence in events §4)
  and its pin, in the same PR that implements compaction. Trigger:
  the compaction implementation.
- OW25 — the ON-ARM CI SHELL BUILD (the workflow contract's other
  clause, discharged-by-listing in Phase 4): the ON-arm CI lanes
  run the toolshed binary's OFF-built browser shell — the flag is
  an esbuild define burned in at `build-binaries` and embedded via
  `--include`, with no serve-time override — so browser-ON
  behavior (Phase 4's effect channel in a real shell, and every
  later phase's browser-side surface) is CI-UNCOVERED: locally
  full-ON, in CI mixed-posture. The affected test is listed
  (`tasks/server-execution-on-skips.ts`: topics-navigation, red on
  the unmodified Phase-3 base under the full posture). Owed: a
  flag-ON toolshed binary build feeding the two ON jobs (a second
  `build-binaries` invocation with the define env set — contained
  in the workflow, but it flips ~50 browser suites into a posture
  with a known inherited red family, so it lands WITH the triage
  of that family, not before). Trigger: the leg-C ruling landing
  (the inherited red's fix), and no later than the Phase-7 flip
  (a flip criterion measured on a mixed-posture lane would be
  vacuous).
  Phase 7 (2026-08-15, re-tensed 2026-08-16 by the P7 fixer on the
  independent review — the flip landed DARK, constant `false`): the ON
  shell build LANDS as its own CI job, `build-toolshed-on` (the shell
  define baked `true`), feeding the explicit-`EXPERIMENTAL_SERVER_
  EXECUTION=true` ON lanes — the FULL ON posture (server ON, test
  processes declaring ON, shell ON-built), VERIFIED by a posture probe
  before every ON suite (`/api/meta`'s `shellServerExecutionDefine ===
  "true"` from the COMPILED marker + `/api/health/stats`.servingLoop
  present). The default lanes stay the OFF posture (their probe pins
  server OFF + define unset). This row's owed leg is DISCHARGED: no
  ON-lane green rides a mixed posture anymore. The inherited red did NOT
  lift and its attribution is CORRECTED: `cfc-group-chat-demo-two-
  browsers` and `lunch-poll-vote` stall on the UNATTRIBUTED client-side
  scheduler-non-settling loop (OW32; NOT evidenced as OW17 — see the
  correction in OW17), `topics-navigation` fails fast at the
  controller's write-destination validation (`missing required property
  myName`, OW30's class). All three are ON-skip-listed with loud reasons
  (`tasks/server-execution-on-skips.ts`), and the fixer found the skip
  mechanism itself had been INERT since Phase 4 (`deno test --ignore`
  does not apply to explicitly listed files; fixed and pinned — the
  quoted-glob tasks + the pattern shard's `--filter`); no browser-
  posture criterion ticks until OW32/OW30 are triaged.
- OW26 — the DEMANDED-EFFECT retry wedge (scheduler adjacency,
  surfaced by the owner-review P1 batch, 2026-08-12): when an
  `isEffect` builtin's action THROWS (the arms are builtins.md §4's
  navigateTo runtime errors — no-context, sessionless, LT3) and an
  authored input lands in the tight window after the failure, the
  failed action's retry parks idle-blocking and STARVES — no
  further charge ever appears, every subsequent flush exhausts its
  deadline, and the space's W freezes below the new input (observed
  ≥30s with no recovery). DETERMINISTIC for a statically-demanded
  navigateTo (the invalid-pattern shape: the demand persistently
  re-arms the node) and INTERMITTENT for the event-instantiated
  throws (the sessionless test's kick-and-await-W barrier froze ~1
  run in 4 before being reverted to a bounded drain). A throwing
  `computed` under the IDENTICAL schedule does not wedge (charged,
  bounded-retried, W advances in <1s), so the class is the
  demanded-EFFECT retry park, not action errors per se; with
  ≥500ms between the failure and the next input the wedge does not
  arm. Reachable only downstream of a §4 runtime error today, but
  one erroring pattern then degrades the whole space's serving
  (waitForSettled stalls for every session). Original owed: a
  scheduler fix aligning the erroring-demanded-effect posture with
  the erroring-derivation posture (charge, bounded retry, settle),
  plus a regression test racing an input into the failure window;
  the three refusal tests' absence asserts then move from fixed
  drains to the kick-and-await-W barrier that batch had to revert.
  DISCHARGED with Phase 6 (2026-08-14) — the repro was re-run to
  root cause, and every symptom that REPRODUCED traced to the
  OBSERVER, not a scheduler posture gap (one recorded symptom did
  not reproduce at all — the residual below):
  (i) the reverted kick-and-await-W barriers derived their targets
  from `Engine.serverSeq`, which counts the serving loop's own
  derived wave echoes — and coverage NEVER claims a trailing echo on
  a quiet space (the advance is input-driven; `#drainFeed` skips
  self-echoes for `#coverageHead`), so the BARRIER hung, not W's
  contract (deterministic for the fast-settling statically-demanded
  thrower, ~1-in-4 when the echo raced the target read, disarmed by
  a ≥500 ms gap — every recorded arm);
  (ii) "no further charge ever appears" came from the recorded racing
  input writing an UNRELATED doc — the thrower's registered reads
  are path-granular, so it legitimately never re-ran (an input that
  re-points the target re-runs and re-charges it);
  (iii) offset sweeps 0–250 ms (overlapping commits included, 30+
  runs) found NO genuine settled-contract stall: the
  erroring-demanded-effect posture already matches the
  erroring-derivation posture — charged, settled, W covers every
  authored seq. No scheduler change was needed or made.
  (iv — recorded 2026-08-15, from the Phase-6 independent review)
  The original record's computed-control contrast ("a throwing
  computed under the IDENTICAL schedule does not wedge", above) was
  ALSO observer read-timing, not a product asymmetry: the review's
  directed computed-control probe — a throwing `computed` under the
  identical schedule and the same flawed `serverSeq` arithmetic, run
  at both the Phase-6 base and head — froze IDENTICALLY (same
  watermark-only echoes, same frozen wrong-class target, same
  instant coverage of the input's own authored seq). The original
  control's barrier simply read its target BEFORE the trailing echo
  landed. So the two postures are symmetric from BOTH directions —
  erroring demanded-effect and erroring derivation are each charged,
  settled, and W covers every authored seq — which is the
  discharge's central claim; the review's main probe added the
  product-liveness discriminator the original observation lacked
  (during the recorded "wedge" state the product accepts and settles
  a fresh authored input in ~50 ms, at base and head alike).
  RESIDUAL (keep watching): the original record's "every subsequent
  flush exhausts its deadline" was NOT reproduced — it is
  unexplained, not explained: `wavesBudgetExhausted` stayed 0 in
  every armed wedge-schedule state across the root-cause re-runs and
  the independent review's probes (base and head). By mechanism the
  recorded ingredients cannot produce it (an erroring action writes
  nothing, so it cannot re-dirty itself, and budget backoff defers
  invalid actions out of the dirty pull set), and real-load
  exhaustion — normal and benign, observed under the sx2-scale
  flood — is a plausible mundane source of the original observation.
  This row REOPENS if a schedule surfaces where W genuinely stalls
  below an authored seq; the OW26 pin suite in
  `executor-effect-channel.test.ts` is the resurface point.
  (Correction 2026-08-15: this residual previously lived only in the
  Phase-6 PR body — the self-review's claim that the discharge text
  carried it was wrong; the register is the canon and now carries
  it.)
  The obligation's substance landed as: the OW26 pin test racing
  authored inputs into the failure window and asserting
  charged/settled/W-advances directly; the three refusal tests'
  bounded 300 ms drains RETIRED for an await-W barrier with an
  authored-seq target. Standing lesson, binding on test authors: a
  settled-contract barrier targets an AUTHORED seq — never a server
  seq, which derived echoes inflate (protocol §4's client-use
  sentence was always the contract). The barrier is `settleServing`
  in `executor-effect-channel.test.ts`: it drains the client, flushes
  its manager, reads `highestAuthoredSeq` — `MAX(seq)` over commits
  whose class is `authored`, so the class the lesson forbids cannot
  be named — and hands that seq to `waitForSettled`, which sleeps on
  the watermark doc's own subscription rather than polling for it.

- OW27 — LANDED with Phase 7 (2026-08-15; RULED (a) by the owner
  2026-08-15 — "client-side send pacing in the flag-gated append path,
  per-stream token bucket, pace-never-drop"): the client event-append
  queue paces per stream (`EventAppendQueue` — `pacing`, keyed by the
  stream's sidecar doc; burst passes, sustained sends drain at the
  rate, a flood is HELD in that stream's fired order, never coalesced,
  never dropped). Streams are INDEPENDENT — RULED 2026-08-16 (P7 fixer,
  on the P7 independent review's finding 5): the queue sends the
  earliest-fired entry whose stream has a token, so a paced stream
  holds only its own later sends and never an unrelated stream's (NO
  cross-stream head-of-line hold; the P7 build's "accepted cost" wording
  described a defect — the shipped drain sent strictly the fired-order
  head, so b1 waited behind a2's hold, reproduced by the review's probe
  and unpinned by the shipped suite). Fixed red-first: the adopted
  cross-stream test in `event-append-client.test.ts` (b1 sends
  immediately, a2/b2 wait only on their own buckets, a3 on A's second
  refill; every stream's own fired order exact; every intent delivered)
  went red at head and green with the per-stream selection; events.md
  §5 and README §3.8 now state per-stream fired order + independence.
  Default posture
  `DEFAULT_EVENT_APPEND_PACING` = 20/s sustained, 20 burst — a DIAL,
  FLAGGED for the owner (the bound on the flooding user's own rapid
  interactions ≈ (queued − burst)/rate seconds; a held key at ~30 Hz
  is paced to 20 commits/s and clears within half a second of
  release). Pinned red-first in `event-append-client.test.ts`: a 40-send
  key-repeat flood — bounded rate (no 100 ms window above burst +
  rate·window), ZERO loss, fired order — plus the DISABLED-PACING
  mutation witness (`pacing: false` → the flood sends in one tick) and
  close-during-hold (held outcomes settle; the intent stays queued for
  a successor). OFF-arm untouched by construction: the OFF arm never
  enqueues (the fire fork is flag-gated), so pacing has nothing to act
  on there. README §3.8 carries the implementation sentence. Original
  obligation, for the record — the Phase-6 plan bullet's third item,
  FLAGGED as a design fork rather than filled (2026-08-14): README
  §3.8 promises "event floods
  (key-repeat driving `stream.send()`) are rate-shaped at the binding
  layer before they become commits", and under the flag the W4
  last-wins collapse is DISABLED (events.ts gates it off — collapse
  would destroy durable intent ids), so the ON arm currently has NO
  event-flood bound at all; the two shapers that exist do not satisfy
  §3.8 (the scheduler's WakeShaper shapes when patterns OBSERVE a
  commit — after it exists; the UI InputTimingController reduces
  commit volume but is per-component, defaults `immediate` for
  boolean bindings, and is OFF-arm-visible to change). The unstated
  semantics are exactly the escalate-don't-fill fork class: pace vs
  batch vs drop (events are intent — dropping loses it), the hold-
  latency bound a paced send imposes on the flooding user's own
  legitimate rapid interactions, per-stream vs per-space keying, and
  whether UI timing defaults may change (user-visible in BOTH arms).
  Candidate resolutions, costs recorded: (a) client-side send pacing
  in the flag-gated append path (token bucket per stream, pace-never-
  drop — OFF-arm untouched by construction; chooses a latency bound);
  (b) batch coalescing — N held sends commit as ONE authored commit
  carrying N event appends (intent preserved, commit RATE bounded;
  touches fresh Phase-3 admission machinery and the offline-queue
  discharge path); (c) UI-layer defaults (flag-reach into packages/ui
  — rejected shape unless gated). Owed: the owner's semantics ruling,
  then the implementation with its tests. Trigger: before the
  Phase-7 flip (the ON arm ships with no event-flood bound until
  then; W4's cheap guard still bounds the OFF arm).

**Phase 6 (the contract is fixed now, the check lands with
hardening):**

- OW8 — LANDED with Phase 6 (2026-08-14): `noteExecutorCommit`
  classifies derived commits' dirty keys, and the fan-out runs two
  phases per flush batch — every connection's derived-subscribed
  sessions evaluate and send before any bulk-only session (protocol
  §3's implementation-shape note carries the frame/marker rationale).
  The ORDERING half pins deterministically at the unit level
  (`packages/memory/test/v2-push-priority.test.ts` —
  registration-order-adversarial, mutation-probed against the
  reverted split, with vacuous-arm negatives); the COUNTER half rides
  `sx2-scale` (`servingLoop.push.*` present and sane in the ON arm) —
  split deliberately: a live mixed batch needs derived and bulk
  novelty in one flush window, which wall-clock integration timing
  cannot force reliably. Original obligation: push priority —
  subscribed derived rows flush before bookkeeping/bulk (README §3.3,
  protocol §3), counter/ordering assertion in `sx2-scale`.

Delta 2026-08-10 — Phase 3 (events-down, D-v2-1; the phase PR):

- events.md §1/§4/§5, protocol §2's event-append rows: IMPL-GATE rows
  now COVERED by the Phase-3 suites — admission end to end
  (`memory/test/v2-event-append.test.ts`: stamping, disagreement
  refusal, the dedupe-horizon CAS + replay short-circuit +
  at-or-below re-admission, the sidecar write guard, LT1 derived
  carriage incl. the REWRITE arm, delegated stamping, OW15's floor),
  the serving loop (`executor-events-down.test.ts`: the full loop,
  restart exactly-once both directions, error/skip arms, LT1
  same-space cascade, LD1 attribution at cardinality 2), the client
  half (`event-append-client.test.ts` + the inverted F10 pins in
  `speculation-overlay.test.ts`), and the outbox arms
  (`executor-outbox.test.ts`: OW15 delivery, OW14 order).
- NEW implementation surfaces below spec granularity, FLAGGED in the
  Phase-3 PR rather than silently normative: (i)
  `StreamEventEntry.deliveryFailures` — OW14's notice shape on the
  source entry; (ii) the stream-sidecar doc vocabulary
  (`of:stream-events:` + `streamEntriesDocId` — the spec's "stream
  document", concretely: a derivation-owned result doc cannot hold
  durable entries); (iii) LT9's persistence SEAM (the queue rides an
  injectable store whose default is in-memory — the same persistence
  class as `sessionId` today, protocol §5's sessionId persistence
  being pre-existing spec debt; the browser adapter lands with it);
  (iv) same-space emitted entries PROCESS IN THEIR OWN WAVE: the
  batch marks an emitted entry consequenced iff its handler's
  contribution survived the wave (requeued runs leave it unmarked
  for the next drain — C8b/C8d); (v) `runtimeInjectedEventKeys` on
  the entry converts a process-local trust mark into client-asserted
  wire provenance the drain re-mints — threat-model-consistent (the
  client could equally assert locally today) but a WIDENING, flagged;
  (vi) the OW14 notice's CARRIAGE is a direct engine derived commit
  from the outbox (the completion-commit precedent), not a
  later-wave write — flagged with its field shape; (vii) `events.*`
  counter semantics: `processed` counts DRAINED (thrown handlers and
  re-drained requeues re-count), `appended` re-counts scan-covered
  entries across re-activations — gates assert `>=`, never equality;
  (viii) sidecar-log COMPACTION (events §4's allowance) is not
  implemented — the per-wave pending scan and the index-addressed
  consequence marks are both sized by the uncompacted log, and the
  compaction follow-up must revisit the wave's sidecar rebase
  refinement and the drain's index addressing together; (ix) the
  backlog-collapse disablement gates on the FLAG (all events), not
  per-durable-id — conservative (losing collapse loses no intent);
  ledger L8's alternative stays open.
- The engine's per-stream `eventWatermark` is DERIVED state: the
  contiguous consequenced frontier recomputed inside every derived
  commit that touches a sidecar (the model's commit-step rule
  verbatim, INCLUDING its stored-value floor — the recompute never
  lowers the stored watermark, so a lease holder that wrote a
  too-high value is trusted: the single-deriver threat posture,
  protocol §1's accepted-intrusion twin).
- runtime-mapping N26 discharged: the receipt create-only +
  origin-committed precondition mechanisms are disabled under the
  flag (`eventWatermark` subsumes); the receipt VALUE surface and
  `handlingReceiptLink` stay.
- events §2's backlog-collapse disablement discharged (the last-wins
  collapse is gated OFF under the flag; ledger L8's
  collapse-but-list alternative stays open).

Delta 2026-08-10 — the #5569 incremental-liveness catch-up (main
9d6c9fe00 cascaded through the train; one NEW binding sentence, two
re-homed pins from train-deleted test surfaces):

- serving-loop §8's liveness-bracket tripwire: NEW binding sentence
  (any future demand-root kind or root-flipping site MUST bracket its
  transitions with the liveness notifications; no global rebuild
  repairs silent flips — labs #5569). Coverage: the env-gated
  every-mutation equivalence hook in
  `packages/runner/src/scheduler/dependency-graph.ts`
  (`SCHEDULER_LIVENESS_EQUIVALENCE=1`, asserts incremental state
  equals `recomputeLiveRefs` at each mutator exit; run across the
  whole runner suite at catch-up: zero drift, and
  discrimination-verified by reinjecting the historical
  `unregisterDependentEdge` root-writer decrement skip), plus
  `test/scheduler/dependency-graph.test.ts`'s randomized
  every-mutation reference check. Silent-root-flip audit of the
  merged tree found every flip site bracketed
  (`updateSchedulerActionType`, `updateMaterializerRegistration`,
  `setNodeProvisionalDemand` callers; unsubscribe's envelope clear is
  post-unregistration and inert).
- per-doc-rehydration's resume-fresh reliance on scheduler-v2 §5.2's
  registration-recount order-independence: CROSS-REFERENCE recorded
  (a §5.2 recount change is a resume-correctness change). Coverage:
  same instruments as above; resume paths exercised under the
  equivalence hook by the runner suite's reload/resume tests.
- #5388's release-vs-stop pin ("releasing a target before link
  resolution preserves the held start") — its main-side home
  (`reload-rehydration-safety.test.ts`) was deleted with the
  observation machinery; RE-HOMED train-side as
  `packages/runner/test/release-vs-stop-link-resolution.test.ts`
  (green; discriminates — substituting stop for the release fails).
- #5529's verdict-precedes-fan-out — its main-side instrument gated
  `runPostCommitSchedulerSideEffects`, machinery the train deleted;
  RE-PINNED train-side in
  `packages/memory/test/v2-verdict-catchup.test.ts` ("the verdict
  leaves within the transact's publication turn; fan-out cannot
  enter it"), instrumenting the publication turn directly (green;
  discriminates — deferring the in-lock verdict publication fails
  it).

Delta 2026-08-11 — lunch-gate triage leg A: §3d's unstamped-seal
refusal caught real undeclared commit paths (this PR; serving-loop
§7's counter shape gains `unstampedSealRefusals` — a CHANGED
sentence, coverage below):

- §3d's "every server-side commit path declares its run context"
  (RULED 2026-08-05): the RULE was already covered (the Q4 refusal
  row); this delta records impl CONFORMANCE. A three-run
  instrumented triage proved the resumed list builtins'
  container-recovery seeds (`map`/`filter`/`flatMap` resume-seed +
  resume-settle — an out-of-band `editWithRetry` from a `.finally()`
  continuation, no scheduler run around it) sealed unstamped on the
  serving runtime: the wave refused, the seed retried into the
  refusal (97,341 throws in one 5-minute run), and the demanded map
  derivation never landed — breaking speculation.md §4's
  overlay-retirement premise (the serving loop's first-round
  reliability machinery makes the demanded derivation exist and
  land). Fixed by declaring the sanctioned internal `bookkeeping`
  kind at the runtime's posture-gated stamping seam
  (`stampServerRun` — a no-op on the OFF arm; under client
  speculation bookkeeping commits exactly as unstamped txs do), for
  the full audited class: the six list-builtin recovery writes
  (2026-08-13 amendment, review thread r3756175819: the three
  resume-SETTLE writes are bookkeeping ONLY on the serving posture —
  on a flag-ON client they write DERIVED content and now stamp
  `derivation`, diverting to the overlay; the shared decision is
  `resumeSettleRunKind` in resume-republish.ts, unit-pinned; the
  three resume-SEEDs stay bookkeeping on both postures as
  container-materialization, setup-class under the scheduler tell), the
  shared list republisher, the compile-cache writebacks + pattern
  annotation (pattern-manager), the piece
  instantiate/start/repair/run-synced/pointer-roll-forward family
  (runner), the pattern updater's transition writes, wish's
  interval tick / error-UI / sidecar-run / ready writes, and the
  fetch / fetchProgram / llmDialog teardown claims-release txs.
  OW28's compile-and-run completion writes also carry their declared context.
  NOT stamped, per existing rulings: llm partial-stream writes
  (partials never become commits — the serving posture UNDER THE
  FLAG now SKIPS the write before minting a tx, the same ruled
  outcome the refusal produced, keeping the new counter clean; the
  2026-08-13 round scoped the skip to `serverExecution === true` —
  posture alone had dropped OFF-arm partials, an unrecorded OFF-arm
  delta, review thread r3756175835), and llm-dialog's
  pin/unpin/updateArgument/invoke
  tool-call writes (ruled completion-/handler-class — Phase-3
  territory). Coverage: impl-gate, red-first —
  `packages/runner/test/executor-serving-loop.test.ts` ("lands a
  resumed map derivation whose result container was never
  persisted") authors a map piece under client speculation (the
  production shape that leaves the result container unpersisted),
  resumes it through the demand loader, and pins BOTH the landed
  derivation and `unstampedSealRefusals === 0`; at the pre-fix
  tree the same test red-fails (counter at 3, the §3d refusal
  storm in the log).
- serving-loop §7's counter shape: `unstampedSealRefusals` added
  (CHANGED sentence — the refusal becomes a health-stats fact,
  structurally zero under conformance; any non-zero count names an
  undeclared commit path). Coverage rides the same impl-gate
  test's `=== 0` assertion.

This closes leg A of the lunch-gate triage arc (the unstamped
recovery-seed storm). Leg B — the OW19 demand spin
(`structureLoadDeferred` climbing) — is closed by stage P2-F's
demand-cycle terminal state (the closed OW19 row above); leg C
(the speculative-pending-basis design fix) is closed by the
2026-08-13 delta below.

Delta 2026-08-13 — lunch-gate triage leg C: the speculative-basis
export refusal (RULED 2026-08-13; speculation.md §6's "process-local
principle and the export refusal" carries the rule and the owner
blockquote; this PR):

- speculation.md §6's "a commit basis MUST NOT name a speculative
  layer" (the export refusal): → COVERED, impl-gate, red-first.
  `packages/runner/test/speculation-overlay.test.ts` ("an authored tx
  that read a speculative echo is refused LOUDLY at the client")
  drives a real client-flag-ON runtime to a live echo, commits an
  unstamped tx that read it, and pins the terminal client-side
  `SpeculativeBasisError` (isTerminalRejection true), the unchanged
  engine commit count (nothing exported), the intact overlay entry,
  and the never-rendered refused write. At the pre-fix tree the same
  scenario exported the seq and red-failed with the server's
  `ConflictError: pending dependency not resolved: 4` after a wire
  round trip.
- The bounded-and-loud convergence half (the ruling's "fix infinitely
  stuck things"): → COVERED, red-first. The same file's "a handler
  that read a speculative echo fails terminal on the FIRST attempt"
  pins exactly ONE handler run per event (console-channel counting —
  the sandbox globalThis is isolated); pre-fix the backoff loop
  re-ran the handler throughout the observation window (17 runs / 5s
  observed; production shape ~43 attempts / 30.5s to
  CommitConvergenceError). The push-boundary belt (a ConflictError
  naming a known-speculative layer upgrades to the terminal refusal)
  is unreachable-by-construction behind the build-time refusal and
  carries no separate pin — `speculative-basis-exported` in the log
  names any future reach.
- The origin-ack retirement wake (speculation.md §6's closing
  paragraph; the verdict-lifetime sub-defect): → COVERED, impl-gate,
  red-first. The same file's "an entry whose origin's accept verdict
  lands AFTER the covering watermark still retires" scripts the race
  destination-level (watermark event first, ack after; no further
  watermark event) and pins retirement on the ack wake alone;
  pre-fix the entry stayed pending forever (red: the observer was
  never installed and the sweep never re-ran).

One ATTEMPTED-AND-REVERTED fix rides this round, recorded per
flag-don't-fill (review thread r3739139506 — stage D's documented
third bound, the read-only-space seal dependencies): an overlay
implementation of the sealSpaceReads handoff (per-entry read-only-space
floors; retirement additionally gated on EACH read-only space's
watermark; cross-space re-sweeps on watermark/ack/settled events) was
built red-first and REVERTED the same day. CORRECTED RATIONALE (the
revert commit's original "bisect-verified gate regression" claim was
INVALIDATED hours later: the two-browsers Phase-2 gate proved
BIMODALLY FLAKY on the from-source local harness independent of
commit — the UNMODIFIED merge base failed the same "Bob sees Alice"
300s stall twice in a row under clean single-engine fresh-store
conditions, and a runtime-identical tree to an earlier passing
configuration also failed — so the gate discriminates nothing
locally; CI's compiled-binary harness is its arbiter). The revert is
RETAINED on design-risk grounds identified during the investigation:
the machinery makes flag-ON client runtimes open watermark
subscriptions into foreign — possibly unauthorized — spaces reached
through links (AuthorizationError sync-load noise observed), and its
conservative blocking can pin entries on never-covered floors
forever. That risk profile wants an owner-reviewed design, not a
fix-batch patch. The BOUND THEREFORE STANDS as documented: a
cross-space speculation can retire on its written space's coverage
while a read-only input is still uncovered. Owed: the redesign,
flagged for the owner alongside P2-F's follow-ups.

Two adjacency closures ride the same 2026-08-13 round (stage-G
round-2 follow-ups):

- `tryClaimMutex` swallows a TERMINAL claim-commit failure (row only;
  no code change): the claim callback sets `claimed = true`, but the
  surrounding `editWithRetry`'s outcome is not consulted — a commit
  that terminally fails after retries still returns
  `{ claimed: true }`, the builtin proceeds as claim-holder, and the
  effect can complete locally WITHOUT its claim/completion egress
  ever becoming durable. Bounded by design: recovery is §6 step 3's
  re-miss — the next demanded run finds no durable result, re-misses
  the memo, and re-claims (the completed-request guard reads the
  durable view, so nothing wedges on the phantom claim). Recorded as
  a known-swallow with a ruled recovery path; a loud disposition
  (consulting the editWithRetry outcome) is follow-up material, not
  Phase-2 gate material.
- The wave-replay reachability closure (stage-G round-2's flag,
  checked against the spec-model): `applyWaveCommit` runs the
  per-doc CAS re-verification BEFORE `applyCommitTransaction`'s
  replay return, so an exact replay at its ORIGINAL basisSeq can
  never reach replay service — the first application advanced the
  heads past that basis and the re-verification throws
  `WaveCommitConflictError`. Only a re-drive with a RE-DERIVED
  (current) basis reaches the stored-result return (the FP1
  insert-skip's test shape). VERIFIED AGREEING with the spec-model's
  crash-recovery arms: the model's `crash` step nulls the in-memory
  `pendingWave` (nothing retains an old basis), `recover` recomputes
  at current state per the ruled §6 no-replay recovery, and no arm
  re-submits an already-admitted wave — the model never expects
  original-basis replay service, so the engine's reachability
  restriction and the model agree by construction. (The
  admitted-but-unacked re-drive window G's engine test pins sits
  below the model's step granularity — the wave step is atomic
  there; noted, accepted.)

Delta 2026-08-11 — the Phase-3 INDEPENDENT review's fix batch (this
PR; every finding probe- or repro-verified by the reviewer, all
red-first-evidenced where the batch required it):

- M1+m4 — the fail-open sidecar admission CLOSED, both arms, both
  flag postures. Pre-fix, `appendedEntriesOfPatch` and the `set` arm
  coerced a non-array `/value/entries` write to `[]` for validation
  while the write applied VERBATIM: authored garbage ADMITTED with
  zero located entries, then `selectPendingStreamEventDocs`
  TypeErrored in activate/park/drain/wave-close (wedging the space)
  while every honest append hit the garbage in its dedupe read.
  Fixed: `refuseMalformedAuthoredStreamWrites` (engine.ts) refuses
  authored non-array `/value/entries` writes flag-ON, and refuses
  authored sidecar-prefixed writes OUTRIGHT flag-OFF; the pending
  scan, the watermark recompute, and the admission's dedupe read all
  carry defensive `Array.isArray` (derived stays trusted — malformed
  derived state skips instead of wedging). Red-first pinned in
  `memory/test/v2-event-append.test.ts` (the reviewer's repro shapes:
  admit-then-TypeError, the set-arm coercion, the OFF-arm refusal,
  the derived-garbage recompute wedge).
- A THIRD RECORDED OFF-arm acceptance rides the m4 half (RATIFIED
  2026-08-13 — owner ruling: BOTH deltas stand, the both-arms
  non-array refusal AND the OFF-arm `of:stream-events:` id-prefix
  refusal; coordinator-adjudicated 2026-08-11: the defect-flavored
  freedom removed; the OFF-written garbage poisons the ON flip):
  authored writes into `of:stream-events:`-prefixed docs under the
  OFF flag, which formerly SUCCEEDED unvalidated (no admission
  exists OFF — including forged `firedAt` actors that the first ON
  activation would deliver as-stamped), now REFUSE prefix-keyed. No
  legitimate OFF-arm producer writes the reserved prefix; testing
  §2's gate clause already names this register's recorded-acceptance
  rows. The ruling's simplicity lean was applied as a review of
  `refuseMalformedAuthoredStreamWrites` (engine.ts): no
  behavior-preserving simplification was worth taking — folding the
  patch-op arms or replacing the `"entries" in` narrowing changes
  edge behavior (explicit-`undefined` payloads flip from refused to
  admitted), so the guard stands as written.
- M2 — the C8d parent fold WIRED FOR REAL. The fold keyed on
  `context.parentEventId`, which nothing in production set: cell.ts's
  same-wave cascade queued `{eventId, served:{firedAt}}` only, so a
  raced parent's requeue left its cascade child COMMITTED (the
  orphan) and the retry re-applied the consequence under a fresh-id
  re-emission (the double). The emitter's eventId now threads
  end-to-end: `ServedEventDispatch.parentEventId` → the dispatch
  stamp (scheduler/events.ts) → `ServerRunInfo.parentEventId` →
  `#stampRun` → the wave run context. Red-first e2e through the
  WHOLE production chain in `executor-events-down.test.ts` (the
  raced-cascade test: a predicate-scoped settle gate holds the
  sealed wave open, a rival races the parent's consequence — child
  lands exactly once, never doubled).
- M3 (RULED let-stand 2026-08-13; coordinator-adjudicated
  2026-08-11) — the emit-path
  tail-read excluded from the dependency log and basis rows: a
  sender does not re-send because someone else sent. cell.ts's LT1
  emission read `/entries` unmarked, putting the target sidecar in
  the EMITTING run's logged reads and basis rows — a demanded
  derivation emitter re-ran (and re-emitted, fresh eventId) on any
  neighbor's append to the same stream. Classified with the existing
  machinery-read boundary: `ignoreReadForScheduling` +
  `mergeableOpRead` (the Cell.push precedent, paired with the
  already-recorded mergeable append). Red-first pinned in
  `executor-wave.test.ts` (the derivation-emitter test: dependency
  log and §3b basis rows both exclude the sidecar; the write and the
  stamped entry still land).
- C1 — the watermark requeue-hold PINNED at the engine
  (`v2-event-append.test.ts`): mixed consequenced/unconsequenced
  entries at distinct seqs hold the frontier below the pending entry
  and advance through consequenced ones; a same-commit seq group
  advances only together (the `every(consequenced)` clause verbatim
  — the reviewer's delete-the-hold probe now goes red; it previously
  left all 481 memory tests green).
- C2 — the mark-failure ABORT pinned at the SpaceServer
  (`executor-space-server.test.ts`): fault-injected consequence-mark
  failure aborts the handler tx — no unmarked consequence ever
  commits (events.md §4's double-consequence hatch; the reviewer's
  replace-abort-with-continue probe now goes red).
- m5 — the overlay REFUSES an event-handler seal lacking an eventId
  (loud error instead of the silent no-retire divert), the llm-dialog
  tool loop's egress-drop posture is now asserted (both in
  `speculation-overlay.test.ts`), updateArgument's full event-routing
  is owed as OW21, and the pin/unpin completion key carries the
  scopeKeyIdentity caveat comment (llm-dialog.ts) for the day
  `pinnedCells` is scoped.
- m6/n2 — the event-append queue's `#persist` serializes behind the
  PREVIOUS save (an async adapter could complete saves out of order,
  leaving an OLDER snapshot durable) and an enqueue AFTER close
  settles its outcome instead of hanging its barrier (both pinned in
  `event-append-client.test.ts`); the browser-adapter follow-up
  carries the remaining debts as OW20.
- m7 — worker/host flag-posture AGREEMENT
  (`runtime-client/src/backends/runtime-processor.ts`):
  `InitializationData.experimental` now types `serverExecution` (it
  rode as an untyped excess property), and the worker asserts the
  constructed runtime's resolved posture matches the host's
  declaration — refusing initialization loudly on divergence in
  either direction (pre-fix `data.experimental ?? {}` silently
  reverted an undeclared worker to OFF while the host diverted: F10
  alive and dead across realms). OFF-arm-neutral (nothing-declared +
  resolved-OFF agree); pinned in `runtime-processor.test.ts`.
- n3 (recorded note, no mechanism moved): a send from a
  BOOKKEEPING-stamped run on a flag-ON client is silent loss — the
  stamp suppresses the client append (the fire fork keys on "outside
  the scheduler") and no wave carries it. The bookkeeping class is
  the pattern-swap setupTx plus, since the lunch-gate leg-A delta
  above, the audited recovery/writeback family (list-builtin seeds,
  compile-cache writebacks, the piece start/repair family, pattern
  updater transitions, wish tick/UI writes, teardown claims) — all
  CELL WRITES; none calls `.send()` today. The row becomes
  load-bearing the day a bookkeeping path sends on a client; route
  it as an event then.
- n4 — the Phase-3 flagged-surfaces list above omitted one NEW
  below-spec-granularity surface, recorded here: the
  `execution_outbox` EVENT-CARRIAGE MIGRATION
  (`migrateExecutionOutboxEventCarriage`, engine.ts) — three
  additive nullable columns (`target_stream_link`,
  `sessionless_space_scope`, `source_event`) added in place;
  stage-G-era rows predate them, and their NULLs read fail-closed
  (path-less stream fallback at the sidecar id; "not declared" for
  the OW15 carve-out) — the engine.ts migration comment carries the
  same reading.
- n1 — `selectPendingStreamEventDocs`' cost comment corrected: the
  head query is a branch-wide scan filtered by the sidecar prefix
  (LIKE under default collation does not use the PK), run at
  activation, per drain, at park evaluation, and at wave-close — not
  "activation-time, never per-wave".
- n5 — the two Phase-2 ledger lines above that still described the
  inverted F10 pins now carry their Phase-3 supersession inline (the
  named suite asserts the diverted posture since events-down).

Delta 2026-08-11 — Phase 4 (the client-effect channel; the phase PR):

- protocol §5's channel rows now COVERED by the Phase-4 suites: the
  effects-doc engine surface (`memory/test/v2-effects-doc.test.ts`:
  `issuedIn` stamping derived-only, append nonce-dedupe against the
  stored instance with the whole-value-set exemption, per-instance
  addressing at cardinality 2, the retirement scan's
  acked/unacked/stale-mark/malformed arms), and the end-to-end
  channel (`runner/test/executor-effect-channel.test.ts`: the T2
  hops-1–4 served intent with addressing+acting annotations, the
  cardinality-2 multi-hop inheritance pin (a cascade-hop navigateTo
  addresses the CLICKING session; the second session's instance stays
  empty), the T2 hops-5–6 optimistic-enact convergence at ONE
  navigation with the authored ack counted in `effectAcks` and the
  retirement write's addressing-only annotations (T2.Q4), the LT8
  reload journey (re-enact across the reload-wiped record, ack once,
  retire once, nothing resurrects), the sessionless refusal, and the
  LT3 not-connected refusal). T2's Q2/Q3 reference cells carry the
  Phase-4 refreshes (scenario-traces §4).
- NEW implementation surfaces below spec granularity, FLAGGED in the
  Phase-4 PR rather than silently normative:
  (i) the ACK MARK SHAPE — protocol §5's "`{ ackedNonce }`" is
  implemented as per-nonce marks (`acks[nonce] = true`) because a
  scalar last-ack field LOSES an earlier unretired ack whenever two
  intents ack within one retirement interval; was PENDING OWNER
  RATIFICATION, RULED 2026-08-13 — ratified, protocol §5 now
  specifies the map (the T2.Q3 refresh carried the same flag, also
  resolved; the 2026-08-13 delta below);
  (ii) the DETERMINISTIC NONCE constructor
  (`effectIntentNonce(eventId, instanceId)`, wire-shape module) —
  "minted server-side" implemented as a deterministic function both
  sides compute, which is what makes T2.Q7's optimistic enactment
  converge by nonce (the cause-derived-identity convergence
  speculation §2 sanctions); a re-run of either side is idempotent by
  the engine's stored-nonce dedupe;
  (iii) the served half's NO-CONTEXT arm refuses with a WARN instead
  of builtins §4's runtime ERROR: a re-instantiated builtin from a
  past fire (a restart/re-demand replay, whose navigation already
  happened) is indistinguishable from a fresh
  outside-any-event-context computation at the action — the
  ctx-PRESENT error arms (sessionless chain, LT3) still throw;
  flagged, not silently normative;
  (iv) LT3's "connected session of the computing space" is probed as
  a LIVE-SESSION-NOW check (`Server.hasLiveSessionFor` via
  `Runtime.connectedSessionProbe`, installed at activation) — a
  session inside the registry's TTL window counts as connected, which
  is what lets the reload race (fire, reload, intent computes)
  deliver rather than refuse;
  (v) the LT8 reload journey's COLD-PROCESS half (the same sessionId
  re-OPENED from a fresh process) additionally rides protocol §5's
  owed client-side session persistence: the registry refuses a
  token-less re-open by design (anti-hijack), so the persistence
  adapter must carry the resume token with the sessionId — recorded
  on OW20's trigger; the landed test pins the runtime-reload half
  (overlay + enacted record wiped, session persisted);
  (vi) the effects doc joins the never-a-piece id classes
  (space-server.ts): every flag-ON client subscribes to it, and
  piece demand for a value doc that can never carry `patternIdentity`
  meta is the OW19 churn class;
  (vii) the serving replica's scope-NAME-keyed local view (the OW17
  residual) is TOLERATED, never trusted for instance state: the
  served half still READS it, but ONLY as the tail-append base —
  nothing store-visible derives from it, and no suppression
  consults it (the independent review's MINOR-4 deleted the local
  presence gate that suppressed the append on a locally-seen nonce:
  consulting the collapsed view to withhold a store write WAS a
  store-visible derivation, redundant with the engine dedupe today
  and cross-session suppression the day foreign rows land in the
  serving replica) — the intent write is a tail-relative MERGEABLE
  append (only the appended tail crosses; the store applies it per
  instance via the annotation key; the builtin FAILS CLOSED if the
  transaction cannot record the mergeable append) with the ENGINE's
  stored-nonce dedupe as the SOLE idempotency authority, and the
  retirement write's pruned value is computed from
  `selectRetirableEffectsInstances`' engine reads.
- serving-loop §7's `effectAcks` counter is LIVE (the feed drain
  counts authored commits touching the effects doc), so testing §4's
  amplification metric is computable from counters alone — the
  Phase-2 gate's formula gains its subtrahend. (Counting note: the
  recognizer is any AUTHORED commit touching the effects doc — a
  client authoring garbage into its own instance inflates it; the
  notice carries no paths to discriminate by, and the inflation is
  the same self-poisoning class as the instance itself.)
- The Phase-4 SELF-review's fix batch (2026-08-11; every finding
  addressed in the same PR): (1) requeue is now ATOMIC PER
  EVENT at the wave — an event can contribute SEVERAL transactions
  (the handler run + the served intent tx), and the conflict
  closure folds every same-eventId sibling into a requeue, with
  `requeuedEventIds`/`committedEventIds`/`consequenceOf` deduped to
  one entry per event (red-first pinned in `executor-wave.test.ts`'s
  per-event fold test: without the fold, a requeued handler beside a
  surviving intent marks the event consequenced while its
  consequences were withdrawn — lost behind the idempotency skip).
  CORRECTED by the independent review (M2, below): the fold makes
  the ROLLBACK atomic, but it did NOT restore the re-issue — the
  wave-2 re-run re-landed the handler consequences while the served
  navigateTo's closure guard (`navigated`, surviving in the reused
  builtin instance) suppressed the intent forever; exactly-once
  additionally required the store-owned idempotency fix below;
  (2) the overlay records the optimistic nonce BEFORE the flush (a
  slow async navigateCallback left a window where the authoritative
  intent double-navigated within one life); (3) the intent seal's
  resolved-`{error}` outcome is logged loudly (commit promises
  resolve, never reject, on ordinary failure) — the isolated
  failure's input-driven re-land posture recorded there was
  OVERRULED by the owner review (P1-2, below: every seal failure
  now requeues the owning event), and the failures are COUNTED
  (§7's `servedIntentSealFailures`); (4) the
  served-side `navigated` re-run arm returns early instead of
  re-writing the result cell under the wave-level service identity
  (superseded by the independent review's M2: served runs no longer
  consult `navigated` at all — the result-cell read early-returns a
  landed navigation, and the served path still never writes the
  result cell on the wave tx); (5) the no-context refusal arm gained
  direct coverage (the static-wiring test in
  `executor-effect-channel.test.ts`).
- The Phase-4 INDEPENDENT adversarial review's fix batch
  (2026-08-11, the fixer PR-push; reviewed at d28276798):
  (M1) CASCADE-HOP DOUBLE NAVIGATION fixed by suppressing
  cascade-hop optimism — on a cascade hop the client's speculative
  run and the server's authoritative run mint DIFFERENT attempt ids
  (events §4's fresh-per-attempt cascades), and the handler-result
  frame's cause embeds that id (`$event: tx.dispatchedEventId`), so
  BOTH `effectIntentNonce` components (event id AND cause-derived
  instance id) diverge across the twins: no keying scheme can
  converge them, which is also why the review's probe saw two
  DISTINCT targets. The capture is tagged attempt-minted
  (`NavigateEventContext.attemptMinted`, threaded from the
  emitter's eventId through the cascade dispatch on both sides),
  and the optimistic arm refuses to enact an attempt-minted
  capture — first-hop optimism (durable fire id, converging cause)
  is unchanged; the authoritative intent is the cascade hop's ONE
  navigation (red-first: the cascade × capable-client test in
  `executor-effect-channel.test.ts` — two navigations, two targets
  at d28276798);
  (M2) REQUEUED NAVIGATE EVENTS RE-ISSUE: the served arm's
  `navigated` closure guard is DELETED — the builtin instance and
  its closure survive a requeue (runner.ts's cancels-guard reuse),
  so closure state suppressed the wave-2 re-issue; store-derived
  state governs instead (the result-cell read returns a landed
  navigation early, a withdrawn intent reads false and re-issues,
  and the ENGINE's stored-nonce dedupe makes re-issue idempotent)
  (red-first: the requeue-through-the-builtin test — intent count
  0 forever at d28276798, exactly 1 post-fix);
  (MINOR-3) the receipt-race divert is PINNED structurally: zero
  authored-class commits touch the served navigation's target doc
  (the divert-neutralization probe that left the full runner suite
  green now goes red) — NOTE (2026-08-18, the stage-C tuning
  independent review): this pin FLAKES under load, PRE-EXISTING and
  not the tuning trio's — its 20-s `waitUntil` for the served intent
  to land times out at 1-min load ≈ 5 (the fan-out-B base tip 2/20,
  the trio's tip 2/16, ≈10 %); a sweep should read a red here as the
  wait budget, not the divert, until the budget or the wake is
  addressed — CLEARED 2026-09-15, the file's polling helper having
  been replaced by event-driven waits with no budget in them, so a red
  here reads as the divert again;
  (MINOR-4) the `locallyPresent` suppression gate deleted — see
  (vii) above;
  (MINOR-5) same-principal two-session isolation pinned BOTH
  halves: the push half (memory-side, `v2-scoped-push.test.ts`) —
  a derived write into `session:p:s1`'s effects instance delivers
  the frame to s1 and ZERO rows of that doc to `session:p:s2` —
  and the client half (`executor-effect-channel.test.ts`) — s2's
  channel neither enacts nor acks s1's intent, and stays live for
  its own;
  plus: the dispose-order hazard fixed (a runtime's dispose clears
  `spaceOpenObserver` only when the installed hook is its OWN — a
  later runtime over the same manager keeps its channel);
  `servedIntentSealFailures` added to §7's stats; the two engine
  gap arms pinned (`v2-effects-doc.test.ts`: the retirement scan's
  non-session-instance skip; append dedupe consults the OP's OWN
  instance — a space-addressed duplicate is not deduped against a
  session instance, and stamping still applies); the client-half
  convergence assert made unconditional (the channel's
  enacted-nonce count); owed rows OW22–OW25 below.
- The OWNER review's fix batch (seefeldb review 2026-08-12, the six
  P1s; fixer push):
  (P1-1) THE ACK FOLLOWS ENACTMENT SUCCESS (protocol.md §5's
  "enacts, then commits an authored ack write"): the channel
  previously acked unconditionally — before the async
  navigateCallback settled and regardless of its outcome — so a
  failed enactment was acked, retired by the next wave, and the
  navigation lost permanently. Now every ack chains on the
  enactment's outcome (`beginEnactment`: record-before-invoke with
  the outcome attached), a FAILED enactment retracts the
  enacted-nonce record and withholds the ack (the entry stays
  durable and unacked; a later delivery or the LT8 reload re-read
  retries), and the OPTIMISTIC flush propagates its failure into
  the same discipline (the flag-ON flush no longer swallows the
  callback error; the OFF arm's legacy swallow is untouched).
  Red-first: the two enactment-failure tests in
  `executor-effect-channel.test.ts` (throwing-then-recovering
  callbacks; both red at the pre-fix batch — the failed-enactment
  entry was retired with zero navigations). Known residual: a
  failed enactment retries only on the NEXT delivery of the
  instance (no in-life retry timer — protocol.md §5 forbids
  server-side retries and names no client timer; recorded, not
  filled), and a permanently-malformed entry (no stageable target)
  now stays unacked-loud instead of being silently consumed (the
  session-lifetime GC is the backstop) — both residual postures
  RULED 2026-08-13 as the intended contract, now normative in
  protocol §5's failure postures (the 2026-08-13 delta below);
  (P1-2) INTENT-SEAL FAILURE REQUEUES THE OWNING EVENT: an isolated
  seal failure of the served navigateTo's intent tx previously only
  logged — the handler contribution (carrying the entry's
  `consequenced` mark) committed and the event went
  consequenced-clean with the intent lost forever. Now the
  SpaceServer's seal wrapper notes every failed wave-bound seal on
  the wave (`noteSealFailure`, INSIDE the seal chain, so the
  flush's pre-commit `await #sealChain` barrier orders the note
  before commitWave), and commitWave seeds the noted events into
  the requeue set — the per-event fold withdraws the handler's mark
  with the failed consequence, the entry stays pending, the
  re-drain re-runs the event, and the engine's nonce dedupe absorbs
  the re-issue (red-first: the one-shot seal-injection test — at
  the pre-fix batch the event consequenced clean with zero intents
  forever);
  (P1-3) THE NO-CONTEXT ARM RAISES THE §4 RUNTIME ERROR: the served
  navigateTo's no-firing-event-context arm warned-and-returned
  where builtins.md §4 mandates the SAME runtime error as the
  sessionless chain ("Enforce with a runtime check"); it now throws
  like the sessionless and LT3 arms, charged to the run
  (red-first: the no-context test asserts the charge via
  scheduler.onError — no charge at the pre-fix batch). The
  acknowledged costs: a re-instantiated past instance re-running
  after a restart surfaces the same loud error (nothing further is
  lost — its navigation already happened), and the throw is the
  first deterministic thrower on a DEMANDED effect node, exposing
  the pre-existing OW26 scheduler wedge above (as recorded at the
  time; DISCHARGED with Phase 6 as an observer artifact, not a
  scheduler wedge — see the OW26 row);
  (P1-4) the ack WIRE SHAPE (`acks[nonce]` map vs protocol.md §5's
  scalar `{ ackedNonce }`) was PENDING OWNER RATIFICATION — neither
  the spec nor the implementation was touched; the plan doc's
  passage carried the pending marker. RULED 2026-08-13: the map is
  ratified — protocol §5 amended, the plan marker resolved (the
  2026-08-13 delta below);
  (P1-5) the deferred-start stamping (serving-loop.md §3d's sole
  sanctioned internal `bookkeeping` stamp vs the flag-ON client's
  event-handler-stamped navigate-deferred start) was FLAGGED as a
  genuine spec-vs-design contradiction, evidence in the fixer
  report: conforming to §3d's letter (the bookkeeping mutation) is
  exactly the MINOR-3 neutralization and fails the receipt-race pin
  deterministically — the spec edit was the owner's call, not the
  fixer's. RULED 2026-08-13, resolution (a): §3d now carries the
  sanction sentence (boundary named, not exception carved) and the
  runner comments cite it (the 2026-08-13 delta below);
  (P1-6) the shared-manager observer clear was already
  identity-guarded in this batch (NOTE-a above; red-first:
  `effects-channel-dispose.test.ts` fails at d28276798).

Delta 2026-08-13 — the owner ruling batch (P1-4, P1-5, the P1-1
residual postures, and the delegated-scoped-reads deferral; protocol
59 → 61, serving-loop 77 → 78 — the map edited with this delta):

- protocol §5's ack wire shape RATIFIED as the per-nonce
  `acks[nonce] = true` map (P1-4 resolved; the scalar
  `{ ackedNonce }` draft is retired — rationale on the amended
  sentence: a scalar loses an earlier un-retired ack whenever two
  intents ack between retirement observations). CHANGED sentences,
  same rows — the ack-write and next-wave-retirement rules already
  existed; the stale-mark defined no-op and re-ack idempotence are
  stated on the amended retirement sentence. Coverage already
  landed with Phase 4: the engine retirement-scan arms
  (`memory/test/v2-effects-doc.test.ts`: acked/unacked prune,
  stale-mark hygiene, malformed-value skip) and the end-to-end ack
  journeys (`executor-effect-channel.test.ts`). The Phase-4 delta's
  (i) flag, the owner-review delta's P1-4 entry, the plan's ack
  passage, T2.Q3's refresh flag, and FP11's ack-shape half all
  carry the resolution.
- serving-loop §3d's speculative-consequence deferred-start
  sentence (+1 rule): the flag-ON client's `event-handler`-stamped
  deferred piece-start is SANCTIONED (P1-5 resolution (a) —
  boundary named, not exception carved: §3d's refusal machinery
  governs the wave seal destination, which the client's start tx
  never reaches). → COVERED by the landed MINOR-3 receipt-race pin
  (`executor-effect-channel.test.ts`: the bookkeeping-stamp
  mutation fails deterministically — eventEchoSealCount 1 ≠ 2 —
  and zero authored-class commits touch the served navigation's
  target doc). The runner.ts comments now cite the sentence
  instead of claiming an informal "Phase-4 exception".
- protocol §5's failure postures (+2 rules, both RULED): (a)
  failed-enactment retry is DELIVERY-driven and RELOAD-driven only
  — no client-side backoff timers; → COVERED by the P1-1 red-first
  pair (the retry is witnessed arriving with the next delivery;
  the no-timer half is the sanctioned absence, structural in
  `effects-channel.ts`). (b) permanently malformed entries stay
  unacked and LOUD until session GC — no synthesized acks, no
  tombstones; → COVERED by the leave-unacked discipline pins (the
  P1-1 arms; the engine's stale-mark/malformed scan arms) — the
  unknown-kind arm shares the same reconcile skip-without-ack
  path (code-comment-cited); its dedicated client pin rides the
  session-data GC design (scopes §8 item 2), which owns the
  abandoned-instance end state.
- OW13 updated in place with the delegated-scoped-reads deferral
  ruling (no count move — the register row carries the Phase-5
  work-order precondition; see the row).

Delta 2026-08-14 — Phase 5 (cross-space serving; the phase PR;
protocol 61 → 63, serving-loop 78 → 79 — the map edited with this
delta):

- protocol §2's grant-scoped read DESIGN (+1 rule) with its
  FAIL-CLOSED interim (+1 rule) — the RULED 2026-08-13 Phase-5
  precondition, discharged as one stack with the producers: →
  COVERED, impl-gate, red-first. `memory/test/v2-explicit-read.test.ts`
  ("Phase 5" arms, all three red at the pre-change tree): FP2's
  cross-engine widening (a home holder names a FOREIGN space's
  instance under its own space's lease; a lease-less client stays
  refused), the per-process sharpening (a second process's lease row
  admits nobody — full-DR1-holder equality), and the fail-closed
  unnamed-scoped-foreign refusal (a co-hosted serving session's
  unnamed scoped read of a space it does not hold refuses; ordinary
  clients, space-scope foreign reads, and home scoped reads are
  untouched). The producer half is
  `runner/test/executor-cross-space.test.ts`'s provider refusal (a
  serving manager's FOREIGN provider refuses scoped reads; space-scope
  and home and non-serving managers unaffected), refused ENTRY-scoped
  at `pull()` — per caller, before the coalesced watch-refresh batch —
  so one scoped offender cannot poison innocent space-scope foreign
  reads sharing the batch's single pending promise (the review's F3;
  the concurrent scoped+plain coalescing arm is pinned red-first, and
  the batch-level check survives as a loud bypass backstop). The
  unnamed-path check is fully synchronous (the resolved-engine index),
  preserving the ACL revocation-race invariant; its per-query cost is
  one prepared-statement lease probe per open co-hosted engine, only
  for flag-ON scoped reads by principal-bearing sessions.
- protocol §2's read-row Phase-1 recorded acceptance (the
  service-identity-only equality): RETIRED — the sharpened check
  compares the full DR1 holder minted by the co-hosted process
  (CHANGED sentences on the existing row; coverage above).
- serving-loop §3b's server-internal foreign wake (+1 rule,
  impl-gate): → COVERED, with a survival-test finding recorded
  honestly. `executor-cross-space.test.ts`'s wake test pins the
  END-TO-END behavior — a home derivation over a foreign doc
  re-derives on the foreign commit alone (idle window 600 s). A
  host-side fan-out built for the wake was MUTATION-PROBED REDUNDANT
  (the test stayed green with it disabled) and REMOVED: the wake is
  the already-landed chain — foreign session frames → the scheduler's
  autonomous storage-notification runs → the seal's loop wake — so
  the spec sentence is satisfied by construction, not by new
  machinery. Chained-not-yet-applied wave seals now COUNT as work in
  the loop's idle check (the review's F4: a seal chained in a cycle's
  last microtasks was invisible to the contribution count and fell
  back to the idle timeout — latency-only; the level shape was chosen
  over an edge latch after the latch double-counted the loop's own
  mid-cycle watermark seal, caught by the shadow-clamp pin; not a
  guard, so no mutation probe attaches).
  Activation's foreign basis re-mark (§6 step 2's Phase-5 sentence)
  rides `selectForeignBasisRows` + per-space head resolution,
  fail-degrading to surfacing (accounting parity with the home scan;
  recovery correctness rides recompute-on-demand) — and because that
  catch makes breakage invisible by design, the DECISION is
  unit-pinned (the review's F5): `selectForeignStaleInstances` in
  `executor-cross-space.test.ts` — foreign rows only, at-head rows
  never re-mark (the `>=` mutation is red), behind-head rows do, a
  foreign-head move flips an at-head row stale, home-scan findings
  are not double-added.
- serving-loop §3d's accumulation gate (CHANGED — the Phase-5 accept
  posture as an AUTHORIZATION boundary, per the review's F1: carriage
  is minted for every acting run, so an admitted-iff-carriage gate
  authorized nothing): → COVERED. The gate admits iff carriage AND
  the acting identity holds a structural write grant for the TARGET
  space (`Server.foreignWriteAuthorityFor`: owner-by-identity /
  fresh-store creation, DID-shape-checked and probed WITHOUT
  materializing a store (F1c) / the target's own ACL grant,
  mode-independent — no service-DID blanket, no populated-legacy
  compat; fail-closed otherwise), and `foreignWrites: "accept"`
  REFUSES construction without the probe — the vacuous configuration
  is unrepresentable. `executor-wave.test.ts`: full carriage admitted
  with the foreign scoped row keyed from the CARRIED identity (the
  stage-F delegated test, now under the live gate, allow-all probe);
  the UNGRANTED crossing (full carriage, existing no-ACL target)
  refused action-scoped and counted with the actor's OWN home space
  admitted beside it (red under the grant-check-neutralized
  mutation — the pre-fix shape); partial carriage refused at
  ACCUMULATION with the wave surviving vacuous (red under the
  carriage-arm mutation); the probe's own arms (owner / creation /
  non-creating second probe / garbage name / no-ACL fail-closed /
  ACL WRITE grant / no-row refusal) pinned in
  `executor-cross-space.test.ts`; the sink's
  scoped-op-without-carriage refusal re-pinned DIRECTLY as the
  backstop ("Phase 5 backstop" test). The serving loop passes
  "accept" + the memory server's probe (space-server.ts) and resolves
  foreign co-hosted engines ahead of the commit step with PER-SPACE
  failure isolation (the review's F1b: pre-fix an unresolvable
  foreign engine threw out of the cycle — loop-failed → park for the
  HOME space; now the failing space's contributions withdraw
  action-scoped — events requeue, derivations drop — the wave commits
  the rest, counted in §7's `foreignEngineFailures`; the E2E is red
  under the catch-reverted mutation, reproducing park(loop-failed)
  verbatim). Carriage-less and ungranted foreign writes stay counted
  in §7's `foreignWriteRefusals`. Residual recorded (F1c): a
  well-formed FRESH space DID still provisions a store at commit —
  §2b's sanctioned minting (deterministic per-user-per-event ids;
  quota attribution the standing residual, README §3.8).
- builtins §5's wish row (CHANGED — the RULED 2026-08-14
  per-demanding-identity lift): → COVERED, impl-gate.
  `executor-cross-space.test.ts`'s home-space resolution test: a
  stamped derivation resolves the DEMANDING principal's home space, a
  stamped handler resolves the ACTOR's, MIXED carriage (instance
  owner's scopeKeyIdentity + a different acting pair) resolves the
  INSTANCE OWNER (the review's F6 — red under the precedence-swap
  mutation), an identity-less serving run refuses (never the service
  DID), and a client runtime is byte-identical to before. The wish
  builtin's guards ride `homeSpacePrincipalFor`; the sidecar
  compile-cache context is the SERVED space on serving runtimes;
  sidecar result cells AND the builtin's per-node closure caches key
  by the home-space user — PINNED by the two-demander test (the
  review's F2: the closure caches were per-node singles, so demander
  #2 reused demander #1's create surface and clobbered the shared
  pending input; the reviewer's M6 mutation — both keyings reverted
  to the service DID — now fails the test, where pre-fix it survived
  every suite; the suggestion sidecar gains the same per-user keying
  on SERVING runtimes only, client cause byte-identical). The
  lunch-ON gate's profile leg is the E2E witness (the phase PR's
  gates table carries its status).
- OW13 — the delegated-grant RESOLUTION row's Phase-5 PRECONDITION is
  DISCHARGED (the design + fail-closed refusals above, one stack with
  the producers). The row's original obligation — grant RESOLUTION
  against a per-doc grant store, with negative tests — STAYS OWED on
  its original trigger (the store landing); Phase 5's write-side
  carriage is presence+completeness (`capabilityRef` minted
  structurally at #stampRun: `event-consequence:<eventId>` /
  `demanded-run:<principal>`, the FP1 `stream-append:<sidecarId>`
  precedent — a below-spec-granularity surface FLAGGED in the
  Phase-5 PR) PLUS the accept gate's per-TARGET-SPACE structural
  grant check above — space-granular authorization now, doc-granular
  resolution still owed.
- OW22 — DISCHARGED (evidence recorded on this delta; the row's
  trigger was Phase 5's grant-scoped read hardening): the exemption
  re-verifies on CURRENT holdership at every push-path use
  (`#currentLeaseHolderExemption` — Phase 5 widens it to exactly the
  admission's co-hosted condition, full-holder equality), lease loss
  clears the persisted bit, and the post-handover test exists
  red-first ("lease-holder push exemption dies with the lease" +
  the resume revalidation test, `v2-explicit-read.test.ts`). The
  half (ii) wire-upsert scope-name mitigation (forced full resync)
  stands unchanged and keeps its comment. *(Superseded in part by
  fan-out stage A's fix round, 2026-08-17: "lease loss clears the
  persisted bit" is no longer the mechanism — the bit is the session's
  sticky WIRE VOCABULARY (keyed frames for its life; a keyed delivery is
  keyed-retracted), the exemption still re-verifies on CURRENT
  holdership at every push-path use, a lapse is recorded and re-armed on
  the first live pass; the post-handover tests still hold — a former
  holder receives no foreign instance — see OW17.)*
- OW17 — RE-TAGGED with the Phase-5 posture (flag-don't-fill upheld):
  the trigger anticipated foreign scoped instances making the
  replica's scope-name collapse load-bearing; Phase 5 instead
  REFUSES foreign scoped reads fail-closed (the grant-design
  interim), so no foreign instance can enter a serving replica and
  the collapse's exposure is unchanged from P2-F. The owed leg
  (replica-level per-instance read keying + per-(action × instance)
  local precision) now triggers with the grant-scoped read
  RESOLUTION landing — the same work that first admits a foreign
  scoped instance producer.
- LT9 rec (c) — was ADOPTED-PENDING-VETO (the COUPLING SEAM half only:
  `InitializationData.eventAppendQueuePersistence` →
  `resolveEventAppendQueuePersistence` → the manager's
  `eventAppendQueueStore` option); VETOED BY SIMPLIFICATION with the
  LT9 re-ruling (owner, 2026-08-15) and RETIRED in Phase 7 — the seam
  and its tests are deleted (dead weight for a non-goal); OW20 CLOSED
  (see its row).

Delta 2026-08-14 — Phase 6 (push priority, budgets, scale; the phase
PR):

- protocol §3's push-priority row: IMPL-GATE → COVERED. The
  implementation-shape note added to §3 (session-chain ordering,
  two-phase fan-out, whole-frame-at-derived-priority for mixed
  frames, the INV-5 rationale against frame splitting) is +1 binding
  sentence; its pins are the memory unit suite's
  registration-order-adversarial ordering test (mutation-probed
  against the reverted split) and `sx2-scale`'s counter half
  (OW8's row above carries the split rationale).
- serving-loop §5's budget-hooks row: IMPL-GATE → COVERED. The §5
  rewrite (+1 binding sentence set) names the mechanism: outstanding
  cap + egress token bucket as `SpaceServerPolicy` knobs, env-wired
  in the toolshed bootstrap (`SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS`
  default 16, `SERVER_EXECUTION_EGRESS_RATE_PER_S` default unpaced,
  `SERVER_EXECUTION_FLUSH_DEADLINE_MS` for T_flush — the §3 "tuned in
  Phase 6" knob's landing), eager in-flight registration with
  dispatch-only deferral, the sqlite-query LOCAL exemption, and
  drop-on-park. Pins: `executor-outbox-budget.test.ts` (cap + FIFO
  drain, local exemption, token pacing, close-drops — real-clock,
  listed in the preload). NEW implementation surfaces below spec
  granularity, FLAGGED in the Phase-6 PR rather than silently
  normative: (i) the LOCAL_EFFECT_KINDS exemption set (sqlite-query
  is the one shipped non-egress effect kind); (ii) the 16-outstanding
  toolshed default (an operator-tunable production posture, not a
  spec constant); (iii) `outbox.budgetDeferrals` + the
  `servingLoop.push` counter block (§7's list updated).
- The Phase-6 gate calibration (impl-gate, lands with `sx2-scale`):
  the budget-isolation and flat-accumulation gates bind
  noise-tolerant envelopes (absolute ceiling + same-box baseline
  multiple, constants at the head of `sx2-scale.test.ts`) rather
  than the §3.3 300 ms LAN p50, which is a quiet-box number the
  plan's Phase-7 criterion re-measures under the §1 method; the
  cf-checkbox in-suite≈isolated criterion is held as its SUBSTANCE
  (server latency flat as spaces accumulate) measured headlessly —
  the v1 mechanism was never pinned and the browser-context timing
  rides the ordinary suite.
- OW26's discharge and the OW27 flag are recorded in their register
  rows above (§3).

Delta 2026-08-15 — Phase 6 independent-review fixes (same PR):

- OW26's row: the computed-control arm reconciled (observer
  read-timing, probed at base and head) and the flush-deadline
  residual moved INTO the register (it had lived only in the PR
  body); the standing lesson is now pinned in-suite — every
  kick-and-await-W barrier in `executor-effect-channel.test.ts` reads
  its target after the trailing echo, so the `serverSeq` regression
  class is deterministically red (mutation-verified at all four
  barrier sites). (Superseded 2026-09-15: that suite's polling waits
  are gone, and with them the echo reads that armed this pin. The
  class the lesson forbids is now unnameable — see the OW26 row's
  standing lesson for the barrier that replaced them.)
- serving-loop §5's env-knob sentence gained +1 binding clause: the
  outstanding-effect cap's env parse is FAIL-CLOSED (literal `0` is
  the only opt-out; garbage/negative → default 16, warned). Pin:
  `packages/toolshed/lib/server-execution.test.ts`
  (`serverExecutionPolicyFromEnv`; the pre-fix parser mapped garbage
  to unbounded — mutation-verified red).
- §7's `push.*` counters are DEFINED as sessions EVALUATED per group
  (an ordering witness, not delivered frames) — the exported type's
  doc said "sends"; corrected, no counter change.

**Phase 7 (the flip): rows opened by the flip's own gates, 2026-08-15:**

- OW28 — CLOSED: the `compile-and-run` serving port (builtins.md §3).
  Compilation is an accepted outbox effect. The request snapshots the resolved
  program, passes the CFC sink ceiling, and uses the requesting user or session
  instance in its effect key. Completion checks the accepted request marker
  under that same identity and records compilation readiness; the next
  derivation stages child setup and the resolved marker together. Clients
  observe durable outcomes without launching compilation.

  Scoped children retain their deterministic document identity. One piece
  registration owns a node group per canonical program, and instances selecting
  the same program share its nodes. Static child setup and passthrough bindings
  initialize in each actor's transaction while the group retains each child
  once. Selection reads participate in dependencies and basis tracking.
  Program changes, clearing, handlers, resume, and parent release preserve the
  other instances' selected implementations. Keyless
  pointers remain transaction-local until accepted wave settlement. Local-only
  changes enroll their read dependencies even when all storage writes are
  no-ops; selective withdrawal cannot publish a pointer from a withdrawn basis.

  `executor-compile-and-run.test.ts` exercises a real ExecutorHost through
  compiler completion, failure, attached data files, restart, A→B→A
  supersession, and independently reactive user and session instances.
  `builtins/compile-and-run-served.test.ts` covers client observation, CFC
  refusal, abandoned and withdrawn requests, cache recovery, and superseded
  completion, including a completion overtaken by a subsequently withdrawn
  request. Explicit clears work with empty or retained attachment lists;
  partial source hydration preserves the accepted request. The runner's
  scoped-program and keyless-selection tests cover setup rejection, clear
  withdrawal, parent ownership, and keyless swaps;
  `scheduler/guarded-event-handlers.test.ts` covers dispatch selection and
  registration replacement. The family follow-ups below retain their own scope.
- OW28-createRef — CLOSED: program-value hashing at the compile-cache boundary.
  `PatternManager.compileOrGetPattern` snapshots the complete resolved program
  with `snapshotQueryResult` and uses that same detached value for its key and
  compiler input. Requests with and without a space use separate cache entries.
  With CFC enforcement, concurrent requests share compilation across spaces and
  register closure replication into every requested space; replicated data
  files retain their compiled-cache data marker. With CFC disabled, requests
  share compilation without scheduling closure replication.

  `pattern-manager.test.ts` proves that a same-cell program edit selects the new
  contents, identical content shares a result across addresses, and a delayed
  compile retains the program's source and options. `compile-cache-space-aware.test.ts`
  proves a fresh runtime loads a follower space's piece and attached data
  from the compiled cache, with recompilation refused, for persistent and
  source-only pending/cached leaders. It also proves concurrent and cached
  CFC-disabled calls share compilation without issuing replication. This cache
  boundary is shared by OFF and the served compiler; closing it does not
  discharge OW28's serving port.
- OW28-supersession-family — PARTIALLY CLOSED: served `llm`, `generateText`,
  and direct `generateObject` accept unqueued completions by the selected
  request hash in the resolved output instance. Returning from A to B to A while the original
  A remains in flight attaches to that A through outbox deduplication; a local
  run generation does not discard its result. A pending request hash is a
  selection marker, not a settled memo hit.

  `executor-llm-supersession.test.ts` drives controlled responses through a real
  serving host and outbox, covering A→B and A→B→A, stale responses, model errors,
  and suppression of durable partial writes. `llm-served-lifecycle.test.ts`
  covers withdrawn contributions, reissue after withdrawal, and initial and
  superseded dispatch refusals, including the result announcement. It also
  proves space→user→space result rebinding with serving both on and off,
  retirement of settled state, retention across uncommitted staging, and
  delayed refusals after withdrawal or instance retirement. It also covers
  refusal of a duplicate accepted request, accepted memo/empty publication
  superseding an older scope, per-binding announcement ownership for a shared
  result, bounded retry ownership, and OFF/served queue completion parity.
  The shared-result binding checks observe the raw publication callback;
  the host suite separately proves durable user/session result isolation.
  These direct-provider controls do not establish shared tool-loop or other
  effect-family supersession.

  `executor-llm-dialog.test.ts` separately covers served dialog turns in space,
  user, and session instances, including two users and two sessions, isolated
  cancellation/replacement, stale replies, model errors, and a `presentResult`
  roundtrip whose next model request includes the committed tool messages.
  `llm-dialog-served.test.ts` covers initial refusal, refusal after a scope
  change, physical binding ownership across actors, distinct bindings sharing
  a result, withdrawn cancellation/publication, scope return with execution on
  and off, accepted outbox ownership, release rejection, teardown failure
  isolation, and error-write lifetime. The raw actor cases assert publication
  callbacks; the host suite establishes durable actor isolation. Dialog
  cancellation waits for commit and wave acceptance. Those controls establish
  turn lifecycle; they do not establish actor isolation for every management
  tool or the shared direct-LLM tool loop. The remaining surfaces are
  investigation obligations, not claims that every caller has the same failure.
  `llmDialog` captures the issuing handler identity for postcommit transcript
  reads, claim guards, and completion writes. Its active turns are partitioned
  by resolved result instance, with finite cell bundles per symbolic scope;
  completed turn records retire. `executor-llm-dialog.test.ts` proves one- and
  two-demander turns and absence of a service-instance result. It does not
  exercise management-tool read partitioning or the integrity gate's acting
  principal.

- OW28-instance-family — PARTIALLY CLOSED. Served `compileAndRun`, the
  shared `fetch.ts` builtins (`fetchText`, `fetchBinary`, `fetchJson`, and
  `fetchJsonUnchecked`), `llm`, `generateText`, `generateObject`, and
  `sqliteQuery` pass the requesting identity to `effectTargetKey`.
  Fetch keeps its request id, cancellation, and abandonment state per resolved
  scope instance. Its claim, result, error, abandonment, and teardown reads use
  that same identity; an authoritative claim records its validated input hash
  with the claim id and activity timestamp. The `fetch-served-instances` tests
  pin user/session key separation and sharing at the declared scope.
  `executor-fetch-instances` pins a service-identity host with one requester,
  two users, two sessions, and one request superseding or failing while the
  neighboring instance completes independently. Idle and completed instances
  retire without accumulating graph cleanup callbacks; a returning session
  can issue again, and graph stop still aborts a pending owner. Direct staged
  tests pin equivalent-request retirement, late-refusal ownership, and each
  issuance's representative identity while an earlier request is held. Refusal
  publication tests cover scope changes, shared results across distinct output
  bindings, memo and empty results, and withdrawn waves; output binding
  publication is independent of ownership of the request's result fields.

  LLM lifecycle state is partitioned by the resolved output instance, and
  completion reads bind that identity before checking the selected request
  or its live input label basis. `served-llm-instances.test.ts` covers
  deterministic same-user keys, separate user/session keys, and two users
  sharing one builtin closure. `executor-llm-supersession.test.ts` covers
  concurrent responses landing in distinct user and session instances, with
  no service-instance result.

  Non-clearance `sqliteQuery` uses the resolved result instance for outbox and
  in-flight RPC identity while preserving reader-independent query hashes.
  `sqlite-served-instances.test.ts` covers independent user/session completions
  and refusals, a captured result target across scope changes, shared results
  across distinct bindings, memo selection, and withdrawn publications.
  `executor-sqlite-instances.test.ts` drives a service-identity host with one
  requester, two users, and two sessions against a space database, including
  reverse completion order. These controls rely on the storage replica
  promoting every accepted same-sequence contribution; they do not test which
  user/session database file the provider reads.

  `fetchProgram` captures the requesting identity for its cache-instance key
  and asynchronous claim, completion, refusal, and teardown reads and writes.
  It retains accepted requests before dispatch and one controller per dispatched
  resolution. `executor-fetch-program-instances.test.ts` covers space, user,
  and session completion, two users, two sessions, reverse completion order,
  isolated errors, A→B→A with both URLs retained in the cache, and teardown
  despite one cleanup failure. `fetch-program-served-lifecycle.test.ts` covers
  stop before dispatch, rejected release checks, late publication acceptance,
  shared physical bindings across actors, independent bindings sharing a pending
  result, stale-peer takeover after refusal publication, and withdrawn
  publication. A refused request may publish its binding without owning the
  resolution represented by a peer's cache claim. These controls exercise local
  program responses; cancellation of resolver network requests remains separate.
  Same-binding retry controls hold the original refusal until the retry commits
  or withdraws: only accepted publication suppresses the earlier announcement.
  They also cover an accepted different target between retries and preservation
  of accepted-target visibility after a refusal write fails.

  The program lifecycle controls also admit duplicate accepted contributions
  through the real `SpaceOutbox` under a held dispatch budget. A release refusal
  selects a surviving accepted attachment; refusing every attachment releases
  the claim. Component handoff controls also admit immediately after real wave
  settlement, before runtime-wide settlement, and cover one surviving attachment
  and complete refusal. The serving loop waits for wave settlement before
  admitting its effects, so publication acceptance precedes release checks.
  `executor-outbox-budget.test.ts` covers the selected run context,
  readable-completion deduplication, immediate re-admission after all refusals,
  and the absence of fallback after a dispatched request fails.
  `cfc-sink-release-reject-surfaced.test.ts` checks that inline release refusals
  increment refusal statistics without counting an effect as flushed.

  `memory-v2-wave-promotion.test.ts` covers the storage boundary those completion
  guards depend on: all accepted contributions to one document at the same wave
  sequence remain visible after settlement, across space, user, and session
  instances. Noncommutative appends retain sealing order between local verdicts,
  including when the reader excludes speculative pending layers. Authoritative
  frames prevent replay of accepted contributions, and withdrawing an earlier
  pending layer preserves already accepted sibling operations.
  A received acceptance records its sequence before promotion resumes, so a
  confirmed view covering that sequence does not replay the pending operation.
  Frames alone do not prove coverage of unresolved or later-wave receipts;
  those operations and speculative neighbors remain visible. The storage
  controls cover both receipt/frame orders, cached reads, and notifications.
  Real wave and engine controls cover consecutive home waves and foreign
  contributions grouped by actor and grant: accepted verdicts follow each
  space's server sequence, retaining sealing order within a batch. Nonadjacent
  contributions sharing a foreign batch produce the same settled value in the
  replica and engine, while delegated user instances remain separate.

  Standalone effect completions join the serving loop's own derived tail for
  the drain-settle watermark advance. `executor-settle-advance.test.ts` covers
  a completed request while another accepted request remains unresolved,
  with an empty-completion control that creates no commit, a divergent client
  overlay, and a completion arriving during an older advance's seal. The
  completion itself retains the current watermark; a later quiescent cycle covers its
  sequence without requiring another authored input.

  Remaining investigation obligations include shared tool-loop LLM requests
  and provider/tool READ partitioning. Caller-specific coverage and residuals
  are detailed in this row and OW53 below. OW53's SQLite acting-identity,
  owner, and clearance fixes remain closed. Owed: one- and two-demander
  request/completion regressions for remaining callers, without reopening
  covered cases or counting compile coverage twice.

  Child-input default creation is covered separately from builtin instance
  identity. `executor-compile-and-run.test.ts` passes uninitialized
  `PerUser<Writable<number | Default<0>>>` and `PerSession` inputs to static
  and compiled children, then dispatches their handlers under separate users
  or two sessions of the initializing user. Argument setup creates missing
  declared scope redirects through whole-object input references.
  `scoped-input-initialization.test.ts` preserves explicit values and
  references, including references to missing targets, and rejects
  initialization that races with an explicit write.
  `scoped-default-writable.test.ts` covers direct projection of an absent
  defaulted slot, its write destination, and its dependency behavior.

  Later-user session initialization is covered by the static and compiled
  child host cases: the first user changes a missing or seeded `PerSession`
  input, the serving runtime reloads, and two later sessions of another user
  independently update their child inputs. Automatic space-to-user links carry
  a non-addressing `scopeInitialization: "session"` declaration. A graph-owned
  action discovers demanded user instances through reads and initializes only
  absent continuations, after loading the actor's user document. Explicit
  same-address reference replacement survives reload and keeps the later
  user's sessions sharing their user input; the first user's initialized
  session value remains intact.
  `scoped-session-initialization.test.ts` covers declaration preservation and
  removal, raw copies, modern and legacy wire forms, unchanged cause identity,
  CFC integrity filtering, explicit values and undefined ancestors, and a
  conflicting explicit replacement. Unmarked stored links remain conservative:
  they are not automatically migrated based on pointer shape. The caller-driven
  rematerialization path and this compatibility boundary are specified in
  [scoped cell instances](../scoped-cell-instances.md).
  `scheduler-wave-withdrawal.test.ts` covers a pure leaf reader whose result is
  withdrawn even though rollback preserves its input value, plus accepted,
  canceled, superseded-run, equal-value no-op, partial no-op, write-free local
  acceptance, abandoned-wave, and direct output/precondition/foreign-failure
  controls. Held bodies and seals cannot transfer retry obligations to a new
  registration; departed or replacement scoped instances cannot be revived.
  A replacement that reuses a pending output acquires its own write-free
  acceptance obligation; verifier probes and non-derivation no-ops remain
  excluded. A runtime settlement wait begun before the wave resolves observes
  withdrawal recovery before returning. A shared-space trigger control retries
  only the withdrawn user instance while preserving its CFC trigger metadata and the accepted sibling.
  `storage-write-elision-provenance.test.ts` covers raw value, deletion, and batch
  elision over pending state, internal read classification, confirmed-only and
  own-unsealed-only controls, conservative replacement over an older pending
  document, and the UI-blind and foreign read-only boundaries. The serving fan-out
  storm case retains its original initial-convergence and bounded-wave
  assertions while session-slot initialization races authored writes.

- OW29 — space-root demanders + demand-arrival re-runs (the reverted
  Phase-7 extension recorded under OW17): a client whose only watch is
  the space-scoped piece root supplies NO identity to the run supply,
  and a clean action never re-runs for a newly arrived instance. Both
  are needed for a second user of a shared space to be served at all;
  both are GATED on OW17's replica per-instance keying (without it they
  turn silent under-serving into a wave storm). Land the three
  together. Trigger: OW17. The demand-root CHAIN'S coverage folds in
  here (P7 independent review finding 4, 2026-08-15): the chain
  (`demandRootIds`) covered nested pattern nodes and result-as-pattern
  children but MISSED the list builtins' child instantiation
  (`builtins/map.ts`, `filter.ts`, `flatmap.ts` call `runtime.runner.
  run` directly) — a mapped child's derivations ran with the service
  fallback while the parent's `raw:map` ran per instance (probe:
  alice=0 bob=0 fallback=2), so any per-user state inside a list item's
  sub-piece was mis-keyed under `user:<serviceDID>` at cardinality 1
  too. FIXED by the P7 fixer (2026-08-16): the six list-builtin sites
  pass `parentPieceRootId`; red-first via the adopted probe,
  parametrized over map/filter/flatMap in `executor-run-supply.test.ts`
  (mutation-verified per site); the grandchild-composes probe pinned.
  STILL OPEN, FLAGGED (not filled): wish.ts's four `runtime.run`
  sidecar launches (profile create / picker / suggestion) also carry no
  parent — the served sidecar's own actions run under the wave-level
  identity — but chaining them to the wish's parent root would run each
  per-demander sidecar for EVERY demanded instance of the outer root
  (bob's run over alice's sidecar; spurious per-user writes under bob's
  key), and whether a per-demander sidecar wants the chain's instances
  or exactly its own demander is an UNSTATED semantic — owner ruling
  needed before it is wired.
  **DIRECTION VINDICATED, storm cut PINNED IN THE HARNESS; a lunch
  residual stays OPEN (fan-out stage B, 2026-08-17; wording corrected on
  the independent review's F4).** Both extensions landed on stage A's
  instance-keyed replica: space-root demanders (every demanding pair
  recorded on every root; the walk and the supply per demander) and the
  demand-arrival re-run (the arrival re-arm). The 4,427-wave storm's
  cycle — N instance runs writing one collapsed local doc + patches
  diffed against a sibling's value — is pinned UNBUILT in the HARNESS:
  `executor-fan-out.test.ts` (i) — two users, 20 divergent authored
  edits each, waves ≤ 2·edits + 8, quiescent after the last edit (the
  loop suspends on its input wait with its runtime settled, which a loop
  whose cycles keep finding work never does), zero
  `wave-commit-rejected … missing path`, neither instance ever holding
  the sibling's value. But "UNCONSTRUCTIBLE
  now" OVERCLAIMED against the LIVE gate: the independent review's
  lunch run 4 still showed a churning serving loop (331
  `wavesBudgetExhausted`, `wave-commit-rejected … path is not
  traversable at /value/children/2/children/0` ×5) under ON — a
  transient patch-vs-wrong-base race on a `computed:` VDOM. The fixer
  pass did NOT reproduce that on its own ON binary (fadc2efb1b): lunch
  runs 1–2 show `wavesBudgetExhausted` 66–90 (well below run 4's 331)
  and ZERO `wave-commit-rejected`, so the storm cut holds far better
  here than the review's snapshot — plausibly helped by F1's
  RetryImmediately bound removing one hot-loop source — but the residual
  is not PROVEN gone at the live gate, so the honest disposition is
  "storm pinned unbuilt in the harness; a live churn residual of open
  attribution, unreproduced at the fixer's binary". The wish-sidecar
  chain is WIRED per the panel's Lens 5 (the sidecar's actions carry the
  outer root and run as demanders) but its runner-suite pin is OWED
  (review F3 — it needs the sidecar to RUN, which does not complete
  under the suite's fake clock; the per-demander pin stays FLAGGED, OW17
  residual viii). The lunch gate STAYS SKIP-LISTED with the residual
  named below.
- OW30 — PARTIAL: controller write-destination validation under ON.
  Stream sends validate their event payload against the producer-owned event
  contracts, but do not stage or validate the unchanged producer root.
  `piece-controller.ts` guards `validateDurableSourceRoots` with
  `issue === undefined && !isStream(txCell)`. The regression in
  `packages/piece/test/pull-materialization.test.ts` sends a valid Stream
  event past an invalid producer sibling and still rejects an invalid event
  payload. This closes the Stream sibling-validation defect.

  The Topics navigation test's separate barriered capture closes its flake
  and its ON skip is lifted (OW33); the unresolved echo behavior is OW60.
  Neither result establishes closure of the non-Stream counter observation
  ("current producer value is not accepted as an array container"). Owed:
  reproduce and attribute that served/speculative destination-shape case,
  then pin the required convergence behavior. A blanket pre-validation
  `waitForSettled` is not implemented and should not be treated as an already
  established fix. Trigger: a non-Stream destination-shape refusal during
  ON testing or renewed soak.

**Rows opened by the Phase 7 independent review and the fixer pass
(2026-08-15/16; the flip landed DARK — constant `false`):**

- OW31 — the service-principal READ-AUTHORITY grant is a WRITE-AUTHORITY
  WIDENING for the process identity's ordinary session traffic (P7
  independent review finding 6; the P7 build's "NOT a write widening"
  was overstated). Under the flag `memoryServiceDidsFor` makes the
  toolshed process identity a memory service principal, and a service
  principal is implicit OWNER for its sessions on EVERY space
  (`packages/memory/v2/server.ts` — transact, queries, watches, ACL-doc
  writes, fresh-space genesis; the ACL policy has no read-only service
  class). So the process identity's ORDINARY session traffic — its own
  `productionServer` runtime (ingest / webhooks) and the loopback
  plane's authored/bookkeeping commits — gains OWNER everywhere,
  wherever `MEMORY_SERVICE_DIDS` did not already list it. Bounded by
  process trust (the same process already derives every space through
  the engine-direct sink) and NOT widened at the wave's foreign-write
  accept gate (`foreignWriteAuthorityFor` ignores the blanket). What the
  wish's bootstrap NEEDS is READ on the demanding user's home space; the
  narrower shape — a read-only service-principal class in the memory
  ACL — is a memory-ACL POLICY addition, and whether it suffices depends
  on what the served create handler's `.inSpace()` provisioning needs at
  fresh-space GENESIS (a service DID may initialize a genesis ACL; a
  read-only principal could not). RULED-POSTURE ITEM FOR THE OWNER:
  accept the OWNER-everywhere posture under the flag (the deployment
  checklist's operator-DID posture made automatic where the loop runs),
  or add the read-only class and route the wish's read through it. Not
  narrowed by the fixer (flag-don't-fill). Inert while the constant is
  `false` (the grant is flag-gated; OFF the configured list is used
  verbatim). Trigger: before the flip PR.
  **RULED 2026-08-18 — the write-authority posture; implementation
  OWED post-merge, BEFORE the flip PR; OFF-invisible.** Owner,
  verbatim intent: toolshed's serving identity (a generic one, not
  user-specific) must NOT be used to write into users' home spaces;
  the USER's identity does — for wish provisioning and `.inSpace()`
  genesis; the service principal is not an implicit OWNER of users'
  spaces. Genesis shape, ruled: "the new space's own keys can be used
  for the genesis transaction, immediately delegating owner to the
  acting user (so that first commit happens under the space's own
  identity, the rest is then the user's)." Scoping report (the
  evidence, work order and proposed spec text):
  [`stage-c-ow31-scope-report.md`](../../history/plans/server-execution-v2/stage-c/stage-c-ow31-scope-report.md).
  Findings, as they bear on the build: (i) served home-space WRITES
  ALREADY ride the delegated path under the acting user — the wave's
  accept gate ignores the service-DID blanket and the engine sink
  carries `delegated{actingPrincipal, capabilityRef}` — so the ruling
  was the architecture's intent, honored for every write but one;
  (ii) the ONE defect is the `.inSpace()` genesis ACL's CONTENT, which
  names the SERVICE as OWNER (`registerSpaceIdentity` in
  `packages/runner/src/storage/v2.ts` — the bootstrap session signs as
  the space, but `signer` = the
  manager's `as` = the service on the loopback plane), so a served
  create mints a service-owned space — or an ACL-less one when the
  sink's data commit wins the race with the mount's genesis; UNPINNED
  today; the fix is `registerSpaceIdentity(identity, { owner:
  actingUser })` threaded from the serving-side `resolveSpaceName`
  (a serving runtime with no actor REFUSES to register), the genesis
  forced BEFORE the sink's data batch for every `creation`-granted
  foreign target, and the sink refusing a foreign batch into a
  seq-0 / no-ACL engine (INV-13 mirrored on the engine-direct plane);
  replay-idempotent, because actor and keys are both functions of the
  creation event (CT-1650 + the event's stamped `firedAt.user`);
  (iii) the READ side: removing the OWNER blanket with no replacement
  makes `session.open` deny the serving runtime on EVERY owner-only
  home space — under ON, where clients do not commit derivations,
  every private-space piece stops deriving — so a READ-ONLY SERVICE
  CLASS in the memory ACL policy (`acl.readOnlyServiceDids`: a READ
  floor, never WRITE or OWNER by that class, never a genesis
  initializer; ON: the process identity; OFF: empty) is the
  scoping report's RECOMMENDATION on file — SUPERSEDED by the READ
  ruling below (RULED 2026-08-19: ACL-only service reads); (iv)
  flagged residual for the
  owner's eye: the genesis ACL's `"*": WRITE` wildcard (the client's
  own rollout default) leaves the service — and every authenticated
  principal — with WRITE on the new space via the wildcard; "the user
  is OWNER, the service is not" holds, "the service cannot write P"
  does not follow, and narrowing the wildcard is a separate policy
  question. Pins for the build: "a served `.inSpace()` genesis: actor
  = the space DID, ACL owner = the acting user, the service principal
  appears nowhere in the ACL, and the space's commit #1 IS the ACL
  commit"; "the service principal cannot write into a user home space"
  (session plane refused under `enforce`; a carriage-less wave write
  refused at accumulation; a carriage-bearing write acting as another
  user refused on the `acl` arm); a creation-granted foreign batch
  never lands before the genesis; kill/replay between genesis, data
  and home commits converges on ONE user-owned ACL; and the served-wish
  + lunch gates as acceptance (no `lacks READ` in the toolshed log,
  `foreignWriteRefusals` 0, a store dump with no `of:<P>` owned by the
  service DID; an `observe`-mode canary counting the process
  identity's write would-denies — expected 0, any non-zero names a
  residual to re-route). Guard against creep: the OWNER-class list
  stays operator-configured; if a future stage needs the process
  identity to WRITE over the session plane, the answer is a
  wave-stamped path or an explicit grant, never re-adding it to that
  list. Does not gate landing the stack OFF (the grant is flag-gated;
  OFF the configured list is used verbatim); the flip PR's gate reads
  against the built posture.

  **READ side RULED 2026-08-19 — service identity reads the ACL ONLY;
  every other served read runs under the USER's identity.** Owner, in
  chat:

  > ACL can be read with service identity, but all other reads must
  > be user identity (but if this is wrong, flag for follow-up work
  > after merging to main if criteria succeeds)

  — owner (Berni), 2026-08-19. This rules the read side and
  SUPERSEDES the scoping report's read-only-service-class
  recommendation (finding (iii) above; `acl.readOnlyServiceDids` is
  not taken — the report stays as the evidence and the history): the
  service identity may read a space's ACL, and EVERY OTHER served
  read — `session.open` on a user's home space included — runs under
  the acting USER's identity, mirroring the ruled write posture's
  delegated carriage. Escape hatch, per the ruling's own words: if
  this proves wrong during the OW31 build, FLAG for follow-up work
  after merging to main (the merge happening if the confidence
  criteria succeed) rather than blocking on it.

  **BUILT 2026-08-21 (the optimize-on-main train; build report:
  `docs/history/plans/server-execution-v2/optimize/ow31-build-report.md`).**
  What landed, per the recorded work order:
  (a) **genesis owner = the acting user** —
  `registerSpaceIdentity(identity, { owner })` threaded from the
  serving-side `resolveSpaceName` (the acting principal read from the
  frame tx's wave run context WITHOUT the read-scope-ratchet side
  effect, F8); a serving runtime with no actor REFUSES to resolve;
  the bootstrap ACL's non-home arm names the registered owner
  (`{ [actor]: "OWNER", "*": "WRITE" }`), the home arm and every
  client byte-identical. Pins: `memory-v2-acl-bootstrap.test.ts`
  (red-first: the pre-fix run minted `{ [service]: "OWNER" }`),
  `executor-cross-space.test.ts` (the serving no-actor refusal).
  (b) **genesis before data** — the wave retains the grant probe's
  `via` per (space, acting) and the commit step forces
  `ensureSpaceInitialized` for every `creation`-granted foreign
  target before the sink applies; the sink refuses a foreign batch
  into a seq-0/no-ACL engine (INV-13 mirrored on the engine-direct
  plane; red-first: the pre-fix sink landed the batch in a fresh
  store). Kill/replay converges on ONE user-owned ACL (the replay
  grant resolves `acl` through the owner; `executor-wave.test.ts`'s
  OW31 pins, including the actor-=-space / owner-=-acting-user /
  service-nowhere / commit-#1-is-the-ACL shape).
  (c) **the READ posture** — the OWNER blanket is RETIRED:
  `memoryServiceDidsFor` became `memoryAclPrincipalsFor`
  (`serviceDids` = the operator list verbatim on BOTH arms — the
  absolute pin "under ON the process identity is not an OWNER-class
  service DID by default" is in `server-execution-flag.test.ts`;
  `delegatingDids` = ON: the process identity, OFF: empty). A serving
  manager's session mounts carry `actingAs: "space-owner"` (signed
  into the session.open descriptor); the memory server admits the
  marker for delegating-class envelopes only, resolves the space's
  ACL owner ITSELF (the ruled service-identity ACL read), and the
  session's READ-class decisions run as that user — WRITE/OWNER
  requirements stay on the envelope (no session-plane write path; the
  observe canary counts residuals — `v2-server-acl.test.ts`'s OW31
  pins, mutation-witnessed), a delegating principal cannot initialize
  a genesis, revocation judges the acting user, and the lease/read-row
  /scoped-read machinery (which keys on the envelope) is untouched.
  (d) **seat S-A** — the cross-space `compile-cache/writeback` rides
  the TRIGGERING run's §2b carriage: `ServerRunInfo.delegated`
  (an explicit carriage for the bookkeeping-kind materialization
  family), stamped verbatim by the SpaceServer's stamper and threaded
  through `replicatePatternToSpace` from the instantiating run's wave
  context — attached only when the target is FOREIGN to the serving
  home space; carriage-less foreign writebacks stay refused
  (fail-closed pin + mutation witness in
  `executor-cross-space.test.ts`). The carriage arm was NOT wrong at
  writeback time for the observed defect class — the trigger
  (`instantiatePatternNode`, CT-1687) has the provisioning run's
  carriage in scope, and the client precedent is exact (the program
  commit is the user's own session client-side) — so the system-class
  alternative was not needed for this class.
  RESIDUALS, flagged (see the build report's running list): (i) the
  `"*": WRITE` wildcard residual (finding iv) STANDS — pinned live in
  the executor mutation test: a mis-threaded genesis owner is visible
  in the ACL content while the wildcard still grants the write;
  narrowing it is the separate policy question. (ii) the
  `loadPatternByIdentity` repair path and `compilePattern`'s own
  persist do not carry the carriage (no run context is reachable at
  those triggers today) — their foreign-write case stays fail-closed
  refused; if live gates surface residual refusals from them, that is
  the named follow-up, not a re-widening. (iii) CFC AUTHORSHIP LABELS on served rows carrying the SERVICE
  signer (the runtime-level ambient trust snapshot, not this build's
  memory-plane carriage): CLOSED-BY **OW59** (2026-08-21, the
  OW34-family implementation train — per-run trust snapshots attached
  at the SpaceServer's run stamp; design RULED 2026-08-21). The
  cfc-group-chat-demo lift rode that train, not this build. (iv) the ruled
  ACL-only-read allowance is exercised as the server-side owner
  resolution at session.open; no raw ACL-doc query surface was built
  (nothing needs one — smaller surface, permissive clause). (v) SHARED
  NAMED spaces (equal `inSpace("name")` across users deliberately map
  to ONE space) now transfer OWNER power — ACL-rewrite included — to
  whichever user's flow wins the genesis race; peers hold `"*": WRITE`.
  Inherent in the ruling composed with the pre-existing shared-name
  behavior; convergence clean; SURFACED TO OWNER 2026-08-21 (the
  independent review's F2 — the wildcard residual's sharper sibling;
  build report FLAG-8). RATIFIED by the CFC owner 2026-08-21
  ("ratify", relayed by the coordinator with the RULING-5 batch):
  first-creator-owns IS the shared-named-space contract — the genesis
  race's winner holds owner power, peers hold `"*": WRITE` — a settled
  behavior now, not a residual awaiting a fix. (vi) a via-"owner" crossing into a
  never-materialized home store is granted without genesis forcing and
  then refused forever by the sink's INV-13 mirror — a fail-closed
  livelock unreachable in sanctioned flows; its watcher signature is
  nonzero `foreignWriteRefusals` naming a HOME space (the review's F3).
  (vii) CLOSED for read-triggered remount. An admitted ACL change latches
  `Provider.noteAclChanged`; the next load discards a session terminated by
  an ACL verdict and reopens through the server's full `session.open`
  admission. The watched-document tracker is cleared so a previously watched
  document is fetched again on its next read. `executor-session-remount.test.ts`
  pins the ACL-change/host path, owner rebinding, denial without widened
  authority, and refetch after remount. Automatic replay of the entire dead
  session's watch set remains a distinct follow-up; read-triggered refetch
  does not establish that stronger guarantee.
  Acceptance beyond the executor pins rides the PR's CI ON lanes and
  the flip train's live gates (the lunch/served-wish log criteria and
  the store dump), which stay the flip PR's bar; the
  `home-profile-reload-durability` ON skip was LIFTED 2026-08-21 (the
  explicit warm request — OW45's row carries the ruling and the 6/6
  gate), and the `cfc-group-chat-demo` skip was LIFTED the same day
  by OW59 (the OW34-family train closed the CFC-attribution residual
  above and removed the entry on its green ON gate + store audit).
- OW32 — the CLIENT-side `scheduler-non-settling` loop under the full
  ON posture in the two-browser journeys — the EVIDENCED mechanism of
  the two two-browser gates' red, UNATTRIBUTED (P7 independent review
  findings 1/2; the P7 build had attributed the red to OW17 by
  inference). Evidence (`review-p7-logs/`, two-browsers 2/2 at head +
  1 at base, lunch 2/2 at head, 300 s stalls each): the SERVING LOOP is
  QUIET (waves 20–26, derivedCommits 19–25, events 2/2 appended/
  processed, watermarkLag 1–2 — no storm) while BOTH browsers run
  `scheduler-non-settling` every ~6.6 s (40–56 k client action runs /
  5 min at head AND base; `runner/start/resumeCellSync` n=458–644 piece
  re-starts); 50–70 % of the server's waves exhaust the flush deadline
  (`wavesBudgetExhausted` 12–16 of 20–26 — reported here because it was
  reported nowhere; the single-browser `counter` gate also exhausts 2/5
  with NO client loop, so exhaustion alone is not the discriminator).
  Base stall ≈ head stall (head run 1 got one step further; run 2
  stalled identically at the first per-user write) — P7 is not a
  regression, but neither is it evidenced progress. The 4,427-wave storm
  signature exists ONLY on the builder's tree with OW29's reverted
  extensions applied. NOT evidenced as OW17. The lunch gate ADDITIONALLY
  hits the served `#profile` wish throwing identity-less at step 1 (see
  OW17's correction; the OW29 gap at first demand). Owed FIRST in the
  flip's ordered gates: the discriminating experiment — a
  `commonfabric.detectNonIdempotent()` capture in one browser of the
  two-browsers gate plus a debug-level `wave-budget-exhausted` trace
  naming the non-quiescing server actions — then the fix. Until then
  both gates are ON-skip-listed with this reason (`tasks/server-
  execution-on-skips.ts`), red under the full ON posture, NOT green-by-
  vacuity. Trigger: first of the flip's ordered gates (plan Phase 7 task
  1); the flip PR needs the skip list EMPTY.
  **TRIAGED (2026-08-16) and the SYMPTOM treated — row stays OPEN
  until stage B.** The triage attributed the loop: a purely
  CLIENT-side speculation retire-to-nothing loop on scope-narrowed
  (per-user) derivations — the overlay retires the echo on watermark
  coverage of its basis (~1 ms after the seal), the store holds
  NOTHING for the instance (the server derived it under the SERVICE
  identity's instance — F1's identity-less space-root demand), the
  flip is an `integrate` and the writer reads its own output, so it
  re-derives; seal → retire → flip → re-run at ~80 ms cycles. Cause =
  the demand registry drops identity for space roots (stage B's run
  supply fixes it). The CLIENT ARRIVAL GATE (speculation.md §4, RULED
  2026-08-16 on the panel's recommendation — a backstop for demand-walk
  coverage gaps and the first-demand transient, independent of the
  server half) LANDED with fan-out stage A as its own commit: an
  input-origin entry retires only once every doc instance it wrote
  holds a confirmed value at seq ≥ its floor; riders
  supersede-by-newer and own-retirement-is-not-a-trigger. Pinned:
  `speculation-arrival-gate.test.ts` (the OW32 shape — covering
  watermark, no store value → the echo stays, bounded runs, no
  non-settling; gate removed → the entry retires to nothing; arrival
  retires it and the store value renders; the own-retirement mechanism
  with its mutation; supersede-by-newer scripted). The triage's
  measured effect: 45–56 k → 55–137 client runs / 5 min, both
  two-browser gates booting < 3 s. The gates stay ON-skip-listed:
  the gate treats the symptom; the R7 wall behind it is closed by
  stage A's read seam, and the per-user derived state of real users
  needs stage B's supply — record the two-browser gates' status
  honestly at each stage (stage A's build report carries the runs).
  **CAUSE FIXED FOR WATCHING PRINCIPALS (fan-out stage B, 2026-08-17;
  wording corrected on the independent review's F4 — not blanket
  "CLOSED as a cause").** The loop's premise — the store holds per-user
  instances under the SERVICE identity and no user principal — is gone;
  every demanded per-user node runs per demanding principal (OW17 leg
  2). The NON-watching actor gap the review's F2 named (a served handler
  reading a per-user derivation it does not watch lost its event
  silently) is CLOSED by the fixer pass's transient-demander PREFLIGHT
  (`rearmNotCurrentFanOutForActor` — instance-level currency, not
  node-level; flag (2) row above). The arrival gate STAYS as the
  backstop for the first-demand transient and any walk-coverage gap
  (design §E residuals 1 and 4). Gate observations on the fixer's
  ON-built binary (fadc2efb1b), fresh store per run: the two-browsers
  gate GREEN 2/2 (1m53s, 56s; zero `scheduler-non-settling`;
  `structureLoadTerminal` 105 — NOT the build report's "0"), holding
  the stage-A/B builders' 3/3 + the review's 2/2 — UN-SKIPPED. The lunch
  gate is BIMODAL (fixer runs 1/2: run 1 merge-hang, run 2 green
  1m18s), on a residual the F4 TRIAGE attributes to SERVED-WISH TIMING,
  NOT a stage-B B7 precise-dirtiness miss:
  - the swatch flip and the merge's lost vote are the SAME chain,
    `ranked ← todaysVotes ← nowTick`. `todaysVotes` and `ranked`
    (`lunch-poll/main.tsx`) read only SHARED inputs (options, votes,
    users, `nowTick`), so they are SPACE-scoped — NOT fanned out per
    user — and B7 per-instance dirtiness does not even apply to them; a
    change to `nowTick` (a shared doc) is a space cause that dirties the
    single instance (and, for any per-user swatch VDOM downstream,
    `dirtyFanOutForCause`'s space arm dirties ALL instances —
    `dirtyFanOutAll`, not a miss). The flip is `ranked` recomputing a
    different VALUE as `nowTick` resolves, not a missed re-dirty.
  - the ROOT is the served `#now/300` interval wish (`nowTick`)
    resolving null/stale on the serving loop: `castVote` NO-OPS when
    `nowTick` is null (`main.tsx` `if (!now) return`) → the merge's lost
    vote (fixer run 1: "1 love it" at the 300 s timeout, the client
    re-fetching the piece every ~6 s — `compile-cache-hit` — with
    commitConflicts but `eventLostRaces=0` and NO `wave-commit-rejected`);
    `todaysVotes`' `dayKeyOf(nowTick)` filter flips which votes are
    "today" as `nowTick` changes → the review's swatch flip
    [Bob,Alice]→[Alice]→[Bob,Alice].
  - the two-browsers gate — which has NO `#now/300`/`nowTick`
    dependency — is GREEN 2/2 under the SAME binary and load, isolating
    the failure to the `nowTick` chain, not stage B's per-user run
    supply. The review's run-4 churn (331 `wavesBudgetExhausted`,
    `wave-commit-rejected … path is not traversable
    /value/children/2/children/0` ×5) did NOT reproduce on the fixer's
    binary (0 in 2 runs; `wavesBudgetExhausted` 66–90), so that storm
    is characterized as a transient patch-vs-wrong-base race on a
    `computed:` VDOM under the review's timing (the OW29-cousin
    class) — NOT a persistent stage-B issue; a register note, not a
    stage-B fix, plausibly further damped by F1's RetryImmediately
    bound.
  Owed (Stage C, a NAMED FOLLOW-UP, NOT stage-B-owned): the served
  interval `#now/300` wish's value for a serving runtime at dispatch
  (or the pattern's `if (!now) return` guard reading a wall clock the
  serving runtime supplies). The separate
  client-instantiate-vs-server-derive race at piece creation remains a
  source of contention, but not an unrecovered one-shot loss: deferred
  client starts catch up and dropped serving-instantiation contributions
  retry once under exact lifecycle guards (residual x).**
- OW34 — a CFC-serving POLICY item: served handler runs carry NO
  renderer-trusted event mark, so a per-user served handler's write to a
  UI-contract-gated (owner-protected) cell is refused by CFC at prepare
  ("missing trusted-event policy input") — the two-browsers gate's NEXT
  wall, UNMASKED by fan-out stage A and NOT caused by it (the stage-A
  independent review's characterization, 2026-08-17: stage A changed
  nothing the CFC ladder sees; it made the handler read Alice's draft
  and reach the write; pre-stage-A the same handler wrote nothing).
  Owning layer: stage B's attribution work or a CFC policy-input rule
  for actor-stamped served entries — with its own spec sentence (cfc +
  events.md) before it is wired; the two-browsers gate's ON-skip reason
  names it alongside OW32. Evidence (2026-08-16/17): with the R7 read
  seam closed, Alice's served save
  handler reads her draft and WRITES the shared `profiles` cell, and the
  wave refuses the commit three times and drops it — `CFC enforcement
  rejected commit: relevant transaction was not prepared: missing
  trusted-event policy input for <profiles doc> at /` (both stage-A ON
  runs, `store-on{2,3}/toolshed.log`). Mechanism: the client's fire marks
  the UI event renderer-trusted in an in-process WeakSet
  (`cfc/ui-contract.ts` `markRendererTrustedEvent`), and
  `recordTrustedEventPolicyInputs` at dispatch matches only such events;
  a drained stream entry's payload is a fresh object, so the served
  dispatch records no trusted-event policy input and
  `verifyTrustedEventRequirements` refuses at prepare. Pre-stage-A the
  same handler read the service instance's EMPTY draft and wrote nothing,
  so the refusal never fired. Not stage A's scope (flag-don't-fill): the
  fix shape is a CFC-serving design question — carry the fired event's
  trust provenance on the durable stream entry (the append is admitted
  under the actor's authority; events.md §1) and re-mark it at the served
  dispatch, or a serving-side trust rule for actor-stamped entries — with
  its own spec sentence (cfc + events.md) before it is wired. Trigger:
  before the two-browsers gate can green under ON (with stage B for the
  per-user derived state of the second user); the gates stay skip-listed.
  **CLOSED (fan-out stage B, 2026-08-17) — the sister-mark carriage,
  wired red-first (item 10's condition: the actor carriage did NOT
  supply the policy input — the ladder wants the process-local
  renderer-trust MARK, which no `firedAt` carries — so the fix is the
  register's own stated shape, the twin of the already-landed
  `runtimeInjectedEventKeys` re-mint, not a new CFC rule): the firing
  RUNTIME writes `rendererTrusted: true` on the durable entry IFF the
  sent event carried the renderer-trust mark (never the pattern; the
  append queue carries only the runtime's `true`; admission refuses any
  other value); the served dispatch RE-MARKS the payload, so the
  handler's UI-contract-gated write records the trusted-event policy
  input `verifyTrustedEventRequirements` requires, under the same
  in-process trust the client-side gate ran under (the entry was
  admitted under the firing client's authority). events.md §2 carries
  the sentence. Pinned: `executor-events-down.test.ts` (a marked fire
  appends the flag, an unmarked one — even one CLAIMING renderer
  provenance in its payload — does not; a served probe handler sees
  the re-mark for the attested entry only; a caller-supplied non-true
  value never reaches the entry) and memory `v2-event-append.test.ts`
  (malformed values refused, `true` admits). Evidence: the
  two-browsers gate's "Bob sees Alice before save" — 300 s / 14
  `missing trusted-event policy input` refusals on stage B's first
  build (`store-on1`) — passes in 3–3.4 s with the carriage
  (`store-on2..4`), zero refusals. FLAGGED for the owner: the
  server re-mints a client runtime's process-local trust attestation
  — sound at the injected-keys precedent's trust level (a compromised
  client can already write what its session authority admits), stated
  here so the ruling can veto.**
- OW33 — the ON-posture DENO-CLIENT family, surfaced by making the ON
  lanes UNIFORM (P7 independent review finding 7; fixer 2026-08-16):
  once the runner integration tests that talk to the lane's toolshed
  and the runtime-client worker DECLARE the posture from the env
  (before: bare `new Runtime` / undeclared worker → OFF client against
  an ON server, so "runner 14/14" and "runtime-client 45 steps" under
  the ON lane were mixed-posture evidence), the uniform ON posture is
  RED on: (a) `packages/runner/integration/pattern-and-data-
  persistence.test.ts` — Phase 3 starts a NEW piece, `pull()`s its
  result and reads `getAsQueryResult().sum` (15 under OFF, `undefined`
  under ON; no sink → no demand — the sink is the demand — and the ON
  client's own speculative run did not surface the value through this
  read path either; 13/14 green otherwise); (b) `runtime-client/
  integration/client.test.ts` step "renders PerUser-derived computed
  JSX inside cf-screen header slot (CT-1606)" — never reaches its FIRST
  render in 15 s (3/3 red; a `computed` over `PerUser<myName>` — the
  same PerUser shape `topics-navigation` fails on under full ON); (c)
  the same file's "dispatches one navigateTo when a rendered handler
  changes local state" — FLAKY (1/3 red: two dispatches observed for
  one handler fire — the double-dispatch class the F10 handler-fork
  contract exists to prevent); (d) `derive_array_leak.test.ts` counts 0
  of 50 increments under ON (its own warning fires; green only because
  it asserts memory). UNTRIAGED — whether the Deno-client speculation
  overlay should have shown (a)/(b) or the demand should have been
  registered, and what double-fires (c). Recorded as ON-skip entries
  (a file entry for (a); STEP-level entries for (b)/(c) so the one-file
  runtime-client suite keeps its other 43 steps ON — the step guard is
  in-file, bound to the register and validated). The 8 runner
  integration files that serve toolshed's `app.ts` in-process (no
  ExecutorHost) are single-process harnesses, OFF by construction in
  either lane. Trigger: with OW32's triage (the same "client under ON
  never settles/renders" family); the flip PR needs the skip list EMPTY.
  **TRIAGED (2026-08-22, main 51350077e — every member re-reproduced
  at the true ON topology before theorizing; report:
  docs/history/plans/server-execution-v2/optimize/ow33-triage-report.md):
  (b) and (c) are HEALED — 12/12 green (10 on the ON-built binary,
  fresh store, posture probed per run; both steps executing) — their
  STEP skips LIFTED; (d) is HEALED (counter 50/50, 5/5). The
  UNTRIAGED demand question is DISCHARGED: `pull()`'s sync joins the
  session's tracked set and the server serves both instances durably
  every run — the ruled `.pull`-for-round-one flow works. (a)
  persists as a rotating flake (4/8 original-file runs red in the
  triage series; 1-2 of 8-10 in instrumented variants) whose
  failing read alternates between the new and the resumed instance,
  ROOT-CAUSED to the speculation overlay's ARRIVAL GATE
  (speculation.md §4, RULED 2026-08-16): the
  implementation witnesses arrival as `confirmedSeq(writtenDoc) >=
  floor`, and a first-run speculation's computed docs carry an
  AUTHORED STRUCTURE write at exactly the floor seq — the client's
  OWN setup for the new instance, a PRIOR session's setup for the
  resumed one. Store-proven invariant (both decoded red stores, both
  arms; independently reproduced by the #6195 review): the covering
  watermark reaches the client at least one frame BEFORE the
  victim's served value — via a values-free advance commit or a
  values wave preceding the victim's, or pre-existing for the
  resumed arm; never an exhausted wave, which freezes
  `derivedThrough` (space-server.ts) — and the only confirmed cover
  at/above the floor is that authored structure write, so the entry
  retires on it while the served value is frames away (40–260 ms
  observed) and the
  bare read falls in the hole. Fix direction determined by the ruled
  sentence; the witness PREDICATE is a design fork FLAGGED for the
  owner (five candidates, their edges, and a recommendation:
  optimize/ow33-arrival-witness-fork.md) — no build until ruled; the
  runner skip stays re-tensed, lift bar 10/10 at the true ON
  topology once the ruled predicate lands. The topics-navigation
  sibling's recorded fail-fast myName validation red did NOT
  reproduce (9/11 green at the true topology); its residual 2/10
  flake was a different surface — the controller's addTopic ECHO run
  dropped at the stream-action validation guard (`$ctx` resolving
  without the required derived `crossrefs` at send time; topics
  still created correctly server-side: store exactly-two, events
  28/28 appended==processed) plus the unbarriered `topicAt` capture.
  LIFTED (the review pass, 2026-08-22): the capture is barriered on
  both created topics being readable (waitForCellValue — the
  waiting-in-tests non-browser shape; the red-first evidence is the
  recorded 2/10 red series, the exact mechanism the barrier closes),
  10/10 green at the true ON topology WITH the echo-drop occurring
  in 2 of the 10 gate runs and absorbed — the smell persists and is
  now tracked as its own row, OW60 (the stream-action validation
  guard's silent echo skip; flagged there: whether it should take
  the OW51 refusal+retrigger disposition is a spec decision — #6179
  scoped the refusal to the schema-aware lazy READ path). The
  patterns skip entry is REMOVED.** **RULED AND CLOSED (2026-08-22):
  the arrival-witness fork is RULED — owner ("agreed with all the
  recommendations above, continue"): candidate (B) of the fork memo
  adopted — a confirmed cover witnesses arrival STRICTLY ABOVE the
  entry's floor whatever its class, and AT the floor only when the
  covering commit is DERIVED-class; unknown class at the floor fails
  CLOSED toward the standing echo (value-identical in the observed
  arms — an unknown-class foreign cover may differ, and the next cover
  settles it); seq-keyed (C)
  the ruled fallback, not needed — and BUILT (speculation.md §4's
  arrival-witness predicate sentence, binding): the sweep's gate in
  `overlay-destination.ts` consults the covering commit's class at
  equality, threaded as the optional `coverClass` session-frame
  field (populated only under the flag — the OFF wire is
  byte-identical, key-set-pinned in `v2-cover-class-frames.test.ts`)
  through the replica's confirmed record (frames on integrate, the
  same-seq echo preserving a known class, `authored` at own-transact
  promotion, `derived` at the sealed wave confirm) into
  `speculationRetirementView`. Red-first: both observed arms
  replayed as deterministic scripted pins from the decoded store
  shapes (run 5's new arm — authored setup cover at floor 11,
  values-free advance, derived values at 13; run 1's resumed arm —
  pre-existing watermark at 7 — the base gate retired on the first
  covering watermark after seal, not literally at seal), red at base
  (entryCount 0 — the entry retired on the authored cover), green
  with (B); the elision posture, the legitimate at-floor derived
  retirement, and above-floor-any-class pinned both-sides;
  mutation-checked in both directions (class-demanded-above-floor
  kills 5 pins including 3 pre-existing arrival pins;
  equality-never-witnesses kills the at-floor-derived pin). The
  runner skip entry is LIFTED — the LAST file-level skip — on
  **10/10 green at the true ON topology** (ON-built binary sha256
  `d3ef4a47f4354977…`, fresh store per run, posture probed per run:
  `shellServerExecutionDefine === "true"` + `servingLoop` present;
  1-min loads 4.2–6.5; per-run stores show the loop serving — run
  7: 7 authored + 13 derived commits). Suites at the fix head:
  runner 1280 (7359 steps), memory 564 (274 steps), skips pins
  17/17, repo typecheck/fmt/lint green. Posture notes: a
  `system`-class cover at the floor fails closed via `!== "derived"`
  (the predicate demands the derivation itself, not merely a
  server-side write — conservative, converging on the next cover);
  the `queryGraph`/`watch.set` snapshot surface also carries
  `coverClass` under the flag (`EntitySnapshot`), and no query-result
  reader consumes it today — the consumed surface is the session-frame
  upsert into the replica's confirmed record; a same-seq frame whose
  class arrives LATE (undefined to defined) fires the arrival re-sweep
  (the mixed-window gap — an entry failed closed at its floor is not
  stranded until an unrelated commit). OW60 is NOT closed by this
  predicate, as the fork memo said: a dropped echo run seals no
  overlay entry, so no witness predicate can reach it.**
  **NAMED RESIDUAL (2026-08-22, flagged not built — owner to rule):
  the at-floor-derived edge.** An event-handler echo on a RESUMED
  instance whose floor EQUALS the prior session's wave-commit seq
  retires through the shared gate's backstop on that derived-class
  cover with no NEW consequence arrived — a flash-revert window until
  the served consequence lands. Mechanism demonstrated in review;
  reachability unproven; strictly less aggressive than the base gate
  (which retired on ANY cover there). Confirming instrument: a
  resumed counter-click at the true ON topology — check whether the
  sealed echo's floor equals the target's confirmed cover, and
  measure the revert window. Disposition option on file (not built):
  hybrid (B)+(C) at equality — derived-class AND cover seq not in the
  entry's basis-seq set. The owner rules whether to build it.**

Delta 2026-08-15 — Phase 7 (the flip; the phase PR):

- README §3.8's backpressure sentence: IMPL-GATE → COVERED (OW27 LANDED
  above; +1 binding implementation sentence — pace-never-drop, per
  stream, fired order held; the default posture is a flagged dial).
- events.md §5's offline-queue persistence sentence RE-TENSED (LT9
  re-ruled — process-lifetime; the reload half is a non-goal this
  round, the in-process replacement survival stays pinned); OW20
  CLOSED, the LT9 rec (c) seam RETIRED (rows above).
- protocol §2b's free-read row and serving-loop §3b's cross-space read
  gained the read-authority mechanism sentence (the process identity is
  a memory service principal under the flag —
  `packages/toolshed/lib/server-execution-flag.ts`, pinned in
  `server-execution-flag.test.ts`: OFF the configured list verbatim,
  ON the identity joins it exactly once). CORRECTED 2026-08-16: this IS
  a write widening for the process identity's ordinary session traffic
  (implicit OWNER everywhere) — not widened at the wave's §2b accept
  gate, which ignores the service-DID blanket by design; OW31 carries
  the ruled-posture question.
- builtins.md §5's wish row: +1 binding sentence (a flag-ON non-serving
  runtime references the served sidecar cell, never instantiates it)
  — impl-gate; witnessed live on the lunch gate (the ~13/s stale-basis
  loop stopped), unit pin owed with OW17's landing (the two-demander
  sidecar test in `executor-cross-space.test.ts` covers the serving
  side).
- scheduler/types.ts `SchedulerObservationIdentity.demandRootIds` (the
  nested-piece demand-root chain) — an implementation surface below
  spec granularity, FLAGGED: scopes.md §5's "the demand supplies the
  identity" now resolves a nested piece through its ancestors; pinned
  red-first (`executor-run-supply.test.ts`).
- testing.md §2: the CI arms (SUPERSEDED the next day — see the fixer
  delta below): the phase PR swapped the lanes by env (default = ON;
  explicit false = OFF on an OFF-built binary).
- The flip's own default (SUPERSEDED — see the fixer delta below): the
  phase PR set `SERVER_EXECUTION_DEFAULT_ENABLED = true`
  (`packages/memory/v2/server-execution-default.ts`), resolved by the
  `productionServer` / `remoteClient` presets, the shell define
  fallback, and toolshed's flag helper; the single-process presets keep
  the OFF baseline by construction (EXPERIMENTAL_OPTIONS.md). Pins:
  `runtime-presets.test.ts` (deployed-topology presets carry the
  default), `shell/test/env.test.ts` (define unset → default; `false`
  → OFF), `toolshed/lib/server-execution-flag.test.ts`.
- The plan's Phase-7 section carries the honest gates table (re-tensed
  by the fixer delta below).

Delta 2026-08-16 — Phase 7 fixer pass (the independent review's 12
findings; the OWNER RULING — the flip lands DARK):

- The landing posture: `SERVER_EXECUTION_DEFAULT_ENABLED = false`
  (owner ruling 2026-08-16 on the review's verdict LANDABLE-WITH-FIXES
  as flip-READY / NOT-LANDABLE as the flip). The OFF posture is the
  default again everywhere the constant reaches; the ON posture stays
  fully selectable; the ONE absolute pin (`server-execution-flag.test.
  ts`) now states the default IS OFF. THE FLIP IS ITS OWN SEPARATE
  ONE-LINE PR (repo convention: a flip is reverted by reverting the PR
  that only flips) — owed after the ON posture works and is performant,
  in the plan's ordered gates: OW32 triage → OW17 re-keying (+OW29) →
  OW28 → the honest benchmark → the flip PR (which also flips the
  absolute pin, the CI lane roles and their posture probes, and
  EXPERIMENTAL_OPTIONS.md; and MUST land with the ON skip list EMPTY).
  The PR that discharged it is its own delta below (2026-08-29 —
  #6535); the rest of THIS delta is the pre-flip world that PR
  changed, and reads as the history it is.
- CI lanes (testing.md §2 re-tensed): default lanes = the OFF posture
  (probe: server not serving, shell define unset); explicit-`true` ON
  lanes on `build-toolshed-on` (shell define baked `true`), FULL ON
  posture VERIFIED before each suite (`/api/meta.shellServerExecution
  Define === "true"` — a new field read from the COMPILED marker
  `tasks/build-binaries.ts` writes from the same env the shell bakes;
  `/api/health/stats.servingLoop` present); the ON lanes' Deno-side
  clients DECLARE the posture from the env (runner integration tests
  that talk to the lane's toolshed; the runtime-client worker) — the
  ON lane is UNIFORM, no longer the mixed posture the review found. The
  future flip PR's gate obligation for the deployed-topology binaries
  the review named (finding 8: `background-piece-service`, the CLI,
  cf-harness, every `PiecesController` resolve ON by the presets — no
  gate exercises them ON) is RECORDED in the plan's Phase-7 task 1;
  with the constant `false` none of them flips today.
- The ON skip mechanism was INERT since Phase 4 (found while adding
  entries; pinned by spawning deno on both shapes in
  `tasks/server-execution-on-skips.test.ts`): `deno test --ignore`
  filters only discovered modules and ignores nothing for explicitly
  listed files — a shell-expanded glob or the pattern shards' list. The
  runner/runtime-client/shell `integration` tasks now hand deno a
  QUOTED glob; the pattern ON shard filters its list through the
  script's `--filter` mode; STEP-level entries exist (in-file guard
  bound to the register, validated). Entries at this delta's date (ALL
  `phase-7`, none of the lists EMPTY — the P7 phase PR's "one entry" and
  every earlier "EMPTY" wording were about a mechanism that never bit):
  patterns ×3
  (`topics-navigation`, `cfc-group-chat-demo-two-browsers`,
  `lunch-poll-vote` — the last two on OW32's characterized, unattributed
  loop), runner ×1 (`pattern-and-data-persistence` — OW33),
  runtime-client ×2 STEP entries in `client.test.ts` (OW33). Verified
  locally: runner integration 14/14 default posture, 13/14 + 1 skipped
  under ON; runtime-client 45 steps default, 43 + 2 ignored under ON.
  [State at 2026-08-16, SUPERSEDED: the six entries were lifted
  arc-by-arc and the ON-skip registry has been EMPTY across all four
  suites since the ruled-3b-close lift (#6528, 2026-08-28 — the
  RULED-CLOSE LIFT block below); the INERT-mechanism discovery, the
  quoted-glob/`--filter` fix, and the register binding remain current.]
- Rows: OW17 gains the review's CLASS VERDICT and the correction (the
  two-browser red is NOT evidenced as OW17; the lunch "(1)+(2)+(3) →
  join UI" narrative did not reproduce); OW25 DISCHARGED (the ON shell
  build runs and is verified); OW27 corrected (cross-stream head-of-line
  hold was a defect, fixed and pinned — streams independent); OW28
  carries the characterization and fix shape (compile as an outbox
  effect kind + completion-class writeback); OW29 folds in the
  demand-root chain's list-builtin gap (fixed) and the wish-sidecar
  question (flagged); NEW OW31 (write-authority posture — ruled item;
  since RULED 2026-08-18 and BUILT 2026-08-21 — its row above),
  OW32 (the client non-settling loop — first gate), OW33 (the ON-posture
  Deno-client family).
- protocol.md §2 gains the `capabilityRef` vocabulary sentence (review
  finding 11 — adjudicated spec-sentence, no rename): the values are
  provenance TAGS naming the authorizing context, admitted by PRESENCE,
  never resolved (OW13/FP7); the name does not denote a capability
  object.
- Benchmark (review finding 12): the two-browsers harness red is the
  OW32 client loop, not a harness bug and not evidenced as OW17. An
  HONEST partial number has a shape (not built): `sx2-scale.test.ts`
  already builds N `PiecesController` clients with a timed
  `settleWrite`; two controllers (distinct identities) on ONE space — A
  appends an event, B's replica sinks the served consequence — timed
  under explicit ON vs explicit OFF, fresh store per arm, n ≥ 20, gives
  a byte-identical cross-user propagation number for the Deno client
  posture today. Recorded in the plan; the browser number waits for the
  two-user family.

The current rollout posture is the
[`serverExecution` registry](../../development/EXPERIMENTAL_OPTIONS.md#serverexecution):
first-party default OFF, ON soak paused. The following flip record describes
#6535's changes, not a current gate verdict. OW28's direct acceptance coverage
is recorded above; the plan's gate dispositions govern a renewed ON rollout.

**Flip record — PR #6535.** Its ON-skip registry and topology checks do not
exercise fresh served `compileAndRun` completion. Its merge therefore does not
discharge OW28. The flip's changes and validation record follow:

- The one-liner: `SERVER_EXECUTION_DEFAULT_ENABLED = true`
  (`packages/memory/v2/server-execution-default.ts`), and the absolute
  pin re-tensed to state the default IS ON
  (`packages/toolshed/lib/server-execution-flag.test.ts` — watched RED
  at the flipped constant before the re-tense).
- The LANE-ROLE SWAP, old → new (testing.md §2 re-tensed with it):
  `build-toolshed-on` (bakes `true`) → `build-toolshed-off` (bakes
  `"false"`); default `package-integration-test` /
  `pattern-integration-test` lanes: OFF probe → ON probe
  (serving-loop PRESENT + shell define UNSET) and they now carry the
  ON skip list (EMPTY; the OFF guard never skips);
  `package-integration-test-server-execution-on` /
  `pattern-integration-test-server-execution-on` (explicit `true`,
  variant `server-execution`) →
  `...-server-execution-off` (explicit `false` on the OFF-built
  binary, probe inverted, variant `server-execution-off` — the
  default arm continues the unmarked history). The old ci-workflow
  lane pins were watched RED on the swapped workflow, then
  reconciled, plus a new lane-roles pin test (a partial revert of one
  half now reds).
- The four-topology gate dispositions (the Phase-7 table row's
  obligation, review finding 8), lane by lane:
  (1) `background-piece-service` — had NO exercising lane; the new
  `deployed-topology-gate` job starts the REAL binary against the
  default (ON, probed) toolshed, asserts its new startup posture log
  line (`main.ts`; the binary has no HTTP surface) and clean SIGTERM
  exit — RED-FIRST with a forced-OFF service env (posture line "OFF"
  vs expected "ON").
  (2) cf-harness — had NO toolshed-backed lane (its integration suite
  was CF_HARNESS_INTEGRATION-gated); the same job runs
  `createHarnessFabricSessionFactory` (PKCS#8 from disk →
  `PiecesController.initialize` → deployed-client adoption), asserts
  the session's runtime resolved ON with nothing declared, and serves
  one genuine flow (compile + create a piece, read the result back) —
  RED-FIRST against a forced-OFF server.
  (3) the CLI — `cli-integration-test` (all three suites) becomes the
  ON exercise: `cf` ADOPTS the server's published posture
  (`experimentalOptionsForDeployedClient`, authority "server") from
  the default binary's /api/meta; the job gains the server-side ON
  posture probe so the exercise is verified, not assumed. (`cf test`
  / `cf check` stay deliberately ambient-OFF — patternTest/localDev
  presets.)
  (4) `PiecesController` hosts — the default package/pattern lanes
  are the ON exercise (sx2-scale's N controllers, the
  pieces-controller helper, every integration file initializing a
  controller against the lane's toolshed); the agents host
  (`connectors/agents/host`) shares the same
  `experimentalOptionsForDeployedClient` + remoteClient seam and is
  covered at it (no dedicated lane exists for it — recorded).
- The UNIFORM-posture reconciliation the swap needs: 4 runner
  integration files and the runtime-client integration host (worker
  declaration + `onArmStepSkip` guard) resolve env-else-default via
  the now-exported `withServerExecutionDefault` — under default-ON a
  raw env read would resurrect the P7 finding-7 MIXED posture in the
  default lanes.
- The topics multi-user LANE-POSTURE item (the topics measurement
  report §5.1/§6, 2026-08-24: "the serverless multi-user pattern lane
  — a lane-posture question the flip decision has to address either
  way"), discharged as recorded: the pattern-tests lane runs with NO
  server (`PACKAGES_WITHOUT_SERVER`) through the `patternTest`
  preset, which deliberately does NOT read the constant — the lane
  resolves the AMBIENT baseline (OFF) by construction, i.e. the
  "lane pins OFF" arm realized structurally (pinned by the preset
  conformance goldens: only productionServer/remoteClient carry the
  constant). Verified live at the flipped head:
  `topics/multi-user.test.tsx` 7/7 GREEN with the env unset (the
  campaign's 5/7 red was under EXPLICIT env ON only). The
  alternative the report named — the in-process surface growing the
  serving role — is NOT taken; it would be its own design work if
  ever wanted.
- **THE FIRST FLIP BOARD (run 33232274193) — seven reds, every one
  classified from its assertion before any fix; the fix round rode
  the same PR.** (1) `Test (2/8)`: the `startServerExecutionHost OFF
  witness` unit pins keyed unset=OFF — re-keyed (unset = the
  first-party default, gate-opens witnessed; OFF witness = the
  explicit-false arm). (2) `sx2-speculation` in the default pattern
  lane, DETERMINISTIC: the novel ON×coverage combination —
  `CF_PATTERN_COVERAGE_DIR` makes the client compile the INSTRUMENTED
  pattern variant while the serving side compiles uninstrumented, so
  the client's speculative `computed:` entries (content-addressed by
  module bytes) can never be covered by the served watermark, and an
  authored write whose basis touches them is refused per
  speculation.md §6. Repro: red with coverage, green without, same ON
  toolshed. Disposition: authored-pattern coverage COLLECTS ON THE
  OFF GUARD LANE through the soak (single-compiler world — sound;
  the pre-flip default lane's own posture), the default lane keeps
  V8 coverage. **OWED (post-soak, before the OFF lanes retire):
  serving-side instrumented-variant parity — the serving compile
  honoring the space's coverage variant — or a re-homed authored
  coverage collection; pattern-reload still collects under its
  now-ON self-booted toolshed and shares this mechanism (green so
  far, named here as the residual to watch).** BOARD-READING
  CONSEQUENCE through the soak: `coverage-check` now `needs` the OFF
  pattern lane, so ANY red in that lane also SKIPS Coverage Check and
  reds Status — board 33239003881 shows exactly that shape behind the
  owned-elsewhere firebreak red. The coupling retires when the OWED
  re-homing above lands. (3) CLI
  `core-piece-values`: the "cannot project in a fresh session"
  refusal DISSOLVES under ON by design (the serving loop
  materializes the session-derived result; a fresh session projects
  it) — the step is arm-aware now and under ON asserts the SERVED
  value. (4) CLI `core-piece-call` dedup: retry left EXACTLY ONE
  message (the dedupe-horizon skip works) but `deduplicated: true`
  cannot be reported — verb receipts are deliberately unwritten
  under ON — the script's ON arm asserts the behavioral witness
  (same id, exit 0, exactly-one-message). (5) **RULED 2026-08-29 —
  owner: "yes, Serving-side receipt/result write, as that is indeed
  what i said before" — LANDED (was STOP-AND-REPORT: the verb
  DECLARED-RESULT surface was ABSENT under ON; CLI topology, first
  ON exercise).** The gap's mechanism, as reported to owner court:
  `runner.ts handleJavaScriptHandlerResult` disabled the whole
  receipt write under the flag (`receiptsEnabled = … &&
  serverExecution !== true`) on events.md §4/N26's subsumption,
  which subsumes only the EXACTLY-ONCE role — the receipt's
  RESULT-CARRIAGE role (plainResultReceipts, verb contract WS-C/D —
  `cf call`'s `.result`/`.receipt`) had no replacement sentence and
  no serving-side writer. The ruling resolves the fork to a
  SERVING-SIDE receipt/result write, on the owner's stated model:
  "all handlers write result cells (even if the value is undefined),
  and that CAS for that is the write-once guarantee." Landed
  mechanism: the served handler run writes the receipt in its OWN
  transaction (same wave as the entry's `consequenced` mark —
  mark/effects atomic; §2b carriage as any served handler write) at
  the same cause-derived address the client-era write used;
  write-once by CAS with a lost CAS a LOUD no-op (never a second
  write, never a wave failure — counter
  `runner.servedReceiptCasLosses` + warn line); undefined-value
  handlers write the `{}` witness; the flag-ON client's echo
  publishes the address (`tx.handlingReceiptLink`) so the unchanged
  CLI readback works — the durable-ack coupling already orders the
  readback after the consequence. The client write stays disabled;
  no create-only mark rides a wave. Spec: events.md §4 "Result
  carriage" (the replacement sentence) + runtime-mapping.md N26(b)
  re-tensed RULED. Pins (executor-events-down.test.ts, each
  red-first at the pre-fix head and mutation-killed independently —
  M1 drop-the-write kills the declared-value + `{}` pins, M2
  skip-undefined kills the `{}` pin alone, M3 drop-the-CAS-check and
  M4 CAS-loss-fails-the-wave each kill the CAS-loss pin alone):
  declared value written by ONE derived commit whose
  `consequence_of` names the event (revision-table single-writer
  proof — the client never wrote); `{}` witness post-serve;
  CAS-loss loud no-op with the standing value winning, the wave
  still committing, and the OFF-arm probe's pre-created receipt
  proving cross-arm address agreement. Witness red→green: CLI
  three-topic fixture (integration.sh:908 umbrella declared-result
  assert) RED at a5d5561dc vs a default-ON source toolshed, GREEN
  with the fix on BOTH arms — including the dropped-response retry
  and imposter replay now reading the ORIGINAL result back under ON
  (their `deduplicated`-key asserts went arm-aware like flip-board
  item (4); the D3 original-result assert_json_eq holds in both
  arms). (6) `topic-board-pivot-contract` 4≠3
  crossref rows: intermittent ON-arm convergence transient (~2/22
  local only under load, 14 straight greens after; single CI
  observation; clean titles = duplicated ROW). NOT patched — the
  test's own comment records that the pivot "has been seen to
  settle a row away … under server execution" and deliberately
  asserts rather than awaits, so any wait-shape is the surface
  owner's decision (flag-don't-fill); WATCHED intermittent, this
  row is its record. (7) `iframe Firebreak Commons` red in BOTH
  arms: INHERITED — the file (#6526) landed on main after this PR's
  base and reaches the board only via the merge ref; main's own
  board at d1eca661f failed the explicit-ON pattern lane on it.
  The file's owner's, not the flip's.
- **The OFF→ON CONTRACT DELTA the first cf-ON exercise surfaced: a
  THROWN handling durably CONSUMES its invocation id.** Under ON the
  throw happens SERVER-side, where an error IS the consequence
  (events.md §5): the errored handling is the event's recorded
  outcome and the watermark advances past it, so a SAME-id retry
  never re-executes. Its mechanical shape is a race the spec allows
  either way — admission refuses the duplicate while the errored
  entry is still above the dedupe horizon, or admits it and the
  processing skip passes it (settled, no result; no receipt exists
  for an errored handling) — and both agree on the semantic: nothing
  runs, nothing is created. Under OFF the client-side refusal never
  consumed the id, so the same id then executed. The caller's correct
  move after an error is therefore a FRESH id. NOT a defect and
  nothing to fix: a spec-consistent consequence of moving the
  handling to the serving side, recorded here so the settled delta is
  not re-litigated post-soak. Asserted arm-aware by
  `packages/cli/integration/verbs-over-the-cli.sh` step 10 ("A thrown
  call and its invocation id") — under ON the same-id retry yields no
  result and leaves the note count unchanged, and a fresh id executes
  the corrected call; under OFF the same id executes. The step's ON
  comment points at this row.

Delta 2026-09-03 — flip records: from here, a flip's record is the
registry's dated status entry and the plan's coordination delta; this
register does not repeat it.

Delta 2026-09-03 — the rollback (#6840):

- The first-party default returned to OFF by the first data-only flip:
  the constant plus current-status prose, with no workflow, test, or role
  edit. The PR's own CI board is the exercise of the hygiene delta below —
  the `default` lanes probe OFF, the `opposite` lanes build an ON shell
  and probe ON, and the docs pin is what forced the status prose to move
  with the constant.

Delta 2026-09-03 — post-flip toggle hygiene:

- The absolute literal default pin introduced by #6535 is retired. Stable
  `default` / `opposite` roles already keep both arms exercised, and
  `tasks/server-execution-ci.test.ts` now pins the source default to the
  current-status cell in `EXPERIMENTAL_OPTIONS.md` (the posture word, the
  constant's value, and the rollback arm): an isolated constant edit reds,
  while an intentional flip changes only the constant and that status. The
  workflow itself is pinned literal-free: no step may select an arm by a
  literal `EXPERIMENTAL_SERVER_EXECUTION` value outside a comment.
- The workflow-facing command adapter is exercised as the program CI invokes
  (no permissions, exact output, exit 1 on a bad role) rather than opted out
  of coverage, and the topology's unreadable-directory guard holds on both of
  its readers.
- The locally persistent opposite-binary cache includes its baked `true` or
  `false` posture in the filename, so a default flip cannot restore a shell
  compiled for the former opposite arm.

Delta 2026-09-15 — nonce reconciliation in either order:

- protocol §5's "Reconciliation holds in either order" and speculation
  §2's "stands aside when that nonce is already recorded" ELABORATE the
  exactly-once MUST already counted under protocol; they add no rule to
  §1's map. The exactly-once duty was previously kept in one direction
  only — the overlay recorded its optimistic nonce so a later intent
  converged, and nothing converged the optimistic enactment on an
  intent that had already arrived and enacted, so one fire navigated
  twice whenever the served round trip beat the client's speculative
  run. The nonce is now arbitrated by the effects channel, against one
  record both arms meet: `EffectsChannel.enactOnce` is the optimistic
  arm's entry point, and the channel's own delivery arm converges on
  that record inline before it takes the nonce. The record is
  installed before an enactment's callback runs, so a callback that
  enacts synchronously meets it rather than a gap.
- Instrument: `packages/runner/test/speculation-overlay.test.ts` — the
  already-enacted nonce is not flushed while a fresh one is, and an
  in-flight enactment is awaited rather than assumed, so its FAILURE
  (which retracts the record) enacts the optimistic flush instead of
  losing the navigation.

Delta 2026-09-16 — the deferred start of a piece a speculative run
created:

- protocol §1's scheduler-tell rule and speculation §2's
  no-creation-carve-out corollary add no sentence to the map; what
  changes is which instrument covers the corollary, and which normative
  sections describe the site. The 2026-08-07 batch recorded the
  corollary as riding the stamping-boundary pins, because a run that
  instantiates a pattern is stamped by construction. A run does not
  always set the piece up in its own transaction: when the piece's
  execution family is not in this replica yet,
  `Runner.runAfterNamedFamilyLands` names that family, waits for it,
  and sets the piece up in a transaction it mints itself. That
  transaction was stamped bookkeeping whatever ran it, so a flag-ON
  client committed the argument its speculative run computed over the
  argument the served run wrote — a client path from a scheduler run to
  the wire, which the wrappers around a transaction hid a second way by
  hiding the stamp the lookup went after. The durable-read mark was
  lost across the same wait.
- serving-loop.md §3d sanctioned the speculative-consequence stamp for
  the start a commit callback mints and listed every deferred start
  under bookkeeping; it now says the stamp follows the run a start came
  from, and names the third start and the derivation kind.
  speculation.md's durable-read paragraph said the mark covers only the
  transaction the runner mints for itself; it now says what a start
  that waits for a family carries into the second one.
- Instrument: `packages/runner/test/cold-speculative-child.test.ts` —
  a child left cold and then run from a speculative transaction,
  direct and through the real and nested transaction wrappers, with
  authored and serving-runtime controls that still persist, and a pair
  covering the durable-read mark either side of the wait.

Delta 2026-08-16 — fan-out stage A (OW17 leg 1: the instance-keyed
serving replica + wire; the client arrival gate):

- protocol.md §2's read row: +1 binding clause (the runner ISSUES
  explicit-instance reads for a served per-instance run's non-own
  scoped reads; a live lease holder may name two instances of one
  (branch, id, scope)) — pinned in memory `v2-explicit-read.test.ts`
  ("stage A: a lease holder names two instances…", red-first at the P7
  head) and `executor-instance-keyed-replica.test.ts` (the serving
  replica holds both instances).
- protocol.md §3: +1 binding clause (lease-holder frames/snapshots carry
  `scope_key`; every other session's wire byte-identical) — pinned in
  the same memory test (keyed frames on watch.set/add/query/push; no
  key on a non-holder's frames). AMENDED 2026-08-17 (the fix round on
  the review's finding 1): the keying is the admitted session's STICKY
  wire vocabulary — a keyed delivery is always keyed-retracted — and the
  foreign-instance delivery re-arms after a lapse — pinned in
  `v2-explicit-read.test.ts` ("finding 1" ×3), `storage-instance-keying.
  test.ts` (the replica half), `executor-space-server.test.ts` (the
  renew arm's notice), `executor-instance-keyed-replica.test.ts` (the
  lapse E2E); mutation-verified per half.
- scopes.md §2 Monotonicity AMENDED (RULED 2026-08-16): structural at
  the space→user hop only; ragged per principal below it; instance
  addresses carry the full (scope-kind, principal) address; "k only
  narrows" is stage B's policy — a ruling, no impl-gate of its own; its
  consequence for the basis index is the S4 amendment below.
- serving-loop.md §3b's S4 AMENDED (+1 binding sentence set): rows keyed
  by the run's FULL instance address — pinned in
  `executor-instance-keyed-replica.test.ts` (S4 step) with the two P2-F
  pins moved to the same truth (`executor-serving-loop.test.ts`,
  `executor-space-server.test.ts`); the stranded stamp and broader-chain
  keys cleared in BOTH directions — pinned 2026-08-17 in
  `executor-wave.test.ts` ("S4 clearance in BOTH directions", with
  pre-existing stranded rows and the same-wave real-row guard; the
  earlier "pinned" claim covered not-written only — corrected).
- key-vocabulary.md §3b (new inventory section) + §5's list: the
  instance-keyed replica/wire vocabulary and `IMemoryAddress.scopeKey`;
  §4's first tripwire covers the list — pinned in
  `storage-instance-keying.test.ts` (OFF-arm neutrality per site).
- speculation.md §4 step 3 + the arrival-gate paragraph (RULED
  2026-08-16): +1 binding sentence set (the gate, its two riders) —
  pinned in `speculation-arrival-gate.test.ts` (each with its
  mutation); OW32's row carries the disposition.
- Danger-zone note (storage/v2.ts near the wedge machinery): the
  re-key touched `sealNative`/`sealOperations`, `settleSealedCommit`,
  `confirmPending`, `finalizeRejection`, `finalizeSupersededSpeculation`,
  `SpaceReplica.#applySessionSync()`, `SpaceReplica.#buildReads()`,
  `record`/`visibleVersion` and the
  sink/notify paths — ONLY to thread the instance key/identity into
  the doc-key resolution and the touched-doc entries; no ordering,
  parking, marker, or shadow-floor logic moved. The wedge pins
  (`settleSealedCommit → confirmPending` at verdict, `whenApplied`,
  `markAuthoritativeWrites`), park/backoff, the B-1 barrier, the
  renew-blip, and C10/T_flush suites ran green under the re-key (the
  stage-A build report carries the counts).
- Fix round (2026-08-17, on the independent review): the seams the
  review found untested each carry a discriminating pin — the true-R7
  no-load shape (`executor-instance-keyed-replica.test.ts`), the A3
  seed memo, the served preflight/presync identity, `Cell.sync`, the
  traversal kick, `SpaceReplica.#buildReads()`, and the OFF-arm serialized-form
  witness
  (`storage-instance-keying.test.ts`), `WatchView` keying
  (`v2-client-watch.test.ts`); speculation.md §4 states the arrival
  gate's frame-coupling assumption; the two-browsers gate's ON-skip
  reason names OW34 alongside OW32; residuals sharpened in OW17.

Delta 2026-08-17 — fan-out stage B (OW17 leg 2: the per-demander run
supply; OW29/OW32/OW34 closed):

- scopes.md §2: +1 binding bullet — the mechanism sentence ("a
  principal's demand at a broad address is demand for that
  principal's instance of every node that narrows beneath it"; RULED
  2026-08-16) with the probe / discovery re-arm / arrival re-arm /
  accept-and-count / transient-demander sentences — pinned in
  `executor-fan-out.test.ts` (a)–(i) and `executor-run-supply.test.ts`.
- serving-loop.md §1 ("for the subscriber's instances"; the walk per
  demanding pair) and §3b (the known-scope ratchet's three sources and
  no fourth; `instances(ratchet, demanders)`; discovery/arrival
  re-arms; B7) — pinned in `scheduler-fan-out.test.ts` (the pure core,
  each mutation red on its own), `executor-fan-out.test.ts` (b)/(h),
  `executor-run-supply.test.ts` (probe once, then per principal).
- protocol.md §1: the SpaceServer's-own-writes sentence AMENDED for the
  discovering run's redirect (RULED 2026-08-16, §I.3) with the
  durability-coupling note; +1 binding sentence set for scope-derived
  attribution and the early-emit guard (RULED 2026-08-16, §I.2) —
  pinned in `executor-space-server.test.ts` (LT6 as a user-instance
  run; the guard arm) and `executor-fan-out.test.ts` (a) (user-only
  annotations, never the service). §4: W waits on demanded INSTANCES;
  arrival is later demand — pinned by (i)'s bounded waves and (b).
- events.md §2: the renderer-trust attestation carriage (OW34) —
  pinned in `executor-events-down.test.ts` and memory
  `v2-event-append.test.ts`.
- Counters (stats.ts): `undemandedNarrowingRuns`, `earlyEmitRefusals`,
  `demandArrivals` — the first two 0 at both browser gates, the third
  17–36 per gate run.
- Danger-zone note: `space-server.ts` gained (i) the demand latch +
  300 ms coalescing grace on `noteDemandChanged`, (ii) the empty-wave
  discard at zero-delta cycles (a wave with no contribution, no
  pending effect batch and no chained-not-yet-applied seal is dropped
  so the next seal opens a fresh basis/tenure — closes the stage-A fix
  round's residual vii(b): a stale-basis wave superseded the boot
  wave's first derivations; verified against the wave/outbox/watermark/
  cross-space/effect-channel/events-down/serving-loop suites), (iii)
  the drain's view-lag guard moved AHEAD of the SKIP arm (the skip
  notice was index-addressed on the stored index alone; with a fresh
  basis its stale-view write materialized a ghost entry — pinned by
  the events-down SKIP-arm test staying green under the discard).
  `pattern-binding.ts` gained the ragged redirect fix (flag-gated; a
  session hop below an existing user redirect writes the run's own
  user slot). Not touched: the wedge machinery in `storage/v2.ts`,
  park/backoff, B-1, the renew-blip arm, C10/T_flush.
- OFF byte-identity: every new seam is reached only past a serving-
  posture or flag gate — `serverRunDemandersFor` undefined off the
  serving runtime (the scheduler's single-run path is byte-identical;
  a node acquires a fan-out record only from demanders); the wave's
  attribution settle/guard run only for stamped derivations with a
  demanded identity; `homeSpacePrincipalFor`'s ratchet is inside the
  serving branch; the pattern-binding hop is behind
  `getServerExecutionConfig()`; the wish sidecar chain is inert
  (`demandRootIds` is consulted only by the resolver); `rendererTrusted`
  rides only events-down appends (the OFF client fires no appends);
  the memory server's `demandChanged` observer and per-session demand
  rows are read only by the ExecutorHost. Whole-suite witness in the
  build report.
- Self-review delta (the mutation ledger, 2026-08-17): two mechanisms
  survived their first mutation and got discriminating pins —
  `executor-fan-out.test.ts` (f-walk) now requires the result root's
  walk to have RUN stamped with each demander's key (a walk registered
  without its demand root runs once as the service; the guarded value
  still materialized because a demander's own instance of the ifElse
  pulled it — the walk's per-demander identity is a supply fact, not
  what that value witnesses), and (j) pins the TRANSIENT event
  demander at the resolver seam (a queued served event fired by a
  non-watching principal makes their pair a demander of the target
  piece's roots — deterministically, while queued, never after, never
  for another piece). Two FLAGS surfaced while building (j)'s E2E
  shape (owner rulings owed; NOT filled):
  (1) **A handler's write to a per-user slot can land on the SPACE row
  — real behavior, WRONG cause, nil reachability, fixed UPSTREAM by a
  schema-generator guard; NO v2 code change (the fix round's
  pre-narrowing was RETRACTED 2026-08-17).** As found: a `type` handler
  running as Alice wrote her draft onto the shared argument row, no
  `user:alice` row; the independent review characterized it
  posture-independent (reproduced OFF, client-only). The owner's
  main-side investigation (`scope-handler-write-findings.md`, main
  `751cbf75c`) confirmed the STORAGE behavior but REFUTED the cause and
  the seat, and the fixer pass RE-VERIFIED the refutation on the
  fan-out-B tree with a 4-cell raw-row check:
  - **The eager-redirect pass WORKS on our tree.** The ordinary
    `PerUser<T>` shape (generated `{type:"string",
    asCell:[{kind:"cell",scope:"user"}]}` — scope at the TOP level, NOT
    a compound) narrows correctly: the report's §8 recipe (parent
    written THROUGH the schema, then a schema-less handler write) yields
    SPACE = redirect → user, USER = the value — identical to main. A
    piece instantiated with a VALUE argument narrows the same way. So
    stage A/B did NOT break the eager pass (verified: the eager
    scoped-keys pass in `data-updating.ts` and `updateArgument` /
    `Runner.#setupInternal()`'s cell-link handling are BYTE-IDENTICAL
    across the stage-A base `6d18d6998` → stage-B head — the only stage-A
    `data-updating.ts` change is `seedMemoKey`, unrelated).
  - **The review's leak came from a NON-STANDARD construction, not a
    handler-write gap.** The review's repro seeded a SCHEMA-LESS
    document with `{n:1}` and instantiated the piece over that doc
    cell; `run` converts a cell argument to a link and never re-writes
    the parent through the schema, so the eager pass never fired and the
    slot stayed at `space` — the same on main (unchanged code). This is
    "the construction is valid but skips a mitigation that fires first"
    (the report's words). Normal instantiation (value argument, or a
    schema-bearing doc) narrows; the two-browsers gate's real served
    pieces keep per-user state isolated (GREEN 2/2).
  - **The genuine defect is compound-schema blindness.**
    `getSchemaScopeCap` (`cfc.ts`) reads only the top level, so a
    scope inside an `anyOf`/`oneOf` branch is invisible to the write
    path (`declaredCellScope`, `foldDeclaredScopeIntoLinkSchema`) while
    the READ side folds it in — writes and reads disagree and the slot
    lands on `space`. Corpus reachability is NIL (all 165 declarations
    put the union inside the wrapper). ENFORCEMENT: a schema-generator
    guard that throws when a scope wrapper ends up a union member —
    OWNED BY THE MAIN-SIDE thread, at that layer, in that thread; NOT a
    v2 write-path change.
  - **Spec.** scopes.md §5 already says handler consequences land in the
    acting principal's scoped instances; §2 governs DISCOVERED scope
    (derivations). The genuine gap is that the DECLARED-scope path had
    no stated invariant — added to §5 (2026-08-17 owner thread): *a
    declared scope must be visible to the write path at the top level of
    the slot's own schema; declared-scope narrowing is the eager-redirect
    pass, and served execution EXPOSES a violation as cross-user sharing
    rather than causing it.*
  DISPOSITION: the fix round's `preNarrowDeclaredScopeSlots` (an
  instantiation-time pre-narrow) was **REVERTED** — it was a behavior
  change for a leak the ordinary path does not reach, and the real bug
  is fixed one layer up. No recorded OFF-arm acceptance. The F2 pins
  that need a narrowed slot narrow it the ORDINARY way (a schema write —
  the R7 idiom), never via pre-narrowing.
  (2) **The transient demander's REACH — CLOSED (review F2, fix round
  2026-08-17).** As found: the ruled sentence was read as "a DIRTY
  scoped input at the dispatch's preflight", and the preflight
  (`collectInvalidUpstreamForLog`) asked only the NODE-level question.
  A non-watching actor whose handler reads a per-user DERIVATION met a
  node that was node-level CLEAN (it ran for the watchers) but had NO
  instance for her — so nothing ran, her handler read the MISSING
  instance, its argument failed the schema, the run was silently
  skipped, and the entry was marked consequenced with NO error: silent
  event loss, in ALL THREE schedules the independent review tried
  (two-drains, same-drain, and the dirty-input race where the
  recompute landed before her event queued). The register formerly
  understated this as "reads empty / unstated"; §B5's own text says
  "stale/**missing**", so this was a gap in the implementation of the
  ruled mechanism, not an unstated semantic. Fix: B7 made cleanliness
  PER INSTANCE, so the preflight now asks the per-instance question for
  the actor — `Scheduler.rearmNotCurrentFanOutForActor` re-arms the
  fanned-out nodes in a served handler's closure whose instance for the
  ACTOR is not current (never run at the node's ratchet for her),
  keeping the sibling instances clean (B7); the event waits on them,
  and the handler then reads a CURRENT instance (or, if her instance
  cannot be keyed — a sessionless actor at session depth — nothing is
  materialized and the read fails as before, never a silent
  consequence for the motivating shape). This is the arrival re-arm
  applied to the transient demand `transientEventDemandersFor` already
  folds in (pinned by (j)). Pinned red-first: `executor-fan-out.test.ts`
  (k) [two-drains / same-drain / dirty-input] — the actor's `save`
  lands `saved:echo:A` under HER instance, consequenced CLEAN, the
  watcher's instance untouched; mutation (the re-arm dropped) → the
  silent loss returns → red 3/3. scopes.md §2's transient-demander
  sentence now reads "not current for the actor" (B7's sense), not
  "dirty". Residual (documented gap, narrow): the re-arm walks the
  handler's DIRECT read-writers only — a per-user node reached
  TRANSITIVELY through an intervening derivation is not materialized
  for the actor (the node-level path's inverted cone is not
  duplicated); the watchers' rendering walk covers the rendering shape,
  so this is narrow in practice.
  Also on the record: (f-walk)'s walk-key wait failed 5/9 in one
  window (Alice's walk instance CLEAN with no keyed run 20 s after
  her flag write; the diagnostic label now prints the walk node's
  fan-out record and every run since the flag write) and then held
  40+/40 across two soaks including one under CPU load; unexplained,
  so the pin waits on TWO keyed changes under her chain (flag, then
  draft) — a recurrence in CI is evidence about B7 (a keyed cascade
  not dirtying a walk instance) and should be read as such, not
  retried.

- **Stage C tuning delta (2026-08-18) — the tuning trio, owner-approved
  as the tuning half of the tuning-vs-design split (the design half —
  the per-demander demand walk × roots, and the client's whole-sidecar
  intent tracking with a CFC probe per fire — is a SEPARATE stage;
  untouched here). Every item re-measured on the harness protocol
  (fresh store per run, ON binary posture-verified via `/api/meta` +
  `servingLoop` present, load recorded, NO configured LLM model — the
  attribution found the 08-17 daytime greens masked by exactly that
  churn). Provenance: the figures below are the FINAL binaries' — ON
  `a2d9a2b7…` / OFF `e8d8ae60…`, both built from the PR tip
  `2e9d86478` — with the interim reps (`a9534d18…` ON, `6ac8a606…` OFF,
  and earlier scratch builds) kept where they add evidence and labeled
  as such; this register's first cut (`5c296cefe`) carried the interim
  figures alone and was reconciled 2026-08-18 by the independent
  review's fix batch:**
  - **T1 — one CFC flow-label probe per commit** (`cfc/prepare.ts`
    `flowLabelWorkExists`, evaluated by both `Runtime.prepareTxForCommit`
    and the commit chokepoint on the same unprepared, not-yet-relevant
    tx — 65 % of a saturated client worker on the ON note series). The
    NEGATIVE verdict is memoized on the transaction
    (`IExtendedStorageTransaction.probeFlowLabelWork`), invalidated by
    any journaled read/write/dereference trace/trigger read (an activity
    epoch); a positive verdict marks the tx relevant, after which nobody
    probes. Shared client code, both arms: verdicts unchanged (a memo of
    a deterministic function; the flow-label suites pin them), probe
    count 2 → 1 per commit in both. Pinned:
    `cfc-flow-probe-memo.test.ts` (one evaluation + one memo hit; a
    read or a write between the asks re-evaluates; a positive verdict is
    never memoized; both arms) with mutations (memo disabled → red;
    read-bump removed → the invalidation pin red). Re-measured, note
    create n=20 (`default-app.test.ts`, `CF_NOTE_CREATE_TIMING_SERIES=20`):
    ON createToView p50 **5 758 / 3 838 ms** on the FINAL binary
    (`a2d9a2b7…`, FN1/FN2, loads 6.0 / 5.1) and **4 224 / 4 361 ms** on
    the interim `a9534d18…` (N1/N2, loads 3.3 / 3.0) vs the
    attribution's baseline **8 927 / 5 841 ms**; p95 **10 003 / 9 908 ms**
    (final) and **8 165 / 7 358 ms** (interim) vs **23 335 / 26 451**;
    the series completed n=20 in 292 / 229 s (final) and 253 / 227 s
    (interim) — every rep — vs 502 s and a 780-s cap hit at note 18; the
    adjacent OFF controls (OFF binaries from the same tips: final
    `e8d8ae60…` at load 5.8, interim `6ac8a606…` at load 3.6)
    createToView p50 **1 205 / 1 129 ms**, p95 1 447 / 1 236 — inside the
    baseline OFF band (1 085–1 171 / 1 328–1 496): the OFF arm's timing
    is unchanged. ON/OFF ratio 3.2–4.8× (was 5.4–8.2×). The per-note
    growth is still monotone (1.2 → 14.9 s at note 20 on the interim
    reps): the O(events²) intent-tracking term is the design half's, as
    predicted; the console-gate red on some ON reps is the pre-existing
    `splitDefinitions` error the attribution's §6 records, unrelated to
    timing.
  - **T2 — retirement on ARRIVAL, and the late-echo rule** (the
    attribution's §4: a correctly served + pushed derived value held 48 s
    by the client's overlay). (a) The owed arrival re-sweep LANDED: the
    replica fires `speculationArrivalObserver` at the end of integrating
    a frame that moves a doc's confirmed seq forward; the overlay
    re-sweeps when an arrived doc is one some live entry wrote. The
    gate's predicates are UNCHANGED — arrival is a second, EARLIER
    trigger (speculation.md §4's amended paragraph states the soundness
    argument: the sweep re-evaluates coverage and arrival on replica
    state at every trigger). Reconciled with #5969's arrival-gate KEEP
    verdict: the gate STAYS as the fallback; the wake fires ahead of the
    watermark. (b) The late-echo edge #5969 flagged is the SAME gate and
    IS covered here, by a different sentence than the arrival wake: an
    event-handler echo sealed after its intent's terminal consequence
    already arrived is not registered (speculation.md §4 step 2 read as
    the state it names — the consequences exist, the echo is jobless).
    Evidence that E2 WAS that edge: the chip never flipped even
    speculatively (`flippedAt=-1`) — no prompt echo — while Alice's
    worker was busy for 8.7–12 s (`ipc/runtime:idle` max in every red
    run: A1 8 658, D4 12 015, E2 8 699 ms; the green runs 3.2–7.3 s);
    the toggle handler is bound to `onClick` with no `detail.checked`,
    so a dispatch that runs after the served consequences reads
    `everyoneIsAdmin=false` and toggles it BACK — the DOM's "Everyone is
    admin"; that echo's floor is the served commit's seq (above every W
    until the next authored input) and its mark was consumed before it
    existed, so nothing retires it — until Bob's draft lifts W (the
    48-s release the report timed). Stated as INFERRED from that
    evidence, not witnessed by a client trace (the report's "last
    inch"): the re-measured runs never reproduced the late dispatch
    (`overlayLateEchoDrops` 0), so the rule's live firing is unobserved;
    its unit pin covers the mechanism. The rule's sentence in
    speculation.md §4 step 2 landed DATED (2026-08-18), not RULED, and
    was **ratified 2026-08-18** — RULED as written, with its rationale
    (a speculative preview of an event the server has already completed
    has nothing to add and can only mislead); #5969 had called it a
    candidate rule, owner call; it landed here as the retirement
    condition the step already states (register OW36, closed). The
    rule reaches the late echo's
    client CASCADE too (a child echo whose `parentEventId` is the jobless
    intent, and its children), and a dropped late echo's enactable
    effects are owned and not enacted (the closed-overlay arm's shape).
    Pinned: `speculation-arrival-gate.test.ts`
    (the E2 shape end to end — a served value arriving decoupled from a
    watermark advance retires and renders at once, mutation: wake
    removed → the entry stands; the trigger-not-relaxation scripted pin;
    the late-echo rule scripted with its mutation). Re-measured, the
    two-browsers lockdown gate at night-like conditions (no LLM model,
    loads 2.2–6.5): **GREEN 16/16** — 6/6 on the FINAL binary
    (`a2d9a2b7…`, F10–F15: 36–43 s walls), 7/7 on the interim
    `a9534d18…` (G3–G9: 31–58 s walls), I1 (instrumented, byte-equal
    code) and G1/G2 on earlier interim builds — vs the attribution's 5
    stalls in 12 night attempts; per browser, `overlayArrivalSweeps`
    14–25 per run
    (the wake fires routinely — served values now arrive decoupled from W
    as the ordinary shape), `overlayLateEchoDrops` 0 (the late dispatch
    did not recur: Alice's `ipc/runtime:idle` max fell to 0.66–2.3 s per
    run, total 3.4–6.7 s vs 11.8–31.4 s — T1's client relief; the
    late-echo rule stands as the backstop). Also found and FIXED while
    landing (a): the browser worker bundle drops UNINITIALIZED class
    fields, so `"speculationAckObserver" in replica` read false in
    browsers — leg-C's origin-ack wake had never installed in a browser
    client (Deno-only green); the replica's observer fields are now
    initialized explicitly and the overlay probes capability by method
    (`speculationRetirementView`). The overlay counters ride the browser
    load summary (`cfc-browser-helpers.ts` churn:
    `overlayLateEchoDrops`, `overlayArrivalSweeps`).
  - **T3 — the honest deadline and the mid-wave renew** (attribution
    §2b/§3: deadline late by 2.5–8.3 s; renew gaps to 10 s vs a 15-s TTL;
    t2's `lease-lost` on all spaces at once). A SERVING runtime's
    scheduler yields one macrotask between settle-loop ACTIONS once its
    16-ms slice of continuous work is spent — not inside the per-demander
    fan-out loop, where a yield let a run's own async seal refusal land
    mid-pass and double a served emission (the LT6 early-emit arm caught
    it; the retry lands on the queued pass by contract)
    (`scheduler/cooperative-yield.ts` — `setTimeout(0)`,
    the one primitive that lets due timers fire in deadline order;
    MessageChannel and setImmediate measured to starve them); the OFF arm
    and clients construct no yielder (posture-gated at construction).
    The SpaceServer installs `Runtime.servingYieldObserver` at
    activation and renews the lease from it once the tenure has gone
    TTL/3 without a renewal (`leaseTtlMs` policy knob for tests). Pinned:
    `executor-cooperative-yield.test.ts` — (i) a 1.2-s synthetic walk
    under a 100-ms deadline commits its first exhausted wave in < 600 ms
    (mutation: yield removed → 1 239 ms, red); (ii) a 45-step, 1.8-s
    walk outliving a 900-ms TTL twice over commits under a live lease
    with the timer inert (mutation: renew-on-yield removed → the commit
    is refused, red); (iii) posture gate; unit. Live (I1, instrumented
    scratch build): deadline lateness on exhausted cycles p50 **25 ms**,
    p90 152, max 399 ms (was p50 125 / p90 443 / max 1 155 on the note
    run, and seconds on chat event waves); renew gaps p50 **5 020 ms**,
    max 5 120 (was p50 5.0–7.9 s, max 10.0 s); `lease.lost` **0** in
    all 22 re-measured runs (the 16 gate runs and the 4 ON note runs hold
    leases; the 2 OFF note controls hold none); `wavesBudgetExhausted`
    now an honest count (117–210 per chat run vs 29 — it counts every
    cut cycle). Its
    COMPANION, forced by honesty: with cycles cut before a drained event
    ran, the post-commit re-arm re-drained the still-pending entry every
    cycle and queued a second copy each time — G1 (pre-guard) showed
    `events: appended 8 / processed 34` (4.25× dispatch of the lockdown
    toggle; #5969's (β) re-scan variant); the drain now skips an entry
    whose earlier drain copy is still in flight — queued/held/running,
    or with its mark sealed into a wave the store has not yet committed
    — and releases it only on a store-visible outcome (the wave's
    committed/requeued ids) or a provably markless end (deferral, an
    aborted run's final callback, a notice that failed to stage); the
    self-review's finding 1 moved the release off the SEAL, where a
    re-drain hitting a real await between wave-detach and the guard
    check could still queue a second copy (`events.drainInFlightSkips`;
    events.md §4's new sentence, stated narrowly as the drain deduping
    against ITSELF — the LT1 (α) in-process copy and the cross-producer
    invariant stayed owed to the owner's ruling at this landing; RULED
    2026-08-18, OW35 below). Pinned:
    `executor-events-down.test.ts` (exactly-once under an honest
    deadline: one fire mid-settle → processed 1, ONE consequence commit,
    the counter reads 1; mutation: guard removed → processed 11, red).
    The RELEASE POINT itself is pinned too (the independent review's
    MINOR-2, 2026-08-18 — the exactly-once pin above passes with either
    release point): the same file's SEAL→OUTCOME-window pin parks a
    re-drain at the sidecar sync (the serving manager's `syncCell` seam,
    engaged on re-drains only) until the copy's consequence has SEALED
    into a wave the store has not committed — the store still holds the
    pre-fire value, the entry is unconsequenced — then lets the drain
    reach the entry's guard check: it skips (`marked`), the wave commits,
    processed 1, value 1; mutation: release at the seal → that re-drain
    queues a second copy (processed 2, value 2), red.
    Every guarded run: `processed == appended`.
  - OFF witness: T1 is arm-independent by design (verdicts pinned);
    T2 lives in the flag-ON client overlay (constructed only under the
    flag on non-serving runtimes) and the replica seam fires only with an
    observer installed; T3 is gated on `runtime.servingPosture` at
    construction (the yielder does not exist elsewhere) and the drain
    guard sits inside the serving loop. Whole-suite witness in the PR.

- **Stage C coordination delta (2026-08-18) — the coordination state is
  carried ON-BRANCH (owner directive 2026-08-18: files, not agent
  memory).** The arc's live state — the train, the owner's landing
  posture (confidence verdict → land the stack with the flag OFF →
  optimize on main; the flip later), stage-C outcomes, ordered next
  actions, open rulings — is the plan's "Coordination state" section
  (`docs/plans/server-execution-v2.md`); the frozen record with the
  evidence beside it is
  [`docs/history/plans/server-execution-v2/stage-c-closeout.md`](../../history/plans/server-execution-v2/stage-c-closeout.md)
  (the two benchmarks, the attribution, the three stage-C review
  reports, the fan-out design + panel). OW28's implementation and acceptance
  work, with its independently scoped follow-ups, are recorded above.
  The lunch double-dispatch work is tracked by OW35; the frozen
  closeout carries the stage-C branch and review record.
  - **OW35 — the served-handler DOUBLE-DISPATCH parity gap: (α) + the
    cross-producer invariant sentence — RULED 2026-08-18 (owner:
    "agreed with your recommendations" — (ii) as stated, NOT (iii));
    the (α) build is OWED to the design build stage.** One
    durable entry, one eventId, dispatched N× (2–5 on the lunch gate;
    the two-browsers lockdown toggle is the same class, re-drain
    variant only) via the LT1 in-process leftover (α), the drain
    re-queue (β), and the re-armed re-scan; under OFF exactly-once by
    construction (one in-process queue, one handler registration per
    stream link) — a served-execution parity gap, not a pattern bug
    (#5969's Flag 1 is the dossier, `file:line` at `fb2292a24`; the
    attribution quantified it ≤1.2× on chat/note, 1.15–1.67× on the
    lunch `nowTick` shape; the re-benchmark shows it intact — `appended
    11 / processed 17` in both green lunch runs). CLOSED NARROWLY by the
    tuning trio: the drain dedupes against ITSELF (events.md §4's
    at-most-one-copy sentence; `events.drainInFlightSkips`; released
    on the wave outcome, not the seal). STILL OWED: (α) — a
    deadline-time purge of unrun LT1 in-process leftovers
    (discriminator `served !== undefined && served.streamEntry ===
    undefined`, synchronous at the deadline decision) — and the
    events.md §4 sentence across BOTH producers. Recommendation on file
    (#5969's (ii); the coordinator concurs): *"one durable entry = one
    COMPLETED delivery to its handler, regardless of dispatch path or
    reference count; an entry not completed in the wave that appended
    it is dispatched by the drain alone"*, with the sub-clause decided
    for DERIVATION-kind LT1 emitters (a superseded per-doc drop re-emits
    nothing; today an orphan consequence — refuse or tolerate); NOT
    "make handlers idempotent". `events.processed > events.appended` is
    NOT the signature; per-event run counts are. **RULED 2026-08-18:**
    events.md §4 now carries the binding sentence — *"One durable
    stream entry is delivered to its handler exactly once as a
    COMPLETED run, regardless of dispatch path or reference count. An
    entry whose in-process (LT1 same-wave) run does not complete within
    its appending wave is dispatched by the drain alone; the serving
    loop purges unrun in-process leftovers at the flush deadline and
    skips at the drain any id already queued or run with a durable
    entry. A derivation-kind emitter's superseded LT1 leftover re-arms
    nothing and its orphan delivery is REFUSED (never delivered without
    a durable entry)."* — the orphan-delivery sub-clause decided
    REFUSE, (iii) refused (a FORBIDDEN entry names it), and
    serving-loop.md §3d (REQUEUE = one completed delivery; the
    supersede-drop re-arms nothing) / §5 (the outbox's durable-row +
    `eventId`-horizon twin) cross-referenced. State against the
    sentence: the tuning trio's drain in-flight guard ALREADY covers
    the (β) drain re-queue for the drain's own copies (it dedupes the
    drain against ITSELF — `events.drainInFlightSkips`, released on the
    wave outcome; pinned in `executor-events-down.test.ts`); OWED to the
    design build stage: (α) the deadline-time purge of unrun LT1
    in-process leftovers (discriminator `served !== undefined &&
    served.streamEntry === undefined`, synchronous at the deadline
    decision), the drain's skip against an in-wave `streamEntry`-bearing
    run (the (β) half beyond the drain's own copies, shaper-held events
    included), the derivation-emitter orphan REFUSAL, and a per-event
    run-count pin (one fire under an LT1 cascade that misses the
    deadline → exactly one COMPLETED run; `processed == appended` is
    not that pin). Scope, recorded at the owner's request so the
    invariant is not misread: the client's speculative echo COMMITS
    NOWHERE — it renders only (speculation.md §1) — and the AUTHORED
    event commit (the client's append, one per fire) and the DERIVED
    result commit (the served handler's consequences) are TWO commits;
    the invariant binds the RESULT side — how many times one durable
    entry's consequences are committed — not the authored append (whose
    exactly-once is the `eventId` dedupe horizon) and not the echo.
    Trigger unchanged for the build: before the lunch skip lifts and
    before the ON arm is called correct on non-idempotent handlers —
    i.e. before the confidence verdict is stated as "no fundamental
    issue" without this qualification.
    **CLOSED 2026-08-19 by the design build's W3 (α)** (stacked PR
    `claude/server-exec-v2-w3-alpha`, built off W1 and re-stacked onto
    W2's tip at the 2026-08-19 re-stack; no CI — every green a local
    run). LANDED: (α1) the deadline-time purge of QUEUED LT1 leftovers
    (`Scheduler.purgeQueuedEvents`, the ruled discriminator, synchronous
    at both `exhausted` arms of `#waveCycle`; `events.lt1LeftoversPurged`);
    (α1b) the late-seal REFUSAL of an LT1 copy that was still RUNNING at
    the deadline and seals after its appending wave closed — the wave its
    emitter sealed into, carried as `ServedEventDispatch.lt1.emitterTx`
    and resolved at the dispatch stamp (`#lt1AppendingWave`), refused in
    `SpaceServer.seal()` before it enters any wave
    (`events.lt1LateSealsRefused`; the scheduler settles the copy quietly
    on the `LT1_LATE_SEAL_REFUSED` sentinel) — the seat the ruled
    sentence's "does not complete within its appending wave" requires and
    the design's α1–α4 list did not name: W0's l1 store shows it (commit
    64 = the in-process copy's unmarked vote add + the drain copy's marked
    `remove-by-value`, `consequenceOf` deduping to ONE id — so per-event
    `consequenceOf` counts cannot see a same-wave double; the handler's
    effect can); (α2) VERIFIED, not rebuilt: the trio's in-flight guard is
    set BEFORE `queueEvent`, which holds shaped events synchronously, so a
    shaper-held drain copy is `queued` to the guard, and the drain is the
    ONLY producer of `streamEntry`-bearing copies (cell.ts's LT1 copy
    carries none; the scheduler's requeue paths never carry `served` —
    served copies are queued `retries: false`); (α3) the orphan REFUSAL
    in the wave's requeue closure — an LT1 copy (`WaveRunContext.lt1`)
    whose entry no SURVIVING contribution of the wave appends (the
    emitter's sidecar write superseded per-doc, the emitter dropped whole
    or requeued, or the emitter's seal never entered the wave) is
    withdrawn with disposition `dropped`, never reported as requeued,
    nothing re-armed (`events.orphanDeliveriesRefused`; the seat is the
    closure loop beside the C8d `parentRequeued` arm, keyed on a
    per-wave eventId → emitter map built from the sealed ops' seq-less
    sidecar entries); (α4) the per-event run-count pins, red-first:
    `executor-events-down.test.ts` "(α1)+(α1b)+(α4)" (two LT1 children —
    the first async and parked across the deadline, the second queued
    behind it: purge 1, refusal 1, the child's non-idempotent effect
    applied exactly twice for two entries, one consequence commit each;
    mutations: purge skipped → purge 0 / refusal 2; seal refusal AND the
    orphan arm's absent-emitter clause skipped → the effect applied
    THREE times, the lunch double), "(α1b)+(α4)" (the in-flight copy
    alone: refusal 1, effect once; the combined mutation → effect twice),
    "(α3)" (a derivation emitter + a rival client append on the same
    stream, the settle gate holding the wave: the orphan refused, the
    sidecar holds only the rival's entry, every consequenced id has a
    durable entry; mutation: the orphan arm removed → "ping" delivered
    with no entry behind it). Defense in depth, recorded: with the seal
    refusal alone removed, the late copy enters the next wave and the
    orphan arm's absent-emitter clause withdraws it there (the drain's
    copy, having read its write, requeues once) — the effect stays once;
    the TRUE double needs both seats off. Live witness: the lunch gate ON
    at the W3 tip, fresh store, 3/3 GREEN (walls 36 / 20 / 17 s; totals
    7.3 / 5.5 / 4.5 s; `events appended 11 / processed 12` in every run —
    the 12th is the purged LT1 leftover the drain delivered —
    `lt1LeftoversPurged 1`, `lt1LateSealsRefused 0`,
    `orphanDeliveriesRefused 0`; each run's store: 16 events (11 client
    + 5 LT1), every eventId in exactly one derived commit, the votes doc
    3 adds / 0 `remove-by-value` — W0's l1 showed the remove). The
    before/after shape: `appended 11 / processed 17` (re-benchmark) and
    `appended 9 / processed 10` + a vote toggled off (W0 l1) → `appended
    11 / processed 12`, no toggle. The lunch ON skip STAYS (decision
    below, W3 block): the gate's remaining bimodality is NOT (α)'s —
    see the l3 row.
    **RE-READ by W3's independent review (2026-08-19) — CLOSED stands
    for the PINNED shapes, and the sibling shape is now one of them.**
    The closing build's code was WEAKER than the ruled sentence's
    letter in one corner the (α4) pins did not construct: an event
    contributing a same-eventId SIBLING tx (the served navigateTo's
    intent, committed inline mid-run) beside its LT1 handler run. With
    the sibling surviving the appending wave and the handler's tx
    refused at its late seal (α1b), the batch marked the entry on the
    sibling's survival and the drain never re-delivered — zero
    completed runs (review B1, a BLOCKER: a lost delivery and a
    regression against the W1 base, where the late copy committed
    unmarked one wave later); the (α3) arm had the mirror gap — the
    intent half of an orphan landed (review M1). Both FIXED in the
    review batch and pinned red-first ("(α1b)+(α4) + a same-eventId
    SIBLING tx"; "(α3) + a same-eventId SIBLING tx"): only the LT1
    copy's OWN surviving run marks its seq-less entry; an
    orphan-refused copy folds its siblings, counted once per event.
    Residual recorded (events.md §4's AMENDED note): the late-seal
    split — the intent lands in the appending wave, the consequences
    with the drain's run one wave later, idempotent by the nonce
    dedupe; a tightening that withdraws the timing-orphaned sibling is
    named, not built. Not a hole in the sentence; a shape the register
    now names.
  - **OW36 — the late-echo arrival-gate rule — RULED 2026-08-18
    (ratified as written); CLOSED.**
    Implemented in #5991 (T2 (b)) as speculation.md §4 step 2 read as a
    state predicate — an event-handler echo sealed after its intent's
    terminal consequence already arrived is jobless and NOT registered;
    its client cascade is jobless via `parentEventId`; its enactable
    effects are owned and not enacted — DATED 2026-08-18, no RULED
    marker; #5969 had called it a candidate rule / owner call. Never
    fired live (`overlayLateEchoDrops` 0 in every re-measured run — 16
    gate runs, the re-benchmark's 2 chat runs); its unit pin covers the
    mechanism (`speculation-arrival-gate.test.ts`, with mutation). E2's
    mechanism is INFERRED (no prompt echo, a busy worker, the
    click-bound toggle re-toggling), not witnessed by a client trace.
    **RULED 2026-08-18:** the owner ratified the sentence AS WRITTEN;
    speculation.md §4 step 2 now carries the RULED marker with the
    one-clause rationale — a speculative preview of an event the server
    has already completed has nothing to add and can only mislead. The
    tuning review's Q1/Q2 sub-questions (cascade semantics; effects)
    are answered by option (a) as built (the T2 row above records the
    two arms). Nothing owed; the live-firing evidence gap stays as
    recorded (`overlayLateEchoDrops` 0 across the re-measured runs; the
    unit pin covers the mechanism).
  - **OW37 — the §4 amplification ratio, a hair over budget under the
    honest deadline — a testing.md §4 TRIGGER breach that needs its
    human inspection.** Re-benchmark: chat 2.05 / 2.14 (≤2 pure), lunch
    2.11 / 2.15 (≤2), note 3.07 / 3.20 (≤3 effectful) — where the first
    benchmark sat just under (1.7–2.8). Mechanism named: with T3's
    honest deadline `derivedCommits == waves` still holds but the settle
    commits MORE, SMALLER waves per authored input, so the ratio tracks
    the cycle count, not per-write amplification; total store commits
    remain 2.1–3.1× BELOW OFF (chat 195–201 vs 608–612; note 460–475 vs
    989). Owed (the metric's owner): either a "per logical write"
    reading of the denominator/numerator or a re-baselined budget line
    with this reason recorded in testing.md §4 — never silenced in the
    test. Trigger: before the §4 counter assertion is asserted in CI's
    ON arm on these workloads; naturally with the design pass's
    re-benchmark (whose fewer, larger walks may move it back under).
  - **OW38 — the flip's performance metric and BAR: measure SERVER
    SETTLE TIME explicitly; the bar is an owner ruling.** The owner's
    2026-08-18 measurement caveat: the OFF "4–42 ms" client-local
    numbers (and the 0.22-s chat series) are the client rendering its
    own run; speculative client-side execution stays under ON and stays
    fast, so that number is not necessarily the comparator. The honest
    server metric is TIME-TO-SETTLE ON THE SERVER — authored input
    admitted → derived consequences committed and W covering them
    (`waitForSettled` / `derivedThrough`), measured explicitly and
    reported beside the send→other-browser series (which stays: the
    several-second sends are far too high under any comparator). Owed:
    (i) the next benchmark's protocol adds the settle-time series (the
    `sx2-scale` `settleWrite` shape and the two-controllers-one-space
    partial number the plan already names are the building blocks); (ii)
    the flip's performance BAR restated against it — the design pass's
    pre-recommendation is "sub-second, within a small constant of OFF"
    on the cross-user step; the owner rules. Trigger: the design pass's
    re-benchmark; the flip gate (plan Phase 7 task 1 item 4) reads
    against the RULED bar, not against the client-local OFF number.
    (W3.1, 2026-08-19: S1's quiescence advances are split OUT of the
    per-input settle series — the `settleAdvances` block (count,
    lastDelta, series) — so W4's settle metric reads per-input
    timings with the designed advance-only waves excluded, and the
    amplification arithmetic subtracts them; the sx2-serving-loop
    budgets already do.)
    **(i) LANDED 2026-08-20 with W4's acceptance benchmark**
    (`stage-c/w4-acceptance-report.md`, raw series under
    `stage-c/w4-raw/`): the settle-time series measured explicitly on
    the OFF₁→ON→OFF₂ protocol at the train tip — server settle
    all-inputs coverage p50 **18/15 ms chat, 17/20/17 ms lunch,
    28/22 ms note** (value-only 15–21 ms; structural-growth to landing
    p50 258–520 ms; every p50 sub-second — the design pass's
    pre-recommendation bar holds on the measured numbers), reported
    beside the send→other-browser series (chat median 520/421 ms ON vs
    217–253 OFF; the several-second sends gone) and the new
    sender-echo series (the one bar that FAILS as worded: not ms-class
    in either arm, ON 1.5–2.4× OFF on chat, attributed to the client
    (e) term). **(ii) RULED 2026-08-24 (owner, verbatim): "topics
    numbers are fine." — the flip performance bar is MET on the
    measured numbers**; the flip gate (plan Phase 7 task 1 item 4)
    reads satisfied on this ruling.
  - OW31 (row above, RULED 2026-08-18; BUILT 2026-08-21): the
    write-authority posture is
    ruled — the serving identity never writes users' home spaces, the
    user's identity does; a provisioned space's genesis is signed by
    the space's own keys and names the acting user OWNER in that same
    first commit — with the work order recorded (the scoping report
    beside the closeout); the implementation LANDED on the
    optimize-on-main train (the row above carries the build evidence);
    OFF-invisible; it did not gate landing the stack OFF (the
    grant is flag-gated; OFF uses the configured list verbatim). The
    READ side is RULED 2026-08-19 (the row above carries the verbatim
    quote): the service identity reads the ACL ONLY, every other
    served read runs under the acting user's identity — SUPERSEDING
    the scoping report's read-only-service-class recommendation; if
    the posture proves wrong during the build, flag for follow-up
    after merging to main rather than blocking.
  - Not rows, recorded: #5991's ledger comment POSTED 2026-08-18
    (<https://github.com/commonfabric/labs/pull/5991#issuecomment-5337935897>;
    the second review round's report recovered on-branch beside the
    closeout, `stage-c/stage-c-tuning-independent-review.md`); the design
    pass's reconciled report (`stage-c-design.md`) LANDED 2026-08-18 as
    a LIVE design + build work order at
    `docs/plans/server-execution-v2/stage-c-design.md` (the design-pass
    delta below; it archives beside the closeout with the history
    header when the build stage lands — the closeout's stated
    destination); #5968's Flags 1–4 (instantiation seat,
    `resolvedHash`, fetch-parity on live completion failure,
    `plainProgramOf`) await the owner's ratify-or-direct.
- **Stage C design-pass delta (2026-08-18) — the reconciled design
  LANDED; NOTHING BINDING LANDED.** The three design lenses (spec-only;
  server demand walk; client intent watch) are reconciled in
  [`docs/plans/server-execution-v2/stage-c-design.md`](../../plans/server-execution-v2/stage-c-design.md)
  (live; the lens reports verbatim beside the closeout as
  `stage-c/stage-c-lens-*.md`). It is a DESIGN: this PR changes no
  binding sentence — serving-loop.md §1:57–62 still reads "runs once
  per demanding pair" (superseded later the same day: the
  ruling-acceptance delta below lands the (d′) text there); the
  amended "structural subscription" text is
  the design's §2F.4 (the FALLBACK's wording since the same-day (d′)
  amendment below; the (d′) text is §2.10) and the front-loaded item of
  its ruling set (§5); the residual (ix) item above ("N × walk per
  changed root — the design's stated cost") still stands as accepted
  cost and is restated only when (d′) — or its fallback — lands. The
  three rulings the owner made on
  2026-08-18 are folded in as RULED (no lazy demand — RULED in
  substance; the double-dispatch invariant, OW35, whose (α) build the
  design carries as a work item; the measurement caveat, OW38 — the
  build's acceptance is server settle time sub-second on the
  cross-user journeys plus client-local speculation latency preserved).
  Rows the BUILD will mint or move when it lands (none minted here):
  a "Stage C design build delta" LANDED block with the counters
  (`servingLoop.demand.*`, the client `commonfabric.*` surface); the
  restated residual (ix); (b′) the incremental structural walk if the
  settle floor needs it; the effects-channel listener if not in scope;
  Q3.3 (skip resubscribe on identical logs) for fanned-out computeds;
  the CFC zero-write probe rider (CFC owner; OFF-visible); speculation
  §4 step 4's rebase if ruled owed; OW24 compaction re-pointed as the
  bound on the ON-only linear residuals (whole-doc frames, the
  differential, patch apply); the (a) upgrade if the interim
  schema-narrowed sink lands first; OW37 re-read on the new numbers;
  OW38 (i) the settle-time series lands with the build's benchmark and
  (ii) the flip's numeric bar stays the owner's. Spec drift the design
  records for the build to fix: serving-loop.md §7's counter list omits
  `undemandedNarrowingRuns` (scopes.md §2) and `earlyEmitRefusals`
  (protocol.md §2) though the code emits both; scopes.md §9's "ragged
  instance sets" tripwire is inconsistent with §2's amended ragged
  ruling (design §5 item 10).
  - **Amendment (2026-08-18, same day) — design (d) SUPERSEDED by (d′)
    per owner direction; still NOTHING BINDING LANDED.** The owner
    directed that demand be "the set of documents the client cares
    about … accumulated across all (highly overlapping) demands …
    [with] the schema" — which memory v2 already tracks per session
    (`session.trackedIds`, coarse on unsubscribe) — and that the loop
    "keep that list, for each document there see whether it is current
    via scheduler metadata and if not update it. that then creates new
    reads that trigger later updating." The design's §2 is now (d′):
    the demand WALK is DELETED; demand = the union over a space's
    client sessions of their tracked-ids closures with each row's
    demanding pair (`demandedInstancesForSpace`, the successor of
    `watchedRootsForSpace`); the writers of demanded instances are
    demand roots (a new `isDemandRoot` disjunct, §8-bracketed) and the
    loop runs the ones not current for a demanding pair (B7's clean
    bit; the basis index at activation); no structural-versus-value
    distinction; the structural walk is the FALLBACK (design §2F). What
    this changes in the ruling set: item 1 is RESTATED — the sentence
    to adopt for serving-loop.md §1:57–62 is the (d′) text ("demand is
    the union of the demanding sessions' tracked instances (memory v2's
    schema-narrowed closure); the serving loop runs the stale writers
    of demanded instances; there is no demand walk"; design §2.10 —
    still a PROPOSAL, not landed here; LANDED 2026-08-18 by the
    ruling-acceptance delta below); items 2 (reach gap), 3 (Q3.3),
    11 (no basis rows for the walk), 12 (walk-node key) are MOOT under
    (d′); ONE new item is RULED — **R-D, the coarse unsubscribe** ("it
    doesn't unsubscribe in a fine-grained way … i think this remains
    acceptable (and we can make it fine-grained in the future)") —
    recorded in the design's §5, no binding sentence yet (its sentence
    is part of the (d′) §1 text the build lands; the build mints the
    "fine-grained demand release" future row then). W0 becomes (d′)'s
    refutation experiment (does anything the walk kept live go dark;
    the settle including the one-push-late structural-growth cycle and
    the 300 ms demand-wake grace); W1 becomes (d′) proper with the
    structural walk as the fallback branch. Rows the build will now
    mint or move (superseding the list above where they conflict): the
    (d′) `demand` counter block (`demandedInstances`, `demandedWriters`,
    `demandRootEnters/Leaves`, `notCurrentRearms`, `pushGrowthWakes`, …
    — no `walkRuns`); residual (ix) restated as "there is no walk; the
    demand pass reconciles the tracked-ids closure in O(rows) on
    deltas; the structural-growth path lands one derived commit later
    than the link that reaches it"; the fine-grained-release future
    row (R-D); the no-grace push-growth wake / pre-seal closure refresh
    if W0 needs them; the structure load for demanded non-root docs
    with pattern meta if W0's count says so; the output-doc demanders
    union if `undemandedNarrowingRuns` shows the linked-piece shape;
    (b′) and Q3.3-for-computeds ONLY on the fallback branch. The
    design's §2.8 lists what in the code makes (d′) harder than the
    naive statement — flagged, not filled.
- **Stage C ruling-acceptance delta (2026-08-18) — the design's §5
  ruling set ACCEPTED by the owner (verbatim: "ruling set is
  accepted"); ONE binding sentence lands — serving-loop.md §1's (d′)
  demand paragraph (RULED 2026-08-18), whose IMPLEMENTATION is W1;
  every other spec sentence the rulings unlock is RULED TEXT OWED WITH
  THE BUILD; W0 is next.** Every open item of the design's §5 is RULED
  per its stated recommendation (each carries its RULED line there);
  the four already-RULED (R-A–R-D) and four MOOT items are unchanged.
  Rows minted here: OW39, OW40 (the siblings mint no numbers; this
  delta owns them).
  - **serving-loop.md §1:57–62 — CHANGED sentence, same row; the
    row's instrument moves to W1 (impl-gate → OW39).** The stage-B
    description — "the demand WALK (the live reader per demanded root
    that pulls the value's subtree) runs once per demanding pair, each
    run following THAT demander's redirects" (pinned 2026-08-17 in
    `executor-fan-out.test.ts` (f-walk) and `scheduler-fan-out.test.ts`
    — the fan-out stage-B delta above) — is REPLACED by the (d′) text
    (design §2.10, verbatim: demand = the demanding (user, session)
    pair on every INSTANCE a client session TRACKS — memory v2's
    schema-narrowed closure, instance-keyed, accumulated across
    overlapping watches; the union over the space's client sessions;
    there is no demand walk; the loop runs the STALE writers of
    demanded instances; a demanded instance's writers hold demand while
    any session tracks it and release when none does — coarse, R-D;
    push-time re-traversal / a later derived commit for
    structural growth; value-only changes through the trigger index
    alone; nothing about structure versus value decided anywhere), with
    a RULED marker that quotes the replaced sentence and states the
    implementation gap. RULED (a) — the replaced sentence was
    DESCRIPTIVE (item 1 as recommended), so this is a changed rule, not
    a spec change; no count moves here (the map's re-tally is the
    build's LANDED block, as the design-pass delta says). The
    instrument: the stage-B pins pin the WALK the sentence no longer
    describes — they stay green at this tip because the CODE still
    runs the walk (the spec is ahead of the code at §1, and says so in
    its own marker), and W1 retires them with the walk (T9′ is the
    structural pin: no `demand-walk:*` node anywhere in the graph
    snapshot; the (d′) `demand` counter block has no `walkRuns`); the
    sentence's own pins are W1's — T1′–T5′, T7′, T9′, T10′,
    P-demand-set, P-coarse, P-arrival (design §2.8 / §6) — red-first
    when the build lands. NOT restated here, deliberately: residual (ix)
    above ("the walk re-fires per changed doc it read … N × walk per
    changed root") describes the code at this tip and stays its accepted
    cost until W1 restates it with the code (design §2.10's landing
    note; item 1's ruling line); speculation.md §4's rationale phrase
    "any per-user subtree the demand walk does not reach" likewise
    describes the stage-B mechanism and is swept by the build's
    speculation.md edits (W2), not by the acceptance.
  - **OW39 — the (d′) §1 sentence's IMPLEMENTATION (W1). CLOSED
    2026-08-19 by the design build's W1.** Binding since 2026-08-18
    (serving-loop.md §1): demand is the union of the demanding sessions'
    tracked instances (memory v2's schema-narrowed closure); the serving
    loop runs the stale writers of demanded instances; there is no demand
    walk; a demanded instance's writers hold demand while any session
    tracks it and release when none does (coarse — R-D; fine-grained is
    the future row below). W1 LANDED it: the memory-server exposure
    (`demandedInstancesForSpace` + the push-growth `demandChanged`
    notify), the SpaceServer's registry over the closure + the currency
    check on registry deltas (writers of an entered key → demand roots;
    not-current-for-pair re-arm; releases on leave), the scheduler's
    standing `demandedWriters` root kind with its §8 bracket on every
    enter/leave/registration/unregistration transition, and the walk
    DELETED (`#installDemandWalk`, `#demandSinks`, the `demand-walk:*`
    effects/traces, the walk's union logs and resubscribes — gone; `grep
    -r demand-walk packages/src` finds no code). Instruments: the (d′)
    `demand` counter block (no `walkRuns`); the W1 pins T1′/T2′(probe +
    cross-piece)/T3′/T4′/T5′/T7′/T9′/T10′/P-demand-set/P-coarse/P-arrival
    (`executor-dprime-w0.test.ts`), red-first with recorded killing
    mutations; the fan-out (f) walk half retired into T9′;
    `SCHEDULER_LIVENESS_EQUIVALENCE=1` green across the executor suites
    and the pins; the OFF scheduler suites' pass/fail set identical to
    the base tree (T9′). §1's spec-ahead-of-code marker is REMOVED. See
    the "Stage C design build delta — W1 (d′)" LANDED block below for the
    per-sentence coverage rows. (W0 returned PROCEED (d′): no dark value;
    the fallback §2F was not taken.)
  - **OW40 — speculation.md §4 step 4's re-run of un-consequenced
    intents against fresh state — RULED "owed" 2026-08-18 (design §5
    item 4's sub-question, as recommended; §4 NOT amended).** Step 4
    names a rebase that is neither the sink's nor the sweep's job today
    (`#sweep` retires / un-renders an intent echo, never rebases it);
    NOT built in the design build stage — the intent listener (e) is
    orthogonal to it; the alternative ruling ("amend §4 to say an
    outstanding echo stands until retired") was not taken, so the
    sentence stands as written with this row as its owed mechanism.
    Owed: the rebase in the client overlay (`overlay-destination.ts`
    is the seat), or a later ruling that retires the sentence. Trigger
    (the recorder's, not ruled): before the flip PR — the sentence
    binds the flag-ON client — and earlier if a rendered un-consequenced
    echo is witnessed standing stale on a live run. The build
    re-points this row if W2 learns more.
  - **RULED text OWED WITH THE BUILD (not landed with the acceptance;
    each sentence brings its coverage row when it lands — §4's standing
    rule):** item 5 + item 6 — speculation.md §4 step 2's clarifying
    sentence (the match is on the pushed commit's `consequenceOf`,
    carried to the client as the tracked entry's own `consequenced` /
    `status` / `error` fields — T7 semantics — SANCTIONED as the
    consequence carrier with the guards binding: never a dependency on
    HISTORY, always backstopped by `W ≥ seq(e)` / `eventWatermark ≥
    seq(e)`; the entry read only for the tracked event and a dropped
    event's reason; `consequenceOf` does NOT go on the wire) — rides
    W2; item 7 — events.md §5's one-line pin (drops and errors ride
    `consequenceOf`) — rides the build; item 8 — the client keeps a
    stream subscribed while it has intents outstanding on it (the
    minimal watch; the `eventWatermark` write on the appended stream
    doc is the vehicle) — rides the build, its spec home (speculation.md
    §4 beside step 2, or events.md §5) the build's to name; item 9 —
    the W / `eventWatermark` backstop retires an intent-origin entry
    when the `consequenceOf` frame was missed (already the sweep's
    rule; one sweep serves both origins) — a clarifying clause if the
    build needs one; item 10 —
    scopes.md §9's tripwire amended to "ragged at the space→user hop"
    — rides the build train (design §6's "spec and register edits the
    build carries").
  - **RULED, no spec sentence and no row (build items, recorded in the
    design's §5):** item 4 — the intent watch may be a non-reactive
    storage-notification listener outside the scheduler (pin 10 guards
    the timing); item 13 — the effects-channel sink follows the same
    redesign as (e)'s second step; item 14 — the zero-write CFC-probe
    skip is a separate CFC-owner rider, OFF suite as its gate,
    OFF-visible, not this stage; item 15 — `storageManager.subscribe`;
    item 16 — the schema-narrowed sink only as an interim if (e) lands
    in two steps.
  - Not rows, recorded: the coordination state moves to "ruling set
    ACCEPTED 2026-08-18; W0 is next" (plan); W0 is (d′)'s refutation
    experiment (and (e)'s) on a scratch branch, nothing pushed (design
    §6); the design document itself stays LIVE until the build lands.
- **Stage C design build delta — W1 (d′) LANDED (2026-08-19).** The
  serving loop's demand model is now the tracked-ids closure and the
  demand walk is deleted; the build is the stacked PR
  `claude/server-exec-v2-w1-dprime` off the design branch (no CI — every
  green a local run). It closes OW39 (above) and lands serving-loop.md
  §1's (d′) text as CODE. Coverage row per (d′) §1 sentence:
  - "demand … is memory v2's schema-narrowed closure … instance-keyed,
    accumulated across its overlapping watches" — COVERED by
    `demandedInstancesForSpace` (⋃ `session.trackedIds` over the space's
    client sessions, service excluded, one row per (instance key,
    session)); pins P-demand-set / T5′ (`server.demandSetSizesForSpace`
    unionKeys = the registry keys). Killing mutation: return only watch
    roots → the closure's non-root docs vanish from the registry and
    P-demand-set's union-equality fails.
  - "there is no demand walk … the serving loop runs the STALE writers
    of demanded instances … those runs' own logged reads make their
    inputs live and current in turn" — COVERED by the standing
    `demandedWriters` root kind (the `isDemandRoot` disjunct) + the
    currency check on registry deltas; pins T1′/T4′/T7′ (the standing
    root), P-arrival (a second principal arriving on a ROOT key —
    `notCurrentRearms` +1 AND `demandArrivals` +1, both now ASSERTED), and
    **P-arrival-closure** (W1 review MAJOR-1 — the non-root-growth case of
    design §2.2: a second principal whose closure reaches a narrowed
    writer's OUTPUT doc ONLY through non-root closure rows, her watch root a
    plain holder doc that is no piece's root, gets her instance through the
    per-key currency check ALONE — the root-level arrival re-arm has no
    piece beneath her root). Killing mutation **M1** (drop the
    `demandedWriters` disjunct in `isDemandRoot`/`recomputeLiveRefs`) → 5/6
    T1′-family steps time out. Killing mutation **M-C**
    (`rearmNotCurrentForDemander` returns 0) → BOTH P-arrival (the counter
    assertion) and P-arrival-closure (the landing times out) RED — the
    build report's original P-arrival "killing mutation" claim was REFUTED
    (M-C was green against it) and is corrected there. T9′: no
    `demand-walk:*` action in the graph or trace; the OFF suites byte-identical.
  - "a demanded instance's writers hold demand … while any session
    tracks the instance and release it when none does — a session's
    tracked set shrinks only on a full re-evaluation or close (coarse)"
    — COVERED by the §8 liveness bracket on enter/leave/registration and
    the coarse leave (release only when no registry key names the writer);
    pins P-coarse (a departed session's keys leave; a shared key stays)
    AND **P-release** (W1 review MAJOR-2): a writer demanded ONLY through a
    departing session releases 1→0 (`demandRootLeaves` +N, `demandedWriters`
    drops) and goes DORMANT (a later write to its input does not re-derive),
    while a writer a remaining session still demands stays a root and keeps
    re-deriving. Killing mutation **M-B** (`leaveDemandedEntity` a no-op) →
    the solo writer never releases (`demandRootLeaves` 0; the dormant value
    re-derives), RED. **M-I** (`before <= 2` early release) is GREEN by
    construction: writer entities are SPACE-keyed so their refcount is
    always 1 — the refcount>1 branch is reached only by writerless entities
    (the session-scoped effects doc, the per-user narrowed rows, DIAG-2), so
    `before <= 2` alters no writer's liveness; no multi-key writer entity is
    reachable in the demand-set's shape (recorded, not forced).
    `SCHEDULER_LIVENESS_EQUIVALENCE=1` green (T10′ — but see the T10′ note
    below: the equivalence hook's real guard is fan-out's M-A2, not this
    suite).
  - "a derivation that becomes reachable through a wave's own write
    becomes demand when the tracker's push-time re-traversal reaches it
    and lands in a later derived commit" — COVERED by the push-growth
    `demandChanged` notify (a push pass that GREW a session's tracked set)
    → `pushGrowthWakes`; pins T2′-cross / T3′ **GROWTH** (W1 review
    MAJOR-3). The old pins asserted only the notify COUNTER while the
    value they checked (`leaf:5`) had been pre-landed by the creator's
    demand — "asserts the landing" was vacuous. Reworked: the creator
    DEPARTS; a non-runner makes `leaf` STALE; a separate firing actor
    (who does not demand leaf) fires the link; the FRESH `leaf:6` LANDS
    server-side and `demandedWriters` goes 0→1 — the landing is now the
    assertion. Killing mutation **M-D** (remove the two push-growth notify
    sites) → the growth pins fail on `pushGrowthWakes`. NOTE (the reviewer's
    sanctioned split): `leaf` is SPACE-scoped, so the firing actor's served
    handler run makes it live through its own read edge (design §2.3(ii))
    and it lands regardless of the demand pass — so **M-E** (the demand pass
    ignoring every non-root row) does NOT bite the cross-piece growth pins.
    The M-E kill — closure-row consumption LOAD-BEARING for a landing — is a
    PER-USER property, pinned by **P-arrival-closure**: a demander's own
    instance, reached only through her non-root closure row, is STARVED
    under M-E (RED). Forcing a per-user narrowing in a departed-creator
    growth is unreachable in the fan-out machinery, so this split is
    RECORDED here rather than COVERED (design §2.8 note; the reviewer
    sanctioned it). The cycle count is the `settle` series'
    structural-growth waves (W0 workload numbers: chat landing 3.3–3.4
    waves, 220–253 ms p50 — adjacency-attributed, and the W0/W1 counts
    included service-session growth now dropped, MINOR-4).
  - The `demand` counter block (serving-loop.md §7, no `walkRuns`) and
    the `settle` series are asserted present in the pins; `demandRootEnters`/
    `Leaves` accumulate across park (obligation (iii)).
  - **R-D — the coarse unsubscribe — RULED 2026-08-18, recorded here.**
    A doc leaves demand only when NO live session tracks it; the
    incremental push path only grows a session's set, so demand roots
    release LATE, never early (bounded work no client reads, never a
    starved value). FUTURE row **"fine-grained demand release"**: the
    seat is the memory server's tracker (per-doc refcounts across a
    session's selectors), not the loop; trigger — a workload where the
    coarse over-demand's compute cost is shown to matter (W0's drift was
    not tens of thousands: note union 0 → 1 721 over 20 notes, one
    session, dropping to 3 when the sessions leave).
  - **FUTURE / owed rows the build surfaced (none binding):**
    - **flag 4 — the structure load for demanded NON-root docs with
      pattern meta.** The closure surfaces a piece reachable only through
      a DATA link whose writer is not registered on the server (parity
      with the walk, which never started pieces either); W0 counted the
      rows: chat 2 / note 19 / lunch 0. The id-class-filtered
      `#attemptStructureLoad` per such row is the OPTION; not built (the
      count is small and the pattern-meta test needs a per-row engine read
      the pass must not do). Trigger: a workload where a data-linked
      piece's value must land server-side.
    - **flag 5 — the output-doc-demanders union.** `#demandersFor`
      matches keys by ROOT id; a session whose closure reaches piece P2's
      computed doc but not P2's root supplies no demander to P2's writer →
      the wave-level `undemandedNarrowingRuns` fallback (pre-existing;
      W0: chat 0, lunch 0, note 47–55, the trio tip 47–48). Unioning the
      pairs demanding a writer's OUTPUT docs into its demanders is an
      option within the ruled semantics; not built. Trigger: the note
      journey's `undemandedNarrowingRuns` shown on the critical path.
    - **flag 9 — id-class filtering of the `source`-wired closure.** The
      tracker follows a piece root's `source`/process wiring regardless of
      schema, so a schema-narrowed root watch demands the piece's whole
      internal graph (over-approximation, never under — W0 §2(b)).
      RECOMMENDATION ON FILE: accept the tracker's set as the demand set
      (it is what the client is delivered anyway); do NOT filter the demand
      pass by id class / value reach. Owner-visible; not a binding change.
      RULED 2026-08-19: accepted as recommended — the tracker's closure IS
      the demand set; the filtering is logged as a future improvement,
      PAIRED with lazy client instantiation, as row OW44 (the owner-rulings
      delta below carries the owner's verbatim quote).
    - **the no-grace push-growth wake / pre-seal closure refresh** — the
      two named fix shapes for the one-push-late structural-growth cycle;
      NOT built (W0's numbers did not force it: sub-second at p50 on every
      workload, mostly the 300 ms grace, and the `source` pre-emption
      makes most structure demanded before it exists). Trigger: a real
      journey that puts the growth path on its critical path.
    - **the l3 duplicate-join / vote-toggle family → W3.** The lunch gate
      was bimodal on the W0 tip (1/3 green) for a DUPLICATE-CONSEQUENCE
      family — (α)'s double dispatch toggling a vote off; a duplicate join
      rendered — made more visible by faster waves, NOT a (d′) demand hole
      (the votes were demanded and derived, twice). The root cause is
      (α)/(e) territory (W3/W2); l3's duplicate not root-caused (client
      speculative echo vs a same-drain LT1 copy). Trigger: W3 (α).
      **RESOLVED by W3 (2026-08-19):** the vote toggle was (α)'s in-flight
      late seal (OW35 CLOSED above); the duplicate join is a CLIENT
      cascade-echo stranding — W2's, handed off with the evidence (the W3
      block below).
    - **OW37 re-read on W1's numbers** — with the walk gone, the wave
      count per authored input falls (fewer exhausted waves; W0: chat
      wavesBudgetExhausted 30–35 vs the trio tip's 739–777), and the
      structural-growth path adds one cycle; re-read the §4 amplification
      ratio on W4's quiet run, never silence the assertion.
  - **W1 (d′) independent-review fixes (2026-08-19; LANDABLE-WITH-FIXES,
    0 BLOCKER / 3 MAJOR / 9 MINOR / 6 NIT — all dispositioned; review
    report on-branch at `docs/history/plans/server-execution-v2/stage-c/
    w1-dprime-review-report.md`, fix report beside it).** The three MAJORs
    were pin/register honesty, not mechanism (the (d′) code held): the
    three coverage rows above are RE-WORDED to what is now genuinely
    red-first — the per-key currency check (P-arrival-closure, RED under
    M-C), the 1→0 release (P-release, RED under M-B), and the growth
    LANDING (T2′-cross/T3′ GROWTH, RED under M-D; the M-E closure-row kill
    pinned by P-arrival-closure). OW39's "pins … red-first with recorded
    killing mutations" was true for the MECHANISM but overstated for
    three named pins; it is now accurate. Minor dispositions worth a row:
    - **MINOR-4 — the push-growth notify is now PRINCIPAL-FILTERED.** The
      serving runtime's own loopback (service-principal) session is
      dropped by the ExecutorHost (the memory server threads the changed
      session's principal; pinned red-first in
      `test/v2-demand-changed-principal.test.ts`). CAVEAT on the numbers:
      the W0/W1 `structural-growth` p50 (220–263 ms) is BOTH
      adjacency-attributed (the reports say so) AND included ~2/20
      service-driven growth notifies per (d′) run (the reports did not say
      so); W4's quiet run reads the counters net of the now-dropped service
      growth. The settle `class` prose (§7, stats.ts) now labels the
      adjacency honestly, and `demandPassMs` is labeled WALL time (it
      includes structure-load awaits), `pushGrowthWakes`/`watchWakes` as
      pre-coalescing NOTIFY counts.
    - **T10′ / MINOR-5 — the equivalence hook's real guard is fan-out's
      M-A2, not this suite.** In `executor-dprime-w0` every demanded
      writer reads only authored docs (no upstream scheduler writer), so
      `recomputeLiveRefs`'s disjunct is liveRefs-blind here and the (d′)
      T10′ is a SMOKE check; the load-bearing kill (drop the disjunct from
      `recomputeLiveRefs` only) is RED in `executor-fan-out` (f) —
      `liveness drift … incremental=1 rebuilt=0` — as the build report
      already records. A starvation-witness pin with an undemanded upstream
      scheduler writer is the strengthening the reviewer named; NOT built
      (the fan-out guard covers the disjunct); recorded.
    - **OW41 (NEW, owed) — the demand pass is O(closure) per WAVE inside
      the settle race (MINOR-6).** Measured 4.9 ms/pass at 1 922 rows /
      823 keys (incl. early structure-load awaits), ≈ ≤2.5 µs/row; linear
      — ~25 ms at 10 K rows, ~100 ms (the whole default flush deadline) at
      ~40 K. Sub-second at today's sizes; NOT a hole. The named follow-on
      is the INCREMENTAL-delta exposure (a per-space demand generation on
      the memory server, bumped on watch.set/add / push-growth / session
      prune, so a pass with an unchanged generation does only its pending
      structure-load retries) — flag 6, not built here (rebase-risk for the
      W3 builder; the cost curve is the trigger). Witness: `demandPassMs`.
    - **Ruling item 10 (LANDED here) — scopes.md §9's ragged tripwire.**
      The §9 "ragged instance sets as a steady state" tripwire forbade what
      §2's amended ruling (2026-08-16, design §5 item 10) permits; §9 now
      distinguishes the TOP (space→user) hop (uniform — forbidden ragged)
      from BELOW it (ragged per principal — the RULED stage-B mechanism,
      not forbidden). The §7 counter-list omission the same drift note
      named (`undemandedNarrowingRuns` / `earlyEmitRefusals`) was already
      folded in by W1.
- **Stage C design build delta — W2 (e) (2026-08-19) — the client
  intent watch is a NON-REACTIVE storage-notification listener keyed on
  the outstanding intent set; the schema-less whole-sidecar `cell.sink`
  is GONE; the effects channel follows (item 13); THREE RULED sentences
  LANDED (items 5/6, 8, 7). LANDED on
  `claude/server-exec-v2-w2-intent-listener` (PR #6039, built on the
  design branch; RE-STACKED onto W1's tip — PR #6029 — 2026-08-19).
  Independent adversarial review 2026-08-19: LANDABLE-WITH-FIXES (0
  BLOCKER / 1 MAJOR / 7 MINOR / 6 NIT), every finding addressed in the
  fix pass — MAJ-1 (the check applied a retired id TWICE when an
  outcome subscriber re-fired on the same sidecar) FIXED with its pin.**
  Reports:
  [`stage-c/w2-intent-build-report.md`](../../history/plans/server-execution-v2/stage-c/w2-intent-build-report.md),
  [`stage-c/w2-intent-review-report.md`](../../history/plans/server-execution-v2/stage-c/w2-intent-review-report.md),
  [`stage-c/w2-intent-fix-report.md`](../../history/plans/server-execution-v2/stage-c/w2-intent-fix-report.md).
  Rows minted here: OW42 (the fix pass; minted as OW41 — W1's branch
  had minted none at the time of minting, OW40 was the last — and
  RENUMBERED OW42 at the 2026-08-19 re-stack onto W1, whose own fix
  pass had concurrently minted OW41, the O(closure) demand-pass row;
  W1 keeps the number).
  W0's (e) gate (the design §6 refutation experiment, run FIRST on this
  branch): the interim (b) schema-narrowed sink on the note n=20 series
  collapsed the per-note client `scheduler/run` from 0.84 → 14–20 s
  (monotone, `run/commit` = the CFC probes 60–70 % of it) to a FLAT
  0.07–0.33 s, and createToView p50 from 4.03 s to 0.81 s (same
  instruments, adjacent runs, ON binaries, no LLM model; 1-min load
  in-run 2.2 → 6.3 — the BASELINE arm peaked highest (b1 6.29
  mid-series, e1 ≤ 5.01), which inflates the ratio a little; the
  flat-vs-monotone SLOPE is the robust signal) — the O(history) client
  term IS the intent sink; (a) was built (design §3.3's seven-point
  contract), the interim (b) did NOT ship (item 16: (a) replaced the
  sink outright; the (b) scratch is W0's measurement arm only, kept in
  the branch history).
  - **speculation.md §4 step 2 — the match-and-carrier sentence (items
    5 + 6) — LANDED (RULED 2026-08-18; text with W2).** Binding: the
    match is on the pushed commit's `consequenceOf`, carried to the
    client as the TRACKED entry's own `consequenced` / `status` /
    `error` fields (T7 semantics), SANCTIONED as the carrier;
    `consequenceOf` does not go on the wire; guards: tracked-entry-only
    read (its terminal fields; on a drop, its reason), never
    whole-history, never a dependency on HISTORY; always backstopped
    by `W ≥ seq(e)` / `eventWatermark ≥ seq(e)` (item 9's clause is
    folded into the same sentence). Instrument:
    `packages/runner/test/speculation-intent-listener.test.ts` — pin 1
    (consequenced retires silently; errored + dropped retire AND signal;
    `waitForIntentConsequence` per terminal kind, memo consumed), pin 2
    (an UNTRACKED id's mark is ignored), pin 5 (a sidecar with 1 000
    consequenced entries + 1 outstanding: the mark's check visits ≤ 2
    entries, ZERO transactions — the per-check-cost witness: a
    notified check located by verified hint is O(1); a moved index is
    verified by eventId and re-located from the tail), pin 7 (T25: a
    re-fired id whose consequence already landed resolves AT
    `trackIntent`, no listener leaks), pin 10 (the REAL path: the
    served mark resolves the intent by the time `synced()` / `idle()`
    armed at the mark's frame resolve and by the time the mark is
    visible on a macrotask poll, O(1) visits, the echo retires, the
    durable ack settles from the consequence — plus
    `executor-events-down.test.ts`'s full loop, whose ack assertion
    only settles through this carrier); the review pins — MAJ-1 (a
    RE-ENTRANT `trackIntent` inside an outcome callback: each retired
    id is applied exactly once — the check gates on the LIVE tracked
    set per entry, never its pre-loop snapshot; mutation: the snapshot
    gate → `dropped:X` twice and a stale memo), MIN-1 (ONE notification
    whose merged changes span TWO tracked sidecars checks both;
    mutation: record only the first wanted change → the second intent
    stays outstanding); the re-seamed pin in
    `event-append-client.test.ts` ("intent outcome consumption") now
    drives the storage-notification seam, not a hand-stubbed
    `cell.sink`. Mutations recorded in the build report's table (each
    pin red under its own mutation, or — pin 11 — the OFF witness).
  - **speculation.md §4 step 2 — "the client keeps a stream subscribed
    while it has intents outstanding on it" (item 8) — LANDED, spec home
    NAMED: speculation.md §4 beside step 2** (the client-side
    reconciliation rule belongs with the retirement it serves; events.md
    §5 is the server's failure semantics). Instrument: pin 1 (the
    sidecar is put on watch through the schema-less selector
    `sync(id, { path: [], schema: false }, "space")` at EVERY
    `trackIntent` on it — a covered watch is a replica no-op, and the
    re-kick is what heals a transiently failed first pull: review pin
    MIN-4, a `sync` that fails once (loud: `intent-watch-failed`) is
    re-issued by the next fire on that stream; mutation: kick only when
    the sidecar state is created → the second fire issues no sync), pin
    6 e2e (the appended sidecar ARRIVES in the firing client's replica
    while its intent is outstanding — the entry's arrival is checked in
    O(1) from the tail; the reviewer's MX5 probe — the watch never
    established — times out pins 6 and 10: the watch is LOAD-BEARING,
    the event-append path alone does not put the sidecar in the
    client's replica).
  - **speculation.md §4 step 2 — the non-reactive listener (item 4,
    build item; item 15 `storageManager.subscribe`) — LANDED with the
    same sentence.** Instrument: pin 6 (no `sink:…/of:stream-events:`
    scheduler node after a fire, before or after the append lands —
    mutation: keep the `cell.sink` → a node appears), pin 9 (the check
    runs in a MICROTASK, never inside the notification dispatch; a burst
    coalesces to ONE check per sidecar; a storage RESET re-checks every
    tracked sidecar), pin 8 (`close()` releases; a delivery already
    dispatched when close runs does not check; nothing after close
    subscribes), pin 10 (the design's timing guard proper: the check
    has run by the time `storageManager.synced()` / `runtime.idle()`
    armed AT the mark's frame resolve — observed from a subscriber
    registered after the listener; mutation: defer the check to a
    macrotask → both barriers read the intent still outstanding, a
    deferral the earlier macrotask-poll form of the pin could not see),
    pin 11 (OFF: no overlay, no `subscribe`, no node).
  - **The effects channel follows the same redesign — item 13, (e)'s
    SECOND step — LANDED in this PR** (`speculation/effects-channel.ts`
    over the shared `speculation/doc-notification-listener.ts`; the
    reconcile is unchanged, it now reads the RAW session instance and
    runs from a microtask; the LT8 resubscribe re-read rides the same
    schema-less `sync`). Instrument: pin 6's second half (no
    `sink:…/of:server-execution-effects/` node; `listenerInstalled`) and
    the whole `executor-effect-channel.test.ts` suite green through the
    listener (15 steps incl. the LT8 reload journey, cardinality 2, the
    receipt-race divert pin, same-principal two-session isolation).
    No follow-on row: the effects doc is small on the acceptance
    workloads (one entry + one ack per navigation), but its sink shared
    the intent sink's shape (schema-less whole-doc effect following
    `args.target` links), so it was retired here rather than measured.
  - **events.md §5 — "drops and errors ride `consequenceOf`" (item 7)
    — LANDED.** Binding: a drop notice / an error surface is the
    event's consequence, named in the writing derived commit's
    `consequenceOf`, advancing `eventWatermark` (verified in
    `space-server.ts` `#sealEventConsequenceNotice`: the notice seals as
    an event-handler-kind tx stamped with the eventId, so the wave's
    `consequenceOf` fold carries it). Instrument: the existing
    `executor-events-down.test.ts` ERROR arm and DROP arm; the client
    half by pins 1 and 2 (the `status: "dropped"` and `error` arms on
    the tracked entry).
  - **The `commonfabric.*` counter surface (design §3.3 point 7 / SB S5),
    LANDED:** the overlay's logger keys under `speculation-overlay/` —
    `intent-check` (per check: one at the fire, one per coalesced sidecar
    change while outstanding), `intent-retired-by-consequence-of`
    (an intent resolved by its tracked entry's mark), `intent-drop-notice`,
    `intent-error-notice`, `intent-refused`, `intent-echo-retired-by-
    backstop` (an intent-origin ENTRY retired by the W sweep instead —
    it counts ECHO entries swept by W, NOT missed marks: the arrival
    sweep runs synchronously inside `SpaceReplica.#applySessionSync()`
    and can retire the echo before the mark's microtask check runs, so a
    non-zero count coexists with every fire resolved by its mark — the chat
    witness below reads 2 beside 25/25), `intent-listener-installed` /
    `-released`, `intent-watch-failed` / `intent-listener-failed` /
    `intent-check-read-failed` / `intent-apply-failed` (the loud
    fail-soft arms; the last is the fix pass's per-entry guard, N-2 —
    nothing in the arms throws today); the effects channel's
    `effects-reconcile`; the overlay's diagnostic getters
    `pendingIntentCount`, `intentListenerInstalled`, `intentCheckCount`,
    `intentCheckVisits` (the `sidecarEntriesRead` witness),
    `intentCheckMaxVisits`; the browser churn line
    (`cfc-browser-helpers.ts`) gained `overlayIntentChecks` /
    `overlayIntentsByConsequenceOf` / `overlayIntentEchoBackstops`.
    `pendingIntents` = `pendingIntentCount` (a gauge; not a logger key).
  - **W4 witnesses (client side), PROVISIONAL numbers on the W2 tip
    `7a5481d14` (ON built binary sha `7964711e835ea16f`, gitSha read per
    run, `No default model available`, fresh store; the design tip's
    server — the walk still present — so the cross-user numbers are
    W1's territory):** note createToView **FLAT in history** —
    per-note `scheduler/run` 71–170 ms across n=20 (baseline on the
    design tip the same hour: 0.84 → 14–20 s), createToView series
    `1145 692 637 878 765 741 932 444 879 415 596 474 1275 1166 876 887
    574 793 1879 778` ms (p50 ~0.79 s vs the design tip's 4.03 s and
    W0's 4.09 s; first-10 median 764 / last-10 876 — no slope), 1-min
    load 3.46 → 6.07 during the run (the note arms' loads were NOT
    equal: b1 peaked 6.29, e1 5.01, a1 6.07 — the slope is the signal,
    the ratio indicative); the sink effect no longer exists (0 runs, 0
    ms; the design tip: 9–19 runs and 142 → 4 096 ms per note); chat
    n=20 (1-min load 3.9 → 7.6 in-run): `overlayIntentChecks` 75 for
    25 fires (3 per intent: fire, append landing, mark),
    `overlayIntentsByConsequenceOf` 25/25 (every fire resolved by its
    mark), `overlayIntentEchoBackstops` 2 (echo entries the arrival
    sweep reached first — see the counter bullet; not lost marks),
    cross-user median 11.3 s (the trio tip 7.4–9.7 s: the walk term,
    unchanged by (e), plus load) — the client-local speculation latency
    is preserved by construction (the fire's own echo runs are inside
    the flat 71–170 ms per-note client budget); a DEDICATED sender-echo
    instrument (click → own render) does not exist in the harness and
    is W4's to add (recorded). The fix pass changed one client-side
    cost (the per-fire watch re-kick, MIN-4 — a covered watch is an
    O(1) tracker lookup, no wire); its PROVISIONAL note n=20 series is
    in the fix report.
  - **OW40 (step 4's rebase) — re-read, unchanged:** the listener
    RETIRES and never rebases; an outstanding echo stands until its
    mark or the backstop, as the sentence says; nothing learned moves
    the row.
  - **OW42 — the tracked-set DRAIN when a mark never arrives: an
    outstanding intent whose sidecar entry is GONE before this client
    saw its mark never resolves — `waitForIntentConsequence` hangs,
    and with it the caller's durable-ack `onCommit` (`cell.ts`'s
    flag-ON send path routes the ack through it: the CLI verb dispatch
    / the webhook forwarder would wait forever) — the ECHO still
    retires by W.** Numbered in the W2 fix pass (independent review
    MIN-3; the build had it "recorded, not a row"; minted as OW41 and
    renumbered OW42 at the 2026-08-19 re-stack onto W1 — W1's fix pass
    had concurrently minted OW41, the O(closure) demand-pass row, and
    keeps the number). Verified
    UNREACHABLE today: the watermark is recomputed from the contiguous
    consequenced frontier, so `eventWatermark ≥ seq(e)` implies the
    mark is present, and nothing else removes an entry — only
    stream-entry compaction (OW24, unbuilt) could. Pre-existing with
    the sink (the same tracked set, the same hang). Owed: in
    `#checkIntents`, record the entry's `seq` at first sight and treat
    `eventWatermark ≥ seq` with the entry GONE as consequenced — item
    9's fact applied to the tracked SET (~10 lines) — with a pin whose
    scripted sidecar compacts the entry away under an advanced
    watermark. Trigger: OW24 — the compaction PR cannot land without
    this row (the two rows close together); earlier if any path other
    than compaction is found to remove a sidecar entry.
  - Not rows, recorded: (i) the cost of the check AS BUILT (the spec
    sentence was corrected to it in the fix pass — review MIN-2; the
    ruling says nothing about cost): the immediate check at
    `trackIntent` walks the raw array once, O(E), for an id whose entry
    is not yet present (a plain JS array walk, no transaction; T25
    needs it; pin 5 asserts the 1 000 visits) — `intentCheckMaxVisits`
    reports it; a NOTIFIED check is O(outstanding + hinted indices),
    and a change with no usable index (an append, a moved hint)
    degrades to a backward tail scan over the entries appended AFTER
    the tracked one — O(k) per notification while an intent stays
    outstanding on a busy shared stream (µs at k ≈ 100; memoizing each
    located index into the hint set would make later checks O(1), not
    done — flagged, not ruled). (ii) The backward (tail-first) scan
    reads the TAIL-MOST entry for a tracked id: when a T25 duplicate
    coexists with its consequenced original, the listener waits for the
    duplicate's OWN mark (the skip path seals it consequenced without
    error → signals `consequenced`); the old forward scan read the
    original's mark (and its `error`, if any). This fire's own
    consequence — a behavior delta in that corner, stated (review N-3).
    (iii) The re-seamed `event-append-client` pin's first delivery uses
    the whole-doc path and so exercises the tail-scan arm only; the
    hinted arm is pinned in the new suite (review N-6). (iv) The
    scripted harness's change addresses carry the production scope
    (`scope: "space"`, as `differential.ts`'s `toAddress` sets) since
    the fix pass, so the `wants` scope filter is exercised by the
    scripted pins too (review MIN-6; before, only e2e pins 6/10 saw the
    production shape).
  - **W2.1 (2026-08-19) — the CLIENT CASCADE-ECHO STRANDING (W0 l3's
    "duplicate join", root-caused by W3 and handed to W2) — FIXED, shape
    (a): `retireIntent(P)` also retires P's client cascade
    descendants.** Report:
    [`stage-c/w2-1-cascade-echo-report.md`](../../history/plans/server-execution-v2/stage-c/w2-1-cascade-echo-report.md).
    Binding text: speculation.md §4 step 2's DATED clarification beside
    the late-echo rule (descriptive — the jobless-cascade consequence
    read on arrival; not a new rule). What it binds: when the terminal
    consequence of intent `e` arrives (consequenced / errored / dropped
    / refused — every arm reaches the one seam), every live overlay
    entry whose cascade thread (`OverlayEntry.parentEventId`, recorded
    at the cascade echo's seal; `#cascadeParents` links a child that
    wrote nothing to its grandchildren) reaches `e` retires with `e`'s
    own echo; the retired descendant's id joins the jobless set (a LATE
    grandchild drops at seal). Scope: client-minted descendants of
    `e`'s speculative run only — never a durable entry of its own, never
    an unrelated intent's cascade, never a derivation echo. Guards kept:
    no dependency on history (the thread is process-local and bounded
    like the jobless set); the parent's own retirement is still the
    sanctioned mark / the `W ≥ seq(e)` backstop — the descendant rides
    the parent's signal (in the fail-soft posture where neither the
    listener nor the watch installed, the descendant has no backstop of
    its own — as before W2.1; stated). Instrument:
    `speculation-intent-listener.test.ts` — **W2.1-1** (a cascade
    child's echo is retired when P's MARK arrives; RED on the pre-W2.1
    tip: `entryCount` 1 ≠ 0 — the entry stood forever; mutation: the
    cascade arm removed), **W2.1-2** (P's mark retires ONLY P's cascade:
    an entry with an unrelated parent, another intent's root echo, and
    an untracked emitter's cascade stand; mutation: the walk accepts any
    parented entry), **W2.1-3** (the late-echo rule holds around the
    arrival arm — a LATE child and a LATE grandchild of the retired
    child drop at seal; a grandchild behind a SILENT no-write child is
    reached through the thread; mutations: the thread not recorded at a
    no-write seal / the retired child not joining the jobless set),
    **W2.1-4** (the flicker witness counts a cascade echo retired on
    its parent's consequenced mark while NO doc it wrote landed at or
    after the mark's frame — including when a CONCURRENT writer moved
    the doc past the echo's basis first (the two voters' shape) — not
    one whose written doc rode the mark's frame, and not a dropped
    parent's cascade; mutations: key on the basis → the concurrent-
    writer case reads arrived; arm on the drop arm → it counts), and
    the **W2.1 e2e** pin — the lunch
    join shape through the real path (a click handler that only forwards
    to a handler that cellifies a NEW object into a list, one flag-ON
    client + a live ExecutorHost): on the pre-W2.1 tip it times out at
    "the cascade child's echo to retire" (the stranding, reproduced
    end to end); with the fix the echo retires on the click's mark, the
    rendered list holds exactly the server's one entry, the counter
    reads 1, unarrived 0. OFF arm: pin 11's shape unchanged — every
    W2.1 line lives inside the overlay, which does not exist OFF. The
    lunch gate's "both join lands" step now asserts the CONFIRMED
    roster (exactly {Alice, Bob} chips on BOTH browsers + "2 joined"),
    RED on a standing echo (7–16 ms on the pre-W2.1 tip), green only on
    the real landing (3.3–5.1 s across 6/6 green runs at the W2.1 tip
    without (α); 253–255 ms across the 6 green runs at loads ≤ 12 on
    the W2.1 + (α) scratch — each ≥ a server round trip); the ON skip
    entry is W3's to lift — and **must NOT lift on these runs:
    BLOCKER-class flag (2026-08-19, W2.1 report §6b) — on the W2.1 +
    (α) scratch the gate is RED at "both voters' swatches visible" in
    5 of 13 runs (60-s timeout; the store clean in every one, both
    votes durable, "2 love it" rendered on both browsers 300–700 ms
    after the clicks), while W3's own tip is 3/3 green under HIGHER
    load and W2-on-W3 WITHOUT W2.1 2/2 green under far higher load:
    the stall is attributable to W2.1 in the (α) configuration — the
    voter's own vote ECHO retired at the click's mark (the designed
    flicker; the purged castVote child lands a wave later), and the
    CONFIRMED own vote then not rendering its swatch on that browser
    within 60 s. Not root-caused; candidates named in the report (the
    confirmed own-vote entity doc — a new id the client never read —
    not reaching the voter's replica after the echo's entity layer
    dropped; or the swatch re-derivation after the superseded flip
    racing the next frame). Before W2.1 the stranded echo carried the
    own swatch forever, so every baseline is green by masking. (b)
    would remove the exposure (the echo stands until the child's own
    landing). Owner / W3 / W2 call; the evidence, the three baseline
    worktrees and binaries are in the report. UPDATE 2026-08-19
    (W3.1): the stall is root-caused (the coordination delta below;
    OW43) and its CLASS FIX landed — S1's drain-settle quiescence
    advance (RULED 2026-08-19) makes the diverged layer's retirement
    reachable on a quiet space, so the blocker mechanism is closed;
    the designed FLICKER itself (the cascade echo retiring at the
    parent's mark, one wave before the drained child lands) remains
    W2.1's designed cost, and shape (b) — deterministic cascade ids,
    the FUTURE row below — stays the flagged follow-on that would
    remove the flicker too. The lunch skip's lift rides the W3.1
    lunch gate's evidence, not this flag.** Counters:
    `speculation-overlay/cascade-echo-retired` and
    `…/cascade-echo-retired-unarrived` (the flicker witness, armed only
    on a consequenced non-error parent: no doc the echo wrote held a
    confirmed value at or after the MARK frame's seq — the sidecar's
    confirmed seq at the check — when it went; keyed on the mark's
    frame, not the echo's basis, because a concurrent writer moves the
    doc past the basis without the child having landed — a HEURISTIC,
    two misreadings stated on the getter: an unchanged authoritative
    value reads as unarrived; a foreign write landing in the mark's own
    frame at or after the mark reads as arrived), getters
    `cascadeEchoRetirementCount` /
    `cascadeEchoRetirementUnarrivedCount`, the browser churn line's
    `overlayCascadeEchoRetired` / `overlayCascadeEchoFlickers`. Lunch
    witness: at the W2.1 tip (no (α)) `overlayCascadeEchoRetired` 2 /
    `…Flickers` 1 on the host every run — the join child landed one
    wave AFTER the click's mark (commit 45 the click, 46 the child's
    `users` splice), so spec-Alice went at 45 and the confirmed Alice
    arrived at 46: the flicker, live; on the (α) scratch the JOIN child
    rode the click's wave (0 for it), and the purged castVote leftover
    (`lt1LeftoversPurged 1` in ~1 run in 2: the click alone in one
    commit, the drained child in the next) is the flicker the mark-
    frame-keyed witness catches (0–1 per browser per run).
    **UPDATE 2026-08-20 (combined W2.1+S1 review, F1 MAJOR — FIXED on
    the train tip):** the seal-time jobless checks were ONE LEVEL deep
    (eventId or direct parent) while the thread can be deeper — a LATE
    grandchild of a SILENT (write-less) cascade child sealed after the
    root's mark passed both checks, registered, and stranded forever
    (the silent child has no entry, is never retired, never joins the
    jobless set; probe-verified by the reviewer: `entryCount=1,
    dropped=false, retired=false`). Both checks (pre-seal and the
    post-`sealInto` re-check) now walk the `parentEventId` chain
    through `#cascadeParents` (`#joblessByAncestry` — the
    `#cascadeReaches` walk on ids). Pins, red-first on the pre-fix
    code: W2.1-3 extended with the late-silent-grandchild seal (RED:
    the entry registered, drops +2 not +3), **W2.1-6** (the mid-seal
    mark arrival caught at the post-`sealInto` re-check through the
    chain; RED: `entryCount` 1, no drop). The review also named the
    SILENT truncation modes (F6 MINOR): a `#cascadeParents` eviction at
    the 4096 bound and a walk stopped at the 64-hop depth cap are
    indistinguishable from "no ancestor" at walk time — both now
    COUNTED (`cascadeThreadEvictionCount` / `cascadeWalkDepthCapCount`,
    logger keys `cascade-thread-evicted` / `cascade-walk-depth-capped`;
    pin **W2.1-7**), so if either bound is ever hit in the wild the
    stranding presents WITH telemetry (the strand itself remains the
    stated bounded-design posture — eviction needs ~4096 cascade seals
    within one intent round trip). The flicker-witness docstring on the
    churn surface (F5 MINOR) was still basis-keyed text from before the
    witness refinement — rewritten to the mark-frame semantics with
    both heuristic biases and their directions stated.
  - **FUTURE / owner-level — (b) deterministic cascade ids (NOT built;
    the reason the flicker exists).** Derive a cascade child's event id
    on BOTH sides from the parent event id + the send ordinal within the
    parent's run (instead of `mintEventId`'s per-tx random key): then
    the client's cascade echo carries the SAME id as the server's LT1
    entry — `retireIntent` matches it by its own mark (no thread walk),
    AND the handler-frame-caused entity ids agree (`$event:
    tx.dispatchedEventId`, runner.ts), so step 3's arrival gate passes
    and the echo stands until the child's OWN consequence lands — no
    flicker in the purged-leftover case, and a tracked intent per
    cascade hop if wanted. What it touches: `event-identity.ts`
    `mintEventId` and events.md §4's "cascade sends minted inside a
    handler attempt get fresh ids per attempt" (the per-attempt
    freshness that keeps a retried attempt's cascades apart; a
    deterministic id must then carry the attempt or rely on the
    committing-attempt-only escape), the C8d fold key and the served
    dispatch's `parentEventId` carriage, the LT1 emission in `cell.ts`
    (both arms mint), and the client cascade's `queueEvent` id. Better:
    no flicker, the child's own mark retires its own echo, one identity
    for one cascade hop. Worse: a spec-level identity change (events.md
    §4), two code paths that must agree byte-for-byte, and a retry
    story to re-rule. Owner-level; put to the owner 2026-08-19 —
    ACKNOWLEDGED / DEFERRED (below). Trigger: the OPEN swatch stall
    (5/13 at the W2.1 + (α)
    configuration, 2026-08-19 — (b) structurally removes the exposure:
    the echo stands until the child's own landing) if the root cause
    lands in this seat; the flicker witness reading non-zero on the W4
    acceptance workloads at a rate the owner will not accept; or when
    per-hop intents are wanted.

    **ACKNOWLEDGED / DEFERRED by the owner — 2026-08-19.** Owner, in
    chat:

    > ack, revisit later if flicker is too high or as optimization.
    > honestly, flicker might be acceptable for a first launch since
    > status quo flickers as well.

    — owner (Berni), 2026-08-19. The trigger above is CONFIRMED as
    written, with the owner's judgment recorded beside it: the flicker
    is likely ACCEPTABLE for a first launch (the status quo flickers
    as well), which SOFTENS W4's flicker bar — W4 still reports the
    flicker counters, so "too high" stays a number the owner can read,
    not a feeling. Not scheduled; revisit if that number is too high,
    or as optimization.

    **Instrument bias note (2026-08-20, combined review F4 — the
    trigger's counter is a floor, not an exact count).** The flicker
    witness (`overlayCascadeEchoFlickers`) systematically UNDER-counts
    the COALESCED-PURGED shape: when both voters' clicks mark in ONE
    commit that carries the OTHER voter's confirmed add while THIS
    voter's child was purged (the root-cause report's green-run shape,
    s6/s13 — a COMMON shape, not a corner), the shared list doc moves
    to the mark's own seq via the foreign write, reads "arrived", and
    the purged voter's real one-wave flicker is NOT counted. It also
    over-counts on the equality cutoff (an unchanged authoritative
    value moves no seq and reads "unarrived") and on a late same-frame
    sidecar append over-stating the mark seq. Directionally: whoever
    reads this row's trigger at W4 should treat a NONZERO reading as
    real flicker evidence and a LOW/ZERO reading as NOT proof of
    little flicker — the bias in the common shape is downward. A
    seq-level witness cannot attribute a same-frame move to a specific
    writer; counting the shape exactly needs value-level (or
    writer-attributed) evidence — deliberately NOT built in the fix
    round (it would change the decision instrument right before the
    owner reads it); the biases are now also stated on the churn
    surface's docstring (F5). Disposition: NOT CHANGED (code), this
    note is the register record.
- **Stage C design build delta — W3 (α) LANDED (2026-08-19).** One
  durable stream entry is delivered to its handler exactly once as a
  COMPLETED run (events.md §4, RULED 2026-08-18); the build is the
  stacked PR `claude/server-exec-v2-w3-alpha`, built off W1 and
  re-stacked onto W2's tip 2026-08-19 (no CI — every green a local
  run; report
  [`stage-c/w3-alpha-build-report.md`](../../history/plans/server-execution-v2/stage-c/w3-alpha-build-report.md)).
  It closes OW35 (above) and lands events.md §4's LANDED note naming the
  three seats. Coverage row per sentence of the RULED paragraph:
  - "One durable stream entry is delivered to its handler exactly once
    as a COMPLETED run, regardless of dispatch path or reference count"
    — COVERED by the run-count pins (`executor-events-down.test.ts`
    "(α1)+(α1b)+(α4)", "(α1b)+(α4)"): the child handler's non-idempotent
    effect applied exactly once per durable entry and exactly one
    derived commit naming each event, under a flush deadline that cuts
    the appending wave with one LT1 copy running and one queued. Killing
    mutations recorded in the report (the true double needs BOTH the
    seal refusal and the orphan arm's absent-emitter clause off: the
    effect applied three times / twice). **Review fix (2026-08-19):**
    the same-eventId SIBLING shape — an LT1 copy whose run commits a
    separate event-handler-stamped tx (the served navigateTo intent)
    before an await spanning the deadline — is pinned by "(α1b)+(α4) +
    a same-eventId SIBLING tx": RED on the build tip (the sibling's
    survival marked the entry; the refused handler copy was never
    re-delivered — `processed` 1, the effect 0×, a LOST delivery),
    green with the marking keyed on the copy's OWN run (`lt1 === true`);
    the effect once, the sibling's write once, `processed` 2; the
    store-side per-event commit count reads 2 for this split and is
    recorded as not the witness. Pin 1 additionally holds its gate
    across ≥2 further deadlines with the drain's `streamEntry` copies
    queued (review m1): an over-reaching purge predicate (`served !==
    undefined` alone) is RED there (`lt1LeftoversPurged` 3 ≠ 1) — the
    discriminator is now guarded by the α pins, not only by the trio's.
  - "An entry whose in-process (LT1 same-wave) run does not complete
    within its appending wave is dispatched by the drain alone; the
    serving loop purges unrun in-process leftovers at the flush deadline
    and skips at the drain any id already queued or run with a durable
    entry" — COVERED by (α1) `#purgeLt1Leftovers` at both `exhausted`
    arms (pin: `lt1LeftoversPurged` 1 for the queued child; mutation:
    purge skipped → 0 and the copy is refused at the seal instead,
    `lt1LateSealsRefused` 2), by (α1b) the late-seal refusal (pin:
    `lt1LateSealsRefused` 1 for the parked child; `childRuns` 2 — the
    refused copy and the drain's), and by (α2) the trio's guard, verified
    by reading (held copies are `queued` to the guard; one producer of
    `streamEntry`-bearing copies) — its pin is the trio's
    ("exactly-once under an HONEST flush deadline"); a shaper-HELD-copy
    pin is NOT added (FOLLOW-ON, see the report's not-done list) — and
    the follow-on should cover the shaper-held LT1 copy too, not only
    the drain-held one (review m3): an LT1 copy forwarding a
    renderer-trusted event is HELD by the wake shaper, out of the
    purge's `eventQueue` reach, released into a later wave and caught by
    (α1b) there — exactly-once holds, `lt1LateSealsRefused` grows
    routinely for it (the counter doc says so now).
  - "A derivation-kind emitter's superseded LT1 leftover re-arms nothing
    and its orphan delivery is REFUSED (never delivered without a durable
    entry)" — COVERED by (α3): the orphan arm in the wave's requeue
    closure (pin "(α3)": `orphanDeliveriesRefused` 1, the witness doc
    saw only the rival's tag, every consequenced id has an entry;
    mutation: the arm removed → "ping" delivered with no entry) and by
    (α1)'s purge for a not-yet-run copy (no notice, no re-arm: the copy
    carries no failure hook and no commit callback). **Review fix
    (2026-08-19, M1):** the arm folds the copy's same-eventId SIBLINGS
    (the inline intent tx) into the refusal and counts once per EVENT —
    pin "(α3) + a same-eventId SIBLING tx": RED on the build tip (the
    handler half refused, the intent half LANDED — `side` 1), green with
    the fold (`side` 0, `orphanDeliveriesRefused` 1 for two folded
    contributions).
  - Counters (serving-loop.md §7 `events`): `lt1LeftoversPurged`,
    `lt1LateSealsRefused`, `orphanDeliveriesRefused` — asserted in the
    pins; read on the live runs (lunch 1/0/0 per run; chat 0/0/0).
  - **DECISION (flag-don't-fill) — the lunch ON skip STAYS, its reason
    rewritten.** The lift rule's two conditions are met literally (the
    (α4) pins green; the gate 3/3 green fresh-store on the W3 tip), but
    the l3 root cause below shows the gate's "both join lands (count
    reaches 2)" step has been passing on a stranded CLIENT echo (7–16 ms
    after the guest's click in every green run — W0 l1/l2, W3 l1–l3 —
    faster than any server round trip) and fails when the first probe
    lands after the guest's confirmed join (W0 l3: "3 joined"). Lifting
    would knowingly re-expose the ON lane to a ~1-in-8 flake whose
    mechanism is W2's (the alternative, named: lift now on the literal
    rule and accept the flake until W2 lands). Lift condition restated
    in the entry: W2's cascade-echo fix (or the step re-pointed at the
    CONFIRMED count) + 3/3 green. Owner-visible.
  - **l3 root cause (W0's "3 joined") — NOT (α); W2 / T2 territory,
    handed off with the evidence.** The join is a CASCADE child: the
    `#lp-join-button` click lowers to a handler (stream `FkFw…`) whose
    served run emits `joinAs`'s event (stream `lalq…`, payload `{}`)
    as an LT1 same-space emission, consequenced in the same commit as
    the click (W0 l3 store: commit 42 = click + child; `users` spliced
    ONCE per join — commits 42 and 52 — so the server holds 2 joined; 8
    events, each in exactly one `consequence_of`; `appended 6 /
    processed 6`). On the client the speculative click echo sends the
    same `{}` to `boundJoin`, minting a cascade id from its own tx
    (`mintEventId(link, originTx)` — a random per-tx key) that never
    equals the server's LT1 id (another random key); `retireIntent`
    retires by EXACT eventId, so the child's echo is never retired by
    the parent's consequence; the late-echo rule (T2/OW36) does not
    apply (the child sealed ~8 ms after the click, before the served
    consequence); and the sweep's ARRIVAL gate never passes because
    `joinAs` cellifies the new `user` into a doc whose id derives from
    the frame's cause — `$event: tx.dispatchedEventId` (runner.ts) — so
    the client's entity (`$event` = the client cascade id) ≠ the
    server's `NYEME…`, and the spec entity doc never holds a confirmed
    value. The host page renders overlay spec-Alice + confirmed Alice +
    Bob = "3 joined, Alice, Alice, Bob". Candidate shapes for W2, not
    filled: (a) `retireIntent(P)` also retires the cascade children
    whose `parentEventId` chain reaches P (the late-echo rule's jobless
    logic applied on arrival; a visible flicker when the LT1 child lands
    a wave later); (b) deterministic cascade ids derived from the parent
    id + send ordinal on both sides (then `retireIntent` matches and the
    `$event`-caused entity ids match, so the arrival gate passes) —
    touches events.md §4's per-attempt freshness; owner-level.
  - **OW37 re-read on W3's numbers** — (α) adds no wave: the purge and
    the refusal run inside existing cut cycles; the lunch runs show
    `derivedCommits == waves` (61/61, 52/52, 52/52) with
    `wavesBudgetExhausted` 38 / 26 / 25 — the deadline-honesty shape the
    trio named. CORRECTED (review m2, 2026-08-19; the first wording said
    "fewer … by noise", the wrong direction): W3's exhausted ratios are
    0.62 / 0.50 / 0.48 (38/61, 26/52, 25/52) against W0's l1–l3 0.46 /
    0.39 / 0.26 (21/46, 17/44, 10/38) — HIGHER, and confounded by load
    (W3's 1-min load 4.5 / 6.9 / 5.5 before each run → 8.8 / 8.3 / 5.7
    after; W0's l1–l3 5.0 / 2.9 / 3.6 before, from the driver logs); not
    a comparison, not silence. The ratio metric stays owed to W4's
    quiet run.
  - Chat n=20 smoke (PROVISIONAL, one run, load 9.4–9.6 — a concurrent
    benchmark on the box; NOT comparable to W1's 1 239 ms): series
    complete, median 1 541 ms (q1 1 408 / q3 1 818 / max 3 208);
    `events appended 28 / processed 28`, purge/refusal/orphan 0/0/0 —
    (α) is passive on the chat path.

- **Stage C coordination delta (2026-08-19) — the swatch stall
  ROOT-CAUSED; one row minted (OW43; nothing renumbered).** The
  blocker-class stall flagged in the W2.1 row above (5/13 at the
  W2.1 + (α) configuration; "Not root-caused; candidates named") is
  now root-caused and the candidates there are SUPERSEDED — report
  [`stage-c/swatch-stall-rootcause.md`](../../history/plans/server-execution-v2/stage-c/swatch-stall-rootcause.md):
  under (α) the purged castVote child makes the lagging voter's click
  a mark-only commit; W2.1's cascade-echo retirement at that mark
  visibly regresses the client; the re-derivation from the regressed
  base seals a DIVERGED speculation layer — a literal
  `splice remove@1` tombstone over the swatch VDOM doc — under which
  the server's healed derivation ARRIVES (delivery fine) and stays
  masked, because both convergence paths are dead: no re-run (the
  swatch computed is an undemanded pull computation — a legal
  scheduler idle; a settle does not run it) and no retirement (the
  space-server's watermark freezes below the layer's floor on a quiet
  space until the next authored commit — probe-verified: one
  keystroke healed the stalled browser in one poll). All 5 builder
  reds plus 8 instrumented reproductions ONE class (arm A
  i6/i7/i10/i15 + arm B f1/f7/f9/f10; recorded as 7 when this block
  was minted — corrected by W3.1 per the report's own tables)
  (delivered-but-masked); 0 never-delivered; 0 B1; F1 tested and
  orthogonal (4/10 vs 5/13). Fix seats S1–S4 are with the owner —
  the plan's coordination block carries them and the S1 ruling
  request (its item (10)).
  - **OW43 — the overlay sweep's accepted-lingering premise ("values
    converge, rendering stays correct") is FALSE under regressed-base
    re-derivation — a diverged layer can mask a DELIVERED value —
    CLOSED 2026-08-19 by W3.1 (S1)**, per the row's own trigger ("the
    chosen fix seat's landing (S1 closes this row)"): the drain-settle
    quiescence advance landed — protocol.md §4's RULED 2026-08-19
    amendment, the space-server seat, pins
    `executor-settle-advance.test.ts` (red-first on the pre-S1 tip:
    the frozen-W i10 shape and the diverged-layer masking reproduced
    RED, then healed with NO authored traffic) — so every layer's
    floor is reachable on a quiet space, and the premise the sweep's
    comment now states is true. The original row, for the record:
    The sweep's comment accepts entries lingering on a then-quiet
    space under the premise that lingering layers hold CONVERGED
    values; a re-derivation from a flip-regressed effective base
    (W2.1's cascade-echo retirement at a mark-only commit is the
    known producer; any regressed-base re-derivation racing an
    arrival can mint one — e.g. a rejection-revert racing pushes)
    seals a layer whose value DIVERGES, and the delivered, healed
    confirmed value beneath it is masked indefinitely (the swatch
    stall; report §§3–4). Owed: make the premise TRUE (S1 — the
    watermark covers the tail derivations at drain-settle, so every
    layer's floor is reachable on a quiet space) or make the sweep
    handle the diverged case explicitly; S2/S3 remove the only known
    producer but leave this hole open. The flicker witness
    (`…/cascade-echo-retired-unarrived`) is the live, cheap predictor
    of the poisonous window (5/5 on the builder's reds; marks the
    stalled browser in every instrumented red) — necessary, not
    sufficient (report §1). Trigger: the chosen fix seat's landing
    (S1 closes this row; under S2/S3 the row STAYS until the
    retirement hole is closed or explicitly accepted) — in any case
    before the lunch ON skip lifts and before W4's `waitForSettled`
    numbers are read at quiescence.

- **Stage C W3.1 (S1) delta (2026-08-19) — the drain-settle
  quiescence advance LANDED (the ruling at the plan's owner item
  (10): owner, in chat, "S1 sounds good"; OW43 CLOSED above).**
  Coverage row for the amended sentence:
  - protocol.md §4, the quiescence-advance amendment ("at
    drain-settle ... W additionally advances over the space's
    committed TAIL DERIVATIONS", with the stated reading that W's
    definition quantifies over authored commits only, the
    once-per-transition latch, the never-chased advance commit, and
    the fail-closed hole rule) → seat
    `packages/runner/src/executor/space-server.ts` (the wave cycle's
    advance computation; `#ownWaveSeqs` + `#settleAdvanceOwed`),
    `wave.ts` `contentContributionCount`, `stats.ts`/`host.ts`
    `settleAdvances` → pins `executor-settle-advance.test.ts`:
    (1) the frozen-W i10 shape (RED on `e386a01be`: "W frozen at
    input coverage; derived tail 4"; GREEN: the advance lands with NO
    authored commit and reaches the client via the ordinary
    watermark-doc push), (2) the diverged layer retires at quiescence
    and the healed confirmed value renders (the report §5 probe
    shape as a minimal seam — a stamped derivation-kind re-derivation
    over the pushed derived value; RED masked 30 s), (3+5)
    idempotence/no-self-chase + busy-space neutrality (the killing
    mutation: removing the latch consume storms — one advance per
    echo cycle — caught in 920 ms; arming the latch on
    bookkeeping-only waves is INERT because the consume runs after
    the arm, stated here so nobody "fixes" the ordering), (4) the
    OFF witness (no SpaceServer, no derived commits, no watermark
    doc). Serving-loop §3's drain-settle step and §7's counter
    vocabulary updated in the same commit; the sweep comment's
    accepted-lingering premise rewritten to the now-true form.
  - FLAGGED test edits (not silent fixes): the serving-loop
    stability pin now waits for the designed trailing advance before
    sampling its 400-ms window (meaning unchanged — stabilize, no
    self-chase — and it now also witnesses the advance's
    no-successor guarantee); sx2-serving-loop's waves and
    amplification budgets subtract `settleAdvances` and add the
    once-per-transition bound (`advances <= authored + 1`).
  - Residuals, stated: (i) the advance never fires past a LATE
    authored record (a notice arriving after a later echo advanced
    the input head — the in-order coverage math skips it, so W stays
    below that seq until the next ordinary input; pre-S1 behavior,
    unchanged, now the one remaining stall residue of that rare
    interleaving); (ii) the walk's fail-closed hole rule is
    construction-guaranteed (Set membership over dense engine seqs),
    not pinned by a dedicated in-flight-notice interleaving test — a
    deterministic seam would need a notice-holding server shim
    (flagged, not filled); (iii) the one derived commit W does not
    cover at quiescence is the final advance-carrying bookkeeping
    commit itself, definitionally — a client derivation READING the
    watermark doc could carry that seq in its floor and linger to
    the next transition (no known reader does; the id class is
    excluded from piece demand); (iv) **[FOUND by the combined review
    2026-08-19 (F2 MAJOR) — FIXED 2026-08-20 in its fix round]** the
    once-per-transition latch was consumed even when the advance-only
    wave picked up CONTENT mid-seal (a transaction sealing between the
    quiescence gate's snapshot and the wave detach joins the still-open
    closing wave — the watermark-tx commit and `#sealChain` awaits are
    the window): the fold's content armed the latch, the seal-consume
    immediately erased it, and the folded seq — ABOVE the advance's
    pre-fold target — stayed uncovered until the next authored input
    (the swatch-stall shape, reintroduced in a microtask-wide race;
    same consequence bound as residual (i), but S1's own bookkeeping
    and previously unflagged). Fix: the consume is gated on
    `closing.contentContributionCount === 0` — a fold leaves the latch
    armed and the NEXT quiescence covers the folded tail (the
    reviewer's probe-validated shape, 28/28 green against the pinned
    population). Pin 6 makes the interleaving DETERMINISTIC (a
    serving-runtime `edit()` wrapper injects a derivation-kind commit
    when the quiescence advance's watermark write commits, then
    asserts the fold landed in the SAME wave commit — loud abort
    otherwise) and was RED on the unfixed code: W frozen below the
    folded seq, timeout. The sweep comment's "every floor is reachable
    on a quiet space" carries the pointer.
  - For OW38/W4: quiescence advances are split in the stats
    (`settleAdvances`), so the settle-time metric excludes the
    advance-only waves; the growth-landing adjacency attribution is
    UNCHANGED (a quiescence advance right after a growth wake can
    still take the landing slot — the pre-existing MINOR-4
    heuristic, now cross-referenceable against the settleAdvances
    series timestamps).
  - The LUNCH GATE at the W3.1 tip (`f250feacd`, ON-built binary
    sha256 `53a712cede690b6e…`, fresh store + posture + `No default
    model available` per run, loads 2.3–3.7): **6/6 GREEN**, totals
    3 467–4 334 ms, joins honest (confirmed roster) 254–256 ms, and
    the stalled step — "both voters' swatches visible" — walled at
    **1 ms in every run** (no 28-s recovery, no timeout); events
    appended/processed 11/12 with the one purged LT1 leftover in 4
    runs and 11/11 in 2 (the clicks coalesced — no purge; both
    shapes exactly-once); consequence multiplicity **{1:16} in all
    six stores**; settleAdvances 10–13 per run (S1 live at
    quiescence). **The lunch ON skip is LIFTED** (the entry removed;
    the ledger lives in `tasks/server-execution-on-skips.ts`'s
    header comment; the skip-list test asserts the one-entry state).
    Chat n=20 smoke at the tip (PROVISIONAL, one run, load 4.3–4.4):
    series complete, median 544 ms (q1 459 / q3 563 / max 622),
    events 28/28, purge/refusal/orphan 0/0/0, settleAdvances 54 over
    193 waves — quiescence-only, never per-wave (busy-path
    neutrality at workload level).

- **Stage C owner-rulings delta (2026-08-19) — the four open owner
  items answered in chat; one row minted (OW44).** No owner question
  stays open on the arc after this batch (#5968's Flags 1–4 remain on
  file awaiting ratify-or-direct, flagged, not blocking). The four:
  α1b — events.md §4's late-seal-refusal clarification RATIFIED as it
  stands in the W3 fix pass's amended form (owner, verbatim: "ack");
  the RULED 2026-08-19 marker and the attributed quote live in
  events.md §4, the DATED/AMENDED trail kept as history, and the
  split-residual tightening stays a named, not-built follow-on. OW31's
  READ side — RULED 2026-08-19 (the OW31 row above carries the
  verbatim quote): the service identity reads the ACL ONLY, every
  other served read runs under the acting user's identity, SUPERSEDING
  the scoping report's read-only-service-class recommendation, with
  the flag-don't-block escape hatch recorded; build unchanged — owed
  post-merge, before the flip PR. Shape (b) — ACKNOWLEDGED / DEFERRED
  with the trigger confirmed and the owner's first-launch-flicker
  judgment recorded on the FUTURE row above (it softens W4's flicker
  bar; the counters still report, so "too high" stays a number). W0's
  flag 9 — the tracker's closure ACCEPTED as the demand set, the
  filtering logged as a future improvement paired with lazy client
  instantiation: the row below.
  - **OW44 — FUTURE (optimize-on-main) — filter the demand closure
    toward the rendered subset, TOGETHER WITH lazy client
    instantiation (the client not running the pattern immediately).**
    W0's flag 9
    ([`stage-c/w0-dprime-report.md`](../../history/plans/server-execution-v2/stage-c/w0-dprime-report.md)
    §2(b)/§4): the tracker's closure follows a piece root's
    `source`/process wiring, so a schema-narrowed root watch demands
    the piece's WHOLE internal graph (ifElse inputs = both branches;
    handler bindings) — over-demand, never under-demand. RULED
    2026-08-19: the closure (the piece graph, `source`-wired) IS the
    demand set, accepted as recommended; the narrowing is a future
    improvement, coupled by the owner with the client side. Owner, in
    chat:

    > log as a future improvement, together with not running the
    > pattern on the client immediately

    — owner (Berni), 2026-08-19. The row pairs, per that coupling:
    (i) filtering the demand closure toward the rendered subset (by
    id class / value reach — flag 9's named shapes), and (ii) LAZY
    CLIENT INSTANTIATION — the client not running the pattern
    immediately, so what a session demands (today: the tracker's
    closure, hence the whole piece graph) can narrow toward what is
    actually rendered rather than being forced wide by the client's
    own immediate run. Trigger: the optimize-on-main phase (the
    owner's landing posture — land OFF, then continue optimizing on
    main); not a gate for landing the stack, and not one of the
    flip's ordered gates.

- **Stage C combined W2.1+S1 independent review + fix round delta
  (2026-08-20).** The combined adversarial review of W2.1 (cascade-echo
  retirement), W3.1/S1 (drain-settle quiescence advance), and the
  receipt-race flake fix — read-only, at `4bf914a70` (= the train tip
  minus one docs-only commit) — returned **LANDABLE-WITH-FIXES: 2
  MAJOR / 5 MINOR / 8 notes**; report on-branch verbatim:
  [`stage-c/combined-w21-s1-review-report.md`](../../history/plans/server-execution-v2/stage-c/combined-w21-s1-review-report.md),
  dispositions with red/green evidence:
  [`stage-c/combined-w21-s1-fix-report.md`](../../history/plans/server-execution-v2/stage-c/combined-w21-s1-fix-report.md).
  Every fix landed ON THE TRAIN TIP (`claude/server-exec-v2-w3-alpha`)
  — F1 touches W2.1's client file that lives lower in the stack; the
  fix rides the tip, no lower branch was rebased. Dispositions: **F1
  (MAJOR) FIXED** — the seal-time jobless checks walk the cascade
  thread (the W2.1 row's UPDATE above carries the mechanism and pins
  W2.1-3-extended/W2.1-6); **F2 (MAJOR) FIXED** — the latch consume
  gated on the advance wave having stayed bookkeeping-only (the S1
  row's residual (iv) above carries the mechanism and pin 6); **F3
  (MINOR) FIXED** — S1 pin 1's client clause is now PUSH-HALF honest
  (a watermark sink installed before any advance exists must observe a
  DELIVERED value above the authored coverage; under the reviewer's
  S1-P1 mutation — the advance wave's `noteExecutorCommit` skipped —
  the pin goes RED at 10 s, re-verified in the fix round, where the
  pre-fix pins all stayed green); **F4 (MINOR) NOT CHANGED (code) —
  register note landed** on the shape-(b) FUTURE row above (the
  flicker counter under-counts the coalesced-purged shape; read it as
  a floor); **F5 (MINOR) FIXED** — the churn-surface docstring
  re-keyed to the mark-frame semantics with both biases stated; **F6
  (MINOR) FIXED (counter, the preferred shape)** —
  `cascadeThreadEvictionCount` / `cascadeWalkDepthCapCount` + logger
  keys, pin W2.1-7; **F7 (nit) FIXED** — `#ownWaveSeqs` bounded at
  4096, oldest evicted (fail-closed degradation only; on a healthy
  space the prune-at-advance keeps the set near-empty). The 8 notes:
  acknowledged in the fix report §4 (no code action beyond F6's
  counter, which also covers the depth-64 note); the reviewer verified
  OW43's closure justified, the skip lift doubly satisfied (adding an
  independent 7th green lunch run with `{1:16}` store multiplicity),
  and the flake fix real. One NEW pre-existing flake surfaced during
  the fix round's suite battery and was attributed by the ritual
  before any blame: `executor-effect-channel.test.ts`'s "served intent
  (T2 hops 1–4)" step times out at "waiting for the intent to land in
  alice's session instance" (~1/8 under load ~2) — reproduced at the
  UNFIXED tip `7e1d5a8ff` with the byte-identical assert (baseline
  worktree, 1/7), so NOT a fix-round regression and NOT the
  receipt-race pin `78959c26c` fixed (different step, different wait);
  left un-fixed here (out of the round's scope), flagged for its own
  red-first pass. (FIXED 2026-09-15, in two parts. The step's client
  was opened with a navigations array, which is what gives a client an
  enactment surface: it enacted the intent, acked the nonce, and the
  next wave retired the entry, so the wait was racing a state the
  system is built to clear. That client is headless now
  (`de5baca1a5`). The wait itself is event-driven: the file's local
  polling helper — a 20-second deadline over a 20-millisecond poll —
  is gone, so the step has no deadline left to exceed.)

- **First ON-lane CI gate delta (2026-08-21) — the stack's first-ever
  CI execution of the ON pattern lanes (land-off PR #6096, run
  32447348664) found SEVEN real ON red surfaces; skip-and-land is the
  landing posture; NINE rows minted (OW45–OW53, nothing renumbered).**
  Every surface reproduced locally on the ON-built binary; the OFF
  lanes untouched; the lunch and chat ON gates PASSED in CI. The
  headline: **NO DEMAND HOLE** — the (d′) demand machinery held
  everywhere it could be observed (group-chat: 33–41 derived commits,
  healthy demand counters, normal settle series; home-profile: the
  identical demand derived the surviving space's name with 72 basis
  rows) — every red is a WRITE-PATH defect under ON: a write that no
  longer lands, a write that lands with the wrong identity, or an
  action killed at commit-prep before it can write. TWO of the seven
  converge on the register's already-owed **OW31/§2b write-authority
  carriage build** (cfc-group-chat-demo's served rows carrying the
  SERVICE identity; home-profile's `compile-cache/writeback` fallback
  refused without carriage): NO new row was minted at the gate for
  what OW31 already owed — both skip entries pointed at OW31 then.
  The group-chat surface has since split and closed: its memory-plane
  carriage half closed with OW31's build, its CFC-attribution half
  (the service-identity authorship labels) closed by **OW59** (the
  OW34-family train), which lifted that skip — so OW31's remaining CI
  surface is home-profile's, riding OW31/OW45. A ninth CI-red family member,
  `cfc-group-chat-demo-multi-runtime`, was the test HARNESS's own
  mixed posture (the self-hosted OFF-arm standalone server refusing
  the ON workers' event appends deterministically) — fixed IN the
  harness (`create()` resolves the posture like a deployed entry
  point; ON targets the lane's toolshed), all 7 steps green on the ON
  binary: no skip, no row. Reports:
  [`stage-c/first-on-ci-gate.md`](../../history/plans/server-execution-v2/stage-c/first-on-ci-gate.md)
  (the gate record: the failure table, the harness fix, the coverage
  re-baseline) and
  [`stage-c/on-render-stall-rootcause.md`](../../history/plans/server-execution-v2/stage-c/on-render-stall-rootcause.md)
  (the three render-stall surfaces: store/log/live-run evidence,
  classifications, fix seats S-A..S-J). The skip entries live in
  `tasks/server-execution-on-skips.ts` (at the gate: SIX file entries
  + TWO step-level entries; the skip-list test pins the CURRENT set —
  both step entries were lifted the same day, cellset-lww with OW47's
  close and convergence-storm with OW52's, the group-chat file entry
  was lifted with OW59's close, default-app's file entry converted
  to its OW45 reload-step entry with OW51's close,
  home-profile-reload-durability's file entry lifted the same day too
  with the explicit warm request (OW45's row), and profile-embed's
  file entry fell with OW47's re-close, leaving TWO file
  entries — the sqlite identity pair — beside default-app's step
  entry; then both sqlite entries fell with OW53's close and
  topics-navigation with the OW33 triage's review pass (both
  2026-08-22), leaving default-app's step entry alone — which STAYS
  (2026-08-22): the test-side pass closed the step's own interim-race
  half and ISOLATED the residue as the OW45 row's real arm-B client
  starvation, so the entry now names that product charge, not a test
  flake). That 2026-08-26 census — THREE patterns entries: default-app's
  reload STEP, lunch-poll-vote's FILE entry, and the topic-board
  pivot-baseline STEP — fell to TWO with #6316 (2026-08-26, the topic-board
  STEP lifted by its content-addressed arrival-witness fix, without updating
  this sentence), and both of those two were campaigned for a lift on
  2026-08-27 and neither lifted (the STEP-ENTRY and LUNCH-POLL blocks
  below), then campaigned AGAIN the same day under the newly ruled
  local-plus-CI-probe bar (the PHASE-3 block at the end of this row) — where
  they split for OPPOSITE reasons: the default-app step passed BOTH halves
  of its own evidence (10/10 local, and a GREEN direct-CI run of the exact
  step) and was held only by a co-resident file's red in the same shard,
  while lunch-poll-vote passed its local half 8/8 and its probe went red at
  the probed surface for the second campaign running. **The current census
  (2026-08-28, the ruled-3b-close PR) is EMPTY — every suite's list: the
  owner ruled the 3b fork ("go with (1) plus the (2-D) kick"), both
  mechanisms landed red-first, and lunch-poll-vote's FILE entry is
  LIFTED a third time under the ruled local-plus-CI-probe bar with THIS
  PR's own ON-lane board as the direct-CI unskip probe (the RULING and
  RULED-CLOSE LIFT blocks at the end of this row; a red at the probed
  surface restores the entry per the arc's standing method).** The
  superseded 2026-08-28 census (after the geometry-3 close PR's probe 5)
  was ONE patterns entry: lunch-poll-vote's FILE entry, RESTORED a
  second time — the geometry-3 close landed (the mid-flight-supplier
  once-await, red-first) and its lift attempt's own probe went red at
  the surface with the PRE-DECLARED geometry-3b signature (the
  GEOMETRY-3 CLOSE, LIFT-ATTEMPT, and PROBE 5 blocks at the end of this
  row); the 3b close was an owner-court fork, since ruled. default-app's reload
  STEP LIFTED 2026-08-28 — the owner ruled the SURFACE reading of the
  probe bar, under which its evidence was already complete (the LIFT block
  at the end of this row). lunch-poll-vote's lift was ATTEMPTED the same
  day on the probe's own artifact — the park root-caused into the
  closure-replication write path, two supplier geometries fixed red-first
  on the PR — and every one of the PR's THREE probe boards went red at the
  probed surface (runs 33160430927, 33164596936, 33165960083; four probes
  across the arc, counting the pre-PR phase-3 board 33138358110 that opened
  it), the last exposing the still-open third geometry (the supplier
  compile mid-flight), so the entry was restored carrying the accumulated
  map (the lunch ROOT-CAUSE, PROBE-2/3/4 blocks at the end of
  this row); the geometry-3 close then fixed that third geometry and its
  lift attempt was withdrawn by probe 5 (geometry 3b). The
  FLIP's bar remains a green ON lane and every list empty; under that
  superseded census this entry was again what held the list, and under
  the current one NOTHING does — the ruled-3b-close lift emptied it
  (the co-resident `#host-send-button` debt the
  probe surfaced was paid by #6477 — the OBSERVATION's FIXED paragraph
  below). Rows, one per
  mechanism cluster; each row's trigger names the skip entry it
  lifts:
  - **OW45 — the profile piece's PROGRAM-materialization write path
    under ON (rootcause §1; seats S-A/S-B/S-C).** Under ON the
    created piece's program (code + CFC labelMap + schema docs) is
    only ever written by the client's own post-arrival commit; a
    reload kills the trailing create's program commit (it is issued
    AFTER `waitForRuntimeIdle` returns), nothing re-issues it, and
    the server's fallback — `compile-cache/writeback/<patternIdentity>`
    running in the HOME space's wave — is refused by the wave
    accumulator as a foreign-space write with no §2b delegated
    carriage (`seal-space-commit-failed`, 17 refusals per profile
    space observed), so the space's serving loop parks the structure
    load forever and the name renders the `#id` placeholder. Owed:
    **S-A** a legitimate server-side write path for
    `compile-cache/writeback` into the piece's own space — **BUILT
    2026-08-21 with OW31's build, on the carriage arm**: the
    replicate trigger threads the instantiating run's §2b delegated
    carriage into the writeback stamps (the system-class-exemption
    alternative was not needed; the heal-on-next-demand property
    holds for the replicate trigger — the repair path's own foreign
    case stays fail-closed, a flagged residual in OW31's row);
    **S-B CLOSED 2026-08-21** (optimize-on-main
    client-durability pass; its report,
    `ow47-client-durability-report.md`, lands under
    `docs/history/plans/server-execution-v2/optimize/` with the OW47
    PR):
    the client durability barrier now covers program materialization —
    `Scheduler.idleWithPendingCommits` (what `waitForRuntimeIdle`
    reaches through the runtime-client's `handleIdle`) additionally
    awaits the pattern manager's in-flight by-identity loads (whose
    cold-load arm recompiles and re-persists a space's program
    closure) and compile-cache write-backs (the program commit
    itself), joint-fixpoint with pending commits; plain `idle()` stays
    reactive-only, so serving-loop settle probes are untouched
    (red-first pin: `scheduler-idle-pattern-work.test.ts`); **S-C**
    heal-on-read: re-issue program materialization on adopt/open when
    the space lacks the program docs for a referenced patternIdentity
    — **SKIPPED BY RULING (RULED 2026-08-21, owner: "agreed, let's
    skip the fix then")**, on the evidence that S-C sits OFF the lift
    critical path: the home-profile durability test's own contract
    runs every create through `waitForRuntimeIdle` — S-B's barrier —
    before any reload, so with S-A+S-B merged the loss window the
    heal would repair is closed going forward; and the two
    gate-evidence broken spaces (Ada's and Alan's — TWO, not three)
    lived in EPHEMERAL TEST STORES, so production (flag OFF, no
    served creates) holds no broken space and no one-off repair
    exists or is needed. **Named residual (recorded, not owed)**: a
    client that DIES before its create-flow commits flush — a window
    of roughly hundreds of milliseconds — still orphans the space
    with no healer: the server's repair path stays fail-closed (OW31
    FLAG-4 — the detached compile flows carry no §2b carriage) and
    the client never re-issues. DETECTOR: OW46's
    `structureLoadStuck` counter names exactly this state. REVISIT
    TRIGGER: a nonzero park count in real ON usage, or OW56 landing
    (which dissolves the class), whichever comes first; the parked
    WIP branch `claude/server-exec-v2-ow45-sc-heal` is the
    shelf-ready start (client-side heal riding
    `PatternManager.#replicateClosures()` under the client's own identity,
    green red-first runner pins,
    serving posture pinned fail-closed; marked do-not-merge).
    Trigger DISCHARGED for the home-profile half — the
    `integration/home-profile-reload-durability.test.ts` ON skip is
    LIFTED (2026-08-21). The last blocker was not a carriage residual:
    the §2b derivation-carriage scoping pass
    (`optimize/2b-derivation-carriage-scope.md` §4) decomposed step
    2's red to a SETUP-AFTER-PARK ORDERING RACE — authored setup
    landing in a parked, sessionless space activates nothing (T11.Q7's
    designed parking) and nothing ever re-demands it (the post-reload
    summary reads the missing computed through the HOME space's free
    cross-space read, which registers no target-side demand) — and
    flagged three candidate mechanisms for the owner. **RULED
    2026-08-21 (owner: "three decisions: i agree with all
    recommendations")**: implement serving-loop.md §1's third,
    then-unimplemented activation trigger — the EXPLICIT WARM REQUEST,
    issued by the SERVING-SIDE PROVISIONING PATH when it stages setup
    into a parked space (not a synthetic client session, and not
    S-C-shape healing). BUILT the same day: the wave commit step
    reports every durably committed foreign provisioning batch as a
    warm-marked notice; the host activates a sessionless target on it
    (the carries-events arm's sibling; T11.Q7's write-alone parking
    untouched); the target tenure takes the staged instances as
    identity-less warm demand, so the setup derives. The build also
    closed the latent sink localSeq collision the warm activation
    exposed (per-space counters under the process-stable holder
    session — a home sink's foreign batches consumed pairs the
    target's own sink later re-minted, killing its waves as replay
    mismatches; now one process-global counter). Red-first:
    `executor-warm-request.test.ts` (watched failing at the
    activation wait, then at the derivation on the collision, then
    green end to end). Lift evidence: 6/6 fresh-store ON gate runs at
    the fix head, BOTH steps green in 12–24 s (the prior shape: step 1
    ~10 s green, step 2 red at 5m+ on "Alan Turing"), posture verified
    and loads (4.3–5.9) recorded per run, `warmRequests` 4–6 per run
    in the live stats. The row's REMAINING charge: it gates
    `integration/default-app.test.ts`'s "persist and reload every
    rapidly created notebook note" STEP — **which is NO LONGER
    SKIP-LISTED as of 2026-08-28 (OW45's LIFT block: 10/10 local plus a
    green direct-CI probe of that exact step), so the ON lanes run it and
    any recurrence surfaces as a lane red rather than behind a skip.
    Whether that closes this charge is this row's own call, flagged not
    taken** — the OW51 fix (2026-08-21)
    lifted that file's FILE skip and UNMASKED this same
    reload-durability surface there — the reloaded notebook's
    `noteCount` reads `undefined` past the step's wait (1/10 local ON
    at the OW51 build; re-measured 2026-08-22 by the warm-request P-1
    probe as heavily LOAD-SENSITIVE: 5/10 red on pure main and 7/10
    red on the warm-request head — statistically indistinguishable at
    n=10 — on a shared box at loads 3-16, every red the same
    `undefined`-vs-7 shape, and the warm request structurally INERT in
    this flow: `warmRequests` 0 in 10/10, the notebook stages no
    foreign provisioning). The test-side close RAN 2026-08-22 and
    SPLIT that charge in two — the red population was BIMODAL and the
    old single-shot shape structurally could not tell the halves
    apart (both print undefined-vs-7 at one instant). (i) CLOSED —
    the step's own interim race: its assertions now bind to the
    summary the `waitForCondition` predicate approves and hands back
    (taken at the instant the condition held, re-approved after the
    sync barrier; the failure path's one-shot read is
    diagnostics-only), absorbing the OW51-ruled
    interim-undefined-then-retrigger disposition the old post-wait
    single-shot read kept racing — the waiting-in-tests trap. Watched
    red-first at the true ON topology (ON-built binary sha256
    00fcf833…, deliberate load ~11-14): the old shape red in 20 s
    with the failed read's own dump showing `noteCount` 7 beside
    `argumentNotesLength` undefined and the RENDER fully healthy
    (7/7/7) — the interim landing on one field of one read while the
    product was correct. The fixed step then ran 16 greens across the
    day's regimes (fix-loop battery 10/10 loads ~5-7; gate-attempt-1
    g01-g04 4/4 loads 6-9; h02-h03 at 9.6-11.5). Mutation-checked:
    suppressing the seventh create reds the fixed wait at its
    stuck-condition net with the true 6-vs-7 state in the
    diagnostics — the value-wait cannot vacuously green. (ii) OPEN,
    and now ISOLATED, STORE-VERIFIED — the row's REMAINING charge,
    the arm-B client starvation: on the FIXED step at the true ON
    topology (rebuilt binary sha256 c724d7c6…, fresh store + posture
    probe per run, shared box with a sibling train churning) the
    value-wait itself starves — gate-attempt-2 red 3/5: h01 (ambient
    ~7) and h05 (ambient 6.6) with the client's `readCell` of the
    argument's redirect-linked `notes` sticky-`undefined` across the
    FULL 5-minute net at the predicate's 500 ms re-read cadence
    while `noteCount` (internal manifest) resolved 7 and the page's
    reactive render path held ALL SEVEN notes (chips one short at
    6/7 — the starved doc is the missing chip's own dependency); h04
    (load spike ~20) the rf2 whole-piece shape — `isNotebook` false
    with the view id still pointing at the piece: every client read
    of it (argument, internal manifest, the render's own) returning
    nothing MID-SESSION, persisting after load fell back to 6.
    PRECISION (independent review P2, confirmed in code and
    artifacts): these are FIRST-HYDRATION reads of freshly created
    served state — the step's only navigation (dispose +
    `shell.goto` into the fresh space) precedes the notebook's
    existence, and NO reload sits between the creates and the reads
    (h01's single post-goto "Await runtime idle" marker precedes
    every create, nothing between the creates and the red) — so the
    arm-B repro is CREATE-THEN-READ under serving, not
    reload-then-read (the true reload surface is the reload shard's,
    `integration/reload/default-app-notebook.test.ts`).
    Store-verified in every red: all 7 `/value/notes`
    appends present, event pipeline healthy (each `event-view-lag`
    deferral drained in seconds during the create phase, none in the
    wait window) — ZERO data loss, sticky client-side unresolved
    reads. Candidate mechanism (recorded, not concluded): the OW51
    disposition's re-trigger never lands for these reads — a first
    read in the interim leaves the client cache permanently
    `undefined` (a first-read lottery, explaining the load
    sensitivity: wider interim window under load); a poll-retrigger
    interaction (each 500 ms re-read re-opening the interim) is not
    excluded, but rf2's OLD-shape saturation stall — the
    piece-structure read never resolving over a 5-minute net with NO
    polling predicate — shows the starvation predates the value-wait.
    Retro-reading P-1: its 1/10-quiet and 5/10-loaded rates were a
    MIXTURE of the two populations; and the same box ran 14 straight
    greens before h-phase red 3/5 at the same nominal loadavg — the
    starvation is environment-coupled beyond what loadavg captures.
    The step's ON skip therefore STAYS, reworded to the isolated
    charge (the in-file guard KEPT — unchanged from main except its
    comment, which now names the product charge; the skips pin test
    pins the single entry; h06-h10 of the gate incidentally proved
    the guard skips loudly). OFF control on a default-built
    binary at the same head, guard in place: 2/2 green (6 s steps).
    Lift bar: the starvation closes and the FIXED step greens ON
    10/10 quiet-and-loaded. Measurement-integrity note, recorded
    because the artifacts are cited: gate-attempt-1 aborted
    mid-flight when the shared box filled to 0 B and macOS's temp
    purge deleted the gate workdir (g05 died to `database or disk is
    full` wave-commit rejections — an environment fault, discarded);
    attempt 2 re-ran uniformly on a rebuilt binary from a purge-safe
    workdir, and its h06-h10 burner phase self-invalidated (the step
    skipped) when the skip ENTRY's restoration landed in the working
    tree mid-gate — the 3/5 rate is the five valid runs h01-h05.
    **ARM-B TRIAGE 2026-08-22 (evening): the starvation family is
    THREE defects — two FIXED red-first, one isolated LIVE and
    FORKED; the step entry STAYS.** The instrumented bench (the
    name-draft triage's FORWARD_WORKER_CONSOLE aid + fresh-store
    harness at merged main) caught two reds in four runs, each a
    DIFFERENT member: (i) **run b01 — the event drain's deferral arm
    reordered one user's clicks (FIXED).** Store-verified: the
    `usedCreateAnotherNote` doc's terminal write is `true` at
    19:41-equivalent seq 90 AFTER the final Create's clearing `false`
    at seq 85 — a deferred Create-Another (five `event-view-lag`
    deferrals logged on its sidecar) consequenced after the
    later-arrived Create on its own healthy sidecar, violating
    events.md §2's stated order (per stream commit-seq; across
    streams arrival). The client read the state correctly — the
    PRODUCT state was wrong, so the value-wait's 300 s report was
    faithful. Fix: the drain processes ACROSS sidecars in append
    commit-seq order and a deferral (view-lag or sidecar-sync
    failure) is a BARRIER — later arrivals wait behind it — instead
    of a skip (`space-server.ts` `#drainStreamEvents`); red-first pin
    watched `["A","B","A"]` pre-fix and green after
    (`executor-events-down.test.ts` "arrival order across streams",
    deterministic via a transient sidecar-sync-failure seam; the
    view-lag arm is the same barrier, pinned through that sibling —
    the emulated harness cannot hold an async view lag across passes,
    the OW47-hydration precedent's shape, so the live ON gate remains
    the view-lag half's bench). (ii) **The walk's
    absent-hop-target demand hole (FIXED, the register's candidate
    mechanism made precise).** A server graph walk that dead-ends on
    a link-hop target absent at evaluation recorded NOTHING for it
    (`followPointer` returns before `trackVisitedDoc`; the meta-doc
    loader already tracked its absent targets, with the re-fire
    rationale in its comment), so the target's birth commit failed
    the session wake pass's touched check (`trackedIds` derives from
    DELIVERED entities) and the standing watch never delivered it —
    while the client's selector tracker legitimately answered every
    re-read locally after the first pull (a schema-false pull is
    covered by any registered selector) and `#docPullKicks` is
    one-shot. On a quiet space (create-then-read ends with a write
    then pure reads — the store shows the last commit ONE SECOND
    after the 7th append in every red) no later commit exists to
    heal, so the absence is permanent for the session: the
    first-read lottery. Fix: the walk records the dead-end in a MISS
    SET on the tracked graph state (`TrackedGraphState.missed`,
    same-space only, fed by the server walk's `onMissingLinkTarget`)
    — wake-reactivity ONLY, folded into `session.trackedIds` beside
    the delivered entities at every rebuild/fold site, and consulted
    by the dirty refresh so the birth re-evaluates and delivers the
    real document. Deliberately NOT the schema tracker: tracker
    entries materialize as delivered entities, and putting absence
    markers for every dangling value link on the wire changed client
    replica state at scale and broke the deliberate
    absence-confirmation flow (the list-resume-container-defer
    harness caught it — the first cut of this fix rode the tracker
    and wedged that suite's held-transport step; absent ROOTS keep
    their narrower pre-existing marker contract). Red-first:
    `v2-watch-absent-arrival.test.ts` — the hop pin watched starving
    at its 10 s net, both pins green with the fix; the list-defer
    suite and the (d′) demand-set equality
    (`executor-dprime-w0.test.ts`) green with the miss-set shape
    where the tracker-marker shape had broken both. The PR's review
    pass hardened the lifecycle: a miss carries its REFERRER
    attribution (the walk hands the dead-ended link's holder to the
    recorder), a referrer's re-walk releases its previous
    attributions — so a link edited away retires the miss instead of
    leaving a stale wake and an unreachable delivery on birth
    (mutation-killed pin: "retires a miss when its referrer is
    repointed away") — and a dirtied-but-still-absent miss stays a
    miss, never the tracker whose entries reach the wire (the sink
    routing's KILLING pin is the UNIT-isolation test in
    `v2-query.test.ts`, driving `refreshTrackedGraph` against a bare
    engine; the integration flicker test binds the no-frame contract
    end to end). Disclosed
    ripple (corrected by the adversarial round — the first wording
    claimed a structure-load park, mechanically wrong: structure
    loads iterate ROOT keys only and misses emit as NON-ROOT demand
    rows, so the root filter never sees them and no park or OW46
    count occurs): misses join `trackedIds` and therefore the (d′)
    demand rows as non-root entries, whose actual effects are
    `enterDemandedEntity` — the missing doc's WRITERS become demand
    roots, mildly beneficial (the docs that would create it get
    served) — plus a `rearmNotCurrentForDemander` per
    (key, demander) and demand-union growth; all bounded by the live
    misses. OWED FOLLOW-UP (recorded by the adversarial round, not
    built here): the drain's PRE-QUEUE deferral barrier (view-lag,
    sidecar-sync failure, queue-time throw) never reaches the queued
    class's `#eventDeferrals`, so events.md §5's DROP hardening does
    not apply before queueing — detection is the
    `preQueueDeferralStuck` counter and its doubling warn (added
    with the round). The §2-CONFORMING escape: a persistent
    pre-queue streak hardens into a DROP/ERROR NOTICE IN ARRIVAL
    POSITION — a consequence, so arrival order is preserved and the
    barrier lifts — the same §5 pattern the queued class has. (iii) **run b04 — the flag-ON client's
    navigate-deferred piece start dies terminally on the
    first-hydration race (ISOLATED LIVE, FORKED — the remaining
    charge).** The h04 whole-piece shape reproduced with the worker
    console forwarded: the client's deferred start tx REFUSED with
    `ConflictError: stale confirmed read: computed:… at seq 0
    conflicted with seq 10` — its basis read the served piece's
    computed docs PRE-BIRTH while the serving side materialized them
    — then `pattern-load-error`, then silence; the error arm of the
    deferred-start commit cancels ownership with NO retry
    (`runner.ts` ~3453), so the piece never starts client-side, its
    demand never registers, and every dependent read is undefined
    for the session (root doc readable via the registry closure —
    98 stored chip labels — every link hop dead; ZERO
    `sync-load-failure` lines, excluding the swallowed-pull class
    for this red). Dispositions and recommendation — (a)
    retry-on-conflict now, (b) adopt-not-start under ON as the
    model's destination, (c) heal-on-read re-opens the ruled S-C
    with new evidence — in
    `../../history/plans/server-execution-v2/optimize/ow45-armb-client-start-fork.md`.
    The skip entry therefore STAYS, its reason updated to the
    refined map; the lift bar is unchanged (the client-start class
    closes and the fixed step greens ON 10/10 quiet-and-loaded —
    unreachable while a per-run lottery can kill the client's piece
    context). Retro-reading the h-runs: h01/h05's converged-but-one-
    chain shape is the same die-off later in the start walk; rf2's
    old-shape stall is the die-off at the front; b01's shape hid
    inside the population as "the product not answering" with the
    client blameless.
    **SERVER-ENSURE STAGE 1 BUILT 2026-08-23 (design PR #6209,
    owner-green-lit; build report
    `../../history/plans/server-execution-v2/optimize/ow45-armb-server-ensure-stage1-report.md`).**
    The space-root ensure owns existence only. It runs at the SpaceServer's
    activation as a lease-guarded owed step, single-flight for the tenure.
    `ensure-space-root.ts` returns an existing root without checking or
    following its source. When creation is required, the creation transaction
    carries the owner-resolved trust snapshot from `resolveSpaceOwner` and
    `trustSnapshotForPrincipal(owner)`. Source following belongs to the opener
    under piece-source-lifecycle.md; no freshness write arm is owed to the
    server ensure. Design §4(b)'s ACTING-IDENTITY
    carriage is NOT built (review F3, recorded): the stamp carries no
    `acting`, so `homeSpacePrincipalFor`/`getHomeSpaceCell` would
    fail-closed-throw if a served setup resolved home — inert today
    and consistent with the custom-URL interim, but stage 2's
    owner-scoped home read needs it built first. With
    no-owner spaces SKIPPED counted-and-warned (OW53's shape) — plus
    the measurement-driven SAME-TENURE retry: the live boot order has
    activation (session-open-triggered) PRECEDE the client bootstrap's
    genesis ACL commit, so a fresh space's first ensure always finds no
    owner; the skip therefore latches awaiting-owner and an admitted
    commit touching the ACL doc re-arms the owed ensure — identity
    posture unchanged, only the retry cadence moved from next-tenure to
    owner-became-resolvable (without it, r01 measured the ensure INERT
    on 4/4 gate spaces; with it, r02 measured the server creating 4/4).
    The
    custom-`defaultAppUrl` fork stays UNRULED: stage 1
    logs-and-uses-the-system-default on fresh non-home creations.
    Recorded STAGE-2 GATE: the runnability-repair pair (cold-start
    setup repair + roll-forward heal) did NOT move — the ON client's
    creation retirement must not ship before it does, or aged spaces
    brick under ON. What stage 1 changes live: the server wins most
    creation races from activation onward; the ARM-A refusal class does
    NOT close (the ON client still creates on the slow path and still
    deferred-starts on the fast path), so THE STEP'S SKIP STAYS and the
    lift bar is unchanged. Pins: fresh-space materialization at
    activation (watched red pre-seat), park/re-activate convergence on
    ONE root + aged-identity reconcile-before-load across tenures
    (which also live-caught a FIXTURE class worth naming: a per-tenure
    localSeqRef re-mints (session, localSeq) pairs and engine replay
    detection kills the second tenure's waves — the host's shared
    counter contract, now stated in the suite), the owner-snapshot pin,
    the fail-closed skip pin (service-DID-fallback mutation killed),
    the toolshed OFF bootstrap pin (gate-bypass mutation killed), and
    the piece OFF-arm creation pin (provenance-stamp mutation killed
    through the delegated controller). Named residual (flagged, not
    filled): the deferred-start transaction the ensure's creation arms
    still stamps actor-less bookkeeping — ambient SERVICE snapshot on
    the child-materialization docs, OW59 Q3's arm — threading the owner
    through the shared arming machinery is OW59-ruling territory; the
    same family's second, pre-existing member is `PatternManager`'s
    compile-cache write-backs minted inside `compilePattern` (escape
    the stamp hook; enumerated with the flag in the stage-1 report).
    **SHARD-10 DISCRIMINATED AND FIXED 2026-08-25 (PR #6320): the
    ensure-ON board's compile-cache write-back CFC red is NOT this
    attribution family** — the failing writer is the CLIENT under its
    own identity in its own space, and no identity/carriage question is
    open (the stamp-hook escape above stays flagged exactly as
    written). Root cause, reproduced 3/3 deterministic at the true
    topology: `loadCompiledClosure`'s `verifiedDoc` returned
    `cell.get()` docs whose `sourceMap` is a LIVE query-result view;
    consumers carry the field verbatim into module artifacts (the
    process byte cache — `putAll` runs on storage-served compiles too
    and replaces existing entries — storage-served compile bodies,
    repair/replication write-backs), and written back into ANOTHER
    space the view serializes as the sigil link it names: a cross-space
    `/sourceMap` link into the space it was read from. Under ensure-ON
    the target doc pre-exists with its stored envelope (the ensured
    default-app closure shares content-addressed helper docs with every
    pattern's closure), so the link write is CFC-relevant and prepare
    fail-closes on the unreadable foreign source — `missing link source
    metadata … at /sourceMap`, the sx2-scale shard-10 red; CFC is
    CORRECT there. Under ensure-OFF the same corrupt link LANDED
    SILENTLY AND DURABLY (control run: 10 of 12 fresh spaces held a
    quoted cross-space link at `/sourceMap`; value-level reads resolve
    THROUGH the link, which is why the green regime never noticed) — so
    the ensure exposed a pre-existing silent-corruption class rather
    than creating one. FIXED red-first at the one read boundary every
    consumer funnels through: `verifiedDoc` snapshots `sourceMap`
    exactly as it already snapshots `policyManifests`; enforcement
    untouched. Pin `compile-cache-storage-served-values.test.ts` (both
    arms, asserting on the RAW stored value — resolved reads are
    blind). Live: pre-fix 3/3 red, post-fix 3/3 green ensure-ON, and
    the ensure-OFF store dump post-fix holds 0 corrupt of 24 stored
    sourceMap fields. Legacy residual (recorded, not owed): the
    fleet's EXISTING poisoned docs are never healed in place — a warm
    hit skips write-back and a runtimeVersion bump orphans rather than
    rewrites them — but they are inert going forward (the independent
    review's planted-corruption probes, review-6320-report.md): with
    the serving space reachable a value read resolves THROUGH the
    legacy link and post-fix onward write-backs LAUNDER it to the
    plain value; with the target dangling the doc loads mapless and
    compiles fine; and a snapshot-time throw (e.g. an
    unreachable-space authorization error) degrades that one doc to a
    cache miss instead of failing the closure load. Healing is
    deliberately out of scope. Expected on #6248's board: shard 10
    greens (its red is this exact deterministic producer); shards 2/6
    remain the row's separate profile program-materialization family.
    **SCOPE RULED 2026-08-24 (the owner; verbatim in the stage-1
    report): production ensures a root for EVERY activated space —
    per-space discrimination is DEFERRED to its own design work — and
    tests get an off switch**: `ensureSpaceRoots` on
    SpaceServer/ExecutorHost options (the ruled in-memory setting) and
    the toolshed's `SERVER_EXECUTION_ENSURE_SPACE_ROOTS` (literal
    `"false"` only; garbage fails to production), off = fully inert,
    pinned both ways. The ruling followed the stage-1 CI board going
    red across the ON lanes: the ensured root's content-addressed
    computed cells landed in every fixture space's plain space-cell
    subscriptions with the root's `cid:` schema docs not
    delivered-and-verified — an UNCAUGHT client-replica throw
    (`#validateArrivedSchemaDocuments`) that failed files wholesale
    (all red lanes real-toolshed; in-process harnesses unaffected;
    main green at the identical base). The CI ON lanes opted out of
    the ensure while that gap was open (`cf test` needs nothing: no
    serving host exists in `packages/cli` — the ruled opt-in is its
    status quo); the exposed delivery gap became OW61's row, whose
    arrival CONTAINMENT (per-doc quarantine, never a process kill)
    landed with #6223, and whose residual client-side absorb defect
    was root-caused and FIXED with #6292 (pre-watch-response
    `session/effect` frames now reach the replica in wire order —
    OW61's tail carries the mechanism). WITH THE OPT-OUT RETIRED
    (the ensure-on lane flip PR, following #6223 and #6292): the ON
    lanes run the production default again and ARE the CI coverage
    of the ensure at the true topology — the "no CI lane exercises
    the ensure" flag this tail carried is closed.
    **CATCH-UP-AND-START BUILT 2026-08-24 — the ruled close of the
    client-start class. RULED 2026-08-24: the coordinator's
    recommendation, ACKED verbatim by the owner ("so ack on all
    recommendaions"):**

    > In the stale-confirmed-read error arm of the deferred start,
    > treat the refusal as "the server won the race": wait for the
    > conflicting docs to arrive (the wire path already attaches
    > `readyToRetry` = `Client.#waitForCaughtUpLocalSeq()`,
    > packages/memory/v2/client.ts), then START the runner
    > against the served docs, COMMITTING NOTHING. Not re-commit
    > (#6208's retry — census-proved non-convergent, closed), not
    > refuse-to-start (today's terminal arm).

    The owner's model statements grounding it (same date, verbatim):

    > "clients should actually start patterns when they load, but
    > it's an entirely reactive flow that catches up with the
    > server."

    > "a client can still speculatively run it locally, just that
    > the server-state will eventually win"

    > "ah, one thing i forgot, and we can change: clients do create
    > patterns, but only in tests. for production client we
    > currently don't have a way to instantiate a new pattern with
    > new code from \"the outside\" (as opposed to patterns doing
    > it). (and just to be clear, a .map creates and starts a lot of
    > sub patterns, but it does so deterministacally and reactively
    > and with existing code, so the client just speculates, the
    > servers fills in, it converges, done)."

    — owner (Berni), 2026-08-24. As built (`runner.ts`
    `Runner.#catchUpAndStartOnStaleRead()` + `startFromServedState`; the
    readiness `awaitCommitRetryReadiness` cherry-picked from closed
    #6208 along with its discriminator — the retry itself
    deliberately NOT brought): both deferred-start arms' stale-read
    refusals, ON-ONLY (`experimental.serverExecution === true`, the
    coordinator's conservative default — under OFF the refusal means
    another CLIENT raced and cross-tab mutex semantics own that
    story; OFF byte-identical, pinned). COVERED SHAPES, exactly (the
    adversarial review's F4 — the class language is scoped to these,
    never "all conflicts"): the engine's stale-read family —
    `stale confirmed read` (validateConfirmedReads) and its sibling
    `stale pending read` (resolvePendingReads) — matched HEAD-
    ANCHORED by `isStaleReadConflict` (né #6208's
    `isStaleConfirmedReadConflict`; renamed when the pending sibling
    joined, both directions red-first), so a client-fabricated
    withdrawal that merely EMBEDS a staleness phrase never
    classifies (review note F5). Deliberately NOT matched, each with
    its reason in the predicate's docstring: `pending dependency not
    resolved` (own-commit fate), `entity-value-hash precondition
    target changed` (create-only double-handling), and the
    same-family preempt-mode client shape (`commit preempted: …`,
    experimental `CF_CONFLICT_ADMISSION=preempt`, default off) —
    recorded, not silently extended; a b04-shaped death under THAT
    message is that mode's own open item. THE RECOVERY, as
    restructured by the review's F1 (+ Cubic P1 — the
    cancellation-authority root, both faces) and CORRECTED by the
    delta review's D1: it recovers only an attempt whose install is
    STILL THE CURRENT REGISTRATION when the refusal lands (a stop or
    release during the commit round trip now WINS, exactly as on the
    terminal path), tears the refused install down with the token's
    own registry-guarded stop WITHOUT spending the token, CLEARS the
    token's now-stale install reference (D1's root: the token's
    cancel is a one-shot `stopped` latch — fired against a stale
    install it no-ops AND burns the latch, and the first cut's later
    hand-off then returned at the latch without stopping the
    recovered run: the F1 leak one window later, the reviewer's
    `registered-after-parent-cancel` probe; with the install
    cleared, a cancel landing anywhere in the wait or walk window
    stays pending-shaped), re-enters the pending index under the
    SAME token the parent holds (stops tombstone the readiness wait
    there), then awaits the conflict's readiness and runs the
    ORDINARY LOAD WALK (`doStart`, the reload walk) with no
    independent-start marking. The walk hands the claimed
    registration to the token INSIDE its claim mapping — the same
    synchronous block as the claim checks, so no promise hop
    separates claim from hand-off for a stop+restart to slip a
    foreign registration into (the delta review's D2, closed by
    construction) — and the hand-off is IDENTITY-EXACT (Cubic P1,
    post-mini-delta, confirmed and fixed red-first): the attempt
    records the registration its OWN `Runner.#startCore()` created, and only
    that registration, still current, is handed off — because a
    COMPETING start can install into the registry the recovery's
    entry emptied with no stop and so no generation bump
    (`Runner.#startCore()`'s unconditional install; the only bump
    sites live in stopResult),
    and the walk's already-started returns report it as success; on
    a foreign registration the recovery YIELDS exactly as
    `Runner.#startWithTx()` yields on an owned key (the piece runs under the
    competitor's authority — an independent navigate keeps its
    life). After the hand-off the parent's one Cancel handle stops
    the recovered run, and a cancel that landed during the wait or
    the walk is finished by that markInstalled against the real
    registration: stopped in the same breath, the walk reporting
    not-running. If another start took the key during the wait, the
    recovery yields exactly as `Runner.#startWithTx()` yields on an owned
    key. The recovery arm commits nothing (store-door pin: zero
    `commitNative` calls post-refusal) and mints no transaction. Log
    keys: `deferred-start-catchup` (recovery
    scheduled), `deferred-start-catchup-failed` (walk failed —
    loud, the piece has no client context). The two design checks
    flagged to the owner, resolved with evidence before code:
    (1) nothing downstream in the start walk requires the CLIENT's
    startTx commit to have succeeded — the walk consumes the
    ORIGINATING committed tx's products (root doc, patternIdentity
    meta, argument link, setup state; the deferred callback only
    arms on that commit's success) plus in-memory context the
    recovery re-creates; the one startTx-success-gated product is
    the pattern-updater schedule (the walk's own instantiation tx
    re-arms it); the startTx's staged materialization writes are
    exactly what the SERVER already materialized (deterministic,
    cause-derived ids). (2) §3d restated in serving-loop.md §3d's
    RULED 2026-08-24 paragraph (the sanction names the
    deferred-start transaction; the recovery mints none) — no
    semantic beyond the ruling. Red-first:
    `deferred-start-catchup-start.test.ts`, watched red at the
    exact b04 shape (terminal tx-commit-error, one install, the
    awaited second install failed by quiescence), and again for the
    review round — the stop-during-round-trip revival and the spent
    parent handle both watched red before the F1 restructure, the
    stale-pending-read recovery and the embedded-phrase terminality
    both watched red before the predicate change, and the delta
    round's mid-walk parent cancel watched red at the D1 leak
    (`cancels.has` true after the handle fired inside the recovery's
    assembly) before the latch-clear + in-claim hand-off landed.
    Mutation kills: the ON gate (OFF pin), the discriminator
    (other-refusals-terminal pin), the token registration point
    (stop pin), the epoch pair JOINTLY (teardown pin — the two
    checks are each other's backstop, individually shadowed;
    recorded as one joint kill, not two), the entry authority gate
    (stop-wins pin), the stale-install CLEAR (mid-walk pin), the
    in-claim markInstalled hand-off (parent-handle AND mid-walk
    pins — doubly load-bearing), the hand-off's IDENTITY gate
    (competing-start pin — watched red at the pre-fix head: the
    parent's cancel tore down the competitor's independent run), and
    the cross-space CALL SITE (the
    routing pin's entry-point instrumentation — the review's F13
    found the prior pin vacuous to exactly this mutation; it now
    reds). The
    readiness gate itself is pinned (Cubic P2/F12): a test-held
    `readyToRetry` shows no re-assembly while held and recovery
    exactly after release; the other unit refusals are
    injected-shape pins whose readiness resolves immediately (the
    named-doc pull only), the live campaign being the wire-gate's
    true-topology witness. Disclosed deltas, the FULL enumeration
    (review F10), each derived from "the context is the normal
    start walk's": the recovery re-derives the pattern from the
    durable patternIdentity meta (a KEYLESS piece — no stored
    pointer — therefore fails LOUD, "Cannot start: no pattern
    identity", rather than starting) and drops the refused
    attempt's RunnerRunOptions — no navigate event context (the
    server owns the intent — §3d's own rationale), no
    independent-start marking (the recovered piece stays its
    parent's child), no caller `doNotUpdateOnPatternChange` /
    `awaitSyncBeforeInitialRun` / `parentPieceRootId`, and
    `schedulePatternUpdate` at the walk's default (true); a
    document still in flight at walk time reads PENDING and
    re-triggers on arrival (OW51 semantics).
    **THE 10/10 GATE AT THE FIX HEAD (2026-08-24): 7/10 — the b04
    START death is closed live; the residue is TWO READ-SIDE members
    the deferred-start error arm cannot reach; THE SKIP STAYS,
    reworded.** Method: ON-built binary (sha256 88631052bc76…),
    fresh store + posture probe per run
    (shellServerExecutionDefine "true" + servingLoop present, every
    run), ensure-off (`SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false` —
    deliberately the CI ON lanes' posture, i.e. what a lifted step
    would actually run under, and the harsher client-creates regime),
    the skip neutralized in the working tree for all ten runs
    (skip-print verified absent per run), quiet-and-loaded (ambient
    5-14 on a busy shared box; loaded = +6 pinned CPU spinners,
    ambient peaked 144 before r09), PID-only kills, ports 9711-9730.
    Per-run ledger on the PR. What the recovery did, live: catchup
    activations 1-2 in EVERY run (18 across the ten counted runs; 19
    with smoke r00 — the first write-up said 17, corrected by the
    adversarial review's reconciliation), terminal deferred-start
    deaths ZERO, recovery failures ZERO — and in the green runs the
    SECOND catchup was the NOTEBOOK space's own refused root start
    (space-DID-matched in r03/r04/r05), i.e. the exact b04 sequence
    (interactive piece → stale-confirmed-read refusal → teardown)
    now ends in a running piece and a green step (22-46 s steps,
    including at loads 23-40). The three reds, classified: (i) r01
    (quiet) — the h01/h05 READ member, store-verified: all 7
    /value/notes appends durable (seqs 48-88), serving loop healthy,
    notebook context fully live (isNotebook true, internal noteCount
    7, render notesLength 7, chips 6/7), the predicate's readCell of
    the argument's redirect-linked notes undefined across the full
    300 s net — SILENT (zero error lines; its one catchup was a
    DIFFERENT space's, so no recovery was even involved); one
    recorded thread: a speculation.md §6 speculative-basis refusal
    (designed, terminal) in-window whose doc then never landed
    anywhere. (ii) r06+r09 (both loaded) — the STRANDED WHOLE-PIECE
    member, identical chain twice: the notebook space's root
    recovery fired and no start died, then ONE watcher
    `pattern-load-error` for a KEYLESS identity, then every read of
    the piece (argument, internal, render's own) returning nothing
    at diagnostics time — the CT-1923 stranded-state shape; the
    durable store's patternIdentity pointers are all REAL
    identities, so the keyless ref is session-side (an
    overlay/session-synthetic pointer reaching the watcher), and the
    load-error is the discriminating event between recovered-green
    and stranded-red (greens have the same catchup and no
    load-error). **[CORRECTED 2026-08-27, root-cause seat: the
    session-side claim is WRONG. Durable `keyless:` patternIdentity
    pointers exist in EVERY run at the lift-campaign head — greens
    included — written by the serving runtime's derived
    materialization commits onto orphan sub-piece docs (one per
    piece root; a03 seq 57 is the store witness). The pointers this
    record checked were the piece ROOTS', which are real; the
    keyless ones sit on sub-piece docs nothing else durably
    references. The member is also not a stranded whole piece: the
    root cause on the 2026-08-27 campaign row shows the diagnostics
    were reading a different piece.]** CONSEQUENCE for the family map: the fork memo's
    working hypothesis that h01/h05/rf2 were "the same die-off
    later/earlier in the start walk" is DISPROVED — the walk
    completes in both red shapes; the residue lives in the
    read/delivery path (r01) and in the post-start pointer-watcher
    path (r06/r09). Follow-on aids landed with this build: the
    recovery logs a LOUD
    `deferred-start-catchup-failed …resolved without the piece
    running` when its walk resolves false un-stopped (r06's
    post-mortem could not distinguish that outcome; the next
    occurrence is decisive — and the F1 restructure narrowed the
    line's confound: a supersede now yields BEFORE the walk at the
    owned-key check and a stop cancels the token, so review note
    F11's benign-supersede false fire is structurally squeezed to
    the mid-walk window), beside the existing
    `deferred-start-catchup` scheduling line. Recorded follow-on
    (review F9, veto not exercised — a recommendation, not owed
    here): §3d makes failure-arm loudness a CONTRACT, and the
    client half of it is unpinned because this package has no
    logger-capture idiom; the serving half's model is an assertable
    counter (`structureLoadFailures`) — a client-side counter or a
    capture idiom would make the client half assertable too. The lift bar's STEP
    half is unchanged — the fixed step greens ON 10/10
    quiet-and-loaded — and its class half is now the named read-side
    residue (the START class the bar originally named is closed by
    this build); the step entry's reason names the narrowed charge.
    **POST-#6292 RE-MEASURE, 2026-08-26: 9/10 — NO LIFT. The earlier
    read-side residues are likely closed; the sole red is a NEW
    store-incomplete setup-error shape.** Method: one ON binary at
    `37b45336a6b17ad27039cc525e4ba2e89f517449` (contains #6292 as
    `9c9073995`), sha256
    `747c162b30bd18e144ebbf9ef1c03b7a84d44d005949bcbd4a919e17d1970ebd`;
    the STEP guard neutralized for every run while its registry entry
    stayed present; ensure-off, matching the CI ON lanes; fresh store,
    independent 97xx port, ON posture probe, and LLM environment masked
    per run; five quiet plus five loaded; PID-only teardown and a
    port-free check. Quiet was 4/5 green and loaded 5/5. The nine greens
    completed the step in 7–24 s. Across ten runs: 12
    `deferred-start-catchup`, zero catch-up failures, zero
    `pattern-load-error`, 12 stale-read lines, zero terminal deferred
    deaths, and zero skip prints.

    The sole red, quiet r01, reached the target step and remained there
    until the unchanged 600 s harness bound returned rc 124. Its durable
    notebook space held 89 commits, 808 entities, and 1,220 revisions;
    the root carried a real pattern identity. The notebook argument held
    exactly SIX note links, with post-creation patches at seqs 37, 45,
    55, 63, 71, and 83 and no seventh append. The log held one
    `pattern-swap-setup-error` whose server detail was “updated arguments
    do not match the candidate schema: parentNotebook: notes: 0:
    parentNotebook: recursive schema validation made no progress,” plus
    seven `event-view-lag` deferrals reaching index 5. It held zero
    `pattern-load-error`.

    Discriminators: NOT the earlier r01, whose store was complete with
    all seven appends and whose live context silently starved only the
    read; this store was incomplete, had an explicit setup error, and
    never reached the final authority read. NOT r06/r09, which each had
    one keyless-identity `pattern-load-error` followed by whole-piece
    unreadability while durable pointers remained real; this run had
    zero load errors and a real root pattern identity. The previous
    read-side residues are likely closed by intervening fixes, but the
    evidence remains split: r01 has #6292's matching client-absorb
    mechanism plus the signature's absence here; r06/r09 have
    absence-of-observation only, since their keyless-identity mechanism
    was never root-caused. The campaign does NOT determine whether the
    seventh append was refused, dropped, or never issued, and assigns no
    root cause to the recursive-schema error.

    **DISPOSITION: NO LIFT.** The STEP entry and its bound guard stay,
    reworded to this store-incomplete `pattern-swap-setup-error` charge.
    The lift bar remains 10/10 quiet-and-loaded ON. Full ledger and
    per-run evidence paths:
    [`ow45-default-app-reload-post-6292-remeasure-2026-08-26.md`](../../history/plans/server-execution-v2/optimize/ow45-default-app-reload-post-6292-remeasure-2026-08-26.md).
    **ROOT-CAUSED 2026-08-26: the campaign launcher split browser and
    serving pattern-source authority; the seventh event was durable but
    STRANDED before served admission, and the recursive setup error was a
    finite witness of that divergence rather than the event's refusal.** The
    off-repository launcher gave the browser the run's independent 97xx
    `API_URL` but did not set `API_URL` on the toolshed process. Toolshed's
    supported remote-source posture therefore used the default
    `http://localhost:8000` while storage and the browser used the run
    toolshed. Only red r01 had an unrelated old toolshed answering on 8000:
    the browser compiled current note identity `30y74xQLD…#default`; the
    serving updater fetched `c-jbvEpTaj…#default`, whose source maps exactly
    to repository commit `8ca18b71e`. Green r02/r03 got connection refused
    from the implicit source host, so no conflicting candidate was installed;
    a self-source live control likewise avoided the path.

    Store classification, now definitive: the seventh `Create` WAS emitted
    and durably appended at seq 87, with a registered handler, but its sidecar
    has no consequence, terminal status, error, or reason; the durable served
    watermark covers only through seq 81. The client speculative path
    materialized an orphan seventh note, but the served handler did not run
    and no seventh notebook append exists. Precisely: the event is stranded
    BEFORE served queue admission/terminal classification — not refused,
    dropped, or never issued. The six completed actions/consequences are
    seqs 36/37, 43/45, 53/55, 60/63, 69/71, and 81/83. Loaded green r02 has
    all seven authored actions and consequences, ending at seqs 84/86.

    The exact captured candidate was `c-jbvEpTaj…#default`, validated against
    a note argument whose `parentNotebook` points at the notebook root. The
    embedded NotePiece/NotebookPiece schema follows
    `note.parentNotebook.notes[0].parentNotebook` back to the same value under
    the same schema pair, so the schema progress guard returns “recursive
    schema validation made no progress.” Offline replay terminates; the
    validator is not the endless loop. An exact-old-source live probe
    reproduced the error after all seven appends had landed, and a
    comment-only identity split reproduced the family, ruling out the old
    note semantics and a fixed note index. A narrow idle trace saw the same
    client setup error but drained all observed idle branches and failed
    normally in 22 s, so the setup error neither automatically refuses an
    event nor intrinsically leaks the idle barrier.

    Established causal chain: omitted server `API_URL` → conflicting source
    identity → live-piece swap requests → finite recursive-argument setup
    error; under r01's ordering, served progress then failed to reach the
    final durable event, so `waitForRuntimeIdle`'s event/durability fixpoint
    could not resolve before the unchanged 600 s harness bound. OPEN LIMIT:
    the durable store names the pending event but cannot reconstruct which
    original client scheduler collection or promise held it after the error;
    diagnostic timing did not recreate that state. Load is not necessary
    (r01 and the identity-only red were quiet), and `event-view-lag` alone is
    insufficient (quiet r03 had it and greened).

    No production fix: distinct source and storage hosts are supported, and
    forcing self-source would change that contract without a mechanism pin.
    The exact measurement fix seat is the off-repository launcher: pass the
    run port as the server's `API_URL` and preflight that browser and serving
    source authorities report the expected identity. No repository-owned
    deterministic regression can directly pin that launcher, and the live
    timing probe did not isolate a local behavior change suitable for a
    mutation check. The STEP skip and bound guard therefore STAY. The lift bar
    remains a separate 10/10 quiet-and-loaded campaign under the corrected
    source-authority posture. Full RCA and evidence map:
    [`ow45-default-app-store-incomplete-root-cause-2026-08-26.md`](../../history/plans/server-execution-v2/optimize/ow45-default-app-store-incomplete-root-cause-2026-08-26.md).
    **DIRECT CI UNSKIP PROBE, 2026-08-26: RED — NO LIFT.** Head
    `66a969ca02e8962ae44eeb4da264a575da421893`, Actions run
    [33008274232, ON shard 5](https://github.com/commonfabric/labs/actions/runs/33008274232/job/98307864923).
    The registry had no default-app entry, the job printed that no listed
    skip was in its file list, and the exact rapid-note step ran. The other
    nine ON pattern shards passed. Shard 5 failed only this target after
    5m22s, when `waitForCondition` reached its unchanged 300000 ms bound.
    The final client trace reported `eventInvocationCount: 7` and
    `notebookInvocationCount: 7`, but `isNotebook: false`, `notesLength: 0`,
    `notebookActionCount: 0`, 84 stored UI note chips, and zero rendered note
    chips. The log had zero `pattern-swap-setup-error`, recursive-schema
    errors, and `pattern-load-error`. This is therefore a current true-CI ON
    failure distinct from the split-source off-repository launcher failure;
    the direct CI artifact does not establish the durable disposition of any
    note action or assign the new failure's root cause. The STEP entry is
    restored with this current charge. Its bound guard and separate lift bar
    remain.
    **THE STEP ENTRY'S LIFT CAMPAIGN AT THE CORRECTED POSTURE, 2026-08-27:
    7/10 — NO LIFT, and the charge REPRODUCES LOCALLY for the first time.**
    Method: ON binary at main `4b70949ac` (sha256 `5018e589dc54b19a1…`,
    re-verified into every run's ledger; a mismatch aborts the run), fresh
    store and own 97xx port and ON posture probe per run, LLM masked,
    PID-only teardown with a port-free check, the STEP entry neutralized in
    the working tree for all ten runs (zero skip prints, step verified RAN
    per run), `gtimeout 600` never raised, five quiet and five loaded
    interleaved. TWO posture changes from the archived campaigns, both
    strictly harder and both deliberate: the space-root ensure is **ON**
    (the production default — #6248 put the CI ON lanes back on it, so the
    archived `SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false` no longer matches
    the lane a lifted step would run in), and the toolshed process now gets
    the run port as its pattern-source `API_URL`, which is exactly the
    corrected source authority the RCA above prescribed (`port_8000_holder`
    `none` in every run; zero `pattern-swap-setup-error` and zero
    recursive-schema across all ten — the split-source artifact is gone).
    Greens finish the step in 13–14 s; every red is the test's own 300 s
    `waitForCondition` bound (313–315 s wall). Reds are NOT load-driven:
    a03 and a07 quiet, a04 loaded. Campaign-wide: `deferred-start-catchup`
    **0**, catch-up failures **0**, terminal `Error committing deferred`
    **0**, stale-read lines **0**, `session-remount` **0**, load-park
    deferrals/drops **0**, `piece-start-commit-failed` **0**,
    `sidecar-run-raced` **0**, `schema-doc-quarantine` **0** (the ensure-ON
    tripwire, clean), `structure-load-stuck` **0**; server-side
    `event-view-lag` 45 (4–5 per run, greens and reds alike).
    **The three reds all carry the entry's CURRENT charge verbatim** —
    `eventInvocationCount: 7` and `notebookInvocationCount: 7` with
    `notebookActionCount: 0` and empty `notebookActionsById`,
    `notebookActionTail`, `notebookCoreNodes`: all seven invocation traces,
    no bound notebook action state. This is the first LOCAL reproduction of
    the direct-CI charge; the CI artifact could not establish the store side
    and these runs can. They split into two read-side shapes:
    (i) **a03 and a07 — the KEYLESS stranded-whole-piece shape**, exactly one
    `pattern-load-error` for a keyless identity
    (`keyless:fid1:0r4P8HEr…#default`, `keyless:fid1:R6f49f-N…#default`),
    then `isNotebook: false`, `noteCount: -1`, `notesLength: 0`, 84 stored UI
    chips and zero rendered. That is **r06/r09's stated discriminator** — the
    member whose mechanism was never root-caused and which this row has
    carried as absence-of-observation since 2026-08-24. It is observed again,
    2 in 10, at current main. Recorded and NOT resolved by that measurement
    seat: this row says r06/r09's durable pointers are all REAL identities and
    the keylessness is session-side, but in a03 the failing keyless identity
    is present in the DURABLE store at seq 57 of the notebook space, and both
    reds' notebook spaces carry 8 distinct `keyless:fid1:…` references.
    Variant or distinct durable-keyless member is a root-cause question.
    (ii) **a04 — a LIVE but incomplete piece**: zero `pattern-load-error`,
    `isNotebook: true`, `noteCount: 5`, `notesLength: 5`, 8 stored chips and 4
    rendered — and still `notebookActionCount: 0`. It matches neither
    read-side member as stated (r01 needs a complete store; r06/r09 need the
    keyless load error) and is not the 2026-08-26 store-incomplete shape
    either, which required the recursive-schema `pattern-swap-setup-error`
    the source-authority fix removes. Ruled out in all three from store and
    both logs: the split-source launcher shape, the b04 client-start class,
    and the fifth-face load-park member (no `memory session revoked`, no
    `sync-load-failure`, no load-park deferral or terminal drop).
    **DISPOSITION: NO LIFT.** The bar stays 10/10 quiet-and-loaded; the entry
    and its bound guard stay, with the charge they already carry — this
    campaign confirms that wording rather than changing it. Per-run ledger
    and per-red classifications are on the measuring box at
    `/Users/berni/labs-worktrees/b1-lifts-evidence/runs/default-app/`
    (`a03|a04|a07/classification.md` beside the raw dumps) with the running
    report at `/Users/berni/labs-worktrees/b1-lifts-report.md`.
    **ROOT CAUSE, 2026-08-27 (the r06/r09 member, from a03/a07's own
    stores + logs; full report
    `../../history/plans/server-execution-v2/optimize/keyless-diagnosis-2026-08-27.md`, branch
    `claude/server-exec-v2-keyless-diagnosis`): the member is a
    WRONG-BRANCH OPTIMISTIC NAVIGATION, not a stranded whole piece.**
    The client's speculative run of the final-"Create" handler
    (`notebook.tsx`: `shouldNavigate = !usedCreateAnotherNote.get()`
    → `navigateTo(newNote)`) read the flag false/undefined while the
    durable value was TRUE (a03: derived seq 24 set true 14:27:55; the
    authoritative consequence seq 57 patched true→false, proving the
    server read true and computed NO navigation — and no navigate
    intent for the note exists in any effects doc). The client enacted
    optimistically (`optimisticNavigate`, navigate-to.ts — enactment
    with no withdrawal when the authoritative run's branch computes no
    effect) and the view moved to the new NOTE: reds carry TWO
    `set-view` lines where every green carries ONE. Every wait and
    every diagnostic reads `view.pieceId`, so `isNotebook:false,
    noteCount:-1, notesLength:0, 84 stored chips` is a healthy NOTE
    read through notebook accessors (the 84 chips are the note's own
    `$UI`) — "every read returning nothing" was reads of the wrong
    piece. The keyless `pattern-load-error` is downstream collateral of
    mounting that freshly materialized note: `Runner.setup()` durably
    stamps session-keyless patternIdentity (the `patternIdentity` stamp
    in `Runner.#applySetupState()`, `runner.ts`, whose `if (entryRef)`
    filtered nothing — `entryRefForPattern` always mints;
    the serving runtime wrote `keyless:fid1:0r4P8HEr…` at a03 seq 57
    onto an ORPHAN sub-piece doc nothing else durably references, in
    EVERY run, greens included), the navigated client re-derives the
    same doc ids live, arms the watcher with its OWN keyless mint, the
    server's differing mint syncs in, the load fails, and the CT-1923
    roll-forward CORRECTLY refuses (running ref also keyless) — one
    error line, one stranded orphan sub-piece, not the step's verdict.
    The CI charge (33008274232 shard 5: same fingerprint, zero load
    errors) is the same chain with the sub-piece hash race falling the
    other way — navigation alone produces the full fingerprint, load
    error optional; charge and r06/r09 UNIFY. Why 2/10 quiet-biased:
    the flag is read only inside handlers (no render/derive demand), so
    under lazy materialization nothing pulls the authoritative patch to
    the client; once the speculative echoes retire (watermark-gated,
    speculation.md §4) a later speculative read regresses to the stale
    base — fastest on a quiet box. That divergent-read link is inferred
    from the speculation design, not witnessed (the overlay is
    process-memory): flagged, not filled. NO FIX LANDED — all three
    layers end in unstated semantics owed an owner ruling: (L1)
    speculative echo retirement can regress reads for demand-less docs
    (speculation.md §4's replacement guarantee is demand-gated); (L2)
    optimistic enactment has no withdrawal on authoritative-branch
    divergence (protocol.md §5 nonce convergence covers only
    intent-arrives); (L3) two code paths durably write `keyless:` refs
    (setup's stamp; `substituteOpPatternRefs`' sentinel, the latter
    test-pinned as sanctioned) against the never-durable contract
    stated on `Runner.#sessionPatternPointers` in `runner.ts` —
    whether a durable piece tree may carry
    a pointer only one session can load is the unstated
    identity-assignment semantic. Fixing L3 alone would NOT green the
    step (the verdict is L1+L2); fixing L1/L2 alone leaves durable
    poison pointers.
    **RULED 2026-08-27 (owner, coordination chat) — L3 and L2; L1 remains
    an OPEN owner question (no ruling received; flagged, not filled).**
    L3 ruled (a), verbatim: keyless identities must NEVER land durably
    (honor the existing contract; the transformer hoists all
    source-authored lift()/handler() code to cf:module — CT-1644/CT-1655
    — so the keyless population is runtime-built pattern VALUES whose
    PRODUCING CODE is module-addressed; "nothing keyless should ever
    need loading"). Recovery semantics: reactive producers re-derive on
    demand (run the producing lift); handler-created-outliving-session
    is out of contract (must instantiate from content-addressed
    artifacts) — handler-replay is NOT built, deferred to the
    codeless-rebuild arc (seed: `docs/plans/codeless-graph-rebuild-seed.md`).
    L2 ruled PUNT, verbatim: optimistic navigateTo stands even when the
    authoritative branch computes no intent — the client navigates, so
    be it; the default-app step must be robust to it (the step's
    navigation-robustness fix is the companion PR on
    `claude/server-exec-v2-default-app-test`).
    **LANDED (keyless close-out PR-1, branch
    `claude/server-exec-v2-keyless-guard`): the L3(a) guard, all
    writers.** A THIRD writer beyond the diagnosis's two fell out of
    the build: the storage-boundary serializer itself
    (`patternToEncodableForm`) — the mint sets the value's forward
    entry ref, so the designed "no entry ref → full graph" fallback
    stopped firing and every boundary write of a minted pattern VALUE
    emitted the keyless ref. Landed: (1) boundary serializer treats a
    keyless ref as no-ref (full graph); (2) `Runner.setup` skips the
    durable `patternIdentity`/`patternSetupIdentity` stamps for
    keyless refs — keyless pieces genuinely carry no pointer, the
    verdict `getPatternIdentityRef`'s own doc always claimed; the
    `onPatternInstantiated` report deliberately does NOT share that
    gate (it reports the SESSION pointer, keyless included — it is a
    session-side reporting channel, and cf-harness's stranded-piece
    guard consumes exactly the keyless evidence via `keylessSince`;
    coupling it to the stamp made that guard fail open, caught on the
    board by the pre-existing `fabric-instantiations` pin and now
    pinned report-flows-AND-store-stays-clean in the scan test);
    (3) `substituteOpPatternRefs` no longer
    substitutes the keyless `$patternRef` sentinel — the durable inputs
    doc carries the full embedded graph and the instantiating session
    registers a session-side resolution hint keyed by the inputs doc,
    so CT-1812 stays sealed in-session; (4) `setArtifactEntryRef` lets
    a REAL ref replace a keyless one (the mint used to permanently
    shadow a later-indexed real identity — first-write-wins); (5) the
    CT-1923 roll-forward's refuses-when-running-ref-also-keyless arm
    now converges the unloadable durable pointer to the running VALUE's
    module-addressed PRODUCER (`resolveProducerEntryRef`: first real
    entry ref up the derivation chain, as many steps as recorded); a
    from-scratch runtime-built value has NO in-memory producer link
    (frames carry the building code's `implementationIdentity` but
    nothing records it per-artifact, and a lift-module identity would
    not be a loadable PATTERN identity anyway) — that shape stays a
    tolerated orphan, `keyless-running-no-producer` at debug, nothing
    written; (6) legacy tolerance for pre-guard durable keyless
    pointers: watcher and start walk record
    `legacy-keyless-pattern-pointer` at debug (not
    `pattern-load-error`), `loadPatternByIdentity` short-circuits
    (storage cannot hold a session identity), the start walk reports
    not-started instead of rejecting; (7) mint-site tripwire
    (`keyless-mint-missing-association` + `keylessMintAnomalies`
    counter): a module-indexed pattern (source path present) reaching
    the mint is the missing-association bug surfacing — full runner
    battery ran silent. The build also surfaced — and replaced — THREE
    in-session roles the durable keyless stamps had been quietly
    playing, each now served session-side (dies with the session, the
    contract's own shape): (i) the pattern POINTER for
    separate-start/resume/stop-restart flows and (ii) the
    setup-completion MARKER for `storedSetupMarker`'s reuse decision —
    both via `Runner.#sessionPatternPointers`, written exactly where the
    stamps are skipped; and (iii) the intra-session CHANGE SIGNAL for
    RUNNING sub-pieces: a lift re-deriving its returned pattern used to
    reach the running piece's swap machinery THROUGH the stamp (setup
    wrote the pointer, the meta watcher fired, swapToPattern replaced
    the graph) — now a session swap channel
    (`Runner.#sessionPatternSwaps`) carries the live value to the
    watcher's own swap closure with the same guards; real patterns
    keep the durable-stamp path byte-for-byte. Test pins that read the
    durable stamp for hand-built pieces were adjusted to the contract
    (cfc-boundary, patterns-lift/handlers diagnostics-identity source,
    scheduler-event-receipts' Decision-13 discriminator → setup's
    result-schema meta). Pinned red-first in
    `packages/runner/test/keyless-never-durable.test.ts` (raw-sqlite
    byte scan across all three writer paths; producer convergence;
    start-walk tolerance; tripwire — 4 of 5 red at base, the
    legacy-heal pin being a regression guard for the pre-existing
    roll-forward arm).
    **FLAGGED OPEN SEMANTIC (found by the close-out build, owed an
    owner ruling — flagged, not filled): rejected-consequence
    re-derivation for computation-produced children.** The
    `child-pattern-start-ownership.test.ts` convergence pin's
    mechanism WAS the ruled-out churn: pre-guard every re-derivation
    of a lift-produced child durably re-stamped a fresh per-source
    `keyless:` pointer in its own setup tx, a rejected handing commit
    cascaded narrowly, and the child's meta watcher converged the
    graph to whichever stamp stood. Post-guard the handing run's
    durable footprint is its piece-instantiate tx, so a rejected
    handing commit cascades through every subsequent run
    ("pending dependency not resolved"), durable and local state roll
    back COHERENTLY to the pre-bump child, the error callbacks
    release the child and clear the materialization memo — and then
    nothing re-derives it (the producing lift's inputs are
    unchanged; the trigger that used to exist was the stamped-pointer
    watch). Needed: a re-run trigger for a computation whose
    consequence commit was rejected — the client-side cousin of the
    §3d mark-vs-effects question above. The end-to-end pin is
    `it.ignore`d with this flag inline; it lifts on the ruling, not
    on a build. **a04 RECLASSIFIED — a DIFFERENT member, the
    WRITE-side loss family (lunch third-member kin), not r06/r09:**
    all 7 create events durably appended and marked
    `consequenced: true`, but clientSeq 10 and 11's consequences are
    1-op 802-byte derived commits carrying ONLY the mark (seqs 53/56;
    healthy siblings run 19+ ops) — two user actions permanently lost:
    the mark blocks re-dispatch and a dropped first-ever run leaves no
    basis rows to re-run (the D3 gap record above). The
    mark-survives-dropped-contributions atomicity break is its own
    §3d-disposition question for the owner. The final Create being one
    of the two lost events is also why a04 did NOT navigate (one
    set-view). The #6224-armed decisive line
    (`deferred-start-catchup-failed …resolved without the piece
    running`) did not and could not fire in any of the three reds —
    `deferred-start-catchup` was 0 campaign-wide — so these reds are
    decisively NOT the catchup-resolved-without-running variant.
    **THE a04 FAMILY ROOT-CAUSED AND FIXED — mark/effects atomicity,
    RULED 2026-08-27 (owner) and built the same day (branch
    `claude/server-exec-v2-mark-atomicity`). The ruling:** atomic with
    all its effects — contribution-level all-or-nothing. If ANY effect
    op of a consequence contribution is withdrawn or requeued by the
    wave, the MARK op goes with it — the entry stays
    pending-unconsequenced, the standard re-drain re-delivers, and the
    retried handler's cause-derived (idempotent) writes converge. (α)
    preserved: the mark still commits exactly once, only never without
    its effects. Handler-launched patterns: launch writes are
    cause-derived/idempotent; ON's run-until-first-idle analog is the
    serving cycle's settle — no kickoff logic needed or wanted.
    **The split point, store-proven (evidence before code): NOT the
    wave.** commitWave already treats an event-handler contribution
    atomically (whole-contribution requeue, wave.ts; per-doc drops
    apply only to derivation kind; the batch build never strips a
    handler contribution's ops; the mark rides the handler's own tx,
    runtime.ts `streamEntry` doc + space-server.ts's stamper, written
    BEFORE the body runs). The wave was HANDED a 1-op contribution:
    the split is the DISPATCH-side skip at runner.ts's stream path —
    `readJavaScriptArgument` → `isValidArgument === false` → "action
    argument is undefined (potential schema mismatch) -- not running"
    logged, handler body skipped, and the tx — holding the
    pre-stamped mark and nothing else — sealed and committed cleanly.
    a04's toolshed.log carries exactly TWO of those ERROR lines
    (14:34:01.511 and .725, the two notebook create handlers'
    `$ctx`), one per lost event; `events.processed 15` vs
    `appended 14` shows clientSeq 10's FIRST run silently requeued
    (its cause-derived note materialization surviving as the seq-52
    orphan sets, no consequence_of) before the REDISPATCH hit the
    skip mid-churn; clientSeq 11 skipped on its first dispatch. The
    class was already NAMED in prose (scheduler/events.ts's B7
    comment, scheduler/facade.ts's preflight doc: "its argument fails
    the schema, the run is silently skipped, the entry marked
    consequenced with no error — silent event loss"); B7 guarded one
    trigger (the per-actor fan-out instance), a04 is a second trigger
    (serving-replica view churn on the handler's `$ctx` docs) through
    the same unguarded skip. **The fix (the ruled substance adapted to
    the verified point — mark durability ⇒ effects durability):** the
    runner records the skip on the tx
    (`dispatchedHandlerNotRun`), and the scheduler's event finalize
    WITHDRAWS a served dispatch's tx instead of sealing it — aborted,
    reported `{kind: "deferred", cause: "handler-not-run"}`, counted
    `events.handlerNotRunDeferrals` (serving-loop.md §7) — so the
    entry stays pending and re-drains (the 8-deferral threshold
    hardens a permanently unresolvable argument into the visible §5
    DROP notice; no stream wedge). An LT1 copy withdraws through the
    abort alone (no onFailure): the batch marks only a surviving lt1
    run, the entry lands unmarked, the drain re-delivers with a
    `streamEntry`. A client/OFF dispatch carries no mark and is withdrawn
    and requeued by the scheduler within its retry window, or withdrawn
    and dropped at once when it was sent with `retries: false`
    (events.md §5's client bullet); a flag-ON client echo seals its skip
    as an empty speculative commit. Spec: events.md §5's handler-body-did-not-run
    bullet (RULED 2026-08-27). **Pin (red-first, watched):**
    `executor-events-down.test.ts` "mark/effects atomicity at the
    DISPATCH layer" — a served event whose handler `$ctx` requires a
    number the argument doc does not yet hold: at the pre-fix base
    the entry consequenced with ZERO effects (the a04 1-op shape —
    watched red at the `consequenced not.toBe(true)` assert); with
    the fix the entry stays pending through counted deferrals, the
    healing write re-drains it, and mark + effects land in ONE
    derived commit exactly once (α run-count witness: the
    non-idempotent bump reads exactly 1; exactly one consequence-
    carrying commit; the committing batch holds the sidecar mark op
    AND the argument write together). Mutation kill: reverting the
    finalize withdrawal (= the pre-fix base) reds the pin at the same
    assert. Full events-down suite green with the fix (29 steps).
    **NAMED FOLLOW-UP, not built (owner, verbatim, 2026-08-27): the
    mark may duplicate the result-cell write-once guarantee** — "the
    idea was that all handlers write result cells (even if the value
    is undefined), and that CAS for that is the write-once guarantee.
    but if that means we don't need the mark after all, consider
    marking that for follow-up improvements rather than expanding
    scope." If mark retirement is taken up, the drain's
    delivered-scan would key on the handling receipt/result cell
    (spec §7.6's cause-derived receipt address) instead of the
    entry's `consequenced` field — recorded here as the candidate
    key, not a design. Also recorded, not owed by this fix: WHY the
    redispatch's argument read failed mid-churn (the transient
    resolution failure on ctx docs the first run's withdrawal left
    behind) is its own diagnosis — the atomicity fix makes every such
    transient recoverable by re-drain instead of a permanent loss.
    **FIX ROUND (independent review of PR #6459, 2026-08-27): F1
    landed — the withdrawal carries §2's arrival-order barrier.** The
    review DEMONSTRATED (213 ms probe) that the new deferral arm let
    a later-arrived same-space served entry overtake the withdrawn
    head — the b01 class re-opened at a new arm: durable log
    ["B","A"] against arrival [a1, b1], b1 sealing while a1 was
    pending. The withdrawal now sweeps later-arrived durable served
    followers out of the scheduler queue with
    `{cause: "arrival-barrier", blockedBy}` exactly as
    `failHeadEventLoadPark` does (a shared events.ts helper,
    enqueueSeq-guarded because these arms do not fail at the
    un-dispatched queue head; the piece-start deferral arms — the
    review's named sibling gap, same no-sweep shape, same disposition
    — carry the same sweep). Pins red-first, watched: the ordering
    pin inverts the review's probe (executor-events-down "the
    handler-not-run withdrawal carries the arrival-order BARRIER" —
    pre-fix/mutation red at stored log ["B"] while a1 pends; fixed:
    b1 barrier-deferred and the healed re-drain lands ["A","B"]); a
    unit pin (scheduler-event-identity) drives both piece-start
    failure modes and the exclusions (cross-space neighbours and LT1
    copies stay queued). Mutations killed arm by arm: finalize sweep
    disabled → ordering pin red at the ["B"] overtake with the piece
    sweeps still active; piece sweeps disabled → unit pin red with
    the finalize sweep still active. The barrier's MID-PASS half
    landed with it: the sweep can only hold entries already queued,
    and a withdrawal landing while the drain pass awaits a later
    sidecar's sync let the pass queue the next arrival behind the
    barrier's back (the load-park fix's P1 gap, reopened for this
    cause) — the plain-deferral arm now sets
    `#loadParkDeferredInPass` for handler-not-run, and the drain's
    existing past-every-await check stops the pass. RESIDUAL,
    recorded (scoped-verify SV1): the piece-start (cold-view)
    deferral arms carry NO cause, so they never set the pass flag —
    their in-queue half is swept by the shared helper, but a
    piece-start deferral landing mid-pass keeps the pre-existing
    mid-pass window (their deferrals usually land outside a pass;
    same one-flag shape if ever taken up). Deterministic
    pin, red-first (watched): the load-park mid-pass construction —
    pass held at B's sidecar sync, A2's withdrawal counted inside the
    hold, gate healed before release — pre-fix durable log
    ["A","B","A"], fixed ["A","A","B"]; the watched red is the
    mutation evidence (that tree was the final code minus exactly the
    flag-set). **F2 landed** — the terminal §5
    notice branches on the final deferral's cause ("handler did not
    run after N withdrawn dispatches"; the old
    no-runnable-handler/load-attempt boilerplate was false in both
    clauses for this class), red-first through the full 8-deferral
    budget with THIS cause — which also closes the review's stated
    gap that the threshold path was code-traced, not test-run. **F3,
    recorded shape, not built:** a deferral that heals below the
    threshold leaves its `#eventDeferrals` entry for the tenure, and
    `#eventDeferrals.size > 0` arms `#eventScanOwed` on every
    admitted commit — a per-commit drain rescan over an (empty)
    pending set. Pre-existing for every plain-deferral cause;
    handler-not-run makes heal-after-defer the COMMON case, so the
    residue now arms routinely. Cheap close if taken up: delete the
    eventId on successful seal. **F4: no change owed** — the
    atomicity pin's final batch assert is corroborative; the teeth
    are the α run-count and the single consequence-carrying commit.
    Sibling entry, landed mid-review: #5744 (lunch-poll profile-first
    join) re-skipped `integration/lunch-poll-vote.test.ts` as a FILE
    entry on this row's b04 signature — its recorded reds PREDATE the
    recovery, whose mechanism targets exactly that death; the entry
    lifts on its own gate evidence at the merged head, never by
    inference from the default-app gate.
    **THE LUNCH-POLL FILE ENTRY'S OWN GATE, 2026-08-24: 7/10 — NO
    LIFT. The b04 START class is CLOSED on this file's own evidence
    too; what keeps the entry is a THIRD residue member, and it is on
    the WRITE side.** Method, as the merge note prescribed: ON-built
    binary at the merged head `f14e44830` (#6224's catch-up-and-start
    in tree), sha256 `ce65782063f4f14a1…` re-verified into every run's
    ledger line; the FILE entry NEUTRALIZED in the working tree for
    all runs (the tree held at exactly that one-file diff, recorded
    per run rather than asserted) and the file's having RUN verified
    per run from its own `running 1 test from …` line; fresh store,
    own port and posture probe per run (`shellServerExecutionDefine`
    "true" + `servingLoop` present, 11/11; port-free check after
    every run, PID-only kills); ensure-off
    (`SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false` — deliberately the CI
    ON lanes' posture, i.e. what a lifted file would actually run
    under); 10 counted runs INTERLEAVED 5 quiet / 5 loaded (r00 a
    smoke, uncounted). Verdicts: greens 19-39 s; every red the test's
    own 300 s `waitForCondition` net (313-322 s wall — never the
    600 s harness bound, which was never raised); reds r02 (loaded),
    r05 and r09 (quiet), plus the quiet smoke — NOT load-driven
    (loads 1.7-15.5 with no relation to the verdict; if anything the
    quiet arm fared worse). The report is ARCHIVED at
    `../../history/plans/server-execution-v2/optimize/lunch-gate-evidence-2026-08-24.md`;
    its per-run evidence is NOT in the repo and stays on the measuring
    box at `/Users/berni/labs-worktrees/lunch-lift-evidence/`
    (`runs/r00…r10/` each with its ledger, test and toolshed logs,
    meta+stats JSON and its own `memory/` store; `probes/p1…p3/`,
    `final-ledger.txt`, and the harness).
    **b04 CLOSED at this head:** `deferred-start-catchup` fired in
    EVERY run (10 activations over the 10 counted, 11 with the
    smoke), `deferred-start-catchup-failed` **0**, terminal `Error
    committing deferred …` **0**, `pattern-load-error` **0** — the
    entry's own recorded death ("dies terminally on a
    stale-confirmed-read ConflictError") did not reproduce once, in
    either arm, reds included. Strictly that is the ABSENCE of the
    death's lines rather than a positive witness of each recovery's
    success; the signature is unmissable and never appeared.
    **THE NEW MEMBER — the GUEST's mid-session profile piece never
    lands its PROGRAM-materialization commit.** All three reds are
    one shape at one place: `Timed out waiting for #lp-join-button to
    render` (`lunch-poll-vote.test.ts`), the GUEST's join click;
    the host always joins; the join card renders `Unknown profile` /
    `Create profile` forever because the viewer's `#profile` wish
    never resolves. Everything before it passes in seconds even in
    the reds; the wall time is entirely that 300 s net. The
    store/log discriminator
    separates the arms 11/11 including the smoke: in every RED the
    guest's profile space holds exactly **4 commits, NO
    `patternIdentity` in any of them, and 0 mentions in the toolshed
    log** (its identity home space 2 commits instead of 4); in every
    GREEN both profile spaces reach 14-21 commits, both carry
    `patternIdentity`, and the server names them 57-216 times. The
    stalled store is BYTE-IDENTICAL across the reds — seq 1 authored
    337 B / 1 op (the space ACL), seq 2 derived 167 B (watermark
    set), seq 3 authored 125 187 B / 3 ops `{of:2, cid:1}`, seq 4
    derived 200 B (watermark patch) — and seq 3's three ids are
    content-addressed and identical across runs AND across different
    randomly generated identities, i.e. a deterministic
    identity-independent closure fragment, not the guest's own piece.
    What is MISSING is the ~98-101 operation, 76-200 KB authored
    commit carrying the piece's root doc, its `computed:` docs and
    its whole `cid:` program/schema closure WITH `patternIdentity` —
    the commit after which, in a green run (and for the HOST's space
    even inside a red one), the serving side engages and the space
    converges over 13-19 commits. With no pattern meta durable the
    serving loop has nothing to load and never names the space at
    all. The reds are also SILENT client-side (0 browser warn/err in
    r00/r02/r05, exactly 1 in r09; greens emit 5-14 designed
    non-fatal lines — the client says nothing when it fails and
    complains when it succeeds), which is what makes the store the
    only usable witness; the worker console bridge was verified live
    at all three levels first, so the silence is a finding rather
    than a blind instrument. **CAMPAIGN FORK, DELIBERATELY LEFT
    UNDETERMINED AT THAT HEAD:**
    whether that commit was REFUSED, DROPPED in flight, or NEVER
    ISSUED. The guest's space appears in NO server-side line at all —
    including none of the 50-73 per-run
    `foreign-write-refused` / `seal-space-commit-failed` refusals,
    which name OTHER spaces and fire just as often in greens — so the
    refusal hypothesis is unsupported by these logs and this is not
    S-A regressing; the write appears never to have reached the
    server, and that link is the open question the campaign hands on.
    **Why a member and not a re-sighting of the two read-side ones:**
    NOT r01's silent `readCell` starvation — that member is
    store-verified COMPLETE with the piece context fully live and
    only the read starved, whereas here the store is missing the
    PROGRAM and no piece ever ran, so there is no live context to
    starve; NOT r06/r09's shape — that member fires
    one watcher `pattern-load-error` for a keyless identity with
    patternIdentity STAMPS PRESENT in the durable store (real ones
    beside keyless ones — the keylessness itself is DURABLE, per the
    2026-08-27 correction; the older "session-side" reading was
    wrong), whereas here `pattern-load-error` is 0 in every run and
    the durable store carries NO `patternIdentity` stamp at all —
    absent stamps, not keyless ones. What it IS is this
    row's opening sentence verbatim, placeholder included —
    reappearing for a piece the SECOND browser creates MID-SESSION,
    and reached by a DIFFERENT route than the row's recorded one
    (S-A fixed the writeback-refusal route; here the client's program
    commit appears never to reach the server).
    **Two flags, recorded not acted on.** (1) S-B's durability
    barrier cannot cover this: the test awaits `waitForRuntimeIdle`
    on the guest immediately after the create (the host's identical
    path greens every time), and a barrier over IN-FLIGHT work does
    not await a write that is never in flight. (2) The S-C skip
    ruling's PREMISE does not reach this case: S-C was skipped on the
    reasoning that every create runs through `waitForRuntimeIdle` —
    S-B's barrier — before any RELOAD; this surface has NO reload at
    all, does run the create through the barrier, and still loses the
    program in every red. Whether that reopens S-C is the owner's
    call, not a measurement call.
    **Anti-red-herrings, recorded so the next seat does not
    re-derive them.** `piece-start-commit-failed` is NOT this file's
    discriminator: 13 occurrences across the campaign, 1-2 per run,
    in GREEN runs as often as red. It did not explain these reds, and
    ruling it out cost the measuring seat real time. The arm now observes
    the self-minted transaction's wave settlement: a contribution drop
    cancels only the node group that transaction installed, preserves
    the outer registration and its parent/root cancellation ownership,
    waits for retry readiness, and instantiates the still-current
    pattern once into the next wave. A stop/stopAll/dispose aborts that
    readiness and any named-document pull through the outer registration's
    cancellation signal; a runtime cycle, pointer change, or newer node
    group wins through exact guards. Under server execution, an immediate
    stale-read refusal follows the same catch-up and one-shot reinstantiation
    path: it is the commit-time form of losing the materialization race, not a
    terminal graph failure. A second recoverable failure tears the exact
    registration down rather than spinning. A whole-wave abort or abandon is
    not retried in place. Non-stale refusals and promise rejections remain
    terminal in every posture, and client/OFF retains terminal behavior for
    stale reads: a graph whose setup writes never landed is a zombie unless
    the serving side's materialization supplies the repair path. Explicit wave
    abandon is classified separately and warned without incrementing the
    serving runtime's structure-load-failure observer. A recoverable failure
    is warned on the same terms while its one retry is outstanding, and is
    counted only if that retry also loses: the writes have not landed YET,
    and reporting a loss the retry goes on to repair makes a routine race
    read as a health regression on the very counter that exists to find real
    ones. Every other failure remains loud.
    Pinned in `executor-wave.test.ts` by a deterministic whole-document
    conflict plus a held-readiness teardown companion, a flag-OFF
    terminal-behavior companion, and a second-refusal companion for the
    commit-time arm. The readiness assertions name a real conflicted
    document, so the catch-up's named-document pull is exercised rather
    than skipped. And OW46's
    `structure-load-stuck` counter is BLIND here: it fires 6× per run
    in BOTH arms and in the reds names only the HOST's space, because
    it counts deferred structure loads of DEMANDED roots and this
    space's root is never demanded at all.
    **Side probe (n=3 — a LEAD, not a finding; diagnostic, outside
    the gate and the ledger).** With only
    `SERVER_EXECUTION_ENSURE_SPACE_ROOTS` flipped to `true`: **3/3
    RED, and red EARLIER and differently** — all three time out
    filling `#wish-profile-name-input`, i.e. the HOST's
    profile-create surface never renders, 300 s, before the
    campaign's failure point is even reached, with NO profile space
    created at all (the campaign's reds at least create the guest's
    space). Two narrow conclusions: the lane's ensure-off posture is
    ruled OUT as an explanation of the campaign's reds, and
    ensure-ON is a strictly worse regime for this file — worth
    someone's attention independently, at n=3 on a non-sanctioned
    posture. Bearing recorded as a bearing, not a finding: the loss
    here is WRITE-direction and occurs at ensure-OFF, so OW61's
    separate client-side ABSORB investigation is not expected to
    close this shape.
    **SUPERSEDED CAMPAIGN DISPOSITION: NO LIFT.** The 2026-08-24
    campaign kept the entry on the narrowed guest-profile
    program-materialization charge and left the mechanism fork open.
    **CURRENT DISPOSITION: RESOLVED — the server never issued the
    materialization commit on its first served attempt.** Under ON the
    client may run the handler speculatively, but intentionally discards
    that seal and waits for the authoritative server transaction.
    **OWNER RULING 2026-08-26:** “with ON, the transaction should go
    through the server. it's in this case fine for the client to just
    wait for that to complete vs speculatively running things.” The
    server reached `ProfileHome.inSpace()` before the anonymous target
    name was cached; name resolution warmed the cache and threw
    `RetryImmediately`, but `retries: false` caused the served event to
    be dropped instead of rerun. The scheduler now preserves the served
    carriage across that name-resolution requeue and reruns it in the
    same settle. Ordinary transient commit retries remain disabled. The
    red-first scheduler regression failed at one attempt before the fix
    and passes at two; production-shaped ensure-OFF ON evidence moved
    from 2/8 target-member reds on current main to 0/8, with all eight
    guest stores carrying the 98-operation `patternIdentity`
    materialization. Baseline head: `37b45336a`; diagnostic fix head:
    `8524f4ec1`; rebased smokes: f10 at `622ef2bda` and f11 at
    `e158eb0c3`. The run stores and logs remain on the measuring box at
    `/Users/berni/labs-worktrees/lunch-member-evidence/`; the running
    report is `/Users/berni/labs-worktrees/lunch-member-report.md`.
    This was neither a server refusal nor loss of a required client wire
    send; it was the server name-resolution retry gate preventing
    issuance.
    **THE 2026-08-27 LIFT ATTEMPT: the local re-baseline PASSED 8/8 and
    the DIRECT CI UNSKIP PROBE ON THE SAME BRANCH went RED — NO LIFT.**
    Recorded in that order because the order is the finding. The bar the
    local campaign satisfies is the one the
    2026-08-26 ruling set in place of the old 10/10: an approximately
    eight-run re-baseline, a red-first mechanism regression, and eight
    post-fix runs. The regression and the first eight runs landed with
    #6378; this is the re-baseline, run at main `4b70949ac` on an ON-built
    binary (sha256 `5018e589dc54b19a1…`, re-verified per run), fresh store
    and own 97xx port and ON posture probe per run, LLM masked, PID-only
    teardown with a port-free check, the FILE entry neutralized in the
    working tree throughout (the file's having RUN verified per run from
    its own `running 1 test from …` line), `gtimeout 600` never raised,
    four quiet and four loaded interleaved. **8/8 GREEN in 17–18 s** — the
    file's recorded green band is 19–39 s and every recorded red was its
    own 300 s `waitForCondition` net at 313–322 s, so no run came near
    either. TWO posture changes, both harder and both deliberate: the
    space-root ensure is **ON**, the production default the CI ON lanes
    returned to at #6248 — the 2026-08-24 campaign's own n=3 side probe had
    called ensure-ON "a strictly worse regime for this file" (3/3 red), and
    the class it saw was root-caused and fixed by #6312 — and the toolshed
    now self-sources its pattern `API_URL` on the run port, the corrected
    source authority the default-app RCA prescribed.
    **The member's own store discriminator is negative in 8/8.** The
    2026-08-24 red signature was store-side and byte-stable: the GUEST's
    profile space holding exactly 4 commits with NO `patternIdentity`,
    against greens reaching 14–21 commits; the missing artifact was the
    ~98–101-operation authored commit carrying the piece's root doc and its
    whole `cid:` closure WITH `patternIdentity`. Census over all eight fresh
    stores: five spaces per run (one more than the archived campaign's four
    — the ensure is ON now), **every space in every run carrying
    `patternIdentity`**, each with a materialization commit of 141–198
    operations; the smallest space in the campaign holds 5 commits. The
    4-commit zero-`patternIdentity` guest space does not occur once.
    Counters across the eight: `pattern-load-error` **0**,
    `pattern-swap-setup-error` **0**, `deferred-start-catchup` **0**,
    catch-up failures **0**, terminal `Error committing deferred` **0**,
    `session-remount` **0**, load-park deferrals/drops **0**,
    `schema-doc-quarantine` **0**, `structure-load-stuck` **0**; stale-read
    lines 8 (1/run), `piece-start-commit-failed` 8 (1/run — this row already
    records it as NOT this file's discriminator), `sidecar-run-raced` 8
    (1/run, #6312's designed loud yield), and the recorded background of
    `foreign-write-refused` / `seal-space-commit-failed` refusals (80 and
    40 per run; this row already records that background as firing just as
    often in greens). Evidence on the measuring box at
    `/Users/berni/labs-worktrees/b1-lifts-evidence/runs/lunch/` (per-run
    ledger, test and toolshed logs, meta+stats JSON, own `memory/` store,
    plus `store-census.txt`), report at
    `/Users/berni/labs-worktrees/b1-lifts-report.md`.
    **AND THEN CI SAID NO.** The lift PR (#6410) un-skipped the file, so its
    own CI ran it in the true lane for the first time since #5744's re-skip:
    **ON shard 7 of run 33085668531 (job 98564797510, head `0cebb3621`) went
    RED.** Not at any stage this row records — the failure is
    `lunch-poll-vote.test.ts`, the **HOST's**
    `clickCfButton("#lp-join-button")`, timing out at the test's own
    300000 ms bound after 5m10s with `"#lp-join-button": []` and the poll
    body rendered. Every red this row has recorded for this file is the
    GUEST's join click, and the 2026-08-24 gate's own finding was
    that "the host always joins". The 2026-08-24 n=3 ensure-ON side probe is
    the nearest recorded neighbour — it timed out even earlier, filling the
    HOST's `#wish-profile-name-input` — and #6312 fixed the member that
    probe saw. Whether this is that family's residue, a new host-side
    member, or the fifth-face load-park member reaching this surface is
    UNDETERMINED from the CI artifact: the CI window between the file's
    start and its failure is SILENT (zero `pattern-load-error`,
    `pattern-swap-setup-error`, `sidecar-run-raced`,
    `deferred-start-catchup`, `session-remount`, `piece-start-commit-failed`
    — the neighbouring occurrences in that job's log fall outside the
    window), and **CI does not publish the toolshed log**, so no server-side
    member can be excluded from it. **The OFF lane's shard 7 PASSED on that
    same run** (`Pattern Integration Tests (7/10)`, same commit, same runner
    pool), so the red is ON-specific rather than a general flake in this
    file. n=1 in CI, against 0/8 locally.
    **DISPOSITION: NO LIFT.** The entry stays, its reason extended with this
    probe (and the skip-list test pinned to it) so the 8/8 cannot be read as
    a clean bar by the next seat. What the split says on its own terms: a
    local campaign — however careful its posture, and this one deliberately
    matched the lane on both the ensure and the source authority — is not
    the lane. This row already carries one member with exactly that profile
    (the fifth-face load-park member: local control 0/12, CI 2/2 red on two
    shards), and the honest reading is that the lift bar for this file
    should require a green DIRECT CI unskip probe, not a local count alone.
    That is a bar change, so it is the owner's call, flagged not taken.
    **RULED 2026-08-27 (owner: "agreed") — THE BAR CHANGE IS TAKEN, AND IT
    BINDS EVERY ON-SKIP ENTRY, NOT ONLY THIS FILE.** An entry lifts only on
    BOTH (1) its own local campaign bar AND (2) a GREEN DIRECT-CI UNSKIP
    PROBE: a commit on the lift branch that removes the entry's guard, a CI
    board that demonstrably RAN the un-skipped surface, and that probed lane
    green. A local campaign is evidence about the box it ran on; only the
    lane is evidence about the lane. Both of this row's entries carry a
    member with exactly that profile (the fifth-face load-park member: local
    control 0/12 against CI 2/2 red; this file's 2026-08-26 split: local 0/8
    against CI 1/1 red), so the probe is not ceremony — it is the only
    observation that has ever caught them. A RED probe WITHDRAWS that
    entry's lift: the signature is captured from the job log and classified
    against this row's recorded members, and any sibling entry's lift stands
    or falls on its own probe. No rerun-looping — one probe board,
    classified honestly.
    **SURFACE READING — RULED 2026-08-28.** The bar was ruled hours before
    its first use, and the case that distinguishes its two readings arrived
    immediately: the default-app probe's own step passed while its shard went
    red on a CO-RESIDENT file the entry has nothing to do with. The
    coordinator's recommendation — that requirement (2) binds the PROBED
    SURFACE, so a green probed surface satisfies it, and a co-resident
    failure is a separate defect carrying its own accountability rather than
    a veto on an unrelated entry's lift — went to the owner, who ruled
    **"agreed with your recommendations, proceed" (2026-08-28)**. So
    requirement (2) reads: the CI board demonstrably RAN the un-skipped
    surface and THAT SURFACE was green. Two things the reading does not
    license, both live: a co-resident red is not thereby forgiven — it is a
    defect owed its own row, seat, or entry (the flip's bar is a green ON
    lane, not merely an empty skip list, so unlisted co-resident debt still
    blocks the flip); and a probe that reds AT THE PROBED SURFACE still
    withdraws the lift exactly as written above.
    **THE ENSURE-ON PROFILE-SURFACE MEMBER ROOT-CAUSED AND FIXED
    2026-08-25 (PR #6312) — the n=3 side probe's "create surface never renders"
    shape and the #6248 board's profile-shard family, reproduced
    locally: a WRITE-side SELF-CLOBBER of the wish's create-surface
    sidecar — neither recorded read-side member, and not a
    provisioning loss.** Reproduced 6/11 at main `35ab29c38` (true
    topology, ensure defaulting ON, fresh store + posture probe per
    run; shared-profile, profile-embed, and a probe driver): every
    red's store shows the served `#profile` wish's profile-create
    sidecar materialize DURABLY and then — inside the SAME wave
    commit — a patch removing `/value/$NAME` and
    `/value/createProfile` and replacing `$UI` with an error span
    carrying a conflict message. Mechanism: every pre-resolve launch
    of the sidecar chains its OWN instantiation continuation on the
    resolution already in flight (`openSidecarSurface` — by design,
    so a launch arriving mid-flight joins one rather than starting a
    second), so a wish node that runs twice before that resolution
    answers instantiates the sidecar twice into the same
    cause-derived result cell; the losing duplicate's commit fails on
    the conflict class (`StorageTransactionInconsistent` /
    `ConflictError` — its snapshot predates the winner) and
    `runSidecarInOwnTx`'s error arm wrote the ERROR UI over the
    winner's surface (`commitPatternErrorUI`). Nothing re-issues (the
    continuation is one-shot; the wish never re-ran — residual (i)
    below), the client faithfully renders the durable error box, the
    create input never exists, and the run is SILENT — the register's
    "fail EARLIER at the host's create" prediction, mechanized. FIX
    (red-first): a conflict-class failure (commit-refused or thrown
    mid-run) now checks the RESULT CELL — a materialized value there
    means a sibling instantiation won, and the loser YIELDS, loudly
    (`sidecar-run-raced`, serving-loop.md §3d's failure-arm
    contract); an EMPTY cell means the conflict came from an input
    doc (e.g. the home `profiles` list moving), and the run RE-RUNS
    against fresh state (bounded, three attempts) rather than
    abandoning the only instantiation; the error UI is reserved for
    real fetch/compile/run failures and the bounded-retry terminal.
    No local dedupe latch: the pin drives the duplicate from a
    second runtime instance of the same node (cause-derived
    convergence is the design), so yield-on-conflict — the OCC
    discipline `createSpaceRootIfAbsent` already uses — is the fix,
    not dedupe. Pin: `wish-sidecar-duplicate-launch.test.ts` (two
    runtimes, one store, the same compiled `#profile` piece → one
    wish-node cause → one sidecar cell; a gated fetch holds the
    duplicate window open, a registration-counted witness — the
    `wishSidecarDiagnostics` test seam, this package's stand-in for
    the missing logger-capture idiom — proves the duplicate
    continuation is chained before release, and a runs-delta
    assertion kills the vacuous-green path; watched red at `$NAME`
    undefined with the conflict text durable; removing only the
    conflict-class yield reds it again). The sidecar run also now
    observes its wave settlement OUTSIDE the tracked launch (an
    awaited settlement would make `idle()` wait on the wave that
    waits on quiescence) and warns (`sidecar-run-withdrawn`) when a
    committed instantiation is withdrawn, and the wave accumulator
    names DROPPED contributions (`contribution-dropped` — requeues
    and superseded derivations stay quiet; both are expected
    recovery): the r05/p11 cascades each surfaced exactly ONE logged
    symptom before this.
    Live evidence, by head: 6/6 GREEN in 23-27 s at the ORIGINAL fix
    head `bcd816b8a` (shared-profile ×2, profile-embed ×2, probe ×2)
    and 3/3 GREEN in 20-22 s re-run at the review-round head
    `95734a5b0` (one of each) — same harness, fresh store + posture
    probe per run, against 6/11 red pre-fix on the same box; the
    9-green record has well under 1% probability at the pre-fix
    rate.
    Residuals recorded, NOT owed by this fix: (i) in red r05 the wish
    action held a durable `scheduler_basis` row on its ready-cell
    read (seq 0, user-instance-keyed), the ready flip landed at
    commit 31, waves kept running through 44 — and the wish action
    provably never re-ran (wish-state doc frozen; greens re-run it
    within 60 ms and heal everything). When that re-run fires, every
    one-shot loss heals; when it does not, any one-shot loss is
    permanent. Gear undetermined — its own seat. Related, from code
    reading: a DROPPED contribution leaves NO basis rows
    (`#basisRowsFor` covers survivors only), so "its own reads re-run
    it when fresh state lands" is structurally false for a first-ever
    run that gets dropped — the D3 basis-row gap.
    **D3 DECOUPLED from the a04 event family (2026-08-27, the
    mark/effects-atomicity pass):** for HANDLER EVENTS the re-arm is
    the RE-DRAIN, not basis rows — the durable pending-unconsequenced
    entry is itself the retry record, so a withdrawn or never-run
    handler dispatch needs no basis row to run again (the atomicity
    fix keeps the entry pending exactly so that mechanism carries the
    recovery). D3 therefore stays scoped to REACTIVE first-runs with
    no durable retry record behind them — the wish case above, where
    a dropped first-ever derivation leaves neither basis rows nor any
    entry to re-drain. (ii) The dual-updater contention finding is CLOSED:
    following a piece's source belongs to its explicit opener, while root
    ensuring does not follow source (piece-source-lifecycle.md; OW56 finding
    2). The serving runtime explicitly opens wish sidecars; it also performs
    the hot-swap after an accepted pointer change.
    (iii) The lunch FILE entry's
    third member (ensure-OFF: the guest's ~98-101-op
    program-materialization commit never landing) is a DIFFERENT,
    post-click stage; it is now resolved by the served-event
    name-resolution requeue described in that entry's current
    disposition. The 2026-08-26 owner ruling and evidence recorded there
    supersede the earlier 10/10 lift bar with the requested approximately
    eight-run re-baseline, a red-first mechanism regression, and eight
    post-fix runs. (iv)
    Whether the #6248 board's
    POST-fill shape (shards 2/6: fill succeeded, click landed,
    `#profile` never resolved) is this same clobber on a later
    surface or another member is undetermined — re-measure on that
    board at a head carrying this fix. **RESOLVED 2026-08-25 (the
    re-measure: CI failure-path store capture at the lane-flip head,
    run 32929764230, scratch instrumentation branch
    `claude/server-exec-v2-postfill-diagnosis` — never merged): NOT
    this clobber — ANOTHER MEMBER, one mechanism across both shards,
    store-proven in both captures.** The trusted CreateProfile
    click's durable entry is healthy (seq 17 in both event spaces:
    `target.value "Ada Lovelace"`, `rendererTrusted: true`, clean
    admission), and the served dispatch DROPPED it pre-dispatch: the
    head-event load park awaited a cross-space replica load of the
    HOME space's ensured `defaultPattern` quote doc — a doc the
    server's OWN ensure had durably written ONE second earlier — and
    the load failed `ConnectionError: memory session revoked:
    unauthorized` (storage/v2.ts sync-load-failure) because the
    serving plane's home-space session predated the genesis ACL
    (activation-before-genesis, the recorded boot order) and the ACL
    landing revoked it (`#revokeDeauthorizedSessions`,
    memory/v2/server.ts — by design; a HOME
    genesis is `{user: OWNER}` with no `"*"`, so the pre-genesis
    session is de-authorized the moment it lands. **This clause read
    "by design, heal-on-next-mount" until 2026-08-26. That premise was
    FALSE — nothing remounted — and its falsification is the FIFTH-FACE
    member recorded at the end of this entry.**);
    `failHeadEventLoadPark` (scheduler/facade.ts) maps ANY load-park
    failure to the TERMINAL drop arm, and the drain sealed
    `{status: "dropped", consequenced: true}` with the watermark
    advanced (seq 18, `consequence_of` naming the eventId) —
    at-least-once discharged, nothing ever re-runs the event, the
    authoritative handler never executes, and the surface starves
    the full 300 s net. This VIOLATES events.md §5's T3 drop
    predicate ("no runnable handler", never "the run raced"): the
    handler was runnable and the input doc existed durably; the
    spec-conforming disposition for an unreachable input is
    `deferred` (no consequence; re-drain) — the same code's own
    docstring names the split. Negative discriminators, both stores
    swept whole: clobber patch signature 0, `sidecarError` 0,
    `sidecar-run-raced` 0 (this fix HOLDS — no hole); not the
    read-side r01 member (an error account exists and the
    consequence is absent, not present-but-unread); not residual
    (i)'s basis-row gap (the entry is consequenced-dropped, and the
    only dropped contributions — 3× `compile-cache/writeback` in the
    speculative profile space's first waves — re-ran and healed in
    the same second); not OW54's give-up arm (no CFC rejection, no
    commit attempted) and not OW58's notice wedge (the notice sealed
    cleanly). A NEW served-event-family member: the pre-dispatch
    load-park failure arm. Rates at this base: shard 2 red 2/2 CI
    boards, shard 6 red 2/2, local control 0/12 — the click must
    land inside the [pre-genesis session open → revocation →
    re-mount] window with a cross-space read at preflight; slow CI
    runners do, the local box did not. Shard 9
    (`cfc-staged-publish`, `TrustedSaveDraft` → `#saved-title`) red
    1/2 and GREEN on the capture board — UNHARVESTED: symptom-
    compatible with this member, no store evidence, classification
    open. Observability, recorded: a terminally dropped served event
    is invisible in serving stats (`events.*` has no dropped
    counter; only the scheduler WARN line and the entry's
    `status: "dropped"` field carry it). Product exposure: an ACL change
    that REMOVES the serving session's authority or changes its
    delegated owner revokes that session by design
    (`#revokeDeauthorizedSessions` — authority-PRESERVING grants
    leave the session valid; Cubic P2 on this PR scoped the claim),
    so under ON a served dispatch's cross-space load racing such a
    revocation permanently and silently discards a user's trusted
    action; the fix direction (load-park failure →
    `deferred`/re-park) touches the seal-adjacent path — OW58's
    "(α)-critical, its own deliberate pass" caution applies, and the
    disposition (fix-before-flip vs. narrow honest step-skips naming
    shared-profile's, profile-embed's, and staged-publish's steps
    with an owed row) is the owner's call, deliberately not taken by
    the diagnosis seat.
    **FIXED 2026-08-26 (its own deliberate seal-adjacent pass, no
    riders — the OW58 caution above is why): the load-park failure arm
    DEFERS a served event instead of dropping it.**
    `failHeadEventLoadPark` (scheduler/facade.ts) now settles a served
    event through the `deferred` arm — no consequence sealed, the
    durable entry left pending and UNCONSEQUENCED, the standard
    re-drain re-delivering it — and carries the drain's arrival-order
    BARRIER with it (events.md §2, mirroring the sidecar-sync-failure
    arm), in TWO halves, because the deferral can land in two places.
    IN THE QUEUE: every later-arrived durable served entry behind the
    head IN THE SAME SPACE defers too. MID-DRAIN-PASS: the
    scheduler-side barrier can only hold what is already queued, and
    the drain awaits a `sync()` per new sidecar — so a park failure can
    land between one entry's queueing and the next's, and the next
    entry would queue behind the barrier's back and overtake. The
    second half (`#loadParkDeferredInPass`) makes the pass STOP there,
    the same `break` the sidecar-sync arm makes; found in this seat's
    own adversarial pass, and its mutation reds `["A","B","A"]` exactly
    like the in-queue one. Its CHECK POSITION is load-bearing and was
    got wrong first: the loop awaits TWICE per entry (a new sidecar's
    `sync()` and then the stream doc's), and a rejection landing in
    either window sweeps only what was queued at that instant — so the
    check sits past BOTH, immediately before
    `#drainInFlight.set`/`queueEvent`. Independent review (Codex P1 on
    PR #6365) caught it one await too early. **Coverage gap recorded,
    NOT filled:** the pin discriminates the check's EXISTENCE (delete
    it → red) but NOT its POSITION — measured, not assumed: with the
    check moved back to the pre-review position the pin still passes.
    Discriminating the position needs the park rejection to land inside
    the stream-doc-sync window specifically. **PIN OWED, CONSTRUCTION
    SKETCHED** (review F7 corrected this seat's earlier "a flaky pin
    would be worse than none" — the construction is fully CAUSAL, not
    timing-raced, so that framing overstated): hold B at its sidecar
    sync (the shipped gate), wait for A2's park to be CREATED (a
    parkObserved hook in the seam, as the scheduler pin already does),
    arm a second gate on B's stream-doc sync (`cell.sync()` always
    reaches `syncCell` — verified, no warm-cache short-circuit),
    release the sidecar gate, hold at the stream gate, reject the park,
    disarm, release. Every step causally ordered, no timers. Recorded
    rather than built here only to keep this round scoped to the two P1
    pins; see review-6365-report.md F7. Until it exists the position
    rests on the code comment and this record. Two
    exclusions, deliberate: cross-space
    queue neighbours (§2's order is per-space) and LT1 in-process
    copies (`served` with no `streamEntry` — no durable entry to
    re-drain, and a running event's same-wave cascade children rather
    than later arrivals; their entry re-drains WITH a `streamEntry`,
    the `lt1LeftoversPurged` semantics). CLIENT-side (no `served`) the
    drop keeps today's shape — there is no durable entry to re-drain,
    so deferring would lose the event outright; the same split
    events.ts already makes for a piece-load failure, and client-side
    the two arms are behaviourally indistinguishable anyway (both
    remove the event and abort its onCommit). T3's genuine
    no-runnable-handler drop is UNTOUCHED — only the load-FAILURE
    routing changed.
    **Persistent-failure posture, stated:** a load that never heals
    defers INDEFINITELY — durable, visible, re-tried each drain. The
    deferral is deliberately kept OFF the queued class's bounded
    creation-race budget (`EVENT_DEFERRAL_DROP_THRESHOLD`, which
    hardens into §5's drop after 8 deferrals) by a typed
    `cause: "load-park"` on the served failure outcome: that budget
    exists because a piece which never materializes has no runnable
    handler, whereas here the input doc EXISTS durably and only the
    read path failed, so hardening would restore exactly the
    at-least-once discharge this fix removes. Indefinite deferral is
    strictly better than silent loss and is the accepted posture; its
    cost is that the backstop rescan keeps ticking, so a never-healing
    load holds the space out of its idle park. A give-up arm for that
    case is OW54's separately tracked territory and was deliberately
    NOT built here.
    **The price, quantified (review §2 — it was asserted but not
    costed).** Per poisoned space, per 250 ms backstop tick: one drain
    pass, one queueEvent, one preflight, one park, one real load attempt
    against the failing backend, and 1+N WARN lines (head plus barrier
    victims). So ~4 load attempts/s and, for a 10-event backlog, ~44 log
    lines/s sustained — a WARN-flood cost the fix frames as
    observability. Same-space later served events are head-of-line
    blocked indefinitely BY DESIGN (order over liveness). Cross-space
    events are not deferred, but the scheduler is head-serial, so the
    poisoned head occupies the head slot for one park-to-rejection
    latency every tick — negligible for the production error (a revoked
    session rejects immediately) but a TIMEOUT-class slow failure would
    stall co-scheduled dispatch at 4 Hz. That slow-failure case is what
    makes OW54 worth scheduling rather than itself deferring
    indefinitely.
    **Weakening recorded (review F5), and it is DELIBERATE but was
    unstated.** The arm's `#eventDeferrals.delete(entry.eventId)` on
    every load-park deferral — head and barrier victims alike — means
    the cold-view give-up guarantee is no longer "8 deferrals" but "8
    CONSECUTIVE cold-view deferrals uninterrupted by a load-park
    failure". Under a FLAPPING serving session (revoke/remount cycling
    — the production mechanism here) a genuinely unrunnable event whose
    cold-view deferrals interleave with load-park failures at least once
    per ~7 ticks never hardens, wedging the park criterion active for an
    event T3 licenses dropping. The intent was only to keep the budgets
    unmixed; the sharper alternative — leave the cold-view count ALONE
    rather than resetting it, since not-mixing is not the same as
    resetting — preserves the hardening bound and belongs in OW54's
    design space. Not changed here: it is a behaviour change to the
    cold-view arm, which this deliberately scoped pass does not touch.
    Observability gap CLOSED with the fix: `events.loadParkDeferrals`
    counts each deferral (head and barrier alike) and `events.dropped`
    counts terminal drop notices sealed onto a durable entry — the
    previously invisible half; a loud WARN per deferral names the
    failing doc keys and the error. serving-loop.md §7 carries both.
    Pins, red-first: `executor-events-down.test.ts`'s "a served event
    whose HEAD-EVENT LOAD PARK fails DEFERS instead of terminally
    dropping" (a new `GatedStorageManager.loadParkFailAddress` seam
    reports one doc as an in-flight load and REJECTS its park settle
    with the production error text; observed pre-fix red: BOTH entries
    sealed `{consequenced: true, status: "dropped", reason: "Event
    dropped: required replica load failed before dispatch"}` — the
    exact CI store shape) and
    `scheduler-event-load-park.test.ts`'s "a SERVED event's load-park
    failure reaches the drain as a load-park DEFERRAL, not a drop"
    (the contract the SpaceServer's `onFailure` branches on; the
    pre-existing client-side drop pin beside it is unchanged).
    A third pin covers the mid-pass half: the drain's sync gate holds a
    pass at B's sidecar with A2's park already failed inside it, and
    after healing and release the log still reads `["A","A","B"]`.
    **CORRECTED 2026-08-26 (independent review F3 — this record briefly
    claimed a mutation red that does not reproduce, the one thing it
    must never do).** The original in-queue row was measured BEFORE the
    mid-pass half existed and never re-run after; with both halves
    present, emptying the in-queue loop leaves the suite GREEN, because
    that pin's two handlers both read the ARMED doc — so a barrier-less
    B parks on the same failure and self-defers through the HEAD arm.
    The in-queue half is now discriminated by its own pin: the
    `DISJOINT_CLOSURE_LOG_PATTERN` gives `pushA` an extra `gate` input
    linked to a SEPARATE doc, the seam arms only that doc (so B stays
    perfectly runnable), and the park rejection is HELD
    (`loadParkSettle`) until both entries are provably queued —
    `events.processed` up by two with the head parked — so the mid-pass
    half cannot be what preserves the order. A fifth pin discriminates
    the typed-cause budget bypass (review F4, the posture's load-bearing
    half, previously unpinned): a PERSISTENT failure, waited past
    `EVENT_DEFERRAL_DROP_THRESHOLD` on the `loadParkDeferrals` counter
    rather than a sleep, must still seal nothing — then heals and
    delivers once.
    Mutations, all red, all re-run at this head: restore the drop
    routing → both entries seal dropped and the log never grows past the
    warm-up (and the scheduler-level pin reads `kind: "dropped"`); empty
    the in-queue barrier loop → "B1 must not consequence while the
    earlier-arrived A2 is deferred", `["A","B","A"]`, the OW45 arm-B b01
    overtake shape; drop the `#loadParkDeferredInPass` check → the same
    overtake through the mid-pass gap; fall the load-park arm through
    into the threshold accounting → "a persistent load failure must
    never harden into events.md §5's drop". The barrier's TWO
    EXCLUSIONS are pinned too — they were the coverage ratchet's two
    uncovered lines, and were COVERED rather than accepted: a
    scheduler-level pin queues, behind a parked served head, a
    same-space durable sibling, another SPACE's durable entry, and a
    `streamEntry`-less LT1 copy, and asserts the sweep takes only the
    first. Independently red: drop the cross-space guard → "another
    space's entry must not be swept"; drop the LT1 guard → "a
    streamEntry-less LT1 copy must not be swept". Construction note for
    whoever edits it — both traps cost this seat a red: `addEventHandler`
    stamps `populateDependencies` onto the HANDLER FUNCTION OBJECT, so
    each stream needs its own function (sharing one makes all four park
    on the armed doc), and same-stream sends COALESCE by doc id, so the
    cross-space neighbour needs its own id rather than the sibling's
    with the space swapped. Battery green at the fix:
    executor-events-down
    (26 steps, the α3 retry machinery untouched), executor-fan-out,
    executor-serving-loop, scheduler-event-load-park,
    executor-space-server, executor-watermark, executor-stats,
    executor-wave, executor-cross-space, and the full
    `packages/runner` package (1301 passed / 7549 steps / 0 failed).
    **THE BARRIER INVARIANT AS STATED IS NOT CLOSED — a THIRD path gets
    past both halves (review F1, structural from the code; not built as
    a repro, and NOT a landing blocker because both the re-mark and the
    shaper routing pre-date this PR and the pre-fix behaviour — terminal
    drop — was strictly worse).** The drain re-marks durable entries
    renderer-trusted before queueing (space-server.ts), and
    `Scheduler.queueEvent` routes any renderer-trusted payload with
    `doNotLoadPieceIfNotRunning=false` — what the drain passes — through
    `holdShapedEvent`. The wake shaper's first `BURST_CAPACITY` (10)
    deliveries per piece-group are synchronous, so the barrier sees
    those; overflow sits in `group.pending` and releases as a batch on
    the next window tick (≤1000 ms) straight into `queueSchedulerEvent`,
    knowing nothing of a barrier sweep that ran while it was held.
    Scenario, and the fresh-space backlog drain IS the OW45 window:
    >10 renderer-trusted served entries for one piece drain in one pass;
    1–10 queue, 11+ are shaper-held with their `#drainInFlight` guards
    set (so re-drains skip them). Head 1's park fails → the in-queue
    sweep defers 2–10 and the mid-pass break stops further queueing, but
    11+ are in NEITHER place. The window tick releases 11 into the
    now-empty queue; the load heals (this failure heals on next mount,
    seconds); the rescan re-drains 1–10 BEHIND 11 → 11's consequence
    lands ahead of 1–10, the §2 inversion the barrier exists to prevent.
    (If the load still fails when 11 heads, 11 self-parks and order
    self-heals; the overtake needs the heal inside the
    release-to-rescan window — a real race for a transient failure.)
    Named follow-up shape: exempt DRAIN RE-DISPATCHES from shaping —
    they are re-deliveries of already-shaped input, so re-shaping
    double-charges the timing budget anyway — or have the shaper's
    release re-check barrier state. Sibling PRE-EXISTING hazard minted
    separately as **OW63** below.
    STILL OPEN, untouched by that fix: shard 9
    (`cfc-staged-publish`) stays UNHARVESTED — symptom-compatible,
    no store evidence, classification open — and the #6248 lane
    disposition remains the owner's call, now with the fix-before-flip
    option actually available.
    **FIFTH FACE — THE MISSING SESSION REMOUNT. Store-proven
    2026-08-26 (CI run 33021643751, the same board's shards 2 and 6,
    both captures swept whole; forensics report
    `session-remount-report.md`). FIXED the same day, its own seat.**
    Not a new code region: a newly-falsified PREMISE, and the one
    #6365's deferral arm rests on. Post-#6365 the disposition changed
    exactly as designed — watermark held AT the click's entry (seq
    17, not 18), `consequence_of` naming the eventId **0**,
    `events.dropped` **0**, the entry left pending and
    UNCONSEQUENCED — and the event still never ran: **350 deferrals
    over 5m47s in shard 2 (329 in shard 6), `loadParkDeferrals` 349
    / 328, ZERO successful loads**, every one
    `ConnectionError: memory session revoked: unauthorized` on the
    same three replicas, at the 250 ms backstop cadence decaying to
    ~1 s. `processed − loadParkDeferrals == appended` exactly in both
    shards — every unit of serving-loop progress after the failure
    was a re-deferral, which is precisely the criterion `stats.ts`
    sets for that counter. Discriminators, both stores swept:
    `sidecarError` 0 (not #6312/#6320), `RetryImmediately`/`inSpace`
    0 (never reached #6378), "no handler registered" 0 (not the
    previous board's T3 face), `scheduler_basis` rows 197/197 and
    228/228 in the shared space with 0 into home (not D3), the
    profile program materialized fine (not OW45's write path). The
    refused doc is PRESENT and durable: "sync completed without data"
    was an AUTHORIZATION outcome, not an absence.
    **The mechanism.** `SpaceReplica.#memoizedSessionHandle()` (storage/v2.ts)
    memoized the mount and dropped it only in `close()`, and
    `terminateSession` (memory/v2/client.ts) is terminal for a
    session — so every re-drain's load reused the very session the
    server had revoked. `storage/rejection.ts`'s SessionError note
    had already named the gap in prose ("the convergence argument is
    sound, only the remount is missing"); `scheduler/facade.ts`'s
    load-park docstring asserted the opposite ("healing by design on
    the next mount"). The capture settled it in rejection.ts's
    favour, and BOTH docstrings plus this entry's own clause above
    are reconciled in the fix's PR.
    **The fix — the space-root ensure's own re-arm, one layer down.**
    Stage 1 solved the identical boot order for the ensure by
    latching at the fail-closed refusal and consuming the latch when
    an admitted commit touches `of:<space>`
    (`#rootEnsureAwaitingOwner`). The session analog: `SpaceReplica`
    latches an ACL-doc admission (`noteAclChanged`) and consumes it at
    `#memoizedSessionHandle()` (`#consumeOwedSessionRemount`) — the one place
    every read and commit reaches a session — dropping a mount that
    `SessionRevokedError` or `AuthorizationError` terminated so the
    next load re-opens. `ExecutorHost.#onCommitAdmitted` fans an
    `of:<space>` write out to EVERY registered space server, because
    the starved session is a CROSS-SPACE replica: the ACL commit and
    the dead session are in different spaces.
    **Why a LATCH and not an eager teardown, measured not assumed.**
    The memory server emits the admitted-commit notice BEFORE it runs
    `#revokeDeauthorizedSessions` (both inside one `transact`). At
    notification time the session that same commit is about to revoke
    is still OPEN, so an eager teardown inspects a live session,
    declines, and the revocation lands a moment later — starving
    exactly as before. Mutation-checked: making the trigger eager
    reds the host-glue pin and only that pin.
    **Soundness — the remount never decides.** It re-runs
    `session.open`, which re-runs the server's admission against the
    ACL as it now stands. One CORRECTION to the seat's own brief,
    recorded because it changes what "fail closed" means here: under
    OW31 a SERVING mount's READ decisions resolve as whoever OWNS the
    space, so an ACL change that removes the USER does not
    de-authorize the serving plane — it re-binds the NEW owner, which
    is the outcome `#revokeDeauthorizedSessions`'s own comment asks
    for ("the serving plane's next mount re-binds the new owner
    instead of reading indefinitely under a stale identity"). The
    denial the remount must respect is constructible on a principal
    the ACL does not grant, and that is the general statement anyway.
    Both are pinned.
    **Pins, red-first, `executor-session-remount.test.ts`** (a real
    memory server in ACL-enforce mode with the OW31 delegating class,
    real signed loopback sessions): the reproduction (pre-genesis
    session, genesis revokes it, 8 reads / 0 successes / all
    "revoked", then the ACL notice heals it and the durable doc reads
    through); fail-closed (one trigger, two outcomes, only the ACL
    chooses); the ownership re-bind; NO CHURN (a live session survives
    an ACL commit with zero new `session.open`s); and host glue (a real
    ExecutorHost whose own admission observer carries the genesis —
    nothing hand-fed); and the SILENT-STALE-READ pin (the Cubic-P1
    class: post-remount reads for tracker-covered selectors returned
    SUCCESS carrying the pre-revocation value — reproduced at the
    pre-fix commit, fixed by dropping the dead mount's selectors from
    the watch tracker at both consume sites, pinned both ways).
    Mutations, all red, each reddening its own pin alone: no-op the
    consume → the reproduction, fail-closed, ownership re-bind,
    host-glue, and stale-read pins (no-churn stays green);
    remove the host fan-out → host glue only; remove the ACL-verdict
    guard → no-churn only; eager instead of latched → host glue only
    (the measured ordering-independence proof); remove the tracker
    drop → stale-read only; remove `pull()`'s consume → stale-read
    only.
    **Residual, FLAGGED not filled:** watches installed on the DEAD
    session are not replayed on remount. The revocation had already
    stopped their pushes (the server drops the session from its
    registry and `terminateSession` clears `#watchSpecs`), and the
    remount now DROPS the dead mount's selectors from the watch
    tracker (the Cubic-P1 fix — the earlier claim that "each address
    re-installs on its next pull" was FALSE for tracker-covered
    selectors and is retracted), so post-remount reads re-install
    coverage fresh instead of silently serving pre-revocation state —
    but a general "replay the watch set on remount" still belongs
    with the reconnect path's replay. **Also unchanged:** CLIENT runtimes get no host
    notification, so a browser session revoked this way still stays
    revoked; out of this seat's scope.
    **The persistent-failure posture is UNCHANGED and still OWED to
    OW54.** A load whose ACL never changes — or whose re-open is
    denied — defers indefinitely, exactly as recorded above. The
    remount removes the case where the heal existed in the design and
    not in the code; it does not remove the need for a give-up arm.
    The F1 barrier scenario above ("the load heals ... seconds") now
    has an actual mechanism behind its premise for the fresh-space
    boot order; it was written against a heal that did not exist.
    **PHASE 3 — BOTH ENTRIES CAMPAIGNED UNDER THE RULED
    LOCAL-PLUS-CI-PROBE BAR, 2026-08-27. NEITHER LIFTED, and the two now
    fail for OPPOSITE reasons.** Base: main `1fc841b6e`, one ON-built
    binary (sha256
    `a93047a461c0c4d8cb5c63106179eaf9613b2b431269877255100e7fbaf40e79`,
    re-verified into every run's ledger; a mismatch aborts the run), fresh
    store and own 97xx port and ON posture probe per run, ensure defaulting
    ON, the toolshed self-sourced on the run port, LLM masked, PID-only
    teardown with a port-free check, `gtimeout 600` never approached, quiet
    and loaded interleaved. Probe head `95f313835` (both entries and the
    default-app in-file guard removed in one commit), CI run
    [33138358110](https://github.com/commonfabric/labs/actions/runs/33138358110);
    eight of the ten ON pattern shards passed, shards 5 and 7 red — the two
    shards that carry the two probed files.

    **default-app's reload STEP: LOCAL 10/10, CI PROBE OF THE STEP GREEN,
    LANE RED ON A CO-RESIDENT FILE — the entry's own charge did not
    reproduce in either arm.** Ten counted runs (5 quiet / 5 loaded,
    interleaved, plus an uncounted green smoke) at 13–14 s wall each,
    against 313–315 s for every red the earlier 2026-08-27 campaign
    recorded; the step itself finished in 7–8 s. Campaign-wide zeroes:
    `pattern-load-error` (so a03/a07's keyless discriminator is absent —
    #6451), `pattern-swap-setup-error` and recursive-schema (the
    split-source artifact stays gone), `deferred-start-catchup(-failed)`,
    terminal `Error committing deferred`, `session-remount`, load-park
    deferrals and drops, `piece-start-commit-failed`, `sidecar-run-raced`,
    `schema-doc-quarantine`, `structure-load-stuck`,
    `contribution-dropped`, and `events.handlerNotRunDeferrals` — #6459's
    new deferral arm never had to fire, i.e. the a04 dispatch-side skip did
    not occur rather than being recovered from. Serving stats:
    `events.appended` 14 = `events.processed` 14 in all ten (no silent
    requeue), `dropped` 0, `needsAttention.total` 0, `derivedCommits`
    54–58, `settleAdvances` 12–15. Then the probe (ON shard 5, job
    98743591519) ran the exact step with no listed skip and it **PASSED —
    `ok (18s)`** — the whole `default-app flow test` green, and the shard's
    published toolshed log clean across the file's window (4
    `event-view-lag`, nothing else). Shard 5's red is
    `cfc-group-chat-demo.test.ts`: `clickCfButton("#host-send-button")`
    retargeting to the cf-button host (`cf-button#host-send-button < slot <
    div < cf-hstack`) — rootcause §2b's disabled-inner-button shape, whose
    S-G test-aim seat is named-but-unbuilt. That file is NOT skip-listed,
    is untouched by the probe diff, and **reproduces 4/6 RED locally at the
    same head running ALONE on a fresh store with the same signature
    (the same click, same retarget chain)**, so it is neither this entry's
    charge
    nor a probe artifact — see the OW31-adjacent observation below.
    **DISPOSITION AT THE TIME: NO LIFT, on the literal reading of the ruled
    bar** — the entry and its bound guard stayed, reworded to say exactly
    this, with an OPEN QUESTION referred to the coordinator/owner: does "the
    probed lane GREEN" mean the probed SURFACE green, or every test in the
    shard green? The bar was ruled hours before its first use and the case
    that distinguishes the two readings arrived immediately. **THAT QUESTION
    IS NOW RULED (2026-08-28): the SURFACE reading** (the bar's SURFACE
    READING paragraph above), **and this entry LIFTED on the evidence above
    — see the LIFT block at the end of this row.**

    **lunch-poll-vote's FILE entry: LOCAL 8/8, CI PROBE RED AT THE PROBED
    SURFACE — and the mechanism is now OBSERVED SERVER-SIDE for the first
    time.** Eight counted runs (4 quiet / 4 loaded, interleaved), 16–18 s
    each, against 313–322 s for every red this entry has ever recorded; the
    owner-directed approximately-eight-run pin MET locally, with
    `pattern-load-error`, `deferred-start-catchup(-failed)`,
    `session-remount`, load-park, `handler-not-run`/`arrival-barrier` and
    `events.handlerNotRunDeferrals` all zero, `events.appended` 9 in all
    eight, `dropped` 0, `needsAttention.total` 0, `derivedCommits` 74–87.
    (Present in every run INCLUDING the greens, so recorded as expected
    recovery rather than smell: one `sidecar-run-raced` — #6312's
    loser-yields arm — one `piece-start-commit-failed`, two
    `event-view-lag`, one stale-read line; b06 also logged two
    `contribution-dropped` and greened.) The probe (ON shard 7, job
    98743591583) went RED at the SAME stage and signature as the
    2026-08-26 probe: `lunch-poll-vote.test.ts`, the HOST's
    `clickCfButton("#lp-join-button")`, `Timed out waiting for
    #lp-join-button to render. Last probe: {"#lp-join-button": []}`,
    `waitForCondition` at its unchanged 300000 ms bound, 5m5s, the body
    reading "0 joined" and **"Unknown profile #MjhprA"**. The OFF lane's
    shard 7 passed on the same run, so the red is ON-specific.
    **WHAT IS NEW — the 2026-08-26 disposition's stated blind spot is
    CLOSED: CI now publishes the toolshed log as a job artifact**
    (`toolshed-log-pattern-integration-server-execution-on-7`), so the
    server-side members can be examined instead of merely not excluded. In
    the file's window that log carries **80 `structure-load-stuck` WARNs**
    on the profile space `did:key:z6MktpA5…`, the first naming demanded
    root `of:fid1:32Pic3-REdd7zmJ8gPchJyFD0LECk0u-QrFUXMjhprA` as
    `pattern-unloadable` after 8 consecutive deferred cycles — the
    detector's own words, "a forever-park … the home-profile
    program-write-loss shape" — and **that root's suffix IS the `#MjhprA`
    the placeholder rendered**. Upstream sit **20
    `seal-space-commit-failed` / `foreign-write-refused` pairs**:
    `applyInitialName` and a `__cfLift_1` action running in the HOME wave
    `did:key:z6Mkv7Tjz…` refused a write to the profile space for want of
    the §2b delegated carriage. So the chain is this row's ORIGINAL
    mechanism, end to end: profile program/name write refused → structure
    load parks forever → the name renders the `#id` placeholder → the join
    card never renders `#lp-join-button` → the HOST's join click times
    out.
    **CRUCIAL DISCRIMINATOR, recorded so nobody chases the refusal: the
    refusal is NOT it.** All eight local GREENS carry 80
    `foreign-write-refused` and 40 `seal-space-commit-failed` each — MORE
    than the CI red — with `structureLoadStuck` 0, `structureLoadRearmed`
    7–10 and `structureLoadTerminal` 190–199. The foreign-write refusal is
    a standing, tolerated condition in both arms; **the PARK is the
    discriminator.** Locally the profile space's structure load always
    resolves; in CI it never does, and why it never does is the open
    question this entry now names. Excluded from the CI window, all zero:
    `pattern-load-error`, `pattern-swap-setup-error`,
    `deferred-start-catchup`, `session-remount`,
    `piece-start-commit-failed`, `sidecar-run-raced`, `handler-not-run`,
    `arrival-barrier`, `memory session revoked`, `sync-load-failure`,
    `Event deferred` and `Event dropped` — so NOT the b04 client-start
    class, NOT the a04 mark/effects family, NOT the #6312 sidecar clobber,
    NOT the fifth-face load-park member, and NOT #6378's name-resolution
    drop. Each of those was a prior charge for this entry and each is now
    excluded by OBSERVATION rather than by absence of it.
    **DISPOSITION: NO LIFT.** Local 8/8 against CI 1/1 red, for the second
    campaign running — this file's lift needs the park explained, not
    another local count.

    **THE PARK EXPLAINED — ROOT-CAUSED 2026-08-28 from the probe's own
    artifact, and FIXED red-first: the child closure replication
    one-shot-died against the IN-FLIGHT SIBLING replication supplying its
    origin space.** The discriminating event sits 33 s before the first
    stuck warn and appears in NO local green (0/8 in the b-runs, 1/1 in
    the CI red): `closure-replication-failed entry=Jlzs0wulc086…
    from=did:key:z6Mkv7Tjz… to=did:key:z6MktpA5… Error: source closure
    unavailable in origin space` at 03:18:09.048 — the shard's ONLY
    pattern-manager error. That is the CT-1687 write path (S-A's
    carriage arm) — the ONE writer that supplies a fresh child space's
    program closure — failing at its READ side and, by its own contract,
    never retrying ("retried on the next child creation"; a user creates
    their profile once). With the supplier dead, the profile space's
    deferral loop re-reads an empty store every cycle: patternIdentity
    meta present (the carriaged materialization landed), the closure
    absent, verdict `pattern-unloadable`, forever — the 80 stuck warns
    are 40 distinct roots x streaks 8+16, the entire piece graph of that
    one space. The name derivation never runs, the placeholder renders,
    the HOST's join click times out. WHY the origin was empty — the
    deduction chain,
    each link forced: the serving session is ONE (every closure write in
    every b-run store is the service session's), so the reader and any
    same-runtime writer share a replica; the LAYERED VIEW was verified en
    route (a deterministic executor-wave-harness experiment: a fresh-tx
    read DOES see a held-open wave's staged writes — executor-wave.ts's
    documented design), so a compile TARGETING the parent space would
    have been readable the moment its pattern existed (E4 awaits the
    write-back); the handler demonstrably RAN ProfileHome (the refusal
    storm at 03:18:09.353 is its actions), so the pattern object existed
    — therefore it came from the CONTENT CACHE with `cached.space` a
    DIFFERENT space, and the content-hit arm (pattern-manager.ts ~2435)
    had fired `replicate(cached.space -> parentSpace)` fire-and-forget:
    the SIBLING, mid-flight at 03:18:09, its writes not yet issued —
    the one supplier shape that leaves the origin empty to every read.
    The b-run stores CONFIRM the machinery by commit class and timing:
    the first serving-side compile's E4 write-back lands in an
    identity-home space (seq 2 DERIVED, b01 03:05:48), the sibling
    replications into the other served spaces land DERIVED via each
    target's wave (lunch space seq 16, 03:05:51), and the child
    replications into the two profile spaces land AUTHORED with §2b
    carriage (seq 2, 03:05:54/56 — protocol §2's server-produced
    authored row). Local greens are the sibling winning by ~3 s; CI's
    crawling boot (first home-env compile 12 s after the parent space
    activated, the click ~1 s after the content cache warmed) flips the
    edge — the park was CI-timing-armed exactly as the method finding
    predicted, and the foreign-write refusals stay what this entry
    already said they are: standing, tolerated, present in every arm,
    NOT the discriminator. Causality was validated end to end by a
    working-tree fault injection (never committed): failing exactly the
    delegated-carriage replication once reproduced the FULL CI signature
    locally — 1 replication failure, 80 stuck warns over exactly 40
    `pattern-unloadable` roots, the join flow dead, the 300 s net
    (evidence: lunch-park-evidence/runs/lunch/inj01 on the measuring
    box). THE FIX, at the write path and never the tolerance
    (pattern-manager.ts): every replication registers under its TARGET
    space with a monotonic ticket (`replicationsIntoSpace`), and a
    replication awaits the STRICTLY OLDER replications registered INTO
    its origin space before reading it — event-driven (the siblings' own
    completion, no timers), acyclic by registration order (no from/to
    mutual wait), with genuine absence still failing loud and settling
    (pinned — no hang into `flushCompileCacheWrites` or the S-B
    durability barrier). Red-first pin
    `packages/runner/test/pattern-replication-sibling-race.test.ts`: the
    race is deterministic-by-construction (the child is issued
    synchronously after the sibling and its origin read is strictly less
    work than the sibling's read-plus-write); watched red at the
    pre-fix head with the exact production error line and the child
    space empty; 6/6 green with the fix; mutation-killed (neutralizing
    the await hunk alone reds it — the sibling step issues BOTH
    replications from a second manager whose fallback-origin map is
    empty, so the later fallback fix cannot mask this pin; moving them
    back onto the compiling manager silently unpins the await).
    Recorded residual, flagged not filled: a CROSS-REPLICA supplier (a
    client/harness write-back
    arriving over the wire) is outside the await's reach — no observed
    red has that shape (the deduction above excludes it for this one),
    and building for it would be filling an unobserved gap. Also
    corrected en route: this row's original "wave staging vs durable
    read" framing for the 2026-08-27 park is WRONG — the layered-view
    experiment kills it — and the 2026-08-26 blind-spot note's
    hypothesis space ("refused vs dropped vs never issued") resolves as
    NEVER ISSUED, by a supplier that died before writing.

    **LIFT ATTEMPT — lunch-poll-vote's FILE entry removed 2026-08-28 on
    the evidence below; WITHDRAWN BY THE PROBES (the PROBE-2/3/4 blocks
    that follow) and the entry RESTORED with the accumulated map.** The
    ruled local-plus-CI-probe bar, both halves as they stood at the
    attempt:
    - **Requirement (1), the local campaign — MET TWICE, 8/8
      quiet-and-loaded at the fix head AND 8/8 again at the rebased lift
      head.** Method both times: ON binary sha256 re-verified into every
      run's ledger (a mismatch aborts the run), fresh store + own 97xx
      port + ON posture probe per run, ensure defaulting ON, toolshed
      self-sourced on the run port, LLM masked, PID-only teardown with a
      port-free check, 4 quiet / 4 loaded interleaved. Campaign F at the
      pre-rebase fix commit (binary `8c693ea873…`, loads 4.3–10.4) and
      campaign G at the rebased head — fix `044993c98` on main
      `d9dc01d75`, which folds in #6477's UI-write retry on the very
      fill path this test drives (binary `0ef22fced1…`, loads 3.3–7.5):
      17–18 s walls in all sixteen runs against 313–322 s for every red
      this entry ever recorded; `structureLoadStuck` 0,
      `closure-replication-failed` 0 (the fixed mechanism's own line),
      `pattern-load-error` 0, `deferred-start-catchup(-failed)` 0,
      `session-remount` 0, `event-view-lag` 2/run, one designed
      `sidecar-run-raced` and one recorded-non-discriminator
      `piece-start-commit-failed` per run, and the tolerated refusal
      storm present as ever (40 `foreign-write-refused` + 40
      `seal-space-commit-failed` per run) — the park gone with the storm
      untouched, which is exactly the discriminator this entry named.
      The full runner suite is 1312/1312 at the rebased head. Campaign H
      re-ran the same 8-run posture at the v4 head (sibling-await +
      fallback-origin; binary `72be0363…`): 8/8 again, 17–19 s walls,
      `structureLoadStuck` 0, `closure-replication-failed` 0, and
      `closure-replication-fallback-origin` 0 — locally the heuristic
      origin is always supplied (the parent compiles first), so the
      fallback stays dormant exactly as designed; the runner suite is
      1312/1312 at v4 too. Evidence on the measuring box:
      `/Users/berni/labs-worktrees/lunch-park-evidence/runs/lunch/`
      (`f01…f08`, `g01…g08`, `h11…h18` — per-run ledger, test+toolshed
      logs, stats, own store); report
      `/Users/berni/labs-worktrees/lunch-park-report.md`.
    - **Requirement (2), the direct-CI unskip probe — THIS lift PR's own
      board**: the registry carries no lunch entry, so the ON pattern
      lanes RUN the file; per the ruled SURFACE reading the probed
      surface's verdict decides, and a red AT the surface withdraws the
      lift exactly as the bar states (captured and classified, never
      rerun-looped).
    **PROBE 2 (this PR's first board at head `83f31e47f`, run
    [33160430927](https://github.com/commonfabric/labs/actions/runs/33160430927),
    ON shard 7, job 98813758092): RED AT THE PROBED SURFACE — that lift
    attempt WITHDREW, and the classification found the SECOND supplier
    geometry.** The surface itself failed (the HOST's join, "Unknown
    profile #a_FyQU"; 11 co-residents passed — #6477's host-send fix
    held); the published toolshed artifact carries the SAME chain —
    exactly one `closure-replication-failed from=parent(z6Mkv6nW…)
    to=profile(z6MkpPK85…)` at 09:45:39.983, then 80
    `structure-load-stuck` (40 roots, `pattern-unloadable`) from
    09:45:44 — with the sibling-await IN PLACE and inert. The
    instrumented local greens (SCRATCH build, runs instr01/wdel01/wdel02
    on the measuring box) then decomposed the supplier model:
    (i) `compileOrGetPattern` is NEVER CALLED in this flow — the
    content-cache-hit sibling does not exist here; local greens have
    `olderIntoOrigin=none-registered` and still pass. (ii) The parent
    space's closure is supplied by the FIRST home-env/sidecar compile
    that targets it (`persistCompileCacheTracked(parent)`, whose
    per-module docs cover the profile-home entry) — locally always the
    session's first compile (instr01's line 1). (iii) On both CI reds
    the fetch/activation timeline shows NO compile ever targeting the
    parent (the two home-env compiles land on the identity-home spaces,
    09:45:30/34): `loadPatternByIdentity` then serves the pattern from
    the manager's IN-MEMORY ARTIFACT INDEX — which persists NOTHING
    per-space — so the parent space never receives the closure from any
    flow, and the child's read was never going to find it: an ORDER
    flip, not a data race. (iv) Wave-hold experiments (45 s holds on
    closure-carrying waves) could not falsify read-visibility — every
    local read trailed durability — so staged-vs-durable remains
    UNDISCRIMINATED and is NOT load-bearing for the fix. THE SECOND FIX
    (same PR, red-first): `PatternManager.#replicateClosures()` records
    every durable persist target per entry (`persistedClosureSpaces`) and,
    on a dry heuristic origin, retries its verified read against those recorded
    spaces — content-addressed, so the copy is byte-identical and the
    integrity-gated read stays fail-closed; genuine absence (no recorded
    target) still fails loud and settles. Pinned in the same suite
    (fallback test watched red at the sibling-await-only head with the
    exact production error; recording no-op mutation-killed; the
    no-record loud-failure control keeps the absence contract and — since
    the PR's fix round — the loudness too: a logger spy pins the single
    `closure-replication-failed` line, so a throw-to-silent-return
    mutation reds it). Under
    the CI geometry the identity-home persists ARE recorded, so the
    child replication converges order-independently.
    **PROBE 3 (the v4 board, run
    [33164596936](https://github.com/commonfabric/labs/actions/runs/33164596936),
    ON shard 7, job 98827162794): RED at the surface again — and the
    artifact caught the fix's own defect: the fallback NEVER FIRED
    (`closure-replication-fallback-origin` 0 beside the same one
    failure + 80 stuck warns), because the recording KEYED BY THE
    PERSIST CALL'S ENTRY while the replicated identity is a MODULE of
    that closure** — the identity-home persists record the home-env
    ROOT's identity, the failing replication's entry is the
    profile-home MODULE the in-memory index served, and the lookup
    found an empty set. The per-module docs were addressable all along
    (the write functions persist one doc per module; the instrumented
    green read them by module identity). Fixed: the recording covers
    EVERY module identity of the persisted set
    (`recordPersistedClosureSpaces`), and the pin suite gained the
    exact geometry — an importer program whose LIB module's pattern is
    served from the in-memory index and replicated from a dry origin —
    watched red at the entry-keyed head (the lib-id replication's
    production failure line) and green with module keying; the
    original single-module tests were blind to the keying by
    construction (entry == module there), which is recorded so the
    next pin author widens the module graph first. The board at the
    keying-fix head is this attempt's probe; a red at the surface
    there restores the entry with the accumulated map — no further
    iteration on this PR.
    **PROBE 4 (the keying-fix board, run
    [33165960083](https://github.com/commonfabric/labs/actions/runs/33165960083),
    ON shard 7, job 98831529935): RED at the surface — the THIRD
    geometry, and the declared hard stop is honored: THE ENTRY IS
    RESTORED.** Same signature, fallback counter still 0 — and this
    time correctly: the artifact's timeline shows both identity-home
    compiles STILL MID-FLIGHT at the child replication's moment
    (fetch waves 18 s and 5 s earlier; the profile-home fetches before
    them belong to the harness process), so NO persist of the
    profile-home module had completed anywhere server-side and the
    module-keyed map was genuinely empty. The supplier class the fix
    chain has not reached: the IN-FLIGHT COMPILE — a compile's E4
    persist registers in `pendingCacheWriteBacks` only once the
    compile reaches it, so a mid-compile supplier is invisible to
    every await the replication holds. DESIGNED, NOT LANDED (the hard
    stop): on a dry fallback map, await the manager's in-flight
    compilations once (`inProgressCompilations` — their E4 persists
    record into the map before the compile promise resolves),
    re-consult the map, then throw; event-driven, no timers, no
    deadlock (compiles never await replications; the content-hit
    replication call is fire-and-forget). [LANDED by the geometry-3
    close PR — the GEOMETRY-3 CLOSE block below carries the landed
    record.] WHAT THE PR KEEPS: both
    landed fixes are real, pinned defect classes (the sibling race and
    the by-ORDER dry origin with module keying); the pin suite is
    rebound to the RESTORED single-entry registry; the entry's reason
    carries the full three-geometry map with the four probes'
    coordinates so the next seat starts where this one stopped. The
    lift bar is unchanged (the ruled local-plus-CI-probe bar); the
    lift condition is now concretely the third geometry's close. What
    the arc's four probes taught — one before the PR, three on it —
    recorded as method: each board's artifact advanced the map exactly
    one geometry — the probe is not a gate ceremony but the arc's only
    instrument that SEES the CI boot order; and a declared hard stop
    kept the loop honest.
    **GEOMETRY-3 CLOSE (this PR, off #6484's merge `bd9b1c10b`;
    review-sharpened, red-first, LANDED):** on a dry origin AND dry
    fallback map, `PatternManager.#replicateClosures()` snapshots BOTH
    in-flight compile registries — `inProgressCompilations` AND
    `inProgressByIdentityLoads` (a supplier can be a by-identity load's
    recovery compile; NEVER `compileCacheWrites`, the replication's own
    set — awaiting it would await itself), `Promise.allSettled`s the
    snapshot ONCE (a failing compile neither hangs nor rejects the
    replication; post-snapshot registrations are the next consult's
    business), then re-observes a FRESH `pendingCacheWriteBacks`
    snapshot — a settled load's recovery persist is fire-and-forget but
    REGISTERS there synchronously before the load resolves (verified in
    code; replications are never in that set) — and re-runs the
    primary-then-fallbacks read once. Still dry throws the same
    production reason string: the one-shot contract is byte-identical
    on the still-failing path. An EMPTY registry snapshot deliberately
    takes NO retry: every `pendingCacheWriteBacks` member belongs to a
    compile or load (registry-covered) or to a sibling replication
    (ticket-covered at registration), so an empty-registry retry adds
    no designed coverage [AMENDED per review-6502 F1: justification (a)
    is overstated — zero-announce proves "no supplier REGISTERED at
    snapshot time", a STRICT SUPERSET of "not started": a supplier that
    completed entirely inside the read window (F1-ii) or a load that
    resolved leaving its repair persist floating (F1-iii) also snapshots
    empty while a bare re-consult would rescue. Both slivers share the
    3b signature and are closed by the ruled 3b close (the RULING block
    below): F1-ii by the registration-time map check, F1-iii by the
    repair persist's own record waking the park] — and it measurably
    re-rescues the sibling
    race nondeterministically, masking the sibling-await pin: the
    build's unconditional-retry draft turned the sibling-await
    mutation kill GREEN (the F1 masking class, recreated); the
    short-circuit restored the kill (step 1 red 3/3). Acyclic (compiles
    and loads never await replications — the content-hit replication is
    fire-and-forget; the wholesale barrier is scheduler/facade-only).
    The dry-consult path announces itself:
    `closure-replication-await-inflight entry=… from=… to=…
    compilations=N byIdentityLoads=N` (warn) fires exactly when the
    registries are non-empty, BEFORE the await. RED-FIRST + MUTATION
    EVIDENCE: pin step 5 in
    `packages/runner/test/pattern-replication-sibling-race.test.ts`
    latch-gates the supplier compile mid-flight (a harness
    `compileToRecordGraph` gate, released by the replication's own
    announcement — no sleeps anywhere) on a SECOND runtime with an
    empty map and a never-supplied origin, so neither the ticket await
    nor a pre-populated map can rescue (the F1 lesson applied at
    birth); watched RED at pre-fix `bd9b1c10b` with the production
    `closure-replication-failed … source closure unavailable in origin
    space` line and an empty target; with the fix, the suite green
    [count made count-free per review-6502 F2: the suite was 6 steps at
    this PR's final head (the F5-1 coverage step landed after this block
    was written) and has since grown — counts live in the test file, not
    here]. The once-await
    mutation (both awaits removed, warn + re-read kept) reds step 5
    ALONE, 5/5 stable; the four existing kills re-verified at the new
    head (sibling-await neutralized → step 1 red alone 3/3; fallback
    consult emptied → steps 2+3 red, plus step 5 whose rescue path
    consults the map by design; throw→silent-return → step 4 red
    alone). From the #6484 review's F5 list, landed alongside:
    per-candidate try/continue on fallback reads (loud:
    `closure-replication-fallback-read-failed`), the dead
    ticket-undefined await-all branch removed by making the private
    params required (proven dead: exactly two call sites, both thread
    tickets), and the map's session-growth note at the field; the
    dependency-recursion re-read nit is recorded, NOT changed
    (rerouting the recursion's origin is not provably safe — a
    dependency can live in the primary origin but not in the fallback
    space, and the map only holds THIS manager's persists).
    **GEOMETRY 3b — PRE-DECLARED RESIDUE (recorded, NOT built):** a
    supplier compile that has not STARTED by consult time is invisible
    to a once-await — the throw fires and the park recurs. Signature,
    readable in any future red's artifact: the same
    `closure-replication-failed` chain with NO
    `closure-replication-await-inflight` line for that entry (nothing
    in the registries at consult), fallback counter 0, and the closure
    appearing shortly after. A probe red with that signature is 3b —
    classify it as such, never conflate it with 3. The full close is
    event-driven re-supply: on every `recordPersistedClosureSpaces`
    for identity I, re-issue any failed replication registered as
    wanting I (once per persist event — no timers, no polling,
    bounded). That closes ALL supplier-timing geometries at once but
    TOUCHES THE ONE-SHOT CONTRACT ("a failure is logged and retried on
    the next child creation" would become "…and on the next persist
    event") — an OWNER-LEVEL DESIGN FORK, recorded here for the
    owner's ruling; deliberately not built by this seat. [RULED AND
    BUILT 2026-08-28 — the RULING block below carries the ruling, the
    landed mechanism, and the contract sentence now in effect.]
    The pin suite (`tasks/server-execution-on-skips.test.ts`) was bound,
    post-restore, to the SINGLE-entry registry: the patterns list held
    exactly the restored FILE entry (reason pinned to the
    three-geometry map and the probe coordinates), the report carried
    its SKIP line and no SKIP-STEP line, the shard filter dropped exactly
    that file, and the whole-registry loop asserted it was the only entry
    anywhere — so any OTHER entry or a silent lift reddened a pin. [That
    binding was superseded by the GEOMETRY-3 LIFT-ATTEMPT below, and
    PROBE 5's red re-superseded it: the suite was rebound to the
    single-entry registry again, with acyclic alias chains for each
    rename.] [And superseded a THIRD time by the RULED-CLOSE LIFT
    below: the registry is EMPTY, so the suite is now rebound to the
    empty state — every suite's list asserted empty, the report
    carrying no SKIP or SKIP-STEP line, the shard filter dropping
    nothing, and the whole-registry loop asserting NO entry anywhere,
    so any new entry or a silent re-restore reddens a pin (17/17, two
    further alias bridges for the renames).] The
    flip's bar remains a green ON lane AND every list empty (the
    co-resident `#host-send-button` blocker in the
    OBSERVATION below is PAID by #6477, its FIXED paragraph there).
    **GEOMETRY-3 LIFT-ATTEMPT (2026-08-28, the geometry-3 close PR —
    WITHDRAWN by PROBE 5, exactly per this block's own clause):** this
    block rode the lift PR; requirement (2)'s board went RED at the
    probed surface (the PROBE 5 block below carries the reading), so the
    entry is restored and this record converts to a LIFT-ATTEMPT — the
    #6484 precedent, repeated. The local half of the bar WAS met at the
    fix head:
    - **Requirement (1), local:** campaign I, 8 counted runs i01–i08
      (4 quiet / 4 loaded interleaved, fresh store + own 97xx port +
      posture probe per run, ensure defaulting ON, toolshed self-sourced
      at the fix head, binary sha256 `a483b13f70b8…` re-verified into
      every ledger, LLM masked): **8/8 GREEN**, walls 18–19 s,
      `structureLoadStuck` 0, `closure-replication-failed` 0,
      `closure-replication-await-inflight` 0 — the new retry is DORMANT
      locally, exactly the model (the parent's own sidecar compile
      persists first locally; the geometry is CI boot order). The
      standing refusal storm unchanged (40 foreign-write-refused pairs
      per run, the non-discriminator). Evidence on the measuring box:
      `/Users/berni/labs-worktrees/geometry3-evidence/` (per-run
      ledgers, test+toolshed logs, stats, stores; the red-first and
      mutation-ladder logs under `pin/`).
    - **Requirement (2), the direct-CI unskip probe — THIS PR's own
      ON-lane board: RED AT THE PROBED SURFACE (probe 5, run
      33198257149).** Per this block's own clause the lift is WITHDRAWN
      and the entry restored carrying the map plus probe 5's 3b
      classification — the PROBE 5 block below.
    **PROBE 5 (run
    [33198257149](https://github.com/commonfabric/labs/actions/runs/33198257149),
    ON shard 7, job 98941298566, head `683477989`): RED at the surface —
    and the artifact is GEOMETRY 3B ON ITS PRE-DECLARED SIGNATURE, the
    first probe classified by a discriminator this arc built for it in
    advance.** The surface: `lunch-poll-vote.test.ts`, the HOST's
    `#lp-join-button` timeout at the 300000ms bound (step 5m6s; file
    FAILED | 11 passed (40 steps) | 1 failed), body "0 joined" +
    "Unknown profile #AykQuk"; every co-resident green. The server
    chain, from the published toolshed artifact: ONE
    `closure-replication-failed entry=Jlzs0wulc086…
    from=z6Mkte7…(parent) to=z6Mkk3w…(profile) — source closure
    unavailable in origin space` at 18:16:15.616, with **ZERO
    `closure-replication-await-inflight` lines in the whole log** — that
    warn prints whenever EITHER compile registry is non-empty at a dry
    consult (the pattern-manager logger's default level is "info",
    the `Logger` constructor's fallback in `packages/utils/src/logger.ts`
    — warn is admitted; the same logger's ERROR printed in
    this very log), so its absence is real: BOTH registries were EMPTY
    at consult — the supplier compile had NOT STARTED. That is 3b's
    defining property, pre-declared above before the probe ran.
    Fallback counters 0 (`closure-replication-fallback-origin` and
    `-fallback-read-failed` both absent — the module-keyed map was
    correctly dry; no persist had completed anywhere), then the park:
    80 `structure-load-stuck` warns 18:16:50–18:20:50 (40
    `pattern-unloadable` roots, streaks — the OW46 signature), the
    refusal storm present as in every green (the standing
    non-discriminator). The only `profile-home.tsx` fetches BEFORE the
    failure are the harness process's (Deno-UA, 18:15:18.8–18:16:10.8 —
    probe 4 established that discrimination); the artifact carries no
    serving-side compile/persist lines at all in the window, consistent
    with a supplier that had not begun. [Per review-6502 F3, stated
    plainly: the pre-declared signature's "closure appearing shortly
    after" limb was NOT VERIFIABLE FROM THIS ARTIFACT — it carries no
    persist-level lines at all, so that limb went unchecked; the
    classification rests on the zero-announce limb plus the
    no-serving-side-activity window, not on all three limbs.] NOT geometry 3 (probe 4's
    discriminator — compile waves already in flight 5–18 s before the
    failure — is absent here); NOT the close misbehaving (the
    empty-snapshot short-circuit's contract IS the byte-identical
    one-shot throw, which is what fired — the behavior pinned by the
    suite); NOT a co-resident (11/11 green beside it). DISPOSITION: the
    lift is withdrawn, the entry restored with the four-geometry map
    (1: sibling-await; 2: module-keyed fallback origins; 3: the
    once-await over both in-flight compile registries — all three
    CLOSED, red-first, kept; 3b: CONFIRMED LIVE, the residue), the pin
    suite rebound to the single-entry registry with acyclic alias
    chains, the workflow lane comment and plan delta updated. **THE
    OWNER FORK IS NOW THE LIVE DECISION:** the once-await family is
    structurally exhausted — no await can see a supplier that has not
    started — so closing 3b means either the event-driven re-supply
    (on each `recordPersistedClosureSpaces` for identity I, re-issue
    failed replications wanting I — touches the one-shot contract,
    recorded above), or a supply-side redesign (e.g. the serving
    runtime compiles/persists the home-env closure into the parent
    space BEFORE serving profile creation, making the supplier
    deterministic rather than boot-order-dependent). Both are
    owner-court; this seat built neither, per the declared stop.
    **RULING (2026-08-28) — the owner ruled on the 3b fork: "go with
    (1) plus the (2-D) kick"** — option (1), event-driven re-supply,
    composed with the (2-D) sidecar serve-time kick, accepting the
    decision memo's recommendation (fork-3b-analysis) with its two
    design details as LOAD-BEARING parts: the registry keys by the
    WANTED (failing) identity, not the entry (a dependency-recursion
    failure records under the dependency's identity, which is what its
    supplier's persist will name), and failure registration checks the
    fallback map ONCE, re-issuing immediately when a usable record
    already exists (closing review-6502 F1's interleaving (b): a
    supplier that completed inside the read window records before the
    failure registers, and its record event may never recur).
    Supply-side determinism as a PRINCIPLE — option (2-B),
    activation-time awaited supply — is DEFERRED to its own arc: it
    re-rules the lazy-activation model (space-server.ts's RULED
    2026-08-02 block) and is not the 3b close.
    **LANDED by the ruled-close PR:** (1) in pattern-manager.ts — a
    supply-class replication failure (the classify-throw's reasons
    only; store-level throws and persist failures keep today's behavior)
    PARKS under the wanted identity in `parkedFailedReplications`
    (FIFO-capped, loud eviction, replacement on re-park) and
    `recordPersistedClosureSpaces` re-issues matching parks once per
    persist event (fire-and-forget off the E4-awaited chain; records
    into a park's own toSpace are skipped — the fallback read cannot use
    them and the filter keeps a heal from waking itself; records into a
    park's fromSpace DO wake it, deliberately: the observed lunch
    supplier persists into the PARENT space, the child replication's
    origin, and the primary re-read is what heals — pinned by the
    late-carriage pin). A failed re-issue re-parks WITHOUT the
    registration-time check (its read just consulted the map — the spin
    guard) and waits for the next matching record. The one-shot
    contract sentence is now IN EFFECT as pre-drafted above: "A failure
    is logged and retried on the next child creation and on the next
    persist event — never on the caller's commit path." Loudness
    strictly increased: the failure line is byte-identical, plus
    `closure-replication-parked` / `-reissued` (with trigger) /
    `-healed` / `-park-evicted` (all warn). (2-D) in wish.ts — the
    sidecar cache tracks its compile space and, serving a cached
    pattern for a space it did not compile into (cached-run arms under
    the serving posture, and chained demanders inside the memoized
    fetch), fires the same replicate-into-the-demanding-space the
    content-cache hit fires, once per (cache epoch, space): the
    demanding space's supplier is REGISTERED at page-serve time, so the
    child replication's strictly-older-ticket await covers the lunch
    class by registration, with (1) as the structural backstop.
    Red-first pins (all watched red at bare main d569f3722): the
    record-triggered heal, the module-identity wake, the
    registration-time check (mutation-isolated pairwise: wake deleted
    reds the heal pins alone; check neutralized reds its pin alone),
    the dependency-frame park (wanted=dependency, entry=importer — an
    entry-keyed-park mutation reds it alone; its phase 1 also pins that
    a PERSIST failure does not park), the no-storm control (genuine
    absence: one loud failure, one park, nothing else ever), the
    late-carriage admission (executor-cross-space: a parked §2b
    delegation rides the heal into the provisioned space through the
    accept gate's delegated admission — completeness, not freshness —
    asserted on the landed commit row), and the serve/chained kick pins.
    The existing kill matrix re-ran cell-for-cell with no mask; the one
    mask the build itself would have created — the heal re-rescuing the
    K1-mutated sibling race's END STATE (the F1 masking class,
    recreated by design: healing is the product behavior) — was closed
    by rebinding pin step 1's kill signal to ZERO failure lines
    (first-try determinism is the ticket await's contract; recovery is
    the heal's).
    **WHAT STAYS OPEN under the ruled close, recorded honestly:** the
    CROSS-REPLICA / never-records supplier (a wire-arrived closure this
    manager never persists records nothing, so no wake fires) — reduced
    to "heals at the server's first matching persist of the identity",
    which the observed lunch class always eventually has; the
    PRIOR-SESSION third-space closure (durable docs from an earlier
    session are readable but unrecorded — same reduction); and the
    SPIN-GUARD residue — every way a RE-ISSUE can re-park onto supply
    that is already durable, because its re-park deliberately skips the
    registration-time check (the spin guard: the failed attempt's read
    just consulted that very map, so an immediate retry could only spin
    on state it already read) and no later record of the identity ever
    fires. Two constructors reach it, and the record must name both
    (review-6528 F7 — the first was recorded alone and under-described
    its own class): (i) the recursive-(b) sliver — a record landing
    inside the RE-ISSUE's own read window, i.e. two independent
    suppliers of one identity with the second completing inside that
    window and none after; and (ii) a re-issue woken by a REAL,
    STANDING record that then fails on a TRANSIENT store error — no
    new record is needed at all, and the park sleeps on supply already
    durable. Both are vanishingly narrow, loud at every step (a
    failure, a re-issue, and a re-park line each), and strictly smaller
    than the pre-ruling residue — in both, pre-ruling the same child
    was one-shot dead, so a park that sleeps is a strict improvement,
    never a regression. The alternative — re-checking the map on
    re-park — is exactly the immediate-retry spin the guard exists to
    prevent, so the code is right and the RECORD is what was owed.
    One bound worth stating outright (review-6528 F4): record events
    include re-issues' OWN re-records — a re-issue that succeeds past
    the already-stored short-circuit re-verifies and re-RECORDS the
    entry's module set — so two parks whose wanted identities live in
    each other's entries can in principle wake each other in a cycle.
    That cycle is one wake per persist event, paced by real storage
    I/O, loud at every step, sustainable only while every wanted-read
    keeps failing as every entry verify-read keeps succeeding
    (doc-specific persistent read pathology in every candidate space),
    and it heals outright on the first good read.
    Where truly nothing ever records, the loud one-shot behavior stands
    — the correct floor under the wedge-loudly ruling.
    **RULED-CLOSE LIFT (2026-08-28, this PR — the THIRD lift; the
    ON-skip registry is EMPTY across all four suites and B1's
    list-EMPTY precondition is met again):** the entry's lift condition
    — "the owner-ruled 3b close … plus the ruled bar" — is met at this
    head: the ruling is taken (the RULING block above), both mechanisms
    are landed red-first with the full mutation ladder clean, and the
    ruled local-plus-CI-probe bar's two halves are (1) campaign R, 8
    counted runs quiet-and-loaded interleaved at the lift head (fresh
    store + own 97xx port + posture probe per run, ensure defaulting
    ON, toolshed self-sourced and sha-verified per ledger, LLM masked)
    — the per-run ledgers, logs, and stores on the measuring box under
    `/Users/berni/labs-worktrees/ruled-close-evidence/`, with the
    ruled-close accounting per run (every closure-replication-* line
    class counted; failed allowed only when followed by its heal) — and
    (2) THIS PR's own ON-lane board as the DIRECT-CI UNSKIP PROBE
    (PROBE 6 of the arc): ON shard 7 RUNS lunch-poll-vote, and the
    probed surface's verdict decides under the ruled SURFACE reading.
    A red at that surface WITHDRAWS this lift exactly per the arc's
    standing clause — the entry is restored carrying the accumulated
    map plus the new red's classification against the residue table
    (which interleaving? the healed-too-late class? something new?),
    and this block converts to a LIFT-ATTEMPT — the #6484 and #6502
    precedent. The flip PR's list-EMPTY precondition is met; its bar
    remains a green ON lane, not merely the empty registry.
    **[CONFIRMED by PROBE 6 — GREEN at the probed surface; the
    withdrawal clause went UNEXERCISED. This is the arc's first probe
    to come back green at the lunch host-join surface, on the sixth
    board across three PRs. The PROBE 6 block below carries the
    reading.]**
    **PROBE 6 (run
    [33222653635](https://github.com/commonfabric/labs/actions/runs/33222653635),
    head `1a5f3e66e`, THIS PR's own board — read settle-confirmed by
    the arc coordinator): GREEN AT THE PROBED SURFACE.** All ten
    server-execution ON shards succeeded — including ON shard 7 with
    `lunch-poll-vote` RUNNING (the lift is in the branch; the shard
    selector passed the file through, the local verification of which
    is recorded in the lift commit). The park's whole chain — the
    supplier geometries this arc mapped five probes deep — did not
    fire at the surface that produced probes 2, 3, 4, and 5's reds:
    the host's `#lp-join-button` rendered and the file went green
    with the ruled close (event-driven re-supply + the serve-time
    kick) live in the binary. THE LIFT STANDS: the ON-skip registry
    is EMPTY and B1's list-EMPTY precondition is MET. The board's
    sole red, classified and NOT conflated with the probe: Test
    (3/8), `packages/cli/test/view-diffedit.test.ts` — "diffedit:
    abbreviated, compact, and email formats amend hunk edits",
    AssertionError "commit 26953" — a CLI view-layer surface this
    PR's diff cannot reach (the diff touches packages/runner's
    replication path, wish.ts's sidecar cache, tasks/, docs/, and a
    workflow comment; zero packages/cli files), with main green at
    the base `a3eae3e97`; a second observation (shard relaunch on the
    same run id) was in flight when this block landed — its verdict
    belongs to the merge gate's ordinary every-lane-read bar, not to
    the probe, whose ruled reading is the SURFACE. **Read the run
    HEADER with this decomposition, not on its own:** the run's overall
    conclusion is `cancelled`, because the relaunched Test (3/8) was
    still running when this very record's push created the next board
    at 00:23:34 and GitHub's concurrency rule cancelled it (00:23:59),
    taking the jobs gated behind it with it — the relaunch never
    concluded, so the second observation fell to the `bdaabf8ee` board,
    where Test (3/8) is GREEN. The decomposition is clean either way:
    on attempt 1 the only non-success jobs were Test (3/8), the Status
    aggregate, and the four jobs Status gates (skipped); on attempt 2
    all ten `Pattern Integration Tests / server-execution ON (n/10)`
    shards were SUCCESS again. So a future
    forensics pass that reads only the header's `cancelled` is reading
    a push-cancelled relaunch, not a probe verdict — the same honesty
    class as #6502's F3. Per the arc's
    method note: this record lands as a docs-only commit AFTER the
    probe board settled — the probe's coordinates are immutable above;
    the commit's own board is the ordinary merge gate, not a probe.

    **OBSERVATION, not owed by this row and NOT one of the two entries —
    `cfc-group-chat-demo.test.ts` is failing ON at current main, 4/6, and
    is not skip-listed.** The file's ON skip was lifted with OW31's
    trust-attribution build (that row's live lift condition, green 4/4 at
    the time). At `1fc841b6e`, run alone on a fresh store under the full ON
    posture, it reds 4 of 6 at
    `clickCfButton("#host-send-button")`, the aimed button's click
    retargeting to its own cf-button host, which rootcause §2b identifies
    as the inner native button being DISABLED (the served `sendDisabled`
    never flipping). Its named seats S-E (the client binding-write wedge),
    S-F (the barrier that did not see that write as pending) and S-G (the
    missing `waitForDisabled(false)` before a served-enable round trip) are
    all recorded-not-built. Main's own board at `1fc841b6e` was green on
    that shard, so CI sees it less often than this box does; either way it
    is a FLIP blocker in its own right (the flip's bar is a green ON lane,
    not merely an empty skip list) and it is what held the default-app lift
    under the shard reading. Recorded here because the phase-3 probe is
    where it surfaced; whether it earns its own row is the coordinator's
    call. **Under the 2026-08-28 surface ruling it no longer holds that
    lift — it is a separate unlisted defect carrying its own
    accountability, and it is still a flip blocker.**

    **FIXED 2026-08-28 (PR #6477, branch
    `claude/server-exec-v2-groupchat-stall`; red-first, store/probe-proven
    at `23cf68e7d`).** The mechanism MIGRATED from §2b's recorded shape —
    not the OW47 standing echo (no `speculative-basis-refused` anywhere; a
    refill after a 300 s hang landed and enabled the button: one-shot
    loss, not poison; the "recorded-not-built" S-E/S-F/S-G reading above
    was stale — OW47 closed them 2026-08-21, S-G for Bob's click only).
    Two parts, both instrumented-red-proven (4/4 taps): (1) the
    `#host-message-draft` fill's blind write is engine-rejected `stale
    confirmed read` — the
    room-add wave's consequence stamps the argument doc's FIRST `/cfc`
    labelMap and adds `/value/rooms`, structure at/above the blind write's
    shape-read parent, against a pre-wave client basis — a RETRYABLE
    ConflictError (the ruled vocabulary) that NO UI-write path consumed:
    `applyCellWrite` fire-and-forgot `tx.commit()` (never pending, no log,
    no retry; the S-G wait alone hung 300 s ×3). (2) each fill issues TWO
    same-value writes (change-event + commit()); the second succeeds
    VACUOUSLY (zero ops against the first's standing optimistic layer,
    `{ok}` before any verdict), so a token-guarded retry of the first
    declined toward a no-op owner and the revert erased the only copy
    (8/8 red at that intermediate head). Fix: `Runtime.commitUiCellWrite`
    — UI cell writes commit through `editWithRetry`, blind marks +
    structural parent re-threaded per attempt, VALUE-FOLLOWING lanes
    (every attempt writes the lane's newest requested value; refcounted
    entry) closing LWW inversion AND the vacuous owner; a finally-lost
    write is logged+counted (`runtime.ui-cell-write`/`lost`, the OW46-class
    detectability); `applyCellWrite` rewired; the S-G wait added before
    the host's send (mirrors the trusted send's). Pins red-first in
    `runner/test/ui-cell-write-conflict-retry.test.ts` (the engine half
    already pinned by `memory/test/cellset-structural-precondition.test.ts`).
    Lift evidence: baseline 5/6 red running alone → post-fix 8/8 green →
    6/6 green on the probe-stripped shipped binary, the draft durable in
    every store (14/14); runner suite 1309/1310 (the one red re-ran green
    alone — load flake). The file was never skip-listed: NO census change.
    The surface-ruled default-app lift (the LIFT block below) never
    waited on this fix; what it retires is the standing unlisted
    flip-blocker itself. Review round on the PR: cubic P1/codex P1
    (a retried CAS push could erase an intervening append) fixed —
    non-blind writes take ONE attempt, no lane; the processor
    set/push harness re-pinned at the new routing seam; final tally
    18/18 green across three gate rounds. Live-class note for the
    flip: the same race silently ate a real user's keystroke commit
    wherever a wave landed structure mid-typing — the fix is
    product-side, not test-side.

    **LIFT — default-app's reload STEP entry is REMOVED, 2026-08-28, under
    the ruled SURFACE reading of the local-plus-CI-probe bar.** The entry
    (`integration/default-app.test.ts` :: "should persist and reload every
    rapidly created notebook note") and its bound in-file
    `serverExecutionOnStepSkip` guard are both gone from
    `tasks/server-execution-on-skips.ts` and
    `packages/patterns/integration/default-app.test.ts`. No new measurement
    was taken for this lift; the bar was already met by evidence in hand,
    and the only thing that changed is which reading of requirement (2)
    governs. The chain, in full:
    - **Requirement (1), the local campaign bar — MET, 10/10
      quiet-and-loaded.** Phase 3's campaign at main `1fc841b6e` on one
      ON-built binary (sha256 `a93047a461c0c4d8…`, re-verified into every
      run's ledger), fresh store + own 97xx port + ON posture probe per run,
      ensure defaulting ON, toolshed self-sourced on the run port, LLM
      masked, PID-only teardown, `gtimeout 600` never approached, 5 quiet / 5
      loaded interleaved: 13–14 s wall per run against 313–315 s for every
      red the earlier 2026-08-27 campaign recorded, with EVERY fixed-mechanism
      counter zero (`pattern-load-error`, `pattern-swap-setup-error` and
      recursive-schema, `deferred-start-catchup(-failed)`, terminal `Error
      committing deferred`, `session-remount`, load-park deferrals and drops,
      `piece-start-commit-failed`, `sidecar-run-raced`,
      `schema-doc-quarantine`, `structure-load-stuck`, `contribution-dropped`,
      `events.handlerNotRunDeferrals`) and `events.appended` 14 =
      `events.processed` 14 in all ten. Ledger: the PHASE 3 block above; the
      campaign's own report is PR #6469's (merged `23cf68e7d`) record.
    - **Requirement (2), the direct-CI unskip probe — MET at the probed
      SURFACE.** Probe head `95f313835`, CI run
      [33138358110](https://github.com/commonfabric/labs/actions/runs/33138358110),
      ON shard 5, job 98743591519: the registry carried no default-app entry,
      the job ran this exact step, and it **PASSED — `ok (18s)`** — the whole
      `default-app flow test` file green, the shard's published toolshed log
      clean across the file's window (4 `event-view-lag`, nothing else).
    - **The shard's red was CO-RESIDENT, not this surface.**
      `cfc-group-chat-demo.test.ts`'s host send — not skip-listed,
      untouched by the probe diff, and 4/6 RED locally at the same head
      running ALONE with the
      same signature (the OBSERVATION paragraph above). It is a separate
      defect with its own accountability and its own flip-blocking weight.
    - **The ruling.** The coordinator recommended that the probe proves the
      unskipped SURFACE and that co-resident debt carries its own
      accountability; the owner ruled **2026-08-28: "agreed with your
      recommendations, proceed"**. Recorded verbatim, with its date, because
      it is the whole difference between this entry's 2026-08-27
      NO-LIFT disposition and its lift.
    - **The lift's own final proof runs on the lift PR's board**: with the
      entry gone, the ON pattern lanes execute this step on that PR. A red
      there would be new information against the surface evidence and is
      captured and reported rather than rerun-looped.
    The pin suite (`tasks/server-execution-on-skips.test.ts`) is updated to
    bind the lift rather than the entry: the patterns list holds exactly ONE
    entry (lunch-poll-vote's FILE entry), the step's guard lookup resolves to
    `undefined`, and the report carries no `SKIP-STEP` line — so a silent
    re-skip reds, and a re-listing without a restored in-file guard fails the
    registry's own step-entry binding check.
  - **OW46 — the silent forever-park is invisible (seat S-D;
    OW19-adjacent detectability). CLOSED 2026-08-21 (optimize-on-main
    client-durability pass; report:
    `../../history/plans/server-execution-v2/optimize/ow47-client-durability-report.md`).**
    The "unloadable pattern awaiting its source docs" deferral
    (`space-server.ts`'s `structureLoadDeferred` branch) parked with
    no DISTINGUISHING counter and no visible log line — each attempt
    fed the per-attempt aggregate `structureLoadDeferred`, where a
    dead space is indistinguishable from routine one-cycle creation
    races, the only log line is debug-level, and
    `structureLoadFailures` stays 0 — so a whole class of dead
    spaces (OW45's shape) was undetectable from stats. Landed: the
    space server tracks each root's CONSECUTIVE-deferral streak; at
    `STRUCTURE_LOAD_STUCK_AFTER` (8 — an observability knob, not a
    contract) it counts `structureLoadStuck` once per crossing and
    WARNS (`structure-load-stuck`, naming the space, root, and
    reason) there and at each doubling of the streak; the streak
    clears when the root starts or terminalizes (a later re-stuck
    episode counts again, like `structureLoadTerminal`); the THROW
    arm is untouched (already loud per attempt). serving-loop.md §7
    carries the counter. Pinned red-first in
    `executor-space-server.test.ts` (a pattern-unloadable root
    deferring per cycle: stuck stays 0 below the threshold, crosses
    to exactly 1, never re-counts while the streak grows; the OW19
    terminal/re-arm pins unchanged). Residual DISCHARGED with the
    lift (2026-08-21): the home-profile lift landed via the explicit
    warm request (OW45's row), which PREVENTS the parked state in
    that flow — the staged setup activates and derives, so the 6/6
    gate runs had no stuck park to count and the counter correctly
    stayed quiet. The counter's live purpose stands unchanged for
    genuinely dead spaces (OW45's named die-before-flush residual;
    its revisit trigger reads this counter in real ON usage).
    **Family variant, closed same-day (the warm request's adversarial
    review; no crash required)**: an activation FAILURE after the
    host drained buffered warm notices into it — `activate()`
    refusing on a rival process's unexpired lease, or throwing —
    stranded the staged setup underived with no crash anywhere: the
    warm one-shot died with the failed server and nothing re-issued
    it. Fixed red-first (the host re-buffers the consumed warm
    notices on either failure arm; `executor-warm-request.test.ts`'s
    post-drain-failure pin, watched red at the drained root never
    reaching the eventual successor). The re-buffer collects what the
    activation CONSUMED — its argument and the drained buffer — so
    the family's remaining losses are TWO: the PROCESS-crash window
    recorded above, and a mid-activate-arrival SLIVER (no crash
    required): a warm notice arriving AFTER the successor registered
    and BEFORE its `activate()` failed routes through the
    existing-server arm straight into the doomed server's feed — in
    neither re-buffer collection. Recovery caveat, stated: re-buffered
    notices activate nothing by themselves — they recover on the next
    QUALIFYING trigger (a session open, an event, or another warm
    request), which in the strict no-backstop shape may be indefinite;
    the diagnostic read is §7's `warmRequests` against the target
    space's subsequent serving activity (requests issued with no
    derived commits following). Review observation, recorded: a
    tenure's warm-demand key set grows monotonically until park —
    bounded by the provisioning volume aimed at the space per tenure,
    and worth a stats eye (`warmRequests` — a loop-global counter; no
    per-space breakdown exists today) if a provisioning-heavy space
    ever holds a very long tenure.
  - **OW47 — client own-write durability under ON (seats S-E/S-F/S-G;
    rootcause §2b + the cellset-lww reproducer). CLOSED 2026-08-21
    (optimize-on-main client-durability pass; report:
    `../../history/plans/server-execution-v2/optimize/ow47-client-durability-report.md`).**
    A USER's binding write into a serve-owned user-scope doc could be
    silently LOST: group-chat local shape — Bob's `messageDraft`
    `$value` patch never reaches the store in 4/4 runs including a
    300 s probe while his session commits 12 OTHER writes; cellset-lww
    end-to-end — the typed name's transaction refused terminally
    (`speculative-basis-refused`) and DROPPED. **S-E traced (the
    instrumented client build the row asked for): neither §6.1
    candidate.** The write dies at speculation.md §6's export refusal,
    synchronously, before the optimistic apply: a blind UI-input write
    (handleCellSet) emits ONE structural nonRecursive read at the
    cell's parent, and `SpaceReplica.#buildReads()`'s `pushCommitRead`
    named EVERY pending layer of that doc — the client's own process-local
    speculation layers included — so a standing handler echo on the
    doc turned the user's next input into a terminal refusal. The
    echo's standing window is a full served round trip at minimum (the
    arrival gate holds it until every doc it wrote is confirmed — in
    the trace the echo's speculatively-created entity docs sat at
    confirmedSeq 0 for ~130 ms), and UNBOUNDED for a never-served
    instance, so the race is a routine state; the `shell.login` switch
    is NOT a necessary condition (the cellset reproducer has no login).
    The cellset trace: iteration i's `saveProfile` echo (the handler
    writes the trimmed name BACK into the draft cell) stands on the
    draft's doc when iteration i+1's typed-name set builds its
    structural read — refused naming exactly that layer, ops
    `patch /value/profileDraft`. Fix (landed with this row): the
    structural read of a blind write bases on the doc's
    NON-speculative stack (`excludeSpeculativeLayers` in
    `SpaceReplica.#buildReads()`) — the blind write consumes no
    overlay value, the excluded layers never reach the wire as
    commits, basisSeq stays the true confirmed basis, durable
    in-flight layers stay named, and the §6 refusal is untouched for
    value-consuming reads. Which-direction: the fix re-issues NOTHING
    (the same single commit exports with a smaller named-layer set),
    so it cannot double-apply; pinned both ways in
    `speculation-overlay.test.ts` (the new blind-write pin: exports,
    exactly one engine commit, durable value via an overlay-free
    reader, echo untouched; the standing §6 pin: a value-consuming
    authored tx over an echo is still refused terminally). **S-F
    resolved as no separate defect**: every commit()-entered write is
    tracked at the transaction chokepoint
    (`trackPendingCommit`, v2-transaction.ts) and
    `idleWithPendingCommits` sources exactly that set, so exported
    binding writes are barrier-covered; the pre-fix loss was the
    synchronous refusal — such a write never existed as pending, so no
    barrier could have held it. **S-G closed**: group-chat's Bob-send
    click now waits `waitForDisabled(false)` like Alice's. Lift
    evidence: the cellset-lww end-to-end step 5/5 green ON locally
    (true ON topology, lane-shaped toolshed) after 2/6-red pre-fix at
    the same tip; the `integration/cellset-lww.test.ts` step entry is
    REMOVED. The `integration/cfc-group-chat-demo.test.ts` file skip
    was subsequently LIFTED by OW59 (the OW34-family train): its
    remaining CI shape was the per-run CFC trust attribution seam,
    closed there — the OW47 half of its reason had closed here.
    **RE-OPENED AND RE-CLOSED 2026-08-21 (the SECOND
    layer-naming producer — the CFC internal-verifier read; ruling:
    arm (b) of the name-draft triage's §9 fork, owner 2026-08-21).**
    The close above covered the blind write's STRUCTURAL read and its
    report's §5 deliberately left the CFC-read corner "refusing loudly
    rather than widening the exclusion" — the profile-embed residual
    proved the consequence: `storedMetadataFor` (cfc/prepare.ts), the
    verifier's path-[] recursive read of the write-target doc issued
    AFTER `unmarkUiInputBlindWriteTx` by design, entered the commit
    set with no exclusion, so under a standing startEditing seed echo
    the basis named the echo layer and §6 refused the USER's name fill
    terminally — refusing in the WORKER console where nothing
    forwards, while the served `saveName` then amended the STALE SEED
    value (store-proven; the triage measured the loss at one
    knife-edge rate across three arms, 2/10 pre-#6187, 2/10 at its
    head, 1/10 on merged main —
    `../../history/plans/server-execution-v2/optimize/name-draft-loss-triage.md`).
    The ruled fix (this close): the blind-write tx's verifier reads
    base on the doc's NON-speculative stack — the VALUE they consume
    (`ISpaceReplica.getNonSpeculativeDocument`, served by the
    transaction read path) and the basis they contribute
    (`excludeSpeculativeLayers` in `SpaceReplica.#buildReads()`) — so the
    verifier
    verifies exactly the durable policy state the server will enforce
    against, and verify-durable + name-durable travel together. Four
    completions the live gates forced (each caught live — the
    forwarded worker console and a local commit-outcome tap — the triage's harness aid, landed with
    this close): (1) CONTENT-ADDRESSED (`cid:`) reads keep their
    ordinary overlay value — identical to the durable content by
    construction (the replica refuses content that does not hash to
    its id) — while their layers stay basis-excluded; during the
    echo's arrival window the client's durable copy of an echo-staged
    schema doc can lag the server's, and serving the verifier "durably
    absent" there moved the silent loss into CFC prepare's
    `stored schemaHash … missing or unreadable` abort (the first live
    red's signature). (2) Stored `/cfc` metadata can reference a
    schema document NO client view holds — a frame delivers metadata
    without its schemaHash refs (store-proven: the server held the
    `cid:` doc as a head while the client's prepare died on it) — so
    `loadSchemaDocument` falls back to the realm schema registry,
    which holds only hash-verified content and which
    `ensureSchemaDocument` now populates at the stamping site
    (whoever stamped the reference held the content); this also
    un-silences the triage's flagged pre-existing "missing or
    unreadable" worker class wherever the stamper's session is alive.
    (3) The live stamper is the SERVER's own derivation and the ON
    watch frames carry no refs, so no in-process source could resolve
    — `hydrateArrivedCfcSchemaRefs` (storage/v2.ts) pulls the
    referenced `cid:` document as arrived metadata integrates
    (deferred, deduped, failure-retried on a later frame), the
    standing-watch sibling of the explicit-sync path's existing
    `StorageManager.#syncCfcSchemaDocument` hydration; not unit-pinnable in the
    emulated harness (loopback frames already carry refs — a pin
    there is vacuous by construction), so the ON gate below is its
    red-first bench. (4) The verifier read's commit-set entry is
    scoped to what it CONSUMES: `storedMetadataFor` reads AT
    `["cfc"]`, never the document root (the triage's arm (c), the
    path half of the ruled arm (b)) — the root-recursive read made
    the whole doc a value dependency at the reader's confirmed basis,
    which lags exactly while the echo stands, so the covering served
    commit's own value patch killed the fill server-side as
    `stale confirmed read … conflicted with` (the commit-outcome tap's
    signature, store-confirmed: basis = the draft mint's seq, head =
    the served seed's); a concurrent `/cfc` change still conflicts —
    the precondition the ruling kept. *(SUPERSEDED 2026-08-28: a
    runtime-internal verifier read at `["cfc"]` no longer enters the
    commit's conflict set, per CFC spec §18.6.2's read exclusion for
    runtime-internal label-metadata reads and §8.9.4's point-in-time
    derived-label semantics. The read stays journaled, so the
    commit-set shape this entry pins — verifier reads sit AT
    `["cfc"]`, never the doc root — is unchanged.)* Pinned red-first
    in `speculation-overlay.test.ts`, six ways: the CFC-relevant
    blind write over a standing echo EXPORTS (base red:
    `SpeculativeBasisError` naming the echo layer; exactly one engine
    commit — re-issues nothing, cannot double-apply); the echo-staged
    cid: shape EXPORTS (base red: the schemaHash-missing abort); the
    registry-only stored-schemaHash shape EXPORTS (base red: the same
    abort, the second live signature); the exported fill's
    commit-set verifier reads sit AT ["cfc"] (base red: path []); the
    SAME write without the blind mark is STILL REFUSED (the exclusion
    never leaves the `unmarkUiInputBlindWriteTx` family); and the
    verifier-shaped read in a blind tx sees the DURABLE doc while an
    ordinary read in the same tx sees the overlay (verify-durable
    consistency, both directions). Value-consuming reads keep the
    ruled §6 refusal untouched (the standing pin). Lift evidence: the
    profile-embed ON gate at the fix head — TEN fresh-store runs,
    **10/10 GREEN**, 10–16 s each (the loss's reds ran 300 s+; the
    triage's three-arm baseline for this defect was 2/10–2/10–1/10
    red), the name AND bio amends STORE-DURABLE in every run (4
    value-bearing commit rows each, queried post-teardown — never the
    render), posture verified per run (`shellServerExecutionDefine` +
    live `servingLoop`), per-iteration fresh store on :8125,
    self-referential API_URL/MEMORY_URL, loads 4.6–10.9 recorded —
    and the `integration/profile-embed.test.ts` skip entry is
    REMOVED (its two prior blockers fell to RULING 5/OW49 and the §2b
    derivation-carriage close; this was the last). **The #6192
    adversarial review round (LANDABLE-WITH-FIXES) hardened four
    edges:** (i) cid: reads are dropped from the commit CONFLICT SET
    entirely (`SpaceReplica.#buildReads()`) — the resolution fallbacks leave the
    replica's confirmed basis for a registry-/overlay-resolved schema
    doc at 0 while the doc's first install is a real revision row, so
    the exported `confirmed {seq: 0}` died server-side as
    `stale confirmed read: cid:… at seq 0 conflicted with seq N` in
    the delivery-gap window (the review's probe, now a permanent pin —
    the gap pins had left the engine EMPTY at the hash, a satisfiable
    read; layer-indifference extended from layers to seqs, presence
    owned by server-side closure validation); (ii) the hydration
    dedupe RE-ARMS on a pull that completes without delivering (doc
    not yet installed — legal), so a later reference-carrying frame
    re-kicks instead of the window going permanent (the emulated
    loopback attaches installed refs to frames, so the pin for it is
    an end-to-end net and the discriminating bench is the live
    kick-before-install ordering); (iii) a PRESENT-but-empty durable
    envelope serves `{}` at the root and no-metadata under ["cfc"],
    never a deleted doc (the empty-collapse deviation, pinned); (iv)
    hydration pull failures log at the REPLICA layer, the only layer
    the path crosses. Recorded, not fixed: `setupResultSchemaFor`
    (cfc/prepare.ts) still reads its SOURCE doc at path [] for
    `.schema` alone — the surviving over-breadth instance, a named
    follow-up under the same scoped-to-what-it-consumes rule; the
    relevance-probe divergence now has a CONCRETE loss shape
    (overlay-says-irrelevant + durable-says-relevant → the fill
    exports UNPREPARED → silent server-side CFC refusal; confirming
    step: seal an echo omitting /cfc over a durably-relevant doc,
    blind-fill, watch the commit outcome) — still the separate ruling
    flagged at the close; and the echo-CREATED-target sub-case (the
    blind fill's leaf path missing at apply because only the echo
    created the doc) is pre-existing and outside the ruled scope.
  - **OW48 — CLOSED 2026-08-21 (refuted premise; optimize-on-main
    served-wish seat,
    [`optimize/ow48-50-wish-path-report.md`](../../history/plans/server-execution-v2/optimize/ow48-50-wish-path-report.md)
    §1).** The row's premise — #6098's reserved-result-keys rule
    breaks the ON serving compile of byte-identical system patterns —
    was environment contamination, not a defect: the failing compiles'
    content-derived program ids match the PRE-#6019 sources exactly,
    and those bytes came from a STALE toolshed on localhost:8000 (the
    `env.API_URL` default) that the investigation's serving runtimes
    fetched system patterns from — a pre-#6019 vendor pin still
    live-serving `[UI]: unknown` at the result root, the exact defect
    #6098 exists to reject. Main's current system patterns compile
    green under every posture including `servingPosture` (posture
    matrix in the report); the transformer stack reads neither
    server-execution flag. No pattern-typing change and no
    serving-compile relaxation is owed. Residuals flagged in the
    report §1c: the serving runtimes' pattern-fetch trust surface
    (API_URL decides whose bytes the server compiles), and the
    historical-stored-sources × new-transformer-rules exposure.
  - **OW49 — the ifc-divergent-anyOf envelope at /result under ON
    (seat S-I; RULED 2026-08-21 — CFC owner ("sg", relayed by the
    coordinator; the owner confirmed CFC ownership): the narrowing is
    APPROVED per the seat recommendation WITH the adversarial
    reviewer's cautions as binding constraints — narrow
    `assertNoDivergentIfcBranches` to actual ambiguity, admitting at
    most ONE ifc-carrying branch when every ifc-free sibling is
    type-disjoint from it (conservative disjointness — explicit scalar
    `type` keywords decided over VALUE-sets, not type strings: the one
    subtype pair integer ⊂ number is NOT disjoint, review F1; no other
    semantic subtyping), scoped to anyOf/oneOf (allOf stays refused —
    unsatisfiable-by-construction under the rule), the merge treating
    the ifc branch as the policy carrier, holding at all four
    mergeCfcSchemaEnvelopes call sites, and still recursing INTO the
    admitted carrier. Built red-first on the seat's deterministic
    repro (the two-writer journey flipped from crash-surfaced to
    clean-merge; the genuinely-ambiguous class pinned refused);
    envelope DECODED 2026-08-21,
    [`optimize/ow48-50-wish-path-report.md`](../../history/plans/server-execution-v2/optimize/ow48-50-wish-path-report.md)
    §2).** Main's `assertNoDivergentIfcBranches` (cfc/schema-merge.ts,
    #3263) fires inside the `raw:wish` action's commit-prep only under
    ON. The envelope question is answered: the /result branches are
    the WISH BUILTIN'S OWN presence union —
    `anyOf[{type:"undefined"}, <requested schema asCell>]`
    (`wishStateSchemaForResult`) — with ifc riding the requested
    profile consumer view; NOT a served-vs-local vintage divergence
    and NOT instance-keyed (both writers intern the identical `cid:`
    schema doc, so "normalize the served envelope before merge" is
    refuted — there is nothing served-side to normalize, and open PR
    #6083's content-addressing neither causes nor fixes it). The
    ON-only trigger is two-writer sequencing: the serving loop
    persists the envelope first; the browser's raw:wish, writing a
    changed /result link against it, dies at the un-caught
    verification merge — whoever writes second dies, and under ON
    there is always a second writer. The stored envelope is a POISON
    PILL: every later merging writer (including the runtime's own
    error report) is refused via the merge's entry assert on the
    STORED side. Deterministic unit repro:
    `packages/runner/test/cfc-prepare-crash-surfacing.test.ts`.
    Owed (the CFC owner decides; recommendation in the report §2e):
    preferred — narrow the assert to actual ambiguity (allow a
    combinator when at most one branch carries ifc and the ifc-free
    branches are type-disjoint from it; merge treats the ifc branch
    as the policy carrier); alternative — remove the combinator from
    the wish's own result declaration (narrower; other ifc-under-union
    families re-trip). BUILT 2026-08-21 per the ruling
    (`cfc/schema-merge.ts`; red-first both directions —
    `cfc-schema-merge.test.ts` + `cfc-prepare-crash-surfacing.test.ts`
    carry the admitted-shape, constraint, and genuine-ambiguity pins;
    optimize/ruling5-ow49-report.md). LIVE-VERIFIED extinct: 10
    fresh-store ON runs at the ruling head show ZERO divergence
    asserts — the wish UI mounts and the profile resolves every run.
    The row is NOT closed: the ruled closure condition (profile-embed
    greens ON) did not land — the lift attempt surfaced the NEXT
    blocker (the resolved-profile amend steps intermittently red 6/10
    with the amended values durably absent from every store; the
    OW45+OW31-family cross-space derivation signatures in every run —
    triage in optimize/ruling5-ow49-report.md §3). That
    amend-convergence blocker was ROOT-CAUSED AND CLOSED 2026-08-21
    by the §2b derivation-carriage scoping pass
    (optimize/2b-derivation-carriage-scope.md): ONE send-site defect —
    cell.ts's serving branch picked the LT1-vs-outbox arm by the
    sending CELL's space instead of the WAVE's home space, so the
    served amend handlers' sends into the profile's exported streams
    (direct foreign cell handles) raw-wrote the foreign space and
    died on the one-tx-one-space isolation error — fixed red-first
    (executor-cross-space.test.ts's outbox-arm pin); the amends now
    cross via the outbox with the carried actor and are durably
    present in both stores. The ten-run gate at that fix head
    separated a REMAINING, different-family red — the client
    name-draft own-write loss, OW47's family — which the verifier-read
    basis close (OW47's re-close above, RULED 2026-08-21) has since
    CLOSED: profile-embed greens ON at that fix head and its skip
    entry is removed, so the ruled closure condition (profile-embed
    greens ON) is now MET. Declaring this row closed on that evidence
    remains the coordinator's call, per the row's own provision.
  - **OW50 — CLOSED 2026-08-21 (built; optimize-on-main served-wish
    seat,
    [`optimize/ow48-50-wish-path-report.md`](../../history/plans/server-execution-v2/optimize/ow48-50-wish-path-report.md)
    §3; red-first tests in
    `packages/runner/test/cfc-prepare-crash-surfacing.test.ts`).**
    Wish-action commit-prep failures now surface where the wish UI
    belongs, in three layers, none touching cfc/ semantics: (1) a
    crash escaping `prepareBoundaryCommit` becomes a MODELED refusal
    (`prepareCfc` records it as an invalidation reason; commit()
    rejects with the real cause; callbacks fire; observe mode
    survives); (2) the scheduler survives any `prepareTxForCommit`
    throw (the tx is aborted with the cause instead of the
    double-finalize wedge + unhandled rejection + never-settling tx);
    (3) the wish writes `{error, [UI]}` into its state doc on a
    settled non-transient commit failure — raw value writes (a cell
    write's candidate re-meets the OW49 poison envelope), transient
    conflict classes excluded (the scheduler converges those),
    surfacing serialized per doc, and the old error-report path's
    "would meet whatever refused it the first time" single-shot
    corrected with bounded retries for the transient classes. The
    formerly silent never-mount now shows the refusal's text in the
    wish surface. The throw-to-rejected-commit contract change (the
    three re-pinned `cfc-policy-of-label` PolicyOf pins) is RATIFIED
    by the CFC owner 2026-08-21 ("sg", relayed by the coordinator,
    with the motivation question answered on the record: the change
    was forward-motivated by the silent-never-mount and the scheduler
    wedge, no pre-existing test was left broken — the three pins were
    green before and after, consciously migrated with the same
    diagnostics delivered through the rejection message). Still open (flagged in the report §6): whether
    modeled CFC refusals should be terminal-classified for the retry
    budget, and whether the browser should run raw:wish at all under
    ON given the served result is already durable.
  - **OW51 — the default-app `splitDefinitions` undefined-read (the
    ON read-semantics seam): CLOSED (2026-08-21, second ruling —
    option 3 built; the §8.5b surfaced residual root-caused and
    closed same day, §8.5c).** The residual's consumer was NAMED
    under the coordinator's find-first directive: `schema-examples`'
    two baseless-`parseLink` deep-equals — the §3 assertion-churn
    class the churn commit missed in that one file; the visible
    crash cascade was afterEach-teardown fallout over the test's
    unawaited seed commit. No product-code consumer of the carrier
    exists; the §3 observability audit stands; §7's flake exclusion
    stays corrected as a mis-verification. Fixed by the same churn
    convention (`8777de478`), red watched via the named assertion
    diff. The refusal-scope fork the first build surfaced
    (build report §6–§7) was RULED by the owner (option 3: the
    refusal's re-trigger is independent of the root-level arrival
    re-arm — verbatim: "client-side doesn't react to its own writes,
    server should do, but i'm not sure this is about that. what does
    self-demanded mean? either way, option 3 sounds good") and closed
    in two parts. (i) The memo-variant fix (§7) closed the alias class,
    pinned both directions (`link-resolution-memo.test.ts`). (ii) The
    §8 build closed the demand-closure class: verification showed the
    re-fire contract ALREADY held (a disposed run's committed log
    joins the union subscription; any writer's arrival cause-dirties
    and re-runs it; root-level re-arms keep clean instances and so
    can never deliver it) — the deadlock was the refusal MIS-FIRING
    on a SCOPED instance row's absence, which is knowledge (the
    scoped first-write idiom the fan-out run supply materializes
    instances over), not transit. `pendingHopDoc` now marks only a
    missing SPACE-scoped doc (`link-resolution.ts`); the relayed read
    of an absent user/session row reads `undefined` exactly as the
    flat form does. NAMED RESIDUAL WINDOW (the #6179 review,
    MINOR-3): a scoped row ALREADY WRITTEN elsewhere — another
    device, or a cold/lagging serving replica — is transit, not
    knowledge, and the carve-out returns such mid-arrival reads to
    main's interim-undefined-then-heal (fragile-body crash included);
    outside the refusal's protection, matching main. No shipped
    pattern routes link chains through user-scoped docs (the review's
    population audit is the evidence). Red-first: `executor-dprime-w0`
    "P-arrival-closure" watched red ×3 at the rebased head (22 s
    timeout), green after (9/9 ×3). The ruled re-fire contract
    carries its own pin — "OW51 refusal re-trigger": a
    refusal-disposed served run re-fires on a FOREIGN writer's
    arrival through its registered dead-end read alone —
    mutation-verified load-bearing (clean-bit kill times out; stated
    honestly, it guards a contract the code already delivered rather
    than witnessing a fix). Two adjacent latent findings FLAGGED, not
    filled (report §8.5): capture type-shrinking strips `Default<>`
    from directly-captured argument schemas, and a relayed PerUser
    read's scope resolution is era-dependent. Evidence:
    docs/history/plans/server-execution-v2/optimize/
    ow51-build-report.md §8. The mechanism, the first ruling, and the
    lift:
    The undefined read was
    a scheduler lift whose input LINK CHAIN dead-ended at a doc the
    replica could not serve yet (a note's `pendingEdit` reached
    through the piece's result/process doc during a freshly
    SERVED-instantiated note's materialization); the read handed
    `undefined` into a body whose schema promised a value, crashing
    `splitDefinitions` on BOTH the client and the toolshed's serving
    runtime (shared read path — the "arrival ordering" root cause of
    the triage report). The owner ruled the fix fork, option (a),
    verbatim:

    > (a), server-side should match the current client behavior
    > exactly. also note that with the lazy proxy based evaluation a
    > lift can throw a specific error and mark a tx aborted with that
    > reason and that should also be handled just like an unresolved
    > input, i.e. being retriggered when any of the reads so far
    > change (just like a regular call), and the output being
    > `undefined`.

    — owner (Berni), 2026-08-21. Built: link resolution marks a
    data-derived dead-end behind a hop (`pendingHopDoc` /
    `viaLinkHop`); the LAZY read path (action bodies; eager reads
    unchanged) refuses with `UnresolvedInputError` (a
    `SchemaMismatchError` subclass, so the action-run boundary's
    existing "argument did not resolve" disposal treats it identically
    — output `undefined`, no action failure, re-triggered when any
    registered read changes), UNLESS the reader's schema declares a
    default (the stated absent value still flows — the
    `get() ?? fallback` idiom and a not-yet-produced computed are
    unchanged). A dead-end at the handle's OWN root doc is likewise
    not this shape. The (ii) lift-throw clause holds by inheritance:
    the refusal propagating out of the body takes the same disposal; a
    pattern body MINTING the error is the FLAGGED
    pattern-facing-export question, still with the owner. Server
    matches client by construction (`servingPosture` gates nothing on
    this path). Pinned:
    `packages/runner/test/unresolved-input-lift.test.ts` (the
    hop-target dead-end disposes and re-triggers on arrival; the
    stated-null control still flows), the full schema-view suite
    green; serving-runtime match witnessed by
    `integration/default-app.test.ts` ON 10/10 with ZERO
    `splitDefinitions` occurrences (the pre-fix crash surface). Spec:
    speculation.md §2's RULED unresolved-lift-input paragraph.
    Evidence: docs/history/plans/server-execution-v2/optimize/
    ow51-build-report.md (and ow51-undefined-read-report.md for the
    triage). NAMED RESIDUAL (owed pin, not a reopening): the
    optional-property refusal swallow (`createObjectView`) correctly
    disposes an unresolved OPTIONAL read as eager-parity `undefined`
    with the retrigger preserved (the swallow clears the note; the
    read registration survives) — verified by mechanism, a dedicated
    pin owed (build-report §3, caution 4). LIFT: default-app's
    FILE-level ON skip is LIFTED — its "should create a note" step
    (the OW51 surface) runs ON; the "persist and reload" step stays a
    STEP skip under **OW45** (the reload-durability flake the OW51
    crash had been masking — a reloaded notebook's `noteCount` reads
    `undefined` past the step's wait, 1/10 local ON; the OW51 fix's
    clean-undefined-plus-retrigger surfaces it, OW45's territory to
    close with an event-driven wait).
  - **OW52 — the convergence-storm ON loss (landed 23/40): CLOSED
    (2026-08-21, the optimize-phase loss triage) — NOT a loss.** The
    full 40-event accounting (serving-loop counters + the space's
    sqlite commit log) cleared every candidate seam: append admission
    40/40 (`events.appended`), drain/dispatch 40/40
    (`events.processed`, `skippedIdempotent` 0, purge/orphan counters
    0), consequences EXACTLY-ONCE (all 40 eventIds across 10 derived
    commits, zero duplicates — the (α) invariant held at storm depth),
    all 40 array appends durable, and the observer CONVERGES to 40/40
    (~2–3 s of serving drain; 16 waves, 9 deadline-cut — the honest
    flush deadline's routine shape, serving-loop.md §3). Per-wave
    coalescing (`coalescedPerWaveMax` 11) collapses wave boundaries
    only, never handler runs — no coalescing-by-design ambiguity. The
    red was the HARNESS: the served-topology `settle()` had no
    server-drain step (the OFF arm's `server.idle()`), so a fixed
    round count of idle/barrier hops raced the drain and the assert
    read a mid-drain head. Fixed in the harness (test infrastructure,
    no product semantics): `MultiRuntimeHarness.settle`'s
    toolshed-backed arm waits, bounded, for each session's
    outstanding-intent set to empty — speculation.md §4 step 2's
    arrived-terminal-consequence retirement,
    `Runtime.speculationOverlay.pendingIntentCount` — before the
    barrier, restoring the arms' settle agreement for FIRST-ORDER
    consequences (server-side cascade children are no session's
    intent and ride the barrier rounds — the storm has none; budget
    exhaustion warns loudly so a slow-box mid-drain red
    self-identifies instead of re-opening this row). Step green ON
    5/5 + file 4/4 ON and OFF; the step entry LIFTED. Evidence:
    docs/history/plans/server-execution-v2/optimize/
    ow52-storm-loss-report.md. Recorded, not decided (adjacent):
    whether the PRODUCT's idle vocabulary should carry an
    intent-quiescence barrier under ON (OFF's idle implies own-send
    consequence visibility; ON's does not) — a spec question beside
    OW47's pending-commit-barrier seat, surfaced in the report.
    ADDENDUM (2026-08-22, arrival-wait-hardening pass): the report's
    §7 claim that this fix also covered the census's group-chat
    waitFor flakes (items 1+3) is CORRECTED — those recurred
    post-merge with quiescence clean (runs 32543810077 /
    32547606642) and were a different race entirely: the test's
    chained draft→trusted-send events, on different streams with
    cross-stream serve order unpromised (events.md §2), let the
    served handler no-op SILENTLY on a pre-draft view, so the
    awaited write never existed — terminal before any wait began.
    Root-caused, made deterministic (delay injection at the seam),
    and closed — helper gates on the arrived-consequence signal
    (`SpeculationOverlayDestination.waitForIntentQuiescence` /
    `MultiRuntimeSession.awaitEventConsequences`, pinned both with
    killing mutations), plus the staged-publish / spec-gallery
    settled-text conversions (the ledger's browser members) — in
    `optimize/arrival-wait-hardening-report.md`. This row's own
    closure (the storm-loss triage and the settle fix) STANDS.
  - **OW53 — the sqlite multi-runtime identity pair under ON: CLOSED
    (2026-08-22, the OW53 triage+build — determination: BOTH halves
    IMPLEMENTATION, no model fork).** The row was minted UNTRIAGED
    whether the fix is model or implementation; the rulings that
    landed after the mint COMPLETED the model — builtins.md §2 (RULED
    2026-08-02: the reader principal is part of the memo key, one
    cleared result cell per (query, reader), "cleared where the read
    is served"), serving-loop.md §3c (the run's identity, "never the
    serving runtime's ambient identity"), serving-loop.md §4 (the
    effect carries the run's identity carriage; the completion's
    annotations source from it), protocol.md §1 ("identity arrives
    WITH the work ... carried into keys, not resolved from ambient
    state"), and 06-cfc.md's dbOwner definition ("the principal that
    created the SqliteDb cell") — and what remained was code lagging
    them. Traced at main `51350077e` (true-ON topology, fresh
    stores): the failure shapes had MOVED off this row's minted text.
    Db-owner half: the committed owner was the SERVICE DID (the
    toolshed identity) — not a bob re-mint — because the serving-side
    creating run carried alice (`scopeKeyIdentity.principal`,
    `attributionFromScope`) and the OW34 per-run tx snapshot was
    CORRECT (alice), while the mint read
    `runtime.trustSnapshotProvider()` — the runtime-ambient service
    (exactly the direct provider read OW34's Q5 deliberately left
    here). Read-clearance half: the cleared queries never completed —
    each reader's claim `{pending, requestHash}` landed per-user (the
    stamped runs), but the flush's UNSTAMPED writeback resolved the
    SERVICE's user-partition, found no claim, and no-opped forever
    (the stage-A OW17 residual flagged in space-server.ts
    `#commitEffectCompletion`); and both readers' cleared hashes were
    IDENTICAL (clearanceReader = the ambient provider = service), so
    the two instances' effects also collided on one outbox key. Four
    defects, ONE family — ambient identity consumed where the ruled
    model requires run-carried identity: the owner mint, the
    cleared-hash keying, the flush-time reader/ceiling reads, and the
    completion writeback's partition. Fix (sqlite-builtins.ts):
    `sqliteRunActingPrincipal` — a stamped run's carried actor
    (`acting.user ?? scopeKeyIdentity.principal`), else the ambient
    provider (client/OFF byte-identical) — consumed at the mint and
    the hash; the flush captures the requesting run's reader and
    `scopeKeyIdentity` and every writeback transaction sets the OW17
    identity seam (`tx.tx.scopeKeyIdentity`) so its guard reads and
    writes resolve the REQUESTING instance; reader-keyed hashes also
    split the effect keys, dissolving the cross-reader outbox
    collision. Fail-closed arm (RULED 2026-08-22 — ratified as
    built; the owner, Berni: "agreed with all the recommendations
    above, continue" — one ruling over the presented batch: this
    arm, and the session-identity join below): a served creating
    run with NO carried actor mints NO owner — ownerless handle,
    dbOwner() fails closed (the OW31 genesis-arm /
    `homeSpacePrincipalFor` posture, "never the service DID") — and
    the Q3 keep-service reading, which would have minted the
    SERVICE and thereby granted it dbOwner() row admission, is
    REJECTED. Spec (docs-move-together): 06-cfc.md's dbOwner row +
    Phase 3.b acting-reader sentence.
    Red-first: `packages/runner/test/sqlite-served-identity.test.ts`
    — the mint pin WATCHED RED at base (a stamped alice run minted
    the ambient service DID), the actor-less fail-closed pin RED
    (service), the unstamped-neutrality guard green both sides, the
    cleared-hash pin RED (both stamped readers staged ONE
    service-keyed hash) — plus both integration files re-reproduced
    RED at main under the true ON topology before the fix (db-owner:
    owner = the service DID in both views; read-clearance: settle
    timeout + equal cleared hashes + bare-claim docs). Lift evidence:
    the true-ON gate (fresh store per run, posture verified —
    serving-loop waves/derivedCommits live, `serverExecution=true` in
    every worker — loads 5.9–9.0 recorded per round):
    `sqlite-db-owner-multi-runtime` 5/5 and
    `sqlite-read-clearance-multi-runtime` 5/5 (all 3 steps as then
    present; PR #6196 adds a fourth two-tabs step — the session-fork
    close below — run 4/4 under the same gate topology); BOTH ON
    skips LIFTED (this row's minted trigger). Residuals, recorded
    not closed: llm-dialog's direct provider read
    (the `trustSnapshotProvider()` read in `executeToolCalls`,
    `llm-dialog.ts` — same family, named untouched by OW34 §7
    and by this close; no ON surface pins it yet); NOTE-6 below
    (delegated read sessions' demand under the process DID —
    label-inert, unchanged); shared provider/tool reads and dialog management
    tools remain separate obligations. Shared fetch, `fetchProgram`, `llm`,
    direct `generate*`, and dialog turn-completion paths bind their guard reads
    to the issuing identity. These controls do not cover every tool operation.
    Dialog management tools still use bare lifecycle completion keys for
    pin/unpin, and their asynchronous reads require separate actor-partition
    evidence. The acting≠demanded split: every context the stamper
    produces derives `acting` FROM the demanded pair where both
    exist, so a run whose two halves disagree is an identity-model
    question no ruling has decided — `sqliteRunActingPrincipal`
    tripwires on it (fails loud, citing this row) rather than
    picking whose rows a cleared read admits. The non-clearance user/session
    result-key and lifecycle gap is covered by the raw and ExecutorHost
    controls in OW28-instance-family.
    They use a space database and reader-independent query hashes.
    Cleared-query hashing and acting/owner selection follow the OW53 rules
    above. The remaining distinct surface is the
    provider READ RPC's partition resolution (recorded 2026-08-22
    by the session-identity build, flagged not filled): a
    sub-space-scoped db's ON-DISK partition resolves from the
    TRANSPORT session — memory/v2/server.ts `sqliteQuery`'s
    `resolveScopeKey(db.scope, {principal: session.principal,
    sessionId: message.sessionId})`, the service's own session on a
    serving runtime — same ambient-identity family, distinct
    surface (which FILE gets read, not which cell or key is
    written), outside the 2026-08-22 request-identity ruling, and
    no live surface reaches it (the clearance fixture's db is
    space-scoped, whose resolution is identity-free) — and it
    BLOCKS the session split's live completion coverage: until the
    partition resolves from the requesting identity, a
    session-scoped cleared query cannot be driven to completion
    end-to-end, which is why the session-fork close binds staged
    hashes at unit level and user-granularity sharing in
    integration, never a session-scoped completion. The
    SESSION-scoped cleared-result collision variant (the #6194
    review's find) is CLOSED — RULED 2026-08-22 (the same ruling as
    the fail-closed arm above) and built in the session-identity
    train (PR #6196): `narrowestScope` legitimately resolves a cleared
    result to SESSION scope when the db itself is session-scoped,
    and pre-build `clearanceReader` and the effect key carried the
    USER principal only — two sessions of one user on one serving
    runtime shared hash + effect key across DISTINCT session
    instances, and the second rode the in-flight dedupe (starvation
    until a re-run; ON-only; off-model against builtins.md §2's one
    cell per (query, reader)). NOT clamped to exactly `user`: a
    session-scoped db's cleared result MUST stay session-scoped (a
    user clamp would memo-collide two session dbs' results in one
    cell); instead the SESSION JOINS the request identity for
    session-scoped cleared results — one cleared cell per
    query-and-reader-at-matching-granularity. The build
    (sqlite-builtins.ts): the hash's `clearanceReader` component
    carries `{user, session}` when the cleared result's scope is
    `session`, sourced from the run's `scopeKeyIdentity` — the same
    identity the flush's writebacks resolve instances against, so
    request identity and cell instance split together — and the
    effect/outbox key splits through the hash; user-scoped cleared
    results and the whole unstamped arm (clients, ON-arm
    speculation, OFF) are byte-identical. Pinned red-first in
    sqlite-served-identity (two sessions of one user against a
    session-scoped cleared db: ONE identical hash watched red at
    base, distinct after; the user-scoped session-blind guard green
    both sides; a determinism pin re-stages the same session from a
    fresh builtin instance and expects the SAME hash — the split is
    identity-derived, not per-run noise; mutant-watched: a salted
    session arm reddened ONLY this pin, the other 7 steps green),
    and GUARDED
    both-sides-green by the read-clearance integration file's
    two-tabs-of-one-user step (one Identity in two harness
    sessions: user-granularity sharing — same cell, same hash —
    green OFF and under the true-ON gate, serving loop live).
  - **OW54 — bounded terminal cover for proven delivery failure: IMPLEMENTED;
    OQ-23 TRANSIENT FINALIZATION AND VALIDATION FOLLOW-UPS OPEN
    (2026-08-27).** A failed served-event head records a
    durable typed delivery checkpoint and accumulates only confirmed
    failed-state time. Arrival-barrier followers, dirty-input
    settlement, and the served `RetryImmediately` name-resolution path
    spend no budget. Positive recovery persists a recovering state and
    wakes one retry, including after storage-manager recreation because the
    failed boundary is keyed by document instance; flapping never erases spent
    time. An unchanged
    active failure reaches the explicitly ratified 60-second policy
    boundary, while a current-ACL or `RowLabelCommitError`
    proven-no-commit verdict terminalizes immediately. Typed
    commit-preparation crashes use the same cover; exact
    `CfcCommitRefusalError` verdicts and explicit handler aborts remain
    error consequences. Ambiguous storage-time or transport outcomes
    remain outside explicit replay. No current transient pre-seal transport
    producer supplies positive no-commit evidence, so that OQ-23 arm remains
    pending on the ordinary re-drain cadence and this row does not claim the
    every-entry-terminal invariant for it. It joins this checkpoint policy when
    its producer can distinguish a pre-storage refusal from an ambiguous
    outcome without inspecting diagnostic text.

    Terminal cover is one entry-local `{status: "needs-attention",
    consequenced: true}` notice plus the per-space unresolved-attention
    discovery index, keyed by prototype-safe encodings of stream sidecar and
    immutable `(eventId, seq)` identity and protected
    from authored writes. The entry stays authoritative and uncompactable
    until resolution. The arrival barrier opens only after the notice's
    wave confirms the whole terminal contribution committed; failed
    checkpoint or notice writes fail closed and are counted. Retry and Dismiss
    resolve the original, remove the unresolved index item, and record a durable
    resolution tombstone in one same-space CAS. Retry appends at most one fresh
    ID with `retryOf`,
    exact server-copied payload and admission provenance, and the
    original user's current session; concurrent and replayed requests return the
    recorded winner after source-entry compaction as well. The runtime-client and
    persistent shell
    surface carry the complete safe attention object for the active space,
    and reconnect discovery reads the unresolved index back through the
    authoritative entry. Health reads recompute active failed-state duration
    from the checkpoint timestamps rather than freezing it at the last state
    transition.

    Pins cover cumulative flapping and clock skew, typed successful recovery,
    failed-head versus barrier-follower routing, immediate permanent
    evidence, checkpoint and notice commit accounting, terminal
    ordering, CFC versus preparation-crash classification,
    `RowLabelCommitError` operation-owner attribution through an actual
    refused-wave outcome, current-ACL routing, ambiguous-outcome
    exclusion, exact-provenance Retry, Retry/Dismiss and lost-response races,
    lost-response replay after source compaction, equal event IDs within and
    across streams, cross-user/sessionless rejection, unresolved retention,
    userless Dismiss without replay authority, in-flight retry ownership at the
    budget boundary, runtime-client forwarding,
    mutation-aware shell refresh ownership, dark-theme and live-region
    presentation, and the end-to-end transient and persistent load paths.
    Direct pins for cold-view T3 observations interleaved with load-park
    failures, absence of a retry cadence between the single budget-boundary
    wake and valid storage wakes, foreign-space preflight recompute spending no
    failure budget, and a served current-ACL denial produced by the live memory
    authorization path remain validation follow-ups. The structural paths keep
    cold-view counts separate, schedule only the budget-boundary timer, and
    create checkpoints only from served head-failure outcomes; these statements
    do not substitute for those integration pins.
    OQ-19's foreign-derived
    freshness mechanism remains its separate currentness design and is
    not part of this closure.
  - **OW55 — OPEN: the serving runtimes' pattern-fetch trust surface.**
    `packages/toolshed/index.ts` passes `new URL(env.API_URL)` into
    `startServerExecutionHost`, which supplies the serving runtime's API URL.
    The default is `http://localhost:8000`. Wish sidecars and space-root
    creation resolve system program sources through this URL. Existing wish
    sidecars also reconcile their origins when `openSidecarSurface` explicitly
    opens them on the serving runtime. Tenure activation does not follow the
    root's source or run a general source updater. Owed: a deliberate posture
    that pins the serving source to self
    when co-hosted, or verifies its identity against the local patterns route,
    plus a local-reproduction runbook note requiring explicit API_URL and
    MEMORY_URL when the default port is occupied. Root creation is within
    this obligation. A configured URL alone does not establish local source
    identity. The coverage audit does not claim a new cross-origin experiment.
    Trigger: the serving pattern-source trust pass; close when the chosen
    posture and its regression coverage land.
  - **OW56 — PARTIALLY CLOSED — server-owned program materialization
    and compilation.** Under ON, the upload and instantiate lifecycle
    verbs compile and materialize on the serving runtime. `cf piece new`
    requests this path. The request settles after the verb's wave commits
    and durable confirmation succeeds; the receipt does not promise that
    the piece's first derivation has completed. The contract is
    [server-pattern-lifecycle.md](../../features/server-pattern-lifecycle.md).
    `executor-lifecycle-verbs.test.ts` covers the host's queue and durable
    settlement; `packages/piece/test/served-lifecycle.test.ts` covers the
    operations through a real memory server and serving host.

    Source update/check and browser/background creation still use their
    client paths. Serving source updates requires registering module-update
    authority at wave settlement; migrating each remaining client is
    separate work. Clients also resolve local program files and may run
    the opened graph speculatively. The served creation path therefore
    does not discharge Finding 1's compiled-byte trust obligation or
    OW45's die-before-flush residual for the remaining client-written
    program paths. These boundaries remain open alongside OW44's lazy
    client-instantiation work.

    The write-topology explorer's two findings extend this row (explorer
    map 2026-08-21, verified against main), ruled FOLLOW-UP not
    flip-gating — owner: *"we're not in prod yet, so we can fix this as
    follow-up."* — owner (Berni), 2026-08-21; both close with OW56, or
    before it at the owner's discretion:

    - **Finding 1 — cached transpiled code is client-writable,
      server-executed-unverified.** The compiled-cache key
      `compileCache:<runtimeVersion>/<sourceIdentity>` keys by SOURCE
      identity and does NOT hash the JS bytes
      (`docs/specs/module-loading.md` § Compilation Cache, "Storage
      model"). The serving runtime reads a compiled entry and runs it
      with `trustedBodies: true` — SES body re-verification SKIPPED —
      in `pattern-manager.ts`'s `#compileViaCellCache()`,
      `#tryWarmLoadByIdentity()` and
      `#loadPatternByIdentityFromStorage()`. The only gate is the CFC
      atom `COMPILED_INTEGRITY_ATOM` (`cf-compiled-by:cf-compiler`) read
      from the doc's own labelMap (`cellCarriesIntegrity` in
      `compilation-cache/cell-cache.ts`) — plain unsigned
      committed JSON, client-mintable through the honest compile-cache
      builtin path (`prepare.ts` `gateRuntimeMintedIntegrity` returns it
      unfiltered for `kind:"builtin"`) and writable directly at the
      storage layer (memory has no doc-level label validation). The
      SOURCE set IS content-verified (`verifySourceDocs` in
      `compilation-cache/cell-cache.ts` recomputes the Merkle
      identity); the COMPILED
      set is not — that asymmetry is the finding. Consequence: a client
      can write an entry whose key claims source X with arbitrary bytes,
      and the SpaceServer executes those bytes IN-PROCESS. This is the
      DOCUMENTED accepted posture (`module-loading.md` § Threat Model,
      "self-poisoning within a space, acceptable") — but that argument
      was written for CLIENT-ONLY execution; under ON the poisoned bytes
      run in the shared SpaceServer. Fail-open-to-recompile softens it:
      a MISSING/invalid entry recompiles from verified source
      (`tryColdLoadByIdentity` checks entryIdentity match + SES-verifies),
      so DELETING a poisoned entry heals — OVERWRITING one does not.
      Containment leak: closure replication copies compiled docs
      cross-space on `.inSpace()`/content-cache-hit, re-stamping the
      LABEL not the BYTES (`module-loading.md` § Threat Model, the
      cross-space closure replication bullet). RECOMMENDED
      follow-up fix (flagged, NOT committed): bind the bytes — make the
      compiled key, or a co-stored digest the reader checks, a hash of
      the JS, so honest-source/dishonest-bytes fails to a
      recompile-from-verified-source miss; far smaller than full
      server-only compilation and closes the forgery path. The spec's
      named end-state (server-only compilation + real attestation,
      `CFC_COMPILED_BY_ATOM`'s doc comment in `packages/api/cfc.ts`)
      remains the complete fix — this OW56 row.
    - **Finding 2 — version-update was a dual-write under ON, client AND
      server, unarbitrated.** CLOSED: following a piece's source origin
      runs where a piece is explicitly OPENED; tenure activation no longer
      follows the root's source. Under ON, the serving wish builtin opens its
      sidecars and the client references the served cells, preserving one
      source-following owner for that surface too. The server still swaps
      served graphs after accepted pointer writes. What follows is the
      finding as recorded. Both
      runtimes defaulted the update posture on, so both ran the
      check/fetch/compile/persist and attempted the pointer swap; they
      RACED — OCC-guarded so the loser failed clean,
      content-addressed so double-writes converged. NOT a
      correctness bug (freshness is safe either way); the cost is a
      duplicated network fetch + full TS compile per piece per runtime,
      and mismatched compiler fingerprints (shell-baked vs server
      Deno-resolved) can land TWO compiled sets under two
      `runtimeVersion` keys for one source. Recorded as an OW56-adjacent
      efficiency follow-up. (The stale
      `docs/development/EXPERIMENTAL_OPTIONS.md` line claiming
      auto-update is "off server-side" is corrected in this PR;
      `serving-loop.md` §3e already stated it correctly.)
  - **OW57 — the (α3)-family held-wave probe's gate race (a
    PRE-EXISTING test flake in `executor-events-down.test.ts`, filed
    2026-08-21 by the #6170 review's G1 so the constructed-depth
    pin's PR is not blamed when the lane first flakes; renumbered
    OW56 → OW57 pre-merge for the parallel-mint collision with the
    durability train's #6173, which keeps OW56 for server-owned
    program compilation; tracked as CT-2060).** The
    "(α3) + a same-eventId SIBLING tx" step's held-wave construction
    (#6096's W3 pins) sets `settleGate`/`settleGateWhen` and then
    probes `expect(entriesOf(sidecar)).toEqual([])` — asserting the
    wave is still HELD (its "ping" entry not yet durable). As
    originally filed, the when-predicate flipped only once a seal was
    visible through the sealed overlay, so a commit whose settle pass
    checked the gate BEFORE the flip could complete in that same
    cycle, landing the ping before the probe: measured 2/15
    full-suite reds at #6170's head vs 0/10 on main's version (a pin
    inserted ahead plausibly shifts timing into the window;
    fresh-server-per-step rules out state coupling). #6184
    (`c31397906`) landed a HARDENING: the gate now ARMS from the
    handler itself — a flag set synchronously as the handler starts —
    intending the sealing cycle to be held structurally while idle
    cycles pass. The hardening REDUCED but did not eliminate the
    race. Measured at the #6184 construction (the OW54 follow-on
    PR's runs, 2026-08-21, with that PR's two tests inserted ahead
    of the step): 14/15 full-file runs green, ONE red with the
    identical signature — the ping durable AND consequenced at the
    probe (`expect(...).toEqual([])` received the consequenced ping
    entry) — on a loaded machine at `b775787b6`; five runs of plain
    main's version at the same head were green. The owed
    "construction that holds" was then DISPROVED as reachable
    test-side: after two further arming constructions failed on the
    identical signature (a drain-sync seam, then the queue seam
    #6233 merged — the arming provably synchronous with the sealed
    append), 5 identical CI observations on #6223's boards forced
    the seam audit (PR #6223, comment 5401826757): the serving
    cycle's ONLY `inputSynced` consultation is inside the settle
    race (`SpaceServer.#waveCycle()` in `executor/space-server.ts`),
    and the committing tail after the settle break (watermark
    `tx.commit()` → notice settle → wave capture → `await #sealChain`
    → `commitWave`) admits late seals with NO further
    gate sample — an emitter interleaving into those awaits flushes
    past an ARMED gate. The settle is a WATERMARK barrier, not an
    admission barrier (no product defect asserted; W never claims
    tail seqs), so no test-side held-wave construction can be sound
    for tail-arriving work, and even a held gate only DELAYS (the
    deadline arm commits what is sealed so far). RULED 2026-08-24
    (owner, verbatim): "agreed with your recommendation: bounded
    accept-and-retry for now". That bounded retry shipped as the
    interim disposition: the M1 SIBLING step re-ran its full
    construction at most twice, and only a tagged
    `A3StructuralWindow` retried. CLOSED 2026-08-27: the existing
    test-only `decorateWaveCommitSink` seam is late enough to make
    the race deterministic without a product change. The test gates
    the exact home-space batch whose `eventAppends` and
    `consequenceOf` both name the ping event, after the emitter and
    handler/sibling contributions have accumulated but immediately
    before the real sink's head-checked store commit. While that
    batch is paused, the client commits the rival sidecar append;
    releasing it therefore deterministically exercises the
    production sink's conflict reconciliation and orphan/sibling
    fold. The settle-gate/queue monkeypatch, tagged structural
    exception, fresh-attempt teardown, and bounded retry are removed:
    every assertion now fails on its first construction. Validation:
    20/20 focused fake-clock runs and the full 28-step events-down file
    passed; the standard repository checks are recorded on the closing
    PR. No lift trigger (test-harness item; no product-side seam or
    behavior change).
  - **OW58 — CLOSED: resolved-error consequence-notice commits release the
    drain guard.** `#sealEventConsequenceNotice` consumes the commit result
    and routes `result.error` through `#recordEventNoticeFailure`, as it does
    a rejected promise or staging failure. The helper deletes the event's
    drain-in-flight guard so a notice refused before the wave destination
    cannot strand the event for the tenure. A needs-attention notice failure
    also preserves the failed head and its later-event barrier until the
    allowed recovery wake.

    `executor-events-down.test.ts`'s rejected-terminal-notice regression
    injects a resolved `{error}` before storage, verifies the pending head
    and later arrival remain blocked, then verifies ordered recovery when a
    newer input permits the cover. The full 35-step file passed in the
    coverage audit; no mutation check of this fix is claimed. Preparing
    ordinary notices in CFC enforce mode is a separate hardening question,
    not an unimplemented drain-guard fix.
  - **OW59 — OW34-family: per-run CFC trust attribution for served
    runs (the FLAG-5 seam; design RULED 2026-08-21, all seven §10
    recommendations adopted): CLOSED (2026-08-21, the OW34-family
    implementation train).** The defect as designed against: a served
    run's `__ctCurrentPrincipal` mints (authored-by /
    represents-principal) resolved against the RUNTIME-level ambient
    trust snapshot — `storageManager.as`, the SERVICE — so every
    durable served row carried service-DID authorship labels
    (rootcause §2a's store shape; the first-ON-CI-gate row-2 red),
    collapsing the authorship-verification property to a tautology
    and blocking the `cfc-group-chat-demo` ON lift. The build, per
    the design's §8: `Runtime.trustSnapshotForPrincipal(principal)`
    — `{id: "principal:<did>", actingPrincipal, revision}` on the
    runtime's ONE trust-revision composition site (the default
    provider refactored onto it, so a trust-config change invalidates
    per-run served digests exactly as ambient ones — INV-G); the
    SpaceServer's `#stampRun` attaches the per-run snapshot via
    `tx.setCfcTrustSnapshot(...)` with the ruled precedence —
    `delegated.acting.user`, else the handler's acting
    (LT6-inherited pairs included), else a demanded derivation's
    `scopeKeyIdentity.principal` (the Q2 arm — ships, severable),
    else the ambient service snapshot stays (the Q3 ruling:
    actor-less bookkeeping and wave-fallback derivations are the
    loop's own writes). Spec: serving-loop.md §3c's binding sentence
    + SC-38 (cfc-spec-changes.md). Lift evidence
    (`executor-trust-attribution.test.ts`): the FLAG-5 mint pin
    WATCHED RED at base — the persisted subjects were the service
    DID, the §2a query shape verbatim — and green with the fix (the
    served docs' authored-by / represents-principal subjects equal
    the entry's `firedAt.user`); INV-E negative arms (a
    schema-authored literal-DID claim still refuses "must be runtime
    resolved"; an unprivileged direct `["cfc"]` labelMap rewrite on a
    minted envelope still fails closed with the S18
    "unprivileged write to protected cfc path" reason, the stored
    envelope untouched); per-wave multi-principal (two users' runs in
    one drain mint each run's own user, both commits recheck clean —
    no `cfc-prepared-digest-mismatch`); replay (a re-drained entry
    mints from the DURABLE entry's actor; a second activation re-runs
    nothing — ONE consequence commit per eventId — and the labels
    stay byte-identical); the live stamp seam's precedence pinned on
    the real stamper (delegated / acting / LT6-inherited / demanded /
    actor-less-keeps-service); OFF-arm neutrality (no stamper ⇒ no
    snapshot call — the OFF client and flag-ON client speculation
    leave the edit()-attached ambient snapshot untouched); INV-G
    revision-composition equality with and without a trust config.
    The `cfc-group-chat-demo` ON gate is this row's live lift
    condition (the skip entry is removed by this train; green 4/4 —
    three fresh-store lift runs plus a quiet-machine solo run, every
    run's store audited); the
    store-dump audit (zero authored-by / represents-principal atoms
    naming the service DID — INV-D) arbitrates Q3's flagged caveat:
    a serving-side system-pattern restage of an owner-gated pattern
    (the setup/defaults mint carve-out) would mint
    `represents-principal: <service>` under keep-service; if a live
    gate ever surfaces that shape, the named follow-up is an
    owner-resolved snapshot (OW31's ACL owner resolution), not a
    silent widening. Out of scope, left where the ruling put them:
    the sqlite/llm-dialog direct RUNTIME-provider reads (OW53's
    identity-model decision — the per-run tx snapshot is the
    substrate a fix would re-point them at); label option (b)'s
    served-provenance mark (future, on product need, with its own
    spec sentence). OW53-adjacent note (the #6190 review's NOTE-6,
    recorded not fixed): delegated READ sessions register their
    demand under the PROCESS DID rather than the acting principal
    (memory/v2/server.ts — the session-demand identity assembly,
    `session.principal` into the demander identity) —
    label-inert (no mint reads it) and operator-allowlisted; an
    identity-model decision for OW53's family, not this row's.
  - **OW60 — the echo-drop smell: the stream-action validation guard
    silently skips a client echo run whose composite `$ctx` has not
    materialized (OW33 triage review pass, 2026-08-22; the canary
    moved here from the topics-navigation flake).** This remains open:
    `scheduler/events.ts` requeues client/OFF handler-not-run dispatches, but
    explicitly excludes the flag-ON speculative echo, which still seals its skip. That
    requeue path does not restore this row's missing speculative cover.
    The trace, exact
    (ow33-triage-report.md §6): on a flag-ON Deno controller,
    `board.result.set(..., ["addTopic"])` fires the stream handler
    whose `$ctx` schema REQUIRES `myName`/`topics`/`crossrefs`; at
    send time the resolved `$ctx` can hold `myName: ""` and
    `topics: []` while the derived `crossrefs` member is still
    missing, and the pre-OW51 validation guard
    (`packages/runner/src/runner.ts` — "action argument is
    undefined (potential schema mismatch) -- not running") SKIPS
    the echo run silently: no refusal, no re-trigger, no echo
    cover. The board stays CORRECT (the event still appends; the
    served run has the materialized `$ctx`; store exactly-two
    topics, events appended == processed) — the loss is purely the
    client's speculative cover, so any unbarriered read between the
    drop and the served arrival sees pre-consequence state.
    Occurrence ~2/10 on the topics-navigation setup at the true ON
    topology, OBSERVED SURVIVING the test-side fix (the barriered
    fid capture absorbed the drop in 2 of the 10 lift-gate runs —
    the smell persists; only its test-flake symptom is closed).
    FLAGGED, not filled: whether this guard should take the OW51
    refusal+retrigger disposition (dispose as a non-event,
    re-trigger when the reads change) is a spec decision — #6179
    deliberately scoped the refusal to the schema-aware lazy READ
    path, and a composite-context validation failure is a
    neighboring but distinct shape; a ruling here gets its own
    events.md/speculation.md sentence before any build. Trigger:
    the next echo-semantics pass, or any live surface where a
    dropped echo's missing cover is user-visible (the OW33
    arrival-witness fork's fix would NOT close this — a dropped
    run seals no overlay entry at all).**
    EVIDENCE NOTE 2026-08-24 — the OBSERVED RATE collapsed; the row
    STAYS OPEN. Measured by the topics measurement campaign (seat
    `topics-benchmark`, branch
    `claude/server-exec-v2-topics-benchmark` — park checkpoint
    `97f0745e5` plus evidence commits, the harness and per-run
    artifacts committed under `.bench-artifacts/` and NOT archived
    here; report ARCHIVED at
    `../../history/plans/server-execution-v2/optimize/topics-measure-report-2026-08-24.md`
    §2b/§5.3) at tip `2ea87cea9` — #6199's CFC
    envelope/cid convergence, with OW45 arm-B stage 1 (#6210) in
    tree. The guard fired **0 times across the campaign's 20 journey
    runs** (400 series events: 20 `addTopic` events × 20 runs), and
    THIS ROW'S OWN WINDOW — the seed writes issued right after board
    create, the barriered fid capture immediately after — was
    exercised 40 times (2 seeds × 20 runs) with no fire. The row
    records ~2/10 at earlier heads.
    WHAT THE NUMBER IS AND IS NOT: the instrument is the seat's
    journey harness, not the `topics-navigation` setup the ~2/10 came
    from (that file ran in the same campaign — 6/6 green per arm —
    but its guard fires were not counted separately). The 20 runs are
    10 ON + 10 OFF and this row's trace is a flag-ON controller, so
    the like-for-like evidence is 10 ON runs: at a ~0.2 per-run rate,
    no fire in 10 runs happens ~11% of the time (0.8^10) — the
    absence is SUGGESTIVE, not decisive. Only if the guard is
    arm-independent (unestablished) do all 20 count, taking that
    figure to ~1%.
    PLAUSIBLE HEALERS — HYPOTHESIS, NOT CONCLUSION: #6199 moved the
    commit boundaries this window sits on, and #6210 materializes
    space roots server-side; either could plausibly make the derived
    `crossrefs` member present at send time. Neither was tested
    against this guard and no mechanism account exists. The same
    campaign records the sibling observation under the same caveat —
    the old head's deferred-start ConflictError also went quiet at
    this tip (0 occurrences in all 66 new-tip runs), "consistent with
    #6199's commit-boundary changes; not proven causal".
    CLOSURE, against this row's own conditions: NOT MET. What the row
    flags is a SPEC decision — whether the guard takes OW51's
    refusal+re-trigger disposition, which owes its own
    events.md/speculation.md sentence before any build — and a fire
    count cannot discharge a spec decision; the stated trigger (the
    next echo-semantics pass, or a live surface where the missing
    cover is user-visible) has not occurred. The row already carries
    the precedent for refusing closure on absence: the smell was
    OBSERVED SURVIVING the test-side fix that closed its flake
    symptom, which is why it was moved here at all. What this note
    narrows is the reproduction budget — do not expect ~2/10 at this
    tip — and nothing else.

  - **OW61 — delivery of content-addressed computed cells to a
    replica without their verified `cid:` schema docs: an UNCAUGHT
    fail-closed throw in every space-cell-only subscriber (minted
    2026-08-24 from PR #6210's first red board; pre-existing
    delivery-machinery defect, NOT the ensure seat's).** Mechanism:
    when a subscription delivers a `computed:` doc whose schema ref
    (`cid:…`) is "not delivered and verified in this replica",
    `SpaceReplica.#validateArrivedSchemaDocuments`
    (`packages/runner/src/storage/v2.ts`) THROWS on the background
    consume path (`SpaceReplica.#applySessionSync()` →
    `SpaceReplica.#consumeUpdates()`) — uncaught,
    outside any caller's try, killing the consuming worker/test file
    wholesale. Evidence: CI run 32742547103 at `7d97a80aa` — 13
    file-level failures sharing exactly this class across the runner,
    runtime-client, and shell ON lanes and 9/10 pattern ON shards; the
    broken doc in the runtime-client lane
    (`computed:fid1:7BycCyHc2yDDzr17jnXayWZMxpweSGk2JcGKILKguvo`) is
    byte-for-byte the default-app root's computed cell (content-
    addressed ids are space-independent), delivered through the
    fixtures' plain space-cell subscriptions after the stage-1 server
    ensure materialized roots in their spaces. TRIGGER: any server-side
    materialization into a space with a subscriber that did not demand
    the docs root-aware — today that is the stage-1 ensure wherever it
    runs ON; the affected subscriber shape is the SPACE-CELL-ONLY
    subscriber (no root-aware schema walk), which exists in PRODUCTION
    (CLI, agents-host), so any real deployment with such a subscriber
    re-surfaces this the moment the ensure runs there. Timing-
    dependent: whether the computed doc's frame lands before its
    `cid:` sibling is delivery-window timing (CI hit it consistently;
    one local run at the same head did not). With the test lanes'
    ensure opt-out (the RULED switch) the defect was LATENT again, not
    fixed — history: the opt-out retired with the ensure-on lane-flip
    PR once the containment below and the client absorb fix (#6292,
    this row's tail) had both landed, and the ON lanes run the
    production default again. SURFACED TO THE OWNER 2026-08-24 (the
    coordinator is carrying it). RULED 2026-08-24 (owner, verbatim —
    the shipping side is the fix):

    > "seam 3: that's a bug then, and the most straightforward fix is
    > to make sure the subscription query results include cids when
    > they are mentioned, just like they follow the `source` metadata."

    > "ack on all recommendaions, except 2/OW61 (ii): instead of
    > holding computed: docs, let's fix the shipping side and make
    > sure `cid` s arrive with the `computed` that require them, i.e.
    > the seam 3 fix i propose (and i'm surprised isn't in already,
    > tbh)."

    The coordinator's recommendation (i) — the arrival validator's
    uncaught throw becomes a CONTAINED per-doc failure (fail-closed
    for the doc, contained for the process) — was ACKed and stands
    beside the shipping fix. BUILT (this row's closing PR), three
    parts, each red-first. **The mechanism, located:** the cid
    following the ruling asks for EXISTED at the graph layer —
    `assembleSchemaDocClosures` (memory/v2/query.ts, since #5833)
    scans every delivered snapshot for embedded cid refs and stages
    the verified closure, beside the meta-link following in runner
    traverse.ts (as of #7193 a traversal follows a document's `cfc`
    envelope alone, through `loadLabelSchemaDoc`) that shipped computed
    results at all — but it stages a closure doc only while the
    tracked graph has never delivered it, and the frame builders
    additionally elide entries the session cache says were delivered
    before. So a RE-delivered cid-mentioning doc shipped in a frame
    WITHOUT its cid: sibling, and that frame's validity hung on the
    client having durably applied every earlier frame in order —
    the ordering delivery-window timing broke. (1) Shipping — BUILT
    as a per-frame resend (`closeFrameOverSchemaRefs` at the three
    diffed builders), then **REVERSED by the owner 2026-08-24
    (verbatim)**:

    > "this change undermines why we added cids in the first place,
    > to not retransmit the schemas all the time"

    > "the client should absorb all information sent from the server,
    > it shouldn't ever dismiss a frame. i don't think it even does
    > so."

    > "So if we saw this in CI - earlier frame delivered cid doc,
    > later frame didn't see it - then that's the actual bug."

    The resend and its pins and spec text are REMOVED; the server's
    cross-frame elision of already-delivered cid docs is
    correct-by-design, and the ACTUAL bug is CLIENT-side — a replica
    that failed to absorb/retain (or apply in order) an earlier cid
    delivery. The client absorb handoff that closes that defect is
    recorded at the end of this row. (2) Containment — ACKed, KEPT,
    and what closes OW61's crash class on its own:
    `#validateArrivedSchemaDocuments`
    returns a quarantine set instead of throwing — the offending doc
    drops from the frame with a loud per-doc diagnostic (fixpoint
    over in-frame schema docs so dependents fail closed together),
    the replica keeps its prior state for it, and the heal arrives
    with the next FULL evaluation (watch.set/reconnect ship the
    whole assembled closure — under the elision design an unchanged
    quarantined doc is rightly never re-delivered mid-session);
    `SpaceReplica.#consumeUpdates()` additionally catches any residual per-frame
    apply failure. In the race window the computed doc now
    quarantines-with-loud-log instead of killing the worker; the
    correctness fix lands from the investigation session. Also kept:
    the watch.add session-cache staging reorder (the delta review's
    S4 — diff, build the frame, only then commit the cache; its
    red-first pin died with the resend, whose closure pass was the
    only reachable throw in that window, so the ordering is kept as
    commented hygiene). (3) Pins standing: four steps in
    `runner/test/schema-doc-sync.test.ts`, each watched red at base
    `2ea87cea9` with the exact uncaught validator throws from the
    board (quarantine + innocent-sibling survival + the
    full-evaluation heal + the consumeUpdates belt); and the
    ensure-driven containment pin in
    `runner/test/executor-space-root-ensure.test.ts` ("a plain
    space-cell subscriber SURVIVES a replica that fails to absorb
    the cid schema docs") — the register's named deterministic
    producer with a simulated absorb defect (cid upserts dropped at
    the reader replica), routed through the BACKGROUND consume path
    (the subscription registers before the ensure activates, so the
    violating frames arrive as pushes — the crash class's actual
    seam; the round-3 review's R2 caught the earlier pull-path
    construction passing at base). The discriminator is DELIVERY
    LIVENESS: after the quarantine, a writer's push to a pre-synced
    cell must arrive through the same consumer — watched red against
    the no-containment base validator (the board's exact doc pair as
    an unhandled rejection, then the liveness timeout), green at
    head with a cid-mentioning doc quarantined, the request path
    answering ok, and the ensure completing.
    Subscriber-shape finding (the owner's cf-harness question,
    verified): ALL THREE named production space-cell-only
    subscribers are ONE shape — `PiecesController`'s constructor
    subscription (`piece/src/ops/pieces-controller.ts` —
    `runtime.getSpaceCell(space).sync()`, no root-aware demand) —
    constructed by the CLI (`cli/lib/piece.ts`), agents-host
    (`connectors/agents/host/src/fabric-runtime.ts`), AND cf-harness's
    run_pattern session (`cf-harness/src/fabric-session.ts`), so
    yes: cf-harness is also that shape, and the containment covers
    all three. Residual trigger: any live `schema-doc-quarantine` log
    — each occurrence is evidence that another client absorb/ordering
    defect remains, not a server-side hole. The LOSS no longer outlives
    a reconnect: a reconnecting client declares its holdings
    (memory-v2/04-protocol.md §4.1.2), and a quarantined document is not
    among them, so the resume's catch-up (or the re-establishing
    watch.set) re-delivers it with its closure — the diagnostic still
    names the defect to find; the replica no longer stays incomplete
    until the session lapses.
    SHIPPING SIDE, current state: the closure pass stages what a
    delivered document's refs name, and the memory package now PINS both
    halves of that guarantee —
    `memory/test/v2-schema-doc-closure-delivery.test.ts`, seven
    properties over the session frame, each with a mutation that reds it,
    every watch using the SELECTS-NOTHING selector because under a
    walking selector the traversal loads the schema documents anyway and
    the assertions pass with the closure pass disabled. The gate that
    keeps a session from being sent a closure document twice is the frame
    builders' session-cache diff, NOT the closure pass's
    `tracker.has(key)` staging gate: removing that gate changes no wire
    frame. THE SHIPPING SIDE IS NOT THE DEFECT, measured rather than
    argued: the per-session delivery probe was carried into a CI pattern
    lane at the ensure-ON posture (the class does not reproduce on demand
    locally), and one run produced both halves at once — 103
    `schema-doc-quarantine` on the client over 13 distinct missing
    `cid:` ids, including this row's own `computed:fid1:7Byc…` against
    `cid:fid1:zgJY…`, against 136 ref-carrying frames on the server with
    ZERO delivery violations and zero own-write elisions. Every `cid:` a
    delivered document referenced had been put on the wire for that
    session. That is the owner's 2026-08-24 ruling in measured form, and
    it hands the residual to the CLIENT-side absorb/retention
    investigation. The bound: the probe sees what the server puts in a
    frame, not what the socket carried or the replica applied, so it
    rules out the shipping side without separating a lost frame from an
    unabsorbed one. The
    measurements behind all of this, including the probe results that
    falsify the earlier "the closure pass never completes an iteration"
    localization and the correction to this row's own claim that
    Cz/Nz/xz reference g2, are in
    [`ow61-shipping-side-reexamination-2026-08-25.md`](../../history/plans/server-execution-v2/optimize/ow61-shipping-side-reexamination-2026-08-25.md).
    CLIENT ABSORB SIDE, current state: FIXED. A `session/effect` could
    arrive before the first watch response; `SpaceSession.handleEffect`
    created a `WatchView` with the frame in its aggregate snapshot but
    did not enqueue the raw sync, the first watch response returned only
    its own sync to `SpaceReplica`, and the runner subscribed afterward.
    The replica therefore never applied the earlier frame even though the
    server session had delivered and cached it. `SpaceSession` now returns
    those pre-response effects in wire order as
    `WatchMutationResult.precedingSyncs`, and `SpaceReplica` applies that
    prefix before the response sync. The buffer belongs to the session's
    delivery epoch: a successful resume retains it, while a replaced
    session clears it before re-establishing watches. No server
    retransmission changes.
    The runner pin sends a valid schema document before the first
    `watch.add` response and a referrer in that response; it quarantines
    before the fix, stores both afterward, and reds again when only the
    prefix apply is removed. A per-session ensure-ON CI probe removed the
    earlier realm-global ambiguity: before the fix all 7 pre-watch
    `cid:` effects (raw-complete and carrying `ayhc5ov`) lacked a
    same-session/same-sequence replica apply and the lane emitted 118
    quarantines; after the fix all 6 pre-watch effects reached the
    ordered-prefix apply, quarantine count was 0, and shard 1 passed.
    The complete mechanism, layer boundary, mutation check, and run/job
    ids are in
    [`ow61-client-absorb-root-cause-2026-08-25.md`](../../history/plans/server-execution-v2/optimize/ow61-client-absorb-root-cause-2026-08-25.md).

  - **OW62 — adopt-not-start: the piece-open seam is where the ON
    execution model's "one starter per piece" has to land. POST-FLIP
    (RULED 2026-08-22, owner: "ok, let's do (a) and record (b) as a
    post-flip task").** LIFT NOTE (2026-08-24): this row was minted as
    "OW61" on PR #6208's branch (`claude/server-exec-v2-client-start-retry`,
    unmerged) and is lifted here essentially verbatim under the next
    free number, because it records an OWNER RULING that must not live
    only on a branch that may never land; the parallel-mint collision
    (both branches picked OW61 — the OW56/OW57 hazard again) is
    resolved first-come: OW61 on main is the delivery-defect row
    above. CONSEQUENCE FOR #6208 IF IT LANDS: its own OW61 row is
    SUPERSEDED by this OW62 and must be dropped, and its
    cross-reference to it (the "model's destination in OW61 below"
    sentence in its copy of `verification-coverage.md`) must re-point
    to OW62 —
    otherwise the union-merge mints the silent duplicate this note
    exists to prevent. The "(a)" retry this row's landing duty retires
    is #6208's own unmerged build; the duty binds whenever both land.
    The destination the OW45 arm-B fork named (b),
    recorded rather than built: a flag-ON client whose navigate lands
    on a piece the SERVER materialized does not run a deferred start
    of its own at all — it ADOPTS the served instance (sync the root,
    register demand through the served closure) and starts nothing.
    That DISSOLVES the first-hydration race instead of re-attempting
    it, and it is the posture canon already states rather than a new
    mechanism: runtime-mapping.md's N62 row deleted the old
    observation-adoption feature precisely BECAUSE under the flag
    "clients no longer run committed derivations at all (reload is
    read-and-render, §3b)", and serving-loop.md §3b states that
    posture. The client-side deferred start is the remnant still
    running against it at the navigate/piece-open seam. Design seed:
    `../../history/plans/server-execution-v2/optimize/ow45-armb-client-start-fork.md`
    (disposition (b), with the instrumented catch that motivates it).
    WHY POST-FLIP: it touches the piece-open path for every ON
    navigate. (This row first said the flip's empty-skip-list bar was
    reached by (a) without moving that path. The live gate DISPROVED
    that — see the arm-B gate evidence in OW45 — so which arm reaches
    the bar is an OPEN question, not a settled one, and (b)'s
    scheduling is the only claim this row still makes.) **The five
    pieces it still needs, none of them settled by this row:**
    (i) how the ADOPTED context is constructed client-side — what a
    client holds for a piece it did not start, and which of today's
    start-walk products (node wiring, the cancel registration, the
    demand registration) it keeps; (ii) the BIRTH-adoption flow — a
    navigate that arrives BEFORE the server has materialized the
    piece has nothing to adopt, so the seam needs a defined wait or a
    defined fallback; (iii) whether §3d's speculative-consequence
    stamp SURVIVES at all once no client start transaction exists —
    §3d's sanction is written for the deferred start, and adoption
    deletes the thing it sanctions, so that sentence needs
    restatement, not inference; (iv) the UNMATERIALIZED-piece
    fallback, i.e. whether the OFF-arm start path is retained as a
    fallback under ON and under exactly which predicate; (v) the
    first-hydration UX gates — what the user sees between navigate
    and adoption, which is today covered by the client's own start
    rendering immediately. **Its landing DUTY: retire (a)'s retry.**
    With no client start transaction there is no start commit to be
    refused, so `reattemptDeferredStartOnStaleRead` and the
    `isStaleConfirmedReadConflict` predicate become dead code on the
    ON arm and must be removed with it (the OFF arm keeps them while
    the OFF path exists — see #6208's OW45-row disclosed ripple: that
    fix is deliberately not flag-gated). Trigger: the post-flip soak,
    or any ON surface where a re-attempted start is observed
    exhausting its budget in real usage
    (`deferred-start-conflict-exhausted`), whichever comes first.
    **RE-FRAMED (RULED 2026-08-24, owner ack "so ack on all
    recommendaions"): the destination is START-WITHOUT-COMMIT, not
    adopt-not-start.** Clients DO start pieces — speculatively, with
    the normal start walk's context — and the server-state wins:

    > "a client can still speculatively run it locally, just that
    > the server-state will eventually win"

    > "clients should actually start patterns when they load, but
    > it's an entirely reactive flow that catches up with the
    > server."

    — owner (Berni), 2026-08-24. The five pieces, re-dispositioned
    (the history above kept as written): (i) adopted-context,
    (ii) the birth-adoption wait, and (v) the hydration UX all
    DISSOLVE — the context is the normal start walk's; whoever wins
    the race materializes and the loser catches up; the UX is
    today's. (iii) the §3d restatement arrived EARLY via the OW45
    catch-up-and-start build (serving-loop.md §3d's RULED 2026-08-24
    paragraph). (iv) — whether the OFF-arm start path is retained as
    a fallback under ON, and under exactly which predicate — is the
    STAGE-2 question, unchanged, and is what remains of this row.
    The landing DUTY above is discharged by history: #6208 closed
    unmerged, so no retry ever landed to retire; its
    `isStaleConfirmedReadConflict` predicate lands via the OW45
    build as the LIVE discriminator of the catch-up recovery — not
    dead code, and renamed `isStaleReadConflict` when the engine's
    pending-read staleness sibling joined it (the OW45 block's
    covered-shapes sentence) — and `reattemptDeferredStartOnStaleRead`
    never landed at all (`deferred-start-conflict-exhausted` never
    became a live log key; the recovery's keys are
    `deferred-start-catchup` / `deferred-start-catchup-failed`).**
  - **OW63 — the wake shaper can invert same-space arrival order
    across PIECES, with no load-park involved (PRE-EXISTING; minted
    2026-08-26 from the independent review of PR #6365, finding F1's
    sibling). NOT OWED BY THAT PR** — it neither introduced nor
    worsened this; it is recorded because reading the barrier's
    reachability exposed it. events.md §2 orders served entries
    "across streams in one space, arrival order", but the wake shaper
    buckets held events per PIECE-GROUP, and two pieces in one space
    have SEPARATE buckets with independent burst budgets and window
    ticks. So a later-arrived entry for piece Y whose bucket is cold
    (synchronous, inside `BURST_CAPACITY`) can consequence ahead of an
    earlier-arrived entry for piece X whose bucket is saturated and
    therefore held to the next window tick (≤1000 ms). No failure of
    any kind is required — only a burst on one piece and normal
    traffic on another, which is ordinary multi-piece load. What is
    NOT yet established: whether any §2-visible consequence ordering
    actually depends on cross-piece order in practice (same-piece and
    same-stream order are preserved by the shaper's own FIFO), so the
    first move is to decide whether §2's "across streams in one space"
    is meant to bind across pieces at all — a SPEC question for the
    owner before it is a code question. If it does bind, the candidate
    shapes are the same two F1 names for the load-park case: exempt
    drain re-dispatches from shaping (re-deliveries of already-shaped
    input — re-shaping double-charges the timing budget), or give the
    shaper a space-level ordering constraint rather than a per-group
    one. Unpinned and unmeasured; structural from the code only
    (`wake-shaping.ts`'s per-group `pending` + window tick, and the
    drain's per-entry `queueEvent`).
  - **OW64 — the runtime read ceiling does not travel with a demand
    (minted 2026-09-18 from the ON-default rehearsal's one failing
    unit test, `pieces-controller-connection.test.ts`).**
    `RuntimeOptions.cfcReadMaxConfidentiality`
    (`docs/specs/sqlite-builtin/06-cfc.md`, "Runtime read ceiling")
    bounds only the runtime it is set on. Under the ON arm a client
    runtime executes no `db.query` of its own — the serving runtime
    performs it, under ITS option — so a ceiling accepted on a
    flag-ON client would read as a bounded session whose reads
    nothing bounds. The constructor refuses that combination
    (`packages/runner/src/runtime.ts`; pinned in
    `packages/runner/test/sqlite-runtime-read-ceiling.test.ts`),
    which made the pieces controller's forwarding test fail at an ON
    default: the test depended on the ambient default for its arm.
    **CLOSED (2026-09-18, the same change): the ceiling travels with
    the session.** RULED by the owner ("do this the right way"; the
    ceiling is wanted for ordinary client sessions too, where the
    server will sometimes assign it). Mechanism: the client runtime
    hands its ceiling to its storage manager before any session
    opens (`IStorageManager.setSessionReadCeiling`, refused after a
    session is open), the manager declares it in every session's
    signed `session.open` descriptor (`SessionDescriptor.readCeiling`,
    memory-v2 04-protocol.md §4.1.2) and refuses a server that does
    not advertise the `sessionReadCeiling` protocol flag, the memory
    server records it on the session (fresh per open; a resume
    re-declares) and exposes it through `Server.sessionReadCeiling` —
    the ONE seam a server-assigned ceiling reaches the run through as
    well — and the SpaceServer's `#stampRun` reads it for the run's
    `scopeKeyIdentity.sessionId` and carries it as
    `WaveRunContext.readCeiling`. The sqlite builtin resolves ONE
    effective ceiling per run (`effectiveReadCeiling`: the serving
    runtime's option met with the carried one, `onExceed` meeting
    toward `fail`) and uses it where it used the runtime's option:
    the session-scoped query request hash (`runtimeReadCeiling`),
    the row meet and the mode default. Ordinary cell reads meet the
    carried session ceiling with the runtime ceiling as well. The
    constructor refusal is retired; what it refuses now is a manager
    that cannot carry the ceiling. Pinned: wire parse, registry and
    flag in `packages/memory/test/v2-session-read-ceiling.test.ts`;
    the memory client re-declaring the ceiling on every reopen after a
    dropped connection (the server takes it fresh per open, so a
    reopen without it would read unbounded) and refusing, at every
    open, a server without the flag, in
    `packages/memory/test/v2-client-read-ceiling.test.ts`; the same
    refusal through the remote session factory and the
    late-declaration refusal in
    `packages/runner/test/memory-v2-remote-session.test.ts`; the
    constructor handoff and the effective-ceiling meet in
    `packages/runner/test/sqlite-runtime-read-ceiling.test.ts`; end
    to end — a bounded and an unbounded client of one space served
    their own session instances of one `PerSession` query from one
    labeled row set, and a shared materialization whose labeled rows
    are withheld from the bounded client —
    in `packages/runner/test/executor-sqlite-read-ceiling.test.ts`;
    the controller's forwarding on both arms in
    `packages/piece/test/pieces-controller-connection.test.ts`.
    cf-harness needs nothing: its `--max-confidentiality` bounds the
    session on either arm, and its bounded-as-configured attestation
    over the client runtime's fields stays true because the carried
    value is those fields. Shared query results retain the complete
    labels of their materialized rows and array shape; each cell read
    enforces its runtime and carried session ceiling. The cell guard
    is pinned in `packages/runner/test/cfc-cell-read-ceiling.test.ts`,
    and shared result shape, aggregate and diagnostic protection in
    `packages/runner/test/sqlite-shared-read-ceiling.test.ts`. One
    residual, fail-OPEN and therefore owed: the stamp reads the LIVE
    session record, so a run served as a session whose record has
    expired — an event a bounded client fired and then stayed
    disconnected past the session's retention — finds no ceiling and
    reads under the serving runtime's option alone, into that
    session's instance. A detached session inside its retention keeps
    its ceiling; past it the server no longer knows the session was
    bounded. The candidate close is the server-assigned source this
    seam exists for: a ceiling keyed by principal (or persisted with
    the event's `firedAt` pair) rather than by a live session.

## 4. Standing rule

A ruling batch that adds a BINDING sentence adds its coverage row
(or its owed entry) in the same PR — this register is under the same
docs-move-together rule as everything else. The next full mapping
pass is due when the owed register empties or Phase 2 flips ON,
whichever comes first.
