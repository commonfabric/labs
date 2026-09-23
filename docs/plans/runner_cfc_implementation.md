# CFC Runner Implementation Plan

This document is the implementation plan for adding commit-boundary Contextual
Flow Control (CFC) enforcement to `packages/runner`.

It is intentionally self-contained. It describes:

- the target behavior
- the normative specification context
- the data model we will implement
- the workstreams, files, and acceptance criteria
- the rollout sequence

## Implementation Guidance

Use a disciplined per-slice workflow while executing this plan:

- Work in red-green-refactor TDD loops: start by writing or extending the
  smallest failing test that captures the next required behavior, implement
  the minimum change to make it pass, then refactor with the suite green
- Commit often. Prefer small, reviewable commits that each preserve a green
  targeted test run and map to one vertical slice, invariant, or mechanical
  refactor
- Keep each landing slice mergeable and reversible. Avoid multi-workstream
  branches that mix contract changes, policy behavior, persistence changes,
  and sink integration unless the boundary is already proven by tests
- After each slice, run the narrowest relevant tests first, then rerun the
  broader package-level tests before moving to the next slice
- Treat invariants in this document as executable requirements. When a bug
  or ambiguity is found, add or tighten a test before adjusting the code
- Use sub-agents only for bounded sidecar work that improves quality
  without creating conflicting edits. Good uses include plan/spec
  conformance review, test-gap review, and source-hunting for integration
  points; avoid delegating overlapping code edits in the same files
- For risky slices such as commit gating, retry behavior, trust-sensitive
  relaxations, or sink deduplication, schedule an explicit review pass
  before moving rollout forward. A sub-agent review is useful here as a
  second set of eyes, but the main branch of truth remains the spec, the
  tests, and the final human review

## Goal

Move from schema-guided IFC propagation to a runner/storage boundary that
enforces CFC at commit time.

At the end of this work:

- schema `ifc` annotations will be enforced before a commit succeeds
- CFC-relevant writes will persist authoritative path-granular metadata and
  deep-frozen canonical schema hashes backed by canonical schema documents
  stored at `cid:<hash>` as a phase-1 stand-in for fuller content-addressed v2
  storage
- commit-time enforcement will apply uniformly at the transaction boundary,
  regardless of whether the transaction came from the scheduler,
  `runtime.editWithRetry()`, or another runtime-owned caller
- cell reads that follow stored links will expose a dereferenced cell-view label
  that reflects both the stored link relationship and the target content, while
  raw reads of stored link fields keep distinct link-field label semantics
- external side effects will be gated on successful commit
- trust-sensitive relaxations will be explicit, deterministic, and fail closed

Phase 1 targets the memory-v2 transaction path only. No
`application/label+json` bridge or coarse-label compatibility path is carried
forward.

## Specification Context

This plan is constrained by the surrounding specs rather than by any specific
current implementation shape:

- `docs/specs/json_schema.md` defines `ifc` as a schema extension
- `docs/specs/verifiable-execution/06-cfc-and-trust.md` defines the
  path-granular label-map direction and trust terminology
- `docs/specs/ts-transformer/cfc_authoring_contract.md` defines the authoring
  surface for richer `ifc` keys such as `integrity`, `addIntegrity`,
  `requiredIntegrity`, `maxConfidentiality`, `writeAuthorizedBy`, `projection`,
  and collection rules
- `docs/specs/ts-transformer/cfc_ui_helper_contract.md` defines the UI-helper
  authoring surface that lowers into `ifc.uiContract` hints plus runtime
  `data-ui-*` markers consumed by the trusted UI provenance path
- `docs/specs/memory-v2/README.md` and
  `docs/specs/memory-v2/03-commit-model.md` define the seq-addressed JSON write
  path and the adjunct/system-entity surfaces we should reuse for schema
  persistence and code identity; phase 1 persists canonical schemas as regular
  v2 entities addressed by `cid:<hash>` so the boundary model does not depend
  on new blob APIs landing first

This plan adds the boundary substrate that those specs require:

- there is no transaction-level CFC state
- there is no prepare-before-commit step
- there is no canonical digest of consumed reads, attempted writes, and
  write-time policy inputs
- there is no authoritative persisted CFC metadata record per entity
- there is no trust snapshot threaded through boundary evaluation
- side effects are not uniformly gated on successful commit

## Terms

### Schema IFC Metadata

This plan treats schema `ifc` as the only declaration surface. The runner will
support these keys in phases:

- `confidentiality`
- `integrity`
- `addIntegrity`
- `requiredIntegrity`
- `maxConfidentiality`
- `writeAuthorizedBy`
- `exactCopyOf`
- `projection`
- `collection`

### CFC-Relevant Transaction

A transaction is CFC-relevant when at least one consumed read, attempted write,
or write-time policy input touches data whose effective schema or stored CFC
metadata carries IFC constraints.

### Consumed Read

A consumed read is a read that contributes to boundary checking for the current
attempt. It is derived from transaction inspection APIs and excludes
verifier-internal reads. Scheduler-only metadata and CFC metadata must remain
separate concerns.

### Potential and Final Write Sets

The ideal high-precision model records ordered attempted writes before
last-write-wins compaction.

Phase 1 does not require that precision. It uses two deterministic transaction
views:

- `attemptedWrites`: the maybe-write target set, sourced from tx
  `markReadAsAttemptedWrite` reads performed while deciding whether a diff
  results in a write
- `writes`: the actual changed/final write set sourced from v2 transaction
  internals

Boundary checking uses `attemptedWrites ∪ writes` as the target set for
relevance and conservative target-side policy checks. Persisted output label-map
updates and metadata updates are derived from `writes` only. If later rules
need per-write provenance or exact attempt order, we can add dedicated
write-attempt logging as a follow-on precision optimization.

Phase-1 invariant: direct `tx.write*()` usage remains internal-only runner API.
No-op attempted-target coverage depends on higher-level diff paths performing
`markReadAsAttemptedWrite` reads before deciding whether to write. That
assumption should be documented explicitly on the transaction write APIs and
covered by guardrail tests. This is not just theoretical: current v2 writes
short-circuit same-value writes before recording write activity, so no-op
attempted-target coverage must come from `markReadAsAttemptedWrite` or a future
explicit attempted-write API.

### Write-Policy Input

A write-policy input is boundary-relevant write-time data that cannot be
reconstructed from generic tx read/write inspection alone.

Examples:

- the candidate `SchemaAndHash` or canonical schema payload for a target write
- provenance claims needed for `projection`, `exactCopyOf`, or collection rules
- trusted-event provenance
- immutable sink request snapshots
- persisted link-write provenance for paths where the diff layer has decided
  the stored value will remain a sigil link

These inputs must be recorded explicitly in tx CFC state at mutation time,
canonicalized deterministically, and hashed into prepare.

### Dereference Trace

A dereference trace records the link hops followed while resolving a cell view.
It is separate from the ordinary consumed-read list. Ordinary read logging is
still sufficient for conservative downstream write taint, but the trace is
needed to explain which stored link slots and target reads contributed to a
dereferenced label, to preserve link-path provenance, and to distinguish raw
stored-link reads from dereferenced cell-view reads.

