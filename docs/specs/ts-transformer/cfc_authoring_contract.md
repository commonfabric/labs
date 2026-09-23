# CFC Authoring Contract

**Status:** Implemented direct-authoring contract
**Scope:** `packages/api`, `packages/ts-transformers`,
`packages/schema-generator`

This document specifies the compile-time contract for CFC-aware TypeScript
authoring. It is intentionally narrower than the runner CFC specs: the concern
here is how authored types and JSX lower into schema metadata and helper calls.

## Source Of Truth

This document is normative for the CFC-specific TypeScript authoring surface.

Related contracts:

- `docs/specs/ts-transformer/cfc_ui_helper_contract.md`
- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`

## Goals

- Give authors a type-level way to express CFC metadata without hand-writing
  raw `ifc` JSON for common cases.
- Keep lowering deterministic across `toSchema<T>()`, inferred `pattern()`
  schemas, and explicit `pattern(..., outputSchema)` paths.
- Preserve implementation identity where the schema must refer back to a local
  binding, especially for `WriteAuthorizedBy`.
- Preserve the defining module identity and exact compiler-emitted manifest
  digest for `PolicyOf<typeof rules>`.

## Non-Goals

- Model every possible CFC construct as TypeScript sugar.
- Infer arbitrary runtime expressions into schema metadata.
- Treat the transformer as a trust boundary.

## Canonical Surface

### Base Carrier

The canonical compiler-facing carrier is:

```ts
type Cfc<T, Meta> = T & {
  readonly __ct_cfc__?: Meta;
};
```

`Cfc<T, Meta>` must preserve the runtime/schema shape of `T` and only add to
the emitted `ifc` metadata.

### Path-Bearing Helpers

Projection-like constructs must preserve path identity, not only the projected
value type.

Canonical helpers:

```ts
type Ref<Root, Path extends readonly string[]> = {
  readonly __ct_ref_root__?: Root;
  readonly __ct_ref_path__?: Path;
};

