# v2 detail: client speculation

Normative spec for Phase 2 (overlay + authored writes) and the client
half of Phase 3. Assumes [README.md](README.md) §3.2 and
[events.md](events.md).

## Anchors (verified on main, 2026-08-02 — re-verify before coding)

- The ordinary client runtime runs the full graph; v2 does not add a
  speculation engine — it REDIRECTS the existing run's writes into an
  overlay instead of a storage transaction.
- Overlay substrate: the storage stack's transaction/journal layering in
  `packages/runner/src/storage/` (`extended-storage-transaction.ts`,
  `cache.ts`). The v1 branch validated "drop authority, keep the run"
  against this stack; the concept ports, the code does not.

## 1. The overlay, defined

- A client-side value layer keyed by (doc, path) sitting above the
  replicated store. Reads check overlay first, then store.
- Every entry records: `baseSeq` (the space seq the speculation ran
  against) and `origin` — either `intent(eventId)` (a locally fired,
  not-yet-consequenced event) or `input(bindingId)` (live UI input echo).
- The overlay is process-memory only. It is NEVER serialized, synced, or
  committed. On reload it is empty and the store is the truth.
- The seal emits an entry's document operations as WHOLE-DOCUMENT
  set/delete (`markWholeDocumentWrites`), and refuses a transaction that
  cannot. The ops are materialized over the confirmed value on every
  read, and that value moves under them: the space's serving runtime
  commits the authoritative derivation for the same document, and it
  arrives before the coverage that retires the entry (§4). A positional
  array splice re-applied over an array that already carries what it
  inserts duplicates that element, one that removed elements drops one,
  and a mergeable append double-applies — so an entry says what its run
  computed rather than how that differed from the layer it ran over. The
  mergeable intents the run recorded are abandoned with the ops they
  would have produced, so the reads those ops would have narrowed out of
  the commit stay in the entry's read set, which is what its retirement
  floor and its pending-read documents are built from. Pinned in
  `speculation-overlay.test.ts` and `array-push-mergeable.test.ts`.
- A standing entry therefore masks a concurrent authoritative change to
  any other path of the same document, until the entry retires and the
  arrived value renders. What a reader sees while it stands is a value
  some run computed, whole.

## 2. What may speculate

The optional
[view-scoped replication mode](../../features/view-scoped-client-replication.md)
restricts this permission to the computations selected from observed server
reads for mounted UI. Its client installs resident JavaScript bindings from the
stored graph without executing raw factories. A transaction with an unavailable
input aborts all writes and staged work, even if the authored body catches the
read failure. It parks on input and eligibility dependencies until its complete
local basis is usable. Invalidation never replaces a confirmed output with
`undefined` merely because an input was not replicated.

This mode consumes effect outputs directly, including their authoritative
pending/error fields; it does not hash omitted request inputs to synthesize
pending state. It also defers result-as-pattern materialization and raw
structural builtins. Producer currency requires a successful local attempt or
matching authoritative input/output fingerprints from a successful durable
serving settlement. A generation or store sequence alone does not establish
currency. The existing overlay and retirement rules below still apply.

- The membership test is the SCHEDULER TELL (RULED, owner 2026-08-07;
  protocol.md §1 carries the primary statement and the owner's
  rationale): ONLY scheduler-driven work moves to the server —
  scheduler-stamped derivation and handler runs are what divert here.
  Commits OUTSIDE the scheduler — setup/instantiation transactions,
  imperative creation (with its sanctioned `.pull`-for-round-one
  flow), UI bindings, widget edits — are the client's authored acts
  and commit as today. NO creation carve-out: a pattern instantiated
  within a lift/map/filter is a derived computation like any other,
  so its first run diverts even at instantiation. *(AMENDED 2026-09-09:
  a `cf` client sends its instantiation verb to the serving runtime
  instead of committing it itself — protocol.md §1's lifecycle-verb
  amendment; nothing about that speculates. AMENDED 2026-09-11: its
  source-update verb likewise.)*
- Pure structural nodes: freely.
- Handlers: run locally on fire, writes go to the overlay (events.md §2);
  the committed artifact is the event only.
