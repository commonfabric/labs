# `wish(...).result` lowering: conclusions and take-forwards

This document captures the load-bearing conclusions from the work that landed in
PR #3567 and the design decisions that future contributors should know about.
Investigation history lives in the PR commits and review thread; this is the
long-tail reference.

## What the transformer now handles

Source shapes that produce correctly-lowered output in a pattern body:

```ts
const state = wish<T>(...);                          // (1) two-step named
const request = state.result;                        // AsyncResult<T>
const value = resultOf(request);                     // usable T

const { result: request } = wish<T>(...);             // (2) destructured request
const value = resultOf(request);

const request = wish<T>(...).result;                 // (3) one-line request
const value = resultOf(request);
```

Shape (3) is handled by a pre-pass (`rewriteInlineReactiveOriginChains`) that
rewrites it into the equivalent destructure form (2) before the body walker
runs. The existing destructure machinery then handles the rest. Do not chain
through `.result` as though it were `T`: Wish now exposes `AsyncResult<T>`, and
`resultOf()` is the explicit usable-value projection.

## Design decisions worth knowing

### 1. `.for(<bindingName>, true)` is attached to each destructured leaf, not to the synthesized root

When the destructure root is a fresh opaque-origin call
(`isOpaqueOriginCall(initializer)`), each named leaf gets
`.for(<localName>, true)` attached to its `.key(...)` chain. Why:

- The leaf shares its `_causeContainer` with the synthesized root and all
  siblings, so naming the leaf names the whole container.
- `allowIfSet: true` makes multi-binding destructures
  (`const { a, b } = wish(...)`) order-deterministic: the first leaf in source
  order wins, the rest are no-ops.
- Honest to user intent — the user wrote `const { pieceRegistry } = wish(...)`,
  so the cell takes its identity from `pieceRegistry`, the name they actually
  chose. The synthesized `__cf_destructure_N` is invisible scaffolding.
- Avoids a regression we hit when attaching `.for(...)` to the root:
  `isOpaqueSourceExpression` didn't recognize `<opaque>.for(...)` as a source,
  so downstream walker tracking broke.

Without this cause attachment, the cell falls back to a generated internal
`partialCause`. That avoids collisions with user-provided names, but the
generated cause can still drift when surrounding generated cells change,
invalidating any persisted state keyed on the old generated cause. See
`packages/runner/test/pattern.test.ts:101-128` for the generated-cause behavior.

### 2. `.for(...)` is only attached when the root is a FRESH opaque origin

Scoping via `isOpaqueOriginCall(initializer)` excludes:

- `const { x } = alreadyNamed.key(...)` — container already has identity via
  `alreadyNamed`.
- `const sn = spot.key("spotNumber")` inside map callbacks — pattern-input
  identity flows down.

For those cases, adding `.for(...)` would be a silent no-op via `allowIfSet`,
but clutters generated code and gives a false impression that the leaf controls
identity.

### 3. The pre-pass preserves casts/satisfies, drops parens/non-null

Within a chain rewrite, the helper `stripSyntacticWrappers` strips parens and
non-null assertions (purely syntactic — no runtime effect, no type information)
but preserves `as T` and `satisfies T` (load-bearing type information that
downstream passes like schema injection use).

So `(wish(...) as { result: AsyncResult<T> }).result` rewrites to
`const { result } = wish(...) as { result: AsyncResult<T> }` — the cast
survives. A non-null assertion is only syntactic; it does not remove
`DataUnavailable` variants and is not a substitute for `resultOf()`.

### 4. The inline diagnostic is kept as a fallback

`pattern-context:inline-reactive-root-access` still exists to catch shapes the
rewrite doesn't handle:

- Element-access chains with computed keys (`wish(...).foo[expr]`).
- Chains inside non-rewritten contexts (free-floating expressions, nested
  `computed(() => ...)` callbacks — see "Open issues" below).

The diagnostic skips only the legitimate cell-method invocation shape:
PropertyAccess whose immediate receiver is itself a reactive-origin call
(`Writable.of(...).for(...)`, `wish(...).key(...)`). It deliberately does NOT
skip chains like `wish(...).result.get()` — there `.result` defeats reactivity
and `.get()` reads off plain JS.

### 5. `isOpaqueSourceExpression` is the load-bearing predicate

Multiple consumers (`buildPatternScope` in `pattern-callback-lowering`, the
body-walker's dynamic tracking, `collectLocalOpaqueRootSymbols`) use this
predicate to decide whether a binding's initializer makes it an opaque source.
Two additions to keep it honest:

- Sees through `.for(...)` calls (identity-preserving like `.key`/`.get`).
- Sees property/element-access chains bottoming on an opaque-origin call (the
  same shape the rewrite catches; useful for consumers that examine the AST
  before the rewrite has run).

## Open issues / out-of-scope

### Nested `computed(() => ...)` factory placement

The `wish()` factory belongs in the pattern body. It cannot be created directly
or through a helper inside `computed()`, `lift()`, `action()`, or `handler()`
callbacks. Capture the request or its usable projection in `computed()`:

```ts
const state = wish<T>(...);
const request = state.result;
const value = resultOf(request);
const derived = computed(() => value.items.map(...));
```

Creating the Wish inside an execution callback is rejected with
`compute-context:local-reactive-use`, including at sites whose downstream array
method can otherwise be lowered. `map-regains-reactive-aliases` keeps its Wish
projection outside the compute and verifies that capturing the projection still
regains the reactive array alias for pattern-owned callback lowering.

### Element-access terminals with computed keys

`wish(...).foo[someExpr]` can't be rewritten into a destructure pattern cleanly
(numeric/computed positions don't fit `{ foo: { 0: x } }` style). These are
caught by the diagnostic as a fallback. If they become common, the rewrite could
be extended or path B (in-place `.key(...)` lowering) could be added alongside.

### Pre-existing type errors in production patterns

`chat-note.tsx` had a pre-existing typecheck failure on `main` (unrelated to
this work) that PR #3578 cleared. The shape was `const { x } = wish(...).result`
— destructuring directly off `T | undefined` from the wish result type. The fix
is `.result!` to assert non-null.

## Files of interest

- `packages/ts-transformers/src/transformers/pattern-body-reactive-root-lowering.ts`
  — pre-pass rewrite (`rewriteInlineReactiveOriginChains`), destructure
  lowering, leaf-cause attachment, diagnostic.
- `packages/ts-transformers/src/transformers/opaque-roots.ts` —
  `isOpaqueSourceExpression`, `isOpaqueOriginCall`. The shared predicates.
- `packages/runner/src/cell.ts` — `.for(cause, allowIfSet)` and cell identity
  via `_causeContainer`.
- `packages/runner/src/builder/pattern.ts` — `getStableInternalPathSegment` and
  the path-assignment loop that uses cell causes.
