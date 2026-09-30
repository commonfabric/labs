# `wish(...).result` lowering: conclusions and take-forwards

This document captures the load-bearing conclusions from the work that landed in
PR #3567 and the design decisions that future contributors should know about.
Investigation history lives in the PR commits and review thread; this is the
long-tail reference.

## What the transformer now handles

Source shapes that produce correctly-lowered output in a pattern body:

```ts
const w = wish<T>(...);                              // (1) two-step named
const x = w.result;

const { result } = wish<T>(...);                     // (2) single-level destructure
const { result: { pieceRegistry } } = wish<T>(...);  // (3) nested destructure

const x = wish<T>(...).result;                       // (4) one-line direct
const x = wish<T>(...).result.pieceRegistry;         // (5) one-line chained
const { pieceRegistry } = wish<T>(...).result;       // (6) one-line + destructure
const { pieceRegistry } = wish<T>(...).result!;      // (7) with non-null assertion
const { pieceRegistry } = (wish<T>(...) as U).result; // (8) with cast
```

Shapes (4)–(8) are handled by a pre-pass (`rewriteInlineReactiveOriginChains`)
that rewrites them into the equivalent nested-destructure form (2)/(3) before
the body walker runs. The existing destructure machinery then handles the rest.

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

So `(wish(...) as { result: T }).result` rewrites to
`const { result } = wish(...) as { result: T }` — the cast survives.

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

### Nested `computed(() => ...)` walker gap

The body-walker doesn't descend into nested `computed(...)` callbacks. So shapes
like:

```ts
const fromWish = computed(() => {
  const foo = wish<T>(...).result!;        // not lowered
  return foo.map(...);                     // works anyway via Reactive proxy
});
```

…stay as plain JS access at compile time. The `foo.map(...)` lowering still
works because the Reactive proxy at runtime returns a cell for `.result`, and
`.map`/`.mapWithPattern` work on cells. So in practice the lowering gap is
silent. Producing correct lowered output here would require either extending the
walker to descend into `computed(...)` callbacks (alongside the existing
`derive(...)` descent) or routing them through the same expression-site
machinery. Not in scope for this branch.

Fixture: `closures/map-regains-reactive-aliases` documents this case.

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
