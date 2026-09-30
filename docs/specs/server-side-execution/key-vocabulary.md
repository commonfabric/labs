# v2 inventory: the key vocabulary (scopes.md §7 M2)

Normative inventory for the M2 re-keying, plan Phase 1 stage E —
LANDED (the nine §1 sites construct instance keys via the shared
vocabulary). Read [scopes.md](scopes.md) §7 first; this document
assumes its vocabulary. §3 records one ruling of its own — LD3, the
shared `scope_key` vocabulary (owner, 2026-08-03).

M2 said every in-memory identity key used the scope NAME and never
the `scope_key` — sound only at cardinality 1, and broken the moment
one runtime holds every principal's instances. M2 named three
subsystems; the closure of STORAGE-ROW-ALIGNED identity construction
— every key that must match a storage row's exact `scope_key`, which
is what stage E re-keyed — is NINE construction sites (§1). Name-keyed
identity structures that are not storage-row-aligned remain,
deliberately: §5 is their inventory, each with a disposition. This
page is the inventory both lists are held to — §4's tripwires police
it.

## Anchors

Paths are relative to `packages/runner/src/` unless another package is
named. The `scope_key` vocabulary lives in the wire-shape module (LD3,
§3): `resolveScopeKey` plus the parse/inspect helpers
(`packages/memory/v2.ts`, beside `CellScope`), producing `space`,
`user:<principal>`, `session:<principal>:<sessionId>` (components
encodeURIComponent-encoded, so `:` splits segments exactly). The
shared validator `isScopeKey` accepts exactly the constructor's image:
every segment must be the CANONICAL encoding — no raw `/` or `:`
inside a segment, no malformed or non-canonical percent escape — and
malformed input refuses (false), never throws. Admission gates on it
wherever an explicit key ARRIVES rather than being constructed (the
derived-commit annotation check in `applyCommitTransaction` and the
wave basis-instance check in `applyWaveCommit`, both in
`packages/memory/v2/engine.ts`), so a non-canonical key is refused at
the door instead of keying a storage row that later corrupts
`/`-delimited composite addressing or throws when a serving surface
percent-decodes it. Storage rows are keyed `(branch, id, scope_key)`
(the `head` primary key in `engine.ts`; `revision` extends it with
`seq` and `op_index`), constructed at admission through the same
shared definition (`applyCommitTransaction`).

## 1. The nine sites

Each site keys per scope INSTANCE: the shared constructor over
(scope, identity), where the identity arrives WITH the work — in the
OFF arm, the runtime's own authenticated session
(`Runtime.scopeKeyIdentity`, delegating to
`IStorageManager.scopeKeyIdentity()`).