type PathValue<Root, Path extends readonly string[]> = unknown;
type RefValue<SourceRef> = unknown;
type CanonicalPointer<Path extends readonly string[]> = `/${string}`;
```

### Supported Alias Set

The implementation must keep the supported alias list synchronized across the
public API, transformer diagnostics, and schema-generator formatter support.

Canonical alias set:

- `Cfc`
- `Confidential`
- `Integrity`
- `AddIntegrity`
- `RepresentsCurrentUser`
- `AuthoredByCurrentUser`
- `RequiresIntegrity`
- `MaxConfidentiality`
- `AnyOf`
- `PolicyOf`
- `WriteAuthorizedBy`
- `TrustedActionWriteWithIntegrity`
- `TrustedActionWrite`
- `TrustedActionUiContract`
- `ExactCopy`
- `ProjectionPath`
- `ProjectionOf`
- `Projection`

Friendly aliases may expand to those forms, but the formatter contract is keyed
to this canonical set.

The former `OpaqueInput`, `LengthPreservedFrom`, `FilteredFrom`, `SubsetOf`,
and `PermutationOf` aliases were removed: they lowered to `ifc.opaque` /
`ifc.collection`, which the runner rejects fail-closed as unsupported
trust-sensitive claims, so the authoring surface advertised capabilities that
could only ever fail at commit. Reintroduce them together with the runner
enforcement for the spec's §8.5 collection and §8.13 opaque-input transitions.
A raw `Cfc<T, { opaque: ... }>` / `Cfc<T, { collection: ... }>` payload still
lowers verbatim through the base-carrier rule below (and still fails closed at
commit) — the carrier copies any payload; only the canonical promises are
gone.

## Lowering Rules

### `Cfc<T, Meta>`

- Lower the base schema exactly as if `T` had been authored directly.
- Evaluate `Meta` as a type-level object/tuple/literal payload.
- Merge the evaluated metadata into `schema.ifc`.
- If the base schema already contains `ifc`, the metadata combines with it key
  by key rather than replacing the schema object. `confidentiality` lists join,
  the base schema's atoms first and each atom once. Any other key both declare
  must be declared alike, or lowering fails.
- Where the base schema is a `$ref` to a definition carrying `ifc`, the `ifc`
  written beside the `$ref` also carries the labels of every definition its
  reference chain reaches, because resolving the reference replaces the
  definition's `ifc` with it. They combine by the same rule with the
  definitions as the inner declarations: the farthest definition's
  `confidentiality` atoms first and the reference's own last. The mapping
  spec's §11 (`docs/specs/schema-generator/ts_to_json_schema_mapping.md`) has
  the details.

### Simple Wrapper Aliases

These aliases lower to direct `ifc` keys:

- `Confidential<T, X>` -> `ifc.confidentiality = X`
- `Integrity<T, X>` -> `ifc.integrity = X`
- `AddIntegrity<T, X>` -> `ifc.addIntegrity = X`
- `RequiresIntegrity<T, X>` -> `ifc.requiredIntegrity = X`
- `MaxConfidentiality<T, X>` -> `ifc.maxConfidentiality = X`
- `ExactCopy<T, P>` -> `ifc.exactCopyOf = P`

### `AnyOf<X>`

`AnyOf<readonly [A, B, ...]>` is valid only inside a confidentiality tuple and
lowers to one `{ anyOf: [A, B, ...] }` clause. Without the wrapper,
`Confidential<T, readonly [A, B]>` emits two conjunctive clauses. The wrapper is
therefore an explicit weakening and should be used only when any one listed
alternative is sufficient. Runtime authored-OR validation remains authoritative
for forbidden alternative families.

### `PolicyOf<typeof rules>`

`PolicyOf` is a compiler-bound reference to a static exported
`exchangeRules([...])` declaration. The argument must be a direct `typeof`
query. The CFC policy validation pass rejects plain objects, computed
expressions, non-exported bindings, the wrong artifact kind, and unresolved
imports.

Schema generation first emits an internal binding marker. The schema transformer
then replaces it with an exact module-policy atom containing the defining
module identity, defining export symbol, compiler-emitted policy digest, and
`{ __ctOwningSpace: true }`. Imported and pinned `cf:` bindings retain the
dependency's defining identity; they never acquire the importer's identity.

### Projection Helpers

- `ProjectionPath<T, From, Path>` lowers to
  `ifc.projection = { from: From, path: Path }`.
- `ProjectionOf<Root, PathTuple>` lowers to
  `ifc.projection = { from: "/", path: encode(PathTuple) }`.
- `Projection<Ref<Root, PathTuple>>` lowers identically to `ProjectionOf`.

Path tuple encoding rules:

- each segment must be a string literal at compile time
- `~` escapes to `~0`
- `/` escapes to `~1`
- `[]` encodes to `/`
- otherwise encode as `/${segments.join("/")}`

### `WriteAuthorizedBy<T, typeof binding>`

`WriteAuthorizedBy` is special because the emitted schema must refer to a local
implementation binding, not a plain JSON value.

Normative behavior:

1. The second type argument must be a direct `typeof ...` query.
2. The queried root binding must be declared in an authored module: the
   source file itself, or a module it imports, through any re-export. A
   declaration file cannot declare a writer.
3. Supported binding declarations are intentionally narrow:
   - a variable initialized from `handler(...)`
   - a variable initialized from `module(...)`
   - a variable initialized from `requireEventIntegrity(...)`
   - any of the three called on a Common Fabric module's namespace
     (`cf.handler(...)` after `import * as cf`, or a namespace an authored
     module re-exports); a member of any other object, including a named
     export of a Common Fabric module, is not a builder
   - a function declaration
4. The transformer must report `cfc-write-authorized-by` if any of the above
   conditions fail.
5. The schema-generator must preserve the declaring source and binding path in
   `__ctWriterIdentityOf`. The transformer maps the declaring compile name to
   the caller's authored file spelling. When `moduleIdentities` contains that
   defining source, the marker must also carry its content-addressed
   `moduleIdentity`, so engine-authored claims are stamped when minted.
6. If `moduleIdentities` is supplied but omits the defining source, compilation
   must fail instead of silently minting an unstamped claim.
7. The defining module gives the binding its runtime binding identity,
   whichever module wrote the claim: a claim in an importing module is
   verified against the writer's own module, never the importer's. The
   direct-root `toSchema<WriteAuthorizedBy<…>>()` path and nested claims
   resolve the binding to its declaration the same way.

One valid marker shape is:

```ts
// Shown for illustration only.
{
  __ctWriterIdentityOf: {
    file: "/authored/path.tsx",
    path: ["binding"],
    moduleIdentity: "cf:module/content-identity"
  }
}
```

`moduleIdentity` is absent for compatibility callers that do not supply source
identities and for aged stored claims. The marker is an implementation detail,
but the implementation still needs an equivalent cross-stage identity channel.

## Pipeline Contract

The CFC authoring path is not owned by one transformer. The relevant stage
ordering is:

1. `CfcPolicyAuthoringTransformer`
2. `CfcPolicyOfValidationTransformer`
3. `WriteAuthorizedByValidationTransformer`
4. `SchemaInjectionTransformer`
5. `SchemaGeneratorTransformer`

More precisely:

- `CfcPolicyAuthoringTransformer` validates static rule declarations, lowers
  them to inert values, and emits per-source manifests through cross-stage
  state rather than JavaScript exports.
- `CfcPolicyOfValidationTransformer` validates the narrow direct-`typeof`
  contract before schema generation.
- `SchemaInjectionTransformer` seeds `[UI]` member schema hints and constructs
  `toSchema<...>()` calls that preserve type/identity information.
- `SchemaGeneratorTransformer` evaluates CFC type metadata, resolves
  `PolicyOf` against the compiler manifest, rehydrates validated writer
  identity markers, and emits the final schema AST.

Reordering these stages changes behavior and is not allowed without updating
this spec.

## Alias Expansion And Type Evaluation

The formatter must be able to resolve simple type-alias indirection before it
decides whether a type is CFC-aware.

Required capabilities:

- resolve nested type aliases recursively
- substitute type parameters through alias expansion
- evaluate literal, tuple, array, and type-literal payloads
- preserve the base type when stripping the `Cfc` carrier intersection
- preserve wrapper erasure rules for `Reactive<T>` so a `Cfc<Reactive<T>, ...>`
  carrier lowers to the schema shape of `T` rather than inventing a separate
  runtime value shape

If alias expansion cannot resolve back to a supported form, lowering must fall
back to ordinary schema generation rather than inventing partial metadata.
Non-canonical aliases resolve only through explicit type arguments — defaulted
type parameters are not recovered outside the canonical set.

## Diagnostics

Required diagnostic type:

- `cfc-write-authorized-by`
- `cfc-policy-authoring`
- `cfc-policy-of`

Required failure modes:

- second type argument is not `typeof ...`
- target is declared in a declaration file, or not resolvable to a declaration
- target is not a supported handler/module-style binding
- policy declarations contain dynamic content, unsupported fields, unbound
  variables, missing guards, invalid exports, or rule reuse
- `PolicyOf` does not directly query an exported `exchangeRules` binding

## Current Limits

- `WriteAuthorizedBy` only supports bindings the checker resolves to a
  declaration in an authored module; dynamic lookup is rejected.
- Exchange-rule declarations use a closed static expression grammar and must be
  module-level exports.
- `PolicyOf` supports local, direct imported, and pinned `cf:` bindings; general
  dynamic/re-export discovery is intentionally rejected.
- `ConceptOf` and concept-default policy authoring are not implemented.
- Projection paths must be statically known string tuples.
- Metadata payload evaluation is limited to literal-like type syntax; arbitrary
  conditional or computed type programs are out of scope.
- The supported alias set is closed by name. New sugar needs explicit formatter
  support.

## Acceptance Coverage

The contract is not fully implemented until these tests pass or equivalent
coverage exists:

- `packages/ts-transformers/test/cfc-authoring.test.ts`
- `packages/schema-generator/test/schema/cfc-authoring.test.ts`
