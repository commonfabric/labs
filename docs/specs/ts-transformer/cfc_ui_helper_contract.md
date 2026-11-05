# CFC UI Helper Contract

**Status:** Contract — implemented (#3263, 2026-04-14): the rewrite lives in
`JsxExpressionSiteRouterTransformer` via
`src/transformers/ui-helper-lowering.ts` (there is no distinct
`CfcJsxTransformer` stage), schema hints flow through `SchemaInjection` into
`ifc.uiContract` at schema generation. Two notes beyond this document's
letter: (a) a non-literal `as` prop silently falls back to the helper's
default tag; (b) the shipped `uiContract` hint carries two additional fields —
`trustedPattern` and `requiredEventIntegrity` — fed by the
`TrustedActionUiContract` alias (type-level, not JSX). See the behavior spec
§6.8/§7.1.\
**Scope:** `base/api`, `base/ts-transformers`,
`base/schema-generator`, runner UI builder/runtime integration

This document specifies the compile-time and builder-time contract for the CFC
UI helpers. These helpers are authoring sugar for trusted
UI contracts; they are not generic component macros. The helpers do not mint
final CFC integrity atoms by themselves. Instead, they lower into schema-time UI
contract hints plus `data-ui-*` runtime markers that trusted renderer/runtime
code later combines with concrete provenance data to mint the normative atoms.

## Source Of Truth

This document is normative for the CFC-specific UI helper surface.

Related contracts:

- `docs/specs/ts-transformer/cfc_authoring_contract.md`
- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`

## Recognized Helpers

The helper set is closed and explicit.

| Helper | Default emitted tag | Semantic props | Emitted data attrs | Emitted schema hint | Normative runtime bridge |
| --- | --- | --- | --- | --- | --- |
| `UiAction` | `ct-button` | `as`, `action` | `data-ui-action` | `{ helper: "UiAction", action }` | lets trusted UI/runtime bind gesture targets to a named action without introducing a helper-specific atom into stored integrity |
| `UiPromptSlot` | `ct-textarea` | `as`, `surface`, `role` | `data-ui-surface`, `data-ui-role` | `{ helper: "UiPromptSlot", surface, role }` | lets trusted UI/runtime mint concrete `UserSurfaceInput` and `PromptSlotBound` atoms when a user submits/binds a value through the slot |
| `UiDisclosure` | `ct-card` | `as`, `kind` | `data-ui-disclosure-kind` | `{ helper: "UiDisclosure", kind }` | lets trusted UI/runtime mint disclosure-related atoms such as rendered-warning / acknowledgment evidence without inventing helper-only atoms |

Adding a new helper requires coordinated changes across API exports, JSX
rewriting, schema hint synthesis, and builder/runtime helper code.

## JSX Rewrite Contract

`JsxExpressionSiteRouterTransformer`, through
`src/transformers/ui-helper-lowering.ts`, owns the compile-time rewrite.

Given a recognized helper element:

1. Replace the helper tag with the intrinsic tag from `as` or the helper's
   default tag.
2. Remove helper-only props from the semantic prop bag.
3. Preserve all non-helper props and all children.
4. Re-emit the semantic props as `data-ui-*` attributes on the intrinsic node.

Example:

```tsx
// Shown for illustration only.
<UiAction action="SubmitDirectCommand" onClick={submit}>Go</UiAction>
```

lowers to:

```tsx
// Shown for illustration only.
<ct-button data-ui-action="SubmitDirectCommand" onClick={submit}>Go</ct-button>
```

The builder/runtime helper implementation must emit the same runtime shape so
authored use and transformed use converge.

## Schema Hint Contract

The helper rewrite also has a schema side effect.

When the helper's required semantic props are compile-time string literals,
The router must attach a node-local schema hint of the form:

```ts
// Shown for illustration only.
{
  cfcUiContract: {
    helper: "UiAction" | "UiPromptSlot" | "UiDisclosure";
    // helper-specific literal fields
  }
}
```

This is compile-time-only metadata. It does not change the JSX runtime value,
and it is intentionally not itself a final integrity atom. The final atoms are
minted later by trusted runtime code once concrete user, value-digest, source
reference, kernel, render-frame, and acknowledgment details are known.

## Literal Versus Non-Literal Inputs

This distinction is part of the contract:

- If the relevant helper props are present at all, the rewritten JSX still gets
  the corresponding `data-ui-*` attributes.
- If those props are not literal strings, no compile-time `uiContract` hint
  may be synthesized for the schema.

In other words:

- runtime DOM/VNode tagging works with dynamic expressions
- schema-level UI contract hints only exist for statically known literals

That asymmetry is intentional and must be documented in user-facing guidance.

## Normative Runtime Bridge

The UI helpers exist to seed trusted runtime evidence using the registered CFC
atoms already used elsewhere in the spec.

- `UiPromptSlot(surface, role)` does not directly add integrity. Instead, it
  marks a UI subtree so trusted renderer/runtime code can later mint:
  - `UserSurfaceInput { user, surface, valueDigest, snapshotDigest? }` when a
    user submits a concrete value through that surface
  - `PromptSlotBound { source, role, kernelName, subject?, surface }` when a
    trusted kernel binds that submitted value into a prompt slot
- `UiAction(action)` marks a concrete gesture/action target. Trusted
  renderer/runtime code combines that with render-frame/gesture provenance to
  derive the correct semantic event. The helper does not introduce a
  helper-specific persistent atom.
- `UiDisclosure(kind)` marks disclosure/acknowledgment UI. Trusted
  renderer/runtime code later turns actual rendered and acknowledged disclosures
  into the appropriate registered atoms such as rendered-warning,
  acknowledgment, or disclaimer-attached evidence.

This bridge is the load-bearing alignment point: the helper contract is only
valid if its emitted schema hints can be consumed to produce the normative atom
shapes that the runner and policy specs already understand.

## `[UI]` Schema Synthesis Contract

`SchemaInjectionTransformer` is responsible for turning returned JSX into a
schema hint for the result type's `[UI]` member.

Required behavior:

1. Find the JSX subtree returned from the pattern builder's `[UI]` property.
2. Find the corresponding `[UI]` property type node on the output type.
3. Synthesize a VNode-like schema for the returned tree.
4. Copy any node-local `cfcUiContract` hints onto the matching synthesized
   schema nodes as `ifc.uiContract`.

The synthesized shape is a recursive VNode object with:

- `type`
- `name`
- `props`
- `children`

and render-leaf fallbacks for text/expressions.

## Explicit Output Schema Parity

A failure mode to avoid is inferred output schemas and explicit
`pattern(..., explicitOutputSchema)` calls receiving different `[UI]` helper
hints.

Normative rule:

- if `pattern()` has a statically recoverable output type and a returned JSX
  subtree for `[UI]`, then `[UI]` schema hint seeding must happen regardless of
  whether the final output schema is inferred inline or supplied explicitly via
  a `toSchema<Output>()` binding

This rule is why JSX helper rewriting and schema hint seeding have to be
implemented as one slice.

## Builder Contract

The builder/runtime helper implementation must mirror the compile-time helper
shape:

- same default tags
- same `data-ui-*` attributes
- same omission of helper-only props from the residual prop bag
- same child normalization

The builder helpers do not enforce trust. They only preserve the semantic shape
that the runner and renderer later consume when matching runtime DOM/VNode
output against `ifc.uiContract` hints.

## Out Of Scope

- Trust-lattice evaluation of the emitted integrity atoms
- Renderer provenance frames and event minting details
- Arbitrary user-defined helper recognition

Those belong to runner/UI specs, not this authoring contract.

## Acceptance Coverage

The contract is not fully implemented until these tests pass or equivalent
coverage exists:

- `base/ts-transformers/test/cfc-authoring.test.ts`
- `base/ts-transformers/test/cfc-ui-helper.test.ts`
- `runtime/runner/test/cfc-ui-contract.test.ts` and the `cfc-*` integration
  suites (the originally named
  `patterns/integration/cfc-ui-direct-command.test.ts` does not
  exist)
