# CFC TypeScript Authoring Implementation Plan

This document is the forward-looking implementation plan for the CFC-aware
TypeScript and JSX authoring surface. It defines the execution plan for turning
author-authored types and UI helpers into deterministic schema `ifc` metadata
and UI contract hints.

Normative contract details live in:

- [CFC Authoring Contract](../specs/ts-transformer/cfc_authoring_contract.md)
- [CFC UI Helper Contract](../specs/ts-transformer/cfc_ui_helper_contract.md)
- [CFC Runner Implementation Plan](./runner_cfc_implementation.md)

This plan is intentionally about the target system only.

## Goal

Deliver a small TypeScript authoring surface that:

- keeps ordinary pattern code close to normal TypeScript and JSX
- lowers deterministically into schema `ifc` metadata
- preserves enough provenance for runner-side commit-boundary enforcement
- keeps the canonical surface small and puts friendly sugar on top
- keeps raw schema authoring available as an escape hatch

At the end of this work, authors should be able to express the supported CFC
metadata in types and UI helpers, and the emitted schemas should be stable
enough for the runner plan to persist canonical `schemaHash` values and enforce
transition rules at commit time.

## Scope

In scope:

- `base/api`
- `base/ts-transformers`
- `base/schema-generator`
- builder and UI runtime helper parity needed for the closed helper set
- acceptance tests that prove authoring parity across inferred and explicit
  schema paths

Out of scope:

- general policy evaluation in the runner
- trust-graph semantics beyond the schema and identity handoff required here
- broad UI ergonomics outside the closed CFC helper set
- replacing raw `JSONSchema` authoring for advanced or unsupported cases

## Target Surface

The implementation centers on a small canonical surface:

- `Cfc<T, Meta>` as the compiler-facing carrier
- path-bearing helpers: `Ref`, `PathValue`, `RefValue`, `CanonicalPointer`
- projection helpers: `ProjectionPath`, `ProjectionOf`, `Projection`
- simple wrapper aliases:
  `Confidential`, `Integrity`, `AddIntegrity`, `RequiresIntegrity`,
  `MaxConfidentiality`, `ExactCopy`
- `WriteAuthorizedBy<T, typeof binding>` for trust-sensitive write policy
- closed JSX helper set:
  `UiAction`, `UiPromptSlot`, `UiDisclosure`

> **2026-07-10 surface reduction:** the collection helpers
> (`LengthPreservedFrom`, `FilteredFrom`, `SubsetOf`, `PermutationOf`) and
> `OpaqueInput<T, Spec>` were removed from the canonical surface (and the
> checked items below that built them were executed and later reverted): they
> lowered to `ifc.collection` / `ifc.opaque`, which the runner rejects
> fail-closed as unsupported trust-sensitive claims, so authors got code that
> type-checked but could only ever fail at commit. Reintroduce the helpers
> together with the runner enforcement for the spec's §8.5 / §8.13
> transitions. `ifc.projection` is now runner-enforced (§8.3 verify + scoped
> integrity carry), so the projection helpers stay.

Friendly sugar may exist, but it must remain a thin layer over this canonical
surface. There should not be a second CFC DSL with different lowering rules.

## Required Invariants

The authoring implementation must preserve these invariants:

- `Cfc<T, Meta>` never changes the runtime value shape of `T`
- supported aliases lower by expanding back to the canonical surface
- path-bearing helpers preserve source path identity, not only projected value
  types
- `ProjectionOf<Root, Path>` and `Projection<Ref<Root, Path>>` lower
  identically
- `WriteAuthorizedBy` accepts only the narrow supported `typeof` forms and
  emits a hard diagnostic otherwise
- JSX helpers rewrite to stable runtime `data-ui-*` attributes and compile-time
  schema hints; they do not mint final integrity atoms themselves
- inferred output schemas and explicit `toSchema<Output>()` paths produce the
  same CFC-relevant schema output
- transformer stage ordering remains:
  `CfcJsxTransformer -> SchemaInjectionTransformer -> SchemaGeneratorTransformer`

## Cross-Plan Alignment With The Runner Layer

The authoring and runner plans meet at a few load-bearing seams. Those seams
need to be explicit in this plan so implementation work does not drift.

### Stable Canonical Schemas

The runner persists canonical schema envelopes and `schemaHash` values. The
authoring pipeline therefore needs deterministic CFC lowering across:

- `toSchema<T>()`
- inferred `pattern()` schemas
- explicit output schema bindings

Semantically equivalent authoring forms must converge on the same emitted IFC
shape or the runner's schema merge and persistence model will drift.

### `WriteAuthorizedBy` Identity Handoff

`WriteAuthorizedBy` is authoring sugar for a runner-enforced trust-sensitive
rule. The authoring pipeline must preserve local binding identity through the
transformer and schema-generator boundary in a form that the runner can later
map to its policy-facing `ImplementationIdentity`.

This plan assumes phased availability:

- authoring-time syntax and diagnostics can land first
- runner enforcement for stable built-in identities can land next
- runner enforcement for verified compiled user code remains blocked until the
  lower-layer code-identity work in
  [runner_cfc_implementation.md](./runner_cfc_implementation.md) is complete

Deferred until the lower-layer verified code-identity work lands:

- verified compiled user code is still gated on the runner identity model
- the authoring surface documents the handoff now, but the runner still owns the
  eventual identity decision

### Structural Provenance Handoff

`projection`, `exactCopyOf`, and `collection` annotations only become
enforceable when the runtime also records the write-policy inputs described in
the runner plan. Authoring work must therefore standardize the emitted schema
shapes that those runtime write-policy inputs are checked against.

The emitted schema shapes are standardized as follows:

- `writeAuthorizedBy` emits a stable binding marker that the schema generator
  can rehydrate
- `exactCopyOf` lowers to canonical JSON Pointer segments
- `projection` lowers to canonical `from` + `path` pointer metadata
- `collection` lowers to canonical collection claim metadata

Deferred until runtime mutation paths record the required write-policy inputs:

- the authoring surface emits the structural claims, but the runner still owns
  enforcement

### UI Contract Handoff

UI helpers are only useful if the compile-time and runtime halves agree:

- compile time emits `ifc.uiContract` hints and `data-ui-*` attributes
- builder and renderer emit the same runtime node shape
- the runner's trusted-event and provenance path consumes those hints without
  inventing a second helper-specific policy format

This branch already aligns the emitted `ifc.uiContract` shape with the runner's
trusted-event and UI provenance path.

### `OpaqueInput` Boundary

`OpaqueInput<T, Spec>` was removed from the authoring surface (see the
2026-07-10 surface-reduction note above): the runner rejects `ifc.opaque`
fail-closed, so the helper only produced commit failures. The boundary
described here still applies if the helper is reintroduced with runner
support:

- authoring/schema generation owns `ifc.opaque` lowering
- builder/runtime input handling owns opaque read restrictions
- runner boundary enforcement is driven by the supported IFC rule set, not by
  treating `opaque` as a transition rule

### Literal Evaluation Limits

Metadata payload lowering is intentionally conservative. The authoring
transform only evaluates payloads that are statically reducible during
transform-time lowering; dynamic expressions remain runtime values and do not
become schema metadata.

UI helper hints follow the same rule. `cfcUiContract` is synthesized only from
compile-time string literals, while non-literal helper props still rewrite the
DOM but do not produce schema hints.

## Workstreams

### 1. Lock The Contract Surface

- [x] Freeze the canonical alias set across `base/api`,
      `base/ts-transformers`, and `base/schema-generator`
- [x] Define the supported metadata keys for the TypeScript surface:
      `confidentiality`, `integrity`, `addIntegrity`, `requiredIntegrity`,
      `maxConfidentiality`, `writeAuthorizedBy`, `exactCopyOf`, `projection`,
      `collection`, and `opaque`
- [x] Define the path-bearing helper contract for `Ref`, `PathValue`,
      `RefValue`, and `CanonicalPointer`
- [x] Define the projection helper contract for `ProjectionPath`,
      `ProjectionOf`, and `Projection`
- [x] Lock the supported `WriteAuthorizedBy` declaration forms and the required
      `cfc-write-authorized-by` diagnostic
- [x] Document the literal-only limits for metadata payload evaluation and UI
      helper schema hint synthesis

### 2. Add The Public API Surface

- [x] Export `Cfc<T, Meta>` from `base/api`
- [x] Export the canonical alias set from `base/api`
- [x] Export `OpaqueInput<T, Spec>` and keep its base schema shape equal to `T`
- [x] Keep friendly sugar as aliases over the canonical surface rather than
      separate lowering paths
- [x] Add author-facing examples for path-bearing projections, opaque inputs,
      and trusted write authorization annotations

#### Authoring Examples

The supported helpers should read like ordinary TypeScript:

- `ProjectionPath<{ title: string }, "/source", readonly ["nested", "path"]>`
  lowers to `ifc.projection` with canonical JSON Pointer paths.
- `OpaqueInput<{ token: string }>` preserves the base schema of `T` while
  adding `ifc.opaque`.
- `WriteAuthorizedBy<{ title: string }, typeof localFunction>` preserves the
  local binding identity marker for later runner handoff.

### 3. Implement Schema Lowering In `schema-generator`

- [x] Expand nested aliases recursively before deciding whether a type is
      CFC-aware
- [x] Substitute type parameters through alias expansion
- [x] Evaluate literal-like metadata payloads and merge the result into
      `schema.ifc`
- [x] Preserve the base schema of `T` when stripping the `Cfc<T, Meta>`
      carrier
- [x] Lower `ProjectionPath`, `ProjectionOf`, and `Projection` to canonical
      JSON Pointer metadata
- [x] Lower `OpaqueInput<T, Spec>` to the schema of `T` plus `ifc.opaque`
- [x] Preserve `WriteAuthorizedBy` binding identity through a cross-stage
      marker that can be rehydrated during schema emission
