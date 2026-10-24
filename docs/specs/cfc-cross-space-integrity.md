# CFC across spaces — copying, referencing, and declassifying labeled values

_How to express, in a pattern or a test, the family of "move a labeled value
from one space to another" operations: keep its integrity, declassify its
confidentiality, or take only a subset — and where the authoring surface still
has gaps. Grounded in the runner implementation (`packages/runner/src/cfc/`) and
pinned end-to-end by
[`packages/runner/test/cfc-cross-space-integrity.test.ts`](../../packages/runner/test/cfc-cross-space-integrity.test.ts).
Spec ground: `commonfabric/specs` `cfc/03-core-concepts.md` §3.7 (cross-space
links), `cfc/08-02` (pass-through via references), `cfc/08-03` (projection),
`cfc/08-04` (exact-copy verification), `cfc/08-12` (store-label monotonicity /
declassification routes). Written 2026-07-10._

## 1. The scenarios and what carries the label

A "space" is a DID. Moving a labeled value between spaces has three questions:
does its **integrity** survive, is its **confidentiality** changed
(declassified), and is it the **whole** value or a **subset**. The load-bearing
fact is:

> **A reference (link) reaches a labeled value across a space boundary.
> Materialized bytes do not.**

When a cell in space B holds a link to a value in space A, the value's labels
stay in space A, on the value, and a read that follows the link consumes them
there together with the link's own restriction (spec §8.2.4: dereference
confidentiality is the reference restriction conjoined with the target's
current labels; integrity is the target's plus the link's own endorsements,
§3.7.2). What the runtime persists at the link path in space B is the
reference's own label (`linkSlotLabel`, `prepare.ts`): the link schema's
declarations and the restriction the written handle carried, in one entry
stamped `origin: "link"`. Where flow labels persist, the creating attempt's
flow join is stamped at the same path as an entry of its own, with
`origin: "structure"` and `observes: "followRef"`. No evidence atom is minted
for the reference (§15.4, the retired `LinkReference`). Nothing of the
source's labels is copied into either (§8.2.5, §8.12.8): a public,
independently acquired reference to confidential content is public to hold
and compare, and confidential to read through.

By contrast, once a handler reads a value into plain bytes and writes those
bytes into another space, the runtime has no basis to attest they are the same
labeled thing — the copy is a fresh, unendorsed value. That is not a bug; it is
why you carry the *reference*, not the extracted value.

## 2. Verbatim copy that keeps integrity

Two forms, both real:

- **Same document** — `ifc: { exactCopyOf: ["<sibling-path>"] }`. The runtime
  content-address-verifies that the field equals the named sibling path and
  copies that path's label onto it, both axes, unfiltered (spec §8.4.2). A
  mismatch rejects the commit with `exactCopyOf failed`.
- **Across spaces** — `exactCopyOf` compares two paths *within one value tree*,
  but a path may **hold a cross-space link**. So a field whose `exactCopyOf`
  source is a link into another space is (a) verified as an exact copy of the
  reference and (b) carries that path's own label, the reference's restriction
  and endorsement. The linked value's integrity is read where the value is,
  through either reference. This is "verbatim copy retains integrity across
  spaces": the link is the carrier, `exactCopyOf` is the verified claim on top
  of it.

`exactCopyOf` under an array wildcard (`"*"`) is unsupported and fails closed.

## 3. Declassify while copying

Declassification is a **boundary-time** rewrite, not a stored mutation. It is
expressed with **exchange rules** (`ExchangeRule`, `cfc/policy.ts`) evaluated at
the sink/egress boundary under `cfcPolicyEvaluation: "enforce"`. A rule's `post`
either `addAlternatives` (widen a confidentiality clause — e.g. add
`User($recipient)` so a specific reader may observe) or `dropClause` (release the
clause entirely), gated by a `preCondition` over `confidentiality` / `integrity`
/ `boundary` / `policyState` evidence. The rewrite is never persisted (spec
§8.12.7 route 1).

Two properties matter for "copy retains integrity while declassifying":

1. **Exchange rules only touch confidentiality.** They never add, drop, or alter
   integrity. So a declassified copy keeps every integrity claim it had — you
   can widen who may read a value without weakening its provenance.
2. **Fail-closed.** Without the required evidence, no rule fires and the clause
   stands (nothing is released).

Durable-but-revocable release uses **grants** (`tx.writeCfcGrant(...)`, a trusted
builtin write; `cfc/grants.ts`) consumed by a `policyState`-guarded rule (spec
§8.12.7 route 2a). **Single-use** grants additionally require
`experimental.commitPreconditions` and only satisfy a guard in a *consuming*
context. Route 3 — a new value carrying a wider authored label — is just
ordinary authoring, no special machinery.

## 4. Subsets — the subtle part

Two different meanings, two different behaviors:

- **Reference a subset of fields** — link the **specific sub-paths**, not the
  parent object. A link to `src.key("foo").key("bar")` reaches only that leaf,
  and a read through it consumes that leaf's labels and nothing of its
  siblings'. **Gotcha:** linking the **whole** object does *not* project it to a
  narrower destination schema — every field of the source is reachable through
  the reference, undeclared sibling fields included, each under its own label. A
  narrower schema is a read-time *view*, not a projection; it does not sanitize
  the reference. (The undeclared fields stay confined by their own
  confidentiality labels, so it is safe, not a leak — but "only the right
  fields are reachable" is false.) To copy a genuine subset by reference, link
  exactly the leaves you want.
- **Declassify only a subset** — two orthogonal scopings compose:
  - **Per-path labels.** A value's label is stored per path, so only the
    field(s) you read/release reach the boundary evaluator.
  - **Clause-locality (home clause).** Within one label, a `selection:
    "referenced"` policy fires only on the clause carrying its hash-bound
    `policyRef` atom, never a sibling clause (spec CT-1874 / invariant 11). So a
    declassification scoped to one clause cannot widen an independent sibling
    requirement.

## 5. Gaps in the authoring surface

- **`projection` (§8.3) is implemented** _(landed 2026-07-10, after this
  document was first written)_ — a write through a schema declaring
  `ifc.projection = { from, path }` is verified at commit (the target value
  must equal the source field at `from + path`, same document) and carries the
  source's label: confidentiality in full (§8.3.1), integrity **scoped** to the
  projected pointer via `scope.projection` (§8.3.2), so a projected field can
  never claim whole-object integrity. Malformed and array-wildcard claims fail
  closed. The `Projection` / `ProjectionOf` / `ProjectionPath` helpers in
  `packages/api/cfc.ts` are safe to reach for; full behavior is pinned by
  `packages/runner/test/cfc-projection.test.ts` (and scenario 3a′ in this
  document's test file). Checked recomposition (`recomposeProjections`) remains
  unimplemented and fails closed.
- **`passThrough` (§8.2) remains unimplemented and fails closed** — a write
  through a schema declaring it is rejected with
  `unsupported trust-sensitive claim <key>` (`prepare.ts`
  `unsupportedTrustSensitiveReason`; also `collection`, `opaque`,
  `recomposeProjections`, `combinedFrom`, `transformation`, `addedIntegrity`).
  Reference behaviors stay reachable via per-path labels and links (§2, §4).
- **Authoring surface / runtime mismatch — reconciled** _(2026-07-10)_. The
  helper types that lowered to still-unimplemented keys were **removed** —
  `SubsetOf` / `FilteredFrom` / `LengthPreservedFrom` / `PermutationOf`
  (→ `collection`) and `OpaqueInput` (→ `opaque`) — so the authoring surface
  now only advertises what the runtime enforces. Reintroduce them together
  with the runner enforcement for §8.5 / §8.13. For collection-shaped needs
  meanwhile, prefer `ExactCopy`, `Integrity`/`AddIntegrity`, `Confidential`,
  `RequiresIntegrity`, `WriteAuthorizedBy`, and plain `Cell<T>` links.
- **No cross-space verbatim byte-copy carry.** By design (§1): carry the
  reference. Flagged here so future work does not mistake it for a missing
  feature to bolt on to `exactCopyOf`.

## 6. Can a pattern author exchange rules? No — and why

A pattern can declare **classification labels** (`ifc` confidentiality /
integrity atoms, via the `Cfc<>` helper types) and can **reference** a policy by
putting a `Policy(...)` / `Context(...)` / `policyRef` atom in a label (which
selects which registered record applies — the `selection: "referenced"` path).

But the **exchange rules themselves are deployment/runtime configuration**
(`RuntimeOptions.cfcPolicyRecords`, consumed at `Runtime` construction), not
pattern-authored. No shipped pattern defines a rule; `cfc/trusted-surfaces/
share-policy.tsx` is a UI surface that captures share *intent*, not a rule. This
split is deliberate: patterns are untrusted, and letting a pattern author its
own declassification would let it release its own data. Classification is
pattern-level; the authority to exchange/declassify is runtime-level.

## 7. Enforcement dials this depends on

From [`cfc-enforcement-matrix.md`](./cfc-enforcement-matrix.md): the label
mechanics (§1–§2, §4) run under the default `cfcEnforcementMode:
"enforce-explicit"`. Declassification (§3) additionally needs `cfcPolicyRecords`
configured plus `cfcPolicyEvaluation: "enforce"` (or `"observe"` to diagnose
without releasing). No shipped host configures a policy set today, so exchange
declassification is exercised only in tests and would be turned on per
deployment.

## Provenance

Runner seams: `linkSlotLabel` / `linkedSourceEvidence` /
`derivePersistedLabel` / `verifyExactCopyRequirements` /
`unsupportedTrustSensitiveReason` / `gateRuntimeMintedIntegrity`
(`cfc/prepare.ts`); `ExchangeRule` / `buildCfcPolicySnapshot` (`cfc/policy.ts`);
`evaluateExchangeRules` + home-clause locality (`cfc/exchange-eval.ts`);
`writeCfcGrant` (`storage/extended-storage-transaction.ts`, `cfc/grants.ts`);
authoring aliases (`packages/api/cfc.ts`, canonical set
`CFC_CANONICAL_ALIAS_NAMES`, lowered by `ts-transformers/src/cfc-authoring.ts`).
Tests:
[`cfc-cross-space-integrity.test.ts`](../../packages/runner/test/cfc-cross-space-integrity.test.ts)
(the four scenarios end-to-end), `cfc-exact-copy.test.ts`,
`cfc-exchange-eval.test.ts`, `cfc-grant-records.test.ts`, `cfc-write-floor.test.ts`
(link-carried label idiom). Spec: `cfc/03-core-concepts.md` §3.7,
`cfc/08-02`…`08-04`, `cfc/08-12`, `cfc/13-worked-examples.md` §13.4.