| # | site | instance key | required instance dimension | identity source AT that site |
| --- | --- | --- | --- | --- |
| 1 | `scheduler/keys.ts` — `entityKey(address, identity)`, type `SpaceScopeAndURI`; the dependency-graph node key (also the composite constructor `addressesToPathByEntity` in `reactive-dependencies.ts` builds through) | `` `${space}/${scope_key}/${id}` `` | the READ instance: dirtiness must match storage's exact-`scope_key` row keying, or one principal's commit wakes every principal's node | threaded per call from the scheduler's state (`scopeKeyIdentity` thunks wired to the runtime) |
| 2 | `runner.ts` — `resultPatternCache` and `#writeJavaScriptActionResult`; N37's memo | `` Map<`${space}/${id}`, Map<ScopeKey, string>> `` | the ACTION instance whose result pattern is cached — two instances may resolve to different patterns | the run transaction's identity, falling back to `runtime.scopeKeyIdentity` |
| 3 | `runner.ts` — `JavaScriptActionResultCells.byScope`, selected by `#writeJavaScriptActionResult` | `Map<ScopeKey, Cell<any>>` | one result cell PER INSTANCE, not per scope name: a name-keyed `byScope.get("session")` would return one cell where the server needs one per session | the run transaction's identity, falling back to `runtime.scopeKeyIdentity`, resolved over the discovered `effectiveOutputScope` |
| 4 | `data-updating.ts` — `seedMemoKey(link, identity)`; dedupes eager scoped-property seeding | `` `${space}/${scope_key}/${id}` `` | per instance — one instance's presence must not suppress another's seed; at fan-out one USER's presence must not suppress another's | `runtime.scopeKeyIdentity` at the call sites |
| 5 | `traverse.ts` — coverage key `isLinkedDocumentCovered` passes to `schemaTrackerCoversSelector` (constructed via site 6's `getTrackerKey`; consulted only for links that DECLARE a scope — an unscoped link refuses coverage explicitly, see the OFF-ARM NEUTRALITY note at the site) | `` `${space}/${scope_key}/${id}` `` | per instance read: coverage proven for one instance is not coverage of another | `TraversalContext.scopeKeyIdentity` (the traversal's acting identity; the memory server's query path supplies the querying session's — `packages/memory/v2/query.ts`) |
| 6 | `traverse.ts` — `getTrackerKey(address, identity)`, over the exported `schemaTrackerKey(space, id, scope, identity)` that `packages/memory/v2/query.ts`'s `toDocKey` also builds through (one construction for writer and query-side reader); the schema-tracker key | `` `${space}/${scope_key}/${id}` `` | same as 5 — one tracker entry per instance | `TraversalContext.scopeKeyIdentity` |
| 7 | `StorageManager.#registerPendingLoad()` in `storage/v2.ts`, the `#pendingLoads` key (built with site 1's `entityKey`, which the scheduler cross-matches in `collectPendingLoadParkKeys`) | `` `${space}/${scope_key}/${id}` `` | per instance: two instances of one doc are two loads, and collapsing them makes one waiter observe another's failure | the explicit load instance when supplied, otherwise the manager's own `scopeKeyIdentity()`; immutable input sync carries the requesting identity to linked targets |
| 8 | `storage/transaction/address.ts` — `toString(address, identity)`; notification-differential address identity (`storage/differential.ts`, whose `toKey` shares the vocabulary) | `` `/${scope_key}/${id}/${JSON.stringify(path)}` `` (no space — per-space by construction) | per instance within a batch: one batch may carry several instances of one doc (scopes.md §2), and they must not collapse to one change entry | the owning session's identity, threaded through `Differential.create/load/checkout` from the replica |
| 9 | `scheduler/graph-snapshot.ts` — `formatAddress(address, identity)`; diagnostic graph-snapshot labels (site 1's `entityKey` in `buildSchedulerGraphSnapshot` and `findOverlappingCells`) | `` `${space}/${id}/${scope_key}/${path.join("/")}` `` | per instance — diagnostic only, but a per-instance graph renders N indistinguishable rows without it, which is how a fan-out bug hides | `SchedulerGraphSnapshotState.scopeKeyIdentity` |

## 2. Why the OFF arm does not move

Stage E is declared OFF-ARM NEUTRAL (plan Phase 1 stage E), and the
argument is structural rather than empirical: in the OFF arm each
runtime derives ONLY its own instances, so scoped cardinality is
exactly 1 per (runtime, scope). The instance dimension is therefore
DERIVABLE from the authenticated session at every site above —
`space` → `space`, `user` → `user:<me>`, `session` →
`session:<me>:<sid>` — and the re-keyed string partitions state into
exactly the same equivalence classes the scope-NAME string did. The
key text changes; no two things that were distinct merge, and no two
things that were merged separate.

That is what makes this stage landable dark, ahead of everything
that depends on it. It is also the test: an implementation whose OFF
arm moves has re-keyed by something other than the runtime's own
resolved identity, and is wrong.

## 3. The twin column — RULED (ledger LD3, owner 2026-08-03)

The last column was OPEN on one question, not nine: **who owns the
runner-side `resolveScopeKey` twin, and is importing engine
vocabulary into the runner legal layering?** The transaction
identity model (protocol.md §1) answers it, and the answer is the
middle of the three shapes the question recorded — the vocabulary
moves DOWN, and the engine imports it too — reached by modeling,
not coin flip:

- **`scope_key` is now WIRE vocabulary, so it cannot stay
  engine-internal.** Under the model, server-driven commits carry
  explicit keys inside — addressing per scoped write, attribution per
  action run (protocol.md §1/§7) — and lease-holder reads name
  `entity_scope_key` on the wire (protocol.md §2). A format both
  endpoints speak on the wire is protocol vocabulary by construction.
  Its home is the wire-shape module — `packages/memory/v2.ts`, where
  `CellScope`, `SessionId`, and the other protocol types already live
  — as ONE exported constructor `(scope, identity) → scope_key`
  (`resolveScopeKey`) plus the parse/inspect helpers, which
  `engine.ts` imports in place of private definitions (it re-exports
  the same objects, so `Engine.resolveScopeKey` IS the shared one,
  never a twin).
- **What stays engine-owned is IDENTITY DERIVATION, not the format.**
  For `authored` traffic the memory server still derives the identity
  from the authenticated session at admission — `#decideTransaction()`
  in `packages/memory/v2/server.ts` threads `session.principal` +
  `message.sessionId` into `Engine.applyCommit`, whose
  `applyCommitTransaction` constructs the key — via the shared
  definition. Clients never name keys — their identity rides the
  session, established at session open, never the commit (protocol.md
  §1) — so the derivation step is admission machinery and never exists
  client-side.
- **The runner gets NO resolver at all — construction only.** A
  runner-side run never resolves identity from ambient state (§4's
  tripwire): its identity arrives explicitly — the DEMAND supplies
  it for derivations, the server-stamped `firedAt` for handlers
  (scopes.md §5) — and the nine sites construct keys from
  (scope, identity) with the shared constructor. In the OFF arm
  that identity is the runtime's own authenticated session, which
  is §2's neutrality argument restated.
- **Layering: legal, and no new dependency direction.** The runner
  already imports memory-v2 protocol vocabulary
  (`@commonfabric/memory/v2` — e.g. the imports in
  `packages/runner/src/storage/v2.ts`); what it must not import is
  ENGINE internals, and the format is not one.
  (`packages/state-inspector/scopes.ts` and `conflicts.ts` import
  `resolveScopeKey` from the shared module; the runner's remaining
  reaches into `memory/v2` internals beyond the wire module are out of
  this ruling's scope.)

Plan Phase 1 stage E LANDED on this ruling: the definition move
(one shared constructor, engine re-exports) ahead of the nine-site
re-keying, exactly as ruled.

### 3b. The instance-keyed replica and wire (fan-out stage A, OW17 — 2026-08-16)

The last name-keyed LAYER — the serving runtime's local view and
the wire that fills it — is re-keyed on stage E's shape: instance
keys built from an explicitly supplied identity, partition unchanged
at cardinality 1. The unifying device is an OPTIONAL EXPLICIT
INSTANCE on the address type — `IMemoryAddress.scopeKey?: ScopeKey`
(`packages/runner/src/storage/interface.ts`) — ABSENT everywhere off
the serving path (every client, the whole OFF arm), so no key, frame,
or serialized notification moves by a byte when it is absent, and SET
only where a serving runtime knows the instance is not the ambient
one. Every consumer that builds a key from an address PREFERS it over
resolving `scope` against its identity. The vocabulary:

- **Replica** — `SpaceReplica`'s local doc key is `docKey(id,
  instance)` (`storage/v2.ts`), `instance` = the address's explicit
  key, else the reading/sealing run's identity resolved over the
  scope name, else the replica's own (memoized per scope name — the
  hot path pays a map lookup, never a per-read resolve); an
  unresolvable scope keys by NAME (an anonymous session's user-scoped
  read, as before). One replica holds the service instance AND
  per-principal instances of one doc. Every seal, verdict, frame, and
  notification threads the instance: `sealNative(…, {identity})` and
  its in-flight entry (confirm/rollback settle exactly that
  identity's layers), `getDocument(id, scope, identity)`, keyed
  frames applied under `upsert.scopeKey`, and the differential's
  states/addresses carrying `scopeKey` (`storage/differential.ts`,
  `storage/transaction/address.ts` — the change address is what the
  scheduler keys per instance).
- **Transaction** — `IStorageTransaction.scopeKeyIdentity` (set once,
  by `stampWaveRunContext`, before the first read; a second, different
  identity throws — one transaction serves one identity, the tx's own
  doc cache being name-keyed) is the tx→replica seam: reads, the
  commit-time claim, and the seal resolve against it, and the
  reactivity log's scoped addresses carry `scopeKey` so the
  scheduler's dependency/trigger keys (`entityKey`) key the read to
  ITS instance; space-scope addresses carry none.
- **The runner's explicit-instance read** — a per-instance run's
  read of a scoped instance the replica has never seen kicks an
  instance-NAMED load: `Cell.sync` with the cell's transaction
  identity, `IStorageManager.syncCell(cell, {scopeKeyIdentity})` /
  `syncInstance(address, identity)`, the transaction layer's kick in
  `V2StorageTransaction.#loadRoot` (reserved once per (space,
  instance, id) — `shouldPullDoc(…, identity)`), the traversal's
  absent-target kick (`Runtime.ensureLinkedDocLoaded(link, space,
  identity)`), and the served event's presync/preflight as the
  event's actor. The watch root carries `entityScopeKey` (protocol.md
  §2's read row — lease-holder-only, exactly who issues one), the
  watch id and the selector tracker (`SelectorTracker.#toKey`,
  `watchIdForEntry`, the pull dedupe key, the provider's replay map)
  key by the instance, and the pending-load ledger keys the address
  with it (the event preflight's park cross-matches per instance).
- **Wire** — `SessionSyncUpsert.scopeKey` / `SessionSyncRemove.scopeKey`
  / `EntitySnapshot.scopeKey` (`packages/memory/v2.ts`), populated
  ONLY on frames/results to a session that has been admitted an
  explicit-instance read — its STICKY wire vocabulary (`SessionState.
  leaseHolderReads`, kept for the session's life; amended 2026-08-17,
  the stage-A review's finding 1: keying never hangs from the live
  lease, so a keyed delivery is always keyed-retracted; the DELIVERY of
  foreign instances is the per-pass live-lease question, with the
  lapse recorded and re-armed — `leaseHolderReadsLapsed`,
  `noteLeaseReacquired`) (`toWireUpsert(entry, keyed)`, `toWireRemove`,
  `buildFullSync` / `buildDiffSync(…, keyed)`,
  `queryGraph({keyedSnapshots})`); the collapse guard
  (`#denyExplicitInstanceReads`) refuses two instances of one (branch,
  id, scope) for NON-holders only; `WatchView.applySync` keys by
  `scopeKey ?? scope`.
- **Scheduler** — `entityKey(address, identity)` prefers
  `address.scopeKey` (dependency/trigger keys per instance);
  `sortAndCompactPaths` compacts per instance; the WRITER index and the
  MATERIALIZER index are NAME-keyed (`entityNameKey`) — reader→writer
  is a node-level topology relation (one node writes all instances of
  its declared surface, C11b), so the edge between a user-scoped-declared
  writer and a reader running as any principal holds; the N-run loop
  resubscribes to the UNION of its instance logs after each instance,
  keeping earlier reads watched while later instances run; instance-precise
  dirtiness across the name-keyed fan-in is stage B's B7 (O(N) re-runs
  per input change, equality cutoffs absorbing siblings — recorded, not
  a correctness need).
- **Basis rows** — keyed by the run's FULL instance address (S4 as
  amended, serving-loop.md §3b): the discovered scope resolved against
  the run identity, with the stamped and broader-chain keys cleared.

