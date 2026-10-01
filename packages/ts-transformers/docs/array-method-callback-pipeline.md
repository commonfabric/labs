# Array-method callback pipeline

_Reference doc for the transformer pipeline as it processes reactive
`arr.map((elem) => …)` and `filter` / `flatMap` callbacks, plus `count` /
`minBy` / `maxBy` callbacks on explicit array-valued cells._

## Pipeline order

The pipeline driver in `src/cf-pipeline.ts` runs transformers in a fixed order.
The stages relevant to array-method callbacks are:

```
1.  CastValidationTransformer
2.  EmptyArrayOfValidationTransformer
3.  OpaqueGetValidationTransformer
4.  PatternContextValidationTransformer
5.  MergeablePushValidationTransformer
6.  VerbReturnValidationTransformer          ← validation-only; not array-method
                                                related
7.  IndirectBuilderCallbackValidationTransformer
                                             ← validation-only; not array-method
                                                related
8.  CfcPolicyAuthoringTransformer
9.  CfcPolicyOfValidationTransformer
10. JsxExpressionSiteRouterTransformer
11. AssertDiagnosticsTransformer             ← rewrites assert(...) bodies; not
                                                array-method related
12. LiftLoweringTransformer
13. ClosureTransformer                       ← lowers .map() to .mapWithPattern()
                                                + immediately runs the per-callback
                                                expression-site lowering
14. PatternOwnedExpressionSiteLoweringTransformer
15. HelperOwnedExpressionSiteLoweringTransformer
16. WriteAuthorizedByValidationTransformer
17. PatternCallbackLoweringTransformer       ← __cf_pattern_input.key(...)
                                                destructuring (ONLY for destructured
                                                first params)
18. SchemaInjectionTransformer
19. BuilderCallHoistingTransformer           ← hoists whole lift/handler calls and
                                                argument-position pattern(...) to
                                                module-scope consts, after schema
                                                injection (CT-1644/CT-1655; replaced
                                                the former BuilderCallbackHoisting +
                                                LiftHoisting pair, #3864)
20. SchemaGeneratorTransformer
21. VerbTierMarkTransformer                  ← verb listing marks (WS-F)
22. ReactiveVariableForTransformer
23. ModuleScopeShadowingTransformer
24. ModuleScopeCfDataTransformer
25. PatternCoverageTransformer               ← no-op unless coverage is enabled
26. ModuleScopeFunctionHardeningTransformer
```

A common misconception worth flagging up front:
`PatternCallbackLoweringTransformer` (stage 17) runs _last_ among the lowering
passes, not first. By the time it fires, expression-site lowering during
`ClosureTransformer` (stage 13) has already had its say. The
`key()`-substitution prologue it generates is downstream of the analyzer-driven
decisions about wrapping.

This document focuses on reactive collection calls that `ClosureTransformer`
rewrites. An ordinary eager `Array.map()` or `ReadonlyArray.map()` call remains
plain JavaScript, but a callback in a pattern body can still carry pattern-owned
value sites that stage 13 lowers. That permission is narrower than the
`plain-array-value` callback boundary: `isCollectingPlainArrayMethodCallback`
admits only argument zero of a `map` whose owner symbol includes the configured
TypeScript default-library `Array`/`ReadonlyArray` declaration. Same-named
source and ambient types do not qualify, and neither do result-interpreting
methods such as `filter`, `find`, `sort`, `flatMap`, or `reduce`.

## What `ClosureTransformer` does for `.map`s

`ClosureTransformer` walks the source tree and delegates each visited expression
to a strategy. The relevant one is `ArrayMethodStrategy`
(`src/closures/strategies/array-method-strategy.ts`). For each reactive
`arr.map(callback)` it dispatches to `transformArrayMethodCallback`
(`src/closures/strategies/array-method-transform.ts`).

That function does, in order:

1. `context.markAsArrayMethodCallback(callback)` — registers the callback in
   `mapCallbackRegistry`. This is the signal the dataflow analyzer (and other
   downstream consumers) uses to recognize element-param identifiers as opaque
   even when their TS type is plain.
2. `CaptureCollector.analyzeCurrentAndOriginal(callback)` — finds outer-scope
   reads to capture as `params: { … }`.
