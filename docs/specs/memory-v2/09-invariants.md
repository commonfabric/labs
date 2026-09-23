# 9. Consistency Invariants

This document is the normative catalog of end-to-end consistency invariants for
Memory v2. The other chapters state requirements per mechanism (the commit
model, the conflict matcher, the protocol); this chapter states the properties
those mechanisms exist to uphold, as a checkable list with stable identifiers.

Why it exists: optimizations to conflict detection and commit admission almost
always work by *narrowing an approximation* — fewer recorded dependencies, a
more precise overlap matcher, a later staleness basis. Each such change must be
argued against the invariant it narrows toward, not against the previous
implementation's behavior. A change that satisfies the letter of one
mechanism's MUST can still break a property nobody restated; this catalog is
where those properties are stated once.

## How to use this catalog

- **Reference invariants by ID** (e.g. `INV-1`) in PR descriptions, review
  comments, code comments, and tickets whenever a change touches commit
  admission (including ACL admission), conflict detection, dependency
  recording, or client replay.
- **Every entry names its soundness direction.** Most invariants are
  asymmetric: one direction of approximation is safe (costs a retry), the
  other is corruption. An optimization is admissible only if it moves
  *within* the safe direction.
- **Known deviations are listed, not hidden.** An invariant with an open
  violation stays in the catalog with the ticket attached; the catalog
  describes the contract, not the current score.

Checkers referenced below:

- the **durable-history oracle**: `staleReadAnomalies` in
  `packages/state-inspector/oracle.ts`, which replays the engine's own
  admission predicate over a space DB's commit history
  (`packages/state-inspector/test/engine-oracle.test.ts` proves it detects
  seeded corruption);
- the **differential harness**:
  `packages/memory/test/v2-differential-consistency.test.ts`, which runs
  seeded random commit schedules against the engine and a naive reference
  validator (`packages/memory/test/naive-admission.ts`);
- the **TLA+ model**: `docs/specs/memory-v2/tla/PendingStacks.tla`, which
  model-checks INV-1/INV-3/INV-4/INV-5 over all small interleavings for each
  dependency-recording, staleness-basis, and identity-acceptance variant,
  and — in its delayed-verdict-delivery mode (the `PendingStacks_Channel*.cfg`
  configs) — INV-6 over the decided-but-not-yet-processed window.
- the **delivery model**: `docs/specs/memory-v2/tla/SessionDelivery.tla`,
  which model-checks INV-14 over one session's watch delivery across lost
  pushes, a wiped replica, and both reconnect paths (resumed and
  re-established), for each diff-base design (`SessionDelivery_*.cfg`).

## The invariants

### INV-1 — Read coherence (no phantom, no missed write)