The first representation should be lightweight and transaction-local: metadata
on target reads, a CFC state side trace, or a nearby wrapper around
`resolveLink(...)` are all acceptable. Introducing a future explicit
`followRef` activity kind is a cleanup, not a prerequisite.

### Cell-View Label

A cell-view label is the label exposed by APIs that materialize dereferenced
cell content: `Cell.get()`, `Cell.pull()`, query-result proxies, schema
traversal, and render-time label helpers such as `cfcLabelViewForCell(...)`.

It includes the labels of reads actually consumed to materialize the value. If a
link hop is followed, the resulting view includes both the stored link-slot
observation and the target value observation reached through the hop. For
cross-space links this remains conjunctive in practice: the reader must satisfy
the source-side link relationship and the target-side content.

### Stored Link-Field Label

A stored link-field label describes the path where a sigil link is stored as
data, including raw final-slot reads such as `getRawUntyped()`.

It labels the fact that "this path references that target" rather than treating
the target bytes as if they were stored inline. It must preserve the source-cell
confidentiality/integrity relationship, add link-local endorsement integrity
for storing or selecting the reference, and avoid collapsing raw-link reads into
the same semantics as dereferenced reads.

### Prepare

Prepare is the deterministic boundary check that runs after the user action or
handler has produced its reads and writes but before commit succeeds.

Prepare:

- gathers consumed reads, canonical `attemptedWrites`, canonical `writes`, and
  canonical write-policy inputs
- evaluates schema and policy obligations
- computes output label maps and metadata
- records a digest of exactly what was checked

### Prepared Digest

The prepared digest is a stable hash of:

- canonical consumed reads
- canonical `attemptedWrites`
- canonical `writes`
- the ordered write-attempt log
- dereference traces and trigger reads
- canonical write-policy inputs
- implementation identity
- trust snapshot identity
- module delegations
- the policy snapshot
- consulted grants and module-policy manifests
- label-metadata observations
- external-content observations admitted through opaque runtime receipts

Optional sets are omitted when empty. In particular,
`externalContentObservations: []` has the same digest spelling as an absent
field, preserving the digest of a transaction that observed no external
content.

Any change to that material invalidates preparation.

### Implementation Identity

Every trust-sensitive check uses an explicit implementation identity:

- a stable, policy-facing code identity for verified compiled modules and
  handlers
- `Builtin(<name-or-ref>)` for runtime built-ins

`implementationRef` remains the runtime lookup key for executable functions, and
`verifiedLoadId` remains the runtime admission scope. The boundary evaluator
reuses the verified-load registry for execution provenance, while policy
references resolve against a separate stable code identity derived from one of:

- verified compiled code: a stable verified bundle hash plus canonical binding
  path within that bundle, and when needed source loc/col and/or a pure code
  hash for sandbox-admitted self-contained functions
- built-ins: canonical runtime-owned registry ids

Phase 1 treats bare memory-v2 `codeCID` as at most one component or hint for
that identity, not the identity itself. Durable policy references must use the
stable verified bundle hash and binding metadata rebound through the verified
registry rather than the ephemeral `verifiedLoadId`.

Phase 1 does not require stable policy identities for direct-eval,
unsafe-host/test helpers, or any other unsupported identity class. Those paths
are treated as untrusted for trust-sensitive relaxations unless a later
explicit stable-id path is added.

Outstanding verified-code trust-anchor gap:

- [ ] Add policy/trust-graph infrastructure that can say a stable code
      location is trusted for a specific claim class. The durable identity must
      be based on the verified bundle hash plus canonical binding/source-map
      metadata, or a content-addressed hash for sandbox-admitted self-contained
      functions; do not persist or policy-reference `verifiedLoadId` load
      counts. Source-map rebinding must fail closed if the resolved source
      location is outside the verified bundle identity being checked.
- [ ] Use that trust anchor to decide when authored annotations are trusted.
      In particular, `ifc.uiContract` hints and aligned `data-ui-*` markers
      should only become trusted UI provenance evidence when the declaring
      pattern/helper code identity is trusted for the corresponding UI
      annotation capability; otherwise the annotations remain untrusted and
      fail closed.

### Trust Snapshot

A trust snapshot is the acting-principal-scoped view of the trust graph used by
the boundary evaluator. Trust-sensitive relaxations must depend on this
snapshot, not on ambient mutable state.

## Storage Model

For memory-v2, the runner needs an authoritative CFC metadata record embedded in
the single entity document. Phase 1 is memory-v2-only.

### Embedded Metadata

Introduce a system-owned reserved sibling to `value` and `source` for each
entity:

```ts
type IFCLabel = {
  confidentiality?: unknown[];
  integrity?: unknown[];
};

type CfcMetadata = {
  version: 1;
  schemaHash: string;
  labelMap: {
    version: 1;
    entries: Array<{
      path: string[];
      label: IFCLabel;
    }>;
  };
};

type EntityDocumentWithCfc = {
  value?: unknown;
  source?: unknown;
  cfc?: CfcMetadata;
};
```

### Document Surface Rules

Memory-v2 keeps a full entity-document boundary. Low-level `tx.read()` and
`tx.write()` operate on the whole entity document, including reserved metadata
siblings such as `source` and `cfc`.

The read and materialization paths present the logical `value` surface:
`Cell.get()`, `Cell.sync()`, query materialization, and similar
validate/transform paths read under `value`, not the full document, so a
reserved sibling never arrives as user JSON content.

That is a property of those paths rather than a boundary around untrusted
code. A pattern's handler holds a runtime cell in the runtime's own realm, so
the document surface is within its reach: `getMetaRaw` reads a meta field, and
the storage transaction the cell is bound to addresses any path of the
document, `value` and its reserved siblings alike. Each seam on that surface
therefore carries its own guard:

- The meta seam — `patternIdentity`, `argument`, `slug`, and the rest of the
  `MetaField` union — is the runtime's to write. `setMetaRaw` marks the write
  it makes, and the write chokepoint refuses a meta write that arrives
  unmarked, whatever the enforcement mode, because a write there names the
  program a piece runs rather than editing its data. Three shapes reach a
  meta field and all three are refused: an address naming the field, a
  document-root envelope carrying it as a key, and a document-root write that
  leaves it out, which drops it, since a root write replaces the envelope.
  The third is decided by one read of the envelope the write replaces, at the
  document root. What the guard looks at there is which meta keys that envelope
  has rather than what any of them holds, so the read is `nonRecursive`, and the
  flow join keys on that: a recursive read consumes every label-map entry at or
  below the path it names, a `nonRecursive` one consumes only the entry at that
  path, so this read consumes the document's root entry and nothing else.
  Reading a meta member instead would consume the user data an entry of the same
  name covers, because canonicalization strips a leading `value` and a document
  with a user field named `slug` labels it at the logical path the raw
  `["slug"]` member reads. The read carries no commit precondition, because a
  precondition would turn a whole-document write into a read-modify-write, and
  the blind root writes the runtime makes would lose the race against any
  advance of the document they replace. What that leaves open is an erasure
  racing the guard, never a forgery: the two shapes that name a field are
  refused from the write itself, with no read at all. The refusal is also the
  first of these guards to run, ahead of the ones keyed by target id, so which
  document a write names cannot decide whether it is asked for an authorization.
  Meta fields stay readable.
