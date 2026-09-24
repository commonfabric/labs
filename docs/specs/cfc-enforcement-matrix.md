# CFC enforcement × propagation × write-floor × trigger gating — the deployment mode matrix

_Spec residual: SC-13 in [`cfc-spec-changes.md`](./cfc-spec-changes.md) (§18)
and the `enforce-strict` differentiation (SC-13 / §18.6.3). This document
settles **which combinations of the five CFC dials are conforming deployment
states and in what order a deployment may advance them**. The shipped hosts sit
at the strict end of that order; what the ordering governs now is a deployment
moving away from it and back._

## 1. The five dials (all runtime-configured, all orthogonal)

CFC has five independent runtime dials. Each is a monotone ladder; none
subsumes another. Their current homes and defaults:

| Dial | Values (weak → strict) | `Runtime` default | Governs |
|---|---|---|---|
| `cfcEnforcementMode` | `disabled` · `observe` · `enforce-explicit` · `enforce-strict` | `enforce-strict` | whether a boundary **reason rejects** the commit ([types.ts](../../packages/runner/src/cfc/types.ts) `cfcEnforcementStrictness`) |
| `cfcFlowLabels` | `off` · `observe` · `persist` | `persist` | whether the per-tx **flow join is derived and persisted** as `derived` label components (S16) |
| `cfcWriteFloor` | `off` · `observe` · `enforce` | `enforce` | whether the **write-side `requiredIntegrity` floor** (SC-18, Epic D3) is checked against the written value's integrity |
| `cfcTriggerReadGating` | `false` · `true` | `true` | whether the **§8.9.2 trigger reads** — the addresses whose invalidating writes scheduled this run — join the enforcement consumed sets: the sink-request ceiling and the `requiredIntegrity` input gate (SC-3 / H5; [runtime.ts](../../packages/runner/src/runtime.ts) `cfcTriggerReadGating`, [types.ts](../../packages/runner/src/cfc/types.ts) `CfcTriggerReadGating`, consumed in [prepare.ts](../../packages/runner/src/cfc/prepare.ts) `triggerReadSources`) |
| `cfcPolicyEvaluation` | `off` · `observe` · `enforce` | `enforce` | whether the **exchange-rule evaluator** (spec §4.4.5, Epic B5) rewrites gated labels to a fueled fixpoint before the sink-request ceiling and `requiredIntegrity` input gates fit them. `observe` evaluates + diagnoses divergence but decides on the *un-rewritten* label; `enforce` decides on the *rewritten* label and **fails closed on fuel exhaustion or policy-lookup failure**. ([runtime.ts](../../packages/runner/src/runtime.ts) `cfcPolicyEvaluation` + `cfcPolicyRecords`, consumed in [prepare.ts](../../packages/runner/src/cfc/prepare.ts) `evaluateGatedConfidentiality`) |

They are orthogonal because they gate different things: the **enforcement mode**
decides what happens to a recorded reason (ignore / diagnose / reject); the
**flow dial** decides whether derived labels come into existence; the **write
floor** is one more reason-source, itself dialable so it can be observed before
it rejects; **trigger gating** widens what the existing gates count as consumed
(a handler scheduled by a labeled write is treated as having read it, even if
its executed branch never re-reads it); **policy evaluation** rewrites the label
a gate fits *before* the fit, so a discharge/exchange rule can admit a flow the
raw label would refuse (and, in `enforce`, a fuel-exhausted or unresolvable
rewrite becomes a fail-closed reason rather than a silent pass-through). A
deployment picks a point in the 4 × 3 × 3 × 2 × 3 cube — but most points are not
conforming, and the conforming ones are reachable only along a partial order.

### What each enforcement level means

- **`disabled`** — the boundary pass does not run as a gate; runtime-authored
  provenance mints still run (e.g. the external-ingest mark), but no reason ever
  rejects. CFC is descriptive only. This posture exists only by **explicitly
  passing** `cfcEnforcementMode: "disabled"` (toolshed constructs its `Runtime`
  with no CFC options and therefore runs the `enforce-strict` default; see §3).
- **`observe`** — the boundary pass runs and records reasons as **diagnostics**;
  the commit still succeeds. Used to measure reason volume before enforcing.
- **`enforce-explicit`** — a recorded reason **rejects** the commit, and that
  **includes the missing-policy case**: a write that touches a labeled doc with
  **no resolvable schema/policy input** records a
  `missing schema write-policy input` reason
  ([prepare.ts](../../packages/runner/src/cfc/prepare.ts)), and the enforcement
  ladder rejects any reasoned transaction under both enforcing modes
  ([extended-storage-transaction.ts](../../packages/runner/src/storage/extended-storage-transaction.ts));
  asserted under explicit mode in
  [cfc-boundary.test.ts](../../packages/runner/test/cfc-boundary.test.ts)
  ("missing schema write-policy input"). "Explicit" refers to which checks
  *run* — those whose declared inputs (policy, resolvable schema) are present —
  not to tolerating absent policy on labeled docs; that case is already
  fail-closed.
- **`enforce-strict`** — everything `enforce-explicit` rejects, **plus**
  strict-only fail-closed rejects. The one implemented today is the writer-fit
  misfit variant (SC-18b): the `canWrite` confidentiality misfit **rejects**
  rather than persist-and-flag (H4,
  [prepare.ts](../../packages/runner/src/cfc/prepare.ts) writer-fit,
  [cfc-writer-fit.test.ts](../../packages/runner/test/cfc-writer-fit.test.ts));
  future checks that want a persist-and-flag grace under explicit put their
  reject here, same shape.

The ladder is closed, and both places a mode is installed refuse a name off it
rather than land on no rung. `resolveCfcDials`
([posture-report.ts](../../packages/runner/src/cfc/posture-report.ts)) is where
every `Runtime` resolves its dials, and it throws when `cfcEnforcementMode` is
stated and is not one of the four names above; `setCfcEnforcementMode`
([extended-storage-transaction.ts](../../packages/runner/src/storage/extended-storage-transaction.ts))
throws the same way for the mid-transaction lever, which is on the public
transaction interface and so reachable from pattern code. A transaction holding
any other name would be on no rung: `cfcEnforcementStrictness` has no answer for
such a name and returns `undefined`, so every floor comparison against it reads
false — including the audit-S3 anti-downgrade floor, which therefore never
rises — while the commit gate, which asks only whether the name is one of
`disabled` and `observe`, reads the same name as enforcing.

## 2. Rollout ordering (the partial order)

Two hard ordering constraints (SC-13), plus one that D3 adds and one that H5
adds:

1. **`cfcFlowLabels`: `observe` before `persist`.** Persisting derived label
   components changes what is stored on real user documents; a deployment must
   first observe (diagnostics + benches: SC-11 idempotence, volume) that
   derivation is stable and cheap before it writes those components. This is
   the H1 → H2 step.

2. **`persist` before any enforcement that *consumes* derived labels.** An
   enforcement check that reads a `derived` component to make a reject decision
   is only sound once those components are actually being written — otherwise
   the check sees a partial label and either under-blocks (if it treats absence
   as public) or over-blocks (if fail-closed). So `enforce-strict` on the
   flow-derived paths presupposes `cfcFlowLabels: persist`. Concretely:
   `enforce-strict` (H4) and the render ceiling that consumes derived labels
   (H3a/H3b) must not precede H2.

3. **`cfcWriteFloor`: `observe` before `enforce`** (the D3 analog of #1). The
   floor is a new reason-source; observe its miss volume on real schemas before
   it rejects. Independent of the flow dial — the floor credits the flow meet
   only when `cfcFlowLabels: persist` (else it credits nothing, fail-closed), so
   `cfcWriteFloor: enforce` is *sound* at any flow setting but is only
   *complete* (does not over-reject a legitimately flow-endorsed write) once
   flow persists.

4. **`cfcTriggerReadGating` is one-hop only until flow persists.** The gate may
   flip on at any point — it only *adds* consumed labels, so it is sound at any
   flow setting — but it closes only the **direct** trigger channel. A handler
   can evade it through an intermediary: the triggered handler writes an
   **unlabeled** doc; that doc's write schedules a second run, which egresses —
   and the second run's trigger reads point at the unlabeled intermediate, so
   they contribute nothing. Multi-hop closure requires `cfcFlowLabels: persist`
   stamping the intermediate doc's derived label so the second hop's trigger
   read picks it up. Same shape as the write floor in #3: sound anywhere,
   **complete only once flow persists**.

5. **`cfcPolicyEvaluation`: `observe` before `enforce`, and `enforce` only
   *loosens*.** The evaluator adds alternatives (discharge/exchange), so a
   rewritten label fits *more* ceilings than the raw one — turning it on can
   only admit flows the raw label refused, never reject a flow the raw label
   admitted, EXCEPT the deliberate fail-closed cases: in `enforce`, fuel
   exhaustion or a policy-lookup failure records a reason instead of passing
   the un-rewritten label through (invariant 6 — a policy violation disables
   exchange, it never silently downgrades). So `observe` is the honest
   dial-up step (diagnose which labels the rewrite would have changed, decide
   on the un-rewritten label) before `enforce` lets the rewrite actually
   admit. It is **sound at any flow / enforcement setting** — it consumes the
   same consumed labels the sink-request and input gates already fit, only
   rewritten first — so it may advance on its own schedule. It is only
   *useful* once `cfcPolicyRecords` are configured (an empty policy set makes
   evaluation a no-op at every setting).

Everything else is free: a deployment may sit at any enforcement level with
flow `off` (the floor and the explicit gate need no derived labels), and may
advance `cfcWriteFloor` / `cfcPolicyEvaluation` on their own schedules. The
only forbidden moves are advancing a *consuming* enforcement ahead of the
*production* dial it consumes.

The `observe` rung on each ladder is a measurement stage, not a step the order
requires. What the order forbids is a consuming enforcement running ahead of
the dial that produces what it consumes; a deployment that moves a production
dial and its consumers together satisfies that whatever rungs it passes
through. The shipped defaults sit at the strict state directly, so an operator
who wants the measurement first states the intermediate rung rather than
finding it underneath.

```
cfcFlowLabels:   off ──▶ observe ──▶ persist ─────────┐
                                                       ├─▶ enforce-strict on
cfcEnforcementMode: disabled ▶ observe ▶ enforce-explicit ┘   flow-derived paths
                                                             + render ceiling (H3b)
cfcWriteFloor:   off ──▶ observe ──▶ enforce   (independent; complete once flow persists)
cfcTriggerReadGating: false ──▶ true           (independent; one-hop until flow persists)
cfcPolicyEvaluation: off ──▶ observe ──▶ enforce  (independent; only loosens, save fail-closed exhaustion)
```

## 3. Conforming deployment states

A **conforming state** is one where no enforcement consumes a label the flow
dial is not yet producing. The states a deployment is expected to pass through:

| State | enforcement | flow | write-floor | trigger | Meaning |
|---|---|---|---|---|---|
| **Operator (explicitly disabled)** | `disabled` | `off` | `off` | `false` | CFC descriptive only; provenance mints run, nothing rejects. Requires explicitly passing `cfcEnforcementMode: "disabled"`. |
| **Explicit** | `enforce-explicit` | `off` | `off` | `false` | Explicit checks enforce; nothing derived is produced or consumed. A host reaches this by stating the dials, since it is no longer what an unconfigured `Runtime` resolves. |
| **Explicit + flow** | `enforce-explicit` | `persist` | `off` | `false` | Flow labels persisted (H2, inv-9 active); floor not yet dialed. |
| **Explicit + floor observe** | `enforce-explicit` | `persist` | `observe` | `false` | Add the write floor as diagnostics (D3 dial-up step). |
| **Explicit + floor enforce** | `enforce-explicit` | `persist` | `enforce` | `false` | Floor rejects; complete on flow-endorsed writes (flow persists). |
| **Strict — the shipped default** | `enforce-strict` | `persist` | `enforce` | `true` | Writer-fit fail-closed (H4); render ceiling consumes derived labels (H3b); trigger reads gated, multi-hop complete since flow persists. Where the core pins in `presetCfcOptions` hold every preset — the server hosts ([toolshed/index.ts](../../packages/toolshed/index.ts), [background-piece-service main.ts](../../packages/background-piece-service/src/main.ts)) and the shell among them — and where an unconfigured `Runtime` resolves too, so the two agree without the hosts depending on the default. |

Trigger gating may flip to `true` at any of these states (ordering constraint
#4: it is sound anywhere) — the table shows it flipping at the end state
because before `cfcFlowLabels: persist` it closes only the one-hop channel.

`cfcPolicyEvaluation` is omitted from the state columns above because it
advances on its own schedule (ordering constraint #5: sound anywhere, only
loosening save fail-closed exhaustion). It defaults to `enforce`, which decides
gates on the rewritten label and fails closed on fuel exhaustion. A host that
declares no `cfcPolicyRecords` has no rules for the evaluator to run, so at that
rung it evaluates over an empty rule set and the decision is the one the raw
label gives; what the rung buys such a host is that configuring a policy set
later needs no second dial move. The `max-enforcement` bundle carries the §10.1
standard prompt-caveat profile.

**Non-conforming** examples (a linter/deploy-check should reject): any
`enforce-strict` with `cfcFlowLabels ≠ persist` (strict consumes derived labels
the dial isn't producing); `cfcFlowLabels: persist` with `cfcEnforcementMode:
disabled` is *permitted but pointless* (labels written, never consulted) — a
warning, not an error.

## 4. What `enforce-strict` adds (the H4 implementation contract)

H4's code step (separate PR) implements the strict-only rejects at the
enforcement ladder
([extended-storage-transaction.ts](../../packages/runner/src/storage/extended-storage-transaction.ts)),
each gated so `enforce-explicit` keeps today's behavior.

**Not part of the delta: missing-policy.** A write touching a labeled document
with no resolvable schema/policy input **already rejects under
`enforce-explicit`**: the prepare pass records a
`missing schema write-policy input for <id>` reason
([prepare.ts](../../packages/runner/src/cfc/prepare.ts)), the ladder rejects
any reasoned transaction under both enforcing modes, and
[cfc-boundary.test.ts](../../packages/runner/test/cfc-boundary.test.ts)
asserts the reject in explicit mode. Its SC-18c error contract (a stable reason
string naming the target) is likewise already shipped. H4 must **not** move
this check behind the strict gate — that would weaken the shipped shell
posture (anti-fail-closed).

The strict-only delta is:

- **Writer-fit reject (SC-18b) — implemented (H4 code step).** The per-tx flow
  join landing as a target's `derived` value component is measured against the
  target's DECLARED store-policy component (declared + legacy entries, resolved
  by the same per-component longest-prefix rule reads use; absent declarations
  are the empty "public" ceiling, fail-closed) joined with the target's
  RESIDENCY clause at each path where the component lands, with the shared
  clause-subsumption predicate of the egress gates (`atomsOutsideCeiling`).
  The residency clause is `Space(<the space the document lives in>)`. That
  atom's audience is the space's reader set — §4.9.3 resolves it by
  dereferencing its id against the space's ACL, the same document that decides
  who receives a replica — so every principal holding the bytes is inside the
  audience it names, and a flow clause listing the target's own space among
  its alternatives fits a document there whatever that document declares. The
  measurement admits the write; it does not drop the clause. The stamp
  persists the full join, so the egress and display ceilings gate reads on the
  unchanged label, and the space principal there reaches a concrete reader
  only through the verified `HasRole` exchange rule. Residency inherits the
  bound the render membership lookup carries: it is exactly as strong as the
  deployment's ACL posture. Under `enforce-strict` a misfit records a prepare
  reason and the commit rejects; every mode below persists the measurement and
  flags a `writer-fit(persist-and-flag)` diagnostic carrying the same reason
  string — so a deployment below strict keeps the persist-and-flag posture
  bit-for-bit on stored metadata. The reason string is stable and names the
  rule id, target, path, and offending clause(s) (SC-18c):
  `writer-fit confidentiality misfit for <doc> at /<path> (canWrite, §8.12.4):
  <clauses>`. Scope note (v1): link-covered writes carry per-slot link labels
  instead of the join and are outside the check, as is the pure-link-structure
  shape channel; grown existence atoms (SC-4) are historical and deliberately
  never measured — only the current join is; `Space` is the only principal
  form residency admits, because `User` and the bare DID-string spelling gate
  by equality against one acting reader, making their audience narrower than
  the set of principals a space grants reader roles to, while
  `PersonalSpace(<owner>)` names a space whose clause the measurement cannot
  build from a target address (SC-39); and the ungrantable
  read-failed marker sits outside every ceiling, the residency clause
  included, so a poisoned measurement never proves fit. The reserved policy
  namespaces are outside the check too: the durable policy manifests
  (`of:cfc-policy-manifest:<digest>`) and the release grants and single-use
  consumption receipts (`grant:cfc:<digest>`) hold policy state the runtime
  persists through its own privileged writers, gated at the transaction write
  chokepoint, so they are not value-write targets any of the write-side checks
  measure. The spec settles this rather than leaving it to implementation
  taste. A grant record is "a content-addressed record at a reserved location
  in the granting owner's space, written only by a trusted policy writer",
  whose "stored label never changes" (spec §4.3.5, and §8.12.7 route 2a).
  Policy manifests live in "a separate immutable store" and are "public
  artifacts", and a transaction MUST NOT persist a module-policy reference
  unless that same transaction create-only installs the byte-verified manifest
  (spec §4.4.2) — which the writer-fit reject would otherwise make impossible
  at this level. Implementation in
  [prepare.ts](../../packages/runner/src/cfc/prepare.ts) (`prepareBoundaryCommit`
  flow-persist stamping), asserted both ways in
  [cfc-writer-fit.test.ts](../../packages/runner/test/cfc-writer-fit.test.ts).
  Landing this also closed a reasoned-tx fail-open: `prepareCfc` now marks any
  transaction with recorded reasons CFC-relevant (`prepare-reasons`), so a
  reasoned tx whose reads never tripped an eager relevance mark cannot slip the
  ladder ([extended-storage-transaction.ts](../../packages/runner/src/storage/extended-storage-transaction.ts)).

  One of the forms residency excludes is readable in the DECLARED half of the
  ceiling, in one direction. A `PersonalSpace(owner)` LABEL clause answers a
  declared ceiling naming that owner, because §3.6.2's role order makes an
  owner a reader and §3.6.4 makes that principal the space's sole owner, and
  the fit test asks only that everyone the ceiling admits is entitled to the
  data. The reverse does not hold: a store DECLARING the atom is not read by
  that person alone, because adding a member converts the space and §3.6.5
  rewrites no labels, so a stamped clause outlives the conversion. `Space` gains nothing either way, for the reason residency lets
  it in — its readers are derived through verified `HasRole` exchange, and
  residency already joins the target's own space onto every ceiling, so
  covering it here would admit that data space-wide. The kernel owns the
  reading, so it holds at the egress, display, observation, and
  declared-monotonicity gates too. Recorded in
  [`cfc-spec-changes.md`](./cfc-spec-changes.md) SC-39.

  The raw meta seam is outside the check at EVERY rung, so a meta path
  raises neither a strict reject nor a persist-and-flag diagnostic. The
  measurement quantifies over paths a schema could have declared a policy
  at, and no value schema describes the document-root siblings of `value`
  that `setMetaRaw` addresses. One route does reach a ceiling there: a
  document-root declared entry resolves at every meta path by longest
  prefix. It is skipped anyway. That entry sits at logical `[]`, the
  payload root, and reaches the seam only because canonicalization strips a
  leading `value` — so it is not a declaration about the seam, and honoring
  it would make a piece updatable or not according to whether its pattern
  carries a root `ifc`. Declaring on a single result field, which is how a
  pattern normally labels one, leaves the seam's ceiling empty, and the
  piece is then un-updatable under strict because the pattern updater,
  `setsrc`, and setup over an existing piece all stamp meta.

  Two id classes are outside the check at every rung too, and that is the
  same rule over a document rather than over a path. A computed cell is the
  derived internal cell the runtime materializes to hold a derivation's
  result, under its own URI scheme (`computed:fid1:<hash>`; see
  [`computed-cell-identity.md`](./computed-cell-identity.md)). A stream's
  entries document holds that stream's durable event entries and the marks
  recording which of them have been handled, at an id derived from the
  stream's link so that the firing client, the serving space's drain and
  another space's outbox delivery all address the same document with no
  coordination (`STREAM_ENTRIES_DOC_PREFIX` and `streamEntriesDocId` in
  [`packages/memory/v2.ts`](../../packages/memory/v2.ts); the code and
  [`events.md`](./server-side-execution/events.md) also call it the stream's
  sidecar, which in this section is otherwise a background piece). A pattern
  names the data it declares policy on, and it names neither of these, so
  their ceiling is the empty one. Measuring a computed cell refuses every
  derivation that reads labeled data and writes its result; measuring an
  entries document refuses every mark a served run writes to record that it
  handled an event, and every entry a same-space served emission carries into
  the document on its own transaction. Both are ordinary operation rather
  than edge cases. One predicate covers those two classes, the marked class
  below, and the meta seam above (`isDeclarablePolicyPath` in `prepare.ts`),
  because all of them answer one question: could a schema have declared a
  policy here.

  Two id classes is what this is, rather than a rule about documents the
  runtime mints. The runtime mints many more and route 2 below is what most
  of them take — the document anchoring splits out of a value has an id
  derived from its parent's, which no author named either, and it is
  measured. Adding a class here means arguing that case on its own.

  What an entries document does NOT reach is the client fire. A flag-ON fire
  from a client hands its event to the append queue, which builds its own
  commit outside any storage transaction and carries no `cfc` envelope, so
  that append is outside CFC at every rung and always was. The served arm is
  the one this section is about.

  The two classes differ in what an id says on its own, and an entries
  document is the weaker of them. A computed cell carries a scheme of its
  own, which `entityKindOfIdString` parses and nothing else mints. An entries
  document carries a prefix inside the `of:` scheme, so its id shape does not
  by itself say who wrote it. Two gates compose over one instead: this one
  skips the ceiling, and the memory server owns the shape — an authored write
  reaches a document under that prefix only as a declared tail append, and
  only under `EXPERIMENTAL_SERVER_EXECUTION`
  ([`events.md`](./server-side-execution/events.md) §1, §4). The admission
  path that processed a commit settles its class and a `ClientCommit` cannot
  express one, so pattern-authored traffic arrives `authored` whatever id it
  names.

  A third class is outside the check for the same reason and reaches it by a
  different route, because its ids say nothing at all. It is also the one the
  spec already names: §18.6.2's read exclusions list "program/source text
  loaded to execute the handler" beside the `cid:` schema documents and the
  `/cfc/...` label metadata this runtime already excludes, and calls all three
  public infrastructure. A compilation-cache record holds one module for the
  compiler — the `cid:` document its bytes live in, the identities of its
  imports, and the predecessor identities its writer authority descends from
  ([`module-loading.md`](./module-loading.md), and the write side in
  [`cell-cache.ts`](../../packages/runner/src/compilation-cache/cell-cache.ts)).
  The cache addresses it by the cause `pattern:<identity>`, or
  `compileCache:<runtimeVersion>/<identity>` for the compiled set, whose
  `<identity>` is the module's content-derived Merkle identity. The entity id
  that cause mints is an ordinary `of:fid1:<hash>`, indistinguishable from a
  piece's argument document, so there is nothing for a predicate over id
  strings to recognize, and giving the class an id of its own would re-address
  every cached module in every space that holds one. The write side names the
  document instead: the cache records an authorized whole-document
  `runtime.undeclarable-store` marker beside each of its writes, and the
  measurement asks the transaction. No pattern names one of these documents.
  The schemas that describe their fields are the cache's own write schemas,
  which declare integrity and no confidentiality, so the ceiling that resolves
  there is the empty one, and a measured cache write carrying any clause
  misfits. A piece's source transition stages the
  successor module's delegation union on the same transaction that moves the
  piece's source pointer, so that the authority and the pointer land together,
  and that transaction also reads the piece's argument — which is why the
  measurement reaches a cache document during an ordinary pattern update
  rather than only in an unusual flow.

  Three things bound the marker, and the first is what the other two rest on.
  The recording method is the same public one route 2's marker uses, so the
  runtime's authorization is what separates a claim it made from one pattern-
  authored code wrote; a marker without it counts for nothing. The marker
  names a whole document, because whether a schema could have declared a
  policy is a question about the document rather than about a path inside one;
  `anchorValueAsEntity` carries the claim down to a document anchored out of a
  marked value, which holds part of that value at an id derived from it, the
  same way it carries a runtime-owned store's. A cache record is written raw,
  with its import edges inline, so the cache itself anchors nothing. And it
  lasts for the transaction that recorded it, with no enrollment beside it:
  the measurement runs over documents the asking transaction wrote, so a
  marker recorded beside the write always covers the question. That is the one
  respect in which it is narrower than route 2's marker, which answers for
  stores a later transaction writes.

  One thing this class does NOT take from §18.6.2 is its write-side mirror.
  That section states its read exclusion as mirroring "the write-side rule
  that the same addresses are not value-write targets", which would leave the
  record unstamped as well as unmeasured, the way a `cid:` document is. This
  runtime keeps it a stamp target and skips the ceiling alone, as it does for
  the two id classes above, and safety invariant 9 is what decides that rather
  than a preference. The delegation metadata holds module identities, and
  §17.7 says holding one grants no access to the artifact it names, so the
  content written there is public. Which identity appears is the other
  question: a transaction that read a labeled value and chose a successor by
  it writes that choice into the record, and §8.11.3 puts a decision's label
  on every downstream output whatever the output's own content is — the router
  attack at one bit per update. Unstamping the record would drop exactly that.
  The module's bytes are unaffected either way, living in a `cid:` document of
  their own, so the divergence covers the compiler's bookkeeping and nothing
  else. Its cost is that a later reader of the delegation field consumes the
  clause. For a join the target's own space produced the two shapes differ
  only in what is labeled: neither refuses. They part on a join that drew a
  clause from elsewhere, which the skip is scoped away from, so the
  implemented shape measures the cache write and can refuse it at strict where
  §18.6.2's shape, having no write target there at all, would not. That is the
  direction the residency half of the ceiling was written for, so the
  divergence keeps a refusal rather than giving one up. §18.6.4's checklist
  obligation to document "the excluded address patterns" is discharged by this
  section.

  A cache document is off route 2 on the same keying ground an entries
  document is. Route 2 declares one piece's flow join as the store's policy,
  so it wants a store keyed on that piece's own nodes; a cache document is
  keyed on module content, every piece in the space running that module
  addresses it, and it outlives all of them. What route 2 leaves behind is
  also permanent, and that is the second reason. It writes a `declared` entry
  per measured path, which §8.12.1 does not let back, on a document nothing
  collects; the flow stamp the skip keeps instead is a per-value component
  §8.12.8 replaces on overwrite. The two routes agree on what a later reader
  carries — reading a cache document is how a pattern's code is loaded, and
  under either route the clause reaches whoever loads that module next — so
  that consequence is not what separates them.

  An entries document takes this route rather than §8.12.5's route 2 below,
  and the ownership route 2 asks for is the reason. Route 2 declares a policy
  out of one piece's flow join, so it reaches stores keyed on that piece's
  own nodes, and its enrollment lasts as long as those nodes do. An entries
  document is keyed on the stream, and every party that can reach the stream
  writes to the same document: a piece the stream was handed to, the serving
  space's drain, another space's outbox delivery. It also outlives all of
  them, because it is the durable log a later wave drains. `wish`'s interval
  clock below is off route 2 on that same keying ground, which is a separate
  question from the measurement one this section settles above.

  Where the route would lead is measured rather than argued. Route 2 declares
  at the path the misfit was measured at, and a mark on an entries document
  that already holds entries is measured at `/entries/<n>/consequenced`. So
  the declaration lands at that entry's own path, and a second mark on the
  next entry lands beside it rather than folding into it: two marks carrying
  different atoms leave two `declared` entries, at `/entries/0/consequenced`
  and `/entries/1/consequenced`. A declared entry is permanent, so the stored
  label map would grow by one entry per event the stream ever carried, on a
  durable log that outlives the pieces that wrote to it.

  The skip is scoped to a join the target's own space produced, for the marked
  class as much as for the two id classes. Every clause the join carries comes
  from a document some read resolved, and the join records which space each of
  those lived in; where any of them lived elsewhere, the target is measured
  like any other document. So the residency half of the ceiling still holds
  for the direction it was written for — a derivation cannot carry another
  space's labeled value into a local document by materializing it, an emission
  cannot carry one into a local stream's entries document, and a source
  transition cannot carry one into a local cache document — while work over
  the space's own data proceeds. A computed cell shares a replica set with the
  source it derives from, an entries document shares one with the document
  holding the stream it belongs to, and a cache document shares one with every
  piece in that space running the module it holds, so in each case the value
  reaches no reader it had not reached already, and what follows it is the
  stamp.

  A declared entry can still reach one of these documents, from a
  schema-carrying write to it, and the skip is unconditional over that route
  as it is over the meta seam's document-root route. Honoring it would make a
  derivation admit its own inputs' taint or refuse it according to whether
  the schema behind it happens to carry an `ifc`, while the atoms arriving in
  the join come from what the transaction read rather than from anything that
  schema describes. The residual is that a declaration which did reach such a
  document stops being a write ceiling; it stays a read floor, and the
  persisted stamp is unaffected.

  What the skip does NOT do is release the value. A derivation's result
  leaves the fabric only through a sink, and a sink measures the join it is
  handed. Where the host is the one releasing — the `run_pattern` tool
  answering a model with the values a piece computed — there is no request
  to record and no commit to gate, so that tool measures the release itself,
  against a public ceiling, through `describeSinkReleaseRefusal`
  ([run-pattern.ts](../../packages/cf-harness/src/tools/run-pattern.ts)).
  What it measures is the values a `resultSchema` asks for. The result
  reference it returns names the result without carrying it, so a call that
  asks for no values is not measured, and a refusal withholds the values
  while the reference goes out with them: a handle is not a release. The two
  routes fit their joins with one membership predicate, so a clause outside
  a ceiling on one is outside it on the other. They differ in what reaches
  the join: the host route measures what releasing the values resolved, and
  applies no exchange-rule rewriting to it, so a clause a policy evaluation
  would have discharged is withheld there. The ladder governs it like any
  other gate — at `disabled` and `observe` it records nothing that
  withholds.

  The exemption is not a hole. A path counts as meta only while no payload
  write landed on it too, so a transaction writing both leaves the path
  measured. The collapse of a deeper path against a covering ancestor runs
  over the measured paths only, so an exempt meta path cannot shadow a value
  write beneath it. Meta paths remain flow stamp targets, so the join still
  persists there and the egress, display, and observation gates read the
  unchanged label. And the seam sits in the same document, space, and
  replica set as the value surface beside it, so it reaches no reader that
  surface did not. One residual comes with it: where a payload field carries
  a `MetaField` name, an exempt meta write can raise the stored derived
  label at their shared logical path past what that field declares. The
  direction is over-taint, so reads stay protected; giving the envelope seam
  a path space of its own is what removes the collision.

  What the check measures is bounded on the read side as well, and not only
  at this rung: the write machinery's own reads of the region it is writing
  leave the per-transaction join wherever the flow dial derives one, which is
  what lets a document whose fields carry different confidentiality be
  rewritten whole.
  [`cfc-write-destination-reads.md`](./cfc-write-destination-reads.md)
  carries that class, the §8.11.3 objection to it, and the channel it leaves
  open.

- **Runtime-owned-store declaration (§8.12.5 route 2) — implemented.** The
  runtime materializes a set of documents to hold a piece's machinery rather
  than data an author named. There are four kinds: a piece's argument
  document, its result document, and the internal documents and streams its
  result projects to, all minted by the runner from the piece's result cause;
  the state documents a builtin mints from its own node's cause, such as a
  dialog's result, internal state and pinned-cell list, or a list operation's
  result container; the per-event documents a builtin mints inside one
  transaction, such as a dialog message; and the documents anchoring splits
  out of a value written into any of those. The runtime fills all of them
  with whatever the writing transaction read. An author cannot know which
  atoms a given transaction will carry, so a declaration written into a schema
  either misses them or over-declares every instance of the pattern. The
  transaction declares the policy instead, which is §8.12.5's route 2: the
  write that puts the join on a path also declares, in that same transaction,
  a policy covering it. What lands is the ceiling that resolved at the path
  plus exactly the clauses that had nowhere to go, as an ordinary `declared`
  entry, so the fit test passes and the store's promise becomes the audience
  of what it holds.

  Declaring is what makes the route sound where an exemption would not be.
  The declared clauses persist as store policy, so readers of the store
  consume them, and go on consuming them after an overwrite clears the
  derived stamp. They are the clauses the ceiling did not already cover
  rather than the whole join: a clause the residency alternative satisfies
  lands in the stamp and not in the declaration, because the store already
  answers for it. The cost is the ratchet §8.12.2 asks for: a document that
  once held data derived from a labeled read keeps that clause after the read
  stops. The direction is over-taint.

  The route runs on every write to such a store, not only while the piece is
  being set up. What makes that safe is a property of the declaration rather
  than of when it is made. A declared clause list is read two ways, and the
  two agree: as a ceiling, §8.12.4's `canWrite` admits a label clause when
  SOME declared clause subsumes it, and as a reader's taint, that same
  section makes the declared label a floor every reader carries — §8.12.8
  has reader taint consume the effective label, which always includes the
  declared component. Subsumption means satisfying the declared clause
  implies satisfying the label, so every reader of the store satisfies every
  clause the store admits. One upgrade therefore admits more data AND
  narrows the audience by the same step, and so does the next one: an
  unbounded reactive stream of upgrades leaves a store readable by fewer
  people than it started with, never by more. That is why the route needs no
  bound on how many times it may fire, or on which clauses it may take from
  a later transaction. It is §8.12.5's own argument for option 2 — existing
  readers already expect data at the original label level — applied once per
  write rather than once per piece.

  The declaration is the runtime's to make. §8.12.8's component table names
  "explicit store-label operations (upgrades per §8.12.5)" as a provenance
  of the declared component beside schema `ifc` declarations, and §8.12.5
  states the discipline as atomically tightening the label and then writing,
  which is what declaring in the writing transaction does. The authority
  §8.12.7 and safety invariant 1 require is for WIDENING — adding an
  alternative to a clause already stored, which grows that clause's reader
  set and is admissible only through a grant record or an intent-gated
  declassification event. This route adds clauses and never alternatives, so
  it never asks for that authority; the mint folds clause LISTS, and a
  stored disjunction comes back with the alternatives it went in with.

  The route is the strict rung's, like the reject it replaces, and §18.6.3's
  "strict only rejects more" holds across it: a writer-fit misfit is not a
  rejection at `enforce-explicit` — it persists and flags — so admitting one
  at strict with a declaration admits nothing a lower rung refused. Every
  rung below keeps its `writer-fit(persist-and-flag)` diagnostic, which is
  the rollout signal, and stores no declared policy it could never take back.
  That last is a statement about the RUNG rather than about a deployment: the
  shell posture below strict still escalates per transaction, so an escalated
  transaction writes a permanent declared entry that every rung's readers then
  consume, and §8.12.1 does not let it back.
  At strict, a declaration records a `writer-fit(runtime-owned-store-declared)`
  diagnostic naming the document, the path, and the clauses added: a
  permanent change to a store's policy leaves a trace even at the rung that
  admits it.

  What bounds the route, and what it declares once inside:

  - **Who recorded the marker.** The recording method is on the public
    transaction interface, and pattern-authored code reaches the
    transaction its cells are bound to, so an input's own fields say only
    what its recorder wrote. The runtime passes an authorization alongside,
    the way `setMetaRaw` marks a meta write, and a marker without it counts
    for nothing however it is addressed. This is the difference between a
    gate that ACTS on an input and one that measures it: the two sibling
    markers in the same file corroborate against transaction state, which
    suits a claim about a write that has already happened, while this one
    is a claim about whose write it is, and a forger supplies the write.
  - **Which document it names.** The runner derives every address from the
    piece's result cell — the result cell itself, the argument address that
    cell's cause mints, and each derived internal cell's — and never reads
    one back out of stored metadata, where an `argument` or manifest link can
    name another document (a nested piece's argument lives in its HOST's).
    A builtin names only the stores it mints from its own node's cause. In
    every case the address must name a whole document rather than a path
    inside one, and must lie in the owner's own space: a store elsewhere
    belongs to whoever holds that space's replicas, so a policy declared on
    it out of this piece's join would put those bytes behind a promise made
    here. The result document is the one address a caller may have chosen
    rather than the runtime minted; from the moment setup writes the piece's
    meta into it, it is that piece's store and nothing else's, and the route
    reaches every path written there. Every document the route does not
    reach keeps the ceiling it resolves to, and a misfit there is refused as
    before, with the §8.12.5 remedy in the reason.
  - **How long the claim lasts.** A store the runtime mints and fills in one
    transaction is named for that transaction. A store it KEEPS — written by
    the reactive updates, event handlers and settled requests that come
    after the mint, each on a transaction of its own — is enrolled instead,
    and every later transaction of the same runtime finds it. An enrollment
    lasts as long as the piece's nodes do and goes out with them, which is
    what bounds it: a list operation mints one piece per element, so an
    enrollment that lived for the process would grow with every element a
    churning list ever held. A store minted per event takes the marker alone
    for the same reason. Both carry the runtime's authorization, and both
    are refused for an address naming part of a document or another space.
  - **Which builtins may take it.** A builtin whose result store moves onto
    the route gives up whatever its own ceiling was refusing, so the test is
    what refuses that write instead. A builtin that stages its request as a
    `sink-request` write-policy input has a ceiling to move the refusal to;
    one that stages its effect directly — `navigateTo` calls
    `enqueuePostCommitEffect` itself — has none, so its stores keep their own
    ceilings until the gate that should own them exists. `sqliteQuery` has
    that gate now. Its request stages under a `sqliteQuery` sink, which
    releases ungated under the max-enforcement posture for a reason of its
    own: the bound a read wants is the database's own SPACE, and a per-sink
    ceiling holds a clause list and nothing else. That bound is also what the
    store's own ceiling was refusing, and it was worth exactly one case — a
    database in another space receiving a request that carries a label —
    so the builtin applies it before staging, where which space the database
    is in is a thing it can see, measuring the transaction's flow join rather
    than the transaction-global consumed set the sink ceilings read. The
    control state takes the route, because a request hash is a function of
    parameters no author can foresee, while `/result`'s per-column entries
    stay the author's: the route declines at a declared path, and the
    transaction that settles a request reads its destination's hash as a read
    of the write destination, so the clauses the control state accumulates
    never reach the rows. The second thing that store's ceiling was refusing
    was the membership of a SHARED result selected by a labeled parameter,
    which no transaction's join can supply once the settle carries nothing;
    the builtin declares it on `/result`'s shape itself, beside the rows'
    own labels. Most
    builtins are in neither group: a list coordinator, `ifElse`, `when`,
    `unless`, `cellFromUrl` and `inspectConfLabel` stage nothing at all, so
    there is no egress to govern and no refusal to move,
    and their stores take the route on the node-keyed test alone. That is
    the reading to apply to a new builtin: ask what it stages before asking
    what its stores may declare. `builtin-ownership-route.test.ts` pairs the
    two sets mechanically, so a builtin that stages an effect and takes the
    route fails rather than passing on a reviewer noticing. Served
    `compileAndRun` stages its detached program through a `compileAndRun`
    sink request before releasing the compiler, so its node-owned progress
    and result stores use the route and the request has its own configurable
    sink ceiling.
    Two further stores stay off the route for the reasons above rather than
    for this one. A store the runtime keys on something other than a node —
    `wish`'s interval clock, keyed on the interval, and its shared hashtag
    state, keyed on the space and scope — is shared by every piece that asks
    for it, so no one piece's flow join may declare its policy. And a
    sidecar's result cell is the result cell of the piece the sidecar runs,
    which that piece's own instantiation enrolls and its stop releases;
    enrolling it again under the piece that launched it would hold it past
    the release that owns it.
  - **How ownership reaches an anchored document.** Anchoring splits one
    value across two documents, deriving the child's id from the parent's
    rather than from anything an author named, and nothing but that write
    puts anything in the child. A `set`, a `push` or an `addUnique` through
    a cell splits every plain object it puts at an array position, and being
    inside a handler or a lift is not what decides. The id the split draws on
    comes from the builder frame the cell was made in, and the `Runtime`
    constructor pushes a frame that nothing pops until that runtime is
    disposed, so a cell made while a runtime is alive always carries one. Two
    things the walk leaves alone: an element the write carries through by
    reference from the stored array, which diffs to nothing, and one that is
    already a link. Splitting is the shape §8.5.4.3 prefers rather than one
    the spec tolerates: a coordinator reading a container of references
    consumes membership and reference identities and no element contents, so
    a per-element transaction's pointwise label is a fact about its journal
    rather than a claim needing `flow-taint-precision` trust. Which writes
    split is what an author needs in order to read a refusal: the split
    decides which document a writer-fit reason names, and an anchored child's
    id appears in no source file. §8.2 treats either representation of a
    pass-through as valid so long as the label is preserved, which is the
    nearest thing the spec says to "the choice must not decide a verdict";
    the reading here goes one step past that text.
    A child the runtime split out of a store it owns is therefore that
    store's, and it takes the marker alone: the transaction that anchors it
    writes it, and a later write reaching the same position walks through the
    same place again. A transaction addressing the child directly rather than
    through its parent finds no claim and measures against the child's own
    ceiling, which is the fail-closed direction. The marker also carries the
    claim down a nested anchor, whose own parent is the child marked a step
    earlier.

    That direction has a shape an author meets rather than predicts, so it is
    stated here concretely. On a piece whose result projects a list of
    objects, `items.key(0).set({ note: labeled })` commits: the write goes
    through the parent, re-anchors the element, and the route declares.
    `items.key(0).key("note").set(labeled)` is refused with a writer-fit
    misfit naming the child: the write addresses the child directly, so the
    marker the parent's walk would have recorded is never reached, and the
    child's own declaration is what measures it. The two spellings put the
    same value in the same place and disagree.

    Enrolling anchored children would settle it and is ruled out on
    measurement, not on taste. A whole-list `set` re-anchors every element
    with a fresh id, so six appends mint twenty-one children and five
    rewrites of one position mint thirty more: an enrollment keyed on
    children would grow with total historical writes times list length
    rather than with live data, undoing one level down what the per-piece
    release bounds. The fix that is both coherent and bounded is
    link-carried provenance (§8.12.8) — deriving the child's ownership from
    the parent link a write traverses — which is tracked separately.
    `cfc-runtime-owned-store-wiring.test.ts` pins both spellings, so the
    refused half flips visibly the day that lands. That file also reads the
    split itself, from a write with neither a handler nor a lift around it.

    The claim reaches a child only from a parent that carries one, and the
    case where none does is worth stating because the refusal it produces
    names a document no author wrote down. A child anchored out of an
    ordinary authored store is measured against its own ceiling: the
    residency clause, plus what the schema describing the parent's value at
    the anchored position declares, which the child carries. Only a
    declaration at that position covers it. The anchoring write lands at the
    child's root, so an `ifc` on a field of the element leaves the write
    uncovered, and the misfit reads `at /` rather than naming the field the
    clause was written for. Where the parent declares nothing there, a write
    carrying a label into the child is refused at the child's id, and that id
    is a hash of the parent and the path, so nothing recovers the parent from
    it: what the message establishes is that some document holds a piece of
    another document's value. The same test file pins the four outcomes.
  - **How far it reaches inside that document.** Every path the
    transaction writes there, not only the paths setup wrote: the marker
    names the store, and the declaration is a statement about the store.
  - **No schema declaration at that path.** A schema that declares at the
    written path owns the store's policy there. Widening it from the join
    would make the walk's own re-mint non-monotone on the next write, and
    would brick the path under the declared-monotonicity gate. That store's
    route 2 is the author's, in the schema. The reverse order stays
    reachable, and is §8.12.1 rather than a defect of the route: a pattern
    that later adds an `ifc` at a path the route already declared has to
    name what the store already promises, or the monotonicity gate rejects
    the write for dropping a stored clause. The gate ships `off`, so this is
    latent until it is turned on.
  - **No poisoned measurement.** The ungrantable read-failed marker is
    outside every ceiling, so it is outside what the route may declare: a
    measurement the runtime could not take proves nothing about the
    audience, and declaring it would write a clause no reader can satisfy.
  - **No foreign container clause.** A container clause is honored by a
    replica set rather than by a reader check — §4.9.3 resolves it against
    that space's ACL, the document that also decides who holds the bytes —
    so a store in this space cannot keep a promise made to another space's
    readers. That is why residency admits only the target's own space
    clause, and the route declares no container clause naming another.
    `PersonalSpace(owner)` is the second spelling of one: §4.9.4 calls the
    two forms "the two `Space(...)` atoms", and §3.6.4 makes the named
    principal the sole owner of the space whose id it is. The same-space
    spelling stays admissible, because there the clause names the space the
    bytes are already in, and if that space stops being personal its
    audience and its replica set grow together. A person-audience clause is
    not a container clause: `User(alice)` is honored by the reader check
    whoever holds the bytes.
  - **Growth only.** Within the walk, the ceiling the declaration starts
    from resolves over the entries that walk is about to persist,
    carried-forward stored declared entries among them, so a later
    transaction carrying a wider join adds its clauses to what the path
    already declared rather than replacing them. The entry coalesces with
    the carried-forward stored entry rather than standing in for it. Adding
    clauses is the restricting direction, so the monotonicity gate that runs
    earlier in the same walk cannot be contradicted by what this route
    pushes. Growth is also what reaches a store written before any labeled
    read entered a transaction writing it: that store declares nothing, and
    the write that first carries a join is the one that declares it.

  What the route does NOT reach is a document nobody named. A write to an
  ordinary document measures against its own ceiling whichever transaction
  makes it: a bystander written by a later transaction of the same piece is
  refused exactly as one written by the setup transaction is. A `computed:`
  document, a stream's entries document and a compilation-cache document are
  outside the route for a different reason — the measurement skips them
  altogether, per the exemption above.

  It DOES reach further than the setup-time route in two ways worth stating,
  because neither follows from "the same rule, later". The piece's result
  document is on the route and was not before, and it is the member the
  "no schema declares this" argument does not carry — an author may write
  `ifc` into a pattern's `resultSchema`. Where they did, the route declines
  and the misfit stands; where they did not, it reaches every path written
  there. And what the route tests is the STORE, not the caller: once a store
  is enrolled, any writer reaching it takes the route and contributes the
  clause its own join carries. The direction stays refusal — every clause
  added narrows the store's audience and its readers carry it — so this is a
  permanent over-taint another writer can impose rather than a disclosure it
  can obtain. Constraining it to the runtime's own writes would need
  something the transaction does not carry: pattern-authored code runs in the
  runtime's realm, so "who is writing" is not a question the write side can
  ask.

  Two costs come with it, both outside the store. The declared list is a
  conjunction every reader carries, so a store that accumulates clauses with
  disjoint audiences ends up readable by nobody while still admitting
  writes; that is §8.12.2's ratchet reaching its end, and §8.12.7 records the
  same outcome for its own case as safe and an operational footgun worth
  flagging in review — the direction is refusal rather than disclosure. Two
  shapes reach it soonest, and both are worth knowing before raising the rung.
  A piece's RESULT document is what other pieces read, and it now accumulates
  every clause the piece ever read. And a conditional keeps ONE result store
  per node — `ifElse`, `when`, `unless`, and `inspectConfLabel` over whatever
  it is pointed at — so a branch that fires once leaves its clause on the
  store the other branch writes through afterwards. Both are the ratchet
  behaving as specified rather than a defect in the route, and both are
  arguments for the per-value components carrying the audience rather than
  the declared one. And a transaction that could not commit
  now commits, so whatever else it staged proceeds — a post-commit effect, a
  sink request. That is why the condition above asks what refuses a
  builtin's request once its store no longer does, and it is the whole of
  what the LLM sinks lose: `MAX_ENFORCEMENT_SINK_CEILINGS` declares no
  ceiling for them, so a request the store's misfit used to refuse by
  accident now goes. `max-enforcement-posture.test.ts` and
  `builtin-abandoned-request.test.ts` pin that, and both flip when the
  boundary-scoped admission mechanism that preset describes lands.

  Implementation in
  [prepare.ts](../../packages/runner/src/cfc/prepare.ts)
  (`prepareBoundaryCommit` writer-fit),
  [runner.ts](../../packages/runner/src/runner.ts)
  (`recordRuntimeOwnedStore`),
  [runtime-owned-store.ts](../../packages/runner/src/builtins/runtime-owned-store.ts)
  (`ownedCell`, which a builtin mints its own state store through where the
  mint and the scoping sit together, and the two helpers beside it for the
  sites where they do not), and
  [data-updating.ts](../../packages/runner/src/data-updating.ts)
  (`anchorValueAsEntity`), asserted condition by condition in
  [cfc-writer-fit.test.ts](../../packages/runner/test/cfc-writer-fit.test.ts),
  and against the cross-space representation transform in
  [cfc-label-metadata-protection.test.ts](../../packages/runner/test/cfc-label-metadata-protection.test.ts).

- **Future strict-only fail-closed cases.** Any new check that wants a
  persist-and-flag grace under explicit puts its reject at the strict level,
  same shape.

These are the fail-closed direction, so strict never *accepts* something
explicit rejects — it only *rejects more*. That keeps the strictness ranking
honest (`cfcEnforcementStrictness`: strict = 3 > explicit = 2) and the
anti-downgrade pin (a tx cannot be weakened below its established floor)
meaningful once strict carries distinct behavior.

## 5. Spec-owed

A spec PR to `commonfabric/specs` records the §18.6.3 conformance text: the
four-dial matrix, the "no consuming enforcement ahead of its producing dial"
ordering constraint, and the `enforce-strict` reject set. File it once H4's code
step lands and the strict rejects have concrete reason contracts to cite.
Tracked in [`cfc-spec-changes.md`](./cfc-spec-changes.md) SC-13.

The residency half of the writer-fit ceiling is owed to the spec as well:
§8.12.4 states the fit against the declared policy and says nothing about the
space a document lives in widening it. The same PR should make residency part
of the write ceiling, state that only the container-naming `Space` form
counts, and record that residency admits the write without altering the
persisted label. Tracked in
[`cfc-spec-changes.md`](./cfc-spec-changes.md) SC-18(d).

## Provenance

Grounded in the four implemented dials — `cfcEnforcementMode`
([types.ts](../../packages/runner/src/cfc/types.ts)), `cfcFlowLabels` (H1),
`cfcWriteFloor` (D3, #4479), and `cfcTriggerReadGating` (H5, #4488) — plus the
SC-13 rollout constraint in `cfc-spec-changes.md` and the current host
postures: shell
([lib-shell/src/runtime.ts](../../packages/lib-shell/src/runtime.ts):
`enforce-strict` + flow `persist`); toolshed and background-piece-service
(no CFC options passed, so the `Runtime` defaults, `enforce-strict` + flow
`persist`).
