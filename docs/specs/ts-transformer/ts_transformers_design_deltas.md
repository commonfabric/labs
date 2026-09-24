# TS Transformers Design Deltas

**Status:** Partially implemented (status snapshot)\
**Date:** March 17, 2026\
**Companion:**
`docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`

## Purpose

Track intentional behavior deltas, what has landed, and what remains relative to
the current implementation.

This document is a mixed roadmap/status artifact. It includes both landed
behavior and open follow-up work.

## Delta Backlog

### Collection index selectors

Explicit array-valued cells expose `groupBy` and `keyBy`, returning typed index
handles with per-key lookup. Their one-element callbacks preserve Cell identity
by tagging the evaluated key before serialization. Index and whole-array
callback parameters remain outside this API. Ordinary array-typed inputs do not
expose these methods through the public types. See the
[index documentation](../../features/collection-indexes.md).

### Named collection aggregates

Explicit array-valued cells expose `count`, `sum`, `min`, `max`, `minBy`, and
`maxBy`. Predicate and score callbacks use the collection callback pipeline,
including cell receivers inside computations. Extending the methods to ordinary
array-typed inputs and mapped-array results remains separate work: the public
`Reactive<T>` alias is still `T`. See the
[aggregate contracts](../../features/collection-aggregates.md).

## Implementation Snapshot (March 17, 2026)

- Landed:
  - single transform pipeline (legacy `useLegacyReactiveSemantics`
    flag removed)
  - unified context classifier (`pattern` / `compute` / `neutral`)
  - provenance-first Common Fabric call detection with shadowed-helper rejection
    and narrow synthetic/ambient fallback paths
  - deterministic JSX logical lowering policy (`&&` / `||`) by context
  - helper-owned ternary / conditional branches re-analyzed under synthetic
    compute ownership
  - `.map` rewrite matrix by `{context, receiverKind}`
  - local reactive rewrap aliases in compute callbacks can re-enter collection
    rewrite eligibility
  - pattern callback canonicalization and `key(...)` lowering
  - local opaque-root rewriting inside lift-applied callbacks
  - capability analysis with path/capability shrinking at schema boundaries
  - additive wrapper support for `ReadonlyCell` / `WriteonlyCell` / `OpaqueCell`
  - structural reactive-origin detection for `.get()` validation and opaque-root
    classification even when `Reactive<T>` is an identity alias
  - static destructuring default initializer lowering to schema defaults
  - array destructuring lowering in pattern/map callbacks
  - wildcard classification includes `for...of` over tracked sources
  - empty-array cell-factory validation (`cell-factory:empty-array`)
  - schema-generator distinguishes `unknown` from `any`, preserves synthetic
    `unknown` union members, and no longer emits `asOpaque`
  - schema-generator synthetic union parity for `undefined` members
  - map capture classification hardened for reactive vs non-reactive captures
  - pattern-boundary schema continuity alignment (defaults-only application
    mode)
  - schema shrink coverage validation (`schema:unknown-type-access`,
    `schema:path-not-in-type`)
  - schema shrink validation for declared `unknown`-typed properties
  - array item shrinking to `unknown` when only non-item properties (for
    example `.length`) are observed
  - projected-result / object-literal schema recovery for lift result
    inference
  - compute-context local reactive alias diagnostics
- Partially landed:
  - diagnostics migration (some legacy validation remains)
  - compute-context interprocedural capability summaries (MVP scope)
- Open:
  - collection-method generalization beyond current `.map` / `.filter` /
    `.flatMap` coverage (`.find`, `.some`, `.every`, etc.)
  - full diagnostics convergence onto lowerability-only checks

### Addendum (landed since the March 17 snapshot)

The `derive→lift→selfcontained` arc and content-addressed builder identity
landed after the snapshot above:

- Landed:
  - `derive`/`computed` → lift-applied lowering (Phase 1, CT-1615)
  - whole-builder-call hoisting to module scope for `lift` (CT-1644), then
    `handler`, `pattern`, and `patternTool` (CT-1655), via the single
    `BuilderCallHoistingTransformer` (current-behavior spec §11). The former
    lift-only `LiftHoistingTransformer` and the callback-only
    `BuilderCallbackHoistingTransformer` are both gone (the latter deleted in
    #3864).
  - content-addressed builder artifacts: a single trailing `__cfReg({ … })`
    registration per module (CT-1623), consumed by the runner's module-record
    compiler and `PatternManager` reverse index. Shipped and exercised across
    the builder-bearing fixture corpus.
- Open (forward-looking, NOT on `main`):
  - Phase 3 `selfcontained(...)` wrapping (CT-1654): wrap each hoisted builder
    const with `__cfHelpers.selfcontained(...)`. Blocked on a `selfcontained`
    runtime helper / `__cfHelpers` export that does not yet exist. Today
    `selfcontained` appears only in design comments in `ast/call-kind.ts` and
    `builder-call-hoisting.ts`; no transformer emits it and no fixture expects
    it. See `packages/ts-transformers/docs/derive-to-lift-design.md`.

### Addendum 4 (a plain-array `map` callback carries pattern-owned sites)

A `map` callback on an ordinary JavaScript array inside a pattern body now
carries pattern-owned expression sites, the same ones the pattern body carries.
`supportsPatternOwnedWrapperCallbackSite` (`policy/callback-boundary.ts`)
admits the `plain-array-value` boundary for that callback role, which
`isCollectingPlainArrayMethodCallback` (`ast/call-kind.ts`) decides.

The callback runs eagerly during pattern build, so its statements are pattern
body statements that happen to be written once and executed several times. A
value binding in one is therefore a pattern-body binding, and a reactive
computation bound there lowers to its own lift-applied call per iteration.

The permission stops at the callback's role, because the boundary kind alone is
too coarse to carry it. `plain-array-value` also covers `filter`, `find`,
`some`, `every`, `sort`, `flatMap`, and `reduce`, and each of those reads what
the callback returns while it runs — as a boolean, a number, an array test, or
the next accumulator. `map` is the one that merely collects. A lift returned to
a predicate is an object, so `filter` keeps every element and `find` matches
the first; those callbacks therefore keep the diagnostic. The test that admits
a callback also requires it to be argument zero of a method whose owner symbol
includes the configured default-library `Array`/`ReadonlyArray` declaration, so
a comparator in a later argument position, a same-named source or ambient type,
and a `map` belonging to some other type are all excluded.

Two behaviors change:

- A binding such as `const isToday = weekDates?.[colIdx] === todayDate` inside
  `COLUMN_INDICES.map((colIdx) => …)` lowers. Previously the comparison was
  emitted raw, so it ran on the reactive proxies rather than their values and
  froze to `false`. Reading the binding as a JSX condition then rendered the
  wrong branch with no diagnostic, because the JSX exemption in
  `isInRestrictedReactiveContext` suppresses the "wrap it in `computed()`"
  errors that the same binding draws outside JSX.
- `pattern-context:get-call` and `pattern-context:optional-chaining` no longer
  fire for a read that a `map` callback's own value sites can carry, so
  `["-", "+"].map((sep) => rows.get().join(sep))` compiles to an array of
  per-separator lifts instead of being rejected. Both still fire in the
  result-interpreting callbacks.

A reactive array-method callback keeps the older, stricter rule, and the
difference is structural rather than stylistic: that callback is lowered into a
sub-pattern over per-element cells, so a `.get()` on the element binding has no
pattern-body site to become a lift.

This is P-011 applied to a boundary that had been drawn by the receiver's type
rather than by what the callback lowers to. Whether the mapped array is plain
says nothing about whether the values the callback closes over are reactive.

### Addendum 3 (`toJSON` is an ordinary member name)

`pattern-context:object-member` treats `toJSON` like any other member. A
`toJSON()` method or `toJSON:` function-valued property on an object literal in
pattern or render context is reported, whatever its body reads.

The rule previously exempted a `toJSON` member whose body read nothing
reactive, on the grounds that such an object was storable — the data model
converted a `toJSON`-bearing object by calling the method. It no longer does:
the conversion reads `toJSON` as the ordinary function-valued member it is, and
a record may hold no function. So the exemption admitted a member that compiles
and throws at its first write, and the body check it rested on
(`memberBodyReadsReactiveValue`) is gone with it.

This narrows the accepted language. Nothing in the corpus used the exemption.

### Addendum 2 (2026-07-10 phase-4 verification findings)

Language deltas found by adversarial verification of the target-language
matrix (implementation vs normative spec). Resolution status is recorded on
each finding:

- **Top-level eager-read carve-out (#3725, 2026-05-28) — resolved 2026-08-12 by
  ratifying the has-a-lowerable-site rule.** A `.get()` read on a
  `Cell`/`Writable`/`Stream` in pattern-owned context is part of the language
  wherever a lowerable expression site can carry it; that site lowers into a
  lift, which is what keeps the read live. The line is the site, not the shape
  of the read: a binding, a return, an object property, an array element, an
  argument, a computation over the read, and a call whose receiver chain
  reaches it are all accepted, terminal or not, and parentheses, the
  computed-key spelling, and the optional spellings do not change the
  classification. A read with no such site — statement position, or a
  reactive array-method callback, whose callback becomes a sub-pattern over
  per-element cells — remains outside the language, as does a read on a value
  that is not a cell. Addendum 4 carries the same reasoning into a plain-array
  `map` callback, which does supply a site; the array callbacks whose result
  the method reads as it runs do not.

  What settled it: the matrix already blessed the JSX spelling, so the earlier
  rule was really "no eager reads outside JSX" — which made extracting a JSX
  expression into a named binding change a program's legality. The rejection's
  main output was "wrap it in `computed()`" diagnostics that bred wrapper
  cascades in author code, against a platform direction of needing explicit
  `computed()` less often. Ratified in the target-language matrix and §5.7;
  lowering-contract §3.9's eager-read bullet now names the site-less read
  rather than the top-level read. Golden-pinned (`cell-get-binding-autowrap`,
  `cell-get-terminal-binding-autowrap`, `with-reactive`;
  `test/validation.test.ts:3179`).
- **Optional-call accepted in JSX and compute callbacks — resolved 2026-07-23
  by making optionality orthogonal to call support.** The earlier location
  split was an implementation leak, and the proposed blanket rejection would
  have removed valid authoring forms. Optional receiver and invocation forms
  now follow the same expression-site and call-root policy as the corresponding
  non-optional call. Supported sites lower the whole call and preserve
  receiver binding, nullish short-circuiting, and lazy argument evaluation;
  unsupported call roots remain unsupported for their existing reason.
  Function-valued reactive data remains outside the storable data model whether
  invoked with `()` or `?.()`.
  - **Carried-forward open sub-finding: no diagnostic enforces the
    function-valued-data boundary.** The earlier revision of this finding
    recorded that lift lowering drops function-typed captures from input
    schemas, so an invocation of a function value from reactive data compiles
    without diagnostics and is dead code at runtime (current-behavior spec
    §19.6). That behavior predates the orthogonality change for plain `()`
    calls and now uniformly covers `?.()` forms, which previously errored at
    top-level, statement, and collection-callback sites — as an accident of
    the removed optional-call bucket, not as a considered rejection of the
    callable-root family. The open decision is where enforcement belongs:
    a call-site diagnostic for callable roots that resolve to reactive-data
    function values (ts-transformers scope, diagnoses the symptom), a
    declaration-site diagnostic where schema generation drops a function-typed
    property (schema-generator scope, diagnoses the root cause and also
    catches stored-but-never-called function values), or both. Any
    enforcement must not fire for legal callable families: pattern factories,
    cell/stream-branded values, registered runtime exports, and module-scope
    captures. Decided 2026-07-23: the call-site diagnostic proceeds as
    CT-1905 (a corpus sweep found zero authored occurrences of the family,
    so error severity is safe); the declaration-site option stays open as a
    schema-generator design question (no diagnostics channel exists there
    today).
- **Residual pass-through emits runnable-looking output alongside errors.**
  Both documented bucket-4 forms are alive: `forEach`-in-JSX survives
  verbatim as plain JS and promise-`.then` gets compute-island-wrapped, in
  each case *in addition to* the reported error — a consumer that ignores
  diagnostics inherits residual semantics. Worth deciding whether error
  programs should emit at all.

## D-001 Rename Context Terms (`safe` -> `compute` / `pattern`)

**Current term:** `safe context` / `safe wrapper`\
**Proposed terms:**

- `compute context` for callbacks where values are being computed in a wrapped
  compute form (`computed`, `action`, `lift`, `handler`, etc.)
- `pattern context` for top-level pattern/render-style author code where
  parameters are opaque by default and direct computation should trigger
  guidance/rewrite

**Rationale:**

- `safe` is misleading; all code is sandboxed and untrusted.
- The distinction is semantic (opaque authoring context vs compute callback
  context), not security/trust.

**Acceptance criteria:**

1. User-facing docs and diagnostics stop using “safe context” terminology.
2. Internal naming may migrate incrementally, but external language should be
   context-accurate immediately.
3. Terminology clearly communicates _why_ computation rules differ by context.

## D-002 Context-Driven `&&` / `||` Lowering Policy In JSX

**Policy target:**

- In **compute context inside JSX**: do **not** lower `&&`/`||` to
  `when`/`unless`.
- In **pattern context inside JSX**: **always** lower
  - `a && b` -> `when(a, b)`
  - `a || b` -> `unless(a, b)`

**Rationale:**

- `&&`, `||`, and `?:` are all conditional/control-flow operators.
- Context should drive lowering policy, not heuristics like “right side is
  expensive.”
- Pattern context benefits from explicit runtime control-flow helpers.
- Compute context should preserve direct compute-expression author intent.

**Acceptance criteria:**

1. No heuristic gating for `&&`/`||` in pattern context JSX (always lower).
2. No `&&`/`||` lowering in compute context JSX.
3. Behavior is test-covered for nested/mixed logical expressions and ternary
   adjacency.

## D-003 Context-Driven Collection Operator Policy (`.map` / `.filter` / `.flatMap` first, then analogs)

**Status:** Mostly landed

**Policy target:**

- In **pattern context**: rewrite reactive collection operators to explicit
  reactive forms.
- In **compute context**: rewrite only when receiver type is in the
  non-auto-unwrapped cell-like set (`Cell`, `Writable`, `Stream`, etc.).
- In **compute context**, local aliases created inside the same callback may
  become reactive again when they re-wrap a reactive collection via
  `computed(...)`, `lift(...)`, `action(...)`, `handler(...)`,
  `wish(...)`, or an already-lowered reactive collection call.
- Never rewrite plain JS array operators.
- The callback parameter of `.map` is treated as a **pattern callback
  parameter** only in cases where the call is actually rewritten to
  `mapWithPattern`. If a `.map` is not rewritten, its callback parameter keeps
  ordinary compute/plain semantics.

**Currently landed operators:** `.map`, `.filter`, `.flatMap`\
**Future analogous operators:** `.find`, `.some`, `.every` (subject to runtime
contract support).

**Rationale:**

- `.map` is the hardest nested case and currently mixes context and type
  heuristics.
- We want one matrix-driven rule for all collection operators, starting with
  `.map`.

**Acceptance criteria:**

1. `.map` rewrite decisions are fully explained by `{context, receiverKind}`.
2. Pattern-context `.map` on reactive receivers is always rewritten.
3. Compute-context `.map` rewrites only for non-auto-unwrapped cell-like
   receivers.
4. Context evaluation uses the **active context at the operator site after prior
   rewrites**, including synthetic compute wrappers introduced by JSX rewriting.
5. `.map` callback parameter context is conditional on transform outcome:
   rewritten `.map` -> pattern callback semantics; non-rewritten `.map` ->
   regular callback semantics.
6. Test matrix exists and is extensible to future operators.
7. Synthetic compute-owned branches/calls must not retain stale pattern
   ownership after earlier rewrites.

## D-004 Replace Reactive-Heuristic Typing With Capability Dataflow + Type Shrinking

**Status:** Mostly landed

**Policy target:**

- Move away from relying on complex proxy-heavy `Reactive<T>` surface types as
  the primary decision source for transform policy.
- `Reactive<T>` surface typing can simplify toward ordinary `T` so long as
  reactive-origin detection remains available structurally to validation and
  lowering passes.
- Build a flow-aware capability model from normal parameters/locals and
  propagated origins.
- Treat pattern inputs and outputs of `lift(...)` / `pattern(...)` inside
  patterns as origin sources, then follow aliases/reassignments/destructuring.
- Apply context-specific propagation rules:
  - In pattern context, boundary signatures are intentionally based on
    directly-observed local usage for legality analysis, but emitted boundary
    schemas keep broad shape/default continuity.
  - In compute context, forwarded values should eventually use interprocedural
    summaries so helper calls contribute to required capability.
- Summarize actual usage at compute-oriented boundaries:
  - read-only -> `ReadonlyCell<T>`
  - write-only -> `WriteonlyCell<T>`
  - read+write -> `Cell<T>` / `Writable<T>`
  - pass-through only -> `OpaqueCell<T>`
- Shrink structural types in compute context to paths actually observed as
  read/written, with conservative fallback to broader shape on unknown-dynamic
  operations.
- Preserve broad pattern boundary shapes (including schema defaults) so links to
  downstream `compute`/`handler` code do not lose fields that are not
  directly read in the outer pattern callback.
- In pattern-style contexts, treat "lowerable to opaque/key semantics" as the
  primary legality criterion. Uses that cannot be lowered should produce
  diagnostics.

**Additional lowering target:**

- If a receiver is capability-classified as `OpaqueCell`, lower path navigation:
  - `foo.bar.baz` -> `foo.key("bar", "baz")`
  - `foo?.bar?.baz` -> `foo.key("bar", "baz")`
- Optional-chain path navigation should not force a data read when represented
  via `key(...)` traversal.
- Canonicalize destructured pattern-style parameters to a single receiver
  parameter plus synthesized key-bindings.
  - Example: `pattern(({ foo, bar }) => body)` ->
    `pattern((input) => { const foo = input.key("foo"); const bar = input.key("bar"); return body; })`
  - This also applies to callbacks rewritten to `mapWithPattern`.

**Rationale:**

- Current context/type heuristics are increasingly brittle for nested/synthetic
  boundaries.
- `Reactive` type complexity leaks into policy in ways that are hard to reason
  about and hard to maintain.
- Least-capability boundary types make behavior and contracts explicit while
  reducing accidental overexposure.

**Acceptance criteria:**

1. Rewrite decisions for collection and conditional operators can be explained
   from `{context, receiver capability summary}`, not `Reactive` heuristics.
2. Boundary schemas/types for compute-oriented boundaries (`lift`,
   `handler`, compute-like callbacks) can be shrunk to used paths when no
   wildcard operations are present.
3. Wildcard/dynamic operations (`...obj`, `Object.keys`, `for..in`, `for..of`,
   unknown dynamic keys, serialization-like full traversal) conservatively
   disable path shrinking for affected roots.
4. Capability shrink is path-sensitive across local aliasing/reassignment within
   the analyzed function scope.
5. Opaque path navigation lowering (`prop` / optional-chain navigation ->
   `key(...)`) is deterministic and semantics-preserving.
6. Optional receiver and invocation forms (for example `foo?.bar()` and
   `foo.bar?.()`) follow the underlying call-root policy; supported forms lower
   as whole calls rather than extracting a function-valued member.
7. ~~A feature gate exists for rollout and A/B fixture validation.~~
   (Completed: `useLegacyReactiveSemantics` gate has been removed; the single
   transform pipeline is the only path.)
8. Destructured callback parameters in pattern-style contexts are lowered to
   non-destructured receiver parameters with explicit `key(...)` bindings.
9. Alias/nested destructuring (for example `{ bar: b }`, `{ user: { name } }`)
   maps to the correct key paths.
10. Unsupported destructuring features that require full-value materialization
    (`...rest`, computed binding keys, default initializers requiring
    undefined-check semantics) are either conservatively handled via explicit
    compute wrappers or diagnosed until modeled.
11. Pattern-context diagnostics are emitted when an expression/use-site cannot
    be represented under opaque/key lowering rules, rather than by separate
    legacy heuristic checks.
12. Pattern-context legality summaries do not widen from helper-callee reads
    (`g(input) { return f(input); }` does not inherit read paths observed in
    `f`).
13. Pattern-context emitted schemas retain broad shape/defaults rather than
    shrinking to local reads.
14. Compute-context boundary summaries are allowed to widen from helper-callee
    reads/writes when interprocedural summaries are enabled.
15. Schema shrink validation: unresolvable property paths produce hard errors
    rather than silently falling back to broader schemas (see D-005).
16. `.get()` validation and opaque-root discovery continue to work when
    `Reactive<T>` is no longer represented by a dedicated schema marker.

## D-005 Validate Schema Shrink Coverage

**Status:** Landed

**Policy target:**

- When capability analysis detects property reads/writes and schema shrinking
  narrows the declared type, validate that all accessed top-level property
  heads are actually present in the result.
- If the declared type is `unknown`, every property access is unresolvable →
  hard error.
- If the declared type is `any`, path validation is skipped because runtime
  fetch is already full-shape.
- If the declared type is concrete but missing accessed properties → hard error
  naming the missing paths.

**Implementation:**

- `validateShrinkCoverage()` (`type-shrinking.ts`; called from the
  schema-injection paths) runs after every shrink operation (both
  `applyShrinkAndWrap` and the `defaults_only` branch).
- `TransformationContext` and `fnNode` are threaded through
  `applyCapabilitySummaryToArgument`, `applyCapabilitySummaryToParameter`,
  `collectFunctionSchemaTypeNodes`, and `applyShrinkAndWrap`.
- Guards skip synthetic parameters (`__`-prefixed names), `never`-typed
  parameters, non-`unknown` wildcard parameters, and the reactive proxy `"key"`
  head.
- Wildcard parameters typed `unknown` now produce `schema:unknown-type-access`
  because the generated schema cannot express what to fetch. `any`-typed and
  concrete-typed wildcard parameters are not affected.
- Declared interface/type members whose resolved property type is `unknown`
  also produce `schema:unknown-type-access` when accessed. `any`-typed members
  do not.
- `buildShrunkTypeNodeFromTypeNode` resolves non-Cell TypeReferences (type
  aliases, interfaces) to their declaration members via
  `resolveTypeReferenceMembers`, then shrinks those members directly using
  `shrinkTypeLiteralMembers`. This preserves source-level TypeNodes (Date
  formats, enum literals, `$ref`/`$defs`) that would be lost by the
  type-driven fallback. When no members are removed, the original
  TypeReference is kept intact to preserve schema references.
- `buildShrunkTypeNodeFromTypeNode` handles `UnionTypeNode` by stripping
  nullish constituents (`undefined`, `null`, `void`) and shrinking the
  remaining non-nullish members.
- `buildShrunkTypeNodeFromType` strips nullish union constituents via
  `checker.getNonNullableType()` before property resolution, so types like
  `{ amount?: number } | undefined` resolve correctly.
- `validateShrinkCoverage` uses `typeHasProperty()` (path-driven) instead of
  `collectMaterializedHeads()` (collect-then-check). This handles unions (any
  non-nullish constituent), TypeReferences (resolved declarations), and array
  types (numeric index heads) without requiring upfront enumeration of all
  property names. The checker is threaded through as `ts.TypeChecker`.

**Diagnostic codes:**

- `schema:unknown-type-access` — parameter typed `unknown` with property
  accesses, or concrete parameter with accessed `unknown`-typed property heads
- `schema:path-not-in-type` — concrete type missing accessed properties

**Test coverage:** `test/schema-shrink-validation.test.ts` — unknown-type and
missing-property errors, interprocedural lift-callback cases, wildcard
unknown/any/concrete splits, union and type-alias parameters, numeric array
index access. (Case counts churn; the file is the inventory.)

**Rationale:**

- Silent fallback to unshrunk schemas hides type mismatches that surface as
  runtime surprises. A compile-time error forces authors to declare the
  properties their code actually uses.

**Goals touched:** G-004, G-005, G-016\
**Invariants touched:** C-007 (conservative fallback now produces an error
instead of silently degrading)\
**Non-goal check:** Does not attempt full type soundness (NG-002); validates
only top-level path heads, not deep path resolution.

## Principles

## P-001 Terminology Must Describe Semantics, Not Trust

Names should reflect execution model and data semantics. Avoid terms implying
security guarantees (`safe`) when all authored code is sandboxed and untrusted.

## P-002 Context Is A First-Class Semantic Axis

Transformer policy should branch first on context category:

- pattern context: opaque-facing author code
- compute context: callback-local computed code

This should be explicit and centralized, not scattered via ad-hoc checks.

## P-003 Conditional Operator Family Should Be Handled Coherently

`&&`, `||`, and `?:` belong to one control-flow family. Rewriting policy should
be consistent and context-defined for all three, rather than using independent
heuristics per operator.

## P-004 Preserve JavaScript Semantics Exactly

Rewrites must preserve short-circuit and value-return semantics:

- `&&`: returns left if falsy, else right
- `||`: returns left if truthy, else right
- `?:`: returns selected branch

Lowering is acceptable only when semantic equivalence is exact.

## P-005 Make Reactive Boundaries Explicit Where Opaque Values Dominate

In pattern context, emitted forms should make reactive/opaque boundaries
explicit (`when`, `unless`, `ifElse`, schema boundaries), to reduce
implicit behavior and runtime ambiguity.

## P-006 Minimize Rewrite Surface In Compute Context

Compute contexts already encode computation intent. Prefer preserving authored
expression structure there unless a rewrite is strictly required for
correctness.

## P-007 Deterministic, Explainable Rules Over Heuristics

Choose small deterministic policies tied to context/operator class. Avoid
“expensive RHS” style heuristics where possible because they are harder to
predict and explain.

## P-008 Diagnostics Should Teach The Model

When disallowing expressions in pattern context, diagnostics should explain:

1. what context the user is in,
2. why direct computation is constrained there,
3. which compute-context wrapper to use.

## P-009 Least Capability At Boundaries

When a boundary type can be represented with less authority without losing
needed behavior, prefer the least-capability representation in compute-oriented
contexts. Pattern boundaries prioritize opaque contract continuity.

## P-010 Path-Sensitive Precision, Conservative Fallback

Use precise path-level shrinking when evidence is strong in compute context.
When analysis is ambiguous, fall back to broader types/shapes rather than
risking unsoundness.

## P-011 Pattern Legality Is Lowerability

In pattern context, if authored code can be lowered to explicit opaque/key
operations, it is legal. If it cannot be lowered soundly, it should be rejected
with diagnostics that explain the blocking construct and compute-context escape
hatch.

## P-012 Preserve Schema Continuity Across Pattern Boundaries

Pattern boundaries should not prune schema/default shape based solely on local
pattern reads. Downstream compute/handler links must continue to see expected
fields/defaults unless an explicit author opt-in narrowing model is introduced.

## Candidate Implementation Touchpoints

- `packages/ts-transformers/src/ast/reactive-context.ts`
- `packages/ts-transformers/src/ast/call-kind.ts`
  (`classifyArrayMethodCallSite` — the former `type-inference.ts`
  `isReactiveArrayMapCall` no longer exists)
- `packages/ts-transformers/src/transformers/jsx-expression-site-router.ts`
- `packages/ts-transformers/src/transformers/expression-rewrite/emitters/binary-expression.ts`
- `packages/ts-transformers/src/transformers/expression-rewrite/emitters/conditional-expression.ts`
- `packages/ts-transformers/src/closures/strategies/array-method-strategy.ts`
  (née `map-strategy.ts`; split into strategy/policy/transform/utils)
- `packages/ts-transformers/src/ast/call-kind.ts`
- `packages/ts-transformers/src/ast/dataflow.ts` (or successor capability graph)
- `packages/ts-transformers/src/ast/type-inference.ts`
- `packages/ts-transformers/src/ast/type-building.ts`
- validation messaging in
  `packages/ts-transformers/src/transformers/pattern-context-validation.ts`
- replacement/merge path for that validation in pattern-callback-lowering diagnostics
- schema emission in
  `packages/ts-transformers/src/transformers/schema-injection.ts`
- schema generation coupling in
  `packages/ts-transformers/src/transformers/schema-generator.ts`
- docs currently describing “safe context,” including
  `docs/history/packages/ts-transformers/docs/SAFE_CONTEXT_TRANSFORMS_DESIGN.md`

## Simplification Recommendations

## S-001 Replace Overlapping Context Predicates With One Classifier

**Current complexity:** multiple partially-overlapping helpers:

- `isInsideSafeCallbackWrapper`
- `isInsideSafeWrapper`
- `isInsideRestrictedContext`
- `isInRestrictedReactiveContext`

**Recommendation:** introduce one context API:

```ts
type ReactiveContextKind = "pattern" | "compute" | "neutral";
interface ReactiveContextInfo {
  kind: ReactiveContextKind;
  inJsxExpression: boolean;
  owner:
    | "pattern"
    | "render"
    | "array-map"
    | "computed"
    | "lift-applied"
    | "action"
    | "lift"
    | "handler"
    | "standalone"
    | "unknown";
}
```

Consumers should read `kind` rather than composing multiple booleans.

The classifier must treat synthetic callback boundaries created by earlier
passes as authoritative context boundaries. Example target behavior:

```tsx
// Shown for illustration only.
<div>{[0, 1].forEach(() => list.map(...))}</div>
```

If JSX rewriting first introduces a compute wrapper (`computed`) around
this expression, the nested `list.map(...)` is in compute context for subsequent
collection rewrite policy.

## S-002 Centralize Rewrite Decisions In A Policy Module

**Current complexity:** rewrite rules are spread across emitters/strategies and
partly heuristic.

**Recommendation:** add a policy module (for example
`src/policy/rewrite-policy.ts`) with pure functions:

1. `shouldLowerLogicalInJsx(context, operator)`
2. `shouldRewriteCollectionMethod(context, method, receiverKind)`
3. `classifyReceiverKind(type) -> "plain" | "opaque_autounwrapped" | "celllike_requires_rewrite"`

Emitters/strategies call policy functions instead of embedding local logic.

## S-003 Split Binary Rewriting Into Two Independent Steps

**Current complexity:** `emitBinaryExpression` mixes:

1. logical lowering (`&&`/`||`)
2. computed wrapping fallback
3. expensive-RHS heuristics

**Recommendation:** structure as:

1. operator-class handling (`&&`/`||`) via policy matrix
2. generic expression wrapping path for remaining cases

This makes conditional-operator behavior auditable and removes heuristic-driven
branching.

## S-004 Generalize Map Strategy Into Collection Method Strategy

**Current complexity:** map-specific logic is split across:

- call-kind detection
- type-inference helpers
- closure map strategy
- context checks in multiple files

**Recommendation:** introduce a method-agnostic strategy base with per-method
adapters. Phase 1 uses only `map`, but architecture supports future methods.

This keeps `map` semantics intact while reducing future copy/paste complexity
for `.filter`-class operators.

## S-005 Make Diagnostics Context-Literate

**Current complexity:** messages refer to “safe context,” which conflates trust
with semantics.

**Recommendation:** diagnostics should explicitly mention “pattern context” vs
“compute context” and explain why behavior differs there.

## S-006 Add A First-Class Context Policy Test Matrix

**Current complexity:** coverage is broad but not organized as a policy matrix.

**Recommendation:** add table-driven tests for:

1. context kind (`pattern`, `compute`)
2. operator (`&&`, `||`, ternary)
3. method (`map`, future analog)
4. receiver kind (`plain`, `opaque_autounwrapped`, `celllike_requires_rewrite`)

This turns policy regressions into obvious test failures.

## S-007 Introduce A Dedicated Capability-Flow IR

**Current complexity:** expression-local dataflow exists, but not a dedicated
summary model for read/write/pass-through capability at boundaries.

**Recommendation:** add a first-class capability-flow IR per analyzed function:

1. origin roots (pattern params, lift/pattern outputs, callback params)
2. alias graph edges (assignment/destructure/rebind)
3. operation facts (`read(path)`, `write(path)`, `pass`, `unknown-read`,
   `unknown-write`)
4. boundary summaries (per root and per emitted callback/module boundary)

For `.map` callbacks, callback parameters are origin roots in pattern mode only
for map calls that resolve to `mapWithPattern` under policy. Non-rewritten
`.map` callbacks should not be promoted to pattern-origin roots.

## S-008 Centralize Capability Shrinking In One Summarizer

**Current complexity:** type shaping logic is distributed across closure/schema
helpers.

**Recommendation:** one summarizer should own:

1. capability class (`opaque`, `readonly`, `writeonly`, `cell`)
2. path set and wildcard flags
3. conversion to TypeNode/schema hints for downstream emitters

## S-009 Add A Receiver Path-Lowering Pass For OpaqueCell

**Current complexity:** property/optional-chain behavior is split across several
emitters and contextual checks.

**Recommendation:** add a targeted lowering step (or utility used by emitters)
that converts property navigation on capability-proven `OpaqueCell` receivers to
`key(...)` chains while routing an enclosing optional call as one semantic unit.

## S-010 Add A Shared Parameter Canonicalization Pass

**Current complexity:** destructuring behavior is encoded in multiple callback
transforms and depends on proxy-style access assumptions.

**Recommendation:** add one reusable canonicalization utility for pattern-style
callbacks:

1. rewrite parameter binding patterns to a single receiver identifier
2. synthesize stable local bindings via `receiver.key(...)`
3. preserve aliasing and nested paths
4. apply consistently to `pattern(...)` and rewritten `mapWithPattern` callbacks

## S-011 Unify Validation With Lowerability Analysis

**Current complexity:** a separate validation transformer enforces pattern
context constraints using heuristics that may diverge from lowering behavior.

**Recommendation:** generate pattern-context diagnostics from the same analysis
that decides opaque/key lowering. This removes split-brain behavior where code
is "valid per validator" but not lowerable, or vice versa.

## Proposed Implementation Path

## Phase 0: Lock Baseline And Prepare Rollout

**Status:** Landed

1. Add explicit characterization tests for current `.map` nested behavior and
   logical lowering behavior.
2. Add a transformer option gate for new policy path (for example
   `contextPolicyV2`) so rollout can be incremental.

**Exit criteria:** baseline green; feature gate available.

## Phase 1: Terminology Migration (Low-Risk)

**Status:** Partially landed

1. Update docs and diagnostics from “safe” to “compute/pattern” terms.
2. Keep existing function names internally if needed, but update user-facing
   text immediately.

**Exit criteria:** no user-facing “safe context” wording in transformer docs and
diagnostics.

## Phase 2: Context Classifier Introduction

**Status:** Landed

1. Implement `getReactiveContextInfo(node, checker)`. (Landed as
   `classifyReactiveContext`.)
2. Re-implement old helpers as wrappers over the new classifier to preserve
   compatibility.
3. Migrate a first consumer (`pattern-context-validation`) to classifier-first
   flow.

**Exit criteria:** one canonical context implementation; old helpers become thin
compatibility shims.

## Phase 3: Logical Operator Policy Rewrite

**Status:** Landed

1. Implement `shouldLowerLogicalInJsx`. (Landed as the emitter + policy-module
   split rather than under this exact name.)
2. Refactor `emitBinaryExpression` to use policy matrix (remove expensive-RHS
   gating for policy-controlled paths).
3. Keep semantic equivalence checks via snapshots/fixtures.

**Exit criteria:** `&&`/`||` behavior determined by context matrix, not local
heuristics.

## Phase 4: `.map` Policy Simplification

**Status:** Landed (with standalone-function follow-up)

1. Implement `classifyReceiverKind`. (Landed as
   `classifyReactiveReceiverKind`, `src/policy/rewrite-policy.ts`.)
2. Refactor `shouldTransformMap` to policy-driven form:
   `{contextKind, receiverKind}`. (Landed as `shouldTransformArrayMethod` in
   `array-method-strategy.ts`.)
3. Add nested context fixtures that assert:
   - pattern-context reactive map rewrites
   - compute-context rewrite only for cell-like set
   - synthetic compute-context boundaries introduced by earlier JSX rewrite
     passes (for example `forEach(() => list.map(...))` inside JSX) are honored

**Exit criteria:** `.map` rewrite decisions are matrix-driven and test-backed.

## Phase 5: Collection Method Generalization Scaffold

**Status:** Open

1. Introduce collection-method strategy abstraction with `map` as first method.
2. Define placeholder policy entries for future operators without enabling
   runtime behavior yet.

**Exit criteria:** architecture ready for `.filter` analog without repeating map
logic.

## Phase 6: Cleanup

**Status:** Landed

1. ~~Remove superseded heuristic branches.~~
   Done — `useLegacyReactiveSemantics` and all legacy heuristic branches removed.
2. Delete or deprecate old context helper names once all consumers migrate.
3. ~~Update behavior and goals specs to final terminology/policy.~~
   Done.

**Exit criteria:** no dead-path fallback logic for replaced policies.

## Capability Dataflow Rollout Path

## Phase D0: Guardrails And Instrumentation

**Status:** Landed

1. Add feature gate (`capabilityDataflowV1`) and fixture split for old/new path.
2. Add characterization tests for tricky nested cases and current boundary
   types.

**Exit criteria:** dual-path test harness in place with stable baseline.

## Phase D1: Origin Tagging

**Status:** Landed (intraprocedural)

1. Tag analysis origins from:
   - pattern/lift/handler/action callback parameters
   - results of `lift(...)` and `pattern(...)` invoked within pattern code
   - `.map` callback parameters only when that call site is selected for
     `mapWithPattern` rewrite
2. Persist origin identity through synthetic node creation via registry
   metadata.

**Exit criteria:** origins are queryable at any operator/boundary site.

## Phase D2: Local Alias/Reassignment Flow Graph

**Status:** Landed

1. Implement statement-level local flow tracking for:
   - direct assignment/reassignment
   - object/array destructuring
   - parameter rebinding aliases
2. Emit conservative "unknown" edges on unsupported constructs.
3. Add parameter canonicalization for pattern-style destructured inputs to
   explicit key-binding prologues.

**Exit criteria:** alias lineage is available for capability summarization.

## Phase D3: Operation Classification

**Status:** Landed

1. Classify operations per origin/path:
   - reads (`get`, comparisons, arithmetic, branch predicates, template use)
   - writes (`set`, `update`, `push`, `send`, mutation helpers)
   - pass-through (argument forwarding/return without local read/write)
2. Detect wildcard/full-shape triggers (`...`, `Object.keys`, dynamic unknown
   key access, broad iteration).
3. Emit "non-lowerable in pattern context" reason codes for constructs requiring
   diagnostics.

**Exit criteria:** per-origin fact sets are stable across fixtures.

## Phase D4: Boundary Capability And Shape Shrinking

**Status:** Landed

1. Produce boundary summaries:
   - `OpaqueCell` / `ReadonlyCell` / `WriteonlyCell` / `Cell`
   - used path tree + wildcard flags
2. Wire summaries into schema/type emission in schema-injection/generator path.
3. Validate shrink coverage: `validateShrinkCoverage` reports hard errors when
   accessed properties are missing from the declared type (D-005).

**Exit criteria:** emitted boundary type/schema changes match expected least
capability for covered fixtures. Unresolvable property paths during shrinking
produce hard errors rather than silently degrading.

## Phase D5: Policy Integration For Operator Rewrites

**Status:** Partially landed

1. Replace map/logical receiver classification inputs with capability summaries.
2. Remove remaining `Reactive`-specific heuristic branches where superseded.
3. ~~Start routing pattern-context validation diagnostics through lowering
   eligibility checks.~~ Done for restricted-reactive computation diagnostics:
   validation now consults shared expression-site lowerability before
   reporting `pattern-context:computation`.

Remaining work:

1. Keep shrinking residual heuristic branches where no capability-backed
   replacement exists yet.
2. Expand matrix-style policy coverage if we want a permanent gate on
   expression-site / operator behavior.

**Exit criteria:** operator rewrite matrix decisions are capability-backed and
validation-side computation diagnostics no longer rediscover lowerability
independently.

## Phase D6: Opaque Path Navigation Lowering

**Status:** Landed

1. Lower `foo.bar.baz` and optional-chain path navigation to `foo.key(...)` when
   receiver summary is `OpaqueCell`.
2. Ensure optional-chain navigation lowering preserves no-throw behavior.
3. Classify optional calls by the same call-root and expression-site policy as
   non-optional calls, lowering supported forms as whole calls.
4. Ensure destructured parameter lowering composes with path-navigation lowering
   without duplicate or conflicting rewrites.

**Exit criteria:** snapshot parity for supported forms, including receiver and
invocation optionality, and explicit diagnostics for underlying call roots that
remain unsupported.

## Phase D7: Interprocedural Summaries (Compute Context Focus)

**Status:** Partially landed

Implemented in current MVP:

1. Compute-context capability analysis reuses callee summaries through resolved
   function signatures with concrete function bodies in the same source file.
2. Transitive read/write paths from helper callees propagate to caller compute
   boundaries.
3. Cross-file or otherwise unsupported helper calls fall back to the existing
   conservative wildcard path rather than taking partial transitive precision.
4. Pattern-context legality summaries remain direct/local (no helper-driven
   widening).
5. Recursion still bails out conservatively via the existing `recursive`
   summary path.

Remaining work:

1. Decide whether to widen beyond same-source-file concrete helper bodies (for
   example broader declaration forms or cross-module calls).
2. Add dedicated fixture matrix for interprocedural edge cases and recursion
   boundaries.

**Exit criteria:** compute-context boundaries gain transitive precision across
supported helper calls, while pattern-context legality remains local-only,
without major compile-time regression.

## Phase D8: Default-On And Legacy Cleanup

**Status:** Landed

1. ~~Flip `capabilityDataflowV1` to default after stabilization window.~~
   Done — the single transform pipeline is the only path.
2. ~~Remove legacy branches tied to old `Reactive` heuristics.~~
   Done — `useLegacyReactiveSemantics` flag and all legacy branches removed.
3. ~~Update behavior spec to reflect new default behavior.~~
   Done.
4. Retire or reduce legacy pattern-context validation passes once lowerability
   diagnostics are complete.

**Exit criteria:** new path is default, old path removed or hard-deprecated.

## Indirect Builder Callbacks Are Rejected At Compile Time

`IndirectBuilderCallbackValidationTransformer` (stage 7) rejects a trusted
builder whose callback arrives through a property access or an imported
binding, matching `verifyTrustedBuilderCall`'s admitted spellings.

The lowering stages continue to RECOGNIZE those spellings — schema injection
still resolves such a callback semantically and leaves it in the position the
runtime dispatch reads (`test/schema-first-imported-callback.test.ts`). That is
deliberate: recognition is what lets the compiler describe the form accurately
instead of garbling it first, and it is what would make the form work
immediately were the verifier's rule ever widened. Only the language boundary
moved; the lowering did not.

The alternative — widening the verifier to admit a binding imported from
another verified module — is a sandbox-contract decision rather than a
transformer one, since it rests on whether one module's verification may vouch
for a callable another module calls.

## Remaining Hardening Follow-Ups

Normative language decisions now live in the target-language spec and lowering
contract. The items below are rollout/hardening follow-ups, not unresolved
source-language policy.

1. Decide and pin whether compute-context JSX ternary should preserve authored
   ternary (no `ifElse` lowering), mirroring the current `&&`/`||` direction.
2. Add a strict context-policy matrix test suite if we want a permanent gate on
   operator rewrite behavior.
3. Tighten wildcard-fallback rules for path shrinking so partial precision vs
   full-shape fallback is consistently classified.
4. Tighten the compute-context interprocedural MVP scope (for example
   same-module direct calls vs broader) while keeping pattern-context legality
   intentionally direct/local.
5. JSX / render-node schema verbosity: repeated render-node shapes and local
   `$defs` in emitted output are semantically consistent but noisy; the open
   question is presentation/canonicalization, not core correctness. (Folded
   from the retired package-root `ISSUES_TO_FOLLOW_UP.md` queue, 2026-07; its
   old test pins no longer exist.)