- The reserved siblings — the `cfc` label map and `source` — are the runtime's,
  and a write reaching either from outside the privileged persistence scope is
  recorded, with the commit boundary turning each record into a fail-closed
  reason (audit S18). The prepare pass excludes both from its accounting: a
  read of one is left out of the flow join, and a write to one is left out of
  schema write policy and flow-label attachment. That exclusion describes the
  runtime's own bookkeeping, and it holds only because this guard establishes
  that the runtime is who writes here, so one list of sibling names drives the
  exclusion and the guard together.
- Three shapes reach a reserved sibling. An address can name it, or a path
  inside it. And a document-root (`path: []`) write replaces the envelope
  rather than merging into it, so its envelope reaches every sibling at once —
  leaving one out erases what was stored, and leaving a different one behind
  installs what the derivation pass never derived. A root write is decided
  against the stored sibling, so one that carries the stored sibling forward
  unchanged passes: code that replaces a document wholesale reads the stored
  envelope and spreads it, the way `ACLManager` does. Creating a document, and
  replacing one that carries no reserved sibling, pass for the same reason.
- Whether a sibling is there at all is decided on what a reader would see
  rather than on the presence of a key. For `cfc` that account is
  `cfcMetadataPresent`: the reserved position is what qualifies a value, so an
  envelope carrying `cfc: null` or a scalar erases the map as surely as one
  carrying no `cfc`, and anything else there leaves a map behind, including a
  version this build cannot read. Nothing interprets `source`, so definedness
  is the whole account there.
- Whether the sibling that is there is the stored one decides the rest, and
  what a whole-document write owes it is the value the document already holds.
  Reading the stored envelope and spreading it produces that value; an
  envelope assembled some other way is one the transaction composed rather
  than carried, and it is recorded whether or not the labels it names work out
  the same. So a rebuild that reorders entries, or the alternatives inside an
  OR clause, is recorded even though the label it names is unchanged. Holding
  the rule at the value is what gives one answer across every spelling a
  stored envelope takes: a version-1 envelope carrying its labels, a version-2
  one naming the large ones by content hash and holding the small ones inline,
  and a version this build does not read at all.
- Nothing outside the runtime is given a way past this. A fixture still needs
  stored label state in shapes the derivation pass does not produce — a forged
  atom, a version this build cannot read, a record carrying no label map — and
  reaches one write inside the privileged persistence scope through the
  transaction's `accessForTestingOnly` getter, which a lint rule confines to
  tests and benchmarks. The runtime keeps no second door: there is no write
  option, and no exported value, that lets a caller past the guard.
- The refusal is a record rather than a throw, unlike the meta seam beside it.
  A forged label map is a signal whose treatment follows the enforcement mode:
  enforce rejects the commit, observe diagnoses it, and `disabled` keeps the
  record so a mid-transaction escalation still rejects. A deployment running
  with CFC disabled consults no label map, so a forged one decides nothing
  while it runs — the map it wrote is durable, and a later run with enforcement
  on reads what is stored.
- The guard reads the stored sibling through the writing transaction, which
  bounds the erasure half: a transaction whose view does not hold the document
  gets the same "nothing here" a document with nothing gives, so a writer that
  has not synced the document erases its label map and commits. No race is
  involved — the map is present throughout, and the writer never looked. The
  forgery half carries no such bound, because it is decided from the envelope
  the writer supplied. Closing the erasure half means forcing the document into
  view before deciding, which turns every blind root write into a
  read-modify-write, or making the commit boundary establish what the space
  holds; both are open.
- A guard on a seam governs writes to it, not the runtime entry points that
  write it while doing their own work. The same reach that hands a handler
  the storage transaction hands it the runtime: `runtime.run` instantiates a
  pattern of the caller's choosing onto a cell the caller names, and stamps
  that cell's `patternIdentity` through the authorized entry point on the
  caller's behalf. What that costs is a question about the object graph a
  cell hands pattern code, and it is where a boundary around untrusted code
  would have to be drawn.

Storage rules:

- in memory-v2, the reserved `cfc` sibling is authoritative for boundary checks
  once present
- the v2 `cfc` sibling stores the authoritative label map and `schemaHash` in
  the same document as `value` and `source`
- untrusted value-surface reads and materialized values must not expose the
  reserved `cfc` sibling
- code that replaces a document wholesale carries the stored envelope forward
  — read it and spread it, the way `ACLManager` does — rather than building
  a fresh `{ value }`, which drops every reserved sibling the document held
- no `application/label+json` bridge or coarse-summary compatibility path is
  carried forward

### Path Canonicalization

The canonical logical path format is `string[]` with the wrapper segment
`"value"` stripped. Root is `[]`.

When we need deterministic hashing or ordering, encode that canonical path as a
JSON Pointer string derived from the segment array.

### Schema Hash and Frozen Schema

Use the existing frozen-schema pipeline for canonical schema identity. Prefer
interning _unless_ there is strong evidence that it causes performance problems.
`internSchema(...)` returns an interned value, and `internSchema(..., true)`
returns a `SchemaAndHash` with both the interned value and its hash. If not
interning, deep-freezing via `toDeepFrozenSchema()` is the best fallback choice.
**Note:** There is never a need to pre-freeze the input to `internSchema()`, as
it will do the freezing step itself; it is documented to "take ownership" of
its argument and will freeze it directly.

`schemaHash` is the persisted `SchemaAndHash.hashString` for the canonical
merged schema envelope for the entity, not the hash of any one effective
selector schema seen during prepare.

The root document `schemaHash` names may be self-contained or carry
`$ref: cid:` members — a decomposed write
(`RuntimeOptions.cfcDecomposedEnvelopes`), or the root a reference-form
declared schema leaves behind. One read policy covers both: every external
reference a stored root carries resolves (space-first with content
verification, the hash-verified realm registry supplying what the space
does not hold) or the envelope is unreadable (fail closed), and the
storage commit boundary validates the whole closure at write time. A
`version` outside the declared union is an envelope the build cannot
interpret, and every reader fails closed on it rather than treating the
document as unlabeled.

The corresponding deep-frozen canonical schema object is also persisted as a
regular memory-v2 entity whose id is `cid:<hash>`. The canonical schema payload
lives under that entity document's `value`; any sibling fields are reserved for
system metadata. This is a phase-1 stand-in for a future dedicated
content-addressed v2 surface.

Prepare loads the prior envelope by reading `cid:<schemaHash>` and then its
`value`, merges candidate schema input into it, and persists a replacement
canonical schema document only when the merged envelope changes.

### Merged Schema Envelope