- [x] Fall back to ordinary schema generation when unsupported alias expansion
      cannot be resolved, except for required hard diagnostics such as invalid
      `WriteAuthorizedBy`
- [x] Prove deterministic output across inferred and explicit schema paths so
      runner `schemaHash` persistence remains stable

### 4. Implement Transformer Pipeline Support

- [x] Keep the CFC stage order fixed:
      `CfcJsxTransformer -> SchemaInjectionTransformer -> SchemaGeneratorTransformer`
- [x] Add validation for `WriteAuthorizedBy<T, typeof binding>` in the
      transformer pipeline
- [x] Ensure the pipeline preserves enough AST identity for schema-generator to
      rehydrate local binding references
- [x] Ensure `SchemaInjectionTransformer` preserves CFC-aware type identity in
      generated `toSchema<...>()` calls
- [x] Add guardrail tests so pipeline reordering fails loudly

### 5. Land The UI Helper Vertical Slice

- [x] Export the closed helper set:
      `UiAction`, `UiPromptSlot`, `UiDisclosure`
- [x] Rewrite recognized helper elements to intrinsic tags using `as` or the
      helper default
- [x] Strip helper-only props from the residual prop bag
- [x] Re-emit semantic props as `data-ui-*` attributes on the rewritten node
- [x] Attach node-local `cfcUiContract` hints only when the relevant helper
      props are compile-time string literals
- [x] Synthesize `[UI]` member schemas from returned JSX trees
- [x] Copy node-local UI contract hints onto the synthesized schema as
      `ifc.uiContract`
- [x] Ensure explicit output schemas receive the same `[UI]` helper hints as
      inferred output schemas
- [x] Mirror the same runtime helper shape in builder and renderer code so
      transformed JSX and direct helper usage converge

### 6. Close The Runner Handoff Gaps

- [x] Add explicit acceptance criteria that compare the normalized IFC output
      from inferred and explicit schema paths to protect stable runner
      `schemaHash` values
- [x] Define the emitted schema shape that the runner prepare engine will read
      for `writeAuthorizedBy`, `exactCopyOf`, `projection`, and `collection`
- [ ] Deferred until lower-layer verified code-identity work lands: Align the
      `WriteAuthorizedBy` handoff with the runner's `ImplementationIdentity`
      model instead of treating schema emission as the end of the feature
- [ ] Deferred until the lower-layer identity work lands: Document that
      trust-sensitive enforcement for verified compiled user code remains
      gated on the lower-layer identity work
- [ ] Deferred until runtime mutation paths record the required write-policy
      inputs: Document that structural claims are not enforceable unless
      runtime mutation paths also record the required write-policy inputs
- [x] Align `ifc.uiContract` output with the runner's trusted-event and UI
      provenance path in workstream 11 of
      [runner_cfc_implementation.md](./runner_cfc_implementation.md)
- [x] Keep `OpaqueInput` documented as an authoring/runtime feature rather than
      a commit-boundary transition rule

### 7. Testing And Acceptance Coverage

- [x] Add transformer tests for alias expansion, projection path encoding,
      `OpaqueInput`, JSX helper rewriting, and `WriteAuthorizedBy` diagnostics
- [x] Add schema-generator tests for every canonical alias and metadata merge
      path
- [x] Add parity tests proving identical CFC output for:
      inferred schemas, explicit `toSchema<T>()`, and explicit output schema
      bindings
- [x] Add integration tests for UI helper parity across compile-time rewriting,
      builder/runtime helper rendering, and `[UI]` schema synthesis
- [x] Add end-to-end tests that exercise runner observe-mode and fail-closed
      behavior for trust-sensitive claims emitted by the authoring surface
- [x] Add fixture coverage for `OpaqueInput<T, Spec>` lowering to `ifc.opaque`

### 8. Rollout Order

- [x] Land the contract docs and public API surface first
- [x] Land schema-generator lowering for the canonical alias set next
- [x] Land `WriteAuthorizedBy` diagnostics and cross-stage identity plumbing
- [x] Land the UI helper vertical slice as one coordinated transformer,
      schema-injection, and runtime-helper change
- [x] Land runner-aligned acceptance tests before treating the authoring surface
      as complete
- [x] Publish author guidance only after the inferred and explicit schema paths
      are demonstrably equivalent

## Done Means

This plan is complete when all of the following are true:

- authors can express the supported CFC schema metadata using the canonical
  TypeScript surface
- friendly sugar expands back to the canonical surface without changing
  semantics
- JSX helpers lower to deterministic runtime `data-ui-*` attributes and schema
  `ifc.uiContract` hints
- `WriteAuthorizedBy` has a strict diagnostic contract and a defined handoff to
  the runner's identity model
- inferred and explicit schema authoring paths produce stable, equivalent CFC
  output
- the emitted schema shapes align with the runner plan's persistence,
  enforcement, and provenance requirements
- tests cover both authoring-time behavior and the lower-layer integration
  points this plan depends on