> Every read recorded by an **accepted** commit observed exactly the durable
> state at the commit's resolution point: the set of writes that produced the
> observed value equals the set of accepted overlapping writes with
> `seq < commit.seq` (restricted to the read's path, branch, and scope).

This is the master invariant. It forbids both failure directions at once:

- **Phantom read** (observed ⊃ durable): the observation includes a write
  that was never durably accepted — e.g. a rejected pending layer whose
  optimistic value leaked into a dependent commit's observation. This is the
  CT-1872 "1c corruption" shape.
- **Missed write** (observed ⊂ durable): a concurrent accepted write
  overlapping the read landed before the reader's commit but after its
  recorded basis, and admission did not scan it. This is the CT-1910 shape.

Layer: server admission (`validateConfirmedReads`, `resolvePendingReads` in
`packages/memory/v2/engine.ts`) together with client dependency recording
(`packages/runner/src/storage/v2.ts`, `v2-transaction.ts`).

Soundness direction: admission MAY reject a commit whose observation is in
fact coherent (over-rejection costs a retry). It MUST NOT accept a commit
whose observation is incoherent.

Checked by: the durable-history oracle (any hit is by construction a
violation); the TLA+ model's `ReadCoherence` invariant; the differential
harness's replay comparison.

Known deviations: **CT-1910** (pending-read basis over-advance), repaired
for readers that declare `basisSeq` and RETAINED for legacy readers that do
not: a pending read without `basisSeq` is scanned from the highest
dependency's resolution seq, so overlapping foreign writes landing between
the reader's confirmed basis and that seq are not scanned. A read declaring
`basisSeq` is scanned over the full interval from that basis, excluding
only the own-session layers its dependency array NAMES — the accepted
layers whose inclusion in the reader's view the array attests; an own
write the array does not name conflicts like a foreign one, whether
admitted out of submission order or omitted while durably integrated
(03-commit-model.md §3.6.3) — the shape current clients always emit. The TLA+ config
`PendingStacks_Current.cfg` reproduces the legacy-shape violation (kept as a
regression witness, alongside the legacy-shape engine test in
`packages/memory/test/v2-pending-read-basis-overadvance.test.ts`) and
`PendingStacks_Repaired.cfg` certifies the repaired shape in the bounded
model. The residual deviation retires when clients that omit `basisSeq`
fall below the support floor.

A second deviation is deliberate: an **identity commit**
(`03-commit-model.md` §3.6.1), which leaves every document it writes as the
space already holds it, is accepted without a staleness check. Its
observation may be stale in this invariant's terms, but it produced no
write, so the durable state at its resolution point is unchanged by it and
the phantom and missed-write failures both have nothing to act on. What
makes the acceptance sound is that the server proves the identity itself,
inside the commit's transaction: per document, the commit's ordered `set`
and `patch` operations replayed on the view the reader saw yield the stored
document, and replayed on the stored document leave it unchanged, where a
pending read's view is its declared confirmed basis with exactly the own
layers it names replayed on it; a client claim would not do. The
differential harness's reference model applies the idempotence half alone,
so it admits a superset of what the engine admits. The TLA+ model's `IdentityMode = "elide"`
(`PendingStacks_Identity.cfg`, `PendingStacks_ChannelIdentity.cfg`) certifies
the rule in the bounded model under this invariant's content form,
`ContentCoherence`: the writer-set form `ReadCoherence` is not the statement
once a layer can be accepted without a revision, because the elided layer is
observed by its own session as a contributor while durable history holds the
foreign write that carried the same value, so the writer sets differ where
the content does not (`PendingStacks_IdentityWriterForm.cfg` is the witness,
on the writer-set form restricted to commits that wrote). `ElidedUnchanged`
pins the exemption's premise: every path an elided commit would have written
already held its value at its resolution point.

### INV-2 — Overlap over-approximation only

> Write/read overlap detection MAY over-approximate (report overlap where
> none exists) and MUST NOT under-approximate (miss a real overlap). A real
> overlap is: the write changed a value the read's result depends on.

This is `03-commit-model.md` §3.6.2 restated as the standing rule for every
matcher refinement. The three granularity refinements in
`08-conflict-granularity.md` (leaf-only touched paths, nonRecursive shape
reads, asCell reference-resolution exclusion) are each an argument that a
narrowing stays on the safe side; any future refinement owes the same
argument, including its whole-system preconditions (e.g. leaf-only matching
is sound only because the runner never emits indexed-array structural ops —
guarded by `assertNoIndexedArrayStructuralOps`).

Layer: `patchOverlapsRead`, `patchOverlapsNonRecursiveRead`,
`touchedLeafPathsForPatch`, `touchedPathsForPatch` (engine); read tagging and
exclusion at the client boundary (`reactivity-log.ts`,
`SpaceReplica.#buildReads()`).

Soundness direction: toward precision only from above; never below exact.

Checked by: the differential harness (engine-accept must imply
naive-accept, where the naive validator implements exact overlap); the
generator test asserting the runner's array-op discipline
(`packages/runner/test/memory-v2-native-commit.test.ts`).

### INV-3 — Dependency completeness and staleness-basis selection

> A commit that reads a document through a pending stack records a dependency
> set that (a) includes every pending layer whose acceptance or rejection can
> change the observed value, and (b) includes the top-of-stack layer of the
> reader's materialized view. For a read declaring its true confirmed basis
> (`basisSeq`), the staleness scan runs from that basis with declared-set
> own-session exclusion; for a legacy read, the top-of-stack layer's
> resolution is the staleness basis. Narrowing may drop only non-top layers
> that provably cannot influence the observed value: a layer whose write
> footprint misses the read path, or a layer the overlay removed before the
> view was built (a processed rejection — see below).

Clause (a) is what makes rejection cascades reach every semantically
dependent commit (see INV-4); recording fewer layers than the value's true
contributors is how phantoms are born (CT-1872 1c: the pre-#4606 scalar shape
named only the top writer of the read path and missed a rejected lower layer
that also wrote it). Clause (b) anchors the cascade at the stack top; for a
LEGACY read it is also `03-commit-model.md` §3.5's basis rule — basing that
scan below the top of stack without own-session exclusion is unsound, not
merely conservative, which is exactly why the `basisSeq` shape pairs its
lower basis with the exclusion (§3.6.3).

The current full-stack recording (every layer of the document, no overlap
filtering) over-approximates clause (a) — safe direction, costs false dooms
(the CT-1872 over-coupling). The proposed overlap-filtered refinement must
keep every layer overlapping the read path *and* the top-of-stack layer; the
TLA+ config `PendingStacks_Filtered.cfg` certifies that shape in the bounded
model. Dropping a layer that overlaps the read path instead re-creates the
CT-1872 phantom — an INV-1 violation.

Completeness is relative to the reader's VIEW, not to the session's commit
history (`03-commit-model.md` §3.5): a layer the overlay removed before the
view was built — a rejection verdict honored, the view rebuilt without it —
is not a contributor under clause (a), so its absence is a sound narrowing
and the recorded array may be non-contiguous in the session's `localSeq`
space. The server verifies the durable half of the completeness claim: the
declared-set exclusion (§3.6.3) makes an omitted own layer's durable
overlapping write conflict like a foreign one, so an accepted omission is
one whose omitted layers contributed nothing durable — which a processed
rejection never does. Only the never-durable half stays on the client's
honor: an omitted REJECTED contributor's optimistic value never crossed the
wire, so that omission is unverifiable and sits in the same trust class as
a fabricated read. The interleaving this
permits — rejections honored eagerly while an accept's promotion is still
parked — is reachable in the TLA+ model's `fullstack` recording mode:
rejection removes the doomed layers from the pending stack, an accepted
layer stays pending until `Integrate`, and a later `Build` records only the
survivors — a sparse set relative to session history. The delayed-delivery
mode (the `PendingStacks_Channel*.cfg` configs) additionally certifies the
window where a rejection is decided but not yet processed: a commit built
there still names the dead layer and is refused by the dead-dependency
admission rule, while a commit built after the processed drop records the
sparse survivor set and is admitted.

Layer: client dependency recording (`packages/runner/src/storage/v2.ts`
pending-stack bookkeeping); server resolution (`resolvePendingReads`).

Soundness direction: MAY record more layers than semantically necessary;
MAY omit a layer the overlay dropped before the view was built (a processed
rejection is no longer a contributor); MUST NOT omit a layer of the view
that overlaps the read path, and MUST NOT omit the view's top-of-stack
layer. A legacy read MUST NOT base its staleness scan below
the top of stack; a `basisSeq` read scans from its declared basis and MUST
exclude only the own-session layers its array names — an own write it does
not name conflicts like a foreign write, whether accepted out of
submission order or omitted while durably integrated. The declared-set
exclusion is what lets the server VERIFY the completeness claim against
durable history instead of trusting it; the phantom direction (an omitted
rejected contributor) remains unverifiable, as recorded in §3.5.

Checked by: the TLA+ model (both recording modes, under atomic and
delayed-delivery configs) for recording completeness and sparse-omission
reachability — its `Build` always names the view's full layer set, so the
declared-set scan's VALIDATION half (a buggy omission of a durably
integrated layer) is outside its reach and is checked instead by the
engine unit tests (`packages/memory/test/v2-sparse-pending-dependencies.test.ts`),
the differential harness's sparse mutation, and stacked-commit unit
tests (`packages/runner/test/memory-v2-stacked-commit.test.ts`); see the
TLA README's "Canonical dependency arrays" note for the coincidence
argument and the `SkipLayers` refinement that would bring it in scope.