The runner needs a proper merge implementation for the supported schema subset.
This is not general JSON-Schema merge; it is a canonical merge for the
IFC-relevant structural subset that preserves compatibility with already-stored
data.

Phase-1 merge rules:

- IFC keys such as `confidentiality`, `integrity`, `addIntegrity`,
  `requiredIntegrity`, `maxConfidentiality`, `writeAuthorizedBy`,
  `exactCopyOf`, `projection`, and `collection` may stay the same or become
  stricter, but must never be weakened
- IFC keys must live at the same node as `anyOf`/`oneOf`/`allOf`, not inside
  divergent branches; we do not support different label sets per branch
- the merged schema must not invalidate data that was previously structurally
  valid
- a merge may add a required field when the merged schema provides a default
  that preserves validity/materialization for existing documents, or when the
  write-policy input identifies that path as a generated output materialized by
  the running module
- every merged result is canonicalized with `internSchema(..., true)` before
  persistence to its `cid:<hash>` schema document

Phase-1 behavior:

- each write that carries schema context, typically from `Cell.*` operations,
  contributes a candidate schema update for its target entity
- if the target entity has no stored `schemaHash`, prepare persists the
  candidate canonical schema envelope as `cid:<hash>` and stores the resulting
  `schemaHash`
- if the target entity already has a stored `schemaHash`, prepare loads that
  canonical schema document from `cid:<schemaHash>` and attempts a monotonic
  merge of the candidate schema into it
- if merge fails because the candidate would weaken IFC obligations or
  invalidate previously valid data, prepare rejects and the transaction aborts,
  unless an explicit migration or recovery path is active
- if the canonical merged envelope produces the same `schemaHash`, prepare
  treats the schema update as a no-op
- if the canonical merged envelope produces a new `schemaHash`, prepare
  persists or reuses the replacement `cid:<hash>` schema document and
  replacement hash
- if a stored `schemaHash` is missing or unreadable, or the corresponding
  `cid:<hash>` schema document is absent/unreadable, prepare rejects and the
  transaction aborts unless an explicit recovery path is active

This keeps schema identity stable while making schema evolution a per-write
entity update, rather than depending on whichever narrowed selector schema
happened to be observed elsewhere in the attempt.

## Non-Goals

This plan does not attempt to do all of the following in the first landing:

- full write-time JSON Schema validation unrelated to CFC
- general policy distribution or discovery protocols
- broad UI authoring ergonomics beyond the provenance hooks needed for trusted
  events
- a generalized content-addressed side-path security model before the core
  causal path is stable
- a wholesale rewrite of scheduler or runtime architecture

## Invariants

These must hold once enforcement is enabled:

- no CFC-relevant commit succeeds without a same-attempt prepare
- any read, write, or write-policy input that changes the prepared digest
  invalidates prepare
- verifier-internal reads never become consumed reads
- explicit IFC claims fail closed on missing schema, missing metadata, unknown
  trust state, or unsupported trust-sensitive claims
- the commit gate lives at the transaction boundary, not only in scheduler code
- external side effects happen only after successful commit
- retries always run in a fresh transaction and recompute prepare
- persisted CFC metadata is system-controlled, not user-editable JSON content
- no `application/label+json` compatibility path participates in enforcement
- dereferenced cell-view labels keep link-slot observations coupled to the
  target reads reached through those links
- raw final-slot link reads and dereferenced reads intentionally produce
  different CFC label surfaces
- ordinary final-slot links are values, not write-through aliases; only
  write-redirect links are followed for writes
- persisted link-write provenance is emitted only after the diffing layer has
  decided that the stored value at the target path will actually be a link
- unlabeled paths remain permissive in phase 1; changing that default is a
  separate rollout step, not an implicit side effect of the first enforcement
  launch

## Workstreams

### 1. Contract and Types

Primary files:

- `packages/runner/src/storage/interface.ts`
- `packages/runner/src/storage/extended-storage-transaction.ts`
- new files under `packages/runner/src/cfc/`

Tasks:

- [x] Define `CfcTxState`, `ConsumedRead`, `AttemptedWrite`,
      `WritePolicyInput`, `PreparedDigestInput`, `ImplementationIdentity`,
      `TrustSnapshot`, `CfcEnforcementMode`, and `CfcMetadata`
- [x] Define a dedicated metadata marker for `internalVerifierRead`
- [x] Define a dedicated side-effect outbox entry type for post-commit effects
- [x] Define the reserved embedded `cfc` document shape and system-ownership
      rules for that metadata
- [x] Define a canonical code-identity shape that separates policy-facing code
      identity from per-load runtime ids and can encode bundle/path/location/hash
      provenance without relying on bare memory-v2 `codeCID`

Acceptance:

- [x] New types compile without changing behavior
- [x] Serialization tests cover `CfcMetadata`, `WritePolicyInput`, and digest
      input canonicalization

### 2. Transaction State and Commit Gate

Primary files:

- `packages/runner/src/storage/interface.ts`
- `packages/runner/src/storage/extended-storage-transaction.ts`
- `packages/runner/src/storage/v2-transaction.ts`

Tasks:

- [x] Add CFC state to the extended transaction wrapper and/or underlying
      transaction implementation: relevance, preparation status, prepared
      digest, write-policy inputs, trust snapshot, outbox, and enforcement mode
- [x] Add helpers to mark a transaction relevant, prepared, invalidated, and to
      enqueue post-commit side effects
- [x] Make the commit gate live in the transaction commit path so
      scheduler-driven flows, `runtime.editWithRetry()`, and other
      runtime-owned commit callers use the same enforcement boundary
- [x] Support rollout modes:
      `disabled`, `observe`, `enforce-explicit`, and `enforce-strict`
- [x] In `observe`, compute prepare state and diagnostics without blocking
- [x] In enforcing modes, enforce `relevant -> prepared` at commit
- [x] Recompute the digest immediately before commit and reject on mismatch
- [x] Reset CFC state on abort and on retry

Acceptance:

- [x] Observe mode records prepare state without blocking commit
- [x] Relevant transaction without prepare fails commit in enforcing modes
- [x] Prepared transaction with unchanged activity commits successfully
- [x] Post-prepare read, write, or write-policy input invalidates prepare
- [x] Abort clears outbox state
- [x] Scheduler-owned and direct runtime-owned commit callers hit the same gate

### 3. Canonical Activity and Policy-Input Capture

Primary files:

- `packages/runner/src/storage/interface.ts`
- `packages/runner/src/storage/v2-transaction.ts`
- `packages/runner/src/storage/transaction-inspection.ts`
- `packages/runner/src/storage/reactivity-log.ts`
- new files under `packages/runner/src/cfc/`

Tasks:

- [x] Build a canonical extractor over the v2 inspection APIs
- [x] Surface tx `attemptedWrites` as the phase-1 maybe-write target set
- [x] Produce a deterministic final-per-path `writes` set for phase 1
- [x] Preserve no-op attempted-target coverage through `attemptedWrites`
- [x] Add JSDoc and guardrails on internal `tx.write*` APIs explaining that
      phase-1 no-op attempted-target coverage relies on higher-level diff paths
      using `markReadAsAttemptedWrite`; blind same-value direct writes are not
      surfaced through `attemptedWrites`