- Effectful nodes (`fetch*`, `generate*`, `sqlite*`): NEVER execute
  client-side. A speculative read of such a node returns its last
  committed result (read-through). If inputs changed so the memo key
  differs, the node reads as pending — the UI shows its ordinary loading
  state until the server's result arrives. No exceptions: no "just this
  one idempotent GET". OBLIGATION for the read-through's memo-key
  comparison (pinned 2026-08-22, inherited by the arrival-witness
  train's read-through work): a session-scoped CLEARED `sqlite*`
  result's request hash is session-keyed (builtins.md §2), so a
  read-through that recomputes the key must reproduce the session
  component — or key the comparison on the STORED claim's recorded
  identity — a session-blind recomputation would misread "inputs
  changed" for every such node.
- `navigate-to`: may enact optimistically (protocol.md §5) — navigation
  is reversible. The overlay records the nonce it acted on, and stands
  aside when that nonce is already recorded: the authoritative intent
  reached the channel and enacted before this speculative run sealed,
  which is the ordering whenever the served round trip beats the
  client's own run of the same handler. When the
  AUTHORITATIVE run's branch computes NO navigation (a speculative read
  diverged — the 2026-08-27 r06/r09 root cause, register OW45), the
  optimistic enactment STANDS: ruled PUNT (owner, 2026-08-27) — the
  client navigates, so be it. Nonce reconciliation covers only the
  intent-arrives case; no withdrawal mechanism exists, and consumers
  (tests included) must be robust to the view resting where the
  speculative branch left it.
- Child-piece instantiation (builtins.md §3): result-as-pattern
  children MAY instantiate speculatively, overlay-local (owner,
  2026-08-02 — reversing the earlier no-children rule). Child ids
  derive from cause, so the speculative child converges with the
  authoritative one by identity when the push arrives; overlay
  containment applies — the child's registrations and writes are
  overlay-side, nothing commits, and they retire with their origin
  entry on reconcile (§4). `compile-and-run` children are NOT
  speculable (compilation is an effectful step): that branch renders
  its ordinary loading state until the authoritative push delivers
  the child (runtime-mapping.md N37/N38).
- **Unreplicated inputs**: a speculative read of a doc/path the client
  has not replicated is PENDING for that branch — speculation NEVER
  blocks on a fetch and never triggers a network read. The branch
  renders its ordinary loading state and reconciles when the server's
  derived value arrives. (The server discovers the same read by running
  with the store local — serving-loop.md §3b; the asymmetry is the
  point.)

  **Unresolved lift inputs are PENDING, not `undefined` (RULED
  2026-08-21 — the OW51 fix; the serving runtime matches the client
  exactly).** The rule above is stated for a doc the reader has not
  replicated; its edge is a lift whose input LINK CHAIN dead-ends at a
  hop-target doc the local replica cannot serve yet (the doc has not
  arrived, or does not exist). Such a read does NOT hand `undefined`
  into the lift body — nothing about the value is knowable, so a body
  whose schema promised a value would crash on the `undefined` (the
  OW51 `splitDefinitions` TypeError, observed on BOTH the client and
  the serving runtime because the read path is shared code). Instead
  the lazy read REFUSES (when the reader's schema PROMISES a value —
  see the carve-outs below): it registers the dead-end doc's read (the
  dependency that re-triggers the run when the doc arrives) and the run
  is disposed as a non-event — **output `undefined`, no action failure,
  re-triggered when any of its reads so far change, exactly like a
  regular call whose inputs were not ready.** Scope, precisely (#6179
  review, item 5b): the refusal is on the SCHEMA-aware lazy read path
  only — a SCHEMA-LESS read takes `validateAndTransform`'s
  query-result-proxy early-out before resolution and so never reaches
  the gate (consistent with the mismatch/refusal machinery, which has
  always been schema-path-only; compiled patterns are schema'd). The
  owner's ruling, verbatim:

  > (a), server-side should match the current client behavior exactly.
  > also note that with the lazy proxy based evaluation a lift can
  > throw a specific error and mark a tx aborted with that reason and
  > that should also be handled just like an unresolved input, i.e.
  > being retriggered when any of the reads so far change (just like a
  > regular call), and the output being `undefined`.

  — owner (Berni), 2026-08-21. Two clauses, both RULED and built:

  1. **The unresolved read refuses.** Link resolution marks a dead-end
     behind a followed hop (`pendingHopDoc`); the lazy read path
     throws `UnresolvedInputError` (a `SchemaMismatchError` subclass,
     so the action-run boundary's existing "argument did not resolve"
     disposal treats it identically — §4's reconciliation is
     unchanged). This applies ONLY when the reader's schema declares
     NO default: a declared default is the stated absent value and
     still flows (the `get() ?? fallback` idiom, and a computed that
     has not produced yet, are unchanged). A dead-end at the reader's
     OWN root doc is likewise not this shape — a locally-minted cell's
     doc does not exist until its first write. Nor is a dead-end at a
     USER- or SESSION-scoped instance row (RULED 2026-08-21, the
     option-3 build): a principal's row exists only once that
     principal writes it, so its absence is knowledge — the scoped
     first-write idiom — and the fan-out run supply materializes
     instances by running derivations over exactly such absent rows.
     Only a missing SPACE-scoped doc behind a hop is an unresolved
     input; composition does not change the verdict (a per-user cell
     relayed through a nested pattern's arg doc reads its absent row
     as `undefined` exactly as the flat form does). One window sits
     outside this protection, matching main: a scoped row already
     written elsewhere (another device; a cold or lagging serving
     replica) is transit, not knowledge — such a mid-arrival read
     takes main's interim-undefined-then-heal. No shipped pattern
     routes link chains through user-scoped docs (the #6179 review's
     population audit).
  2. **A lift that THROWS the error takes the same disposition.** The
     refusal propagates out of the lift body (the body did not catch
     it) and produces an undefined result through the ordinary result
     path — the same non-event disposal, re-triggering on the reads so far. A
     pattern body cannot yet MINT the error itself (it is
     runner-internal; a pattern-facing refusal export is a flagged API
     question with the owner), so the built coverage is the
     read-propagation path — the OW51 shape — with the deliberate
     body-throw awaiting that export.

  **The serving-side re-trigger, explicit (RULED 2026-08-21 — the
  option-3 ruling on the demand-closure fork):**

  > client-side doesn't react to its own writes, server should do,
  > but i'm not sure this is about that. what does self-demanded
  > mean? either way, option 3 sounds good

  — owner (Berni), 2026-08-21. A refusal-disposed SERVED run's
  re-trigger is independent of the root-level arrival re-arm: the
  disposed run's committed log (the registered dead-end read
  included) joins its node's union subscription, and the awaited
  doc's arrival — from ANY writer, the serving loop's own work or a
  foreign session — cause-dirties and re-runs exactly the covered
  instances. The root-level machinery structurally cannot substitute:
  a disposed instance is CLEAN (its ruled interim output `undefined`
  is its current value), and every root-level re-arm keeps clean
  instances, so only the registered read can re-fire it. Pinned in
  `executor-dprime-w0.test.ts` ("OW51 refusal re-trigger"),
  mutation-verified on the clean-bit seam.

  Implementation: `link-resolution.ts` (`pendingHopDoc` /
  `viaLinkHop`), `schema.ts`'s lazy branch, `schema-view.ts`
  (`UnresolvedInputError`); pinned in
  `packages/runner/test/unresolved-input-lift.test.ts` (the hop-target
  dead-end disposes and re-triggers on arrival; the stated-null
  control still flows; its case has no previous result, so it does not
  pin that one is overwritten), with the serving-runtime match
  witnessed by `integration/default-app.test.ts` greening ON (the
  surface whose serving-runtime crash first recorded the bug —
  verification-coverage.md OW51).