### INV-4 — Cascade totality

> If a pending commit is rejected, every commit whose recorded dependency set
> names it is also rejected (server side), and no commit naming it is left
> standing on the client: one already queued or in flight is dropped before
> its verdict arrives, and one minted after the rejection is refused before
> it is sent. Combined with INV-3(a), no commit built on a rejected layer's
> optimistic value is ever durably accepted.

The client mirror has to cover both halves because a rejected layer outlives
its verdict: the drop waits for the conflict's read repair, and the layer is
visible to dependency recording for that whole window. Covering only the
drop leaves every commit minted during the repair to be sent and refused by
the server, one round trip each.

Note the division of labor: the cascade mechanism is only as good as the
dependency sets it walks (INV-3). A complete cascade over incomplete
dependencies still admits phantoms.

Layer: server (`resolvePendingReads` rejection path); client drop cascade
and pre-send refusal (`packages/runner/src/storage/v2.ts`).

Soundness direction: MAY drop commits that name a rejected layer they did
not semantically depend on (over-coupling, a wasted retry); MUST NOT leave a
dependent commit standing.

Checked by: the TLA+ model; stacked-commit tests; the differential harness.

### INV-5 — Per-session monotonic resolution

> Within a logical session, commits resolve (accept or reject) in increasing
> `localSeq` order. A held commit is never leapfrogged by a later
> same-session commit. Consequently a commit's resolution seq is monotonic in
> its `localSeq`.