- [x] Audit existing internal direct `tx.write*` / `writeValueOrThrow()` call
      sites and either ensure they establish `attemptedWrites` coverage before
      same-value short-circuiting or explicitly keep them out of phase-1 CFC
      scope
- [x] Add explicit APIs to record canonical `WritePolicyInput` entries at
      mutation time; do not rely on generic tx read/write inspection alone for
      schema hashes or structural provenance claims
- [x] Keep scheduler metadata and verifier metadata distinct
- [x] Exclude only `internalVerifierRead` from the consumed-read set
- [x] Make the phase-1 prepare engine free to pessimistically treat all
      consumed reads as influencing all target paths in
      `attemptedWrites ∪ writes`
- [x] Defer exact ordered write-attempt logging to a follow-up precision slice
      if later rules need it

Acceptance:

- [x] Canonical path handling strips the `value` wrapper consistently
- [x] Phase-1 canonical `attemptedWrites` extraction is deterministic across
      runs
- [x] Phase-1 canonical `writes` extraction is deterministic across runs
- [x] Canonical `WritePolicyInput` capture is deterministic across runs
- [x] Internal verifier reads remain visible for diagnostics but not policy
- [x] Final-per-path view is deterministic
- [x] Same-value direct writes are either covered by `attemptedWrites` or
      explicitly out of phase-1 scope

### 4. Relevance Detection

Primary files:

- `packages/runner/src/schema.ts`
- `packages/runner/src/traverse.ts`
- `packages/runner/src/cell.ts`
- `packages/runner/src/link-utils.ts`

Tasks:

- [x] Mark a transaction relevant when traversal encounters schema `ifc`
- [x] Mark a transaction relevant when existing stored CFC metadata applies to a
      consumed read
- [x] Mark write-only transactions relevant when the target path carries CFC
      obligations even if no read happened first
- [x] Treat attempted no-op writes as relevant when they appear in
      `attemptedWrites` for a path carrying CFC obligations
- [x] Ensure dependency-discovery transactions and other non-committing
      inspection transactions do not trigger prepare
- [x] Audit helper reads that should be tagged `internalVerifierRead`

Acceptance:

- [x] Reading a path with `ifc` marks the transaction relevant
- [x] Reading unlabeled plain data does not mark it relevant
- [x] Writing to a path with stored or schema-derived CFC metadata marks it
      relevant
- [x] Attempting a no-op write to a path with stored or schema-derived CFC
      metadata still marks it relevant
- [x] Dependency-collection transactions remain unaffected

### 5. Metadata and Schema Persistence

Primary files:

- `packages/runner/src/storage/v2.ts`
- `packages/runner/src/storage/v2-document.ts`
- `packages/memory/v2.ts`
- `packages/memory/v2/engine.ts`
- `packages/runner/src/storage/interface.ts`

Tasks:

- [x] Persist CFC metadata as a system-owned reserved sibling to `value` and
      `source` in the v2 entity document
- [x] Persist canonical merged schema envelopes as system-owned v2 schema
      documents at `cid:<hash>` and store `schemaHash` in embedded metadata
- [x] Store the authoritative path-granular label map and `schemaHash` in that
      embedded metadata
- [x] Ensure untrusted value-surface reads and materialized values do not
      expose the reserved `cfc` sibling
- [x] Make storage helpers able to read current CFC metadata and load
      canonical schemas from `cid:<schemaHash>` efficiently during prepare
- [x] Do not carry forward `application/label+json` or query-redaction
      compatibility behavior

Acceptance:

- [x] A successful prepared write persists embedded CFC metadata and
      `schemaHash`
      in the v2 document
- [x] Loading the stored canonical schema by `schemaHash` after a fresh runtime
      restart reads `cid:<schemaHash>` and reproduces the canonical merged
      schema envelope
- [x] Existing untrusted value-surface reads and materialized values do not
      surface the reserved `cfc` sibling
- [x] Missing or unreadable `schemaHash` rejects later writes unless recovery
      is on

### 6. Prepare Engine

Primary files:

- new files under `packages/runner/src/cfc/`
- `packages/runner/src/schema.ts`
- `packages/runner/src/traverse.ts`

Tasks:

- [x] Build `prepareBoundaryCommit(tx, options)` as a pure, deterministic
      evaluator
- [x] Thread explicit write-policy inputs recorded at mutation time into
      prepare, including candidate `SchemaAndHash` values and structural
      provenance claims
      when available
- [x] Implement a canonical merged-schema envelope operator for the supported
      subset
- [x] Ensure IFC keys never weaken under merge and never appear only inside a
      divergent `anyOf`/`oneOf`/`allOf` branch
- [x] Ensure structural merge does not invalidate previously valid data; adding
      a required input or unclassified document field requires a default, while
      a generated output path may be required without one
- [x] Resolve input labels from stored CFC metadata and persisted
      `cid:<hash>`-backed schema documents; no coarse-label fallback
- [x] Implement `confidentiality`, `integrity`, `addIntegrity`,
      `requiredIntegrity`, and `maxConfidentiality`
- [x] Implement `writeAuthorizedBy`, `exactCopyOf`, `projection`, and
      collection-derived transition checks where they can be evaluated from
      consumed reads plus `attemptedWrites`/`writes` plus explicit write-policy
      inputs; otherwise fail closed or remain conservative
- [x] Until stable implementation identities and trust snapshots land, treat
      trust-sensitive claims such as `writeAuthorizedBy` as non-enforceable:
      allow diagnostics in `observe`, but hard-reject them in enforcing modes
- [x] Compute output label maps from `writes`
- [x] Persist only concrete evidence in stored metadata; derived trust closure
      remains runtime-only
- [x] In phase 1, allow a conservative all-consumed-reads-to-all-targets
      influence model over `attemptedWrites ∪ writes`
- [x] Use `attemptedWrites ∪ writes` for target-side enforcement and use
      `writes` only for persisted output metadata
- [x] If a target entity has no stored `schemaHash`, seed it from the first
      canonical `SchemaAndHash` and persist or reuse `cid:<hash>`; if merge
      yields the existing `schemaHash`, treat it as a no-op; if merge yields a
      new `schemaHash`, replace the stored hash; if merge fails, reject and
      abort the transaction
- [x] Reject on missing schema, missing write-policy inputs, unreadable schema
      hashes, or any unsupported trust-sensitive claim

Acceptance:

- [x] Required-integrity failures reject before commit
- [x] Successful prepare writes stable `schemaHash` and label-map metadata
- [x] Unsupported or malformed trust-sensitive claims fail closed

### 7. Transaction Integration, Retry, and Side-Effect Gating

Primary files:

- `packages/runner/src/scheduler.ts`
- `packages/runner/src/cell.ts`
- `packages/runner/src/runner.ts`
- `packages/runner/src/runtime.ts`
- `packages/runner/src/storage/extended-storage-transaction.ts`