The seed-memo site (§1 site 4) keys under the RUN's identity
(`tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity`). The result-pattern
cache holds an inner entry per resolved output instance. Setup evidence and
session-only pattern pointers resolve against the instance being staged;
execution-family naming additionally distinguishes the full resolution
identity because a user-scoped piece can read session-scoped dependencies.

The piece registry and wake-shaper buckets keep the runtime's identity:
they group the piece as a whole. A scoped piece registration owns program
variants keyed by canonical pattern identity, with shared nodes for every
instance selecting the same program (C11b). The selection is a tracked read
in each run, and distinct variants have distinct action-instance keys.

## 4. Tripwires

FORBIDDEN once stage E lands:

- a NEW identity key built from the scope NAME — §1 plus §5 is the
  complete inventory at the time of writing: a tenth
  storage-row-aligned site is a regression, not an omission, and a
  new name-keyed identity key (or a change to a §5 boundary site)
  that does not update §5's list in the same change fires this
  tripwire too;
- two definitions of the `scope_key` string format (LD3 ruled: the
  wire-shape module `packages/memory/v2.ts` owns the ONE definition
  — §3; the engine's row keys and the runner's in-memory keys
  import it, never restate it);
- deriving an instance key from anything but a resolved identity
  (a positional index, an insertion counter, a "current user"
  global) — instance keys are addresses, and an address that is not
  derived from the principal cannot be matched against a storage
  row;