This ordering is what makes the top-of-stack staleness basis sound (INV-3(b)
depends on it): every own-session layer below a reader resolves at or before
the basis layer's seq, so the scan interval past the basis contains no
own-session commits.

Layer: server session queueing (`03-commit-model.md` §3.6.3 — the current
implementation rejects rather than holds, which preserves the ordering
trivially).

Soundness direction: none — this is an exact ordering requirement, not an
approximation. Any reordering optimization (parallel admission, speculative
holds) must re-establish it.

Checked by: the TLA+ model (FIFO processing is load-bearing there; any
future relaxation should be modeled first); reconnect/race unit tests.

### INV-6 — Accepted-versus-dropped agreement

> The server and the client never disagree about a commit's fate: a commit
> the client has locally cascade-dropped is never durably accepted, and a
> commit the server has durably accepted is never treated by the client as
> dropped.

This is why the scalar downgrade rule exists (`03-commit-model.md` §3.5): a
client talking to a server without `pendingReadStacks` MUST hold a commit
whose omitted lower dependencies are unsettled, because the server could
durably accept what the client is about to cascade-reject.

Layer: client send gating and replay (`v2.ts`, reconnect paths); server
dedup by `(sessionId, localSeq)`.

Soundness direction: MAY hold a send longer than necessary; MUST NOT send a
commit whose local doom is still possible, and MUST NOT locally drop a
commit whose acceptance is still possible without confirming its fate.

Checked by: the TLA+ model's delayed-delivery mode
(the `PendingStacks_Channel*.cfg` configs, invariant
`AcceptedVersusDropped`), which splits the server's decision from the
client's processing, runs the rejection drop-and-cascade at the
processing point, and checks that a locally
cascade-dropped commit is never durably accepted — the guarantee rests on
FIFO admission plus the dead-dependency rule, and the model checks that
composition rather than assuming it. The CT-1927 parking window is in
scope (promotion waits for `Integrate`, and a covering frame cannot
precede its verdict). What the model still does NOT cover is connection
loss and replay — the scalar-downgrade hold and reconnect races remain
covered only by example-based tests (reconnect-race,
pending-commit-durability); extending the channel with loss and re-send is
the remaining refinement.

### INV-7 — Committed writes are never silently dropped

> A write that reached `.commit()` successfully either becomes durable or its
> failure is surfaced to the caller (rejection, revert notification, retry
> exhaustion). There is no path on which it silently vanishes.

Stated in
[Committed-write backpressure](../../features/committed-write-backpressure.md);
listed here because retry-loop and backpressure optimizations are the changes
most likely to violate it.

Layer: client retry/backpressure (`scheduler/backpressure.ts`, storage
rejection taxonomy in `rejection.ts`).

Soundness direction: MAY surface a failure for a write that would have
eventually succeeded; MUST NOT drop one without surfacing.

Checked by: backpressure and convergence-storm tests
(`packages/patterns/integration/convergence-storm.test.ts` asserts all 2K
contended writes land).

### INV-8 — Transaction atomicity

> All material state changes of an accepted transaction land at one seq, or
> none do. No partial visibility, on the server or in any client's
> integrated view.

An operation the engine PROVES changes nothing — a `set` of a
content-addressed (`cid:`) document whose stored content is value-equal to
the operation's — applies as a no-op: no revision row, no head update, no
dirty mark. The commit row and the space sequence still advance, and the
verdict reports the elided operation indexes. Atomicity is therefore
phrased over material changes, not over one revision per submitted
operation: every operation that changes state lands at the commit's seq,
and a no-op operation is exact by proof, not a torn apply.

Layer: engine (`applyCommitTransaction` runs in one database transaction);
client integrate path.

Soundness direction: none — exact.

Checked by: engine unit tests; the differential harness's value-replay
comparison (a torn apply diverges from the naive fold).

