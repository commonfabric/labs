# Computed Cell Identity And Write Conflict Policy

## Status

Phase 1 (minting) is implemented behind `EXPERIMENTAL_COMPUTED_CELL_IDS` and
defaults on; an explicit `false` remains a temporary rollback override.
Redesigned in July 2026, computed ids are now `computed:fid1:<hash>`:
the kind rides the URI scheme, the `FabricHash` format tag stays `fid1`, and
the earlier kind-in-hash-tag format is retired without back-compat readers
(the flag never shipped, so no such ids exist). The classifier polarity
flipped in the same redesign: internals with a writer are computed BY
DEFAULT, with an exhaustive disqualifier list, instead of computed only
under a narrow provable-pure rule. Phase 2 (server policy: the memory-v2
engine acknowledges-and-drops stale all-computed commits, the storage client
reverts the optimistic pending value on a `droppedComputed` ack instead of
promoting it) and phase 3 (lineage verification) are SPLIT INTO THEIR OWN
follow-up PR so minting can land and be exercised under fully strict
conflict semantics first. Value-equality dedupe (phase 4) and the
server-side action runner (phase 5) are not started. Derived from a design
discussion on 2026-06-30/07-01 about avoiding needless commit conflicts when
multiple clients recompute the same derived values; redesigned 2026-07.

## Summary

When a pattern is instantiated, the runner materializes internal cells whose
contents are, in many cases, pure functions of the pattern's inputs: any
runtime holding the same inputs recomputes the same values. Today the memory
server treats writes to those cells exactly like writes to authoritative
state. When two clients recompute concurrently, or when one client commits a
recompute against inputs that another client has just advanced, the server
rejects the stale commit, the losing client's action re-runs, and it commits
again — protocol churn that exists purely to converge on a value both sides
would have derived anyway.

This proposal makes the derived/authoritative distinction visible to the
memory server by minting computed internal cells under a dedicated entity URI
scheme, and relaxes the server's conflict handling for writes that target
those entities: a computed write whose reads are stale is acknowledged and
dropped instead of rejected, because reactivity guarantees the writer
recomputes from the newer inputs once they sync down. Clients keep sending
every commit — the database stays current for tools like `cf inspect`,
`localSeq`-based read resolution keeps working, and speculation lineage
preconditions stay satisfiable. Only the server's *response* to staleness
changes, and only for entities whose ids carry the computed scheme.

## Goals

- Eliminate reject/re-run/recommit churn for concurrent or stale writes to
  derived internal cells, without weakening conflict detection for
  authoritative state.
- Make the derived/authoritative classification of an entity immutable,
  client-independent, and readable by the server (and by offline tools)
  without protocol shape changes or side-channel registries.
- Keep every commit flowing to the server so the durable store remains a
  complete, inspectable materialization of all values.
- Preserve the semantics of `PendingRead.localSeq` references and
  `origin-committed` commit preconditions.
- Lay the classification groundwork the future server-side action runner
  needs to know which entities it is licensed to regenerate.

## Non-goals

- Do not skip sending recompute commits from clients. (An earlier variant of
  this idea did; it was rejected because later commits' pending reads
  reference the `localSeq` of prior local commits, `origin-committed`
  preconditions name origin commits by `localSeq`, and non-runtime readers
  such as `cf inspect` would lose visibility.)
- Do not make the memory server execute pattern code. The server compares
  read watermarks; it never computes values. A server-side action runner is
  future work that this proposal feeds but does not include.
- Do not change conflict semantics for authoritative state cells, stream
  cells, or the result cells of non-replayable builtins (`fetch*`, `llm`,
  `generateText`, `llmDialog`, `sqliteQuery`, …). Their writes are not
  re-derivable and keep strict semantics. (Replayable sync builtins —
  `map`, `ifElse`, … — are deterministic derivations and DO qualify; see
  the classification section.)
- Do not retrofit visible kind markers onto existing kinds. Stream cells
  already carry `$kind: "stream"` in their id preimage but not in their
  visible form; adding a visible marker would re-identify every existing
  stream cell. Visible kind schemes apply to newly introduced kinds only.
- Do not treat the kind scheme as a security boundary. Conflict semantics
  are a convergence mechanism; authorization is unchanged.

## Current System Overview

### Internal cell identity

