# CF Protocol: CFC & Trust Profiles (Sections 10–12)

See the [verifiable-execution document map](README.md) for navigation.

## 10. Contextual Flow Control (CFC)

### 10.1 Beyond Access Control

Traditional access control answers the question "who may read or write this
resource?" but it is largely silent on what happens _after_ access is granted.
Once computation is treated as a first-class event, the question of _policy_
becomes unavoidable.

### 10.2 What is CFC?

**Contextual Flow Control (CFC)** is an opinionated application of Information
Flow Control (IFC), aligned with the idea of _contextual integrity_: data should
flow in ways that match the user's expectations for a given context.

CFC treats external inputs—including those produced by AI models—as **untrusted
by default**, requiring explicit policy to allow them to influence
higher-integrity state.

### 10.3 Labels

Inputs and outputs carry labels that describe confidentiality and integrity
constraints:

- **Confidentiality label**: Where information is allowed to flow
- **Integrity label**: What sources of information are considered trustworthy

The current implementation has a foundation:

```typescript
type Labels = {
  // Coarse/legacy label summary. Full IFC labels are schema-driven and may
  // vary by JSON path (via `ifc` annotations in schemas).
  classification?: string[];
};
```

In practice, IFC annotations live on JSON Schemas via the `ifc` extension (see
`docs/specs/json_schema.md`) and are evaluated/propagated by runtime logic (see
`runtime/runner/src/cfc.ts`).

#### 10.3.1 Label Facts (Current)

The current implementation supports a coarse, entity-level label fact:

- `the: "application/label+json"` associated with an entity (`of: URI`)
- `is: Labels` (today: `classification?: string[]`)

These label facts are used for access control and redaction in schema-guided
queries (e.g. `"/memory/graph/query"`), and may also be attached to commits as
supporting metadata for downstream redaction.

#### 10.3.2 Schema-Driven Labels (Path Granularity)

Schemas may include IFC annotations (via the `ifc` extension) at any depth of a
JSON Schema. This makes labels naturally **path-granular**: different subpaths
of the same JSON value may carry different labels.

When path-granular labels exist, an entity-level `Labels` value can be treated
as a coarse summary (e.g., a join/LUB of all subpath labels).

#### 10.3.3 Canonical Label Map (Future)

To support verifiable label reasoning (without requiring disclosure of labeled
values), receipts may commit to a canonical, path-addressed “label map”.

**Path representation:** Use JSON paths as `string[]` segments:

- Object properties use their property name as a segment
- Array indices use a base-10 integer segment (e.g. `"0"`, `"1"`)
- The root path is `[]`

**Canonical representation:**

```typescript
type JSONPath = readonly string[];

type IFCLabel = {
  classification?: string[];
  // Future: confidentiality / integrity components beyond classification
};

type CFCLabelMapEntry = {
  path: JSONPath;
  label: IFCLabel;
};

type CFCLabelMap = {
  version: 1;
  entries: CFCLabelMapEntry[];
};
```

**Canonical ordering:** `entries` MUST be sorted lexicographically by `path`
(segment-by-segment), and MUST NOT contain duplicate paths.

#### 10.3.4 Label Map Commitments (Future)

This spec uses content-addressed hashes (see `FabricHash` in
`base/data-model/src/fabric-primitives/FabricHash.ts`) for
commitments.

A label map commitment MUST be domain-separated and deterministic. One simple
construction is:

```typescript
// Shown inside a pattern body.
// Commitment = merkle-reference hash of a domain-separated wrapper object.
const labelMapCommitment = refer({ "CT/CFCLabelMap": labelMap });
```

Verifiers can recompute this commitment given the canonical label map object.

### 10.4 Policy as Content-Addressed Artifact

Policies are themselves content-addressed and referenced by receipts. A
computation does not merely claim compliance with a policy; **it commits to a
specific, immutable policy definition.**

---

## 11. Policy Commitment vs Policy Enforcement

### 11.1 The Distinction

**Policy commitment** records that a computation declared its intent to operate
under a particular policy. This alone is valuable:

- Makes assumptions explicit
- Prevents silent policy drift
- Allows downstream systems to reason about compatibility

**Policy enforcement** concerns evidence. It asks whether the rules were
mechanically applied during execution.

### 11.2 Why the Distinction Matters

The CF Protocol does not force a single answer. A system can choose to accept
commitment alone, or it can require proof of enforcement, depending on context.

By separating declaration from demonstration, the CF Protocol avoids the false
dichotomy between blind trust and maximal proof.

### 11.3 Trusted Execution Environments (TEEs)

When enforcement evidence is required, TEEs can attest that specific code ran in
a measured environment. The attestation links:

- The identity of the code
- The receipt describing the computation
- The outcome of policy checks

TEEs are treated as _optional strengthening_, not as a foundation on which
everything else rests.

---

## 12. Trust Profiles

### 12.1 The Problem

Different audiences mean different things when they say they "trust" an
artifact. Trust profiles provide a vocabulary for precise communication.

### 12.2 Profile: Existence & Ordering

**Checks:** Log inclusion (and receipt signature, if present)

**Guarantees:** The receipt/commit exists and was ordered

**Non-guarantees:** Authorization, correctness, policy compliance

### 12.3 Profile: Authorized State Update

**Checks:** Log inclusion, ACL verification, and authenticated actor identity (e.g. receipt signature)

**Guarantees:** The authenticated actor was authorized at commit time

### 12.4 Profile: Provenance-Complete Output

**Checks:** Authorized + verification of all `inputRefs`

**Guarantees:** Output is transitively derived from referenced inputs

### 12.5 Profile: Policy-Committed Computation

**Checks:** Provenance + presence of CFC commitments

**Guarantees:** The computation committed to a specific CFC policy

### 12.6 Profile: Policy-Enforced Computation

**Checks:** Policy-Committed + TEE attestation verification

**Guarantees:** The computation mechanically enforced CFC rules

### 12.7 Profile Selection

Applications SHOULD explicitly state which trust profile they require.
Verifiers MUST NOT assume guarantees beyond the verified profile.

---

Prev: `docs/specs/verifiable-execution/05-log-and-authorization.md`  
Next: `docs/specs/verifiable-execution/07-extensions-and-appendices.md`