### INV-9 — Log determinism and convergence

> An entity's value is a deterministic function of the accepted commit log
> prefix: `value = fold(apply, genesis, log[1..n])`. Any two replicas that
> have integrated the same prefix compute identical values, and a stored
> snapshot equals the replay of its prefix (`01-data-model.md` §7.3).

Layer: patch application (`packages/memory/v2/patch.ts` server-side, the
client apply path in `v2-document.ts`); snapshot materialization.

Soundness direction: none — exact. Note this requires client and server
apply semantics to be identical; a "fast path" on one side that reorders or
coalesces ops differently is a violation even if each side is internally
consistent.

Checked by: the differential harness (engine `read` versus naive fold);
`packages/state-inspector` convergence verdicts
(`multispace.ts`) and `reconstruct-parity.test.ts`.

### INV-10 — Single-snapshot reads

> A transaction's recorded read set describes one coherent local snapshot:
> confirmed bases from one integrated prefix plus the session's own pending
> stack, never a mixture of states observed across an integration boundary
> (`03-commit-model.md` §3.3.4).

Layer: client, in either of the forms `03-commit-model.md` §3.3.4 admits:
sync-frame buffering while a transaction builds, or the runner's commit-time
claim check, which re-reads every document the transaction snapshotted from
the state the read set is built from and rejects the transaction locally when
a value differs.

Soundness direction: MAY reject a transaction whose reads are in fact coherent
(a local rejection costs a re-run); MUST NOT export a read set that mixes two
prefixes.

Checked by: `packages/runner/test/commit-read-basis.test.ts` for the claim
check (a document that lands under an open transaction rejects the commit
locally); the durable-history oracle would surface a resulting incoherent
acceptance as an INV-1 hit.

### INV-11 — Idempotent replay

> Replaying a commit after reconnect is idempotent: the server deduplicates
> by `(sessionId, localSeq)`; an identical payload returns the original
> result, a differing payload is a protocol error, and replay never produces
> a second durable commit.

Layer: server dedup (`03-commit-model.md` §3.7.4); client retained-commit
replay.

Soundness direction: none — exact.

Checked by: engine and reconnect unit tests.

### INV-12 — ACL mutation commit shape

> A commit that touches a space's ACL document (entity id `of:<space>`) is
> admitted only if it is, all at once: the **only** operation in the commit;
> an `op: "set"` on exactly that id, with `scope` `"space"` or absent; on the
> default branch (`branch` absent or `""`); and carrying a value that
> satisfies `isACL` and retains at least one **concrete** (non-`"*"`) OWNER.
> Every other shape — a patch, a delete, a different scope, a mixed ACL/data
> commit, a non-default branch, an ownerless or malformed result — is a
> `ProtocolError`.

This is `04-protocol.md` §4.5.1's normative sentence ("A valid ACL mutation is
a whole-document, space-scoped replacement on the default branch and must
retain at least one concrete OWNER") restated as a checkable entry, because it
is the invariant a client is most likely to violate without knowing the rule
exists.