The pattern builder assigns each internal root cell a `partialCause` —
the cell's declared name, or an anonymous `{ $generated: N }` counter, with
`$kind: "stream"` mixed in for stream cells
(`packages/runner/src/builder/pattern.ts`). At instantiation the runner
mints the entity id from the piece's result cell and the effective cause. For
a versioned generated descriptor, the effective cause includes the accepted
authored artifact; named and legacy descriptors keep their partial cause. See
[Generated cell identity](generated-cell-identity.md).

```ts
// Shown for illustration only.
createRef({}, { parent, type: "internal", cause: generatedInternalCellCause(descriptor) })
```

(`packages/runner/src/link-utils.ts`, `getDerivedInternalCellLink`). The
result is a `FabricHash`: hash bytes plus an algorithm tag, stringified as
`<tag>:<base64urlHash>`, e.g. `fid1:abc…`
(`packages/data-model/src/fabric-primitives/FabricHash.ts`). The hash is
opaque: nothing about the preimage — including `type: "internal"` or the
partial cause — is recoverable from the id. `hashOf` mints the `fid1` tag at
a single chokepoint (`packages/data-model/src/value-hash.ts`). The URI layer
(`packages/runner/src/uri-utils.ts`, `toURI`/`fromURI`) prefixes an entity
scheme onto the tagged hash — historically always `of:`.

The manifest of materialized internal cells is stored in result-cell
metadata and matched by partial cause, kind, and derived address
(`packages/runner/src/runner.ts`, `materializeDerivedInternalCells`).

### Transaction provenance

The runner already distinguishes recompute transactions from event-handler
transactions, but only in process memory:

- Reactive action runs open their transaction with a `changeGroup` and set
  `tx.tx.sourceAction` (`packages/runner/src/scheduler/action-run.ts`).
- Event dispatch sets `tx.dispatchedEventId` and `tx.tx.immediate`
  (`packages/runner/src/scheduler/events.ts`).

(A retired mechanism once attached a `SchedulerActionObservation` to
reactive runs' commits behind `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE`;
both were deleted by server-execution v2 Phase 1 stage C — see
[the archived spec](../history/specs/persistent-scheduler-state.md).)

### Commit conflict handling

`ClientCommit` (`packages/memory/v2.ts`) carries `localSeq`, a read set
(confirmed reads with sequence watermarks, pending reads referencing prior
local commits by `localSeq`), operations, and optional preconditions. A
commit whose reads are stale relative to the space head is rejected; the
client's scheduler re-runs the action against the newer inputs and commits
again. The (since-deleted) persistent-scheduler-state work already performed per-entry
keep/drop decisions on exactly this read-watermark basis for no-op
observation batches, recording dropped replay rows rather than surfacing
conflicts.

## Problem Statement

For a derived internal cell, a conflict between two clients is never
meaningful: if their inputs matched, their values match; if their inputs
differed, one client was stale and will recompute when the newer input
arrives. The reject-and-retry cycle spends protocol round-trips and commit
log entries converging on a value the system was always going to reach.
Worse, as more clients share spaces, the probability of two runtimes
recomputing the same node concurrently grows, so the churn scales with
exactly the deployments we want to work well.

The server cannot currently tell derived writes from authoritative ones. The
in-process provenance markers do not cross the wire, the observation
`actionKind` is an optional blob behind an experimental flag and absent on
the event path (so absence is not a safe discriminator), and the entity id
is an opaque hash.

## Proposed Model

### Id grammar: the `computed:` URI scheme

A computed cell's id is a **kinded entity URI**:

```
computed:fid1:<base64urlHash>
```

The `computed:` scheme REPLACES `of:` for these entities — a computed id is
never written `of:…`. `of:fid1:<hash>` remains the unkinded form with
strict, authoritative semantics. The kind rides the URI scheme, NOT the
`FabricHash` format tag: the tag stays `fid1` (same bytes, same hashing,
same last-colon `FabricHash.fromString` parse), and no hash-layer parser
needs to learn anything.

Kind parsing is by scheme (`entityKindOfIdString`,
`packages/data-model/src/entity-kind.ts`): the segment
before the FIRST colon. `computed:fid1:H` parses as kind `"computed"`;
`of:` URIs, bare tagged hashes (`fid1:H`), non-entity URIs (`data:`),
colon-free strings, and UNKNOWN schemes (e.g. `future:fid1:H`) all parse as
no kind, which callers must treat as strict/authoritative — never relaxed.

Rules:

- **The hash preimage is kind-free.** A computed cell and a state cell
  minted from the same cause share hash bytes; the URI scheme is the ONLY
  representation of the kind and the sole distinguisher. This is a
  deliberate relaxation: under the fail-open classifier the kind is a
  conflict-policy hint, not a purity guarantee, so hash-level separation
  buys nothing — but it makes the next rule load-bearing rather than
  advisory, and any keying done on stripped or bare hashes is unsound.
- **The URI string is the identity.** `fromURI` strips the scheme, and the
  bare hash no longer carries the kind, so a round-trip through the bare
  hash ALIASES the computed entity with its `of:` sibling of the same
  cause. Never rebuild a computed cell's URI from its bare hash, and never
  key subscriptions or caches on scheme-stripped ids. `toURI(value, kind)`
  throws when handed a kind alongside an already-schemed string — an
  existing identity is never re-schemed. The one sanctioned stripped form
  is `PieceHandle.id()` (runtime-client): a piece-root ROUTING/DISPLAY
  accessor whose consumers are shell URLs, `cf-piece` lookups, and
  favorites equality against URL-derived bare pieceIds. It strips `of:`
  only (a `computed:` scheme stays visible), and piece roots are minted
  unkinded, so it never launders a computed id into the bare world.
  `CellHandle.id()` returns the FULL schemed id and is safe as identity.
- **One mint site.** `getDerivedInternalCellLink`
  (`packages/runner/src/link-utils.ts`) applies `descriptor.kind` as the
  URI scheme via `toURI`; a kind change names a different entity because
  the URI string differs, even though the hash bytes do not.
- **Absence means strict.** Unkinded ids — every existing entity — keep
  authoritative conflict semantics. There is no migration; only newly
  minted computed cells get the new scheme, and the server's conservative
  default covers everything it cannot classify.

Below the URI layer nothing routes on the scheme: storage and the memory
engine treat `URI` as an opaque string key (only `data:` URIs get special
routing), so computed docs flow as ordinary documents. The scheme is learned
only by the URI codecs (`uri-utils.ts`, `fabric-import-specifier.ts`,
`fabric-ref-resolution.ts`) and read by the engine's drop policy via
`entityKindOfIdString`.

Terminology: the entity KIND is the semantic property (re-derivability,
conflict policy); the URI SCHEME is its representation in the id string —
a "kinded scheme" encodes a kind, `of:` is the unkinded default. Two other
uses of "kind" in the runtime are related concepts under a shared word,
not entity kinds: stream cells' `$kind: "stream"` is the same
flavor-distinction implemented by the older, preimage-mixed mechanism
(invisible in the id string; a future migration to a visible `stream:`
scheme is left open but excluded by the Non-goals above), and `asCell`
kinds (`"cell"`, `"stream"`, `"opaque"`, …) are handle CAPABILITY kinds —
properties of a binding, unrelated to identity. The full delineation lives
at the definition site, `entity-kind.ts`.

### Builder-side classification

The classifier (`assignComputedCellKinds`,
`packages/runner/src/builder/pattern.ts`) runs at pattern build time, gated
on the flag. Its polarity is **computed by default**: an internal cell with
a writer is tagged `computed` unless something disqualifies it — even when
its computation involves writes, because a replayable writer
deterministically reproduces every write it makes, so dropping one loses
nothing. (The authored escape hatches `safeDateNow()` / `nonPrivateRandom()`
can break this determinism inside an otherwise-qualifying compute; handling
is undecided — see Open Questions.) A cell is tagged iff:

- **It has at least one writer** — a node listing its root under
  `node.outputs`. Zero-writer cells are seeded state and are never tagged.
- **No writer disqualifies** (`writerDisqualifies`). Disqualifying writers
  are exactly:
  - handler wrappers (`wrapper === "handler"`);
  - effect modules (`isEffect === true`);
  - `raw`, `isolated`, unrecognized module types, and opaque non-module
    values;
  - `type: "ref"` builtins whose `implementation` name is not proven
    replayable (see the registry below) — unknown names fail STRICT.

  `javascript`, `pattern`, and `passthrough` writers qualify. Capture
  writes and `materializerWriteInputPaths` do NOT disqualify — those
  writes replay. (`captureWritesAnalyzed`, the transformer's
  exhaustive-write assertion, is still emitted but is pure provenance now;
  the classifier no longer consumes it.) `passthrough` is a one-shot
  deterministic copy of its input binding. `pattern` writers qualifying is
  a monitored bet: if dropped instantiation writes fail to converge in
  practice, the one-line fallback is to move `"pattern"` to the
  disqualifying set.
