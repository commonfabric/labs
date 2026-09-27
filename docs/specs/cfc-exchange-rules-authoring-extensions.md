# CFC Exchange Rules — Authoring Extensions

Syntax sketches for the policy surfaces the core design
([`cfc-exchange-rules-authoring.md`](./cfc-exchange-rules-authoring.md))
deliberately left out. Each section: what the spec already defines, the
authoring sketch, the lowering, and what (if anything) the spec still owes.
Everything here follows the core design's discipline — module-level exports
with `{ identity, symbol }` identity, static lowering, no pattern-side
evaluation, adoption-by-workflow where authority is someone else's to give.

## Status

Exploratory design sketches, one notch below the core doc. Critical review
found that several require new runtime semantics rather than authoring sugar;
none is scheduled by the core implementation program. See the
[`cfc-exchange-rule-authoring` implementation plan](../plans/cfc-exchange-rule-authoring.md)
for the prerequisite and safety disposition of each surface. New spec-change
items: SC-36, SC-37 in [`cfc-spec-changes.md`](./cfc-spec-changes.md).

## Last Updated

2026-07-11

---

## 1. Sink-scoped rules and authority-only inputs

**Spec:** §5.2.1 (sink gate), §5.3.1 (authority-only vs data-bearing),
`PolicyRecord.dependencies` (§4.3.1). Already in the rule language as
`allowedSink` / `allowedPaths`; what's missing is the authoring ergonomics and
the dependency classification.

```ts
// Shown for illustration only.
// Strip the gateway token only where it lawfully appears; the sink gate
// fires this during boundary execution and emits AuthorizedRequest (§5.2.1).
export const stripGatewayToken = exchangeRule({
  appliesTo: THIS_POLICY,
  post: { dropClause: true }, // spec's empty-postcondition removal form
  sink: "fetchData",
  paths: [["options", "headers", "Authorization"]],
});

export const gatewayRules = exchangeRules([stripGatewayToken]);

interface GatewayInput {
  // AuthorityOnly<T> lowers to dependencies.authorityOnly for this path.
  accessToken: AuthorityOnly<Confidential<string, [PolicyOf<typeof gatewayRules>]>>;
}
```

- `sink:` / `paths:` are sugar: they lower to `pre.boundary` patterns over
  the `BoundaryContext` atoms the evaluator mints per boundary evaluation —
  the shipped generalization of the spec's `allowedSink` / `allowedPaths`
  metadata (`packages/runner/src/cfc/policy.ts`).
- `AuthorityOnly<T>` is classification, not magic: the response drops the
  token's taint only because the sink-scoped rule fires at the permitted
  path — "not a global exemption such as 'tokens never taint'" (§5.3.1). A
  token that leaks into the request body has no matching rule and taints.
- Boundary scoping does not satisfy the core authoring surface's integrity or
  policy-state guard requirement by itself. This boundary-only syntax remains
  unavailable until the runtime can enforce its path-local authority contract;
  if shipped, it uses a dedicated extension surface rather than weakening the
  general rule lint.

Spec/runtime owe: per-path boundary evaluation, authority-only flow semantics,
and an acceptance case proving a token leaked outside the authorized path keeps
its clause.

## 2. Error exchange rules

**Spec:** §5.4 (`ErrorExchangeRule`, sanitizers, category table); errors
inherit full input confidentiality unless a rule fires, and §5.4.7 says every
request-authorizing policy *should* carry error rules.

```ts
// Shown for illustration only.
// A sanitizer is itself an { identity, symbol } artifact (§5.4.4 shape).
export const gatewayErrorSanitizer = errorSanitizer({
  redact: [
    { pattern: /Bearer [A-Za-z0-9._-]+/, replacement: "Bearer [REDACTED]" },
  ],
  maxLength: 200,
});

export const gatewayErrorRules = errorExchangeRules({
  match: { policy: THIS_POLICY, errorCode: [400, 401, 404, 429] },
  release: [
    { path: "/error/code", to: actingUser() },
    { path: "/error/message", to: actingUser(), sanitizedBy: gatewayErrorSanitizer },
  ],
  retain: ["/error/details", "/headers"],
  requires: [authorizedRequest(), networkProvenance({ tls: true })],
});
```

Lowering: §5.4.2 `ErrorExchangeRule` entries in the same derived policy record
as the pattern's general rules (one `exchangeRules` array per §5.3.2);
`$actingUser` is the acting principal the evaluator binds before matching
(§4.9.2, §5.4.2; SC-49). The §5.4.3 observation-model caveat holds:
descendant-path releases do not make `/error` materializable as a whole.
Successful sanitization mints `SanitizedError` integrity naming the
sanitizer's identity pair (§5.4.6).