The generic invitation service commits its private admission records and unique
redemption receipts in the same engine transaction as an ACL-only system commit.
That internal operation reads current authority under the SQLite write lock and
publishes cache and watch changes only after durable commit. Its only public
document operation remains the whole-document ACL `set` described here. Private
invitation metadata is not part of `ClientCommit` and cannot be submitted through
`session.transact`. See the
[invitation service contract](../../../packages/toolshed/README.md#space-invitations).

The clauses are checked in this order, each rejecting with a `ProtocolError`
carrying a distinct message (so a message identifies the clause):

| Clause | Rejection message |
| --- | --- |
| default branch | `ACL mutations are only valid on the default branch` |
| exactly one operation | `ACL mutations must be an ACL-only commit` |
| whole-document `set` on `of:<space>`, scope space-or-absent | `ACL mutations must replace the space-scoped ACL document` |
| result is a valid ACL with a concrete OWNER | `ACL must be valid and retain at least one concrete OWNER` |

It holds in **both** `observe` and `enforce`, and is skipped only when
`MEMORY_ACL_MODE` is `off`. The code states its own reason for keeping it
outside the mode dial: it is a *storage* invariant, not an access decision —
"an invalid ACL or an ordinary first write would make later enforcement
ambiguous or impossible" (`#validateAclCommit`'s doc comment). The shape check
also runs *before* the OWNER capability check on the same commit, so a
malformed ACL write reports `ProtocolError` even from a principal that has no
OWNER capability at all.

On the whole-document clause specifically, one mechanical observation is
available and no stated rationale is: the validity clause inspects
`operation.value?.value` — the document the operation itself carries — and of
the four operation shapes only `SetOperation` carries one (`patch` carries
patch ops, `delete` and `sqlite` carry no document). So under whole-document
replacement the value the server validates *is* the document the commit
produces. That is an observation about the current check, not recovered
intent: the rule arrived with ACL enforcement in #4670 (`4eb3026d1`) with no
separately stated motivation, and no spec gives one. Anyone proposing to relax
it owes the argument #4670 did not record.

Layer: server admission (`#validateAclCommit` in
`packages/memory/v2/server.ts`); client emission (`ACLManager` in
`packages/runner/src/acl-manager.ts`, which satisfies the rule by addressing
the whole document at path `[]` — a write through the ordinary value surface
decomposes into per-key `op: "patch"` details and is refused).

Soundness direction: none — an exact admission predicate, with a real cost on
each side. Over-rejection is not merely a retry: a client that cannot produce
the accepted shape has no route to change the ACL at all, which is what
happened while `ACLManager` wrote through the value surface — every
post-genesis grant and revoke failed, and the wildcard a named space is born
with could not be removed. Over-acceptance lets the ACL document reach a state
no admission check ever validated.

Checked by: example-based server tests only — no oracle, TLA+, or differential
coverage. `packages/memory/test/v2-server-acl.test.ts`: "ACL mutations must
preserve a concrete owner" (rejects `delete`, `patch`, `scope: "user"`, and
empty / wildcard-only-owner / downgraded-owner / invalid-capability values) and
"ACL mutations are default-branch ACL-only commits" (rejects a non-default
branch and a mixed ACL+data commit, asserting the data operation did not land).
Client side, `packages/runner/test/memory-v2-acl-mutation.test.ts` asserts the
emitted operation *shape and count* against a real server, not just the
resulting value.

### INV-13 — ACL genesis precedence and authority

> A space's ACL document must exist before any ordinary write is admitted, and
> the commit that creates it must come from the space's own identity or from an
> identity the deployment has designated. Concretely:
> with ACL state missing and server sequence 0, a commit that does **not**
> touch `of:<space>` is refused; and a commit that **does** touch it while ACL
> state is missing is refused unless the session's principal is the space DID
> itself or a configured service DID (`acl.serviceDids` /
> `MEMORY_SERVICE_DIDS`).

Genesis is the one commit with no prior ACL to authorize it, so its authority
is derived rather than granted. Both clauses reject with an
`AuthorizationError`: `Space <space> requires an ACL genesis commit before
ordinary writes` for the precedence clause, and `Only the space identity or a
service DID may initialize <space>` for the authority clause. Like INV-12 this
is enforced in `observe` as well as `enforce`, for the reason quoted there.

The precedence clause binds only at server sequence 0. A *populated* space that
never had an ACL is not forced through genesis; it falls under the temporary
pre-launch compatibility rule in `04-protocol.md` §4.5.1 (authenticated
READ/WRITE, never OWNER). Retracted, malformed, and ownerless ACL state is not
equivalent to missing state — it fails closed rather than reopening genesis.

Layer: server admission (`#validateAclCommit`). The operator `writeDocument`
path enforces the same precedence separately and additionally refuses *any*
direct write to the ACL document, so genesis cannot be performed off-protocol.

Soundness direction: none — exact.

Checked by: example-based server tests only.
`packages/memory/test/v2-server-acl.test.ts`: "an ordinary opener cannot claim
or write a new space", "the space identity initializes a private space",
"service DIDs have implicit OWNER and do not claim spaces", "acl observe:
fresh-space genesis remains a hard invariant", "direct writes cannot create or
mutate ACL state", "a retracted ACL fails closed instead of becoming public",
"a genesis ACL without a concrete OWNER is refused and the space stays
uninitialized".

### INV-14 — Reconnect convergence

> A reconnect brings a session's replica to the current state of its watch
> union: after the reconnect's frame, every document the union covers is
> held at its current seq (a tombstone as a tombstone, an uncovered document
> removed), whatever the replica lost, was wiped of, or missed while away.