- **Its root is never handed WRITABLE into another node**
  (`collectInputDisqualifiedRoots`). The graph's input/output labeling is
  not a write-capability boundary: any node holding a writable handle can
  write through its *inputs* (handlers through their `$ctx` captures,
  `llmDialog` through its `messages` binding), and those writes never
  appear under `outputs`. So writes must be audited by capability — who
  holds a writable handle — not by writer labels alone. Per node type:
  - *Schema-carrying handlers*: the bound `$ctx` value is walked in
    parallel with `argumentSchema.properties.$ctx`
    (`collectWritablyBoundRoots`), collecting the roots at positions whose
    covering subschema may grant a non-read-only `asCell` handle
    (read-only kinds: `opaque`, `comparable`, `readonly`; everything else,
    including unrecognized kinds, counts as write-capable). Read-only
    captures collect nothing — in such a handler, write capability flows
    only through `asCell` handles — so a computed value captured read-only
    by a handler stays computed. Any subtree the walk cannot align falls
    back to collecting ALL roots in that value subtree: boolean or missing
    subschemas where a grant may exist, value/schema shape mismatches, and
    positions carrying unmodeled schema keywords. The provably-handle-free
    test is `$ref`-aware: a subschema containing `$ref`/`$dynamicRef` (or
    any composition keyword the walk does not model — `allOf`, `oneOf`,
    `if`/`then`/`else`, `patternProperties`, …) is treated as
    possibly-granting, because the writable grant could hide behind the
    reference. Under-collection here would silently drop user writes, so
    every structural doubt disqualifies.
  - *Schema-less handlers*: every input root disqualifies.
  - *Sub-pattern nodes* (`type: "pattern"`): every input root disqualifies
    — pattern arguments are writable-by-default aliases, and handlers
    inside the sub-pattern are invisible at this layer.
  - *Op-sub-pattern builtins* (`map`, `filter`, `flatMap`): outputs
    qualify (the mapping replays deterministically) but every input root
    disqualifies — the op sub-pattern may contain handlers that write the
    source elements.
  - *Non-replayable/unknown builtins, effects, raw/isolated modules*:
    every input root disqualifies. Non-replayable builtins may write
    through their inputs — the proof case is `llmDialog`, which pushes
    onto its `messages` input.
  - *Qualifying `javascript` computes and `passthrough`*: inputs do not
    disqualify; their (replayable) writes are covered on the writer side.
- **It is not a stream.**

The failure directions are asymmetric by design. SHAPE questions fail open
only where write capability is provably absent; any structural doubt
disqualifies. NAME questions fail strict: a builtin name not in the
registry disqualifies. The misclassification asymmetry drives both: tagging
a computed cell as state costs a missed optimization; tagging state as
computed means the server silently drops user writes.

#### The replayability registry

Builtins appear at classification time as `type: "ref"` modules whose
`implementation` is a string NAME — the runtime's module registrations are
invisible to the builder — so replayability is decided by name against
`REPLAYABLE_BUILTIN_REFS`
(`packages/runner/src/builder/builtin-replayability.ts`): `map`, `filter`,
`flatMap`, `ifElse`, `when`, `unless`, `sqliteDatabase`. Every other name is
non-replayable, including the documented set `fetchBinary`, `fetchText`,
`fetchJson`, `fetchJsonUnchecked`, `fetchProgram`, `streamData`, `llm`,
`llmDialog`, `compileAndRun`, `generateObject`, `generateText`,
`navigateTo`, `wish`, and `sqliteQuery` (a server round-trip, even though
its name suggests a query). The registry is deliberately NOT derived from
the scheduler's `isEffect`, which carries scheduler semantics and says
nothing about replay; do not repurpose it. `isEffect` is one of the ways a node
becomes a standing demand root, and of these names only `navigateTo` carries
it. A node reaches the same standing demand by other routes too: `llmDialog`
holds it as a materializer, through the envelope it declares over the
`messages` cell it writes. A reciprocal comment at `registerBuiltins`
(`builtins/index.ts`) keeps the registry in sync when builtins are added.

#### Accepted consequence: result-surface exposure