Tasks:

- [x] Make prepare invocation explicit for all runtime-owned writable
      transaction paths; scheduler integration is one path, but the commit gate
      remains in the transaction commit path
- [x] Insert prepare between action/handler execution and commit in
      scheduler-managed flows
- [x] Integrate generic `runtime.editWithRetry()` and other direct commit
      callers with the same prepare-or-observe path
- [x] Replace effectful use of generic commit callbacks with a success-only
      outbox
- [x] Migrate stream sends, queued events, and other runner-managed side
      effects to the outbox
- [x] Add JSDoc on internal commit-callback / `onCommit` hooks explaining that
      they are internal-only, may run after failed commits, and must not
      perform external side effects; effectful work must use the outbox
- [x] Keep retries fresh: new tx, new prepare, new trust snapshot
- [x] Audit `onCommit` and direct commit call sites and move effectful ones to
      the outbox

Acceptance:

- [x] Failed commit does not emit side effects
- [x] Relevant transactions committed via the scheduler,
      `runtime.editWithRetry()`, or other runtime-owned direct callers are
      uniformly gated
- [x] Retried handler emits side effects once, after the winning commit
- [x] Non-effectful commit callbacks used for diagnostics still work
- [x] Internal callback docs make the non-effectful restriction explicit

### 8. Implementation Identity and Trust

Primary files:

- `packages/runner/src/runner.ts`
- `packages/runner/src/builder/module.ts`
- `packages/runner/src/builder/to-encodable-form.ts`
- `packages/runner/src/harness/executable-registry.ts`
- `packages/runner/src/storage/interface.ts`
- `packages/memory/v2.ts`
- new files under `packages/runner/src/cfc/`

Tasks:

- [x] Define a stable policy-facing code identity separate from runtime
      `implementationRef` and per-load `verifiedLoadId`, capable of describing
      verified bundle identity, canonical binding path, optional loc/col,
      and/or pure code hash
- [x] Keep `implementationRef` as the runtime lookup key and `verifiedLoadId` as
      the runtime admission scope; resolve policy identities through the
      verified registry and built-in registry, treating bare memory-v2
      `codeCID` as only one possible component or hint rather than a complete
      identity
- [x] Define canonical ids for built-ins
- [x] Rebind verified compiled-code policy identity through a stable verified
      bundle hash plus registry-owned binding metadata rather than persisting
      the ephemeral `verifiedLoadId`
- [x] Keep authored trust-sensitive matching on canonical binding identity
      rather than runtime export shape; top-level supported bindings are
      annotated directly and self-contained content-addressed functions remain
      a separate verified-identity lane
- [x] In phase 1, treat direct-eval and unsafe-host/test helpers as untrusted
      for trust-sensitive relaxations unless a later explicit stable-id path is
      added
- [x] Thread the resulting implementation identity through action and handler
      execution where possible for both built-ins and verified compiled user
      code; unsupported identity classes still remain observe-only/fail-closed
- [x] Define a trust-snapshot provider interface that is deterministic and easy
      to test
- [x] Bind prepare success to the acting principal, trust snapshot identity,
      and resolved policy-facing implementation identity
- [x] Gate trust-sensitive flow relaxations on that snapshot

Acceptance:

- [x] Built-ins produce stable policy-facing implementation identities
- [x] Verified compiled user-code policy identities resolve to stable verified
      bundle-hash identities and canonical binding paths when the verified
      registry can rebind them safely
- [x] Trust-sensitive authored `writeAuthorizedBy` claims match verified
      compiled code through canonical binding identity rather than helper-
      specific policy formats
- [x] Unsupported identity classes fail closed for trust-sensitive checks
- [x] Changing the trust snapshot between prepare and commit invalidates prepare
- [x] Unknown implementation identity is treated as untrusted

### 9. Flow-Precision and Structural Claims

Primary files:

- new files under `packages/runner/src/cfc/`
- `packages/runner/src/builtins/`
- `packages/runner/src/traverse.ts`

Tasks:

- [x] Define the supported structural claim set for the first pass
- [x] Implement conservative defaults for collection transforms
- [x] Allow less-restrictive structural claims only when explicitly trusted
- [x] Start with the built-ins that already shape collections in the runtime:
      `map`, `filter`, and `flatMap`

Acceptance:

- [x] Untrusted structural relaxations fall back to conservative labels
- [x] Trusted structural claims can narrow labels only where the claim proves it
- [x] Unsupported collection operators remain conservative

### 10. Sink Enforcement

Primary files:

- `packages/runner/src/builtins/fetch.ts`
- `packages/runner/src/builtins/fetch-program.ts`
- `packages/runner/src/builtins/stream-data.ts`
- `packages/runner/src/builtins/llm.ts`
- `packages/runner/src/builtins/llm-dialog.ts`
- new files under `packages/runner/src/cfc/`

Tasks:

- [x] Introduce a stable, immutable request snapshot for external sink calls
- [x] Include `streamData`, `llm`, `llmDialog`, `generateText`, and
      `generateObject` alongside `fetchJson` and `fetchProgram` in the initial
      sink inventory and rollout gate
- [x] Move network side effects behind the transaction outbox
- [x] Verify sink-specific policy from the prepared request snapshot and
      committed CFC state before issuing the request
- [x] Add idempotency keys so retries do not reissue the same committed effect
- [x] Keep request authorization and request execution as separate steps

Acceptance:

- [x] Failed prepare or failed commit never issues a network call from
      `fetchJson`, `fetchProgram`, `streamData`, `llm`, `llmDialog`,
      `generateText`, or `generateObject`
- [x] Retried attempts reuse the winning committed effect and do not double-send
- [x] Request release rules are evaluated from the prepared request snapshot and
      committed CFC metadata, not ad hoc runtime state

### 11. UI Provenance and Trusted Events

Primary files:

- `packages/html/src/`
- `packages/runner/src/scheduler.ts`
- `packages/ts-transformers/src/`
- `packages/schema-generator/src/`

Tasks:

- [x] Define an internal event envelope that can carry provenance and integrity
      hints
- [x] Add renderer-generated provenance for user-initiated events
- [x] Carry event provenance through scheduler delivery and handler execution
- [x] Consume the authoring pipeline's `ifc.uiContract` hints and aligned
      runtime `data-ui-*` markers as the schema/runtime declaration surface for
      trusted UI event outputs

Acceptance:

- [x] User-originated events can be distinguished from untrusted synthetic input
- [x] Boundary evaluation can consume event provenance without ambient globals
- [x] Trusted UI event delivery consumes `ifc.uiContract` without inventing a
      second helper-specific policy format
- [x] Untrusted UI-origin claims fail closed

Implementation notes for spec update:

- [x] Trusted reusable UI surfaces now express pattern-level trust through
      `ifc.uiContract.trustedPattern` plus
      `ifc.uiContract.requiredEventIntegrity`; the renderer supplies matching
      event provenance from aligned `data-ui-pattern` and
      `data-ui-event-integrity` markers on the rendered UI ancestry
