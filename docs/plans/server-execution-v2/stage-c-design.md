# Server-execution v2 — stage C design pass, reconciled

**Status: LIVE — a design + build work order for the design build stage
of the server-execution v2 arc (not yet executed).** Written 2026-08-18
by the reconciler, after the convener that launched the three design
lenses died before reconciling them. Base: the stage-C docs branch tip
`bebf8e1ff` (PR #6009, off the tuning trio's `b54bf5215`). The three
lenses read the fan-out B tip `fb2292a24`; the build lands on the
stacked stage-C tip. When the build stage lands, this document is
archived by `git mv` to
`docs/history/plans/server-execution-v2/stage-c-design.md` — beside the
[stage-C closeout](../../history/plans/server-execution-v2/stage-c-closeout.md),
which is where the closeout and the register said the design report
belongs; it sits in `docs/plans/server-execution-v2/` now because a
design for work not yet done is live documentation
([`docs/README.md`](../../README.md): a plan you intend to execute starts
in `docs/plans/`), and this subdirectory mirrors the history tree's
`plans/server-execution-v2/` so the archive step is a move, not a
re-placement. (Not `docs/development/projects/`: this repository has no
such tree.)

**AMENDED 2026-08-18 (the same day, after the owner's direction quoted
in §2.0): design (d) — the STRUCTURAL WALK — is SUPERSEDED by (d′):
demand is the memory server's TRACKED-IDS CLOSURE (the set of documents
each client session cares about, schema-narrowed by memory v2's own
tracker, instance-keyed, accumulated across overlapping watches, coarse
on unsubscribe); the serving loop marks the writers of demanded
instances as demand roots and runs the ones not CURRENT for a demanding
pair; there is NO demand walk and NO structural-versus-value
distinction anywhere. §2 is now (d′), the primary design; the structural
walk is kept VERBATIM as the fallback in §2F (demoted, not deleted);
§5's ruling #1 is restated and #2/#3/#11/#12 are moot; one new item is
RULED (R-D, the coarse unsubscribe); §6's W0/W1 are re-targeted. The
reconciliation in §1 stands as the record of the lens pass — items 1.1
#3, D1, D3, and D6 now concern the fallback only.**

**RULING SET ACCEPTED 2026-08-18 (owner, verbatim: "ruling set is
accepted") — later the same day.** Every OPEN item in §5 is RULED per
its stated recommendation (the already-RULED R-A–R-D and the MOOT
#2/#3/#11/#12 unchanged). The ONE binding spec edit the acceptance
unlocks that is pure text — the (d′) replacement of serving-loop.md
§1:57–62 with §2.10's text — LANDED with the acceptance (RULED marker;
its IMPLEMENTATION is W1 — register OW39). The other spec edits the
rulings unlock (events.md §5's drops/errors pin, speculation.md §4
step 2's clarifying sentence, scopes.md §9's ragged amendment) are
RULED text that rides the build PRs, not landed with the acceptance;
item 4's step-4 sub-question is RULED owed (register OW40). Nothing
else in this document's substance moves; **W0 (§6) is next.**

**Inputs — the reconciler re-did none of their analysis; it reconciled
them:**

- the spec-only lens (blind to code): what the ruled sentences REQUIRE
  versus DESCRIBE, the "no lazy demand" reasoning, eleven flagged
  silences (S6), the counters the spec would want, the proposed
  amended serving-loop §1 sentence —
  [`stage-c/stage-c-lens-spec-blind.md`](../../history/plans/server-execution-v2/stage-c/stage-c-lens-spec-blind.md)
  ("SB" below);
- the server demand-walk lens: the verified K×N duplication, the
  walk's read anatomy (~7 read activities per property, value-only
  changes re-fire it), the redesign (a)+(c′), the union-log fixes,
  pins T1–T9 with mutations, rulings R1–R5, refutation conditions —
  [`stage-c/stage-c-lens-d-server-walk.md`](../../history/plans/server-execution-v2/stage-c/stage-c-lens-d-server-walk.md)
  ("W" below);
- the client intent-watch lens: the schema-less whole-sidecar
  `cell.sink`, the demand leak, the redesign (a) (a non-reactive
  storage-notification listener), interim (b), the seven-point build
  contract, pins 1–11, rulings 1–5 —
  [`stage-c/stage-c-lens-e-client-intent.md`](../../history/plans/server-execution-v2/stage-c/stage-c-lens-e-client-intent.md)
  ("C" below);
