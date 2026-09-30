# CFC across spaces — copying, referencing, and declassifying labeled values

This guide distinguishes reference bindings from the contents they name when a
pattern moves data between spaces. The precise profile is enabled by
`cfcFlowLabels: "persist"`; its reference contract is defined in
[CFC references](cfc-references.md). The legacy profile retains different
label-copying behavior, described separately below.

## 1. Reference confidentiality and content integrity

A space is a DID. Writing `B.selected → A.item` writes the reference slot in B;
it does not write A. In the precise profile, B persists the confidentiality of
acquiring, selecting, and exposing that binding, together with the writing
attempt's flow confidentiality. Authored receiving policies also apply at B's
slot and projected paths. The reference entry has `origin: "link"` and
`observes: "followRef"`.

A's content labels remain on A. A public, independently acquired reference can
name confidential content without copying its confidentiality into B. Selecting
among public items using a secret produces a confidential reference. Following
the reference consumes its acquisition restrictions and the current target
labels for the observation being made.

The runtime adds `LinkReference` integrity describing the relationship between
the source and destination addresses, including their spaces. That endorsement
does not endorse A's contents. A content floor must verify the current content
subject; neither the relationship endorsement nor a receiving `addIntegrity`
declaration proves that subject meets the floor.

Reading contents into plain bytes consumes their confidentiality. Writing those
bytes with persistent flow labels retains the attempt's confidentiality, but
materialization alone is not an exact-copy proof. An explicit copy or projection
claim supplies a separate checked assertion about the value being written.

With flow labels `"off"` or `"observe"`, legacy reference persistence derives
labels from the target's stored or pending labels and the carried schema. It
copies target confidentiality and eligible integrity, adds `LinkReference`, and
can copy target descendant entries beneath the receiving path. The
[legacy cross-space tests](../../packages/runner/test/cfc-cross-space-integrity.test.ts)
exercise that behavior with flow labels off. It does not establish complete
selection history for a precise reader; upgrading one slot or merely retaining
its recorded labels does not authenticate other legacy references.

## 2. Verified copies and their subjects

`ifc: { exactCopyOf: ["<sibling-path>"] }` declares a comparison between two
paths rooted in the receiving document. A supported claim carries the verified
source subject's confidentiality and integrity. In the precise profile, the
comparison depends on what those paths identify:

- **Inline contents:** compare their Fabric values. A linked descendant is
  resolved to its current scoped contents before comparison.
- **Reference bindings:** compare complete normalized bindings. Copying a
  reference to another space preserves reference restrictions and identity; it
  does not copy or endorse the remote contents.

A content assertion can reveal information through success or refusal. Its
reference, shape, value, and protected metadata evidence must fit
confidentiality the attempt already carries. Otherwise the assertion returns
unavailable evidence. Known absence is insufficient for a positive copy claim,
and mismatched or unresolved subjects fail closed.

The Runtime binds mutable content evidence to the receiving commit's revision
checks. Assertions that require mutable contents in another space are rejected
because those reads cannot be bound atomically to that commit. Forwarding or
identity-copying a reference across spaces does not require such a content
assertion. `exactCopyOf` under an array wildcard (`"*"`) is unsupported and
fails closed.

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
context. A new authored classification does not discard confidentiality already
consumed by the writing attempt; persistent flow labels and writer-fit still
apply.

## 4. Subsets and read projections

A link to `src.key("foo").key("bar")` selects that path while retaining the
reference's acquisition history and scope restrictions. A link to the whole
object permits observations through its read projection; it does not copy the
whole target label map into the receiver in the precise profile. A narrower
schema is a read view, not proof that the target satisfies a content assertion.
Each actual dereference consumes the current labels for the fields and shapes
it observes. In the legacy profile, whole-object links can copy descendant
labels even when the receiving schema does not name those fields.

A verified `ifc.projection = { from, path }` claim compares the destination with
the source subject at `from + path`. It carries source confidentiality and
scopes source integrity to the projected pointer through `scope.projection`, so
a field cannot claim whole-object integrity. The content/reference distinction,
confidentiality guard, and cross-space evidence limit in §2 apply. Malformed and
array-wildcard projection claims fail closed. The authoring helpers are
`Projection`, `ProjectionOf`, and `ProjectionPath`; the checks are pinned by
[cfc-projection.test.ts](../../packages/runner/test/cfc-projection.test.ts) and
[cfc-linked-content-floor.test.ts](../../packages/runner/test/cfc-linked-content-floor.test.ts).

Declassifying a subset composes two restrictions:

- **Per-path labels:** the observations made on each field determine which
  labels reach the boundary evaluator.
- **Clause locality:** within one label, a `selection: "referenced"` policy
  applies only to the clause carrying its hash-bound `policyRef` atom. Releasing
  one clause cannot widen an independent sibling requirement.

## 5. Unsupported assertions

`passThrough` remains unsupported as an explicit schema assertion and fails
closed. Ordinary reference forwarding uses the reference profile without that
annotation. `collection`, `opaque`, `recomposeProjections`, `combinedFrom`,
`transformation`, and `addedIntegrity` also fail closed as unsupported
trust-sensitive claims.

The authoring surface exposes supported operations through `ExactCopy`,
`Projection`, `Integrity`/`AddIntegrity`, `Confidential`, `RequiresIntegrity`,
`WriteAuthorizedBy`, and plain `Cell<T>` links. None makes an unsupported
cross-space content assertion atomic or authorizes declassification by itself.

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

## 7. Enforcement dials

The reference/content separation described here requires
`cfcFlowLabels: "persist"`. The default enforcement mode is
`cfcEnforcementMode: "enforce-explicit"`; diagnostic and disabled modes do not
establish rejection guarantees. Content write floors additionally require
`cfcWriteFloor: "enforce"`. Explicit copy and projection checks are independent
of that floor dial.

Declassification requires configured `cfcPolicyRecords` and
`cfcPolicyEvaluation: "enforce"`; `"observe"` diagnoses exchange rules without
releasing confidentiality. Writer-fit and trigger gating remain separate
choices. See the [enforcement matrix](cfc-enforcement-matrix.md) for deployment
postures and [CFC references](cfc-references.md) for reader/writer compatibility.

## Implementation and tests

Reference persistence and content verification live in
[prepare.ts](../../packages/runner/src/cfc/prepare.ts); scoped content resolution
is supplied by [Runtime](../../packages/runner/src/runtime.ts). The precise
contract is covered by
[cfc-reference-confidentiality.test.ts](../../packages/runner/test/cfc-reference-confidentiality.test.ts)
and
[cfc-linked-content-floor.test.ts](../../packages/runner/test/cfc-linked-content-floor.test.ts).
[cfc-cross-space-integrity.test.ts](../../packages/runner/test/cfc-cross-space-integrity.test.ts)
covers legacy target-label copying and exchange-rule scenarios.

Exchange rules are configured in `cfc/policy.ts`, evaluated in
`cfc/exchange-eval.ts`, and exercised by `cfc-exchange-eval.test.ts` and
`cfc-grant-records.test.ts`. The specification subjects are CFC §8.2
(references), §8.3 (projection), §8.4 (exact copy), and §8.12
(store-label updates and declassification).