- [x] Prepare-side trusted-event validation reuses the existing
      `trusted-event` write-policy input and fails closed when a schema declares
      trusted pattern or event-integrity requirements that the renderer did not
      attest
- [x] Current enforcement assumes a trusted host and an embedding model where
      untrusted embedders cannot hide or obscure embedded trusted UIs; future
      spec work should define opaque trusted UI islands and a non-forgeable
      pattern identity token beyond DOM data attributes
- [x] Event-integrity labels are collected from the event target ancestry, so a
      trusted pattern can later bind rendered integrity-bearing data into the
      event attestation without introducing a parallel helper-specific policy
- [x] Render-time label disclosure now has a generic `cf-cfc-label` UI
      primitive: it takes a bound `$value` and optional `atom`/`kind` filters,
      asks the trusted runtime IPC layer for that cell's CFC label view, and
      renders the result without exposing a general label-introspection API to
      pattern code
- [x] Audience release is modeled as a family of trusted send/publish surfaces,
      not one universal component: each surface should bind the visible
      destination context (conversation, channel, public target, persistent
      policy target) into the trusted pattern semantics
- [x] Disclaimer-style gates such as fact-check, prompt-influence disclosure,
      provenance review, and redaction warnings now have a non-interactive
      render path: trusted surfaces render the associated content plus a
      generic `cf-cfc-label` disclosure instead of treating the disclaimer as a
      click-derived event authorization
- [x] `cf-cfc-label` intentionally reads document-level CFC metadata through
      the trusted runtime IPC path. It must not treat schema `ifc` constraints
      as labels to display; schema annotations remain the policy/declaration
      surface that prepare uses to create or constrain stored metadata
- [x] The implemented render-time monitor is intentionally low-level and
      generic: `cf-cfc-render-boundary` can bind a `$value`, narrow
      `maxConfidentiality`, and declassify an explicit atom list before
      rendering its children. It reads actual document CFC metadata, with schema
      IFC only as a conservative fallback when stored/read labels are absent
- [x] The render boundary no longer models a legacy ordered secrecy lattice.
      Absent `maxConfidentiality` means no render-time bound, while explicit
      `maxConfidentiality={[]}` means only unlabeled content may render. Any
      allowed or declassified labels are compared as structured CFC atoms by
      canonical structural equality
- [x] Runtime/demo CFC labels now use spec-style structured atoms such as
      `Resource` and `Caveat` instead of the previous
      `unclassified`/`confidential`/`secret`/`topsecret` compatibility strings.
      The old runner `Classification` constants were removed from the public
      runtime surface
- [x] Defer full render-time declassification evidence to a follow-on
      runtime/spec slice: specify how trusted disclaimer render evidence enters
      CFC prepare/digest inputs and how that evidence is checked before labeled
      content can appear in an untrusted host tree outside an explicit
      `cf-cfc-render-boundary`
- [x] Process-oriented examples such as song identification, scoped
      availability contribution, and long-running upload are modeled as trusted
      interactive kickoff surfaces with mocked middle steps; the surface should
      authorize only the bounded derivative/process result, not raw recording
      or raw private inputs

### 12. Content-Addressed Side-Path Hardening

This stays behind the core causal-path rollout. Phase 1 schema persistence uses
regular `cid:<hash>` schema entities, not a dedicated blob/adjunct write
surface. This slice remains blocked until memory-v2 gains first-class
content-addressed adjunct read/write APIs.

Primary files:

- `packages/runner/src/storage/`
- `packages/memory/`
- new files under `packages/runner/src/cfc/`

Tasks:

- [x] Defer applying the same boundary model to future content-addressed
      adjunct writes until v2 exposes first-class blob/object side-path APIs
- [x] Defer exact binding enforcement between embedded hashes such as
      `schemaHash` and any future content-addressed object until prepare can
      actually read and verify that adjunct surface
- [x] Defer normalized miss behavior across absent blob/ref, unreadable
      binding, and policy mismatch until adjunct reads exist
- [x] Defer seq-addressed versus content-addressed bypass proofs until those
      side paths exist in v2

Acceptance:

- [x] Keep content-addressed side-path enforcement disabled in phase 1 while
      the adjunct API surface does not exist
- [x] Keep side-path miss reasons out of the public surface by not exposing any
      adjunct read path in phase 1
- [x] Keep public causal reads limited to explicit embedded hashes and regular
      entity reads in phase 1

### 13. Cell Link Label Following and Stored-Link Provenance

This slice keeps the existing conservative consumed-read taint behavior while
making link-following structure explicit enough for first-class cell-view
labels, stored link-field labels, diagnostics, and persisted link metadata.

Primary files:

- `packages/runner/src/link-resolution.ts`
- `packages/runner/src/cell.ts`
- `packages/runner/src/query-result-proxy.ts`
- `packages/runner/src/schema.ts`
- `packages/runner/src/data-updating.ts`
- `packages/runner/src/cfc/types.ts`
- `packages/runner/src/cfc/canonical.ts`
- `packages/runner/src/cfc/label-view.ts`
- `packages/runner/src/cfc/prepare.ts`
- `packages/runner/src/storage/extended-storage-transaction.ts`

Tasks:

- [x] Add a transaction-local dereference trace representation that records
      each followed hop's source link slot, resolved target, link kind, and
      whether the final slot was followed as a value or only as a
      write-redirect
- [x] Emit dereference trace entries from `resolveLink(...)` or a focused
      wrapper used by `Cell.get()`, `Cell.pull()`, query-result proxies, schema
      traversal, and render-time label-view reads
- [x] Keep ordinary read logging intact so conservative all-consumed-reads
      write taint remains sound before any future `followRef` activity kind
- [x] Extend `cfcLabelViewForCell(...)` and related helpers so cell-view labels
      are computed from stored metadata on consumed link slots, stored metadata
      on consumed targets, and the dereference trace rather than from final
      target reads alone
- [x] Add a write-policy input kind for persisted link writes that captures the
      target path, normalized target reference, source cell/source metadata when
      available, link-local endorsement integrity, and optional link schema
- [x] Emit persisted link-write policy input from `normalizeAndDiff(...)` only
      on the branch that returns a stored link write; do not emit it from
      `convertCellsToLinks(...)`, and do not emit it when the diff collapses a
      link to an inline snapshot
- [x] Teach `prepare.ts` to derive stored link-field labels from source-cell
      metadata, the link relationship, link-local endorsement integrity, and
      any explicit schema carried by the stored link
- [x] Fail closed in enforcing modes when a CFC-relevant stored link write is
      missing required source metadata, link-write provenance, or readable
      target/source metadata; observe mode should emit diagnostics without
      silently treating the link as public
- [x] Preserve the write semantics distinction: final-slot ordinary links are
      persisted as values, while only write-redirect links are followed for
      writes
- [x] Include dereference-trace and link-write inputs in canonical prepare
      hashing so post-prepare link changes invalidate prepare deterministically