- context: the instrumented
  [attribution](../../history/plans/server-execution-v2/stage-c/stage-c-attribution-report.md)
  (chat event waves 2.6–3.6 s settle, 96 % walk + resubscribe; the ON
  client's `scheduler/run` per note 0.6 → 15.5 s) and the
  [re-benchmark](../../history/plans/server-execution-v2/stage-c/stage-c-rebenchmark-report.md)
  on the trio tip (chat cross-user p50 7.4–9.7 s vs OFF 0.22 s; note
  createToView 3.9–4.2 s vs 1.13 s) — the baseline this design inherits;
- the owner's rulings of 2026-08-18 that already bear on the design,
  folded in below as RULED and not re-asked (§5).

File:line citations are at `fb2292a24` (the lenses' tree) unless
marked; Appendix A gives the offsets on the tuning tip. Spec citations
are by section; the lenses' spec line numbers are also `fb2292a24`'s —
serving-loop.md §1:53–62 was unmoved on this branch until the
acceptance commit (2026-08-18), which replaced §1:57–62 with the (d′)
text (§2.10; RULED): "§1:57–62" throughout this document names the
demand-WALK sentence as it stood at `fb2292a24`; on this branch the
(d′) paragraph now spans §1:57–89, and every later serving-loop.md
anchor sits a further +27 lines below Appendix A's tuning-tip column
(§3b/§7/§8 were already ~35 lines lower than `fb2292a24` from the
RULED text added on 2026-08-18: B7 :423 → :450, §7 :1147 → :1174, §8
:1200 → :1227).

## 0. In one screen

- Two design-class terms remain after the tuning trio: the server's
  per-demander DEMAND WALK (d) and the client's whole-sidecar INTENT
  WATCH (e). Neither cost is forced by the spec; both are how demand
  and intent are TRACKED, not the serving-loop model, W, the ratchet,
  B7/C11b, the commit classes, the lease, or the wire.
- **(d′) — PRIMARY (owner direction 2026-08-18, §2.0): the demand WALK
  is DELETED.** Demand is the memory server's per-session TRACKED-IDS
  closure — `session.trackedIds`, the instance-keyed set of every doc a
  session's watches reach, narrowed by the selectors' schemas,
  maintained on every push, accumulated across overlapping watches,
  coarse on unsubscribe (RULED acceptable, R-D) — exposed as the union
  over a space's client sessions with each row's demanding (principal,
  session) pair. The serving loop marks the WRITERS of demanded
  instances as demand roots (a new `isDemandRoot` disjunct, §8-bracketed)
  and runs the ones NOT CURRENT for a demanding pair (B7's per-instance
  clean bit; the basis index is the same predicate at activation);
  those runs' own logged reads pull upstream and dirty downstream — the
  client-side scheduler's model. Structure changes ride the two
  mechanisms that already exist (the tracker's push-time re-traversal;
  a run's own read of a newly linked doc). No structural-versus-value
  distinction anywhere. §2.
- (d) the STRUCTURAL WALK — one node per (scope-name, root id), a
  read-class gate that value-only changes do not fire — is the FALLBACK
  (§2F), reached only if (d′)'s refutation experiment (§2.8 (b)) finds a
  real hole.
- (e) becomes a NON-REACTIVE storage-notification listener keyed on
  the outstanding intent set: O(outstanding) per check, zero
  transactions, zero CFC probes, no scheduler node, never inline in
  notification dispatch. Interim, if the build lands in two steps: a
  schema-narrowed sink (linear, still an effect).
- (α) — the deadline-time purge of unrun LT1 in-process leftovers, the
  drain skip against a `streamEntry`-bearing copy, and the
  derivation-emitter orphan REFUSAL — is RULED (events.md §4) and OWED
  to this stage; it is a work item here.
- Acceptance (owner's measurement caveat, RULED): SERVER SETTLE TIME on
  the cross-user chat and lunch journeys, sub-second, measured
  explicitly (`waitForSettled`), PLUS client-local speculation latency
  reported separately as a preserved property; the OFF client-local
  number is not the comparator, but several-second sends are wrong on
  any comparator.
- One ruling matters most: the walk's spec sentence — serving-loop.md
  §1:57–62 "runs once per demanding pair" — is descriptive; under (d′)
  adopt the (d′) text (§2.10): demand is the union of the demanding
  sessions' tracked instances; the loop runs the stale writers of
  demanded instances; there is no demand walk (the SB/W "structural
  subscription" text, §2F.4, is the fallback's wording). The reach gap,
  Q3.3, no-basis-rows, and the walk-node key are MOOT under (d′);
  everything else in the ruling set is a one-liner or already ruled
  (§5). **RULED 2026-08-18 — descriptive, the (d′) text adopted and
  LANDED in serving-loop.md §1 the same day (implementation W1); the
  whole ruling set is ACCEPTED (§5).**
- Run the refutation experiments FIRST (§6, W0): (d′)'s cheap
  experiment — expose the closure, delete the walk on a scratch branch,
  run the chat/lunch/note workloads: do the demanded derivations still
  land, does anything the walk kept live go dark, what is the settle
  (§2.8) — and the sink replacement that should flatten the client —
  before building either proper.

## 1. Reconciliation

*(Kept as the record of the lens pass. Under (d′) — §2, the owner's
direction of 2026-08-18 — items 1.1 #3 (structural versus value-only as
the walk's gate), D1 (which lever removes the walk term), D3 (why the
walk fires today), and D6 (what "structural" is) concern the FALLBACK
(§2F) only: (d′) has no walk and draws no such distinction. Everything
about (e), (α), the acceptance, and the comparator stands.)*

### 1.1 Where the three lenses agree (stated once)

1. **The spec forces neither cost.** SB: serving-loop.md §1:59–62 is a
   consequence clause of the ruling written in implementation
   vocabulary, not a MUST, and a normative reading contradicts the
   ruled per-node instancing (scopes.md §2); the spec never states when
   the walk re-runs; nothing requires the intent watch to be a
   scheduler effect or to read the sidecar beyond a dropped event's
   reason. W (Q4): scopes.md §2 names no walk; the §1 sentence is a
   description of stage B's mechanism (commit `755569f4a`) written into
   a normative section. C (Q1): no sentence requires a reactive effect,
   an entry traversal, or a scheduler node for the intent watch.
2. **Both redesigns are contained and OFF-invisible by construction.**
   W (Q2, Q7): (a)+(c′) live in `space-server.ts` and use existing tx
   primitives; the union-log fixes live in the `fanOut !== undefined`
   branch of `run.ts` / `fan-out.ts`, unreachable OFF
   (`serverRunDemandersFor` → `#serverRunDemanderResolver?.()`
   undefined, `runtime.ts:2007–2011`). C (Q7): the overlay exists only
   under `experimental.serverExecution === true && !servingPosture`
   (`runtime.ts:1897–1902`), `trackIntent` is reached only inside
   `cell.ts`'s flag-ON branch (`:1581–1586`). SB (S3): nothing
   normative to amend for (e); for (d) only serving-loop.md §1:57–62.
   Two generic-path items are kept OUT of this stage by all who
   noticed them (§2F.3, §3.3): the eager telemetry payload
   (`facade.ts:1773–1780`) and the proxy's read-before-cache order
   (W), and the zero-write CFC probe skip (C Q3).
3. **Structural versus value-only is the walk's right gate, and it must
   be evidence-from-reads.** SB (S6 #2, S4): re-run on structural
   change only, with "structural" defined from the walk's OWN logged
   reads (D11-safe; scopes.md §9's static-inference tripwire trips if
   the gate classifies commits by schema or code). W ((c′)): the gate
   is the read CLASS — three change kinds `determineTriggeredActions`
   already distinguishes from what was read.
4. **The intent watch is O(outstanding) by rights.** SB (S3): the
   outstanding set is already the overlay's `origin = intent(eventId)`
   entries (speculation.md §1), bounded by pending-intent count (§5);
   the retirement key is `consequenceOf`; the sidecar entry is read
   only for a dropped event's reason; a non-reactive listener at the
   replica-apply boundary suffices, woken by pushed derived commits and
   by origin acks (the ack-after-covering-watermark wake, speculation.md
   §6). C (Q1, Q2 contract): `#trackedIntents` is exactly that set;
   the listener triggers on any notification touching the sidecar; the
   watermark backstop and the origin-ack wake stay as they are.
5. **Counters, not logs, are the pins' evidence.** SB (S5): a `demand`
   block under `servingLoop` for the walk and a `commonfabric.*` debug
   surface for the client. W (T8) and C (pins 5–7) assert on counters.
6. **The honest bar is settle on the server.** W (Q5): beating OFF's
   4–42 ms client-local step is not credible; the bar is "sub-second
   and within a small constant of OFF". The owner's caveat (RULED,
   §5) makes server settle the metric.
7. **Refute cheaply before building.** W (Q9) and C (Q9) each name the
   condition under which "the term was elsewhere" and what to look at
   next.

### 1.2 Where they differ, and how each is resolved

- **D1 — which lever removes the walk term.** The attribution and the
  convener's brief framed the term as K×N duplication (one walk node
  per demand key, each fanned over every matching pair). W verified
  the duplication (item 2) but sized it: the win exists only for
  scoped keys; the demand-key mix (585–634 rows / 232–249 keys ≈ 2.5
  rows/key) puts (a) at ~15–20 % of walk NODES — not the main lever.
  The lever is (c′): today's walk is re-fired by value-only changes
  because of its read class. **Resolved by evidence:** (a) is kept as
  a pure dedup (no ruling), (c′) is the design.
- **D2 — "shared prefix / per-pair suffix".** The brief carried that
  framing; W's Q1 uses it descriptively (from the root down to the
  first scoped link every instance run reads the same addresses; the
  runs diverge at scoped addresses). SB corrected it: the split is not
  a clean prefix/suffix — space-scoped nodes are shareable wherever
  they occur (a user-scoped instance may link back into space docs),
  scoped instances are per-demander — so the walk must be modeled on
  the spec's per-node rule: one probe over any unnarrowed node, fork
  per demanding principal at a discovered space→user redirect (shared
  state at space, identical for all demanders), fork per demanding
  session of THAT principal below it (ragged; never assume a uniform
  suffix). W's (a) node keying and its "keep space/user/session
  distinct" note are the same rule seen from the code. **Resolved:**
  per-node instancing with ragged forks is the model; prefix/suffix
  only describes one instance run's read order; sharing the
  identity-independent prefix ACROSS instances within a pass is W's
  deferred (b)/(b′), an implementation freedom the amended spec
  sentence must not promise (§2F.4).
- **D3 — why the walk fires today.** The convener's reading: dirty
  computeds run because they are LIVE, not because the walk reads
  them. W refined it (item 6): true of the LOG (the walk's run is not
  what pulls; no path runs a computed synchronously from a
  query-result-proxy read), but false of the TRIGGER — `JSON.stringify`
  over the proxy issues a nonRecursive SHAPE read at every scalar leaf
  (`shallowEqual` compares an opaque leaf by value) and a RECURSIVE
  read of every array (`length`, iterator, array methods), so a
  value-only change re-runs the walk today. **Resolved:** the gate
  lives in the walk's read class, not in the trigger index (W's "why
  not a trigger-index gate").
- **D4 — where the client's consequence signal lives.** SB (spec
  only): the reconciliation key is `consequenceOf` metadata
  (mandated); the value plane holds `eventWatermark` and the drop
  notice; a per-entry `consequenced` mark is "in neither" and should
  not be a client dependency (S6 #6). C (code): the wire frame
  (`SessionSyncUpsert`, `memory/v2.ts:1042–1062`) carries
  `{branch,id,scope,scopeKey,seq,doc,deleted}` — NO commit metadata —
  so the SpaceServer-written entry mark (`["entries", i,
  "consequenced"]`, `space-server.ts:1171–1180`) is the ONLY
  client-visible consequence carrier today; putting `consequenceOf` on
  the wire (C's option (d)) is spec-literal but not smallest, touches
  protocol §3/§7, engine, memory server, session sync, and the client,
  and still cannot carry the drop notice (T7 rules it value-plane).
  **Resolved for the build; one ruling put (§5 item 6):** the listener
  reads the TRACKED entry's own fields (`status`, `consequenced`,
  `error`) — never history — and the owner is asked to SANCTION the
  tracked entry's mark as the value-plane carrier of `consequenceOf`
  (T7 semantics: written as the event's consequence, atomically with
  the derived commit, retiring with its entry at compaction; it passes
  events.md §4's FORBIDDEN test because it is not a processed-events
  table and retires with its entry) rather than amend the wire. SB's
  "not a client dependency" survives as "never a dependency on
  HISTORY, and always backstopped by `W ≥ seq(e)` /
  `eventWatermark ≥ seq(e)`".
- **D5 — how many CFC probes per sink fire.** The attribution said
  twice per commit; C (Q0 refinement A) found FOUR per scheduler
  re-run at `fb2292a24` — two cheap on `extraTx`, two expensive on the
  scheduler tx (the `deepTraverse` reads land on the SINK's tx via the
  `TransactionWrapper`, not on `extraTx`). The trio's T1 then memoized
  the negative verdict per transaction (halving it). **Resolved:** the
  count is a fact of the pre-trio tree; (e)'s redesign (a) removes the
  probes from the intent watch entirely (no tx); the residual generic double-probe
  question is the CFC owner's rider (§5).
- **D6 — what "structural" is.** SB: a write at a link- or
  redirect-bearing path in the walk's own last-run read set. W: the
  three change kinds the trigger machinery decides from the read class
  — (i) a container's own-key set / array length changed; (ii) the
  value at a LINK position changed (appear / retarget / vanish);
  (iii) reachability depth at a visited path changed (scalar ↔
  container, doc appear / vanish, scalar → link) — a strictly larger
  and more precise set (container membership and doc appearance are
  structural too). **Resolved:** W's enumeration is the definition;
  SB's "own logged reads" is its D11 framing; the harmonized sentence
  (§2F.4) carries both.
- **D7 — the comparator.** W (Q5): sub-second within a small constant
  of OFF; the OFF client-local step is not beatable on a two-user
  localhost chat. Owner (RULED): the OFF client-local number is not
  the comparator; server settle is. **Resolved by ruling:** the
  acceptance is server settle sub-second (§6), with the arrival series
  and the client-local speculation latency reported beside it.

### 1.3 The corrections each lens made to the others (and to the brief)

1. SB → the brief and W's framing: prefix/suffix → per-node instancing
   with ragged forks (D2).
2. W → the convener: liveness pulls, but the walk IS re-run by
   value-only changes because of its read class (D3); the gate is the
   read class.
3. W → the attribution: (a) alone is a minor lever; the register's
   accepted residual (ix) — "N × walk per changed root — the design's
   stated cost" — is precisely what (c′) removes for value-only
   changes (restate it when built, §5).
4. C → the convener: the reads land on the sink tx, not `extraTx`;
   four probes per run; the sink follows payload links TRANSITIVELY
   into other docs, so old event payloads keep their linked computeds
   live on the client — a DEMAND LEAK the attribution had not named;
   `stream: StreamLinkRef` is a plain object, so traces come only from
   payload links (the profile's `isPrefix` dominance implies this
   workload's payloads carry links); the client's append is
   TAIL-RELATIVE and an entry's index can move across
   pending → confirmed, so any `eventId → index` hint must be verified
   and fall back to a raw backward scan (a JS array walk, microseconds
   at E = 1 000 — not the disease).
5. C → SB: the wire carries no `consequenceOf` today (D4) — the
   value-plane mark question flips from "not a dependency" to
   "sanction the tracked entry's mark as the carrier".
6. SB → W: the trigger definition must be D11-safe; scopes.md §9's
   per-instance-watermark tripwire forbids per-pair "current through
   seq X" bookkeeping (use B7's clean bit); §8's lexical tripwires
   (`claim`, `candidate`, `settlement`, `rank`, `evidence`,
   `shadowRun` are not identifiers); and §8's positive liveness
   tripwire is DIRECTLY implicated — every transition the redesign
   introduces (pair arrival/departure, node install/cancel, structural
   re-walk) must be bracketed with `wasLive` →
   `notifyNodeLivenessChange` (or `setNodeProvisionalDemand`) and the
   `SCHEDULER_LIVENESS_EQUIVALENCE=1` hook must stay green; unbracketed
   is SILENT starvation. W's (c′) is D11-safe by construction; the
   bracketing is a build obligation W did not list.
7. SB → W: a write-nothing walk should record no basis rows (S6 #11);
   W did not address it — carried as a one-liner ruling.
8. W → SB: the amended sentence must not promise cross-instance prefix
   sharing (deferred (b)/(b′)); the harmonized text uses the ratchet's
   vocabulary (§2F.4).
9. C → the attribution's fix table (#5, "subscribe to the ENTRY or the
   tail"): per-entry sinks are REJECTED — the client does not know its
   index at fire time, the index can move, and a schema-less per-entry
   sink still deep-traverses that entry's payload links; the tail
   read is what (a)'s check does with a raw array walk, without a sink.

### 1.4 What survives the tuning trio

The lenses read `fb2292a24`, before the trio. The trio changed the
probe count (T1), added retirement on arrival and the late-echo rule
(T2), the honest deadline and mid-wave renew (T3), and the drain's
in-flight guard. None of those touch the walk's node keying or read
class, or the sink's O(history) shape; the re-benchmark at `b54bf5215`
shows both terms intact (`structureLoadTerminal` 377–441 per run;
per-post and per-note cost monotone across each series; Alice's client
action runs 2.7× OFF's). Appendix A gives the moved anchors.

## 2. (d′) Demand is the tracked-ids closure; the demand walk is DELETED

**Status: the PRIMARY design for (d) as of 2026-08-18. Adopted on the
owner's direction (§2.0), which supersedes §2F's structural walk; §2F
stays as the fallback (§2.9). Docs only; nothing built. Code citations
are the tuning tip's (`b54bf5215` — this branch's code; Appendix A
lists the offsets).**

### 2.0 The premise, verbatim (owner, 2026-08-18)

> "the client-side scheduler seems to work well without differentiating
> structural changes from just value changes … maybe what this is is the
> set of documents the client cares about and hence need to be updated,
> accumulated across all (highly overlapping) demands? but in that case
> we do need to care about the schema. if we ignore the schema we go
> down a ton of links we don't need to follow for narrow schemas — memory
> v2 has all that implemented fwiw, including tracking which documents
> the client is interested in. it doesn't unsubscribe in a fine-grained
> way as tracking that over overlapping subscriptions was difficult, and
> so i think this remains acceptable (and we can make it fine-grained in
> the future). so naively, i would have said since that establishes
> demand, we keep that list, for each document there see whether it is
> current via scheduler metadata and if not update it. that then creates
> new reads that trigger later updating (orthogonal to the client
> subscription list)."

Read against the code, the direction says four things, and each is a
fact the code already supports: (1) DEMAND is a set of documents — the
ones the client cares about — accumulated across overlapping watches,
and it must be SCHEMA-narrowed or it follows links nobody needs;
memory v2 already keeps exactly that set per session (§2.1). (2) The
set is COARSE on unsubscribe, and that is acceptable for now (RULED,
§5 R-D). (3) The loop's job is: for each demanded document, is it
CURRENT (scheduler metadata)? if not, update it (§2.2). (4) The
update's own reads create the next reads — propagation is the
scheduler's ordinary dependency graph, orthogonal to the subscription
list (§2.3) — so no structural-versus-value distinction is needed
anywhere: the client-side scheduler has none and works.

### 2.1 The demand set — what exists, verified

- **The memory server already holds the schema-narrowed closure per
  session.** `session.trackedIds` (`session-registry.ts:15`, a
  `Set<string>`) is the set of INSTANCE-keyed doc keys —
  `toDirtyKey(id, scopeKey)` = `` `${scopeKey}\0${id}` `` (`query.ts:877`)
  — of every entity the session's watches reach: built at
  `session.watch.set` from the full evaluation
  (`server.ts:3160`, `trackedIdsFromEntries(entities)` — `server-sync.ts:87`),
  extended at `session.watch.add` (`:3349`, every entity of the added
  graph or the extension), and grown on EVERY push pass
  (`syncSessionForConnection`, `:3617`): a dirty id that a session's
  tracker names makes `refreshTrackedGraph` (`query.ts:592`) re-evaluate
  the affected tracked docs under their selectors — the
  `SchemaObjectTraverser` follows only the links the selector's SCHEMA
  names (`loadFactsForDoc`, `query.ts:712`; a `schema: false` selector
  tracks the doc alone) — and every doc the re-traversal reaches (a new
  link target; an ABSENT target too — `trackVisitedDoc`,
  `traverse.ts:2242–2253`, tracks a followed link's target whether or
  not it exists, and `snapshotForDocKey` snapshots an absent doc as
  `document: null`) enters `session.entities` and `session.trackedIds`
  (`commitEntities`, `server.ts:3853–3858`; the full-evaluation branch
  replaces the set, `:3956–3960`). The tracker's own state
  (`TrackedGraphState`: a per-doc selector set + entities + a memo,
  `query.ts:50`) is per (session, branch); the closure is per SESSION
  and evaluated under THAT session's identity — a user-scoped doc is
  `user:<alice>\0X` in Alice's sessions and `user:<bob>\0X` in Bob's;
  a space doc is `space\0X` in every session that tracks it. It is
  "the set of documents the client cares about", accumulated across all
  its (highly overlapping) watches, schema-narrowed, per instance.
- **It is coarse on unsubscribe, exactly as the owner said.** The
  incremental push branch only ADDS (`:3856`); a session's set shrinks
  only on a FULL evaluation — `session.watch.set` (the runner never
  sends one to shrink; `storage/v2.ts:3844` only ever `watchAdd`s),
  `forceFullResync` (a delivery rollback), the lease-holder re-arm — or
  when the session closes. A retargeted link keeps its OLD target
  tracked until then; the tracker itself (`refreshTrackedGraph`) deletes
  and re-adds only the AFFECTED doc's own selectors (`query.ts:646–663`),
  never the docs that were reachable only through the old shape.
- **The serving loop today uses only the ROOTS of that closure and
  re-derives the rest itself, schema-LESS.** `watchedRootsForSpace`
  (`server.ts:4104`) returns each session's watch ROOTS with the
  demanding identity — one row per (root, scope, principal, session),
  the SpaceServer's own loopback session excluded by principal — and
  `#loadDemandedStructure` (`space-server.ts:2329`) keys them
  (`keyOf`, `:2347–2366`: `` `space\0<id>` `` / `` `<scopeKey>\0<id>` ``
  — the SAME vocabulary as `toDirtyKey`), reconciles `#demandersByKey`
  (`:437`; per key, the demanding pairs; the arrival re-arm on a new
  pair, `:2413–2429`, `:2600–2620`), structure-loads each root
  (`#attemptStructureLoad`, `ensurePieceRunningVerdict`), and installs
  the WALK per key (`#installDemandWalk`, `:2629`:
  `JSON.stringify(runtime.getCellFromLink(link).withTx(tx).get())` in a
  swallow-all try, an `isEffect: true` node) — the closure re-derived
  by reading every link and every scalar leaf under every root through
  the query-result proxies (§2F.1: ~7 read activities per property;
  value-only changes re-fire it; 67 K-read unions). The run supply
  (`runDemanderResolver` → `#demandersFor`, `:792`, `:1286`) reads
  `#demandersByKey`, never the walk.

**Definition — the demand set of a space:**

> Demand(space) = ⋃ over the space's live CLIENT sessions (every session
> whose principal is not the SpaceServer's service identity — the
> loopback session's watches are the serving graph's own reads, as
> `watchedRootsForSpace` already excludes) of `session.trackedIds`, each
> element carrying its session's demanding identity — rows
> `(id, scope, scopeKey, identity: {principal?, sessionId})`, one per
> (instance key, session); `root: true` on the rows that are watch
> ROOTS (the structure load's input, unchanged in scope — §2.8 flag 4).

**Exposure.** The memory server exposes it as the successor of
`watchedRootsForSpace` — `demandedInstancesForSpace(space, {
excludePrincipal })` — the roots PLUS the traversed closure, never
roots alone; the anonymous-session and unresolvable-scope rules carry
over (a session with no principal contributes keys but is not a
demander — `fanOutInstances` drops principal-less pairs,
`fan-out.ts:109`; a session that cannot resolve a scope owns no
instance of it — the tracker never keyed one for it). One more thing
the memory server must do, which it does not today:
`#notifyDemandChanged` (`server.ts:4240`) fires only from
`session.watch.set` / `.add` (`:3162`, `:3360`); under (d′) a push pass
that GROWS a session's tracked set (`commitEntities` /
`commitWatchState` adding keys) is a demand change too and must notify
— else a newly reachable derivation waits for the next input (§2.3, the
one-push-late note; §2.8 flag 2).

**The registry mapping.** The SpaceServer's demand-key registry keeps
its shape and semantics; its KEY SPACE widens from the roots to the
closure: `#demandersByKey` keyed by the instance key (the row's
`toDirtyKey(id, scopeKey)` — today's `keyOf` output, byte-identical
vocabulary) over every demanded instance, valued with the demanding
pairs (the sessions tracking that instance); `#pieceRootByDemandKey`
still maps a root demand that named an argument/derived doc to the
owning piece root the structure load resolved; `#demandersFor(pieceRootIds)`
(`:1286`) still answers "the pairs whose demand key names one of these
roots directly or resolved to one" — the fan-out B run supply's
contract (`instances(ratchet, demanders)`, serving-loop.md §3b) is
UNCHANGED: it consumes demanders, not the walk. Because roots ⊂
closure, every lookup that works today works verbatim; the closure's
non-root keys are additionally consulted by the currency check (§2.2)
and give `#demandersFor` a hit for a linked piece's own root doc when a
session's schema reaches it (an improvement over today's "watched roots
only" — §2.8 flag 5). Departed pairs retire per key as today; a key no
session tracks leaves the registry (the coarse boundary — R-D).
Registry cost: `#demandersFor` scans every key per action run (lens-d's
tuning item); with the closure as keys, index by root id in W1 —
tuning-class, now load-bearing.

### 2.2 The currency check, instead of walking

For each demanded row — an instance key `K = (id, scopeKey)` and a
demanding pair `P` — the loop asks "is K current for P?", and if not,
runs K's writer for P's instance. Precisely:

1. **The writers of K:** `writersByEntity.get(entityNameKey({ space, id,
   scope: scopeOfScopeKey(scopeKey) }))` — the scheduler's writer index,
   keyed by scope NAME (`scheduling-writes.ts:58`: the reader→writer
   relation is node-level topology; under C11b one node writes ALL
   instances of its declared surface). No writer ⇒ nothing to run: an
   authored doc (the client's own data), or a doc whose owning piece is
   not running on the server (§2.8 flag 4 — the structure load stays
   root-scoped, as today).
2. **Every writer of a demanded instance is a DEMAND ROOT** while any
   demanded row names one of its outputs (§2.4 — the liveness bracket).
3. **Current(W, K, P):**
   - W has a fan-out record (`record.fanOut`, `fan-out.ts:55`): its
     instance for P is `keyAtRatchet(fanOut, P)` (`fan-out.ts:187` —
     `space` while unnarrowed; `user:p` / `session:p:s` at the depth the
     ratchet holds for p) and it is CURRENT iff `fanOut.clean.has(key)`
     — B7: the instance ran at the ratchet and no cause has dirtied it
     since (`dirtyGen` guards a cause landing mid-run). A missing
     instance (never run at this ratchet for P — the arrival case) is
     not clean, so not current. Not current ⇒
     `markActionInvalid(W, undefined, { fanOutInstances: "keep" })` +
     `pending` — the shape `rearmNotCurrentFanOutForActor` already
     applies to the event actor (`facade.ts:952–978`: "current for the
     actor: her instance ran at the ratchet and no cause dirtied it"),
     applied to a demanding pair.
   - W has no fan-out record (a node acquires one only when the run
     supply hands it demanders — `fan-out.ts` header; so: never ran
     under the serving posture, or ran with no principal-bearing
     demander): current iff `!isInvalidOrNeverRan(record)`
     (`work-oracle.ts:80`).
     A dirty or never-ran node that is LIVE is already a runnable seed
     (`isRunnableSchedulingSeed` = dirty ∧ live ∧ not throttled,
     `work-oracle.ts:93`) — the check adds nothing; making it live is
     what step 2 does.
   - **"Current" means:** the writer's instance for P ran at W's ratchet
     and none of that run's recorded reads has changed since — in
     memory the clean bit (maintained by the trigger index on every
     change; `dirtyFanOutForCause`, `fan-out.ts:220`, dirties exactly
     the instances whose identity chain contains a keyed cause, every
     instance for a space cause); durably the basis rows (§3b: "output
     current iff these inputs unchanged since these seqs" —
     `selectStaleBasisInstances`, `scheduler-basis.ts:117`, is the SAME
     predicate evaluated at activation, §6 step 2, index-guided). The
     two agree by construction; no per-pair "current through seq X"
     bookkeeping is introduced (scopes.md §9's tripwire) — B7's bit is
     the only steady-state state, the basis index the only durable one.
4. **What runs:** the writer action, for P's instance, through the
   ordinary run supply — `instances(ratchet, demanders)` and
   `fanOutInstancesToRun` (= not clean, `fan-out.ts:250`); the
   discovery re-arm and the equality cutoff as always. The loop READS
   NOTHING: no traversal, no proxy, no transaction of its own.

**When the check runs.** At steady state, nothing scans: the trigger
index dirties instances as commits arrive (B7), dirty ∧ live seeds run
under `idle()`, W advances over them (protocol.md §4). The demand PASS
(the successor of `#loadDemandedStructure`, still single-flighted under
the wave's flush deadline, `space-server.ts:2778`) reconciles the
registry against the exposed rows — O(rows), map operations — and
applies steps 2–3 to the DELTA: (key, pair) rows that entered (mark the
writers roots; not-current-for-pair re-arm) and rows that left (release
the roots when their refcount hits zero). It runs on the input cycle
as today, on `demandChanged` (watch changes AND, new, push-time growth),
and on activation (where the basis scan re-marks the stale frontier
first, §6). The root-level arrival re-arm
(`invalidateActionsForDemandRoots`, `facade.ts:857` — every narrowed
node under an arrived pair's roots) is kept as is: a superset of the
per-key check for root arrivals, harmless, RULED semantics; the per-key
check is what serves the non-root growth the root-level re-arm cannot
see (a doc entering Alice's closure whose writer is already a root for
Bob's sake and clean node-level, but has no instance for Alice).

### 2.3 Propagation without a walk

- **Upstream.** A demanded writer's run logs its reads (the reactivity
  log; §3b) → edges to its inputs' writers → `propagateDemand` makes
  them live (`dependency-graph.ts`, #5569's incremental liveness) → the
  dirty ones among them are seeds and run under the pull order; the
  demanded writer re-runs one-run-late when their outputs change (§3b's
  soundness argument, unchanged).
- **Downstream.** Another demanded writer that reads this run's output
  is dirtied by the commit through the trigger index → runs. Nothing
  else: an undemanded reader stays dirty-unmaterialized (protocol.md
  §4).
- **Structure changes need no walk and no gate.** Two mechanisms that
  already exist carry them: (i) memory v2's tracker RE-TRAVERSES on push
  when a tracked doc's shape changes — the affected doc's selectors are
  re-evaluated (`refreshTrackedGraph`, `query.ts:646–663`), a new link's
  target enters the tracker and `trackedIds` (absent or not), and the
  new key reaches the demand pass through the (new) push-growth
  `demandChanged` → its writer becomes a demand root → runs → the doc
  lands → the tracker delivers it; (ii) a RUN that reads through a newly
  linked doc (a per-user `ifElse` branch, a derived list's new element)
  registers that read ITSELF in its log — the edge, and the liveness
  upstream, come from the run, as they do on the client. Array growth
  is (i) (the tracker's selector re-evaluation reaches the appended
  element's link) plus (ii) (the reader's own read); a doc APPEARING is
  the absent-tracked case (its writer was a demand root the whole time;
  the tracker delivers the landing). No structural-versus-value
  distinction is decided anywhere: the tracker follows what its
  selectors name; the trigger index dirties what changed; the loop
  marks writers of what is demanded. §1.2's D1/D3/D6 lose their subject.
- **The one-push-late property (FLAGGED, not filled — §2.8 flag 1).**
  Under the walk, a link a wave writes is traversed IN THE SAME PASS
  (the walk is an effect in the same scheduler; its structural re-fire
  reads the new target before `idle()`), so the newly reachable
  derivation lands in the SAME derived commit. Under (d′) the demand
  set grows only when the memory server's PUSH pass re-traverses the
  committed wave's frames — after the wave sealed W — so the newly
  reachable derivation is LATER demand and lands in the NEXT derived
  commit (protocol.md §4: "an instance that was NOT demanded when W
  advanced (a later arrival) is ordinary later demand"; the client sees
  the link, then the value — the client-side scheduler's own shape,
  which pulls after it sees). Spec-consistent; a settle-time term
  nonetheless, and today's `noteDemandChanged` adds `DEMAND_WAKE_GRACE_MS`
  = 300 ms (`space-server.ts:268`, sized for watch-set bursts at shell
  boot) before the cycle it latches — a push-produced delta from the
  loop's OWN wave is not a burst. W0 (§2.8 (c)) measures the extra
  cycle; if it matters, the fix shapes are a distinct no-grace wake for
  push-growth deltas and, further, a pre-seal closure refresh — neither
  designed here.

### 2.4 What still needs liveness — the demand-root bracket

Today the walk's READ LOG is what makes reachable computeds live:
edges from an effect root (`isEffect`) to every writer of every doc it
read. Under (d′) liveness must come from demand DIRECTLY:

- **A new `isDemandRoot` disjunct — `demandedWriters`.** Today
  `isDemandRoot` = `isEffect(action) || node.provisionalDemand ||
  materializerIndex.isMaterializer(action)` (`dependency-graph.ts:52–59`).
  The demanded writers need a STANDING root kind: a set on the liveness
  state, refcounted per demanded instance that names the writer. NOT
  `provisionalDemand`: it is pass-scoped and one-shot by design —
  `markNodeHasRun` clears it after the node runs (`facade.ts:2652–2666`,
  `provisionalDemandPass === undefined || passCounter > pass`) and
  `clearProvisionalDemandAtPassEnd` sweeps the pass's marks — a writer
  whose demand must hold across passes would starve after one run.
  Serving-loop.md §8's positive tripwire names exactly this case: "Any
  future demand-root kind (a new `isDemandRoot` disjunct) … MUST bracket
  the transition with the liveness notifications."
- **The bracket, exactly.** ENTER — a (K, P) row enters the registry
  and W is a writer of K: if W's refcount was 0, capture `wasLive =
  isLive(state, W)`, add W, then `notifyNodeLivenessChange(state, W,
  wasLive)` (`dependency-graph.ts:141`: for a node that was not live it
  recovers `liveRefs` from its readers, then `grantDemandFrom` propagates
  upstream through W's existing edges); refcount > 0 ⇒ nothing (already
  a root). LEAVE — the last demanded instance naming W leaves the
  registry: `wasLive`, remove W, `notifyNodeLivenessChange(W, wasLive)`
  (`withdrawDemandFrom` re-derives — a stale internal cycle ref can make
  a node look live, so root removal walks from the remaining roots).
  REGISTRATION — a writer that registers AFTER its output is demanded
  (a piece loading late) must consult the demanded set on registration
  (the `updateMaterializerRegistration` / `updateSchedulerActionType`
  shape: `wasLive` → flip → notify) so the root status is not missed;
  unregistration releases. Every transition bracketed; never a global
  rebuild; `SCHEDULER_LIVENESS_EQUIVALENCE=1` green across enter /
  leave / registration (pin T10′). An unbracketed flip is SILENT
  starvation (§8) — the risk this design carries in place of the walk's
  reach risks.
- **Leaving is coarse (RULED R-D).** A doc leaves demand only when no
  live session tracks it — a session's tracked set shrinks only on a
  full evaluation or close (§2.1) — so demand roots are released late,
  never early: a released-late root computes work no client will read
  (cost, bounded by the session's life), a released-early root would
  starve a demanded value (correctness). The owner accepts the former;
  fine-grained unsubscribe is a future item, and its seat is the memory
  server's tracker (per-doc refcounts across the session's selectors),
  not the loop.
- **Unchanged and still needed:** the event actor's transient demand
  and the dispatch preflight (`transientEventDemandersFor`,
  `rearmNotCurrentFanOutForActor` — they act on the actor and the
  demanders, not on the walk); effects and materializers as roots;
  `idle()`'s exclusion of undemanded work.

### 2.5 Per-instance correctness

- **Instance-keyed by construction.** `trackedIds` are
  `toDirtyKey(id, scopeKey)` evaluated under the session's OWN identity
  (the tracker's `EngineObjectManager` binds the session's principal and
  session id, `query.ts:100–103`, `:128–134`), so per-user demand is
  per-user with no re-resolution: Alice's session names
  `user:<alice>\0X`, Bob's `user:<bob>\0X`; two sessions of Alice name
  the same user instance twice (two pairs on one key — a node beneath
  may narrow to session for her: both are demanders); a space-scoped
  doc is ONE key (`space\0X`) with every tracking pair on it — the
  owner's "highly overlapping" property realized for free by the union
  (the walk paid K×N for the same overlap).
- **The vocabulary is already shared.** The registry key
  (`keyOf`), the dirty key (`toDirtyKey`), the query doc key's middle
  segment (`QueryDocKey`, `query.ts:48`), the notification address's
  `scopeKey`, the basis rows' `entity_scope_key`, and the fan-out
  instance keys (`fanOutInstances`) all speak scope-INSTANCE keys
  (key-vocabulary.md §2; scopes.md §7 M2/M4). Nothing translates.
- **The fan-out B semantics stand.** `instances(ratchet, demanders)`,
  the ratchet's three sources (run outcomes only — D11), the discovery
  re-arm (same wave), the arrival re-arm (root-level kept; per-key
  not-current-for-pair added, §2.2), B7's per-instance clean bit and
  union subscription, the ragged depth per principal (`keyAtRatchet`
  resolves P at whatever depth W holds for p), the event actor's
  transient demand — all act on demanders and instances, none on the
  walk. Per-instance keyed causes still dirty only that demander's
  instances (`dirtyFanOutForCause`); a space cause dirties all.
- **Anonymous sessions and the service session** as today: keys, no
  demanders; excluded, respectively.

### 2.6 The schema-narrowness win, stated

- **What the walk followed:** every link under every root, at every
  scalar leaf and every array — schema-LESS — ~7 read activities per
  property, ~20 K raw activities per instance, 67 155 reads in a
  3-instance union; 573 walk runs (27.5 s) + 263 resubscribes (17.7 s)
  per chat E2 = 96 % of event-wave settles of 2.6–3.6 s; the trigger set
  "any change anywhere under any reachable doc" (§2F.1). Its product was
  a subscription; it computed nothing.
- **What the tracker follows:** only the links the watch selectors'
  SCHEMAS name (`SchemaObjectTraverser`; `schema: false` follows none)
  — the closure the CLIENT will actually read, evaluated once per watch
  and incrementally per affected doc on push, and already paid for
  DELIVERY regardless of (d′) (the memory server does this traversal to
  know what to push; (d′) adds no traversal, no read, no transaction —
  it reads a set the server already maintains).
- **Under (d′):** ZERO walk runs, ZERO walk resubscribes, ZERO
  `demand-walk:*` nodes; the demand pass is O(rows) map reconciliation
  applied to deltas; per demanded writer, only its own run's log (paid
  today too). The union-log unions of 67 K reads disappear with the
  walk (§2.7).
- **The size of the demand set is not known — TO BE MEASURED IN W0.**
  Roots today: 585–634 rows / 232–249 keys (chat), 1 031–1 147 (note);
  the closure adds the schema-traversed targets per session; the union
  per space is what the pass reconciles. Instrument per-session
  `trackedIds.size`, the union per space, and their DRIFT over the n=20
  series (monotone growth is the coarse-unsubscribe cost showing;
  §2.8 flag 7). Expected: the same order as the roots (the runner
  `pull`s every doc it reads, so most reachable docs are roots already)
  — say so with numbers, not this sentence.
- **Cost per event wave expected:** derivations + wave commit + push,
  with no walk term — the settle floor §2F.7 could only approach with
  (b′). The structural-growth path pays one extra cycle (§2.3, flag 1).

### 2.7 What this deletes, and what it keeps

**Deletes:** `#installDemandWalk` and `#demandSinks` (the per-key
sinks; `space-server.ts:419`, `:2589–2592`, `:2629–2659`, the park /
close teardown at `:3294–3301`); the `demand-walk:*` scheduler effects,
their trace entries, and their `observationIdentity`; the walk's
per-instance union logs and resubscribes — Q3.1 / Q3.2 are MOOT (no
walk log to compact or union), Q3.3 MOOT as a ruling (the fanned-out
computeds' resubscribe stays a tuning-class follow-on if measured);
(a)'s node-key dedup (no node); the visited-set cycle guard; pins
T1–T11 as WALK pins (their scenarios return as (d′)'s pins, §2.8); the
`demand.walk*` counters (§2F.3); §5's rulings #2 (reach gap), #3
(Q3.3), #11 (no basis rows for the walk), #12 (walk-node key) — MOOT.
Also the "no basis rows for the walk" question: no walk, no rows.

**Keeps:** the demand-key registry (`#demandersByKey`,
`#pieceRootByDemandKey`, `#demandersFor`) as THE source of demanders —
now over the closure; the fan-out B run supply and B7 (whose clean bit
becomes the currency check's substrate); the ratchet; the discovery
and arrival re-arms; the event actor's transient demand and preflight;
the structure load per watch ROOT (`#attemptStructureLoad`, the OW19
terminal state, the commit-triggered re-arm — unchanged input; flag 4);
the basis index (activation's currency check — the same predicate);
the honest deadline, the wave, the commit classes, the push path;
`stats.demandArrivals`.

**Adds:** `demandedInstancesForSpace` and the push-growth
`demandChanged` (memory server); the `demandedWriters` root kind, its
bracketed enter / leave / registration transitions, and a facade
method to set it (scheduler); the currency check over registry deltas
(SpaceServer); the `demand` counter block, (d′) version (§6 W4).

### 2.8 Refutation / W0 for (d′)

**The cheap experiment (scratch branch, nothing pushed):** expose
`demandedInstancesForSpace` (+ the push-growth notify), add the
`demandedWriters` disjunct with its bracket, replace the walk with the
currency check over the registry, and run the chat / lunch / note
workloads with the attribution's per-wave instrumentation. Three
questions:

- **(a) Do the demanded derivations still land?** W advances, values
  correct — the acceptance pins from lens-d T1 / T2 / T3 / T7,
  re-targeted:
  - **T1′** a value-only change under a demanded doc → the downstream
    demanded computed's instances re-derive and W advances with ZERO
    walk runs — trivially, and structurally: no `demand-walk:*` node
    exists (T9′ below); the pin is the re-derive and the advance.
  - **T2′** a new link (or scalar → link) written by a wave → the newly
    reachable computed enters the demand set (the tracker's
    re-traversal; `demandChanged` fires) → its writer is a demand root →
    it lands — per demander (per-user: under each instance) — and the
    pin records IN HOW MANY CYCLES (the one-push-late measurement, (c)).
  - **T3′** array growth: an appended element carrying a link → its
    target enters the closure and lands (same shape as T2′).
  - **T7′** doc-appears: a computed's ABSENT output doc is in the demand
    set (the tracker tracks absent targets) → its writer is a demand
    root from the first pass → the doc lands and the tracker delivers
    it; no re-traversal by the loop.
  - **T4′** a per-user change re-runs only that demander's instances
    (B7 unchanged; trace `instanceKey`).
  - **T5′** the registry holds ONE key for a space doc tracked by N
    sessions, with N pairs; a user-scoped doc tracked by two principals
    is two keys (the K×N question is gone with the node).
  - **T9′** OFF-arm: no `demand-walk:*` node ever exists (structural:
    `#installDemandWalk` deleted); `demandedWriters` is empty off the
    serving posture (only the SpaceServer sets it); the OFF runner suite
    byte-identical.
  - **T10′** `SCHEDULER_LIVENESS_EQUIVALENCE=1` green across enter /
    leave / registration of demanded writers.
  - **P-demand-set** the registry equals ⋃ `trackedIds` over the client
    sessions minus the service session; **P-coarse** a departed
    session's rows leave and their writers' roots release; a doc
    tracked by two sessions stays while one remains; **P-arrival** a
    doc entering a second principal's closure whose writer is clean and
    narrowed re-arms for that principal only.
- **(b) Does anything the walk used to make live go DARK?** The
  refutation: a computed reachable only through a path the client's
  schema does NOT traverse, but that a demanded derivation NEEDS. Since
  derivation inputs are discovered by RUNNING (edges from the demanded
  writer's log, then upstream — §2.3), the candidate class narrows to:
  a writer no demanded writer reads and no client schema reaches —
  undemanded by definition (protocol.md §4) — so if W0 finds a value the
  client renders that stays stale, either the client's SCHEMA is wrong
  (it renders what it did not ask for) or the tracker's closure is the
  wrong demand set. Name it if found; that is the thing W0 must find.
  Two known non-holes to check off explicitly: absent targets (tracked;
  T7′) and per-user branches (edges from the branch's own run). One
  known parity gap to check off, not a hole: a linked piece not running
  on the server (flag 4) — the walk never started pieces either.
- **(c) Settle time.** Server settle per authored input (§6 W4's
  metric) with the walk gone, split into: the value-only path (should be
  derivations + commit + push, no walk term) and the structural-growth
  path (T2′/T3′: one extra cycle plus today's 300 ms grace — the number
  the owner needs to see against the sub-second bar).

**Flags — what in the code makes (d′) harder than the naive statement
(FLAGGED, not filled; each is a W0 measurement or a builder / owner
decision):**

1. **One-push-late structural growth (+ the grace).** §2.3: a newly
   reachable derivation lands one wave after the link that reaches it,
   and today's demand wake adds 300 ms. Measure (c); the fix shapes (a
   no-grace wake for push-growth deltas; a pre-seal closure refresh)
   are named, not designed.
2. **`demandChanged` on push growth is a NEW notify site.** Today it
   fires only on `watch.set` / `.add`; without the push-time notify,
   structural growth waits for the next input.
3. **A NEW `isDemandRoot` disjunct**, standing and refcounted — the
   pass-scoped `provisionalDemand` cannot carry it (§2.4); §8's bracket
   on every enter / leave / registration transition, T10′ as the guard.
4. **The structure load stays root-scoped.** The closure's non-root
   docs get no `ensurePieceRunning`; a piece reachable only through a
   DATA link (not a child the outer piece instantiated — Phase 7's
   `demandRootIds` covers those) has no registered writers on the
   server unless something starts it — parity with today (the walk's
   proxy reads never started pieces; `link-resolution.ts`'s only side
   effects are load kicks), but (d′) makes it VISIBLE: a demanded row
   whose doc carries `patternIdentity` meta and has no writer. An
   id-class-filtered extension (`#attemptStructureLoad` per such row)
   is an OPTION; W0 counts the rows.
5. **Demander resolution for linked pieces' writers.** `#demandersFor`
   matches keys by ROOT id; a session whose closure reaches piece P2's
   computed doc D but not P2's root doc supplies no demander to D's
   writer → the wave-level fallback (`undemandedNarrowingRuns`,
   scopes.md §2 — accepted and counted today). (d′) COULD union the pairs
   demanding a writer's OUTPUT docs into its demanders (within the ruled
   "the closure is the demand" semantics; a run-supply change) — an
   option; W0 reads `undemandedNarrowingRuns` before deciding; not
   minted as a ruling here.
6. **`#demandersFor` is a full key scan per action run** (twice per
   pass); with the closure as keys, index by root id (W1).
7. **Monotone growth of `trackedIds`** on the incremental push path (a
   retargeted link's old target stays demanded; §2.1) — the coarse
   ruling covers it; W0 measures the drift over the n=20 series so the
   cost is a number.
8. **The demand set is the SERVER's view of what it delivered**, not the
   client's cache: a doc the client's own runtime dropped is still
   demand until the session closes or fully re-evaluates — the same
   coarseness, stated so nobody expects the client's local unsubscribe
   to reach the loop.

### 2.9 Fallback

The structural walk — §2F, the former (d): (a) one walk node per
(scope-name, root id) + (c′) the read-class traversal, the union-log
fixes, pins T1–T11, the "structural subscription" spec sentence
(§2F.4) — is the fallback IF (d′)'s refutation finds a real hole:
§2.8 (b) names a value the client renders that goes dark and the schema
is right (the tracker's closure is then the wrong demand set), or (c)'s
one-push-late cost is ruled unacceptable and no wake fixes it. Demoted,
not deleted: nothing in §2F is built unless (d′) is refuted, and the
build's W1 carries it as the fallback branch (§6).

### 2.10 The serving-loop.md §1:57–62 replacement text — under (d′)

Replace, in serving-loop.md §1, from "so the demand registry keeps …"
through "… each run following THAT demander's redirects." (lines 57–62
on this branch) with:

```text
… so the demand registry keeps the demanding (user, session) pair on
every INSTANCE a client session TRACKS — memory v2's schema-narrowed
closure of that session's watches (the roots and every doc the
selectors' schemas reach, absent targets included), instance-keyed,
accumulated across its overlapping watches, space-scoped instances
included. Demand is that union over the space's client sessions; there
is no demand walk. The serving loop runs the STALE writers of demanded
instances — a writer whose instance for a demanding pair never ran at
its ratchet, or was dirtied since (§3b's per-instance clean bit; the
basis index is the same predicate at activation) — and those runs' own
logged reads make their inputs live and current in turn (§3b,
one-run-late); a demanded instance's writers hold demand (a demand
root, §8's liveness bracket) while any session tracks the instance and
release it when none does — a session's tracked set shrinks only on a
full re-evaluation or close (coarse, RULED 2026-08-18; fine-grained is
future). A derivation that becomes reachable through a wave's own write
becomes demand when the tracker's push-time re-traversal reaches it and
lands in a later derived commit (protocol.md §4's later demand); a
value-only change re-derives the demanded instances through the trigger
index alone. Nothing about structure versus value is decided anywhere.
```

The SB/W "structural subscription" text (§2F.4) is the FALLBACK's
wording, kept there. If the ruling lags the build, land the code with
the (d′) sentence DATED (pending ratification) — T2's late-echo
precedent (§2F.4's last paragraph). Restate the register's accepted
residual (ix) — "the walk re-fires per changed doc it read (an effect;
N × walk per changed root — the design's stated cost)" — to: *"there
is no walk; the demand pass reconciles the tracked-ids closure in
O(rows) on deltas; the structural-growth path lands one derived commit
later than the link that reaches it."*

**LANDED 2026-08-18 (RULED).** The owner accepted the ruling set the
same day, so the ruling did NOT lag the build and the DATED interim was
never needed: the text above now stands in serving-loop.md §1 in place
of lines 57–62 (§1:57–89 on this branch), verbatim, with a RULED marker
that quotes the demand-WALK sentence it replaced and says its
IMPLEMENTATION is W1 (register OW39 — the row W1 closes). The spec is
therefore AHEAD of the code at §1: at this tip the per-demander walk
still runs. For the same reason residual (ix) is NOT restated with the
acceptance — it describes the code at this tip and is still its cost —
its restatement rides W1 with the code (§6; the register's design-pass
delta says the same). If W0 refutes (d′) and the fallback is taken, the
§2F.4 text REPLACES a RULED sentence — a re-ruling, not a quiet swap.

## 2F. FALLBACK — (d) the structural walk (demoted 2026-08-18)

*Everything in §2F is the pre-direction design for (d), kept verbatim
as the fallback branch of §2.9. Its terms — "the walk", "structural",
"value-only", the pins T1–T11, the counters, the amended sentence — are
the FALLBACK's, not the design's. Nothing here is built unless (d′) is
refuted (§2.8 (b)/(c)); §5's rulings #2, #3, #11, #12 belong to it and
are MOOT while (d′) stands.*

### 2F.1 The mechanism today (`fb2292a24`; verified by W)

- `#loadDemandedStructure` (`space-server.ts:2202–2494`) installs one
  walk effect node per DEMAND KEY (`this.#demandSinks.set(key,
  this.#installDemandWalk(runtime, root))`, `:2462–2465`, inside the
  `for (const [key, root] of rootByKey)` loop `:2326`); `keyOf`
  (`:2220–2239`) yields `space\0<id>` for space roots and
  `<resolveScopeKey(scope, identity)>\0<id>` for scoped ones.
  `#installDemandWalk` (`:2502–2532`) reads
  `JSON.stringify(runtime.getCellFromLink(link).withTx(tx).get())` in a
  swallow-all try, registered `isEffect: true` with
  `observationIdentity.pieceRootId = root.id`.
- **K×N duplication.** `rootByKey` is per demand key (first row per
  key); every key gets its own sink; `#demandersFor` (`:1222–1253`)
  unions pairs across ALL keys matching the id — so `user:alice\0X` and
  `user:bob\0X` are two walk nodes with the identical link (scope
  NAME, not instance) each fanned over every matching pair; both
  narrow on their probe run (the first read is a `user`-scoped address
  → `recordReadScope("user")`), so each runs per principal: 2 nodes ×
  2–3 runs where 1 × 2–3 suffices; session-scoped roots 3 × 3.
- **Per pass:** instances run serially (`run.ts:585–604`), then ONE
  resubscribe with `fanOutUnionLog(fanOut)` (`:605–618`) if `ran ||
  fanOut.instances.size > 0`; each stored instance log is the RAW
  `txToReactivityLog(tx)` (`run.ts:810`, `fan-out.ts:320`), never
  compacted; the tx's read activities are never deduplicated
  (`v2-transaction.ts:1400–1413`); the union carries N copies of the
  space prefix, each ~5–10× redundant; `sortAndCompactPaths`
  collapses the space copies only.
- **Dirtiness:** a space-doc cause dirties every instance
  (`invalidation.ts:262–285`; `fan-out.ts:220–235`); a keyed cause
  dirties the instances whose identity chain contains the key.
- **Resubscribe cost:** O(union) — `registration.ts:238–319` →
  `setSchedulerDependencies` (sort/compact ×2) → `updateDependents`
  (eager telemetry payload) → `updateDependentEdgesForLog` →
  `applyActionReadDelta` (four `addressesToPathByEntity` calls, the two
  over the previous log answered from the grouping memoized on it);
  67 ms at 67 K reads.
- **Read anatomy per property ≈ 7 activities:** `getOwnPropertyDescriptor`
  and `get` traps each build a child view (sigil probe read at
  `[…child,"/","link@1"]`, a parent probe — journaled once per position
  and transaction, since link resolution memoizes each probe's outcome
  on the snapshot memo — a SHAPE read), a `toJSON`
  probe per object, `ownKeys`, one recursive whole-array read per
  array — with the cache check AFTER `resolveLink` and the SHAPE read
  (`query-result-proxy.ts:246–256, 351–359, 639–652, 731–790`). A
  few-thousand-property subtree yields ~20 K raw activities per
  instance, 67 K in a 3-instance union; the trigger set is effectively
  "any change anywhere under any reachable doc" — value-only changes
  fire the walk (D3).
- **What the walk is for:** it computes nothing and writes nothing;
  its product is its READ LOG — liveness edges to every writer of
  every doc it read (name-keyed writer index), its own re-trigger
  set, ratchet discovery (`getNarrowestReadScope`), and, as a side
  effect, instance-named load kicks for absent scoped docs.
- **Cycle handling:** throws at depth 100 and swallows, leaving a
  PARTIAL log (`space-server.ts:2515–2518`).
- **Numbers** (attribution, chat E2): `demand-walk:*` 573 runs, 27.5 s
  (avg 48 ms) + 263 resubscribes 17.7 s, union logs to 67 155 reads —
  96 % of event-wave settles of 2.6–3.6 s; 3 instances per walk;
  roots 585–634 (232–249 keys) chat, 1 031–1 147 note. Re-benchmark
  (trio tip): cross-user steps 2.6–10 s; `structureLoadTerminal`
  377–441 per run.

### 2F.2 What the spec requires (SB's minimal statement)

Binding: a watch is identity-bearing demand for the subscriber's own
instances (scopes.md §2, RULED 2026-08-16); demand is value-granular
pull that recomputes the value AND its upstream for the subscriber's
instances, nothing else (serving-loop.md §1); instances = discovered
scope × demanders under the per-node ratchet — a node runs ONCE, as a
PROBE, regardless of demander count while it has read nothing scoped;
once per demanding principal once user is discovered; once per
demanding session of that principal (ragged) — with the discovery
re-arm (same wave) and the arrival re-arm (that pair only) (scopes.md
§2; serving-loop.md §3b); demanded instances current before W advances,
undemanded stay dirty-unmaterialized (protocol.md §4); per-demander run
identity (scopes.md §5); B7/C11b — the node is singular, per-instance
last log and clean bit, the node's ONE subscription is the union of the
instance logs, a pass that skips clean instances keeps their reads
registered, an N-user space costs O(affected instances) per change;
COVERAGE is the operative concept elsewhere in the spec (speculation.md
§4 names "demand-walk coverage gaps" as what the arrival gate
backstops; run count and frequency are referenced nowhere); §8's
positive liveness tripwire (incremental maintenance, no global rebuild,
bracket every transition).

The mechanism sentence — serving-loop.md §1:59–62, "the demand WALK
(the live reader per demanded root that pulls the value's subtree) runs
once per demanding pair, each run following THAT demander's redirects" —
carries no MUST/NEVER, is introduced by "so … and" as a consequence of
the ruling, uses implementation vocabulary, and read normatively
contradicts the per-node probe rule (a per-pair walk over unnarrowed
space structure is the one thing that would not follow it). Its
load-bearing residue is "each run following THAT demander's redirects".

**The minimal thing the walk must establish:** that every node
reachable from a demanded root — for each demander's OWN instances
(space nodes once; scoped nodes per demander per the ratchet) — is
LIVE, i.e., recomputed when dirty before `idle()`/W, following each
demander's own redirects, with late arrivals re-armed for that pair
only and the event actor's transient demand honored (scopes.md §2).
Nothing more. The spec never states when the walk re-runs; §3b's
one-run-late argument transfers to it (the reachable set can only gain
a node through a change in something already read), and B7 sanctions a
registration that persists across passes without re-running.

Tripwires a redesign must respect (SB S4): scopes.md §9's
static-inference item — "structural" must be evidence from the walk's
own logged reads, never schema or code; §9's per-instance-watermark
item — no per-pair "current through seq X" bookkeeping, B7's clean bit
only; §8's lexical list; §8's liveness bracketing (DIRECTLY
implicated). Also: a per-change full re-walk is the "global rebuild"
posture §8 disfavors in spirit — the redesign moves TOWARD the tripwire.

### 2F.3 The redesign — (a) + (c′), precisely

**(a) One walk node per (scope-name, root id).** Key `#demandSinks` by
`${root.scope ?? "space"}\0${id}` with a refcount over the demand keys
that name it (install on the first, cancel on the last), keeping
`#demandersByKey` / `#pieceRootByDemandKey` / `#demandersFor` per demand
key exactly as today (arrivals, retirement, the pair union unchanged).
Node count per root id becomes the number of DISTINCT DEMANDED SCOPE
NAMES of that id (≤ 3), independent of demander count. Keep space, user,
and session distinct: a `user`-scoped demand names the user instance
doc, which can exist without a space→user redirect (the register's
"legacy plain values"), so a single space-link walk would not reach it.
Nothing is lost — today's K nodes already fan over the identical union.
Pure dedup; the only choice is the key (R5, §5).

**(c′) The structural walk — the gate is the read CLASS, not the
trigger index.** A purpose-built traversal replaces
`JSON.stringify(cell.get())`. Per traversed doc instance it issues:

- at the root: the probe and, if the root is a link, the whole read
  `resolveLink` issues (hop semantics, redirect following, the ratchet,
  sync kicks — all kept);
- ONE nonRecursive read per container path
  (`readValueOrThrow(container, { nonRecursive: true })`) — the frozen
  subtree value is in hand and children are inspected in memory;
- ONE recursive PROBE path per leaf, `[…leaf, "/", "link@1"]`,
  registered in a batch with `trackReadPaths`
  (`extended-storage-transaction.ts:1708–1728` →
  `v2-transaction.ts:1471–1517`; no load, no freeze);
- at a found link: the recursive whole read `resolveLink` issues
  (`link-resolution.ts:261–263, :299`) — link appear / retarget /
  vanish is what `shallowEqual`'s link arm compares;
- NEVER a read at a scalar leaf's own path; NEVER a recursive read of
  an array;
- a per-run visited set of `(space, scopeKey, id, path)` so link cycles
  terminate cleanly (replaces the depth-100 throw-and-swallow and its
  partial log).

Link recognition is what the code already uses (`linkPayloadAtProbe` /
`linkProbeSubPath`, `parseLink`, the redirect marker
`overwrite: "redirect"`).

By construction — the three change kinds `determineTriggeredActions`
(`reactive-dependencies.ts:115–249`) already decides from the read
class, with no new generic code:

- (i) a container's own-key set / array length changed — the
  nonRecursive read AT the container path (`shallowEqual` compares
  plain containers by key set, arrays also by length);
- (ii) the value at a LINK position changed — the recursive whole read
  at the link (`shallowEqual`'s link arm);
- (iii) reachability depth at a visited path changed (scalar ↔
  container, doc appear / vanish, scalar → link) — the recursive sigil
  probe (`beforeCanReach` / `afterCanReach` / `lastObject`).

Value-only changes do not fire the walk. A new / retargeted / removed
link, a member added or removed (arrays: growth / shrink), a reachable
doc appearing or vanishing, a scalar becoming a container all do.
Per-instance keyed causes still dirty only that demander (B7); the
ratchet still moves (scoped reads happen); liveness is preserved
because every visited path carries a recursive probe (overlaps any
writer surface at or above it — `arraysOverlap` prefix,
`scheduling-writes.ts:168–185`) and every container carries a shallow
read (overlaps a writer at the container or its direct child,
`nonRecursiveReadMayOverlapWrite`). Cost per property drops from ~7
reads + 2 `resolveLink`s + proxy machinery to ~1 activity; logs shrink
~5–7×.

**Unchanged pre-existing gap (R3):** a writer whose declared surface
lies two or more levels below the deepest visited container of an
existing doc is not pulled live by the walk — identical to today's
`JSON.stringify` walk (its `toJSON` / parent probes have the same
reach); one-run-late soundness (§3b) covers it once anything writes
there. Not introduced by (c′); the owner is asked to accept it as
unchanged (§5).

**D11-safety:** "structural" is never inferred from schema or code; it
is what the walk's OWN logged reads (the read classes above) make the
trigger machinery decide. **Liveness bracketing (§8):** every transition
— pair arrival / departure, node install / cancel, structural re-walk —
is bracketed (`wasLive` → `notifyNodeLivenessChange`, or
`setNodeProvisionalDemand`); the equivalence hook stays green.
**Lexical:** no `candidate demanders`, no `rank the smallest pair` (the
spec says "smallest").

**Why not a trigger-index gate:** it would be a generic-path change
(`trigger-index.ts` / `invalidation.ts`, OFF-visible), need a per-action
opt-in, and re-derive from `change.before/after` what
`determineTriggeredActions` already decides from the read class. **Why
not an ambient read-meta trick on the existing proxy walk:** leaf vs
container is only known after the read, the proxy's array `length`
recursive reads would remain, and `query-result-proxy.ts` is generic.

**The union-log fixes (W Q3), all ON-only** (fan-out state exists only
when `serverRunDemandersFor` returns principals):

- **Q3.1** compact each instance log ONCE at record time
  (`fanOutRunFinished`, `fan-out.ts:320`: store
  `sortAndCompactPaths(reads)` / `(shallowReads, false)`); compaction is
  a prefix-minimal closure, so `compact(compact(A) ∪ compact(B)) =
  compact(A ∪ B)`; removes the intra-instance ×5–10 redundancy (with
  (c′) the raw log is nearly minimal anyway).
- **Q3.2** resubscribe only if `ran || pruned` (`run.ts:605`; make
  `pruneFanOutInstances` return whether it removed anything — departed
  instances' reads must still leave the union). Today "keep"-style
  re-arms (arrival re-arm, actor preflight) that find nothing to run
  still pay a full resubscribe.
- **Q3.3 (optional; R4)** keep the previous compacted log per instance
  and skip the resubscribe when every ran instance's compacted log
  equals its previous one and nothing was pruned — sound because writer
  arrivals / departures are already edged at THEIR registration /
  unsubscription; touches C11b's one-subscription bookkeeping for
  fanned-out COMPUTEDS too → ruling (§5); verify with
  `SCHEDULER_LIVENESS_EQUIVALENCE=1`.
- **Q3.4 (generic, OFF-visible)** telemetry payload laziness
  (`facade.ts:1773–1780`) — OUT of this stage; land separately with the
  OFF suite as the gate, if at all.

The #5569-style incremental liveness already covers the EDGE side; the
remaining O(union) is the log → index projection, and (c′) + Q3.1 +
Q3.2 shrink its input ~10×, which is enough.

**Deferrals:** (b) share the space prefix across instances within a
pass — sound (the prefix is identity-independent) but needs cross-run
state inside the action and log synthesis; after (c′) it only halves
the residual structural re-walk; the natural follow-on is (b′) the
INCREMENTAL structural walk (re-traverse only from the run's causes,
`tx.getCfcState().triggerReads`, and re-register the untouched
remainder from a per-instance structural cache via `trackReadPaths`)
— reach for it only if the settle floor needs it (§2F.7). (d) probe walk
+ per-slot narrowed walks — dynamic per-slot effect nodes with their own
lifecycle; not smallest. (e) a replica-/scheduler-maintained link
closure — a new subsystem duplicating the reactivity log + trigger
index, and it changes the D11 "discovery by running" posture; too big
for this stage.

**Counters (serving-loop.md §7 — "implement with the loop, not after";
"tests MUST assert on counters, not logs").** None of §7's counters can
see the (d) term today. Add a `demand` block under `servingLoop`:
`roots`, `pairs`, `walkRuns` (total), `walkProbeRuns` (unnarrowed),
`walkForkRuns` (per principal / per session), `walkStructuralTriggers`,
`walkArrivalRearms`, `walkDiscoveryRearms`, `actorPreflightRearms`,
`registeredReads` (union-subscription gauge, current / max), and — if
cheap to observe at the feed hook — `walkValueOnlySkipped` (commits
under a walked root's registered doc set that caused no walk run; the
gate's witness). If the skip counter is not cheap, T1's pin (zero new
`demand-walk:` trace entries on a value-only change) plus `walkRuns`
per wave is the witness; the builder decides and says which. Also fold
into §7's LIST the two counters the code already emits and the list
omits (`undemandedNarrowingRuns`, `earlyEmitRefusals` — both appear in
the re-benchmark's stats table) — a doc drift fix.

### 2F.4 The amended serving-loop.md §1:57–62 — ONE item to rule

Replace, in serving-loop.md §1, from "so the demand registry keeps …"
through "… each run following THAT demander's redirects." (lines 57–62
on this branch) with the following text — SB's proposed sentence
harmonized with W's Q4 wording (the ratchet's own instancing
vocabulary so nothing is promised that the build does not deliver;
W's enumeration of what is structural; SB's coverage requirement, D11
framing, incremental registration, and counting; both lenses'
"computes and writes nothing" and "each run following THAT demander's
redirects"):

```text
… so the demand registry keeps the demanding (user, session) pair on
every root a client watches, space-scoped roots included, and the demand
WALK — the live reader per demanded root whose STANDING SUBSCRIPTION
(its last run's structural read set: container shapes, link positions,
per-path link probes) holds the value's reachable subtree live for its
demanders — is instanced like any node (scopes.md §2's ratchet: ONE
probe run while its reads are unnarrowed, regardless of demander count;
once per demanding principal after a user narrowing is discovered; once
per demanding session of that principal below it, ragged), each run
following THAT demander's redirects. What the walk MUST establish is
COVERAGE: every node reachable from the root, for each demander's own
instances, is live — recomputed when dirty before W advances
(protocol.md §4). It runs on first demand and again on STRUCTURAL
change only — a link appearing, retargeting, or vanishing at a path it
visited; a visited container gaining or losing members; a reachable doc
appearing or vanishing; a narrowing discovered beneath it (the
discovery re-arm); a demanding pair's arrival (the arrival re-arm, that
pair's instances only) — where "structural" is decided from the walk's
OWN logged reads (D11), never from schema or code; a value-only change
beneath a walked root reaches the affected nodes through their own
subscriptions (§3b, B7) without a walk run. The walk computes and
writes nothing; its registration is maintained incrementally and never
rebuilt (§8's liveness tripwire); its runs, skips, and re-arms are
counted (§7).
```

Optionally append to B7 (serving-loop.md §3b): *"(A STRUCTURAL change
in a space doc dirties every instance of the walk over it — one
re-traversal per demanding instance; a value-only change dirties none.
The walk over unnarrowed structure has ONE instance by §1.)"*

And restate the register's accepted residual (ix) — "the walk re-fires
per changed doc it read (an effect; N × walk per changed root — the
design's stated cost)" — to: *"the walk re-fires per STRUCTURAL change
under a root it read (its demanding instances re-traverse); value-only
changes do not fire it."*

If the ruling lags the build, land the code with the amended sentence
DATED (pending ratification), never silently — the precedent is T2's
late-echo rule (landed DATED 2026-08-18, ratified the same day).

### 2F.5 Pins T1–T9, red-first, each with the mutation that kills it

- **T1** — a value-only change under a walked root → the downstream
  computed's instances re-derive and W advances with ZERO new
  `demand-walk:` trace entries. Kills M1 (revert to
  `JSON.stringify(cell.get())` — leaf / array reads → walk runs) and M2
  (walk logs no container / probe reads — computed never live → no
  re-derive).
- **T2** — a new link (or scalar → link) at a visited path IS walked;
  the linked subtree becomes live for each demander (per-user: under
  each instance). Kills M3 (drop leaf probes) and M4 (drop the whole
  read at link positions — retarget missed).
- **T3** — array growth is structural: an appended element carrying a
  link becomes live. Kills M5 (skip container SHAPE reads for arrays).
- **T4** — a per-user structural change re-walks only that demander's
  instance(s) (trace `instanceKey`). Kills M6 (log scoped reads without
  `scopeKey` / dirty all).
- **T5** — walk node count per (scope-name, id) = 1 with two principals
  watching a user-scoped root; walk runs per pass = N, not K×N. Kills
  M7 (per-demand-key sinks).
- **T6** — union coverage after a skipped / partial pass: after a pass
  that ran only Bob (or nothing), a change under Alice's instance-only
  path still dirties the walk; after a prune with no run, the departed
  instance's reads leave. Kills M8 (skip the resubscribe
  unconditionally when `!ran`) and M8′ (drop per-instance log
  retention).
- **T7** — doc-appears: a computed's absent output doc is live via the
  walk's absent read; when it lands the walk re-runs once and traverses
  it. Kills M9 (don't log absent-doc reads).
- **T8** — resubscribe telemetry (`scheduler.dependencies.update`)
  performed iff ran or pruned. Kills: guard removed.
- **T9** — OFF-arm: no `demand-walk:` node ever exists off the serving
  posture (structural: `#installDemandWalk` is SpaceServer-private;
  `installSealDestination` throws OFF, `runtime.ts:1953–1959`); the OFF
  runner suite byte-identical.
- Add: **T10** — the liveness equivalence hook
  (`SCHEDULER_LIVENESS_EQUIVALENCE=1`) green across arrival, departure,
  install / cancel, and structural re-walk (SB's §8 obligation);
  **T11** — a link CYCLE terminates with a complete log (visited set;
  today's partial log is the mutation).
- Note: `executor-fan-out.test.ts:731–734`'s comment ("her walk
  instance … must observe her draft") becomes a stale mechanism claim
  (the draft is value-only); the assertion stays green (both keys
  appear at the flag flip, which is structural for Alice's `view`
  link and re-derives Bob's instance in the same pass) — reword the
  comment.

### 2F.6 OFF-arm statement

None by construction: (a) and (c′) live in `space-server.ts` and use
existing tx primitives (`resolveLink`, `readValueOrThrow`,
`trackReadPaths`, `tx.read`); the trigger machinery is unchanged;
Q3.1–Q3.3 live in `fan-out.ts` and the `fanOut !== undefined` branch of
`run.ts`, unreachable OFF. Two generic-path, OFF-visible items are kept
OUT (Q3.4 telemetry laziness; the proxy's read-before-cache order and
`toJSON` probe) — behavior-preserving, but their gate is the OFF suite
in their own change. Witness: T9 + the OFF runner suite byte-identical
+ the OFF store's commit table unchanged on the benchmark workloads.

### 2F.7 Expected cost after the redesign, and the reasoning

W's estimate (chat: 8 events, 3 instances, ~240 keys; anchors from the
attribution — ~30 walk nodes fire per event wave, ~72 runs @ ~48 ms,
~33 resubscribes @ ~67 ms — walks + resubscribes = 96 % of a 2.6–3.6 s
settle): after (a), −15–20 % nodes (scoped-key dedup; ~0 if the keys
were all space keys — check the scope mix first). After (c′), a message
append is STRUCTURAL for every root whose subtree contains a container
that grew (the messages array, derived / filtered arrays, the rendered
VDOM list) and NOT for value-only outputs (counts, per-user drafts,
edited text): 5–10 firing nodes × ~2.4 instances ≈ 12–24 runs at
3–10 ms (≈ 1 activity per property, no proxies) ≈ 40–240 ms;
resubscribes 5–10 × 10–20 ms (logs 5–7× smaller, per-instance
compaction) ≈ 50–200 ms; ≈ 0.1–0.45 s per event wave vs ~2.5–3.5 s.
Cross-user step 2.4–7 s → ~0.3–0.8 s (settle + the non-walk
~0.1–0.15 s + push + client apply): sub-second at the median,
plausible; the tail depends on what else drove the 7 s events
(exhausted waves cascading). ON floor: the 100 ms deadline is a CAP not
a wait (`#waveCycle` breaks as soon as `isIdle()`), so the floor ≈
append RTT + drain / handler / derivations + commit + push + apply ≈
tens of ms on localhost for a value-only step. Reaching that floor
needs the walk fully off the append path ((b′) incremental) AND wave
commit + push cheaper than a client-local recompute — on a two-user
localhost chat not credible; the honest bar is what the owner ruled:
settle on the server, sub-second, with the client-local speculative
render preserved (§6).

### 2F.8 What would refute (d)

- After (a) + (c′), walk runs per event wave fall to ≈ (#roots whose
  subtree grew) × N and the settle stays ~2.6 s → the term was
  elsewhere (wave commit / frames / `server.idle()`, derivation
  fan-out, the structure-load pass) and the 96 % attribution is wrong.
- T1 fails — a value-only change under a walked root leaves the
  downstream computed stale or W stalls → something in liveness or
  loading depends on the walk's RUN (the `isRunnableSchedulingSeed` /
  `liveRefs` reading, or an instance-load kick only the walk performs);
  the structural gate is unsound and the fallback is "one recursive
  read at `[]` per traversed doc" (a trivially sound superset, tiny
  logs, still re-fires on values but ~10× cheaper per run and
  resubscribe).
- The per-run ms does not drop with the structural traversal → the cost
  is in the tx read layer per activity (`readAttestation` / freeze /
  validate), not the proxy — attack via `trackReadPaths` batching / the
  storage layer.
- The demand-key scope mix is all-space → (a) is inert (expected: rows /
  keys ≈ 2.5 says it is not).

## 3. (e) The intent listener

### 3.1 The mechanism today (`fb2292a24`; verified by C)

- `trackIntent` (`speculation/overlay-destination.ts:586–642`) builds
  `getCellFromLink({ space, id: sidecarId, scope: "space", path: [] })`
  with NO schema and installs one `cell.sink` per `${space}\0${sidecarId}`;
  `#scanIntentNotices` (`:730–781`) iterates EVERY `value.entries`
  element and acts only on tracked ids — arm order `status === "dropped"`
  then `consequenced === true`; `#untrackIntent` (`:783–806`) cancels
  the sink when the set empties. Installed from `cell.ts:1580–1644`
  (`overlay?.trackIntent(...)` precedes `replica.enqueueEventAppend`,
  inside the flag-ON, non-serving, unstamped-tx branch) — the sink's
  immediate run executes on the click's SYNCHRONOUS path.
- `sink` → `subscribeToReferencedDocs` (`cell.ts:3503–3559`): a
  scheduler EFFECT node (`isEffect: true`) that runs once immediately
  and on every sidecar change; each run mints two `runtime.edit()` txs
  (`extraTx` and the sink tx); schema-less → `needsTraversal` → a query
  proxy whose `deepTraverse` touches every property of every entry AND
  follows payload links TRANSITIVELY into other docs (`get` trap →
  `createViewProxy` → `resolveLink`), recording O(E) reads + O(E)
  dereference traces on the SINK tx (the `TransactionWrapper` forwards
  reads to the wrapped tx; `extraTx` is consulted only when minting
  child cells, which the schema-less path never does); then
  `prepareTxForCommit` + `commit` on both txs → FOUR
  `flowLabelWorkExists` probes per run. Each `forEachFlowObservation`
  classifies reads from their metadata: a link-resolution probe consumes
  reference confidentiality as `followRef`, and content reads consume the
  target's labels. Trace membership does not exempt either read. Measure the
  observation walk and label lookup separately; trace count alone does not
  establish their cost.
- **The demand leak (C Q4):** the sink's dependency log = every sidecar
  path touched PLUS every path of every payload-linked doc it walked
  into; as an effect its dependencies are DEMAND — an old event payload
  linking a computed's output keeps that computed live on the client.
  It fires on EVERY sidecar change (append, `seq` / `firedAt` stamping,
  `consequenced` mark, `eventWatermark`, other clients' entries on a
  shared stream) and on any change to any linked doc.
- **The wire:** `SessionSyncUpsert` carries `{branch, id, scope,
  scopeKey, seq, doc, deleted}` — no `consequenceOf`, and `doc` is the
  WHOLE `EntityDocument`; the entry marks are SpaceServer-written by
  index path (`space-server.ts:1171–1180`; error / status / reason at
  `:2063–2072`); compaction is allowed at-or-below `eventWatermark`
  (events.md §4) and unbuilt (register OW24).
- **Numbers** (attribution): the ON client's `scheduler/run` per note
  0.6 → 15.5 s while OFF's stays ~80 ms; note-10 worker 100 % busy,
  `flowLabelWorkExists` 65 %; 13× the `sink:<space>/of:stream-events:…`
  effect at ~99 ms per note. Re-benchmark (post-T1): per-note cost
  still monotone 1 → 13 s; per-post chat cost 5 → 14 s; Alice's action
  runs 2.7× OFF's.

### 3.2 What the spec requires

Speculation.md §4 step 2: on each pushed `derived` commit with
`derivedThrough = W` and `consequenceOf = [E…]`, retire overlay entries
whose `origin` is `intent(e)` for `e ∈ E` — the consequences (or, for a
dropped event, its notice — events.md §5) now exist. Step 4 (re-run
un-consequenced intents against fresh store state) is assigned to
reconciliation on each push, not to any watch. §5: overlay memory is
bounded by pending-intent count. Events.md §5: a dropped event's client
MUST be signaled; T7 — the notice `{ status: "dropped", reason }` is a
FIELD ON THE STREAM DOC'S OWN ENTRY, written as that event's
consequence, advancing `eventWatermark` past it, retiring with its entry
at compaction; a handler error surfaces as the derived commit for that
event. `consequenceOf` is mandated and complete (events.md §4;
protocol.md §7; serving-loop.md §3). Not required by any sentence (SB,
grep-checked): a reactive scheduler effect; reading the entries'
payloads; reading the whole sidecar; a per-fire CFC label probe (a
CONSEQUENCE of making the watch a run); a per-entry `consequenced`
mark. Events.md §4 FORBIDS a processed-events table, per-event acks
from clients, handler-run provenance records — the client's outstanding
set is the PENDING set (bounded, drains to zero, process-local, never
persisted, never sent), not a processed-events table.

Minimal state: the outstanding eventId set = the overlay's
`origin = intent(eventId)` entries — no separate state. Minimal signal
per pushed derived commit: `consequenceOf ∩ outstanding`; O(1)
backstops that are also spec facts: `eventWatermark ≥ seq(e)` on the
stream doc and `W ≥ seq(e)`; only the DROP REASON requires reading a
value-plane entry — the tracked event's own, by eventId. Outstanding
intents are by definition above `eventWatermark` and therefore above
the compaction line: a tracked-entry watch never reads compactable
data. A non-reactive listener must also wake on origin acks
(speculation.md §6's recorded pending-forever bug) — the existing
watermark backstop and origin-ack wake stay.

The reconciled carrier (D4): the wire carries no `consequenceOf`, so
the client keys on the TRACKED entry's own value-plane fields, which
the owner is asked to sanction as the carrier (§5); the spec gains one
clarifying sentence in §4 step 2 (SB): *"the match is on the pushed
commit's `consequenceOf` — carried to the client as the tracked entry's
own `consequenced` / `status` / `error` fields (T7 semantics); the
entry is read only for the tracked event, and for a dropped event's
reason."*

### 3.3 The redesign — (a), with the seven-point contract; interim (b)

*LANDED 2026-08-19 (W2, `claude/server-exec-v2-w2-intent-listener`):
(a) as specified below — `overlay-destination.ts` `trackIntent` /
`#checkIntents` over `speculation/doc-notification-listener.ts`; the
interim (b) did NOT ship (item 16 — W0's gate arm only); the effects
channel followed (item 13); pins 1–11 in
`speculation-intent-listener.test.ts`. The anchors in §3.1 and Appendix
A describe the pre-W2 code. Report:
`docs/history/plans/server-execution-v2/stage-c/w2-intent-build-report.md`.
W2.1 (2026-08-19, same branch): W3's root cause of W0 l3 — the CLIENT
cascade-echo stranding (a cascade child's echo under a client-minted id
no mark names, writing a frame-caused entity doc the arrival gate never
sees) — fixed as shape (a): `retireIntent(P)` also retires P's client
cascade descendants (speculation.md §4 step 2's dated clarification);
shape (b), deterministic cascade ids on both sides, is the owner-level
alternative (register, W2 block). FLAGGED there, blocker-class for the
lift configuration: on W2.1 + (α) the lunch gate's swatch step stalls
in ~5 of 13 runs (bisected to W2.1 by W3-alone and W2-on-W3 baselines
green under higher load) — the confirmed own vote not rendering after
its echo's retirement; not root-caused. Report:
`docs/history/plans/server-execution-v2/stage-c/w2-1-cascade-echo-report.md`.*

**(a) A non-reactive storage-notification listener** — feasible,
smallest sound. Substrates (C Q2): `IStorageManager.subscribe(
IStorageNotification)` (`storage/interface.ts:116, 512–562`), the same
relay the scheduler consumes; notifications carry `IMergedChanges` with
LEAF-granular paths from the differential (a consequenced mark yields
`["value","entries","<i>","consequenced"]`, an append
`["value","entries"]`) and whole-doc `before` / `after`; fired for
commit / integrate / pull / load / revert; the differential is always
computed because the scheduler is always subscribed. Alternative:
`SpaceReplica.sinkDocument(uri, cb)` (`v2.ts:2616–2635`), a per-doc raw
callback keyed `docKey(uri, "space")`, exposed on the concrete
`Provider.sink` but NOT on `IStorageProvider` / `ISpaceReplica` — using
it needs an optional interface member (the `speculationRetirementView?`
precedent). Raw read without a tx: `ISpaceReplica.getDocument(id,
scope)`. Keeping the doc watched: `storageManager.open(space).sync(
sidecarId, { path: [], schema: false }, "space")` — the selector
`syncCell` uses for a schema-less cell.

**The contract for the build:**

1. State: `#trackedIntents` unchanged; replace `#intentSinks` with
   `#intentListenerReleases` (`space\0sidecar` → release) plus optional
   `#intentIndexHints` (`space\0sidecar\0eventId` → index).
2. Install in `trackIntent` when no listener exists for (space,
   sidecar): (i) subscribe ONE `IStorageNotification` per overlay (or
   per sidecar) via `runtime.storageManager.subscribe(...)` filtering
   `notification.space === space` and `change.address.id === sidecarId`
   (alternative: `replica.sinkDocument?` after adding the optional
   member); (ii) keep the doc watched via `sync(sidecarId, { path: [],
   schema: false }, "space")` (best-effort, logged like today's
   `intent-sink-failed` arm); (iii) run an immediate raw check against
   `replica.getDocument(sidecarId, "space")?.value` (covers the T25
   duplicate fire whose consequence already landed).
3. Trigger: any notification touching the sidecar (append, mark, stamp,
   watermark, load / pull, revert; on `reset` treat as dirty). The
   listener does NOT act inline: it records dirty (+ hinted indices from
   `address.path[2]` when `path[1] === "entries"`) and `queueMicrotask`s
   ONE coalesced check per (space, sidecar) — precedent
   `#sealSpeculative`'s deferred sweep. Rationale: `#notifyIntentOutcome`
   calls arbitrary UI subscribers and must not run inside the replica's
   integrate / commit dispatch (the `speculationAckObserver` precedent is
   safe only because `#sweep` merely resolves promises).
4. Check: re-read the raw doc at check time (not the captured `after`);
   for each tracked id locate its entry by verified hint
   (`entries[i].eventId === id`) else a backward scan from the tail
   (stop when all located); not-found stays tracked (append not yet
   landed; the watermark backstop stands). Apply today's arms unchanged
   and in today's order: `status === "dropped"` → `#untrackIntent`,
   `retireIntent`, `#settleIntentConsequence(dropped)`,
   `#notifyIntentOutcome(dropped)`; else `consequenced === true` →
   untrack, `retireIntent`, settle (`errored` if `error` else
   `consequenced`), notify `errored` if `error`. `resolveIntent`,
   `waitForIntentConsequence`, `subscribeIntentOutcomes` untouched.
5. Release: `#untrackIntent` releases the listener when the set empties
   (or the listener returns `{ done: true }`); `close()` releases all
   (today's `:1085–1092` slot).
6. Backstop unchanged: `#ensureWatermarkSink` / `#sweep`
   (`:888–921, 960–1057`) — and the origin-ack wake (leg C, repaired by
   T2 in the browser bundle).
7. Diagnostics for pins: `intentCheckVisits` (entries visited per check)
   and `intentCheckCount`; recommended `commonfabric.*` surface (SB S5):
   `pendingIntents`, `intentRetiredByConsequenceOf`,
   `intentRetiredByBackstop`, `dropNoticesSeen`, `errorNoticesSeen`,
   `sidecarEntriesRead` (must be O(tracked), never O(history)) — pinned
   in the speculation tests (precedent
   `speculation-arrival-gate.test.ts`).

No tx ⇒ no CFC probe, no scheduler action, no `idle()` participation,
no demand edges. Per notification O(changes) map lookups; per check
O(outstanding + hinted indices), degrading to a raw O(E) array walk
only when a hint misses (microseconds).

**(b) Interim — the schema-narrowed sink, if the build lands in two
steps.** `getCellFromLink(link, schema)` with a non-true schema makes
`needsTraversal` false and routes `validateAndTransform` through the
`SchemaObjectTraverser`; with `properties` listed and
`additionalProperties` UNSET, unlisted properties (`payload`, `stream`,
`firedAt`, …) hit the missing-property marker and are NOT descended, no
read, no link followed. **Do NOT set `additionalProperties: false`**:
that routes the unlisted property through `descend()`, which records a
shape read first. Recommended schema: `{ type: "object", properties: {
entries: { type: "array", items: { type: "object", properties: { eventId:
{ type: "string" }, consequenced: { type: "boolean" }, error: { type:
"string" }, status: { type: "string" }, reason: { type: "string" } } } }
} }` (a type-mismatched element voids the whole array — entry
well-formedness, which admission enforces, is load-bearing). Reads per
fire ≈ 2–7 per entry, ZERO dereference traces ⇒ each probe O(E) not
O(E²); reactivity preserved (a `consequenced` key-add is a shape change
under the per-item non-recursive read); the demand leak is CLOSED.
What (b) does not fix: still O(E) reads and O(E) dependency addresses
re-indexed per fire; still the CFC probes (four at `fb2292a24`, halved
by T1) at O(E) each; still a scheduler effect (idle participation, a
graph node); still fires on EVERY sidecar
change; still O(E) on the click's synchronous path. "Flat enough" only
while E stays in the hundreds — an interim, not the design.

**Rejected:** (c) per-entry `cell.key("entries").key(i)` sinks (the
index is unknown at fire time and can move; one effect per intent with
tx + probes; a schema-less per-entry sink still follows payload links);
(d) `consequenceOf` on the wire frame (spec-literal, not smallest;
cannot carry the drop notice or the error consequence, so a value-plane
read remains anyway).

### 3.4 Pins 1–11, red-first, each with its mutation

1. A consequenced / dropped / errored mark on a TRACKED id retires the
   echo (mutation: listener never installed → echo lingers until the
   watermark backstop; the existing pin `event-append-client.test.ts:
   577–643` stubs `getCellFromLink().sink` — it binds to the old seam
   and must be re-seamed to the notification path, ideally through the
   emulated storage manager rather than a hand stub).
2. A mark on an UNTRACKED id is ignored (mutation: drop the `ids.has`
   guard).
3. Outcome subscribers hear dropped / errored, not consequenced
   (existing).
4. `waitForIntentConsequence` resolves for each terminal kind, memo
   consumed (existing / extend).
5. Per-check cost O(outstanding): a synthetic sidecar with 1 000
   consequenced entries + 1 outstanding → `intentCheckVisits` ≤ a small
   constant (mutation witness: the full-scan variant reports 1 000);
   plus ZERO txs minted by the overlay during a mark delivery (wrap
   `runtime.edit`).
6. No scheduler effect for the watch: `runtime.scheduler
   .getGraphSnapshot().nodes` has no id starting
   `sink:${space}/of:stream-events:` after a fire (precedent filter
   `scheduler-effects.test.ts:228–231`; mutation: keep the `cell.sink`).
7. A duplicate fire whose consequence already landed resolves at
   `trackIntent` (T25) without leaking a listener (mutation: skip the
   immediate raw check).
8. `close()` releases listeners; no callback after close (mutation:
   forget the release).
9. The check runs in a microtask, never inside notification dispatch
   (mutation: call inline; witness: a subscriber that commits during the
   outcome callback).
10. The check has run by the time `storageManager.synced()` / `idle()`
    resolve after a frame (timing regression guard, since the watch
    leaves the scheduler).
11. OFF byte-identity: `runtime.speculationOverlay === undefined` and no
    listener installed OFF.

### 3.5 OFF-arm statement

The overlay exists only under the flag off the serving posture;
`trackIntent` is reached only inside `cell.ts`'s flag-ON branch. (a) and
(b) touch only overlay code (plus an optional interface member for the
`sinkDocument?` variant): OFF-invisible. The zero-write
`flowLabelWorkExists` skip (C Q3) IS OFF-visible — a separate,
CFC-owned rider (§5), never in this change.

### 3.6 Expected cost after

(a): per notification O(changes) lookups; per check O(outstanding +
hints); zero txs, zero probes, zero scheduler runs, zero proxies;
`trackIntent` on the click path becomes O(1) + one raw check. Per note
the ~4 sidecar changes each cost ≈ nothing. The ON client's
`scheduler/run` per note should return to ≈ OFF's ~80 ms plus the
speculative echo run and overlay bookkeeping (seal + sweep, O(live
entries)) — FLAT in history. What remains: ordinary UI sinks (linear in
notes, OFF too), `handleRequest` / `createViewProxy` (~1.6 s at note 10,
OFF too), and three ON-only LINEAR residuals outside `scheduler/run`
that only compaction (OW24) bounds — the frame carries the whole sidecar
doc per change, the differential deep-compares before / after per
change, and local patch application.

### 3.7 What would refute (e)

If per-note client `scheduler/run` still grows after replacing the
sink, the remaining O(history) candidates are: (i) UI sinks over growing
lists (check OFF grows too → not ON-specific); (ii) `#entries` growth —
never-served instances kept by the arrival gate make `#sweep`,
`retireIntent`, and `#supersedeOlderEntries` O(live) per event with a
fixpoint loop — watch `overlay.entryCount(space)`, which must stay
bounded by pending work; (iii) the effects-channel sink if the session
effects doc grows; (iv) the watermark sink is tiny — not a candidate;
(v) the ON-only linear residuals above — linear, outside
`scheduler/run`, compaction-bounded.

## 4. (α) The double-dispatch implementation — RULED, owed to this stage

**The ruling (events.md §4, RULED 2026-08-18):** *"One durable stream
entry is delivered to its handler exactly once as a COMPLETED run,
regardless of dispatch path or reference count. An entry whose
in-process (LT1 same-wave) run does not complete within its appending
wave is dispatched by the drain alone; the serving loop purges unrun
in-process leftovers at the flush deadline and skips at the drain any id
already queued or run with a durable entry. A derivation-kind emitter's
superseded LT1 leftover re-arms nothing and its orphan delivery is
REFUSED (never delivered without a durable entry)."* The invariant binds
the RESULT side — how many times one durable entry's consequences are
committed — not the authored append (the `eventId` dedupe horizon) and
not the client's echo (which commits nowhere).

**What exists (the trio):** the drain's in-flight guard —
`#drainInFlight: eventId → "queued" | "marked"` (`space-server.ts:323`
on the tuning tip; `events.drainInFlightSkips`; released on the wave
outcome, not the seal) — dedupes the drain against ITSELF for copies
queued WITH a `streamEntry`; that covers (β) for the drain's own copies.
The LT1 in-process copy (no `streamEntry`) is deliberately not tracked
there.

**Owed to this stage — the work item:**

- **(α1) The deadline-time purge of unrun LT1 leftovers.** At the
  deadline decision inside `#waveCycle` — the `exhausted = true; break`
  arms (`space-server.ts:2702–2708` at `fb2292a24` = `:2829–2836` on the
  tuning tip) — synchronously, purge every scheduler-queued event with
  `served !== undefined && served.streamEntry === undefined` that has
  not started running (queued, not in flight). Mechanism candidate: the
  scheduler facade's `dropQueuedEvent` / `dropEvent`
  (`scheduler/facade.ts:2561–2579` on the tuning tip; splices
  `eventQueue`, releases lineage) behind a new facade method (a
  predicate purge with a distinct reason and a counter,
  `events.lt1LeftoversPurged`). The LT1 copy is queued with `served: {
  firedAt, parentEventId? }` and NO `onFailure` / `onCommit`
  (`cell.ts:1799–1819` on the tuning tip), so `notifyEventDropped`
  writes NO dropped notice — the durable entry stays pending in the
  store and the drain delivers it in a later wave with its
  `streamEntry`. Pin exactly that: no `status: "dropped"` lands on the
  entry, and the drain's later delivery is the ONE completed run.
- **(α2) The drain skip against an in-wave `streamEntry`-bearing
  copy.** The (β) half beyond the drain's own copies (shaper-held
  events included): the drain skips an id already queued or run WITH a
  durable entry in the open wave; the guard's phase map is the seat.
- **(α3) The orphan REFUSAL for derivation-kind emitters.** A
  derivation's write that the wave supersedes (a per-doc drop) takes
  the durable append with it, so its LT1 leftover must re-arm nothing
  and, if it ran, its consequences must NOT be delivered without a
  durable entry. Seat candidates: the C8d fold in `wave.ts` (the
  emitter-requeue withdrawal keyed on `parentEventId`, `:2566–2590` on
  the tuning tip) extended to the supersede-drop arm, plus (α1)'s purge
  for a not-yet-run copy. Neither lens examined this seat (the
  requirement comes from the ruling, not the lenses); the exact seat is
  builder-verified and stated in the PR.
- **(α4) The per-event run-count pin.** One fire under an LT1 cascade
  that misses the deadline → exactly ONE completed run (from the
  store's per-event consequence commits; `processed == appended` is NOT
  that pin — re-drains inflate `processed`, in-wave LT1 cascades count
  in neither). Plus: the lunch gate's `appended 11 / processed 17`
  shape reported before and after; the lunch skip lifts only after the
  pin is green (register OW35's trigger).
- (β) for the drain's own copies is already covered — note it, do not
  rebuild it.

OFF: dispatch-path code under the serving posture only (OFF has one
in-process queue and one handler registration per stream link —
exactly-once by construction).

## 5. Consolidated owner ruling set

Merged from SB's S6 (11), W's R1–R5, and C's rulings 1–5, plus the one
item the reconciliation itself surfaced (6), deduplicated. Each
open item: the question a non-implementer can parse, the options, the
recommendation. Items the owner ALREADY ruled are marked and not
re-asked.

**Amended 2026-08-18 for (d′) (§2):** item 1 is RESTATED (the sentence
to adopt is the (d′) text, §2.10; the SB/W "structural subscription"
text is the fallback's); items 2, 3, 11, and 12 are MOOT while (d′)
stands (they belong to the fallback, §2F, and are kept as written); ONE
item is added as RULED — R-D, the coarse unsubscribe — because the
owner's direction already says it. Nothing else in the set moves.

**ACCEPTED 2026-08-18 — the owner accepted the ENTIRE revised ruling
set (verbatim: "ruling set is accepted").** Every OPEN item below is
RULED 2026-08-18 per its stated recommendation; each carries its ruling
as a trailing **RULED** line, with the question, options, and
recommendation kept above it as the record. The already-RULED items
(R-A–R-D) and the MOOT items (#2/#3/#11/#12) are unchanged. What the
acceptance LANDS in the spec is exactly one edit — item 1's (d′)
sentence in serving-loop.md §1 (§2.10; RULED marker; implementation
W1, register OW39); every other spec sentence a ruling unlocks (items
5/6's speculation.md §4 step-2 sentence, item 7's events.md §5 pin,
item 8's pin, item 10's scopes.md §9 amendment) is RULED text that
rides its build PR (§6's "spec and register edits the build carries"),
so the register's coverage row for each lands with the sentence
(register §4's standing rule). Item 4's step-4 sub-question is RULED
"owed" and its row is minted with the acceptance (register OW40).

### Already RULED (2026-08-18) — folded in, not re-asked

- **R-A. No lazy demand** (SB S2 / S6 #5; W R1). RULED IN SUBSTANCE —
  the owner: "clients will request a bunch and it is highly
  overlapping, and so likely that computation demanded for one already
  updated the others — design for that." A watch IS demand; shared
  (unnarrowed) structure computes ONCE regardless of demander count;
  only the genuinely per-user suffix is per-user. Consequences for the
  design: eager per-demander structural suffix (W's option A); no
  server-side "idle demander" tier (SB's option C — excluded: it would
  let W advance over a demanded-but-never-walked instance); lazy
  compute with W held (SB D) is sound and useless. Not a ruling but
  consistent with it: a client that goes idle DROPS its watches (SB's
  option B — leaving D; on return, the arrival re-arm) is the only
  laziness the spec has, and needs no spec change.
- **R-B. The double-dispatch invariant** — RULED (events.md §4, quoted
  in §4); its (α) implementation is OWED to THIS stage (§4; register
  OW35).
- **R-C. The measurement caveat** — RULED: the OFF client-local number
  is not the comparator; speculative client-side execution stays and
  stays fast; the honest server metric is time-to-SETTLE on the server
  (`waitForSettled` is the instrument); several-second sends are wrong
  on any comparator. Hence the build's acceptance (§6): server settle
  on the cross-user journeys sub-second, measured explicitly, PLUS
  client-local speculation latency reported separately as a preserved
  property. The FLIP's numeric bar restated against settle remains the
  owner's at flip time (register OW38 (ii)); this build's acceptance
  bar is stated here.
- **R-D. The coarse unsubscribe is accepted for now; fine-grained is
  future.** RULED 2026-08-18 — the owner, in the direction that
  established (d′) (§2.0): *"it doesn't unsubscribe in a fine-grained
  way as tracking that over overlapping subscriptions was difficult,
  and so i think this remains acceptable (and we can make it
  fine-grained in the future)."* Recorded, not re-asked. What it binds:
  a doc leaves the demand set only when NO live session tracks it — a
  session's tracked set shrinks only on a full re-evaluation
  (`session.watch.set`, a forced full resync, the lease-holder re-arm)
  or on close; the incremental push path only grows it (§2.1). Demand
  roots are therefore released LATE, never early (§2.4): the cost is
  bounded work no client reads, never a starved value. Fine-grained
  release is a future item whose seat is the memory server's tracker
  (per-doc refcounts across a session's selectors), not the loop; the
  register carries the row when the build lands (§6).

### Front-loaded — RULED 2026-08-18 (was open; the (d′) spec sentence; the reach/perf items are MOOT under (d′))

1. **The demand sentence — under (d′): "demand is the tracked-ids
   closure; there is no demand walk".** (SB S6 #1 + #2; W R2; RESTATED
   2026-08-18.) *Question:* serving-loop.md §1:57–62 says the demand
   walk "runs once per demanding pair"; is that sentence a description
   of the stage-B mechanism (amendable) or a rule? Under (d′) the
   sentence to adopt becomes: **"demand is the union of the demanding
   sessions' tracked instances (memory v2's schema-narrowed closure);
   the serving loop runs the stale writers of demanded instances; there
   is no demand walk"** — the full replacement text is §2.10. *Options:*
   (a) descriptive — replace lines 57–62 with the (d′) text (§2.10),
   restate register residual (ix) as §2.10 says; (b) normative — then
   (d′) is a spec change (and the spec is inconsistent with its own
   per-node probe rule either way — scopes.md §2; serving-loop.md §3b);
   (c) keep the walk sentence and build the structural walk — the
   fallback (§2F), whose wording is §2F.4's SB/W "structural
   subscription" text, retained there for that branch only. *Recommend
   (a).* If the ruling lags the build, the code lands with the (d′)
   sentence DATED, pending ratification (T2's precedent). The old
   sub-question — "must a value-only change under a demanded root
   re-run the walk?" — has no subject under (d′).
   **RULED 2026-08-18 — (a), as recommended:** the sentence was
   descriptive; serving-loop.md §1:57–62 now reads the (d′) text
   (§2.10) with the RULED marker — LANDED the same day, with the
   acceptance, ahead of the code; the ruling did not lag the build, so
   the DATED interim was never needed. Its IMPLEMENTATION is W1 (§6;
   register OW39, closed by W1's landing). Residual (ix)'s restatement
   is the one part of (a) that rides W1 with the code: at this tip the
   walk still runs and (ix) is still its cost, so the register stays
   truthful about the code until W1 (§2.10's landing note).
2. **MOOT under (d′) (fallback-only) — the reach gap, accepted as
   unchanged.** (W R3.) *Question:* a
   writer whose declared surface lies two or more levels below the
   deepest container the walk visited in an existing doc is not pulled
   live by the walk until something writes there (one-run-late then
   covers it) — this is TODAY's behavior too; is it accepted as
   unchanged by (c′)? *Options:* accept (record it in §3b as the walk's
   reach rule); or require the walk to register a recursive read per
   visited doc root (the fallback shape — sound, ~10× cheaper than
   today, but re-fires on values). *Recommend accept*; the fallback
   stays the refutation path if T1 fails. *(Under (d′) there is no walk
   and no visited container: liveness comes from demand roots and the
   runs' own logs — the question does not arise.)*
3. **MOOT under (d′) (fallback-only) — Q3.3 for fanned-out COMPUTEDS
   (a perf item touching C11b's bookkeeping).** (W R4.) *Question:* may
   "skip the resubscribe when
   every ran instance's compacted log equals its previous one and
   nothing was pruned" apply to fanned-out computeds as well as the
   walk? *Options:* walk only in this stage; both, verified by
   `SCHEDULER_LIVENESS_EQUIVALENCE=1`. *Recommend walk-only now (Q3.1 +
   Q3.2 are enough for the acceptance); computeds as a follow-on with
   the equivalence hook as the gate.* *(Under (d′) the walk-only
   recommendation loses its subject; the computeds' resubscribe stays a
   tuning-class follow-on if the build's numbers ask for it — not a
   ruling.)*

### The one-liners — RULED 2026-08-18 (were open)

4. **The intent watch need not be a scheduler effect.** (SB S6 #3; C
   #1.) *Question:* may the watch be a non-reactive
   storage-notification listener outside the scheduler (it no longer
   participates in `runtime.idle()`; the check moves to a microtask)?
   *Recommend yes* — no sentence requires an effect; pin 10 guards the
   timing. Sub-question (C #1): speculation.md §4 step 4's re-run of
   un-consequenced intents against fresh state is neither the sink's
   nor the sweep's job today (`#sweep` retires / un-renders an intent
   echo but does not rebase it) — is step 4 owed at all? *Recommend:*
   not built in this stage (the listener is orthogonal); rule "owed"
   (mint a row) or "amend §4 to say an outstanding echo stands until
   retired".
   **RULED 2026-08-18, as recommended:** yes — the intent watch may be
   a non-reactive storage-notification listener outside the scheduler
   (pin 10 guards the timing). Sub-question: RULED **"owed"** — step
   4's re-run is not built in this stage and speculation.md §4 is NOT
   amended (the "an outstanding echo stands until retired" alternative
   was not taken); the register mints the row with the acceptance
   (OW40).
5. **Tracked-entry-only sidecar read.** (SB S6 #4.) *Recommend:* read
   the tracked entry only — on drop for the UI hook, otherwise its own
   terminal fields — never whole-history; add the §4 step-2 clarifying
   sentence (§3.2).
   **RULED 2026-08-18, as recommended:** tracked-entry-only — the
   client reads the tracked entry (its own terminal fields; on drop,
   for the UI hook), never whole-history. The speculation.md §4 step-2
   clarifying sentence (§3.2) is RULED text that rides the build (W2),
   not landed with the acceptance.
6. **Sanction the tracked entry's mark as the value-plane carrier of
   `consequenceOf`.** (SB S6 #6, flipped by C's wire finding — D4;
   reconciler's item.) *Question:* the spec does not sanction the
   per-entry `consequenced` mark, yet the wire carries no
   `consequenceOf` and the mark is the only client-visible carrier; may
   the client key on the tracked entry's `consequenced` / `status` /
   `error` (T7 semantics: written as the event's consequence, retiring
   with the entry at compaction — not a processed-events table), or
   must `consequenceOf` go on the wire (C's option (d))? *Recommend
   sanction*, with SB's guard kept: never a dependency on HISTORY;
   always backstopped by `W ≥ seq(e)` / `eventWatermark ≥ seq(e)`.
   **RULED 2026-08-18, as recommended:** SANCTIONED — the tracked
   entry's `consequenced` / `status` / `error` mark is the client's
   consequence carrier (T7 semantics: written as the event's
   consequence, retiring with the entry at compaction — not a
   processed-events table), with SB's guards binding: never a
   dependency on HISTORY; always backstopped by `W ≥ seq(e)` /
   `eventWatermark ≥ seq(e)`. `consequenceOf` does NOT go on the wire.
   The sanctioning sentence rides the build with item 5's (W2).
7. **Drops and errors ride `consequenceOf`.** (SB S6 #7.) Inferred
   from "every eventId drained this wave" + drops / errors advancing
   `eventWatermark`, never stated. *Recommend* a one-line pin in
   events.md §5.
   **RULED 2026-08-18, as recommended:** pinned — drops and errors ride
   `consequenceOf`; the one-line pin in events.md §5 is RULED text that
   rides the build, not landed with the acceptance.
8. **The client keeps a stream subscribed while it has intents
   outstanding on it.** (SB S6 #8.) The delivery vehicle in practice is
   the `eventWatermark` write on the stream doc the client appended to;
   *recommend pinning* — it is exactly the minimal watch ((a)'s point
   2(ii)).
   **RULED 2026-08-18, as recommended:** pinned — a client keeps a
   stream subscribed while it has intents outstanding on it ((a)'s
   point 2(ii), the minimal watch); the pin's spec sentence rides the
   build (its home — speculation.md §4 beside step 2, or events.md §5
   — is the build's to name), not landed with the acceptance.
9. **The W / `eventWatermark` backstop.** (SB S6 #9.) May an
   intent-origin entry retire on `W ≥ seq(e)` or `eventWatermark ≥
   seq(e)` when the `consequenceOf` frame was missed? Both are
   spec-defined "consequences committed" facts. *Recommend yes*;
   W-coverage is the sweep's existing rule, so one sweep serves both
   origins.
   **RULED 2026-08-18, as recommended:** yes — an intent-origin entry
   may retire on `W ≥ seq(e)` or `eventWatermark ≥ seq(e)` when the
   `consequenceOf` frame was missed; one sweep serves both origins.
10. **scopes.md §9 vs §2 — the ragged tripwire.** (SB S6 #10.) §9
    forbids "ragged instance sets as a steady state"; §2 (amended
    2026-08-16) permits ragged below the space→user hop
    "simultaneously and stably". *Recommend amending §9* to "ragged at
    the space→user hop".
    **RULED 2026-08-18, as recommended:** amend scopes.md §9 to "ragged
    at the space→user hop"; the amendment is RULED text that rides the
    build PRs, not landed with the acceptance.
11. **MOOT under (d′) (fallback-only) — no basis rows for the walk.**
    (SB S6 #11.) §3b's rows are per (action, instance) output-currency;
    the walk has no output, and activation re-walks demanded roots by
    construction. *Recommend no basis rows*; say so in §3b so recovery
    never re-marks a zombie. *(Under (d′) there is no walk and no
    question: activation's re-mark is the basis scan over the demanded
    writers' own rows — §2.2 step 3.)*
12. **MOOT under (d′) (fallback-only) — the walk-node key.** (W R5.)
    Per (scope-name, id) as recommended, vs one node per id reading all
    demanded scope names (needs a re-arm when a new scope name arrives
    for a known id). *Recommend per (scope-name, id)* — an
    implementation choice, cheap to rule. *(No node under (d′).)*
13. **The effects-channel sink follows the same redesign.** (C #5.)
    `speculation/effects-channel.ts:141–149` is the same schema-less
    whole-doc `cell.sink` over the session effects doc. *Recommend
    yes*, as (e)'s second step (or a follow-on row if the effects doc
    is small on the acceptance workloads — say which).
    **RULED 2026-08-18, as recommended:** yes — the effects-channel
    sink follows the same redesign, as (e)'s second step (a follow-on
    row only if the effects doc proves small on the acceptance
    workloads — the build says which).
14. **The zero-write CFC-probe skip is a CFC-owner rider, OFF-visible.**
    (C #3; W's generic-path note.) Skipping `flowLabelWorkExists` when
    a tx has no writes / attempted writes / write-policy inputs /
    ingest stamp looks CFC-sound (the probe only ever computes `false`
    on such a tx) but is generic, shifts `cfcStats.cfcRelevantTx`, and
    the S16 rationale reads broader than the code. *Recommend* a
    separate rider for the CFC owner, OFF suite as its gate; not in this
    stage (under (a) the intent watch has no tx, so the rider narrows
    to ordinary UI sinks — tuning-class).
    **RULED 2026-08-18, as recommended:** a separate rider for the CFC
    owner, OFF suite as its gate, OFF-visible; NOT this stage.
15. **`storageManager.subscribe` vs `sinkDocument?` — the storage
    owner's call.** (C #4.) *Recommend `subscribe`* (typed, the
    scheduler's own precedent) unless the storage owner prefers the
    optional interface member.
    **RULED 2026-08-18, as recommended:** `storageManager.subscribe`.
16. **Is the schema-narrowed sink an acceptable interim?** (C #2.)
    Linear, still an effect. *Recommend* only if the build lands in two
    steps (the first step is also the cheap refutation experiment for
    (e), §6 W0); otherwise skip straight to (a).
    **RULED 2026-08-18, as recommended:** the schema-narrowed sink is
    acceptable ONLY as an interim, if the build lands (e) in two steps
    (its first step doubling as (e)'s cheap refutation experiment, W0);
    otherwise straight to (a).

## 6. The build-stage work order

**W0 RAN 2026-08-19 — PROCEED (d′)** (report
[`stage-c/w0-dprime-report.md`](../../history/plans/server-execution-v2/stage-c/w0-dprime-report.md));
W1 proceeds; W1-F not taken; the report's §4 flags 9–14 are additional
W1 inputs.

Base: the stacked stage-C tip — the docs branch (`claude/server-exec-
v2-stage-c-docs`, off the tuning trio's `b54bf5215`) or, once the three
stage-C siblings are stacked, that stack's tip; rebase onto it, never
build on `fb2292a24`. Fetch before dispatch; fresh worktree per item;
push `HEAD:<branch>`; stacked PRs get NO CI — every green is a local
run, said with counts. Benchmarks and gates on the harness protocol
with NO configured LLM model, built binaries, posture read per run.

**W0 — the refutation experiments, FIRST (scratch, nothing pushed):**

- **(d′) — §2.8's experiment, FIRST.** On a scratch branch: expose
  `demandedInstancesForSpace` (+ the push-growth `demandChanged`), add
  the `demandedWriters` root kind with its bracket, replace the walk
  with the currency check over the registry deltas (§2.2), and run the
  chat / lunch / note workloads with the attribution's per-wave
  instrumentation. Answer §2.8's three questions with numbers: **(a)**
  the demanded derivations still land — T1′/T2′/T3′/T7′ (value change →
  re-derive with zero walk runs; new link → the newly reachable computed
  becomes demand and lands, in N cycles; array growth; doc-appears) plus
  P-demand-set / P-coarse / P-arrival; **(b)** nothing the walk kept
  live goes dark — the refutation to look for is a value the client
  RENDERS that stays stale (then either the schema is wrong or the
  closure is the wrong demand set — name it); **(c)** server settle per
  authored input, value-only path and structural-growth path separately
  (the one-push-late cycle and the 300 ms grace are the numbers the
  owner needs — §2.8 flag 1). Also read: the demand-set sizes
  (per-session `trackedIds.size`, the union per space, the drift over
  n=20 — §2.6), the count of demanded rows with pattern meta and no
  writer (flag 4), `undemandedNarrowingRuns` (flag 5). If (b) finds a
  real hole → the fallback (§2F; W1's fallback branch below); if (c)'s
  extra cycle breaks the bar and a no-grace wake does not fix it → the
  owner rules between the fallback and the pre-seal refresh; else W1.
- *(The former (d) W0 — W's Q9 on the fallback read shape — runs only
  if the fallback branch is taken: a scratch build with (a)'s node dedup
  plus "one recursive read at `[]` per traversed doc", predicted ~10×
  cheaper per run and resubscribe; if walk runs per event wave fall to
  ≈ (#roots whose subtree grew) × N and the settle stays ~2.6 s, the
  term was elsewhere and the 96 % attribution is wrong — STOP and
  re-attribute before building (c′); read the demand-key scope mix to
  size (a).)*
- **(e)** C's interim (b) — a one-line schema on the sink — on the note
  and chat series: if per-note client `scheduler/run` still grows, the
  O(history) is elsewhere (C Q9's list; watch `overlay.entryCount`) —
  re-attribute before building (a).

**W1 — (d′) proper** (server; the biggest term), gated by W0's (d′)
result: the memory-server exposure (`demandedInstancesForSpace` — rows
`(id, scope, scopeKey, identity, root)` over the closure, the service
principal excluded; the push-growth `demandChanged` notify); the
SpaceServer's registry over the closure (`#demandersByKey` keyed by
instance key for every demanded row; `#demandersFor` indexed by root id;
the structure load per ROOT row unchanged) and the currency check
applied to registry deltas (writers of an entered key → demand roots;
not-current-for-pair re-arm via the `rearmNotCurrentFanOutForActor`
shape; the root-level arrival re-arm kept; releases on leave); the
scheduler's `demandedWriters` root kind (a facade method to enter /
leave; the `isDemandRoot` disjunct; the bracket on enter / leave /
registration / unregistration — §2.4); DELETING the walk
(`#installDemandWalk`, `#demandSinks`, the `demand-walk:*` effects and
traces, the walk's union logs and resubscribes); the `demand` counter
block, (d′) version (W4); pins T1′–T5′, T7′, T9′, T10′, P-demand-set,
P-coarse, P-arrival red-first, plus the settle-cycle count for T2′/T3′
as a reported number; the register's residual (ix) restated per §2.10
(rides HERE with the code — the sentence landed ahead of it); the (d′)
§1 sentence — RULED 2026-08-18 and LANDED in serving-loop.md §1 with
the acceptance, ahead of the code (register OW39 — this item CLOSES
it; the spec-ahead-of-code marker in §1 comes out with the walk);
`SCHEDULER_LIVENESS_EQUIVALENCE=1` green across the new transitions;
the OFF suite byte-identical.
*(No B7 note, no "no basis rows for the walk" — moot.)*
**FALLBACK BRANCH — W1-F, only if W0 refutes (d′):** (d) the structural
walk per §2F: (a) node keying + refcount; (c′) the structural traversal
+ visited-set cycle guard; Q3.1 + Q3.2 (Q3.3 walk-only if ruled);
liveness bracketing on every transition; the fallback's `demand`
counter block (§2F.3); pins T1–T11 red-first; residual (ix) restated
per §2F.4; §2F.4's amended §1 sentence — now a RE-RULING, since it
would replace the RULED and landed (d′) text (§2.10's landing note);
§3b's "no basis rows for the walk" and B7 note (if ruled); the
equivalence hook green; OFF suite byte-identical.

**W2 — (e) the intent listener** (client) — *BUILT 2026-08-19, see
§3.3's landing note*: contract points 1–7; the
`commonfabric.*` debug counters; pins 1–11 red-first (re-seam the
existing `event-append-client.test.ts` pin to the notification path);
the effects channel (item 13 — RULED yes, as (e)'s second step); the
speculation.md §4 step-2 clarifying sentence (items 5/6 — RULED; the
text rides this PR) and item 8's pin (RULED; its spec home is the
build's to name); interim (b) only if two steps (item 16 — RULED so).

**W3 — (α)** (dispatch path): (α1) the deadline-time purge; (α2) the
drain skip against an in-wave `streamEntry`-bearing copy; (α3) the
derivation-emitter orphan refusal (seat stated in the PR); (α4) the
per-event run-count pin; `events.lt1LeftoversPurged`; the lunch gate
re-run (skip lifts only on the green pin).
*W3 LANDED 2026-08-19 (stacked PR `claude/server-exec-v2-w3-alpha`;
report `stage-c/w3-alpha-build-report.md`; register OW35 CLOSED): α1 as
specified; α2 verified (the trio's guard covers held copies; the drain is
the only `streamEntry`-bearing producer) — not rebuilt; α3's seat is the
wave's requeue closure (an eventId → emitter map over the sealed ops'
seq-less sidecar entries; refused when no surviving contribution appends
the copy's entry); α4 pinned. PLUS a seat this list did not name and the
ruled sentence requires — (α1b) the late-seal REFUSAL of an LT1 copy
still RUNNING at the deadline (it seals after its appending wave closed;
W0's l1 store is that shape: commit 64 = the unmarked in-process add +
the drain copy's marked toggle-off) — the purge reaches only QUEUED
copies. Lunch gate 3/3 green at the tip; the ON skip STAYS for the
client cascade-echo stranding (l3's "3 joined"), which is W2's.
Independent review (2026-08-19; LANDABLE-WITH-FIXES, 1 BLOCKER / 2
MAJOR / 3 MINOR / 4 NIT, report on-branch) found the build WEAKER than
the sentence in the same-eventId SIBLING corner — an LT1 copy whose run
commits a separate event-handler-stamped tx (the served navigateTo
intent) that survives the appending wave while the handler's own tx is
refused late: the entry was marked on the sibling's survival and never
re-delivered (a LOST delivery; a regression against W1's base). Fixed in
the review batch and pinned: only the copy's OWN run marks its seq-less
entry; the orphan arm folds siblings, counted per event. OW35 CLOSED
stands for the pinned shapes, the sibling shape now among them; the
late-seal SPLIT (intent in the appending wave, consequences one wave
later) is a recorded residual, not a hole.*

**W4 — measurement and acceptance** (the design pass's re-benchmark;
register OW38 (i)):

- **Server settle time (the acceptance metric).** Per authored
  cross-user input on the chat n=20 series and the lunch steps: from
  the authored event commit's ADMISSION on the server (the feed's
  admitted-commit notice for the client's append; the append's seq) to
  W COVERING it (the wave commit whose `derivedThrough` ≥ that seq —
  `waitForSettled(space, seq)`, `packages/runner/src/executor/
  watermark.ts`, is the instrument; server-side timestamps in a
  bounded per-space series exposed through the §7 block, alongside the
  existing per-wave `scheduler/execute/settle` timing). **Sub-second at
  p50 on both journeys is the acceptance; p95 reported.** Separately
  report the client-observed settle (append ack → the watermark doc's
  arrival at the appending client).
- **Arrival at the observing client** — the existing send-click →
  other-browser series and per-step StepTimer, reported beside settle
  (not the comparator; the several-second sends must be gone — it
  bounds settle + push + apply).
- **Client-local speculation latency preserved** — click → the sender's
  own speculative render (the 1–3 ms echo), reported as a preserved
  property; must not regress.
- **Note-create `createToView` (client) FLAT in history** — the per-note
  cost does not grow across the n=20 series (slope ≈ OFF's); C's Q5
  prediction; the monotone 1 → 13 s is the mutation witness.
- **The §7 `demand` counter block, (d′) version,** present in
  `/api/health/stats.servingLoop` and asserted in tests: `demandedRows`
  (the exposed rows per pass), `demandedInstances` (distinct keys — the
  registry's size, current / max), `demandedPairs`, `demandedWriters`
  (the standing root set, current / max), `demandRootEnters` /
  `demandRootLeaves`, `notCurrentRearms` (per-key not-current-for-pair
  re-arms), `demandArrivals` (existing), `demandPasses` and
  `demandPassMs`, `pushGrowthWakes` (the new notify's count), and the
  witnesses: NO `walkRuns` counter exists (T9′ is the structural pin;
  a `demand-walk:*` node id anywhere in the graph snapshot fails it);
  `notCurrentRearms` per wave is the arrival witness; the T2′/T3′
  settle-cycle count is reported beside the settle series. Also fold
  into §7's LIST the two counters the code emits and the list omits
  (`undemandedNarrowingRuns`, `earlyEmitRefusals`) — the same doc drift
  fix as before. *(The fallback's block — `walkRuns`, `walkProbeRuns`,
  `walkForkRuns`, `walkStructuralTriggers`, `walkValueOnlySkipped`,
  `registeredReads`, … — is §2F.3's, for W1-F only.)*
- **The OFF byte-identity witness** — OFF suites unchanged; T9′ and pin
  11; the OFF store's commit table on the benchmark workloads
  identical.
- Re-read register OW37 (the §4 amplification ratio) on the new
  numbers — with the walk gone, wave count per authored input should
  fall (fewer exhausted waves), the structural-growth path adds one;
  never silence the assertion.

**Spec and register edits the build carries** (every ruling below is
RULED 2026-08-18 — the acceptance; what the build carries is the TEXT):
serving-loop.md §1:57–62 — the (d′) text (§2.10) — item 1: LANDED with
the acceptance, RULED, ahead of the code (register OW39; W1's landing
closes it and removes the spec-ahead-of-code marker) — the B7 note and
§3b's no-basis-rows are moot; scopes.md §9 ragged amendment — item 10
(text rides the build); speculation.md §4 step 2 clarifying sentence —
item 5 / 6 (text rides W2), and item 8's pin (text rides the build;
spec home the build's to name); events.md §5 drops / errors pin — item
7 (text rides the build); §7 counter list (the (d′)
`demand` block + the two omitted counters); the register: residual (ix)
restated per §2.10 (with W1's code), R-D recorded as RULED with its
future-item row (fine-grained release), a "Stage C design build delta"
LANDED block, the coverage row for each sentence as it lands (register
§4's standing rule), and the owed rows below.

**One PR or a train — recommend a TRAIN of three stacked PRs, in this
order:** (1) (d′) — memory server + scheduler + SpaceServer, biggest,
its own pins and OFF witness, gated by W0's (d′) result (W1-F, the
fallback, takes its slot if refuted); (2) (e) — client, independent
files, its own OFF witness; (3) (α) — small, RULED, dispatch path; the
benchmark report as a history file with the last PR (or a fourth docs
PR). Rationale: three subsystems, three review surfaces, three
independent refutations; W0's (d′) result may change (d)'s scope
without touching (e) or (α); the order is leverage, not dependency —
(e) and (α) can be built in parallel by separate builders. Not one PR:
it would couple three reviews and make a (d) re-scope stall the client
fix.

**Owed rows the build will create when it lands** (the acceptance
minted TWO ahead of the build — OW39, the (d′) §1 sentence's
implementation, which W1 closes; OW40, step 4's rebase, RULED owed —
otherwise none exist yet: this is a design document, and the (d′) §1
sentence is the one binding edit landed so far): fine-grained demand
release (R-D's future item; seat: the memory server's tracker); the
no-grace push-growth wake and/or the pre-seal closure refresh if W0's
(c) needs them (flag 1); the structure load for demanded non-root docs
with pattern meta if W0's count says so (flag 4); the output-doc
demanders union if `undemandedNarrowingRuns` shows the linked-piece
shape (flag 5); the (b′) incremental walk ONLY on the fallback branch;
the effects-channel follow-on if not in scope (item 13 — RULED as (e)'s
second step); the CFC zero-write probe rider (item 14 — RULED, CFC
owner); step 4's rebase (item 4 — RULED owed 2026-08-18; OW40 minted
with the acceptance, the build re-points it if it learns more); OW24
compaction as the bound on the ON-only linear residuals (existing row,
re-pointed); the (a) upgrade if interim (b) lands first (item 16); OW37
re-read; OW38 (i) lands with the benchmark, (ii) the flip bar stays the
owner's. *(Q3.3 for computeds leaves the owed list under (d′):
tuning-class if measured, not a row.)*

## 7. Risks, and what would refute each redesign

- **(d′) — something the walk kept live goes dark** (§2.8 (b)): a value
  the client renders stays stale with the walk gone. Since derivation
  inputs are discovered by running, the only class is a writer no
  demanded writer reads and no client schema reaches — undemanded by
  definition — so a real instance means the schema is wrong or the
  closure is the wrong demand set. W0 finds it or not; if found and the
  schema is right → the fallback (§2F, W1-F).
- **(d′) — the one-push-late cycle breaks the bar** (§2.3, §2.8 flag
  1): structural growth lands one derived commit later than the link
  that reaches it, plus today's 300 ms demand-wake grace. Measured in
  W0 (c); the no-grace push-growth wake is the cheap fix, the pre-seal
  closure refresh the expensive one; if neither is acceptable the owner
  chooses between them and the fallback.
- **(d′) — an unbracketed root transition is silent starvation** (§8's
  positive tripwire): the `demandedWriters` enter / leave /
  registration / unregistration transitions must all bracket; T10′ and
  `SCHEDULER_LIVENESS_EQUIVALENCE=1` are the guard. This replaces the
  walk's reach risks with one bracket risk.
- **(d′) — the demand set is much larger than the roots** (§2.6): the
  pass is O(rows) map work on deltas, but `#demandersFor`'s per-run scan
  is O(keys) — index by root id (flag 6); and the coarse growth is
  monotone within a session (flag 7) — W0 measures the sizes and the
  drift; if the union per space runs to tens of thousands, the pass
  moves to incremental deltas from the memory server (a follow-on, not
  a hole).
- **(d′) — a linked piece is not running on the server** (flag 4):
  parity with today, but visible now; the id-class-filtered structure
  load for demanded rows with pattern meta is the option; W0 counts.
- **(d′) — the term is elsewhere.** With the walk gone (zero walk runs
  by construction), if the settle stays ~2.6 s the 96 % attribution was
  wrong — re-attribute (wave commit / frames / `server.idle()` /
  derivation fan-out / structure-load); the 30 % of wave wall the
  attribution saw in `server.idle()` (the memory-server flush drain) is
  the first suspect. Not a (d′) refutation — (d′) is still simpler and
  correct — but the acceptance would need the next term found.
- **(d′) — the ruling** — if the owner rules the §1 sentence normative
  (§5 item 1 (b)), (d′) is a spec change: land the code DATED and the
  (d′) sentence as an amendment proposal; do not build a walk to satisfy
  a descriptive sentence. *RETIRED 2026-08-18: RULED (a), descriptive;
  the (d′) sentence is landed (§2.10's landing note). The residual risk
  is the inverse — the spec is ahead of the code until W1 lands
  (register OW39 keeps it visible).*
- **(d) — FALLBACK-ONLY risks (kept for W1-F):**
- **(d) — the term is elsewhere.** W0 checks it before the full walk is
  built; if refuted, re-attribute (wave commit / frames /
  `server.idle()` / derivation fan-out / structure-load) — the 30 % of
  wave wall the attribution saw in `server.idle()` (the memory-server
  flush drain) is the first suspect.
- **(d) — the structural gate is unsound** (T1 fails: liveness or
  loading depends on the walk's RUN). Fallback: the recursive-read-at-
  root shape (sound superset; ~10× cheaper; still fires on values).
- **(d) — the per-run ms does not drop** → the cost is in the tx read
  layer per activity, not the proxy — batch via `trackReadPaths` /
  attack the storage layer.
- **(d) — the scope mix is all-space** → (a) inert; harmless.
- **(d) — the liveness tripwire** — an unbracketed transition is silent
  starvation; T10 and the equivalence hook are the guard.
- **(d) — the D11 tripwire** — if "structural" is ever inferred from
  schema / code, scopes.md §9 trips; the read-class definition avoids
  it by construction.
- **(d) — the floor** — if sub-second needs the walk fully off the
  append path, (b′) is the follow-on; say so with numbers rather than
  stretch (c′).
- **(d) — the ruling** — if the owner rules the §1 sentence normative
  (option (b)), the redesign is a spec change: land the code DATED and
  the sentence as an amendment proposal; do not build a per-pair
  re-walk to satisfy a descriptive sentence. *Since 2026-08-18 the
  fallback's own sentence (§2F.4) is what needs a ruling: the landed
  (d′) text is RULED, so W1-F would replace a ruled sentence — a
  re-ruling.*
- **(e) — per-note growth persists** → C Q9's list (never-served
  instances growing `#entries`; the effects channel; UI sinks that OFF
  pays too); the linear ON-only residuals (whole-doc frames, the
  differential, patch apply) are outside `scheduler/run` and bounded
  only by compaction (OW24) — the strongest argument for scheduling it.
- **(e) — a missed wake** — the leg-C class (the browser bundle dropped
  the origin-ack wake once); pins 1, 9, 10 and the watermark backstop
  cover it.
- **(e) — the microtask timing** — the check must have run before
  `synced()` / `idle()` resolve after a frame (pin 10), or tests that
  await idle then read the overlay flake.
- **(e) — the mark ruling flips** (item 6 ruled "not sanctioned") →
  `consequenceOf` on the wire becomes owed (protocol §3/§7 frame
  change), and a value-plane read stays for drops / errors anyway.
- **(α) — the purge over-reaches** (drops a copy that is in flight, or
  one whose emitter's durable append lands in the SAME wave — the drain
  must then deliver it, which the ruled sentence requires); (α3)'s seat
  is unexamined by the lenses — the builder verifies and pins; the
  lunch gate is the live witness. *W3: the purge reaches QUEUED copies
  only (a dispatched copy is off the queue), so it cannot over-reach an
  in-flight one; the opposite gap — an in-flight copy sealing AFTER its
  wave closed — was the real l1 mechanism and is the late-seal refusal
  (α1b). A copy whose emitter seals into the same wave after the purge
  is delivered by the next drain, one cycle late, never lost.*
- **Process** — stacked PRs get no CI; a benchmark run with a configured
  LLM model is masked (the daytime greens); a source-run toolshed cannot
  bake the ON define; read toolshed logs with `/usr/bin/grep -a`.

## Appendix A — anchor offsets, `fb2292a24` → the tuning tip

The lenses cite `fb2292a24`; the trio's runtime (`2e9d86478` =
`b54bf5215`) moved these without changing them:

| site | `fb2292a24` | tuning tip |
| --- | --- | --- |
| `space-server.ts` `#loadDemandedStructure` | :2202 | :2329 |
| `space-server.ts` `#installDemandWalk` / the `JSON.stringify` body | :2502 / :2512 | :2629 / :2641 |
| `space-server.ts` `#demandersFor` | :1222 | :1286 |
| `space-server.ts` `#waveCycle` deadline decision (`exhausted = true`) | :2702–2708 | :2829–2836 |
| `space-server.ts` `#drainInFlight` (new in the trio) | — | :323 |
| `run.ts` fan-out resubscribe (`fanOutUnionLog`) | :605 | :627 |
| `overlay-destination.ts` `trackIntent` / `#scanIntentNotices` / `#intentSinks` | :586 / :730 / — | :724 / :886 / :269 |
| `cell.ts` LT1 in-process `queueEvent` (no `streamEntry`, no `onFailure`) | — | :1799–1819 |
| `scheduler/facade.ts` `dropEvent` / `dropQueuedEvent` | — | :2561–2579 |
| `wave.ts` C8d fold (`parentEventId`) | — | :2566–2590 |
| `executor/watermark.ts` `waitForSettled` | — | :62 |
| serving-loop.md §1:53–62 (the walk sentence) | unmoved | unmoved — until the acceptance commit (2026-08-18) replaced §1:57–62 with the (d′) text: now §1:57–89 |
| serving-loop.md §3b B7 / §7 / §8 | :388 / :1112 / :1165 | :423 / :1147 / :1200 — +27 after the acceptance commit: :450 / :1174 / :1227 |

*(The acceptance commit's +27 applies to every serving-loop.md anchor
below §1 on this branch; the code anchors below are untouched — the
acceptance changed no code.)*

**(d′) anchors — the tuning tip (= this branch's code), verified
2026-08-18 for §2:**

| site | tuning tip |
| --- | --- |
| `memory/v2/session-registry.ts` `SessionState.trackedIds` | :15 |
| `memory/v2/server-sync.ts` `trackedIdsFromEntries` | :87 |
| `memory/v2/query.ts` `toDirtyKey` / `fromDirtyKey`; `TrackedGraphState`; `trackGraph`; `extendTrackedGraph`; `refreshTrackedGraph` (affected-doc delete + re-evaluate `:646–663`); `loadFactsForDoc`; `evaluateTrackedDocument`; `snapshotForDocKey` (absent → `document: null`) | :877 / :882; :50; :379; :477; :592; :712; :794; :317 |
| `runner/src/traverse.ts` `trackVisitedDoc` (a followed link's target is tracked whether or not it exists) | :2175 / :2242–2253 |
| `memory/v2/server.ts` `watchSet` (full evaluation; `trackedIds` replaced `:3160`; `#notifyDemandChanged` `:3162`); `watchAdd` (`trackedIds.add` `:3349`; notify `:3360`); `syncSessionForConnection` (`:3617`; the incremental branch `refreshTrackedGraph` `:3768`, `commitEntities` adds `:3853–3858`; the full branch replaces `:3956–3960`); `watchedRootsForSpace`; `#notifyDemandChanged`; `ServerExecutionObserver.demandChanged` | :3067; :3182; :3617; :4104; :4240; :416 |
| `memory/v2/client.ts` `watchSetSync` / `watchAddSync`; `runner/src/storage/v2.ts` the runner's only watch sender (`watchAddSync`) | :827 / :865; :3844 |
| `executor/space-server.ts` `#demandSinks`; `#demandersByKey`; `#pieceRootByDemandKey`; `runDemanderResolver`; `noteDemandChanged` + `DEMAND_WAKE_GRACE_MS`; `#demandersFor`; `#loadDemandedStructure` (`keyOf` `:2347–2366`; sink cancel `:2391–2402`; arrivals `:2413–2429`, `:2600–2620`; walk install `:2589–2592`); `#installDemandWalk`; the single-flighted pass under the deadline; sink teardown | :419; :437; :444; :792; :898 / :268; :1286; :2329; :2629; :2778; :3294–3301 |
| `executor/host.ts` the `demandChanged` observer → `noteDemandChanged` | :117–121 |
| `scheduler/dependency-graph.ts` `isDemandRoot` (the three disjuncts today); `isLive`; `notifyNodeLivenessChange`; `setNodeProvisionalDemand`; `registerDependentsForWriterSurface` | :52–59; :61; :141; :183; :525 |
| `scheduler/facade.ts` `invalidateActionsForDemandRoots`; `transientEventDemandersFor`; `rearmNotCurrentFanOutForActor` (the not-current-for-pair shape); `updateMaterializerRegistration` (the bracket shape); `markProvisionalDemand`; `markNodeHasRun` (clears provisional demand after one run); `clearProvisionalDemandAtPassEnd` | :857; :891; :952–978; :2630–2638; :2640; :2652–2666; :2669 |
| `scheduler/fan-out.ts` `FanOutNodeState` (`instances`, `clean`, `dirtyGen`); `fanOutInstances`; `keyAtRatchet`; `keysOnChain` / `dirtyFanOutForCause`; `fanOutInstancesToRun`; `pruneFanOutInstances` | :55; :109; :187; :200 / :220; :250; :262 |
| `scheduler/scheduling-writes.ts` `writersByEntity` (name-keyed); `forEachOverlappingWriter`; `scheduler/keys.ts` `entityNameKey` | :58; :218; :59 |
| `scheduler/work-oracle.ts` `isInvalidOrNeverRan`; `isRunnableSchedulingSeed` | :80; :93 |
| `memory/v2/scheduler-basis.ts` `replaceSchedulerBasisRows`; `selectStaleBasisInstances` (activation's currency predicate) | :68; :117 |
| `runtime.ts` `serverRunDemandersFor` → `#serverRunDemanderResolver` | :2032–2035 |

## Appendix B — evidence

- The three lens reports, verbatim with history headers:
  [`stage-c/stage-c-lens-spec-blind.md`](../../history/plans/server-execution-v2/stage-c/stage-c-lens-spec-blind.md),
  [`stage-c/stage-c-lens-d-server-walk.md`](../../history/plans/server-execution-v2/stage-c/stage-c-lens-d-server-walk.md),
  [`stage-c/stage-c-lens-e-client-intent.md`](../../history/plans/server-execution-v2/stage-c/stage-c-lens-e-client-intent.md).
- The baseline: the
  [attribution](../../history/plans/server-execution-v2/stage-c/stage-c-attribution-report.md)
  and the
  [re-benchmark](../../history/plans/server-execution-v2/stage-c/stage-c-rebenchmark-report.md).
- The frozen record: the
  [stage-C closeout](../../history/plans/server-execution-v2/stage-c-closeout.md);
  the live state: the plan's "Coordination state"
  ([`../server-execution-v2.md`](../server-execution-v2.md)) and the
  register's §3
  ([`verification-coverage.md`](../../specs/server-side-execution/verification-coverage.md)).
