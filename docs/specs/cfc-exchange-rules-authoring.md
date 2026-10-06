# CFC Exchange Rules — Pattern Authoring Surface

How pattern code declares exchange rules (declassification policies) and
raises confidentiality by referencing them directly. Concept-governed defaults
remain a separately gated design described later in this document.

## Status

The direct, digest-bound `PolicyOf<typeof rules>` slice is implemented. Static
rule declarations, compiler-emitted manifests, destination-local durable
manifest copies, label-time subject binding, and exact referenced-policy
evaluation are current behavior. `ConceptOf`, concept grants/defaults, and the
companion extensions are still proposals and must not be used as implemented
API. The remaining dependency gates are tracked in the
[`cfc-exchange-rule-authoring` implementation plan](../plans/cfc-exchange-rule-authoring.md).
Companion spec-change items are SC-29..SC-37 in
[`cfc-spec-changes.md`](./cfc-spec-changes.md); companion syntax sketches for
the remaining surfaces are in
[`cfc-exchange-rules-authoring-extensions.md`](./cfc-exchange-rules-authoring-extensions.md).

The evaluator and direct authoring path live in
`packages/runner/src/cfc/exchange-eval.ts`, `packages/api/cfc.ts`, and the CFC
transformer passes. The evaluator provides fueled-fixpoint guarded rewrites
with clause locality, label-carried `referenced`
policy records with home-clause locality (CT-1874, #4652), and §4.3.5 grant
records — `policyState` guards, reserved-path storage, single-use
commit-precondition receipts (`grants.ts`, #4627 / #4649). Ambient deployment
records still use `RuntimeOptions.cfcPolicyRecords`; module-authored policies
use their separate exact-manifest resolver and never enter that snapshot.

## Last Updated

2026-07-11

## Motivation

Exchange rules are the spec's only declassification mechanism: integrity-
guarded rewrites on hash-bound policy records that may rewrite only the
clause(s) their policy principal appears in (spec §4.3.2, §4.4.5 home-clause
locality). Before this design landed, the authoring surface stopped at
`Confidential<T, X>` atom lists and declassification existed only as
`declassifyConfidentiality={[...]}` attribute lists on trusted components.
The shipped `PolicyOf` and `exchangeRules` surface now supplies policy records
whose release paths travel with the *data*. It addresses three needs:

1. **Direct use.** A pattern raises confidentiality on data it produces and, in
   the same declaration, names the exchange rules that are that clause's
   release paths.
2. **Indirect use.** A pattern raises confidentiality *to a concept* — an
   identifier like "health" coordinated across parties — and inherits whatever
   default rules the data's owner keeps for that concept, as they change.
3. **Both at once.** Concept defaults and pattern-specific rules governing the
   same value, composing predictably.

Proposing a rule to someone else's concept is deliberately **not** an API
(§ Proposing rules is a workflow, below).

## Identity: literal or reference, never bare names

For any policy-bearing thingie — a rule set, a concept, a context — pattern
code can either define it **literally** (inline, anonymous) or reference it by
an **id for coordination**. Ids come in exactly the two forms the runtime
already has; there are no global bare names (no ambient `"health"` string that
means the same thing everywhere):

- **Well-known URI** — ecosystem-level coordination, the spec §4.8.1 /
  §5.7.1 form and the existing `CFC_CONCEPT_KIND` convention
  (`https://commonfabric.org/cfc/concepts/prompt-influence`). Right for
  concepts whose meaning many independent parties must agree on.
- **Module-relative: `{ identity, symbol }`** — the exported symbol of an
  authored module, where `identity` is the content-addressed module
  identity. This is the same pair the runtime already uses for patterns,
  lifts, and handlers (`content-addressed-action-identity.md`; owner decision
  SC-22: implementation identity = content hash of the code artifact +
  symbol). A module-local concept or rule set gets a global address during
  compilation/publishing, and other patterns reference it by
  importing from the deployed piece or published pattern
  (`pattern-imports/README.md` — `import { health } from "cf:/wellness/commons"`
  pins to the exporting module's identity at compile time).

A "context" in the spec's sense is one kind of concept — the primary one for
this design — but the identity story is uniform: the same concept id can
appear in a confidentiality position (as a context/policy principal selecting
an owner's rules), in an integrity guard (satisfied via trust closure, spec
§4.8.9), or in a caveat kind. The position determines the machinery; the id is
just coordination.

## Authoring surface

Two verbs, both declarative, both statically lowerable (same `typeof`-of-a-
module-level-const discipline as `TrustedActionWrite`). Pattern code never
evaluates rules; trusted boundaries do.

### 1. Declaring rules

```ts
import {
  cfcPattern,
  exchangeRule,
  exchangeRules,
  THIS_POLICY,
  v,
} from "commonfabric/cfc";
import type { PolicyOf } from "commonfabric/cfc";
import type { Confidential } from "commonfabric";

// Release this policy's home clause to a principal with reader evidence for
// the concrete space bound as THIS_POLICY.subject.
export const releaseFlagToReader = exchangeRule({
  appliesTo: THIS_POLICY, // target: the clause this rule set governs
  pre: {
    integrity: [
      cfcPattern.hasRole(v("reader"), THIS_POLICY.subject, "reader"),
    ],
  },
  post: { addAlternatives: [cfcPattern.user(v("reader"))] },
});

export const driftFlagRules = exchangeRules([
  releaseFlagToReader,
]);

interface Flag {
  value: boolean;
}

type DriftFlag = Confidential<Flag, [PolicyOf<typeof driftFlagRules>]>;
```

- **Identity has three roles.** `{ identity, symbol }` content-addresses the
  defining module export. A canonical `policyDigest` content-addresses its
  smaller, subject-independent lowered manifest so another space can copy and
  evaluate the policy without copying the module's whole source closure. The
  concrete `subject` is bound by each invoking piece at label creation.
  Changing a rule creates a new pair and digest for future labels; old labels
  keep their old reference until explicit migration. Upgrading the module alone
  never extends the release paths of data that is already labeled.
- `THIS_POLICY` is the placeholder for the policy principal being defined, which
  cannot be named before the module is hashed. It resolves relative to the
  containing exported `exchangeRules` artifact—not to the module as a
  singleton—and always occupies the `appliesTo` (target-pattern) position.
- Two fields of `THIS_POLICY` may appear inside other patterns, and each binds
  from the selected policy reference at evaluation time: `THIS_POLICY.subject`
  is the concrete subject bound at label creation, and
  `THIS_POLICY.moduleIdentity` is the content identity of the module defining
  the rules. The second is how a rule names a function of its own module in a
  `TransformedBy` identity pattern
  (`{ kind: "verified", moduleIdentity: THIS_POLICY.moduleIdentity, symbol }`)
  without spelling a hash that changes with every edit of the module or of its
  imports. `symbol` is the function's export name, so a blessed function must
  be exported under that one name; a rule naming anything else never fires.
  Because
  the binding comes from the selected reference, a label created under one
  version of the module is released only by that version's function.
- `v("X")` is the `{ var: "X" }` placeholder of spec §4.3.3.
- Field names follow the shipped authoring grammar and lower to the canonical
  evaluator dialect
  (`packages/runner/src/cfc/policy.ts`, which documents its mapping to spec
  §4.3.2): `appliesTo` is the spec's target pattern
  (`preCondition.confidentiality[0]`); `pre` holds the remaining side
  conditions — `confidentiality` and `integrity`; grant-backed state belongs in
  `guard.policyState`. `post` is exactly one of `addAlternatives` /
  `dropClause`. `preConfScope` defaults to `"targetClause"`. Unknown or dynamic
  fields are compile errors.
- Lowering rejects a general-surface rule unless it has a `pre.integrity`
  pattern or `guard.policyState` grant guard. Boundary-only authoring remains
  extensions-gated. If the owner-self case is approved, it ships as a narrow
  trusted standard-profile rule rather than a generic authoring exemption.

### 2a. Raising, direct

The declaration above raises `DriftFlag` directly to the exact exported
`driftFlagRules` artifact; no raw policy object or ambient name is involved.

Lowering: the schema-time atom is a policy principal addressed by the module
export, its portable manifest digest, and the invocation-relative subject —
`Policy{ module: <identity>, symbol: "driftFlagRules", policyDigest:
<digest>, subject: <owning space> }`. The pair binds the authored source export;
the digest binds the proposed module-policy variant's canonical,
subject-independent manifest body. The complete tuple binds the exact policy
instance while letting another space evaluate without retaining or recompiling
the source. A trusted compiler/verifier first proves that the source closure
and exported symbol lower to that manifest; digest verification alone proves
only copied-byte integrity. At label creation the subject is bound. Before any
space commits a persisted reference, it atomically stores or confirms a
verified local copy of the small manifest keyed by `policyDigest`.

Under cross-space label-metadata protection, `Policy.subject` may be represented
by a self-describing `{ digestOf: <hash> }` field commitment rather than
plaintext; see
[`cfc-label-metadata-confidentiality.md`](./cfc-label-metadata-confidentiality.md#5-staging)
and SC-25. The resolver seeds `THIS_POLICY.subject` from that represented value
before matching. Existing commitment-aware equality can then compare concrete
evidence without opening or disclosing the committed subject.

The record lands as a
`selection: "referenced"` policy record — the shipped label-carried,
home-clause-local selection mode (CT-1874) — with the `{ identity, symbol }`
pair, manifest digest, and invocation-relative subject added alongside the
legacy label reference `{ name, subject, hash }` (SC-29). Stage 1's
representation adapter validates the subject-independent manifest and maps its
canonical rules into the shipped
`PolicyRecord { id, digest, rules, selection: "referenced" }`; the resolver
separately supplies home-clause and pre-seeded subject context during evaluation.

Semantics, all inherited rather than invented:

- **Home-clause locality** (spec §4.4.5, `formal/Cfc/HomeClauses.lean`): the
  referenced rules can rewrite exactly the clause this raise contributes.
- **Conjunctive join**: labels arriving on the pattern's inputs join as
  independent clauses the pattern's rules cannot touch. A pattern can make its
  *own* raise declassifiable; it can never attach release paths to data it
  merely consumed.
- Raising is label creation, not rewrite — store monotonicity (§8.12) is
  unaffected.

The compiler can check local declaration/reference coherence: every direct
policy reference resolves to a static exported rule set, and every locally
authored rule is well formed. Whether a rule can actually rewrite an egress
label remains a runtime decision because it depends on input labels, integrity
evidence, grants, and boundary context.

### 2b. Raising, indirect — concept references (not implemented)

Everything in this subsection is future design. The public API does not expose
`concept()`, `ConceptOf`, `ConceptGrant`, or `ConsumerIntent` authoring.

```ts
// Shown for illustration only.
import { concept } from "commonfabric";
import type { ConceptOf, Confidential } from "commonfabric";

// pattern-local concept: id = { identity, symbol } of this export
export const avoidanceObservation = concept();

// concept bound to a well-known URI for ecosystem coordination
export const health = concept("https://commonfabric.org/cfc/concepts/health");

// or import someone else's, pinned via cf: resolution
// import { health } from "cf:/wellness/commons";

type HealthNote = Confidential<Note, [ConceptOf<typeof health>]>;
// dynamic form: cfcAtom.conceptOf(health)          — subject: owning space
//               cfcAtom.conceptOf(health, subject) — explicit owner
```

Lowering: a context principal keyed by the pair (concept id, owner subject) —
`Context{ concept: <uri | {identity, symbol}>, subject: <owner> }`. The
governing policy record is the **owner's** record for that concept, discovered
through the owner-space policy root (spec §4.4.1) and hash-verified at label
creation. That record is where user default policies live: the pattern raising
to `health` doesn't know or care what the owner's rules are.

**Stable kernel + grants (recommended record shape).** A concept record that
directly holds the user's rules has the wrong update semantics for *defaults*:
every already-labeled value stays pinned to the old hash until migrated
(§4.4.4), so "I changed my health sharing policy" wouldn't apply to existing
data. Instead the concept's record is a small hash-stable **kernel** whose
rules are generic and grant-guarded, and the user's editable defaults are
**grant records** (spec §4.3.5) consulted at evaluation time:

```jsonc
// 1. Owner access — the concept never locks out its owner. Guarded by the
//    owner-self binding: the target matches only when the clause's own
//    subject IS the acting principal (the §5.4.2 $actingUser shape), and
//    the rule releases only to that same principal — self-scoped by
//    construction, never a release to anyone else.
{ "id": "concept-owner-access",
  "appliesTo": { "type": ".../atom/Context",
    "concept": HEALTH, "subject": "$actingUser" },
  "post": { "addAlternatives": [
    { "type": ".../atom/User", "subject": "$actingUser" }] } }

// 2. Standing default — one rule serves every user-edited default.
{ "id": "concept-standing-grant",
  "appliesTo": { "type": ".../atom/Context",
    "concept": HEALTH, "subject": { "var": "O" } },
  "pre": {
    "integrity": [{ "type": ".../atom/ConsumerIntent",
      "intent": { "var": "I" }, "surface": { "var": "S" } }],
    "policyState": [{ "kind": "ConceptGrant", "concept": HEALTH,
      "owner": { "var": "O" }, "audience": { "var": "A" },
      "requiredIntent": { "var": "I" } }] },
  "post": { "addAlternatives": [
    { "type": ".../atom/User", "subject": { "var": "A" } }] } }

// 3. One-shot release — same shape, grant marked single-use (§4.3.5),
//    consumed atomically at the releasing commit (shipped as
//    commit-precondition receipts, grants.ts / #4649).
```

Consequences, inherited from §4.3.5: default edits are grant CRUD — effective
at next evaluation, no label migration; revocation is grant deletion; one-shot
declassification rides single-use grants with receipt linearity already proved
in `formal/Cfc/GrantConsumption.lean` and shipped as commit-precondition
receipts (`packages/runner/src/cfc/grants.ts`). This resolves the open question the
spec records in `notes/WORKING_GOVERNANCE_EXAMPLES.md` ("How is Alice's
medical policy at the time represented? What changes automatically for future
data?").

**Bootstrap.** Raising to a concept the owner never configured must not fail:
the substrate registers the concept's kernel (substrate-shipped, covered by
attested deployment configuration — spec §5.7.2 / SC-28) with zero grants.
Result: owner-only data with a standing structure for defaults to grow into —
strictly private until the owner says otherwise.

**Consumer side.** The `ConsumerIntent` fact in kernel rule 2 is runtime-
minted evidence for a consuming pattern's *declared* intents (a static
declaration in the consumer's module, e.g. `intents: ["care-coordination"]`).
"Health flows to surfaces that declared care-coordination intent, because the
owner granted that" is then one grant plus one declaration, evaluated by the
ordinary calculus. Default stays no-access.

### 2c. Composition

Multiple direct policies are conjunctive by default — two clauses, two
independent gates, ordinary CNF join:

```ts
import type { Confidential } from "commonfabric";
import {
  cfcPattern,
  exchangeRule,
  exchangeRules,
  THIS_POLICY,
  v,
} from "commonfabric/cfc";
import type { AnyOf, PolicyOf } from "commonfabric/cfc";

export const releaseRetention = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [
      cfcPattern.hasRole(v("reader"), THIS_POLICY.subject, "reader"),
    ],
  },
  post: { dropClause: true },
});
export const retentionRules = exchangeRules([releaseRetention]);

export const releaseDrift = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [
      cfcPattern.hasRole(v("reader"), THIS_POLICY.subject, "reader"),
    ],
  },
  post: { dropClause: true },
});
export const driftFlagRules = exchangeRules([releaseDrift]);

interface Flag {
  value: boolean;
}

type CareFlag = Confidential<Flag, readonly [
  PolicyOf<typeof retentionRules>,
  PolicyOf<typeof driftFlagRules>,
]>;

type EitherPath = Confidential<Flag, readonly [
  AnyOf<readonly [
    PolicyOf<typeof retentionRules>,
    PolicyOf<typeof driftFlagRules>,
  ]>,
]>;
```

`CareFlag` needs a firing path through *each* clause. `EitherPath` is the
explicit disjunctive opt-in via the authored-OR surface (spec §3.1.8).

One clause, either path releases — and the clause's admissible rule set is the
*union* over alternatives. `AnyOf` is an explicit weakening relative to the
conjunctive spelling; use it only when either policy is independently
sufficient. The existing authored-OR validation still rejects forbidden
alternatives such as caveats and expiry atoms.

## Proposing rules is a workflow, not an API

A pattern will often know what release *would* be useful ("weekly drift
summaries may flow to the therapist the owner named") without authority to
enact it. There is deliberately no `propose()` call. The unit of proposal is
the **published pattern itself**:

1. The author writes a pattern that declares the rule set (and typically
   raises to the relevant concept), and publishes it — deployment/publication
   gives the rule set a global `{ identity, symbol }` address.
2. Proposing is out-of-band from code: the pattern (piece address) is proposed
   to the owner's review surface, to a verifier, to a space — whatever the
   deployment's adoption flow is.
3. Adoption takes one of the existing evidence-producing forms, none of which
   pattern code can perform:
   - **Instantiation** — the owner instantiates the pattern; its declared
     rules now govern (only) the clauses the pattern itself raises. Same
     authority bound as authoring.
   - **Grant** — the owner accepts a standing default for a concept via the
     trusted review surface: a state-scoped intent executed by the trusted
     policy writer, which commits a `ConceptGrant` (spec §13.4.3 shape,
     §4.3.5 write gate: the writer verifies the owner's release authority
     over the granted scope).
   - **Trust statement** — a verifier asserts the pattern's implementation
     satisfies a concept used in integrity guards (spec §4.8.2), extending
     which concrete code can satisfy concept-guarded rules for users who
     delegate to that verifier.

This split has a security payoff: the release *parameters* (audience,
required intent, expiry) originate in the trusted review surface at acceptance
time, not in pattern-authored data — which structurally removes the main
§3.8.4 laundering path (a pattern smuggling an injected audience through a
proposal object). The policy writer's obligation reduces to sourcing grant
parameters only from endorsed intent evidence.

## Enforcement summary

1. Rules referenced from `PolicyOf` must be module-level exports (or pinned
   `cf:` imports); the compiler lowers them statically and rejects
   runtime-computed rule content other than `v()` variables and
   `THIS_POLICY`. `ConceptOf` is not implemented.
2. All rule firing happens in trusted boundaries (render boundary, sink gate,
   gated writes) via the fueled fixpoint of spec §4.4.5, fail-closed.
3. Observing contexts (preview/diagnostics) must not consume single-use
   grants (§4.3.5) — "would release" chrome renders without spending.
4. Module-declared records are pinned by defining module identity, export
   symbol, and canonical manifest digest. Each destination persists the exact
   verified manifest before committing a referencing label; missing or
   mismatched local artifacts fail closed.

## Companion extensions

Syntax sketches for the remaining policy surfaces live in
[`cfc-exchange-rules-authoring-extensions.md`](./cfc-exchange-rules-authoring-extensions.md):
sink-scoped rules and authority-only inputs (spec §5.2.1, §5.3.1), error
exchange rules (§5.4), caveat-discharge rules (invariant 10 / §14.1),
multi-party consent release (§5.3.4), `PolicyCertified` require/run-under
(§5.5), implements-concept claims (§4.8.2), TTL sugar, and row-set read modes
(invariant 14 / §8.17). Deliberately out of scope everywhere: verifier
delegation and trust-statement issuance (user/space-level acts, not pattern
code) and recombination across multiple grants on one concept (§14.3.2 — open
in the spec; the surface-level obligation is enumerating a concept's active
grants, SC-35).

## Open questions

1. **Atom shape for concept-scoped principals.** Extend `Context` with a
   `concept` field (as sketched) vs. a distinct atom type. Leaning extension:
   all `Context` machinery (discovery, hash binding, home clauses, migration)
   applies unchanged; SC-30 carries the decision.
2. **Well-known URI governance.** Who mints `concepts/health` and where the
   directory lives (spec §5.7.1 names a public concept directory but no
   process). Pattern-relative ids need no governance, so this only gates the
   ecosystem-coordination tier.
3. **Owner-record discovery key.** `{user-space}/.policies/<x>` needs a
   canonical key for both id forms (URI digest; identity+symbol digest).
4. **Cross-pattern rule-set reuse.** Sharing rules as importable *values*
   (each pattern's record hashes its own copy) vs. referencing another
   pattern's deployed rule set as the *same policy identity*. Values-only
   reuse is safer (no cross-code-hash coupling of release paths) but loses
   "we both defer to the same policy"; `cf:` imports make either expressible.
   Leaning values-only until a concrete need appears.