- re-keying the OFF arm by anything but the runtime's own
  authenticated session (§2's neutrality argument is the gate).

## 5. The name-keyed boundary surface

§1's nine sites are the closure of storage-row-aligned identity
construction — every key that must match a storage row's exact
`scope_key`. They are NOT every name-keyed identity structure in the
tree. The sites below still key by scope NAME (or by no identity at
all); each carries its disposition and its
cardinality-greater-than-1 failure mode. This list is held-to
inventory, not observation: §4's first tripwire covers it — a new
entry, or a change to a listed one that does not update this
section, fires it.

**M4-coupled — RE-KEYED at stage F** (with the M4 push re-key, as
this section's disposition required; each site now constructs
instance keys via the shared vocabulary from an explicitly supplied
identity, partition-unchanged at cardinality 1 per §2's argument):

- `storage/selector-tracker.ts` — `toKey` is now an instance method
  over the tracker's BOUND identity (constructor-injected thunk):
  `${scope_key}\0${id}` — and, since fan-out stage A, an address that
  NAMES its instance (`scopeKey`) keys by it. The failure it closed:
  A's watch deduped B's, so B never subscribed.
- `storage/v2.ts` — `#docPullKicks` keys build in `#pullKickKey`
  via the manager's own identity, or the explicit foreign instance a
  served per-instance read names (stage A). The failure it closed:
  A's kick suppressed B's pull, and B's doc never loaded.
- the server's wake/sync dirty keys — `toDirtyKey` =
  `${scope_key}\0${id}` (`packages/memory/v2/query.ts`), marked at
  admission from the COMMITTING session's resolved instance; the
  per-session sync cache carries `scopeKey` on its entries and keys
  `${branch}\0${scope_key}\0${id}` (`server-sync.ts`), with the
  wire upserts STRIPPED back to scope names (`toWireUpsert`) so
  frames stay byte-identical — EXCEPT (fan-out stage A, §3b) frames to
  a session admitted explicit-instance reads, which keep the key for
  the session's life. This was scopes.md §7 M4 itself: dirtiness AND delivery now key
  by instance, and one principal's commit touches only sessions
  tracking THAT instance.

**Fan-out stage A (OW17) — RE-KEYED 2026-08-16** (§3b): the serving
replica's local doc keys (`SpaceReplica` `docKey`, formerly
`${scope-name}\0${id}` — the last name-keyed layer, the P7 review's
CLASS VERDICT), the wire upserts/removes/snapshots to a live lease
holder, `WatchView`'s entity keys, the transaction's root addresses
and logged addresses, the watch ids and pull dedupe keys, and the
scheduler's writer/materializer indexes (name-keyed by DESIGN — the
one deliberate fan-in, see §3b). Each carries the address's explicit
`scopeKey` where the serving path names one and is byte-identical
without it.