- [x] Add diagnostics that can explain which link hops and target reads
      contributed to a dereferenced cell-view label

Acceptance:

- [x] `Cell.get()`, `Cell.pull()`, query-result proxies, traversal, and
      `cfcLabelViewForCell(...)` expose a cell-view label that includes both
      link-slot and dereferenced target labels
- [x] `getRawUntyped()` at a final stored link slot exposes the stored
      link-field label and does not read or label the target content as an
      inline copy
- [x] Two links to the same target preserve the same target-content taint while
      differing in link-local integrity/provenance when their endorsements
      differ
- [x] Cross-space linked reads produce a cell-view label that reflects both the
      source-side link relationship and target-side content read
- [x] Prepared writes that persist sigil links also persist CFC metadata for
      the stored link path, even when the sigil link omits schema
- [x] Same-document parent/self links collapsed to snapshots by
      `normalizeAndDiff(...)` do not persist link-style provenance metadata
- [x] `cfcLabelViewForCell(...)` continues to reflect labels behind linked
      cells and uses the dereference trace when available
- [x] Enforcing modes fail closed for missing link-source metadata or missing
      link-write provenance; observe mode records actionable diagnostics
- [x] Tests prove ordinary final-slot links are not write-through aliases while
      write-redirect links still are

## Test Strategy

The test matrix should be built in the same order as the implementation:

- [x] unit tests for types, path canonicalization, write-policy input
      canonicalization, and digest stability
- [x] unit tests for merged-schema monotonicity, branch-external IFC placement,
      and required-field/default compatibility
- [x] transaction tests for prepare gating and invalidation
- [x] rollout-mode tests for `disabled`, `observe`, and enforcing modes
- [x] traversal tests for relevance detection
- [x] prepare-engine tests for input requirements and output transitions
- [x] storage tests for embedded-metadata persistence, `schemaHash`
      dereferencing, and non-exposure
- [x] scheduler and runtime-owned direct-commit tests for retry and outbox
      behavior
- [x] sink tests for commit-gated network execution and idempotency
- [x] UI tests for provenance-backed trusted event delivery
- [x] fresh-runtime restart tests for persisted metadata and schema hashes;
      trust snapshots are recomputed per transaction and covered by retry
      tests
- [ ] link-resolution tests for dereference trace shape, including nested links,
      final-slot raw reads, write-redirect resolution, and cross-space hops
- [ ] label-view tests proving dereferenced cell-view labels join link-slot and
      target labels, while raw link-field reads surface only the stored
      link-field label
- [ ] boundary/prepare tests for persisted link-write policy inputs, missing
      source metadata fail-closed behavior, and observe-mode diagnostics
- [ ] data-updating tests proving link-write provenance is emitted only for
      actually persisted links, not for links collapsed to snapshots by
      `normalizeAndDiff(...)`
- [ ] integration tests mirroring the spec's personal-workspace-to-shared-
      material scenario: a personal-space entry links to shared content, reading
      through the entry requires both sides, and the view gains personal
      selection integrity plus the shared target integrity

Sink-result replay across restart is deferred to a later phase.

Every phase should land with tests before the next phase starts.

## Rollout and Guardrails

- [x] Add a runtime feature flag for commit-boundary CFC enforcement
- [x] Define rollout modes:
      `disabled`, `observe`, `enforce-explicit`, and `enforce-strict`
- [x] Default phase 1 to unlabeled-permissive behavior; switching unlabeled
      paths away from permissive defaults is a separate rollout gate
- [x] Emit counters for:
      `cfcRelevantTx`, `cfcPreparedTx`, `cfcPrepareRejects`,
      `cfcDigestInvalidations`, `cfcOutboxFlushes`, and sink dedup hits
- [x] Keep sensitive values out of logs; log only rule ids, paths, schema
      hashes,
      and effect ids
- [x] Treat step 8 below as the first safe enablement point for state-only
      transactions
- [x] Before step 9 below, enforcing modes cover only the non-trust-sensitive
      rule subset; claims that depend on stable code identity or trust snapshots
      must remain observe-only or fail closed
- [x] Do not enable enforcing modes for runtimes with external sinks until
      outbox and retry tests are green
- [x] Do not enable content-addressed side-path enforcement until non-bypass
      tests are green; the temporary `cid:<hash>` schema-entity path can land
      earlier

## Recommended Landing Order

Land the work in mergeable vertical slices:

1. [x] Types, canonical path helpers, write-policy input helpers, and digest
       helpers
2. [x] Transaction CFC state and rollout modes with observe-mode prepare
3. [x] V2 consumed-read, `attemptedWrites`, compact final-write extraction, and
       write-policy input capture APIs
4. [x] Relevance detection and merged-schema envelope implementation
5. [x] Embedded v2 CFC metadata persistence, `cid:<hash>` schema-document
       persistence, and non-exposure
6. [x] Baseline prepare engine for confidentiality and integrity checks
7. [x] Transaction integration and success-only outbox
8. [x] Enforcing commit gate for state-only transactions for the
       non-trust-sensitive rule subset once extraction/prepare slices are green
9. [x] Stable built-in implementation identity and trust snapshotting; richer
       verified-code identity and trust-sensitive rule enforcement remain
       blocked on extending v2 code-identity surfaces
10. [x] Structural flow-precision claims for core built-ins
11. [x] Fetch, `streamData`, `llm`, and other external sink enforcement
12. [x] UI provenance and trusted-event path
13. [x] Content-addressed side-path hardening is deferred behind the missing
        v2 adjunct API surface
14. [ ] Cell link label-following and stored-link provenance:
        first land failing tests for dereference trace capture, cell-view versus
        stored-link-field labels, and persisted link writes; then implement the
        smallest trace, policy-input, prepare, and label-view changes needed to
        make each slice green

Step 8 is the first safe enablement point for non-trust-sensitive,
state-only transactions that do not issue external effects. Step 9 is the first
safe enablement point for identity classes that already have stable policy ids,
such as built-ins; verified compiled user-code trust-sensitive enforcement
remains blocked until the richer v2 code-identity extension lands. Step 11 is
the first safe enablement point for runtimes with external sinks.

## Done Means

This plan is complete when all of the following are true:

- CFC-relevant transactions are prepared and verified before commit at the
  transaction boundary
- authoritative path-granular CFC metadata and canonical schema hashes are
  persisted for later reads and writes, with phase-1 schema payloads stored as
  `cid:<hash>` schema documents
- no `application/label+json` or coarse-label bridge is required for the v2
  enforcement path
- external side effects are commit-gated and retry-safe
- stable policy-facing code identities align supported identity classes with
  bundle/path/location/hash provenance rather than relying on bare `codeCID`
- trust-sensitive relaxations are deterministic and fail closed
- linked cell-view labels can explain the link hops and target reads that
  contributed to their confidentiality and integrity
- stored link fields persist link-field CFC metadata without pretending raw
  link reads are dereferenced target-content reads
- tests cover warm-runtime and fresh-runtime behavior
- the feature can be enabled incrementally with clear observability