3. `analyzeElementBinding` (`array-method-utils.ts`) decides how to surface the
   element parameter. See "Two surface forms" below.
4. `ts.visitNode(callback.body, visitor)` — recurses into the body before the
   per-callback expression-site lowering runs. Nested array-methods in the body
   get transformed during this recursion (depth-first).
5. `expandCapturedObjectSpreads`
   (`src/closures/utils/captured-object-spread.ts`) writes out a spread of a
   captured `const` whose keys are known where it is declared (an object
   literal with static keys, a literal that spreads one, or an alias of one)
   as the properties it copies, read through the capture with `.key(...)`.
   Inside the new pattern a capture is an opaque reference, which has no keys
   to spread, so a spread of any other capture is reported as an error.
6. `createPatternCallWithParams` synthesizes the new shape:
   `array.mapWithPattern(pattern((destructured) => …), capturesObj)`.
7. `rewriteArrayMethodCallbackExpressionSites` (called from `createPattern…` via
   the strategy's `rewriteTransformedBody` option) runs over the transformed
   body to decide which expressions need lift-applied reactive wrapping and
   which can pass through.

The output of step 6 is a `pattern((destructured) => …)` call wrapping the
original body. The destructured parameter is one of two shapes depending on how
step 3 decided to surface the element binding.

## Surface forms and their treatments

`analyzeElementBinding` (`array-method-utils.ts`) classifies the source-level
callback parameter into one of three shapes, with three corresponding treatments
during `ClosureTransformer`. `PatternCallbackLoweringTransformer` sees only the
synthesized destructured `({element, …})` param and handles all three
identically as far as the key-prologue is concerned.

| Source form                                             | `ClosureTransformer` (stage 13)                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `(elem) => …elem.foo…`                                  | Identifier form. `bindingName = elem`, no aliases, body unchanged. Later passes (and our new analyzer hook) recognize `elem` as the element binding via `mapCallbackRegistry`.                                                                                                                                                                |
| `({piece, name}) => …` (plain object destructure)       | Destructure with no computed property names. `plan.aliases.length === 0`: the destructure binding passes through unchanged (no fresh `element` identifier synthesized). `PatternCallbackLoweringTransformer` sees the destructured param and generates a `key()` prologue (`const piece = __cf_pattern_input.key("element", "piece");` etc.). |
| `({[someKey]: alias, …}) => …` (computed property name) | Destructure with computed property names. Each computed access gets a fresh lift-applied alias keyed off `someKey`. A new `element` identifier is synthesized and the body is rewritten to reference the aliases. This is the rare case; most source destructures are plain identifier-form.                                                  |

In our fixture suite, identifier-form outnumbers destructured-form by roughly
10:1. Computed-property-name destructures are rarer still. The identifier-form
path is therefore the dominant one and the one most worth understanding deeply.

## How `elem.foo` becomes `elem.key("foo")`

For the identifier-form path, the late stages handle most of the lowering:

- During `ClosureTransformer` (stage 13), expression-site lowering decides
  whether each expression in the body needs an early lift-applied wrapper. The
  decision flows from `analyze(expression)` reporting `containsReactive` /
  `requiresRewrite` / `dataFlows`.
- Most `elem.foo`-style passthrough reads (inside `{elem.foo}` JSX, inside
  `[elem.foo]` array literals, etc.) are deliberately **not** wrapped at this
  stage. They flow through to `PatternCallbackLoweringTransformer`.
- During `PatternCallbackLoweringTransformer` (stage 17),
  `pattern-body-reactive-root-lowering` walks the body and rewrites `elem.foo`
  to `elem.key("foo")` in place. This is the cheaper form — it gives the runtime
  a fine-grained key path without pulling `elem` into a lift's inputs.

The decision during `ClosureTransformer` about whether to wrap is made by a gate
in `expression-site-lowering.ts:rewriteArrayMethodCallbackExpressionSites`:

- If the expression is a **passthrough container** (`PropertyAccess`,
  `ElementAccess`, `ObjectLiteral`, `ArrayLiteral`) AND every relevant dataflow
  is rooted at an array-method element binding (no captures of outer reactive
  values like `labelPrefix` or `name`), the wrap is **skipped**. Late
  `PatternCallbackLoweringTransformer` lowering handles it in-place.
- Otherwise — computations like `BinaryExpression`, mixed dataflows that include
  outer captures, etc. — the early wrap fires. The synthesized lift-applied
  computation then includes the element-rooted dataflows as **partial-key
  entries** in its inputs object: `{ elem: { foo: elem.key("foo") } }`, matching
  the runtime's preferred subscription shape.

## Why the dataflow analyzer needs an explicit signal

The analyzer (`src/ast/dataflow.ts`) decides reactivity from the TypeScript type
at each expression. For a direct `Reactive<T>` reference, the type itself says
"this is reactive."

The synthesized array-method-callback element parameter is **deliberately not**
typed as `Reactive`. `SchemaFactory.createArrayMethodCallbackSchema`
(`src/closures/utils/schema-factory.ts`) types `element` as the plain user
element type `T`. Downstream consumers (capability summary analysis,
type-shrinking, schema generation) need the plain type — widening to
`Reactive<T>` would break their assumptions.

So the analyzer needs an out-of-band signal that `elem` is implicitly opaque
even when its TS type is plain. That signal is the
`isArrayMethodElementBindingReference` hook on the dataflow analyzer:

- `TransformationContext.isArrayMethodElementBindingReference(identifier)` walks
  the identifier's declaration to its enclosing function-like and checks whether
  that function is in `mapCallbackRegistry`. If yes, the identifier is
  reads-as-opaque.
- The analyzer's identifier branch returns the same opaque shape it returns for
  a direct `Reactive` when the hook says yes.
- The analyzer's property-access branch (when the recursive analysis of the
  target returns `containsReactive: true` and the leftmost identifier is an
  element binding) records the full property access as a dataflow — not just the
  root identifier — so lift-applied input builders can emit the partial-key
  inputs shape `{ elem: { foo: elem.key("foo") } }`.