**Stage-F serving-identity sites — RE-KEYED at stage F** (M1
territory; keys construct from the runtime's identity today and take
per-run identities where run contexts carry them):

- `runtime.ts` — `missingDocLoadKicks` keys
  `${space}\0${scope_key}\0${id}` via the runtime's identity. The
  failure it closed: A's kick suppressed B's load, so B's absent
  read never healed.
- `scheduler/wake-shaping.ts` — `linkKey`
  (`space|scope_key|id|path`, identity-parameterized), plus the
  pieceId buckets `${scope_key}:${id}` (`runner.ts`
  `schedulerObservationIdentity` and the handler tagging twin). The
  failure they closed: shaper groups and rate caps collapsed across
  principals — cross-principal budget consumption, and a timing
  channel correlating one principal's activity with another's wakes.
  (The re-key also normalized the observation-identity constructor's
  raw `undefined:` prefix into `space:` — the same instance by
  definition; the two constructors now agree. The OFF-arm shaper-merge
  delta this produces is a recorded acceptance, ratified 2026-08-05 —
  verification-coverage.md's stage-F recorded-acceptance row.)

**Recorded sound-per-session:**

- `packages/memory/v2/query.ts` — the `EngineObjectManager` caches
  (`load`, `detail`, `invalidateIds`) key
  `${scope_key}/${id}/${type}`, the scope key resolved against the
  manager's bound identity (`#scopeKeyFor`), and are sound because the
  constructor binds ONE identity per manager: every entry a manager
  holds was read as that identity. Re-key only if the manager sharing
  model ever changes.

**Identity-bound invariant — GUARD LANDED at stage F (OW10):**

- the shared schema memo — `schemaMemoAddressKey`
  (`traverse.ts`) has no identity component, and every sharing scope
  is single-identity today: `TrackedGraphState.memo` is bound to its
  manager (`packages/memory/v2/query.ts`), and the query path's
  `sharedMemo` instances are per-call. Sharing one memo across
  identities is FORBIDDEN — schema narrowing memoized under one
  principal's traversal would leak into another's (value-bleed). The
  guard: `assertSchemaMemoIdentity` (`traverse.ts`) binds a shared
  memo to its FIRST traversal's identity at the one choke point
  where a shared memo meets a traversal (the SchemaObjectTraverser
  constructor) and throws on any other identity — a future sharing
  change becomes a loud error, never silent value-bleed.
- the query evaluation cache — `QueryEvaluationCache`
  (`packages/memory/v2/query.ts`) serves whole tracked-graph
  evaluations ACROSS identities, and its sharing rests on an
  assumption wider than key construction: evaluation is
  recipient-blind. The walk consults the requesting identity only
  to resolve scope instances, so `classifyStateScope` decides
  shareability from scope keys alone — a scope-pure entry serves
  every identity, an absent-residue entry serves after per-requester
  absence probes, and anything else keys to the evaluating identity.
  ACL changes hold the invariant from outside: they are commits, and
  any commit rotates the cache. A per-recipient filter INSIDE
  evaluation (CFC label enforcement, say — the runtime's flow-label
  and sink-ceiling dials own it today, and the server's sqlite read
  labeling annotates rather than filters) would break the sharing
  invisibly: clearance differs between identities at one seq, so
  rotation cannot fence it and scope classification cannot see it.
  Such a filter must key the cache by its filtering context or
  bypass it — a separate, deliberate change, never a side effect of
  landing the filter.

**Instance-safe transients** (why each is fine as-is):

- `pending:`/`confirmed:` dependency-dedupe keys
  (`storage/v2.ts`) — per-commit-assembly lifetime; a key
  never outlives the one identity building that commit.
- `#pendingAsyncWork` owner keys (`Runtime.#pendingAsyncWork` in
  `runtime.ts`) — conservative direction: a name-keyed owner match can
  only make `settledFor` wait for MORE work, never return early.
- `fixtureDocKey` (`traverse-recorder.ts`) — dev capture
  tooling; fixture identity, not runtime identity.

**A recorded enablement gate** (from the stage-E re-key itself): the
coverage memo is consulted only for links that DECLARE a scope
(`isLinkedDocumentCovered` in `traverse.ts`). Enabling it for unscoped
links is gated on first resolving the html reconciler's
`get({ traverseCells: true })` value consumption, and is a separate,
deliberate change — never a side effect of re-keying.