## 3. Rendering

Rendering reads through the overlay, so the actor sees handler
consequences immediately (echo) and everyone's UI reads identically
through one code path. There is no "speculative styling" requirement in
v2; divergence handling is value replacement (§4), not UI annotation
(RULED 2026-08-02: replacement IS the reconciliation UX — how
conflicts render today; no divergence surfacing ships in v2).

## 4. Reconciliation, exactly

On each pushed `derived` commit with `derivedThrough = W` and
`consequenceOf = [E...]`:

1. Apply the commit to the local store replica (existing path).
2. Retire overlay entries whose `origin` is `intent(e)` for `e ∈ E` —
   the authoritative consequences (or, for a dropped event, its
   notice — events.md §5) now exist; the echo's job is done. This is a
   condition on STATE, not on arrival order (stage C tuning T2,
   2026-08-18; **RULED 2026-08-18** — ratified as written: a
   speculative preview of an event the server has already completed
   has nothing to add and can only mislead): an echo of `e` sealed
   AFTER `e`'s terminal consequence (consequenced, errored, dropped, or
   refused) has already arrived at this client — the local dispatch
   ran late (a load-parked head event, a busy worker) — is jobless on
   the same grounds and is NOT registered: its writes are dropped
   before any layer is sealed. A
   non-idempotent handler's late echo is divergent by construction (it
   re-toggles the already-served state), and its floor sits at the
   served commit's seq, above every W reachable until the next authored
   input, so it would otherwise stand indefinitely and hide the served
   value (the two-browsers lockdown chip's 48-s / 300-s stalls; #5969's
   late castVote echo). Impl: `overlay-destination.ts`
   `#terminalIntents` at `#sealSpeculative`; pinned in
   `speculation-arrival-gate.test.ts` (the late-echo rule, scripted,
   with its mutation).
   *Clarification (2026-08-19, stage C W2.1 — DESCRIPTIVE, the same
   rule read at its other edge; not a new rule):* the jobless-cascade
   consequence applies on ARRIVAL too. Retiring `e`'s echo when `e`'s
   terminal consequence arrives also retires every overlay entry that
   is a CLIENT CASCADE DESCENDANT of `e` — the echoes of the events
   `e`'s speculative run itself sent, sealed under client-minted
   cascade ids (`mintEventId(link, originTx)`, a per-attempt mint —
   events.md §4) that the server's own run of `e` never mints (it mints
   its own for the same cascade, and the handler-frame-caused entity
   ids of the two runs differ likewise), so no mark ever names them and
   step 3's arrival gate never passes for them: they are jobless on the
   same grounds as a late cascade echo (W0 l3's "duplicate join" —
   spec-Alice standing beside the confirmed Alice, forever). Scope,
   exactly: only entries whose cascade thread (`parentEventId`,
   recorded at seal) reaches `e` — client-minted descendants of `e`'s
   speculative run, never a durable entry of its own (a root fire's
   echo carries no thread; another intent's cascade does not reach
   `e`); a retired descendant's id joins the jobless set so a LATE
   grandchild drops at seal. Cost, stated: when the server's LT1 child
   of `e` did not complete in `e`'s appending wave (events.md §4's
   purge; the drain delivers it a wave later), the descendant echo goes
   at `e`'s consequence while the child's own consequence is still a
   wave away — a visible one-wave flicker, COUNTED
   (`cascade-echo-retired-unarrived`), not hidden; the owner-level
   alternative (deterministic cascade ids derived from the parent id +
   send ordinal on both sides — which would also make the frame-caused
   entity ids agree, so the arrival gate would carry the echo to the
   child's own landing) touches this section's per-attempt mint and is
   NOT taken here. Impl: `overlay-destination.ts` `retireIntent` (the
   cascade arm) over `OverlayEntry.parentEventId` + `#cascadeParents`;
   pinned in `speculation-intent-listener.test.ts` (W2.1-1…4 scripted,
   each with its mutation, + the W2.1 e2e lunch-join shape, RED on the
   pre-W2.1 tip).
   **The match, and its carrier (RULED 2026-08-18 — the stage-C design
   pass, items 5/6, landed with W2):** the match is on the pushed
   commit's `consequenceOf` — carried to the client as the TRACKED
   entry's own `consequenced` / `status` / `error` fields (events.md
   §5's T7 semantics: written as that event's consequence, retiring
   with the entry at compaction — not a processed-events table), which
   are SANCTIONED as the client's consequence carrier; `consequenceOf`
   does NOT go on the wire. Two guards bind: the client reads the
   tracked entry ONLY — its own terminal fields and, on a drop, its
   reason for the UI hook — never whole-history and never as a
   dependency on HISTORY; and the read is always BACKSTOPPED by
   `W ≥ seq(e)` / `eventWatermark ≥ seq(e)` (item 9: an intent-origin
   entry whose signal was missed retires on coverage — step 3's sweep
   serves both origins). **The client keeps a stream subscribed while
   it has intents outstanding on it** (item 8): the sidecar doc it
   appended to stays watched — the minimal watch; the `eventWatermark`
   write on that doc is the delivery vehicle in practice — so the marks
   arrive; the watch is a NON-REACTIVE storage-notification listener
   keyed on the outstanding set, outside the scheduler (item 4 — no
   effect, no transaction, no CFC probe, no demand edge, never a
   dependency on history). Its cost, as built (W2; the ruling says
   nothing about cost): a notified check runs in a microtask and
   costs O(outstanding + hinted indices) — a hint that misses (the
   index moved) or a change with no index (an append) degrades to a
   raw backward scan over the entries appended AFTER the tracked one,
   a plain array walk, O(k) per notification while an intent stays
   outstanding on a busy shared stream; and the immediate check at
   `trackIntent` walks the raw array once, O(E), for an id whose entry
   is not yet present (the T25 re-fire needs it). Impl:
   `overlay-destination.ts` `trackIntent` / `#checkIntents` over
   `speculation/doc-notification-listener.ts`; pinned in
   `speculation-intent-listener.test.ts` (pins 1–11, each with its
   mutation or OFF witness, plus the review pins) and re-seamed in
   `event-append-client.test.ts`.