This is the mandatory clause. Its efficiency companion — **no redundant
delivery**: the frame delivers nothing the replica already holds at its
current seq — is NOT part of the correctness contract. A redundant delivery
is a wasted frame the replica's monotonic seq guard drops as a no-op, so
convergence never depends on it; it is stated as `NoRedundantDelivery` in
the delivery model, and certified there, precisely so it can be checked
without being conflated with the safety property. Where the two pull apart
— a client that under-declares — convergence wins: the omitted document is
re-delivered.

The diff base is the client's DECLARED holdings (`04-protocol.md` §4.1.2,
§4.3.5), on a resumed session and a re-established one alike. The server's
own memory of what it delivered is a claim about the client the client cannot
contradict — a push it recorded and the client failed to absorb, or a replica
wiped under a surviving session, left the memory asserting a document the
replica did not hold, and the resumed catch-up elided it for the session's
life. A declaration is the diff's own vocabulary; its trustworthiness is a
property of how the CLIENT builds it, not a given (see the soundness
direction) — the runtime derives it from the last frame each document was
DELIVERED at, never from a locally promoted confirmed seq the server never
sent.

Layer: server (`holdingsToCacheEntries` and the resumed-open reconcile in
`packages/memory/v2/server.ts`; `buildDiffSync` against the declaration in
`watchSet`); client (`SpaceSession.holdingsProvider`, `reopen`/`restore` in
`packages/memory/v2/client.ts`; `SpaceReplica.holdings()` in
`packages/runner/src/storage/v2.ts`).

Soundness direction: the server MAY deliver a document the replica already
holds (a redundant frame is tolerated — the replica's monotonic seq guard makes
an equal or older re-delivery a no-op) and MUST NOT elide a document the
replica does not hold at its current seq. The client MAY under-declare (a
document it holds but omits is re-delivered) and MUST NOT over-declare: a
claim to hold a document at a seq it does not is the one input that makes the
server elide a real gap. The declaration is therefore derived from DELIVERED
state only — the seq and deletedness of the last `SessionSync` the replica
absorbed for each watched document — and never from `record.confirmed`,
which a local promotion (`confirmPending`: an own accepted write extrapolated
over the pending base) can advance to a seq carrying a value the server never
delivered. An own write the server elided as this session's echo declares the
older delivered seq and is re-delivered — redundant, never a gap. Pending and
never-seen keys are excluded for the same reason.

Checked by: the delivery model (`SessionDelivery_Holdings.cfg` certifies it
with loss, a wipe, union shrink, and the zero-watch reconcile in play;
`SessionDelivery_Memory.cfg` is the violation witness for the server-memory
base — the schema-doc quarantine residual; `SessionDelivery_MemoryFull.cfg`
witnesses the full re-download of a lapsed session under the old base). The
model certifies the SERVER's diff rule against a truthful declaration —
`tla/README.md` states the assumption set — and each CLIENT construction
obligation is pinned by a unit test instead: delivered-not-promoted seqs and
the end-to-end declaration by
`packages/runner/test/memory-v2-reconnect-holdings.test.ts`; branch identity,
the wire-boundary parse, and the zero-watch retraction by
`packages/memory/test/v2-session-holdings.test.ts`; the declaration on both
reconnect paths and the terminal restore against a server that cannot take
one by `packages/memory/test/v2-client-holdings.test.ts`.

## Change discipline

When a change narrows dependency recording, overlap matching, staleness
scanning, cascade scope, or retry behavior:

1. Name the invariant(s) the narrowing approaches, by ID, in the PR.
2. State why the change stays on the safe side of each soundness direction,
   including any whole-system preconditions it newly relies on — and guard
   those preconditions (assertion + generator test, as
   `assertNoIndexedArrayStructuralOps` does for INV-2).
3. If the change touches pending-stack recording, resolution ordering, or
   staleness bases, run the corresponding TLA+ configs (see
   `docs/specs/memory-v2/tla/README.md`) — add a mode to the model if the
   change introduces a new recording/basis shape. The same holds on the
   delivery side: a change to the reconnect diff base, the holdings
   declaration, or removal semantics runs the `SessionDelivery` configs,
   and a new base or declaration shape becomes a `Mode` variant there.
4. Run the differential harness; if the change makes the engine accept
   strictly more histories, the naive validator must agree on every newly
   accepted one.

When an invariant is found violated in the field or by a checker: file a
ticket, add it to the invariant's "known deviations" with the ticket ID, and
where feasible reproduce it as a TLA+ config or a differential-harness seed
before fixing — the reproduction is what certifies the fix.