Exposure of a computed cell on the pattern's result surface no longer
disqualifies it (the old classifier's result-surface machinery is deleted).
This scopes the conflict-policy invariant precisely: "a write to a
non-computed entity is never dropped" is a statement about the CELL's kind,
not about the writer. The cell is computed; the writer of a dropped write
may be foreign — an embedder holding a writable handle obtained through the
exposed result surface can have its stale write into the computed cell
acknowledged-and-dropped. That is accepted: the derivation re-establishes
the value, and writing non-derived data through another pattern's derived
output was never a supported contract.

### Server conflict policy

At commit-apply time the engine classifies each semantic operation by
parsing the kind from its entity id string (`entityKindOfIdString`; unknown
schemes parse as no kind and stay strict). Policy:

- **All-computed commits** (every semantic operation targets a
  computed-kind entity):
  - Reads current → accept normally. Optionally dedupe value-equal writes
    (see Open Questions).
  - Reads stale → **acknowledge and drop.** No rejection is signaled, no
    retry is expected. The client's own scheduler re-runs the action when
    the winning input syncs down; convergence is unchanged, churn is
    eliminated.
  - Two current commits racing on the same computed entity: first wins.
    Determinism says the values should be identical; if they differ, that is
    a nondeterminism bug surfacing, and first-wins still converges because
    the losing client is corrected on sync-down.
- **Mixed commits** (computed and non-computed operations together): strict
  semantics for the whole commit. Atomicity is preserved; partial
  application of a commit is never introduced. Pure recompute transactions
  write only their computed output cells, so the all-computed case is the
  common one.
- **Non-computed commits**: unchanged.

An acknowledged-and-dropped commit consumes its `localSeq` — replay dedupe
must keep working regardless of anything below. The REST of the dropped
commit's lineage semantics are **PROVISIONAL**, not settled. Treating a
dropped commit as accepted for `origin-committed` preconditions and
`PendingRead.localSeq` resolution makes the *bookkeeping* consistent
without making a descendant's *payload* consistent: a client can build
commit B from commit A's optimistic value before A's ack arrives, so B's
serialized operations already embed `g(X_v1)`; if A is dropped, resolving
B's pending read against the winning `X_v2` does not recompute that
payload — B would appear to read `X_v2` while writing `g(X_v1)`. For an
all-computed B, recompute eventually paves over the phantom; for a B that
writes authoritative state, the phantom persists. The follow-up
implementation must therefore ensure a descendant derived from a dropped
optimistic value is rejected, retried, recomputed, or proven independent
of the dropped value (e.g. cascade-dropping computed-only lineage and
strictly rejecting anything else) before these semantics can be considered
final.

### Client behavior

None required beyond minting. The drop is invisible: the client applied its
write optimistically, the server acks (the storage client reverts the
optimistic pending value on the `droppedComputed` ack rather than promoting
it), and the authoritative value arrives through the normal subscription
path exactly as a lost conflict does today — minus the rejection, the
action re-run, and the second commit.

### Version-skew rollout

New-form ids are a data-compatibility event, so
`EXPERIMENTAL_COMPUTED_CELL_IDS` gates MINTING only and defaults on; readers in
this codebase accept both forms unconditionally. An explicit `false` remains a
rollback override for version skew. The skew hazard is one-directional:

- **Old clients are the hard constraint.** A client predating the scheme
  THROWS in `fromURI` on a `computed:` id arriving via sync (`Invalid
  URI`). Enabling minting anywhere therefore poisons shared spaces for
  every stale client reading them. Do not graduate the flag until all
  syncing clients carry the `computed:`-aware readers.
- **Old servers are safe.** A server predating the scheme parses
  `computed:` as an unknown scheme ⇒ no kind ⇒ strict conflict semantics.
  The optimization is lost; correctness is not.

### Kind flips across pattern versions

A cell whose kind changes between pattern versions (e.g. a `computed(...)`
refactored into handler-managed state) mints a different id — same hash
bytes, different URI scheme, distinct identity. This is
semantically correct, not a migration problem: in the computed→state
direction the orphaned value was derived garbage; in the state→computed
direction the old value is superseded by derivation. Either way the old
contents are meaningless under the new kind, and the manifest's
partial-cause matching materializes the new cell and drops the stale entry
naturally.

Anonymous cells re-mint when an authored update changes the accepted artifact;
named cells re-mint on rename. A runtime deploy preserves unchanged legacy
addresses. Kind
flips add a trigger to an existing hazard class (durable cross-piece links
pointing at an orphaned entity), not a new class. The flipped classifier
polarity widens the set of cells that flip when a pattern edit adds or
removes a disqualifier (e.g. introducing a writable handler capture of a
previously computed cell), which is the same hazard at higher frequency.

### Trust model

The kind scheme is client-asserted; the server cannot verify purity without
executing code. What the design guarantees instead:

- **Immutability.** The kind is part of identity. There is no retag
  operation, no migration case, and no surface where a buggy or malicious
  client demotes an existing state cell to computed to get its writes
  stale-dropped: changing the scheme necessarily changes the id, i.e. names
  a different entity.
- **Blast-radius containment.** A client that mints a computed-schemed id
  and writes non-derived data through it only relaxes conflict semantics
  for entities it created itself. It gains no ability to affect the
  conflict handling of anyone else's data.
- **Honest tagging by construction.** The kind originates in the builder's
  structural analysis, never in pattern-author-controlled values.

## Relationship To Durable Scheduler State

This section originally leaned on the persistent-scheduler-state work,
which server-execution v2 Phase 1 stage C deleted (the archived account is
[persistent-scheduler-state.md](../history/specs/persistent-scheduler-state.md);
the durable successor is the basis index,
[serving-loop.md §3b](server-side-execution/serving-loop.md)). What that
changes here:

- The server-side machinery this policy needs — comparing a payload's read
  watermarks against heads and making per-entry keep/drop decisions with
  dropped-replay bookkeeping — existed for no-op observation batches and was
  deleted with them. It is prior art now: implementing this policy means
  rebuilding that mechanism on the engine for semantic operations on
  computed-kind entities, not extending a live one.
- The rehydration-trust problem this proposal de-risked is moot in its old
  form (nothing rehydrates from persisted observations anymore); the same
  property — a wrong computed write degrades to a recompute, never a
  correctness cliff — is exactly what makes computed-kind entities safe for
  the serving loop's drop-on-stale wave commits (serving-loop.md §3d).
- The knowledge layer for the server-side action runner is now the
  server-execution v2 arc: the basis index supplies staleness, computed-kind
  ids supply the set of entities the server is licensed to regenerate;
  `ClientCommit.codeCID`
  supplies code identity. Execution remains the missing (and out-of-scope)
  half.

## Correctness Invariants

- A write to a non-computed entity is never dropped, deduped, or otherwise
  relaxed by this policy. (Scoped by the accepted consequence above: the
  invariant keys on the target CELL's kind. A foreign writer's write INTO a
  computed cell — e.g. through a result-surface handle — is a computed
  write and may be dropped.)
- A commit is either applied whole or dropped whole; mixed commits are never
  partially applied.
- An acknowledged-and-dropped commit consumes its `localSeq` (replay
  dedupe). PROVISIONAL — see Server conflict policy: whether it also
  satisfies `origin-committed` preconditions and resolves `PendingRead`
  references as if applied is NOT settled; the follow-up must first close
  the phantom-descendant hazard (a dependent commit whose payload embeds
  the dropped optimistic value must not apply unchanged).
- For deterministic computations, all clients converge on identical values
  and identical entity ids without any client observing a conflict on a
  computed entity.
- For a nondeterministic computation mistakenly tagged computed, the system
  still converges (first-wins plus sync-down correction); the failure mode
  is value flapping, never divergence or data loss.
- Existing entities and unkinded ids behave exactly as before the change.

## Phased Plan

1. **Minting** (implemented, redesigned). Kind applied as the URI scheme
   by `toURI` at the single mint site (the hash preimage is kind-free);
   computed-by-default classifier with the exhaustive disqualifier
   list and the name registry; kind-aware descriptor/manifest matching.
   Gated behind `EXPERIMENTAL_COMPUTED_CELL_IDS`: the flag controls id
   creation only, and readers accept both forms unconditionally from the
   start.
2. **Server policy, drop-on-stale** (split into its own follow-up PR).
   Engine-side kind parse at commit-apply; ack-and-drop for all-computed
   stale commits, with `droppedComputed` bookkeeping for inspectability,
   rebuilding the deleted persistent-scheduler-state keep/drop path as
   prior art. Backed out of
   the minting branch so phase 1 can land and be exercised under fully
   strict conflict semantics; ships gated behind its own flag.
3. **Lineage integration** (with phase 2; semantics provisional). Settle
   the dropped-origin semantics for `origin-committed` and
   `PendingRead.localSeq`: a descendant derived from a dropped optimistic
   value must be rejected, retried, recomputed, or proven independent of
   it — then validate lineage SAFETY (no phantom descendant payload
   applies) under the speculation test suites.
4. **Value-equality dedupe** for current-read computed commits, if the
   measured commit-log savings justify the comparison cost.
5. **Later:** server-side action runner consumes the kinds (separate spec).

## Test Strategy

- Unit: scheme-based kind parsing (`computed:fid1:H` ⇒ computed; `of:`,
  bare, `data:`, and unknown `future:fid1:H` forms ⇒ no kind);
  `toURI`/`fromURI` round-trips, including the kind-plus-schemed-string
  throw; the kind-free preimage (same cause ⇒ same hash bytes; the scheme
  is the sole distinguisher); import-specifier round-trip of computed
  refs.
- Builder: positive battery for the fail-open rule (capture-writes lift,
  handle-bearing lift without provenance, sync-builtin writers, read-only
  handler captures, result-surface exposure) and negative battery for every
  disqualifier (async-builtin writer, unknown ref name, write-capable
  `asCell` handler capture, stream, zero-writer cell, sub-pattern input,
  op-sub-pattern builtin input); a registry
  cross-check that every registered builtin name is either replayable or on
  the documented non-replayable list; a pattern refactor that flips a
  cell's kind mints a new id and re-materializes via the manifest.
- Engine: all-computed stale commit is acked, dropped, and recorded, and
  replay stays idempotent; lineage SAFETY for dependents (per the
  provisional semantics above): a descendant commit whose payload was
  derived from the dropped optimistic value must not apply unchanged —
  the tests validate whichever reject/retry/cascade resolution the
  follow-up settles on, rather than prescribing that every dropped origin
  satisfy downstream dependencies; mixed commit keeps strict semantics;
  race of two current computed commits is first-wins; unknown-scheme ids
  stay strict.
- Integration: two-client scenario where both recompute the same node —
  assert convergence with zero conflict-driven action re-runs; default-on
  instantiation syncs a manifest-linked `computed:fid1:` id through storage
  and reads it back (no special routing below the URI layer); `cf inspect`
  shows the computed value and the drop bookkeeping.

## Open Questions

- Should the engine cache per-entity kind or parse per operation? Parsing a
  string prefix is likely cheap enough to skip the cache.
- Is value-equality dedupe on current-read commits worth the comparison
  cost, or does drop-on-stale capture nearly all of the win?
- How should dropped commits surface in telemetry and `cf inspect` so that
  a misclassified cell (state writes being silently dropped) is diagnosable
  rather than mysterious? The flipped classifier polarity raises the
  stakes: the input-side `$ctx` walk is the code whose under-collection
  would produce exactly this failure.
- Do `type: "pattern"` writers stay qualifying? Instantiation writes are
  expected to converge on replay; if they do not in practice, `"pattern"`
  moves to the disqualifying writer set (a one-line change).
- Interaction with multi-space commits (`enableMultiSpaceWrites`): per-space
  commits classify independently, but the partial-failure contract needs
  re-reading against ack-and-drop.
- Whether CFC flow-label derivation needs to observe dropped writes, or is
  indifferent to them.
- Authored nondeterminism escape hatches: `safeDateNow()` and
  `nonPrivateRandom()` are callable inside `computed()`/`lift()` bodies, so
  a `javascript` compute can be nondeterministic while still qualifying as
  a computed writer — no layer scans callback source for these calls.
  Today this rests on the nondeterminism invariant (first-wins plus
  sync-down correction; the failure mode is value flapping, never
  divergence or data loss). Undecided how to handle them: keep that
  stance, or fail closed by tainting modules that call the escape hatches
  so their output cells stay strict — the transformer's capability
  analysis (`capability-analysis.ts`) is the natural place to detect the
  calls, including through module-scope helpers via its interprocedural
  summaries.
- Deferred tooling gap: `XSchedulerGraph.#extractEntityId` (shell) groups
  graph nodes by scheme-stripped entity id, so an `of:` doc and a
  `computed:` doc minted from the same cause would be conflated into one
  group in the debug graph. This is more than cosmetic debt: the scheduler
  treats computed cells differently (ack-and-drop instead of conflict
  retry, recompute-on-sync convergence), so the kind is a scheduling-
  relevant property the graph view should surface as a first-class visual
  dimension — distinct grouping keys at minimum, and eventually a distinct
  color/badge for computed nodes so drop-and-recompute behavior is legible
  when debugging settle waves.