3. Retire overlay entries whose `origin` is `input` once their authored
   commit is acked AND `W ≥` that commit's seq AND — the ARRIVAL GATE
   (RULED 2026-08-16, landed with fan-out stage A) — every doc INSTANCE
   the entry wrote holds a CONFIRMED value at seq `≥` that floor (the
   authoritative derivation for the instance this client reads has
   ARRIVED; what counts as the witness at exactly the floor is the
   arrival-witness predicate, RULED 2026-08-22 — the arrival-gate
   paragraph below) — regardless of value agreement (the store wins);
   keep live-input echoes whose authored commit is still unacked or not
   yet covered by `W` (the user is mid-typing), and keep echoes whose
   written instance the store has not yet spoken for (nothing to win
   with — see the arrival-gate paragraph below).
4. If any local intents remain un-consequenced (offline queue, in-flight
   events), re-run their speculation against the fresh store state so
   the echo rebases instead of going stale.

Divergence is silent by default: the authoritative value replaces the
speculative one in the same render path — the simplest thing, and
exactly how conflicts render today (RULED 2026-08-02). No flicker
suppression beyond what rebasing gives.

Stated honestly (RULED 2026-08-07; owed from the wedge round), and
scoped to step 3's INPUT-origin entries — step 2's intent-origin
entries retire on their event appearing in `consequenceOf`, which IS
the authoritative consequence arriving: coverage of an entry's BASIS
alone carries no by-construction guarantee that the store HOLDS what
won at withdrawal time (W covers DEMANDED derivations; nothing about
an entry's own output riding the covering wave is implied). What makes
coverage-based retirement safe is the serving loop's first-round
reliability machinery — the demanded-structure loads with their
counted, retried deferrals (serving-loop.md §7's
`structureLoadDeferred` / `structureLoadFailures` counters over §1/§3's
per-cycle load pass) — which makes the demanded derivation exist and
land. That premise is FALSE for a scoped instance the server never
serves (before the fan-out run supply, every per-user derivation is
such an instance — the demand registry keeps no identity for a
space-scoped root; and after it, any per-user instance the server's
demand set does not reach — the stage-B walk's coverage then, and under
serving-loop.md §1's (d′) sentence an instance no client session
tracks), and coverage without arrival is then the
retire-to-nothing loop the P7 review recorded as OW32: the echo dropped
to nothing, the writer — a reader of its own output through the
scope-narrowing write path — re-derived, re-speculated, retired,
forever, at ~80 ms cycles bounded per pass only by the scheduler's
budget.

**The arrival gate (RULED 2026-08-16 — owner, on the fan-out design
panel's recommendation; landed with fan-out stage A):** step 3
additionally requires ARRIVAL — every doc instance the entry wrote
holds a confirmed value at seq ≥ the entry's floor. The panel's
rationale: the gate is the client's BACKSTOP for demand-walk coverage
gaps (fan-out design §E residual 4) and the first-demand transient (§E
residual 1 — a node whose basis W already covers at speculation time
retires before the server's first wave lands), and it is independent
of the server half: it treats the SYMPTOM (a never-served instance
flips to nothing) while stage B's fan-out run supply fixes the CAUSE
(the instance is never served). Consequences, exact: a served node
still retires the moment its derived value arrives — the watermark
write rides the same wave commit, so the covering sweep sees the
value; an echo whose instance nobody serves persists as the client's
own value (correct rendering; no durability of per-user derived values,
of which there was none before either); an unchanged authoritative
value (equality cutoff — no rewrite, so the doc's seq stays below the
floor) leaves the echo standing rather than retiring it, which is
value-identical. Stated as an ASSUMPTION, not a guarantee (fan-out stage
A's independent review, finding 7): the sweep has no arrival trigger of
its own — it runs on the watermark sink, the origin-ack observer, and
chained settlements — so "retires the moment its derived value arrives"
holds because a wave's derived doc and its watermark advance ride ONE
frame per session and the replica applies every record of a frame before
it notifies; a written doc that arrived in a LATER frame than the
covering watermark, or one the client never watched, keeps its echo
until the next watermark event (value-identical when the values agree;
otherwise the echo hides the authoritative value that long). An arrival
re-sweep is the owed follow-up if that coupling ever loosens (recorded
in verification-coverage.md's stage-A delta). **LANDED (stage C tuning
T2, 2026-08-18): the coupling DID loosen — an EXHAUSTED wave carries no
watermark movement (serving-loop.md §3: its `derivedThrough` is frozen),
so its derived values arrive DECOUPLED from W, and with the honest flush
deadline (T3) exhaustion is the routine shape of a busy wave. The
replica now fires an ARRIVAL wake
(`ISpaceReplica.speculationArrivalObserver`) at the end of integrating
any frame that moves a doc's confirmed seq forward, and the overlay
re-sweeps the space when an arrived doc is one some live entry WROTE.
The gate's predicates are UNCHANGED — arrival is a second, EARLIER
trigger, never a relaxation of coverage (`W ≥ floor`) or of the arrival
gate itself; the sweep re-evaluates both on replica state at every
trigger, so the wake can only retire an entry the next watermark event
would have retired anyway (the store has spoken for the instance at seq
≥ the entry's floor: the derivation the gate waits for HAS landed).
Pinned in `speculation-arrival-gate.test.ts` (the E2 shape end to end,
mutation: wake removed → the entry stands until an unrelated commit;
scripted: an arrival for an unwritten doc sweeps nothing, an arrival
while `W < floor` retires nothing).** **The arrival-witness predicate
(RULED 2026-08-22 — owner, on the OW33 fork memo's recommendation): a
confirmed cover WITNESSES arrival for a written doc when its seq is
STRICTLY ABOVE the entry's floor — whatever its commit class: the
store has spoken past everything this speculation consumed — or when
it sits AT the floor and its covering commit is DERIVED-class
(protocol.md §1's producer vocabulary): the legitimate at-floor
arrival is a re-derivation whose run read the already-arrived value
at that very seq. An authored-class cover at the floor is the entry's
own basis commit — the setup write that created the computed docs'
structure (the client's own for a new instance, a prior session's for
a resumed one) — and never witnesses the derivation's arrival: the
class-blind gate retired first-run speculations on it 40–260 ms
before the served value landed, the ruled sentence's own excluded
class (the OW33 hole). A cover whose class the replica does not know
(an OFF-arm or pre-predicate frame) does not witness at the floor
either — fail toward the standing echo (value-identical in the
observed arms; an unknown-class cover at the floor could be a foreign
write whose value differs, and the next cover settles it), never the
undefined read. A `system`-class cover at the floor does not witness
either: the predicate demands the derivation itself — `derived` — not
merely a server-side write (`!== "derived"`, conservative, converging
on the next cover). The elision posture above is unchanged: no rewrite
means the doc's seq stays BELOW the floor, and the predicate is never
consulted. **A content-addressed doc the store holds witnesses at ANY cover seq
(#6304, 2026-08-25): its stored envelope is immutable — admission
refuses every operation but `set` against a `cid:` id outright, and a
`cid:` set unless the whole stored envelope, metadata included, is
value-equal;
identical rewrites are elided — so its cover never advances and the
floor comparison can never pass for it. The witness rests on that
commit-boundary immutability: a metadata-write carve-out for `cid:`
docs (a label merge for two sources of one hash, say) would have to
revisit it.
Nothing newer can be pending at the id, and retiring the layer
renders the STORED value whatever the layer holds: the store wins,
the disposition every divergence gets (a divergent speculative cid
layer is inadmissible content that can never arrive; holding the
entry for it would strand the entry, and its sibling layers,
forever). A cid doc with NO confirmed cover still holds the entry:
nothing has served the schema document yet. Pinned in
`speculation-arrival-gate.test.ts` — scripted with its mutation, and
on a real replica for identical, divergent, and unstored cid
writes.** Carriage: the covering commit's class rides session-frame
upserts as `coverClass` (populated only under the flag — the OFF wire
is byte-identical), is recorded on the replica's confirmed record
(frames on integrate; `authored`/`derived` at own-commit promotions),
and reaches the sweep through `speculationRetirementView`. Pinned in
`speculation-arrival-gate.test.ts` (both observed arms replayed
red-first from the decoded store shapes; elision, at-floor-derived,
and above-floor-any-class both-sides; mutation-checked in both
directions) and `v2-cover-class-frames.test.ts` (the frame carriage,
both arms).** Two riders ride with the
gate: SUPERSEDE-BY-NEWER — a
newer entry of the same writer whose WHOLE-DOC ops cover every doc an
older entry wrote retires the older one at seal (the drop of a lower
layer under an upper whole-doc layer is invisible; a patch is
path-relative to the layer beneath and never supersedes), bounding
entry growth for a never-served instance that keeps changing; and
OWN-RETIREMENT-IS-NOT-A-TRIGGER — the `integrate` a retiring echo
produces carries the echo's own transaction as its source, so the
scheduler treats the flip of an action's own output like its own
commit and does not re-run the writer for it (a divergent
authoritative value would otherwise re-derive, re-speculate, retire,
and flip forever); downstream readers are unaffected. Impl:
`packages/runner/src/speculation/overlay-destination.ts` (`#sweep`'s
gate, `#supersedeOlderEntries`), the replica's superseded flip
(`finalizeSupersededSpeculation` — `IIntegrateNotification.source`),
and the scheduler's own-source skip (`scheduler/invalidation.ts`);
pinned in `speculation-arrival-gate.test.ts` (each with its mutation).
The measured effect that motivated the ruling (the OW32 triage's
prototype, 2026-08-16): 45–56 k → 55–137 client action runs per
5-minute two-browser gate, zero non-settling episodes, `runtime:idle`
resolving, both two-browser gates booting in < 3 s.

## 5. Offline

- Events accumulate locally in fired order (events.md §5), speculation
  stands, the overlay grows. On reconnect: discharge queued events in
  order, then reconcile as pushes arrive (RULED 2026-08-02). A
  discharged event whose handler conflicts is DROPPED server-side;
  its dropped-event notice (eventId + reason, events.md §5) retires
  the event's overlay entries — the echo un-renders instead of
  lingering as false state — and is the UI's hook to react (the UI
  treatment is a follow-up; components that send authored commits
  already handle conflict feedback gracefully today, and events
  reuse that posture). Overlay memory is bounded by pending-intent
  count.

## 6. Tripwires

FORBIDDEN client-side under the flag: constructing a `derived`-class
commit; committing any handler write; executing an effectful builtin;
persisting the overlay; sending overlay contents to any server; deciding
"the server is wrong" (there is no client arbitration — the store wins,
always, by construction).

### The process-local principle and the export refusal (RULED 2026-08-13)

Overlay entries are PROCESS-LOCAL: their localSeqs exist only in the
client process, so a pushed commit whose read basis names one carries a
wire pending-read dependency the server can NEVER resolve — and only
the client can know that (the client knows which of its layers are
speculative; the server cannot distinguish a dependency that is never
coming from one that has not arrived yet). "Sending overlay contents to
any server" above therefore includes the BASIS, not just the values.

The rule: a commit basis MUST NOT name a speculative layer. The export
path REFUSES to build one — a loud, terminal, client-side failure
(`SpeculativeBasisError`; never retried — a retry would re-read the
same live echo and refuse identically) raised BEFORE the optimistic
apply, so nothing renders, nothing reverts, and nothing reaches the
wire. Anything that slips through or pre-exists is caught twice more:
a `ConflictError` whose commit names a known-speculative layer is
upgraded to the same terminal refusal at the push boundary, so the
convergence-retry loop is bounded-and-loud instead of infinite for
dependencies that cannot resolve. Pre-fix, this exported as
`pending dependency not resolved` and spun the scheduler's whole retry
window per event (~43 attempts / 30s observed) against an echo that
was never going to push.

The ruling that fixed the direction (owner, 2026-08-13):

> since only ui components land here and they don't use intermediate
> values like this, we're not going to hit it. so let's fix infinitely
> stuck things but otherwise go for what adds the least amount of
> complexity. e.g. fine to just outright, but loudly, fail those.

Rebase-to-confirmed / CAS-translation machinery for authored writes
over speculative bases was CONSIDERED AND REJECTED with that ruling:
UI components do not commit authored writes derived from intermediate
speculative values, so the added complexity buys nothing shipped.

### The blind-write reads that consume no overlay value (RULED 2026-08-21)

The refusal above is about DEPENDENCIES — a basis entry stands for a
value the commit consumed. A blind UI-input write (the
`markUiInputBlindWriteTx` family: a user's scalar `$value` overwrite,
last-write-wins by design) consumes no overlay value, so the two read
classes such a transaction contributes to its commit basis base on the
doc's NON-speculative stack — confirmed state plus durable in-flight
layers, speculative layers excluded — instead of turning the user's
own typed input into a terminal refusal whenever one of their own
echoes still stands (an echo's standing window is at least a full
served round trip, and unbounded for a never-served instance):

- The structural existence/shape precondition — the nonRecursive read
  at the cell's parent (verification-coverage.md OW47's close;
  `excludeSpeculativeLayers` in `SpaceReplica.#buildReads()`).
- CFC prepare's internal-verifier reads (OW47's second producer, the
  name-draft triage; RULED 2026-08-21 — arm (b) of the triage's §9
  fork): the verifier READS and VERIFIES the non-speculative state.
  The verifier's job is the durable policy state the server will
  enforce against — an overlay layer never reaches the wire, so
  deriving policy from it would verify state the server can never
  see — and the basis named for these reads is the same durable layer
  set, so verify-durable and name-durable always travel together
  (never verify-overlay + name-durable).

The verifier read's commit-set entry is scoped to what it CONSUMES —
the stored-metadata read sits AT `["cfc"]`, never at the document
root. A root-recursive read made the whole document a value
dependency at the reader's confirmed basis, and the blind fill's
basis lags exactly while its own echo stands (the arrival window), so
the covering served commit's value patch conflicted the fill
server-side as a stale confirmed read — the same silent loss through
the staleness pin instead of the layer-naming pin. A concurrent
`/cfc` change still conflicts: that is the precondition the ruling
kept when it chose basing over dropping the read class entirely.

One read class is exempt from BOTH halves: a CONTENT-ADDRESSED
(`cid:`) document's content is identical on every layer and at every
seq — the engine and every replica refuse content that does not hash
to its id — so a cid: read carries NO commit-time concurrency
precondition at all. The verifier consumes the ordinary view (which
IS the durable content), and the read contributes no conflict-set
entry whatsoever: neither named layers nor a confirmed-seq basis.
There is no staleness for the engine's scan to find, and a
resolution served from the overlay or the realm registry would
otherwise export an unsatisfiable `confirmed {seq: 0}` for a doc
whose first install is a real revision row; presence is owned by
server-side closure validation. The exemption matters during the
echo's arrival window: the echo's staging carries the schema
documents its writes reference, the covering SERVED commit already
persisted the same documents server-side, and the client's own
durable copy can lag — serving the verifier "durably absent" there
turned the fill into CFC prepare's silent stored-schemaHash-missing
abort, the same loss one layer deeper. Resolution is location-indifferent one step further:
stored `/cfc` metadata can reference a schema document NO replica
view holds (a frame delivers metadata without its schemaHash refs),
so `loadSchemaDocument` falls back to the realm schema registry —
which holds only content verified against its hash, and which the
metadata-stamping site itself populates (`ensureSchemaDocument`
registers what it writes: whoever stamped the reference held the
content, the standing echo's own derivation included).

Both exclusions are about the NAMED BASIS of one commit, never a
withdrawal: the echo itself stands until its ordinary retirement
(§4). Value-consuming reads keep the refusal unchanged in every
transaction shape, and a transaction outside the blind-write family —
including its verifier reads — keeps naming every layer, unless it
carries the durable-read mark below; `speculation-overlay.test.ts`
pins the export, the scoping, the verify-durable consistency, the
content-addressed exemption, and the durable-read mark on both a
direct transaction and a piece start.

### The durable-read mark, and the piece start that needs it

An authored transaction whose writes must reach the wire can read the
durable replica view instead of the ordinary one. `markDurableReadTx`
(`storage/reactivity-log.ts`) is that mark: values and named basis
both skip the process-local speculation layers, so what such a
transaction consumed and what it names stay the same set — the
verify-durable and name-durable pairing again, one shape wider. A
document still short of its authoritative value re-derives reactively
once that value lands, which is the recovery path §6's refusal
message names. Two callers carry the mark. One is the direct SQLite
capability's exec, an authored write with no reactive run around it.
The other is the runner's piece start.

A piece start mints its own transaction, instantiates the pattern's
nodes into it, and commits it fire-and-forget as sanctioned
bookkeeping (serving-loop.md §3d). It reads whatever the node
bindings resolve through, which is as likely to be a document a
standing echo rewrote as any other. Naming that echo's layer turns
the start's commit into a terminal refusal, and the arm that catches
one retires the piece's whole registration — taking with it the event
handlers its graph installed, so the next send to one of those
streams finds no handler and the scheduler drops the event. A list
that grows by handler sends stops growing, one send at a time, with
no error anywhere near the send. Reading durably is what keeps that
commit exportable. The mark covers a transaction the runner mints
for itself; a start handed a caller's transaction keeps that
caller's read semantics. A start that waits for a piece's
execution family mints a SECOND transaction once that family
lands, and that one carries the mark when the transaction it
continues did — the view the start read before the wait is the
view it commits against after. Without it a standing echo over
the child's argument enters the authored commit's basis, and the
refusal above takes the child's registration with it.

One retirement wake completes the ruling's "fix infinitely stuck
things" half (§4's evaluation detail): a sweep that runs while an
origin's accept verdict is still in flight skips its entries as
blocked, and on a then-quiet space the covering watermark event has
already passed — so the replica signals origin ACKS to the overlay
(`speculationAckObserver`) and the overlay re-sweeps. Rejected origins
already reached it through the dependency cascade; accepts had no
client-side wake, and an entry whose origin's verdict landed after the
covering watermark stayed pending forever.
