# CFC persisted declassification — grants, and the rewrite event

_Design for the thing Epic B scoped out (decision 1: "rewritten labels are
never persisted; store-label rewrite as a declassification event is out of
scope for this epic"). Spec ground: `08-12-store-label-monotonicity.md`
§8.12.7's three sanctioned widening routes, worked example §13.4.3, merged
§4.9.3 (ACL point query), `06-events-and-intents.md` §6.5. Grounded in the
shipped Epic B evaluator (`cfc/exchange-eval.ts`, `cfc/policy.ts`).
Written 2026-07-09 at owner request._

## 1. The spec names one route; its example is a different one

§8.12.7 sanctions three routes to post-hoc widening of a stored label:
access-time exchange rules (1), "an explicit store-label rewrite as a
declassification event: an intent-gated, policy-guarded operation (the shape
of §13.4.3's persistent share-policy update), never an ordinary write" (2),
and a new value carrying the wider label (3).

But §13.4.3 — route 2's own cited shape — does **not** rewrite a label. It
persists a `ShareGrant` record (`{owner, resourceRef, recipient, scope,
grantedAt, sourceIntentId}`) to policy state; "the grant is then consulted on
later reads." §13.4.4 then shows the consuming exchange rule (`guard:
{policyState: [{kind:"ShareGrant", …}]}` adding `User($recipient)`). The
worked-examples summary table blurs the two ("persistent policy state / label
rewrite"). These are different artifacts:

- A **grant record** is a durable *input to evaluation*: the stored label
  keeps its clauses; a route-1 rule consults the grant at access time. The
  label stays honest, monotonicity is never touched, and revocation is the
  grant's lifecycle.
- A **rewrite event** is a durable *output of evaluation*: the declared
  component itself widens, once, attributably. Reads thereafter need no
  policy evaluation — the widening survives export beyond the
  policy-evaluation domain.

This design: build **grants** as the standard persisted-declassification
mechanism (§2–3); specify the **rewrite event** precisely but keep it
unscheduled behind hard entry criteria (§4–5), because every piece of
substrate it needs is unbuilt and grants cover all but one use class.

## 2. Grant records (build this)

### 2.1 Shape and precedents

Two artifacts of exactly this kind already exist or are specced:

- The **space ACL document** (merged §4.9.3; `acl-manager.ts`,
  `memory/v2/server.ts`): one doc per space at a reserved address (entity id
  = the space DID), owner-gated writes, consulted at access time by a
  fail-closed point query, feeding runtime-minted `HasRole` facts into
  exchange evaluation. It *is* a durable audience grant.
- The **ShareGrant** (§13.4.3): per-resource, minted by a trusted policy
  writer after verifying intent evidence (rendered-state match, trusted
  surface concept, share authority).

A grant generalizes both: a content-addressed record at a reserved space-root
path (the storage discipline the archived B2b plan first named:
"content-addressed records verified on read, read under
`internalVerifierRead` so policy lookups never taint" — grants are now its
sole consumer, see the dependency note below), written only by a trusted
policy writer, shaped

```ts
// Shown for illustration only.
type CfcGrant = {
  kind: string;                    // "ShareGrant", …  — matched by policyState guards
  owner: DID;                      // whose release authority this spends
  resource: Reference | AtomPattern; // what it releases (doc ref or label-pattern scope)
  audience: unknown[];             // principal-like atoms, §3.1.8-validated
  grantedAt: number;
  expiresAt?: number;
  sourceIntentId?: Reference;      // §6 attribution when the intent substrate exists
  revoked?: { at: number; by: DID };
};
```

### 2.2 Consumption: the `policyState` guard kind

Before #4627, `ExchangeRule.preCondition` admitted `confidentiality |
integrity | boundary` guards only — §13.4.4's `policyState` guard kind was
unimplementable in B2a. The extension: a `policyState` guard names a grant
`kind` plus field
patterns; at evaluation the runtime resolves matching, unexpired, unrevoked
grants from the governing space's grant path (point query per candidate, the
§4.9.3 discipline: fail-closed on absent/malformed/unsynced; discovered from
atoms in the label under evaluation, never enumerated) and binds guard
variables from the grant's fields. Everything downstream is the shipped
evaluator: the fired rule adds the grant's audience as alternatives to the
matched clause, clause-locally (invariant 11), evaluation-time only.

Properties inherited for free:

- **Monotonicity**: untouched — the stored label never changes.
- **Revocation**: delete/expire/mark the grant; rules stop firing on next
  evaluation. "Disjunctions arise at access time" stays true.
- **Attribution**: the grant doc is written under the policy writer's
  verified identity with `writeAuthorizedBy`, carries `owner` +
  `sourceIntentId`; the policy-snapshot digest already binds *which rules*
  could consume it (B5's `PreparedDigestInput.policySnapshot`).
- **Audit**: grants are ordinary docs — enumerable per space at the reserved
  path, with history.
- **Single-use releases**: a grant consumed at a commit point claims a
  create-only receipt document causal to the grant id — the shipped
  exactly-once discipline (`experimental.commitPreconditions`: the event
  path already mints the handler result cell from the durable event id via
  `{resultFor: cause}` + `markCreateOnly`, and a duplicate handling dies as
  a `receipt-exists` permanent rejection, `runner.ts` /
  `scheduler/events.ts`). A consuming release claims
  `{grantConsumed: {grantId}}` the same way; standing grants simply never
  consume.

### 2.3 Soundness conditions (each red-first-testable)

1. **Write gate**: grant docs are writable only by the trusted policy-writer
   identity (reserved-path guard, same class as the S18 `["cfc"]` write
   guard); `audience` entries pass the §3.1.8 principal-like validation
   (`disallowedAuthoredClauseReason` — no Caveat/Expires alternatives); the
   writer verifies the granting principal's release authority over
   `resource` (inv-7: an audience is mintable only over content within the
   granter's own authority).
2. **Read non-taint**: grant lookups ride `internalVerifierRead` — they must
   not enter the consumed set or PC (the §4.9.3 point-query discipline;
   otherwise every gated read of a shared doc taints with the grant doc).
3. **Digest binding**: the resolved grant set joins the evaluation's
   identity. Cheapest sound form: fold each consulted grant's content address
   into the prepared digest input alongside `policySnapshot.digest` (same
   invalidation discipline — a grant changed between prepare and commit
   invalidates).
4. **Clause locality**: a grant releases only the clause(s) its consuming
   rule matched — inherited from the evaluator, where the CT-1874
   home-clause gate is now SHIPPED for label-carried policy selection
   (`referenced` records rewrite only the ref atom's home clauses,
   `exchange-eval.ts`); it applies identically when grants are discovered
   from label-carried atoms: a grant referenced from clause k must not widen
   clause j ≠ k.
5. **Cross-space representation**: a grant names DIDs; when its *existence*
   crosses spaces it is label-adjacent metadata and the inv-12 classification
   applies ([`cfc-label-metadata-confidentiality.md`](./cfc-label-metadata-confidentiality.md)).
   Same-space grants (the normal case) persist verbatim.

### 2.4 What grants cannot do

A grant is live state: it works only where the evaluator runs *and* the grant
doc is reachable. Three consequences — the exact residual that motivates the
rewrite event:

- **Export/publish**: a value released "to everyone, forever" (publishing)
  should not depend on a grant lookup succeeding for eternity.
- **Cross-deployment portability**: a doc synced into a deployment without
  the source's policy writer/grant path re-closes.
- **Read-path cost**: every gated read pays evaluation + point queries.

## 3. Build order for grants

1. `policyState` guard kind + grant resolution in `exchange-eval.ts`
   (evaluator change is additive; guards default-absent).
2. Reserved grant path + trusted-writer gate + §3.1.8 validation (the
   reserved-path, content-addressed, verify-on-read storage discipline).
3. Digest binding of consulted grants.
4. ShareGrant end-to-end: share UI → (until §6 intents ship) a
   trusted-builtin writer verifying authority directly → grant → release on
   read; the §13.4.3 verification list minus the intent-evidence rows, which
   strengthen when intents land.
5. Single-use grants — **shipped (#4649)**: `CfcGrant.singleUse: true`
   satisfies a `policyState` guard only in a CONSUMING evaluation context
   (the sink-request egress ceiling and the input-requirement gate on gated
   writes, under the `enforce` policy-evaluation dial — never the render
   ceiling or observe-dial diagnostics, where a grant would be spent by
   looking at it) and only while its consumption receipt is absent. The
   receipt is `grant:cfc:` + a digest of `{grantConsumed: {grantId}}` — the
   §6.5.1 `consumedCellId` shape on the item-2 address idiom, so the
   S18-class reserved-namespace write gate covers forging AND the
   re-arming delete. The releasing transaction stages the receipt write +
   create-only mark inside `prepareBoundaryCommit`, so consumption commits
   atomically with the release (no-consume-on-failure, §6.5.2) and a
   racing second release dies as a permanent `receipt-exists` rejection.
   **Requires `experimental.commitPreconditions`** (the storage commit
   emits entity-absent preconditions only under it): with the flag off —
   the default — single-use grants are unsatisfiable everywhere, fail
   closed, never silently multi-use. Standing grants are flag-independent.

Dependency note (revised 2026-07-10): the B2b space-hosted policy-doc plan
this substrate was to be shared with is DESCOPED — the owner decision is
that remote attestation covers deployment config for security-sensitive
inputs like `cfcPolicyRecords`, so attested federated peers provably
evaluate the same record set and space-hosted policy documents are not
needed for federation soundness (`cfc-spec-changes.md` SC-28). What B2b
still meant beyond storage shipped against the deployment snapshot:
label-carried `Policy(...)`/`Context(...)` selection with the CT-1874
home-clause gate (`referenced` records in `policy.ts` /
`exchange-eval.ts`). Grants therefore remain the ONE space-hosted policy
state, and this section's reserved-path machinery has no second consumer
planned.

_Implementation note (2026-07-09): items 1–3 shipped in #4627. The
`policyState` guard resolves through `ExchangeEvalContext.grantResolver`
(evaluator stays pure; variables bind from grant fields; unresolvable or
throwing resolution fails closed). `CfcGrant` records live in the **owner's
identity space** at `grant:cfc:` + a digest of the release scope
`{version, space, kind, owner, resource}` — identity is the scope only, so
the audience and lifecycle live in the value and revocation keeps the
address (a full-record hash would give revocations a fresh address while
the stale one kept resolving). Writes go through
`IExtendedStorageTransaction.writeCfcGrant()` and require a trusted
**builtin** implementation identity (pattern/handler code cannot author
durable release state); audience entries pass the §3.1.8 principal-like
validation shared with authored clauses (`clause.ts`); `owner` must equal
the acting principal — the fuller §13.4.3 intent-evidence chain lands with
item 4. Lookups ride `internalVerifierRead`;
`PreparedDigestInput.consultedGrants` binds each consulted grant's content
address (absent candidates carry an `"absent"` marker so a grant appearing
also invalidates), with a live prepare→revoke→commit-reject test. Item 5
shipped in #4649 (single-use consumption receipts — see the build-order
entry above; receipt consulted-state rides the same `consultedGrants`
binding). Item 4 remains open._

### 3.1 Reviewed snapshot copies

The native `cf-share-snapshot` surface implements a bounded route-3 operation:
it displays an exact JSON snapshot and runtime-verified audience, then creates a
new copy after a trusted host confirmation. The host-only runner module
`cfc/share-snapshot.ts` issues one-use consent objects; authored pattern imports
and streams cannot issue them. The source value and its labels stay unchanged.
This operation does not create a standing `ShareGrant` or complete item 4 above.

The copy may widen only a direct `User(actor)` clause owned by the authenticated
confirming principal. Every other source clause must already contain the
requested audience as a literal atom or alternative and remains in the copy's
label. The copy also carries an alternative admitting the actor or requested
audience. The audience comes from the destination cell's resolved space or its
persisted principal attestation, never a caller-supplied DID or schema claim.

Commit checks the reviewed value, resolved addresses, audience, and acting
principal again. Reads that established those facts are compared in the write
transaction and retain optimistic conflict checks. The immutable copy and an
actor-private audit receipt are written in the destination space in the same
transaction. The receipt retains any other source clauses and records the source
identifier, snapshot digest, audience, and host event identifier. Source integrity
endorsements are not transferred to the copy.

The renderer and runtime transport are trusted. The operation requires an
authenticated actor. When the host declares a runtime read ceiling, the source
must fit it. Otherwise, the source must fit the actor's own `User` ceiling
before the worker returns a preview. The recipient's access does not authorize
showing the actor a preview.
This reduced-evidence operation
does not establish the full hostile-host intent chain in §4. Its in-memory
one-use consent does not provide durable retry recovery. It releases only the
reviewed snapshot, with no release authority over later source changes or other
values. See [host embedding](../features/host-embedding.md) and the
[`cf-share-snapshot` component](../common/components/COMPONENTS.md#cf-share-snapshot)
for the host and pattern interfaces.

## 4. The rewrite event (specify now, build later)

When a widening must survive without evaluation (§2.4), route 2 proper: an
in-place widening of the **declared** component, executed as a
declassification event. Contract, if and when built:

1. **Intent-gated**: requires a consumed single-use intent whose parameters
   (target doc, clause, added audience) carry integrity per §3.8.4 robust
   declassification — release scope/destination/audience are
   integrity-sensitive parameters. The **consumption half of this substrate
   is shipped** (scheduler-v2 §7.6 / decision 13, flag
   `experimental.commitPreconditions`): a durable event id rides the handler
   transaction (`tx.dispatchedEventId`), every id minted in the handler
   frame derives causally from it, and a create-only receipt cell is the
   exactly-once witness — duplicate handlings collide as `receipt-exists`
   permanent rejections. What is still missing is the **refinement/evidence
   half** of §6, four named pieces: the `IntentEvent → IntentOnce`
   refinement chain, gesture-provenance binding to rendered state
   (§6.3/§6.7.3), the `exp`/`maxAttempts` attempt-cell ledger (§6.5.3), and
   long-intent display/cancellation. **None of the four gates the
   mechanism** — they raise assurance from "owner-authenticated call" to
   "provably user-gestured". A **reduced-evidence v1 is buildable on the
   receipt substrate alone**: the declassification event is an ordinary
   stream event `{doc, path, clauseDigest, audience}`; its handler is a
   trusted builtin that verifies release authority directly (`owner` ===
   acting principal from the trust snapshot — the shipped `writeCfcGrant`
   discipline) and consumes the event's receipt as the single-use gate. For
   the owner-decided case §3.8.4's conjunctive gate is satisfied in this
   form: the release condition *is* the authenticated owner's event, and
   the parameters' integrity is the verified session identity. The four
   §6 pieces slot in later without changing the event record or the gate.
2. **Policy-guarded**: the acting principal's authority over the target
   clause verified exactly as a grant writer would (inv-7), plus §8.10.5.2 —
   a broader audience is a new release judgment with its own evidence.
3. **A new monotonicity gate**: the event is the *sanctioned exception* to a
   gate that must exist first — without an enforced gate rejecting
   non-monotone declared-component changes outside an event, the "never an
   ordinary write" clause is unenforced prose. _Implementation note
   (2026-07-09): shipped in #4647 behind
   `RuntimeOptions.cfcDeclaredMonotonicity` (`off | observe | enforce`,
   default `off`) — the prepare-time re-mint check of §5's gate bullet
   (`cfc/declared-monotonicity.ts`, hooked at the persist walk), comparing
   each re-minted declared entry against the per-path join of the stored
   declared entries via the A2/A3 clause kernel, with
   `setCfcDeclaredWideningExemption` (trusted-builtin only, one
   `(doc, path, clauseDigest)` triple per tx, `cfcCanonicalClauseDigest`
   clause identity) as the event writer's exemption seam. No consumer of
   the seam is built — the event itself is superseded per §5._
4. **The event record**, adjacent to but not inside the `["cfc"]` envelope
   (SC-11 keeps envelopes churn-free and version-neutral): a **create-only
   document causal to the consumed intent's id** — the shipped receipt
   discipline reused, which gives the record ordinary journaling, atomic
   exactly-once creation (a re-run of the declassification collides as
   `receipt-exists`), and attribution through the normal write path, with
   the envelope untouched. Contents: `{doc, path, clauseDigest,
   priorLabelDigest, newLabelDigest, actingPrincipal, intentId, at}` —
   clause identity by canonical clause digest (clause *indices* are
   evaluation-ephemeral; the shipped `RuleFiring.clauseIndex` is explicitly
   firing-time-only and under-records for this purpose).
5. **Tighten-back is legal, un-widening is not retroactive**: a later
   monotone tightening (§8.12.5) may re-narrow the label, but reads served
   between event and tightening were released — the event is a real
   declassification, stated plainly.

**Considered and rejected — mechanized route 3** (rewrite = copy-forward with
a wider authored label + alias swap): sidesteps monotonicity entirely and
reuses the shipped authoring path (the B6 sanitizer already persists loosened
labels onto new values), but changes document identity — every inbound link,
sync client, and history consumer sees a different doc. Identity-preserving
widening is the whole point of route 2; if identity may change, route 3
already works today with no new machinery.

## 5. Entry criteria

Build **grants** when a product surface needs durable sharing (the share UI,
group-membership beyond space ACLs) — no blockers; the evaluator extension
and storage substrate shipped in #4627. For the **rewrite event**, the
dependency picture at mechanism level (2026-07-09):

- **Exists**: single-use consumption — `experimental.commitPreconditions`
  receipts (durable event id, event-causal record ids, create-only
  exactly-once witness); authority verification — the `writeCfcGrant`
  owner === acting-principal discipline; clause identity — the canonical
  clause form (`normalizeClause` + the canonical digest idiom) needs only a
  small `clauseDigest` helper; attribution — verified identities +
  `writeAuthorizedBy` builtin arm.
- **Shipped 2026-07-09, soaking**: the declared-component **monotonicity
  gate** (§4.3) — a self-contained prepare-time check comparing a re-minted
  declared entry against the stored one under `canUpdateStoreLabel`
  semantics (confidentiality may only add clauses or drop alternatives;
  integrity may only drop atoms — the A2/A3 clause helpers give
  subsumption), dialed `off | observe | enforce` like every other gate,
  with the event writer as its sanctioned exception hook. Built in #4647
  exactly in this shape (including the `cfcCanonicalClauseDigest` helper
  the "Exists" bullet anticipated); the remaining criterion is soak at
  `enforce` **before** the exception exists.
- **Missing, assurance-only**: the four §6 evidence pieces (§4.1) — they
  upgrade a v1, they do not gate it.

So the only *hard* remaining gate is (a): a real export/publish/portability
requirement that grants demonstrably cannot serve. **Resolved 2026-07-10
(owner decision): no such requirement is identified, and the two candidate
sources dissolve on inspection.** *In-fabric federation* runs on remote
attestation — every federated instance is a trusted runtime enforcing the
same rules, so the rewrite event's one technical differentiator ("trust-free
release": a rewritten label needs no policy/trust config at the destination,
grants need both) buys nothing where trust is ambient; grants replicate as
ordinary docs with the owner's space and evaluate locally. *Out-of-fabric
egress* (an HTTP POST, an email) is irrevocable by nature — and the honest
artifact for it is the **egress record** (§6), not a label rewrite: folding
a past external disclosure into the label would loosen *future* fabric
enforcement as a consequence of a leak, which is the wrong direction. The
rewrite event therefore stands **superseded on both flanks**; §4's contract
is retained in case a genuinely new requirement appears, and its
prerequisite (the monotonicity gate) shipped anyway on its own merits as a
declared-label integrity guarantee (#4647). "Publish" inside the fabric is
grants (revocable) or route 3 copy-forward (a new value, honestly);
"publish" outside the fabric is a sink release plus an egress record.

## 6. Egress records — irrevocability made honest

Revoking the fabric-side record of an external send must never read as
un-sending. That confusion is structural if external egress is modeled with
the same revocable artifact as internal sharing: a user who "revokes" sees
the grant disappear and reasonably believes the disclosure is undone, when
only the *record that we sent it* changed. The fix is a second artifact
class with the opposite lifecycle:

- The record is minted in two phases, because the transaction commits
  **before** the outbox flush and the release can still be refused during
  the flush (`verifySinkRequestRelease` runs post-commit): the committing
  transaction MAY stage an **attempt** marker, but the permanent **sent**
  record is created only by the **successful post-commit send path** — a
  create-only document causal to the outbox idempotency key (itself bound
  to the consumed intent), shaped `{valueDigest, destination,
  boundaryContext, releasedAudienceEvidence, at, intentId}`, the
  destination captured per §8.10.5.2's destination/audience binding (the
  spec's open destination-binding follow-up is exactly this evidence).
  Write ordering: **record, then clear the outbox entry** — a crash between
  send and record leaves a live outbox entry to reconcile from, so the
  record can understate but never overstate. An attempt marker with no sent
  record after the retry window means known-not-sent and MUST NOT display
  as "sent". (This is the same seam as the audit's open "post-commit outbox
  + sink-release re-verification contract" item — the two should be specced
  together.)
- **Permanent by construction**: the sent record is create-only (the
  receipt discipline), never deleted, no revocation surface. Reserved-path
  hosted like grants; readable as provenance.
- **No enforcement role.** The record never feeds a future release
  decision — the label keeps governing what the fabric itself serves (an
  external copy existing is not a reason for our runtime to serve the
  original more widely). It exists for honesty, audit, and UI derivation.
- **UI vocabulary**: *shared* (a grant — revocable; revoking stops future
  fabric reads) vs *sent* (an egress record — irrevocable; the only
  affordance is "left the fabric on T to D"). "Who can see this?" derives
  from current grants ∪ past egress records.
- **Composition with single-use grants**: a single-use grant consumed by an
  external send yields both artifacts atomically — the `grantConsumed`
  receipt (spends the grant) and the egress record (remembers the send) —
  in the same commit.

Substrate: create-only receipts (`experimental.commitPreconditions`,
shipped), the outbox's idempotency keys and sink-release instrumentation
(`onSinkReleaseReject`/`onSinkDedupHit` seams), and the §8.10.5.2
destination-binding follow-up for the evidence shape. This is a small
build, not a design program.

## 7. Spec-change queue

_All items below applied to the spec 2026-07-10 (specs f65553cf..fbc9c2fc:
§4.3.5 grants + policyState + single-use, §6.8 grantConsumed row, §8.10.7
egress records + post-commit contract, §8.12.7 2a↔§4.3.5 links); the
runner-side egress-records build remains open (SC-27)._

- **§8.12.7 route 2 splits** into 2a (durable grant records consumed by
  access-time rules — the §13.4.3/§13.4.4 shape, generalizing the §4.9.3 ACL
  document) and 2b (the in-place rewrite event proper, with the §4 contract:
  intent-gated, authority-verified, gate-first, event record with
  clause-digest identity, ledger outside the envelope). "Right when the
  widening is a durable owner decision" refines to: 2a when revocable or
  policy-derived; 2b only when the widening must survive without evaluation.
- **§13 worked-examples summary table**: "persistent policy state / label
  rewrite" unconflates into the two rows.
- **§6.8 cell-ID table** gains `grantConsumed` (single-use grants) when the
  §6.5 substrate is specced for the runner.
- **`policyState` guard kind** documented next to the exchange-rule grammar
  (§4.3.3 vicinity), with the §4.9.3-style fail-closed resolution rules and
  the CT-1874 home-clause constraint for label-carried discovery.
- **Egress records** (§6): normative text for the irrevocable release
  receipt at send sinks, riding the §8.10.5.2 destination/audience-binding
  follow-up — the record's shape, its create-only permanence, its
  no-enforcement-role rule, and the shared-vs-sent distinction. Tracked as
  SC-27 in [`cfc-spec-changes.md`](./cfc-spec-changes.md).

## Provenance

Runner seams: `exchange-eval.ts` (`RuleFiring` under-recording, guard kinds,
fuel/fail-closed), `policy.ts` (`PolicyRecord`/`PolicySnapshot` digests,
B2a scope note), `prepare.ts` (S18 privileged `["cfc"]` write guard, SC-11
idempotence skip, `derivePersistedLabel` authoring path,
`disallowedAuthoredClauseReason`, runtime-mint forgery gate),
`acl-manager.ts` + `memory/v2/server.ts` (reserved ACL doc, capability
resolution, owner-gated writes), `cfc/space-membership.ts` (fail-closed point
query, `HasRole` mint), B6 sanitizer discharge-onto-new-value
(`schema-sanitization.ts`). Spec: `08-12-store-label-monotonicity.md` §8.12.1
(`canUpdateStoreLabel`, spec/Lean only), §8.12.5, §8.12.7 (the three routes),
§8.12.8 (components, replacement-soundness); `03-core-concepts.md` §3.1.8
(conjunctive join, principal-like alternatives, no-silent-widening) and
§3.8.4 (robust declassification); `06-events-and-intents.md` §6.2/§6.4/§6.5
(processed/consumed/attempt cells — spec-only in the runner today);
`08-10-validation-at-boundaries.md` §8.10.5.2/§8.10.6 (audience expansion is
a new release judgment); `13-worked-examples.md` §13.4.3–.4 (ShareGrant +
consuming rule); merged §4.9.3 (HasRole fact generation). Exactly-once
substrate (scheduler-v2 §7.6 / decision 13, flag
`experimental.commitPreconditions`): durable event id on the handler tx
(`scheduler/events.ts` `tx.dispatchedEventId = queuedEvent.id`), handler
frame cause derived from it (`runner.ts` — "every id minted in this frame
derives from the durable event id"), create-only receipt cell
`{resultFor: cause}` + `markCreateOnly` as the exactly-once witness,
`receipt-exists` permanent rejection (`scheduler/events.ts`). Labs-side:
Epic B decision 1 (`docs/history/plans/cfc-future-work-implementation.md`), CT-1874
(home-clause constraint), [`cfc-label-metadata-confidentiality.md`](./cfc-label-metadata-confidentiality.md)
(grant records as label-adjacent metadata).