Spec owes: nothing new; §5.4's `sanitizer: string` id field should be noted as
subsumable by the identity pair (folds into SC-29's addressing story).

## 3. Caveat-discharge rules

**Spec:** invariant 10 (caveats cleared only by explicit, evidence-bound,
clause-local rules), §14.1 (prompt-injection caveats; meaning lives in caveat
`kind` URIs + policy rules), §4.8.9 (concept guards via trust closure).

```ts
// Shown for illustration only.
export const dischargeUnscreenedRisk = caveatDischargeRule({
  kind: CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
  evidence: [
    screenedBy(concept("https://commonfabric.org/cfc/concepts/prompt-injection-screening")),
  ],
});
```

Lowering: an ordinary rule whose target pattern matches the caveat atom
(`Caveat{ kind, source }`) and whose integrity pattern is concept-valued —
satisfied only when the screening implementation's concrete identity reaches
the concept under the **acting user's** trust closure (§4.8.9). The pattern
declares the discharge *shape*; authority comes from trust statements it
cannot mint. A deployed screening lift with no verifier statement discharges
nothing — fail closed, per invariant 10.

Spec owes: nothing; this is the §14.1 architecture with a helper name.

## 4. Multi-party consent release

**Spec:** §5.3.3–§5.3.4 — the default output of a joint computation keeps
every participant clause; a profile MAY add shared-result principals "only via
ordinary exchange rules guarded by compatible consent evidence from every
required participant."

```ts
// Shown for illustration only.
export const participantConsent = exchangeRule({
  appliesTo: cfcAtom.user(v("P")),                      // each participant clause
  pre: {
    integrity: [consentEvidence({
      participant: v("P"),
      scope: "calendar-intersection",
      audience: v("A"),
      purpose: "find-mutual-availability",
    })],
  },
  post: { addAlternatives: [cfcAtom.user(v("A"))] },
});
```

No quantifier is needed: rules fire per clause, so each participant's clause
rewrites only on that participant's own consent evidence, and the conjunction
dissolves exactly when *all* participants' evidence is present — which is
§5.3.3's requirement stated operationally. Consent evidence itself is minted
by trusted consent surfaces (the §13.4.3 state-scoped-intent shape per
participant), never by the computing pattern.

Spec owes: §5.3.4 deliberately doesn't privilege a consent payload, but
interop wants a *reserved shape* with the binding fields it already demands
(scope, audience, purpose) — SC-37.

## 5. `PolicyCertified`: requiring it, and running under a policy

**Spec:** §5.5 — the runtime auto-attests `PolicyCertified(P)` for execution
under policy P (patterns don't request certification); downstream patterns may
require it; propagation is hereditary weakest-link (§5.5.3, §15.1.1).

```ts
// Shown for illustration only.
// Require: inputs must have been processed under the named policy.
type CertifiedAnalysis = RequiresIntegrity<Analysis, [
  PolicyCertifiedBy<typeof approvedModels>,
]>;

// Run-under: ask the runtime to enforce a policy envelope for this pattern's
// execution, so outputs gain the certification.
export const analysisEnvelope = executionPolicy(approvedModels);
```

`approvedModels` is a policy artifact export (an `{ identity, symbol }`
reference to enforceable constraints — §5.5.7's mechanically-verifiable
subset). The require side is just `RequiresIntegrity` plus an atom
constructor (`CFC_ATOM_TYPE.PolicyCertified` already ships). The run-under
side is new surface: a pattern *requesting* an envelope can only constrain
its own execution, never widen anything, and the attestation stays
runtime-minted — SC-36.

## 6. Implements-concept claims

**Spec:** §4.8.2 trust statements bind concrete identity → concept, signed by
a verifier; users delegate to verifiers (§4.8.3). None of that is pattern
code. The pattern-side piece is the discoverable **claim**:

```ts
// Shown for illustration only.
export const screenInjection = lift(/* ... */);

export const screeningClaim = claimsConcept(
  screenInjection,
  "https://commonfabric.org/cfc/concepts/prompt-injection-screening",
);
```

A claim is authorable data with zero authority: it says "review me as an
implementation of C." It becomes effective only when a verifier issues the
§4.8.2 statement binding the lift's content-addressed identity to the concept
— the same publish-then-adopt workflow as rule adoption (core doc). Value of
the in-code form: verifiers can enumerate what wants review, and static
checking can warn when a declared caveat-discharge rule (§3 above) depends on
a concept no shipped artifact even claims.

Spec owes: nothing normative (claims are ordinary data); a registry note
distinguishing claims from statements would help ecosystem tooling.

## 7. Expiry sugar

**Spec:** §4.2.1/§4.2.3 — `TTL` atoms in schemas convert to absolute
`Expires` at label creation; both are ordinary conjuncts.

```ts
// Shown for illustration only.
type Ephemeral = Confidential<Note, [
  ConceptOf<typeof health>,
  ttl(86_400), // conjunct clause; lowers to TTL → Expires at label creation
]>;
```

Pure sugar; the only rule is inherited from §3.1.8: `Expires`/`TTL` may not
appear inside `AnyOf` alternatives (it would invert into
least-restrictive-wins).

## 8. Row-set read modes (existence channel)

**Spec:** §8.17 (row-set reads), invariant 14 (result shape carries the join
of all contributors, including withheld ones), the disjunctive proposal §6
(declared output ceiling = result store label; `fail` default; `skip` as a
declared existence release; aggregates never skip).

```ts
// Shown for illustration only.
const inbox = collectionRead(messages, {
  ceiling: [cfcAtom.user(currentUser())], // result store label, bound at prepare
  onExceed: "skip",                       // declared existence release; default "fail"
});
```

Lowering: the ceiling is the result cell's store label; the per-row check is
ordinary `canWrite(rowLabel, ceiling)`; `skip` is legitimate only when (a)
declared here, (b) the container's governing policy permits the existence
release, (c) skips are audited — all three from §8.17. Interacts with concept
labels immediately: a feed skipping unreadable `health`-labeled rows is
releasing one presence bit per row, and the concept kernel is where that
permission would live.

Spec owes: nothing — §8.17 is the normative home; this is its authoring shape.

---

## Non-proposals

- **`preConfScope: "anywhere"`** — already a field on `exchangeRule()`;
  needs documentation and a lint nudge (cross-clause side conditions are
  opt-in per §5.3.2), not new syntax.
- **Verifier delegation and trust-statement issuance** — user/space-level
  acts performed through trusted surfaces; deliberately not authorable from
  pattern code (§4.8.3). Only the claim half (§6 above) lives in code.
- **Recombination budgets** — §14.3.2 is an open problem no authoring syntax
  can close; the honest surface-level obligation (enumerate a concept's
  active grants) is SC-35.