## Cache invalidation contract

The hook depends on `mapCallbackRegistry` being populated before any analyzer
query that consults it. The pipeline guarantees this because
`ClosureTransformer` calls `markAsArrayMethodCallback(callback)` before
recursing into the body. But the analyzer maintains a per-expression cache, and
`JsxExpressionSiteRouterTransformer` / `LiftLoweringTransformer` can analyze
expressions in the body before `ClosureTransformer` marks the callback.

`TransformationContext.#invalidateReactiveAnalysisCaches()` is called by each
`mark*` method on the context. It drops three things:

- `#reactiveContextCache`
- `#relevantDataFlowCache`
- `#dataFlowAnalyzer` (the analyzer instance itself, including its internal
  per-expression cache, via `closure-state reset`)

See `src/core/mod.ts` for the full registry contract.

## Key code pointers

| Concern                                                    | File                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Pipeline order                                             | `src/cf-pipeline.ts`                                                                         |
| Closure array-method strategy entry                        | `src/closures/strategies/array-method-strategy.ts`                                           |
| Per-callback closure transform                             | `src/closures/strategies/array-method-transform.ts`                                          |
| Element binding analysis (identifier vs destructured)      | `src/closures/strategies/array-method-utils.ts`                                              |
| Synthesized pattern callback's typed shape                 | `src/closures/utils/schema-factory.ts`                                                       |
| Plain-array `map` callback value-site permission           | `src/policy/callback-boundary.ts` + `src/ast/call-kind.ts`                                   |
| `ClosureTransformer` per-callback expression-site lowering | `src/transformers/expression-site-lowering.ts` (`rewriteArrayMethodCallbackExpressionSites`) |
| The defer-to-late-lowering gate                            | `src/transformers/expression-site-lowering.ts` (`shouldDeferToLateInPlaceLowering`)          |
| Dataflow analyzer identifier + property-access branches    | `src/ast/dataflow.ts` (around lines 700-900)                                                 |
| Element-binding hook on context                            | `src/core/context.ts` (`isArrayMethodElementBindingReference`)                               |
| Late `key()`-rewrite pass                                  | `src/transformers/pattern-body-reactive-root-lowering.ts`                                    |
| Cache invalidation contract                                | `src/core/mod.ts`                                                                            |
